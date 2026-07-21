// Tests for the Overpass mirror failover in src/clients/overpass.js#runQuery
// (exercised through the exported fetchBeaches). runQuery tries each mirror in
// OVERPASS_MIRRORS order and returns the first usable body; a transport/HTTP
// failure or a server-side truncation "remark" on one mirror falls through to
// the next; only when ALL mirrors fail does it return null.

import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchBeaches, fetchParkBeaches, buildQuery, OVERPASS_URL, OVERPASS_MIRRORS } from "../src/clients/overpass.js";
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

describe("Overpass query [maxsize] declarations", function () {
  // A declared [maxsize] below the 512 MiB default improves admission odds
  // during a 504 overload storm (Overpass commons doc: the server admits a
  // request only when it fits within half the remaining available
  // resources). Each builder keeps its existing tuned [timeout:N] unchanged.

  it("buildQuery (named beach query) keeps [timeout:90] and declares 64 MiB", function () {
    const q = buildQuery(BBOX);
    expect(q).toContain("[out:json][timeout:90][maxsize:67108864];");
  });

  it("fetchBeaches sends the named query's maxsize declaration on the wire", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({ elements: [] }));
    });
    await fetchBeaches(BBOX);
    expect(calls[0].init.body.get("data")).toContain("[maxsize:67108864]");
  });

  it("fetchParkBeaches keeps [timeout:180] and sends the park query's 128 MiB maxsize declaration", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({ elements: [] }));
    });
    await fetchParkBeaches(BBOX);
    const sent = calls[0].init.body.get("data");
    expect(sent).toContain("[out:json][timeout:180][maxsize:134217728];");
  });
});

// --- Appended coverage below (do not reorganize the blocks above) ---------

import {
  OVERPASS_NAMED_TIMEOUT_MS,
  OVERPASS_MIRROR_TIMEOUT_MS
} from "../src/clients/overpass.js";

describe("fetchBeaches defensive skips on malformed elements", function () {
  // fetchBeaches must tolerate malformed Overpass output: elements with no
  // name, no usable coordinates, or non-numeric coordinates are silently
  // skipped, never thrown on and never emitted with bad data.
  it("keeps only well-formed named elements with numeric coordinates", async function () {
    installFetch(function () {
      return Promise.resolve(jsonResponse({
        elements: [
          // Unnamed way with a valid center: skipped (no tags.name).
          { type: "way", id: 10, center: { lat: 43, lon: -85 }, tags: {} },
          // Element with no tags object at all: skipped, must not throw.
          { type: "way", id: 14, center: { lat: 43.2, lon: -85.1 } },
          // Named way with neither top-level lat/lon nor a center: skipped.
          { type: "way", id: 11, tags: { name: "No Coords Beach" } },
          // Named way whose center coords are strings, not numbers: skipped.
          { type: "way", id: 12, center: { lat: "43.5", lon: "-85.5" }, tags: { name: "String Center Beach" } },
          // Valid named node: the only survivor.
          { type: "node", id: 13, lat: 44.1, lon: -85.2, tags: { name: "Good Beach" } }
        ]
      }));
    });
    const result = await fetchBeaches(BBOX);
    expect(result).toEqual([
      { osmType: "node", osmId: 13, name: "Good Beach", lat: 44.1, lon: -85.2 }
    ]);
  });
});

