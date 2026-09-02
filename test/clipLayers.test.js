// Tests for scripts/clip-layers.js — the build-side region filter (predicate A)
// and proximity clip (predicate B). The module's entrypoint is guarded by
// import.meta.main (falsy under vitest/node), so importing the pure exports is
// safe: no Deno access, no file system, no subprocess.
//
// Every fixture here is built in memory from readable primitives — plain bounds
// records and tag bags — with explicit malformation knobs, because the failure
// this file exists to catch is a predicate that silently keeps or drops the
// wrong half of a continent.

import { describe, it, expect } from "vitest";
import { REGIONS } from "../src/regions.js";
import { EXPECTED_LAYER_KEYS } from "../src/layerManifest.js";
import {
  REGION_SPAT_PAD_DEG,
  WATER_CLIP_PAD_DEG,
  LAYER_PLAN,
  PUBLISHED_LAYER_FIELDS,
  SOURCE_TAG_KEYS,
  padBox,
  boxesIntersect,
  regionBoxes,
  regionEnvelopeKeep,
  buildBeachIndex,
  proximityKeep,
  isBeachTags,
  isNamedParkTags,
  isCoastlineTags,
  isWaterTags,
  isOtherRelationTags,
  layerPropertyKeys,
  toGeoJsonFeature,
  parseArgs
} from "../scripts/clip-layers.js";

// --- fixture builders -----------------------------------------------------------

// A fgbReader-shaped bounds record. Called with one point it degenerates to a
// zero-extent envelope, which is exactly what a node beach produces.
function bounds(minLon, minLat, maxLon, maxLat) {
  return {
    minLat: minLat === undefined ? minLon : minLat,
    minLon: minLon,
    maxLat: maxLat === undefined ? (minLat === undefined ? minLon : minLat) : maxLat,
    maxLon: maxLon === undefined ? minLon : maxLon
  };
}

function pointBounds(lon, lat) {
  return { minLat: lat, minLon: lon, maxLat: lat, maxLon: lon };
}

// A LayerFeature as scripts/lib/fgbReader.js produces one. knobs:
//   osmType    "node" | "way" | "relation"
//   tags       the tag bag (omit a key to make it absent)
//   badBounds  replace bounds with an unusable value
function layerFeature(options) {
  const opts = options === undefined ? {} : options;
  return {
    layer: null,
    osmType: opts.osmType === undefined ? "way" : opts.osmType,
    osmId: opts.osmId === undefined ? 12345 : opts.osmId,
    tags: opts.tags === undefined ? {} : opts.tags,
    bounds: opts.badBounds !== undefined ? opts.badBounds : pointBounds(-87.0, 42.0),
    geometry: opts.geometry === undefined
      ? { type: "Point", coordinates: [-87.0, 42.0] }
      : opts.geometry
  };
}

// --- padBox / boxesIntersect ------------------------------------------------------

describe("padBox", () => {
  it("grows a box by padDeg on every edge", () => {
    expect(padBox({ minLon: -1, minLat: -2, maxLon: 3, maxLat: 4 }, 0.5)).toEqual({
      minLon: -1.5, minLat: -2.5, maxLon: 3.5, maxLat: 4.5
    });
  });

  it("forces min/max ordering so a corner-swapped fixture cannot match nothing", () => {
    expect(padBox({ minLon: 3, minLat: 4, maxLon: -1, maxLat: -2 }, 0)).toEqual({
      minLon: -1, minLat: -2, maxLon: 3, maxLat: 4
    });
  });

  it("returns null for a non-finite edge rather than an NaN box", () => {
    expect(padBox({ minLon: NaN, minLat: 0, maxLon: 1, maxLat: 1 }, 0.1)).toBe(null);
    expect(padBox(null, 0.1)).toBe(null);
    expect(padBox({ minLon: 0, minLat: 0 }, 0.1)).toBe(null);
  });
});

describe("boxesIntersect", () => {
  it("is INCLUSIVE — edge-touching counts", () => {
    const a = { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 };
    const b = { minLon: 1, minLat: 1, maxLon: 2, maxLat: 2 };
    expect(boxesIntersect(a, b)).toBe(true);
  });

  it("separates on either axis", () => {
    const a = { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 };
    expect(boxesIntersect(a, { minLon: 1.0001, minLat: 0, maxLon: 2, maxLat: 1 })).toBe(false);
    expect(boxesIntersect(a, { minLon: 0, minLat: 1.0001, maxLon: 1, maxLat: 2 })).toBe(false);
  });

  it("is false for malformed input rather than throwing", () => {
    expect(boxesIntersect(null, { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 })).toBe(false);
    expect(boxesIntersect({ minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }, undefined)).toBe(false);
  });
});

