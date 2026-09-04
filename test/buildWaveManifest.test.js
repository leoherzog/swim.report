// Tests for scripts/build-wave-manifest.js, the build-side gate of the NOAA
// GRIB2 wave pipeline. Importing its pure exports touches no Deno API, no
// subprocess and no file system.
//
// The split these tests defend is the whole design: everything that could
// produce a wrong number is non-overridable, and everything that is merely less
// data is overridable and warns. A flag an operator reaches for during an
// incident must not be able to wave a sentinel, a shifted grid or a time-shifted
// band into src/rules.js.

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  FORECAST_HOURS,
  GRIDS,
  REQUIRED_GRID_IDS,
  METERS_PER_SECOND_TO_MPH
} from "../src/waveGrids.js";
import { WAVE_KV_LEASE_SECONDS } from "../src/waveManifest.js";
import {
  WAVE_SHRINK_MIN_RATIO,
  WAVE_DECAY_MIN_RATIO,
  HISTORY_RETAIN,
  MIN_DISTINCT_WAVE_VALUES,
  MAX_EMITTED_FT,
  MAX_EMITTED_MPH,
  ALLOWED_PAIR_FIELDS,
  gridIdentityRefusals,
  bandIdentityRefusals,
  validTimeRefusals,
  scanRecords,
  sentinelRefusals,
  alignmentRefusals,
  distributionRefusals,
  ttlSpellingRefusals,
  minimumRecordRefusals,
  zeroResolutionWarnings,
  floorsEntryFor,
  coverageFloorRefusals,
  perGridFloorRefusals,
  perGridFloorStatus,
  perGridShrinkRefusals,
  perGridDecayRefusals,
  shrinkRatioRefusals,
  decayRefusals,
  gridIdsOf,
  gridStatusOf,
  gridSampled,
  notSampledGrids,
  hasGridCounts,
  gridCountsFromManifest,
  buildHistory,
  oldestRetained,
  historyEntryFor,
  sha256SumsText,
  parseNdjson,
  sentinelValues,
  runnerImageOf,
  evaluateWaveGates,
  main
} from "../scripts/build-wave-manifest.js";

const VALID_START = 1788415200;
const DIGEST = "sha256:" + "e".repeat(64);

function expectDoc() {
  return {
    tolerance: { origin: 1e-9, pixel: 1e-12 },
    bands: ["HTSGW", "WIND"],
    grids: {
      noaa_gfswave: {
        sampled: { width: 10, height: 8, originLon: -5, originLat: 4,
          pixelLon: 0.5, pixelLat: -0.5, nodata: 9999 }
      }
    }
  };
}

function gridStats(overrides) {
  return {
    noaa_gfswave: Object.assign({
      assignedBeaches: 100,
      resolvedBeaches: 90,
      waveinputRecords: 90,
      wavesRecords: 90,
      validPercent: 42,
      ring0Fraction: 0.8,
      medianSearchKm: 3,
      maxSearchKm: 20,
      identity: { width: 10, height: 8, originLon: -5, originLat: 4,
        pixelLon: 0.5, pixelLat: -0.5, nodata: 9999 },
      // 24 hourly wave planes plus the hour-0 wind plane, all agreeing with identity.
      identityPlanes: FORECAST_HOURS + 1,
      identityMismatches: []
    }, overrides || {})
  };
}

// One entry for EVERY grid in GRIDS, which is the contract the build gate scopes
// every count gate by. Overriding one id to "unfetched" is the NOMADS-outage shape.
function gridStatus(overrides) {
  const out = {};
  for (let i = 0; i < GRIDS.length; i = i + 1) {
    out[GRIDS[i].id] = { status: "sampled", elements: ["HTSGW", "WIND"], reasons: [] };
  }
  return Object.assign(out, overrides || {});
}

function outGrid(reason) {
  return { status: "unfetched", elements: [], reasons: [reason] };
}

function bands(overrides) {
  const out = [];
  for (let hour = 0; hour < FORECAST_HOURS; hour = hour + 1) {
    out.push({ gridId: "noaa_gfswave", hour: hour, element: "HTSGW", band: 2,
      validTime: VALID_START + hour * 3600 });
    out.push({ gridId: "noaa_gfswave", hour: hour, element: "WIND", band: 1,
      validTime: VALID_START + hour * 3600 });
  }
  if (overrides !== undefined) {
    Object.assign(out[overrides.index], overrides.patch);
  }
  return out;
}

function waveinputRecords(n, overrides) {
  const out = [];
  for (let i = 0; i < n; i = i + 1) {
    out.push(Object.assign({
      beachId: "b-" + String(i),
      waveHeightFt: 1 + i * 0.13,
      model: "noaa_gfswave",
      windSpeedMph: null,
      windGustMph: null,
      updated: "2026-09-03T12:00:00.000Z"
    }, overrides || {}));
  }
  return out;
}

function wavesRecords(inputs, overrides) {
  const out = [];
  for (let i = 0; i < inputs.length; i = i + 1) {
    const hoursFt = [];
    for (let h = 0; h < FORECAST_HOURS; h = h + 1) {
      hoursFt.push(h === 0 ? inputs[i].waveHeightFt : inputs[i].waveHeightFt + h * 0.02);
    }
    out.push(Object.assign({
      beachId: inputs[i].beachId,
      startIso: "2026-09-03T12:00:00.000Z",
      hoursFt: hoursFt,
      models: ["noaa_gfswave"],
      byModel: { noaa_gfswave: hoursFt },
      sources: [],
      updated: "2026-09-03T12:00:00.000Z"
    }, overrides || {}));
  }
  return out;
}

function cleanStats() {
  const inputs = waveinputRecords(40);
  return scanRecords(inputs, wavesRecords(inputs), [9999]);
}

// --- identity -----------------------------------------------------------------------

describe("gridIdentityRefusals", function () {
  it("passes a raster that matches its committed expectation", function () {
    expect(gridIdentityRefusals(gridStats(), expectDoc())).toEqual([]);
  });

  it("refuses a moved origin, a resized raster and a changed cell size", function () {
    const moves = [
      { originLon: -5.5 }, { width: 11 }, { pixelLat: -0.25 }, { nodata: 9998 }
    ];
    for (let i = 0; i < moves.length; i = i + 1) {
      const stats = gridStats({ identity: Object.assign(
        { width: 10, height: 8, originLon: -5, originLat: 4, pixelLon: 0.5,
          pixelLat: -0.5, nodata: 9999 }, moves[i]) });
      expect(gridIdentityRefusals(stats, expectDoc()).length).toBeGreaterThan(0);
    }
  });

  it("tolerates float noise inside the committed epsilon", function () {
    const stats = gridStats({ identity: { width: 10, height: 8, originLon: -5 + 1e-12,
      originLat: 4, pixelLon: 0.5, pixelLat: -0.5, nodata: 9999 } });
    expect(gridIdentityRefusals(stats, expectDoc())).toEqual([]);
  });

  it("refuses a grid with no committed expectation at all", function () {
    const doc = expectDoc();
    delete doc.grids.noaa_gfswave;
    expect(gridIdentityRefusals(gridStats(), doc).length).toBe(1);
  });

  it("is never overridable", function () {
    const stats = gridStats({ identity: { width: 99 } });
    const refusals = gridIdentityRefusals(stats, expectDoc());
    for (let i = 0; i < refusals.length; i = i + 1) {
      expect(refusals[i].overridable).toBe(false);
    }
  });

  it("refuses a grid whose LATER planes disagree with its hour-0 raster", function () {
    // The identity block above describes hour 0 alone. noaa_gfswave downloads one
    // file per forecast hour, so hour 7 can carry a shifted origin with identical
    // dimensions and decode, sample and pass every other gate.
    const stats = gridStats({ identityMismatches: [
      "noaa_gfswave-h07-HTSGW: originLon is -179.75, expected -5"
    ] });
    const refusals = gridIdentityRefusals(stats, expectDoc());
    expect(refusals.length).toBe(1);
    expect(refusals[0].message).toBe("gridIdentity: noaa_gfswave: " +
      "noaa_gfswave-h07-HTSGW: originLon is -179.75, expected -5");
    expect(refusals[0].overridable).toBe(false);
  });

  it("refuses a sample report that carries no plane identity count", function () {
    // A producer predating the all-plane comparison would otherwise pass it
    // vacuously, which is the failure the comparison exists to close.
    const stats = gridStats();
    delete stats.noaa_gfswave.identityPlanes;
    const refusals = gridIdentityRefusals(stats, expectDoc());
    expect(refusals.length).toBe(1);
    expect(refusals[0].message).toBe(
      "gridIdentity: noaa_gfswave: the sample report carries no plane identity count");
    expect(refusals[0].overridable).toBe(false);
    expect(gridIdentityRefusals(gridStats({ identityPlanes: 0 }), expectDoc()).length).toBe(1);
  });
});

