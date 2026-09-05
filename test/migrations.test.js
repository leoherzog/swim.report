// migrations/ apply in order to an in-memory SQLite, the engine D1 runs, so a
// statement D1 would reject fails here first. The requeue migration is then
// exercised against seeded rows.
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MARINE_ZONE_PREFIXES } from "../src/clients/nws.js";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(function (f) { return /^\d{4}_.*\.sql$/.test(f); })
    .sort();
}

function applyMigrations(db, upTo) {
  for (const file of migrationFiles()) {
    if (upTo && file > upTo) {
      break;
    }
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
}

describe("migrations", function () {
  it("apply in order without error", function () {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(beaches)").all().map(function (c) { return c.name; });
    expect(cols).toContain("nws_zone");
    expect(cols).toContain("marine_zone");
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
