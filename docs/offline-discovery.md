# Offline discovery + classification from prebuilt OSM layers (GitHub Actions)

Beach **discovery**, **water-body classification** and the **`marine_zone` derivation** are
pipeline concerns: they run occasionally, tolerate hours of latency, and produce a table. They
run outside the Cloudflare Worker, in offline GitHub Actions jobs that bulk-load production D1.
The Worker keeps serving, the hourly flag recompute, the water-temperature refresh and the
enrichment crons; the NOAA wave cycle is a pipeline concern too, in its own job
(`docs/offline-waves.md`).

All three passes are **pure local math over a prebuilt spatial layer set**. The job that emits
the SQL makes zero upstream data queries and runs with **no network permission at all**.

## Freshness

A separate workflow turns the Geofabrik OpenStreetMap extracts into ten small FlatGeobuf files;
the discovery job downloads and verifies them and does one local scan. Coverage becomes a
locally-checkable fact about bytes on disk, classification becomes a spatial join in the same
pass that discovers a beach, and a region box costs nothing to add. The trade is latency:
freshness is the extract cadence — twice weekly, with a hard 21-day refusal — not minutes.

## The two-path rule still holds

The **request path** still reads only D1 and KV, and the **cron path** still owns the Worker's
own upstream fetching. These batch jobs are a **third, offline path** that writes D1
out-of-band. The prebuilt layers are read by the offline job alone: R2 never enters the request
path, and `wrangler.toml` deliberately carries no `[[r2_buckets]]` binding, so the Worker
cannot reach the bucket even by accident.

## Pieces

### The layer build

**`.github/workflows/build-layers.yml`** — twice weekly (`41 6 * * 0` and `41 6 * * 3`, plus
`workflow_dispatch`), concurrency group `build-layers`, `timeout-minutes: 180`. Plain shell on
a GitHub runner; not delete-bearing and not a Deno program. It reclaims runner disk against a
40 GB floor, then per country (us, canada, mexico) **sequentially** downloads the Geofabrik
extract, verifies its `.md5`, runs `osmium tags-filter` against `.github/build/expressions.txt`
and deletes the `.pbf` before the next country, peaking at ~13.3 GB. Then `osmium merge`, one
`ogr2ogr` OSM read, `scripts/clip-layers.js` (Deno) trimming the park, coastline and water
layers to within ~1.1 km of the beach set, and `scripts/build-manifest.js`.

Four things in that sequence are load-bearing:

- Every extract must carry the **same** `osmosis_replication_timestamp`, because osmium merge
  is documented as incorrect across differing data vintages. Reference completion is on by
  default and `-R` must **never** be passed, or the six Great Lake relations cannot be
  assembled and Great Lake classification silently collapses to zero.
- `CPL_TMPDIR` must be set **explicitly** on the `ogr2ogr` read. An exhausted GDAL node-index
  temp filesystem emits a flood of "Cannot read node" warnings and then returns an **empty**
  result with a **zero** exit status — the shape of every dangerous failure here:
  valid-looking, quiet, and total.
- `.github/build/osmconf.ini` promotes `wikidata` to a first-class column in every layer. The
  stock GDAL config buries the QID in an HSTORE blob, silently collapsing Great Lake matching
  to zero.
- The clip is what makes the published set **O(beaches) rather than O(continent)**.

The manifest carries schema version, build id, per-layer sha256 and feature count, the oldest
source timestamp, the `regionsDigest`, the sanity verdict, and a history array of previous
builds' counts. Absolute floors come from the committed `data/layer-floors.json`, keyed by
`regionsDigest`.

**Publication order matters.** Ten layer files plus the manifest go to an **immutable per-build
prefix** in the R2 bucket `swim-report`; the small `layers/current.json` pointer is overwritten
**last**, so a reader can never see a torn set. Writes use the runner's preinstalled AWS CLI
over the S3 API, and **path-style addressing is mandatory**, because a dotted bucket name would
fail TLS against a wildcard certificate covering one label.

