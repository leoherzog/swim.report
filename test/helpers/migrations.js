// test/helpers/migrations.js — the migrations/ loader shared by the migration
// test and the SQLite-backed D1 fake. Files apply in filename order, which is
// the order D1 applies them.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR =
  join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "migrations");

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(function (f) { return /^\d{4}_.*\.sql$/.test(f); })
    .sort();
}

// Applies every migration, or every one up to and including upTo.
export function applyMigrations(db, upTo) {
  for (const file of migrationFiles()) {
    if (upTo && file > upTo) {
      break;
    }
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
}
