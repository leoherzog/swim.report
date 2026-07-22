// src/wqFloor/kenoshaBeachConditions.js
//
// KIND: wq — RAISE-ONLY water-quality FLOOR source (src/wqFloor registry, NOT
// an official scraper). Its site colors feed rules.js estimateFlag's
// "waterQualityAdvisory" input (step 7), where an active E. coli advisory can
// RAISE a flag UP to yellow/red (worst-of by SEVERITY_RANK) but can NEVER pull
// a hazard estimate down. A clean/OPEN reading is modeled as the ABSENCE of a
// site (resolves to null -> zero color effect), so a clean-water status can
// never mask a wave/rip/alert red. This is water quality (E. coli), a
// DIFFERENT axis from the posted-flag hazard sources — it must live here, not
// in src/officialSources/ (an official color OVERRIDES the estimate
// everywhere).
//
// SOURCE: Kenosha County, WI "Beach Conditions" page — a server-rendered HTML
// table. GET https://www.kenoshacountywi.gov/348/Beach-Conditions
// Each table row reads roughly: "<beach name> <N> MPN/100mL <STATUS> <date>"
// (inland-lake rows instead read "<N> E.coli/100 mL"; the unit text is not
// load-bearing to this parser, only the status word and the row's beach name
// are). STATUS is one of OPEN / ADVISORY / CLOSED. The date column is usually
// MM/DD/YY but can instead read a non-date placeholder like
// "To Be Resampled" — that degrades to using nowIso for "updated", it does not
// invalidate the row's status.
//
// FETCH URL CONFIRMED LIVE 2026-07 (fetched via WebFetch to confirm the table
// contents and column order: Beach Name | E.coli Result | Condition |
// Sampling Date). The exact underlying HTML tag/class structure was NOT
// directly observable through the fetch tool (it returns rendered/markdown
// content, not raw markup), so parseKenoshaBeachConditions is written
// defensively against the STANDARD <table>/<tr>/<td> shape a CivicPlus-style
// county site is expected to serve, and degrades to null (never a wrong
// color) if that structural assumption breaks. Re-verify the raw HTML if this
// source starts returning null in production.
//
// CURATION: Kenosha County's table lists ~20+ INLAND lake beaches (Silver
// Lake, Camp Lake, Lake George, etc.) alongside the ~6 LAKE MICHIGAN beaches
// this floor is scoped to: Alford Park, Eichelman (Beach), Pennoyer Park,
// Simmons Island (Park), Southport Park, Prairie Shores. Only rows whose name
// cell matches one of those curated aliases are considered; every inland-lake
// row is ignored regardless of its status.
//
// FLOOR MAPPING (raise-only; nothing else produces a site):
//   STATUS "ADVISORY" -> floorColor "yellow"
//   STATUS "CLOSED"   -> floorColor "red"
//   STATUS "OPEN"     -> NO site (the beach is clean; absence IS the floor)
//   any other/unrecognized status text -> NO site (fail closed to no-floor,
//     never a guessed color)
//
// INTEGRATOR / DEDUP NOTE: register in src/wqFloor/index.js "wqFloorSources"
// (append; no ordering conflict with the existing NY/USGS sources — disjoint
// geography). Do NOT add this to src/officialSources/index.js — water quality
// is a NEW axis, disjoint from every hazard source (wave / rip / NWS+ECCC
// alerts), so there is no dedup concern. Its entire color effect is inside the
// estimate (official:false).
//
// scrape() runs cron-side only. parseKenoshaBeachConditions, extractTableRows,
// and htmlToText are pure and exported for tests.

import { fetchText, perBeachResult, DEFAULT_SITE_RADIUS_MI } from "../officialSources/util.js";
import { distanceMi } from "../geo.js";

export const KENOSHA_BEACH_CONDITIONS_URL =
  "https://www.kenoshacountywi.gov/348/Beach-Conditions";

export const KENOSHA_LABEL = "Kenosha County Beach Conditions";

export const KENOSHA_INFO_URL = KENOSHA_BEACH_CONDITIONS_URL;

