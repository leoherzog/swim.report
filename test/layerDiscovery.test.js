// test/layerDiscovery.test.js
// Coverage for src/layerDiscovery.js — the replacement for runDiscovery(),
// which answers the two Overpass discovery questions ("named beaches here" and
// "beaches intersecting a named park polygon, plus the water near them")
// locally against prebuilt FlatGeobuf layer arrays.
//
// The module is PURE and has no entrypoint at all, so there is no
// import.meta.main guard to state and nothing to stub: no fetch, no Date, no
// Deno, no filesystem. Every fixture below is built IN MEMORY from readable
// primitives via one named builder per layer shape — no committed binaries, no
// GDAL, no pretest step.
//
// Four things here are load-bearing beyond ordinary coverage, and each one is
// a delete-path defect if it regresses:
//
//   1. REGION SCOPING. The published layers are cut with ONE -spat rectangle
//      over the union of REGIONS, which encloses the whole continental
//      interior. A row upserted from outside every REGIONS bbox is
//      permanently UN-DELETABLE, because reconcileStaleRows scopes its delete
//      candidates with pointInAnyRegion. The blanket assertion is that NO
//      emitted row fails pointInAnyRegion.
//   2. THE POOLED POND-EVIDENCE SET. Production pooled the water evidence
//      once per tile, seeded by every small beach INCLUDING NAMED ONES. A
//      per-beach 60 m set is a strict SUBSET of that, and a beach that loses
//      its evidence is dropped, becomes a name === park_name stale row, and is
//      deleted. Both directions of the difference are asserted below against a
//      per-beach reference built from the module's own pool function.
//   3. THE PARK TWO-TIER SPLIT. Membership is parks-polygon ONLY (map_to_area
//      converts nothing for an unclosed way); naming is the wider tier.
//   4. THE ID ROUND-TRIP. "osm-" + osmType + "-" + osmId is the primary key
//      every KV flag and every enriched column hangs off. Getting it wrong
//      silently orphans the lot, so a known production id is threaded end to
//      end through mergeBeachRows.

import { describe, it, expect } from "vitest";
import {
  discoverFromLayers,
  poolPondWaters,
  beachInAnyParkPolygon,
  classifyLayerFeature
} from "../src/layerDiscovery.js";
import {
  POND_EVIDENCE_RADIUS_M,
  POND_TEST_MAX_BEACH_AREA_DEG2,
  associateParkForBeach,
  beachRecord,
  isPondBeach,
  parkRecord,
  sortLayerFeatures
} from "../src/osmSelect.js";
import { pointInAnyRegion } from "../src/regions.js";
import { pointInGeometry } from "../src/geo.js";
import { mergeBeachRows } from "../src/discovery.js";

// --- fixture builders ----------------------------------------------------------
//
// A LayerFeature is { layer, osmType, osmId, tags, bounds, geometry }. Every
// builder here derives the geometry FROM the bounds so the two can never
// disagree — a fixture whose rectangle and envelope drift apart would make an
// exact membership test pass or fail for reasons that have nothing to do with
// the rule under test.

function box(minLat, minLon, maxLat, maxLon) {
  return { minLat: minLat, minLon: minLon, maxLat: maxLat, maxLon: maxLon };
}

// The closed ring of a bounds rectangle, in GeoJSON [lon, lat] order.
function ringOf(b) {
  return [
    [b.minLon, b.minLat],
    [b.minLon, b.maxLat],
    [b.maxLon, b.maxLat],
    [b.maxLon, b.minLat],
    [b.minLon, b.minLat]
  ];
}

// A closed-way / multipolygon feature: the shape beaches-polygon,
// parks-polygon and water-polygon all carry.
function polyFeature(layer, osmType, osmId, tags, b) {
  return {
    layer: layer,
    osmType: osmType,
    osmId: osmId,
    tags: tags,
    bounds: b,
    geometry: { type: "Polygon", coordinates: [ringOf(b)] }
  };
}

// An open-way feature (beaches-line, parks-line, water-line, coastline-line).
// The line is the rectangle's diagonal, so its envelope is the rectangle and
// no vertex sits at a corner the polygon builders would also produce.
function lineFeature(layer, osmType, osmId, tags, b) {
  return {
    layer: layer,
    osmType: osmType,
    osmId: osmId,
    tags: tags,
    bounds: b,
    geometry: { type: "LineString", coordinates: [[b.minLon, b.minLat], [b.maxLon, b.maxLat]] }
  };
}

// An explicit polyline, for the crossing test where the exact vertices matter.
function pathFeature(layer, osmType, osmId, tags, positions) {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const position of positions) {
    if (position[1] < minLat) { minLat = position[1]; }
    if (position[1] > maxLat) { maxLat = position[1]; }
    if (position[0] < minLon) { minLon = position[0]; }
    if (position[0] > maxLon) { maxLon = position[0]; }
  }
  return {
    layer: layer,
    osmType: osmType,
    osmId: osmId,
    tags: tags,
    bounds: box(minLat, minLon, maxLat, maxLon),
    geometry: { type: "LineString", coordinates: positions }
  };
}

// A node feature: the geometry is a Point, so probeVertices yields the point
// itself and the way/node cases need no separate branch anywhere.
function nodeFeature(layer, osmId, tags, lat, lon) {
  return {
    layer: layer,
    osmType: "node",
    osmId: osmId,
    tags: tags,
    bounds: box(lat, lon, lat, lon),
    geometry: { type: "Point", coordinates: [lon, lat] }
  };
}

// The other-relations shape: GDAL emits a GeometryCollection for a relation it
// could not assemble into rings, and a GeometryCollection has no reliable ring
// structure. These features take the envelope-overlap fallback.
function relationFeature(osmId, tags, b) {
  return {
    layer: "other-relations",
    osmType: "relation",
    osmId: osmId,
    tags: tags,
    bounds: b,
    geometry: {
      type: "GeometryCollection",
      geometries: [{ type: "LineString", coordinates: [[b.minLon, b.minLat], [b.maxLon, b.maxLat]] }]
    }
  };
}

// A feature with no usable envelope — the record builders return null for it
// and step 0 must reject it before deriving a coordinate from NaN.
function bogusFeature(layer, osmType, osmId, tags) {
  return { layer: layer, osmType: osmType, osmId: osmId, tags: tags, bounds: null, geometry: null };
}

// The layers argument, with every logical layer defaulting to empty so a test
// only names the ones it cares about.
function layersOf(overrides) {
  const base = { beaches: [], parksPoly: [], parksName: [], coastline: [], water: [] };
  const keys = Object.keys(overrides || {});
  for (const key of keys) {
    base[key] = overrides[key];
  }
  return base;
}

// The raw degree product of an envelope, mirroring bboxAreaDeg2 — the quantity
// both the pond-skip guard and the smallest-park association compare on.
function bboxArea(b) {
  return (b.maxLat - b.minLat) * (b.maxLon - b.minLon);
}

function idsOf(rows) {
  return rows.map(function (row) { return row.osmId; });
}

function findById(rows, osmId) {
  return rows.find(function (row) { return row.osmId === osmId; });
}

// --- step 0: region scoping (D18/B2) -------------------------------------------

