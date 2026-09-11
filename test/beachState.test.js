// The beach_state read/write contract: a record past its absolute expiry reads
// as absent, an absent record leaves its column alone, and the alert refresh's
// CAS never touches the standing instant or the lease.
import { describe, it, expect } from "vitest";
import {
  WQFLOOR_TTL_SECONDS,
  BEACH_STATE_SELECT,
  BEACH_STATE_JOIN,
  CHIP_STATE_SELECT,
  WAVE_STATE_SELECT,
  liveBeachState,
  liveChipState,
  liveWaveRecord,
  beachStateUpsertStatements,
  estimateCasStatement,
  chunkStatements
} from "../src/beachState.js";
import { makeD1 } from "./helpers/d1.js";

const NOW_MS = 1750000000000;
const NOW_EPOCH = Math.floor(NOW_MS / 1000);

function recordingDb() {
  return {
    prepare: function (sql) {
      return {
        bind: function () {
          return { sql: sql, args: Array.prototype.slice.call(arguments) };
        }
      };
    }
  };
}

describe("beachState constants", function () {
  it("keeps the wqfloor lease at two hours", function () {
    expect(WQFLOOR_TTL_SECONDS).toBe(7200);
  });

  it("selects every blob with its own expiry, aliased to the join", function () {
    expect(BEACH_STATE_SELECT).toBe(
      "s.estimate, s.estimate_expires, s.official, s.official_expires, " +
      "s.wqfloor, s.wqfloor_expires, s.reading, s.reading_expires"
    );
    expect(BEACH_STATE_JOIN).toBe(" LEFT JOIN beach_state s ON s.beach_id = b.id");
    expect(BEACH_STATE_SELECT.indexOf("wave")).toBe(-1);
  });

  it("keeps the wave record in its own fragment, selected only by its two readers", function () {
    expect(WAVE_STATE_SELECT).toBe("s.wave, s.wave_expires");
  });

  it("gives the chip surfaces the scalar mirror columns and no blob", function () {
    expect(CHIP_STATE_SELECT).toBe(
      "s.estimate_color, s.estimate_updated, s.estimate_expires, " +
      "s.official_color, s.official_updated, s.official_expires"
    );
    expect(CHIP_STATE_SELECT.indexOf("s.estimate,")).toBe(-1);
    expect(CHIP_STATE_SELECT.indexOf("s.official,")).toBe(-1);
    expect(CHIP_STATE_SELECT.indexOf("wqfloor")).toBe(-1);
    expect(CHIP_STATE_SELECT.indexOf("reading")).toBe(-1);
    expect(CHIP_STATE_SELECT.indexOf("wave")).toBe(-1);
  });
});

