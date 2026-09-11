# Rolling out `noaa_nwps_sew`, the fourth wave grid

Adding NOAA's Nearshore Wave Prediction System Seattle nest to `GRIDS` is a code change plus a
staged human rollout. The code change alone is not a rollout, and landing it without the
sequence below takes every wave record on the site to `unknown` within about a day. This
document is that sequence.

Nothing here has been executed. Every step is for a human with repository write access and the
Cloudflare read tokens.

## Read this first: merging alone takes the whole site to unknown

`gridsDigestInput` in `src/waveGrids.js` hashes the grid list, and this change moves the digest
three times over — a fourth grid, and the bundled fix that folds `waterClasses` and
`windFallback` into the digest entry. The working tree digest is:

```
sha256:2df3c65045c0a808a61e45bcf4b2a5c4c0e602ec4ca2ba36d00a11d1b7a8a633
```

The seeded entry in `data/wave-floors.json` is keyed by the previous digest,
`sha256:c4eafd4a4b0045968b45b70dfcace999395cb3f1af218a69167cb9cef2d7be9b`, and stops being
looked up the moment the new digest is in force.

The chain from there is mechanical:

1. `floorsEntryFor` in `scripts/build-wave-manifest.js` finds no seeded entry for the new
   digest and returns `autoPublishAllowed: false`.
2. `manifest.sanity.autoPublishAllowed` is false, so the workflow's `AUTO_PUBLISH` env is
   `false`.
3. `Publish the pointer` requires `PUBLISH && (AUTO_PUBLISH || FORCE_PUBLISH)`, and
   `FORCE_PUBLISH` is hardcoded `false` on a scheduled run. The pointer does not move.
4. `publish-d1` runs only `if needs.sample.outputs.published == 'true'`, which is never set. The
   job is skipped entirely.

The consequence is wider than the new grid. **Every** scheduled cycle writes no rows for **any**
grid, including the Great Lakes and both gfswave grids, which are otherwise healthy. Every
stored wave record carries an absolute `wave_expires` at `validStartEpoch + 86400`, so
the last cycle that landed before the merge covers roughly one more day. After that the hourly
cron finds no wave input for any beach, the wave lane in `src/rules.js` falls through, and the
site is gray coast to coast.

A scheduled run in that state fails, on `Fail a scheduled withheld publish`. That step is the
only alert the state produces: the publish job that did not run leaves no artifact to notice, and
without it the run would go green on one `::warning::` annotation from `Explain a withheld
publish`. It fires after the reports artifact has uploaded, so the `manifest.json` that seeds
the floors is still there.

`npm test` does not stop this. `test/waveGateData.test.js` checks the committed data
structurally and accepts a `bootstrap` entry by design, so the suite is green on the code
commit alone. There is no mechanical merge block; this document is the control, and the failing
scheduled run is the alarm if it is ignored.

## Why the floors entry ships as bootstrap

`data/wave-floors.json` carries an entry under the new digest with `status "bootstrap"`,
`seededFromCycleId` null and every floor null. That is the intended shipping state, and it is
not a placeholder to be filled in with a guess.

Floors are absolute coverage counts: the answer to "is this enough coverage at all", which no
ratio against a previous cycle can give. A floor scaled from a cycle nobody has measured is the
invented number the file exists to refuse. So the entry records that the grid set is known and
its floors are pending, and it withholds auto-publish exactly as an absent entry does.

The bootstrap entry also satisfies the structural half of `test/waveGateData.test.js`: an entry
exists for the current digest, every `GRIDS` id has a key in its `grids` map, nothing is keyed
that `GRIDS` does not contain, and the entry is wholly pending rather than half-seeded. Those
assertions catch a grid silently unfloored — `perGridFloorRefusals` and `perGridFloorStatus`
both iterate the floors entry rather than `GRIDS`, so an omitted grid produces no refusal, no
warning and not even a "not evaluated" line.

Withheld auto-publish is the safety property. Steps 2 through 4 below are what lifts it, and
nothing else may.

## The sequence

### Step 0 — measure the raster before committing a single origin

Do this on the feature branch, before the merge. It touches nothing outside the working tree.

The `sampled` origins in `src/waveGrids.js` and `data/wave-grids.json` are derived arithmetic
until a real plane confirms them. `gridIdentityRefusals` compares origins within 1e-9 absolute
and pixel sizes within 1e-12, and its refusals are **non-overridable**: `build-wave-manifest.js`
throws before `manifest.json` is written, so a wrong origin discovered after the merge leaves no
manifest to seed floors from and the only exit is a revert.

```
npm run seed:wavegrids -- --grids noaa_nwps_sew
npm run seed:waveplanes
```

