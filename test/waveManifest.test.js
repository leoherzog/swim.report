// Tests for src/waveManifest.js — the fail-closed consumer gate that decides whether
// a published wave cycle may be written into production KV.
//
// The property under test is REFUSAL, not acceptance. Every conjunct is a strict
// !== true, so the assertions below deliberately spend most of their budget proving
// that a MISSING field refuses exactly as an explicitly false one does. The report is
// assembled by two separate scripts and one of them leaves two fields ABSENT on
// purpose, so a dropped fold must stop the write rather than sail through it.

import { describe, it, expect } from "vitest";
import {
  WAVE_SCHEMA_VERSION,
  EXPECTED_WAVE_ARTIFACTS,
  WAVE_KV_LEASE_SECONDS,
  MIN_LEASE_SECONDS,
  classifyWaveManifestFailure,
  waveKvWriteAllowed
} from "../src/waveManifest.js";

// A report every conjunct passes. Each test removes or falsifies exactly one field.
function okReport(overrides) {
  return Object.assign({
    schemaVersion: WAVE_SCHEMA_VERSION,
    pointerAgreesWithManifest: true,
    artifactsVerified: true,
    artifactsPresent: EXPECTED_WAVE_ARTIFACTS.length,
    artifactsExpected: EXPECTED_WAVE_ARTIFACTS.length,
    buildStatus: "complete",
    validTimesPassed: true,
    sentinelScanPassed: true,
    minimumRecordsPassed: true,
    gridsDigestMatches: true,
    secondsRemaining: WAVE_KV_LEASE_SECONDS,
    gridsComplete: true,
    sanityOverridden: false
  }, overrides || {});
}

function without(field) {
  const report = okReport();
  delete report[field];
  return report;
}

describe("the clean cycle", function () {
  it("passes every conjunct and allows the write", function () {
    const verdict = classifyWaveManifestFailure(okReport());
    expect(verdict.tier).toBe("ok");
    expect(verdict.reasons).toEqual([]);
    expect(waveKvWriteAllowed(okReport())).toBe(true);
  });
});

describe("the fatal tier", function () {
  const fields = ["schemaVersion", "pointerAgreesWithManifest", "artifactsVerified",
    "buildStatus", "validTimesPassed", "sentinelScanPassed", "minimumRecordsPassed"];

  it("refuses on any single false fatal conjunct", function () {
    for (let i = 0; i < fields.length; i = i + 1) {
      const overrides = {};
      overrides[fields[i]] = false;
      expect(classifyWaveManifestFailure(okReport(overrides)).tier).toBe("fatal");
      expect(waveKvWriteAllowed(okReport(overrides))).toBe(false);
    }
  });

  it("refuses on a MISSING fatal conjunct exactly as on a false one", function () {
    for (let i = 0; i < fields.length; i = i + 1) {
      expect(classifyWaveManifestFailure(without(fields[i])).tier).toBe("fatal");
      expect(waveKvWriteAllowed(without(fields[i]))).toBe(false);
    }
  });

  it("refuses a truthy-but-not-true value, which is not proof", function () {
    expect(waveKvWriteAllowed(okReport({ artifactsVerified: 1 }))).toBe(false);
    expect(waveKvWriteAllowed(okReport({ validTimesPassed: "true" }))).toBe(false);
  });

  it("refuses a schemaVersion this code cannot claim to understand", function () {
    expect(classifyWaveManifestFailure(okReport({ schemaVersion: WAVE_SCHEMA_VERSION + 1 }))
      .tier).toBe("fatal");
  });

  it("refuses any buildStatus other than the literal \"complete\"", function () {
    expect(classifyWaveManifestFailure(okReport({ buildStatus: "partial" })).tier)
      .toBe("fatal");
    expect(classifyWaveManifestFailure(okReport({ buildStatus: "" })).tier).toBe("fatal");
  });

  it("refuses null and non-object reports rather than throwing", function () {
    expect(waveKvWriteAllowed(null)).toBe(false);
    expect(waveKvWriteAllowed(undefined)).toBe(false);
    expect(waveKvWriteAllowed([])).toBe(false);
    expect(waveKvWriteAllowed("{}")).toBe(false);
    expect(classifyWaveManifestFailure(null).tier).toBe("fatal");
  });
});

describe("the artifact-count trap", function () {
  it("refuses when BOTH counts are absent, which a bare !== comparison would pass",
    function () {
      // undefined !== undefined is false, so "present !== expected" alone is
      // FAIL-OPEN for a report in which no artifact counting happened at all — the
      // exact conjunct that exists to prove the counting happened.
      const report = okReport();
      delete report.artifactsPresent;
      delete report.artifactsExpected;
      expect(waveKvWriteAllowed(report)).toBe(false);
      expect(classifyWaveManifestFailure(report).tier).toBe("fatal");
    });

  it("refuses when either count alone is absent", function () {
    expect(waveKvWriteAllowed(without("artifactsPresent"))).toBe(false);
    expect(waveKvWriteAllowed(without("artifactsExpected"))).toBe(false);
  });

  it("refuses a count that arrived as JSON text rather than a JSON number", function () {
    expect(waveKvWriteAllowed(okReport({ artifactsPresent: "2", artifactsExpected: "2" })))
      .toBe(false);
  });

  it("refuses a short set", function () {
    expect(waveKvWriteAllowed(okReport({ artifactsPresent: 1 }))).toBe(false);
  });

  it("refuses a complete set of the wrong size, which means the two halves drifted",
    function () {
      expect(waveKvWriteAllowed(okReport({ artifactsPresent: 3, artifactsExpected: 3 })))
        .toBe(false);
    });
});

