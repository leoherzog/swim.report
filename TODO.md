# TODO.md — Swim Report

Registry of LIVE known gaps, deliberate deferrals, and verified dead-ends, per
PLAN.md. Nothing below blocks the pilot; all of it is scoped for follow-up work.

## Data quality / coverage

- **Pond filter covers unnamed park beaches only.** Discovery drops unnamed park-contained
  beaches whose adjacent `natural=water` is all below ~4.5 ha bbox (`isPondBeach`). Named pond
  beaches are deliberately untouched — someone mapping a name is treated as intent. If named
  pond beaches turn out to be noise too, apply the same test to them. Known residual of the
  ways-only water evidence (PLAN.md §5): an unnamed beach on a relation-mapped inland lake with
  no coastline tagging, whose only nearby way-water is a small pond, would be wrongly dropped.
  No confirmed real instance yet. The fix is cheap — consult the lakes-polygon layer, a local
  lookup. See the Scale-out section.
- **Flag-worthy water classification** (migration 0009, `src/waterClass.js`). Runs only in the
  offline GitHub Actions batch (`scripts/discovery-batch.js`, Deno). Each beach's adjacent water
  body is resolved by a **local spatial join** over the prebuilt FlatGeobuf layers
  (`src/layerSignals.js`), anchored on member vertices at 150 m / 120 m radii, and classified
  ocean / great_lake / inland by the pure `classifyWaterBody` (Great Lakes matched by wikidata
  QID, never by name). The join always decides: a clean-but-empty result classifies `inland`,
  and there is no transient-failure mode, so an unclassified row means only "not in the layer
  set". Inland and parked rows are hidden by the shared `FLAG_WORTHY_WATER_SQL` gate on every
  consumer, never deleted; still-unclassified NULL rows stay visible (fail-open), which is why
  deciding on the first complete probe matters — a pending row is a published row. The batch
  classifies its own new-beach delta synchronously and NULLs `water_class` when a re-discovered
  centroid moves > ~100 m. Open residuals:
  - **Node-only beaches** (`osm_id` = "node/N") have no polygon geometry, so only the point can
    be probed; a node set back from shore can miss and is classified inland and hidden. Accepted
    residual — most set-back beaches are ways or relations, which the vertex probe handles.
  - **Probe radii are the remaining lever for set-back beaches.** A complete-but-empty probe
    decides `inland`, so a genuine Great Lakes beach whose polygon sits beyond
    `GREAT_LAKE_RADIUS_M` from any mapped shoreline is labeled inland on the first attempt. The
    fix for that whole class is widening the radii, not restoring a pending state. Note the
    asymmetry: ocean and great_lake probe at 150 m while inland probes at 120 m, so a beach
    whose only water sits in the 120–150 m band can be confirmed flag-worthy but never
    confirmed on inland water; widening `INLAND_RADIUS_M` to 150 m would close it. This is
    **actionable**: a re-drain is a `WATER_CLASS_VERSION` bump plus one local re-run that
    re-decides the whole table in seconds. It still changes stored decisions, so it needs the
    version bump, a measured before/after distribution, and a look at the classification flip
    rail (`CLASSIFY_MAX_HIDE_FLIPS` / `CLASSIFY_MAX_HIDE_FRACTION`) before it lands.
  - **Parked rows** sit at `WATER_CLASS_MAX_ATTEMPTS = 5`, matching the enrichment caps. A
    version bump does **not** un-park them: `buildClassifyQueue` ANDs the version clause with
    `attempts < cap`, so the cap, not the version, is the gate. Rows the pre-decisive classifier
    parked are re-drained once by the `water_class_version IS NULL` legacy marker, deliberately
    without resetting attempts so they stay hidden while they re-decide. Do **not** reach for
    `UPDATE beaches SET water_class_attempts = 0 WHERE water_class IS NULL`: it un-parks them
    into the fail-open gate and republishes every one as a visible beach with an estimated flag
    card until it drains. Under the decisive classifier nothing can newly reach the cap, so a
    rising parked count means the classifier regressed to a pending state.
  - **Orphaned `flag_history` / `last_viewed`** for reclassified-inland beaches
    linger in D1 (their KV flags self-expire at the 25200 s TTL). Harmless and
    cheap — left in place.
  - **The `ocean` branch stays dormant** until `REGIONS` gains a saltwater box. In the current
    Great Lakes regions every keeper is a Great Lake, since shorelines are relation member ways
    rather than `natural=coastline`. Harmless: ocean and great_lake are both flag-worthy and
    pass the gate identically — only inland versus {ocean, great_lake} must be reliable.
- **GitHub Actions cron skipping is the wave pipeline's largest unclosed risk.** The
  scheduler skips occurrences rather than deferring them, and 8 slots a day against a 7 h
  absolute key expiration tolerates only two consecutive misses. The permanent fix is to
  carry `hoursFt` and `startIso` in `waveinput:` and have `runFlagRecompute` index the
  current hour, which turns one landed cycle into 24 h of coverage; it is out of scope here
  because it changes the hourly cron's read contract.
- **A grid that sampled but under-covers its seeded per-grid floor still refuses the whole
  cycle**, so a present-but-under-covering GLWU takes the ocean down with it. Dropping that
  grid's records instead would mean re-emitting and rescanning both NDJSON artifacts inside the
  build. The exposure is dormant while every floor in `data/wave-floors.json` is null.
