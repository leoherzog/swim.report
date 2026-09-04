// Tests for src/layerSignals.js, the water-class signal provider.
//
// The module is pure: no fetch, no Date, no filesystem and no entrypoint, so
// importing it under vitest exercises exactly the code the Deno batch runs. A
// LayerFeature is a plain object, so the FlatGeobuf reader is not in the loop
// for any assertion here.
//
// Every tag/type/area rule is also a distance question, so each one is asserted
// at its radius in both directions.

import { describe, it, expect } from "vitest";
import {
  buildSignalsIndex,
  beginSignalsIndex,
  addSignalsFeature,
  finishSignalsIndex,
  signalsIndexStats,
  waterClassSignals,
  beachAbsentFromLayers
} from "../src/layerSignals.js";
import { classifyWaterBody } from "../src/waterClass.js";
import { reconciliationAllowed } from "../src/layerManifest.js";
import {
  OCEAN_RADIUS_M,
  GREAT_LAKE_RADIUS_M,
  INLAND_RADIUS_M,
  WATER_MIN_AREA_DEG2
} from "../src/osmSelect.js";
import { KM_PER_DEG } from "../src/geo.js";

// --- geometry primitives --------------------------------------------------------

// The probe point every fixture is measured from. Any Great Lakes latitude does;
// 45 N keeps the longitude scaling of the grid's cells unremarkable.
const BEACH_LAT = 45;
const BEACH_LON = -86;

// Degrees of LATITUDE for a given number of metres, in the exact model
// src/geo.js#anySegmentWithinKm uses (equirectangular, KM_PER_DEG). A fixture
// placed this far due north of the probe point is that many metres away, so a
// boundary assertion is arithmetic rather than approximation.
function metresNorth(metres) {
  return (metres / 1000) / KM_PER_DEG;
}

function boundsOfPositions(positions) {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const position of positions) {
    const lon = position[0];
    const lat = position[1];
    if (lat < minLat) { minLat = lat; }
    if (lat > maxLat) { maxLat = lat; }
    if (lon < minLon) { minLon = lon; }
    if (lon > maxLon) { maxLon = lon; }
  }
  return { minLat: minLat, minLon: minLon, maxLat: maxLat, maxLon: maxLon };
}

// Closed rectangular ring, in GeoJSON [lon, lat] positions.
function ringRect(minLon, minLat, maxLon, maxLat) {
  return [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat]
  ];
}

// --- layer-feature builders ------------------------------------------------------
// Each returns the LayerFeature shape scripts/lib/fgbReader.js#toLayerFeature
// produces: { layer, osmType, osmId, tags, bounds, geometry }.

function pointFeature(options) {
  const coordinates = [options.lon, options.lat];
  return {
    layer: options.layer,
    osmType: options.osmType === undefined ? "node" : options.osmType,
    osmId: options.osmId,
    tags: options.tags === undefined ? {} : options.tags,
    bounds: boundsOfPositions([coordinates]),
    geometry: { type: "Point", coordinates: coordinates }
  };
}

function lineFeature(options) {
  return {
    layer: options.layer,
    osmType: options.osmType === undefined ? "way" : options.osmType,
    osmId: options.osmId,
    tags: options.tags === undefined ? {} : options.tags,
    bounds: boundsOfPositions(options.coordinates),
    geometry: { type: "LineString", coordinates: options.coordinates }
  };
}

function polygonFeature(options) {
  const ring = options.ring;
  return {
    layer: options.layer,
    osmType: options.osmType === undefined ? "way" : options.osmType,
    osmId: options.osmId,
    tags: options.tags === undefined ? {} : options.tags,
    // malformation KNOB: an explicit bounds override, so the area gate can be
    // exercised independently of the ring the distance probe measures against.
    bounds: options.bounds === undefined ? boundsOfPositions(ring) : options.bounds,
    geometry: { type: "Polygon", coordinates: [ring] }
  };
}

// --- fixture shorthands ----------------------------------------------------------

