# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm test` — run the full Vitest suite
- `npx vitest run test/rules.test.js` — run a single test file
- `npm run dev` — local dev server (`wrangler dev`; `predev` auto-applies migrations to local D1). It starts with an empty local database; populate it with `npm run seed`.
- `npm run seed:layers` — download and verify the FlatGeobuf layer set into `./.layers` (`deno run --allow-net --allow-read --allow-write scripts/fetch-layers.js --dest ./.layers`). It pins one `layers/current.json` build id, sha256-verifies every layer against the build manifest, and writes the `report.json` the delete-path gate reads. Run it once per layer build, not on every seed.
- `npm run seed` — populate local D1 from that layer set (`deno run --allow-read --allow-write scripts/discovery-batch.js --layers ./.layers --out ./.seed.sql && node scripts/apply-local-sql.js ./.seed.sql`). Note the permission set: no `--allow-net`. Discovery, park association, classification and reconciliation are pure local math over those bytes, so any `--allow-net` on a `discovery-batch.js` invocation is a leftover upstream call, findable by one grep. The apply splits the delta into <90 KB line-aligned chunks, because `wrangler d1 execute --local --file` hands the whole file to workerd as one SQL call capped at 100,000 bytes (`SQLITE_TOOBIG`); the workflow's `--remote` apply uses the D1 import API and is unaffected.
- `npm run seed:enrich` (NWS point enrichment, 75 beaches/run — repeat to drain the queue), `seed:eccc`, `seed:webcams`, `seed:watertemp`, `seed:flags` and `seed:alerts` trigger the matching crons. `npm run seed:marine` is not a cron trigger: it snapshots local D1, runs `discovery-batch.js --no-discovery --no-classify --marine-zones data/marine-zones-greatlakes.json --snapshot <file>`, and applies the delta through `apply-local-sql.js`. Run it after `seed:enrich` has stamped `nws_zone`, since the pass only derives zones for rows that already have one.
- The wave pipeline is three local steps, mirroring the `seed:layers` / `seed` split. `npm run seed:wavegrids` downloads one NOAA GRIB2 cycle into `./.wavegrids` (`fetch-wave-grids.js`, the only `--allow-net` script in the pipeline). `npm run seed:waveplanes` runs GDAL: a `gdalinfo -json` sidecar per file, `sample-waves.js --mode plan` to resolve which band carries each hour's HTSGW and WIND, then one `gdal_translate` per band into a flat ENVI plane. `npm run seed:waves` samples every beach, applies the build gate and bulk-writes the KV pairs. GDAL runs only in the shell, so no Deno script in the pipeline carries `--allow-run`. Run `seed:waves` before `seed:flags`.
- **Every `deno` invocation in this repo must set `DENO_NO_PACKAGE_JSON=1`** — every `npm run` script above does, and so must every `deno` step in every workflow. The repo-root `deno.lock` is auto-discovered for all Deno commands here, and without that env var Deno folds `package.json`'s npm dependency tree into the lockfile it expects: `deno check --frozen` then fails with "The lockfile is out of date", and a plain `deno run` silently rewrites the checked-in lock. The fix is the env var, never regenerating the lock without it. `deno.json` carries exactly two things: `nodeModulesDir: "none"`, so the batch resolves flatgeobuf from the npm cache rather than a CI-absent `node_modules/`; and the import-map entry `"flatgeobuf/": "npm:/flatgeobuf@4.4.0/"`, whose leading slash after `npm:` is the canonical Deno form for a trailing-slash directory mapping. That lets `scripts/lib/fgbReader.js` use a bare specifier both Deno and vitest resolve, where an `npm:` URL would be unloadable under vitest.
- Cron triggering in local dev goes through `/cdn-cgi/handler/scheduled?cron=<urlencoded cron>`.
- `npm run deploy` — deploy (`wrangler deploy`); `npx wrangler deploy --dry-run` validates config without deploying.
- `npx wrangler d1 migrations apply swim-report --local` / `--remote` — apply `migrations/` to D1.
- There is no `wrangler login` session on this machine. Export `CLOUDFLARE_API_TOKEN` before any wrangler command that talks to the Cloudflare API — see Credentials for which token.

