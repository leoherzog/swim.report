// src/clients/glerl.js
// Great Lakes wave-height gap-filler. Open-Meteo's wave models frequently
// return null (masked grid cells) on the Great Lakes; this client fills the
// gap from real buoy observations served by the GLOS Seagull REST API
// (https://seagull.glos.org/ — unauthenticated JSON, 10-minute cadence).
//
// NOTE on the name: the true gridded source (NOAA GLCFS via the GLOS/Axiom
// ERDDAP at erddap.axiomdatascience.com) was hard-down (HTTP 502 on every
// probe) when this was built, so the implementation uses NEAREST-BUOY point
// observations instead of grid interpolation. A beach only gets a reading
// when a wave-reporting buoy sits within MAX_PLATFORM_DISTANCE_KM; beyond
// that we return null so a distant buoy is never presented as the beach's
// condition (the rules engine then falls through to wind/unknown). Buoys are
// seasonal (many are pulled Nov-Apr), so winter coverage collapsing to null
// is expected behavior, not an error.
//
// Every fetching export is async, takes structured args, and NEVER throws
// across the module boundary: on any error it logs with console.log and
// resolves to null. Pure parse helpers are exported for tests. No Date.now()
// anywhere — all freshness math derives from the nowIso argument.

import { distanceKm, metersToFeet } from "../geo.js";
import { fetchJson as httpFetchJson } from "./http.js";

export const SEAGULL_API_BASE = "https://seagull-api.glos.org/api/v1";
export const SEAGULL_PLATFORMS_URL = SEAGULL_API_BASE + "/obs-datasets.geojson";
export const SEAGULL_PARAMETERS_URL = SEAGULL_API_BASE + "/parameters";
// Human-readable portal for source labels — never link the raw API request.
export const SEAGULL_INFO_URL = "https://seagull.glos.org/";

// Model identifier reported in the { waveHeightFt, model } result entries so
// FlagEstimate sources can name the buoy network (WAVE_MODEL_LABELS in
// src/index.js maps it to a human-readable label).
export const GLCFS_WAVE_MODEL = "glos_seagull_buoy";

export const WAVE_STANDARD_NAME = "sea_surface_wave_significant_height";

// Nearest-buoy is an approximation, not a grid: beyond this distance a buoy
// reading stops being representative of the beach, so the beach gets null
// (rules fall back to wind/unknown) rather than a borrowed color.
export const MAX_PLATFORM_DISTANCE_KM = 25;

// Freshness window for a buoy observation, matching the product-wide 2 h
// stale rule. Older readings are discarded (null), never served as current.
export const MAX_OBS_AGE_MS = 7200000;

// Small tolerance for observation timestamps slightly ahead of nowIso
// (upstream clock skew); anything further in the future is rejected.
const MAX_OBS_FUTURE_MS = 600000;

// Hard cap on per-run buoy fetches, defending the subrequest budget (math in
// fetchGlcfsWaveHeightsFt below) even if the platform catalog balloons.
export const MAX_PLATFORM_FETCHES = 60;

// Politeness: at most this many concurrent requests against the Seagull API.
const OBS_FETCH_CONCURRENCY = 4;

// distanceKm and metersToFeet live in the dependency-free src/geo.js. distanceKm
// is re-exported here because tests and windyWebcams.js import it from this
// module.
export { distanceKm };

// Pure. Seagull /api/v1/parameters catalog (array of { parameter_id,
// standard_name, ... }; parameter_id is globally unique across platforms) ->
// Set of the parameter_ids whose standard_name is significant wave height.
// Malformed input -> empty Set (callers then find no wave data — never a
// wrong reading).
export function parseWaveParameterIds(paramsJson) {
  const ids = new Set();
  if (!Array.isArray(paramsJson)) {
    return ids;
  }
  for (const entry of paramsJson) {
    if (entry && entry.standard_name === WAVE_STANDARD_NAME &&
        typeof entry.parameter_id === "number") {
      ids.add(entry.parameter_id);
    }
  }
  return ids;
}

