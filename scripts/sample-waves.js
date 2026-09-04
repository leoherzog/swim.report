// scripts/sample-waves.js — turns the downloaded NOAA GRIB2 cycle into the two
// NDJSON artifacts the KV writer consumes. Two modes, both pure local math over
// bytes on disk:
//
//   deno run --allow-read --allow-write scripts/sample-waves.js --mode plan \
//     --dest ./.waves --out ./.waves/band-plan.json
//   deno run --allow-read --allow-write scripts/sample-waves.js --mode sample \
//     --dest ./.waves --planes ./.waves/planes --snapshot snapshot.json --out ./.waves/out
//
// NO --allow-net AND NO --allow-run. GDAL runs in the WORKFLOW SHELL and never from
// here: plan mode reads the gdalinfo JSON the shell captured and says which band of
// which file to extract; sample mode reads the flat ENVI rasters the shell wrote and
// their gdalinfo sidecars. That keeps subprocess permission out of the entire wave
// pipeline, and .github/workflows/test.yml enforces the no-network half.
//
// THE UNITS CONTRACT
// ------------------
// HTSGW is METERS. Feet = meters * 3.28084 (metersToFeet, src/geo.js — never
// re-derived here). WIND is METERS PER SECOND. mph = m/s * 2.2369362920544
// (metersPerSecondToMph, src/waveGrids.js). src/rules.js thresholds are 2 ft yellow
// and 4 ft red, and 15/25 mph; handing it metres makes every sea state below 1.22 m
// read green sitewide and handing it m/s makes an actual 25 mph arrive as 11, with
// no error anywhere in either case.
//
// windGustMph is ALWAYS null: gfswave publishes no GUST field (verified against the
// GFSWAVE .idx variable list DIRPW HTSGW PERPW SWDIR SWELL SWPER UGRD VGRD WDIR WIND
// WVDIR WVHGT WVPER). src/rules.js already renders "n/a" for a null gust. That list
// describes gfswave alone; GLWU is fetched whole and its element set is measured per
// cycle from the gdalinfo sidecar at plan time.
//
// NODATA IS A NUMBER THAT SURVIVES JSON. gfswave uses 9999 and GLWU uses
// 9.999000260554009e+20, both read PER BAND from the gdalinfo sidecar and never
// hardcoded. 9999 m becomes 32808.4 ft and colors a flag RED with a straight-faced
// reason string; a negative sentinel colors it GREEN. src/rules.js tests
// waveHeightFt !== null with no isFinite guard and src/index.js guards with typeof
// === "number" only, so containment is THIS writer's job (isUsableSample in
// src/waveGrids.js) and nothing else's.
//
// THE RESOLVED CELL IS COMPUTED ONCE PER BEACH, FROM THE HOUR-0 WAVE BAND, AND
// REUSED FOR ALL 24 HOURS. The WW3 land mask is fixed for a cycle, and re-running
// the spiral per hour would let hoursFt jump between cells — breaking the
// hoursFt[0] === waveinput.waveHeightFt invariant in a way no test catches
// obviously, and making the detail page's "now" stat contradict its own first bar.
//
// Project style: plain JS, ES modules, const/let only, string concatenation with +
// (never template literals), console for logging.

import {
  GRIDS,
  REQUIRED_GRID_IDS,
  WAVE_ELEMENT,
  WIND_ELEMENT,
  FORECAST_HOURS,
  gridById,
  candidateGrids,
  nearestWetSample,
  sampleAtCell,
  isUsableSample,
  matchesNodata,
  metersPerSecondToMph
} from "../src/waveGrids.js";
import { metersToFeet } from "../src/geo.js";
import { EXPECTED_WAVE_ARTIFACTS } from "../src/waveManifest.js";

// Derived, never re-spelled: the consumer gate takes its download list from
// EXPECTED_WAVE_ARTIFACTS, so a second literal here would be a second source of
// truth for the same two filenames.
const WAVEINPUT_ARTIFACT = EXPECTED_WAVE_ARTIFACTS[0];
const WAVES_ARTIFACT = EXPECTED_WAVE_ARTIFACTS[1];

