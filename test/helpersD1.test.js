// The SQLite-backed D1 fake itself: migrations apply, the seeders produce rows
// the repo's real queries accept, batches are all-or-nothing, and every result
// carries D1's shape.
import { describe, it, expect } from "vitest";
import { makeD1 } from "./helpers/d1.js";
import { FLAG_WORTHY_WATER_SQL } from "../src/waterClass.js";
import { BEACH_STATE_SELECT, BEACH_STATE_JOIN } from "../src/beachState.js";

describe("makeD1", function () {
  it("applies every migration", async function () {
    const env = makeD1();
    const cols = await env.prepare("PRAGMA table_info(beach_state)").all();
    const names = cols.results.map(function (c) { return c.name; });
    expect(names).toContain("estimate_expires");
    expect(names).toContain("wave_expires");
    const beachCols = await env.prepare("PRAGMA table_info(beaches)").all();
    expect(beachCols.results.map(function (c) { return c.name; })).toContain("marine_zone");
  });

  it("seeds beaches flag-worthy by default and respects an explicit water_class", async function () {
    const env = makeD1();
    env.seedBeaches([
      { id: "b1", name: "Great Lake Beach", lat: 42.1, lon: -86.2 },
      { id: "b2", name: "Ocean Beach", lat: 33.0, lon: -117.3, water_class: "ocean" },
      { id: "b3", name: "Pond Beach", lat: 44.0, lon: -85.0, water_class: "inland" },
      { id: "b4", name: "Pending Beach", lat: 45.0, lon: -84.0, water_class: null }
    ]);
    const worthy = await env.prepare(
      "SELECT id FROM beaches WHERE " + FLAG_WORTHY_WATER_SQL + " ORDER BY id"
    ).all();
    expect(worthy.results.map(function (r) { return r.id; })).toEqual(["b1", "b2", "b4"]);
    const b1 = await env.prepare("SELECT * FROM beaches WHERE id = ?1").bind("b1").first();
    expect(b1.water_class).toBe("great_lake");
    expect(b1.osm_id).toBe("b1");
    expect(b1.water_class_attempts).toBe(0);
  });

  it("ignores unknown fixture keys", async function () {
    const env = makeD1();
    env.seedBeaches([{ id: "b1", name: "Beach", lat: 1, lon: 2, flagColor: "green" }]);
    const row = await env.prepare("SELECT * FROM beaches WHERE id = ?1").bind("b1").first();
    expect(row.name).toBe("Beach");
    expect(row.flagColor).toBeUndefined();
  });

  it("seeds beach_state and joins it onto beaches", async function () {
    const env = makeD1();
    env.seedBeaches([{ id: "b1", name: "Joined Beach", lat: 1, lon: 2 }, { id: "b2" }]);
    env.seedState("b1", {
      estimate: { color: "yellow", updated: "2026-09-09T12:00:00Z" },
      estimate_color: "yellow",
      estimate_expires: 1750025200
    });
    const rows = await env.prepare(
      "SELECT b.*, " + BEACH_STATE_SELECT + " FROM beaches b" + BEACH_STATE_JOIN +
      " ORDER BY b.id"
    ).all();
    expect(rows.results.length).toBe(2);
    expect(JSON.parse(rows.results[0].estimate).color).toBe("yellow");
    expect(rows.results[0].estimate_expires).toBe(1750025200);
    expect(rows.results[0].name).toBe("Joined Beach");
    expect(rows.results[1].estimate).toBeNull();
    expect(env.stateOf("b1").estimate_color).toBe("yellow");
    expect(env.stateOf("b2")).toBeNull();
  });

  it("seeds a wave record without wiping the columns already seeded", async function () {
    const env = makeD1();
    env.seedBeaches([{ id: "b1" }]);
    env.seedState("b1", {
      estimate: { color: "yellow", updated: "2026-09-09T12:00:00Z" },
      estimate_color: "yellow",
      estimate_expires: 1750025200
    });
    const record = { beachId: "b1", startIso: "2026-09-09T06:00:00Z", hoursFt: [1.2] };
    env.seedWave("b1", record);

    const row = env.stateOf("b1");
    expect(JSON.parse(row.wave)).toEqual(record);
    expect(row.wave_expires).toBe(Math.floor(Date.parse(record.startIso) / 1000) + 86400);
    expect(row.estimate_color).toBe("yellow");
    expect(row.estimate_expires).toBe(1750025200);

    env.seedWave("b1", record, 42);
    expect(env.stateOf("b1").wave_expires).toBe(42);
    expect(env.stateOf("b1").estimate_color).toBe("yellow");
  });

  it("returns D1 shapes from all, first and run", async function () {
    const env = makeD1();
    env.seedBeaches([{ id: "b1", name: "A", lat: 1, lon: 2 }, { id: "b2", name: "B", lat: 3, lon: 4 }]);
    const all = await env.prepare("SELECT id, name FROM beaches ORDER BY id").all();
    expect(all.success).toBe(true);
    expect(all.results).toEqual([{ id: "b1", name: "A" }, { id: "b2", name: "B" }]);
    expect(all.meta.changes).toBe(0);

    const first = await env.prepare("SELECT id, name FROM beaches ORDER BY id").first();
    expect(first).toEqual({ id: "b1", name: "A" });
    const column = await env.prepare("SELECT COUNT(*) AS c FROM beaches").first("c");
    expect(column).toBe(2);
    const missing = await env.prepare("SELECT id FROM beaches WHERE id = ?1").bind("nope").first();
    expect(missing).toBeNull();
    const missingColumn = await env.prepare("SELECT id FROM beaches WHERE id = ?1")
      .bind("nope").first("id");
    expect(missingColumn).toBeNull();

    const run = await env.prepare("UPDATE beaches SET name = ?1 WHERE id = ?2")
      .bind("Renamed", "b1").run();
    expect(run.success).toBe(true);
    expect(run.meta.changes).toBe(1);
    expect(run.meta.rows_written).toBe(1);
    const noop = await env.prepare("UPDATE beaches SET name = ?1 WHERE id = ?2")
      .bind("X", "absent").run();
    expect(noop.meta.changes).toBe(0);
  });

  it("binds positional parameters in order and reuses ?1", async function () {
    const env = makeD1();
    env.seedBeaches([{ id: "b1", lat: 5, lon: 6 }]);
    const row = await env.prepare(
      "SELECT id, name, lat, lon FROM beaches WHERE id = ?1 AND name = ?1 AND lat > ?2"
    ).bind("b1", 1).first();
    expect(row).toEqual({ id: "b1", name: "b1", lat: 5, lon: 6 });
  });

  it("records every statement with its bound args, and every batch call", async function () {
    const env = makeD1();
    env.seedBeaches([{ id: "b1" }]);
    await env.prepare("SELECT id FROM beaches").all();
    const stmt = env.prepare("SELECT id FROM beaches WHERE id = ?1").bind("b1");
    await stmt.first();
    await env.batch([stmt]);
    expect(env.statements[0]).toEqual({ sql: "SELECT id FROM beaches", args: [] });
    expect(env.statements[1]).toEqual({
      sql: "SELECT id FROM beaches WHERE id = ?1", args: ["b1"]
    });
    expect(env.batchCalls.length).toBe(1);
    expect(env.batchCalls[0].length).toBe(1);
    expect(env.batchCalls[0][0].sql).toBe("SELECT id FROM beaches WHERE id = ?1");
  });

  it("re-binding a prepared statement records a second entry", async function () {
    const env = makeD1();
    const prepared = env.prepare("SELECT ?1 AS v");
    const one = prepared.bind(1);
    const two = prepared.bind(2);
    expect(await one.first("v")).toBe(1);
    expect(await two.first("v")).toBe(2);
    expect(env.statements.length).toBe(2);
    expect(env.statements[1].args).toEqual([2]);
  });

  it("runs an unbound statement", async function () {
    const env = makeD1();
    env.seedBeaches([{ id: "b1" }]);
    const out = await env.prepare("SELECT COUNT(*) AS c FROM beaches").all();
    expect(out.results[0].c).toBe(1);
  });

  it("rejects a matching statement under failWhen", async function () {
    const env = makeD1();
    env.failWhen(function (sql, args) {
      return sql.indexOf("INSERT INTO beach_state") === 0 && args[0] === "bad";
    });
    env.seedBeaches([{ id: "bad" }, { id: "good" }]);
    await expect(
      env.prepare("INSERT INTO beach_state (beach_id) VALUES (?1)").bind("bad").run()
    ).rejects.toThrow(/forced failure/);
    const ok = await env.prepare("INSERT INTO beach_state (beach_id) VALUES (?1)")
      .bind("good").run();
    expect(ok.meta.changes).toBe(1);
    expect(env.stateOf("bad")).toBeNull();
  });

  it("applies a batch all or nothing", async function () {
    const env = makeD1();
    env.seedBeaches([{ id: "b1" }, { id: "b2" }]);
    env.failWhen(function (sql, args) {
      return args[0] === "b2";
    });
    await expect(env.batch([
      env.prepare("INSERT INTO beach_state (beach_id, estimate_color) VALUES (?1, ?2)")
        .bind("b1", "green"),
      env.prepare("INSERT INTO beach_state (beach_id, estimate_color) VALUES (?1, ?2)")
        .bind("b2", "red")
    ])).rejects.toThrow(/forced batch failure/);
    expect(env.stateOf("b1")).toBeNull();
    expect(env.stateOf("b2")).toBeNull();

    const results = await env.batch([
      env.prepare("INSERT INTO beach_state (beach_id, estimate_color) VALUES (?1, ?2)")
        .bind("b1", "green"),
      env.prepare("SELECT COUNT(*) AS c FROM beaches").bind()
    ]);
    expect(results.length).toBe(2);
    expect(results[0].meta.changes).toBe(1);
    expect(results[1].results[0].c).toBe(2);
    expect(env.stateOf("b1").estimate_color).toBe("green");
  });

  it("rolls a batch back when a statement fails in SQLite", async function () {
    const env = makeD1();
    env.seedBeaches([{ id: "b1" }]);
    await expect(env.batch([
      env.prepare("INSERT INTO beach_state (beach_id) VALUES (?1)").bind("b1"),
      env.prepare("INSERT INTO no_such_table (beach_id) VALUES (?1)").bind("b1")
    ])).rejects.toThrow();
    expect(env.stateOf("b1")).toBeNull();
    const after = await env.prepare("SELECT COUNT(*) AS c FROM beaches").first("c");
    expect(after).toBe(1);
  });
});
