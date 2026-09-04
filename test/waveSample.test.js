// Tests for the nearest-wet-cell search in src/waveGrids.js and the pure plumbing in
// scripts/sample-waves.js.
//
// The spiral is THE mechanism of this pipeline, not a fallback: 4 of 5 real beach
// coordinates land on a masked LAND cell, so naive nearest-cell sampling returns
// nodata almost everywhere. Every failure it can have is silent — a wrong tie-break
// returns a plausible wave height from the wrong cell, a hardcoded sentinel passes
// 9.999e+20 straight into a flag color, and re-resolving per forecast hour makes a
// detail page's "now" stat contradict its own first bar.

import { describe, it, expect } from "vitest";
import { distanceKm } from "../src/geo.js";
import {
  GRIDS,
  REQUIRED_GRID_IDS,
  nearestWetSample,
  sampleAtCell,
  isUsableSample,
  cellCenterLat,
  cellCenterLon
} from "../src/waveGrids.js";
import {
  planeKey,
  parseGribValidTime,
  gdalinfoBands,
  headerFromInfo,
  planFor,
  planRefusal,
  emptyGridStatus,
  sampleGridStatus,
  medianOf,
  validFractionOf,
  planeKeysFor,
  planeIdentityMismatches,
  beachesFromSnapshot
} from "../scripts/sample-waves.js";

const NODATA = 9999;

// A 5x5 lat/lon raster. Cell (r, c) has its CENTRE at
//   lon = originLon + (c + 0.5) * pixelLon
//   lat = originLat + (r + 0.5) * pixelLat
// so with the defaults below cell (2, 2) is centred exactly on (0, 0).
function header(overrides) {
  return Object.assign({
    width: 5,
    height: 5,
    originLon: -2.5,
    originLat: 2.5,
    pixelLon: 1,
    pixelLat: -1,
    nodata: NODATA
  }, overrides || {});
}

// A dry plane with the named cells set. cells is [[row, col, value], ...]. Every
// literal below is float32-exact (halves, quarters, eighths): a plane is a
// Float32Array, so 1.2 comes back as 1.2000000476837158 and an equality assertion on
// it fails for a reason that has nothing to do with the code under test.
function plane(h, cells) {
  const data = new Float32Array(h.width * h.height).fill(h.nodata);
  const list = cells || [];
  for (let i = 0; i < list.length; i = i + 1) {
    data[list[i][0] * h.width + list[i][1]] = list[i][2];
  }
  return data;
}

function grid(overrides) {
  return Object.assign({ id: "test", searchMaxKm: 200 }, overrides || {});
}

describe("isUsableSample", function () {
  it("rejects the gfswave sentinel", function () {
    expect(isUsableSample(9999, 9999)).toBe(false);
  });

  it("rejects the GLWU sentinel, which a hardcoded 9999 check would miss", function () {
    expect(isUsableSample(9.999000260554009e+20, 9.999000260554009e+20)).toBe(false);
    // The magnitude rail catches it even if the header nodata were wrong.
    expect(isUsableSample(9.999000260554009e+20, 9999)).toBe(false);
  });

  it("rejects a value equal to an ARBITRARY header nodata", function () {
    // The point of this case: the sentinel is read from the band header and never
    // hardcoded, so an ordinary-looking number is rejected when the header says so.
    expect(isUsableSample(3.5, 3.5)).toBe(false);
    expect(isUsableSample(3.6, 3.5)).toBe(true);
  });

  it("rejects non-finite and out-of-range values", function () {
    expect(isUsableSample(NaN, NODATA)).toBe(false);
    expect(isUsableSample(Infinity, NODATA)).toBe(false);
    expect(isUsableSample(-0.5, NODATA)).toBe(false);
    expect(isUsableSample(9001, NODATA)).toBe(false);
    expect(isUsableSample(0, NODATA)).toBe(true);
  });
});

describe("sampleAtCell", function () {
  it("returns null outside the raster rather than reading a neighbouring row", function () {
    const h = header();
    const data = plane(h, [[0, 0, 1.5], [0, 4, 2.5]]);
    expect(sampleAtCell(h, data, 0, 0)).toBe(1.5);
    // col -1 of row 1 would be the last cell of row 0 under a bare row*width+col.
    expect(sampleAtCell(h, data, 1, -1)).toBe(null);
    expect(sampleAtCell(h, data, 5, 0)).toBe(null);
    expect(sampleAtCell(h, data, 0, 5)).toBe(null);
  });
});

