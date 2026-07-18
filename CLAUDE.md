# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm test` — run the full Vitest suite
- `npx vitest run test/rules.test.js` — run a single test file
- `npm run dev` — local dev server (`wrangler dev`; `predev` auto-applies migrations to local D1). Starts with an EMPTY local database — populate it explicitly with `npm run seed`.
- `npm run seed` — with the dev server running, trigger the daily Overpass discovery cron locally (`curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=47+8+*+*+*"`). Hits the live Overpass API and takes ~2 minutes; run it once per fresh database, not on every dev start. `npm run seed:enrich` (NWS point enrichment, 75 beaches/run — repeat to drain the queue), `npm run seed:eccc` (ECCC zone enrichment for Canadian rows NWS has parked), `npm run seed:webcams` (Windy webcam hydration), and `npm run seed:flags` (hourly flag recompute) trigger the other four crons the same way.
- Cron triggering in local dev goes through `/cdn-cgi/handler/scheduled?cron=<urlencoded cron>` — the old `--test-scheduled` flag and `/__scheduled` path are obsolete in wrangler 4.
- `npm run deploy` — deploy (`wrangler deploy`); `npx wrangler deploy --dry-run` to validate config without deploying
- `npx wrangler d1 migrations apply swim-report --local` (dev) / `--remote` (production) — apply `migrations/` to D1
- Wrangler auth: there is no `wrangler login` session on this machine — export `CLOUDFLARE_API_TOKEN` from the `CLOUDFLARE_TOKEN` value in `.dev.vars` before any wrangler command that talks to the Cloudflare API (deploy, remote migrations, secrets, tail).

## Production

Deployed 2026-07-13 at **https://swim.report** (custom-domain route). `wrangler.toml` carries the real D1/KV IDs plus observability (full head sampling), Smart Placement, and a pinned `compatibility_date` (bump occasionally). The `WINDY_WEBCAM_API_TOKEN` Worker secret is set. Remote data populates via the crons only — there is no remote `npm run seed`; the request path serves whatever D1/KV currently hold.

`npm install` needs both `WEBAWESOME_NPM_TOKEN` and `FONTAWESOME_NPM_TOKEN` exported in the environment (values in `.dev.vars`, which is gitignored) — `.npmrc` routes `@web.awesome.me`/`@awesome.me` and `@fortawesome` through private registries via `${VAR}` placeholders; never hardcode a token in `.npmrc`.

## Mandatory JavaScript style

All project source and tests are plain JavaScript (no TypeScript), ES modules, and:

- `const`/`let` only, never `var`
- String concatenation with `+`, **never template literals** — no backticks anywhere
- `console.log` for logging

## Architecture

Single Cloudflare Worker (`wrangler.toml`, modules syntax) that **estimates** beach hazard flag status (green / yellow / red / double-red / unknown) for US beaches. The core product constraint: estimated conditions must never be presentable as official flag status — every payload carries `official: true|false` and the UI renders them distinctly (badges, footer disclaimer).

**PLAN.md is the authoritative contract** — exact D1 schema, KV shapes, module signatures, rules precedence, and reason-string formats. Update it when changing any cross-module interface. README.md documents the public API and rules table; TODO.md tracks known gaps.

### The two-path rule (never violate)

1. **Request path** (`fetch` → `src/router.js` → `src/frontend/render.js`): reads **only** D1 and KV. No upstream `fetch()` may ever be reachable from here.
2. **Cron path** (`scheduled` in `src/index.js`, dispatched on `controller.cron`): all upstream fetching happens here, split across five independent triggers so one upstream's failure or rate limit never starves another.
   - `"0 * * * *"` (hourly): reads beaches from D1, gathers inputs via `src/clients/*`, computes estimates, scrapes official sources, writes KV `"flag:" + beachId` and `"official:" + beachId` with `expirationTtl: 7200`.
   - `"47 8 * * *"` (daily): Overpass beach discovery (pilot bbox: Michigan/Great Lakes) upserted into the D1 `beaches` table.
   - `"17 3,9,15,21 * * *"` (4x daily): NWS point enrichment — beaches with `nws_zone` NULL get `nws_zone`/`nws_grid_url` via api.weather.gov/points, 75 per run.
   - `"29 4,10,16,22 * * *"` (4x daily): ECCC zone enrichment — Canadian beaches NWS enrichment permanently parked get `eccc_zone` (public forecast region NAME) via the GeoMet API, 50 per run.
   - `"31 9 * * *"` (daily): Windy webcam hydration, 100 lookups per run.

### Single source of color

`src/rules.js#estimateFlag(inputs)` is the **only** place an estimated flag color is decided. It is pure and versioned (`RULES_VERSION`): structured inputs in, complete flag object out (`color`, `reason`, `rules_version`, `official: false`, `sources`, `updated`); no fetch, no `Date.now()` (timestamp passed in). Precedence: NWS alerts (High Surf Warning → double-red; Beach Hazards Statement / High Surf Advisory / Rip Current Statement → red) → ECCC alerts for Canadian beaches (lowercase `alert_name_en` strings; tornado / storm surge warning → double-red; squall / waterspout / severe thunderstorm / wind warning → red; watches deliberately unmapped) → SRF rip-current risk (HIGH → red, MODERATE → yellow) → wave height (≥4 ft red, ≥2 ft yellow, else green) → wind fallback (only when all wave models null) → unknown (gray, honest). The sole exception is `src/officialSources/` reporting a *scraped official* color. Any rule/threshold change requires bumping `RULES_VERSION` and updating the tests plus README's rules table.

### Error isolation

Every client in `src/clients/` returns data-or-`null` and never throws across its module boundary; the cron isolates per-beach/per-zone failures so one bad upstream never poisons the batch. All api.weather.gov requests must send the `User-Agent` header (`NWS_USER_AGENT` in `src/clients/nws.js`); api.weather.gc.ca (ECCC GeoMet, `src/clients/eccc.js`) needs no auth or User-Agent. Open-Meteo marine data commonly returns null/masked cells on the Great Lakes — treat null wave data as normal, not an error.

### Frontend

`src/frontend/render.js` renderers are pure string builders: data (including a `now` timestamp) in, complete HTML out — no fetching, no Date access. Web Awesome Pro loads via the version-pinned CDN kit (`WA_KIT_BASE`, matter theme + mild palette, matching `wa-theme-matter wa-palette-mild` classes on `<html>`); font-token overrides live in `WA_THEME_OVERRIDES` (system font stacks, no webfont downloads). Font Awesome icons resolve via `data-fa-kit-code` on `<html>`. Theme edits in the kit builder do not auto-apply — the pinned CDN files are immutable; re-copy changed snippet values into `render.js`. Non-negotiable UI invariants: footer disclaimer ("Estimated — not the official flag status…") on every page, stale-data warning when `updated` is older than 2 h, gray/honest `unknown` (never a green default), official-vs-estimated visual distinction.

The Web Awesome component/design skills are bundled in the repo at `node_modules/@web.awesome.me/webawesome-pro/dist/skills/{webawesome,webawesome-design}/SKILL.md` — read them before writing or styling frontend markup.

### Adding an official-source scraper

Implement the scraper contract from PLAN.md (`matches(beach)` + `scrape()` returning `{color, official: true, source, updated}` or `null` on any failure) in `src/officialSources/`, register it in the `scrapers` array in `src/officialSources/index.js`. Parse defensively — a markup change on the source site must degrade to `null`, never a wrong color. README has the full how-to.
