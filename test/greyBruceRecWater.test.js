// test/greyBruceRecWater.test.js
import { describe, it, expect } from "vitest";
import {
  parseGreyBruceRecWaterTable,
  normalizePosted,
  parseTestedDate,
  buildGreyBruceSites,
  matchesGreyBruceCoverage,
  greyBruceRecWater,
  GREY_BRUCE_REC_WATER_URL,
  GREY_BRUCE_REC_WATER_LABEL,
  LAKE_HURON_SITES
} from "../src/wqFloor/greyBruceRecWater.js";
import { resolveSiteForBeach } from "../src/officialSources/util.js";
import { scrapeWqFloorFromResult } from "../src/wqFloor/index.js";
import { makeBeach } from "./helpers/beach.js";

const NOW = "2026-07-10T12:00:00Z";

// Trimmed fixture mirroring the observed GridView-style sortable table: a
// header row using "Public Beach" as the anchor cell, several Lake Huron rows
// (one posted, several passing/not-posted), a Georgian Bay row that is out of
// this module's curated scope, and a decoy unrelated table earlier in the
// page to prove the parser scopes to the right <table>.
function buildFixture(bodyRows) {
  const decoyTable =
    "<table id=\"UnrelatedNav\"><tr><th>Menu</th></tr>" +
    "<tr><td>Home</td></tr></table>";
  const header =
    "<table>" +
    "<tr>" +
    "<th><a href=\"javascript:__doPostBack('grid','Sort$Beach')\">Public Beach</a></th>" +
    "<th>Location</th><th>Test Result</th><th>Date Tested</th>" +
    "<th>Posted</th><th>Note</th>" +
    "</tr>";
  const footer = "</table>";
  return decoyTable + header + bodyRows.join("") + footer;
}

function row(beach, location, testResult, dateTested, posted, note) {
  return "<tr>" +
    "<td>" + beach + "</td>" +
    "<td>" + location + "</td>" +
    "<td>" + testResult + "</td>" +
    "<td>" + dateTested + "</td>" +
    "<td>" + posted + "</td>" +
    "<td>" + (note || "") + "</td>" +
    "</tr>";
}

describe("parseGreyBruceRecWaterTable", function () {
  it("parses a clean multi-row table, skipping the header and unrelated table", function () {
    const html = buildFixture([
      row("Station Park Beach", "Kincardine", "Pass", "6/17/2026", "No"),
      row("Sauble Beach North", "Sauble Beach", "Elevated E. coli", "7/6/2026", "Yes", "Posted advisory")
    ]);
    const rows = parseGreyBruceRecWaterTable(html);
    expect(rows).not.toBe(null);
    expect(rows.length).toBe(2);
    expect(rows[0].beach).toBe("Station Park Beach");
    expect(rows[0].posted).toBe("No");
    expect(rows[1].beach).toBe("Sauble Beach North");
    expect(rows[1].posted).toBe("Yes");
    expect(rows[1].note).toBe("Posted advisory");
  });

  it("decodes HTML entities in cell text", function () {
    const html = buildFixture([
      row("Port Elgin Gobles Grove", "Port Elgin", "Pass", "6/22/2026", "No", "Sand&amp;surf note")
    ]);
    const rows = parseGreyBruceRecWaterTable(html);
    expect(rows).not.toBe(null);
    expect(rows[0].note).toBe("Sand&surf note");
  });

  it("returns null when the Public Beach header is entirely absent", function () {
    const html = "<table><tr><th>Something Else</th></tr>" +
      "<tr><td>irrelevant</td></tr></table>";
    expect(parseGreyBruceRecWaterTable(html)).toBe(null);
  });

  it("returns null for null and empty-string input", function () {
    expect(parseGreyBruceRecWaterTable(null)).toBe(null);
    expect(parseGreyBruceRecWaterTable("")).toBe(null);
  });

  it("returns null for garbage input with no usable rows", function () {
    expect(parseGreyBruceRecWaterTable("<<< not the expected format >>>")).toBe(null);
  });

  it("returns null when the table has a header but zero data rows", function () {
    const html = buildFixture([]);
    expect(parseGreyBruceRecWaterTable(html)).toBe(null);
  });

  it("skips a malformed row (too few cells) without failing the whole parse", function () {
    const html = buildFixture([
      "<tr><td>Truncated Beach</td><td>Somewhere</td></tr>",
      row("Southampton Beach", "Southampton", "Pass", "7/1/2026", "No")
    ]);
    const rows = parseGreyBruceRecWaterTable(html);
    expect(rows).not.toBe(null);
    expect(rows.length).toBe(1);
    expect(rows[0].beach).toBe("Southampton Beach");
  });
});

