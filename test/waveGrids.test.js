// Tests for src/waveGrids.js — the grid table, its digest, and the water_class
// constrained ordered fallthrough that decides which NOAA grid answers for a beach.
//
// The failures these guard are all SILENT. A 'great_lake' beach reaching a gfswave
// grid, or an 'ocean' beach reaching the lakes model, produces a plausible wave
// height from the wrong body of water with no error anywhere. A digest that fails to
// move when a cap or a domain moves means the seeded coverage floors in
// data/wave-floors.json keep vouching for a grid set they were never measured under.

import { describe, it, expect } from "vitest";
import {
  GRIDS,
  REQUIRED_GRID_IDS,
  METERS_PER_SECOND_TO_MPH,
  metersPerSecondToMph,
  gridById,
  gridsDigestInput,
  gridsDigest,
  containsPoint,
  waterClassAllowsGrid,
  candidateGrids,
  selectGrid,
  nearestWetSample
} from "../src/waveGrids.js";
import { WAVE_MODEL_IDS, waveSourceLabel } from "../src/waveModels.js";

// A beach in Lake Michigan, inside the GLWU window and also inside gfswave global.
const LAKE_BEACH = { id: "b-lake", lat: 42.4, lon: -86.29, water_class: "great_lake" };
// Santa Monica: ocean, inside gfswave global, outside the GLWU window.
const OCEAN_BEACH = { id: "b-ocean", lat: 34.01, lon: -118.5, water_class: "ocean" };
// An Alaskan beach above gfswave global's 52.583N ceiling.
const ARCTIC_BEACH = { id: "b-arctic", lat: 60.5, lon: -151.4, water_class: "ocean" };

function alwaysProbe() {
  return true;
}

describe("GRIDS", function () {
  it("is exactly the three grids, in fallthrough order", function () {
    const ids = GRIDS.map(function (g) { return g.id; });
    expect(ids).toEqual(["noaa_glwu", "noaa_gfswave", "noaa_gfswave_arctic"]);
  });

  it("carries no superseded regional grid", function () {
    const ids = GRIDS.map(function (g) { return g.id; });
    // global.0p16 supersedes wcoast/atlocn/epacif; epacif's 0-360 longitudes are a
    // silent-empty-sample trap and global.0p25 is 11x the bytes for less resolution.
    expect(ids.join(",").indexOf("wcoast")).toBe(-1);
    expect(ids.join(",").indexOf("atlocn")).toBe(-1);
    expect(ids.join(",").indexOf("epacif")).toBe(-1);
  });

  it("names the sr GLWU grid, not the lake-connecting-channels variant", function () {
    const glwu = gridById("noaa_glwu");
    expect(glwu.urlTemplate.indexOf("grlc_2p5km_sr")).not.toBe(-1);
    expect(glwu.urlTemplate.indexOf("grlc_2p5km_lc_sr")).toBe(-1);
  });

  // REQUIRED_GRID_IDS is the hinge of four separate refusals — the fetch, the band
  // plan, the workflow shell and the manifest rail. Emptying it makes every grid
  // optional and a cycle carrying no gfswave data publishes.
  it("requires exactly the global ocean grid", function () {
    expect(REQUIRED_GRID_IDS).toEqual(["noaa_gfswave"]);
  });

  it("requires only ids that resolve, so no refusal can be disarmed by a typo", function () {
    expect(REQUIRED_GRID_IDS.length).toBeGreaterThan(0);
    for (let i = 0; i < REQUIRED_GRID_IDS.length; i = i + 1) {
      expect(gridById(REQUIRED_GRID_IDS[i])).not.toBe(null);
    }
  });
});

