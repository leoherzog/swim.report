// test/nwsNshNearshore.test.js
// Pure-parser unit tests for the NWS Nearshore Marine Forecast (NSH)
// supplemental wave source. No network: every test drives the exported pure
// functions against inline fixtures. Project style: ES modules, NO template
// literals (string concat with +), function () {} callbacks.

import { describe, it, expect } from "vitest";
import {
  parseNshWaveFt,
  expandUgcZones,
  matches
} from "../src/waveSources/nwsNshNearshore.js";

const NOW_ISO = "2026-07-22T11:00:00Z";

// Realistic multi-zone NSH product for WFO MKX (Milwaukee), modeled on the live
// productText shape: an MND/synopsis segment whose UGC header lists every zone,
// then per-zone forecast segments separated by "$$". LMZ643 gets its own
// segment; LMZ645/646 share one; the wave phrase is line-wrapped like the real
// product. LMZ644 appears only in the synopsis (no wave phrase).
const NSH_MKX = [
  "000",
  "FZUS53 KMKX 221100",
  "NSHMKX",
  "Nearshore Marine Forecast",
  "National Weather Service Milwaukee/Sullivan WI",
  "510 AM CDT Wed Jul 22 2026",
  "",
  "LMZ643-644-645-646-221600-",
  "...SYNOPSIS...",
  "High pressure builds across the region through Thursday.",
  "$$",
  "LMZ643-221600-",
  "Sheboygan to Port Washington WI-",
  "510 AM CDT Wed Jul 22 2026",
  "",
  "...SMALL CRAFT ADVISORY IN EFFECT UNTIL 7 AM CDT THIS MORNING...",
  "",
  ".TODAY...Northwest wind 15 to 20 knots becoming north. Sunny. Waves 2 to",
  "4 feet subsiding to 1 to 2 feet in the late morning and afternoon.",
  "$$",
  "LMZ645-646-221600-",
  "North Point Light to Winthrop Harbor WI-",
  "510 AM CDT Wed Jul 22 2026",
  "",
  ".TODAY...North wind 10 to 15 knots. Waves 3 to 5 feet subsiding to",
  "1 to 3 feet late.",
  "$$"
].join("\n");

// A calm product: "1 foot or less" wording.
const NSH_CALM = [
  "LMZ742-231000-",
  "Some Calm Zone-",
  "400 AM CDT Wed Jul 22 2026",
  "",
  ".TODAY...Light winds. Waves 1 foot or less.",
  "$$"
].join("\n");

describe("expandUgcZones", function () {
  it("expands a list header with continuation digits", function () {
    expect(expandUgcZones("LMZ643-644-645-646-221600-"))
      .toEqual(["LMZ643", "LMZ644", "LMZ645", "LMZ646"]);
  });

  it("expands a single-zone header, ignoring the purge stamp", function () {
    expect(expandUgcZones("LMZ643-221600-")).toEqual(["LMZ643"]);
  });

  it("expands a > range form", function () {
    expect(expandUgcZones("LMZ643>646-221600-"))
      .toEqual(["LMZ643", "LMZ644", "LMZ645", "LMZ646"]);
  });

  it("returns [] for non-string / empty input (never throws)", function () {
    expect(expandUgcZones(null)).toEqual([]);
    expect(expandUgcZones("")).toEqual([]);
    expect(expandUgcZones("no zones here")).toEqual([]);
  });
});

describe("parseNshWaveFt", function () {
  it("takes the upper bound of the first range, line-wrap tolerant", function () {
    // LMZ643: "Waves 2 to\n4 feet ..." -> 4
    expect(parseNshWaveFt(NSH_MKX, "LMZ643", NOW_ISO)).toBe(4);
  });

  it("resolves a zone named as the FIRST code of a shared segment", function () {
    // LMZ645/646 share a segment: "Waves 3 to 5 feet ..." -> 5
    expect(parseNshWaveFt(NSH_MKX, "LMZ645", NOW_ISO)).toBe(5);
  });

  it("resolves a zone named as a CONTINUATION code of a shared segment", function () {
    expect(parseNshWaveFt(NSH_MKX, "LMZ646", NOW_ISO)).toBe(5);
  });

  it("is case-insensitive on the zone argument", function () {
    expect(parseNshWaveFt(NSH_MKX, "lmz643", NOW_ISO)).toBe(4);
  });

  it("parses a 'X foot or less' phrase", function () {
    expect(parseNshWaveFt(NSH_CALM, "LMZ742", NOW_ISO)).toBe(1);
  });

  it("skips a synopsis-only zone match and returns null when no wave phrase", function () {
    // LMZ644 appears ONLY in the synopsis segment (no "Waves ... feet").
    expect(parseNshWaveFt(NSH_MKX, "LMZ644", NOW_ISO)).toBe(null);
  });

  it("returns null for a zone the product does not cover", function () {
    expect(parseNshWaveFt(NSH_MKX, "LMZ999", NOW_ISO)).toBe(null);
  });

  it("returns null for a malformed zone argument", function () {
    expect(parseNshWaveFt(NSH_MKX, "MKX", NOW_ISO)).toBe(null);
    expect(parseNshWaveFt(NSH_MKX, "643", NOW_ISO)).toBe(null);
  });

  it("returns null for null / empty / garbage product text", function () {
    expect(parseNshWaveFt(null, "LMZ643", NOW_ISO)).toBe(null);
    expect(parseNshWaveFt("", "LMZ643", NOW_ISO)).toBe(null);
    expect(parseNshWaveFt("<<< not an NSH product >>>", "LMZ643", NOW_ISO)).toBe(null);
  });

  it("returns null when the zone's segment has no recognizable height number", function () {
    const noNumber = [
      "LMZ643-221600-",
      "Sheboygan to Port Washington WI-",
      "",
      ".TODAY...Waves subsiding through the day.",
      "$$"
    ].join("\n");
    expect(parseNshWaveFt(noNumber, "LMZ643", NOW_ISO)).toBe(null);
  });

  it("rejects an implausibly large height rather than emit a wrong number", function () {
    const bogus = [
      "LMZ643-221600-",
      "",
      ".TODAY...Waves 250 feet.",
      "$$"
    ].join("\n");
    expect(parseNshWaveFt(bogus, "LMZ643", NOW_ISO)).toBe(null);
  });
});

describe("matches", function () {
  it("is true only when the beach carries a non-empty marine_zone", function () {
    expect(matches({ id: "b1", marine_zone: "LMZ643" })).toBe(true);
    expect(matches({ id: "b1", marine_zone: "" })).toBe(false);
    expect(matches({ id: "b1", marine_zone: "   " })).toBe(false);
    expect(matches({ id: "b1", marine_zone: null })).toBe(false);
    expect(matches({ id: "b1" })).toBe(false);
    expect(matches(null)).toBe(false);
  });
});