function log(msg) {
  console.error("sample-waves: " + msg);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseArgs(argv) {
  const args = {
    mode: "sample", dest: "./.waves", planes: null, snapshot: null, out: null
  };
  for (let i = 0; i < argv.length; i = i + 1) {
    const a = argv[i];
    if (a === "--mode") { args.mode = argv[++i]; }
    else if (a === "--dest") { args.dest = argv[++i]; }
    else if (a === "--planes") { args.planes = argv[++i]; }
    else if (a === "--snapshot") { args.snapshot = argv[++i]; }
    else if (a === "--out") { args.out = argv[++i]; }
    else { throw new Error("unknown argument: " + a); }
  }
  if (args.mode !== "plan" && args.mode !== "sample") {
    throw new Error("sample-waves: --mode must be plan or sample");
  }
  if (typeof args.out !== "string" || args.out === "") {
    throw new Error("sample-waves: --out is required");
  }
  if (args.mode === "sample") {
    if (typeof args.planes !== "string" || args.planes === "") {
      throw new Error("sample-waves: --planes is required in sample mode");
    }
    if (typeof args.snapshot !== "string" || args.snapshot === "") {
      throw new Error("sample-waves: --snapshot is required in sample mode");
    }
  }
  return args;
}

// --- gdalinfo parsing (pure) ------------------------------------------------------

// The stable name of one extracted plane, used for the ENVI raster, its sidecar and
// the plan entry alike, so a plan and a directory listing can be compared by eye.
export function planeKey(gridId, hour, element) {
  const hh = hour < 10 ? "0" + String(hour) : String(hour);
  return gridId + "-h" + hh + "-" + element;
}

// GRIB_VALID_TIME arrives as seconds since the epoch, sometimes with a trailing unit
// word depending on the GDAL build. Returns a number or null; never throws.
export function parseGribValidTime(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }
  const first = String(raw).trim().split(/\s+/)[0];
  const n = Number(first);
  return isFiniteNumber(n) ? n : null;
}

// Flattens gdalinfo -json into the per-band facts the gates need. Throws on output
// this code cannot read: a gdalinfo result it cannot parse is a raster it cannot
// vouch for, and the one outcome worse than refusing is guessing a band index.
export function gdalinfoBands(info, what) {
  if (!isPlainObject(info) || !Array.isArray(info.bands)) {
    throw new Error("sample-waves: " + what + ": gdalinfo output has no bands array");
  }
  const out = [];
  for (let i = 0; i < info.bands.length; i = i + 1) {
    const band = info.bands[i];
    if (!isPlainObject(band)) { continue; }
    const meta = isPlainObject(band.metadata) && isPlainObject(band.metadata[""])
      ? band.metadata[""]
      : {};
    out.push({
      band: isFiniteNumber(band.band) ? band.band : i + 1,
      element: typeof meta.GRIB_ELEMENT === "string" ? meta.GRIB_ELEMENT : null,
      validTime: parseGribValidTime(meta.GRIB_VALID_TIME),
      nodata: isFiniteNumber(band.noDataValue) ? band.noDataValue : null
    });
  }
  return out;
}

// The sampled raster's geometry, straight from gdalinfo's own size and geoTransform.
//
// ENVI's "map info" header is deliberately NOT parsed: its tie point is 1-INDEXED
// and refers to a pixel CORNER, so reading it is a half-cell error waiting to
// happen. gdalinfo's geoTransform is the same six numbers GDAL itself used.
export function headerFromInfo(info, what) {
  if (!isPlainObject(info) || !Array.isArray(info.size) || !Array.isArray(info.geoTransform)) {
    throw new Error("sample-waves: " + what + ": gdalinfo output has no size/geoTransform");
  }
  const gt = info.geoTransform;
  const band = Array.isArray(info.bands) && isPlainObject(info.bands[0]) ? info.bands[0] : {};
  return {
    width: info.size[0],
    height: info.size[1],
    originLon: gt[0],
    pixelLon: gt[1],
    originLat: gt[3],
    pixelLat: gt[5],
    nodata: isFiniteNumber(band.noDataValue) ? band.noDataValue : null
  };
}

// --- plan mode -------------------------------------------------------------------

// The per-grid verdict threaded band-plan.json -> sample-report.json -> manifest.json,
// carrying ONE entry for EVERY grid in GRIDS whatever the cycle contained.
//
// That completeness is the contract. An absent entry would let the build gate's
// per-grid floor silently skip a grid that under-covered, and an entry claiming a
// status a grid never reached would score an absent grid as a shrink to zero and
// refuse the whole cycle — including the grids that sampled cleanly.
//
//   unfetched — no grids-report entry, so the fetch never produced this grid
//   unplanned — fetched but not usable for waves; contributes no planes and no records
//   planned   — every hour's HTSGW band located; elements says whether WIND survived too
export function emptyGridStatus() {
  const out = {};
  for (let i = 0; i < GRIDS.length; i = i + 1) {
    out[GRIDS[i].id] = { status: "unfetched", elements: [], reasons: [] };
  }
  return out;
}