describe("nearestWetSample", function () {
  it("returns a ring-0 hit at the containing cell", function () {
    const h = header();
    const data = plane(h, [[2, 2, 1.5]]);
    const hit = nearestWetSample(grid(), h, data, 0, 0);
    expect(hit.value).toBe(1.5);
    expect(hit.ring).toBe(0);
    expect(hit.row).toBe(2);
    expect(hit.col).toBe(2);
    expect(hit.distanceKm).toBe(0);
  });

  it("picks the great-circle nearest ring-1 cell, not the first one in scan order",
    function () {
      // The Santa Monica shape: the NW cell is reached first by any dr-ascending scan
      // and is FARTHER than the W cell. First-hit-in-scan-order returns 0.90 here
      // where great-circle-minimum returns 0.66, and both are plausible numbers.
      const h = header();
      const data = plane(h, [[1, 1, 0.75], [2, 1, 0.5]]);
      const hit = nearestWetSample(grid(), h, data, 0, 0);
      expect(hit.value).toBe(0.5);
      expect(hit.row).toBe(2);
      expect(hit.col).toBe(1);
    });

  it("picks by great-circle rather than ring index at high latitude", function () {
    // At 70N a one-cell step east is ~38 km and a one-cell step north is ~111 km.
    // Both are ring 1, so a ring-index tie-break cannot tell them apart and any
    // dr-ascending scan reaches the northern cell first.
    const h = header({ originLat: 72.5 });
    const data = plane(h, [[1, 2, 3.0], [2, 3, 1.0]]);
    const east = distanceKm(70, 0, cellCenterLat(h, 2), cellCenterLon(h, 3));
    const north = distanceKm(70, 0, cellCenterLat(h, 1), cellCenterLon(h, 2));
    expect(east).toBeLessThan(north);
    const hit = nearestWetSample(grid(), h, data, 70, 0);
    expect(hit.value).toBe(1.0);
    expect(hit.row).toBe(2);
    expect(hit.col).toBe(3);
  });

  it("breaks an exact distance tie lexicographically by (dr, dc)", function () {
    const h = header();
    const data = plane(h, [[2, 1, 0.25], [2, 3, 0.75]]);
    const west = distanceKm(0, 0, cellCenterLat(h, 2), cellCenterLon(h, 1));
    const east = distanceKm(0, 0, cellCenterLat(h, 2), cellCenterLon(h, 3));
    expect(west).toBe(east);
    const hit = nearestWetSample(grid(), h, data, 0, 0);
    // dr is 0 for both, so the smaller dc (-1, the western cell) wins.
    expect(hit.col).toBe(1);
    expect(hit.value).toBe(0.25);
  });

  it("honours the km cap: a wet cell at ~26 km is refused under a 25 km cap", function () {
    const h = header({ pixelLon: 0.234, pixelLat: -0.234, originLon: -0.585, originLat: 0.585 });
    const data = plane(h, [[2, 3, 1.25]]);
    const away = distanceKm(0, 0, cellCenterLat(h, 2), cellCenterLon(h, 3));
    expect(away).toBeGreaterThan(25);
    expect(away).toBeLessThan(30);
    expect(nearestWetSample(grid({ searchMaxKm: 25 }), h, data, 0, 0)).toBe(null);
    expect(nearestWetSample(grid({ searchMaxKm: 30 }), h, data, 0, 0).value).toBe(1.25);
  });

  it("reads nothing out of bounds when the point sits in a corner cell", function () {
    const h = header();
    const data = plane(h, [[0, 1, 2.25]]);
    const hit = nearestWetSample(grid(), h, data, cellCenterLat(h, 0), cellCenterLon(h, 0));
    expect(hit.row).toBe(0);
    expect(hit.col).toBe(1);
    expect(hit.value).toBe(2.25);
  });

  it("returns null everywhere on a wholly dry grid", function () {
    const h = header();
    const data = plane(h, []);
    expect(nearestWetSample(grid(), h, data, 0, 0)).toBe(null);
    expect(nearestWetSample(grid(), h, data, 2, -2)).toBe(null);
  });

  it("refuses a sentinel-valued cell as if it were dry", function () {
    const h = header({ nodata: 9.999000260554009e+20 });
    const data = new Float32Array(h.width * h.height).fill(h.nodata);
    expect(nearestWetSample(grid(), h, data, 0, 0)).toBe(null);
  });

  it("resolves ONE cell that stays fixed across all 24 forecast hours", function () {
    // Hour 0 has two wet cells and the spiral picks the nearer one. Later hours mask
    // that cell and wet a DIFFERENT one: re-running the spiral per hour would jump to
    // it, which is exactly what must not happen.
    const h = header();
    const hour0 = plane(h, [[2, 1, 0.5], [1, 1, 4.0]]);
    const resolved = nearestWetSample(grid(), h, hour0, 0, 0);
    expect(resolved.row).toBe(2);
    expect(resolved.col).toBe(1);

    const readings = [];
    for (let hour = 0; hour < 24; hour = hour + 1) {
      const data = hour === 5
        ? plane(h, [[1, 1, 4.0]])
        : plane(h, [[2, 1, 0.5 + hour * 0.125], [1, 1, 4.0]]);
      readings.push(sampleAtCell(h, data, resolved.row, resolved.col));
      // A per-hour re-resolve at hour 5 would have picked (1, 1) and returned 4.0.
      if (hour === 5) {
        expect(nearestWetSample(grid(), h, data, 0, 0).row).toBe(1);
      }
    }
    expect(readings[0]).toBe(0.5);
    expect(readings[5]).toBe(null);
    expect(readings.length).toBe(24);
  });
});

