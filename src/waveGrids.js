// src/waveGrids.js — the NOAA GRIB2 wave grids the offline pipeline samples,
// plus the pure geometry over them: grid selection, the nearest-wet-cell search and
// the m/s -> mph conversion the GRIB path needs.
//
// Offline only. Nothing in the Worker's import closure may import this module: it
// exists for scripts/sample-waves.js and scripts/build-wave-manifest.js, which run
// on Deno inside .github/workflows/waves.yml. The Worker request path reads only
// D1 and KV, and the cron path reads the KV this pipeline writes.
//
// The units contract. HTSGW is metres; feet = metres * 3.28084 (metersToFeet,
// src/geo.js). WIND is metres per second; mph = m/s * 2.2369362920544
// (METERS_PER_SECOND_TO_MPH below). Feeding m/s straight into src/rules.js makes
// an actual 25 mph arrive as 11, so every wind reads green with no error
// anywhere.
//
// nodata is a number that survives JSON: gfswave uses 9999 and GLWU uses
// 9.999000260554009e+20. Both are read per band from the gdalinfo sidecar and
// never hardcoded at a sample site — 9999 m is 32808.4 ft and colors a flag red
// with a straight-faced reason string, so every candidate is screened here before
// it can reach a record. A masked cell is not always a sentinel either: the NWPS
// nest's WIND plane reads 0 m/s over land, so whether a cell is wet is a question
// only HTSGW can answer.

import { distanceKm, KM_PER_DEG } from "./geo.js";

// m/s -> mph. Exact ratio: 3600 / 1609.344.
export const METERS_PER_SECOND_TO_MPH = 2.2369362920544;

// Metres per second -> miles per hour. Null-safe in the same shape as
// metersToFeet in src/geo.js: null/undefined pass through as null, which is the
// masked/no-data convention every wave record uses.
export function metersPerSecondToMph(ms) {
  if (ms === null || ms === undefined) {
    return null;
  }
  return ms * METERS_PER_SECOND_TO_MPH;
}

// Containment rails applied to every sampled value before it can become a record.
// Deliberately generous: they catch a sentinel or a garbage plane, they do not
// second-guess a model.
const MAX_PLAUSIBLE_SAMPLE = 9000;
const MIN_PLAUSIBLE_SAMPLE = 0;

// The two GRIB elements sliced out of every cycle. gfswave publishes no GUST
// element, which is why windGustMph is permanently null on this pipeline. GLWU is
// fetched whole and never touches an .idx, so its element set is measured per
// cycle from the gdalinfo sidecar at plan time.
export const WAVE_ELEMENT = "HTSGW";
export const WIND_ELEMENT = "WIND";
export const GRID_ELEMENTS = [WIND_ELEMENT, WAVE_ELEMENT];

// The 24 forecast hours every cycle must cover: hoursFt is exactly 24 entries or
// src/frontend/waveStrip.js drops the whole strip.
export const FORECAST_HOURS = 24;