// For each enabled grid and each of the 24 forecast hours, name the source file and
// the BAND INDEX carrying that hour's HTSGW and WIND, plus the GRIB_VALID_TIME the
// gate will assert against validStartEpoch + hour*3600.
//
// Band indices are DISCOVERED from gdalinfo, never assumed: GLWU is one file of 931
// bands (49 steps x 19 elements) and the stepped grids are two-record concatenations
// whose order mirrors ascending byte offset. Assuming either layout is how an .idx
// off-by-one becomes a complete, plausible, silently time-shifted series.
export function planFor(gridsReport, infoByFile, validStartEpoch) {
  const entries = [];
  const problems = [];
  const gridStatus = emptyGridStatus();
  if (!isPlainObject(gridsReport) || !isPlainObject(gridsReport.grids)) {
    return {
      entries: entries,
      problems: ["grids-report.json has no grids block"],
      gridStatus: gridStatus
    };
  }
  const gridIds = Object.keys(gridsReport.grids);
  for (let g = 0; g < gridIds.length; g = g + 1) {
    const gridId = gridIds[g];
    const grid = gridById(gridId);
    const entry = gridsReport.grids[gridId];
    const status = gridStatus[gridId];
    if (grid === null || !isPlainObject(entry) || !Array.isArray(entry.files)) {
      const message = gridId + ": grids-report entry is unusable";
      problems.push(message);
      if (status !== undefined) {
        status.status = "unplanned";
        status.reasons.push(message);
      }
      continue;
    }
    // The workflow shell marks a grid unusable after the fact — a gdalinfo sweep or a
    // band extraction that failed for it. An absent usable field means true.
    if (entry.usable === false) {
      const message = gridId + ": " + (typeof entry.unusableReason === "string" &&
        entry.unusableReason !== "" ? entry.unusableReason : "marked unusable by the workflow");
      problems.push(message);
      status.status = "unplanned";
      status.reasons.push(message);
      continue;
    }
    const gridEntries = [];
    const waveProblems = [];
    const windProblems = [];
    for (let hour = 0; hour < FORECAST_HOURS; hour = hour + 1) {
      const wantTime = validStartEpoch + hour * 3600;
      // A stepped grid has one file per hour; a whole-file grid has one file for all
      // of them and the hour is found by valid time.
      const file = entry.files.length === 1 ? entry.files[0] : entry.files[hour];
      if (!isPlainObject(file)) {
        const message = gridId + " hour " + String(hour) + ": no source file";
        problems.push(message);
        waveProblems.push(message);
        windProblems.push(message);
        continue;
      }
      const path = entry.dir + "/" + file.name;
      const info = infoByFile[path];
      if (info === undefined) {
        const message = gridId + " hour " + String(hour) + ": no gdalinfo for " + path;
        problems.push(message);
        waveProblems.push(message);
        windProblems.push(message);
        continue;
      }
      const bands = gdalinfoBands(info, path);
      const elements = [WAVE_ELEMENT, WIND_ELEMENT];
      for (let e = 0; e < elements.length; e = e + 1) {
        const element = elements[e];
        let match = null;
        for (let b = 0; b < bands.length; b = b + 1) {
          if (bands[b].element !== element) { continue; }
          if (bands[b].validTime !== wantTime) { continue; }
          match = bands[b];
          break;
        }
        if (match === null) {
          const message = gridId + " hour " + String(hour) + ": " + path +
            " carries no " + element + " band at valid time " + String(wantTime);
          problems.push(message);
          if (element === WAVE_ELEMENT) { waveProblems.push(message); }
          else { windProblems.push(message); }
          continue;
        }
        gridEntries.push({
          gridId: gridId,
          hour: hour,
          element: element,
          sourceFile: path,
          band: match.band,
          validTime: match.validTime,
          expectedValidTime: wantTime,
          nodata: match.nodata,
          key: planeKey(gridId, hour, element),
          warp: grid.warp
        });
      }
    }
    // The element requirement splits in ONE direction only. A grid missing HTSGW at any
    // hour contributes nothing at all, because a wind-only record from a grid whose wave
    // plane was never proven is a wave lane nobody can audit. A grid missing only WIND
    // still carries its waves: WIND is read at exactly one place — the hour-0 wind plane
    // behind the wave-null fallback — so losing it costs that grid's beaches the fallback
    // and nothing else.
    if (waveProblems.length > 0) {
      status.status = "unplanned";
      status.reasons = status.reasons.concat(waveProblems);
      continue;
    }
    status.status = "planned";
    const keepWind = windProblems.length === 0;
    status.elements = keepWind ? [WAVE_ELEMENT, WIND_ELEMENT] : [WAVE_ELEMENT];
    if (!keepWind) {
      status.reasons = status.reasons.concat(windProblems);
    }
    for (let i = 0; i < gridEntries.length; i = i + 1) {
      if (!keepWind && gridEntries[i].element === WIND_ELEMENT) { continue; }
      entries.push(gridEntries[i]);
    }
  }
  return { entries: entries, problems: problems, gridStatus: gridStatus };
}

