// test/waterClass.test.js
// Pure-function coverage for the water-body DECISION layer (src/waterClass.js)
// alone. The probe that gathers its three signals is the layer pipeline's
// (src/layerSignals.js#waterClassSignals, covered in test/layerSignals.test.js);
// the probe radii it uses live in src/osmSelect.js and are pinned in
// test/osmSelect.test.js. Keeping the decision's tests here, with no probe
// import at all, is the point: it is what makes their invariance across the
// WATER_CLASS_VERSION bump real evidence that the decision layer did not move
// when the transport did. Matched by QID, never by name; precedence
// ocean > great_lake > inland; a clean-but-empty answer DECIDES inland (a
// complete probe that finds no water is a real negative), and only a transient
// failure — which never reaches classifyWaterBody — leaves a row pending.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  classifyWaterBody,
  isGreatLakeQid,
  isFlagWorthyWater,
  GREAT_LAKE_QIDS,
  WATER_CLASS_VERSION,
  WATER_CLASS_MAX_ATTEMPTS,
  FLAG_WORTHY_WATER_SQL
} from "../src/waterClass.js";

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

  it("all-empty signals -> inland: a COMPLETE probe finding no water is a decision, not a pending row", () => {
    // Regression (Locklin Pines Beach Park, way/1545732724): nearest water way
    // ~150 m out and pond-sized, Cross Lake ~300 m, so all three probes come back
    // empty. This used to return null, which bumped attempts and left the row
    // unclassified — and therefore VISIBLE under the FLAG_WORTHY_WATER_SQL
    // fail-open, showing an estimated flag card for an inland lake beach across
    // all 5 attempts. The probe is deterministic, so those retries could only
    // reach the same answer; decide it once.
    expect(classifyWaterBody({})).toBe("inland");
    expect(classifyWaterBody({ coastlinePresent: false, nearbyLakeQids: [], nearbyWayWater: false })).toBe("inland");
  });

  it("a non-allowlisted lake QID with NO qualifying way-water still classifies inland", () => {
    // Great Lakes allowlist miss + nothing else usable: still a decision.
    expect(classifyWaterBody({
      coastlinePresent: false, nearbyLakeQids: ["Q99999999"], nearbyWayWater: false
    })).toBe("inland");
  });

  it("a positive signal always beats the empty-case default", () => {
    // Guards the ordering: the clean-but-empty 'inland' fallthrough must never
    // shadow a real ocean/great_lake decision.
    expect(classifyWaterBody({ coastlinePresent: true, nearbyLakeQids: [], nearbyWayWater: false })).toBe("ocean");
    expect(classifyWaterBody({ coastlinePresent: false, nearbyLakeQids: ["Q1066"], nearbyWayWater: false })).toBe("great_lake");
  });

  it("only a MISSING signals object is null — the transient path the caller must not bump on", () => {
    expect(classifyWaterBody(null)).toBeNull();
    expect(classifyWaterBody(undefined)).toBeNull();
  });

  it("pins the decision layer's version integer", () => {
    // Relocated here from the query-text block: WATER_CLASS_VERSION versions
    // the DECISION this describe block covers, not the probe transport, and a
    // bump is what re-drains every already-classified row. Its home is beside
    // the rules it versions.
    //
    // 1 -> 2 on the move off Overpass. The rules above are byte-identical
    // either side of that bump — nothing in this block changed — but the
    // SIGNALS feeding them are now derived from clipped FlatGeobuf layers
    // rather than an anchored Overpass around: probe, so every already
    // classified row has to re-decide once against the new evidence.
    expect(WATER_CLASS_VERSION).toBe(2);
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

// The CLASSIFICATION half of the golden fixture.
//
// test/fixtures/overpass-golden.json carries 13 real water-class captures taken
// against the live Overpass mirrors before the layer migration: for each beach,
// the raw elements, the {coastlinePresent, nearbyLakeQids, nearbyWayWater}
// signals derived from them, and the verdict classifyWaterBody returned.
//
// The park/pond half of that fixture is replayed in test/osmSelect.test.js. This
// half had no replay at all, which left the fixture's classification captures as
// dead data — and classification is the side where a wrong answer HIDES a beach
// from the site (FLAG_WORTHY_WATER_SQL serves only ocean/great_lake plus
// under-cap NULLs), so it is the half that most needed a mechanical pin.
//
// SCOPE, stated honestly: this replays SIGNALS -> VERDICT, so it proves the
// decision tree is unchanged across the migration and across the
// WATER_CLASS_VERSION bump (which exists because the signals PROVIDER changed,
// not because the rules did). It does NOT prove ELEMENTS -> SIGNALS parity
// between the Overpass probe and the layer join — those two derivations read
// different inputs, and the contract's 9.3 dry-run diff over the full table is
// the intended proof of that half.
describe("overpass-golden fixture replay (water classification)", function () {
  const golden = JSON.parse(
    readFileSync(new URL("./fixtures/overpass-golden.json", import.meta.url), "utf8")
  );

  it("reproduces every recorded verdict from the real captured signals", function () {
    let replayed = 0;
    const mismatches = [];
    for (const capture of golden.waterClass) {
      if (!capture || !capture.signals || typeof capture.verdict !== "string") {
        continue;
      }
      replayed = replayed + 1;
      const got = classifyWaterBody(capture.signals);
      if (got !== capture.verdict) {
        mismatches.push(
          (capture.caseKey || capture.osmId || capture.name || "?") +
          ": expected " + capture.verdict + ", got " + String(got)
        );
      }
    }
    expect(mismatches).toEqual([]);
    // Guard against a silently emptied or restructured fixture making the loop
    // above vacuous — the same discipline the park-half replay uses.
    expect(replayed).toBe(13);
  });

  it("covers all three classes, so the replay is not one-branch coverage", function () {
    const seen = new Set();
    for (const capture of golden.waterClass) {
      if (capture && typeof capture.verdict === "string") {
        seen.add(capture.verdict);
      }
    }
    expect(seen.has("great_lake")).toBe(true);
    expect(seen.has("inland")).toBe(true);
  });
});
