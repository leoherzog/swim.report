// Tests for scripts/snapshot-d1.js — the shared keyset-paginated D1 snapshot both
// offline workflows read through. The walk is exercised in-process against a fake
// table; the wrangler wiring is exercised as a child process with a fake npx on
// PATH that answers the count query and the page queries from a fixture.

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArgs,
  validateArgs,
  sqlLiteral,
  buildPageSql,
  buildCountSql,
  rowsFromWranglerJson,
  snapshotRows
} from "../scripts/snapshot-d1.js";

const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "snapshot-d1.js");

const tempDirs = [];
function makeTempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-d1-test-" + label + "-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(function () {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

// A fake table that answers the SQL the walk builds: it parses the id cursor and
// LIMIT back out of the statement, so the walk is tested against the statements
// it really emits.
function fakeTable(ids, hooks) {
  const calls = [];
  const rows = ids.slice().sort().map(function (id) { return { id: id, lat: 1, lon: 2 }; });
  return {
    calls: calls,
    runQuery: async function (sql) {
      calls.push(sql);
      if (sql.indexOf("SELECT COUNT(*)") === 0) {
        const n = hooks && typeof hooks.count === "number" ? hooks.count : rows.length;
        return [{ n: n }];
      }
      const limit = Number(/LIMIT (\d+)$/.exec(sql)[1]);
      const cursorMatch = /id > '((?:[^']|'')*)'/.exec(sql);
      const after = cursorMatch ? cursorMatch[1].replace(/''/g, "'") : null;
      let out = rows.filter(function (r) { return after === null || r.id > after; }).slice(0, limit);
      if (hooks && hooks.mutate) { out = hooks.mutate(out, calls.length); }
      return out;
    }
  };
}

describe("snapshot-d1 SQL builders", function () {
  it("doubles single quotes in the keyset literal", function () {
    expect(sqlLiteral("o'brien")).toBe("'o''brien'");
  });

  it("builds the first page without a cursor and later pages with one", function () {
    expect(buildPageSql("beaches", "id, lat", "", null, 10)).toBe(
      "SELECT id, lat FROM beaches ORDER BY id LIMIT 10");
    expect(buildPageSql("beaches", "id, lat", "water_class = 'ocean'", "b'2", 10)).toBe(
      "SELECT id, lat FROM beaches WHERE (water_class = 'ocean') AND id > 'b''2' ORDER BY id LIMIT 10");
  });

  it("puts the same predicate on the count query", function () {
    expect(buildCountSql("beaches", "")).toBe("SELECT COUNT(*) AS n FROM beaches");
    expect(buildCountSql("beaches", " x = 1 ")).toBe("SELECT COUNT(*) AS n FROM beaches WHERE (x = 1)");
  });

  it("accepts only the single-statement wrangler envelope", function () {
    expect(rowsFromWranglerJson('[{"results":[{"id":"a"}],"success":true}]')).toEqual([{ id: "a" }]);
    expect(function () { rowsFromWranglerJson("not json"); }).toThrow(/not JSON/);
    expect(function () { rowsFromWranglerJson('{"results":[]}'); }).toThrow(/envelope/);
    expect(function () { rowsFromWranglerJson("[]"); }).toThrow(/envelope/);
  });
});