// A one-node beach at the probe point. osm_id "node/1" unless overridden.
function beachAt(osmId, lat, lon) {
  const parts = osmId.split("/");
  return pointFeature({
    layer: "beaches",
    osmType: parts[0],
    osmId: Number(parts[1]),
    lat: lat === undefined ? BEACH_LAT : lat,
    lon: lon === undefined ? BEACH_LON : lon,
    tags: { natural: "beach", name: "Test Beach" }
  });
}

// An east-west coastline way whose whole length sits metres due north of the
// probe point, so its distance to that point IS metres.
function coastlineAt(metres, osmId) {
  const lat = BEACH_LAT + metresNorth(metres);
  return lineFeature({
    layer: "coastline",
    osmId: osmId === undefined ? 500 : osmId,
    tags: { natural: "coastline" },
    coordinates: [[BEACH_LON - 0.01, lat], [BEACH_LON + 0.01, lat]]
  });
}

// A water polygon whose SOUTH edge sits metres due north of the probe point.
// Default extent is 0.003 lat x 0.002 lon = 6e-6 deg2, comfortably at or above
// WATER_MIN_AREA_DEG2 (5e-6); pass small: true for 1e-6, below it.
function waterAt(metres, options) {
  const opts = options === undefined ? {} : options;
  const minLat = BEACH_LAT + metresNorth(metres);
  const height = opts.small === true ? 0.001 : 0.003;
  const halfWidth = opts.small === true ? 0.0005 : 0.001;
  return polygonFeature({
    layer: "water",
    osmType: opts.osmType === undefined ? "way" : opts.osmType,
    osmId: opts.osmId === undefined ? 600 : opts.osmId,
    tags: opts.tags === undefined ? { natural: "water" } : opts.tags,
    ring: ringRect(BEACH_LON - halfWidth, minLat, BEACH_LON + halfWidth, minLat + height)
  });
}

// A lake polygon whose SOUTH edge sits metres due north of the probe point.
function lakeAt(metres, options) {
  const opts = options === undefined ? {} : options;
  const minLat = BEACH_LAT + metresNorth(metres);
  const tags = { natural: "water", water: "lake" };
  if (opts.wikidata !== undefined) {
    tags.wikidata = opts.wikidata;
  }
  return polygonFeature({
    layer: "lakes",
    osmType: opts.osmType === undefined ? "relation" : opts.osmType,
    osmId: opts.osmId === undefined ? 700 : opts.osmId,
    tags: opts.tags === undefined ? tags : opts.tags,
    ring: ringRect(BEACH_LON - 0.5, minLat, BEACH_LON + 0.5, minLat + 0.5)
  });
}

const EMPTY_SIGNALS = {
  coastlinePresent: false,
  nearbyLakeQids: [],
  nearbyWayWater: false
};

// The classify-queue row shape: the D1 column names, not the layer field names.
function row(id, osmId) {
  return { id: id, osm_id: osmId, lat: BEACH_LAT, lon: BEACH_LON };
}

// --- shape -----------------------------------------------------------------------

describe("waterClassSignals — the object classifyWaterBody consumes", () => {
  it("returns EXACTLY the three keys, no more", () => {
    const index = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      coastline: [coastlineAt(50)],
      water: [waterAt(50)],
      lakes: [lakeAt(50, { wikidata: "Q1169" })]
    });
    const signals = waterClassSignals(index, row(1, "node/1"));
    expect(Object.keys(signals).sort()).toEqual(
      ["coastlinePresent", "nearbyLakeQids", "nearbyWayWater"]);
    expect(typeof signals.coastlinePresent).toBe("boolean");
    expect(Array.isArray(signals.nearbyLakeQids)).toBe(true);
    expect(typeof signals.nearbyWayWater).toBe("boolean");
  });

  it("a missing layer is an empty layer, not a crash", () => {
    const index = buildSignalsIndex({ beaches: [beachAt("node/1")] });
    expect(waterClassSignals(index, row(1, "node/1"))).toEqual(EMPTY_SIGNALS);
  });
});

// --- the radii, in both directions ------------------------------------------------