describe("bandIdentityRefusals", function () {
  it("passes bands drawn from the committed element set", function () {
    expect(bandIdentityRefusals(bands(), ["HTSGW", "WIND"])).toEqual([]);
  });

  it("refuses a band whose GRIB_ELEMENT is not one this pipeline reads", function () {
    // Slicing the wrong .idx record produces a valid GRIB2 message describing the
    // wrong variable, which decodes without a murmur.
    const refusals = bandIdentityRefusals(
      bands({ index: 4, patch: { element: "PERPW" } }), ["HTSGW", "WIND"]);
    expect(refusals.length).toBe(1);
    expect(refusals[0].overridable).toBe(false);
  });

  it("refuses an empty band list", function () {
    expect(bandIdentityRefusals([], ["HTSGW"]).length).toBe(1);
  });
});

describe("validTimeRefusals", function () {
  it("passes when every band's valid time is validStartEpoch + hour*3600", function () {
    expect(validTimeRefusals(bands(), VALID_START)).toEqual([]);
  });

  it("refuses an off-by-one hour, which is the .idx shift signature", function () {
    const shifted = bands({ index: 10, patch: { validTime: VALID_START + 6 * 3600 } });
    const refusals = validTimeRefusals(shifted, VALID_START);
    expect(refusals.length).toBe(1);
    expect(refusals[0].overridable).toBe(false);
  });

  it("refuses when validStartEpoch itself is not a number", function () {
    expect(validTimeRefusals(bands(), null).length).toBe(1);
  });
});

// --- the emitted numbers ---------------------------------------------------------------

describe("scanRecords", function () {
  it("counts values and measures the distribution", function () {
    const stats = cleanStats();
    expect(stats.waveinputRecords).toBe(40);
    expect(stats.wavesRecords).toBe(40);
    expect(stats.waveValues).toBe(40);
    expect(stats.sentinelHits).toBe(0);
    expect(stats.distinctWaveValues).toBeGreaterThan(MIN_DISTINCT_WAVE_VALUES);
    expect(stats.meanWaveFt).toBeGreaterThan(0);
  });

  it("catches a sentinel that survived containment", function () {
    const inputs = waveinputRecords(40);
    inputs[3].waveHeightFt = 9999;
    // The series mirrors hour 0 from the same sample, so one leaked sentinel shows up
    // twice: once in waveinput.waveHeightFt and once in hoursFt[0].
    const stats = scanRecords(inputs, wavesRecords(inputs), [9999]);
    expect(stats.sentinelHits).toBe(2);
    // Only the two cells that EQUAL the nodata are sentinel hits; every hour of the
    // leaked series is out of range, because 9999 m is 32808 ft.
    expect(stats.outOfRange).toBe(25);
    expect(sentinelRefusals(stats).length).toBe(2);
  });

  it("catches the GLWU sentinel converted to feet", function () {
    const inputs = waveinputRecords(40);
    inputs[1].waveHeightFt = 9.999000260554009e+20 * 3.28084;
    const stats = scanRecords(inputs, [],
      sentinelValues([{ sampled: { nodata: 9.999000260554009e+20 } }]));
    expect(stats.sentinelHits).toBe(1);
  });

  it("catches a series that is not exactly 24 entries", function () {
    const inputs = waveinputRecords(40);
    const series = wavesRecords(inputs);
    series[0].hoursFt = series[0].hoursFt.slice(0, 23);
    const stats = scanRecords(inputs, series, [9999]);
    expect(stats.misalignedSeries).toBe(1);
    expect(alignmentRefusals(stats).length).toBeGreaterThan(0);
  });

  it("catches hoursFt[0] drifting from its own waveinput waveHeightFt", function () {
    const inputs = waveinputRecords(40);
    const series = wavesRecords(inputs);
    series[2].hoursFt[0] = series[2].hoursFt[0] + 0.5;
    const stats = scanRecords(inputs, series, [9999]);
    expect(stats.firstCellMismatches).toBe(1);
    expect(alignmentRefusals(stats).length).toBe(1);
  });

  it("catches a non-null non-number cell", function () {
    const inputs = waveinputRecords(40);
    const series = wavesRecords(inputs);
    series[0].hoursFt[4] = "1.2";
    const stats = scanRecords(inputs, series, [9999]);
    expect(stats.nonNumericCells).toBe(1);
  });

  it("catches a waveinput carrying a non-null windGustMph", function () {
    const inputs = waveinputRecords(2, { windGustMph: 30 });
    const stats = scanRecords(inputs, [], [9999]);
    expect(stats.shapeProblems).toBe(2);
  });
});

// windSpeedMph is populated only when waveHeightFt is null, so for exactly the
// beaches carrying it, wind is the sole input deciding a color. The 9000 m/s
// magnitude rail in src/waveGrids.js bounds the RAW sample, so a corrupt WIND plane
// producing a finite value inside it emits up to 20,132 mph with no rail underneath.
describe("the wind sentinel scan", function () {
  function windInputs(n, wind) {
    return waveinputRecords(n, { waveHeightFt: null, windSpeedMph: wind });
  }

  it("counts plausible wind without refusing", function () {
    const inputs = waveinputRecords(40);
    inputs[0].waveHeightFt = null;
    inputs[0].windSpeedMph = 14.2;
    const stats = scanRecords(inputs, wavesRecords(inputs.slice(1)), [9999]);
    expect(stats.windValues).toBe(1);
    expect(stats.windSentinelHits).toBe(0);
    expect(stats.windOutOfRange).toBe(0);
    expect(sentinelRefusals(stats)).toEqual([]);
  });

  it("catches a nodata that survived containment as mph", function () {
    const stats = scanRecords(windInputs(1, 9999 * METERS_PER_SECOND_TO_MPH), [],
      sentinelValues([{ sampled: { nodata: 9999 } }]));
    expect(stats.windSentinelHits).toBe(1);
    const refusals = sentinelRefusals(stats);
    expect(refusals.length).toBe(2);
    for (let i = 0; i < refusals.length; i = i + 1) {
      expect(refusals[i].overridable).toBe(false);
    }
  });

  it("catches a wind above the mph ceiling and a negative one", function () {
    const high = scanRecords(windInputs(1, MAX_EMITTED_MPH + 1), [], [9999]);
    expect(high.windOutOfRange).toBe(1);
    expect(sentinelRefusals(high).length).toBe(1);
    const negative = scanRecords(windInputs(1, -3), [], [9999]);
    expect(negative.windOutOfRange).toBe(1);
    expect(sentinelRefusals(negative).length).toBe(1);
  });

  it("counts a non-finite windSpeedMph as a non-numeric cell", function () {
    const stats = scanRecords(windInputs(1, "12"), [], [9999]);
    expect(stats.nonNumericCells).toBe(1);
    expect(stats.windValues).toBe(0);
    expect(alignmentRefusals(stats).length).toBe(1);
  });

  it("keeps wind out of the wave distribution entirely", function () {
    // Folding mph into meanWaveFt and distinctWaveValues would stop both
    // distribution gates from measuring waves, and a constant wave plane could then
    // pass distinctValues on wind variance alone.
    const withWind = waveinputRecords(40);
    for (let i = 0; i < withWind.length; i = i + 1) {
      withWind[i].windSpeedMph = 5 + i;
    }
    const stripped = waveinputRecords(40);
    const a = scanRecords(withWind, wavesRecords(withWind), [9999]);
    const b = scanRecords(stripped, wavesRecords(stripped), [9999]);
    expect(a.meanWaveFt).toBe(b.meanWaveFt);
    expect(a.distinctWaveValues).toBe(b.distinctWaveValues);
    expect(a.waveValues).toBe(b.waveValues);
    expect(a.windValues).toBe(40);
    expect(b.windValues).toBe(0);
  });

  it("pins the mph ceiling separately from the feet one", function () {
    expect(MAX_EMITTED_MPH).toBe(200);
    expect(MAX_EMITTED_MPH).not.toBe(MAX_EMITTED_FT);
  });
});

