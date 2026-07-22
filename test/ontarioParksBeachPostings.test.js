// test/ontarioParksBeachPostings.test.js
// Pure-parser + pure-resolver unit tests for
// src/wqFloor/ontarioParksBeachPostings.js (KIND: wq raise-only water-quality
// floor). No network -- every case builds an inline HTML fixture mirroring
// the live-confirmed Ontario Parks "Beach Postings" table markup and
// exercises the exported pure functions directly.
// Project style: ES modules, no template literals, string concat with +,
// function () {} callbacks.

import { describe, it, expect } from "vitest";
import {
  parseOntarioParksBeachPostings,
  isPostedFromCell,
  buildOntarioParksSites,
  matchesOntarioParksCoverage,
  ontarioParksBeachPostings,
  SITE_DEFS,
  ONTARIO_PARKS_INFO_URL,
  ONTARIO_PARKS_LABEL,
  PARK_PAGES
} from "../src/wqFloor/ontarioParksBeachPostings.js";
import { resolveSiteForBeach } from "../src/officialSources/util.js";
import { scrapeWqFloorFromResult } from "../src/wqFloor/index.js";
import { makeBeach } from "./helpers/beach.js";

// Trimmed fixture mirroring the live-confirmed markup (curl-fetched
// 2026-07-22 from ontarioparks.ca/park/{sandbanks,presquile,rockpoint}/
// alerts): an h2 "Beach Postings" header, an explanatory <p>, a decoy
// unrelated table earlier in the page (to prove the parser scopes to the
// right <table>), and a <table> with a Beach Name / Sample Date / Posted
// header row followed by data rows.
function buildFixture(bodyRows) {
  const decoyTable =
    "<table id=\"UnrelatedNav\"><tr><th>Menu</th></tr>" +
    "<tr><td>Home</td></tr></table>";
  const section =
    "<section id=\"beaches\">" +
    "<h2 class=\"mt-5\">Beach Postings</h2>" +
    "<p>A \"posting\" is an indication of elevated bacteria levels in the water, not intended as an indication of operational status.</p>" +
    "<table class=\"table table-striped\">" +
    "<thead><tr><th>Beach Name</th><th>Sample Date</th><th class=\"text-center\">Posted</th></tr></thead>" +
    "<tbody>" + bodyRows.join("") + "</tbody>" +
    "</table></section>";
  return decoyTable + section;
}

function iconCell(filename) {
  return "<div style=\"display: flex; align-items: center; justify-content: center;\">" +
    "<img class=\"alert-icon-list-55\" src=\"/images/icons/alerts/" + filename + "\" alt=\"Beach Posting Results\"/>" +
    "</div>";
}

function row(beach, sampleDate, filename) {
  return "<tr>" +
    "<td>" + beach + "</td>" +
    "<td>" + sampleDate + "</td>" +
    "<td>" + iconCell(filename) + "</td>" +
    "</tr>";
}

describe("isPostedFromCell", function () {
  it("recognizes the confirmed not-posted icon filename", function () {
    expect(isPostedFromCell(iconCell("beach-posting-no.png"))).toBe(false);
  });

  it("recognizes the inferred posted icon filename", function () {
    expect(isPostedFromCell(iconCell("beach-posting-yes.png"))).toBe(true);
  });

  it("is case-insensitive on the filename", function () {
    expect(isPostedFromCell(iconCell("Beach-Posting-NO.png"))).toBe(false);
    expect(isPostedFromCell(iconCell("Beach-Posting-YES.png"))).toBe(true);
  });

  it("returns null for an unrecognized icon filename (fails closed)", function () {
    expect(isPostedFromCell(iconCell("beach-posting-unknown.png"))).toBe(null);
  });

  it("returns null when there is no img src at all", function () {
    expect(isPostedFromCell("<div>No image here</div>")).toBe(null);
  });

  it("returns null for null and empty-string input", function () {
    expect(isPostedFromCell(null)).toBe(null);
    expect(isPostedFromCell("")).toBe(null);
  });
});