Open the hour-0 `HTSGW` plane's `.info.json` and copy `geoTransform[0]`, `[1]`, `[3]`, `[5]`,
`size[0]`, `size[1]` and `bands[0].noDataValue` verbatim into the `sampled` block in **both**
files, then recompute the four `domain` edges as `origin + n * pixel` from those same numbers.
Never take them from the corner coordinates `gdalinfo` prints: those are rounded to seven
decimals and land about 1.2e-8 from the true origin.

The committed block is what the arithmetic predicts. If the measurement disagrees, the
measurement wins.

This pass also settles, for free, four things nothing else in the sequence can: whether the CGI
answers the GET probe at all, whether the `WIND` plane's header nodata matches the `HTSGW`
plane's (a mismatch is a `planeIdentity` refusal), whether `https://polar.ncep.noaa.gov/nwps/`
resolves — if it does not, change `infoUrl` to `https://www.weather.gov/sew/`, which is not a
digest input and is free to move later — and the Carr Inlet trap itself, by finding a cell whose
`HTSGW` reads 9999 beside a `WIND` of 0.

Then run `npm run seed:waves` locally and record `beaches.windOnly` from
`.seed/sample-report.json`. That pre-change number is what the step 3 cross-check compares
against, and it is what the generic pass-2 gate follow-up needs in hand.

### Step 1 — merge the code commit and the bootstrap entry together

One commit, one push: `src/waveGrids.js`, `data/wave-grids.json`, `data/wave-floors.json` with
the bootstrap entry, `src/waveModels.js`, `src/frontend/waveStrip.js`,
`scripts/sample-waves.js`, `scripts/fetch-wave-grids.js`, the workflow edits, the tests and the
docs. Confirm before pushing:

```
npx vitest run
DENO_NO_PACKAGE_JSON=1 deno check --lock=deno.lock --frozen \
  scripts/fetch-wave-grids.js scripts/sample-waves.js scripts/build-wave-manifest.js \
  scripts/build-wave-sql.js
```

That list is the wave-pipeline subset of the frozen `deno check` step in
`.github/workflows/test.yml`; a script added to one belongs in the other.

The suite must be green, including `test/waveGateData.test.js`. A failure there means the
committed floors key does not match the digest the committed `GRIDS` produce, and the two
halves of the commit disagree.

Do not wait for a scheduled cycle. From this point the clock in the blackout section is
running, and steps 2 through 4 must complete inside it. If they cannot, revert.

### Step 2 — dispatch `waves.yml` with publish true

