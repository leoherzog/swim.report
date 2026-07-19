// Cron input-assembly test for runFlagRecompute (via the scheduled handler):
// verifies the alertsCheckable wiring — a beach with neither nws_zone nor
// eccc_zone (not yet enriched for either authority) must get an estimate
// whose reason carries the explicit "Weather alerts not yet available for
// this beach" caveat, while an enriched beach whose alerts fetch merely
// failed this run must NOT.
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
    eccc_zone: null,
    eccc_attempts: 0,
    marine_zone: null,
    marine_attempts: 0,
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

// kvSeed pre-populates KV reads (e.g. a "waveinput:" + id payload the hourly
// estimate reads); values are the already-parsed objects a { type: "json" } get
// resolves to. The env also zeroes the wave cron's pacing so batchByBeach never
// arms a real timer (its gap/retry sleeps) during a test.
function makeEnv(beachRows, kvSeed) {
  const kvPuts = new Map();
  const kvGets = kvSeed instanceof Map
    ? kvSeed
    : new Map(Object.entries(kvSeed || {}));
  const env = {
    OPEN_METEO_BATCH_GAP_MS: 0,
    OPEN_METEO_RETRY_MS: 0,
    OPEN_METEO_CONCURRENCY: 8,
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
      get: function (key) {
        return Promise.resolve(kvGets.has(key) ? kvGets.get(key) : null);
      },
      put: function (key, value, opts) {
        kvPuts.set(key, { value: value, opts: opts });
        return Promise.resolve();
      }
    }
  };
  return { env: env, kvPuts: kvPuts, kvGets: kvGets };
}

function runHourlyCron(env) {
  return runScheduledCron(env, "0 * * * *");
}

