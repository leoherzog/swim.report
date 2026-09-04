// Tests for the remaining untested src/geo.js helpers: distanceMi (used by the
// router's distance sort) and metersToFeet (used by the offline NOAA wave
// sampler). distanceKm and pointInGeometry already have coverage in
// test/waveGrids.test.js and test/eccc.test.js. Pure math, no mocks needed.

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
    // The offline wave sampler relies on this to propagate masked grid cells
    // without fabricating 0 ft waves.
    expect(metersToFeet(null)).toBeNull();
  });

  it("passes undefined through as null (masked/no-data convention)", function () {
    expect(metersToFeet(undefined)).toBeNull();
  });
});

// --- The line-geometry extension -------------------------------------------
//
// src/geo.js is a pure src module with no Deno, no fs, no fetch and no npm
// dependency, so importing it under vitest performs no I/O.
//
// Every expected distance below was computed by hand in the same local
// equirectangular frame the implementation uses (x = dLon * cos(lat) * 111.195,
// y = dLat * 111.195), never by calling the function under test.

import {
  geometryLines,
  minGeometryDistanceKm,
  anySegmentWithinKm,
  geometryPolygons,
  minEdgeDistanceKm,
  pointToSegmentKm,
  KM_PER_DEG
} from "../src/geo.js";

// A short north-south LineString on the Lake Michigan shore, 0.01 deg tall.
const SHORE_LINE = {
  type: "LineString",
  coordinates: [[-86.0, 42.0], [-86.0, 42.01]]
};

// A second, parallel line 0.02 deg to the east — the MultiLineString below is
// these two, so a query between them exercises "minimum across parts".
const INLAND_LINE = {
  type: "LineString",
  coordinates: [[-85.98, 42.0], [-85.98, 42.01]]
};

// A square with a square hole in the middle, so the island-in-a-hole path
// (which minEdgeDistanceKm already owns) is exercised through the new wrapper.
const HOLED_POLYGON = {
  type: "Polygon",
  coordinates: [
    [[-86.1, 41.9], [-85.9, 41.9], [-85.9, 42.1], [-86.1, 42.1], [-86.1, 41.9]],
    [[-86.01, 41.99], [-85.99, 41.99], [-85.99, 42.01], [-86.01, 42.01], [-86.01, 41.99]]
  ]
};

// Packs GeoJSON line coordinate arrays into the Float64Array/Int32Array pair
// anySegmentWithinKm consumes, exactly as src/layerGrid.js's segment builder
// will: four doubles per segment (ax, ay, bx, by) in DEGREES, plus one segment
// index per entry. Returns the whole index (count === idx.length); tests that
// care about a partial index slice it themselves.
function packSegments(lines) {
  const flat = [];
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i = i + 1) {
      flat.push(line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]);
    }
  }
  const segs = new Float64Array(flat);
  const count = flat.length / 4;
  const idx = new Int32Array(count);
  for (let i = 0; i < count; i = i + 1) {
    idx[i] = i;
  }
  return { segs: segs, idx: idx, count: count };
}

describe("geometryLines", function () {
  it("wraps a LineString's coordinates in a single-element array", function () {
    const lines = geometryLines(SHORE_LINE);
    expect(lines.length).toBe(1);
    // Identity, not equality: the function must not copy the coordinates —
    // a ~3e6 vertex lakes layer cannot afford a defensive clone per probe.
    expect(lines[0]).toBe(SHORE_LINE.coordinates);
  });

  it("returns a MultiLineString's coordinates array as-is", function () {
    const multi = {
      type: "MultiLineString",
      coordinates: [SHORE_LINE.coordinates, INLAND_LINE.coordinates]
    };
    expect(geometryLines(multi)).toBe(multi.coordinates);
    expect(geometryLines(multi).length).toBe(2);
  });

  it("returns [] for Polygon and MultiPolygon (it is a SIBLING of geometryPolygons)", function () {
    // The two must never learn about each other's types: if geometryPolygons
    // grew line support, pointInGeometry would ray-cast an OPEN line as though
    // it were a closed ring and answer a question nobody asked.
    expect(geometryLines(HOLED_POLYGON)).toEqual([]);
    expect(geometryLines({ type: "MultiPolygon", coordinates: [HOLED_POLYGON.coordinates] })).toEqual([]);
    expect(geometryPolygons(SHORE_LINE)).toEqual([]);
  });

  it("returns [] for Point, MultiPoint and unknown types", function () {
    expect(geometryLines({ type: "Point", coordinates: [-86.0, 42.0] })).toEqual([]);
    expect(geometryLines({ type: "MultiPoint", coordinates: [[-86.0, 42.0]] })).toEqual([]);
    expect(geometryLines({ type: "Wat", coordinates: [] })).toEqual([]);
  });

  it("returns [] for null, undefined, non-objects and a missing coordinates array", function () {
    expect(geometryLines(null)).toEqual([]);
    expect(geometryLines(undefined)).toEqual([]);
    expect(geometryLines("LineString")).toEqual([]);
    expect(geometryLines({ type: "LineString" })).toEqual([]);
    expect(geometryLines({ type: "LineString", coordinates: null })).toEqual([]);
  });
});

