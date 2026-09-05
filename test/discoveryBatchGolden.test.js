// test/discoveryBatchGolden.test.js
// End-to-end run of scripts/discovery-batch.js main() over an in-memory
// FlatGeobuf layer set: the emitted SQL is pinned statement by statement, so a
// change to layer loading, streaming, discovery, reconciliation or
// classification that alters the delta fails here. The coastline and water
// layers are streamed: every feature reaches the signals index, and only a way
// whose padded envelope overlaps a beach envelope is retained for discovery.

import { describe, it, expect, afterEach, vi } from "vitest";
import { serialize } from "flatgeobuf/lib/mjs/geojson.js";
import { buildHeader } from "flatgeobuf/lib/mjs/generic/featurecollection.js";
import { magicbytes } from "flatgeobuf/lib/mjs/constants.js";
import { main } from "../scripts/discovery-batch.js";
import { EXPECTED_LAYER_KEYS, regionsDigestInput } from "../src/layerManifest.js";
import { REGIONS } from "../src/regions.js";
import { WATER_CLASS_VERSION } from "../src/waterClass.js";

const PROPS = { osm_id: null, osm_way_id: null, name: null, loc_name: null, natural: null,
  leisure: null, boundary: null, water: null, wikidata: null, type: null };

function feat(geometry, props) {
  return { type: "Feature", geometry: geometry, properties: Object.assign({}, PROPS, props) };
}
function ring(minLat, minLon, maxLat, maxLon) {
  return [[minLon, minLat], [minLon, maxLat], [maxLon, maxLat], [maxLon, minLat], [minLon, minLat]];
}
function poly(minLat, minLon, maxLat, maxLon, props) {
  return feat({ type: "MultiPolygon", coordinates: [[ring(minLat, minLon, maxLat, maxLon)]] }, props);
}
function line(positions, props) {
  return feat({ type: "LineString", coordinates: positions }, props);
}
function point(lat, lon, props) {
  return feat({ type: "Point", coordinates: [lon, lat] }, props);
}
function collection(lat, lon, props) {
  return feat({ type: "GeometryCollection", geometries: [
    { type: "LineString", coordinates: [[lon, lat], [lon + 0.0002, lat + 0.0002]] }
  ] }, props);
}

function layerBytes(features) {
  if (features.length === 0) {
    const header = buildHeader({ geometryType: 0, columns: null, envelope: null, featuresCount: 0,
      indexNodeSize: 0, crs: null, title: null, description: null, metadata: null });
    const empty = new Uint8Array(magicbytes.length + header.length);
    empty.set(magicbytes, 0);
    empty.set(header, magicbytes.length);
    return empty;
  }
  return serialize({ type: "FeatureCollection", features: features });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i = i + 1) {
    const b = view[i].toString(16);
    hex = hex + (b.length === 1 ? "0" + b : b);
  }
  return hex;
}

function fixtureLayers() {
  return {
    "beaches-point.fgb": [
      point(43.0005, -86.4990, { osm_id: "1001", name: "Node Beach", natural: "beach" })
    ],
    "beaches-line.fgb": [
      line([[-86.4995, 43.0010], [-86.4993, 43.0012]], { osm_id: "1002", natural: "beach" })
    ],
    "beaches-polygon.fgb": [
      poly(43.0000, -86.5000, 43.0001, -86.4998, { osm_id: "1", osm_way_id: "1003", name: "Sandy Beach", natural: "beach" }),
      poly(43.0015, -86.5015, 43.0016, -86.5013, { osm_id: "2", osm_way_id: "1004", natural: "beach" }),
      poly(43.0005, -86.5010, 43.0006, -86.5009, { osm_id: "3", osm_way_id: "1005", natural: "beach", loc_name: "West Cove" }),
      poly(43.0012, -86.4985, 43.0013, -86.4984, { osm_id: "4", osm_way_id: "1007", natural: "beach" })
    ],
    "parks-polygon.fgb": [
      poly(42.998, -86.502, 43.002, -86.498, { osm_id: "5", osm_way_id: "5001", name: "Dune Park", leisure: "park" })
    ],
    "parks-line.fgb": [],
    "coastline-line.fgb": [
      line([[-86.4990, 43.0011], [-86.4980, 43.0011]], { osm_id: "7001", natural: "coastline" }),
      line([[-86.0, 43.5], [-85.9, 43.5]], { osm_id: "7002", natural: "coastline" })
    ],
    "water-line.fgb": [
      line([[-86.2, 43.3], [-86.1, 43.35]], { osm_id: "8001", natural: "water", water: "river" })
    ],
    "water-polygon.fgb": [
      poly(43.00125, -86.4993, 43.00135, -86.4992, { osm_id: "6", osm_way_id: "8002", natural: "water", water: "pond" }),
      poly(43.0017, -86.5030, 43.0050, -86.5000, { osm_id: "7", osm_way_id: "8003", natural: "water", water: "lake" }),
      poly(43.00062, -86.5012, 43.00072, -86.5006, { osm_id: "8004", natural: "water", water: "lake", wikidata: "Q1169" }),
      poly(43.00135, -86.4985, 43.00140, -86.4984, { osm_id: "9", osm_way_id: "8006", natural: "water", water: "pond" })
    ],
    "lakes-polygon.fgb": [
      poly(42.990, -86.520, 42.9999, -86.490, { osm_id: "9001", name: "Lake Michigan", natural: "water", water: "lake", wikidata: "Q1169" })
    ],
    "other-relations.fgb": [
      collection(43.0008, -86.4995, { osm_id: "1009", name: "Relation Beach", natural: "beach", type: "multipolygon" }),
      collection(42.999, -86.501, { osm_id: "5002", name: "Relation Park", leisure: "park", type: "multipolygon" }),
      collection(43.0, -86.5, { osm_id: "6001", type: "site" })
    ]
  };
}

