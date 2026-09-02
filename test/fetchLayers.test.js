// Tests for scripts/fetch-layers.js and scripts/print-spat-bbox.js — the two
// build/fetch-side Deno scripts of the FlatGeobuf layer pipeline. Both guard
// their entrypoint with import.meta.main (falsy under vitest/node), so importing
// their pure exports here is safe: no Deno access, no network, no file writes.
//
// print-spat-bbox.js has no test file of its own (work unit U8 owns exactly one)
// so its exports are exercised in the final describe block below.
//
// Every fixture is built IN MEMORY from readable primitives by one named helper
// per artifact — makePointerText, makeManifest, makeFloors — each carrying
// explicit MALFORMATION knobs rather than being hand-corrupted per test. That is
// the same discipline test/buildMarineZones.test.js uses and for the same
// reason: this pipeline's characteristic failure is a VALID-LOOKING artifact,
// and the assertions that matter are the exact refusal messages on the
// artifact-is-corrupt paths.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_LAYERS_BASE,
  DEFAULT_DEST,
  DEFAULT_FLOORS_PATH,
  POINTER_PATH,
  parseArgs,
  normalizeBase,
  joinPath,
  pointerUrl,
  prefixUrl,
  manifestUrl,
  layerUrl,
  parsePointer,
  planDownloads,
  verifyLayer,
  sha256Hex,
  parksReportInput,
  buildReport
} from "../scripts/fetch-layers.js";
import {
  REGION_SPAT_PAD_DEG,
  padBbox,
  paddedRegionBoxes,
  unionBbox,
  formatBbox,
  renderOutput,
  parseArgs as parseSpatArgs
} from "../scripts/print-spat-bbox.js";
import {
  EXPECTED_LAYER_KEYS,
  classificationAllowed,
  reconciliationAllowed,
  classifyManifestFailure,
  parksLayerHealthy
} from "../src/layerManifest.js";
import { REGIONS } from "../src/regions.js";

const BUILD_ID = "20260906T064102Z-a1b2c3d";
const PREFIX = "layers/" + BUILD_ID;
const DIGEST = "sha256:0123456789abcdef";

// A deterministic, well-formed 64-hex digest per layer key. The manifest's
// sha256 field is compared as a STRING by verifyLayer, so a synthetic digest
// exercises every path except the one real-digest test below.
function fakeSha(seed) {
  let out = "";
  for (let i = 0; out.length < 64; i = i + 1) {
    out = out + (seed.charCodeAt(i % seed.length) + i).toString(16);
  }
  return out.slice(0, 64);
}

// --- fixture builders -------------------------------------------------------------

// A complete, well-formed pointer, with knobs for each way one can go wrong.
// opts: { buildId, prefix, json (raw text override) }
function makePointerText(opts) {
  const o = opts || {};
  if (o.json !== undefined) { return o.json; }
  const pointer = {};
  if (o.buildId !== null) { pointer.buildId = o.buildId === undefined ? BUILD_ID : o.buildId; }
  if (o.prefix !== null) { pointer.prefix = o.prefix === undefined ? PREFIX : o.prefix; }
  return JSON.stringify(pointer);
}

