# Swim Report (swim.report)

Swim Report estimates beach hazard flag status (green / yellow / red / double-red /
unknown) for US and Canadian Great Lakes beaches using public NWS, Environment and
Climate Change Canada (ECCC), and Open-Meteo data, and — where a municipality
publishes one — surfaces the real official flag alongside it.

## Estimated vs. official

**Estimated — not the official flag status. Always obey posted flags and lifeguards.**

Every color shown by Swim Report is either:

- an **ESTIMATE** (`official: false`) — a deterministic, versioned guess computed from
  NWS alerts (or Environment Canada alerts for Canadian beaches), NWS Surf Zone
  Forecast rip current risk, and Open-Meteo wave/wind data.
  It is not a substitute for the flag actually flying at the beach.
- an **OFFICIAL** reading (`official: true`) — scraped directly from a municipality's
  or health department's own published status page/API, when Swim Report has a
  working scraper for that beach. Nine programs are supported today (see
  [Official sources](#official-sources) below for the full table).

Estimates and official readings are rendered in visually distinct UI elements
everywhere they appear, and the API always keeps them in separate fields so a client
can never confuse the two.

Only **ocean and Great Lakes** beaches are shown. Beach flags exist only for those
waters, so every beach is classified by its adjacent water body and inland-lake rows
(Fremont Lake, Clinton Lakes) are hidden — classified and filtered out, never deleted.
Discovery and water-body classification both run in the offline GitHub Actions batch
(`scripts/discovery-batch.js`), not in the Worker; see [Discovery and classification
(offline)](#discovery-and-classification-offline).

This is a personal weather-data project, not a lifeguard service. It can be wrong. It
can be stale (see the staleness warning below). If a beach has a physical flag posted,
that flag — and any lifeguard on duty — is the actual authority, not this site.

## API

The HTTP request path never calls any upstream API. It only reads pre-computed data
from D1 (beach directory) and KV (flag estimates / official readings), which are kept
fresh by scheduled cron jobs (see [Cron jobs](#cron-jobs) below — the hourly recompute
and a 6-hourly wave refresh).

### `GET /api/beaches?bbox=minLon,minLat,maxLon,maxLat`

Returns beaches from the D1 directory inside the given bounding box. `bbox` is
required: exactly four comma-separated finite numbers, with `minLon < maxLon` and
`minLat < maxLat`. Results exclude confirmed-inland beaches (only ocean / Great
Lakes rows are returned; still-unclassified rows remain visible during backfill).

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
      ]
    }

`park_name` is the containing park from OpenStreetMap (e.g. `"Holland State Park"`
for the beach named `"Ottawa Beach"`), or `null` when the beach is not inside any
named park. The UI titles such beaches by park name with the beach's own name as a
subtitle.

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
        "rules_version": "1.4.0",
        "official": false,
        "waveHeightFt": 2.62,
        "alertDetails": [],
        "ripCurrentRisk": null,
        "sources": [
          { "label": "ECMWF Wave Forecast",
            "url": "https://open-meteo.com/en/docs/marine-weather-api" }
        ],
        "updated": "2026-07-04T15:00:03.000Z"
      },
      "official": null
    }

Unknown `beachId` (no matching D1 row) returns `404`. A confirmed-inland beach
returns `404` too — it is not flag-worthy, so it is treated as not found:

    { "error": "beach not found" }

### `GET /health`

Liveness check, no upstream/DB access:

    { "ok": true }

### `GET /` and `GET /beach/:beachId`

Server-rendered HTML pages: a beach list and a beach detail page, built entirely from
D1 + KV data (see the frontend contract in `src/frontend/render.js`). Both exclude
confirmed-inland beaches: they are absent from the list and search, and a detail page
for one returns `404` (only ocean / Great Lakes rows, plus still-unclassified rows
during backfill, are shown).