// A grid id travels from here into every waveinput: record's 'model', and the
// Worker reads it back through src/waveModels.js. The two files are on opposite
// sides of the two-path boundary and neither imports the other, so a grid added
// here without a label there degrades SILENTLY: the flag card falls back to the
// generic "Wave Forecast" chip and the detail chart's legend renders the raw id
// to visitors. test/waveModels.test.js carries the second half of the chain
// (every labelled id is nameable in the strip); this is the first half.
describe("every grid id the pipeline can publish is labelled in the Worker", function () {
  it("has a waveModels.js label for each GRIDS id", function () {
    for (let i = 0; i < GRIDS.length; i = i + 1) {
      expect(waveSourceLabel(GRIDS[i].id)).not.toBe("Wave Forecast");
    }
  });

  it("labels no id the pipeline cannot publish", function () {
    const gridIds = GRIDS.map(function (g) { return g.id; });
    for (let i = 0; i < WAVE_MODEL_IDS.length; i = i + 1) {
      expect(gridIds).toContain(WAVE_MODEL_IDS[i]);
    }
  });
});

describe("metersPerSecondToMph", function () {
  it("uses the exact 3600/1609.344 ratio", function () {
    expect(METERS_PER_SECOND_TO_MPH).toBe(2.2369362920544);
    expect(metersPerSecondToMph(1)).toBe(2.2369362920544);
  });

  it("passes null and undefined through as null", function () {
    expect(metersPerSecondToMph(null)).toBe(null);
    expect(metersPerSecondToMph(undefined)).toBe(null);
  });
});

describe("containsPoint", function () {
  it("is true inside a domain and false outside it", function () {
    expect(containsPoint(gridById("noaa_glwu"), 42.4, -86.29)).toBe(true);
    expect(containsPoint(gridById("noaa_glwu"), 34.01, -118.5)).toBe(false);
  });

  it("is false for malformed input rather than throwing", function () {
    expect(containsPoint(null, 42, -86)).toBe(false);
    expect(containsPoint(gridById("noaa_glwu"), null, -86)).toBe(false);
  });
});

describe("waterClassAllowsGrid", function () {
  it("confines great_lake to the lakes model", function () {
    expect(waterClassAllowsGrid("great_lake", gridById("noaa_glwu"))).toBe(true);
    expect(waterClassAllowsGrid("great_lake", gridById("noaa_gfswave"))).toBe(false);
    expect(waterClassAllowsGrid("great_lake", gridById("noaa_gfswave_arctic"))).toBe(false);
  });

  it("confines ocean to the two gfswave grids", function () {
    expect(waterClassAllowsGrid("ocean", gridById("noaa_glwu"))).toBe(false);
    expect(waterClassAllowsGrid("ocean", gridById("noaa_gfswave"))).toBe(true);
    expect(waterClassAllowsGrid("ocean", gridById("noaa_gfswave_arctic"))).toBe(true);
  });

  it("lets a NULL water_class try every grid", function () {
    expect(waterClassAllowsGrid(null, gridById("noaa_glwu"))).toBe(true);
    expect(waterClassAllowsGrid(null, gridById("noaa_gfswave"))).toBe(true);
    expect(waterClassAllowsGrid(undefined, gridById("noaa_gfswave_arctic"))).toBe(true);
    expect(waterClassAllowsGrid("", gridById("noaa_glwu"))).toBe(true);
  });

  it("gates both directions, so neither arm may be short-circuited away", function () {
    // The lake direction happens to be covered a second time by gfswave's land
    // mask. The ocean direction is covered by this gate alone: nothing stops an
    // ocean beach inside the GLWU window from sampling the lakes model if it
    // goes.
    expect(waterClassAllowsGrid("ocean", gridById("noaa_glwu"))).toBe(false);
    expect(waterClassAllowsGrid("great_lake", gridById("noaa_gfswave"))).toBe(false);
  });

  it("permits a grid that declares no waterClasses list at all", function () {
    expect(waterClassAllowsGrid("ocean", { id: "unconstrained" })).toBe(true);
    expect(waterClassAllowsGrid("great_lake", { id: "x", waterClasses: null })).toBe(true);
  });

  it("is false for a non-object grid rather than throwing", function () {
    expect(waterClassAllowsGrid("ocean", null)).toBe(false);
    expect(waterClassAllowsGrid(null, undefined)).toBe(false);
  });
});

