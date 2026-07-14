// src/officialSources/lenawee.js
// Official scraper for the Lenawee County (Michigan) Health Department Public
// Beach Monitoring page, which reports a per-beach E. coli health advisory
// status (not a flag color) for two beaches: Hayes State Park and Lake
// Hudson Recreation Area. "No Advisory Posted" is treated as green (safe to
// swim per the county's own monitoring program); any other status wording
// has never been observed live, so it is intentionally NOT mapped to a
// color — a beach with unrecognized or stale status text is simply omitted
// (no official data), never guessed.
// scrape() runs cron-side only; parseLenaweeHtml is pure and exported for
// tests.

import { fetchText, perBeachResult, resolveSiteForBeach, MS_PER_DAY } from "./util.js";

export const LENAWEE_URL = "https://www.lenawee.mi.us/1099/Public-Beach-Monitoring";

// Beach coordinates (Lenawee County, Irish Hills area, MI), verified against
// public park listings.
export const HAYES_STATE_PARK_LAT = 42.0654;
export const HAYES_STATE_PARK_LON = -84.1409;
export const LAKE_HUDSON_LAT = 41.8361;
export const LAKE_HUDSON_LON = -84.2417;

const LENAWEE_MATCH_RADIUS_MI = 3;
const STALE_MS = 10 * MS_PER_DAY;

// The same name-substring-or-within-radius rule that resolveSiteForBeach
// applies at resolution time, expressed as static site descriptors so
// matches() and resolution can never drift apart.
const LENAWEE_MATCH_SITES = [
  {
    names: ["hayes state park"],
    lat: HAYES_STATE_PARK_LAT,
    lon: HAYES_STATE_PARK_LON,
    radiusMi: LENAWEE_MATCH_RADIUS_MI
  },
  {
    names: ["lake hudson"],
    lat: LAKE_HUDSON_LAT,
    lon: LAKE_HUDSON_LON,
    radiusMi: LENAWEE_MATCH_RADIUS_MI
  }
];

// Pure. The GREEN gate. A beach is only reported green when its status field
// normalizes EXACTLY to "no advisory posted" (whitespace collapsed, a single
// trailing period/space stripped, case-insensitive). Deliberately NOT a
// substring test: a status that merely CONTAINS the phrase while meaning
// something dangerous (e.g. "Advisory posted; prior No Advisory Posted status
// void") must degrade to omission, never to a guessed green.
function isNoAdvisoryPosted(statusText) {
  if (typeof statusText !== "string") {
    return false;
  }
  const normalized = statusText
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
  return normalized === "no advisory posted";
}

// Pure. Converts captured M/D/YY(YY) [H:MM AM/PM] regex groups into a UTC
// epoch ms timestamp. Does not read the system clock — every component
// comes from the already-matched string.
function lastUpdatedPartsToMs(monthStr, dayStr, yearStr, hourStr, minuteStr, ampmStr) {
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  let year = parseInt(yearStr, 10);
  if (year < 100) {
    year += 2000;
  }
  let hour = 0;
  let minute = 0;
  if (hourStr && minuteStr) {
    hour = parseInt(hourStr, 10);
    minute = parseInt(minuteStr, 10);
    if (ampmStr) {
      const period = ampmStr.toUpperCase();
      if (period === "PM" && hour !== 12) {
        hour += 12;
      }
      if (period === "AM" && hour === 12) {
        hour = 0;
      }
    }
  }
  return Date.UTC(year, month - 1, day, hour, minute);
}

