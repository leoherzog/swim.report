// test/glerl.test.js
// Fixtures are trimmed from real Seagull API responses captured 2026-07-06
// (South Haven buoy, obs_dataset_id 37, wave parameter_id 195, Hs 0.476 m).
// No network access — fetchGlcfsWaveHeightsFt runs against a stubbed
// globalThis.fetch.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchGlcfsWaveHeightsFt,
  fetchWaveCatalogs,
  serializeWaveCatalogs,
  deserializeWaveCatalogs,
  parseWaveParameterIds,
  parseWavePlatforms,
  nearestWavePlatform,
  obsStartDateUtc,
  parseObsWaveHeightFt,
  distanceKm,
  GLCFS_WAVE_MODEL,
  MAX_PLATFORM_DISTANCE_KM,
  SEAGULL_PLATFORMS_URL,
  SEAGULL_PARAMETERS_URL
} from "../src/clients/glerl.js";
import { installFetch, jsonResponse } from "./helpers/fetch.js";

const NOW = "2026-07-06T02:25:00.000Z";
const WAVE_NAME = "sea_surface_wave_significant_height";
// 0.476 m * 3.28084 ft/m
const SOUTH_HAVEN_FT = 0.476 * 3.28084;

// Trimmed /api/v1/parameters catalog: two wave parameters on different
// platforms (parameter_id is per-platform), one non-wave parameter, and two
// malformed entries that must be ignored.
const PARAMS_FIXTURE = [
  { parameter_id: 195, parameter_name: WAVE_NAME, standard_name: WAVE_NAME, platform_id: 25 },
  { parameter_id: 610, parameter_name: WAVE_NAME, standard_name: WAVE_NAME, platform_id: 41 },
  { parameter_id: 191, parameter_name: "wind_speed", standard_name: "wind_speed", platform_id: 25 },
  { parameter_id: "195", standard_name: WAVE_NAME },
  null
];

// Trimmed /api/v1/obs-datasets.geojson: South Haven buoy (37, wave), a second
// wave buoy (62, Ludington), a non-wave platform, and malformed features.
const PLATFORMS_FIXTURE = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-86.331, 42.397] },
      properties: {
        obs_dataset_id: 37,
        platform_name: "South Haven buoy",
        parameters: [
          { standard_name: "sea_water_temperature" },
          { standard_name: WAVE_NAME }
        ]
      }
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-86.56, 43.98] },
      properties: {
        obs_dataset_id: 62,
        platform_name: "Ludington buoy",
        parameters: [{ standard_name: WAVE_NAME }]
      }
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-83.1, 42.3] },
      properties: {
        obs_dataset_id: 99,
        platform_name: "Temperature-only station",
        parameters: [{ standard_name: "sea_water_temperature" }]
      }
    },
    {
      type: "Feature",
      geometry: null,
      properties: { obs_dataset_id: 100, parameters: [{ standard_name: WAVE_NAME }] }
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: ["-86.3", 42.4] },
      properties: { obs_dataset_id: 101, parameters: [{ standard_name: WAVE_NAME }] }
    }
  ]
};

// Trimmed /api/v1/obs?obsDatasetId=37 response: newest-first observations,
// wave parameter 195 plus a non-wave parameter that must be ignored.
const OBS_37_FIXTURE = [
  {
    obs_dataset_id: 37,
    parameters: [
      {
        parameter_id: 191,
        observations: [
          { latitude: 42.397, longitude: -86.331, timestamp: "2026-07-06T02:20:00+00:00", value: 6.762 }
        ]
      },
      {
        parameter_id: 195,
        observations: [
          { latitude: 42.397, longitude: -86.331, timestamp: "2026-07-06T02:20:00+00:00", value: 0.476 },
          { latitude: 42.397, longitude: -86.331, timestamp: "2026-07-06T02:10:00+00:00", value: 0.5 },
          { latitude: 42.397, longitude: -86.331, timestamp: "2026-07-06T02:00:00+00:00", value: 0.49 }
        ]
      }
    ]
  }
];

const WAVE_IDS = new Set([195, 610]);

