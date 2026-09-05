// Tests for src/marineZones.js — the pure offline nearest-marine-zone resolver
// that replaced the retired in-Worker runMarineEnrichment probe. Synthetic
// zone fixtures throughout (no network); two small sanity blocks read the
// committed data/marine-zones-greatlakes.json and data/marine-zones.json via fs.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import {
  buildMarineZoneIndex,
  nearestMarineZone,
  MARINE_ZONE_MAX_DISTANCE_KM
} from "../src/marineZones.js";

// Closed rectangular ring, [lon, lat] points, first repeated last.
function rect(minLon, minLat, maxLon, maxLat) {
  return [
    [minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]
  ];
}

// Two adjacent "nearshore" strips with a 0.02-deg water gap between them at
// lon -85.90..-85.88, and a third far-away zone with an island-sized HOLE.
//   LMZ800: lon -86.00..-85.90, lat 43.0..43.1  (west strip)
//   LMZ700: lon -85.88..-85.78, lat 43.0..43.1  (east strip; lexicographically
//           SMALLER id but geometrically east — proves distance beats id)
//   LHZ900: lon -85.0..-84.5, lat 45.0..45.5 with a hole -84.8..-84.7 x 45.2..45.3
function fixtureData() {
  return {
    zones: [
      { id: "LMZ800", polygons: [[rect(-86.00, 43.0, -85.90, 43.1)]] },
      { id: "LMZ700", polygons: [[rect(-85.88, 43.0, -85.78, 43.1)]] },
      {
        id: "LHZ900",
        polygons: [[
          rect(-85.0, 45.0, -84.5, 45.5),
          rect(-84.8, 45.2, -84.7, 45.3)
        ]]
      }
    ]
  };
}

describe("buildMarineZoneIndex", function () {
  it("builds an index from well-formed zones data", function () {
    const index = buildMarineZoneIndex(fixtureData());
    expect(index.zones.length).toBe(3);
    expect(index.zones[0].id).toBe("LMZ800");
    expect(index.zones[0].geometry.type).toBe("MultiPolygon");
  });
  it("throws on malformed top-level data", function () {
    expect(function () { return buildMarineZoneIndex(null); }).toThrow();
    expect(function () { return buildMarineZoneIndex({}); }).toThrow();
    expect(function () { return buildMarineZoneIndex({ zones: "nope" }); }).toThrow();
  });
  it("throws on a zone with no id or no polygons", function () {
    expect(function () {
      return buildMarineZoneIndex({ zones: [{ polygons: [[rect(0, 0, 1, 1)]] }] });
    }).toThrow();
    expect(function () {
      return buildMarineZoneIndex({ zones: [{ id: "LMZ001", polygons: [] }] });
    }).toThrow();
  });
  it("throws on an unclosed/short ring or a non-numeric point", function () {
    expect(function () {
      return buildMarineZoneIndex({ zones: [{ id: "LMZ001", polygons: [[[[0, 0], [1, 0], [0, 0]]]] }] });
    }).toThrow();
    expect(function () {
      return buildMarineZoneIndex({
        zones: [{ id: "LMZ001", polygons: [[[[0, 0], [1, 0], [1, "x"], [0, 1], [0, 0]]]] }]
      });
    }).toThrow();
  });
});