function runWaveCron(env) {
  return runScheduledCron(env, "15 */6 * * *");
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

  it("a successful alerts fetch lands its per-alert details in the flag payload", async function () {
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target.indexOf("api.weather.gov/alerts/active") !== -1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () {
            return Promise.resolve({
              features: [{
                properties: {
                  event: "Beach Hazards Statement",
                  onset: "2026-07-15T14:00:00Z",
                  ends: "2026-07-16T06:00:00Z",
                  // National feed: the feature must self-identify its zones so
                  // nwsAlertsForZone can match the beach's nws_zone "MIZ071".
                  geocode: { UGC: ["MIZ071"] },
                  affectedZones: ["https://api.weather.gov/zones/forecast/MIZ071"]
                }
              }]
            });
          }
        });
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({
        id: "osm-node-3",
        name: "Test Beach Gamma",
        nws_zone: "MIZ071",
        nws_grid_url: null // no WFO -> SRF skipped
      })
    ]);
    await runHourlyCron(made.env);

    const estimate = JSON.parse(made.kvPuts.get("flag:osm-node-3").value);
    expect(estimate.color).toBe("red");
    expect(estimate.reason).toBe("Active NWS alert: Beach Hazards Statement");
    // The structured echo the detail page's hazard lane consumes.
    expect(estimate.alertDetails).toEqual([{
      event: "Beach Hazards Statement",
      onset: "2026-07-15T14:00:00Z",
      ends: "2026-07-16T06:00:00Z"
    }]);
    expect(estimate.ripCurrentRisk).toBeNull();
  });

  it("marine-zone alert (Gale Warning) matched via marine_zone -> red, NWS Marine Alerts source", async function () {
    // The national feed carries a Gale Warning zoned to the MARINE zone LMZ874,
    // not the beach's land nws_zone. The recompute must match it via marine_zone
    // and merge it into the estimate.
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target.indexOf("api.weather.gov/alerts/active") !== -1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () {
            return Promise.resolve({
              features: [{
                properties: {
                  event: "Gale Warning",
                  onset: "2026-07-15T14:00:00Z",
                  ends: "2026-07-16T06:00:00Z",
                  geocode: { UGC: ["LMZ874"] },
                  affectedZones: ["https://api.weather.gov/zones/marine/LMZ874"]
                }
              }]
            });
          }
        });
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({
        id: "osm-node-4",
        name: "Test Beach Delta",
        nws_zone: "MIZ056",
        marine_zone: "LMZ874",
        nws_grid_url: null // no WFO -> SRF skipped
      })
    ]);
    await runHourlyCron(made.env);

    const estimate = JSON.parse(made.kvPuts.get("flag:osm-node-4").value);
    expect(estimate.color).toBe("red");
    expect(estimate.reason).toBe("Active NWS alert: Gale Warning");
    expect(estimate.alertDetails).toEqual([{
      event: "Gale Warning",
      onset: "2026-07-15T14:00:00Z",
      ends: "2026-07-16T06:00:00Z"
    }]);
    const sourceLabels = estimate.sources.map(function (s) { return s.label; });
    expect(sourceLabels).toContain("NWS Marine Alerts");
  });

  it("marine Small Craft Advisory floors a wave green up to yellow via marine_zone", async function () {
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target.indexOf("api.weather.gov/alerts/active") !== -1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () {
            return Promise.resolve({
              features: [{
                properties: {
                  event: "Small Craft Advisory",
                  onset: null,
                  ends: null,
                  geocode: { UGC: ["LMZ874"] },
                  affectedZones: []
                }
              }]
            });
          }
        });
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    // Seed a calm wave input (< 2 ft) so steps 1-5 land on green; the marine
    // advisory floor (step 6) must raise it to yellow.
    const made = makeEnv(
      [
        makeBeachRow({
          id: "osm-node-5",
          name: "Test Beach Epsilon",
          nws_zone: "MIZ056",
          marine_zone: "LMZ874",
          nws_grid_url: null
        })
      ],
      { "waveinput:osm-node-5": { waveHeightFt: 1.0, model: "ecmwf_wam025" } }
    );
    await runHourlyCron(made.env);

    const estimate = JSON.parse(made.kvPuts.get("flag:osm-node-5").value);
    expect(estimate.color).toBe("yellow");
    expect(estimate.reason).toBe("Active NWS alert: Small Craft Advisory");
    expect(estimate.trigger).toBe("nws-floor");
  });

  it("Canadian beach (eccc_zone set) with a containing ECCC alert polygon -> ECCC red, no caveat", async function () {
    // Stub GeoMet: one active severe thunderstorm warning whose region
    // polygon contains the Colchester Beach point. Everything else fails so
    // waves/wind/SRF are null and the alert decides the color.
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target.indexOf("api.weather.gc.ca/collections/weather-alerts/items") !== -1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () {
            return Promise.resolve({
              features: [{
                type: "Feature",
                properties: {
                  alert_name_en: "severe thunderstorm warning",
                  status_en: "issued",
                  validity_datetime: "2026-07-18T11:00:00.000Z",
                  event_end_datetime: "2026-07-18T21:00:00.000Z"
                },
                geometry: {
                  type: "Polygon",
                  coordinates: [[
                    [-83.2, 41.7], [-82.6, 41.7], [-82.6, 42.3], [-83.2, 42.3], [-83.2, 41.7]
                  ]]
                }
              }]
            });
          }
        });
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({
        id: "osm-way-175343424",
        name: "Colchester Beach",
        lat: 41.9836774,
        lon: -82.9343626,
        eccc_zone: "Windsor - Essex - Chatham-Kent",
        enrichment_attempts: 5
      })
    ]);
    await runHourlyCron(made.env);

    const estimate = JSON.parse(made.kvPuts.get("flag:osm-way-175343424").value);
    expect(estimate.color).toBe("red");
    expect(estimate.reason).toBe("Active Environment Canada alert: severe thunderstorm warning");
    expect(estimate.reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT)).toBe(-1);
    expect(estimate.alertDetails).toEqual([{
      event: "severe thunderstorm warning",
      onset: "2026-07-18T11:00:00.000Z",
      ends: "2026-07-18T21:00:00.000Z"
    }]);
    expect(estimate.sources).toEqual([{
      label: "Environment Canada Alerts",
      url: "https://weather.gc.ca/warnings/index_e.html"
    }]);
  });

  it("Canadian beach outside every alert polygon -> alerts checked ([]), no caveat", async function () {
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target.indexOf("api.weather.gc.ca/collections/weather-alerts/items") !== -1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () { return Promise.resolve({ features: [] }); }
        });
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({
        id: "osm-node-ca-1",
        name: "Sunset Beach",
        lat: 46.2686243,
        lon: -83.2821572,
        eccc_zone: "Blind River - Thessalon",
        enrichment_attempts: 5
      })
    ]);
    await runHourlyCron(made.env);

    const estimate = JSON.parse(made.kvPuts.get("flag:osm-node-ca-1").value);
    expect(estimate.color).toBe("unknown");
    expect(estimate.reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT)).toBe(-1);
    // The successful (empty) alerts check still names its source.
    expect(estimate.sources).toEqual([{
      label: "Environment Canada Alerts",
      url: "https://weather.gc.ca/warnings/index_e.html"
    }]);
  });

  it("Canadian beach with a failed ECCC fetch gets NO caveat (transient failure, alerts were checkable)", async function () {
    const made = makeEnv([
      makeBeachRow({
        id: "osm-node-ca-2",
        name: "Colchester Beach",
        lat: 41.9836774,
        lon: -82.9343626,
        eccc_zone: "Windsor - Essex - Chatham-Kent",
        enrichment_attempts: 5
      })
    ]);
    await runHourlyCron(made.env);

    const estimate = JSON.parse(made.kvPuts.get("flag:osm-node-ca-2").value);
    expect(estimate.color).toBe("unknown");
    expect(estimate.reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT)).toBe(-1);
    expect(estimate.sources).toEqual([]);
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

// The 6-hourly WAVE cron (runWaveRefresh) owns all Open-Meteo/GLOS fetching. It
// writes a "waveinput:" + id payload (what the hourly estimate reads for wave
// height + the wind fallback) and, only when the beach has a real hourly wave
// series (>=1 finite cell), a "waves:" + id WaveSeries for the detail-page
// strip. A fetch failure leaves both keys untouched (last-good rides the TTL);
// an all-masked series with no buoy/wind writes neither. Both use the 7 h
// wave-data TTL (25200 s), not the 2 h flag TTL.
const WAVE_DATA_TTL = 25200;
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

describe("runWaveRefresh wave inputs + series (waveinput:/waves: KV)", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("writes a 24-entry WaveSeries anchored to the run's top-of-hour, plus the waveinput", async function () {
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
    await runWaveCron(made.env);

    // The waveinput put carries the current wave height + model for the
    // estimate, at the wave-data TTL.
    const inputPut = made.kvPuts.get("waveinput:osm-node-1");
    expect(inputPut).toBeDefined();
    expect(inputPut.opts).toEqual({ expirationTtl: WAVE_DATA_TTL });
    const input = JSON.parse(inputPut.value);
    expect(input.beachId).toBe("osm-node-1");
    expect(input.model).toBe("ecmwf_wam025");
    // 0.5 m -> ~1.6404 ft.
    expect(input.waveHeightFt).toBeCloseTo(1.64042, 4);
    expect(input.windSpeedMph).toBe(null);
    expect(input.updated).toBe("2026-07-15T16:20:33.000Z");

    // The waves put is present with the specced shape.
    const wavesPut = made.kvPuts.get("waves:osm-node-1");
    expect(wavesPut).toBeDefined();
    expect(wavesPut.opts).toEqual({ expirationTtl: WAVE_DATA_TTL });
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

  it("writes NEITHER key when the marine series is fully masked with no buoy/wind", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));

    // Marine returns a real series shape but every model masked (null) — the
    // Great Lakes norm. Buoy gap-fill and wind both fall through to null here,
    // so there is nothing usable to record; the old keys expire on their own.
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
    await runWaveCron(made.env);

    expect(made.kvPuts.get("waveinput:osm-node-1")).toBeUndefined();
    expect(made.kvPuts.get("waves:osm-node-1")).toBeUndefined();
  });

  it("writes NEITHER key when the marine fetch fails entirely (last-good rides the TTL)", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1", lat: 44.8, lon: -83.3 })
    ]);
    await runWaveCron(made.env);

    expect(made.kvPuts.get("waveinput:osm-node-1")).toBeUndefined();
    expect(made.kvPuts.get("waves:osm-node-1")).toBeUndefined();
  });

  it("buoy gap-fill writes a waveinput reading but never a waves: series", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));

    // Marine masked -> beach is wave-null -> GLOS Seagull buoy gap-fills a
    // now-observation. The buoy carries no hourly series, so the preserved
    // (all-masked) hoursFt must yield no waves: put even though waveinput gets
    // the buoy reading.
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
    await runWaveCron(made.env);

    const inputPut = made.kvPuts.get("waveinput:osm-node-1");
    expect(inputPut).toBeDefined();
    const input = JSON.parse(inputPut.value);
    // The buoy reading (1.0 m -> ~3.28 ft) is recorded for the estimate.
    expect(input.waveHeightFt).toBeCloseTo(3.28084, 4);
    // ...but there is no hourly series to publish.
    expect(made.kvPuts.get("waves:osm-node-1")).toBeUndefined();
  });
});

