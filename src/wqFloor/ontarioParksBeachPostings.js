// src/wqFloor/ontarioParksBeachPostings.js
//
// KIND: wq (src/wqFloor raise-only water-quality floor source). Feeds
// rules.js estimateFlag's "waterQualityAdvisory" input (step 7): it may only
// RAISE a flag UP (worst-of by SEVERITY_RANK) -- never pull a hazard estimate
// down, and it is NOT an official override (official:false). A clean/absent
// reading is the ABSENCE of a site (resolves to null -> zero effect).
//
// SOURCE: Ontario Parks (ontarioparks.ca) publishes a per-park "Alerts" page
// with a server-rendered "Beach Postings" table for its Great Lakes
// provincial-park beaches, e.g.
//   https://www.ontarioparks.ca/park/sandbanks/alerts    (Lake Ontario)
//   https://www.ontarioparks.ca/park/presquile/alerts    (Lake Ontario)
//   https://www.ontarioparks.ca/park/rockpoint/alerts    (Lake Erie)
// Each table has three columns -- "Beach Name", "Sample Date", "Posted" --
// and the page itself explains: A "posting" is an indication of elevated
// bacteria levels in the water, not intended as an indication of operational
// status. (verified live, 2026-07-22, via a direct curl fetch of all three
// pages above -- the raw HTML for the Posted cell is:
//   <td><div ...><img class="alert-icon-list-55"
//       src="/images/icons/alerts/beach-posting-no.png"
//       alt="Beach Posting Results"/></div></td>
// for every beach observed, all currently un-posted.)
//
// FLOOR MAPPING (RAISE-ONLY):
//   Posted icon filename indicates an active posting  -> yellow floor.
//   Posted icon filename indicates NOT posted ("...-no.png", confirmed live)
//     -> NO SITE (the page itself says a posting is not an operational
//        status, so "not posted" carries no hazard signal either way).
//   Icon filename unrecognized / row unparseable                -> NO SITE
//     for that row (fail closed -- never guess).
// There is no red mapping: this source carries only a boolean posted/
// not-posted advisory, so it can only ever raise a clean or unknown estimate
// to yellow, exactly like the project's other wqFloor sources.
//
// *** ICON-FILENAME CONFIRMATION NOTE (integrator: please re-verify before
// enabling in the registry) *** -- every beach observed across all three
// curated parks during authoring (2026-07-22) reads "not posted", so a LIVE
// "posted" row's icon filename has never actually been seen. This module
// infers the posted-state filename to be "beach-posting-yes.png" purely by
// symmetry with the confirmed "beach-posting-no.png" not-posted filename; if
// the true filename differs (e.g. a different token, or the "Posted"
// determination moves off the icon entirely), isPostedFromCell() below
// returns null for that row and no site is ever emitted for it -- the
// feature would quietly do nothing rather than guess, which is the
// safe-fail direction, but an integrator should confirm the real filename
// against a genuinely-posted beach (or via the site owner) before relying on
// this source to raise anything in production.
//
// COVERAGE: curated to the three Ontario Parks Great Lakes beach properties
// named in the task spec (Sandbanks / Lake Ontario, Presqu'ile / Lake
// Ontario, Rock Point / Lake Erie). Sandbanks reports three named beaches
// (Outlet, Dunes, Lakeshore); Presqu'ile and Rock Point each report one.
// names[] entries are somewhat generic beach names ("Outlet Beach", "Dunes
// Beach", "Lakeshore Beach") that COULD collide with a namesake beach
// elsewhere if that beach's OSM park_name happens to also contain the same
// substring -- resolveSiteForBeach's PASS 1 (names) does not itself check
// proximity. This mirrors a known, accepted limitation documented elsewhere
// in the project (see south haven's deliberate omission of "van buren" for
// the same reason); the risk here is judged low because the paired
// park_name context ("Sandbanks Provincial Park", "Presqu'ile Provincial
// Park", "Rock Point Provincial Park") is itself distinctive, but a future
// builder curating a namesake "Outlet Beach"/"Dunes Beach"/"Lakeshore Beach"
// elsewhere should re-check this list.
//
// CADENCE: the page samples periodically (observed sample dates were 1-8
// days old at fetch time) and carries no reliable machine-parseable ISO
// timestamp -- site.updated is left undefined so the wqFloor resolver falls
// back to the perBeachResult-level "updated", which scrape() stamps with the
// passed-in nowIso. Nothing in this module reads Date.now()/new Date().
//
// DEFENSIVE PARSING: any markup/schema change (missing "Beach Postings"
// section/table, reordered/renamed columns, unrecognized Posted icon)
// degrades a ROW to being skipped; a page whose table cannot be located at
// all degrades that PARK's fetch to null (the other parks are unaffected --
// each park page is fetched and parsed independently). Only if EVERY
// curated park page fails does scrape() itself return null.
// parseOntarioParksBeachPostings and isPostedFromCell are pure and exported
// for tests; scrape() is the only network-touching, cron-side-only piece and
// never throws across the module boundary.
//
// INTEGRATOR DEDUP NOTE: this is the ONLY Ontario Parks beach-posting source
// in the project; it does not overlap with any existing hazard scraper or
// wave/alert client (SRF rip, NWS/ECCC alerts, Open-Meteo/GLOS wave are all
// weather/hazard axis, not bacteria). Register ONLY in
// src/wqFloor/index.js's wqFloorSources array (raise-only), never in
// src/officialSources/index.js's scrapers array (hazard-override) -- a
// clean/not-posted reading here says nothing about surf hazard and must
// never be able to produce or mask a color on its own.

