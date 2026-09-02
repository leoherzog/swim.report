// Tests for src/layerManifest.js — the DELETE-PATH GATE.
//
// This is a pure src/ module: no entrypoint, no import.meta.main guard needed, no
// fetch, no Date, no filesystem. Its only import is src/regions.js (read-only),
// so importing it here touches nothing. Every fixture below is built in memory by
// one named helper with explicit MALFORMATION knobs.
//
// The bias of this file is deliberate: the REFUSAL paths get more coverage than
// the accept paths. A gate that wrongly returns false costs one skipped
// reconciliation pass, retried on the next daily run. A gate that wrongly returns
// true mass-deletes live, enriched production rows.

import { describe, it, expect } from "vitest";
import {
  LAYER_SCHEMA_VERSION,
  MAX_SOURCE_AGE_DAYS,
  PARKS_PREVIOUS_MIN_RATIO,
  EXPECTED_LAYER_KEYS,
  classificationAllowed,
  reconciliationAllowed,
  classifyManifestFailure,
  parksLayerHealthy,
  regionsDigestInput
} from "../src/layerManifest.js";
import { REGIONS } from "../src/regions.js";

// --- fixtures -------------------------------------------------------------------

// A fully-proven report: every conjunct satisfied, the only shape for which
// reconciliationAllowed may return true. Overrides are applied on top; passing
// undefined explicitly is how a test DELETES a field (the "missing field" case,
// which is the realistic failure now that three separate scripts assemble this
// object between them).
function makeReport(overrides) {
  const report = {
    schemaVersion: LAYER_SCHEMA_VERSION,
    buildStatus: "complete",
    sourcesVerified: true,
    buildSanityPassed: true,
    pointerAgreesWithManifest: true,
    layersVerified: true,
    layersPresent: EXPECTED_LAYER_KEYS.length,
    layersExpected: EXPECTED_LAYER_KEYS.length,
    regionsDigestMatches: true,
    sourceAgeDays: 3.5,
    parks: makeParks(null)
  };
  if (overrides) {
    const keys = Object.keys(overrides);
    for (let i = 0; i < keys.length; i = i + 1) {
      report[keys[i]] = overrides[keys[i]];
    }
  }
  return report;
}

// A healthy parks block: both layers well clear of their seeded floors and of
// 0.98x the previous build.
function makeParks(overrides) {
  const parks = {
    polygonCount: 3120,
    lineCount: 214,
    polygonFloor: 2800,
    lineFloor: 180,
    previousPolygonCount: 3140,
    previousLineCount: 216
  };
  if (overrides) {
    const keys = Object.keys(overrides);
    for (let i = 0; i < keys.length; i = i + 1) {
      parks[keys[i]] = overrides[keys[i]];
    }
  }
  return parks;
}

// Every value that is NOT proof, for the strictness sweep. The Overpass-era gate
// carried this same list for the same reason: a truthy-but-not-true value must
// never slip a DELETE through.
const NON_TRUE_VALUES = [null, undefined, false, 0, 1, "true", "", [], {}, NaN];

// --- constants -------------------------------------------------------------------

describe("layer manifest constants", function () {
  it("pins the schema version and the source-age horizon", function () {
    expect(LAYER_SCHEMA_VERSION).toBe(1);
    // 21, not 14: GitHub SKIPS scheduled occurrences rather than deferring them,
    // and against a twice-weekly build 21 days is three missed slots.
    expect(MAX_SOURCE_AGE_DAYS).toBe(21);
    expect(PARKS_PREVIOUS_MIN_RATIO).toBe(0.98);
  });

  it("expects exactly the ten published layer keys, with no duplicates", function () {
    expect(EXPECTED_LAYER_KEYS.length).toBe(10);
    expect(EXPECTED_LAYER_KEYS).toEqual([
      "beaches-point.fgb",
      "beaches-line.fgb",
      "beaches-polygon.fgb",
      "parks-polygon.fgb",
      "parks-line.fgb",
      "coastline-line.fgb",
      "water-line.fgb",
      "water-polygon.fgb",
      "lakes-polygon.fgb",
      "other-relations.fgb"
    ]);
    const unique = [];
    for (let i = 0; i < EXPECTED_LAYER_KEYS.length; i = i + 1) {
      if (unique.indexOf(EXPECTED_LAYER_KEYS[i]) === -1) {
        unique.push(EXPECTED_LAYER_KEYS[i]);
      }
    }
    expect(unique.length).toBe(10);
    // coastline-polygon.fgb is deliberately NOT published: the lines pass already
    // carries every coastline way, and publishing both double-counted islands.
    expect(EXPECTED_LAYER_KEYS.indexOf("coastline-polygon.fgb")).toBe(-1);
  });
});

