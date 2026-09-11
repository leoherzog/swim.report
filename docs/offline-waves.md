# Offline wave sampling from NOAA GRIB2 model output (GitHub Actions)

Wave height and the wind fallback change every few hours, tolerate latency, and produce one
number per beach per hour. They are sampled outside the Worker, in a GitHub Actions job that
decodes NOAA GRIB2 output with GDAL, resolves each beach to a wet grid cell, and bulk-writes
the result into the `waveinput:` and `waves:` KV keys the hourly flag cron reads. The Worker
reads those keys through `src/waveInput.js`, which indexes each record's series at the hour
being estimated; nothing on the request path changes.

**Blast radius.** This job never writes a flag color. A failed or refused cycle writes no KV
and leaves the previous cycle's keys under an expiration derived from that cycle's own model
valid time, so the failure mode is a flag aging out to `unknown` — gray and honest — never a
stale wave height deciding a color. Republishing an older cycle yields a short or negative
lease and is refused by construction.

## The two-path rule still holds

The Worker request path still reads only D1 and KV. The grids are read by the offline job
alone, and `wrangler.toml` deliberately carries no `r2_buckets` binding. The hourly cron reads
`waveinput:` from KV and fetches nothing.

## The grid set

Four grids in ordered fallthrough, constrained by each beach's `water_class`: `great_lake` may
match only `noaa_glwu`, `ocean` the three ocean grids, and a NULL class may try every grid,
each in `GRIDS` order. A beach out of extent, or with no wet cell inside its cap, falls through
to the next permitted grid and then to null.

| id | source | grid | nodata | cap |
| --- | --- | --- | --- | --- |
| `noaa_glwu` | NOMADS | `glwu.grlc_2p5km_sr`, 2.5 km Lambert, 49 steps in one file | 9.999000260554009e+20 | 10 km |
| `noaa_gfswave` | AWS `noaa-gfs-bdp-pds` | `gfswave.global.0p16`, 2160x406 at 0.166666 deg | 9999 | 25 km |
| `noaa_gfswave_arctic` | AWS `noaa-gfs-bdp-pds` | `gfswave.arctic.9km`, polar stereographic | 9999 | 25 km |
| `noaa_nwps_sew` | NOMADS filter CGI | `sew_nwps_CG1`, 99x93 at ~4 km, 145 hourly steps as 290 bands in one file | 9999 | 10 km |

`global.0p16` spans -180.083 to 179.917 and 52.583N to -15.083S, which is why the regional
grids are not fetched. In one file it covers what `wcoast.0p16`, `atlocn.0p16` and
`epacif.0p16` split, closing the gap between wcoast's -109.917 and atlocn's -100.083 edges that
leaves Mexican Pacific beaches uncovered, and it uses the -180..180 convention, so `epacif`'s
0-360 longitude trap does not exist on it. `arctic.9km` covers what `global.0p16` cannot, above
52.58N. GLWU is the only source for the Great Lakes, which gfswave masks entirely.

`global.0p16` is not every ocean beach either: at 0.1667 degrees it masks the sheltered inland
seas whole, so a Salish Sea beach has no wet cell inside any cap. `noaa_nwps_sew` is NOAA's
Nearshore Wave Prediction System nest for the Seattle office, a SWAN run over that water at
about 4 km, and it is **last** in the fallthrough so it is offered only the beaches
`global.0p16` could not resolve. Position is assignment: an earlier one would move thousands of
ocean beaches to a different model while the floors seeded under the current assignment still
validate. Its cap is 10 km for the lakes' reason — a 25 km reach crosses from Puget Sound into
the Strait of Juan de Fuca, a different wave regime. CG1 rather than CG2: the coarser CG2
covers more beaches only on a direct hit, and once the spiral runs CG1 resolves as many or more
at every cap with a sharper land mask. CG0 is swell-partition tracking and carries no `HTSGW`.
Puget Sound sits under the `ocean` class's yellow threshold in fair weather, so a green there
is the model rather than a fault.