describe("parseGreyBruceRecWaterTable header validation", function () {
  const gridRows =
    row("Point Clark Beach", "Huron-Kinloss", "Pass", "8/18/2026", "No") +
    row("Kelso Beach", "Owen Sound", "Fail", "8/27/2026", "Yes");

  it("finds the grid past intro prose that also says Public Beaches", function () {
    const html =
      "<p>Public beaches and other recreational water facilities are tested</p>" +
      "<h2>Public Beaches</h2>" +
      "<table id=\"Decoy\"><tr><th>Menu</th></tr><tr><td>Home</td></tr></table>" +
      "<table><tr><th>Public Beach</th><th>Location</th><th>Test Result</th>" +
      "<th>Date Tested</th><th>Posted</th><th>Note</th></tr>" + gridRows + "</table>";
    const rows = parseGreyBruceRecWaterTable(html);
    expect(rows).not.toBe(null);
    expect(rows.length).toBe(2);
    expect(rows[0].beach).toBe("Point Clark Beach");
  });

  it("parses the live DNN GridView markup", function () {
    function th(label) {
      return "<th scope=\"col\"><a href=\"javascript:__doPostBack(&#39;dnn$ctr1259$Default$List$grdData&#39;,&#39;Sort$" +
        label + "|ASC&#39;)\">" + label + "</a></th>";
    }
    const html =
      "<p>Public beaches and other recreational water facilities are tested</p>" +
      "<table class=\"dnnGrid\" id=\"dnn_ctr1259_Default_List_grdData\">" +
      "<tr class=\"dnnGridHeader\">" + th("Public Beach") + th("Location") + th("Test Result") +
      th("Date Tested") + th("Posted") + th("Note") + "</tr>" +
      "<tr class=\"dnnGridItem\"><td>Kelso Beach </td><td>Owen Sound</td><td>Fail</td>" +
      "<td align=\"right\">8/27/2026</td><td>Yes</td><td>&nbsp;</td></tr>" +
      "<tr class=\"dnnGridAltItem\"><td>Point Clark Beach</td><td>Huron-Kinloss</td><td>Pass</td>" +
      "<td align=\"right\">8/18/2026</td><td>No</td><td>&nbsp;</td></tr>" +
      "</table>";
    const rows = parseGreyBruceRecWaterTable(html);
    expect(rows).not.toBe(null);
    expect(rows.length).toBe(2);
    expect(rows[0].beach).toBe("Kelso Beach");
    expect(rows[0].dateTested).toBe("8/27/2026");
    expect(rows[0].note).toBe("");
    expect(rows[1].posted).toBe("No");
  });

  it("returns null when Test Result and Posted columns are swapped", function () {
    const html = "<table><tr><th>Public Beach</th><th>Location</th><th>Posted</th>" +
      "<th>Date Tested</th><th>Test Result</th><th>Note</th></tr>" + gridRows + "</table>";
    expect(parseGreyBruceRecWaterTable(html)).toBe(null);
  });

  it("returns null when the only table lacks a Posted header", function () {
    const html = "<table><tr><th>Public Beach</th><th>Location</th><th>Test Result</th>" +
      "<th>Date Tested</th><th>Note</th></tr>" + gridRows + "</table>";
    expect(parseGreyBruceRecWaterTable(html)).toBe(null);
  });
});

describe("parseTestedDate", function () {
  it("parses M/D/YYYY to UTC midnight", function () {
    expect(parseTestedDate("8/18/2026")).toBe(Date.UTC(2026, 7, 18));
    expect(parseTestedDate(" 12/1/2026 ")).toBe(Date.UTC(2026, 11, 1));
  });

  it("rejects a day that rolls over into the next month", function () {
    expect(parseTestedDate("2/31/2026")).toBe(null);
    expect(parseTestedDate("13/1/2026")).toBe(null);
  });

  it("rejects garbage", function () {
    expect(parseTestedDate("Aug 18")).toBe(null);
    expect(parseTestedDate("")).toBe(null);
    expect(parseTestedDate(null)).toBe(null);
    expect(parseTestedDate("2026-08-18")).toBe(null);
  });
});

