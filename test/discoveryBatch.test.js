// Tests for the pure SQL / queue / rail builders in scripts/discovery-batch.js —
// the offline discovery + water-class pipeline, now driven by prebuilt spatial
// layers rather than per-tile upstream queries. These verify the emitted SQL
// mirrors the statements the Worker upsert used, that classification queueing
// matches the Worker's semantics, and — the part that carries the real risk —
// that every one of the four safety rails refuses what it is supposed to refuse.
// The Deno-bound layer reading and the main() orchestration are NOT exercised
// here; the entrypoint is guarded by import.meta.main so importing this module
// never triggers it.

import { describe, it, expect } from "vitest";
import {
  sqlStr,
  sqlNum,
  parseSnapshot,
  parseArgs,
  joinLayerPath,
  layerFilePlanProblems,
  splitOtherRelations,
  upsertSql,
  syncMetaSql,
  reconcileStaleRows,
  reconciliationDelta,
  reconciliationGate,
  reconciliationAllowed,
  classificationAllowed,
  applyRunConjuncts,
  sourceAgeDays,
  regionForPoint,
  regionDeleteRailAllows,
  classificationFlipRailAllows,
  formatFlipMatrix,
  deleteBeachSql,
  classifyUpdateSql,
  bumpAttemptsSql,
  buildClassifyQueue,
  classifyCoverageCounts,
  budgetExhausted,
  classifyQueue,
  marineZoneSql,
  nothingToDo
} from "../scripts/discovery-batch.js";
import { WATER_CLASS_VERSION, WATER_CLASS_MAX_ATTEMPTS } from "../src/waterClass.js";
import { EXPECTED_LAYER_KEYS } from "../src/layerManifest.js";
import { buildMarineZoneIndex, nearestMarineZone } from "../src/marineZones.js";

// A layer report every conjunct of src/layerManifest.js accepts. Tests knock ONE
// field out at a time, which is the realistic shape of the failure: the report is
// assembled by three separate scripts and a field going missing is far likelier
// than one going explicitly false.
function verifiedReport(extra) {
  return Object.assign({
    schemaVersion: 1,
    pointerAgreesWithManifest: true,
    layersVerified: true,
    layersPresent: EXPECTED_LAYER_KEYS.length,
    layersExpected: EXPECTED_LAYER_KEYS.length,
    buildStatus: "complete",
    sourcesVerified: true,
    buildSanityPassed: true,
    regionsDigestMatches: true,
    sourceAgeDays: 3
  }, extra || {});
}

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
  it("defaults classify on, out discovery-delta.sql", function () {
    const a = parseArgs([]);
    expect(a.classify).toBe(true);
    expect(a.out).toBe("discovery-delta.sql");
  });
  it("parses flags", function () {
    const a = parseArgs(["--snapshot", "s.json", "--out", "o.sql", "--no-classify"]);
    expect(a.snapshot).toBe("s.json");
    expect(a.out).toBe("o.sql");
    expect(a.classify).toBe(false);
  });
  it("defaults discovery on; --no-discovery turns it off (classify-only mode)", function () {
    expect(parseArgs([]).discovery).toBe(true);
    const a = parseArgs(["--no-discovery"]);
    expect(a.discovery).toBe(false);
    expect(a.classify).toBe(true);
  });
  it("throws on unknown argument", function () {
    expect(function () { return parseArgs(["--nope"]); }).toThrow();
  });
  it("rejects the retired per-run classify pacing flags", function () {
    // Classification is a local join in the same run as discovery now, so there
    // is nothing to ration per run. The parameters survive INSIDE classifyQueue
    // (see the budget/limit/flush tests below) — only the CLI surface is gone,
    // and it must fail loudly rather than silently ignore a stale invocation.
    expect(function () { return parseArgs(["--classify-limit", "25"]); }).toThrow();
    expect(function () { return parseArgs(["--classify-delay-ms", "300"]); }).toThrow();
    expect(function () { return parseArgs(["--classify-budget-ms", "3600000"]); }).toThrow();
  });
  it("defaults marineZones to null; --marine-zones takes a path", function () {
    expect(parseArgs([]).marineZones).toBe(null);
    const a = parseArgs(["--marine-zones", "data/marine-zones-greatlakes.json"]);
    expect(a.marineZones).toBe("data/marine-zones-greatlakes.json");
  });
  it("defaults layers to null and derives --report from --layers", function () {
    expect(parseArgs([]).layers).toBe(null);
    expect(parseArgs([]).report).toBe(null);
    const a = parseArgs(["--layers", "./.layers"]);
    expect(a.layers).toBe("./.layers");
    expect(a.report).toBe("./.layers/report.json");
  });
  it("an explicit --report wins regardless of flag order", function () {
    expect(parseArgs(["--report", "r.json", "--layers", "./.layers"]).report).toBe("r.json");
    expect(parseArgs(["--layers", "./.layers", "--report", "r.json"]).report).toBe("r.json");
  });
  it("tolerates a trailing slash on --layers when deriving the report path", function () {
    expect(parseArgs(["--layers", "/tmp/layers/"]).report).toBe("/tmp/layers/report.json");
  });
});

