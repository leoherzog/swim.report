// scripts/apply-local-sql.js — apply a large .sql delta to the LOCAL D1 in
// chunks (node scripts/apply-local-sql.js <delta.sql> [db-name]).
//
// WHY: `wrangler d1 execute --local --file <f>` hands the WHOLE file to
// miniflare/workerd, whose SQLite build caps a single SQL call at 100,000
// bytes — a file over that fails with "statement too long: SQLITE_TOOBIG"
// even when every individual statement is tiny (verified on wrangler 4.112.0:
// a 98.6 KB file applies, a 100.5 KB file fails). A full discovery delta is
// ~700 KB, so `npm run seed` cannot apply .seed.sql in one call. The REMOTE
// path is unaffected (wrangler --remote --file uploads through the D1 import
// API, which ingests server-side), so the GitHub Actions workflows keep their
// single-file apply; only local dev needs this splitter.
//
// The batch emits exactly one statement per line (scripts/discovery-batch.js),
// so splitting on line boundaries can never tear a statement. Chunks stay
// under CHUNK_MAX_BYTES (margin below the 100,000-byte cap) and each one is
// applied with its own `npx wrangler d1 execute --local --file` call. The
// delta is idempotent, so a failure partway can simply be re-run.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const CHUNK_MAX_BYTES = 90000;

function fail(message) {
  console.log("apply-local-sql: " + message);
  process.exit(1);
}

const file = process.argv[2];
const dbName = process.argv[3] || "swim-report";
if (!file) {
  fail("usage: node scripts/apply-local-sql.js <delta.sql> [db-name]");
}

let text;
try {
  text = readFileSync(file, "utf8");
} catch (err) {
  fail("cannot read " + file + ": " + err.message);
}

const lines = text.split("\n");
const chunks = [];
let current = [];
let currentBytes = 0;
for (const line of lines) {
  const lineBytes = Buffer.byteLength(line, "utf8") + 1;
  if (lineBytes > CHUNK_MAX_BYTES) {
    fail("single line exceeds " + String(CHUNK_MAX_BYTES) + " bytes — cannot split on line boundaries");
  }
  if (currentBytes + lineBytes > CHUNK_MAX_BYTES && current.length > 0) {
    chunks.push(current.join("\n") + "\n");
    current = [];
    currentBytes = 0;
  }
  current.push(line);
  currentBytes += lineBytes;
}
if (current.length > 0) {
  chunks.push(current.join("\n") + "\n");
}

console.log("apply-local-sql: applying " + file + " to local D1 '" + dbName + "' in " + String(chunks.length) + " chunk(s)");

const dir = mkdtempSync(join(tmpdir(), "apply-local-sql-"));
try {
  for (let i = 0; i < chunks.length; i++) {
    const chunkPath = join(dir, "chunk-" + String(i) + ".sql");
    writeFileSync(chunkPath, chunks[i]);
    const result = spawnSync("npx", ["wrangler", "d1", "execute", dbName, "--local", "--file", chunkPath], {
      stdio: ["ignore", "ignore", "inherit"]
    });
    if (result.status !== 0) {
      fail("chunk " + String(i + 1) + "/" + String(chunks.length) + " failed (exit " + String(result.status) + ") — the delta is idempotent, re-run after fixing");
    }
    console.log("apply-local-sql: chunk " + String(i + 1) + "/" + String(chunks.length) + " applied");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("apply-local-sql: done");
