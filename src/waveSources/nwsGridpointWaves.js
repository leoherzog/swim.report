// src/waveSources/nwsGridpointWaves.js
//
// KIND: wave — a SUPPLEMENTAL fallback wave-height source (src/waveSources
// registry). It is NOT an official override and NOT a color source: it only
// produces a wave HEIGHT in feet that runWaveRefresh treats exactly like the
// primary Open-Meteo/GLOS reading (feeding the wave-height rule in
// src/rules.js). Consulted ONLY for beaches whose primary wave height came back
// null, in registry order, first finite hit wins (never additive).
//
// SOURCE: NWS gridpoint forecast (api.weather.gov/gridpoints/{WFO}/{x},{y}),
// carried per beach as beach.nws_grid_url from the points-enrichment cron. The
// gridpoint JSON exposes properties.waveHeight (and sometimes
// properties.windWaveHeight) as an ISO8601 time series:
//   { uom: "wmoUnit:m", values: [ { validTime: "<ISO start>/<ISO8601 dur>",
//                                    value: <meters | null> }, ... ] }
// We pick the value whose validTime interval contains nowIso and convert
// metres -> feet (metersToFeet, ~3.28084). Lake gridpoints expose waveHeight
// ONLY where water-adjacent, and cells are frequently masked (value null), so
// returning null is NORMAL and common here — never an error.
//
// COLOR/FLOOR MAPPING: none. This source emits a numeric wave height only; the
// green/yellow/red decision stays solely in src/rules.js estimateFlag
// (>=4 ft red, >=2 ft yellow, else green). We never emit a color.
//
// INTEGRATOR DEDUP NOTE: many beaches share one WFO gridpoint cell, so
// beach.nws_grid_url repeats across beaches. Dedup by nws_grid_url before
// fetching — fetch each unique grid URL ONCE per run and fan the result to
// every beach sharing it (mirror glerl.js's platform dedup) — otherwise a
// fully wave-null (winter) run issues one fetch per beach and blows the
// per-invocation subrequest budget. This module fetches a single grid URL; the
// dedup/caps belong in the runWaveRefresh step-2b consult, not here.
//
// Two-path rule: waveFt fetches upstream and is reachable ONLY from the cron
// (runWaveRefresh). The request path never imports this network code. Error
// isolation: every path degrades to null on any missing field / parse issue /
// unrecognized unit — NEVER a wrong height (which would mis-color a flag).
// No template literals; string concat with + only; const/let only.

import { fetchJson } from "../clients/http.js";
import { NWS_USER_AGENT } from "../clients/nws.js";
import { metersToFeet } from "../geo.js";

export const GRIDPOINT_MODEL = "nws_gridpoint_wave";
export const GRIDPOINT_LABEL = "NWS Gridpoint Wave Forecast";
export const GRIDPOINT_URL = "https://www.weather.gov/";