describe("buildGreyBruceSites sample age gate", function () {
  function postedRow(dateTested) {
    return [{ beach: "Point Clark Beach", location: "Huron-Kinloss", testResult: "Fail", dateTested: dateTested, posted: "Yes", note: "" }];
  }

  it("drops a posted row sampled more than 35 days before now", function () {
    expect(buildGreyBruceSites(postedRow("8/18/2026"), "2026-09-22T12:00:00Z")).toEqual([]);
  });

  it("keeps the same row within 35 days", function () {
    const sites = buildGreyBruceSites(postedRow("8/18/2026"), "2026-08-25T12:00:00Z");
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("point-clark-beach");
    expect(sites[0].floorColor).toBe("yellow");
  });

  it("drops a posted row with an empty, unparseable or impossible date", function () {
    expect(buildGreyBruceSites(postedRow(""), "2026-08-25T12:00:00Z")).toEqual([]);
    expect(buildGreyBruceSites(postedRow("Aug 18"), "2026-08-25T12:00:00Z")).toEqual([]);
    expect(buildGreyBruceSites(postedRow("2/31/2026"), "2026-03-05T12:00:00Z")).toEqual([]);
  });

  it("drops a posted row dated in the future", function () {
    expect(buildGreyBruceSites(postedRow("8/25/2026"), "2026-08-18T12:00:00Z")).toEqual([]);
  });

  it("returns [] for an invalid nowIso", function () {
    expect(buildGreyBruceSites(postedRow("8/18/2026"), "not a date")).toEqual([]);
    expect(buildGreyBruceSites(postedRow("8/18/2026"), undefined)).toEqual([]);
  });
});

describe("normalizePosted", function () {
  it("maps Yes/No case-insensitively", function () {
    expect(normalizePosted("Yes")).toBe(true);
    expect(normalizePosted("yes")).toBe(true);
    expect(normalizePosted("No")).toBe(false);
    expect(normalizePosted("no")).toBe(false);
  });

  it("returns null for unrecognized or non-string values", function () {
    expect(normalizePosted("")).toBe(null);
    expect(normalizePosted("Pending")).toBe(null);
    expect(normalizePosted(null)).toBe(null);
    expect(normalizePosted(undefined)).toBe(null);
    expect(normalizePosted(1)).toBe(null);
  });
});

describe("buildGreyBruceSites", function () {
  it("emits a yellow-floor site only for curated beaches with Posted === Yes", function () {
    const rows = [
      { beach: "Station Park Beach", location: "Kincardine", testResult: "Pass", dateTested: "6/17/2026", posted: "No", note: "" },
      { beach: "Sauble Beach North", location: "Sauble Beach", testResult: "Elevated E. coli", dateTested: "7/6/2026", posted: "Yes", note: "" }
    ];
    const sites = buildGreyBruceSites(rows, NOW);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("sauble-beach-north");
    expect(sites[0].floorColor).toBe("yellow");
    expect(sites[0].names).toEqual(["sauble beach north"]);
    expect(sites[0].reason.indexOf("Elevated E. coli") !== -1).toBe(true);
    expect(sites[0].reason.indexOf("7/6/2026") !== -1).toBe(true);
  });

  it("never emits a site for a Pass / not-posted row", function () {
    const rows = [
      { beach: "Sauble Beach North", location: "Sauble Beach", testResult: "Pass", dateTested: "7/6/2026", posted: "No", note: "" }
    ];
    expect(buildGreyBruceSites(rows, NOW)).toEqual([]);
  });

  it("never emits a site for a beach outside the curated Lake Huron list", function () {
    const rows = [
      { beach: "Wiarton Beach", location: "Wiarton", testResult: "Elevated E. coli", dateTested: "7/1/2026", posted: "Yes", note: "" }
    ];
    expect(buildGreyBruceSites(rows, NOW)).toEqual([]);
  });

  it("never emits a site when Posted is unrecognized garbage", function () {
    const rows = [
      { beach: "Southampton Beach", location: "Southampton", testResult: "Pass", dateTested: "7/1/2026", posted: "Maybe", note: "" }
    ];
    expect(buildGreyBruceSites(rows, NOW)).toEqual([]);
  });

  it("returns [] for non-array input rather than throwing", function () {
    expect(buildGreyBruceSites(null)).toEqual([]);
    expect(buildGreyBruceSites(undefined)).toEqual([]);
  });

  it("resolves multiple posted beaches independently", function () {
    const rows = [
      { beach: "Sauble Beach North", location: "Sauble Beach", testResult: "Elevated E. coli", dateTested: "7/6/2026", posted: "Yes", note: "" },
      { beach: "Point Clark Beach", location: "Point Clark", testResult: "Elevated E. coli", dateTested: "7/6/2026", posted: "Yes", note: "" }
    ];
    const sites = buildGreyBruceSites(rows, NOW);
    const siteIds = sites.map(function (s) { return s.siteId; });
    expect(siteIds.sort()).toEqual(["point-clark-beach", "sauble-beach-north"]);
  });
});