**Failure posture: last-good.** A failed or sanity-refused build publishes nothing and leaves
the previous layer set live. That is delete-safe: an older extract is over-inclusive, so it can
only fail to discover a new beach, never invent a stale one. `osmium-tool` and GDAL are
**workflow shell dependencies only** — never a dependency of the Deno batch, the Worker, or the
tests.

### The consuming job

- **`.github/workflows/discovery.yml`** — daily (`47 8 * * *`), plus a `workflow_run` trigger
  on a successful layer build, plus `workflow_dispatch` with an `apply` input (false =
  artifact-only dry run). Concurrency group `discovery`. It fetches and verifies the layer set,
  snapshots D1, runs the batch once, uploads the `.sql` delta as an artifact, and applies it
  with `wrangler d1 execute --remote --file`. It needs **no R2 credentials**: it reads the
  published layers over plain HTTPS from `https://map.swim.report`.
- **`scripts/snapshot-d1.js`** — Node, the one snapshot reader both offline workflows share. It
  pages the table through `wrangler d1 execute --json` keyed on the `id` primary key and writes
  the `[{ results }]` envelope only when the assembled row count equals `SELECT COUNT(*)` under
  the same predicate. D1's `--json` response is size-capped, so a single-shot `SELECT` over a
  grown table silently truncates. Pages are keyset, not `LIMIT/OFFSET`: an insert plus a delete
  between two `OFFSET` pages keeps the total unchanged while one row is emitted twice and
  another never, and the count guard cannot see that. Any id that fails to ascend across pages
  aborts the run. `--require-where` refuses an empty predicate, which matters wherever the
  predicate is interpolated from another command.
- **`scripts/fetch-layers.js`** — Deno, and the **only network-touching script in the offline
  path**. It reads `layers/current.json` **once**, with a cache-buster, and derives every
  subsequent URL from that one pinned prefix. Re-reading the pointer per file would let a build
  completing mid-run hand back three layers from set A and seven from set B: a set that passes
  every checksum, since each file matches its *own* manifest, while describing a world that
  never existed. The download list is `EXPECTED_LAYER_KEYS` from `src/layerManifest.js`, never
  `manifest.layers[].key`, which also keeps every written filename a compile-time constant of
  this repo rather than remote input. It writes `report.json`, the input to the delete gate.
- **`scripts/discovery-batch.js`** — Deno, run as `deno run --allow-read --allow-write`, with
  **no `--allow-net`**: the machine-enforced form of the claim that the only job here that can
  DELETE production rows cannot talk to the network. Any surviving `--allow-net` on a
  `discovery-batch.js` invocation is a leftover upstream call and a bug. It imports the pure
  logic *verbatim* from `src/`, reads a D1 snapshot and the verified layer set, and emits **one
  idempotent `.sql` delta**.

### Modules

- **`src/discovery.js`** — the pure merge logic (`mergeBeachRows`), imported by the batch and
  by `test/parkContainment.test.js`, and deliberately not by the Worker.
- **`src/regions.js`** — `REGIONS` (coastal bounding boxes tracing the entire Great Lakes
  shoreline, US and Canadian) plus the pure predicate `pointInAnyRegion(lat, lon)`. `REGIONS`
  drives exactly three things: the layer build's `-spat` clip mask, the per-region sanity floors
  and delete rail, and `pointInAnyRegion` delete scoping. There is no tiling and no per-box
  query cost, so box size and count are free.
- **`src/osmSelect.js`** — the transport-independent selection semantics: the probe radii
  (`OCEAN_RADIUS_M` 150, `GREAT_LAKE_RADIUS_M` 150, `INLAND_RADIUS_M` 120), the tag predicates,
  park association, the pond filter, `sortLayerFeatures` (a total order over `(osmType, osmId)`,
  because FlatGeobuf's Hilbert storage order reshuffles on every rebuild while both the park
  tie-break and the merge dedupe resolve by first seen), and `probeVertices`: every
  classification distance is measured from the beach element's own member **vertices**, never
  its centroid.
