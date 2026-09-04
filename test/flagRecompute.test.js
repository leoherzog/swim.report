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
import { HOT_VIEW_WINDOW_MS } from "../src/demandWindow.js";
import { NDBC_HEAD_BYTES } from "../src/waveSources/ndbcBuoys.js";
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
// resolves to.
function makeEnv(beachRows, kvSeed) {
  const kvPuts = new Map();
  const kvGets = kvSeed instanceof Map
    ? kvSeed
    : new Map(Object.entries(kvSeed || {}));
  // Every bind() call is recorded (sql + args) so the demand-ordering tests
  // can assert on the SELECT's ORDER BY shape and its single bound cutoff arg;
  // the returned statement supports BOTH .all() (the candidate SELECT) and
  // .run() (the per-beach UPDATEs), since the same stub backs both call sites.
  const preparedBinds = [];
  // Every env.DB.batch(...) call, in the order D1 received it. The water-temp
  // cron flushes its wave_updated rotation cursor through batch() INCREMENTALLY
  // as the write pool advances, so the cursor tests need the individual flushes,
  // not just a final tally.
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
            preparedBinds.push({ sql: sql, args: args });
            return {
              sql: sql,
              args: args,
              all: function () {
                return Promise.resolve({ results: beachRows });
              },
              run: function () {
                return Promise.resolve({ success: true });
              }
            };
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
        return Promise.resolve(kvGets.has(key) ? kvGets.get(key) : null);
      },
      put: function (key, value, opts) {
        kvPuts.set(key, { value: value, opts: opts });
        return Promise.resolve();
      }
    }
  };
  return {
    env: env,
    kvPuts: kvPuts,
    kvGets: kvGets,
    preparedBinds: preparedBinds,
    batchCalls: batchCalls
  };
}

function runHourlyCron(env) {
  return runScheduledCron(env, "7 * * * *");
}

function runWaterTempCron(env) {
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
      "No usable data from NWS alerts, surf zone forecast, or NOAA wave and wind models (" +
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
      "No usable data from NWS alerts, surf zone forecast, or NOAA wave and wind models"
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
      { "waveinput:osm-node-5": { waveHeightFt: 1.0, model: "noaa_glwu" } }
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
            return {
              sql: sql,
              args: args,
              all: function () {
                return Promise.resolve({ results: beachRows });
              }
            };
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

// The 6-hourly cron writes "watertemp:" + id at the 7 h wave-data TTL (25200 s),
// not the 2 h flag TTL.
const WAVE_DATA_TTL = 25200;

// The hourly estimate never fetches wave data — it READS the "waveinput:" + id
// KV the offline NOAA GRIB pipeline bulk-writes. A seeded wave height must flow
// through to the flag color; a missing key must degrade honestly (no wave
// input, no crash).
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
      model: "noaa_gfswave",
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
    expect(labels).toContain("NOAA GFS Wave Model");
    // The hourly path must never write the strip series (the offline pipeline
    // owns it).
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

describe("scraper health season/cadence gate (healthMonitored)", function () {
  // A deliberate season/cadence pre-fetch skip must be invisible to the
  // health monitor: no streak bump (no months-long false ALERT flood) and no
  // reset. Only genuine in-window nulls count. Date alone is faked so the
  // cron's new Date() lands where each case needs it; timers stay real (the
  // wave-path sleeps are zeroed by the env).
  afterEach(function () {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function southHavenBeach() {
    // Inside the south-haven-mi matches() box (North Beach). south-haven-mi is
    // a season/hours-gated scraper (healthMonitored = isSouthHavenMonitored:
    // May 15-Sept 15, 9am-9pm America/Detroit), so it exercises the deliberate
    // season/cadence pre-fetch skip the same way the retired wisconsin-dnr did.
    return makeBeachRow({ id: "osm-node-sh", name: "North Beach", lat: 42.406, lon: -86.28 });
  }

  function runAt(isoTime, beachRows) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(isoTime));
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });
    const made = makeEnv(beachRows);
    return runHourlyCron(made.env).then(function () { return made; });
  }

  it("off-season (January): the deliberate skip writes NO scraperhealth: key", async function () {
    const made = await runAt("2026-01-15T18:00:00Z", [southHavenBeach()]);
    expect(made.kvPuts.get("scraperhealth:south-haven-mi")).toBeUndefined();
  });

  it("in-season off-hours: still not counted (no scraperhealth: write)", async function () {
    // 2026-07-15T10:00:00Z = 06:00 America/Detroit — in season but before the
    // 9am monitored-hours window, so the pre-fetch skip is deliberate.
    const made = await runAt("2026-07-15T10:00:00Z", [southHavenBeach()]);
    expect(made.kvPuts.get("scraperhealth:south-haven-mi")).toBeUndefined();
  });

  it("in-season monitored hour with a real fetch failure: the null IS counted", async function () {
    // 2026-07-15T16:00:00Z = 12:00 America/Detroit — in season AND inside the
    // 9am-9pm monitored window; the stubbed network failure is a genuine null.
    const made = await runAt("2026-07-15T16:00:00Z", [southHavenBeach()]);
    const put = made.kvPuts.get("scraperhealth:south-haven-mi");
    expect(put).toBeDefined();
    const health = JSON.parse(put.value);
    expect(health.consecutiveNulls).toBe(1);
    expect(health.lastSuccess).toBeNull();
  });
});