The office publishes on demand, when it submits wind grids — in practice near 00Z and 12Z, with
whole days sometimes absent — so `cycleStepHours` 12 addresses the two real publication hours
and `maxCycleAgeHours` 36 walks back three of them. One file carries 145 hourly steps, so a
cycle over a day old still covers the 24 h window. The grid is deliberately outside
`REQUIRED_GRID_IDS`: requiring a grid that publishes on demand would turn one missing office
run into a nationwide refusal, where its absence instead degrades the cycle and every other
grid still writes KV. Its per-grid floor and record-count ratio misses likewise warn rather
than refuse. SWAN wets and dries the nest's shore cells with the tide, so the count resolved at
hour 0 swings about 13% with the tidal phase at validStart, and the grid declares
`recordCountMinRatio` 0.8 so that swing never warns.

NOMADS documents a ten second wait between scripted fetches, honoured by construction: every
NOMADS request is spaced, and each grid's NOMADS request count is capped on its own, because a
shared counter lets one grid's walk-back starve the next grid's cycle. A whole-file grid is one
such request in the normal case. `noaa_nwps_sew` is reachable only through the filter CGI —
there is no NODD or S3 mirror, and the plain directory tree has autoindex off and 403s every
real path under it — and because a CGI is a script rather than a file server its cycle probe is
a GET whose first bytes must read `GRIB`, with the probed bytes kept as the download. A HEAD
proves nothing about a script, and a 200 carrying an error page would take a real sha256 and
surface only as a `gdalinfo` warning two steps later. Every NOMADS request sends a User-Agent,
since an unidentified client is throttled and a 403 there is terminal. The AWS mirror publishes
no such rule and is Range-sliced freely.

## The nearest-wet-cell spiral

This is the sampling mechanism, not a fallback. `nearestWetSample` in `src/waveGrids.js`
searches outward from the beach's cell and returns the wet cell at the **great-circle
minimum** — not the first hit in scan order, and not the lowest ring index. Both cheaper
tie-breaks are wrong and wrong quietly: longitude cells narrow with latitude, so
ring-index-nearest picks the wrong cell at high latitude, and first-hit-in-scan-order returns a
different neighbour than the true nearest. Each produces a plausible wave height with no error
anywhere.

The resolved cell is computed **once** per beach, from the hour-0 wave band, and reused for all
24 hours. On a fixed-mask grid that cell is wet for all 24 hours; on the tidal
`noaa_nwps_sew` nest it can read null at low-water hours. Either way, re-running the search
per hour would let `hoursFt` jump between cells, breaking the `hoursFt[0] === waveinput.waveHeightFt` invariant
and making the detail page's "now" stat contradict its own first bar. A beach on a narrow
peninsula can still find a wet cell on the far side within its cap: `water_class` removes the
worst cases, and the residual is bounded only by the cap and accepted.

## The wind fallback, and which grids may serve it

A beach whose hour-0 wave plane resolved no wet cell inside its cap gets a second pass over the
same grid's hour-0 `WIND` plane, and `src/rules.js` uses that speed only when every wave model
is null. A grid may serve that pass only if it declares `windFallback: true`;
`windFallbackAllowed` in `src/waveGrids.js` is the predicate and it is default-deny, so a grid
that says nothing serves no wind.

A masked cell is not always a sentinel, which is the whole reason for the flag. `noaa_nwps_sew`
writes 0 m/s over land rather than its nodata value — Carr Inlet returns `HTSGW` 9999 beside
`WIND` 0 — and `isUsableSample` accepts 0. Pass 1 already searched the entire cap over the same
cell geometry, so any pass-2 hit necessarily sits on a wave-masked cell: on that grid it is a
fabricated calm at a land cell, which `src/rules.js` colors green and which no build gate can
see. Whether a cell is wet is a question only `HTSGW` can answer.

## Units

