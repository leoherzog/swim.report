// runNwsEnrichment (cron "17 3,9,15,21 * * *"): beaches with nws_zone NULL
// get their forecast zone + gridpoint URL from api.weather.gov/points, 75 per
// run; a null lookup (404, missing fields, or a swallowed network throw)
// bumps enrichment_attempts so permanently-failing points eventually park,
// and one bad beach never aborts the rest of the batch.
import { describe, it, expect, vi, afterEach } from "vitest";
import { runScheduledCron } from "./helpers/cron.js";
import { isMarineZoneId, landProbePoints, LAND_PROBE_RADII_M } from "../src/clients/nws.js";

// DB stub: records every prepare(sql) so the candidate SELECT's shape is
// assertable, serves candidateRows from .all(), serves the parked COUNT from
// .first(), and records every .bind().run() with its SQL + args. An optional
// failRun(sql, args) predicate makes a specific run() reject, to exercise the
// per-beach catch path.
function makeEnrichmentEnv(candidateRows, failRun) {
  const runCalls = [];
  const preparedSql = [];
  const env = {
    // The nudge path sleeps before each of up to 16 probes; the real 300 ms
    // spacing would make these tests wait seconds per beach.
    ENRICHMENT_REQUEST_SPACING_MS: 0,
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

function pointsUrl(lat, lon) {
  return "https://api.weather.gov/points/" + lat.toFixed(4) + "," + lon.toFixed(4);
}

describe("isMarineZoneId", function () {
  it("is true for every marine prefix and false for land zones", function () {
    expect(isMarineZoneId("LMZ221")).toBe(true);
    expect(isMarineZoneId("ANZ050")).toBe(true);
    expect(isMarineZoneId("PZZ650")).toBe(true);
    expect(isMarineZoneId("MIZ071")).toBe(false);
    expect(isMarineZoneId("ILZ014")).toBe(false);
    expect(isMarineZoneId("CAZ006")).toBe(false);
    expect(isMarineZoneId(null)).toBe(false);
    expect(isMarineZoneId("LM")).toBe(false);
  });
});

describe("landProbePoints", function () {
  it("yields 16 deterministic probes, 8 per ring, nearest ring first, north first", function () {
    const probes = landProbePoints(42.401, -86.288);
    expect(probes.length).toBe(16);
    expect(landProbePoints(42.401, -86.288)).toEqual(probes);
    // Ring 1 is the 300 m ring: the north probe moves latitude only.
    expect(probes[0].lat).toBeCloseTo(42.401 + LAND_PROBE_RADII_M[0] / 111320, 6);
    expect(probes[0].lon).toBeCloseTo(-86.288, 6);
    // The 1 km ring's north probe is further out.
    expect(probes[8].lat).toBeCloseTo(42.401 + LAND_PROBE_RADII_M[1] / 111320, 6);
    // East moves longitude only, by more degrees than latitude at 42N.
    expect(probes[2].lat).toBeCloseTo(42.401, 6);
    expect(probes[2].lon - (-86.288)).toBeGreaterThan(LAND_PROBE_RADII_M[0] / 111320);
  });
});

describe("runNwsEnrichment", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("re-probes a marine forecastZone and stores the first land probe's zone and grid URL", async function () {
    const marineGrid = "https://api.weather.gov/gridpoints/GRR/44,41";
    const landGrid = "https://api.weather.gov/gridpoints/GRR/43,41";
    const probes = landProbePoints(42.401, -86.288);
    const byUrl = {};
    byUrl[pointsUrl(42.401, -86.288)] = pointsPayload("LMZ221", marineGrid);
    // The first two probes still resolve marine; the third lands.
    byUrl[pointsUrl(probes[0].lat, probes[0].lon)] = pointsPayload("LMZ221", marineGrid);
    byUrl[pointsUrl(probes[1].lat, probes[1].lon)] = "http-404";
    byUrl[pointsUrl(probes[2].lat, probes[2].lon)] = pointsPayload("MIZ071", landGrid);
    // A later probe with a different land zone must never be reached.
    byUrl[pointsUrl(probes[3].lat, probes[3].lon)] = pointsPayload("MIZ056", "https://api.weather.gov/gridpoints/GRR/1,1");
    const fetchState = stubPointsFetch(byUrl);

    const made = makeEnrichmentEnv([
      { id: "osm-node-1", lat: 42.401, lon: -86.288 }
    ]);
    await runNwsCron(made.env);

    expect(fetchState.urls).toEqual([
      pointsUrl(42.401, -86.288),
      pointsUrl(probes[0].lat, probes[0].lon),
      pointsUrl(probes[1].lat, probes[1].lon),
      pointsUrl(probes[2].lat, probes[2].lon)
    ]);
    const zoneUpdates = made.runCalls.filter(function (c) {
      return c.sql.indexOf("SET nws_zone = ?1, nws_grid_url = ?2") !== -1;
    });
    expect(zoneUpdates.length).toBe(1);
    expect(zoneUpdates[0].args).toEqual(["MIZ071", landGrid, "osm-node-1"]);
    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("enrichment_attempts + 1") !== -1;
    })).toBe(false);
  });

  it("bumps attempts and stores nothing when every probe is marine or fails", async function () {
    const marineGrid = "https://api.weather.gov/gridpoints/GRR/44,41";
    const probes = landProbePoints(42.401, -86.288);
    const byUrl = {};
    byUrl[pointsUrl(42.401, -86.288)] = pointsPayload("LMZ221", marineGrid);
    for (let i = 0; i < probes.length; i++) {
      byUrl[pointsUrl(probes[i].lat, probes[i].lon)] = i % 2 === 0
        ? pointsPayload("LMZ221", marineGrid) : "http-404";
    }
    const fetchState = stubPointsFetch(byUrl);

    const made = makeEnrichmentEnv([
      { id: "osm-node-1", lat: 42.401, lon: -86.288 }
    ]);
    await runNwsCron(made.env);

    expect(fetchState.urls.length).toBe(1 + probes.length);
    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("SET nws_zone") !== -1;
    })).toBe(false);
    const bumps = made.runCalls.filter(function (c) {
      return c.sql.indexOf("enrichment_attempts + 1") !== -1;
    });
    expect(bumps.map(function (c) { return c.args[0]; })).toEqual(["osm-node-1"]);
  });

  it("caps the nudge path at 20 beaches per run and leaves the rest untouched", async function () {
    const marineGrid = "https://api.weather.gov/gridpoints/GRR/44,41";
    const byUrl = {};
    const rows = [];
    for (let i = 0; i < 21; i++) {
      const lat = 42.0 + i * 0.01;
      rows.push({ id: "osm-node-" + String(i), lat: lat, lon: -86.288 });
      byUrl[pointsUrl(lat, -86.288)] = pointsPayload("LMZ221", marineGrid);
    }
    const fetchState = stubPointsFetch(byUrl);

    const made = makeEnrichmentEnv(rows);
    await runNwsCron(made.env);

    // 20 nudged beaches burn 17 requests each; the 21st gets its centroid
    // lookup only, no probes, no write and no attempt bump.
    expect(fetchState.urls.length).toBe(20 * 17 + 1);
    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("SET nws_zone") !== -1;
    })).toBe(false);
    const bumps = made.runCalls.filter(function (c) {
      return c.sql.indexOf("enrichment_attempts + 1") !== -1;
    });
    expect(bumps.length).toBe(20);
    expect(bumps.some(function (c) { return c.args[0] === "osm-node-20"; })).toBe(false);
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

  it("selects candidates attempts-first, hot last_viewed tiebreak, RANDOM() last, capped at 75", async function () {
    stubPointsFetch({});
    const made = makeEnrichmentEnv([]);
    await runNwsCron(made.env);

    const selects = made.preparedSql.filter(function (sql) {
      return sql.indexOf("SELECT id, lat, lon FROM beaches WHERE nws_zone IS NULL") !== -1;
    });
    expect(selects.length).toBe(1);
    expect(selects[0]).toContain("enrichment_attempts < 5");
    expect(selects[0]).toContain("ORDER BY enrichment_attempts ASC, last_viewed DESC NULLS LAST, RANDOM()");
    expect(selects[0]).toContain("LIMIT 75");
    // The attempts key MUST stay first (it is the parking guarantee);
    // last_viewed is only a demand-aware tiebreak, and RANDOM() stays last so
    // ties among equally-cold rows still shuffle.
    const attemptsIdx = selects[0].indexOf("enrichment_attempts ASC");
    const lastViewedIdx = selects[0].indexOf("last_viewed DESC NULLS LAST");
    const randomIdx = selects[0].indexOf("RANDOM()");
    expect(attemptsIdx).toBeGreaterThan(-1);
    expect(lastViewedIdx).toBeGreaterThan(attemptsIdx);
    expect(randomIdx).toBeGreaterThan(lastViewedIdx);
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
