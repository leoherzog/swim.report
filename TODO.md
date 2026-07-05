# TODO.md — Swim Report

Known gaps and deliberate deferrals, per PLAN.md. Nothing below blocks the pilot; all
of it is scoped for follow-up work.

## Data quality / coverage

- **Great Lakes wave data (GLERL/GLCFS).** Open-Meteo's marine wave models
  (`ecmwf_wam025`, `ncep_gfswave025`, `meteofrance_wave`) frequently return null/masked
  values on the Great Lakes, which is exactly the pilot region. The rules engine and
  wind fallback handle this gracefully today, but a NOAA GLERL / Great Lakes Coastal
  Forecasting System (GLCFS) client would give real wave data for Michigan, Huron,
  Erie, etc. instead of falling back to wind-only estimates so often. This would be a
  new `src/clients/glerl.js`-style module feeding into the same `waveHeightFt` slot in
  `estimateFlag` inputs.
- **Threshold calibration against South Haven's real flag history.** South Haven is
  the one beach with both an estimate and a live official reading. Once enough
  official-vs-estimate history has been logged, revisit the wave/wind thresholds in
  `src/rules.js` (2 ft / 4 ft wave, 15/25 mph wind, 25/35 mph gust) against how often
  the estimate actually matches South Haven's posted flag, and consider a
  `rules_version` bump (`1.1.0`) if thresholds change — old cached `FlagEstimate`
  objects already carry their own `rules_version`, so this is safe to do
  incrementally.
- **SwimSmart / Michigan DNR partnership outreach.** Michigan's SwimSmart program and
  DNR-managed state park beaches are an obvious source of more official flag data
  (beyond South Haven) and possibly a sanctioned data-sharing agreement instead of
  scraping. Worth an outreach email before building more scrapers against
  DNR-adjacent HTML pages that could change without notice.

## Scale-out

- **Nationwide Overpass scale-out.** `runOverpassSync` currently syncs a single pilot
  bbox (`PILOT_BBOX`, Michigan / Great Lakes shoreline) once a day. Scaling to the
  full US coastline means tiling CONUS coastal bboxes and queuing them (e.g. one tile
  per night, or spread across multiple daily cron windows) rather than one big
  Overpass query — large bbox queries risk Overpass API timeouts/rate limiting.
  `MAX_BEACHES_PER_RUN = 250` in `runFlagRecompute` and the `ORDER BY id LIMIT 250`
  cursor will also need real pagination (cursor on last-seen `id`, or multiple
  invocations) once the `beaches` table exceeds a few hundred rows.
- **NWS enrichment backlog.** `runOverpassSync` enriches at most 30 beaches/night
  (`NWS_ENRICHMENT_LIMIT`) with `nws_zone`/`nws_grid_url` via `fetchPointMetadata`.
  Fine for the pilot region; will need a higher throughput (or parallel batched
  requests, respecting api.weather.gov rate limits) once beach counts grow.

## Official-scraper fragility

- `src/officialSources/southHaven.js` parses a live HTML page for
  `Green.png` / `Yellow.png` / `Red.png` / `Grey2.png` image filenames. This is
  inherently brittle — any redesign of southhavenmi.gov breaks the scraper silently
  (it will just return `null`, which is safe/non-fabricating, but means no official
  data at all until someone notices and fixes the regex).
- No monitoring/alerting exists yet for "official scraper has returned null for N
  consecutive cron runs." Worth adding a simple KV-backed failure counter or a
  scheduled health-check that pages someone (or just logs loudly) when a
  previously-working scraper goes quiet for, say, 24 hours.
- Same fragility risk applies to any future scraper added per the README's
  "How to add a new official-source scraper" section — plan for this from the start
  rather than bolting it on later.

## Free vs. paid Workers plan

- The hourly `runFlagRecompute` cron's subrequest budget (~360 subrequests/run for the
  pilot region, per PLAN.md section 7) assumes the Workers **Paid** plan (1000
  subrequests/invocation, no daily KV-write cap). The **Free** plan's 50-subrequest
  ceiling and 1000 KV-writes/day quota are not sufficient at this cadence and beach
  count. For a free-plan demo, drop `MAX_BEACHES_PER_RUN` way down (e.g. 10-15
  beaches) and/or reduce cron frequency before deploying without a paid plan.

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
