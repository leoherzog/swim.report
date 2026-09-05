// test/regions.test.js
// Pure coverage for the discovery scope (src/regions.js): REGIONS is a
// well-formed set of coastal bounding boxes over the Great Lakes and the US and
// Canadian ocean coasts, and pointInAnyRegion(lat, lon) is inclusive, true only for points
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

  it("names are unique, since the floors file and the manifest key per-region counts by name", function () {
    const seen = new Set();
    for (let i = 0; i < REGIONS.length; i = i + 1) {
      expect(seen.has(REGIONS[i].name)).toBe(false);
      seen.add(REGIONS[i].name);
    }
  });

  it("no box crosses the antimeridian: src/layerGrid.js has no longitude wrap", function () {
    for (let i = 0; i < REGIONS.length; i = i + 1) {
      const b = REGIONS[i].bbox;
      expect(b.minLon).toBeGreaterThanOrEqual(-180);
      expect(b.maxLon).toBeLessThanOrEqual(180);
    }
  });
});

describe("pointInAnyRegion — ocean coast shore points are inside", function () {
  const insidePoints = [
    { name: "Coronado CA (Southern California)", lat: 32.68, lon: -117.18 },
    { name: "Santa Cruz CA (Central California)", lat: 36.96, lon: -122.02 },
    { name: "Cannon Beach OR", lat: 45.89, lon: -123.96 },
    { name: "Alki Beach, Seattle WA (Puget Sound)", lat: 47.58, lon: -122.41 },
    { name: "Kitsilano, Vancouver BC", lat: 49.27, lon: -123.15 },
    { name: "Tofino BC", lat: 49.15, lon: -125.9 },
    { name: "Prince Rupert BC", lat: 54.31, lon: -130.32 },
    { name: "Juneau AK", lat: 58.3, lon: -134.42 },
    { name: "Homer Spit AK", lat: 59.6, lon: -151.42 },
    { name: "Unalaska AK", lat: 53.87, lon: -166.54 },
    { name: "Nome AK", lat: 64.5, lon: -165.4 },
    { name: "Waikiki HI", lat: 21.28, lon: -157.83 },
    { name: "South Padre Island TX", lat: 26.1, lon: -97.17 },
    { name: "Grand Isle LA", lat: 29.24, lon: -90.0 },
    { name: "Gulf Shores AL", lat: 30.25, lon: -87.7 },
    { name: "Destin FL (Panhandle)", lat: 30.39, lon: -86.5 },
    { name: "Key West FL", lat: 24.56, lon: -81.78 },
    { name: "Clearwater Beach FL", lat: 27.97, lon: -82.83 },
    { name: "Tybee Island GA", lat: 32.0, lon: -80.85 },
    { name: "Cape Hatteras NC", lat: 35.25, lon: -75.53 },
    { name: "Ocean City MD", lat: 38.34, lon: -75.08 },
    { name: "Sandy Point, Chesapeake Bay MD", lat: 39.01, lon: -76.4 },
    { name: "Coney Island NY", lat: 40.57, lon: -73.98 },
    { name: "Nauset Beach, Cape Cod MA", lat: 41.81, lon: -69.93 },
    { name: "Old Orchard Beach ME", lat: 43.52, lon: -70.38 },
    { name: "Cavendish Beach PEI", lat: 46.5, lon: -63.4 },
    { name: "Lawrencetown Beach NS", lat: 44.64, lon: -63.35 },
    { name: "Percé QC (Gaspé)", lat: 48.52, lon: -64.21 },
    { name: "Sept-Îles QC", lat: 50.2, lon: -66.38 },
    { name: "Topsail Beach NL", lat: 47.53, lon: -52.93 },
    { name: "Luquillo PR", lat: 18.38, lon: -65.72 }
  ];

  insidePoints.forEach(function (p) {
    it("returns true for " + p.name, function () {
      expect(pointInAnyRegion(p.lat, p.lon)).toBe(true);
    });
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
    { name: "Kansas City MO (continental interior)", lat: 39.1, lon: -94.6 },
    { name: "Atlanta GA (inland of the Georgia coast box)", lat: 33.75, lon: -84.39 },
    { name: "Sacramento CA (inland of the Central California box)", lat: 38.58, lon: -121.49 },
    { name: "Cancún MX (Mexico is out of scope)", lat: 21.16, lon: -86.85 },
    { name: "Goose Bay NL (Labrador is out of scope)", lat: 53.3, lon: -60.4 },
    { name: "Utqiagvik AK (Arctic coast is out of scope)", lat: 71.29, lon: -156.79 },
    { name: "open Atlantic", lat: 40.0, lon: -70.0 },
    { name: "open Atlantic off Bermuda", lat: 35.0, lon: -65.0 }
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
