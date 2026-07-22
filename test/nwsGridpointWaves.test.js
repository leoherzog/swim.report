// test/nwsGridpointWaves.test.js
// Pure-parser tests for the NWS gridpoint supplemental wave source. No network:
// every fixture is built inline. Project style: ES modules, NO template
// literals (string concat with +), function () {} callbacks.

import { describe, it, expect } from "vitest";
import {
  parseGridpointWaveFt,
  iso8601DurationMs,
  matches,
  nwsGridpointWaveSource,
  GRIDPOINT_MODEL
} from "../src/waveSources/nwsGridpointWaves.js";

const METERS_TO_FEET = 3.28084;

// Build a gridpoint JSON. waveHeight / windWaveHeight are passed as full series
// objects (or undefined to omit).
function gridpoint(waveHeight, windWaveHeight) {
  const props = {};
  if (waveHeight !== undefined) {
    props.waveHeight = waveHeight;
  }
  if (windWaveHeight !== undefined) {
    props.windWaveHeight = windWaveHeight;
  }
  return { properties: props };
}

function series(uom, values) {
  return { uom: uom, values: values };
}

// A single 6-hour interval covering 12:00-18:00 UTC on 2026-07-22.
function sixHourValues(meters) {
  return [{ validTime: "2026-07-22T12:00:00+00:00/PT6H", value: meters }];
}

const NOW = "2026-07-22T14:30:00+00:00"; // inside 12:00-18:00

describe("parseGridpointWaveFt", function () {
  it("returns the waveHeight metres value valid at nowIso, converted to feet", function () {
    const json = gridpoint(series("wmoUnit:m", sixHourValues(0.9)));
    const ft = parseGridpointWaveFt(json, NOW);
    expect(ft).toBeCloseTo(0.9 * METERS_TO_FEET, 5);
  });

  it("assumes metres when uom is absent", function () {
    const json = gridpoint(series(undefined, sixHourValues(1.5)));
    expect(parseGridpointWaveFt(json, NOW)).toBeCloseTo(1.5 * METERS_TO_FEET, 5);
  });

  it("picks the interval that contains nowIso in a multi-period series", function () {
    const json = gridpoint(series("wmoUnit:m", [
      { validTime: "2026-07-22T06:00:00+00:00/PT6H", value: 0.3 },
      { validTime: "2026-07-22T12:00:00+00:00/PT6H", value: 1.2 },
      { validTime: "2026-07-22T18:00:00+00:00/PT6H", value: 2.0 }
    ]));
    // NOW 14:30 is inside the 12:00-18:00 period -> 1.2 m.
    expect(parseGridpointWaveFt(json, NOW)).toBeCloseTo(1.2 * METERS_TO_FEET, 5);
  });

  it("uses the first entry when nowIso precedes the whole series", function () {
    const json = gridpoint(series("wmoUnit:m", [
      { validTime: "2026-07-22T12:00:00+00:00/PT6H", value: 0.8 },
      { validTime: "2026-07-22T18:00:00+00:00/PT6H", value: 1.1 }
    ]));
    const before = "2026-07-22T09:00:00+00:00";
    expect(parseGridpointWaveFt(json, before)).toBeCloseTo(0.8 * METERS_TO_FEET, 5);
  });

  it("returns null when nowIso is past the end of the series", function () {
    const json = gridpoint(series("wmoUnit:m", sixHourValues(0.9)));
    const after = "2026-07-23T00:00:00+00:00"; // after 18:00
    expect(parseGridpointWaveFt(json, after)).toBe(null);
  });

  it("returns 0 for a calm (0 m) cell", function () {
    const json = gridpoint(series("wmoUnit:m", sixHourValues(0)));
    expect(parseGridpointWaveFt(json, NOW)).toBe(0);
  });

  it("falls back to windWaveHeight when waveHeight is masked at nowIso", function () {
    const json = gridpoint(
      series("wmoUnit:m", sixHourValues(null)),
      series("wmoUnit:m", sixHourValues(0.6))
    );
    expect(parseGridpointWaveFt(json, NOW)).toBeCloseTo(0.6 * METERS_TO_FEET, 5);
  });

  it("returns null when the only series is masked and there is no fallback", function () {
    const json = gridpoint(series("wmoUnit:m", sixHourValues(null)));
    expect(parseGridpointWaveFt(json, NOW)).toBe(null);
  });

  it("returns null when neither waveHeight nor windWaveHeight is present", function () {
    const json = gridpoint(undefined, undefined);
    expect(parseGridpointWaveFt(json, NOW)).toBe(null);
  });

  it("rejects a non-metre unit rather than guessing", function () {
    const json = gridpoint(series("wmoUnit:ft", sixHourValues(3.0)));
    expect(parseGridpointWaveFt(json, NOW)).toBe(null);
  });

  it("rejects a km/h unit whose token also contains the letter m", function () {
    const json = gridpoint(series("wmoUnit:km_h-1", sixHourValues(2.0)));
    expect(parseGridpointWaveFt(json, NOW)).toBe(null);
  });

  it("returns null for a negative value", function () {
    const json = gridpoint(series("wmoUnit:m", sixHourValues(-1.0)));
    expect(parseGridpointWaveFt(json, NOW)).toBe(null);
  });

  it("returns null for an empty values array", function () {
    const json = gridpoint(series("wmoUnit:m", []));
    expect(parseGridpointWaveFt(json, NOW)).toBe(null);
  });

  it("skips entries with a malformed validTime and still resolves a good one", function () {
    const json = gridpoint(series("wmoUnit:m", [
      { validTime: "not-a-valid-time", value: 9.9 },
      { validTime: "2026-07-22T12:00:00+00:00/PT6H", value: 1.0 }
    ]));
    expect(parseGridpointWaveFt(json, NOW)).toBeCloseTo(1.0 * METERS_TO_FEET, 5);
  });

  it("returns null (does not throw) for null / non-object json", function () {
    expect(parseGridpointWaveFt(null, NOW)).toBe(null);
    expect(parseGridpointWaveFt(undefined, NOW)).toBe(null);
    expect(parseGridpointWaveFt(42, NOW)).toBe(null);
    expect(parseGridpointWaveFt("<<garbage>>", NOW)).toBe(null);
  });

  it("returns null when properties is missing", function () {
    expect(parseGridpointWaveFt({}, NOW)).toBe(null);
  });

  it("returns null for a missing / non-ISO nowIso", function () {
    const json = gridpoint(series("wmoUnit:m", sixHourValues(0.9)));
    expect(parseGridpointWaveFt(json, null)).toBe(null);
    expect(parseGridpointWaveFt(json, "")).toBe(null);
    expect(parseGridpointWaveFt(json, "not-a-time")).toBe(null);
  });

  it("returns null when a non-numeric value sits at nowIso", function () {
    const json = gridpoint(series("wmoUnit:m", [
      { validTime: "2026-07-22T12:00:00+00:00/PT6H", value: "1.2" }
    ]));
    expect(parseGridpointWaveFt(json, NOW)).toBe(null);
  });
});