GRIB `HTSGW` is **metres**; feet are `metres * 3.28084` (`metersToFeet`, `src/geo.js`). GRIB
`WIND` is **metres per second**; mph is `m/s * 2.2369362920544` (`metersPerSecondToMph`,
`src/waveGrids.js`). `src/rules.js` thresholds are 2 ft yellow, 4 ft red (3 / 6 ft on `ocean` rows), and 15/25 mph.
Handing it metres makes every sea state below 1.22 m read green sitewide; handing it m/s makes
an actual 25 mph arrive as 11. Neither raises an error anywhere, which is why
`test/buildWaveKv.test.js` pins both conversions directly. `windGustMph` is always null,
because no grid in this set publishes a GUST element, so the wind red rule narrows in effect to
sustained speed alone and `src/rules.js` renders `n/a` for the gust.

GRIB nodata is a **number that survives JSON**. 9999 m becomes 32,808 ft and colors a flag red
with a straight-faced reason string; a negative sentinel colors it green. `src/rules.js` tests
`waveHeightFt !== null` with no `isFinite` guard and the cron guards with `typeof === "number"`
only, so containment belongs to the offline writer and nowhere else. Each sentinel is read
**per band** from the raster header, never hardcoded: a check for 9999 alone would pass every
Great Lakes sentinel straight through.

## Decoding requires GDAL

gfswave's GRIB2 data representation template 5.40 is JPEG 2000. There is no pure-JavaScript
decode path, so GRIB2 decoding inside the Worker is impossible and must never be attempted
there. `noaa_nwps_sew` is template 5.0 simple packing, which GDAL reads with no special
handling and which proves nothing about the JPEG 2000 driver, so the smoke decode stays pointed
at gfswave. GDAL runs in the **workflow shell**, which keeps subprocess permission out of the
Deno pipeline entirely: no script carries `--allow-run`, and only
`scripts/fetch-wave-grids.js` carries `--allow-net`.
`.github/workflows/test.yml` enforces the network half machine-side; the subprocess half rests
on review, and extending the guard is tracked in `TODO.md`.

Two GDAL traps the workflow accounts for. GDAL has a documented mode where it returns an empty
result with a zero exit status, so a format-list grep does not prove the JPEG 2000 driver is
present — only a smoke decode asserting a real valid-percent does. And `gdallocationinfo` with
coordinates as arguments prints nothing for an out-of-extent point and exits 1, silently losing
points; reading raw planes in Deno avoids that, and shell-side sampling reintroduces it.

## The pipeline

1. `scripts/fetch-wave-grids.js` resolves the cycle **at runtime** and downloads it.
   `validStart` is the top of the current UTC hour, the hour the published series describes.
   GFS cycles are walked newest-first back 24 hours and the first whose `f(k)..f(k+23)` all
   exist is taken. The job's cadence and the model's are deliberately decoupled, so resolving to
   an older cycle is an ordinary, healthy outcome. A whole-file grid walks its own
   `cycleStepHours` steps back through `maxCycleAgeHours` and takes the first cycle actually
   published: GLWU on its hourly cycle, `noaa_nwps_sew` on the office's 00Z/12Z one.
2. The shell captures a `gdalinfo -json` sidecar per file.
3. `scripts/sample-waves.js --mode plan` names the band index carrying each hour's `HTSGW` and
   `WIND`, **discovered** from the sidecars and never assumed, and records a per-grid verdict
   in `gridStatus`. Assuming a layout is how an `.idx` off-by-one becomes a complete,
   plausible, silently time-shifted series.
4. The shell extracts each planned band to a flat ENVI plane — `gdal_translate` for the two
   lat/lon grids, `gdalwarp` for the two projected ones. `-r near` is mandatory on the warp: any
   interpolating resampler smears wave values across the land mask and manufactures readings on
   shore.
5. `scripts/sample-waves.js --mode sample` samples every beach in the D1 snapshot and emits
   `waveinput.ndjson` and `waves.ndjson`.
6. `scripts/build-wave-manifest.js` applies every build gate and writes `manifest.json` plus
   `SHA256SUMS`, or exits 1.
7. The shell publishes, then reads every artifact back through the public domain, and
   `scripts/build-wave-kv.js --mode emit` re-verifies the download against the manifest,
   applies the consumer gate, and emits the bulk-put chunks.

## Per-grid isolation

