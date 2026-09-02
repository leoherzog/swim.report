// Tests for scripts/build-manifest.js — the BUILD-SIDE GATE of contract 5.3,
// which is the primary defence against mass deletion. The module's entrypoint is
// guarded by import.meta.main (falsy under vitest/node), so importing the pure
// exports is safe: no Deno access, no subprocess, no file system.
//
// Every fixture is built in memory from readable primitives via one named helper
// per artifact kind (a layer measurement, a manifest, a floors file, an ogrinfo
// dump), each with explicit MALFORMATION knobs, because the failure this file
// exists to catch is a gate that waves through a half-built layer set. Roughly
// half the budget goes to the refusals rather than the happy path, for the same
// reason scripts/lib/fgbReader.js spends its budget on the corrupt-artifact
// paths: a pipeline that half-passes is how you silently zero a layer.

import { describe, it, expect } from "vitest";
import { EXPECTED_LAYER_KEYS, LAYER_SCHEMA_VERSION } from "../src/layerManifest.js";
import { GREAT_LAKE_QIDS } from "../src/waterClass.js";
import {
  BUILD_SHRINK_MIN_RATIO,
  BUILD_BYTES_MIN_RATIO,
  BUILD_GROWTH_WARN_RATIO,
  BUILD_DECAY_MIN_RATIO,
  REGION_FLOOR_MIN,
  HISTORY_RETAIN,
  REQUIRED_LAYER_FIELDS,
  REGION_LAYER_NAMES,
  REGION_COUNT_FIELDS,
  UNCLIPPED_LAYER_KEYS,
  parseOgrinfoLayer,
  lakesWikidataFrom,
  aggregateRegionCounts,
  regionCountsToManifest,
  regionCountsFromManifest,
  floorsEntryFor,
  absoluteFloorRefusals,
  lakesIdentityRefusals,
  sidecarRefusals,
  schemaRefusals,
  regionFloorRefusals,
  shrinkRatioRefusals,
  regionShrinkRefusals,
  decayRefusals,
  historyEntryFor,
  buildHistory,
  oldestRetained,
  previousLayerIndex,
  previousRegionIndex,
  evaluateGates,
  runnerImageOf,
  sha256SumsText,
  verifySources,
  parseArgs
} from "../scripts/build-manifest.js";

const QIDS = Object.keys(GREAT_LAKE_QIDS);

// --- fixture builders ------------------------------------------------------------

// One measured layer as main() assembles it from ogrinfo + stat + sha256.
// knobs: featureCount, bytes, fields (pass [] to model a schema GDAL dropped a
// field from), sha256.
function layer(key, options) {
  const opts = options === undefined ? {} : options;
  return {
    key: key,
    featureCount: opts.featureCount === undefined ? 1000 : opts.featureCount,
    bytes: opts.bytes === undefined ? 100000 : opts.bytes,
    sha256: opts.sha256 === undefined ? "0".repeat(64) : opts.sha256,
    fields: opts.fields === undefined ? REQUIRED_LAYER_FIELDS[key].slice() : opts.fields
  };
}

// A full set of ten measured layers. overrides is keyed by layer key.
function layerSet(overrides) {
  const over = overrides === undefined ? {} : overrides;
  return EXPECTED_LAYER_KEYS.map(function (key) {
    const opts = over[key] === undefined ? {} : over[key];
    if (key === "lakes-polygon.fgb" && opts.featureCount === undefined) {
      return layer(key, Object.assign({ featureCount: 6 }, opts));
    }
    return layer(key, opts);
  });
}

function layerCountsOf(layers) {
  const out = {};
  for (const entry of layers) {
    out[entry.key] = entry.featureCount;
  }
  return out;
}

// The sidecar counts clip-layers.js writes, keyed by layer NAME (key minus
// ".fgb"). lakes-polygon has no sidecar: ogr2ogr carves it directly.
function sidecarCountsOf(layers) {
  const out = {};
  for (const entry of layers) {
    if (UNCLIPPED_LAYER_KEYS.indexOf(entry.key) !== -1) {
      continue;
    }
    out[entry.key.slice(0, entry.key.length - 4)] = entry.featureCount;
  }
  return out;
}

// A per-region tally in the LOGICAL vocabulary the gates speak.
function regionTally(value) {
  const out = {};
  for (const logical of REGION_LAYER_NAMES) {
    out[logical] = value;
  }
  return out;
}

function regionCounts(spec) {
  const out = {};
  for (const name of Object.keys(spec)) {
    out[name] = typeof spec[name] === "number" ? regionTally(spec[name]) : spec[name];
  }
  return out;
}

// A data/layer-floors.json file. knobs: status, layer floors, region floors.
function floorsFile(digest, options) {
  const opts = options === undefined ? {} : options;
  const entry = {
    status: opts.status === undefined ? "seeded" : opts.status,
    layers: opts.layers === undefined ? {} : opts.layers,
    regions: opts.regions === undefined ? {} : opts.regions
  };
  const floors = {};
  floors[digest] = entry;
  return { schemaVersion: 1, floors: floors };
}

// A previous manifest, in the shape 5.1 defines.
function manifest(options) {
  const opts = options === undefined ? {} : options;
  const layers = opts.layers === undefined ? layerSet() : opts.layers;
  const regions = [];
  const spec = opts.regions === undefined ? {} : opts.regions;
  for (const name of Object.keys(spec)) {
    const counts = regionCountsToManifest(
      typeof spec[name] === "number" ? regionTally(spec[name]) : spec[name]);
    regions.push(Object.assign({ name: name, bbox: {} }, counts));
  }
  return {
    schemaVersion: LAYER_SCHEMA_VERSION,
    buildId: opts.buildId === undefined ? "20260830T064055Z-9f8e7d6" : opts.buildId,
    generated: "2026-08-30T06:40:55.000Z",
    layers: layers,
    regions: regions,
    history: opts.history === undefined ? [] : opts.history,
    buildStatus: "complete"
  };
}

// An ogrinfo -json -so dump. knobs: noLayers, twoLayers, noCount, badJson.
function ogrinfoSummary(name, featureCount, fields, knobs) {
  const k = knobs === undefined ? {} : knobs;
  if (k.badJson) {
    return "ERROR 4: not a FlatGeobuf file";
  }
  const layerEntry = {
    name: name,
    geometryFields: [{ name: "", type: "Polygon" }],
    featureCount: featureCount,
    fields: fields.map(function (field) { return { name: field, type: "String" }; })
  };
  if (k.noCount) {
    delete layerEntry.featureCount;
  }
  const layers = k.noLayers ? [] : (k.twoLayers ? [layerEntry, layerEntry] : [layerEntry]);
  return JSON.stringify({ description: "x", driverShortName: "FlatGeobuf", layers: layers });
}