// A NULL water_class is reachable between discovery and classification, on a
// WATER_CLASS_VERSION bump, and in the layer manifest's scope_or_stale tier. What
// keeps such a beach off ocean values on a lake is not the water_class gate — the
// gate lets it through — but ORDER plus gfswave's land mask.
describe("the NULL water_class fallthrough at a Great Lakes beach", function () {
  // Chicago 63rd Street Beach: inside the GLWU window and inside gfswave global.
  const PENDING_LAKE_BEACH = { id: "b-63rd", lat: 41.78, lon: -87.58, water_class: null };

  it("offers GLWU before gfswave, so the lake model answers first", function () {
    const ids = candidateGrids(PENDING_LAKE_BEACH, GRIDS).map(function (g) { return g.id; });
    expect(ids).toEqual(["noaa_glwu", "noaa_gfswave"]);
  });

  it("resolves on GLWU when GLWU has a wet cell", function () {
    expect(selectGrid(PENDING_LAKE_BEACH, GRIDS, alwaysProbe).id).toBe("noaa_glwu");
  });
});

// The second line of defence, measured: gfswave global.0p16 masks the Great Lakes
// as land, so the nearest wet cell is hundreds of km away against a 25 km cap and
// the spiral gives up. The plane is synthetic — the assertion is about the
// SAMPLER's behaviour over a masked neighbourhood, not about decoding a real GRIB.
describe("nearestWetSample over a masked gfswave plane", function () {
  const gfswave = gridById("noaa_gfswave");
  const header = gfswave.sampled;
  // Real gfswave geotransform and extent; every cell holds the 9999 nodata sentinel.
  const masked = new Float32Array(header.width * header.height).fill(header.nodata);

  // Mid-lake points, one per Great Lake.
  const MID_LAKE = [
    ["Michigan", 43.5, -87.0],
    ["Superior", 47.5, -87.5],
    ["Huron", 44.8, -82.3],
    ["Erie", 42.15, -81.2],
    ["Ontario", 43.6, -77.8]
  ];

  for (const point of MID_LAKE) {
    it("returns null mid-lake in " + point[0], function () {
      expect(nearestWetSample(gfswave, header, masked, point[1], point[2])).toBe(null);
    });
  }

  it("is not vacuously null: one wet cell at the containing cell is found", function () {
    const lat = 43.5;
    const lon = -87.0;
    const col = Math.floor((lon - header.originLon) / header.pixelLon);
    const row = Math.floor((lat - header.originLat) / header.pixelLat);
    const plane = new Float32Array(header.width * header.height).fill(header.nodata);
    plane[row * header.width + col] = 1.25;
    const hit = nearestWetSample(gfswave, header, plane, lat, lon);
    expect(hit.value).toBe(1.25);
    expect(hit.row).toBe(row);
    expect(hit.col).toBe(col);
    expect(hit.ring).toBe(0);
  });

  it("stops at searchMaxKm — a wet cell five cells east is out of reach", function () {
    const lat = 43.5;
    const lon = -87.0;
    const col = Math.floor((lon - header.originLon) / header.pixelLon);
    const row = Math.floor((lat - header.originLat) / header.pixelLat);
    const plane = new Float32Array(header.width * header.height).fill(header.nodata);
    // One cell east is 13.4 km and inside the 25 km cap; five is 67 km and outside.
    plane[row * header.width + (col + 5)] = 1.25;
    expect(nearestWetSample(gfswave, header, plane, lat, lon)).toBe(null);
    plane[row * header.width + (col + 1)] = 2.5;
    const hit = nearestWetSample(gfswave, header, plane, lat, lon);
    expect(hit.value).toBe(2.5);
    expect(hit.ring).toBe(1);
  });
});

