// test/wqFloor.test.js
// Unit tests for the raise-only water-quality floor registry
// (src/wqFloor/index.js). The registry now ships POPULATED with the curated
// per-region sources; these tests lock the source-object contract every
// registered source must satisfy and the resolver behavior (floorColor ->
// advisory shape, invalid-color rejection) shared across them, not any one
// source's parsing.
import { describe, it, expect } from "vitest";
import {
  wqFloorSources,
  findWqFloorSource,
  scrapeWqFloorFromResult,
  scrapeFloorFromResult
} from "../src/wqFloor/index.js";
import { makeBeach } from "./helpers/beach.js";

// A stand-in source used only for the source-parameter's .id/.label in logging;
// the resolver never calls its methods (it operates on an already-fetched
// result), so a minimal object is enough.
const STUB_SOURCE = { id: "stub-wq", label: "Stub Water-Quality Program" };

function perBeachResult(sites) {
  return {
    perBeach: true,
    sites: sites,
    source: "Stub Water-Quality Program",
    updated: "2026-07-22T12:00:00.000Z"
  };
}

describe("wqFloor registry", function() {
  it("ships a populated registry of contract-shaped sources", function() {
    expect(Array.isArray(wqFloorSources)).toBe(true);
    expect(wqFloorSources.length).toBeGreaterThan(0);
    wqFloorSources.forEach(function(s) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.label).toBe("string");
      expect(typeof s.matches).toBe("function");
      expect(typeof s.scrape).toBe("function");
    });
  });

  it("findWqFloorSource returns null when no source matches", function() {
    expect(findWqFloorSource(makeBeach({ name: "Anywhere Beach" }))).toBe(null);
  });

  it("exports scrapeFloorFromResult as an alias of scrapeWqFloorFromResult", function() {
    expect(scrapeFloorFromResult).toBe(scrapeWqFloorFromResult);
  });
});

describe("scrapeWqFloorFromResult", function() {
  it("resolves a matched site to the advisory shape estimateFlag consumes", function() {
    const beach = makeBeach({ name: "North Avenue Beach", lat: 41.9, lon: -87.6 });
    const result = perBeachResult([
      {
        siteId: "north-ave",
        floorColor: "red",
        names: ["north avenue"],
        reason: "E. coli exceedance advisory",
        updated: "2026-07-22T06:00:00.000Z"
      }
    ]);
    const advisory = scrapeWqFloorFromResult(beach, STUB_SOURCE, result);
    expect(advisory).toEqual({
      beachId: "osm-test",
      color: "red",
      reason: "E. coli exceedance advisory",
      source: "Stub Water-Quality Program",
      updated: "2026-07-22T06:00:00.000Z"
    });
  });

  it("maps the site floorColor onto the advisory .color field", function() {
    const beach = makeBeach({ name: "Ohio Street Beach" });
    const result = perBeachResult([
      { siteId: "ohio", floorColor: "yellow", names: ["ohio street"] }
    ]);
    const advisory = scrapeWqFloorFromResult(beach, STUB_SOURCE, result);
    expect(advisory.color).toBe("yellow");
    // default reason + result-level updated fallback
    expect(advisory.reason).toBe("active water-quality advisory");
    expect(advisory.updated).toBe("2026-07-22T12:00:00.000Z");
  });

  it("rejects an invalid floor color (green) with null, never a color", function() {
    const beach = makeBeach({ name: "Clean Beach", names: ["clean"] });
    const result = perBeachResult([
      { siteId: "clean", floorColor: "green", names: ["clean beach"] }
    ]);
    expect(scrapeWqFloorFromResult(beach, STUB_SOURCE, result)).toBe(null);
  });

  it("rejects double-red and unknown floor colors with null", function() {
    const beach = makeBeach({ name: "Some Beach", names: ["some"] });
    expect(scrapeWqFloorFromResult(beach, STUB_SOURCE, perBeachResult([
      { siteId: "s", floorColor: "double-red", names: ["some beach"] }
    ]))).toBe(null);
    expect(scrapeWqFloorFromResult(beach, STUB_SOURCE, perBeachResult([
      { siteId: "s", floorColor: "unknown", names: ["some beach"] }
    ]))).toBe(null);
  });

  it("returns null when no site resolves to the beach", function() {
    const beach = makeBeach({ name: "Unmatched Beach", lat: 10, lon: 10 });
    const result = perBeachResult([
      { siteId: "far", floorColor: "red", names: ["somewhere else"], lat: 40, lon: -80 }
    ]);
    expect(scrapeWqFloorFromResult(beach, STUB_SOURCE, result)).toBe(null);
  });

  it("returns null for a non-perBeach or falsy result (never throws)", function() {
    const beach = makeBeach({});
    expect(scrapeWqFloorFromResult(beach, STUB_SOURCE, null)).toBe(null);
    expect(scrapeWqFloorFromResult(beach, STUB_SOURCE, { perBeach: false })).toBe(null);
    expect(scrapeWqFloorFromResult(beach, STUB_SOURCE, { perBeach: true, sites: null })).toBe(null);
  });
});
