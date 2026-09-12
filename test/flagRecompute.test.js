// The hourly cron, driven through the scheduled handler against real in-memory
// SQLite: every record it derives — estimate, wqfloor, official, reading — lands
// in one beach_state row per beach, each blob beside its own absolute expiry.
//
// Cron input-assembly test for runFlagRecompute (via the scheduled handler):
// verifies the alertsCheckable wiring — a beach with neither nws_zone nor
// eccc_zone (not yet enriched for either authority) must get an estimate
// whose reason carries the explicit "weather alerts are not checked here yet"
// caveat, while an enriched beach whose alerts fetch merely failed this run
// must not.
// The network is stubbed to fail entirely, so every client returns null and
// both beaches land on the honest "unknown" terminal fallback.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ALERTS_UNAVAILABLE_CAVEAT } from "../src/rules.js";
import { HOT_VIEW_WINDOW_MS } from "../src/demandWindow.js";
import { NDBC_HEAD_BYTES } from "../src/waveSources/ndbcBuoys.js";
import { runScheduledCron } from "./helpers/cron.js";
import { makeD1 } from "./helpers/d1.js";
import { READING_MAX_AGE_MS } from "../src/officialReading.js";
import { officialExpiryEpoch } from "../src/index.js";
import { estimateFlag } from "../src/rules.js";
import {
  FLAG_SEAL_VERSION,
  buildEstimateInputs,
  signalsFromStanding
} from "../src/flagInputs.js";

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

// D1 is real in-memory SQLite with migrations/ applied, so the beach rows are
// inserted and the four derived records land in beach_state exactly as the
// request path reads them back.
//
// kvSeed pre-populates the KV reads that remain on the cron path: the raw
// "scraperhealth:" string. Wave records are seeded into beach_state through
// db.seedWave, not here — the cron reads them off the join its SELECT issues.
function makeEnv(beachRows, kvSeed) {
  const db = makeD1({ beaches: beachRows || [] });
  const kvPuts = new Map();
  const kvGets = kvSeed instanceof Map
    ? kvSeed
    : new Map(Object.entries(kvSeed || {}));
  const env = {
    DB: db,
    FLAGS: {
      // Both get forms, as the Workers binding implements them: a string key
      // resolves to the value, an array of keys to a Map.
      get: function (key) {
        if (Array.isArray(key)) {
          return Promise.resolve(new Map(key.map(function (k) {
            return [k, kvGets.has(k) ? kvGets.get(k) : null];
          })));
        }
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
    db: db,
    kvPuts: kvPuts,
    kvGets: kvGets,
    // Every recorded { sql, args }, in order, so the demand-ordering test can
    // assert the SELECT's ORDER BY shape and its single bound cutoff arg.
    preparedBinds: db.statements,
    // Every env.DB.batch(...) call, in the order D1 received it. The water-temp
    // cron flushes its wave_updated rotation cursor INCREMENTALLY as the write
    // pool advances, so the cursor tests need the individual flushes.
    batchCalls: db.batchCalls
  };
}

// One beach_state row holds all four derived records, each a JSON blob beside
// its own absolute expiry in epoch seconds. A record this run did not produce is
// simply absent, so a null column is "nothing written", never "cleared".
function recordOf(made, id, column) {
  const row = made.db.stateOf(id);
  return row && row[column] ? JSON.parse(row[column]) : null;
}

function estimateOf(made, id) {
  return recordOf(made, id, "estimate");
}

function officialOf(made, id) {
  return recordOf(made, id, "official");
}

function wqfloorOf(made, id) {
  return recordOf(made, id, "wqfloor");
}

function readingOf(made, id) {
  return recordOf(made, id, "reading");
}

function expiresOf(made, id, column) {
  const row = made.db.stateOf(id);
  return row ? row[column] : null;
}

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

function runHourlyCron(env) {
  return runScheduledCron(env, "7 * * * *");
}

function runWaterTempCron(env) {
  return runScheduledCron(env, "15 */6 * * *");
}

describe("runFlagRecompute input assembly - alertsCheckable", function () {
  beforeEach(function () {
    // The alert fixtures below carry July 2026 onset/ends periods, and only an
    // alert in effect at the run's clock may decide a color.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });
  });

  afterEach(function () {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("unenriched beach (nws_zone NULL) gets the alerts-unavailable caveat", async function () {
    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1", nws_zone: null, nws_grid_url: null })
    ]);
    await runHourlyCron(made.env);

    const estimate = estimateOf(made, "osm-node-1");
    expect(estimate).not.toBeNull();
    expect(expiresOf(made, "osm-node-1", "estimate_expires")).toBe(nowEpoch() + 25200);
    expect(estimate.color).toBe("unknown");
    expect(estimate.official).toBe(false);
    expect(estimate.reason).toBe(
      "No wave or weather data is available for this beach yet (" +
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

    const estimate = estimateOf(made, "osm-node-2");
    expect(estimate).not.toBeNull();
    expect(estimate.color).toBe("unknown");
    expect(estimate.reason).toBe(
      "No wave or weather data is available for this beach yet"
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

    const estimate = estimateOf(made, "osm-node-3");
    expect(estimate.color).toBe("red");
    expect(estimate.reason).toBe("Active NWS alert: Beach Hazards Statement");
    // The structured echo the detail page's hazard lane consumes.
    expect(estimate.alertDetails).toMatchObject([{
      event: "Beach Hazards Statement",
      onset: "2026-07-15T14:00:00Z",
      ends: "2026-07-16T06:00:00Z"
    }]);
    expect(estimate.ripCurrentRisk).toBeNull();
  });

  it("treats a paginated national feed as no feed and seals alertsResolved false", async function () {
    // Same feature as the unpaginated control above, plus a pagination cursor:
    // a partial view of the population must not seal any zone as checked.
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
                  geocode: { UGC: ["MIZ071"] },
                  affectedZones: ["https://api.weather.gov/zones/forecast/MIZ071"]
                }
              }],
              pagination: { next: "https://api.weather.gov/alerts/active?cursor=next" }
            });
          }
        });
      }
      return Promise.reject(new Error("network disabled in test"));
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-paged", nws_zone: "MIZ071", nws_grid_url: null })
    ]);
    await runHourlyCron(made.env);

    const estimate = estimateOf(made, "osm-node-paged");
    expect(estimate.color).toBe("unknown");
    expect(estimate.reason).toBe("No wave or weather data is available for this beach yet");
    expect(estimate.reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT)).toBe(-1);
    expect(estimate.alertDetails).toEqual([]);
    expect(estimate.sources.map(function (s) { return s.label; })).not.toContain("NWS Alerts");
    expect(estimate.estimateInputs.alertsResolved).toBe(false);
    expect(loggedLines(logSpy)).toContain("nws alerts feed paginated");
    logSpy.mockRestore();
  });

  it("issues the NWS and both ECCC national fetches concurrently", async function () {
    let inFlight = 0;
    let peakInFlight = 0;
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      const national = target.indexOf("api.weather.gov/alerts/active") !== -1 ||
        target.indexOf("collections/weather-alerts/items") !== -1 ||
        target.indexOf("collections/marineweather-realtime/items") !== -1;
      if (!national) {
        return Promise.reject(new Error("network disabled in test"));
      }
      inFlight = inFlight + 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      return new Promise(function (resolve) {
        setTimeout(function () {
          inFlight = inFlight - 1;
          resolve({ ok: false, status: 503 });
        }, 5);
      });
    });

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-us", nws_zone: "MIZ071", nws_grid_url: null }),
      makeBeachRow({
        id: "osm-way-ca",
        name: "Colchester Beach",
        lat: 41.9836774,
        lon: -82.9343626,
        eccc_zone: "Windsor - Essex - Chatham-Kent",
        enrichment_attempts: 5
      })
    ]);
    await runHourlyCron(made.env);

    expect(peakInFlight).toBe(3);
    // Failure isolation is unchanged: every authority failed, no caveat.
    for (const id of ["osm-node-us", "osm-way-ca"]) {
      const estimate = estimateOf(made, id);
      expect(estimate.color).toBe("unknown");
      expect(estimate.reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT)).toBe(-1);
    }
  });

  it("skips the NWS fetch with no zoned row and the ECCC fetches with no Canadian row", async function () {
    const urls = [];
    vi.stubGlobal("fetch", function (url) {
      urls.push(typeof url === "string" ? url : (url && url.url) || "");
      return Promise.reject(new Error("network disabled in test"));
    });

    const unenriched = makeEnv([makeBeachRow({ id: "osm-node-bare" })]);
    await runHourlyCron(unenriched.env);
    expect(urls.some(function (u) { return u.indexOf("alerts/active") !== -1; })).toBe(false);
    expect(urls.some(function (u) { return u.indexOf("collections/") !== -1; })).toBe(false);

    urls.length = 0;
    const usOnly = makeEnv([makeBeachRow({ id: "osm-node-us", nws_zone: "MIZ071" })]);
    await runHourlyCron(usOnly.env);
    expect(urls.some(function (u) { return u.indexOf("alerts/active") !== -1; })).toBe(true);
    expect(urls.some(function (u) { return u.indexOf("collections/") !== -1; })).toBe(false);
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

    const estimate = estimateOf(made, "osm-node-4");
    expect(estimate.color).toBe("red");
    expect(estimate.reason).toBe("Active NWS alert: Gale Warning");
    expect(estimate.alertDetails).toMatchObject([{
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
      ]
    );
    made.db.seedWave("osm-node-5", { waveHeightFt: 1.0, model: "noaa_glwu" });
    await runHourlyCron(made.env);

    const estimate = estimateOf(made, "osm-node-5");
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
                  validity_datetime: "2026-07-15T11:00:00.000Z",
                  event_end_datetime: "2026-07-15T21:00:00.000Z"
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

    const estimate = estimateOf(made, "osm-way-175343424");
    expect(estimate.color).toBe("red");
    expect(estimate.reason).toBe("Active Environment Canada alert: severe thunderstorm warning");
    expect(estimate.reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT)).toBe(-1);
    expect(estimate.alertDetails).toMatchObject([{
      event: "severe thunderstorm warning",
      onset: "2026-07-15T11:00:00.000Z",
      ends: "2026-07-15T21:00:00.000Z"
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

    const estimate = estimateOf(made, "osm-node-ca-1");
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

    const estimate = estimateOf(made, "osm-node-ca-2");
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

    const first = estimateOf(made, "osm-node-1");
    const second = estimateOf(made, "osm-node-2");
    expect(first.reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT)).toBeGreaterThan(-1);
    expect(second.reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT)).toBe(-1);
  });
});

