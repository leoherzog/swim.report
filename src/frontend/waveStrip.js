// src/frontend/waveStrip.js
// Pure helpers for the Dark Sky-style wave-height forecast strip on the detail
// page. No fetch, no Date access at module scope beyond Date.parse on the
// caller-supplied ISO strings (the strip is derived from data + nowIso passed
// in by the router — never Date.now()). String concatenation with +, never
// template literals. const/let only.
//
// The 2 ft / 4 ft color thresholds live ONLY in src/rules.js#waveColorForHeight,
// so this strip colors each hour from the exact same numbers the flag estimate
// uses — no restated thresholds here.

import { waveColorForHeight } from "../rules.js";

// Band presentation: label + palette token per waveColorForHeight result.
// null (non-numeric/masked hour) maps to the "no-data" band, which uses the
// same gray token as the "unknown" flag — gray means honest absence, never a
// guessed condition. Yellow uses tint 70 (tint 50 reads olive in the mild
// palette; see PLAN.md section 9).
const BAND_DEFS = {
  "green": { band: "green", label: "Under 2 ft", tokenVar: "var(--wa-color-green-50)" },
  "yellow": { band: "yellow", label: "2-4 ft", tokenVar: "var(--wa-color-yellow-70)" },
  "red": { band: "red", label: "4 ft or more", tokenVar: "var(--wa-color-red-50)" },
  "no-data": { band: "no-data", label: "No data", tokenVar: "var(--wa-color-gray-50)" }
};

// Ordered known-model mapping: model id -> display name. The order here IS the
// display order for the per-model caption, the comparison chart's dataset
// sequence, and the prose summary. Kept local (not imported from src/clients/)
// so a backend id rename can't silently reorder the UI. Unknown ids fall back
// to the raw id and sort after every known model, in payload-key order.
const MODEL_DISPLAY = [
  { id: "ecmwf_wam025", name: "ECMWF" },
  { id: "ncep_gfswave025", name: "NOAA GFS" },
  { id: "meteofrance_wave", name: "Météo-France" }
];

// Precomputed lookups over the fixed MODEL_DISPLAY list: known-id membership
// and id -> display name, so the per-id helpers don't re-scan the array.
const MODEL_IDS = new Set();
const MODEL_NAME_BY_ID = new Map();
for (let i = 0; i < MODEL_DISPLAY.length; i++) {
  MODEL_IDS.add(MODEL_DISPLAY[i].id);
  MODEL_NAME_BY_ID.set(MODEL_DISPLAY[i].id, MODEL_DISPLAY[i].name);
}

// Series colors for the comparison chart, assigned by display position. Blue /
// purple / cyan at a mid tint: deliberately NOT the green/yellow/red flag
// semantics, so a model line can never be misread as a hazard color. Cycles for
// a 4th+ (unknown) model. The <wa-line-chart> component resolves the var() itself.
const MODEL_SERIES_COLORS = [
  "var(--wa-color-blue-60)",
  "var(--wa-color-purple-60)",
  "var(--wa-color-cyan-60)"
];

// Display name for a model id: the mapped name for a known id, else the raw id.
export function modelDisplayName(id) {
  return MODEL_NAME_BY_ID.has(id) ? MODEL_NAME_BY_ID.get(id) : id;
}

// Ordered list of model ids present in a byModel map: known ids first (in
// MODEL_DISPLAY order, only those present), then any unknown ids in their
// original payload-key order. Malformed/missing byModel -> [].
export function orderedModelIds(byModel) {
  const obj = (byModel !== null && typeof byModel === "object") ? byModel : {};
  const ordered = [];
  for (let i = 0; i < MODEL_DISPLAY.length; i++) {
    const id = MODEL_DISPLAY[i].id;
    if (Object.prototype.hasOwnProperty.call(obj, id)) {
      ordered.push(id);
    }
  }
  const keys = Object.keys(obj);
  for (let j = 0; j < keys.length; j++) {
    if (!MODEL_IDS.has(keys[j])) {
      ordered.push(keys[j]);
    }
  }
  return ordered;
}

// True when arr is an array of exactly 24 entries, each null or a number —
// the shape both hoursFt and every per-model raw series must have.
function isNullableNumberArray(arr) {
  if (!Array.isArray(arr) || arr.length !== 24) {
    return false;
  }
  for (let i = 0; i < arr.length; i++) {
    const entry = arr[i];
    if (entry !== null && typeof entry !== "number") {
      return false;
    }
  }
  return true;
}

// True when every entry of arr is null (a slice with nothing to show).
function isAllNull(arr) {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] !== null) {
      return false;
    }
  }
  return true;
}