// --- reconciliationAllowed: the accept path ---------------------------------------

describe("reconciliationAllowed accepts only a fully-proven report", function () {
  it("allows reconciliation for a complete, verified, in-scope, fresh set", function () {
    expect(reconciliationAllowed(makeReport(null))).toBe(true);
  });

  it("allows the boundary ages 0 and MAX_SOURCE_AGE_DAYS exactly", function () {
    expect(reconciliationAllowed(makeReport({ sourceAgeDays: 0 }))).toBe(true);
    expect(reconciliationAllowed(makeReport({ sourceAgeDays: MAX_SOURCE_AGE_DAYS }))).toBe(true);
  });

  it("ignores extra manifest fields it does not know about", function () {
    const report = makeReport({ buildId: "20260906T064102Z-a1b2c3d", growthWarnings: ["water"] });
    expect(reconciliationAllowed(report)).toBe(true);
  });
});

// --- reconciliationAllowed: the refusal paths ------------------------------------

describe("reconciliationAllowed refuses every unproven report", function () {
  it("refuses null, undefined and malformed input without throwing", function () {
    expect(reconciliationAllowed(null)).toBe(false);
    expect(reconciliationAllowed(undefined)).toBe(false);
    expect(reconciliationAllowed("complete")).toBe(false);
    expect(reconciliationAllowed(1)).toBe(false);
    expect(reconciliationAllowed(true)).toBe(false);
    expect(reconciliationAllowed([])).toBe(false);
    // An empty object is the shape a report gets when JSON.parse succeeded on a
    // truncated or wrong file: every conjunct is MISSING, none is false.
    expect(reconciliationAllowed({})).toBe(false);
  });

  it("refuses when ANY single boolean conjunct is missing", function () {
    const conjuncts = ["schemaVersion", "buildStatus", "sourcesVerified", "buildSanityPassed",
      "pointerAgreesWithManifest", "layersVerified", "layersPresent", "layersExpected",
      "regionsDigestMatches", "sourceAgeDays"];
    for (let i = 0; i < conjuncts.length; i = i + 1) {
      const overrides = {};
      overrides[conjuncts[i]] = undefined;
      expect(reconciliationAllowed(makeReport(overrides))).toBe(false);
    }
  });

  it("is strict about the boolean true — any non-true value refuses", function () {
    // Ported verbatim in spirit from the Overpass-era strictness case. The
    // failure mode is MORE likely now, not less: this report is assembled by
    // three separate scripts, so a JSON string "true" or a 1 from a shell
    // pipeline is a realistic way for an unproven set to look proven.
    const booleans = ["sourcesVerified", "buildSanityPassed", "pointerAgreesWithManifest",
      "layersVerified", "regionsDigestMatches"];
    for (let b = 0; b < booleans.length; b = b + 1) {
      for (let v = 0; v < NON_TRUE_VALUES.length; v = v + 1) {
        const overrides = {};
        overrides[booleans[b]] = NON_TRUE_VALUES[v];
        expect(reconciliationAllowed(makeReport(overrides))).toBe(false);
      }
    }
  });

  it("refuses a schemaVersion that is the right number as a string", function () {
    expect(reconciliationAllowed(makeReport({ schemaVersion: "1" }))).toBe(false);
    expect(reconciliationAllowed(makeReport({ schemaVersion: 2 }))).toBe(false);
    expect(reconciliationAllowed(makeReport({ schemaVersion: 0 }))).toBe(false);
  });

  it("refuses a buildStatus that is anything but the exact string complete", function () {
    expect(reconciliationAllowed(makeReport({ buildStatus: "partial" }))).toBe(false);
    expect(reconciliationAllowed(makeReport({ buildStatus: "COMPLETE" }))).toBe(false);
    expect(reconciliationAllowed(makeReport({ buildStatus: true }))).toBe(false);
  });

  it("refuses a layer-count mismatch in either direction", function () {
    // A manifest layer absent from disk.
    expect(reconciliationAllowed(makeReport({ layersPresent: 9 }))).toBe(false);
    // A layer on disk the manifest never described.
    expect(reconciliationAllowed(makeReport({ layersPresent: 11 }))).toBe(false);
  });

  it("refuses when layersPresent and layersExpected are BOTH absent", function () {
    // The fail-open trap: a bare "present !== expected" is FALSE when both are
    // undefined, so the conjunct that exists to prove the layer counting happened
    // would pass on a report where no layer counting happened at all.
    const report = makeReport({ layersPresent: undefined, layersExpected: undefined });
    expect(reconciliationAllowed(report)).toBe(false);
    expect(classificationAllowed(report)).toBe(false);
    expect(classifyManifestFailure(report).tier).toBe("fatal");
  });

  it("refuses when the two halves agree on a count this code does not expect", function () {
    // Both sides counted 9 and agreed — but the code expects ten layers, so the
    // fetcher and this gate have drifted about what a complete set is.
    const report = makeReport({ layersPresent: 9, layersExpected: 9 });
    expect(reconciliationAllowed(report)).toBe(false);
    expect(classifyManifestFailure(report).tier).toBe("fatal");
  });

  it("refuses counts that are not finite numbers", function () {
    expect(reconciliationAllowed(makeReport({ layersPresent: "10" }))).toBe(false);
    expect(reconciliationAllowed(makeReport({ layersExpected: NaN }))).toBe(false);
    expect(reconciliationAllowed(makeReport({ layersPresent: Infinity }))).toBe(false);
    expect(reconciliationAllowed(makeReport({ layersPresent: null }))).toBe(false);
  });

  it("refuses a stale, negative, unparseable or coercible source age", function () {
    expect(reconciliationAllowed(makeReport({ sourceAgeDays: MAX_SOURCE_AGE_DAYS + 0.0001 })))
      .toBe(false);
    expect(reconciliationAllowed(makeReport({ sourceAgeDays: 60 }))).toBe(false);
    // A negative age is a clock or timestamp bug, not freshness.
    expect(reconciliationAllowed(makeReport({ sourceAgeDays: -0.5 }))).toBe(false);
    // NaN from an unparseable oldestSourceTimestamp.
    expect(reconciliationAllowed(makeReport({ sourceAgeDays: NaN }))).toBe(false);
    // The string "5" satisfies both "5" >= 0 and "5" <= 21 through coercion — a
    // bare range check would have armed the delete path on JSON text.
    expect(reconciliationAllowed(makeReport({ sourceAgeDays: "5" }))).toBe(false);
    expect(reconciliationAllowed(makeReport({ sourceAgeDays: "0" }))).toBe(false);
  });

  it("refuses a regions-digest mismatch — the expansion-commit mass-delete guard", function () {
    // Appending a coastal box widens pointInAnyRegion immediately, so every D1
    // row in the new box becomes a delete candidate against a layer set that has
    // no features there. This conjunct is the only thing standing between that
    // commit and the new coast being wiped on the next run.
    expect(reconciliationAllowed(makeReport({ regionsDigestMatches: false }))).toBe(false);
  });

  it("refuses a layerKeys array that does not match the expected set exactly", function () {
    const short = EXPECTED_LAYER_KEYS.slice(0, 9);
    expect(reconciliationAllowed(makeReport({ layerKeys: short }))).toBe(false);
    const swapped = EXPECTED_LAYER_KEYS.slice(0, 9).concat(["coastline-polygon.fgb"]);
    expect(reconciliationAllowed(makeReport({ layerKeys: swapped }))).toBe(false);
    const duplicated = EXPECTED_LAYER_KEYS.slice(0, 9).concat(["water-line.fgb"]);
    expect(reconciliationAllowed(makeReport({ layerKeys: duplicated }))).toBe(false);
    expect(reconciliationAllowed(makeReport({ layerKeys: "ten" }))).toBe(false);
    expect(reconciliationAllowed(makeReport({ layerKeys: [1, 2] }))).toBe(false);
  });

  it("accepts a layerKeys array in any order, since it is a set", function () {
    const reversed = EXPECTED_LAYER_KEYS.slice().reverse();
    expect(reconciliationAllowed(makeReport({ layerKeys: reversed }))).toBe(true);
  });
});

