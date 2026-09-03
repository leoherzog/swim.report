# TODO.md — Swim Report

Registry of LIVE known gaps, deliberate deferrals, and verified dead-ends, per
PLAN.md. Nothing below blocks the pilot; all of it is scoped for follow-up work.

## Data quality / coverage

- **Pond filter covers unnamed park beaches only.** Discovery drops unnamed
  park-contained beaches whose adjacent `natural=water` is all below ~4.5 ha bbox
  (`isPondBeach`). NAMED pond beaches are deliberately untouched — someone mapping a
  name is treated as intent. If named pond beaches turn out to be noise too, apply
  the same `isPondBeach` test to them. Known residual of the WAYS-ONLY water
  evidence (see PLAN.md §5): an unnamed beach on a relation-mapped INLAND lake (no
  coastline tagging) whose only nearby way-water is a small pond would be wrongly
  dropped — no confirmed real instance yet. This is kept as-is only for parity with
  the pre-layers behaviour; the fix is now **cheap** (consult the lakes-polygon
  layer, a local lookup) rather than the pathologically slow `relation(around...)`
  query it used to imply. See the Scale-out section.
- **Flag-worthy water classification** (migration 0009, `src/waterClass.js`).
  Runs only in the offline GitHub Actions batch (`scripts/discovery-batch.js`,
  Deno). Each beach's adjacent water body is resolved by a **local spatial join**
  over the prebuilt FlatGeobuf layers (`src/layerSignals.js`), anchored on the same
  member vertices and at the same 150 m / 120 m radii the old remote probe used,
  and classified ocean / great_lake / inland by the pure `classifyWaterBody` (Great
  Lakes matched by wikidata QID, never by name). The join ALWAYS decides — a
  clean-but-empty result classifies `inland`, and there is no transient-failure
  mode left, so an unclassified row now means only "not in the layer set". Inland + parked rows are hidden by
  the shared `FLAG_WORTHY_WATER_SQL` gate on every consumer (never deleted);
  still-unclassified NULL rows stay visible (fail-open), which is why deciding on
  the first complete probe matters — a pending row is a published row. The offline
  discovery batch classifies its own new-beach delta synchronously and NULLs
  `water_class` when a re-discovered centroid moves > ~100 m. Open residuals:
  - **Node-only beaches** (`osm_id` = "node/N") have no polygon geometry, so
    only the point can be probed; a node set back from shore can miss (now
    classified inland/hidden rather than parked/hidden — same end state, one
    attempt instead of five). Accepted residual — most set-back beaches are
    ways/relations, which the vertex probe handles.
  - **Probe radii are the remaining lever for set-back beaches.** Now that a
    complete-but-empty probe DECIDES `inland` (instead of leaving the row pending
    and visible), a genuine Great Lakes beach whose polygon sits beyond
    `GREAT_LAKE_RADIUS_M` from any mapped shoreline is labeled inland on the first
    attempt. Its end state is unchanged (it parked hidden at the cap before), so
    this added no false negatives — but the fix for that whole class is widening
    the radii, NOT restoring a pending state. Note the asymmetry: ocean/great_lake
    probe at 150 m while inland probes at 120 m, so a beach whose only water sits
    in the 120–150 m band can be confirmed flag-worthy but never confirmed on
    inland water. Widening `INLAND_RADIUS_M` to 150 m would close it. **This is now
    ACTIONABLE rather than deferred**: the cost argument that parked it was the
    per-beach remote probe volume a re-drain implied, and a re-drain is now a
    `WATER_CLASS_VERSION` bump plus one local re-run that re-decides the whole table
    in seconds. It still changes stored decisions, so it needs the version bump, a
    measured before/after distribution, and a look at the classification flip rail
    (`CLASSIFY_MAX_HIDE_FLIPS` / `CLASSIFY_MAX_HIDE_FRACTION`) before it lands.
  - ~~**The fail-open window.**~~ **CLOSED by the layers migration.**
    Classification now runs in the SAME batch pass that discovers a beach, so the
    gap between a row appearing and being decided is zero, not ~1 h. The structural
    objection that kept this open — daily discovery injects new NULL rows forever,
    and the centroid-move reset re-NULLs existing ones — no longer holds, because
    the run that inserts or re-NULLs a row also decides it. Nothing needs hiding.
  - ~~**Per-beach relation-`around` cost.**~~ **CLOSED.** There is no remote
    relation probe any more; the lake join is a local segment-grid lookup.
  - **Parked rows** sit at `WATER_CLASS_MAX_ATTEMPTS = 5` (matches the
    enrichment caps). A version bump does NOT un-park them — `buildClassifyQueue`
    ANDs the version clause with `attempts < cap`, so no version value can reach a
    parked row (this bit an earlier diagnosis; the cap, not the version, is the
    gate). The ~409 rows the pre-decisive classifier parked are re-drained once by
    the `water_class_version IS NULL` legacy marker in `buildClassifyQueue`,
    deliberately WITHOUT resetting attempts so they stay hidden while they
    re-decide. Do NOT reach for
    `UPDATE beaches SET water_class_attempts = 0 WHERE water_class IS NULL` —
    it un-parks them into the fail-open gate and republishes every one as a
    visible beach with an estimated flag card until it drains. Under the decisive
    classifier nothing can newly reach the cap (only transient failures leave a row
    unclassified, and those never bump), so a rising parked count now means the
    classifier regressed to a pending state.
  - **Orphaned `flag_history` / `last_viewed`** for reclassified-inland beaches
    linger in D1 (their KV flags self-expire at the 7200 s TTL). Harmless and
    cheap — left in place.
  - **The `ocean` branch stays dormant** until `REGIONS` gains a saltwater box
    (Pacific / Gulf / Atlantic boxes stubbed in `src/regions.js`); in the
    current Great Lakes regions every keeper is a Great Lake (shorelines are
    relation member ways, not `natural=coastline`). Harmless: ocean and
    great_lake are both flag-worthy and pass the gate identically — only inland
    vs {ocean, great_lake} must be reliable, and it is.
