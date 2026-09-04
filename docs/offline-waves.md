# Offline wave sampling from NOAA GRIB2 model output (GitHub Actions)

Wave height and the wind fallback are *pipeline* concerns: they change every few
hours, tolerate latency, and produce one number per beach per hour. They are
sampled outside the Cloudflare Worker, in a GitHub Actions job that decodes NOAA
GRIB2 model output with GDAL, resolves each beach to a wet grid cell, and
bulk-writes the result into the same `waveinput:` and `waves:` KV keys the hourly
flag cron already read. The Worker's read contract does not move.

**Blast radius.** This job never writes a flag color. A failed or refused cycle
writes no KV at all and leaves the previous cycle's keys in place under an
expiration derived from that cycle's own model valid time, so the failure mode is
a flag aging out to `unknown` — gray and honest — never a stale wave height
deciding a color. Republishing an older cycle yields a short or negative lease and
is refused by construction: there is no KV time machine, and the only rollback is
to stop writing.

## Why

A coordinate-query wave API prices by the coordinate. At roughly 1,100 beaches the
free tier was near its daily ceiling, and the coverage this project is heading for
— every US ocean beach, five to fifteen thousand more rows — is unreachable at any
cadence. Independently, at that size the Worker cannot write the KV fan-out at all:
about 0.45 s per put across the six effective concurrent connections a Worker gets
is roughly 1,200 s of writes against a 900 s invocation ceiling.

Model output is priced by the file instead. One gfswave global file covers every
ocean beach on the continent for one forecast hour, and adding a beach costs an
array index. The KV fan-out moves to a runner with no invocation ceiling.

The change also buys a capability the API could not offer. Beach coordinates
frequently land on masked land cells: of five real beach points checked against the
hour-0 wave band, four returned the nodata sentinel at the exact cell. With the
whole grid in hand, the nearest wet cell can be searched for. Through an API, a
masked cell is simply a null.

## The two-path rule still holds

The Worker request path still reads only D1 and KV. The grids are read by the
offline job only; `wrangler.toml` deliberately carries no `r2_buckets` binding. The
hourly cron still reads `waveinput:` from KV and fetches nothing. What changed is
who writes those keys, not who reads them.

## The grid set

Three grids, in fallthrough order, constrained by each beach's `water_class`:
`great_lake` may match only `noaa_glwu`, `ocean` only the two gfswave grids, and a
NULL class may try both in order. A beach out of extent, or with no wet cell inside
its cap, falls through to the next permitted grid and then to null.

| id | source | grid | nodata | cap |
| --- | --- | --- | --- | --- |
| `noaa_glwu` | NOMADS | `glwu.grlc_2p5km_sr`, 2.5 km Lambert, 49 steps in one file | 9.999000260554009e+20 | 10 km |
| `noaa_gfswave` | AWS `noaa-gfs-bdp-pds` | `gfswave.global.0p16`, 2160x406 at 0.166666 deg | 9999 | 25 km |
| `noaa_gfswave_arctic` | AWS `noaa-gfs-bdp-pds` | `gfswave.arctic.9km`, polar stereographic | 9999 | 25 km |

`global.0p16` spans -180.083 to 179.917 and 52.583N to -15.083S, which is why the
regional grids are not fetched. It supersedes `wcoast.0p16`, `atlocn.0p16` and
`epacif.0p16` in one file, closes the coverage gap between wcoast's -109.917 edge
and atlocn's -100.083 edge that left Mexican Pacific beaches uncovered, and uses the
normal -180..180 convention, so `epacif`'s 0-360 longitude trap does not exist on
it. `arctic.9km` covers what `global.0p16` cannot, above 52.58N. GLWU is the only
source for the Great Lakes, which gfswave masks entirely.

NOMADS documents a ten second wait between scripted fetches. The design honours it
by construction: GLWU is one whole-file request carrying all 49 steps, every NOMADS
request is spaced, and the per-run count is capped. The AWS mirror publishes no such
rule and is Range-sliced freely.

## The nearest-wet-cell spiral

