// Tests for src/layerGrid.js — the two-mode in-process spatial index (envelope
// grid for beaches/parks, segment grid for coastline/water/lakes).
//
// The module is pure, imports src/geo.js and nothing else, and touches no
// network, no clock and no filesystem.
//
// Two things here are load-bearing beyond ordinary coverage:
//
//   1. Grid-versus-linear equality of queryGridByBounds, including order. Every
//      consumer's tie-break (associateParkForBeach's
//      smallest-area-then-first-seen, nearbyLakeQids' push order) rides on
//      candidates arriving in ascending original index order, so the grid is
//      only correct if it is bit-identical to the full scan it replaces.
//   2. The segment-grid benchmark at the bottom. A probe against a giant polygon
//      degenerating into a full scan of its ring is invisible in a correctness
//      test and shows up only as a job that runs for hours. The benchmark
//      asserts segments examined per probe, with wall clock as a secondary
//      check, so a regression to the quadratic behaviour fails the suite rather
//      than the nightly build.

import { describe, it, expect } from "vitest";
import {
  GRID_CELL_DEG,
  buildLayerGrid,
  queryGridByBounds,
  buildSegmentGrid,
  addFeatureSegments,
  finishSegmentGrid,
  anySegmentWithinKmOfPoint,
  featuresWithinKmOfVertices,
  segmentGridStats
} from "../src/layerGrid.js";
import { KM_PER_DEG, minGeometryDistanceKm } from "../src/geo.js";

// --- fixture builders ----------------------------------------------------------

// A feature is anything carrying { bounds }; the grid never looks at the rest,
// which is why a name rides along here to prove the caller's own records survive.
function boxFeature(name, minLon, minLat, maxLon, maxLat) {
  return {
    name: name,
    bounds: { minLon: minLon, minLat: minLat, maxLon: maxLon, maxLat: maxLat }
  };
}

function squareFeature(name, lon, lat, sizeDeg) {
  return boxFeature(name, lon, lat, lon + sizeDeg, lat + sizeDeg);
}

