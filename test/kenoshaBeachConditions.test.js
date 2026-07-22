// test/kenoshaBeachConditions.test.js
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  htmlToText,
  extractTableRows,
  parseSamplingDate,
  parseKenoshaBeachConditions,
  kenoshaBeachConditions,
  KENOSHA_BEACH_CONDITIONS_URL,
  KENOSHA_LABEL
} from "../src/wqFloor/kenoshaBeachConditions.js";
import { scrapeFloorFromResult } from "../src/wqFloor/index.js";
import { makeBeach } from "./helpers/beach.js";
import { findSite } from "./helpers/sites.js";
import { installFetch } from "./helpers/fetch.js";

const NOW_ISO = "2026-07-21T12:00:00Z";

// Builds a minimal HTML table body from row-cell arrays, mirroring the live
// Kenosha County page's column order: [name, ecoli reading, status, date].
function kenoshaTable(rows) {
  let html = "<table><thead><tr><th>Beach</th><th>E.coli</th>" +
    "<th>Condition</th><th>Date</th></tr></thead><tbody>";
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i];
    html = html + "<tr>";
    for (let c = 0; c < cells.length; c++) {
      html = html + "<td>" + cells[c] + "</td>";
    }
    html = html + "</tr>";
  }
  html = html + "</tbody></table>";
  return html;
}

describe("htmlToText", function() {
  it("strips tags and collapses whitespace", function() {
    expect(htmlToText("<span>Alford  Park</span>")).toBe("Alford Park");
  });

  it("decodes common entities", function() {
    expect(htmlToText("Tom&#39;s &amp; Jerry&nbsp;Beach")).toBe("Tom's & Jerry Beach");
  });

  it("returns empty string for non-string input", function() {
    expect(htmlToText(null)).toBe("");
    expect(htmlToText(undefined)).toBe("");
  });
});

describe("extractTableRows", function() {
  it("extracts cell text arrays from a well-formed table", function() {
    const html = kenoshaTable([
      ["Alford Park", "10 MPN/100mL", "OPEN", "07/20/26"],
      ["Eichelman Beach", "63 MPN/100mL", "OPEN", "07/20/26"]
    ]);
    const rows = extractTableRows(html);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual(["Alford Park", "10 MPN/100mL", "OPEN", "07/20/26"]);
    expect(rows[1][0]).toBe("Eichelman Beach");
  });

  it("drops rows with fewer than 3 cells", function() {
    const html = "<table><tr><td>Only</td><td>Two</td></tr>" +
      "<tr><td>Alford Park</td><td>10 MPN/100mL</td><td>OPEN</td></tr></table>";
    const rows = extractTableRows(html);
    expect(rows.length).toBe(1);
    expect(rows[0][0]).toBe("Alford Park");
  });

  it("returns an empty array when no rows are found", function() {
    expect(extractTableRows("<div>no table here</div>")).toEqual([]);
  });

  it("returns an empty array for null/empty input", function() {
    expect(extractTableRows(null)).toEqual([]);
    expect(extractTableRows("")).toEqual([]);
  });
});

describe("parseSamplingDate", function() {
  it("parses MM/DD/YY to an ISO UTC-midnight string", function() {
    expect(parseSamplingDate("07/20/26")).toBe("2026-07-20T00:00:00Z");
  });

  it("pads single-digit month/day", function() {
    expect(parseSamplingDate("7/5/26")).toBe("2026-07-05T00:00:00Z");
  });

  it("returns null for a non-date placeholder", function() {
    expect(parseSamplingDate("To Be Resampled")).toBe(null);
  });

  it("returns null for non-string / malformed input", function() {
    expect(parseSamplingDate(null)).toBe(null);
    expect(parseSamplingDate("")).toBe(null);
    expect(parseSamplingDate("13/40/99")).toBe(null);
  });
});