// --- PREDICATE A ------------------------------------------------------------------

describe("regionEnvelopeKeep (predicate A)", () => {
  const boxes = regionBoxes(REGIONS, REGION_SPAT_PAD_DEG);

  it("builds one padded box per REGIONS entry", () => {
    expect(boxes.length).toBe(REGIONS.length);
    const niagara = boxes.find((entry) => entry.name === "Niagara River");
    expect(niagara.box).toEqual({
      minLon: -79.3 - REGION_SPAT_PAD_DEG,
      minLat: 42.9 - REGION_SPAT_PAD_DEG,
      maxLon: -78.8 + REGION_SPAT_PAD_DEG,
      maxLat: 43.4 + REGION_SPAT_PAD_DEG
    });
  });

  // THE B2 TEST. The ogr2ogr -spat mask is the UNION rectangle of every REGIONS
  // box, and that rectangle encloses the entire continental interior between the
  // lakes. A feature there is inside the mask and outside every region: keeping
  // it would upsert an inland-lake beach that pointInAnyRegion-scoped
  // reconciliation can never delete again.
  it("DROPS a feature inside the union rectangle but outside every REGIONS box", () => {
    const union = boxes.reduce((acc, entry) => ({
      minLon: Math.min(acc.minLon, entry.box.minLon),
      minLat: Math.min(acc.minLat, entry.box.minLat),
      maxLon: Math.max(acc.maxLon, entry.box.maxLon),
      maxLat: Math.max(acc.maxLat, entry.box.maxLat)
    }), { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity });

    // Central Wisconsin: inside the union rectangle, outside every coastal box.
    const interior = pointBounds(-89.5, 44.0);
    expect(interior.minLon >= union.minLon && interior.maxLon <= union.maxLon).toBe(true);
    expect(interior.minLat >= union.minLat && interior.maxLat <= union.maxLat).toBe(true);
    expect(regionEnvelopeKeep(interior, boxes)).toBe(false);
  });

  it("KEEPS a feature straddling a padded box edge", () => {
    const niagara = boxes.find((entry) => entry.name === "Niagara River").box;
    const straddling = bounds(niagara.minLon - 0.2, niagara.minLat + 0.1,
      niagara.minLon + 0.05, niagara.minLat + 0.2);
    expect(regionEnvelopeKeep(straddling, boxes)).toBe(true);
  });

  it("KEEPS a feature exactly on the padded corner", () => {
    const niagara = boxes.find((entry) => entry.name === "Niagara River").box;
    expect(regionEnvelopeKeep(pointBounds(niagara.minLon, niagara.minLat), boxes)).toBe(true);
    expect(regionEnvelopeKeep(pointBounds(niagara.minLon - 1e-9, niagara.minLat), boxes))
      .toBe(true);
  });

  it("KEEPS a Great Lakes shoreline point", () => {
    expect(regionEnvelopeKeep(pointBounds(-87.63, 41.9), boxes)).toBe(true);
  });

  it("DROPS a feature with unusable bounds rather than defaulting to keep", () => {
    expect(regionEnvelopeKeep(null, boxes)).toBe(false);
    expect(regionEnvelopeKeep({ minLat: NaN, minLon: 0, maxLat: 0, maxLon: 0 }, boxes)).toBe(false);
    expect(regionEnvelopeKeep(pointBounds(-87.63, 41.9), [])).toBe(false);
    expect(regionEnvelopeKeep(pointBounds(-87.63, 41.9), null)).toBe(false);
  });

  it("accepts bare boxes as well as { name, box } entries", () => {
    const bare = [{ minLon: -1, minLat: -1, maxLon: 1, maxLat: 1 }];
    expect(regionEnvelopeKeep(pointBounds(0, 0), bare)).toBe(true);
    expect(regionEnvelopeKeep(pointBounds(2, 2), bare)).toBe(false);
  });
});

// --- PREDICATE B ------------------------------------------------------------------

