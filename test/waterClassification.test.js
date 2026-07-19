// test/waterClassification.test.js
// Cron behavior for runWaterClassification (cron "37 1,7,13,19 * * *"): drain a
// bounded batch, write water_class + version on a decision (resetting
// attempts), bump attempts on a CLEAN-BUT-EMPTY probe, and NEVER bump on a
// transient Overpass failure. The Overpass endpoint is stubbed via fetch so
// the real fetchWaterClassSignals / classifyWaterBody path runs end to end.
import { describe, it, expect, vi, afterEach } from "vitest";
import { runScheduledCron } from "./helpers/cron.js";
import { WATER_CLASS_VERSION } from "../src/waterClass.js";

// DB stub: .all() serves the candidate rows for the SELECT, .first() serves the
// COUNT queries (parked / hidden_inland), and every .bind().run() is recorded
// with its SQL + args.
function makeClassEnv(candidateRows) {
  const runCalls = [];
  const env = {
    DB: {
      prepare: function (sql) {
        return {
          all: function () {
            return Promise.resolve({ results: candidateRows });
          },
          first: function () {
            return Promise.resolve({ n: 0 });
          },
          bind: function () {
            const args = Array.prototype.slice.call(arguments);
            return {
              sql: sql,
              args: args,
              run: function () {
                runCalls.push({ sql: sql, args: args });
                return Promise.resolve({ success: true });
              }
            };
          }
        };
      }
    }
  };
  return { env: env, runCalls: runCalls };
}

function runClassifyCron(env) {
  return runScheduledCron(env, "37 1,7,13,19 * * *");
}

// Overpass JSON body carrying the given elements, honoring the OK/remark shape
// the real runQuery inspects.
function overpassOk(elements) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve({ elements: elements }); }
  });
}

describe("runWaterClassification", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("classifies a Great Lake beach: writes water_class + version, resets attempts", async function () {
    vi.stubGlobal("fetch", function () {
      // A water=lake relation carrying an allowlisted QID within range.
      return overpassOk([
        { type: "relation", id: 1, tags: { natural: "water", water: "lake", wikidata: "Q1169" } }
      ]);
    });

    const made = makeClassEnv([
      { id: "osm-way-1", osm_id: "way/1", lat: 43.6, lon: -86.5 }
    ]);
    await runClassifyCron(made.env);

    const classUpdates = made.runCalls.filter(function (c) {
      return c.sql.indexOf("SET water_class = ?1") !== -1;
    });
    expect(classUpdates.length).toBe(1);
    expect(classUpdates[0].args).toEqual(["great_lake", WATER_CLASS_VERSION, "osm-way-1"]);
    // No attempts bump for a decided row.
    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("water_class_attempts + 1") !== -1;
    })).toBe(false);
  });

  it("bumps attempts on a CLEAN-BUT-EMPTY probe (found nothing usable)", async function () {
    vi.stubGlobal("fetch", function () {
      return overpassOk([]); // clean 200, zero elements -> classifyWaterBody null
    });

    const made = makeClassEnv([
      { id: "osm-node-empty", osm_id: "node/9", lat: 43.0, lon: -85.0 }
    ]);
    await runClassifyCron(made.env);

    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("SET water_class = ?1") !== -1;
    })).toBe(false);
    const bumps = made.runCalls.filter(function (c) {
      return c.sql.indexOf("water_class_attempts + 1") !== -1;
    });
    expect(bumps.length).toBe(1);
    expect(bumps[0].args).toEqual(["osm-node-empty"]);
  });

  it("does NOT bump attempts on a transient Overpass failure (HTTP error)", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.resolve({ ok: false, status: 504 });
    });

    const made = makeClassEnv([
      { id: "osm-way-flaky", osm_id: "way/7", lat: 43.0, lon: -85.0 }
    ]);
    await runClassifyCron(made.env);

    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("SET water_class = ?1") !== -1;
    })).toBe(false);
    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("water_class_attempts + 1") !== -1;
    })).toBe(false);
  });

  it("does NOT bump attempts on a truncation remark (partial result treated as failure)", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () {
          return Promise.resolve({ remark: "runtime error: Query timed out", elements: [] });
        }
      });
    });

    const made = makeClassEnv([
      { id: "osm-way-remark", osm_id: "way/8", lat: 43.0, lon: -85.0 }
    ]);
    await runClassifyCron(made.env);

    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("water_class_attempts + 1") !== -1;
    })).toBe(false);
    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("SET water_class = ?1") !== -1;
    })).toBe(false);
  });

  it("classifies inland when nearby way-water is present but no coastline / allowlisted lake", async function () {
    vi.stubGlobal("fetch", function () {
      return overpassOk([
        // A big-enough natural=water way (0.003 x 0.003 deg = 9e-6 > 5e-6).
        { type: "way", id: 2, tags: { natural: "water" },
          bounds: { minlat: 43.0, minlon: -85.0, maxlat: 43.003, maxlon: -84.997 } }
      ]);
    });

    const made = makeClassEnv([
      { id: "osm-way-inland", osm_id: "way/2", lat: 43.0, lon: -85.0 }
    ]);
    await runClassifyCron(made.env);

    const classUpdates = made.runCalls.filter(function (c) {
      return c.sql.indexOf("SET water_class = ?1") !== -1;
    });
    expect(classUpdates.length).toBe(1);
    expect(classUpdates[0].args).toEqual(["inland", WATER_CLASS_VERSION, "osm-way-inland"]);
  });

  it("isolates per-beach: one flaky fetch leaves its row untouched, the next still classifies", async function () {
    let call = 0;
    vi.stubGlobal("fetch", function () {
      call = call + 1;
      if (call === 1) {
        return Promise.reject(new Error("network down"));
      }
      return overpassOk([
        { type: "way", id: 3, tags: { natural: "coastline" },
          bounds: { minlat: 41.0, minlon: -82.5, maxlat: 41.1, maxlon: -82.4 } }
      ]);
    });

    const made = makeClassEnv([
      { id: "osm-way-a", osm_id: "way/10", lat: 43.0, lon: -85.0 },
      { id: "osm-way-b", osm_id: "way/11", lat: 41.05, lon: -82.45 }
    ]);
    await runClassifyCron(made.env);

    // First row: transient -> neither classified nor bumped.
    expect(made.runCalls.some(function (c) {
      return c.args.indexOf("osm-way-a") !== -1;
    })).toBe(false);
    // Second row: ocean classified.
    const classUpdates = made.runCalls.filter(function (c) {
      return c.sql.indexOf("SET water_class = ?1") !== -1;
    });
    expect(classUpdates.length).toBe(1);
    expect(classUpdates[0].args).toEqual(["ocean", WATER_CLASS_VERSION, "osm-way-b"]);
  });
});