// flag_history (migration 0006) is the calibration signal: one row per beach
// per run only when that beach has both a fresh estimate AND a scraped official
// color this run, and only when the beach_state chunk carrying that estimate
// actually committed. Estimate-only rows must never be logged, or the table
// would grow by one row per beach every hour.
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
    const made = makeEnv([
      makeBeachRow({
        id: "osm-node-sh",
        name: "North Beach",
        lat: 42.406,
        lon: -86.28,
        nws_zone: null,
        nws_grid_url: null
      }),
      // Alpena beach: gets an estimate but matches no scraper -> no official ->
      // must not appear in flag_history.
      makeBeachRow({ id: "osm-node-alpena", name: "Alpena Beach", lat: 44.8, lon: -83.3 })
    ]);
    await runHourlyCron(made.env);

    // Sanity: both beaches got an estimate, only South Haven got an official.
    expect(estimateOf(made, "osm-node-sh")).not.toBeNull();
    expect(estimateOf(made, "osm-node-alpena")).not.toBeNull();
    const official = officialOf(made, "osm-node-sh");
    expect(official).not.toBeNull();
    expect(official.color).toBe("red");

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

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1" }),
      makeBeachRow({ id: "osm-node-2", name: "Test Beach Beta", lat: 44.81, lon: -83.31 })
    ]);
    await runHourlyCron(made.env);

    // Estimates were still written for both beaches...
    expect(estimateOf(made, "osm-node-1")).not.toBeNull();
    expect(estimateOf(made, "osm-node-2")).not.toBeNull();
    // ...but no flag_history INSERT was batched.
    expect(findHistoryStatements(made.batchCalls).length).toBe(0);
  });
});

// The 6-hourly cron writes "watertemp:" + id at the 7 h wave-data TTL (25200 s),
// not the 2 h flag TTL.
const WAVE_DATA_TTL = 25200;

