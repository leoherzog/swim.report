# Offline discovery + classification from prebuilt OSM layers (GitHub Actions)

Beach **discovery**, **water-body classification** and the **`marine_zone`
derivation** are *pipeline* concerns — they run occasionally, tolerate hours of
latency, and produce a table — not *serving* concerns. They run outside the
Cloudflare Worker, in offline GitHub Actions jobs that bulk-load production D1.
The Worker keeps everything else: serving, the hourly flag recompute, the
6-hourly wave refresh, and NWS/ECCC/webcam enrichment.

All three are now **pure local math over a prebuilt spatial layer set**. The job
that produces the SQL makes zero upstream data queries and runs with **no network
permission at all**.

## Why

The pipeline used to query the public Overpass API, tile by tile, on every run.
That transport had three problems, and only the first was ever the loud one:

1. **It was flaky in a way that scaled against us.** Discovery needed 33 named
   tiles plus 33 park tiles to all succeed before a DELETE was safe. A 66-way
   conjunction of independent public-mirror requests has a joint success
   probability that decays as p^(2n), and in production it was simply false: the
   run of 2026-08-31 exhausted its budget at park tile 27. The delete path was
   therefore effectively off, which is not a safety property — it is a safety
   property that has stopped being exercised.
2. **It made classification expensive per beach**, so classification was rationed
   (25 beaches an hour, its own workflow, its own cadence) and a beach could be
   discovered and published hours before it was classified. Under a fail-open
   NULL gate, that means an inland-lake beach served a live estimated flag card
   for those hours (the Locklin Pines regression).
3. **It priced scale-out per bounding box.** Every added region was more tiles,
   more requests, more failure surface — which is exactly the cost that kept the
   North America expansion parked.

Prebuilt layers remove all three at once. A separate workflow turns the Geofabrik
OpenStreetMap extracts into ten small FlatGeobuf files; the discovery job
downloads and verifies them and does one local scan. Coverage becomes a
locally-checkable fact about bytes on disk rather than a 66-way conjunction over
someone else's server, classification becomes a spatial join in the same pass that
discovers a beach, and a region box costs nothing to add.

What we gave up is latency: freshness is now the extract cadence (twice weekly,
with a hard 21-day refusal), not minutes. For a directory of beaches that is the
right trade, and it is stated plainly here so nobody has to rediscover it.

**A deliberate seam predicted this.** The previous design wrapped the per-beach
classification probe as an explicit seam — one call, `fetchWaterClassSignals` +
`classifyWaterBody`, with the note that a smarter bulk classifier should replace
that one call and nothing else. That is exactly what happened:
`src/layerSignals.js`'s `waterClassSignals` was dropped into the same seam with
the same signature and the same null contract, and `classifyQueue`'s body did not
change. The seam was worth building.

## The two-path rule still holds

Nothing about the Worker changes. The **request path** still reads only D1 + KV.
The **cron path** still owns the Worker's own upstream fetching. These batch jobs
are a **third, offline path** that writes D1 out-of-band — they never run inside
the Worker. The prebuilt layers are read by the **offline job only**: R2 never
enters the request path, and `wrangler.toml` deliberately carries no
`[[r2_buckets]]` binding, so the Worker cannot reach the bucket even by accident.

## Pieces

### The layer build