- **`src/layerGrid.js`** — two spatial indexes. Mode A buckets by envelope, for park containment
  and water matching. Mode B indexes the **segments**, because an envelope grid prunes nothing
  for the six Great Lake polygons: their bounding boxes contain essentially every Great Lakes
  beach. Mode B keeps typed arrays rather than a multi-gigabyte GeoJSON heap.
- **`src/layerDiscovery.js`** — `discoverFromLayers`, plus hole-aware park containment and
  the pond water pooling. Only beaches, parks and other-relations are materialised; coastline,
  water and lakes stream through `readFgbStream` once each into the segment index, and a
  coastline or water way is retained for discovery only when its radius-padded envelope
  overlaps a beach envelope (`buildPondEvidenceFilter` / `pondEvidenceCandidate`, the same
  test `poolPondWaters` applies), so the retained subset is O(beaches) and a continental
  coastline costs the process its typed-array segments alone. The run log reports both the
  streamed and the retained counts per layer.
- **`src/layerSignals.js`** — the water-class **signal provider**.
- **`src/layerManifest.js`** — manifest verification and the delete gate.
- **`scripts/lib/fgbReader.js`** — the FlatGeobuf reader, and the **only module in this repo
  with an npm dependency** (`flatgeobuf`, a devDependency). It is never reachable from
  `src/index.js`, and a test asserts that.

Note on the Deno setup, because it bites: `deno.json` and `deno.lock` are **committed**.
`deno.json` carries `"nodeModulesDir": "none"`, so the batch resolves `flatgeobuf` from the npm
cache rather than a CI-absent `node_modules/`, and one import-map entry,
`"flatgeobuf/": "npm:/flatgeobuf@4.4.0/"` — note the **leading slash** after `npm:`, the
canonical Deno form for a trailing-slash directory mapping. The bare specifier is what lets the
same module load under both Deno and vitest, since `npm:` is a Deno-only URL scheme. And
**every** `deno` invocation in this repo, npm script or workflow step, must set
`DENO_NO_PACKAGE_JSON=1`: the repo-root lockfile is auto-discovered for all Deno commands here,
and without that variable Deno folds `package.json`'s npm tree into the lockfile it expects, so
`deno check --frozen` fails with "The lockfile is out of date" and a plain `deno run`
**silently rewrites the checked-in lock**. Do not fix that by regenerating the lock without the
variable.

## Faithful to the Worker's semantics

The emitted SQL preserves every invariant the previous pipeline established
(`test/discoveryBatch.test.js` locks this down):

- **Enrichment columns are preserved.** The upsert is
  `INSERT … ON CONFLICT(id) DO UPDATE SET name, lat, lon, park_name, …` and never touches
  `nws_zone` / `nws_grid_url` / `eccc_zone` / `webcam_*`, so a bulk reload cannot clobber what
  the enrichment crons filled.
- **Moved-centroid reset.** A re-discovered beach whose centroid moved > ~0.001° has its
  `water_class` reset to re-classify.
- **Reconciliation is guarded by a gate that does not decay.** Stale unnamed-park rows
  (`name = park_name`, inside a discovery region per `pointInAnyRegion`, not produced this run)
  are deleted only under a verified, complete, in-scope, fresh layer set. The single pure
  predicate is `reconciliationAllowed(report)` in `src/layerManifest.js`, and it is the sole
  choke point, so the unit-tested invariant *incomplete coverage means no DELETE* holds. Every
  conjunct is a locally-checkable fact about bytes on disk. Scoping candidates by
  `pointInAnyRegion` **fails safe**: shrinking a box only drops rows from the candidate set, so
  an over-tight box under-deletes rather than deleting a real, enriched beach.
- **Two proportional delete rails, and each refuses the whole run.** Global: at most
  `max(RECONCILE_MAX_DELETES = 10, ceil(0.05 × candidates))`. Coverage is either
  verified-complete or gated off, so a large fraction of candidates is never a legitimate
  delete run; at 0.05 a parks-layer shrink, a single-region parks loss and a clip-mask bug that
  zeroes one lake all refuse. A false refusal costs one day. Per-region, applied after the
  global rail: each `REGIONS` box gets
  `max(REGION_RECONCILE_MIN_DELETES = 2, ceil(0.05 × that region's candidates))`, and any
  single region over its allowance refuses the whole run, because the global rail's protection
  asymptotes toward zero as the number of independently breakable clip masks grows. The floor
  is 2 because the region tail is single-digit (Niagara has 5 park-origin candidates, St. Marys
  6), and a floor of 10 would make the rail vacuous for exactly the regions a global rail can
  never protect.