// The hourly estimate never fetches wave data — it READS the beach_state.wave
// record the offline NOAA GRIB pipeline writes, off the join its own SELECT
// issues. A seeded wave height must flow through to the flag color; a beach with
// no record, and one whose wave_expires has passed, must degrade honestly (no
// wave input, no crash).
describe("runFlagRecompute reads the beach_state wave record", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("uses a seeded wave height (>=4 ft -> red) with the model's source label", async function () {
    // No network needed: the hourly path only reads stored state. Fail all fetch
    // to prove no upstream call is reachable from the request-assembly path.
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1", lat: 44.8, lon: -83.3 })
    ]);
    made.db.seedWave("osm-node-1", {
      beachId: "osm-node-1",
      waveHeightFt: 4.5,
      model: "noaa_gfswave",
      windSpeedMph: null,
      windGustMph: null,
      updated: "2026-07-15T12:00:00.000Z"
    });
    const seeded = made.db.stateOf("osm-node-1");
    await runHourlyCron(made.env);

    const estimate = estimateOf(made, "osm-node-1");
    expect(estimate).not.toBeNull();
    // 4.5 ft crosses the 4 ft red threshold.
    expect(estimate.color).toBe("red");
    const labels = estimate.sources.map(function (s) { return s.label; });
    expect(labels).toContain("NOAA GFS Wave Model");
    // The offline cycle owns these two columns: the hourly upsert names neither,
    // so the run leaves both byte-identical.
    const after = made.db.stateOf("osm-node-1");
    expect(after.wave).toBe(seeded.wave);
    expect(after.wave_expires).toBe(seeded.wave_expires);
  });

  it("degrades to unknown when the beach has no wave record", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1", lat: 44.8, lon: -83.3 })
    ]);
    await runHourlyCron(made.env);

    expect(estimateOf(made, "osm-node-1").color).toBe("unknown");
    // Nothing wrote the column, so it stays NULL rather than an empty blob.
    const row = made.db.stateOf("osm-node-1");
    expect(row.wave).toBeNull();
    expect(row.wave_expires).toBeNull();
  });

  it("reads a past wave_expires as absent even though the blob is still in the row", async function () {
    // The whole failure this lease closes: the JSON stays in the row past its
    // lease, so a reader that skips the gate resurrects a spent cycle as a live
    // wave height. 4.5 ft would be red; the expired lease must make it gray.
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1", lat: 44.8, lon: -83.3 })
    ]);
    made.db.seedWave(
      "osm-node-1",
      {
        beachId: "osm-node-1",
        waveHeightFt: 4.5,
        model: "noaa_gfswave",
        windSpeedMph: null,
        windGustMph: null,
        updated: "2026-07-15T12:00:00.000Z"
      },
      Math.floor(Date.now() / 1000) - 1
    );
    await runHourlyCron(made.env);

    expect(made.db.stateOf("osm-node-1").wave).not.toBeNull();
    expect(estimateOf(made, "osm-node-1").color).toBe("unknown");
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
    // season/cadence pre-fetch skip.
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
// from the same beach_state.wave record the offline wave pipeline wrote, and the
// { label: "Wind Forecast" } source entry is pushed only when the record's
// waveHeightFt is null (wind is a fallback, never a co-signal).
describe("runFlagRecompute wind fallback from the stored wave record", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("wave-null record with 30 mph wind -> red via the wind trigger, Wind Forecast source", async function () {
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
      ]
    );
    made.db.seedWave("osm-node-1", {
      beachId: "osm-node-1",
      waveHeightFt: null,
      model: null,
      windSpeedMph: 30,
      windGustMph: null,
      updated: "2026-07-15T12:00:00.000Z"
    });
    await runHourlyCron(made.env);

    const estimate = estimateOf(made, "osm-node-1");
    expect(estimate).not.toBeNull();
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

  it("a record carrying BOTH a wave height and wind: wave decides, Wind Forecast source is NOT pushed", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv(
      [makeBeachRow({ id: "osm-node-1", nws_zone: "MIZ071" })]
    );
    made.db.seedWave("osm-node-1", {
      beachId: "osm-node-1",
      waveHeightFt: 1.0,
      model: "noaa_gfswave",
      windSpeedMph: 30,
      windGustMph: null,
      updated: "2026-07-15T12:00:00.000Z"
    });
    await runHourlyCron(made.env);

    const estimate = estimateOf(made, "osm-node-1");
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

    const estimate = estimateOf(made, "osm-node-1");
    expect(estimate).not.toBeNull();
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
    const first = estimateOf(made, "osm-node-1");
    const second = estimateOf(made, "osm-node-2");
    expect(first.color).toBe("red");
    expect(first.trigger).toBe("rip-current");
    expect(second.color).toBe("red");
    expect(second.trigger).toBe("rip-current");
  });

  it("pools the per-WFO fetches with one WFO throwing and one null, isolating each to its own beaches", async function () {
    const urls = [];
    let inFlight = 0;
    let peakInFlight = 0;
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      urls.push(target);
      if (target.indexOf("/products/types/SRF/") === -1) {
        return Promise.reject(new Error("network disabled in test"));
      }
      inFlight = inFlight + 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      return new Promise(function (resolve) {
        setTimeout(function () {
          inFlight = inFlight - 1;
          if (target.indexOf("/locations/LOT/") !== -1) {
            resolve({ ok: false, status: 404 });
            return;
          }
          resolve({
            ok: true,
            status: 200,
            json: function () {
              // GRR's product text throws when the parser coerces it, the only
              // route to a genuine throw past fetchLatestSrfText's null contract.
              const text = target.indexOf("/locations/GRR/") !== -1
                ? { toString: function () { throw new Error("bad product text"); } }
                : "SRFMKX\n\n.TODAY...\nRIP CURRENT RISK IS HIGH.\n";
              return Promise.resolve({ productText: text });
            }
          });
        }, 5);
      });
    });

    const made = makeEnv([
      makeBeachRow({
        id: "osm-node-1",
        nws_zone: "MIZ071",
        nws_grid_url: "https://api.weather.gov/gridpoints/GRR/33,33"
      }),
      makeBeachRow({
        id: "osm-node-2",
        name: "Test Beach Beta",
        nws_zone: "ILZ014",
        nws_grid_url: "https://api.weather.gov/gridpoints/LOT/76,73"
      }),
      makeBeachRow({
        id: "osm-node-3",
        name: "Test Beach Gamma",
        nws_zone: "WIZ066",
        nws_grid_url: "https://api.weather.gov/gridpoints/MKX/80,60"
      })
    ]);
    await runHourlyCron(made.env);

    const srfRequests = urls.filter(function (u) {
      return u.indexOf("/products/types/SRF/") !== -1;
    });
    expect(srfRequests.sort()).toEqual([
      "https://api.weather.gov/products/types/SRF/locations/GRR/latest",
      "https://api.weather.gov/products/types/SRF/locations/LOT/latest",
      "https://api.weather.gov/products/types/SRF/locations/MKX/latest"
    ]);
    expect(peakInFlight).toBe(3);

    const first = estimateOf(made, "osm-node-1");
    const second = estimateOf(made, "osm-node-2");
    const third = estimateOf(made, "osm-node-3");
    // The throwing and null WFOs carry no rip input and no SRF source.
    for (const estimate of [first, second]) {
      expect(estimate.ripCurrentRisk).toBeNull();
      expect(estimate.trigger).not.toBe("rip-current");
      expect(estimate.sources.some(function (s) {
        return s.label === "NWS Surf Zone Forecast";
      })).toBe(false);
    }
    expect(third.color).toBe("red");
    expect(third.trigger).toBe("rip-current");
    expect(third.ripCurrentRisk).toBe("HIGH");
    expect(third.sources).toContainEqual({
      label: "NWS Surf Zone Forecast",
      url: "https://api.weather.gov/products/types/SRF/locations/MKX/latest"
    });
  });
});