## Production

Live at **https://swim.report** (custom-domain route). `wrangler.toml` carries the real D1/KV IDs plus observability, Smart Placement and a pinned `compatibility_date`. The `WINDY_WEBCAM_API_TOKEN` Worker secret is set. Remote data populates through the crons and the GitHub Actions pipelines only; the request path serves whatever D1 and KV currently hold.

`npm install` needs both `WEBAWESOME_NPM_TOKEN` and `FONTAWESOME_NPM_TOKEN` exported in the environment (values in `.dev.vars`, which is gitignored). `.npmrc` routes `@web.awesome.me`/`@awesome.me` and `@fortawesome` through private registries via `${VAR}` placeholders; never hardcode a token in `.npmrc`.

### Credentials

Five scoped Cloudflare credentials, no shared account token. Each job holds the narrowest scope that lets it work.

- `CLOUDFLARE_D1_EDIT_TOKEN` — repo secret, read by `discovery.yml` for the remote D1 snapshot and delta apply.
- `CLOUDFLARE_D1_READ_TOKEN` — repo secret, read by the `waves.yml` sample job for its read-only beach snapshot.
- `CLOUDFLARE_KV_WRITE_TOKEN` — repo secret carrying Workers KV Storage: Edit, read by the `waves.yml` publish-kv job. That job holds no R2 keys, and the sample job holds no KV token.
- `CLOUDFLARE_R2_ACCESS_KEY` / `CLOUDFLARE_R2_SECRET_ACCESS_KEY` — repo secrets, the S3-API pair both publishers use against the `swim-report` bucket.
- `CLOUDFLARE_WORKERS_EDIT_TOKEN` — lives in `.dev.vars` only and is deliberately never a repo secret, so no CI job can change the code running at swim.report. Export it as `CLOUDFLARE_API_TOKEN` for a local deploy, remote migration, secret write or tail.

## Mandatory JavaScript style

All project source and tests are plain JavaScript (no TypeScript), ES modules, and:

- `const`/`let` only, never `var`
- String concatenation with `+`, **never template literals** — no backticks anywhere
- `console.log` for logging

## Architecture

Single Cloudflare Worker (`wrangler.toml`, modules syntax) that **estimates** beach hazard flag status (green / yellow / red / double-red / unknown). The core product constraint: estimated conditions must never be presentable as official flag status — every payload carries `official: true|false` and the UI renders the two distinctly.

**PLAN.md is the authoritative contract** — D1 schema, KV shapes, module signatures, rules precedence, reason-string formats. Update it when changing any cross-module interface. README.md documents the public API and rules table; TODO.md tracks known gaps.

### The two-path rule (never violate)

