// src/wqFloor/greyBruceRecWater.js — a raise-only water-quality floor source; see
// src/wqFloor/index.js for the floor contract.
//
// Source: Grey Bruce Health Unit (Lake Huron east shore / Bruce Peninsula,
// Ontario) recreational water testing table, published at
//   https://www.publichealthgreybruce.on.ca/Your-Environment/Safe-Water/Recreational-Water
// A server-rendered, sortable table (columns, in order: Public Beach,
// Location, Test Result, Date Tested, Posted, Note) listing the health unit's
// monthly bacteriological samples for its public bathing areas.
//
// Floor mapping:
//   Posted == "Yes"                      -> yellow floor (advisory posted)
//   Posted == "No" / Test Result == Pass / row absent / unrecognized -> no site
// There is no red mapping: this source carries only a boolean posted flag, never
// a severity tier, so it can only raise a clean or unknown estimate to yellow. A
// Pass or unposted row is the absence of a site, never an affirmative green.
//
// COVERAGE: the health unit's public table lists public bathing areas across
// all of Grey and Bruce counties (Georgian Bay + Lake Huron). This module is
// curated to the Lake Huron east-shore / Bruce Peninsula beaches only (see
// LAKE_HURON_SITES below) by name substring, mirroring the resolveSiteForBeach
// names-win convention used across src/officialSources/. The curated list was
// assembled from the health unit's own beach naming, not a live crawl of every
// row the table can contain in a given month — a name that does not resolve
// simply yields no floor (fail-open toward "no data", never a wrong color),
// and the list can be extended by a later builder as more rows are observed.
//
// CADENCE: the health unit samples monthly and the table keeps each beach's
// last sample indefinitely. buildGreyBruceSites therefore drops a posted row
// whose Date Tested is unparseable, more than a day after nowIso, or more than
// MAX_SAMPLE_AGE_DAYS before the caller's nowIso. Nothing here reads the
// wall clock.
//
// DEFENSIVE PARSING: a missing table, reordered or renamed header columns, or
// zero data rows degrade the whole parse to null; a short row or an
// unrecognized Posted value skips that row. parseGreyBruceRecWaterTable is
// pure and exported for tests; scrape() is the only network-touching piece
// and never throws across the module boundary.
//
// FETCH URL NOTE: the table is a DNN GridView whose header cells wrap
// javascript:__doPostBack sort links. The parser accepts the first <table>
// whose header row begins with exactly Public Beach, Location, Test Result,
// Date Tested, Posted, because intro prose above the grid also says "Public
// Beaches" and a page-text search would anchor on it.
//
// INTEGRATOR DEDUP NOTE: this is the only Grey Bruce Health Unit source in the
// project; it does not overlap with any existing hazard scraper or wave/alert
// client. It must be registered only in src/wqFloor/index.js's wqFloorSources
// array (raise-only), never in src/officialSources/index.js's scrapers array
// (hazard-override) — a clean/"Pass" reading here says nothing about surf
// hazard and must never be able to produce or mask a color on its own.

import {
  fetchText,
  perBeachResult,
  decodeCellText,
  extractTableRowsRaw,
  matchesAnyAlias
} from "../officialSources/util.js";

export const GREY_BRUCE_REC_WATER_URL =
  "https://www.publichealthgreybruce.on.ca/Your-Environment/Safe-Water/Recreational-Water";

export const GREY_BRUCE_REC_WATER_LABEL =
  "Grey Bruce Health Unit Recreational Water Testing";

// Curated Lake Huron east-shore / Bruce Peninsula public bathing areas this
// module claims. names[] entries are lowercase substrings matched against
// ((beach.park_name || "") + " " + beach.name).toLowerCase(), mirroring
// resolveSiteForBeach's own matching convention (kept in sync deliberately
// so matches() and the eventual site resolution agree on what this source
// covers). Keep entries TIGHT — a loose token can wrongly attribute a
// namesake beach's advisory to a different beach.
export const LAKE_HURON_SITES = [
  { siteId: "sauble-beach-north", names: ["sauble beach north"], tableNames: ["sauble beach north"] },
  { siteId: "sauble-beach-south", names: ["sauble beach south"], tableNames: ["sauble beach south"] },
  { siteId: "oliphant-beach", names: ["oliphant beach"], tableNames: ["oliphant"] },
  { siteId: "station-park-beach", names: ["station park beach"], tableNames: ["station park beach"] },
  { siteId: "boiler-beach", names: ["boiler beach"], tableNames: ["boiler beach"] },
  { siteId: "mac-gregor-point-beach", names: ["macgregor point"], tableNames: ["macgregor point"] },
  { siteId: "port-elgin-main-beach", names: ["port elgin main beach"], tableNames: ["port elgin main beach"] },
  { siteId: "port-elgin-gobles-grove-beach", names: ["gobles grove"], tableNames: ["gobles grove"] },
  { siteId: "southampton-beach", names: ["southampton beach"], tableNames: ["southampton beach"] },
  { siteId: "point-clark-beach", names: ["point clark beach"], tableNames: ["point clark beach"] },
  { siteId: "inverhuron-beach", names: ["inverhuron beach"], tableNames: ["inverhuron beach"] },
  { siteId: "amberley-beach", names: ["amberley beach"], tableNames: ["amberley beach"] }
];

