// THE WRITER CONTRACT for the NOAA GRIB2 wave pipeline: the record shapes the Worker
// reads, the two unit conversions, and the KV pair spelling.
//
// This is the most important file in the pipeline. Every failure it guards is
// SILENT in production:
//
//   * Handing src/rules.js METRES makes every sea state below 1.22 m read under 2 ft
//     — a permanent green across the whole site, with no error anywhere. The
//     "1 m -> 3.28084 ft" exactness pin is this repo's only assertion on that path.
//   * Handing src/rules.js METRES PER SECOND makes an actual 25 mph arrive as 11, so
//     every wind reads green. No other test covers that conversion.
//   * A camelCase expirationTtl is accepted by wrangler as an unexpected property,
//     WARNED about, and IGNORED, with exit 0 — writing a key that NEVER EXPIRES.
//     runFlagRecompute never reads waveinput.updated, so expiration is the only
//     staleness control on the color path.
//   * hoursFt[0] drifting from waveinput.waveHeightFt makes the detail page's "now"
//     stat contradict its own first bar.

import { describe, it, expect } from "vitest";
import { metersToFeet } from "../src/geo.js";
import { metersPerSecondToMph } from "../src/waveGrids.js";
import {
  WAVE_KV_LEASE_SECONDS,
  classifyWaveManifestFailure,
  waveKvWriteAllowed
} from "../src/waveManifest.js";
import { waveRecordsForBeach } from "../scripts/sample-waves.js";
import {
  MAX_PAIRS_PER_CHUNK,
  parseWavePointer,
  verifyArtifact,
  manifestArtifact,
  buildConsumerReport,
  kvPairGroups,
  chunkGroups,
  chunkFileName
} from "../scripts/build-wave-kv.js";

const VALID_START_EPOCH = 1788415200;
const START_ISO = new Date(VALID_START_EPOCH * 1000).toISOString();

function meters(value) {
  const out = [];
  for (let i = 0; i < 24; i = i + 1) {
    out.push(value === null ? null : value + i * 0.01);
  }
  return out;
}

function recordsFor(overrides) {
  return waveRecordsForBeach(Object.assign({
    beachId: "b-1",
    gridId: "noaa_gfswave",
    label: "NOAA GFS Wave Model",
    infoUrl: "https://polar.ncep.noaa.gov/waves/",
    startIso: START_ISO,
    updated: START_ISO,
    waveMeters: meters(1),
    windMs: null
  }, overrides || {}));
}

describe("the unit conversions", function () {
  it("converts meters -> feet exactly (1 m -> 3.28084 ft)", function () {
    expect(metersToFeet(1)).toBe(3.28084);
    expect(recordsFor().waveinput.waveHeightFt).toBe(3.28084);
  });

  it("converts m/s -> mph exactly (1 m/s -> 2.2369362920544 mph)", function () {
    expect(metersPerSecondToMph(1)).toBe(2.2369362920544);
    const out = recordsFor({ waveMeters: null, windMs: 1 });
    expect(out.waveinput.windSpeedMph).toBe(2.2369362920544);
  });

  it("keeps a 25 mph wind reading as 25 mph, not as 11", function () {
    // 11.176 m/s IS 25 mph. Passed through unconverted it would read 11 and every
    // wind threshold in src/rules.js (15/25 yellow, 25/35 red) would stay green.
    const out = recordsFor({ waveMeters: null, windMs: 11.176 });
    expect(out.waveinput.windSpeedMph).toBeCloseTo(25, 6);
  });
});

