// test/bldhd.test.js
import { describe, it, expect } from "vitest";
import {
  parseBldhdReportDate,
  parseBldhdHtml,
  bldhd,
  BLDHD_URL
} from "../src/officialSources/bldhd.js";
import { resolveSiteForBeach } from "../src/officialSources/index.js";

// Trimmed inline fixture modeled on the real bldhd.org/beach-monitoring/
// markup captured in the probe (docs/official-sources-verified.json /
// scratchpad probe HTML), reduced to the header + table only. Built with
// string concatenation, never backticks.
function buildFixture(reportDate, rows) {
  let rowsHtml = "";
  for (let i = 0; i < rows.length; i++) {
    rowsHtml = rowsHtml +
      "<tr style=\"height: 35px;\">\n" +
      "<td style=\"width: 63.0542%; height: 35px;\">" + rows[i].name + "</td>\n" +
      "<td style=\"width: 36.9458%; height: 35px;\">" + rows[i].levelCell + "</td>\n" +
      "</tr>\n";
  }
  return "<p><span data-contrast=\"none\">Test results from regularly scheduled beach " +
    "monitoring may be viewed on the </span><a href=\"https://www.egle.state.mi.us/beach/\">" +
    "<strong>EGLE Beach website</strong></a></p>\n" +
    "<p><strong>Beach Report " + reportDate + "-&nbsp;</strong></p>\n" +
    "<table border=\"1\" style=\"border-collapse: collapse; width: 57.9606%; height: 336px;\">\n" +
    "<tbody>\n" +
    rowsHtml +
    "</tbody>\n" +
    "</table>\n" +
    "<p><span><br /></span><iframe src=\"https://app.powerbigov.us/view?r=xyz\"></iframe></p>";
}

const TEN_LEVEL_ONE_ROWS = [
  { name: "Beulah Beach- Crystal Lake", levelCell: "Level 1&nbsp; &nbsp;&nbsp;" },
  { name: "Empire Beach", levelCell: "Level 1&nbsp; &nbsp;&nbsp;" },
  { name: "Frankfort Beach", levelCell: "Level 1&nbsp; &nbsp;&nbsp;" },
  { name: "Greilickville Harbor Park", levelCell: "Level 1&nbsp; &nbsp;" },
  { name: "Leland- Van's Beach", levelCell: "Level 1&nbsp; &nbsp;&nbsp;" },
  { name: "Northport Marina", levelCell: "Level 1&nbsp; &nbsp;&nbsp;" },
  { name: "Omena Beach", levelCell: "Level 1&nbsp; &nbsp;&nbsp;" },
  { name: "South Bar Lake", levelCell: "Level 1&nbsp; &nbsp;&nbsp;" },
  { name: "Suttons Bay Marina", levelCell: "Level 1&nbsp; &nbsp;&nbsp;" },
  { name: "Suttons Bay Park", levelCell: "Level 1&nbsp; &nbsp;&nbsp;" }
];

describe("parseBldhdReportDate", function() {
  it("parses the non-zero-padded M/D/YYYY header", function() {
    const html = buildFixture("7/2/2026", []);
    const result = parseBldhdReportDate(html);
    expect(result.raw).toBe("7/2/2026");
    expect(result.iso).toBe("2026-07-02T00:00:00Z");
  });

  it("returns null when the header is missing", function() {
    expect(parseBldhdReportDate("<p>no header here</p>")).toBe(null);
  });

  it("returns null for garbage input", function() {
    expect(parseBldhdReportDate("asdf;lkj !@#$ garbage")).toBe(null);
    expect(parseBldhdReportDate("")).toBe(null);
    expect(parseBldhdReportDate(null)).toBe(null);
  });
});