// Step 8's official_expires: writeEpoch + FLAG_TTL_SECONDS (25200) by default,
// so the record never expires ahead of the estimate displayFlag weighs it
// against, unless the scraper declares a numeric officialTtlSeconds (no
// registered scraper does) or an officialMaxAgeMs, which anchors the lease to
// the record's updated instant instead of the run.
// The NWS Grand Rapids "Other Marine Reports" product, the one registered
// scraper that also publishes point-in-time observations and the one that
// declares officialMaxAgeMs. Issued 14:56Z, read at 18:00Z, so both the reading
// and the posted flag are still inside their four-hour horizon.
const OMR_ISSUANCE = "2026-07-21T14:56:00+00:00";
const OMR_NOW = "2026-07-21T18:00:00Z";
// Read again at 20:00Z, past the horizon: the product is still the newest one
// NWS lists, and nothing off it may be written.
const OMR_LATE = "2026-07-21T20:00:00Z";

function omrProduct() {
  return [
    "000",
    "SXUS83 KGRR 211456",
    "OMRGRR",
    "",
    "Other Marine Reports",
    "National Weather Service Grand Rapids MI",
    "1056 AM EDT Tue Jul 21 2026",
    "",
    "Lake Michigan Beach Reports",
    "                               Water      Wave        Flag",
    "Location                       Temp       Height      Color ",
    "Ludington State Park           68 F       4 ft        Red",
    "",
    "$$"
  ].join("\n");
}

function omrJson(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve(body); }
  });
}

describe("runFlagRecompute official_expires (default vs officialTtlSeconds)", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a scraper without officialTtlSeconds gets the default 25200 s lease (south-haven)", async function () {
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

    const official = officialOf(made, "osm-node-sh");
    expect(official).not.toBeNull();
    expect(expiresOf(made, "osm-node-sh", "official_expires")).toBe(nowEpoch() + 25200);
    expect(official.color).toBe("red");
  });

  // A point-in-time observation expires on its own column, at an ABSOLUTE
  // instant anchored to the observation rather than the cron tick, so a morning
  // reading dies four hours after it was taken no matter which run picked it up.
  it("a reading expires four hours past the observation, not the run", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(OMR_NOW));

    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target.indexOf("/products/types/OMR/locations/GRR") !== -1) {
        return omrJson({ "@graph": [{ id: "newest-id", issuanceTime: OMR_ISSUANCE }] });
      }
      if (target.indexOf("/products/newest-id") !== -1) {
        return omrJson({ productText: omrProduct(), issuanceTime: OMR_ISSUANCE });
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({
        id: "osm-node-ludington",
        name: "Ludington State Park",
        lat: 43.9585,
        lon: -86.4790
      })
    ]);
    await runHourlyCron(made.env);

    const reading = readingOf(made, "osm-node-ludington");
    expect(reading).not.toBeNull();
    expect(reading.waterTempF).toBe(68);
    expect(reading.waveHeightFt).toBe(4);
    const horizon = Math.floor((Date.parse(OMR_ISSUANCE) + READING_MAX_AGE_MS) / 1000);
    expect(expiresOf(made, "osm-node-ludington", "reading_expires")).toBe(horizon);
    // The flag off the same product is the same morning observation, so it
    // takes the same absolute lease rather than the run's 25200 s.
    expect(officialOf(made, "osm-node-ludington").color).toBe("red");
    expect(expiresOf(made, "osm-node-ludington", "official_expires")).toBe(horizon);
    expect(horizon).toBeLessThan(nowEpoch() + 25200);
  });

  // A run past the horizon writes neither record and pairs no history row, so
  // a re-scrape of the same product cannot extend the flag's life.
  it("a run past the four-hour horizon writes no official and no reading", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(OMR_LATE));

    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target.indexOf("/products/types/OMR/locations/GRR") !== -1) {
        return omrJson({ "@graph": [{ id: "newest-id", issuanceTime: OMR_ISSUANCE }] });
      }
      if (target.indexOf("/products/newest-id") !== -1) {
        return omrJson({ productText: omrProduct(), issuanceTime: OMR_ISSUANCE });
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({
        id: "osm-node-ludington",
        name: "Ludington State Park",
        lat: 43.9585,
        lon: -86.4790
      })
    ]);
    await runHourlyCron(made.env);

    expect(estimateOf(made, "osm-node-ludington")).not.toBeNull();
    expect(officialOf(made, "osm-node-ludington")).toBeNull();
    expect(expiresOf(made, "osm-node-ludington", "official_expires")).toBeNull();
    expect(readingOf(made, "osm-node-ludington")).toBeNull();
    expect(findHistoryStatements(made.batchCalls)).toHaveLength(0);
  });
});

describe("officialExpiryEpoch", function () {
  const NOW = Math.floor(Date.parse(OMR_NOW) / 1000);
  const flag = { updated: OMR_ISSUANCE };

  it("defaults to the estimate's write-time lease", function () {
    expect(officialExpiryEpoch({ id: "x" }, flag, NOW)).toBe(NOW + 25200);
  });

  it("honors officialTtlSeconds as a write-time lease", function () {
    expect(officialExpiryEpoch({ id: "x", officialTtlSeconds: 600 }, flag, NOW))
      .toBe(NOW + 600);
  });

  it("anchors officialMaxAgeMs to the record's updated instant", function () {
    const scraper = { id: "x", officialMaxAgeMs: READING_MAX_AGE_MS };
    expect(officialExpiryEpoch(scraper, flag, NOW))
      .toBe(Math.floor((Date.parse(OMR_ISSUANCE) + READING_MAX_AGE_MS) / 1000));
  });

  it("officialMaxAgeMs wins over a declared officialTtlSeconds", function () {
    const scraper = { id: "x", officialMaxAgeMs: READING_MAX_AGE_MS, officialTtlSeconds: 600 };
    expect(officialExpiryEpoch(scraper, flag, NOW))
      .toBe(Math.floor((Date.parse(OMR_ISSUANCE) + READING_MAX_AGE_MS) / 1000));
  });

  it("returns null within 60 s of the horizon or past it", function () {
    const scraper = { id: "x", officialMaxAgeMs: READING_MAX_AGE_MS };
    const horizon = Math.floor((Date.parse(OMR_ISSUANCE) + READING_MAX_AGE_MS) / 1000);
    expect(officialExpiryEpoch(scraper, flag, horizon - 60)).toBe(horizon);
    expect(officialExpiryEpoch(scraper, flag, horizon - 59)).toBeNull();
    expect(officialExpiryEpoch(scraper, flag, horizon + 3600)).toBeNull();
  });

  it("returns null for an unparseable updated under officialMaxAgeMs", function () {
    const scraper = { id: "x", officialMaxAgeMs: READING_MAX_AGE_MS };
    expect(officialExpiryEpoch(scraper, { updated: "yesterday" }, NOW)).toBeNull();
    expect(officialExpiryEpoch(scraper, { updated: null }, NOW)).toBeNull();
  });

  it("ignores an invalid officialMaxAgeMs and falls back to the write-time lease", function () {
    expect(officialExpiryEpoch({ id: "x", officialMaxAgeMs: NaN }, flag, NOW)).toBe(NOW + 25200);
    expect(officialExpiryEpoch({ id: "x", officialMaxAgeMs: 0 }, flag, NOW)).toBe(NOW + 25200);
    expect(officialExpiryEpoch({ id: "x", officialMaxAgeMs: "14400000" }, flag, NOW))
      .toBe(NOW + 25200);
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
    expect(estimateOf(made, "osm-node-sh")).not.toBeNull();
  });
});

