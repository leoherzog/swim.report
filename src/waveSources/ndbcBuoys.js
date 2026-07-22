// src/waveSources/ndbcBuoys.js
//
// KIND: wave — a SUPPLEMENTAL fallback wave-height source (src/waveSources
// registry). It is NOT an official override and NOT a color source: it only
// produces a wave HEIGHT in feet that runWaveRefresh treats exactly like the
// primary Open-Meteo/GLOS reading (feeding the wave-height rule in
// src/rules.js: >=4 ft red, >=2 ft yellow, else green). Consulted ONLY for
// beaches whose primary wave height came back null, in registry order, first
// finite hit wins (never additive).
//
// SOURCE: NOAA National Data Buoy Center (NDBC) realtime2 standard
// meteorological files, https://www.ndbc.noaa.gov/data/realtime2/{id}.txt —
// raw fixed-width/space-delimited text. Two comment header lines start with
// "#"; the first is column names, the second is units. Data rows follow,
// NEWEST FIRST. Columns (0-based after whitespace split):
//   0 YY  1 MM  2 DD  3 hh  4 mm  5 WDIR  6 WSPD  7 GST  8 WVHT  9 DPD ...
// WVHT (index 8) is significant wave height in METRES (header unit "m"), or
// the literal "MM" when missing. We take the newest data row whose WVHT is a
// finite non-"MM" value AND whose UTC timestamp is fresh, then convert
// metres -> feet (metersToFeet, ~3.28084).
//
// COLOR/FLOOR MAPPING: none. This source emits a numeric wave height only; the
// green/yellow/red decision stays solely in src/rules.js estimateFlag. We never
// emit a color.
//
// STATION LIST: a curated set of Great Lakes NDBC stations, each verified
// (July 2026) to have a live realtime2 file, with published lat/lon. For a
// beach we pick the NEAREST station within NDBC_MAX_DISTANCE_KM (40 km); beyond
// that a buoy is not representative of the beach, so we return null (rules fall
// back to wind/unknown) rather than borrow a distant reading. Great Lakes buoys
// are seasonal (many pulled Nov-Apr), so a station 404 / all-"MM" WVHT / winter
// gap all degrade to null — expected, not an error.
//
// INTEGRATOR DEDUP NOTE (two kinds of dedup):
//   1) Subrequest budget: many beaches share the same nearest station, so
//      dedup by station id (nearestStation(...).id) in the runWaveRefresh
//      step-2b consult and fetch each unique station ONCE per run, fanning the
//      result to every beach sharing it (mirror glerl.js's platform dedup).
//      This module fetches ONE station per call; the caps live in the consult.
//   2) Platform overlap with GLOS/GLERL: some of these NDBC ids are the SAME
//      physical platform GLOS/glerl.js already serves (e.g. 45013 Atwater Park
//      and 45161 Muskegon are GLOS/UWM buoys). Because this source is a
//      FALLBACK consulted ONLY where the GLOS pass already returned null, a
//      single beach's reading is never double-counted — but an integrator
//      widening either list should audit the two station sets so the same buoy
//      is not presented under two different model badges.
//
// Two-path rule: waveFt fetches upstream and is reachable ONLY from the cron
// (runWaveRefresh). The request path never imports this network code. Error
// isolation: every path degrades to null on any missing field / parse issue /
// stale or masked reading — NEVER a wrong height (which would mis-color a flag).
// No template literals; string concat with + only; const/let only.

import { distanceKm, metersToFeet } from "../geo.js";
import { fetchText } from "../officialSources/util.js";

export const NDBC_MODEL = "ndbc_buoy";
export const NDBC_LABEL = "NOAA NDBC Buoy";
export const NDBC_URL = "https://www.ndbc.noaa.gov/";

// Base for a station's realtime2 standard-meteorological file.
export const NDBC_REALTIME2_BASE = "https://www.ndbc.noaa.gov/data/realtime2/";

// Beyond this a buoy stops being representative of the beach — the beach gets
// null (rules fall back to wind/unknown) rather than a borrowed reading.
export const NDBC_MAX_DISTANCE_KM = 40;

// Freshness window for a buoy observation, matching the product-wide 2 h stale
// rule (glerl.js uses the same). An older WVHT reading is discarded (null),
// never served as the current condition.
export const NDBC_MAX_OBS_AGE_MS = 7200000;