describe("nearestMarineZone", function () {
  const index = buildMarineZoneIndex(fixtureData());

  it("point INSIDE a zone resolves to that zone (PIP, distance 0)", function () {
    expect(nearestMarineZone(index, 43.05, -85.95)).toBe("LMZ800");
    expect(nearestMarineZone(index, 43.05, -85.80)).toBe("LMZ700");
  });

  it("an on-land point within the cap resolves to the nearest zone edge", function () {
    // 0.05 deg west of LMZ800's west edge: ~4.1 km at lat 43 — well under 15.
    expect(nearestMarineZone(index, 43.05, -86.05)).toBe("LMZ800");
  });

  it("with two zones in reach, the closer one wins even when the farther id is smaller", function () {
    // In the -85.90..-85.88 gap, nearer LMZ800's east edge: LMZ800 wins although
    // "LMZ700" sorts first lexicographically.
    expect(nearestMarineZone(index, 43.05, -85.893)).toBe("LMZ800");
    // And nearer LMZ700's west edge: LMZ700 wins.
    expect(nearestMarineZone(index, 43.05, -85.885)).toBe("LMZ700");
  });

  it("an exact tie goes to the lexicographically smallest zone id", function () {
    // -85.89 is exactly midway between LMZ800's east edge (-85.90) and LMZ700's
    // west edge (-85.88); both distances are computed in the same projection
    // anchored at the point, so the tie is exact -> "LMZ700" < "LMZ800".
    expect(nearestMarineZone(index, 43.05, -85.89)).toBe("LMZ700");
  });

  it("returns null beyond the 15 km cap", function () {
    expect(MARINE_ZONE_MAX_DISTANCE_KM).toBe(15);
    // 0.3 deg west of LMZ800 (~24 km at lat 43): out of reach.
    expect(nearestMarineZone(index, 43.05, -86.30)).toBe(null);
    // Inside the expanded bbox but past the cap on the diagonal corner:
    // dlat 0.12 deg (~13.3 km) + dlon 0.1 deg (~8.1 km) -> ~15.6 km.
    expect(nearestMarineZone(index, 42.88, -86.10)).toBe(null);
  });

  it("an island point inside a HOLE resolves via the nearest hole edge", function () {
    // (45.25, -84.75) is inside LHZ900's hole: PIP is false (the hole excludes
    // it), but the hole's edges are ~4-6 km away and COUNT for nearest-edge.
    expect(nearestMarineZone(index, 45.25, -84.75)).toBe("LHZ900");
  });

  it("non-finite or non-number lat/lon -> null", function () {
    expect(nearestMarineZone(index, NaN, -86.0)).toBe(null);
    expect(nearestMarineZone(index, 43.05, Infinity)).toBe(null);
    expect(nearestMarineZone(index, "43.05", -86.0)).toBe(null);
    expect(nearestMarineZone(index, null, null)).toBe(null);
  });
});

describe("committed data/marine-zones.json sanity", function () {
  const path = fileURLToPath(new URL("../data/marine-zones.json", import.meta.url));
  const data = JSON.parse(readFileSync(path, "utf8"));
  const COASTAL_PREFIXES = /^(AMZ|ANZ|GMZ|PZZ|PKZ|PHZ|PMZ|PSZ|LCZ|LEZ|LHZ|LMZ|LOZ|LSZ|SLZ)\d{3}$/;

  it("carries every coastal zone in the mz16ap26 release, Great Lakes included", function () {
    expect(data.zones.length).toBe(569);
    const prefixes = new Set();
    for (const zone of data.zones) {
      expect(zone.id).toMatch(COASTAL_PREFIXES);
      prefixes.add(zone.id.slice(0, 3));
    }
    expect(prefixes.size).toBe(15);
    const greatLakes = data.zones.filter(function (zone) {
      return /^(LCZ|LEZ|LHZ|LMZ|LOZ|LSZ|SLZ)/.test(zone.id);
    });
    expect(greatLakes.length).toBe(134);
  });

  it("resolves ocean, Gulf, Alaska and Great Lakes beaches to their coastal zone", function () {
    const index = buildMarineZoneIndex(data);
    // Same family assertions as the Great Lakes block: a renumbering fails
    // loudly, a same-family re-id shows in the diff.
    expect(nearestMarineZone(index, 34.0095, -118.4977)).toMatch(/^PZZ6\d{2}$/);
    expect(nearestMarineZone(index, 25.7907, -80.1300)).toMatch(/^AMZ6\d{2}$/);
    expect(nearestMarineZone(index, 41.8107, -69.9280)).toMatch(/^ANZ2\d{2}$/);
    expect(nearestMarineZone(index, 29.2691, -94.8258)).toMatch(/^GMZ3\d{2}$/);
    expect(nearestMarineZone(index, 61.15, -150.05)).toMatch(/^PKZ\d{3}$/);
    expect(nearestMarineZone(index, 42.775, -86.211)).toMatch(/^LMZ8\d{2}$/);
    expect(nearestMarineZone(index, 42.73, -84.55)).toBe(null);
  });
});