// After the per-beach loop, runFlagRecompute batches one
// "UPDATE beaches SET recompute_updated = ?1 WHERE id = ?2" per processed
// beach — the rotation that guarantees full-table coverage. A failed batch is
// swallowed (the beach_state rows must survive).
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

    const made = makeEnv([
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

  it("a rejected UPDATE batch is swallowed — the run completes and the state rows survive", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnv([
      makeBeachRow({ id: "osm-node-1" }),
      makeBeachRow({ id: "osm-node-2", name: "Test Beach Beta", lat: 44.81, lon: -83.31 })
    ]);
    made.db.failWhen(function (sql) {
      return sql.indexOf("UPDATE beaches SET recompute_updated") === 0;
    });
    await runHourlyCron(made.env);

    // The batch WAS attempted...
    expect(findRecomputeUpdates(made.batchCalls).length).toBe(2);
    // ...and its failure never poisoned the state rows already committed.
    expect(estimateOf(made, "osm-node-1")).not.toBeNull();
    expect(estimateOf(made, "osm-node-2")).not.toBeNull();
  });
});

// last_viewed demand-aware ordering: the recompute rotation's normal
// (recompute_updated ASC, id ASC) queue is fronted by a hot-first guard so a
// beach a real visitor looked at within HOT_VIEW_WINDOW_MS gets refreshed
// before the cold sweep catches up to it. The window is 7 days — far longer
// than the estimate's lease — so a beach's hotness never flaps mid-lifecycle.
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
      // The hourly splats b.* and carries the wave columns over the beach_state
      // join; the water-temp cron's own SELECT names its columns and stays
      // unjoined, so this literal picks exactly one of the two.
      return b.sql.indexOf(
        "SELECT b.*, s.wave, s.wave_expires FROM beaches b" +
        " LEFT JOIN beach_state s ON s.beach_id = b.id WHERE"
      ) !== -1 && b.sql.indexOf("ORDER BY") !== -1;
    });
    expect(selectBinds.length).toBe(1);
    const sql = selectBinds[0].sql;
    const hotIdx = sql.indexOf("(last_viewed IS NOT NULL AND last_viewed >= ?1) DESC");
    const recomputeIdx = sql.indexOf("recompute_updated ASC, id ASC");
    expect(hotIdx).toBeGreaterThan(-1);
    // The hot guard must precede the pre-existing rotation key — NULLS/never-
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
      makeBeachRow({ id: "osm-node-1", last_viewed: recentIso, recompute_updated: "2026-01-02T00:00:00.000Z" }),
      makeBeachRow({ id: "osm-node-2", name: "Test Beach Beta", lat: 44.81, lon: -83.31, last_viewed: staleIso, recompute_updated: "2026-01-01T00:00:00.000Z" }),
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
    expect(summaryLine).toContain("oldest=2026-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Integration coverage for the registered sources: ECCC marine warnings raising
// a Canadian beach, a raise-only water-quality floor lifting a green (and not
// lowering a hazard red), and an official scraper overriding the estimate. All run
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

      const estimate = estimateOf(made, "osm-way-marine-1");
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
      const made = makeEnv([mnBeachRow()]);
      made.db.seedWave("osm-node-duluth-1", {
        beachId: "osm-node-duluth-1",
        waveHeightFt: 1.0,
        model: "noaa_glwu",
        windSpeedMph: null,
        windGustMph: null,
        updated: "2026-07-18T12:00:00.000Z"
      });
      await runHourlyCron(made.env);

      const estimate = estimateOf(made, "osm-node-duluth-1");
      expect(estimate.color).toBe("yellow");
      expect(estimate.trigger).toBe("wq-floor");
      expect(estimate.reason.indexOf("Water-quality advisory (")).toBe(0);

      // The structured advisory is persisted for the request path.
      const advisory = wqfloorOf(made, "osm-node-duluth-1");
      expect(advisory).not.toBeNull();
      expect(advisory.color).toBe("yellow");
      // Its own shorter lease: expiry is the only retraction path for a cleared
      // advisory, so it must not inherit the estimate's seven hours.
      expect(expiresOf(made, "osm-node-duluth-1", "wqfloor_expires"))
        .toBe(expiresOf(made, "osm-node-duluth-1", "estimate_expires") - 25200 + 7200);
    })();
  });

  it("a water-quality advisory NEVER lowers a wave-height red", function () {
    return (async function () {
      vi.stubGlobal("fetch", mnAdvisoryFetch("Elevated E. coli bacteria"));
      const made = makeEnv([mnBeachRow()]);
      made.db.seedWave("osm-node-duluth-1", {
        beachId: "osm-node-duluth-1",
        waveHeightFt: 5.0,
        model: "noaa_glwu",
        windSpeedMph: null,
        windGustMph: null,
        updated: "2026-07-18T12:00:00.000Z"
      });
      await runHourlyCron(made.env);

      const estimate = estimateOf(made, "osm-node-duluth-1");
      expect(estimate.color).toBe("red");
      expect(estimate.trigger).toBe("wave-height");
      // The advisory is still recorded for the request path — it just did not
      // (and must not) pull the hazard red down.
      expect(wqfloorOf(made, "osm-node-duluth-1")).not.toBeNull();
    })();
  });

  // A Kenosha County beach at a curated LAKE_MICHIGAN_SITES coordinate, so
  // kenoshaBeachConditions matches it by proximity.
  function kenoshaBeachRow() {
    return makeBeachRow({
      id: "osm-node-kenosha-1",
      name: "Alford Park Beach",
      lat: 42.619,
      lon: -87.795
    });
  }

  function seedCalmWave(made, id) {
    made.db.seedWave(id, {
      beachId: id,
      waveHeightFt: 1.0,
      model: "noaa_glwu",
      windSpeedMph: null,
      windGustMph: null,
      updated: "2026-07-18T12:00:00.000Z"
    });
  }

  it("fetches two distinct wqFloor sources concurrently and isolates each", async function () {
    const mnFetch = mnAdvisoryFetch("Elevated E. coli bacteria");
    let inFlight = 0;
    let peakInFlight = 0;
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      const isMn = target.indexOf("mnbeaches.org") !== -1;
      const isKenosha = target.indexOf("kenoshacountywi.gov") !== -1;
      if (!isMn && !isKenosha) {
        return Promise.reject(new Error("network disabled in test"));
      }
      inFlight = inFlight + 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      return new Promise(function (resolve) {
        setTimeout(function () {
          inFlight = inFlight - 1;
          if (isKenosha) {
            resolve({ ok: false, status: 404 });
            return;
          }
          resolve(mnFetch(url));
        }, 5);
      });
    });

    const made = makeEnv([mnBeachRow(), kenoshaBeachRow()]);
    seedCalmWave(made, "osm-node-duluth-1");
    seedCalmWave(made, "osm-node-kenosha-1");
    await runHourlyCron(made.env);

    expect(peakInFlight).toBe(2);
    const duluth = estimateOf(made, "osm-node-duluth-1");
    expect(duluth.color).toBe("yellow");
    expect(duluth.trigger).toBe("wq-floor");
    const kenosha = estimateOf(made, "osm-node-kenosha-1");
    expect(kenosha.trigger).toBe("wave-height");
    expect(wqfloorOf(made, "osm-node-kenosha-1")).toBeNull();
  });

  it("an expired wq gather deadline leaves every source unfetched, the same outcome as a failed scrape", async function () {
    const urls = [];
    const mnFetch = mnAdvisoryFetch("Elevated E. coli bacteria");
    vi.stubGlobal("fetch", function (url) {
      urls.push(typeof url === "string" ? url : (url && url.url) || "");
      return mnFetch(url);
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});

    const made = makeEnv([mnBeachRow()]);
    made.env.WQ_GATHER_DEADLINE_MS = 0;
    seedCalmWave(made, "osm-node-duluth-1");
    await runHourlyCron(made.env);

    expect(urls.some(function (u) { return u.indexOf("mnbeaches.org") !== -1; })).toBe(false);
    const estimate = estimateOf(made, "osm-node-duluth-1");
    expect(estimate).not.toBeNull();
    expect(estimate.color).toBe("green");
    expect(estimate.trigger).toBe("wave-height");
    expect(wqfloorOf(made, "osm-node-duluth-1")).toBeNull();
    expect(loggedLines(logSpy)).toContain("index: wqFloor gather deadline reached=0 of 1 sources");
    logSpy.mockRestore();
  });

  it("a registered official scraper writes an official override", function () {
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

      const official = officialOf(made, "osm-node-tower-1");
      expect(official).not.toBeNull();
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
// Everything below asserts what a truncated run must still deliver against
// workerd's 900 s scheduled ceiling: a persisted prefix, not nothing.
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
      "unattempted=0 failures=0 watertemp=120 truncated=no stations=1 live=1"
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
    // The failed beach is not stamped: it persisted nothing, so advancing its
    // wave_updated cursor would send a beach with no data to the BACK of the
    // rotation. Unstamped means NULL, which sorts first next run. The RUN is
    // still complete — failures= carries the one bad put and truncated= stays
    // "no", so a flaky put cannot trip the truncation alarm.
    expect(logged).toContain(
      "index: water temp refresh complete, beaches=60 stamped=59 reached=60 " +
      "unattempted=0 failures=1 watertemp=59 truncated=no stations=1 live=1"
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
      "unattempted=3 failures=0 watertemp=0 truncated=yes stations=0 live=0"
    );
  });
});