describe("proximityKeep (predicate B)", () => {
  const index = buildBeachIndex([pointBounds(-87.0, 42.0)], WATER_CLIP_PAD_DEG);

  it("indexes the beach envelopes it was given", () => {
    expect(index.count).toBe(1);
    expect(index.padDeg).toBe(WATER_CLIP_PAD_DEG);
  });

  it("keeps a candidate exactly at WATER_CLIP_PAD_DEG from the beach", () => {
    expect(proximityKeep(pointBounds(-87.0 + WATER_CLIP_PAD_DEG, 42.0), index)).toBe(true);
  });

  // Both envelopes are padded, so the total reach is 2 x WATER_CLIP_PAD_DEG.
  // Asserted just inside and just beyond rather than exactly ON that reach: the
  // padding is applied twice in binary floating point, so "exactly at 2 x pad"
  // lands within one ULP of the boundary and which side it falls on depends on
  // the coordinate, not on the predicate. The INCLUSIVE edge behaviour itself is
  // pinned by the boxesIntersect tests above, where the numbers are exact.
  it("keeps a candidate just inside the doubled padding and drops one just beyond", () => {
    const reach = 2 * WATER_CLIP_PAD_DEG;
    expect(proximityKeep(pointBounds(-87.0 + reach - 1e-9, 42.0), index)).toBe(true);
    expect(proximityKeep(pointBounds(-87.0 + reach + 1e-6, 42.0), index)).toBe(false);
    expect(proximityKeep(pointBounds(-87.0, 42.0 + reach - 1e-9), index)).toBe(true);
    expect(proximityKeep(pointBounds(-87.0, 42.0 + reach + 1e-6), index)).toBe(false);
  });

  it("keeps a large water polygon whose envelope merely reaches the beach", () => {
    const lake = bounds(-88.0, 41.0, -87.0 - WATER_CLIP_PAD_DEG, 43.0);
    expect(proximityKeep(lake, index)).toBe(true);
  });

  // An empty beach set keeps NOTHING. Inventing a keep rule for that case would
  // publish a full continental water layer the moment the beach carve broke; the
  // empty layers it produces instead are what the build floors are for.
  it("keeps nothing when the beach set is empty", () => {
    const empty = buildBeachIndex([], WATER_CLIP_PAD_DEG);
    expect(empty.count).toBe(0);
    expect(proximityKeep(pointBounds(-87.0, 42.0), empty)).toBe(false);
  });

  it("skips unusable beach envelopes instead of indexing NaN", () => {
    const mixed = buildBeachIndex([null, { minLat: NaN, minLon: 0, maxLat: 0, maxLon: 0 },
      pointBounds(-87.0, 42.0)], WATER_CLIP_PAD_DEG);
    expect(mixed.count).toBe(1);
    expect(proximityKeep(pointBounds(-87.0, 42.0), mixed)).toBe(true);
  });

  it("is false for a malformed index or malformed bounds", () => {
    expect(proximityKeep(pointBounds(-87.0, 42.0), null)).toBe(false);
    expect(proximityKeep(pointBounds(-87.0, 42.0), {})).toBe(false);
    expect(proximityKeep(null, index)).toBe(false);
  });
});

// --- attribute predicates (the -where column of contract 1.4) ---------------------

describe("attribute predicates", () => {
  it("isBeachTags matches natural=beach OR leisure=beach_resort", () => {
    expect(isBeachTags({ natural: "beach" })).toBe(true);
    expect(isBeachTags({ leisure: "beach_resort" })).toBe(true);
    expect(isBeachTags({ natural: "water" })).toBe(false);
    expect(isBeachTags({})).toBe(false);
    expect(isBeachTags(null)).toBe(false);
  });

  it("isNamedParkTags requires a name — an unnamed park can name nothing", () => {
    expect(isNamedParkTags({ name: "Lincoln Park", leisure: "park" })).toBe(true);
    expect(isNamedParkTags({ name: "X", leisure: "nature_reserve" })).toBe(true);
    expect(isNamedParkTags({ name: "X", boundary: "protected_area" })).toBe(true);
    expect(isNamedParkTags({ leisure: "park" })).toBe(false);
    expect(isNamedParkTags({ name: "", leisure: "park" })).toBe(false);
    expect(isNamedParkTags({ name: "X", leisure: "pitch" })).toBe(false);
  });

  it("isCoastlineTags and isWaterTags match their single tag", () => {
    expect(isCoastlineTags({ natural: "coastline" })).toBe(true);
    expect(isCoastlineTags({ natural: "water" })).toBe(false);
    expect(isWaterTags({ natural: "water" })).toBe(true);
    expect(isWaterTags({ natural: "coastline" })).toBe(false);
  });

  it("isOtherRelationTags carries BOTH the beach half and the named-park half", () => {
    expect(isOtherRelationTags({ natural: "beach" })).toBe(true);
    expect(isOtherRelationTags({ name: "State Park", leisure: "park" })).toBe(true);
    expect(isOtherRelationTags({ type: "multipolygon", natural: "wood" })).toBe(false);
  });
});

// --- the layer plan ----------------------------------------------------------------