- **The permission guard in `.github/workflows/test.yml` checks `--allow-net` only.** No
  Deno script in the wave pipeline may carry `--allow-run` (GDAL runs in the workflow
  shell), but nothing enforces that machine-side; extend the same loop to `--allow-run`.
- **Measure the slot hit rate before trusting the cadence.** No second wave source is left to
  shadow against, so read the hit rate from `waves.yml`'s run history and the per-beach coverage
  from `manifest.beaches.resolved` across consecutive cycles. A run of missed slots is the
  trigger for the `hoursFt`/`startIso` fix above.
- **Arctic 9 km spiral is unvalidated against real Alaska coordinates.** Ring geometry on a
  polar-stereographic grid differs from a lat/lon one, and `gfswave.global.0p16` stops at
  52.583°N, so every Alaskan beach depends on that path. Check a handful of real rows before
  the first publish.
- **The identity gate proves the target raster of a warped grid, never its source.** For
  `noaa_glwu` and `noaa_gfswave_arctic` the plane is produced by `gdalwarp` at a fixed `te`/`tr`,
  so a displaced source resamples into a raster whose header matches `data/wave-grids.json`
  exactly and passes. `planFor` already reads each source file's `gdalinfo`, so carrying the
  source header on every plan entry and gating on both is the natural fix.
- **A seeded absolute `validPercent` floor per grid** (`floors[<digest>].validPercent[<gridId>]`)
  is the eventual shape: the ratio rails catch a slide from a known-good cycle, while an
  absolute floor catches a grid that has been thin since the first accepted cycle. It cannot be
  seeded while `data/wave-floors.json` carries null floors.
- **`PERPW`, `DIRPW`, `SWELL` and `WVHGT` arrive in the GRIB messages already being fetched.**
  They are the natural second series for the currently dormant multi-model comparison chart.
- **GFS atmos `GUST:surface` would restore `windGustMph`.** It is a second upstream product
  family (`gfs.tHHz.pgrb2.0p25`) for a branch that fires only when wave data is entirely absent,
  and GFS surface gust is not the same quantity as a 10 m gust, so the output distribution would
  shift and must be measured first.
- **Windy webcam caveats** (`src/clients/windyWebcams.js`, daily `runWebcamSync`). The free
  tier publishes **no daily request quota**, so 100 lookups a night is polite guesswork; watch
  the daily-run logs for 429s. The free-tier embed player shows ads, and the ad-free tier is
  €9,990/yr, so ads stay. "Nearest active cam within 5 km" is a proximity heuristic — the cam
  may face a marina rather than the beach; the UI labels it "Nearby webcam" honestly, and a
  curated per-beach override column is the eventual fix if bad matches show up. Cams flip
  between active and inactive, so a beach keeps a stored player URL up to 14 days after its cam
  dies.

  **Open decision (not pending work):** nothing reads `webcam_detail_url`. Both `/webcams`
  queries request `&include=player,location,urls`, the client returns `detailUrl`, migration
  0011 added the column, and the daily cron writes it — but the render-side per-cam anchor was
  removed when Windy attribution moved to the site-wide footer, so the column is written every
  night and never displayed. Two coherent resolutions; pick one rather than leaving it as-is:
  (a) restore the per-caption deep link in `render.js` so each cam links its own Windy detail
  page, or (b) stop writing the column and let the footer credit stand alone. Migration 0011's
  stated rationale — the Windy Terms line "Link every image with either our webcam page or
  timelapse player for full view", satisfied by `renderWebcam`'s caption — is currently unmet,
  and both `src/clients/windyWebcams.js`'s header and migration 0011's comment still describe
  that removed fallback. Whoever decides should confirm against Windy's current Terms whether
  the footer credit alone suffices.
- **Threshold calibration against real flag history.** The `flag_history` table (migration
  0006, PLAN.md sections 2 and 7) accumulates estimated-versus-official pairs for beaches with a
  scraped official flag; the raise-only wqFloor water-quality sources are not official and do
  not feed calibration. Once enough history exists, revisit the wave and wind thresholds in
  `src/rules.js` against how often the estimate matches the posted flag, and bump
  `RULES_VERSION` if thresholds move — cached `FlagEstimate` objects carry their own
  `rules_version`, so this is safe to do incrementally. Revisit the flat 90-day retention window
  (`FLAG_HISTORY_RETENTION_DAYS = 90`) in the same pass. That pass should also decide the
  multi-model derivation question: the flag uses the composite first-finite-model wave series,
  and the per-model data in the `waves:` payloads (`byModel`) exists precisely so mean, max or
  calibrated-blend alternatives can be evaluated retroactively against official flags. Note the
  safety asymmetry before reaching for a mean: averaging dilutes whichever model saw the hazard
  — a 4.5 ft plus 2.5 ft disagreement averages to yellow, not red — so any derivation change
  must ride a `RULES_VERSION`-style bump to keep calibration cohorts comparable.
- **Secondary unnamed park beaches need a derivable label to survive.** `mergeBeachRows` keeps
  a park's largest unnamed beach under the bare park name, and additional unnamed beaches only
  when `deriveUnnamedSuffix` finds a distinguishing label (the element's own `loc_name` tag,
  else a compass direction at ≥0.2 km separation); indistinguishable or coincident polygons drop
  and are logged `skipped_unnamed`. Follow-up: merge their geometries, or derive richer locality
  labels.
