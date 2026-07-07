# TODO.md — Swim Report

Known gaps and deliberate deferrals, per PLAN.md. Nothing below blocks the pilot; all
of it is scoped for follow-up work.

## Data quality / coverage

- **DONE 2026-07-05 — Great Lakes wave gap-fill shipped** (`src/clients/glerl.js`,
  wired in as `runFlagRecompute` step 5b): beaches Open-Meteo leaves wave-null get
  the nearest GLOS Seagull wave buoy observation (25 km cap, 2 h freshness window,
  one deduped obs fetch per buoy, ≤62 subrequests). Follow-ups: the true gridded
  GLCFS source (erddap.axiomdatascience.com) was hard-down (100% HTTP 502) when
  built — if it recovers, true grid interpolation could replace nearest-buoy
  behind the same `fetchGlcfsWaveHeightsFt` export; buoy coverage collapses in
  winter when GLOS pulls buoys (beaches then fall back to wind/unknown by design);
  the meters unit for Seagull wave values rests on out-of-band research, not an
  in-band units field.
- **Windy webcam hydration caveats** (shipped 2026-07-06: `src/clients/windyWebcams.js`,
  its own daily cron `runWebcamSync` since the 2026-07-06 cron split, migration 0005). (1) **Production secret**: `npx wrangler secret
  put WINDY_WEBCAM_API_TOKEN` must be run once before the next deploy or hydration
  silently skips (it logs). (2) The Windy free tier publishes **no daily request
  quota** — 100 lookups/night is polite guesswork; watch the daily-run logs for 429s.
  (3) The free-tier embed player **shows ads**; the ad-free tier is €9,990/yr, so ads
  stay. (4) "Nearest active cam within 5 km" is a proximity heuristic — the cam may
  face a marina, not the beach; the UI labels it "Nearby webcam" honestly, but a
  curated per-beach override column is the eventual fix if bad matches show up.
  (5) Cams flip between active/inactive; a beach keeps a stored player URL up to
  14 days after its cam dies (the player page itself degrades gracefully).
- **Threshold calibration against real flag history.** South Haven and the Chicago
  Park District are the sources publishing true flag colors (the health-dept
  scrapers report water quality, a different signal), so their beaches now carry
  both an estimate and a live official flag. Once enough
  official-vs-estimate history has been logged, revisit the wave/wind thresholds in
  `src/rules.js` (2 ft / 4 ft wave, 15/25 mph wind, 25/35 mph gust) against how often
  the estimate actually matches South Haven's posted flag, and consider a
  `rules_version` bump (`1.1.0`) if thresholds change — old cached `FlagEstimate`
  objects already carry their own `rules_version`, so this is safe to do
  incrementally.
- **Multiple unnamed beaches per park: only the largest survives.** The daily sync's
  park-containment pass (`mergeBeachRows` in `src/index.js`) keeps just one unnamed
  beach per park element — the one with the largest bounding box — because several
  rows all titled "Ludington State Park" would be indistinguishable in the list UI.
  Ludington SP, for example, has 4 unnamed beach polygons (Lake Michigan shore plus
  Hamlin Lake); the smaller ones are dropped (logged as `skipped_unnamed`). A future
  pass could keep them with a locality suffix, or merge their geometries.
- **Stale park-beach rows are never deleted.** Sync only upserts. If OSM edits make
  a different unnamed beach the largest in a park, the previously-kept row lingers
  alongside the new one (same park name, both rows). Harmless at pilot scale, but a
  reconciliation/delete pass is needed eventually.
- **Park association is bbox-overlap, not polygon containment.** The worker
  associates each beach to the smallest park whose bounding box overlaps the
  beach's (fetching full polygon geometry for ~9k parks nightly is not worth it).
  An L-shaped or diagonal park could claim an adjacent beach. Verified accurate on
  the pilot region's state parks; revisit if wrong pairings show up.
- **Only named beaches/parks are discoverable — by design, current and future
  queries.** Every discovery path requires a name somewhere: query 1 takes only
  named `natural=beach` / `leisure=beach_resort` elements, and query 2's park
  containment only rescues unnamed beaches inside a NAMED park polygon. An unnamed
  beach outside any named park never enters the dataset, and any future query
  (nationwide tiles included) should keep this constraint — a row with no
  human-searchable name can't be displayed, searched, or trusted as a real swim
  spot. Scale of the exclusion (US-wide OSM counts, 2026-07): ~21,000
  `natural=beach` elements total, ~4,900 named, ~10-15k reachable once park
  containment is applied — the remainder is intentionally out of scope unless a
  future pass invents names from other containment/proximity signals (nearest
  named road end, `addr:*` tags, GNIS, etc.).