describe("planeKey", function () {
  it("zero-pads the hour so a directory listing sorts by hour", function () {
    expect(planeKey("noaa_gfswave", 0, "HTSGW")).toBe("noaa_gfswave-h00-HTSGW");
    expect(planeKey("noaa_glwu", 23, "WIND")).toBe("noaa_glwu-h23-WIND");
  });
});

describe("parseGribValidTime", function () {
  it("reads the epoch seconds with or without a trailing unit word", function () {
    expect(parseGribValidTime("1788415200")).toBe(1788415200);
    expect(parseGribValidTime("1788415200 sec UTC")).toBe(1788415200);
    expect(parseGribValidTime(undefined)).toBe(null);
    expect(parseGribValidTime("not a time")).toBe(null);
  });
});

describe("gdalinfoBands / headerFromInfo", function () {
  function info() {
    return {
      size: [2160, 406],
      geoTransform: [-180.083333343214463, 0.166666686428902, 0,
        52.583333333333336, 0, -0.166666666666667],
      bands: [
        { band: 1, noDataValue: 9999,
          metadata: { "": { GRIB_ELEMENT: "WIND", GRIB_VALID_TIME: "1788415200" } } },
        { band: 2, noDataValue: 9999,
          metadata: { "": { GRIB_ELEMENT: "HTSGW", GRIB_VALID_TIME: "1788415200" } } }
      ]
    };
  }

  it("flattens the per-band element, valid time and nodata", function () {
    const bands = gdalinfoBands(info(), "test");
    expect(bands.length).toBe(2);
    expect(bands[0]).toEqual({ band: 1, element: "WIND", validTime: 1788415200, nodata: 9999 });
    expect(bands[1].element).toBe("HTSGW");
  });

  it("reads the raster geometry from gdalinfo's own geoTransform", function () {
    const h = headerFromInfo(info(), "test");
    expect(h.width).toBe(2160);
    expect(h.height).toBe(406);
    expect(h.originLon).toBe(-180.083333343214463);
    expect(h.originLat).toBe(52.583333333333336);
    expect(h.pixelLon).toBe(0.166666686428902);
    expect(h.pixelLat).toBe(-0.166666666666667);
    expect(h.nodata).toBe(9999);
  });

  it("throws on gdalinfo output it cannot read rather than guessing", function () {
    expect(function () { gdalinfoBands({}, "test"); }).toThrow();
    expect(function () { headerFromInfo({ size: [1, 1] }, "test"); }).toThrow();
  });
});

