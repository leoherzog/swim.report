// scripts/build-wave-manifest.js — the build-side gate for the NOAA GRIB2 wave
// pipeline. Runs on Deno as the last step before anything is uploaded:
//
//   deno run --allow-read --allow-write --allow-env=ImageOS,ImageVersion \
//     scripts/build-wave-manifest.js --sample ./.waves/out --grids-report ./.waves/grids-report.json \
//     --expect data/wave-grids.json --floors data/wave-floors.json \
//     --previous ./.waves/prev-manifest.json --cycle-id "..." --git-sha "..." --run-id "..." \
//     --allow-shrink false --out ./.waves/out/manifest.json
//
// It re-reads the two emitted NDJSON artifacts, applies every gate, and either
// writes manifest.json plus SHA256SUMS or exits 1 with a specific reason. A refused
// cycle fails safe: nothing is uploaded, waves/current.json stays on the last good
// cycle, and that cycle's KV rides an expiration derived from its own model valid
// time, so the failure mode is a flag aging out to unknown rather than a stale wave
// height deciding a color.
//
// Everything that could produce a wrong number is non-overridable: grid identity,
// band identity, valid times, the sentinel scan, series alignment, the distribution
// checks and the KV pair spelling. A flag an operator reaches for during an incident
// must not wave a wrong wave height into src/rules.js. Everything that is merely
// less data is overridable by --allow-shrink and warns: the coverage floors, the
// per-grid floors and the two ratios. The minimum record rails are the exception in
// that family, since a cycle carrying no wave value cannot color a flag.
//
// A broken or missing grid must produce zero records for its own beaches without
// blocking the others, so every count gate is scoped by sampleReport.gridStatus: a
// floor or ratio is evaluated only for a grid whose status is "sampled" and which is
// present on both sides of the comparison, and every skip warns. An absent grid is
// not a count of zero; scoring it as one refuses the whole cycle on behalf of a grid
// that never ran.
//
// distinctValues and meanPlausibility exist because every other gate counts things
// and a constant plane counts perfectly: 24 aligned hours, no sentinels, no
// out-of-range values, full coverage, every beach reading the same number. They are
// the only gates that can tell a real ocean from a filled buffer.
//
// Every gate is a pure exported function over plain data, so all of it is
// unit-tested in test/buildWaveManifest.test.js. main() does the I/O. Deno is
// reached through globalThis so importing this module under vitest is legal.

import {
  WAVE_SCHEMA_VERSION,
  EXPECTED_WAVE_ARTIFACTS,
  WAVE_KV_LEASE_SECONDS
} from "../src/waveManifest.js";
import {
  GRIDS,
  REQUIRED_GRID_IDS,
  FORECAST_HOURS,
  METERS_PER_SECOND_TO_MPH,
  gridsDigest,
  matchesNodata
} from "../src/waveGrids.js";
import { metersToFeet } from "../src/geo.js";

// --- gate constants ----------------------------------------------------------------

// Ratio against the previous accepted cycle. Coverage is a beach count, which moves
// only when discovery adds rows or a grid stops answering, so this is loose enough
// for ordinary growth and tight enough that a lost grid is unmissable.
export const WAVE_SHRINK_MIN_RATIO = 0.95;

// Against the oldest retained cycle. A hit rate bleeding a few percent per cycle
// passes every ratio-to-previous check forever, so the window comparison is the only
// thing that can see it.
export const WAVE_DECAY_MIN_RATIO = 0.85;

// Rolling window carried forward in manifest.history. Eight cycles is one day at the
// 3-hourly cadence, which is the right span for a decay check whose unit is a cycle.
export const HISTORY_RETAIN = 8;

// The ratio a human uses when seeding data/wave-floors.json from a first real cycle.
// Not applied by this script: seeding is a reviewed commit, never automatic.
export const FLOOR_SEED_RATIO = 0.75;

// Distribution rails. A wave field with fewer than 20 distinct values across the
// whole beach set is not a wave field, and a mean outside [0.05, 25] ft is either a
// dead-calm constant or a unit error.
export const MIN_DISTINCT_WAVE_VALUES = 20;
const MIN_MEAN_WAVE_FT = 0.05;
const MAX_MEAN_WAVE_FT = 25;

// Nothing emitted may exceed this. 9999 m is 32808.4 ft; a real sea state is not
// within two orders of magnitude of 100 ft.
export const MAX_EMITTED_FT = 100;

// The same rail for the wind path, in mph and deliberately separate from the feet one
// so a later change to either cannot silently move the other. The magnitude rail in
// src/waveGrids.js bounds the raw sample, so a corrupt WIND plane can still emit tens
// of thousands of mph; a real sustained wind is not within an order of magnitude
// of 200.
export const MAX_EMITTED_MPH = 200;

export const ATTRIBUTION = "NOAA / NWS / NCEP — US Government work, public domain";

// The KV pair fields the pinned wrangler validator accepts. It warns and exits 0 on
// an unexpected property, so a camelCase expirationTtl — the spelling the Worker
// runtime uses, making it the likeliest mistake here — is silently dropped and the
// key never expires. runFlagRecompute never reads waveinput.updated, so expiration is
// the only staleness control on the color path and that key would color flags from
// dead data indefinitely.
export const ALLOWED_PAIR_FIELDS = ["key", "value", "expiration", "expiration_ttl", "base64", "metadata"];

// --- small pure helpers ---------------------------------------------------------------

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Every gate speaks this shape. overridable says whether --allow-shrink may demote it
// to a warning: count-shrink refusals may, identity and integrity refusals may not.
function refusal(check, subject, message, overridable) {
  return {
    check: check,
    subject: subject,
    message: check + ": " + subject + ": " + message,
    overridable: overridable === true
  };
}

function ratioText(current, previous, ratio) {
  return String(current) + " vs " + String(previous) + " (" +
    (previous > 0 ? (current / previous).toFixed(4) : "n/a") +
    "x, floor " + String(ratio) + "x)";
}

// --- gridStatus, the per-grid scoping contract -------------------------------------------

// The authoritative set is GRIDS, never the keys of the report being judged: a grid
// missing from gridStatus reads as unproven, not as absent.
export function gridIdsOf(grids) {
  const source = Array.isArray(grids) ? grids : GRIDS;
  const out = [];
  for (let i = 0; i < source.length; i = i + 1) {
    out.push(source[i].id);
  }
  return out;
}

// The status sample-waves.js recorded for one grid, or "absent" when the report
// carries no entry. "absent" is deliberately not "unfetched": a missing entry means
// the producer said nothing, which is not a measurement either.
export function gridStatusOf(gridStatus, id) {
  if (!isPlainObject(gridStatus) || !isPlainObject(gridStatus[id]) ||
      typeof gridStatus[id].status !== "string") {
    return "absent";
  }
  return gridStatus[id].status;
}

// Only a "sampled" grid produced records this cycle, so only a "sampled" grid may be
// scored against a floor or a ratio.
export function gridSampled(gridStatus, id) {
  return gridStatusOf(gridStatus, id) === "sampled";
}

// The grids that did not sample. A non-empty list retires the global coverage floor
// and the global ratio fallback, because a number seeded from a complete cycle says
// nothing about a cycle missing a grid; the minimum record rails are then the floor.
export function notSampledGrids(gridStatus, grids) {
  const ids = gridIdsOf(grids);
  const out = [];
  for (let i = 0; i < ids.length; i = i + 1) {
    if (!gridSampled(gridStatus, ids[i])) {
      out.push(ids[i] + " (" + gridStatusOf(gridStatus, ids[i]) + ")");
    }
  }
  return out;
}

// True when a history entry carries per-grid counts. A manifest carrying none is the
// one condition under which the global ratio gates still apply as a fallback.
export function hasGridCounts(gridCounts) {
  return isPlainObject(gridCounts) && Object.keys(gridCounts).length > 0;
}

// --- NON-OVERRIDABLE: identity -----------------------------------------------------------