- **`.github/workflows/build-layers.yml`** — twice weekly (`41 6 * * 0` and
  `41 6 * * 3`, plus `workflow_dispatch`), concurrency group `build-layers`,
  `timeout-minutes: 180`. Plain shell on a GitHub runner. It is **not**
  delete-bearing and is **not** a Deno program.
  - Reclaims runner disk and asserts a 40 GB floor.
  - Per country (us, canada, mexico), **sequentially**: download the Geofabrik
    extract, verify its published `.md5`, assert every extract carries the **same**
    `osmosis_replication_timestamp` (osmium merge is documented as incorrect
    across differing data vintages), `osmium tags-filter` it down to the tag sets
    in `.github/build/expressions.txt`, and **delete the `.pbf`** before starting
    the next country. Peak disk is ~13.3 GB. Reference completion is **on by
    default** and `-R` must **never** be passed — without referenced objects the
    six Great Lake relations cannot be assembled and Great Lake classification
    silently collapses to zero.
  - `osmium merge`, then **one** `ogr2ogr` OSM read into raw layers, with
    `CPL_TMPDIR` set **explicitly**. An exhausted GDAL node-index temp filesystem
    emits a flood of "Cannot read node" warnings and then returns an **empty**
    result with a **zero** exit status. That is the shape of every dangerous
    failure in this pipeline: valid-looking, quiet, and total.
  - `.github/build/osmconf.ini` and `osmconf-lines.ini` promote `wikidata` (and
    the other tag keys the pipeline reads) to first-class columns in every layer.
    The stock GDAL `osmconf.ini` does not, and buries the QID inside an HSTORE
    blob — which would collapse Great Lake matching, silently, to zero.
  - `scripts/clip-layers.js` (Deno) trims the park / coastline / water layers to
    within ~1.1 km of the beach set. **This clip is what makes the published set
    O(beaches) rather than O(continent)** and is the reason the whole approach
    fits in a runner and a daily download.
  - `scripts/build-manifest.js` writes the manifest: schema version, build id,
    per-layer sha256 and feature count, the oldest source timestamp, the
    `regionsDigest`, the sanity verdict, and a history array of previous builds'
    counts. Absolute floors come from the committed `data/layer-floors.json`,
    keyed by `regionsDigest`.
  - **Publication order matters.** Ten layer files plus the manifest go to an
    **immutable per-build prefix** in the R2 bucket `swim-report`; the single small
    `layers/current.json` pointer is overwritten **last**. A reader can therefore
    never see a torn set. The bucket is served publicly at
    `https://map.swim.report`. Writes use the runner's preinstalled AWS CLI over
    the S3 API; **path-style addressing is mandatory**, because the bucket name
    contains a dot and the wildcard certificate covers only one label.
  - **Failure posture: last-good.** A failed build, or one a sanity floor refuses,
    publishes nothing and leaves the previous layer set live. That is delete-safe:
    an older extract is over-inclusive, so it can only fail to discover a new
    beach, never invent a stale one.
  - `osmium-tool` and GDAL are **workflow shell dependencies only** — never a
    dependency of the Deno batch, of the Worker, or of the tests.

### The consuming job

- **`.github/workflows/discovery.yml`** — daily (`47 8 * * *`), plus a
  `workflow_run` trigger on a successful layer build, plus `workflow_dispatch`
  with an `apply` input (false = artifact-only dry run). Concurrency group
  `discovery`. It fetches and verifies the layer set, snapshots D1, runs the batch
  once, uploads the `.sql` delta as an artifact, and applies it with
  `wrangler d1 execute --remote --file`. It needs **no R2 credentials** — it reads
  the published layers over plain HTTPS from `https://map.swim.report`.
- **`scripts/fetch-layers.js`** — Deno, and the **only network-touching script in
  the offline path**. It reads `layers/current.json` **once**, with a cache-buster,
  logs the build id, and derives every subsequent URL from that one pinned prefix.
  Re-reading the pointer per file would let a build completing mid-run hand back
  three layers from set A and seven from set B: a set that passes every checksum
  (each file matches its *own* manifest) while describing a world that never
  existed. The download list is `EXPECTED_LAYER_KEYS` from `src/layerManifest.js`,
  **never** `manifest.layers[].key` — a manifest describing nine layers is not a
  nine-layer set to consume as-is, it is a set this code cannot decode, and this
  choice also keeps every written filename a compile-time constant of this repo
  rather than remote input. It writes `report.json`, the input to the delete gate.