describe("planFor", function () {
  const VALID_START = 1788415200;

  function gridsReport() {
    const files = [];
    for (let hour = 0; hour < 24; hour = hour + 1) {
      files.push({ name: "f0" + (hour < 10 ? "0" : "") + String(hour) + ".grib2", hour: hour });
    }
    return {
      validStartEpoch: VALID_START,
      grids: {
        noaa_gfswave: { id: "noaa_gfswave", dir: "/w/noaa_gfswave", files: files }
      }
    };
  }

  function infos(shiftHour) {
    const out = {};
    const report = gridsReport();
    for (let hour = 0; hour < 24; hour = hour + 1) {
      const time = VALID_START + (hour === shiftHour ? hour + 1 : hour) * 3600;
      out["/w/noaa_gfswave/" + report.grids.noaa_gfswave.files[hour].name] = {
        size: [10, 10],
        geoTransform: [0, 1, 0, 0, 0, -1],
        bands: [
          { band: 1, noDataValue: 9999,
            metadata: { "": { GRIB_ELEMENT: "WIND", GRIB_VALID_TIME: String(time) } } },
          { band: 2, noDataValue: 9999,
            metadata: { "": { GRIB_ELEMENT: "HTSGW", GRIB_VALID_TIME: String(time) } } }
        ]
      };
    }
    return out;
  }

  it("plans two bands per forecast hour, discovered rather than assumed", function () {
    const plan = planFor(gridsReport(), infos(-1), VALID_START);
    expect(plan.problems).toEqual([]);
    expect(plan.entries.length).toBe(48);
    expect(plan.entries[0].element).toBe("HTSGW");
    expect(plan.entries[0].band).toBe(2);
    expect(plan.entries[1].element).toBe("WIND");
    expect(plan.entries[1].band).toBe(1);
    expect(plan.entries[0].expectedValidTime).toBe(VALID_START);
  });

  it("reports a problem when an hour's band carries the wrong valid time", function () {
    // This is the .idx off-by-one shape: every file is present and decodes, and the
    // series would be complete, plausible and silently shifted by an hour.
    const plan = planFor(gridsReport(), infos(7), VALID_START);
    expect(plan.problems.length).toBe(2);
    expect(plan.problems[0].indexOf("hour 7")).not.toBe(-1);
  });
});

