# Swim Report (swim.report)

Swim Report estimates beach hazard flag status (green / yellow / red / double-red /
unknown) for US beaches using public NWS and Open-Meteo data, and — where a
municipality publishes one — surfaces the real official flag alongside it.

## Estimated vs. official

**Estimated — not the official flag status. Always obey posted flags and lifeguards.**

Every color shown by Swim Report is either:

- an **ESTIMATE** (`official: false`) — a deterministic, versioned guess computed from
  NWS alerts, NWS Surf Zone Forecast rip current risk, and Open-Meteo wave/wind data.
  It is not a substitute for the flag actually flying at the beach.
- an **OFFICIAL** reading (`official: true`) — scraped directly from a municipality's
  or health department's own published status page/API, when Swim Report has a
  working scraper for that beach. Nine programs are supported today (see
  "Official sources" below): South Haven MI, Lenawee County MI, Huron-Clinton
  Metroparks MI, Michigan City IN, Ohio ODH BeachGuard, Health Dept of Northwest
  Michigan, Benzie-Leelanau District Health Dept MI, Chicago Park District, and
  Wisconsin DNR Beach Health.

Estimates and official readings are rendered in visually distinct UI elements
everywhere they appear, and the API always keeps them in separate fields so a client
can never confuse the two.

This is a personal weather-data project, not a lifeguard service. It can be wrong. It
can be stale (see the staleness warning below). If a beach has a physical flag posted,
that flag — and any lifeguard on duty — is the actual authority, not this site.

## API

The HTTP request path never calls any upstream API. It only reads pre-computed data
from D1 (beach directory) and KV (flag estimates / official readings), which are kept
fresh by two scheduled cron jobs.

### `GET /api/beaches?bbox=minLon,minLat,maxLon,maxLat`

Returns beaches from the D1 directory inside the given bounding box. `bbox` is
required: exactly four comma-separated finite numbers, with `minLon < maxLon` and
`minLat < maxLat`.

Example request:

    GET /api/beaches?bbox=-86.32,42.35,-86.24,42.45

Example response:

    {
      "beaches": [
        {
          "id": "osm-node-123456",
          "name": "South Beach",
          "park_name": null,
          "lat": 42.401,
          "lon": -86.288,
          "nws_zone": "MIZ071",
          "osm_id": "node/123456"
        }

`park_name` is the containing park from OpenStreetMap (e.g. `"Holland State Park"`
for the beach named `"Ottawa Beach"`), or `null` when the beach is not inside any
named park. The UI titles such beaches by park name with the beach's own name as a
subtitle.
      ]
    }

Invalid or missing `bbox` returns `400`:

    { "error": "invalid bbox" }

### `GET /api/flag/:beachId`

Returns the cached estimate and official reading (if any) for one beach, read
straight from KV. Either field may be `null` if no value is cached (missing/expired
key just means "no data").

Example request:

    GET /api/flag/osm-node-123456

Example response:

    {
      "beachId": "osm-node-123456",
      "estimate": {
        "beachId": "osm-node-123456",
        "color": "yellow",
        "reason": "Estimated wave height 2.6 ft (at or above 2 ft)",
        "trigger": "wave-height",
        "rules_version": "1.2.0",
        "official": false,
        "waveHeightFt": 2.62,
        "sources": [
          { "label": "ECMWF Wave Forecast",
            "url": "https://open-meteo.com/en/docs/marine-weather-api" }
        ],
        "updated": "2026-07-04T15:00:03.000Z"
      },
      "official": null
    }

Unknown `beachId` (no matching D1 row) returns `404`:

    { "error": "beach not found" }

### `GET /health`

Liveness check, no upstream/DB access:

    { "ok": true }

### `GET /` and `GET /beach/:beachId`

Server-rendered HTML pages: a beach list and a beach detail page, built entirely from
D1 + KV data (see the frontend contract in `src/frontend/render.js`).