describe("iso8601DurationMs", function () {
  it("parses hour durations", function () {
    expect(iso8601DurationMs("PT1H")).toBe(3600 * 1000);
    expect(iso8601DurationMs("PT6H")).toBe(6 * 3600 * 1000);
  });

  it("parses day + hour + minute + second components", function () {
    expect(iso8601DurationMs("P1DT6H")).toBe((24 + 6) * 3600 * 1000);
    expect(iso8601DurationMs("PT30M")).toBe(30 * 60 * 1000);
    expect(iso8601DurationMs("PT1H30M")).toBe((3600 + 1800) * 1000);
    expect(iso8601DurationMs("PT45S")).toBe(45 * 1000);
  });

  it("returns null for a bare / empty / garbage duration", function () {
    expect(iso8601DurationMs("P")).toBe(null);
    expect(iso8601DurationMs("PT")).toBe(null);
    expect(iso8601DurationMs("")).toBe(null);
    expect(iso8601DurationMs("6H")).toBe(null);
    expect(iso8601DurationMs("garbage")).toBe(null);
    expect(iso8601DurationMs(null)).toBe(null);
    expect(iso8601DurationMs(6)).toBe(null);
  });
});

describe("matches / source object", function () {
  it("matches a beach carrying a non-empty nws_grid_url", function () {
    expect(matches({ id: "a", nws_grid_url: "https://api.weather.gov/gridpoints/GRR/33,33" })).toBe(true);
  });

  it("does not match without a usable grid url", function () {
    expect(matches({ id: "a", nws_grid_url: "" })).toBe(false);
    expect(matches({ id: "a", nws_grid_url: null })).toBe(false);
    expect(matches({ id: "a" })).toBe(false);
    expect(matches(null)).toBe(false);
  });

  it("exposes the locked source-object contract", function () {
    expect(nwsGridpointWaveSource.id).toBe("nws-gridpoint-waves");
    expect(nwsGridpointWaveSource.model).toBe(GRIDPOINT_MODEL);
    expect(GRIDPOINT_MODEL).toBe("nws_gridpoint_wave");
    expect(typeof nwsGridpointWaveSource.label).toBe("string");
    expect(typeof nwsGridpointWaveSource.url).toBe("string");
    expect(typeof nwsGridpointWaveSource.matches).toBe("function");
    expect(typeof nwsGridpointWaveSource.waveFt).toBe("function");
  });
});
