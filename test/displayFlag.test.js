// test/displayFlag.test.js
// The one display decision (src/displayFlag.js): its decision table, the
// invariants every surface relies on, parity between the chip-record and
// blob-record shapes, purity, and a source scan that keeps a second copy of the
// rule from creeping back into any surface.

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as displayFlagModule from "../src/displayFlag.js";
import { STALE_MS, isStale, collapseFlagColor, displayFlag } from "../src/displayFlag.js";
import { SEVERITY_RANK, normalizeColor } from "../src/rules.js";
import { liveChipState, liveBeachState } from "../src/beachState.js";

const NOW_ISO = "2026-07-05T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function agoIso(ms) {
  return new Date(NOW_MS - ms).toISOString();
}

const FRESH = agoIso(1800000);
const AGED = agoIso(10800000);

function est(color) {
  return { color: color, reason: "r", official: false, sources: [], updated: agoIso(600000) };
}

function off(color, updated) {
  const record = { color: color, reason: "posted", official: true, source: "https://ex.gov/f" };
  if (updated !== undefined) {
    record.updated = updated;
  }
  return record;
}

function decide(estimate, official, nowIso) {
  return displayFlag({ estimate: estimate, official: official },
    nowIso === undefined ? NOW_ISO : nowIso);
}

function result(color, keyword, source) {
  return { color: color, keyword: keyword, source: source };
}

const UNKNOWN_NONE = result("unknown", "unknown", "none");