describe("probe radii — the thresholds this migration must not move", () => {
  it("coastline at 149.5 m is present, at 150.5 m is not (OCEAN_RADIUS_M 150)", () => {
    expect(OCEAN_RADIUS_M).toBe(150);
    const inside = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      coastline: [coastlineAt(149.5)]
    });
    const outside = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      coastline: [coastlineAt(150.5)]
    });
    expect(waterClassSignals(inside, row(1, "node/1")).coastlinePresent).toBe(true);
    expect(waterClassSignals(outside, row(1, "node/1")).coastlinePresent).toBe(false);
  });

  it("a lake relation at 149.5 m contributes its QID, at 150.5 m does not (GREAT_LAKE_RADIUS_M 150)", () => {
    expect(GREAT_LAKE_RADIUS_M).toBe(150);
    const inside = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      lakes: [lakeAt(149.5, { wikidata: "Q1169" })]
    });
    const outside = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      lakes: [lakeAt(150.5, { wikidata: "Q1169" })]
    });
    expect(waterClassSignals(inside, row(1, "node/1")).nearbyLakeQids).toEqual(["Q1169"]);
    expect(waterClassSignals(outside, row(1, "node/1")).nearbyLakeQids).toEqual([]);
  });

  it("a water way at 119.5 m sets nearbyWayWater, at 120.5 m does not (INLAND_RADIUS_M 120)", () => {
    expect(INLAND_RADIUS_M).toBe(120);
    const inside = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      water: [waterAt(119.5)]
    });
    const outside = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      water: [waterAt(120.5)]
    });
    expect(waterClassSignals(inside, row(1, "node/1")).nearbyWayWater).toBe(true);
    expect(waterClassSignals(outside, row(1, "node/1")).nearbyWayWater).toBe(false);
  });

  it("the water radius really is TIGHTER than the other two: 140 m is in range for a lake and out of range for a water way", () => {
    // The one place the three radii are not interchangeable. A beach 140 m from
    // both would be great_lake on the lake evidence and would see NO adjacent
    // water way, which is what makes inland_no_water a meaningful counter.
    const index = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      water: [waterAt(140)],
      lakes: [lakeAt(140, { wikidata: "Q1169" })]
    });
    const signals = waterClassSignals(index, row(1, "node/1"));
    expect(signals.nearbyLakeQids).toEqual(["Q1169"]);
    expect(signals.nearbyWayWater).toBe(false);
  });
});

// --- nearbyLakeQids ---------------------------------------------------------------

describe("nearbyLakeQids — the QID path 100% of served beaches classify through", () => {
  it("a water=lake RELATION with wikidata contributes its QID verbatim", () => {
    const index = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      lakes: [lakeAt(40, { wikidata: "Q1169" })]
    });
    const signals = waterClassSignals(index, row(1, "node/1"));
    expect(signals.nearbyLakeQids).toEqual(["Q1169"]);
    expect(classifyWaterBody(signals)).toBe("great_lake");
  });

  it("a water=lake relation WITHOUT wikidata contributes nothing", () => {
    const index = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      lakes: [lakeAt(40)]
    });
    const signals = waterClassSignals(index, row(1, "node/1"));
    expect(signals.nearbyLakeQids).toEqual([]);
    expect(classifyWaterBody(signals)).toBe("inland");
  });

  it("a non-allowlisted QID is carried but falls through to inland", () => {
    const index = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      lakes: [lakeAt(40, { wikidata: "Q3062" })]
    });
    const signals = waterClassSignals(index, row(1, "node/1"));
    expect(signals.nearbyLakeQids).toEqual(["Q3062"]);
    expect(classifyWaterBody(signals)).toBe("inland");
  });

  it("QIDs are pushed untrimmed and unnormalised, so a dirty tag still fails to match", () => {
    // isGreatLakeQid is an exact, case-sensitive lookup, and these are handed
    // through raw, so " Q1066" must still classify inland.
    const index = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      lakes: [lakeAt(40, { wikidata: " Q1066" })]
    });
    const signals = waterClassSignals(index, row(1, "node/1"));
    expect(signals.nearbyLakeQids).toEqual([" Q1066"]);
    expect(classifyWaterBody(signals)).toBe("inland");
  });

  it("a way-mapped lake polygon contributes nothing (relations only)", () => {
    const index = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      lakes: [lakeAt(40, { wikidata: "Q1169", osmType: "way", osmId: 701 })]
    });
    expect(waterClassSignals(index, row(1, "node/1")).nearbyLakeQids).toEqual([]);
  });

  it("a relation missing natural=water or water=lake contributes nothing", () => {
    const index = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      lakes: [
        lakeAt(40, { osmId: 702, tags: { natural: "water", wikidata: "Q1169" } }),
        lakeAt(40, { osmId: 703, tags: { water: "lake", wikidata: "Q1383" } })
      ]
    });
    expect(waterClassSignals(index, row(1, "node/1")).nearbyLakeQids).toEqual([]);
  });

  it("does NOT dedupe: the same QID published as two relations appears twice", () => {
    const index = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      lakes: [
        lakeAt(40, { osmId: 710, wikidata: "Q1169" }),
        lakeAt(45, { osmId: 711, wikidata: "Q1169" })
      ]
    });
    expect(waterClassSignals(index, row(1, "node/1")).nearbyLakeQids).toEqual(["Q1169", "Q1169"]);
  });
});

