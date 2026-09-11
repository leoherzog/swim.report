// test/helpers/d1.js — a D1 binding fake backed by real in-memory SQLite, so a
// statement the engine would reject fails in the test rather than in production.
// It exposes the surface src/ uses: prepare().bind().all()/first()/run() and
// batch(), with D1's result shapes and D1's all-or-nothing batch.
//
// Imports node:sqlite unguarded: the repo's Node ships it, and a skip guard
// would hide the suite instead of failing it.
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "./migrations.js";

// Fixtures pass the flag-worthy gate unless they say otherwise; a fixture that
// names water_class, including as null, is respected.
const DEFAULT_WATER_CLASS = "great_lake";

// SQLite binds only null, numbers, strings, bigints and buffers. undefined is
// D1's "no value" and booleans arrive from JS callers, so both are coerced here
// rather than throwing mid-statement.
function bindable(value) {
  if (value === undefined) {
    return null;
  }
  if (value === true) {
    return 1;
  }
  if (value === false) {
    return 0;
  }
  return value;
}

function plainRow(row) {
  return row === undefined || row === null ? null : Object.assign({}, row);
}

function isSelect(sql) {
  return /^\s*(select|pragma|with)\b/i.test(sql);
}

export function makeD1(options) {
  const opts = options || {};
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);

  const statements = [];
  const batchCalls = [];
  const failures = [];

  const beachColumns = sqlite.prepare("PRAGMA table_info(beaches)").all()
    .map(function (c) { return c.name; });

  function shouldFail(sql, args) {
    for (const predicate of failures) {
      if (predicate(sql, args)) {
        return true;
      }
    }
    return false;
  }

  // Executes one statement and returns D1's shape for it. changes() reports the
  // statement just run, so a SELECT reports 0 rather than the last write's count.
  function execute(sql, args) {
    const bound = args.map(bindable);
    const prepared = sqlite.prepare(sql);
    const results = prepared.all.apply(prepared, bound).map(plainRow);
    const changes = isSelect(sql)
      ? 0
      : Number(sqlite.prepare("SELECT changes() AS c").get().c);
    return {
      results: results,
      success: true,
      meta: { changes: changes, rows_read: results.length, rows_written: changes }
    };
  }

  // Recorded entries stay exactly { sql, args }; the bound flag is non-enumerable
  // so an assertion can compare a recorded statement whole.
  function newEntry(sql, args) {
    const entry = { sql: sql, args: args };
    Object.defineProperty(entry, "bound", { value: false, writable: true, enumerable: false });
    return entry;
  }

  function makeStatement(entry) {
    return {
      sql: entry.sql,
      get args() {
        return entry.args;
      },
      bind: function () {
        const args = Array.prototype.slice.call(arguments);
        if (entry.bound) {
          const next = newEntry(entry.sql, args);
          next.bound = true;
          statements.push(next);
          return makeStatement(next);
        }
        entry.args = args;
        entry.bound = true;
        return makeStatement(entry);
      },
      all: async function () {
        if (shouldFail(entry.sql, entry.args)) {
          throw new Error("D1 fake: forced failure for " + entry.sql);
        }
        return execute(entry.sql, entry.args);
      },
      first: async function (column) {
        if (shouldFail(entry.sql, entry.args)) {
          throw new Error("D1 fake: forced failure for " + entry.sql);
        }
        const bound = entry.args.map(bindable);
        const prepared = sqlite.prepare(entry.sql);
        const row = plainRow(prepared.get.apply(prepared, bound));
        if (column === undefined || row === null) {
          return row;
        }
        return row[column] === undefined ? null : row[column];
      },
      run: async function () {
        if (shouldFail(entry.sql, entry.args)) {
          throw new Error("D1 fake: forced failure for " + entry.sql);
        }
        const out = execute(entry.sql, entry.args);
        return { success: true, meta: out.meta };
      }
    };
  }

  const env = {
    sqlite: sqlite,
    statements: statements,
    batchCalls: batchCalls,

    prepare: function (sql) {
      const entry = newEntry(sql, []);
      statements.push(entry);
      return makeStatement(entry);
    },

    // All or nothing, as D1 is: one matching predicate rejects the whole batch
    // and nothing it contained is applied.
    batch: async function (stmts) {
      batchCalls.push(stmts);
      for (const stmt of stmts) {
        if (shouldFail(stmt.sql, stmt.args)) {
          throw new Error("D1 fake: forced batch failure for " + stmt.sql);
        }
      }
      sqlite.exec("BEGIN");
      const out = [];
      try {
        for (const stmt of stmts) {
          out.push(execute(stmt.sql, stmt.args));
        }
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
      sqlite.exec("COMMIT");
      return out;
    },

    // predicate(sql, args) -> true makes that statement, or the batch holding
    // it, reject.
    failWhen: function (predicate) {
      failures.push(predicate);
    },

    seedBeaches: function (rows) {
      for (const row of rows) {
        const cols = [];
        const values = [];
        for (const col of beachColumns) {
          if (Object.prototype.hasOwnProperty.call(row, col)) {
            cols.push(col);
            values.push(bindable(row[col]));
          }
        }
        if (!Object.prototype.hasOwnProperty.call(row, "water_class")) {
          cols.push("water_class");
          values.push(DEFAULT_WATER_CLASS);
        }
        if (!Object.prototype.hasOwnProperty.call(row, "osm_id")) {
          cols.push("osm_id");
          values.push(String(row.id));
        }
        if (!Object.prototype.hasOwnProperty.call(row, "name")) {
          cols.push("name");
          values.push(String(row.id));
        }
        if (!Object.prototype.hasOwnProperty.call(row, "lat")) {
          cols.push("lat");
          values.push(0);
        }
        if (!Object.prototype.hasOwnProperty.call(row, "lon")) {
          cols.push("lon");
          values.push(0);
        }
        const placeholders = cols.map(function (c, i) { return "?" + String(i + 1); });
        const insert = sqlite.prepare(
          "INSERT INTO beaches (" + cols.join(", ") + ") VALUES (" +
          placeholders.join(", ") + ")"
        );
        insert.run.apply(insert, values);
      }
    },

    // fields are beach_state column names; an object value is stored as JSON.
    seedState: function (beachId, fields) {
      const cols = ["beach_id"];
      const values = [beachId];
      for (const key of Object.keys(fields || {})) {
        const value = fields[key];
        cols.push(key);
        values.push(value !== null && typeof value === "object"
          ? JSON.stringify(value)
          : bindable(value));
      }
      const placeholders = cols.map(function (c, i) { return "?" + String(i + 1); });
      const insert = sqlite.prepare(
        "INSERT OR REPLACE INTO beach_state (" + cols.join(", ") + ") VALUES (" +
        placeholders.join(", ") + ")"
      );
      insert.run.apply(insert, values);
    },

    // Seeds one beach's wave record with a live lease. expiresEpoch defaults to a
    // series lease measured from the record's own startIso, matching the offline
    // writer; pass it explicitly to age the record out. Merges into the row's
    // existing columns, because seedState replaces the whole row.
    seedWave: function (beachId, record, expiresEpoch) {
      const existing = env.stateOf(beachId) || {};
      const startMs = record && typeof record.startIso === "string"
        ? Date.parse(record.startIso)
        : NaN;
      const fallback = Number.isFinite(startMs)
        ? Math.floor(startMs / 1000) + 86400
        : Math.floor(Date.now() / 1000) + 86400;
      const fields = Object.assign({}, existing, {
        wave: record,
        wave_expires: expiresEpoch === undefined ? fallback : expiresEpoch
      });
      delete fields.beach_id;
      env.seedState(beachId, fields);
    },

    stateOf: function (beachId) {
      return plainRow(
        sqlite.prepare("SELECT * FROM beach_state WHERE beach_id = ?1").get(beachId)
      );
    },

    close: function () {
      sqlite.close();
    }
  };

  if (Array.isArray(opts.beaches)) {
    env.seedBeaches(opts.beaches);
  }
  return env;
}
