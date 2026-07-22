// test/seaCavesWaves.test.js
// Pure-parser tests for src/waveSources/seaCavesWaves.js. No network — every
// case builds an inline HTML fixture mirroring the live page's confirmed
// structure (fetched 2026-07-22) and exercises extractSeaCavesWaveHeightFt +
// the matches() gate directly.

import { describe, it, expect } from "vitest";
import {
  extractSeaCavesWaveHeightFt,
  seaCavesSource,
  SEA_CAVES_MODEL,
  SEA_CAVES_LABEL,
  SEA_CAVES_URL
} from "../src/waveSources/seaCavesWaves.js";

const NOW_ISO = "2026-07-22T11:15:00.000Z"; // 6:15 AM Central (CDT, UTC-5)

// Builds a minimal fixture around the "Latest Wave Info" block, matching the
// real page's markup shape. bodyLines are inserted verbatim after the
// heading so tests can vary date/time/height/marker content freely.
function buildLatestBlock(dateLine, timeLine, waveLine) {
  return "<div id=\"latest_info\" style=\"float:left;margin-left:150px;\">" +
    "<div id=\"bar\" class=\"comc\" style=\"height:auto;margin:0px;padding:7px;\">" +
    "<h3 align=\"center\" style=\"margin:0px;color:White;\"><u>Latest Wave Info</u></h3>" +
    "</div>" +
    "<h4 align=\"center\" style=\"margin:5px\">" + dateLine + "</h4>" +
    "<h4 align=\"center\" style=\"margin:5px\">" + timeLine + "</h4>" +
    "<h4 align=\"center\" style=\"margin:5px\">" + waveLine + "</h4>" +
    "</div>" +
    "<div id=\"latest_info\" style=\"float:right;margin-right:150px;\">" +
    "<div id=\"bar\" class=\"comc\"><h3><u>Wave Plots</u></h3></div>" +
    "</div>";
}

describe("extractSeaCavesWaveHeightFt", function () {
  it("parses the live-shaped fixture (fresh, non-N/A latest reading)", function () {
    const html = buildLatestBlock("07/22/2026", "6:00 AM", "Wave height  0.6 ft");
    expect(extractSeaCavesWaveHeightFt(html, NOW_ISO)).toBe(0.6);
  });

  it("parses a larger wave height as a finite number", function () {
    const html = buildLatestBlock("07/22/2026", "6:00 AM", "Wave height 3.4 ft");
    expect(extractSeaCavesWaveHeightFt(html, NOW_ISO)).toBe(3.4);
  });

  it("returns null when the latest reading is N/A", function () {
    const html = buildLatestBlock("07/22/2026", "6:00 AM", "Wave height N/A");
    expect(extractSeaCavesWaveHeightFt(html, NOW_ISO)).toBe(null);
  });

  it("returns null when the reading is flagged as a Model result", function () {
    const html = buildLatestBlock(
      "07/22/2026",
      "6:00 AM",
      "Wave height 0.6 ft <span style=\"color:red;\">Model</span>"
    );
    expect(extractSeaCavesWaveHeightFt(html, NOW_ISO)).toBe(null);
  });

  it("returns null for an off-season page with no Latest Wave Info block", function () {
    const html = "<html><body><p>WISC-Watch Buoys removed for the season</p></body></html>";
    expect(extractSeaCavesWaveHeightFt(html, NOW_ISO)).toBe(null);
  });

  it("returns null when the latest reading is stale (older than the freshness window)", function () {
    // Reading timestamped ~5 hours before nowIso, well past MAX_READING_AGE_MS.
    const html = buildLatestBlock("07/22/2026", "1:00 AM", "Wave height 0.5 ft");
    expect(extractSeaCavesWaveHeightFt(html, NOW_ISO)).toBe(null);
  });

  it("returns null when the reading appears to be far in the future (clock skew)", function () {
    const html = buildLatestBlock("07/22/2026", "11:59 PM", "Wave height 0.5 ft");
    expect(extractSeaCavesWaveHeightFt(html, NOW_ISO)).toBe(null);
  });

  it("returns null when the timestamp is missing entirely", function () {
    const html = "<div id=\"latest_info\"><h3><u>Latest Wave Info</u></h3>" +
      "<h4>Wave height 0.6 ft</h4></div>";
    expect(extractSeaCavesWaveHeightFt(html, NOW_ISO)).toBe(null);
  });

  it("returns null for null and empty-string input", function () {
    expect(extractSeaCavesWaveHeightFt(null, NOW_ISO)).toBe(null);
    expect(extractSeaCavesWaveHeightFt("", NOW_ISO)).toBe(null);
  });

  it("returns null (does not throw) on garbage input", function () {
    expect(extractSeaCavesWaveHeightFt("<<< not the expected format >>>", NOW_ISO)).toBe(null);
  });

  it("returns null when nowIso itself is unparseable", function () {
    const html = buildLatestBlock("07/22/2026", "6:00 AM", "Wave height 0.6 ft");
    expect(extractSeaCavesWaveHeightFt(html, "not-a-date")).toBe(null);
  });
});

describe("seaCavesSource.matches", function () {
  it("matches a beach named after the sea caves", function () {
    expect(seaCavesSource.matches({
      id: "b1",
      name: "Mainland Sea Caves",
      park_name: "Apostle Islands National Lakeshore",
      lat: 40.0,
      lon: -70.0
    })).toBe(true);
  });

  it("matches a beach named Meyers Beach regardless of coordinates", function () {
    expect(seaCavesSource.matches({
      id: "b2",
      name: "Meyers Beach",
      park_name: null,
      lat: 0,
      lon: 0
    })).toBe(true);
  });

  it("matches a beach within ~15 km of the station by coordinates alone", function () {
    expect(seaCavesSource.matches({
      id: "b3",
      name: "Unnamed Access Point",
      park_name: null,
      lat: 46.90,
      lon: -91.00
    })).toBe(true);
  });

  it("does not match a distant beach with an unrelated name", function () {
    expect(seaCavesSource.matches({
      id: "b4",
      name: "South Haven Beach",
      park_name: null,
      lat: 42.4,
      lon: -86.3
    })).toBe(false);
  });

  it("does not match when lat/lon are missing and the name is unrelated", function () {
    expect(seaCavesSource.matches({ id: "b5", name: "Some Beach", park_name: null })).toBe(false);
  });

  it("returns false defensively on a missing/garbage beach argument", function () {
    expect(seaCavesSource.matches(null)).toBe(false);
    expect(seaCavesSource.matches(undefined)).toBe(false);
  });
});

describe("seaCavesSource shape", function () {
  it("exposes the locked supplemental wave-source contract fields", function () {
    expect(seaCavesSource.id).toBe("uw-sea-caves-watch");
    expect(seaCavesSource.model).toBe(SEA_CAVES_MODEL);
    expect(seaCavesSource.label).toBe(SEA_CAVES_LABEL);
    expect(seaCavesSource.url).toBe(SEA_CAVES_URL);
    expect(typeof seaCavesSource.matches).toBe("function");
    expect(typeof seaCavesSource.waveFt).toBe("function");
  });
});
