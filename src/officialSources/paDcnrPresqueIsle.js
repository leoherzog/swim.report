// src/officialSources/paDcnrPresqueIsle.js
// Official HAZARD scraper for the PA DCNR Park Advisory feed, scoped to
// Presque Isle State Park (Lake Erie, PA). This is a CLOSURE-ONLY source: an
// active "Danger"-tier advisory whose free text describes a genuine SWIMMING
// hazard (beach closed, swimming prohibited, dangerous conditions, rip
// current, high water/high surf, hazardous swimming) maps to a park-wide RED.
// Anything else degrades to no-data:
//   - IsAlert:false                                  -> ignored (not a Danger tier)
//   - Water-quality / E. coli / bacteria / algae     -> null (that is the
//       raise-only wqFloor axis, NOT a hazard override — a clean surf estimate
//       must never be overridden by a bacteria closure; see the dedup note)
//   - road / facility / trail / event / boilerplate  -> null (off the surf axis)
// This source NEVER emits green: the absence of a hazard advisory is the
// absence of a site (no KV write), so it can only ever RAISE a beach to red,
// never lower an estimate.
//
// COLOR MAPPING (provisional — fail closed):
//   swimming-hazard closure keyword in an IsAlert:true Message -> red
//   everything else                                            -> no site
// NOTE: as of this writing the live payload is 100% off-axis boilerplate
// (Spotted Lanternfly / firewood / drone advisories, all IsAlert:false), so
// the hazard keyword mapping is verified ONLY against the SYNTHETIC fixtures in
// test/paDcnrPresqueIsle.test.js. Treat the mapping as provisional; every
// unrecognized shape/word degrades to null, never a wrong color.
//
// INTEGRATOR DEDUP NOTE: Presque Isle water-quality Danger advisories are
// deliberately routed to null here — they belong to the raise-only water-
// quality floor (src/wqFloor), not to this hazard-override registry. Do not
// also register a Presque Isle water-quality source in the scrapers[] array.
//
// scrape() runs cron-side only. parsePresqueIsleAdvisories, classifyAdvisoryMessage,
// and htmlToText are pure and exported for tests.
//
// FETCH URL: confirmed live and openly readable at the documented endpoint
// below; the JSON shape (array of { IsAlert, Message }) is confirmed. Whether
// Workers' fetch needs a User-Agent for this .gov host has NOT been probed, so
// no header is sent (a 403 would degrade to null — the safe direction). If it
// is later found to 403, add a probed User-Agent to the fetchText call.

import { fetchText, perBeachResult } from "./util.js";

// Presque Isle State Park id in the DCNR ParkAdvisory API.
export const PRESQUE_ISLE_URL =
  "https://services.dcnr.pa.gov/ParkAddresses/api/ParkAdvisory/get?id=6220";

export const PRESQUE_ISLE_LABEL =
  "PA DCNR Park Advisory (Presque Isle State Park)";

// Peninsula centroid + a radius generous enough to span the full Presque Isle
// shoreline (the park is ~7 mi of beaches on a curving spit), so any matched
// Presque Isle beach resolves to the single park-wide site by proximity even
// when its own name is a bare "Beach 6" that carries no "presque isle" token.
const PRESQUE_ISLE_LAT = 42.155;
const PRESQUE_ISLE_LON = -80.11;
const PRESQUE_ISLE_RADIUS_MI = 6;

// The single park-wide site this closure-only source reports. names[] lets a
// row whose park_name/name carries "presque isle" resolve by substring; lat/lon
// + radiusMi cover the rest by proximity.
const PRESQUE_ISLE_SITE_ID = "presque-isle-state-park";
const PRESQUE_ISLE_SITE_NAMES = ["presque isle"];

// Water-quality / bacteria / algae phrasing. Checked FIRST: a "beach closed"
// message that is actually a bacteria/E. coli closure must NOT become a hazard
// red here — water quality is the raise-only floor axis, so it degrades to
// no-data on this hazard-override path.
const WATER_QUALITY_KEYWORDS = [
  "e. coli",
  "e.coli",
  "escherichia",
  "bacteria",
  "bacterial",
  "water quality",
  "water-quality",
  "algae",
  "algal",
  "cyanobacteria",
  "harmful algal bloom",
  "hab advisory"
];

// Genuine swimming-hazard closure phrasing -> red. Kept tight and explicit; a
// message that matches none of these is omitted, never guessed.
const HAZARD_KEYWORDS = [
  "beach closed",
  "beaches closed",
  "beach is closed",
  "swimming prohibited",
  "swimming is prohibited",
  "swimming closed",
  "swimming is closed",
  "no swimming",
  "swimming ban",
  "closed to swimming",
  "closed for swimming",
  "dangerous condition",
  "dangerous conditions",
  "dangerous surf",
  "hazardous swimming",
  "hazardous condition",
  "hazardous conditions",
  "rip current",
  "rip currents",
  "high water",
  "high surf"
];

// Pure. Returns true if any needle in needles is a substring of hay.
function containsAny(hay, needles) {
  for (let i = 0; i < needles.length; i++) {
    if (hay.indexOf(needles[i]) !== -1) {
      return true;
    }
  }
  return false;
}