- **Park association is bbox-overlap, not polygon containment.** Each beach associates to the
  smallest park whose bounding box overlaps the beach's. An L-shaped or diagonal park could
  claim an adjacent beach. Verified accurate on the pilot region's state parks; revisit if wrong
  pairings show up.
- **Only named beaches and parks are discoverable — by design.** Every discovery path requires
  a name somewhere: the first pass takes only named `natural=beach` / `leisure=beach_resort`
  elements, and park containment only rescues unnamed beaches inside a **named** park polygon.
  An unnamed beach outside any named park never enters the dataset, and any future pass should
  keep that constraint, because a row with no human-searchable name cannot be displayed,
  searched or trusted as a real swim spot. The excluded set is large — roughly three-quarters of
  US `natural=beach` elements are unnamed — and intentionally out of scope unless a future pass
  invents names from other containment or proximity signals.
- **Beaches OSM simply hasn't mapped stay invisible.** Park containment only
  rescues beach polygons that exist. P.J. Hoffmaster State Park has a park
  polygon but no `natural=beach` element inside it, so it still doesn't appear.
  Fixing OSM is the fix.
- **Canadian beaches: alerts and marine warnings supported, no rip or surf signal.** Ontario
  shoreline beaches get Environment Canada land alert coverage (ECCC zone enrichment plus the
  hourly national GeoMet `weather-alerts` fetch matched by alert-region polygon,
  `src/clients/eccc.js`, rules step 1b) and marine warnings (`marineweather-realtime`,
  `src/clients/ecccMarine.js`, matched by marine-zone polygon and concatenated into the same
  alerts list). ECCC issues no rip current, high surf or beach hazards product, so Canadian
  estimates have no step-2 rip analog and lean on the curated warning set plus wave and wind.
  Possible refinements: the ECCC colour-coded tier (`risk_colour_en`) as a severity signal, and
  pairing with a Canadian official source. **Warning:** the land warning literal strings
  ("waterspout warning", "storm surge warning", "tornado warning") are inferred from ECCC's
  product list and not yet observed live in `alert_name_en` — verify the exact strings when one
  fires; a mismatch fails safe, ignoring the event. The marine event names are lowercased from
  the live `marineweather-realtime` payload.
- **ECCC zone enrichment: consider a conservative shoreline-nearest fallback.**
  `runEcccEnrichment` does one bulk `fetchEcccForecastZones()` polygon fetch per run plus local
  exact point-in-polygon. A beach centroid sitting just offshore of its forecast-region polygon
  resolves to null and parks, exactly like a US point. A conservative
  nearest-region-within-a-small-distance fallback could rescue those centroids; it is
  deliberately not implemented, to avoid a wrong region assignment. Revisit if parked Canadian
  counts climb.
- **SwimSmart / Michigan DNR partnership outreach.** Michigan's SwimSmart program and
  DNR-managed state park beaches are the only path to Michigan's statewide official data: every
  EGLE BeachGuard/MiEnviro route is an SPA shell with no beach data in raw HTML and no
  discoverable unauthenticated API, and a dozen-plus county health pages just defer to it. The
  partnership gates 70+ beaches' worth of official data. A ready-to-send outreach email draft
  lives at `docs/swimsmart-outreach-draft.md`.

## Scale-out

- **Offline discovery + classification (live residuals).** Discovery and water-body
  classification run in one daily GitHub Actions workflow that scans a prebuilt FlatGeobuf
  layer set and bulk-loads D1, over layers a second workflow builds twice weekly from the
  Geofabrik OSM extracts — see `docs/offline-discovery.md`. The live residuals:
  - **Freshness is the extract cadence, not minutes.** A beach mapped in OSM today appears
    after the next twice-weekly build, and `MAX_SOURCE_AGE_DAYS = 21` is a hard refusal, not
    a warning.
  - **The dangerous failure is a successful build of a wrong layer set** — a clip-mask bug, a
    short parks layer, an `ogr2ogr` node-index exhaustion that returns empty with exit status
    0. The defenses are the absolute floors in `data/layer-floors.json`, the previous-build
    ratio checks, the manifest's three-tier gate, the two proportional delete rails and the
    classification flip rail. Every one of those numbers was calibrated against a 1669-row
    table; re-derive them when the table changes scale.
  - **Layer-set size at North America scale.** The published set is O(beaches) because of the
    ~1.1 km proximity clip, but the pre-clip intermediate is not, and the build's peak disk
    (~13.3 GB) sits inside a runner's budget with less headroom than is comfortable. Measure
    before adding coasts.
  - **`beaches-line` and `water-line` may be droppable.** If they contribute nothing to
    discovery or classification, dropping them shrinks the set and the download. Decide from a
    real build's manifest, not from reasoning.
  - **Retire the vestigial classification columns.** Nothing can bump `water_class_attempts`,
    and `parkedPreDecisive` plus the attempts cap in `buildClassifyQueue` exist only for rows
    parked before the layer migration. Once a run reports zero such rows, delete the cap, the
    marker and (in a migration) the column.
  - **The relation-mapped-inland-lake pond filter is cheap to fix.** The narrow residual at
    the top of this file (ways-only water evidence) can be closed by consulting the
    lakes-polygon layer directly, a local lookup rather than a new upstream probe.
