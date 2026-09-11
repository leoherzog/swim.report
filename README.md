# Swim Report (swim.report)

Swim Report estimates beach hazard flag status (green / yellow / red / double-red /
unknown) for US and Canadian beaches on the Great Lakes and the Pacific, Gulf, Atlantic and
Alaskan coasts using public NOAA/NWS and Environment and Climate Change Canada (ECCC) data, and — where a municipality publishes one —
surfaces the real official flag alongside it.

## Estimated vs. official

**Estimated — not the official flag status. Always obey posted flags and lifeguards.**

Every color shown is either an **ESTIMATE** (`official: false`) — a deterministic, versioned
guess computed from NWS alerts (or Environment Canada alerts for Canadian beaches), NWS Surf
Zone Forecast rip current risk, and NOAA wave-model wave and wind data — or an **OFFICIAL**
reading (`official: true`), scraped from a municipality's or health department's own published
status page or API where Swim Report has a working scraper (see [Official
sources](#official-sources)). An estimate is not a substitute for the flag actually flying at
the beach. The two are rendered in visually distinct UI elements everywhere they appear, and
the API keeps them in separate fields so a client can never confuse them.

Only **ocean and Great Lakes** beaches are shown, because beach flags exist only for those
waters. Every beach is classified by its adjacent water body and inland-lake rows are hidden:
classified and filtered out, never deleted. Discovery and classification run in the offline
GitHub Actions batch, not in the Worker; see [Discovery and classification
(offline)](#discovery-and-classification-offline).

This is a personal weather-data project, not a lifeguard service. It can be wrong and it can be
stale. If a beach has a physical flag posted, that flag — and any lifeguard on duty — is the
actual authority, not this site.

## API

The HTTP request path never calls any upstream API. It reads only pre-computed data from D1
(the beach directory, and the estimates, official readings, advisories, observations and wave
forecast series beside it in `beach_state`) and KV (buoy water temperatures),
kept fresh by the scheduled crons and the offline NOAA wave cycle.

### `GET /api/beaches.geojson`

Returns a GeoJSON `FeatureCollection` of **every** flag-worthy beach in the D1 directory (no
bounding box, no parameters). Results exclude confirmed-inland beaches; still-unclassified
rows remain visible during backfill. The response is location-independent and cacheable, so
the homepage map fetches it once on load and hands it to a single MapLibre GeoJSON source that
renders it as a coast highlight when zoomed out and as flag icons from zoom 9 up.

Example response:    {
      "type": "FeatureCollection",
      "builtAt": "2026-07-04T15:00:03.000Z",
      "features": [
        {
          "type": "Feature",
          "geometry": { "type": "Point", "coordinates": [-86.288, 42.401] },
          "properties": {
            "id": "osm-node-123456",
            "name": "Holland State Park",
            "flag": "green"
          }
        }
      ]
    }

The response is one D1 statement over scalar columns — each beach's coordinates beside the
color, timestamp and expiry of its estimate and its official record — so serving it costs one
read no matter how many beaches the table holds, and the color is decided per row at read
time by the same rule the detail page uses. `builtAt` is the newest live estimate timestamp
in the response, or `null` when no beach carries one, carried as a top-level GeoJSON foreign
member so a stalled recompute is visible from the endpoint itself.

Each feature's geometry is a `Point` in GeoJSON `[longitude, latitude]` order — lon first.
`properties.name` is the beach's display name: the containing park name from OpenStreetMap
when the beach sits inside a named park, otherwise the beach's own name.

`properties.flag` is the beach's display flag as a keyword — `green`, `yellow`, `red` or
`unknown`. A scraped official reading wins over the estimate, which wins
over `unknown`; `double-red` collapses to `red`; a missing or expired reading maps to
`unknown`, never a green default. One exception keeps a point-in-time official reading from
going stale on the map: once the official record is more than 2 h old, the more severe of the
official and estimated colors wins, so a fresher estimate can **raise** the marker but never
lower it. List rows, nearby cards and the detail page show the identical color, each with an
OFFICIAL badge only when the scraped record supplied it. Beaches with non-finite coordinates
are omitted.

### `GET /api/flag/:beachId`

Returns the stored estimate and official reading (if any) for one beach, read straight from
D1. Either field may be `null` if there is no live record (a missing or expired one just
means "no data").

The response also carries `display`, the flag swim.report shows for the beach:
`display.color` is `green`, `yellow`, `red`, `double-red` or `unknown`, and `display.source`
names the record that supplied it — `official`, `estimate`, or `none` when the color is
unknown. It follows the `properties.flag` rule without collapsing double-red, and never
alters either record. Once the official record is more than 2 h old it is credited only while
strictly more severe than the estimate; on a tie `display.source` is `estimate`.

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
        "rules_version": "1.8.0",
        "official": false,
        "waveHeightFt": 2.62,
        "alertDetails": [
          { "event": "Beach Hazards Statement",
            "onset": "2026-07-04T22:00:00.000Z",
            "ends": "2026-07-05T12:00:00.000Z",
            "description": "* WHAT...High waves and dangerous currents expected. ...",
            "instruction": "Remain out of the water to avoid hazardous swimming conditions.",
            "area": "Door; Kewaunee; Manitowoc",
            "sender": "NWS Green Bay WI" }
        ],
        "alertsAt": "2026-07-04T15:00:03.000Z",
        "ripCurrentRisk": null,
        "sources": [
          { "label": "NWS Alerts",
            "url": "https://api.weather.gov/alerts/active?zone=WIZ022" },
          { "label": "NOAA GFS Wave Model",
            "url": "https://polar.ncep.noaa.gov/waves/" }
        ],
        "updated": "2026-07-04T15:00:03.000Z"
      },
      "official": null,
      "display": { "color": "yellow", "source": "estimate" }
    }

The statement's onset is still ahead of `alertsAt`, so it is echoed for the detail
page to show but did not decide the wave-height yellow.

Unknown `beachId` (no matching D1 row) returns `404`. A confirmed-inland beach
returns `404` too — it is not flag-worthy, so it is treated as not found:

    { "error": "beach not found" }

### `GET /health`

Liveness check, no upstream/DB access:

    { "ok": true }

### Static brand assets

`GET /favicon.svg`, `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`,
`/manifest.webmanifest` and `/og/{green,yellow,red,double-red,unknown}.png` are committed
files under `public/`, served by Workers static assets before the Worker runs. No Worker
code and no binding is involved. Regenerate them with `node scripts/build-brand-assets.js`
and commit the result.

The `og/` files are the share cards, one per display flag color. They carry the flag graphic,
Font Awesome's solid flag glyph, on a wave background and no text, so the estimated-or-official wording lives only in a page's
title and description and can never disagree with the picture.

### `GET /` and `GET /beach/:beachId`

Server-rendered HTML pages: a beach list and a beach detail page, built entirely from D1,
plus the buoy water temperature in KV (see the frontend contract in `src/frontend/render.js`). Both exclude
confirmed-inland beaches: they are absent from the list and search, and a detail page for one
returns `404`. Only ocean and Great Lakes rows, plus still-unclassified rows during backfill,
are shown. The list page's map area holds a skeleton placeholder until the map's `load` event
fires, so it is never a blank framed box while tiles arrive.

The detail page opens with a **flag hero**: the beach name behind its flag icon, the flag's
label, and a badge naming the record that supplied that color — OFFICIAL for a posted flag,
ESTIMATE for the estimate, none when the status is unknown — over a background washed 12% in that flag's own color. The
hero carries a copy-link button and, where the browser supports `navigator.share`, a Share
button. Directly under it, up to five **at a glance** tiles summarize the waves now, the
water temperature, the rip-current risk, the count of active alerts and the next sunrise or
sunset. A reading nobody published gets no tile, so the row carries only answers, and a beach
with no readings at all shows no section. The full official and estimate cards follow
unchanged.

The sun tile is computed in the Worker from the beach's coordinates (`src/frontend/sun.js`,
delegating to the `suncalc` library, no upstream call), and shown on the viewer's own clock by
`<wa-format-date>`. Until that component upgrades, the served `<time>` element shows the same
instant in UTC, because a beach's longitude fixes its solar day but not the clock posted
there. Inside the polar circles, where there is no next event, the tile is omitted.

