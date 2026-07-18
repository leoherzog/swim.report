// test/waveStrip.test.js
// Pure-helper coverage for the wave-forecast strip (src/frontend/waveStrip.js):
// trimming a 24-hour series to "now" forward, run-length encoding by color
// band, and the prose summary. No fetch, no Date.now.

import { describe, it, expect } from "vitest";
import {
  trimWaveSeries,
  computeWaveRuns,
  computeHazardBands,
  waveStripSummary,
  modelDisplayName,
  orderedModelIds,
  modelNowEntries,
  modelNowCaption,
  buildWaveModelChartConfig,
  waveModelSummary
} from "../src/frontend/waveStrip.js";
import { waveColorForHeight } from "../src/rules.js";

// A 24-length series of a constant finite value (helper for byModel fixtures).
function constHours(v) {
  const arr = [];
  for (let i = 0; i < 24; i++) {
    arr.push(v);
  }
  return arr;
}

const START = "2026-07-05T00:00:00.000Z";

// 24 ascending-ish heights, all finite numbers.
function fullHours() {
  const arr = [];
  for (let i = 0; i < 24; i++) {
    arr.push(1.0);
  }
  return arr;
}

function wavesWith(extra) {
  return Object.assign(
    { beachId: "osm-node-1", startIso: START, hoursFt: fullHours(),
      models: [], sources: [], updated: START },
    extra
  );
}