// Pure, exported for tests. Strips HTML tags and a few common entities from a
// Message, collapses whitespace, and trims. Preserves original case (for the
// reason string); classification lowercases separately. Non-string -> "".
export function htmlToText(html) {
  if (typeof html !== "string") {
    return "";
  }
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

// Pure, exported for tests. Classifies one advisory Message's free text.
// Returns:
//   "hazard"        — a genuine swimming-hazard closure (-> red)
//   "water-quality" — a bacteria/E. coli/algae closure (-> no data here; wqFloor axis)
//   "none"          — nothing recognized on the surf axis (-> no data)
// Water quality is tested BEFORE hazard so a bacteria "beach closed" message is
// never mis-mapped to a hazard red.
export function classifyAdvisoryMessage(message) {
  const text = htmlToText(message).toLowerCase();
  if (text.length === 0) {
    return "none";
  }
  if (containsAny(text, WATER_QUALITY_KEYWORDS)) {
    return "water-quality";
  }
  if (containsAny(text, HAZARD_KEYWORDS)) {
    return "hazard";
  }
  return "none";
}

// Pure, exported for tests. Raw JSON text -> sites[] | null.
//   - null ONLY on a total failure: unparseable JSON or a non-array payload
//     (schema change / bad body). That is the health-failure signal.
//   - [] when the feed parsed cleanly but no active Danger advisory describes a
//     swimming hazard (the all-clear case) — a SUCCESSFUL scrape with nothing
//     to report, so scrape() wraps it in an empty perBeachResult (health success),
//     mirroring the metroparks closure-only pattern.
//   - one park-wide red site when an IsAlert:true Message names a swimming hazard.
// Only IsAlert === true objects are considered (the "Danger" tier). The first
// hazard message supplies the reason; a single red site covers the whole park.
export function parsePresqueIsleAdvisories(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    console.log("paDcnrPresqueIsle: JSON parse failed: " + err.message);
    return null;
  }
  if (!Array.isArray(data)) {
    console.log("paDcnrPresqueIsle: payload was not an array");
    return null;
  }
  let hazardDetail = null;
  for (let i = 0; i < data.length; i++) {
    const record = data[i];
    if (!record || record.IsAlert !== true) {
      continue;
    }
    if (typeof record.Message !== "string") {
      continue;
    }
    const tag = classifyAdvisoryMessage(record.Message);
    if (tag === "water-quality") {
      // Bacteria/E. coli/algae closure — belongs to the raise-only wqFloor
      // axis, never a hazard override. Omit here.
      console.log("paDcnrPresqueIsle: water-quality Danger advisory, routing to no-data (wqFloor axis)");
      continue;
    }
    if (tag === "hazard") {
      hazardDetail = htmlToText(record.Message);
      break;
    }
    // tag === "none": off the surf axis (road/facility/event/boilerplate). Omit.
  }
  if (hazardDetail === null) {
    // Clean run: no active swimming-hazard closure. Nothing to report.
    return [];
  }
  const detail = hazardDetail.length > 240
    ? hazardDetail.slice(0, 237) + "..."
    : hazardDetail;
  return [
    {
      siteId: PRESQUE_ISLE_SITE_ID,
      color: "red",
      reason: "PA DCNR park advisory for Presque Isle State Park: " + detail,
      names: PRESQUE_ISLE_SITE_NAMES,
      lat: PRESQUE_ISLE_LAT,
      lon: PRESQUE_ISLE_LON,
      radiusMi: PRESQUE_ISLE_RADIUS_MI
    }
  ];
}

// Presque Isle peninsula bounding box (Lake Erie, PA). Deliberately kept to the
// peninsula rather than the whole PA Lake Erie shore so this park-specific
// closure is not attributed to unrelated beaches.
function inPresqueIsleBox(beach) {
  return beach.lat >= 42.09 && beach.lat <= 42.20 &&
    beach.lon >= -80.22 && beach.lon <= -80.03;
}

export const paDcnrPresqueIsle = {
  id: "pa-dcnr-presque-isle",
  label: PRESQUE_ISLE_LABEL,
  url: PRESQUE_ISLE_URL,
  matches: function(beach) {
    const hasCoords = typeof beach.lat === "number" && typeof beach.lon === "number";
    // When the beach has coordinates, they decide: only rows inside the
    // Presque Isle bbox match. This excludes far-away namesakes — there are
    // OTHER "Presque Isle" beaches (e.g. Presque Isle on Lake Huron, MI) whose
    // name would otherwise resolve to THIS park's single "presque isle" site
    // and be painted with a false official red (the metroparks namesake trap).
    if (hasCoords) {
      return inPresqueIsleBox(beach);
    }
    // Only a coordinate-less row (never produced by OSM discovery) may match on
    // a bare name substring — a defensive path with no real namesake exposure.
    const name = (beach.name || "").toLowerCase();
    const park = (beach.park_name || "").toLowerCase();
    return name.indexOf("presque isle") !== -1 || park.indexOf("presque isle") !== -1;
  },
  scrape: async function(nowIso) {
    // No headers: this .gov host has not been probed to require a User-Agent,
    // and Workers' fetch sends none by default. A 403 degrades to null (safe).
    const text = await fetchText(PRESQUE_ISLE_URL, {
      logPrefix: "paDcnrPresqueIsle: fetch failed"
    });
    if (text === null) {
      return null;
    }
    try {
      const sites = parsePresqueIsleAdvisories(text);
      // null => real parse failure (surface as failure). [] => clean run with
      // no swimming-hazard closure — a SUCCESSFUL scrape with nothing to report,
      // wrapped in an empty perBeachResult so it counts as a health success
      // (resolves to no official flag for every beach, writes no KV).
      if (sites === null) {
        return null;
      }
      return perBeachResult(sites, PRESQUE_ISLE_URL, nowIso);
    } catch (err) {
      console.log("paDcnrPresqueIsle: parse failed: " + err.message);
      return null;
    }
  }
};
