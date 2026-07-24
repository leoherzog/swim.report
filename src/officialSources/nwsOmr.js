// src/officialSources/nwsOmr.js
//
// KIND: official HAZARD scraper (contract v2, per-beach resolution). An
// official color OVERRIDES the estimate everywhere it is shown
// (render.js markerFlagColor / titleColor). This source is admissible here
// because it reports POSTED LIFEGUARD FLAG COLORS — the gold-standard hazard
// axis, exactly what src/rules.js estimates.
//
// SOURCE: NWS Grand Rapids (WFO GRR) "Other Marine Reports" product (AWIPS
// OMRGRR), which carries the fixed "Lake Michigan Beach Reports" table for the
// west-Michigan Lake Michigan state-park beaches. Fetched two-legged through
// the public api.weather.gov products API:
//   1. GET /products/types/OMR/locations/GRR -> @graph -> newest product id
//   2. GET /products/{id} -> productText (plain text inside JSON)
// Every request sends the required NWS User-Agent (reused from src/clients/nws.js).
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
// INTEGRATOR DEDUP NOTE: these are ~7 named Lake Michigan state-park beaches in
// west Michigan (Ludington, Mears/Pentwater, Muskegon, P.J. Hoffmaster, Grand
// Haven, Holland, Saugatuck Oval). They do NOT overlap the existing scrapers
// (South Haven is south of Saugatuck; Huron-Clinton Metroparks is SE Michigan;
// Chicago is Illinois), so registration order versus those is not a conflict —
// but findScraper is first-match-wins, so keep matches() tight to these parks
// (name + tight proximity). This is a HAZARD posted-flag source, so it belongs
// in the officialSources "scrapers" registry (NOT the wqFloor floor registry).
//
// scrape() runs cron-side only; parseOmrBeachReport, normalizeOmrFlagColor,
// and newestOmrProductId are pure and exported for tests.

import { fetchJson } from "../clients/http.js";
import { NWS_USER_AGENT } from "../clients/nws.js";
import { distanceMi } from "../geo.js";

// Product-type list for the OMR product issued by WFO Grand Rapids (GRR).
export const OMR_LIST_URL =
  "https://api.weather.gov/products/types/OMR/locations/GRR";

// Canonical human-facing pointer for the beach-hazard program.
export const OMR_URL = "https://www.weather.gov/grr/";

export const OMR_LABEL = "NWS Grand Rapids Lake Michigan Beach Report";

// The distinctive header of the beach-report table. If it is absent the product
// is not the beach report (or the format changed) and we degrade to null.
const OMR_TABLE_HEADER = "Lake Michigan Beach Reports";

// Proximity fallback radius (statute miles) for matches() and for
// resolveSiteForBeach when a beach name does not substring-match a site.
const OMR_MATCH_RADIUS_MI = 2;

// The named beaches this product reports, in table order. names[] are LOWERCASE
// substrings compared BOTH against each OMR table row's Location text (to map a
// row to a site) AND, in resolveSiteForBeach, against a beach's
// (park_name + " " + name). Keep them tight and distinctive so a row is never
// attributed to a namesake/sibling beach. lat/lon are approximate positions
// along the Lake Michigan shore, used only for the proximity fallback.
// radiusMi is carried onto each emitted site so resolveSiteForBeach's proximity
// pass uses the SAME reach as matchesOmr's claim — otherwise a beach 1.5-2.0 mi
// from a centroid (no name match) would be CLAIMED here yet resolve to null.
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

// One table row:
//   "<Location>  <temp> F  <wave> ft  <Flag Color>"
// The water-temp ("NN F" or "M F") and wave-height ("N ft" or "M ft") columns
// are required structural anchors so this only matches genuine data rows — the
// header lines ("Location ... Temp ... Height ... Color", "Water Wave Flag")
// and the prose sections lack this shape and are skipped. The Location group is
// non-greedy so it stops at the first temp column. The trailing flag word is a
// single alpha token (Green / Yellow / Red / None); "None"/unknown normalize to
// null (no data). There is no double-red in this product.
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

// Pure, exported for tests. productText (+ the cron's ISO timestamp, unused but
// kept for signature symmetry) -> sites[] (contract shape (b) sites), [] when
// the table parsed but has nothing reportable (every row None / off-season /
// unknown), or null when the product is unusable (missing table header, or the
// header is present but not one data row matches — a format change).
//   - A row is scoped to the table region between the header and the
//     "Disclaimer"/"Flag Definitions"/"$$" trailer so prose can never be
//     misread as a row.
//   - A row that does not match OMR_ROW_RE is skipped (not a data row).
//   - A row naming an unknown beach is skipped (cannot map to a curated site).
//   - A row whose flag color is None/unrecognized is omitted (NO DATA), never
//     guessed.
//   - Duplicate rows for the same site keep the FIRST (rows are single per
//     beach in this product; the guard is defensive).
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

// Pure. Does this beach belong to one of the curated OMR sites? True if any
// site's names[] substring-matches the beach's (park_name + " " + name), or the
// beach sits within OMR_MATCH_RADIUS_MI of a site. Kept tight so a namesake
// beach elsewhere never resolves onto a west-Michigan state-park flag.
function matchesOmr(beach) {
  const haystack = ((beach.park_name || "") + " " + (beach.name || "")).toLowerCase();
  for (let i = 0; i < SITE_DEFS.length; i++) {
    const def = SITE_DEFS[i];
    for (let j = 0; j < def.names.length; j++) {
      if (haystack.indexOf(def.names[j]) !== -1) {
        return true;
      }
    }
  }
  if (typeof beach.lat === "number" && typeof beach.lon === "number") {
    for (let i = 0; i < SITE_DEFS.length; i++) {
      const def = SITE_DEFS[i];
      if (distanceMi(beach.lat, beach.lon, def.lat, def.lon) <= OMR_MATCH_RADIUS_MI) {
        return true;
      }
    }
  }
  return false;
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
  // Staleness horizon for THIS source. The frontend's 2 h default is calibrated
  // to our own hourly estimate recompute, but the OMR GRR product is issued
  // ONCE PER DAY, late morning local time — observed issuances: 2026-07-17
  // 16:13Z, 07-18 15:17Z, 07-19 15:16Z, 07-20 16:00Z, 07-21 14:56Z, 07-22
  // 15:33Z, i.e. roughly 14:30-16:00 UTC. Since the updated field below is the
  // product's issuanceTime, a flat 2 h horizon would mark the official card
  // stale for ~22 of every 24 hours even though we rewrite the record hourly
  // and the posted flag colors are the current ones. 30 h covers the 24 h
  // cadence plus the ~1.5 h issuance jitter with margin, so the stale warning
  // fires only when NWS genuinely SKIPS an issuance — which is exactly when a
  // reader should stop trusting the colors.
  staleMs: 30 * 60 * 60 * 1000,
  // ...but the reading is still a point-in-time morning observation, and the
  // product text itself warns the observations "may not be representative of
  // conditions later in the day". So between the 2 h default and the 30 h
  // horizon we say so plainly instead of saying nothing. Rendered as a neutral
  // callout with the age appended: "Morning reading — conditions may have
  // changed since it was posted 11 hours ago."
  readingNote: "Morning reading — conditions may have changed since it was posted",
  matches: function(beach) {
    return matchesOmr(beach);
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
      return {
        perBeach: true,
        sites: sites,
        source: OMR_URL,
        sources: [OMR_URL],
        updated: updated
      };
    } catch (err) {
      console.log("nwsOmr: parse failed: " + err.message);
      return null;
    }
  }
};