// The decoded raster of every sampled grid must match data/wave-grids.json: size,
// geotransform origin, cell size and nodata. A grid whose raster moved has cell
// indices pointing somewhere else on earth, and it decodes cleanly, samples without
// error and returns wave heights from the wrong place.
export function gridIdentityRefusals(observedGrids, expectDoc) {
  const out = [];
  if (!isPlainObject(expectDoc) || !isPlainObject(expectDoc.grids)) {
    out.push(refusal("gridIdentity", "expectation", "data/wave-grids.json has no grids block", false));
    return out;
  }
  const originEps = isFiniteNumber(expectDoc.tolerance && expectDoc.tolerance.origin)
    ? expectDoc.tolerance.origin : 1e-9;
  const pixelEps = isFiniteNumber(expectDoc.tolerance && expectDoc.tolerance.pixel)
    ? expectDoc.tolerance.pixel : 1e-12;
  const ids = Object.keys(isPlainObject(observedGrids) ? observedGrids : {});
  for (let i = 0; i < ids.length; i = i + 1) {
    const id = ids[i];
    const expected = expectDoc.grids[id];
    if (!isPlainObject(expected) || !isPlainObject(expected.sampled)) {
      out.push(refusal("gridIdentity", id, "no committed expectation for this grid", false));
      continue;
    }
    const observed = isPlainObject(observedGrids[id]) ? observedGrids[id].identity : null;
    if (!isPlainObject(observed)) {
      out.push(refusal("gridIdentity", id, "the sample report carries no decoded identity", false));
      continue;
    }
    const want = expected.sampled;
    const integers = ["width", "height"];
    for (let f = 0; f < integers.length; f = f + 1) {
      if (observed[integers[f]] !== want[integers[f]]) {
        out.push(refusal("gridIdentity", id, integers[f] + " is " +
          String(observed[integers[f]]) + ", expected " + String(want[integers[f]]), false));
      }
    }
    const origins = ["originLon", "originLat"];
    for (let f = 0; f < origins.length; f = f + 1) {
      if (!isFiniteNumber(observed[origins[f]]) ||
          Math.abs(observed[origins[f]] - want[origins[f]]) > originEps) {
        out.push(refusal("gridIdentity", id, origins[f] + " is " +
          String(observed[origins[f]]) + ", expected " + String(want[origins[f]]), false));
      }
    }
    const pixels = ["pixelLon", "pixelLat"];
    for (let f = 0; f < pixels.length; f = f + 1) {
      if (!isFiniteNumber(observed[pixels[f]]) ||
          Math.abs(observed[pixels[f]] - want[pixels[f]]) > pixelEps) {
        out.push(refusal("gridIdentity", id, pixels[f] + " is " +
          String(observed[pixels[f]]) + ", expected " + String(want[pixels[f]]), false));
      }
    }
    // Relative, not exact: gdalinfo -json prints a large nodata with about eight
    // significant digits, so GLWU's sentinel comes back slightly rounded and an
    // equality test would refuse every cycle for a formatting difference.
    if (!matchesNodata(observed.nodata, want.nodata)) {
      out.push(refusal("gridIdentity", id, "nodata is " + String(observed.nodata) +
        ", expected " + String(want.nodata), false));
    }
    // The identity above is the hour-0 wave plane alone. noaa_gfswave downloads one
    // file per forecast hour, so a later hour can carry a shifted origin with
    // identical dimensions and decode, sample and gate cleanly while reading the
    // wrong cells; the sampler compares every plane it read and reports the
    // disagreements here. A report carrying no count refuses rather than passing
    // vacuously, as an absent decoded identity does.
    const entry = observedGrids[id];
    if (!isFiniteNumber(entry.identityPlanes) || entry.identityPlanes < 1) {
      out.push(refusal("gridIdentity", id,
        "the sample report carries no plane identity count", false));
    }
    const mismatches = Array.isArray(entry.identityMismatches) ? entry.identityMismatches : [];
    for (let m = 0; m < mismatches.length; m = m + 1) {
      out.push(refusal("gridIdentity", id, String(mismatches[m]), false));
    }
  }
  return out;
}

// Every band the sampler read must carry a GRIB_ELEMENT this pipeline recognises.
// Slicing the wrong record produces a valid GRIB2 message describing the wrong
// variable, which decodes without a murmur.
export function bandIdentityRefusals(bands, expectedElements) {
  const out = [];
  if (!Array.isArray(bands) || bands.length === 0) {
    out.push(refusal("bandIdentity", "bands", "the sample report describes no bands", false));
    return out;
  }
  const allowed = Array.isArray(expectedElements) ? expectedElements : [];
  for (let i = 0; i < bands.length; i = i + 1) {
    const band = bands[i];
    const subject = isPlainObject(band)
      ? String(band.gridId) + " hour " + String(band.hour) + " band " + String(band.band)
      : "band " + String(i);
    if (!isPlainObject(band) || typeof band.element !== "string") {
      out.push(refusal("bandIdentity", subject, "no GRIB_ELEMENT", false));
      continue;
    }
    if (allowed.indexOf(band.element) === -1) {
      out.push(refusal("bandIdentity", subject, "GRIB_ELEMENT is " + band.element +
        ", expected one of " + allowed.join(","), false));
    }
    if (!isFiniteNumber(band.band) || band.band < 1) {
      out.push(refusal("bandIdentity", subject, "band index is not a positive number", false));
    }
  }
  return out;
}

// Per band, GRIB_VALID_TIME must equal validStartEpoch + hour*3600. This is the
// conjunct that catches an .idx off-by-one — the failure that otherwise produces a
// complete, plausible, silently time-shifted 24 h series.
export function validTimeRefusals(bands, validStartEpoch) {
  const out = [];
  if (!isFiniteNumber(validStartEpoch)) {
    out.push(refusal("validTimes", "cycle", "validStartEpoch is not a finite number", false));
    return out;
  }
  if (!Array.isArray(bands) || bands.length === 0) {
    out.push(refusal("validTimes", "bands", "the sample report describes no bands", false));
    return out;
  }
  for (let i = 0; i < bands.length; i = i + 1) {
    const band = bands[i];
    if (!isPlainObject(band) || !isFiniteNumber(band.hour)) {
      out.push(refusal("validTimes", "band " + String(i), "no forecast hour", false));
      continue;
    }
    const want = validStartEpoch + band.hour * 3600;
    const subject = String(band.gridId) + " hour " + String(band.hour) + " " + String(band.element);
    if (band.validTime !== want) {
      out.push(refusal("validTimes", subject, "GRIB_VALID_TIME is " + String(band.validTime) +
        ", expected " + String(want), false));
    }
  }
  return out;
}

// --- NON-OVERRIDABLE: the emitted numbers -------------------------------------------------