// The ~6 Lake Michigan beaches this floor is scoped to (Kenosha County, WI).
// aliases are lowercase substrings matched BOTH against a table row's name
// cell (to pick the row) and, as resolveSiteForBeach "names", against a
// swim.report beach's park_name + name. Coordinates are approximate Kenosha,
// WI lakefront locations (used only as the resolver's proximity fallback when
// a beach's own name/park_name does not carry the alias).
const LAKE_MICHIGAN_SITES = [
  { siteId: "alford-park", aliases: ["alford park", "alford"], lat: 42.619, lon: -87.795 },
  { siteId: "eichelman-beach", aliases: ["eichelman"], lat: 42.585, lon: -87.790 },
  { siteId: "pennoyer-park", aliases: ["pennoyer"], lat: 42.567, lon: -87.795 },
  { siteId: "simmons-island", aliases: ["simmons island", "simmons"], lat: 42.600, lon: -87.795 },
  { siteId: "southport-park", aliases: ["southport"], lat: 42.561, lon: -87.796 },
  { siteId: "prairie-shores", aliases: ["prairie shores"], lat: 42.652, lon: -87.792 }
];

// How near (mi) a swim.report beach must sit to a curated site for the
// source's matches() proximity gate to fire, when the name substring does not.
const MATCH_RADIUS_MI = 3;

// Pure, exported for tests. Strips HTML tags and a few common entities from a
// cell/row fragment, collapses whitespace, and trims. Non-string -> "".
export function htmlToText(html) {
  if (typeof html !== "string") {
    return "";
  }
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

// Pure, exported for tests. Raw HTML -> array of row-cell-text arrays
// (["Alford Park", "10 MPN/100mL", "OPEN", "07/20/26"], ...), or [] when no
// <tr> blocks are found at all (a total structural change). Only <td> cells
// are collected (NOT <th>), so a standard header row built from <th> cells
// naturally yields zero cells and is dropped; a data row with fewer than 3
// <td> cells is also dropped silently — both simply never contribute a row.
// Never throws.
export function extractTableRows(html) {
  if (typeof html !== "string" || html.length === 0) {
    return [];
  }
  const rows = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells = [];
    const cellRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(htmlToText(cellMatch[1]));
    }
    if (cells.length >= 3) {
      rows.push(cells);
    }
  }
  return rows;
}

// Pure. Uppercased/trimmed status token, or null when unrecognized. Only
// ADVISORY and CLOSED ever produce a floor; OPEN and anything else are both
// "no floor" (the caller distinguishes OPEN-recognized from wholly
// unrecognized only for the recognized-row counter, not for color).
function normalizeStatus(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim().toUpperCase();
  if (trimmed === "OPEN" || trimmed === "ADVISORY" || trimmed === "CLOSED") {
    return trimmed;
  }
  return null;
}

// Pure. Which curated site (if any) a row's name cell refers to.
function findCuratedSite(nameCellText) {
  const lowered = (nameCellText || "").toLowerCase();
  for (let i = 0; i < LAKE_MICHIGAN_SITES.length; i++) {
    const site = LAKE_MICHIGAN_SITES[i];
    for (let a = 0; a < site.aliases.length; a++) {
      if (lowered.indexOf(site.aliases[a]) !== -1) {
        return site;
      }
    }
  }
  return null;
}

// Pure. "MM/DD/YY" -> ISO-8601 UTC-midnight string, or null when the text does
// not match (e.g. "To Be Resampled"). Built from parsed components only — no
// wall-clock read.
export function parseSamplingDate(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(raw.trim());
  if (!m) {
    return null;
  }
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  const yy = parseInt(m[3], 10);
  if (!isFinite(month) || month < 1 || month > 12) {
    return null;
  }
  if (!isFinite(day) || day < 1 || day > 31) {
    return null;
  }
  if (!isFinite(yy)) {
    return null;
  }
  const fullYear = 2000 + yy;
  const mm = month < 10 ? "0" + String(month) : String(month);
  const dd = day < 10 ? "0" + String(day) : String(day);
  return String(fullYear) + "-" + mm + "-" + dd + "T00:00:00Z";
}