- **GLCFS gridded wave source is still down.** The Great Lakes wave gap-fill
  (`fetchGlcfsWaveHeightsFt` in `src/clients/glerl.js`) uses nearest-GLOS-
  Seagull-buoy observations because the true gridded GLCFS source
  (erddap.axiomdatascience.com) is hard-down — 100% HTTP 502. If it recovers,
  true grid interpolation could replace nearest-buoy behind the same
  `fetchGlcfsWaveHeightsFt` export. Known limits of the buoy approach: coverage
  collapses in winter when GLOS pulls buoys (beaches then fall back to
  wind/unknown by design), and the meters unit for Seagull wave values rests on
  out-of-band research, not an in-band units field.
- **Windy webcam caveats** (`src/clients/windyWebcams.js`, daily
  `runWebcamSync`). (1) The Windy free tier publishes **no daily request
  quota** — 100 lookups/night is polite guesswork; watch the daily-run logs for
  429s. (2) The free-tier embed player **shows ads**; the ad-free tier is
  €9,990/yr, so ads stay. (3) "Nearest active cam within 5 km" is a proximity
  heuristic — the cam may face a marina, not the beach; the UI labels it
  "Nearby webcam" honestly, but a curated per-beach override column is the
  eventual fix if bad matches show up. (4) Cams flip between active/inactive; a
  beach keeps a stored player URL up to 14 days after its cam dies (the player
  page itself degrades gracefully). (5) The site-wide footer now carries Windy's
  required Terms credit and same-grid-cell due beaches share one bbox `/webcams`
  request (F14 clustering landed). (6) The F13-secondary **data** half is DONE, not
  open: both `/webcams` queries request `&include=player,location,urls`,
  `src/clients/windyWebcams.js` returns `detailUrl` (`urls.detail`, null when absent),
  migration 0011 added `beaches.webcam_detail_url`, and the daily cron writes it
  (`src/index.js` — set on a hit, NULLed on a miss).
  **OPEN DECISION (not pending work):** nothing READS `webcam_detail_url`. The
  render-side per-cam anchor shipped in `42c6a07` and was deliberately removed in
  `26e9051` when Windy attribution moved to the site-wide footer, so the column is
  written every night and never displayed. Two coherent resolutions — pick one, do
  not leave it as-is: (a) restore the per-caption deep link in `render.js` so each
  cam links its OWN Windy detail page, or (b) stop writing the column (drop it from
  the cron write and from the client's return shape) and let the footer credit stand
  alone. Note that migration `0011_webcam_detail_url.sql`'s stated rationale — the
  Windy Terms line "Link every image with either our webcam page or timelapse player
  for full view", to be satisfied by `renderWebcam`'s caption — is **currently unmet**:
  that caption link no longer exists. `src/clients/windyWebcams.js`'s header comment
  and migration 0011's comment both still describe the removed `renderWebcam`
  fallback. Whoever decides should confirm with Windy's current Terms whether the
  footer credit alone suffices.
- **Threshold calibration against real flag history.** The `flag_history` table
  (migration 0006, PLAN.md sections 2 and 7) accumulates estimated-vs-official
  pairs for beaches with a scraped official flag (South Haven, Chicago, the NWS
  GRR beach report, Winnetka, Presque Isle, and NWS Marine Beach Forecast publish
  official hazard colors; the raise-only wqFloor water-quality sources are NOT
  official and do not feed calibration — see the official-source coverage section).
  Once enough history exists, revisit the wave/wind
  thresholds in `src/rules.js` (2 ft / 4 ft wave, 15/25 mph wind, 25/35 mph
  gust) against how often the estimate matches the posted flag, and bump
  `RULES_VERSION` if thresholds move — cached `FlagEstimate` objects carry their
  own `rules_version`, so this is safe to do incrementally. Also revisit the
  flat 90-day retention window (`FLAG_HISTORY_RETENTION_DAYS = 90`) once
  calibration data collection is complete — a tighter policy or downsampling may
  fit better. The same pass should decide the multi-model derivation question:
  the flag currently uses the composite first-finite-model wave series, and the
  per-model data stored in the `waves:` KV payloads (`byModel`) exists precisely
  so mean / max / calibrated-blend alternatives can be evaluated retroactively
  against official flags. Note the safety asymmetry before reaching for a mean:
  averaging dilutes whichever model saw the hazard (a 4.5 ft + 2.5 ft
  disagreement averages to yellow, not red); any derivation change must ride a
  `RULES_VERSION`-style bump to keep calibration cohorts comparable.
- **Secondary unnamed park beaches need a derivable label to survive.**
  `mergeBeachRows` keeps a park's largest unnamed beach under the bare park
  name, and additional unnamed beaches only when `deriveUnnamedSuffix` finds a
  distinguishing label (the element's own `loc_name` tag, else a compass
  direction at ≥0.2 km separation); indistinguishable or coincident polygons
  still drop (logged `skipped_unnamed`). Follow-up: merge their geometries, or
  derive richer locality labels (a nearby named water feature, etc.).
- **Park association is bbox-overlap, not polygon containment.** The worker
  associates each beach to the smallest park whose bounding box overlaps the
  beach's (fetching full polygon geometry for ~9k parks nightly is not worth
  it). An L-shaped or diagonal park could claim an adjacent beach. Verified
  accurate on the pilot region's state parks; revisit if wrong pairings show up.