// The NDBC water-temperature pass (display-only: it colors no flag and never
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
// resolves the same station for every one of them and the pass must dedup down
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
    // One unique station consulted, one live: the trip-wire for a station
    // family going dark is live= falling to 0 while stations= holds.
    expect(loggedLines(logSpy)).toContain("watertemp=60 truncated=no stations=1 live=1");
  });

  it("writes no beach_state wave column: the record belongs to the offline pipeline", async function () {
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
    // and the wave record is applied into beach_state from GitHub Actions. It
    // owns beaches.wave_updated, one underscore away in name and unrelated.
    const state = made.db.stateOf("osm-node-0");
    expect(state === null || state.wave === null).toBe(true);
    expect(state === null || state.wave_expires === null).toBe(true);
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
      "unattempted=0 failures=0 watertemp=0 truncated=no stations=1 live=0"
    );
  });
});

// Step 6 runs the per-beach estimate through the bounded pool and collects a
// write descriptor per beach; step 7b flushes those before the scrape pass and
// step 8b flushes the officials and readings after it, each in chunked D1
// batches. Two invariants survive the batching: a flag_history row exists only
// for a beach whose estimate chunk committed, and a failure in the scrape pass
// or its flush never costs a beach the estimate already persisted.
describe("runFlagRecompute pooled estimates and the beach_state flush", function () {
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

  it("writes one beach_state row per beach and keeps flag_history in query order", async function () {
    // Inside South Haven's monitored season/hours so the scraper does not gate
    // itself off.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));
    vi.stubGlobal("fetch", southHavenFetch());

    const rows = southHavenBeaches(120);
    const made = makeEnv(rows);
    await runHourlyCron(made.env);

    // The estimate pass and the scrape pass each pushed a descriptor for every
    // beach, flushed separately; both COALESCE onto the same row, so a beach
    // that produced both ends the run as one row carrying both.
    for (const row of rows) {
      expect(estimateOf(made, row.id)).not.toBeNull();
      expect(officialOf(made, row.id)).not.toBeNull();
      expect(expiresOf(made, row.id, "estimate_expires")).toBe(nowEpoch() + 25200);
      expect(expiresOf(made, row.id, "official_expires")).toBe(nowEpoch() + 25200);
    }

    // The history step iterates the beaches array, not the estimate/official
    // Maps, so a pooled (nondeterministic) write order must remain invisible
    // here: the rows come back in the SELECT's id ASC order.
    const historyRows = findHistoryStatements(made.batchCalls);
    expect(historyRows.length).toBe(120);
    const historyIds = historyRows.map(function (h) { return h.args[0]; });
    expect(historyIds).toEqual(rows.map(function (b) { return b.id; }).sort());
  });

  it("a rejected estimate chunk excludes its beaches from flag_history", async function () {
    // The ordering invariant under batching: a chunk that fails leaves its rows
    // unwritten, and no calibration row may claim an estimate that never landed.
    // The chunk is all-or-nothing, so one poisoned statement costs every beach
    // in it — and none outside it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));
    vi.stubGlobal("fetch", southHavenFetch());

    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    const rows = southHavenBeaches(205);
    const made = makeEnv(rows);
    // Only the estimate flush: its statements bind the estimate blob as ?2.
    made.db.failWhen(function (sql, args) {
      return sql.indexOf("INSERT INTO beach_state") === 0 &&
        args[1] !== null && args[0] === "osm-node-7";
    });
    await runHourlyCron(made.env);

    expect(estimateOf(made, "osm-node-7")).toBeNull();
    // The official flush is a separate statement on the same row, so the
    // scraped color still lands beside the missing estimate.
    expect(officialOf(made, "osm-node-7")).not.toBeNull();

    const historyIds = findHistoryStatements(made.batchCalls).map(function (h) { return h.args[0]; });
    expect(historyIds.length).toBeGreaterThan(0);
    expect(historyIds.indexOf("osm-node-7")).toBe(-1);
    // Exactly the beaches with a persisted estimate and a scraped official are
    // paired: none is logged for a beach whose chunk rolled back, and none is
    // withheld from a beach whose did.
    let persistedEstimates = 0;
    let persistedOfficials = 0;
    for (const row of rows) {
      const hasEstimate = estimateOf(made, row.id) !== null;
      const hasOfficial = officialOf(made, row.id) !== null;
      if (hasEstimate) {
        persistedEstimates = persistedEstimates + 1;
      }
      if (hasOfficial) {
        persistedOfficials = persistedOfficials + 1;
      }
      expect(historyIds.indexOf(row.id) !== -1).toBe(hasEstimate && hasOfficial);
    }
    // 205 estimate statements chunk 200 + 5; the chunk holding osm-node-7 is
    // the only rejected one, and every official statement landed.
    expect(persistedEstimates).toBe(5);
    expect(loggedLines(logSpy)).toContain(
      " stateRows=" + String(persistedEstimates + persistedOfficials) +
      " stateFailures=" + String(205 - persistedEstimates)
    );
  });

  it("keeps every estimate when the official flush rejects", async function () {
    // The durability split: the estimates are already committed when the scrape
    // pass starts, so a rejected official chunk — or a run killed anywhere in
    // that pass — costs officials and readings only.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));
    vi.stubGlobal("fetch", southHavenFetch());

    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    const rows = southHavenBeaches(120);
    const made = makeEnv(rows);
    // Only the official flush: its statements bind a NULL estimate (?2) and an
    // official blob (?6).
    made.db.failWhen(function (sql, args) {
      return sql.indexOf("INSERT INTO beach_state") === 0 &&
        args[1] === null && args[5] !== null;
    });
    await runHourlyCron(made.env);

    for (const row of rows) {
      expect(estimateOf(made, row.id)).not.toBeNull();
      expect(officialOf(made, row.id)).toBeNull();
    }
    expect(loggedLines(logSpy)).toContain(" stateRows=120 stateFailures=120");
  });

  it("retries a chunk once, so a transient D1 rejection costs nothing", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:00:00Z"));
    vi.stubGlobal("fetch", southHavenFetch());

    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    const rows = southHavenBeaches(120);
    const made = makeEnv(rows);
    let rejected = 0;
    // The estimate flush's first chunk rejects exactly once; the retry lands.
    made.db.failWhen(function (sql, args) {
      if (rejected === 0 && sql.indexOf("INSERT INTO beach_state") === 0 && args[1] !== null) {
        rejected = rejected + 1;
        return true;
      }
      return false;
    });
    await runHourlyCron(made.env);

    expect(rejected).toBe(1);
    for (const row of rows) {
      expect(estimateOf(made, row.id)).not.toBeNull();
    }
    const lines = loggedLines(logSpy);
    expect(lines).toContain("beach_state chunk of 120 failed, retrying once");
    expect(lines).toContain(" stateRows=240 stateFailures=0");
  });
});