A grid that is missing, or that arrives decodable but carrying something the plan did not
expect, costs its own beaches their waves and nothing else. Refusing the whole cycle for one
grid takes the ocean down for a Great Lakes file, which is more data lost, not less.

`gridStatus` carries that verdict, one entry for **every** grid in `GRIDS`, threaded
`band-plan.json` → `sample-report.json` → `manifest.json`:

| status | meaning |
| --- | --- |
| `unfetched` | no `grids-report.json` entry — the fetch never produced this grid |
| `unplanned` | fetched, not usable for waves; contributes no planes and no records |
| `planned` | every hour's `HTSGW` band located; `elements` says whether `WIND` survived |
| `sampled` | sample report only: the grid produced a stats entry |

Completeness is the contract. An absent entry lets the build gate's per-grid floor silently
skip a grid that under-covered; an entry claiming a status a grid never reached scores an absent
grid as a shrink to zero and refuses the whole cycle.

`REQUIRED_GRID_IDS` in `src/waveGrids.js` names the grids a cycle cannot do without. A required
grid that does not reach `planned` refuses the cycle at every step that can see it, as does an
empty plan; everything else warns and continues with fewer grids. The build gate draws the same
line for the per-grid count gates, below. The element requirement splits
in one direction only: a grid missing `HTSGW` at any of the 24 hours is `unplanned` and
contributes nothing, while a grid missing only `WIND` stays planned for waves and loses only the
wind-only fallback. The inverse would publish records from a grid whose wave plane was never
proven.

The workflow shell holds the same contract: its gdalinfo sweep and band extraction run per
grid, and a failure marks that grid `usable: false` or `unplanned`, deletes the partial `.img`
and `.vrt`, removes that grid's entries from the plan, and continues. Deleting the partials is
load-bearing, because a truncated raster whose plane key still matches the plan is read by the
sampler as a plane. Both steps read `requiredGridIds` from the JSON rather than naming a grid.

The D1 snapshot is read through `scripts/snapshot-d1.js` (see `docs/offline-discovery.md`),
which pages by `id` and applies the truncation count guard. Its `WHERE` clause comes from
`FLAG_WORTHY_WATER_SQL` in `src/waterClass.js`, printed by `scripts/print-flag-worthy-sql.js`.
The guard compares the same predicate against itself, so an empty value would snapshot the whole
table and pass; the step passes `--require-where`, which fails on an empty value instead.

## Publication

Copied from the layer build. R2 bucket `swim-report` — with a hyphen, because the zone is
`swim.report` with a dot and R2 answers `AccessDenied` rather than `NoSuchBucket` for a bucket a
token cannot see, so the dotted form fails looking exactly like a bad secret — path-style
addressing, served at `https://map.swim.report`.

    waves/<cycleId>/manifest.json      immutable
    waves/<cycleId>/waveinput.ndjson   immutable
    waves/<cycleId>/waves.ndjson       immutable
    waves/<cycleId>/SHA256SUMS         immutable, covers the two .ndjson only
    waves/current.json                 no-store, WRITTEN LAST

`cycleId` is `<validStart compact>-g<gfs cycle compact>-<git sha 7>`. The pointer is written
last so a reader can never see a torn set. `manifest.buildStatus:"complete"` is the last key
written and is assigned nowhere else. The manifest stays outside its own `SHA256SUMS` scope
because it is the gate's sole input and is byte-compared on its own.

A withheld publish is a warning on a dispatch and a **failure** on a scheduled run. The
scheduled cycle wrote no KV for any grid and the pointer did not move, so the failing step
costs nothing and is the only alert that state produces; without it the run goes green with
one annotation while every `waveinput:` key expires on its own lease. The reports artifact
uploads first either way, and its `manifest.json` is what seeds the floors.

## Gates

**Non-overridable** — everything that could produce a wrong number. A flag an
operator reaches for during an incident must not be able to wave a wrong wave height
into `src/rules.js`.