describe("snapshot-d1 argument validation", function () {
  const good = ["--db", "swim-report", "--remote", "--columns", "id, lat", "--out", "s.json"];

  it("parses the documented flags", function () {
    const args = parseArgs(good.concat(["--where", "x = 1", "--page", "7", "--require-where"]));
    expect(args.db).toBe("swim-report");
    expect(args.mode).toBe("--remote");
    expect(args.where).toBe("x = 1");
    expect(args.page).toBe(7);
    expect(args.requireWhere).toBe(true);
    expect(function () { validateArgs(args); }).not.toThrow();
  });

  it("requires id among the columns", function () {
    const args = parseArgs(["--db", "d", "--remote", "--columns", "lat, lon", "--out", "s.json"]);
    expect(function () { validateArgs(args); }).toThrow(/include id/);
  });

  it("requires exactly one of --remote or --local", function () {
    const args = parseArgs(["--db", "d", "--columns", "id", "--out", "s.json"]);
    expect(function () { validateArgs(args); }).toThrow(/--remote or --local/);
  });

  it("refuses an empty predicate under --require-where", function () {
    const args = parseArgs(good.concat(["--require-where", "--where", "  "]));
    expect(function () { validateArgs(args); }).toThrow(/unbounded/);
  });

  it("rejects an unknown flag", function () {
    expect(function () { parseArgs(["--bogus"]); }).toThrow(/unknown argument/);
  });
});

describe("snapshot-d1 keyset walk", function () {
  it("assembles every row across pages and stops on a short page", async function () {
    const ids = [];
    for (let i = 0; i < 23; i = i + 1) { ids.push("b" + String(100 + i)); }
    const t = fakeTable(ids);
    const res = await snapshotRows(t.runQuery, { columns: "id, lat, lon", page: 10 });
    expect(res.rows.map(function (r) { return r.id; })).toEqual(ids);
    expect(res.total).toBe(23);
    expect(res.pages).toBe(3);
    expect(t.calls[0]).toBe("SELECT id, lat, lon FROM beaches ORDER BY id LIMIT 10");
    expect(t.calls[1]).toBe("SELECT id, lat, lon FROM beaches WHERE id > 'b109' ORDER BY id LIMIT 10");
    expect(t.calls[3]).toBe("SELECT COUNT(*) AS n FROM beaches");
  });

  it("issues exactly one page when the table fits and still runs the count", async function () {
    const t = fakeTable(["a", "b"]);
    const res = await snapshotRows(t.runQuery, { columns: "id", page: 10 });
    expect(res.pages).toBe(1);
    expect(t.calls.length).toBe(2);
  });

  it("carries ids with quotes through the cursor", async function () {
    const t = fakeTable(["o'a", "o'b", "o'c"]);
    const res = await snapshotRows(t.runQuery, { columns: "id", page: 2 });
    expect(res.rows.map(function (r) { return r.id; })).toEqual(["o'a", "o'b", "o'c"]);
    expect(t.calls[1]).toContain("id > 'o''b'");
  });

  it("applies the predicate to both the pages and the count", async function () {
    const t = fakeTable(["a"]);
    await snapshotRows(t.runQuery, { columns: "id", where: "water_class = 'ocean'", page: 5 });
    expect(t.calls[0]).toContain("WHERE (water_class = 'ocean') ORDER BY id");
    expect(t.calls[1]).toBe("SELECT COUNT(*) AS n FROM beaches WHERE (water_class = 'ocean')");
  });

  it("refuses when the assembled rows disagree with the count", async function () {
    const t = fakeTable(["a", "b", "c"], { count: 4 });
    await expect(snapshotRows(t.runQuery, { columns: "id", page: 10 }))
      .rejects.toThrow(/truncated \(3 of 4 rows\)/);
  });

  it("refuses a page whose ids do not ascend past the cursor", async function () {
    const t = fakeTable(["a", "b", "c", "d"], {
      mutate: function (out, call) { return call === 2 ? [{ id: "b" }, { id: "c" }] : out; }
    });
    await expect(snapshotRows(t.runQuery, { columns: "id", page: 2 }))
      .rejects.toThrow(/did not ascend/);
  });

  it("refuses a row without a string id", async function () {
    const t = fakeTable(["a"], { mutate: function () { return [{ id: 7 }]; } });
    await expect(snapshotRows(t.runQuery, { columns: "id", page: 2 }))
      .rejects.toThrow(/without a string id/);
  });
});