// Rescans the emitted records rather than trusting the sampler's summary, covering
// waveinput.waveHeightFt, waveinput.windSpeedMph and every waves.hoursFt cell, which
// is every number that will reach a KV value. waves.byModel[gridId] and hoursFt are
// the same array object assigned twice by the sampler, so byModel is not scanned
// separately.
//
// nodataValues is the set of header sentinels in three forms — raw, feet and mph —
// because a sentinel that survived a unit conversion is still a sentinel, and the raw
// form is what would have been written had containment failed upstream.
//
// Wind is counted in its own fields: folding mph into the height distribution would
// make meanWaveFt and distinctWaveValues a mixed measurement, and a constant wave
// plane could then pass distinctValues on wind variance alone.
export function scanRecords(waveinputRecords, wavesRecords, nodataValues) {
  const sentinels = Array.isArray(nodataValues) ? nodataValues : [];
  const stats = {
    waveinputRecords: 0,
    wavesRecords: 0,
    waveValues: 0,
    sentinelHits: 0,
    outOfRange: 0,
    windValues: 0,
    windSentinelHits: 0,
    windOutOfRange: 0,
    misalignedSeries: 0,
    nonNumericCells: 0,
    firstCellMismatches: 0,
    shapeProblems: 0,
    distinctWaveValues: 0,
    meanWaveFt: null,
    maxWaveFt: null,
    minWaveFt: null
  };
  const distinct = new Set();
  const heights = [];
  const heightById = new Map();

  const inputs = Array.isArray(waveinputRecords) ? waveinputRecords : [];
  for (let i = 0; i < inputs.length; i = i + 1) {
    const record = inputs[i];
    stats.waveinputRecords = stats.waveinputRecords + 1;
    if (!isPlainObject(record) || typeof record.beachId !== "string" ||
        typeof record.updated !== "string") {
      stats.shapeProblems = stats.shapeProblems + 1;
      continue;
    }
    if (record.windGustMph !== null) {
      stats.shapeProblems = stats.shapeProblems + 1;
    }
    // Scanned before the wave branch below, which returns early for a null height:
    // windSpeedMph is populated only when waveHeightFt is null, so for exactly the
    // beaches that carry it, wind is the sole input deciding a color.
    const wind = record.windSpeedMph;
    if (wind !== null) {
      if (!isFiniteNumber(wind)) {
        stats.nonNumericCells = stats.nonNumericCells + 1;
      } else {
        stats.windValues = stats.windValues + 1;
        if (isSentinel(wind, sentinels)) {
          stats.windSentinelHits = stats.windSentinelHits + 1;
        }
        if (wind > MAX_EMITTED_MPH || wind < 0) {
          stats.windOutOfRange = stats.windOutOfRange + 1;
        }
      }
    }
    const value = record.waveHeightFt;
    if (value === null) {
      heightById.set(record.beachId, null);
      continue;
    }
    if (!isFiniteNumber(value)) {
      stats.nonNumericCells = stats.nonNumericCells + 1;
      continue;
    }
    heightById.set(record.beachId, value);
    stats.waveValues = stats.waveValues + 1;
    heights.push(value);
    distinct.add(value);
    if (isSentinel(value, sentinels)) { stats.sentinelHits = stats.sentinelHits + 1; }
    if (value > MAX_EMITTED_FT || value < 0) { stats.outOfRange = stats.outOfRange + 1; }
  }

  const series = Array.isArray(wavesRecords) ? wavesRecords : [];
  for (let i = 0; i < series.length; i = i + 1) {
    const record = series[i];
    stats.wavesRecords = stats.wavesRecords + 1;
    if (!isPlainObject(record) || !Array.isArray(record.hoursFt)) {
      stats.shapeProblems = stats.shapeProblems + 1;
      continue;
    }
    if (record.hoursFt.length !== FORECAST_HOURS) {
      stats.misalignedSeries = stats.misalignedSeries + 1;
    }
    for (let h = 0; h < record.hoursFt.length; h = h + 1) {
      const cell = record.hoursFt[h];
      if (cell === null) { continue; }
      if (!isFiniteNumber(cell)) {
        stats.nonNumericCells = stats.nonNumericCells + 1;
        continue;
      }
      distinct.add(cell);
      if (isSentinel(cell, sentinels)) { stats.sentinelHits = stats.sentinelHits + 1; }
      if (cell > MAX_EMITTED_FT || cell < 0) { stats.outOfRange = stats.outOfRange + 1; }
    }
    // hoursFt[0] and waveinput.waveHeightFt are two writes of one sample. A
    // divergence means the spiral ran twice, and the detail page's "now" stat would
    // contradict its own first bar.
    if (heightById.has(record.beachId) && heightById.get(record.beachId) !== record.hoursFt[0]) {
      stats.firstCellMismatches = stats.firstCellMismatches + 1;
    }
  }

  stats.distinctWaveValues = distinct.size;
  if (heights.length > 0) {
    let sum = 0;
    let max = heights[0];
    let min = heights[0];
    for (let i = 0; i < heights.length; i = i + 1) {
      sum = sum + heights[i];
      if (heights[i] > max) { max = heights[i]; }
      if (heights[i] < min) { min = heights[i]; }
    }
    stats.meanWaveFt = sum / heights.length;
    stats.maxWaveFt = max;
    stats.minWaveFt = min;
  }
  return stats;
}

// A value is a sentinel when it matches a grid's raw header nodata, or that nodata
// converted to feet or to mph. All three are checked because containment could have
// failed before or after either conversion, and the match is the same tolerant one
// src/waveGrids.js uses: gdalinfo prints a large nodata with about eight significant
// digits, so exact equality would miss every GLWU sentinel.
function isSentinel(value, sentinels) {
  for (let i = 0; i < sentinels.length; i = i + 1) {
    if (matchesNodata(value, sentinels[i])) { return true; }
  }
  return false;
}

export function sentinelRefusals(stats) {
  const out = [];
  if (!isPlainObject(stats)) {
    out.push(refusal("sentinelScan", "stats", "no scan was performed", false));
    return out;
  }
  if (stats.sentinelHits > 0) {
    out.push(refusal("sentinelScan", "emitted values", String(stats.sentinelHits) +
      " value(s) equal a grid's header nodata", false));
  }
  if (stats.outOfRange > 0) {
    out.push(refusal("sentinelScan", "emitted values", String(stats.outOfRange) +
      " value(s) outside [0, " + String(MAX_EMITTED_FT) + "] ft", false));
  }
  if (stats.windSentinelHits > 0) {
    out.push(refusal("sentinelScan", "emitted wind values", String(stats.windSentinelHits) +
      " wind value(s) equal a grid's header nodata", false));
  }
  if (stats.windOutOfRange > 0) {
    out.push(refusal("sentinelScan", "emitted wind values", String(stats.windOutOfRange) +
      " wind value(s) outside [0, " + String(MAX_EMITTED_MPH) + "] mph", false));
  }
  return out;
}

export function alignmentRefusals(stats) {
  const out = [];
  if (!isPlainObject(stats)) {
    out.push(refusal("alignment", "stats", "no scan was performed", false));
    return out;
  }
  if (stats.misalignedSeries > 0) {
    out.push(refusal("alignment", "waves.ndjson", String(stats.misalignedSeries) +
      " series are not exactly " + String(FORECAST_HOURS) + " entries", false));
  }
  if (stats.nonNumericCells > 0) {
    out.push(refusal("alignment", "emitted values", String(stats.nonNumericCells) +
      " cell(s) are neither a finite number nor null", false));
  }
  if (stats.firstCellMismatches > 0) {
    out.push(refusal("alignment", "hoursFt[0]", String(stats.firstCellMismatches) +
      " series disagree with their own waveinput waveHeightFt", false));
  }
  if (stats.shapeProblems > 0) {
    out.push(refusal("alignment", "record shape", String(stats.shapeProblems) +
      " record(s) are malformed", false));
  }
  return out;
}

// The two gates a constant or garbage grid cannot pass. Skipped entirely when the
// cycle emitted no wave values at all — a mean over zero samples is not a fact, and
// that case is owned by minimumRecordRefusals, which refuses it outright.
export function distributionRefusals(stats) {
  const out = [];
  if (!isPlainObject(stats) || stats.waveValues === 0) {
    return out;
  }
  if (stats.distinctWaveValues < MIN_DISTINCT_WAVE_VALUES) {
    out.push(refusal("distinctValues", "emitted values", String(stats.distinctWaveValues) +
      " distinct wave value(s), floor " + String(MIN_DISTINCT_WAVE_VALUES), false));
  }
  if (!isFiniteNumber(stats.meanWaveFt) ||
      stats.meanWaveFt < MIN_MEAN_WAVE_FT || stats.meanWaveFt > MAX_MEAN_WAVE_FT) {
    out.push(refusal("meanPlausibility", "emitted values", "mean " +
      String(stats.meanWaveFt) + " ft outside [" + String(MIN_MEAN_WAVE_FT) + ", " +
      String(MAX_MEAN_WAVE_FT) + "]", false));
  }
  return out;
}

// The KV pair spelling gate, applied twice: here against the cycle's expiration
// arithmetic, and in scripts/build-wave-kv.js against every pair it emits.
//
//   input = { kvExpirationEpoch, validStartEpoch, pairs }
//
// pairs may be empty at manifest time; the epoch arithmetic is checked either way.
// Absolute expiration, never a TTL: a TTL measured from write time is wrong for a
// scheduler that skips occurrences, because a run firing 9 h late would grant 7 more
// hours of life to data already 9 h old.
export function ttlSpellingRefusals(input) {
  const out = [];
  const validStartEpoch = isPlainObject(input) ? input.validStartEpoch : null;
  const kvExpirationEpoch = isPlainObject(input) ? input.kvExpirationEpoch : null;
  if (!isFiniteNumber(validStartEpoch)) {
    out.push(refusal("ttlSpelling", "cycle", "validStartEpoch is not a finite number", false));
  } else if (!isFiniteNumber(kvExpirationEpoch)) {
    out.push(refusal("ttlSpelling", "cycle", "kvExpirationEpoch is not a finite number", false));
  } else if (kvExpirationEpoch !== validStartEpoch + WAVE_KV_LEASE_SECONDS) {
    out.push(refusal("ttlSpelling", "cycle", "kvExpirationEpoch " + String(kvExpirationEpoch) +
      " is not validStartEpoch + " + String(WAVE_KV_LEASE_SECONDS), false));
  }
  const pairs = isPlainObject(input) && Array.isArray(input.pairs) ? input.pairs : [];
  for (let i = 0; i < pairs.length; i = i + 1) {
    const pair = pairs[i];
    const subject = isPlainObject(pair) && typeof pair.key === "string"
      ? pair.key : "pair " + String(i);
    if (!isPlainObject(pair)) {
      out.push(refusal("ttlSpelling", subject, "pair is not an object", false));
      continue;
    }
    if (typeof pair.key !== "string" || pair.key === "") {
      out.push(refusal("ttlSpelling", subject, "key is not a non-empty string", false));
    }
    // The validator rejects a nested-object value outright, which fails loudly, but
    // only a string is ever correct, so it is asserted here too.
    if (typeof pair.value !== "string") {
      out.push(refusal("ttlSpelling", subject, "value is " + typeof pair.value +
        ", not a JSON string", false));
    }
    if (!isFiniteNumber(pair.expiration)) {
      out.push(refusal("ttlSpelling", subject, "expiration is not a number", false));
    }
    const fields = Object.keys(pair);
    for (let f = 0; f < fields.length; f = f + 1) {
      if (ALLOWED_PAIR_FIELDS.indexOf(fields[f]) === -1) {
        // wrangler warns and exits 0 on an unexpected property, so a camelCase
        // expirationTtl writes a key that never expires. Refuse here instead.
        out.push(refusal("ttlSpelling", subject, "unexpected pair field " + fields[f], false));
      }
    }
  }
  return out;
}

