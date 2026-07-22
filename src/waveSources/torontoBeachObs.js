// src/waveSources/torontoBeachObs.js
//
// KIND: wave — a SUPPLEMENTAL fallback wave-height source (src/waveSources
// registry). It is NOT an official override and NOT a color source: it only
// produces a wave HEIGHT in feet that runWaveRefresh treats exactly like the
// primary Open-Meteo/GLOS reading, feeding the wave-height rule in src/rules.js
// (>=4 ft red, >=2 ft yellow, else green). Consulted ONLY for beaches whose
// primary wave height came back null, in registry order, first finite hit wins
// (never additive, never double-counted).
//
// SOURCE: City of Toronto "Toronto Beaches Observations" open dataset via CKAN
// datastore_search (no auth JSON):
//   https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/datastore_search
//     ?resource_id=b1b87de1-e021-43c2-a80e-69028fe9fafa
// Each record is a once-daily staff observation of a single Lake Ontario beach:
//   { _id, dataCollectionDate: "YYYY-MM-DD", beachName, waveAction, windSpeed,
//     windDirection, airTemp, waterTemp, ... }
// waveAction is a coarse staff-reported category. Observed live values (July
// 2026): "HIGH", "MOD", "None"/"NONE". The dataset also carries "LOW"
// historically. ANY other/unknown token (including stray mis-keyed values like
// "Murky") degrades to null — never a guessed height.
//
// CRITICAL (data ordering): the datastore's natural/_id order is INSERTION
// order, which is NOT chronological — do NOT trust it. We request the API with
// sort=dataCollectionDate desc AND, defensively, re-derive the freshest row by
// parsing dataCollectionDate ourselves, so a torn/re-ordered response can never
// serve a stale reading.
//
// COLOR/FLOOR MAPPING (representative feet, so the coarse category flows through
// the EXISTING wave-height rule — this module never emits a color):
//   HIGH -> 5.0 ft  (>=4 -> red)
//   MOD  -> 2.5 ft  (>=2 and <4 -> yellow)
//   LOW  -> 1.0 ft  (<2 -> green)
//   NONE -> 0.5 ft  (<2 -> green)
// These are stand-in magnitudes, not measured heights; the point is only that
// the flag color lands in the right band. A missing/unrecognized waveAction ->
// null (no reading), NEVER a green default.
//
// SEASONAL / CADENCE: staff observe roughly mid-May..mid-Sep, once per day. Off
// season we return null WITHOUT fetching (isInSeason gate). A row is honored
// only if its date is recent (within TORONTO_MAX_ROW_AGE_MS of nowIso and not in
// the future) so a stale prior-season value is never served as current.
//
// INTEGRATOR DEDUP NOTES:
//   1) Wave-height fallback ONLY. Do NOT also pull rip/wind signal from this
//      dataset — rip converges from three places already (SRF client primary);
//      wave height is Open-Meteo/GLOS primary with this as a null-only fallback.
//   2) Subrequest budget: EVERY Toronto beach shares the SAME single CKAN
//      endpoint, so a naive per-beach waveFt would issue one identical fetch per
//      wave-null Toronto beach in a run. This module MEMOIZES the fetched
//      records per nowIso (one fetch per run, fanned to all beaches sharing it),
//      mirroring the glerl.js platform-dedup intent, so the step-2b consult loop
//      stays inside the subrequest budget even on a fully wave-null run.
//   3) Geographic overlap: these are Lake Ontario / Toronto-waterfront beaches
//      only; the curated bbox/proximity gate keeps the source from ever
//      resolving a non-Toronto beach.
//
// Two-path rule: waveFt fetches upstream and is reachable ONLY from the cron
// (runWaveRefresh step-2b). The request path never imports this network code.
// Error isolation: every path degrades to null on any missing field / parse
// issue / stale reading / unrecognized category — NEVER a wrong height (which
// would mis-color a flag). No template literals; string concat with + only;
// const/let only; console.log logging.