- **Beaches OSM simply hasn't mapped stay invisible.** Park containment only
  rescues beach polygons that exist. P.J. Hoffmaster State Park has a park polygon
  but no `natural=beach` element inside it, so it still doesn't appear. Fixing OSM
  is the fix.
- **DONE 2026-07-05 — enrichment queue poisoning fixed** (migration
  `0003_enrichment_attempts.sql`): an `enrichment_attempts` counter is bumped on
  every failed `fetchPointMetadata` call and the nightly enrichment query skips
  rows at `enrichment_attempts >= 5`, so permanently-404ing non-US points
  (Ontario shoreline swept in by `PILOT_BBOX`) park after 5 attempts instead of
  starving US beaches. The per-run summary logs `enrichment_parked`. (Canadian
  beaches could eventually get Environment Canada data instead — bigger feature.)
- **DONE 2026-07-05 — Overpass retry shipped**: each of the two daily sync
  queries gets a single delayed retry (`sleep(60000)`) on failure; a second
  named-query failure aborts the run (data kept), a second park-query failure
  degrades to named-only. The two queries stay strictly sequential —
  overpass-api.de allows only 2 slots per IP and 429s beyond that.
- **SwimSmart / Michigan DNR partnership outreach.** Michigan's SwimSmart program and
  DNR-managed state park beaches are an obvious source of more official flag data
  (beyond South Haven) and possibly a sanctioned data-sharing agreement instead of
  scraping. Worth an outreach email before building more scrapers against
  DNR-adjacent HTML pages that could change without notice. UPDATE 2026-07-05: the
  official-source survey (see "Official-source scraper candidates" below) confirmed
  this is the ONLY path to Michigan's statewide data — every EGLE
  BeachGuard/MiEnviro access route is a React/Angular SPA shell with no beach data
  in raw HTML and no discoverable unauthenticated API in the shipped JS bundles,
  while a dozen-plus county health pages just defer to it. The partnership is no
  longer a nice-to-have; it gates ~70+ beaches' worth of official data.
  A ready-to-send outreach email draft lives at
  `docs/swimsmart-outreach-draft.md` — send it.

## Scale-out

- **Nationwide Overpass scale-out.** `runOverpassSync` currently syncs a single pilot
  bbox (`PILOT_BBOX`, Michigan / Great Lakes shoreline) once a day. Scaling to the
  full US coastline means tiling CONUS coastal bboxes and queuing them (e.g. one tile
  per night, or spread across multiple daily cron windows) rather than one big
  Overpass query — large bbox queries risk Overpass API timeouts/rate limiting.
  `MAX_BEACHES_PER_RUN = 1000` in `runFlagRecompute` (raised from 250 on
  2026-07-06 — the `recompute_updated` rotation at 250 left each of the 613
  pilot beaches flagless ~1 h in 3, because the 2 h KV TTL expired between
  rotation turns) will also need real pagination or multiple invocations once
  the `beaches` table exceeds 1000 rows: anything past the limit reintroduces
  the same TTL-expiry gap, so the limit must always cover the table (or the
  TTL/cadence must change with it).
- **MOSTLY DONE 2026-07-06 — NWS enrichment throughput fixed by the cron split.**
  Enrichment moved out of `runOverpassSync` into its own cron (`runNwsEnrichment`,
  `17 3,9,15,21 * * *`): 75 beaches/run, 4 runs/day (≤300/day, was 30/night), so a
  freshly discovered region becomes alert-capable in days, not weeks, and an
  aborted Overpass sync no longer skips that night's enrichment. Queue order is
  now `enrichment_attempts ASC, RANDOM()` — the old `ORDER BY id` drained every
  `osm-node-*` row before any `osm-way-*` row, which is how Holland State Park
  (Ottawa Beach, `osm-way-505668572`) showed estimated GREEN during an active
  Beach Hazards Statement for its zone (MIZ064) on 2026-07-06. REMAINING
  follow-up: a beach with `nws_zone` still NULL silently skips rules steps 1-2
  (alerts, SRF rip risk) — the estimate should say so honestly (a reason/source
  note like "NWS alerts not yet available for this beach") instead of presenting
  a wave-only green as if alerts had been checked.

## Official-scraper fragility