The detail page includes a **Wave forecast** section: a "now" wave-height stat (from
the estimate's structured `waveHeightFt`) plus a Dark Sky-style horizontal strip of
the next up-to-24 hours of forecast wave height, colored by the same 2 ft / 4 ft
thresholds the rules engine uses (gray for hours with no model data — common on the
Great Lakes). The strip is drawn by the Web Awesome `wa-bar-chart` component from a
server-built JSON config stored hourly in KV (`waves:` keys); it carries the same
ESTIMATE badge as the estimate card, degrades to a prose forecast summary when JS or
the component kit is unavailable, and is omitted entirely for beaches with no wave
series (e.g. buoy-only readings, which still show the "now" stat).

When two or more wave models resolve for a beach, the section also shows each model's
current reading ("ECMWF 2.6 ft · NOAA GFS 2.4 ft · Météo-France 2.9 ft") and a
collapsed "Compare wave models" line chart of the per-model 24-hour series. The flag
estimate itself still derives from the composite first-finite-model series — the
per-model data (`byModel` in the KV `waves:` payload) is stored for transparency and
future calibration against `flag_history`, not for averaging (see TODO.md).

When Cloudflare's IP-derived geolocation is available on the request (`request.cf`),
the beach list is sorted by approximate distance to the visitor and each row shows a
rough mileage label; the page says so explicitly. Without geolocation the list falls
back to alphabetical order. `GET /?near=lat,lon` overrides the detected location
(useful in local dev, where `request.cf` has no coordinates); an invalid `near` value
falls back to alphabetical order. Nothing about the visitor's location is stored.

`GET /?q=term` runs a case-insensitive substring search over the **entire** beach
directory server-side (not just the ~100 rows the page renders), matching both the
display name (`COALESCE(park_name, name)`) and the beach's own name; user-supplied
`LIKE` wildcards are escaped so the term is matched literally. Results are still
capped at 100 rows and combine with `near=` — when a location resolves, matches are
filtered first and then distance-sorted. Empty or whitespace-only `q` is ignored. The
on-page search box submits this parameter as a `GET` form while also filtering the
rendered rows instantly client-side as you type.

All `/api/*` responses set `content-type: application/json`; HTML responses set
`content-type: text/html; charset=utf-8`. Responses are cached at Cloudflare's edge
(Workers Cache, `[cache]` in `wrangler.toml`) under an explicit per-route policy:
successful API and beach-detail responses send
`cache-control: public, max-age=60, stale-while-revalidate=600, stale-if-error=600`
(fresh for a minute, served stale up to 10 more while revalidating in the
background); the `/api/flag` 404 sends plain `public, max-age=60`; the home page,
`/health`, and error responses send `no-store` — the home page is personalized by
IP-derived location and must never be shared across visitors.

## Estimation rules

Flag estimation is a pure, deterministic, versioned function (`estimateFlag` in
`src/rules.js`) — no ML, no LLM, no network access, no clock access. The current
`rules_version` is `1.2.0`. Given the same inputs it always returns the same output.

Precedence is strict: the first matching rule wins, evaluated top to bottom.

| # | Signal | Source | Condition | Color | Reason |
|---|--------|--------|-----------|-------|--------|
| 1 | Active NWS alert | `api.weather.gov/alerts/active?zone={nws_zone}` | Event = "High Surf Warning" | double-red | "Active NWS alert: High Surf Warning" |
| 1 | Active NWS alert | same | Event = "Beach Hazards Statement" | red | "Active NWS alert: Beach Hazards Statement" |
| 1 | Active NWS alert | same | Event = "High Surf Advisory" | red | "Active NWS alert: High Surf Advisory" |
| 1 | Active NWS alert | same | Event = "Rip Current Statement" | red | "Active NWS alert: Rip Current Statement" |
| 2 | Rip current risk | NWS Surf Zone Forecast (SRF) text product, regex-parsed | HIGH | red | "NWS surf zone forecast rip current risk: HIGH" |
| 2 | Rip current risk | same | MODERATE | yellow | "NWS surf zone forecast rip current risk: MODERATE" |
| 3 | Wave height | Open-Meteo Marine API (m converted to ft, `m * 3.28084`) | >= 4 ft | red | "Estimated wave height X.X ft (at or above 4 ft)" |
| 3 | Wave height | same | >= 2 ft | yellow | "Estimated wave height X.X ft (at or above 2 ft)" |
| 3 | Wave height | same | < 2 ft, non-null | green | "Estimated wave height X.X ft (below 2 ft)" |
| 4 | Wind (fallback only when wave height is null) | Open-Meteo standard forecast API | sustained >= 25 mph OR gusts >= 35 mph | red | "No wave data; wind S mph sustained, G mph gusts (at or above 25 mph sustained or 35 mph gust threshold)" |
| 4 | Wind | same | sustained >= 15 mph OR gusts >= 25 mph | yellow | "No wave data; wind S mph sustained, G mph gusts (at or above 15 mph sustained or 25 mph gust threshold)" |
| 4 | Wind | same | below both thresholds | green | "No wave data; wind S mph sustained, G mph gusts (below advisory thresholds)" |
| 5 | Terminal fallback | rip current risk LOW, nothing else usable | — | green | "NWS surf zone forecast rip current risk: LOW; no wave or wind data available" |
| 5 | Terminal fallback | no usable data anywhere | — | unknown | "No usable data from NWS alerts, surf zone forecast, or Open-Meteo wave and wind models" |

Notes on the precedence design (all intentional, see `src/rules.js` and
`test/rules.test.js`):

- Alerts are checked in `ALERT_PRECEDENCE` order, not the order they appear in the
  NWS response — "High Surf Warning" always wins over any other simultaneous alert.
- Rip current risk beats wave height even when the wave height alone would imply a
  worse (or better) color. A MODERATE rip risk yields yellow even with a 6 ft wave
  height reading.
- Wind is used **only** as a fallback when every wave model returned null (common on
  the Great Lakes, where wave model grid points are frequently masked). It is never
  blended with wave data.
- On the Great Lakes, a beach whose Open-Meteo wave reading is null may be
  gap-filled from the nearest GLOS Seagull wave buoy (within 25 km, freshest
  observation within 2 h — `src/clients/glerl.js`) before wind is considered.
  The `sources` array on each estimate names whichever wave source was actually
  used.
- An empty alerts array (`[]`, i.e. a successful fetch with zero active alerts) does
  not by itself count as "usable data" — with everything else null the result is
  still `unknown`, not `green`.
- A beach not yet through NWS point enrichment (its `nws_zone` is still `NULL`, so
  alerts and rip-current risk were never checkable) carries an explicit caveat
  appended to its `reason`: ` (NWS alerts not yet available for this beach)`. This
  adds no new color or table row — it only distinguishes "alerts checked, none
  active" from "alerts never checked" so a wave/wind-only estimate is never
  presentable as alert-verified. The caveat is omitted once the beach is enriched
  (and whenever an NWS alert itself decided the color).

Every `FlagEstimate` carries: `color`, a human-readable `reason`, `trigger` (which
precedence branch decided the color: `nws-alert`, `rip-current`, `wave-height`,
`wind`, `rip-current-low`, or `no-data` — the detail page renders this as a
natural-language explanation), `rules_version`, `official: false`, `sources`
(`{ label, url }` entries for the data actually used for that beach), and `updated`
(ISO 8601 UTC).

## Local development

    npm install
    npm run dev    # predev applies migrations/ to the local D1 automatically

The production D1 database and KV namespace already exist and their IDs are
committed in `wrangler.toml` — no resource creation is needed. `wrangler dev`
runs everything against local simulated storage regardless of those IDs.

Then visit `http://localhost:8787/health`, `http://localhost:8787/`, and
`http://localhost:8787/api/beaches?bbox=-87.6,41.6,-82.3,46.6`.

Run tests (pure functions only, no network, no Workers runtime):

    npm test

### Environment variables

`.dev.vars` holds local secrets: `WEBAWESOME_NPM_TOKEN` is used by the Web Awesome
Pro build tooling (`npm install`, via `.npmrc`), `WINDY_WEBCAM_API_TOKEN` is a
Worker **runtime** secret (`wrangler dev` loads `.dev.vars` into `env`
automatically), and `CLOUDFLARE_TOKEN` is the account API token used to
authenticate wrangler itself (export it as `CLOUDFLARE_API_TOKEN` before running
wrangler commands — this machine has no `wrangler login` session).

In production the webcam token is a Worker secret, set once (done 2026-07-13) with:

    npx wrangler secret put WINDY_WEBCAM_API_TOKEN

The webcam cron skips hydration (with a log line) when the token is unset;
everything else — NWS, Open-Meteo, GLOS Seagull, and every official-source
scraper — is unauthenticated.

**Web Awesome Pro CDN kit**: the frontend `<head>` loads Web Awesome Pro from the
account's version-pinned CDN kit (`WA_KIT_BASE` in `src/frontend/render.js`): the
matter theme, the mild color palette, native styles/reset, CSS utilities, and the
`webawesome.loader.js` component autoloader, with matching
`wa-theme-matter wa-palette-mild` classes on `<html>`. A `WA_THEME_OVERRIDES`
style block carries the kit's token overrides but swaps its webfont downloads for
system font stacks (no external font requests). Theme changes in the kit builder
mean re-copying the snippet's theme/palette/overrides into `render.js` — the
pinned CDN files themselves are immutable and long-cached. Font Awesome icons
resolve through the kit code set via `data-fa-kit-code` on the `<html>` element.

### Cron jobs

Four scheduled triggers run in production (see `wrangler.toml`). They are separate
crons on purpose: each upstream's rate-limit posture is independent, and a failure
in one job never starves another (an aborted Overpass sync used to skip that
night's NWS enrichment and webcam hydration entirely).

- `0 * * * *` (hourly) — `runFlagRecompute`: reads beaches from D1 (up to
  `MAX_BEACHES_PER_RUN = 1000`, oldest `recompute_updated` first — enough to cover
  the whole pilot table every run, so no flag ever outlives its 2 h KV TTL waiting
  for a rotation turn), fetches NWS alerts/SRF and Open-Meteo wave/wind data, runs
  them through `estimateFlag`, runs the official-source scrapers (once per distinct
  matched scraper, resolved per beach, with KV-backed health monitoring), and
  writes both to KV (`flag:` + beachId, `official:` + beachId) with a 7200 second
  TTL. Beaches whose Open-Meteo wave data comes back null (common on the Great
  Lakes) get a second chance from `src/clients/glerl.js`: nearest GLOS Seagull
  wave buoy within 25 km, freshest observation within 2 h, before falling back to
  the wind-only estimate.
- `47 8 * * *` (daily, ~03:47 America/New_York) — `runOverpassSync`, discovery
  only: two Overpass API queries over the pilot bbox — (1) named `natural=beach` /
  `leisure=beach_resort` elements, and (2) every `natural=beach` element (named or
  not) that intersects a NAMED park polygon (`leisure=park`,
  `leisure=nature_reserve`, or `boundary=protected_area`), plus those park polygons'
  bounding boxes. Each park-contained beach is associated to the smallest
  overlapping park bbox and stored with that `park_name`; unnamed park beaches are
  kept one-per-park (the largest) and take the park's name, because most OSM
  mappers name the park polygon (Holland State Park) rather than the beach way
  inside it. Results are upserted into D1. Each Overpass query gets a single
  delayed retry (60 s) on failure; if the named-beaches query fails twice the sync
  aborts (existing data kept), and if only the park query fails twice the sync
  degrades to named beaches only with existing `park_name` values left untouched.
- `17 3,9,15,21 * * *` (4x daily; the 09:17 run picks up rows the 08:47 discovery
  just inserted) — `runNwsEnrichment`: up to 75 beaches per run (≤300/day) with
  `nws_zone` NULL get their NWS forecast zone + gridpoint URL from
  api.weather.gov/points. A beach without `nws_zone` silently skips the alert and
  rip-current rules in `runFlagRecompute`, so draining this queue fast is a safety
  property — api.weather.gov publishes no numeric rate limit and 75 sequential
  polite requests per run is well within reasonable use. Queue order is fewest
  failed attempts first, then `RANDOM()` (the old `ORDER BY id` drained every
  node-based beach before any way-based one). Failures bump a per-beach
  `enrichment_attempts` counter (migration 0003); after 5 failed attempts a row is
  parked and no longer requeued, so permanently-404ing non-US points (Ontario
  shoreline swept in by the pilot bbox) can't starve US beaches.
- `31 9 * * *` (daily) — `runWebcamSync`: hydrates each beach's nearest **Windy
  webcam** (`src/clients/windyWebcams.js`, Webcams API v3 free tier): up to 100
  beaches/night — never-checked rows first, then rows last checked more than
  14 days ago — get one `nearby` lookup (5 km radius) and store the nearest
  *active* cam's id, title, and embed **player** URL in D1 (migration 0005).
  The 100/night cap is deliberately unchanged: Windy publishes no free-tier
  quota, so it stays at polite guesswork. Only the player URL is kept:
  free-tier still-image URLs expire in ~15 minutes, so images are useless under
  the read-only request path, while the player embeds durably. The detail page
  renders it in a plain `<iframe>` embed (the same framed treatment as the
  wave map, with an accessible `title`) labeled as a *nearby* webcam
  with a Windy.com attribution link (free-tier requirement). An API failure
  leaves the row untouched (retried next night); a confirmed
  no-cam-within-radius answer clears the webcam columns and stamps the check
  time.

`wrangler dev` does not run cron triggers on a schedule; trigger them manually while
developing via the scheduled-handler endpoint:

    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=47+8+*+*+*"          # daily discovery sync
    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+3,9,15,21+*+*+*"  # NWS point enrichment
    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=31+9+*+*+*"          # webcam hydration
    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"           # hourly flag recompute

`npm run seed` / `npm run seed:enrich` / `npm run seed:webcams` / `npm run seed:flags`
wrap these four commands. The local database starts empty — run `npm run seed` once
after a fresh checkout (it queries the live Overpass API and takes a couple of
minutes), then `npm run seed:enrich` a few times to give beaches their NWS zones.
The `--test-scheduled` flag and `/__scheduled` path from older wrangler versions no
longer exist in wrangler 4.

**Paid-plan assumption**: the hourly job's subrequest budget (~950 subrequests/run for
the pilot region: alert + SRF + wave + GLOS buoy gap-fill + wind + scraper fetches —
Ohio BeachGuard alone is now 51 per-id GETs — plus up to ~700 KV reads/writes) exceeds
the free plan's 50-subrequest ceiling (the paid
plan allows 10,000 per invocation). Production deployment assumes the Workers Paid
plan. See `TODO.md` for a free-plan-friendly fallback (lower `MAX_BEACHES_PER_RUN`).

