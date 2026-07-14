// Cron input-assembly test for runFlagRecompute (via the scheduled handler):
// verifies the alertsCheckable wiring — a beach whose nws_zone is still NULL
// (not yet NWS-enriched) must get an estimate whose reason carries the
// explicit "NWS alerts not yet available for this beach" caveat, while an
// enriched beach whose alerts fetch merely failed this run must NOT.
// The network is stubbed to fail entirely, so every client returns null and
// both beaches land on the honest "unknown" terminal fallback.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ALERTS_UNAVAILABLE_CAVEAT } from "../src/rules.js";
import { runScheduledCron } from "./helpers/cron.js";

function makeBeachRow(overrides) {
  const row = {
    id: "osm-node-1",
    name: "Test Beach Alpha",
    park_name: null,
    // Lake Huron shoreline near Alpena MI — outside every registered
    // official-scraper bbox so step 8 stays quiet in this test.
    lat: 44.8,
    lon: -83.3,
    nws_zone: null,
    nws_grid_url: null,
    osm_id: "node/1",
    enrichment_attempts: 0,
    recompute_updated: null,
    webcam_id: null,
    webcam_title: null,
    webcam_player_url: null,
    webcam_checked: null
  };
  const extra = overrides || {};
  for (const key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) {
      row[key] = extra[key];
    }
  }
  return row;
}

function makeEnv(beachRows) {
  const kvPuts = new Map();
  const env = {
    DB: {
      prepare: function (sql) {
        return {
          all: function () {
            return Promise.resolve({ results: beachRows });
          },
          bind: function () {
            return { sql: sql };
          }
        };
      },
      batch: function (statements) {
        return Promise.resolve(statements.map(function () { return { success: true }; }));
      }
    },
    FLAGS: {
      get: function () {
        return Promise.resolve(null);
      },
      put: function (key, value, opts) {
        kvPuts.set(key, { value: value, opts: opts });
        return Promise.resolve();
      }
    }
  };
  return { env: env, kvPuts: kvPuts };
}

function runHourlyCron(env) {
  return runScheduledCron(env, "0 * * * *");
}

describe("runFlagRecompute input assembly - alertsCheckable", function () {
  beforeEach(function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });
  });

  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("unenriched beach (nws_zone NULL) gets the alerts-unavailable caveat", async function () {
    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1", nws_zone: null, nws_grid_url: null })
    ]);
    await runHourlyCron(made.env);

    const put = made.kvPuts.get("flag:osm-node-1");
    expect(put).toBeDefined();
    expect(put.opts).toEqual({ expirationTtl: 7200 });
    const estimate = JSON.parse(put.value);
    expect(estimate.color).toBe("unknown");
    expect(estimate.official).toBe(false);
    expect(estimate.reason).toBe(
      "No usable data from NWS alerts, surf zone forecast, or Open-Meteo wave and wind models (" +
      ALERTS_UNAVAILABLE_CAVEAT + ")"
    );
  });

  it("enriched beach with a failed alerts fetch gets NO caveat", async function () {
    const made = makeEnv([
      makeBeachRow({
        id: "osm-node-2",
        name: "Test Beach Beta",
        nws_zone: "MIZ071",
        nws_grid_url: "https://api.weather.gov/gridpoints/GRR/33,33"
      })
    ]);
    await runHourlyCron(made.env);

    const put = made.kvPuts.get("flag:osm-node-2");
    expect(put).toBeDefined();
    const estimate = JSON.parse(put.value);
    expect(estimate.color).toBe("unknown");
    expect(estimate.reason).toBe(
      "No usable data from NWS alerts, surf zone forecast, or Open-Meteo wave and wind models"
    );
    expect(estimate.reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT)).toBe(-1);
  });

  it("mixed table: only the unenriched beach carries the caveat", async function () {
    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1", nws_zone: null, nws_grid_url: null }),
      makeBeachRow({
        id: "osm-node-2",
        name: "Test Beach Beta",
        nws_zone: "MIZ071",
        nws_grid_url: "https://api.weather.gov/gridpoints/GRR/33,33"
      })
    ]);
    await runHourlyCron(made.env);

    const first = JSON.parse(made.kvPuts.get("flag:osm-node-1").value);
    const second = JSON.parse(made.kvPuts.get("flag:osm-node-2").value);
    expect(first.reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT)).toBeGreaterThan(-1);
    expect(second.reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT)).toBe(-1);
  });
});

