// test/usgsGreatLakesNowcast.test.js
// Pure-parser unit tests for the USGS Great Lakes NowCast water-quality floor
// source. No network — every case builds inline JSON fixtures modeled on the
// live getbeaches.php / getconditions.php responses. Project style: ES modules,
// NO template literals (string concat with +), function () {} callbacks.

import { describe, it, expect } from "vitest";
import {
  normalizeNowcastCondition,
  deriveNowcastQueryDate,
  parseNowcastBeaches,
  parseNowcastConditions,
  buildNowcastFloorSites,
  usgsGreatLakesNowcast
} from "../src/wqFloor/usgsGreatLakesNowcast.js";

const NOW_ISO = "2026-07-22T12:00:00Z";

// A roster fixture mirroring getbeaches.php (LATITUDE/LONGITUDE are strings).
function beachesFixture() {
  return JSON.stringify([
    { COOP_ID: "COUNTY_CUYAHOGA", BEACH_NAME: "Edgewater", LATITUDE: "41.4906", LONGITUDE: "-81.7370", STATE: "OH" },
    { COOP_ID: "COUNTY_SUMMIT", BEACH_NAME: "Cuyahoga", LATITUDE: "41.1400", LONGITUDE: "-81.5100", STATE: "OH" },
    { COOP_ID: "COUNTY_ERIENY", BEACH_NAME: "Evans Town", LATITUDE: "42.642198", LONGITUDE: "-79.065643", STATE: "NY" },
    { COOP_ID: "COUNTY_ERIEPA", BEACH_NAME: "Presque Isle Beach 1", LATITUDE: "42.1600", LONGITUDE: "-80.1100", STATE: "PA" },
    { COOP_ID: "COUNTY_LAKE", BEACH_NAME: "Fairport", LATITUDE: "41.7600", LONGITUDE: "-81.2800", STATE: "OH" },
    { COOP_ID: "COUNTY_MONROE", BEACH_NAME: "Sterling", LATITUDE: "41.9000", LONGITUDE: "-83.3400", STATE: "MI" }
  ]);
}

describe("normalizeNowcastCondition", function () {
  it("maps Advisory to yellow", function () {
    expect(normalizeNowcastCondition("Advisory")).toBe("yellow");
  });

  it("maps Closed to yellow (bacteria closure is never a hazard red)", function () {
    expect(normalizeNowcastCondition("Closed")).toBe("yellow");
  });

  it("is case-insensitive and trims whitespace", function () {
    expect(normalizeNowcastCondition("  ADVISORY ")).toBe("yellow");
    expect(normalizeNowcastCondition("closed")).toBe("yellow");
  });

  it("returns null for Good, blank, and unrecognized values", function () {
    expect(normalizeNowcastCondition("Good")).toBe(null);
    expect(normalizeNowcastCondition("")).toBe(null);
    expect(normalizeNowcastCondition("Unknown")).toBe(null);
  });

  it("returns null for non-string input", function () {
    expect(normalizeNowcastCondition(null)).toBe(null);
    expect(normalizeNowcastCondition(undefined)).toBe(null);
    expect(normalizeNowcastCondition(3)).toBe(null);
  });
});

describe("deriveNowcastQueryDate", function () {
  it("extracts the YYYY-MM-DD prefix from an ISO timestamp", function () {
    expect(deriveNowcastQueryDate("2026-07-22T12:00:00Z")).toBe("2026-07-22");
    expect(deriveNowcastQueryDate("2026-07-22")).toBe("2026-07-22");
  });

  it("returns null for a non-ISO or non-string value", function () {
    expect(deriveNowcastQueryDate("not-a-date")).toBe(null);
    expect(deriveNowcastQueryDate("")).toBe(null);
    expect(deriveNowcastQueryDate(null)).toBe(null);
    expect(deriveNowcastQueryDate(1234)).toBe(null);
  });
});

describe("parseNowcastBeaches", function () {
  it("parses roster rows with string coordinates into numbers", function () {
    const rows = parseNowcastBeaches(beachesFixture());
    expect(Array.isArray(rows)).toBe(true);
    const edge = rows.find(function (r) { return r.beachName === "Edgewater"; });
    expect(edge.lat).toBe(41.4906);
    expect(edge.lon).toBe(-81.737);
    expect(edge.state).toBe("OH");
    expect(edge.key).toBe("county_cuyahoga|edgewater");
  });

  it("skips rows with missing or non-finite coordinates", function () {
    const text = JSON.stringify([
      { COOP_ID: "C1", BEACH_NAME: "Good One", LATITUDE: "42.0", LONGITUDE: "-80.0", STATE: "OH" },
      { COOP_ID: "C2", BEACH_NAME: "No Coords", LATITUDE: "", LONGITUDE: "", STATE: "OH" },
      { COOP_ID: "C3", BEACH_NAME: "Bad Coords", LATITUDE: "abc", LONGITUDE: "-80.0", STATE: "OH" }
    ]);
    const rows = parseNowcastBeaches(text);
    expect(rows.length).toBe(1);
    expect(rows[0].beachName).toBe("Good One");
  });

  it("returns null for a non-array body, garbage, empty string, and empty array", function () {
    expect(parseNowcastBeaches("{}")).toBe(null);
    expect(parseNowcastBeaches("<<< not json >>>")).toBe(null);
    expect(parseNowcastBeaches("")).toBe(null);
    expect(parseNowcastBeaches(null)).toBe(null);
    expect(parseNowcastBeaches("[]")).toBe(null);
  });
});