This is the sampling mechanism, not a fallback. `nearestWetSample` in
`src/waveGrids.js` searches outward from the beach's cell and returns the wet cell
at the **great-circle minimum** — not the first hit in scan order, and not the
lowest ring index. Both cheaper tie-breaks are wrong and wrong quietly: longitude
cells narrow with latitude, so ring-index-nearest picks the wrong cell at high
latitude, and first-hit-in-scan-order returns a different neighbour than the true
nearest. Each produces a plausible wave height with no error anywhere.

The resolved cell is computed **once** per beach, from the hour-0 wave band, and
reused for all 24 hours. The land mask is fixed for a cycle, and re-running the
search per hour would let `hoursFt` jump between cells — breaking the
`hoursFt[0] === waveinput.waveHeightFt` invariant in a way no test catches
obviously, and making the detail page's "now" stat contradict its own first bar.

A beach on a narrow peninsula can still find a wet cell on the far side within its
cap. `water_class` removes the worst cases; the residual is real, bounded only by
the cap, and accepted.

## Units

GRIB `HTSGW` is **metres**. Feet are `metres * 3.28084` (`metersToFeet`,
`src/geo.js`). GRIB `WIND` is **metres per second**. mph is
`m/s * 2.2369362920544` (`metersPerSecondToMph`, `src/waveGrids.js`) — a constant
with no prior existence in this repo, because the previous source was asked for mph
directly. `src/rules.js` thresholds are 2 ft yellow and 4 ft red, and 15/25 mph.
Handing it metres makes every sea state below 1.22 m read green sitewide; handing it
m/s makes an actual 25 mph arrive as 11. Neither raises an error anywhere, which is
why `test/buildWaveKv.test.js` pins both conversions directly.

`windGustMph` is always null: gfswave publishes no GUST element. `src/rules.js`
already renders `n/a` for a null gust, so the wind red rule narrows in effect to
sustained speed alone. That branch only fires when `waveHeightFt` is null, which
under this source should be rare — and "should be" is what the coverage numbers below
measure.

GRIB nodata is a **number that survives JSON**. 9999 m becomes 32,808 ft and colors
a flag red with a straight-faced reason string; a negative sentinel colors it green.
`src/rules.js` tests `waveHeightFt !== null` with no `isFinite` guard and the cron
guards with `typeof === "number"` only, so containment belongs to the offline writer
and nowhere else. Each sentinel is read **per band** from the raster header, never
hardcoded: a check for 9999 alone would pass every Great Lakes sentinel straight
through.

## Decoding requires GDAL

GRIB2 data representation template 5.40 is JPEG 2000. There is no pure-JavaScript
decode path, so GRIB2 decoding inside the Worker is impossible and must never be
attempted there. GDAL runs in the **workflow shell**, which keeps subprocess
permission out of the Deno pipeline entirely: no script carries `--allow-run`, and
only `scripts/fetch-wave-grids.js` carries `--allow-net`. The permission guard in
`.github/workflows/test.yml` enforces the network half machine-side, scanning every
workflow and `package.json` for an `--allow-net` on any of the four offline scripts.
The subprocess half rests on review; extending the guard to `--allow-run` is tracked
in `TODO.md`.

Two GDAL traps the workflow accounts for. GDAL has a documented mode where it
returns an empty result with a zero exit status, so a format-list grep does not
prove the JPEG 2000 driver is present — only a smoke decode asserting a real
valid-percent does. And `gdallocationinfo` with coordinates as arguments prints
nothing for an out-of-extent point and exits 1, silently losing points; reading raw
planes in Deno avoids the issue entirely, and any shell-side sampling reintroduces
it.

## The pipeline

1. `scripts/fetch-wave-grids.js` resolves the cycle **at runtime** and downloads it.
   `validStart` is the top of the current UTC hour — the hour the published series
   describes. GFS cycles are walked newest-first back 24 hours and the first whose
   `f(k)..f(k+23)` all exist is taken. Measured publish latency is about T+3h33m and
   steps run to f357, so a 21:52 run resolving to the 12z cycle and sampling
   f010..f033 is an ordinary, healthy outcome: the job's cadence and the model's are
   deliberately decoupled. GLWU resolves independently on its own hourly cycle.