// flag_history (migration 0006) is the calibration signal: one row per beach
// per run ONLY when that beach has BOTH a fresh estimate AND a scraped official
// color this run. Estimate-only rows must never be logged, or the table would
// grow with all ~613 beaches hourly.
function makeBatchRecordingEnv(beachRows) {
  const kvPuts = new Map();
  const kvStore = new Map();
  const batchCalls = [];
  const env = {
    DB: {
      prepare: function (sql) {
        return {
          all: function () {
            return Promise.resolve({ results: beachRows });
          },
          bind: function () {
            const args = Array.prototype.slice.call(arguments);
            return { sql: sql, args: args };
          }
        };
      },
      batch: function (statements) {
        batchCalls.push(statements);
        return Promise.resolve(statements.map(function () { return { success: true }; }));
      }
    },
    FLAGS: {
      get: function (key) {
        return Promise.resolve(kvStore.has(key) ? kvStore.get(key) : null);
      },
      put: function (key, value, opts) {
        kvStore.set(key, value);
        kvPuts.set(key, { value: value, opts: opts });
        return Promise.resolve();
      }
    }
  };
  return { env: env, kvPuts: kvPuts, batchCalls: batchCalls };
}

function findHistoryStatements(batchCalls) {
  const rows = [];
  for (const statements of batchCalls) {
    for (const statement of statements) {
      if (statement.sql && statement.sql.indexOf("INSERT INTO flag_history") !== -1) {
        rows.push(statement);
      }
    }
  }
  return rows;
}

describe("runFlagRecompute flag_history calibration logging", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("logs a paired row only for a beach with BOTH an estimate and an official color", async function () {
    // Freeze the clock inside South Haven's monitored season/hours (July,
    // ~noon Detroit EDT) so the scraper does not gate itself off. Only Date is
    // faked so the network stub's real timers keep working.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));

    // Stub the network: fail the South Haven flag page (forces the CSV
    // fallback), serve a real CSV for the Google export, and reject everything
    // else so alerts/waves/wind all return null.
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target.indexOf("southhavenmi.gov") !== -1) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      if (target.indexOf("docs.google.com") !== -1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: function () { return Promise.resolve("Flag #6 North Beach is Red"); }
        });
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    // Beach inside the South Haven bbox, name resolves to the North Beach site.
    const made = makeBatchRecordingEnv([
      makeBeachRow({
        id: "osm-node-sh",
        name: "North Beach",
        lat: 42.406,
        lon: -86.28,
        nws_zone: null,
        nws_grid_url: null
      }),
      // Alpena beach: gets an estimate but matches no scraper -> no official ->
      // must NOT appear in flag_history.
      makeBeachRow({ id: "osm-node-alpena", name: "Alpena Beach", lat: 44.8, lon: -83.3 })
    ]);
    await runHourlyCron(made.env);

    // Sanity: both beaches got an estimate, only South Haven got an official.
    expect(made.kvPuts.get("flag:osm-node-sh")).toBeDefined();
    expect(made.kvPuts.get("flag:osm-node-alpena")).toBeDefined();
    const official = made.kvPuts.get("official:osm-node-sh");
    expect(official).toBeDefined();
    expect(JSON.parse(official.value).color).toBe("red");

    const historyRows = findHistoryStatements(made.batchCalls);
    expect(historyRows.length).toBe(1);
    const args = historyRows[0].args;
    // VALUES (beach_id, observed_at, estimated_color, official_color, rules_version, official_source)
    expect(args[0]).toBe("osm-node-sh");
    expect(args[1]).toBe("2026-07-15T16:00:00.000Z");
    expect(args[2]).toBe("unknown");        // estimated (all upstreams null)
    expect(args[3]).toBe("red");            // official from the CSV
    expect(typeof args[4]).toBe("string");  // rules_version
    expect(args[4].length).toBeGreaterThan(0);
    expect(args[5]).toBe("south-haven-mi"); // official_source = scraperId
  });

  it("logs NOTHING when no beach has an official color (estimate-only rows are not recorded)", async function () {
    // Network fully disabled: every scraper returns null, so no official flag
    // exists for any beach and the calibration table must stay empty.
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeBatchRecordingEnv([
      makeBeachRow({ id: "osm-node-1" }),
      makeBeachRow({ id: "osm-node-2", name: "Test Beach Beta", lat: 44.81, lon: -83.31 })
    ]);
    await runHourlyCron(made.env);

    // Estimates were still written for both beaches...
    expect(made.kvPuts.get("flag:osm-node-1")).toBeDefined();
    expect(made.kvPuts.get("flag:osm-node-2")).toBeDefined();
    // ...but no flag_history INSERT was batched.
    expect(findHistoryStatements(made.batchCalls).length).toBe(0);
  });
});