describe("parseWaveParameterIds", function () {
  it("collects the parameter_ids whose standard_name is significant wave height", function () {
    const ids = parseWaveParameterIds(PARAMS_FIXTURE);
    expect(Array.from(ids).sort()).toEqual([195, 610]);
  });

  it("returns an empty Set on malformed input", function () {
    expect(parseWaveParameterIds(null).size).toBe(0);
    expect(parseWaveParameterIds({}).size).toBe(0);
    expect(parseWaveParameterIds("nope").size).toBe(0);
  });
});

describe("parseWavePlatforms", function () {
  it("keeps only wave-reporting platforms with usable Point coordinates", function () {
    const platforms = parseWavePlatforms(PLATFORMS_FIXTURE);
    expect(platforms).toEqual([
      { obsDatasetId: 37, lat: 42.397, lon: -86.331 },
      { obsDatasetId: 62, lat: 43.98, lon: -86.56 }
    ]);
  });

  it("returns [] on malformed input", function () {
    expect(parseWavePlatforms(null)).toEqual([]);
    expect(parseWavePlatforms({})).toEqual([]);
    expect(parseWavePlatforms({ features: "nope" })).toEqual([]);
  });
});

describe("nearestWavePlatform", function () {
  const platforms = parseWavePlatforms(PLATFORMS_FIXTURE);

  it("picks the nearest platform within the distance cap", function () {
    // South Haven beach target (~3.5 km from buoy 37).
    const nearest = nearestWavePlatform(42.4, -86.29, platforms);
    expect(nearest.obsDatasetId).toBe(37);
    expect(nearest.distanceKm).toBeLessThan(MAX_PLATFORM_DISTANCE_KM);
  });

  it("returns null when every platform is beyond the cap", function () {
    // Inland point ~100+ km from both buoys — a distant buoy must never be
    // presented as the beach's condition.
    expect(nearestWavePlatform(44.9, -84.5, platforms)).toBe(null);
  });

  it("returns null on invalid coordinates or platform list", function () {
    expect(nearestWavePlatform(NaN, -86.29, platforms)).toBe(null);
    expect(nearestWavePlatform(42.4, null, platforms)).toBe(null);
    expect(nearestWavePlatform(42.4, -86.29, null)).toBe(null);
  });
});

describe("distanceKm", function () {
  it("measures the South Haven beach-to-buoy hop at a few km", function () {
    const d = distanceKm(42.4, -86.29, 42.397, -86.331);
    expect(d).toBeGreaterThan(3);
    expect(d).toBeLessThan(4);
  });
});

describe("obsStartDateUtc", function () {
  it("returns the UTC date of nowIso minus the freshness window", function () {
    expect(obsStartDateUtc("2026-07-06T12:00:00.000Z")).toBe("2026-07-06");
  });

  it("backs into the previous UTC day just after midnight", function () {
    expect(obsStartDateUtc("2026-07-06T01:00:00.000Z")).toBe("2026-07-05");
  });

  it("returns null on unparseable input", function () {
    expect(obsStartDateUtc("garbage")).toBe(null);
    expect(obsStartDateUtc(null)).toBe(null);
  });
});