describe("displayFlag decision table", function () {
  it("1: no estimate and no official reads gray unknown, never a green default", function () {
    expect(decide(null, null)).toEqual(UNKNOWN_NONE);
    expect(displayFlag({}, NOW_ISO)).toEqual(UNKNOWN_NONE);
    expect(displayFlag(null, NOW_ISO)).toEqual(UNKNOWN_NONE);
    expect(displayFlag(undefined, NOW_ISO)).toEqual(UNKNOWN_NONE);
  });

  it("2: a green, yellow or red estimate alone decides as itself", function () {
    expect(decide(est("green"), null)).toEqual(result("green", "green", "estimate"));
    expect(decide(est("yellow"), null)).toEqual(result("yellow", "yellow", "estimate"));
    expect(decide(est("red"), null)).toEqual(result("red", "red", "estimate"));
  });

  it("3: a double-red estimate alone keeps its color and collapses its keyword", function () {
    expect(decide(est("double-red"), null)).toEqual(result("double-red", "red", "estimate"));
  });

  it("4: an estimate the rules engine left unknown credits no record", function () {
    expect(decide(est("unknown"), null)).toEqual(UNKNOWN_NONE);
  });

  it("5: an invalid estimate color reads unknown with no source", function () {
    expect(decide(est("magenta"), null)).toEqual(UNKNOWN_NONE);
    expect(decide(est("GREEN"), null)).toEqual(UNKNOWN_NONE);
    expect(decide(est(""), null)).toEqual(UNKNOWN_NONE);
    expect(decide(est(42), null)).toEqual(UNKNOWN_NONE);
    expect(decide({ reason: "no color" }, null)).toEqual(UNKNOWN_NONE);
  });

  it("6: an official with an invalid color is treated as absent", function () {
    const invalid = ["magenta", "unknown", "", null];
    for (const color of invalid) {
      for (const updated of [FRESH, AGED, undefined]) {
        expect(decide(null, off(color, updated))).toEqual(UNKNOWN_NONE);
        expect(decide(est("yellow"), off(color, updated)))
          .toEqual(result("yellow", "yellow", "estimate"));
        expect(decide(est("double-red"), off(color, updated)))
          .toEqual(result("double-red", "red", "estimate"));
      }
    }
    expect(decide(est("green"), { reason: "no color", updated: FRESH }))
      .toEqual(result("green", "green", "estimate"));
  });

  it("7: a fresh official decides outright, even below the estimate", function () {
    expect(decide(est("green"), off("yellow", FRESH))).toEqual(result("yellow", "yellow", "official"));
    expect(decide(est("red"), off("yellow", FRESH))).toEqual(result("yellow", "yellow", "official"));
    expect(decide(est("double-red"), off("green", FRESH))).toEqual(result("green", "green", "official"));
    expect(decide(null, off("red", FRESH))).toEqual(result("red", "red", "official"));
  });

  it("7: an official exactly STALE_MS old is still fresh (strict comparison)", function () {
    expect(decide(est("red"), off("yellow", agoIso(STALE_MS))))
      .toEqual(result("yellow", "yellow", "official"));
    expect(decide(est("red"), off("yellow", agoIso(STALE_MS + 1))))
      .toEqual(result("red", "red", "estimate"));
  });

  it("8: an official with no usable updated stamp reads fresh", function () {
    // 2026 and a Date both parse into the past, so only the non-string guard
    // keeps them fresh, as liveChipRecord's null stamp reads.
    const stamps = [undefined, null, 12345, 2026, new Date(Date.parse(AGED)), "garbage"];
    for (const updated of stamps) {
      const official = off("yellow");
      official.updated = updated;
      expect(decide(est("red"), official)).toEqual(result("yellow", "yellow", "official"));
    }
  });

  it("9: a missing or unparseable nowIso reads the official fresh", function () {
    for (const nowIso of [null, "garbage"]) {
      expect(decide(est("red"), off("yellow", AGED), nowIso))
        .toEqual(result("yellow", "yellow", "official"));
    }
    expect(displayFlag({ estimate: est("red"), official: off("yellow", AGED) }))
      .toEqual(result("yellow", "yellow", "official"));
  });

  it("10: an official stamped in the future reads fresh", function () {
    const future = new Date(NOW_MS + 3600000).toISOString();
    expect(decide(est("red"), off("yellow", future))).toEqual(result("yellow", "yellow", "official"));
  });

  it("11: an aged official still decides while strictly more severe", function () {
    expect(decide(est("green"), off("red", AGED))).toEqual(result("red", "red", "official"));
    expect(decide(est("yellow"), off("red", AGED))).toEqual(result("red", "red", "official"));
    // No estimate and an unknown estimate both rank 0.
    expect(decide(null, off("green", AGED))).toEqual(result("green", "green", "official"));
    expect(decide(est("unknown"), off("green", AGED))).toEqual(result("green", "green", "official"));
    expect(decide(est("magenta"), off("yellow", AGED))).toEqual(result("yellow", "yellow", "official"));
  });

  it("12: an aged official that ties credits the fresher estimate", function () {
    expect(decide(est("yellow"), off("yellow", AGED))).toEqual(result("yellow", "yellow", "estimate"));
    expect(decide(est("green"), off("green", AGED))).toEqual(result("green", "green", "estimate"));
    expect(decide(est("double-red"), off("double-red", AGED)))
      .toEqual(result("double-red", "red", "estimate"));
  });

  it("13: an aged official below the estimate yields to it", function () {
    expect(decide(est("red"), off("yellow", AGED))).toEqual(result("red", "red", "estimate"));
    expect(decide(est("yellow"), off("green", AGED))).toEqual(result("yellow", "yellow", "estimate"));
  });

  it("weighs double-red in both directions once the official has aged", function () {
    expect(decide(est("red"), off("double-red", AGED))).toEqual(result("double-red", "red", "official"));
    expect(decide(est("double-red"), off("red", AGED))).toEqual(result("double-red", "red", "estimate"));
    expect(decide(null, off("double-red", FRESH))).toEqual(result("double-red", "red", "official"));
  });

  it("shows Holland's posted yellow over its green estimate, morning and afternoon", function () {
    expect(decide(est("green"), off("yellow", FRESH))).toEqual(result("yellow", "yellow", "official"));
    expect(decide(est("green"), off("yellow", agoIso(14400000))))
      .toEqual(result("yellow", "yellow", "official"));
  });

  it("gates on the 2 h default, never the record's own staleMs", function () {
    const official = off("yellow", AGED);
    official.staleMs = 108000000;
    expect(decide(est("red"), official)).toEqual(result("red", "red", "estimate"));
  });
});

