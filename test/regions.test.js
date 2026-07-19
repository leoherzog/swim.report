// test/regions.test.js
// Pure coverage for the North America discovery expansion rail (src/regions.js):
// REGIONS is a well-formed set of coastal bounding boxes tracing the Great Lakes
// shoreline, and pointInAnyRegion(lat, lon) is inclusive, true only for points
// inside some box, and fail-safe on non-finite / non-number inputs (false) so a
// garbage-coordinate row is never treated as in-region by the offline batch's
// reconciliation-delete scoping.

import { describe, it, expect } from "vitest";
import { REGIONS, pointInAnyRegion } from "../src/regions.js";

describe("REGIONS shape", function () {
  it("is a non-empty array", function () {
    expect(Array.isArray(REGIONS)).toBe(true);
    expect(REGIONS.length).toBeGreaterThan(0);
  });

  it("every entry has a name and a well-ordered bbox (minLon<maxLon, minLat<maxLat)", function () {
    for (let i = 0; i < REGIONS.length; i = i + 1) {
      const r = REGIONS[i];
      expect(typeof r.name).toBe("string");
      expect(r.name.length).toBeGreaterThan(0);
      const b = r.bbox;
      expect(typeof b.minLon).toBe("number");
      expect(typeof b.minLat).toBe("number");
      expect(typeof b.maxLon).toBe("number");
      expect(typeof b.maxLat).toBe("number");
      expect(b.minLon).toBeLessThan(b.maxLon);
      expect(b.minLat).toBeLessThan(b.maxLat);
    }
  });
});

describe("pointInAnyRegion — Great Lakes shore points are inside", function () {
  // Each verified against the actual REGIONS boxes read from src/regions.js.
  const insidePoints = [
    { name: "Warren Dunes MI (Lake Michigan)", lat: 41.9, lon: -86.6 },
    { name: "Chicago lakefront (Lake Michigan)", lat: 41.9, lon: -87.6 },
    { name: "Duluth MN (Lake Superior)", lat: 46.78, lon: -92.1 },
    { name: "Lake Erie western basin", lat: 41.7, lon: -82.0 },
    { name: "Lake Ontario south shore", lat: 43.5, lon: -77.5 }
  ];

  insidePoints.forEach(function (p) {
    it("returns true for " + p.name, function () {
      expect(pointInAnyRegion(p.lat, p.lon)).toBe(true);
    });
  });
});

describe("pointInAnyRegion — interior / off-lake points are outside", function () {
  const outsidePoints = [
    { name: "Denver CO (continental interior)", lat: 39.7, lon: -104.9 },
    { name: "mid-continent plains", lat: 45.0, lon: -100.0 },
    { name: "open Atlantic", lat: 40.0, lon: -70.0 }
  ];

  outsidePoints.forEach(function (p) {
    it("returns false for " + p.name, function () {
      expect(pointInAnyRegion(p.lat, p.lon)).toBe(false);
    });
  });
});

describe("pointInAnyRegion — non-finite / non-number inputs fail safe to false", function () {
  it("returns false for NaN coordinates", function () {
    expect(pointInAnyRegion(NaN, -86.6)).toBe(false);
    expect(pointInAnyRegion(41.9, NaN)).toBe(false);
    expect(pointInAnyRegion(NaN, NaN)).toBe(false);
  });

  it("returns false for undefined / null coordinates", function () {
    expect(pointInAnyRegion(undefined, -86.6)).toBe(false);
    expect(pointInAnyRegion(41.9, undefined)).toBe(false);
    expect(pointInAnyRegion(null, null)).toBe(false);
  });

  it("returns false for Infinity and non-number types", function () {
    expect(pointInAnyRegion(Infinity, -86.6)).toBe(false);
    expect(pointInAnyRegion(41.9, -Infinity)).toBe(false);
    expect(pointInAnyRegion("41.9", "-86.6")).toBe(false);
  });
});

describe("pointInAnyRegion — bounds are inclusive", function () {
  it("a point exactly on a box corner is inside", function () {
    const b = REGIONS[0].bbox;
    expect(pointInAnyRegion(b.minLat, b.minLon)).toBe(true);
    expect(pointInAnyRegion(b.maxLat, b.maxLon)).toBe(true);
  });
});