// A complete, well-formed manifest describing all ten EXPECTED_LAYER_KEYS.
// opts:
//   buildId, regionsDigest, generated, oldestSourceTimestamp, buildStatus,
//   sourcesVerified, schemaVersion  — scalar overrides
//   counts   { key: featureCount }  — per-layer feature counts
//   omit     [key]                  — layers to leave undescribed
//   extra    [{ key, ... }]         — layers the code does not expect
//   corrupt  { key: { field: value } } — field-level malformation
//   duplicate key                   — describe one key twice
//   sanity   object | null          — replaces the sanity block wholesale
//   history  array | null           — replaces manifest.history wholesale
//   layers   any                    — replaces manifest.layers wholesale
function makeManifest(opts) {
  const o = opts || {};
  const counts = o.counts || {};
  const omit = o.omit || [];
  const corrupt = o.corrupt || {};
  const layers = [];
  for (let i = 0; i < EXPECTED_LAYER_KEYS.length; i = i + 1) {
    const key = EXPECTED_LAYER_KEYS[i];
    if (omit.indexOf(key) !== -1) { continue; }
    const layer = {
      key: key,
      featureCount: counts[key] === undefined ? 100 + i : counts[key],
      bytes: 1024 * (i + 1),
      sha256: fakeSha(key),
      fields: ["osm_id", "name"]
    };
    const patch = corrupt[key];
    if (patch !== undefined) {
      const names = Object.keys(patch);
      for (let n = 0; n < names.length; n = n + 1) {
        layer[names[n]] = patch[names[n]];
      }
    }
    layers.push(layer);
  }
  if (o.duplicate !== undefined) {
    layers.push({ key: o.duplicate, featureCount: 1, bytes: 1, sha256: fakeSha("dup") });
  }
  if (o.extra !== undefined) {
    for (let i = 0; i < o.extra.length; i = i + 1) { layers.push(o.extra[i]); }
  }
  const manifest = {
    schemaVersion: o.schemaVersion === undefined ? 1 : o.schemaVersion,
    buildId: o.buildId === undefined ? BUILD_ID : o.buildId,
    buildStatus: o.buildStatus === undefined ? "complete" : o.buildStatus,
    generated: o.generated === undefined ? "2026-09-06T06:41:02.000Z" : o.generated,
    attribution: "(c) OpenStreetMap contributors, ODbL 1.0",
    sourcesVerified: o.sourcesVerified === undefined ? true : o.sourcesVerified,
    oldestSourceTimestamp: o.oldestSourceTimestamp === undefined
      ? "2026-08-31T20:21:20Z" : o.oldestSourceTimestamp,
    regionsDigest: o.regionsDigest === undefined ? DIGEST : o.regionsDigest,
    layers: o.layers === undefined ? layers : o.layers,
    history: o.history === undefined
      ? [{ buildId: "older", generated: "2026-09-02T06:41:02.000Z",
           layers: { "parks-polygon.fgb": 3000, "parks-line.fgb": 200 } }]
      : o.history,
    sanity: o.sanity === undefined
      // The FULL sanity shape scripts/build-manifest.js writes. Modelling only a
      // subset here is what let decayPassed/integrityPassed/passed go unread by
      // buildReport for as long as they did — a partial fixture cannot fail a
      // conjunction it does not mention.
      ? { previousBuildId: "older", absoluteFloorsPassed: true, regionFloorsPassed: true,
          shrinkRatiosPassed: true, decayPassed: true, integrityPassed: true,
          growthWarnings: [], bootstrap: false, overridden: false, passed: true }
      : o.sanity
  };
  return manifest;
}

// data/layer-floors.json shaped. opts: { digest, polygonFloor, lineFloor, floors }
function makeFloors(opts) {
  const o = opts || {};
  const entry = {
    status: "seeded",
    layers: {
      "parks-polygon.fgb": o.polygonFloor === undefined ? 2000 : o.polygonFloor,
      "parks-line.fgb": o.lineFloor === undefined ? 150 : o.lineFloor
    }
  };
  const floors = {};
  floors[o.digest === undefined ? DIGEST : o.digest] = entry;
  return { schemaVersion: 1, floors: o.floors === undefined ? floors : o.floors };
}

// The report shape a HEALTHY fetch produces, assembled through the real
// buildReport rather than hand-written, so every assertion below is about the
// production path.
function healthyReport(manifestOpts, floorsOpts) {
  const manifest = makeManifest(manifestOpts);
  const plan = planDownloads(manifest);
  const downloaded = [];
  for (let i = 0; i < plan.entries.length; i = i + 1) {
    downloaded.push({
      key: plan.entries[i].key,
      bytes: plan.entries[i].bytes,
      sha256: plan.entries[i].sha256
    });
  }
  return buildReport({
    pointer: { buildId: manifest.buildId, prefix: PREFIX },
    manifest: manifest,
    base: DEFAULT_LAYERS_BASE,
    dest: "./.layers",
    fetchedAt: "2026-09-06T09:00:00.000Z",
    downloaded: downloaded,
    problems: plan.problems,
    floorsDoc: floorsOpts === null ? null : makeFloors(floorsOpts)
  });
}

// --- parseArgs ---------------------------------------------------------------------

describe("parseArgs", function () {
  it("defaults dest, base and floors", function () {
    const args = parseArgs([]);
    expect(args.dest).toBe(DEFAULT_DEST);
    expect(args.base).toBe(DEFAULT_LAYERS_BASE);
    expect(args.floors).toBe(DEFAULT_FLOORS_PATH);
  });

  it("reads --dest, --base and --floors", function () {
    const args = parseArgs(["--dest", "/tmp/layers", "--base", "https://example.test",
      "--floors", "data/other.json"]);
    expect(args.dest).toBe("/tmp/layers");
    expect(args.base).toBe("https://example.test");
    expect(args.floors).toBe("data/other.json");
  });

  it("throws on an unknown argument", function () {
    expect(function () { parseArgs(["--layers", "x"]); })
      .toThrow("unknown argument: --layers");
  });

  it("throws when --dest is given no value", function () {
    expect(function () { parseArgs(["--dest"]); })
      .toThrow("fetch-layers: --dest requires a path");
  });
});

// --- URL assembly: every download derives from ONE pinned prefix --------------------