describe("displayFlag invariants", function () {
  const ESTIMATES = [null, "green", "yellow", "red", "double-red", "unknown", "magenta", "no-color"];
  const OFFICIALS = [null, "green", "yellow", "red", "double-red", "unknown", "magenta"];
  const AGES = [
    { name: "fresh", updated: agoIso(1800000), aged: false },
    { name: "exactly 2 h", updated: agoIso(STALE_MS), aged: false },
    { name: "aged", updated: agoIso(10800000), aged: true },
    { name: "no updated", updated: undefined, aged: false },
    { name: "non-string", updated: 2026, aged: false }
  ];

  function estimateFor(key) {
    if (key === null) {
      return null;
    }
    if (key === "no-color") {
      return {};
    }
    return est(key);
  }

  // Every combination, as the parsed blobs the detail page reads.
  function sweep() {
    const cases = [];
    for (const e of ESTIMATES) {
      for (const o of OFFICIALS) {
        for (const age of AGES) {
          cases.push({
            label: String(e) + " / " + String(o) + " / " + age.name,
            estimate: estimateFor(e),
            official: o === null ? null : off(o, age.updated),
            aged: age.aged
          });
        }
      }
    }
    return cases;
  }

  // The chip pair liveChipRecord would build from the same record's mirror columns.
  function chipOf(record) {
    if (!record || typeof record.color !== "string" || record.color === "") {
      return null;
    }
    return { color: record.color, updated: typeof record.updated === "string" ? record.updated : null };
  }

  it("holds invariants 1 to 4 and the raise-only rule for every input", function () {
    for (const c of sweep()) {
      const d = decide(c.estimate, c.official);
      const officialColor = c.official ? normalizeColor(c.official.color) : "unknown";
      const estimateColor = c.estimate ? normalizeColor(c.estimate.color) : "unknown";
      // 1: official means the official's own real color.
      if (d.source === "official") {
        expect(d.color, c.label).toBe(officialColor);
        expect(d.color, c.label).not.toBe("unknown");
      }
      // 2: estimate means the estimate's own real color.
      if (d.source === "estimate") {
        expect(c.estimate, c.label).not.toBe(null);
        expect(d.color, c.label).toBe(estimateColor);
        expect(d.color, c.label).not.toBe("unknown");
      }
      // 3: none exactly when unknown.
      expect(d.source === "none", c.label).toBe(d.color === "unknown");
      // 4: the keyword is the collapse of the color.
      expect(d.keyword, c.label).toBe(collapseFlagColor(d.color));
      expect(["green", "yellow", "red", "unknown"], c.label).toContain(d.keyword);
      expect(["official", "estimate", "none"], c.label).toContain(d.source);
      expect(Object.keys(d), c.label).toEqual(["color", "keyword", "source"]);
      // Raise-only past the gate, outright before it.
      if (officialColor !== "unknown") {
        if (c.aged) {
          expect(SEVERITY_RANK[d.color], c.label).toBeGreaterThanOrEqual(SEVERITY_RANK[officialColor]);
        } else {
          expect(d.color, c.label).toBe(officialColor);
        }
      }
      // Never a green default: green comes only from a record that says green.
      if (d.color === "green") {
        const said = (c.estimate && c.estimate.color === "green") ||
          (c.official && c.official.color === "green");
        expect(said, c.label).toBe(true);
      }
    }
  });

  it("decides chip pairs and full blobs identically for every input", function () {
    for (const c of sweep()) {
      const blob = decide(c.estimate, c.official);
      const chip = decide(chipOf(c.estimate), chipOf(c.official));
      expect(chip, c.label).toEqual(blob);
    }
  });

  it("decides one real row alike through liveChipState and liveBeachState", function () {
    const estimate = est("green");
    const official = off("yellow", AGED);
    const liveExpires = Math.floor(NOW_MS / 1000) + 3600;
    const row = {
      estimate: JSON.stringify(estimate),
      estimate_color: estimate.color,
      estimate_updated: estimate.updated,
      estimate_expires: liveExpires,
      official: JSON.stringify(official),
      official_color: official.color,
      official_updated: official.updated,
      official_expires: liveExpires
    };
    const chip = displayFlag(liveChipState(row, NOW_MS), NOW_ISO);
    const blob = displayFlag(liveBeachState(row, NOW_MS), NOW_ISO);
    expect(chip).toEqual(blob);
    expect(chip).toEqual(result("yellow", "yellow", "official"));
  });
});

