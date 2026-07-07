// test/chicagoParkDistrict.test.js
import { describe, it, expect } from "vitest";
import {
  parseChicagoFlags,
  beachNameKeys,
  cachebustFromNowIso,
  chicagoParkDistrict
} from "../src/officialSources/chicagoParkDistrict.js";

// Reference "now" for the fixtures below. Epoch seconds = 1783289540.
// The 36-hour staleness floor is therefore epoch 1783159940.
const NOW_ISO = "2026-07-05T22:12:20.000Z";

// Build a JSON string fixture (no backticks) mirroring the live /flag-status
// payload shape. Records intentionally arrive out of category order and mix a
// stale prior-season row, an unknown flag string, and a record with no parent.
function buildFixture() {
  const records = [
    // 12th Street Beach: trailing space in parent. THE LIVE TRAP — the Water
    // Quality row is the FRESHEST and reads Green, but the Surf row says
    // "Red Afterhours - Swimming Prohibited". Most-severe-wins must report red,
    // never the newer green (a wrong official green is the worst bug).
    { title: "12th Street Beach - Surf Conditions", parent: "12th Street Beach ", date: "1783265808", flag: "Red Afterhours - Swimming Prohibited" },
    { title: "12th Street Beach - Water Quality", parent: "12th Street Beach ", date: "1783271048", flag: "Green" },
    // Montrose Beach: single fresh Yellow.
    { title: "Montrose Beach - Weather", parent: "Montrose Beach", date: "1783270000", flag: "Yellow" },
    // Calumet Beach: fresh Afterhours closure -> red, with the after-hours note.
    { title: "Calumet Beach - Surf Conditions", parent: "Calumet Beach", date: "1783289000", flag: "Red Afterhours - Swimming Prohibited" },
    // Humboldt Beach: only a ~10-month-stale record -> must be omitted.
    { title: "Humboldt Beach - Surf Conditions", parent: "Humboldt Beach", date: "1756482510", flag: "Green" },
    // Rainbow Beach: fresh but unrecognized flag string -> omitted, never guessed.
    { title: "Rainbow Beach - Weather", parent: "Rainbow Beach ", date: "1783280000", flag: "Purple" },
    // Malformed record with no usable parent -> skipped without throwing.
    { title: "Orphan - Weather", parent: null, date: "1783280000", flag: "Green" }
  ];
  return JSON.stringify(records);
}

function siteById(sites, id) {
  for (let i = 0; i < sites.length; i++) {
    if (sites[i].siteId === id) {
      return sites[i];
    }
  }
  return null;
}

