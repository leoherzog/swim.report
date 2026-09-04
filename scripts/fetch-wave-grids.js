// scripts/fetch-wave-grids.js — downloads the NOAA GRIB2 wave cycle that
// scripts/sample-waves.js consumes, and writes the grids-report.json that records
// exactly which cycle it pinned.
//
//   deno run --allow-net --allow-read --allow-write scripts/fetch-wave-grids.js \
//     --dest ./.waves
//
// This is the ONLY network-touching script in the wave pipeline. Everything
// downstream of it — band planning, point sampling, the gates, the KV pair
// assembly — is pure local math over the bytes this script put on disk, and
// .github/workflows/test.yml asserts that machine-side by refusing --allow-net on
// any of the other three scripts.
//
// CYCLE RESOLUTION HAPPENS AT RUNTIME, NOT BY CRON OFFSET
// -------------------------------------------------------
// validStart is the top of the current UTC hour: the hour the published series
// DESCRIBES. GFS cycles are then walked newest-first back 24 h, and the first cycle
// whose f(k)..f(k+23) all exist is taken, where k is the whole-hour offset from that
// cycle to validStart. Measured publish latency is about T+3h33m and steps run to
// f357, so a 21:52 run resolving to the 12z cycle and sampling f010..f033 is an
// ordinary, healthy outcome — the cadence of the job and the cadence of the model
// are deliberately decoupled. GLWU resolves independently on its own hourly cycle.
//
// NOMADS PACING
// -------------
// NOMADS documents a 10 second wait between scripted fetches. GLWU is therefore ONE
// whole-file fetch of ~22 MB carrying all 49 steps, every NOMADS request is spaced by
// NOMADS_MIN_GAP_MS, and the total is capped. The AWS mirror publishes no such rule
// and is Range-sliced freely.
//
// FAILURE POLICY
// --------------
// A grid in REQUIRED_GRID_IDS that resolves no complete cycle inside its age window
// exits 1 and publishes nothing: the previous cycle's KV rides its lease and the
// flags age out to unknown, which is gray and honest. Any OTHER grid failing is
// recorded as a problem and leaves gridsComplete false, which the consumer gate
// treats as DEGRADED — less data, not wrong data.
//
// Project style: plain JS, ES modules, const/let only, string concatenation with +
// (never template literals), console for logging.

import {
  GRIDS,
  GRID_ELEMENTS,
  FORECAST_HOURS,
  REQUIRED_GRID_IDS,
  gridById
} from "../src/waveGrids.js";

// Re-exported so an importer of this script keeps reaching the same constant the
// plan, the workflow shell and the manifest rail all refuse against.
export { REQUIRED_GRID_IDS };

export const DEFAULT_DEST = "./.waves";

// Per-request wall clock. Generous because the GLWU whole file is ~22 MB over a
// government host, but NOT unbounded: an AbortController is armed unconditionally
// here (unlike src/clients/http.js, where the timeout is optional) because there is
// exactly one caller and a hung socket that never resolves burns the whole workflow
// budget and produces no report at all.
export const FETCH_TIMEOUT_MS = 300000;

// Bounded retries with linear backoff. The failure being absorbed is a transient 5xx
// or a dropped connection, never a wrong path: a 404 on a resolved cycle means the
// object is genuinely not there and retrying it only delays the refusal.
export const FETCH_ATTEMPTS = 3;
export const FETCH_RETRY_BASE_MS = 1000;

// The documented NOMADS spacing between scripted fetches, plus a hard cap on how
// many NOMADS requests one run may make at all.
export const NOMADS_MIN_GAP_MS = 10000;
export const NOMADS_MAX_REQUESTS = 6;