// The hourly recompute's wind-fallback wiring: windSpeedMph/windGustMph come
// from the same "waveinput:" KV payload the offline wave pipeline wrote, and the
// { label: "Wind Forecast" } source entry is pushed ONLY when the payload's
// waveHeightFt is null (wind is a fallback, never a co-signal).
describe("runFlagRecompute wind fallback from waveinput: KV", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("wave-null waveinput with 30 mph wind -> red via the wind trigger, Wind Forecast source", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv(
      [
        makeBeachRow({
          id: "osm-node-1",
          // Enriched zone so the estimate carries no alerts-unavailable caveat
          // (the stubbed alerts failure keeps alertsCheckable true).
          nws_zone: "MIZ071"
        })
      ],
      {
        "waveinput:osm-node-1": {
          beachId: "osm-node-1",
          waveHeightFt: null,
          model: null,
          windSpeedMph: 30,
          windGustMph: null,
          updated: "2026-07-15T12:00:00.000Z"
        }
      }
    );
    await runHourlyCron(made.env);

    const put = made.kvPuts.get("flag:osm-node-1");
    expect(put).toBeDefined();
    const estimate = JSON.parse(put.value);
    expect(estimate.color).toBe("red");
    expect(estimate.trigger).toBe("wind");
    expect(estimate.reason).toBe(
      "No wave data; wind 30 mph sustained, n/a mph gusts (at or above 25 mph sustained or 35 mph gust threshold)"
    );
    expect(estimate.sources).toContainEqual({
      label: "Wind Forecast",
      url: "https://polar.ncep.noaa.gov/waves/"
    });
  });

  it("waveinput carrying BOTH a wave height and wind: wave decides, Wind Forecast source is NOT pushed", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv(
      [makeBeachRow({ id: "osm-node-1", nws_zone: "MIZ071" })],
      {
        "waveinput:osm-node-1": {
          beachId: "osm-node-1",
          waveHeightFt: 1.0,
          model: "noaa_gfswave",
          windSpeedMph: 30,
          windGustMph: null,
          updated: "2026-07-15T12:00:00.000Z"
        }
      }
    );
    await runHourlyCron(made.env);

    const estimate = JSON.parse(made.kvPuts.get("flag:osm-node-1").value);
    // The 1.0 ft wave decides green; the 30 mph wind (red-worthy as a
    // fallback) must not override or even appear as a source.
    expect(estimate.color).toBe("green");
    expect(estimate.trigger).toBe("wave-height");
    const labels = estimate.sources.map(function (s) { return s.label; });
    expect(labels).toContain("NOAA GFS Wave Model");
    expect(labels).not.toContain("Wind Forecast");
  });
});

// SRF (Surf Zone Forecast) wiring: step 4 fetches the latest SRF product text
// once per distinct WFO (api.weather.gov /products/types/SRF/locations/<wfo>/
// latest), parses the rip-current risk, and step 6 feeds it into the estimate
// with an "NWS Surf Zone Forecast" source entry.
const SRF_LATEST_URL = "https://api.weather.gov/products/types/SRF/locations/GRR/latest";

describe("runFlagRecompute SRF rip-current wiring", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  function makeSrfFetchStub(urls) {
    return function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      urls.push(target);
      if (target.indexOf("/products/types/SRF/") !== -1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () {
            return Promise.resolve({
              productText: "SRFGRR\n\n.TODAY...\nRIP CURRENT RISK IS HIGH.\n"
            });
          }
        });
      }
      // Alerts and everything else fail (alerts stay null, no caveat since the
      // beach has an nws_zone).
      return Promise.reject(new Error("network disabled in test"));
    };
  }

  it("a successful SRF fetch parsing to HIGH -> red rip-current flag with the SRF source", async function () {
    const urls = [];
    vi.stubGlobal("fetch", makeSrfFetchStub(urls));

    const made = makeEnv([
      makeBeachRow({
        id: "osm-node-1",
        nws_zone: "MIZ071",
        nws_grid_url: "https://api.weather.gov/gridpoints/GRR/33,33"
      })
    ]);
    await runHourlyCron(made.env);

    const put = made.kvPuts.get("flag:osm-node-1");
    expect(put).toBeDefined();
    const estimate = JSON.parse(put.value);
    expect(estimate.color).toBe("red");
    expect(estimate.trigger).toBe("rip-current");
    expect(estimate.reason).toBe("NWS surf zone forecast rip current risk: HIGH");
    expect(estimate.ripCurrentRisk).toBe("HIGH");
    expect(estimate.sources).toContainEqual({
      label: "NWS Surf Zone Forecast",
      url: SRF_LATEST_URL
    });
  });

  it("two beaches sharing a WFO cause exactly ONE SRF fetch (deduped via the wfos set)", async function () {
    const urls = [];
    vi.stubGlobal("fetch", makeSrfFetchStub(urls));

    const made = makeEnv([
      makeBeachRow({
        id: "osm-node-1",
        nws_zone: "MIZ071",
        nws_grid_url: "https://api.weather.gov/gridpoints/GRR/33,33"
      }),
      makeBeachRow({
        id: "osm-node-2",
        name: "Test Beach Beta",
        lat: 44.81,
        lon: -83.31,
        nws_zone: "MIZ056",
        nws_grid_url: "https://api.weather.gov/gridpoints/GRR/40,50"
      })
    ]);
    await runHourlyCron(made.env);

    const srfRequests = urls.filter(function (u) {
      return u.indexOf(SRF_LATEST_URL) !== -1;
    });
    expect(srfRequests.length).toBe(1);

    // Both beaches still received the shared WFO's risk.
    const first = JSON.parse(made.kvPuts.get("flag:osm-node-1").value);
    const second = JSON.parse(made.kvPuts.get("flag:osm-node-2").value);
    expect(first.color).toBe("red");
    expect(first.trigger).toBe("rip-current");
    expect(second.color).toBe("red");
    expect(second.trigger).toBe("rip-current");
  });
});