// Pure. Seagull /api/v1/obs-datasets.geojson FeatureCollection -> array of
// { obsDatasetId, lat, lon } for platforms that report significant wave
// height and have usable Point coordinates. Malformed input -> [].
export function parseWavePlatforms(geojson) {
  const platforms = [];
  if (!geojson || !Array.isArray(geojson.features)) {
    return platforms;
  }
  for (const feature of geojson.features) {
    if (!feature || !feature.properties || !feature.geometry) {
      continue;
    }
    const props = feature.properties;
    if (typeof props.obs_dataset_id !== "number" || !Array.isArray(props.parameters)) {
      continue;
    }
    const hasWave = props.parameters.some(function (p) {
      return p && p.standard_name === WAVE_STANDARD_NAME;
    });
    if (!hasWave) {
      continue;
    }
    const coords = feature.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2 ||
        typeof coords[0] !== "number" || !isFinite(coords[0]) ||
        typeof coords[1] !== "number" || !isFinite(coords[1])) {
      continue;
    }
    platforms.push({ obsDatasetId: props.obs_dataset_id, lat: coords[1], lon: coords[0] });
  }
  return platforms;
}

// Pure. Nearest wave platform within MAX_PLATFORM_DISTANCE_KM of (lat, lon),
// as { obsDatasetId, distanceKm }, or null when none is close enough.
export function nearestWavePlatform(lat, lon, platforms) {
  if (typeof lat !== "number" || !isFinite(lat) ||
      typeof lon !== "number" || !isFinite(lon) || !Array.isArray(platforms)) {
    return null;
  }
  let best = null;
  for (const platform of platforms) {
    const d = distanceKm(lat, lon, platform.lat, platform.lon);
    if (d <= MAX_PLATFORM_DISTANCE_KM && (best === null || d < best.distanceKm)) {
      best = { obsDatasetId: platform.obsDatasetId, distanceKm: d };
    }
  }
  return best;
}

// Pure. UTC calendar date ("YYYY-MM-DD") of nowIso minus the freshness
// window — the startDate for the obs request. Backing up by MAX_OBS_AGE_MS
// keeps the 2 h window fully covered just after 00:00 UTC, when startDate =
// "today" alone would miss late-yesterday observations.
export function obsStartDateUtc(nowIso) {
  const ms = Date.parse(nowIso);
  if (!isFinite(ms)) {
    return null;
  }
  return new Date(ms - MAX_OBS_AGE_MS).toISOString().slice(0, 10);
}

// Pure. Seagull /api/v1/obs response (array of dataset objects, each
// { obs_dataset_id, parameters: [{ parameter_id, observations: [{ timestamp,
// value }, ...] }] }; observations are newest-first but we do not rely on
// ordering) -> significant wave height in FEET for obsDatasetId, or null.
// Null when: dataset missing, no wave parameter, no finite value, or the
// freshest reading is outside the 2 h window relative to nowIso. Stale or
// ambiguous data degrades to null, never to an old number.
export function parseObsWaveHeightFt(obsJson, obsDatasetId, waveParameterIds, nowIso) {
  const nowMs = Date.parse(nowIso);
  if (!Array.isArray(obsJson) || !isFinite(nowMs)) {
    return null;
  }
  const dataset = obsJson.find(function (d) {
    return d && d.obs_dataset_id === obsDatasetId;
  });
  if (!dataset || !Array.isArray(dataset.parameters)) {
    return null;
  }
  let bestMs = null;
  let bestMeters = null;
  for (const param of dataset.parameters) {
    if (!param || !waveParameterIds.has(param.parameter_id) ||
        !Array.isArray(param.observations)) {
      continue;
    }
    for (const obs of param.observations) {
      if (!obs || typeof obs.value !== "number" || !isFinite(obs.value)) {
        continue;
      }
      const obsMs = Date.parse(obs.timestamp);
      if (!isFinite(obsMs)) {
        continue;
      }
      const age = nowMs - obsMs;
      if (age > MAX_OBS_AGE_MS || age < -MAX_OBS_FUTURE_MS) {
        continue;
      }
      if (bestMs === null || obsMs > bestMs) {
        bestMs = obsMs;
        bestMeters = obs.value;
      }
    }
  }
  if (bestMeters === null) {
    return null;
  }
  return metersToFeet(bestMeters);
}

function fetchJson(url, label) {
  return httpFetchJson(url, { label: "glerl: " + label });
}