// --- nearbyWayWater ----------------------------------------------------------------

describe("nearbyWayWater — the pond-guarded inland water signal", () => {
  it("a natural=water WAY at or above WATER_MIN_AREA_DEG2 sets it", () => {
    const water = waterAt(50);
    const area = (water.bounds.maxLat - water.bounds.minLat) *
      (water.bounds.maxLon - water.bounds.minLon);
    expect(area).toBeGreaterThanOrEqual(WATER_MIN_AREA_DEG2);
    const index = buildSignalsIndex({ beaches: [beachAt("node/1")], water: [water] });
    const signals = waterClassSignals(index, row(1, "node/1"));
    expect(signals.nearbyWayWater).toBe(true);
    expect(classifyWaterBody(signals)).toBe("inland");
  });

  it("a way BELOW the area threshold does not set it", () => {
    const water = waterAt(50, { small: true });
    const area = (water.bounds.maxLat - water.bounds.minLat) *
      (water.bounds.maxLon - water.bounds.minLon);
    expect(area).toBeLessThan(WATER_MIN_AREA_DEG2);
    const index = buildSignalsIndex({ beaches: [beachAt("node/1")], water: [water] });
    expect(waterClassSignals(index, row(1, "node/1")).nearbyWayWater).toBe(false);
  });

  it("the threshold is >= and not >, so a way at EXACTLY WATER_MIN_AREA_DEG2 counts", () => {
    // Same ring as the in-range fixture, but with the envelope stated exactly at
    // the threshold — the area gate reads bounds, the distance probe reads the ring.
    const minLat = BEACH_LAT + metresNorth(50);
    const water = polygonFeature({
      layer: "water",
      osmId: 620,
      tags: { natural: "water" },
      ring: ringRect(BEACH_LON - 0.001, minLat, BEACH_LON + 0.001, minLat + 0.003),
      bounds: { minLat: 0, minLon: 0, maxLat: 0.0025, maxLon: 0.002 }
    });
    expect((0.0025 - 0) * (0.002 - 0)).toBe(WATER_MIN_AREA_DEG2);
    const index = buildSignalsIndex({ beaches: [beachAt("node/1")], water: [water] });
    expect(waterClassSignals(index, row(1, "node/1")).nearbyWayWater).toBe(true);
  });

  it("a RELATION-mapped water body never sets it", () => {
    const index = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      water: [waterAt(50, { osmType: "relation", osmId: 601 })]
    });
    expect(waterClassSignals(index, row(1, "node/1")).nearbyWayWater).toBe(false);
  });

  it("a way without natural=water never sets it", () => {
    const index = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      water: [waterAt(50, { osmId: 602, tags: { waterway: "riverbank" } })]
    });
    expect(waterClassSignals(index, row(1, "node/1")).nearbyWayWater).toBe(false);
  });
});