describe("liveWaveRecord", function () {
  const RECORD = {
    beachId: "b1",
    startIso: "2026-07-05T12:00:00.000Z",
    hoursFt: [1.2, 1.4],
    waveHeightFt: 1.2,
    model: "global.0p16"
  };

  it("parses a live record off a row that selected WAVE_STATE_SELECT", function () {
    expect(liveWaveRecord({
      wave: JSON.stringify(RECORD),
      wave_expires: NOW_EPOCH + 1
    }, NOW_MS)).toEqual(RECORD);
  });

  it("treats expires equal to the current epoch as expired", function () {
    expect(liveWaveRecord({
      wave: JSON.stringify(RECORD), wave_expires: NOW_EPOCH
    }, NOW_MS)).toBeNull();
    expect(liveWaveRecord({
      wave: JSON.stringify(RECORD), wave_expires: NOW_EPOCH - 1
    }, NOW_MS)).toBeNull();
    expect(liveWaveRecord({
      wave: JSON.stringify(RECORD), wave_expires: NOW_EPOCH + 1
    }, NOW_MS)).not.toBeNull();
  });

  it("reads a NULL blob, a missing lease and unparseable JSON as absent", function () {
    expect(liveWaveRecord({ wave: null, wave_expires: NOW_EPOCH + 1 }, NOW_MS)).toBeNull();
    expect(liveWaveRecord({ wave: "", wave_expires: NOW_EPOCH + 1 }, NOW_MS)).toBeNull();
    expect(liveWaveRecord({
      wave: JSON.stringify(RECORD), wave_expires: null
    }, NOW_MS)).toBeNull();
    expect(liveWaveRecord({
      wave: JSON.stringify(RECORD), wave_expires: Number.NaN
    }, NOW_MS)).toBeNull();
    expect(liveWaveRecord({
      wave: "{not json", wave_expires: NOW_EPOCH + 1
    }, NOW_MS)).toBeNull();
    expect(liveWaveRecord({
      wave: "null", wave_expires: NOW_EPOCH + 1
    }, NOW_MS)).toBeNull();
    expect(liveWaveRecord({
      wave: "42", wave_expires: NOW_EPOCH + 1
    }, NOW_MS)).toBeNull();
  });

  it("returns null for a missing row and never throws", function () {
    expect(liveWaveRecord(null, NOW_MS)).toBeNull();
    expect(liveWaveRecord(undefined, NOW_MS)).toBeNull();
    expect(liveWaveRecord({}, NOW_MS)).toBeNull();
  });

  it("ignores the other records on a row that selected both widths", function () {
    const row = {
      id: "b1",
      estimate: JSON.stringify({ color: "green" }),
      estimate_expires: NOW_EPOCH + 10,
      wave: JSON.stringify(RECORD),
      wave_expires: NOW_EPOCH + 10
    };
    expect(liveWaveRecord(row, NOW_MS).model).toBe("global.0p16");
    expect(liveBeachState(row, NOW_MS)).toEqual({
      estimate: { color: "green" }, official: null, wqfloor: null, reading: null
    });
  });
});

describe("liveChipState", function () {
  const ROW = {
    estimate_color: "yellow",
    estimate_updated: "2026-07-05T12:00:00.000Z",
    estimate_expires: NOW_EPOCH + 60,
    official_color: "red",
    official_updated: "2026-07-05T11:00:00.000Z",
    official_expires: NOW_EPOCH + 60
  };

  it("returns the color and updated pair each record renders from", function () {
    const state = liveChipState(ROW, NOW_MS);
    expect(state.estimate).toEqual({
      color: "yellow", updated: "2026-07-05T12:00:00.000Z"
    });
    expect(state.official).toEqual({
      color: "red", updated: "2026-07-05T11:00:00.000Z"
    });
  });

  it("cuts each record off at its own expiry, on the same boundary as the blobs", function () {
    const atBoundary = Object.assign({}, ROW, { estimate_expires: NOW_EPOCH });
    const state = liveChipState(atBoundary, NOW_MS);
    expect(state.estimate).toBeNull();
    expect(state.official).not.toBeNull();

    const oneMore = Object.assign({}, ROW, { estimate_expires: NOW_EPOCH + 1 });
    expect(liveChipState(oneMore, NOW_MS).estimate).not.toBeNull();
  });

  it("reads a missing row, a NULL color and a NULL expiry as absent", function () {
    expect(liveChipState(null, NOW_MS)).toEqual({ estimate: null, official: null });
    expect(liveChipState({}, NOW_MS)).toEqual({ estimate: null, official: null });
    expect(liveChipState(
      { estimate_color: "green", estimate_expires: null }, NOW_MS
    ).estimate).toBeNull();
  });

  it("keeps a live record whose updated stamp is NULL, reporting it as null", function () {
    const noStamp = Object.assign({}, ROW, { estimate_updated: null });
    expect(liveChipState(noStamp, NOW_MS).estimate).toEqual({
      color: "yellow", updated: null
    });
  });
});