// Fetch + parse the two large semi-static Seagull catalogs (the ~3.4 MB
// /api/v1/parameters and ~2.1 MB /api/v1/obs-datasets.geojson) into the two
// SMALL derived structures the obs step actually needs:
//   { platforms: [{ obsDatasetId, lat, lon }, ...], waveParameterIds: Set }
// Returns null when EITHER catalog fetch fails (the caller then leaves its
// beaches wave-null). This is a separable step so the 6-hourly wave cron can
// cache the (tiny) derived result in KV and hand it back to
// fetchGlcfsWaveHeightsFt, avoiding the ~5.5 MB re-download on a normal run.
// Env-free: knows nothing about KV — the cron owns caching.
export async function fetchWaveCatalogs() {
  const geojson = await fetchJson(SEAGULL_PLATFORMS_URL, "platform catalog");
  if (geojson === null) {
    return null;
  }
  const platforms = parseWavePlatforms(geojson);

  const paramsJson = await fetchJson(SEAGULL_PARAMETERS_URL, "parameter catalog");
  if (paramsJson === null) {
    return null;
  }
  const waveParameterIds = parseWaveParameterIds(paramsJson);
  return { platforms: platforms, waveParameterIds: waveParameterIds };
}

// Pure. True when c is a usable derived-catalog structure (a platforms array
// plus a waveParameterIds Set). Guards the cached-catalog fast path so a
// missing/garbage value degrades to a fresh fetch instead of throwing.
function isUsableCatalogs(c) {
  return !!c && Array.isArray(c.platforms) && c.waveParameterIds instanceof Set;
}

// Pure. Derived catalogs -> a JSON-safe object for KV. JSON cannot represent a
// Set, so waveParameterIds is written as an array.
export function serializeWaveCatalogs(catalogs) {
  return {
    platforms: catalogs.platforms,
    waveParameterIds: Array.from(catalogs.waveParameterIds)
  };
}

// Pure. Rehydrate a KV payload written by serializeWaveCatalogs back into the
// derived structures (array -> Set). Returns null on any missing/malformed
// field so a corrupt or stale-shaped cache degrades to a fresh fetch rather
// than throwing — the caller passes the null straight into
// fetchGlcfsWaveHeightsFt, which then fetches fresh.
export function deserializeWaveCatalogs(raw) {
  if (!raw || !Array.isArray(raw.platforms) || !Array.isArray(raw.waveParameterIds)) {
    return null;
  }
  return {
    platforms: raw.platforms,
    waveParameterIds: new Set(raw.waveParameterIds)
  };
}