function log(msg) {
  console.error("fetch-wave-grids: " + msg);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseArgs(argv) {
  const args = { dest: DEFAULT_DEST, validStart: null, gridIds: null };
  for (let i = 0; i < argv.length; i = i + 1) {
    const a = argv[i];
    if (a === "--dest") { args.dest = argv[++i]; }
    else if (a === "--valid-start") { args.validStart = argv[++i]; }
    else if (a === "--grids") { args.gridIds = String(argv[++i]).split(","); }
    else { throw new Error("unknown argument: " + a); }
  }
  if (typeof args.dest !== "string" || args.dest === "") {
    throw new Error("fetch-wave-grids: --dest requires a path");
  }
  return args;
}

// --- time and url assembly ---------------------------------------------------------

export function pad3(n) {
  let s = String(n);
  while (s.length < 3) { s = "0" + s; }
  return s;
}

// The hour the published series DESCRIBES: the top of the current UTC hour. Both
// startIso and updated on every emitted record are this value, never the run clock,
// so a cycle republished late cannot claim to be fresher than its data.
export function validStartEpochFor(nowMs) {
  return Math.floor(nowMs / 3600000) * 3600;
}

export function isoFromEpoch(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString();
}

export function compactIso(epochSeconds) {
  const iso = isoFromEpoch(epochSeconds);
  return iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + "T" +
    iso.slice(11, 13) + iso.slice(14, 16) + "Z";
}

export function compactCycle(epochSeconds) {
  const iso = isoFromEpoch(epochSeconds);
  return iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + "T" + iso.slice(11, 13) + "Z";
}

// Substitutes {YYYYMMDD}, {HH} and {FFF} in a grid's urlTemplate. forecastHour is
// ignored for whole-file grids, whose template carries no {FFF}.
export function gridUrl(grid, cycleEpoch, forecastHour) {
  const iso = isoFromEpoch(cycleEpoch);
  const ymd = iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10);
  const hh = iso.slice(11, 13);
  let out = grid.urlTemplate;
  out = out.split("{YYYYMMDD}").join(ymd);
  out = out.split("{HH}").join(hh);
  out = out.split("{FFF}").join(pad3(forecastHour === undefined ? 0 : forecastHour));
  return out;
}

// Cycle epochs for a grid, newest first, from the newest cycle at or before
// validStart back through its own maxCycleAgeHours. Each candidate carries the
// whole-hour offset k from the cycle to validStart, which is the first forecast step
// the 24 h window needs.
export function cycleCandidates(grid, validStartEpoch) {
  const step = grid.cycleStepHours * 3600;
  const newest = Math.floor(validStartEpoch / step) * step;
  const out = [];
  const maxBack = Math.floor(grid.maxCycleAgeHours / grid.cycleStepHours);
  for (let i = 0; i <= maxBack; i = i + 1) {
    const cycleEpoch = newest - i * step;
    const k = (validStartEpoch - cycleEpoch) / 3600;
    if (k < 0) { continue; }
    // A whole-file grid holds a fixed number of steps; a stepped grid must have
    // f(k+23) inside its published range.
    if (k + FORECAST_HOURS > grid.forecastSteps) { continue; }
    out.push({ cycleEpoch: cycleEpoch, cycleIso: isoFromEpoch(cycleEpoch), forecastOffset: k });
  }
  return out;
}

// --- .idx parsing --------------------------------------------------------------------

// A wgrib2 .idx line is "recnum:byteoffset:d=YYYYMMDDHH:ELEMENT:level:forecast:".
// A record's byte range ends at the NEXT record's offset; the last record runs to
// EOF and gets no range end.
//
// Throws rather than degrading: an .idx this code cannot read is a file whose byte
// ranges it cannot compute, and slicing the wrong bytes produces a GRIB2 message
// that decodes cleanly and describes the wrong variable.
export function parseIdx(text) {
  const lines = String(text).split("\n");
  const records = [];
  for (let i = 0; i < lines.length; i = i + 1) {
    const line = lines[i].trim();
    if (line === "") { continue; }
    const parts = line.split(":");
    if (parts.length < 4) {
      throw new Error("fetch-wave-grids: unreadable .idx line: " + line);
    }
    // Digits-only, because Number("") is 0 and finite: a blank offset field would
    // parse as offset 0 and make the PREVIOUS record's end -1, emitting bytes=X--1.
    if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
      throw new Error("fetch-wave-grids: unreadable .idx line: " + line);
    }
    const record = Number(parts[0]);
    const offset = Number(parts[1]);
    if (!isFiniteNumber(record) || !isFiniteNumber(offset)) {
      throw new Error("fetch-wave-grids: unreadable .idx line: " + line);
    }
    records.push({ record: record, offset: offset, element: parts[3], level: parts[4] || "" });
  }
  if (records.length === 0) {
    throw new Error("fetch-wave-grids: .idx is empty");
  }
  // The end chain below assumes ascending offsets. Slicing a file whose .idx
  // offsets do not ascend produces a valid GRIB2 message describing the wrong
  // variable, which is why this throws rather than degrading.
  for (let i = 0; i + 1 < records.length; i = i + 1) {
    if (records[i + 1].offset <= records[i].offset) {
      throw new Error("fetch-wave-grids: .idx offsets must ascend: record " +
        String(records[i].record) + " at " + String(records[i].offset) +
        " is followed by record " + String(records[i + 1].record) + " at " +
        String(records[i + 1].offset));
    }
  }
  for (let i = 0; i < records.length; i = i + 1) {
    records[i].end = i + 1 < records.length ? records[i + 1].offset - 1 : null;
  }
  return records;
}

