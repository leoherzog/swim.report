// Tests for the pure SQL / queue builders in scripts/discovery-batch.js — the
// offline discovery + water-class pipeline. These verify the emitted SQL mirrors
// the in-Worker runOverpassSync statements and that classification queueing +
// reconciliation gating match the Worker's semantics. The network-touching
// discovery/classify orchestration is NOT exercised here (that runs live against
// Overpass in CI); the entrypoint is guarded by import.meta.main so importing
// this module never triggers it.

import { describe, it, expect } from "vitest";
import {
  sqlStr,
  sqlNum,
  parseSnapshot,
  parseArgs,
  upsertSql,
  syncMetaSql,
  reconciliationSql,
  reconcileStaleRows,
  reconciliationAllowed,
  shouldFastDefer,
  deleteBeachSql,
  classifyUpdateSql,
  bumpAttemptsSql,
  buildClassifyQueue,
  tileBbox,
  backoffDelayMs,
  budgetExhausted,
  classifyQueue
} from "../scripts/discovery-batch.js";
import { WATER_CLASS_VERSION, WATER_CLASS_MAX_ATTEMPTS } from "../src/waterClass.js";

describe("sqlStr / sqlNum literal escaping", function () {
  it("doubles single quotes and NULLs empty values", function () {
    expect(sqlStr("O'Brien Beach")).toBe("'O''Brien Beach'");
    expect(sqlStr("plain")).toBe("'plain'");
    expect(sqlStr(null)).toBe("NULL");
    expect(sqlStr(undefined)).toBe("NULL");
  });
  it("inlines finite numbers and NULLs non-finite", function () {
    expect(sqlNum(42.401)).toBe("42.401");
    expect(sqlNum(-86.288)).toBe("-86.288");
    expect(sqlNum(NaN)).toBe("NULL");
    expect(sqlNum("42")).toBe("NULL");
  });
});

describe("parseSnapshot", function () {
  it("reads wrangler --json shape [{results:[...]}]", function () {
    const text = JSON.stringify([{ results: [{ id: "osm-node-1" }], success: true }]);
    expect(parseSnapshot(text)).toEqual([{ id: "osm-node-1" }]);
  });
  it("accepts a bare {results} and a bare array", function () {
    expect(parseSnapshot(JSON.stringify({ results: [{ id: "a" }] }))).toEqual([{ id: "a" }]);
    expect(parseSnapshot(JSON.stringify([{ id: "b" }]))).toEqual([{ id: "b" }]);
  });
  it("empty / blank text -> []", function () {
    expect(parseSnapshot("")).toEqual([]);
    expect(parseSnapshot("   ")).toEqual([]);
  });
});

describe("parseArgs", function () {
  it("defaults classify on, limit 0, out discovery-delta.sql", function () {
    const a = parseArgs([]);
    expect(a.classify).toBe(true);
    expect(a.classifyLimit).toBe(0);
    expect(a.classifyBudgetMs).toBe(0);
    expect(a.out).toBe("discovery-delta.sql");
  });
  it("parses --classify-budget-ms; a bad value falls back to 0 (disabled)", function () {
    expect(parseArgs(["--classify-budget-ms", "4200000"]).classifyBudgetMs).toBe(4200000);
    expect(parseArgs(["--classify-budget-ms", "x"]).classifyBudgetMs).toBe(0);
  });
  it("parses flags", function () {
    const a = parseArgs(["--snapshot", "s.json", "--out", "o.sql", "--no-classify", "--classify-limit", "50"]);
    expect(a.snapshot).toBe("s.json");
    expect(a.out).toBe("o.sql");
    expect(a.classify).toBe(false);
    expect(a.classifyLimit).toBe(50);
  });
  it("defaults discovery on; --no-discovery turns it off (classify-only mode)", function () {
    expect(parseArgs([]).discovery).toBe(true);
    const a = parseArgs(["--no-discovery", "--classify-limit", "150"]);
    expect(a.discovery).toBe(false);
    expect(a.classify).toBe(true);
    expect(a.classifyLimit).toBe(150);
  });
  it("throws on unknown argument", function () {
    expect(function () { return parseArgs(["--nope"]); }).toThrow();
  });
});

