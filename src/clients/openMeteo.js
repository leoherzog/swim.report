// src/clients/openMeteo.js
// Client for the Open-Meteo marine and standard forecast APIs. Every export
// is async, takes structured args, and NEVER throws across the module
// boundary: on any error the function logs with console.log and resolves to
// null.

import { metersToFeet } from "../geo.js";

export const WAVE_MODEL_ORDER = ["ecmwf_wam025", "ncep_gfswave025", "meteofrance_wave"];

// The request uses forecast_days=2&timezone=UTC, so hourly.time always starts
// at hour 0 UTC of the current day and has 48 entries. The array index for the
// current hour equals the UTC hour of nowIso (0-23), and the 24-hour forecast
// window idx..idx+23 is always within the 48-entry series. Bounds are checked
// per-series at the call site.
function findHourIndex(nowIso) {
  return new Date(nowIso).getUTCHours();
}

// Open-Meteo sometimes reports a masked Great Lakes cell as 0.0 across the
// entire series instead of nulls. A series whose every finite cell is exactly
// 0 is that no-data signature, not a real flat calm — real calm water still
// reads as small nonzero floats somewhere in 48 hours.
function seriesAllZero(series) {
  let hasFinite = false;
  for (let i = 0; i < series.length; i++) {
    const value = series[i];
    if (typeof value === "number" && isFinite(value)) {
      if (value !== 0) {
        return false;
      }
      hasFinite = true;
    }
  }
  return hasFinite;
}

// Pick the wave reading at a single series index: iterate WAVE_MODEL_ORDER and
// Slice one model's wave_height series into a 24-entry feet array starting at
// startIndex. Non-finite/out-of-bounds cells become null. Returns null when
// the model has no usable series, every cell is null, or every finite cell in
// the full series is exactly 0 (masked-cell signature) — callers keep only
// models that contributed at least one finite hour.
function modelHoursSlice(hourly, model, startIndex) {
  const series = hourly["wave_height_" + model];
  if (!Array.isArray(series)) {
    return null;
  }
  if (seriesAllZero(series)) {
    return null;
  }
  const out = [];
  let hasFinite = false;
  for (let h = 0; h < 24; h++) {
    const index = startIndex + h;
    const value = (index >= 0 && index < series.length) ? series[index] : null;
    if (typeof value === "number" && isFinite(value)) {
      out.push(metersToFeet(value));
      hasFinite = true;
    } else {
      out.push(null);
    }
  }
  return hasFinite ? out : null;
}

// Points array [{ beachId, lat, lon }, ...] -> "&latitude=a,b,c&longitude=x,y,z"
// query-string fragment shared by every Open-Meteo endpoint here.
function latLonQuery(points) {
  const lats = points.map(function(p) { return p.lat; });
  const lons = points.map(function(p) { return p.lon; });
  return "latitude=" + lats.join(",") + "&longitude=" + lons.join(",");
}

// Shared fetch wrapper: GET url, ok-check, JSON-parse, and normalize the
// response into a per-point locations array (Open-Meteo returns a bare object
// for a single point and an array for multiple points). NEVER throws across
// the module boundary: any network error, non-2xx status, or JSON parse
// failure is caught, logged with console.log, and resolves to null.
async function fetchLocations(url, label) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.log("openMeteo: " + label + " fetch failed: HTTP " + response.status);
      return null;
    }
    const json = await response.json();
    return Array.isArray(json) ? json : [json];
  } catch (err) {
    console.log("openMeteo: " + label + " fetch failed: " + err.message);
    return null;
  }
}

export async function fetchWaveHeightsFt(points, nowIso) {
  const url = "https://marine-api.open-meteo.com/v1/marine?" + latLonQuery(points) +
    "&hourly=wave_height,wave_direction,wave_period" +
    "&models=" + WAVE_MODEL_ORDER.join(",") +
    "&forecast_days=2&timezone=UTC";
  try {
    const locations = await fetchLocations(url, "wave");
    if (locations === null) {
      return null;
    }
    const results = {};
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const location = locations[i];
      if (!location || !location.hourly) {
        const emptyHours = [];
        for (let h = 0; h < 24; h++) {
          emptyHours.push(null);
        }
        results[point.beachId] = { waveHeightFt: null, model: null, hoursFt: emptyHours, models: [], byModel: {} };
        continue;
      }
      const idx = findHourIndex(nowIso);
      // Per-model 24-hour slices (raw floats, feet). byModel keeps only models
      // that contributed >= 1 finite hour; it powers the detail page's model
      // comparison and is stored verbatim in the WaveSeries KV payload.
      const byModel = {};
      for (let m = 0; m < WAVE_MODEL_ORDER.length; m++) {
        const model = WAVE_MODEL_ORDER[m];
        const slice = modelHoursSlice(location.hourly, model, idx);
        if (slice !== null) {
          byModel[model] = slice;
        }
      }
      // Composite series: at each hour, the first model in WAVE_MODEL_ORDER
      // with a finite value wins. waveHeightFt / model come from the hour-0
      // pass of this same loop so the flag color and the chart's first cell
      // always agree (load-bearing). models = the distinct winners, in
      // WAVE_MODEL_ORDER order (a model can appear in byModel without ever
      // winning an hour).
      const hoursFt = [];
      const modelsUsed = {};
      let waveHeightFt = null;
      let hour0Model = null;
      for (let h = 0; h < 24; h++) {
        let valueFt = null;
        let usedModel = null;
        for (let m = 0; m < WAVE_MODEL_ORDER.length; m++) {
          const model = WAVE_MODEL_ORDER[m];
          const slice = byModel[model];
          if (slice !== undefined && slice[h] !== null) {
            valueFt = slice[h];
            usedModel = model;
            break;
          }
        }
        hoursFt.push(valueFt);
        if (usedModel !== null) {
          modelsUsed[usedModel] = true;
        }
        if (h === 0) {
          waveHeightFt = valueFt;
          hour0Model = usedModel;
        }
      }
      const models = WAVE_MODEL_ORDER.filter(function(model) {
        return modelsUsed[model] === true;
      });
      results[point.beachId] = {
        waveHeightFt: waveHeightFt,
        model: hour0Model,
        hoursFt: hoursFt,
        models: models,
        byModel: byModel
      };
    }
    return { results: results, sourceUrl: url };
  } catch (err) {
    console.log("openMeteo: wave fetch failed: " + err.message);
    return null;
  }
}

export async function fetchWinds(points) {
  const url = "https://api.open-meteo.com/v1/forecast?" + latLonQuery(points) +
    "&current=wind_speed_10m,wind_gusts_10m&wind_speed_unit=mph&timezone=UTC";
  try {
    const locations = await fetchLocations(url, "wind");
    if (locations === null) {
      return null;
    }
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
