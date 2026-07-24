// src/wqFloor/greyBruceRecWater.js
//
// KIND: wq (src/wqFloor raise-only water-quality floor source).
//
// Source: Grey Bruce Health Unit (Lake Huron east shore / Bruce Peninsula,
// Ontario) recreational water testing table, published at
//   https://www.publichealthgreybruce.on.ca/Your-Environment/Safe-Water/Recreational-Water
// A server-rendered, sortable table (columns, in order: Public Beach,
// Location, Test Result, Date Tested, Posted, Note) listing the health unit's
// monthly bacteriological samples for its public bathing areas.
//
// FLOOR MAPPING (RAISE-ONLY, low confidence):
//   Posted == "Yes"                      -> yellow floor (advisory posted)
//   Posted == "No" / Test Result == Pass / row absent / unrecognized -> NO SITE
// There is no red mapping: this source carries only a boolean "posted"
// advisory flag, never a severity tier, so it can only ever raise a clean or
// unknown estimate to yellow, exactly like the other wqFloor sources. A
// "Pass" or unposted row is represented as the ABSENCE of a site, never as an
// affirmative green (green is not a valid wqFloor color at all — see
// src/wqFloor/index.js's WQ_FLOOR_COLORS gate, which independently rejects
// anything other than "yellow"/"red").
//
// COVERAGE: the health unit's public table lists public bathing areas across
// all of Grey and Bruce counties (Georgian Bay + Lake Huron). This module is
// curated to the Lake Huron east-shore / Bruce Peninsula beaches ONLY (see
// LAKE_HURON_SITES below) by name substring, mirroring the resolveSiteForBeach
// names-win convention used across src/officialSources/. The curated list was
// assembled from the health unit's own beach naming, not a live crawl of every
// row the table can contain in a given month — a name that does not resolve
// simply yields no floor (fail-open toward "no data", never a wrong color),
// and the list can be extended by a later builder as more rows are observed.
//
// CADENCE: the health unit samples monthly, not in real time. scrape() has no
// special monthly-cadence gating of its own (there is no "last week's stale
// row" signal in the table itself — every row IS the latest sample for that
// beach); the cron driving this registry is expected to run it at its own
// cadence and let the KV TTL (owned by the cron/integrator, not this module)
// govern staleness. Nothing here reads Date.now()/new Date() for "now" — the
// only place nowIso would matter (an updated timestamp) falls back to the
// caller-supplied nowIso when the table gives us no reliable machine-parseable
// per-row timestamp (see buildGreyBruceSites).
//
// DEFENSIVE PARSING: any markup/schema change (missing table, reordered or
// renamed columns, unrecognized Posted value) degrades a ROW to being skipped,
// and a table that yields no rows at all degrades the whole parse to null.
// parseGreyBruceRecWaterTable is pure and exported for tests; scrape() is the
// only network-touching, cron-side-only piece and never throws across the
// module boundary.
//
// FETCH URL NOTE (integrator: please confirm before enabling in the
// registry): the exact live HTML shape of this ASP.NET/GridView-style
// sortable table (it uses javascript:__doPostBack sort handlers) was
// confirmed via a one-time page fetch during authoring, but no bot-protection
// probing was performed and the table carries no id/class in the observed
// markup to anchor on — the parser instead anchors on the literal header cell
// text "Public Beach", which is the most change-resistant handle available.
// If the header text or table structure ever changes, parseGreyBruceRecWaterTable
// degrades to null (fail closed), never a wrong color.
//
// INTEGRATOR DEDUP NOTE: this is the ONLY Grey Bruce Health Unit source in the
// project; it does not overlap with any existing hazard scraper or wave/alert
// client. It must be registered ONLY in src/wqFloor/index.js's wqFloorSources
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

// Pure, exported for tests. html -> array of
//   { beach, location, testResult, dateTested, posted, note }
// or null when the table cannot be confidently located/parsed at all.
//
// Anchors on the literal header cell text "Public Beach" (the most
// change-resistant handle for an un-ided sortable GridView-style table) to
// locate the table, then reads every subsequent <tr> as a data row until the
// table closes. A row with fewer than 5 cells, or an empty/garbage Public
// Beach cell, is skipped (not fatal to the whole parse) — only a total
// absence of the "Public Beach" header, or zero recognizable data rows,
// degrades the WHOLE result to null.
export function parseGreyBruceRecWaterTable(html) {
  if (typeof html !== "string" || html.length === 0) {
    return null;
  }
  const headerIdx = html.search(/Public\s+Beach/i);
  if (headerIdx === -1) {
    return null;
  }
  // Scope to the nearest enclosing <table>...</table> around the header, so
  // we never wander into unrelated tables elsewhere on the page.
  const tableStart = html.lastIndexOf("<table", headerIdx);
  if (tableStart === -1) {
    return null;
  }
  const tableEndTagIdx = html.indexOf("</table>", headerIdx);
  const tableHtml = tableEndTagIdx === -1
    ? html.slice(tableStart)
    : html.slice(tableStart, tableEndTagIdx + "</table>".length);

  const rows = [];
  const rawRows = extractTableRowsRaw(tableHtml);
  for (let i = 0; i < rawRows.length; i++) {
    const cells = decodeCells(rawRows[i]);
    // Header row (and any decorative rows) use <th> or have no <td> cells at
    // all; skip those without failing the whole parse.
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

// Pure, exported for tests. rows (from parseGreyBruceRecWaterTable) + nowIso
// -> Site[] (contract shape (b), field "floorColor" not "color") for every
// curated LAKE_HURON_SITES entry whose table row has Posted === "Yes". Rows
// for beaches not in the curated list, or with Posted !== "Yes" (including
// unrecognized values), are simply omitted — never mapped to a color.
//
// The health unit table gives no machine-parseable per-row ISO timestamp (its
// Date Tested column is a locale date string, not reliably parseable without
// guessing a timezone), so site.updated is intentionally left undefined here;
// the wqFloor resolver (scrapeWqFloorFromResult) falls back to the
// perBeachResult-level "updated", which scrape() stamps with the passed-in
// nowIso — never a wall-clock read inside this pure function.
export function buildGreyBruceSites(rows) {
  if (!Array.isArray(rows)) {
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
      const sites = buildGreyBruceSites(rows);
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
