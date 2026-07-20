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
  half hourly (`23 * * * *`, plus `workflow_dispatch`), running the
  script with `--no-discovery --classify-limit 25` (classify-only: no tiling, no
  upserts, no reconciliation, no deletes; emits **only** `water_class` UPDATEs,
  25 per run — short, polite Overpass bursts at ~600/day, the same throughput as
  the old 4×-daily 150/run cadence; manual runs default to 150 for bulk drains —
  draining the NULL/stale queue over repeated runs). It lives in its
  own workflow — and a distinct concurrency group (`classify`, disjoint from
  discovery's) so the two can run concurrently — because classification is
  hundreds of **sequential** per-beach Overpass probes, the pipeline's long pole:
  bundled into discovery it threatened the job's time budget and coupled its
  flakiness to discovery. A single per-beach probe failure is non-fatal (the row
  stays queued for the next run), so classify has no all-or-nothing abort.

  **Wall-clock budget (60 min) vs job timeout (90 min).** Under public-Overpass
  504 storms each per-beach probe is slow, so 150 sequential probes overran the
  `timeout-minutes: 90` job cap and GitHub CANCELLED the run mid-queue. A cancelled
  step's later steps SKIP under their default `if`, so the Upload+Apply steps never
  ran — every scheduled run persisted ZERO `water_class` progress. The PRIMARY fix
  is a self-imposed wall-clock budget: `classify.yml` passes
  `--classify-budget-ms $((CLASSIFY_BUDGET_MIN * 60000))` (`CLASSIFY_BUDGET_MIN=60`),
  so the classify loop returns, `main()` exits 0, the classify step SUCCEEDS, and
  Upload+Apply run on their normal gate — loading the full flushed delta.
  `timeout-minutes: 90` stays as a hard backstop. The 30-min gap between budget and
  timeout is the budget-to-timeout margin, not the exact stop time: the budget is
  checked only at the TOP of each loop iteration, so a probe already in flight can
  push the actual process exit past the 60-min mark by up to one full 2-mirror
  Overpass timeout (~8 min worst case with both mirrors dead-hanging). That leaves
  ~22 min of real headroom below the 90-min cap — deliberately larger than any
  single probe — plus ~4 min job setup and ~2 min apply still fit under 90.

  The budget is the dependable mechanism, but it is backed by TWO belt-and-suspenders
  layers so a hard timeout-cancel is never catastrophic: (1) the classify SQL is
  flushed INCREMENTALLY (the preamble is written before the loop, then each complete,
  newline-terminated `UPDATE …;` is appended the instant it is decided), so a valid
  statement-boundary-clean partial `.sql` always survives even a hard kill; (2)
  Upload+Apply are `always()`-gated — NOT `!cancelled()`, which a `timeout-minutes`
  cancel would SKIP (that cancel sets the `cancelled()` context true, so the belt
  path would be dead in exactly the case it exists for). `always()` runs inside the
  ~5-min cancellation grace window, enough for one `wrangler d1 execute`. It is safe
  on a genuine unrelated failure (a bad token failing Snapshot leaves no delta file):
  `if-no-files-found: ignore` makes upload a no-op, and Apply first truncates the
  delta to its last complete `;`-terminated statement (so a torn SIGKILL tail can
  never reach wrangler and fail the whole apply) then short-circuits on a
  `[ ! -s classify-delta.sql ] || ! grep -q ';'` guard — a missing/empty/statement-less
  delta applies as a harmless idempotent no-op. No SIGTERM/SIGINT handler is added:
  the step is a bash `run: |` block and GitHub signals bash, which does not reliably
  forward signals to the child Deno process, so the graceful budget (exit 0) is the
  dependable mechanism.

  **Drain liveness under sustained outages.** A transient probe failure (null
  Overpass signals) emits NO statement and does NOT bump `water_class_attempts`, so
  a persistently-failing beach stays at the attempts-ASC queue head and is re-probed
  first on every run. During a sustained 504/hang storm a budget-stopped run can burn
  its whole budget on a few TCP-hanging heads, emit zero decisions, and never reach
  `WATER_CLASS_MAX_ATTEMPTS` to retire them — decided/bumped beaches advance, but
  fetch-failed beaches do not. This is pre-existing (the in-Worker `runWaterClassification`
  behaved the same) and the budget is a strict improvement over the old
  cancel-everything-persist-nothing behavior, but operators should know a stuck head
  can stall drain until Overpass recovers.
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
  identity (`mergeBeachRows` also keys by id, so the merge is idempotent).
  **Upserts are decoupled from reconciliation** (the safety invariant is that a
  DELETE runs only under *provably-complete* coverage): the named loop is
  **best-effort** — a tile still null after its retries no longer aborts the run, the
  loop **continues past it** to salvage **every** tile that DID fetch, regardless of
  *which* tile failed. It emits UPSERTS for those fetched tiles while **skipping
  reconciliation entirely** whenever coverage is incomplete
  (`namedComplete = (namedTilesOk === tiles.length)`, so any failed/skipped/budget-
  stopped tile flips it `false`) — a beach that merely sat in an un-fetched tile is
  never read as "gone from OSM", so it can't be wrongly deleted. Best-effort (rather
  than break-early) is deliberate: the motivating outage was "32 of 33 tiles
  succeeded", and the observed failure mode is *contiguous* multi-minute 504 bursts,
  so a break-early prefix would lose **every** tile after the burst even once it
  clears; continuing salvages them. Three **total-outage guards** keep a hopeless run
  cheap so best-effort never regresses to a tens-of-minutes grind-that-ingests-nothing:
  (1) `shouldFastDefer` — an early circuit breaker that aborts with no SQL after
  `OVERPASS_DISCOVERY_MAX_FAILED_TILES` (3) failures **while zero tiles have
  succeeded** (~4-5 min, mirrors down from the start; once any tile succeeds it
  disarms and the run commits to best-effort); (2) a post-loop `namedTilesOk === 0`
  defer (aborts if the loop ended having fetched nothing, e.g. the budget elapsed at
  zero); (3) `OVERPASS_DISCOVERY_BUDGET_MS` (90 min, under the 120-min job timeout),
  a wall-clock backstop reusing `budgetExhausted` that breaks the loop at the deadline
  leaving coverage incomplete (upserts-only). A hopeless run exits 1 (Upload+Apply
  skip, fast-defer); a partial-but-productive run exits 0 (so `Apply` applies its
  upserts). Park beaches are fetched **only when the named pass completed** (the
  delete pass, the sole consumer that needs park data, is already off under partial
  named coverage, so probing park tiles during an outage is wasted Overpass load);
  any park tile still null then degrades to named-only (`parkBeaches = null`, no
  reconciliation), and the same wall-clock backstop bounds the park loop too. The gate
  is a single pure predicate, `reconciliationAllowed(namedComplete, parkComplete)`
  (both must be `true`), unit-tested in `test/discoveryBatch.test.js` alongside
  `shouldFastDefer`. `sync_meta` records a `last_overpass_complete` marker
  (`true`/`false`) alongside `last_overpass_count` so an operator never reads a
  partial run's smaller count as a table shrink. Discovery deliberately does **not**
  adopt classify's `always()` / incremental-flush / truncate machinery: it writes its
  whole delta atomically at the end (a clean exit-0-with-complete-file /
  exit-1-no-file binary, no torn-tail window), and its slow risk is the upstream
  Overpass fetch — which the three guards bound — not a long local emit loop. This is
  also the North America expansion rail — appending coastal boxes to `REGIONS` fans
  out into per-tile queries that each stay under the timeout, with no other code change.
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
(default 300), `--classify-budget-ms N` (self-imposed wall-clock cap on the
classify loop; 0 = disabled/full drain), `--now <iso>`.

For **local dev**, `npm run seed` is now this same offline batch pointed at the
local D1: it runs `scripts/discovery-batch.js --out ./.seed.sql --no-classify`
(discovery only, no snapshot) and applies the delta with
`node scripts/apply-local-sql.js ./.seed.sql`, which splits it into <90 KB
line-aligned chunks and runs one `wrangler d1 execute --local --file` per
chunk. The chunking exists because wrangler's LOCAL apply hands the whole file
to miniflare/workerd as a single SQL call, capped at 100,000 bytes
(`SQLITE_TOOBIG`) — a full delta is ~700 KB. The REMOTE apply the workflows use
is unaffected (it uploads through the D1 import API and ingests server-side).
`npm run seed:classify` runs the batch without `--no-classify` to also emit
`water_class` updates. Both replace the old "trigger the discovery cron" seed
path, which no longer exists in the Worker.

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