describe("parseOntarioParksBeachPostings", function () {
  it("parses a clean single-beach table (Presqu'ile / Rock Point shape)", function () {
    const html = buildFixture([
      row("Presqu'ile Beach", "July 15, 2026", "beach-posting-no.png")
    ]);
    const rows = parseOntarioParksBeachPostings(html);
    expect(rows).not.toBe(null);
    expect(rows.length).toBe(1);
    expect(rows[0].beach).toBe("Presqu'ile Beach");
    expect(rows[0].sampleDate).toBe("July 15, 2026");
    expect(rows[0].posted).toBe(false);
  });

  it("parses a clean multi-beach table (Sandbanks shape)", function () {
    const html = buildFixture([
      row("Outlet Beach", "July 13, 2026", "beach-posting-no.png"),
      row("Dunes Beach", "July 20, 2026", "beach-posting-no.png"),
      row("Lakeshore Beach", "July 20, 2026", "beach-posting-no.png")
    ]);
    const rows = parseOntarioParksBeachPostings(html);
    expect(rows).not.toBe(null);
    expect(rows.length).toBe(3);
    expect(rows.map(function (r) { return r.beach; })).toEqual(["Outlet Beach", "Dunes Beach", "Lakeshore Beach"]);
  });

  it("parses a posted beach when the (inferred) posted icon is present", function () {
    const html = buildFixture([
      row("Rock Point Beach", "July 14, 2026", "beach-posting-yes.png")
    ]);
    const rows = parseOntarioParksBeachPostings(html);
    expect(rows).not.toBe(null);
    expect(rows[0].posted).toBe(true);
  });

  it("skips a row with an unrecognized posting icon without failing the whole parse", function () {
    const html = buildFixture([
      row("Outlet Beach", "July 13, 2026", "beach-posting-weird.png"),
      row("Dunes Beach", "July 20, 2026", "beach-posting-no.png")
    ]);
    const rows = parseOntarioParksBeachPostings(html);
    expect(rows).not.toBe(null);
    expect(rows.length).toBe(1);
    expect(rows[0].beach).toBe("Dunes Beach");
  });

  it("returns null when the Beach Postings section is entirely absent", function () {
    const html = "<table><tr><th>Something Else</th></tr><tr><td>irrelevant</td></tr></table>";
    expect(parseOntarioParksBeachPostings(html)).toBe(null);
  });

  it("returns null for null and empty-string input", function () {
    expect(parseOntarioParksBeachPostings(null)).toBe(null);
    expect(parseOntarioParksBeachPostings("")).toBe(null);
  });

  it("returns null for garbage input with no usable rows", function () {
    expect(parseOntarioParksBeachPostings("<<< not the expected format >>>")).toBe(null);
  });

  it("returns null when the header is present but the table yields zero rows", function () {
    const html = buildFixture([]);
    expect(parseOntarioParksBeachPostings(html)).toBe(null);
  });

  it("returns null when every row's icon is unrecognized", function () {
    const html = buildFixture([
      row("Outlet Beach", "July 13, 2026", "beach-posting-weird.png")
    ]);
    expect(parseOntarioParksBeachPostings(html)).toBe(null);
  });
});