describe("parseObsWaveHeightFt", function () {
  it("returns the freshest wave reading converted meters -> feet", function () {
    const ft = parseObsWaveHeightFt(OBS_37_FIXTURE, 37, WAVE_IDS, NOW);
    expect(ft).toBeCloseTo(SOUTH_HAVEN_FT, 4);
  });

  it("picks the newest observation even when the array is oldest-first", function () {
    const fixture = [
      {
        obs_dataset_id: 37,
        parameters: [
          {
            parameter_id: 195,
            observations: [
              { timestamp: "2026-07-06T02:00:00+00:00", value: 0.9 },
              { timestamp: "2026-07-06T02:20:00+00:00", value: 0.476 }
            ]
          }
        ]
      }
    ];
    expect(parseObsWaveHeightFt(fixture, 37, WAVE_IDS, NOW)).toBeCloseTo(SOUTH_HAVEN_FT, 4);
  });

  it("skips null and non-finite values and falls back to the next newest valid one", function () {
    const fixture = [
      {
        obs_dataset_id: 37,
        parameters: [
          {
            parameter_id: 195,
            observations: [
              { timestamp: "2026-07-06T02:20:00+00:00", value: null },
              { timestamp: "2026-07-06T02:10:00+00:00", value: "0.5" },
              { timestamp: "2026-07-06T02:00:00+00:00", value: 0.3 }
            ]
          }
        ]
      }
    ];
    expect(parseObsWaveHeightFt(fixture, 37, WAVE_IDS, NOW)).toBeCloseTo(0.3 * 3.28084, 4);
  });

  it("returns null when every reading is older than the 2 h freshness window", function () {
    const fixture = [
      {
        obs_dataset_id: 37,
        parameters: [
          {
            parameter_id: 195,
            observations: [
              { timestamp: "2026-07-06T00:20:00+00:00", value: 0.476 },
              { timestamp: "2026-07-05T22:00:00+00:00", value: 0.5 }
            ]
          }
        ]
      }
    ];
    expect(parseObsWaveHeightFt(fixture, 37, WAVE_IDS, NOW)).toBe(null);
  });

  it("rejects readings too far in the future", function () {
    const fixture = [
      {
        obs_dataset_id: 37,
        parameters: [
          {
            parameter_id: 195,
            observations: [{ timestamp: "2026-07-06T03:00:00+00:00", value: 0.476 }]
          }
        ]
      }
    ];
    expect(parseObsWaveHeightFt(fixture, 37, WAVE_IDS, NOW)).toBe(null);
  });

  it("returns null when the dataset or wave parameter is missing", function () {
    expect(parseObsWaveHeightFt(OBS_37_FIXTURE, 62, WAVE_IDS, NOW)).toBe(null);
    expect(parseObsWaveHeightFt(OBS_37_FIXTURE, 37, new Set([999]), NOW)).toBe(null);
  });

  it("returns null on malformed input or bad nowIso", function () {
    expect(parseObsWaveHeightFt(null, 37, WAVE_IDS, NOW)).toBe(null);
    expect(parseObsWaveHeightFt({}, 37, WAVE_IDS, NOW)).toBe(null);
    expect(parseObsWaveHeightFt([{ obs_dataset_id: 37, parameters: "nope" }], 37, WAVE_IDS, NOW)).toBe(null);
    expect(parseObsWaveHeightFt(OBS_37_FIXTURE, 37, WAVE_IDS, "garbage")).toBe(null);
  });
});