const DIGEST = "sha256:b206bbdc0ded40457dfeb046221ad69e44eef71f22ab297e69df0735828907c3";

// --- ogrinfo parsing ---------------------------------------------------------------

describe("parseOgrinfoLayer", () => {
  it("reads the feature count and the schema field names", () => {
    const text = ogrinfoSummary("beaches_point", 4210, ["osm_id", "name", "natural"]);
    expect(parseOgrinfoLayer(text, "beaches-point.fgb")).toEqual({
      name: "beaches_point",
      featureCount: 4210,
      fields: ["osm_id", "name", "natural"]
    });
  });

  it("throws by name when ogrinfo emitted something that is not JSON", () => {
    expect(() => parseOgrinfoLayer(ogrinfoSummary("x", 1, [], { badJson: true }), "water-line.fgb"))
      .toThrow(/^build-manifest: water-line\.fgb: ogrinfo output is not JSON: /);
  });

  it("throws when ogrinfo reported no layers — never returns a zero count", () => {
    expect(() => parseOgrinfoLayer(ogrinfoSummary("x", 1, [], { noLayers: true }), "water-line.fgb"))
      .toThrow("build-manifest: water-line.fgb: ogrinfo reported no layers");
  });

  it("throws when a published file holds more than one layer", () => {
    expect(() => parseOgrinfoLayer(ogrinfoSummary("x", 1, [], { twoLayers: true }), "water-line.fgb"))
      .toThrow("build-manifest: water-line.fgb: ogrinfo reported 2 layers; " +
        "each published FlatGeobuf file must hold exactly one");
  });

  it("throws rather than guessing when there is no usable featureCount", () => {
    expect(() => parseOgrinfoLayer(ogrinfoSummary("x", 1, [], { noCount: true }), "water-line.fgb"))
      .toThrow("build-manifest: water-line.fgb: ogrinfo reported no usable featureCount");
  });

  it("ignores schema entries with no usable name instead of throwing", () => {
    const text = JSON.stringify({ layers: [{ name: "l", featureCount: 2, fields: [{ name: "osm_id" }, {}, null] }] });
    expect(parseOgrinfoLayer(text, "x").fields).toEqual(["osm_id"]);
  });
});

describe("lakesWikidataFrom", () => {
  // ogrinfo -json is SUMMARY ONLY (measured: it emits no features array at any
  // verbosity), so the six QIDs are read with the pipeline's own FlatGeobuf
  // reader instead — which also brings that reader's truncation trip-wire to
  // bear on the one layer with no clip-layers.js sidecar to cross-check.
  it("reads the wikidata tag off each decoded record", () => {
    expect(lakesWikidataFrom([{ tags: { wikidata: "Q1066" } }, { tags: { wikidata: "Q1169" } }]))
      .toEqual(["Q1066", "Q1169"]);
  });

  it("yields undefined for a record whose wikidata tag is absent", () => {
    const out = lakesWikidataFrom([{ tags: { name: "Lake Somewhere" } }, { tags: null }, null]);
    expect(out.length).toBe(3);
    expect(out).toEqual([undefined, undefined, undefined]);
  });

  it("is an empty list for an empty or malformed record set", () => {
    expect(lakesWikidataFrom([])).toEqual([]);
    expect(lakesWikidataFrom(null)).toEqual([]);
  });
});

// --- region tallies ------------------------------------------------------------------

describe("aggregateRegionCounts", () => {
  it("folds the published layers into the six LOGICAL region-layer names", () => {
    const sidecars = {
      "beaches-point": { regions: { "Lake Erie": 10 } },
      "beaches-line": { regions: { "Lake Erie": 3 } },
      "beaches-polygon": { regions: { "Lake Erie": 7 } },
      "parks-polygon": { regions: { "Lake Erie": 40 } },
      "parks-line": { regions: { "Lake Erie": 5 } },
      "coastline-line": { regions: { "Lake Erie": 0 } },
      "water-line": { regions: { "Lake Erie": 11 } },
      "water-polygon": { regions: { "Lake Erie": 22 } },
      "other-relations": { regions: { "Lake Erie": 2 } }
    };
    expect(aggregateRegionCounts(sidecars, ["Lake Erie"])["Lake Erie"]).toEqual({
      "beaches": 20,
      "parks-polygon": 40,
      "parks-line": 5,
      "coastline": 0,
      "water": 33,
      "other-relations": 2
    });
  });

  it("reads a region no sidecar mentions as zero across the board", () => {
    expect(aggregateRegionCounts({}, ["Niagara River"])["Niagara River"]).toEqual(regionTally(0));
  });
});

describe("regionCountsToManifest / regionCountsFromManifest", () => {
  it("round-trips through the manifest field names of contract 5.1", () => {
    const logical = { "beaches": 1487, "parks-polygon": 3120, "parks-line": 214,
      "coastline": 0, "water": 9022, "other-relations": 31 };
    const flat = regionCountsToManifest(logical);
    expect(flat).toEqual({
      beachCount: 1487, parkPolyCount: 3120, parkLineCount: 214,
      coastlineCount: 0, waterCount: 9022, otherRelationsCount: 31
    });
    expect(regionCountsFromManifest(flat)).toEqual(logical);
  });

  // "not recorded" and "recorded as zero" must not be conflated: the first skips
  // the ratio, the second fails it.
  it("reads a field the previous build did not record as null, NOT zero", () => {
    expect(regionCountsFromManifest({ beachCount: 5 })).toEqual({
      "beaches": 5, "parks-polygon": null, "parks-line": null,
      "coastline": null, "water": null, "other-relations": null
    });
  });
});

// --- Level 1: floors keyed by regionsDigest (D20/MJ-10) --------------------------------