// The two refusals the plan step applies, as one pure decision.
//
// Everything else a grid can do wrong costs THAT grid's beaches their waves and
// nothing more. These two are different in kind: an empty plan has nothing to sample
// at all, and a grid in REQUIRED_GRID_IDS that did not reach "planned" means the
// beaches this pipeline exists to cover would get nothing, so the cycle is refused
// rather than published thin. Returns the refusal text, or null to proceed.
export function planRefusal(entries, gridStatus) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "no grid could be planned";
  }
  for (let i = 0; i < REQUIRED_GRID_IDS.length; i = i + 1) {
    const required = REQUIRED_GRID_IDS[i];
    const status = isPlainObject(gridStatus) ? gridStatus[required] : undefined;
    if (!isPlainObject(status) || status.status !== "planned") {
      return "required grid " + required + " is " +
        (isPlainObject(status) ? String(status.status) : "absent from the plan");
    }
  }
  return null;
}

// --- sample mode -----------------------------------------------------------------

// The record pair for ONE beach, carrying both write-skip guards:
//
//   wave null AND wind null -> NO record at all, so the previous KV key rides its
//                              lease and the flag ages out to unknown rather than
//                              being recoloured from nothing.
//   wave null, wind present -> a waveinput record only, no series.
//
// The wind is a FALLBACK and is recorded ONLY for a wave-null beach, which is what
// keeps src/index.js's "Wind Forecast" source attribution honest: it pushes that
// source exactly when waveHeightFt is null.
//
// hoursFt[0] and waveHeightFt are the SAME conversion of the SAME sample, computed
// once and written twice.
export function waveRecordsForBeach(input) {
  const hoursM = Array.isArray(input.waveMeters) ? input.waveMeters : null;
  const hoursFt = [];
  if (hoursM !== null) {
    for (let i = 0; i < hoursM.length; i = i + 1) {
      hoursFt.push(isFiniteNumber(hoursM[i]) ? metersToFeet(hoursM[i]) : null);
    }
  }
  const waveHeightFt = hoursFt.length > 0 && hoursFt[0] !== null ? hoursFt[0] : null;
  const windSpeedMph = waveHeightFt === null && isFiniteNumber(input.windMs)
    ? metersPerSecondToMph(input.windMs)
    : null;

  if (waveHeightFt === null && windSpeedMph === null) {
    return { waveinput: null, waves: null };
  }

  const waveinput = {
    beachId: input.beachId,
    waveHeightFt: waveHeightFt,
    model: waveHeightFt === null ? null : input.gridId,
    windSpeedMph: windSpeedMph,
    // gfswave publishes no GUST element, so this is permanently null and the wind
    // red rule narrows to speed alone. The branch only fires when waveHeightFt is
    // null, which under GRIB is rare.
    windGustMph: null,
    updated: input.updated
  };

  let hasFinite = false;
  for (let i = 0; i < hoursFt.length; i = i + 1) {
    if (hoursFt[i] !== null) { hasFinite = true; break; }
  }
  if (!hasFinite) {
    return { waveinput: waveinput, waves: null };
  }

  const byModel = {};
  byModel[input.gridId] = hoursFt;
  const waves = {
    beachId: input.beachId,
    startIso: input.startIso,
    hoursFt: hoursFt,
    models: [input.gridId],
    byModel: byModel,
    sources: [{ label: input.label, url: input.infoUrl }],
    updated: input.updated
  };
  return { waveinput: waveinput, waves: waves };
}

// The sample report's per-grid verdict: the plan's gridStatus carried forward, with a
// grid upgraded to "sampled" only when it actually produced a stats entry.
//
// A planned grid that produced no stats is reported "unplanned", never "sampled" with
// zeroes: the build gate scores a per-grid floor against what a grid claims to have
// measured, and a phantom zero would refuse the whole cycle on behalf of a grid that
// never ran.
export function sampleGridStatus(planStatus, stats) {
  const out = emptyGridStatus();
  const ids = Object.keys(out);
  for (let i = 0; i < ids.length; i = i + 1) {
    const id = ids[i];
    const planned = isPlainObject(planStatus) ? planStatus[id] : undefined;
    if (isPlainObject(planned)) {
      out[id] = {
        status: typeof planned.status === "string" ? planned.status : "unfetched",
        elements: Array.isArray(planned.elements) ? planned.elements.slice() : [],
        reasons: Array.isArray(planned.reasons) ? planned.reasons.slice() : []
      };
    }
    const sampled = isPlainObject(stats) && isPlainObject(stats[id]);
    if (out[id].status === "planned") {
      if (sampled) {
        out[id].status = "sampled";
      } else {
        out[id].status = "unplanned";
        out[id].reasons.push(id + ": planned but produced no sampled plane");
      }
      continue;
    }
    if (sampled) {
      out[id].status = "sampled";
      out[id].reasons.push(id + ": sampled without a plan gridStatus entry");
    }
  }
  return out;
}