// The hourly cron writes a "waves:" + beachId WaveSeries alongside each "flag:"
// put, but ONLY when the beach has a real hourly wave series (>=1 finite cell).
// A fetch failure, an all-masked series, or a buoy-only gap-fill (no series)
// writes no "waves:" key, while the "flag:" put is always made.
const MARINE_HOST = "marine-api.open-meteo.com";
const OPEN_METEO_MARINE_URL = "https://open-meteo.com/en/docs/marine-weather-api";

// A 48-entry hourly series (forecast_days=2, timezone=UTC) of one repeated
// wave height in METERS — matching what the real /v1/marine endpoint returns.
function waveSeries48(meters) {
  const arr = [];
  for (let h = 0; h < 48; h++) {
    arr.push(meters);
  }
  return arr;
}

// Build a marine JSON payload for 'count' locations, each carrying the given
// per-model 48-entry hourly wave_height arrays. 'models' maps model id ->
// meters value (null for a fully masked model).
function marinePayload(count, models) {
  const locations = [];
  for (let i = 0; i < count; i++) {
    const hourly = {};
    for (const model in models) {
      if (Object.prototype.hasOwnProperty.call(models, model)) {
        hourly["wave_height_" + model] = waveSeries48(models[model]);
      }
    }
    locations.push({ hourly: hourly });
  }
  return locations;
}

function marineOkResponse(payload) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve(payload); }
  });
}