- `gridIdentity` — decoded size, geotransform, cell size and nodata equal the committed
  expectation in `data/wave-grids.json`, **and every plane the sampler read agrees with its own
  grid's hour-0 wave plane**. A grid the cycle sampled with no block of its own in that file is
  refused outright, before any artifact uploads, so a new grid's identity block ships in the
  commit that adds the grid. Seed those numbers from an extracted plane's geotransform, never
  from the corner coordinates `gdalinfo` prints: those are rounded to seven decimals and the
  gate compares origins within 1e-9. The committed expectation describes hour 0 alone;
  `noaa_gfswave` downloads one file per forecast hour and each plane's geotransform comes from
  that file, so a later hour can carry a shifted origin with identical dimensions and decode,
  sample and pass every count gate while reading the wrong cells. `sample-waves.js` compares
  the planes it loaded and publishes `identityPlanes` and `identityMismatches` per grid; a
  report carrying no plane count refuses rather than passing vacuously, so the sampler and the
  build gate ship together.

  The residual: for the two **warped** grids, `gdalwarp` forces a fixed `-te`/`-tr` target, so
  this gate proves the target raster and never the source. A displaced arctic source would be
  resampled into a correct-looking plane and pass.
- `minimumRecords` — a beach total, at least one wave height in the cycle, every required grid
  `sampled` and resolving, and for **every** grid reporting `sampled`, a `validPercent` strictly
  above zero. Without that last clause an all-nodata grid reports `0.00` and is caught only by
  the overridable ratio rails.
- `bandIdentity` — `GRIB_ELEMENT` at every band index used.
- `validTimes` — `GRIB_VALID_TIME === validStartEpoch + i*3600` per band, which is
  what catches an `.idx` off-by-one.
- `sentinelScan` — no emitted value equals any grid's own header nodata, exceeds
  100 ft, or falls below zero.
- `alignment` — every series exactly 24 entries, every value finite or null.
- `distinctValues` and `meanPlausibility` — at least 20 distinct wave values across
  the set, mean within 0.05 to 25 ft. Every other gate counts things, and a constant
  plane counts perfectly; these two are the only ones that can tell a real ocean from
  a filled buffer.
- `ttlSpelling` — every emitted pair carries a numeric `expiration` and a string
  `value`.

**Overridable with `--allow-shrink`, and warned** — everything that is merely less
data.

- Coverage floors from `data/wave-floors.json`, keyed by `gridsDigest`, plus one floor per
  `GRIDS` id. The per-grid refusal walk iterates the floors entry rather than `GRIDS`, so a
  grid omitted there is unfloored with no refusal and no warning.
- Shrink ratio at least 0.95 against the previous cycle.
- Decay ratio at least 0.85 against the oldest of an 8-cycle rolling history. A wet-cell hit
  rate bleeding 5% per cycle passes every ratio-to-previous check forever, so the window
  comparison is the only thing that can see it.
- Both ratios score `validPercent` alongside the two record counts, per grid. The dangerous
  shape is partial corruption: a wet fraction falling from 70 to 3 while beaches still resolve
  through longer spiral rings and every count floor holds.
- Only a `REQUIRED_GRID_IDS` grid refuses the cycle on its per-grid floor or record-count
  ratios. Any other grid's miss warns, lands in `sanity.optionalGridCounts` and degrades the
  cycle, since it costs only that grid's beaches; a missed floor publishes as `"warned"`. A
  grid may declare `recordCountMinRatio` for its record counts, outside `gridsDigest`.
  `validPercent` always takes the default ratio and refuses for every grid, because it
  signals a wrong plane rather than less data.

A **seeded absolute floor** for `validPercent` (`floors[<digest>].validPercent[<gridId>]`,
seeded at 0.75x an observed real cycle) is the right eventual shape and is deferred while
`data/wave-floors.json` still carries null floors. One tuned constant cannot stand in for it:
the grids' legitimate wet fractions differ by close to an order of magnitude.

**Auto-publish also requires that a ratio was actually scored.** `shrinkRatiosPassed` reads
true on zero comparisons, which a previous manifest carrying no per-grid counts can produce. A
refusal there would be a false alarm on behalf of a grid that never ran, so `autoPublishAllowed`
goes false, the manifest publishes `sanity.shrinkRatiosCompared`, and a human reads it.

