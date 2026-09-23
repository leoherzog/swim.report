// test/mnBeaches.test.js
// Pure-parser tests for src/wqFloor/mnBeaches.js. No network — parseMnBeaches,
// normalizeMnStatus, and isMnHabReason are exercised directly against inline
// fixtures shaped like the live mnbeaches.org MNBstatus payload. mnBeaches
// (matches/scrape) is exercised only for its pure matches() gate; scrape()
// itself is a thin fetch wrapper and is not network-tested here.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseMnBeaches,
  normalizeMnStatus,
  isMnHabReason,
  mnBeaches
} from "../src/wqFloor/mnBeaches.js";
import { makeBeach } from "./helpers/beach.js";

const NOW_ISO = "2026-07-22T12:00:00Z";

function buildPayload(statusEntries) {
  return {
    MNBdataUpdated: "7/22/2026",
    MNBsiteactive: "1",
    MNBmessage: "",
    MNBstatus: statusEntries,
    MNBregions: []
  };
}

function skyHarborEntry(overrides) {
  const base = {
    StnID: "324141",
    Date: "7/20/2026",
    Status: "Water Contact Acceptable",
    Reason: "",
    Name: "Park Point Sky Harbor Parking Lot Beach",
    lng: "-92.0519435",
    lat: "46.7282128",
    Region: "Duluth"
  };
  return Object.assign(base, overrides || {});
}

// Shaped like the live off-season feed: entries carry no Status, Reason or Date.
function offSeasonPayload(statusEntries) {
  return {
    MNBdataUpdated: "Fri Sep 04 2026 CDT",
    MNBsiteactive: "False",
    MNBmessage: "Beach monitoring has ended for the 2026 season. It will resume again in May 2027.",
    MNBstatus: statusEntries,
    MNBregions: []
  };
}

function offSeasonEntry(stnId, name, lat, lng) {
  return {
    StnID: stnId,
    lat: lat,
    lng: lng,
    Name: name,
    Region: "Duluth",
    Jurisdiction: "City of Duluth",
    url: "",
    Message: ""
  };
}

afterEach(function () {
  vi.restoreAllMocks();
});

describe("normalizeMnStatus", function () {
  it("recognizes Water Contact Acceptable", function () {
    expect(normalizeMnStatus("Water Contact Acceptable")).toBe("acceptable");
  });

  it("recognizes Water Contact Not Recommended", function () {
    expect(normalizeMnStatus("Water Contact Not Recommended")).toBe("not-recommended");
  });

  it("is case-insensitive and trims whitespace", function () {
    expect(normalizeMnStatus("  water contact NOT recommended  ")).toBe("not-recommended");
  });

  it("returns null for an unrecognized status", function () {
    expect(normalizeMnStatus("Beach Closed")).toBe(null);
  });

  it("returns null for non-string input", function () {
    expect(normalizeMnStatus(null)).toBe(null);
    expect(normalizeMnStatus(undefined)).toBe(null);
    expect(normalizeMnStatus(42)).toBe(null);
  });
});

describe("isMnHabReason", function () {
  it("detects harmful algal bloom phrasing", function () {
    expect(isMnHabReason("Harmful Algal Bloom observed")).toBe(true);
  });

  it("detects HAB acronym, toxic algae, blue-green algae, cyanobacteria", function () {
    expect(isMnHabReason("Confirmed HAB at this station")).toBe(true);
    expect(isMnHabReason("Toxic algae present")).toBe(true);
    expect(isMnHabReason("Blue-green algae bloom")).toBe(true);
    expect(isMnHabReason("Cyanobacteria detected")).toBe(true);
  });

  it("returns false for an unrelated or bacteria-only reason", function () {
    expect(isMnHabReason("High E. coli levels")).toBe(false);
  });

  it("returns false for absent/empty/non-string reason", function () {
    expect(isMnHabReason(null)).toBe(false);
    expect(isMnHabReason(undefined)).toBe(false);
    expect(isMnHabReason("")).toBe(false);
  });
});