- **`scripts/discovery-batch.js`** — Deno. **Runs as
  `deno run --allow-read --allow-write`. No `--allow-net`.** That is the
  machine-enforced form of the claim that the only job in this repo that can DELETE
  production rows cannot talk to the network; **any surviving `--allow-net` on a
  `discovery-batch.js` invocation is a leftover upstream call and a bug.** It
  imports the pure logic *verbatim* from `src/` so it can never diverge from the
  Worker's own semantics, reads a D1 snapshot and the verified layer set, and emits
  **one idempotent `.sql` delta**.

### Modules

- **`src/discovery.js`** — the pure merge logic (`mergeBeachRows`), imported by the
  batch and directly by `test/parkContainment.test.js`. **Not** imported by the
  Worker: `src/index.js` used to re-export it for a test import path, which meant
  the deployed bundle shipped it for no runtime reason. That re-export is gone.
  Its only dependency is `src/geo.js`.
- **`src/regions.js`** — `REGIONS` (a curated array of coastal bounding boxes
  tracing the entire Great Lakes shoreline, US and Canadian) plus the pure
  predicate `pointInAnyRegion(lat, lon)`. Pure data + one function, no imports.
  `REGIONS` now drives exactly three things: the layer build's `-spat` clip mask,
  the per-region sanity floors and delete rail, and `pointInAnyRegion` delete
  scoping. **There is no tiling and no per-box query cost**, so box size and count
  are free — which is what makes the North America expansion cheap on the
  discovery side.
- **`src/osmSelect.js`** — the transport-independent selection semantics: the
  probe radii (`OCEAN_RADIUS_M` 150, `GREAT_LAKE_RADIUS_M` 150,
  `INLAND_RADIUS_M` 120), the tag predicates, park association, the pond filter,
  `sortLayerFeatures` (a total order over `(osmType, osmId)`, because FlatGeobuf's
  Hilbert storage order reshuffles on every rebuild and both the park tie-break
  and the merge dedupe resolve by first seen), and `probeVertices`, which
  reproduces the old recurse-down anchor: every classification distance is measured
  from the beach element's own member **vertices**, never its centroid.
- **`src/layerGrid.js`** — two spatial indexes. Mode A buckets by envelope, for
  park containment and water matching. Mode B indexes the **segments**, because an
  envelope grid prunes nothing for the six Great Lake polygons — their bounding
  boxes contain essentially every Great Lakes beach. Mode B keeps typed arrays
  rather than a multi-gigabyte GeoJSON heap and answers exactly the question the
  old `around:R` clauses asked.
- **`src/layerDiscovery.js`** — `discoverFromLayers`, the local replacement for the
  tiled fetch/parse/dedupe pipeline, plus hole-aware park containment and the pond
  water pooling.
- **`src/layerSignals.js`** — the water-class **signal provider**, sitting in the
  seam `fetchWaterClassSignals` occupied.
- **`src/layerManifest.js`** — manifest verification and the delete gate.
- **`scripts/lib/fgbReader.js`** — the FlatGeobuf reader, and the **only module in
  this repo with an npm dependency** (`flatgeobuf`, a devDependency). It is never
  reachable from `src/index.js`, and a test asserts that.

Note on the Deno setup, because it bites: `deno.json` and `deno.lock` are
**committed**. `deno.json` carries `"nodeModulesDir": "none"` (so the batch
resolves `flatgeobuf` from the npm cache rather than a CI-absent `node_modules/`)
and one import-map entry, `"flatgeobuf/": "npm:/flatgeobuf@4.4.0/"` — note the
**leading slash** after `npm:`, which is the canonical Deno form for a
trailing-slash directory mapping. The bare specifier is what lets the same module
load under both Deno and vitest (`npm:` is a Deno-only URL scheme). And **every**
`deno` invocation in this repo — npm script or workflow step — must set
`DENO_NO_PACKAGE_JSON=1`: the repo-root lockfile is auto-discovered for all Deno
commands here, and without that variable Deno folds `package.json`'s npm tree into
the lockfile it expects, so `deno check --frozen` fails with "The lockfile is out
of date" and a plain `deno run` **silently rewrites the checked-in lock**. Do not
fix that by regenerating the lock without the variable.