describe("parseNowcastConditions", function () {
  it("parses condition rows and drops rows without a valid ISO DATE", function () {
    const text = JSON.stringify([
      { COOP_ID: "C1", BEACH_NAME: "A", BEACH_CONDITIONS: "Advisory", DATE: "2026-07-19" },
      { COOP_ID: "C2", BEACH_NAME: "B", BEACH_CONDITIONS: "Good", DATE: "" },
      { COOP_ID: "C3", BEACH_NAME: "C", BEACH_CONDITIONS: "Closed", DATE: "07/19/2026" }
    ]);
    const rows = parseNowcastConditions(text);
    expect(rows.length).toBe(1);
    expect(rows[0].beachName).toBe("A");
    expect(rows[0].conditions).toBe("Advisory");
    expect(rows[0].key).toBe("c1|a");
  });

  it("returns an empty array for a legitimately empty body", function () {
    expect(parseNowcastConditions("[]")).toEqual([]);
  });

  it("returns null when rows are present but none are parseable (schema drift)", function () {
    const text = JSON.stringify([
      { COOP_ID: "C1", BEACH_NAME: "A", CONDITION: "Advisory", REPORT_DATE: "2026-07-19" }
    ]);
    expect(parseNowcastConditions(text)).toBe(null);
  });

  it("returns null for a non-array body or garbage", function () {
    expect(parseNowcastConditions("{}")).toBe(null);
    expect(parseNowcastConditions("nope")).toBe(null);
    expect(parseNowcastConditions("")).toBe(null);
  });
});