2. The shell captures a `gdalinfo -json` sidecar per file.
3. `scripts/sample-waves.js --mode plan` names the band index carrying each hour's
   `HTSGW` and `WIND`, **discovered** from those sidecars and never assumed, and
   records a per-grid verdict in `gridStatus`. GLWU is one file of 931 bands; assuming
   a layout is how an `.idx` off-by-one becomes a complete, plausible, silently
   time-shifted series.
4. The shell extracts each planned band to a flat ENVI plane — `gdal_translate` for
   the lat/lon grid, `gdalwarp` for the two projected ones. `-r near` is mandatory on
   the warp: any interpolating resampler smears wave values across the land mask and
   manufactures readings on shore.
5. `scripts/sample-waves.js --mode sample` samples every beach in the D1 snapshot
   and emits `waveinput.ndjson` and `waves.ndjson`.
6. `scripts/build-wave-manifest.js` applies every build gate and writes
   `manifest.json` plus `SHA256SUMS`, or exits 1.
7. The shell publishes, then reads every artifact back through the public domain.
8. `scripts/build-wave-kv.js --mode emit` re-verifies the download against the
   manifest, applies the consumer gate, and emits the bulk-put chunks.

## Per-grid isolation

A grid that is missing, or that arrives decodable but carrying something the plan did
not expect, costs its own beaches their waves and nothing else. Refusing the whole
cycle for one grid takes the ocean down for a Great Lakes file, which is more data
lost, not less: this lane's failure mode is beaches aging out to `unknown`.

`gridStatus` carries that verdict, one entry for **every** grid in `GRIDS`, threaded
`band-plan.json` to `sample-report.json` to `manifest.json`:

| status | meaning |
| --- | --- |
| `unfetched` | no `grids-report.json` entry — the fetch never produced this grid |
| `unplanned` | fetched, not usable for waves; contributes no planes and no records |
| `planned` | every hour's `HTSGW` band located; `elements` says whether `WIND` survived |
| `sampled` | sample report only: the grid produced a stats entry |

Completeness is the contract. An absent entry lets the build gate's per-grid floor
silently skip a grid that under-covered; an entry claiming a status a grid never
reached scores an absent grid as a shrink to zero and refuses the whole cycle. The
sample report carries per-grid record counts for the same reason, so a floor is
measured against what a grid actually produced.

`REQUIRED_GRID_IDS` in `src/waveGrids.js` names the grids a cycle cannot do without —
`noaa_gfswave` today. A required grid that does not reach `planned` refuses the cycle
at every step that can see it: the fetch, the plan, the workflow's gdalinfo sweep, its
band extraction and the manifest rail. An empty plan refuses for the same reason.
Everything else warns and continues with fewer grids.

The element requirement splits in one direction only. A grid missing `HTSGW` at any of
the 24 hours is `unplanned` and contributes nothing; a grid missing only `WIND` stays
planned for waves and loses only the wind-only fallback, which fires for a beach with
no wet wave cell and is expected to be nearly empty. The inverse is not available:
keeping a grid's wind while dropping its waves would publish records from a grid whose
wave plane was never proven.

The workflow shell holds the same contract. Its gdalinfo sweep and its band extraction
run per grid; a failure marks that grid `usable: false` in `grids-report.json` or
`unplanned` in `band-plan.json`, deletes the partial `.img` and `.vrt`, removes that
grid's entries from the plan, and continues with the rest. Deleting the partials is
load-bearing: a truncated raster whose plane key still matches the plan is read by the
sampler as a plane. Both steps read `requiredGridIds` from the JSON rather than naming
a grid, so the shell and the scripts cannot disagree about which grid is required.

The `WHERE` clause of the D1 snapshot comes from `FLAG_WORTHY_WATER_SQL` in
`src/waterClass.js`, printed by `scripts/print-flag-worthy-sql.js` and interpolated
into both the paginated `SELECT` and the truncation count guard. The guard compares the
same predicate against itself, so an empty value would snapshot the whole table and
pass; the step fails on an empty value instead.

## Publication