// PER-GRID ISOLATION. A GLWU file that IS fetched and decodes but carries something
// the plan did not expect must cost the Great Lakes their waves and NOTHING ELSE.
// Refusing the whole cycle for it takes the ocean down with it, which is more data
// lost, not less — and the wave lane's failure mode is beaches aging out to unknown.
describe("planFor per-grid isolation", function () {
  const VALID_START = 1788415200;

  // gfswave is stepped: one file per forecast hour. GLWU is one whole file whose 24
  // hours are found by valid time.
  function report(options) {
    const opts = options || {};
    const files = [];
    for (let hour = 0; hour < 24; hour = hour + 1) {
      files.push({ name: "f0" + (hour < 10 ? "0" : "") + String(hour) + ".grib2", hour: hour });
    }
    const grids = {
      noaa_gfswave: { id: "noaa_gfswave", dir: "/w/noaa_gfswave", files: files }
    };
    if (opts.glwu !== false) {
      grids.noaa_glwu = Object.assign({
        id: "noaa_glwu", dir: "/w/noaa_glwu", files: [{ name: "glwu.grib2" }]
      }, opts.glwuEntry || {});
    }
    return { validStartEpoch: VALID_START, grids: grids };
  }

  function band(index, element, time) {
    return {
      band: index, noDataValue: 9999,
      metadata: { "": { GRIB_ELEMENT: element, GRIB_VALID_TIME: String(time) } }
    };
  }

  // dropElement/dropHour remove exactly one band from the GLWU file, which is the
  // decodable-but-unexpected shape: the file is real, it opens, and one thing the
  // plan wanted is not in it.
  function infos(options) {
    const opts = options || {};
    const out = {};
    const files = report().grids.noaa_gfswave.files;
    for (let hour = 0; hour < 24; hour = hour + 1) {
      out["/w/noaa_gfswave/" + files[hour].name] = {
        size: [10, 10], geoTransform: [0, 1, 0, 0, 0, -1],
        bands: [
          band(1, "WIND", VALID_START + hour * 3600),
          band(2, "HTSGW", VALID_START + hour * 3600)
        ]
      };
    }
    const glwuBands = [];
    for (let hour = 0; hour < 24; hour = hour + 1) {
      const time = VALID_START + hour * 3600;
      const elements = ["HTSGW", "WIND"];
      for (let e = 0; e < elements.length; e = e + 1) {
        if (opts.dropElement === elements[e] && opts.dropHour === hour) { continue; }
        glwuBands.push(band(glwuBands.length + 1, elements[e], time));
      }
    }
    out["/w/noaa_glwu/glwu.grib2"] = {
      size: [10, 10], geoTransform: [0, 1, 0, 0, 0, -1], bands: glwuBands
    };
    return out;
  }

  function entriesFor(plan, gridId) {
    const out = [];
    for (let i = 0; i < plan.entries.length; i = i + 1) {
      if (plan.entries[i].gridId === gridId) { out.push(plan.entries[i]); }
    }
    return out;
  }

  it("reports one entry per GRIDS member whatever the report contained", function () {
    const ids = [];
    for (let i = 0; i < GRIDS.length; i = i + 1) { ids.push(GRIDS[i].id); }
    const full = planFor(report(), infos(), VALID_START);
    expect(Object.keys(full.gridStatus).sort()).toEqual(ids.slice().sort());
    const empty = planFor({}, {}, VALID_START);
    expect(Object.keys(empty.gridStatus).sort()).toEqual(ids.slice().sort());
    expect(empty.gridStatus.noaa_gfswave.status).toBe("unfetched");
  });

  it("plans both grids when both are whole", function () {
    const plan = planFor(report(), infos(), VALID_START);
    expect(plan.problems).toEqual([]);
    expect(plan.gridStatus.noaa_gfswave.status).toBe("planned");
    expect(plan.gridStatus.noaa_glwu.status).toBe("planned");
    expect(plan.gridStatus.noaa_glwu.elements).toEqual(["HTSGW", "WIND"]);
    expect(entriesFor(plan, "noaa_glwu").length).toBe(48);
    expect(planRefusal(plan.entries, plan.gridStatus)).toBe(null);
  });

  it("calls a grid the fetch never produced unfetched, and plans the rest", function () {
    const plan = planFor(report({ glwu: false }), infos(), VALID_START);
    expect(plan.problems).toEqual([]);
    expect(plan.gridStatus.noaa_glwu.status).toBe("unfetched");
    expect(plan.gridStatus.noaa_glwu.elements).toEqual([]);
    expect(plan.gridStatus.noaa_gfswave.status).toBe("planned");
    expect(entriesFor(plan, "noaa_glwu").length).toBe(0);
    expect(entriesFor(plan, "noaa_gfswave").length).toBe(48);
    expect(planRefusal(plan.entries, plan.gridStatus)).toBe(null);
  });

  it("keeps a GLWU missing one WIND band planned for waves and drops only its WIND",
    function () {
      const plan = planFor(report(), infos({ dropElement: "WIND", dropHour: 6 }), VALID_START);
      expect(plan.gridStatus.noaa_glwu.status).toBe("planned");
      expect(plan.gridStatus.noaa_glwu.elements).toEqual(["HTSGW"]);
      expect(plan.gridStatus.noaa_glwu.reasons.length).toBeGreaterThan(0);
      const glwu = entriesFor(plan, "noaa_glwu");
      expect(glwu.length).toBe(24);
      for (let i = 0; i < glwu.length; i = i + 1) {
        expect(glwu[i].element).toBe("HTSGW");
      }
      // The ocean is untouched: this is the defect this isolation exists to fix.
      expect(entriesFor(plan, "noaa_gfswave").length).toBe(48);
      expect(plan.gridStatus.noaa_gfswave.reasons).toEqual([]);
      expect(planRefusal(plan.entries, plan.gridStatus)).toBe(null);
    });

  it("unplans a GLWU missing one HTSGW band entirely, ocean untouched", function () {
    const plan = planFor(report(), infos({ dropElement: "HTSGW", dropHour: 6 }), VALID_START);
    expect(plan.gridStatus.noaa_glwu.status).toBe("unplanned");
    expect(plan.gridStatus.noaa_glwu.reasons.length).toBeGreaterThan(0);
    expect(entriesFor(plan, "noaa_glwu").length).toBe(0);
    expect(entriesFor(plan, "noaa_gfswave").length).toBe(48);
    expect(planRefusal(plan.entries, plan.gridStatus)).toBe(null);
  });

  it("honours the workflow shell's usable:false marking", function () {
    const plan = planFor(
      report({ glwuEntry: { usable: false, unusableReason: "gdalinfo failed on glwu.grib2" } }),
      infos(), VALID_START);
    expect(plan.gridStatus.noaa_glwu.status).toBe("unplanned");
    expect(plan.gridStatus.noaa_glwu.reasons.join(" ").indexOf("gdalinfo failed on glwu.grib2"))
      .not.toBe(-1);
    expect(entriesFor(plan, "noaa_glwu").length).toBe(0);
    expect(entriesFor(plan, "noaa_gfswave").length).toBe(48);
  });

  it("refuses the cycle only for a required grid or an empty plan", function () {
    expect(REQUIRED_GRID_IDS).toContain("noaa_gfswave");
    const gfsOut = planFor(report(), infos(), VALID_START);
    gfsOut.gridStatus.noaa_gfswave.status = "unplanned";
    expect(planRefusal(gfsOut.entries, gfsOut.gridStatus)).not.toBe(null);
    const glwuOut = planFor(report(), infos({ dropElement: "HTSGW", dropHour: 6 }), VALID_START);
    expect(planRefusal(glwuOut.entries, glwuOut.gridStatus)).toBe(null);
    expect(planRefusal([], glwuOut.gridStatus)).not.toBe(null);
  });
});