describe("backoffDelayMs", function () {
  // rand injected so the jitter is deterministic. rand()=0.5 -> jitter factor 0.
  const noJitter = function () { return 0.5; };
  it("is exponential in the retry number (base * 2^(retry-1)) with no jitter", function () {
    expect(backoffDelayMs(1, 30000, 120000, noJitter)).toBe(30000);
    expect(backoffDelayMs(2, 30000, 120000, noJitter)).toBe(60000);
    expect(backoffDelayMs(3, 30000, 120000, noJitter)).toBe(120000);
  });
  it("caps the base delay at maxMs before jitter", function () {
    // retry 5 -> 30000*16=480000 capped to 120000.
    expect(backoffDelayMs(5, 30000, 120000, noJitter)).toBe(120000);
  });
  it("applies at most +/-20% jitter around the capped value", function () {
    const lo = backoffDelayMs(2, 30000, 120000, function () { return 0; });   // -20%
    const hi = backoffDelayMs(2, 30000, 120000, function () { return 1; });   // +20%
    expect(lo).toBeCloseTo(48000, 5);   // 60000 * 0.8
    expect(hi).toBeCloseTo(72000, 5);   // 60000 * 1.2
  });
  it("never returns negative", function () {
    expect(backoffDelayMs(1, 0, 0, function () { return 0; })).toBe(0);
  });
});

describe("budgetExhausted", function () {
  it("is disabled (always false) when budgetMs <= 0", function () {
    expect(budgetExhausted(1000, 0, 9e15)).toBe(false);
    expect(budgetExhausted(1000, -5, 9e15)).toBe(false);
  });
  it("is false while elapsed < budget", function () {
    expect(budgetExhausted(1000, 5000, 3000)).toBe(false);   // elapsed 2000
  });
  it("is true once elapsed >= budget", function () {
    expect(budgetExhausted(1000, 5000, 6000)).toBe(true);    // elapsed 5000
    expect(budgetExhausted(1000, 5000, 8000)).toBe(true);    // elapsed 7000
  });
});

describe("classifyQueue budget + incremental flush", function () {
  const makeQueue = function () {
    const q = [];
    for (let n = 0; n < 5; n = n + 1) {
      q.push({ id: "osm-node-" + String(n), water_class_attempts: 0 });
    }
    return q;
  };
  it("case A: stops cleanly when the wall-clock budget is exhausted", async function () {
    const queue = makeQueue();
    const collected = [];
    // now() is checked at the TOP of each iteration before processing. Return
    // start (0) for the first two checks, then a value past the deadline so the
    // loop stops entering the 3rd iteration -> processed=2.
    let calls = 0;
    const clock = [0, 0, 0, 999999];
    const fakeClock = function () {
      const v = clock[Math.min(calls, clock.length - 1)];
      calls = calls + 1;
      return v;
    };
    const result = await classifyQueue(queue, {
      limit: 0,
      delayMs: 0,
      budgetMs: 1,
      now: fakeClock,
      fetchSignals: async function () { return {}; },
      classify: function () { return "great_lake"; },
      flush: async function (s) { collected.push(s); }
    });
    expect(result.stopped).toBe(true);
    expect(result.processed).toBe(2);
    expect(collected.length).toBe(2);
    expect(collected[0]).toBe(classifyUpdateSql(queue[0].id, "great_lake"));
    expect(collected[1]).toBe(classifyUpdateSql(queue[1].id, "great_lake"));
  });
  it("case B: full drain flushes every statement incrementally", async function () {
    const queue = makeQueue();
    const collected2 = [];
    const result = await classifyQueue(queue, {
      limit: 0,
      delayMs: 0,
      budgetMs: 0,
      now: function () { return 0; },
      fetchSignals: async function () { return {}; },
      classify: function () { return "great_lake"; },
      flush: async function (s) { collected2.push(s); }
    });
    expect(result.stopped).toBe(false);
    expect(result.processed).toBe(5);
    expect(collected2.length).toBe(5);
    for (let i = 0; i < 5; i = i + 1) {
      expect(collected2[i]).toBe(classifyUpdateSql(queue[i].id, "great_lake"));
    }
  });
});