import { fetchJson } from "../clients/http.js";
import { resolveSiteForBeach, DEFAULT_SITE_RADIUS_MI, MS_PER_DAY } from "../officialSources/util.js";

export const TORONTO_MODEL = "toronto_beach_obs";
export const TORONTO_LABEL = "Toronto Beaches Observations";
export const TORONTO_URL = "https://open.toronto.ca/dataset/toronto-beaches-observations/";

export const TORONTO_RESOURCE_ID = "b1b87de1-e021-43c2-a80e-69028fe9fafa";

// sort=dataCollectionDate desc so the freshest observations for all beaches sit
// at the top of the (limited) response; limit 100 comfortably covers ~10 days
// across the 10 curated beaches. The space in the sort value is URL-encoded.
export const TORONTO_API_URL =
  "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/datastore_search" +
  "?resource_id=" + TORONTO_RESOURCE_ID +
  "&sort=dataCollectionDate%20desc&limit=100";

// Representative feet per coarse staff category. Stand-in magnitudes chosen only
// so the value lands in the correct wave-height band (rules.js: >=4 red, >=2
// yellow, else green). Exported for tests.
export const WAVE_ACTION_FT = {
  HIGH: 5.0,
  MOD: 2.5,
  LOW: 1.0,
  NONE: 0.5
};

// A row is honored only if its date is within this window of nowIso (and not in
// the future). Two days absorbs posting lag and the Toronto-local vs UTC date
// offset while still rejecting a stale prior-day-plus reading. Once-daily source.
export const TORONTO_MAX_ROW_AGE_MS = 2 * MS_PER_DAY;

// Curated Lake Ontario / Toronto-waterfront beaches this source covers. beachName
// is the EXACT CKAN string (row match). names[] feed resolveSiteForBeach's
// substring pass (only usable when the beach row carries name/park_name); lat/lon
// feed the proximity fallback, which is the reliable gate on the wave path where
// the SELECT does not include a name column. Coordinates are approximate beach
// centroids — good enough for the proximity gate and provenance. radiusMi is kept
// modest so a non-Toronto beach can never resolve; the nearest curated beach wins
// among the clustered Toronto Island sites.
export const TORONTO_SITES = [
  { siteId: "woodbine", beachName: "Woodbine Beaches", names: ["woodbine"], lat: 43.663, lon: -79.305, radiusMi: 1.5 },
  { siteId: "kew-balmy", beachName: "Kew Balmy Beach", names: ["kew balmy", "kew beach", "balmy beach"], lat: 43.668, lon: -79.297, radiusMi: 1.5 },
  { siteId: "centre-island", beachName: "Centre Island Beach", names: ["centre island"], lat: 43.617, lon: -79.378, radiusMi: 1.0 },
  { siteId: "gibraltar-point", beachName: "Gibraltar Point Beach", names: ["gibraltar point"], lat: 43.612, lon: -79.386, radiusMi: 1.0 },
  { siteId: "hanlans-point", beachName: "Hanlan's Point Beach", names: ["hanlan"], lat: 43.617, lon: -79.395, radiusMi: 1.0 },
  { siteId: "wards-island", beachName: "Ward's Island Beach", names: ["ward's island", "wards island"], lat: 43.617, lon: -79.352, radiusMi: 1.0 },
  { siteId: "sunnyside", beachName: "Sunnyside Beach", names: ["sunnyside"], lat: 43.637, lon: -79.448, radiusMi: 1.5 },
  { siteId: "cherry", beachName: "Cherry Beach", names: ["cherry beach"], lat: 43.638, lon: -79.345, radiusMi: 1.5 },
  { siteId: "bluffers", beachName: "Bluffer's Beach Park", names: ["bluffer"], lat: 43.703, lon: -79.235, radiusMi: 1.5 },
  { siteId: "marie-curtis", beachName: "Marie Curtis Park East Beach", names: ["marie curtis"], lat: 43.585, lon: -79.545, radiusMi: 1.5 }
];

