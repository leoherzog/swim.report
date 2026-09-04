// Tests for scripts/fetch-wave-grids.js — the only network-touching script in the
// wave pipeline. Its entrypoint is guarded by import.meta.main (falsy under
// vitest/node), so importing its pure exports here touches no Deno, no network and
// no filesystem.
//
// The failure these guard is a SILENT WRONG SLICE. A byte range computed one byte
// wide, or an element matched by prefix, yields a GRIB2 message that GDAL decodes
// cleanly and that describes the wrong variable: a period field arrives where the
// sampler reads wave height, and a plausible number colors a flag with no error
// anywhere. Cycle selection has the same shape — a candidate whose forecast window
// runs past the published series downloads a short cycle that samples as gaps.
//
// Every fixture is built IN MEMORY by one named helper, makeIdx, carrying explicit
// malformation knobs rather than being hand-corrupted per test, the way
// test/fetchLayers.test.js builds its pointer/manifest/floors fixtures.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_DEST,
  REQUIRED_GRID_IDS,
  parseArgs,
  pad3,
  validStartEpochFor,
  isoFromEpoch,
  compactIso,
  compactCycle,
  gridUrl,
  cycleCandidates,
  parseIdx,
  idxRangesFor,
  rangeHeaderFor,
  selectedGrids,
  gridFailureIsFatal,
  sha256Hex
} from "../scripts/fetch-wave-grids.js";
import { GRIDS, GRID_ELEMENTS, FORECAST_HOURS, gridById } from "../src/waveGrids.js";

// Real gfswave global.0p16 record order: WIND first, HTSGW third with PERPW
// immediately after it. That adjacency is what makes the neighbour assertions
// below meaningful — an end computed as next.offset appends one byte of PERPW to
// the HTSGW slice.
const GFSWAVE_RECORDS = [
  { element: "WIND", offset: 0, level: "surface" },
  { element: "WDIR", offset: 643221, level: "surface" },
  { element: "HTSGW", offset: 1085432, level: "surface" },
  { element: "PERPW", offset: 1442558, level: "surface" },
  { element: "DIRPW", offset: 1801003, level: "surface" },
  { element: "SWELL", offset: 2154880, level: "1 in sequence" }
];

// A wgrib2 .idx as text. Knobs, all optional:
//   records   replace the record list wholesale
//   swap      [a, b] exchange those two elements' slots, offsets staying put
//   drop      remove the named element
//   level     { ELEMENT: "level" } move an element off its published level
//   offsets   positional overrides, taken verbatim so a test can pass "" or "abc"
//   truncate  index of a record rendered with fewer than four fields
function makeIdx(options) {
  const opts = options || {};
  const base = Array.isArray(opts.records) ? opts.records : GFSWAVE_RECORDS;
  let records = base.map(function (r) {
    return { element: r.element, offset: r.offset, level: r.level || "surface" };
  });
  if (Array.isArray(opts.swap)) {
    let a = -1;
    let b = -1;
    for (let i = 0; i < records.length; i = i + 1) {
      if (records[i].element === opts.swap[0]) { a = i; }
      if (records[i].element === opts.swap[1]) { b = i; }
    }
    const held = records[a].element;
    records[a].element = records[b].element;
    records[b].element = held;
  }
  if (typeof opts.drop === "string") {
    records = records.filter(function (r) { return r.element !== opts.drop; });
  }
  if (opts.level) {
    for (let i = 0; i < records.length; i = i + 1) {
      if (Object.prototype.hasOwnProperty.call(opts.level, records[i].element)) {
        records[i].level = opts.level[records[i].element];
      }
    }
  }
  const lines = [];
  for (let i = 0; i < records.length; i = i + 1) {
    const offset = opts.offsets && opts.offsets.length > i
      ? opts.offsets[i]
      : records[i].offset;
    if (opts.truncate === i) {
      lines.push(String(i + 1) + ":" + String(offset) + ":d=2026090318");
      continue;
    }
    lines.push(String(i + 1) + ":" + String(offset) + ":d=2026090318:" +
      records[i].element + ":" + records[i].level + ":27 hour fcst:");
  }
  return lines.join("\n") + "\n";
}