// Small tolerance for observation timestamps slightly ahead of nowIso (upstream
// clock skew); anything further in the future is rejected.
export const NDBC_MAX_OBS_FUTURE_MS = 600000;

// Sanity ceiling: Great Lakes significant wave height never approaches this.
// A parsed value above it is corrupt input, not a real reading -> null.
const MAX_REASONABLE_METERS = 30;

// Index of the WVHT column after splitting a data row on whitespace.
const WVHT_INDEX = 8;

// Curated Great Lakes NDBC stations. Each id was verified (July 2026) to have a
// live realtime2 file; lat/lon are the published station coordinates (decimal
// degrees, W longitude negative). Keep this list conservative — only stations
// confirmed to exist and report standard-met WVHT belong here, because a wrong
// coordinate could attribute the wrong buoy to a beach (the 40 km cap bounds,
// but does not eliminate, that risk).
export const NDBC_STATIONS = [
  { id: "45001", lat: 48.061, lon: -87.793, name: "Mid Superior" },
  { id: "45002", lat: 45.344, lon: -86.411, name: "North Michigan" },
  { id: "45004", lat: 47.583, lon: -86.586, name: "East Superior" },
  { id: "45005", lat: 41.677, lon: -82.398, name: "West Lake Erie" },
  { id: "45012", lat: 43.621, lon: -77.401, name: "East Lake Ontario" },
  { id: "45013", lat: 43.098, lon: -87.850, name: "Atwater Park, WI" },
  { id: "45161", lat: 43.185, lon: -86.354, name: "Muskegon, MI" },
  { id: "45164", lat: 41.748, lon: -81.698, name: "Cleveland, OH" },
  { id: "45165", lat: 41.704, lon: -83.264, name: "Toledo Water Intake, OH" },
  { id: "45167", lat: 42.185, lon: -80.135, name: "Erie Nearshore, PA" }
];

// Pure. Nearest curated station within NDBC_MAX_DISTANCE_KM of (lat, lon), as
// { id, lat, lon, name, distanceKm }, or null when the point is invalid or no
// station is close enough.
export function nearestStation(lat, lon) {
  if (typeof lat !== "number" || !isFinite(lat) ||
      typeof lon !== "number" || !isFinite(lon)) {
    return null;
  }
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < NDBC_STATIONS.length; i++) {
    const st = NDBC_STATIONS[i];
    const d = distanceKm(lat, lon, st.lat, st.lon);
    if (d < bestDist) {
      bestDist = d;
      best = st;
    }
  }
  if (best === null || bestDist > NDBC_MAX_DISTANCE_KM) {
    return null;
  }
  return { id: best.id, lat: best.lat, lon: best.lon, name: best.name, distanceKm: bestDist };
}

// Pure. Realtime2 file URL for a station id.
export function stationUrl(stationId) {
  return NDBC_REALTIME2_BASE + stationId + ".txt";
}

// Pure. Parse a data row's leading "YYYY MM DD hh mm" fields into an epoch-ms
// UTC timestamp, or null when any field is missing/non-numeric. NDBC realtime2
// timestamps are UTC.
function rowTimestampMs(fields) {
  if (!Array.isArray(fields) || fields.length < 5) {
    return null;
  }
  const yr = parseInt(fields[0], 10);
  const mo = parseInt(fields[1], 10);
  const dy = parseInt(fields[2], 10);
  const hr = parseInt(fields[3], 10);
  const mn = parseInt(fields[4], 10);
  if (!isFinite(yr) || !isFinite(mo) || !isFinite(dy) ||
      !isFinite(hr) || !isFinite(mn)) {
    return null;
  }
  const ms = Date.UTC(yr, mo - 1, dy, hr, mn, 0);
  if (!isFinite(ms)) {
    return null;
  }
  return ms;
}

// Pure. A WVHT token in metres, or null. "MM" (missing), non-numeric, negative,
// or absurdly large (> MAX_REASONABLE_METERS) all degrade to null. 0 m (calm)
// is a legitimate finite reading and passes through.
function wvhtMeters(token) {
  if (typeof token !== "string") {
    return null;
  }
  if (token === "MM") {
    return null;
  }
  const v = parseFloat(token);
  if (!isFinite(v) || v < 0 || v > MAX_REASONABLE_METERS) {
    return null;
  }
  return v;
}

