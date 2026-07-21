// Tests for the remaining untested src/geo.js helpers: distanceMi (used by the
// router's distance sort) and metersToFeet (used by the Open-Meteo/GLOS wave
// clients). distanceKm and pointInGeometry already have coverage in
// test/glerl.test.js and test/eccc.test.js. Pure math, no mocks needed.

import { describe, it, expect } from "vitest";
import { distanceKm, distanceMi, metersToFeet } from "../src/geo.js";

// The mile-per-kilometre ratio geo.js carries over from the pre-consolidation
// copies (3958.8 mi radius paired with the 6371 km radius).
const MI_PER_KM = 3958.8 / 6371;

describe("distanceMi", function () {
  it("is distanceKm scaled by the 3958.8/6371 mile-per-km ratio", function () {
    const km = distanceKm(42.4, -86.29, 42.397, -86.331);
    const mi = distanceMi(42.4, -86.29, 42.397, -86.331);
    expect(mi).toBeCloseTo(km * MI_PER_KM, 12);
  });

  it("returns ~2.10 mi for the ~3.38 km South Haven sample pair", function () {
    // Sanity-anchor the actual magnitude, not just the km/mi relationship:
    // (42.4, -86.29) -> (42.397, -86.331) is ~3.383 km along the shore.
    expect(distanceKm(42.4, -86.29, 42.397, -86.331)).toBeCloseTo(3.383, 3);
    expect(distanceMi(42.4, -86.29, 42.397, -86.331)).toBeCloseTo(2.102, 3);
  });

  it("returns 0 for identical points", function () {
    expect(distanceMi(42.4, -86.29, 42.4, -86.29)).toBe(0);
  });

  it("is symmetric in its endpoints", function () {
    const there = distanceMi(41.9, -87.6, 43.05, -86.25);
    const back = distanceMi(43.05, -86.25, 41.9, -87.6);
    expect(there).toBeCloseTo(back, 12);
    expect(there).toBeGreaterThan(0);
  });
});

describe("metersToFeet", function () {
  it("converts using the 3.28084 ft-per-metre factor", function () {
    expect(metersToFeet(1)).toBe(3.28084);
    expect(metersToFeet(2)).toBeCloseTo(6.56168, 10);
    expect(metersToFeet(0.5)).toBeCloseTo(1.64042, 10);
  });

  it("returns 0 for 0 (a real flat-calm reading, not masked data)", function () {
    expect(metersToFeet(0)).toBe(0);
  });

  it("passes null through as null (masked/no-data convention)", function () {
    // The wave clients rely on this to propagate Open-Meteo/GLOS masked
    // cells without fabricating 0 ft waves.
    expect(metersToFeet(null)).toBeNull();
  });

  it("passes undefined through as null (masked/no-data convention)", function () {
    expect(metersToFeet(undefined)).toBeNull();
  });
});