// The grids, in fallthrough order. wcoast.0p16, atlocn.0p16, epacif.0p16 and
// global.0p25 are deliberately absent: global.0p16 supersedes the first three and
// closes the coverage gap between wcoast's -109.917 edge and atlocn's -100.083
// edge, which matters because this repo builds layers for us/canada/mexico, and
// epacif is a 0-360 longitude grid on which a real Hawaii longitude silently
// samples as empty.
//
// noaa_nwps_sew is last, so it is offered only the beaches global.0p16 masked. An
// earlier position would move thousands of beaches to a different model while the
// floors seeded under the current assignment still validate.
//
// sampled{} describes the raster the workflow hands to scripts/sample-waves.js,
// after the shell's gdal_translate (gfswave and nwps, both already lat/lon) or
// gdalwarp (glwu and arctic, both projected). Sampling every grid in one lat/lon frame keeps
// nearestWetSample free of projection math. -r near is mandatory on the warp,
// because any interpolating resampler smears wave values across the land mask and
// manufactures readings on shore.
export const GRIDS = [
  {
    id: "noaa_glwu",
    source: "nomads",
    label: "NOAA Great Lakes Wave Model",
    infoUrl: "https://www.weather.gov/greatlakes/",
    // NOMADS documents a 10 second wait between scripted fetches, so this grid is
    // one whole-file fetch: all 49 forecast steps in a single ~22 MB object.
    fetchMode: "whole",
    urlTemplate: "https://nomads.ncep.noaa.gov/pub/data/nccf/com/glwu/prod/" +
      "glwu.{YYYYMMDD}/glwu.grlc_2p5km_sr.t{HH}z.grib2",
    // grlc_2p5km_sr, not grlc_2p5km_lc_sr: the lc variant is the much smaller
    // lake-connecting-channels grid and covers none of the open lake.
    variables: GRID_ELEMENTS,
    // Great Lakes fetch is hourly with ~6 minutes of publish latency, and one file
    // carries 49 steps, so a cycle up to 25 h old still covers a 24 h window.
    cycleStepHours: 1,
    maxCycleAgeHours: 25,
    forecastSteps: 49,
    // Lambert 2SP 581x361 at 2539.703 m, warped to a plain lat/lon raster.
    warp: {
      targetSrs: "EPSG:4326",
      te: [-93.0, 40.3, -74.0, 49.4],
      tr: [0.02, 0.02],
      resample: "near"
    },
    sampled: {
      width: 950,
      height: 455,
      originLon: -93.0,
      originLat: 49.4,
      pixelLon: 0.02,
      pixelLat: -0.02,
      nodata: 9.999000260554009e+20
    },
    domain: { minLon: -93.0, minLat: 40.3, maxLon: -74.0, maxLat: 49.4 },
    // Tighter than the ocean cap because the lakes are resolved at 2.5 km and a
    // 25 km reach would cross from one lake to another at the straits.
    searchMaxKm: 10,
    // water_class 'ocean' must never reach this grid.
    waterClasses: ["great_lake"],
    // This grid's WIND plane shares its wave land mask, so a wind-only reading
    // taken where the wave plane is masked is still a reading over water.
    windFallback: true
  },
  {
    id: "noaa_gfswave",
    source: "aws",
    label: "NOAA GFS Wave Model",
    infoUrl: "https://polar.ncep.noaa.gov/waves/",
    // Range-sliced per forecast hour off the .idx sidecar: HTSGW ~357 KB and WIND
    // ~643 KB against an 11 MB whole file, so a cycle costs ~24 MB instead of ~260.
    fetchMode: "range",
    urlTemplate: "https://noaa-gfs-bdp-pds.s3.amazonaws.com/" +
      "gfs.{YYYYMMDD}/{HH}/wave/gridded/gfswave.t{HH}z.global.0p16.f{FFF}.grib2",
    variables: GRID_ELEMENTS,
    cycleStepHours: 6,
    maxCycleAgeHours: 24,
    forecastSteps: 358,
    warp: null,
    sampled: {
      width: 2160,
      height: 406,
      originLon: -180.083333343214463,
      originLat: 52.583333333333336,
      pixelLon: 0.166666686428902,
      pixelLat: -0.166666666666667,
      nodata: 9999
    },
    // Normal -180..180 convention, so the 0-360 trap that makes epacif unusable
    // does not exist here. Covers CONUS, Hawaii, Puerto Rico, all of Mexico and
    // southern Canada up to 52.583N.
    domain: { minLon: -180.083333343214463, minLat: -15.0833333, maxLon: 179.9167093, maxLat: 52.583333333333336 },
    searchMaxKm: 25,
    waterClasses: ["ocean"],
    windFallback: true
  },
  {
    id: "noaa_gfswave_arctic",
    source: "aws",
    label: "NOAA GFS Wave Model (Arctic)",
    infoUrl: "https://polar.ncep.noaa.gov/waves/",
    fetchMode: "range",
    urlTemplate: "https://noaa-gfs-bdp-pds.s3.amazonaws.com/" +
      "gfs.{YYYYMMDD}/{HH}/wave/gridded/gfswave.t{HH}z.arctic.9km.f{FFF}.grib2",
    variables: GRID_ELEMENTS,
    cycleStepHours: 6,
    maxCycleAgeHours: 24,
    forecastSteps: 358,
    // 1006x1006 polar stereographic at 9000 m, warped to lat/lon over the Alaska
    // mainland and the eastern Aleutians. Beaches west of the antimeridian sit
    // outside this window and outside global.0p16's 52.583N ceiling, so they
    // resolve to no grid; naming that gap is cheaper than carrying a second warp
    // window nothing has validated.
    warp: {
      targetSrs: "EPSG:4326",
      te: [-180.0, 50.0, -128.0, 73.2],
      tr: [0.08, 0.08],
      resample: "near"
    },
    sampled: {
      width: 650,
      height: 290,
      originLon: -180.0,
      originLat: 73.2,
      pixelLon: 0.08,
      pixelLat: -0.08,
      nodata: 9999
    },
    domain: { minLon: -180.0, minLat: 50.0, maxLon: -128.0, maxLat: 73.2 },
    searchMaxKm: 25,
    waterClasses: ["ocean"],
    windFallback: true
  },
  {
    id: "noaa_nwps_sew",
    source: "nomads",
    label: "NOAA Nearshore Wave Prediction System (Seattle)",
    infoUrl: "https://polar.ncep.noaa.gov/nwps/",
    // A per-WFO SWAN nest over the Salish Sea, which global.0p16 masks entirely at
    // 0.1667 degrees. The NOMADS filter CGI is the only access route: there is no
    // NODD or S3 mirror, and the plain directory tree has autoindex off and 403s
    // every real path under it. One ~3.3 MB response carries all 145 hourly steps
    // as 290 bands, HTSGW interleaved with WIND.
    fetchMode: "whole",
    // The %2F sequences must stay encoded: the url is built by string substitution
    // and never parsed, and fetch does not re-decode an already-encoded query. The
    // subregion parameters are deliberately omitted, because a bbox could silently
    // exclude an assigned beach.
    urlTemplate: "https://nomads.ncep.noaa.gov/cgi-bin/filter_wrnwps.pl" +
      "?dir=%2Fwr.{YYYYMMDD}%2Fsew%2F{HH}%2FCG1" +
      "&file=sew_nwps_CG1_{YYYYMMDD}_{HH}00.grib2" +
      "&lev_surface=on&var_HTSGW=on&var_WIND=on",
    // CG1, not CG2: CG2's 4.9 km cells cover more beaches only on a direct hit, and
    // once nearestWetSample runs CG1 resolves as many or more at every cap, with the
    // sharper land mask. CG0 is swell-partition tracking and carries no HTSGW.
    variables: GRID_ELEMENTS,
    // Published on demand, when the office submits wind grids, in practice near 00Z
    // and 12Z with whole days sometimes absent. cycleStepHours is both the candidate
    // alignment and the walk-back granularity, so 12 addresses the two real
    // publication hours; a run at any other hour is unreachable, which is the price
    // of not spending the NOMADS request budget on candidates that never exist.
    cycleStepHours: 12,
    maxCycleAgeHours: 36,
    // 145 hourly steps f000..f144, so the k + 24 > forecastSteps cut does not bind
    // until k reaches 122: age, not step count, is what ends the walk.
    forecastSteps: 145,
    // The CGI is a script, not a file server, so a HEAD proves nothing about whether
    // a cycle exists. The probe is a GET whose first bytes must read GRIB.
    cycleProbe: "get",
    // Plain lat/lon on a sphere already, so the shell takes the gdal_translate branch
    // and no resampler touches the land mask. This nest's GRIB2 DRS is template 5.0
    // simple packing, not the JPEG 2000 gfswave uses.
    warp: null,
    // Seeded from the geotransform of an extracted plane, never from the corner
    // coordinates gdalinfo prints: those are rounded to seven decimals and land
    // 1.2e-8 from the true origin, while the identity gate compares origins within
    // 1e-9 absolute.
    sampled: {
      width: 99,
      height: 93,
      originLon: -127.0259693877551,
      originLat: 49.43804347826087,
      pixelLon: 0.05193877551020408,
      pixelLat: -0.03608695652173913,
      nodata: 9999
    },
    domain: {
      minLon: -127.0259693877551,
      minLat: 46.08195652173914,
      maxLon: -121.8840306122449,
      maxLat: 49.43804347826087
    },
    // Cells are about 3.9 by 4.0 km at 47.6N. Tighter than the ocean cap for the
    // same reason the lakes are: a 25 km reach crosses from Puget Sound into the
    // Strait of Juan de Fuca, which is a different wave regime.
    searchMaxKm: 10,
    waterClasses: ["ocean"],
    // WIND reads 0, not nodata, on this nest's masked cells: Carr Inlet returns
    // HTSGW 9999 beside WIND 0, and isUsableSample accepts 0. A wind-only reading
    // taken where no wet HTSGW cell was found would be a false calm that rules.js
    // colors green, and no build gate can see it.
    windFallback: false,
    // SWAN wets and dries this nest's shore cells with the tide, and some beaches'
    // only wet cell inside the cap is wet only near high water, so the count resolved
    // at hour 0 swings about 13% with the tidal phase at validStart. The record-count
    // ratios take 0.8 so the tide stays silent. validPercent keeps the default ratio
    // and still refuses the cycle, since the plane's wet fraction moves under 2% over
    // a tide. Outside the digest: it changes which cycles warn, never which beaches
    // resolve.
    recordCountMinRatio: { shrinkRatio: 0.8, decay: 0.8 }
  }
];