// Step 8's official: KV TTL: default KV_TTL_SECONDS (7200) unless the scraper
// declares a numeric officialTtlSeconds. No registered scraper currently
// declares one (the override hook is retained as a generic extension point for
// a future reduced-cadence scraper), so only the default branch is exercised.
describe("runFlagRecompute official: KV TTL (default vs officialTtlSeconds)", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a scraper without officialTtlSeconds gets the default 7200 s TTL (south-haven)", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));

    // Same stubbing as the flag_history test: the flag page 500s, the CSV
    // export serves a red flag for North Beach.
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

    const made = makeEnv([
      makeBeachRow({
        id: "osm-node-sh",
        name: "North Beach",
        lat: 42.406,
        lon: -86.28
      })
    ]);
    await runHourlyCron(made.env);

    const official = made.kvPuts.get("official:osm-node-sh");
    expect(official).toBeDefined();
    expect(official.opts).toEqual({ expirationTtl: 7200 });
    expect(JSON.parse(official.value).color).toBe("red");
  });

});

// A corrupt "scraperhealth:" KV value must degrade to prev = null inside the
// health step's own try/catch — restarting the streak — never poison the
// scrape step or the per-beach flag writes.
describe("runFlagRecompute corrupt scraperhealth: KV", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("unparseable health JSON restarts the streak at 1 and the run still completes", async function () {
    // 2026-07-15T16:00:00Z = 12:00 America/Detroit — in season AND inside the
    // monitored 9am-9pm window, so south-haven-mi is health-monitored this run.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    // The health read uses env.FLAGS.get(key) WITHOUT { type: "json" }, so the
    // stand-in hands back this raw corrupt string for JSON.parse to choke on.
    const made = makeEnv(
      [makeBeachRow({ id: "osm-node-sh", name: "North Beach", lat: 42.406, lon: -86.28 })],
      { "scraperhealth:south-haven-mi": "not-json{{" }
    );
    await runHourlyCron(made.env);

    const put = made.kvPuts.get("scraperhealth:south-haven-mi");
    expect(put).toBeDefined();
    expect(JSON.parse(put.value)).toEqual({
      consecutiveNulls: 1,
      lastSuccess: null,
      lastFailure: "2026-07-15T16:00:00.000Z"
    });
    // The corrupt health state never blocked the estimate writes.
    expect(made.kvPuts.get("flag:osm-node-sh")).toBeDefined();
  });
});

// After the per-beach loop, runFlagRecompute batches one
// "UPDATE beaches SET recompute_updated = ?1 WHERE id = ?2" per processed
// beach — the rotation that guarantees full-table coverage. A failed batch is
// swallowed (the flag: puts must survive).
describe("runFlagRecompute recompute_updated rotation stamping", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  function findRecomputeUpdates(batchCalls) {
    const updates = [];
    for (const statements of batchCalls) {
      for (const statement of statements) {
        if (statement.sql &&
            statement.sql.indexOf("UPDATE beaches SET recompute_updated") === 0) {
          updates.push(statement);
        }
      }
    }
    return updates;
  }

  it("stamps recompute_updated once per processed beach with [nowIso, beachId] args", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeBatchRecordingEnv([
      makeBeachRow({ id: "osm-node-1" }),
      makeBeachRow({ id: "osm-node-2", name: "Test Beach Beta", lat: 44.81, lon: -83.31 })
    ]);
    await runHourlyCron(made.env);

    const updates = findRecomputeUpdates(made.batchCalls);
    expect(updates.length).toBe(2);
    const stampedIds = updates.map(function (u) { return u.args[1]; }).sort();
    expect(stampedIds).toEqual(["osm-node-1", "osm-node-2"]);
    for (const update of updates) {
      expect(update.args.length).toBe(2);
      // nowIso-shaped first arg, identical across the run.
      expect(update.args[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(update.args[0]).toBe(updates[0].args[0]);
    }
  });

  it("a rejected UPDATE batch is swallowed — the run completes and flag: puts survive", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeBatchRecordingEnv([
      makeBeachRow({ id: "osm-node-1" }),
      makeBeachRow({ id: "osm-node-2", name: "Test Beach Beta", lat: 44.81, lon: -83.31 })
    ]);
    made.env.DB.batch = function (statements) {
      made.batchCalls.push(statements);
      return Promise.reject(new Error("d1 batch down"));
    };
    await runHourlyCron(made.env);

    // The batch WAS attempted...
    expect(findRecomputeUpdates(made.batchCalls).length).toBe(2);
    // ...and its failure never poisoned the estimates already written.
    expect(made.kvPuts.get("flag:osm-node-1")).toBeDefined();
    expect(made.kvPuts.get("flag:osm-node-2")).toBeDefined();
  });
});