// Median of a numeric list, or null when empty. Used only for the report's
// medianSearchKm, whose collapse is an early symptom of a shifted geotransform.
export function medianOf(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Fraction of a plane's cells carrying a usable value. A grid whose wet fraction
// collapses is either masked wrong or georeferenced wrong, and neither shows up as
// an error anywhere else.
export function validFractionOf(header, data) {
  if (!isPlainObject(header) || !data || data.length === 0) {
    return 0;
  }
  let usable = 0;
  for (let i = 0; i < data.length; i = i + 1) {
    if (isUsableSample(data[i], header.nodata)) { usable = usable + 1; }
  }
  return usable / data.length;
}

// The plane keys this run READ for one grid, hour-ordered by construction of the key.
export function planeKeysFor(planeInfo, gridId) {
  const out = [];
  if (!isPlainObject(planeInfo)) {
    return out;
  }
  const prefix = String(gridId) + "-h";
  const keys = Object.keys(planeInfo);
  for (let i = 0; i < keys.length; i = i + 1) {
    if (keys[i].indexOf(prefix) === 0) { out.push(keys[i]); }
  }
  return out.sort();
}

// Every plane of one grid must describe the same raster as its hour-0 wave plane.
// Hour 0 proves nothing about hour 7: noaa_gfswave downloads ONE file per forecast
// hour and each plane's geotransform comes from that file, so a shifted origin
// decodes, samples and gates cleanly while reading the wrong cells.
//
// Returns one message per mismatched field, in the shape the build gate's refusals
// already speak; an empty list is a grid whose planes agree.
export function planeIdentityMismatches(planeInfo, gridId, reference) {
  const out = [];
  const keys = planeKeysFor(planeInfo, gridId);
  if (!isPlainObject(reference)) {
    for (let i = 0; i < keys.length; i = i + 1) {
      out.push(keys[i] + ": no hour-0 wave header to compare against");
    }
    return out;
  }
  const fields = ["width", "height", "originLon", "originLat", "pixelLon", "pixelLat"];
  for (let i = 0; i < keys.length; i = i + 1) {
    const key = keys[i];
    const observed = planeInfo[key];
    if (!isPlainObject(observed)) {
      out.push(key + ": the plane carries no decoded header");
      continue;
    }
    for (let f = 0; f < fields.length; f = f + 1) {
      if (observed[fields[f]] !== reference[fields[f]]) {
        out.push(key + ": " + fields[f] + " is " + String(observed[fields[f]]) +
          ", expected " + String(reference[fields[f]]));
      }
    }
    // Relative, like the build gate: gdalinfo prints a large sentinel rounded, so an
    // equality test would report a mismatch for a formatting difference.
    if (!matchesNodata(observed.nodata, reference.nodata)) {
      out.push(key + ": nodata is " + String(observed.nodata) +
        ", expected " + String(reference.nodata));
    }
  }
  return out;
}

// --- I/O helpers (main only) ---------------------------------------------------------

async function readJson(path) {
  return JSON.parse(await Deno.readTextFile(path));
}

// One ENVI plane as a Float32Array over the raw bytes.
//
// Byte order is the runner's native little-endian, which is what GDAL's ENVI driver
// writes by default and what Float32Array reads. A byte-swapped plane would not fail
// here — it would produce absurd magnitudes, which is exactly what the sentinel,
// mean-plausibility and distinct-value gates in scripts/build-wave-manifest.js exist
// to refuse.
async function readPlane(path, header, what) {
  const bytes = await Deno.readFile(path);
  const expected = header.width * header.height * 4;
  if (bytes.length !== expected) {
    throw new Error("sample-waves: " + what + ": expected " + String(expected) +
      " bytes, got " + String(bytes.length));
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, header.width * header.height);
}

// The beach snapshot as wrangler d1 execute --json returns it: an array of result
// envelopes. Rows missing a finite lat/lon are dropped with a problem rather than
// sampled at (0, 0).
export function beachesFromSnapshot(parsed) {
  let rows = [];
  if (Array.isArray(parsed)) {
    for (let i = 0; i < parsed.length; i = i + 1) {
      if (isPlainObject(parsed[i]) && Array.isArray(parsed[i].results)) {
        rows = rows.concat(parsed[i].results);
      }
    }
  } else if (isPlainObject(parsed) && Array.isArray(parsed.results)) {
    rows = parsed.results;
  } else if (isPlainObject(parsed) && Array.isArray(parsed.rows)) {
    rows = parsed.rows;
  }
  const out = [];
  for (let i = 0; i < rows.length; i = i + 1) {
    const row = rows[i];
    if (!isPlainObject(row) || typeof row.id !== "string") { continue; }
    if (!isFiniteNumber(row.lat) || !isFiniteNumber(row.lon)) { continue; }
    out.push({
      id: row.id,
      lat: row.lat,
      lon: row.lon,
      water_class: row.water_class === undefined ? null : row.water_class
    });
  }
  return out;
}

async function runPlan(args) {
  const gridsReport = await readJson(args.dest + "/grids-report.json");
  const infoByFile = {};
  const gridIds = Object.keys(gridsReport.grids || {});
  for (let g = 0; g < gridIds.length; g = g + 1) {
    const entry = gridsReport.grids[gridIds[g]];
    // A grid the shell already marked unusable is not read at all: its sidecars may be
    // truncated or missing, and planFor unplans it from the marking alone.
    if (!isPlainObject(entry) || !Array.isArray(entry.files) || entry.usable === false) {
      continue;
    }
    for (let f = 0; f < entry.files.length; f = f + 1) {
      const path = entry.dir + "/" + entry.files[f].name;
      try {
        infoByFile[path] = await readJson(path + ".info.json");
      } catch (err) {
        // An unreadable sidecar leaves a gap planFor reads as "no gdalinfo", which
        // unplans that grid and leaves every other grid alone.
        log("PROBLEM " + gridIds[g] + ": cannot read " + path + ".info.json: " +
          (err && err.message ? err.message : String(err)));
      }
    }
  }
  const plan = planFor(gridsReport, infoByFile, gridsReport.validStartEpoch);
  for (let i = 0; i < plan.problems.length; i = i + 1) {
    log("PROBLEM " + plan.problems[i]);
  }
  // A grid that could not be planned costs ITS beaches their waves and nothing more.
  // Refusing the whole cycle for one grid's unexpected file takes down every other
  // grid's beaches too, which is more data lost, not less.
  const statusIds = Object.keys(plan.gridStatus);
  for (let i = 0; i < statusIds.length; i = i + 1) {
    const status = plan.gridStatus[statusIds[i]];
    if (status.status === "planned" && status.reasons.length === 0) { continue; }
    log("PROBLEM " + statusIds[i] + " " + status.status + " (elements " +
      (status.elements.length === 0 ? "none" : status.elements.join(",")) + "): " +
      (status.reasons.length === 0 ? "no grids-report entry" : status.reasons.join("; ")));
  }
  const refusal = planRefusal(plan.entries, plan.gridStatus);
  if (refusal !== null) {
    throw new Error("sample-waves: " + refusal +
      " — refusing to sample a cycle whose bands are unproven");
  }
  const doc = {
    validStartIso: gridsReport.validStartIso,
    validStartEpoch: gridsReport.validStartEpoch,
    gridsComplete: gridsReport.gridsComplete === true,
    requiredGridIds: REQUIRED_GRID_IDS.slice(),
    gridStatus: plan.gridStatus,
    entries: plan.entries
  };
  await Deno.writeTextFile(args.out, JSON.stringify(doc, null, 2) + "\n");
  log("planned " + String(plan.entries.length) + " band(s) -> " + args.out);
}

async function runSample(args) {
  const plan = await readJson(args.dest + "/band-plan.json");
  const beaches = beachesFromSnapshot(await readJson(args.snapshot));
  const validStartEpoch = plan.validStartEpoch;
  const startIso = new Date(validStartEpoch * 1000).toISOString();
  // startIso AND updated are the model VALID START, never the run clock: a cycle
  // published late must not be able to claim it is fresher than its own data.
  const updated = startIso;
  log("beaches " + String(beaches.length) + ", validStart " + startIso);

  // Object.create(null) throughout: these are keyed by beach id and plane key, both of
  // which are upstream strings, and a row named __proto__ must not silently vanish.
  const byKey = Object.create(null);
  for (let i = 0; i < plan.entries.length; i = i + 1) {
    byKey[plan.entries[i].key] = plan.entries[i];
  }

  const planeInfo = Object.create(null);
  async function loadPlane(key) {
    const entry = byKey[key];
    if (entry === undefined) {
      return null;
    }
    const base = args.planes + "/" + key;
    const info = await readJson(base + ".info.json");
    const header = headerFromInfo(info, key);
    const data = await readPlane(base + ".img", header, key);
    planeInfo[key] = header;
    return { header: header, data: data };
  }

  const gridIds = [];
  for (let i = 0; i < GRIDS.length; i = i + 1) {
    if (byKey[planeKey(GRIDS[i].id, 0, WAVE_ELEMENT)] !== undefined) {
      gridIds.push(GRIDS[i].id);
    }
  }

  // Pass 1 — ordered fallthrough. One hour-0 wave plane per grid, resident one at a
  // time; every beach the earlier grids could not resolve is offered to the next.
  const assignment = Object.create(null);
  const stats = Object.create(null);
  let unresolved = beaches.slice();
  for (let g = 0; g < gridIds.length; g = g + 1) {
    const grid = gridById(gridIds[g]);
    const plane = await loadPlane(planeKey(grid.id, 0, WAVE_ELEMENT));
    const searchKms = [];
    let ring0 = 0;
    let assigned = 0;
    let considered = 0;
    const stillUnresolved = [];
    for (let b = 0; b < unresolved.length; b = b + 1) {
      const beach = unresolved[b];
      const allowed = candidateGrids(beach, [grid]);
      if (allowed.length === 0) {
        stillUnresolved.push(beach);
        continue;
      }
      considered = considered + 1;
      const hit = nearestWetSample(grid, plane.header, plane.data, beach.lat, beach.lon);
      if (hit === null) {
        stillUnresolved.push(beach);
        continue;
      }
      assignment[beach.id] = {
        gridId: grid.id, row: hit.row, col: hit.col,
        distanceKm: hit.distanceKm, ring: hit.ring
      };
      searchKms.push(hit.distanceKm);
      if (hit.ring === 0) { ring0 = ring0 + 1; }
      assigned = assigned + 1;
    }
    stats[grid.id] = {
      assignedBeaches: considered,
      resolvedBeaches: assigned,
      // Filled in by the emit loop below, so a per-grid floor is scored against the
      // records a grid actually produced rather than against the whole cycle's total.
      waveinputRecords: 0,
      wavesRecords: 0,
      validPercent: validFractionOf(plane.header, plane.data) * 100,
      ring0Fraction: assigned > 0 ? ring0 / assigned : 0,
      medianSearchKm: medianOf(searchKms),
      maxSearchKm: searchKms.length > 0 ? Math.max.apply(null, searchKms) : null,
      identity: planeInfo[planeKey(grid.id, 0, WAVE_ELEMENT)]
    };
    log(grid.id + ": considered " + String(considered) + ", resolved " + String(assigned) +
      ", validPercent " + stats[grid.id].validPercent.toFixed(2) +
      ", ring0Fraction " + stats[grid.id].ring0Fraction.toFixed(3));
    unresolved = stillUnresolved;
  }

  // Pass 2 — wind fallback for beaches with no wet WAVE cell. WIND shares the wave
  // model's land mask, so this is expected to be nearly empty; it exists because the
  // Worker's read contract has a wind-only branch and dropping it would be a silent
  // narrowing of that contract.
  const windOnly = Object.create(null);
  for (let g = 0; g < gridIds.length && unresolved.length > 0; g = g + 1) {
    const grid = gridById(gridIds[g]);
    const plane = await loadPlane(planeKey(grid.id, 0, WIND_ELEMENT));
    if (plane === null) { continue; }
    const stillUnresolved = [];
    for (let b = 0; b < unresolved.length; b = b + 1) {
      const beach = unresolved[b];
      if (candidateGrids(beach, [grid]).length === 0) {
        stillUnresolved.push(beach);
        continue;
      }
      const hit = nearestWetSample(grid, plane.header, plane.data, beach.lat, beach.lon);
      if (hit === null) {
        stillUnresolved.push(beach);
        continue;
      }
      windOnly[beach.id] = { gridId: grid.id, windMs: hit.value };
    }
    unresolved = stillUnresolved;
  }

  // Pass 3 — the 24 hourly wave planes, one resident at a time, read at each
  // assigned beach's ALREADY RESOLVED cell.
  const hoursByBeach = Object.create(null);
  const ids = Object.keys(assignment);
  for (let i = 0; i < ids.length; i = i + 1) {
    hoursByBeach[ids[i]] = new Array(FORECAST_HOURS).fill(null);
  }
  for (let g = 0; g < gridIds.length; g = g + 1) {
    const gridId = gridIds[g];
    let assignedHere = 0;
    for (let i = 0; i < ids.length; i = i + 1) {
      if (assignment[ids[i]].gridId === gridId) { assignedHere = assignedHere + 1; }
    }
    if (assignedHere === 0) {
      continue;
    }
    for (let hour = 0; hour < FORECAST_HOURS; hour = hour + 1) {
      const plane = await loadPlane(planeKey(gridId, hour, WAVE_ELEMENT));
      if (plane === null) { continue; }
      for (let i = 0; i < ids.length; i = i + 1) {
        const cell = assignment[ids[i]];
        if (cell.gridId !== gridId) { continue; }
        hoursByBeach[ids[i]][hour] = sampleAtCell(plane.header, plane.data, cell.row, cell.col);
      }
    }
  }

  // Every plane this run READ is compared against its own grid's hour-0 wave raster,
  // which is the only comparison that can see an hour whose geotransform moved.
  // Pass 3 skips a grid with no beaches assigned to it, so its hourly planes were
  // never read and are never compared: the set compared is exactly the set that
  // contributed a value.
  const identityIds = Object.keys(stats);
  for (let i = 0; i < identityIds.length; i = i + 1) {
    const id = identityIds[i];
    stats[id].identityPlanes = planeKeysFor(planeInfo, id).length;
    stats[id].identityMismatches = planeIdentityMismatches(planeInfo, id, stats[id].identity);
    if (stats[id].identityMismatches.length > 0) {
      log(id + ": " + String(stats[id].identityMismatches.length) +
        " plane(s) disagree with the hour-0 wave raster");
    }
  }

  // Emit.
  const waveinputLines = [];
  const wavesLines = [];
  let waveRecords = 0;
  let wavesRecords = 0;
  let windOnlyRecords = 0;
  for (let b = 0; b < beaches.length; b = b + 1) {
    const beach = beaches[b];
    const cell = assignment[beach.id];
    const wind = windOnly[beach.id];
    const gridId = cell !== undefined ? cell.gridId : (wind !== undefined ? wind.gridId : null);
    if (gridId === null) { continue; }
    const grid = gridById(gridId);
    const records = waveRecordsForBeach({
      beachId: beach.id,
      gridId: gridId,
      label: grid.label,
      infoUrl: grid.infoUrl,
      startIso: startIso,
      updated: updated,
      waveMeters: cell !== undefined ? hoursByBeach[beach.id] : null,
      windMs: wind !== undefined ? wind.windMs : null
    });
    // Attribution is the grid that resolved THIS beach's cell (or, for a wave-null
    // beach, its wind cell). Crediting a record to any other grid would inflate that
    // grid's counts and let a real shrink pass its own floor.
    const gridStats = stats[gridId];
    if (records.waveinput !== null) {
      waveinputLines.push(JSON.stringify(records.waveinput));
      waveRecords = waveRecords + 1;
      if (gridStats !== undefined) {
        gridStats.waveinputRecords = gridStats.waveinputRecords + 1;
      }
      if (records.waveinput.waveHeightFt === null) { windOnlyRecords = windOnlyRecords + 1; }
    }
    if (records.waves !== null) {
      wavesLines.push(JSON.stringify(records.waves));
      wavesRecords = wavesRecords + 1;
      if (gridStats !== undefined) {
        gridStats.wavesRecords = gridStats.wavesRecords + 1;
      }
    }
  }

  await Deno.mkdir(args.out, { recursive: true });
  await Deno.writeTextFile(args.out + "/" + WAVEINPUT_ARTIFACT,
    waveinputLines.length > 0 ? waveinputLines.join("\n") + "\n" : "");
  await Deno.writeTextFile(args.out + "/" + WAVES_ARTIFACT,
    wavesLines.length > 0 ? wavesLines.join("\n") + "\n" : "");

  const bands = [];
  for (let i = 0; i < plan.entries.length; i = i + 1) {
    const e = plan.entries[i];
    bands.push({
      gridId: e.gridId, hour: e.hour, element: e.element, band: e.band,
      validTime: e.validTime, expectedValidTime: e.expectedValidTime,
      sourceFile: e.sourceFile, nodata: e.nodata
    });
  }
  const gridStatus = sampleGridStatus(plan.gridStatus, stats);
  const statusIds = Object.keys(gridStatus);
  for (let i = 0; i < statusIds.length; i = i + 1) {
    if (gridStatus[statusIds[i]].status === "sampled") { continue; }
    log(statusIds[i] + ": " + gridStatus[statusIds[i]].status +
      ", no records — its beaches age out to unknown this cycle");
  }

  const report = {
    generated: new Date().toISOString(),
    validStartIso: plan.validStartIso,
    validStartEpoch: validStartEpoch,
    startIso: startIso,
    gridsComplete: plan.gridsComplete === true,
    gridStatus: gridStatus,
    beaches: {
      total: beaches.length,
      resolved: ids.length,
      windOnly: windOnlyRecords,
      unresolved: unresolved.length,
      waveinputRecords: waveRecords,
      wavesRecords: wavesRecords
    },
    grids: stats,
    bands: bands
  };
  await Deno.writeTextFile(args.out + "/sample-report.json",
    JSON.stringify(report, null, 2) + "\n");
  log("wrote " + String(waveRecords) + " waveinput and " + String(wavesRecords) +
    " waves record(s) to " + args.out);
}

async function main() {
  const args = parseArgs(Deno.args);
  if (args.mode === "plan") {
    await runPlan(args);
    return;
  }
  await runSample(args);
}

if (import.meta.main) {
  main().catch(function (err) {
    console.error("sample-waves: FATAL: " + (err && err.stack ? err.stack : err));
    Deno.exit(1);
  });
}