describe("nothingToDo guard", function () {
  it("errors only when discovery, classify, AND the marine pass are all off", function () {
    expect(nothingToDo(parseArgs(["--no-discovery", "--no-classify"]))).toBe(true);
  });
  it("marine-only is a valid mode", function () {
    const a = parseArgs(["--no-discovery", "--no-classify", "--marine-zones", "data/marine-zones-greatlakes.json"]);
    expect(nothingToDo(a)).toBe(false);
  });
  it("any single mode is valid", function () {
    expect(nothingToDo(parseArgs(["--no-classify"]))).toBe(false);
    expect(nothingToDo(parseArgs(["--no-discovery"]))).toBe(false);
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
      "UPDATE beaches SET water_class = 'great_lake', water_class_version = 2, water_class_attempts = 0 WHERE id = 'osm-node-1';"
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
  // The whole delta is shipped as one file to 'wrangler d1 execute --file', which
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

describe("reconciliationAllowed / classificationAllowed gate on a VERIFIED layer set", function () {
  // THE SAFETY INVARIANT, restated for the layers transport: a DELETE may be
  // emitted ONLY when the manifest PROVES the set is a complete, intact,
  // in-scope, fresh view of OSM. Under the old transport failure was noisy and
  // delete-safe; under prebuilt layers a wrong tag filter exits 0 with a
  // well-formed manifest and every checksum matching, so the proof has to be
  // positive. This predicate is the single choke point in main().
  it("allows reconciliation ONLY under a fully verified report", function () {
    expect(reconciliationAllowed(verifiedReport())).toBe(true);
    expect(classificationAllowed(verifiedReport())).toBe(true);
  });
  it("refuses BOTH when the view is genuinely incomplete", function () {
    // Incompleteness is the one failure that must also stop classification: a
    // partial water view makes the classifier's clean-but-empty branch decide
    // inland, which HIDES beaches.
    const cases = [
      { buildStatus: "partial" },
      { sourcesVerified: false },
      { buildSanityPassed: false }
    ];
    for (let i = 0; i < cases.length; i = i + 1) {
      expect(reconciliationAllowed(verifiedReport(cases[i]))).toBe(false);
      expect(classificationAllowed(verifiedReport(cases[i]))).toBe(false);
    }
  });
  it("refuses DELETES but KEEPS CLASSIFYING when the set is merely out of scope or stale", function () {
    // A regions-digest mismatch is what an expansion commit produces by
    // construction, and a stale extract's geometry is complete, just older.
    // Gating classification on either would publish thousands of unclassified
    // beaches live with estimated flag cards until a rebuild lands.
    const outOfScope = verifiedReport({ regionsDigestMatches: false });
    expect(reconciliationAllowed(outOfScope)).toBe(false);
    expect(classificationAllowed(outOfScope)).toBe(true);
    const stale = verifiedReport({ sourceAgeDays: 99 });
    expect(reconciliationAllowed(stale)).toBe(false);
    expect(classificationAllowed(stale)).toBe(true);
  });
  it("is strict about the boolean true — any non-true (null/undefined/truthy) refuses", function () {
    // Ported verbatim in intent from the per-tile era, and it matters MORE now:
    // the report is assembled by three separate scripts, so a MISSING field is
    // the realistic failure and must refuse exactly as an explicit false does.
    expect(reconciliationAllowed(verifiedReport({ layersVerified: 1 }))).toBe(false);
    expect(reconciliationAllowed(verifiedReport({ layersVerified: "true" }))).toBe(false);
    expect(reconciliationAllowed(verifiedReport({ pointerAgreesWithManifest: null }))).toBe(false);
    expect(reconciliationAllowed(verifiedReport({ sourcesVerified: undefined }))).toBe(false);
    expect(reconciliationAllowed(verifiedReport({ regionsDigestMatches: 1 }))).toBe(false);
  });
  it("refuses a missing or malformed report rather than throwing", function () {
    expect(reconciliationAllowed(null)).toBe(false);
    expect(reconciliationAllowed(undefined)).toBe(false);
    expect(reconciliationAllowed([])).toBe(false);
    expect(classificationAllowed(null)).toBe(false);
  });
});

describe("sourceAgeDays / applyRunConjuncts fold in the two conjuncts the fetcher cannot compute", function () {
  it("measures the OSM data cutoff, not the build wall clock", function () {
    expect(sourceAgeDays("2026-08-31T00:00:00.000Z", "2026-09-03T00:00:00.000Z")).toBe(3);
    expect(sourceAgeDays("2026-09-03T12:00:00.000Z", "2026-09-03T00:00:00.000Z")).toBe(-0.5);
  });
  it("returns NaN for a missing or unparseable timestamp, which FAILS the range check", function () {
    expect(Number.isNaN(sourceAgeDays(null, "2026-09-03T00:00:00.000Z"))).toBe(true);
    expect(Number.isNaN(sourceAgeDays("not-a-date", "2026-09-03T00:00:00.000Z"))).toBe(true);
    const folded = applyRunConjuncts(
      { regionsDigest: "sha256:abc", oldestSourceTimestamp: null }, "2026-09-03T00:00:00.000Z", "sha256:abc"
    );
    expect(reconciliationAllowed(Object.assign(verifiedReport(), folded))).toBe(false);
  });
  it("matches the digest only on an exact string equality, and never mutates the fetched report", function () {
    const fetched = {
      regionsDigest: "sha256:abc", oldestSourceTimestamp: "2026-09-01T00:00:00.000Z"
    };
    const ok = applyRunConjuncts(fetched, "2026-09-03T00:00:00.000Z", "sha256:abc");
    expect(ok.regionsDigestMatches).toBe(true);
    expect(ok.sourceAgeDays).toBe(2);
    expect(applyRunConjuncts(fetched, "2026-09-03T00:00:00.000Z", "sha256:zzz").regionsDigestMatches).toBe(false);
    expect(applyRunConjuncts({ oldestSourceTimestamp: "2026-09-01T00:00:00.000Z" },
      "2026-09-03T00:00:00.000Z", "sha256:abc").regionsDigestMatches).toBe(false);
    // The caller still sees exactly what scripts/fetch-layers.js wrote.
    expect(fetched.regionsDigestMatches).toBe(undefined);
    expect(fetched.sourceAgeDays).toBe(undefined);
  });
  it("passes a null report straight through so the gate reports it as fatal", function () {
    expect(applyRunConjuncts(null, "2026-09-03T00:00:00.000Z", "sha256:abc")).toBe(null);
  });
});

// The delete rail's full composition is exported as a real builder
// (reconciliationDelta), so this helper no longer mirrors production by hand —
// it just names the half of that builder these assertions read.
function reconciliationDeletes(snapshotRows, producedIds, producedParkRowCount) {
  return reconciliationDelta(snapshotRows, producedIds, producedParkRowCount).statements;
}

describe("reconcileStaleRows / deleteBeachSql single-source the delete set", function () {
  function parkRow(id, extra) {
    return Object.assign({ id: id, name: "P", park_name: "P", lat: 43.0, lon: -86.0 }, extra || {});
  }
  it("the emitted DELETEs are exactly reconcileStaleRows mapped through deleteBeachSql", function () {
    const snap = [parkRow("osm-way-1"), parkRow("osm-way-2")];
    const produced = new Set(["osm-way-1"]);
    const stale = reconcileStaleRows(snap, produced, 1);
    expect(stale.map(function (r) { return r.id; })).toEqual(["osm-way-2"]);
    expect(reconciliationDeletes(snap, produced, 1)).toEqual(stale.map(function (r) { return deleteBeachSql(r.id); }));
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

  it("re-drains rows parked unclassified by the pre-decisive classifier (version IS NULL at the cap)", function () {
    // The ~409 production rows left NULL at attempts=5 by the old clean-but-empty
    // null path. A version bump can NEVER reach them (the version clause is ANDed
    // with attempts < cap), so the version-IS-NULL legacy marker admits them.
    const row = function (id, extra) {
      return Object.assign({
        id: id, osm_id: "way/" + id, lat: 42.6, lon: -83.4,
        water_class: null, water_class_version: null, water_class_attempts: 0
      }, extra || {});
    };
    const snap = [
      row("parked-legacy", { water_class_attempts: WATER_CLASS_MAX_ATTEMPTS }),
      row("pending-fresh", { water_class_attempts: 0 })
    ];
    const ids = buildClassifyQueue(snap, [], new Set()).map(function (b) { return b.id; });
    expect(ids).toContain("parked-legacy");
    // Fresh rows sort AHEAD of the legacy backlog (attempts ASC), so newly
    // discovered beaches — the ones visible under the fail-open — decide first.
    expect(ids).toEqual(["pending-fresh", "parked-legacy"]);
  });

  it("does NOT re-drain a row that reached a decision, and never re-queues a decided inland row", function () {
    // A stamped version is the proof a row was decided; only unversioned parks
    // are legacy. This is what makes the re-drain one-time rather than a loop.
    const decided = [
      {
        id: "decided-inland", osm_id: "way/1", lat: 42.6, lon: -83.4,
        water_class: "inland", water_class_version: WATER_CLASS_VERSION, water_class_attempts: 0
      },
      {
        id: "parked-versioned", osm_id: "way/2", lat: 42.6, lon: -83.4,
        water_class: null, water_class_version: WATER_CLASS_VERSION,
        water_class_attempts: WATER_CLASS_MAX_ATTEMPTS
      }
    ];
    expect(buildClassifyQueue(decided, [], new Set())).toEqual([]);
  });
});

describe("classifyCoverageCounts (required visibility for NULL-hides)", function () {
  const row = function (id, wc, attempts) {
    return { id: id, water_class: wc, water_class_attempts: attempts };
  };

  it("splits the table into parked / hidden_inland / pending_visible / flag_worthy", function () {
    const snap = [
      row("gl", "great_lake", 0),
      row("oc", "ocean", 0),
      row("in", "inland", 0),
      row("parked", null, WATER_CLASS_MAX_ATTEMPTS),
      row("pending", null, 0)
    ];
    expect(classifyCoverageCounts(snap, new Set())).toEqual({
      parked: 1,
      hidden_inland: 1,
      // Pending rows are FAIL-OPEN: counted as flag_worthy because the live gate
      // serves them, which is exactly the exposure this metric exists to surface.
      pending_visible: 1,
      flag_worthy: 3
    });
  });

  it("excludes reconcile-deleted rows and treats a missing attempts column as 0 (pending, not parked)", function () {
    const snap = [
      row("gone", null, 0),
      { id: "stub", water_class: null },
      { id: "stub2" }
    ];
    const c = classifyCoverageCounts(snap, new Set(["gone"]));
    expect(c.pending_visible).toBe(2);
    expect(c.parked).toBe(0);
  });

  it("never throws on an empty table", function () {
    expect(classifyCoverageCounts([], new Set())).toEqual({
      parked: 0, hidden_inland: 0, pending_visible: 0, flag_worthy: 0
    });
  });
});

describe("syncMetaSql", function () {
  it("upserts key/value/updated", function () {
    // The key is last_discovery_count, not the retired transport-named row: a D1
    // row literally named after a data source this pipeline no longer uses,
    // frozen at its final value forever, is exactly the residue to avoid.
    const sql = syncMetaSql("last_discovery_count", "613", "2026-07-18T08:47:00.000Z");
    expect(sql).toContain("INSERT INTO sync_meta (key, value, updated) VALUES ('last_discovery_count', '613', '2026-07-18T08:47:00.000Z')");
    expect(sql).toContain("ON CONFLICT(key) DO UPDATE SET value = '613', updated = '2026-07-18T08:47:00.000Z'");
  });
});

describe("reconciliationGate — the three run-level preconditions on any DELETE", function () {
  it("allows deletes only when the layer set is verified, parks are healthy and a snapshot exists", function () {
    const gate = reconciliationGate(true, true, true);
    expect(gate.allowed).toBe(true);
  });

  it("refuses when the layer set is not provably complete", function () {
    const gate = reconciliationGate(false, true, true);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("not provably complete");
  });

  // The band the proportional rails structurally cannot see: a parks layer at
  // 0.96x clears every build gate (they refuse below 0.95x) while the missing
  // polygons make real beaches fail park membership and read as stale.
  it("refuses when the parks layer is unhealthy, even on a verified set with a snapshot", function () {
    const gate = reconciliationGate(true, false, true);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("parksLayerHealthy=false");
  });

  it("refuses when there is no snapshot to diff against", function () {
    const gate = reconciliationGate(true, true, false);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("no snapshot");
  });

  // Strictness: the gate must not be satisfiable by a truthy non-boolean, the
  // same discipline reconciliationAllowed is held to.
  it("is strict — any falsy precondition refuses and every refusal names a reason", function () {
    const combos = [
      [false, false, false], [false, false, true], [false, true, false],
      [true, false, false], [true, false, true], [false, true, true], [true, true, false]
    ];
    for (const combo of combos) {
      const gate = reconciliationGate(combo[0], combo[1], combo[2]);
      expect(gate.allowed).toBe(false);
      expect(typeof gate.reason).toBe("string");
      expect(gate.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("reconciliation safety rails", function () {
  // Candidate = unnamed-origin park row (name === park_name) inside any REGION
  // (pointInAnyRegion). (43.0, -86.0) sits in the Lake Michigan box.
  function parkRow(id, extra) {
    return Object.assign({
      id: id, name: "Some Park", park_name: "Some Park", lat: 43.0, lon: -86.0
    }, extra || {});
  }
  it("skips entirely when the run produced 0 park rows", function () {
    const snap = [parkRow("osm-way-1")];
    expect(reconciliationDeletes(snap, new Set(), 0)).toEqual([]);
  });
  it("deletes a stale candidate not produced this run", function () {
    const snap = [parkRow("osm-way-1"), parkRow("osm-way-2")];
    const produced = new Set(["osm-way-1"]);
    const deletes = reconciliationDeletes(snap, produced, 1);
    expect(deletes).toEqual(["DELETE FROM beaches WHERE id = 'osm-way-2';"]);
  });
  it("never deletes a named beach inside a park (name !== park_name)", function () {
    const snap = [{ id: "osm-way-9", name: "Real Beach", park_name: "Some Park", lat: 43, lon: -86 }];
    const deletes = reconciliationDeletes(snap, new Set(["osm-way-1"]), 1);
    expect(deletes).toEqual([]);
  });
  it("refuses a mass-delete beyond the proportional allowance", function () {
    // 100 candidates, none produced -> 100 stale > allowance max(10, ceil(5)) = 10.
    const snap = [];
    for (let i = 0; i < 100; i = i + 1) { snap.push(parkRow("osm-way-" + i)); }
    const deletes = reconciliationDeletes(snap, new Set(), 1);
    expect(deletes).toEqual([]);
  });
  it("ignores candidates outside all regions", function () {
    // (10.0, 10.0) is far outside every REGION box -> pointInAnyRegion false, so
    // it is never a delete candidate.
    const snap = [parkRow("osm-way-1", { lat: 10.0, lon: 10.0 })];
    const deletes = reconciliationDeletes(snap, new Set(), 1);
    expect(deletes).toEqual([]);
  });

  // --- the TIGHTENED global fraction (0.05, was 0.25) ------------------------
  // 0.25 was calibrated for a transport where partial coverage was normal and a
  // large legitimate delete set was plausible. Under verified layers it is
  // never legitimate, and against the measured table (982 park-origin
  // candidates) it permitted 246 silent deletes — waving through every
  // regression worth naming. These two cases pin the new boundary from both
  // sides; the second is a delete the OLD fraction would have allowed.
  function candidates(n, staleFrom) {
    const snap = [];
    for (let i = 0; i < n; i = i + 1) { snap.push(parkRow("osm-way-" + i)); }
    const produced = new Set();
    for (let i = 0; i < staleFrom; i = i + 1) { produced.add("osm-way-" + i); }
    return { snap: snap, produced: produced };
  }
  it("allows a delete set exactly AT the 5% allowance", function () {
    // 300 candidates -> global allowance max(10, 15) = 15; all in one region, so
    // the per-region allowance is also 15. 15 stale is admitted.
    const c = candidates(300, 285);
    expect(reconciliationDeletes(c.snap, c.produced, 1).length).toBe(15);
  });
  it("refuses one delete PAST the 5% allowance that 25% would have waved through", function () {
    // 16 stale of 300 candidates: allowance 15 at 0.05, but 75 at the old 0.25.
    const c = candidates(300, 284);
    expect(reconciliationDeletes(c.snap, c.produced, 1)).toEqual([]);
  });
});

describe("regionForPoint buckets a row deterministically", function () {
  it("returns the FIRST REGIONS entry containing the point (boxes overlap)", function () {
    expect(regionForPoint(43.0, -86.0)).toBe("Lake Michigan");
    expect(regionForPoint(43.3, -79.0)).toBe("Niagara River");
    // (43.0, -79.0) is inside BOTH Lake Erie and Niagara River; Erie is earlier
    // in the fixed REGIONS order, so it wins, always.
    expect(regionForPoint(43.0, -79.0)).toBe("Lake Erie");
  });
  it("returns null outside every box and for non-finite input", function () {
    expect(regionForPoint(10.0, 10.0)).toBe(null);
    expect(regionForPoint(NaN, -86.0)).toBe(null);
    expect(regionForPoint("43", -86.0)).toBe(null);
  });
});

describe("the per-REGION delete rail catches what the global rail structurally cannot", function () {
  // The global rail's protection asymptotes toward zero as the number of
  // independently breakable clip masks grows: a bug that zeroes ONE region's
  // parks is a small fraction of the global candidate set and passes. The small
  // regions are exactly the ones it can never protect — Niagara has 5
  // park-origin candidates in production, so a floor of 10 would be vacuous.
  function rowAt(id, lat, lon) {
    return { id: id, name: "Some Park", park_name: "Some Park", lat: lat, lon: lon };
  }
  function fixture() {
    const snap = [];
    for (let i = 0; i < 400; i = i + 1) { snap.push(rowAt("mich-" + i, 43.0, -86.0)); }
    for (let i = 0; i < 5; i = i + 1) { snap.push(rowAt("niag-" + i, 43.3, -79.0)); }
    return snap;
  }
  it("refuses the ENTIRE reconciliation when one small region blows its own allowance", function () {
    const snap = fixture();
    // Everything produced except three Niagara rows: 3 stale of 405 candidates
    // clears the global allowance of 21, but Niagara's own allowance is
    // max(2, ceil(0.05 * 5)) = 2.
    const produced = new Set();
    for (let i = 0; i < snap.length; i = i + 1) { produced.add(snap[i].id); }
    produced.delete("niag-0");
    produced.delete("niag-1");
    produced.delete("niag-2");
    const rail = regionDeleteRailAllows(snap, snap.filter(function (r) { return !produced.has(r.id); }));
    expect(rail.allowed).toBe(false);
    expect(rail.region).toBe("Niagara River");
    expect(rail.staleCount).toBe(3);
    expect(rail.allowance).toBe(2);
    // And the composed builder emits NOTHING — not even the Lake Michigan rows.
    expect(reconciliationDeletes(snap, produced, 1)).toEqual([]);
  });
  it("admits a delete set within every region's own allowance", function () {
    const snap = fixture();
    const produced = new Set();
    for (let i = 0; i < snap.length; i = i + 1) { produced.add(snap[i].id); }
    produced.delete("niag-0");
    produced.delete("mich-0");
    const stale = snap.filter(function (r) { return !produced.has(r.id); });
    const rail = regionDeleteRailAllows(snap, stale);
    expect(rail.allowed).toBe(true);
    expect(rail.region).toBe(null);
    expect(rail.staleCount).toBe(2);
    expect(reconciliationDeletes(snap, produced, 1).length).toBe(2);
  });
  it("reports the per-region tally in REGIONS order regardless of snapshot order", function () {
    const snap = fixture().reverse();
    const rail = regionDeleteRailAllows(snap, []);
    expect(rail.regions.map(function (r) { return r.name; })).toEqual(["Lake Michigan", "Niagara River"]);
    expect(rail.regions[0].candidates).toBe(400);
    expect(rail.regions[1].candidates).toBe(5);
    expect(rail.regions[1].allowance).toBe(2);
  });
  it("never throws on empty input", function () {
    const rail = regionDeleteRailAllows([], []);
    expect(rail.allowed).toBe(true);
    expect(rail.regions).toEqual([]);
  });
});

describe("marineZoneSql", function () {
  // One synthetic zone: a water rectangle east of lon -85.90 at lat 43.0..43.1.
  // A beach just WEST of it (on land) derives "LMZ777" via nearest-edge.
  function closedRect(minLon, minLat, maxLon, maxLat) {
    return [
      [minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]
    ];
  }
  const index = buildMarineZoneIndex({
    zones: [{ id: "LMZ777", polygons: [[closedRect(-85.90, 43.0, -85.78, 43.1)]] }]
  });
  const nearBeach = { id: "osm-node-1", lat: 43.05, lon: -85.93, nws_zone: "MIZ071", marine_zone: null };

  it("emits the exact change-only UPDATE with idempotency guards", function () {
    const r = marineZoneSql([nearBeach], new Set(), index);
    expect(r.considered).toBe(1);
    expect(r.updates).toBe(1);
    expect(r.statements).toEqual([
      "UPDATE beaches SET marine_zone = 'LMZ777' WHERE id = 'osm-node-1'" +
      " AND nws_zone IS NOT NULL AND (marine_zone IS NULL OR marine_zone <> 'LMZ777');"
    ]);
  });
  it("emits nothing when the derived zone equals the snapshot value", function () {
    const same = Object.assign({}, nearBeach, { marine_zone: "LMZ777" });
    const r = marineZoneSql([same], new Set(), index);
    expect(r.considered).toBe(1);
    expect(r.updates).toBe(0);
    expect(r.statements).toEqual([]);
  });
  it("corrects a historic probe artifact (existing value differs from derived)", function () {
    const stale = Object.assign({}, nearBeach, { marine_zone: "LMZ874" });
    const r = marineZoneSql([stale], new Set(), index);
    expect(r.statements.length).toBe(1);
    expect(r.statements[0]).toContain("SET marine_zone = 'LMZ777'");
  });
  it("skips rows without a non-empty nws_zone string", function () {
    const noZone = Object.assign({}, nearBeach, { nws_zone: null });
    const emptyZone = Object.assign({}, nearBeach, { nws_zone: "" });
    const missing = { id: "osm-node-2", lat: 43.05, lon: -85.93 };
    const r = marineZoneSql([noZone, emptyZone, missing], new Set(), index);
    expect(r.considered).toBe(0);
    expect(r.statements).toEqual([]);
  });
  it("skips rows deleted by this run's reconciliation", function () {
    const r = marineZoneSql([nearBeach], new Set(["osm-node-1"]), index);
    expect(r.considered).toBe(0);
    expect(r.statements).toEqual([]);
  });
  it("NEVER NULLs out an existing value when derivation misses (derived null)", function () {
    // A far-inland row keeps its old probe result: no statement at all.
    const inland = { id: "osm-node-3", lat: 42.0, lon: -84.0, nws_zone: "MIZ099", marine_zone: "LMZ874" };
    const r = marineZoneSql([inland], new Set(), index);
    expect(r.considered).toBe(1);
    expect(r.updates).toBe(0);
    expect(r.statements).toEqual([]);
  });
  it("is idempotent: a second run over the post-update state emits zero statements", function () {
    const first = marineZoneSql([nearBeach], new Set(), index);
    expect(first.updates).toBe(1);
    // Apply the derived value to the snapshot (what D1 holds after the UPDATE)…
    const derived = nearestMarineZone(index, nearBeach.lat, nearBeach.lon);
    const after = Object.assign({}, nearBeach, { marine_zone: derived });
    // …and the steady-state run emits nothing.
    const second = marineZoneSql([after], new Set(), index);
    expect(second.updates).toBe(0);
    expect(second.statements).toEqual([]);
  });
});

describe("classifyQueue per-beach error isolation", function () {
  // The try/catch around fetchSignals is the batch's error-isolation contract:
  // a throwing or null (transient) fetch must emit NO SQL for that beach and
  // must NOT abort the loop — the row stays queued for the next run.
  it("a thrown fetch and a null fetch emit no SQL and do not stop later beaches", async function () {
    const queue = [
      { id: "osm-node-throw", water_class_attempts: 0 },
      { id: "osm-node-null", water_class_attempts: 0 },
      { id: "osm-node-ok", water_class_attempts: 0 }
    ];
    const result = await classifyQueue(queue, {
      limit: 0,
      delayMs: 0,
      budgetMs: 0,
      now: function () { return 0; },
      fetchSignals: async function (beach) {
        if (beach.id === "osm-node-throw") { throw new Error("boom"); }
        if (beach.id === "osm-node-null") { return null; }
        return {};
      },
      classify: function () { return "inland"; }
    });
    expect(result.processed).toBe(3);
    expect(result.counts.attempted).toBe(3);
    expect(result.counts.transient).toBe(2);
    expect(result.counts.classified).toBe(1);
    expect(result.counts.inland).toBe(1);
    expect(result.counts.bumped).toBe(0);
    // ONLY the healthy beach gets a statement — no UPDATE of any kind for the
    // thrown/null beaches (they stay queued, attempts untouched).
    expect(result.statements).toEqual([classifyUpdateSql("osm-node-ok", "inland")]);
  });
});

describe("classifyQueue bump path (clean fetch, empty classification)", function () {
  it("a successful fetch with classify null bumps attempts and flushes each bump", async function () {
    const queue = [
      { id: "osm-node-b0", water_class_attempts: 0 },
      { id: "osm-node-b1", water_class_attempts: 0 }
    ];
    const flushed = [];
    const result = await classifyQueue(queue, {
      limit: 0,
      delayMs: 0,
      budgetMs: 0,
      now: function () { return 0; },
      fetchSignals: async function () { return {}; },
      classify: function () { return null; },
      flush: async function (s) { flushed.push(s); }
    });
    expect(result.statements).toEqual([
      bumpAttemptsSql("osm-node-b0"),
      bumpAttemptsSql("osm-node-b1")
    ]);
    expect(result.counts.bumped).toBe(2);
    expect(result.counts.classified).toBe(0);
    expect(result.counts.transient).toBe(0);
    // Each bump was also persisted incrementally through the injected flush.
    expect(flushed).toEqual(result.statements);
  });
});

describe("classifyQueue limit cap keeps attempts-ASC group ordering", function () {
  // When limit caps a larger queue, the loop reshuffles within equal-attempts
  // groups but MUST keep attempts ASC across groups: the attempts-2 group is
  // never selected before the attempts-0 group is exhausted. The invariant is
  // group membership, not order within the group, so run it a few times to be
  // robust to the shuffle.
  it("selects only the lowest-attempts group when limit equals its size", async function () {
    for (let run = 0; run < 5; run = run + 1) {
      const queue = [
        { id: "osm-node-a0", water_class_attempts: 0 },
        { id: "osm-node-a1", water_class_attempts: 0 },
        { id: "osm-node-a2", water_class_attempts: 0 },
        { id: "osm-node-b0", water_class_attempts: 2 },
        { id: "osm-node-b1", water_class_attempts: 2 },
        { id: "osm-node-b2", water_class_attempts: 2 }
      ];
      const result = await classifyQueue(queue, {
        limit: 3,
        delayMs: 0,
        budgetMs: 0,
        now: function () { return 0; },
        fetchSignals: async function () { return {}; },
        classify: function () { return "great_lake"; }
      });
      expect(result.processed).toBe(3);
      expect(result.statements.length).toBe(3);
      const allowed = new Set([
        classifyUpdateSql("osm-node-a0", "great_lake"),
        classifyUpdateSql("osm-node-a1", "great_lake"),
        classifyUpdateSql("osm-node-a2", "great_lake")
      ]);
      for (const stmt of result.statements) {
        expect(allowed.has(stmt)).toBe(true);
      }
      // All three attempts-0 beaches were hit exactly once (no duplicates).
      expect(new Set(result.statements).size).toBe(3);
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
  it("skips a parked row at the attempts cap once it has been through the decisive classifier", function () {
    // The attempts cap still parks rows for good — but the proof a row was
    // actually decided-on is a STAMPED version. An unversioned park predates the
    // clean-but-empty -> inland change and is re-drained exactly once (covered in
    // the legacy re-drain tests above).
    const snap = [{
      id: "osm-node-p", osm_id: "node/p", lat: 43.0, lon: -86.0,
      water_class: null, water_class_version: WATER_CLASS_VERSION,
      water_class_attempts: WATER_CLASS_MAX_ATTEMPTS
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

describe("classifyQueue absent-from-layers bump (the D21 attempts semantics)", function () {
  // Under the old per-beach probe there was no such thing as "absent": the
  // server answered for any id. Under a VERIFIED layer set, absent means GONE
  // FROM OSM, which is a real answer and must bump attempts — otherwise the row
  // re-queues forever with attempts stuck at 0 and the fail-open serves it live
  // with an estimated flag card permanently.
  const queue = [{ id: "osm-way-gone", water_class_attempts: 0 }];
  it("bumps attempts and counts absent_from_layers when the set is verified", async function () {
    const result = await classifyQueue(queue, {
      now: function () { return 0; },
      fetchSignals: async function () { return null; },
      isKnownAbsent: function () { return true; }
    });
    expect(result.statements).toEqual([bumpAttemptsSql("osm-way-gone")]);
    expect(result.counts.absent_from_layers).toBe(1);
    expect(result.counts.bumped).toBe(1);
    expect(result.counts.transient).toBe(0);
  });
  it("stays TRANSIENT when the bump is disarmed (an unverified or out-of-scope set)", async function () {
    // This is what keeps an expansion commit from parking and hiding every
    // beach on the newly-added coast while the first rebuild is pending.
    const result = await classifyQueue(queue, {
      now: function () { return 0; },
      fetchSignals: async function () { return null; },
      isKnownAbsent: function () { return false; }
    });
    expect(result.statements).toEqual([]);
    expect(result.counts.absent_from_layers).toBe(0);
    expect(result.counts.transient).toBe(1);
  });
  it("never reads a THROWN probe as absent, however the predicate answers", async function () {
    // A throw says the probe failed, never that the element is missing.
    const result = await classifyQueue(queue, {
      now: function () { return 0; },
      fetchSignals: async function () { throw new Error("boom"); },
      isKnownAbsent: function () { return true; }
    });
    expect(result.statements).toEqual([]);
    expect(result.counts.absent_from_layers).toBe(0);
    expect(result.counts.transient).toBe(1);
  });
  it("returns the DECISIONS it made as verdicts, and never a bump or an absence", async function () {
    // verdicts is what feeds the classification flip rail: it must carry
    // re-decisions and nothing else, or a run full of attempts bumps would read
    // as a run full of flips.
    const rows = [
      { id: "decided", water_class_attempts: 0 },
      { id: "bumped", water_class_attempts: 0 },
      { id: "gone", water_class_attempts: 0 }
    ];
    const result = await classifyQueue(rows, {
      now: function () { return 0; },
      fetchSignals: async function (beach) { return beach.id === "gone" ? null : {}; },
      isKnownAbsent: function () { return true; },
      classify: function () { return null; }
    });
    // Two clean-but-empty answers plus one absence, all three of them bumps.
    expect(result.counts.bumped).toBe(3);
    expect(result.counts.absent_from_layers).toBe(1);
    expect(result.verdicts.size).toBe(0);
    const decided = await classifyQueue([rows[0]], {
      now: function () { return 0; },
      fetchSignals: async function () { return {}; },
      classify: function () { return "great_lake"; }
    });
    expect(decided.verdicts.get("decided")).toBe("great_lake");
    expect(decided.verdicts.size).toBe(1);
  });
});

describe("classificationFlipRailAllows — the rail on mass RE-classification", function () {
  // Deciding inland HIDES a beach: the same product loss as deleting the row,
  // arriving faster, and invisible in the row count. There were four rails on
  // deletes and none here, while 100% of the served flag-worthy rows classify
  // through one code path — so one broken build plus a version bump re-decides
  // all of them in a single delta and empties the site.
  function snapshot(flagWorthyCount, inlandCount) {
    const rows = [];
    for (let i = 0; i < flagWorthyCount; i = i + 1) {
      rows.push({ id: "gl-" + i, water_class: "great_lake" });
    }
    for (let i = 0; i < inlandCount; i = i + 1) {
      rows.push({ id: "in-" + i, water_class: "inland" });
    }
    return rows;
  }
  it("allows the normal drain: unclassified rows deciding for the first time", function () {
    const rows = [{ id: "new-1", water_class: null }, { id: "new-2" }];
    const rail = classificationFlipRailAllows(rows, new Map([["new-1", "inland"], ["new-2", "great_lake"]]));
    expect(rail.allowed).toBe(true);
    expect(rail.hideFlips).toBe(0);
    expect(rail.matrix.unclassified.inland).toBe(1);
    expect(rail.matrix.unclassified.great_lake).toBe(1);
  });
  it("allows a small hide set within max(10, 10% of the flag-worthy rows)", function () {
    const rows = snapshot(200, 0);
    const verdicts = new Map();
    for (let i = 0; i < 20; i = i + 1) { verdicts.set("gl-" + i, "inland"); }
    const rail = classificationFlipRailAllows(rows, verdicts);
    expect(rail.flagWorthy).toBe(200);
    expect(rail.allowance).toBe(20);
    expect(rail.hideFlips).toBe(20);
    expect(rail.allowed).toBe(true);
  });
  it("REFUSES a synthetic mass hide", function () {
    const rows = snapshot(200, 0);
    const verdicts = new Map();
    for (let i = 0; i < 150; i = i + 1) { verdicts.set("gl-" + i, "inland"); }
    const rail = classificationFlipRailAllows(rows, verdicts);
    expect(rail.allowed).toBe(false);
    expect(rail.hideFlips).toBe(150);
    expect(rail.allowance).toBe(20);
    expect(rail.matrix.great_lake.inland).toBe(150);
  });
  it("keeps a floor of 10 so a tiny table is not railed into uselessness", function () {
    const rows = snapshot(12, 0);
    const verdicts = new Map();
    for (let i = 0; i < 10; i = i + 1) { verdicts.set("gl-" + i, "inland"); }
    expect(classificationFlipRailAllows(rows, verdicts).allowance).toBe(10);
    expect(classificationFlipRailAllows(rows, verdicts).allowed).toBe(true);
  });
  it("is ASYMMETRIC: inland -> flag-worthy is un-hiding and is never refused", function () {
    const rows = snapshot(0, 500);
    const verdicts = new Map();
    for (let i = 0; i < 500; i = i + 1) { verdicts.set("in-" + i, "great_lake"); }
    const rail = classificationFlipRailAllows(rows, verdicts);
    expect(rail.allowed).toBe(true);
    expect(rail.unhideFlips).toBe(500);
    expect(rail.hideFlips).toBe(0);
    expect(rail.matrix.inland.great_lake).toBe(500);
  });
  it("accepts a plain object verdict map and ignores rows with no verdict", function () {
    const rows = snapshot(3, 0);
    const rail = classificationFlipRailAllows(rows, { "gl-0": "inland" });
    expect(rail.hideFlips).toBe(1);
    expect(rail.matrix.great_lake.inland).toBe(1);
  });
  it("never throws on empty or missing input", function () {
    expect(classificationFlipRailAllows([], new Map()).allowed).toBe(true);
    expect(classificationFlipRailAllows(null, null).allowed).toBe(true);
    expect(classificationFlipRailAllows(undefined, undefined).hideFlips).toBe(0);
  });
  it("renders every row of the confusion matrix, logged whether or not the rail fires", function () {
    const rendered = formatFlipMatrix(classificationFlipRailAllows(snapshot(2, 0), { "gl-0": "inland" }).matrix);
    expect(rendered).toContain("great_lake->{great_lake=0 ocean=0 inland=1}");
    expect(rendered).toContain("ocean->{");
    expect(rendered).toContain("inland->{");
    expect(rendered).toContain("unclassified->{");
  });
});

describe("the layer file plan", function () {
  it("consumes every published layer key and names no key the build does not publish", function () {
    // A drift here does not throw or warn at runtime — it silently zeroes a
    // logical layer, which is precisely the valid-looking failure the manifest
    // gate exists for. main() asserts it too, before any SQL is emitted.
    expect(layerFilePlanProblems()).toEqual({ missing: [], unexpected: [] });
  });
  it("joins a layer directory and a file name with exactly one separator", function () {
    expect(joinLayerPath("/tmp/layers", "report.json")).toBe("/tmp/layers/report.json");
    expect(joinLayerPath("/tmp/layers/", "report.json")).toBe("/tmp/layers/report.json");
    expect(joinLayerPath("", "report.json")).toBe("report.json");
  });
});

describe("splitOtherRelations halves the relation layer by TAG, not by file", function () {
  // GDAL routes type=site and unassemblable beach/park relations to
  // other_relations. The beach half must reach discovery (such a beach vanishes
  // entirely otherwise) and the park half must reach the NAMING tier (dropping
  // it unnames beaches and deletes their park-origin rows), so the one file is
  // split by the same branch-precedence chain the rest of discovery uses.
  function feature(tags) {
    return {
      osmType: "relation", osmId: 1, tags: tags,
      bounds: { minLat: 43.0, minLon: -86.0, maxLat: 43.01, maxLon: -85.99 },
      geometry: { type: "Point", coordinates: [-86.0, 43.0] }
    };
  }
  it("routes natural=beach to the beach half and a named park to the park half", function () {
    const beach = feature({ natural: "beach", name: "Sandy" });
    const park = feature({ leisure: "park", name: "Some Park" });
    const split = splitOtherRelations([beach, park]);
    expect(split.beaches).toEqual([beach]);
    expect(split.parks).toEqual([park]);
  });
  it("keeps a named protected lake in the PARK half — losing its park role deletes rows", function () {
    // natural=water AND park-tagged AND named: the branch order is load-bearing,
    // and it is not re-implemented here.
    const protectedLake = feature({ natural: "water", boundary: "protected_area", name: "Reserve Lake" });
    const split = splitOtherRelations([protectedLake]);
    expect(split.parks).toEqual([protectedLake]);
    expect(split.beaches).toEqual([]);
  });
  it("drops a relation that is neither, and never throws on junk input", function () {
    expect(splitOtherRelations([feature({ type: "site" })])).toEqual({ beaches: [], parks: [] });
    expect(splitOtherRelations(null)).toEqual({ beaches: [], parks: [] });
    expect(splitOtherRelations([null, undefined, {}])).toEqual({ beaches: [], parks: [] });
  });
});