describe("runFlagRecompute wave series (waves: KV)", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("writes a 24-entry WaveSeries anchored to the run's top-of-hour, plus the flag", async function () {
    // Freeze Date so the hour index (16) and top-of-hour startIso are
    // deterministic; only Date is faked so real timers are untouched.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:20:33Z"));

    // Marine payload: only the first model (ecmwf_wam025) is populated, so the
    // series resolves to a single model and the source label names it.
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target.indexOf(MARINE_HOST) !== -1) {
        return marineOkResponse(marinePayload(1, { ecmwf_wam025: 0.5 }));
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1", lat: 44.8, lon: -83.3 })
    ]);
    await runHourlyCron(made.env);

    // The flag put is always present.
    const flagPut = made.kvPuts.get("flag:osm-node-1");
    expect(flagPut).toBeDefined();

    // The waves put is present with the specced shape.
    const wavesPut = made.kvPuts.get("waves:osm-node-1");
    expect(wavesPut).toBeDefined();
    expect(wavesPut.opts).toEqual({ expirationTtl: 7200 });
    const series = JSON.parse(wavesPut.value);
    expect(series.beachId).toBe("osm-node-1");
    expect(series.startIso).toBe("2026-07-15T16:00:00.000Z");
    expect(series.updated).toBe("2026-07-15T16:20:33.000Z");
    expect(Array.isArray(series.hoursFt)).toBe(true);
    expect(series.hoursFt.length).toBe(24);
    // 0.5 m -> ~1.6404 ft, raw (unrounded) floats.
    expect(series.hoursFt[0]).toBeCloseTo(1.64042, 4);
    expect(series.models).toEqual(["ecmwf_wam025"]);
    expect(series.sources).toEqual([
      { label: "ECMWF Wave Forecast", url: OPEN_METEO_MARINE_URL }
    ]);
    // Per-model series ride along for the model-comparison UI; only models
    // with >= 1 finite hour appear, aligned with hoursFt.
    expect(Object.keys(series.byModel)).toEqual(["ecmwf_wam025"]);
    expect(series.byModel["ecmwf_wam025"].length).toBe(24);
    expect(series.byModel["ecmwf_wam025"][0]).toBe(series.hoursFt[0]);
  });

  it("writes NO waves: when the marine series is fully masked (all-null), but still writes flag:", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));

    // Marine returns a real series shape but every model masked (null) — the
    // Great Lakes norm. Buoy gap-fill and wind both fall through to null here.
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target.indexOf(MARINE_HOST) !== -1) {
        return marineOkResponse(marinePayload(1, { ecmwf_wam025: null }));
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1", lat: 44.8, lon: -83.3 })
    ]);
    await runHourlyCron(made.env);

    expect(made.kvPuts.get("flag:osm-node-1")).toBeDefined();
    expect(made.kvPuts.get("waves:osm-node-1")).toBeUndefined();
  });

  it("writes NO waves: when the marine fetch fails entirely, but still writes flag:", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1", lat: 44.8, lon: -83.3 })
    ]);
    await runHourlyCron(made.env);

    expect(made.kvPuts.get("flag:osm-node-1")).toBeDefined();
    expect(made.kvPuts.get("waves:osm-node-1")).toBeUndefined();
  });

  it("buoy gap-fill supplies the flag reading but never a waves: series", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));

    // Marine masked -> beach is wave-null -> GLOS Seagull buoy gap-fills a
    // now-observation. The buoy carries no hourly series, so the preserved
    // (all-masked) hoursFt must yield no waves: put even though flag: gets the
    // buoy reading.
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target.indexOf(MARINE_HOST) !== -1) {
        return marineOkResponse(marinePayload(1, { ecmwf_wam025: null }));
      }
      if (target.indexOf("obs-datasets.geojson") !== -1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () {
            return Promise.resolve({
              features: [{
                properties: {
                  obs_dataset_id: 100,
                  parameters: [{ standard_name: "sea_surface_wave_significant_height" }]
                },
                geometry: { coordinates: [-83.3, 44.8] }
              }]
            });
          }
        });
      }
      if (target.indexOf("/parameters") !== -1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () {
            return Promise.resolve([
              { parameter_id: 5, standard_name: "sea_surface_wave_significant_height" }
            ]);
          }
        });
      }
      if (target.indexOf("/obs?") !== -1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () {
            return Promise.resolve([{
              obs_dataset_id: 100,
              parameters: [{
                parameter_id: 5,
                observations: [{ timestamp: "2026-07-15T15:55:00Z", value: 1.0 }]
              }]
            }]);
          }
        });
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1", lat: 44.8, lon: -83.3 })
    ]);
    await runHourlyCron(made.env);

    const flagPut = made.kvPuts.get("flag:osm-node-1");
    expect(flagPut).toBeDefined();
    // The buoy reading (1.0 m -> ~3.28 ft) drove a non-unknown estimate.
    expect(JSON.parse(flagPut.value).color).not.toBe("unknown");
    // ...but there is no hourly series to publish.
    expect(made.kvPuts.get("waves:osm-node-1")).toBeUndefined();
  });
});