describe("runFlagRecompute wave input finite guards", function () {
  beforeEach(function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });
  });

  afterEach(function () {
    vi.unstubAllGlobals();
  });

  // Seeded as raw JSON text, not through a JS object: these are the only two
  // spellings of a non-finite number that can reach the guards from a stored
  // blob. JSON.parse turns an out-of-range literal into Infinity and leaves a
  // quoted number a string, while JSON.stringify can spell neither.
  function waveBlob(waveHeightText, windText) {
    return "{\"beachId\":\"osm-node-1\"," +
      "\"waveHeightFt\":" + waveHeightText + "," +
      "\"model\":\"noaa_glwu\"," +
      "\"windSpeedMph\":" + windText + "," +
      "\"windGustMph\":null," +
      "\"updated\":\"2026-07-18T12:00:00.000Z\"}";
  }

  function estimateFor(blob) {
    const made = makeEnv([makeBeachRow({ id: "osm-node-1" })]);
    made.db.seedState("osm-node-1", {
      wave: blob,
      wave_expires: Math.floor(Date.now() / 1000) + 86400
    });
    return runHourlyCron(made.env).then(function () {
      return estimateOf(made, "osm-node-1");
    });
  }

  it("refuses a non-finite wave height instead of calling it green", async function () {
    // rules.js step 3's else branch has no finite check, so an unguarded
    // Infinity decides green with a nonsense reason — a green from garbage in
    // the one module that must never default to green.
    const infinite = await estimateFor(waveBlob("1e400", "null"));
    expect(infinite.trigger).not.toBe("wave-height");
    expect(infinite.color).toBe("unknown");
    expect(infinite.waveHeightFt).toBe(null);
    const infiniteLabels = infinite.sources.map(function (s) { return s.label; });
    expect(infiniteLabels.indexOf("NOAA Great Lakes Wave Model")).toBe(-1);

    const quoted = await estimateFor(waveBlob("\"4.5\"", "null"));
    expect(quoted.trigger).not.toBe("wave-height");
    expect(quoted.color).toBe("unknown");
  });

  it("refuses a non-finite wind speed instead of falling back on it", async function () {
    const estimate = await estimateFor(waveBlob("null", "1e400"));
    expect(estimate.trigger).not.toBe("wind");
    expect(estimate.color).toBe("unknown");
    const labels = estimate.sources.map(function (s) { return s.label; });
    expect(labels.indexOf("Wind Forecast")).toBe(-1);
  });

  it("still takes a finite wave height", async function () {
    const estimate = await estimateFor(waveBlob("4.5", "null"));
    expect(estimate.trigger).toBe("wave-height");
    expect(estimate.color).toBe("red");
  });
});