describe("parseChicagoFlags", function() {
  it("returns null for malformed JSON", function() {
    expect(parseChicagoFlags("{ not json", NOW_ISO)).toBe(null);
  });

  it("returns null for non-array JSON", function() {
    expect(parseChicagoFlags("{\"parent\":\"x\"}", NOW_ISO)).toBe(null);
  });

  it("returns null for an unparseable nowIso", function() {
    expect(parseChicagoFlags(buildFixture(), "not-a-date")).toBe(null);
  });

  it("resolves each beach to the most severe fresh row, never the newest", function() {
    const sites = parseChicagoFlags(buildFixture(), NOW_ISO);
    // 12th Street (RED — surf afterhours beats fresher green water quality),
    // Montrose (yellow), Calumet (red afterhours). Humboldt (stale), Rainbow
    // (unknown), orphan (no parent) are all omitted.
    expect(sites.length).toBe(3);

    const twelfth = siteById(sites, "12th street beach");
    expect(twelfth).not.toBe(null);
    // Regression: the newer water-quality "Green" must NOT win over the surf
    // "Red Afterhours - Swimming Prohibited". A wrong official green here would
    // tell a swimmer the water is safe while swimming is prohibited.
    expect(twelfth.color).toBe("red");
    expect(/after-hours/i.test(twelfth.reason)).toBe(true);
    expect(twelfth.names.indexOf("12th street beach")).not.toBe(-1);
    expect(twelfth.names.indexOf("12th street")).not.toBe(-1);
  });

  it("takes the most severe color across categories (bacteria green cannot mask a surf red)", function() {
    // Mirrors the live pattern: three rows, water quality freshest and green,
    // a genuine daytime surf red (not after-hours). Result must be a genuine
    // red with a NON-after-hours reason.
    const text = JSON.stringify([
      { title: "Oak Street Beach - Water Quality", parent: "Oak Street Beach", date: "1783271048", flag: "Green" },
      { title: "Oak Street Beach - Weather", parent: "Oak Street Beach", date: "1783270000", flag: "Green" },
      { title: "Oak Street Beach - Surf Conditions", parent: "Oak Street Beach", date: "1783265808", flag: "Red - Swimming Prohibited" }
    ]);
    const sites = parseChicagoFlags(text, NOW_ISO);
    const oak = siteById(sites, "oak street beach");
    expect(oak).not.toBe(null);
    expect(oak.color).toBe("red");
    // Genuine daytime hazard, not an after-hours closure.
    expect(/after-hours/i.test(oak.reason)).toBe(false);
  });

  it("takes yellow over green across categories", function() {
    const text = JSON.stringify([
      { title: "Foster Beach - Water Quality", parent: "Foster Beach", date: "1783271048", flag: "Green" },
      { title: "Foster Beach - Surf Conditions", parent: "Foster Beach", date: "1783270000", flag: "Yellow" }
    ]);
    const sites = parseChicagoFlags(text, NOW_ISO);
    const foster = siteById(sites, "foster beach");
    expect(foster.color).toBe("yellow");
  });

  it("reports green only when every fresh row is green", function() {
    const text = JSON.stringify([
      { title: "Ohio Street Beach - Water Quality", parent: "Ohio Street Beach", date: "1783271048", flag: "Green" },
      { title: "Ohio Street Beach - Weather", parent: "Ohio Street Beach", date: "1783270000", flag: "Green" },
      { title: "Ohio Street Beach - Surf Conditions", parent: "Ohio Street Beach", date: "1783265808", flag: "Green" }
    ]);
    const sites = parseChicagoFlags(text, NOW_ISO);
    const ohio = siteById(sites, "ohio street beach");
    expect(ohio.color).toBe("green");
  });

  it("drops a stale red row but keeps a fresh green (per-row staleness)", function() {
    // A ~10-month-old surf red must not force this beach red; only the fresh
    // green rows count, so the beach is green.
    const text = JSON.stringify([
      { title: "Leone Beach - Surf Conditions", parent: "Leone Beach", date: "1756482510", flag: "Red - Swimming Prohibited" },
      { title: "Leone Beach - Water Quality", parent: "Leone Beach", date: "1783271048", flag: "Green" }
    ]);
    const sites = parseChicagoFlags(text, NOW_ISO);
    const leone = siteById(sites, "leone beach");
    expect(leone).not.toBe(null);
    expect(leone.color).toBe("green");
  });

  it("maps a fresh Yellow flag to yellow", function() {
    const sites = parseChicagoFlags(buildFixture(), NOW_ISO);
    const montrose = siteById(sites, "montrose beach");
    expect(montrose.color).toBe("yellow");
  });

  it("maps an Afterhours closure to red with an after-hours reason", function() {
    const sites = parseChicagoFlags(buildFixture(), NOW_ISO);
    const calumet = siteById(sites, "calumet beach");
    expect(calumet.color).toBe("red");
    expect(/after-hours/i.test(calumet.reason)).toBe(true);
  });

  it("omits a beach whose newest record is stale (> 36h old)", function() {
    const sites = parseChicagoFlags(buildFixture(), NOW_ISO);
    expect(siteById(sites, "humboldt beach")).toBe(null);
  });

  it("omits a beach with an unrecognized flag string instead of guessing", function() {
    const sites = parseChicagoFlags(buildFixture(), NOW_ISO);
    expect(siteById(sites, "rainbow beach")).toBe(null);
  });

  it("maps a Double Red flag to double-red and never lets it degrade to no-data", function() {
    // Regression: a genuine "Double Red" (water fully closed) must surface as
    // double-red. If it were dropped to no-data the beach would fall back to a
    // benign swim.report estimate — an effective under-report of a closure.
    const text = JSON.stringify([
      { title: "Rainbow Beach - Surf Conditions", parent: "Rainbow Beach", date: "1783270000", flag: "Double Red - Water Closed" },
      { title: "Rainbow Beach - Water Quality", parent: "Rainbow Beach", date: "1783271048", flag: "Green" }
    ]);
    const sites = parseChicagoFlags(text, NOW_ISO);
    const rainbow = siteById(sites, "rainbow beach");
    expect(rainbow).not.toBe(null);
    expect(rainbow.color).toBe("double-red");
  });

  it("keeps double-red above an after-hours red across categories", function() {
    // double-red must outrank a fresher after-hours red on the same beach.
    const text = JSON.stringify([
      { title: "Oak Street Beach - Surf Conditions", parent: "Oak Street Beach", date: "1783265808", flag: "Double Red - Water Closed" },
      { title: "Oak Street Beach - Weather", parent: "Oak Street Beach", date: "1783296001", flag: "Red Afterhours - Swimming Prohibited" }
    ]);
    const sites = parseChicagoFlags(text, NOW_ISO);
    const oak = siteById(sites, "oak street beach");
    expect(oak.color).toBe("double-red");
  });

  it("counts a future-dated after-hours red as fresh (never a wrong green before dusk)", function() {
    // CPD stamps the after-hours rows at the 7pm lifeguard-off time, so during
    // the day that row is FUTURE-dated. It must still count (staleness has only a
    // lower bound) so a beach is never reported green while a scheduled closure
    // is in the feed. Locks in the safe direction.
    const future = "1783296001"; // ~1.8h after NOW_ISO
    const text = JSON.stringify([
      { title: "Foster Beach - Surf Conditions", parent: "Foster Beach", date: future, flag: "Red Afterhours - Swimming Prohibited" },
      { title: "Foster Beach - Water Quality", parent: "Foster Beach", date: "1783271048", flag: "Green" }
    ]);
    const sites = parseChicagoFlags(text, NOW_ISO);
    const foster = siteById(sites, "foster beach");
    expect(foster.color).toBe("red");
  });

  it("returns an empty array when every record is stale", function() {
    const stale = JSON.stringify([
      { title: "Foster Beach - Weather", parent: "Foster Beach", date: "1756482510", flag: "Green" }
    ]);
    expect(parseChicagoFlags(stale, NOW_ISO)).toEqual([]);
  });
});

