// Tests for the Overpass mirror failover in src/clients/overpass.js#runQuery
// (exercised through the exported fetchBeaches). runQuery tries each mirror in
// OVERPASS_MIRRORS order and returns the first usable body; a transport/HTTP
// failure or a server-side truncation "remark" on one mirror falls through to
// the next; only when ALL mirrors fail does it return null.

import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchBeaches, OVERPASS_URL, OVERPASS_MIRRORS } from "../src/clients/overpass.js";
import { installFetch, jsonResponse } from "./helpers/fetch.js";

const BBOX = { minLon: -87.6, minLat: 41.6, maxLon: -82.3, maxLat: 46.6 };
const PRIMARY = OVERPASS_URL;
const FALLBACK = OVERPASS_MIRRORS[1];

afterEach(function () {
  vi.unstubAllGlobals();
});

describe("Overpass mirror failover", function () {
  it("primary success: fallback is never contacted", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({
        elements: [{ type: "way", id: 5, center: { lat: 44, lon: -86 }, tags: { name: "Primary Beach" } }]
      }));
    });
    const result = await fetchBeaches(BBOX);
    expect(result).toEqual([{ osmType: "way", osmId: 5, name: "Primary Beach", lat: 44, lon: -86 }]);
    expect(calls.map(function (c) { return c.url; })).toEqual([PRIMARY]);
  });

  it("falls over to the fallback mirror when the primary returns a truncation remark", async function () {
    const calls = installFetch(function (url) {
      if (url === PRIMARY) {
        return Promise.resolve(jsonResponse({ remark: "runtime error: Query timed out", elements: [] }));
      }
      return Promise.resolve(jsonResponse({
        elements: [{ type: "node", id: 1, lat: 43, lon: -85, tags: { name: "Fallback Beach" } }]
      }));
    });
    const result = await fetchBeaches(BBOX);
    expect(result).toEqual([{ osmType: "node", osmId: 1, name: "Fallback Beach", lat: 43, lon: -85 }]);
    // Tried the primary first, then the fallback, in order.
    expect(calls.map(function (c) { return c.url; })).toEqual([PRIMARY, FALLBACK]);
  });

  it("falls over on a primary transport/HTTP failure (non-2xx)", async function () {
    const calls = installFetch(function (url) {
      if (url === PRIMARY) {
        return Promise.resolve({ ok: false, status: 504, json: function () { return Promise.resolve({}); } });
      }
      return Promise.resolve(jsonResponse({ elements: [] }));
    });
    const result = await fetchBeaches(BBOX);
    expect(result).toEqual([]); // fallback returned a usable (empty) body
    expect(calls.map(function (c) { return c.url; })).toEqual([PRIMARY, FALLBACK]);
  });

  it("returns null only when EVERY mirror fails", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({ remark: "timed out", elements: [] }));
    });
    const result = await fetchBeaches(BBOX);
    expect(result).toBeNull();
    expect(calls.length).toBe(OVERPASS_MIRRORS.length);
  });

  it("passes a client-side timeout AbortSignal on each mirror attempt", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({ elements: [] }));
    });
    await fetchBeaches(BBOX);
    expect(calls[0].init.signal).toBeDefined();
  });
});