- **FIXED 2026-07-05 — the critical South Haven wrong-green bug.** The scraper no
  longer parses the flag page's static legend images (which returned official
  green 24/7); it now discovers and fetches the city's live Google Sheets CSV
  ("text version" link, rebuilt from the discovered doc-id/gid so a republished
  sheet self-heals), parses per-flag lines into ~9 per-beach sites with
  most-severe rollup, and maps Gray/unmonitored to no data — never a color.
- **DONE 2026-07-05 — scraper health monitoring shipped**
  (`src/scraperHealth.js` + hourly cron): a KV-backed per-scraper counter
  (`scraperhealth:` + scraperId, no TTL) tracks consecutive null scrapes for
  every matched scraper and logs a LOUD `ALERT:` line once a scraper has been
  quiet for 24 consecutive hourly runs. Log-based only — nothing pages a human
  yet; wiring the alert to email/push is a possible follow-up.
- All scrapers parse third-party pages/APIs that can change without notice.
  Every parser degrades to `null` (never a guessed color) on unexpected markup,
  and health monitoring now surfaces a scraper that goes quiet — but a source
  that changes *semantics* while staying parseable (e.g. repurposing a status
  string) would still need a human to notice. Re-verify sources occasionally.
- **Open findings from the 2026-07-06 adversarial review** (plausible but
  unconfirmed or deliberately deferred; none emit a *confirmed* wrong color):
  - **South Haven has no freshness gate.** The CSV carries no timestamp, so the
    scraper trusts the sheet's operators to switch flags to Gray overnight /
    off-season. An abandoned sheet stuck on Green would republish a stale
    official green every hour. Possible fix: drop colored output outside the
    monitored season/hours (May 15–Sept 15, 9am–9pm local) that the Gray
    convention already implies.
  - **South Haven double-red suppresses the whole feed.** A "Double Red" line
    fails the line regex, so the entire parse returns null and ALL South Haven
    sites lose official data exactly when conditions are worst (safe direction,
    but the most dangerous real condition yields no official flag). Capture the
    actual wording live during a double-red event, then add it to the parser.
  - **Chicago residual false-green path:** if a beach's surf/weather rows go
    >36 h stale while its Water Quality row stays fresh and green, the stale
    red rows are dropped and the fresh green wins. Rare in season; a fix would
    require category-aware staleness (e.g. no green unless the surf row itself
    is fresh).
  - **Ohio advisory severity mapping is a heuristic:** a non-HAB advisory with
    typeSeverityLevel < 4 maps to yellow even if its text means "no water
    contact" — possibly under-severe (never a false green). Re-probe during a
    live bacteria advisory and refine the type→color table.

## Official-source scraper candidates (multi-agent survey, 2026-07-05)

A 164-agent survey swept the web for official current-status sources covering the
613 beaches then in the local DB: 83 research agents (one per geographic cluster)
produced 292 raw candidates → 186 unique sources → the top 80 by beach coverage were
each verified by fetching the RAW response (curl, not a rendered view) and rating
scrapability; 30 survived as usable. Full report:
`docs/official-sources-research.md`; structured verdicts (parse strategies,
matches() sketches, render modes): `docs/official-sources-verified.json`. The 106
lowest-coverage candidates (mostly single-beach county pages) were never verified —
they're in the workflow logs if coverage gaps appear.

### Tier 1 — BUILT 2026-07-05 (all registered in `src/officialSources/index.js`)

All nine Tier-1 scrapers below shipped as contract-v2 multi-site scrapers with
dedicated test files. Condensed caveats worth remembering per scraper:

- **South Haven CSV** (`south-haven-mi`) — BUILT; the critical fix above. CSV URL
  is re-discovered from the flag page each run (hardcoded fallback); Gray =
  unmonitored → no data; same-named flag poles roll up to most severe.
- **Chicago Park District `/flag-status` JSON** (`chicago-park-district`) — BUILT.
  ~23 lakefront beaches, real flags. Payload mixes in stale prior-season rows —
  a 36 h per-record staleness gate is load-bearing; "Afterhours" → red
  (lifeguards-off closure, noted in reason). Undocumented/unversioned API;
  off-season behavior still unverified.
- **Wisconsin DNR Beach Health ArcGIS layer** (`wisconsin-dnr`) — BUILT against
  the open ArcGIS REST layer (441 statewide rows). Open/Advisory/Closed →
  green/yellow/red; Closed For Season / No Data / Other Status omitted; 21-day
  sample staleness gate. Proximity-only resolution (no names[] — generic
  statewide names like "North Beach" would mis-bind); mostly pays off when the
  bbox expands past the pilot.
