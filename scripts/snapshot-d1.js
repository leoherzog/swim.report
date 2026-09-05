// scripts/snapshot-d1.js — page a D1 table into one snapshot file through
// `wrangler d1 execute --json`, keyed on the `id` primary key, and refuse to
// write anything unless the assembled row count equals SELECT COUNT(*) under the
// same predicate. Both offline workflows read their table view through this one
// script, so there is exactly one spelling of the snapshot contract.
//
//   node scripts/snapshot-d1.js --db <name> --remote|--local \
//     --columns "id, lat, lon" [--where "<predicate>"] [--require-where] \
//     --out <file> [--page 5000] [--wrangler-version 4] [--token-hint <SECRET_NAME>]
//
// D1's --json response is size-capped, so a single-shot SELECT over a grown table
// silently truncates; that is what the paging exists for. Pages are keyset
// (`id > <last id> ORDER BY id`), never LIMIT/OFFSET: an insert plus a delete
// between two OFFSET pages leaves the total unchanged while one row is emitted
// twice and another never, and the count guard cannot see that. A keyset walk
// over the primary key cannot duplicate a row, and any id that fails to ascend
// across pages aborts the run.
//
// The output is [{ results: [...] }], the shape `wrangler d1 execute --json`
// emits for a single statement, so every existing --snapshot reader accepts it.

import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_PAGE = 5000;
const DEFAULT_WRANGLER_VERSION = "4";
// A 5000-row page of the widest snapshot is well under 8 MB; this is headroom,
// not a budget.
const SPAWN_MAX_BUFFER = 64 * 1024 * 1024;

export function parseArgs(argv) {
  const args = {
    db: null,
    mode: null,
    columns: null,
    where: "",
    requireWhere: false,
    out: null,
    page: DEFAULT_PAGE,
    wranglerVersion: DEFAULT_WRANGLER_VERSION,
    tokenHint: null
  };
  for (let i = 0; i < argv.length; i = i + 1) {
    const a = argv[i];
    if (a === "--db") { args.db = argv[++i]; }
    else if (a === "--remote") { args.mode = "--remote"; }
    else if (a === "--local") { args.mode = "--local"; }
    else if (a === "--columns") { args.columns = argv[++i]; }
    else if (a === "--where") { args.where = argv[++i]; }
    else if (a === "--require-where") { args.requireWhere = true; }
    else if (a === "--out") { args.out = argv[++i]; }
    else if (a === "--page") { args.page = Number(argv[++i]); }
    else if (a === "--wrangler-version") { args.wranglerVersion = argv[++i]; }
    else if (a === "--token-hint") { args.tokenHint = argv[++i]; }
    else { throw new Error("unknown argument " + a); }
  }
  return args;
}

// Throws on anything that would make the walk unsound: no id column to key on,
// a non-positive page, or a missing predicate when the caller declared one
// mandatory (a guard that compares a predicate against itself passes an empty
// one, so the refusal has to happen here).
export function validateArgs(args) {
  if (!args.db) { throw new Error("--db is required"); }
  if (args.mode !== "--remote" && args.mode !== "--local") {
    throw new Error("exactly one of --remote or --local is required");
  }
  if (!args.columns || args.columns.trim() === "") { throw new Error("--columns is required"); }
  const cols = args.columns.split(",").map(function (c) { return c.trim(); });
  if (cols.indexOf("id") < 0) { throw new Error("--columns must include id, the keyset column"); }
  if (!args.out) { throw new Error("--out is required"); }
  if (!Number.isInteger(args.page) || args.page <= 0) { throw new Error("--page must be a positive integer"); }
  const where = typeof args.where === "string" ? args.where.trim() : "";
  if (args.requireWhere && where === "") {
    throw new Error("--require-where was given and the predicate is empty; refusing an unbounded snapshot");
  }
}

// SQL string literal with embedded single quotes doubled. wrangler --command has
// no bind parameters, so the keyset cursor is inlined.
export function sqlLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// Page query. afterId null means the first page.
export function buildPageSql(table, columns, where, afterId, page) {
  const clauses = [];
  const w = typeof where === "string" ? where.trim() : "";
  if (w !== "") { clauses.push("(" + w + ")"); }
  if (afterId !== null && afterId !== undefined) { clauses.push("id > " + sqlLiteral(afterId)); }
  let sql = "SELECT " + columns + " FROM " + table;
  if (clauses.length > 0) { sql = sql + " WHERE " + clauses.join(" AND "); }
  return sql + " ORDER BY id LIMIT " + String(page);
}

