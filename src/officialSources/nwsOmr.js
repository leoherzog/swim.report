// src/officialSources/nwsOmr.js — an official hazard scraper. It is admissible
// here because it reports posted lifeguard flag colors, the same hazard axis
// src/rules.js estimates, and an official color overrides the estimate everywhere
// it is shown.
//
// The product is a single morning observation, which makes it the canonical case
// for render.js displayFlagColor's raise-only rule: past the 2 h STALE_MS horizon
// a fresher, more severe estimate lifts the title flag and map marker above this
// color but never below it, and this card keeps reporting the scraped color
// verbatim. A morning table posting Yellow can be overtaken within hours by the
// same WFO's Beach Hazards Statement and Surf Zone Forecast.
//
// Source: NWS Grand Rapids (WFO GRR) "Other Marine Reports" product (AWIPS
// OMRGRR), which carries the fixed "Lake Michigan Beach Reports" table for the
// west-Michigan Lake Michigan state-park beaches. Fetched two-legged through
// the public api.weather.gov products API:
//   1. GET /products/types/OMR/locations/GRR -> @graph -> newest product id
//   2. GET /products/{id} -> productText (plain text inside JSON)
// every request sends the required NWS User-Agent (reused from src/clients/nws.js).
//
// COLOR MAPPING (the Flag Color column is a POSTED flag, 1:1):
//   Green  -> green
//   Yellow -> yellow
//   Red    -> red
//   None / M ft / anything unrecognized -> NO DATA (site omitted, never a color)
// There is no double-red tier in this product.
//
// updated = the product's issuanceTime (the observations are taken in the
// morning and "may not be representative of conditions later in the day", so
// the reading time — not the cron tick — drives the frontend stale warning).
//
// The curated sites are the named Lake Michigan state-park beaches in west
// Michigan, which overlap no other registered scraper. findScraper is
// first-match-wins, so keep matches() tight to these parks: name plus tight
// proximity.
//
// scrape() runs cron-side only; the parsers are pure.

import { fetchJson } from "../clients/http.js";
import { NWS_USER_AGENT } from "../clients/nws.js";
import { resolveSiteForBeach, perBeachResult } from "./util.js";

// Product-type list for the OMR product issued by WFO Grand Rapids (GRR).
export const OMR_LIST_URL =
  "https://api.weather.gov/products/types/OMR/locations/GRR";

// Canonical human-facing pointer for the beach-hazard program.
export const OMR_URL = "https://www.weather.gov/grr/";

export const OMR_LABEL = "NWS Grand Rapids Lake Michigan Beach Report";

// The distinctive header of the beach-report table. If it is absent the product
// is not the beach report (or the format changed) and we degrade to null.
const OMR_TABLE_HEADER = "Lake Michigan Beach Reports";

// Proximity fallback radius (statute miles) used by resolveSiteForBeach for
// both matches() (run over SITE_DEFS below) and per-beach resolution of a
// scrape result (run over the emitted sites), when a beach name does not
// substring-match a site.
const OMR_MATCH_RADIUS_MI = 2;

// The named beaches this product reports, in table order. names[] are lowercase
// substrings compared both against each OMR table row's Location text and, in
// resolveSiteForBeach, against a beach's (park_name + " " + name); keep them
// tight and distinctive so a row is never attributed to a namesake or sibling
// beach. lat/lon are approximate shore positions used only for the proximity
// fallback.
//
// radiusMi rides onto each emitted site so the resolution pass uses the same
// reach matches() claims with; otherwise a beach a mile or two from a centroid
// with no name match would be claimed here yet resolve to null. matches() is
// itself resolveSiteForBeach(beach, SITE_DEFS) !== null, so the claim reach and
// the resolve reach cannot drift apart as this table is edited. A claimed beach
// may still resolve to null when the day's product reports no flag for its site,
// which is correct: nothing to report is not the same as no coverage.
const SITE_DEFS = [
  {
    siteId: "ludington-state-park",
    label: "Ludington State Park",
    names: ["ludington state park"],
    lat: 43.9585,
    lon: -86.4790,
    radiusMi: OMR_MATCH_RADIUS_MI
  },
  {
    siteId: "mears-state-park",
    label: "Mears State Park (Pentwater)",
    names: ["mears state park", "charles mears"],
    lat: 43.7830,
    lon: -86.4430,
    radiusMi: OMR_MATCH_RADIUS_MI
  },
  {
    siteId: "muskegon-state-park",
    label: "Muskegon State Park",
    names: ["muskegon state park"],
    lat: 43.2378,
    lon: -86.3400,
    radiusMi: OMR_MATCH_RADIUS_MI
  },
  {
    siteId: "pj-hoffmaster-state-park",
    label: "P.J. Hoffmaster State Park",
    names: ["hoffmaster"],
    lat: 43.1290,
    lon: -86.2760,
    radiusMi: OMR_MATCH_RADIUS_MI
  },
  {
    siteId: "grand-haven-state-park",
    label: "Grand Haven State Park",
    names: ["grand haven state park"],
    lat: 43.0540,
    lon: -86.2490,
    radiusMi: OMR_MATCH_RADIUS_MI
  },
  {
    siteId: "holland-state-park",
    label: "Holland State Park",
    names: ["holland state park"],
    lat: 42.7739,
    lon: -86.2090,
    radiusMi: OMR_MATCH_RADIUS_MI
  },
  {
    siteId: "saugatuck-oval-beach",
    label: "Saugatuck Oval Beach",
    names: ["oval beach", "saugatuck oval"],
    lat: 42.6640,
    lon: -86.2170,
    radiusMi: OMR_MATCH_RADIUS_MI
  }
];

