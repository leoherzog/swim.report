// test/ndbcBuoys.test.js
// Pure-parser + station-selection tests for the NDBC supplemental wave source.
// No network: every realtime2 fixture is built inline. Project style: ES
// modules, NO template literals (string concat with +), function () {}
// callbacks.

import { describe, it, expect } from "vitest";
import {
  parseNdbcWaveFt,
  nearestStation,
  stationUrl,
  matches,
  ndbcBuoySource,
  ndbcWaveSource,
  NDBC_MODEL,
  NDBC_STATIONS,
  NDBC_MAX_DISTANCE_KM
} from "../src/waveSources/ndbcBuoys.js";

const METERS_TO_FEET = 3.28084;

// The two comment header lines every realtime2 file carries.
const HEADER = [
  "#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE",
  "#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft"
];

// Build a realtime2 body from an array of data-row strings (newest first),
// prefixed with the standard two-line header. A helper to keep the fixtures
// focused on the WVHT column under test.
function ndbcFile(dataRows) {
  return HEADER.concat(dataRows).join("\n") + "\n";
}

// A single data row. ts is "YYYY MM DD hh mm"; wvht is the WVHT token (a metres
// string or "MM"). The intervening WDIR/WSPD/GST columns are filler.
function row(ts, wvht) {
  return ts + " 280  5.0  6.0   " + wvht + "     5    MM  MM 1016.2  18.3  22.9    MM   MM   MM    MM";
}

const NOW = "2026-07-22T11:30:00Z"; // just after an 11:00Z observation

describe("parseNdbcWaveFt", function () {
  it("parses the newest fresh WVHT and converts metres to feet", function () {
    const text = ndbcFile([
      row("2026 07 22 11 00", "1.2"),
      row("2026 07 22 10 00", "1.0")
    ]);
    const ft = parseNdbcWaveFt(text, NOW);
    expect(ft).toBeCloseTo(1.2 * METERS_TO_FEET, 5);
  });

  it("passes 0 m (calm) through as a finite reading, not no-data", function () {
    const text = ndbcFile([row("2026 07 22 11 00", "0.0")]);
    expect(parseNdbcWaveFt(text, NOW)).toBe(0);
  });

  it("skips a newest row whose WVHT is MM and uses the next fresh row", function () {
    const text = ndbcFile([
      row("2026 07 22 11 20", "MM"),
      row("2026 07 22 11 00", "1.5")
    ]);
    expect(parseNdbcWaveFt(text, NOW)).toBeCloseTo(1.5 * METERS_TO_FEET, 5);
  });

  it("returns null when every WVHT column is MM", function () {
    const text = ndbcFile([
      row("2026 07 22 11 20", "MM"),
      row("2026 07 22 11 10", "MM")
    ]);
    expect(parseNdbcWaveFt(text, NOW)).toBe(null);
  });

  it("returns null when the freshest real WVHT is older than the 2 h window", function () {
    // Newest real reading is at 09:00Z, 2.5 h before NOW (11:30Z) -> stale.
    const text = ndbcFile([
      row("2026 07 22 11 00", "MM"),
      row("2026 07 22 09 00", "1.4")
    ]);
    expect(parseNdbcWaveFt(text, NOW)).toBe(null);
  });

  it("accepts a reading right at the edge of the freshness window", function () {
    // 2 h before NOW exactly (09:30Z) — within NDBC_MAX_OBS_AGE_MS.
    const text = ndbcFile([row("2026 07 22 09 30", "0.9")]);
    expect(parseNdbcWaveFt(text, NOW)).toBeCloseTo(0.9 * METERS_TO_FEET, 5);
  });

  it("rejects a reading more than 10 min in the future (clock skew guard)", function () {
    // 11:45Z is 15 min after NOW (11:30Z) -> skipped; no other rows -> null.
    const text = ndbcFile([row("2026 07 22 11 45", "1.1")]);
    expect(parseNdbcWaveFt(text, NOW)).toBe(null);
  });

  it("rejects an absurdly large WVHT value as corrupt (never a wrong height)", function () {
    const text = ndbcFile([
      row("2026 07 22 11 00", "999.0"),
      row("2026 07 22 10 30", "1.3")
    ]);
    expect(parseNdbcWaveFt(text, NOW)).toBeCloseTo(1.3 * METERS_TO_FEET, 5);
  });

  it("rejects a negative WVHT value", function () {
    const text = ndbcFile([
      row("2026 07 22 11 00", "-1.0"),
      row("2026 07 22 10 30", "0.8")
    ]);
    expect(parseNdbcWaveFt(text, NOW)).toBeCloseTo(0.8 * METERS_TO_FEET, 5);
  });

  it("skips a row with too few columns to hold WVHT", function () {
    const short = "2026 07 22 11 00 280 5.0";
    const text = ndbcFile([short, row("2026 07 22 10 40", "1.0")]);
    expect(parseNdbcWaveFt(text, NOW)).toBeCloseTo(1.0 * METERS_TO_FEET, 5);
  });

  it("returns null for null, empty, and header-only input", function () {
    expect(parseNdbcWaveFt(null, NOW)).toBe(null);
    expect(parseNdbcWaveFt("", NOW)).toBe(null);
    expect(parseNdbcWaveFt(ndbcFile([]), NOW)).toBe(null);
  });

  it("returns null (does not throw) on garbage input", function () {
    expect(parseNdbcWaveFt("<<< not the expected format >>>", NOW)).toBe(null);
  });

  it("returns null when nowIso is missing or unparseable", function () {
    const text = ndbcFile([row("2026 07 22 11 00", "1.2")]);
    expect(parseNdbcWaveFt(text, null)).toBe(null);
    expect(parseNdbcWaveFt(text, "")).toBe(null);
    expect(parseNdbcWaveFt(text, "not-a-date")).toBe(null);
  });

  it("skips a row whose WVHT parses but timestamp fields are non-numeric", function () {
    const bad = "YYYY MM DD hh mm 280 5.0 6.0 1.2 5 MM MM 1016 18 22 MM MM MM MM";
    const text = ndbcFile([bad, row("2026 07 22 11 00", "0.7")]);
    expect(parseNdbcWaveFt(text, NOW)).toBeCloseTo(0.7 * METERS_TO_FEET, 5);
  });
});