describe("beachNameKeys", function() {
  it("emits the full name and the name without a trailing beach", function() {
    expect(beachNameKeys("12th Street Beach ")).toEqual(["12th street beach", "12th street"]);
  });

  it("does not strip a name that does not end in beach", function() {
    expect(beachNameKeys("Ohio Street")).toEqual(["ohio street"]);
  });
});

describe("cachebustFromNowIso", function() {
  it("strips non-digits from nowIso and never reads the clock", function() {
    expect(cachebustFromNowIso("2026-07-05T22:12:20.000Z")).toBe("20260705221220000");
  });

  it("falls back to 0 for empty input", function() {
    expect(cachebustFromNowIso("")).toBe("0");
    expect(cachebustFromNowIso(null)).toBe("0");
  });
});

describe("chicagoParkDistrict.matches", function() {
  it("matches a beach inside the Chicago lakefront box", function() {
    const beach = { id: "osm-1", name: "Montrose Beach", park_name: null, lat: 41.9636, lon: -87.6383, nws_zone: null, nws_grid_url: null, osm_id: "node/1" };
    expect(chicagoParkDistrict.matches(beach)).toBe(true);
  });

  it("does not match a beach outside the box", function() {
    const beach = { id: "osm-2", name: "South Haven South Beach", park_name: null, lat: 42.4, lon: -86.28, nws_zone: null, nws_grid_url: null, osm_id: "node/2" };
    expect(chicagoParkDistrict.matches(beach)).toBe(false);
  });
});