// One table row: "<Location>  <temp> F  <wave> ft  <Flag Color>". The water-temp
// and wave-height columns are required structural anchors, so only genuine data
// rows match; the header lines and prose sections lack that shape and are
// skipped. The Location group is non-greedy so it stops at the first temp column.
// The trailing flag word is a single alpha token, and "None" or an unknown token
// normalizes to null.
const OMR_ROW_RE =
  /^(.+?)\s+(?:\d+|M)\s*F\s+(?:\d+|M)\s*ft\s+([A-Za-z]+)\s*$/;

// Pure. Map a raw Flag Color word to a known posted-flag color, or null. Uses an
// explicit allowlist (never a prototype-chain membership test) so a stray value
// can never smuggle past the guard. "None", "M", and any unrecognized word map
// to null so the caller reports NO DATA for that beach rather than a guess.
export function normalizeOmrFlagColor(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const key = raw.trim().toLowerCase();
  if (key === "green") {
    return "green";
  }
  if (key === "yellow") {
    return "yellow";
  }
  if (key === "red") {
    return "red";
  }
  return null;
}

// Pure. Find the curated site whose any names[] substring appears in the (lower-
// cased) OMR row Location text; else null. First match in table order wins.
function siteDefForRowName(rawName) {
  const haystack = rawName.toLowerCase();
  for (let i = 0; i < SITE_DEFS.length; i++) {
    const def = SITE_DEFS[i];
    for (let j = 0; j < def.names.length; j++) {
      if (haystack.indexOf(def.names[j]) !== -1) {
        return def;
      }
    }
  }
  return null;
}

// Pure. productText -> sites[], [] when the table parsed but has nothing
// reportable, or null when the product is unusable: a missing table header, or a
// header present with not one matching data row, which means a format change.
//   - Rows are scoped to the region between the header and the
//     "Disclaimer" / "Flag Definitions" / "$$" trailer, so prose can never be
//     misread as a row.
//   - A row not matching OMR_ROW_RE is skipped.
//   - A row naming an unknown beach is skipped.
//   - A row whose flag color is None or unrecognized is omitted, never guessed.
//   - Duplicate rows for the same site keep the first; the guard is defensive.
export function parseOmrBeachReport(text, nowIso) {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  const headerIndex = text.indexOf(OMR_TABLE_HEADER);
  if (headerIndex === -1) {
    console.log("nwsOmr: product missing '" + OMR_TABLE_HEADER + "' header");
    return null;
  }
  const lines = text.split(/\r?\n/);
  const sites = [];
  const seen = {};
  // Structurally-parsed data rows (matched OMR_ROW_RE), regardless of whether
  // they mapped to a known site or carried a color. Zero => the table format is
  // gone; return null rather than presenting no-data as an all-clear result.
  let recognizedRows = 0;
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!inTable) {
      if (trimmed.indexOf(OMR_TABLE_HEADER) !== -1) {
        inTable = true;
      }
      continue;
    }
    if (trimmed.length === 0) {
      continue;
    }
    // Trailer sections end the table region.
    if (trimmed === "$$" ||
        trimmed.indexOf("Disclaimer") !== -1 ||
        trimmed.indexOf("Flag Definitions") !== -1 ||
        trimmed.indexOf("Safety Information") !== -1) {
      break;
    }
    const match = OMR_ROW_RE.exec(trimmed);
    if (!match) {
      // Header sub-rows ("Water Wave Flag" / "Location Temp Height Color") and
      // any non-data line fall here and are skipped.
      continue;
    }
    recognizedRows++;
    const rawName = match[1].trim();
    const def = siteDefForRowName(rawName);
    if (!def) {
      console.log("nwsOmr: unrecognized beach row, skipping: " + rawName);
      continue;
    }
    const color = normalizeOmrFlagColor(match[2]);
    if (color === null) {
      // "None"/"M"/unknown flag word => no posted flag for this beach.
      continue;
    }
    if (seen[def.siteId]) {
      continue;
    }
    seen[def.siteId] = true;
    sites.push({
      siteId: def.siteId,
      color: color,
      reason: "Official flag reported by " + OMR_LABEL + " for " + def.label,
      names: def.names,
      lat: def.lat,
      lon: def.lon,
      radiusMi: def.radiusMi
    });
  }
  if (recognizedRows === 0) {
    // The header was present but not one data row parsed: the table format
    // changed. Degrade to null rather than an all-clear empty result.
    console.log("nwsOmr: no parseable beach rows under the table header");
    return null;
  }
  return sites;
}

