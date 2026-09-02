// Tests for scripts/lib/fgbReader.js — the FlatGeobuf reader the offline layer
// pipeline runs on Deno. The module has NO entrypoint and touches no I/O at
// import time (Deno.readFile / Deno.open are reached through globalThis inside
// the two file readers, exactly as scripts/build-marine-zones.js guards its main
// with import.meta.main), so importing it under vitest is safe: no Deno access,
// no network, no files.
//
// Every fixture is built IN MEMORY with the same library's serializer, so there
// are no committed binaries and no GDAL on anyone's machine. buildLayerBytes
// carries the malformation knobs (truncateTo, emptyLayer) rather than each test
// hand-rolling corrupt input.
//
// Half the budget here is on the artifact-is-corrupt paths and their EXACT throw
// messages. That is deliberate and it is the reason this module exists in this
// shape: a layer pipeline that half-parses is how you silently zero a layer, and
// a zeroed layer feeds the only DELETE-bearing job in the repo. The library gives
// us no protection for free — a buffer truncated in the header region decodes as
// ZERO features with no error at all, which is asserted below.

import { describe, it, expect } from "vitest";
import { serialize } from "flatgeobuf/lib/mjs/geojson.js";
import { buildHeader } from "flatgeobuf/lib/mjs/generic/featurecollection.js";
import { magicbytes } from "flatgeobuf/lib/mjs/constants.js";
import {
  readFgb,
  readLayerFile,
  readFgbStream,
  toLayerFeature,
  geometryBounds,
  LAYER_TAG_KEYS
} from "../scripts/lib/fgbReader.js";

// --- fixture builders -----------------------------------------------------------

// One GeoJSON feature literal per published source layer, named for the layer it
// stands in for. Property sets are kept identical across the features of one
// fixture because the library's serializer derives the column list from
// features[0] ALONE: a key missing from the FIRST feature is dropped from every
// feature, silently.
function pointFeature(id, props) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-87.6, 41.9] },
    properties: Object.assign(
      { osm_id: id, osm_way_id: null, name: null, loc_name: null, natural: null, leisure: null },
      props
    )
  };
}

function lineFeature(id, props) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [[-87.6, 41.9], [-87.4, 42.1]] },
    properties: Object.assign(
      { osm_id: id, osm_way_id: null, name: null, loc_name: null, natural: null, leisure: null },
      props
    )
  };
}

function polygonFeature(id, props) {
  return {
    type: "Feature",
    geometry: {
      type: "MultiPolygon",
      coordinates: [[[[-87.6, 41.9], [-87.4, 41.9], [-87.4, 42.1], [-87.6, 42.1], [-87.6, 41.9]]]]
    },
    properties: Object.assign(
      { osm_id: id, osm_way_id: null, name: null, loc_name: null, natural: null, leisure: null },
      props
    )
  };
}

// The other-relations layer: GDAL yields a GeometryCollection, and the reader
// must treat it as a relation consumed by envelope only.
function collectionFeature(id, props) {
  return {
    type: "Feature",
    geometry: {
      type: "GeometryCollection",
      geometries: [
        { type: "Point", coordinates: [-87.7, 41.8] },
        { type: "LineString", coordinates: [[-87.5, 42.0], [-87.3, 42.2]] }
      ]
    },
    properties: Object.assign(
      { osm_id: id, osm_way_id: null, name: null, loc_name: null, natural: null, leisure: null },
      props
    )
  };
}

// Serializes features to FlatGeobuf bytes. Knobs:
//   emptyLayer  — emit a valid 0-feature layer (the serializer cannot do this
//                 itself: it reads features[0].properties for the column list)
//   truncateTo  — cut the buffer to N bytes (a header-region cut and a
//                 feature-region cut fail in completely different ways)
function buildLayerBytes(features, options) {
  const opts = options || {};
  if (opts.emptyLayer) {
    const header = buildHeader({
      geometryType: 0,
      columns: null,
      envelope: null,
      featuresCount: 0,
      indexNodeSize: 0,
      crs: null,
      title: null,
      description: null,
      metadata: null
    });
    const empty = new Uint8Array(magicbytes.length + header.length);
    empty.set(magicbytes, 0);
    empty.set(header, magicbytes.length);
    return empty;
  }
  const bytes = serialize({ type: "FeatureCollection", features: features });
  if (opts.truncateTo != null) {
    return bytes.slice(0, opts.truncateTo);
  }
  return bytes;
}