// Pure, exported for tests. Row-cell-text arrays -> sites[] | null.
//   - null ONLY when zero rows resolved to a curated Lake Michigan beach at
//     all — i.e. the table shape/column order has drifted so far that none of
//     the ~6 curated names were ever recognized. That is the health-failure
//     signal (fail closed, never a guessed color).
//   - [] when curated rows were found but every one currently reads OPEN (the
//     all-clear case) — a SUCCESSFUL parse with nothing to report.
//   - one site per curated beach currently reading ADVISORY or CLOSED.
// Expects cells in [name, ecoliReading, status, date] order (Kenosha County's
// published column order as of 2026-07); a row with fewer than 3 cells never
// reaches here (extractTableRows already dropped it).
export function parseKenoshaBeachConditions(rows, nowIso) {
  if (!Array.isArray(rows)) {
    return null;
  }
  let recognizedCount = 0;
  const sites = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i];
    if (!Array.isArray(cells) || cells.length < 3) {
      continue;
    }
    const site = findCuratedSite(cells[0]);
    if (site === null) {
      continue;
    }
    recognizedCount = recognizedCount + 1;
    const statusIndex = cells.length >= 4 ? 2 : cells.length - 1;
    const status = normalizeStatus(cells[statusIndex]);
    if (status === null || status === "OPEN") {
      // Unrecognized status text or a clean OPEN reading: no floor for this
      // beach. Both degrade the same way — absence of a site.
      continue;
    }
    const ecoliText = cells.length >= 2 ? cells[1] : "";
    const dateText = cells.length >= 4 ? cells[3] : "";
    const updated = parseSamplingDate(dateText) || nowIso;
    const floorColor = status === "CLOSED" ? "red" : "yellow";
    let reason = "Kenosha County beach conditions: " + status;
    if (typeof ecoliText === "string" && ecoliText.length > 0) {
      reason = reason + " (" + ecoliText + ")";
    }
    sites.push({
      siteId: site.siteId,
      floorColor: floorColor,
      names: site.aliases,
      lat: site.lat,
      lon: site.lon,
      radiusMi: DEFAULT_SITE_RADIUS_MI,
      reason: reason,
      updated: updated
    });
  }
  if (recognizedCount === 0) {
    console.log("kenoshaBeachConditions: no curated Lake Michigan beach rows recognized");
    return null;
  }
  return sites;
}

// Pure. True when a swim.report beach is one of the curated Kenosha County
// Lake Michigan beaches — by name substring OR lat/lon proximity to a curated
// site.
function inKenoshaLakeMichiganSites(beach) {
  const haystack = ((beach.park_name || "") + " " + (beach.name || "")).toLowerCase();
  for (let s = 0; s < LAKE_MICHIGAN_SITES.length; s++) {
    const site = LAKE_MICHIGAN_SITES[s];
    for (let a = 0; a < site.aliases.length; a++) {
      if (haystack.indexOf(site.aliases[a]) !== -1) {
        return true;
      }
    }
    if (typeof beach.lat === "number" && typeof beach.lon === "number") {
      if (distanceMi(beach.lat, beach.lon, site.lat, site.lon) <= MATCH_RADIUS_MI) {
        return true;
      }
    }
  }
  return false;
}

export const kenoshaBeachConditions = {
  id: "kenosha-beach-conditions",
  label: KENOSHA_LABEL,
  infoUrl: KENOSHA_INFO_URL,
  matches: function(beach) {
    return inKenoshaLakeMichiganSites(beach);
  },
  scrape: async function(nowIso) {
    const html = await fetchText(KENOSHA_BEACH_CONDITIONS_URL, {
      logPrefix: "kenoshaBeachConditions: fetch failed"
    });
    if (html === null) {
      return null;
    }
    try {
      const rows = extractTableRows(html);
      const sites = parseKenoshaBeachConditions(rows, nowIso);
      // null => real parse/structural failure (surface as a health failure).
      // [] => clean run, every curated beach currently OPEN — a SUCCESSFUL
      // scrape with nothing to report, wrapped in an empty perBeachResult so
      // it counts as a health success (resolves to no floor for every beach,
      // writes no KV), mirroring the metroparks/presque-isle closure pattern.
      if (sites === null) {
        return null;
      }
      return perBeachResult(sites, KENOSHA_BEACH_CONDITIONS_URL, nowIso);
    } catch (err) {
      console.log("kenoshaBeachConditions: parse failed: " + err.message);
      return null;
    }
  }
};