function snapshotRows() {
  return [
    { id: "osm-way-1003", osm_id: "way/1003", name: "Sandy Beach", lat: 43.00005, lon: -86.4999,
      park_name: "Dune Park", nws_zone: null, marine_zone: null, water_class: "great_lake",
      water_class_version: WATER_CLASS_VERSION, water_class_attempts: 0 },
    { id: "osm-way-4242", osm_id: "way/4242", name: "Dune Park", lat: 43.0009, lon: -86.4991,
      park_name: "Dune Park", nws_zone: null, marine_zone: null, water_class: null,
      water_class_version: null, water_class_attempts: 0 },
    { id: "osm-way-4343", osm_id: "way/4343", name: "Gone Beach", lat: 43.001, lon: -86.5,
      park_name: null, nws_zone: null, marine_zone: null, water_class: null,
      water_class_version: null, water_class_attempts: 0 },
    { id: "osm-node-1001", osm_id: "node/1001", name: "Node Beach", lat: 43.0005, lon: -86.499,
      park_name: "Dune Park", nws_zone: null, marine_zone: null, water_class: "ocean",
      water_class_version: 1, water_class_attempts: 0 }
  ];
}

const NOW = "2026-09-05T00:00:00.000Z";

async function runBatch(layers, extraArgs) {
  const dir = "/layers";
  const files = new Map();
  const names = Object.keys(layers);
  for (let i = 0; i < names.length; i = i + 1) {
    files.set(dir + "/" + names[i], layerBytes(layers[names[i]]));
  }
  const digest = "sha256:" + await sha256Hex(regionsDigestInput(REGIONS));
  files.set(dir + "/report.json", JSON.stringify({
    schemaVersion: 1, buildId: "golden-build", pointerAgreesWithManifest: true, layersVerified: true,
    layersPresent: EXPECTED_LAYER_KEYS.length, layersExpected: EXPECTED_LAYER_KEYS.length,
    buildStatus: "complete", sourcesVerified: true, buildSanityPassed: true,
    regionsDigest: digest, oldestSourceTimestamp: "2026-09-03T00:00:00Z",
    parks: { polygonCount: 1, lineCount: 0, polygonFloor: 1, lineFloor: 0,
      previousPolygonCount: 1, previousLineCount: 0 }
  }));
  files.set("/snapshot.json", JSON.stringify([{ results: snapshotRows() }]));
  const written = new Map();
  const logs = [];
  vi.spyOn(console, "error").mockImplementation(function (msg) { logs.push(String(msg)); });
  vi.spyOn(console, "log").mockImplementation(function () {});
  vi.stubGlobal("Deno", {
    args: ["--layers", dir, "--snapshot", "/snapshot.json", "--out", "/out.sql", "--now", NOW]
      .concat(extraArgs || []),
    readTextFile: async function (path) {
      const value = files.get(path);
      if (value === undefined) { throw new Error("ENOENT " + path); }
      return typeof value === "string" ? value : new TextDecoder().decode(value);
    },
    writeTextFile: async function (path, text) { written.set(path, text); },
    readFile: async function (path) {
      const value = files.get(path);
      if (value === undefined) { throw new Error("ENOENT " + path); }
      return value;
    },
    open: async function (path) {
      const value = files.get(path);
      if (value === undefined) { throw new Error("ENOENT " + path); }
      let offset = 0;
      return {
        readable: new ReadableStream({
          pull: function (controller) {
            if (offset >= value.length) { controller.close(); return; }
            const end = Math.min(offset + 1024, value.length);
            controller.enqueue(value.slice(offset, end));
            offset = end;
          }
        }),
        close: function () {}
      };
    }
  });
  await main();
  return { sql: written.get("/out.sql"), logs: logs };
}