// The byte ranges for the requested elements at the "surface" level, in ASCENDING
// OFFSET ORDER. Concatenating the slices in file order yields a standalone GRIB2
// file GDAL reads with correct georeferencing and a band order that mirrors the
// original, which is what the bandIdentity gate then asserts.
//
// Missing element -> throw. Slicing a file that does not carry HTSGW yields a valid
// GRIB2 with the wrong variable in the band the sampler reads as wave height.
export function idxRangesFor(records, elements) {
  const out = [];
  for (let e = 0; e < elements.length; e = e + 1) {
    let found = null;
    for (let i = 0; i < records.length; i = i + 1) {
      if (records[i].element === elements[e] && records[i].level === "surface") {
        found = records[i];
        break;
      }
    }
    if (found === null) {
      throw new Error("fetch-wave-grids: .idx carries no surface " + elements[e] + " record");
    }
    out.push({ element: found.element, start: found.offset, end: found.end });
  }
  out.sort(function (a, b) { return a.start - b.start; });
  return out;
}

export function rangeHeaderFor(entry) {
  return "bytes=" + String(entry.start) + "-" + (entry.end === null ? "" : String(entry.end));
}

// --- network --------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// NOMADS pacing state. Every NOMADS request goes through this, so the documented
// 10 s spacing is a property of the module rather than of a caller remembering.
let nomadsLastAt = 0;
let nomadsRequests = 0;

async function paceNomads() {
  nomadsRequests = nomadsRequests + 1;
  if (nomadsRequests > NOMADS_MAX_REQUESTS) {
    throw new Error("fetch-wave-grids: NOMADS request cap (" +
      String(NOMADS_MAX_REQUESTS) + ") reached");
  }
  const wait = nomadsLastAt + NOMADS_MIN_GAP_MS - Date.now();
  if (wait > 0) {
    await sleep(wait);
  }
  nomadsLastAt = Date.now();
}

// One timeout-bounded request with bounded retries. notFoundOk lets the cycle probe
// treat a 404 as an answer ("this step is not published yet") rather than an error;
// on a resolved path a 404 is thrown on the first attempt and never retried.
async function request(url, options) {
  const opts = options || {};
  let lastError = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt = attempt + 1) {
    if (opts.nomads === true) {
      await paceNomads();
    }
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: opts.method || "GET",
        headers: opts.headers || {},
        signal: controller.signal,
        redirect: "follow"
      });
      clearTimeout(timer);
      if (res.status === 404 || res.status === 403) {
        // Drain the body so the connection can be reused rather than left dangling.
        await res.arrayBuffer().catch(function () { return null; });
        if (opts.notFoundOk === true) {
          return { ok: false, status: res.status, bytes: null, headers: res.headers };
        }
        throw new Error("HTTP " + String(res.status) + " for " + url);
      }
      if (!res.ok) {
        await res.arrayBuffer().catch(function () { return null; });
        throw new Error("HTTP " + String(res.status) + " for " + url);
      }
      const bytes = opts.method === "HEAD"
        ? new Uint8Array(0)
        : new Uint8Array(await res.arrayBuffer());
      return { ok: true, status: res.status, bytes: bytes, headers: res.headers };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const message = err && err.message ? err.message : String(err);
      // A 404/403 on a path this caller declared resolved is final.
      if (message.indexOf("HTTP 404") === 0 || message.indexOf("HTTP 403") === 0) {
        throw err;
      }
      log("attempt " + String(attempt) + " of " + String(FETCH_ATTEMPTS) + " failed for " +
        url + ": " + message);
      if (attempt < FETCH_ATTEMPTS) {
        await sleep(FETCH_RETRY_BASE_MS * attempt);
      }
    }
  }
  throw lastError;
}