describe("discoverFromLayers: region scoping (step 0)", () => {
  // The union -spat rectangle over REGIONS encloses the continental interior.
  // These two beaches are real-shaped and well-formed; the only thing wrong
  // with them is that they are nowhere near a Great Lake.
  const inlandNamed = polyFeature("beaches-polygon", "way", 8001,
    { natural: "beach", name: "Devils Lake Beach" }, box(43.42, -89.74, 43.43, -89.73));
  const inlandUnnamed = polyFeature("beaches-polygon", "way", 8002,
    { natural: "beach" }, box(43.42, -89.72, 43.4201, -89.7199));
  const inlandPark = polyFeature("parks-polygon", "way", 8003,
    { leisure: "park", name: "Devils Lake State Park" }, box(43.40, -89.76, 43.44, -89.70));

  const coastalNamed = polyFeature("beaches-polygon", "way", 8010,
    { natural: "beach", name: "Ottawa Beach" }, box(42.77, -86.22, 42.78, -86.21));

  it("drops an out-of-region named beach and counts it", () => {
    const out = discoverFromLayers(layersOf({ beaches: [inlandNamed, coastalNamed] }));
    expect(idsOf(out.namedRows)).toEqual([8010]);
    expect(out.layerCounts.outOfRegion).toBe(1);
    expect(out.layerCounts.beaches).toBe(2);
  });

  it("drops an out-of-region PARK beach even when its park polygon contains it", () => {
    // Without step 0 this row would be upserted, would sit outside every
    // REGIONS bbox, and would therefore never again be a delete candidate.
    const out = discoverFromLayers(layersOf({
      beaches: [inlandUnnamed],
      parksPoly: [inlandPark],
      parksName: [inlandPark]
    }));
    expect(out.parkBeaches).toEqual([]);
    expect(out.layerCounts.outOfRegion).toBe(1);
    // The beach never reached the membership test at all — it was gone before
    // anything else looked at it.
    expect(out.layerCounts.membershipRejected).toBe(0);
  });

  it("counts a feature with no usable envelope as an out-of-region drop", () => {
    const out = discoverFromLayers(layersOf({
      beaches: [bogusFeature("beaches-polygon", "way", 8020, { natural: "beach", name: "Nowhere" })]
    }));
    expect(out.namedRows).toEqual([]);
    expect(out.layerCounts.outOfRegion).toBe(1);
  });

  it("emits NO row for which pointInAnyRegion is false", () => {
    // The blanket assertion. The fixture deliberately mixes in-region and
    // out-of-region beaches of every shape the layers can produce.
    const park = polyFeature("parks-polygon", "way", 8100,
      { leisure: "park", name: "Big Park" }, box(41.0, -92.0, 47.0, -75.0));
    const beaches = [
      inlandNamed,
      inlandUnnamed,
      coastalNamed,
      polyFeature("beaches-polygon", "way", 8101, { natural: "beach" }, box(41.60, -87.20, 41.6002, -87.1998)),
      nodeFeature("beaches-point", 8102, { natural: "beach", name: "Point Beach" }, 44.62, -87.51),
      nodeFeature("beaches-point", 8103, { natural: "beach", name: "Interior Pond Beach" }, 44.62, -90.51),
      relationFeature(8104, { natural: "beach" }, box(45.90, -85.30, 45.91, -85.29)),
      relationFeature(8105, { natural: "beach" }, box(45.90, -90.30, 45.91, -90.29)),
      lineFeature("beaches-line", "way", 8106, { natural: "beach", name: "Erie Strand" }, box(41.90, -80.40, 41.9005, -80.3995))
    ];
    const out = discoverFromLayers(layersOf({ beaches: beaches, parksPoly: [park], parksName: [park] }));
    expect(out.namedRows.length).toBeGreaterThan(0);
    expect(out.parkBeaches.length).toBeGreaterThan(0);
    for (const row of out.namedRows) {
      expect(pointInAnyRegion(row.lat, row.lon)).toBe(true);
    }
    for (const row of out.parkBeaches) {
      expect(pointInAnyRegion(row.lat, row.lon)).toBe(true);
    }
    // The three interior fixtures (8001, 8002, 8103, 8105) are all gone.
    expect(idsOf(out.namedRows).indexOf(8001)).toBe(-1);
    expect(idsOf(out.namedRows).indexOf(8103)).toBe(-1);
    expect(idsOf(out.parkBeaches).indexOf(8002)).toBe(-1);
    expect(idsOf(out.parkBeaches).indexOf(8105)).toBe(-1);
  });
});

// --- the named pass (buildQuery + fetchBeaches) --------------------------------

describe("discoverFromLayers: the named pass", () => {
  it("selects named natural=beach AND named leisure=beach_resort, and nothing else", () => {
    const out = discoverFromLayers(layersOf({
      beaches: [
        polyFeature("beaches-polygon", "way", 1, { natural: "beach", name: "Named Beach" }, box(42.77, -86.22, 42.78, -86.21)),
        polyFeature("beaches-polygon", "way", 2, { leisure: "beach_resort", name: "Named Resort" }, box(42.80, -86.22, 42.81, -86.21)),
        polyFeature("beaches-polygon", "way", 3, { natural: "beach" }, box(42.83, -86.22, 42.84, -86.21)),
        polyFeature("beaches-polygon", "way", 4, { natural: "beach", name: "" }, box(42.86, -86.22, 42.87, -86.21)),
        polyFeature("beaches-polygon", "way", 5, { leisure: "park", name: "Not A Beach" }, box(42.89, -86.22, 42.90, -86.21))
      ]
    }));
    expect(idsOf(out.namedRows)).toEqual([1, 2]);
    expect(out.layerCounts.named).toBe(2);
  });

  it("puts the row at the envelope MIDPOINT, which is what 'out center' produced", () => {
    const out = discoverFromLayers(layersOf({
      beaches: [polyFeature("beaches-polygon", "way", 1, { natural: "beach", name: "Ottawa Beach" },
        box(42.77, -86.22, 42.78, -86.21))]
    }));
    expect(out.namedRows[0].lat).toBeCloseTo(42.775, 12);
    expect(out.namedRows[0].lon).toBeCloseTo(-86.215, 12);
    // The named row carries exactly the fetchBeaches shape and no geometry.
    expect(Object.keys(out.namedRows[0]).sort()).toEqual(["lat", "lon", "name", "osmId", "osmType"]);
  });

  it("uses a node's own coordinate", () => {
    const out = discoverFromLayers(layersOf({
      beaches: [nodeFeature("beaches-point", 3, { natural: "beach", name: "The First Curve" }, 43.99, -86.48)]
    }));
    expect(out.namedRows[0].lat).toBe(43.99);
    expect(out.namedRows[0].lon).toBe(-86.48);
  });

  it("dedupes a (type, id) that lands in two source layers, keeping the first", () => {
    // A closed way GDAL emits to both the line and the polygon layer would
    // otherwise be upserted twice with different geometry.
    const b = box(42.77, -86.22, 42.78, -86.21);
    const out = discoverFromLayers(layersOf({
      beaches: [
        polyFeature("beaches-polygon", "way", 7, { natural: "beach", name: "Twice Beach" }, b),
        lineFeature("beaches-line", "way", 7, { natural: "beach", name: "Twice Beach" }, box(42.70, -86.30, 42.71, -86.29))
      ]
    }));
    expect(out.namedRows.length).toBe(1);
    expect(out.namedRows[0].lat).toBeCloseTo(42.775, 12);
  });
});

// --- classifyLayerFeature: the parseParkBeachElements branch chain -------------
//
// These six are the re-fixtured parseParkBeachElements assertions. The chain
// order (beach, then park, then water) was one if/else-if in the Overpass
// parser and is load-bearing: a dual-tagged element is a beach ONLY, and a
// named park-tagged lake is a PARK, not water.