// --- the two predicates, and the direction of their implication -------------------

describe("classificationAllowed is the weaker predicate", function () {
  it("allows classification on a complete set that is merely STALE", function () {
    // A 20-day-old extract's shoreline geometry is COMPLETE, just older.
    // Classifying from it beats leaving rows NULL and VISIBLE, because
    // FLAG_WORTHY_WATER_SQL is fail-OPEN for NULL rows under the attempts cap.
    const report = makeReport({ sourceAgeDays: 45 });
    expect(classificationAllowed(report)).toBe(true);
    expect(reconciliationAllowed(report)).toBe(false);
  });

  it("allows classification when the regions digest no longer matches", function () {
    // The expansion commit produces this BY CONSTRUCTION. Gating classification
    // here too would publish thousands of unclassified new-coast beaches live
    // until a rebuild lands — the exact fail-open regression the classifier gate
    // exists to close, reopened by a guard meant for a different failure.
    const report = makeReport({ regionsDigestMatches: false });
    expect(classificationAllowed(report)).toBe(true);
    expect(reconciliationAllowed(report)).toBe(false);
  });

  it("refuses classification when the view of OSM is INCOMPLETE", function () {
    // A partial water view makes classifyWaterBody's clean-but-empty branch
    // decide inland, which HIDES beaches — the same product loss as a wrong
    // delete, arriving faster and invisible in the row count.
    expect(classificationAllowed(makeReport({ buildStatus: "partial" }))).toBe(false);
    expect(classificationAllowed(makeReport({ sourcesVerified: false }))).toBe(false);
    expect(classificationAllowed(makeReport({ buildSanityPassed: false }))).toBe(false);
  });

  it("refuses classification on every fatal report", function () {
    expect(classificationAllowed(null)).toBe(false);
    expect(classificationAllowed({})).toBe(false);
    expect(classificationAllowed(makeReport({ layersVerified: false }))).toBe(false);
    expect(classificationAllowed(makeReport({ pointerAgreesWithManifest: false }))).toBe(false);
    expect(classificationAllowed(makeReport({ schemaVersion: 2 }))).toBe(false);
  });

  it("never allows reconciliation where it refuses classification", function () {
    // The implication that keeps the two predicates from drifting apart or being
    // applied in the wrong order: reconciliation is strictly stronger.
    const cases = [
      null, undefined, {}, [], "x",
      makeReport(null),
      makeReport({ schemaVersion: 2 }),
      makeReport({ buildStatus: "partial" }),
      makeReport({ sourcesVerified: false }),
      makeReport({ buildSanityPassed: false }),
      makeReport({ pointerAgreesWithManifest: false }),
      makeReport({ layersVerified: false }),
      makeReport({ layersPresent: 9 }),
      makeReport({ regionsDigestMatches: false }),
      makeReport({ sourceAgeDays: 99 }),
      makeReport({ sourceAgeDays: undefined })
    ];
    for (let i = 0; i < cases.length; i = i + 1) {
      if (reconciliationAllowed(cases[i])) {
        expect(classificationAllowed(cases[i])).toBe(true);
      }
    }
  });
});

