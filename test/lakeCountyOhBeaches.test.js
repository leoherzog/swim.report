// test/lakeCountyOhBeaches.test.js
// Pure-parser + pure-resolver unit tests for
// src/wqFloor/lakeCountyOhBeaches.js (KIND: wq raise-only water-quality
// floor). No network -- every case builds an inline HTML fixture and
// exercises the exported pure functions directly.
// Project style: ES modules, no template literals, string concat with +,
// function () {} callbacks.

import { describe, it, expect } from "vitest";
import {
  lakeCountyOhBeaches,
  extractStatusForBeach,
  floorColorForStatus,
  parseLakeCountyOhBeaches,
  isInLakeCountyBeachSeason,
  LAKE_COUNTY_BEACHES_URL,
  LAKE_COUNTY_LABEL
} from "../src/wqFloor/lakeCountyOhBeaches.js";

const NOW_ISO = "2026-07-21T12:00:00.000Z";

// Inline fixture builder mirroring the illinoisBeachGuard/evanstonStatusfy
// pattern: keep the fixed page chrome here, each test supplies only the
// meaningful prediction words.
function beachesPage(headlandsWord, fairportWord) {
  return "<html><body>" +
    "<h1>2026 Beach Water Quality Program</h1>" +
    "<p>Results for Tuesday, July 21, 2026</p>" +
    "<div>Headlands Beach State Park - Water Bacteria Quality Prediction: " +
    headlandsWord + "</div>" +
    "<div>Fairport Harbor Lakefront Park - Water Bacteria Quality Prediction: " +
    fairportWord + "</div>" +
    "</body></html>";
}

describe("extractStatusForBeach", function () {
  const headlandsDef = { names: ["headlands beach state park", "headlands beach"] };

  it("finds the prediction word anchored to the documented phrase", function () {
    const html = beachesPage("GOOD", "POOR");
    const text = html.replace(/<[^>]*>/g, " ");
    expect(extractStatusForBeach(text, headlandsDef)).toBe("good");
  });

  it("returns null when the beach name is absent", function () {
    const text = "Some unrelated page with no beach names at all.";
    expect(extractStatusForBeach(text, headlandsDef)).toBe(null);
  });

  it("returns null when the name is present but no prediction phrase follows", function () {
    const text = "Headlands Beach State Park is a lovely park with no data here.";
    expect(extractStatusForBeach(text, headlandsDef)).toBe(null);
  });

  it("does not leak a distant word into a name that lacks its own prediction phrase", function () {
    // "good" appears far past the 600-char window boundary relative to name.
    const filler = new Array(400).join("x ");
    const text = "Headlands Beach State Park " + filler + " Water Bacteria Quality Prediction: GOOD";
    expect(extractStatusForBeach(text, headlandsDef)).toBe(null);
  });

  it("returns null for null/empty input", function () {
    expect(extractStatusForBeach(null, headlandsDef)).toBe(null);
    expect(extractStatusForBeach("", headlandsDef)).toBe(null);
  });
});

describe("floorColorForStatus", function () {
  it("maps poor-class words to yellow", function () {
    expect(floorColorForStatus("poor")).toBe("yellow");
    expect(floorColorForStatus("POOR")).toBe("yellow");
    expect(floorColorForStatus("advisory")).toBe("yellow");
    expect(floorColorForStatus("unsafe")).toBe("yellow");
    expect(floorColorForStatus("closed")).toBe("yellow");
  });

  it("maps good-class words to null (no floor)", function () {
    expect(floorColorForStatus("good")).toBe(null);
    expect(floorColorForStatus("GOOD")).toBe(null);
    expect(floorColorForStatus("safe")).toBe(null);
    expect(floorColorForStatus("open")).toBe(null);
  });

  it("never emits red or double-red -- only yellow or null", function () {
    const words = ["poor", "advisory", "unsafe", "closed", "good", "safe", "open"];
    for (let i = 0; i < words.length; i++) {
      const color = floorColorForStatus(words[i]);
      expect(color === "yellow" || color === null).toBe(true);
    }
  });

  it("returns null for an unrecognized word (fails closed)", function () {
    expect(floorColorForStatus("fair")).toBe(null);
    expect(floorColorForStatus("unknown")).toBe(null);
  });

  it("returns null for null/empty input", function () {
    expect(floorColorForStatus(null)).toBe(null);
    expect(floorColorForStatus("")).toBe(null);
  });
});