describe("liveBeachState", function () {
  it("parses every live record", function () {
    const state = liveBeachState({
      estimate: JSON.stringify({ color: "yellow" }),
      estimate_expires: NOW_EPOCH + 1,
      official: JSON.stringify({ color: "red", official: true }),
      official_expires: NOW_EPOCH + 1,
      wqfloor: JSON.stringify({ color: "red", kind: "ecoli" }),
      wqfloor_expires: NOW_EPOCH + 1,
      reading: JSON.stringify({ waterTempF: 68 }),
      reading_expires: NOW_EPOCH + 1
    }, NOW_MS);
    expect(state.estimate.color).toBe("yellow");
    expect(state.official.official).toBe(true);
    expect(state.wqfloor.kind).toBe("ecoli");
    expect(state.reading.waterTempF).toBe(68);
  });

  it("treats expires equal to the current epoch as expired", function () {
    const row = {
      estimate: JSON.stringify({ color: "green" }),
      estimate_expires: NOW_EPOCH,
      official: JSON.stringify({ color: "green" }),
      official_expires: NOW_EPOCH + 1
    };
    const state = liveBeachState(row, NOW_MS);
    expect(state.estimate).toBeNull();
    expect(state.official).not.toBeNull();
  });

  it("expires each record on its own column", function () {
    const state = liveBeachState({
      estimate: JSON.stringify({ color: "green" }),
      estimate_expires: NOW_EPOCH - 1,
      official: JSON.stringify({ color: "red" }),
      official_expires: NOW_EPOCH + 3600
    }, NOW_MS);
    expect(state.estimate).toBeNull();
    expect(state.official.color).toBe("red");
  });

  it("reads NULL blobs, NULL expiries and unparseable JSON as absent", function () {
    const state = liveBeachState({
      estimate: null,
      estimate_expires: null,
      official: "{not json",
      official_expires: NOW_EPOCH + 1,
      wqfloor: JSON.stringify({ color: "red" }),
      wqfloor_expires: null,
      reading: "",
      reading_expires: NOW_EPOCH + 1
    }, NOW_MS);
    expect(state).toEqual({ estimate: null, official: null, wqfloor: null, reading: null });
  });

  it("returns all-null for a missing row and never throws", function () {
    expect(liveBeachState(null, NOW_MS)).toEqual({
      estimate: null, official: null, wqfloor: null, reading: null
    });
    expect(liveBeachState(undefined, NOW_MS).estimate).toBeNull();
    expect(liveBeachState({ estimate: "null", estimate_expires: NOW_EPOCH + 1 }, NOW_MS).estimate)
      .toBeNull();
  });

  it("ignores extra columns from a b.* select", function () {
    const state = liveBeachState({
      id: "b1",
      name: "Test Beach",
      estimate: JSON.stringify({ color: "green" }),
      estimate_expires: NOW_EPOCH + 10
    }, NOW_MS);
    expect(state.estimate.color).toBe("green");
  });
});