// --- NON-OVERRIDABLE: the minimum record rails ----------------------------------------

// The absolute floor under every count gate, independent of data/wave-floors.json.
// Without it a zero-record cycle passes everything: distributionRefusals returns
// early when waveValues is 0, an unseeded floors entry applies no floor, and the
// ratio gates are skipped on a bootstrap cycle. It is also absorbing, because
// shrinkRatioRefusals skips a field whose previous count is <= 0, so every later
// zero-record cycle would sail through.
//
// Every refusal here is non-overridable and reads only the sample report, so neither
// --allow-shrink nor an absent floors entry can reach it.
export function minimumRecordRefusals(stats, sampleBeaches, gridStats, gridStatus) {
  const out = [];

  // A ratio whose denominator is absent must refuse, never pass vacuously.
  const total = isPlainObject(sampleBeaches) ? sampleBeaches.total : null;
  if (!isFiniteNumber(total) || total <= 0) {
    out.push(refusal("minimumRecords", "beaches",
      "the sample report describes " + String(total) + " beaches", false));
  }

  // No non-null waveHeightFt anywhere means the wave planes resolved nothing, which
  // also covers wind-only-everywhere: the wind branch is a legitimate per-beach
  // fallback, but every beach taking it is not a coverage variation.
  if (!isPlainObject(stats) || !isFiniteNumber(stats.waveValues) || stats.waveValues <= 0) {
    out.push(refusal("minimumRecords", "wave values",
      "the cycle emitted no wave height at all, so it cannot color a single flag", false));
  }

  for (let i = 0; i < REQUIRED_GRID_IDS.length; i = i + 1) {
    const id = REQUIRED_GRID_IDS[i];
    const status = gridStatusOf(gridStatus, id);
    if (status !== "sampled") {
      out.push(refusal("minimumRecords", id, "a required grid whose status is " +
        status, false));
      continue;
    }
    const counts = isPlainObject(gridStats) ? gridStats[id] : undefined;
    if (!isPlainObject(counts)) {
      out.push(refusal("minimumRecords", id,
        "status is sampled but the sample report carries no counts for it", false));
      continue;
    }
    // A required grid offered beaches and resolved none: a wrong or empty plane, not
    // coverage variation. There is deliberately no tuned resolution rate here, because
    // candidateGrids offers every NULL-water_class beach to any grid whose domain box
    // contains it, so assignedBeaches is diluted by inland rows by an unmeasured
    // amount and a tuned rate could refuse every cycle forever.
    if (isFiniteNumber(counts.assignedBeaches) && counts.assignedBeaches > 0 &&
        counts.resolvedBeaches === 0) {
      out.push(refusal("minimumRecords", id, String(counts.assignedBeaches) +
        " beach(es) were offered to this required grid and none resolved", false));
    }
  }

  // validPercent is otherwise published and gated by nothing, leaving an all-nodata
  // grid to the overridable ratio rails alone. Scoped to a grid already claiming
  // status "sampled", which cannot have had zero usable cells, so it needs no tuned
  // threshold and cannot fire for the wrong reason.
  const ids = gridIdsOf();
  for (let i = 0; i < ids.length; i = i + 1) {
    const id = ids[i];
    if (gridStatusOf(gridStatus, id) !== "sampled") { continue; }
    const counts = isPlainObject(gridStats) ? gridStats[id] : undefined;
    if (!isPlainObject(counts)) { continue; }
    if (!isFiniteNumber(counts.validPercent) || counts.validPercent <= 0) {
      out.push(refusal("minimumRecords", id, "validPercent is " +
        (isFiniteNumber(counts.validPercent)
          ? counts.validPercent.toFixed(2) : String(counts.validPercent)) +
        " — every cell of its hour-0 wave plane is nodata", false));
    }
  }
  return out;
}

// A non-required grid that resolved nothing warns and never refuses: it contributes
// zero records either way, and refusing on its behalf is the whole-cycle refusal this
// scoping exists to remove.
export function zeroResolutionWarnings(gridStats, gridStatus) {
  const out = [];
  const ids = gridIdsOf();
  for (let i = 0; i < ids.length; i = i + 1) {
    const id = ids[i];
    if (REQUIRED_GRID_IDS.indexOf(id) !== -1) { continue; }
    if (gridStatusOf(gridStatus, id) !== "sampled") { continue; }
    const counts = isPlainObject(gridStats) ? gridStats[id] : undefined;
    if (!isPlainObject(counts)) { continue; }
    if (isFiniteNumber(counts.assignedBeaches) && counts.assignedBeaches > 0 &&
        counts.resolvedBeaches === 0) {
      out.push(id + ": sampled, " + String(counts.assignedBeaches) +
        " beach(es) offered and none resolved — its beaches age out to unknown");
    }
  }
  return out;
}

// --- OVERRIDABLE: coverage ------------------------------------------------------------

// Resolves the floors entry for this grid set. An unseeded digest withholds
// auto-publish and does not fail the build: appending a grid to src/waveGrids.js
// changes the digest by construction, and the right response is a human seeding
// floors from the first real cycle, not a red build.
export function floorsEntryFor(floorsFile, digest) {
  if (!isPlainObject(floorsFile) || !isPlainObject(floorsFile.floors)) {
    return { entry: null, status: "missing", autoPublishAllowed: false,
      reason: "data/wave-floors.json has no floors block" };
  }
  const entry = floorsFile.floors[digest];
  if (!isPlainObject(entry)) {
    return { entry: null, status: "unseeded", autoPublishAllowed: false,
      reason: "no floors entry for gridsDigest " + String(digest) };
  }
  if (entry.status !== "seeded") {
    return { entry: entry, status: String(entry.status), autoPublishAllowed: false,
      reason: "floors entry for gridsDigest " + String(digest) + " is status " +
        String(entry.status) + ", not seeded" };
  }
  return { entry: entry, status: "seeded", autoPublishAllowed: true, reason: null };
}

// Global coverage floors. A null floor means none has been seeded and the check does
// not apply: a deliberate, reviewable gap, unlike an invented number that either
// blocks every cycle forever or blesses a broken one.
//
// The caller applies this only when every grid sampled: a floor seeded from a
// complete cycle measures nothing about a cycle missing a grid.
export function coverageFloorRefusals(counts, floorsEntry) {
  const out = [];
  if (!isPlainObject(floorsEntry) || !isPlainObject(counts)) {
    return out;
  }
  const fields = ["waveinputRecords", "wavesRecords"];
  for (let i = 0; i < fields.length; i = i + 1) {
    const floor = floorsEntry[fields[i]];
    if (!isFiniteNumber(floor)) { continue; }
    const value = counts[fields[i]];
    if (!isFiniteNumber(value) || value < floor) {
      out.push(refusal("coverageFloor", fields[i], String(value) + " is below the seeded floor " +
        String(floor), true));
    }
  }
  return out;
}