// --- the vertex anchor ---------------------------------------------------------------

describe("distance is measured from member VERTICES, never the centroid (the Sleeping Bear case)", () => {
  // A large multipolygon beach: 0.010 deg (~1.1 km) tall. Its envelope centre is
  // ~600 m from the coastline that its northern vertices sit 50 m from. A
  // centroid probe classifies the whole dune complex inland; a vertex probe
  // classifies it ocean. Only the second one is correct.
  const beachMinLat = BEACH_LAT;
  const beachMaxLat = BEACH_LAT + 0.010;
  const centreLat = (beachMinLat + beachMaxLat) / 2;
  const bigBeach = polygonFeature({
    layer: "beaches",
    osmType: "relation",
    osmId: 42,
    tags: { natural: "beach", name: "Sleeping Bear" },
    ring: ringRect(BEACH_LON - 0.005, beachMinLat, BEACH_LON + 0.005, beachMaxLat)
  });
  const coastline = lineFeature({
    layer: "coastline",
    osmId: 501,
    tags: { natural: "coastline" },
    coordinates: [
      [BEACH_LON - 0.01, beachMaxLat + metresNorth(50)],
      [BEACH_LON + 0.01, beachMaxLat + metresNorth(50)]
    ]
  });

  it("the polygon beach whose VERTICES reach the coastline yields coastlinePresent", () => {
    const index = buildSignalsIndex({ beaches: [bigBeach], coastline: [coastline] });
    const signals = waterClassSignals(index, row(42, "relation/42"));
    expect(signals.coastlinePresent).toBe(true);
    expect(classifyWaterBody(signals)).toBe("ocean");
  });

  it("the same coastline probed from that beach's ENVELOPE CENTRE finds nothing", () => {
    // The control: proof the first assertion is about the anchor and not about
    // the fixture simply being close to the coastline.
    const centreBeach = pointFeature({
      layer: "beaches",
      osmType: "node",
      osmId: 43,
      lat: centreLat,
      lon: BEACH_LON,
      tags: { natural: "beach" }
    });
    const index = buildSignalsIndex({ beaches: [centreBeach], coastline: [coastline] });
    const signals = waterClassSignals(index, row(43, "node/43"));
    expect(signals.coastlinePresent).toBe(false);
    expect(classifyWaterBody(signals)).toBe("inland");
  });
});

// --- the transient-vs-clean contract ---------------------------------------------------

describe("transient null vs clean signals (ported from fetchWaterClassSignals)", () => {
  // null = transient: the caller must not bump water_class_attempts and the row
  // stays queued. A signals object — including the all-empty one — is a CLEAN,
  // complete answer that decides. This is the one place the migration can
  // silently regress the Locklin Pines fix.

  it("an unparseable osm_id -> null", () => {
    const index = buildSignalsIndex({ beaches: [beachAt("node/1")] });
    expect(waterClassSignals(index, row(1, "banana"))).toBeNull();
    expect(waterClassSignals(index, row(1, "way/12x"))).toBeNull();
    expect(waterClassSignals(index, row(1, "WAY/12"))).toBeNull();
    expect(waterClassSignals(index, { id: 1, osm_id: null })).toBeNull();
  });

  it("a beach absent from the layer set -> null", () => {
    const index = buildSignalsIndex({ beaches: [beachAt("node/1")] });
    expect(waterClassSignals(index, row(2, "way/999"))).toBeNull();
  });

  it("a successfully indexed beach with NOTHING in range -> the ALL-EMPTY OBJECT, not null", () => {
    // The Locklin Pines shape: a real, indexed beach set back from its water. A
    // complete probe found nothing, and saying so once is the whole fix.
    const index = buildSignalsIndex({
      beaches: [beachAt("way/123")],
      coastline: [coastlineAt(400)],
      water: [waterAt(400)],
      lakes: [lakeAt(400, { wikidata: "Q1169" })]
    });
    const signals = waterClassSignals(index, row(1, "way/123"));
    expect(signals).not.toBeNull();
    expect(signals).toEqual(EMPTY_SIGNALS);
    expect(classifyWaterBody(signals)).toBe("inland");
  });

  it("a malformed or half-built index answers TRANSIENT rather than all-empty", () => {
    // An unfinished builder must never look like a complete probe: that would
    // turn a wiring bug into a table-wide hide.
    expect(waterClassSignals(null, row(1, "node/1"))).toBeNull();
    expect(waterClassSignals({}, row(1, "node/1"))).toBeNull();
    const halfBuilt = beginSignalsIndex();
    addSignalsFeature(halfBuilt, "beaches", beachAt("node/1"));
    expect(waterClassSignals(halfBuilt, row(1, "node/1"))).toBeNull();
  });
});