## Deployment

Production runs at **https://swim.report** (first deployed 2026-07-13) as a single
Cloudflare Worker with a custom-domain route, Workers Logs observability
(`head_sampling_rate = 1`), and Smart Placement — all configured in
`wrangler.toml`, which carries the real production D1 database and KV namespace
IDs (see PLAN.md section 8 for the authoritative config).

    export CLOUDFLARE_API_TOKEN=...                            # from .dev.vars (CLOUDFLARE_TOKEN)
    npx wrangler deploy --dry-run                              # validate first
    npm run deploy                                             # deploy
    npx wrangler d1 migrations apply swim-report --remote      # after adding a migration
    npx wrangler tail                                          # live logs

The production database starts empty on a fresh deploy — the `47 8 * * *`
discovery cron populates beaches on its next run, then the `17 3,9,15,21 * * *`
enrichment runs drain the NWS-zone queue and the hourly cron starts writing
flags. There is no remote equivalent of `npm run seed`; either wait for the
crons or run a local dev server with `remote = true` bindings and trigger the
scheduled-handler endpoints manually.

`compatibility_date` is pinned — bump it to the current date occasionally when
deploying. Structured logs land in the Cloudflare dashboard under
Workers → swim-report → Logs.

## Official sources

Official flag data (`official: true`) comes from `src/officialSources/`, a scraper
registry implementing **scraper contract v2** (per-beach resolution — the
authoritative spec is PLAN.md section 6). Every scraper obeys one hard product
rule: **never report a wrong color**. Any ambiguity, unexpected markup, stale
data, or unrecognized status degrades to `null` (no data), never a guessed color.

