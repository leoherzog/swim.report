// runNwsEnrichment (cron "17 3,9,15,21 * * *"): beaches with nws_zone NULL
// get their forecast zone + gridpoint URL from api.weather.gov/points, 75 per
// run; a null lookup (404, missing fields, or a swallowed network throw)
// bumps enrichment_attempts so permanently-failing points eventually park,
// and one bad beach never aborts the rest of the batch.
import { describe, it, expect, vi, afterEach } from "vitest";
import { runScheduledCron } from "./helpers/cron.js";

// DB stub: records every prepare(sql) so the candidate SELECT's shape is
// assertable, serves candidateRows from .all(), serves the parked COUNT from
// .first(), and records every .bind().run() with its SQL + args. An optional
// failRun(sql, args) predicate makes a specific run() reject, to exercise the
// per-beach catch path.
function makeEnrichmentEnv(candidateRows, failRun) {
  const runCalls = [];
  const preparedSql = [];
  const env = {
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
              run: function () {
                if (failRun && failRun(sql, args)) {
                  return Promise.reject(new Error("d1 write failed"));
                }
                runCalls.push({ sql: sql, args: args });
                return Promise.resolve({ success: true });
              }
            };
          }
        };
      }
    }
  };
  return { env: env, runCalls: runCalls, preparedSql: preparedSql };
}

function runNwsCron(env) {
  return runScheduledCron(env, "17 3,9,15,21 * * *");
}

// A points payload in the shape fetchPointMetadata parses: forecastZone is a
// zone URL whose last path segment becomes nws_zone, forecastGridData is
// stored verbatim as nws_grid_url.
function pointsPayload(zoneId, gridUrl) {
  return {
    properties: {
      forecastZone: "https://api.weather.gov/zones/forecast/" + zoneId,
      forecastGridData: gridUrl
    }
  };
}

// Stub fetch keyed by exact request URL: each entry is either a payload
// object (served as a 200), the string "http-404" (ok:false), or the string
// "throw" (network error — fetchJson swallows it to null). Records every
// requested URL.
function stubPointsFetch(byUrl) {
  const state = { urls: [] };
  vi.stubGlobal("fetch", function (url) {
    state.urls.push(url);
    const entry = byUrl[url];
    if (entry === "throw") {
      return Promise.reject(new Error("connection reset"));
    }
    if (entry === "http-404" || entry === undefined) {
      return Promise.resolve({ ok: false, status: 404 });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () { return Promise.resolve(entry); }
    });
  });
  return state;
}