describe("waveRecordsForBeach", function () {
  it("emits a waveinput with exactly the six contracted fields", function () {
    const out = recordsFor();
    expect(Object.keys(out.waveinput).sort()).toEqual([
      "beachId", "model", "updated", "waveHeightFt", "windGustMph", "windSpeedMph"
    ]);
    expect(out.waveinput.model).toBe("noaa_gfswave");
    expect(out.waveinput.updated).toBe(START_ISO);
  });

  it("always leaves windGustMph null (gfswave publishes no GUST element)", function () {
    expect(recordsFor().waveinput.windGustMph).toBe(null);
    expect(recordsFor({ waveMeters: null, windMs: 8 }).waveinput.windGustMph).toBe(null);
  });

  it("records the wind ONLY for a wave-null beach", function () {
    // The Worker pushes its "Wind Forecast" source exactly when waveHeightFt is null,
    // so recording a wind alongside a wave height would attribute a source that is
    // not in play.
    expect(recordsFor({ windMs: 8 }).waveinput.windSpeedMph).toBe(null);
    expect(recordsFor({ waveMeters: null, windMs: 8 }).waveinput.windSpeedMph)
      .toBeCloseTo(metersPerSecondToMph(8), 12);
  });

  it("emits hoursFt of exactly 24 entries", function () {
    // src/frontend/waveStrip.js drops the whole strip for any other length.
    expect(recordsFor().waves.hoursFt.length).toBe(24);
  });

  it("keeps hoursFt[0] bit-for-bit equal to waveinput.waveHeightFt", function () {
    const out = recordsFor({ waveMeters: meters(1.7345) });
    expect(out.waves.hoursFt[0]).toBe(out.waveinput.waveHeightFt);
  });

  it("carries a masked hour through as null, not as a number", function () {
    const m = meters(1);
    m[3] = null;
    const out = recordsFor({ waveMeters: m });
    expect(out.waves.hoursFt[3]).toBe(null);
    expect(out.waves.hoursFt[4]).not.toBe(null);
  });

  it("names one model and mirrors it in byModel and sources", function () {
    const out = recordsFor();
    expect(out.waves.models).toEqual(["noaa_gfswave"]);
    expect(out.waves.byModel["noaa_gfswave"]).toBe(out.waves.hoursFt);
    expect(out.waves.sources).toEqual([
      { label: "NOAA GFS Wave Model", url: "https://polar.ncep.noaa.gov/waves/" }
    ]);
  });

  it("stamps startIso and updated with the model valid start, not the run clock",
    function () {
      const out = recordsFor();
      expect(out.waves.startIso).toBe(START_ISO);
      expect(out.waves.updated).toBe(START_ISO);
      expect(out.waveinput.updated).toBe(START_ISO);
    });

  it("skip guard: wave null AND wind null emits NO record at all", function () {
    // The previous KV key then rides its own lease and the flag ages out to unknown,
    // which is gray and honest.
    const out = recordsFor({ waveMeters: null, windMs: null });
    expect(out.waveinput).toBe(null);
    expect(out.waves).toBe(null);
  });

  it("skip guard: wave null but wind present emits a waveinput only", function () {
    const out = recordsFor({ waveMeters: null, windMs: 6 });
    expect(out.waveinput).not.toBe(null);
    expect(out.waveinput.waveHeightFt).toBe(null);
    expect(out.waveinput.model).toBe(null);
    expect(out.waves).toBe(null);
  });

  it("emits a waves record only when at least one hour is finite", function () {
    const allNull = [];
    for (let i = 0; i < 24; i = i + 1) { allNull.push(null); }
    expect(recordsFor({ waveMeters: allNull, windMs: 6 }).waves).toBe(null);
    const oneFinite = allNull.slice();
    oneFinite[9] = 1;
    const out = recordsFor({ waveMeters: oneFinite, windMs: 6 });
    expect(out.waves).not.toBe(null);
    expect(out.waves.hoursFt[9]).toBe(3.28084);
    // Hour 0 is masked, so the flag has no wave height and the wind fallback stands.
    expect(out.waveinput.waveHeightFt).toBe(null);
    expect(out.waves.hoursFt[0]).toBe(out.waveinput.waveHeightFt);
  });
});