describe("parseIdx", function () {
  it("reads the six-record gfswave fixture with each end at the next offset minus one", function () {
    const records = parseIdx(makeIdx());
    expect(records.length).toBe(6);
    expect(records[0]).toEqual({
      record: 1, offset: 0, element: "WIND", level: "surface", end: 643220
    });
    expect(records[2]).toEqual({
      record: 3, offset: 1085432, element: "HTSGW", level: "surface", end: 1442557
    });
  });

  it("gives the last record no range end", function () {
    const records = parseIdx(makeIdx());
    expect(records[records.length - 1].end).toBe(null);
  });

  it("computes the end chain for a three-record .idx as [99, 249, null]", function () {
    const text = makeIdx({
      records: [
        { element: "WIND", offset: 0 },
        { element: "HTSGW", offset: 100 },
        { element: "PERPW", offset: 250 }
      ]
    });
    expect(parseIdx(text).map(function (r) { return r.end; })).toEqual([99, 249, null]);
  });

  it("gives a single-record .idx end null rather than -1", function () {
    const records = parseIdx(makeIdx({ records: [{ element: "HTSGW", offset: 0 }] }));
    expect(records.length).toBe(1);
    expect(records[0].end).toBe(null);
    expect(rangeHeaderFor(idxRangesFor(records, ["HTSGW"])[0])).toBe("bytes=0-");
  });

  it("refuses empty and whitespace-only text", function () {
    expect(function () { parseIdx(""); })
      .toThrow("fetch-wave-grids: .idx is empty");
    expect(function () { parseIdx("   \n \n"); })
      .toThrow("fetch-wave-grids: .idx is empty");
  });

  it("refuses a line with fewer than four colon-separated fields", function () {
    expect(function () { parseIdx(makeIdx({ truncate: 0 })); })
      .toThrow("fetch-wave-grids: unreadable .idx line: 1:0:d=2026090318");
  });

  it("refuses a non-numeric offset", function () {
    expect(function () { parseIdx("2:abc:d=2026090318:HTSGW:surface:"); })
      .toThrow("fetch-wave-grids: unreadable .idx line: 2:abc:d=2026090318:HTSGW:surface:");
  });

  it("refuses an EMPTY offset field, which Number() would read as a valid 0", function () {
    const text = makeIdx({ offsets: ["", 643221, 1085432, 1442558, 1801003, 2154880] });
    expect(function () { parseIdx(text); })
      .toThrow("fetch-wave-grids: unreadable .idx line: 1::d=2026090318:WIND:surface:27 hour fcst:");
  });

  it("refuses a non-numeric record number", function () {
    expect(function () { parseIdx("x:0:d=2026090318:HTSGW:surface:"); })
      .toThrow("fetch-wave-grids: unreadable .idx line:");
  });

  it("refuses offsets that do not ascend, naming both record numbers", function () {
    const text = makeIdx({ offsets: [0, 643221, 643221, 1442558, 1801003, 2154880] });
    expect(function () { parseIdx(text); })
      .toThrow("fetch-wave-grids: .idx offsets must ascend: record 2 at 643221 " +
        "is followed by record 3 at 643221");
  });

  it("refuses a descending offset pair", function () {
    const text = makeIdx({ offsets: [0, 643221, 500000, 1442558, 1801003, 2154880] });
    expect(function () { parseIdx(text); }).toThrow("offsets must ascend");
  });
});