describe("classifyLayerFeature (the branch chain, re-fixtured onto layers)", () => {
  it("routes beaches, parks and water to their own branches", () => {
    const beach = classifyLayerFeature(polyFeature("beaches-polygon", "way", 1,
      { natural: "beach", name: "Ottawa Beach" }, box(42.77, -86.22, 42.78, -86.21)));
    const park = classifyLayerFeature(polyFeature("parks-polygon", "relation", 4,
      { leisure: "park", name: "Holland State Park" }, box(42.76, -86.23, 42.79, -86.20)));
    const water = classifyLayerFeature(lineFeature("coastline-line", "way", 9,
      { natural: "coastline" }, box(43.04, -86.26, 43.06, -86.25)));
    expect(beach.kind).toBe("beach");
    expect(beach.record.lat).toBeCloseTo(42.775, 12);
    expect(beach.record.lon).toBeCloseTo(-86.215, 12);
    expect(park.kind).toBe("park");
    expect(park.record.name).toBe("Holland State Park");
    expect(water.kind).toBe("water");
    expect(water.record.shoreline).toBe(true);
  });

  it("populates locality from the beach element's own loc_name tag", () => {
    const withLoc = classifyLayerFeature(polyFeature("beaches-polygon", "way", 1,
      { natural: "beach", loc_name: "Hamlin Lake" }, box(43.95, -86.49, 43.97, -86.47)));
    const blankLoc = classifyLayerFeature(polyFeature("beaches-polygon", "way", 2,
      { natural: "beach", loc_name: "   " }, box(43.90, -86.49, 43.92, -86.47)));
    const noLoc = classifyLayerFeature(polyFeature("beaches-polygon", "way", 3,
      { natural: "beach" }, box(43.80, -86.49, 43.82, -86.47)));
    expect(withLoc.record.locality).toBe("Hamlin Lake");
    expect(blankLoc.record.locality).toBe(null);
    expect(noLoc.record.locality).toBe(null);
  });

  it("returns null for an unnamed park and for a feature without usable bounds", () => {
    expect(classifyLayerFeature(polyFeature("parks-polygon", "way", 1,
      { leisure: "park" }, box(42.0, -86.0, 42.1, -85.9)))).toBe(null);
    expect(classifyLayerFeature(bogusFeature("beaches-polygon", "way", 2,
      { natural: "beach", name: "No Coords Beach" }))).toBe(null);
    expect(classifyLayerFeature(polyFeature("parks-polygon", "way", 3,
      { leisure: "park", name: "Real Park" }, box(42.0, -86.0, 42.1, -85.9))).kind).toBe("park");
  });

  it("treats a feature tagged both beach and park as a beach only", () => {
    const classified = classifyLayerFeature(polyFeature("beaches-polygon", "way", 1,
      { natural: "beach", leisure: "park", name: "Grand Haven State Park" },
      box(43.04, -86.25, 43.06, -86.24)));
    expect(classified.kind).toBe("beach");
  });

  it("marks natural=coastline as shoreline and natural=water as not", () => {
    const pond = classifyLayerFeature(polyFeature("water-polygon", "way", 1,
      { natural: "water", name: "Hawthorn Pond" }, box(42.7776, -86.0273, 42.7793, -86.0258)));
    const shore = classifyLayerFeature(lineFeature("coastline-line", "way", 2,
      { natural: "coastline" }, box(43.04, -86.26, 43.06, -86.25)));
    expect(pond.kind).toBe("water");
    expect(pond.record.shoreline).toBe(false);
    expect(pond.record.areaDeg2).toBeGreaterThan(0);
    expect(shore.record.shoreline).toBe(true);
  });

  it("classifies a named park-tagged lake as a PARK, not water", () => {
    // A named protected lake must keep donating its name to contained beaches;
    // losing its water role only errs toward keeping a beach, which is safe.
    const classified = classifyLayerFeature(polyFeature("water-polygon", "way", 1,
      { natural: "water", boundary: "protected_area", name: "Hawthorn Pond Natural Area" },
      box(42.776, -86.028, 42.781, -86.018)));
    expect(classified.kind).toBe("park");
  });

  it("returns null for a non-null non-object and for an untagged feature", () => {
    expect(classifyLayerFeature(null)).toBe(null);
    expect(classifyLayerFeature(polyFeature("other-relations", "relation", 1,
      { landuse: "forest" }, box(42.0, -86.0, 42.1, -85.9)))).toBe(null);
  });
});

// --- step 4: (area.pa) membership ----------------------------------------------