// --- classifyManifestFailure: the three tiers -------------------------------------

describe("classifyManifestFailure splits fatal from the two degraded tiers", function () {
  it("reports ok with no reasons for a fully-proven report", function () {
    const verdict = classifyManifestFailure(makeReport(null));
    expect(verdict.tier).toBe("ok");
    expect(verdict.reasons).toEqual([]);
  });

  it("reports fatal for a missing or malformed manifest", function () {
    const cases = [null, undefined, "manifest", 7, [], true];
    for (let i = 0; i < cases.length; i = i + 1) {
      const verdict = classifyManifestFailure(cases[i]);
      expect(verdict.tier).toBe("fatal");
      expect(verdict.reasons.length).toBe(1);
      expect(verdict.reasons[0]).toContain("manifest-missing");
    }
  });

  it("reports fatal for each undecodable-set conjunct", function () {
    expect(classifyManifestFailure(makeReport({ schemaVersion: 2 })).tier).toBe("fatal");
    expect(classifyManifestFailure(makeReport({ pointerAgreesWithManifest: false })).tier)
      .toBe("fatal");
    expect(classifyManifestFailure(makeReport({ layersVerified: false })).tier).toBe("fatal");
    expect(classifyManifestFailure(makeReport({ layersPresent: 9 })).tier).toBe("fatal");
    expect(classifyManifestFailure(makeReport({ layerKeys: [] })).tier).toBe("fatal");
  });

  it("reports incomplete for each not-provably-complete conjunct", function () {
    expect(classifyManifestFailure(makeReport({ buildStatus: "partial" })).tier)
      .toBe("incomplete");
    expect(classifyManifestFailure(makeReport({ sourcesVerified: false })).tier)
      .toBe("incomplete");
    expect(classifyManifestFailure(makeReport({ buildSanityPassed: false })).tier)
      .toBe("incomplete");
  });

  it("reports scope_or_stale for the digest and freshness conjuncts", function () {
    expect(classifyManifestFailure(makeReport({ regionsDigestMatches: false })).tier)
      .toBe("scope_or_stale");
    expect(classifyManifestFailure(makeReport({ sourceAgeDays: 99 })).tier)
      .toBe("scope_or_stale");
    expect(classifyManifestFailure(makeReport({ sourceAgeDays: -1 })).tier)
      .toBe("scope_or_stale");
    expect(classifyManifestFailure(makeReport({ sourceAgeDays: undefined })).tier)
      .toBe("scope_or_stale");
  });

  it("reports the MOST SEVERE tier when several tiers fail at once", function () {
    const everything = makeReport({
      schemaVersion: 2,
      buildStatus: "partial",
      regionsDigestMatches: false,
      sourceAgeDays: 99
    });
    const verdict = classifyManifestFailure(everything);
    expect(verdict.tier).toBe("fatal");
    // ...but the reasons carry the WHOLE diagnosis, fatal first, so one run log
    // line tells the operator everything that is wrong with the set.
    expect(verdict.reasons.length).toBe(4);
    expect(verdict.reasons[0]).toContain("schema-version");
    expect(verdict.reasons[1]).toContain("build-incomplete");
    expect(verdict.reasons[2]).toContain("regions-digest-mismatch");
    expect(verdict.reasons[3]).toContain("source-age");
  });

  it("prefers incomplete over scope_or_stale when both are present", function () {
    const verdict = classifyManifestFailure(makeReport({
      sourcesVerified: false,
      sourceAgeDays: 99
    }));
    expect(verdict.tier).toBe("incomplete");
    expect(verdict.reasons.length).toBe(2);
  });

  it("names the offending value in the reason string", function () {
    const verdict = classifyManifestFailure(makeReport({ buildStatus: "partial" }));
    expect(verdict.reasons[0]).toBe("build-incomplete: buildStatus is string \"partial\"");
    const missing = classifyManifestFailure(makeReport({ sourcesVerified: undefined }));
    expect(missing.reasons[0]).toBe("sources-unverified: sourcesVerified is undefined");
    const counted = classifyManifestFailure(makeReport({ layersPresent: 8 }));
    expect(counted.reasons[0]).toBe("layer-count: 8 of 10 layers present");
  });

  it("agrees with both predicates on every tier", function () {
    const byTier = {
      ok: makeReport(null),
      fatal: makeReport({ layersVerified: false }),
      incomplete: makeReport({ buildSanityPassed: false }),
      scope_or_stale: makeReport({ sourceAgeDays: 99 })
    };
    expect(reconciliationAllowed(byTier.ok)).toBe(true);
    expect(classificationAllowed(byTier.ok)).toBe(true);
    expect(reconciliationAllowed(byTier.fatal)).toBe(false);
    expect(classificationAllowed(byTier.fatal)).toBe(false);
    expect(reconciliationAllowed(byTier.incomplete)).toBe(false);
    expect(classificationAllowed(byTier.incomplete)).toBe(false);
    // The tier that keeps classifying.
    expect(reconciliationAllowed(byTier.scope_or_stale)).toBe(false);
    expect(classificationAllowed(byTier.scope_or_stale)).toBe(true);
  });

  it("never throws, whatever it is handed", function () {
    const hostile = [null, undefined, 0, "", NaN, [], [1], function () { return 1; },
      Symbol("s"), new Map(), Object.create(null)];
    for (let i = 0; i < hostile.length; i = i + 1) {
      expect(function () { classifyManifestFailure(hostile[i]); }).not.toThrow();
      expect(function () { classificationAllowed(hostile[i]); }).not.toThrow();
      expect(function () { reconciliationAllowed(hostile[i]); }).not.toThrow();
      expect(function () { parksLayerHealthy(hostile[i]); }).not.toThrow();
    }
  });
});