## Faithful to the Worker's semantics

The emitted SQL preserves every invariant the previous pipeline established
(`test/discoveryBatch.test.js` locks this down):

- **Enrichment columns are preserved.** The upsert is
  `INSERT … ON CONFLICT(id) DO UPDATE SET name, lat, lon, park_name, …` — it
  never touches `nws_zone` / `nws_grid_url` / `eccc_zone` / `webcam_*`, so a bulk
  reload can't clobber what the enrichment crons filled.
- **Moved-centroid reset.** A re-discovered beach whose centroid moved > ~0.001°
  has its `water_class` reset to re-classify (same `CASE WHEN abs(lat-…)` clause).
- **Reconciliation is guarded, and now by a gate that does not decay.** Stale
  unnamed-park rows (`name = park_name`, inside a discovery region per
  `pointInAnyRegion`, not produced this run) are deleted only under a verified,
  complete, in-scope, fresh layer set. The single pure predicate is
  `reconciliationAllowed(report)` in `src/layerManifest.js`; it **replaces**
  `reconciliationAllowed(namedComplete, parkComplete)` at the same call site and
  keeps its single-choke-point role, so the exported and unit-tested invariant
  *incomplete coverage means no DELETE* survives with a new input. The difference
  is that every conjunct is now a locally-checkable fact about bytes on disk
  rather than a 66-way conjunction over a public mirror, so the gate does not decay
  as the region set grows. Scoping the candidate set by `pointInAnyRegion` still
  **fails safe**: shrinking or removing a box only ever drops rows from the
  delete-candidate set, never adds one, so an over-tight box under-deletes rather
  than deleting a real, enriched beach.
- **Two proportional delete rails, and each refuses the whole run.**
  - Global: at most `max(RECONCILE_MAX_DELETES = 10, ceil(0.05 × candidates))`.
    **The fraction is 0.05, not the old 0.25.** 0.25 was calibrated for a per-tile
    transport where partial coverage was normal; under prebuilt layers coverage is
    either verified-complete or gated off, so a 25%-of-candidates delete run is
    never legitimate. Against the measured table (1669 rows, 982 park-origin
    candidates) 0.25 permitted 246 silent deletes — ~15% of the table in one run —
    which waves through a 9% parks-layer shrink (~88), a 15% single-region parks
    loss (~45) and a clip-mask bug that zeroes Lake Ontario (80). At 0.05 the
    allowance is ~50 and all three refuse. A false refusal costs almost nothing:
    the row simply is not deleted and reconciliation retries tomorrow.
  - Per-region, applied after the global rail: each `REGIONS` box gets
    `max(REGION_RECONCILE_MIN_DELETES = 2, ceil(0.05 × that region's candidates))`,
    and any single region over its allowance refuses the whole run. The global
    rail's protection asymptotes toward zero as the number of independently
    breakable clip masks grows — a bug that zeroes *one* region's parks is a small
    fraction of the global set and passes. **The floor is 2, not 10**, because the
    region tail is tiny (Niagara has 5 park-origin candidates, St. Marys 6) and a
    floor of 10 would make the rail vacuous for exactly the three regions a global
    rail can never protect.