// last_viewed demand-aware ordering: the recompute rotation's normal
// (recompute_updated ASC, id ASC) queue is fronted by a hot-first guard so a
// beach a real visitor looked at within HOT_VIEW_WINDOW_MS gets refreshed
// before the cold sweep catches up to it. The window is 7 days — far longer
// than the 2 h flag KV TTL — so a beach's hotness never flaps mid-lifecycle.
describe("HOT_VIEW_WINDOW_MS demand window constant", function () {
  it("is exactly 7 days in milliseconds", function () {
    expect(HOT_VIEW_WINDOW_MS).toBe(7 * 86400000);
  });
});

describe("runFlagRecompute demand-aware ordering (last_viewed)", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("SELECT ORDERs hot-first ahead of recompute_updated/id, and binds exactly ONE ISO cutoff arg near Date.now() - HOT_VIEW_WINDOW_MS", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const before = Date.now();
    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1" })
    ]);
    await runHourlyCron(made.env);
    const after = Date.now();

    const selectBinds = made.preparedBinds.filter(function (b) {
      return b.sql.indexOf("SELECT * FROM beaches WHERE") !== -1 && b.sql.indexOf("ORDER BY") !== -1;
    });
    expect(selectBinds.length).toBe(1);
    const sql = selectBinds[0].sql;
    const hotIdx = sql.indexOf("(last_viewed IS NOT NULL AND last_viewed >= ?1) DESC");
    const recomputeIdx = sql.indexOf("recompute_updated ASC, id ASC");
    expect(hotIdx).toBeGreaterThan(-1);
    // The hot guard MUST precede the pre-existing rotation key — NULLS/never-
    // viewed rows evaluate the guard to 0 and sort after hot rows into the
    // unchanged recompute_updated/id rotation.
    expect(recomputeIdx).toBeGreaterThan(hotIdx);

    // FLAG_WORTHY_WATER_SQL is an inlined literal with no bind params, so ?1
    // (the hot cutoff) is the SELECT's only bound argument.
    expect(selectBinds[0].args.length).toBe(1);
    const boundIso = selectBinds[0].args[0];
    expect(typeof boundIso).toBe("string");
    const boundMs = Date.parse(boundIso);
    expect(Number.isNaN(boundMs)).toBe(false);
    // Cutoff = now - HOT_VIEW_WINDOW_MS, within a few minutes of test wall time
    // (a generous tolerance for CI scheduling jitter, not a precision check).
    const toleranceMs = 5 * 60000;
    expect(boundMs).toBeGreaterThanOrEqual(before - HOT_VIEW_WINDOW_MS - toleranceMs);
    expect(boundMs).toBeLessThanOrEqual(after - HOT_VIEW_WINDOW_MS + toleranceMs);
  });

  it("summary log includes hot=<count of beaches last_viewed within the window>", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});

    const recentIso = new Date(Date.now() - 60000).toISOString(); // 1 min ago: hot
    const staleIso = new Date(Date.now() - (HOT_VIEW_WINDOW_MS + 86400000)).toISOString(); // 8 days ago: cold

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1", last_viewed: recentIso }),
      makeBeachRow({ id: "osm-node-2", name: "Test Beach Beta", lat: 44.81, lon: -83.31, last_viewed: staleIso }),
      makeBeachRow({ id: "osm-node-3", name: "Test Beach Gamma", lat: 44.82, lon: -83.32, last_viewed: null })
    ]);
    await runHourlyCron(made.env);

    const calls = logSpy.mock.calls;
    logSpy.mockRestore();

    const summaryLine = calls
      .map(function (c) { return c[0]; })
      .filter(function (line) { return typeof line === "string" && line.indexOf("flag recompute complete") !== -1; })[0];
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toContain("hot=1");
  });
});