describe("nearestStation", function () {
  it("picks the nearest curated station within the cap", function () {
    // Point next to the Cleveland buoy (45164 @ 41.748,-81.698).
    const st = nearestStation(41.75, -81.70);
    expect(st).not.toBe(null);
    expect(st.id).toBe("45164");
    expect(st.distanceKm).toBeLessThan(5);
  });

  it("returns null when no station is within NDBC_MAX_DISTANCE_KM", function () {
    // Middle of the Atlantic — far from every Great Lakes buoy.
    expect(nearestStation(30.0, -40.0)).toBe(null);
  });

  it("returns null for invalid coordinates", function () {
    expect(nearestStation(null, -81.7)).toBe(null);
    expect(nearestStation(41.7, undefined)).toBe(null);
    expect(nearestStation(NaN, NaN)).toBe(null);
  });

  it("chooses the closer of two nearby stations", function () {
    // Toledo (45165 @ 41.704,-83.264) vs West Erie (45005 @ 41.677,-82.398).
    const st = nearestStation(41.70, -83.20);
    expect(st.id).toBe("45165");
  });
});

describe("matches", function () {
  it("is true for a beach near a curated buoy", function () {
    expect(matches({ id: "b1", lat: 41.75, lon: -81.70 })).toBe(true);
  });

  it("is false for a beach far from every buoy", function () {
    expect(matches({ id: "b2", lat: 30.0, lon: -40.0 })).toBe(false);
  });

  it("is false for a missing beach or missing coordinates", function () {
    expect(matches(null)).toBe(false);
    expect(matches({ id: "b3", lat: null, lon: null })).toBe(false);
  });
});

describe("stationUrl", function () {
  it("builds the realtime2 file URL for a station id", function () {
    expect(stationUrl("45164")).toBe("https://www.ndbc.noaa.gov/data/realtime2/45164.txt");
  });
});

describe("ndbcBuoySource object", function () {
  it("exposes the locked supplemental-wave-source shape", function () {
    expect(ndbcBuoySource.id).toBe("ndbc-buoys");
    expect(ndbcBuoySource.model).toBe(NDBC_MODEL);
    expect(typeof ndbcBuoySource.label).toBe("string");
    expect(typeof ndbcBuoySource.url).toBe("string");
    expect(typeof ndbcBuoySource.matches).toBe("function");
    expect(typeof ndbcBuoySource.waveFt).toBe("function");
  });

  it("aliases ndbcWaveSource to the same object", function () {
    expect(ndbcWaveSource).toBe(ndbcBuoySource);
  });

  it("every curated station has an id and finite coordinates", function () {
    expect(NDBC_STATIONS.length).toBeGreaterThan(0);
    for (let i = 0; i < NDBC_STATIONS.length; i++) {
      const st = NDBC_STATIONS[i];
      expect(typeof st.id).toBe("string");
      expect(st.id.length).toBeGreaterThan(0);
      expect(isFinite(st.lat)).toBe(true);
      expect(isFinite(st.lon)).toBe(true);
    }
  });

  it("keeps the distance cap positive", function () {
    expect(NDBC_MAX_DISTANCE_KM).toBeGreaterThan(0);
  });
});
