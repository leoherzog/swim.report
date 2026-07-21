// Dependency-free proof that the four demand-aware ORDER BY clauses (F8) do
// what the plan claims when run against REAL SQLite, not just substring
// matches on the SQL string. Uses the Node built-in node:sqlite
// (DatabaseSync) so no better-sqlite3/native-module dependency is added to
// the project; if this Node build has no node:sqlite, the whole file is
// skipped rather than failing the run.
//
// The four clauses under test are copied VERBATIM from src/index.js so a
// drift between this file and the real cron SQL is a merge conflict, not a
// silent divergence:
//   - runFlagRecompute / runWaveRefresh (shared hybrid clause):
//       ORDER BY (last_viewed IS NOT NULL AND last_viewed >= ?1) DESC,
//                recompute_updated ASC, id ASC
//   - runNwsEnrichment:
//       ORDER BY enrichment_attempts ASC, last_viewed DESC NULLS LAST, RANDOM()
//   - runEcccEnrichment:
//       ORDER BY eccc_attempts ASC, last_viewed DESC NULLS LAST, RANDOM()
//   - runWebcamSync:
//       ORDER BY (webcam_checked IS NULL) DESC, last_viewed DESC NULLS LAST,
//                webcam_checked ASC, id ASC
import { describe, it, expect, beforeAll } from "vitest";

let DatabaseSync = null;
let sqliteUnavailableReason = "";
try {
  const nodeSqlite = await import("node:sqlite");
  DatabaseSync = nodeSqlite.DatabaseSync;
} catch (err) {
  sqliteUnavailableReason = err && err.message ? err.message : "node:sqlite import failed";
}

const describeIfSqlite = DatabaseSync ? describe : describe.skip;

if (!DatabaseSync) {
  console.log(
    "test/demandOrdering.test.js: node:sqlite unavailable on this Node build (" +
    sqliteUnavailableReason + ") — skipping the whole file."
  );
}

// Builds a fresh in-memory beaches table with just the columns the four
// clauses touch, seeded with the given rows (arrays -> INSERT per row).
function makeBeachesDb(rows) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE beaches (" +
    "id TEXT, " +
    "enrichment_attempts INTEGER, " +
    "eccc_attempts INTEGER, " +
    "webcam_checked TEXT, " +
    "recompute_updated TEXT, " +
    "last_viewed TEXT" +
    ")"
  );
  const insert = db.prepare(
    "INSERT INTO beaches " +
    "(id, enrichment_attempts, eccc_attempts, webcam_checked, recompute_updated, last_viewed) " +
    "VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.enrichment_attempts === undefined ? 0 : row.enrichment_attempts,
      row.eccc_attempts === undefined ? 0 : row.eccc_attempts,
      row.webcam_checked === undefined ? null : row.webcam_checked,
      row.recompute_updated === undefined ? null : row.recompute_updated,
      row.last_viewed === undefined ? null : row.last_viewed
    );
  }
  return db;
}

function idsOf(rows) {
  return rows.map(function (r) { return r.id; });
}