// --- parksLayerHealthy ------------------------------------------------------------

describe("parksLayerHealthy is the hasPark valve", function () {
  it("is true when both parks layers clear their floors and the previous build", function () {
    expect(parksLayerHealthy(makeReport(null))).toBe(true);
  });

  it("is true at the exact 0.98x and exact-floor boundaries", function () {
    const atRatio = makeReport({
      parks: makeParks({ polygonCount: 980, polygonFloor: 900, previousPolygonCount: 1000 })
    });
    expect(parksLayerHealthy(atRatio)).toBe(true);
    const atFloor = makeReport({
      parks: makeParks({ polygonCount: 2800, polygonFloor: 2800, previousPolygonCount: 2800 })
    });
    expect(parksLayerHealthy(atFloor)).toBe(true);
  });

  it("is false just below the 0.98x previous-build ratio, for either layer", function () {
    const polygon = makeReport({
      parks: makeParks({ polygonCount: 979, polygonFloor: 900, previousPolygonCount: 1000 })
    });
    expect(parksLayerHealthy(polygon)).toBe(false);
    const line = makeReport({
      parks: makeParks({ lineCount: 195, lineFloor: 150, previousLineCount: 200 })
    });
    expect(parksLayerHealthy(line)).toBe(false);
  });

  it("is false below a seeded floor, for either layer", function () {
    expect(parksLayerHealthy(makeReport({
      parks: makeParks({ polygonCount: 2799, polygonFloor: 2800, previousPolygonCount: 2800 })
    }))).toBe(false);
    expect(parksLayerHealthy(makeReport({
      parks: makeParks({ lineCount: 179, lineFloor: 180, previousLineCount: 180 })
    }))).toBe(false);
  });

  it("is false when parks-line is ZERO — a broken carve, never a real reading", function () {
    // Named park ways exist unconditionally at this scope. Zero means the carve
    // that produces them broke, and the consequence is unnamed beaches plus
    // deleted park-origin rows.
    const zeroLine = makeReport({
      parks: makeParks({ lineCount: 0, lineFloor: 0, previousLineCount: 0 })
    });
    expect(parksLayerHealthy(zeroLine)).toBe(false);
    const zeroPolygon = makeReport({
      parks: makeParks({ polygonCount: 0, polygonFloor: 0, previousPolygonCount: 0 })
    });
    expect(parksLayerHealthy(zeroPolygon)).toBe(false);
  });

  it("is false when any parks field is missing, non-numeric or negative", function () {
    const fields = ["polygonCount", "lineCount", "polygonFloor", "lineFloor",
      "previousPolygonCount", "previousLineCount"];
    const bad = [undefined, null, "3120", NaN, Infinity, -1, true, {}];
    for (let f = 0; f < fields.length; f = f + 1) {
      for (let b = 0; b < bad.length; b = b + 1) {
        const overrides = {};
        overrides[fields[f]] = bad[b];
        expect(parksLayerHealthy(makeReport({ parks: makeParks(overrides) }))).toBe(false);
      }
    }
  });

  it("is false on a BOOTSTRAP set with no history and no seeded floors", function () {
    // Build 1 has an empty history array and a floors file that ships with nulls
    // rather than invented numbers. hasPark false leaves park_name UNTOUCHED on
    // every existing row, which is the safe direction; the next build carries
    // history and the valve opens on its own.
    const bootstrap = makeReport({
      parks: makeParks({
        polygonFloor: null,
        lineFloor: null,
        previousPolygonCount: null,
        previousLineCount: null
      })
    });
    expect(parksLayerHealthy(bootstrap)).toBe(false);
  });

  it("is false when the parks block is absent or not an object", function () {
    expect(parksLayerHealthy(makeReport({ parks: undefined }))).toBe(false);
    expect(parksLayerHealthy(makeReport({ parks: null }))).toBe(false);
    expect(parksLayerHealthy(makeReport({ parks: [] }))).toBe(false);
    expect(parksLayerHealthy(makeReport({ parks: "healthy" }))).toBe(false);
  });

  it("is false whenever the set is not a complete view of OSM", function () {
    // The counts come from the manifest, so they are only worth reading once the
    // set is decodable and complete.
    expect(parksLayerHealthy(makeReport({ buildStatus: "partial" }))).toBe(false);
    expect(parksLayerHealthy(makeReport({ layersVerified: false }))).toBe(false);
    expect(parksLayerHealthy(null)).toBe(false);
  });

  it("stays true on a stale or out-of-scope set, where park names are still good", function () {
    // Deletes stop in both tiers, but a stale extract's park polygons are
    // complete and refreshing park_name from them is strictly better than
    // freezing it.
    expect(parksLayerHealthy(makeReport({ sourceAgeDays: 45 }))).toBe(true);
    expect(parksLayerHealthy(makeReport({ regionsDigestMatches: false }))).toBe(true);
  });
});