- **Every `deno` step in every workflow must set `DENO_NO_PACKAGE_JSON=1`.** The repo-root
  `deno.lock` is auto-discovered for all Deno commands here; without that env var Deno folds
  `package.json`'s npm tree into the lockfile it expects, `deno check --frozen` fails with "The
  lockfile is out of date", and a plain `deno run` silently rewrites the checked-in lock. The
  npm scripts already set it. Do not "fix" this by regenerating the lock without the env var —
  that trades a loud failure for silent drift in the only delete-bearing job in the repo.
- **Demand-priority recompute rotation — mechanism landed, cold-tier tuning deferred.** The
  request path stamps `beaches.last_viewed` (migration 0007; detail page and `/api/flag`,
  throttled to 1/h per beach, `ctx.waitUntil`). `runFlagRecompute` and `runWaterTempRefresh`
  split their rotation into a hot tier (`last_viewed` within `HOT_VIEW_WINDOW_MS`, always
  fully covered) and a cold tier rotating through the remaining `MAX_BEACHES_PER_RUN` budget;
  the enrichment and webcam crons add `last_viewed DESC NULLS LAST` as a queue tiebreak. At
  pilot scale both tiers fit inside one run, so the split only starts mattering once beach
  count approaches `MAX_BEACHES_PER_RUN`. Deferred residue: (1) stamping `last_viewed` from the
  home list view too, since only the two single-beach routes stamp it today; (2) a real
  split-query implementation — today's is a single ORDER BY guard, not two queries — plus the
  migration 0012-class indexes real pagination will need; (3) real pagination itself. Workers
  Cache means cache hits do not run the Worker, so `last_viewed` undercounts popular beaches
  slightly, which is fine for a coarse priority signal.
- **Alerts-only fast cron — shipped as `runAlertRefresh` (`"3-53/10 * * * *"`).** It closes
  the warning-to-flag gap from up to an hour to about ten minutes on four national fetches
  whose cost is flat in the beach table. Residue: a queue-based stale-refresh (request path
  enqueues, consumer fetches), only if flagless gaps show up in practice.
- **Canadian clear-down is still hourly.** `runAlertRefresh` is raise-only for Canada, because
  neither GeoMet collection has an `/alerts/active/count` equivalent and the cron publishes a
  lowering only from a feed whose completeness it verified. It becomes 10-minute the moment
  GeoMet exposes a count or the two collections gain an independent completeness signal.
- **336 flag-worthy rows carry a marine zone id in `nws_zone`** (`LHZ441`, `LMZ221`, `LSZ250`
  and so on), with `marine_zone` equal to it, because `api.weather.gov/points` returns a
  marine forecast zone for a centroid over water. Those beaches have no land forecast zone and
  can never match High Surf Advisory, Beach Hazards Statement or Coastal Flood Advisory — the
  products the refresh cron exists to deliver quickly — yet they read `alertsCheckable` true,
  so no caveat renders. Pre-existing; the fix belongs in NWS enrichment, which should reject a
  marine-prefixed `forecastZone` and re-queue the row.
- **`rules.js` step 3's else branch still has no finite check**, so any future caller passing a
  non-finite `waveHeightFt` gets green with a nonsense reason. `buildEstimateInputs`
  (`src/flagInputs.js`) closes the reachable route from a malformed KV value; fixing `rules.js`
  itself is a color-decision change and needs its own `RULES_VERSION` bump.
- **An ECCC bounding-box prefilter through `idx_beaches_lon_lat`** before exact
  point-in-polygon. Free at today's 354 Canadian rows (112 ms measured); about 6.4 s of CPU at
  20k against the 30 s sub-hour CPU allowance the refresh cron runs under.
- **`flag_history` records only hourly-vintage pairs.** `runAlertRefresh` scrapes no officials,
  so it logs nothing, and a color served between hourly runs may differ from the logged one.
  Calibration should say so.
- **Map directory scale ceiling.** The binding constraint on `mapdirectory:v1` is the 128 MB
  isolate, not KV's 25 MiB value cap (190 B/entry measured, so the cap is ~139k entries away)
  and not the read-time CPU. Measured against the real `mapDirectoryFeatures` with the
  directory string, the parsed directory, the feature array and the response body all live at
  once, which is what `handleBeachesGeojson` holds: 10k → 1.8 MiB artifact, 17 MiB heap, 72 ms
  (parse 27 + resolve 20 + stringify 25); 40k → 7.3 MiB, 56 MiB, 255 ms; 100k → 18.1 MiB,
  151 MiB, 590 ms. A single 100k request exceeds the isolate on its own, so the endpoint OOMs
  somewhere near 85k features with no concurrency at all, and near 42k with two concurrent
  cache misses. The practical ceiling is roughly 40k features, and the single-fetch map model
  wants bbox or tile sharding well before that. The artifact does not scale to 100k, and
  nothing here should pretend it does.