describe("idxRangesFor", function () {
  it("slices HTSGW to exactly its own record, ending one byte before PERPW", function () {
    const out = idxRangesFor(parseIdx(makeIdx()), GRID_ELEMENTS);
    const htsgw = out[1];
    expect(htsgw.element).toBe("HTSGW");
    expect(htsgw.start).toBe(1085432);
    expect(htsgw.end).toBe(1442557);
    // next.offset would append a byte of PERPW; next.offset - 2 would truncate the
    // last byte of HTSGW.
    expect(htsgw.end + 1).toBe(1442558);
    expect(htsgw.end - htsgw.start + 1).toBe(357126);
  });

  it("returns entries in FILE order, not the order they were requested in", function () {
    expect(GRID_ELEMENTS).toEqual(["WIND", "HTSGW"]);
    const out = idxRangesFor(parseIdx(makeIdx()), GRID_ELEMENTS);
    expect(out[0].element).toBe("WIND");
    expect(out[1].element).toBe("HTSGW");
  });

  it("follows the FILE order when HTSGW precedes WIND", function () {
    const text = makeIdx({ swap: ["WIND", "HTSGW"] });
    const out = idxRangesFor(parseIdx(text), GRID_ELEMENTS);
    expect(out[0].element).toBe("HTSGW");
    expect(out[0].start).toBe(0);
    expect(out[1].element).toBe("WIND");
    expect(out[1].start).toBe(1085432);
  });

  it("never overlaps two slices", function () {
    const out = idxRangesFor(parseIdx(makeIdx()), GRID_ELEMENTS);
    expect(out[0].end < out[1].start).toBe(true);
  });

  it("refuses when HTSGW is published at a level other than surface", function () {
    const text = makeIdx({ level: { HTSGW: "1 in sequence" } });
    expect(function () { idxRangesFor(parseIdx(text), GRID_ELEMENTS); })
      .toThrow("fetch-wave-grids: .idx carries no surface HTSGW record");
  });

  it("refuses when the WIND record is absent", function () {
    const text = makeIdx({ drop: "WIND" });
    expect(function () { idxRangesFor(parseIdx(text), GRID_ELEMENTS); })
      .toThrow("fetch-wave-grids: .idx carries no surface WIND record");
  });

  it("matches elements exactly, so WDIR is never taken for WIND", function () {
    const text = makeIdx({ drop: "WIND" });
    const records = parseIdx(text);
    expect(records.some(function (r) { return r.element === "WDIR"; })).toBe(true);
    expect(function () { idxRangesFor(records, ["WIND"]); }).toThrow("surface WIND");
  });

  it("carries the open-ended last record through to an open-ended range header", function () {
    // SWELL sits at "1 in sequence" in the real file, so the fixture moves it to
    // surface to make the last record selectable.
    const text = makeIdx({ level: { SWELL: "surface" } });
    const swell = idxRangesFor(parseIdx(text), ["SWELL"])[0];
    expect(swell.start).toBe(2154880);
    expect(swell.end).toBe(null);
    expect(rangeHeaderFor(swell)).toBe("bytes=2154880-");
  });
});

describe("rangeHeaderFor", function () {
  it("emits an inclusive-on-both-ends HTTP byte range", function () {
    expect(rangeHeaderFor({ start: 1085432, end: 1442557 })).toBe("bytes=1085432-1442557");
  });

  it("emits an open-ended range for the last record", function () {
    expect(rangeHeaderFor({ start: 2154880, end: null })).toBe("bytes=2154880-");
  });
});

describe("cycleCandidates", function () {
  const VALID_START = 1788469200;

  it("walks gfswave back 24 h, newest first, with the offset each cycle needs", function () {
    const out = cycleCandidates(gridById("noaa_gfswave"), VALID_START);
    expect(out.length).toBe(5);
    expect(out.map(function (c) { return c.cycleIso; })).toEqual([
      "2026-09-03T18:00:00.000Z",
      "2026-09-03T12:00:00.000Z",
      "2026-09-03T06:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
      "2026-09-02T18:00:00.000Z"
    ]);
    expect(out.map(function (c) { return c.forecastOffset; })).toEqual([3, 9, 15, 21, 27]);
  });

  it("measures the offset to validStart, not to the run clock", function () {
    const onCycle = Date.parse("2026-09-03T18:00:00Z") / 1000;
    expect(cycleCandidates(gridById("noaa_gfswave"), onCycle)[0].forecastOffset).toBe(0);
  });

  it("walks glwu back over its 25 hourly cycles", function () {
    const out = cycleCandidates(gridById("noaa_glwu"), VALID_START);
    expect(out.length).toBe(26);
    expect(out[0].cycleIso).toBe("2026-09-03T21:00:00.000Z");
    expect(out[out.length - 1].cycleIso).toBe("2026-09-02T20:00:00.000Z");
    const offsets = [];
    for (let i = 0; i <= 25; i = i + 1) { offsets.push(i); }
    expect(out.map(function (c) { return c.forecastOffset; })).toEqual(offsets);
  });

  it("never offers a glwu cycle whose 24 h window runs past its 49 published steps", function () {
    const grid = gridById("noaa_glwu");
    const out = cycleCandidates(grid, VALID_START);
    const over = out.filter(function (c) {
      return c.forecastOffset + FORECAST_HOURS > grid.forecastSteps;
    });
    expect(over).toEqual([]);
  });

  it("cuts on forecastSteps independently of maxCycleAgeHours", function () {
    const grid = {
      urlTemplate: "x", cycleStepHours: 1, maxCycleAgeHours: 30, forecastSteps: 49
    };
    expect(cycleCandidates(grid, VALID_START).length).toBe(26);
  });

  it("offers nothing at all when no cycle can cover 24 h, rather than a short series", function () {
    const grid = {
      urlTemplate: "x", cycleStepHours: 1, maxCycleAgeHours: 30, forecastSteps: 20
    };
    expect(cycleCandidates(grid, VALID_START)).toEqual([]);
  });
});