describe("parseKenoshaBeachConditions", function() {
  it("omits OPEN curated beaches (a clean reading is the absence of a site)", function() {
    const rows = extractTableRows(kenoshaTable([
      ["Alford Park", "10 MPN/100mL", "OPEN", "07/20/26"],
      ["Eichelman Beach", "63 MPN/100mL", "OPEN", "07/20/26"]
    ]));
    const sites = parseKenoshaBeachConditions(rows, NOW_ISO);
    expect(sites).toEqual([]);
  });

  it("floors an ADVISORY curated beach to yellow", function() {
    const rows = extractTableRows(kenoshaTable([
      ["Pennoyer Park", "276 MPN/100mL", "ADVISORY", "07/20/26"]
    ]));
    const sites = parseKenoshaBeachConditions(rows, NOW_ISO);
    const site = findSite(sites, "pennoyer-park");
    expect(site).not.toBe(null);
    expect(site.floorColor).toBe("yellow");
    expect(site.reason).toBe("Kenosha County beach conditions: ADVISORY (276 MPN/100mL)");
    expect(site.updated).toBe("2026-07-20T00:00:00Z");
  });

  it("floors a CLOSED curated beach to red", function() {
    const rows = extractTableRows(kenoshaTable([
      ["Simmons Island Park", "1300 MPN/100mL", "CLOSED", "07/21/26"]
    ]));
    const sites = parseKenoshaBeachConditions(rows, NOW_ISO);
    const site = findSite(sites, "simmons-island");
    expect(site).not.toBe(null);
    expect(site.floorColor).toBe("red");
  });

  it("uses nowIso for updated when the date column is a non-date placeholder", function() {
    const rows = extractTableRows(kenoshaTable([
      ["Southport Park", "1300 MPN/100mL", "CLOSED", "To Be Resampled"]
    ]));
    const sites = parseKenoshaBeachConditions(rows, NOW_ISO);
    const site = findSite(sites, "southport-park");
    expect(site.updated).toBe(NOW_ISO);
  });

  it("ignores inland-lake rows outside the curated Lake Michigan set", function() {
    const rows = extractTableRows(kenoshaTable([
      ["Camp Lake", "276 MPN/100mL", "ADVISORY", "To be Resampled"],
      ["Silver Lake", "115 E.coli/100 mL", "OPEN", "07/21/26"],
      ["Alford Park", "10 MPN/100mL", "OPEN", "07/20/26"]
    ]));
    const sites = parseKenoshaBeachConditions(rows, NOW_ISO);
    // Camp Lake's ADVISORY must never surface here — it is not a curated
    // Lake Michigan beach, even though its status would otherwise floor.
    expect(sites).toEqual([]);
  });

  it("rolls the full curated set the way the live page lists it", function() {
    const rows = extractTableRows(kenoshaTable([
      ["Alford Park", "10 MPN/100mL", "OPEN", "07/20/26"],
      ["Eichelman Beach", "63 MPN/100mL", "OPEN", "07/20/26"],
      ["Pennoyer Park", "120 MPN/100mL", "OPEN", "07/20/26"],
      ["Simmons Island Park", "20 MPN/100 mL", "OPEN", "07/20/26"],
      ["Southport Park", "20 MPN/100mL", "OPEN", "07/20/26"],
      ["Silver Lake", "115.0 E.coli/100 mL", "OPEN", "07/21/26"],
      ["PHLA Beach", "1300.0 E.coli/100 mL", "CLOSED", "To Be Resampled"],
      ["Camp Lake", "276.0 E.coli/100 mL", "ADVISORY", "To be Resampled"],
      ["Prairie Shores", "10 MPN/100 mL", "OPEN", "07/20/26"]
    ]));
    const sites = parseKenoshaBeachConditions(rows, NOW_ISO);
    // All 6 curated beaches are OPEN on this fixture; only inland-lake rows
    // (PHLA Beach, Camp Lake, Silver Lake) carry non-OPEN statuses, and those
    // must never leak into the curated result.
    expect(sites).toEqual([]);
  });

  it("returns null when no curated beach row is ever recognized (structural drift)", function() {
    const rows = extractTableRows(kenoshaTable([
      ["Silver Lake", "115 E.coli/100 mL", "OPEN", "07/21/26"],
      ["Camp Lake", "276 E.coli/100 mL", "ADVISORY", "07/21/26"]
    ]));
    expect(parseKenoshaBeachConditions(rows, NOW_ISO)).toBe(null);
  });

  it("returns null for a non-array rows argument", function() {
    expect(parseKenoshaBeachConditions(null, NOW_ISO)).toBe(null);
    expect(parseKenoshaBeachConditions(undefined, NOW_ISO)).toBe(null);
  });

  it("treats an unrecognized status word as no-floor, not a crash", function() {
    const rows = extractTableRows(kenoshaTable([
      ["Alford Park", "10 MPN/100mL", "UNKNOWN-STATUS", "07/20/26"],
      ["Eichelman Beach", "10 MPN/100mL", "OPEN", "07/20/26"]
    ]));
    const sites = parseKenoshaBeachConditions(rows, NOW_ISO);
    expect(sites).toEqual([]);
  });
});