`gridsDigest` is sha256 over the canonical serialization of `GRIDS` in `src/waveGrids.js`: id,
domain, cell size, url template, variables, cap km, accepted water classes and the
wind-fallback flag. Each of those decides which beaches resolve to which grid, how far a sample
may reach, or how many records come back, so counts seeded under the old set say nothing about
the new one — retargeting a grid's `waterClasses`, or flipping its `windFallback`, moves the
record population exactly as adding a grid does. Cadence and probe fields stay out: they decide
whether a cycle lands, not which beaches it covers. The **beach set is deliberately excluded**,
because it grows daily and a digest that changes daily is not a gate. An unseeded digest sets
`autoPublishAllowed:false` without failing the build, and `sanity.overridden` is published
separately so an `--allow-shrink` run is distinguishable downstream.

## The consumer gate

`src/waveManifest.js` is pure, fail-closed, and never imported by the Worker. Three tiers on
one conjunct walk, every conjunct a strict `!== true` so a **missing** field refuses exactly as
a false one does.

- **fatal**, write no KV: schema version mismatch, pointer disagrees with manifest, artifacts
  unverified, `artifactsPresent`/`artifactsExpected` (both `isFiniteNumber`-guarded **first**,
  because `undefined !== undefined` is false and fails open), `buildStatus` not `"complete"`,
  `validTimesPassed` or `sentinelScanPassed` not true.
- **expired**, write no KV: fewer than 10800 seconds (`MIN_LEASE_SECONDS`) of series lease
  left, or `gridsDigestMatches` not true. A cycle with under three hours left costs a full
  bulk write, buys little, and means the pipeline is more than 21 hours late, which the
  operator must see. `NaN` from an unparseable
  `validStartIso` fails the range check, which is correct: refusing because the age is
  unknowable is the same answer as refusing because it is too old.
- **degraded**, write and warn: `gridsComplete` not true, `sanity.overridden` true, or
  `optionalGridCountsWarned` true. The
  manifest sets `gridsComplete` only when every grid was fetched **and** reached `sampled`, so
  a grid lost at plan or extraction time degrades the cycle the same way a failed fetch does.

The split of duties is copied from `scripts/fetch-layers.js`: the fetcher proves facts about
the fetch only and leaves `gridsDigestMatches` and `secondsRemaining` **absent** rather than
stubbed, because the gate is fail-closed on missing fields. The consumer folds them in.

## Absolute expiration

Every emitted pair carries an `expiration` in seconds since the epoch, never a duration, so a
key expires a fixed span after the hour it *describes* regardless of when the job ran. A TTL
measured from write time is wrong for a scheduler that skips occurrences: a run firing 9 hours
late would grant a fresh lease to data already 9 hours old.

There are two spans, and a record's own shape picks one. A `waveinput:` carrying the hourly
series gets `validStartEpoch + 86400`, the span it describes, because `runFlagRecompute`
indexes it at the hour it is estimating rather than reading hour 0; its paired `waves:` key
shares that lease, since the detail-page strip trims itself to the hours from now forward. A
wind-only `waveinput:` is one hour-0 sample with no series behind it and gets
`validStartEpoch + 25200`. `startIso` and `hoursFt` are present together or not at all, which
is the field `build-wave-kv.js` reads to choose. The series lease outlives the scalar one, so a
cycle the gate still accepts can carry wind-only records with nothing left; those are dropped
rather than handed to wrangler with a past expiration.

`runFlagRecompute` never reads `waveinput.updated`, so the expiration and the hour index are
the whole staleness control on the color path.

The spelling is a trap worth stating plainly. The wrangler bulk-put pair field is snake_case
`expiration` / `expiration_ttl`. The Worker runtime's camelCase `expirationTtl` — the spelling
used everywhere else in this repo, and therefore the likeliest mistake in the pipeline — is
accepted as an unexpected property, warned about, and **ignored**, with exit 0. The result is a
key that never expires, coloring flags from dead data indefinitely. `value` must also be a JSON
string. The workflow greps wrangler's output for `unexpected properties` and fails the step.