async function headExists(url, nomads) {
  const res = await request(url, { method: "HEAD", notFoundOk: true, nomads: nomads === true });
  return res.ok;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i = i + 1) {
    const h = view[i].toString(16);
    out = out + (h.length === 1 ? "0" + h : h);
  }
  return out;
}

function concatBytes(chunks) {
  let total = 0;
  for (let i = 0; i < chunks.length; i = i + 1) { total = total + chunks[i].length; }
  const out = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < chunks.length; i = i + 1) {
    out.set(chunks[i], at);
    at = at + chunks[i].length;
  }
  return out;
}

// --- per-grid resolution and download ---------------------------------------------------

async function resolveSteppedCycle(grid, validStartEpoch) {
  const candidates = cycleCandidates(grid, validStartEpoch);
  for (let c = 0; c < candidates.length; c = c + 1) {
    const candidate = candidates[c];
    let complete = true;
    for (let h = 0; h < FORECAST_HOURS; h = h + 1) {
      const url = gridUrl(grid, candidate.cycleEpoch, candidate.forecastOffset + h);
      if (!(await headExists(url, false))) {
        complete = false;
        break;
      }
    }
    if (complete) {
      log(grid.id + ": cycle " + candidate.cycleIso + " covers f" +
        pad3(candidate.forecastOffset) + "..f" +
        pad3(candidate.forecastOffset + FORECAST_HOURS - 1));
      return candidate;
    }
    log(grid.id + ": cycle " + candidate.cycleIso + " is incomplete for this window");
  }
  return null;
}

async function resolveWholeCycle(grid, validStartEpoch) {
  const candidates = cycleCandidates(grid, validStartEpoch);
  for (let c = 0; c < candidates.length; c = c + 1) {
    const candidate = candidates[c];
    const url = gridUrl(grid, candidate.cycleEpoch);
    if (await headExists(url, grid.source === "nomads")) {
      log(grid.id + ": cycle " + candidate.cycleIso + " present (offset f" +
        pad3(candidate.forecastOffset) + ")");
      return candidate;
    }
    log(grid.id + ": cycle " + candidate.cycleIso + " not published");
  }
  return null;
}

async function downloadStepped(grid, candidate, destDir) {
  const files = [];
  for (let h = 0; h < FORECAST_HOURS; h = h + 1) {
    const step = candidate.forecastOffset + h;
    const url = gridUrl(grid, candidate.cycleEpoch, step);
    const idxText = new TextDecoder().decode((await request(url + ".idx", {})).bytes);
    const ranges = idxRangesFor(parseIdx(idxText), GRID_ELEMENTS);
    const chunks = [];
    for (let r = 0; r < ranges.length; r = r + 1) {
      const res = await request(url, { headers: { Range: rangeHeaderFor(ranges[r]) } });
      chunks.push(res.bytes);
    }
    const bytes = concatBytes(chunks);
    const name = "f" + pad3(step) + ".grib2";
    await Deno.writeFile(destDir + "/" + name, bytes);
    const elements = [];
    for (let r = 0; r < ranges.length; r = r + 1) { elements.push(ranges[r].element); }
    files.push({
      name: name,
      hour: h,
      forecastStep: step,
      url: url,
      bytes: bytes.length,
      sha256: await sha256Hex(bytes),
      // Band order in the concatenated file mirrors ascending byte offset, which is
      // the original file order. The bandIdentity gate asserts it rather than
      // trusting it.
      elements: elements
    });
  }
  return files;
}

async function downloadWhole(grid, candidate, destDir) {
  const url = gridUrl(grid, candidate.cycleEpoch);
  const res = await request(url, { nomads: grid.source === "nomads" });
  const name = "cycle.grib2";
  await Deno.writeFile(destDir + "/" + name, res.bytes);
  return [{
    name: name,
    hour: null,
    forecastStep: candidate.forecastOffset,
    url: url,
    bytes: res.bytes.length,
    sha256: await sha256Hex(res.bytes),
    lastModified: res.headers.get("last-modified") || null
  }];
}

// --- main -----------------------------------------------------------------------------

export function selectedGrids(gridIds) {
  if (!Array.isArray(gridIds) || gridIds.length === 0) {
    return GRIDS.slice();
  }
  const out = [];
  for (let i = 0; i < gridIds.length; i = i + 1) {
    const grid = gridById(gridIds[i].trim());
    if (grid === null) {
      throw new Error("fetch-wave-grids: unknown grid id " + gridIds[i]);
    }
    out.push(grid);
  }
  return out;
}