- **The parks layer gets its own valve.** `parksLayerHealthy(report)` supplies
  `hasPark`; when it is false the upsert drops to the five-column variant and
  leaves `park_name` untouched. "The parks layer is present under a verified
  manifest" and "the parks layer is correctly populated" are different predicates.
  Hardcoding this true would let a 9%-short parks layer blank `park_name` on every
  named row in the missing parks and strand the park-origin rows those names
  produced as **delete candidates**. A `parks-line` count of zero is **not** a
  refusal — GDAL routes closed area-tagged ways to multipolygons, so at Great Lakes
  scope that layer is legitimately empty (build 1: 0 against 6457 in
  `parks-polygon`). The hard zero refusal sits on `parks-polygon`, which is where
  membership, and therefore every delete candidate, comes from.
- **Classification is gated too, and symmetrically.** It runs only when
  `classificationAllowed(report)` is true. A `fatal` manifest tier exits 1 with no
  SQL at all; an `incomplete` tier suppresses **both** deletes and classification;
  a `scope_or_stale` tier (a `regionsDigest` mismatch, or an extract past
  `MAX_SOURCE_AGE_DAYS = 21`) suppresses deletes only. The reason classification
  needs a gate is the same reason deletes do: deciding `inland` **hides** a beach,
  and product loss by hiding is the same family as product loss by deleting.
- **A classification flip rail.** `CLASSIFY_MAX_HIDE_FLIPS = 10` /
  `CLASSIFY_MAX_HIDE_FRACTION = 0.10`. There were four rails on deletes and none at
  all on mass re-classification, while 100% of the flag-worthy rows served today
  classify through a single code path: one broken build plus a
  `WATER_CLASS_VERSION` bump would re-decide all of them in one delta and empty the
  site, with the row count unchanged and every delete rail green. Over the
  allowance, the whole `water_class` block is refused rather than partly applied.
  The run logs the full before/after transition matrix either way.
- **Whole-table classification, in the same pass as discovery.** The queue is every
  beach (snapshot ∪ newly discovered, minus reconcile-deletes) where
  `water_class IS NULL OR water_class_version < WATER_CLASS_VERSION` and
  `water_class_attempts < WATER_CLASS_MAX_ATTEMPTS`, plus a one-time legacy
  re-drain of rows left unclassified at/above the cap by the pre-decisive
  classifier (`water_class_version IS NULL`, attempts deliberately **not** reset so
  they stay hidden while they re-decide). Decisions reset attempts to 0.
  `water_class_attempts` is otherwise **vestigial** now: a local join has no
  transient-failure mode, so nothing bumps it.
- **The signal provider's null contract is the whole attempts semantics.**
  `waterClassSignals(index, beach)` returns exactly
  `{ coastlinePresent, nearbyLakeQids, nearbyWayWater }` or `null`. `null` means
  **transient** — do not bump attempts, leave the row queued — and is returned in
  exactly three cases: an unqueryable index, an unparseable `osm_id`, and no beach
  feature indexed under that id. A signals object, **including the all-empty one**,
  is a clean, complete answer that `classifyWaterBody` decides on, and all-empty
  decides `inland`. **The provider must return `null`, never empty signals, on
  incompleteness** — empty signals on a data bug would publish `inland`, i.e. hide
  the beach. `beachAbsentFromLayers` separates the one failure mode the old
  transport never had (the element is simply not in the layer set) so it is
  reported as its own `absent_from_layers=` counter.
- **A complete answer always decides.** `classifyWaterBody` classifies a
  clean-but-empty result as `inland` rather than leaving the row NULL, so `bumped`
  should read 0 in every run log and a nonzero value means the classifier regressed
  to a pending state. The old behavior left away-from-water beaches NULL for all 5
  attempts, and since `FLAG_WORTHY_WATER_SQL` is fail-open for NULL under the cap,
  those beaches were served live with estimated flag cards the whole time (the
  Locklin Pines regression). The join is pure local math over verified, immutable
  bytes, so re-running it could only reach the same answer. The
  `inland=N (no_water=M)` summary count splits the rows decided by the empty branch
  from those with a real adjacent water way. **And the exposure window is now
  zero**: a beach is classified in the run that discovers it.