- **The parks layer gets its own valve.** `parksLayerHealthy(report)` supplies `hasPark`; when
  it is false the upsert drops to the five-column variant and leaves `park_name` untouched.
  "Present under a verified manifest" and "correctly populated" are different predicates.
  Hardcoding this true would let a short parks layer blank `park_name` on every named row in the
  missing parks and strand the park-origin rows those names produced as **delete candidates**. A
  `parks-line` count of zero is **not** a refusal: GDAL routes closed area-tagged ways to
  multipolygons, so at Great Lakes scope that layer is legitimately empty. The hard zero refusal
  sits on `parks-polygon`, where membership, and therefore every delete candidate, comes from.
- **Classification is gated symmetrically.** It runs only when `classificationAllowed(report)`
  is true. A `fatal` manifest tier exits 1 with no SQL; an `incomplete` tier suppresses **both**
  deletes and classification; a `scope_or_stale` tier (a `regionsDigest` mismatch, or an extract
  past `MAX_SOURCE_AGE_DAYS = 21`) suppresses deletes only. Classification needs a gate for the
  same reason deletes do: deciding `inland` **hides** a beach.
- **A classification flip rail.** `CLASSIFY_MAX_HIDE_FLIPS = 10` /
  `CLASSIFY_MAX_HIDE_FRACTION = 0.10`. Every flag-worthy row classifies through one code path,
  so a broken build plus a `WATER_CLASS_VERSION` bump could re-decide all of them in one delta
  and empty the site, with the row count unchanged and every delete rail green. Over the
  allowance the whole `water_class` block is refused rather than partly applied, and the run
  logs the before/after transition matrix either way.
- **Whole-table classification, in the same pass as discovery.** The queue is every beach
  (snapshot ∪ newly discovered, minus reconcile-deletes) where `water_class IS NULL OR
  water_class_version < WATER_CLASS_VERSION` and
  `water_class_attempts < WATER_CLASS_MAX_ATTEMPTS`, plus a one-time re-drain of rows left
  unclassified at or above the cap by the pre-decisive classifier (`water_class_version IS
  NULL`, attempts deliberately **not** reset so they stay hidden while they re-decide).
  Decisions reset attempts to 0. `water_class_attempts` is otherwise vestigial: a local join
  has no transient-failure mode.
- **The signal provider's null contract is the whole attempts semantics.**
  `waterClassSignals(index, beach)` returns exactly
  `{ coastlinePresent, nearbyLakeQids, nearbyWayWater }` or `null`. `null` means **transient**
  — do not bump attempts, leave the row queued — and is returned in exactly three cases: an
  unqueryable index, an unparseable `osm_id`, and no beach feature indexed under that id. A
  signals object, **including the all-empty one**, is a complete answer that `classifyWaterBody`
  decides on, and all-empty decides `inland`. The provider must return `null`, never empty
  signals, on incompleteness: empty signals on a data bug would publish `inland`, hiding the
  beach. `beachAbsentFromLayers` separates the case where the element is simply not in the layer
  set, reported as its own `absent_from_layers=` counter.
- **A complete answer always decides.** `classifyWaterBody` classifies a clean-but-empty result
  as `inland` rather than leaving the row NULL, so `bumped` should read 0 in every run log and a
  nonzero value means the classifier regressed to a pending state. Leaving away-from-water
  beaches NULL is worse, because `FLAG_WORTHY_WATER_SQL` is fail-open for NULL under the cap, so
  those rows are served live with estimated flag cards (the Locklin Pines exposure). The
  `inland=N (no_water=M)` summary splits rows decided by the empty branch from those with a real
  adjacent water way.
- **`flag_history` prune runs here.** The 90-day retention sweep is emitted by the batch job,
  in its own try/catch, so a pruning failure never costs a discovery run.