// Pure. Normalize a raw waveAction token to one of HIGH/MOD/LOW/NONE, or null.
// Uses an explicit allowlist — any unrecognized value (including stray mis-keyed
// tokens like "Murky", empty, non-string, numbers) degrades to null, never a
// guess. "NONE"/"None" collapse to "NONE".
export function normalizeWaveAction(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const key = raw.trim().toUpperCase();
  if (key === "HIGH") {
    return "HIGH";
  }
  if (key === "MOD" || key === "MODERATE") {
    return "MOD";
  }
  if (key === "LOW") {
    return "LOW";
  }
  if (key === "NONE") {
    return "NONE";
  }
  return null;
}

// Pure. Representative feet for a raw waveAction token, or null when the token
// is not a recognized category. Exported for tests.
export function waveActionToFt(raw) {
  const category = normalizeWaveAction(raw);
  if (category === null) {
    return null;
  }
  const ft = WAVE_ACTION_FT[category];
  if (typeof ft !== "number" || !isFinite(ft)) {
    return null;
  }
  return ft;
}

// Pure. Resolve a beach to one curated Toronto site (names first, then
// proximity), or null. Delegates to the shared resolveSiteForBeach so behavior
// matches the official-source resolver exactly.
export function resolveSite(beach) {
  if (!beach) {
    return null;
  }
  return resolveSiteForBeach(beach, TORONTO_SITES);
}

// Pure. Interpret the PASSED-IN nowIso only (no wall clock) to decide whether the
// once-daily staff observation program is in season (roughly mid-May..mid-Sep).
// Off season the source returns null without fetching. Invalid nowIso -> false
// (fail closed to no-data).
export function isInSeason(nowIso) {
  if (typeof nowIso !== "string" || nowIso.length === 0) {
    return false;
  }
  const d = new Date(nowIso);
  const ms = d.getTime();
  if (!isFinite(ms)) {
    return false;
  }
  const month = d.getUTCMonth(); // 0=Jan ... 4=May, 8=Sep
  const day = d.getUTCDate();
  if (month > 4 && month < 8) {
    // June, July, August
    return true;
  }
  if (month === 4 && day >= 15) {
    // mid-May onward
    return true;
  }
  if (month === 8 && day <= 15) {
    // through mid-September
    return true;
  }
  return false;
}

// Pure. Parse a "YYYY-MM-DD" date string to epoch ms (UTC midnight), or null.
function rowDateMs(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  if (!isFinite(ms)) {
    return null;
  }
  return ms;
}

// Pure. Extract the records array from a CKAN datastore_search response, or null
// on any unexpected shape (defensive — a schema change degrades to no-data).
export function extractRecords(json) {
  if (!json || typeof json !== "object") {
    return null;
  }
  if (json.success === false) {
    return null;
  }
  const result = json.result;
  if (!result || typeof result !== "object") {
    return null;
  }
  if (!Array.isArray(result.records)) {
    return null;
  }
  return result.records;
}

// Pure, exported for tests. From a records array, return the FRESHEST valid row
// for a given exact CKAN beachName that is within TORONTO_MAX_ROW_AGE_MS of
// nowIso and not in the future, or null. Re-derives freshness from
// dataCollectionDate itself (does NOT trust record order).
export function latestRowForBeach(records, beachName, nowIso) {
  if (!Array.isArray(records) || typeof beachName !== "string" || beachName.length === 0) {
    return null;
  }
  const nowMs = Date.parse(nowIso);
  if (!isFinite(nowMs)) {
    return null;
  }
  const targetName = beachName.trim().toLowerCase();
  let best = null;
  let bestMs = -Infinity;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec || typeof rec !== "object") {
      continue;
    }
    if (typeof rec.beachName !== "string") {
      continue;
    }
    if (rec.beachName.trim().toLowerCase() !== targetName) {
      continue;
    }
    const ms = rowDateMs(rec.dataCollectionDate);
    if (ms === null) {
      continue;
    }
    // Reject rows in the future (row date after nowIso's day).
    if (ms - nowMs > 0) {
      continue;
    }
    if (ms > bestMs) {
      bestMs = ms;
      best = rec;
    }
  }
  if (best === null) {
    return null;
  }
  // Freshness: the freshest in-range row must be recent enough to be "current".
  if (nowMs - bestMs > TORONTO_MAX_ROW_AGE_MS) {
    return null;
  }
  return best;
}