// Pure, exported for tests. (realtime2 body text, nowIso) -> finite feet | null.
// Walks data rows newest-first and returns the FIRST row whose WVHT is a finite
// non-"MM" metres value AND whose UTC timestamp is within NDBC_MAX_OBS_AGE_MS of
// nowIso (not more than NDBC_MAX_OBS_FUTURE_MS in the future). Any parse issue,
// masked column, or stale/missing reading degrades to null — never a wrong
// height. Comment lines ("#...") and blank lines are skipped.
export function parseNdbcWaveFt(text, nowIso) {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  if (typeof nowIso !== "string" || nowIso.length === 0) {
    return null;
  }
  const nowMs = Date.parse(nowIso);
  if (!isFinite(nowMs)) {
    return null;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0 || line.charAt(0) === "#") {
      continue;
    }
    const fields = line.split(/\s+/);
    if (fields.length <= WVHT_INDEX) {
      continue;
    }
    const meters = wvhtMeters(fields[WVHT_INDEX]);
    if (meters === null) {
      // Newer row with a masked/invalid WVHT — keep scanning older rows.
      continue;
    }
    const tsMs = rowTimestampMs(fields);
    if (tsMs === null) {
      continue;
    }
    // Reject readings too far in the future (clock skew tolerance) or older
    // than the freshness window. Because rows are newest-first, the first row
    // carrying a real WVHT is the freshest such reading; if it is already
    // stale, every row below it is older too, so we stop and return null.
    if (tsMs - nowMs > NDBC_MAX_OBS_FUTURE_MS) {
      continue;
    }
    if (nowMs - tsMs > NDBC_MAX_OBS_AGE_MS) {
      return null;
    }
    const ft = metersToFeet(meters);
    if (typeof ft === "number" && isFinite(ft)) {
      return ft;
    }
    return null;
  }
  return null;
}

// Pure guard: this source can serve a beach only if a curated station sits
// within the cap. Uses only lat/lon (no other beach key required).
export function matches(beach) {
  if (!beach) {
    return false;
  }
  return nearestStation(beach.lat, beach.lon) !== null;
}

// Pure. The run-scoped dedup key: the NEAREST curated station's id. Many beaches
// share one nearest buoy, so the step-2b consult fetches each station's
// realtime2 file ONCE and fans the reading to every beach sharing it. The id
// fully determines waveFt's fetch (the parsed WVHT is station-, not beach-,
// specific), so the memo's cached ft is exactly what waveFt would produce. null
// when no station is in range.
export function keyOf(beach) {
  if (!beach) {
    return null;
  }
  const station = nearestStation(beach.lat, beach.lon);
  return station === null ? null : station.id;
}

// Cron-side ONLY. Picks the nearest curated buoy, fetches its realtime2 file,
// and resolves the freshest valid WVHT valid at nowIso, in feet, or null.
// NEVER throws across the boundary.
async function waveFt(beach, nowIso, env) {
  const station = nearestStation(beach ? beach.lat : null, beach ? beach.lon : null);
  if (station === null) {
    return null;
  }
  const text = await fetchText(stationUrl(station.id), {
    logPrefix: "ndbcBuoys: fetch failed for station " + station.id
  });
  if (text === null) {
    return null;
  }
  try {
    return parseNdbcWaveFt(text, nowIso);
  } catch (err) {
    console.log(
      "ndbcBuoys: parse failed for station " + station.id +
      " (beach " + (beach ? beach.id : "?") + "): " + err.message
    );
    return null;
  }
}

// The supplemental wave-source object the registry (src/waveSources/index.js)
// consumes. Shape locked to { id, model, label, url, matches, waveFt }.
export const ndbcBuoySource = {
  id: "ndbc-buoys",
  model: NDBC_MODEL,
  label: NDBC_LABEL,
  url: NDBC_URL,
  matches: matches,
  keyOf: keyOf,
  waveFt: waveFt
};

// Alias so the integrator can import under either spelling.
export { ndbcBuoySource as ndbcWaveSource };