describe("trimWaveSeries", () => {
  it("returns all 24 hours when 0 hours have elapsed", () => {
    const out = trimWaveSeries(wavesWith({}), START);
    expect(out.totalHours).toBe(24);
    expect(out.hoursFt).toHaveLength(24);
  });

  it("trims the first 2 entries when 2 hours have elapsed, starting at index 2", () => {
    const hours = fullHours();
    for (let i = 0; i < 24; i++) {
      hours[i] = i; // make each entry identifiable by its original index
    }
    const out = trimWaveSeries(wavesWith({ hoursFt: hours }), "2026-07-05T02:00:00.000Z");
    expect(out.totalHours).toBe(22);
    expect(out.hoursFt).toHaveLength(22);
    expect(out.hoursFt[0]).toBe(2);
    expect(out.hoursFt[21]).toBe(23);
  });

  it("returns null when 25 hours have elapsed (series entirely in the past)", () => {
    expect(trimWaveSeries(wavesWith({}), "2026-07-06T01:00:00.000Z")).toBeNull();
  });

  it("returns null for an unparseable startIso", () => {
    expect(trimWaveSeries(wavesWith({ startIso: "not-a-date" }), START)).toBeNull();
  });

  it("returns null when hoursFt is the wrong length", () => {
    expect(trimWaveSeries(wavesWith({ hoursFt: [1, 2, 3] }), START)).toBeNull();
  });

  it("returns null when hoursFt is not an array", () => {
    expect(trimWaveSeries(wavesWith({ hoursFt: "nope" }), START)).toBeNull();
    expect(trimWaveSeries(wavesWith({ hoursFt: null }), START)).toBeNull();
  });

  it("returns null when any hour entry is a string (malformed payload -> omission)", () => {
    const hours = fullHours();
    hours[7] = "2.0";
    expect(trimWaveSeries(wavesWith({ hoursFt: hours }), START)).toBeNull();
  });

  it("returns null when every remaining entry is null after the trim", () => {
    const hours = fullHours();
    for (let i = 0; i < 24; i++) {
      hours[i] = null;
    }
    expect(trimWaveSeries(wavesWith({ hoursFt: hours }), START)).toBeNull();
  });

  it("clamps a negative elapsed (future startIso) to 0 and returns the untrimmed 24", () => {
    // nowIso is one hour BEFORE the series start.
    const out = trimWaveSeries(wavesWith({}), "2026-07-04T23:00:00.000Z");
    expect(out.totalHours).toBe(24);
    expect(out.hoursFt).toHaveLength(24);
  });

  it("returns null for a null waves object", () => {
    expect(trimWaveSeries(null, START)).toBeNull();
  });

  it("defaults byModel to an empty object when the field is missing", () => {
    const out = trimWaveSeries(wavesWith({}), START);
    expect(out.byModel).toEqual({});
  });

  it("defaults byModel to {} when it is malformed (not an object / an array)", () => {
    expect(trimWaveSeries(wavesWith({ byModel: "nope" }), START).byModel).toEqual({});
    expect(trimWaveSeries(wavesWith({ byModel: [1, 2, 3] }), START).byModel).toEqual({});
    expect(trimWaveSeries(wavesWith({ byModel: null }), START).byModel).toEqual({});
  });

  it("keeps only well-formed model arrays and drops malformed ones", () => {
    const out = trimWaveSeries(wavesWith({
      byModel: {
        ecmwf_wam025: constHours(2.0),
        ncep_gfswave025: [1, 2, 3],            // wrong length -> dropped
        meteofrance_wave: constHours("2.0"),   // non-number entries -> dropped
        bogus_extra: constHours(3.0)
      }
    }), START);
    expect(Object.keys(out.byModel).sort()).toEqual(["bogus_extra", "ecmwf_wam025"]);
    expect(out.byModel.ecmwf_wam025).toHaveLength(24);
  });

  it("applies the same elapsed offset to byModel as to hoursFt", () => {
    const model = [];
    for (let i = 0; i < 24; i++) { model.push(i); }
    const out = trimWaveSeries(
      wavesWith({ byModel: { ecmwf_wam025: model } }),
      "2026-07-05T02:00:00.000Z"
    );
    expect(out.hoursFt).toHaveLength(22);
    expect(out.byModel.ecmwf_wam025).toHaveLength(22);
    expect(out.byModel.ecmwf_wam025[0]).toBe(2);
    expect(out.byModel.ecmwf_wam025[21]).toBe(23);
  });

  it("drops a model whose trimmed slice is entirely null", () => {
    const model = constHours(2.0);
    for (let i = 20; i < 24; i++) { model[i] = 1.0; }  // finite only in first 20
    for (let i = 0; i < 20; i++) { model[i] = null; }  // null in first 20
    // After 22 h elapsed only indices 22,23 remain — both null here.
    const nulled = constHours(null);
    const out = trimWaveSeries(
      wavesWith({ byModel: { ecmwf_wam025: nulled, ncep_gfswave025: constHours(2.0) } }),
      "2026-07-05T22:00:00.000Z"
    );
    expect(Object.keys(out.byModel)).toEqual(["ncep_gfswave025"]);
  });

  it("never lets a garbage byModel block the main strip", () => {
    const out = trimWaveSeries(wavesWith({ byModel: { x: 42, y: "bad" } }), START);
    expect(out.totalHours).toBe(24);
    expect(out.hoursFt).toHaveLength(24);
    expect(out.byModel).toEqual({});
  });
});

describe("modelDisplayName", () => {
  it("maps known ids to their display names and passes unknown ids through", () => {
    expect(modelDisplayName("ecmwf_wam025")).toBe("ECMWF");
    expect(modelDisplayName("ncep_gfswave025")).toBe("NOAA GFS");
    expect(modelDisplayName("meteofrance_wave")).toBe("Météo-France");
    expect(modelDisplayName("some_new_model")).toBe("some_new_model");
  });
});

describe("orderedModelIds", () => {
  it("orders known ids by display order then unknown ids in payload-key order", () => {
    const ids = orderedModelIds({
      zeta_extra: [],
      meteofrance_wave: [],
      ecmwf_wam025: [],
      alpha_extra: []
    });
    expect(ids).toEqual(["ecmwf_wam025", "meteofrance_wave", "zeta_extra", "alpha_extra"]);
  });

  it("returns [] for malformed input", () => {
    expect(orderedModelIds(null)).toEqual([]);
    expect(orderedModelIds("nope")).toEqual([]);
  });
});