// ---------------------------------------------------------------------------
// Integration coverage for the registered sources: ECCC marine warnings raising
// a Canadian beach, a raise-only water-quality floor lifting a green (and NOT
// lowering a hazard red), and an official scraper overriding via KV. All run
// through the real cron handler + registries; only upstream fetch is stubbed.
// ---------------------------------------------------------------------------
describe("runFlagRecompute - registered-source integration", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("ECCC marine gale warning raises a Canadian beach to red (eccc-alert)", function () {
    return (async function () {
      // Only the marine-alerts collection answers; the land weather-alerts
      // fetch fails, proving the branch still processes on marine alone.
      vi.stubGlobal("fetch", function (url) {
        const target = typeof url === "string" ? url : (url && url.url) || "";
        if (target.indexOf("collections/marineweather-realtime/items") !== -1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: function () {
              return Promise.resolve({
                features: [{
                  type: "Feature",
                  properties: {
                    lastUpdated: "2026-07-18T11:00:00.000Z",
                    area: { region: { en: "Great Lakes" }, value: { en: "Lake Erie" } },
                    warnings: {
                      locations: [{
                        events: [{
                          name: { en: "Gale Warning" },
                          category: { en: "marine" },
                          status: { en: "in effect" }
                        }]
                      }]
                    }
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
          id: "osm-way-marine-1",
          name: "Colchester Beach",
          lat: 41.9836774,
          lon: -82.9343626,
          eccc_zone: "Windsor - Essex - Chatham-Kent",
          enrichment_attempts: 5
        })
      ]);
      await runHourlyCron(made.env);

      const estimate = JSON.parse(made.kvPuts.get("flag:osm-way-marine-1").value);
      expect(estimate.color).toBe("red");
      expect(estimate.trigger).toBe("eccc-alert");
      expect(estimate.reason).toBe("Active Environment Canada alert: gale warning");
      expect(estimate.reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT)).toBe(-1);
      const labels = estimate.sources.map(function (s) { return s.label; });
      expect(labels.indexOf("Environment Canada Marine Alerts")).toBeGreaterThan(-1);
    })();
  });

  // A Duluth / Lake Superior beach covered by the mnBeaches water-quality
  // floor source; MNBstatus reports a not-recommended reading.
  function mnAdvisoryFetch(reason) {
    return function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target.indexOf("mnbeaches.org") !== -1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () {
            return Promise.resolve({
              MNBstatus: [{
                Name: "Park Point Sky Harbor",
                Region: "Duluth",
                Status: "Water Contact Not Recommended",
                Reason: reason,
                lat: 46.7282128,
                lng: -92.0519435
              }]
            });
          }
        });
      }
      return Promise.reject(new Error("network disabled in test"));
    };
  }

  function mnBeachRow() {
    return makeBeachRow({
      id: "osm-node-duluth-1",
      name: "Park Point Sky Harbor",
      lat: 46.7282128,
      lon: -92.0519435
    });
  }

  it("a water-quality advisory raises a wave-green estimate to yellow (wq-floor)", function () {
    return (async function () {
      vi.stubGlobal("fetch", mnAdvisoryFetch("Elevated E. coli bacteria"));
      const made = makeEnv([mnBeachRow()], {
        "waveinput:osm-node-duluth-1": {
          beachId: "osm-node-duluth-1",
          waveHeightFt: 1.0,
          model: "noaa_glwu",
          windSpeedMph: null,
          windGustMph: null,
          updated: "2026-07-18T12:00:00.000Z"
        }
      });
      await runHourlyCron(made.env);

      const estimate = JSON.parse(made.kvPuts.get("flag:osm-node-duluth-1").value);
      expect(estimate.color).toBe("yellow");
      expect(estimate.trigger).toBe("wq-floor");
      expect(estimate.reason.indexOf("Water-quality advisory (")).toBe(0);

      // The structured advisory is persisted for the request path.
      const wqPut = made.kvPuts.get("wqfloor:osm-node-duluth-1");
      expect(wqPut).toBeDefined();
      expect(JSON.parse(wqPut.value).color).toBe("yellow");
    })();
  });

  it("a water-quality advisory NEVER lowers a wave-height red", function () {
    return (async function () {
      vi.stubGlobal("fetch", mnAdvisoryFetch("Elevated E. coli bacteria"));
      const made = makeEnv([mnBeachRow()], {
        "waveinput:osm-node-duluth-1": {
          beachId: "osm-node-duluth-1",
          waveHeightFt: 5.0,
          model: "noaa_glwu",
          windSpeedMph: null,
          windGustMph: null,
          updated: "2026-07-18T12:00:00.000Z"
        }
      });
      await runHourlyCron(made.env);

      const estimate = JSON.parse(made.kvPuts.get("flag:osm-node-duluth-1").value);
      expect(estimate.color).toBe("red");
      expect(estimate.trigger).toBe("wave-height");
      // The advisory is still recorded for the request path — it just did not
      // (and must not) pull the hazard red down.
      expect(made.kvPuts.get("wqfloor:osm-node-duluth-1")).toBeDefined();
    })();
  });

  it("a registered official scraper writes an official override to KV", function () {
    return (async function () {
      vi.stubGlobal("fetch", function (url) {
        const target = typeof url === "string" ? url : (url && url.url) || "";
        if (target.indexOf("rainoutline.com") !== -1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: function () {
              return Promise.resolve(
                "<div><span class=\"status2\">Closed</span>&nbsp;-&nbsp;" +
                "Dangerous high waves and rip currents<br /><br />" +
                "<span class=\"clue\"><em>Last updated at 7/18/26 8:00 am</em></span></div>"
              );
            }
          });
        }
        return Promise.reject(new Error("network disabled in test"));
      });

      const made = makeEnv([
        makeBeachRow({
          id: "osm-node-tower-1",
          name: "Tower Road Beach",
          lat: 42.115585,
          lon: -87.733837
        })
      ]);
      await runHourlyCron(made.env);

      const officialPut = made.kvPuts.get("official:osm-node-tower-1");
      expect(officialPut).toBeDefined();
      const official = JSON.parse(officialPut.value);
      expect(official.official).toBe(true);
      expect(official.color).toBe("red");
      expect(official.scraperId).toBe("winnetka-tower-beach");
    })();
  });
});