describe("distributionRefusals", function () {
  it("refuses a constant grid that passes every counting gate", function () {
    const inputs = waveinputRecords(40, { waveHeightFt: 1.5 });
    const stats = scanRecords(inputs, [], [9999]);
    expect(stats.misalignedSeries).toBe(0);
    expect(stats.sentinelHits).toBe(0);
    const refusals = distributionRefusals(stats);
    expect(refusals.length).toBe(1);
    expect(refusals[0].check).toBe("distinctValues");
    expect(refusals[0].overridable).toBe(false);
  });

  it("refuses an implausible mean in either direction", function () {
    const low = scanRecords(waveinputRecords(40, { waveHeightFt: 0.001 }), [], [9999]);
    expect(distributionRefusals(low).length).toBeGreaterThan(0);
    const high = scanRecords(waveinputRecords(40, { waveHeightFt: 90 }), [], [9999]);
    const checks = distributionRefusals(high).map(function (r) { return r.check; });
    expect(checks.indexOf("meanPlausibility")).not.toBe(-1);
  });

  it("stays silent for a cycle that emitted no wave values at all", function () {
    // That is a coverage failure and belongs to the floors; a mean over zero samples
    // is not a fact.
    expect(distributionRefusals(scanRecords([], [], [9999]))).toEqual([]);
  });

  it("passes a plausible distribution", function () {
    expect(distributionRefusals(cleanStats())).toEqual([]);
  });
});

describe("ttlSpellingRefusals", function () {
  function pair(overrides) {
    return Object.assign({ key: "waveinput:b-1", value: "{}",
      expiration: VALID_START + WAVE_KV_LEASE_SECONDS }, overrides || {});
  }

  it("passes correct epoch arithmetic and correctly spelled pairs", function () {
    expect(ttlSpellingRefusals({
      validStartEpoch: VALID_START,
      kvExpirationEpoch: VALID_START + WAVE_KV_LEASE_SECONDS,
      pairs: [pair()]
    })).toEqual([]);
  });

  it("refuses an expiration that is not validStartEpoch + 25200", function () {
    expect(ttlSpellingRefusals({
      validStartEpoch: VALID_START,
      kvExpirationEpoch: VALID_START + 3600,
      pairs: []
    }).length).toBe(1);
  });

  it("refuses the camelCase expirationTtl wrangler silently drops", function () {
    // wrangler warns and exits 0 on an unexpected property, so the key would never
    // expire and would color flags from dead data indefinitely.
    const bad = pair();
    delete bad.expiration;
    bad.expirationTtl = 25200;
    const refusals = ttlSpellingRefusals({
      validStartEpoch: VALID_START,
      kvExpirationEpoch: VALID_START + WAVE_KV_LEASE_SECONDS,
      pairs: [bad]
    });
    expect(refusals.length).toBe(2);
    for (let i = 0; i < refusals.length; i = i + 1) {
      expect(refusals[i].overridable).toBe(false);
    }
  });

  it("refuses a nested-object value", function () {
    expect(ttlSpellingRefusals({
      validStartEpoch: VALID_START,
      kvExpirationEpoch: VALID_START + WAVE_KV_LEASE_SECONDS,
      pairs: [pair({ value: { beachId: "b-1" } })]
    }).length).toBe(1);
  });

  it("accepts only the documented pair fields", function () {
    expect(ALLOWED_PAIR_FIELDS).toEqual([
      "key", "value", "expiration", "expiration_ttl", "base64", "metadata"]);
  });
});

// --- coverage ----------------------------------------------------------------------------

describe("floorsEntryFor", function () {
  const floors = { floors: {} };
  floors.floors[DIGEST] = { status: "seeded", waveinputRecords: 100, wavesRecords: 90,
    grids: { noaa_gfswave: 80 } };

  it("resolves a seeded entry and allows auto-publish", function () {
    const result = floorsEntryFor(floors, DIGEST);
    expect(result.status).toBe("seeded");
    expect(result.autoPublishAllowed).toBe(true);
    expect(result.reason).toBe(null);
  });

  it("withholds auto-publish for an unseeded digest without failing", function () {
    const result = floorsEntryFor(floors, "sha256:" + "f".repeat(64));
    expect(result.entry).toBe(null);
    expect(result.autoPublishAllowed).toBe(false);
    expect(result.reason).not.toBe(null);
  });

  it("withholds auto-publish for a bootstrap entry", function () {
    const doc = { floors: {} };
    doc.floors[DIGEST] = { status: "bootstrap", waveinputRecords: null };
    expect(floorsEntryFor(doc, DIGEST).autoPublishAllowed).toBe(false);
  });
});

