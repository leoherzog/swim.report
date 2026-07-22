// test/waveSources.test.js
// Unit tests for the supplemental fallback wave-source registry
// (src/waveSources/index.js). The registry ships POPULATED (see the accurate
// note below), so these lock the resolver contract every source targets, not
// any single source. The behavior tests temporarily empty the exported array,
// push stubbed sources onto it, and restore the real contents afterward, so
// ordering / isolation / run-scoped dedup can be proven deterministically.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { waveSources, SUPPLEMENTAL_WAVE_SOURCES, resolveSupplementalWaveFt } from "../src/waveSources/index.js";
import { makeBeach } from "./helpers/beach.js";

// The registry now ships POPULATED (real supplemental sources are registered).
// The behavior tests below need a controlled array, so they push stub sources
// onto a temporarily-emptied registry and restore the real contents afterward.
// Snapshot the real registry once at load so restore is exact.
const ORIGINAL_SOURCES = waveSources.slice();

describe("waveSources registry", function() {
  it("ships a populated registry of contract-shaped sources", function() {
    expect(Array.isArray(waveSources)).toBe(true);
    expect(waveSources.length).toBeGreaterThan(0);
    waveSources.forEach(function(s) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.model).toBe("string");
      expect(typeof s.label).toBe("string");
      expect(typeof s.url).toBe("string");
      expect(typeof s.matches).toBe("function");
      expect(typeof s.waveFt).toBe("function");
    });
  });

  it("aliases SUPPLEMENTAL_WAVE_SOURCES to the same array", function() {
    expect(SUPPLEMENTAL_WAVE_SOURCES).toBe(waveSources);
  });
});

describe("resolveSupplementalWaveFt behavior", function() {
  // Isolate each behavior test on an empty registry so a pushed stub is the
  // sole/first match, then restore the real sources so no state leaks.
  beforeEach(function() {
    waveSources.length = 0;
  });
  afterEach(function() {
    waveSources.length = 0;
    for (let i = 0; i < ORIGINAL_SOURCES.length; i++) {
      waveSources.push(ORIGINAL_SOURCES[i]);
    }
  });

  it("returns null with an empty registry", async function() {
    const result = await resolveSupplementalWaveFt(makeBeach({}), "2026-07-22T12:00:00.000Z", {});
    expect(result).toBe(null);
  });

  it("returns the first matching source's finite ft WITH provenance", async function() {
    waveSources.push({
      id: "fake-gridpoint",
      model: "fake_wave_model",
      label: "Fake Wave Forecast",
      url: "https://example.gov/waves",
      matches: function(beach) { return beach.nws_grid_url !== null; },
      waveFt: function() { return Promise.resolve(3.2); }
    });
    const beach = makeBeach({ nws_grid_url: "https://api.weather.gov/gridpoints/GRR/33,33" });
    const result = await resolveSupplementalWaveFt(beach, "2026-07-22T12:00:00.000Z", {});
    expect(result).toEqual({
      waveHeightFt: 3.2,
      model: "fake_wave_model",
      label: "Fake Wave Forecast",
      url: "https://example.gov/waves"
    });
  });

  it("skips a non-matching source and falls through to null", async function() {
    waveSources.push({
      id: "needs-grid",
      model: "m",
      label: "L",
      url: "u",
      matches: function(beach) { return beach.nws_grid_url !== null; },
      waveFt: function() { return Promise.resolve(5.0); }
    });
    const beach = makeBeach({ nws_grid_url: null });
    expect(await resolveSupplementalWaveFt(beach, "x", {})).toBe(null);
  });

  it("tries sources in order and returns the FIRST finite hit (never additive)", async function() {
    let secondCalled = false;
    waveSources.push({
      id: "first", model: "m1", label: "L1", url: "u1",
      matches: function() { return true; },
      waveFt: function() { return Promise.resolve(2.5); }
    });
    waveSources.push({
      id: "second", model: "m2", label: "L2", url: "u2",
      matches: function() { return true; },
      waveFt: function() { secondCalled = true; return Promise.resolve(9.9); }
    });
    const result = await resolveSupplementalWaveFt(makeBeach({}), "x", {});
    expect(result.waveHeightFt).toBe(2.5);
    expect(result.model).toBe("m1");
    expect(secondCalled).toBe(false);
  });

  it("falls through when a source returns null and uses the next finite one", async function() {
    waveSources.push({
      id: "null-source", model: "m1", label: "L1", url: "u1",
      matches: function() { return true; },
      waveFt: function() { return Promise.resolve(null); }
    });
    waveSources.push({
      id: "good-source", model: "m2", label: "L2", url: "u2",
      matches: function() { return true; },
      waveFt: function() { return Promise.resolve(4.1); }
    });
    const result = await resolveSupplementalWaveFt(makeBeach({}), "x", {});
    expect(result.waveHeightFt).toBe(4.1);
    expect(result.model).toBe("m2");
  });

  it("isolates a throwing waveFt and continues (never throws across the boundary)", async function() {
    waveSources.push({
      id: "thrower", model: "m1", label: "L1", url: "u1",
      matches: function() { return true; },
      waveFt: function() { throw new Error("upstream schema change"); }
    });
    waveSources.push({
      id: "recover", model: "m2", label: "L2", url: "u2",
      matches: function() { return true; },
      waveFt: function() { return Promise.resolve(1.8); }
    });
    const result = await resolveSupplementalWaveFt(makeBeach({}), "x", {});
    expect(result.waveHeightFt).toBe(1.8);
    expect(result.model).toBe("m2");
  });

  it("rejects a non-finite ft (NaN/Infinity) and returns null", async function() {
    waveSources.push({
      id: "nan-source", model: "m1", label: "L1", url: "u1",
      matches: function() { return true; },
      waveFt: function() { return Promise.resolve(NaN); }
    });
    expect(await resolveSupplementalWaveFt(makeBeach({}), "x", {})).toBe(null);
  });
});