- **`flag_history` prune runs here.** The 90-day retention sweep is emitted by the
  batch job, in its own try/catch so a pruning failure never costs a discovery run.

## Prerequisites

1. **Migration 0009 applied to remote D1**: the `water_class` columns must exist.
   `export CLOUDFLARE_API_TOKEN=…` (the `CLOUDFLARE_TOKEN` value from `.dev.vars`)
   then `npx wrangler d1 migrations apply swim-report --remote`.
2. **Repository secret `CLOUDFLARE_API_TOKEN`** (value = `.dev.vars`
   `CLOUDFLARE_TOKEN`; a token with D1 edit scope on `swim-report`). No npm
   private-registry tokens are needed — the workflow never runs `npm install`/
   `npm ci` in the repo (which would reify package.json's private
   `@web.awesome.me` / `@fortawesome` deps and fail). Every wrangler call goes
   through `npx --yes wrangler@<pin>`, which fetches only wrangler from the
   default registry and never consults the repo's `package.json`.
3. **The R2 bucket `swim-report`**, served publicly at `https://map.swim.report`,
   plus repository secrets **`CLOUDFLARE_R2_ACCESS_KEY`** and
   **`CLOUDFLARE_R2_SECRET_ACCESS_KEY`** — used by the **layer build only**. The
   discovery job needs **no** R2 credentials; it reads over plain HTTPS. Nothing in
   the Worker holds a binding to this bucket, deliberately.

## Running

Locally (dry run — produce the SQL, don't apply; needs Deno + a snapshot):

    export CLOUDFLARE_API_TOKEN=…   # from .dev.vars (CLOUDFLARE_TOKEN)
    DENO_NO_PACKAGE_JSON=1 deno run --allow-net --allow-read --allow-write \
      scripts/fetch-layers.js --dest ./.layers
    npx wrangler d1 execute swim-report --remote --json \
      --command "SELECT id, osm_id, name, lat, lon, park_name, nws_zone, marine_zone, water_class, water_class_version, water_class_attempts FROM beaches" \
      > snapshot.json
    DENO_NO_PACKAGE_JSON=1 deno run --allow-read --allow-write \
      scripts/discovery-batch.js --layers ./.layers --snapshot snapshot.json \
      --out discovery-delta.sql
    # inspect discovery-delta.sql, then apply when satisfied:
    npx wrangler d1 execute swim-report --remote --file discovery-delta.sql

Note the permission sets: `fetch-layers.js` is the one script that needs
`--allow-net`, and `discovery-batch.js` deliberately does not get it.

Flags: `--layers <dir>` (the verified layer set; required for discovery and
classification), `--report <path>` (defaults to `<layers>/report.json`),
`--no-classify` (skip the classification join), `--no-discovery` (skip discovery,
reconciliation and deletes), `--marine-zones <path>` (the offline `marine_zone`
pass over the snapshot — `discovery.yml` passes
`data/marine-zones-greatlakes.json`; either mode may also carry it),
`--snapshot <path>`, `--out <path>`, `--now <iso>`.

`--no-classify --no-discovery` together is **not** an error as long as
`--marine-zones` is also passed — that is exactly what `npm run seed:marine`
runs (marine pass only, zero upstream requests). The `nothingToDo` guard errors
only when discovery, classify, AND the marine pass are all off.

For **local dev**: `npm run seed:layers` fetches and verifies the layer set into
`./.layers` (run it once per layer build, not per seed), then `npm run seed` runs
`scripts/discovery-batch.js --layers ./.layers --out ./.seed.sql` and applies the
delta with `node scripts/apply-local-sql.js ./.seed.sql`, which splits it into
<90 KB line-aligned chunks and runs one `wrangler d1 execute --local --file` per
chunk. The chunking exists because wrangler's LOCAL apply hands the whole file
to miniflare/workerd as a single SQL call, capped at 100,000 bytes
(`SQLITE_TOOBIG`) — a full delta is ~700 KB. The REMOTE apply the workflow uses
is unaffected (it uploads through the D1 import API and ingests server-side).
There is no `npm run seed:classify` any more: classification was opt-in only
because it was expensive, and a local join is not.

In CI: `build-layers.yml` runs twice weekly and `discovery.yml` runs daily plus on
each successful build, in separate concurrency groups. Both have a manual
`workflow_dispatch`; `discovery.yml` takes an `apply` input (false = artifact-only
dry run) and uploads its delta as `discovery-delta.sql` (artifact
`discovery-delta-sql`) for inspection on every run.

## History

Two migrations preceded this one, and their end states still hold. First, beach
discovery and water classification moved **out of the Worker** entirely: the
in-Worker `runOverpassSync` (`"47 8 * * *"`) and `runWaterClassification`
(`"37 1,7,13,19 * * *"`) triggers were retired from `wrangler.toml`'s `crons`
array and their code deleted, leaving the merge logic as `mergeBeachRows` in
`src/discovery.js`, imported by the batch and the tests but **not** by the Worker
bundle. Second, `beaches.marine_zone` moved offline the same way, retiring the
`"23 1,7,13,19 * * *"` marine-enrichment cron. This third migration replaced the
query transport with prebuilt layers and merged the separate hourly classification
workflow back into the daily discovery run.

The Worker's remaining cron path is: hourly flag recompute (`"7 * * * *"`, offset
off the congested `:00` slot), 6-hourly wave refresh (`"15 */6 * * *"`), and the
NWS/ECCC/webcam enrichment crons (`"17 3,9,15,21"`, `"29 4,10,16,22"`,
`"31 9"`). Discovery, classification, and marine-zone derivation are the offline
job's alone.