describe("kenoshaBeachConditions.matches", function() {
  it("matches by curated name substring", function() {
    const beach = makeBeach({ name: "Alford Park Beach", lat: 0, lon: 0 });
    expect(kenoshaBeachConditions.matches(beach)).toBe(true);
  });

  it("matches by park_name substring", function() {
    const beach = makeBeach({ name: "Main Beach", park_name: "Pennoyer Park", lat: 0, lon: 0 });
    expect(kenoshaBeachConditions.matches(beach)).toBe(true);
  });

  it("matches by proximity when the name carries no curated alias", function() {
    const beach = makeBeach({ name: "Lakefront Access", lat: 42.567, lon: -87.795 });
    expect(kenoshaBeachConditions.matches(beach)).toBe(true);
  });

  it("does not match a beach far from every curated site", function() {
    const beach = makeBeach({ name: "Somewhere Else Beach", lat: 44.8, lon: -83.3 });
    expect(kenoshaBeachConditions.matches(beach)).toBe(false);
  });
});

describe("kenoshaBeachConditions.scrape", function() {
  afterEach(function() {
    vi.unstubAllGlobals();
  });

  it("fetches the live URL and returns a perBeach result on an advisory", async function() {
    const html = kenoshaTable([
      ["Pennoyer Park", "276 MPN/100mL", "ADVISORY", "07/20/26"]
    ]);
    const calls = installFetch(function(url) {
      return Promise.resolve({
        ok: true,
        text: function() { return Promise.resolve(html); }
      });
    });
    const result = await kenoshaBeachConditions.scrape(NOW_ISO);
    expect(calls.length).toBe(1);
    expect(String(calls[0].url)).toBe(KENOSHA_BEACH_CONDITIONS_URL);
    expect(result).not.toBe(null);
    expect(result.perBeach).toBe(true);
    expect(result.source).toBe(KENOSHA_BEACH_CONDITIONS_URL);
    const site = findSite(result.sites, "pennoyer-park");
    expect(site.floorColor).toBe("yellow");
  });

  it("returns null when the fetch fails", async function() {
    vi.stubGlobal("fetch", function() {
      return Promise.resolve({ ok: false, status: 500 });
    });
    const result = await kenoshaBeachConditions.scrape(NOW_ISO);
    expect(result).toBe(null);
  });

  it("returns null when no curated row is recognized (all-clean fetch, structural drift)", async function() {
    const html = kenoshaTable([
      ["Silver Lake", "115 E.coli/100 mL", "OPEN", "07/21/26"]
    ]);
    vi.stubGlobal("fetch", function() {
      return Promise.resolve({
        ok: true,
        text: function() { return Promise.resolve(html); }
      });
    });
    const result = await kenoshaBeachConditions.scrape(NOW_ISO);
    expect(result).toBe(null);
  });
});

describe("wqFloor resolver integration (scrapeFloorFromResult)", function() {
  it("resolves a matched beach's advisory into the waterQualityAdvisory shape", function() {
    const html = kenoshaTable([
      ["Simmons Island Park", "1300 MPN/100mL", "CLOSED", "07/21/26"]
    ]);
    const rows = extractTableRows(html);
    const sites = parseKenoshaBeachConditions(rows, NOW_ISO);
    const result = {
      perBeach: true,
      sites: sites,
      source: KENOSHA_LABEL,
      sources: [KENOSHA_LABEL],
      updated: NOW_ISO
    };
    const beach = makeBeach({ name: "Simmons Island Park", lat: 42.6, lon: -87.795 });
    const advisory = scrapeFloorFromResult(beach, kenoshaBeachConditions, result);
    expect(advisory).not.toBe(null);
    expect(advisory.beachId).toBe(beach.id);
    expect(advisory.color).toBe("red");
    expect(advisory.reason).toBe("Kenosha County beach conditions: CLOSED (1300 MPN/100mL)");
    expect(advisory.source).toBe(KENOSHA_LABEL);
  });

  it("resolves to null for a beach with no matching site (e.g. OPEN reading -> no site emitted)", function() {
    const html = kenoshaTable([
      ["Alford Park", "10 MPN/100mL", "OPEN", "07/20/26"]
    ]);
    const rows = extractTableRows(html);
    const sites = parseKenoshaBeachConditions(rows, NOW_ISO);
    const result = {
      perBeach: true,
      sites: sites,
      source: KENOSHA_LABEL,
      sources: [KENOSHA_LABEL],
      updated: NOW_ISO
    };
    const beach = makeBeach({ name: "Alford Park", lat: 42.619, lon: -87.795 });
    const advisory = scrapeFloorFromResult(beach, kenoshaBeachConditions, result);
    expect(advisory).toBe(null);
  });
});