describe("the overridable coverage gates", function () {
  const entry = { waveinputRecords: 100, wavesRecords: 90, grids: { noaa_gfswave: 80 } };

  it("refuses below a seeded floor, overridably", function () {
    const refusals = coverageFloorRefusals(
      { waveinputRecords: 99, wavesRecords: 90 }, entry);
    expect(refusals.length).toBe(1);
    expect(refusals[0].overridable).toBe(true);
  });

  it("skips a null floor rather than treating it as zero", function () {
    expect(coverageFloorRefusals({ waveinputRecords: 1, wavesRecords: 1 },
      { waveinputRecords: null, wavesRecords: null })).toEqual([]);
  });

  it("refuses below a per-grid floor for a SAMPLED grid, overridably", function () {
    const refusals = perGridFloorRefusals(
      gridStats({ resolvedBeaches: 10 }), entry, gridStatus());
    expect(refusals.length).toBe(1);
    expect(refusals[0].overridable).toBe(true);
  });

  it("does not score a per-grid floor for a grid that never sampled", function () {
    // sampleReport.grids carries only grids that sampled, so an absent grid would
    // otherwise read as a resolvedBeaches of zero — which is what refuses the whole
    // cycle, ocean included, when one regional upstream is out.
    const statuses = ["unfetched", "unplanned"];
    for (let i = 0; i < statuses.length; i = i + 1) {
      const status = gridStatus();
      status.noaa_gfswave = { status: statuses[i], elements: [], reasons: ["down"] };
      expect(perGridFloorRefusals({}, entry, status)).toEqual([]);
      const reported = perGridFloorStatus(entry, status);
      expect(reported.grids.noaa_gfswave).toBe("not evaluated");
      expect(reported.warnings.length).toBe(1);
    }
  });

  it("evaluates nothing and warns when gridStatus is absent or malformed", function () {
    // Fail toward not-a-measurement, never toward a phantom zero.
    const cases = [undefined, null, [], { noaa_gfswave: "sampled" }];
    for (let i = 0; i < cases.length; i = i + 1) {
      expect(perGridFloorRefusals(gridStats({ resolvedBeaches: 0 }), entry, cases[i]))
        .toEqual([]);
      expect(perGridFloorStatus(entry, cases[i]).warnings.length).toBe(1);
    }
  });

  it("refuses a grid that claims to have sampled but carries no count", function () {
    // "sampled" with no stats entry is an inconsistent report, and inventing the
    // number the floor would be scored on is the phantom zero all over again.
    const refusals = perGridFloorRefusals({ noaa_gfswave: {} }, entry, gridStatus());
    expect(refusals.length).toBe(1);
    expect(refusals[0].message.indexOf("no resolvedBeaches count")).not.toBe(-1);
  });

  it("publishes a seeded floor as its number only when it was scored", function () {
    expect(perGridFloorStatus(entry, gridStatus()).grids.noaa_gfswave).toBe(80);
    expect(perGridFloorStatus({ grids: { noaa_gfswave: null } }, gridStatus())
      .grids.noaa_gfswave).toBe(null);
  });

  it("refuses a shrink against the previous cycle, overridably", function () {
    const refusals = shrinkRatioRefusals(
      { waveinputRecords: 900, wavesRecords: 900 },
      { waveinputRecords: 1000, wavesRecords: 900 });
    expect(refusals.length).toBe(1);
    expect(refusals[0].overridable).toBe(true);
    expect(WAVE_SHRINK_MIN_RATIO).toBe(0.95);
  });

  it("catches a slow bleed that every ratio-to-previous check would pass", function () {
    // 1000 -> 950 -> 902 -> ... : each step clears 0.95x forever, and only the
    // comparison against the OLDEST retained cycle can see the cumulative loss.
    expect(shrinkRatioRefusals({ waveinputRecords: 840, wavesRecords: 840 },
      { waveinputRecords: 860, wavesRecords: 860 })).toEqual([]);
    const decayed = decayRefusals({ waveinputRecords: 840, wavesRecords: 840 },
      { waveinputRecords: 1000, wavesRecords: 1000 });
    expect(decayed.length).toBe(2);
    expect(decayed[0].overridable).toBe(true);
    expect(WAVE_DECAY_MIN_RATIO).toBe(0.85);
  });
});

// The gates that stop one grid's outage from refusing the whole cycle. A global
// ratio is satisfiable by one grid collapsing while another grows, and a grid absent
// from this cycle scored as a zero refuses for the grids that DID sample.
describe("the per-grid ratio gates", function () {
  function counts(overrides) {
    return Object.assign({
      noaa_gfswave: { waveinputRecords: 900, wavesRecords: 900, validPercent: 42 },
      noaa_glwu: { waveinputRecords: 500, wavesRecords: 500, validPercent: 8 }
    }, overrides || {});
  }

  it("refuses a per-grid shrink the global sum would hide", function () {
    // The global sum is 1400 against 1400 — no shrink at all — while GLWU lost 60%.
    const previous = { noaa_gfswave: { waveinputRecords: 200, wavesRecords: 200 },
      noaa_glwu: { waveinputRecords: 1200, wavesRecords: 1200 } };
    const result = perGridShrinkRefusals(counts(), previous, gridStatus());
    expect(result.refusals.length).toBe(2);
    expect(result.refusals[0].check).toBe("shrinkRatio");
    expect(result.refusals[0].overridable).toBe(true);
    expect(shrinkRatioRefusals({ waveinputRecords: 1400, wavesRecords: 1400 },
      { waveinputRecords: 1400, wavesRecords: 1400 })).toEqual([]);
  });

  it("skips and warns for a grid that did not sample this cycle", function () {
    const status = gridStatus({ noaa_glwu: outGrid("NOMADS 503") });
    const result = perGridShrinkRefusals(
      { noaa_gfswave: { waveinputRecords: 900, wavesRecords: 900, validPercent: 42 } },
      counts(), status);
    expect(result.refusals).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].indexOf("noaa_glwu")).not.toBe(-1);
    // The grid that DID sample was scored on all three fields.
    expect(result.compared).toBe(3);
  });

  it("skips and warns for a grid absent from the other side", function () {
    const result = perGridShrinkRefusals(counts(),
      { noaa_gfswave: { waveinputRecords: 900, wavesRecords: 900, validPercent: 42 } },
      gridStatus());
    expect(result.refusals).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].indexOf("noaa_glwu")).not.toBe(-1);
  });

  it("skips a non-positive count on the other side, which cannot be a ratio", function () {
    const result = perGridShrinkRefusals(
      { noaa_gfswave: { waveinputRecords: 0, wavesRecords: 0, validPercent: 0 } },
      { noaa_gfswave: { waveinputRecords: 0, wavesRecords: 0, validPercent: 0 } },
      gridStatus());
    expect(result.refusals).toEqual([]);
    expect(result.warnings.length).toBe(3);
    expect(result.compared).toBe(0);
  });

  it("refuses a validPercent collapse the record counts hold through", function () {
    // The dangerous shape is PARTIAL corruption: the wet fraction falls from 70 to 3
    // while beaches still resolve through longer spiral rings and every count floor
    // holds, so no record-count rail moves at all.
    const previous = { noaa_gfswave: { waveinputRecords: 900, wavesRecords: 900,
      validPercent: 70 } };
    const collapsed = perGridShrinkRefusals(
      { noaa_gfswave: { waveinputRecords: 900, wavesRecords: 900, validPercent: 3 } },
      previous, gridStatus());
    expect(collapsed.refusals.length).toBe(1);
    expect(collapsed.refusals[0].subject).toBe("noaa_gfswave validPercent");
    // Overridable like every other count gate: it is less coverage, not a wrong number.
    expect(collapsed.refusals[0].overridable).toBe(true);
    const steady = perGridShrinkRefusals(
      { noaa_gfswave: { waveinputRecords: 900, wavesRecords: 900, validPercent: 68 } },
      previous, gridStatus());
    expect(steady.refusals).toEqual([]);
    expect(steady.compared).toBe(3);
  });

  it("warns rather than refuses against a manifest written before validPercent",
    function () {
      const result = perGridShrinkRefusals(
        { noaa_gfswave: { waveinputRecords: 900, wavesRecords: 900, validPercent: 3 } },
        { noaa_gfswave: { waveinputRecords: 900, wavesRecords: 900 } }, gridStatus());
      expect(result.refusals).toEqual([]);
      expect(result.compared).toBe(2);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toBe("shrinkRatio: noaa_gfswave validPercent is not a " +
        "positive value in the previous cycle, so it was not compared");
    });

  it("catches a per-grid slow bleed against the oldest retained cycle", function () {
    const current = { noaa_gfswave: { waveinputRecords: 840, wavesRecords: 840 } };
    expect(perGridShrinkRefusals(current,
      { noaa_gfswave: { waveinputRecords: 860, wavesRecords: 860 } },
      gridStatus()).refusals).toEqual([]);
    const decayed = perGridDecayRefusals(current,
      { noaa_gfswave: { waveinputRecords: 1000, wavesRecords: 1000 } }, gridStatus());
    expect(decayed.refusals.length).toBe(2);
    expect(decayed.refusals[0].check).toBe("decay");
  });
});

