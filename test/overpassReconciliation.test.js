// test/overpassReconciliation.test.js
// Integration coverage for the stale park-beach reconciliation pass added to
// runOverpassSync (src/index.js). Drives the daily sync through the scheduled
// handler with the two Overpass queries stubbed at the fetch layer, and a
// mock D1 that records batch statements so deletions can be asserted.
//
// The reconciliation deletes UNNAMED-origin park-containment rows (name =
// park_name) that were NOT produced by this run, and only after a FULLY
// successful sync (both queries returned) that itself produced at least one
// park-containment row.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runScheduledCron } from "./helpers/cron.js";

// Overpass element fixtures. fetchBeaches issues the [timeout:60] query;
// fetchParkBeaches issues the [timeout:180] query. The stub routes on that.
function beachesResponse(elements) {
  return bodyResponse({ elements: elements });
}

function bodyResponse(body) {
  return {
    ok: true,
    status: 200,
    json: function () { return Promise.resolve(body); }
  };
}

// A named park polygon plus one unnamed beach inside it -> one produced
// park-containment row (id osm-way-5000, name = park name).
const PARK_QUERY_ELEMENTS = [
  { type: "relation", id: 99, tags: { leisure: "park", name: "Warren Dunes State Park" },
    bounds: { minlat: 41.89, minlon: -86.62, maxlat: 41.93, maxlon: -86.58 } },
  { type: "way", id: 5000, tags: { natural: "beach" },
    bounds: { minlat: 41.90, minlon: -86.61, maxlat: 41.91, maxlon: -86.60 } }
];

// Park query returns the park polygon but NO beach inside it -> zero produced
// park-containment rows (exercises the wholesale-change safety rail).
const PARK_QUERY_NO_BEACH = [
  { type: "relation", id: 99, tags: { leisure: "park", name: "Warren Dunes State Park" },
    bounds: { minlat: 41.89, minlon: -86.62, maxlat: 41.93, maxlon: -86.58 } }
];

function stubFetch(options) {
  const opts = options || {};
  vi.stubGlobal("fetch", function (url, init) {
    const body = init && init.body ? String(init.body) : "";
    const isParkQuery = body.indexOf("timeout%3A180") > -1 || body.indexOf("timeout:180") > -1;
    if (isParkQuery) {
      if (opts.parkFails) {
        return Promise.resolve({ ok: false, status: 504, json: function () { return Promise.resolve({}); } });
      }
      if (opts.parkRemark) {
        // Overpass timeout mid-output: HTTP 200, TRUNCATED elements, remark set.
        return Promise.resolve(bodyResponse({
          elements: opts.parkElements || [],
          remark: "runtime error: Query timed out in \"query\" at line 3 after 180 seconds."
        }));
      }
      return Promise.resolve(beachesResponse(opts.parkElements || []));
    }
    return Promise.resolve(beachesResponse(opts.namedElements || []));
  });
}

// Mock D1 that records every batch and every bound run(), and answers the
// reconciliation SELECT (the only .all() the sync path issues) by EMULATING
// its WHERE clause against the supplied fixture rows — rows must carry
// { id, name, park_name, lat, lon } and only unnamed-origin rows
// (park_name set AND name = park_name) inside the bound bbox are returned,
// exactly like a real D1 would. That makes the named-beach safety rail a
// behavioral assertion, not just an SQL-substring check. sync_meta and upsert
// statements resolve as no-ops.
function makeEnv(existingParkRows) {
  const batches = [];
  const runs = [];
  function makeStatement(sql) {
    return {
      sql: sql,
      bind: function () {
        const args = Array.prototype.slice.call(arguments);
        return {
          sql: sql,
          args: args,
          run: function () {
            runs.push({ sql: sql, args: args });
            return Promise.resolve({ success: true });
          },
          all: function () {
            if (sql.indexOf("park_name IS NOT NULL") > -1) {
              // args: [minLat, maxLat, minLon, maxLon]
              const rows = existingParkRows.filter(function (row) {
                return row.park_name !== null && row.park_name !== undefined &&
                  row.name === row.park_name &&
                  row.lat >= args[0] && row.lat <= args[1] &&
                  row.lon >= args[2] && row.lon <= args[3];
              });
              return Promise.resolve({ results: rows });
            }
            return Promise.resolve({ results: [] });
          }
        };
      }
    };
  }
  const env = {
    DB: {
      prepare: function (sql) { return makeStatement(sql); },
      batch: function (statements) {
        batches.push(statements);
        return Promise.resolve(statements.map(function () { return { success: true }; }));
      }
    }
  };
  return { env: env, batches: batches, runs: runs };
}