// --- regionsDigestInput -----------------------------------------------------------

describe("regionsDigestInput canonicalises the delete scope", function () {
  // Two boxes, deliberately out of name order, with incidental fields and a
  // different key order inside the bbox literal.
  function twoRegions() {
    return [
      {
        name: "Zeta Bay",
        note: "some prose that must not enter the digest",
        bbox: { maxLat: 44.0, minLon: -80.0, maxLon: -79.0, minLat: 43.0 }
      },
      {
        name: "Alpha Sound",
        bbox: { minLon: -88.3, minLat: 41.5, maxLon: -84.5, maxLat: 46.2 }
      }
    ];
  }

  it("defaults to the live REGIONS and is deterministic across calls", function () {
    expect(regionsDigestInput()).toBe(regionsDigestInput());
    expect(regionsDigestInput()).toBe(regionsDigestInput(REGIONS));
    expect(typeof regionsDigestInput()).toBe("string");
  });

  it("carries every live region by name, and nothing else", function () {
    const digestInput = regionsDigestInput();
    const parsed = JSON.parse(digestInput);
    expect(parsed.length).toBe(REGIONS.length);
    for (let i = 0; i < parsed.length; i = i + 1) {
      expect(Object.keys(parsed[i])).toEqual(["name", "bbox"]);
      expect(Object.keys(parsed[i].bbox)).toEqual(["minLon", "minLat", "maxLon", "maxLat"]);
    }
    // Note text is the most-edited field in src/regions.js and must never
    // invalidate a layer set.
    expect(digestInput.indexOf("note")).toBe(-1);
    expect(digestInput.indexOf("Largest of the lakes")).toBe(-1);
  });

  it("is stable under comment, note and array-order edits", function () {
    const base = regionsDigestInput(twoRegions());
    // Reordering the array.
    const reordered = twoRegions().reverse();
    expect(regionsDigestInput(reordered)).toBe(base);
    // Rewriting the note prose and adding an incidental field.
    const renoted = twoRegions();
    renoted[0].note = "entirely different prose";
    renoted[1].tileHint = 2.0;
    expect(regionsDigestInput(renoted)).toBe(base);
    // Reordering the keys inside a bbox literal.
    const rekeyed = twoRegions();
    const b = rekeyed[1].bbox;
    rekeyed[1].bbox = { maxLat: b.maxLat, maxLon: b.maxLon, minLat: b.minLat, minLon: b.minLon };
    expect(regionsDigestInput(rekeyed)).toBe(base);
  });

  it("CHANGES when any bbox edge moves, even slightly", function () {
    const base = regionsDigestInput(twoRegions());
    const edges = ["minLon", "minLat", "maxLon", "maxLat"];
    for (let i = 0; i < edges.length; i = i + 1) {
      const moved = twoRegions();
      moved[1].bbox[edges[i]] = moved[1].bbox[edges[i]] + 0.01;
      expect(regionsDigestInput(moved)).not.toBe(base);
    }
  });

  it("CHANGES when a box is added, removed or renamed", function () {
    const base = regionsDigestInput(twoRegions());
    const added = twoRegions();
    added.push({
      name: "US Pacific Coast",
      bbox: { minLon: -125.0, minLat: 32.5, maxLon: -117.0, maxLat: 49.0 }
    });
    expect(regionsDigestInput(added)).not.toBe(base);
    const removed = [twoRegions()[0]];
    expect(regionsDigestInput(removed)).not.toBe(base);
    const renamed = twoRegions();
    renamed[0].name = "Zeta Bay East";
    expect(regionsDigestInput(renamed)).not.toBe(base);
  });

  it("orders identically-named boxes deterministically by their bbox", function () {
    const a = [
      { name: "Twin", bbox: { minLon: -2, minLat: 1, maxLon: -1, maxLat: 2 } },
      { name: "Twin", bbox: { minLon: -4, minLat: 1, maxLon: -3, maxLat: 2 } }
    ];
    const b = [a[1], a[0]];
    expect(regionsDigestInput(a)).toBe(regionsDigestInput(b));
  });

  it("throws on malformed regions data rather than digesting garbage", function () {
    expect(function () { regionsDigestInput([]); })
      .toThrow("regionsDigestInput: expected a non-empty regions array");
    expect(function () { regionsDigestInput(null); })
      .toThrow("regionsDigestInput: expected a non-empty regions array");
    expect(function () { regionsDigestInput("REGIONS"); })
      .toThrow("regionsDigestInput: expected a non-empty regions array");
    expect(function () { regionsDigestInput([{ bbox: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 } }]); })
      .toThrow("regionsDigestInput: region 0 has no name");
    expect(function () { regionsDigestInput([{ name: "No Box" }]); })
      .toThrow("regionsDigestInput: region No Box has no bbox");
    expect(function () {
      regionsDigestInput([{ name: "Bad Edge", bbox: { minLon: 0, minLat: 0, maxLon: "1", maxLat: 1 } }]);
    }).toThrow("regionsDigestInput: region Bad Edge bbox.maxLon is not a finite number");
    expect(function () {
      regionsDigestInput([{ name: "NaN Edge", bbox: { minLon: 0, minLat: 0, maxLon: 1, maxLat: NaN } }]);
    }).toThrow("regionsDigestInput: region NaN Edge bbox.maxLat is not a finite number");
  });
});

