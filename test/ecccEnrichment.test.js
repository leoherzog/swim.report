// runEcccEnrichment (cron "29 4,10,16,22 * * *"): beaches that NWS point
// enrichment permanently parked get their ECCC public forecast region name;
// a null lookup (US point or transient failure) bumps eccc_attempts so
// unresolvable rows eventually park, mirroring the NWS attempts cap.
import { describe, it, expect, vi, afterEach } from "vitest";
import { runScheduledCron } from "./helpers/cron.js";

// DB stub: .all() serves the candidate rows for the SELECT, .first() serves
// the parked COUNT, and every .bind().run() is recorded with its SQL + args.
function makeEnrichmentEnv(candidateRows) {
  const runCalls = [];
  const preparedSql = [];
  const env = {
    // Production parks the run when the bulk zones fetch under-delivers
    // (~419 expected); these tests use 1-2 fixture zones, so lower the floor.
    ECCC_ZONES_SANITY_MIN: 1,
    DB: {
      prepare: function (sql) {
        preparedSql.push(sql);
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
      },
      batch: function (statements) {
        return Promise.resolve(statements.map(function () { return { success: true }; }));
      }
    },
    FLAGS: {
      get: function () { return Promise.resolve(null); },
      put: function () { return Promise.resolve(); }
    }
  };
  return { env: env, runCalls: runCalls, preparedSql: preparedSql };
}

function runEcccCron(env) {
  return runScheduledCron(env, "29 4,10,16,22 * * *");
}

// A ~0.4-degree square Polygon centered on (lat, lon) — a forecast-region
// stand-in the enrichment's local point-in-polygon resolves against.
function squareAround(lat, lon) {
  return {
    type: "Polygon",
    coordinates: [[
      [lon - 0.2, lat - 0.2],
      [lon + 0.2, lat - 0.2],
      [lon + 0.2, lat + 0.2],
      [lon - 0.2, lat + 0.2],
      [lon - 0.2, lat - 0.2]
    ]]
  };
}

// Stub fetch: the ONE forecast-zones request returns the given feature set;
// counts how many times fetch was called so the "one bulk fetch per run"
// contract is assertable.
function stubZonesFetch(features) {
  const state = { calls: 0 };
  vi.stubGlobal("fetch", function () {
    state.calls = state.calls + 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () { return Promise.resolve({ features: features }); }
    });
  });
  return state;
}