Under the flag's label the hero carries a one-sentence **plain-language verdict** built from
the same estimate the flag card explains — "Calm water, no alerts.", "Beach Hazards Statement
in effect; high rip current risk." A sentence names a flag color only when it also says who
decided it, so a posted flag reads "Water closed by the posted flag." while an estimate names
its signals instead, and a beach with nothing usable reads "No data yet for this beach."
After the at-a-glance tiles, a collapsed **What the flags mean** disclosure gives one line per
color — green, yellow, red, double red and unknown — and says that estimated flags are
computed here from forecasts and alerts, official flags are posted at the beach, and posted
flags and lifeguards always win.

When a water-quality advisory stands for the beach, a **water-quality callout** renders
directly under the estimate card, between it and the wave forecast — see the raise-only floor
below.

Last on the detail page, after the wave map and the webcam, come up to three **nearby
beaches** as cards: the nearest flag-worthy rows within 50 mi, each with the same flag chip,
and OFFICIAL badge when earned, that a list row carries, its distance, and a link. The section is omitted
when nothing lies within range.

The detail page includes a **Wave forecast** section: a "now" wave-height stat (from the
estimate's structured `waveHeightFt`) plus a horizontal strip of the next up-to-24 hours of
forecast wave height, colored and labeled by the same per-water-class thresholds the rules engine uses, gray
for hours with no model data. The strip is a flex row of proportionally sized segments, one per
run of consecutive same-band hours, built server-side from the stored 24-hour series in the
beach's `beach_state` row. Each
segment carries a `wa-tooltip` and a matching `aria-label` naming its band and hour range ("2–4
ft waves (estimated) — +5 h to +8 h"), and a visually-hidden prose summary keeps the forecast
readable by assistive tech. Active hazards overlay the strip as a lane of labeled bands: each
flag-relevant NWS alert spans its onset-to-ends period, and a HIGH or MODERATE rip-current risk
renders a full-window band, since the SRF product carries no parseable end time. The section
carries the same ESTIMATE badge as the estimate card and is omitted for beaches with no wave
series.

That same badge-carrying line ends with a one-sentence estimated outlook over the strip —
"Stays under 2 ft for the next 21 hours.", "Rises to 2–4 ft in about 5 hours.", "Drops under 2
ft in about 3 hours." — using the strip's own band labels, so it is omitted for beaches with no
series. Below the strip, the hour ticks are rendered as relative offsets ("Now", "+6 h", "+24
h"), since no per-beach timezone exists; each carries the instant it marks, and a small inline
script rewrites them to the viewer's own clock and notes that it did. With JavaScript off the
relative labels stand on their own.

The strip starts at the current hour, marked by a hairline on its left edge, and fills in from
there on load, one segment at a time. Navigating between the list and a detail page morphs the
row (or a nearby-beach card) into the detail hero through a native cross-document view
transition. Both are decoration: they run only under `prefers-reduced-motion: no-preference`,
need no library, and every page is complete and correct without them. No flag icon ever
animates — a moving flag would imply live wind.

When two or more wave models resolve for a beach, the section also shows each model's current
reading ("NOAA Great Lakes 2.6 ft · NOAA GFS 2.4 ft") and a collapsed line chart of the
per-model 24-hour series. The estimate still derives from the composite first-finite-model
series; `byModel` is stored for transparency and future calibration, not for averaging.

When Cloudflare's IP-derived geolocation is available (`request.cf`), the beach list is sorted
by approximate distance to the visitor, each row shows a rough mileage label, and the list is
headed **Nearby**. Without geolocation the list falls back to alphabetical order and the
heading is absent.
`GET /?near=lat,lon` overrides the detected location, useful in local dev where `request.cf`
has no coordinates; an invalid value falls back to alphabetical. Nothing about the visitor's
location is stored. The located list really is the nearest beaches no matter where the visitor
sits relative to the table: the server narrows to the 500 nearest candidates **in SQL**, then
re-sorts those with the exact haversine before slicing to 100.

`GET /?q=term` runs a case-insensitive substring search over the **entire** directory
server-side, not just the rows the page renders, matching both the display name
(`COALESCE(park_name, name)`) and the beach's own name; user-supplied `LIKE` wildcards are
escaped so the term matches literally. Results are capped at 100 rows and combine with
`near=`: when a location resolves, matches are filtered first and then distance-sorted. Empty
or whitespace-only `q` is ignored. The on-page search box submits this as a `GET` form while
also filtering the rendered rows client-side as you type.

Each list row shows the beach's flag — the same color as its map marker and detail page — as
a chip, followed by an OFFICIAL badge when a posted flag supplied it, and a border in that
color on its leading edge, so the list scans as a color-coded feed; unknown rows show gray. A
**Green flags only** switch above the list hides every row whose flag is not green. It is browser-side and works over the
rendered rows alone, so it means green among the beaches on this page, not across the whole
table. It combines with the search term in one pass, and remembers its position between visits,
re-applying it as the page loads; with JavaScript off it is inert and every row shows.

`GET /?ids=osm-way-1,osm-node-2` renders the same list page for exactly those beaches, in
the order given. At most 10 ids are read, each must match the `osm-<node|way|relation>-<id>`
format, and ids that are malformed, unknown or not flag-worthy are skipped silently, so a
list nothing matches renders the honest "No beaches match those ids." rather than the
empty-database copy. The mode ignores `q`, `near` and the visitor's IP location, so the
response depends only on the URL and is cacheable. It is what the **Your Beaches** section
fetches.

**Your Beaches.** The list page carries a saved-and-recently-viewed section above the main
list, filled in the browser from `localStorage` — no accounts, no cookie, and nothing about
the lists is stored server-side beyond the bounded `?ids=` request. The detail page's
**Save** button toggles a beach in the saved list, and every detail view records the beach in
a recently-viewed list of the last 8. The section shows saved beaches first, then recently
viewed ones that are not saved, using the server's own rows so they search and filter with
the rest of the list. Rows already rendered in the list below are reused as they are, so the
`?ids=` request is made only for the beaches the page does not already hold, and often not at
all. With JavaScript off the Save button never appears and the section stays hidden; a failed
fetch leaves it hidden too.

**The staleness warning.** When a flag card's `updated` time is older than its staleness
horizon, the card carries a visible warning callout reading "Stale data — last updated
<em>N hours ago</em>". The horizon is 2 hours by default, matching the hourly recompute, and
the estimate card always uses that default. An official card may declare a longer horizon when
its source publishes on a slower schedule, and for a point-in-time reading the gap between 2
hours and that horizon is filled by a neutral note instead. See [How to add a new
official-source scraper](#how-to-add-a-new-official-source-scraper) for the `staleMs` and
`readingNote` fields. The wave forecast strip has its own 8 hour threshold, since the marine
models publish every 6–12 hours.

All `/api/*` responses set `content-type: application/json`, except
`GET /api/beaches.geojson`, which sends the RFC 7946 GeoJSON media type
`application/geo+json; charset=utf-8`; HTML responses set `text/html; charset=utf-8`.
Responses are cached at Cloudflare's edge (Workers Cache, `[cache]` in `wrangler.toml`) under
an explicit per-route policy: successful API, beach-detail and `?ids=` responses send
`cache-control: public, max-age=60, stale-while-revalidate=600, stale-if-error=600`;
`GET /api/beaches.geojson` sends `public, max-age=60, stale-while-revalidate=60,
stale-if-error=600`, a shorter revalidate window than the rest because its origin is a single
D1 scan and a longer one would only add to the flag-flip latency the map exists to show; the
`/api/flag` 404 sends plain `public, max-age=60`; the home page, `/health` and error
responses send `no-store`, because the home page is personalized by IP-derived location and
must never be shared across visitors. The `near=` and `ids=` modes are the exceptions: neither
reads that location, so both are fully determined by the URL.

## Estimation rules

Flag estimation is a pure, deterministic, versioned function (`estimateFlag` in
`src/rules.js`) — no ML, no LLM, no network access, no clock access. The current
`rules_version` is `1.8.0`, and the same inputs always return the same output.

Precedence is strict: the first matching rule (steps 1–5) wins, top to bottom. Steps 6, 6b and
7 are raise-only *floors* applied after a color is decided — an NWS severe-weather
watch/advisory, an ECCC below-gale marine product, and an active water-quality advisory — each
raising a lower result but never downgrading a higher color.

| # | Signal | Source | Condition | Color | Reason |
|---|--------|--------|-----------|-------|--------|
| 1 | NWS alert in effect | `api.weather.gov/alerts/active` (land matched by `nws_zone`, marine by `marine_zone`), onset at or before the run and ends after it | Event = "Tsunami Warning", "Hurricane Warning", "Storm Surge Warning", "Extreme Wind Warning", "Tornado Warning", "High Surf Warning", marine "Hurricane Force Wind Warning", or marine "Storm Warning" | double-red | "Active NWS alert: &lt;event&gt;" |
| 1 | Active NWS alert | same | Event = "Tropical Storm Warning", "Tsunami Advisory", "Severe Thunderstorm Warning", "Beach Hazards Statement", "High Surf Advisory", "Rip Current Statement", "High Wind Warning", marine "Gale Warning", marine "Special Marine Warning", "Lakeshore Flood Warning", or "Coastal Flood Warning" | red | "Active NWS alert: &lt;event&gt;" |
| 1b | Active ECCC alert (Canadian beaches) | `api.weather.gc.ca` `weather-alerts` matched by alert-region polygon; `marineweather-realtime` matched by marine-zone polygon | Event = "tornado warning", "storm surge warning", or marine "storm warning" (≥ 48 kt) | double-red | "Active Environment Canada alert: &lt;event&gt;" |
| 1b | Active ECCC alert | same | Event = "squall warning", "waterspout warning", "severe thunderstorm warning", marine "gale warning" (≥ 34 kt), or "wind warning" | red | "Active Environment Canada alert: &lt;event&gt;" |
| 2 | Rip current risk | NWS Surf Zone Forecast (SRF) text product, regex-parsed | HIGH | red | "NWS surf zone forecast rip current risk: HIGH" |
| 2 | Rip current risk | same | MODERATE | yellow | "NWS surf zone forecast rip current risk: MODERATE" |
| 3 | Wave height | NOAA wave-model HTSGW (m converted to ft, `m * 3.28084`), thresholds by `water_class` | Great Lakes and every non-ocean class: >= 4 ft / >= 2 ft / < 2 ft non-null. `ocean`: >= 6 ft / >= 3 ft / < 3 ft (provisional, uncalibrated) | red / yellow / green | "Estimated wave height X.X ft (at or above R ft \| at or above Y ft \| below Y ft)" with the deciding threshold quoted |
| 4 | Wind (fallback only when wave height is null) | NOAA wave-model WIND (m/s converted to mph, `m/s * 2.2369362920544`); gusts are always null | sustained >= 25 mph or gust >= 35 mph / sustained >= 15 mph or gust >= 25 mph / below both | red / yellow / green | "No wave data; wind S mph sustained, G mph gusts (at or above 25 mph sustained or 35 mph gust threshold \| at or above 15 mph sustained or 25 mph gust threshold \| below advisory thresholds)" |
| 5 | Terminal fallback | rip current risk LOW, nothing else usable | — | green | "NWS surf zone forecast rip current risk: LOW; no wave or wind data available" |
| 5 | Terminal fallback | no usable data anywhere | — | unknown | "No wave or weather data is available for this beach yet" |
| 6 | NWS yellow watch/advisory floor | `api.weather.gov/alerts/active` (land `nws_zone` / marine `marine_zone`) | Event in {Hurricane, Tropical Storm, Storm Surge, Tsunami, Tornado, Severe Thunderstorm, High Wind, Hurricane Force Wind} Watch or {Wind, Lake Wind, Small Craft, Lakeshore Flood, Coastal Flood} Advisory, **and** steps 1–5 decided green/unknown | yellow | "Active NWS alert: <event>" |
| 6b | ECCC marine yellow floor (Canadian beaches) | `marineweather-realtime` collection | Event = "strong wind warning" or "marine weather advisory", **and** the decided color is green/unknown | yellow | "Active Environment Canada alert: <event>" |
| 7 | Water-quality advisory floor (raise-only) | `src/wqFloor/` registry (E. coli / bacteria / HAB advisories) | An active advisory whose floor color (yellow or red) **outranks** the color steps 1–6b decided | yellow or red | "Water-quality advisory (<source>): <detail>" |

Notes on the precedence design (see `src/rules.js` and `test/rules.test.js`):

- An alert counts only while it is in effect: its onset at or before the instant the estimate
  is made and its ends after it (`alertsInEffect` in `src/rules.js`, applied where both crons
  build their inputs). NWS publishes products such as a Beach Hazards Statement hours ahead
  of their onset, and until then the product is a forecast of a hazard, not the hazard: it
  neither short-circuits at step 1 nor floors at step 6, and the same holds for ECCC. It
  still rides in the estimate's `alertDetails`, so the detail page's hazard lane draws it as
  a band that starts later, and `alertsAt` records the instant the check was made. A missing
  or unreadable timestamp keeps the alert rather than hiding it. The ten-minute alerts refresh
  treats an onset arriving or an ends passing exactly like a new issuance.
- Alerts are checked in `ALERT_PRECEDENCE` order, not the order they appear in the NWS
  response. **Ordering constraint:** the step-1 loop takes the first matching event regardless
  of color, so the list must place every double-red before every red — otherwise a red could
  shadow a co-active double-red such as a Storm Warning. Every step-1 event is red or
  double-red, so step 1 can only raise the flag, never lower it.
- **Marine** alerts (Hurricane Force Wind / Storm / Gale / Special Marine Warning, Hurricane
  Force Wind Watch, Small Craft Advisory) are issued
  for a beach's adjacent *marine* zone, not its land `nws_zone`. A US beach's `marine_zone` is
  derived once offline by the discovery batch and matched from the **same** national
  `/alerts/active` fetch. They are a bonus signal: a beach with no resolved `marine_zone` still
  flags on land alerts and waves. Canadian marine waters belong to ECCC, so the derivation is
  gated to US beaches.
- NWS yellow **watches and advisories** (`NWS_FLOOR_PRECEDENCE`) are deliberately not part of
  the step-1 short-circuit. As a floor at step 6 they raise a green or unknown estimate to
  yellow but never downgrade a color already decided, which keeps a 4 ft-wave red from being
  masked down to a watch yellow.
- Canadian beaches use ECCC, which issues no rip current, high surf or beach hazards product,
  so step 1b maps a curated set of severe-weather **warnings** for hazards dangerous to people
  in or on the water. Watches are deliberately unmapped, since a watch-to-yellow rule could
  mask a wave-height red. Event names are exact-match against GeoMet's lowercase
  `alert_name_en` strings, and each beach is alert-checked by exactly one authority. ECCC
  marine warnings come from a **separate**, disjoint collection (`marineweather-realtime`,
  `src/clients/ecccMarine.js`) concatenated onto the land matches exactly as the US path does;
  Strong Wind Warning and Marine Weather Advisory are yellow floors at step 6b instead.
- **Water-quality advisory floor (raise-only)** — step 7. Bacteria and HAB advisories are a
  *different axis* from surf hazard: a clean reading says nothing about surf, so it may never
  pull a hazard estimate down. An active advisory may raise a flag up to its floor color using
  the same worst-of logic as the NWS/ECCC floors; a clean or absent reading has zero effect. It
  is baked into the estimate (`official: false`) and is never an official override.
- Rip current risk beats wave height in both directions: a MODERATE rip risk yields yellow even
  with a 6 ft wave reading.
- Wind is used **only** as a fallback when the wave reading is null, never blended with it.
  Gust is always null on this data source, so the wind red test is sustained speed alone and
  the reason string renders `n/a` for the gust.
- A wave model masks land, so the offline sampler resolves each beach to the nearest wet cell
  within a per-grid cap. A beach with no wet cell inside its cap has no wave reading at all,
  and `sources` names whichever grid supplied the number.
- An empty alerts array — a successful fetch with zero active alerts — is not by itself usable
  data. With everything else null the result is still `unknown`, not `green`.
- A beach not yet enriched for either authority carries a caveat appended to its `reason`:
  ` (weather alerts are not checked here yet)`. It adds no color and no table row; it
  only distinguishes "alerts checked, none active" from "alerts never checked", so a wave-only
  estimate is never presentable as alert-verified. It is omitted once the beach is enriched.

Every `FlagEstimate` carries `color`, a human-readable `reason`, `trigger` (the precedence
branch that decided the color: `nws-alert`, `eccc-alert`, `rip-current`, `wave-height`, `wind`,
`rip-current-low`, `no-data`, `nws-floor`, `eccc-floor` or `wq-floor`, which the detail page
renders as a natural-language explanation), `rules_version`, `official: false`, `sources`
(`{ label, url }` entries for the data actually used for that beach), `updated` (ISO 8601
UTC), and the structured echoes `waveHeightFt`, `alertDetails` (every matched alert, upcoming
ones included, each with the issuing office's own `description`, `instruction`, `area` and
`sender` where that authority publishes them), `alertsAt` (the instant the alerts were judged
in effect at) and `ripCurrentRisk`. The alert text is display-only: the detail page shows it
under the estimate card, and no rule reads it.

## Local development

    npm install
    npm run dev    # predev applies migrations/ to the local D1 automatically

The production D1 database and KV namespace already exist and their IDs are committed in
`wrangler.toml`, so no resource creation is needed; `wrangler dev` runs against local simulated
storage regardless. The local database starts **empty** — populate it with the seed steps
below. Then visit `http://localhost:8787/health`, `http://localhost:8787/` and
`http://localhost:8787/api/beaches.geojson`. `npm test` runs the suite (pure functions only, no
network, no Workers runtime).

### Environment variables

`.dev.vars` holds local secrets. `WEBAWESOME_NPM_TOKEN` and `FONTAWESOME_NPM_TOKEN` are
build-tooling credentials for `npm install`, referenced as `${VAR}` placeholders in `.npmrc` —
export both before installing, and never hardcode a token in `.npmrc`.
`WINDY_WEBCAM_API_TOKEN` is a Worker **runtime** secret, which `wrangler dev` loads into `env`
automatically. `CLOUDFLARE_WORKERS_EDIT_TOKEN` authenticates wrangler itself: export it as
`CLOUDFLARE_API_TOKEN` before any wrangler command that talks to the Cloudflare API, since this
machine has no `wrangler login` session. It lives in `.dev.vars` only and is deliberately never
a repository secret, so no CI job can change the code running at swim.report. The GitHub
Actions pipelines use their own narrower tokens: `CLOUDFLARE_D1_EDIT_TOKEN`,
`CLOUDFLARE_D1_READ_TOKEN` and the `CLOUDFLARE_R2_ACCESS_KEY` /
`CLOUDFLARE_R2_SECRET_ACCESS_KEY` pair.

In production the webcam token is a Worker secret, set once with
`npx wrangler secret put WINDY_WEBCAM_API_TOKEN`. The webcam cron skips hydration (with a log
line) when it is unset; everything else is unauthenticated.

The frontend `<head>` loads Web Awesome Pro from the account's version-pinned CDN kit
(`WA_KIT_BASE` in `src/frontend/render.js`) with matching `wa-theme-matter wa-palette-mild`
classes on `<html>`; a `WA_THEME_OVERRIDES` block swaps the kit's webfont downloads for system
font stacks, and Font Awesome icons resolve via `data-fa-kit-code`. The pinned CDN files are
immutable, so kit-builder theme edits must be re-copied into `render.js` by hand. Light and
dark follow the visitor's OS preference via a blocking inline script
(`src/frontend/colorSchemeScript.js`).

Every page's `<head>` also carries the site identity: the SVG favicon, the apple-touch icon,
the web manifest, and two media-queried `theme-color` metas holding the light and dark
surface colors. The list and detail pages add a `<meta name="description">`, a
`<link rel="canonical">` against the constant `SITE_ORIGIN`, and the Open Graph and Twitter
card set. A detail page's description states the flag color the page displays and always says
whether it is estimated or official, or that the status is unknown — the share cards carry no
text, so the two can never disagree. The error page deliberately gets neither a canonical link
nor a share card.

### Cron jobs

Six scheduled triggers run in production (`wrangler.toml`'s `crons` array). They are
separate crons on purpose: each upstream's rate-limit posture is independent, and a
failure in one job never starves another. Beach discovery, water-body classification and
the `marine_zone` derivation are not in this list — they run offline (see [Discovery and
classification (offline)](#discovery-and-classification-offline)).

- `7 * * * *` (hourly) — `runFlagRecompute`: reads up to `MAX_BEACHES_PER_RUN = 3000` beaches
  from D1, ordered hot-first then oldest-`recompute_updated`-first. A beach viewed within
  `HOT_VIEW_WINDOW_MS` (7 days, tracked by the `last_viewed` demand stamp) is covered every
  run; cold rows rotate through the remaining budget, and the stored estimate's 25200 second
  lease spans several rotation turns plus a lost run, so a cold beach keeps showing its last
  reading rather than dropping to "no data". The detail page marks that reading stale past
  2 h; the list chip and the map marker carry no age signal, so a rotation-old color reads
  there like a fresh one. It fetches the
  fast-changing safety signals (alerts and SRF rip-current risk) and reads each beach's wave
  inputs off the same `beach_state` row it is about to write, indexing that record's
  24-hour series at the hour it is estimating — it performs **no** wave or wind fetch itself
  and no per-beach read at all. Both alert authorities are fetched nationally once per run and matched
  locally, so alert cost stays flat no matter how many beaches a run covers: one
  `api.weather.gov/alerts/active` fetch matched by `nws_zone` and `marine_zone`, and one GeoMet
  `weather-alerts` fetch matched by alert-region polygon. It runs the inputs through
  `estimateFlag`, runs the official-source scrapers once per distinct matched scraper with
  KV-backed health monitoring, and writes each beach's estimate and official record into its
  `beach_state` row at a 25200 second lease. The rows go out as `env.DB.batch` calls of 200
  statements rather than a write per beach, so a full 3000-beach run costs 15 round trips.
  The estimates are flushed the moment the per-beach pass finishes, before the scrapers run,
  so a run killed inside an upstream fetch still keeps every estimate it computed; the
  officials and readings follow after the scrape pass, onto the same rows. A rejected batch
  is logged and its beaches are left out of the calibration history, so a history row can
  never claim an estimate that was not stored. A scraper's optional
  `officialTtlSeconds` sets its own `official_expires` and may run past the estimate's,
  because every reader checks each record's lease on its own; its `staleMs` and `readingNote`,
  plus the resolver's `reportedFor`, ride along as display-side hints rather than leases. A
  scraped point-in-time observation lands in the same row's `reading` column, expiring on an
  absolute schedule 4 h past the observation instant, and the water-quality advisory in
  `wqfloor` at a 2 h lease. A run that resolved no scrape, no observation or no advisory
  writes no value for it and leaves the stored one to age out: expiry is the only retraction
  path. The wave record is the one column the hourly reads and never writes: it carries an
  absolute expiry tied to the model valid time, so no ordering against the wave pipeline is
  required, and a missing record — or one past its lease, or one whose series is spent — just
  means the estimate falls back to wind or `unknown`. Each estimate it
  writes also carries an `estimateInputs` seal — the non-alert inputs that estimate was decided
  from — which is what lets the alerts refresh below recompute a beach without refetching or
  losing any of them.
- `3-53/10 * * * *` (every 10 min) — `runAlertRefresh`. NWS alerts are the one event-driven
  input, so this cron closes the gap between a warning being issued and the flag moving from
  up to an hour to about ten minutes. It makes three national fetches whose cost does not grow
  with the beach table, re-estimates every beach holding a live estimate against the current
  alerts using the same functions the hourly uses, and writes only the beaches whose payload
  actually moved. The recompute reads the sealed non-alert inputs out of the stored estimate,
  so it can never lower a flag by losing a wave reading, a rip-current risk or a
  water-quality advisory. A lowering decided from sealed inputs the detail page would already
  mark stale is left to the hourly instead. It writes nothing but the estimate column, and
  only through a compare-and-set on the standing timestamp: the row keeps its original
  `estimate_updated` and `estimate_expires`, so it can neither restamp the age the detail page
  reports for the data behind a color nor keep a flag alive past the hourly rotation meant to
  judge it, and a beach the hourly rewrote underneath it is skipped rather than clobbered.
- `15 */6 * * *` (6-hourly) — `runWaterTempRefresh`: the sole writer of `watertemp:` + beachId,
  the WTMP water temperature from the nearest station able to serve that reading (see "Water
  temperature stations"), deduped by station id so each file is fetched once and fanned to
  every beach sharing it, written at a 7 h TTL. The reading is **display-only**: the detail
  page shows it in the water-temperature tile when fresh, with the station, its distance in
  miles and a live observation age ("72°F", sourced "Muskegon, MI · ~3 mi · 1 hour ago"), but
  it never feeds `src/rules.js` and cannot change a flag color. A beach whose fetch merely
  failed is left untouched so its last-good KV survives. The run is bounded against the 900 s
  ceiling: no new upstream work starts after T+480 s, and the write pool yields at T+840 s
  instead of being killed. It rotates on its **own** `wave_updated` cursor (migration 0012),
  stamped incrementally so a run that yields early persists everything it finished. The two
  crons must not share a cursor: `runFlagRecompute` rewrites `recompute_updated` to one
  timestamp for its whole run, which flattens the column, collapses a second cron's rotation
  to `id ASC`, and starves a fixed tail of the table.
- `17 3,9,15,21 * * *` (4x daily) — `runNwsEnrichment`: beaches with `nws_zone` NULL get their
  NWS forecast zone and gridpoint URL from api.weather.gov/points, 400 selected per run and as
  many walked as fit a 780 s wall-clock deadline (about 1,300 spaced requests). A
  beach without `nws_zone` silently skips the alert and rip-current rules, so draining this
  queue fast is a safety property. A centroid over water answers with the *marine* zone
  (`LMZ221`, `ANZ050`), which no land product is issued for; that answer is never stored.
  Instead the cron re-probes 16 nudged coordinates (300 m and 1 km rings) and stores the first
  land zone and its grid URL; nearly every ocean centroid takes this path at a mean of ~3
  probes, which is why the run is bounded by time rather than by count. A row the deadline
  leaves unreached is untouched and re-selects; an unrecoverable point fails like any other.
  Queue order is fewest failed attempts first, then
  `last_viewed DESC`, then `RANDOM()`. A `404` from `/points` means the point is outside the
  NWS domain and parks the row immediately, so Canadian rows reach the ECCC cron on their first
  touch; other failures bump `enrichment_attempts` (migration 0003) and park after 5.
- `29 4,10,16,22 * * *` (4x daily) — `runEcccEnrichment`: the Canadian counterpart. Beaches NWS
  enrichment permanently parked get their ECCC public forecast region name from the GeoMet
  `public-standard-forecast-zones` collection (`src/clients/eccc.js`), up to 50 per run, same
  queue order. One **bulk** polygon fetch of the whole region set per run plus a local
  point-in-polygon per beach, not a per-beach lookup; a failed bulk fetch parks the whole run
  with no attempt bumped. A row with `eccc_zone` set joins the hourly ECCC alerts check and
  drops the alerts-unavailable caveat; rows no region matches park at their own 5-attempt cap
  (`eccc_attempts`, migration 0008).
- `31 9 * * *` (daily) — `runWebcamSync`: hydrates each beach's nearest **Windy webcam**
  (`src/clients/windyWebcams.js`, Webcams API v3 free tier), up to 100 beaches a night.
  Never-checked rows come first, then within each of never-checked and due-for-recheck (last
  checked more than 14 days ago) a `last_viewed DESC` tiebreak, then oldest-checked first.
  Same-grid-cell due beaches share one bbox `/webcams` request; lone, truncated and failed
  buckets fall back to per-beach `nearby` queries. Only the nearest *active* cam's id, title
  and embed **player** URL are stored (migration 0005): free-tier still-image URLs expire in
  ~15 minutes and are useless under a read-only request path, while the player embeds durably.
  The detail page renders it in a plain `<iframe>` under a "Nearby webcam" heading, with a note
  reading "This camera is near this beach and may not show the beach itself." and the Windy.com
  attribution link the free tier requires; the footer carries the Windy credit on every page
  independently. An API failure leaves the row untouched; a confirmed
  no-cam-within-radius answer clears the webcam columns and stamps the check time.

`wrangler dev` does not run cron triggers on a schedule; trigger them manually while
developing via the scheduled-handler endpoint:

    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+3,9,15,21+*+*+*"   # NWS point enrichment
    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=29+4,10,16,22+*+*+*"  # ECCC zone enrichment
    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=31+9+*+*+*"           # webcam hydration
    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=15+*/6+*+*+*"         # 6-hourly water-temperature refresh
    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=7+*+*+*+*"            # hourly flag recompute
    curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=3-53/10+*+*+*+*"      # alerts refresh
    # (marine_zone is derived offline by the discovery batch — not a cron; see npm run seed:marine)

`npm run seed:enrich` / `seed:eccc` / `seed:webcams` / `seed:watertemp` / `seed:flags` /
`seed:alerts` wrap those crons. `npm run seed:marine` is not a cron wrapper — it runs the offline `marine_zone`
derivation against local D1, so run it after `seed:enrich` has stamped `nws_zone`.

The local database starts empty. Run `npm run seed:layers` once to download and verify the
prebuilt layer set into `./.layers` (the only step here that touches the network), then
`npm run seed` to scan it: discovery and classification in the same pass, no live API and no
`--allow-net` on the batch. Then run `npm run seed:enrich` a few times for NWS zones, and
`npm run seed:eccc` afterwards for the Canadian rows NWS parks — the NWS attempts cap means a
fresh database needs about five `seed:enrich` passes before Canadian rows become ECCC
candidates. For wave data run `npm run seed:wavegrids`, then `npm run seed:waveplanes`, then
`npm run seed:waves`, before `seed:flags`. That last step ends by applying its own SQL delta
into local D1 through `node scripts/apply-local-sql.js`, the same applier `npm run seed` uses.

### Water temperature stations

`src/waveSources/ndbcBuoys.js` holds one curated table of Great Lakes stations served by
NDBC's `realtime2` endpoint, selected with `nearestWaterTempStation(lat, lon)`:

| Capability | Constant | Stations | Cap | Consumer |
| --- | --- | --- | --- | --- |
| Water temperature | `CAP_WATER_TEMP` | 72 | `NDBC_WATER_TEMP_MAX_DISTANCE_KM` = 25 km | detail-page water-temperature tile, named with its distance and age — display only |

Station admission is on a water-temperature criterion, not a wave one. That distinction is
load-bearing: a wave criterion ("reports standard-met WVHT") would exclude the entire NOAA
**National Ocean Service** water-level network — gauges that report WTMP on a 6-minute cadence,
frequently a few hundred metres from a served beach, and no wave height at all.

NDBC serves those files under UPPERCASE names while the master station table spells the NOS
stations lowercase, and the path is case-sensitive, so `stationUrl` upcases (a no-op for the
numeric buoy ids). A lowercase request 404s, which degrades to null and is indistinguishable
from the winter gap — the beach silently loses its temperature rather than anything failing
loudly, so `test/ndbcBuoys.test.js` asserts the built filename for every row in the table.

The 25 km cap is set by how a temperature is consumed: it is printed next to the beach name as
a precise number, and both cross-lake attribution (Lake Erie's central basin is ~57 km wide)
and summer upwelling (the thermal front sits 5–15 km offshore and can put 15–20 °F between a
beach and open water) bound how far one may honestly travel.

Adding a station is hand-curated, because the exclusions that matter are judgment calls a rule
cannot encode: river-mouth and navigation-channel gauges reading a different water body,
platforms whose WTMP trace tracks air temperature, two ids for one buoy. Verify coordinates
against `https://www.ndbc.noaa.gov/data/stations/station_table.txt` and siting against
`https://www.ndbc.noaa.gov/station_page.php?station=<id>`, then confirm the station's
`realtime2` file carries a non-`MM` value in the column you are admitting it for. Most moored
buoys are seasonal (pulled roughly Nov–Apr); that is not a reason to reject one, since a
missing reading already degrades to null, but it is why winter coverage rests on the much
smaller set of stations that overwinter.

Water temperature is the only capability these stations carry, and it is display-only. The
capability machinery survives a single-capability table on purpose: adding a reading that feeds
`src/rules.js` is a color-path change needing a `RULES_VERSION` discussion, and the
per-capability distance caps stop such a reading from inheriting an eligibility rule written
for another.

### Discovery and classification (offline)

Beach discovery and water-body classification run **outside** the Worker, in an offline
GitHub Actions batch (`scripts/discovery-batch.js`, run on Deno). Both are pure local math
over a prebuilt spatial layer set: the batch makes zero upstream data queries and runs with
no network permission at all (`deno run --allow-read --allow-write`).
`docs/offline-discovery.md` has the full design.

`.github/workflows/build-layers.yml` (twice weekly) builds the layer set from the Geofabrik
OpenStreetMap extracts for the US, Canada and Mexico, each verified against its published
`.md5`, filtered to the beach / park / coastline / water tag sets, merged, converted with GDAL
and clipped to within ~1.1 km of the beach set. It publishes ten **FlatGeobuf** files plus a
manifest to an R2 bucket served at `https://map.swim.report`, under an immutable per-build
prefix with the `layers/current.json` pointer overwritten last, so a reader can never see a
torn set. `.github/workflows/discovery.yml` (daily, plus a trigger on each new layer build)
downloads and sha256-verifies that set, snapshots D1, and runs the batch once — discovery, park
association, classification, stale-row reconciliation, the `flag_history` prune and the
`marine_zone` derivation — emitted as one idempotent `.sql` delta.

This keeps the two-path invariant: the batch writes D1 out-of-band, R2 is read by the offline
job only, and the request path still reads only D1 and KV.

Classification always reaches a decision. Finding no coastline, no allowlisted Great Lake
relation and no qualifying water way within the probe radii classifies the beach `inland`
rather than leaving it unclassified, and there is no transient-failure escape hatch: the join
is local math over verified immutable bytes, so re-running it could only reach the same answer.
This matters for what the site serves, because still-unclassified rows stay **visible** — the
gate is fail-open for them — so a newly discovered beach would be listed with an estimated flag
until its first classification. That window is zero, because classification happens in the same
run that discovers the beach. Water bodies are matched to an allowlisted Great Lake by wikidata
QID, never by name.

**Failure posture.** The freshness horizon is the extract cadence — twice weekly, with a hard
`MAX_SOURCE_AGE_DAYS = 21` refusal. A build that fails, or that a sanity floor refuses,
publishes nothing and leaves the last good layer set live; that is delete-safe, because an
older extract is over-inclusive and can only fail to discover a new beach, never invent a stale
one. The batch verifies the manifest before it does anything, in three tiers. A **fatal** set
(wrong schema, torn pointer, failed checksum, missing layer) exits with no SQL. An
**incomplete** set (build unfinished, sources unverified, sanity floors failed) suppresses
**both** deletes and classification, because a partial view of OSM must never read as "gone
from OSM" and must never decide `inland`, which hides beaches. A **stale or out-of-scope** set
suppresses deletes only. Deletes additionally pass two proportional rails, and mass
re-classification passes a rail of its own.

**Coverage.** Discovery is scoped to a curated set of coastal bounding boxes in
`src/regions.js` (`REGIONS`) tracing the entire Great Lakes shoreline, both US and Canadian.
Coastal boxes keep the discovery universe to actual shoreline; a continental rectangle would
sweep in thousands of inland-lake "beach" elements the classifier just drops. `REGIONS` feeds
the clip mask, the per-region sanity floors and delete rail, and delete scoping, and nothing
else. Reconciliation treats a D1 row as a delete candidate only if `pointInAnyRegion(lat, lon)`
is true — the **sole delete path** — and that check fails safe: shrinking or removing a box
only *removes* delete candidates, so an editing mistake under-deletes rather than over-deleting
a real, enriched beach. Bringing a new coast online is additive.

**Marine-zone derivation.** The daily run also derives `beaches.marine_zone`
(`--marine-zones data/marine-zones.json`): a nearest-marine-zone pass
(point-in-polygon plus nearest-edge, 15 km cap; `src/marineZones.js`) over snapshot rows that
already have `nws_zone`, emitting change-only idempotent UPDATEs, never NULLing an existing
value and never touching the delete path. Regenerate the committed geometry file with
`scripts/build-marine-zones.js` when NWS publishes a new coastal marine-zone shapefile
(https://www.weather.gov/gis/MarineZones).

### Wave data (offline)

Wave height and the wind fallback come from NOAA GRIB2 model output, downloaded and
point-sampled in `.github/workflows/waves.yml` (`52 */6 * * *`) and applied as an idempotent
SQL delta into each beach's `beach_state` row, where the hourly cron reads it off the join it
already issues. Each cycle publishes 24 hours of
forecast per beach and the hourly cron indexes into it, so four cycles a day is margin against
a skipped GitHub schedule rather than a freshness requirement. Four grids are sampled in ordered
fallthrough, constrained by each beach's `water_class`: NOAA's Great Lakes Wave model (GLWU,
2.5 km) for the lakes, GFS-Wave `global.0p16` for ocean coasts, GFS-Wave `arctic.9km` above
52.58°N, and the Seattle forecast office's Nearshore Wave Prediction System nest
(`sew_nwps_CG1`, about 4 km) for the Salish Sea, which `global.0p16` masks entirely at its
0.1667° resolution. A wave model masks land, and real beach coordinates frequently land on a
masked cell, so each beach is resolved to the nearest wet cell within a per-grid cap — a search
only possible with the whole grid in hand, and a genuine capability gain over asking a
coordinate API. GFS-Wave's GRIB2 uses JPEG 2000 compression and has no pure-JavaScript decoder,
so decoding requires GDAL and can never happen inside the Worker.

The sampled cycle travels between the workflow's two jobs as a workflow artifact and never
leaves the run. R2 keeps only each published cycle's `manifest.json`, which the next cycle's
coverage ratios read, under an immutable `waves/<cycleId>/` prefix, with the small
`waves/current.json` pointer written last so it never names a manifest that is not there.

Each stored record carries an **absolute** expiry measured from the model's valid hour, not a
TTL measured from write time: 24 h for a record carrying the hourly series, 7 h for a
wind-only one. A run that fires late gets a correspondingly shorter lease rather than a fresh
one on old data, and republishing an older cycle yields a negative lease
and is refused. A failed or refused cycle writes nothing and leaves the previous cycle's
records in place, so the failure mode is a flag aging out to `unknown` — gray and honest —
never a stale wave height deciding a color. See `docs/offline-waves.md`.

NOAA data is a US Government work in the public domain; the credit on every page is a
courtesy, not an obligation.

**Paid-plan assumption.** The cron subrequest budgets exceed the free plan's 50-subrequest
ceiling; the paid plan allows 10,000 per invocation. `TODO.md` records a free-plan-friendly
fallback (a lower `MAX_BEACHES_PER_RUN`). Wall clock, not subrequest count, is the binding
limit: a scheduled invocation gets 900 s, and Cloudflare caps an invocation at **six
simultaneous open connections** with KV `get`/`put` counting toward that cap, so a write pool
wider than ~6 buys no throughput and all wall-clock sizing here is done at 6. The per-beach
flag writes escape that cap entirely by not being a fan-out: they are batched into
`env.DB.batch` calls of 200 statements, a handful of round trips for a whole run. The hourly's
wave read escapes it too, riding the SELECT the run already issues.

## Deployment

Production runs at **https://swim.report** as a single Cloudflare Worker with a custom-domain
route, Workers Logs observability (`head_sampling_rate = 1`) and Smart Placement, all
configured in `wrangler.toml`, which carries the real production D1 and KV IDs (PLAN.md
section 8 is authoritative).

    export CLOUDFLARE_API_TOKEN=...                            # CLOUDFLARE_WORKERS_EDIT_TOKEN from .dev.vars
    npx wrangler deploy --dry-run                              # validate first
    npm run deploy                                             # deploy
    npx wrangler d1 migrations apply swim-report --remote      # after adding a migration
    npx wrangler tail                                          # live logs

The production database starts empty on a fresh deploy. The offline batch populates and
classifies beaches in one pass, then the enrichment runs drain the zone queues and the hourly
cron starts writing flags. There is no remote equivalent of the `npm run seed:*` wrappers;
either wait for the crons or run a local dev server with `remote = true` bindings and trigger
the scheduled-handler endpoints manually.

Each workflow authenticates with its own narrowly scoped repository secret — see
[`docs/offline-discovery.md`](docs/offline-discovery.md) for the full list and the R2 bucket
setup. The discovery job needs no R2 credentials: it reads the published layers over plain
HTTPS from `https://map.swim.report`.

A deploy also uploads the committed brand assets in `public/` ( `[assets] directory` in
`wrangler.toml`): favicon, apple-touch icon, the two manifest icons, `manifest.webmanifest`
and the five share cards. They are regenerated by `node scripts/build-brand-assets.js`, which
is idempotent, so re-run it and commit the diff whenever the mark or the theme colors change.

`compatibility_date` is pinned — bump it occasionally when deploying. Structured logs land in
the Cloudflare dashboard under Workers → swim-report → Logs.

## Official sources

Official flag data (`official: true`) comes from `src/officialSources/`, a scraper registry
implementing **scraper contract v2** (per-beach resolution; PLAN.md section 6 is the
authoritative spec). Every scraper obeys one hard product rule: **never report a wrong color**.
Any ambiguity, unexpected markup, stale data or unrecognized status degrades to `null` (no
data), never a guessed color.

Registered scrapers, in registry order — most-specific match first, since `findScraper`
returns the first scraper whose `matches(beach)` is true:

| Scraper (id) | Source | Color semantics |
|---|---|---|
| South Haven MI (`south-haven-mi`) | City flag program's published Google Sheets CSV (linked from the flag page as the "text version") | Real flag colors per site; multiple poles roll up to most severe; Gray = unmonitored → no data. A beach naming no pole resolves to the nearest one and carries `reportedFor`, so the card names the pole it borrowed |
| Huron-Clinton Metroparks (`huron-clinton-metroparks`) | metroparks.com park-closures page (Martindale, Maple, Baypoint, Eastwood) | **Closure-only**: Closed → red; Open → no assertion, never an inferred green |
| Chicago Park District (`chicago-park-district`) | chicagoparkdistrict.com `/flag-status` JSON API (~23 lakefront beaches) | Real flag colors; "Afterhours" → red; records >36 h old dropped; a beach reports green only when its own Surf row is fresh, so a green resting solely on a water-quality row is no data rather than a false green |
| NWS Grand Rapids beach report (`nws-omr-grr`) | NWS WFO GRR "Other Marine Reports" text product — the "Lake Michigan Beach Reports" table (~7 west-Michigan state-park beaches) | **Posted flag colors**: Green/Yellow/Red map 1:1; no double-red; None or unrecognized → no data. Also carries the table's observed water temperature and wave height per site as a `reading` record, including for a site reporting no flag. `updated` is the product's once-daily morning issuance, so it declares a 30 h `staleMs` and a "Morning reading" note. Nearby beaches served by a park's row carry `reportedFor`, and the card names the site the reading was posted for |
| Winnetka Tower Beach (`winnetka-tower-beach`) | Winnetka Park District status page for Tower Road Beach (Lake Michigan, IL) | **Dangerous-conditions closure**: Open → green; Closed with a surf-hazard reason → red; closed for water quality or any other reason → no data. `updated` is the page's own stamp, which moves only when a staffer posts, hence a 72 h `staleMs`. The bbox also claims the neighboring Winnetka beaches, which carry `reportedFor` so the card names Tower Road Beach |
| PA DCNR Presque Isle (`pa-dcnr-presque-isle`) | PA DCNR Park Advisory feed for Presque Isle State Park (Lake Erie, PA) | **Closure-only, red-only**: a Danger-tier advisory describing a swimming hazard → park-wide red; water-quality or off-axis → no data; never green. Hazard-keyword mapping is verified against fixtures only |
| NWS Marine Beach Forecast (`nws-marine-beach-forecast`) | NWS Marine Beach Forecast ArcGIS MapServer, per-WFO Day-1 layers (CLE, BUF) | Zonal rip "Swim Risk" and surf-height text through `waveColorForHeight`; site color is the more severe of the two; both null → no data. Bound by a curated name/proximity table, registered **last** because its bbox is broad |

Only hazard, flag and closure sources are registered. An official color **overrides** the
estimate wherever it is shown, with one bounded exception: a reading older than 2 h may be
**raised** (never lowered) by a more severe fresh estimate on every surface that shows the
beach's flag, and is credited as the source only while strictly more severe, so an aged
reading the estimate ties shows as the estimate. The OFFICIAL card always reports the scraped
color verbatim. Water-quality monitoring
sources are deliberately excluded from *this* registry, because a clean-water reading is a
different axis from surf hazard and letting its green win would mask a genuine hazard estimate.
Water quality feeds a **separate raise-only floor** (below) that can never lower a flag.

### Water-quality advisory floor (raise-only)

Water-quality advisories (E. coli, bacteria, harmful algal bloom) come from a second registry,
`src/wqFloor/`, on a **different axis** from the official hazard scrapers above. Because a
clean water reading says nothing about surf, such a source is admissible **only as a raise-only
floor**: an active advisory may raise a flag up to yellow or red, but a clean or absent reading
can never pull a flag down. It is baked into the estimate (rules step 7, `official: false`), so
it never overrides an official reading and never wins over the map marker, list or detail title
the way an official hazard flag does. Mechanically it mirrors the NWS/ECCC yellow floors:
worst-of by severity, applied after the hazard color is decided.

The detail page also renders the standing advisory as its own callout directly under the
estimate card — yellow renders `warning`, red renders `danger` — carrying the reason, the
source name as plain text and the reading's own timestamp. It is advisory context beside the
estimate that already folded it in, never an official flag card, so a bacteria advisory stays
visible under a wave-height red.

Registered wqFloor sources (most-specific match first; the coarse USGS NowCast bbox is
consulted last, only for beaches no curated source claims):

| Source (id) | Coverage |
|---|---|
| NY State Parks (`ny-oprhp-beach-status`) | OPRHP Lake Erie/Ontario state-park beaches |
| Lake County OH (`lake-county-oh-beaches`) | Lake County (OH) GHD water-quality program |
| Kenosha County WI (`kenosha-beach-conditions`) | Kenosha County beach conditions |
| Minnesota DoH (`mn-beaches`) | mnbeaches.org (~6 Duluth-area sites) |
| Grey Bruce ON (`grey-bruce-rec-water`) | Grey Bruce Health Unit (Lake Huron) — low confidence |
| Ontario Parks (`ontario-parks-beach-postings`) | Ontario Parks per-park Alerts |
| Evanston IL (`evanston-statusfy`) | City of Evanston beach status |
| USGS Great Lakes NowCast (`usgs-great-lakes-nowcast`) | Predicted E. coli, coarse US-shore bbox (fallback) |

Three further sources are authored and tested but held out of the registry until their gates
are confirmed: `chautauqua-county-ny` and `erie-county-pa-kml` (fetch URL still empty) and
`illinois-beachguard` (placeholder BeachIDs). Each fails closed before fetching, and because
the registry is first-match-wins with exactly one source resolved per beach, a permanently
inert source registered ahead of a working one *shadows* it — hence unregistered rather than
inert-but-listed. Re-registering one must place it **above** `usgs-great-lakes-nowcast`, and
for Illinois above `kenosha-beach-conditions`. TODO.md has the checklist.

Each wqFloor source obeys the same never-a-wrong-color rule — a schema change degrades to
`null`, meaning no floor — and reports only `yellow` or `red`; green and double-red are invalid
floor colors by construction. See PLAN.md section 6 for the full contract.

### Scraper health monitoring

The hourly cron tracks every matched scraper's consecutive-null streak in KV
(`scraperhealth:` + scraperId, no TTL — see `src/scraperHealth.js`). When a scraper with
matched beaches returns null for 24 consecutive hourly runs, the cron logs a loud `ALERT:` line
naming the scraper and its last success, so a silently-broken source page surfaces in the logs
instead of going dark. Only `null` counts as a failure: a scrape that fetched and parsed
cleanly but had nothing to report — a closure-only source with every beach Open — returns an
empty result (`sites: []`), which is a success and resets the streak. A working source with
nothing to report must never return null, or it would raise a false alert.

## How to add a new official-source scraper

1. Create `src/officialSources/<yourScraper>.js` exporting an object matching scraper
   contract v2 (PLAN.md section 6 has the full spec):

       export const yourScraper = {
         id: "stable-kebab-case-id",
         label: "Human-readable operator name",
         url: "https://the-page-you-scrape",
         // OPTIONAL, see "Staleness horizons" below:
         staleMs: 108000000,         // this source's own staleness horizon (ms)
         readingNote: "Morning reading — conditions may have changed since it was posted",
         // OPTIONAL, unrelated to the two above: extends this record's own
         // official_expires when the source fetches on a reduced cadence. Free to
         // run past the estimate's 25200 s — every reader checks each record's
         // lease on its own.
         // officialTtlSeconds: 21600,
         matches: function (beach) {
           // BeachRow -> boolean, pure. Match by name regex and/or a lat/lon
           // bounding box covering every OSM beach row for that area.
         },
         scrape: async function (nowIso) {
           // Fetch and parse the source, then return ONE of:
           // (a) single-color, applied to every matched beach:
           //   { color, reason, official: true, scraperId: id, source: url,
           //     sources: [url], updated: nowIso }
           // (b) multi-site, each matched beach resolving to at most one site:
           //   { perBeach: true, sites: [{ siteId, color, reason,
           //     names: ["lowercase substrings"], lat, lon, radiusMi,
           //     waterTempF, waveHeightFt /* optional; see "Observed readings" */,
           //     reportSiteName /* optional; see "Transferred readings" */,
           //     updated /* optional ISO; overrides result updated */ }],
           //     source: url, sources: [url], updated: nowIso }
           // Return null ONLY on genuine failure (fetch failed, page
           // unparseable, parse threw) — null is what the health tracker
           // counts as a failure. A clean parse with nothing to report (every
           // beach Open on a closure-only source) is a SUCCESS: return an
           // empty shape (b) result (`sites: []`), never null.
           // Never throw and never guess a color — omit ambiguous sites.
           // updated honesty: only real-time sources may stamp nowIso.
           // Periodic sources must stamp the source's own report or sample
           // date, so the UI's stale-data warning stays honest.
         }
       };

   With shape (b), each matched beach is resolved to a site by `resolveSiteForBeach`, defined
   in `src/officialSources/util.js`: name substrings win over proximity, then nearest site
   within its `radiusMi` (default 1.5 mi). A beach that resolves to no site gets no official
   flag — the correct outcome, not an error. A site without a confirmed color carries
   `color: null`, which resolves to no official flag silently; omit it from `sites` entirely
   unless it carries an observed reading. Build the shape-(b) object with
   `perBeachResult(sites, source, updated)`.

   **Observed readings (`waterTempF`, `waveHeightFt`).** A source that publishes point-in-time
   observations alongside its posted flag puts them on the site, in °F and feet.
   `scrapeReadingFromResult` resolves them independently of the color into the beach's
   `reading` record, so a site reporting no flag still publishes its numbers. The detail page
   renders them as "at a glance" tiles: the wave height beside the estimate's modeled "Waves
   now", and the water temperature ahead of the NDBC buoy reading, since an observation taken
   at the beach beats one from a station up to 25 km offshore. Both disappear four hours after the
   observation rather than carrying a stale warning — a morning water temperature is not a
   claim about the afternoon. They are display-only: they reach no rule and bump no
   `RULES_VERSION`. Range-check them in the scraper, so a shifted column cannot render a
   station id as a temperature.

   **Transferred readings (`reportSiteName`).** A shape-(b) site that is a real reporting
   location whose flag also serves nearby beaches declares `reportSiteName`, the site's own
   display name. When it is neither the resolved beach's display name (`park_name || name`)
   nor claimed by that site's own `names[]`, `scrapeOfficialFlagFromResult` attaches
   `reportedFor: { name, distanceMi }` to the record and the detail page's official card adds
   a quiet "Reported for Grand Haven State Park, ~1 mi away" line, so a visitor at Grand Haven
   City Beach is never shown a neighboring park's posted flag as their own. The `names[]` test
   is what keeps a beach that IS the report site quiet when the source qualifies its label
   ("Mears State Park (Pentwater)" for Charles Mears State Park), so every line the site
   resolver can produce comes from its proximity fallback. `distanceMi` is the real haversine
   distance when both the beach and the site carry coordinates and `null` otherwise — a
   distance is never invented.

   Declare it on every site of a source whose sites are real reporting locations that also
   serve nearby beaches. The test is whether a beach the scraper `matches()` can resolve to a
   site it is not named after: a coordinate-bearing site plus a `matches()` wider than that
   site's own name means the proximity fallback will hand some neighbor the site's posted flag.
   `nws-omr-grr`, `south-haven-mi` and `winnetka-tower-beach` all qualify. South Haven
   publishes nine flag poles along one shoreline, claims the whole city by bbox, and resolves a
   beach naming no pole to the nearest one within 1.5 mi. Winnetka posts one pole, Tower Road
   Beach, but `matches()` falls through to a bbox covering the neighboring Winnetka Park
   District beaches, each of which lands inside the site's default 1.5 mi radius.

   Sources whose sites carry no coordinates — Chicago Park District, Metroparks — have no
   proximity fallback at all, so a bbox-matched beach that no site names resolves to `null` and
   there is never a neighbor to disclose. Area-wide sources must not declare it: Presque Isle
   posts one park-wide advisory, and the NWS marine beach forecast's sites are whole zones
   whose centroids are not measurement points, so any distance would be invented.

   Keep parsing logic in separate, pure, exported functions (see `parseSouthHavenCsv` in
   `src/officialSources/southHaven.js`) so they can be unit tested with fixture strings and no
   network access. `scrape(nowIso)` receives its timestamp — never call `Date.now()`.

   **Shared helpers in `src/officialSources/util.js`** to reuse: `fetchText` (cron-side fetch
   to text or `null`; for JSON use `fetchJson` from `src/clients/http.js`), `perBeachResult`,
   `resolveSiteForBeach` / `siteNamesMatchBeach` / `DEFAULT_SITE_RADIUS_MI`, `ageDays` /
   `MS_PER_DAY`, `FLAG_SEVERITY`, `decodeCellText`, `extractTableRowsRaw`,
   `containsAny` (exact, no case folding) and
   `matchesAnyAlias` (lowercases only the haystack, because every curated alias array here is
   already lowercase). **Caution:** `decodeCellText` is deliberately the *conservative*
   table-cell chain. A scraper that strips full-page HTML into a bounded window which **gates a
   floor color** must keep its own local stripper — widening the entity set there changes
   whether a floor is raised (e.g. `prediction&mdash;poor`), a behavior change, not a cleanup.

   **Staleness horizons (`staleMs` / `readingNote`).** The stale-data warning defaults to 2
   hours, calibrated to the hourly *estimate* recompute. That is wrong for a source publishing
   on its own slower schedule: the NWS Grand Rapids beach report is issued once a day, so an
   honest `updated` of its issuance time would show "Stale data" for most of every day even
   though the posted colors are current. Such a scraper declares `staleMs` — the milliseconds
   after which *its* reading is genuinely stale — and the warning then fires only when the
   source actually misses its cadence (`nws-omr-grr` 30 h; `winnetka-tower-beach` 72 h,
   covering a Friday-afternoon status post read on Monday morning). A scraper that declares
   nothing keeps the honest 2 h signal.

   A source whose reading is a **point in time** may additionally declare `readingNote`: a
   sentence fragment rendered as a neutral callout when the reading is older than the 2 h
   default but still inside `staleMs`, with the relative age appended. A persistent posted
   **status** declares `staleMs` alone. The two callouts are mutually exclusive and the warning
   always wins, so a `readingNote` can never suppress a real stale warning. Both fields are
   validated when the record is written (`staleMs` a finite number > 0, `readingNote` a
   non-empty string) and are otherwise omitted. Neither has anything to do with
   `officialTtlSeconds`, which governs how long the stored record itself lives. That lease is
   independent: `official_expires` is checked on its own everywhere, the map endpoint
   included, so an official outliving its paired estimate keeps its color on the marker and on
   the detail page alike.

   `staleMs` is an addition to honest `updated` stamping, never a substitute: stamping `nowIso`
   on a days-old reading and covering it with a long horizon is exactly the failure the honesty
   rule exists to prevent.

2. Register it in the `scrapers` array in `src/officialSources/index.js`, most-specific
   `matches()` first — `findScraper(beach)` returns the first match, so tight city boxes go
   before broad statewide bboxes.

3. Add tests under `test/` covering the pure parse function (including ambiguous rows being
   omitted) and `matches()` with representative `BeachRow` fixtures: a matching name, a
   matching bbox, and a beach that should not match.

4. That's it. The hourly cron discovers every beach your scraper matches, calls
   `scrape(nowIso)` **once per distinct scraper per run**, resolves the shared result per
   beach, and writes the `official` record for every beach that resolved. Health monitoring
   picks the new scraper up automatically.

Official scrapes, like estimates, run cron-side only and are stored in D1 — the
request path never scrapes a page live.
