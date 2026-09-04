// scripts/apply-local-sql.js — apply a large .sql delta to the local D1 in
// chunks (node scripts/apply-local-sql.js <delta.sql> [db-name]).
//
// `wrangler d1 execute --local --file <f>` hands the whole file to
// miniflare/workerd as one SQL call, which its SQLite build caps at 100,000
// bytes: a larger file fails with "statement too long: SQLITE_TOOBIG" even when
// every individual statement is tiny. A full discovery delta is several hundred
// KB. The --remote path uploads through the D1 import API and is unaffected, so
// only local dev needs this splitter.
//
// scripts/discovery-batch.js emits exactly one statement per line, so splitting
// on line boundaries can never tear a statement. Chunks stay under
// CHUNK_MAX_BYTES and each is applied with its own wrangler call; the delta is
// idempotent, so a failure partway can be re-run.

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