1. **Request path** (`fetch` → `src/router.js` → `src/frontend/render.js`): reads **only** D1 and KV. No upstream `fetch()` may ever be reachable from here. `/api/beaches.geojson` reads one KV key, the cron-built `mapdirectory:v1` (`src/mapDirectory.js`), instead of the `ceil(N/100) × 2` bulk gets it used to make; the artifact stores ingredients and `mapDirectoryFeatures` resolves them through the unchanged `markerFlagColor` at read time, so the map marker and the detail page's title flag cannot disagree. A missing, unparseable or version-mismatched directory takes a degraded branch that reads D1 only, bounded by `MAP_DEGRADED_MAX_FEATURES`, and emits `flag: "unknown"` with `builtAt: null` and `degraded: true` — never a fallback that reintroduces the per-beach read, which is a silent cliff and the shape that cannot run in the request path at scale.
2. **Cron path** (`scheduled` in `src/index.js`, dispatched on `controller.cron`): all upstream fetching happens here, split across independent triggers so one upstream's failure or rate limit never starves another. Discovery, classification, `marine_zone` and wave sampling are not here — the offline pipelines own them.
   - `"7 * * * *"` (hourly): reads beaches ordered hot-first (a `last_viewed` demand stamp within `HOT_VIEW_WINDOW_MS`, 7 days, always fully covered every run) then oldest-`recompute_updated`-first for the cold remainder, so a beach in active demand never loses its flag to the rotation once the table outgrows one run. It gathers NWS and ECCC land alerts, ECCC marine warnings and SRF rip risk through `src/clients/*`, folds in `src/wqFloor/` advisories as `waterQualityAdvisory` (raise-only: it can lift a flag to yellow or red, never lower one), **reads** wave height and wind fallback from `"waveinput:" + beachId` KV, computes estimates, scrapes official sources, and writes `"flag:"` and `"official:"` at `expirationTtl: 25200`, sized to the cold rotation period and shared so an estimate never outlives the posted flag it is weighed against, and `"wqfloor:"` at `7200`, where expiry is the only retraction path. A single national NWS `/alerts/active` fetch is matched against both a beach's land `nws_zone` and its adjacent `marine_zone`; the Canadian equivalent is two national ECCC fetches of disjoint collections, matched by region polygon. Every fan-out KV write in both crons goes through the pool in `src/pool.js`, never a sequential per-beach `await env.FLAGS.put`; the outer per-scraper loop stays sequential because it mutates shared `scraperhealth:` state. It reads `waveinput:` and never fetches it. As its last step it rebuilds `"mapdirectory:v1"` whole, preloading both the estimates and the officials it wrote this run because KV offers no read-your-own-writes guarantee; a scan that trips `MAP_SCAN_DEADLINE_MS` writes no artifact at all rather than a partial one, since a partial directory drops beaches from the map entirely. `FLAG_TTL_SECONDS` moved to `src/flagTtl.js` (the entry-module export rule), and the step-6 wave and wind reads use `Number.isFinite` so a malformed `waveinput:` value cannot reach `rules.js` step 3's unguarded else branch as a green. Each `"flag:"` value also carries the `estimateInputs` seal (`src/flagInputs.js`), spread on after `estimateFlag` returns from the same `signals` object the estimate consumed.
   - `"3-53/10 * * * *"` (every 10 min): `runAlertRefresh`, a level-triggered alerts refresh. Four national fetches, no per-beach upstream call, no persisted diff state and no run lock: it compares each beach's current alert set against the set its standing estimate used (echoed as `alertDetails`) and recomputes from the `estimateInputs` seal inside the same `"flag:"` value, so no non-alert input is ever reconstructed or lost. It publishes a lowering only when `featureCount + 5 >= ` the `/alerts/active/count` total AND the parse dropped at most 5 features — the count proves the population arrived, the drop proves the parse understood it, and a drift that renames `properties.event` would otherwise pass the first clause with zero alerts and clear the country. Canadian beaches are raise-only for want of a count endpoint. It skips any beach whose `recompute_updated` in D1 is newer than its standing `updated`, since that value is a stale KV replica the hourly has already superseded. It writes only `"flag:"` (with a remaining-lease TTL and the standing `updated`, never a fresh one) and the map directory, and must never gain a `wqfloor:`, `official:`, `flag_history` or `recompute_updated` write.
   - `"15 */6 * * *"` (6-hourly): `runWaterTempRefresh`, the sole writer of `"watertemp:" + beachId`. It reads NDBC `WTMP` from the nearest station carrying `CAP_WATER_TEMP` in `src/waveSources/ndbcBuoys.js` within a 25 km cap, with a 32 KB `Range` header because the NOS water-level gauges that dominate that set publish ~1 MB realtime2 files. Display-only: the detail page shows it in `.beach-subtitle`, it never feeds `src/rules.js`, and it never bumps `RULES_VERSION`. It rotates on its own `wave_updated` cursor (migration 0012). The two crons must not share a cursor: the hourly cron rewrites `recompute_updated` to one shared `nowIso` for its entire run, flattening the column so a cold-tier sort over it collapses to `id ASC` and a fixed tail of the table starves forever.
   - `"17 3,9,15,21 * * *"`: NWS point enrichment — beaches with `nws_zone` NULL get `nws_zone`/`nws_grid_url` via api.weather.gov/points, 75 per run, ordered fewest-attempts-first, then `last_viewed DESC` so recently-viewed beaches drain their zone gap first, then `RANDOM()`.
   - `"29 4,10,16,22 * * *"`: ECCC zone enrichment for Canadian beaches NWS enrichment has permanently parked, 50 per run, same queue order. One bulk `fetchEcccForecastZones()` fetch per run plus local point-in-polygon (`ecccZoneNameForPoint`); a failed bulk fetch parks the whole run.
   - `"31 9 * * *"`: Windy webcam hydration, 100 lookups per run. Due beaches on one coarse grid cell share a single bbox `/webcams` request; lone, cap-truncated and failed buckets fall back to per-beach queries. Ordered never-checked-first, then `last_viewed DESC`, then oldest-checked-first.