describe("parseLakeCountyOhBeaches", function () {
  it("emits no sites when both beaches read GOOD (clean run)", function () {
    const html = beachesPage("GOOD", "GOOD");
    const sites = parseLakeCountyOhBeaches(html, NOW_ISO);
    expect(sites).toEqual([]);
  });

  it("emits a yellow site only for the POOR beach", function () {
    const html = beachesPage("GOOD", "POOR");
    const sites = parseLakeCountyOhBeaches(html, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("fairport-harbor-lakefront-park");
    expect(sites[0].floorColor).toBe("yellow");
    expect(sites[0].reason).toBe("Lake County GHD bacteria prediction: POOR");
    expect(sites[0].updated).toBe(NOW_ISO);
  });

  it("emits yellow sites for both beaches when both read POOR", function () {
    const html = beachesPage("POOR", "ADVISORY");
    const sites = parseLakeCountyOhBeaches(html, NOW_ISO);
    expect(sites.length).toBe(2);
    const ids = sites.map(function (s) { return s.siteId; });
    expect(ids.indexOf("headlands-beach-state-park") !== -1).toBe(true);
    expect(ids.indexOf("fairport-harbor-lakefront-park") !== -1).toBe(true);
  });

  it("never emits a red or double-red floorColor", function () {
    const html = beachesPage("POOR", "CLOSED");
    const sites = parseLakeCountyOhBeaches(html, NOW_ISO);
    for (let i = 0; i < sites.length; i++) {
      expect(sites[i].floorColor).toBe("yellow");
    }
  });

  it("returns null when neither curated beach name appears (unusable page)", function () {
    const html = "<html><body><p>Some other health district page entirely.</p></body></html>";
    expect(parseLakeCountyOhBeaches(html, NOW_ISO)).toBe(null);
  });

  it("returns null for null/empty input", function () {
    expect(parseLakeCountyOhBeaches(null, NOW_ISO)).toBe(null);
    expect(parseLakeCountyOhBeaches("", NOW_ISO)).toBe(null);
  });

  it("returns null (does not throw) on garbage input", function () {
    expect(parseLakeCountyOhBeaches("<<< not the expected format >>>", NOW_ISO)).toBe(null);
  });

  it("recognizes one named beach even if the other's status word is missing", function () {
    const html = "<html><body>" +
      "<div>Headlands Beach State Park - Water Bacteria Quality Prediction: POOR</div>" +
      "</body></html>";
    const sites = parseLakeCountyOhBeaches(html, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("headlands-beach-state-park");
  });
});

describe("isInLakeCountyBeachSeason", function () {
  it("is true during mid-summer", function () {
    expect(isInLakeCountyBeachSeason("2026-07-21T12:00:00.000Z")).toBe(true);
  });

  it("is false in winter", function () {
    expect(isInLakeCountyBeachSeason("2026-01-15T12:00:00.000Z")).toBe(false);
  });

  it("is false before Memorial Day", function () {
    // 2026 Memorial Day is Monday, May 25.
    expect(isInLakeCountyBeachSeason("2026-05-20T12:00:00.000Z")).toBe(false);
  });

  it("is true on Memorial Day itself", function () {
    expect(isInLakeCountyBeachSeason("2026-05-25T12:00:00.000Z")).toBe(true);
  });

  it("is true on Labor Day itself", function () {
    // 2026 Labor Day is Monday, September 7.
    expect(isInLakeCountyBeachSeason("2026-09-07T12:00:00.000Z")).toBe(true);
  });

  it("is false after Labor Day", function () {
    expect(isInLakeCountyBeachSeason("2026-09-10T12:00:00.000Z")).toBe(false);
  });

  it("fails closed to false for an unparseable timestamp", function () {
    expect(isInLakeCountyBeachSeason("not-a-date")).toBe(false);
    expect(isInLakeCountyBeachSeason(null)).toBe(false);
    expect(isInLakeCountyBeachSeason("")).toBe(false);
  });
});

describe("lakeCountyOhBeaches.matches", function () {
  it("matches by exact beach name", function () {
    expect(lakeCountyOhBeaches.matches({ name: "Headlands Beach State Park", lat: 0, lon: 0 })).toBe(true);
    expect(lakeCountyOhBeaches.matches({ name: "Fairport Harbor Lakefront Park", lat: 0, lon: 0 })).toBe(true);
  });

  it("matches by park_name", function () {
    expect(lakeCountyOhBeaches.matches({ name: "Main Beach", park_name: "Fairport Harbor Lakefront Park", lat: 0, lon: 0 })).toBe(true);
  });

  it("matches by proximity within the Lake County, OH box", function () {
    expect(lakeCountyOhBeaches.matches({ name: "Unnamed Beach", lat: 41.76, lon: -81.28 })).toBe(true);
  });

  it("does not match a beach far outside Lake County, OH", function () {
    expect(lakeCountyOhBeaches.matches({ name: "Unnamed Beach", lat: 44.8, lon: -83.3 })).toBe(false);
  });

  it("does not match a beach with no lat/lon and no matching name", function () {
    expect(lakeCountyOhBeaches.matches({ name: "Some Other Beach" })).toBe(false);
  });

  it("returns false for a falsy beach", function () {
    expect(lakeCountyOhBeaches.matches(null)).toBe(false);
  });
});

describe("lakeCountyOhBeaches object shape", function () {
  it("carries the expected id/label/infoUrl", function () {
    expect(lakeCountyOhBeaches.id).toBe("lake-county-oh-beaches");
    expect(lakeCountyOhBeaches.label).toBe(LAKE_COUNTY_LABEL);
    expect(lakeCountyOhBeaches.infoUrl).toBe(LAKE_COUNTY_BEACHES_URL);
  });

  it("exposes matches and scrape as functions", function () {
    expect(typeof lakeCountyOhBeaches.matches).toBe("function");
    expect(typeof lakeCountyOhBeaches.scrape).toBe("function");
  });
});

describe("lakeCountyOhBeaches.scrape - off-season", function () {
  it("returns a clean empty perBeach result without fetching, off-season", async function () {
    const result = await lakeCountyOhBeaches.scrape("2026-01-15T12:00:00.000Z");
    expect(result).not.toBe(null);
    expect(result.perBeach).toBe(true);
    expect(result.sites).toEqual([]);
    expect(result.source).toBe(LAKE_COUNTY_LABEL);
  });
});