// Validate + trim the per-model raw-float map that rides alongside hoursFt.
// Accepts only arrays of exactly 24 number|null entries, sliced by the same
// elapsed offset as the main series; drops (never fails on) any model whose
// value is malformed or whose trimmed slice is entirely null. Always returns a
// plain object — a garbage byModel must never block the main strip.
function trimByModel(raw, elapsed) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out = {};
  const keys = Object.keys(raw);
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    const series = raw[key];
    if (!isNullableNumberArray(series)) {
      continue;
    }
    const sliced = series.slice(elapsed);
    if (isAllNull(sliced)) {
      continue;
    }
    out[key] = sliced;
  }
  return out;
}

// Trim a 24-hour wave series down to the hours from "now" forward.
// waves: { startIso, hoursFt: [24 x number|null], byModel?: {...}, ... } | null.
// Returns { hoursFt, totalHours, byModel } or null. Defensive by design: any
// malformed payload degrades to null (section omitted), never a wrong bar.
// byModel is always a plain object (possibly empty); malformed byModel never
// affects hoursFt/totalHours.
export function trimWaveSeries(waves, nowIso) {
  if (waves === null || typeof waves !== "object") {
    return null;
  }
  const startMs = Date.parse(waves.startIso);
  if (Number.isNaN(startMs)) {
    return null;
  }
  const hoursFt = waves.hoursFt;
  if (!isNullableNumberArray(hoursFt)) {
    return null;
  }

  // elapsed whole hours since the series start; NaN (unparseable nowIso) or a
  // negative value (series starts in the future) clamps to 0 (no trim). A
  // series entirely in the past (>= 24 h elapsed) has nothing to show.
  let elapsed = Math.floor((Date.parse(nowIso) - startMs) / 3600000);
  if (Number.isNaN(elapsed) || elapsed < 0) {
    elapsed = 0;
  }
  if (elapsed >= 24) {
    return null;
  }

  const sliced = hoursFt.slice(elapsed);
  if (isAllNull(sliced)) {
    return null;
  }
  return {
    hoursFt: sliced,
    totalHours: sliced.length,
    byModel: trimByModel(waves.byModel, elapsed)
  };
}

// Run-length-encode consecutive hours that share a color band.
// -> [{ band, tokenVar, label, hours }]; the hour counts sum to hoursFt.length.
export function computeWaveRuns(hoursFt) {
  const list = Array.isArray(hoursFt) ? hoursFt : [];
  const runs = [];
  for (let i = 0; i < list.length; i++) {
    const color = waveColorForHeight(list[i]);
    const band = color === null ? "no-data" : color;
    const last = runs.length > 0 ? runs[runs.length - 1] : null;
    if (last && last.band === band) {
      last.hours += 1;
    } else {
      const def = BAND_DEFS[band];
      runs.push({ band: def.band, tokenVar: def.tokenVar, label: def.label, hours: 1 });
    }
  }
  return runs;
}

// Build the Chart.js config for the horizontal stacked strip. Each run is one
// single-bar dataset; the chart type, stacking, and the value-axis min/max all
// come from the <wa-bar-chart> element and its attributes, NOT this config.
// The caller stringifies this.
export function buildWaveChartConfig(runs) {
  const list = Array.isArray(runs) ? runs : [];
  return {
    data: {
      labels: [""],
      datasets: list.map(function (run) {
        return {
          label: run.label,
          data: [run.hours],
          backgroundColor: run.tokenVar,
          barPercentage: 1,
          categoryPercentage: 1
        };
      })
    },
    options: {
      scales: {
        x: { display: false },
        y: { display: false }
      },
      plugins: {
        title: { display: false }
      },
      events: []
    }
  };
}

// "hour" is singular only for a 1-hour run.
function hourWord(n) {
  return n === 1 ? "hour" : "hours";
}

// Lowercase the first character of a band label. The first run keeps its label
// verbatim; every "then" run runs its label through this. Deterministic rule:
// only "Under" and "No data" begin with an uppercase letter, so this yields
// "under" / "no data" while leaving "2-4 ft" and "4 ft or more" (which begin
// with a digit) unchanged.
function lowerFirst(str) {
  if (str.length === 0) {
    return str;
  }
  return str.charAt(0).toLowerCase() + str.slice(1);
}

// Prose summary of the runs for accessibility (the chart's aria description)
// and the pre-upgrade fallback paragraph, e.g.
// "Under 2 ft for 5 hours from now, then 2-4 ft for 3 hours, then no data for
// 2 hours." Empty string for no runs.
export function waveStripSummary(runs) {
  const list = Array.isArray(runs) ? runs : [];
  if (list.length === 0) {
    return "";
  }
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    const run = list[i];
    if (i === 0) {
      parts.push(run.label + " for " + run.hours + " " + hourWord(run.hours) + " from now");
    } else {
      parts.push("then " + lowerFirst(run.label) + " for " + run.hours + " " + hourWord(run.hours));
    }
  }
  return parts.join(", ") + ".";
}