// Pure. Decodes one <tr>'s raw <td> inner-HTML strings (as produced by the
// shared extractTableRowsRaw) into cell texts, in document order. Returns []
// for a row with no <td> cells (e.g. a <th> header row).
function decodeCells(rawCells) {
  const cells = [];
  for (let c = 0; c < rawCells.length; c++) {
    cells.push(decodeCellText(rawCells[c]));
  }
  return cells;
}

const EXPECTED_HEADER = ["public beach", "location", "test result", "date tested", "posted"];

// The table keeps each beach's last sample indefinitely, so an end-of-season
// posting must not floor a beach all winter.
const MAX_SAMPLE_AGE_DAYS = 35;

const DAY_MS = 86400000;

// Pure. One <table> block -> its first <th>-bearing row's cell texts,
// lowercased, or null when the block has no <th> row.
function headerCells(tableHtml) {
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch = rowRegex.exec(tableHtml);
  while (rowMatch !== null) {
    const cells = [];
    const cellRegex = /<th\b[^>]*>([\s\S]*?)<\/th>/gi;
    let cellMatch = cellRegex.exec(rowMatch[1]);
    while (cellMatch !== null) {
      cells.push(decodeCellText(cellMatch[1]).toLowerCase());
      cellMatch = cellRegex.exec(rowMatch[1]);
    }
    if (cells.length > 0) {
      return cells;
    }
    rowMatch = rowRegex.exec(tableHtml);
  }
  return null;
}

// Pure. True when the header's first five cells are exactly EXPECTED_HEADER.
function isGridHeader(cells) {
  if (cells === null || cells.length < EXPECTED_HEADER.length) {
    return false;
  }
  for (let i = 0; i < EXPECTED_HEADER.length; i++) {
    if (cells[i] !== EXPECTED_HEADER[i]) {
      return false;
    }
  }
  return true;
}

// Pure, exported for tests. html -> array of
//   { beach, location, testResult, dateTested, posted, note }
// or null when no <table> carries the expected header or it has no data rows.
// A row with fewer than 5 cells or an empty Public Beach cell is skipped.
export function parseGreyBruceRecWaterTable(html) {
  if (typeof html !== "string" || html.length === 0) {
    return null;
  }
  let tableHtml = null;
  const tableRegex = /<table\b[\s\S]*?<\/table>/gi;
  let tableMatch = tableRegex.exec(html);
  while (tableMatch !== null) {
    if (isGridHeader(headerCells(tableMatch[0]))) {
      tableHtml = tableMatch[0];
      break;
    }
    tableMatch = tableRegex.exec(html);
  }
  if (tableHtml === null) {
    return null;
  }

  const rows = [];
  const rawRows = extractTableRowsRaw(tableHtml);
  for (let i = 0; i < rawRows.length; i++) {
    const cells = decodeCells(rawRows[i]);
    if (cells.length >= 5) {
      const beach = cells[0];
      const location = cells[1];
      const testResult = cells[2];
      const dateTested = cells[3];
      const posted = cells[4];
      const note = cells.length >= 6 ? cells[5] : "";
      if (beach.length > 0 && !/^public\s+beach$/i.test(beach)) {
        rows.push({
          beach: beach,
          location: location,
          testResult: testResult,
          dateTested: dateTested,
          posted: posted,
          note: note
        });
      }
    }
  }

  if (rows.length === 0) {
    return null;
  }
  return rows;
}