// --- beachAbsentFromLayers ---------------------------------------------------------------

describe("beachAbsentFromLayers — which of the two nulls this is", () => {
  const index = buildSignalsIndex({ beaches: [beachAt("way/123")] });

  it("is true for an id not in the index and false for one that is", () => {
    expect(beachAbsentFromLayers(index, row(1, "way/999"))).toBe(true);
    expect(beachAbsentFromLayers(index, row(2, "way/123"))).toBe(false);
  });

  it("distinguishes the two null cases: an unparseable id is NOT absence", () => {
    // Both return null from the seam, but only one of them is evidence about
    // layer coverage. An unparseable osm_id is a data bug in the row and must
    // stay transient forever — bumping attempts for it would eventually hide a
    // beach because of a typo in its own id.
    expect(waterClassSignals(index, row(1, "banana"))).toBeNull();
    expect(waterClassSignals(index, row(2, "way/999"))).toBeNull();
    expect(beachAbsentFromLayers(index, row(1, "banana"))).toBe(false);
    expect(beachAbsentFromLayers(index, row(2, "way/999"))).toBe(true);
  });

  it("every unproven input answers false, the fail-safe direction", () => {
    expect(beachAbsentFromLayers(null, row(1, "way/999"))).toBe(false);
    expect(beachAbsentFromLayers({}, row(1, "way/999"))).toBe(false);
    expect(beachAbsentFromLayers(index, null)).toBe(false);
    expect(beachAbsentFromLayers(index, {})).toBe(false);
  });

  it("a beach indexed from a different published file under the same identity is still present", () => {
    // beaches arrive from four files and the same (type, id) legitimately shows
    // up twice; first-seen wins and neither copy reads as absent.
    const twice = buildSignalsIndex({
      beaches: [beachAt("relation/42"), beachAt("relation/42")]
    });
    expect(beachAbsentFromLayers(twice, row(1, "relation/42"))).toBe(false);
    expect(signalsIndexStats(twice).beaches).toBe(1);
  });
});

// --- determinism and the streaming feed -----------------------------------------------

describe("determinism", () => {
  it("the same index queried twice yields identical signals, nearbyLakeQids order included", () => {
    const index = buildSignalsIndex({
      beaches: [beachAt("node/1")],
      coastline: [coastlineAt(100)],
      water: [waterAt(100)],
      lakes: [
        lakeAt(100, { osmId: 900, wikidata: "Q1169" }),
        lakeAt(100, { osmId: 100, wikidata: "Q1383" })
      ]
    });
    const first = waterClassSignals(index, row(1, "node/1"));
    const second = waterClassSignals(index, row(1, "node/1"));
    expect(second).toEqual(first);
    // Canonical order is sortLayerFeatures order (type, then id ascending), not
    // the order the features were fed in: relation 100 precedes relation 900.
    expect(first.nearbyLakeQids).toEqual(["Q1383", "Q1169"]);
  });

  it("feeding the index one feature at a time gives the same answer as building it from arrays", () => {
    // The streaming feed is how the batch consumes readFgbStream without ever
    // materialising a layer; it must not be a second, subtly different code path.
    const layers = {
      beaches: [beachAt("node/1")],
      coastline: [coastlineAt(100)],
      water: [waterAt(100)],
      lakes: [
        lakeAt(100, { osmId: 900, wikidata: "Q1169" }),
        lakeAt(100, { osmId: 100, wikidata: "Q1383" })
      ]
    };
    const builder = beginSignalsIndex();
    for (const name of ["lakes", "water", "coastline", "beaches"]) {
      for (const feature of layers[name]) {
        addSignalsFeature(builder, name, feature);
      }
    }
    const streamed = finishSignalsIndex(builder);
    expect(waterClassSignals(streamed, row(1, "node/1")))
      .toEqual(waterClassSignals(buildSignalsIndex(layers), row(1, "node/1")));
  });
});