describe("floorsEntryFor", () => {
  it("returns the seeded entry and allows auto-publish", () => {
    const result = floorsEntryFor(floorsFile(DIGEST, { status: "seeded" }), DIGEST);
    expect(result.status).toBe("seeded");
    expect(result.autoPublishAllowed).toBe(true);
    expect(result.reason).toBe(null);
  });

  // The MJ-10 property: appending a Pacific box changes the digest, the new
  // footprint has NO entry here, and the pointer is withheld until a human seeds
  // one — instead of silently mass-hiding every ocean beach.
  it("REFUSES to auto-publish a regionsDigest with no entry", () => {
    const result = floorsEntryFor(floorsFile(DIGEST), "sha256:deadbeef");
    expect(result.entry).toBe(null);
    expect(result.autoPublishAllowed).toBe(false);
    expect(result.reason).toContain("no data/layer-floors.json entry for regionsDigest");
  });

  it("REFUSES to auto-publish a bootstrap-status entry", () => {
    const result = floorsEntryFor(floorsFile(DIGEST, { status: "bootstrap" }), DIGEST);
    expect(result.entry).not.toBe(null);
    expect(result.autoPublishAllowed).toBe(false);
    expect(result.reason).toContain("status \"bootstrap\"");
  });

  it("treats a malformed floors file as an unseeded footprint", () => {
    expect(floorsEntryFor(null, DIGEST).autoPublishAllowed).toBe(false);
    expect(floorsEntryFor({ floors: [] }, DIGEST).autoPublishAllowed).toBe(false);
  });
});

describe("absoluteFloorRefusals", () => {
  it("passes when every floor is null — a null is 'not seeded yet', not zero", () => {
    const floors = { layers: { "beaches-point.fgb": null, "water-line.fgb": null } };
    expect(absoluteFloorRefusals(layerCountsOf(layerSet()), floors)).toEqual([]);
  });

  it("refuses a layer below its seeded floor", () => {
    const layers = layerSet({ "water-polygon.fgb": { featureCount: 800 } });
    const out = absoluteFloorRefusals(layerCountsOf(layers), { layers: { "water-polygon.fgb": 900 } });
    expect(out.length).toBe(1);
    expect(out[0].check).toBe("absolute-floor");
    expect(out[0].message).toContain("800 features is below the seeded floor of 900");
    expect(out[0].overridable).toBe(true);
  });

  // parks-POLYGON zero is the real canary. Park membership comes from this layer
  // alone (D7/M1), membership produces park-origin rows, and park-origin rows are
  // the entire delete-candidate set (982 of 1669 rows), so an empty parks-polygon
  // makes every one of them read as stale.
  it("hard-refuses a parks-polygon count of ZERO, and that refusal is NOT overridable", () => {
    const layers = layerSet({ "parks-polygon.fgb": { featureCount: 0 } });
    const out = absoluteFloorRefusals(layerCountsOf(layers), { layers: {} });
    expect(out.length).toBe(1);
    expect(out[0].check).toBe("parks-polygon-empty");
    expect(out[0].overridable).toBe(false);
  });

  // The guard used to sit on parks-line, reasoning that named park ways exist
  // unconditionally. That is an Overpass-era invariant: Overpass's way[leisure=park]
  // [name] returns closed AND unclosed ways, while GDAL's lines layer holds only
  // UNCLOSED ways (a closed area-tagged way is routed to multipolygons). The first
  // real build measured parks-line 0 against parks-polygon 6457 and the refusal
  // blocked an entirely correct build.
  it("accepts a parks-line count of ZERO, which is legitimate for a GDAL layer set", () => {
    const layers = layerSet({ "parks-line.fgb": { featureCount: 0 } });
    const out = absoluteFloorRefusals(layerCountsOf(layers), { layers: {} });
    expect(out).toEqual([]);
  });

  // The other line layers are empty for the same structural reason.
  it("accepts empty line layers and other-relations at Great Lakes scope", () => {
    const layers = layerSet({
      "beaches-line.fgb": { featureCount: 0 },
      "water-line.fgb": { featureCount: 0 },
      "coastline-line.fgb": { featureCount: 0 },
      "other-relations.fgb": { featureCount: 0 }
    });
    const out = absoluteFloorRefusals(layerCountsOf(layers), { layers: {} });
    expect(out).toEqual([]);
  });

  it("refuses a layer whose count was never measured", () => {
    const counts = layerCountsOf(layerSet());
    delete counts["coastline-line.fgb"];
    const out = absoluteFloorRefusals(counts, { layers: {} });
    expect(out.length).toBe(1);
    expect(out[0].message).toContain("no feature count was measured");
    expect(out[0].overridable).toBe(false);
  });

  it("allows a legitimately zero coastline layer at Great Lakes scope", () => {
    const layers = layerSet({ "coastline-line.fgb": { featureCount: 0 } });
    expect(absoluteFloorRefusals(layerCountsOf(layers), { layers: {} })).toEqual([]);
  });
});

describe("lakesIdentityRefusals", () => {
  it("accepts exactly six features carrying exactly GREAT_LAKE_QIDS", () => {
    expect(lakesIdentityRefusals(6, QIDS.slice(), QIDS)).toEqual([]);
  });

  it("accepts the QIDs in any order", () => {
    expect(lakesIdentityRefusals(6, QIDS.slice().reverse(), QIDS)).toEqual([]);
  });

  // The sharpest canary in the set: the six lake relations are the largest and
  // most reference-heavy objects in the data, so if the GDAL node index broke,
  // this layer goes empty first.
  it("hard-refuses an empty lakes layer", () => {
    const out = lakesIdentityRefusals(0, [], QIDS);
    expect(out.length).toBe(2);
    expect(out[0].message).toContain("expected exactly 6 features, ogrinfo reports 0");
    for (const entry of out) {
      expect(entry.overridable).toBe(false);
    }
  });

  it("hard-refuses a seventh lake", () => {
    const out = lakesIdentityRefusals(7, QIDS.concat(["Q999"]), QIDS);
    expect(out.length).toBe(2);
    expect(out[1].message).toContain("does not equal GREAT_LAKE_QIDS");
  });

  it("hard-refuses six features with a wrong QID even though the count is right", () => {
    const wrong = QIDS.slice(0, 5).concat(["Q999"]);
    const out = lakesIdentityRefusals(6, wrong, QIDS);
    expect(out.length).toBe(1);
    expect(out[0].check).toBe("lakes-identity");
    expect(out[0].overridable).toBe(false);
  });

  it("hard-refuses six features whose wikidata column is entirely null", () => {
    const out = lakesIdentityRefusals(6, [null, null, null, null, null, null], QIDS);
    expect(out.length).toBe(1);
    expect(out[0].message).toContain("wikidata set [] does not equal");
  });
});

// --- integrity: the sidecar cross-check and the schema assertion ------------------------