describe("minGeometryDistanceKm", function () {
  it("is finite for a LineString where minEdgeDistanceKm is Infinity (the motivating regression)", function () {
    // This is the whole reason the extension exists. The OSM coastline layer is
    // predominantly LineString; routing a nearest-shore probe through the
    // polygon-only path returns Infinity SILENTLY, which would classify every
    // ocean beach inland — a failure invisible in production today because
    // there are zero ocean rows.
    expect(minEdgeDistanceKm(SHORE_LINE, 42.005, -85.99)).toBe(Infinity);
    expect(minGeometryDistanceKm(SHORE_LINE, 42.005, -85.99)).toBeCloseTo(0.8263, 3);
  });

  it("clamps to the nearer endpoint for a query beyond the end of a LineString", function () {
    // 0.01 deg of latitude past the north end: 0.01 * 111.195 = 1.11195 km.
    expect(minGeometryDistanceKm(SHORE_LINE, 42.02, -86.0)).toBeCloseTo(1.11195, 5);
  });

  it("takes the minimum across MultiLineString parts", function () {
    const multi = {
      type: "MultiLineString",
      coordinates: [SHORE_LINE.coordinates, INLAND_LINE.coordinates]
    };
    // Query at lon -85.985 sits 0.005 deg from the inland line and 0.015 deg
    // from the shore line: 0.4131 km vs 1.2394 km.
    expect(minGeometryDistanceKm(multi, 42.005, -85.985)).toBeCloseTo(0.4131, 3);
  });

  it("measures to the vertex for a Point and to the nearest vertex for a MultiPoint", function () {
    const point = { type: "Point", coordinates: [-86.0, 42.0] };
    expect(minGeometryDistanceKm(point, 42.0, -85.999)).toBeCloseTo(0.08263, 4);
    expect(minGeometryDistanceKm(point, 42.0, -86.0)).toBe(0);
    const multiPoint = { type: "MultiPoint", coordinates: [[-85.98, 42.0], [-86.0, 42.0]] };
    expect(minGeometryDistanceKm(multiPoint, 42.0, -85.999)).toBeCloseTo(0.08263, 4);
  });

  it("delegates polygons to minEdgeDistanceKm with an identical result, holes included", function () {
    // Outside the outer ring.
    const outside = minEdgeDistanceKm(HOLED_POLYGON, 42.0, -86.2);
    expect(minGeometryDistanceKm(HOLED_POLYGON, 42.0, -86.2)).toBe(outside);
    // Inside the HOLE — an island beach. The nearest edge is the hole's, not
    // the outer ring's, and the wrapper must not change that.
    const inHole = minEdgeDistanceKm(HOLED_POLYGON, 42.0, -86.0);
    expect(minGeometryDistanceKm(HOLED_POLYGON, 42.0, -86.0)).toBe(inHole);
    expect(inHole).toBeLessThan(outside);
  });

  it("handles a MIXED GeometryCollection: a line plus a polygon, minimum across members", function () {
    // The coastline layer mixes open ways with closed island ways, so a caller
    // handed one geometry cannot assume a family.
    const mixed = {
      type: "GeometryCollection",
      geometries: [SHORE_LINE, HOLED_POLYGON]
    };
    const lineOnly = minGeometryDistanceKm(SHORE_LINE, 42.005, -85.99);
    const polyOnly = minGeometryDistanceKm(HOLED_POLYGON, 42.005, -85.99);
    expect(minGeometryDistanceKm(mixed, 42.005, -85.99)).toBe(Math.min(lineOnly, polyOnly));
    // And the mixed-LAYER form of the same case: separate features of different
    // geometry types reduced by the caller.
    const layer = [SHORE_LINE, HOLED_POLYGON, { type: "Point", coordinates: [-86.0, 42.0] }];
    let best = Infinity;
    for (const g of layer) {
      const d = minGeometryDistanceKm(g, 42.005, -85.99);
      if (d < best) { best = d; }
    }
    expect(best).toBeLessThan(Infinity);
  });

  it("returns Infinity for null, non-objects, unknown types and empty coordinate lists", function () {
    expect(minGeometryDistanceKm(null, 42, -86)).toBe(Infinity);
    expect(minGeometryDistanceKm(undefined, 42, -86)).toBe(Infinity);
    expect(minGeometryDistanceKm("LineString", 42, -86)).toBe(Infinity);
    expect(minGeometryDistanceKm({ type: "Wat", coordinates: [[0, 0]] }, 42, -86)).toBe(Infinity);
    expect(minGeometryDistanceKm({ type: "LineString", coordinates: [] }, 42, -86)).toBe(Infinity);
    // A one-position LineString has no segment, exactly as a one-position ring
    // has no edge in minEdgeDistanceKm. Degenerate input, same answer.
    expect(minGeometryDistanceKm({ type: "LineString", coordinates: [[-86, 42]] }, 42, -86)).toBe(Infinity);
  });

  it("skips malformed positions instead of throwing", function () {
    // Layer data is upstream input; a half-parsed geometry must degrade, never
    // take down the batch mid-probe.
    // A malformed vertex costs the two segments that touch it and nothing
    // more — the rest of the line still measures, exactly as minEdgeDistanceKm
    // loses only the edges adjacent to a bad ring position.
    const ragged = {
      type: "LineString",
      coordinates: [[-86.0, 42.0], [-86.0, 42.01], null, ["x", 42.02], [-86.0, 42.03]]
    };
    expect(function () { minGeometryDistanceKm(ragged, 42.005, -85.99); }).not.toThrow();
    expect(minGeometryDistanceKm(ragged, 42.005, -85.99)).toBeCloseTo(0.8263, 3);
    const allBad = { type: "MultiPoint", coordinates: [null, [1], "nope"] };
    expect(minGeometryDistanceKm(allBad, 42, -86)).toBe(Infinity);
  });
});