describe("resolveSupplementalWaveFt run-scoped dedup (memo)", function() {
  // Same empty-registry isolation as the behavior block, so a pushed stub is
  // the sole source under test and the shared memo is exercised deterministically.
  beforeEach(function() {
    waveSources.length = 0;
  });
  afterEach(function() {
    waveSources.length = 0;
    for (let i = 0; i < ORIGINAL_SOURCES.length; i++) {
      waveSources.push(ORIGINAL_SOURCES[i]);
    }
  });

  it("fetches ONCE per shared keyOf and fans the ft to every sharing beach", async function() {
    let fetches = 0;
    waveSources.push({
      id: "grid", model: "m1", label: "L1", url: "u1",
      matches: function(beach) { return typeof beach.nws_grid_url === "string"; },
      keyOf: function(beach) { return beach.nws_grid_url; },
      waveFt: function() { fetches = fetches + 1; return Promise.resolve(3.3); }
    });
    const memo = new Map();
    const url = "https://api.weather.gov/gridpoints/GRR/33,33";
    const results = [];
    // 5 beaches share ONE gridpoint URL -> exactly one upstream fetch.
    for (let i = 0; i < 5; i++) {
      const beach = makeBeach({ id: i + 1, nws_grid_url: url });
      results.push(await resolveSupplementalWaveFt(beach, "2026-01-15T12:00:00.000Z", {}, memo));
    }
    expect(fetches).toBe(1);
    results.forEach(function(r) {
      expect(r.waveHeightFt).toBe(3.3);
      expect(r.model).toBe("m1");
    });
  });

  it("fetches once PER DISTINCT key (two cells -> two fetches)", async function() {
    const seen = [];
    waveSources.push({
      id: "grid", model: "m1", label: "L1", url: "u1",
      matches: function(beach) { return typeof beach.nws_grid_url === "string"; },
      keyOf: function(beach) { return beach.nws_grid_url; },
      waveFt: function(beach) { seen.push(beach.nws_grid_url); return Promise.resolve(2.0); }
    });
    const memo = new Map();
    const a = "https://api.weather.gov/gridpoints/GRR/1,1";
    const b = "https://api.weather.gov/gridpoints/DTX/2,2";
    await resolveSupplementalWaveFt(makeBeach({ id: 1, nws_grid_url: a }), "t", {}, memo);
    await resolveSupplementalWaveFt(makeBeach({ id: 2, nws_grid_url: a }), "t", {}, memo);
    await resolveSupplementalWaveFt(makeBeach({ id: 3, nws_grid_url: b }), "t", {}, memo);
    expect(seen.length).toBe(2);
    expect(seen).toEqual([a, b]);
  });

  it("fans a NULL (miss) result too — a shared key that missed is not re-fetched", async function() {
    let fetches = 0;
    waveSources.push({
      id: "grid", model: "m1", label: "L1", url: "u1",
      matches: function(beach) { return typeof beach.nws_grid_url === "string"; },
      keyOf: function(beach) { return beach.nws_grid_url; },
      waveFt: function() { fetches = fetches + 1; return Promise.resolve(null); }
    });
    const memo = new Map();
    const url = "https://api.weather.gov/gridpoints/GRR/9,9";
    const r1 = await resolveSupplementalWaveFt(makeBeach({ id: 1, nws_grid_url: url }), "t", {}, memo);
    const r2 = await resolveSupplementalWaveFt(makeBeach({ id: 2, nws_grid_url: url }), "t", {}, memo);
    expect(r1).toBe(null);
    expect(r2).toBe(null);
    expect(fetches).toBe(1);
  });

  it("does NOT dedup a source without keyOf (per-beach fetch preserved)", async function() {
    let fetches = 0;
    waveSources.push({
      id: "per-beach", model: "m1", label: "L1", url: "u1",
      matches: function() { return true; },
      // no keyOf -> memo skips this source
      waveFt: function() { fetches = fetches + 1; return Promise.resolve(1.5); }
    });
    const memo = new Map();
    await resolveSupplementalWaveFt(makeBeach({ id: 1 }), "t", {}, memo);
    await resolveSupplementalWaveFt(makeBeach({ id: 2 }), "t", {}, memo);
    expect(fetches).toBe(2);
  });

  it("keys the memo by source id, so two sources with the same key value don't collide", async function() {
    let firstFetches = 0;
    let secondFetches = 0;
    // First source misses (null) for the shared key; second source (same key
    // string) must still be consulted and win — the memo namespaces by source id.
    waveSources.push({
      id: "first", model: "m1", label: "L1", url: "u1",
      matches: function() { return true; },
      keyOf: function() { return "shared-key"; },
      waveFt: function() { firstFetches = firstFetches + 1; return Promise.resolve(null); }
    });
    waveSources.push({
      id: "second", model: "m2", label: "L2", url: "u2",
      matches: function() { return true; },
      keyOf: function() { return "shared-key"; },
      waveFt: function() { secondFetches = secondFetches + 1; return Promise.resolve(4.2); }
    });
    const memo = new Map();
    const r = await resolveSupplementalWaveFt(makeBeach({ id: 1 }), "t", {}, memo);
    expect(r.waveHeightFt).toBe(4.2);
    expect(r.model).toBe("m2");
    expect(firstFetches).toBe(1);
    expect(secondFetches).toBe(1);
  });

  it("real registry sources all expose the documented shape (keyOf optional)", function() {
    ORIGINAL_SOURCES.forEach(function(s) {
      if (s.keyOf !== undefined) {
        expect(typeof s.keyOf).toBe("function");
      }
    });
  });
});
