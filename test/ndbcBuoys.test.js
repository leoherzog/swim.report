// test/ndbcBuoys.test.js
// Pure-parser + station-selection tests for the NDBC supplemental wave source.
// No network: every realtime2 fixture is built inline. Project style: ES
// modules, NO template literals (string concat with +), function () {}
// callbacks.

import { describe, it, expect } from "vitest";
import {
  parseNdbcWaveFt,
  parseNdbcWaterTempF,
  nearestStationFor,
  nearestWaveStation,
  nearestWaterTempStation,
  stationsWithCapability,
  stationUrl,
  matches,
  ndbcBuoySource,
  ndbcWaveSource,
  NDBC_MODEL,
  NDBC_STATIONS,
  NDBC_CAPABILITIES,
  CAP_WAVES,
  CAP_WATER_TEMP,
  NDBC_MAX_DISTANCE_KM,
  NDBC_WATER_TEMP_MAX_DISTANCE_KM,
  NDBC_WATER_TEMP_MAX_OBS_AGE_MS
} from "../src/waveSources/ndbcBuoys.js";

// The ten ids the COLOR path may use. Frozen: wave height feeds src/rules.js,
// so a change here is a RULES_VERSION discussion, and this literal is the CI
// guard that one cannot happen by accident (e.g. by pasting CAP_WAVES onto a
// row while adding water-temp stations).
const FROZEN_WAVE_IDS = [
  "45001", "45002", "45004", "45005", "45012",
  "45013", "45161", "45164", "45165", "45167"
];

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

// A single data row for the WATER-TEMP tests: ts is "YYYY MM DD hh mm"; wtmp is
// the WTMP token (a Celsius string or "MM"), placed at column index 14. WVHT and
// the intervening columns are filler so the row is full-width.
function wtRow(ts, wtmp) {
  return ts + " 280  5.0  6.0   1.2     5    MM  MM 1016.2  18.3  " + wtmp + "    MM   MM   MM    MM";
}

describe("parseNdbcWaterTempF", function () {
  it("parses the newest fresh WTMP and converts Celsius to Fahrenheit", function () {
    const text = ndbcFile([
      wtRow("2026 07 22 11 00", "24.6"),
      wtRow("2026 07 22 10 00", "24.0")
    ]);
    const out = parseNdbcWaterTempF(text, NOW);
    expect(out).not.toBe(null);
    expect(out.tempC).toBeCloseTo(24.6, 5);
    expect(out.tempF).toBeCloseTo(76.28, 5);
    expect(out.observedIso).toBe("2026-07-22T11:00:00.000Z");
  });

  it("passes 0 C (near-freezing water) through as a finite reading", function () {
    const out = parseNdbcWaterTempF(ndbcFile([wtRow("2026 07 22 11 00", "0.0")]), NOW);
    expect(out).not.toBe(null);
    expect(out.tempF).toBeCloseTo(32, 5);
  });

  it("skips a newest MM WTMP and uses the next fresh valid row still in window", function () {
    const text = ndbcFile([
      wtRow("2026 07 22 11 20", "MM"),
      wtRow("2026 07 22 11 00", "20.0")
    ]);
    const out = parseNdbcWaterTempF(text, NOW);
    expect(out).not.toBe(null);
    expect(out.tempC).toBeCloseTo(20.0, 5);
    expect(out.tempF).toBeCloseTo(68, 5);
    expect(out.observedIso).toBe("2026-07-22T11:00:00.000Z");
  });

  it("returns null when the freshest real WTMP is older than the 12 h window", function () {
    // Freshest real reading is 07-21 22:00Z, 13.5 h before NOW (07-22 11:30Z).
    const text = ndbcFile([
      wtRow("2026 07 22 11 00", "MM"),
      wtRow("2026 07 21 22 00", "18.0")
    ]);
    expect(parseNdbcWaterTempF(text, NOW)).toBe(null);
  });

  it("accepts a reading right at the edge of the 12 h freshness window", function () {
    const edgeIso = new Date(Date.parse(NOW) - NDBC_WATER_TEMP_MAX_OBS_AGE_MS).toISOString();
    // NOW is 2026-07-22T11:30Z, so the edge is 2026-07-21T23:30Z.
    const text = ndbcFile([wtRow("2026 07 21 23 30", "17.0")]);
    const out = parseNdbcWaterTempF(text, NOW);
    expect(out).not.toBe(null);
    expect(out.observedIso).toBe(edgeIso);
  });

  it("rejects a reading more than 10 min in the future (clock skew guard)", function () {
    // 11:45Z is 15 min after NOW (11:30Z) -> skipped; no other rows -> null.
    expect(parseNdbcWaterTempF(ndbcFile([wtRow("2026 07 22 11 45", "22.0")]), NOW)).toBe(null);
  });

  it("rejects an out-of-range WTMP as corrupt (never a wrong temperature)", function () {
    const text = ndbcFile([
      wtRow("2026 07 22 11 00", "99.0"),
      wtRow("2026 07 22 10 30", "21.0")
    ]);
    const out = parseNdbcWaterTempF(text, NOW);
    expect(out).not.toBe(null);
    expect(out.tempC).toBeCloseTo(21.0, 5);
  });

  it("rejects a WTMP below the sanity floor (MIN_REASONABLE_C = -2 C)", function () {
    // Unlike WVHT (all negatives rejected), WTMP allows negatives down to -2 C,
    // so -10 C is corrupt and must degrade — falling through to the next valid row.
    const text = ndbcFile([
      wtRow("2026 07 22 11 00", "-10.0"),
      wtRow("2026 07 22 10 30", "3.0")
    ]);
    const out = parseNdbcWaterTempF(text, NOW);
    expect(out).not.toBe(null);
    expect(out.tempC).toBeCloseTo(3.0, 5);
  });

  it("skips a row too short to hold the WTMP column (index 14)", function () {
    const short = "2026 07 22 11 00 280 5.0 6.0 1.2 5 MM MM";
    const text = ndbcFile([short, wtRow("2026 07 22 10 40", "19.5")]);
    const out = parseNdbcWaterTempF(text, NOW);
    expect(out).not.toBe(null);
    expect(out.tempC).toBeCloseTo(19.5, 5);
  });

  it("returns null for null, empty, header-only, and garbage input", function () {
    expect(parseNdbcWaterTempF(null, NOW)).toBe(null);
    expect(parseNdbcWaterTempF("", NOW)).toBe(null);
    expect(parseNdbcWaterTempF(ndbcFile([]), NOW)).toBe(null);
    expect(parseNdbcWaterTempF("<<< not the expected format >>>", NOW)).toBe(null);
  });

  it("returns null when nowIso is missing or unparseable", function () {
    const text = ndbcFile([wtRow("2026 07 22 11 00", "24.6")]);
    expect(parseNdbcWaterTempF(text, null)).toBe(null);
    expect(parseNdbcWaterTempF(text, "")).toBe(null);
    expect(parseNdbcWaterTempF(text, "not-a-date")).toBe(null);
  });
});

