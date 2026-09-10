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

import {
  resolveSiteForBeach,
  siteNamesMatchBeach,
  DEFAULT_SITE_RADIUS_MI
} from "./util.js";
import { distanceMi } from "../geo.js";
import { southHaven } from "./southHaven.js";
import { metroparks } from "./metroparks.js";
import { chicagoParkDistrict } from "./chicagoParkDistrict.js";
import { nwsOmr } from "./nwsOmr.js";
import { winnetkaTowerBeach } from "./winnetkaTowerBeach.js";
import { paDcnrPresqueIsle } from "./paDcnrPresqueIsle.js";
import { nwsMarineBeachForecast } from "./nwsMarineBeachForecast.js";

// This registry holds hazard flags (surf, rip, closure) — the authoritative
// version of what src/rules.js estimates. An official color overrides the
// estimate everywhere the beach's flag is shown (src/displayFlag.js displayFlag),
// with one bounded exception: once a reading has aged past the 2 h STALE_MS
// horizon a fresher estimate may raise the displayed color but never lower it.
// The official card always reports the scraped color verbatim.
//
// Water-quality (E. coli, bacteria) monitoring belongs in src/wqFloor/, not here:
// a clean-water reading is a different axis from surf hazard, and letting its
// green win would mask a genuine hazard estimate such as a gale-driven red.
//
// Ordered most-specific-first, since findScraper is first-match-wins: the tight
// single-city, fixed-site and narrow-park-cluster scrapers come first, and
// nwsMarineBeachForecast is last because its matches() is a broad Lake
// Erie/Ontario bbox that would otherwise shadow them.
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