// One landed cycle has to color a day of runs, or the offline pipeline is back to
// publishing every three hours. The hour index is what does that, and reading the
// wrong hour is invisible: the color is plausible, the reason string names a real
// height, and nothing in the payload says which hour it came from.
describe("runFlagRecompute indexes the wave series at the hour it estimates",
  function () {
    const START = "2026-07-18T00:00:00.000Z";

    beforeEach(function () {
      vi.stubGlobal("fetch", function () {
        return Promise.reject(new Error("network disabled in test"));
      });
      vi.useFakeTimers({ toFake: ["Date"] });
    });

    afterEach(function () {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    // Calm through hour 5, then over the 4 ft red threshold from hour 6.
    function seriesInput() {
      const hoursFt = [];
      for (let h = 0; h < 24; h = h + 1) { hoursFt.push(h < 6 ? 1 : 5); }
      return {
        beachId: "osm-node-1",
        waveHeightFt: 1,
        model: "noaa_glwu",
        windSpeedMph: null,
        windGustMph: null,
        startIso: START,
        hoursFt: hoursFt,
        updated: START
      };
    }

    // expiresEpoch overrides the writer's own validStartEpoch + 86400 lease,
    // which a run at hour 24 would find exactly expired: the gray this describe
    // is about has to come from the spent series, not from the column lease.
    function estimateAt(hour, expiresEpoch) {
      vi.setSystemTime(new Date(Date.parse(START) + hour * 3600000));
      const made = makeEnv([makeBeachRow({ id: "osm-node-1" })]);
      made.db.seedWave("osm-node-1", seriesInput(), expiresEpoch);
      return runHourlyCron(made.env).then(function () {
        return estimateOf(made, "osm-node-1");
      });
    }

    it("colors from hour 0 at the valid start", async function () {
      const estimate = await estimateAt(0);
      expect(estimate.color).toBe("green");
      expect(estimate.reason).toContain("1.0 ft");
    });

    it("colors from the later hour once the run reaches it", async function () {
      const estimate = await estimateAt(9);
      expect(estimate.color).toBe("red");
      expect(estimate.reason).toContain("5.0 ft");
    });

    it("goes gray rather than replaying hour 0 once the series is spent",
      async function () {
        const generous = Math.floor(Date.parse(START) / 1000) + 10 * 86400;
        const estimate = await estimateAt(24, generous);
        expect(estimate.color).toBe("unknown");
        expect(estimate.reason).not.toContain("ft");
      });
  });

// A throw escaping a runner's top level is the one failure the cron path does
// not swallow: it is logged and rejects the scheduled promise, which is what
// records the invocation as failed. Inner isolation (a rejected chunk, a failed
// scrape) still resolves, as the flush tests above pin.
describe("whole-run failure rejects the scheduled promise", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hourly: a failing opening SELECT rejects and writes no beach_state row", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    const made = makeEnv([makeBeachRow({ id: "osm-node-1", nws_zone: "MIZ071" })]);
    made.db.failWhen(function (sql) {
      return sql.indexOf("SELECT b.*") === 0;
    });

    await expect(runHourlyCron(made.env)).rejects.toThrow(/D1 fake: forced failure/);
    expect(made.db.stateOf("osm-node-1")).toBeNull();
    expect(loggedLines(logSpy)).toContain("index: flag recompute failed: D1 fake: forced failure");
    expect(loggedLines(logSpy)).toContain("index: scheduled flag recompute threw: D1 fake: forced failure");
  });

  it("water temp: a failing opening SELECT rejects and writes no key", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    const made = makeEnv([makeBeachRow({ id: "osm-node-1" })]);
    made.db.failWhen(function (sql) {
      return sql.indexOf("SELECT id, lat, lon, last_viewed") === 0;
    });

    await expect(runWaterTempCron(made.env)).rejects.toThrow(/D1 fake: forced failure/);
    expect(made.kvPuts.size).toBe(0);
    expect(loggedLines(logSpy)).toContain("index: water temp refresh failed: D1 fake: forced failure");
  });
});

// The hourly is the seal's producer. If it ever wrote a value the refresh cron's
// signalsFromStanding rejects, that cron would silently skip every beach — a
// regression visible only as skipNoSeal= in a log line nobody reads.
describe("runFlagRecompute writes the estimateInputs seal", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("stores a seal signalsFromStanding accepts, carrying the non-alert inputs", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network disabled in test"));
    });
    const made = makeEnv(
      [makeBeachRow({ id: "osm-node-seal", nws_zone: "MIZ071" })]
    );
    // No series, so resolveWaveInput falls through to the hour-0 scalar. A seal
    // carrying a non-null wind is the wind-fallback block's case: wind is offered
    // only where the resolved wave height is null.
    made.db.seedWave("osm-node-seal", {
      waveHeightFt: 2.6,
      model: "noaa_glwu",
      windSpeedMph: null,
      windGustMph: null,
      updated: "2026-07-15T15:00:00.000Z"
    });
    await runHourlyCron(made.env);

    const stored = estimateOf(made, "osm-node-seal");
    expect(stored.estimateInputs.v).toBe(FLAG_SEAL_VERSION);
    // The national fetch failed, so the hourly decided this color with no alert
    // evidence at all — the fact the refresh cron needs to re-select the beach.
    expect(stored.estimateInputs.alertsResolved).toBe(false);
    expect(stored.estimateInputs.windSpeedMph).toBeNull();
    expect(stored.estimateInputs.waterQualityAdvisory).toBeNull();

    const signals = signalsFromStanding(JSON.parse(JSON.stringify(stored)));
    expect(signals).not.toBeNull();
    expect(signals.waveHeightFt).toBe(2.6);
    expect(signals.updated).toBe(stored.updated);
    // The seal plus the echo reproduce the published color exactly.
    expect(estimateFlag(buildEstimateInputs(
      { id: "osm-node-seal", nws_zone: "MIZ071", marine_zone: null, eccc_zone: null },
      { alerts: null, alertDetails: null, alertSources: [], alertsResolved: false, alertsAt: null },
      signals
    ))).toEqual({
      beachId: stored.beachId,
      color: stored.color,
      reason: stored.reason,
      trigger: stored.trigger,
      rules_version: stored.rules_version,
      official: stored.official,
      sources: stored.sources,
      updated: stored.updated,
      waveHeightFt: stored.waveHeightFt,
      alertDetails: stored.alertDetails,
      alertsAt: stored.alertsAt,
      ripCurrentRisk: stored.ripCurrentRisk
    });
  });
});