describe("sidecarRefusals (MJ-7)", () => {
  it("passes when every sidecar equals ogrinfo", () => {
    const layers = layerSet();
    expect(sidecarRefusals(layerCountsOf(layers), sidecarCountsOf(layers))).toEqual([]);
  });

  // A torn GeoJSONSeq tail is SPATIALLY CONTIGUOUS (FlatGeobuf is Hilbert
  // ordered), which is precisely the shape the proportional delete rails are
  // worst at catching — so this equality has no tolerance and no override.
  it("hard-refuses a one-feature disagreement", () => {
    const layers = layerSet();
    const sidecars = sidecarCountsOf(layers);
    sidecars["water-polygon"] = sidecars["water-polygon"] - 1;
    const out = sidecarRefusals(layerCountsOf(layers), sidecars);
    expect(out.length).toBe(1);
    expect(out[0].check).toBe("sidecar-mismatch");
    expect(out[0].overridable).toBe(false);
    expect(out[0].message).toContain("torn GeoJSONSeq tail");
  });

  it("hard-refuses a missing sidecar", () => {
    const layers = layerSet();
    const sidecars = sidecarCountsOf(layers);
    delete sidecars["parks-line"];
    const out = sidecarRefusals(layerCountsOf(layers), sidecars);
    expect(out.length).toBe(1);
    expect(out[0].check).toBe("sidecar-missing");
  });

  it("exempts lakes-polygon, which clip-layers.js does not produce", () => {
    const layers = layerSet();
    const sidecars = sidecarCountsOf(layers);
    expect(Object.prototype.hasOwnProperty.call(sidecars, "lakes-polygon")).toBe(false);
    expect(sidecarRefusals(layerCountsOf(layers), sidecars)).toEqual([]);
  });
});

describe("schemaRefusals (m10/B3)", () => {
  it("passes when every layer carries its required fields plus extras", () => {
    const layers = layerSet();
    const fields = {};
    for (const entry of layers) {
      fields[entry.key] = entry.fields.concat(["protect_class"]);
    }
    expect(schemaRefusals(fields, REQUIRED_LAYER_FIELDS)).toEqual([]);
  });

  // A dropped wikidata is the silent mass-hide of every Great Lakes beach:
  // src/waterClass.js matches shoreline by QID, and nothing else in the pipeline
  // would report an error.
  it("hard-refuses a layer whose wikidata column GDAL dropped", () => {
    const layers = layerSet();
    const fields = {};
    for (const entry of layers) {
      fields[entry.key] = entry.fields.filter(function (f) {
        return !(entry.key === "water-polygon.fgb" && f === "wikidata");
      });
    }
    const out = schemaRefusals(fields, REQUIRED_LAYER_FIELDS);
    expect(out.length).toBe(1);
    expect(out[0].check).toBe("schema-missing");
    expect(out[0].subject).toBe("water-polygon.fgb");
    expect(out[0].message).toContain("[wikidata]");
    expect(out[0].overridable).toBe(false);
  });

  it("names every missing field at once", () => {
    const fields = {};
    for (const key of EXPECTED_LAYER_KEYS) {
      fields[key] = key === "other-relations.fgb"
        ? ["osm_id", "name", "type", "natural"]
        : REQUIRED_LAYER_FIELDS[key].slice();
    }
    const out = schemaRefusals(fields, REQUIRED_LAYER_FIELDS);
    expect(out.length).toBe(1);
    expect(out[0].message).toContain("[loc_name, leisure, boundary]");
  });

  it("hard-refuses when no schema was read at all", () => {
    const out = schemaRefusals({}, REQUIRED_LAYER_FIELDS);
    expect(out.length).toBe(EXPECTED_LAYER_KEYS.length);
    expect(out[0].message).toContain("no ogrinfo schema was read");
  });

  // coastline-line.fgb is LEGITIMATELY empty at Great Lakes scope: the lakes are
  // mapped as water relations, not natural=coastline ways. GDAL cannot infer a
  // field list from no features, so asserting a schema on it would make the very
  // first Great Lakes build fail. The count gates catch an UNEXPECTED zero.
  it("exempts a zero-feature layer, whose schema GDAL cannot infer", () => {
    const fields = {};
    for (const key of EXPECTED_LAYER_KEYS) {
      fields[key] = key === "coastline-line.fgb" ? [] : REQUIRED_LAYER_FIELDS[key].slice();
    }
    const counts = layerCountsOf(layerSet({ "coastline-line.fgb": { featureCount: 0 } }));
    expect(schemaRefusals(fields, REQUIRED_LAYER_FIELDS, counts)).toEqual([]);
    // ... but the same empty schema on a NON-empty layer is still a hard refusal.
    const populated = layerCountsOf(layerSet());
    const out = schemaRefusals(fields, REQUIRED_LAYER_FIELDS, populated);
    expect(out.length).toBe(1);
    expect(out[0].subject).toBe("coastline-line.fgb");
    expect(out[0].overridable).toBe(false);
  });
});

// --- Level 2: per-REGION floors on EVERY clipped layer (BL-1) ----------------------------