describe("anySegmentWithinKm", function () {
  it("is true when some packed segment is within maxKm and false when none is", function () {
    const packed = packSegments([SHORE_LINE.coordinates]);
    // The perpendicular distance from (42.005, -85.99) to the line is 0.8263 km.
    expect(anySegmentWithinKm(packed.segs, packed.idx, packed.count, 42.005, -85.99, 0.9)).toBe(true);
    expect(anySegmentWithinKm(packed.segs, packed.idx, packed.count, 42.005, -85.99, 0.7)).toBe(false);
  });

  it("holds the 150 m and 120 m probe radii in BOTH directions", function () {
    // The entire safety argument of the migration is that the radii did not
    // change, so both sides of each boundary are asserted. Offsets are due
    // NORTH so the longitude cosine cannot enter the arithmetic:
    // 0.00134 deg = 0.1490 km, 0.00136 deg = 0.1512 km,
    // 0.00107 deg = 0.1190 km, 0.00109 deg = 0.1212 km.
    const packed = packSegments([[[-86.01, 42.0], [-85.99, 42.0]]]);
    const probe = function (dLat, maxKm) {
      return anySegmentWithinKm(packed.segs, packed.idx, packed.count, 42.0 + dLat, -86.0, maxKm);
    };
    expect(probe(0.00134, 0.150)).toBe(true);
    expect(probe(0.00136, 0.150)).toBe(false);
    expect(probe(0.00107, 0.120)).toBe(true);
    expect(probe(0.00109, 0.120)).toBe(false);
  });

  it("is inclusive at exactly maxKm and answers a zero radius honestly", function () {
    // maxKm is taken from the reference implementation rather than written as a
    // literal, because "exactly" has to survive binary floating point: the two
    // must agree on the boundary case itself, not on a decimal that rounds to
    // within an ulp of it. The comparison is <=, so equality qualifies.
    const line = { type: "LineString", coordinates: [[-86.0, 42.0], [-86.0, 42.01]] };
    const packed = packSegments([line.coordinates]);
    const exact = minGeometryDistanceKm(line, 42.011, -86.0);
    expect(exact).toBeCloseTo(0.001 * KM_PER_DEG, 9);
    expect(anySegmentWithinKm(packed.segs, packed.idx, packed.count, 42.011, -86.0, exact)).toBe(true);
    expect(anySegmentWithinKm(packed.segs, packed.idx, packed.count, 42.011, -86.0, exact * 0.999)).toBe(false);
    // A radius of 0 is answered honestly rather than short-circuited away: a
    // query sitting ON a vertex is distance 0 and qualifies. A query on the
    // segment's INTERIOR is deliberately not asserted here — the projection
    // leaves a ~1e-13 km residue and a test that pretended otherwise would be
    // asserting infinite precision, not behaviour.
    expect(anySegmentWithinKm(packed.segs, packed.idx, packed.count, 42.0, -86.0, 0)).toBe(true);
    expect(anySegmentWithinKm(packed.segs, packed.idx, packed.count, 42.005, -85.99, 0)).toBe(false);
  });

  it("evaluates only the first count entries of idx", function () {
    // The grid grows its arrays in blocks, so idx.length is never the answer —
    // reading past count would evaluate stale segment indices.
    const packed = packSegments([SHORE_LINE.coordinates, INLAND_LINE.coordinates]);
    expect(packed.count).toBe(2);
    const padded = new Int32Array(8);
    padded[0] = 1;
    // Only the inland line (index 1) is live; the shore line is beyond count.
    expect(anySegmentWithinKm(packed.segs, padded, 1, 42.005, -85.985, 0.5)).toBe(true);
    expect(anySegmentWithinKm(packed.segs, padded, 1, 42.005, -85.995, 0.5)).toBe(false);
    // With both live, the shore line answers the second query.
    const both = new Int32Array([0, 1, 0, 0]);
    expect(anySegmentWithinKm(packed.segs, both, 2, 42.005, -85.995, 0.5)).toBe(true);
  });

  it("returns false, never throws, for an empty or absent index", function () {
    const packed = packSegments([SHORE_LINE.coordinates]);
    expect(anySegmentWithinKm(packed.segs, packed.idx, 0, 42.005, -85.99, 100)).toBe(false);
    expect(anySegmentWithinKm(packed.segs, new Int32Array(0), 0, 42.0, -86.0, 100)).toBe(false);
    expect(anySegmentWithinKm(null, packed.idx, packed.count, 42.0, -86.0, 100)).toBe(false);
    expect(anySegmentWithinKm(packed.segs, null, packed.count, 42.0, -86.0, 100)).toBe(false);
    expect(anySegmentWithinKm(packed.segs, packed.idx, packed.count, 42.0, -86.0, -1)).toBe(false);
    expect(anySegmentWithinKm(packed.segs, packed.idx, packed.count, 42.0, -86.0, NaN)).toBe(false);
  });

  it("skips out-of-range segment indices instead of throwing", function () {
    // An out-of-range entry is a builder bug, not bad data; a corrupt index must
    // not take down a whole build mid-probe.
    const packed = packSegments([SHORE_LINE.coordinates]);
    const idx = new Int32Array([99, -1, 0]);
    expect(function () {
      anySegmentWithinKm(packed.segs, idx, 3, 42.005, -85.99, 0.9);
    }).not.toThrow();
    expect(anySegmentWithinKm(packed.segs, idx, 3, 42.005, -85.99, 0.9)).toBe(true);
    expect(anySegmentWithinKm(packed.segs, new Int32Array([99, -1]), 2, 42.005, -85.99, 100)).toBe(false);
  });

  it("agrees with minGeometryDistanceKm <= maxKm over a deterministic sweep", function () {
    // The cross-check that matters: the packed evaluator and the GeoJSON
    // reference must answer the same threshold question. A deterministic LCG,
    // not Math.random, so a failure is reproducible.
    const coords = [];
    let seed = 20260901;
    const next = function () {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 40; i = i + 1) {
      coords.push([-86.2 + next() * 0.4, 41.9 + next() * 0.3]);
    }
    const line = { type: "LineString", coordinates: coords };
    const packed = packSegments([coords]);
    for (let q = 0; q < 200; q = q + 1) {
      const lat = 41.9 + next() * 0.3;
      const lon = -86.2 + next() * 0.4;
      const maxKm = 0.05 + next() * 8;
      const reference = minGeometryDistanceKm(line, lat, lon) <= maxKm;
      expect(anySegmentWithinKm(packed.segs, packed.idx, packed.count, lat, lon, maxKm)).toBe(reference);
    }
  });
});

