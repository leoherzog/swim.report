// Model labels and provenance urls for the wave inputs the offline NOAA GRIB
// pipeline publishes into "waveinput:" / "waves:" KV. Static tables, so the
// hourly flag cron can name a reading's source without importing any fetching
// module. Lives outside src/index.js because workerd rejects every non-function
// named export on the Worker entry module (precedent: src/demandWindow.js).

// Every id here must also appear in MODEL_DISPLAY in src/frontend/waveStrip.js,
// or the detail-page chart legend renders the raw id to visitors.
const WAVE_MODEL_LABELS = {
  "noaa_gfswave": "NOAA GFS Wave Model",
  "noaa_gfswave_arctic": "NOAA GFS Wave Model (Arctic)",
  "noaa_glwu": "NOAA Great Lakes Wave Model"
};

export const WAVE_MODEL_IDS = Object.keys(WAVE_MODEL_LABELS);

// One provenance page for all three grids: NOAA publishes no per-grid page that
// resolves (both GLWU candidates 404), and these render as plain-text chips on
// the flag cards, never as links.
const NOAA_WAVES_URL = "https://polar.ncep.noaa.gov/waves/";

// The wind fallback comes out of the SAME GRIB message as the wave height, so it
// carries the same provenance. Frozen because the hourly cron pushes this exact
// object into an estimate's sources array.
export const WIND_SOURCE = Object.freeze({
  label: "Wind Forecast",
  url: NOAA_WAVES_URL
});

// An unrecognised id degrades to the generic label — it must never throw, and it
// never affects color.
export function waveSourceLabel(model) {
  if (Object.prototype.hasOwnProperty.call(WAVE_MODEL_LABELS, model)) {
    return WAVE_MODEL_LABELS[model];
  }
  return "Wave Forecast";
}

export function waveSourceUrl(model) {
  return NOAA_WAVES_URL;
}