describeIfSqlite("demand-aware ORDER BY clauses against real SQLite (F8)", function () {
  let now;
  let hotCutoffIso;
  let recentIso;
  let staleIso;

  beforeAll(function () {
    now = Date.now();
    hotCutoffIso = new Date(now - 7 * 86400000).toISOString();
    recentIso = new Date(now - 60000).toISOString(); // 1 minute ago: hot
    staleIso = new Date(now - 8 * 86400000).toISOString(); // 8 days ago: cold
  });

  describe("runFlagRecompute / runWaveRefresh hybrid clause", function () {
    const CLAUSE =
      "ORDER BY (last_viewed IS NOT NULL AND last_viewed >= ?1) DESC, " +
      "recompute_updated ASC, id ASC";

    it("puts the recently-viewed (hot) beach first, ahead of an otherwise-earlier rotation turn", function () {
      const db = makeBeachesDb([
        // "cold" has the earliest recompute_updated (would win a plain
        // rotation sort) but was never viewed.
        { id: "cold", recompute_updated: "2020-01-01T00:00:00.000Z", last_viewed: null },
        // "hot" recomputed more recently but was viewed just now.
        { id: "hot", recompute_updated: "2026-06-01T00:00:00.000Z", last_viewed: recentIso },
        // "cold-recent-view" was viewed, but before the 7-day window closed.
        { id: "cold-old-view", recompute_updated: "2021-01-01T00:00:00.000Z", last_viewed: staleIso }
      ]);
      const rows = db.prepare("SELECT * FROM beaches " + CLAUSE).all(hotCutoffIso);
      // hot sorts first regardless of its rotation position; the two cold
      // rows fall back to plain recompute_updated ASC ordering between
      // themselves (cold's 2020 timestamp before cold-old-view's 2021 one).
      expect(idsOf(rows)).toEqual(["hot", "cold", "cold-old-view"]);
    });

    it("a never-viewed (NULL last_viewed) row sorts with the cold group, not first or crashing", function () {
      const db = makeBeachesDb([
        { id: "never-viewed", recompute_updated: "2025-01-01T00:00:00.000Z", last_viewed: null },
        { id: "hot", recompute_updated: "2026-06-01T00:00:00.000Z", last_viewed: recentIso }
      ]);
      const rows = db.prepare("SELECT * FROM beaches " + CLAUSE).all(hotCutoffIso);
      expect(idsOf(rows)).toEqual(["hot", "never-viewed"]);
    });
  });

  describe("runNwsEnrichment clause (attempts-first, hot tiebreak)", function () {
    const CLAUSE = "ORDER BY enrichment_attempts ASC, last_viewed DESC NULLS LAST, RANDOM()";

    it("orders by enrichment_attempts ASC first regardless of last_viewed", function () {
      const db = makeBeachesDb([
        { id: "many-attempts-hot", enrichment_attempts: 4, last_viewed: recentIso },
        { id: "few-attempts-cold", enrichment_attempts: 0, last_viewed: null }
      ]);
      const rows = db.prepare("SELECT * FROM beaches " + CLAUSE).all();
      // The lower-attempts row wins even though it was never viewed and the
      // higher-attempts row was viewed a minute ago — attempts stays primary.
      expect(idsOf(rows)).toEqual(["few-attempts-cold", "many-attempts-hot"]);
    });

    it("within equal attempts, the more recently viewed row sorts first (NULLS LAST)", function () {
      const db = makeBeachesDb([
        { id: "never-viewed", enrichment_attempts: 1, last_viewed: null },
        { id: "viewed-long-ago", enrichment_attempts: 1, last_viewed: staleIso },
        { id: "viewed-recently", enrichment_attempts: 1, last_viewed: recentIso }
      ]);
      const rows = db.prepare("SELECT * FROM beaches " + CLAUSE).all();
      expect(idsOf(rows)).toEqual(["viewed-recently", "viewed-long-ago", "never-viewed"]);
    });
  });

  describe("runEcccEnrichment clause (eccc_attempts-first, hot tiebreak)", function () {
    const CLAUSE = "ORDER BY eccc_attempts ASC, last_viewed DESC NULLS LAST, RANDOM()";

    it("orders by eccc_attempts ASC first regardless of last_viewed", function () {
      const db = makeBeachesDb([
        { id: "many-attempts-hot", eccc_attempts: 3, last_viewed: recentIso },
        { id: "few-attempts-cold", eccc_attempts: 0, last_viewed: null }
      ]);
      const rows = db.prepare("SELECT * FROM beaches " + CLAUSE).all();
      expect(idsOf(rows)).toEqual(["few-attempts-cold", "many-attempts-hot"]);
    });

    it("within equal eccc_attempts, the more recently viewed row sorts first (NULLS LAST)", function () {
      const db = makeBeachesDb([
        { id: "never-viewed", eccc_attempts: 2, last_viewed: null },
        { id: "viewed-recently", eccc_attempts: 2, last_viewed: recentIso }
      ]);
      const rows = db.prepare("SELECT * FROM beaches " + CLAUSE).all();
      expect(idsOf(rows)).toEqual(["viewed-recently", "never-viewed"]);
    });
  });

  describe("runWebcamSync clause (never-checked-first, hot tiebreak, then oldest-checked/id)", function () {
    const CLAUSE =
      "ORDER BY (webcam_checked IS NULL) DESC, last_viewed DESC NULLS LAST, " +
      "webcam_checked ASC, id ASC";

    it("a never-checked row sorts first even when a checked row was viewed more recently", function () {
      const db = makeBeachesDb([
        { id: "checked-hot", webcam_checked: "2026-07-01T00:00:00.000Z", last_viewed: recentIso },
        { id: "never-checked-cold", webcam_checked: null, last_viewed: null }
      ]);
      const rows = db.prepare("SELECT * FROM beaches " + CLAUSE).all();
      expect(idsOf(rows)).toEqual(["never-checked-cold", "checked-hot"]);
    });

    it("among rows equally never-checked or equally checked, the hot (recently-viewed) row sorts first", function () {
      const db = makeBeachesDb([
        { id: "never-checked-b", webcam_checked: null, last_viewed: staleIso },
        { id: "never-checked-a-hot", webcam_checked: null, last_viewed: recentIso }
      ]);
      const rows = db.prepare("SELECT * FROM beaches " + CLAUSE).all();
      expect(idsOf(rows)).toEqual(["never-checked-a-hot", "never-checked-b"]);
    });

    it("falls back to webcam_checked ASC, id ASC once never-checked and last_viewed are exhausted", function () {
      const db = makeBeachesDb([
        { id: "z-older-check", webcam_checked: "2026-01-01T00:00:00.000Z", last_viewed: null },
        { id: "a-newer-check", webcam_checked: "2026-06-01T00:00:00.000Z", last_viewed: null }
      ]);
      const rows = db.prepare("SELECT * FROM beaches " + CLAUSE).all();
      expect(idsOf(rows)).toEqual(["z-older-check", "a-newer-check"]);
    });
  });
});
