// THE READER CONTRACT for the NOAA GRIB2 wave pipeline, the mirror of
// test/buildWaveSql.test.js. Every failure here is silent in production:
//
//   * Reading hour 0 of a series written 19 h ago colors today's flag with
//     yesterday's sea state, and nothing in the payload marks it.
//   * Falling back to a spent series' own waveHeightFt resurrects exactly the
//     reading the hour index exists to retire.
//   * Offering the stored hour-0 wind at hour 11 puts an 11 h old wind on the color
//     path, where rules.js step 4 turns it straight into a color.

import { describe, it, expect } from "vitest";
import { resolveWaveInput, waveSeriesHourIndex } from "../src/waveInput.js";

const START = "2026-09-08T00:00:00.000Z";
const START_MS = Date.parse(START);

function at(hours) {
  return START_MS + hours * 3600000;
}

// The shape scripts/sample-waves.js emits for a beach with a wet wave cell.
function seriesRecord(overrides) {
  const hoursFt = [];
  for (let i = 0; i < 24; i = i + 1) { hoursFt.push(1 + i); }
  return Object.assign({
    beachId: "osm-node-1",
    waveHeightFt: 1,
    model: "noaa_gfswave",
    windSpeedMph: null,
    windGustMph: null,
    startIso: START,
    hoursFt: hoursFt,
    updated: START
  }, overrides || {});
}

// The shape it emits for a beach with no wet wave cell: one hour-0 wind sample and
// no series at all, which is what earns it the short scalar lease.
function windRecord(overrides) {
  return Object.assign({
    beachId: "osm-node-2",
    waveHeightFt: null,
    model: null,
    windSpeedMph: 26,
    windGustMph: null,
    startIso: null,
    hoursFt: null,
    updated: START
  }, overrides || {});
}

describe("waveSeriesHourIndex", function () {
  it("counts whole elapsed hours", function () {
    expect(waveSeriesHourIndex(START_MS, at(0), 24)).toBe(0);
    expect(waveSeriesHourIndex(START_MS, START_MS + 3599999, 24)).toBe(0);
    expect(waveSeriesHourIndex(START_MS, at(11), 24)).toBe(11);
    expect(waveSeriesHourIndex(START_MS, at(23), 24)).toBe(23);
  });

  it("answers null once the series is spent rather than clamping to its last hour",
    function () {
      // Clamping would hold the final hour's height on the color path for as long as
      // the key lived, which is the failure the lease and this index share.
      expect(waveSeriesHourIndex(START_MS, at(24), 24)).toBe(null);
      expect(waveSeriesHourIndex(START_MS, at(400), 24)).toBe(null);
    });

  it("clamps a start in the future to hour 0, matching trimWaveSeries", function () {
    expect(waveSeriesHourIndex(START_MS, at(-3), 24)).toBe(0);
  });

  it("answers null for an unusable start or length", function () {
    expect(waveSeriesHourIndex(NaN, at(1), 24)).toBe(null);
    expect(waveSeriesHourIndex(START_MS, at(1), 0)).toBe(null);
    expect(waveSeriesHourIndex(START_MS, at(1), NaN)).toBe(null);
  });
});

