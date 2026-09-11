// THE WRITER CONTRACT for the NOAA GRIB2 wave pipeline: the record shape the Worker
// reads, the two unit conversions, and the emitted row's lease and statement shape.
//
// This is the most important file in the pipeline. Every failure it guards is
// SILENT in production:
//
//   * Handing src/rules.js METRES makes every sea state below 1.22 m read under 2 ft
//     — a permanent green across the whole site, with no error anywhere. The
//     "1 m -> 3.28084 ft" exactness pin is this repo's only assertion on that path.
//   * Handing src/rules.js METRES PER SECOND makes an actual 25 mph arrive as 11, so
//     every wind reads green. No other test covers that conversion.
//   * A wave_expires that is not one of the cycle's two computed epochs, or one that
//     has already passed, breaks the only staleness control the color path has:
//     runFlagRecompute never reads the record's updated field, so the absolute lease
//     and the series hour index are the whole of it. The blob stays in the row past
//     its lease, so a wrong lease leaves readable data sitting there.
//   * A record carrying the hourly series written under the SHORT scalar lease loses
//     17 h of coverage; one written the other way round puts an hour-0 wind on the
//     color path for a day.
//   * hoursFt[0] drifting from waveHeightFt makes the detail page's "now" stat
//     contradict its own first bar.
//   * A statement carrying a raw newline, or an unescaped quote in the JSON blob,
//     tears the delta: scripts/apply-local-sql.js splits on line boundaries only.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { metersToFeet } from "../src/geo.js";
import { metersPerSecondToMph } from "../src/waveGrids.js";
import {
  WAVE_SCALAR_LEASE_SECONDS,
  WAVE_SERIES_LEASE_SECONDS,
  classifyWaveManifestFailure,
  waveWriteAllowed
} from "../src/waveManifest.js";
import { liveWaveRecord } from "../src/beachState.js";
import { waveRecordsForBeach } from "../scripts/sample-waves.js";
import { applyMigrations } from "./helpers/migrations.js";
import {
  MAX_STATEMENT_BYTES,
  parseArgs,
  verifyArtifact,
  manifestArtifact,
  buildConsumerReport,
  sqlStr,
  sqlNum,
  waveRowsFor,
  waveRowStatement,
  waveRowRefusals
} from "../scripts/build-wave-sql.js";

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
  it("emits a waveinput with exactly the eight contracted fields", function () {
    const out = recordsFor();
    expect(Object.keys(out.waveinput).sort()).toEqual([
      "beachId", "hoursFt", "model", "startIso", "updated", "waveHeightFt",
      "windGustMph", "windSpeedMph"
    ]);
    expect(out.waveinput.model).toBe("noaa_gfswave");
    expect(out.waveinput.updated).toBe(START_ISO);
  });

  it("carries the same series object the waves record does", function () {
    // scanRecords walks waves.hoursFt for sentinels and range, and the color path
    // indexes waveinput.hoursFt. One array is what makes the first cover the second.
    const out = recordsFor();
    expect(out.waveinput.hoursFt).toBe(out.waves.hoursFt);
    expect(out.waveinput.startIso).toBe(out.waves.startIso);
  });

  it("leaves a wind-only record with no series, which is what earns it the short lease",
    function () {
      const out = recordsFor({ waveMeters: null, windMs: 6 });
      expect(out.waveinput.hoursFt).toBe(null);
      expect(out.waveinput.startIso).toBe(null);
    });

  it("names the grid on a series whose hour 0 is masked", function () {
    // waveHeightFt is hour 0 and stays null, but a later hour has a model behind it
    // and resolveWaveInput needs the name to attribute the reading.
    const m = meters(1);
    m[0] = null;
    const out = recordsFor({ waveMeters: m });
    expect(out.waveinput.waveHeightFt).toBe(null);
    expect(out.waveinput.model).toBe("noaa_gfswave");
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
    // The previous beach_state.wave row then rides its own lease and the flag ages
    // out to unknown, which is gray and honest.
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

// --- the emitted rows -----------------------------------------------------------------

function inputs(n) {
  const out = [];
  for (let i = 0; i < n; i = i + 1) {
    out.push({ beachId: "b-" + String(i), waveHeightFt: 1, model: "noaa_gfswave",
      windSpeedMph: null, windGustMph: null, startIso: START_ISO, hoursFt: [1],
      updated: START_ISO });
  }
  return out;
}

function series(n) {
  const out = [];
  for (let i = 0; i < n; i = i + 1) {
    out.push({ beachId: "b-" + String(i), startIso: START_ISO, hoursFt: [1],
      models: ["noaa_gfswave"], byModel: { noaa_gfswave: [1] }, sources: [],
      updated: START_ISO });
  }
  return out;
}

function windOnly() {
  return [{ beachId: "b-0", waveHeightFt: null, model: null, windSpeedMph: 14,
    windGustMph: null, startIso: null, hoursFt: null, updated: START_ISO }];
}

// Every row in these blocks is series-bearing unless a test says otherwise, and
// nowEpoch sits just after the valid start, so no lease has run out.
function leases(overrides) {
  return Object.assign({
    series: VALID_START_EPOCH + WAVE_SERIES_LEASE_SECONDS,
    scalar: VALID_START_EPOCH + WAVE_SCALAR_LEASE_SECONDS,
    nowEpoch: VALID_START_EPOCH + 600
  }, overrides || {});
}

describe("waveRowsFor", function () {
  it("merges a beach's two artifact records into one row", function () {
    const rows = waveRowsFor(inputs(1), series(1), leases());
    expect(rows.length).toBe(1);
    expect(rows[0].beachId).toBe("b-0");
    // The exact union of the two emitted shapes: no reader has to learn a new field
    // name, and the stored row stays a straight diff against the NDJSON artifact.
    expect(Object.keys(rows[0].record).sort()).toEqual([
      "beachId", "byModel", "hoursFt", "model", "models", "sources", "startIso",
      "updated", "waveHeightFt", "windGustMph", "windSpeedMph"
    ]);
  });

  it("emits exactly one row per beach", function () {
    const rows = waveRowsFor(inputs(3), series(3), leases());
    expect(rows.length).toBe(3);
    const ids = rows.map(function (r) { return r.beachId; });
    expect(ids.sort()).toEqual(["b-0", "b-1", "b-2"]);
  });

  it("takes the series the color path indexes from the waveinput copy", function () {
    // scanRecords has already proved the two copies identical across the NDJSON
    // round trip, so the color path's array is the one that is stored.
    const waveinputs = inputs(1);
    const wavesList = series(1);
    wavesList[0].hoursFt = [9];
    const rows = waveRowsFor(waveinputs, wavesList, leases());
    expect(rows[0].record.hoursFt).toEqual([1]);
  });

  it("uses validStartEpoch + 86400 for a series row, regardless of when the build ran",
    function () {
      expect(WAVE_SERIES_LEASE_SECONDS).toBe(86400);
      const rows = waveRowsFor(inputs(1), series(1), leases());
      expect(rows[0].expiration).toBe(VALID_START_EPOCH + 86400);
    });

  it("gives a wind-only record the short scalar lease", function () {
    expect(WAVE_SCALAR_LEASE_SECONDS).toBe(25200);
    const rows = waveRowsFor(windOnly(), [], leases());
    expect(rows.length).toBe(1);
    expect(rows[0].expiration).toBe(VALID_START_EPOCH + 25200);
    expect(rows[0].record.models).toBe(undefined);
  });

  it("drops a wind-only record whose scalar lease has already run out", function () {
    // The series lease outlives the scalar one, so a cycle the gate still accepts
    // can carry wind-only records with nothing left. A reader treats an expired
    // wave_expires as absent, so writing the row would land data nothing can read.
    const late = leases({ nowEpoch: VALID_START_EPOCH + WAVE_SCALAR_LEASE_SECONDS + 1 });
    expect(waveRowsFor(windOnly(), [], late)).toEqual([]);
    // The series rows of the same late cycle still go out.
    expect(waveRowsFor(inputs(1), series(1), late).length).toBe(1);
  });

  it("gives a waves record with no waveinput its own row", function () {
    const rows = waveRowsFor([], series(1), leases());
    expect(rows.length).toBe(1);
    expect(rows[0].beachId).toBe("b-0");
    expect(rows[0].expiration).toBe(VALID_START_EPOCH + 86400);
  });

  it("skips a record with no beach id", function () {
    expect(waveRowsFor([{ hoursFt: [1], startIso: START_ISO }], [], leases()))
      .toEqual([]);
  });
});

describe("the statement shape", function () {
  it("is a single-row upsert naming only the two wave columns", function () {
    const rows = waveRowsFor(inputs(1), series(1), leases());
    const statement = waveRowStatement(rows[0]);
    expect(statement.indexOf(
      "INSERT INTO beach_state (beach_id, wave, wave_expires) VALUES (")).toBe(0);
    expect(statement.indexOf(
      ") ON CONFLICT(beach_id) DO UPDATE SET wave = excluded.wave, " +
      "wave_expires = excluded.wave_expires;")).not.toBe(-1);
    // Naming no other column is what keeps the hourly cron's estimate, official,
    // wqfloor and reading untouched by the offline cycle.
    expect(statement.indexOf("estimate")).toBe(-1);
    expect(statement.indexOf("official")).toBe(-1);
  });

  it("puts every statement on one line", function () {
    // scripts/apply-local-sql.js splits on line boundaries only and hard-fails on a
    // line over its chunk cap, so an embedded newline tears the delta in half.
    const rows = waveRowsFor(inputs(5), series(5), leases());
    for (let i = 0; i < rows.length; i = i + 1) {
      const statement = waveRowStatement(rows[i]);
      expect(statement.indexOf("\n")).toBe(-1);
      expect(statement.indexOf("\r")).toBe(-1);
    }
  });

  it("keeps every statement under the per-statement budget", function () {
    expect(MAX_STATEMENT_BYTES).toBe(80000);
    const rows = waveRowsFor(inputs(1), series(1), leases());
    const bytes = new TextEncoder().encode(waveRowStatement(rows[0])).length;
    expect(bytes).toBeLessThanOrEqual(MAX_STATEMENT_BYTES);
  });

  it("keeps a quote, a semicolon, a backslash, a newline and a comment marker inside " +
    "the literal", function () {
      const hostile = inputs(1);
      hostile[0].beachId = "osm-node-'1;--";
      hostile[0].model = "a'b;--c\\d\ne";
      const rows = waveRowsFor(hostile, [], leases());
      const statement = waveRowStatement(rows[0]);
      expect(statement.indexOf("\n")).toBe(-1);
      // Every quote in the payload arrives doubled, so the literal never closes early.
      expect(statement.indexOf("'osm-node-''1;--'")).not.toBe(-1);
      expect(statement.split(";").length).toBeGreaterThan(1);
    });

  it("quotes text and inlines a finite number, or NULL", function () {
    expect(sqlStr("o'hare")).toBe("'o''hare'");
    expect(sqlStr(null)).toBe("NULL");
    expect(sqlNum(1788415200)).toBe("1788415200");
    expect(sqlNum(Number.NaN)).toBe("NULL");
    expect(sqlNum("1788415200")).toBe("NULL");
  });
});

describe("waveRowRefusals", function () {
  function rowsOf() {
    return waveRowsFor(inputs(1), series(1), leases());
  }

  it("passes a clean row set", function () {
    expect(waveRowRefusals(rowsOf(), leases())).toEqual([]);
  });

  it("refuses a zero-row delta", function () {
    // An empty .sql applies cleanly and makes a broken cycle look landed.
    expect(waveRowRefusals([], leases()).length).toBe(1);
  });

  it("refuses an expiration that is neither computed epoch", function () {
    const rows = rowsOf();
    rows[0].expiration = VALID_START_EPOCH + 3600;
    expect(waveRowRefusals(rows, leases()).length).toBe(1);
  });

  it("refuses a non-finite expiration", function () {
    const rows = rowsOf();
    rows[0].expiration = null;
    expect(waveRowRefusals(rows, leases()).length).toBe(1);
  });

  it("refuses an expiration that has already passed", function () {
    const late = leases({ nowEpoch: VALID_START_EPOCH + WAVE_SERIES_LEASE_SECONDS + 1 });
    const refusals = waveRowRefusals(rowsOf(), late);
    expect(refusals.length).toBe(1);
    expect(refusals[0].indexOf("already passed")).not.toBe(-1);
  });

  it("refuses an empty beach id", function () {
    const rows = rowsOf();
    rows[0].beachId = "";
    expect(waveRowRefusals(rows, leases()).length).toBe(1);
  });

  it("refuses a statement over the byte budget", function () {
    const rows = rowsOf();
    const big = [];
    for (let i = 0; i < MAX_STATEMENT_BYTES; i = i + 1) { big.push(i); }
    rows[0].record.hoursFt = big;
    const refusals = waveRowRefusals(rows, leases());
    expect(refusals.length).toBe(1);
    expect(refusals[0].indexOf("byte budget")).not.toBe(-1);
  });
});

describe("the delta against real SQLite", function () {
  function applyRows(db, rows) {
    for (let i = 0; i < rows.length; i = i + 1) {
      db.exec(waveRowStatement(rows[i]));
    }
  }

  it("lands a row liveWaveRecord reads back intact", function () {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const hostile = inputs(1);
    hostile[0].beachId = "osm-node-'1";
    hostile[0].model = "a'b;--c\\d";
    const rows = waveRowsFor(hostile, [], leases());
    applyRows(db, rows);
    const row = db.prepare(
      "SELECT wave, wave_expires FROM beach_state WHERE beach_id = ?").get("osm-node-'1");
    const record = liveWaveRecord(row, VALID_START_EPOCH * 1000 + 600000);
    expect(record.model).toBe("a'b;--c\\d");
    expect(record.hoursFt).toEqual([1]);
    expect(row.wave_expires).toBe(VALID_START_EPOCH + WAVE_SERIES_LEASE_SECONDS);
  });

  it("reads back as absent once the stored lease has passed", function () {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    applyRows(db, waveRowsFor(inputs(1), series(1), leases()));
    const row = db.prepare(
      "SELECT wave, wave_expires FROM beach_state WHERE beach_id = ?").get("b-0");
    const afterMs = (VALID_START_EPOCH + WAVE_SERIES_LEASE_SECONDS + 1) * 1000;
    expect(liveWaveRecord(row, afterMs)).toBe(null);
  });

  it("is idempotent and leaves the sibling columns alone", function () {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    db.exec("INSERT INTO beach_state (beach_id, estimate, estimate_color, " +
      "estimate_expires) VALUES ('b-0', '{\"color\":\"green\"}', 'green', 99)");
    const rows = waveRowsFor(inputs(1), series(1), leases());
    applyRows(db, rows);
    applyRows(db, rows);
    const row = db.prepare("SELECT * FROM beach_state WHERE beach_id = ?").get("b-0");
    expect(row.estimate_color).toBe("green");
    expect(row.estimate_expires).toBe(99);
    expect(JSON.parse(row.wave).beachId).toBe("b-0");
    expect(db.prepare("SELECT COUNT(*) AS n FROM beach_state").get().n).toBe(1);
  });

  it("creates a row for a beach with no prior beach_state row", function () {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    applyRows(db, waveRowsFor(inputs(1), series(1), leases()));
    const row = db.prepare("SELECT * FROM beach_state WHERE beach_id = ?").get("b-0");
    expect(row.estimate).toBe(null);
    expect(row.wave_expires).toBe(VALID_START_EPOCH + WAVE_SERIES_LEASE_SECONDS);
  });
});

describe("parseArgs", function () {
  it("requires the cycle directory and the output directory", function () {
    expect(parseArgs(["--dir", "/c", "--out", "/sql"])).toEqual(
      { dir: "/c", now: null, out: "/sql" });
    expect(function () { parseArgs(["--out", "/sql"]); }).toThrow(/--dir/);
    expect(function () { parseArgs(["--dir", "/c"]); }).toThrow(/--out/);
  });

  it("rejects an argument it does not know", function () {
    expect(function () {
      parseArgs(["--dir", "/c", "--out", "/sql", "--pointer", "/p"]);
    }).toThrow(/unknown argument/);
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
      schemaVersion: 2,
      cycleId: "cycle-a",
      buildStatus: "complete",
      validStartIso: START_ISO,
      validStartEpoch: VALID_START_EPOCH,
      kvExpirationEpoch: VALID_START_EPOCH + WAVE_SERIES_LEASE_SECONDS,
      kvScalarExpirationEpoch: VALID_START_EPOCH + WAVE_SCALAR_LEASE_SECONDS,
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
      verified: [{ key: "waveinput.ndjson" }, { key: "waves.ndjson" }],
      problems: [],
      nowEpoch: VALID_START_EPOCH + 600,
      localGridsDigest: DIGEST
    }, overrides || {}));
  }

  it("folds in the two conjuncts the producer leaves absent", function () {
    const r = report();
    expect(r.gridsDigestMatches).toBe(true);
    // Measured against the SERIES lease: that is the one the color path stands on.
    expect(r.secondsRemaining).toBe(WAVE_SERIES_LEASE_SECONDS - 600);
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

  it("takes cycleId from the manifest and nulls it when the manifest has none", function () {
    expect(report().cycleId).toBe("cycle-a");
    expect(report({ manifest: manifest({ cycleId: undefined }) }).cycleId).toBe(null);
    expect(report({ manifest: null }).cycleId).toBe(null);
  });

  it("copies optionalGridCountsWarned through verbatim", function () {
    expect(report().optionalGridCountsWarned).toBe(undefined);
    const warned = report({ manifest: manifest({ sanity: { validTimesPassed: true,
      sentinelScanPassed: true, minimumRecordsPassed: true, overridden: false,
      optionalGridCountsWarned: true } }) });
    expect(warned.optionalGridCountsWarned).toBe(true);
    expect(classifyWaveManifestFailure(warned).tier).toBe("degraded");
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
    expect(waveWriteAllowed(noSanity)).toBe(false);
    const noField = report({ manifest: manifest({ sanity: { validTimesPassed: true,
      sentinelScanPassed: true, overridden: false } }) });
    expect(noField.minimumRecordsPassed).toBe(undefined);
    expect(waveWriteAllowed(noField)).toBe(false);
  });

  it("carries gridStatus as provenance and never as a tier decision", function () {
    const r = report();
    expect(r.gridStatus.noaa_glwu.status).toBe("unfetched");
    expect(classifyWaveManifestFailure(r).tier).toBe("ok");
    // Stripping the whole block changes nothing about the verdict, which is what
    // "provenance only" means: a gate on it would refuse any manifest that lacks
    // the field.
    const stripped = report({ manifest: manifest({ gridStatus: undefined }) });
    expect(stripped.gridStatus).toBe(null);
    expect(classifyWaveManifestFailure(stripped).tier).toBe("ok");
    expect(waveWriteAllowed(stripped)).toBe(true);
  });

  it("still writes for the grids that sampled when one grid was out", function () {
    // The degraded tier the per-grid isolation exists to make reachable: GLWU down,
    // gfswave sampled, so the ocean beaches keep their rows and the Great Lakes ones
    // age out to unknown.
    const r = report({ manifest: manifest({ gridsComplete: false }) });
    expect(classifyWaveManifestFailure(r).tier).toBe("degraded");
    expect(waveWriteAllowed(r)).toBe(true);
  });
});