describe("per-grid history", function () {
  it("lifts per-grid counts off a manifest's grids array", function () {
    const counts = gridCountsFromManifest({ grids: [
      { id: "noaa_gfswave", waveinputRecords: 900, wavesRecords: 880 },
      { id: "noaa_glwu", waveinputRecords: 500, wavesRecords: 500 }
    ] });
    expect(counts.noaa_gfswave)
      .toEqual({ waveinputRecords: 900, wavesRecords: 880, validPercent: null });
    expect(hasGridCounts(counts)).toBe(true);
  });

  it("carries validPercent forward so the next cycle can score its collapse",
    function () {
      const counts = gridCountsFromManifest({ grids: [
        { id: "noaa_gfswave", waveinputRecords: 900, wavesRecords: 900, validPercent: 70 }
      ] });
      expect(counts.noaa_gfswave.validPercent).toBe(70);
    });

  it("yields no per-grid counts for an old-shape manifest", function () {
    expect(gridCountsFromManifest({ grids: [{ id: "noaa_gfswave" }] })).toEqual({});
    expect(hasGridCounts(gridCountsFromManifest(null))).toBe(false);
  });

  it("carries the per-grid counts forward in the history entry", function () {
    const entry = historyEntryFor({ cycleId: "c-1",
      beaches: { waveinputRecords: 1400, wavesRecords: 1400 },
      grids: [{ id: "noaa_gfswave", waveinputRecords: 900, wavesRecords: 900 }] });
    expect(entry.grids.noaa_gfswave.waveinputRecords).toBe(900);
  });
});

describe("the minimum record rails", function () {
  const beaches = { total: 1600, resolved: 1200 };

  it("passes a cycle with beaches, wave values and every required grid sampled",
    function () {
      expect(minimumRecordRefusals(cleanStats(), beaches, gridStats(), gridStatus()))
        .toEqual([]);
    });

  it("refuses each rail independently and never overridably", function () {
    const cases = [
      { name: "an absent beach total", args: [cleanStats(), {}, gridStats(), gridStatus()] },
      { name: "a zero beach total",
        args: [cleanStats(), { total: 0 }, gridStats(), gridStatus()] },
      { name: "no wave value anywhere",
        args: [scanRecords([], [], [9999]), beaches, gridStats(), gridStatus()] },
      { name: "a required grid that never sampled",
        args: [cleanStats(), beaches, {},
          gridStatus({ noaa_gfswave: outGrid("AWS 403") })] },
      { name: "a required grid absent from gridStatus entirely",
        args: [cleanStats(), beaches, gridStats(), {}] },
      { name: "a required grid that resolved nothing",
        args: [cleanStats(), beaches, gridStats({ resolvedBeaches: 0 }), gridStatus()] }
    ];
    for (let i = 0; i < cases.length; i = i + 1) {
      const refusals = minimumRecordRefusals.apply(null, cases[i].args);
      expect(refusals.length).toBeGreaterThan(0);
      for (let r = 0; r < refusals.length; r = r + 1) {
        expect(refusals[r].overridable).toBe(false);
        expect(refusals[r].check).toBe("minimumRecords");
      }
    }
  });

  it("refuses a SAMPLED grid whose hour-0 wave plane is entirely nodata", function () {
    // validPercent was computed, published and gated by nothing; an all-nodata grid
    // reported 0.00 and was caught only by the overridable ratio rails.
    const refusals = minimumRecordRefusals(cleanStats(), beaches,
      gridStats({ validPercent: 0 }), gridStatus());
    expect(refusals.length).toBe(1);
    expect(refusals[0].message).toBe("minimumRecords: noaa_gfswave: validPercent is " +
      "0.00 — every cell of its hour-0 wave plane is nodata");
    expect(refusals[0].overridable).toBe(false);
  });

  it("passes at any positive validPercent and refuses an absent one", function () {
    expect(minimumRecordRefusals(cleanStats(), beaches,
      gridStats({ validPercent: 0.01 }), gridStatus())).toEqual([]);
    const absent = gridStats();
    delete absent.noaa_gfswave.validPercent;
    expect(minimumRecordRefusals(cleanStats(), beaches, absent, gridStatus()).length).toBe(1);
  });

  it("never scores validPercent for a grid that did not sample", function () {
    // A grid that never ran has no plane to measure, and refusing on its behalf is
    // the whole-cycle refusal the per-grid scoping exists to remove.
    const refusals = minimumRecordRefusals(cleanStats(), beaches,
      gridStats({ validPercent: 0 }), gridStatus({ noaa_gfswave: outGrid("AWS 403") }));
    expect(refusals.length).toBe(1);
    expect(refusals[0].message.indexOf("validPercent")).toBe(-1);
  });

  it("reads REQUIRED_GRID_IDS rather than a re-spelled literal", function () {
    expect(REQUIRED_GRID_IDS).toEqual(["noaa_gfswave"]);
  });

  it("warns rather than refuses for a NON-required grid that resolved nothing",
    function () {
      // Refusing on its behalf would recreate the whole-cycle refusal this scoping
      // exists to remove; it contributes zero records either way.
      const stats = gridStats();
      stats.noaa_glwu = { assignedBeaches: 80, resolvedBeaches: 0,
        waveinputRecords: 0, wavesRecords: 0, validPercent: 12,
        identityPlanes: FORECAST_HOURS + 1, identityMismatches: [] };
      expect(minimumRecordRefusals(cleanStats(), beaches, stats, gridStatus()))
        .toEqual([]);
      const warnings = zeroResolutionWarnings(stats, gridStatus());
      expect(warnings.length).toBe(1);
      expect(warnings[0].indexOf("noaa_glwu")).not.toBe(-1);
    });
});

// --- history ---------------------------------------------------------------------------

describe("history", function () {
  function manifestAt(n) {
    return {
      cycleId: "c-" + String(n),
      validStartIso: "2026-09-03T12:00:00.000Z",
      beaches: { waveinputRecords: n, wavesRecords: n },
      history: []
    };
  }

  it("appends the previous manifest's own entry, newest last", function () {
    const history = buildHistory(manifestAt(5), HISTORY_RETAIN);
    expect(history.length).toBe(1);
    expect(history[0].cycleId).toBe("c-5");
  });

  it("retains a fixed window and keeps the oldest at index 0", function () {
    let previous = null;
    for (let i = 0; i < 12; i = i + 1) {
      const manifest = manifestAt(i);
      manifest.history = buildHistory(previous, HISTORY_RETAIN);
      previous = manifest;
    }
    const history = buildHistory(previous, HISTORY_RETAIN);
    expect(history.length).toBe(HISTORY_RETAIN);
    expect(oldestRetained(history).cycleId).toBe("c-" + String(11 - HISTORY_RETAIN + 1));
  });

  it("returns null for an absent previous manifest and an empty history", function () {
    expect(historyEntryFor(null)).toBe(null);
    expect(buildHistory(null, HISTORY_RETAIN)).toEqual([]);
    expect(oldestRetained([])).toBe(null);
  });
});

// --- the verdict --------------------------------------------------------------------------

