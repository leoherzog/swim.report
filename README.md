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
  own published flag status page, when Swim Report has a working scraper for that
  beach. Only South Haven, Michigan is supported today.

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
          "lat": 42.401,
          "lon": -86.288,
          "nws_zone": "MIZ071",
          "osm_id": "node/123456"
        }
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
        "rules_version": "1.1.0",
        "official": false,
        "sources": [
          { "label": "ECMWF Wave Forecast via Open-Meteo",
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

When Cloudflare's IP-derived geolocation is available on the request (`request.cf`),
the beach list is sorted by approximate distance to the visitor and each row shows a
rough mileage label; the page says so explicitly. Without geolocation the list falls
back to alphabetical order. `GET /?near=lat,lon` overrides the detected location
(useful in local dev, where `request.cf` has no coordinates); an invalid `near` value
falls back to alphabetical order. Nothing about the visitor's location is stored.

All `/api/*` responses set `content-type: application/json` and
`cache-control: public, max-age=60`. HTML responses set
`content-type: text/html; charset=utf-8`.

## Estimation rules

Flag estimation is a pure, deterministic, versioned function (`estimateFlag` in
`src/rules.js`) — no ML, no LLM, no network access, no clock access. The current
`rules_version` is `1.1.0`. Given the same inputs it always returns the same output.

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
- An empty alerts array (`[]`, i.e. a successful fetch with zero active alerts) does
  not by itself count as "usable data" — with everything else null the result is
  still `unknown`, not `green`.

Every `FlagEstimate` carries: `color`, a human-readable `reason`, `trigger` (which
precedence branch decided the color: `nws-alert`, `rip-current`, `wave-height`,
`wind`, `rip-current-low`, or `no-data` — the detail page renders this as a
natural-language explanation), `rules_version`, `official: false`, `sources`
(`{ label, url }` entries for the data actually used for that beach), and `updated`
(ISO 8601 UTC).

## Local development

    npm install
    npx wrangler d1 create swim-report        # then paste the database_id into wrangler.toml
    npx wrangler kv namespace create FLAGS     # then paste the id into wrangler.toml
    npx wrangler d1 migrations apply swim-report --local
    npm run dev

Then visit `http://localhost:8787/health`, `http://localhost:8787/`, and
`http://localhost:8787/api/beaches?bbox=-87.6,41.6,-82.3,46.6`.

Run tests (pure functions only, no network, no Workers runtime):

    npm test

### Environment variables

`.dev.vars` holds local secrets used by the Web Awesome Pro build tooling
(`WEBAWESOME_NPM_TOKEN`) and is read by `npm install`/build steps, not by the Worker
runtime. The Worker itself needs no runtime secrets today — the NWS and Open-Meteo
clients are unauthenticated, and the South Haven scraper is a plain unauthenticated
GET.

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

Two scheduled triggers run in production (see `wrangler.toml`):

- `0 * * * *` (hourly) — `runFlagRecompute`: reads beaches from D1, fetches NWS
  alerts/SRF and Open-Meteo wave/wind data, runs them through `estimateFlag`, runs the
  official-source scrapers, and writes both to KV (`flag:` + beachId,
  `official:` + beachId) with a 7200 second TTL.
- `47 8 * * *` (daily, ~03:47 America/New_York) — `runOverpassSync`: queries the
  Overpass API for named beaches in the pilot bbox, upserts them into D1, and
  enriches up to 30 beaches/night with their NWS zone + gridpoint URL.

`wrangler dev` does not run cron triggers on a schedule; trigger them manually while
developing with `wrangler dev --test-scheduled` and a request to
`/__scheduled?cron=0+*+*+*+*` (or the daily cron string), or call the exported
`scheduled` handler directly from a small script.

**Paid-plan assumption**: the hourly job's subrequest budget (~360 subrequests/run for
the pilot region: alert + SRF + wave + wind fetches plus up to 250 KV writes) exceeds
the free plan's 50-subrequest ceiling. Production deployment assumes the Workers Paid
plan. See `TODO.md` for a free-plan-friendly fallback (lower `MAX_BEACHES_PER_RUN`).

## How to add a new official-source scraper

Official flag data (`official: true`) comes from `src/officialSources/`, a small
scraper registry. To add support for a new city/park system:

1. Create `src/officialSources/<yourScraper>.js` exporting an object matching the
   scraper contract:

       export const yourScraper = {
         id: "stable-kebab-case-id",
         label: "Human-readable operator name",
         url: "https://the-page-you-scrape",
         matches: function (beach) {
           // BeachRow -> boolean, pure. Match by name regex and/or a lat/lon
           // bounding box that covers every OSM beach row for that town.
         },
         scrape: async function (nowIso) {
           // Fetch the page, parse it, and return either:
           //   { color, reason, official: true, scraperId: id, source: url,
           //     sources: [url], updated: nowIso }
           // or null on any fetch/parse failure. NEVER throw.
         }
       };

   Keep any HTML-parsing logic in a separate, pure, exported function (see
   `parseSouthHavenHtml` in `src/officialSources/southHaven.js`) so it can be unit
   tested with fixture HTML strings and no network access.

2. Register it in `src/officialSources/index.js`:

       import { yourScraper } from "./yourScraper.js";
       export const scrapers = [southHaven, yourScraper];

   `findScraper(beach)` returns the first scraper (in registry order) whose
   `matches(beach)` is true, so put more specific matchers earlier if bounding boxes
   could ever overlap.

3. Add tests under `test/` covering the pure parse function and `matches()` with a
   few representative `BeachRow` fixtures (matching name, matching bbox, and a
   beach that should NOT match).

4. That's it — the hourly cron (`runFlagRecompute` in `src/index.js`) automatically
   discovers every beach matched by your scraper, calls `scrape(nowIso)` once per
   distinct scraper per run, and writes `official:` + beachId to KV for every matched
   beach. No other code changes are required.

Official scrapes, like estimates, run cron-side only and are cached in KV — the
request path never scrapes a page live.