describe("URL assembly", function () {
  it("normalizes trailing slashes on the base", function () {
    expect(normalizeBase("https://map.swim.report/")).toBe("https://map.swim.report");
    expect(normalizeBase("https://map.swim.report///")).toBe("https://map.swim.report");
    expect(normalizeBase("https://map.swim.report")).toBe("https://map.swim.report");
  });

  it("joins destination paths without doubling the separator", function () {
    expect(joinPath("./.layers", "report.json")).toBe("./.layers/report.json");
    expect(joinPath("./.layers/", "report.json")).toBe("./.layers/report.json");
  });

  it("cache-busts the pointer and only the pointer", function () {
    expect(pointerUrl("https://map.swim.report", "12345"))
      .toBe("https://map.swim.report/" + POINTER_PATH + "?cb=12345");
    expect(manifestUrl("https://map.swim.report", PREFIX).indexOf("?")).toBe(-1);
    expect(layerUrl("https://map.swim.report", PREFIX, "beaches-point.fgb").indexOf("?")).toBe(-1);
  });

  it("derives the manifest and ALL TEN layer URLs from the one pinned prefix", function () {
    const base = "https://map.swim.report";
    const expectedRoot = base + "/" + PREFIX + "/";
    expect(manifestUrl(base, PREFIX)).toBe(expectedRoot + "manifest.json");
    const seen = [];
    for (let i = 0; i < EXPECTED_LAYER_KEYS.length; i = i + 1) {
      const url = layerUrl(base, PREFIX, EXPECTED_LAYER_KEYS[i]);
      expect(url).toBe(expectedRoot + EXPECTED_LAYER_KEYS[i]);
      seen.push(url);
    }
    expect(seen.length).toBe(10);
    expect(prefixUrl(base, PREFIX, "anything")).toBe(expectedRoot + "anything");
  });
});

// --- parsePointer -------------------------------------------------------------------

describe("parsePointer", function () {
  it("parses a well-formed pointer", function () {
    const pointer = parsePointer(makePointerText());
    expect(pointer.buildId).toBe(BUILD_ID);
    expect(pointer.prefix).toBe(PREFIX);
  });

  it("throws when the pointer is not valid JSON", function () {
    expect(function () { parsePointer("{not json"); })
      .toThrow("fetch-layers: pointer is not valid JSON");
  });

  it("throws when the pointer is not an object", function () {
    expect(function () { parsePointer("[1,2,3]"); })
      .toThrow("fetch-layers: pointer is not an object");
  });

  it("throws when buildId is missing", function () {
    expect(function () { parsePointer(makePointerText({ buildId: null })); })
      .toThrow("fetch-layers: pointer buildId is missing or malformed");
  });

  it("throws when buildId carries a path separator", function () {
    expect(function () { parsePointer(makePointerText({ buildId: "../../etc" })); })
      .toThrow("fetch-layers: pointer buildId is missing or malformed");
  });

  it("throws when prefix is missing", function () {
    expect(function () { parsePointer(makePointerText({ prefix: null })); })
      .toThrow("fetch-layers: pointer prefix is missing or malformed");
  });

  it("refuses an absolute-URL prefix", function () {
    expect(function () {
      parsePointer(makePointerText({ prefix: "https://evil.test/" + BUILD_ID }));
    }).toThrow("fetch-layers: pointer prefix is not a plain relative path");
  });

  it("refuses a rooted prefix", function () {
    expect(function () { parsePointer(makePointerText({ prefix: "/" + PREFIX })); })
      .toThrow("fetch-layers: pointer prefix is not a plain relative path");
  });

  it("refuses parent traversal in the prefix", function () {
    expect(function () {
      parsePointer(makePointerText({ prefix: "layers/../" + BUILD_ID }));
    }).toThrow("fetch-layers: pointer prefix is not a plain relative path");
  });

  it("refuses a prefix that does not contain the buildId it claims", function () {
    expect(function () {
      parsePointer(makePointerText({ prefix: "layers/20200101T000000Z-deadbee" }));
    }).toThrow("does not contain buildId " + BUILD_ID);
  });
});

// --- planDownloads: expected-key checking --------------------------------------------

