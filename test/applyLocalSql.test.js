// Tests for scripts/apply-local-sql.js — the local-D1 chunked applier that
// keeps 'npm run seed' under workerd's 100,000-byte single-SQL-call cap
// (SQLITE_TOOBIG). The script has no exports and runs on import, so it is
// exercised as a child process via spawnSync. The 'npx wrangler d1 execute'
// calls are intercepted by placing a fake 'npx' executable at the front of
// PATH that copies each chunk file into a capture directory (the script
// deletes its temp chunk files afterwards, so capture must happen inside the
// fake). Splitting is on line boundaries only — the batch emits exactly one
// statement per line — so no statement may ever be torn mid-line.

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "apply-local-sql.js");
const CHUNK_MAX_BYTES = 90000;

const tempDirs = [];

function makeTempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), "apply-local-sql-test-" + label + "-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(function () {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

// Runs the script as a child process. When fakeBinDir is given it is
// prepended to PATH so the script's spawnSync("npx", ...) resolves to the
// fake instead of the real npx.
function runScript(args, fakeBinDir, captureDir) {
  const env = Object.assign({}, process.env);
  if (fakeBinDir) {
    env.PATH = fakeBinDir + ":" + (process.env.PATH || "");
  }
  if (captureDir) {
    env.CAPTURE_DIR = captureDir;
  }
  return spawnSync(process.execPath, [SCRIPT].concat(args), {
    cwd: REPO_ROOT,
    env: env,
    encoding: "utf8"
  });
}

// Writes a fake 'npx' executable into a fresh bin dir. The fake copies its
// --file argument (argv position 7 of the fixed wrangler invocation) into
// CAPTURE_DIR and logs the full argument list, then exits with exitCode.
function makeFakeNpx(exitCode) {
  const binDir = makeTempDir("bin");
  const script =
    "#!/bin/sh\n" +
    'if [ -n "$CAPTURE_DIR" ]; then\n' +
    '  cp "$7" "$CAPTURE_DIR/" 2>/dev/null\n' +
    "  printf '%s\\n' \"$*\" >> \"$CAPTURE_DIR/invocations.txt\"\n" +
    "fi\n" +
    "exit " + String(exitCode) + "\n";
  writeFileSync(join(binDir, "npx"), script, { mode: 0o755 });
  return binDir;
}

// Builds a .sql body of 'count' single-statement lines, each exactly
// 'lineLength' bytes before its newline (ASCII only, so bytes === chars).
function buildSqlLines(count, lineLength) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const prefix = "INSERT INTO beaches (id) VALUES ('b" + String(i) + "'); --";
    let line = prefix;
    while (line.length < lineLength) {
      line += "x";
    }
    lines.push(line);
  }
  return lines;
}

