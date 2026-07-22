// src/wqFloor/lakeCountyOhBeaches.js
//
// KIND: wq (src/wqFloor raise-only water-quality floor source). Feeds
// rules.js estimateFlag's "waterQualityAdvisory" input (step 7): it may only
// RAISE a flag UP (worst-of by SEVERITY_RANK) — never pull a hazard estimate
// down, and it is NOT an official override (official:false). A clean/absent
// reading is the ABSENCE of a site (resolves to null -> zero effect).
//
// SOURCE: Lake County General Health District (Ohio) Beach Water Quality
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
// FLOOR MAPPING (RAISE-ONLY, per spec):
//   - "Poor" / "Advisory" / "Unsafe" / "Closed" prediction -> floorColor
//     "yellow" (never red or double-red for a water-quality-only signal).
//   - "Good" / "Safe" / "Open" prediction, OR the beach's status simply
//     cannot be located on the page                -> NO site (never a
//     green -- absence of an advisory IS the "no floor" state).
//   - Anything ambiguous/unrecognized for a given beach's status word
//     (a schema/markup change) -> NO site for that beach; if the page as a
//     whole carries none of the two beaches' names at all, the WHOLE parse
//     fails to null (unusable body), never a guessed color. "No data" always
//     beats a guess.
//
// SEASON: the program only publishes results Memorial Day through Labor Day.
// scrape() checks the passed-in nowIso against isInLakeCountyBeachSeason and,
// off-season, returns a CLEAN EMPTY perBeach result (a deliberate schedule
// skip, not a failure) rather than fetching a page that has nothing current
// to report -- mirrors the "empty perBeachResult on a clean/nothing run"
// convention (see src/officialSources/metroparks.js) so the source still
// counts as healthy when it has nothing to say.
//
// *** LIVE-MARKUP CONFIRMATION NEEDED ***
// A live fetch of https://www.lcghd.org/beaches/ during this build was
// blocked by the site's Mod_Security WAF ("Not Acceptable!", HTTP request
// rejected before any markup was served) -- the exact surrounding HTML
// structure (tag/class/id around each beach's prediction line) could not be
// confirmed. The wording "Water Bacteria Quality Prediction: GOOD/POOR" is
// per the task spec. The parser below therefore works on VISIBLE TEXT
// (tag-stripped), not brittle selectors, and is written to fail closed to
// null/no-site on anything it cannot positively recognize. Before this
// source is registered live, an integrator should re-confirm the exact
// wording (GOOD/POOR vs. some other vocabulary) and, if the WAF still blocks
// automated fetches, obtain a permitted access path (documented API, feed,
// or a pre-cleared User-Agent) before wiring scrape() into production.
//
// DEDUP: this is a NEW axis (Lake County, OH bacteria prediction), disjoint
// from the SRF rip lane, NWS/ECCC alert lane, and Open-Meteo/GLOS wave lane.
// No overlap with any other registered source for these two beaches.
//
// scrape() runs CRON-SIDE ONLY (one fetch per run). extractStatusForBeach,
// floorColorForStatus, parseLakeCountyOhBeaches, and isInLakeCountyBeachSeason
// are pure and exported for unit tests (no network).

import { fetchText } from "../officialSources/util.js";

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

// Pure. Strip HTML tags to plain text and collapse whitespace, mirroring the
// other wqFloor parsers' tag-stripping approach (robust to markup/class
// churn since we key off visible words, not selectors).
function stripTags(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Pure, exported for tests. Locates ONE curated beach's prediction word in
// the page's VISIBLE TEXT. Scoped to a bounded window (600 chars) following
// the beach's own name occurrence, so an unrelated mention of "good"/"poor"
// elsewhere on the page (e.g. weather, water temperature commentary) cannot
// leak into a different beach's result. Returns the raw lowercase status
// word found ("good" | "poor" | "advisory" | "unsafe" | "closed" | "safe" |
// "open"), or null when this beach's name or its prediction word cannot be
// located at all.
export function extractStatusForBeach(text, beachDef) {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  const lower = text.toLowerCase();
  let nameIndex = -1;
  for (let i = 0; i < beachDef.names.length; i++) {
    const idx = lower.indexOf(beachDef.names[i]);
    if (idx !== -1 && (nameIndex === -1 || idx < nameIndex)) {
      nameIndex = idx;
    }
  }
  if (nameIndex === -1) {
    return null;
  }
  const windowEnd = Math.min(lower.length, nameIndex + 600);
  const window = lower.slice(nameIndex, windowEnd);
  // Require the documented "prediction" phrasing to anchor the match so a
  // stray word elsewhere in the window (e.g. "the water looks good today" in
  // unrelated copy) cannot masquerade as the actual prediction.
  const predictionRe = /(?:water\s+)?bacteria\s+quality\s+prediction[\s:-]*([a-z]+)/;
  const match = predictionRe.exec(window);
  if (match !== null && match[1].length > 0) {
    return match[1];
  }
  // Fallback: no anchored "prediction" phrase found near the name at all --
  // do not guess from loose keyword presence. Fail closed to null.
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
// an array of Site objects (possibly empty on an all-clean page), or null
// when the page cannot be positively recognized as a Lake County beach
// report AT ALL (neither curated beach name appears anywhere in the text --
// an unusable/redesigned page). A page that names the beaches but reports
// "good" for both is a legitimate CLEAN result: [] (not null).
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
    let nameFound = false;
    for (let j = 0; j < def.names.length; j++) {
      if (lower.indexOf(def.names[j]) !== -1) {
        nameFound = true;
        break;
      }
    }
    if (!nameFound) {
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
    // Neither curated beach name appears anywhere in the page -- the page is
    // not the Lake County beach report we expect (redesign/outage/wrong
    // page). Unusable body: fail to null, not an empty clean result.
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
  // CRON-SIDE ONLY. Off-season: returns a clean EMPTY perBeach result (a
  // deliberate schedule skip, never a failure). In-season: fetches the page
  // once and emits sites ONLY for beaches with an affirmatively-recognized
  // "poor"-class prediction. Returns null only when the fetch itself failed
  // or the page could not be positively recognized as the Lake County beach
  // report at all.
  scrape: async function(nowIso) {
    if (!isInLakeCountyBeachSeason(nowIso)) {
      return {
        perBeach: true,
        sites: [],
        source: LAKE_COUNTY_LABEL,
        sources: [LAKE_COUNTY_LABEL],
        updated: nowIso
      };
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
      return {
        perBeach: true,
        sites: sites,
        source: LAKE_COUNTY_LABEL,
        sources: [LAKE_COUNTY_LABEL],
        updated: nowIso
      };
    } catch (err) {
      console.log("lakeCountyOhBeaches: parse failed: " + err.message);
      return null;
    }
  }
};