// A grid's seeded floor, scored only against a grid whose status is "sampled".
// sampleReport.grids carries only grids that sampled, so an unfetched grid is
// indistinguishable there from one that resolved nothing, and reading that absence as
// zero would refuse the whole cycle, ocean included, when one regional grid's upstream
// is out. An unsampled grid produces no refusal here; perGridFloorStatus reports it as
// not evaluated and warns.
export function perGridFloorRefusals(gridCounts, floorsEntry, gridStatus) {
  const out = [];
  if (!isPlainObject(floorsEntry) || !isPlainObject(floorsEntry.grids) || !isPlainObject(gridCounts)) {
    return out;
  }
  const ids = Object.keys(floorsEntry.grids);
  for (let i = 0; i < ids.length; i = i + 1) {
    const floor = floorsEntry.grids[ids[i]];
    if (!isFiniteNumber(floor)) { continue; }
    if (!gridSampled(gridStatus, ids[i])) { continue; }
    const entry = gridCounts[ids[i]];
    if (!isPlainObject(entry) || !isFiniteNumber(entry.resolvedBeaches)) {
      // "sampled" with no count is an inconsistent report, not a zero: refuse on
      // that rather than inventing the number the floor would be scored on.
      out.push(refusal("perGridFloor", ids[i],
        "status is sampled but the sample report carries no resolvedBeaches count", true));
      continue;
    }
    if (entry.resolvedBeaches < floor) {
      out.push(refusal("perGridFloor", ids[i], String(entry.resolvedBeaches) +
        " resolved beaches is below the seeded floor " + String(floor), true));
    }
  }
  return out;
}

// The sanity.floors.grids map plus one warning per floor that could not be scored.
// A skipped floor is published as the string "not evaluated" and never as its
// numeric value: a reader must not be able to mistake a skip for a pass.
export function perGridFloorStatus(floorsEntry, gridStatus) {
  const grids = {};
  const warnings = [];
  if (!isPlainObject(floorsEntry) || !isPlainObject(floorsEntry.grids)) {
    return { grids: grids, warnings: warnings };
  }
  const ids = Object.keys(floorsEntry.grids);
  for (let i = 0; i < ids.length; i = i + 1) {
    const id = ids[i];
    const floor = floorsEntry.grids[id];
    if (!isFiniteNumber(floor)) {
      grids[id] = floor === undefined ? null : floor;
      continue;
    }
    if (!gridSampled(gridStatus, id)) {
      grids[id] = "not evaluated";
      warnings.push("perGridFloor: " + id + " is " + gridStatusOf(gridStatus, id) +
        ", so its seeded floor of " + String(floor) + " measures nothing this cycle");
      continue;
    }
    grids[id] = floor;
  }
  return { grids: grids, warnings: warnings };
}

// One per-grid ratio comparison. A grid is compared only when it sampled this cycle
// and the other side carries a positive count for it; every other case is a skip
// that warns, because a silent skip and a pass are indistinguishable in a manifest.
//
// These are strictly tighter than the global ratios for any grid present on both
// sides: a global ratio is satisfiable by one grid collapsing while another grows.
function perGridRatioRefusals(check, minRatio, gridCounts, otherGrids, gridStatus, otherLabel) {
  const refusals = [];
  const warnings = [];
  // How many field comparisons were scored. shrinkRatiosPassed reads true on zero of
  // them, so the count is what tells a reader whether the flag means anything.
  let compared = 0;
  const seen = {};
  const ids = [];
  const sources = [isPlainObject(gridCounts) ? gridCounts : {},
    isPlainObject(otherGrids) ? otherGrids : {}];
  for (let s = 0; s < sources.length; s = s + 1) {
    const keys = Object.keys(sources[s]);
    for (let k = 0; k < keys.length; k = k + 1) {
      if (seen[keys[k]] === true) { continue; }
      seen[keys[k]] = true;
      ids.push(keys[k]);
    }
  }
  // validPercent rides the same rails as the record counts: it is a fraction rather
  // than a count, and a collapse from 70 to 3 while beaches still resolve through
  // longer spiral rings is the partial corruption every count floor holds through.
  const fields = ["waveinputRecords", "wavesRecords", "validPercent"];
  for (let i = 0; i < ids.length; i = i + 1) {
    const id = ids[i];
    if (!gridSampled(gridStatus, id)) {
      warnings.push(check + ": " + id + " is " + gridStatusOf(gridStatus, id) +
        " this cycle, so it was not compared against " + otherLabel);
      continue;
    }
    const current = isPlainObject(gridCounts) ? gridCounts[id] : undefined;
    const previous = isPlainObject(otherGrids) ? otherGrids[id] : undefined;
    if (!isPlainObject(previous)) {
      warnings.push(check + ": " + id + " has no counts in " + otherLabel +
        ", so it was not compared");
      continue;
    }
    for (let f = 0; f < fields.length; f = f + 1) {
      const was = previous[fields[f]];
      const now = isPlainObject(current) ? current[fields[f]] : undefined;
      if (!isFiniteNumber(was) || was <= 0) {
        warnings.push(check + ": " + id + " " + fields[f] + " is not a positive value in " +
          otherLabel + ", so it was not compared");
        continue;
      }
      if (!isFiniteNumber(now)) {
        warnings.push(check + ": " + id + " " + fields[f] +
          " is not a value this cycle, so it was not compared");
        continue;
      }
      compared = compared + 1;
      if (now < minRatio * was) {
        refusals.push(refusal(check, id + " " + fields[f],
          ratioText(now, was, minRatio), true));
      }
    }
  }
  return { refusals: refusals, warnings: warnings, compared: compared };
}

// Per grid, against the previous accepted cycle.
export function perGridShrinkRefusals(gridCounts, previousGrids, gridStatus) {
  return perGridRatioRefusals("shrinkRatio", WAVE_SHRINK_MIN_RATIO, gridCounts,
    previousGrids, gridStatus, "the previous cycle");
}

// Per grid, against the oldest retained cycle.
export function perGridDecayRefusals(gridCounts, oldestGrids, gridStatus) {
  return perGridRatioRefusals("decay", WAVE_DECAY_MIN_RATIO, gridCounts,
    oldestGrids, gridStatus, "the oldest retained cycle");
}

// The global shrink ratio, summed across grids. A fallback: the caller applies it
// only when the previous entry carries no per-grid counts and every grid sampled.
export function shrinkRatioRefusals(counts, previousCounts) {
  const out = [];
  if (!isPlainObject(counts) || !isPlainObject(previousCounts)) {
    return out;
  }
  const fields = ["waveinputRecords", "wavesRecords"];
  for (let i = 0; i < fields.length; i = i + 1) {
    const previous = previousCounts[fields[i]];
    const current = counts[fields[i]];
    if (!isFiniteNumber(previous) || previous <= 0 || !isFiniteNumber(current)) { continue; }
    if (current < WAVE_SHRINK_MIN_RATIO * previous) {
      out.push(refusal("shrinkRatio", fields[i],
        ratioText(current, previous, WAVE_SHRINK_MIN_RATIO), true));
    }
  }
  return out;
}

// Against the oldest retained cycle, because a hit rate bleeding a few percent per
// cycle passes every ratio-to-previous check forever.
export function decayRefusals(counts, oldest) {
  const out = [];
  if (!isPlainObject(counts) || !isPlainObject(oldest)) {
    return out;
  }
  const fields = ["waveinputRecords", "wavesRecords"];
  for (let i = 0; i < fields.length; i = i + 1) {
    const previous = oldest[fields[i]];
    const current = counts[fields[i]];
    if (!isFiniteNumber(previous) || previous <= 0 || !isFiniteNumber(current)) { continue; }
    if (current < WAVE_DECAY_MIN_RATIO * previous) {
      out.push(refusal("decay", fields[i],
        ratioText(current, previous, WAVE_DECAY_MIN_RATIO), true));
    }
  }
  return out;
}

// --- history --------------------------------------------------------------------------

// The per-grid record counts of a manifest, lifted off its grids array into the keyed
// form the per-grid ratio gates read. A manifest carrying none yields {}, which is
// the condition that keeps the global ratio fallback alive.
export function gridCountsFromManifest(manifest) {
  const out = {};
  if (!isPlainObject(manifest) || !Array.isArray(manifest.grids)) {
    return out;
  }
  for (let i = 0; i < manifest.grids.length; i = i + 1) {
    const entry = manifest.grids[i];
    if (!isPlainObject(entry) || typeof entry.id !== "string") { continue; }
    if (!isFiniteNumber(entry.waveinputRecords) && !isFiniteNumber(entry.wavesRecords)) {
      continue;
    }
    out[entry.id] = {
      waveinputRecords: isFiniteNumber(entry.waveinputRecords)
        ? entry.waveinputRecords : null,
      wavesRecords: isFiniteNumber(entry.wavesRecords) ? entry.wavesRecords : null,
      validPercent: isFiniteNumber(entry.validPercent) ? entry.validPercent : null
    };
  }
  return out;
}