describe("apply-local-sql argument and input validation", function () {
  it("exits 1 with a usage message when no file argument is given", function () {
    const result = runScript([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("usage:");
  });

  it("exits 1 with a cannot-read message for a nonexistent file", function () {
    const missing = join(makeTempDir("missing"), "no-such-file.sql");
    const result = runScript([missing]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("cannot read");
    expect(result.stdout).toContain("no-such-file.sql");
  });

  it("exits 1 when a single line exceeds the chunk byte cap", function () {
    const dir = makeTempDir("bigline");
    const sqlPath = join(dir, "delta.sql");
    let big = "INSERT INTO beaches (id) VALUES ('";
    while (Buffer.byteLength(big, "utf8") <= CHUNK_MAX_BYTES) {
      big += "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    }
    big += "');";
    writeFileSync(sqlPath, big + "\n");
    const result = runScript([sqlPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("single line exceeds");
  });
});

describe("apply-local-sql chunk splitting", function () {
  it("splits a large delta into <=90000-byte line-aligned chunks that reassemble the input", function () {
    // 2500 lines of exactly 99 bytes + newline = 100 bytes per line,
    // 250,000 bytes total. floor(90000 / 100) = 900 lines per chunk, so the
    // script must emit ceil(2500 / 900) = 3 chunks (900 + 900 + 700 lines).
    const lines = buildSqlLines(2500, 99);
    const inputText = lines.join("\n") + "\n";
    const dir = makeTempDir("input");
    const sqlPath = join(dir, "delta.sql");
    writeFileSync(sqlPath, inputText);

    const captureDir = join(makeTempDir("capture"), "chunks");
    mkdirSync(captureDir);
    const binDir = makeFakeNpx(0);

    const result = runScript([sqlPath], binDir, captureDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("in 3 chunk(s)");
    expect(result.stdout).toContain("chunk 3/3 applied");
    expect(result.stdout).toContain("apply-local-sql: done");

    const captured = readdirSync(captureDir)
      .filter(function (name) { return name.indexOf("chunk-") === 0; })
      .sort(function (a, b) {
        const ai = parseInt(a.replace("chunk-", ""), 10);
        const bi = parseInt(b.replace("chunk-", ""), 10);
        return ai - bi;
      });
    expect(captured).toEqual(["chunk-0.sql", "chunk-1.sql", "chunk-2.sql"]);

    let reassembled = "";
    for (const name of captured) {
      const chunk = readFileSync(join(captureDir, name), "utf8");
      // Under the SQLITE_TOOBIG margin.
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(CHUNK_MAX_BYTES);
      // Line-aligned: every chunk ends with a complete line.
      expect(chunk.endsWith("\n")).toBe(true);
      // No statement torn mid-line: every non-empty chunk line is one of the
      // original full statement lines.
      const chunkLines = chunk.split("\n");
      for (const chunkLine of chunkLines) {
        if (chunkLine !== "") {
          expect(chunkLine.length).toBe(99);
          expect(chunkLine.indexOf("INSERT INTO beaches")).toBe(0);
        }
      }
      reassembled += chunk;
    }

    // Real reassembly behavior: the trailing-newline input splits into a
    // final empty line, and the script appends "\n" to every chunk, so the
    // concatenation is the input plus exactly one extra trailing newline —
    // every statement byte-for-byte intact and in order.
    expect(reassembled).toBe(inputText + "\n");
    const reassembledStatements = reassembled.split("\n").filter(function (l) { return l !== ""; });
    expect(reassembledStatements).toEqual(lines);
  });

  it("applies a small delta in one chunk and passes the db name to wrangler", function () {
    const inputText = "INSERT INTO beaches (id) VALUES ('one');\nINSERT INTO beaches (id) VALUES ('two');\n";
    const dir = makeTempDir("small");
    const sqlPath = join(dir, "delta.sql");
    writeFileSync(sqlPath, inputText);

    const captureDir = join(makeTempDir("capture"), "chunks");
    mkdirSync(captureDir);
    const binDir = makeFakeNpx(0);

    const result = runScript([sqlPath, "custom-db"], binDir, captureDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("in 1 chunk(s)");
    expect(result.stdout).toContain("local D1 'custom-db'");

    const invocations = readFileSync(join(captureDir, "invocations.txt"), "utf8")
      .split("\n")
      .filter(function (l) { return l !== ""; });
    expect(invocations.length).toBe(1);
    expect(invocations[0].indexOf("wrangler d1 execute custom-db --local --file ")).toBe(0);

    const chunk = readFileSync(join(captureDir, "chunk-0.sql"), "utf8");
    expect(chunk).toBe(inputText + "\n");
  });

  it("defaults the db name to swim-report when none is given", function () {
    const dir = makeTempDir("defaultdb");
    const sqlPath = join(dir, "delta.sql");
    writeFileSync(sqlPath, "SELECT 1;\n");

    const captureDir = join(makeTempDir("capture"), "chunks");
    mkdirSync(captureDir);
    const binDir = makeFakeNpx(0);

    const result = runScript([sqlPath], binDir, captureDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("local D1 'swim-report'");

    const invocations = readFileSync(join(captureDir, "invocations.txt"), "utf8")
      .split("\n")
      .filter(function (l) { return l !== ""; });
    expect(invocations[0].indexOf("wrangler d1 execute swim-report --local --file ")).toBe(0);
  });
});

describe("apply-local-sql wrangler failure handling", function () {
  it("exits 1 and reports which chunk failed when wrangler exits nonzero", function () {
    const dir = makeTempDir("fail");
    const sqlPath = join(dir, "delta.sql");
    writeFileSync(sqlPath, "INSERT INTO beaches (id) VALUES ('one');\n");

    const captureDir = join(makeTempDir("capture"), "chunks");
    mkdirSync(captureDir);
    const binDir = makeFakeNpx(1);

    const result = runScript([sqlPath], binDir, captureDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("chunk 1/1 failed (exit 1)");
    expect(result.stdout).toContain("re-run after fixing");
    expect(result.stdout).not.toContain("apply-local-sql: done");
  });
});