describe("validStartEpochFor", function () {
  it("floors to the top of the UTC hour in SECONDS", function () {
    // Millisecond divide then second multiply: a slip yields an epoch 1000x off
    // that every downstream GRIB_VALID_TIME comparison silently fails against.
    expect(validStartEpochFor(Date.parse("2026-09-03T21:52:31.250Z"))).toBe(1788469200);
    expect(1788469200).toBe(Date.parse("2026-09-03T21:00:00Z") / 1000);
  });

  it("is idempotent on the hour and constant across the hour", function () {
    const top = Date.parse("2026-09-03T21:00:00.000Z");
    expect(validStartEpochFor(top)).toBe(validStartEpochFor(top + 3599999));
    expect(validStartEpochFor(Date.parse("2026-09-03T21:59:59.999Z"))).toBe(1788469200);
  });

  it("always lands on a whole hour", function () {
    const samples = [0, 1, 3599999, 1788469199250, 1788472799999];
    for (let i = 0; i < samples.length; i = i + 1) {
      const epoch = validStartEpochFor(samples[i]);
      expect(epoch % 3600).toBe(0);
      expect(isoFromEpoch(epoch).endsWith(":00:00.000Z")).toBe(true);
    }
  });
});

describe("compactIso and compactCycle", function () {
  it("render the fixed-width forms the R2 prefix is built from", function () {
    expect(compactIso(1788469200)).toBe("20260903T2100Z");
    expect(compactCycle(1788469200)).toBe("20260903T21Z");
  });

  it("agree with each other, so one slice index cannot drift from the other", function () {
    const epochs = [1788469200, 0, 1788372000];
    for (let i = 0; i < epochs.length; i = i + 1) {
      expect(compactIso(epochs[i]).slice(0, 11) + "Z").toBe(compactCycle(epochs[i]));
    }
  });
});

describe("gridUrl", function () {
  it("substitutes BOTH {HH} occurrences in the gfswave template", function () {
    const cycle = Date.parse("2026-09-03T18:00:00Z") / 1000;
    expect(gridUrl(gridById("noaa_gfswave"), cycle, 27)).toBe(
      "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20260903/18/wave/gridded/" +
      "gfswave.t18z.global.0p16.f027.grib2");
  });

  it("pads the forecast step to three digits", function () {
    const grid = gridById("noaa_gfswave");
    const cycle = Date.parse("2026-09-03T18:00:00Z") / 1000;
    expect(gridUrl(grid, cycle, 3).indexOf(".f003.")).toBeGreaterThan(-1);
    expect(gridUrl(grid, cycle, 27).indexOf(".f027.")).toBeGreaterThan(-1);
    expect(gridUrl(grid, cycle, 357).indexOf(".f357.")).toBeGreaterThan(-1);
  });

  it("leaves no placeholder and no forecast step on the whole-file glwu url", function () {
    const url = gridUrl(gridById("noaa_glwu"), 1788469200);
    expect(url).toBe("https://nomads.ncep.noaa.gov/pub/data/nccf/com/glwu/prod/" +
      "glwu.20260903/glwu.grlc_2p5km_sr.t21z.grib2");
    expect(url.indexOf("{")).toBe(-1);
    expect(url.indexOf("f000")).toBe(-1);
  });
});

describe("pad3", function () {
  it("pads to three digits and never truncates a wider number", function () {
    expect(pad3(0)).toBe("000");
    expect(pad3(9)).toBe("009");
    expect(pad3(99)).toBe("099");
    expect(pad3(357)).toBe("357");
    expect(pad3(1234)).toBe("1234");
  });
});