// Deterministic PRNG (mulberry32) so the random cross-checks below are
// reproducible: a failure here must be reproducible on the next run, not a
// once-a-month flake nobody can chase.
function makeRng(seed) {
  let state = seed >>> 0;
  return function () {
    state = state + 0x6D2B79F5 >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t = t ^ t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// A synthetic layer of small-to-medium envelopes scattered over a Great Lakes
// sized box, in an order deliberately unrelated to geography, so the grid's
// ascending-index guarantee cannot be satisfied by accident.
function randomLayer(count, rng) {
  const features = [];
  for (let i = 0; i < count; i = i + 1) {
    const lon = -92 + rng() * 12;
    const lat = 41 + rng() * 7;
    const w = 0.001 + rng() * 0.25;
    const h = 0.001 + rng() * 0.25;
    features.push(boxFeature("f" + i, lon, lat, lon + w, lat + h));
  }
  return features;
}

// The reference implementation of queryGridByBounds: osmSelect's boundsOverlap,
// inclusive on every edge, in original array order.
function linearQueryByBounds(features, bounds) {
  const out = [];
  for (let i = 0; i < features.length; i = i + 1) {
    const b = features[i].bounds;
    if (b.minLat <= bounds.maxLat && b.maxLat >= bounds.minLat &&
      b.minLon <= bounds.maxLon && b.maxLon >= bounds.minLon) {
      out.push(i);
    }
  }
  return out;
}

function lineString(points) {
  return { type: "LineString", coordinates: points };
}

function polygon(rings) {
  return { type: "Polygon", coordinates: rings };
}

// A closed ring approximating a circle of radiusDeg around (lon, lat) with
// vertexCount vertices. This is the "megapolygon" the whole segment grid exists
// for: its ENVELOPE contains every query point in the tests that use it, so an
// envelope index prunes exactly nothing and the only thing standing between the
// probe and a full ring scan is the segment index.
function circleRing(lon, lat, radiusDeg, vertexCount) {
  const ring = [];
  for (let i = 0; i < vertexCount; i = i + 1) {
    const angle = 2 * Math.PI * i / vertexCount;
    ring.push([lon + radiusDeg * Math.cos(angle), lat + radiusDeg * Math.sin(angle)]);
  }
  ring.push(ring[0].slice());
  return ring;
}

// Build a finished segment grid from [{ geometry }, ...] in array order, so the
// feature index a query returns is the caller's own index.
function segmentGridOf(features) {
  const builder = buildSegmentGrid();
  for (let i = 0; i < features.length; i = i + 1) {
    addFeatureSegments(builder, i, features[i].geometry);
  }
  return finishSegmentGrid(builder);
}

// Degrees of longitude corresponding to km at this latitude — the conversion the
// module has to get right and a naive degree pad gets wrong.
function lonDegForKm(km, lat) {
  return km / (KM_PER_DEG * Math.cos(lat * Math.PI / 180));
}

// --- mode A: the envelope grid -------------------------------------------------

describe("buildLayerGrid / queryGridByBounds — basics", function () {
  it("uses a 0.05 degree cell, an order of magnitude above every probe radius", function () {
    expect(GRID_CELL_DEG).toBe(0.05);
    // The largest radius in the pipeline is OCEAN_RADIUS_M / GREAT_LAKE_RADIUS_M
    // at 150 m; the cell must dwarf it or the neighbourhood stops being cheap.
    expect(GRID_CELL_DEG * KM_PER_DEG).toBeGreaterThan(1);
  });

  it("returns [] and never throws on an empty index", function () {
    const grid = buildLayerGrid([]);
    expect(queryGridByBounds(grid, { minLat: 43, minLon: -88, maxLat: 45, maxLon: -86 })).toEqual([]);
  });

  it("returns [] and never throws for missing, malformed or non-finite input", function () {
    const grid = buildLayerGrid([squareFeature("a", -87, 44, 0.01)]);
    expect(queryGridByBounds(grid, null)).toEqual([]);
    expect(queryGridByBounds(grid, { minLat: 1, minLon: 2 })).toEqual([]);
    expect(buildLayerGrid(null).count).toBe(0);
  });

  it("keeps malformed-bounds features in the index positionally but matches none", function () {
    const features = [
      squareFeature("ok0", -87, 44, 0.01),
      { name: "broken", bounds: { minLat: 44, minLon: null, maxLat: 44.01, maxLon: -86.99 } },
      squareFeature("ok2", -87, 44, 0.01),
      { name: "boundsless" }
    ];
    const grid = buildLayerGrid(features);
    expect(grid.count).toBe(4);
    // Index 2 still means the third feature — alignment with the caller's array
    // is the whole contract of returning indices.
    const hits = queryGridByBounds(grid, {
      minLat: 44, minLon: -87, maxLat: 44.01, maxLon: -86.99
    });
    expect(hits).toEqual([0, 2]);
    expect(features[hits[1]].name).toBe("ok2");
  });

  it("indexes an oversized envelope through the always-scanned overflow list", function () {
    // 12 x 8 degrees is ~38,000 cells, far past the per-feature cell cap: it must
    // still be a candidate everywhere inside it, and never a candidate outside.
    const features = [
      boxFeature("huge", -92, 41, -80, 49),
      squareFeature("small", -87, 44, 0.01)
    ];
    const grid = buildLayerGrid(features);
    expect(grid.oversized.length).toBe(1);
    expect(queryGridByBounds(grid, { minLat: 46.9, minLon: -85.1, maxLat: 47.1, maxLon: -84.9 }))
      .toEqual([0]);
  });
});

describe("queryGridByBounds — bbox-to-bbox, order-identical to the full scan", function () {
  it("matches a linear boundsOverlap scan, in the same order, for 100 random rectangles", function () {
    const rng = makeRng(4242);
    const features = randomLayer(400, rng);
    const grid = buildLayerGrid(features);
    for (let q = 0; q < 100; q = q + 1) {
      const lon = -92 + rng() * 12;
      const lat = 41 + rng() * 7;
      const bounds = {
        minLon: lon,
        minLat: lat,
        maxLon: lon + rng() * 0.4,
        maxLat: lat + rng() * 0.4
      };
      expect(queryGridByBounds(grid, bounds)).toEqual(linearQueryByBounds(features, bounds));
    }
  });

  it("counts edge-touching envelopes as overlapping, exactly as boundsOverlap does", function () {
    const features = [boxFeature("park", -87.0, 44.0, -86.9, 44.1)];
    const grid = buildLayerGrid(features);
    // Shares only the corner point (-86.9, 44.1).
    expect(queryGridByBounds(grid, { minLon: -86.9, minLat: 44.1, maxLon: -86.8, maxLat: 44.2 }))
      .toEqual([0]);
    // One ulp of separation is a miss.
    expect(queryGridByBounds(grid, { minLon: -86.8999, minLat: 44.1001, maxLon: -86.8, maxLat: 44.2 }))
      .toEqual([]);
  });

  it("preserves the smallest-area-then-first-seen answer of the full-list scan", function () {
    // The exact shape associateParkForBeach depends on: two equally small parks
    // overlap the beach, and the FIRST in array order must win the tie. areaDeg2
    // is carried as a FIELD, exactly as parkRecord carries it, rather than
    // recomputed from the bounds here — two boxes of the same nominal size have
    // subtly different floating-point degree products, which would decide the
    // tie by rounding instead of by order and quietly gut the assertion.
    const parks = [
      { name: "big", areaDeg2: 0.16, bounds: { minLon: -87.2, minLat: 43.9, maxLon: -86.8, maxLat: 44.3 } },
      { name: "tie-a", areaDeg2: 0.0004, bounds: { minLon: -87.01, minLat: 43.99, maxLon: -86.99, maxLat: 44.01 } },
      { name: "tie-b", areaDeg2: 0.0004, bounds: { minLon: -87.015, minLat: 43.995, maxLon: -86.995, maxLat: 44.015 } }
    ];
    const grid = buildLayerGrid(parks);
    const beachBounds = { minLon: -87.001, minLat: 43.999, maxLon: -86.999, maxLat: 44.001 };
    const candidates = queryGridByBounds(grid, beachBounds);
    expect(candidates).toEqual([0, 1, 2]);
    let best = null;
    for (const i of candidates) {
      if (best === null || parks[i].areaDeg2 < best.areaDeg2) {
        best = parks[i];
      }
    }
    expect(best.name).toBe("tie-a");
  });
});

describe("longitude scaling — asserted at both latitude extremes", function () {
  // Cells are square in DEGREES: at 49 N a cell is ~3.6 km east-west against
  // 5.5 km north-south, and at 25 N (the North America target's southern edge)
  // ~5.0 km. A pad expressed in degrees of latitude therefore reaches LESS
  // ground east-west than it does north-south, and would silently drop a feature
  // that is genuinely within the radius. Both modes scale the longitude pad by
  // 1/cos(lat); these are the assertions that keep that scaling honest.
  const radiusKm = 0.15;
  const padDeg = radiusKm / KM_PER_DEG;

  for (const lat of [49, 25]) {
    it("admits a segment " + radiusKm + " km east at " + lat + " N (segment grid)", function () {
      const seg = { geometry: lineString([[-87, lat - 0.002], [-87, lat + 0.002]]) };
      const segGrid = segmentGridOf([seg]);
      const insideLon = -87 + lonDegForKm(radiusKm * 0.99, lat);
      const outsideLon = -87 + lonDegForKm(radiusKm * 1.5, lat);
      expect(anySegmentWithinKmOfPoint(segGrid, lat, insideLon, radiusKm)).toBe(true);
      expect(anySegmentWithinKmOfPoint(segGrid, lat, outsideLon, radiusKm)).toBe(false);
      // And the exact-decision reference agrees at both points.
      expect(minGeometryDistanceKm(seg.geometry, lat, insideLon) <= radiusKm).toBe(true);
      expect(minGeometryDistanceKm(seg.geometry, lat, outsideLon) <= radiusKm).toBe(false);
    });
  }
});

// --- mode B: the segment grid --------------------------------------------------

describe("segment grid — construction", function () {
  it("indexes a LineString and answers the threshold question exactly", function () {
    const coast = { geometry: lineString([[-87.0, 44.0], [-87.0, 44.02], [-86.98, 44.03]]) };
    const segGrid = segmentGridOf([coast]);
    expect(segmentGridStats(segGrid).segments).toBe(2);
    // ~100 m west of the first segment.
    const nearLon = -87.0 - lonDegForKm(0.1, 44);
    expect(anySegmentWithinKmOfPoint(segGrid, 44.01, nearLon, 0.15)).toBe(true);
    // ~500 m west of it.
    const farLon = -87.0 - lonDegForKm(0.5, 44);
    expect(anySegmentWithinKmOfPoint(segGrid, 44.01, farLon, 0.15)).toBe(false);
  });

  it("indexes hole rings as well as outer rings", function () {
    // An island beach sits inside a HOLE of a water polygon; its nearest water
    // edge is the hole's, so dropping hole rings would report no water at all.
    const outer = [[-87.2, 43.8], [-86.8, 43.8], [-86.8, 44.2], [-87.2, 44.2], [-87.2, 43.8]];
    const hole = [[-87.02, 43.98], [-86.98, 43.98], [-86.98, 44.02], [-87.02, 44.02], [-87.02, 43.98]];
    const lake = { geometry: polygon([outer, hole]) };
    const segGrid = segmentGridOf([lake]);
    // Dead centre of the hole is ~2 km from every hole edge: not within 150 m.
    expect(anySegmentWithinKmOfPoint(segGrid, 44.0, -87.0, 0.15)).toBe(false);
    // 100 m inside the hole's western edge IS within 150 m of that edge.
    const nearHoleEdge = -87.02 + lonDegForKm(0.1, 44);
    expect(anySegmentWithinKmOfPoint(segGrid, 44.0, nearHoleEdge, 0.15)).toBe(true);
    expect(minGeometryDistanceKm(lake.geometry, 44.0, nearHoleEdge) <= 0.15).toBe(true);
  });

  it("indexes MultiLineString and MultiPolygon members, and Point geometry degenerately", function () {
    const multiLine = {
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [[-87.0, 44.0], [-87.0, 44.01]],
          [[-86.5, 44.0], [-86.5, 44.01]]
        ]
      }
    };
    const multiPoly = {
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [[[-88.0, 44.0], [-87.99, 44.0], [-87.99, 44.01], [-88.0, 44.01], [-88.0, 44.0]]]
        ]
      }
    };
    // A node-mapped water feature: a zero-length segment, still probeable.
    const node = { geometry: { type: "Point", coordinates: [-85.0, 44.0] } };
    const segGrid = segmentGridOf([multiLine, multiPoly, node]);
    expect(anySegmentWithinKmOfPoint(segGrid, 44.005, -87.0, 0.15)).toBe(true);
    expect(anySegmentWithinKmOfPoint(segGrid, 44.005, -86.5, 0.15)).toBe(true);
    // ~40 m inside the multipolygon's western edge. The segment grid answers
    // PROXIMITY, not containment, so the polygon's centre (~400 m from the
    // nearest edge) is deliberately a miss.
    expect(anySegmentWithinKmOfPoint(segGrid, 44.005, -87.9995, 0.15)).toBe(true);
    expect(anySegmentWithinKmOfPoint(segGrid, 44.005, -87.995, 0.15)).toBe(false);
    expect(anySegmentWithinKmOfPoint(segGrid, 44.0, -85.0 + lonDegForKm(0.1, 44), 0.15)).toBe(true);
    expect(anySegmentWithinKmOfPoint(segGrid, 44.0, -85.0 + lonDegForKm(0.5, 44), 0.15)).toBe(false);
  });

  it("skips malformed coordinates instead of throwing, and reports what it indexed", function () {
    const builder = buildSegmentGrid();
    expect(addFeatureSegments(builder, 0, null)).toBe(0);
    expect(addFeatureSegments(builder, 0, { type: "LineString", coordinates: null })).toBe(0);
    expect(addFeatureSegments(builder, 0, lineString([[-87, 44]]))).toBe(0);
    expect(addFeatureSegments(builder, 0, lineString([[-87, 44], ["x", 44.01], [-87, 44.02]]))).toBe(0);
    expect(addFeatureSegments(builder, -1, lineString([[-87, 44], [-87, 44.01]]))).toBe(0);
    expect(addFeatureSegments(null, 0, lineString([[-87, 44], [-87, 44.01]]))).toBe(0);
    expect(addFeatureSegments(builder, 0, lineString([[-87, 44], [-87, 44.01]]))).toBe(1);
    const segGrid = finishSegmentGrid(builder);
    expect(segmentGridStats(segGrid).segments).toBe(1);
  });

  it("subdivides a long segment instead of registering its whole bounding box", function () {
    // A 5-degree diagonal segment's bbox covers 100 x 100 cells; registering it
    // whole would write 10,000 entries for a segment that touches ~140 of them.
    const long = { geometry: lineString([[-90, 41], [-85, 46]]) };
    const segGrid = segmentGridOf([long]);
    const stats = segmentGridStats(segGrid);
    expect(stats.segments).toBeGreaterThan(1);
    // Cells occupied stay proportional to the segment's LENGTH, not to the area
    // of its bounding box.
    expect(stats.cells).toBeLessThan(1000);
    // Subdivision is exact: the pieces are colinear, so the answer at the
    // midpoint is unchanged.
    expect(anySegmentWithinKmOfPoint(segGrid, 43.5, -87.5, 0.15)).toBe(true);
    expect(anySegmentWithinKmOfPoint(segGrid, 43.5, -87.5 + lonDegForKm(5, 43.5), 0.15)).toBe(false);
  });

  it("retains no source geometry — mutating the input afterwards changes nothing", function () {
    const ring = circleRing(-87, 44, 0.01, 32);
    const feature = { geometry: polygon([ring]) };
    const segGrid = segmentGridOf([feature]);
    const nearEdge = { lat: 44 + 0.01 - 0.05 / KM_PER_DEG, lon: -87 };
    expect(anySegmentWithinKmOfPoint(segGrid, nearEdge.lat, nearEdge.lon, 0.15)).toBe(true);
    // The grid holds typed arrays of numbers, not references into the GeoJSON,
    // which is what lets the caller stream a 120 MB layer and keep only a small
    // per-feature sidecar.
    expect(segGrid.segs instanceof Float64Array).toBe(true);
    expect(segGrid.owners instanceof Int32Array).toBe(true);
    feature.geometry.coordinates[0].length = 0;
    feature.geometry = null;
    expect(anySegmentWithinKmOfPoint(segGrid, nearEdge.lat, nearEdge.lon, 0.15)).toBe(true);
  });

  it("returns safe empties for an empty or absent grid", function () {
    const empty = finishSegmentGrid(buildSegmentGrid());
    expect(anySegmentWithinKmOfPoint(empty, 44, -87, 0.15)).toBe(false);
    expect(featuresWithinKmOfVertices(empty, [{ lat: 44, lon: -87 }], 0.15)).toEqual([]);
    expect(segmentGridStats(empty)).toEqual({
      segments: 0, cells: 0, features: 0, probes: 0, segmentsExamined: 0
    });
    const nothing = finishSegmentGrid(null);
    expect(anySegmentWithinKmOfPoint(nothing, 44, -87, 0.15)).toBe(false);
    expect(anySegmentWithinKmOfPoint(null, 44, -87, 0.15)).toBe(false);
    expect(featuresWithinKmOfVertices(null, [{ lat: 44, lon: -87 }], 0.15)).toEqual([]);
    expect(segmentGridStats(null).segments).toBe(0);
  });
});