describe("sampleGridStatus", function () {
  function planStatus(overrides) {
    const base = emptyGridStatus();
    const keys = Object.keys(overrides || {});
    for (let i = 0; i < keys.length; i = i + 1) {
      base[keys[i]] = Object.assign(base[keys[i]], overrides[keys[i]]);
    }
    return base;
  }

  it("upgrades a planned grid to sampled only when it produced stats", function () {
    const status = sampleGridStatus(
      planStatus({ noaa_gfswave: { status: "planned", elements: ["HTSGW", "WIND"] } }),
      { noaa_gfswave: { resolvedBeaches: 12 } });
    expect(status.noaa_gfswave.status).toBe("sampled");
    expect(status.noaa_glwu.status).toBe("unfetched");
  });

  it("reports a planned grid that sampled nothing as unplanned, never as a zero",
    function () {
      // A phantom "sampled" with no records is what would let the build gate score a
      // zero against that grid's seeded floor and refuse the whole cycle.
      const status = sampleGridStatus(
        planStatus({ noaa_glwu: { status: "planned", elements: ["HTSGW"] } }), {});
      expect(status.noaa_glwu.status).toBe("unplanned");
      expect(status.noaa_glwu.reasons.length).toBeGreaterThan(0);
    });

  it("carries an unfetched grid forward and keeps one entry per GRIDS member",
    function () {
      const ids = [];
      for (let i = 0; i < GRIDS.length; i = i + 1) { ids.push(GRIDS[i].id); }
      const status = sampleGridStatus(undefined, undefined);
      expect(Object.keys(status).sort()).toEqual(ids.slice().sort());
      expect(status.noaa_gfswave.status).toBe("unfetched");
    });
});

describe("medianOf / validFractionOf", function () {
  it("returns the median or null for an empty list", function () {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 2, 3])).toBe(2.5);
    expect(medianOf([])).toBe(null);
  });

  it("measures the usable fraction of a plane", function () {
    const h = header();
    const data = plane(h, [[0, 0, 1], [0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]]);
    expect(validFractionOf(h, data)).toBe(5 / 25);
    expect(validFractionOf(h, plane(h, []))).toBe(0);
  });
});

describe("beachesFromSnapshot", function () {
  it("reads the wrangler d1 --json envelope and drops rows with no coordinates",
    function () {
      const rows = beachesFromSnapshot([{
        results: [
          { id: "b1", lat: 42.4, lon: -86.29, water_class: "great_lake" },
          { id: "b2", lat: null, lon: -86.29, water_class: "ocean" },
          { id: "b3", lat: 34.0, lon: -118.5 }
        ]
      }]);
      expect(rows.length).toBe(2);
      expect(rows[0].id).toBe("b1");
      expect(rows[1].water_class).toBe(null);
    });

  it("returns an empty list for malformed input rather than throwing", function () {
    expect(beachesFromSnapshot(null)).toEqual([]);
    expect(beachesFromSnapshot({})).toEqual([]);
  });
});