Copied from the layer build. R2 bucket `swim-report` (hyphen — the zone is
`swim.report` with a dot, and R2 answers `AccessDenied` rather than `NoSuchBucket`
for a bucket a token cannot see, so the dotted form fails looking exactly like a bad
secret), path-style addressing, served publicly at `https://map.swim.report`.

    waves/<cycleId>/manifest.json      immutable
    waves/<cycleId>/waveinput.ndjson   immutable
    waves/<cycleId>/waves.ndjson       immutable
    waves/<cycleId>/SHA256SUMS         immutable, covers the two .ndjson only
    waves/current.json                 no-store, WRITTEN LAST

`cycleId` is `<validStart compact>-g<gfs cycle compact>-<git sha 7>`. The pointer is
written last so a reader can never see a torn set. `manifest.buildStatus:"complete"`
is the last key written and is assigned nowhere else. The manifest stays outside its
own `SHA256SUMS` scope because it is the gate's sole input and is byte-compared on
its own. Publish is double-gated exactly as the layer build is, and a withheld
publish is a warning, not a failure.

## Gates

**Non-overridable** — everything that could produce a wrong number. A flag an
operator reaches for during an incident must not be able to wave a wrong wave height
into `src/rules.js`.

- `gridIdentity` — decoded size, geotransform, cell size and nodata equal the
  committed expectation in `data/wave-grids.json`, **and every plane the sampler read
  agrees with its own grid's hour-0 wave plane**. The committed expectation describes
  hour 0 alone; `noaa_gfswave` downloads one file per forecast hour and each plane's
  geotransform comes from that file, so a later hour can carry a shifted origin with
  identical dimensions and decode, sample and pass every count gate while reading the
  wrong cells. `sample-waves.js` compares the planes it loaded and publishes
  `identityPlanes` and `identityMismatches` per grid; a report carrying no plane count
  refuses rather than passing vacuously, so the sampler and the build gate ship
  together.

  The residual: for the two **warped** grids, `noaa_glwu` and `noaa_gfswave_arctic`,
  `gdalwarp` forces a fixed `-te`/`-tr` target, so the output raster is identical
  whatever the source did. This gate proves the target raster, never the source. A
  displaced arctic source would be resampled into a correct-looking plane and pass.
  `planFor` already reads each source file's `gdalinfo`, so asserting the source
  geotransform per plan entry is the natural next step; it is deliberately not taken
  here.
- `minimumRecords` — a beach total, at least one wave height in the cycle, every
  required grid `sampled` and resolving, and for **every** grid reporting `sampled`, a
  `validPercent` strictly above zero. `validPercent` was computed, published and gated
  by nothing: an all-nodata grid reported `0.00` and was caught only by the overridable
  ratio rails. The rail is scoped to a grid that already claims to have sampled, which
  cannot have had zero usable cells, so it needs no tuned threshold.
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

- Coverage floors from `data/wave-floors.json`, keyed by `gridsDigest`, plus per-grid
  floors.
- Shrink ratio at least 0.95 against the previous cycle.
- Decay ratio at least 0.85 against the oldest of an 8-cycle rolling history. A wet-cell
  hit rate bleeding 5% per cycle passes every ratio-to-previous check forever, so the
  window comparison is the only thing that can see it.
- Both ratios score `validPercent` alongside the two record counts, per grid. The
  dangerous shape is partial corruption: a wet fraction falling from 70 to 3 while
  beaches still resolve through longer spiral rings and every count floor holds. It
  rides the existing rails rather than a new gate shape, so it is skipped with a
  warning against a manifest written before the field existed.

A **seeded absolute floor** for `validPercent` — `floors[<digest>].validPercent[<gridId>]`,
seeded by a human at 0.75x an observed real cycle and reported through the same
`perGridFloorStatus` "not evaluated" path — is the right eventual shape and is
deliberately deferred: there is no observed number to seed from while
`data/wave-floors.json` is still status `bootstrap` with every floor null. One tuned
constant cannot stand in for it, because the three grids' legitimate wet fractions
differ by close to an order of magnitude: the Great Lakes box is mostly land,
`global.0p16`'s band is mostly ocean, and the warped Alaska box is mostly land and
off-domain.