describe("snapshot-d1 as a child process", function () {
  // The fake npx logs its argument list and answers from fixed JSON: the count
  // query gets n, every page query gets the page fixture (a short page, so the
  // walk stops after one).
  function makeFakeNpx(pageJson, countN, exitCode) {
    const binDir = makeTempDir("bin");
    const script =
      "#!/bin/sh\n" +
      "printf '%s\\n' \"$*\" >> \"$CAPTURE_DIR/invocations.txt\"\n" +
      "case \"$*\" in\n" +
      "  *\"SELECT COUNT(*)\"*) printf '%s' '[{\"results\":[{\"n\":" + String(countN) + "}],\"success\":true}]' ;;\n" +
      "  *) printf '%s' '" + pageJson + "' ;;\n" +
      "esac\n" +
      "exit " + String(exitCode) + "\n";
    writeFileSync(join(binDir, "npx"), script, { mode: 0o755 });
    return binDir;
  }

  function runScript(args, binDir, captureDir) {
    const env = Object.assign({}, process.env);
    env.PATH = binDir + ":" + (process.env.PATH || "");
    env.CAPTURE_DIR = captureDir;
    return spawnSync(process.execPath, [SCRIPT].concat(args), { cwd: REPO_ROOT, env: env, encoding: "utf8" });
  }

  it("passes the mode, --json and the built statements to wrangler and writes the envelope", function () {
    const capture = makeTempDir("capture");
    const bin = makeFakeNpx('[{"results":[{"id":"x","lat":1}],"success":true}]', 1, 0);
    const out = join(capture, "snapshot.json");
    const res = runScript([
      "--db", "swim-report", "--remote", "--columns", "id, lat",
      "--where", "lat > 0", "--out", out, "--page", "5000", "--wrangler-version", "4"
    ], bin, capture);
    expect(res.status).toBe(0);
    const invocations = readFileSync(join(capture, "invocations.txt"), "utf8").trim().split("\n");
    expect(invocations.length).toBe(2);
    expect(invocations[0]).toContain("--yes wrangler@4 d1 execute swim-report --remote --json --command SELECT id, lat FROM beaches WHERE (lat > 0) ORDER BY id LIMIT 5000");
    expect(invocations[1]).toContain("SELECT COUNT(*) AS n FROM beaches WHERE (lat > 0)");
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([{ results: [{ id: "x", lat: 1 }] }]);
    expect(res.stdout).toContain("rows 1 / db rows 1");
  });

  it("writes nothing and names the token on a wrangler failure", function () {
    const capture = makeTempDir("capture");
    const bin = makeFakeNpx('{"error":"Authentication error"}', 0, 1);
    const out = join(capture, "snapshot.json");
    const res = runScript([
      "--db", "swim-report", "--remote", "--columns", "id", "--out", out,
      "--token-hint", "CLOUDFLARE_D1_EDIT_TOKEN"
    ], bin, capture);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("::error::");
    expect(res.stdout).toContain("CLOUDFLARE_D1_EDIT_TOKEN");
    expect(res.stdout).toContain("Authentication error");
    expect(function () { readFileSync(out); }).toThrow();
  });

  it("writes nothing when the count disagrees", function () {
    const capture = makeTempDir("capture");
    const bin = makeFakeNpx('[{"results":[{"id":"x"}],"success":true}]', 2, 0);
    const out = join(capture, "snapshot.json");
    const res = runScript(["--db", "swim-report", "--remote", "--columns", "id", "--out", out], bin, capture);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("truncated (1 of 2 rows)");
    expect(function () { readFileSync(out); }).toThrow();
  });

  it("exits 2 on a usage error before touching wrangler", function () {
    const capture = makeTempDir("capture");
    const bin = makeFakeNpx("[]", 0, 0);
    const res = runScript(["--db", "swim-report", "--remote", "--columns", "lat", "--out", "x"], bin, capture);
    expect(res.status).toBe(2);
    expect(res.stdout).toContain("include id");
    expect(function () { readFileSync(join(capture, "invocations.txt")); }).toThrow();
  });
});
