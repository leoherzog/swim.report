// src/clients/openMeteo.js
// Client for the Open-Meteo marine and standard forecast APIs. Every export
// is async, takes structured args, and NEVER throws across the module
// boundary: on any error the function logs with console.log and resolves to
// null.

export const WAVE_MODEL_ORDER = ["ecmwf_wam025", "ncep_gfswave025", "meteofrance_wave"];

const METERS_TO_FEET = 3.28084;

function metersToFeetLocal(m) {
  if (m === null || m === undefined) {
    return null;
  }
  return m * METERS_TO_FEET;
}

// The request uses forecast_days=1&timezone=UTC, so hourly.time always
// starts at hour 0 UTC of the current day and the array index equals the
// UTC hour of nowIso. Bounds are checked per-series at the call site.
function findHourIndex(nowIso) {
  return new Date(nowIso).getUTCHours();
}

export async function fetchWaveHeightsFt(points, nowIso) {
  const lats = points.map(function(p) { return p.lat; });
  const lons = points.map(function(p) { return p.lon; });
  const url = "https://marine-api.open-meteo.com/v1/marine?latitude=" + lats.join(",") +
    "&longitude=" + lons.join(",") +
    "&hourly=wave_height,wave_direction,wave_period" +
    "&models=" + WAVE_MODEL_ORDER.join(",") +
    "&forecast_days=1&timezone=UTC";
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.log("openMeteo: wave fetch failed: HTTP " + response.status);
      return null;
    }
    const json = await response.json();
    const locations = Array.isArray(json) ? json : [json];
    const results = {};
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const location = locations[i];
      if (!location || !location.hourly) {
        results[point.beachId] = { waveHeightFt: null, model: null };
        continue;
      }
      const idx = findHourIndex(nowIso);
      let waveHeightFt = null;
      let usedModel = null;
      for (let m = 0; m < WAVE_MODEL_ORDER.length; m++) {
        const model = WAVE_MODEL_ORDER[m];
        const series = location.hourly["wave_height_" + model];
        if (Array.isArray(series) && idx >= 0 && idx < series.length) {
          const value = series[idx];
          if (typeof value === "number" && isFinite(value)) {
            waveHeightFt = metersToFeetLocal(value);
            usedModel = model;
            break;
          }
        }
      }
      results[point.beachId] = { waveHeightFt: waveHeightFt, model: usedModel };
    }
    return { results: results, sourceUrl: url };
  } catch (err) {
    console.log("openMeteo: wave fetch failed: " + err.message);
    return null;
  }
}

export async function fetchWinds(points) {
  const lats = points.map(function(p) { return p.lat; });
  const lons = points.map(function(p) { return p.lon; });
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lats.join(",") +
    "&longitude=" + lons.join(",") +
    "&current=wind_speed_10m,wind_gusts_10m&wind_speed_unit=mph&timezone=UTC";
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.log("openMeteo: wind fetch failed: HTTP " + response.status);
      return null;
    }
    const json = await response.json();
    const locations = Array.isArray(json) ? json : [json];
    const results = {};
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const location = locations[i];
      const current = location ? location.current : null;
      const windSpeedMph = current && typeof current.wind_speed_10m === "number" ? current.wind_speed_10m : null;
      const windGustMph = current && typeof current.wind_gusts_10m === "number" ? current.wind_gusts_10m : null;
      results[point.beachId] = { windSpeedMph: windSpeedMph, windGustMph: windGustMph };
    }
    return { results: results, sourceUrl: url };
  } catch (err) {
    console.log("openMeteo: wind fetch failed: " + err.message);
    return null;
  }
}