## Prerequisites

1. **Migration 0009 applied to remote D1**, so the `water_class` columns exist. Export
   `CLOUDFLARE_API_TOKEN` from `CLOUDFLARE_WORKERS_EDIT_TOKEN` in `.dev.vars`, then
   `npx wrangler d1 migrations apply swim-report --remote`.
2. **Repository secret `CLOUDFLARE_D1_EDIT_TOKEN`**, D1 edit scope on `swim-report`, read by
   `discovery.yml`. No npm private-registry tokens are needed: the workflow never runs
   `npm install` in the repo, which would reify `package.json`'s private `@web.awesome.me` and
   `@fortawesome` dependencies and fail. Every wrangler call goes through
   `npx --yes wrangler@<pin>`, which never consults the repo's `package.json`.
3. **The R2 bucket `swim-report`**, served publicly at `https://map.swim.report`, plus
   repository secrets **`CLOUDFLARE_R2_ACCESS_KEY`** and **`CLOUDFLARE_R2_SECRET_ACCESS_KEY`**,
   used by the **layer build only**. The discovery job needs no R2 credentials. Nothing in the
   Worker holds a binding to this bucket, deliberately.

## Running

Locally (dry run: produce the SQL, do not apply; needs Deno and a snapshot):

    export CLOUDFLARE_API_TOKEN=…   # CLOUDFLARE_WORKERS_EDIT_TOKEN from .dev.vars
    DENO_NO_PACKAGE_JSON=1 deno run --allow-net --allow-read --allow-write \
      scripts/fetch-layers.js --dest ./.layers
    node scripts/snapshot-d1.js --db swim-report --remote \
      --columns "id, osm_id, name, lat, lon, park_name, nws_zone, marine_zone, water_class, water_class_version, water_class_attempts" \
      --out snapshot.json
    DENO_NO_PACKAGE_JSON=1 deno run --allow-read --allow-write \
      scripts/discovery-batch.js --layers ./.layers --snapshot snapshot.json \
      --out discovery-delta.sql
    # inspect discovery-delta.sql, then apply when satisfied:
    npx wrangler d1 execute swim-report --remote --file discovery-delta.sql

Note the permission sets: `fetch-layers.js` is the one script that needs `--allow-net`, and
`discovery-batch.js` deliberately does not get it.

Flags: `--layers <dir>` (required for discovery and classification), `--report <path>`
(defaults to `<layers>/report.json`), `--no-classify`, `--no-discovery` (skips discovery,
reconciliation and deletes), `--marine-zones <path>`, `--snapshot <path>`, `--out <path>`,
`--now <iso>`. `--no-classify --no-discovery` together is not an error as long as
`--marine-zones` is passed — that is what `npm run seed:marine` runs. The `nothingToDo` guard
errors only when all three passes are off.

For **local dev**: `npm run seed:layers` fetches and verifies the layer set into `./.layers`,
once per layer build rather than per seed; `npm run seed` then scans it and applies the delta
with `node scripts/apply-local-sql.js`, which splits it into <90 KB line-aligned chunks. The
chunking exists because wrangler's local apply hands the whole file to miniflare/workerd as a
single SQL call capped at 100,000 bytes (`SQLITE_TOOBIG`), and a full delta is ~700 KB. The
remote apply the workflow uses is unaffected, since it uploads through the D1 import API.

In CI: `build-layers.yml` runs twice weekly and `discovery.yml` daily plus on each successful
build, in separate concurrency groups. Both have a manual `workflow_dispatch`; `discovery.yml`
takes an `apply` input (false = artifact-only dry run) and uploads its delta as
`discovery-delta.sql` for inspection.

## Offline marine-zone pass

`beaches.marine_zone` — the adjacent NWS marine forecast zone (e.g. `LMZ874`) the hourly
recompute matches marine warnings and Small Craft Advisory against — is derived by the daily
discovery run with pure local math and zero upstream requests, by passing
`--marine-zones data/marine-zones.json` to `discovery-batch.js`. NWS already
publishes the mapping as a shapefile.