describe("regionFloorRefusals", () => {
  it("passes a steady region", () => {
    const current = regionCounts({ "Lake Michigan": 100 });
    const previous = regionCounts({ "Lake Michigan": 100 });
    expect(regionFloorRefusals(current, previous, { regions: {} })).toEqual([]);
  });

  // The BL-1 case: a 15% single-region PARKS regression is ~4-5% globally, so it
  // passes a global ratio and a beaches-only per-region floor untouched — and
  // park-origin rows are the ONLY delete candidates.
  it("refuses a 15% single-region PARKS regression that a global ratio would pass", () => {
    const current = regionCounts({ "Lake Michigan": { "beaches": 1487, "parks-polygon": 2652,
      "parks-line": 214, "coastline": 0, "water": 9022, "other-relations": 31 } });
    const previous = regionCounts({ "Lake Michigan": { "beaches": 1487, "parks-polygon": 3120,
      "parks-line": 214, "coastline": 0, "water": 9022, "other-relations": 31 } });
    const out = regionFloorRefusals(current, previous, { regions: {} });
    expect(out.length).toBe(1);
    expect(out[0].subject).toBe("Lake Michigan/parks-polygon");
  });

  it("applies min(previous, max(REGION_FLOOR_MIN, floor(0.95 * previous)))", () => {
    // previous 8: floor(0.95 * 8) = 7, above REGION_FLOOR_MIN, and below previous.
    const previous = regionCounts({ "Lake Ontario": 8 });
    expect(regionFloorRefusals(regionCounts({ "Lake Ontario": 7 }), previous, { regions: {} }))
      .toEqual([]);
    const out = regionFloorRefusals(regionCounts({ "Lake Ontario": 6 }), previous, { regions: {} });
    expect(out.length).toBe(REGION_LAYER_NAMES.length);
    expect(out[0].message).toContain("min(8, max(" + String(REGION_FLOOR_MIN) + ", floor(" +
      String(BUILD_SHRINK_MIN_RATIO) + " * 8))) = 7");
  });

  it("lets REGION_FLOOR_MIN relax the ratio for a small region", () => {
    // previous 4: floor(0.95 * 4) = 3, which the minimum of 3 matches, so a
    // single-feature swing in a four-feature region is tolerated.
    const previous = regionCounts({ "Niagara River": 4 });
    expect(regionFloorRefusals(regionCounts({ "Niagara River": 3 }), previous, { regions: {} }))
      .toEqual([]);
  });

  // Contract 5.3 writes this rule as max(3, floor(0.95 * previous)), which taken
  // literally INVERTS its own stated purpose below three features: an unchanged
  // region of 1 would be required to reach 3 and would refuse every build
  // forever. Region/layer pairs that small are ordinary here — coastline is
  // legitimately zero-to-tiny at Great Lakes scope and Niagara River carries
  // single digits — so the floor is clamped to the previous count.
  it("never demands that a tiny region GROW to REGION_FLOOR_MIN", () => {
    const previous = regionCounts({ "Niagara River": 1 });
    expect(regionFloorRefusals(regionCounts({ "Niagara River": 1 }), previous, { regions: {} }))
      .toEqual([]);
    const lost = regionFloorRefusals(regionCounts({ "Niagara River": 0 }), previous, { regions: {} });
    expect(lost.length).toBe(REGION_LAYER_NAMES.length);
    expect(lost[0].message).toContain("min(1, max(3, floor(0.95 * 1))) = 1");
  });

  it("skips the ratio for a region the previous build did not record", () => {
    expect(regionFloorRefusals(regionCounts({ "Pacific": 1 }), {}, { regions: {} })).toEqual([]);
  });

  it("applies the seeded per-region floor independently of the ratio", () => {
    const seeded = { regions: { "Lake Erie": { "parks-polygon": 500 } } };
    const current = regionCounts({ "Lake Erie": { "beaches": 100, "parks-polygon": 400,
      "parks-line": 10, "coastline": 0, "water": 100, "other-relations": 1 } });
    const out = regionFloorRefusals(current, null, seeded);
    expect(out.length).toBe(1);
    expect(out[0].message).toContain("below the seeded floor of 500");
    expect(out[0].overridable).toBe(true);
  });

  it("refuses a region whose count was never measured", () => {
    const out = regionFloorRefusals({ "Lake Erie": { "beaches": 1 } }, null, { regions: {} });
    expect(out.length).toBe(REGION_LAYER_NAMES.length - 1);
    expect(out[0].overridable).toBe(false);
  });
});

// --- Level 3: shrink ratios against the PREVIOUS accepted manifest -------------------------

describe("shrinkRatioRefusals", () => {
  const previous = previousLayerIndex(manifest());

  it("passes a set that held steady", () => {
    expect(shrinkRatioRefusals(layerSet(), previous)).toEqual({ refusals: [], warnings: [] });
  });

  // 0.95 and not 0.90: the build gate must always be strictly tighter than the
  // 0.05 delete rail, so the build is always the FIRST refusal.
  it("refuses at just under 0.95x and passes at just over", () => {
    const under = layerSet({ "beaches-polygon.fgb": { featureCount: 949 } });
    const over = layerSet({ "beaches-polygon.fgb": { featureCount: 951 } });
    expect(shrinkRatioRefusals(under, previous).refusals.length).toBe(1);
    expect(shrinkRatioRefusals(under, previous).refusals[0].check).toBe("shrink-ratio");
    expect(shrinkRatioRefusals(over, previous).refusals).toEqual([]);
  });

  // The one thing a feature count cannot catch: a truncated write carrying a
  // plausible header count.
  it("refuses a byte size below 0.80x even when the count is unchanged", () => {
    const truncated = layerSet({ "water-polygon.fgb": { bytes: 70000 } });
    const out = shrinkRatioRefusals(truncated, previous).refusals;
    expect(out.length).toBe(1);
    expect(out[0].check).toBe("shrink-bytes");
    expect(out[0].message).toContain("truncated write");
  });

  // Growth WARNS rather than refuses because the consequences are asymmetric:
  // extra features cause idempotent UPSERTs, missing features cause DELETEs.
  it("WARNS on growth above 1.50x and still publishes", () => {
    const grown = layerSet({ "water-line.fgb": { featureCount: 1600 } });
    const result = shrinkRatioRefusals(grown, previous);
    expect(result.refusals).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("growth: water-line.fgb");
  });

  it("skips a layer the previous build never described", () => {
    expect(shrinkRatioRefusals([layer("beaches-point.fgb", { featureCount: 1 })], {}))
      .toEqual({ refusals: [], warnings: [] });
  });

  it("does not divide by a previous count of zero", () => {
    const prior = { "coastline-line.fgb": { featureCount: 0, bytes: 0 } };
    const grown = [layer("coastline-line.fgb", { featureCount: 5 })];
    expect(shrinkRatioRefusals(grown, prior)).toEqual({ refusals: [], warnings: [] });
  });
});

describe("regionShrinkRefusals", () => {
  it("is strictly tighter than the Level 2 region floor above previous = 3", () => {
    // Niagara 7 -> 6 clears max(3, floor(0.95 * 7)) = 6 but not 0.95 * 7 = 6.65.
    const current = regionCounts({ "Niagara River": 6 });
    const previous = regionCounts({ "Niagara River": 7 });
    expect(regionFloorRefusals(current, previous, { regions: {} })).toEqual([]);
    expect(regionShrinkRefusals(current, previous).length).toBe(REGION_LAYER_NAMES.length);
  });

  it("passes a steady region and refuses independently per layer", () => {
    const previous = regionCounts({ "Lake Erie": 1000 });
    const current = regionCounts({ "Lake Erie": { "beaches": 1000, "parks-polygon": 940,
      "parks-line": 1000, "coastline": 1000, "water": 1000, "other-relations": 1000 } });
    const out = regionShrinkRefusals(current, previous);
    expect(out.length).toBe(1);
    expect(out[0].subject).toBe("Lake Erie/parks-polygon");
    expect(out[0].overridable).toBe(true);
  });

  it("skips a region or layer the previous build did not record", () => {
    expect(regionShrinkRefusals(regionCounts({ "Pacific": 1 }), {})).toEqual([]);
    expect(regionShrinkRefusals(regionCounts({ "Lake Erie": 1 }),
      { "Lake Erie": { "beaches": null } })).toEqual([]);
  });
});