- **The refresh cron's KV read volume is the Worker's one recurring O(N) cost.** Its scan
  reads both key families for every flag-worthy beach on every run, and KV bills a bulk read
  per key, so 144 runs a day is 288N key-reads a day: about 320k at today's 1,102 rows, 2.9M
  at 10k (~87M/month, past the Paid plan's 10M included reads) and 29M at 100k. It buys the
  standing alert set for a median of a few dozen beaches whose alerts actually moved. There is
  no cheaper level-triggered selection while the standing set lives inside the `"flag:"` value;
  the ways out are a shorter cadence for the artifact rebuild than for selection, or the same
  bbox/tile sharding the ceiling above wants.
- **NDBC `latest_obs.txt` would replace the hardcoded water-temp table.** One ~106 KB file
  carries 886 stations, against today's 72 committed rows and 72 per-station Range fetches.
  Display-only and a separate change, because it feeds a different key family on a
  per-station time basis. Once it lands in Actions, `"15 */6 * * *"`,
  `runWaterTempRefresh`, `beaches.wave_updated`, `ROTATION_COLUMNS.wave` and the rest of
  `src/waveSources/ndbcBuoys.js` all become removable together in one coherent commit, and
  `migrations/0013_drop_wave_updated.sql` becomes the honest follow-up.
- **NWS marine-zone shapefile refresh (~biannual chore).** `beaches.marine_zone` is derived
  offline from `data/marine-zones-greatlakes.json`, generated from the NWS coastal
  marine-zone shapefile. NWS republishes it ~1–2×/year on a schedule announced on
  https://www.weather.gov/gis/MarineZones (current release `mz16ap26.zip`, effective
  2026-04-16). When a new release lands, follow the refresh procedure in
  `docs/offline-discovery.md` (update `DEFAULT_ZIP_URL` + `RELEASE_VALID_DATE` in
  `scripts/build-marine-zones.js`, regenerate, diff per-prefix counts, `npm test`, commit).
  Also grow `GREAT_LAKES_ZONE_PREFIXES` in that script whenever `src/regions.js` `REGIONS`
  gains coasts beyond the Great Lakes system.
- **North America coastal expansion — add Pacific / Gulf / Atlantic boxes to
  `src/regions.js`.** The DISCOVERY half of this is now genuinely cheap. `REGIONS`
  feeds the layer build's clip mask, the per-region sanity floors and delete rail,
  and `pointInAnyRegion` delete scoping — and nothing else. There is no tiling and
  no per-box query cost, so scale-out stays purely additive: append coastal bboxes
  to `REGIONS` (commented-out placeholders already stubbed at the bottom of the
  file) and the build clips to them automatically. Adding a saltwater box also
  wakes the dormant `ocean` branch of the water classifier. One constraint remains:
  - **`MAX_BEACHES_PER_RUN = 1200` and `FLAG_TTL_SECONDS = 25200`** (`src/index.js`) are one
    constraint, not two. Hot rows are covered every run; a cold row waits
    `ceil((flagWorthy - hot) / (MAX_BEACHES_PER_RUN - hot))` runs for its turn, and the flag
    TTL must span that wait plus the runs killed before their trailing `recompute_updated`
    batch commits: `FLAG_TTL_SECONDS / 3600 >= that wait + 2`. At 1102 flag-worthy rows
    (1771 total; 669 are hidden as inland) and 471 hot, the wait is one run and the TTL
    absorbs five lost runs, so missing a turn no longer costs a beach its flag. A run
    truncated at the 900 s ceiling is a different failure and the TTL only delays it:
    neither write pool takes a deadline and the `recompute_updated` batch is
    all-or-nothing, so an hourly truncation dies at the same point in the same selection
    order and the same tail is never written. The residual is
    growth: at the observed 43 % hot fraction the inequality fails near 2100 flag-worthy
    rows, and above roughly 2810 the hot tier alone fills the run and the cold tier gets no
    slots at all, which no TTL rescues. The hourly summary logs `oldest=`, the oldest cursor
    stamp the run selected, so the wait is readable from the observability API. Past those
    sizes the knob is a larger `MAX_BEACHES_PER_RUN`, bounded by the 900 s wall clock on a
    cron that passes no deadline to either write pool, or real pagination.
    The alerts refresh cron inherits that reach rather than extending it: a seal and a
    standing `flag:` value exist only for the rows a run covered, so
    `MAX_BEACHES_PER_RUN × (FLAG_TTL_SECONDS / 3600)` beaches — about 8,400 — can hold a live
    seal at any time. At 1102 rows that is the whole table; at 10k it is most of it; past that
    real pagination is the prerequisite, and `skipNoSeal=` in the refresh cron's completion log
    is the number that reports it.

## Official-scraper fragility

- All scrapers parse third-party pages and APIs that can change without notice. Every parser
  degrades to `null` on unexpected markup, never a guessed color, and health monitoring surfaces
  a scraper that goes quiet — but a source that changes *semantics* while staying parseable, for
  example by repurposing a status string, still needs a human to notice.
- **Scraper health alerting is log-only.** `src/scraperHealth.js` logs a loud `ALERT:` line once
  a matched scraper has returned null for 24 consecutive hourly runs, but nothing pages a human.
- **Not every scraper implements empty-success yet.** The contract (PLAN.md §6) distinguishes
  "parsed cleanly, nothing to report" (an empty `sites: []` result, a health success) from
  `null` (a genuine fetch or parse failure). metroparks complies; south-haven and
  chicago-park-district still return `null` when they parse fine but no site survives their
  gates, which off-season or stale-only data would log as a false failure streak.