export function historyEntryFor(manifest) {
  if (!isPlainObject(manifest)) {
    return null;
  }
  const beaches = isPlainObject(manifest.beaches) ? manifest.beaches : {};
  return {
    cycleId: manifest.cycleId || null,
    validStartIso: manifest.validStartIso || null,
    waveinputRecords: isFiniteNumber(beaches.waveinputRecords) ? beaches.waveinputRecords : null,
    wavesRecords: isFiniteNumber(beaches.wavesRecords) ? beaches.wavesRecords : null,
    // Carried forward so the decay ratio can be scored per grid against the oldest
    // retained cycle; the globals alone cannot see one grid collapsing while another
    // grows.
    grids: gridCountsFromManifest(manifest)
  };
}

// Newest last, retained to a fixed window. The previous manifest's own entry is
// appended to its history, so a chain of manifests carries a rolling window without
// N extra fetches.
export function buildHistory(previousManifest, retain) {
  const keep = isFiniteNumber(retain) && retain > 0 ? retain : HISTORY_RETAIN;
  const history = [];
  if (isPlainObject(previousManifest) && Array.isArray(previousManifest.history)) {
    for (let i = 0; i < previousManifest.history.length; i = i + 1) {
      if (isPlainObject(previousManifest.history[i])) {
        history.push(previousManifest.history[i]);
      }
    }
  }
  const entry = historyEntryFor(previousManifest);
  if (entry !== null) {
    history.push(entry);
  }
  return history.slice(Math.max(0, history.length - keep));
}

export function oldestRetained(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return null;
  }
  return history[0];
}

// --- the verdict --------------------------------------------------------------------

// One evaluation of every gate, with --allow-shrink demoting the overridable ones to
// warnings and stamping sanity.overridden true, visible forever downstream. It cannot
// touch identity or integrity: sentinelScan, gridIdentity, bandIdentity, validTimes,
// alignment, distinctValues, meanPlausibility, minimumRecords and ttlSpelling are
// refusals in every mode.
//
// The count gates are scoped by input.gridStatus. A grid that did not sample is never
// scored: not against its own floor, not against a ratio, and not through the global
// gates, which are skipped entirely while any grid is missing.
export function evaluateWaveGates(input) {
  const floorsResult = floorsEntryFor(input.floorsFile, input.gridsDigest);
  const bootstrap = !isPlainObject(input.previousManifest);
  const gridStatus = input.gridStatus;
  const missingGrids = notSampledGrids(gridStatus);
  const everyGridSampled = missingGrids.length === 0;

  const gridIdentity = gridIdentityRefusals(input.gridStats, input.expectDoc);
  const bandIdentity = bandIdentityRefusals(input.bands, input.expectedElements);
  const validTimes = validTimeRefusals(input.bands, input.validStartEpoch);
  const sentinel = sentinelRefusals(input.stats);
  const alignment = alignmentRefusals(input.stats);
  const distribution = distributionRefusals(input.stats);
  const minimumRecords = minimumRecordRefusals(input.stats, input.sampleBeaches,
    input.gridStats, gridStatus);
  const ttl = ttlSpellingRefusals({
    validStartEpoch: input.validStartEpoch,
    kvExpirationEpoch: input.kvExpirationEpoch,
    pairs: []
  });

  // The global floor and the global ratios measure the whole cycle, so they are
  // meaningful only for a cycle that has every grid in it. When one is missing they
  // are skipped and the non-overridable minimum record rails above stand in their
  // place; scoring them anyway would refuse the whole cycle for the grids that did
  // sample.
  const coverage = everyGridSampled
    ? coverageFloorRefusals(input.counts, floorsResult.entry) : [];
  const floorStatus = perGridFloorStatus(floorsResult.entry, gridStatus);
  const perGrid = perGridFloorRefusals(input.gridStats, floorsResult.entry, gridStatus);

  const perGridShrink = bootstrap
    ? { refusals: [], warnings: [], compared: 0 }
    : perGridShrinkRefusals(input.gridStats, input.previousGridCounts, gridStatus);
  const perGridDecay = bootstrap
    ? { refusals: [], warnings: [], compared: 0 }
    : perGridDecayRefusals(input.gridStats, input.oldestGridCounts, gridStatus);

  // The global ratios survive only as the fallback for a previous or oldest entry
  // that carries no per-grid counts, and only for a complete cycle. Without this such
  // a cycle would have no ratio coverage at all.
  const shrinkFallback = !bootstrap && !hasGridCounts(input.previousGridCounts) &&
    everyGridSampled;
  const decayFallback = !bootstrap && !hasGridCounts(input.oldestGridCounts) &&
    everyGridSampled;
  const shrink = shrinkFallback
    ? shrinkRatioRefusals(input.counts, input.previousCounts) : [];
  const decay = decayFallback ? decayRefusals(input.counts, input.oldest) : [];

  // A previous manifest with no per-grid counts and a grid missing this cycle scores
  // no ratio comparison at all: the global fallback is retired by the missing grid
  // and every per-grid comparison skips for want of a previous entry. Refusing would
  // be a false alarm on behalf of a grid that never ran, so the response is to
  // withhold auto-publish and make a human read the manifest, as an unseeded floor
  // and a bootstrap cycle already do.
  const ratioCoverage = shrinkFallback || perGridShrink.compared > 0;

  const all = gridIdentity
    .concat(bandIdentity, validTimes, sentinel, alignment, distribution,
      minimumRecords, ttl, coverage, perGrid, shrink, decay,
      perGridShrink.refusals, perGridDecay.refusals);

  const allowShrink = input.allowShrink === true;
  const refusals = [];
  const warnings = [];
  for (let i = 0; i < all.length; i = i + 1) {
    if (allowShrink && all[i].overridable) {
      warnings.push("OVERRIDDEN " + all[i].message);
      continue;
    }
    refusals.push(all[i]);
  }
  const overridden = allowShrink && warnings.length > 0;

  const skips = floorStatus.warnings
    .concat(perGridShrink.warnings, perGridDecay.warnings,
      zeroResolutionWarnings(input.gridStats, gridStatus));
  for (let i = 0; i < skips.length; i = i + 1) {
    warnings.push(skips[i]);
  }
  if (!everyGridSampled) {
    warnings.push("the global coverage floor and the global ratio fallback were " +
      "skipped: " + missingGrids.join(", ") + " did not sample this cycle, and a " +
      "number seeded from a complete cycle measures nothing about this one");
  }

  if (floorsResult.reason !== null) {
    warnings.push("auto-publish withheld: " + floorsResult.reason);
  }
  if (!bootstrap && !ratioCoverage) {
    warnings.push("auto-publish withheld: no ratio check was scored this cycle — the " +
      "previous manifest carries no per-grid counts and " +
      (missingGrids.length > 0 ? missingGrids.join(", ") : "no grid") + " did not sample");
  }
  if (bootstrap) {
    warnings.push("auto-publish withheld: no previous manifest — this is a bootstrap cycle, " +
      "so every ratio check was skipped and a human must read this manifest before the " +
      "pointer is written");
  }

  const passed = refusals.length === 0;
  return {
    refusals: refusals,
    warnings: warnings,
    bootstrap: bootstrap,
    sanity: {
      previousCycleId: bootstrap ? null : (input.previousManifest.cycleId || null),
      gridIdentityPassed: countUnrefused(gridIdentity, refusals),
      bandIdentityPassed: countUnrefused(bandIdentity, refusals),
      validTimesPassed: countUnrefused(validTimes, refusals),
      sentinelScanPassed: countUnrefused(sentinel, refusals),
      alignmentPassed: countUnrefused(alignment, refusals),
      distinctValuesPassed: countUnrefused(
        refusalsOfCheck(distribution, "distinctValues"), refusals),
      meanPlausibilityPassed: countUnrefused(
        refusalsOfCheck(distribution, "meanPlausibility"), refusals),
      ttlSpellingPassed: countUnrefused(ttl, refusals),
      // Non-overridable and independent of the seeded floors: a cycle carrying no
      // wave value at all cannot color a flag.
      minimumRecordsPassed: countUnrefused(minimumRecords, refusals),
      coverageFloorsPassed: countUnrefused(coverage.concat(perGrid), refusals),
      shrinkRatiosPassed: countUnrefused(shrink.concat(perGridShrink.refusals), refusals),
      // How many per-grid field comparisons backed shrinkRatiosPassed. It reads true
      // on zero comparisons, so the flag alone cannot say whether anything was scored.
      shrinkRatiosCompared: perGridShrink.compared,
      decayPassed: countUnrefused(decay.concat(perGridDecay.refusals), refusals),
      everyGridSampled: everyGridSampled,
      gridsNotSampled: missingGrids,
      bootstrap: bootstrap,
      // Published separately so an --allow-shrink cycle stays distinguishable
      // downstream: under an override every individual flag above still reads true,
      // and this is the only field that still says a human bypassed a refusal.
      overridden: overridden,
      passed: passed,
      autoPublishAllowed: passed && floorsResult.autoPublishAllowed && !bootstrap &&
        ratioCoverage,
      floors: {
        digest: input.gridsDigest,
        status: floorsResult.status,
        waveinputRecords: isPlainObject(floorsResult.entry)
          ? floorsResult.entry.waveinputRecords : null,
        wavesRecords: isPlainObject(floorsResult.entry)
          ? floorsResult.entry.wavesRecords : null,
        // A floor that could not be scored reads "not evaluated", never its numeric
        // value, so a skip is never mistakable for a pass.
        grids: floorStatus.grids
      }
    }
  };
}