- **Only named beaches/parks are discoverable — by design, current and future
  queries.** Every discovery path requires a name somewhere: query 1 takes only
  named `natural=beach` / `leisure=beach_resort` elements, and query 2's park
  containment only rescues unnamed beaches inside a NAMED park polygon. An
  unnamed beach outside any named park never enters the dataset, and any future
  query (a nationwide layer set included) should keep this constraint — a row with no
  human-searchable name can't be displayed, searched, or trusted as a real swim
  spot. The excluded set is large (roughly three-quarters of US `natural=beach`
  elements are unnamed) and intentionally out of scope unless a future pass
  invents names from other containment/proximity signals (nearest named road
  end, `addr:*` tags, GNIS, etc.).
- **Beaches OSM simply hasn't mapped stay invisible.** Park containment only
  rescues beach polygons that exist. P.J. Hoffmaster State Park has a park
  polygon but no `natural=beach` element inside it, so it still doesn't appear.
  Fixing OSM is the fix.
- **Canadian beaches: alerts + marine warnings supported, no rip/surf signal.**
  Ontario shoreline beaches get Environment Canada land alert coverage (ECCC zone
  enrichment cron + the hourly national GeoMet `weather-alerts` fetch matched per
  beach by alert-region polygon, `src/clients/eccc.js` — rules step 1b) AND marine
  warnings (the `marineweather-realtime` GeoMet collection, `src/clients/ecccMarine.js`,
  matched per beach by marine-zone polygon and concatenated into the same alerts
  list — Storm/Gale Warning short-circuit, Strong Wind Warning / Marine Weather
  Advisory as a yellow floor at step 6b). But ECCC issues no rip current / high surf /
  beach hazards product, so Canadian estimates still have no step-2 rip analog and
  lean on the curated warning set plus wave/wind. Possible future refinements: the
  ECCC colour-coded tier (`risk_colour_en`) as a severity signal, and pairing with a
  Canadian official source. **WARNING:** several land warning literal API strings
  ("waterspout warning" / "storm surge warning" / "tornado warning") are inferred
  from ECCC's product list but not yet observed live in `alert_name_en` — verify the
  exact strings when one fires; a mismatch fails safe (event ignored). The marine
  event names (`storm warning` / `gale warning` / `strong wind warning` / `marine
  weather advisory`) are lowercased from the live `marineweather-realtime` payload.
- **ECCC zone enrichment: consider a conservative shoreline-nearest fallback.**
  `runEcccEnrichment` now does one bulk `fetchEcccForecastZones()` polygon fetch per run +
  local exact point-in-polygon (`ecccZoneNameForPoint`). A beach centroid that sits just
  OFFSHORE of its forecast-region polygon (a shoreline point nudged into the lake) resolves
  to null and parks, exactly like a US point. A conservative nearest-region-within-a-small-
  distance fallback could rescue those centroids — deliberately NOT implemented now to avoid
  a wrong region assignment; revisit if parked-Canadian counts climb.
- **SwimSmart / Michigan DNR partnership outreach.** Michigan's SwimSmart
  program and DNR-managed state park beaches are the ONLY path to Michigan's
  statewide official data: every EGLE BeachGuard/MiEnviro access route is a
  React/Angular SPA shell with no beach data in raw HTML and no discoverable
  unauthenticated API in the shipped JS bundles, and a dozen-plus county health
  pages just defer to it. The partnership gates ~70+ beaches' worth of official
  data. A ready-to-send outreach email draft lives at
  `docs/swimsmart-outreach-draft.md` — send it.

## Scale-out

- **Offline discovery + classification (live residuals).** Discovery and
  water-body classification run in one daily GitHub Actions workflow that scans a
  prebuilt FlatGeobuf layer set and bulk-loads D1, over layers a second workflow
  builds twice weekly from the Geofabrik OSM extracts — see
  `docs/offline-discovery.md` for the full design. The old residual here (chronic
  public-mirror 504 flakiness, and a self-hosted query instance as the real fix) is
  **CLOSED**: there is no query API in the pipeline at all. The NEW residuals are
  different in kind:
  - **Freshness is now the extract cadence, not minutes.** A beach mapped in OSM
    today appears after the next twice-weekly build, and `MAX_SOURCE_AGE_DAYS = 21`
    is a hard refusal, not a warning. For a directory of beaches this is the right
    trade, but it is a real regression in latency and should be stated plainly
    rather than discovered.
  - **The dangerous failure is a SUCCESSFUL build of a WRONG layer set** — a
    clip-mask bug, a short parks layer, an `ogr2ogr` node-index exhaustion that
    returns empty with exit status 0. These are quiet in a way a 504 never was. The
    defenses are the absolute floors in `data/layer-floors.json`, the previous-build
    ratio checks, the manifest's three-tier gate, the two proportional delete rails
    and the classification flip rail. Every one of those numbers was calibrated
    against a 1669-row table; re-derive them when the table changes scale.
  - **Layer-set size at North America scale.** The published set is O(beaches)
    because of the ~1.1 km proximity clip, but the pre-clip intermediate is not, and
    the build's peak disk (~13.3 GB) sits inside a runner's budget with less headroom
    than is comfortable. Measure before adding coasts.
  - **`beaches-line` and `water-line` may be droppable.** Both are carried because
    the first build had not yet reported their counts; if they turn out to
    contribute nothing to discovery or classification, dropping them shrinks the set
    and the download. Decide from a real build's manifest, not from reasoning.
  - **Retire the vestigial classification columns.** `water_class_attempts` can no
    longer be bumped by anything, and `parkedPreDecisive` / the attempts cap in
    `buildClassifyQueue` exist only for rows parked before this migration. Once a
    run reports zero such rows, delete the cap, the marker and (in a migration) the
    column.
  - **The relation-mapped-inland-lake pond filter is now cheap to fix.** The
    known-correct-but-narrow residual at the top of this file (ways-only water
    evidence, kept for parity with the old query) can be closed by consulting the
    lakes-polygon layer directly — a local lookup, not a new upstream probe. Kept as
    is for now only to avoid changing discovery output in the same change that
    changed its transport.