describe("fetchGlcfsWaveHeightsFt", function () {
  function defaultHandler(url) {
    if (url === SEAGULL_PLATFORMS_URL) {
      return Promise.resolve(jsonResponse(PLATFORMS_FIXTURE));
    }
    if (url === SEAGULL_PARAMETERS_URL) {
      return Promise.resolve(jsonResponse(PARAMS_FIXTURE));
    }
    if (url.indexOf("obsDatasetId=37") !== -1) {
      return Promise.resolve(jsonResponse(OBS_37_FIXTURE));
    }
    return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.resolve(null); } });
  }

  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("fills nearby beaches, nulls distant ones, and dedups platform fetches", async function () {
    const calls = installFetch(defaultHandler);
    const points = [
      { beachId: "beach-near", lat: 42.4, lon: -86.29 },
      { beachId: "beach-near-2", lat: 42.39, lon: -86.3 },
      { beachId: "beach-far", lat: 44.9, lon: -84.5 }
    ];
    const out = await fetchGlcfsWaveHeightsFt(points, NOW);
    expect(out).not.toBe(null);
    expect(out.results["beach-near"].waveHeightFt).toBeCloseTo(SOUTH_HAVEN_FT, 4);
    expect(out.results["beach-near"].model).toBe(GLCFS_WAVE_MODEL);
    expect(out.results["beach-near-2"].waveHeightFt).toBeCloseTo(SOUTH_HAVEN_FT, 4);
    expect(out.results["beach-far"]).toEqual({ waveHeightFt: null, model: null });
    expect(typeof out.sourceUrl).toBe("string");
    // Two beaches share buoy 37 — its obs endpoint is fetched exactly once,
    // and startDate is derived from nowIso (no Date.now()).
    const obsUrls = calls.map(function (c) { return c.url; }).filter(function (u) { return u.indexOf("/obs?") !== -1; });
    expect(obsUrls.length).toBe(1);
    expect(obsUrls[0].indexOf("obsDatasetId=37")).not.toBe(-1);
    expect(obsUrls[0].indexOf("startDate=2026-07-06")).not.toBe(-1);
    // F9: obs is filtered to the wave parameter ids (sorted, comma-separated),
    // shrinking the payload ~9x. Parser already filters to the same ids.
    expect(obsUrls[0].indexOf("parameterId=195,610")).not.toBe(-1);
  });

  it("makes no fetches and returns empty results for empty points", async function () {
    const calls = installFetch(defaultHandler);
    const out = await fetchGlcfsWaveHeightsFt([], NOW);
    expect(out.results).toEqual({});
    expect(calls.length).toBe(0);
  });

  it("returns null when the platform catalog fetch fails", async function () {
    installFetch(function () {
      return Promise.resolve({ ok: false, status: 502, json: function () { return Promise.resolve(null); } });
    });
    expect(await fetchGlcfsWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW)).toBe(null);
  });

  it("returns null when the parameter catalog fetch throws", async function () {
    installFetch(function (url) {
      if (url === SEAGULL_PLATFORMS_URL) {
        return Promise.resolve(jsonResponse(PLATFORMS_FIXTURE));
      }
      return Promise.reject(new Error("network down"));
    });
    expect(await fetchGlcfsWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], NOW)).toBe(null);
  });

  it("returns null on an unparseable nowIso", async function () {
    const calls = installFetch(defaultHandler);
    expect(await fetchGlcfsWaveHeightsFt([{ beachId: "b1", lat: 42.4, lon: -86.29 }], "garbage")).toBe(null);
    expect(calls.length).toBe(0);
  });

  it("nulls only the beaches whose platform obs fetch failed", async function () {
    installFetch(function (url) {
      if (url === SEAGULL_PLATFORMS_URL) {
        return Promise.resolve(jsonResponse(PLATFORMS_FIXTURE));
      }
      if (url === SEAGULL_PARAMETERS_URL) {
        return Promise.resolve(jsonResponse(PARAMS_FIXTURE));
      }
      if (url.indexOf("obsDatasetId=37") !== -1) {
        return Promise.resolve(jsonResponse(OBS_37_FIXTURE));
      }
      // Buoy 62 is down.
      return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve(null); } });
    });
    const points = [
      { beachId: "beach-near", lat: 42.4, lon: -86.29 },
      { beachId: "beach-ludington", lat: 44.03, lon: -86.51 }
    ];
    const out = await fetchGlcfsWaveHeightsFt(points, NOW);
    expect(out).not.toBe(null);
    expect(out.results["beach-near"].waveHeightFt).toBeCloseTo(SOUTH_HAVEN_FT, 4);
    expect(out.results["beach-ludington"]).toEqual({ waveHeightFt: null, model: null });
  });

  it("returns the derived catalogs it fetched so the cron can cache them", async function () {
    installFetch(defaultHandler);
    const out = await fetchGlcfsWaveHeightsFt(
      [{ beachId: "beach-near", lat: 42.4, lon: -86.29 }],
      NOW
    );
    expect(out.catalogsFetched).toBe(true);
    expect(out.catalogs.waveParameterIds instanceof Set).toBe(true);
    expect(Array.from(out.catalogs.waveParameterIds).sort()).toEqual([195, 610]);
    expect(out.catalogs.platforms).toEqual([
      { obsDatasetId: 37, lat: 42.397, lon: -86.331 },
      { obsDatasetId: 62, lat: 43.98, lon: -86.56 }
    ]);
  });

  it("reuses passed-in cached catalogs and fetches NEITHER large catalog", async function () {
    const calls = installFetch(defaultHandler);
    const cached = {
      platforms: [{ obsDatasetId: 37, lat: 42.397, lon: -86.331 }],
      waveParameterIds: new Set([195, 610])
    };
    const out = await fetchGlcfsWaveHeightsFt(
      [{ beachId: "beach-near", lat: 42.4, lon: -86.29 }],
      NOW,
      cached
    );
    expect(out.catalogsFetched).toBe(false);
    expect(out.results["beach-near"].waveHeightFt).toBeCloseTo(SOUTH_HAVEN_FT, 4);
    const urls = calls.map(function (c) { return c.url; });
    // Neither semi-static catalog is re-downloaded on a cache hit.
    expect(urls.indexOf(SEAGULL_PLATFORMS_URL)).toBe(-1);
    expect(urls.indexOf(SEAGULL_PARAMETERS_URL)).toBe(-1);
    // The obs request still fires, still parameter-filtered.
    const obsUrls = urls.filter(function (u) { return u.indexOf("/obs?") !== -1; });
    expect(obsUrls.length).toBe(1);
    expect(obsUrls[0].indexOf("parameterId=195,610")).not.toBe(-1);
  });

  it("degrades to a fresh fetch when the cached catalogs are unusable", async function () {
    const calls = installFetch(defaultHandler);
    // Garbage shape (waveParameterIds is not a Set) must not throw — the client
    // ignores it and fetches both catalogs fresh.
    const out = await fetchGlcfsWaveHeightsFt(
      [{ beachId: "beach-near", lat: 42.4, lon: -86.29 }],
      NOW,
      { platforms: "nope", waveParameterIds: [195] }
    );
    expect(out.catalogsFetched).toBe(true);
    expect(out.results["beach-near"].waveHeightFt).toBeCloseTo(SOUTH_HAVEN_FT, 4);
    const urls = calls.map(function (c) { return c.url; });
    expect(urls.indexOf(SEAGULL_PLATFORMS_URL)).not.toBe(-1);
    expect(urls.indexOf(SEAGULL_PARAMETERS_URL)).not.toBe(-1);
  });
});