// distributionRefusals produces two independently reportable gates in one list; the
// manifest publishes them separately because the consumer gate and a human reading a
// refusal both want to know which one fired.
function refusalsOfCheck(list, check) {
  return list.filter(function (r) { return r.check === check; });
}

// A gate passed when none of its refusals survived into the final list, whether it
// produced none or every one was overridden.
function countUnrefused(produced, refusals) {
  for (let i = 0; i < produced.length; i = i + 1) {
    if (refusals.indexOf(produced[i]) !== -1) {
      return false;
    }
  }
  return true;
}

// --- SHA256SUMS ---------------------------------------------------------------------

// Scope is the two .ndjson artifacts and nothing else. manifest.json must stay
// outside its own checksum scope: it is the sole input to the consumer gate and is
// read back and byte-compared with cmp on its own.
export function sha256SumsText(artifacts) {
  const list = Array.isArray(artifacts) ? artifacts.slice() : [];
  list.sort(function (a, b) {
    if (a.key < b.key) { return -1; }
    if (a.key > b.key) { return 1; }
    return 0;
  });
  const lines = [];
  for (let i = 0; i < list.length; i = i + 1) {
    if (EXPECTED_WAVE_ARTIFACTS.indexOf(list[i].key) !== -1) {
      lines.push(list[i].sha256 + "  " + list[i].key);
    }
  }
  return lines.join("\n") + "\n";
}

// --- argument parsing -----------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    sample: null, gridsReport: null, expect: "data/wave-grids.json",
    floors: "data/wave-floors.json", previous: null, cycleId: null, gitSha: null,
    runId: null, allowShrink: false, retain: HISTORY_RETAIN, gdal: null, out: null
  };
  for (let i = 0; i < argv.length; i = i + 1) {
    const a = argv[i];
    if (a === "--sample") { args.sample = argv[++i]; }
    else if (a === "--grids-report") { args.gridsReport = argv[++i]; }
    else if (a === "--expect") { args.expect = argv[++i]; }
    else if (a === "--floors") { args.floors = argv[++i]; }
    else if (a === "--previous") { args.previous = argv[++i]; }
    else if (a === "--cycle-id") { args.cycleId = argv[++i]; }
    else if (a === "--git-sha") { args.gitSha = argv[++i]; }
    else if (a === "--run-id") { args.runId = argv[++i]; }
    else if (a === "--allow-shrink") { args.allowShrink = String(argv[++i]) === "true"; }
    else if (a === "--retain") { args.retain = Number(argv[++i]); }
    else if (a === "--gdal") { args.gdal = argv[++i]; }
    else if (a === "--out") { args.out = argv[++i]; }
    else { throw new Error("unknown argument: " + a); }
  }
  const required = ["sample", "gridsReport", "cycleId", "out"];
  for (let i = 0; i < required.length; i = i + 1) {
    if (typeof args[required[i]] !== "string" || args[required[i]] === "") {
      throw new Error("build-wave-manifest: --" + required[i] + " is required");
    }
  }
  return args;
}

// --- I/O (main only) --------------------------------------------------------------------

function requireDeno(what) {
  const runtime = globalThis.Deno;
  if (runtime === undefined) {
    throw new Error("build-wave-manifest: " + what + " requires Deno");
  }
  return runtime;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i = i + 1) {
    const h = view[i].toString(16);
    out = out + (h.length === 1 ? "0" + h : h);
  }
  return out;
}

async function readJsonIfPresent(runtime, path) {
  if (typeof path !== "string" || path === "") {
    return null;
  }
  try {
    return JSON.parse(await runtime.readTextFile(path));
  } catch (err) {
    return null;
  }
}

// One NDJSON artifact as parsed records. A line that will not parse is a torn
// artifact, which throws rather than degrading to a shorter record list that every
// count gate would then measure as a legitimate shrink.
export function parseNdjson(text, what) {
  const out = [];
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i = i + 1) {
    if (lines[i].trim() === "") { continue; }
    try {
      out.push(JSON.parse(lines[i]));
    } catch (err) {
      throw new Error("build-wave-manifest: " + what + " line " + String(i + 1) +
        " is not valid JSON");
    }
  }
  return out;
}

export function runnerImageOf(imageOs, imageVersion) {
  if (!imageOs && !imageVersion) {
    return null;
  }
  return String(imageOs || "?") + "/" + String(imageVersion || "?");
}

// The nodata sentinels of every grid in the three forms scanRecords compares
// against: raw, converted to feet, and converted to mph. Both conversions go through
// the same function and constant the sampler applied — metersToFeet and
// METERS_PER_SECOND_TO_MPH — rather than a re-spelled ratio: spelled twice a factor
// can drift, and matchesNodata's relative tolerance would then stop matching.
export function sentinelValues(grids) {
  const source = Array.isArray(grids) ? grids : GRIDS;
  const out = [];
  for (let i = 0; i < source.length; i = i + 1) {
    const nodata = source[i].sampled.nodata;
    out.push(nodata);
    out.push(metersToFeet(nodata));
    out.push(nodata * METERS_PER_SECOND_TO_MPH);
  }
  return out;
}

