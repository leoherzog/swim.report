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
import { nwsOmr } from "./nwsOmr.js";
import { winnetkaTowerBeach } from "./winnetkaTowerBeach.js";
import { paDcnrPresqueIsle } from "./paDcnrPresqueIsle.js";
import { nwsMarineBeachForecast } from "./nwsMarineBeachForecast.js";

// Ordered most-specific-match first: findScraper returns the FIRST scraper
// whose matches(beach) is true, so tight single-city boxes and fixed-site
// scrapers come before regional tables, and broad statewide bboxes come last.
//
// Registry scope note: this product's official flags are HAZARD flags
// (surf/rip/closure) — the authoritative version of what src/rules.js
// estimates — and an official color OVERRIDES the estimate everywhere it is
// shown (render.js markerFlagColor / titleColor). Water-quality (E. coli /
// bacteria) monitoring sources were intentionally removed: a clean-water
// reading is a DIFFERENT axis from surf hazard, and letting its "green" win
// would mask a genuine hazard estimate (e.g. a gale-driven red). Only
// hazard/flag/closure sources belong here.
// Ordering is most-specific-first (findScraper is first-match-wins):
//   - southHaven / metroparks / chicagoParkDistrict / nwsOmr /
//     winnetkaTowerBeach / paDcnrPresqueIsle all have tight single-city,
//     fixed-site, or narrow-park-cluster matches().
//   - nwsMarineBeachForecast is LAST: its matches() is a broad Lake
//     Erie/Ontario bbox, so every tighter scraper must be consulted first.
export const scrapers = [
  southHaven,
  metroparks,
  chicagoParkDistrict,
  nwsOmr,
  winnetkaTowerBeach,
  paDcnrPresqueIsle,
  nwsMarineBeachForecast
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
    // Optional per-source staleness contract, read off the SCRAPER OBJECT (like
    // officialTtlSeconds in src/index.js), never off the per-fetch result. The
    // frontend's 2 h stale warning is calibrated to OUR hourly recompute; a
    // source that publishes once a day (an NWS morning product) or holds a
    // human-posted status for days is not stale just because 2 h passed. A
    // scraper declares its own horizon (staleMs) and, for point-in-time
    // readings, a neutral note (readingNote) to show inside it.
    //
    // Validated hard, because staleMs SUPPRESSES a safety warning: typeof alone
    // admits NaN and Infinity (typeof NaN === "number"), and a NaN threshold
    // makes the renderer's (now - updated) > NaN false forever — silently
    // disabling the stale warning for that source. Invalid or absent -> OMIT the
    // key entirely rather than write an undefined-valued one: it keeps the KV
    // records (and the public /api/flag response) minimal and lets render fall
    // back to its default.
    const staleMs = typeof scraper.staleMs === "number" &&
      Number.isFinite(scraper.staleMs) && scraper.staleMs > 0
      ? scraper.staleMs
      : null;
    const readingNote = typeof scraper.readingNote === "string" &&
      scraper.readingNote.length > 0
      ? scraper.readingNote
      : null;
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
      const record = {
        beachId: beach.id,
        color: site.color,
        reason: reason,
        official: true,
        scraperId: scraper.id,
        source: result.source,
        sources: result.sources,
        updated: updated
      };
      // Attached AFTER the literal, never inline as staleMs: maybeNull — an
      // undefined-valued key is not the same as an absent one to consumers that
      // compare whole records.
      if (staleMs !== null) {
        record.staleMs = staleMs;
      }
      if (readingNote !== null) {
        record.readingNote = readingNote;
      }
      return record;
    }
    if (OFFICIAL_COLORS.indexOf(result.color) === -1) {
      console.log(
        "officialSources: invalid color from " + scraper.id + ", skipping"
      );
      return null;
    }
    const flag = Object.assign({}, result, {
      beachId: beach.id,
      official: true,
      scraperId: result.scraperId || scraper.id
    });
    // This branch SPREADS the scrape result, so a result that happened to carry
    // staleMs/readingNote would otherwise smuggle an unvalidated value into KV
    // and defeat the check above. These are scraper-object contract fields: the
    // declaration wins, and a result-only value never survives. Deleting from
    // the fresh copy leaves result itself untouched (this function must never
    // mutate result).
    if (staleMs !== null) {
      flag.staleMs = staleMs;
    } else {
      delete flag.staleMs;
    }
    if (readingNote !== null) {
      flag.readingNote = readingNote;
    } else {
      delete flag.readingNote;
    }
    return flag;
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