// The hourly estimate no longer fetches Open-Meteo — it READS the wave cron's
// "waveinput:" + id KV. A seeded wave height must flow through to the flag
// color; a missing key must degrade honestly (no wave input, no crash).
describe("runFlagRecompute reads waveinput: KV", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("uses a seeded wave height (>=4 ft -> red) with the model's source label", async function () {
    // No network needed: the hourly path only reads KV. Fail all fetch to
    // prove no upstream call is reachable from the request-assembly path.
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const seed = new Map();
    seed.set("waveinput:osm-node-1", {
      beachId: "osm-node-1",
      waveHeightFt: 4.5,
      model: "ecmwf_wam025",
      windSpeedMph: null,
      windGustMph: null,
      updated: "2026-07-15T12:00:00.000Z"
    });

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1", lat: 44.8, lon: -83.3 })
    ], seed);
    await runHourlyCron(made.env);

    const flagPut = made.kvPuts.get("flag:osm-node-1");
    expect(flagPut).toBeDefined();
    const estimate = JSON.parse(flagPut.value);
    // 4.5 ft crosses the 4 ft red threshold.
    expect(estimate.color).toBe("red");
    const labels = estimate.sources.map(function (s) { return s.label; });
    expect(labels).toContain("ECMWF Wave Forecast");
    // The hourly path must never write the strip series (that is the wave cron).
    expect(made.kvPuts.get("waves:osm-node-1")).toBeUndefined();
  });

  it("degrades to unknown when no waveinput: key exists", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1", lat: 44.8, lon: -83.3 })
    ]);
    await runHourlyCron(made.env);

    const flagPut = made.kvPuts.get("flag:osm-node-1");
    expect(flagPut).toBeDefined();
    expect(JSON.parse(flagPut.value).color).toBe("unknown");
  });
});