## Offline marine-zone pass

`beaches.marine_zone` (the adjacent NWS marine forecast zone, e.g. `LMZ874`, that the
hourly recompute matches marine warnings + Small Craft Advisory against) used to be
resolved by an in-Worker cron that probed `api.weather.gov/zones?type=marine` offshore —
up to ~17 subrequests per beach, up to ~1,360 live requests/day — to derive a static
mapping NWS already publishes as a shapefile. That cron is retired. The daily discovery
run now derives `marine_zone` with **pure local math and zero upstream requests**, passing
`--marine-zones data/marine-zones-greatlakes.json` to `discovery-batch.js`.

**The pass** (`marineZoneSql` in `discovery-batch.js`, geometry in `src/marineZones.js`)
mirrors `reconcileStaleRows`: it operates ONLY on the snapshot rows, skips rows in this
run's reconciliation delete set, and for every row with `nws_zone` set derives the nearest
marine zone via `nearestMarineZone(index, lat, lon)` — point-in-polygon first, else nearest
polygon edge within `MARINE_ZONE_MAX_DISTANCE_KM = 15` km, else null (a `<1e-9` km tie
resolves to the lexicographically smallest id, so the derivation is deterministic and a
steady-state run emits zero statements). It re-derives for EVERY `nws_zone` row (not just
`marine_zone`-NULL rows) so historic probe artifacts self-correct once, and emits an
`UPDATE` only when the derived zone is non-null AND differs from the snapshot value —
derived-null NEVER NULLs an existing value (an old probe result beats nothing). The pass
never affects `reconciliationAllowed` or the delete path (it only appends change-only
UPDATEs), and it stamps `sync_meta` keys `last_marine_zone_pass` / `last_marine_zone_count`.
A beach discovered THIS run resolves on the NEXT daily run, once the in-Worker NWS
enrichment has stamped its `nws_zone`. There is now **one** snapshot, because discovery
and classification run in the same pass: `discovery.yml`'s `SELECT` is
`SELECT id, osm_id, name, lat, lon, park_name, nws_zone, marine_zone, water_class,
water_class_version, water_class_attempts FROM beaches` — the exact union of what
`reconcileStaleRows` (id, name, lat, lon, park_name), `marineZoneSql` (id, lat, lon,
nws_zone, marine_zone) and `buildClassifyQueue` (id, osm_id, water_class,
water_class_version, water_class_attempts) read, and nothing else. The old deliberate
asymmetry between a narrow discovery snapshot and a wider classify one is gone with the
separate classify workflow; do **not** re-introduce a second snapshot. The column set
widening from 7 to 11 does matter, though: this is the ONLY delete-bearing run and its
truncation guard aborts the whole pass if D1's `--json` response is size-capped, so a
paginated snapshot is a recorded prerequisite for the North America expansion (see
`TODO.md`). `beaches.marine_attempts` is vestigial (column retained, no writers).