describe("modelNowEntries", () => {
  it("returns finite now-hour models in display order", () => {
    const trimmed = {
      totalHours: 24,
      byModel: {
        meteofrance_wave: constHours(2.9),
        ecmwf_wam025: constHours(2.6),
        ncep_gfswave025: constHours(2.4)
      }
    };
    const entries = modelNowEntries(trimmed);
    expect(entries.map(function (e) { return e.name; }))
      .toEqual(["ECMWF", "NOAA GFS", "Météo-France"]);
    expect(entries.map(function (e) { return e.valueFt; })).toEqual([2.6, 2.4, 2.9]);
  });

  it("skips a model whose now-hour is null", () => {
    const withNull = constHours(2.4);
    withNull[0] = null;
    const trimmed = {
      totalHours: 24,
      byModel: { ecmwf_wam025: constHours(2.6), ncep_gfswave025: withNull }
    };
    expect(modelNowEntries(trimmed).map(function (e) { return e.id; }))
      .toEqual(["ecmwf_wam025"]);
  });

  it("returns [] for null / empty trimmed", () => {
    expect(modelNowEntries(null)).toEqual([]);
    expect(modelNowEntries({ totalHours: 0, byModel: {} })).toEqual([]);
  });
});

describe("modelNowCaption", () => {
  it("joins names + toFixed(1) values with ' · ' in display order", () => {
    const trimmed = {
      totalHours: 24,
      byModel: {
        ecmwf_wam025: constHours(2.63),
        ncep_gfswave025: constHours(2.44),
        meteofrance_wave: constHours(2.9)
      }
    };
    expect(modelNowCaption(trimmed))
      .toBe("ECMWF 2.6 ft · NOAA GFS 2.4 ft · Météo-France 2.9 ft");
  });

  it("returns '' with fewer than two now-hour models", () => {
    expect(modelNowCaption({ totalHours: 24, byModel: { ecmwf_wam025: constHours(2.6) } }))
      .toBe("");
    expect(modelNowCaption({ totalHours: 24, byModel: {} })).toBe("");
  });
});

describe("buildWaveModelChartConfig", () => {
  function threeModelTrimmed() {
    const ecmwf = constHours(2.63);
    const gfs = constHours(2.44);
    const mf = constHours(2.9);
    gfs[1] = null; // a null hour to prove gaps are preserved
    return {
      totalHours: 24,
      byModel: { meteofrance_wave: mf, ecmwf_wam025: ecmwf, ncep_gfswave025: gfs }
    };
  }

  it("builds a config with datasets in display order, leaving the type to <wa-line-chart>", () => {
    const config = buildWaveModelChartConfig(threeModelTrimmed());
    expect(config.type).toBeUndefined();
    expect(config.data.datasets.map(function (d) { return d.label; }))
      .toEqual(["ECMWF", "NOAA GFS", "Météo-France"]);
  });

  it("labels the category axis 'Now', '+1 h', ... with length = totalHours", () => {
    const config = buildWaveModelChartConfig(threeModelTrimmed());
    expect(config.data.labels).toHaveLength(24);
    expect(config.data.labels[0]).toBe("Now");
    expect(config.data.labels[1]).toBe("+1 h");
    expect(config.data.labels[23]).toBe("+23 h");
  });

  it("rounds values to 1 decimal and preserves nulls", () => {
    const config = buildWaveModelChartConfig(threeModelTrimmed());
    const gfs = config.data.datasets[1];
    expect(gfs.data[0]).toBe(2.4);
    expect(gfs.data[1]).toBeNull();
  });

  it("omits pointRadius (points hidden via the --point-radius custom property on .wave-model-chart), sets spanGaps false, and distinct non-flag color tokens", () => {
    const config = buildWaveModelChartConfig(threeModelTrimmed());
    const colors = config.data.datasets.map(function (d) { return d.borderColor; });
    expect(colors).toEqual([
      "var(--wa-color-blue-60)",
      "var(--wa-color-purple-60)",
      "var(--wa-color-cyan-60)"
    ]);
    config.data.datasets.forEach(function (d) {
      expect(d).not.toHaveProperty("pointRadius");
      expect(d.spanGaps).toBe(false);
      expect(d.backgroundColor).toBe(d.borderColor);
      // Never a flag semantic color.
      expect(d.borderColor).not.toContain("green");
      expect(d.borderColor).not.toContain("yellow");
      expect(d.borderColor).not.toContain("red");
    });
  });

  it("carries no scales block (the 'ft' y-axis title rides on the element's yLabel attribute) and hides the chart title plugin", () => {
    const config = buildWaveModelChartConfig(threeModelTrimmed());
    expect(config.options.scales).toBeUndefined();
    expect(config.options.plugins.title.display).toBe(false);
  });
});