// A grid whose absence, or whose failed floor, shrink or decay gate, refuses the
// cycle. Any other grid only warns for those, since it costs only its own beaches.
// gfswave global.0p16 is every ocean beach in the table; the others are regional.
export const REQUIRED_GRID_IDS = ["noaa_gfswave"];

// --- small helpers ---------------------------------------------------------------

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function gridById(id, grids) {
  const source = grids === undefined ? GRIDS : grids;
  for (let i = 0; i < source.length; i = i + 1) {
    if (source[i].id === id) {
      return source[i];
    }
  }
  return null;
}

// --- the grids digest -------------------------------------------------------------

// Canonical digest input: id, domain, sampled cell size, url template, variables,
// cap km, accepted water classes and the wind-fallback flag, with a fixed key
// order. The caller hashes the returned string with sha256.
//
// The beach set is deliberately not in the digest. It grows daily, and a digest
// that changes daily is not a gate: it would invalidate the seeded floors in
// data/wave-floors.json every cycle and permanently withhold auto-publish.
//
// What must invalidate a floors entry: adding or removing a grid, moving a domain
// edge, changing a cell size, retargeting a url template, changing a search cap,
// changing which water classes a grid accepts, or changing whether a grid's wind
// plane may answer a wave-null beach. All seven change which beaches resolve to
// which grid, how far a sample may reach, or how many records come back, so counts
// seeded under the old set say nothing about the new one. Cadence and probe fields
// stay out: the digest covers assignment policy and geometry, which decide which
// beaches resolve to which grid, not availability, which decides whether a cycle
// lands at all.
//
// Throws on malformed input: GRIDS is repo-committed source, so a malformed entry
// is a commit bug that must fail loudly rather than digest to something that
// happens to match.
export function gridsDigestInput(grids) {
  const source = grids === undefined ? GRIDS : grids;
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error("gridsDigestInput: expected a non-empty grids array");
  }
  const entries = [];
  for (let i = 0; i < source.length; i = i + 1) {
    const grid = source[i];
    if (!isPlainObject(grid) || typeof grid.id !== "string" || grid.id === "") {
      throw new Error("gridsDigestInput: grid " + String(i) + " has no id");
    }
    if (!isPlainObject(grid.domain) || !isPlainObject(grid.sampled)) {
      throw new Error("gridsDigestInput: grid " + grid.id + " has no domain/sampled block");
    }
    const edges = ["minLon", "minLat", "maxLon", "maxLat"];
    for (let e = 0; e < edges.length; e = e + 1) {
      if (!isFiniteNumber(grid.domain[edges[e]])) {
        throw new Error("gridsDigestInput: grid " + grid.id + " domain." + edges[e] +
          " is not a finite number");
      }
    }
    if (!isFiniteNumber(grid.sampled.pixelLon) || !isFiniteNumber(grid.sampled.pixelLat)) {
      throw new Error("gridsDigestInput: grid " + grid.id + " has no sampled cell size");
    }
    if (!isFiniteNumber(grid.searchMaxKm)) {
      throw new Error("gridsDigestInput: grid " + grid.id + " has no searchMaxKm");
    }
    if (typeof grid.urlTemplate !== "string" || grid.urlTemplate === "") {
      throw new Error("gridsDigestInput: grid " + grid.id + " has no urlTemplate");
    }
    if (!Array.isArray(grid.variables) || grid.variables.length === 0) {
      throw new Error("gridsDigestInput: grid " + grid.id + " has no variables");
    }
    entries.push({
      id: grid.id,
      domain: {
        minLon: grid.domain.minLon,
        minLat: grid.domain.minLat,
        maxLon: grid.domain.maxLon,
        maxLat: grid.domain.maxLat
      },
      cell: { lon: grid.sampled.pixelLon, lat: grid.sampled.pixelLat },
      urlTemplate: grid.urlTemplate,
      variables: grid.variables.slice(),
      searchMaxKm: grid.searchMaxKm,
      // Normalised rather than passed through: waterClassAllowsGrid treats a
      // non-array as permissive, so a grid that declares no list must digest as an
      // explicit "accepts everything" rather than as a key JSON.stringify drops.
      // Sorted, because membership is what decides assignment and a reordering is
      // not a change.
      waterClasses: Array.isArray(grid.waterClasses) ? grid.waterClasses.slice().sort() : null,
      // Normalised the same way and for the same reason: windFallbackAllowed is
      // default-deny, so a grid that declares nothing must digest as an explicit
      // false rather than as a key JSON.stringify drops.
      windFallback: grid.windFallback === true
    });
  }
  entries.sort(function (a, b) {
    if (a.id < b.id) { return -1; }
    if (a.id > b.id) { return 1; }
    return 0;
  });
  return JSON.stringify(entries);
}

