// test/openMeteo.test.js
// Unit tests for fetchWaveHeightsFt's 24-hour forecast series. No network
// access — the client runs against a stubbed globalThis.fetch. nowIso is fixed
// so the hourly index (idx = UTC hour) is deterministic.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchWaveHeightsFt, WAVE_MODEL_ORDER } from "../src/clients/openMeteo.js";

// idx = getUTCHours("...T15:20:00Z") = 15, so hoursFt[0] maps to series[15].
const NOW = "2026-07-12T15:20:00.000Z";
const M_TO_FT = 3.28084;

const ECMWF = "wave_height_ecmwf_wam025";
const GFS = "wave_height_ncep_gfswave025";
const METEOFRANCE = "wave_height_meteofrance_wave";

// Build a 48-entry series filled with fill, overriding specific indices from
// the overrides map.
function series(fill, overrides) {
  const arr = [];
  for (let i = 0; i < 48; i++) {
    arr.push(fill);
  }
  if (overrides) {
    Object.keys(overrides).forEach(function(k) {
      arr[Number(k)] = overrides[k];
    });
  }
  return arr;
}

describe("fetchWaveHeightsFt", function() {
  const realFetch = globalThis.fetch;
  let fetchedUrls;

  function jsonResponse(data) {
    return {
      ok: true,
      json: function() {
        return Promise.resolve(data);
      }
    };
  }

  function installFetch(handler) {
    globalThis.fetch = function(url) {
      fetchedUrls.push(url);
      return handler(url);
    };
  }

  beforeEach(function() {
    fetchedUrls = [];
  });

  afterEach(function() {
    globalThis.fetch = realFetch;
  });

  it("requests forecast_days=2, timezone=UTC, and the three models joined", async function() {
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(1);
      return Promise.resolve(jsonResponse({ hourly: hourly }));
    });
    await fetchWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW);
    const url = fetchedUrls[0];
    expect(url.indexOf("forecast_days=2")).not.toBe(-1);
    expect(url.indexOf("timezone=UTC")).not.toBe(-1);
    expect(url.indexOf("models=" + WAVE_MODEL_ORDER.join(","))).not.toBe(-1);
  });

  it("returns a 24-entry series starting at the UTC hour of nowIso", async function() {
    // Distinctive value at series index 15 (== idx) surfaces as hoursFt[0].
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(1, { 15: 2.5 });
      return Promise.resolve(jsonResponse({ hourly: hourly }));
    });
    const out = await fetchWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW);
    const entry = out.results["b1"];
    expect(entry.hoursFt.length).toBe(24);
    expect(entry.hoursFt[0]).toBeCloseTo(2.5 * M_TO_FT, 10);
    // hoursFt[1] maps to series index 16, which holds the fill value.
    expect(entry.hoursFt[1]).toBeCloseTo(1 * M_TO_FT, 10);
  });

  it("falls back per-hour to the next model in WAVE_MODEL_ORDER", async function() {
    // ecmwf finite at hour 0 (idx 15) but null at hour 5 (idx 20); gfs finite
    // there. meteofrance never contributes.
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(1, { 20: null });
      hourly[GFS] = series(2);
      hourly[METEOFRANCE] = series(9);
      return Promise.resolve(jsonResponse({ hourly: hourly }));
    });
    const out = await fetchWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW);
    const entry = out.results["b1"];
    // Hour 0 from ecmwf, hour 5 from gfs.
    expect(entry.hoursFt[0]).toBeCloseTo(1 * M_TO_FT, 10);
    expect(entry.hoursFt[5]).toBeCloseTo(2 * M_TO_FT, 10);
    expect(entry.models).toEqual(["ecmwf_wam025", "ncep_gfswave025"]);
  });

  it("converts meters -> feet exactly (1 m -> 3.28084 ft)", async function() {
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(1);
      return Promise.resolve(jsonResponse({ hourly: hourly }));
    });
    const out = await fetchWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW);
    expect(out.results["b1"].hoursFt[0]).toBe(3.28084);
  });

  it("keeps waveHeightFt strictly equal to hoursFt[0] and model equal to hour-0 model", async function() {
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(1, { 15: 1.234 });
      return Promise.resolve(jsonResponse({ hourly: hourly }));
    });
    const out = await fetchWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW);
    const entry = out.results["b1"];
    expect(entry.waveHeightFt).toBe(entry.hoursFt[0]);
    expect(entry.model).toBe("ecmwf_wam025");
  });

  it("uses the hour-0 model when the first model is null at hour 0", async function() {
    // ecmwf null at idx 15, gfs finite -> waveHeightFt/model come from gfs.
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(1, { 15: null });
      hourly[GFS] = series(2);
      return Promise.resolve(jsonResponse({ hourly: hourly }));
    });
    const out = await fetchWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW);
    const entry = out.results["b1"];
    expect(entry.model).toBe("ncep_gfswave025");
    expect(entry.waveHeightFt).toBe(entry.hoursFt[0]);
    expect(entry.waveHeightFt).toBeCloseTo(2 * M_TO_FT, 10);
  });

  it("returns all-null entry for an all-null 48-entry series", async function() {
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(null);
      hourly[GFS] = series(null);
      hourly[METEOFRANCE] = series(null);
      return Promise.resolve(jsonResponse({ hourly: hourly }));
    });
    const out = await fetchWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW);
    const entry = out.results["b1"];
    expect(entry.waveHeightFt).toBe(null);
    expect(entry.model).toBe(null);
    expect(entry.models).toEqual([]);
    expect(entry.hoursFt.length).toBe(24);
    expect(entry.hoursFt.every(function(v) { return v === null; })).toBe(true);
  });

  it("treats an all-zero series from every model as no data (masked-cell signature)", async function() {
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(0);
      hourly[GFS] = series(0);
      hourly[METEOFRANCE] = series(0);
      return Promise.resolve(jsonResponse({ hourly: hourly }));
    });
    const out = await fetchWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW);
    const entry = out.results["b1"];
    expect(entry.waveHeightFt).toBe(null);
    expect(entry.model).toBe(null);
    expect(entry.models).toEqual([]);
    expect(entry.byModel).toEqual({});
    expect(entry.hoursFt.every(function(v) { return v === null; })).toBe(true);
  });

  it("drops an all-zero model but keeps the next model's real data", async function() {
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(0);
      hourly[GFS] = series(2);
      return Promise.resolve(jsonResponse({ hourly: hourly }));
    });
    const out = await fetchWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW);
    const entry = out.results["b1"];
    expect(entry.model).toBe("ncep_gfswave025");
    expect(entry.waveHeightFt).toBeCloseTo(2 * M_TO_FT, 10);
    expect(Object.keys(entry.byModel)).toEqual(["ncep_gfswave025"]);
  });

  it("keeps a series with zeros in the window when any finite cell is nonzero (real calm)", async function() {
    // All-zero window (idx 15..38) but a nonzero value late in the raw series
    // -> genuine flat calm, not the masked-cell signature.
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(0, { 40: 0.5 });
      return Promise.resolve(jsonResponse({ hourly: hourly }));
    });
    const out = await fetchWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW);
    const entry = out.results["b1"];
    expect(entry.waveHeightFt).toBe(0);
    expect(entry.model).toBe("ecmwf_wam025");
    expect(entry.models).toEqual(["ecmwf_wam025"]);
  });

  it("normalizes a single-location (non-array) response", async function() {
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(1, { 15: 3 });
      return Promise.resolve(jsonResponse({ hourly: hourly }));
    });
    const out = await fetchWaveHeightsFt([{ beachId: "solo", lat: 42.4, lon: -86.29 }], NOW);
    expect(out.results["solo"].hoursFt[0]).toBeCloseTo(3 * M_TO_FT, 10);
  });

  it("gives a missing location a null entry with 24 null hours and no models", async function() {
    // Two points, one location object returned -> second point is undefined.
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(1, { 15: 2 });
      return Promise.resolve(jsonResponse([{ hourly: hourly }]));
    });
    const points = [
      { beachId: "present", lat: 42.4, lon: -86.29 },
      { beachId: "missing", lat: 43.0, lon: -86.5 }
    ];
    const out = await fetchWaveHeightsFt(points, NOW);
    expect(out.results["present"].hoursFt[0]).toBeCloseTo(2 * M_TO_FT, 10);
    const missing = out.results["missing"];
    expect(missing.waveHeightFt).toBe(null);
    expect(missing.model).toBe(null);
    expect(missing.models).toEqual([]);
    expect(missing.hoursFt.length).toBe(24);
    expect(missing.hoursFt.every(function(v) { return v === null; })).toBe(true);
  });

  it("maps multiple points to their own results by beachId", async function() {
    installFetch(function() {
      const h1 = {};
      h1[ECMWF] = series(1, { 15: 1 });
      const h2 = {};
      h2[GFS] = series(1, { 15: 4 });
      return Promise.resolve(jsonResponse([{ hourly: h1 }, { hourly: h2 }]));
    });
    const points = [
      { beachId: "a", lat: 42.4, lon: -86.29 },
      { beachId: "b", lat: 43.0, lon: -86.5 }
    ];
    const out = await fetchWaveHeightsFt(points, NOW);
    expect(out.results["a"].waveHeightFt).toBeCloseTo(1 * M_TO_FT, 10);
    expect(out.results["a"].model).toBe("ecmwf_wam025");
    expect(out.results["b"].waveHeightFt).toBeCloseTo(4 * M_TO_FT, 10);
    expect(out.results["b"].model).toBe("ncep_gfswave025");
  });

  it("returns per-model 24-entry slices in byModel, aligned with hoursFt", async function() {
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(1, { 15: 2.5, 20: null });
      hourly[GFS] = series(3);
      return Promise.resolve(jsonResponse({ hourly: hourly }));
    });
    const out = await fetchWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW);
    const byModel = out.results["b1"].byModel;
    expect(Object.keys(byModel)).toEqual(["ecmwf_wam025", "ncep_gfswave025"]);
    expect(byModel["ecmwf_wam025"].length).toBe(24);
    expect(byModel["ncep_gfswave025"].length).toBe(24);
    // Slices start at idx 15, same alignment as hoursFt.
    expect(byModel["ecmwf_wam025"][0]).toBeCloseTo(2.5 * M_TO_FT, 10);
    // ecmwf's null at series index 20 is byModel hour 5 — null preserved, NOT
    // filled from another model (per-model series stay pure).
    expect(byModel["ecmwf_wam025"][5]).toBe(null);
    expect(byModel["ncep_gfswave025"][5]).toBeCloseTo(3 * M_TO_FT, 10);
  });

  it("keeps a never-winning model in byModel but not in models (winners only)", async function() {
    // ecmwf finite every hour -> gfs never wins the composite, but it still has
    // data, so it appears in byModel for the model-comparison UI.
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(1);
      hourly[GFS] = series(2);
      return Promise.resolve(jsonResponse({ hourly: hourly }));
    });
    const out = await fetchWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW);
    const entry = out.results["b1"];
    expect(entry.models).toEqual(["ecmwf_wam025"]);
    expect(Object.keys(entry.byModel)).toEqual(["ecmwf_wam025", "ncep_gfswave025"]);
  });

  it("excludes an all-null model from byModel; missing location gets byModel {}", async function() {
    installFetch(function() {
      const hourly = {};
      hourly[ECMWF] = series(1);
      hourly[METEOFRANCE] = series(null);
      return Promise.resolve(jsonResponse([{ hourly: hourly }]));
    });
    const points = [
      { beachId: "present", lat: 42.4, lon: -86.29 },
      { beachId: "missing", lat: 43.0, lon: -86.5 }
    ];
    const out = await fetchWaveHeightsFt(points, NOW);
    expect(Object.keys(out.results["present"].byModel)).toEqual(["ecmwf_wam025"]);
    expect(out.results["missing"].byModel).toEqual({});
  });

  it("returns null on a non-ok HTTP response (never throws)", async function() {
    installFetch(function() {
      return Promise.resolve({ ok: false, status: 503, json: function() { return Promise.resolve(null); } });
    });
    // The call resolving to null rather than rejecting is the never-throws proof.
    const out = await fetchWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW);
    expect(out).toBe(null);
  });

  it("returns null when fetch throws (never throws itself)", async function() {
    installFetch(function() {
      return Promise.reject(new Error("network down"));
    });
    const out = await fetchWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW);
    expect(out).toBe(null);
  });
});