- **Every `deno` step in every workflow must set `DENO_NO_PACKAGE_JSON=1`.** The
  repo-root `deno.lock` is auto-discovered for all Deno commands here; without that env
  var Deno folds `package.json`'s npm tree into the lockfile it expects, `deno check
  --frozen` fails with "The lockfile is out of date", and a plain `deno run` silently
  REWRITES the checked-in lock. The npm scripts already set it. Do not "fix" this by
  regenerating the lock without the env var — that trades a loud failure for a silent
  drift in the only delete-bearing job in the repo.
- **Demand-priority recompute rotation — mechanism landed, cold-tier tuning
  deferred.** The request path stamps `beaches.last_viewed` (migration 0007;
  detail page + `/api/flag`, throttled to 1/h per beach, `ctx.waitUntil`), and
  it now has real consumers: `runFlagRecompute`/`runWaveRefresh` split their
  rotation into a hot tier (`last_viewed` within `HOT_VIEW_WINDOW_MS`, 7 days —
  always fully covered every run) and a cold tier that rotates through the
  remaining `MAX_BEACHES_PER_RUN` budget on the existing
  `recompute_updated`-oldest-first order; `runNwsEnrichment`/
  `runEcccEnrichment`/`runWebcamSync` add `last_viewed DESC NULLS LAST` as a
  tiebreak in their candidate queues so a viewed beach's enrichment/recheck gap
  fills before an equally-eligible never-viewed one's. At pilot scale both tiers
  still fit inside one run, so the split is a no-op in practice today; it only
  starts mattering once beach count approaches `MAX_BEACHES_PER_RUN`. Deferred
  residue: (1) a longer KV TTL for the cold tier specifically, so a cold beach's
  flag doesn't expire to "no data" every time it misses a rotation turn once hot
  and cold no longer both fit in one run; (2) stamping `last_viewed` from the
  home list view too (currently only the two single-beach routes stamp it, so a
  beach that's only ever seen on the list page never reads as hot); (3) a real
  split-query implementation (today's is a single ORDER BY guard, not two
  separate queries) plus the migration 0012-class indexes real pagination will
  need at nationwide scale; (4) real pagination itself. Caveat unchanged:
  Workers Cache means cache HITs don't run the Worker, so `last_viewed`
  undercounts popular beaches slightly (stamps land on misses/revalidations
  only) — fine for a coarse priority signal.
- **Alerts-only fast cron (not yet built).** A `*/10`-ish alerts-only cron — NWS
  alerts are the one event-driven input; a High Surf Warning issued at :05
  currently waits up to 55 min for the hourly recompute. Since alerts are a
  single national fetch matched to beaches locally, such a cron would cost just
  ONE `api.weather.gov/alerts/active` fetch per run (plus one ECCC national fetch
  if Canadian beaches are included), regardless of zone count. A separate
  queue-based stale-refresh (request path enqueues, consumer fetches) only if
  flagless gaps show up in practice.
- **Open-Meteo daily weighted-call budget (accounting landed, throttle deferred).**
  Open-Meteo's free tier caps at **10,000 weighted calls/day**, and a batched
  multi-location request is weighted by its location count (a 100-coordinate batch ≈ 100
  weighted calls), so HTTP-level batching saves connections but NOT daily quota.
  `runWaveRefresh` now LOGS a per-run weighted-call estimate (via `batchByBeach`'s return
  value, counting each attempt including the one backoff retry) against
  `OPEN_METEO_DAILY_WEIGHTED_CEILING = 10000` — visibility only, no behavioral throttling
  on the DAILY budget yet (existing pacing guards only the per-MINUTE limit). Today a full
  run stays well under the ceiling, but it **binds first** — before the Workers subrequest
  limit — once nationwide pagination removes the `MAX_BEACHES_PER_RUN = 1000` cap (the
  pagination item above). Add a real per-day cap/throttle (or cap the wind-fallback
  location set per day, or reduce from 4 runs/day given the 6–12 h marine model cadence)
  BEFORE pagination ships.
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
  wakes the dormant `ocean` branch of the water classifier. Two blockers remain,
  and the first is **already violated in production today**:
  - **`MAX_BEACHES_PER_RUN = 1200`** (`src/index.js`) must always cover the whole
    `beaches` table: any beach past the limit has its 2 h KV TTL expire between
    rotation turns and goes flagless. **The table is already 1669 rows.** This is a
    live gap right now, not a future NA blocker — the hot/cold demand-priority
    rotation mitigates it (a beach in active demand is always covered) but does not
    close it. Growth needs real pagination or multiple invocations, or a
    TTL/cadence change to match. Note the Open-Meteo daily weighted-call ceiling
    binds here too (see README).
  - **The D1 `--json` snapshot is size-capped and single-shot**, and the
    delete-bearing snapshot just widened from 7 to 11 columns (discovery and
    classification now share one). A truncated snapshot aborts the only delete path
    there is. A **paginated snapshot is required before NA**, not after.

## Official-scraper fragility

- All scrapers parse third-party pages/APIs that can change without notice.
  Every parser degrades to `null` (never a guessed color) on unexpected markup,
  and health monitoring surfaces a scraper that goes quiet — but a source that
  changes *semantics* while staying parseable (e.g. repurposing a status string)
  would still need a human to notice. Re-verify sources occasionally.
- **Scraper health alerting is log-only.** `src/scraperHealth.js` logs a LOUD
  `ALERT:` line once a matched scraper has returned null for 24 consecutive
  hourly runs, but nothing pages a human — wiring the alert to email/push is a
  possible follow-up.
- **Not every scraper implements empty-success yet.** The contract (PLAN.md §6)
  distinguishes "parsed cleanly, nothing to report" (empty `sites: []` result, a
  health success) from `null` (genuine fetch/parse failure). metroparks complies;
  south-haven and chicago-park-district still return
  `null` when they parse fine but no site survives their gates — rare in season,
  but off-season or stale-only data would log a false failure streak. Migrate
  them the same way.
- **Deferred: tier-2 HTML entity-decoder consolidation.** `decodeCellText` now lives
  in `src/officialSources/util.js` and the two byte-identical copies
  (`greyBruceRecWater.js`, `ontarioParksBeachPostings.js`) were folded into it. Five
  near-variants were deliberately LEFT ALONE: `kenoshaBeachConditions.js` `htmlToText`,
  `paDcnrPresqueIsle.js` `htmlToText`, `chautauquaCountyNy.js` `htmlToPlainText`,
  `evanstonStatusfy.js` `stripTags` and `lakeCountyOhBeaches.js` `stripTags`. Folding
  them into a union decoder is **behavior-changing**, not a cleanup: evanston and
  lakeCountyOh strip *full-page* HTML into a bounded character window (400 / 600 chars)
  that GATES a red and a yellow floor, and decoding one more entity demonstrably changes
  whether a floor is raised (`prediction&mdash;poor` currently fails
  `lakeCountyOhBeaches`'s regex and raises NO floor; under a union decoder it would match
  and raise yellow). Both test suites use entity-free synthetic fixtures, so a green run
  proves nothing — this needs real captured page samples and its own reviewed commit.
  `erieCountyPaKml.js` `decodeAndStrip` is PERMANENTLY excluded from any such
  consolidation: it decodes `&amp;` LAST on purpose (decoding it first would
  double-decode) and it unwraps CDATA.

## Official-source coverage

A multi-agent survey swept the web for official current-status sources covering
the pilot beaches. Full report: `docs/official-sources-research.md`; structured
verdicts (parse strategies, `matches()` sketches, render modes):
`docs/official-sources-verified.json`. Low-coverage candidates that were never
verified (mostly single-beach county pages) are in the workflow logs if coverage
gaps appear.

### Newly integrated sources (shipped) + human-verify follow-ups

A batch of new data sources landed across three registries. **Official HAZARD
scrapers** (`src/officialSources/`, may override the estimate): `nws-omr-grr`,
`winnetka-tower-beach`, `pa-dcnr-presque-isle`, `nws-marine-beach-forecast`.
**Raise-only water-quality FLOOR sources** (`src/wqFloor/`, may only lift a flag,
never lower it — see README "Water-quality advisory floor"). Registered:
`ny-oprhp-beach-status`, `lake-county-oh-beaches`, `kenosha-beach-conditions`,
`mn-beaches`, `grey-bruce-rec-water`, `ontario-parks-beach-postings`,
`evanston-statusfy`, `usgs-great-lakes-nowcast`. Authored and tested but
**deliberately NOT registered** (see the follow-up below): `chautauqua-county-ny`,
`erie-county-pa-kml`, `illinois-beachguard`.
**Supplemental fallback wave sources** (`src/waveSources/`, wave-height only, used
only where Open-Meteo + GLOS are null): `nws-gridpoint-waves`, `nws-nsh-nearshore`,
`uw-sea-caves-watch`, `toronto-beach-obs`, `ndbc-buoys`. **ECCC marine warnings**
(`src/clients/ecccMarine.js`) are wired into the Canadian alert path (rules step
1b/6b). Nothing was punted — every surveyed source above is authored; three wqFloor
sources are held OUT of the registry pending gate confirmation (see the follow-up
below).

Follow-ups a human must verify (parsers fail safe to `null`/no-effect, so these are
coverage gaps, not wrong-color risks):

- **`erie-county-pa-kml` KML URL is UNCONFIRMED** — the module ships with an empty
  `ERIE_COUNTY_PA_KML_URL`, so it fails closed (resolves to null, no floor) before
  fetching. It is therefore **unregistered** pending URL confirmation and is not
  consulted at all on a run — see the next bullet for why, and for how to re-insert
  it safely. Several other wqFloor source URLs are best-effort and should be
  re-verified live before their coverage is relied on; `grey-bruce-rec-water` is
  flagged low-confidence in its own header.
- **Three wqFloor sources are authored, tested, and DELIBERATELY UNREGISTERED** —
  `chautauqua-county-ny` and `erie-county-pa-kml` (fetch URL still `""`) and
  `illinois-beachguard` (`ILLINOIS_BEACHGUARD_CONFIRMED === false`, placeholder
  BeachIDs). All three fail closed before fetching, so they stayed permanently inert
  while sitting AHEAD of working sources in the first-match-wins `wqFloorSources`
  registry — and because the cron resolves exactly ONE source per beach, an inert
  source silently SUPPRESSED the working source behind it: `erie-county-pa-kml`'s
  `ERIE_BOX` is strictly inside `usgs-great-lakes-nowcast`'s region bbox, and
  `illinois-beachguard`'s box overlaps `kenosha-beach-conditions` coverage around
  lat 42.517–42.55. The modules remain on disk with their full test suites.
  **WHEN A GATE IS CONFIRMED**, re-insert that source into `wqFloorSources` in
  `src/wqFloor/index.js` **ABOVE** `usgsGreatLakesNowcast` — and, for
  `illinois-beachguard`, also ABOVE `kenoshaBeachConditions` — never below, or it
  will shadow nothing and be shadowed itself. Unregistering them restored real
  coverage: Erie County PA / Presque Isle beaches now reach USGS Great Lakes
  NowCast, beaches around lat 42.517–42.55 near lon −87.79 now reach Kenosha
  County WI, and the four curated Chautauqua County NY named beaches now fall
  through to whichever registered source claims them (NY OPRHP first, else
  NowCast's coarse Lake Erie/Ontario bbox). If any doc still says these areas
  have no water-quality coverage, it is out of date.
- **`nws-marine-beach-forecast` ArcGIS layer enumeration** — only layers verified
  live (CLE = 19, BUF = 7, Lake Erie/Ontario) are enabled. Enumerate the MapServer
  for additional Great Lakes Day-1 layers (e.g. other WFOs) and enable each ONLY
  after confirming it returns features live — a wrong layer id silently yields no
  features (safe-fail).
- **`pa-dcnr-presque-isle` hazard-keyword mapping is PROVISIONAL** — the live DCNR
  advisory feed is currently 100% off-axis boilerplate, so the swimming-hazard →
  red mapping is verified only against synthetic fixtures. Re-verify against a real
  Danger-tier swimming-hazard advisory when one appears.
- **`winnetka-tower-beach` `staleMs` rests on a single-day sample** — its 72 h
  staleness horizon is reasoned from one observation of the rainoutline page (all four
  Winnetka beach extensions stamped in one 7/21/26 4:43-4:46 pm human batch, still
  unchanged and still accurate ~29 h later; dormant extensions holding 2019-2021
  stamps prove there is no auto-refresh), plus the ~63 h Friday-post/Monday-read
  weekend bound — not a measured distribution. Re-verify the real in-season posting
  cadence; if genuine holds routinely run longer, raise the horizon rather than
  leaving false stale warnings in place. Note also that a `staleMs` that never trips
  makes a silently-dead source indistinguishable from a healthy one — the
  `scraperhealth:` counter, not the horizon, is what catches that.
- **Widen the NDBC wave set** — the 2026-09-02 station audit found 40 stations within 60 km
  of a served beach reporting a fresh WVHT, of which 36 are not among the ten `CAP_WAVES`
  ids. They were deliberately left wave-ineligible: wave height feeds `src/rules.js`, so
  admitting them moves flag colors and needs a `RULES_VERSION` discussion plus a review of
  how each new platform's readings compare with the Open-Meteo/GLOS values it would be
  filling in for. The capability table in `src/waveSources/ndbcBuoys.js` makes the change
  itself a one-word edit per row; the analysis is the work.
- **Water-temp coverage is 47%, and 14% in winter** — 519 of 1102 beaches have a
  `CAP_WATER_TEMP` station inside the 25 km cap, falling to ~153 when the seasonal buoys are
  pulled and only the 15 year-round NOS gauges remain. The gap is a real sensor-density
  limit on the Great Lakes, not a list problem: even at a 75 km cap winter coverage only
  reaches ~36%. GLOS Seagull (already integrated in `src/clients/glerl.js` for waves) exposes
  `sea_water_temperature` on a denser network and is the obvious next source; it would need
  the same siting review this list got.
- **Station-list rot has no trip-wire** — station 45161 (Muskegon) went off-air 2026-08-18
  and nothing noticed; it was found by hand. The 12 h freshness window correctly degrades a
  dark station to null, which is exactly why the failure is invisible. Step 3b knows, per
  run, how many unique stations it consulted and how many returned a reading, so logging
  `stations=<n> live=<n>` would make a station family going dark visible in the observability
  query without anyone auditing anything.
- **NDBC-vs-GLOS double-count audit** — `ndbc-buoys` is the first NDBC ingestion and
  is a *fallback* consulted only for beaches still wave-null after Open-Meteo + the
  GLOS/GLERL buoy pass, so it is by design non-additive. Audit that no NDBC buoy is
  double-counting a beach the GLOS Seagull pass already covers (the ordered
  registry breaks on the first finite reading, but confirm the GLOS pass runs first
  and the wave-null set is recomputed between passes).

### Registered scrapers — live caveats

Three scrapers are registered in `src/officialSources/index.js` (contract v2,
multi-site, one test file each) — hazard/flag/closure sources only. An official
color OVERRIDES the estimate wherever shown, so water-quality (E. coli / bacteria)
sources are deliberately excluded: a clean-water "green" is a different axis from
surf hazard and would mask a genuine hazard estimate (e.g. a gale-driven red).
Six water-quality scrapers were REMOVED for this reason (`lenawee-mi`,
`michigan-city-in`, `ohio-beachguard`, `hdnw-michigan`, `bldhd-mi`,
`wisconsin-dnr`) — modules, tests, and doc entries deleted. Do not re-add a source
whose "clean" reading would downgrade a hazard flag. Caveats for the survivors:

- **South Haven CSV** (`south-haven-mi`) — real flag colors, ~9 sites. CSV URL
  is re-discovered from the flag page each run (hardcoded fallback); Gray =
  unmonitored → no data; colored output is gated to the monitored season/hours
  (America/Detroit); same-named flag poles roll up to most severe (double-red
  recognized as the top tier).
- **Chicago Park District `/flag-status` JSON** (`chicago-park-district`) — ~23
  lakefront beaches, real flags. Payload mixes in stale prior-season rows — the
  36 h per-record staleness gate is load-bearing, and GREEN additionally
  requires the beach's own Surf row to be fresh; "Afterhours" → red
  (lifeguards-off closure, noted in reason). Undocumented/unversioned API;
  off-season behavior still unverified.
- **Huron-Clinton Metroparks** (`huron-clinton-metroparks`) — closure-only
  (Closed → red, Open → no assertion); parsing strictly scoped to the
  Kensington/Stony Creek panel ids; name-only site resolution so an open sibling
  beach can't inherit its neighbor's red; Lake St. Clair Metropark excluded
  (defers to EGLE).
- **Windsor-Essex County Health Unit** (`wechu.org/beaches/beach-water-testing`,
  Ontario) — NOT built (US focus; Canadian beaches lack NWS enrichment anyway).
  Still the most feasible CA source when that becomes relevant.

### Tier 2 — worth building, with caveats

- **Algoma Public Health** (CA) — status is inline plain-text JS in raw HTML,
  but match by lat/lon proximity, not name ("Old Mill Beach" appears twice at
  different locations; 3 of 5 claimed names never appear on the page).
- **City of Muskegon WP REST feed**
  (`muskegon-mi.gov/wp-json/wp/v2/posts?categories=8`) — clean JSON but
  event-only press releases: absence of a post is NOT an affirmative all-clear.
- **Grand Traverse County** (`gtcountymi.gov/814`) — static + dated, but only 5
  claimed beach names appear and entries aggregate ("four beaches Level 2...");
  only the unambiguous "all GTC beaches Level 1" case is trustworthy.
- **Michigan DNR closures feed** (Sitecore search JSON behind
  `michigan.gov/dnr/about/newsroom/closures`) — real open endpoint but generic
  park-facility closures, not flags; sparse "day-use closed" override at best.
- **Swim Guide Indiana pages** (`theswimguide.org/beach/{id}`) — Nuxt SSR with
  literal `waterQuality:{description:...}` in raw HTML, but it's a mirror one hop
  from IDEM and needs a hardcoded numeric-ID table.
- **Ontario Parks** (`ontarioparks.ca/beachresults`, CA) — NOW SHIPPED as the
  `ontario-parks-beach-postings` raise-only wqFloor source (binary posted/open, so
  a posting raises the floor; open is no-effect).
- **Barry-Eaton DHD** — parseable dated bulletins, but only 1 of 3 claimed
  beaches has entries; absence isn't a clear signal.
- **Kalamazoo County CivicAlerts** (`kalcounty.gov/m/newsflash?cat=9`) —
  server-rendered, stable DOM, but event-only advisory posts inside general
  county news; zero current entries mid-season.

### Statewide/aggregator plays

- **Michigan EGLE BeachGuard / MiEnviro: hard scraping dead end** (see the
  SwimSmart partnership bullet under Data quality — partnership is the only path;
  it gates 70+ beaches).
- **Indiana IDEM BeachAlert** (`portal.idem.in.gov/BeachAlert`) — the natural IN
  statewide play but NOT implementable: Power Pages anonymous role is
  permission-denied and it sits behind Cloudflare Bot Management.
- The flag/closure integrations (South Haven, Huron-Clinton Metroparks, Chicago
  Park District, NWS GRR beach report, Winnetka, Presque Isle, NWS Marine Beach
  Forecast) are hazard sources — the kind that may safely override the estimate.
  The statewide water-quality registries that were removed as *overrides* (Wisconsin
  DNR, Ohio BeachGuard) are exactly the "clean → green masks a hazard" case — and the
  raise-only floor anticipated here is now BUILT (`src/wqFloor/` + rules step 7): a
  water-quality source may RAISE a flag but never lower one, so bacteria/HAB feeds
  (Illinois BeachGuard, Lake County OH, and the rest of the wqFloor registry) are
  now admissible on that basis. Illinois BeachGuard shipped as `illinois-beachguard`
  — authored and tested, but currently held OUT of the registry pending BeachID
  confirmation (see the unregistered-sources follow-up above); a reworked
  Ohio/Wisconsin floor source could be added the same way.

### Dead ends (verified — don't re-investigate without new info)

- **EGLE MiEnviro / nSITE / ncore portals** (+ legacy `egle.state.mi.us/beach/...`
  links, which 301 into the same SPAs) — no data in raw HTML, no public API in
  any shipped JS bundle, repeated attempts.
- **Every Facebook page checked** (St. Clair Co. Beaches, Genesee/Isabella Co.
  Parks, Sanilac Co. HD, Marquette Park Gary, City of Marquette, East Tawas,
  Livingston Co. HD, Weko Beach, Ludington SP) — bot-blocked or empty shell to
  both curl and JS-rendering fetch; no public JSON/RSS exists. Same for
  **x.com/chicagoparks**.
- **Ottawa County Beachwatch** — data is inside a session-token-gated Power BI
  Embedded iframe; base page also UA-filters bots.
- **Akamai/Cloudflare-blocked county sites** — Oakland Co. Health, Allegan Co.
  Health, Grosse Pointe Farms parks (522/403), PHSD Sudbury (CA).
- **Chicago per-beach facility pages** (widget broken sitewide, flag set
  client-side), **Chicago Socrata E. coli predictions** (`xvsz-3xcj`, zero 2026
  rows — program paused) and **automated sensors** (`qmqz-2xku`, frozen at March
  2025 readings).
- **Swim Guide Michigan** — SSR is fine but the upstream Michigan feed
  (`translate.theswimguide.org/michigan/json`) returns HTTP 500 and every MI
  beach shows "No Data Available"; broken platform-wide.
- **NPS Indiana Dunes `status.htm`** — real raw-HTML alerts but years-stale
  (2021 "until further notice" items); not a maintained daily feed.
- **Program-description-only pages that defer to BeachGuard** — DHD2, DHD10,
  St. Clair Co., Mid-Michigan DHD, Ingham Co., Muskegon Co. monitoring page,
  gtbay.org (pure link farm).
- **404s / no content** — MI DNR `dnrclosures` URL, michigandnr.com Pontiac Lake
  page, Chippewa Co. HD beach subpage (full sitemap sweep: no beach content),
  Mecosta Co. Parks (static Weebly), Manistee webcams (video only), USDA FS
  Hiawatha alerts (target beaches never named), MI DNR beach-safety page (legend
  images + `javascript:void(0)` park links).

### Coverage math

Site capacity by registered scraper: South Haven ~9 sites, Metroparks 4,
Chicago ~23. Within the current Michigan-centric `REGIONS` coverage that
translates to official (hazard/flag) status for a few dozen of ~613 DB beaches in
season — actual counts depend on per-beach resolution (name/proximity) and each
source's staleness gates, and shrink off-season by design. (The six removed
water-quality scrapers previously added ~90 monitored sites of E. coli status,
but that is a different signal from hazard flags and was masking hazard estimates
where it overrode them.) The 70+-beach prize (Michigan EGLE BeachGuard) remains
partnership-gated — see `docs/swimsmart-outreach-draft.md`.

## Free vs. paid Workers plan

- The cron subrequest budgets assume the Workers **Paid** plan (10,000
  subrequests/invocation, no daily KV-write cap). The hourly `runFlagRecompute`
  runs alert + SRF + scraper fetches plus up to ~700 `flag:`/`official:` KV
  writes (it no longer fetches waves),
  and the 6-hourly `runWaveRefresh` runs the paced Open-Meteo marine + GLOS buoy
  + wind fetches plus up to ~1200 `waveinput:`/`waves:` KV writes (per PLAN.md
  section 7). The **Free** plan's 50-subrequest ceiling and 1000 KV-writes/day
  quota are not sufficient at this cadence and beach count. For a free-plan demo,
  drop `MAX_BEACHES_PER_RUN` way down (e.g. 10-15 beaches) and/or reduce cron
  frequency before deploying without a paid plan.

## Frontend

- **Wave-forecast strip: hour ticks are relative, not local time.** The detail
  page's 24 h wave strip labels its ticks "Now / +6 h / … / +N h" because D1 has
  no per-beach timezone column and the series is UTC-indexed. A small
  progressive-enhancement inline script (pattern of `src/frontend/searchScript.js`)
  could rewrite the ticks to the *viewer's* browser-local clock time with a
  "times shown in your local time" note. Deferred from the initial build.
- **Wave-forecast strip: no hover tooltips.** Chart.js tooltip callbacks are
  functions, which the slotted-JSON config can't encode (and a slotted config
  shadows the element's `config` property, so the two can't mix). If per-hour
  hover values are wanted: move the JSON to an adjacent
  `<script type="application/json" id=…>`, add a small `waveChartScript.js` that
  parses it, attaches callbacks, and assigns `el.config` before upgrade. Trades
  away works-without-our-JS, which is why v1 ships `without-tooltip` +
  `events: []` instead.
- **List-page pagination.** `GET /` renders at most the first 100 beaches
  (`ORDER BY COALESCE(park_name, name), name LIMIT 100`) with no pagination
  controls or `?page=` param (the server-side `?q=` search is the way to reach
  beaches past the cap). Fine while the pilot region has well under 100 named
  beaches; needs real pagination once nationwide scale-out lands. (The homepage
  map is already the whole-directory view: it fetches every flag-worthy beach
  once from the cacheable `GET /api/beaches.geojson` and renders them via native
  MapLibre clustering — no per-viewport paging. That single-fetch model is
  comfortable to ~5–10k features; beyond that the GeoJSON endpoint itself needs
  server-side clustering / tiling before the 10k–100k North America target.)
  Cross-reference, out of scope here: a browser-fetched static tiled artifact in the
  same R2 bucket the layer build already writes would solve both this and the map's
  scale problem without the Worker ever touching R2. But such an artifact MUST be
  generated **from D1** — post-classification truth — and never from the OSM layers,
  or the map would show beaches the pipeline rejected as inland.

## Explicitly deferred by PLAN.md (not gaps, just out of scope for this pass)

- No ML/LLM-based estimation — the rules engine is intentionally a fully
  deterministic, versioned pure function (`src/rules.js`). Any future "smarter"
  estimation should be a new `rules_version`, not a replacement of this approach.
  The pure/deterministic contract is a design decision, not a limitation to lift.