// Pure, exported for tests. The @graph list JSON -> newest product id string, or
// null. Picks the id with the greatest issuanceTime (ISO strings sort
// lexicographically); if no item carries an issuanceTime, falls back to the
// first item that has an id (the list is documented newest-first). Defensive
// against a missing/renamed @graph.
export function newestOmrProductId(json) {
  if (!json || typeof json !== "object") {
    return null;
  }
  const graph = json["@graph"];
  if (!Array.isArray(graph) || graph.length === 0) {
    return null;
  }
  let bestId = null;
  let bestTime = null;
  let firstId = null;
  for (let i = 0; i < graph.length; i++) {
    const item = graph[i];
    if (!item || typeof item !== "object") {
      continue;
    }
    if (typeof item.id !== "string" || item.id.length === 0) {
      continue;
    }
    if (firstId === null) {
      firstId = item.id;
    }
    const time = typeof item.issuanceTime === "string" ? item.issuanceTime : null;
    if (time === null) {
      continue;
    }
    if (bestTime === null || time > bestTime) {
      bestTime = time;
      bestId = item.id;
    }
  }
  return bestId !== null ? bestId : firstId;
}

function nwsHeaders() {
  return {
    "User-Agent": NWS_USER_AGENT,
    "Accept": "application/ld+json"
  };
}

export const nwsOmr = {
  id: "nws-omr-grr",
  label: OMR_LABEL,
  url: OMR_URL,
  // Staleness horizon for this source. The frontend's 2 h default is calibrated
  // to the hourly estimate recompute, but this product is issued once per day,
  // late morning local time (roughly 14:30-16:00 UTC), and the updated field is
  // its issuanceTime — so a flat 2 h horizon would mark the card stale for most
  // of every day even though the posted colors are current. 30 h covers the daily
  // cadence plus issuance jitter, so the stale warning fires only when NWS
  // genuinely skips an issuance, which is exactly when a reader should stop
  // trusting the colors.
  staleMs: 30 * 60 * 60 * 1000,
  // The reading is still point-in-time, and the product text itself warns the
  // observations "may not be representative of conditions later in the day", so
  // between the 2 h default and the 30 h horizon that is said plainly. Rendered
  // as a neutral callout with the age appended.
  readingNote: "Morning reading — conditions may have changed since it was posted",
  // Does this beach belong to one of the curated OMR sites? The shared resolver
  // over SITE_DEFS: any site's names[] substring-matching the beach's
  // (park_name + " " + name), or the nearest site within its radiusMi. Kept tight
  // so a namesake beach elsewhere never resolves onto a west-Michigan state-park
  // flag.
  matches: function(beach) {
    return resolveSiteForBeach(beach, SITE_DEFS) !== null;
  },
  scrape: async function(nowIso) {
    // Leg 1: list the OMR products for GRR and pick the newest id.
    const listJson = await fetchJson(OMR_LIST_URL, {
      headers: nwsHeaders(),
      label: "nwsOmr: OMR product list"
    });
    if (listJson === null) {
      return null;
    }
    const productId = newestOmrProductId(listJson);
    if (productId === null) {
      console.log("nwsOmr: no product id in OMR list");
      return null;
    }
    // Leg 2: fetch that product's text.
    const productUrl = "https://api.weather.gov/products/" + productId;
    const productJson = await fetchJson(productUrl, {
      headers: nwsHeaders(),
      label: "nwsOmr: OMR product"
    });
    if (productJson === null) {
      return null;
    }
    const text = productJson.productText;
    if (typeof text !== "string" || text.length === 0) {
      console.log("nwsOmr: product missing productText");
      return null;
    }
    const updated = typeof productJson.issuanceTime === "string" &&
      productJson.issuanceTime.length > 0
      ? productJson.issuanceTime
      : nowIso;
    try {
      const sites = parseOmrBeachReport(text, nowIso);
      if (sites === null) {
        // Genuine parse failure (missing header / format change).
        return null;
      }
      // A clean run with no reportable flags (every beach None / off-season) is
      // a SUCCESSFUL scrape with an empty site list — a health success, not a
      // null failure. It resolves to no official flag for every beach.
      return perBeachResult(sites, OMR_URL, updated);
    } catch (err) {
      console.log("nwsOmr: parse failed: " + err.message);
      return null;
    }
  }
};