// Pure. Parse an ISO8601 duration (e.g. "PT1H", "PT6H", "P1DT6H", "PT30M") to
// milliseconds, or null when it is not a recognizable P[nD][T[nH][nM][nS]]
// duration. Weeks (PnW) and fractional components are deliberately unhandled
// (NWS gridpoint durations are whole hours/days) and degrade to null.
export function iso8601DurationMs(dur) {
  if (typeof dur !== "string") {
    return null;
  }
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(dur);
  if (m === null) {
    return null;
  }
  // Require at least one numeric component — a bare "P" or "PT" is meaningless.
  if (!m[1] && !m[2] && !m[3] && !m[4]) {
    return null;
  }
  const days = m[1] ? parseInt(m[1], 10) : 0;
  const hours = m[2] ? parseInt(m[2], 10) : 0;
  const minutes = m[3] ? parseInt(m[3], 10) : 0;
  const seconds = m[4] ? parseInt(m[4], 10) : 0;
  return ((((days * 24) + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

// Pure. Parse a gridpoint validTime "<ISO start>/<ISO8601 duration>" into
// { startMs, endMs }, or null when either half is unparseable.
function parseInterval(validTime) {
  if (typeof validTime !== "string") {
    return null;
  }
  const slash = validTime.indexOf("/");
  if (slash === -1) {
    return null;
  }
  const startMs = Date.parse(validTime.slice(0, slash));
  if (!isFinite(startMs)) {
    return null;
  }
  const durMs = iso8601DurationMs(validTime.slice(slash + 1));
  if (durMs === null) {
    return null;
  }
  return { startMs: startMs, endMs: startMs + durMs };
}

// A masked/absent/negative reading is "no data", not zero. 0 m (calm) is a
// legitimate finite reading and passes through.
function normalizeMeters(value) {
  if (typeof value !== "number" || !isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

// A gridpoint quantity is metres unless its uom says otherwise. When uom is
// absent we assume metres (the documented default for waveHeight); when uom is
// present we REQUIRE it to resolve to metres and reject anything else rather
// than guess a unit (a wrong unit would mis-color a flag).
function seriesInMeters(series) {
  const uom = series.uom;
  if (uom === undefined || uom === null) {
    return true;
  }
  if (typeof uom !== "string") {
    return false;
  }
  const parts = uom.split(":");
  return parts[parts.length - 1] === "m";
}

// Pure. Return the metres value whose interval contains nowMs, or the first
// entry's value when nowMs precedes the whole series (forecast not yet
// started), or null when nowMs is past the series / nothing parseable / the
// selected cell is masked.
function metersAtTime(series, nowMs) {
  const values = series.values;
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  let firstStartMs = null;
  let firstValue = null;
  for (let i = 0; i < values.length; i++) {
    const entry = values[i];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const iv = parseInterval(entry.validTime);
    if (iv === null) {
      continue;
    }
    if (firstStartMs === null) {
      firstStartMs = iv.startMs;
      firstValue = entry.value;
    }
    if (nowMs >= iv.startMs && nowMs < iv.endMs) {
      return normalizeMeters(entry.value);
    }
  }
  if (firstStartMs !== null && nowMs < firstStartMs) {
    return normalizeMeters(firstValue);
  }
  return null;
}

// Pure, exported for tests. (gridpointJson, nowIso) -> finite feet | null.
// Tries properties.waveHeight first, then properties.windWaveHeight, so a
// masked primary series can still fall back to the wind-wave series. Any
// missing field, unrecognized unit, masked cell, or out-of-range time degrades
// to null — never a wrong height.
export function parseGridpointWaveFt(json, nowIso) {
  if (!json || typeof json !== "object") {
    return null;
  }
  if (typeof nowIso !== "string" || nowIso.length === 0) {
    return null;
  }
  const nowMs = Date.parse(nowIso);
  if (!isFinite(nowMs)) {
    return null;
  }
  const props = json.properties;
  if (!props || typeof props !== "object") {
    return null;
  }
  const candidates = [props.waveHeight, props.windWaveHeight];
  for (let i = 0; i < candidates.length; i++) {
    const series = candidates[i];
    if (!series || typeof series !== "object" || !Array.isArray(series.values) ||
        series.values.length === 0) {
      continue;
    }
    if (!seriesInMeters(series)) {
      continue;
    }
    const meters = metersAtTime(series, nowMs);
    if (meters === null) {
      continue;
    }
    const ft = metersToFeet(meters);
    if (typeof ft === "number" && isFinite(ft)) {
      return ft;
    }
  }
  return null;
}

// Pure guard: this source can serve a beach only if it carries a gridpoint URL.
export function matches(beach) {
  return !!beach && typeof beach.nws_grid_url === "string" &&
    beach.nws_grid_url.length > 0;
}

// Pure. The run-scoped dedup key: the WFO gridpoint URL itself. Many beaches
// share one cell, so the step-2b consult fetches each unique URL ONCE and fans
// the result to every beach sharing it. null when the beach has no grid URL.
export function keyOf(beach) {
  return matches(beach) ? beach.nws_grid_url : null;
}

// Cron-side ONLY. Fetches the beach's gridpoint JSON and resolves the wave
// height valid at nowIso, in feet, or null. NEVER throws across the boundary.
async function waveFt(beach, nowIso, env) {
  if (!matches(beach)) {
    return null;
  }
  const json = await fetchJson(beach.nws_grid_url, {
    headers: {
      "User-Agent": NWS_USER_AGENT,
      "Accept": "application/geo+json"
    },
    label: "nwsGridpointWaves: " + beach.nws_grid_url
  });
  if (json === null) {
    return null;
  }
  try {
    return parseGridpointWaveFt(json, nowIso);
  } catch (err) {
    console.log(
      "nwsGridpointWaves: parse failed for beach " + beach.id + ": " + err.message
    );
    return null;
  }
}

// The supplemental wave-source object the registry (src/waveSources/index.js)
// consumes. Shape locked to { id, model, label, url, matches, waveFt }.
export const nwsGridpointWaveSource = {
  id: "nws-gridpoint-waves",
  model: GRIDPOINT_MODEL,
  label: GRIDPOINT_LABEL,
  url: GRIDPOINT_URL,
  matches: matches,
  keyOf: keyOf,
  waveFt: waveFt
};

// Aliases so the integrator can import under either spelling used in the
// scaffolding notes without rework.
export { nwsGridpointWaveSource as gridpointWaveSource };
export { nwsGridpointWaveSource as gridpointSource };
