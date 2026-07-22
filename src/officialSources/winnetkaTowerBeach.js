// src/officialSources/winnetkaTowerBeach.js
//
// KIND: official (src/officialSources hazard-override scraper).
// SOURCE: Winnetka Park District — Tower Road Beach (single beach, Lake
// Michigan, Illinois). Server-rendered status page at
//   https://rainoutline.com/search/extension/8475633131/9
// (live shape confirmed via curl on 2026-07-22: a
// <span class="status2">Open|Closed</span>&nbsp;-&nbsp;<free text reason>
// line, followed by a <span class="clue"><em>Last updated at M/D/YY H:MM am|pm
// ... </em></span> line). If the site's markup or URL ever changes shape
// this MUST degrade to null, never a wrong color.
//
// COLOR / FLOOR MAPPING (dangerous-conditions closure, hazard axis only):
//   status "Open"                                              -> green
//   status "Closed" AND reason mentions a HAZARD keyword        -> red
//     (beach hazard statement, rip current(s), high waves/surf,
//      dangerous surf/conditions, high surf)
//   status "Closed" AND reason mentions a WATER-QUALITY keyword -> null
//     (e.coli, bacteria, water quality, advisory — that signal belongs to
//      the separate src/wqFloor raise-only mechanism, NOT this registry)
//   status "Closed" for any other/unrecognized reason           -> null
//     (season, maintenance, staffing, or anything we cannot confirm)
//   unrecognized/missing status, or markup we cannot parse      -> null
//
// KNOWN AMBIGUITY: the generic "advisory" water-quality keyword can collide
// with a hazard product NAME that happens to include the word "advisory"
// (e.g. an NWS "High Surf Advisory" quoted verbatim in the closure reason).
// Per the never-a-wrong-color rule the water-quality check runs FIRST, so
// such a reason degrades to null (no site) rather than red. That is the
// safe-fail direction (a missed red beats a red asserted from an
// unconfirmed reading), but it does mean a hazard closure phrased with the
// word "advisory" will be under-reported here rather than surfaced. If this
// proves to matter in practice, narrow WATER_QUALITY_KEYWORDS's "advisory"
// entry to a tighter phrase (e.g. "water quality advisory").
//
// INTEGRATOR DEDUP NOTE: this is a single fixed site (Tower Road Beach only,
// osm/park-district scale — not a statewide table), so matches() is a tight
// name-substring-within-bbox gate; register it ahead of any broad regional
// scraper whose bbox might otherwise also cover this beach. This source is
// independent of wave/rip/alert signal already gathered elsewhere (SRF, NWS,
// Open-Meteo/GLOS) — it is a distinct posted-closure override, not a fallback
// for any of them, and must never be duplicated as a wqFloor source (a
// water-quality closure here already returns null so it cannot masquerade as
// a hazard override).
//
// scrape() runs cron-side only; parseTowerBeachStatus is pure and exported
// for tests. Contract v2 (perBeach / sites[] with "color", not "floorColor").

import { fetchText, perBeachResult } from "./util.js";

export const TOWER_BEACH_URL =
  "https://rainoutline.com/search/extension/8475633131/9";
export const TOWER_BEACH_LABEL = "Winnetka Park District";

export const TOWER_BEACH_SITE_ID = "tower-road-beach";
const TOWER_BEACH_NAMES = ["tower road"];
const TOWER_BEACH_LAT = 42.115585;
const TOWER_BEACH_LON = -87.733837;

// Tight bbox around the single site so this scraper never accidentally
// claims an unrelated beach elsewhere on the North Shore.
const BBOX_MIN_LAT = 42.10;
const BBOX_MAX_LAT = 42.13;
const BBOX_MIN_LON = -87.75;
const BBOX_MAX_LON = -87.72;

const HAZARD_KEYWORDS = [
  "beach hazard statement",
  "rip current",
  "rip currents",
  "high waves",
  "high surf",
  "dangerous surf",
  "dangerous conditions"
];

const WATER_QUALITY_KEYWORDS = [
  "e.coli",
  "e. coli",
  "bacteria",
  "water quality",
  "advisory"
];

// Pure. True if any needle (already lowercase) is a substring of haystack.
function containsAny(haystack, needles) {
  for (let i = 0; i < needles.length; i++) {
    if (haystack.indexOf(needles[i]) !== -1) {
      return true;
    }
  }
  return false;
}

