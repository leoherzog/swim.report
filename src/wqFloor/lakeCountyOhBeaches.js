// src/wqFloor/lakeCountyOhBeaches.js — a raise-only water-quality floor source;
// see src/wqFloor/index.js for the floor contract.
//
// Source: Lake County General Health District (Ohio) Beach Water Quality
// Program, https://www.lcghd.org/beaches/ — a single server-rendered page
// carrying a daily bacteria-quality PREDICTION for Lake County's two Lake
// Erie public beaches:
//   - Headlands Beach State Park (Mentor-on-the-Lake, OH)
//   - Fairport Harbor Lakefront Park (Fairport Harbor, OH)
// The page is published daily during the swim season (Memorial Day through
// Labor Day) and reads, per beach, something like
//   "Headlands Beach State Park - Water Bacteria Quality Prediction: GOOD"
//   "Fairport Harbor Lakefront Park - Water Bacteria Quality Prediction: POOR"
//
// FLOOR MAPPING (raise-only, per spec):
//   - "Poor" / "Advisory" / "Unsafe" / "Closed" prediction -> floorColor
//     "yellow" (never red or double-red for a water-quality-only signal).
//   - "Good" / "Safe" / "Open" prediction, OR the beach's status simply
//     cannot be located on the page                -> NO site (never a
//     green -- absence of an advisory IS the "no floor" state).
//   - Anything ambiguous or unrecognized in a beach's status word yields no
//     site for that beach. If neither beach's own prediction line is on the
//     page, the whole parse fails to null (unusable body), never a guessed
//     color.
//
// SEASON: the program only publishes results Memorial Day through Labor Day.
// scrape() checks the passed-in nowIso against isInLakeCountyBeachSeason and,
// off-season, returns a CLEAN EMPTY perBeach result (a deliberate schedule
// skip, not a failure) rather than fetching a page that has nothing current
// to report -- mirrors the "empty perBeachResult on a clean/nothing run"
// convention (see src/officialSources/metroparks.js) so the source still
// counts as healthy when it has nothing to say.
//
// Each beach's prediction is a WordPress paragraph of the form
// <p><mark>Name – Water Bacteria Quality Prediction: </mark><strong><mark>WORD</mark></strong></p>,
// with an en dash separator. Off-season the value is the &#8212; placeholder,
// which yields no site. The beach names also appear in the head metadata and
// the intro, so the match is anchored on the full per-beach line.
//
// DEDUP: this is a New axis (Lake County, OH bacteria prediction), disjoint
// from the SRF rip lane, NWS/ECCC alert lane, and the NOAA wave lane.
// No overlap with any other registered source for these two beaches.
//
// scrape() runs CRON-SIDE only (one fetch per run). extractStatusForBeach,
// floorColorForStatus, parseLakeCountyOhBeaches, and isInLakeCountyBeachSeason
// are pure and exported for unit tests (no network).

import { fetchText, perBeachResult } from "../officialSources/util.js";

export const LAKE_COUNTY_BEACHES_URL = "https://www.lcghd.org/beaches/";
export const LAKE_COUNTY_LABEL = "Lake County General Health District Beach Water Quality Program";

// The two Lake County, Ohio Lake Erie public beaches this source curates.
// names[] feed resolveSiteForBeach (substring match against park_name +
// name); lat/lon are the proximity fallback. Kept tight and distinctive so
// one beach's prediction can never be attributed to the other.
const SITE_DEFS = [
  {
    siteId: "headlands-beach-state-park",
    names: ["headlands beach state park", "headlands beach"],
    lat: 41.7595,
    lon: -81.2843,
    radiusMi: 1.5
  },
  {
    siteId: "fairport-harbor-lakefront-park",
    names: ["fairport harbor lakefront park", "fairport harbor beach", "fairport harbor"],
    lat: 41.7648,
    lon: -81.2734,
    radiusMi: 1.5
  }
];

