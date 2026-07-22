// test/nyOprhpBeachStatus.test.js
// Unit tests for the NY OPRHP Beach Status water-quality FLOOR source.
// Pure parsers only — no network. Project style: ES modules, NO template
// literals, string concat with +, function () {} callbacks.
import { describe, it, expect } from "vitest";
import {
  parseNyOprhpBeachStatus,
  mapStatusToFloor,
  parseSampledDate,
  nyOprhpBeachStatus,
  NY_OPRHP_LABEL
} from "../src/wqFloor/nyOprhpBeachStatus.js";
import { scrapeWqFloorFromResult, resolveSiteForBeach } from "../src/wqFloor/index.js";
import { perBeachResult } from "../src/officialSources/util.js";
import { makeBeach } from "./helpers/beach.js";

const NOW_ISO = "2026-07-21T12:00:00Z";

// Build a FeatureServer response object from a list of attribute objects.
function buildResponse(attrList) {
  const features = [];
  for (let i = 0; i < attrList.length; i++) {
    features.push({ attributes: attrList[i] });
  }
  return { features: features };
}

// A single beach feature's attributes with sensible defaults.
function feature(overrides) {
  const base = {
    StateParkBeach: "Hamlin Beach SP (Yanty Creek)",
    Beach_status: "Open",
    Status_Reason: null,
    Indicator_: "E.coli",
    Results: 5,
    Date_sampled: "13-Jul-26",
    Latitude: 43.362,
    Longitude: -77.947
  };
  const out = {};
  for (const k in base) {
    if (Object.prototype.hasOwnProperty.call(base, k)) {
      out[k] = base[k];
    }
  }
  if (overrides) {
    for (const k in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, k)) {
        out[k] = overrides[k];
      }
    }
  }
  return out;
}

describe("mapStatusToFloor", function() {
  it("maps Closed + Exceedance to a red floor", function() {
    const result = mapStatusToFloor(feature({
      StateParkBeach: "Evangola SP",
      Beach_status: "Closed",
      Status_Reason: "Exceedance",
      Indicator_: "E.coli"
    }));
    expect(result).not.toBe(null);
    expect(result.floorColor).toBe("red");
    expect(result.reason).toBe("Closed — Exceedance (E.coli)");
  });

  it("maps Closed + Harmful Algal Bloom to a red floor", function() {
    const result = mapStatusToFloor(feature({
      Beach_status: "Closed",
      Status_Reason: "Harmful Algal Bloom"
    }));
    expect(result).not.toBe(null);
    expect(result.floorColor).toBe("red");
  });

  it("maps Open with Advisory to a yellow floor", function() {
    const result = mapStatusToFloor(feature({
      Beach_status: "Open with Advisory",
      Status_Reason: "Exceedance"
    }));
    expect(result).not.toBe(null);
    expect(result.floorColor).toBe("yellow");
  });

  it("returns null for a plain Open reading", function() {
    expect(mapStatusToFloor(feature({ Beach_status: "Open", Status_Reason: null })))
      .toBe(null);
  });

  it("returns null for Reopened (clean after resample)", function() {
    expect(mapStatusToFloor(feature({
      Beach_status: "Reopened",
      Status_Reason: "Clear after resample"
    }))).toBe(null);
  });

  it("returns null for Off-Season", function() {
    expect(mapStatusToFloor(feature({ Beach_status: "Off-Season", Status_Reason: null })))
      .toBe(null);
  });

  it("does NOT floor a Closed with a non-water-quality reason", function() {
    expect(mapStatusToFloor(feature({
      Beach_status: "Closed",
      Status_Reason: "Off-Season"
    }))).toBe(null);
  });

  it("does NOT floor a Closed with a missing reason", function() {
    expect(mapStatusToFloor(feature({ Beach_status: "Closed", Status_Reason: null })))
      .toBe(null);
  });

  it("returns null for garbage input", function() {
    expect(mapStatusToFloor(null)).toBe(null);
    expect(mapStatusToFloor(undefined)).toBe(null);
    expect(mapStatusToFloor({})).toBe(null);
    expect(mapStatusToFloor({ Beach_status: 42 })).toBe(null);
  });
});