describe("planDownloads", function () {
  it("plans all ten expected layers, in EXPECTED_LAYER_KEYS order, with no problems", function () {
    const plan = planDownloads(makeManifest());
    expect(plan.problems).toEqual([]);
    expect(plan.entries.length).toBe(10);
    const keys = plan.entries.map(function (e) { return e.key; });
    expect(keys).toEqual(EXPECTED_LAYER_KEYS);
  });

  it("carries bytes, sha256 and featureCount forward for each entry", function () {
    const plan = planDownloads(makeManifest({ counts: { "parks-line.fgb": 214 } }));
    const parksLine = plan.entries.filter(function (e) { return e.key === "parks-line.fgb"; })[0];
    expect(parksLine.featureCount).toBe(214);
    expect(parksLine.sha256).toBe(fakeSha("parks-line.fgb"));
    expect(parksLine.bytes > 0).toBe(true);
  });

  it("reports a layer the manifest does not describe", function () {
    const plan = planDownloads(makeManifest({ omit: ["water-line.fgb"] }));
    expect(plan.entries.length).toBe(9);
    expect(plan.problems).toContain("manifest does not describe water-line.fgb");
  });

  it("reports a layer the code does not expect", function () {
    const plan = planDownloads(makeManifest({
      extra: [{ key: "coastline-polygon.fgb", featureCount: 5, bytes: 10, sha256: fakeSha("x") }]
    }));
    expect(plan.problems).toContain("manifest describes unexpected layer coastline-polygon.fgb");
  });

  it("reports a duplicated layer key", function () {
    const plan = planDownloads(makeManifest({ duplicate: "lakes-polygon.fgb" }));
    expect(plan.problems).toContain("manifest describes lakes-polygon.fgb twice");
  });

  it("refuses a layer whose sha256 is not a lowercase 64-hex digest", function () {
    const plan = planDownloads(makeManifest({ corrupt: { "lakes-polygon.fgb": { sha256: "ABC" } } }));
    expect(plan.entries.length).toBe(9);
    expect(plan.problems)
      .toContain("lakes-polygon.fgb: manifest sha256 is not a lowercase 64-hex digest");
  });

  it("refuses a layer whose bytes field is not a byte count", function () {
    const plan = planDownloads(makeManifest({ corrupt: { "beaches-point.fgb": { bytes: "9437184" } } }));
    expect(plan.problems).toContain("beaches-point.fgb: manifest bytes is not a byte count");
  });

  it("reports a layer entry with no key at all", function () {
    const manifest = makeManifest();
    manifest.layers.push({ featureCount: 1, bytes: 1, sha256: fakeSha("y") });
    const plan = planDownloads(manifest);
    expect(plan.problems).toContain("manifest.layers[10] has no key");
  });

  it("refuses a manifest that is not an object", function () {
    expect(planDownloads(null).problems).toEqual(["manifest is not an object"]);
    expect(planDownloads([]).problems).toEqual(["manifest is not an object"]);
  });

  it("refuses a manifest whose layers field is not an array", function () {
    const plan = planDownloads(makeManifest({ layers: { "beaches-point.fgb": 1 } }));
    expect(plan.problems).toEqual(["manifest.layers is not an array"]);
    expect(plan.entries).toEqual([]);
  });
});

// --- verifyLayer ---------------------------------------------------------------------

describe("verifyLayer", function () {
  const entry = { key: "water-polygon.fgb", bytes: 2048, sha256: fakeSha("water-polygon.fgb") };

  it("returns null when length and digest both match", function () {
    expect(verifyLayer(entry, { bytes: 2048, sha256: entry.sha256 })).toBe(null);
  });

  it("accepts an uppercase observed digest", function () {
    expect(verifyLayer(entry, { bytes: 2048, sha256: entry.sha256.toUpperCase() })).toBe(null);
  });

  it("names a truncated transfer by its byte counts", function () {
    expect(verifyLayer(entry, { bytes: 1024, sha256: entry.sha256 }))
      .toBe("water-polygon.fgb: expected 2048 bytes, got 1024");
  });

  it("names a digest mismatch with both digests", function () {
    const wrong = fakeSha("other");
    expect(verifyLayer(entry, { bytes: 2048, sha256: wrong }))
      .toBe("water-polygon.fgb: sha256 mismatch (expected " + entry.sha256 + ", got " + wrong + ")");
  });

  it("refuses when nothing was downloaded at all", function () {
    expect(verifyLayer(entry, null)).toBe("water-polygon.fgb: nothing downloaded");
  });
});