// Words that indicate an active water-quality concern -> yellow floor. Kept
// as an explicit whitelist (never a generic "not good" fallback) so an
// unrecognized word degrades to no-site, not a guessed color.
const POOR_PATTERNS = [/\bpoor\b/, /\badvisory\b/, /\bunsafe\b/, /\bclosed\b/];

// Words that indicate a clean reading -> no site (absence of a floor).
const GOOD_PATTERNS = [/\bgood\b/, /\bsafe\b/, /\bopen\b/];

// Pure. HTML -> visible text. Script, style and head blocks are dropped so
// metadata mentions of the beach names never reach the matcher, and block
// boundaries become " | " so a value regex cannot run into the next paragraph.
function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head(?:\s[^>]*)?>[\s\S]*?<\/head>/gi, " ")
    .replace(/<\/(?:p|div|li|h[1-6]|td|tr)>/gi, " | ")
    .replace(/<br\s*\/?>/gi, " | ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#8211;|&ndash;/g, "\u2013")
    .replace(/&#8212;|&mdash;/g, "\u2014")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Pure. The regex for one beach's own prediction line, anchored on its full
// name (names[0]); group 1 is the lowercase status word when one is present.
function predictionLineRe(def) {
  const escaped = def.names[0].toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped +
    "\\s*[-\\u2013\\u2014:]\\s*(?:water\\s+)?bacteria\\s+quality\\s+prediction\\s*:?\\s*(?:([a-z]+)\\b)?");
}

// Pure, exported for tests. One beach's prediction word in the page's visible
// text, lowercase, or null. The beach's own full name must immediately precede
// its own prediction phrase, so one beach's word can never be credited to the other.
export function extractStatusForBeach(text, beachDef) {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  if (!beachDef || !Array.isArray(beachDef.names) || beachDef.names.length === 0) {
    return null;
  }
  const match = predictionLineRe(beachDef).exec(text.toLowerCase());
  if (match !== null && typeof match[1] === "string" && match[1].length > 0) {
    return match[1];
  }
  return null;
}

// Pure, exported for tests. Raw status word -> floor color, or null when the
// word is unrecognized (fail closed) or affirmatively clean (no floor).
export function floorColorForStatus(word) {
  if (typeof word !== "string" || word.length === 0) {
    return null;
  }
  const lower = word.toLowerCase();
  for (let i = 0; i < POOR_PATTERNS.length; i++) {
    if (POOR_PATTERNS[i].test(lower)) {
      return "yellow";
    }
  }
  for (let i = 0; i < GOOD_PATTERNS.length; i++) {
    if (GOOD_PATTERNS[i].test(lower)) {
      return null;
    }
  }
  // Unrecognized word (markup/vocabulary drift) -- fail closed, no floor.
  console.log("lakeCountyOhBeaches: unrecognized prediction word '" + lower + "', omitting");
  return null;
}

// Pure, exported for tests. Full page HTML (+ the cron's ISO timestamp) ->
// an array of Site objects, or null when neither beach's prediction line is
// recognized. A page whose lines read "good" or the placeholder is a clean
// result: [] (not null).
export function parseLakeCountyOhBeaches(html, nowIso) {
  if (typeof html !== "string" || html.length === 0) {
    return null;
  }
  const text = stripTags(html);
  const lower = text.toLowerCase();
  let recognizedAny = false;
  const sites = [];
  for (let i = 0; i < SITE_DEFS.length; i++) {
    const def = SITE_DEFS[i];
    if (!predictionLineRe(def).test(lower)) {
      continue;
    }
    recognizedAny = true;
    const word = extractStatusForBeach(text, def);
    if (word === null) {
      continue;
    }
    const floorColor = floorColorForStatus(word);
    if (floorColor === null) {
      continue;
    }
    sites.push({
      siteId: def.siteId,
      floorColor: floorColor,
      reason: "Lake County GHD bacteria prediction: " + word.toUpperCase(),
      names: def.names,
      lat: def.lat,
      lon: def.lon,
      radiusMi: def.radiusMi,
      updated: nowIso
    });
  }
  if (!recognizedAny) {
    // Neither beach's prediction line is on the page: a redesign or wrong
    // page, reported as a source failure rather than a clean empty run.
    return null;
  }
  return sites;
}

// Pure. Last Monday of May in the given UTC year (Memorial Day, US).
function lastMondayOfMayUtc(year) {
  for (let day = 31; day >= 25; day--) {
    const d = new Date(Date.UTC(year, 4, day));
    if (d.getUTCDay() === 1) {
      return d;
    }
  }
  // Unreachable for a real calendar, but never throw.
  return new Date(Date.UTC(year, 4, 25));
}

// Pure. First Monday of September in the given UTC year (Labor Day, US).
function firstMondayOfSeptemberUtc(year) {
  for (let day = 1; day <= 7; day++) {
    const d = new Date(Date.UTC(year, 8, day));
    if (d.getUTCDay() === 1) {
      return d;
    }
  }
  return new Date(Date.UTC(year, 8, 1));
}

// Pure, exported for tests. Interprets the GIVEN nowIso (never an ambient
// clock, per project rule) against the Memorial Day..Labor Day publishing
// window this program runs on. Returns false (and thus "do not expect fresh
// data") outside that window, and also for an unparseable nowIso (fails
// closed toward "not in season" -- the caller then skips the fetch and
// reports a clean empty run rather than guessing at stale data).
export function isInLakeCountyBeachSeason(nowIso) {
  if (typeof nowIso !== "string" || nowIso.length === 0) {
    return false;
  }
  const now = new Date(nowIso);
  if (isNaN(now.getTime())) {
    return false;
  }
  const year = now.getUTCFullYear();
  const start = lastMondayOfMayUtc(year);
  const end = firstMondayOfSeptemberUtc(year);
  // Inclusive of the entire Labor Day calendar date, not just its midnight
  // instant -- add just under one day so a same-day timestamp still counts.
  const endOfLaborDay = end.getTime() + (24 * 60 * 60 * 1000 - 1);
  return now.getTime() >= start.getTime() && now.getTime() <= endOfLaborDay;
}

function inLakeCountyOhBox(beach) {
  if (typeof beach.lat !== "number" || typeof beach.lon !== "number") {
    return false;
  }
  return beach.lat >= 41.72 && beach.lat <= 41.80 &&
    beach.lon >= -81.32 && beach.lon <= -81.24;
}

export const lakeCountyOhBeaches = {
  id: "lake-county-oh-beaches",
  label: LAKE_COUNTY_LABEL,
  infoUrl: LAKE_COUNTY_BEACHES_URL,
  matches: function(beach) {
    if (!beach) {
      return false;
    }
    if (/headlands beach/i.test(beach.name || "") || /headlands beach/i.test(beach.park_name || "")) {
      return true;
    }
    if (/fairport harbor/i.test(beach.name || "") || /fairport harbor/i.test(beach.park_name || "")) {
      return true;
    }
    return inLakeCountyOhBox(beach);
  },
  // CRON-SIDE only. Off-season: returns a clean EMPTY perBeach result (a
  // deliberate schedule skip, never a failure). In-season: fetches the page
  // once and emits sites only for beaches with an affirmatively-recognized
  // "poor"-class prediction. Returns null only when the fetch itself failed
  // or the page could not be positively recognized as the Lake County beach
  // report at all.
  scrape: async function(nowIso) {
    if (!isInLakeCountyBeachSeason(nowIso)) {
      return perBeachResult([], LAKE_COUNTY_LABEL, nowIso);
    }
    const html = await fetchText(LAKE_COUNTY_BEACHES_URL, {
      logPrefix: "lakeCountyOhBeaches: fetch failed"
    });
    if (html === null) {
      return null;
    }
    try {
      const sites = parseLakeCountyOhBeaches(html, nowIso);
      if (sites === null) {
        return null;
      }
      return perBeachResult(sites, LAKE_COUNTY_LABEL, nowIso);
    } catch (err) {
      console.log("lakeCountyOhBeaches: parse failed: " + err.message);
      return null;
    }
  }
};