describe("discovery-batch golden run", function () {
  afterEach(function () { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("emits the pinned delta for the fixture layer set", async function () {
    const result = await runBatch(fixtureLayers());
    const sql = result.sql;
    expect(sql).toContain("-- mode: discovery=true classify=true");
    expect(sql).toContain("-- beach upserts (5)");
    expect(sql).toContain("VALUES ('osm-node-1001', 'Node Beach', 43.0005, -86.499, 'node/1001', 'Dune Park')");
    expect(sql).toContain("VALUES ('osm-way-1003', 'Sandy Beach', 43.00005, -86.4999, 'way/1003', 'Dune Park')");
    expect(sql).toContain("VALUES ('osm-relation-1009', 'Relation Beach', 43.0009, -86.4994, 'relation/1009', 'Dune Park')");
    expect(sql).toContain("'osm-way-1002', 'Dune Park', ");
    expect(sql).toContain("'osm-way-1005', 'Dune Park — West Cove', ");
    // The way-1004 unnamed beach is indistinguishable from the primary and drops.
    expect(sql).not.toContain("'osm-way-1004'");
    expect(sql).toContain("-- stale park-beach reconciliation (1)");
    expect(sql).toContain("DELETE FROM beaches WHERE id = 'osm-way-4242';");
    expect(sql).not.toContain("DELETE FROM beaches WHERE id = 'osm-way-4343';");
    expect(sql).toContain("-- water-class updates (5)");
    expect(sql).toContain("SET water_class = 'ocean', water_class_version = 2, water_class_attempts = 0 WHERE id = 'osm-node-1001';");
    expect(sql).toContain("SET water_class = 'ocean', water_class_version = 2, water_class_attempts = 0 WHERE id = 'osm-relation-1009';");
    expect(sql).toContain("SET water_class = 'ocean', water_class_version = 2, water_class_attempts = 0 WHERE id = 'osm-way-1002';");
    expect(sql).toContain("SET water_class = 'great_lake', water_class_version = 2, water_class_attempts = 0 WHERE id = 'osm-way-1005';");
    expect(sql).toContain("SET water_class_attempts = water_class_attempts + 1 WHERE id = 'osm-way-4343';");
    expect(sql).toContain("('last_discovery_count', '5',");
    expect(sql).toContain("('last_discovery_complete', 'true',");
  });

  it("streams coastline and water: every feature indexed, only near-beach ways retained", async function () {
    const result = await runBatch(fixtureLayers());
    const loaded = result.logs.find(function (l) { return l.indexOf("layers loaded in") !== -1; });
    expect(loaded).toBeDefined();
    // coastline 7002 sits 50 km from every beach and is dropped from discovery.
    expect(loaded).toContain("coastline_streamed=2 coastline_retained=1");
    // water 8001 (far river way) and 8004 (a relation, no osm_way_id) drop; 8002, 8003, 8006 stay.
    expect(loaded).toContain("water_streamed=5 water_retained=3");
    expect(loaded).toContain("lakes_streamed=1");
    const index = result.logs.find(function (l) { return l.indexOf("signals index built during load") !== -1; });
    expect(index).toBeDefined();
    const stats = JSON.parse(index.slice(index.indexOf("{")));
    expect(stats.coastline.features).toBe(2);
    expect(stats.water.features).toBe(5);
    expect(stats.lakes.features).toBe(1);
  });

  it("a coastline way 50 km from every beach still decides ocean for a beach it touches", async function () {
    const layers = fixtureLayers();
    // Move the far coastline next to Node Beach only; it must then classify ocean
    // through the index even though it is nowhere near the pond pool's other seeds.
    layers["coastline-line.fgb"] = [
      line([[-86.4991, 43.0006], [-86.4989, 43.0006]], { osm_id: "7001", natural: "coastline" })
    ];
    const result = await runBatch(layers);
    expect(result.sql).toContain("SET water_class = 'ocean', water_class_version = 2, water_class_attempts = 0 WHERE id = 'osm-node-1001';");
  });
});