// Pure. Best-effort conversion of "7/21/26 4:43 pm" (America/Chicago local,
// no explicit offset on the page) into an ISO timestamp. Never throws;
// returns null on any parse failure so the caller can fall back to nowIso.
// The offset is derived from nowIso's OWN America/Chicago offset (CDT/CST)
// rather than a fixed constant, so this stays DST-correct without needing a
// timezone database — reasonable because "Last updated" is always close in
// time to the cron's nowIso.
export function parseTowerBeachUpdated(text, nowIso) {
  if (typeof text !== "string" || typeof nowIso !== "string") {
    return null;
  }
  const match = text.match(
    /Last updated at\s+(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i
  );
  if (!match) {
    return null;
  }
  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  const year = 2000 + parseInt(match[3], 10);
  let hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const meridiem = match[6].toLowerCase();
  if (hour < 1 || hour > 12) {
    return null;
  }
  if (meridiem === "pm" && hour !== 12) {
    hour = hour + 12;
  } else if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  const clockRef = new Date(nowIso);
  if (isNaN(clockRef.getTime())) {
    return null;
  }
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    timeZoneName: "short"
  }).formatToParts(clockRef);
  let tzAbbrev = null;
  for (let i = 0; i < tzParts.length; i++) {
    if (tzParts[i].type === "timeZoneName") {
      tzAbbrev = tzParts[i].value;
    }
  }
  const offset = tzAbbrev === "CST" ? "-06:00" : "-05:00";

  const pad2 = function (n) {
    return n < 10 ? "0" + n : String(n);
  };
  const isoLocal =
    year + "-" + pad2(month) + "-" + pad2(day) + "T" +
    pad2(hour) + ":" + pad2(minute) + ":00" + offset;
  const parsed = new Date(isoLocal);
  if (isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

// Pure. Raw page text (any encoding of markup, defensively regex-matched) +
// nowIso -> a single site object ({siteId, color, reason, names, lat, lon,
// updated}) or null. Never throws. A markup change, unrecognized status word,
// or unrecognized closure reason all degrade to null (never a wrong color).
export function parseTowerBeachStatus(text, nowIso) {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }

  const statusMatch = text.match(
    /<span[^>]*class=["']status2["'][^>]*>\s*(Open|Closed)\s*<\/span>\s*&nbsp;-&nbsp;\s*([^<]*)/i
  );
  if (!statusMatch) {
    return null;
  }

  const status = statusMatch[1].toLowerCase();
  const reasonRaw = statusMatch[2].replace(/\s+/g, " ").trim();
  const reasonLower = reasonRaw.toLowerCase();

  const updated = parseTowerBeachUpdated(text, nowIso) || nowIso;

  if (status === "open") {
    return {
      siteId: TOWER_BEACH_SITE_ID,
      color: "green",
      reason: "Official status reported by " + TOWER_BEACH_LABEL + ": Open",
      names: TOWER_BEACH_NAMES,
      lat: TOWER_BEACH_LAT,
      lon: TOWER_BEACH_LON,
      updated: updated
    };
  }

  if (status !== "closed") {
    // Unrecognized status word — never guess.
    console.log("winnetkaTowerBeach: unrecognized status word, omitting site");
    return null;
  }

  // Closed. Water-quality closures are a different axis (handled by the
  // raise-only wqFloor mechanism elsewhere, never here) — do not report a
  // hazard color for them.
  if (containsAny(reasonLower, WATER_QUALITY_KEYWORDS)) {
    console.log("winnetkaTowerBeach: closure reason is water-quality, not hazard; omitting");
    return null;
  }

  if (containsAny(reasonLower, HAZARD_KEYWORDS)) {
    return {
      siteId: TOWER_BEACH_SITE_ID,
      color: "red",
      reason: "Official status reported by " + TOWER_BEACH_LABEL +
        ": Closed - " + reasonRaw,
      names: TOWER_BEACH_NAMES,
      lat: TOWER_BEACH_LAT,
      lon: TOWER_BEACH_LON,
      updated: updated
    };
  }

  // Closed for an unrecognized/non-hazard reason (season, maintenance,
  // staffing, or anything we cannot confirm as a hazard) — no data, not red.
  console.log("winnetkaTowerBeach: closure reason not recognized as hazard, omitting site");
  return null;
}

function inTowerBeachBbox(beach) {
  return typeof beach.lat === "number" && typeof beach.lon === "number" &&
    beach.lat >= BBOX_MIN_LAT && beach.lat <= BBOX_MAX_LAT &&
    beach.lon >= BBOX_MIN_LON && beach.lon <= BBOX_MAX_LON;
}

export const winnetkaTowerBeach = {
  id: "winnetka-tower-beach",
  label: TOWER_BEACH_LABEL,
  url: TOWER_BEACH_URL,
  matches: function (beach) {
    const haystack = ((beach.park_name || "") + " " + (beach.name || "")).toLowerCase();
    if (haystack.indexOf("tower road") !== -1) {
      return true;
    }
    return inTowerBeachBbox(beach);
  },
  scrape: async function (nowIso) {
    // NOTE: URL/shape confirmed live via curl on 2026-07-22 — the response
    // is plain server-rendered HTML with no auth/bot wall observed. If this
    // ever starts requiring auth or renders differently, fetchText's
    // ok-check / parseTowerBeachStatus's regex both fail closed to null.
    const text = await fetchText(TOWER_BEACH_URL, {
      logPrefix: "winnetkaTowerBeach: fetch failed"
    });
    if (text === null) {
      return null;
    }
    try {
      const site = parseTowerBeachStatus(text, nowIso);
      if (site === null) {
        // This is a single-beach source, so — like South Haven/Chicago — a
        // null site (page fetched fine but nothing color-worthy: a genuine
        // markup change, an unrecognized status word, or a Closed reason
        // that is non-hazard/water-quality) collapses to a scrape() null.
        // "No data" always beats a guess; see the module header comment for
        // the exact color/omit mapping.
        return null;
      }
      return perBeachResult([site], TOWER_BEACH_URL, nowIso);
    } catch (err) {
      console.log("winnetkaTowerBeach: parse failed: " + err.message);
      return null;
    }
  }
};