describe("featuresWithinKmOfVertices — deduped, ascending feature order", function () {
  it("returns each owning feature once, in ascending index order", function () {
    // Three vertical lines west to east; the features are declared in an order
    // unrelated to their geography so ascending-index order is a real assertion.
    const features = [
      { geometry: lineString([[-86.9, 43.99], [-86.9, 44.01]]) },
      { geometry: lineString([[-87.1, 43.99], [-87.1, 44.01]]) },
      { geometry: lineString([[-87.0, 43.99], [-87.0, 44.01]]) },
      { geometry: lineString([[-80.0, 43.99], [-80.0, 44.01]]) }
    ];
    const segGrid = segmentGridOf(features);
    // A beach's probe vertices spread across all three nearby lines.
    const vertices = [
      { lat: 44.0, lon: -87.1 },
      { lat: 44.0, lon: -87.0 },
      { lat: 44.0, lon: -86.9 },
      { lat: 44.0, lon: -87.0 }
    ];
    expect(featuresWithinKmOfVertices(segGrid, vertices, 0.15)).toEqual([0, 1, 2]);
    expect(featuresWithinKmOfVertices(segGrid, [{ lat: 44.0, lon: -87.0 }], 0.15)).toEqual([2]);
    expect(featuresWithinKmOfVertices(segGrid, [{ lat: 30, lon: -87 }], 0.15)).toEqual([]);
  });

  it("returns a many-segment feature exactly once, however many vertices hit it", function () {
    const lake = { geometry: polygon([circleRing(-87, 44, 0.2, 2000)]) };
    const segGrid = segmentGridOf([lake]);
    const vertices = [];
    for (let i = 0; i < 24; i = i + 1) {
      const angle = 2 * Math.PI * i / 24;
      vertices.push({ lat: 44 + 0.2 * Math.sin(angle), lon: -87 + 0.2 * Math.cos(angle) });
    }
    expect(featuresWithinKmOfVertices(segGrid, vertices, 0.15)).toEqual([0]);
  });

  it("ignores malformed vertices and non-finite radii", function () {
    const segGrid = segmentGridOf([{ geometry: lineString([[-87, 44], [-87, 44.01]]) }]);
    expect(featuresWithinKmOfVertices(segGrid, [null, { lat: "44", lon: -87 }], 0.15)).toEqual([]);
    expect(featuresWithinKmOfVertices(segGrid, [{ lat: 44, lon: -87 }], NaN)).toEqual([]);
    expect(featuresWithinKmOfVertices(segGrid, [{ lat: 44, lon: -87 }], -1)).toEqual([]);
    expect(anySegmentWithinKmOfPoint(segGrid, 44, -87, NaN)).toBe(false);
  });
});