// Pure. html + nowIso -> sites[] (possibly empty) | null.
// null means the page structure has changed enough that nothing can be
// trusted (missing table, wrong number of beach blocks, unparseable
// timestamp). An empty array means the structure parsed fine but every site
// was omitted (unrecognized status text and/or stale timestamp) — that is a
// normal, correct outcome, not an error.
export function parseLenaweeHtml(html, nowIso) {
  if (!html) {
    return null;
  }

  const startMarker = /<h2[^>]*class="subhead1"[^>]*>\s*Beaches\s*<\/h2>/i;
  const startMatch = startMarker.exec(html);
  if (!startMatch) {
    console.log("lenawee: could not find Beaches section, skipping");
    return null;
  }
  // Scope the end-marker search to the text AFTER the Beaches header. (A
  // non-global regex ignores lastIndex and always scans from index 0, so we
  // slice the tail explicitly — otherwise a stray copy of this phrase earlier
  // in the document would collapse the region to an empty string.)
  const afterStart = startMatch.index + startMatch[0].length;
  const endMarker = /Public Beach Water Testing Results/i;
  const endMatch = endMarker.exec(html.slice(afterStart));
  const region = html.slice(
    startMatch.index,
    endMatch ? afterStart + endMatch.index : html.length
  );

  const headerRegex = /<h2[^>]*class="subhead1"[^>]*>\s*<strong>\s*([^<]+?)\s*<\/strong>\s*<\/h2>/gi;
  const headers = [];
  let match;
  while ((match = headerRegex.exec(region)) !== null) {
    headers.push(match[1].trim());
  }
  if (headers.length !== 2) {
    console.log("lenawee: expected 2 beach blocks, found " + headers.length + ", skipping");
    return null;
  }
  const hasHayes = headers.some(function(name) { return /hayes state park/i.test(name); });
  const hasHudson = headers.some(function(name) { return /lake hudson/i.test(name); });
  if (!hasHayes || !hasHudson) {
    console.log("lenawee: beach block names did not match expected beaches, skipping");
    return null;
  }

  const statusRegex = /Status:\s*([^<]+?)\s*<\/div>/gi;
  const statuses = [];
  while ((match = statusRegex.exec(region)) !== null) {
    statuses.push(match[1].trim());
  }
  if (statuses.length !== headers.length) {
    console.log("lenawee: expected " + headers.length + " status blocks, found " + statuses.length + ", skipping");
    return null;
  }

  const lastUpdatedRegex = /Last Updated:\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})\s*([AP]M))?/i;
  const lastUpdatedMatch = lastUpdatedRegex.exec(region);
  if (!lastUpdatedMatch) {
    console.log("lenawee: could not find a parseable Last Updated timestamp, skipping");
    return null;
  }
  const lastUpdatedText = lastUpdatedMatch[0].replace(/^Last Updated:\s*/i, "").trim();
  const lastUpdatedMs = lastUpdatedPartsToMs(
    lastUpdatedMatch[1],
    lastUpdatedMatch[2],
    lastUpdatedMatch[3],
    lastUpdatedMatch[4],
    lastUpdatedMatch[5],
    lastUpdatedMatch[6]
  );
  const nowMs = Date.parse(nowIso);
  const isStale = !isNaN(nowMs) && !isNaN(lastUpdatedMs) && (nowMs - lastUpdatedMs > STALE_MS);
  if (isStale) {
    console.log("lenawee: Last Updated (" + lastUpdatedText + ") is older than 10 days, omitting all sites");
    return [];
  }
  // updated is the page's own Last Updated timestamp, not nowIso. This is a
  // periodic (weekly E. coli) source: stamping nowIso would make a days-old
  // reading look freshly updated and permanently suppress the frontend's
  // 2-hour stale-data warning. new Date(ms).toISOString() is a pure
  // computation over the already-parsed components — no ambient clock.
  const updatedIso = new Date(lastUpdatedMs).toISOString();

  const sites = [];
  for (let i = 0; i < headers.length; i++) {
    const name = headers[i];
    const statusText = statuses[i];
    const isHayes = /hayes state park/i.test(name);
    const isHudson = /lake hudson/i.test(name);
    if (!isHayes && !isHudson) {
      continue;
    }
    if (!isNoAdvisoryPosted(statusText)) {
      // The ONLY status wording ever observed (live 2026-07-09 + four Wayback
      // snapshots Aug 2023-Apr 2024) is "No Advisory Posted". The exact string
      // the county writes into the Status field when an advisory IS active has
      // never been captured, so it is intentionally NOT mapped to a color --
      // omit, never guess. Log the VERBATIM status text LOUDLY with a
      // greppable marker so the real active-advisory wording can be lifted
      // straight out of production logs the first time it appears, and mapped
      // then (advisory -> yellow or red per its meaning).
      console.log(
        "lenawee: UNMAPPED STATUS -- capture this verbatim wording to add a " +
        "color mapping. beach=\"" + name + "\" status=\"" + statusText +
        "\" (omitting, never guessing a color)"
      );
      continue;
    }
    if (isHayes) {
      sites.push({
        siteId: "hayes-state-park",
        color: "green",
        reason:
          "Official flag reported by Lenawee County Health Department for Hayes State Park (" +
          statusText + ", last updated " + lastUpdatedText + ")",
        names: ["hayes state park"],
        lat: HAYES_STATE_PARK_LAT,
        lon: HAYES_STATE_PARK_LON,
        radiusMi: LENAWEE_MATCH_RADIUS_MI,
        updated: updatedIso
      });
    } else {
      sites.push({
        siteId: "lake-hudson",
        color: "green",
        reason:
          "Official flag reported by Lenawee County Health Department for Lake Hudson Recreation Area (" +
          statusText + ", last updated " + lastUpdatedText + ")",
        names: ["lake hudson"],
        lat: LAKE_HUDSON_LAT,
        lon: LAKE_HUDSON_LON,
        radiusMi: LENAWEE_MATCH_RADIUS_MI,
        updated: updatedIso
      });
    }
  }

  return sites;
}

export const lenawee = {
  id: "lenawee-mi",
  label: "Lenawee County Health Department",
  url: LENAWEE_URL,
  matches: function(beach) {
    return resolveSiteForBeach(beach, LENAWEE_MATCH_SITES) !== null;
  },
  scrape: async function(nowIso) {
    // No headers: lenawee.mi.us has only been probed without a User-Agent.
    const html = await fetchText(LENAWEE_URL, {
      logPrefix: "lenawee: fetch failed"
    });
    if (html === null) {
      return null;
    }
    try {
      const sites = parseLenaweeHtml(html, nowIso);
      if (!sites || sites.length === 0) {
        return null;
      }
      // result-level updated is a fallback only — every emitted site carries
      // updated: the page's own Last Updated timestamp, which wins in
      // scrapeOfficialFlagFromResult.
      return perBeachResult(sites, LENAWEE_URL, nowIso);
    } catch (err) {
      console.log("lenawee: fetch failed: " + err.message);
      return null;
    }
  }
};