- **Deferred: tier-2 HTML entity-decoder consolidation.** `decodeCellText` lives in
  `src/officialSources/util.js`, with the two byte-identical copies folded into it. Five
  near-variants are deliberately left alone: `kenoshaBeachConditions.js` `htmlToText`,
  `paDcnrPresqueIsle.js` `htmlToText`, `chautauquaCountyNy.js` `htmlToPlainText`,
  `evanstonStatusfy.js` `stripTags` and `lakeCountyOhBeaches.js` `stripTags`. Folding them into
  a union decoder is **behavior-changing**, not a cleanup: evanston and lakeCountyOh strip
  full-page HTML into a bounded character window (400 / 600 chars) that **gates** a red and a
  yellow floor, and decoding one more entity demonstrably changes whether a floor is raised
  (`prediction&mdash;poor` currently fails `lakeCountyOhBeaches`'s regex and raises no floor;
  under a union decoder it would match and raise yellow). Both test suites use entity-free
  synthetic fixtures, so a green run proves nothing — this needs real captured page samples and
  its own reviewed commit. `erieCountyPaKml.js` `decodeAndStrip` is permanently excluded from
  any such consolidation: it decodes `&amp;` last on purpose, since decoding it first would
  double-decode, and it unwraps CDATA.

## Official-source coverage

A multi-agent survey swept the web for official current-status sources covering
the pilot beaches. Full report: `docs/official-sources-research.md`; structured
verdicts (parse strategies, `matches()` sketches, render modes):
`docs/official-sources-verified.json`. Low-coverage candidates that were never
verified (mostly single-beach county pages) are in the workflow logs if coverage
gaps appear.

### Newly integrated sources (shipped) + human-verify follow-ups

Sources landed across three registries. **Official hazard scrapers**
(`src/officialSources/`, may override the estimate): `nws-omr-grr`, `winnetka-tower-beach`,
`pa-dcnr-presque-isle`, `nws-marine-beach-forecast`. **Raise-only water-quality floor sources**
(`src/wqFloor/`, may only lift a flag, never lower it): `ny-oprhp-beach-status`,
`lake-county-oh-beaches`, `kenosha-beach-conditions`, `mn-beaches`, `grey-bruce-rec-water`,
`ontario-parks-beach-postings`, `evanston-statusfy`, `usgs-great-lakes-nowcast`. **ECCC marine
warnings** (`src/clients/ecccMarine.js`) are wired into the Canadian alert path (rules steps 1b
and 6b).

Follow-ups a human must verify. Parsers fail safe to `null` or no effect, so these are coverage
gaps, not wrong-color risks.

- **Three wqFloor sources are authored, tested and deliberately unregistered** —
  `chautauqua-county-ny`, `erie-county-pa-kml` (fetch URL still `""`) and
  `illinois-beachguard` (`ILLINOIS_BEACHGUARD_CONFIRMED === false`, placeholder BeachIDs). All
  three fail closed before fetching, so while sitting ahead of working sources in the
  first-match-wins `wqFloorSources` registry they were permanently inert — and because the cron
  resolves exactly **one** source per beach, an inert source silently **suppressed** the working
  source behind it: `erie-county-pa-kml`'s `ERIE_BOX` is strictly inside
  `usgs-great-lakes-nowcast`'s region bbox, and `illinois-beachguard`'s box overlaps
  `kenosha-beach-conditions` coverage around lat 42.517–42.55. The modules remain on disk with
  their full test suites. **When a gate is confirmed**, re-insert that source into
  `wqFloorSources` in `src/wqFloor/index.js` **above** `usgsGreatLakesNowcast` — and, for
  `illinois-beachguard`, also above `kenoshaBeachConditions` — never below, or it will shadow
  nothing and be shadowed itself. Several other wqFloor source URLs are best-effort and should
  be re-verified live before their coverage is relied on; `grey-bruce-rec-water` is flagged
  low-confidence in its own header.
- **`nws-marine-beach-forecast` ArcGIS layer enumeration** — only layers verified live (CLE =
  19, BUF = 7, Lake Erie/Ontario) are enabled. Enumerate the MapServer for additional Great
  Lakes Day-1 layers and enable each only after confirming it returns features live; a wrong
  layer id silently yields no features, which is safe-fail.
- **`pa-dcnr-presque-isle` hazard-keyword mapping is PROVISIONAL** — the live DCNR
  advisory feed is currently 100% off-axis boilerplate, so the swimming-hazard →
  red mapping is verified only against synthetic fixtures. Re-verify against a real
  Danger-tier swimming-hazard advisory when one appears.
- **`winnetka-tower-beach` `staleMs` rests on a thin sample** — its 72 h staleness horizon is
  reasoned from one observation of the posting page plus the ~63 h Friday-post / Monday-read
  weekend bound, not a measured distribution. Re-verify the real in-season posting cadence; if
  genuine holds routinely run longer, raise the horizon rather than leaving false stale warnings
  in place. Note also that a `staleMs` that never trips makes a silently-dead source
  indistinguishable from a healthy one — the `scraperhealth:` counter, not the horizon, is what
  catches that.