## Cadence

The workflow runs `52 */6 * * *` — 4 slots a day, matching the four GFS cycles, on a minute
clear of every other cron in this repo and off the congested top of the hour. The cron picks
nothing; the runtime resolver picks the cycle.

Every landed cycle carries 24 hours of forecast and the hourly cron indexes into it, so a slot
buys margin against a missed occurrence rather than freshness. GitHub Actions **skips** cron
occurrences rather than deferring them, so what the cadence has to survive is consecutive
misses: 4 slots a day against a 24 hour series lease tolerates two, with six hours to spare.
Each slot also costs a full bulk write of roughly two KV pairs per resolved beach, which is
the largest single line in this account's KV write budget, so slots are not free to add.

Read the slot hit rate from the workflow's run history and the per-beach coverage from
`manifest.beaches.resolved` across consecutive cycles: the exposure has to be measured, and no
second wave source is left to shadow against.

## Rollback

There is no way to roll KV back to a previous cycle: an older cycle's absolute expiration is
already short or negative, so republishing it is refused. The ladder is about stopping, not
reverting.

1. **Wrong but not yet written.** Nothing to do — a refused build leaves `waves/current.json` on
   the last good cycle and writes no KV.
2. **Written and wrong.** Disable the workflow. The bad keys expire within 24 hours of the hour
   they describe, and beaches age out to `unknown` meanwhile.
3. **The grid set itself is wrong.** Revert `src/waveGrids.js` and `data/wave-grids.json`
   together, whole. A whole revert restores the previous digest, whose seeded entry is still in
   the append-only floors file, so the next cycle auto-publishes with no further action. A
   partial revert moves the digest to a third value that nothing has seeded and withholds
   auto-publish until someone reviews a real cycle against D1 truth.
4. **The pipeline must go away.** Stop the workflow and let the keys expire. The Worker degrades
   to the wind fallback where one is present and to `unknown` elsewhere.

## Prerequisites

- Repo secrets `CLOUDFLARE_R2_ACCESS_KEY` / `CLOUDFLARE_R2_SECRET_ACCESS_KEY`, the same pair
  the layer build uses.
- Repo secret `CLOUDFLARE_KV_WRITE_TOKEN`, carrying **Workers KV Storage: Edit**, read by the
  `publish-kv` job alone. It is separate from the D1-scoped tokens the other jobs use; if it is
  missing or unscoped, the first bulk put fails after every other step has succeeded.
- GDAL with the JPEG 2000 driver on the runner. `gdal-bin` is installed with
  `--no-install-recommends`, the first suspect for a missing format driver; the smoke decode is
  what proves it.

## Running it locally

`npm run seed:wavegrids` downloads one cycle into `./.wavegrids`; it is the only
network-touching step. `npm run seed:waveplanes` runs GDAL: a `gdalinfo -json` sidecar per file,
the band plan, then one `gdal_translate` per planned band into a flat ENVI plane, or a
`gdal_translate -of VRT -b` followed by `gdalwarp` for the two projected grids. The VRT hop is
deliberate: `gdalwarp -srcband` would do the same job in one call but is GDAL 3.7+, and a plain
VRT copies no pixels. `npm run seed:waves` snapshots local D1, samples every beach, applies the
build gate and writes the KV pairs with `wrangler kv bulk put --local --binding FLAGS`; run it
before `npm run seed:flags`.

Every Deno invocation must set `DENO_NO_PACKAGE_JSON=1`, or a plain `deno run` silently
rewrites the checked-in `deno.lock`.

## Seeding a new `gridsDigest`

Every count gate is a ratio against a previous cycle, and a ratio cannot answer "is this enough
coverage at all": a cycle resolving 40 beaches out of 16,000 passes every ratio check the moment
the cycle before it also resolved 40. The floors in `data/wave-floors.json` are the absolute
answer, seeded from a real cycle and moved only by a reviewed commit.