describe("evaluateWaveGates", function () {
  function input(overrides) {
    const inputs = waveinputRecords(40);
    const floors = { floors: {} };
    floors.floors[DIGEST] = { status: "seeded", waveinputRecords: 10, wavesRecords: 10,
      grids: { noaa_gfswave: 10 } };
    return Object.assign({
      gridStats: gridStats(),
      gridStatus: gridStatus(),
      sampleBeaches: { total: 1600, resolved: 1200 },
      expectDoc: expectDoc(),
      bands: bands(),
      expectedElements: ["HTSGW", "WIND"],
      validStartEpoch: VALID_START,
      kvExpirationEpoch: VALID_START + WAVE_KV_LEASE_SECONDS,
      stats: scanRecords(inputs, wavesRecords(inputs), [9999]),
      counts: { waveinputRecords: 40, wavesRecords: 40 },
      floorsFile: floors,
      gridsDigest: DIGEST,
      previousManifest: { cycleId: "c-prev", beaches: {} },
      previousCounts: { waveinputRecords: 40, wavesRecords: 40 },
      previousGridCounts: { noaa_gfswave: { waveinputRecords: 90, wavesRecords: 90 } },
      oldest: { waveinputRecords: 40, wavesRecords: 40 },
      oldestGridCounts: { noaa_gfswave: { waveinputRecords: 90, wavesRecords: 90 } },
      allowShrink: false
    }, overrides || {});
  }

  it("passes a clean cycle and allows auto-publish", function () {
    const verdict = evaluateWaveGates(input());
    expect(verdict.refusals).toEqual([]);
    expect(verdict.sanity.passed).toBe(true);
    expect(verdict.sanity.autoPublishAllowed).toBe(true);
    expect(verdict.sanity.overridden).toBe(false);
  });

  it("computes autoPublishAllowed as passed && floorsSeeded && !bootstrap", function () {
    expect(evaluateWaveGates(input({ previousManifest: null })).sanity.autoPublishAllowed)
      .toBe(false);
    expect(evaluateWaveGates(input({ gridsDigest: "sha256:" + "9".repeat(64) }))
      .sanity.autoPublishAllowed).toBe(false);
    const failing = input({ gridStats: gridStats({ identity: { width: 99 } }) });
    expect(evaluateWaveGates(failing).sanity.autoPublishAllowed).toBe(false);
    expect(evaluateWaveGates(failing).sanity.passed).toBe(false);
  });

  it("withholds auto-publish for an unseeded digest WITHOUT failing the build",
    function () {
      const verdict = evaluateWaveGates(input({ gridsDigest: "sha256:" + "9".repeat(64) }));
      expect(verdict.refusals).toEqual([]);
      expect(verdict.sanity.passed).toBe(true);
      expect(verdict.sanity.autoPublishAllowed).toBe(false);
      expect(verdict.warnings.length).toBeGreaterThan(0);
    });

  it("skips the ratio gates on a bootstrap cycle", function () {
    // Coverage floors still apply on a bootstrap cycle; only the RATIO gates, which
    // have nothing to compare against, are skipped.
    const verdict = evaluateWaveGates(input({
      previousManifest: null,
      counts: { waveinputRecords: 10, wavesRecords: 10 }
    }));
    expect(verdict.bootstrap).toBe(true);
    expect(verdict.refusals).toEqual([]);
  });

  it("--allow-shrink demotes a coverage refusal and stamps overridden", function () {
    const floors = { floors: {} };
    floors.floors[DIGEST] = { status: "seeded", waveinputRecords: 1000,
      wavesRecords: 1000, grids: { noaa_gfswave: 10 } };
    const verdict = evaluateWaveGates(input({ floorsFile: floors, allowShrink: true }));
    expect(verdict.refusals).toEqual([]);
    expect(verdict.sanity.overridden).toBe(true);
    expect(verdict.sanity.coverageFloorsPassed).toBe(true);
  });

  it("--allow-shrink CANNOT demote sentinelScan, gridIdentity, bandIdentity, " +
    "validTimes, distinctValues or the validPercent rail", function () {
    const constant = waveinputRecords(40, { waveHeightFt: 1.5 });
    const cases = [
      { name: "sentinelScan",
        patch: { stats: scanRecords(waveinputRecords(40, { waveHeightFt: 9999 }), [], [9999]) } },
      { name: "gridIdentity", patch: { gridStats: gridStats({ identity: { width: 99 } }) } },
      // A later plane whose raster moved, and a producer that compared no planes at
      // all, are both identity failures no operator flag may wave through.
      { name: "gridIdentity", patch: { gridStats: gridStats({
        identityMismatches: ["noaa_gfswave-h07-HTSGW: originLon is -179.75, expected -5"] }) } },
      { name: "gridIdentity", patch: { gridStats: gridStats({ identityPlanes: 0 }) } },
      { name: "bandIdentity",
        patch: { bands: bands({ index: 0, patch: { element: "PERPW" } }) } },
      { name: "validTimes",
        patch: { bands: bands({ index: 2, patch: { validTime: 1 } }) } },
      { name: "distinctValues",
        patch: { stats: scanRecords(constant, [], [9999]) } },
      { name: "minimumRecords", patch: { gridStats: gridStats({ validPercent: 0 }) } }
    ];
    for (let i = 0; i < cases.length; i = i + 1) {
      const verdict = evaluateWaveGates(input(
        Object.assign({ allowShrink: true }, cases[i].patch)));
      const checks = verdict.refusals.map(function (r) { return r.check; });
      expect(checks.indexOf(cases[i].name)).not.toBe(-1);
      expect(verdict.sanity.passed).toBe(false);
    }
  });

  // The defect this whole package exists to fix: one regional grid's upstream being
  // out must cost that grid's beaches their records and nothing else.
  it("publishes for the grids that sampled when a NON-required grid is out",
    function () {
      const floors = { floors: {} };
      floors.floors[DIGEST] = { status: "seeded", waveinputRecords: 10, wavesRecords: 10,
        grids: { noaa_gfswave: 10, noaa_glwu: 400 } };
      const verdict = evaluateWaveGates(input({
        floorsFile: floors,
        gridStatus: gridStatus({ noaa_glwu: outGrid("NOMADS 503") })
      }));
      expect(verdict.refusals).toEqual([]);
      expect(verdict.sanity.passed).toBe(true);
      expect(verdict.sanity.everyGridSampled).toBe(false);
      // The seeded GLWU floor is reported as unscored, never as a pass.
      expect(verdict.sanity.floors.grids.noaa_glwu).toBe("not evaluated");
      expect(verdict.sanity.floors.grids.noaa_gfswave).toBe(10);
    });

  it("skips the GLOBAL coverage floor while any grid is missing", function () {
    // A floor seeded from a complete cycle measures nothing about a cycle missing a
    // grid; the non-overridable minimum record rails stand in its place.
    const floors = { floors: {} };
    floors.floors[DIGEST] = { status: "seeded", waveinputRecords: 1000,
      wavesRecords: 1000, grids: { noaa_gfswave: 10 } };
    expect(evaluateWaveGates(input({ floorsFile: floors })).refusals.length).toBe(2);
    const degraded = evaluateWaveGates(input({
      floorsFile: floors,
      gridStatus: gridStatus({ noaa_glwu: outGrid("NOMADS 503") })
    }));
    expect(degraded.refusals).toEqual([]);
    expect(degraded.warnings.join(" ").indexOf("noaa_glwu")).not.toBe(-1);
  });

  it("keeps the global ratio fallback only for an old-shape previous manifest",
    function () {
      // With no per-grid history and every grid sampled, the globals still apply, so
      // the cycle after this shape change is not left with no ratio coverage at all.
      const shrunk = { previousGridCounts: {}, oldestGridCounts: {},
        counts: { waveinputRecords: 10, wavesRecords: 10 } };
      const fallback = evaluateWaveGates(input(shrunk));
      const checks = fallback.refusals.map(function (r) { return r.check; });
      expect(checks.indexOf("shrinkRatio")).not.toBe(-1);
      // The same cycle with a grid missing scores no global ratio at all: an absent
      // grid must never be measured as a shrink to zero.
      const missing = evaluateWaveGates(input(Object.assign({
        gridStatus: gridStatus({ noaa_glwu: outGrid("NOMADS 503") })
      }, shrunk)));
      expect(missing.refusals).toEqual([]);
    });

  it("withholds auto-publish when NO ratio comparison was scored at all", function () {
    // The one-cycle blind spot: a previous manifest with no per-grid counts retires
    // nothing on its own, but with a grid also missing this cycle the global fallback
    // is skipped by everyGridSampled and every per-grid comparison skips for want of
    // a previous entry. A refusal here would be a false alarm on behalf of a grid
    // that never ran, so the response is to make a human read the manifest.
    const verdict = evaluateWaveGates(input({
      previousGridCounts: {},
      oldestGridCounts: {},
      gridStatus: gridStatus({ noaa_glwu: outGrid("NOMADS 503") })
    }));
    expect(verdict.refusals).toEqual([]);
    expect(verdict.sanity.passed).toBe(true);
    expect(verdict.sanity.shrinkRatiosCompared).toBe(0);
    expect(verdict.sanity.autoPublishAllowed).toBe(false);
    expect(verdict.warnings.join(" ").indexOf("no ratio check was scored")).not.toBe(-1);
  });

  it("keeps auto-publish on a cycle whose per-grid ratios WERE scored", function () {
    // The other half of the rail: shrinkRatiosPassed reads true on zero comparisons,
    // so the count is what separates a scored cycle from an unscored one.
    const verdict = evaluateWaveGates(input());
    expect(verdict.sanity.shrinkRatiosCompared).toBeGreaterThan(0);
    expect(verdict.sanity.autoPublishAllowed).toBe(true);
    expect(verdict.warnings.join(" ").indexOf("no ratio check was scored")).toBe(-1);
  });

  it("refuses a per-grid shrink even while the global counts hold steady", function () {
    const verdict = evaluateWaveGates(input({
      previousGridCounts: { noaa_gfswave: { waveinputRecords: 900, wavesRecords: 900 } }
    }));
    const checks = verdict.refusals.map(function (r) { return r.check; });
    expect(checks.indexOf("shrinkRatio")).not.toBe(-1);
    expect(verdict.sanity.shrinkRatiosPassed).toBe(false);
  });

  it("refuses a zero-record cycle that every other gate passes", function () {
    // Bootstrap floors, no previous manifest: distributionRefusals returns early,
    // the floors are null and the ratios are skipped. Publishing it would also
    // POISON every future shrink ratio, which skips a field whose previous count
    // is <= 0.
    const bootstrapFloors = { floors: {} };
    bootstrapFloors.floors[DIGEST] = { status: "bootstrap", waveinputRecords: null,
      wavesRecords: null, grids: { noaa_gfswave: null } };
    const verdict = evaluateWaveGates(input({
      floorsFile: bootstrapFloors,
      previousManifest: null,
      stats: scanRecords([], [], [9999]),
      counts: { waveinputRecords: 0, wavesRecords: 0 },
      gridStats: gridStats({ resolvedBeaches: 0, waveinputRecords: 0, wavesRecords: 0 })
    }));
    expect(verdict.sanity.passed).toBe(false);
    expect(verdict.sanity.minimumRecordsPassed).toBe(false);
    const checks = verdict.refusals.map(function (r) { return r.check; });
    expect(checks.indexOf("minimumRecords")).not.toBe(-1);
  });

  it("--allow-shrink CANNOT demote the minimum record rails", function () {
    const verdict = evaluateWaveGates(input({
      allowShrink: true,
      stats: scanRecords([], [], [9999]),
      sampleBeaches: {},
      gridStatus: gridStatus({ noaa_gfswave: outGrid("AWS 403") })
    }));
    expect(verdict.sanity.minimumRecordsPassed).toBe(false);
    expect(verdict.sanity.passed).toBe(false);
    const checks = verdict.refusals.map(function (r) { return r.check; });
    expect(checks.indexOf("minimumRecords")).not.toBe(-1);
  });
});