describe("buildOntarioParksSites", function () {
  it("emits a yellow-floor site only for curated beaches with posted === true", function () {
    const rows = [
      { beach: "Outlet Beach", sampleDate: "July 13, 2026", posted: false },
      { beach: "Dunes Beach", sampleDate: "July 20, 2026", posted: true }
    ];
    const sites = buildOntarioParksSites(rows);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("sandbanks-dunes-beach");
    expect(sites[0].floorColor).toBe("yellow");
    expect(sites[0].names).toEqual(["dunes beach"]);
    expect(sites[0].reason.indexOf("July 20, 2026") !== -1).toBe(true);
  });

  it("never emits a site for a not-posted row", function () {
    const rows = [
      { beach: "Rock Point Beach", sampleDate: "July 14, 2026", posted: false }
    ];
    expect(buildOntarioParksSites(rows)).toEqual([]);
  });

  it("never emits a site for a beach outside the curated list", function () {
    const rows = [
      { beach: "Some Other Beach", sampleDate: "July 14, 2026", posted: true }
    ];
    expect(buildOntarioParksSites(rows)).toEqual([]);
  });

  it("returns [] for non-array input rather than throwing", function () {
    expect(buildOntarioParksSites(null)).toEqual([]);
    expect(buildOntarioParksSites(undefined)).toEqual([]);
  });

  it("resolves multiple posted beaches independently across parks", function () {
    const rows = [
      { beach: "Dunes Beach", sampleDate: "July 20, 2026", posted: true },
      { beach: "Rock Point Beach", sampleDate: "July 14, 2026", posted: true }
    ];
    const sites = buildOntarioParksSites(rows);
    const siteIds = sites.map(function (s) { return s.siteId; });
    expect(siteIds.sort()).toEqual(["rock-point-beach", "sandbanks-dunes-beach"]);
  });

  it("never emits a red or double-red floorColor", function () {
    const rows = [
      { beach: "Outlet Beach", sampleDate: "July 13, 2026", posted: true },
      { beach: "Presqu'ile Beach", sampleDate: "July 15, 2026", posted: true }
    ];
    const sites = buildOntarioParksSites(rows);
    for (let i = 0; i < sites.length; i++) {
      expect(sites[i].floorColor).toBe("yellow");
    }
  });
});

describe("matchesOntarioParksCoverage", function () {
  it("matches a curated beach by name", function () {
    expect(matchesOntarioParksCoverage(makeBeach({ name: "Outlet Beach" }))).toBe(true);
    expect(matchesOntarioParksCoverage(makeBeach({ name: "Dunes Beach" }))).toBe(true);
    expect(matchesOntarioParksCoverage(makeBeach({ name: "Rock Point Beach" }))).toBe(true);
    expect(matchesOntarioParksCoverage(makeBeach({ name: "Random Municipal Beach" }))).toBe(false);
  });

  it("matches by park_name substring", function () {
    expect(matchesOntarioParksCoverage(makeBeach({ name: "Main Beach", park_name: "Presqu'ile Beach Area" }))).toBe(true);
  });

  it("matches by proximity within a curated site's box when the name does not match", function () {
    expect(matchesOntarioParksCoverage(makeBeach({ name: "Unnamed Beach", lat: 43.9195, lon: -77.2419 }))).toBe(true);
  });

  it("does not match a beach far outside every curated site's box", function () {
    expect(matchesOntarioParksCoverage(makeBeach({ name: "Unnamed Beach", lat: 44.8, lon: -83.3 }))).toBe(false);
  });

  it("does not match an unrelated beach with no lat/lon", function () {
    expect(matchesOntarioParksCoverage(makeBeach({ name: "South Haven Beach", lat: undefined, lon: undefined }))).toBe(false);
  });

  it("handles missing/null beach input without throwing", function () {
    expect(matchesOntarioParksCoverage(null)).toBe(false);
    expect(matchesOntarioParksCoverage(undefined)).toBe(false);
  });
});