import { fetchText } from "../officialSources/util.js";

// Ontario Parks does not publish one canonical cross-park beach-postings
// page -- each park has its own /alerts page (see PARK_PAGES below). This is
// a stable, general landing page for attribution purposes only.
export const ONTARIO_PARKS_INFO_URL = "https://www.ontarioparks.ca/";
export const ONTARIO_PARKS_LABEL = "Ontario Parks Beach Postings";

// The three curated park pages, fetched independently so one park's outage
// or redesign can never null out the other two.
export const PARK_PAGES = [
  { parkId: "sandbanks", url: "https://www.ontarioparks.ca/park/sandbanks/alerts" },
  { parkId: "presquile", url: "https://www.ontarioparks.ca/park/presquile/alerts" },
  { parkId: "rockpoint", url: "https://www.ontarioparks.ca/park/rockpoint/alerts" }
];

// Curated Great Lakes provincial-park beaches this module claims. names[]
// entries are lowercase substrings matched against
// ((beach.park_name || "") + " " + beach.name).toLowerCase(), mirroring
// resolveSiteForBeach's own matching convention (kept in sync deliberately
// so matches() and the eventual site resolution agree on what this source
// covers). tableNames are matched the same way against the parsed table
// row's "Beach Name" cell text.
export const SITE_DEFS = [
  {
    siteId: "sandbanks-outlet-beach",
    names: ["outlet beach"],
    tableNames: ["outlet beach"],
    lat: 43.9195,
    lon: -77.2419,
    radiusMi: 1.5
  },
  {
    siteId: "sandbanks-dunes-beach",
    names: ["dunes beach"],
    tableNames: ["dunes beach"],
    lat: 43.8867,
    lon: -77.2975,
    radiusMi: 1.5
  },
  {
    siteId: "sandbanks-lakeshore-beach",
    names: ["lakeshore beach"],
    tableNames: ["lakeshore beach"],
    lat: 43.8926,
    lon: -77.2846,
    radiusMi: 1.5
  },
  {
    siteId: "presquile-beach",
    names: ["presqu'ile beach", "presquile beach"],
    tableNames: ["presqu'ile beach", "presquile beach"],
    lat: 43.9989,
    lon: -77.7183,
    radiusMi: 1.5
  },
  {
    siteId: "rock-point-beach",
    names: ["rock point beach"],
    tableNames: ["rock point beach"],
    lat: 42.8663,
    lon: -79.5502,
    radiusMi: 1.5
  }
];