describe("upsertSql", function () {
  const row = {
    id: "osm-way-12345", name: "O'Brien Beach", lat: 42.401, lon: -86.288,
    osmId: "way/12345", parkName: "Holland State Park"
  };
  it("park variant carries park_name and the moved-reset CASE", function () {
    const sql = upsertSql(row, true);
    expect(sql).toContain("INSERT INTO beaches (id, name, lat, lon, osm_id, park_name)");
    expect(sql).toContain("'osm-way-12345'");
    expect(sql).toContain("'O''Brien Beach'");     // escaped apostrophe
    expect(sql).toContain("'Holland State Park'");
    expect(sql).toContain("ON CONFLICT(id) DO UPDATE SET");
    // Double space after "=" mirrors the Worker verbatim (the moved fragment
    // has a leading space): "water_class = " + " CASE WHEN ...".
    expect(sql).toContain("water_class =  CASE WHEN (abs(lat - 42.401) > 0.001 OR abs(lon - -86.288) > 0.001) THEN NULL ELSE water_class END");
    expect(sql).toContain("water_class_attempts =  CASE WHEN (abs(lat - 42.401) > 0.001 OR abs(lon - -86.288) > 0.001) THEN 0 ELSE water_class_attempts END");
    expect(sql.endsWith(";")).toBe(true);
  });
  it("named-only variant omits park_name entirely", function () {
    const sql = upsertSql(row, false);
    expect(sql).toContain("INSERT INTO beaches (id, name, lat, lon, osm_id) VALUES");
    expect(sql).not.toContain("park_name");
    expect(sql).toContain("water_class =  CASE WHEN");
  });
});

describe("classify UPDATE builders mirror classifyBeaches", function () {
  it("decision UPDATE stores class + version and RESETS attempts to 0", function () {
    expect(classifyUpdateSql("osm-node-1", "great_lake")).toBe(
      "UPDATE beaches SET water_class = 'great_lake', water_class_version = 1, water_class_attempts = 0 WHERE id = 'osm-node-1';"
    );
  });
  it("bump UPDATE increments attempts by 1", function () {
    expect(bumpAttemptsSql("osm-node-1")).toBe(
      "UPDATE beaches SET water_class_attempts = water_class_attempts + 1 WHERE id = 'osm-node-1';"
    );
  });
  it("escapes an apostrophe in the id", function () {
    expect(classifyUpdateSql("osm-o'-1", "inland")).toContain("WHERE id = 'osm-o''-1';");
  });
});