- **Ohio ODH BeachGuard API** (`ohio-beachguard`) — BUILT with 4 hardcoded Lake
  Erie ids (162/153/154/148). In-season + zero current advisories → affirmative
  green (BeachGuard is Ohio's system of record); out-of-season → no data.
  Expanding coverage means enumerating more of the 192-beach registry.
- **Health Dept of Northwest Michigan** (`hdnw-michigan`) — BUILT. Curated
  32-beach name map (not a loose regex); WQI 1–4 → green/yellow/red/double-red;
  8-day staleness gate. Hand-edited WYSIWYG markup remains the fragility risk;
  some aliases are generic (bounded by the four-county bbox).
- **Huron-Clinton Metroparks** (`huron-clinton-metroparks`) — BUILT.
  Closure-only (Closed → red, Open → no assertion); parsing strictly scoped to
  the Kensington/Stony Creek panel ids; name-only site resolution so an open
  sibling beach can't inherit its neighbor's red; Lake St. Clair Metropark
  excluded (defers to EGLE).
- **Benzie-Leelanau District Health Dept** (`bldhd-mi`) — BUILT. Level 1 → green;
  Level 2/3 remain unconfirmed on-page and are logged + omitted (never guessed)
  — confirm semantics with BLDHD to unlock yellow/red; 8-day staleness gate.
- **Lenawee County Health Dept** (`lenawee-mi`) — BUILT. "No Advisory Posted" →
  green; any other status logged + omitted (active-advisory wording still
  unconfirmed); shared Last-Updated staleness gate (10 days).
- **Michigan City IN parks page** (`michigan-city-in`) — BUILT. Page's own E. coli
  thresholds; hand-edited prose remains fragile (fails closed); weekday-only
  cadence tolerated up to 8 days; `updated` = reading date, so the UI stale
  warning fires by design.
- **Windsor-Essex County Health Unit** (`wechu.org/beaches/beach-water-testing`,
  Ontario) — NOT built (US focus; Canadian beaches lack NWS enrichment anyway).
  Still the most feasible CA source when that becomes relevant.

### Tier 2 — worth building, with caveats

- **Algoma Public Health** (CA) — status is inline plain-text JS in raw HTML, but
  match by lat/lon proximity, not name ("Old Mill Beach" appears twice at different
  locations; 3 of 5 claimed names never appear on the page).
- **City of Muskegon WP REST feed**
  (`muskegon-mi.gov/wp-json/wp/v2/posts?categories=8`) — clean JSON but event-only
  press releases: absence of a post is NOT an affirmative all-clear.
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
  easier than the South Haven gold standard, but binary open/posted and Canadian.
- **Barry-Eaton DHD** — parseable dated bulletins, but only 1 of 3 claimed beaches
  has entries; absence isn't a clear signal.
- **Kalamazoo County CivicAlerts** (`kalcounty.gov/m/newsflash?cat=9`) —
  server-rendered, stable DOM, but event-only advisory posts inside general county
  news; zero current entries mid-season.

### Statewide/aggregator plays

- **Michigan EGLE BeachGuard / MiEnviro: hard scraping dead end** (see the SwimSmart
  partnership bullet under Data quality — partnership is the only path; it gates
  70+ beaches).
- **Wisconsin DNR ArcGIS layer** — BUILT (`wisconsin-dnr`): one integration =
  every WI Great Lakes beach (441 records), no auth.
- **Ohio BeachGuard API** — BUILT (`ohio-beachguard`) with 4 Lake Erie ids;
  covering all 192 registry beaches means enumerating more ids.
- **Chicago Park District flag API** — BUILT (`chicago-park-district`): single
  operator but ~23 beaches of true flag colors in one call.
- **Indiana IDEM BeachAlert** (`portal.idem.in.gov/BeachAlert`) — the natural IN
  statewide play but NOT implementable: Power Pages anonymous role is
  permission-denied and it sits behind Cloudflare Bot Management.
- WI/OH/Chicago mostly pay off when `PILOT_BBOX` expands beyond Michigan — each is
  a single integration worth dozens of beaches at that point.

### Dead ends (verified 2026-07-05 — don't re-investigate without new info)

- **EGLE MiEnviro / nSITE / ncore portals** (+ legacy `egle.state.mi.us/beach/...`
  links, which 301 into the same SPAs) — no data in raw HTML, no public API in any
  shipped JS bundle, repeated attempts.
- **Every Facebook page checked** (St. Clair Co. Beaches, Genesee/Isabella Co.
  Parks, Sanilac Co. HD, Marquette Park Gary, City of Marquette, East Tawas,
  Livingston Co. HD, Weko Beach, Ludington SP) — bot-blocked or empty shell to both
  curl and JS-rendering fetch; no public JSON/RSS exists. Same for
  **x.com/chicagoparks**.
- **Ottawa County Beachwatch** — data is inside a session-token-gated Power BI
  Embedded iframe; base page also UA-filters bots.
- **Akamai/Cloudflare-blocked county sites** — Oakland Co. Health, Allegan Co.
  Health, Grosse Pointe Farms parks (522/403), PHSD Sudbury (CA).
- **Chicago per-beach facility pages** (widget broken sitewide, flag set
  client-side), **Chicago Socrata E. coli predictions** (`xvsz-3xcj`, zero 2026
  rows — program paused) and **automated sensors** (`qmqz-2xku`, frozen at
  March 2025 readings).
- **Swim Guide Michigan** — SSR is fine but the upstream Michigan feed
  (`translate.theswimguide.org/michigan/json`) returns HTTP 500 and every MI beach
  shows "No Data Available"; broken platform-wide.
- **NPS Indiana Dunes `status.htm`** — real raw-HTML alerts but years-stale (2021
  "until further notice" items); not a maintained daily feed.
- **Program-description-only pages that defer to BeachGuard** — DHD2, DHD10,
  St. Clair Co., Mid-Michigan DHD, Ingham Co., Muskegon Co. monitoring page,
  gtbay.org (pure link farm).
- **404s / no content** — MI DNR `dnrclosures` URL, michigandnr.com Pontiac Lake
  page, Chippewa Co. HD beach subpage (full sitemap sweep: no beach content),
  Mecosta Co. Parks (static Weebly), Manistee webcams (video only), USDA FS
  Hiawatha alerts (target beaches never named), MI DNR beach-safety page (legend
  images + `javascript:void(0)` park links).

### Coverage math (updated 2026-07-05)

Nine official-source scrapers are now registered (was 1, and that one read the
wrong page). Site capacity by scraper: South Haven ~9 sites, HDNW ~32, BLDHD 10,
Metroparks 4, Lenawee 2, Michigan City 2, Ohio BeachGuard 4, Chicago ~23,
Wisconsin DNR 441 monitoring sites. Within the current Michigan-centric
`PILOT_BBOX` that translates to official status for roughly 40–60 of ~613 DB
beaches (~7–10%) in season — actual counts depend on per-beach resolution
(name/proximity) and each source's staleness gates, and shrink off-season by
design. Chicago's lakefront and Wisconsin's Door County peninsula fall inside
the bbox already; the rest of Wisconsin's 441 sites and Ohio's 192-beach
registry become disproportionately valuable once the Overpass bbox expands past
the pilot. The 70+-beach prize (Michigan EGLE BeachGuard) remains
partnership-gated — see `docs/swimsmart-outreach-draft.md`.

## Free vs. paid Workers plan

- The hourly `runFlagRecompute` cron's subrequest budget (~900 subrequests/run for the
  pilot region at `MAX_BEACHES_PER_RUN = 1000`, per PLAN.md section 7) assumes the
  Workers **Paid** plan (10,000 subrequests/invocation, no daily KV-write cap). The
  **Free** plan's 50-subrequest ceiling and 1000 KV-writes/day quota are not
  sufficient at this cadence and beach count. For a free-plan demo, drop
  `MAX_BEACHES_PER_RUN` way down (e.g. 10-15 beaches) and/or reduce cron frequency
  before deploying without a paid plan.

## Frontend

- List-page pagination: `GET /` currently renders the first 100 beaches
  (`ORDER BY name LIMIT 100`) with no pagination controls or `?page=` param. Fine
  while the pilot region has well under 100 named beaches; needs real pagination (or
  a map-based `/api/beaches?bbox=` client view) once nationwide scale-out lands.

## Explicitly deferred by PLAN.md (not gaps, just out of scope for this pass)

- No ML/LLM-based estimation — the rules engine is intentionally a fully
  deterministic, versioned pure function (`src/rules.js`). Any future "smarter"
  estimation should be a new `rules_version`, not a replacement of this approach.
  The pure/deterministic contract is a design decision, not a limitation to lift.
