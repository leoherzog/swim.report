// test/waterClass.test.js
// Pure-function coverage for the water-body classifier (src/waterClass.js) and
// the Overpass water-class element parser + query/anchor builders
// (src/clients/overpass.js). Matched by QID, never by name; precedence
// ocean > great_lake > inland; a clean-but-empty answer is null (bumps
// attempts), a transient failure never reaches classifyWaterBody.

import { describe, it, expect } from "vitest";
import {
  classifyWaterBody,
  isGreatLakeQid,
  GREAT_LAKE_QIDS,
  WATER_CLASS_VERSION
} from "../src/waterClass.js";
import {
  parseWaterClassElements,
  buildWaterClassAnchor,
  buildWaterClassQuery,
  WATER_MIN_AREA_DEG2,
  OCEAN_RADIUS_M,
  GREAT_LAKE_RADIUS_M,
  INLAND_RADIUS_M
} from "../src/clients/overpass.js";

describe("classifyWaterBody", () => {
  it("Coney Island: a coastline signal classifies ocean", () => {
    expect(classifyWaterBody({ coastlinePresent: true })).toBe("ocean");
  });

  it("Lake Michigan: an allowlisted lake QID classifies great_lake", () => {
    expect(classifyWaterBody({ nearbyLakeQids: ["Q1169"] })).toBe("great_lake");
  });

  it("Fremont Lake: real nearby way-water with no coastline/allowlisted QID classifies inland", () => {
    expect(classifyWaterBody({ nearbyWayWater: true })).toBe("inland");
  });

  it("Sleeping Bear vertex-probe: the recurse-down probe yields Q1169 -> great_lake", () => {
    // The vertex probe succeeds where the empty-centroid / bbox-ring probe
    // returned nothing (contrast the all-empty case below -> null).
    expect(classifyWaterBody({
      coastlinePresent: false,
      nearbyLakeQids: ["Q1169"],
      nearbyWayWater: false
    })).toBe("great_lake");
  });

  it("precedence: ocean beats a co-present Great Lake QID", () => {
    expect(classifyWaterBody({ coastlinePresent: true, nearbyLakeQids: ["Q1169"] })).toBe("ocean");
  });

  it("a non-allowlisted lake with nearby way-water classifies inland", () => {
    expect(classifyWaterBody({ nearbyLakeQids: ["Q99999999"], nearbyWayWater: true })).toBe("inland");
  });

  it("all-empty signals -> null (the caller bumps attempts)", () => {
    expect(classifyWaterBody({})).toBeNull();
    expect(classifyWaterBody({ coastlinePresent: false, nearbyLakeQids: [], nearbyWayWater: false })).toBeNull();
  });

  it("null signals -> null (never throws)", () => {
    expect(classifyWaterBody(null)).toBeNull();
    expect(classifyWaterBody(undefined)).toBeNull();
  });
});

describe("isGreatLakeQid", () => {
  it("returns true for all six allowlisted QIDs", () => {
    for (const qid of Object.keys(GREAT_LAKE_QIDS)) {
      expect(isGreatLakeQid(qid)).toBe(true);
    }
    expect(Object.keys(GREAT_LAKE_QIDS).length).toBe(6);
  });

  it("returns false for a QID not in the set, empty, or a non-string", () => {
    expect(isGreatLakeQid("Q1")).toBe(false);
    expect(isGreatLakeQid("")).toBe(false);
    expect(isGreatLakeQid(null)).toBe(false);
    expect(isGreatLakeQid(1169)).toBe(false);
    expect(isGreatLakeQid(undefined)).toBe(false);
  });

  it("matches by QID, never by name: a pond whose QID is not in the set is false even if named 'Lake Superior'", () => {
    // Q9999 is the pond's own distinct QID; the name is irrelevant to the match.
    expect(isGreatLakeQid("Q9999")).toBe(false);
    expect(classifyWaterBody({ nearbyLakeQids: ["Q9999"], nearbyWayWater: true })).toBe("inland");
  });
});