describe("the expired tier", function () {
  it("refuses a lease shorter than the floor", function () {
    const verdict = classifyWaveManifestFailure(
      okReport({ secondsRemaining: MIN_LEASE_SECONDS - 1 }));
    expect(verdict.tier).toBe("expired");
    expect(waveKvWriteAllowed(okReport({ secondsRemaining: MIN_LEASE_SECONDS - 1 })))
      .toBe(false);
  });

  it("accepts a lease exactly at the floor", function () {
    expect(waveKvWriteAllowed(okReport({ secondsRemaining: MIN_LEASE_SECONDS }))).toBe(true);
  });

  it("refuses a negative lease, so an old cycle cannot be republished over a new one",
    function () {
      expect(waveKvWriteAllowed(okReport({ secondsRemaining: -60 }))).toBe(false);
    });

  it("refuses NaN from an unparseable validStartIso", function () {
    // Refusing because we cannot tell how old the data is is the same answer as
    // refusing because it is too old.
    expect(waveKvWriteAllowed(okReport({ secondsRemaining: NaN }))).toBe(false);
    expect(classifyWaveManifestFailure(okReport({ secondsRemaining: NaN })).tier)
      .toBe("expired");
  });

  it("refuses a missing secondsRemaining, which is a dropped consumer fold", function () {
    expect(waveKvWriteAllowed(without("secondsRemaining"))).toBe(false);
  });

  it("refuses a gridsDigest mismatch and a missing one alike", function () {
    expect(classifyWaveManifestFailure(okReport({ gridsDigestMatches: false })).tier)
      .toBe("expired");
    expect(waveKvWriteAllowed(without("gridsDigestMatches"))).toBe(false);
  });

  it("reports a fatal conjunct ahead of an expired one when both fire", function () {
    const verdict = classifyWaveManifestFailure(
      okReport({ buildStatus: "partial", secondsRemaining: 0 }));
    expect(verdict.tier).toBe("fatal");
    expect(verdict.reasons.length).toBe(2);
    expect(verdict.reasons[0].indexOf("build-incomplete")).toBe(0);
  });
});

describe("the minimum record rail", function () {
  it("refuses a cycle that emitted no wave value, false or absent alike", function () {
    // A zero-record cycle otherwise passes every conjunct here AND every gate in the
    // build: publishing it moves the pointer and poisons every future shrink ratio,
    // which skips a field whose previous count is <= 0.
    expect(classifyWaveManifestFailure(okReport({ minimumRecordsPassed: false })).tier)
      .toBe("fatal");
    expect(waveKvWriteAllowed(without("minimumRecordsPassed"))).toBe(false);
  });

  it("still reaches DEGRADED when a non-required grid was out", function () {
    // This is the case the per-grid isolation exists to make reachable: GLWU down,
    // gfswave sampled, so gridsComplete is false and the ocean beaches still get
    // their KV.
    const verdict = classifyWaveManifestFailure(
      okReport({ minimumRecordsPassed: true, gridsComplete: false }));
    expect(verdict.tier).toBe("degraded");
    expect(waveKvWriteAllowed(okReport({ gridsComplete: false }))).toBe(true);
  });
});

describe("the degraded tier", function () {
  it("writes but warns when a grid contributed nothing", function () {
    const verdict = classifyWaveManifestFailure(okReport({ gridsComplete: false }));
    expect(verdict.tier).toBe("degraded");
    expect(waveKvWriteAllowed(okReport({ gridsComplete: false }))).toBe(true);
  });

  it("writes but warns when a human overrode a coverage gate", function () {
    const verdict = classifyWaveManifestFailure(okReport({ sanityOverridden: true }));
    expect(verdict.tier).toBe("degraded");
    expect(waveKvWriteAllowed(okReport({ sanityOverridden: true }))).toBe(true);
  });

  it("degrades on a MISSING gridsComplete, since a missing claim is not a claim",
    function () {
      expect(classifyWaveManifestFailure(without("gridsComplete")).tier).toBe("degraded");
      expect(waveKvWriteAllowed(without("gridsComplete"))).toBe(true);
    });

  it("does not degrade on a missing sanityOverridden, which is only true-triggered",
    function () {
      expect(classifyWaveManifestFailure(without("sanityOverridden")).tier).toBe("ok");
    });
});