// --- Level 3b: monotone decay against the OLDEST retained build (BL-3) ----------------------

describe("decayRefusals", () => {
  // The check ratio-to-previous structurally cannot make. Lake Michigan
  // 523 -> 418 -> 335 -> ... passes every per-build ratio forever while landing
  // 60-80 silent DELETEs a week.
  it("catches a slow bleed every per-build ratio waves through", () => {
    const oldest = { buildId: "OLD", layers: { "parks-polygon.fgb": 3120 },
      regions: { "Lake Michigan": regionTally(523) } };
    const layers = [layer("parks-polygon.fgb", { featureCount: 2600 })];
    const counts = regionCounts({ "Lake Michigan": 418 });
    const out = decayRefusals(layers, counts, oldest);
    expect(out.length).toBe(1 + REGION_LAYER_NAMES.length);
    expect(out[0].check).toBe("monotone-decay");
    expect(out[0].message).toContain("against the oldest retained build OLD");
    expect(out[0].overridable).toBe(true);
  });

  it("passes a set that is merely 0.90x of the oldest retained build", () => {
    const oldest = { buildId: "OLD", layers: { "parks-polygon.fgb": 1000 },
      regions: { "Lake Michigan": regionTally(100) } };
    const out = decayRefusals([layer("parks-polygon.fgb", { featureCount: 900 })],
      regionCounts({ "Lake Michigan": 90 }), oldest);
    expect(out).toEqual([]);
  });

  it("is a no-op when the history window is empty", () => {
    expect(decayRefusals(layerSet(), regionCounts({ "Lake Erie": 1 }), null)).toEqual([]);
  });
});

// --- history (contract 5.1) --------------------------------------------------------------

describe("historyEntryFor / buildHistory / oldestRetained", () => {
  it("describes a manifest by its layer counts and region tallies", () => {
    const entry = historyEntryFor(manifest({ regions: { "Lake Erie": 12 } }));
    expect(entry.buildId).toBe("20260830T064055Z-9f8e7d6");
    expect(entry.layers["beaches-point.fgb"]).toBe(1000);
    expect(entry.layers["lakes-polygon.fgb"]).toBe(6);
    expect(entry.regions["Lake Erie"].beachCount).toBe(12);
  });

  it("is empty on a bootstrap build", () => {
    expect(buildHistory(null, HISTORY_RETAIN)).toEqual([]);
  });

  // The CURRENT build is deliberately not in its own history — the next build
  // appends it. Otherwise Level 3b would compare a build against itself.
  it("carries the previous history forward plus the previous build itself, newest last", () => {
    const previous = manifest({
      buildId: "B2",
      history: [{ buildId: "B1", generated: "x", layers: {}, regions: {} }]
    });
    const history = buildHistory(previous, HISTORY_RETAIN);
    expect(history.map((e) => e.buildId)).toEqual(["B1", "B2"]);
  });

  it("caps the window at the retention count, dropping the oldest", () => {
    const carried = [];
    for (let i = 0; i < HISTORY_RETAIN; i = i + 1) {
      carried.push({ buildId: "B" + String(i), generated: "x", layers: {}, regions: {} });
    }
    const history = buildHistory(manifest({ buildId: "NEW", history: carried }), HISTORY_RETAIN);
    expect(history.length).toBe(HISTORY_RETAIN);
    expect(history[0].buildId).toBe("B1");
    expect(history[history.length - 1].buildId).toBe("NEW");
  });

  it("reads the oldest retained entry back into the logical vocabulary", () => {
    const history = [{ buildId: "B1", generated: "x",
      layers: { "beaches-point.fgb": 40 },
      regions: { "Lake Erie": { beachCount: 12, parkPolyCount: 30 } } }];
    const oldest = oldestRetained(history);
    expect(oldest.buildId).toBe("B1");
    expect(oldest.layers["beaches-point.fgb"]).toBe(40);
    expect(oldest.regions["Lake Erie"]["beaches"]).toBe(12);
    expect(oldest.regions["Lake Erie"]["water"]).toBe(null);
  });

  it("is null for an empty or malformed window", () => {
    expect(oldestRetained([])).toBe(null);
    expect(oldestRetained(null)).toBe(null);
    expect(oldestRetained([null])).toBe(null);
  });
});

describe("runnerImageOf", () => {
  it("joins the runner's image env vars", () => {
    expect(runnerImageOf("ubuntu24", "20260815.1")).toBe("ubuntu24/20260815.1");
    expect(runnerImageOf("ubuntu24", "")).toBe("ubuntu24");
  });

  // Null, not "": an empty string reads as "we recorded the image and it was
  // blank", which is a different and untrue claim.
  it("is null off a runner rather than an empty string", () => {
    expect(runnerImageOf(undefined, undefined)).toBe(null);
    expect(runnerImageOf("", "")).toBe(null);
  });
});

describe("previousLayerIndex / previousRegionIndex", () => {
  it("indexes the previous manifest by layer key and region name", () => {
    const previous = manifest({ regions: { "Lake Erie": 12 } });
    expect(previousLayerIndex(previous)["beaches-point.fgb"]).toEqual({
      featureCount: 1000, bytes: 100000
    });
    expect(previousRegionIndex(previous)["Lake Erie"]["beaches"]).toBe(12);
  });

  it("is an empty index for a missing previous manifest", () => {
    expect(previousLayerIndex(null)).toEqual({});
    expect(previousRegionIndex(null)).toEqual({});
  });
});

// --- SHA256SUMS (MJ-11) ---------------------------------------------------------------