```
gh workflow run waves.yml \
  -f publish=true -f apply=true -f allow_shrink=false -f force_publish=false
gh run watch "$(gh run list --workflow waves.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

`publish=true` is safe here precisely because auto-publish is withheld: the cycle lands in the
run's `wave-cycle` artifact, and `waves/current.json` is not moved. `force_publish` stays false.
Never set it before the floors entry is committed — it would move the live pointer to a cycle
nobody has cross-checked, which is the failure this whole document is arranged around.

The concurrency group is `waves` with `cancel-in-progress: false`, so dispatch away from 52
minutes past 00, 06, 12 and 18 UTC or the run queues behind a scheduled one.

Expected: the run succeeds, `Explain a withheld publish` emits its warning, `Publish the
manifest and the pointer` and `Prune old wave cycles` are skipped, and `publish-d1` is skipped. Watch the wall
clock — this is the first grid whose source file carries 290 bands, adding 48 `gdal_translate`
invocations and 48 `gdalinfo -stats` calls to a normal 10 to 18 minute run against a 30 minute
timeout.

### Step 3 — read the withheld manifest and cross-check it

```
RUN=$(gh run list --workflow waves.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run download "$RUN" -n wave-cycle-reports -D ./.rollout
gh run download "$RUN" -n wave-cycle -D ./.rollout
jq '.gridsDigest, .cycleId, .sanity.autoPublishAllowed, .sanity.warnings' ./.rollout/manifest.json
```

`wave-cycle-reports` carries the manifest and the two reports for fourteen days; `wave-cycle`
carries the NDJSON the content checks below read, for three.

`gridsDigest` must equal the digest at the top of this document, and
`sanity.autoPublishAllowed` must be false with a warning naming the unseeded floors. If the
digest differs, the branch is not what you think it is; stop.

A manifest exists at all only because no refusal survived: `build-wave-manifest.js` prints
every refusal to stderr and fails before writing the file. If step 2's gate step failed, read
its log rather than looking for a `refusals` key. A `gridIdentity` refusal means the `sampled`
origins in `src/waveGrids.js` and `data/wave-grids.json` are wrong; re-derive them from an
extracted plane's geotransform, never from gdalinfo's printed corners, which are rounded to
seven decimals against a 1e-9 tolerance.

Then check, in this order, and stop at the first that disagrees:

```
jq '.sanity' ./.rollout/manifest.json
jq '.beaches' ./.rollout/manifest.json
jq '.grids' ./.rollout/manifest.json
jq '.gridStatus' ./.rollout/manifest.json
```

| Field | Expected | Why it matters |
| --- | --- | --- |
| `gridStatus.noaa_nwps_sew.status` | `sampled` | Anything else means the grid was fetched, planned or extracted but contributed nothing, and every number below it is about a grid that did not run. |
| `grids.noaa_nwps_sew.validPercent` | comfortably above 0 | Clause (d) of `minimumRecordRefusals` applies to every sampled grid and is non-overridable: an all-nodata hour-0 wave plane refuses the whole cycle, ocean included. |
| `grids.noaa_nwps_sew.resolvedBeaches` | near 487 | Of roughly 542 beaches inside the SEW domain. Materially lower means the band plan or the land mask is wrong. |
| `grids.noaa_nwps_sew.medianSearchKm` | a few km | Cells are about 4 km. A collapsed median is an early symptom of a shifted geotransform. |
| `grids.noaa_nwps_sew.maxSearchKm` | at or under 10 | The cap. Above it is a bug, not a wide search. |
| `grids.noaa_gfswave.resolvedBeaches` | unchanged at 4816 | The new grid is appended last, so pass 1's ordered fallthrough offers it only beaches gfswave could not resolve. Any drop means the grid went in at the wrong index and reassigned beaches the seeded floors vouched for. |
| `beaches.resolved` | up by roughly 487 | The gap this change closes. |
| `beaches.windOnly` | not grown | The default-deny wind fallback in action. NWPS `WIND` reads 0 rather than nodata on masked cells, so a wind-only reading there would be a false calm. |

Cross-check `beaches.total` against D1 directly. This is a read-only SELECT:

```
export CLOUDFLARE_API_TOKEN="<CLOUDFLARE_D1_READ_TOKEN>"
npx wrangler d1 execute swim-report --remote --json --command \
  "SELECT COUNT(*) AS n FROM beaches WHERE $(DENO_NO_PACKAGE_JSON=1 deno run --allow-read scripts/print-flag-worthy-sql.js)"
```

`CLOUDFLARE_D1_READ_TOKEN` is a repository secret, not a local one. The
`CLOUDFLARE_WORKERS_EDIT_TOKEN` in `.dev.vars` is not authorized for D1 and answers 7403.

And bound the Salish Sea expectation against the same table, over the SEW domain:

```
npx wrangler d1 execute swim-report --remote --json --command \
  "SELECT COUNT(*) AS n FROM beaches WHERE water_class = 'ocean' AND lat BETWEEN 46.082 AND 49.438 AND lon BETWEEN -127.026 AND -121.884"
```

Expect roughly 542. `resolvedBeaches` near 487 against that count is the 10 km cap doing its
job; the residual is unresolved by design, not lost coverage.

Two content checks the counts cannot make:

```
jq -s 'map(select(.model == null and .windSpeedMph != null)) | length' ./.rollout/waveinput.ndjson
jq -c 'select(.model == "noaa_nwps_sew") | .hoursFt' ./.rollout/waveinput.ndjson | head -1
```

The first is the wind-only population, and must match `beaches.windOnly` and not exceed the
pre-change figure. A wind-only record carries `model: null`, so no grid is named on it and the
ndjson cannot attribute one; `noaa_nwps_sew` declares `windFallback: false` and pass 2 skips it
before loading a plane, which is what makes a false calm impossible rather than merely
unlikely.

The second is a 24 h series. For a beach in the Alki area it should run roughly 0.13 to 0.9 ft.
A flat 0.0 series, or any 9999, means the mask or the band plan is wrong and seeding must stop.
Pick the beach by `beachId` if you have one to hand rather than taking the first line.

### Step 4 — commit the floors entry as seeded

Replace the bootstrap entry under the same digest key. Set `status` to `"seeded"`,
`seededFromCycleId` to the manifest's `cycleId`, and every floor — `waveinputRecords`,
`wavesRecords` and each of the four per-grid counts — to 0.75 times the observed value, rounded
down. All four grid ids need a number; a null in a seeded entry silently retires that floor.

Leave the old `sha256:c4eafd4a...` entry untouched. The file is append-only, `floorsEntryFor`
keys on the current digest, and keeping the old entry is what makes a code revert self-healing.

Carry a `_comment` in the shape the existing entry uses, recording the D1 counts from step 3,
where they came from, and that the Salish Sea residual is unresolved by design.

```
npx vitest run test/waveGateData.test.js
```

Green means the key matches what `GRIDS` produces and the entry is wholly seeded. Push.

### Step 5 — re-dispatch with force_publish

```
gh workflow run waves.yml \
  -f publish=true -f apply=true -f allow_shrink=false -f force_publish=true
```

This is the run that moves `waves/current.json` and writes the rows. Dispatch it from the branch or
ref carrying the seeded floors entry: `workflow_dispatch` runs the workflow file and the code
from the selected ref, and a ref still carrying the bootstrap entry withholds again.

Expected: `AUTO_PUBLISH=true` in the gate step's output — the seeded entry alone should be
enough, and `force_publish` is belt and braces for the first cycle whose ratio checks have no
per-grid predecessor for the new grid. `Publish the manifest and the pointer` runs,
`publish-d1` runs, and `Apply the delta to production D1` completes with a non-zero `rows=` on
its summary line.

A degraded-tier warning naming `noaa_nwps_sew` as unfetched is a healthy outcome, not a
failure. SEW publishes on demand near 00Z and 12Z with whole days sometimes absent;
`gridsComplete` false still writes rows for every other grid.

If `sanity.autoPublishAllowed` is still false, read the withheld reason in the manifest before
touching anything. Do not reach for `allow_shrink`.

### Step 6 — confirm on the live site

```
curl -s https://map.swim.report/waves/current.json | jq
```

The `cycleId` must be the one from step 5, not the previous cycle.

Then open a Salish Sea detail page on https://swim.report and confirm:

- a wave strip labelled "NOAA NWPS Seattle", not a raw id and not the generic "Wave Forecast"
  chip;
- an estimate card carrying a wave-height reason rather than `unknown`;
- heights under a foot in fair weather.

Green in fair weather is expected. Puget Sound sits under the ocean class's yellow threshold
most of the year. Retuning thresholds for sheltered water is out of scope for this change.

Spot-check two more beaches: one that was gray before and now resolves, and one still outside
every grid's reach. The second must be gray. It must never be green.

### Step 7 — watch the first scheduled slot

The next `52 */6 * * *` occurrence should auto-publish with no human input: `AUTO_PUBLISH=true`,
the pointer moved, `publish-d1` run. A scheduled run that withholds instead fails on `Fail a
scheduled withheld publish`, and that failure means the floors entry is wrong or missing for the
digest in force. Treat it as an outage and go to the recovery section below.

## Rollback

Revert the code commit whole — `src/waveGrids.js` and `data/wave-grids.json` together with the
rest. The digest returns to `sha256:c4eafd4a...`, whose seeded entry is still in the file
because floors are append-only, `test/waveGateData.test.js` is green because that entry covers
exactly the reverted grid set, and the next scheduled cycle auto-publishes with no further
action. No data migration and no cleanup: a `noaa_nwps_sew` record expires on its own absolute
lease, and nothing deletes a stored wave record.

Never revert partially. Reverting the `waterClasses` or `windFallback` digest fields alone moves
the digest again and re-triggers the withhold with no new grid to show for it.

## If a scheduled run fired before the floors were seeded

Recovery is bounded. The failed run did not move the pointer, so the previous cycle's stored
records stay live until their own `validStart + 86400` — hours of headroom, not minutes.

`Upload the manifest and sample report` is `if: always()` and runs before the failing step, so a
run withheld on the floors carries a usable `manifest.json` in its `wave-cycle-reports`
artifact. Either seed the floors from it and land step 4 immediately, or revert the code commit.
Do not force-publish a cycle nobody has cross-checked to buy time.

A `gridIdentity` refusal is the one case with no manifest to recover from:
`build-wave-manifest.js` throws before writing the file, so the artifact carries only the
sample and grids reports. Re-derive the origins per step 0 and land them, or revert.

## Out of scope, named so they are not smuggled in

- A `sheltered` `water_class` with its own wave thresholds. Puget Sound reading green under the
  ocean thresholds is the expected outcome of this change, not a defect it should fix.
- The classification flip rail counting a hide only when the new class is `inland`.
- `scripts/fetch-wave-grids.js` range mode passing `grid.variables` instead of the module-level
  `GRID_ELEMENTS`. NWPS uses whole mode, so it is not on this path.
- Extending NWPS to other WFO domains. One grid entry and one floors reseed each, following this
  same sequence.
- The generic pass-2 gate requiring a wind hit to sit on a cell the same grid's hour-0 HTSGW
  plane reports usable. It makes pass 2 vacuous for every grid, so it changes the existing
  grids' record counts and needs the pre-change `beaches.windOnly` measurement in hand and a
  floors reseed in the same commit.
- `GRIDS` array position as a digest input. Fallthrough order decides beach-to-grid assignment
  while the digest sorts entries by id, so a reorder moves which model answers for a beach with
  the seeded floors still validating — the same failure mode the `waterClasses` fix closes.
- A fourth `MODEL_SERIES_COLORS` entry, if a payload ever carries three known models.