describe("parseBldhdHtml", function() {
  const NOW_ISO = "2026-07-05T12:00:00Z";

  it("parses all 10 real beach rows at Level 1 as green with the report date in the reason", function() {
    const html = buildFixture("7/2/2026", TEN_LEVEL_ONE_ROWS);
    const result = parseBldhdHtml(html, NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.perBeach).toBe(true);
    expect(result.source).toBe(BLDHD_URL);
    expect(result.sources).toEqual([BLDHD_URL]);
    // updated is the REPORT date, not nowIso, so the weekly cadence surfaces
    // honestly in the stale-data warning instead of always looking fresh.
    expect(result.updated).toBe("2026-07-02T00:00:00Z");
    expect(result.sites.length).toBe(10);
    for (const site of result.sites) {
      expect(site.color).toBe("green");
      expect(site.reason.indexOf("7/2/2026")).toBeGreaterThan(-1);
      expect(Array.isArray(site.names)).toBe(true);
      expect(site.names.length).toBeGreaterThan(0);
    }
    const siteIds = result.sites.map(function(s) { return s.siteId; });
    expect(siteIds.indexOf("beulah-crystal-lake")).toBeGreaterThan(-1);
    expect(siteIds.indexOf("vans-beach-leland")).toBeGreaterThan(-1);
    expect(siteIds.indexOf("suttons-bay-marina")).toBeGreaterThan(-1);
    expect(siteIds.indexOf("suttons-bay-park")).toBeGreaterThan(-1);
  });

  it("tolerates the confirmed &nbsp;-padding inconsistency (Greilickville has one fewer entity)", function() {
    const html = buildFixture("7/2/2026", [
      { name: "Greilickville Harbor Park", levelCell: "Level 1&nbsp; &nbsp;" }
    ]);
    const result = parseBldhdHtml(html, NOW_ISO);
    expect(result.sites.length).toBe(1);
    expect(result.sites[0].color).toBe("green");
    expect(result.sites[0].siteId).toBe("greilickville-harbor-park");
  });

  it("maps Level 2 to yellow per the confirmed BLDHD Water Quality Index legend", function() {
    // Level 2 = "contact above the waist not advised" -> yellow (advisory).
    const html = buildFixture("7/2/2026", [
      { name: "Frankfort Beach", levelCell: "Level 1&nbsp; &nbsp;&nbsp;" },
      { name: "Omena Beach", levelCell: "Level 2&nbsp; &nbsp;&nbsp;" }
    ]);
    const result = parseBldhdHtml(html, NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.sites.length).toBe(2);
    const frankfort = result.sites.filter(function(s) { return s.siteId === "frankfort-beach"; })[0];
    const omena = result.sites.filter(function(s) { return s.siteId === "omena-beach"; })[0];
    expect(frankfort.color).toBe("green");
    expect(omena.color).toBe("yellow");
    expect(omena.reason.indexOf("Level 2")).toBeGreaterThan(-1);
  });

  it("maps Level 3 to red per the confirmed legend (no body contact advised)", function() {
    const html = buildFixture("7/2/2026", [
      { name: "Northport Marina", levelCell: "Level 3&nbsp; &nbsp;&nbsp;" }
    ]);
    const result = parseBldhdHtml(html, NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.sites.length).toBe(1);
    expect(result.sites[0].siteId).toBe("northport-marina");
    expect(result.sites[0].color).toBe("red");
    expect(result.sites[0].reason.indexOf("Level 3")).toBeGreaterThan(-1);
  });

  it("maps Level 4 to double-red per the confirmed legend (Health Alert, avoid contact)", function() {
    const html = buildFixture("7/2/2026", [
      { name: "South Bar Lake", levelCell: "Level 4&nbsp; &nbsp;&nbsp;" }
    ]);
    const result = parseBldhdHtml(html, NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.sites.length).toBe(1);
    expect(result.sites[0].siteId).toBe("south-bar-lake");
    expect(result.sites[0].color).toBe("double-red");
    expect(result.sites[0].reason.indexOf("Level 4")).toBeGreaterThan(-1);
  });

  it("omits a Level outside the confirmed 1-4 legend rather than guessing", function() {
    // A future/unknown Level (e.g. 5) has no authoritative meaning.
    const html = buildFixture("7/2/2026", [
      { name: "Frankfort Beach", levelCell: "Level 1&nbsp; &nbsp;&nbsp;" },
      { name: "Suttons Bay Park", levelCell: "Level 5&nbsp; &nbsp;&nbsp;" }
    ]);
    const result = parseBldhdHtml(html, NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.sites.length).toBe(1);
    expect(result.sites[0].siteId).toBe("frankfort-beach");
  });

  it("returns null when every row is an out-of-legend level (no site survives)", function() {
    const html = buildFixture("7/2/2026", [
      { name: "South Bar Lake", levelCell: "Level 5&nbsp; &nbsp;&nbsp;" },
      { name: "Suttons Bay Park", levelCell: "Level 9&nbsp; &nbsp;&nbsp;" }
    ]);
    expect(parseBldhdHtml(html, NOW_ISO)).toBe(null);
  });

  it("returns null when the report header is more than 8 days older than nowIso (stale)", function() {
    const html = buildFixture("6/20/2026", TEN_LEVEL_ONE_ROWS);
    expect(parseBldhdHtml(html, "2026-07-05T12:00:00Z")).toBe(null);
  });

  it("accepts a report exactly at the freshness boundary", function() {
    const html = buildFixture("6/27/2026", TEN_LEVEL_ONE_ROWS);
    const result = parseBldhdHtml(html, "2026-07-05T00:00:00Z");
    expect(result).not.toBe(null);
  });

  it("refuses a report dated far in the future (year typo / abandoned page)", function() {
    // A wrong year would otherwise pass the one-sided '> STALE_DAYS' gate
    // forever and keep reporting Level 1 -> green indefinitely.
    const html = buildFixture("7/2/2027", TEN_LEVEL_ONE_ROWS);
    expect(parseBldhdHtml(html, "2026-07-05T12:00:00Z")).toBe(null);
  });

  it("tolerates a report dated within the small future slack (timezone edge)", function() {
    // Same-day report parsed as UTC midnight can sit slightly ahead of a
    // nowIso taken just after local midnight; that must still be accepted.
    const html = buildFixture("7/5/2026", TEN_LEVEL_ONE_ROWS);
    const result = parseBldhdHtml(html, "2026-07-04T23:30:00Z");
    expect(result).not.toBe(null);
    expect(result.sites.length).toBe(10);
  });

  it("returns null when the report header is missing entirely", function() {
    const html = "<p>Nothing to see here.</p><table><tbody><tr><td>Empire Beach</td>" +
      "<td>Level 1</td></tr></tbody></table>";
    expect(parseBldhdHtml(html, NOW_ISO)).toBe(null);
  });

  it("returns null for garbage input", function() {
    expect(parseBldhdHtml("!!! not html at all ???", NOW_ISO)).toBe(null);
    expect(parseBldhdHtml("", NOW_ISO)).toBe(null);
    expect(parseBldhdHtml(null, NOW_ISO)).toBe(null);
  });

  it("returns null when the header exists but no table follows it", function() {
    const html = "<p><strong>Beach Report 7/2/2026-&nbsp;</strong></p><p>no table here</p>";
    expect(parseBldhdHtml(html, NOW_ISO)).toBe(null);
  });

  it("stamps updated with the report date (not nowIso) so weekly staleness surfaces", function() {
    // Regression: a weekly source must not report updated=nowIso, which would
    // make every official green look freshly-updated and permanently suppress
    // the frontend's 2-hour stale-data warning.
    const html = buildFixture("7/2/2026", TEN_LEVEL_ONE_ROWS);
    const result = parseBldhdHtml(html, "2026-07-05T12:00:00Z");
    expect(result.updated).toBe("2026-07-02T00:00:00Z");
    expect(result.updated).not.toBe("2026-07-05T12:00:00Z");
  });

  it("skips unrecognized beach names without crashing", function() {
    const html = buildFixture("7/2/2026", [
      { name: "Some Unknown Beach Nobody Curated", levelCell: "Level 1&nbsp; &nbsp;&nbsp;" },
      { name: "Frankfort Beach", levelCell: "Level 1&nbsp; &nbsp;&nbsp;" }
    ]);
    const result = parseBldhdHtml(html, NOW_ISO);
    expect(result.sites.length).toBe(1);
    expect(result.sites[0].siteId).toBe("frankfort-beach");
  });
});