**The pass** (`marineZoneSql` in `discovery-batch.js`, geometry in `src/marineZones.js`)
mirrors `reconcileStaleRows`: it operates only on snapshot rows, skips rows in this run's
delete set, and for every row with `nws_zone` set derives the nearest marine zone via
`nearestMarineZone(index, lat, lon)` — point-in-polygon first, else nearest polygon edge within
`MARINE_ZONE_MAX_DISTANCE_KM = 15` km, else null. A `<1e-9` km tie resolves to the
lexicographically smallest id, so a steady-state run emits zero statements. It re-derives for
**every** `nws_zone` row, not only `marine_zone`-NULL ones, and emits an `UPDATE` only when the
derived zone is non-null and differs: a derived null never NULLs an existing value. The pass
never affects `reconciliationAllowed` or the delete path, and it stamps `sync_meta` keys
`last_marine_zone_pass` / `last_marine_zone_count`. A beach discovered this run resolves on the
next daily run, once NWS enrichment has stamped its `nws_zone`.

There is **one** snapshot, because discovery and classification run in the same pass:
`discovery.yml`'s `SELECT` reads exactly the union of what `reconcileStaleRows`,
`marineZoneSql` and `buildClassifyQueue` need, and nothing else. Do **not** re-introduce a
second snapshot. It is read through `scripts/snapshot-d1.js`, so the page walk and the count
guard that abort this only delete-bearing run on a partial table live in one place.
`beaches.marine_attempts` is vestigial — the column is retained with no writers.

**The committed data file** — `data/marine-zones.json`, generated by
`scripts/build-marine-zones.js` from the NWS coastal marine-zone shapefile. Shape:

    {
      "source": "https://www.weather.gov/source/gis/Shapefiles/WSOM/mz16ap26.zip",
      "validDate": "2026-04-16",
      "generated": "<ISO timestamp>",
      "simplifyToleranceDeg": 0.002,
      "zones": [
        { "id": "LMZ874", "polygons": [ [ [ [lon, lat], ... ] ] ] },
        ...
      ]
    }

`polygons` is GeoJSON-MultiPolygon-shaped (`polygons` → rings → `[lon, lat]`); ring 0 is the
outer ring and the rest are holes; rings are closed; coordinates are rounded to 5 decimals. One
zone per line, for a readable diff. Every prefix in the coastal shapefile is kept
(`COASTAL_ZONE_PREFIXES`: AMZ, ANZ, GMZ, PZZ, PKZ, PHZ, PMZ, PSZ and the seven Great Lakes,
St. Lawrence and St. Clair prefixes; 569 zones in the mz16ap26 release). A prefix the list
does not name is counted and logged as `SKIPPED`, never dropped silently, so read the log
after a regenerate. The offshore and high-seas shapefiles are separate releases and out of
scope. Polygons are simplified at a `0.002`-deg tolerance, about 220 m of maximum
displacement, negligible against both the 15 km cap and the ~5 NM zone widths; tighter
tolerances buy little because the file's floor is its ring count (thousands of small island
holes), not its point count.

**Refresh procedure** (NWS republishes the shapefile once or twice a year):

1. Update `DEFAULT_ZIP_URL` and `RELEASE_VALID_DATE` in `scripts/build-marine-zones.js`; the
   zip filename changes each release.
2. Run `deno run --allow-net --allow-read --allow-write scripts/build-marine-zones.js`. It uses
   **no npm packages**: it reads the zip central directory, inflates with
   `DecompressionStream`, and parses the DBF and SHP binary layouts directly, importing only
   `pointInRing` from `src/geo.js`.
3. Review the logged per-prefix zone counts against the previous release and eyeball the diff.
4. Run `npm test` (`test/marineZones.test.js` sanity-checks the committed file) and commit.

Point-in-polygon plus nearest-edge resolves the true nearest nearshore zone. A first-ring-hit
heuristic does not: Holland, MI sits inside `LMZ874` ("5NM offshore to Mid Lake") while its
true nearest nearshore zone is `LMZ846` ("Holland to Grand Haven MI").