describe("station capabilities", function () {
  it("freezes the wave-capable set to exactly the ten color-path ids", function () {
    const ids = stationsWithCapability(CAP_WAVES).map(function (st) { return st.id; }).sort();
    expect(ids).toEqual(FROZEN_WAVE_IDS.slice().sort());
  });

  it("declares a known, non-empty capability set on every row", function () {
    for (let i = 0; i < NDBC_STATIONS.length; i++) {
      const st = NDBC_STATIONS[i];
      expect(Array.isArray(st.caps)).toBe(true);
      expect(st.caps.length).toBeGreaterThan(0);
      for (let j = 0; j < st.caps.length; j++) {
        expect(NDBC_CAPABILITIES.indexOf(st.caps[j])).not.toBe(-1);
      }
    }
  });

  it("has no duplicate station ids", function () {
    const seen = {};
    for (let i = 0; i < NDBC_STATIONS.length; i++) {
      const key = NDBC_STATIONS[i].id.toLowerCase();
      expect(seen[key]).toBe(undefined);
      seen[key] = true;
    }
  });

  it("carries many more temp-capable stations than wave-capable ones", function () {
    // Guards the whole point of the split: the NOS water-level network reports
    // WTMP and no WVHT, so a wave-shaped filter used to exclude all of it.
    expect(stationsWithCapability(CAP_WATER_TEMP).length)
      .toBeGreaterThan(stationsWithCapability(CAP_WAVES).length * 3);
  });
});

describe("nearestWaveStation", function () {
  it("picks the nearest wave-capable station within the cap", function () {
    // Point next to the Cleveland buoy (45164 @ 41.748,-81.698).
    const st = nearestWaveStation(41.75, -81.70);
    expect(st).not.toBe(null);
    expect(st.id).toBe("45164");
    expect(st.distanceKm).toBeLessThan(5);
    expect(st.capability).toBe(CAP_WAVES);
  });

  it("returns null when no station is within NDBC_MAX_DISTANCE_KM", function () {
    // Middle of the Atlantic — far from every Great Lakes buoy.
    expect(nearestWaveStation(30.0, -40.0)).toBe(null);
  });

  it("returns null for invalid coordinates", function () {
    expect(nearestWaveStation(null, -81.7)).toBe(null);
    expect(nearestWaveStation(41.7, undefined)).toBe(null);
    expect(nearestWaveStation(NaN, NaN)).toBe(null);
  });

  it("chooses the closer of two nearby stations", function () {
    // Toledo (45165 @ 41.704,-83.264) vs West Erie (45005 @ 41.677,-82.398).
    const st = nearestWaveStation(41.70, -83.20);
    expect(st.id).toBe("45165");
  });

  it("never returns a temp-only station, however close it sits", function () {
    // Ottawa Beach, Holland MI: the NOS gauge hlnm4 is 0.3 km away and reports
    // no wave height at all. This is the regression the capability split exists
    // to prevent — a temp station leaking onto the color path.
    const st = nearestWaveStation(42.77545, -86.2113193);
    expect(st).toBe(null);
  });
});