// --- readFgb: the happy paths ---------------------------------------------------

describe("readFgb", function () {
  it("round-trips a mixed-geometry collection in file order with properties intact", async function () {
    const bytes = buildLayerBytes([
      pointFeature("11", { name: "Node Beach", area: 1.5 }),
      lineFeature("22", { name: null, area: 2.25 }),
      polygonFeature("33", { name: "Poly Beach", area: 0.5 })
    ]);
    const features = await readFgb(bytes);
    expect(features.length).toBe(3);
    expect(features.map(function (f) { return f.geometry.type; }))
      .toEqual(["Point", "LineString", "MultiPolygon"]);
    // String and float survive verbatim.
    expect(features[0].properties.osm_id).toBe("11");
    expect(features[0].properties.name).toBe("Node Beach");
    expect(features[1].properties.area).toBe(2.25);
    // A NULL property comes back ABSENT rather than null: the writer omits null
    // values entirely. That matches what toLayerFeature does with the tag set
    // anyway (absent, never null), so the two agree by construction.
    expect("name" in features[1].properties).toBe(false);
    expect(features[2].properties.osm_id).toBe("33");
  });

  it("reads a 0-feature layer as an empty array, distinguishably from a failed read", async function () {
    const features = await readFgb(buildLayerBytes([], { emptyLayer: true }));
    expect(Array.isArray(features)).toBe(true);
    expect(features.length).toBe(0);
  });
});

// --- readFgb: the artifact-is-corrupt paths -------------------------------------

describe("readFgb rejects unreadable bytes", function () {
  it("throws on a buffer truncated inside the FEATURE area", async function () {
    const whole = buildLayerBytes([pointFeature("1", {}), pointFeature("2", {})]);
    const bytes = buildLayerBytes(
      [pointFeature("1", {}), pointFeature("2", {})],
      { truncateTo: whole.length - 20 }
    );
    // The library's own failure here is an opaque RangeError whose text varies by
    // runtime, so the assertion pins OUR prefix and leaves the cause free.
    await expect(readFgb(bytes)).rejects.toThrow(/^fgbReader: undecodable FlatGeobuf bytes: /);
  });

  it("throws on a buffer truncated in the HEADER region, which the library decodes as zero features", async function () {
    const bytes = buildLayerBytes(
      [pointFeature("1", {}), pointFeature("2", {}), pointFeature("3", {})],
      { truncateTo: 60 }
    );
    // This is the silent-zero case and the entire reason for the featuresCount
    // trip-wire: without it this buffer reads as a perfectly healthy empty layer.
    await expect(readFgb(bytes)).rejects.toThrow(
      "fgbReader: truncated FlatGeobuf: header declares 3 features, decoded 0"
    );
  });

  it("throws on a buffer that is not FlatGeobuf at all", async function () {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    await expect(readFgb(bytes)).rejects.toThrow(
      "fgbReader: undecodable FlatGeobuf bytes: Not a FlatGeobuf file"
    );
  });

  it("throws on an empty buffer instead of reading it as an empty layer", async function () {
    // The library's magic-byte check is an .every() over a 3-byte subarray, and
    // .every() on an EMPTY array is vacuously true — a zero-byte download would
    // otherwise sail straight through it.
    await expect(readFgb(new Uint8Array(0))).rejects.toThrow(
      "fgbReader: not a FlatGeobuf file: 0 bytes is shorter than the 12-byte minimum header"
    );
  });

  it("throws when handed something that is not a Uint8Array", async function () {
    await expect(readFgb(null)).rejects.toThrow("fgbReader: expected Uint8Array bytes, got object");
  });
});