describe("buildNowcastFloorSites", function () {
  it("emits a yellow floor site for Advisory and Closed, joined to roster coords", function () {
    const conditions = JSON.stringify([
      { COOP_ID: "COUNTY_CUYAHOGA", BEACH_NAME: "Edgewater", BEACH_CONDITIONS: "Good", DATE: "2026-07-20" },
      { COOP_ID: "COUNTY_SUMMIT", BEACH_NAME: "Cuyahoga", BEACH_CONDITIONS: "Advisory", DATE: "2026-07-19" },
      { COOP_ID: "COUNTY_ERIENY", BEACH_NAME: "Evans Town", BEACH_CONDITIONS: "Closed", DATE: "2026-07-18" }
    ]);
    const sites = buildNowcastFloorSites(beachesFixture(), conditions, NOW_ISO);
    expect(sites.length).toBe(2);
    const cuyahoga = sites.find(function (s) { return s.siteId === "county-summit-cuyahoga"; });
    expect(cuyahoga.floorColor).toBe("yellow");
    expect(cuyahoga.lat).toBe(41.14);
    expect(cuyahoga.lon).toBe(-81.51);
    expect(cuyahoga.updated).toBe("2026-07-19");
    expect(cuyahoga.reason).toBe("predicted E. coli exceedance (Advisory) for Cuyahoga");
    const evans = sites.find(function (s) { return s.siteId === "county-erieny-evans-town"; });
    expect(evans.floorColor).toBe("yellow");
    expect(evans.reason).toBe("predicted E. coli exceedance (Closed) for Evans Town");
    // A Good reading produces NO site (a clean reading is never a green floor).
    expect(sites.some(function (s) { return s.siteId.indexOf("edgewater") !== -1; })).toBe(false);
  });

  it("never emits a site outside NY/OH/PA (e.g. a Michigan beach)", function () {
    const conditions = JSON.stringify([
      { COOP_ID: "COUNTY_MONROE", BEACH_NAME: "Sterling", BEACH_CONDITIONS: "Advisory", DATE: "2026-07-19" }
    ]);
    const sites = buildNowcastFloorSites(beachesFixture(), conditions, NOW_ISO);
    expect(sites).toEqual([]);
  });

  it("drops an advisory that cannot be joined to any roster coordinate", function () {
    const conditions = JSON.stringify([
      { COOP_ID: "COUNTY_GHOST", BEACH_NAME: "Nowhere", BEACH_CONDITIONS: "Advisory", DATE: "2026-07-19" }
    ]);
    const sites = buildNowcastFloorSites(beachesFixture(), conditions, NOW_ISO);
    expect(sites).toEqual([]);
  });

  it("uses the LATEST reading per beach (a since-cleared beach is not floored)", function () {
    const conditions = JSON.stringify([
      { COOP_ID: "COUNTY_LAKE", BEACH_NAME: "Fairport", BEACH_CONDITIONS: "Advisory", DATE: "2026-07-12" },
      { COOP_ID: "COUNTY_LAKE", BEACH_NAME: "Fairport", BEACH_CONDITIONS: "Good", DATE: "2026-07-20" }
    ]);
    const sites = buildNowcastFloorSites(beachesFixture(), conditions, NOW_ISO);
    expect(sites).toEqual([]);
  });

  it("floors on the latest reading when it is the Advisory one", function () {
    const conditions = JSON.stringify([
      { COOP_ID: "COUNTY_LAKE", BEACH_NAME: "Fairport", BEACH_CONDITIONS: "Good", DATE: "2026-07-12" },
      { COOP_ID: "COUNTY_LAKE", BEACH_NAME: "Fairport", BEACH_CONDITIONS: "Advisory", DATE: "2026-07-20" }
    ]);
    const sites = buildNowcastFloorSites(beachesFixture(), conditions, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("county-lake-fairport");
    expect(sites[0].updated).toBe("2026-07-20");
  });

  it("drops a stale advisory older than the max age window", function () {
    const conditions = JSON.stringify([
      { COOP_ID: "COUNTY_CUYAHOGA", BEACH_NAME: "Edgewater", BEACH_CONDITIONS: "Advisory", DATE: "2026-06-01" }
    ]);
    const sites = buildNowcastFloorSites(beachesFixture(), conditions, NOW_ISO);
    expect(sites).toEqual([]);
  });

  it("returns [] (clean run) when there are no advisories at all", function () {
    const conditions = JSON.stringify([
      { COOP_ID: "COUNTY_CUYAHOGA", BEACH_NAME: "Edgewater", BEACH_CONDITIONS: "Good", DATE: "2026-07-20" }
    ]);
    expect(buildNowcastFloorSites(beachesFixture(), conditions, NOW_ISO)).toEqual([]);
  });

  it("propagates null when either endpoint body is unusable", function () {
    const goodConditions = JSON.stringify([
      { COOP_ID: "COUNTY_SUMMIT", BEACH_NAME: "Cuyahoga", BEACH_CONDITIONS: "Advisory", DATE: "2026-07-19" }
    ]);
    expect(buildNowcastFloorSites("not json", goodConditions, NOW_ISO)).toBe(null);
    expect(buildNowcastFloorSites(beachesFixture(), "not json", NOW_ISO)).toBe(null);
    expect(buildNowcastFloorSites("[]", goodConditions, NOW_ISO)).toBe(null);
  });

  it("emits only valid raise-only floor colors (yellow), never green/red", function () {
    const conditions = JSON.stringify([
      { COOP_ID: "COUNTY_SUMMIT", BEACH_NAME: "Cuyahoga", BEACH_CONDITIONS: "Advisory", DATE: "2026-07-19" },
      { COOP_ID: "COUNTY_ERIENY", BEACH_NAME: "Evans Town", BEACH_CONDITIONS: "Closed", DATE: "2026-07-18" }
    ]);
    const sites = buildNowcastFloorSites(beachesFixture(), conditions, NOW_ISO);
    for (let i = 0; i < sites.length; i++) {
      expect(sites[i].floorColor).toBe("yellow");
    }
  });
});

describe("usgsGreatLakesNowcast source object", function () {
  it("has the wqFloor source contract shape", function () {
    expect(usgsGreatLakesNowcast.id).toBe("usgs-great-lakes-nowcast");
    expect(typeof usgsGreatLakesNowcast.label).toBe("string");
    expect(typeof usgsGreatLakesNowcast.infoUrl).toBe("string");
    expect(typeof usgsGreatLakesNowcast.matches).toBe("function");
    expect(typeof usgsGreatLakesNowcast.scrape).toBe("function");
  });

  it("matches() covers the Lake Erie / Lake Ontario US shore box and rejects elsewhere", function () {
    // Cleveland lakefront (Lake Erie, OH) — inside.
    expect(usgsGreatLakesNowcast.matches({ lat: 41.49, lon: -81.74 })).toBe(true);
    // Rochester lakefront (Lake Ontario, NY) — inside.
    expect(usgsGreatLakesNowcast.matches({ lat: 43.27, lon: -77.61 })).toBe(true);
    // Lake Michigan (Chicago) — outside.
    expect(usgsGreatLakesNowcast.matches({ lat: 41.89, lon: -87.62 })).toBe(false);
    // Missing coordinates — rejected, never throws.
    expect(usgsGreatLakesNowcast.matches({})).toBe(false);
  });
});