// --- the one composed pipeline test ------------------------------------------------------

describe("composed: index -> signals -> classifyWaterBody -> the caller's SQL decision", () => {
  // The wiring exactly as scripts/discovery-batch.js splices it: fetchSignals
  // is waterClassSignals bound to the index, and isKnownAbsent is
  // beachAbsentFromLayers ANDed with reconciliationAllowed(report).
  function classifyPass(index, rows, report) {
    const armAbsentBump = reconciliationAllowed(report);
    const result = { updates: [], bumps: [], transient: [] };
    for (const beach of rows) {
      const signals = waterClassSignals(index, beach);
      if (signals === null) {
        if (armAbsentBump && beachAbsentFromLayers(index, beach)) {
          result.bumps.push(beach.id);
        } else {
          result.transient.push(beach.id);
        }
        continue;
      }
      result.updates.push({ id: beach.id, verdict: classifyWaterBody(signals) });
    }
    return result;
  }

  const verifiedReport = {
    schemaVersion: 1,
    pointerAgreesWithManifest: true,
    layersVerified: true,
    layersPresent: 10,
    layersExpected: 10,
    buildStatus: "complete",
    sourcesVerified: true,
    buildSanityPassed: true,
    regionsDigestMatches: true,
    sourceAgeDays: 3
  };
  // The NA-expansion shape: a complete, intact set whose regionsDigest no longer
  // matches this code's REGIONS. Classification runs; the absent-bump does not.
  const unverifiedReport = Object.assign({}, verifiedReport, { regionsDigestMatches: false });

  it("classifies a great-lake, an ocean and a set-back beach, and arms the absent bump only under a verified report", () => {
    const index = buildSignalsIndex({
      beaches: [
        beachAt("way/1", BEACH_LAT, BEACH_LON),
        beachAt("way/2", BEACH_LAT + 1, BEACH_LON),
        beachAt("way/3", BEACH_LAT + 2, BEACH_LON)
      ],
      coastline: [
        lineFeature({
          layer: "coastline",
          osmId: 502,
          tags: { natural: "coastline" },
          coordinates: [
            [BEACH_LON - 0.01, BEACH_LAT + 1 + metresNorth(60)],
            [BEACH_LON + 0.01, BEACH_LAT + 1 + metresNorth(60)]
          ]
        })
      ],
      water: [waterAt(400)],
      lakes: [lakeAt(60, { wikidata: "Q1169" })]
    });
    const rows = [
      row(1, "way/1"),        // great_lake: Lake Michigan relation 60 m away
      row(2, "way/2"),        // ocean: coastline 60 m away
      row(3, "way/3"),        // indexed, nothing in range -> DECIDES inland
      row(4, "way/404"),      // in D1, absent from the layer set
      row(5, "banana")        // unparseable id: a data bug, always transient
    ];

    const verified = classifyPass(index, rows, verifiedReport);
    expect(verified.updates).toEqual([
      { id: 1, verdict: "great_lake" },
      { id: 2, verdict: "ocean" },
      { id: 3, verdict: "inland" }
    ]);
    expect(verified.bumps).toEqual([4]);
    expect(verified.transient).toEqual([5]);

    const unverified = classifyPass(index, rows, unverifiedReport);
    expect(unverified.updates).toEqual(verified.updates);
    expect(unverified.bumps).toEqual([]);
    expect(unverified.transient).toEqual([4, 5]);
  });
});