// --- toLayerFeature: osmType derivation -----------------------------------------

describe("toLayerFeature osmType derivation", function () {
  it("maps a points-layer feature to a node", function () {
    const record = toLayerFeature({
      geometry: { type: "Point", coordinates: [-87.6, 41.9] },
      properties: { osm_id: "12345" }
    }, "beaches");
    expect(record.osmType).toBe("node");
    expect(record.osmId).toBe(12345);
  });

  it("maps a lines-layer feature to a way", function () {
    const record = toLayerFeature({
      geometry: { type: "LineString", coordinates: [[-87.6, 41.9], [-87.5, 42.0]] },
      properties: { osm_id: "678" }
    }, "coastline");
    expect(record.osmType).toBe("way");
    expect(record.osmId).toBe(678);
  });

  it("maps a multipolygon carrying osm_way_id to a WAY, using that id", function () {
    const record = toLayerFeature({
      geometry: { type: "Polygon", coordinates: [[[-87.6, 41.9], [-87.5, 41.9], [-87.5, 42.0], [-87.6, 41.9]]] },
      properties: { osm_id: "999", osm_way_id: "4242" }
    }, "parks");
    expect(record.osmType).toBe("way");
    expect(record.osmId).toBe(4242);
  });

  it("maps a multipolygon with an empty osm_way_id to a RELATION, using osm_id", function () {
    const record = toLayerFeature({
      geometry: { type: "MultiPolygon", coordinates: [[[[-87.6, 41.9], [-87.5, 41.9], [-87.5, 42.0], [-87.6, 41.9]]]] },
      properties: { osm_id: "777", osm_way_id: "" }
    }, "lakes");
    expect(record.osmType).toBe("relation");
    expect(record.osmId).toBe(777);
  });

  it("maps an other-relations GeometryCollection to a relation", function () {
    const record = toLayerFeature({
      geometry: {
        type: "GeometryCollection",
        geometries: [{ type: "Point", coordinates: [-87.6, 41.9] }]
      },
      properties: { osm_id: "31337" }
    }, "beaches");
    expect(record.osmType).toBe("relation");
    expect(record.osmId).toBe(31337);
  });
});

// --- toLayerFeature: skips, tags and bounds -------------------------------------

describe("toLayerFeature skips rather than throws", function () {
  it("skips a null-geometry feature", function () {
    expect(toLayerFeature({ geometry: null, properties: { osm_id: "1" } }, "beaches")).toBe(null);
  });

  it("skips a feature with no osm_id", function () {
    expect(toLayerFeature({
      geometry: { type: "Point", coordinates: [-87.6, 41.9] },
      properties: { name: "Nameless id-less" }
    }, "beaches")).toBe(null);
  });

  it("skips a feature whose osm_id is not a finite number", function () {
    expect(toLayerFeature({
      geometry: { type: "Point", coordinates: [-87.6, 41.9] },
      properties: { osm_id: "way/12" }
    }, "beaches")).toBe(null);
  });

  it("skips a geometry that yields no coordinates", function () {
    expect(toLayerFeature({
      geometry: { type: "MultiPolygon", coordinates: [] },
      properties: { osm_id: "5" }
    }, "beaches")).toBe(null);
  });

  it("skips an unknown geometry type", function () {
    expect(toLayerFeature({
      geometry: { type: "Circle", coordinates: [-87.6, 41.9] },
      properties: { osm_id: "5" }
    }, "beaches")).toBe(null);
  });
});