**The committed data file** — `data/marine-zones-greatlakes.json`, generated by
`scripts/build-marine-zones.js` from the NWS coastal marine-zone shapefile. Shape:

    {
      "source": "https://www.weather.gov/source/gis/Shapefiles/WSOM/mz16ap26.zip",
      "validDate": "2026-04-16",
      "generated": "<ISO timestamp>",
      "simplifyToleranceDeg": 0.001,
      "zones": [
        { "id": "LMZ874", "polygons": [ [ [ [lon, lat], ... ] ] ] },
        ...
      ]
    }

`polygons` is GeoJSON-MultiPolygon-shaped coordinates (`polygons` → rings → `[lon, lat]`
points); ring 0 is the outer ring, the rest are holes; rings are closed (first point
repeated last); coords are rounded to 5 decimals (~1 m). One zone per line, for a readable
diff. The current source zip is `mz16ap26.zip` (569 records, effective 2026-04-16). Only
Great Lakes / St. Lawrence / St. Clair zones are kept, by id prefix —
`GREAT_LAKES_ZONE_PREFIXES = ["LCZ", "LEZ", "LHZ", "LMZ", "LOZ", "LSZ", "SLZ"]` (134
zones); **this list MUST grow when `src/regions.js` `REGIONS` gains coasts beyond the Great
Lakes system.** Polygons are simplified at a `0.001`-deg tolerance (~110 m max
displacement — negligible against both the 15 km cap and the ~5 NM zone widths). The 15 km
cap is a strict superset of the retired probe's ~13.6 km max ring reach, so the offline
pass resolves every beach the probe could and more.

**Refresh procedure** (NWS republishes the shapefile ~1–2×/year on a schedule announced on
the MarineZones page):

1. Update `DEFAULT_ZIP_URL` and `RELEASE_VALID_DATE` in `scripts/build-marine-zones.js` to
   the new release (the zip filename changes each release, e.g. `mz18mr25.zip` →
   `mz16ap26.zip`).
2. Run `deno run --allow-net --allow-read --allow-write scripts/build-marine-zones.js` (the
   script is dependency-free in the sense that matters here — **no npm packages**: it reads
   the zip central directory, inflates with `DecompressionStream`, and parses the DBF + SHP
   binary layouts directly. It does import one local ESM module, `pointInRing` from
   `src/geo.js`, for the hole-grouping ray cast, in place of the private
   `pointInRingPlanar` copy it used to carry; `deno check scripts/build-marine-zones.js`
   resolves it and exits 0).
3. Review the logged per-prefix zone counts against the previous release and eyeball the
   JSON diff.
4. Run `npm test` (`test/marineZones.test.js` sanity-checks the committed file) and commit.

**Verified correction.** The old probe stored the FIRST offshore ring hit, which was often
the wrong band: e.g. Holland, MI resolved to `LMZ874` ("5NM offshore to Mid Lake") while the
true nearest nearshore zone is `LMZ846` ("Holland to Grand Haven MI"). The first offline
pass over 648 `nws_zone` rows emitted 404 change-only UPDATEs; a re-run over the post-update
state emits zero.