// ---------------------------------------------------------------------------
// The 6-hourly cron: the bounded-concurrency write pool and the wave_updated
// rotation cursor it stamps.
//
// These lock the behavior that replaced the production failure mode: the cron
// wrote ~1450 KV keys with a SEQUENTIAL await env.FLAGS.put per beach, had no
// budget of any kind, and was SIGKILLed at 899.989 s of workerd's 900 s
// scheduled ceiling — mid-loop, so its post-loop cursor batch never ran, the
// step that writes "watertemp:" was never reached at all, and the invocation
// left three log lines and no completion record. Everything below is an
// assertion about what a truncated run must still deliver.
// ---------------------------------------------------------------------------

// Every "UPDATE beaches SET wave_updated" statement the run batched, in the
// order D1 received them. Anchored with indexOf(...) === 0 exactly like
// findRecomputeUpdates above, so the two crons' cursor stamps can never be
// mistaken for one another — that separation is the entire point of migration
// 0012.
function findWaveStamps(batchCalls) {
  const updates = [];
  for (const statements of batchCalls) {
    for (const statement of statements) {
      if (statement.sql &&
          statement.sql.indexOf("UPDATE beaches SET wave_updated") === 0) {
        updates.push(statement);
      }
    }
  }
  return updates;
}

function loggedLines(logSpy) {
  return logSpy.mock.calls.map(function (c) { return String(c[0]); }).join("\n");
}

describe("runWaterTempRefresh bounded-concurrency write pool", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes EVERY beach across pool boundaries", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));

    // 120 beaches, deliberately not a multiple of KV_WRITE_CONCURRENCY (12), so
    // the pool's pull-boundary bookkeeping is exercised rather than assumed.
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target === NDBC_CLEVELAND_URL) {
        return ndbcTextResponse(ndbcFile([ndbcRow("2026 07 15 15 50", "1.2", "24.6")]));
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    const made = makeEnv(clevelandBeaches(120));
    await runWaterTempCron(made.env);

    let temps = 0;
    for (const key of made.kvPuts.keys()) {
      if (key.indexOf("watertemp:") === 0) {
        temps = temps + 1;
      }
    }
    expect(temps).toBe(120);

    // Spot-check the seams rather than all 120: the first beach, the first
    // pool-width boundary, and the last beach.
    const seams = ["osm-node-0", "osm-node-11", "osm-node-119"];
    for (const id of seams) {
      const put = made.kvPuts.get("watertemp:" + id);
      expect(put).toBeDefined();
      expect(put.opts).toEqual({ expirationTtl: WAVE_DATA_TTL });
    }

    // Full coverage is reported as such: nothing truncated, every beach stamped.
    expect(loggedLines(logSpy)).toContain(
      "index: water temp refresh complete, beaches=120 stamped=120 reached=120 " +
      "unattempted=0 failures=0 watertemp=120 truncated=no"
    );
  });

  it("one rejecting KV put costs that beach only — never the pool or the run", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));

    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target === NDBC_CLEVELAND_URL) {
        return ndbcTextResponse(ndbcFile([ndbcRow("2026 07 15 15 50", "1.2", "24.6")]));
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    const made = makeEnv(clevelandBeaches(60));
    const recordingPut = made.env.FLAGS.put;
    made.env.FLAGS.put = function (key, value, opts) {
      if (key === "watertemp:osm-node-30") {
        return Promise.reject(new Error("kv put rejected"));
      }
      return recordingPut(key, value, opts);
    };
    await runWaterTempCron(made.env);

    expect(made.kvPuts.get("watertemp:osm-node-30")).toBeUndefined();
    let temps = 0;
    for (const key of made.kvPuts.keys()) {
      if (key.indexOf("watertemp:") === 0) {
        temps = temps + 1;
      }
    }
    expect(temps).toBe(59);

    const logged = loggedLines(logSpy);
    // The per-beach message proves the try/catch is INSIDE the pool worker:
    // runPool's own backstop would have logged "pool: worker threw" instead.
    expect(logged).toContain(
      "index: water temp write failed for beach osm-node-30: kv put rejected"
    );
    expect(logged.indexOf("pool: worker threw")).toBe(-1);
    // The failed beach is NOT stamped: it persisted nothing, so advancing its
    // wave_updated cursor would send a beach with no data to the BACK of the
    // rotation. Unstamped means NULL, which sorts first next run. The RUN is
    // still complete — failures= carries the one bad put and truncated= stays
    // "no", so a flaky put cannot trip the truncation alarm.
    expect(logged).toContain(
      "index: water temp refresh complete, beaches=60 stamped=59 reached=60 " +
      "unattempted=0 failures=1 watertemp=59 truncated=no"
    );
    const stamped = findWaveStamps(made.batchCalls).map(function (u) { return u.args[1]; });
    expect(stamped.length).toBe(59);
    expect(stamped.indexOf("osm-node-30")).toBe(-1);
  });

  it("an expired gather deadline leaves every beach unattempted AND unstamped", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));

    let ndbcCalls = 0;
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target === NDBC_CLEVELAND_URL) {
        ndbcCalls = ndbcCalls + 1;
        return ndbcTextResponse(ndbcFile([ndbcRow("2026 07 15 15 50", "1.2", "24.6")]));
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    const made = makeEnv(clevelandBeaches(3));
    // makeDeadline's expired() uses >=, so a 0 budget trips before the first
    // station fetch even under the suite's frozen clock.
    made.env.WAVE_GATHER_DEADLINE_MS = 0;
    await runWaterTempCron(made.env);

    expect(ndbcCalls).toBe(0);
    for (const key of made.kvPuts.keys()) {
      expect(key.indexOf("watertemp:")).toBe(-1);
    }
    // A beach the gather never attempted must not be stamped — stamping would
    // advance the cursor past work that never happened.
    expect(findWaveStamps(made.batchCalls).length).toBe(0);
    expect(loggedLines(logSpy)).toContain(
      "index: water temp refresh complete, beaches=3 stamped=0 reached=3 " +
      "unattempted=3 failures=0 watertemp=0 truncated=yes"
    );
  });
});