describe("sha256SumsText", () => {
  it("covers exactly the .fgb files, sorted, in sha256sum format", () => {
    const text = sha256SumsText(layerSet());
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(EXPECTED_LAYER_KEYS.length);
    expect(lines[0]).toBe("0".repeat(64) + "  beaches-line.fgb");
    for (const line of lines) {
      expect(line.slice(-4)).toBe(".fgb");
    }
    expect(text.slice(-1)).toBe("\n");
  });

  // It cannot cover LICENSE.txt (copied in after this script runs) and it must
  // not cover manifest.json (read back and byte-compared on its own instead).
  it("excludes manifest.json, SHA256SUMS and LICENSE.txt", () => {
    const text = sha256SumsText(layerSet().concat([
      { key: "manifest.json", sha256: "a".repeat(64) },
      { key: "LICENSE.txt", sha256: "b".repeat(64) }
    ]));
    expect(text).not.toContain("manifest.json");
    expect(text).not.toContain("LICENSE.txt");
    expect(text).not.toContain("SHA256SUMS");
  });
});

// --- sources ------------------------------------------------------------------------

describe("verifySources", () => {
  it("verifies when every published md5 equals its observed md5", () => {
    const result = verifySources([
      { name: "us", md5Published: "aa", md5Observed: "aa",
        osmosisReplicationTimestamp: "2026-08-31T20:21:20Z" },
      { name: "canada", md5Published: "bb", md5Observed: "bb",
        osmosisReplicationTimestamp: "2026-08-30T20:21:20Z" }
    ]);
    expect(result.verified).toBe(true);
    expect(result.oldestTimestamp).toBe("2026-08-30T20:21:20Z");
  });

  // A mid-download Geofabrik extract rotation shows as a mismatch and can never
  // publish: this is the download-completeness proof that replaces "did every
  // tile fetch".
  it("refuses to claim verification on an md5 mismatch", () => {
    const result = verifySources([{ name: "us", md5Published: "aa", md5Observed: "zz" }]);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("md5 mismatch");
  });

  it("is UNVERIFIED, not verified, when no evidence was supplied at all", () => {
    expect(verifySources(null).verified).toBe(false);
    expect(verifySources([]).verified).toBe(false);
    expect(verifySources(null).reason).toContain("no --sources evidence");
  });
});

// --- argument parsing ------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses the workflow's invocation", () => {
    const args = parseArgs([
      "--layers", "/w/layers", "--floors", "data/layer-floors.json",
      "--previous", "/w/prev-manifest.json", "--snapshot", "2026-08-31T20:21:20Z",
      "--build-id", "20260906T064102Z-a1b2c3d", "--git-sha", "a1b2c3d",
      "--run-id", "1234567890", "--allow-shrink", "false",
      "--counts", "/w/clipped", "--relation-warnings", "3", "--out", "/w/layers/manifest.json"
    ]);
    expect(args.layers).toBe("/w/layers");
    expect(args.allowShrink).toBe(false);
    expect(args.relationWarnings).toBe(3);
    expect(args.retain).toBe(HISTORY_RETAIN);
  });

  it("treats any --allow-shrink value other than the literal 'true' as false", () => {
    const base = ["--layers", "a", "--floors", "b", "--counts", "c", "--build-id", "d", "--out", "e"];
    expect(parseArgs(base.concat(["--allow-shrink", "true"])).allowShrink).toBe(true);
    expect(parseArgs(base.concat(["--allow-shrink", "TRUE"])).allowShrink).toBe(false);
    expect(parseArgs(base.concat(["--allow-shrink", "1"])).allowShrink).toBe(false);
  });

  it("throws by name on a missing required argument", () => {
    expect(() => parseArgs(["--layers", "a"]))
      .toThrow("build-manifest: missing required argument(s): --floors, --counts, --build-id, --out");
  });

  it("throws on an unknown argument", () => {
    expect(() => parseArgs(["--publish", "true"]))
      .toThrow("build-manifest: unknown argument: --publish");
  });
});

// --- evaluateGates ------------------------------------------------------------------------