describe("sha256Hex", function () {
  it("matches the published SHA-256 vector for \"abc\"", async function () {
    const digest = await sha256Hex(new TextEncoder().encode("abc"));
    expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("emits a lowercase 64-hex string with leading zeros preserved", async function () {
    const digest = await sha256Hex(new Uint8Array(0));
    expect(digest)
      .toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(/^[0-9a-f]{64}$/.test(digest)).toBe(true);
  });
});

// --- parksLayerHealthy input assembly --------------------------------------------------

describe("parksReportInput", function () {
  it("assembles all six numbers from the manifest, its history and the floors file", function () {
    const manifest = makeManifest({
      counts: { "parks-polygon.fgb": 3120, "parks-line.fgb": 214 }
    });
    const parks = parksReportInput(manifest, makeFloors({ polygonFloor: 2000, lineFloor: 150 }));
    expect(parks).toEqual({
      polygonCount: 3120,
      lineCount: 214,
      polygonFloor: 2000,
      lineFloor: 150,
      previousPolygonCount: 3000,
      previousLineCount: 200
    });
  });

  it("reads the PREVIOUS build from the newest (last) history entry", function () {
    const manifest = makeManifest({
      history: [
        { buildId: "oldest", layers: { "parks-polygon.fgb": 1, "parks-line.fgb": 2 } },
        { buildId: "newest", layers: { "parks-polygon.fgb": 3120, "parks-line.fgb": 214 } }
      ]
    });
    const parks = parksReportInput(manifest, makeFloors());
    expect(parks.previousPolygonCount).toBe(3120);
    expect(parks.previousLineCount).toBe(214);
  });

  it("preserves null rather than substituting zero for an unseeded floor", function () {
    const manifest = makeManifest();
    const parks = parksReportInput(manifest, makeFloors({ polygonFloor: null, lineFloor: null }));
    expect(parks.polygonFloor).toBe(null);
    expect(parks.lineFloor).toBe(null);
  });

  it("returns null floors when the manifest's regionsDigest has no floors entry", function () {
    const manifest = makeManifest({ regionsDigest: "sha256:a-brand-new-footprint" });
    const parks = parksReportInput(manifest, makeFloors());
    expect(parks.polygonFloor).toBe(null);
    expect(parks.lineFloor).toBe(null);
  });

  it("returns null counts when the manifest describes no parks layers", function () {
    const manifest = makeManifest({ omit: ["parks-polygon.fgb", "parks-line.fgb"] });
    const parks = parksReportInput(manifest, makeFloors());
    expect(parks.polygonCount).toBe(null);
    expect(parks.lineCount).toBe(null);
  });

  it("returns all nulls for a missing manifest and a missing floors file", function () {
    expect(parksReportInput(null, null)).toEqual({
      polygonCount: null,
      lineCount: null,
      polygonFloor: null,
      lineFloor: null,
      previousPolygonCount: null,
      previousLineCount: null
    });
  });

  it("feeds parksLayerHealthy true for a healthy set and false for a bootstrap one", function () {
    const healthy = healthyReport({
      counts: { "parks-polygon.fgb": 3120, "parks-line.fgb": 214 }
    });
    expect(parksLayerHealthy(healthy)).toBe(true);

    // Build 1: no history, floors seeded as null. hasPark must be FALSE, which
    // makes upsertSql emit the five-column variant and leaves park_name alone.
    const bootstrap = healthyReport({ history: [] }, { polygonFloor: null, lineFloor: null });
    expect(bootstrap.parks.previousPolygonCount).toBe(null);
    expect(parksLayerHealthy(bootstrap)).toBe(false);
  });

  it("feeds parksLayerHealthy false when parks-polygon shrinks past 0.98x the previous build", function () {
    // 3000 previous, 0.98x = 2940. 2939 must refuse; 2940 must pass.
    const shrunk = healthyReport({ counts: { "parks-polygon.fgb": 2939, "parks-line.fgb": 214 } });
    expect(parksLayerHealthy(shrunk)).toBe(false);
    const edge = healthyReport({ counts: { "parks-polygon.fgb": 2940, "parks-line.fgb": 214 } });
    expect(parksLayerHealthy(edge)).toBe(true);
  });

  it("feeds parksLayerHealthy false when parks-line is empty", function () {
    const empty = healthyReport({ counts: { "parks-polygon.fgb": 3120, "parks-line.fgb": 0 } });
    expect(parksLayerHealthy(empty)).toBe(false);
  });
});

// --- buildReport ------------------------------------------------------------------------

describe("buildReport", function () {
  it("carries all ten EXPECTED_LAYER_KEYS and a complete/complete layer count", function () {
    const report = healthyReport();
    expect(report.layerKeys).toEqual(EXPECTED_LAYER_KEYS);
    expect(report.layersPresent).toBe(10);
    expect(report.layersExpected).toBe(10);
    expect(report.layersVerified).toBe(true);
    expect(report.pointerAgreesWithManifest).toBe(true);
    expect(report.buildSanityPassed).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it("copies the build's own verdicts through verbatim rather than normalizing them", function () {
    const report = healthyReport({ buildStatus: "COMPLETE", sourcesVerified: "yes", schemaVersion: "1" });
    expect(report.buildStatus).toBe("COMPLETE");
    expect(report.sourcesVerified).toBe("yes");
    expect(report.schemaVersion).toBe("1");
    // ...and the gate refuses every one of them, because near-enough is not proof.
    expect(classifyManifestFailure(report).tier).toBe("fatal");
  });

  it("carries the provenance discovery-batch.js needs to finish the report", function () {
    const report = healthyReport();
    expect(report.buildId).toBe(BUILD_ID);
    expect(report.prefix).toBe(PREFIX);
    expect(report.regionsDigest).toBe(DIGEST);
    expect(report.oldestSourceTimestamp).toBe("2026-08-31T20:21:20Z");
    expect(report.attribution).toBe("(c) OpenStreetMap contributors, ODbL 1.0");
  });

  it("omits regionsDigestMatches and sourceAgeDays, which discovery-batch.js owns", function () {
    const report = healthyReport();
    expect(Object.prototype.hasOwnProperty.call(report, "regionsDigestMatches")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(report, "sourceAgeDays")).toBe(false);
    // Fail-CLOSED: the fetch-stage report is complete enough to CLASSIFY from but
    // never enough to DELETE from. Deletes arm only once the batch folds the two
    // conjuncts it owns into this same object.
    expect(classificationAllowed(report)).toBe(true);
    expect(reconciliationAllowed(report)).toBe(false);
    expect(classifyManifestFailure(report).tier).toBe("scope_or_stale");
    report.regionsDigestMatches = true;
    report.sourceAgeDays = 6;
    expect(reconciliationAllowed(report)).toBe(true);
    expect(classifyManifestFailure(report).tier).toBe("ok");
  });

  it("goes FATAL when the pointer and the manifest name different builds", function () {
    const manifest = makeManifest({ buildId: "20260909T000000Z-9999999" });
    const plan = planDownloads(manifest);
    const report = buildReport({
      pointer: { buildId: BUILD_ID, prefix: PREFIX },
      manifest: manifest,
      downloaded: plan.entries.map(function (e) {
        return { key: e.key, bytes: e.bytes, sha256: e.sha256 };
      }),
      problems: plan.problems,
      floorsDoc: makeFloors()
    });
    expect(report.pointerAgreesWithManifest).toBe(false);
    expect(classifyManifestFailure(report).tier).toBe("fatal");
  });

  it("goes FATAL when a layer failed verification and was not written", function () {
    const manifest = makeManifest();
    const plan = planDownloads(manifest);
    const kept = [];
    for (let i = 1; i < plan.entries.length; i = i + 1) {
      kept.push({ key: plan.entries[i].key, bytes: plan.entries[i].bytes,
        sha256: plan.entries[i].sha256 });
    }
    const report = buildReport({
      pointer: { buildId: BUILD_ID, prefix: PREFIX },
      manifest: manifest,
      downloaded: kept,
      problems: ["beaches-point.fgb: sha256 mismatch (expected a, got b)"],
      floorsDoc: makeFloors()
    });
    expect(report.layersVerified).toBe(false);
    expect(report.layersPresent).toBe(9);
    expect(report.layerKeys.indexOf("beaches-point.fgb")).toBe(-1);
    expect(classifyManifestFailure(report).tier).toBe("fatal");
  });

  // Each of these was computed by build-manifest.js and silently ignored by
  // buildReport until the conjunction was completed.
  it("goes INCOMPLETE when the monotone-decay gate refused", function () {
    const report = healthyReport({
      sanity: { absoluteFloorsPassed: true, regionFloorsPassed: true, shrinkRatiosPassed: true,
        decayPassed: false, integrityPassed: true, overridden: false, passed: false }
    });
    expect(report.buildSanityPassed).toBe(false);
    expect(classifyManifestFailure(report).tier).toBe("incomplete");
  });

  it("goes INCOMPLETE when the integrity gate refused", function () {
    const report = healthyReport({
      sanity: { absoluteFloorsPassed: true, regionFloorsPassed: true, shrinkRatiosPassed: true,
        decayPassed: true, integrityPassed: false, overridden: false, passed: false }
    });
    expect(report.buildSanityPassed).toBe(false);
    expect(classifyManifestFailure(report).tier).toBe("incomplete");
  });

  // The subtle one. allow_shrink moves a gate's refusals into warnings, and
  // countUnrefused() then reports that gate as PASSED — so every individual flag
  // reads true and only the overridden flag still records that a human bypassed a
  // refusal. Without this the delete gate cannot tell an overridden build from a
  // clean one.
  it("goes INCOMPLETE when a human overrode a refusal, even though every gate flag reads true", function () {
    const report = healthyReport({
      sanity: { absoluteFloorsPassed: true, regionFloorsPassed: true, shrinkRatiosPassed: true,
        decayPassed: true, integrityPassed: true, overridden: true, passed: true }
    });
    expect(report.buildSanityPassed).toBe(false);
    expect(classifyManifestFailure(report).tier).toBe("incomplete");
  });

  it("goes INCOMPLETE, not fatal, when the build's own sanity block did not pass", function () {
    const report = healthyReport({
      sanity: { absoluteFloorsPassed: true, regionFloorsPassed: false, shrinkRatiosPassed: true,
        decayPassed: true, integrityPassed: true, overridden: false, passed: false }
    });
    expect(report.buildSanityPassed).toBe(false);
    expect(report.layersVerified).toBe(true);
    expect(classifyManifestFailure(report).tier).toBe("incomplete");
    expect(classificationAllowed(report)).toBe(false);
  });

  it("goes INCOMPLETE when the sanity block is missing entirely", function () {
    const report = healthyReport({ sanity: null });
    expect(report.buildSanityPassed).toBe(false);
    expect(classifyManifestFailure(report).tier).toBe("incomplete");
  });

  it("goes FATAL with a null manifest, and never throws building the report", function () {
    const report = buildReport({
      pointer: { buildId: BUILD_ID, prefix: PREFIX },
      manifest: null,
      downloaded: [],
      problems: ["manifest is not an object"],
      floorsDoc: null
    });
    expect(report.schemaVersion).toBe(null);
    expect(report.layersPresent).toBe(0);
    expect(report.layersVerified).toBe(false);
    expect(report.parks.polygonCount).toBe(null);
    expect(classifyManifestFailure(report).tier).toBe("fatal");
  });

  it("survives an entirely empty input object", function () {
    const report = buildReport({});
    expect(report.layersPresent).toBe(0);
    expect(report.layersExpected).toBe(10);
    expect(report.layerKeys).toEqual([]);
    expect(report.pointerAgreesWithManifest).toBe(false);
    expect(classifyManifestFailure(report).tier).toBe("fatal");
  });

  it("serializes to JSON exactly as it is written to report.json", function () {
    const report = healthyReport();
    const round = JSON.parse(JSON.stringify(report));
    expect(round).toEqual(report);
  });
});

// --- print-spat-bbox.js -------------------------------------------------------------------

describe("print-spat-bbox", function () {
  it("pins the pad at 0.05 degrees", function () {
    expect(REGION_SPAT_PAD_DEG).toBe(0.05);
  });

  it("pads every edge outward and prints without float noise", function () {
    const padded = padBbox({ minLon: -88.3, minLat: 41.5, maxLon: -84.5, maxLat: 46.2 }, 0.05);
    expect(padded).toEqual({ minLon: -88.35, minLat: 41.45, maxLon: -84.45, maxLat: 46.25 });
    expect(formatBbox(padded)).toBe("-88.35 41.45 -84.45 46.25");
  });

  it("clamps the padded box to the valid WGS84 domain", function () {
    const padded = padBbox({ minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 }, 0.05);
    expect(padded).toEqual({ minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 });
  });

  it("throws on a malformed bbox rather than emitting a silently wrong mask", function () {
    expect(function () { padBbox(null, 0.05); })
      .toThrow("print-spat-bbox: bbox is not an object");
    expect(function () { padBbox({ minLon: -88, minLat: 41, maxLon: -84 }, 0.05); })
      .toThrow("print-spat-bbox: bbox.maxLat is not a finite number");
    expect(function () { padBbox({ minLon: "-88", minLat: 41, maxLon: -84, maxLat: 46 }, 0.05); })
      .toThrow("print-spat-bbox: bbox.minLon is not a finite number");
  });

  it("returns one named padded box per REGIONS entry, in REGIONS order", function () {
    const boxes = paddedRegionBoxes(REGIONS, REGION_SPAT_PAD_DEG);
    expect(boxes.length).toBe(REGIONS.length);
    for (let i = 0; i < REGIONS.length; i = i + 1) {
      expect(boxes[i].name).toBe(REGIONS[i].name);
      expect(boxes[i].bbox.minLon < REGIONS[i].bbox.minLon).toBe(true);
      expect(boxes[i].bbox.maxLat > REGIONS[i].bbox.maxLat).toBe(true);
    }
  });

  it("throws on a malformed region rather than silently dropping a whole lake", function () {
    expect(function () { paddedRegionBoxes([], 0.05); })
      .toThrow("print-spat-bbox: expected a non-empty regions array");
    expect(function () { paddedRegionBoxes([{ bbox: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 } }], 0.05); })
      .toThrow("print-spat-bbox: region 0 has no name");
    expect(function () { paddedRegionBoxes([null], 0.05); })
      .toThrow("print-spat-bbox: region 0 is not an object");
  });

  it("prints four space-separated numbers for the padded REGIONS union by default", function () {
    const out = renderOutput(REGIONS, "union");
    const parts = out.split(" ");
    expect(parts.length).toBe(4);
    for (let i = 0; i < parts.length; i = i + 1) {
      expect(Number.isFinite(Number(parts[i]))).toBe(true);
    }
    expect(out).toBe(formatBbox(unionBbox(paddedRegionBoxes(REGIONS, REGION_SPAT_PAD_DEG))));
  });

  it("prints one padded box per REGIONS entry under --boxes", function () {
    const lines = renderOutput(REGIONS, "boxes").split("\n");
    expect(lines.length).toBe(REGIONS.length);
    const boxes = paddedRegionBoxes(REGIONS, REGION_SPAT_PAD_DEG);
    for (let i = 0; i < lines.length; i = i + 1) {
      expect(lines[i].split(" ").length).toBe(4);
      expect(lines[i]).toBe(formatBbox(boxes[i].bbox));
    }
  });

  it("keeps the union a strict SUPERSET of every per-region box", function () {
    const boxes = paddedRegionBoxes(REGIONS, REGION_SPAT_PAD_DEG);
    const union = unionBbox(boxes);
    for (let i = 0; i < boxes.length; i = i + 1) {
      const b = boxes[i].bbox;
      expect(b.minLon >= union.minLon).toBe(true);
      expect(b.minLat >= union.minLat).toBe(true);
      expect(b.maxLon <= union.maxLon).toBe(true);
      expect(b.maxLat <= union.maxLat).toBe(true);
    }
  });

  it("proves the union rectangle is NOT the discovery universe (D18/B2)", function () {
    // Wisconsin interior: inside the union rectangle, inside no region box. If
    // the union were ever treated as the scope, every inland lake here would be
    // upserted and then be permanently un-deletable, because reconciliation
    // scopes its delete candidates with pointInAnyRegion.
    const interiorLon = -90;
    const interiorLat = 44;
    const boxes = paddedRegionBoxes(REGIONS, REGION_SPAT_PAD_DEG);
    const union = unionBbox(boxes);
    expect(interiorLon >= union.minLon && interiorLon <= union.maxLon).toBe(true);
    expect(interiorLat >= union.minLat && interiorLat <= union.maxLat).toBe(true);
    let insideAnyBox = false;
    for (let i = 0; i < boxes.length; i = i + 1) {
      const b = boxes[i].bbox;
      if (interiorLon >= b.minLon && interiorLon <= b.maxLon &&
          interiorLat >= b.minLat && interiorLat <= b.maxLat) {
        insideAnyBox = true;
      }
    }
    expect(insideAnyBox).toBe(false);
  });

  it("parses --boxes and refuses anything else", function () {
    expect(parseSpatArgs([]).mode).toBe("union");
    expect(parseSpatArgs(["--boxes"]).mode).toBe("boxes");
    expect(function () { parseSpatArgs(["--union"]); }).toThrow("unknown argument: --union");
  });
});

// --- one composed pipeline test -------------------------------------------------------------

describe("end-to-end: pointer -> manifest -> verified downloads -> report", function () {
  it("verifies real digests over synthetic layer bytes and produces a classifiable report", async function () {
    // Synthetic layer payloads with REAL sha256 digests, so the whole chain —
    // plan, digest, length, verdict, report — runs exactly as it does in
    // production, minus the network.
    const payloads = new Map();
    const counts = {};
    const corrupt = {};
    for (let i = 0; i < EXPECTED_LAYER_KEYS.length; i = i + 1) {
      const key = EXPECTED_LAYER_KEYS[i];
      const bytes = new TextEncoder().encode(key + " payload " + String(i));
      payloads.set(key, bytes);
      counts[key] = 500 + i;
      corrupt[key] = { bytes: bytes.length, sha256: await sha256Hex(bytes) };
    }
    counts["parks-polygon.fgb"] = 3120;
    counts["parks-line.fgb"] = 214;

    const manifest = makeManifest({ counts: counts, corrupt: corrupt });
    const pointer = parsePointer(makePointerText());
    const plan = planDownloads(manifest);
    expect(plan.problems).toEqual([]);

    const downloaded = [];
    const problems = [];
    for (let i = 0; i < plan.entries.length; i = i + 1) {
      const entry = plan.entries[i];
      const bytes = payloads.get(entry.key);
      const observed = { bytes: bytes.length, sha256: await sha256Hex(bytes) };
      const problem = verifyLayer(entry, observed);
      if (problem !== null) { problems.push(problem); continue; }
      downloaded.push({ key: entry.key, bytes: observed.bytes, sha256: observed.sha256 });
    }
    expect(problems).toEqual([]);
    expect(downloaded.length).toBe(10);

    const report = buildReport({
      pointer: pointer,
      manifest: manifest,
      base: DEFAULT_LAYERS_BASE,
      dest: "./.layers",
      fetchedAt: "2026-09-06T09:00:00.000Z",
      downloaded: downloaded,
      problems: problems,
      floorsDoc: makeFloors({ polygonFloor: 2000, lineFloor: 150 })
    });

    expect(report.layerKeys).toEqual(EXPECTED_LAYER_KEYS);
    expect(report.layersVerified).toBe(true);
    expect(parksLayerHealthy(report)).toBe(true);
    expect(classificationAllowed(report)).toBe(true);
    expect(classifyManifestFailure(report).tier).toBe("scope_or_stale");

    // The batch folds in the two conjuncts it owns; only then do deletes arm.
    report.regionsDigestMatches = true;
    report.sourceAgeDays = 6;
    expect(reconciliationAllowed(report)).toBe(true);

    // Flip one byte of one layer and the whole set refuses, fatally.
    const tampered = new TextEncoder().encode("tampered");
    const tamperedObserved = { bytes: tampered.length, sha256: await sha256Hex(tampered) };
    const refusal = verifyLayer(plan.entries[0], tamperedObserved);
    expect(refusal === null).toBe(false);
    const refused = buildReport({
      pointer: pointer,
      manifest: manifest,
      downloaded: downloaded.slice(1),
      problems: [refusal],
      floorsDoc: makeFloors()
    });
    expect(refused.layersVerified).toBe(false);
    expect(classifyManifestFailure(refused).tier).toBe("fatal");
  });
});