describe("parseSampledDate", function() {
  it("parses DD-Mon-YY to an ISO UTC-midnight string", function() {
    expect(parseSampledDate("13-Jul-26")).toBe("2026-07-13T00:00:00Z");
    expect(parseSampledDate("1-Jan-26")).toBe("2026-01-01T00:00:00Z");
    expect(parseSampledDate("09-Dec-25")).toBe("2025-12-09T00:00:00Z");
  });

  it("is case-insensitive on the month token", function() {
    expect(parseSampledDate("20-JUL-26")).toBe("2026-07-20T00:00:00Z");
    expect(parseSampledDate("20-jul-26")).toBe("2026-07-20T00:00:00Z");
  });

  it("returns null on an unrecognized shape", function() {
    expect(parseSampledDate("2026-07-13")).toBe(null);
    expect(parseSampledDate("13-Xyz-26")).toBe(null);
    expect(parseSampledDate("")).toBe(null);
    expect(parseSampledDate(null)).toBe(null);
    expect(parseSampledDate(undefined)).toBe(null);
    expect(parseSampledDate(20260713)).toBe(null);
  });
});

describe("parseNyOprhpBeachStatus", function() {
  it("emits a red site for a Great Lakes beach Closed on Exceedance", function() {
    const sites = parseNyOprhpBeachStatus(buildResponse([
      feature({
        StateParkBeach: "Evangola SP",
        Beach_status: "Closed",
        Status_Reason: "Exceedance",
        Date_sampled: "20-Jul-26"
      })
    ]), NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("evangola");
    expect(sites[0].floorColor).toBe("red");
    expect(sites[0].names).toContain("evangola");
    expect(sites[0].updated).toBe("2026-07-20T00:00:00Z");
  });

  it("emits a yellow site for Open with Advisory", function() {
    const sites = parseNyOprhpBeachStatus(buildResponse([
      feature({
        StateParkBeach: "Fair Haven Beach SP",
        Beach_status: "Open with Advisory",
        Status_Reason: "Exceedance"
      })
    ]), NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("fair-haven");
    expect(sites[0].floorColor).toBe("yellow");
  });

  it("returns an empty array when every Great Lakes beach is clean/open", function() {
    const sites = parseNyOprhpBeachStatus(buildResponse([
      feature({ StateParkBeach: "Hamlin Beach SP", Beach_status: "Open" }),
      feature({ StateParkBeach: "Evangola SP", Beach_status: "Reopened", Status_Reason: "Clear after resample" })
    ]), NOW_ISO);
    expect(sites).toEqual([]);
  });

  it("ignores non-Great-Lakes NY beaches entirely", function() {
    const sites = parseNyOprhpBeachStatus(buildResponse([
      feature({
        StateParkBeach: "Jones Beach SP Ocean - Central Mall",
        Beach_status: "Closed",
        Status_Reason: "Exceedance"
      }),
      feature({
        StateParkBeach: "Buttermilk Falls SP (Falls Swim Area)",
        Beach_status: "Closed",
        Status_Reason: "Exceedance"
      })
    ]), NOW_ISO);
    expect(sites).toEqual([]);
  });

  it("rolls multiple features for one park up to the MOST SEVERE floor", function() {
    const sites = parseNyOprhpBeachStatus(buildResponse([
      feature({ StateParkBeach: "Hamlin Beach SP (Yanty Creek)", Beach_status: "Open with Advisory", Status_Reason: "Exceedance" }),
      feature({ StateParkBeach: "Hamlin Beach SP (Devils Nose)", Beach_status: "Closed", Status_Reason: "Harmful Algal Bloom" }),
      feature({ StateParkBeach: "Hamlin Beach SP (Sandy)", Beach_status: "Open" })
    ]), NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("hamlin-beach");
    expect(sites[0].floorColor).toBe("red");
  });

  it("falls back to nowIso when Date_sampled is unparseable", function() {
    const sites = parseNyOprhpBeachStatus(buildResponse([
      feature({
        StateParkBeach: "Selkirk Shores SP",
        Beach_status: "Closed",
        Status_Reason: "Exceedance",
        Date_sampled: "garbage"
      })
    ]), NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].updated).toBe(NOW_ISO);
  });

  it("returns null when the features array is missing (schema change)", function() {
    expect(parseNyOprhpBeachStatus({ error: { code: 400 } }, NOW_ISO)).toBe(null);
    expect(parseNyOprhpBeachStatus({}, NOW_ISO)).toBe(null);
    expect(parseNyOprhpBeachStatus({ features: [] }, NOW_ISO)).toBe(null);
  });

  it("returns null for null / non-object / unparseable input", function() {
    expect(parseNyOprhpBeachStatus(null, NOW_ISO)).toBe(null);
    expect(parseNyOprhpBeachStatus(42, NOW_ISO)).toBe(null);
    expect(parseNyOprhpBeachStatus("<<not json>>", NOW_ISO)).toBe(null);
  });

  it("accepts a raw JSON string body", function() {
    const text = JSON.stringify(buildResponse([
      feature({ StateParkBeach: "Beaver Island SP", Beach_status: "Open with Advisory" })
    ]));
    const sites = parseNyOprhpBeachStatus(text, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("beaver-island");
  });

  it("skips malformed features without throwing", function() {
    const sites = parseNyOprhpBeachStatus({
      features: [
        null,
        { attributes: null },
        { attributes: { StateParkBeach: "" } },
        { attributes: feature({ StateParkBeach: "Evangola SP", Beach_status: "Closed", Status_Reason: "Exceedance" }) }
      ]
    }, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("evangola");
  });
});

describe("nyOprhpBeachStatus.matches", function() {
  it("matches a curated Great Lakes beach by name", function() {
    expect(nyOprhpBeachStatus.matches(makeBeach({
      name: "Evangola State Park Beach",
      park_name: "Evangola State Park",
      lat: 42.60, lon: -79.16
    }))).toBe(true);
  });

  it("matches by lat/lon proximity when the name does not", function() {
    expect(nyOprhpBeachStatus.matches(makeBeach({
      name: "The Swimming Area",
      park_name: "",
      lat: 43.362, lon: -77.948
    }))).toBe(true);
  });

  it("does not match an unrelated beach", function() {
    expect(nyOprhpBeachStatus.matches(makeBeach({
      name: "Ludington State Park Beach",
      park_name: "Ludington State Park",
      lat: 43.95, lon: -86.45
    }))).toBe(false);
  });
});

describe("scrapeWqFloorFromResult wiring (resolver contract)", function() {
  it("resolves a curated beach to the yellow/red advisory the estimate consumes", function() {
    const sites = parseNyOprhpBeachStatus(buildResponse([
      feature({
        StateParkBeach: "Evangola SP",
        Beach_status: "Closed",
        Status_Reason: "Exceedance",
        Date_sampled: "20-Jul-26"
      })
    ]), NOW_ISO);
    const result = perBeachResult(sites, "https://example/query", NOW_ISO);
    const beach = makeBeach({
      id: "osm-node-evangola",
      name: "Evangola State Park Beach",
      park_name: "Evangola State Park",
      lat: 42.601, lon: -79.160
    });
    const advisory = scrapeWqFloorFromResult(beach, nyOprhpBeachStatus, result);
    expect(advisory).not.toBe(null);
    expect(advisory.beachId).toBe("osm-node-evangola");
    expect(advisory.color).toBe("red");
    expect(advisory.reason).toBe("Closed — Exceedance (E.coli)");
    // result.source is a URL string, so the resolver falls back to source.label.
    expect(advisory.source).toBe(NY_OPRHP_LABEL);
    expect(advisory.updated).toBe("2026-07-20T00:00:00Z");
  });

  it("resolves to null for a beach with no advisory site", function() {
    const sites = parseNyOprhpBeachStatus(buildResponse([
      feature({ StateParkBeach: "Evangola SP", Beach_status: "Closed", Status_Reason: "Exceedance" })
    ]), NOW_ISO);
    const result = perBeachResult(sites, "https://example/query", NOW_ISO);
    const otherBeach = makeBeach({
      name: "Hamlin Beach",
      park_name: "Hamlin Beach State Park",
      lat: 43.362, lon: -77.947
    });
    expect(scrapeWqFloorFromResult(otherBeach, nyOprhpBeachStatus, result)).toBe(null);
  });

  it("resolveSiteForBeach picks the matching site by name", function() {
    const sites = parseNyOprhpBeachStatus(buildResponse([
      feature({ StateParkBeach: "Selkirk Shores SP", Beach_status: "Open with Advisory" })
    ]), NOW_ISO);
    const beach = makeBeach({
      name: "Selkirk Shores Beach",
      park_name: "Selkirk Shores State Park",
      lat: 43.535, lon: -76.203
    });
    const site = resolveSiteForBeach(beach, sites);
    expect(site).not.toBe(null);
    expect(site.siteId).toBe("selkirk-shores");
    expect(site.floorColor).toBe("yellow");
  });
});