// sha256 over gridsDigestInput, rendered the way src/layerManifest.js's regions
// digest is rendered ("sha256:" + 64 lowercase hex) so the two read alike in a
// manifest. Async because crypto.subtle is; Deno, Node and vitest all provide it.
export async function gridsDigest(grids) {
  const bytes = new TextEncoder().encode(gridsDigestInput(grids));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i = i + 1) {
    const h = view[i].toString(16);
    out = out + (h.length === 1 ? "0" + h : h);
  }
  return "sha256:" + out;
}

// --- grid selection ----------------------------------------------------------------

// True when the point falls inside the grid's sampled lat/lon window. For the two
// warped grids this window IS the warp target, so containment here is exact; for
// gfswave it is the native raster extent.
export function containsPoint(grid, lat, lon) {
  if (!isPlainObject(grid) || !isPlainObject(grid.domain) ||
      !isFiniteNumber(lat) || !isFiniteNumber(lon)) {
    return false;
  }
  const d = grid.domain;
  return lat >= d.minLat && lat <= d.maxLat && lon >= d.minLon && lon <= d.maxLon;
}

// True when a beach's water_class permits this grid. A NULL or missing column may
// try every grid; an explicit class is confined to the grids that model that
// water.
//
// This is the cheapest fix for the wrong-water-body problem: a 'great_lake' beach
// can never sample an ocean grid and an 'ocean' beach can never sample the lakes.
// The residual is accepted and bounded only by searchMaxKm — a beach on a narrow
// peninsula can still find a wet cell on the far side within its cap. A
// polygon-aware fix does not belong here.
//
// The NULL branch is safe in the lake direction because gfswave global.0p16
// carries no wet cell anywhere in the Great Lakes basin: the nearest is over
// 380 km from any lake point against a 25 km search cap, so a NULL water_class at
// a lake beach resolves to no record rather than to ocean values. The gate still
// protects the reverse direction, an 'ocean' beach reaching GLWU, and any future
// grid whose mask is less generous, so it must not be removed on the grounds that
// the mask already covers the lake direction.
export function waterClassAllowsGrid(waterClass, grid) {
  if (!isPlainObject(grid)) {
    return false;
  }
  if (waterClass === null || waterClass === undefined || waterClass === "") {
    return true;
  }
  if (!Array.isArray(grid.waterClasses)) {
    return true;
  }
  return grid.waterClasses.indexOf(waterClass) !== -1;
}