// Pure. Normalizes a raw "Posted" cell value to a strict boolean, or null
// when unrecognized (never guess — an unrecognized Posted value is treated
// as "no floor" for that row, not as an advisory).
export function normalizePosted(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const key = raw.trim().toLowerCase();
  if (key === "yes") {
    return true;
  }
  if (key === "no") {
    return false;
  }
  return null;
}

// Pure, exported for tests. "M/D/YYYY" -> that calendar day's UTC midnight
// in ms, or null for any other shape or an impossible date such as 2/31.
export function parseTestedDate(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(raw);
  if (m === null) {
    return null;
  }
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const ms = Date.UTC(year, month - 1, day);
  if (new Date(ms).getUTCDate() !== day) {
    return null;
  }
  return ms;
}

// Pure, exported for tests. rows + nowIso -> a yellow floor Site for every
// curated LAKE_HURON_SITES entry whose row is Posted "Yes" and was tested
// within MAX_SAMPLE_AGE_DAYS of nowIso and no more than a day after it.
// site.updated stays unset, so the resolver takes the result-level nowIso.
// @param {Array} rows from parseGreyBruceRecWaterTable
// @param {string} nowIso the run instant; unparseable yields []
// @returns {Array} Site[] with field floorColor
export function buildGreyBruceSites(rows, nowIso) {
  if (!Array.isArray(rows)) {
    return [];
  }
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    return [];
  }
  const sites = [];
  for (let i = 0; i < LAKE_HURON_SITES.length; i++) {
    const curated = LAKE_HURON_SITES[i];
    let matchedRow = null;
    for (let r = 0; r < rows.length; r++) {
      if (matchesAnyAlias(rows[r].beach || "", curated.tableNames)) {
        matchedRow = rows[r];
        break;
      }
    }
    if (matchedRow === null) {
      continue;
    }
    const posted = normalizePosted(matchedRow.posted);
    if (posted !== true) {
      continue;
    }
    const testedMs = parseTestedDate(matchedRow.dateTested);
    if (testedMs === null || nowMs - testedMs > MAX_SAMPLE_AGE_DAYS * DAY_MS || testedMs - nowMs > DAY_MS) {
      continue;
    }
    const detailBits = [];
    if (matchedRow.testResult && matchedRow.testResult.length > 0) {
      detailBits.push("test result " + matchedRow.testResult);
    }
    if (matchedRow.dateTested && matchedRow.dateTested.length > 0) {
      detailBits.push("tested " + matchedRow.dateTested);
    }
    if (matchedRow.note && matchedRow.note.length > 0) {
      detailBits.push(matchedRow.note);
    }
    const reason = detailBits.length > 0
      ? "Advisory posted (" + detailBits.join(", ") + ")"
      : "Advisory posted";
    sites.push({
      siteId: curated.siteId,
      floorColor: "yellow",
      names: curated.names,
      reason: reason
    });
  }
  return sites;
}

// Pure. Does this beach fall inside the curated Lake Huron coverage list, by
// the same names-substring convention resolveSiteForBeach uses downstream?
export function matchesGreyBruceCoverage(beach) {
  if (!beach) {
    return false;
  }
  const haystack = ((beach.park_name || "") + " " + (beach.name || "")).toLowerCase();
  for (let i = 0; i < LAKE_HURON_SITES.length; i++) {
    if (matchesAnyAlias(haystack, LAKE_HURON_SITES[i].names)) {
      return true;
    }
  }
  return false;
}

export const greyBruceRecWater = {
  id: "grey-bruce-rec-water",
  label: GREY_BRUCE_REC_WATER_LABEL,
  infoUrl: GREY_BRUCE_REC_WATER_URL,
  matches: matchesGreyBruceCoverage,
  scrape: async function (nowIso) {
    const html = await fetchText(GREY_BRUCE_REC_WATER_URL, {
      logPrefix: "greyBruceRecWater: fetch failed"
    });
    if (html === null) {
      return null;
    }
    try {
      const rows = parseGreyBruceRecWaterTable(html);
      if (rows === null) {
        console.log("greyBruceRecWater: no recognizable table in body");
        return null;
      }
      const sites = buildGreyBruceSites(rows, nowIso);
      // Even zero posted advisories is a successful, clean parse — return an
      // empty perBeachResult (not null) so a genuinely all-clear month is
      // never mistaken for a fetch/parse failure by whatever caller tracks
      // this source's health.
      return perBeachResult(sites, GREY_BRUCE_REC_WATER_URL, nowIso);
    } catch (err) {
      console.log("greyBruceRecWater: parse failed: " + err.message);
      return null;
    }
  }
};