describe("kvPairGroups", function () {
  function inputs(n) {
    const out = [];
    for (let i = 0; i < n; i = i + 1) {
      out.push({ beachId: "b-" + String(i), waveHeightFt: 1, model: "noaa_gfswave",
        windSpeedMph: null, windGustMph: null, updated: START_ISO });
    }
    return out;
  }

  function series(n) {
    const out = [];
    for (let i = 0; i < n; i = i + 1) {
      out.push({ beachId: "b-" + String(i), startIso: START_ISO, hoursFt: [], models: [],
        byModel: {}, sources: [], updated: START_ISO });
    }
    return out;
  }

  it("stringifies every value and stamps an absolute expiration", function () {
    const groups = kvPairGroups(inputs(1), series(1), VALID_START_EPOCH + WAVE_KV_LEASE_SECONDS);
    const pairs = groups[0];
    expect(pairs.length).toBe(2);
    for (let i = 0; i < pairs.length; i = i + 1) {
      expect(typeof pairs[i].value).toBe("string");
      expect(typeof pairs[i].expiration).toBe("number");
      // The snake_case field is the ONLY one wrangler honours; a camelCase
      // expirationTtl is warned about, dropped, and the key never expires.
      expect(Object.keys(pairs[i]).sort()).toEqual(["expiration", "key", "value"]);
    }
    expect(JSON.parse(pairs[0].value).beachId).toBe("b-0");
  });

  it("uses validStartEpoch + 25200 regardless of when the build ran", function () {
    expect(WAVE_KV_LEASE_SECONDS).toBe(25200);
    const expiration = VALID_START_EPOCH + WAVE_KV_LEASE_SECONDS;
    const groups = kvPairGroups(inputs(1), series(1), expiration);
    expect(groups[0][0].expiration).toBe(VALID_START_EPOCH + 25200);
    expect(groups[0][1].expiration).toBe(VALID_START_EPOCH + 25200);
  });

  it("prefixes the two key families", function () {
    const groups = kvPairGroups(inputs(1), series(1), 1);
    expect(groups[0][0].key).toBe("waveinput:b-0");
    expect(groups[0][1].key).toBe("waves:b-0");
  });

  it("keeps a beach's two pairs in one group", function () {
    const groups = kvPairGroups(inputs(3), series(3), 1);
    expect(groups.length).toBe(3);
    for (let i = 0; i < groups.length; i = i + 1) {
      expect(groups[i].length).toBe(2);
    }
  });
});

describe("chunkGroups", function () {
  function group(id, size) {
    const out = [];
    for (let i = 0; i < size; i = i + 1) {
      out.push({ key: "k:" + id + ":" + String(i), value: "{}", expiration: 1 });
    }
    return out;
  }

  it("never splits a beach's pairs across two chunk files", function () {
    const groups = [];
    for (let i = 0; i < 5; i = i + 1) { groups.push(group(i, 2)); }
    const chunks = chunkGroups(groups, 3);
    // A limit of 3 against a group size of 2 means one group per chunk: the chunker
    // closes a chunk rather than taking half a beach, so five beaches become five
    // chunks and never two-and-a-half.
    expect(chunks.length).toBe(5);
    expect(chunks[0].length).toBe(2);
    for (let c = 0; c < chunks.length; c = c + 1) {
      const ids = new Set();
      for (let p = 0; p < chunks[c].length; p = p + 1) {
        ids.add(chunks[c][p].key.split(":")[1]);
      }
      // Each beach id appears in exactly one chunk.
      ids.forEach(function (id) {
        let seen = 0;
        for (let x = 0; x < chunks.length; x = x + 1) {
          for (let p = 0; p < chunks[x].length; p = p + 1) {
            if (chunks[x][p].key.split(":")[1] === id) { seen = 1 + seen; }
          }
        }
        expect(seen).toBe(2);
      });
    }
  });

  it("defaults to the documented 5000-pair ceiling", function () {
    expect(MAX_PAIRS_PER_CHUNK).toBe(5000);
    const groups = [];
    for (let i = 0; i < 3000; i = i + 1) { groups.push(group(i, 2)); }
    const chunks = chunkGroups(groups);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBeLessThanOrEqual(5000);
  });

  it("names chunks in zero-padded sequence", function () {
    expect(chunkFileName(0)).toBe("wave-kv-000.json");
    expect(chunkFileName(12)).toBe("wave-kv-012.json");
  });
});