// Whether a grid's WIND plane may answer a beach its wave plane could not resolve.
// Default-deny: true only for a grid that declares it, because a grid whose masked
// WIND cells hold 0 rather than a sentinel would otherwise publish a calm-wind
// green over a land cell, and no build gate can see that record as wrong.
export function windFallbackAllowed(grid) {
  return isPlainObject(grid) && grid.windFallback === true;
}

// The ordered list of grids a beach may be sampled from: permitted by water_class
// AND containing the point, in GRIDS order.
export function candidateGrids(beach, grids) {
  const source = Array.isArray(grids) ? grids : GRIDS;
  const out = [];
  if (!isPlainObject(beach)) {
    return out;
  }
  for (let i = 0; i < source.length; i = i + 1) {
    const grid = source[i];
    if (!waterClassAllowsGrid(beach.water_class, grid)) {
      continue;
    }
    if (!containsPoint(grid, beach.lat, beach.lon)) {
      continue;
    }
    out.push(grid);
  }
  return out;
}

// Ordered fallthrough: the first candidate grid whose probe finds a usable wet
// cell. probe(grid, beach) returns truthy when the grid can answer for this beach;
// omitting it selects on domain and water_class alone. A beach out of every
// domain, or with no wet cell inside any cap, resolves to null and gets no wave
// record.
export function selectGrid(beach, grids, probe) {
  const candidates = candidateGrids(beach, grids);
  for (let i = 0; i < candidates.length; i = i + 1) {
    if (typeof probe !== "function") {
      return candidates[i];
    }
    if (probe(candidates[i], beach)) {
      return candidates[i];
    }
  }
  return null;
}