**Auto-publish also requires that a ratio was actually scored.** `shrinkRatiosPassed`
reads true on zero comparisons, and a previous manifest carrying no per-grid counts
together with a grid missing this cycle scores none at all: the global fallback is
retired by the missing grid and every per-grid comparison skips for want of a previous
entry. A refusal there would be a false alarm on behalf of a grid that never ran — a
missing grid can only reduce the global count — so `autoPublishAllowed` goes false, the
manifest publishes `sanity.shrinkRatiosCompared`, and a human reads it. The state is
reachable only if a future shape change drops the per-grid counts again, which is the
case the fallback exists for.

`gridsDigest` is sha256 over the canonical serialization of `GRIDS` in
`src/waveGrids.js`: id, domain, cell size, url template, variables, cap km. The
**beach set is deliberately excluded** — it grows daily, and a digest that changes
daily is not a gate. An unseeded digest sets `autoPublishAllowed:false` without
failing the build; `sanity.overridden` is published separately so an `--allow-shrink`
run is distinguishable downstream.

## The consumer gate

`src/waveManifest.js` is pure, fail-closed, and never imported by the Worker. Three
tiers on one conjunct walk, every conjunct a strict `!== true` so a **missing** field
refuses exactly as a false one does.

- **fatal**, write no KV: schema version mismatch, pointer disagrees with manifest,
  artifacts unverified, `artifactsPresent`/`artifactsExpected` (both `isFiniteNumber`-
  guarded **first** — `undefined !== undefined` is false and fails open, the trap
  ported verbatim from `src/layerManifest.js`), `buildStatus` not `"complete"`,
  `validTimesPassed` or `sentinelScanPassed` not true.
- **expired**, write no KV: fewer than 3600 seconds of lease left, or
  `gridsDigestMatches` not true. A cycle with 40 minutes left costs a full bulk write,
  buys nothing, and means the pipeline is more than six hours late, which the operator
  must see. `NaN` from an unparseable `validStartIso` fails the range check, and that
  is correct: refusing because the age is unknowable is the same answer as refusing
  because it is too old.
- **degraded**, write and warn: `gridsComplete` not true, or `sanity.overridden` true.
  The manifest sets `gridsComplete` only when every grid was fetched **and** every grid
  reached `sampled`, so a grid lost at plan or extraction time degrades the cycle the
  same way a failed fetch does — it contributed no records either way.

The split of duties is copied from `scripts/fetch-layers.js`: the fetcher proves facts
about the fetch only and leaves `gridsDigestMatches` and `secondsRemaining` **absent**
rather than stubbed, because the gate is fail-closed on missing fields. The consumer
folds them in.

## Absolute expiration

Every emitted pair carries `"expiration": validStartEpoch + 25200` — seconds since
the epoch, not a duration. A key therefore expires 7 hours after the hour it
*describes*, regardless of when the job ran.

This matters because `runFlagRecompute` never reads `waveinput.updated`, so expiration
is the only staleness control on the color path. A TTL measured from write time is
wrong for a scheduler that skips occurrences: a run firing 9 hours late would grant
7 more hours of life to data already 9 hours old.

The spelling is a trap worth stating plainly. The wrangler bulk-put pair field is
snake_case `expiration` / `expiration_ttl`. The Worker runtime's camelCase
`expirationTtl` — which is the spelling used everywhere else in this repo, and
therefore the likeliest mistake in the whole pipeline — is accepted as an unexpected
property, warned about, and **ignored**, with exit 0. The result is a key that never
expires, coloring flags from dead data indefinitely. `value` must also be a JSON
string; a nested object is rejected outright, which at least fails loudly. The
workflow greps wrangler's output for `unexpected properties` and fails the step.

## Cadence and the unclosed risk

The workflow runs `52 */3 * * *` — 8 slots a day, on a minute clear of every other
cron in this repo and off the congested top of the hour. The cron picks nothing; the
runtime resolver above picks the cycle.

GitHub Actions **skips** cron occurrences rather than merely deferring them. The
layer build's own header records a retired hourly workflow firing 4 to 6 of its 24
daily slots. At 8 slots a day against a 7 hour absolute expiration this pipeline
tolerates two consecutive misses, and that is its single largest exposure. It is not
closed by this design.