describe("runEcccEnrichment", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("resolves beaches locally from ONE bulk fetch and stamps eccc_zone", async function () {
    const fetchState = stubZonesFetch([
      {
        type: "Feature",
        properties: { NAME: "Windsor - Essex - Chatham-Kent" },
        geometry: squareAround(41.9836774, -82.9343626)
      },
      {
        type: "Feature",
        properties: { NAME: "Blind River - Thessalon" },
        geometry: squareAround(46.26, -83.28)
      }
    ]);

    const made = makeEnrichmentEnv([
      { id: "osm-way-175343424", lat: 41.9836774, lon: -82.9343626 },
      { id: "osm-node-ca-2", lat: 46.26, lon: -83.28 }
    ]);
    await runEcccCron(made.env);

    // ONE upstream request served both beaches (the whole point of F12).
    expect(fetchState.calls).toBe(1);
    const zoneUpdates = made.runCalls.filter(function (c) {
      return c.sql.indexOf("SET eccc_zone") !== -1;
    });
    expect(zoneUpdates.length).toBe(2);
    expect(zoneUpdates[0].args).toEqual(["Windsor - Essex - Chatham-Kent", "osm-way-175343424"]);
    expect(zoneUpdates[1].args).toEqual(["Blind River - Thessalon", "osm-node-ca-2"]);
    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("eccc_attempts + 1") !== -1;
    })).toBe(false);
  });

  it("bumps eccc_attempts for a point no region contains (a US point)", async function () {
    stubZonesFetch([
      {
        type: "Feature",
        properties: { NAME: "Windsor - Essex - Chatham-Kent" },
        geometry: squareAround(41.9836774, -82.9343626)
      }
    ]);

    const made = makeEnrichmentEnv([
      { id: "osm-node-us-1", lat: 42.401, lon: -86.288 }
    ]);
    await runEcccCron(made.env);

    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("SET eccc_zone") !== -1;
    })).toBe(false);
    const bumps = made.runCalls.filter(function (c) {
      return c.sql.indexOf("eccc_attempts + 1") !== -1;
    });
    expect(bumps.length).toBe(1);
    expect(bumps[0].args).toEqual(["osm-node-us-1"]);
  });

  it("mixes resolvable and unresolvable beaches in one run", async function () {
    stubZonesFetch([
      {
        type: "Feature",
        properties: { NAME: "Blind River - Thessalon" },
        geometry: squareAround(46.26, -83.28)
      }
    ]);

    const made = makeEnrichmentEnv([
      { id: "osm-node-us-1", lat: 42.401, lon: -86.288 },
      { id: "osm-node-ca-2", lat: 46.26, lon: -83.28 }
    ]);
    await runEcccCron(made.env);

    const bumps = made.runCalls.filter(function (c) {
      return c.sql.indexOf("eccc_attempts + 1") !== -1;
    });
    const zoneUpdates = made.runCalls.filter(function (c) {
      return c.sql.indexOf("SET eccc_zone") !== -1;
    });
    expect(bumps.map(function (c) { return c.args[0]; })).toEqual(["osm-node-us-1"]);
    expect(zoneUpdates.length).toBe(1);
    expect(zoneUpdates[0].args).toEqual(["Blind River - Thessalon", "osm-node-ca-2"]);
  });

  it("parks the whole run on a bulk-fetch failure: no updates, no attempt bumps", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.resolve({ ok: false, status: 503 });
    });

    const made = makeEnrichmentEnv([
      { id: "osm-node-ca-1", lat: 46.26, lon: -83.28 },
      { id: "osm-node-ca-2", lat: 46.27, lon: -83.29 }
    ]);
    await runEcccCron(made.env);

    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("SET eccc_zone") !== -1;
    })).toBe(false);
    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("eccc_attempts + 1") !== -1;
    })).toBe(false);
  });

  it("parks the whole run on an EMPTY 200 zones payload: no updates, no attempt bumps", async function () {
    stubZonesFetch([]);

    const made = makeEnrichmentEnv([
      { id: "osm-node-ca-1", lat: 46.26, lon: -83.28 },
      { id: "osm-node-ca-2", lat: 46.27, lon: -83.29 }
    ]);
    await runEcccCron(made.env);

    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("SET eccc_zone") !== -1;
    })).toBe(false);
    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("eccc_attempts + 1") !== -1;
    })).toBe(false);
  });

  it("selects candidates eccc_attempts-first, hot last_viewed tiebreak, RANDOM() last", async function () {
    stubZonesFetch([]);
    const made = makeEnrichmentEnv([]);
    await runEcccCron(made.env);

    const selects = made.preparedSql.filter(function (sql) {
      return sql.indexOf("SELECT id, lat, lon FROM beaches WHERE nws_zone IS NULL") !== -1;
    });
    expect(selects.length).toBe(1);
    expect(selects[0]).toContain("ORDER BY eccc_attempts ASC, last_viewed DESC NULLS LAST, RANDOM()");
    // eccc_attempts MUST stay the leading key (the parking guarantee);
    // last_viewed is only a demand-aware tiebreak, RANDOM() stays last.
    const attemptsIdx = selects[0].indexOf("eccc_attempts ASC");
    const lastViewedIdx = selects[0].indexOf("last_viewed DESC NULLS LAST");
    const randomIdx = selects[0].indexOf("RANDOM()");
    expect(attemptsIdx).toBeGreaterThan(-1);
    expect(lastViewedIdx).toBeGreaterThan(attemptsIdx);
    expect(randomIdx).toBeGreaterThan(lastViewedIdx);
  });

  it("parks the run under the DEFAULT sanity floor when a 200 under-delivers (2 of ~419 zones)", async function () {
    stubZonesFetch([
      {
        type: "Feature",
        properties: { NAME: "Blind River - Thessalon" },
        geometry: squareAround(46.26, -83.28)
      },
      {
        type: "Feature",
        properties: { NAME: "Windsor - Essex - Chatham-Kent" },
        geometry: squareAround(41.98, -82.93)
      }
    ]);

    const made = makeEnrichmentEnv([
      { id: "osm-node-ca-2", lat: 46.26, lon: -83.28 }
    ]);
    // Exercise the PRODUCTION floor (~100), not the test override.
    delete made.env.ECCC_ZONES_SANITY_MIN;
    await runEcccCron(made.env);

    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("SET eccc_zone") !== -1;
    })).toBe(false);
    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("eccc_attempts + 1") !== -1;
    })).toBe(false);
  });
});