// Result shape (a superset of openMeteo.fetchWaveHeightsFt's, plus catalog
// bookkeeping the cron uses to cache):
//   { results: { beachId -> { waveHeightFt: number|null, model: string|null } },
//     sourceUrl,
//     catalogs: { platforms, waveParameterIds } | null,  // structures used
//     catalogsFetched: boolean }                         // true iff fetched fresh
// Every input beachId appears in results (nulls on miss); null only on total
// failure (invalid nowIso, or a catalog fetch failing on the fresh path).
// Successful readings carry model: GLCFS_WAVE_MODEL.
//
// cachedCatalogs (optional): the derived { platforms, waveParameterIds } the
// cron cached in KV. When usable, both large catalogs are skipped entirely;
// when absent/garbage, they are fetched fresh (fetchWaveCatalogs) and returned
// via catalogs/catalogsFetched so the cron can persist them.
//
// Subrequest budget math (paid plan, 1000/invocation; the hourly cron
// currently uses ~360 — PLAN.md section 7): this function costs AT MOST
// 2 catalog fetches (skipped on a cache hit) plus one obs fetch per UNIQUE
// nearby platform, hard-capped at MAX_PLATFORM_FETCHES = 60, so <= 62
// subrequests worst case (realistically a few dozen platforms cover the
// Michigan pilot beaches). ~360 + 62 = ~422, comfortably under 1000. It is
// called only for beaches Open-Meteo left wave-null, and skips all fetching
// when given no points.
export async function fetchGlcfsWaveHeightsFt(points, nowIso, cachedCatalogs) {
  const results = {};
  for (const point of points) {
    results[point.beachId] = { waveHeightFt: null, model: null };
  }
  if (points.length === 0) {
    return { results: results, sourceUrl: SEAGULL_PLATFORMS_URL, catalogs: null, catalogsFetched: false };
  }

  const startDate = obsStartDateUtc(nowIso);
  if (startDate === null) {
    console.log("glerl: invalid nowIso: " + String(nowIso));
    return null;
  }

  // Catalog step: reuse the cron-cached derived structures when usable,
  // otherwise fetch + parse both catalogs fresh. A missing/garbage cache
  // degrades to a fresh fetch (isUsableCatalogs), never a throw.
  let catalogs = cachedCatalogs;
  let catalogsFetched = false;
  if (!isUsableCatalogs(catalogs)) {
    catalogs = await fetchWaveCatalogs();
    if (catalogs === null) {
      return null;
    }
    catalogsFetched = true;
  }
  const platforms = catalogs.platforms;
  const waveParameterIds = catalogs.waveParameterIds;
  if (platforms.length === 0 || waveParameterIds.size === 0) {
    console.log("glerl: no wave platforms or wave parameters in Seagull catalogs");
    return { results: results, sourceUrl: SEAGULL_PLATFORMS_URL, catalogs: catalogs, catalogsFetched: catalogsFetched };
  }

  // F9: restrict each obs request to the wave parameter ids (comma-separated).
  // Verified live: the server returns only the requested parameters (~9x
  // smaller payload) and parseObsWaveHeightFt already filters to these same
  // ids, so behavior is unchanged. Sorted for a deterministic URL.
  const parameterIdQuery = Array.from(waveParameterIds)
    .sort(function (a, b) { return a - b; })
    .join(",");

  // Beach -> nearest platform, then dedup so each platform is fetched once
  // no matter how many beaches share it.
  const platformForBeach = new Map();
  const uniquePlatformIds = [];
  for (const point of points) {
    const nearest = nearestWavePlatform(point.lat, point.lon, platforms);
    if (nearest !== null) {
      platformForBeach.set(point.beachId, nearest.obsDatasetId);
      if (uniquePlatformIds.indexOf(nearest.obsDatasetId) === -1) {
        uniquePlatformIds.push(nearest.obsDatasetId);
      }
    }
  }
  const toFetch = uniquePlatformIds.slice(0, MAX_PLATFORM_FETCHES);
  if (uniquePlatformIds.length > toFetch.length) {
    console.log(
      "glerl: platform fetch cap hit, skipping " +
      String(uniquePlatformIds.length - toFetch.length) + " platforms"
    );
  }

  // One obs fetch per unique platform, in small concurrent batches (be
  // polite to the free Seagull API). A failed platform fetch only nulls the
  // beaches mapped to that platform.
  const heightByPlatform = new Map();
  for (let i = 0; i < toFetch.length; i = i + OBS_FETCH_CONCURRENCY) {
    const batch = toFetch.slice(i, i + OBS_FETCH_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(function (obsDatasetId) {
      const url = SEAGULL_API_BASE + "/obs?obsDatasetId=" + String(obsDatasetId) +
        "&startDate=" + startDate + "&parameterId=" + parameterIdQuery;
      return fetchJson(url, "obs for platform " + String(obsDatasetId));
    }));
    for (let j = 0; j < batch.length; j = j + 1) {
      const outcome = settled[j];
      if (outcome.status === "fulfilled" && outcome.value !== null) {
        heightByPlatform.set(
          batch[j],
          parseObsWaveHeightFt(outcome.value, batch[j], waveParameterIds, nowIso)
        );
      } else {
        heightByPlatform.set(batch[j], null);
      }
    }
  }

  for (const point of points) {
    const obsDatasetId = platformForBeach.get(point.beachId);
    if (obsDatasetId === undefined) {
      continue;
    }
    const waveHeightFt = heightByPlatform.get(obsDatasetId);
    if (typeof waveHeightFt === "number") {
      results[point.beachId] = { waveHeightFt: waveHeightFt, model: GLCFS_WAVE_MODEL };
    }
  }
  return { results: results, sourceUrl: SEAGULL_PLATFORMS_URL, catalogs: catalogs, catalogsFetched: catalogsFetched };
}