Registered scrapers (registry order — most-specific match first, since
`findScraper` returns the first scraper whose `matches(beach)` is true):

| Scraper (id) | Source | Color semantics |
|---|---|---|
| South Haven MI (`south-haven-mi`) | City flag program's published Google Sheets CSV (linked from the flag page as the "text version"; the page itself is only a static legend) | Real flag colors per site (~9 sites, multiple poles roll up to most severe); Gray = unmonitored → no data |
| Lenawee County MI (`lenawee-mi`) | County health dept beach-monitoring page (Hayes SP, Lake Hudson RA) | "No Advisory Posted" → green; any other status omitted; >10-day-old report → no data |
| Huron-Clinton Metroparks (`huron-clinton-metroparks`) | metroparks.com park-closures page (Martindale, Maple, Baypoint, Eastwood) | **Closure-only**: Closed → red; Open → no assertion (never an inferred green) |
| Michigan City IN (`michigan-city-in`) | Washington Park page's dated E. coli prose block | Page's own thresholds: ≤235 green, 236–999 yellow, ≥1000 red; reading >8 days old → no data |
| Ohio ODH BeachGuard (`ohio-beachguard`) | Ohio Dept of Health BeachGuard public API, 51 curated Lake Erie public-beach ids | Current advisory → red (any HAB advisory — warning or watch — / high severity) or yellow (bacteria contamination); in-season, no advisory → green; out-of-season → no data. `matches()` is geographically gated to Ohio's Lake Erie shore so a same-named out-of-state beach can't inherit a flag |
| HD of Northwest Michigan (`hdnw-michigan`) | nwhealth.org Water Quality Index table (~32 curated beaches, 4 counties) | WQI 1/2/3/4 → green/yellow/red/double-red; samples >8 days old dropped |
| Benzie-Leelanau DHD (`bldhd-mi`) | bldhd.org weekly "Beach Report" table (10 curated sites) | WQI Level 1/2/3/4 → green/yellow/red/double-red (mapped from BLDHD's own weekly-report legend); a Level outside 1–4 omitted; report >8 days old → no data |
| Chicago Park District (`chicago-park-district`) | chicagoparkdistrict.com `/flag-status` JSON API (~23 lakefront beaches) | Real flag colors; "Afterhours" → red (no-lifeguard closure); records >36 h old dropped; a beach reports green only when its own Surf row is fresh (a green resting solely on a fresh water-quality row → no data, never a false green) |
| Wisconsin DNR (`wisconsin-dnr`) | DNR Beach Health ArcGIS REST layer (441 statewide monitoring sites) | Open → green, Advisory → yellow, Closed → red; Closed For Season / No Data omitted; samples >21 days old dropped |

Health-department sources report water-quality (E. coli) status, not literal
beach flags — the `reason` string on each official reading says exactly what was
reported and, for periodic-testing sources, when it was sampled.

### Scraper health monitoring

The hourly cron tracks every matched scraper's consecutive-null streak in KV
(`scraperhealth:` + scraperId, no TTL — see `src/scraperHealth.js`). When a
scraper that has matched beaches returns null for 24 consecutive hourly runs
(~24 h quiet), the cron logs a LOUD `ALERT:` line naming the scraper and its
last success, so a silently-broken source page surfaces in the logs instead of
just going dark.

## How to add a new official-source scraper

1. Create `src/officialSources/<yourScraper>.js` exporting an object matching
   scraper contract v2 (PLAN.md section 6 has the full spec):

       export const yourScraper = {
         id: "stable-kebab-case-id",
         label: "Human-readable operator name",
         url: "https://the-page-you-scrape",
         matches: function (beach) {
           // BeachRow -> boolean, pure. Match by name regex and/or a lat/lon
           // bounding box that covers every OSM beach row for that area.
         },
         scrape: async function (nowIso) {
           // Fetch and parse the source, then return ONE of:
           // (a) single-color (applied to every matched beach):
           //   { color, reason, official: true, scraperId: id, source: url,
           //     sources: [url], updated: nowIso }
           // (b) multi-site (each matched beach resolves to at most one site):
           //   { perBeach: true, sites: [{ siteId, color, reason,
           //     names: ["lowercase substrings"], lat, lon, radiusMi,
           //     updated /* optional ISO; overrides result updated */ }],
           //     source: url, sources: [url], updated: nowIso }
           // or null on any fetch/parse failure. NEVER throw, NEVER guess a
           // color — omit ambiguous sites instead.
           // updated honesty: only real-time sources may stamp nowIso.
           // Periodic sources (water sampling, weekly reports) must stamp
           // the source's own report/sample date — result-level when the
           // page shares one date, per-site `updated` when readings differ
           // per beach — so the UI's stale-data warning stays honest.
         }
       };

   With shape (b), each matched beach is resolved to a site by
   `resolveSiteForBeach` in `src/officialSources/index.js`: name substrings
   win over proximity, then nearest site within its `radiusMi` (default
   1.5 mi). A beach that resolves to no site gets no official flag — that is
   the correct outcome, not an error. Sites without a confirmed
   green/yellow/red/double-red color must be omitted from `sites`.

   Keep parsing logic in separate, pure, exported functions (see
   `parseSouthHavenCsv` in `src/officialSources/southHaven.js`) so they can be
   unit tested with fixture strings and no network access. `scrape(nowIso)`
   receives its timestamp — never call `Date.now()` or `new Date()`.

2. Register it in the `scrapers` array in `src/officialSources/index.js`,
   keeping the most-specific `matches()` earliest — `findScraper(beach)`
   returns the first match, so tight city boxes go before broad statewide
   bboxes.

3. Add tests under `test/` covering the pure parse function (including
   ambiguous/unknown-status rows being omitted) and `matches()` with
   representative `BeachRow` fixtures (matching name, matching bbox, and a
   beach that should NOT match).

4. That's it — the hourly cron (`runFlagRecompute` in `src/index.js`)
   automatically discovers every beach matched by your scraper, calls
   `scrape(nowIso)` **once per distinct scraper per run** (not once per
   beach), resolves the shared result per beach, and writes
   `official:` + beachId to KV for every beach that resolved. Scraper health
   monitoring picks the new scraper up automatically.

Official scrapes, like estimates, run cron-side only and are cached in KV — the
request path never scrapes a page live.