describe("toLayerFeature tags and bounds", function () {
  it("copies only the layer tag keys, omitting absent, null and empty values", function () {
    const record = toLayerFeature({
      geometry: { type: "Point", coordinates: [-87.6, 41.9] },
      properties: {
        osm_id: "1",
        name: "Beach",
        loc_name: "",
        natural: "beach",
        wikidata: null,
        other_tags: "\"surface\"=>\"sand\""
      }
    }, "beaches");
    expect(record.tags).toEqual({ name: "Beach", natural: "beach" });
    expect(LAYER_TAG_KEYS.indexOf("other_tags")).toBe(-1);
  });

  it("carries the geometry through by reference rather than copying it", function () {
    const geometry = { type: "Point", coordinates: [-87.6, 41.9] };
    const record = toLayerFeature({ geometry: geometry, properties: { osm_id: "1" } }, "beaches");
    expect(record.geometry).toBe(geometry);
    expect(record.layer).toBe("beaches");
  });

  it("degenerates a Point to a zero-extent envelope, as a node beach must be", function () {
    const record = toLayerFeature({
      geometry: { type: "Point", coordinates: [-87.6, 41.9] },
      properties: { osm_id: "1" }
    }, "beaches");
    expect(record.bounds).toEqual({ minLat: 41.9, minLon: -87.6, maxLat: 41.9, maxLon: -87.6 });
    // areaDeg2 downstream is (maxLat-minLat)*(maxLon-minLon), so a node is always
    // pond-testable. Assert the product rather than trusting the reader.
    const area = (record.bounds.maxLat - record.bounds.minLat) *
      (record.bounds.maxLon - record.bounds.minLon);
    expect(area).toBe(0);
  });

  it("walks every coordinate of a GeometryCollection for bounds", function () {
    const bounds = geometryBounds({
      type: "GeometryCollection",
      geometries: [
        { type: "Point", coordinates: [-87.7, 41.8] },
        { type: "LineString", coordinates: [[-87.5, 42.0], [-87.3, 42.2]] }
      ]
    });
    expect(bounds).toEqual({ minLat: 41.8, minLon: -87.7, maxLat: 42.2, maxLon: -87.3 });
  });

  it("returns null bounds for a geometry with no positions", function () {
    expect(geometryBounds({ type: "LineString", coordinates: [] })).toBe(null);
  });
});

// --- the Deno-only surface ------------------------------------------------------

describe("the file readers are Deno-only and say so", function () {
  it("readLayerFile rejects under Node with an actionable message", async function () {
    await expect(readLayerFile("beaches-point.fgb", "beaches")).rejects.toThrow(
      /^fgbReader: readLayerFile requires Deno/
    );
  });

  it("readFgbStream rejects under Node with an actionable message", async function () {
    const iterate = async function () {
      const out = [];
      for await (const record of readFgbStream("water-polygon.fgb", "water")) {
        out.push(record);
      }
      return out;
    };
    await expect(iterate()).rejects.toThrow(/^fgbReader: readFgbStream requires Deno/);
  });
});

// --- pipeline sanity: GeoJSON -> FlatGeobuf bytes -> LayerFeature records --------

describe("end-to-end read of a synthetic published layer", function () {
  it("turns serialized layer bytes into the records the pure src modules consume", async function () {
    const bytes = buildLayerBytes([
      pointFeature("1001", { name: "Node Beach", natural: "beach" }),
      polygonFeature("1002", { name: "Relation Beach", natural: "beach" }),
      polygonFeature("9", { osm_way_id: "2002", name: "Way Park", leisure: "park" }),
      collectionFeature("3003", { name: "Relation Park", leisure: "park" })
    ]);
    const records = [];
    const raw = await readFgb(bytes);
    for (let i = 0; i < raw.length; i = i + 1) {
      const record = toLayerFeature(raw[i], "beaches");
      if (record !== null) {
        records.push(record);
      }
    }
    // The id form below is the D1 primary key AND the KV flag key; getting the
    // node/way/relation split wrong here orphans every stored flag.
    const ids = records.map(function (r) { return "osm-" + r.osmType + "-" + r.osmId; });
    expect(ids).toEqual([
      "osm-node-1001",
      "osm-relation-1002",
      "osm-way-2002",
      "osm-relation-3003"
    ]);
    expect(records[0].tags).toEqual({ name: "Node Beach", natural: "beach" });
    expect(records[2].tags).toEqual({ name: "Way Park", leisure: "park" });
    expect(records[3].bounds).toEqual({
      minLat: 41.8, minLon: -87.7, maxLat: 42.2, maxLon: -87.3
    });
  });
});