The detail page includes a **Wave forecast** section: a "now" wave-height stat (from
the estimate's structured `waveHeightFt`) plus a Dark Sky-style horizontal strip of
the next up-to-24 hours of forecast wave height, colored by the same 2 ft / 4 ft
thresholds the rules engine uses (gray for hours with no model data — common on the
Great Lakes). The strip is a plain flex row of colored segments — one per run of
consecutive same-band hours, sized proportionally — built server-side from the hourly
KV wave series (`waves:` keys). Each segment carries a `wa-tooltip` (hover/focus/tap)
and a matching `aria-label` naming its band and hour range ("2–4 ft waves (estimated)
— +5 h to +8 h"), and a visually-hidden prose summary keeps the whole forecast
readable by assistive tech. Active hazards overlay the strip as a lane of labeled
bands along the top: each flag-relevant NWS alert renders a band spanning its
onset-to-ends period within the window (tooltip: "NWS alert: Beach Hazards Statement
— now through +14 h"), and a HIGH/MODERATE rip-current risk from the surf zone
forecast renders a full-window band (the SRF product carries no parseable end time).
The `alertDetails` and `ripCurrentRisk` fields echoed on the estimate payload feed
this lane. The section carries the same ESTIMATE badge as the
estimate card (on the "waves now" stat line) and is omitted entirely for beaches
with no wave series (e.g. buoy-only readings, which still show the "now" stat).

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
`rules_version` is `1.4.0`. Given the same inputs it always returns the same output.

Precedence is strict: the first matching rule (steps 1–5) wins, evaluated top to
bottom. Step 6 is the sole exception — an NWS severe-weather **watch** acts as a
yellow *floor*, raising a green/unknown result to yellow but never downgrading a
higher color (see the notes below).

| # | Signal | Source | Condition | Color | Reason |
|---|--------|--------|-----------|-------|--------|
| 1 | Active NWS alert | `api.weather.gov/alerts/active` (land matched by `nws_zone`, marine by `marine_zone`) | Event = "Tornado Warning" | double-red | "Active NWS alert: Tornado Warning" |
| 1 | Active NWS alert | same | Event = "High Surf Warning" | double-red | "Active NWS alert: High Surf Warning" |
| 1 | Active NWS alert | marine (`marine_zone`) | Event = "Storm Warning" | double-red | "Active NWS alert: Storm Warning" |
| 1 | Active NWS alert | same | Event = "Severe Thunderstorm Warning" | red | "Active NWS alert: Severe Thunderstorm Warning" |
| 1 | Active NWS alert | same | Event = "Beach Hazards Statement" | red | "Active NWS alert: Beach Hazards Statement" |
| 1 | Active NWS alert | same | Event = "High Surf Advisory" | red | "Active NWS alert: High Surf Advisory" |
| 1 | Active NWS alert | same | Event = "Rip Current Statement" | red | "Active NWS alert: Rip Current Statement" |
| 1 | Active NWS alert | same | Event = "High Wind Warning" | red | "Active NWS alert: High Wind Warning" |
| 1 | Active NWS alert | marine (`marine_zone`) | Event = "Gale Warning" or "Special Marine Warning" | red | "Active NWS alert: Gale Warning" |
| 1 | Active NWS alert | same | Event = "Lakeshore Flood Warning" or "Coastal Flood Warning" | red | "Active NWS alert: Lakeshore Flood Warning" |
| 1b | Active ECCC alert (Canadian beaches) | `api.weather.gc.ca` `weather-alerts` collection, matched by alert-region polygon | Event = "tornado warning" | double-red | "Active Environment Canada alert: tornado warning" |
| 1b | Active ECCC alert | same | Event = "storm surge warning" | double-red | "Active Environment Canada alert: storm surge warning" |
| 1b | Active ECCC alert | same | Event = "squall warning" | red | "Active Environment Canada alert: squall warning" |
| 1b | Active ECCC alert | same | Event = "waterspout warning" | red | "Active Environment Canada alert: waterspout warning" |
| 1b | Active ECCC alert | same | Event = "severe thunderstorm warning" | red | "Active Environment Canada alert: severe thunderstorm warning" |
| 1b | Active ECCC alert | same | Event = "wind warning" | red | "Active Environment Canada alert: wind warning" |
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
| 6 | NWS yellow watch/advisory floor | `api.weather.gov/alerts/active` (land `nws_zone` / marine `marine_zone`) | Event in {Tornado, Severe Thunderstorm, High Wind} Watch or {Wind, Lake Wind, Small Craft, Lakeshore Flood, Coastal Flood} Advisory, **and** steps 1–5 decided green/unknown | yellow | "Active NWS alert: <event>" |

Notes on the precedence design (all intentional, see `src/rules.js` and
`test/rules.test.js`):

- Alerts are checked in `ALERT_PRECEDENCE` order, not the order they appear in the
  NWS response — the top of that list ("Tornado Warning", then "High Surf Warning",
  both double-red) wins over any other simultaneous alert.
- Step 1 also maps life-threatening severe-weather **warnings** (Tornado Warning →
  double-red, Severe Thunderstorm Warning → red), the **high-wind and lakeshore/
  coastal-flood warnings** (High Wind / Lakeshore Flood / Coastal Flood Warning →
  red), and the **marine warnings** (Storm Warning → double-red; Gale Warning and
  Special Marine Warning → red). Because these are all red/double-red at the top of
  precedence they can only ever raise the flag, never lower it below what waves/wind
  would show. **Ordering constraint:** the step-1 loop takes the first matching event
  regardless of color, so `ALERT_PRECEDENCE` lists every double-red before every red —
  otherwise a red could shadow a co-active double-red (e.g. Storm Warning).
- **Marine** alerts (Storm/Gale/Special Marine Warning, Small Craft Advisory) are
  issued for a beach's adjacent *marine* zone (e.g. `LMZ874`), not its land
  `nws_zone`. A US beach's `marine_zone` is resolved once by the marine-enrichment
  cron (an offshore probe of `api.weather.gov/zones?type=marine`) and matched from the
  **same** national `/alerts/active` fetch — no extra upstream call. Marine alerts are
  a bonus signal: a beach without a resolved `marine_zone` still flags on land alerts
  and waves. Canadian marine waters belong to ECCC, so marine enrichment is gated to
  US beaches (`nws_zone` set).
- NWS yellow **watches and advisories** (`NWS_FLOOR_PRECEDENCE`) map to yellow but are
  deliberately NOT part of the step-1 short-circuit. They are applied as a floor at
  step 6: they raise a green or unknown estimate to yellow, but never downgrade a
  higher color a warning, rip risk, or wave/wind already decided. This flooring is
  what keeps a 4 ft-wave red from ever being masked down to a watch/advisory yellow —
  the same masking concern that keeps ECCC watches unmapped, resolved for NWS by
  flooring rather than exclusion.
- Canadian beaches (the Great Lakes region set covers both the US and Canadian
  shorelines) use Environment and Climate Change Canada instead: ECCC issues **no**
  rip current, high surf, or beach hazards product, so step 1b maps a curated set of
  severe weather **warnings** for hazards dangerous to people in or on the water
  (`ECCC_ALERT_PRECEDENCE`, checked in that order). Watches are deliberately
  unmapped — a watch-to-yellow rule would let it mask a wave-height red under the
  strict precedence. Event names are exact-match against the GeoMet API's
  lowercase `alert_name_en` strings. Each beach is alert-checked by exactly one
  authority (NWS via its `nws_zone`, or ECCC via alert-region polygon containment
  once `eccc_zone` is set).
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
- A beach not yet enriched for either authority (both `nws_zone` and `eccc_zone`
  still `NULL`, so alerts and rip-current risk were never checkable) carries an
  explicit caveat appended to its `reason`: ` (Weather alerts not yet available
  for this beach)`. This adds no new color or table row — it only distinguishes
  "alerts checked, none active" from "alerts never checked" so a wave/wind-only
  estimate is never presentable as alert-verified. The caveat is omitted once the
  beach is enriched (and whenever an alert itself decided the color).

Every `FlagEstimate` carries: `color`, a human-readable `reason`, `trigger` (which
precedence branch decided the color: `nws-alert`, `eccc-alert`, `rip-current`,
`wave-height`, `wind`, `rip-current-low`, `no-data`, or `nws-floor` — the detail page renders
this as a natural-language explanation), `rules_version`, `official: false`, `sources`
(`{ label, url }` entries for the data actually used for that beach), and `updated`
(ISO 8601 UTC).

## Local development

    npm install
    npm run dev    # predev applies migrations/ to the local D1 automatically

The production D1 database and KV namespace already exist and their IDs are
committed in `wrangler.toml` — no resource creation is needed. `wrangler dev`
runs everything against local simulated storage regardless of those IDs. The local
database starts **empty** — populate it explicitly (see the seed steps below).

Then visit `http://localhost:8787/health`, `http://localhost:8787/`, and
`http://localhost:8787/api/beaches?bbox=-87.6,41.6,-82.3,46.6`.

Run tests (pure functions only, no network, no Workers runtime):

    npm test

### Environment variables

`.dev.vars` holds local secrets: `WEBAWESOME_NPM_TOKEN` and `FONTAWESOME_NPM_TOKEN`
are used by the Web Awesome Pro / Font Awesome Pro build tooling (`npm install`,
via `${VAR}` placeholders in `.npmrc` — export both before installing; never
hardcode a token in `.npmrc`), `WINDY_WEBCAM_API_TOKEN` is a
Worker **runtime** secret (`wrangler dev` loads `.dev.vars` into `env`
automatically), and `CLOUDFLARE_TOKEN` is the account API token used to
authenticate wrangler itself (export it as `CLOUDFLARE_API_TOKEN` before running
wrangler commands — this machine has no `wrangler login` session).

In production the webcam token is a Worker secret, set once with
`npx wrangler secret put WINDY_WEBCAM_API_TOKEN`. The webcam cron skips hydration
(with a log line) when the token is unset; everything else — NWS, Open-Meteo, GLOS
Seagull, and every official-source scraper — is unauthenticated.

The frontend `<head>` loads Web Awesome Pro from the account's version-pinned CDN
kit (`WA_KIT_BASE` in `src/frontend/render.js`) with matching
`wa-theme-matter wa-palette-mild` classes on `<html>`; a `WA_THEME_OVERRIDES` style
block swaps the kit's webfont downloads for system font stacks (no external font
requests), and Font Awesome icons resolve via `data-fa-kit-code` on `<html>`. The
pinned CDN files are immutable — theme edits in the kit builder must be re-copied
into `render.js` by hand. Light/dark follows the visitor's OS preference via a
blocking inline script (`src/frontend/colorSchemeScript.js`).

### Cron jobs

Six scheduled triggers run in production (see `wrangler.toml`). They are separate
crons on purpose: each upstream's rate-limit posture is independent, and a failure
in one job never starves another. Beach discovery and water-body classification are
**not** in this list — they run offline (see [Discovery and classification
(offline)](#discovery-and-classification-offline)).

- `0 * * * *` (hourly) — `runFlagRecompute`: reads beaches from D1 (up to
  `MAX_BEACHES_PER_RUN = 1000`, oldest `recompute_updated` first — enough to cover
  the whole beach directory every run, so no flag ever outlives its 2 h KV TTL waiting
  for a rotation turn), fetches the fast-changing safety signals (alerts and SRF
  rip-current risk) and reads each beach's stored wave inputs from KV (the
  `waveinput:` key the wave cron below writes) for the current wave height and the
  wind fallback — it performs **no** Open-Meteo or GLOS fetch itself. Both
  alert authorities are fetched nationally once per run and matched to beaches
  locally — one `api.weather.gov/alerts/active` fetch matched by `nws_zone`, and one
  GeoMet `weather-alerts` fetch matched per beach by alert-region polygon
  containment (for every `eccc_zone` beach) — so alert cost stays flat no matter how
  many zones or beaches a run covers. It runs
  them through `estimateFlag`, runs the official-source scrapers (once per distinct
  matched scraper, resolved per beach, with KV-backed health monitoring), and
  writes both to KV (`flag:` + beachId, `official:` + beachId) with a 7200 second
  TTL. A missing `waveinput:` key (wave cron hasn't run, or its data aged out) just
  means no wave input that run — the estimate falls back to wind or `unknown`, never
  a wrong flag.
- `15 */6 * * *` (6-hourly) — `runWaveRefresh`: owns **all** upstream wave and wind
  fetching. It fetches Open-Meteo marine wave heights, gap-fills Great-Lakes
  wave-null beaches from the nearest GLOS Seagull wave buoy (within 25 km, freshest
  observation within 2 h, `src/clients/glerl.js`), and fetches the Open-Meteo wind
  fallback for beaches still wave-null, then writes two KV shapes per beach at a 7 h
  TTL: `waveinput:` + beachId (the wave height + wind fallback the hourly estimate
  reads) and `waves:` + beachId (the detail page's 24 h forecast strip, only when a
  real hourly series exists). It runs 6-hourly rather than hourly because Open-Meteo's
  marine models only publish every 6–12 h; the fetches are paced (small concurrency
  window, a gap between batch waves, one backoff retry on a throttled batch) to stay
  under Open-Meteo's per-minute weighted rate limit. The 7 h TTL outlives the gap
  between runs, so a transient throttle leaves the strip showing slightly-older-but-
  still-model-current data rather than blanking it. A beach whose fetch merely failed
  is left untouched so its last-good KV survives.
- `17 3,9,15,21 * * *` (4x daily) — `runNwsEnrichment`: up to 75 beaches per run (≤300/day) with
  `nws_zone` NULL get their NWS forecast zone + gridpoint URL from
  api.weather.gov/points. A beach without `nws_zone` silently skips the alert and
  rip-current rules in `runFlagRecompute`, so draining this queue fast is a safety
  property — api.weather.gov publishes no numeric rate limit and 75 sequential
  polite requests per run is well within reasonable use. Queue order is fewest
  failed attempts first, then `RANDOM()`. Failures bump a per-beach
  `enrichment_attempts` counter (migration 0003); after 5 failed attempts a row is
  parked and no longer requeued, so permanently-404ing non-US points (the Canadian
  shoreline covered by the Great Lakes region set) can't starve US beaches.
- `29 4,10,16,22 * * *` (4x daily, offset ~1h from the NWS trigger) —
  `runEcccEnrichment`: the Canadian counterpart. Beaches NWS enrichment
  permanently parked (`nws_zone` NULL at the attempts cap) get their ECCC public
  forecast region name (e.g. "Windsor - Essex - Chatham-Kent") from the GeoMet
  `public-standard-forecast-zones` collection (`src/clients/eccc.js`, no auth or
  User-Agent required), up to 50 per run — one run covers the current ~50-row
  Ontario backlog. A row with `eccc_zone` set joins the hourly Environment
  Canada alerts check and stops carrying the alerts-unavailable caveat; rows no
  Canadian region matches park at their own 5-attempt cap (`eccc_attempts`,
  migration 0008).
- `23 1,7,13,19 * * *` (4x daily, offset from the other enrichment triggers) —
  `runMarineEnrichment`: US beaches (`nws_zone` set) get their adjacent NWS **marine
  forecast zone** id (e.g. `LMZ874`, `marine_zone`, migration 0010) via
  `resolveMarineZone` — an offshore probe of `api.weather.gov/zones?type=marine`
  (the beach point sits on land outside every marine polygon, so it samples the
  point then two 8-way rings ~5.5/11 km out, nearest hit wins). Up to 20 beaches/run
  (each costs up to ~17 sequential probe subrequests, kept well under the Workers
  cap). Once set, the hourly recompute matches **marine warnings** (Storm/Gale/
  Special Marine) and **Small Craft Advisory** from the same national `/alerts/active`
  fetch. A point no marine zone is near (inland) parks at a 5-attempt cap
  (`marine_attempts`); marine alerts are a bonus, so a parked beach still flags on
  land alerts and waves. Gated to US beaches — Canadian marine waters are ECCC's.
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

    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+3,9,15,21+*+*+*"   # NWS point enrichment
    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=29+4,10,16,22+*+*+*"  # ECCC zone enrichment
    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=23+1,7,13,19+*+*+*"   # NWS marine zone enrichment
    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=31+9+*+*+*"           # webcam hydration
    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=15+*/6+*+*+*"         # 6-hourly wave refresh
    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"            # hourly flag recompute

`npm run seed:enrich` / `npm run seed:eccc` / `npm run seed:marine` /
`npm run seed:webcams` / `npm run seed:waves` / `npm run seed:flags` wrap these
enrichment/wave/flag crons,
while `npm run seed` and `npm run seed:classify` run the offline discovery batch
against the local D1 (see [Discovery and classification
(offline)](#discovery-and-classification-offline)). The local database
starts empty — run
`npm run seed` once after a fresh checkout (it queries the live Overpass API and takes
a couple of minutes), then `npm run seed:enrich` a few times to give beaches their NWS
zones (and `npm run seed:eccc` afterwards for the Canadian rows NWS parks — note the
NWS attempts cap means a fresh local database needs ~5 `seed:enrich` passes before
Canadian rows become ECCC candidates), and `npm run seed:classify` to classify their
adjacent water bodies. Run `seed:waves` before `seed:flags` so the recompute has wave
inputs to read.

### Discovery and classification (offline)

Beach discovery and water-body classification run **outside** the Worker, in an
offline GitHub Actions batch job (`scripts/discovery-batch.js`, run on Deno). They
are split across **two independent workflows** so a slow or failing classification
run never blocks discovery: `.github/workflows/discovery.yml` runs daily (beach
discovery + stale-row reconciliation) and `.github/workflows/classify.yml` runs
hourly (water-body classification only, up to 25 beaches/run — ~600/day in short
Overpass bursts — draining the unclassified queue). This keeps the two-path invariant — the batch writes D1
out-of-band and the request path still reads only D1/KV — while sidestepping the
Worker's per-invocation subrequest caps. The batch reuses the discovery/classification
code verbatim (`src/discovery.js`, `src/clients/overpass.js`, `src/waterClass.js`),
emits one idempotent `.sql` delta, and bulk-loads it into D1 with
`wrangler d1 execute --remote --file`.

Overpass is fetched defensively: the named query carries a 90 s server-side timeout
and each per-tile fetch retries with bounded exponential backoff + jitter (3
attempts) to ride out public-Overpass 504 overload bursts. A tile that still fails is
simply deferred to the next scheduled run rather than aborting the batch. No extra
mirrors are used — the regional mirrors return empty for North America (unsafe), and
kumi shares Private.coffee's backend.

**Coverage.** Discovery is scoped to a curated set of coastal bounding boxes in
`src/regions.js` (`REGIONS`) that trace the entire Great Lakes shoreline — both the
US and the Canadian shores. Coastal boxes keep the discovery universe to actual
shoreline: a continental rectangle would sweep in thousands of inland-lake "beach"
elements that the classifier just drops, wasting Overpass query budget. Each region
box is auto-tiled at `TILE_MAX_SPAN_DEG = 2.0` deg before any Overpass query runs, so
box size is never the constraint — a large box simply becomes more tiles. The batch's
stale-row reconciliation only treats a D1 row as a delete candidate if
`pointInAnyRegion(lat, lon)` is true — the **sole delete path** — and that check
fails safe: shrinking or removing a box can only make the predicate false for more
rows, which only *removes* delete candidates (an editing mistake under-deletes rather
than over-deleting a real, enriched beach). **Expansion is additive**: bringing a new
coast online (Pacific / Gulf / Atlantic) means appending boxes to `REGIONS` —
discovery, tiling, and reconciliation all iterate the array and pick them up
automatically (see the placeholder section at the bottom of `src/regions.js`).

Classification matches each beach's adjacent water body to an allowlisted Great Lake
by wikidata QID (never by name), so inland-lake rows can be hidden. Expected
distribution across the Great Lakes region set is heavily `great_lake` / `inland` with
0 `ocean` (no saltwater coast yet). See `docs/offline-discovery.md` for the full design.

**Paid-plan assumption**: the cron subrequest budgets exceed the free plan's
50-subrequest ceiling (the paid plan allows 10,000 per invocation). The hourly
`runFlagRecompute` runs alert + SRF + scraper fetches plus up to ~700 KV
reads/writes (Ohio BeachGuard alone is 51 per-id GETs), and
the 6-hourly `runWaveRefresh` runs the paced Open-Meteo marine + GLOS buoy gap-fill + wind
fetches plus up to ~1200 `waveinput:`/`waves:` KV writes — each well under 10,000 but far
past the free ceiling. Production deployment assumes the Workers Paid plan. See `TODO.md`
for a free-plan-friendly fallback (lower `MAX_BEACHES_PER_RUN`).

## Deployment

Production runs at **https://swim.report** as a single
Cloudflare Worker with a custom-domain route, Workers Logs observability
(`head_sampling_rate = 1`), and Smart Placement — all configured in
`wrangler.toml`, which carries the real production D1 database and KV namespace
IDs (see PLAN.md section 8 for the authoritative config).

    export CLOUDFLARE_API_TOKEN=...                            # from .dev.vars (CLOUDFLARE_TOKEN)
    npx wrangler deploy --dry-run                              # validate first
    npm run deploy                                             # deploy
    npx wrangler d1 migrations apply swim-report --remote      # after adding a migration
    npx wrangler tail                                          # live logs

The production database starts empty on a fresh deploy — the offline **GitHub
Actions** batch (`scripts/discovery-batch.js`, split across
`.github/workflows/discovery.yml` for discovery and `.github/workflows/classify.yml`
for water-body classification) populates and classifies beaches (see [Discovery and
classification (offline)](#discovery-and-classification-offline)), then the
`17 3,9,15,21 * * *` enrichment runs drain the NWS-zone queue (with
`29 4,10,16,22 * * *` picking up the Canadian rows NWS parks) and the hourly cron
starts writing flags. There is no remote equivalent of the enrichment/wave/flag
`npm run seed:*` wrappers; either wait for the crons or run a local dev server with
`remote = true` bindings and trigger the scheduled-handler endpoints manually.

The discovery batch's prerequisites (repo secret `CLOUDFLARE_API_TOKEN`, migration
0009 applied remotely) and operational notes are in
[`docs/offline-discovery.md`](docs/offline-discovery.md).

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
just going dark. Only `null` counts as a failure: a scrape that fetched and
parsed cleanly but had nothing to report — a closure-only source (e.g.
Metroparks) with every beach Open — returns an empty result (shape (b) with
`sites: []`), which is a SUCCESS and resets the streak. A working source with
nothing to report must never return null, or it would raise a false alert.

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
           // Return null ONLY on genuine failure (fetch failed, page
           // unparseable, parse threw) — null is what the health tracker
           // counts as a failure. A clean parse with nothing to report (every
           // beach Open on a closure-only source) is a SUCCESS: return an
           // empty shape (b) result (`sites: []`), NEVER null. An empty sites
           // list resolves to no site for every beach (no KV written) and so
           // flows through harmlessly. NEVER throw, NEVER guess a color — omit
           // ambiguous sites instead.
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