// --- pointToSegmentKm ------------------------------------------------------
//
// The segment evaluator every distance helper in this module bottoms out in.
// Both bit-exactness arguments elsewhere in the codebase hang on its behaviour:
// src/geo.js#anySegmentWithinKm forbids a cheap axis-aligned pre-reject because
// such a reject is not bit-exact against this function, and
// src/layerGrid.js#SEGMENT_BBOX_EPSILON_DEG exists because the grid's rejection
// is in degrees while the decision it guards is the projected km this returns.
// So it is pinned directly, and pinned to agree exactly with
// minGeometryDistanceKm on the same segment.

describe("pointToSegmentKm", function () {
  it("measures a perpendicular foot that lands inside the segment", function () {
    // Segment from (3,-2) to (3,5): the origin's nearest point is (3,0).
    expect(pointToSegmentKm(3, -2, 3, 5)).toBeCloseTo(3, 12);
  });

  it("clamps to the near endpoint when the projection falls before the segment", function () {
    // Segment from (3,4) to (6,8) heads away from the origin, so t clamps to 0.
    expect(pointToSegmentKm(3, 4, 6, 8)).toBeCloseTo(5, 12);
  });

  it("clamps to the far endpoint when the projection falls past the segment", function () {
    // Segment from (-9,-12) to (-3,-4) approaches the origin but stops short,
    // so t clamps to 1 and the answer is the distance to (-3,-4).
    expect(pointToSegmentKm(-9, -12, -3, -4)).toBeCloseTo(5, 12);
  });

  it("treats a zero-length segment as the point itself", function () {
    // len2 === 0 keeps t at 0 rather than dividing by zero, which is what lets
    // minPositionsDistanceKm feed bare vertices through as degenerate segments.
    expect(pointToSegmentKm(6, 8, 6, 8)).toBe(10);
    expect(Number.isFinite(pointToSegmentKm(0, 0, 0, 0))).toBe(true);
    expect(pointToSegmentKm(0, 0, 0, 0)).toBe(0);
  });

  it("is zero when the origin lies on the segment", function () {
    expect(pointToSegmentKm(-4, 0, 4, 0)).toBe(0);
  });

  it("agrees exactly with minGeometryDistanceKm on the same projected segment", function () {
    // minGeometryDistanceKm projects each position into the local
    // equirectangular frame and then calls this function, so reproducing that
    // projection by hand must reproduce its answer bit for bit. An
    // approximation swapped in here would break this equality, which is the
    // whole reason the pre-reject is forbidden.
    const lat = 42.0;
    const lon = -86.0;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const a = [-85.99, 42.004];
    const b = [-85.97, 42.02];
    const line = { type: "LineString", coordinates: [a, b] };
    const ax = (a[0] - lon) * cosLat * KM_PER_DEG;
    const ay = (a[1] - lat) * KM_PER_DEG;
    const bx = (b[0] - lon) * cosLat * KM_PER_DEG;
    const by = (b[1] - lat) * KM_PER_DEG;
    expect(minGeometryDistanceKm(line, lat, lon)).toBe(pointToSegmentKm(ax, ay, bx, by));
  });
});