describe("segment grid — the megapolygon an envelope index cannot prune", function () {
  // A ring 5 degrees in radius: its ENVELOPE contains every query point below,
  // exactly like a Great Lake polygon containing every Great Lakes beach. This
  // is the case that made a plain envelope grid useless and the segment grid
  // necessary.
  const vertexCount = 40000;
  const ring = circleRing(-87, 44, 5, vertexCount);
  const lake = { geometry: polygon([ring]) };
  const maxKm = 0.15;

  it("agrees with minGeometryDistanceKm on every probe, near and far", function () {
    const segGrid = segmentGridOf([lake]);
    const rng = makeRng(1357);
    let hits = 0;
    for (let p = 0; p < 120; p = p + 1) {
      // Half the probes sit right against the ring (where the answer is
      // interesting), half anywhere inside the envelope (where it is false).
      let lat;
      let lon;
      if (p % 2 === 0) {
        const angle = rng() * 2 * Math.PI;
        const radius = 5 + (rng() - 0.5) * 0.004;
        lat = 44 + radius * Math.sin(angle);
        lon = -87 + radius * Math.cos(angle);
      } else {
        lat = 44 + (rng() - 0.5) * 9;
        lon = -87 + (rng() - 0.5) * 9;
      }
      const expected = minGeometryDistanceKm(lake.geometry, lat, lon) <= maxKm;
      if (expected) {
        hits = hits + 1;
      }
      expect(anySegmentWithinKmOfPoint(segGrid, lat, lon, maxKm)).toBe(expected);
    }
    // Sanity: the fixture must actually produce hits, or the test proves nothing.
    expect(hits).toBeGreaterThan(20);
  });

  it("examines a bounded slice of the ring per probe, never the whole ring", function () {
    // THE REGRESSION GUARD. Revision 1 of this migration assumed an envelope grid
    // would do; against this shape it degenerates to a full scan — 1,669 beaches
    // x ~40 vertices x ~3e6 lake segments is ~1e11 evaluations, hours of work
    // rather than seconds. The deterministic symptom is segments-examined per
    // probe, so that is what is asserted; wall clock is the secondary check
    // because a loaded CI box can be slow without being wrong.
    const segGrid = segmentGridOf([lake]);
    const before = segmentGridStats(segGrid);
    expect(before.segments).toBeGreaterThanOrEqual(vertexCount);
    expect(before.probes).toBe(0);

    const probes = [];
    const rng = makeRng(2468);
    for (let p = 0; p < 200; p = p + 1) {
      const angle = rng() * 2 * Math.PI;
      probes.push({
        lat: 44 + 5 * Math.sin(angle),
        lon: -87 + 5 * Math.cos(angle)
      });
    }
    const startedAt = Date.now();
    for (const probe of probes) {
      anySegmentWithinKmOfPoint(segGrid, probe.lat, probe.lon, maxKm);
    }
    const elapsedMs = Date.now() - startedAt;
    const after = segmentGridStats(segGrid);
    expect(after.probes).toBe(200);

    const examinedPerProbe = after.segmentsExamined / after.probes;
    // The ring's local density is ~64 segments per cell; a probe sees a handful
    // of cells. A regression to a full scan would put this at 40,000.
    expect(examinedPerProbe).toBeLessThan(1500);
    expect(after.segmentsExamined).toBeLessThan(before.segments);
    // Generous by design: this must fail on a quadratic regression (which is
    // ~30x more work here and grows with the layer) and never on a slow runner.
    expect(elapsedMs).toBeLessThan(2000);

    // And the same bound holds for the per-feature query, which is the one the
    // lakes probe actually calls.
    const featureGrid = segmentGridOf([lake]);
    for (const probe of probes) {
      featuresWithinKmOfVertices(featureGrid, [probe], maxKm);
    }
    const featureStats = segmentGridStats(featureGrid);
    expect(featureStats.segmentsExamined / featureStats.probes).toBeLessThan(1500);
  });
});