3. **Offline path** (GitHub Actions, Deno plus native shell tools, not in the Worker): two pipelines, designed in `docs/offline-discovery.md` and `docs/offline-waves.md`. `scripts/discovery-batch.js` owns discovery, classification and `marine_zone`, fed by the twice-weekly layer build (`build-layers.yml`) and run daily by `discovery.yml`; the NOAA GRIB2 wave cycle (`waves.yml`, `"52 */3 * * *"`) is the sole producer of the wave inputs the hourly cron reads. What bites from outside those documents:

   - The batch makes no upstream data queries and runs with no network permission at all (`deno run --allow-read --allow-write`). The only network-touching offline scripts are `scripts/fetch-layers.js` and `scripts/fetch-wave-grids.js`, and GDAL runs in the workflow shell, so no Deno script carries `--allow-run`; `.github/workflows/test.yml` enforces the network half machine-side. The layers are read by the offline batch alone, so R2 is never on the request path and `wrangler.toml` deliberately has no `r2_buckets` binding.
   - `CPL_TMPDIR` must be set explicitly on the layer build's `ogr2ogr` read: an exhausted GDAL node-index temp filesystem emits a flood of "Cannot read node" and then returns an empty result with a zero exit status.
   - The R2 bucket is `swim-report`, with a hyphen. The zone is `swim.report` with a dot, and R2 answers `AccessDenied` rather than `NoSuchBucket` for a bucket a token cannot see, so the dotted form fails looking exactly like a bad secret.
   - Both publishers write an immutable per-build or per-cycle prefix and overwrite the small `current.json` pointer last, so a reader can never see a torn set.
   - Reconciliation is the only delete path, and both it and classification run only under a verified manifest — the pure gate `reconciliationAllowed(report)` in `src/layerManifest.js` — because a partial view of OSM must never read as "gone from OSM", and must never be allowed to decide `inland`, which hides beaches. Three proportional rails sit on top: a global delete cap, a per-`REGIONS`-box delete cap, and `CLASSIFY_MAX_HIDE_FLIPS` / `CLASSIFY_MAX_HIDE_FRACTION` against mass re-classification, since a hide is invisible in the row count and no delete rail can see it.
   - A layer build is not delete-bearing: a failed or sanity-refused build leaves the previous set live, which is delete-safe because an older extract is over-inclusive. A failed or refused wave cycle writes no KV at all, so its failure mode is a flag aging out to unknown, never a stale wave height deciding a color.
   - Wave KV pairs carry an absolute `expiration` of `validStartEpoch + 25200` rather than a write-time TTL, so a key expires 7 h after the hour it describes regardless of when the job ran, and republishing an older cycle is refused by construction.
   - GRIB2 DRS template 5.40 is JPEG 2000 with no pure-JS decode path: decoding requires GDAL, so it is impossible inside the Worker and must never be attempted there. Grid choice is constrained by `beaches.water_class`, since `noaa_glwu` is the only source for the Great Lakes, which gfswave masks entirely. Beach coordinates frequently land on masked land cells, so the nearest-wet-cell spiral is the sampling mechanism, not a fallback.
   - `data/marine-zones-greatlakes.json` (`src/marineZones.js`) drives a local nearest-marine-zone pass over US beaches that already have `nws_zone`, emitting change-only UPDATEs and never touching the delete path. Regenerate it with `scripts/build-marine-zones.js` when NWS publishes a new marine-zone shapefile.