describe("discoverFromLayers: park membership is polygon-only and intersection-based", () => {
  it("admits a beach whose vertex is inside a park polygon", () => {
    const park = polyFeature("parks-polygon", "way", 200, { leisure: "park", name: "Dune Park" },
      box(43.20, -86.50, 43.21, -86.49));
    const beach = polyFeature("beaches-polygon", "way", 201, { natural: "beach" },
      box(43.2050, -86.4950, 43.2051, -86.4949));
    const out = discoverFromLayers(layersOf({ beaches: [beach], parksPoly: [park], parksName: [park] }));
    expect(idsOf(out.parkBeaches)).toEqual([201]);
    expect(out.parkBeaches[0].parkName).toBe("Dune Park");
  });

  it("admits a beach way that CROSSES a park ring with no vertex inside (m8)", () => {
    // Overpass's (area.pa) is an intersection test: a way that enters a park
    // and leaves again is in the area even with every vertex outside it. A
    // vertex-in-polygon test alone is a strict SUBSET of that, and a subset of
    // the membership set is a subset of the park-origin ROWS, which
    // reconcileStaleRows reads as "gone from OSM" and deletes.
    const park = polyFeature("parks-polygon", "way", 210, { leisure: "park", name: "Ribbon Park" },
      box(43.20, -86.50, 43.21, -86.49));
    const beach = pathFeature("beaches-line", "way", 211, { natural: "beach" },
      [[-86.505, 43.205], [-86.485, 43.205]]);
    // Neither endpoint is inside the park — the vertex test alone would reject.
    expect(pointInGeometry(park.geometry, 43.205, -86.505)).toBe(false);
    expect(pointInGeometry(park.geometry, 43.205, -86.485)).toBe(false);
    const out = discoverFromLayers(layersOf({ beaches: [beach], parksPoly: [park], parksName: [park] }));
    expect(idsOf(out.parkBeaches)).toEqual([211]);
  });

  it("rejects a beach that overlaps no park polygon at all, and counts it", () => {
    const park = polyFeature("parks-polygon", "way", 220, { leisure: "park", name: "Far Park" },
      box(43.20, -86.50, 43.21, -86.49));
    const beach = polyFeature("beaches-polygon", "way", 221, { natural: "beach" },
      box(43.40, -86.30, 43.4001, -86.2999));
    const out = discoverFromLayers(layersOf({ beaches: [beach], parksPoly: [park], parksName: [park] }));
    expect(out.parkBeaches).toEqual([]);
    expect(out.layerCounts.membershipRejected).toBe(1);
  });

  it("rejects a beach whose envelope overlaps a park but whose geometry does not touch it", () => {
    // Envelope overlap is only the CANDIDACY filter; the exact tests decide.
    // An L-shaped relationship (overlapping bboxes, disjoint shapes) must not
    // become a row purely on rectangles.
    const park = polyFeature("parks-polygon", "way", 230, { leisure: "park", name: "Corner Park" },
      box(43.200, -86.500, 43.210, -86.490));
    // An L that hugs the park's north-east corner from outside: its bbox
    // (43.2050..43.2150, -86.4950..-86.4800) genuinely OVERLAPS the park's
    // (43.200..43.210, -86.500..-86.490), so the grid hands it over as a
    // candidate — and the exact tests then reject it.
    const beach = pathFeature("beaches-line", "way", 231, { natural: "beach" },
      [[-86.4800, 43.2050], [-86.4800, 43.2150], [-86.4950, 43.2150]]);
    expect(beach.bounds.minLat).toBeLessThan(park.bounds.maxLat);
    expect(beach.bounds.minLon).toBeLessThan(park.bounds.maxLon);
    const out = discoverFromLayers(layersOf({ beaches: [beach], parksPoly: [park], parksName: [park] }));
    expect(out.parkBeaches).toEqual([]);
    expect(out.layerCounts.membershipRejected).toBe(1);
  });

  it("does NOT grant membership from a line-only park (map_to_area converts nothing)", () => {
    // parks-line features name beaches; they never admit them. Merging the two
    // tiers would over-admit unnamed beaches into parks that have no area.
    const linePark = lineFeature("parks-line", "way", 734, { leisure: "park", name: "Lone Trail Park" },
      box(43.3499, -86.4001, 43.3502, -86.3998));
    const beach = polyFeature("beaches-polygon", "way", 733, { natural: "beach" },
      box(43.35000, -86.40000, 43.35010, -86.39990));
    const out = discoverFromLayers(layersOf({
      beaches: [beach], parksPoly: [], parksName: [linePark]
    }));
    expect(out.parkBeaches).toEqual([]);
    expect(out.layerCounts.membershipRejected).toBe(1);
  });

  it("falls back to envelope overlap for a beach that arrives only via other-relations", () => {
    // A GeometryCollection has no reliable ring structure: pointInGeometry
    // would answer "not inside" for every point, which is the DELETE
    // direction. The documented widening admits it on envelope overlap.
    const park = polyFeature("parks-polygon", "way", 240, { leisure: "park", name: "Relation Park" },
      box(45.90, -85.32, 45.92, -85.28));
    const beach = relationFeature(241, { natural: "beach" }, box(45.905, -85.31, 45.906, -85.30));
    const out = discoverFromLayers(layersOf({ beaches: [beach], parksPoly: [park], parksName: [park] }));
    expect(idsOf(out.parkBeaches)).toEqual([241]);
    expect(out.parkBeaches[0].osmType).toBe("relation");
    expect(out.parkBeaches[0].parkName).toBe("Relation Park");
  });

  it("beachInAnyParkPolygon admits on envelope overlap when a PARK's geometry is unusable", () => {
    // The mirror of the fallback above. A parks-polygon record whose geometry
    // failed to decode would otherwise reject every beach in it, and each of
    // those unnamed park-origin rows is a delete.
    const park = { osmType: "way", osmId: 250, name: "Broken Park",
      bounds: box(43.20, -86.50, 43.21, -86.49), areaDeg2: 1e-4, geometry: null };
    const beach = beachRecord(polyFeature("beaches-polygon", "way", 251, { natural: "beach" },
      box(43.2050, -86.4950, 43.2051, -86.4949)));
    const grid = { count: 1, cells: new Map([[0, [0]]]), oversized: [0],
      minLat: [43.20], minLon: [-86.50], maxLat: [43.21], maxLon: [-86.49] };
    expect(beachInAnyParkPolygon(beach, { type: "Polygon", coordinates: [ringOf(beach.bounds)] },
      [park], grid)).toBe(true);
  });

  it("beachInAnyParkPolygon is false when the grid produces no candidate at all", () => {
    const beach = beachRecord(polyFeature("beaches-polygon", "way", 252, { natural: "beach" },
      box(43.2050, -86.4950, 43.2051, -86.4949)));
    const emptyGrid = { count: 0, cells: new Map(), oversized: [],
      minLat: [], minLon: [], maxLat: [], maxLon: [] };
    expect(beachInAnyParkPolygon(beach, beach.geometry, [], emptyGrid)).toBe(false);
  });

  it("keeps leisure=beach_resort OUT of the park pass (Overpass parity)", () => {
    // The park query ran nwr[natural=beach](area.pa) and nothing else, so a
    // beach_resort never entered the park pass and never got a park name.
    const park = polyFeature("parks-polygon", "way", 260, { leisure: "park", name: "Resort Park" },
      box(43.20, -86.50, 43.21, -86.49));
    const resort = polyFeature("beaches-polygon", "way", 261,
      { leisure: "beach_resort", name: "Lakeside Resort" }, box(43.2050, -86.4950, 43.2051, -86.4949));
    const out = discoverFromLayers(layersOf({ beaches: [resort], parksPoly: [park], parksName: [park] }));
    expect(idsOf(out.namedRows)).toEqual([261]);
    expect(out.parkBeaches).toEqual([]);
  });
});

// --- step 5: the naming tier and the association rule ---------------------------

describe("discoverFromLayers: park NAMING uses the wider parksName tier", () => {
  it("lets a named park way present only in parks-line donate its name", () => {
    // Membership comes from the big polygon; the smaller line-only park wins
    // the association because association is smallest-overlapping-bbox.
    const regionalForest = polyFeature("parks-polygon", "way", 731,
      { leisure: "park", name: "Regional Forest" }, box(43.29, -86.41, 43.31, -86.39));
    const shorelineTrail = lineFeature("parks-line", "way", 732,
      { leisure: "park", name: "Shoreline Trail Park" }, box(43.2999, -86.4001, 43.3002, -86.3998));
    const beach = polyFeature("beaches-polygon", "way", 730, { natural: "beach" },
      box(43.30000, -86.40000, 43.30010, -86.39990));
    const out = discoverFromLayers(layersOf({
      beaches: [beach],
      parksPoly: [regionalForest],
      parksName: [regionalForest, shorelineTrail]
    }));
    expect(idsOf(out.parkBeaches)).toEqual([730]);
    expect(out.parkBeaches[0].parkName).toBe("Shoreline Trail Park");
    expect(out.parkBeaches[0].parkKey).toBe("way/732");
    expect(out.layerCounts.parksPoly).toBe(1);
    expect(out.layerCounts.parksName).toBe(2);
  });

  it("attaches the smaller-bbox overlapping park and builds parkKey from its element identity", () => {
    const bigWoods = polyFeature("parks-polygon", "way", 200,
      { leisure: "nature_reserve", name: "Big Woods Reserve" }, box(42.9, -85.1, 43.1, -84.9));
    const littleCove = polyFeature("parks-polygon", "relation", 300,
      { leisure: "park", name: "Little Cove Park" }, box(42.999, -85.001, 43.001, -84.999));
    const beach = polyFeature("beaches-polygon", "way", 102, { natural: "beach" },
      box(43.0, -85.0004, 43.0004, -85.0));
    const out = discoverFromLayers(layersOf({
      beaches: [beach],
      parksPoly: [bigWoods, littleCove],
      parksName: [bigWoods, littleCove]
    }));
    expect(out.parkBeaches[0].parkName).toBe("Little Cove Park");
    expect(out.parkBeaches[0].parkKey).toBe("relation/300");
    expect(out.parkBeaches[0].name).toBe(null);
  });

  it("resolves an equal-area park tie by the restored node-way-relation scan order", () => {
    // Both parks have identical bboxes, so associateParkForBeach's tie-break
    // is FIRST SEEN — and "first seen" is only stable because every layer
    // array is re-sorted into Overpass's node/way/relation, id-ascending
    // order before anything reads it. FlatGeobuf's Hilbert order reshuffles on
    // every rebuild, which would otherwise flip the name.
    const b = box(43.20, -86.50, 43.21, -86.49);
    const wayPark = polyFeature("parks-polygon", "way", 999, { leisure: "park", name: "Way Park" }, b);
    const relPark = polyFeature("parks-polygon", "relation", 1, { leisure: "park", name: "Relation Park" }, b);
    const beach = polyFeature("beaches-polygon", "way", 400, { natural: "beach" },
      box(43.2050, -86.4950, 43.2051, -86.4949));
    const forward = discoverFromLayers(layersOf({
      beaches: [beach], parksPoly: [wayPark, relPark], parksName: [wayPark, relPark]
    }));
    const reversed = discoverFromLayers(layersOf({
      beaches: [beach], parksPoly: [relPark, wayPark], parksName: [relPark, wayPark]
    }));
    expect(forward.parkBeaches[0].parkName).toBe("Way Park");
    expect(reversed.parkBeaches[0].parkName).toBe("Way Park");
  });

  it("emits parkName/parkKey null when no park envelope overlaps the beach", () => {
    // Membership from a polygon whose GEOMETRY the beach crosses, association
    // from the naming tier, which here contains a park the beach bbox misses.
    const park = polyFeature("parks-polygon", "way", 410, { leisure: "park", name: "Host Park" },
      box(43.20, -86.50, 43.21, -86.49));
    const beach = polyFeature("beaches-polygon", "way", 411, { natural: "beach" },
      box(43.2050, -86.4950, 43.2051, -86.4949));
    const out = discoverFromLayers(layersOf({ beaches: [beach], parksPoly: [park], parksName: [] }));
    expect(out.parkBeaches[0].parkName).toBe(null);
    expect(out.parkBeaches[0].parkKey).toBe(null);
  });
});