- **Water-temp coverage is 47%, and 14% in winter** — 519 of 1102 beaches have a
  `CAP_WATER_TEMP` station inside the 25 km cap, falling to ~153 when the seasonal buoys are
  pulled and only the year-round NOS gauges remain. The gap is a real sensor-density limit on
  the Great Lakes, not a list problem: even at a 75 km cap winter coverage only reaches ~36%.
  GLOS Seagull exposes `sea_water_temperature` on a denser network and is the obvious next
  source; it would need the same siting review this list got.
- **Station-list rot has no trip-wire** — station 45161 (Muskegon) went off-air and nothing
  noticed; it was found by hand. The 12 h freshness window correctly degrades a dark station to
  null, which is exactly why the failure is invisible. The gather knows, per run, how many
  unique stations it consulted and how many returned a reading, so logging `stations=<n>
  live=<n>` would make a station family going dark visible in the observability query.

### Registered scrapers — live caveats

Seven scrapers are registered in `src/officialSources/index.js` (contract v2, multi-site, one
test file each) — hazard, flag and closure sources only. An official color overrides the
estimate wherever shown, so water-quality (E. coli / bacteria) sources are deliberately
excluded: a clean-water green is a different axis from surf hazard and would mask a genuine
hazard estimate such as a gale-driven red. Six water-quality scrapers were removed for this
reason (`lenawee-mi`, `michigan-city-in`, `ohio-beachguard`, `hdnw-michigan`, `bldhd-mi`,
`wisconsin-dnr`) — modules, tests and doc entries deleted. Do not re-add a source whose clean
reading would downgrade a hazard flag. Caveats for the registered set:

- **South Haven CSV** (`south-haven-mi`) — the CSV URL is re-discovered from the flag page each
  run, with a hardcoded fallback; Gray means unmonitored, so no data; colored output is gated to
  the monitored season and hours (America/Detroit); same-named flag poles roll up to most
  severe.
- **Chicago Park District `/flag-status` JSON** (`chicago-park-district`) — the payload mixes in
  stale prior-season rows, so the 36 h per-record staleness gate is load-bearing, and green
  additionally requires the beach's own Surf row to be fresh. "Afterhours" maps to red, a
  lifeguards-off closure noted in the reason. Undocumented and unversioned API; off-season
  behavior still unverified.
- **Huron-Clinton Metroparks** (`huron-clinton-metroparks`) — closure-only; parsing strictly
  scoped to the Kensington and Stony Creek panel ids; name-only site resolution, so an open
  sibling beach cannot inherit its neighbour's red; Lake St. Clair Metropark excluded, deferring
  to EGLE.
- **Windsor-Essex County Health Unit** (`wechu.org/beaches/beach-water-testing`, Ontario) — not
  built, but still the most feasible Canadian source when that becomes relevant.

### Tier 2 — worth building, with caveats

- **Algoma Public Health** (CA) — status is inline plain-text JS in raw HTML, but match by
  lat/lon proximity rather than name: "Old Mill Beach" appears twice at different locations, and
  3 of 5 claimed names never appear on the page.
- **City of Muskegon WP REST feed** (`muskegon-mi.gov/wp-json/wp/v2/posts?categories=8`) — clean
  JSON, but event-only press releases: the absence of a post is not an affirmative all-clear.
- **Grand Traverse County** (`gtcountymi.gov/814`) — static and dated, but only 5 claimed beach
  names appear and entries aggregate ("four beaches Level 2…"); only the unambiguous "all GTC
  beaches Level 1" case is trustworthy.
- **Michigan DNR closures feed** (Sitecore search JSON behind
  `michigan.gov/dnr/about/newsroom/closures`) — a real open endpoint, but generic park-facility
  closures rather than flags.
- **Swim Guide Indiana pages** (`theswimguide.org/beach/{id}`) — Nuxt SSR with literal
  `waterQuality:{description:...}` in raw HTML, but it is a mirror one hop from IDEM and needs a
  hardcoded numeric-ID table.
- **Barry-Eaton DHD** — parseable dated bulletins, but only 1 of 3 claimed beaches has entries,
  so absence is not a clear signal.
- **Kalamazoo County CivicAlerts** (`kalcounty.gov/m/newsflash?cat=9`) — server-rendered and
  stable, but event-only advisory posts inside general county news.

### Statewide/aggregator plays

- **Michigan EGLE BeachGuard / MiEnviro: hard scraping dead end** — see the SwimSmart
  partnership bullet under Data quality. Partnership is the only path, and it gates 70+ beaches.
- **Indiana IDEM BeachAlert** (`portal.idem.in.gov/BeachAlert`) — the natural Indiana statewide
  play, but not implementable: the Power Pages anonymous role is permission-denied and it sits
  behind Cloudflare Bot Management.
- The flag and closure integrations are hazard sources, the kind that may safely override the
  estimate. Statewide water-quality registries are the "clean → green masks a hazard" case, so
  they belong on the raise-only floor (`src/wqFloor/` plus rules step 7), where a source may
  raise a flag but never lower one.

### Dead ends (verified — do not re-investigate without new info)

- **EGLE MiEnviro / nSITE / ncore portals**, including legacy `egle.state.mi.us/beach/...` links
  that 301 into the same SPAs — no data in raw HTML, no public API in any shipped JS bundle.
- **Every Facebook page checked** (St. Clair Co. Beaches, Genesee/Isabella Co. Parks, Sanilac
  Co. HD, Marquette Park Gary, City of Marquette, East Tawas, Livingston Co. HD, Weko Beach,
  Ludington SP) — bot-blocked or an empty shell to both curl and a JS-rendering fetch, with no
  public JSON or RSS. Same for **x.com/chicagoparks**.