// The NDBC water-temperature pass (DISPLAY-ONLY: it colors no flag and never
// reaches src/rules.js) is the whole of the 6-hourly cron, and the only writer
// of "watertemp:". Many beaches share one station, so the pass dedups by station
// id; every put rides the bounded-concurrency write pool.
const NDBC_CLEVELAND_URL = "https://www.ndbc.noaa.gov/data/realtime2/45164.txt";

const NDBC_HEADER = [
  "#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE",
  "#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft"
];

// One realtime2 data row: ts is "YYYY MM DD hh mm", wvht the WVHT token (metres
// or "MM", column 8) and wtmp the WTMP token (Celsius or "MM", column 14).
function ndbcRow(ts, wvht, wtmp) {
  return ts + " 280  5.0  6.0   " + wvht + "     5    MM  MM 1016.2  18.3  " + wtmp +
    "    MM   MM   MM    MM";
}

function ndbcFile(rows) {
  return NDBC_HEADER.concat(rows).join("\n") + "\n";
}

function ndbcTextResponse(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: function () { return Promise.resolve(body); }
  });
}

// n beach rows sitting on NDBC station 45164 (Cleveland, OH), so nearestStation
// resolves the SAME station for every one of them and the pass must dedup down
// to a single realtime2 fetch.
function clevelandBeaches(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(makeBeachRow({
      id: "osm-node-" + String(i),
      name: "Beach " + String(i),
      lat: 41.748 + i * 0.0005,
      lon: -81.698
    }));
  }
  return rows;
}

describe("runWaterTempRefresh water temperature (watertemp: KV)", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("dedups by station: 60 beaches under one buoy cost ONE fetch and write 60 keys", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));

    let ndbcCalls = 0;
    const ndbcRangeHeaders = [];
    vi.stubGlobal("fetch", function (url, init) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target === NDBC_CLEVELAND_URL) {
        ndbcCalls = ndbcCalls + 1;
        ndbcRangeHeaders.push(init && init.headers ? init.headers.Range : undefined);
        return ndbcTextResponse(ndbcFile([ndbcRow("2026 07 15 15 50", "1.2", "24.6")]));
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    const made = makeEnv(clevelandBeaches(60));
    await runWaterTempCron(made.env);

    expect(ndbcCalls).toBe(1);
    // The temp-capable station set is ~7x the wave set and is dominated by NOS
    // gauges publishing every 6 minutes (~1 MB realtime2 files), so the fetch is
    // Range-limited to the newest-first head rather than pulling whole files.
    expect(ndbcRangeHeaders.length).toBe(1);
    expect(ndbcRangeHeaders[0]).toBe("bytes=0-" + String(NDBC_HEAD_BYTES - 1));

    let temps = 0;
    for (const key of made.kvPuts.keys()) {
      if (key.indexOf("watertemp:") === 0) {
        temps = temps + 1;
      }
    }
    expect(temps).toBe(60);

    const put = made.kvPuts.get("watertemp:osm-node-0");
    expect(put.opts).toEqual({ expirationTtl: WAVE_DATA_TTL });
    const reading = JSON.parse(put.value);
    expect(reading.beachId).toBe("osm-node-0");
    expect(reading.tempC).toBeCloseTo(24.6, 5);
    expect(reading.tempF).toBeCloseTo(76.28, 5);
    expect(reading.station.id).toBe("45164");
    expect(reading.observedIso).toBe("2026-07-15T15:50:00.000Z");
    expect(reading.updated).toBe("2026-07-15T16:00:00.000Z");

    expect(loggedLines(logSpy)).toContain("watertemp=60");
  });

  it("writes NO wave KV: waveinput:/waves: belong to the offline pipeline", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));

    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target === NDBC_CLEVELAND_URL) {
        return ndbcTextResponse(ndbcFile([ndbcRow("2026 07 15 15 50", "MM", "18.0")]));
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv(clevelandBeaches(1));
    await runWaterTempCron(made.env);

    // A WVHT of "MM" is irrelevant here: this cron reads water temperature only,
    // and the wave keys are bulk-written from GitHub Actions.
    for (const key of made.kvPuts.keys()) {
      expect(key.indexOf("waveinput:")).toBe(-1);
      expect(key.indexOf("waves:")).toBe(-1);
    }
    const put = made.kvPuts.get("watertemp:osm-node-0");
    expect(put).toBeDefined();
    expect(put.opts).toEqual({ expirationTtl: WAVE_DATA_TTL });
    expect(JSON.parse(put.value).tempC).toBeCloseTo(18.0, 5);
  });

  it("a null station reading writes nothing, and still stamps every beach", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));

    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target === NDBC_CLEVELAND_URL) {
        // The winter/outage case: the station file is gone. stationWaterTemp
        // degrades to null and every beach's old key expires on its own.
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    const made = makeEnv(clevelandBeaches(3));
    await runWaterTempCron(made.env);

    for (const key of made.kvPuts.keys()) {
      expect(key.indexOf("watertemp:")).toBe(-1);
    }
    // Stamped anyway: a station that publishes nothing writes nothing on every
    // run, and stamping only on a successful write would pin those beaches to
    // the head of the rotation forever.
    expect(findWaveStamps(made.batchCalls).length).toBe(3);
    expect(loggedLines(logSpy)).toContain(
      "index: water temp refresh complete, beaches=3 stamped=3 reached=3 " +
      "unattempted=0 failures=0 watertemp=0 truncated=no"
    );
  });
});