describe("ontarioParksBeachPostings source object shape", function () {
  it("exposes the locked wqFloor contract fields", function () {
    expect(ontarioParksBeachPostings.id).toBe("ontario-parks-beach-postings");
    expect(ontarioParksBeachPostings.label).toBe(ONTARIO_PARKS_LABEL);
    expect(ontarioParksBeachPostings.infoUrl).toBe(ONTARIO_PARKS_INFO_URL);
    expect(typeof ontarioParksBeachPostings.matches).toBe("function");
    expect(typeof ontarioParksBeachPostings.scrape).toBe("function");
  });

  it("curates exactly the three Sandbanks + Presqu'ile + Rock Point beaches", function () {
    const siteIds = SITE_DEFS.map(function (s) { return s.siteId; }).sort();
    expect(siteIds).toEqual([
      "presquile-beach",
      "rock-point-beach",
      "sandbanks-dunes-beach",
      "sandbanks-lakeshore-beach",
      "sandbanks-outlet-beach"
    ]);
  });

  it("declares the three curated park alert pages", function () {
    expect(PARK_PAGES.length).toBe(3);
    const parkIds = PARK_PAGES.map(function (p) { return p.parkId; }).sort();
    expect(parkIds).toEqual(["presquile", "rockpoint", "sandbanks"]);
  });

  it("every curated site's names[] round-trips through resolveSiteForBeach", function () {
    for (let i = 0; i < SITE_DEFS.length; i++) {
      const curated = SITE_DEFS[i];
      const beach = makeBeach({ name: curated.names[0] });
      const site = resolveSiteForBeach(beach, [
        { siteId: curated.siteId, floorColor: "yellow", names: curated.names }
      ]);
      expect(site).not.toBe(null);
      expect(site.siteId).toBe(curated.siteId);
    }
  });
});

describe("ontarioParksBeachPostings end-to-end through the wqFloor resolver", function () {
  it("resolves a posted advisory into the exact waterQualityAdvisory shape estimateFlag consumes", function () {
    const rows = [
      { beach: "Dunes Beach", sampleDate: "July 20, 2026", posted: true }
    ];
    const sites = buildOntarioParksSites(rows);
    const result = {
      perBeach: true,
      sites: sites,
      source: ONTARIO_PARKS_LABEL,
      sources: [PARK_PAGES[0].url],
      updated: "2026-07-22T12:00:00Z"
    };
    const beach = makeBeach({ name: "Dunes Beach" });
    const advisory = scrapeWqFloorFromResult(beach, ontarioParksBeachPostings, result);
    expect(advisory).not.toBe(null);
    expect(advisory.beachId).toBe(beach.id);
    expect(advisory.color).toBe("yellow");
    expect(advisory.source).toBe(ONTARIO_PARKS_LABEL);
    expect(advisory.updated).toBe("2026-07-22T12:00:00Z");
  });

  it("resolves to null when the beach has no posted advisory (clean/absent, never a wrong color)", function () {
    const rows = [
      { beach: "Dunes Beach", sampleDate: "July 20, 2026", posted: false }
    ];
    const sites = buildOntarioParksSites(rows);
    const result = {
      perBeach: true,
      sites: sites,
      source: ONTARIO_PARKS_LABEL,
      sources: [PARK_PAGES[0].url],
      updated: "2026-07-22T12:00:00Z"
    };
    const beach = makeBeach({ name: "Dunes Beach" });
    expect(scrapeWqFloorFromResult(beach, ontarioParksBeachPostings, result)).toBe(null);
  });

  it("resolves to null for a beach not covered by this source", function () {
    const rows = [
      { beach: "Dunes Beach", sampleDate: "July 20, 2026", posted: true }
    ];
    const sites = buildOntarioParksSites(rows);
    const result = {
      perBeach: true,
      sites: sites,
      source: ONTARIO_PARKS_LABEL,
      sources: [PARK_PAGES[0].url],
      updated: "2026-07-22T12:00:00Z"
    };
    const beach = makeBeach({ name: "Some Other Beach Entirely" });
    expect(scrapeWqFloorFromResult(beach, ontarioParksBeachPostings, result)).toBe(null);
  });
});

describe("ontarioParksBeachPostings.scrape - error isolation", function () {
  it("returns null (never throws) when every fetch fails", async function () {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function () {
      return Promise.reject(new Error("network disabled in test"));
    };
    try {
      const result = await ontarioParksBeachPostings.scrape("2026-07-22T12:00:00Z");
      expect(result).toBe(null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