describe("selectedGrids", function () {
  it("returns all three grids in fallthrough order when none are named", function () {
    const all = GRIDS.map(function (g) { return g.id; });
    expect(selectedGrids([]).map(function (g) { return g.id; })).toEqual(all);
    expect(selectedGrids(null).map(function (g) { return g.id; })).toEqual(all);
    expect(selectedGrids(undefined).map(function (g) { return g.id; })).toEqual(all);
  });

  it("returns exactly the named grid", function () {
    expect(selectedGrids(["noaa_glwu"]).map(function (g) { return g.id; }))
      .toEqual(["noaa_glwu"]);
  });

  it("trims surrounding whitespace off a --grids value", function () {
    expect(selectedGrids([" noaa_glwu "]).map(function (g) { return g.id; }))
      .toEqual(["noaa_glwu"]);
  });

  it("refuses an unknown id by name rather than silently fetching nothing", function () {
    expect(function () { selectedGrids(["noaa_glwuu"]); })
      .toThrow("fetch-wave-grids: unknown grid id noaa_glwuu");
  });

  it("consumes a --grids list straight out of parseArgs", function () {
    const args = parseArgs(["--grids", "noaa_glwu,noaa_gfswave"]);
    expect(args.gridIds.length).toBe(2);
    expect(selectedGrids(args.gridIds).map(function (g) { return g.id; }))
      .toEqual(["noaa_glwu", "noaa_gfswave"]);
  });
});

describe("REQUIRED_GRID_IDS", function () {
  it("is exactly the global ocean grid", function () {
    expect(REQUIRED_GRID_IDS).toEqual(["noaa_gfswave"]);
  });

  it("names only ids that resolve, so no refusal can be disarmed by a typo", function () {
    expect(REQUIRED_GRID_IDS.length).toBeGreaterThan(0);
    for (let i = 0; i < REQUIRED_GRID_IDS.length; i = i + 1) {
      expect(gridById(REQUIRED_GRID_IDS[i])).not.toBe(null);
    }
  });
});

describe("parseArgs", function () {
  it("defaults dest and leaves the optional flags null", function () {
    expect(parseArgs([])).toEqual({ dest: DEFAULT_DEST, validStart: null, gridIds: null });
  });

  it("reads all three flags", function () {
    const args = parseArgs([
      "--dest", "./.waves-x",
      "--valid-start", "2026-09-03T21:00:00Z",
      "--grids", "noaa_glwu"
    ]);
    expect(args.dest).toBe("./.waves-x");
    // parseArgs passes --valid-start through raw; main() parses and rejects it.
    expect(args.validStart).toBe("2026-09-03T21:00:00Z");
    expect(args.gridIds).toEqual(["noaa_glwu"]);
  });

  it("refuses an unknown argument", function () {
    expect(function () { parseArgs(["--layers", "./x"]); })
      .toThrow("unknown argument: --layers");
  });

  it("refuses --dest with no value", function () {
    expect(function () { parseArgs(["--dest"]); })
      .toThrow("fetch-wave-grids: --dest requires a path");
  });
});

describe("sha256Hex", function () {
  it("matches the published SHA-256 vector for \"abc\"", async function () {
    const digest = await sha256Hex(new TextEncoder().encode("abc"));
    expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("emits a lowercase 64-hex string with leading zeros preserved", async function () {
    const digest = await sha256Hex(new Uint8Array(0));
    expect(digest)
      .toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(/^[0-9a-f]{64}$/.test(digest)).toBe(true);
  });
});

describe("gridFailureIsFatal", function () {
  // The single decision that separates a partial cycle from no cycle: a required
  // grid's failure writes grids-report.json and exits 1, and any other grid's failure
  // is recorded while the run continues. Reaching it through main() would need a fake
  // network as well as a fake Deno, and a mocked download is a restatement of the
  // loop, not a test of this verdict.
  it("is fatal for every required grid and for no other", function () {
    for (let i = 0; i < GRIDS.length; i = i + 1) {
      const id = GRIDS[i].id;
      expect(gridFailureIsFatal(id)).toBe(REQUIRED_GRID_IDS.indexOf(id) !== -1);
    }
    expect(gridFailureIsFatal("noaa_gfswave")).toBe(true);
    expect(gridFailureIsFatal("noaa_glwu")).toBe(false);
    expect(gridFailureIsFatal("noaa_gfswave_arctic")).toBe(false);
  });

  it("reads REQUIRED_GRID_IDS when the caller names no list", function () {
    // The workflow shell takes the same list off grids-report.json, so a re-spelled
    // literal here would let the two drift.
    expect(gridFailureIsFatal("noaa_glwu", ["noaa_glwu"])).toBe(true);
    expect(gridFailureIsFatal("noaa_gfswave", [])).toBe(false);
    expect(gridFailureIsFatal("noaa_gfswave", null)).toBe(true);
  });

  it("is fatal for nothing the grid set does not contain", function () {
    expect(gridFailureIsFatal("open_meteo")).toBe(false);
  });
});
