// scripts/print-flag-worthy-sql.js — prints FLAG_WORTHY_WATER_SQL from
// src/waterClass.js so a shell WHERE clause and the request path can never
// spell the hide-until-flag-worthy gate differently.
//
// Run on Deno with read permission only (it touches no network and writes no
// files):
//
//   FLAG_WORTHY=$(deno run --allow-read scripts/print-flag-worthy-sql.js)
//   wrangler d1 execute ... --command "SELECT id FROM beaches WHERE $FLAG_WORTHY"
//
// The predicate is interpolated into a DOUBLE-QUOTED shell string, so the output
// carries no double quote and no newline. WATER_CLASS_MAX_ATTEMPTS reaches the
// clause through the constant, never as a second literal 5: a bump that moved the
// request path while leaving a workflow behind would silently sample a population
// the site does not serve.
//
// Project style: plain JS, ES modules, const/let only, string concatenation
// with + (never template literals), console for logging.

import { FLAG_WORTHY_WATER_SQL } from "../src/waterClass.js";

// The whole program as one pure function, so the tests exercise what the CLI
// actually prints. Returns the complete stdout text WITHOUT a trailing newline
// (main adds it via console.log).
export function renderOutput(sql) {
  const text = sql === undefined ? FLAG_WORTHY_WATER_SQL : sql;
  if (typeof text !== "string" || text === "") {
    throw new Error("print-flag-worthy-sql: the predicate is not a non-empty string");
  }
  // A predicate carrying either character would terminate the shell string it is
  // interpolated into and leave a WHERE clause nobody wrote.
  if (text.indexOf("\"") !== -1 || text.indexOf("\n") !== -1) {
    throw new Error("print-flag-worthy-sql: the predicate carries a double quote or a newline");
  }
  return text;
}

// This script takes no options: anything on the command line is a call site that
// believes it can ask for something else, and printing the predicate anyway would
// hand it a clause it did not request.
export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  if (list.length > 0) {
    throw new Error("unknown argument: " + String(list[0]));
  }
  return {};
}

// import.meta.main is Deno-only and falsy under vitest/node, so importing the
// pure exports above never reads Deno.args and never prints anything.
if (import.meta.main) {
  parseArgs(Deno.args);
  console.log(renderOutput());
}