describe("displayFlag reads only what it declares", function () {
  function guarded(record) {
    return new Proxy(record, {
      get: function (target, key) {
        if (key !== "color" && key !== "updated") {
          throw new Error("displayFlag read " + String(key));
        }
        return target[key];
      }
    });
  }

  it("touches only color and updated on each record, and only the two records on state", function () {
    const entry = {
      beach: { id: "b-1" },
      distanceMi: 1.2,
      estimate: guarded(est("green")),
      official: guarded(off("red", AGED))
    };
    const state = new Proxy(entry, {
      get: function (target, key) {
        if (key !== "estimate" && key !== "official") {
          throw new Error("displayFlag read state." + String(key));
        }
        return target[key];
      }
    });
    expect(displayFlag(state, NOW_ISO)).toEqual(result("red", "red", "official"));
  });
});

describe("displayFlag purity", function () {
  it("returns a frozen result", function () {
    expect(Object.isFrozen(decide(est("green"), off("yellow", FRESH)))).toBe(true);
    expect(Object.isFrozen(decide(null, null))).toBe(true);
  });

  it("never reads the clock", function () {
    const estimate = est("green");
    const official = off("red", AGED);
    const before = decide(estimate, official);
    const spy = vi.spyOn(Date, "now").mockImplementation(function () {
      throw new Error("clock");
    });
    try {
      expect(decide(estimate, official)).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });

  it("never mutates its inputs", function () {
    const state = { estimate: est("yellow"), official: off("red", AGED), beach: { id: "b-1" } };
    const snapshot = JSON.stringify(state);
    displayFlag(state, NOW_ISO);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe("isStale and collapseFlagColor", function () {
  it("reads a missing instant on either side as not stale", function () {
    expect(isStale(null, AGED)).toBe(false);
    expect(isStale(NOW_ISO, null)).toBe(false);
    expect(isStale("garbage", AGED)).toBe(false);
    expect(isStale(NOW_ISO, "garbage")).toBe(false);
  });

  it("defaults the threshold to STALE_MS and compares strictly", function () {
    expect(STALE_MS).toBe(7200000);
    expect(isStale(NOW_ISO, agoIso(STALE_MS))).toBe(false);
    expect(isStale(NOW_ISO, agoIso(STALE_MS + 1))).toBe(true);
    expect(isStale(NOW_ISO, agoIso(1001), 1000)).toBe(true);
    expect(isStale(NOW_ISO, agoIso(1000), 1000)).toBe(false);
  });

  it("collapses double-red to red and anything unrecognized to unknown", function () {
    expect(collapseFlagColor("double-red")).toBe("red");
    expect(collapseFlagColor("magenta")).toBe("unknown");
    expect(collapseFlagColor(null)).toBe("unknown");
    expect(collapseFlagColor("green")).toBe("green");
    expect(collapseFlagColor("yellow")).toBe("yellow");
    expect(collapseFlagColor("red")).toBe("red");
  });
});

// A second copy of the rule is the regression this file exists to stop. The
// behavioral guarantee is the cross-surface matrix in test/router.test.js; this
// scan only keeps the old names and raw-record reads from coming back.
describe("no second copy of the display decision", function () {
  const ROOT = new URL("../", import.meta.url);

  function filesUnder(rel) {
    const out = [];
    const dir = new URL(rel, ROOT);
    for (const name of readdirSync(dir)) {
      const childRel = rel + name;
      if (statSync(new URL(childRel, ROOT)).isDirectory()) {
        for (const nested of filesUnder(childRel + "/")) {
          out.push(nested);
        }
      } else {
        out.push(childRel);
      }
    }
    return out;
  }

  function read(rel) {
    return readFileSync(new URL(rel, ROOT), "utf8");
  }

  function count(haystack, needle) {
    return haystack.split(needle).length - 1;
  }

  const SRC_FILES = filesUnder("src/");

  it("leaves no retired name anywhere in src/ or test/", function () {
    // Built by concatenation so this file does not match itself.
    const retired = [
      "display" + "FlagColor",
      "marker" + "FlagColor",
      "worst" + "Color",
      "title" + "Color",
      "display" + "IsOfficial",
      "official" + "Decides",
      "render" + "FlagChip"
    ];
    for (const rel of SRC_FILES.concat(filesUnder("test/"))) {
      const text = read(rel);
      for (const name of retired) {
        expect(text.indexOf(name) === -1, rel + " names " + name).toBe(true);
      }
    }
  });

  it("defines the constant and the three functions once, in src/displayFlag.js", function () {
    const definitions = [
      "const STALE_MS ",
      "function isStale(",
      "function collapseFlagColor(",
      "function displayFlag("
    ];
    for (const needle of definitions) {
      const hits = [];
      for (const rel of SRC_FILES) {
        const n = count(read(rel), needle);
        for (let i = 0; i < n; i = i + 1) {
          hits.push(rel);
        }
      }
      expect(hits, needle).toEqual(["src/displayFlag.js"]);
    }
  });

  it("keeps src/displayFlag.js off the clock", function () {
    const text = read("src/displayFlag.js");
    expect(text).not.toContain("Date.now");
    expect(text).not.toContain("new Date");
  });

  it("leaves render.js no raw-record read that could decide a beach's flag", function () {
    const text = read("src/frontend/render.js");
    expect(text).not.toContain("SEVERITY_RANK");
    expect(text).not.toContain("entry.estimate");
    expect(text).not.toContain("entry.official");
    // Once each, inside the per-record cards.
    expect(count(text, "estimate.color")).toBe(1);
    expect(count(text, "official.color")).toBe(1);
    expect(count(text, "official.updated")).toBe(1);
    // flagIconColorClass, presentation of a color a caller already chose.
    expect(count(text, "collapseFlagColor(")).toBe(1);
    // The row, the nearby card and the detail page.
    expect(count(text, "= displayFlag(")).toBe(3);
    // The definition, the official card, the compact flag and the hero badge.
    expect(count(text, "renderOfficialBadge(")).toBe(4);
    const dataFlags = [];
    const pattern = /data-flag=\\"" \+\s*(\S+)/g;
    let match = pattern.exec(text);
    while (match !== null) {
      dataFlags.push(match[1]);
      match = pattern.exec(text);
    }
    expect(dataFlags).toEqual(["flag.keyword", "flag.keyword"]);
  });

  it("leaves verdict.js reading the decision, not the records' colors", function () {
    const text = read("src/frontend/verdict.js");
    expect(text).not.toContain("official.color");
    expect(text).not.toContain("estimate.color");
    expect(text).not.toContain("normalizeColor(");
  });

  it("has mapFeatures.js and router.js take one decision each and derive nothing", function () {
    const calls = {
      "src/mapFeatures.js": "flag: displayFlag(state, nowIso).keyword",
      "src/router.js": "const flag = displayFlag(state, new Date(nowMs).toISOString());"
    };
    for (const rel of Object.keys(calls)) {
      const text = read(rel);
      for (const name of ["isStale", "SEVERITY_RANK", "collapseFlagColor", "normalizeColor"]) {
        expect(text.indexOf(name) === -1, rel + " names " + name).toBe(true);
      }
      expect(count(text, "displayFlag("), rel).toBe(1);
      expect(text, rel).toContain(calls[rel]);
    }
    expect(read("src/mapFeatures.js")).not.toContain("frontend/render.js");
    // The router imports page renderers from render.js and nothing flag-related.
    const importLine = read("src/router.js").split("\n").filter(function (line) {
      return line.indexOf("from \"./frontend/render.js\"") !== -1;
    });
    expect(importLine).toEqual([
      "import { renderListPage, renderDetailPage, renderErrorPage } from \"./frontend/render.js\";"
    ]);
  });

  it("exports exactly the constant, the two helpers and the decision", function () {
    expect(Object.keys(displayFlagModule).sort())
      .toEqual(["STALE_MS", "collapseFlagColor", "displayFlag", "isStale"]);
  });
});