describe("runNwsEnrichment", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("stamps nws_zone + nws_grid_url from a successful points lookup", async function () {
    const gridUrl = "https://api.weather.gov/gridpoints/GRR/44,41";
    const fetchState = stubPointsFetch({
      "https://api.weather.gov/points/42.4010,-86.2880": pointsPayload("MIZ071", gridUrl)
    });

    const made = makeEnrichmentEnv([
      { id: "osm-node-1", lat: 42.401, lon: -86.288 }
    ]);
    await runNwsCron(made.env);

    // The request URL rounds coordinates to 4 decimals (api.weather.gov
    // redirects otherwise).
    expect(fetchState.urls).toEqual(["https://api.weather.gov/points/42.4010,-86.2880"]);
    const zoneUpdates = made.runCalls.filter(function (c) {
      return c.sql.indexOf("SET nws_zone = ?1, nws_grid_url = ?2") !== -1;
    });
    expect(zoneUpdates.length).toBe(1);
    expect(zoneUpdates[0].sql).toContain("UPDATE beaches SET nws_zone = ?1, nws_grid_url = ?2 WHERE id = ?3");
    expect(zoneUpdates[0].args).toEqual(["MIZ071", gridUrl, "osm-node-1"]);
    // A success never burns an attempt.
    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("enrichment_attempts + 1") !== -1;
    })).toBe(false);
  });

  it("bumps enrichment_attempts on a 404 points lookup and writes no zone", async function () {
    stubPointsFetch({
      "https://api.weather.gov/points/44.5000,-80.2170": "http-404"
    });

    const made = makeEnrichmentEnv([
      { id: "osm-node-ca-1", lat: 44.5, lon: -80.217 }
    ]);
    await runNwsCron(made.env);

    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("SET nws_zone") !== -1;
    })).toBe(false);
    const bumps = made.runCalls.filter(function (c) {
      return c.sql.indexOf("enrichment_attempts + 1") !== -1;
    });
    expect(bumps.length).toBe(1);
    expect(bumps[0].sql).toContain("UPDATE beaches SET enrichment_attempts = enrichment_attempts + 1");
    expect(bumps[0].args).toEqual(["osm-node-ca-1"]);
  });

  it("treats a 200 payload missing forecastZone/forecastGridData as a failed attempt", async function () {
    stubPointsFetch({
      "https://api.weather.gov/points/42.4010,-86.2880": { properties: {} }
    });

    const made = makeEnrichmentEnv([
      { id: "osm-node-1", lat: 42.401, lon: -86.288 }
    ]);
    await runNwsCron(made.env);

    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("SET nws_zone") !== -1;
    })).toBe(false);
    const bumps = made.runCalls.filter(function (c) {
      return c.sql.indexOf("enrichment_attempts + 1") !== -1;
    });
    expect(bumps.map(function (c) { return c.args[0]; })).toEqual(["osm-node-1"]);
  });

  it("selects candidates under the attempts cap, freshest-first with RANDOM(), capped at 75", async function () {
    stubPointsFetch({});
    const made = makeEnrichmentEnv([]);
    await runNwsCron(made.env);

    const selects = made.preparedSql.filter(function (sql) {
      return sql.indexOf("SELECT id, lat, lon FROM beaches WHERE nws_zone IS NULL") !== -1;
    });
    expect(selects.length).toBe(1);
    expect(selects[0]).toContain("enrichment_attempts < 5");
    expect(selects[0]).toContain("ORDER BY enrichment_attempts ASC, RANDOM()");
    expect(selects[0]).toContain("LIMIT 75");
  });

  it("still enriches row 2 when row 1's fetch throws (network error swallowed to a bump)", async function () {
    const gridUrl = "https://api.weather.gov/gridpoints/LOT/76,73";
    stubPointsFetch({
      "https://api.weather.gov/points/42.4010,-86.2880": "throw",
      "https://api.weather.gov/points/41.9670,-87.6510": pointsPayload("ILZ014", gridUrl)
    });

    const made = makeEnrichmentEnv([
      { id: "osm-node-1", lat: 42.401, lon: -86.288 },
      { id: "osm-node-2", lat: 41.967, lon: -87.651 }
    ]);
    await runNwsCron(made.env);

    // fetchJson's data-or-null contract swallows the throw, so row 1 lands on
    // the failed-attempt path rather than aborting the loop.
    const bumps = made.runCalls.filter(function (c) {
      return c.sql.indexOf("enrichment_attempts + 1") !== -1;
    });
    expect(bumps.map(function (c) { return c.args[0]; })).toEqual(["osm-node-1"]);
    const zoneUpdates = made.runCalls.filter(function (c) {
      return c.sql.indexOf("SET nws_zone") !== -1;
    });
    expect(zoneUpdates.length).toBe(1);
    expect(zoneUpdates[0].args).toEqual(["ILZ014", gridUrl, "osm-node-2"]);
  });

  it("still enriches row 2 when row 1's D1 zone UPDATE rejects (per-beach catch)", async function () {
    const gridUrl1 = "https://api.weather.gov/gridpoints/GRR/44,41";
    const gridUrl2 = "https://api.weather.gov/gridpoints/LOT/76,73";
    stubPointsFetch({
      "https://api.weather.gov/points/42.4010,-86.2880": pointsPayload("MIZ071", gridUrl1),
      "https://api.weather.gov/points/41.9670,-87.6510": pointsPayload("ILZ014", gridUrl2)
    });

    const made = makeEnrichmentEnv(
      [
        { id: "osm-node-1", lat: 42.401, lon: -86.288 },
        { id: "osm-node-2", lat: 41.967, lon: -87.651 }
      ],
      function (sql, args) {
        return sql.indexOf("SET nws_zone") !== -1 && args.indexOf("osm-node-1") !== -1;
      }
    );
    await runNwsCron(made.env);

    // Row 1's write failure is caught per-beach: it burns an attempt and the
    // loop continues to row 2.
    const bumps = made.runCalls.filter(function (c) {
      return c.sql.indexOf("enrichment_attempts + 1") !== -1;
    });
    expect(bumps.map(function (c) { return c.args[0]; })).toEqual(["osm-node-1"]);
    const zoneUpdates = made.runCalls.filter(function (c) {
      return c.sql.indexOf("SET nws_zone") !== -1;
    });
    expect(zoneUpdates.length).toBe(1);
    expect(zoneUpdates[0].args).toEqual(["ILZ014", gridUrl2, "osm-node-2"]);
  });
});
