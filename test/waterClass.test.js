// test/waterClass.test.js
// Pure-function coverage for the water-body classifier (src/waterClass.js) and
// the Overpass water-class element parser + query/anchor builders
// (src/clients/overpass.js). Matched by QID, never by name; precedence
// ocean > great_lake > inland; a clean-but-empty answer is null (bumps
// attempts), a transient failure never reaches classifyWaterBody.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  classifyWaterBody,
  isGreatLakeQid,
  isFlagWorthyWater,
  GREAT_LAKE_QIDS,
  WATER_CLASS_VERSION,
  WATER_CLASS_MAX_ATTEMPTS,
  FLAG_WORTHY_WATER_SQL
} from "../src/waterClass.js";
import {
  parseWaterClassElements,
  buildWaterClassAnchor,
  buildWaterClassQuery,
  fetchWaterClassSignals,
  WATER_MIN_AREA_DEG2,
  OCEAN_RADIUS_M,
  GREAT_LAKE_RADIUS_M,
  INLAND_RADIUS_M,
  OVERPASS_MIRRORS
} from "../src/clients/overpass.js";
import { installFetch, jsonResponse } from "./helpers/fetch.js";

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

  it("declares NO [maxsize] (inherits the 512 MiB default) — the lake-relation probe's execution memory must keep full headroom", () => {
    const q = buildWaterClassQuery("way/456");
    expect(q).toContain("[out:json][timeout:60];");
    expect(q).not.toContain("maxsize");
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

describe("fetchWaterClassSignals (transient null vs clean signals contract)", () => {
  // null = TRANSIENT (caller must NOT bump water_class_attempts, row stays
  // queued); a signals object = a CLEAN answer, the ONLY path that bumps
  // attempts (via classifyWaterBody returning null on all-empty signals).

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const EMPTY_SIGNALS = {
    coastlinePresent: false,
    nearbyLakeQids: [],
    nearbyWayWater: false
  };

  it("unparseable osm_id -> null with ZERO upstream fetches", async () => {
    const calls = installFetch(() => {
      return Promise.resolve(jsonResponse({ elements: [] }));
    });
    const result = await fetchWaterClassSignals({ id: 1, osm_id: "banana" });
    expect(result).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("every mirror failing (HTTP 504) -> null after trying each mirror once", async () => {
    const calls = installFetch(() => {
      return Promise.resolve({
        ok: false,
        status: 504,
        json: () => { return Promise.resolve({}); }
      });
    });
    const result = await fetchWaterClassSignals({ id: 2, osm_id: "way/456" });
    expect(result).toBeNull();
    expect(calls.length).toBe(OVERPASS_MIRRORS.length);
    expect(calls.map((c) => { return c.url; })).toEqual(OVERPASS_MIRRORS);
  });

  it("a clean HTTP-200 body with elements: [] -> the all-empty signals OBJECT, not null", async () => {
    // The whole contract: clean-but-empty is a real answer (bumps attempts
    // downstream), distinct from the transient-null no-bump path.
    const calls = installFetch(() => {
      return Promise.resolve(jsonResponse({ elements: [] }));
    });
    const result = await fetchWaterClassSignals({ id: 3, osm_id: "way/456" });
    expect(result).toEqual(EMPTY_SIGNALS);
    expect(result).not.toBeNull();
    // First mirror answered cleanly, so no failover happened.
    expect(calls.length).toBe(1);
    // And the clean-but-empty answer is exactly what makes classifyWaterBody
    // return null — the only attempts-bumping path.
    expect(classifyWaterBody(result)).toBeNull();
  });

  it("a truncation remark on every mirror -> null (partial data reads as transient)", async () => {
    const calls = installFetch(() => {
      return Promise.resolve(jsonResponse({
        remark: "runtime error: Query timed out",
        elements: [{ type: "way", id: 9, tags: { natural: "coastline" } }]
      }));
    });
    const result = await fetchWaterClassSignals({ id: 4, osm_id: "relation/2995932" });
    expect(result).toBeNull();
    // The remark made each mirror fall through in order before giving up.
    expect(calls.map((c) => { return c.url; })).toEqual(OVERPASS_MIRRORS);
  });

  it("a remark on the primary but a clean fallback -> the fallback's signals win", async () => {
    const calls = installFetch((url) => {
      if (url === OVERPASS_MIRRORS[0]) {
        return Promise.resolve(jsonResponse({ remark: "timed out", elements: [] }));
      }
      return Promise.resolve(jsonResponse({
        elements: [
          { type: "relation", id: 2, tags: { natural: "water", water: "lake", wikidata: "Q1169" } }
        ]
      }));
    });
    const result = await fetchWaterClassSignals({ id: 5, osm_id: "way/456" });
    expect(result).toEqual({
      coastlinePresent: false,
      nearbyLakeQids: ["Q1169"],
      nearbyWayWater: false
    });
    expect(calls.map((c) => { return c.url; })).toEqual(OVERPASS_MIRRORS);
  });
});

describe("isFlagWorthyWater / FLAG_WORTHY_WATER_SQL (request-path 404 gate)", () => {
  it("confirmed keepers are flag-worthy: ocean and great_lake", () => {
    expect(isFlagWorthyWater({ water_class: "ocean" })).toBe(true);
    expect(isFlagWorthyWater({ water_class: "great_lake" })).toBe(true);
  });

  it("confirmed inland is hidden", () => {
    expect(isFlagWorthyWater({ water_class: "inland" })).toBe(false);
  });

  it("NULL under the attempts cap stays visible (pending); at the cap it parks hidden", () => {
    expect(isFlagWorthyWater({ water_class: null, water_class_attempts: 0 })).toBe(true);
    expect(isFlagWorthyWater({
      water_class: null,
      water_class_attempts: WATER_CLASS_MAX_ATTEMPTS - 1
    })).toBe(true);
    expect(isFlagWorthyWater({
      water_class: null,
      water_class_attempts: WATER_CLASS_MAX_ATTEMPTS
    })).toBe(false);
  });

  it("a row missing the attempts column (or carrying a non-number) reads as 0 attempts -> visible", () => {
    // Older stub rows / pre-migration reads: undefined attempts must be
    // treated as NULL-pending, never as parked.
    expect(isFlagWorthyWater({ water_class: null })).toBe(true);
    expect(isFlagWorthyWater({ water_class: undefined })).toBe(true);
    expect(isFlagWorthyWater({ water_class: null, water_class_attempts: "3" })).toBe(true);
  });

  it("no beach at all -> false, never throws", () => {
    expect(isFlagWorthyWater(null)).toBe(false);
    expect(isFlagWorthyWater(undefined)).toBe(false);
    expect(isFlagWorthyWater(false)).toBe(false);
  });

  it("FLAG_WORTHY_WATER_SQL is the exact shared fragment, keeping the SQL and its JS mirror in lockstep", () => {
    // A WATER_CLASS_MAX_ATTEMPTS bump must visibly change BOTH the SQL
    // fragment and isFlagWorthyWater together — this pins the current pair.
    expect(FLAG_WORTHY_WATER_SQL).toBe(
      "(water_class IN ('ocean','great_lake') OR (water_class IS NULL AND water_class_attempts < 5))"
    );
    expect(FLAG_WORTHY_WATER_SQL).toContain(
      "water_class_attempts < " + String(WATER_CLASS_MAX_ATTEMPTS)
    );
  });
});