// --- one composed pipeline test ---------------------------------------------------

describe("the gate over one build's lifetime", function () {
  it("walks a set from bootstrap through healthy, degraded and fatal", function () {
    // 1. Bootstrap build: complete and fresh, but no history, so park names stay
    //    frozen while deletes and classification both run.
    const bootstrap = makeReport({
      parks: makeParks({ previousPolygonCount: null, previousLineCount: null })
    });
    expect(classifyManifestFailure(bootstrap).tier).toBe("ok");
    expect(reconciliationAllowed(bootstrap)).toBe(true);
    expect(classificationAllowed(bootstrap)).toBe(true);
    expect(parksLayerHealthy(bootstrap)).toBe(false);

    // 2. Steady state: everything proven, every path armed.
    const healthy = makeReport(null);
    expect(classifyManifestFailure(healthy).tier).toBe("ok");
    expect(reconciliationAllowed(healthy)).toBe(true);
    expect(classificationAllowed(healthy)).toBe(true);
    expect(parksLayerHealthy(healthy)).toBe(true);

    // 3. Someone appends a Pacific box to src/regions.js. The digest stops
    //    matching immediately, deletes stop, classification and park names carry
    //    on so the new coast is not published unclassified.
    const expanded = makeReport({ regionsDigestMatches: false });
    expect(classifyManifestFailure(expanded).tier).toBe("scope_or_stale");
    expect(reconciliationAllowed(expanded)).toBe(false);
    expect(classificationAllowed(expanded)).toBe(true);
    expect(parksLayerHealthy(expanded)).toBe(true);

    // 4. The build workflow starts failing silently. Past the horizon, the
    //    tripwire trips: still no deletes, still classifying.
    const stale = makeReport({ sourceAgeDays: MAX_SOURCE_AGE_DAYS + 1 });
    expect(classifyManifestFailure(stale).tier).toBe("scope_or_stale");
    expect(reconciliationAllowed(stale)).toBe(false);
    expect(classificationAllowed(stale)).toBe(true);

    // 5. A build publishes with failed source checksums. Now the view of OSM is
    //    not provably complete: classification stops too, because a partial water
    //    view would hide beaches as "inland".
    const incomplete = makeReport({ sourcesVerified: false });
    expect(classifyManifestFailure(incomplete).tier).toBe("incomplete");
    expect(reconciliationAllowed(incomplete)).toBe(false);
    expect(classificationAllowed(incomplete)).toBe(false);
    expect(parksLayerHealthy(incomplete)).toBe(false);

    // 6. A download is truncated: the sha256 check fails. Nothing may be decoded
    //    at all — no SQL of any kind.
    const fatal = makeReport({ layersVerified: false });
    expect(classifyManifestFailure(fatal).tier).toBe("fatal");
    expect(classifyManifestFailure(fatal).reasons[0]).toContain("layers-unverified");
    expect(reconciliationAllowed(fatal)).toBe(false);
    expect(classificationAllowed(fatal)).toBe(false);
    expect(parksLayerHealthy(fatal)).toBe(false);
  });
});