describe("parseWavePointer", function () {
  it("accepts a plain pointer whose prefix contains its cycleId", function () {
    const pointer = parseWavePointer(JSON.stringify({
      cycleId: "20260903T1200Z-g20260903T06Z-5f80f4c",
      prefix: "waves/20260903T1200Z-g20260903T06Z-5f80f4c"
    }));
    expect(pointer.cycleId).toBe("20260903T1200Z-g20260903T06Z-5f80f4c");
  });

  it("refuses a prefix that escapes the bucket path", function () {
    const bad = ["waves/../secrets", "waves\\x", "https://elsewhere/waves/x",
      "/waves/x", "waves/x/"];
    for (let i = 0; i < bad.length; i = i + 1) {
      expect(function () {
        parseWavePointer(JSON.stringify({ cycleId: "x", prefix: bad[i] }));
      }).toThrow();
    }
  });

  it("refuses a pointer whose prefix does not contain the cycleId it claims", function () {
    expect(function () {
      parseWavePointer(JSON.stringify({ cycleId: "cycle-a", prefix: "waves/cycle-b" }));
    }).toThrow();
  });

  it("refuses a malformed cycleId and non-JSON", function () {
    expect(function () {
      parseWavePointer(JSON.stringify({ cycleId: "../x", prefix: "waves/../x" }));
    }).toThrow();
    expect(function () { parseWavePointer("not json"); }).toThrow();
  });
});

describe("verifyArtifact", function () {
  const entry = { key: "waveinput.ndjson", bytes: 10,
    sha256: "a".repeat(63) + "b" };

  it("passes on an exact byte and digest match", function () {
    expect(verifyArtifact(entry, { bytes: 10, sha256: entry.sha256 })).toBe(null);
  });

  it("names a truncated transfer by length before the digest", function () {
    const problem = verifyArtifact(entry, { bytes: 9, sha256: entry.sha256 });
    expect(problem.indexOf("expected 10 bytes")).not.toBe(-1);
  });

  it("refuses a manifest entry with no usable integrity fields", function () {
    expect(verifyArtifact({ key: "x", bytes: null, sha256: entry.sha256 }, { bytes: 1 }))
      .not.toBe(null);
    expect(verifyArtifact({ key: "x", bytes: 1, sha256: "short" }, { bytes: 1 }))
      .not.toBe(null);
  });

  it("finds a manifest artifact by key and returns null for an unknown one", function () {
    const manifest = { artifacts: [entry] };
    expect(manifestArtifact(manifest, "waveinput.ndjson")).toBe(entry);
    expect(manifestArtifact(manifest, "waves.ndjson")).toBe(null);
    expect(manifestArtifact(null, "waveinput.ndjson")).toBe(null);
  });
});