- **Ottawa County Beachwatch** — data sits inside a session-token-gated Power BI Embedded
  iframe, and the base page UA-filters bots.
- **Akamai/Cloudflare-blocked county sites** — Oakland Co. Health, Allegan Co. Health, Grosse
  Pointe Farms parks, PHSD Sudbury (CA).
- **Chicago per-beach facility pages** (widget broken sitewide, flag set client-side), **Chicago
  Socrata E. coli predictions** (`xvsz-3xcj`, program paused) and **automated sensors**
  (`qmqz-2xku`, frozen readings).
- **Swim Guide Michigan** — SSR is fine, but the upstream Michigan feed
  (`translate.theswimguide.org/michigan/json`) returns HTTP 500 and every MI beach shows "No
  Data Available".
- **NPS Indiana Dunes `status.htm`** — real raw-HTML alerts, but years-stale items rather than a
  maintained daily feed.
- **Program-description-only pages that defer to BeachGuard** — DHD2, DHD10, St. Clair Co.,
  Mid-Michigan DHD, Ingham Co., Muskegon Co. monitoring page, gtbay.org.
- **404s and no content** — MI DNR `dnrclosures` URL, michigandnr.com Pontiac Lake page,
  Chippewa Co. HD beach subpage, Mecosta Co. Parks, Manistee webcams (video only), USDA FS
  Hiawatha alerts (target beaches never named), MI DNR beach-safety page.

### Coverage math

Site capacity by registered scraper: South Haven ~9 sites, Metroparks 4, Chicago ~23. Within
the current Michigan-centric `REGIONS` coverage that translates to official hazard status for a
few dozen beaches in season; actual counts depend on per-beach resolution and each source's
staleness gates, and shrink off-season by design. The 70+-beach prize (Michigan EGLE BeachGuard)
remains partnership-gated.

## Free vs. paid Workers plan

- The cron subrequest budgets assume the Workers **Paid** plan (10,000 subrequests per
  invocation, no daily KV-write cap). The hourly `runFlagRecompute` runs alert, SRF and scraper
  fetches plus its `flag:`/`official:` KV writes, and does not fetch waves; the 6-hourly
  `runWaterTempRefresh` runs one Range-limited read per distinct station plus its `watertemp:`
  writes (PLAN.md section 7). The **Free** plan's 50-subrequest ceiling and 1000 KV-writes/day
  quota are not sufficient at this cadence and beach count. For a free-plan demo, drop
  `MAX_BEACHES_PER_RUN` well down and reduce cron frequency before deploying. Two further Free
  blockers arrived with the alerts refresh cron: a sub-hour Cron Trigger gets 10 ms of CPU on
  Free, and Free caps Cron Triggers at 5 per account, which this Worker now exceeds.

## Frontend

- **Wave-forecast strip: hour ticks are relative, not local time.** The detail page's 24 h
  strip labels its ticks "Now / +6 h / … / +N h" because D1 has no per-beach timezone column and
  the series is UTC-indexed. A progressive-enhancement inline script (pattern of
  `src/frontend/searchScript.js`) could rewrite the ticks to the viewer's browser-local clock
  with a "times shown in your local time" note.
- **Wave-forecast strip: no hover tooltips.** Chart.js tooltip callbacks are functions, which
  the slotted-JSON config cannot encode, and a slotted config shadows the element's `config`
  property, so the two cannot mix. If per-hour hover values are wanted: move the JSON to an
  adjacent `<script type="application/json" id=…>`, add a small `waveChartScript.js` that
  parses it, attaches callbacks and assigns `el.config` before upgrade. That trades away
  works-without-our-JS, which is why v1 ships `without-tooltip` plus `events: []`.
- **List-page pagination.** `GET /` renders at most the first 100 beaches
  (`ORDER BY COALESCE(park_name, name), name LIMIT 100`) with no pagination controls or `?page=`
  param; the server-side `?q=` search is the way to reach beaches past the cap. Real pagination
  is needed once nationwide scale-out lands. The homepage map is already the whole-directory
  view — it fetches every flag-worthy beach once from the cacheable `GET /api/beaches.geojson`,
  now a single KV read of the cron-built map directory rather than a full-table D1 scan plus
  `ceil(N/100) × 2` bulk KV gets, and renders them via native MapLibre clustering — and that
  single-fetch model is comfortable to roughly 5–10k features; beyond that the GeoJSON endpoint
  itself needs server-side clustering or tiling. Cross-reference, out of scope here: a browser-fetched static tiled
  artifact in the R2 bucket the layer build already writes would solve both this and the map's
  scale problem without the Worker ever touching R2. Such an artifact **must** be generated from
  D1, post-classification truth, and never from the OSM layers, or the map would show beaches
  the pipeline rejected as inland.

## Explicitly deferred by PLAN.md (not gaps, just out of scope for this pass)

- No ML/LLM-based estimation — the rules engine is intentionally a fully
  deterministic, versioned pure function (`src/rules.js`). Any future "smarter"
  estimation should be a new `rules_version`, not a replacement of this approach.
  The pure/deterministic contract is a design decision, not a limitation to lift.