// --- the nearest-wet-cell search ------------------------------------------------------

// Relative tolerance for matching a sampled value against its band's nodata.
//
// Exact equality is unusable here. gdalinfo -json prints a large nodata with about
// eight significant digits, so GLWU's 9.999000260554009e+20 comes back from the
// sidecar as 9.999e+20 while the raster cell still holds the full float32 value,
// and a strict === would miss every Great Lakes sentinel. 1e-6 is far wider than
// that printing loss and far narrower than the gap to any real reading.
const NODATA_MATCH_RELATIVE = 1e-6;

// True when the value is this band's nodata, within the printing tolerance above.
export function matchesNodata(value, nodata) {
  if (!isFiniteNumber(nodata)) {
    return false;
  }
  if (nodata === 0) {
    return value === 0;
  }
  return Math.abs(value - nodata) <= Math.abs(nodata) * NODATA_MATCH_RELATIVE;
}

// A sampled value is usable only when it is finite, is not the band's own header
// nodata, and sits inside the containment rails. The nodata comes from the caller,
// read per band out of gdalinfo -json, never from a literal here: gfswave uses
// 9999 and GLWU uses 9.999000260554009e+20, so a hardcoded 9999 would pass every
// Great Lakes sentinel straight into a flag color.
export function isUsableSample(value, nodata) {
  if (!isFiniteNumber(value)) {
    return false;
  }
  if (matchesNodata(value, nodata)) {
    return false;
  }
  if (value > MAX_PLAUSIBLE_SAMPLE || value < MIN_PLAUSIBLE_SAMPLE) {
    return false;
  }
  return true;
}

// Read one cell of a plane, applying isUsableSample. Returns the number or null.
// Out-of-bounds indices return null rather than reading a neighbouring row, which is
// what a bare row * width + col would do at a grid edge.
export function sampleAtCell(header, data, row, col) {
  if (!isPlainObject(header) || !data) {
    return null;
  }
  if (!(row >= 0) || !(col >= 0) || row >= header.height || col >= header.width) {
    return null;
  }
  const value = data[row * header.width + col];
  return isUsableSample(value, header.nodata) ? value : null;
}

export function cellCenterLat(header, row) {
  return header.originLat + (row + 0.5) * header.pixelLat;
}

