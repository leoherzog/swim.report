# TODO.md — Swim Report

Registry of LIVE known gaps, deliberate deferrals, and verified dead-ends, per
PLAN.md. Nothing below blocks the pilot; all of it is scoped for follow-up work.

## Data quality / coverage

- **Pond filter covers unnamed park beaches only.** The discovery sync drops
  unnamed park-contained beaches whose adjacent `natural=water` is all below
  ~4.5 ha bbox (`isPondBeach`). NAMED pond beaches (rows from the named-beach
  query) are deliberately untouched — someone mapping a name is treated as
  intent — and the named-beach query fetches no water context (`out center
  tags`, no bb). If named pond beaches turn out to be noise too, extend the
  water fetch to that query and apply the same `isPondBeach` test. Known
  residual of the ways-only water fetch (see PLAN.md §5): an unnamed beach on a
  relation-mapped INLAND lake (no coastline tagging) whose only nearby
  way-water is a small pond would be wrongly dropped — no confirmed real
  instance yet; if one shows up, the fix is a cheap water-relation membership
  probe, not reverting to `relation(around...)` (pathologically slow, >10 min
  server-side).
- **Flag-worthy water classification** (migration 0009, `src/waterClass.js`).
  Runs only in the offline GitHub Actions batch (`scripts/discovery-batch.js`,
  Deno). Each beach's adjacent water body is probed via Overpass (vertex
  recurse-down anchor at 150 m / 120 m, `out ids tags bb`) and classified
  ocean / great_lake / inland by the pure `classifyWaterBody` (Great Lakes
  matched by wikidata QID, never by name). Inland + parked rows are hidden by
  the shared `FLAG_WORTHY_WATER_SQL` gate on every consumer (never deleted);
  still-unclassified NULL rows stay visible during backfill. The offline
  discovery batch classifies its own new-beach delta synchronously and NULLs
  `water_class` when a re-discovered centroid moves > ~100 m. Open residuals:
  - **Node-only beaches** (`osm_id` = "node/N") have no polygon geometry, so
    only the point can be probed; a node set back from shore can miss (classify
    as parked/hidden). Accepted residual — most set-back beaches are
    ways/relations, which the vertex probe handles.
  - **Per-beach relation-`around` cost.** The lake-relation probe is scoped to
    one beach's vertices at 150 m with `[timeout:60]` at a small N/run; if it
    proves slow, the documented fallback is a recurse-**up** probe
    (`way[natural=water](around.a:150)` → `rel(bw)` → read their `wikidata`),
    which never loads full multipolygon geometry.
  - **Parked rows** sit at `WATER_CLASS_MAX_ATTEMPTS = 5` (matches the
    enrichment caps); revisit if parked counts climb. A version bump does NOT
    un-park empty-parked rows (adding a lake QID cannot rescue a beach that had
    no nearby water at all); if ever needed,
    `UPDATE beaches SET water_class_attempts = 0 WHERE water_class IS NULL`
    re-opens them.
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
  request (F14 clustering landed). Still open (F13 secondary, deliberately not done —
  scoped to the maintainer's `render.js`-only pass): request `include=...,urls` and
  deep-link each per-webcam caption to that cam's own detail page (`webcam.urls`)
  rather than the generic Windy webcams hub.
- **Threshold calibration against real flag history.** The `flag_history` table
  (migration 0006, PLAN.md sections 2 and 7) accumulates estimated-vs-official
  pairs for beaches with a scraped official flag (South Haven and Chicago
  publish true flag colors; the health-dept scrapers report water quality, a
  different signal). Once enough history exists, revisit the wave/wind
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
  query (nationwide tiles included) should keep this constraint — a row with no
  human-searchable name can't be displayed, searched, or trusted as a real swim
  spot. The excluded set is large (roughly three-quarters of US `natural=beach`
  elements are unnamed) and intentionally out of scope unless a future pass
  invents names from other containment/proximity signals (nearest named road
  end, `addr:*` tags, GNIS, etc.).
- **Beaches OSM simply hasn't mapped stay invisible.** Park containment only
  rescues beach polygons that exist. P.J. Hoffmaster State Park has a park
  polygon but no `natural=beach` element inside it, so it still doesn't appear.
  Fixing OSM is the fix.
- **Canadian beaches: alerts supported, no rip/surf signal.** Ontario shoreline
  beaches get Environment Canada alert coverage (ECCC zone enrichment cron + the
  hourly national GeoMet `weather-alerts` fetch matched per beach by
  alert-region polygon, `src/clients/eccc.js` — rules step 1b). But ECCC issues
  no rip current / high surf / beach hazards product, so Canadian estimates lean
  entirely on the curated warning set plus wave/wind — there is no step-2
  analog. Possible future refinements: the ECCC colour-coded tier
  (`risk_colour_en`) as a severity signal, the experimental
  `marineweather-realtime` GeoMet collection for lake marine warnings, and
  pairing with a Canadian official source (Windsor-Essex, below). **WARNING:**
  the "waterspout warning" / "storm surge warning" / "tornado warning" literal
  API strings are inferred from ECCC's product list but not yet observed live in
  `alert_name_en` (none observed live yet) — verify the exact strings when one
  fires; a mismatch fails safe (event ignored).
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
  water-body classification run in two independent GitHub Actions workflows that
  bulk-load D1 — see `docs/offline-discovery.md` for the full design. Live
  residual: Overpass runs on shared public mirrors, so the named query at
  `[timeout:90]` plus bounded per-tile backoff retries (3 attempts) is a
  mitigation, not a cure. The real fix for chronic public-Overpass 504 flakiness
  is a **self-hosted Overpass instance** (or a paid/reliable endpoint) so
  discovery no longer rides shared public infrastructure.
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
  `src/regions.js`.** Discovery tiles the `REGIONS` array in the offline batch
  (`TILE_MAX_SPAN_DEG = 2.0`), so scale-out is purely additive: append coastal
  bboxes to `REGIONS` (commented-out placeholders already stubbed at the bottom
  of the file) and the batch tiles them automatically. Adding a saltwater box
  also wakes the dormant `ocean` branch of the water classifier. **Invariant:**
  `MAX_BEACHES_PER_RUN = 1000` in `runFlagRecompute` must always cover the whole
  `beaches` table: any beach past the limit has its 2 h KV TTL expire between
  rotation turns and goes flagless, so growth past 1000 rows needs real
  pagination or multiple invocations (or a TTL/cadence change to match).

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
  health success) from `null` (genuine fetch/parse failure). metroparks,
  hdnw-michigan, and michigan-city comply; the others (wisconsin-dnr, bldhd,
  lenawee, south-haven, ohio-beachguard, chicago-park-district) still return
  `null` when they parse fine but no site survives their gates — rare in season,
  but off-season or stale-only data would log a false failure streak. Migrate
  them the same way.