describe("fetchParkBeaches wiring (pond drop, park association, output shape)", function () {
  afterEach(function () {
    vi.restoreAllMocks();
  });

  // One Overpass body exercising the full fetchParkBeaches pipeline:
  //   - pond water way (bbox area 1e-6 deg2 < WATER_MIN_AREA_DEG2) at ~42.0
  //   - way/100: UNNAMED beach on that pond -> dropped by the pond filter
  //   - way/101: NAMED beach on the same pond -> kept (filter is unnamed-only)
  //   - way/102: unnamed beach at ~43.0 overlapping TWO parks (no water
  //     nearby, so it is kept) -> smaller-bbox park wins
  //   - way/103: unnamed beach at ~44.0 carrying a loc_name tag -> locality
  const PARK_BODY = {
    elements: [
      {
        type: "way", id: 900, tags: { natural: "water" },
        bounds: { minlat: 42.0, minlon: -86.0, maxlat: 42.001, maxlon: -85.999 }
      },
      {
        type: "way", id: 100, tags: { natural: "beach" },
        bounds: { minlat: 42.0, minlon: -86.0001, maxlat: 42.0002, maxlon: -86.0 }
      },
      {
        type: "way", id: 101, tags: { natural: "beach", name: "Pond Cove Beach" },
        bounds: { minlat: 42.0003, minlon: -85.9999, maxlat: 42.0005, maxlon: -85.9997 }
      },
      {
        type: "way", id: 102, tags: { natural: "beach" },
        bounds: { minlat: 43.0, minlon: -85.0004, maxlat: 43.0004, maxlon: -85.0 }
      },
      {
        type: "way", id: 103, tags: { natural: "beach", loc_name: "Hamlin Lake" },
        bounds: { minlat: 44.0, minlon: -85.5002, maxlat: 44.0002, maxlon: -85.5 }
      },
      {
        type: "way", id: 200, tags: { leisure: "nature_reserve", name: "Big Woods Reserve" },
        bounds: { minlat: 42.9, minlon: -85.1, maxlat: 43.1, maxlon: -84.9 }
      },
      {
        type: "relation", id: 300, tags: { leisure: "park", name: "Little Cove Park" },
        bounds: { minlat: 42.999, minlon: -85.001, maxlat: 43.001, maxlon: -84.999 }
      }
    ]
  };

  it("drops the unnamed pond beach, keeps everything else, and logs the drop", async function () {
    const log = vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function () {
      return Promise.resolve(jsonResponse(PARK_BODY));
    });
    const result = await fetchParkBeaches(BBOX);
    expect(result.map(function (b) { return b.osmId; })).toEqual([101, 102, 103]);
    expect(log).toHaveBeenCalledWith("overpass: park beaches dropped 1 unnamed pond beaches");
  });

  it("keeps the NAMED beach on pond-sized water (pond filter is unnamed-only)", async function () {
    vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function () {
      return Promise.resolve(jsonResponse(PARK_BODY));
    });
    const result = await fetchParkBeaches(BBOX);
    const named = result.find(function (b) { return b.osmId === 101; });
    expect(named.name).toBe("Pond Cove Beach");
    expect(named.locality).toBeNull();
    expect(named.parkName).toBeNull();
    expect(named.parkKey).toBeNull();
    expect(named.lat).toBeCloseTo(42.0004, 8);
    expect(named.lon).toBeCloseTo(-85.9998, 8);
    expect(named.areaDeg2).toBeCloseTo(0.0002 * 0.0002, 12);
  });

  it("attaches the smaller-bbox overlapping park and builds parkKey from its element identity", async function () {
    vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function () {
      return Promise.resolve(jsonResponse(PARK_BODY));
    });
    const result = await fetchParkBeaches(BBOX);
    const parked = result.find(function (b) { return b.osmId === 102; });
    // Both parks overlap way/102; Little Cove Park's bbox (4e-6 deg2) is
    // smaller than Big Woods Reserve's (0.04 deg2), so it wins.
    expect(parked.parkName).toBe("Little Cove Park");
    expect(parked.parkKey).toBe("relation/300");
    expect(parked.name).toBeNull();
  });

  it("passes the beach element's loc_name tag through as locality", async function () {
    vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function () {
      return Promise.resolve(jsonResponse(PARK_BODY));
    });
    const result = await fetchParkBeaches(BBOX);
    const localized = result.find(function (b) { return b.osmId === 103; });
    expect(localized.locality).toBe("Hamlin Lake");
    expect(localized.name).toBeNull();
  });

  it("emits exactly the documented output object shape", async function () {
    vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function () {
      return Promise.resolve(jsonResponse(PARK_BODY));
    });
    const result = await fetchParkBeaches(BBOX);
    for (let i = 0; i < result.length; i++) {
      expect(Object.keys(result[i]).sort()).toEqual([
        "areaDeg2", "lat", "locality", "lon", "name", "osmId", "osmType", "parkKey", "parkName"
      ]);
      expect(result[i].osmType).toBe("way");
      expect(typeof result[i].lat).toBe("number");
      expect(typeof result[i].lon).toBe("number");
      expect(typeof result[i].areaDeg2).toBe("number");
    }
  });
});

describe("per-query transport timeout caps (named 150 s vs default 240 s)", function () {
  afterEach(function () {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Simulates a mirror that hangs forever: the fetch promise settles ONLY
  // when the AbortController signal fires, and each abort is counted so the
  // test can pin down exactly WHEN each query's transport cap cut it.
  function installHangingFetch(abortCounter) {
    installFetch(function (url, init) {
      return new Promise(function (resolve, reject) {
        init.signal.addEventListener("abort", function () {
          abortCounter.count = abortCounter.count + 1;
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
  }

  it("fetchBeaches aborts each hung mirror at OVERPASS_NAMED_TIMEOUT_MS, not the 240 s default", async function () {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(function () {});
    const aborts = { count: 0 };
    installHangingFetch(aborts);
    const pending = fetchBeaches(BBOX);
    // One tick before the named cap: still waiting on the primary mirror.
    await vi.advanceTimersByTimeAsync(OVERPASS_NAMED_TIMEOUT_MS - 1);
    expect(aborts.count).toBe(0);
    // At exactly the named cap the primary aborts and failover starts.
    await vi.advanceTimersByTimeAsync(1);
    expect(aborts.count).toBe(1);
    // The fallback mirror gets the SAME tighter cap.
    await vi.advanceTimersByTimeAsync(OVERPASS_NAMED_TIMEOUT_MS);
    expect(aborts.count).toBe(2);
    expect(await pending).toBeNull();
  });

  it("fetchParkBeaches keeps the OVERPASS_MIRROR_TIMEOUT_MS default: alive at 150 s, aborted at 240 s", async function () {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(function () {});
    const aborts = { count: 0 };
    installHangingFetch(aborts);
    const pending = fetchParkBeaches(BBOX);
    // At the named query's tighter cap the park query has NOT been cut.
    await vi.advanceTimersByTimeAsync(OVERPASS_NAMED_TIMEOUT_MS);
    expect(aborts.count).toBe(0);
    // ...but at the 240 s default the primary aborts.
    await vi.advanceTimersByTimeAsync(OVERPASS_MIRROR_TIMEOUT_MS - OVERPASS_NAMED_TIMEOUT_MS);
    expect(aborts.count).toBe(1);
    // The fallback mirror also runs under the 240 s default.
    await vi.advanceTimersByTimeAsync(OVERPASS_MIRROR_TIMEOUT_MS);
    expect(aborts.count).toBe(2);
    expect(await pending).toBeNull();
  });
});