describe("nearestWaterTempStation", function () {
  it("resolves the NOS gauge next to a beach the wave list could never reach", function () {
    // The bug in one assertion. Ottawa Beach's nearest WAVE station is 47 km
    // away (and has been off-air since 2026-08-18), so the page showed no water
    // temperature while a live NOS gauge sat 0.3 km offshore.
    const st = nearestWaterTempStation(42.77545, -86.2113193);
    expect(st).not.toBe(null);
    expect(st.id).toBe("hlnm4");
    expect(st.distanceKm).toBeLessThan(1);
    expect(st.capability).toBe(CAP_WATER_TEMP);
  });

  it("applies its own tighter cap, not the wave cap", function () {
    expect(NDBC_WATER_TEMP_MAX_DISTANCE_KM).toBeLessThan(NDBC_MAX_DISTANCE_KM);
    // Due west of the Cleveland buoy (41.748,-81.698) by ~33 km: inside the
    // 40 km wave cap, outside the 25 km water-temp cap. The nearest station is
    // the same platform for both readings, so only the cap can separate them.
    const lonOffset = 33 / (111.32 * Math.cos(41.748 * Math.PI / 180));
    const lat = 41.748;
    const lon = -81.698 - lonOffset;
    const wave = nearestWaveStation(lat, lon);
    expect(wave).not.toBe(null);
    expect(wave.distanceKm).toBeGreaterThan(NDBC_WATER_TEMP_MAX_DISTANCE_KM);
    const temp = nearestWaterTempStation(lat, lon);
    if (temp !== null) {
      expect(temp.distanceKm).toBeLessThanOrEqual(NDBC_WATER_TEMP_MAX_DISTANCE_KM);
    }
  });

  it("returns null for invalid coordinates", function () {
    expect(nearestWaterTempStation(null, -81.7)).toBe(null);
    expect(nearestWaterTempStation(41.7, undefined)).toBe(null);
    expect(nearestWaterTempStation(NaN, NaN)).toBe(null);
  });

  it("returns a station only from the temp-capable pool", function () {
    const pool = {};
    const temps = stationsWithCapability(CAP_WATER_TEMP);
    for (let i = 0; i < temps.length; i++) {
      pool[temps[i].id] = true;
    }
    for (let i = 0; i < NDBC_STATIONS.length; i++) {
      const st = NDBC_STATIONS[i];
      const got = nearestWaterTempStation(st.lat, st.lon);
      if (got !== null) {
        expect(pool[got.id]).toBe(true);
      }
    }
  });
});

describe("nearestStationFor", function () {
  it("returns null and never a station for an unknown capability", function () {
    // A default capability here would have rebuilt the exact defect this module
    // was fixing — a call site inheriting an eligibility rule it never asked
    // for — so an unrecognised one must yield nothing at all.
    expect(nearestStationFor(undefined, 41.75, -81.70)).toBe(null);
    expect(nearestStationFor("", 41.75, -81.70)).toBe(null);
    expect(nearestStationFor("air_temp", 41.75, -81.70)).toBe(null);
    expect(nearestStationFor(CAP_WAVES + "x", 41.75, -81.70)).toBe(null);
  });

  it("is what the two named wrappers delegate to", function () {
    expect(nearestStationFor(CAP_WAVES, 41.75, -81.70))
      .toEqual(nearestWaveStation(41.75, -81.70));
    expect(nearestStationFor(CAP_WATER_TEMP, 42.77545, -86.2113193))
      .toEqual(nearestWaterTempStation(42.77545, -86.2113193));
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

  it("keeps both distance caps positive", function () {
    expect(NDBC_MAX_DISTANCE_KM).toBeGreaterThan(0);
    expect(NDBC_WATER_TEMP_MAX_DISTANCE_KM).toBeGreaterThan(0);
  });

  it("upcases an alphanumeric id for the case-sensitive realtime2 path", function () {
    // NDBC serves realtime2 files under UPPERCASE names while the master
    // station table spells the NOS stations lowercase. A lowercase request 404s,
    // which degrades to null and is indistinguishable from the winter gap — so
    // the beach silently loses its temperature. This assertion is the guard.
    expect(stationUrl("hlnm4")).toBe("https://www.ndbc.noaa.gov/data/realtime2/HLNM4.txt");
    expect(stationUrl("HLNM4")).toBe("https://www.ndbc.noaa.gov/data/realtime2/HLNM4.txt");
  });

  it("leaves numeric buoy ids untouched, so the color path is byte-identical", function () {
    expect(stationUrl("45164")).toBe("https://www.ndbc.noaa.gov/data/realtime2/45164.txt");
    expect(stationUrl("4403585")).toBe("https://www.ndbc.noaa.gov/data/realtime2/4403585.txt");
  });

  it("builds an uppercase realtime2 filename for every station in the table", function () {
    // Class guard: the duplicate-id test lowercases before comparing, so it can
    // never surface a case problem. This one asserts the URL actually requested.
    for (let i = 0; i < NDBC_STATIONS.length; i++) {
      const url = stationUrl(NDBC_STATIONS[i].id);
      const file = url.slice(url.lastIndexOf("/") + 1, url.length - ".txt".length);
      expect(file).toBe(file.toUpperCase());
      expect(file.length).toBeGreaterThan(0);
    }
  });
});
