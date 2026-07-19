# Offline discovery + water classification (GitHub Actions)

Beach **discovery** (OpenStreetMap/Overpass) and **water-body classification**
are *pipeline* concerns — they run occasionally, tolerate hours of latency, and
produce a table — not *serving* concerns. This directory's pipeline moves them
out of the Cloudflare Worker cron and into an offline GitHub Actions batch job
that bulk-loads production D1. The Worker keeps everything else: serving, the
hourly flag recompute, the 6-hourly wave refresh, and NWS/ECCC/webcam
enrichment.

## Why

The in-Worker crons `runOverpassSync` (`47 8 * * *`) and `runWaterClassification`
(`37 1,7,13,19 * * *`) — now **retired** — processed a rationed handful of rows per invocation
(`WATER_CLASS_LIMIT = 25`, `WATER_CLASS_DELTA_CAP = 25`) because a Worker
invocation is bounded (CPU / subrequest / wall-clock caps) and Overpass allows
only 2 slots per IP. That "N per run → park → drip over days" pattern is a
workaround for platform limits, and the initial classification backfill of the
~700-row pilot takes roughly a week of drips. README already anticipated a
"one-time bulk backfill … outside the cron"; this **is** that backfill,
generalized and scheduled.

An offline job can run a plain loop for minutes, pace Overpass politely with no
subrequest ceiling, and write the whole table at once. The same constraint that
made continental scale-out slow (rationing 25–50 rows per cron window) disappears
when discovery/classification is a batch that produces a table and the Worker
just serves it.

## The two-path rule still holds

Nothing about the Worker changes. The **request path** still reads only D1 + KV.
The **cron path** still owns the Worker's own upstream fetching. This batch job
is a **third, offline path** that writes D1 out-of-band — it never runs inside
the Worker.

## Pieces

- **`scripts/discovery-batch.js`** — Deno script. Imports the discovery +
  classification logic *verbatim* from `src/` (`mergeBeachRows` from
  `src/discovery.js`; `fetchBeaches` / `fetchParkBeaches` /
  `fetchWaterClassSignals` from `src/clients/overpass.js`; `classifyWaterBody`
  and the version/attempts constants from `src/waterClass.js`), so it can never
  diverge from the Worker. It reads a D1 snapshot, fetches Overpass, classifies,
  and emits **one idempotent `.sql` delta**. The two halves are selected by flag:
  `--no-classify` emits the discovery delta (upserts + reconciliation deletes +
  `flag_history` prune + `sync_meta`), `--no-discovery` emits the classify delta
  (`water_class` UPDATEs only), and running with neither flag emits both. Passing
  both `--no-discovery` and `--no-classify` is a guarded error (nothing to do). It
  writes no database itself.
- **`.github/workflows/discovery.yml`** — schedules the **discovery** half daily
  (`47 8 * * *`, plus manual `workflow_dispatch`), snapshots D1, runs the script
  with `--no-classify` (Overpass tiling → upserts + stale-row reconciliation +
  `flag_history` retention + `sync_meta`; no `water_class` UPDATEs), uploads the
  `.sql` as an artifact, and applies it with `wrangler d1 execute --remote
  --file`. `timeout-minutes: 120`.