describe("waveModelSummary", () => {
  it("states each model's current reading in display order", () => {
    const trimmed = {
      totalHours: 24,
      byModel: {
        ecmwf_wam025: constHours(2.63),
        ncep_gfswave025: constHours(2.44),
        meteofrance_wave: constHours(2.9)
      }
    };
    expect(waveModelSummary(trimmed)).toBe(
      "Wave height by model, next 24 hours — ECMWF now 2.6 ft, " +
      "NOAA GFS now 2.4 ft, Météo-France now 2.9 ft.");
  });

  it("marks a model that is null at the now-hour as having no current reading", () => {
    const gfs = constHours(2.44);
    gfs[0] = null;
    const trimmed = {
      totalHours: 12,
      byModel: { ecmwf_wam025: constHours(2.6), ncep_gfswave025: gfs }
    };
    expect(waveModelSummary(trimmed)).toBe(
      "Wave height by model, next 12 hours — ECMWF now 2.6 ft, " +
      "NOAA GFS (no current reading).");
  });

  it("returns '' when no models are present", () => {
    expect(waveModelSummary({ totalHours: 24, byModel: {} })).toBe("");
  });
});

describe("computeWaveRuns", () => {
  it("merges consecutive hours sharing a color band", () => {
    // 3 green (1 ft), 2 yellow (3 ft), 1 red (5 ft)
    const runs = computeWaveRuns([1, 1, 1, 3, 3, 5]);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatchObject({ band: "green", hours: 3, label: "Under 2 ft",
      tokenVar: "var(--wa-color-green-50)" });
    expect(runs[1]).toMatchObject({ band: "yellow", hours: 2, label: "2–4 ft",
      tokenVar: "var(--wa-color-yellow-70)" });
    expect(runs[2]).toMatchObject({ band: "red", hours: 1, label: "4 ft or more",
      tokenVar: "var(--wa-color-red-50)" });
  });

  it("keeps singleton runs distinct when bands alternate", () => {
    const runs = computeWaveRuns([1, 3, 1]);
    expect(runs.map(function (r) { return r.band; })).toEqual(["green", "yellow", "green"]);
    expect(runs.every(function (r) { return r.hours === 1; })).toBe(true);
  });

  it("maps null hours to a no-data (gray) run", () => {
    const runs = computeWaveRuns([null, null, 1]);
    expect(runs[0]).toMatchObject({ band: "no-data", hours: 2, label: "No data",
      tokenVar: "var(--wa-color-gray-50)" });
    expect(runs[1].band).toBe("green");
  });

  it("run hours always sum to the input length", () => {
    const input = [1, 1, 3, null, 5, 5, 5, 2, 2, null];
    const runs = computeWaveRuns(input);
    const sum = runs.reduce(function (acc, r) { return acc + r.hours; }, 0);
    expect(sum).toBe(input.length);
  });

  it("puts boundary values 2.0 in yellow and 4.0 in red, consistent with waveColorForHeight", () => {
    expect(waveColorForHeight(2.0)).toBe("yellow");
    expect(waveColorForHeight(4.0)).toBe("red");
    const runs = computeWaveRuns([2.0, 4.0]);
    expect(runs[0].band).toBe("yellow");
    expect(runs[1].band).toBe("red");
  });
});