describe("discoverFromLayers: grid-backed association equals the full-list scan (MJ-8)", () => {
  // A deterministic LCG, so a failure is reproducible and the fixture never
  // changes between runs. Randomness here is about COVERAGE of the overlap
  // geometry, not about sampling.
  function lcg(seed) {
    let state = seed >>> 0;
    return function () {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  it("produces the identical park for every beach on a randomised fixture", () => {
    const random = lcg(20260901);
    // One umbrella polygon guarantees membership for every beach so the test
    // is about ASSOCIATION alone; it is also the largest park, so it only ever
    // wins when nothing smaller overlaps.
    const umbrella = polyFeature("parks-polygon", "relation", 1,
      { leisure: "park", name: "Umbrella Reserve" }, box(43.30, -86.60, 43.50, -86.40));
    const parksPoly = [umbrella];
    const parksName = [umbrella];
    for (let i = 0; i < 80; i++) {
      const minLat = 43.30 + random() * 0.19;
      const minLon = -86.60 + random() * 0.19;
      const height = 0.0005 + random() * 0.02;
      const width = 0.0005 + random() * 0.02;
      const b = box(minLat, minLon, minLat + height, minLon + width);
      // A mix of polygon and line parks so both naming tiers are exercised.
      const feature = (i % 3 === 0)
        ? lineFeature("parks-line", "way", 2000 + i, { leisure: "park", name: "Park " + String(i) }, b)
        : polyFeature("parks-polygon", "way", 2000 + i, { leisure: "nature_reserve", name: "Park " + String(i) }, b);
      if (i % 3 !== 0) {
        parksPoly.push(feature);
      }
      parksName.push(feature);
    }
    const beaches = [];
    for (let i = 0; i < 60; i++) {
      const minLat = 43.31 + random() * 0.17;
      const minLon = -86.59 + random() * 0.17;
      const b = box(minLat, minLon, minLat + 0.0004, minLon + 0.0004);
      beaches.push(polyFeature("beaches-polygon", "way", 3000 + i, { natural: "beach" }, b));
    }

    const out = discoverFromLayers(layersOf({
      beaches: beaches, parksPoly: parksPoly, parksName: parksName
    }));
    expect(out.parkBeaches.length).toBe(60);

    // The reference: the un-gridded O(n*m) scan the grid replaces, over the
    // same sorted naming tier in the same order.
    const referenceParks = [];
    const sortedParksName = sortLayerFeatures(parksName);
    for (const feature of sortedParksName) {
      const record = parkRecord(feature);
      if (record !== null) {
        referenceParks.push(record);
      }
    }
    for (const row of out.parkBeaches) {
      const feature = beaches.find(function (f) { return f.osmId === row.osmId; });
      const expected = associateParkForBeach(beachRecord(feature), referenceParks);
      expect(row.parkName).toBe(expected === null ? null : expected.name);
      expect(row.parkKey).toBe(expected === null ? null : expected.osmType + "/" + String(expected.osmId));
    }
  });
});

// --- step 6: the POOLED pond-evidence set (B1/BL-1) -----------------------------

describe("poolPondWaters", () => {
  it("returns an empty pool when there are no seeds or no waters", () => {
    const water = polyFeature("water-polygon", "way", 1, { natural: "water" }, box(43.0, -86.0, 43.001, -85.999));
    const seed = { bounds: box(43.0, -86.0, 43.0001, -85.9999), geometry: null, vertices: [{ lat: 43.0, lon: -86.0 }] };
    expect(poolPondWaters([], [water], POND_EVIDENCE_RADIUS_M)).toEqual([]);
    expect(poolPondWaters([seed], [], POND_EVIDENCE_RADIUS_M)).toEqual([]);
  });

  it("admits water inside the radius and rejects water outside it, symmetrically", () => {
    // The seed is a SHORT way and the water a LONG one, so the "min over seed
    // vertices of distance-to-water-geometry" half is the one that has to fire
    // — a long water way passing beside a short beach has no vertex near it.
    const seedBox = box(43.00000, -86.50000, 43.00002, -86.49998);
    const seed = {
      bounds: seedBox,
      geometry: { type: "Polygon", coordinates: [ringOf(seedBox)] },
      vertices: [{ lat: 43.0, lon: -86.5 }, { lat: 43.00002, lon: -86.49998 }]
    };
    // A 2 km-long coastline 22 m north of the seed: no vertex of it is near.
    const near = pathFeature("coastline-line", "way", 900, { natural: "coastline" },
      [[-86.51, 43.00022], [-86.49, 43.00022]]);
    // The same line 200 m north.
    const far = pathFeature("coastline-line", "way", 901, { natural: "coastline" },
      [[-86.51, 43.00182], [-86.49, 43.00182]]);
    const pooled = poolPondWaters([seed], [near, far], POND_EVIDENCE_RADIUS_M);
    expect(pooled.length).toBe(1);
    expect(pooled[0].shoreline).toBe(true);
    expect(pooled[0].bounds.minLat).toBeCloseTo(43.00022, 8);
  });

  it("defaults its radius to POND_EVIDENCE_RADIUS_M when none is given", () => {
    const seedBox = box(43.00000, -86.50000, 43.00002, -86.49998);
    const seed = {
      bounds: seedBox,
      geometry: { type: "Polygon", coordinates: [ringOf(seedBox)] },
      vertices: [{ lat: 43.0, lon: -86.5 }]
    };
    const near = pathFeature("water-line", "way", 902, { natural: "water" },
      [[-86.51, 43.00022], [-86.49, 43.00022]]);
    expect(poolPondWaters([seed], [near]).length).toBe(1);
  });
});

describe("discoverFromLayers: the pond pool is RUN-SCOPED, not per-beach (B1)", () => {
  // The per-beach reference: the module's own pool function seeded with ONE
  // beach. That is exactly the revision-1 behaviour this restructuring
  // replaced, and it is a strict SUBSET of the pooled set.
  function perBeachPondVerdict(beachFeature, waterFeatures) {
    const record = beachRecord(beachFeature);
    const seed = {
      bounds: record.bounds,
      geometry: beachFeature.geometry,
      vertices: record.vertices
    };
    const waters = poolPondWaters([seed], waterFeatures, POND_EVIDENCE_RADIUS_M);
    return isPondBeach(record, waters);
  }

  // Scenario A: a pond ~87 m from the unnamed beach (inside isPondBeach's
  // +/-0.001 deg padded bbox, outside a 60 m per-beach gather) but ~2 m from a
  // neighbouring NAMED beach, which seeds it under production's rule.
  const parkA = polyFeature("parks-polygon", "way", 700, { leisure: "park", name: "Dune Ridge Park" },
    box(42.99800, -86.50200, 43.00200, -86.49800));
  const unnamedA = polyFeature("beaches-polygon", "way", 701, { natural: "beach" },
    box(43.00000, -86.50000, 43.00002, -86.49998));
  const namedA = polyFeature("beaches-polygon", "way", 702,
    { natural: "beach", name: "North Point Beach" }, box(43.00092, -86.49995, 43.00094, -86.49993));
  const pondA = polyFeature("water-polygon", "way", 901, { natural: "water" },
    box(43.00080, -86.50000, 43.00090, -86.49990));

  // Scenario B: the mirror. The unnamed beach has a pond right beside it AND a
  // coastline way ~89 m away that only a neighbouring named beach can seed.
  const parkB = polyFeature("parks-polygon", "way", 710, { leisure: "park", name: "Point Light Park" },
    box(43.09800, -86.50200, 43.10200, -86.49800));
  const unnamedB = polyFeature("beaches-polygon", "way", 711, { natural: "beach" },
    box(43.10000, -86.50000, 43.10002, -86.49998));
  const namedB = polyFeature("beaches-polygon", "way", 713,
    { natural: "beach", name: "Light Keeper Beach" }, box(43.10086, -86.49990, 43.10088, -86.49988));
  const pondB = polyFeature("water-polygon", "way", 911, { natural: "water" },
    box(43.10010, -86.50010, 43.10020, -86.50000));
  const shoreB = lineFeature("coastline-line", "way", 912, { natural: "coastline" },
    box(43.10082, -86.49990, 43.10084, -86.49980));

  it("DROPS a beach a per-beach 60 m set would keep (the accepted widening)", () => {
    // Direction check first: the per-beach set sees nothing and keeps it.
    expect(perBeachPondVerdict(unnamedA, [pondA])).toBe(false);
    const out = discoverFromLayers(layersOf({
      beaches: [unnamedA, namedA],
      parksPoly: [parkA],
      parksName: [parkA],
      water: [pondA]
    }));
    // The pooled set gathered the pond via the NAMED neighbour's seed, so the
    // unnamed sliver is correctly recognised as sitting on pond-only water.
    expect(idsOf(out.parkBeaches)).toEqual([702]);
    expect(out.layerCounts.droppedPond).toBe(1);
  });

  it("KEEPS a beach a per-beach 60 m set would drop (the B1 delete this fixes)", () => {
    // Direction check first: the per-beach set sees only the pond and drops it.
    expect(perBeachPondVerdict(unnamedB, [pondB, shoreB])).toBe(true);
    const out = discoverFromLayers(layersOf({
      beaches: [unnamedB, namedB],
      parksPoly: [parkB],
      parksName: [parkB],
      water: [pondB],
      coastline: [shoreB]
    }));
    // Under the per-beach set this row vanishes, becomes a name === park_name
    // stale row, and is DELETED well inside every proportional rail.
    expect(idsOf(out.parkBeaches)).toEqual([711, 713]);
    expect(out.layerCounts.droppedPond).toBe(0);
  });

  it("keeps the NAMED beach on pond-sized water (the pond filter is unnamed-only)", () => {
    const out = discoverFromLayers(layersOf({
      beaches: [unnamedA, namedA],
      parksPoly: [parkA],
      parksName: [parkA],
      water: [pondA]
    }));
    const named = findById(out.parkBeaches, 702);
    expect(named.name).toBe("North Point Beach");
  });

  it("skips the pond test entirely for a beach at or above POND_TEST_MAX_BEACH_AREA_DEG2", () => {
    // An oversized beach never seeded the evidence pool and cannot plausibly
    // sit only on pond-sized water, so skipping the test can only err toward
    // keeping. Both beaches here sit ON THE SAME POND — the ONLY thing
    // separating them is which side of POND_TEST_MAX_BEACH_AREA_DEG2 their own
    // envelope falls on.
    const bigBox = box(43.0000, -86.5000, 43.0400, -86.4600);
    const smallBox = box(43.0000, -86.4999, 43.0001, -86.4998);
    expect(bboxArea(bigBox)).toBeGreaterThanOrEqual(POND_TEST_MAX_BEACH_AREA_DEG2);
    expect(bboxArea(smallBox)).toBeLessThan(POND_TEST_MAX_BEACH_AREA_DEG2);
    const oversized = polyFeature("beaches-polygon", "way", 720, { natural: "beach" }, bigBox);
    const tiny = polyFeature("beaches-polygon", "way", 721, { natural: "beach" }, smallBox);
    const pond = polyFeature("water-polygon", "way", 920, { natural: "water" },
      box(43.00005, -86.49985, 43.00015, -86.49975));
    const park = polyFeature("parks-polygon", "way", 722, { leisure: "park", name: "Wide Park" },
      box(42.99, -86.52, 43.06, -86.44));
    const out = discoverFromLayers(layersOf({
      beaches: [oversized, tiny], parksPoly: [park], parksName: [park], water: [pond]
    }));
    // The small one is dropped by the pond rule; the oversized one is kept.
    expect(idsOf(out.parkBeaches)).toEqual([720]);
    expect(out.layerCounts.droppedPond).toBe(1);
  });

  it("keeps water RELATIONS out of the pool (MI-9: ways only, both layers)", () => {
    // Overpass ran way[natural=water](around.b:60) and
    // way[natural=coastline](around.b:60) — never relations, because an around
    // on natural=water relations forces the Great Lakes multipolygons' full
    // geometry to load and is pathological. If a relation could enter the pool
    // here, the pond filter would see different evidence than production did.
    const park = polyFeature("parks-polygon", "way", 730, { leisure: "park", name: "Relation Water Park" },
      box(42.99800, -86.50200, 43.00200, -86.49800));
    const beach = polyFeature("beaches-polygon", "way", 731, { natural: "beach" },
      box(43.00000, -86.50000, 43.00002, -86.49998));
    const pondWay = polyFeature("water-polygon", "way", 930, { natural: "water" },
      box(43.00005, -86.50005, 43.00015, -86.49995));
    const lakeRelation = polyFeature("water-polygon", "relation", 931, { natural: "water" },
      box(42.90, -86.60, 43.10, -86.40));
    const out = discoverFromLayers(layersOf({
      beaches: [beach], parksPoly: [park], parksName: [park], water: [pondWay, lakeRelation]
    }));
    // The relation's bbox is large enough to clear WATER_MIN_AREA_DEG2 many
    // times over; if it reached the pool the beach would be KEPT.
    expect(out.parkBeaches).toEqual([]);
    expect(out.layerCounts.droppedPond).toBe(1);
  });

  it("skips the gather entirely when no unnamed candidate is under the cutoff", () => {
    // pondWaterSeeds returns [] in that case, and an empty seed list means an
    // empty pool — the third of its three product rules.
    const park = polyFeature("parks-polygon", "way", 740, { leisure: "park", name: "Named Only Park" },
      box(42.99800, -86.50200, 43.00200, -86.49800));
    const namedOnly = polyFeature("beaches-polygon", "way", 741,
      { natural: "beach", name: "Only Named Beach" }, box(43.00000, -86.50000, 43.00002, -86.49998));
    const pond = polyFeature("water-polygon", "way", 940, { natural: "water" },
      box(43.00005, -86.50005, 43.00015, -86.49995));
    const out = discoverFromLayers(layersOf({
      beaches: [namedOnly], parksPoly: [park], parksName: [park], water: [pond]
    }));
    expect(idsOf(out.parkBeaches)).toEqual([741]);
    expect(out.layerCounts.droppedPond).toBe(0);
  });

  it("keeps an unnamed beach with no mapped water nearby (missing data never drops)", () => {
    const park = polyFeature("parks-polygon", "way", 750, { leisure: "park", name: "Dry Park" },
      box(42.99800, -86.50200, 43.00200, -86.49800));
    const beach = polyFeature("beaches-polygon", "way", 751, { natural: "beach" },
      box(43.00000, -86.50000, 43.00002, -86.49998));
    const out = discoverFromLayers(layersOf({
      beaches: [beach], parksPoly: [park], parksName: [park]
    }));
    expect(idsOf(out.parkBeaches)).toEqual([751]);
  });
});

// --- step 7: the emitted record ------------------------------------------------

describe("discoverFromLayers: the emitted park-beach record", () => {
  // The re-fixtured fetchParkBeaches wiring fixture. Same elements, same ids,
  // same expected answers as test/overpassFailover.test.js — the only thing
  // that changed is the transport. Park polygons were added because Overpass
  // performed the membership test server-side and the layers path does it here.
  const PARK_LAYERS = layersOf({
    beaches: [
      // way/100: UNNAMED beach on pond water -> dropped by the filter
      polyFeature("beaches-polygon", "way", 100, { natural: "beach" },
        box(42.0, -86.0001, 42.0002, -86.0)),
      // way/101: NAMED beach on the same pond -> kept (filter is unnamed-only)
      polyFeature("beaches-polygon", "way", 101, { natural: "beach", name: "Pond Cove Beach" },
        box(42.0003, -85.9999, 42.0005, -85.9997)),
      // way/102: unnamed beach overlapping TWO parks, no water nearby -> kept,
      // smaller-bbox park wins
      polyFeature("beaches-polygon", "way", 102, { natural: "beach" },
        box(43.0, -85.0004, 43.0004, -85.0)),
      // way/103: unnamed beach carrying a loc_name tag -> locality
      polyFeature("beaches-polygon", "way", 103, { natural: "beach", loc_name: "Hamlin Lake" },
        box(44.0, -85.5002, 44.0002, -85.5))
    ],
    parksPoly: [
      polyFeature("parks-polygon", "way", 199, { leisure: "park", name: "Pond Cove Reserve" },
        box(41.99, -86.01, 42.01, -85.99)),
      polyFeature("parks-polygon", "way", 200, { leisure: "nature_reserve", name: "Big Woods Reserve" },
        box(42.9, -85.1, 43.1, -84.9)),
      polyFeature("parks-polygon", "relation", 300, { leisure: "park", name: "Little Cove Park" },
        box(42.999, -85.001, 43.001, -84.999)),
      polyFeature("parks-polygon", "way", 400, { leisure: "park", name: "Hamlin Park" },
        box(43.99, -85.51, 44.01, -85.49))
    ],
    parksName: [
      polyFeature("parks-polygon", "way", 199, { leisure: "park", name: "Pond Cove Reserve" },
        box(41.99, -86.01, 42.01, -85.99)),
      polyFeature("parks-polygon", "way", 200, { leisure: "nature_reserve", name: "Big Woods Reserve" },
        box(42.9, -85.1, 43.1, -84.9)),
      polyFeature("parks-polygon", "relation", 300, { leisure: "park", name: "Little Cove Park" },
        box(42.999, -85.001, 43.001, -84.999)),
      polyFeature("parks-polygon", "way", 400, { leisure: "park", name: "Hamlin Park" },
        box(43.99, -85.51, 44.01, -85.49))
    ],
    // The pond way (bbox area 1e-6 deg2 < WATER_MIN_AREA_DEG2) adjacent to
    // way/100 and way/101.
    water: [
      polyFeature("water-polygon", "way", 900, { natural: "water" }, box(42.0, -86.0, 42.001, -85.999))
    ]
  });

  it("drops the unnamed pond beach and keeps everything else", () => {
    const out = discoverFromLayers(PARK_LAYERS);
    expect(idsOf(out.parkBeaches)).toEqual([101, 102, 103]);
    expect(out.layerCounts.droppedPond).toBe(1);
  });

  it("keeps the NAMED beach on pond-sized water, at the envelope midpoint", () => {
    const out = discoverFromLayers(PARK_LAYERS);
    const named = findById(out.parkBeaches, 101);
    expect(named.name).toBe("Pond Cove Beach");
    expect(named.locality).toBe(null);
    expect(named.lat).toBeCloseTo(42.0004, 8);
    expect(named.lon).toBeCloseTo(-85.9998, 8);
    expect(named.areaDeg2).toBeCloseTo(0.0002 * 0.0002, 12);
  });

  it("attaches the smaller-bbox overlapping park and builds parkKey from its element identity", () => {
    const out = discoverFromLayers(PARK_LAYERS);
    const parked = findById(out.parkBeaches, 102);
    // Both parks overlap way/102; Little Cove Park's bbox (4e-6 deg2) is
    // smaller than Big Woods Reserve's (0.04 deg2), so it wins.
    expect(parked.parkName).toBe("Little Cove Park");
    expect(parked.parkKey).toBe("relation/300");
    expect(parked.name).toBe(null);
  });

  it("passes the beach element's loc_name tag through as locality", () => {
    const out = discoverFromLayers(PARK_LAYERS);
    const localized = findById(out.parkBeaches, 103);
    expect(localized.locality).toBe("Hamlin Lake");
    expect(localized.name).toBe(null);
  });

  it("emits exactly the documented nine-key output object shape", () => {
    const out = discoverFromLayers(PARK_LAYERS);
    for (let i = 0; i < out.parkBeaches.length; i++) {
      expect(Object.keys(out.parkBeaches[i]).sort()).toEqual([
        "areaDeg2", "lat", "locality", "lon", "name", "osmId", "osmType", "parkKey", "parkName"
      ]);
      expect(out.parkBeaches[i].osmType).toBe("way");
      expect(typeof out.parkBeaches[i].lat).toBe("number");
      expect(typeof out.parkBeaches[i].lon).toBe("number");
      expect(typeof out.parkBeaches[i].areaDeg2).toBe("number");
    }
    // bounds and vertices are deliberately dropped: nothing downstream of the
    // splice point reads them, and carrying geometry into the SQL builders is
    // how a delta file grows by an order of magnitude.
    expect(out.parkBeaches[0].bounds).toBe(undefined);
    expect(out.parkBeaches[0].vertices).toBe(undefined);
  });

  it("reports areaDeg2 as the raw degree product of the envelope", () => {
    const out = discoverFromLayers(PARK_LAYERS);
    const localized = findById(out.parkBeaches, 103);
    expect(localized.areaDeg2).toBeCloseTo(0.0002 * 0.0002, 14);
  });
});

// --- layerCounts ----------------------------------------------------------------

describe("discoverFromLayers: layerCounts", () => {
  it("carries exactly the ten diagnostic keys", () => {
    const out = discoverFromLayers(layersOf({}));
    expect(Object.keys(out.layerCounts).sort()).toEqual([
      "beaches", "coastline", "droppedPond", "membershipRejected", "named",
      "outOfRegion", "parkBeaches", "parksName", "parksPoly", "water"
    ]);
  });

  it("counts raw input layer sizes alongside the pipeline outcomes", () => {
    const park = polyFeature("parks-polygon", "way", 500, { leisure: "park", name: "Count Park" },
      box(42.99800, -86.50200, 43.00200, -86.49800));
    const out = discoverFromLayers(layersOf({
      beaches: [
        polyFeature("beaches-polygon", "way", 501, { natural: "beach", name: "Kept Beach" },
          box(43.00000, -86.50000, 43.00002, -86.49998)),
        polyFeature("beaches-polygon", "way", 502, { natural: "beach" },
          box(43.40, -89.90, 43.4001, -89.8999)),
        polyFeature("beaches-polygon", "way", 503, { natural: "beach" },
          box(44.50000, -86.50000, 44.50002, -86.49998))
      ],
      parksPoly: [park],
      parksName: [park],
      coastline: [lineFeature("coastline-line", "way", 504, { natural: "coastline" },
        box(43.05, -86.55, 43.06, -86.54))],
      water: [polyFeature("water-polygon", "way", 505, { natural: "water" },
        box(43.05, -86.55, 43.06, -86.54))]
    }));
    expect(out.layerCounts.beaches).toBe(3);
    expect(out.layerCounts.parksPoly).toBe(1);
    expect(out.layerCounts.parksName).toBe(1);
    expect(out.layerCounts.coastline).toBe(1);
    expect(out.layerCounts.water).toBe(1);
    expect(out.layerCounts.outOfRegion).toBe(1);
    expect(out.layerCounts.named).toBe(1);
    expect(out.layerCounts.parkBeaches).toBe(1);
    // way/503 is in region but in no park.
    expect(out.layerCounts.membershipRejected).toBe(1);
  });
});

// --- defensive inputs -----------------------------------------------------------

describe("discoverFromLayers: defensive inputs", () => {
  it("returns the empty result for null, a non-object, and a bag of missing layers", () => {
    for (const input of [null, undefined, 42, "layers", {}]) {
      const out = discoverFromLayers(input);
      expect(out.namedRows).toEqual([]);
      expect(out.parkBeaches).toEqual([]);
      expect(out.layerCounts.beaches).toBe(0);
    }
  });

  it("ignores a layer value that is not an array", () => {
    const out = discoverFromLayers({ beaches: "nope", parksPoly: null, parksName: 7, coastline: {}, water: undefined });
    expect(out.namedRows).toEqual([]);
    expect(out.parkBeaches).toEqual([]);
  });

  it("is order-independent: a shuffled input yields an identical result", () => {
    // FlatGeobuf's Hilbert order reshuffles on every rebuild, so this is the
    // property that keeps a weekly rebuild from rewriting park names.
    const park = polyFeature("parks-polygon", "way", 600, { leisure: "park", name: "Shuffle Park" },
      box(42.99, -86.52, 43.02, -86.47));
    const beaches = [
      polyFeature("beaches-polygon", "way", 601, { natural: "beach", name: "A" }, box(43.000, -86.500, 43.0002, -86.4998)),
      nodeFeature("beaches-point", 602, { natural: "beach", name: "B" }, 43.001, -86.499),
      relationFeature(603, { natural: "beach" }, box(43.005, -86.495, 43.0052, -86.4948)),
      polyFeature("beaches-polygon", "way", 604, { natural: "beach" }, box(43.010, -86.490, 43.0102, -86.4898))
    ];
    const forward = discoverFromLayers(layersOf({ beaches: beaches, parksPoly: [park], parksName: [park] }));
    const reversed = discoverFromLayers(layersOf({
      beaches: beaches.slice().reverse(), parksPoly: [park], parksName: [park]
    }));
    expect(reversed.namedRows).toEqual(forward.namedRows);
    expect(reversed.parkBeaches).toEqual(forward.parkBeaches);
  });

  it("does not mutate the caller's layer arrays", () => {
    const beaches = [
      polyFeature("beaches-polygon", "way", 610, { natural: "beach", name: "Second" }, box(43.00, -86.50, 43.01, -86.49)),
      nodeFeature("beaches-point", 611, { natural: "beach", name: "First" }, 43.02, -86.48)
    ];
    const snapshot = beaches.slice();
    discoverFromLayers(layersOf({ beaches: beaches }));
    expect(beaches).toEqual(snapshot);
    expect(beaches[0].osmId).toBe(610);
  });
});

// --- the one composed pipeline test --------------------------------------------

describe("composed: layer features -> discoverFromLayers -> mergeBeachRows -> rows", () => {
  it("threads a known production id end to end and applies the merge policy", () => {
    // way/505668572 is Ottawa Beach, Holland MI — a real production row. The
    // "osm-" + osmType + "-" + osmId round trip is the single highest-value
    // parity assertion in the migration: getting it wrong silently orphans
    // every KV flag and every enriched column on every beach.
    const hollandStatePark = polyFeature("parks-polygon", "relation", 1976237,
      { leisure: "park", name: "Holland State Park" }, box(42.76, -86.23, 42.79, -86.20));
    const layers = layersOf({
      beaches: [
        polyFeature("beaches-polygon", "way", 505668572,
          { natural: "beach", name: "Ottawa Beach" }, box(42.7742, -86.2110, 42.7758, -86.2090)),
        // The larger unnamed sibling inside the same park takes the park's own
        // name; the smaller one needs a derivable distinction or it is skipped.
        polyFeature("beaches-polygon", "way", 505668573, { natural: "beach" },
          box(42.7700, -86.2120, 42.7720, -86.2090)),
        polyFeature("beaches-polygon", "way", 505668574,
          { natural: "beach", loc_name: "Lake Macatawa" }, box(42.7690, -86.2125, 42.7695, -86.2120))
      ],
      parksPoly: [hollandStatePark],
      parksName: [hollandStatePark]
    });

    const discovered = discoverFromLayers(layers);
    expect(idsOf(discovered.namedRows)).toEqual([505668572]);
    expect(idsOf(discovered.parkBeaches)).toEqual([505668572, 505668573, 505668574]);

    const merged = mergeBeachRows(discovered.namedRows, discovered.parkBeaches);
    const byId = new Map(merged.rows.map(function (row) { return [row.id, row]; }));

    const ottawa = byId.get("osm-way-505668572");
    expect(ottawa).toBeDefined();
    expect(ottawa.name).toBe("Ottawa Beach");
    expect(ottawa.osmId).toBe("way/505668572");
    expect(ottawa.parkName).toBe("Holland State Park");
    expect(ottawa.lat).toBeCloseTo(42.775, 10);
    expect(ottawa.lon).toBeCloseTo(-86.21, 10);

    // The largest unnamed sibling keeps the park's bare name.
    const primary = byId.get("osm-way-505668573");
    expect(primary.name).toBe("Holland State Park");
    // The second unnamed sibling is distinguished by its own loc_name.
    const secondary = byId.get("osm-way-505668574");
    expect(secondary.name).toBe("Holland State Park — Lake Macatawa");

    // Every merged row still sits inside the discovery region, so every one of
    // them is a reconciliation delete CANDIDATE — the upsert universe and the
    // delete-candidate universe are the same set.
    for (const row of merged.rows) {
      expect(pointInAnyRegion(row.lat, row.lon)).toBe(true);
    }
  });
});
