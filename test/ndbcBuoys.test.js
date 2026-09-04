// test/ndbcBuoys.test.js
// Pure-parser + station-selection tests for the NDBC water-temperature source.
// No network: every realtime2 fixture is built inline.

import { describe, it, expect } from "vitest";
import {
  parseNdbcWaterTempF,
  nearestStationFor,
  nearestWaterTempStation,
  stationsWithCapability,
  stationUrl,
  NDBC_STATIONS,
  NDBC_CAPABILITIES,
  CAP_WATER_TEMP,
  NDBC_HEAD_BYTES,
  NDBC_WATER_TEMP_MAX_DISTANCE_KM,
  NDBC_WATER_TEMP_MAX_OBS_AGE_MS
} from "../src/waveSources/ndbcBuoys.js";

// The two comment header lines every realtime2 file carries.
const HEADER = [
  "#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE",
  "#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft"
];

// Build a realtime2 body from an array of data-row strings (newest first),
// prefixed with the standard two-line header.
function ndbcFile(dataRows) {
  return HEADER.concat(dataRows).join("\n") + "\n";
}

// A single data row. ts is "YYYY MM DD hh mm"; wtmp is the WTMP token (a Celsius
// string or "MM"), landing at column index 14. The other columns are filler so
// the row is full-width.
function wtRow(ts, wtmp) {
  return ts + " 280  5.0  6.0   1.2     5    MM  MM 1016.2  18.3  " + wtmp + "    MM   MM   MM    MM";
}

const NOW = "2026-07-22T11:30:00Z"; // just after an 11:00Z observation

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
    // Negatives are legitimate down to -2 C, so -10 C is corrupt and must
    // degrade — falling through to the next valid row.
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

  it("skips a row whose WTMP parses but timestamp fields are non-numeric", function () {
    const bad = "YYYY MM DD hh mm 280 5.0 6.0 1.2 5 MM MM 1016 18 22 MM MM MM MM";
    const text = ndbcFile([bad, wtRow("2026 07 22 11 00", "19.0")]);
    const out = parseNdbcWaterTempF(text, NOW);
    expect(out).not.toBe(null);
    expect(out.tempC).toBeCloseTo(19.0, 5);
  });
});

describe("station capabilities", function () {
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

  it("admits the whole table for water temperature, NOS gauges included", function () {
    // The NOS water-level network reports WTMP and no WVHT, so an admission rule
    // shaped around wave height excluded all of it. Eligibility is per-reading
    // now, and this is the count that rule produces.
    expect(stationsWithCapability(CAP_WATER_TEMP).length).toBe(72);
    expect(stationsWithCapability(CAP_WATER_TEMP).length).toBe(NDBC_STATIONS.length);
  });
});

describe("nearestWaterTempStation", function () {
  it("resolves the NOS gauge next to a beach on the open lake shore", function () {
    // Ottawa Beach, Holland MI: a live NOS gauge sits 0.3 km offshore.
    const st = nearestWaterTempStation(42.77545, -86.2113193);
    expect(st).not.toBe(null);
    expect(st.id).toBe("hlnm4");
    expect(st.distanceKm).toBeLessThan(1);
    expect(st.capability).toBe(CAP_WATER_TEMP);
  });

  it("returns null when no station is inside the cap", function () {
    // Middle of the Atlantic — far from every station in the table.
    expect(nearestWaterTempStation(30.0, -40.0)).toBe(null);
  });

  it("returns null for invalid coordinates", function () {
    expect(nearestWaterTempStation(null, -81.7)).toBe(null);
    expect(nearestWaterTempStation(41.7, undefined)).toBe(null);
    expect(nearestWaterTempStation(NaN, NaN)).toBe(null);
  });

  it("keeps the cap at 25 km, set by the cross-shore error a printed number can absorb", function () {
    // A temperature renders as a precise figure next to the beach name, and a
    // summer upwelling front sits 5-15 km offshore, so 25 km cross-shore is the
    // tolerance. Widening this silently prints the wrong water.
    expect(NDBC_WATER_TEMP_MAX_DISTANCE_KM).toBe(25);
  });

  it("never returns a station beyond the cap, from anywhere in the table", function () {
    for (let i = 0; i < NDBC_STATIONS.length; i++) {
      const st = NDBC_STATIONS[i];
      const got = nearestWaterTempStation(st.lat, st.lon);
      expect(got).not.toBe(null);
      expect(got.distanceKm).toBeLessThanOrEqual(NDBC_WATER_TEMP_MAX_DISTANCE_KM);
      expect(got.capability).toBe(CAP_WATER_TEMP);
    }
  });
});

describe("nearestStationFor", function () {
  it("returns null and never a station for an unknown capability", function () {
    // A default capability here would let a call site inherit an eligibility rule
    // it never asked for, so an unrecognised one must yield nothing at all.
    expect(nearestStationFor(undefined, 41.75, -81.70)).toBe(null);
    expect(nearestStationFor("", 41.75, -81.70)).toBe(null);
    expect(nearestStationFor("air_temp", 41.75, -81.70)).toBe(null);
    expect(nearestStationFor(CAP_WATER_TEMP + "x", 41.75, -81.70)).toBe(null);
  });

  it("is what the named wrapper delegates to", function () {
    expect(nearestStationFor(CAP_WATER_TEMP, 42.77545, -86.2113193))
      .toEqual(nearestWaterTempStation(42.77545, -86.2113193));
  });
});

describe("station table and realtime2 urls", function () {
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

  it("builds the realtime2 file URL for a station id", function () {
    expect(stationUrl("45164")).toBe("https://www.ndbc.noaa.gov/data/realtime2/45164.txt");
  });

  it("upcases an alphanumeric id for the case-sensitive realtime2 path", function () {
    // NDBC serves realtime2 files under UPPERCASE names while the master
    // station table spells the NOS stations lowercase. A lowercase request 404s,
    // which degrades to null and is indistinguishable from the winter gap — so
    // the beach silently loses its temperature. This assertion is the guard.
    expect(stationUrl("hlnm4")).toBe("https://www.ndbc.noaa.gov/data/realtime2/HLNM4.txt");
    expect(stationUrl("HLNM4")).toBe("https://www.ndbc.noaa.gov/data/realtime2/HLNM4.txt");
  });

  it("leaves numeric buoy ids untouched", function () {
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

  it("keeps the Range ceiling above the 12 h window the parser accepts", function () {
    // 32 KB holds ~340 six-minute NOS rows (~34 h); truncation can only drop the
    // OLDEST rows, so the freshest reading is always inside the fetched bytes.
    expect(NDBC_HEAD_BYTES).toBe(32768);
  });
});