describe("beachStateUpsertStatements", function () {
  it("COALESCEs every column onto its stored value", function () {
    const stmt = beachStateUpsertStatements(recordingDb(), [{ beachId: "b1" }])[0];
    expect(stmt.sql).toBe(
      "INSERT INTO beach_state (beach_id, estimate, estimate_color, estimate_updated, " +
      "estimate_expires, official, official_color, official_updated, official_expires, " +
      "wqfloor, wqfloor_expires, reading, reading_expires) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) " +
      "ON CONFLICT(beach_id) DO UPDATE SET " +
      "estimate = COALESCE(excluded.estimate, beach_state.estimate), " +
      "estimate_color = COALESCE(excluded.estimate_color, beach_state.estimate_color), " +
      "estimate_updated = COALESCE(excluded.estimate_updated, beach_state.estimate_updated), " +
      "estimate_expires = COALESCE(excluded.estimate_expires, beach_state.estimate_expires), " +
      "official = COALESCE(excluded.official, beach_state.official), " +
      "official_color = COALESCE(excluded.official_color, beach_state.official_color), " +
      "official_updated = COALESCE(excluded.official_updated, beach_state.official_updated), " +
      "official_expires = COALESCE(excluded.official_expires, beach_state.official_expires), " +
      "wqfloor = COALESCE(excluded.wqfloor, beach_state.wqfloor), " +
      "wqfloor_expires = COALESCE(excluded.wqfloor_expires, beach_state.wqfloor_expires), " +
      "reading = COALESCE(excluded.reading, beach_state.reading), " +
      "reading_expires = COALESCE(excluded.reading_expires, beach_state.reading_expires)"
    );
  });

  it("names no wave column, so the offline cycle owns them alone", function () {
    const stmt = beachStateUpsertStatements(recordingDb(), [{ beachId: "b1" }])[0];
    expect(stmt.sql.indexOf("wave")).toBe(-1);
  });

  it("binds absent fields as NULL and derives color and updated from the objects", function () {
    const estimate = { color: "yellow", updated: "2026-09-09T12:00:00Z", reason: "waves" };
    const stmt = beachStateUpsertStatements(recordingDb(), [{
      beachId: "b1",
      estimate: estimate,
      estimateExpires: NOW_EPOCH + 25200
    }])[0];
    expect(stmt.args).toEqual([
      "b1",
      JSON.stringify(estimate), "yellow", "2026-09-09T12:00:00Z", NOW_EPOCH + 25200,
      null, null, null, null,
      null, null,
      null, null
    ]);
  });

  it("merges the estimate pass and the official pass into one statement per beach", function () {
    const estimate = { color: "green", updated: "2026-09-09T12:00:00Z" };
    const official = { color: "red", updated: "2026-09-09T11:40:00Z", official: true };
    const reading = { waterTempF: 70, observedIso: "2026-09-09T11:00:00Z" };
    const stmts = beachStateUpsertStatements(recordingDb(), [
      { beachId: "b1", estimate: estimate, estimateExpires: 100 },
      { beachId: "b2", estimate: estimate, estimateExpires: 100 },
      { beachId: "b1", official: official, officialExpires: 200, reading: reading, readingExpires: 300 }
    ]);
    expect(stmts.length).toBe(2);
    expect(stmts[0].args).toEqual([
      "b1",
      JSON.stringify(estimate), "green", "2026-09-09T12:00:00Z", 100,
      JSON.stringify(official), "red", "2026-09-09T11:40:00Z", 200,
      null, null,
      JSON.stringify(reading), 300
    ]);
    expect(stmts[1].args[0]).toBe("b2");
    expect(stmts[1].args[5]).toBeNull();
  });

  it("skips descriptors with no beachId", function () {
    expect(beachStateUpsertStatements(recordingDb(), [{}, null]).length).toBe(0);
    expect(beachStateUpsertStatements(recordingDb(), []).length).toBe(0);
  });

  it("leaves a stored record untouched when this run produced none", async function () {
    const env = makeD1();
    env.seedBeaches([{ id: "b1" }]);
    const wqfloor = { color: "red", kind: "ecoli" };
    await env.batch(beachStateUpsertStatements(env, [{
      beachId: "b1",
      estimate: { color: "green", updated: "2026-09-09T11:00:00Z" },
      estimateExpires: 1000,
      wqfloor: wqfloor,
      wqfloorExpires: 2000
    }]));
    await env.batch(beachStateUpsertStatements(env, [{
      beachId: "b1",
      estimate: { color: "yellow", updated: "2026-09-09T12:00:00Z" },
      estimateExpires: 5000
    }]));
    const row = env.stateOf("b1");
    expect(row.estimate_color).toBe("yellow");
    expect(row.estimate_updated).toBe("2026-09-09T12:00:00Z");
    expect(row.estimate_expires).toBe(5000);
    expect(JSON.parse(row.wqfloor)).toEqual(wqfloor);
    expect(row.wqfloor_expires).toBe(2000);
    expect(row.official).toBeNull();
  });

  it("leaves a stored wave record byte-identical across a full hourly upsert", async function () {
    const env = makeD1();
    env.seedBeaches([{ id: "b1" }]);
    const record = {
      beachId: "b1",
      startIso: "2026-09-09T06:00:00Z",
      hoursFt: [1.1, 1.2, 1.3],
      waveHeightFt: 1.1,
      model: "global.0p16"
    };
    env.seedWave("b1", record, 4000);
    const before = env.stateOf("b1");

    await env.batch(beachStateUpsertStatements(env, [{
      beachId: "b1",
      estimate: { color: "yellow", updated: "2026-09-09T12:00:00Z" },
      estimateExpires: 5000,
      official: { color: "red", updated: "2026-09-09T11:40:00Z", official: true },
      officialExpires: 6000,
      wqfloor: { color: "red", kind: "ecoli" },
      wqfloorExpires: 7000,
      reading: { waterTempF: 70 },
      readingExpires: 8000
    }]));

    const after = env.stateOf("b1");
    expect(after.wave).toBe(before.wave);
    expect(after.wave).toBe(JSON.stringify(record));
    expect(after.wave_expires).toBe(4000);
    expect(after.estimate_color).toBe("yellow");
  });
});