export function cellCenterLon(header, col) {
  return header.originLon + (col + 0.5) * header.pixelLon;
}

// Chebyshev-ring search outward from the cell containing (lat, lon) for the
// nearest usable value. This is the sampling mechanism, not a fallback: 4 of 5
// real beach coordinates land on a masked land cell, so naive nearest-cell
// sampling returns nodata almost everywhere.
//
// The tie-break is load-bearing. Candidates are ranked by true great-circle
// distance to the cell centre, never by ring index: longitude cells narrow with
// latitude, so ring-index-nearest picks the wrong cell in Alaska, and
// first-hit-in-scan-order returns 0.90 m from the NW cell at Santa Monica where
// great-circle-minimum returns 0.66 m from the W cell. Both wrong answers are
// plausible numbers with no error anywhere. Exact distance ties break
// lexicographically by (dr, dc) so the result is deterministic across engines.
//
// Returns { value, row, col, cellLat, cellLon, distanceKm, ring } or null.
export function nearestWetSample(grid, header, data, lat, lon) {
  if (!isPlainObject(grid) || !isPlainObject(header) || !data) {
    return null;
  }
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) {
    return null;
  }
  const capKm = isFiniteNumber(grid.searchMaxKm) ? grid.searchMaxKm : 0;
  if (!(capKm > 0)) {
    return null;
  }
  const cellKmLat = Math.abs(header.pixelLat) * KM_PER_DEG;
  // Longitude cells narrow with latitude; the ring radius must be sized on the
  // SMALLER of the two or a high-latitude search stops short of its own cap.
  const cellKmLon = Math.abs(header.pixelLon) * KM_PER_DEG *
    Math.max(Math.cos(lat * Math.PI / 180), 0.01);
  const stepKm = Math.min(cellKmLat, cellKmLon);
  if (!(stepKm > 0)) {
    return null;
  }
  const maxRing = Math.ceil(capKm / stepKm);

  const centerCol = Math.floor((lon - header.originLon) / header.pixelLon);
  const centerRow = Math.floor((lat - header.originLat) / header.pixelLat);

  let best = null;
  for (let ring = 0; ring <= maxRing; ring = ring + 1) {
    // Every cell in this ring is at least (ring - 1) whole cells away, so once that
    // floor exceeds the best distance found no later ring can improve on it.
    if (best !== null && (ring - 1) * stepKm > best.distanceKm) {
      break;
    }
    for (let dr = -ring; dr <= ring; dr = dr + 1) {
      const edge = Math.abs(dr) === ring;
      for (let dc = -ring; dc <= ring; dc = dc + 1) {
        if (!edge && Math.abs(dc) !== ring) {
          continue;
        }
        const row = centerRow + dr;
        const col = centerCol + dc;
        const value = sampleAtCell(header, data, row, col);
        if (value === null) {
          continue;
        }
        const cellLat = cellCenterLat(header, row);
        const cellLon = cellCenterLon(header, col);
        const d = distanceKm(lat, lon, cellLat, cellLon);
        if (d > capKm) {
          continue;
        }
        const candidate = {
          value: value,
          row: row,
          col: col,
          cellLat: cellLat,
          cellLon: cellLon,
          distanceKm: d,
          ring: ring,
          dr: dr,
          dc: dc
        };
        if (best === null || betterCandidate(candidate, best)) {
          best = candidate;
        }
      }
    }
  }
  if (best === null) {
    return null;
  }
  return {
    value: best.value,
    row: best.row,
    col: best.col,
    cellLat: best.cellLat,
    cellLon: best.cellLon,
    distanceKm: best.distanceKm,
    ring: best.ring
  };
}

// Strictly nearer wins; an exact distance tie falls to the smaller dr, then the
// smaller dc. Scan order alone would make the answer depend on which ring reached
// the tie first, which is not a property anyone should have to reason about.
function betterCandidate(candidate, best) {
  if (candidate.distanceKm < best.distanceKm) { return true; }
  if (candidate.distanceKm > best.distanceKm) { return false; }
  if (candidate.dr !== best.dr) { return candidate.dr < best.dr; }
  return candidate.dc < best.dc;
}
