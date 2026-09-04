// scripts/print-flag-worthy-sql.js — prints FLAG_WORTHY_WATER_SQL from
// src/waterClass.js so a shell WHERE clause and the request path can never
// spell the hide-until-flag-worthy gate differently.
//
// Run on Deno with read permission only:
//
//   FLAG_WORTHY=$(deno run --allow-read scripts/print-flag-worthy-sql.js)
//   wrangler d1 execute ... --command "SELECT id FROM beaches WHERE $FLAG_WORTHY"
//
// The predicate is interpolated into a double-quoted shell string, so the output
// carries no double quote and no newline. WATER_CLASS_MAX_ATTEMPTS reaches the
// clause through the constant, never as a second literal 5: a bump that moved
// the request path while leaving a workflow behind would silently sample a
// population the site does not serve.

import { FLAG_WORTHY_WATER_SQL } from "../src/waterClass.js";

// The whole program as one pure function, so the tests exercise what the CLI
// prints. Returns the stdout text without a trailing newline.
export function renderOutput(sql) {
  const text = sql === undefined ? FLAG_WORTHY_WATER_SQL : sql;
  if (typeof text !== "string" || text === "") {
    throw new Error("print-flag-worthy-sql: the predicate is not a non-empty string");
  }
  // Either character would terminate the shell string the predicate is
  // interpolated into and leave a WHERE clause nobody wrote.
  if (text.indexOf("\"") !== -1 || text.indexOf("\n") !== -1) {
    throw new Error("print-flag-worthy-sql: the predicate carries a double quote or a newline");
  }
  return text;
}

// No options: a call site passing an argument believes it can ask for something
// else, and printing the predicate anyway would hand it a clause it did not
// request.
export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  if (list.length > 0) {
    throw new Error("unknown argument: " + String(list[0]));
  }
  return {};
}

if (import.meta.main) {
  parseArgs(Deno.args);
  console.log(renderOutput());
}