## Official-source coverage

A multi-agent survey swept the web for official current-status sources covering
the pilot beaches. Full report: `docs/official-sources-research.md`; structured
verdicts (parse strategies, `matches()` sketches, render modes):
`docs/official-sources-verified.json`. Low-coverage candidates that were never
verified (mostly single-beach county pages) are in the workflow logs if coverage
gaps appear.

### Registered scrapers — live caveats

Nine scrapers are registered in `src/officialSources/index.js` (contract v2,
multi-site, one test file each). Caveats worth remembering per scraper:

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
- **Wisconsin DNR Beach Health ArcGIS layer** (`wisconsin-dnr`) — 441 statewide
  rows. Open/Advisory/Closed → green/yellow/red; Closed For Season / No Data /
  Other Status omitted; 21-day sample staleness gate. Proximity-only resolution
  (no names[] — generic statewide names like "North Beach" would mis-bind);
  mostly pays off when the bbox expands past the pilot. The slow ~34 s statewide
  query is now PRE-FETCH gated (F2): skipped entirely outside a wide May–October
  season and, in-season, run only at local hours [0, 6, 12, 18] (America/Chicago)
  rather than hourly — the color persists between fetches via `officialTtlSeconds`
  = 8 h. Its User-Agent is now self-identifying (no longer a spoofed Chrome UA).