// The hourly cron's step 6 (estimate + flag: put) and step 8's INNER per-beach
// official: put loop are pooled at the same width. The outer scraper-group loop
// stays sequential — it mutates shared "scraperhealth:" state across a KV
// read-modify-write.
describe("runFlagRecompute pooled per-beach writes", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // n beach rows inside the South Haven bbox, all named "North Beach" so the
  // scraper's site resolution gives every one of them an official color and the
  // flag_history pairing is exercised at pool scale.
  function southHavenBeaches(n) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push(makeBeachRow({
        id: "osm-node-" + String(i),
        name: "North Beach",
        lat: 42.40 + i * 0.0004,
        lon: -86.28
      }));
    }
    return rows;
  }

  function southHavenFetch() {
    return function (url) {
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
    };
  }

  it("writes flag: and official: for every beach, and keeps flag_history in beaches order", async function () {
    // Inside South Haven's monitored season/hours so the scraper does not gate
    // itself off.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));
    vi.stubGlobal("fetch", southHavenFetch());

    const rows = southHavenBeaches(120);
    const made = makeBatchRecordingEnv(rows);
    await runHourlyCron(made.env);

    let flags = 0;
    let officials = 0;
    for (const key of made.kvPuts.keys()) {
      if (key.indexOf("flag:") === 0) {
        flags = flags + 1;
      }
      if (key.indexOf("official:") === 0) {
        officials = officials + 1;
      }
    }
    expect(flags).toBe(120);
    expect(officials).toBe(120);
    expect(made.kvPuts.get("flag:osm-node-0").opts).toEqual({ expirationTtl: 7200 });
    expect(made.kvPuts.get("flag:osm-node-119").opts).toEqual({ expirationTtl: 7200 });

    // The history step iterates the beaches array, not the estimate/official Maps, so a
    // pooled (nondeterministic) write order must remain invisible here.
    const historyRows = findHistoryStatements(made.batchCalls);
    expect(historyRows.length).toBe(120);
    const historyIds = historyRows.map(function (h) { return h.args[0]; });
    const expectedIds = rows.map(function (b) { return b.id; });
    expect(historyIds).toEqual(expectedIds);
  });

  it("a beach whose flag: put REJECTS records NO flag_history row", async function () {
    // Pins the ordering both pooling rewrites of this loop got wrong:
    // estimatesByBeach.set must stay AFTER the successful put, inside the same
    // try, so no calibration row can ever claim an estimate that was never
    // published.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));
    vi.stubGlobal("fetch", southHavenFetch());

    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    const made = makeBatchRecordingEnv(southHavenBeaches(5));
    const recordingPut = made.env.FLAGS.put;
    made.env.FLAGS.put = function (key, value, opts) {
      if (key === "flag:osm-node-3") {
        return Promise.reject(new Error("kv put rejected"));
      }
      return recordingPut(key, value, opts);
    };
    await runHourlyCron(made.env);

    expect(made.kvPuts.get("flag:osm-node-3")).toBeUndefined();
    // Its official: put still succeeded — an official with no estimate is
    // simply not a PAIR, so it logs no calibration row.
    expect(made.kvPuts.get("official:osm-node-3")).toBeDefined();

    const historyIds = findHistoryStatements(made.batchCalls).map(function (h) { return h.args[0]; });
    expect(historyIds).toEqual(["osm-node-0", "osm-node-1", "osm-node-2", "osm-node-4"]);
    expect(loggedLines(logSpy)).toContain(
      "index: flag estimate failed for beach osm-node-3: kv put rejected"
    );
  });
});