// Exported so the refusal path, the tmp-then-rename write and the gridsComplete
// conjunction are reachable from a test with a stubbed Deno; every runtime call
// already goes through requireDeno's handle rather than a bare global.
export async function main() {
  const runtime = requireDeno("main");
  const args = parseArgs(runtime.args);

  const sampleReport = JSON.parse(await runtime.readTextFile(args.sample + "/sample-report.json"));
  const gridsReport = JSON.parse(await runtime.readTextFile(args.gridsReport));
  const expectDoc = JSON.parse(await runtime.readTextFile(args.expect));
  const floorsFile = await readJsonIfPresent(runtime, args.floors);
  if (floorsFile === null) {
    throw new Error("build-wave-manifest: could not read the floors file at " + args.floors);
  }
  const previousManifest = await readJsonIfPresent(runtime, args.previous);

  const digest = await gridsDigest();
  console.log("build-wave-manifest: gridsDigest " + digest);

  // Measure every artifact from its own bytes, then rescan the records rather than
  // trusting the sampler's summary.
  const artifacts = [];
  const parsed = {};
  for (let i = 0; i < EXPECTED_WAVE_ARTIFACTS.length; i = i + 1) {
    const key = EXPECTED_WAVE_ARTIFACTS[i];
    const path = args.sample + "/" + key;
    const bytes = await runtime.readFile(path);
    const records = parseNdjson(new TextDecoder().decode(bytes), key);
    parsed[key] = records;
    artifacts.push({
      key: key,
      bytes: bytes.length,
      sha256: await sha256Hex(bytes),
      records: records.length
    });
    console.log("build-wave-manifest: " + key + ": " + String(records.length) +
      " record(s), " + String(bytes.length) + " bytes");
  }

  const stats = scanRecords(parsed[EXPECTED_WAVE_ARTIFACTS[0]],
    parsed[EXPECTED_WAVE_ARTIFACTS[1]], sentinelValues(GRIDS));
  const counts = {
    waveinputRecords: stats.waveinputRecords,
    wavesRecords: stats.wavesRecords
  };
  const validStartEpoch = sampleReport.validStartEpoch;
  const kvExpirationEpoch = validStartEpoch + WAVE_KV_LEASE_SECONDS;

  const history = buildHistory(previousManifest, args.retain);
  const oldest = oldestRetained(history);
  const previousCounts = previousManifest !== null && isPlainObject(previousManifest.beaches)
    ? previousManifest.beaches : null;
  const previousGridCounts = gridCountsFromManifest(previousManifest);
  const oldestGridCounts = isPlainObject(oldest) && isPlainObject(oldest.grids)
    ? oldest.grids : {};

  const verdict = evaluateWaveGates({
    gridStats: sampleReport.grids,
    gridStatus: sampleReport.gridStatus,
    sampleBeaches: sampleReport.beaches,
    expectDoc: expectDoc,
    bands: sampleReport.bands,
    expectedElements: Array.isArray(expectDoc.bands) ? expectDoc.bands : [],
    validStartEpoch: validStartEpoch,
    kvExpirationEpoch: kvExpirationEpoch,
    stats: stats,
    counts: counts,
    floorsFile: floorsFile,
    gridsDigest: digest,
    previousManifest: previousManifest,
    previousCounts: previousCounts,
    previousGridCounts: previousGridCounts,
    oldest: oldest,
    oldestGridCounts: oldestGridCounts,
    allowShrink: args.allowShrink
  });

  for (let i = 0; i < verdict.warnings.length; i = i + 1) {
    console.log("build-wave-manifest: WARNING: " + verdict.warnings[i]);
  }
  if (verdict.refusals.length > 0) {
    for (let i = 0; i < verdict.refusals.length; i = i + 1) {
      console.error("build-wave-manifest: REFUSED: " + verdict.refusals[i].message);
    }
    throw new Error("build-wave-manifest: refusing to publish: " +
      String(verdict.refusals.length) + " gate(s) failed — waves/current.json stays on the " +
      "last good cycle, whose KV rides an expiration derived from its own model valid time");
  }

  const gridEntries = [];
  const gridIds = Object.keys(sampleReport.grids || {});
  for (let i = 0; i < gridIds.length; i = i + 1) {
    const id = gridIds[i];
    const s = sampleReport.grids[id];
    const fetched = isPlainObject(gridsReport.grids) ? gridsReport.grids[id] : null;
    gridEntries.push({
      id: id,
      cycleIso: isPlainObject(fetched) ? fetched.cycleIso : null,
      forecastOffset: isPlainObject(fetched) ? fetched.forecastOffset : null,
      assignedBeaches: s.assignedBeaches,
      resolvedBeaches: s.resolvedBeaches,
      // Carried so the next cycle can score its shrink and decay ratios per grid
      // rather than against a sum in which one grid's collapse hides behind another's
      // growth.
      waveinputRecords: s.waveinputRecords,
      wavesRecords: s.wavesRecords,
      validPercent: s.validPercent,
      ring0Fraction: s.ring0Fraction,
      medianSearchKm: s.medianSearchKm,
      maxSearchKm: s.maxSearchKm,
      identity: s.identity
    });
  }

  const sources = [];
  for (let i = 0; i < gridIds.length; i = i + 1) {
    const fetched = isPlainObject(gridsReport.grids) ? gridsReport.grids[gridIds[i]] : null;
    if (!isPlainObject(fetched)) { continue; }
    sources.push({
      id: gridIds[i], source: fetched.source, cycleIso: fetched.cycleIso,
      files: fetched.files.length, bytes: fetched.totalBytes
    });
  }

  const gfs = isPlainObject(gridsReport.grids) && isPlainObject(gridsReport.grids.noaa_gfswave)
    ? gridsReport.grids.noaa_gfswave.cycleIso : null;
  const glwu = isPlainObject(gridsReport.grids) && isPlainObject(gridsReport.grids.noaa_glwu)
    ? gridsReport.grids.noaa_glwu.cycleIso : null;
  // The oldest contributing cycle, kept separate from generated: freshness is
  // measured against the data, never against the build's own wall clock.
  let dataCutoff = null;
  for (let i = 0; i < sources.length; i = i + 1) {
    const iso = sources[i].cycleIso;
    if (typeof iso !== "string") { continue; }
    if (dataCutoff === null || iso < dataCutoff) { dataCutoff = iso; }
  }

  const manifest = {
    schemaVersion: WAVE_SCHEMA_VERSION,
    cycleId: args.cycleId,
    generated: new Date().toISOString(),
    gitSha: args.gitSha || null,
    workflowRunId: args.runId || null,
    attribution: ATTRIBUTION,
    gfsCycleIso: gfs,
    glwuCycleIso: glwu,
    dataCutoff: dataCutoff,
    validStartIso: sampleReport.validStartIso,
    validStartEpoch: validStartEpoch,
    kvExpirationEpoch: kvExpirationEpoch,
    sources: sources,
    sourcesVerified: gridsReport.problems === undefined || gridsReport.problems.length === 0,
    // Both halves, because they answer different questions: the sample report's own
    // flag says every grid was fetched, and everyGridSampled says every grid produced
    // records. A grid lost at plan or extraction time is fetch-complete and still
    // contributed nothing, and without the second half that cycle reaches
    // src/waveManifest.js as tier "ok" while the beaches it serves age out to
    // unknown.
    gridsComplete: sampleReport.gridsComplete === true &&
      verdict.sanity.everyGridSampled === true,
    tools: {
      gdal: args.gdal || null,
      runnerImage: runnerImageOf(runtime.env.get("ImageOS"), runtime.env.get("ImageVersion")),
      gridsDigest: digest
    },
    gridsDigest: digest,
    grids: gridEntries,
    // Provenance only: one entry per grid in GRIDS saying what this cycle managed to
    // do with it. Never a conjunct of the consumer gate in src/waveManifest.js, where
    // it would refuse a manifest that carries no per-grid counts.
    gridStatus: isPlainObject(sampleReport.gridStatus) ? sampleReport.gridStatus : null,
    beaches: {
      total: sampleReport.beaches.total,
      resolved: sampleReport.beaches.resolved,
      windOnly: sampleReport.beaches.windOnly,
      unresolved: sampleReport.beaches.unresolved,
      waveinputRecords: counts.waveinputRecords,
      wavesRecords: counts.wavesRecords,
      distinctWaveValues: stats.distinctWaveValues,
      meanWaveFt: stats.meanWaveFt,
      maxWaveFt: stats.maxWaveFt,
      minWaveFt: stats.minWaveFt
    },
    artifacts: artifacts,
    history: history,
    sanity: verdict.sanity,
    // Assigned only here, and last. src/waveManifest.js treats any other value as a
    // fatal failure, and this line is reached only after every gate passed, so a
    // manifest claiming completeness earned it. Emitted as the final key, so a torn
    // write cannot produce a file that both parses and claims to be complete.
    buildStatus: "complete"
  };

  const text = JSON.stringify(manifest, null, 2) + "\n";
  await runtime.writeTextFile(args.out + ".tmp", text);
  await runtime.rename(args.out + ".tmp", args.out);

  const sumsPath = args.sample + "/SHA256SUMS";
  await runtime.writeTextFile(sumsPath + ".tmp", sha256SumsText(artifacts));
  await runtime.rename(sumsPath + ".tmp", sumsPath);

  console.log("build-wave-manifest: wrote " + args.out + " and " + sumsPath);
  console.log("build-wave-manifest: autoPublishAllowed=" +
    String(verdict.sanity.autoPublishAllowed) +
    " overridden=" + String(verdict.sanity.overridden) +
    " bootstrap=" + String(verdict.bootstrap) +
    " minimumRecordsPassed=" + String(verdict.sanity.minimumRecordsPassed) +
    " everyGridSampled=" + String(verdict.sanity.everyGridSampled));
}

if (import.meta.main) {
  main().catch(function (err) {
    console.error("build-wave-manifest: FATAL: " + (err && err.stack ? err.stack : err));
    Deno.exit(1);
  });
}