// --- artifacts and provenance -------------------------------------------------------------

describe("sha256SumsText", function () {
  it("covers the two NDJSON artifacts and nothing else", function () {
    // manifest.json must stay OUTSIDE its own checksum scope: it is the sole input
    // to the consumer gate and is read back and byte-compared on its own.
    const text = sha256SumsText([
      { key: "waves.ndjson", sha256: "b".repeat(64) },
      { key: "manifest.json", sha256: "c".repeat(64) },
      { key: "waveinput.ndjson", sha256: "a".repeat(64) }
    ]);
    expect(text).toBe("a".repeat(64) + "  waveinput.ndjson\n" +
      "b".repeat(64) + "  waves.ndjson\n");
  });
});

describe("parseNdjson", function () {
  it("parses one record per non-blank line", function () {
    expect(parseNdjson("{\"a\":1}\n\n{\"a\":2}\n", "test")).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("throws on a torn line rather than returning a shorter record list", function () {
    // A shorter list would be measured by every count gate as a legitimate shrink.
    expect(function () { parseNdjson("{\"a\":1}\n{\"a\":", "test"); }).toThrow();
  });
});

describe("sentinelValues / runnerImageOf", function () {
  it("carries each grid's nodata raw and in both converted forms", function () {
    // The mph form must come from the same constant the sampler applied, or
    // matchesNodata's relative tolerance stops matching it.
    expect(sentinelValues([{ sampled: { nodata: 9999 } }]))
      .toEqual([9999, 9999 * 3.28084, 9999 * METERS_PER_SECOND_TO_MPH]);
  });

  it("renders the runner image or null when the environment says nothing", function () {
    expect(runnerImageOf("ubuntu24", "20260901")).toBe("ubuntu24/20260901");
    expect(runnerImageOf(undefined, undefined)).toBe(null);
  });
});

describe("the manifest literal", function () {
  it("assigns buildStatus once, as the LAST key of the object", function () {
    // A torn write must not be able to produce a file that both parses and claims to
    // be complete, and src/waveManifest.js treats any other value as FATAL.
    const source = readFileSync(
      new URL("../scripts/build-wave-manifest.js", import.meta.url), "utf8");
    const assignments = source.split("buildStatus: \"complete\"").length - 1;
    expect(assignments).toBe(1);
    expect(source.indexOf("buildStatus: \"complete\"\n  };")).not.toBe(-1);
  });

  it("pins the emitted-value ceiling well above any real sea state", function () {
    expect(MAX_EMITTED_FT).toBe(100);
  });
});

// --- main ---------------------------------------------------------------------------------

// main() is exported purely so these three outcomes are reachable: every Deno call it
// makes already goes through the handle requireDeno returns, so an in-memory stub
// replaces the whole filesystem without touching the module's logic.
describe("main", function () {
  const SAMPLE_DIR = "/w/sample";
  const OUT = "/w/manifest.json";

  afterEach(function () {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function identity() {
    return { width: 10, height: 8, originLon: -5, originLat: 4,
      pixelLon: 0.5, pixelLat: -0.5, nodata: 9999 };
  }

  function sampleGrids(ids, overrides) {
    const out = {};
    for (let i = 0; i < ids.length; i = i + 1) {
      out[ids[i]] = Object.assign({
        assignedBeaches: 100, resolvedBeaches: 90,
        waveinputRecords: 40, wavesRecords: 40,
        validPercent: 42, ring0Fraction: 0.8, medianSearchKm: 3, maxSearchKm: 20,
        identity: identity(),
        identityPlanes: FORECAST_HOURS + 1,
        identityMismatches: []
      }, overrides || {});
    }
    return out;
  }

  function expectFor(ids) {
    const grids = {};
    for (let i = 0; i < ids.length; i = i + 1) {
      grids[ids[i]] = { sampled: identity() };
    }
    return { tolerance: { origin: 1e-9, pixel: 1e-12 }, bands: ["HTSGW", "WIND"],
      grids: grids };
  }

  function ndjson(records) {
    const lines = [];
    for (let i = 0; i < records.length; i = i + 1) {
      lines.push(JSON.stringify(records[i]));
    }
    return lines.join("\n") + "\n";
  }

  // One cycle on disk. sampledIds are the grids the sampler produced stats for;
  // statusOverrides is the NOMADS-outage shape.
  function files(options) {
    const opts = options || {};
    const sampledIds = opts.sampledIds || ["noaa_glwu", "noaa_gfswave", "noaa_gfswave_arctic"];
    const inputs = waveinputRecords(40);
    const store = {};
    store[SAMPLE_DIR + "/sample-report.json"] = JSON.stringify({
      generated: "2026-09-03T12:05:00.000Z",
      validStartIso: "2026-09-03T12:00:00.000Z",
      validStartEpoch: VALID_START,
      startIso: "2026-09-03T12:00:00.000Z",
      gridsComplete: true,
      gridStatus: gridStatus(opts.statusOverrides),
      beaches: { total: 1600, resolved: 1200, windOnly: 0, unresolved: 400,
        waveinputRecords: 40, wavesRecords: 40 },
      grids: sampleGrids(sampledIds, opts.gridOverrides),
      bands: bands()
    });
    store["/w/grids-report.json"] = JSON.stringify({
      grids: { noaa_gfswave: { source: "aws", cycleIso: "2026-09-03T06:00:00.000Z",
        forecastOffset: 6, files: [{ bytes: 10 }], totalBytes: 10 } },
      problems: []
    });
    store["/w/expect.json"] = JSON.stringify(expectFor(sampledIds));
    store["/w/floors.json"] = JSON.stringify({ floors: {} });
    store[SAMPLE_DIR + "/waveinput.ndjson"] = ndjson(inputs);
    store[SAMPLE_DIR + "/waves.ndjson"] = ndjson(wavesRecords(inputs));
    return store;
  }

  function stubDeno(store, argv) {
    const written = [];
    const renamed = [];
    const fs = Object.assign({}, store);
    vi.stubGlobal("Deno", {
      args: argv,
      readTextFile: function (path) {
        return fs[path] === undefined
          ? Promise.reject(new Error("no such file: " + path))
          : Promise.resolve(fs[path]);
      },
      readFile: function (path) {
        return fs[path] === undefined
          ? Promise.reject(new Error("no such file: " + path))
          : Promise.resolve(new TextEncoder().encode(fs[path]));
      },
      writeTextFile: function (path, text) {
        written.push(path);
        fs[path] = text;
        return Promise.resolve();
      },
      rename: function (from, to) {
        renamed.push(from + " -> " + to);
        fs[to] = fs[from];
        delete fs[from];
        return Promise.resolve();
      },
      env: { get: function () { return undefined; } }
    });
    return { written: written, renamed: renamed, fs: fs };
  }

  const ARGV = ["--sample", SAMPLE_DIR, "--grids-report", "/w/grids-report.json",
    "--expect", "/w/expect.json", "--floors", "/w/floors.json",
    "--cycle-id", "c-test", "--out", OUT];

  it("writes NOTHING when a gate refuses, so the pointer stays on the last good cycle",
    async function () {
      const io = stubDeno(files({ gridOverrides: { validPercent: 0 } }), ARGV);
      await expect(main()).rejects.toThrow(/refusing to publish/);
      expect(io.written).toEqual([]);
      expect(io.renamed).toEqual([]);
      expect(io.fs[OUT]).toBe(undefined);
    });

  it("writes the manifest and SHA256SUMS through a tmp file and a rename",
    async function () {
      // A reader that sees the final path must never see a half-written manifest:
      // src/waveManifest.js treats a buildStatus other than "complete" as FATAL.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-03T12:34:56.000Z"));
      const io = stubDeno(files(), ARGV);
      await main();
      expect(io.written).toEqual([OUT + ".tmp", SAMPLE_DIR + "/SHA256SUMS.tmp"]);
      expect(io.renamed).toEqual([OUT + ".tmp -> " + OUT,
        SAMPLE_DIR + "/SHA256SUMS.tmp -> " + SAMPLE_DIR + "/SHA256SUMS"]);
      const manifest = JSON.parse(io.fs[OUT]);
      expect(manifest.buildStatus).toBe("complete");
      expect(manifest.generated).toBe("2026-09-03T12:34:56.000Z");
      expect(manifest.gridsComplete).toBe(true);
      expect(manifest.cycleId).toBe("c-test");
    });

  it("reports gridsComplete false when a FETCHED grid contributed no records",
    async function () {
      // The two halves answer different questions: the sampler's own flag says every
      // grid was fetched, and everyGridSampled says every grid produced records. A
      // grid lost at plan time is fetch-complete and still contributed nothing, and
      // without the conjunction that cycle reaches src/waveManifest.js as tier "ok".
      const io = stubDeno(files({
        sampledIds: ["noaa_gfswave", "noaa_gfswave_arctic"],
        statusOverrides: { noaa_glwu: outGrid("planned but produced no sampled plane") }
      }), ARGV);
      await main();
      const manifest = JSON.parse(io.fs[OUT]);
      expect(manifest.sanity.everyGridSampled).toBe(false);
      expect(manifest.gridsComplete).toBe(false);
      expect(manifest.buildStatus).toBe("complete");
    });
});

// --- per-grid scoping ------------------------------------------------------
//
// Every floor, ratio and coverage gate downstream asks "did this grid sample?"
// through these four helpers. The failure they exist to stop is an absent grid
// scoring as a zero: a cycle that never fetched GLWU has no Great Lakes records,
// and a gate that reads that as a count of 0 against a seeded floor either
// refuses a healthy cycle or, worse, passes a cycle whose missing grid was
// silently treated as measured.

describe("gridIdsOf", function () {
  it("defaults to the committed GRIDS list when given a non-array", function () {
    const committed = gridIdsOf(GRIDS);
    expect(gridIdsOf(undefined)).toEqual(committed);
    expect(gridIdsOf(null)).toEqual(committed);
    expect(gridIdsOf("noaa_glwu")).toEqual(committed);
    for (let i = 0; i < REQUIRED_GRID_IDS.length; i = i + 1) {
      expect(committed).toContain(REQUIRED_GRID_IDS[i]);
    }
  });

  it("preserves the caller's order, since fallthrough order is the grid order", function () {
    const grids = [{ id: "b" }, { id: "a" }, { id: "c" }];
    expect(gridIdsOf(grids)).toEqual(["b", "a", "c"]);
  });
});

describe("gridStatusOf", function () {
  it("reads the recorded status string", function () {
    expect(gridStatusOf({ noaa_glwu: { status: "sampled" } }, "noaa_glwu")).toBe("sampled");
    expect(gridStatusOf({ noaa_glwu: { status: "skipped" } }, "noaa_glwu")).toBe("skipped");
  });

  it("answers \"absent\" for a missing or malformed entry, never a measurement", function () {
    // A missing entry means the producer said nothing, which is not the same as
    // a grid that reported zero.
    expect(gridStatusOf({}, "noaa_glwu")).toBe("absent");
    expect(gridStatusOf(null, "noaa_glwu")).toBe("absent");
    expect(gridStatusOf({ noaa_glwu: null }, "noaa_glwu")).toBe("absent");
    expect(gridStatusOf({ noaa_glwu: {} }, "noaa_glwu")).toBe("absent");
    expect(gridStatusOf({ noaa_glwu: { status: 1 } }, "noaa_glwu")).toBe("absent");
  });
});

describe("gridSampled", function () {
  it("is true only for the exact status \"sampled\"", function () {
    expect(gridSampled({ noaa_glwu: { status: "sampled" } }, "noaa_glwu")).toBe(true);
    expect(gridSampled({ noaa_glwu: { status: "empty" } }, "noaa_glwu")).toBe(false);
    expect(gridSampled({ noaa_glwu: { status: "failed" } }, "noaa_glwu")).toBe(false);
    expect(gridSampled({}, "noaa_glwu")).toBe(false);
  });
});

describe("notSampledGrids", function () {
  it("is empty when every grid sampled", function () {
    const status = {};
    const ids = gridIdsOf(GRIDS);
    for (let i = 0; i < ids.length; i = i + 1) {
      status[ids[i]] = { status: "sampled" };
    }
    expect(notSampledGrids(status, GRIDS)).toEqual([]);
  });

  it("names each unsampled grid with the status that explains it", function () {
    const status = { noaa_glwu: { status: "failed" }, noaa_gfswave: { status: "sampled" } };
    const out = notSampledGrids(status, [
      { id: "noaa_glwu" }, { id: "noaa_gfswave" }, { id: "noaa_gfswave_arctic" }
    ]);
    expect(out).toEqual(["noaa_glwu (failed)", "noaa_gfswave_arctic (absent)"]);
  });
});