describe("matchesGreyBruceCoverage", function () {
  it("matches a curated Lake Huron beach by name", function () {
    expect(matchesGreyBruceCoverage(makeBeach({ name: "Sauble Beach North" }))).toBe(true);
    expect(matchesGreyBruceCoverage(makeBeach({ name: "Random Municipal Beach" }))).toBe(false);
    expect(matchesGreyBruceCoverage(makeBeach({ name: "Station Park Beach" }))).toBe(true);
  });

  it("does not match an unrelated beach", function () {
    expect(matchesGreyBruceCoverage(makeBeach({ name: "South Haven Beach" }))).toBe(false);
  });

  it("handles missing/null beach input without throwing", function () {
    expect(matchesGreyBruceCoverage(null)).toBe(false);
    expect(matchesGreyBruceCoverage(undefined)).toBe(false);
  });
});

describe("greyBruceRecWater source object shape", function () {
  it("exposes the locked wqFloor contract fields", function () {
    expect(greyBruceRecWater.id).toBe("grey-bruce-rec-water");
    expect(greyBruceRecWater.label).toBe(GREY_BRUCE_REC_WATER_LABEL);
    expect(greyBruceRecWater.infoUrl).toBe(GREY_BRUCE_REC_WATER_URL);
    expect(typeof greyBruceRecWater.matches).toBe("function");
    expect(typeof greyBruceRecWater.scrape).toBe("function");
  });

  it("every curated site's names[] round-trips through resolveSiteForBeach", function () {
    for (let i = 0; i < LAKE_HURON_SITES.length; i++) {
      const curated = LAKE_HURON_SITES[i];
      const beach = makeBeach({ name: curated.names[0] });
      const site = resolveSiteForBeach(beach, [
        { siteId: curated.siteId, floorColor: "yellow", names: curated.names }
      ]);
      expect(site).not.toBe(null);
      expect(site.siteId).toBe(curated.siteId);
    }
  });
});

describe("greyBruceRecWater end-to-end through the wqFloor resolver", function () {
  it("resolves a posted advisory into the exact waterQualityAdvisory shape estimateFlag consumes", function () {
    const rows = [
      { beach: "Sauble Beach North", location: "Sauble Beach", testResult: "Elevated E. coli", dateTested: "7/6/2026", posted: "Yes", note: "" }
    ];
    const sites = buildGreyBruceSites(rows, NOW);
    const result = { perBeach: true, sites: sites, source: GREY_BRUCE_REC_WATER_URL, sources: [GREY_BRUCE_REC_WATER_URL], updated: "2026-07-21T12:00:00Z" };
    const beach = makeBeach({ name: "Sauble Beach North" });
    const advisory = scrapeWqFloorFromResult(beach, greyBruceRecWater, result);
    expect(advisory).not.toBe(null);
    expect(advisory.beachId).toBe(beach.id);
    expect(advisory.color).toBe("yellow");
    expect(advisory.source).toBe(GREY_BRUCE_REC_WATER_LABEL);
    expect(advisory.updated).toBe("2026-07-21T12:00:00Z");
  });

  it("resolves to null when the beach has no posted advisory (clean/absent, never a wrong color)", function () {
    const rows = [
      { beach: "Sauble Beach North", location: "Sauble Beach", testResult: "Pass", dateTested: "7/6/2026", posted: "No", note: "" }
    ];
    const sites = buildGreyBruceSites(rows, NOW);
    const result = { perBeach: true, sites: sites, source: GREY_BRUCE_REC_WATER_URL, sources: [GREY_BRUCE_REC_WATER_URL], updated: "2026-07-21T12:00:00Z" };
    const beach = makeBeach({ name: "Sauble Beach North" });
    expect(scrapeWqFloorFromResult(beach, greyBruceRecWater, result)).toBe(null);
  });

  it("resolves to null for a beach not covered by this source", function () {
    const rows = [
      { beach: "Sauble Beach North", location: "Sauble Beach", testResult: "Elevated E. coli", dateTested: "7/6/2026", posted: "Yes", note: "" }
    ];
    const sites = buildGreyBruceSites(rows, NOW);
    const result = { perBeach: true, sites: sites, source: GREY_BRUCE_REC_WATER_URL, sources: [GREY_BRUCE_REC_WATER_URL], updated: "2026-07-21T12:00:00Z" };
    const beach = makeBeach({ name: "Some Other Beach Entirely" });
    expect(scrapeWqFloorFromResult(beach, greyBruceRecWater, result)).toBe(null);
  });
});