describe("estimateCasStatement", function () {
  it("sets only the blob and the color, gated on the standing instant", function () {
    const estimate = { color: "red", updated: "2026-09-09T12:00:00Z" };
    const stmt = estimateCasStatement(recordingDb(), "b1", estimate, "2026-09-09T12:00:00Z");
    expect(stmt.sql).toBe(
      "UPDATE beach_state SET estimate = ?1, estimate_color = ?2 " +
      "WHERE beach_id = ?3 AND estimate_updated = ?4"
    );
    expect(stmt.args).toEqual([
      JSON.stringify(estimate), "red", "b1", "2026-09-09T12:00:00Z"
    ]);
    expect(stmt.sql.indexOf("wave")).toBe(-1);
  });

  it("changes nothing once the standing instant moved on", async function () {
    const env = makeD1();
    env.seedBeaches([{ id: "b1" }]);
    env.seedState("b1", {
      estimate: { color: "green", updated: "2026-09-09T12:00:00Z" },
      estimate_color: "green",
      estimate_updated: "2026-09-09T12:00:00Z",
      estimate_expires: 9999
    });
    const stale = await env.batch([
      estimateCasStatement(env, "b1", { color: "red" }, "2026-09-09T11:00:00Z")
    ]);
    expect(stale[0].meta.changes).toBe(0);
    const hit = await env.batch([
      estimateCasStatement(env, "b1", { color: "red" }, "2026-09-09T12:00:00Z")
    ]);
    expect(hit[0].meta.changes).toBe(1);
    const row = env.stateOf("b1");
    expect(row.estimate_color).toBe("red");
    expect(row.estimate_updated).toBe("2026-09-09T12:00:00Z");
    expect(row.estimate_expires).toBe(9999);
  });
});

describe("chunkStatements", function () {
  it("chunks at 200 and keeps order", function () {
    const statements = [];
    for (let i = 0; i < 401; i = i + 1) {
      statements.push(i);
    }
    const chunks = chunkStatements(statements);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(200);
    expect(chunks[1].length).toBe(200);
    expect(chunks[2]).toEqual([400]);
    expect(chunks[0][0]).toBe(0);
    expect(chunks[1][0]).toBe(200);
  });

  it("yields one chunk at exactly 200 and none for an empty array", function () {
    const statements = [];
    for (let i = 0; i < 200; i = i + 1) {
      statements.push(i);
    }
    expect(chunkStatements(statements).length).toBe(1);
    expect(chunkStatements([])).toEqual([]);
  });
});