export function buildCountSql(table, where) {
  const w = typeof where === "string" ? where.trim() : "";
  let sql = "SELECT COUNT(*) AS n FROM " + table;
  if (w !== "") { sql = sql + " WHERE (" + w + ")"; }
  return sql;
}

// Rows out of one `wrangler d1 execute --json` document, or a throw naming the
// shape when it is not the single-statement envelope.
export function rowsFromWranglerJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error("wrangler output is not JSON: " + err.message);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || !Array.isArray(parsed[0].results)) {
    throw new Error("wrangler output is not a single [{ results }] envelope");
  }
  return parsed[0].results;
}

// Walks the table and returns { rows, total, pages }. runQuery(sql) must return
// the rows for one statement or throw. Throws on a count mismatch, a
// non-ascending id, or a row without a string id, and writes nothing itself.
export async function snapshotRows(runQuery, opts) {
  const table = opts.table || "beaches";
  const where = opts.where || "";
  const page = opts.page || DEFAULT_PAGE;
  const log = opts.log || function () {};
  const rows = [];
  let afterId = null;
  let pages = 0;
  for (;;) {
    const got = await runQuery(buildPageSql(table, opts.columns, where, afterId, page));
    pages = pages + 1;
    for (let i = 0; i < got.length; i = i + 1) {
      const id = got[i].id;
      if (typeof id !== "string" || id === "") {
        throw new Error("row without a string id on page " + String(pages));
      }
      if (afterId !== null && !(id > afterId)) {
        throw new Error("id " + id + " did not ascend past " + afterId + " on page " + String(pages));
      }
      afterId = id;
      rows.push(got[i]);
    }
    log("page " + String(pages) + ": " + String(got.length) + " row(s)");
    if (got.length < page) { break; }
  }
  const countRows = await runQuery(buildCountSql(table, where));
  const total = countRows.length === 1 && countRows[0] ? Number(countRows[0].n) : NaN;
  if (!Number.isInteger(total)) {
    throw new Error("count query did not return a single integer n");
  }
  if (rows.length !== total) {
    throw new Error("snapshot truncated (" + String(rows.length) + " of " + String(total) + " rows)");
  }
  return { rows: rows, total: total, pages: pages };
}

function makeWranglerRunner(args) {
  return function (sql) {
    const argv = [
      "--yes", "wrangler@" + args.wranglerVersion, "d1", "execute", args.db,
      args.mode, "--json", "--command", sql
    ];
    const res = spawnSync("npx", argv, { encoding: "utf8", maxBuffer: SPAWN_MAX_BUFFER });
    // --json writes API errors to stdout, so show it on failure or the step
    // fails with a blank log.
    if (res.error) {
      throw new Error("wrangler could not be spawned: " + res.error.message);
    }
    if (res.status !== 0) {
      const hint = args.tokenHint ? " (likely a bad " + args.tokenHint + " secret)" : "";
      throw new Error("wrangler snapshot query failed" + hint + "\n" + (res.stdout || "") + (res.stderr || ""));
    }
    return rowsFromWranglerJson(res.stdout);
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    validateArgs(args);
  } catch (err) {
    console.log("snapshot-d1: " + err.message);
    process.exit(2);
  }
  if (args.where.trim() !== "") {
    console.log("snapshot-d1: predicate: " + args.where.trim());
  }
  let result;
  try {
    result = await snapshotRows(makeWranglerRunner(args), {
      table: "beaches",
      columns: args.columns,
      where: args.where,
      page: args.page,
      log: function (line) { console.log("snapshot-d1: " + line); }
    });
  } catch (err) {
    console.log("::error::snapshot-d1: " + err.message);
    process.exit(1);
  }
  const body = JSON.stringify([{ results: result.rows }]);
  writeFileSync(args.out, body);
  console.log("snapshot-d1: rows " + String(result.rows.length) + " / db rows " + String(result.total) +
    ", " + String(result.pages) + " page(s), " + String(Buffer.byteLength(body)) + " bytes -> " + args.out);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