describe("parseWaterClassElements", () => {
  function bb(minLat, minLon, maxLat, maxLon) {
    return { minlat: minLat, minlon: minLon, maxlat: maxLat, maxlon: maxLon };
  }

  it("a natural=coastline way sets coastlinePresent", () => {
    const s = parseWaterClassElements([
      { type: "way", id: 1, tags: { natural: "coastline" }, bounds: bb(41.0, -87.0, 41.1, -86.9) }
    ]);
    expect(s.coastlinePresent).toBe(true);
    expect(s.nearbyLakeQids).toEqual([]);
    expect(s.nearbyWayWater).toBe(false);
  });

  it("a water=lake relation carrying wikidata collects its QID", () => {
    const s = parseWaterClassElements([
      { type: "relation", id: 2, tags: { natural: "water", water: "lake", wikidata: "Q1169", name: "Lake Michigan" } }
    ]);
    expect(s.nearbyLakeQids).toEqual(["Q1169"]);
    expect(s.coastlinePresent).toBe(false);
  });

  it("a water=lake relation with no wikidata contributes no QID", () => {
    const s = parseWaterClassElements([
      { type: "relation", id: 3, tags: { natural: "water", water: "lake", name: "Some Lake" } }
    ]);
    expect(s.nearbyLakeQids).toEqual([]);
  });

  it("a natural=water way below WATER_MIN_AREA_DEG2 is NOT counted as inland", () => {
    // 0.001 x 0.001 = 1e-6 deg^2, below the 5e-6 pond threshold.
    const s = parseWaterClassElements([
      { type: "way", id: 4, tags: { natural: "water" }, bounds: bb(43.0, -86.0, 43.001, -85.999) }
    ]);
    expect(s.nearbyWayWater).toBe(false);
  });

  it("a natural=water way at/above WATER_MIN_AREA_DEG2 sets nearbyWayWater", () => {
    // 0.003 x 0.003 = 9e-6 deg^2, above the 5e-6 pond threshold.
    const s = parseWaterClassElements([
      { type: "way", id: 5, tags: { natural: "water" }, bounds: bb(43.0, -86.0, 43.003, -85.997) }
    ]);
    expect(s.nearbyWayWater).toBe(true);
    // Sanity: the threshold constant is the shared pond threshold.
    expect(WATER_MIN_AREA_DEG2).toBe(0.000005);
  });

  it("non-array / empty input yields an all-empty signals object", () => {
    expect(parseWaterClassElements([])).toEqual({
      coastlinePresent: false, nearbyLakeQids: [], nearbyWayWater: false
    });
    expect(parseWaterClassElements(null)).toEqual({
      coastlinePresent: false, nearbyLakeQids: [], nearbyWayWater: false
    });
  });

  it("a mixed element set combines all three signals", () => {
    const s = parseWaterClassElements([
      { type: "way", id: 1, tags: { natural: "coastline" }, bounds: bb(41.0, -87.0, 41.1, -86.9) },
      { type: "relation", id: 2, tags: { natural: "water", water: "lake", wikidata: "Q1383" } },
      { type: "way", id: 5, tags: { natural: "water" }, bounds: bb(43.0, -86.0, 43.003, -85.997) }
    ]);
    expect(s.coastlinePresent).toBe(true);
    expect(s.nearbyLakeQids).toEqual(["Q1383"]);
    expect(s.nearbyWayWater).toBe(true);
  });
});

describe("buildWaterClassAnchor / buildWaterClassQuery", () => {
  it("anchors a way and a relation on member vertices (recurse-down)", () => {
    expect(buildWaterClassAnchor("way/456")).toBe("way(456);>->.a;");
    expect(buildWaterClassAnchor("relation/2995932")).toBe("relation(2995932);>->.a;");
  });

  it("anchors a node on the point itself (no recurse-down)", () => {
    expect(buildWaterClassAnchor("node/123")).toBe("node(123)->.a;");
  });

  it("returns null for an unparseable id", () => {
    expect(buildWaterClassAnchor("banana")).toBeNull();
    expect(buildWaterClassAnchor("way/")).toBeNull();
    expect(buildWaterClassAnchor(null)).toBeNull();
    expect(buildWaterClassAnchor(1234)).toBeNull();
  });

  it("builds the vertex-probe query with the validated radii and out ids tags bb (never out geom)", () => {
    const q = buildWaterClassQuery("way/456");
    expect(q).toContain("way(456);>->.a;");
    expect(q).toContain("way[\"natural\"=\"coastline\"](around.a:" + String(OCEAN_RADIUS_M) + ");");
    expect(q).toContain("relation[\"natural\"=\"water\"][\"water\"=\"lake\"](around.a:" + String(GREAT_LAKE_RADIUS_M) + ");");
    expect(q).toContain("way[\"natural\"=\"water\"](around.a:" + String(INLAND_RADIUS_M) + ");");
    expect(q).toContain("out ids tags bb;");
    expect(q).not.toContain("out geom");
  });

  it("returns null when the id cannot be anchored", () => {
    expect(buildWaterClassQuery("nonsense")).toBeNull();
  });

  it("exposes the validated radius constants and a version integer", () => {
    expect(OCEAN_RADIUS_M).toBe(150);
    expect(GREAT_LAKE_RADIUS_M).toBe(150);
    expect(INLAND_RADIUS_M).toBe(120);
    expect(WATER_CLASS_VERSION).toBe(1);
  });
});