### The Worker entry module (`src/index.js`)

workerd treats **every named export of the entry module as a potential entrypoint** and rejects any that is not a function or an `ExportedHandler`. A single `export const FOO = 123` there kills the whole Worker at startup:

```
Uncaught TypeError: Incorrect type for map entry 'FOO': the provided value is not of type 'function or ExportedHandler'.
```

Nothing in CI sees this — the module imports fine under vitest, and `wrangler deploy --dry-run` only bundles, never boots the runtime — so it surfaces at `npm run dev` or on a real deploy. Shared constants belong in their own module that `src/index.js` imports (`src/demandWindow.js` is the precedent); function exports for tests are fine. `test/workerExports.test.js` guards this.

### Platform limits that actually bind

Design the crons against these, not against intuition:

- **15 minutes wall clock per cron invocation.** CPU is *not* the binding constraint: a cron that walks the whole beach table spends almost all of it idle on upstreams and KV, so budget wall time, not work.
- **~6 simultaneous open connections per invocation**, with KV `get`/`put` counting toward it. A pool of 12, 25 or 50 all deliver ~6 in flight, so size concurrency math at 6 or the arithmetic is fiction (`KV_WRITE_CONCURRENCY` requests 12 for headroom, not throughput).
- **A Cron Trigger under a 1 hour interval gets 30 seconds of CPU, not 15 minutes.** Wall clock stays 15 minutes for every cron either way. So the sub-hour rule is not about CPU: it is that no cron which fans out an upstream call per beach may go sub-hourly, because that is what consumes wall clock.
- **Cron Triggers are capped at 5 per ACCOUNT on Free and 250 on Paid.** This Worker's sixth trigger is a Paid-plan dependency.
- **KV: 1,000 operations per invocation is documented** but not enforced — this Worker exceeds it hourly without error. Treat it as watched, not bounded.
- **GitHub Actions crons are skipped, not merely deferred.** A pipeline's cadence must tolerate consecutive missed occurrences, not just late ones. The wave cycle runs 8 slots a day against a 7 h absolute key expiration, tolerating two consecutive misses before beaches age out to unknown.
- Every upstream call must pass `timeoutMs` — see "Error isolation".

### Reading production logs

`wrangler tail` is **live-only**, so it cannot see a cron that already ran. For anything historical use the observability API:

```bash
set -a && . ./.dev.vars && set +a
ACC=0e01552527359dfcce6edc27ebedb530
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/observability/telemetry/query" \
  -H "Authorization: Bearer $CLOUDFLARE_WORKERS_EDIT_TOKEN" -H "Content-Type: application/json" \
  -d '{"queryId":"q","timeframe":{"from":<ms>,"to":<ms>},"parameters":{"datasets":["cloudflare-workers"],
       "filters":[{"key":"$workers.scriptName","operation":"eq","value":"swim-report","type":"string"}],
       "limit":100},"view":"events"}'
```

Always filter on `$workers.scriptName`, or you get other Workers in this account, whose cron triggers look like ours. Use `"view":"invocations"` rather than `"events"` for `outcome` / `wallTimeMs` / `cpuTimeMs`: `outcome: "exceededWallTime"` is invisible in the events view. A run whose completion log line is simply *absent* was killed.

### Single source of color

`src/rules.js#estimateFlag(inputs)` is the **only** place an estimated flag color is decided. It is pure and versioned (`RULES_VERSION`): structured inputs in, complete flag object out (`color`, `reason`, `rules_version`, `official: false`, `sources`, `updated`); no fetch, no `Date.now()`.