- **Ohio ODH BeachGuard API** (`ohio-beachguard`) — 51 curated Lake Erie
  public-beach ids (one GET per id per scrape; the registry bulk endpoint omits
  monitorings/advisories, so per-id detail is required). In-season + zero current
  advisories → affirmative green (BeachGuard is Ohio's system of record);
  out-of-season → no data (a coarse Nov–Apr pre-fetch guard, `isOhioSeasonPossible`,
  now skips the whole ~51-request fan-out off-season, mirroring southHaven);
  `OHIO_MATCH_BBOX` hard-gates `matches()` so a
  same-named Michigan/Ontario beach can never inherit an Ohio flag. A few real
  public beaches carry 64-bit ids (Conneaut Sandbar, the Bay Point beaches, Yacht
  Port, Zeller's, Castaway) and are intentionally not yet covered (under-claim);
  add explicitly later. Minor UX gap: `HAB_WATCH_ADV` and `HAB_WARNING_ADV` share
  the typeText "Recreational Public Health Advisory", so `advisoryReason` renders
  them identically.
- **Health Dept of Northwest Michigan** (`hdnw-michigan`) — curated 32-beach
  name map (not a loose regex); WQI 1–4 → green/yellow/red/double-red; 8-day
  staleness gate. Hand-edited WYSIWYG markup remains the fragility risk; some
  aliases are generic (bounded by the four-county bbox).
- **Huron-Clinton Metroparks** (`huron-clinton-metroparks`) — closure-only
  (Closed → red, Open → no assertion); parsing strictly scoped to the
  Kensington/Stony Creek panel ids; name-only site resolution so an open sibling
  beach can't inherit its neighbor's red; Lake St. Clair Metropark excluded
  (defers to EGLE).
- **Benzie-Leelanau District Health Dept** (`bldhd-mi`) — Level 1–4 →
  green/yellow/red/double-red, mapped from BLDHD's own Water Quality Index legend
  (published in its weekly PDF press release). No live Level 2/3/4 has been
  observed yet, only Level 1 — documentary confirmation only. Levels outside 1–4
  are logged + omitted (never guessed); 8-day staleness gate.
- **Lenawee County Health Dept** (`lenawee-mi`) — "No Advisory Posted" → green.
  Active-advisory wording is still UNCONFIRMED (only "No Advisory Posted" seen
  live) — an unrecognized status logs the verbatim text with a greppable
  `lenawee: UNMAPPED STATUS` marker so production captures the real wording the
  first time an advisory posts; map it then (advisory → yellow or red per its
  meaning), never guessed. Shared Last-Updated staleness gate (10 days).
  (Michigan's statewide advisory wording also lives at the MiEnviro Beach Guard
  portal if a future direct-wording source is wanted.)
- **Michigan City IN parks page** (`michigan-city-in`) — page's own E. coli
  thresholds; hand-edited prose remains fragile (fails closed); weekday-only
  cadence tolerated up to 8 days; `updated` = reading date, so the UI stale
  warning fires by design.
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
- **Ontario Parks** (`ontarioparks.ca/beachresults`, CA) — fully static table,
  easier than the South Haven gold standard, but binary open/posted and
  Canadian.
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
- The built statewide integrations (Wisconsin DNR, Ohio BeachGuard, Chicago Park
  District) mostly pay off when `REGIONS` expands beyond Michigan — each is worth
  dozens of beaches at that point. Ohio's remaining registry ids (beyond the 51
  curated) need enumerating then.

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

Site capacity by scraper: South Haven ~9 sites, HDNW ~32, BLDHD 10, Metroparks 4,
Lenawee 2, Michigan City 2, Ohio BeachGuard 51, Chicago ~23, Wisconsin DNR 441
monitoring sites. Within the current Michigan-centric `REGIONS` coverage that
translates to official status for roughly 40–60 of ~613 DB beaches (~7–10%) in
season — actual counts depend on per-beach resolution (name/proximity) and each
source's staleness gates, and shrink off-season by design. Chicago's lakefront
and Wisconsin's Door County peninsula fall inside the covered regions already;
the rest of Wisconsin's 441 sites and Ohio's registry become disproportionately
valuable once the discovery regions expand past the pilot. The 70+-beach prize
(Michigan EGLE BeachGuard) remains partnership-gated — see
`docs/swimsmart-outreach-draft.md`.

## Free vs. paid Workers plan

- The cron subrequest budgets assume the Workers **Paid** plan (10,000
  subrequests/invocation, no daily KV-write cap). The hourly `runFlagRecompute`
  runs alert + SRF + scraper fetches plus up to ~700 `flag:`/`official:` KV
  writes (Ohio BeachGuard alone is 51 per-id GETs; it no longer fetches waves),
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
  beaches; needs real pagination (or a map-based `/api/beaches?bbox=` client
  view) once nationwide scale-out lands.

## Explicitly deferred by PLAN.md (not gaps, just out of scope for this pass)

- No ML/LLM-based estimation — the rules engine is intentionally a fully
  deterministic, versioned pure function (`src/rules.js`). Any future "smarter"
  estimation should be a new `rules_version`, not a replacement of this approach.
  The pure/deterministic contract is a design decision, not a limitation to lift.