describe("planeIdentityMismatches", function () {
  // The gate's committed identity describes the HOUR-0 wave plane alone. noaa_gfswave
  // downloads one file per forecast hour and each plane's geotransform comes from that
  // file, so a later hour can carry a shifted origin with identical dimensions,
  // decode cleanly, sample without error and pass every other gate while reading cells
  // from the wrong place.
  function plane(overrides) {
    return Object.assign({
      width: 2160, height: 406,
      originLon: -180.083333343214463, originLat: 52.583333333333336,
      pixelLon: 0.166666666, pixelLat: -0.166666666,
      nodata: 9999
    }, overrides || {});
  }

  function planes(overrides) {
    const info = {};
    for (let hour = 0; hour < 24; hour = hour + 1) {
      info[planeKey("noaa_gfswave", hour, "HTSGW")] = plane();
    }
    info[planeKey("noaa_gfswave", 0, "WIND")] = plane();
    if (overrides !== undefined) {
      info[overrides.key] = plane(overrides.patch);
    }
    return info;
  }

  it("finds nothing when every plane of a grid describes the same raster", function () {
    const info = planes();
    expect(planeIdentityMismatches(info, "noaa_gfswave", plane())).toEqual([]);
    expect(planeKeysFor(info, "noaa_gfswave").length).toBe(25);
  });

  it("names the hour and the field of a plane whose origin moved", function () {
    const info = planes({ key: "noaa_gfswave-h07-HTSGW", patch: { originLon: -179.75 } });
    const found = planeIdentityMismatches(info, "noaa_gfswave", plane());
    expect(found).toEqual(["noaa_gfswave-h07-HTSGW: originLon is -179.75, " +
      "expected -180.08333334321446"]);
  });

  it("compares the WIND plane and the nodata sentinel too", function () {
    const shifted = planeIdentityMismatches(
      planes({ key: "noaa_gfswave-h00-WIND", patch: { height: 405 } }),
      "noaa_gfswave", plane());
    expect(shifted).toEqual(["noaa_gfswave-h00-WIND: height is 405, expected 406"]);
    const sentinel = planeIdentityMismatches(
      planes({ key: "noaa_gfswave-h12-HTSGW", patch: { nodata: 9.999e20 } }),
      "noaa_gfswave", plane());
    expect(sentinel.length).toBe(1);
    expect(sentinel[0].indexOf("nodata is")).not.toBe(-1);
  });

  it("tolerates a large sentinel gdalinfo printed rounded", function () {
    // gdalinfo -json prints GLWU's nodata with about eight significant digits, so an
    // equality test would report a mismatch for a formatting difference.
    const info = {};
    info["noaa_glwu-h00-HTSGW"] = plane({ nodata: 9.999000260554009e+20 });
    info["noaa_glwu-h05-HTSGW"] = plane({ nodata: 9.99900026e+20 });
    expect(planeIdentityMismatches(info, "noaa_glwu",
      plane({ nodata: 9.999000260554009e+20 }))).toEqual([]);
  });

  it("does not mistake noaa_gfswave_arctic planes for noaa_gfswave ones", function () {
    // One id is a prefix of the other; matching on the bare id would fold the arctic
    // grid's warped raster into gfswave's comparison and refuse every cycle.
    const info = planes();
    info["noaa_gfswave_arctic-h00-HTSGW"] = plane({ width: 5, height: 5 });
    expect(planeIdentityMismatches(info, "noaa_gfswave", plane())).toEqual([]);
    expect(planeKeysFor(info, "noaa_gfswave_arctic")).toEqual(
      ["noaa_gfswave_arctic-h00-HTSGW"]);
  });

  it("reports every plane when there is no hour-0 header to compare against", function () {
    // A grid whose reference is missing must not read as a grid whose planes agree.
    const found = planeIdentityMismatches(planes(), "noaa_gfswave", null);
    expect(found.length).toBe(25);
    expect(found[0].indexOf("no hour-0 wave header")).not.toBe(-1);
    expect(planeIdentityMismatches(null, "noaa_gfswave", plane())).toEqual([]);
  });
});