describe("bldhd.matches", function() {
  it("matches a beach inside the Benzie/Leelanau bounding box", function() {
    const beach = { id: "osm-node-1", name: "Frankfort Beach", park_name: null, lat: 44.6325, lon: -86.2358, nws_zone: null, nws_grid_url: null, osm_id: "node/1" };
    expect(bldhd.matches(beach)).toBe(true);
  });

  it("does not match a beach far outside the box (e.g. South Haven)", function() {
    const beach = { id: "osm-node-2", name: "South Haven South Beach", park_name: null, lat: 42.4, lon: -86.28, nws_zone: null, nws_grid_url: null, osm_id: "node/2" };
    expect(bldhd.matches(beach)).toBe(false);
  });
});

describe("bldhd site resolution safety", function() {
  const NOW_ISO = "2026-07-05T12:00:00Z";

  it("does NOT resolve a distant Crystal Lake beach to Beulah's green", function() {
    // Regression: "crystal lake" was an over-broad names[] substring. Crystal
    // Lake is a ~9-mile lake and BLDHD only samples the Beulah end, so a beach
    // elsewhere on the lake must not inherit Beulah's Level-1 green. It sits in
    // the matches() bbox but > 1.5 mi from every sampling point.
    const html = buildFixture("7/2/2026", TEN_LEVEL_ONE_ROWS);
    const result = parseBldhdHtml(html, NOW_ISO);
    const farCrystalLakeBeach = {
      id: "osm-node-9",
      name: "Crystal Lake Beach",
      park_name: null,
      lat: 44.655,
      lon: -86.16
    };
    expect(bldhd.matches(farCrystalLakeBeach)).toBe(true);
    expect(resolveSiteForBeach(farCrystalLakeBeach, result.sites)).toBe(null);
  });

  it("still resolves the actual Beulah beach by name", function() {
    const html = buildFixture("7/2/2026", TEN_LEVEL_ONE_ROWS);
    const result = parseBldhdHtml(html, NOW_ISO);
    const beulah = {
      id: "osm-node-10",
      name: "Beulah Beach",
      park_name: null,
      lat: 44.6336,
      lon: -86.0908
    };
    const site = resolveSiteForBeach(beulah, result.sites);
    expect(site).not.toBe(null);
    expect(site.siteId).toBe("beulah-crystal-lake");
    expect(site.color).toBe("green");
  });
});