// Per-beach site resolution (names win over proximity) lives in ./util.js so
// scrapers can reuse it without importing this registry; re-exported here for
// the cron and tests.
export { resolveSiteForBeach, DEFAULT_SITE_RADIUS_MI };

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Pure. BeachRow + resolved site -> { name, distanceMi } | null. Non-null only
// when the site declares a reportSiteName that is neither the beach's display
// name (park_name || name, matching render.js) nor claimed by the site's own
// names[], which is exactly the case where the card's reason names somewhere
// else. The names[] test is what keeps a beach that IS the report site from
// reading as transferred when the source qualifies its label ("Mears State Park
// (Pentwater)" for Charles Mears State Park). distanceMi is the real haversine
// distance when both the beach and the site carry finite coordinates, and null
// otherwise — a transfer distance is never inferred from an unlocated point.
// Exported for tests: resolveSiteForBeach's proximity pass needs finite
// coordinates on both sides and its name pass is suppressed here, so the
// null-distance guard cannot be reached through scrapeOfficialFlagFromResult
// and is only exercisable directly.
export function reportedForSite(beach, site) {
  const reportSiteName = typeof site.reportSiteName === "string"
    ? site.reportSiteName.trim()
    : "";
  if (reportSiteName.length === 0) {
    return null;
  }
  const displayName = String((beach.park_name || beach.name) || "").trim();
  if (displayName.toLowerCase() === reportSiteName.toLowerCase()) {
    return null;
  }
  if (siteNamesMatchBeach(beach, site)) {
    return null;
  }
  const located = isFiniteNumber(beach.lat) && isFiniteNumber(beach.lon) &&
    isFiniteNumber(site.lat) && isFiniteNumber(site.lon);
  return {
    name: reportSiteName,
    distanceMi: located
      ? distanceMi(beach.lat, beach.lon, site.lat, site.lon)
      : null
  };
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
    // Optional per-source staleness contract, read off the scraper object like
    // officialTtlSeconds in src/index.js, never off the per-fetch result. The
    // frontend's 2 h stale warning is calibrated to the hourly recompute; a source
    // that publishes once a day, or holds a human-posted status for days, is not
    // stale just because 2 h passed. A scraper declares its own horizon (staleMs)
    // and, for point-in-time readings, a neutral readingNote to show inside it.
    //
    // Validated hard, because staleMs suppresses a safety warning: typeof alone
    // admits NaN and Infinity (typeof NaN === "number"), and a NaN threshold makes
    // the renderer's (now - updated) > NaN false forever, silently disabling the
    // stale warning for that source. Invalid or absent omits the key entirely
    // rather than writing an undefined-valued one, keeping the KV records and the
    // public /api/flag response minimal and letting render fall back to its
    // default.
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
      if (site.color === null) {
        // The source reported this site with no posted flag. A documented state,
        // not a malformed value, so it is silent: a scraper whose table always
        // carries an unflagged site would otherwise log every hour forever. The
        // site may still carry readings, which scrapeReadingFromResult publishes
        // on its own key.
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
      // Attached after the literal, never inline as staleMs: maybeNull — an
      // undefined-valued key is not the same as an absent one to consumers that
      // compare whole records.
      if (staleMs !== null) {
        record.staleMs = staleMs;
      }
      if (readingNote !== null) {
        record.readingNote = readingNote;
      }
      // Same attach-after-the-literal rule: a beach reading a neighboring site's
      // posted flag carries the provenance, everyone else carries no key at all.
      const reportedFor = reportedForSite(beach, site);
      if (reportedFor !== null) {
        record.reportedFor = reportedFor;
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
    // A single-color source reports one reading for every beach it matches, so
    // there is no neighboring site to name. Deleted for the same reason: this
    // branch spreads the result, and a result-supplied reportedFor would reach
    // KV and the public /api/flag response unvalidated.
    delete flag.reportedFor;
    return flag;
  } catch (err) {
    console.log(
      "officialSources: resolve failed for " + scraper.id + ": " + err.message
    );
    return null;
  }
}

// Pure (no fetch). Resolves the point-in-time observations a scrape result
// carries for ONE beach, independent of whether that beach got a flag: a site
// reporting no posted flag still publishes its water temperature and wave
// height, and a site whose flag was rejected must not drag its readings down
// with it. Returns an OfficialReading (PLAN.md section 6) or null.
//
// Readings are display-only. They never reach src/rules.js, never override a
// color, and carry no color of their own — so unlike the flag path there is no
// severity to validate, only finiteness and provenance.
//
// Both numbers are optional and independently absent; a site with neither
// yields null rather than a record nobody can render. observedIso is the site's
// own timestamp when it has one, else the result-level updated, and must parse:
// the renderer drops a reading past READING_MAX_AGE_MS, which an unparseable
// instant would silently defeat.
export function scrapeReadingFromResult(beach, scraper, result) {
  try {
    if (!result || result.perBeach !== true) {
      return null;
    }
    const site = resolveSiteForBeach(beach, result.sites);
    if (!site) {
      return null;
    }
    const waterTempF = isFiniteNumber(site.waterTempF) ? site.waterTempF : null;
    const waveHeightFt = isFiniteNumber(site.waveHeightFt) ? site.waveHeightFt : null;
    if (waterTempF === null && waveHeightFt === null) {
      return null;
    }
    const observedIso = typeof site.updated === "string" && site.updated.length > 0
      ? site.updated
      : result.updated;
    if (typeof observedIso !== "string" || Number.isNaN(Date.parse(observedIso))) {
      return null;
    }
    const record = {
      beachId: beach.id,
      waterTempF: waterTempF,
      waveHeightFt: waveHeightFt,
      observedIso: observedIso,
      // The reporting site's own name, always rendered, so a beach reading a
      // neighboring site's observations says whose they are without needing the
      // flag card's reportedFor comparison.
      siteName: typeof site.reportSiteName === "string" ? site.reportSiteName : "",
      sourceLabel: typeof scraper.label === "string" ? scraper.label : "",
      source: result.source,
      scraperId: scraper.id
    };
    return record;
  } catch (err) {
    console.log(
      "officialSources: reading resolve failed for " + scraper.id + ": " + err.message
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