- **`.github/workflows/classify.yml`** — schedules the **water-classification**
  half 4× daily (`23 2,8,14,20 * * *`, plus `workflow_dispatch`), running the
  script with `--no-discovery --classify-limit 150` (classify-only: no tiling, no
  upserts, no reconciliation, no deletes; emits **only** `water_class` UPDATEs,
  150 per run, draining the NULL/stale queue over repeated runs). It lives in its
  own workflow — and a distinct concurrency group (`classify`, disjoint from
  discovery's) so the two can run concurrently — because classification is
  hundreds of **sequential** per-beach Overpass probes, the pipeline's long pole:
  bundled into discovery it threatened the job's time budget and coupled its
  flakiness to discovery. A single per-beach probe failure is non-fatal (the row
  stays queued for the next run), so classify has no all-or-nothing abort.
- **`src/discovery.js`** — the extracted pure merge logic, imported by BOTH the
  Worker (`src/index.js`, which re-exports `mergeBeachRows` for tests) and the
  batch script. Its only dependency is `src/geo.js`.
- **`src/regions.js`** — the discovery region set: `REGIONS` (a curated array of
  coastal bounding boxes tracing the entire Great Lakes shoreline, US and
  Canadian) plus the pure predicate `pointInAnyRegion(lat, lon)`. Pure data + one
  function, no imports, so the Deno batch imports it verbatim like `src/geo.js`.
  It replaces the old single Michigan `PILOT_BBOX`: `runDiscovery` tiles **every**
  region, and `reconcileStaleRows` scopes its delete candidates through
  `pointInAnyRegion` (see below).

The classifier itself is **reused, not authored here**: `classifyQueue()` in the
script wraps the existing per-beach probe (`fetchWaterClassSignals` +
`classifyWaterBody`) as a deliberate **seam**. To use a smarter bulk classifier
(e.g. the segment-index approach in README's "One-time bulk backfill" note),
replace that one call — or pass `--no-classify` and generate `water_class`
`UPDATE`s from a separate tool. Everything else (queue construction, the
NULL/version/attempts gate, SQL emission) stays put.

## Faithful to the Worker's semantics

The emitted SQL mirrors what the retired `runOverpassSync` cron did
(`test/discoveryBatch.test.js` locks this down):

- **Enrichment columns are preserved.** The upsert is
  `INSERT … ON CONFLICT(id) DO UPDATE SET name, lat, lon, park_name, …` — it
  never touches `nws_zone` / `nws_grid_url` / `eccc_zone` / `webcam_*`, so a bulk
  reload can't clobber what the enrichment crons filled.
- **Moved-centroid reset.** A re-discovered beach whose centroid moved > ~0.001°
  has its `water_class` reset to re-classify (same `CASE WHEN abs(lat-…)` clause).
- **Reconciliation is guarded.** Stale unnamed-park rows (`name = park_name`,
  inside a discovery region per `pointInAnyRegion`, not produced this run) are
  deleted only when the run produced ≥1 park row and the stale set is within the
  proportional rail (`max(10, 25% of candidates)`) — a partial/truncated Overpass
  result never mass-deletes. The Overpass client already treats a truncation
  `remark` as failure, so a partial result never reaches the script. Scoping the
  candidate set by `pointInAnyRegion` **fails safe**: shrinking or removing a box
  only ever drops rows from the delete-candidate set (they are left alone), never
  adds one, so an over-tight box under-deletes rather than deleting a real,
  enriched beach.
- **Tiled discovery queries.** A single named-beach query over even one large
  region box exceeds Overpass's server-side timeout and comes back a truncated
  `remark`. `runDiscovery` iterates every box in `REGIONS` and `tileBbox()` splits
  each into a grid of sub-boxes (≤ `TILE_MAX_SPAN_DEG`, currently 2.0°, with a
  small edge overlap); even so a 2° tile needs ~53–67 s to answer even on a healthy
  mirror, so the named query runs `[timeout:90]` (raised from `[timeout:60]`, which
  left near-zero margin) under a tighter per-query transport cap
  `OVERPASS_NAMED_TIMEOUT_MS = 150000` (must exceed the 90 s server budget plus
  queue/transfer slack; the park and water-class queries keep the 240000 default).
  Results are concatenated across all tiles of all regions and deduped by OSM
  identity (`mergeBeachRows` also keys by id, so the merge is idempotent). The
  all-or-nothing invariants are preserved per-pass: **any** named tile still null
  after its retries aborts the whole run with no SQL; **any** park tile still null
  degrades the whole run to named-only (no reconciliation), so the delete path
  never runs against a region whose park query failed. This is also the North
  America expansion rail — appending coastal boxes to `REGIONS` fans out into
  per-tile queries that each stay under the timeout, with no other code change.
- **Overpass burst resilience.** The public mirrors periodically return HTTP 504
  overload bursts on both hosts at once. Each per-tile fetch therefore makes
  `OVERPASS_TILE_ATTEMPTS = 3` bounded exponential-backoff-plus-jitter retries
  (`backoffDelayMs`, base 30 s, cap 120 s), replacing the old single fixed retry —
  spreading attempts across several minutes rides out a transient burst, while the
  cap means a **sustained** outage fails fast and defers to the next scheduled run
  rather than burning the whole job window. Adding more mirrors was investigated
  and is **not** safe right now, so the list stays `overpass-api.de` +
  `private.coffee`: `kumi.systems` shares Private.coffee's backend (false
  redundancy), and regional instances (e.g. `overpass.osm.ch`) return **empty** for
  North America — a fast-empty result is dangerous here because it could drive
  reconciliation deletes.
- **Whole-table classification.** The queue unifies the Worker's whole-table
  `runWaterClassification` with `runOverpassSync`'s synchronous discovery-delta:
  every beach (snapshot ∪ newly discovered, minus reconcile-deletes) where
  `water_class IS NULL OR water_class_version < WATER_CLASS_VERSION` and
  `water_class_attempts < WATER_CLASS_MAX_ATTEMPTS`. Decisions reset attempts to
  0; clean-but-empty probes bump attempts; transient Overpass failures are
  skipped (no bump) — identical to `classifyBeaches`.
- **`flag_history` prune moves here.** The 90-day retention sweep that lived in
  `runOverpassSync` is emitted by the batch job, so it survives the cutover.

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

## Running

Locally (dry run — produce the SQL, don't apply; needs Deno + a snapshot):

    export CLOUDFLARE_API_TOKEN=…   # from .dev.vars (CLOUDFLARE_TOKEN)
    npx wrangler d1 execute swim-report --remote --json \
      --command "SELECT id, osm_id, name, lat, lon, park_name, water_class, water_class_version, water_class_attempts FROM beaches" \
      > snapshot.json
    deno run --allow-net --allow-read --allow-write \
      scripts/discovery-batch.js --snapshot snapshot.json --out discovery-delta.sql
    # inspect discovery-delta.sql, then apply when satisfied:
    npx wrangler d1 execute swim-report --remote --file discovery-delta.sql

Flags: `--no-classify` (discovery only), `--no-discovery` (classify only; the two
are mutually exclusive halves and passing both is a guarded error),
`--classify-limit N` (cap per run; 0 = all), `--classify-delay-ms N`
(default 300), `--now <iso>`.

For **local dev**, `npm run seed` is now this same offline batch pointed at the
local D1: it runs `scripts/discovery-batch.js --out ./.seed.sql --no-classify`
(discovery only, no snapshot) and applies the delta with
`wrangler d1 execute swim-report --local --file ./.seed.sql`. `npm run
seed:classify` runs it without `--no-classify` to also emit `water_class`
updates. Both replace the old "trigger the discovery cron" seed path, which no
longer exists in the Worker.

In CI: `discovery.yml` runs daily and `classify.yml` runs 4× daily (in their own
concurrency groups, so they may overlap — they touch disjoint columns); each has a
manual `workflow_dispatch` that lets you choose `apply` (false = artifact-only dry
run) and a `classify_limit`. Every run uploads `discovery-delta.sql` as an
artifact for inspection.

## Cutover (complete)

The offline job is now the **sole owner** of beach discovery and water-body
classification. The two in-Worker triggers were retired:

1. ✅ Repo pushed to GitHub, `CLOUDFLARE_API_TOKEN` secret set, migration 0009
   applied remotely.
2. ✅ Workflow verified with `apply: false` (artifact sanity-checked for row
   counts and an expected `great_lake` / `inland` mix), then run with
   `apply: true` and D1 confirmed updated.
3. ✅ The two now-redundant triggers were removed from `wrangler.toml`'s `crons`
   array — `"47 8 * * *"` (discovery) and `"37 1,7,13,19 * * *"` (water
   classification) — and deployed. `runOverpassSync` / `runWaterClassification`
   (and `PILOT_BBOX`) are gone from `src/index.js`; the merge logic survives only
   as `mergeBeachRows` in `src/discovery.js`, imported by both the batch and the
   tests.

The Worker's remaining cron path is: hourly flag recompute (`"0 * * * *"`),
6-hourly wave refresh (`"15 */6 * * *"`), and the NWS/ECCC/webcam enrichment crons
(`"17 3,9,15,21"`, `"29 4,10,16,22"`, `"31 9"`). Discovery + classification are
the offline job's alone.
