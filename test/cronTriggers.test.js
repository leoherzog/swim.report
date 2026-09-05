// Guards that wrangler.toml's crons array and the CRON_JOBS dispatch table in
// src/index.js name the same trigger set.
//
// Nothing else catches a mismatch. A cron in wrangler.toml with no CRON_JOBS
// entry fires, logs "index: scheduled invoked with unknown cron" and silently
// does nothing; a CRON_JOBS entry with no wrangler.toml trigger never fires at
// all. Both read as "the job just stopped running".
//
// Read as text rather than through an import: wrangler.toml is not a module, and
// CRON_JOBS is deliberately module-private (test/workerExports.test.js).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const WRANGLER = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const INDEX = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

function wranglerCrons() {
  const match = WRANGLER.match(/\ncrons\s*=\s*\[([^\]]*)\]/);
  expect(match).not.toBe(null);
  const found = match[1].match(/"([^"]+)"/g) || [];
  return found.map(function (quoted) { return quoted.slice(1, -1); });
}

function cronJobKeys() {
  const start = INDEX.indexOf("const CRON_JOBS = {");
  expect(start).toBeGreaterThan(-1);
  const end = INDEX.indexOf("\n};", start);
  expect(end).toBeGreaterThan(start);
  const body = INDEX.slice(start, end);
  const found = body.match(/"([^"]+)":\s*\{\s*run:/g) || [];
  return found.map(function (entry) { return entry.slice(1, entry.indexOf("\":")); });
}

describe("cron trigger agreement", function () {
  it("finds a non-empty trigger set on both sides", function () {
    expect(wranglerCrons().length).toBeGreaterThan(0);
    expect(cronJobKeys().length).toBe(wranglerCrons().length);
  });

  it("names the same crons in wrangler.toml and CRON_JOBS", function () {
    const scheduled = wranglerCrons().slice().sort();
    const dispatched = cronJobKeys().slice().sort();
    expect(dispatched).toEqual(scheduled);
  });

  it("keeps the hourly flag recompute in both", function () {
    expect(wranglerCrons()).toContain("7 * * * *");
    expect(cronJobKeys()).toContain("7 * * * *");
  });

  it("keeps the alerts refresh in both", function () {
    expect(wranglerCrons()).toContain("3-53/10 * * * *");
    expect(cronJobKeys()).toContain("3-53/10 * * * *");
  });
});