// Pure. Decode the small set of HTML entities/whitespace noise that appear
// in table cell text and strip any residual tags. Never throws.
function decodeCellText(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Pure, exported for tests. One "Posted" table cell's raw inner HTML (the
// <td>...</td> contents, containing the status <img>) -> true (posted),
// false (confirmed not posted), or null (unrecognized icon filename --
// fail closed, never guess). Keys off the icon filename, the only part of
// the confirmed live markup that actually varies with status (the <img>
// alt text is the same generic "Beach Posting Results" regardless of
// status, so it carries no usable signal).
export function isPostedFromCell(cellHtml) {
  if (typeof cellHtml !== "string" || cellHtml.length === 0) {
    return null;
  }
  const srcMatch = cellHtml.match(/src\s*=\s*["']([^"']+)["']/i);
  if (srcMatch === null) {
    return null;
  }
  const src = srcMatch[1].toLowerCase();
  if (src.indexOf("beach-posting-no") !== -1) {
    return false;
  }
  if (src.indexOf("beach-posting-yes") !== -1) {
    return true;
  }
  // Unrecognized icon filename (markup/vocabulary drift) -- fail closed.
  console.log("ontarioParksBeachPostings: unrecognized posting icon '" + src + "', omitting row");
  return null;
}

// Pure, exported for tests. One park page's full HTML -> array of
//   { beach, sampleDate, posted: true|false }
// (rows whose posted state could not be recognized are simply omitted, not
// fatal to the whole page), or null when the "Beach Postings" table cannot
// be located AT ALL (unusable/redesigned page for this park).
export function parseOntarioParksBeachPostings(html) {
  if (typeof html !== "string" || html.length === 0) {
    return null;
  }
  const headerIdx = html.search(/Beach\s+Postings/i);
  if (headerIdx === -1) {
    return null;
  }
  const tableIdx = html.indexOf("<table", headerIdx);
  if (tableIdx === -1) {
    return null;
  }
  const tableEndTagIdx = html.indexOf("</table>", tableIdx);
  const tableHtml = tableEndTagIdx === -1
    ? html.slice(tableIdx)
    : html.slice(tableIdx, tableEndTagIdx + "</table>".length);

  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match = rowRe.exec(tableHtml);
  while (match !== null) {
    const rowHtml = match[1];
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch = cellRe.exec(rowHtml);
    while (cellMatch !== null) {
      cells.push(cellMatch[1]);
      cellMatch = cellRe.exec(rowHtml);
    }
    if (cells.length >= 3) {
      const beachName = decodeCellText(cells[0]);
      const sampleDate = decodeCellText(cells[1]);
      const posted = isPostedFromCell(cells[2]);
      if (beachName.length > 0 && posted !== null) {
        rows.push({ beach: beachName, sampleDate: sampleDate, posted: posted });
      }
    }
    match = rowRe.exec(tableHtml);
  }

  if (rows.length === 0) {
    return null;
  }
  return rows;
}

// Pure, exported for tests. rows (from parseOntarioParksBeachPostings,
// possibly concatenated across several park pages) -> Site[] (contract shape
// (b), field "floorColor" not "color") for every curated SITE_DEFS entry
// whose matched row has posted === true. Rows for beaches not in the curated
// list, or with posted !== true (including rows that failed to parse a
// recognizable icon and were already dropped upstream), are simply omitted
// -- never mapped to a color.
export function buildOntarioParksSites(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }
  const sites = [];
  for (let i = 0; i < SITE_DEFS.length; i++) {
    const def = SITE_DEFS[i];
    let matchedRow = null;
    for (let r = 0; r < rows.length; r++) {
      const haystack = (rows[r].beach || "").toLowerCase();
      for (let n = 0; n < def.tableNames.length; n++) {
        if (haystack.indexOf(def.tableNames[n]) !== -1) {
          matchedRow = rows[r];
          break;
        }
      }
      if (matchedRow !== null) {
        break;
      }
    }
    if (matchedRow === null || matchedRow.posted !== true) {
      continue;
    }
    const reason = matchedRow.sampleDate && matchedRow.sampleDate.length > 0
      ? "Beach posting (sample date " + matchedRow.sampleDate + "): elevated bacteria levels reported"
      : "Beach posting: elevated bacteria levels reported";
    sites.push({
      siteId: def.siteId,
      floorColor: "yellow",
      names: def.names,
      lat: def.lat,
      lon: def.lon,
      radiusMi: def.radiusMi,
      reason: reason
    });
  }
  return sites;
}