1. Run the workflow by `workflow_dispatch` with publish true. Auto-publish is withheld for an
   unseeded digest, so the prefix uploads and is readable but the pointer does not move.
2. Read the produced `manifest.json`, cross-checking `beaches.resolved` against the D1 row count
   and the per-grid split against where the beaches actually are.
3. Commit an entry under the new digest with status `"seeded"`, `seededFromCycleId` set to that
   manifest's `cycleId`, and each floor at 0.75x the observed count, rounded down.

A null floor means no floor has been seeded and that check does not apply. A null is
deliberate and reviewable; an invented number is not. A `"bootstrap"` entry withholds
auto-publish exactly as an absent one does, so it is a legitimate way to record that a grid
set is known and its floors are pending — but it is never a way past a refusal, and its nulls
must be replaced by measured counts, never by a guess.

`test/waveGateData.test.js` holds the committed data to the **structural** half of that
contract: an entry exists for the digest the committed `GRIDS` produce, every `GRIDS` id is
keyed in it, nothing else is, the entry is wholly seeded or wholly pending, and every grid has
an identity block. It passes on a pending entry by design, so a green suite is not evidence
that a grid set has been seeded. The alarm for an unseeded digest reaching production is the
scheduled withheld-publish step in `waves.yml`, which fails the run; what keeps it from
landing is the sequence below.

## Adding a grid

A grid-set change is a staged rollout, not a merge. Landing the code alone leaves every
scheduled cycle withholding auto-publish, which writes **no KV for any grid** and ages the
whole site out to `unknown` within a day, on a green run with one annotation. The order below
is what prevents that, and the two commits merge together as one push.

1. Locally, add the grid with placeholder `sampled` numbers (the fetch reads none of them),
   run `npm run seed:wavegrids -- --grids <id>` and `npm run seed:waveplanes`, and copy the
   hour-0 `HTSGW` plane's `geoTransform`, `size` and `noDataValue` verbatim into both
   `src/waveGrids.js` and `data/wave-grids.json`. Compute the domain edges as
   `origin + n * pixel` from those same numbers. This local pass is also what settles whether
   the cycle probe answers, whether the `WIND` plane's nodata matches the wave plane's, and
   whether the grid's masked cells read as a sentinel or as zero.
2. Commit the code, the identity block and every test change, with the floors entry pending —
   a `"bootstrap"` entry keyed by the new digest, all floors null. The suite is green, and
   deliberately so: it proves the entry is structurally complete, not that it is seeded. The
   merge block is this sequence, not the suite.
3. Dispatch `waves.yml` from the branch with `publish=false`. The pointer cannot move and
   `publish-kv` cannot run, so production is untouched by construction.
4. Read `manifest.json` and `sample-report.json` from the run's artifact, not the run summary:
   no refusal survived, the new grid's `validPercent` is above zero, its `resolvedBeaches` and
   `maxSearchKm` are what the cap predicts, every existing grid's `resolvedBeaches` is
   unchanged (an append must reassign nobody), `beaches.windOnly` has not grown, and a spot
   series carries plausible heights rather than a flat zero or a sentinel. `manifest.gridsDigest`
   is the new key.
5. Replace the pending entry under that digest: status `"seeded"`, `seededFromCycleId` set to
   the manifest's `cycleId`, every floor at 0.75x the observed count rounded down, and a
   `_comment` recording the cross-check. A guard failure here means the entry is half-seeded
   or the key does not match what `GRIDS` produces.
6. Dispatch once more with `publish=false` and confirm `sanity.autoPublishAllowed` is now true.
   A new grid has no previous per-grid counts, so its ratio warns and skips while the others
   keep `ratioCoverage` true. Never dispatch with `force_publish` during a rollout: it moves
   the live pointer from an unreviewed branch build.
7. Merge both commits as one push, then watch the first scheduled slot: `AUTO_PUBLISH` true,
   the pointer moved, a bulk write, and no `unexpected properties` in the wrangler output. A
   degraded-tier warning naming an on-demand grid as unfetched is the healthy outcome of that
   cadence.