// --- one composed pipeline test -------------------------------------------------

describe("composed: one beach resolved against parks, coastline and a lake", function () {
  it("associates a park by bbox and answers both proximity probes from the grids", function () {
    // A miniature of the classification join: envelope grids for the features
    // whose geometry the caller keeps (parks), segment grids for the big linear
    // layers (coastline, lakes), and one beach probed from its own vertices.
    const parks = [
      boxFeature("County Forest", -87.30, 43.90, -86.90, 44.30),
      boxFeature("Village Park", -87.005, 43.995, -86.995, 44.005)
    ];
    const parkGrid = buildLayerGrid(parks);

    const coastline = [{ geometry: lineString([[-87.002, 43.990], [-87.002, 44.010]]) }];
    const coastGrid = segmentGridOf(coastline);

    const lakes = [
      { geometry: polygon([circleRing(-87.5, 44.0, 0.4, 4000)]) },
      { geometry: polygon([circleRing(-87.0, 44.0, 0.003, 200)]) }
    ];
    const lakeGrid = segmentGridOf(lakes);

    // The beach: a short way just east of the coastline, inside both parks.
    const beach = {
      bounds: { minLon: -87.0015, minLat: 43.9995, maxLon: -87.0005, maxLat: 44.0005 },
      vertices: [
        { lat: 43.9995, lon: -87.0015 },
        { lat: 44.0000, lon: -87.0010 },
        { lat: 44.0005, lon: -87.0005 }
      ]
    };

    // Park association: smallest overlapping envelope wins, candidates ascending.
    const candidates = queryGridByBounds(parkGrid, beach.bounds);
    expect(candidates).toEqual([0, 1]);
    let best = null;
    for (const i of candidates) {
      const b = parks[i].bounds;
      const areaDeg2 = (b.maxLat - b.minLat) * (b.maxLon - b.minLon);
      if (best === null || areaDeg2 < best.areaDeg2) {
        best = { name: parks[i].name, areaDeg2: areaDeg2 };
      }
    }
    expect(best.name).toBe("Village Park");

    // coastlinePresent: 150 m from any probe vertex. The nearest vertex is ~40 m
    // from the coastline way.
    let coastlinePresent = false;
    for (const vertex of beach.vertices) {
      if (anySegmentWithinKmOfPoint(coastGrid, vertex.lat, vertex.lon, 0.15)) {
        coastlinePresent = true;
        break;
      }
    }
    expect(coastlinePresent).toBe(true);

    // Nearby lakes: only the small one is within 150 m; the big one's envelope
    // is nowhere near, and the answer arrives in ascending feature order.
    expect(featuresWithinKmOfVertices(lakeGrid, beach.vertices, 0.15)).toEqual([1]);

    // A beach 3 km inland sees neither.
    const inland = [{ lat: 44.03, lon: -86.95 }];
    expect(anySegmentWithinKmOfPoint(coastGrid, inland[0].lat, inland[0].lon, 0.15)).toBe(false);
    expect(featuresWithinKmOfVertices(lakeGrid, inland, 0.15)).toEqual([]);
    expect(queryGridByBounds(parkGrid, {
      minLon: -86.951, minLat: 44.029, maxLon: -86.949, maxLat: 44.031
    })).toEqual([0]);
  });
});