// A required grid's failure ends the cycle with no publication; any other grid's
// failure is recorded and the run continues, so one regional upstream being out costs
// that grid's beaches their records and nothing else.
export function gridFailureIsFatal(gridId, requiredIds) {
  const required = Array.isArray(requiredIds) ? requiredIds : REQUIRED_GRID_IDS;
  return required.indexOf(gridId) !== -1;
}

async function main() {
  const args = parseArgs(Deno.args);
  const nowMs = Date.now();
  const validStartEpoch = args.validStart === null
    ? validStartEpochFor(nowMs)
    : Math.floor(Date.parse(args.validStart) / 1000);
  if (!isFiniteNumber(validStartEpoch)) {
    throw new Error("fetch-wave-grids: --valid-start is not a parseable ISO timestamp");
  }
  await Deno.mkdir(args.dest, { recursive: true });
  log("validStart " + isoFromEpoch(validStartEpoch));

  const grids = selectedGrids(args.gridIds);
  const report = {
    generated: new Date(nowMs).toISOString(),
    validStartIso: isoFromEpoch(validStartEpoch),
    validStartEpoch: validStartEpoch,
    // Compact form for the cycle id, so the workflow never has to re-derive it.
    validStartCompact: compactIso(validStartEpoch),
    forecastHours: FORECAST_HOURS,
    elements: GRID_ELEMENTS.slice(),
    // Every grids-report.json carries this, including the one written on the fatal
    // early-exit path: the workflow shell reads it to decide whether a per-grid
    // failure is fatal, and a shell that hardcoded the id would drift from the
    // refusals the scripts enforce.
    requiredGridIds: REQUIRED_GRID_IDS.slice(),
    grids: {},
    problems: []
  };

  for (let i = 0; i < grids.length; i = i + 1) {
    const grid = grids[i];
    const destDir = args.dest + "/" + grid.id;
    await Deno.mkdir(destDir, { recursive: true });
    try {
      const candidate = grid.fetchMode === "whole"
        ? await resolveWholeCycle(grid, validStartEpoch)
        : await resolveSteppedCycle(grid, validStartEpoch);
      if (candidate === null) {
        throw new Error("no complete cycle inside " + String(grid.maxCycleAgeHours) + " h");
      }
      const files = grid.fetchMode === "whole"
        ? await downloadWhole(grid, candidate, destDir)
        : await downloadStepped(grid, candidate, destDir);
      let total = 0;
      for (let f = 0; f < files.length; f = f + 1) { total = total + files[f].bytes; }
      report.grids[grid.id] = {
        id: grid.id,
        source: grid.source,
        fetchMode: grid.fetchMode,
        cycleIso: candidate.cycleIso,
        cycleEpoch: candidate.cycleEpoch,
        cycleCompact: compactCycle(candidate.cycleEpoch),
        forecastOffset: candidate.forecastOffset,
        dir: destDir,
        totalBytes: total,
        files: files
      };
      log(grid.id + ": " + String(files.length) + " file(s), " + String(total) + " bytes");
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      report.problems.push(grid.id + ": " + message);
      log("PROBLEM " + grid.id + ": " + message);
      if (gridFailureIsFatal(grid.id, REQUIRED_GRID_IDS)) {
        await Deno.writeTextFile(args.dest + "/grids-report.json",
          JSON.stringify(report, null, 2) + "\n");
        log("FATAL: " + grid.id + " is required and could not be resolved — publishing nothing");
        Deno.exit(1);
      }
    }
  }

  report.gridsComplete = report.problems.length === 0;
  await Deno.writeTextFile(args.dest + "/grids-report.json",
    JSON.stringify(report, null, 2) + "\n");
  log("wrote " + args.dest + "/grids-report.json (gridsComplete " +
    String(report.gridsComplete) + ")");
}

// import.meta.main is Deno-only and falsy under vitest/node, so importing the pure
// exports above never reads Deno.args, never touches the network and never writes a
// file.
if (import.meta.main) {
  main().catch(function (err) {
    console.error("fetch-wave-grids: FATAL: " + (err && err.stack ? err.stack : err));
    Deno.exit(1);
  });
}