function runOverpassCron(env) {
  return runScheduledCron(env, "47 8 * * *");
}

// A batch is a DELETE batch when its first statement's SQL is a DELETE.
function deleteBatches(batches) {
  return batches.filter(function (stmts) {
    return stmts.length > 0 && stmts[0].sql && stmts[0].sql.indexOf("DELETE FROM beaches") === 0;
  });
}

function deletedIds(batches) {
  const ids = [];
  deleteBatches(batches).forEach(function (stmts) {
    stmts.forEach(function (s) { ids.push(s.args[0]); });
  });
  return ids;
}

describe("runOverpassSync stale park-beach reconciliation", function () {
  beforeEach(function () {
    vi.spyOn(console, "log").mockImplementation(function () {});
    // The park-query retry path awaits sleep(60000); fire timers immediately so
    // the degraded-run test does not wait a real minute.
    vi.stubGlobal("setTimeout", function (fn) { fn(); return 0; });
  });
  afterEach(function () {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("deletes a stale unnamed-origin park row not produced this run, keeps the produced one", async function () {
    stubFetch({ namedElements: [], parkElements: PARK_QUERY_ELEMENTS });
    const made = makeEnv([
      // produced by this run (matches osm-way-5000) -> KEEP
      { id: "osm-way-5000", name: "Warren Dunes State Park", park_name: "Warren Dunes State Park", lat: 41.905, lon: -86.605 },
      // previously kept, no longer the largest -> STALE, DELETE
      { id: "osm-way-4000", name: "Warren Dunes State Park", park_name: "Warren Dunes State Park", lat: 41.902, lon: -86.606 }
    ]);
    await runOverpassCron(made.env);

    const ids = deletedIds(made.batches);
    expect(ids).toEqual(["osm-way-4000"]);
    expect(ids.indexOf("osm-way-5000")).toBe(-1);
  });

  it("never deletes a NAMED beach inside a park (name != park_name), even when absent from this run", async function () {
    // Behavioral proof of the named-beach rail: the D1 mock emulates the
    // SELECT's WHERE, so a named row (own OSM name, park merely attached) is
    // never a candidate and survives even though producedIds does not contain
    // it. The stale unnamed-origin sibling still gets deleted, proving the
    // reconciliation itself ran.
    stubFetch({ namedElements: [], parkElements: PARK_QUERY_ELEMENTS });
    const made = makeEnv([
      { id: "osm-way-5000", name: "Warren Dunes State Park", park_name: "Warren Dunes State Park", lat: 41.905, lon: -86.605 },
      { id: "osm-way-4000", name: "Warren Dunes State Park", park_name: "Warren Dunes State Park", lat: 41.902, lon: -86.606 },
      // NAMED beach inside the park: not produced this run, must be spared.
      { id: "osm-way-7000", name: "Ottawa Beach", park_name: "Holland State Park", lat: 42.775, lon: -86.211 }
    ]);
    await runOverpassCron(made.env);

    const ids = deletedIds(made.batches);
    expect(ids).toEqual(["osm-way-4000"]);
    expect(ids.indexOf("osm-way-7000")).toBe(-1);
  });

  it("refuses to delete when the stale set exceeds the proportional allowance (partial-result rail)", async function () {
    // Simulates the damage a partial park response would do if it slipped past
    // the client's remark check: 12 of 13 candidates look stale, which is far
    // beyond max(10, 25% of candidates) — the run must delete NOTHING.
    stubFetch({ namedElements: [], parkElements: PARK_QUERY_ELEMENTS });
    const rows = [
      { id: "osm-way-5000", name: "Warren Dunes State Park", park_name: "Warren Dunes State Park", lat: 41.905, lon: -86.605 }
    ];
    for (let i = 0; i < 12; i++) {
      rows.push({
        id: "osm-way-" + String(6000 + i),
        name: "Park " + String(i),
        park_name: "Park " + String(i),
        lat: 42.5,
        lon: -86.0
      });
    }
    const made = makeEnv(rows);
    await runOverpassCron(made.env);

    expect(deleteBatches(made.batches).length).toBe(0);
  });

  it("treats an HTTP-200 Overpass body carrying a remark (truncated result) as a failed park query", async function () {
    // Overpass can hit [timeout:180] mid-output and still answer 200 with a
    // truncated elements array plus a remark. The client must return null, so
    // the sync degrades to named-only and reconciliation never runs.
    stubFetch({ namedElements: [], parkElements: PARK_QUERY_ELEMENTS, parkRemark: true });
    const made = makeEnv([
      { id: "osm-way-4000", name: "Warren Dunes State Park", park_name: "Warren Dunes State Park", lat: 41.902, lon: -86.606 }
    ]);
    await runOverpassCron(made.env);

    expect(deleteBatches(made.batches).length).toBe(0);
  });

  it("does NOT delete when this run produced zero park-containment rows", async function () {
    stubFetch({ namedElements: [], parkElements: PARK_QUERY_NO_BEACH });
    const made = makeEnv([
      { id: "osm-way-4000", name: "Warren Dunes State Park", park_name: "Warren Dunes State Park", lat: 41.902, lon: -86.606 }
    ]);
    await runOverpassCron(made.env);

    expect(deleteBatches(made.batches).length).toBe(0);
  });

  it("does NOT reconcile after a degraded named-only run (park query failed)", async function () {
    // Both the initial park fetch and its single retry fail -> parkBeaches null.
    stubFetch({ namedElements: [], parkFails: true });
    const made = makeEnv([
      { id: "osm-way-4000", name: "Warren Dunes State Park", park_name: "Warren Dunes State Park", lat: 41.902, lon: -86.606 }
    ]);
    await runOverpassCron(made.env);

    expect(deleteBatches(made.batches).length).toBe(0);
  });

  it("issues no DELETE batch when there are no stale rows", async function () {
    stubFetch({ namedElements: [], parkElements: PARK_QUERY_ELEMENTS });
    const made = makeEnv([
      { id: "osm-way-5000", name: "Warren Dunes State Park", park_name: "Warren Dunes State Park", lat: 41.905, lon: -86.605 }
    ]);
    await runOverpassCron(made.env);

    expect(deleteBatches(made.batches).length).toBe(0);
  });

  it("prunes flag_history rows older than the 90-day retention window every daily run", async function () {
    stubFetch({ namedElements: [], parkElements: PARK_QUERY_ELEMENTS });
    const made = makeEnv([]);
    const before = Date.now();
    await runOverpassCron(made.env);

    const prunes = made.runs.filter(function (r) {
      return r.sql.indexOf("DELETE FROM flag_history") === 0;
    });
    expect(prunes.length).toBe(1);
    expect(prunes[0].sql.indexOf("observed_at < ?1")).toBeGreaterThan(-1);
    const cutoffMs = Date.parse(prunes[0].args[0]);
    const ageMs = before - cutoffMs;
    // Cutoff sits ~90 days behind the run's own nowIso.
    expect(ageMs).toBeGreaterThanOrEqual(90 * 86400000 - 60000);
    expect(ageMs).toBeLessThanOrEqual(90 * 86400000 + 60000);
  });

  it("scopes the reconciliation SELECT to unnamed-origin rows inside the pilot bbox", async function () {
    // The safety rail that named beaches are never deleted lives in the SELECT
    // predicate (name = park_name); assert it is present and bbox-bound.
    stubFetch({ namedElements: [], parkElements: PARK_QUERY_ELEMENTS });
    let selectSql = null;
    const env = {
      DB: {
        prepare: function (sql) {
          return {
            sql: sql,
            bind: function () {
              const args = Array.prototype.slice.call(arguments);
              return {
                sql: sql,
                args: args,
                run: function () { return Promise.resolve({ success: true }); },
                all: function () {
                  if (sql.indexOf("park_name IS NOT NULL") > -1) {
                    selectSql = sql;
                    return Promise.resolve({ results: [] });
                  }
                  return Promise.resolve({ results: [] });
                }
              };
            }
          };
        },
        batch: function (statements) { return Promise.resolve(statements.map(function () { return {}; })); }
      }
    };
    await runOverpassCron(env);

    expect(selectSql).not.toBe(null);
    expect(selectSql.indexOf("name = park_name")).toBeGreaterThan(-1);
    expect(selectSql.indexOf("park_name IS NOT NULL")).toBeGreaterThan(-1);
    expect(selectSql.indexOf("lat >= ?1")).toBeGreaterThan(-1);
  });
});
