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
  deleteBeachSql,
  classifyUpdateSql,
  bumpAttemptsSql,
  buildClassifyQueue
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
    expect(a.out).toBe("discovery-delta.sql");
  });
  it("parses flags", function () {
    const a = parseArgs(["--snapshot", "s.json", "--out", "o.sql", "--no-classify", "--classify-limit", "50"]);
    expect(a.snapshot).toBe("s.json");
    expect(a.out).toBe("o.sql");
    expect(a.classify).toBe(false);
    expect(a.classifyLimit).toBe(50);
  });
  it("throws on unknown argument", function () {
    expect(function () { return parseArgs(["--nope"]); }).toThrow();
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
  it("an out-of-bbox stale row is NOT in the delete set (so it also stays in the classify universe)", function () {
    // Regression: deletedIds must equal the actually-deleted set. An out-of-bbox
    // name===park_name row is never deleted, so it must never be excluded from
    // classification.
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
  // Candidate = unnamed-origin park row (name === park_name) inside PILOT_BBOX.
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
  it("ignores candidates outside PILOT_BBOX", function () {
    const snap = [parkRow("osm-way-1", { lat: 10.0, lon: 10.0 })];
    const deletes = reconciliationSql(snap, new Set(), 1);
    expect(deletes).toEqual([]);
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
