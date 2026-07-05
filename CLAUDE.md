# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm test` — run the full Vitest suite
- `npx vitest run test/rules.test.js` — run a single test file
- `npm run dev` — local dev server (`wrangler dev`; `predev` auto-applies migrations to local D1). Starts with an EMPTY local database — populate it explicitly with `npm run seed`.
- `npm run seed` — with the dev server running, trigger the daily Overpass discovery cron locally (`curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=47+8+*+*+*"`). Hits the live Overpass API and takes ~2 minutes; run it once per fresh database, not on every dev start. `npm run seed:flags` triggers the hourly flag-recompute cron the same way.
- Cron triggering in local dev goes through `/cdn-cgi/handler/scheduled?cron=<urlencoded cron>` — the old `--test-scheduled` flag and `/__scheduled` path are obsolete in wrangler 4.
- `npm run deploy` — deploy (`wrangler deploy`); `npx wrangler deploy --dry-run` to validate config without deploying
- `npx wrangler d1 migrations apply swim-report` — apply `migrations/` to D1

`npm install` needs `WEBAWESOME_NPM_TOKEN` exported in the environment (value in `.dev.vars`, which is gitignored) — `.npmrc` routes `@web.awesome.me`, `@awesome.me`, and `@fortawesome` through private registries.

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
2. **Cron path** (`scheduled` in `src/index.js`, dispatched on `controller.cron`): all upstream fetching happens here.
   - `"0 * * * *"` (hourly): reads beaches from D1, gathers inputs via `src/clients/*`, computes estimates, scrapes official sources, writes KV `"flag:" + beachId` and `"official:" + beachId` with `expirationTtl: 7200`.
   - `"47 8 * * *"` (daily): Overpass beach discovery (pilot bbox: Michigan/Great Lakes) upserted into the D1 `beaches` table, enriched with `nws_zone`/`nws_grid_url` via api.weather.gov/points.

### Single source of color

`src/rules.js#estimateFlag(inputs)` is the **only** place an estimated flag color is decided. It is pure and versioned (`RULES_VERSION`): structured inputs in, complete flag object out (`color`, `reason`, `rules_version`, `official: false`, `sources`, `updated`); no fetch, no `Date.now()` (timestamp passed in). Precedence: NWS alerts (High Surf Warning → double-red; Beach Hazards Statement / High Surf Advisory / Rip Current Statement → red) → SRF rip-current risk (HIGH → red, MODERATE → yellow) → wave height (≥4 ft red, ≥2 ft yellow, else green) → wind fallback (only when all wave models null) → unknown (gray, honest). The sole exception is `src/officialSources/` reporting a *scraped official* color. Any rule/threshold change requires bumping `RULES_VERSION` and updating the tests plus README's rules table.

### Error isolation

Every client in `src/clients/` returns data-or-`null` and never throws across its module boundary; the cron isolates per-beach/per-zone failures so one bad upstream never poisons the batch. All api.weather.gov requests must send the `User-Agent` header (`NWS_USER_AGENT` in `src/clients/nws.js`). Open-Meteo marine data commonly returns null/masked cells on the Great Lakes — treat null wave data as normal, not an error.

### Frontend

`src/frontend/render.js` renderers are pure string builders: data (including a `now` timestamp) in, complete HTML out — no fetching, no Date access. Web Awesome Pro loads via the version-pinned CDN kit (`WA_KIT_BASE`, matter theme + mild palette, matching `wa-theme-matter wa-palette-mild` classes on `<html>`); font-token overrides live in `WA_THEME_OVERRIDES` (system font stacks, no webfont downloads). Font Awesome icons resolve via `data-fa-kit-code` on `<html>`. Theme edits in the kit builder do not auto-apply — the pinned CDN files are immutable; re-copy changed snippet values into `render.js`. Non-negotiable UI invariants: footer disclaimer ("Estimated — not the official flag status…") on every page, stale-data warning when `updated` is older than 2 h, gray/honest `unknown` (never a green default), official-vs-estimated visual distinction.

The Web Awesome component/design skills are bundled in the repo at `node_modules/@web.awesome.me/webawesome-pro/dist/skills/{webawesome,webawesome-design}/SKILL.md` — read them before writing or styling frontend markup.

### Adding an official-source scraper

Implement the scraper contract from PLAN.md (`matches(beach)` + `scrape()` returning `{color, official: true, source, updated}` or `null` on any failure) in `src/officialSources/`, register it in the `scrapers` array in `src/officialSources/index.js`. Parse defensively — a markup change on the source site must degrade to `null`, never a wrong color. README has the full how-to.