describe("buildConsumerReport", function () {
  const DIGEST = "sha256:" + "c".repeat(64);

  function manifest(overrides) {
    return Object.assign({
      schemaVersion: 1,
      cycleId: "cycle-a",
      buildStatus: "complete",
      validStartIso: START_ISO,
      validStartEpoch: VALID_START_EPOCH,
      kvExpirationEpoch: VALID_START_EPOCH + WAVE_KV_LEASE_SECONDS,
      gridsDigest: DIGEST,
      gridsComplete: true,
      gridStatus: {
        noaa_glwu: { status: "unfetched", elements: [], reasons: ["NOMADS 503"] },
        noaa_gfswave: { status: "sampled", elements: ["HTSGW", "WIND"], reasons: [] }
      },
      sanity: { validTimesPassed: true, sentinelScanPassed: true,
        minimumRecordsPassed: true, overridden: false }
    }, overrides || {});
  }

  function report(overrides) {
    return buildConsumerReport(Object.assign({
      manifest: manifest(),
      pointer: { cycleId: "cycle-a", prefix: "waves/cycle-a" },
      verified: [{ key: "waveinput.ndjson" }, { key: "waves.ndjson" }],
      problems: [],
      nowEpoch: VALID_START_EPOCH + 600,
      localGridsDigest: DIGEST
    }, overrides || {}));
  }

  it("folds in the two conjuncts the producer leaves absent", function () {
    const r = report();
    expect(r.gridsDigestMatches).toBe(true);
    expect(r.secondsRemaining).toBe(WAVE_KV_LEASE_SECONDS - 600);
  });

  it("computes secondsRemaining from validStartIso, so an unparseable one is NaN",
    function () {
      const r = report({ manifest: manifest({ validStartIso: "not a time" }) });
      expect(Number.isNaN(r.secondsRemaining)).toBe(true);
    });

  it("marks the digest as not matching when the local grid set has moved", function () {
    expect(report({ localGridsDigest: "sha256:" + "d".repeat(64) }).gridsDigestMatches)
      .toBe(false);
  });

  it("refuses to call artifacts verified when a problem was recorded", function () {
    expect(report({ problems: ["waves.ndjson: sha256 mismatch"] }).artifactsVerified)
      .toBe(false);
  });

  it("copies the build's own validTimes and sentinel verdicts through verbatim",
    function () {
      const r = report({ manifest: manifest({ sanity: { validTimesPassed: false } }) });
      expect(r.validTimesPassed).toBe(false);
      expect(r.sentinelScanPassed).toBe(undefined);
    });

  it("reports the pointer as disagreeing when it names a different cycle", function () {
    const r = report({ pointer: { cycleId: "cycle-b", prefix: "waves/cycle-b" } });
    expect(r.pointerAgreesWithManifest).toBe(false);
  });

  it("copies minimumRecordsPassed through verbatim", function () {
    expect(report().minimumRecordsPassed).toBe(true);
    expect(report({ manifest: manifest({ sanity: { minimumRecordsPassed: false } }) })
      .minimumRecordsPassed).toBe(false);
  });

  it("fails closed when minimumRecordsPassed never reaches the report", function () {
    // A missing sanity block yields null and a sanity block missing the field yields
    // undefined; the consumer gate's strict !== true refuses both.
    const noSanity = report({ manifest: manifest({ sanity: undefined }) });
    expect(noSanity.minimumRecordsPassed).toBe(null);
    expect(waveKvWriteAllowed(noSanity)).toBe(false);
    const noField = report({ manifest: manifest({ sanity: { validTimesPassed: true,
      sentinelScanPassed: true, overridden: false } }) });
    expect(noField.minimumRecordsPassed).toBe(undefined);
    expect(waveKvWriteAllowed(noField)).toBe(false);
  });

  it("carries gridStatus as provenance and never as a tier decision", function () {
    const r = report();
    expect(r.gridStatus.noaa_glwu.status).toBe("unfetched");
    expect(classifyWaveManifestFailure(r).tier).toBe("ok");
    // Stripping the whole block changes nothing about the verdict, which is what
    // "provenance only" means: a gate on it would refuse every manifest built before
    // the field existed.
    const stripped = report({ manifest: manifest({ gridStatus: undefined }) });
    expect(stripped.gridStatus).toBe(null);
    expect(classifyWaveManifestFailure(stripped).tier).toBe("ok");
    expect(waveKvWriteAllowed(stripped)).toBe(true);
  });

  it("still writes for the grids that sampled when one grid was out", function () {
    // The degraded tier the per-grid isolation exists to make reachable: GLWU down,
    // gfswave sampled, so the ocean beaches keep their KV and the Great Lakes ones
    // age out to unknown.
    const r = report({ manifest: manifest({ gridsComplete: false }) });
    expect(classifyWaveManifestFailure(r).tier).toBe("degraded");
    expect(waveKvWriteAllowed(r)).toBe(true);
  });
});
