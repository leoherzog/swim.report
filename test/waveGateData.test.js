// Tests for the committed wave gate data, data/wave-floors.json and
// data/wave-grids.json, against the GRIDS table they describe.
//
// Nothing else under test/ reads either file, and both failure modes are silent in
// production. A grid set with no floors entry withholds auto-publish: the scheduled
// cycle goes green with one annotation while every waveinput: key on the site expires
// on its 24 h lease. A grid with no committed identity block refuses the cycle
// outright, before any artifact uploads. A grid missing from a floors entry's grids
// map is worse than either, because perGridFloorRefusals and perGridFloorStatus both
// iterate that map rather than GRIDS: the grid is unfloored forever with no refusal,
// no warning and not even a "not evaluated" line.
//
// A failure here means the committed data is wrong, not the assertion.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GRIDS, gridsDigest } from "../src/waveGrids.js";

function readGateData(name) {
  return JSON.parse(readFileSync(new URL("../data/" + name, import.meta.url), "utf8"));
}

function gridIds() {
  return GRIDS.map(function (g) { return g.id; });
}

describe("data/wave-floors.json", function () {
  it("carries an entry for the current grid set", async function () {
    // Keyed by digest, so a grid, a cap, a domain edge or a water-class list moving
    // without a matching entry is exactly the unseeded state this asserts against.
    const digest = await gridsDigest();
    const entry = readGateData("wave-floors.json").floors[digest];
    expect(entry, "no floors entry for " + digest).toBeDefined();
    expect(["seeded", "bootstrap"]).toContain(entry.status);
  });

  it("floors every grid the pipeline can publish", async function () {
    const digest = await gridsDigest();
    const entry = readGateData("wave-floors.json").floors[digest] || {};
    const grids = entry.grids || {};
    const ids = gridIds();
    for (let i = 0; i < ids.length; i = i + 1) {
      expect(Object.prototype.hasOwnProperty.call(grids, ids[i]),
        ids[i] + " has no key in the floors entry").toBe(true);
    }
  });

  it("floors nothing the grid set does not contain", async function () {
    // A typo'd id is a floor on nothing, which reads in the manifest exactly like a
    // floor that passed.
    const digest = await gridsDigest();
    const entry = readGateData("wave-floors.json").floors[digest] || {};
    const keys = Object.keys(entry.grids || {});
    for (let i = 0; i < keys.length; i = i + 1) {
      expect(gridIds()).toContain(keys[i]);
    }
  });

  it("is either wholly seeded from a measured cycle or wholly pending", async function () {
    // floorsEntryFor treats any status but "seeded" as withheld, so bootstrap and
    // absent behave alike. What must never appear is a half-seeded entry: a number
    // scaled from an unobserved count either blocks every cycle forever or blesses a
    // broken one, and a seeded entry carrying nulls silently retires those floors.
    const digest = await gridsDigest();
    const entry = readGateData("wave-floors.json").floors[digest] || {};
    const grids = entry.grids || {};
    const keys = Object.keys(grids);
    const seeded = entry.status === "seeded";
    expect(keys.length).toBeGreaterThan(0);
    for (let i = 0; i < keys.length; i = i + 1) {
      if (seeded) {
        expect(typeof grids[keys[i]], keys[i] + " floor").toBe("number");
        expect(grids[keys[i]]).toBeGreaterThan(0);
      } else {
        expect(grids[keys[i]], keys[i] + " floor is not measured yet").toBe(null);
      }
    }
    const totals = ["waveinputRecords", "wavesRecords"];
    for (let t = 0; t < totals.length; t = t + 1) {
      if (seeded) {
        expect(typeof entry[totals[t]], totals[t]).toBe("number");
        expect(entry[totals[t]]).toBeGreaterThan(0);
        expect(typeof entry.seededFromCycleId).toBe("string");
      } else {
        expect(entry[totals[t]], totals[t] + " is not measured yet").toBe(null);
        expect(entry.seededFromCycleId).toBe(null);
      }
    }
  });
});

describe("data/wave-grids.json", function () {
  it("commits an identity expectation for every grid", function () {
    const grids = readGateData("wave-grids.json").grids;
    const ids = gridIds();
    for (let i = 0; i < ids.length; i = i + 1) {
      const committed = grids[ids[i]];
      expect(committed, ids[i] + " has no committed expectation").toBeDefined();
      expect(committed.sampled).toBeDefined();
    }
  });

  it("commits the same raster description the sampler assumes", function () {
    // The gate compares this file against the DECODED raster, never against GRIDS, so
    // this is commit hygiene rather than the gate checking the producer against
    // itself: the two copies are meant to move in one reviewed commit, and a grid
    // whose sampled block drifts from its expectation refuses every cycle
    // non-overridably.
    const grids = readGateData("wave-grids.json").grids;
    const fields = ["width", "height", "originLon", "originLat", "pixelLon",
      "pixelLat", "nodata"];
    for (let i = 0; i < GRIDS.length; i = i + 1) {
      const committed = (grids[GRIDS[i].id] || {}).sampled || {};
      for (let f = 0; f < fields.length; f = f + 1) {
        expect(committed[fields[f]], GRIDS[i].id + "." + fields[f])
          .toBe(GRIDS[i].sampled[fields[f]]);
      }
    }
  });
});