describe("waveStripSummary", () => {
  it("builds the exact prose for a multi-run series", () => {
    const runs = [
      { band: "green", label: "Under 2 ft", hours: 5 },
      { band: "yellow", label: "2–4 ft", hours: 3 },
      { band: "no-data", label: "No data", hours: 2 }
    ];
    expect(waveStripSummary(runs)).toBe(
      "Under 2 ft for 5 hours from now, then 2–4 ft for 3 hours, then no data for 2 hours.");
  });

  it("uses the singular 'hour' for a 1-hour run", () => {
    const runs = [
      { band: "green", label: "Under 2 ft", hours: 1 },
      { band: "red", label: "4 ft or more", hours: 1 }
    ];
    expect(waveStripSummary(runs)).toBe(
      "Under 2 ft for 1 hour from now, then 4 ft or more for 1 hour.");
  });

  it("returns an empty string for no runs", () => {
    expect(waveStripSummary([])).toBe("");
  });
});

describe("computeHazardBands", () => {
  const NOW = "2026-07-05T12:00:00.000Z";

  function estimateWithHazards(extra) {
    return Object.assign({
      color: "red",
      reason: "Active NWS alert: Beach Hazards Statement",
      official: false
    }, extra);
  }

  it("positions a flag-relevant alert by its onset/ends, snapped to hours", () => {
    const bands = computeHazardBands(estimateWithHazards({
      alertDetails: [{
        event: "Beach Hazards Statement",
        onset: "2026-07-05T10:00:00.000Z", // before now -> clamps to 0
        ends: "2026-07-06T02:00:00.000Z"   // +14 h
      }]
    }), 24, NOW);
    expect(bands).toHaveLength(1);
    expect(bands[0].kind).toBe("alert");
    expect(bands[0].label).toBe("Beach Hazards Statement");
    expect(bands[0].text).toBe("NWS alert: Beach Hazards Statement — now through +14 h");
    expect(bands[0].leftPct).toBe(0);
    expect(bands[0].widthPct).toBeCloseTo((14 / 24) * 100, 10);
    expect(bands[0].bgVar).toBe("var(--wa-color-danger-fill-quiet)");
    expect(bands[0].fgVar).toBe("var(--wa-color-danger-on-quiet)");
    expect(bands[0].edgeVar).toBe("var(--wa-color-danger-border-loud)");
  });

  it("a future-onset alert starts mid-window and clamps its end to the window", () => {
    const bands = computeHazardBands(estimateWithHazards({
      alertDetails: [{
        event: "High Surf Warning",
        onset: "2026-07-05T18:00:00.000Z", // +6 h
        ends: "2026-07-07T00:00:00.000Z"   // way past the window
      }]
    }), 24, NOW);
    expect(bands).toHaveLength(1);
    expect(bands[0].leftPct).toBe(25);
    expect(bands[0].widthPct).toBe(75);
    expect(bands[0].text).toBe("NWS alert: High Surf Warning — +6 h to +24 h");
  });

  it("missing onset means already active; missing ends means open-ended", () => {
    const bands = computeHazardBands(estimateWithHazards({
      alertDetails: [{ event: "Rip Current Statement", onset: null, ends: null }]
    }), 24, NOW);
    expect(bands).toHaveLength(1);
    expect(bands[0].leftPct).toBe(0);
    expect(bands[0].widthPct).toBe(100);
    expect(bands[0].text).toBe("NWS alert: Rip Current Statement — now through +24 h");
  });

  it("drops alerts fully outside the window and non-precedence events", () => {
    const bands = computeHazardBands(estimateWithHazards({
      alertDetails: [
        { event: "Beach Hazards Statement",
          onset: "2026-07-04T00:00:00.000Z", ends: "2026-07-05T06:00:00.000Z" }, // ended
        { event: "Beach Hazards Statement",
          onset: "2026-07-07T00:00:00.000Z", ends: "2026-07-08T00:00:00.000Z" }, // not yet
        { event: "Tornado Warning", onset: null, ends: null },                    // not flag-relevant
        "garbage", null                                                           // malformed
      ]
    }), 24, NOW);
    expect(bands).toHaveLength(0);
  });

  it("dedupes exact repeats but keeps distinct periods of the same event", () => {
    const detail = { event: "High Surf Advisory",
      onset: "2026-07-05T12:00:00.000Z", ends: "2026-07-05T18:00:00.000Z" };
    const later = { event: "High Surf Advisory",
      onset: "2026-07-06T00:00:00.000Z", ends: "2026-07-06T06:00:00.000Z" };
    const bands = computeHazardBands(estimateWithHazards({
      alertDetails: [detail, detail, later]
    }), 24, NOW);
    expect(bands).toHaveLength(2);
    expect(bands[0].text).toBe("NWS alert: High Surf Advisory — now through +6 h");
    expect(bands[1].text).toBe("NWS alert: High Surf Advisory — +12 h to +18 h");
  });

  it("adds a full-window band for HIGH (red) and MODERATE (yellow) rip risk", () => {
    const high = computeHazardBands(estimateWithHazards({ ripCurrentRisk: "HIGH" }), 24, NOW);
    expect(high).toHaveLength(1);
    expect(high[0].kind).toBe("rip");
    expect(high[0].label).toBe("Rip current risk: HIGH");
    expect(high[0].text).toBe("Rip current risk HIGH — from the latest NWS surf zone forecast");
    expect(high[0].leftPct).toBe(0);
    expect(high[0].widthPct).toBe(100);
    expect(high[0].bgVar).toBe("var(--wa-color-danger-fill-quiet)");

    const moderate = computeHazardBands(estimateWithHazards({ ripCurrentRisk: "MODERATE" }), 24, NOW);
    expect(moderate).toHaveLength(1);
    expect(moderate[0].bgVar).toBe("var(--wa-color-warning-fill-quiet)");
    expect(moderate[0].fgVar).toBe("var(--wa-color-warning-on-quiet)");
  });

  it("LOW/garbage rip risk and legacy estimates yield no bands", () => {
    expect(computeHazardBands(estimateWithHazards({ ripCurrentRisk: "LOW" }), 24, NOW))
      .toHaveLength(0);
    expect(computeHazardBands(estimateWithHazards({ ripCurrentRisk: "extreme" }), 24, NOW))
      .toHaveLength(0);
    // Legacy KV payload without either echo field.
    expect(computeHazardBands(estimateWithHazards({}), 24, NOW)).toHaveLength(0);
  });

  it("degrades to [] on malformed inputs (estimate, window, nowIso)", () => {
    const withAlert = estimateWithHazards({
      alertDetails: [{ event: "Beach Hazards Statement", onset: null, ends: null }]
    });
    expect(computeHazardBands(null, 24, NOW)).toEqual([]);
    expect(computeHazardBands("nope", 24, NOW)).toEqual([]);
    expect(computeHazardBands(withAlert, 0, NOW)).toEqual([]);
    expect(computeHazardBands(withAlert, NaN, NOW)).toEqual([]);
    expect(computeHazardBands(withAlert, 24, "not a date")).toEqual([]);
  });

  it("alert bands come before the rip band and a trimmed window scales positions", () => {
    // 12-hour trimmed window: the +6 h onset sits at 50%.
    const bands = computeHazardBands(estimateWithHazards({
      alertDetails: [{
        event: "High Surf Warning",
        onset: "2026-07-05T18:00:00.000Z",
        ends: null
      }],
      ripCurrentRisk: "MODERATE"
    }), 12, NOW);
    expect(bands).toHaveLength(2);
    expect(bands[0].kind).toBe("alert");
    expect(bands[0].leftPct).toBe(50);
    expect(bands[0].widthPct).toBe(50);
    expect(bands[0].text).toBe("NWS alert: High Surf Warning — +6 h to +12 h");
    expect(bands[1].kind).toBe("rip");
  });
});