// Pure. Does this beach fall inside the curated Ontario Parks coverage list,
// by the same names-or-proximity convention resolveSiteForBeach uses
// downstream? Reimplemented locally (rather than importing
// resolveSiteForBeach) to keep this module's only import cron-fetch-side
// (fetchText) and avoid pulling the distance helper in for a pure gate; the
// logic intentionally mirrors resolveSiteForBeach's own PASS 1 / PASS 2.
export function matchesOntarioParksCoverage(beach) {
  if (!beach) {
    return false;
  }
  const haystack = ((beach.park_name || "") + " " + (beach.name || "")).toLowerCase();
  for (let i = 0; i < SITE_DEFS.length; i++) {
    const names = SITE_DEFS[i].names;
    for (let n = 0; n < names.length; n++) {
      if (haystack.indexOf(names[n]) !== -1) {
        return true;
      }
    }
  }
  if (typeof beach.lat !== "number" || typeof beach.lon !== "number") {
    return false;
  }
  for (let i = 0; i < SITE_DEFS.length; i++) {
    const def = SITE_DEFS[i];
    const dLat = beach.lat - def.lat;
    const dLon = beach.lon - def.lon;
    // Cheap planar approximation good enough for a ~1.5 mi gate (roughly
    // 0.022 deg latitude); avoids importing the haversine helper into an
    // otherwise fetch-only module. False positives beyond the true radius
    // are harmless here since scrapeWqFloorFromResult's downstream
    // resolveSiteForBeach re-checks distance precisely before ever emitting
    // an advisory.
    if (Math.abs(dLat) < 0.05 && Math.abs(dLon) < 0.07) {
      return true;
    }
  }
  return false;
}

export const ontarioParksBeachPostings = {
  id: "ontario-parks-beach-postings",
  label: ONTARIO_PARKS_LABEL,
  infoUrl: ONTARIO_PARKS_INFO_URL,
  matches: matchesOntarioParksCoverage,
  // CRON-SIDE ONLY. Fetches each of the three curated park pages
  // independently (one park's failure never nulls the others) and merges
  // every recognized "posted" row into a single site list. Returns null only
  // when EVERY park page failed to fetch or parse -- a partial success (at
  // least one park's table read cleanly) still returns a valid perBeach
  // result, even if that result's sites array ends up empty (a genuinely
  // clean run across the readable parks).
  scrape: async function (nowIso) {
    const allRows = [];
    const succeededUrls = [];
    for (let i = 0; i < PARK_PAGES.length; i++) {
      const page = PARK_PAGES[i];
      const html = await fetchText(page.url, {
        logPrefix: "ontarioParksBeachPostings: fetch failed for " + page.parkId
      });
      if (html === null) {
        continue;
      }
      try {
        const rows = parseOntarioParksBeachPostings(html);
        if (rows === null) {
          console.log("ontarioParksBeachPostings: no recognizable Beach Postings table for " + page.parkId);
          continue;
        }
        succeededUrls.push(page.url);
        for (let r = 0; r < rows.length; r++) {
          allRows.push(rows[r]);
        }
      } catch (err) {
        console.log("ontarioParksBeachPostings: parse failed for " + page.parkId + ": " + err.message);
      }
    }
    if (succeededUrls.length === 0) {
      return null;
    }
    const sites = buildOntarioParksSites(allRows);
    return {
      perBeach: true,
      sites: sites,
      source: ONTARIO_PARKS_LABEL,
      sources: succeededUrls,
      updated: nowIso
    };
  }
};
