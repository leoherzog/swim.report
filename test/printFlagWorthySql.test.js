// Tests for scripts/print-flag-worthy-sql.js — the single source of truth for the
// hide-until-flag-worthy WHERE clause the wave snapshot and the request path share.
//
// The failure this pins is silent by construction: a WATER_CLASS_MAX_ATTEMPTS bump
// that moves src/waterClass.js while a workflow keeps its own literal 5 makes the
// wave lane sample a population the site never serves, with every gate green.

import { describe, it, expect } from "vitest";
import { FLAG_WORTHY_WATER_SQL, WATER_CLASS_MAX_ATTEMPTS } from "../src/waterClass.js";
import { renderOutput, parseArgs } from "../scripts/print-flag-worthy-sql.js";

describe("print-flag-worthy-sql", function () {
  it("prints FLAG_WORTHY_WATER_SQL verbatim", function () {
    expect(renderOutput()).toBe(FLAG_WORTHY_WATER_SQL);
  });

  it("carries the attempts cap through the constant rather than a bare literal",
    function () {
      const printed = renderOutput();
      expect(printed.indexOf("water_class_attempts < " + String(WATER_CLASS_MAX_ATTEMPTS)))
        .not.toBe(-1);
    });

  it("is safe to interpolate into a double-quoted shell string", function () {
    const printed = renderOutput();
    expect(printed.indexOf("\"")).toBe(-1);
    expect(printed.indexOf("\n")).toBe(-1);
    expect(printed.length).toBeGreaterThan(0);
  });

  it("refuses a predicate that would terminate the shell string", function () {
    expect(function () { renderOutput("water_class = \"ocean\""); }).toThrow();
    expect(function () { renderOutput("water_class IS NULL\n"); }).toThrow();
    expect(function () { renderOutput(""); }).toThrow();
  });

  it("throws on any argument rather than printing something unasked for", function () {
    expect(parseArgs([])).toEqual({});
    expect(function () { parseArgs(["--boxes"]); }).toThrow();
  });
});