// Pure, exported for tests. (CKAN json, beach, nowIso) -> finite feet | null.
// Resolves the beach to a curated site, finds that site's freshest fresh row,
// and maps its waveAction to a representative height. Any missing/stale/
// unrecognized step degrades to null — never a wrong height.
export function parseTorontoWaveFt(json, beach, nowIso) {
  const records = extractRecords(json);
  if (records === null) {
    return null;
  }
  return waveFtFromRecords(records, beach, nowIso);
}

// Pure. Shared core used by both parseTorontoWaveFt (json fixtures) and waveFt
// (memoized records). Not exported — the two entry points above are the surface.
function waveFtFromRecords(records, beach, nowIso) {
  const site = resolveSite(beach);
  if (site === null) {
    return null;
  }
  const row = latestRowForBeach(records, site.beachName, nowIso);
  if (row === null) {
    return null;
  }
  const ft = waveActionToFt(row.waveAction);
  if (typeof ft !== "number" || !isFinite(ft)) {
    return null;
  }
  return ft;
}

// Pure guard. True only if the beach resolves to a curated Toronto site. Uses
// name (when present) then lat/lon proximity — the wave-refresh SELECT omits the
// name column, so proximity is the operative gate there.
export function matches(beach) {
  return resolveSite(beach) !== null;
}

// Module-level per-run memo so all wave-null Toronto beaches in one run share a
// SINGLE CKAN fetch. Keyed by nowIso (runWaveRefresh passes the same nowIso to
// every beach in a run). Caches the extracted records array OR null (a failed
// fetch is not retried within the run — fail closed, stay in budget).
let _recordsCache = { key: null, records: null };

async function fetchRecordsForRun(nowIso) {
  if (_recordsCache.key === nowIso) {
    return _recordsCache.records;
  }
  const json = await fetchJson(TORONTO_API_URL, { label: "torontoBeachObs: fetch" });
  let records = null;
  if (json !== null) {
    records = extractRecords(json);
  }
  _recordsCache = { key: nowIso, records: records };
  return records;
}

// Cron-side ONLY. Returns a finite representative wave height in feet for a
// matched Toronto beach's freshest in-season observation, or null. NEVER throws
// across the boundary. Off season (or invalid nowIso) it returns null without
// fetching.
async function waveFt(beach, nowIso, env) {
  if (!isInSeason(nowIso)) {
    return null;
  }
  try {
    const records = await fetchRecordsForRun(nowIso);
    if (records === null) {
      return null;
    }
    return waveFtFromRecords(records, beach, nowIso);
  } catch (err) {
    console.log(
      "torontoBeachObs: waveFt failed for beach " +
      (beach && beach.id !== undefined ? beach.id : "?") + ": " + err.message
    );
    return null;
  }
}

// The supplemental wave-source object the registry (src/waveSources/index.js)
// consumes. Shape locked to { id, model, label, url, matches, waveFt }.
export const torontoBeachObsSource = {
  id: "toronto-beach-obs",
  model: TORONTO_MODEL,
  label: TORONTO_LABEL,
  url: TORONTO_URL,
  matches: matches,
  waveFt: waveFt
};

// Alias so the integrator can import under either spelling.
export { torontoBeachObsSource as torontoWaveSource };

// Test-only: reset the per-run memo between cases. Never called in production.
export function _resetCacheForTest() {
  _recordsCache = { key: null, records: null };
}

// Re-export shared resolver bits for the integrator/tests, mirroring other
// supplemental sources.
export { resolveSiteForBeach, DEFAULT_SITE_RADIUS_MI };