describe("LAYER_PLAN", () => {
  it("covers every published layer except lakes-polygon.fgb, exactly once", () => {
    const keys = LAYER_PLAN.map((entry) => entry.key);
    const expected = EXPECTED_LAYER_KEYS.filter((key) => key !== "lakes-polygon.fgb");
    expect(keys.slice().sort()).toEqual(expected.slice().sort());
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("applies predicate B to parks, coastline and water ONLY", () => {
    const phase2 = LAYER_PLAN.filter((entry) => entry.phase === 2).map((entry) => entry.key);
    expect(phase2.slice().sort()).toEqual([
      "coastline-line.fgb", "parks-line.fgb", "parks-polygon.fgb",
      "water-line.fgb", "water-polygon.fgb"
    ]);
  });

  // Contract 1.5: the beach envelope set comes from layers 1, 2, 3 and the BEACH
  // HALF of other-relations. The park half must not widen the neighbourhood.
  it("takes beach envelopes from the three beach layers and the beach half of other-relations", () => {
    const always = LAYER_PLAN.filter((e) => e.beachEnvelope === "always").map((e) => e.key);
    expect(always.slice().sort()).toEqual([
      "beaches-line.fgb", "beaches-point.fgb", "beaches-polygon.fgb"
    ]);
    const beachOnly = LAYER_PLAN.filter((e) => e.beachEnvelope === "beachOnly").map((e) => e.key);
    expect(beachOnly).toEqual(["other-relations.fgb"]);
  });

  // D19: the lines-only second GDAL pass is the SOLE source of coastline.
  it("reads coastline from the raw-lines pass and everything else from the main pass", () => {
    const coastline = LAYER_PLAN.find((entry) => entry.key === "coastline-line.fgb");
    expect(coastline.raw).toBe("rawLines");
    expect(coastline.source).toBe("lines");
    const others = LAYER_PLAN.filter((entry) => entry.key !== "coastline-line.fgb");
    for (const entry of others) {
      expect(entry.raw).toBe("raw");
    }
  });
});

// --- serialization ------------------------------------------------------------------

describe("layerPropertyKeys / toGeoJsonFeature", () => {
  it("emits every field contract 1.4 says the consumer branches on", () => {
    for (const entry of LAYER_PLAN) {
      const keys = layerPropertyKeys(entry);
      for (const field of PUBLISHED_LAYER_FIELDS[entry.key]) {
        expect(keys).toContain(field);
      }
      for (const promoted of SOURCE_TAG_KEYS[entry.source]) {
        expect(keys).toContain(promoted);
      }
    }
  });

  it("gives osm_way_id only to the multipolygon-sourced layers", () => {
    for (const entry of LAYER_PLAN) {
      const hasWayId = layerPropertyKeys(entry).indexOf("osm_way_id") !== -1;
      expect(hasWayId).toBe(entry.source === "multipolygons");
    }
  });

  // THE NULLS ARE THE POINT: GDAL creates only the fields it sees while scanning,
  // so a key omitted when the tag is absent is a column that may never exist —
  // and a dropped wikidata is the silent mass-hide of every Great Lakes beach.
  it("emits an explicit null for an absent tag rather than omitting the key", () => {
    const entry = LAYER_PLAN.find((e) => e.key === "water-polygon.fgb");
    const keys = layerPropertyKeys(entry);
    const feature = toGeoJsonFeature(layerFeature({
      osmType: "way", osmId: 42, tags: { natural: "water" }
    }), keys);
    expect(Object.prototype.hasOwnProperty.call(feature.properties, "wikidata")).toBe(true);
    expect(feature.properties.wikidata).toBe(null);
    expect(feature.properties.natural).toBe("water");
  });

  // osm_id vs osm_way_id is the way/relation discriminator, and it feeds
  // "osm-" + osmType + "-" + osmId, the D1 primary key AND the KV flag key.
  it("routes a way to osm_way_id and a relation to osm_id on a polygon layer", () => {
    const keys = layerPropertyKeys(LAYER_PLAN.find((e) => e.key === "beaches-polygon.fgb"));
    const way = toGeoJsonFeature(layerFeature({ osmType: "way", osmId: 7 }), keys);
    expect(way.properties.osm_way_id).toBe("7");
    expect(way.properties.osm_id).toBe(null);
    const relation = toGeoJsonFeature(layerFeature({ osmType: "relation", osmId: 9 }), keys);
    expect(relation.properties.osm_id).toBe("9");
    expect(relation.properties.osm_way_id).toBe(null);
  });

  it("puts a node/way id on osm_id for a layer with no osm_way_id column", () => {
    const keys = layerPropertyKeys(LAYER_PLAN.find((e) => e.key === "beaches-point.fgb"));
    const node = toGeoJsonFeature(layerFeature({ osmType: "node", osmId: 5 }), keys);
    expect(node.properties.osm_id).toBe("5");
    expect(Object.prototype.hasOwnProperty.call(node.properties, "osm_way_id")).toBe(false);
  });

  it("carries the geometry through untouched — no -clipsrc anywhere", () => {
    const geometry = { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] };
    const keys = layerPropertyKeys(LAYER_PLAN[0]);
    const feature = toGeoJsonFeature(layerFeature({ geometry: geometry }), keys);
    expect(feature.type).toBe("Feature");
    expect(feature.geometry).toBe(geometry);
  });
});

// --- argument parsing -----------------------------------------------------------------

describe("parseArgs", () => {
  it("reads the three required paths", () => {
    expect(parseArgs(["--raw", "/w/raw", "--raw-lines", "/w/raw-lines", "--out", "/w/clipped"]))
      .toEqual({ raw: "/w/raw", rawLines: "/w/raw-lines", out: "/w/clipped" });
  });

  it("throws by name on a missing argument", () => {
    expect(() => parseArgs(["--raw", "/w/raw"]))
      .toThrow("clip-layers: missing required argument(s): --raw-lines, --out");
  });

  it("throws on an unknown argument rather than ignoring it", () => {
    expect(() => parseArgs(["--clipsrc", "x"]))
      .toThrow("clip-layers: unknown argument: --clipsrc");
  });
});

// --- one composed pipeline test ----------------------------------------------------

describe("the composed clip", () => {
  it("runs A on the beach layers, then A+B on the rest, exactly as the build does", () => {
    const boxes = regionBoxes(REGIONS, REGION_SPAT_PAD_DEG);

    // Three raw features: a Chicago lakefront beach node, an inland-Wisconsin
    // beach node inside the -spat union but outside every region, and a park
    // polygon 5 km inland of the lakefront beach.
    const lakefrontBeach = layerFeature({
      osmType: "node", osmId: 1, tags: { natural: "beach", name: "Oak Street Beach" },
      bounds: pointBounds(-87.62, 41.9)
    });
    lakefrontBeach.bounds = pointBounds(-87.62, 41.9);
    const inlandBeach = layerFeature({
      osmType: "node", osmId: 2, tags: { natural: "beach", name: "Interior Pond Beach" }
    });
    inlandBeach.bounds = pointBounds(-89.5, 44.0);
    const nearPark = layerFeature({
      osmType: "way", osmId: 3, tags: { name: "Lincoln Park", leisure: "park" }
    });
    nearPark.bounds = bounds(-87.64, 41.89, -87.62, 41.91);
    const farPark = layerFeature({
      osmType: "way", osmId: 4, tags: { name: "Far Park", leisure: "park" }
    });
    farPark.bounds = bounds(-87.20, 41.89, -87.18, 41.91);

    // PHASE 1 — predicate A only, accumulating beach envelopes.
    const beachEnvelopes = [];
    const keptBeaches = [];
    for (const feature of [lakefrontBeach, inlandBeach]) {
      if (!regionEnvelopeKeep(feature.bounds, boxes)) {
        continue;
      }
      if (!isBeachTags(feature.tags)) {
        continue;
      }
      keptBeaches.push(feature.osmId);
      beachEnvelopes.push(feature.bounds);
    }
    expect(keptBeaches).toEqual([1]);

    // PHASE 2 — predicate A then predicate B.
    const index = buildBeachIndex(beachEnvelopes, WATER_CLIP_PAD_DEG);
    const keptParks = [];
    for (const feature of [nearPark, farPark]) {
      if (!regionEnvelopeKeep(feature.bounds, boxes)) {
        continue;
      }
      if (!isNamedParkTags(feature.tags)) {
        continue;
      }
      if (!proximityKeep(feature.bounds, index)) {
        continue;
      }
      keptParks.push(feature.osmId);
    }
    expect(keptParks).toEqual([3]);

    // And the surviving park serializes with its full 1.4 field set.
    const keys = layerPropertyKeys(LAYER_PLAN.find((e) => e.key === "parks-polygon.fgb"));
    const serialized = toGeoJsonFeature(nearPark, keys);
    expect(serialized.properties).toEqual({
      osm_id: null,
      osm_way_id: "3",
      name: "Lincoln Park",
      leisure: "park",
      boundary: null,
      loc_name: null,
      type: null,
      natural: null,
      water: null,
      wikidata: null
    });
  });
});
