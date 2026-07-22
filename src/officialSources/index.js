// src/officialSources/index.js
// Registry of official flag scrapers (contract v2, per-beach resolution).
// Append future scrapers to the scrapers array. Runs cron-side only; the
// fetch handler never touches this module's network-calling functions.
//
// scrape(nowIso) results come in two shapes (see PLAN.md section 6):
//   (a) legacy single-color — applied to every matched beach;
//   (b) multi-site ({ perBeach: true, sites: [...] }) — each matched beach is
//       resolved to at most one site via resolveSiteForBeach; beaches that
//       resolve to no site get no OfficialFlag (null).

import { distanceMi } from "../geo.js";
import { resolveSiteForBeach, DEFAULT_SITE_RADIUS_MI } from "./util.js";
import { southHaven } from "./southHaven.js";
import { metroparks } from "./metroparks.js";
import { chicagoParkDistrict } from "./chicagoParkDistrict.js";

// Ordered most-specific-match first: findScraper returns the FIRST scraper
// whose matches(beach) is true, so tight single-city boxes and fixed-site
// scrapers come before regional tables, and broad statewide bboxes come last.
//
// Registry scope note: this product's official flags are HAZARD flags
// (surf/rip/closure) — the authoritative version of what src/rules.js
// estimates — and an official color OVERRIDES the estimate everywhere it is
// shown (render.js markerFlagFields / titleColor). Water-quality (E. coli /
// bacteria) monitoring sources were intentionally removed: a clean-water
// reading is a DIFFERENT axis from surf hazard, and letting its "green" win
// would mask a genuine hazard estimate (e.g. a gale-driven red). Only
// hazard/flag/closure sources belong here.
export const scrapers = [
  southHaven,
  metroparks,
  chicagoParkDistrict
];

const OFFICIAL_COLORS = ["green", "yellow", "red", "double-red"];

export function findScraper(beach) {
  for (let i = 0; i < scrapers.length; i++) {
    const scraper = scrapers[i];
    if (scraper.matches(beach)) {
      return scraper;
    }
  }
  return null;
}

// Great-circle distance in statute miles. Re-exported from the dependency-free
// src/geo.js (a cycle is impossible through that module).
export { distanceMi };

// Per-beach site resolution (names win over proximity) lives in ./util.js so
// scrapers can reuse it without importing this registry; re-exported here for
// the cron and tests.
export { resolveSiteForBeach, DEFAULT_SITE_RADIUS_MI };

// Pure (no fetch). Resolves an already-fetched scrape result for ONE beach.
// Handles both result shapes and returns a complete OfficialFlag with beachId
// stamped, or null (no site resolved / invalid color / malformed result).
// The cron calls scrape(nowIso) once per scraper and feeds the shared result
// through this function for every matched beach; never mutates result.
export function scrapeOfficialFlagFromResult(beach, scraper, result) {
  try {
    if (!result) {
      return null;
    }
    if (result.perBeach === true) {
      const site = resolveSiteForBeach(beach, result.sites);
      if (!site) {
        return null;
      }
      if (OFFICIAL_COLORS.indexOf(site.color) === -1) {
        console.log(
          "officialSources: invalid site color from " + scraper.id +
          " site " + String(site.siteId) + ", skipping"
        );
        return null;
      }
      const reason = typeof site.reason === "string" && site.reason.length > 0
        ? site.reason
        : "Official flag reported by " + scraper.label;
      // Periodic sources (E. coli sampling, weekly reports) carry the reading's
      // own timestamp per site; prefer it over the result-level updated (which
      // real-time scrapers set to nowIso) so the frontend's stale-data warning
      // reflects when the source actually produced the data, not the cron tick.
      const updated = typeof site.updated === "string" && site.updated.length > 0
        ? site.updated
        : result.updated;
      return {
        beachId: beach.id,
        color: site.color,
        reason: reason,
        official: true,
        scraperId: scraper.id,
        source: result.source,
        sources: result.sources,
        updated: updated
      };
    }
    if (OFFICIAL_COLORS.indexOf(result.color) === -1) {
      console.log(
        "officialSources: invalid color from " + scraper.id + ", skipping"
      );
      return null;
    }
    return Object.assign({}, result, {
      beachId: beach.id,
      official: true,
      scraperId: result.scraperId || scraper.id
    });
  } catch (err) {
    console.log(
      "officialSources: resolve failed for " + scraper.id + ": " + err.message
    );
    return null;
  }
}

// -> OfficialFlag | null. Finds the scraper, awaits scraper.scrape(nowIso)
// inside try/catch, and resolves the result for this beach via
// scrapeOfficialFlagFromResult. Convenience single-beach path; the cron
// prefers calling scrape() once per scraper and resolving per beach.
export async function scrapeOfficialFlag(beach, nowIso) {
  const scraper = findScraper(beach);
  if (!scraper) {
    return null;
  }
  try {
    const result = await scraper.scrape(nowIso);
    return scrapeOfficialFlagFromResult(beach, scraper, result);
  } catch (err) {
    console.log("officialSources: scrape failed for " + scraper.id + ": " + err.message);
    return null;
  }
}