describe("evaluateGates", () => {
  // The sidecars are derived from whatever layers the override supplies, so a
  // test that moves a feature count is exercising the gate it names rather than
  // tripping the MJ-7 cross-check by accident.
  function goodInput(overrides) {
    const over = overrides === undefined ? {} : overrides;
    const layers = over.layers === undefined ? layerSet() : over.layers;
    const base = {
      layers: layers,
      sidecarCounts: sidecarCountsOf(layers),
      regionCounts: regionCounts({ "Lake Erie": 100, "Lake Michigan": 100 }),
      lakesWikidata: QIDS.slice(),
      floorsFile: floorsFile(DIGEST, { status: "seeded" }),
      regionsDigest: DIGEST,
      previousManifest: manifest({ regions: { "Lake Erie": 100, "Lake Michigan": 100 } }),
      oldest: null,
      allowShrink: false
    };
    return Object.assign(base, over);
  }

  it("passes a healthy build and allows auto-publish", () => {
    const verdict = evaluateGates(goodInput());
    expect(verdict.refusals).toEqual([]);
    expect(verdict.sanity.passed).toBe(true);
    expect(verdict.sanity.autoPublishAllowed).toBe(true);
    expect(verdict.sanity.overridden).toBe(false);
    expect(verdict.sanity.previousBuildId).toBe("20260830T064055Z-9f8e7d6");
  });

  // Level 4. Build 1 has no previous manifest: the ratio checks are skipped, the
  // absolute floors still apply, and the pointer is NOT written automatically.
  it("skips every ratio on a bootstrap build and withholds auto-publish", () => {
    const verdict = evaluateGates(goodInput({
      previousManifest: null,
      layers: layerSet({ "beaches-point.fgb": { featureCount: 1 } })
    }));
    expect(verdict.bootstrap).toBe(true);
    expect(verdict.refusals).toEqual([]);
    expect(verdict.sanity.autoPublishAllowed).toBe(false);
    expect(verdict.warnings.join(" ")).toContain("bootstrap build");
  });

  it("withholds auto-publish for a regionsDigest with no floors entry", () => {
    const verdict = evaluateGates(goodInput({ regionsDigest: "sha256:newfootprint" }));
    expect(verdict.refusals).toEqual([]);
    expect(verdict.sanity.autoPublishAllowed).toBe(false);
    expect(verdict.warnings.join(" ")).toContain("no data/layer-floors.json entry");
  });

  it("withholds auto-publish while the floors entry is still status bootstrap", () => {
    const verdict = evaluateGates(goodInput({
      floorsFile: floorsFile(DIGEST, { status: "bootstrap" })
    }));
    expect(verdict.sanity.autoPublishAllowed).toBe(false);
    expect(verdict.sanity.floors.status).toBe("bootstrap");
  });

  it("refuses independently at each of Level 3 and Level 3b", () => {
    const shrunk = evaluateGates(goodInput({
      layers: layerSet({ "parks-polygon.fgb": { featureCount: 900 } })
    }));
    expect(shrunk.refusals.map((r) => r.check)).toContain("shrink-ratio");
    expect(shrunk.sanity.shrinkRatiosPassed).toBe(false);
    expect(shrunk.sanity.decayPassed).toBe(true);

    const decayed = evaluateGates(goodInput({
      layers: layerSet({ "parks-polygon.fgb": { featureCount: 960 } }),
      previousManifest: manifest({
        layers: layerSet({ "parks-polygon.fgb": { featureCount: 1000 } }),
        regions: { "Lake Erie": 100, "Lake Michigan": 100 }
      }),
      oldest: { buildId: "OLD", layers: { "parks-polygon.fgb": 2000 }, regions: {} }
    }));
    expect(decayed.refusals.map((r) => r.check)).toEqual(["monotone-decay"]);
    expect(decayed.sanity.shrinkRatiosPassed).toBe(true);
    expect(decayed.sanity.decayPassed).toBe(false);
  });

  it("allow_shrink demotes a count refusal to a warning and stamps overridden", () => {
    const input = goodInput({
      layers: layerSet({ "parks-polygon.fgb": { featureCount: 500 } }),
      allowShrink: true
    });
    const verdict = evaluateGates(input);
    expect(verdict.refusals).toEqual([]);
    expect(verdict.sanity.overridden).toBe(true);
    expect(verdict.sanity.passed).toBe(true);
    expect(verdict.warnings.join(" ")).toContain("OVERRIDDEN shrink-ratio");
    // Visible forever, and still not auto-published without a human reading it.
    expect(verdict.sanity.shrinkRatiosPassed).toBe(true);
  });

  // The flag an operator reaches for during an incident must not be able to wave
  // through a torn tail, a dropped column, or a lakes layer that is not the six
  // Great Lakes. None of those is "a legitimate shrink" under any circumstances.
  it("allow_shrink CANNOT override an integrity or identity refusal", () => {
    const layers = layerSet();
    const sidecars = sidecarCountsOf(layers);
    sidecars["water-polygon"] = sidecars["water-polygon"] - 1;
    const verdict = evaluateGates(goodInput({
      sidecarCounts: sidecars,
      lakesWikidata: [],
      allowShrink: true
    }));
    const checks = verdict.refusals.map((r) => r.check);
    expect(checks).toContain("sidecar-mismatch");
    expect(checks).toContain("lakes-identity");
    expect(verdict.sanity.passed).toBe(false);
    expect(verdict.sanity.autoPublishAllowed).toBe(false);
    expect(verdict.sanity.integrityPassed).toBe(false);
  });

  it("reports growth as a published warning, never a refusal", () => {
    const verdict = evaluateGates(goodInput({
      layers: layerSet({ "water-line.fgb": { featureCount: 2000 } })
    }));
    expect(verdict.refusals).toEqual([]);
    expect(verdict.sanity.growthWarnings.length).toBe(1);
    expect(verdict.sanity.autoPublishAllowed).toBe(true);
  });

  it("carries the seeded floors into the manifest so fetch-layers can read them", () => {
    const verdict = evaluateGates(goodInput({
      floorsFile: floorsFile(DIGEST, {
        status: "seeded",
        layers: { "parks-polygon.fgb": 900, "parks-line.fgb": 150 }
      })
    }));
    expect(verdict.sanity.floors.layers["parks-polygon.fgb"]).toBe(900);
    expect(verdict.sanity.floors.digest).toBe(DIGEST);
  });
});

// --- one composed pipeline test -------------------------------------------------------------

describe("the composed gate", () => {
  it("accepts a healthy build, then refuses the same set once parks quietly bleeds", () => {
    const previous = manifest({
      buildId: "B-PREV",
      layers: layerSet({ "parks-polygon.fgb": { featureCount: 3120, bytes: 4000000 } }),
      regions: { "Lake Michigan": { "beaches": 1487, "parks-polygon": 3120, "parks-line": 214,
        "coastline": 0, "water": 9022, "other-relations": 31 } },
      history: [{ buildId: "B-OLD", generated: "x",
        layers: { "parks-polygon.fgb": 3200 },
        regions: { "Lake Michigan": regionCountsToManifest(
          { "beaches": 1487, "parks-polygon": 3200, "parks-line": 214,
            "coastline": 0, "water": 9022, "other-relations": 31 }) } }]
    });
    const history = buildHistory(previous, HISTORY_RETAIN);
    expect(history.map((e) => e.buildId)).toEqual(["B-OLD", "B-PREV"]);
    const oldest = oldestRetained(history);
    expect(oldest.buildId).toBe("B-OLD");

    function verdictFor(parkCount) {
      const layers = layerSet({
        "parks-polygon.fgb": { featureCount: parkCount, bytes: 4000000 }
      });
      return evaluateGates({
        layers: layers,
        sidecarCounts: sidecarCountsOf(layers),
        regionCounts: regionCounts({ "Lake Michigan": { "beaches": 1487,
          "parks-polygon": parkCount, "parks-line": 214, "coastline": 0,
          "water": 9022, "other-relations": 31 } }),
        lakesWikidata: QIDS.slice(),
        floorsFile: floorsFile(DIGEST, { status: "seeded",
          layers: { "parks-polygon.fgb": 2340 } }),
        regionsDigest: DIGEST,
        previousManifest: previous,
        oldest: oldest,
        allowShrink: false
      });
    }

    const healthy = verdictFor(3118);
    expect(healthy.refusals).toEqual([]);
    expect(healthy.sanity.passed).toBe(true);
    expect(healthy.sanity.autoPublishAllowed).toBe(true);

    // A 9% parks regression: ~88 deletes under the old 0.25 rail, every gate
    // green under revision 1. Here it is refused BEFORE the delete rail is
    // reached, per layer AND per region.
    const bleeding = verdictFor(2839);
    const checks = bleeding.refusals.map((r) => r.check);
    expect(checks).toContain("shrink-ratio");
    expect(checks).toContain("region-shrink");
    expect(checks).toContain("region-floor");
    expect(bleeding.sanity.passed).toBe(false);
    expect(bleeding.sanity.autoPublishAllowed).toBe(false);
  });
});