// Defensively read the two fields the model helpers consume from a trimmed
// series: byModel (always a plain object) and totalHours (a number, else 0).
// Any malformed/missing trimmed degrades to { byModel: {}, totalHours: 0 }.
function readTrimmed(trimmed) {
  const isObj = trimmed !== null && typeof trimmed === "object";
  const byModel = (isObj && trimmed.byModel !== null && typeof trimmed.byModel === "object")
    ? trimmed.byModel : {};
  const totalHours = (isObj && typeof trimmed.totalHours === "number")
    ? trimmed.totalHours : 0;
  return { byModel: byModel, totalHours: totalHours };
}

// Models with a finite value at the trimmed now-hour (index 0), in display
// order -> [{ id, name, valueFt }]. Drives the per-model "now" caption and its
// >= 2 gate. trimmed may be null/garbage -> [].
export function modelNowEntries(trimmed) {
  const byModel = readTrimmed(trimmed).byModel;
  const ids = orderedModelIds(byModel);
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const series = byModel[id];
    const v = Array.isArray(series) ? series[0] : null;
    if (typeof v === "number" && isFinite(v)) {
      out.push({ id: id, name: modelDisplayName(id), valueFt: v });
    }
  }
  return out;
}

// Quiet caption text comparing each model's current reading, e.g.
// "ECMWF 2.6 ft · NOAA GFS 2.4 ft · Météo-France 2.9 ft". Only meaningful with
// two or more models finite at the now-hour (a single model just repeats the
// stat) — returns "" for 0-1. Values via toFixed(1), " · " separator.
export function modelNowCaption(trimmed) {
  const entries = modelNowEntries(trimmed);
  if (entries.length < 2) {
    return "";
  }
  const parts = [];
  for (let i = 0; i < entries.length; i++) {
    parts.push(entries[i].name + " " + entries[i].valueFt.toFixed(1) + " ft");
  }
  return parts.join(" · ");
}

// Chart.js line config comparing wave height across models over the trimmed
// window. One dataset per model in display order; values rounded to 1 decimal
// (display only — storage stays raw) so the component's default tooltips read
// cleanly; nulls preserved so spanGaps:false draws honest gaps. Unlike the band
// strip this keeps tooltips + legend (an interactive comparison view). The
// chart type and the "ft" y-axis label come from the <wa-line-chart> element
// and its y-label attribute, NOT this config. The caller stringifies this.
export function buildWaveModelChartConfig(trimmed) {
  const t = readTrimmed(trimmed);
  const byModel = t.byModel;
  const totalHours = t.totalHours;

  const labels = [];
  for (let i = 0; i < totalHours; i++) {
    labels.push(i === 0 ? "Now" : "+" + i + " h");
  }

  const ids = orderedModelIds(byModel);
  const datasets = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const series = Array.isArray(byModel[id]) ? byModel[id] : [];
    const data = [];
    for (let h = 0; h < series.length; h++) {
      const v = series[h];
      data.push((typeof v === "number" && isFinite(v)) ? Math.round(v * 10) / 10 : null);
    }
    const color = MODEL_SERIES_COLORS[i % MODEL_SERIES_COLORS.length];
    datasets.push({
      label: modelDisplayName(id),
      data: data,
      borderColor: color,
      backgroundColor: color,
      pointRadius: 0,
      spanGaps: false
    });
  }

  return {
    data: {
      labels: labels,
      datasets: datasets
    },
    options: {
      plugins: {
        title: { display: false }
      }
    }
  };
}

// Prose summary for the comparison chart's aria description and its pre-upgrade
// fallback paragraph, e.g. "Wave height by model, next 24 hours — ECMWF now
// 2.6 ft, NOAA GFS now 2.4 ft, Météo-France now 2.9 ft." A model that is null
// at the now-hour but has data later reads "ECMWF (no current reading)".
// Deterministic; "" when no models.
export function waveModelSummary(trimmed) {
  const t = readTrimmed(trimmed);
  const byModel = t.byModel;
  const totalHours = t.totalHours;
  const ids = orderedModelIds(byModel);
  if (ids.length === 0) {
    return "";
  }
  const parts = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const name = modelDisplayName(id);
    const series = byModel[id];
    const v = Array.isArray(series) ? series[0] : null;
    if (typeof v === "number" && isFinite(v)) {
      parts.push(name + " now " + v.toFixed(1) + " ft");
    } else {
      parts.push(name + " (no current reading)");
    }
  }
  return "Wave height by model, next " + totalHours + " hours — " +
    parts.join(", ") + ".";
}
