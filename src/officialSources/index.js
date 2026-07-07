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

import { southHaven } from "./southHaven.js";
import { lenawee } from "./lenawee.js";
import { metroparks } from "./metroparks.js";
import { michiganCity } from "./michiganCity.js";
import { ohioBeachGuard } from "./ohioBeachGuard.js";
import { hdnwMichigan } from "./hdnwMichigan.js";
import { bldhd } from "./bldhd.js";
import { chicagoParkDistrict } from "./chicagoParkDistrict.js";
import { wisconsinDnr } from "./wisconsinDnr.js";

// Ordered most-specific-match first: findScraper returns the FIRST scraper
// whose matches(beach) is true, so tight single-city boxes and fixed-site
// scrapers come before regional tables, and broad statewide bboxes come last.
export const scrapers = [
  southHaven,
  lenawee,
  metroparks,
  michiganCity,
  ohioBeachGuard,
  hdnwMichigan,
  bldhd,
  chicagoParkDistrict,
  wisconsinDnr
];

export const DEFAULT_SITE_RADIUS_MI = 1.5;

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

// Haversine great-circle distance in statute miles. Pure.
export function distanceMi(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const earthRadiusMi = 3958.8;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * earthRadiusMi * Math.asin(Math.sqrt(a));
}

// Pure. BeachRow + sites[] -> site | null.
// Pass 1 (names win over proximity): first site, in array order, with any
// names[] entry contained as a substring of
// ((beach.park_name || "") + " " + beach.name).toLowerCase().
// Pass 2: among sites with numeric lat/lon, the NEAREST one whose distance to
// the beach is within its radiusMi (default DEFAULT_SITE_RADIUS_MI = 1.5).
// Otherwise null.
export function resolveSiteForBeach(beach, sites) {
  if (!Array.isArray(sites)) {
    return null;
  }
  const haystack = ((beach.park_name || "") + " " + beach.name).toLowerCase();
  for (const site of sites) {
    if (Array.isArray(site.names)) {
      for (const name of site.names) {
        if (typeof name === "string" && name.length > 0 &&
            haystack.indexOf(name.toLowerCase()) !== -1) {
          return site;
        }
      }
    }
  }
  let best = null;
  let bestDistance = Infinity;
  for (const site of sites) {
    if (typeof site.lat !== "number" || typeof site.lon !== "number") {
      continue;
    }
    const radius = typeof site.radiusMi === "number"
      ? site.radiusMi
      : DEFAULT_SITE_RADIUS_MI;
    const distance = distanceMi(beach.lat, beach.lon, site.lat, site.lon);
    if (distance <= radius && distance < bestDistance) {
      best = site;
      bestDistance = distance;
    }
  }
  return best;
}

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