Precedence, first match wins: NWS alerts (`ALERT_PRECEDENCE`) → ECCC alerts for Canadian beaches (`ECCC_ALERT_PRECEDENCE`, lowercase `alert_name_en` strings, watches deliberately unmapped) → SRF rip-current risk (HIGH red, MODERATE yellow) → wave height (≥4 ft red, ≥2 ft yellow, else green) → wind fallback, only when all wave models are null → unknown, gray and honest. Within each alert list every double-red must precede every red, since the loop takes the first match regardless of color. Three raise-only floors then apply, each able to lift a lower color but never lower a higher one: `NWS_FLOOR_PRECEDENCE`, `ECCC_FLOOR_PRECEDENCE` and the water-quality floor (worst-of by `SEVERITY_RANK`). Flooring rather than mapping is what stops a yellow alert masking a wave-height red. PLAN.md and README's rules table carry the full alert-name lists.

The sole exception is `src/officialSources/` reporting a *scraped official* color. Any rule or threshold change requires bumping `RULES_VERSION` and updating the tests plus README's rules table. `windGustMph` is permanently null because gfswave publishes no GUST element, so the wind red test is speed alone and `rules.js` renders `n/a` for the gust.

### Error isolation

Every client in `src/clients/` returns data-or-`null` and never throws across its module boundary; the cron isolates per-beach and per-zone failures so one bad upstream never poisons the batch. The three alert clients share the pure match/dedupe walk in `src/clients/alertMatch.js`, which deliberately does not wrap the caller's match predicate in a try/catch — only `ecccMarine` catches, inside its own predicate closure, so the other two still propagate a genuine throw instead of silently dropping alerts. All api.weather.gov requests must send `NWS_USER_AGENT`, and every ECCC GeoMet request sends `ECCC_USER_AGENT`. A wave model masks land, so a null wave value for a coastal point is normal rather than an error.

**Every upstream call must pass `timeoutMs`.** `src/clients/http.js` arms its `AbortController` only when `timeoutMs > 0`, so a call site that omits it is genuinely unbounded — and a wall-clock deadline cannot save it, because deadlines are checked between units of work, never inside a pending fetch. One hung socket then runs a cron to the 900 s scheduled ceiling and kills it mid-run. `NWS_TIMEOUT_MS` and `ECCC_TIMEOUT_MS` are both 45 s, covering every api.weather.gov request and both GeoMet bulk collections; anything routed through `fetchText` in `src/officialSources/util.js` is bounded by its unconditional 30 s default.

### Frontend

`src/frontend/render.js` renderers are pure string builders: data (including a `now` timestamp) in, complete HTML out — no fetching, no Date access. Web Awesome Pro loads via the version-pinned CDN kit (`WA_KIT_BASE`, matter theme plus mild palette, matching `wa-theme-matter wa-palette-mild` classes on `<html>`), with font-token overrides in `WA_THEME_OVERRIDES` and Font Awesome icons via `data-fa-kit-code`. The pinned CDN files are immutable, so kit-builder theme edits do not auto-apply; re-copy changed snippet values into `render.js`. The bundled Web Awesome component and design skills at `node_modules/@web.awesome.me/webawesome-pro/dist/skills/{webawesome,webawesome-design}/SKILL.md` come first when writing or styling frontend markup.

Non-negotiable UI invariants: the footer disclaimer ("Estimated — not the official flag status…") on every page; a stale-data warning when `updated` is older than 2 h by default (`STALE_MS`), overridable per official record by a scraper's optional `staleMs`, with an optional neutral `readingNote` callout for point-in-time readings between 2 h and `staleMs` (the warning always wins over the note, the estimate card always uses the plain 2 h default, and the wave strip keeps its own 8 h `WAVE_STALE_MS`); gray, honest `unknown` and never a green default; and a visible distinction between official and estimated.

### Adding an official-source scraper

Implement the scraper contract from PLAN.md (`matches(beach)` plus `scrape()` returning `{color, official: true, source, updated}`, or `null` on any failure) in `src/officialSources/`, and register it in the `scrapers` array in `src/officialSources/index.js`. A scraper may also declare the optional `staleMs`, `readingNote` and `officialTtlSeconds` fields; an `officialTtlSeconds` longer than the estimate's `FLAG_TTL_SECONDS` (25200) requires the map directory to start carrying the official's own expiry instant first, because it infers the pair's expiry from the estimate. Parse defensively: a markup change upstream must degrade to `null`, never a wrong color. README has the full how-to.