describe("parseMnBeaches", function () {
  it("emits a yellow floor site for a curated Duluth station under advisory", function () {
    const payload = buildPayload([
      skyHarborEntry({ Status: "Water Contact Not Recommended", Reason: "High bacteria levels" })
    ]);
    const sites = parseMnBeaches(payload, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("park-point-sky-harbor");
    expect(sites[0].floorColor).toBe("yellow");
    expect(sites[0].reason).toBe("MN Dept. of Health beach monitoring: High bacteria levels");
    expect(sites[0].names).toEqual(["sky harbor"]);
    expect(sites[0].lat).toBe(46.7282128);
    expect(sites[0].lon).toBe(-92.0519435);
    expect(sites[0].updated).toBe(NOW_ISO);
  });

  it("escalates to a red floor when the reason indicates a harmful algal bloom", function () {
    const payload = buildPayload([
      skyHarborEntry({ Status: "Water Contact Not Recommended", Reason: "Harmful algal bloom detected" })
    ]);
    const sites = parseMnBeaches(payload, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].floorColor).toBe("red");
  });

  it("uses a default reason string when Reason is empty", function () {
    const payload = buildPayload([
      skyHarborEntry({ Status: "Water Contact Not Recommended", Reason: "" })
    ]);
    const sites = parseMnBeaches(payload, NOW_ISO);
    expect(sites[0].reason).toBe("MN Dept. of Health beach monitoring: Water Contact Not Recommended");
  });

  it("emits NO site for an acceptable (clean) reading -- absence is the floor signal", function () {
    const payload = buildPayload([
      skyHarborEntry({ Status: "Water Contact Acceptable" })
    ]);
    const sites = parseMnBeaches(payload, NOW_ISO);
    expect(sites).toEqual([]);
  });

  it("returns an empty array (not null) when every curated station is clean", function () {
    const payload = buildPayload([
      skyHarborEntry({ Status: "Water Contact Acceptable" }),
      skyHarborEntry({
        Name: "Park Point Beach House",
        lat: "46.73170278",
        lng: "-92.05061271",
        Status: "Water Contact Acceptable"
      })
    ]);
    expect(parseMnBeaches(payload, NOW_ISO)).toEqual([]);
  });

  it("skips stations outside the curated Duluth region", function () {
    const payload = buildPayload([
      {
        StnID: "108001",
        Date: "7/14/2026",
        Status: "Water Contact Not Recommended",
        Reason: "High bacteria",
        Name: "Schulze Lake Beach",
        lng: "-93.127649",
        lat: "44.785064",
        Region: "SMetro"
      }
    ]);
    expect(parseMnBeaches(payload, NOW_ISO)).toEqual([]);
  });

  it("skips a Duluth-region station whose name does not match a curated station", function () {
    const payload = buildPayload([
      skyHarborEntry({
        Name: "Some Other Duluth Beach",
        Status: "Water Contact Not Recommended",
        Reason: "High bacteria"
      })
    ]);
    expect(parseMnBeaches(payload, NOW_ISO)).toEqual([]);
  });

  it("skips an entry with an unrecognized Status rather than guessing", function () {
    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    const payload = buildPayload([
      skyHarborEntry({ Status: "Beach Closed For Construction" })
    ]);
    expect(parseMnBeaches(payload, NOW_ISO)).toEqual([]);
    const unrecognized = logSpy.mock.calls.filter(function (call) {
      return String(call[0]).indexOf("unrecognized Status") !== -1;
    });
    expect(unrecognized.length).toBe(1);
  });

  it("emits no site and does not log for off-season entries with no Status", function () {
    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    const payload = offSeasonPayload([
      offSeasonEntry("324142", "Park Point Beach House", "46.73170278", "-92.05061271"),
      offSeasonEntry("324150", "Lakewalk Beach", "46.7867", "-92.0810"),
      offSeasonEntry("324151", "Lakewalk East / 16th Avenue East Beach", "46.7960", "-92.0700"),
      offSeasonEntry("324141", "Sky Harbor Parking Lot", "46.7282128", "-92.0519435")
    ]);
    expect(parseMnBeaches(payload, NOW_ISO)).toEqual([]);
    const unrecognized = logSpy.mock.calls.filter(function (call) {
      return String(call[0]).indexOf("unrecognized Status") !== -1;
    });
    expect(unrecognized).toEqual([]);
  });

  it("skips an entry whose Status is an empty or whitespace string without logging", function () {
    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    const payload = buildPayload([
      skyHarborEntry({ Status: "   " }),
      skyHarborEntry({ Status: null })
    ]);
    expect(parseMnBeaches(payload, NOW_ISO)).toEqual([]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("still emits a floor when MNBsiteactive is False but a curated row is Not Recommended", function () {
    const entry = offSeasonEntry("324142", "Park Point Beach House", "46.73170278", "-92.05061271");
    entry.Status = "Water Contact Not Recommended";
    entry.Reason = "High E. coli";
    const sites = parseMnBeaches(offSeasonPayload([entry]), NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("park-point-beach-house");
    expect(sites[0].floorColor).toBe("yellow");
    expect(sites[0].reason).toBe("MN Dept. of Health beach monitoring: High E. coli");
  });

  it("resolves all six curated stations by name substring", function () {
    const payload = buildPayload([
      skyHarborEntry({ Status: "Water Contact Not Recommended", Reason: "r1" }),
      skyHarborEntry({ Name: "Park Point Beach House", lat: "46.73170278", lng: "-92.05061271", Status: "Water Contact Not Recommended", Reason: "r2" }),
      skyHarborEntry({ Name: "Park Point Lafayette Community Club Beach", lat: "46.75262179", lng: "-92.07135989", Status: "Water Contact Not Recommended", Reason: "r3" }),
      skyHarborEntry({ Name: "Franklin Park Beach", lat: "46.7691", lng: "-92.0896", Status: "Water Contact Not Recommended", Reason: "r4" }),
      skyHarborEntry({ Name: "Minnesota Point Harbor Side Beach", lat: "46.7212", lng: "-92.0669", Status: "Water Contact Not Recommended", Reason: "r5" }),
      skyHarborEntry({ Name: "Lakewalk Beach", lat: "46.7867", lng: "-92.0810", Status: "Water Contact Not Recommended", Reason: "r6" })
    ]);
    const sites = parseMnBeaches(payload, NOW_ISO);
    const siteIds = sites.map(function (s) { return s.siteId; }).sort();
    expect(siteIds).toEqual([
      "franklin-park",
      "lakewalk",
      "minnesota-point-harbor-side",
      "park-point-beach-house",
      "park-point-lafayette",
      "park-point-sky-harbor"
    ]);
  });

  it("does not emit a duplicate site for repeated rows of the same station", function () {
    const payload = buildPayload([
      skyHarborEntry({ Status: "Water Contact Not Recommended", Reason: "first" }),
      skyHarborEntry({ Status: "Water Contact Not Recommended", Reason: "second" })
    ]);
    const sites = parseMnBeaches(payload, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].reason).toBe("MN Dept. of Health beach monitoring: first");
  });

  it("ignores a non-object row inside MNBstatus without throwing", function () {
    const payload = buildPayload([null, "garbage", skyHarborEntry({ Status: "Water Contact Not Recommended", Reason: "r" })]);
    const sites = parseMnBeaches(payload, NOW_ISO);
    expect(sites.length).toBe(1);
  });

  it("returns null when MNBstatus is missing", function () {
    expect(parseMnBeaches({ MNBdataUpdated: "x" }, NOW_ISO)).toBe(null);
  });

  it("returns null when MNBstatus is not an array", function () {
    expect(parseMnBeaches({ MNBstatus: "not-an-array" }, NOW_ISO)).toBe(null);
  });

  it("returns null for null/undefined/non-object input", function () {
    expect(parseMnBeaches(null, NOW_ISO)).toBe(null);
    expect(parseMnBeaches(undefined, NOW_ISO)).toBe(null);
    expect(parseMnBeaches("garbage", NOW_ISO)).toBe(null);
    expect(parseMnBeaches(42, NOW_ISO)).toBe(null);
  });
});

describe("mnBeaches.matches", function () {
  it("matches a beach whose name contains a curated station's name token", function () {
    const beach = makeBeach({ name: "Park Point Sky Harbor Beach", lat: 46.7282128, lon: -92.0519435 });
    expect(mnBeaches.matches(beach)).toBe(true);
  });

  it("matches a beach whose park_name carries the station token", function () {
    const beach = makeBeach({ name: "East Access", park_name: "Lakewalk", lat: 46.7867, lon: -92.0810 });
    expect(mnBeaches.matches(beach)).toBe(true);
  });

  it("matches by proximity inside the curated Duluth bounding box even without a name hit", function () {
    const beach = makeBeach({ name: "Unnamed Access Point", lat: 46.75, lon: -92.06 });
    expect(mnBeaches.matches(beach)).toBe(true);
  });

  it("does not match a beach far outside the Duluth box with no name hit", function () {
    const beach = makeBeach({ name: "Random Lake Beach", lat: 44.8, lon: -83.3 });
    expect(mnBeaches.matches(beach)).toBe(false);
  });

  it("does not throw and returns false for a beach with non-numeric coordinates and no name hit", function () {
    const beach = makeBeach({ name: "No Coords Beach", lat: null, lon: undefined });
    expect(mnBeaches.matches(beach)).toBe(false);
  });

  it("returns false for a falsy beach", function () {
    expect(mnBeaches.matches(null)).toBe(false);
    expect(mnBeaches.matches(undefined)).toBe(false);
  });
});