describe("resolveWaveInput", function () {
  it("reads the hour being estimated, not hour 0", function () {
    expect(resolveWaveInput(seriesRecord(), at(0)).waveHeightFt).toBe(1);
    expect(resolveWaveInput(seriesRecord(), at(6)).waveHeightFt).toBe(7);
    expect(resolveWaveInput(seriesRecord(), at(23)).waveHeightFt).toBe(24);
  });

  it("reports the hour it read, so a run can be audited against its own cycle",
    function () {
      expect(resolveWaveInput(seriesRecord(), at(6)).hourIndex).toBe(6);
    });

  it("names the model for whichever hour it resolved", function () {
    expect(resolveWaveInput(seriesRecord(), at(6)).model).toBe("noaa_gfswave");
  });

  it("drops the model name for a masked hour, so no source is attributed", function () {
    const hoursFt = seriesRecord().hoursFt.slice();
    hoursFt[6] = null;
    const out = resolveWaveInput(seriesRecord({ hoursFt: hoursFt }), at(6));
    expect(out.waveHeightFt).toBe(null);
    expect(out.model).toBe(null);
  });

  it("resolves a series whose hour 0 is masked but whose later hours are not",
    function () {
      const hoursFt = seriesRecord().hoursFt.slice();
      hoursFt[0] = null;
      const record = seriesRecord({ hoursFt: hoursFt, waveHeightFt: null });
      expect(resolveWaveInput(record, at(0)).waveHeightFt).toBe(null);
      expect(resolveWaveInput(record, at(4)).waveHeightFt).toBe(5);
    });

  it("yields nothing at all once the series is spent", function () {
    // Never the record's own waveHeightFt, which is hour 0 and a full series old.
    expect(resolveWaveInput(seriesRecord(), at(24))).toBe(null);
    expect(resolveWaveInput(seriesRecord(), at(100))).toBe(null);
  });

  it("never falls back to hour 0 while the series is live", function () {
    const hoursFt = seriesRecord().hoursFt.slice();
    hoursFt[9] = null;
    const out = resolveWaveInput(seriesRecord({ hoursFt: hoursFt }), at(9));
    expect(out.waveHeightFt).toBe(null);
  });

  it("takes the scalar height when the record carries no series", function () {
    // The wind-only and pre-series shapes, both bounded by the short scalar lease.
    const scalar = windRecord({ waveHeightFt: 3.2, model: "noaa_glwu",
      windSpeedMph: null });
    expect(resolveWaveInput(scalar, at(5)).waveHeightFt).toBe(3.2);
    expect(resolveWaveInput(scalar, at(5)).hourIndex).toBe(null);
  });

  it("offers the wind only where the resolved wave height is null", function () {
    expect(resolveWaveInput(windRecord(), at(0)).windSpeedMph).toBe(26);
    const both = seriesRecord({ windSpeedMph: 26 });
    expect(resolveWaveInput(both, at(0)).windSpeedMph).toBe(null);
  });

  it("offers the wind only at hour 0 of a series, since it is an hour-0 sample",
    function () {
      const hoursFt = [];
      for (let i = 0; i < 24; i = i + 1) { hoursFt.push(null); }
      hoursFt[1] = 2;
      const record = seriesRecord({ hoursFt: hoursFt, waveHeightFt: null,
        windSpeedMph: 26 });
      expect(resolveWaveInput(record, at(0)).windSpeedMph).toBe(26);
      // Hour 2 is masked too, so wave height is null and the wind would otherwise
      // stand in — two hours stale, on a key leased for a day.
      expect(resolveWaveInput(record, at(2)).waveHeightFt).toBe(null);
      expect(resolveWaveInput(record, at(2)).windSpeedMph).toBe(null);
    });

  it("treats a malformed series as absent rather than repairing it", function () {
    const cases = [
      seriesRecord({ startIso: "not a time" }),
      seriesRecord({ hoursFt: "1,2,3" }),
      seriesRecord({ hoursFt: [] }),
      seriesRecord({ hoursFt: [1, "2", 3] }),
      seriesRecord({ hoursFt: [1, Infinity, 3] })
    ];
    for (let i = 0; i < cases.length; i = i + 1) {
      const out = resolveWaveInput(cases[i], at(6));
      // Falls through to the hour-0 scalar, which the short lease bounds.
      expect(out.waveHeightFt).toBe(1);
      expect(out.hourIndex).toBe(null);
    }
  });

  it("never throws, and never invents a reading", function () {
    const junk = [null, undefined, 3, "waveinput", [], { }, { hoursFt: {} },
      { waveHeightFt: "2.5" }, { waveHeightFt: NaN }];
    for (let i = 0; i < junk.length; i = i + 1) {
      const out = resolveWaveInput(junk[i], at(1));
      if (out !== null) {
        expect(out.waveHeightFt).toBe(null);
        expect(out.windSpeedMph).toBe(null);
      }
    }
  });

  it("keeps windGustMph null, which is what gfswave publishes", function () {
    expect(resolveWaveInput(windRecord({ windGustMph: null }), at(0)).windGustMph)
      .toBe(null);
  });

  it("ignores models, sources and byModel on the merged stored record", function () {
    // byModel[gridId] is the same array object as hoursFt, and the strip is its
    // only reader. Indexing it here instead of hoursFt would read a second
    // model's series for the color while the strip drew the first.
    const record = seriesRecord({
      models: ["noaa_gfswave", "noaa_glwu"],
      sources: [{ label: "NOAA GFS Wave Model", url: "https://polar.ncep.noaa.gov/waves/" }],
      byModel: { "noaa_glwu": [9, 9, 9] }
    });
    const out = resolveWaveInput(record, at(6));
    expect(out.waveHeightFt).toBe(7);
    expect(out.hourIndex).toBe(6);
    expect(out.model).toBe("noaa_gfswave");
  });

  it("does not mistake byModel for a series when hoursFt is absent", function () {
    const record = {
      beachId: "osm-node-1",
      waveHeightFt: 1,
      model: "noaa_gfswave",
      windSpeedMph: null,
      windGustMph: null,
      startIso: START,
      byModel: { "noaa_glwu": [9, 9, 9] }
    };
    const out = resolveWaveInput(record, at(6));
    // No hoursFt, so there is no series: the hour-0 scalar answers and the hour
    // index stays null.
    expect(out.waveHeightFt).toBe(1);
    expect(out.hourIndex).toBe(null);
  });
});