Two things follow. The exposure has to be measured rather than assumed, and no second
wave source is left to shadow against: read the slot hit rate from the workflow's own
run history and the per-beach coverage from `manifest.beaches.resolved` across
consecutive cycles. And the permanent fix is to carry `hoursFt` and `startIso` in
`waveinput:` and have `runFlagRecompute` index the current hour, turning one landed
cycle into 24 hours of coverage. That changes the hourly cron's read contract, so it
is tracked in `TODO.md` rather than done here.

## Rollback

There is no way to roll KV back to a previous cycle: an older cycle's absolute
expiration is already short or negative, so republishing it is refused. The ladder is
therefore about stopping, not reverting.

1. **A cycle is wrong but not yet written.** Nothing to do — a refused build leaves
   `waves/current.json` on the last good cycle and writes no KV.
2. **A cycle is written and wrong.** Disable the workflow. The bad keys expire on
   their own within 7 hours of the hour they describe, and beaches age out to
   `unknown` in the meantime.
3. **The grid set itself is wrong.** Revert `src/waveGrids.js` and
   `data/wave-grids.json` together. The digest changes, which un-seeds the floors and
   withholds auto-publish until someone reviews a real cycle against D1 truth.
4. **The pipeline must go away entirely.** Stop the workflow and let the keys expire.
   The Worker degrades to the wind fallback where one is present and to `unknown`
   elsewhere, which is the honest answer and not a wrong color.

## Prerequisites

- Repo secrets `CLOUDFLARE_R2_ACCESS_KEY` / `CLOUDFLARE_R2_SECRET_ACCESS_KEY`, the
  same pair the layer build uses.
- A Cloudflare API token carrying **Workers KV Storage: Edit**. The D1-scoped token
  `discovery.yml` uses does not carry it, and provisioning it is an operator action no
  code can verify. The first bulk put fails after every other step has succeeded if it
  is missing.
- GDAL with the JPEG 2000 driver on the runner. The layer build installs `gdal-bin`
  with `--no-install-recommends`, which is the first suspect for a missing format
  driver; the smoke decode is what proves it.

## Running it locally

`npm run seed:wavegrids` downloads one cycle into `./.wavegrids`. It is the only
network-touching step.

`npm run seed:waveplanes` runs GDAL: a `gdalinfo -json` sidecar per GRIB file, the
band plan, then one `gdal_translate` per planned band into a flat ENVI plane, or a
`gdal_translate -of VRT -b` followed by `gdalwarp` for the two projected grids. The
VRT hop is deliberate: `gdalwarp -srcband` would do the same job in one call but is
GDAL 3.7+, and a plain VRT copies no pixels. This needs GDAL on the machine.

`npm run seed:waves` snapshots the local D1, samples every beach, applies the build
gate, emits the KV pairs and writes them with
`wrangler kv bulk put --local --binding FLAGS`. Run it before `npm run seed:flags` so
the recompute has wave inputs to read.

Every Deno invocation must set `DENO_NO_PACKAGE_JSON=1`. Without it Deno folds
`package.json`'s npm dependency tree into the lockfile it expects, `deno check
--frozen` fails with "The lockfile is out of date", and a plain `deno run` silently
rewrites the checked-in `deno.lock`. The npm scripts already set it; the fix is the
env var, never regenerating the lock without it.

## Seeding a new `gridsDigest`

Every count gate is a ratio against a previous cycle, and a ratio cannot answer "is
this enough coverage at all". A cycle resolving 40 beaches out of 16,000 passes every
ratio check the moment the cycle before it also resolved 40. The floors in
`data/wave-floors.json` are the absolute answer, and they are seeded from a real
cycle and moved only by a reviewed commit.

1. Run the workflow by `workflow_dispatch` with publish true. Auto-publish is withheld
   for an unseeded digest, so the prefix uploads and is readable but the pointer does
   not move.
2. Read the produced `manifest.json`. Cross-check `beaches.resolved` against the D1 row
   count and the per-grid split against where the beaches actually are before trusting
   any of it.
3. Commit an entry under the new digest with status `"seeded"`, `seededFromCycleId` set
   to that manifest's `cycleId`, and each floor at 0.75x the observed count, rounded
   down.

A null floor means no floor has been seeded and that check does not apply. A null is
deliberate and reviewable; an invented number is not. Do not add a `"bootstrap"` entry
for a new digest to get past a refusal — that defeats the point of keying the file by
digest.
