// migrations/ apply in order to an in-memory SQLite, the engine D1 runs, so a
// statement D1 would reject fails here first. The requeue migration is then
// exercised against seeded rows.
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MARINE_ZONE_PREFIXES } from "../src/clients/nws.js";
import { MIGRATIONS_DIR, applyMigrations } from "./helpers/migrations.js";

describe("migrations", function () {
  it("apply in order without error", function () {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(beaches)").all().map(function (c) { return c.name; });
    expect(cols).toContain("nws_zone");
    expect(cols).toContain("marine_zone");
  });

  it("0014 creates beach_state with every derived-record column", function () {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(beach_state)").all();
    const names = cols.map(function (c) { return c.name; });
    expect(names).toEqual([
      "beach_id",
      "estimate", "estimate_color", "estimate_updated", "estimate_expires",
      "official", "official_color", "official_updated", "official_expires",
      "wqfloor", "wqfloor_expires",
      "reading", "reading_expires",
      "wave", "wave_expires"
    ]);
    const byName = {};
    for (const c of cols) {
      byName[c.name] = c;
    }
    expect(byName.beach_id.pk).toBe(1);
    expect(byName.estimate_expires.type).toBe("INTEGER");
    expect(byName.official_expires.type).toBe("INTEGER");
    expect(byName.wqfloor_expires.type).toBe("INTEGER");
    expect(byName.reading_expires.type).toBe("INTEGER");
    expect(byName.wave.type).toBe("TEXT");
    expect(byName.wave_expires.type).toBe("INTEGER");
  });

  it("0015 adds the wave columns to an already-populated beach_state", function () {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db, "0014_beach_state.sql");
    db.prepare(
      "INSERT INTO beach_state (beach_id, estimate, estimate_color, estimate_expires) " +
      "VALUES (?1, ?2, ?3, ?4)"
    ).run("b1", JSON.stringify({ color: "green" }), "green", 1750025200);

    db.exec(readFileSync(join(MIGRATIONS_DIR, "0015_beach_state_wave.sql"), "utf8"));

    const row = db.prepare("SELECT * FROM beach_state WHERE beach_id = 'b1'").get();
    expect(row.estimate_color).toBe("green");
    expect(row.estimate_expires).toBe(1750025200);
    expect(row.wave).toBeNull();
    expect(row.wave_expires).toBeNull();
  });

  it("0013 requeues marine nws_zone rows and leaves land rows and marine_zone alone", function () {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db, "0012_wave_updated.sql");
    const insert = db.prepare(
      "INSERT INTO beaches (id, osm_id, name, lat, lon, nws_zone, nws_grid_url, marine_zone, enrichment_attempts) " +
      "VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
    );
    insert.run("land", "Land", 42.4, -86.3, "MIZ071", "https://api.weather.gov/gridpoints/GRR/44,41", "LMZ221", 2);
    insert.run("null", "Null", 44.5, -80.2, null, null, null, 5);
    for (const prefix of MARINE_ZONE_PREFIXES) {
      insert.run("marine-" + prefix, prefix, 43.0, -87.0, prefix + "221", "https://api.weather.gov/gridpoints/MKX/1,1", prefix + "221", 3);
    }

    db.exec(readFileSync(join(MIGRATIONS_DIR, "0013_requeue_marine_nws_zone.sql"), "utf8"));

    const land = db.prepare("SELECT * FROM beaches WHERE id = 'land'").get();
    expect(land.nws_zone).toBe("MIZ071");
    expect(land.nws_grid_url).toBe("https://api.weather.gov/gridpoints/GRR/44,41");
    expect(land.enrichment_attempts).toBe(2);
    const parked = db.prepare("SELECT * FROM beaches WHERE id = 'null'").get();
    expect(parked.nws_zone).toBeNull();
    expect(parked.enrichment_attempts).toBe(5);
    const requeued = db.prepare("SELECT * FROM beaches WHERE id LIKE 'marine-%'").all();
    expect(requeued.length).toBe(MARINE_ZONE_PREFIXES.length);
    for (const row of requeued) {
      expect(row.nws_zone).toBeNull();
      expect(row.nws_grid_url).toBeNull();
      expect(row.enrichment_attempts).toBe(0);
      expect(row.marine_zone).toBe(row.name + "221");
    }
  });
});