describe("SQL literal delivery is statement-split safe", function () {
  // The whole delta is shipped as one file to `wrangler d1 execute --file`, which
  // splits on statement boundaries. A single OSM name containing ; \n or -- must
  // NOT be able to break out of its quoted literal — only ' is special in SQLite
  // string literals, and sqlStr doubles it. Prove the dangerous chars stay inside
  // the quotes (the literal has exactly one opening and one closing quote).
  it("keeps semicolons, newlines, and -- inside the quoted literal", function () {
    const nasty = "Smith; DROP TABLE beaches;--\nBeach";
    const lit = sqlStr(nasty);
    expect(lit.startsWith("'")).toBe(true);
    expect(lit.endsWith("'")).toBe(true);
    // No unescaped single quote inside -> exactly two quote chars total.
    expect((lit.match(/'/g) || []).length).toBe(2);
    // The row builder inlines it verbatim inside the quotes (no extra quoting).
    const sql = upsertSql({ id: "osm-node-1", name: nasty, lat: 43, lon: -86, osmId: "node/1", parkName: null }, false);
    expect(sql).toContain("'" + nasty + "'");
  });
  it("doubles a real apostrophe so it cannot terminate the literal early", function () {
    expect(sqlStr("O'Brien'; DROP")).toBe("'O''Brien''; DROP'");
  });
});

describe("reconciliationAllowed gates DELETE on provably-complete coverage", function () {
  // THE SAFETY INVARIANT: a DELETE may be emitted ONLY when EVERY named tile AND
  // EVERY park tile fetched this run. Any incomplete coverage => reconciliation
  // refused (upserts only). This predicate is the single choke point in main().
  it("allows reconciliation ONLY when named AND park coverage are both complete", function () {
    expect(reconciliationAllowed(true, true)).toBe(true);
  });
  it("refuses when named coverage is incomplete (partial named fetch)", function () {
    expect(reconciliationAllowed(false, true)).toBe(false);
    expect(reconciliationAllowed(false, false)).toBe(false);
  });
  it("refuses when park coverage is incomplete (park query degraded)", function () {
    expect(reconciliationAllowed(true, false)).toBe(false);
  });
  it("is strict about the boolean true — any non-true (null/undefined) refuses", function () {
    // runDiscovery signals incomplete park as parkBeaches === null; main derives
    // parkComplete = (parkBeaches !== null). Guard against a truthy-but-not-true
    // slipping a delete through.
    expect(reconciliationAllowed(1, 1)).toBe(false);
    expect(reconciliationAllowed(true, null)).toBe(false);
    expect(reconciliationAllowed(undefined, true)).toBe(false);
  });
});

describe("shouldFastDefer is the early total-outage circuit breaker", function () {
  // Fires ONLY while ZERO tiles have succeeded AND at least maxFailed have failed —
  // the mirrors-down-from-the-start signature where continuing the best-effort loop
  // would grind every tile and still ingest nothing. Any single success disarms it.
  it("fires once maxFailed tiles have failed with zero successes", function () {
    expect(shouldFastDefer(0, 3, 3)).toBe(true);
    expect(shouldFastDefer(0, 5, 3)).toBe(true);
  });
  it("does not fire before maxFailed failures", function () {
    expect(shouldFastDefer(0, 2, 3)).toBe(false);
    expect(shouldFastDefer(0, 0, 3)).toBe(false);
  });
  it("is disarmed permanently the moment any tile succeeds", function () {
    expect(shouldFastDefer(1, 30, 3)).toBe(false);
  });
});

describe("reconcileStaleRows / deleteBeachSql single-source the delete set", function () {
  function parkRow(id, extra) {
    return Object.assign({ id: id, name: "P", park_name: "P", lat: 43.0, lon: -86.0 }, extra || {});
  }
  it("reconciliationSql is exactly reconcileStaleRows mapped through deleteBeachSql", function () {
    const snap = [parkRow("osm-way-1"), parkRow("osm-way-2")];
    const produced = new Set(["osm-way-1"]);
    const stale = reconcileStaleRows(snap, produced, 1);
    expect(stale.map(function (r) { return r.id; })).toEqual(["osm-way-2"]);
    expect(reconciliationSql(snap, produced, 1)).toEqual(stale.map(function (r) { return deleteBeachSql(r.id); }));
  });
  it("an out-of-region stale row is NOT in the delete set (so it also stays in the classify universe)", function () {
    // Regression: deletedIds must equal the actually-deleted set. An out-of-region
    // name===park_name row (lat 50.0 is north of every REGION box) is never
    // deleted, so it must never be excluded from classification.
    const snap = [parkRow("osm-way-in"), parkRow("osm-way-out", { lat: 50.0, lon: -86.0 })];
    const stale = reconcileStaleRows(snap, new Set(["osm-way-in"]), 1);
    const staleIds = stale.map(function (r) { return r.id; });
    expect(staleIds).not.toContain("osm-way-out");
    // Derived deletedIds excludes it -> buildClassifyQueue still queues it.
    const deletedIds = new Set(staleIds);
    const snapForClassify = [{
      id: "osm-way-out", osm_id: "way/out", lat: 50.0, lon: -86.0,
      water_class: null, water_class_version: null, water_class_attempts: 0
    }];
    const q = buildClassifyQueue(snapForClassify, [], deletedIds);
    expect(q.map(function (b) { return b.id; })).toEqual(["osm-way-out"]);
  });
});

describe("syncMetaSql", function () {
  it("upserts key/value/updated", function () {
    const sql = syncMetaSql("last_overpass_count", "613", "2026-07-18T08:47:00.000Z");
    expect(sql).toContain("INSERT INTO sync_meta (key, value, updated) VALUES ('last_overpass_count', '613', '2026-07-18T08:47:00.000Z')");
    expect(sql).toContain("ON CONFLICT(key) DO UPDATE SET value = '613', updated = '2026-07-18T08:47:00.000Z'");
  });
});

describe("reconciliationSql safety rails", function () {
  // Candidate = unnamed-origin park row (name === park_name) inside any REGION
  // (pointInAnyRegion). (43.0, -86.0) sits in the Lake Michigan box.
  function parkRow(id, extra) {
    return Object.assign({
      id: id, name: "Some Park", park_name: "Some Park", lat: 43.0, lon: -86.0
    }, extra || {});
  }
  it("skips entirely when the run produced 0 park rows", function () {
    const snap = [parkRow("osm-way-1")];
    expect(reconciliationSql(snap, new Set(), 0)).toEqual([]);
  });
  it("deletes a stale candidate not produced this run", function () {
    const snap = [parkRow("osm-way-1"), parkRow("osm-way-2")];
    const produced = new Set(["osm-way-1"]);
    const deletes = reconciliationSql(snap, produced, 1);
    expect(deletes).toEqual(["DELETE FROM beaches WHERE id = 'osm-way-2';"]);
  });
  it("never deletes a named beach inside a park (name !== park_name)", function () {
    const snap = [{ id: "osm-way-9", name: "Real Beach", park_name: "Some Park", lat: 43, lon: -86 }];
    const deletes = reconciliationSql(snap, new Set(["osm-way-1"]), 1);
    expect(deletes).toEqual([]);
  });
  it("refuses a mass-delete beyond the proportional allowance", function () {
    // 100 candidates, none produced -> 100 stale > allowance max(10, 25) = 25.
    const snap = [];
    for (let i = 0; i < 100; i = i + 1) { snap.push(parkRow("osm-way-" + i)); }
    const deletes = reconciliationSql(snap, new Set(), 1);
    expect(deletes).toEqual([]);
  });
  it("ignores candidates outside all regions", function () {
    // (10.0, 10.0) is far outside every REGION box -> pointInAnyRegion false, so
    // it is never a delete candidate.
    const snap = [parkRow("osm-way-1", { lat: 10.0, lon: 10.0 })];
    const deletes = reconciliationSql(snap, new Set(), 1);
    expect(deletes).toEqual([]);
  });
});

describe("tileBbox", function () {
  const PILOT = { minLon: -87.6, minLat: 41.6, maxLon: -82.3, maxLat: 46.6 };

  it("splits the pilot bbox into a ceil(span/max) grid", function () {
    // 5.3 deg wide / 1.5 = ceil 4 cols; 5.0 deg tall / 1.5 = ceil 4 rows.
    const tiles = tileBbox(PILOT, 1.5, 0.05);
    expect(tiles.length).toBe(16);
  });

  it("keeps every base tile under maxSpan + 2*overlap on each side", function () {
    const tiles = tileBbox(PILOT, 1.5, 0.05);
    const maxAllowed = 1.5 + 2 * 0.05 + 1e-9;
    for (const t of tiles) {
      expect(t.maxLon - t.minLon).toBeLessThanOrEqual(maxAllowed);
      expect(t.maxLat - t.minLat).toBeLessThanOrEqual(maxAllowed);
    }
  });

  it("union-covers the whole bbox with no gaps and never exceeds it", function () {
    const tiles = tileBbox(PILOT, 1.5, 0.05);
    // Corners are inside some tile, and no tile spills past the original bbox
    // (overlap is clamped to the edges).
    for (const t of tiles) {
      expect(t.minLon).toBeGreaterThanOrEqual(PILOT.minLon);
      expect(t.minLat).toBeGreaterThanOrEqual(PILOT.minLat);
      expect(t.maxLon).toBeLessThanOrEqual(PILOT.maxLon);
      expect(t.maxLat).toBeLessThanOrEqual(PILOT.maxLat);
    }
    const covers = function (lon, lat) {
      return tiles.some(function (t) {
        return lon >= t.minLon && lon <= t.maxLon && lat >= t.minLat && lat <= t.maxLat;
      });
    };
    expect(covers(PILOT.minLon, PILOT.minLat)).toBe(true);
    expect(covers(PILOT.maxLon, PILOT.maxLat)).toBe(true);
    expect(covers(-85.0, 44.0)).toBe(true); // interior point
  });

  it("interior base-grid seams overlap (no point falls between adjacent tiles)", function () {
    // With overlap > 0, adjacent tiles share a band, so a point exactly on a base
    // seam is inside both — never orphaned by floating-point drift.
    const tiles = tileBbox(PILOT, 1.5, 0.05);
    const lonStep = (PILOT.maxLon - PILOT.minLon) / 4;
    const seamLon = PILOT.minLon + lonStep;
    const hits = tiles.filter(function (t) {
      return seamLon >= t.minLon && seamLon <= t.maxLon && 44.0 >= t.minLat && 44.0 <= t.maxLat;
    });
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("returns a single tile when the bbox is smaller than maxSpan", function () {
    const small = { minLon: -87.0, minLat: 41.6, maxLon: -86.5, maxLat: 42.0 };
    const tiles = tileBbox(small, 1.5, 0.05);
    expect(tiles.length).toBe(1);
    // Overlap is clamped to the bbox, so the lone tile equals the input.
    expect(tiles[0]).toEqual(small);
  });

  it("tiles at the production 2.0-deg span with no base tile exceeding it", function () {
    // TILE_MAX_SPAN_DEG in discovery-batch.js is 2.0 (with 0.05 overlap): this is
    // the span every REGION bbox is actually tiled at before any Overpass query.
    // A REGION-sized box (Lake Michigan: 3.8 deg wide / 4.7 deg tall) at 2.0 deg
    // -> ceil(3.8/2)=2 cols x ceil(4.7/2)=3 rows = 6 tiles.
    const lakeMichigan = { minLon: -88.3, minLat: 41.5, maxLon: -84.5, maxLat: 46.2 };
    const tiles = tileBbox(lakeMichigan, 2.0, 0.05);
    expect(tiles.length).toBe(6);
    const maxAllowed = 2.0 + 2 * 0.05 + 1e-9;
    for (const t of tiles) {
      expect(t.maxLon - t.minLon).toBeLessThanOrEqual(maxAllowed);
      expect(t.maxLat - t.minLat).toBeLessThanOrEqual(maxAllowed);
      // No tile spills past the region box (overlap clamps to the edges).
      expect(t.minLon).toBeGreaterThanOrEqual(lakeMichigan.minLon);
      expect(t.maxLon).toBeLessThanOrEqual(lakeMichigan.maxLon);
    }
  });
});

describe("buildClassifyQueue", function () {
  const merged = [
    { id: "osm-node-new", name: "New Beach", lat: 43.0, lon: -86.0, osmId: "node/new", parkName: null }
  ];
  it("queues a brand-new discovered beach (not in snapshot)", function () {
    const q = buildClassifyQueue([], merged, new Set());
    expect(q.map(function (b) { return b.id; })).toEqual(["osm-node-new"]);
    expect(q[0].osm_id).toBe("node/new");
  });
  it("skips a row already classified at the current version", function () {
    const snap = [{
      id: "osm-node-new", osm_id: "node/new", lat: 43.0, lon: -86.0,
      water_class: "great_lake", water_class_version: WATER_CLASS_VERSION, water_class_attempts: 0
    }];
    expect(buildClassifyQueue(snap, merged, new Set())).toEqual([]);
  });
  it("re-queues a moved beach (centroid shifted > 0.001 deg) even if classified", function () {
    const snap = [{
      id: "osm-node-new", osm_id: "node/new", lat: 44.0, lon: -86.0,
      water_class: "great_lake", water_class_version: WATER_CLASS_VERSION, water_class_attempts: 0
    }];
    const q = buildClassifyQueue(snap, merged, new Set());
    expect(q.map(function (b) { return b.id; })).toEqual(["osm-node-new"]);
  });
  it("skips a parked row at the attempts cap", function () {
    const snap = [{
      id: "osm-node-p", osm_id: "node/p", lat: 43.0, lon: -86.0,
      water_class: null, water_class_version: null, water_class_attempts: WATER_CLASS_MAX_ATTEMPTS
    }];
    expect(buildClassifyQueue(snap, [], new Set())).toEqual([]);
  });
  it("queues an un-rediscovered snapshot row that still needs classifying", function () {
    const snap = [{
      id: "osm-node-old", osm_id: "node/old", lat: 43.0, lon: -86.0,
      water_class: null, water_class_version: null, water_class_attempts: 1
    }];
    const q = buildClassifyQueue(snap, [], new Set());
    expect(q.map(function (b) { return b.id; })).toEqual(["osm-node-old"]);
  });
  it("excludes reconcile-deleted ids", function () {
    const snap = [{
      id: "osm-way-gone", osm_id: "way/gone", lat: 43.0, lon: -86.0,
      water_class: null, water_class_version: null, water_class_attempts: 0
    }];
    expect(buildClassifyQueue(snap, [], new Set(["osm-way-gone"]))).toEqual([]);
  });
  it("orders lowest-attempts-first", function () {
    const snap = [
      { id: "b", osm_id: "node/b", lat: 43, lon: -86, water_class: null, water_class_version: null, water_class_attempts: 3 },
      { id: "a", osm_id: "node/a", lat: 43, lon: -86, water_class: null, water_class_version: null, water_class_attempts: 1 }
    ];
    const q = buildClassifyQueue(snap, [], new Set());
    expect(q.map(function (b) { return b.water_class_attempts; })).toEqual([1, 3]);
  });
});