describe("selectGrid", function () {
  it("never routes a great_lake beach to a gfswave grid", function () {
    const grid = selectGrid(LAKE_BEACH, GRIDS, alwaysProbe);
    expect(grid.id).toBe("noaa_glwu");
    const ids = candidateGrids(LAKE_BEACH, GRIDS).map(function (g) { return g.id; });
    expect(ids).toEqual(["noaa_glwu"]);
  });

  it("never routes an ocean beach to the lakes model", function () {
    // These coordinates are inside the GLWU window, so only water_class keeps the
    // beach off it — which is the whole point of the constraint.
    const lakeBoxOcean = { id: "b-x", lat: 42.4, lon: -86.29, water_class: "ocean" };
    const ids = candidateGrids(lakeBoxOcean, GRIDS).map(function (g) { return g.id; });
    expect(ids.indexOf("noaa_glwu")).toBe(-1);
    expect(ids).toEqual(["noaa_gfswave"]);
  });

  it("prefers glwu for a NULL water_class inside the lakes window", function () {
    const pending = { id: "b-null", lat: 42.4, lon: -86.29, water_class: null };
    expect(selectGrid(pending, GRIDS, alwaysProbe).id).toBe("noaa_glwu");
  });

  it("falls through to the next containing grid when the first search fails", function () {
    const pending = { id: "b-null", lat: 42.4, lon: -86.29, water_class: null };
    const refuseGlwu = function (grid) { return grid.id !== "noaa_glwu"; };
    expect(selectGrid(pending, GRIDS, refuseGlwu).id).toBe("noaa_gfswave");
  });

  it("yields null when every candidate grid fails its search", function () {
    const refuseAll = function () { return false; };
    expect(selectGrid(OCEAN_BEACH, GRIDS, refuseAll)).toBe(null);
  });

  it("yields null for a point outside every domain", function () {
    // South Atlantic, below gfswave global's -15.083 floor and outside both others.
    const nowhere = { id: "b-none", lat: -40.0, lon: -30.0, water_class: "ocean" };
    expect(candidateGrids(nowhere, GRIDS)).toEqual([]);
    expect(selectGrid(nowhere, GRIDS, alwaysProbe)).toBe(null);
  });

  it("routes an Alaskan ocean beach to the arctic grid, which global.0p16 cannot reach",
    function () {
      expect(containsPoint(gridById("noaa_gfswave"), ARCTIC_BEACH.lat, ARCTIC_BEACH.lon))
        .toBe(false);
      expect(selectGrid(ARCTIC_BEACH, GRIDS, alwaysProbe).id).toBe("noaa_gfswave_arctic");
    });
});

describe("gridsDigest", function () {
  it("is stable across a reordering of the array", async function () {
    const reordered = [GRIDS[2], GRIDS[0], GRIDS[1]];
    expect(gridsDigestInput(reordered)).toBe(gridsDigestInput(GRIDS));
    expect(await gridsDigest(reordered)).toBe(await gridsDigest(GRIDS));
  });

  it("changes when a search cap moves", async function () {
    const moved = GRIDS.map(function (g) {
      return g.id === "noaa_glwu" ? Object.assign({}, g, { searchMaxKm: 11 }) : g;
    });
    expect(await gridsDigest(moved)).not.toBe(await gridsDigest(GRIDS));
  });

  it("changes when a domain edge moves", async function () {
    const moved = GRIDS.map(function (g) {
      if (g.id !== "noaa_gfswave") { return g; }
      return Object.assign({}, g, {
        domain: Object.assign({}, g.domain, { maxLat: 53.0 })
      });
    });
    expect(await gridsDigest(moved)).not.toBe(await gridsDigest(GRIDS));
  });

  it("changes when a cell size moves", async function () {
    const moved = GRIDS.map(function (g) {
      if (g.id !== "noaa_glwu") { return g; }
      return Object.assign({}, g, {
        sampled: Object.assign({}, g.sampled, { pixelLon: 0.025 })
      });
    });
    expect(await gridsDigest(moved)).not.toBe(await gridsDigest(GRIDS));
  });

  it("does not change when a display label is edited", async function () {
    const relabelled = GRIDS.map(function (g) {
      return Object.assign({}, g, { label: g.label + " (revised)" });
    });
    expect(await gridsDigest(relabelled)).toBe(await gridsDigest(GRIDS));
  });

  it("throws on a malformed grid rather than digesting to something plausible",
    function () {
      expect(function () { gridsDigestInput([]); }).toThrow();
      expect(function () { gridsDigestInput([{ id: "x" }]); }).toThrow();
    });
});