describe("fetchWaveCatalogs", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("fetches both catalogs and returns the derived structures", async function () {
    installFetch(function (url) {
      if (url === SEAGULL_PLATFORMS_URL) {
        return Promise.resolve(jsonResponse(PLATFORMS_FIXTURE));
      }
      if (url === SEAGULL_PARAMETERS_URL) {
        return Promise.resolve(jsonResponse(PARAMS_FIXTURE));
      }
      return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.resolve(null); } });
    });
    const catalogs = await fetchWaveCatalogs();
    expect(catalogs.waveParameterIds instanceof Set).toBe(true);
    expect(Array.from(catalogs.waveParameterIds).sort()).toEqual([195, 610]);
    expect(catalogs.platforms).toEqual([
      { obsDatasetId: 37, lat: 42.397, lon: -86.331 },
      { obsDatasetId: 62, lat: 43.98, lon: -86.56 }
    ]);
  });

  it("returns null when a catalog fetch fails", async function () {
    installFetch(function (url) {
      if (url === SEAGULL_PLATFORMS_URL) {
        return Promise.resolve(jsonResponse(PLATFORMS_FIXTURE));
      }
      return Promise.resolve({ ok: false, status: 502, json: function () { return Promise.resolve(null); } });
    });
    expect(await fetchWaveCatalogs()).toBe(null);
  });
});

describe("serializeWaveCatalogs / deserializeWaveCatalogs", function () {
  it("round-trips the derived structures through a JSON-safe form (Set <-> array)", function () {
    const catalogs = {
      platforms: [{ obsDatasetId: 37, lat: 42.397, lon: -86.331 }],
      waveParameterIds: new Set([195, 610])
    };
    const serialized = serializeWaveCatalogs(catalogs);
    // JSON cannot hold a Set — it must be an array on the wire.
    expect(Array.isArray(serialized.waveParameterIds)).toBe(true);
    const round = deserializeWaveCatalogs(JSON.parse(JSON.stringify(serialized)));
    expect(round.waveParameterIds instanceof Set).toBe(true);
    expect(Array.from(round.waveParameterIds).sort()).toEqual([195, 610]);
    expect(round.platforms).toEqual(catalogs.platforms);
  });

  it("deserializes a missing/corrupt payload to null (so the caller fetches fresh)", function () {
    expect(deserializeWaveCatalogs(null)).toBe(null);
    expect(deserializeWaveCatalogs({})).toBe(null);
    expect(deserializeWaveCatalogs({ platforms: [], waveParameterIds: "nope" })).toBe(null);
    expect(deserializeWaveCatalogs({ waveParameterIds: [195] })).toBe(null);
  });
});
