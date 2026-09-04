// scripts/fetch-layers.js — downloads and VERIFIES the prebuilt FlatGeobuf
// layer set that scripts/discovery-batch.js consumes, and writes the
// report.json that src/layerManifest.js turns into a delete-path verdict.
//
//   deno run --allow-net --allow-read --allow-write scripts/fetch-layers.js --dest ./.layers
//
// The only network-touching script in the offline path. Everything downstream of
// it — discovery, park association, water-body classification, the marine pass,
// reconciliation — is pure local math over the bytes this script put on disk.
// That split is the point: the job that can delete production rows runs with no
// network permission at all, so the only way a network failure can influence a
// delete is through the report written here.
//
// The buildId is pinned exactly once. layers/current.json is the single mutable
// object in the bucket and every per-build prefix under it is immutable, so this
// script reads the pointer one time, with a cache-buster, logs the buildId, and
// derives every subsequent URL from that one pinned prefix. Re-read the pointer
// per file and a build completing mid-run hands you three layers from set A and
// seven from set B: a set that passes every checksum, since each file matches its
// own manifest, while describing a world that never existed. The per-region
// counts would then measure one build against another build's manifest and the
// proportional delete rails would be comparing noise.
//
// The download list comes from the code, not the manifest: the keys fetched are
// EXPECTED_LAYER_KEYS from src/layerManifest.js, never manifest.layers[].key. A
// manifest describing nine layers is not a nine-layer set to consume as-is, it is
// a set this code cannot decode, and it must refuse fatally rather than quietly
// discover with a layer missing. That also keeps the download paths untainted by
// remote input: every written filename is a compile-time constant of this repo.
//
// This script computes exactly the report fields that are facts about the fetch:
// pointerAgreesWithManifest, layersVerified, layersPresent/layersExpected,
// layerKeys and the parks-health inputs. It copies the build's own verdicts
// (schemaVersion, buildStatus, sourcesVerified, sanity) through verbatim.
//
// It does not compute regionsDigestMatches or sourceAgeDays. Those are facts
// about the consuming code and the clock at consume time, and
// scripts/discovery-batch.js folds them into the same report object before
// calling the gate. They are absent here on purpose rather than stubbed, because
// src/layerManifest.js is fail-closed on missing fields: if that fold is ever
// dropped, deletes refuse, which is the safe direction. A stubbed literal true
// would arm the delete path with an unproven claim.
//
// Exit status: 1 on any fatal conjunct, 0 otherwise. A "scope_or_stale" verdict
// at this stage is structural and expected, not an error.

import {
  EXPECTED_LAYER_KEYS,
  classifyManifestFailure,
  parksLayerHealthy
} from "../src/layerManifest.js";

// The public R2 domain. Plain public HTTPS on purpose: the discovery workflow
// holds no R2 credentials, a deliberate blast-radius reduction for the only job
// in the repo that can delete production rows. The layer set is public derived
// OSM data; its integrity comes from the manifest checksums, not from a
// privileged transport.
export const DEFAULT_LAYERS_BASE = "https://map.swim.report";

// The single mutable object in the bucket.
export const POINTER_PATH = "layers/current.json";

export const DEFAULT_DEST = "./.layers";

// Read for the parks floors of parksLayerHealthy. Repo-committed, keyed by
// regionsDigest — see the file's own _readme.
export const DEFAULT_FLOORS_PATH = "data/layer-floors.json";

// Per-request wall clock, generous because the water layers are the better part of
// a hundred megabytes over a CDN, but never unbounded: a hung socket burns the
// workflow's whole budget and the run dies with no report at all, which reads
// downstream as "no layer set" rather than "the CDN stalled".
export const FETCH_TIMEOUT_MS = 300000;

// Bounded retries with linear backoff, absorbing a transient CDN 5xx or a dropped
// connection but not a wrong pointer: a 404 on the pinned prefix means the set is
// genuinely not there.
export const FETCH_ATTEMPTS = 3;
export const FETCH_RETRY_BASE_MS = 1000;

// A build id is a filesystem and URL path segment. Constraining its charset stops
// a poisoned or corrupt pointer from steering the download, and the writes,
// anywhere but under layers/<buildId>/.
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function log(msg) {
  console.error("fetch-layers: " + msg);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseArgs(argv) {
  const args = {
    dest: DEFAULT_DEST,
    base: DEFAULT_LAYERS_BASE,
    floors: DEFAULT_FLOORS_PATH
  };
  for (let i = 0; i < argv.length; i = i + 1) {
    const a = argv[i];
    if (a === "--dest") { args.dest = argv[++i]; }
    else if (a === "--base") { args.base = argv[++i]; }
    else if (a === "--floors") { args.floors = argv[++i]; }
    else { throw new Error("unknown argument: " + a); }
  }
  if (typeof args.dest !== "string" || args.dest === "") {
    throw new Error("fetch-layers: --dest requires a path");
  }
  if (typeof args.base !== "string" || args.base === "") {
    throw new Error("fetch-layers: --base requires a URL");
  }
  return args;
}

// --- URL and path assembly ------------------------------------------------------

// Trailing slashes on --base are the one input shape a human types by accident.
// Normalising once here keeps every joined URL free of "//" segments, which R2
// treats as a distinct and absent key rather than folding away.
export function normalizeBase(base) {
  let out = String(base);
  while (out.length > 1 && out.charAt(out.length - 1) === "/") {
    out = out.slice(0, out.length - 1);
  }
  return out;
}

export function joinPath(dir, name) {
  let out = String(dir);
  while (out.length > 1 && out.charAt(out.length - 1) === "/") {
    out = out.slice(0, out.length - 1);
  }
  return out + "/" + name;
}

export function pointerUrl(base, cacheBuster) {
  return normalizeBase(base) + "/" + POINTER_PATH + "?cb=" + String(cacheBuster);
}

// Every object under the pinned prefix goes through this one function, so deriving
// from that one prefix is enforced by construction rather than by three call sites
// remembering to concatenate the same variable. No cache-buster: these keys are
// immutable, so caching them is a pure win.
export function prefixUrl(base, prefix, name) {
  return normalizeBase(base) + "/" + prefix + "/" + name;
}

export function manifestUrl(base, prefix) {
  return prefixUrl(base, prefix, "manifest.json");
}

export function layerUrl(base, prefix, key) {
  return prefixUrl(base, prefix, key);
}

// --- pointer parsing ------------------------------------------------------------

// Parses layers/current.json and refuses anything that is not a plain, safe
// pointer. The prefix is remote input that becomes a URL path and, indirectly, the
// provenance of local writes, so it is validated rather than trusted: absolute
// URLs, absolute paths, parent traversal and backslashes are all rejected, and the
// prefix must contain the buildId it claims. A pointer naming one build and
// pointing at another prefix is either a corrupt publish or a tampered object.
export function parsePointer(text) {
  let pointer = null;
  try {
    pointer = JSON.parse(text);
  } catch (err) {
    throw new Error("fetch-layers: pointer is not valid JSON: " + (err && err.message ? err.message : String(err)));
  }
  if (!isPlainObject(pointer)) {
    throw new Error("fetch-layers: pointer is not an object");
  }
  const buildId = pointer.buildId;
  if (typeof buildId !== "string" || !BUILD_ID_PATTERN.test(buildId)) {
    throw new Error("fetch-layers: pointer buildId is missing or malformed");
  }
  const prefix = pointer.prefix;
  if (typeof prefix !== "string" || prefix === "") {
    throw new Error("fetch-layers: pointer prefix is missing or malformed");
  }
  if (prefix.indexOf("..") !== -1 || prefix.indexOf("\\") !== -1 ||
      prefix.indexOf("://") !== -1 || prefix.charAt(0) === "/" ||
      prefix.charAt(prefix.length - 1) === "/") {
    throw new Error("fetch-layers: pointer prefix is not a plain relative path: " + prefix);
  }
  if (prefix.indexOf(buildId) === -1) {
    throw new Error("fetch-layers: pointer prefix " + prefix + " does not contain buildId " + buildId);
  }
  return { buildId: buildId, prefix: prefix };
}

// --- expected-key checking ------------------------------------------------------

// Reconciles manifest.layers against EXPECTED_LAYER_KEYS and validates each
// described layer's integrity fields. Returns a plan rather than throwing: the
// diagnosis belongs in report.json, and therefore in the run log and the gate's
// reason strings, not in a stack trace that says only "bad manifest".
//
// The entries come back in EXPECTED_LAYER_KEYS order, not manifest order, so the
// download sequence and the run log are stable across builds.
export function planDownloads(manifest) {
  const problems = [];
  const entries = [];
  if (!isPlainObject(manifest)) {
    return { entries: entries, problems: ["manifest is not an object"] };
  }
  if (!Array.isArray(manifest.layers)) {
    return { entries: entries, problems: ["manifest.layers is not an array"] };
  }
  const byKey = new Map();
  for (let i = 0; i < manifest.layers.length; i = i + 1) {
    const layer = manifest.layers[i];
    if (!isPlainObject(layer) || typeof layer.key !== "string" || layer.key === "") {
      problems.push("manifest.layers[" + String(i) + "] has no key");
      continue;
    }
    if (byKey.has(layer.key)) {
      problems.push("manifest describes " + layer.key + " twice");
      continue;
    }
    byKey.set(layer.key, layer);
    if (EXPECTED_LAYER_KEYS.indexOf(layer.key) === -1) {
      // Not fatal on its own, since the count and key conjuncts in the gate
      // decide, but always a code/build drift worth naming out loud.
      problems.push("manifest describes unexpected layer " + layer.key);
    }
  }
  for (let i = 0; i < EXPECTED_LAYER_KEYS.length; i = i + 1) {
    const key = EXPECTED_LAYER_KEYS[i];
    const layer = byKey.get(key);
    if (layer === undefined) {
      problems.push("manifest does not describe " + key);
      continue;
    }
    // bytes and sha256 are the entire integrity story for a file this script
    // cannot otherwise judge, so a manifest that omits or mistypes either one
    // cannot be verified against.
    if (!isFiniteNumber(layer.bytes) || layer.bytes < 0) {
      problems.push(key + ": manifest bytes is not a byte count");
      continue;
    }
    if (typeof layer.sha256 !== "string" || !SHA256_PATTERN.test(layer.sha256)) {
      problems.push(key + ": manifest sha256 is not a lowercase 64-hex digest");
      continue;
    }
    entries.push({
      key: key,
      bytes: layer.bytes,
      sha256: layer.sha256,
      featureCount: isFiniteNumber(layer.featureCount) ? layer.featureCount : null
    });
  }
  return { entries: entries, problems: problems };
}

// Returns null when the downloaded bytes match the manifest entry, or a reason
// string. Both length and digest are checked, not because a sha256 match could
// coexist with a wrong length but because the length check produces a legible
// message for the likelier failure, a truncated transfer, instead of an
// inscrutable digest mismatch.
export function verifyLayer(entry, observed) {
  if (!isPlainObject(observed)) {
    return entry.key + ": nothing downloaded";
  }
  if (observed.bytes !== entry.bytes) {
    return entry.key + ": expected " + String(entry.bytes) + " bytes, got " +
      String(observed.bytes);
  }
  if (String(observed.sha256).toLowerCase() !== entry.sha256.toLowerCase()) {
    return entry.key + ": sha256 mismatch (expected " + entry.sha256 + ", got " +
      String(observed.sha256) + ")";
  }
  return null;
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

// --- parks health inputs --------------------------------------------------------

// Assembles report.parks, the six numbers parksLayerHealthy(report) consumes as
// hasPark in scripts/discovery-batch.js.
//
// Every value is passed through exactly as found, including null.
// parksLayerHealthy requires all six to be finite numbers and returns false
// otherwise, so a bootstrap set with no history and unseeded floors resolves to
// hasPark false and the run leaves park_name untouched on every existing row: the
// intended, self-healing bootstrap cost, since the next build carries history and
// the valve opens. Substituting 0 for a missing floor would convert "we have no
// baseline" into "every baseline is satisfied", the exact inversion the gate
// exists to prevent.
//
// The floors are looked up under the manifest's regionsDigest, not the local
// code's. parksLayerHealthy asks whether this build's parks layer is well
// populated for the footprint it was built for, and the floors seeded for that
// footprint are the only correct basis. Whether that footprint is also this
// code's is a different question, asked by regionsDigestMatches.
export function parksReportInput(manifest, floorsDoc) {
  const parks = {
    polygonCount: null,
    lineCount: null,
    polygonFloor: null,
    lineFloor: null,
    previousPolygonCount: null,
    previousLineCount: null
  };
  if (!isPlainObject(manifest)) {
    return parks;
  }
  parks.polygonCount = manifestLayerCount(manifest, "parks-polygon.fgb");
  parks.lineCount = manifestLayerCount(manifest, "parks-line.fgb");

  const digest = typeof manifest.regionsDigest === "string" ? manifest.regionsDigest : null;
  if (digest !== null && isPlainObject(floorsDoc) && isPlainObject(floorsDoc.floors)) {
    const entry = floorsDoc.floors[digest];
    if (isPlainObject(entry) && isPlainObject(entry.layers)) {
      parks.polygonFloor = numberOrNull(entry.layers["parks-polygon.fgb"]);
      parks.lineFloor = numberOrNull(entry.layers["parks-line.fgb"]);
    }
  }

  // manifest.history is newest last, so the previous build is the final element.
  // Reading it from the wrong end would compare this build against the oldest
  // retained one, which is the monotone-decay check and build-manifest.js's job.
  if (Array.isArray(manifest.history) && manifest.history.length > 0) {
    const previous = manifest.history[manifest.history.length - 1];
    if (isPlainObject(previous) && isPlainObject(previous.layers)) {
      parks.previousPolygonCount = numberOrNull(previous.layers["parks-polygon.fgb"]);
      parks.previousLineCount = numberOrNull(previous.layers["parks-line.fgb"]);
    }
  }
  return parks;
}

function numberOrNull(value) {
  return isFiniteNumber(value) ? value : null;
}

function manifestLayerCount(manifest, key) {
  if (!Array.isArray(manifest.layers)) {
    return null;
  }
  for (let i = 0; i < manifest.layers.length; i = i + 1) {
    const layer = manifest.layers[i];
    if (isPlainObject(layer) && layer.key === key) {
      return numberOrNull(layer.featureCount);
    }
  }
  return null;
}

// --- report assembly ------------------------------------------------------------

// Builds the report object src/layerManifest.js consumes and this script writes
// to <dest>/report.json.
//
// input = {
//   pointer:   { buildId, prefix } | null,
//   manifest:  the parsed manifest.json | null,
//   base, dest, fetchedAt,
//   downloaded: [ { key, bytes, sha256 } ],   // what actually landed on disk
//   problems:  string[],                      // plan + verification failures
//   floorsDoc: the parsed data/layer-floors.json | null
// }
//
// regionsDigestMatches and sourceAgeDays are deliberately absent:
// scripts/discovery-batch.js folds them in, and their absence is fail-closed.
export function buildReport(input) {
  const manifest = isPlainObject(input.manifest) ? input.manifest : null;
  const pointer = isPlainObject(input.pointer) ? input.pointer : null;
  const downloaded = Array.isArray(input.downloaded) ? input.downloaded : [];
  const problems = Array.isArray(input.problems) ? input.problems.slice() : [];

  const layerKeys = [];
  for (let i = 0; i < downloaded.length; i = i + 1) {
    layerKeys.push(downloaded[i].key);
  }

  const sanity = manifest !== null && isPlainObject(manifest.sanity) ? manifest.sanity : null;
  // Every sanity gate the build publishes must be read here, not a subset: a gate
  // computed and then dropped can refuse without the delete gate hearing about it.
  //
  // sanity.overridden is the load-bearing one and the least obvious. A
  // workflow_dispatch with allow_shrink true moves a gate's refusals into
  // warnings, and countUnrefused() in build-manifest.js then reports that gate as
  // passed, so under an override every individual flag above still reads true and
  // an overridden build is indistinguishable from a clean one here. overridden is
  // the only field that still says a human bypassed a refusal, and a bypassed
  // sanity gate must not silently authorize deletes on the next discovery run.
  const buildSanityPassed = sanity !== null &&
    sanity.absoluteFloorsPassed === true &&
    sanity.regionFloorsPassed === true &&
    sanity.shrinkRatiosPassed === true &&
    sanity.decayPassed === true &&
    sanity.integrityPassed === true &&
    sanity.passed === true &&
    sanity.overridden !== true;

  const pointerAgreesWithManifest = pointer !== null && manifest !== null &&
    typeof manifest.buildId === "string" && manifest.buildId === pointer.buildId;

  const layersPresent = layerKeys.length;
  const layersExpected = EXPECTED_LAYER_KEYS.length;

  // layersVerified is the conjunction of "nothing went wrong anywhere in the fetch"
  // and "the set is complete". It is deliberately not "no digest mismatched": a
  // manifest that failed to describe a layer produces zero digest mismatches and a
  // set that cannot be discovered from.
  const layersVerified = problems.length === 0 && layersPresent === layersExpected;

  const report = {
    // --- the gate's fatal conjuncts -----------------------------------------
    schemaVersion: manifest !== null ? manifest.schemaVersion : null,
    pointerAgreesWithManifest: pointerAgreesWithManifest,
    layersVerified: layersVerified,
    layersPresent: layersPresent,
    layersExpected: layersExpected,
    layerKeys: layerKeys,

    // --- the gate's incompleteness conjuncts, copied through verbatim -------
    buildStatus: manifest !== null ? manifest.buildStatus : null,
    sourcesVerified: manifest !== null ? manifest.sourcesVerified : null,
    buildSanityPassed: buildSanityPassed,

    // --- hasPark -------------------------------------------------------------
    parks: parksReportInput(manifest, input.floorsDoc),

    // --- provenance, for discovery-batch.js and for humans reading the log ---
    // buildId, prefix and base make the run reproducible from the log alone;
    // oldestSourceTimestamp and regionsDigest are the inputs discovery-batch.js
    // needs for the two conjuncts it owns, and carrying them here spares it a
    // second read of manifest.json.
    buildId: pointer !== null ? pointer.buildId : null,
    prefix: pointer !== null ? pointer.prefix : null,
    base: typeof input.base === "string" ? input.base : null,
    dest: typeof input.dest === "string" ? input.dest : null,
    generated: manifest !== null ? (manifest.generated || null) : null,
    oldestSourceTimestamp: manifest !== null ? (manifest.oldestSourceTimestamp || null) : null,
    regionsDigest: manifest !== null ? (manifest.regionsDigest || null) : null,
    attribution: manifest !== null ? (manifest.attribution || null) : null,
    fetchedAt: typeof input.fetchedAt === "string" ? input.fetchedAt : null,
    layers: downloaded.slice(),
    problems: problems
  };
  return report;
}

// --- network --------------------------------------------------------------------

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Every request is timeout-bounded, with the AbortController armed
// unconditionally: a hung transfer consumes the whole workflow budget and
// produces no report at all.
async function fetchBytes(url, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt = attempt + 1) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!res.ok) {
        throw new Error("HTTP " + String(res.status) + " for " + url);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      clearTimeout(timer);
      return bytes;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      log(label + ": attempt " + String(attempt) + " of " + String(FETCH_ATTEMPTS) +
        " failed: " + (err && err.message ? err.message : String(err)));
      if (attempt < FETCH_ATTEMPTS) {
        await sleep(FETCH_RETRY_BASE_MS * attempt);
      }
    }
  }
  throw lastError;
}

async function fetchText(url, label) {
  const bytes = await fetchBytes(url, label);
  return new TextDecoder().decode(bytes);
}

// data/layer-floors.json is repo-committed and its absence is an operational
// oddity rather than a fatal one: parksLayerHealthy treats a missing floor as
// unproven, which resolves hasPark to false and leaves park_name alone. So this
// warns and continues rather than taking the run down.
async function readFloors(path) {
  try {
    const text = await Deno.readTextFile(path);
    return JSON.parse(text);
  } catch (err) {
    log("WARNING: could not read floors file " + path + ": " +
      (err && err.message ? err.message : String(err)));
    return null;
  }
}

// --- main -----------------------------------------------------------------------

async function main() {
  const args = parseArgs(Deno.args);
  const base = normalizeBase(args.base);
  const fetchedAt = new Date().toISOString();
  await Deno.mkdir(args.dest, { recursive: true });

  // One pointer read, with a cache-buster, before anything else. The pointer is
  // served no-store, but the cache-buster costs nothing and removes any doubt
  // about an intermediary.
  const cacheBuster = String(Date.now()) + "-" + String(Math.floor(Math.random() * 1000000));
  const pointerText = await fetchText(pointerUrl(base, cacheBuster), "pointer");
  const pointer = parsePointer(pointerText);
  log("buildId " + pointer.buildId + " (prefix " + pointer.prefix + ")");

  const manifestText = await fetchText(manifestUrl(base, pointer.prefix), "manifest");
  await Deno.writeTextFile(joinPath(args.dest, "manifest.json"), manifestText);
  let manifest = null;
  try {
    manifest = JSON.parse(manifestText);
  } catch (err) {
    // A manifest that will not parse is an undecodable set. Write the report
    // anyway so the failure is legible in the artifact, then exit non-zero below
    // via the fatal tier.
    log("manifest is not valid JSON: " + (err && err.message ? err.message : String(err)));
    manifest = null;
  }

  const plan = planDownloads(manifest);
  const problems = plan.problems.slice();
  const downloaded = [];
  for (let i = 0; i < plan.entries.length; i = i + 1) {
    const entry = plan.entries[i];
    const bytes = await fetchBytes(layerUrl(base, pointer.prefix, entry.key), entry.key);
    const observed = { bytes: bytes.length, sha256: await sha256Hex(bytes) };
    const problem = verifyLayer(entry, observed);
    if (problem !== null) {
      // A file that does not match its manifest entry is never written to disk:
      // leaving it behind would let a later re-run, or a human poking at the
      // directory, mistake it for a verified layer.
      problems.push(problem);
      log("REFUSED " + problem);
      continue;
    }
    await Deno.writeFile(joinPath(args.dest, entry.key), bytes);
    downloaded.push({ key: entry.key, bytes: observed.bytes, sha256: observed.sha256 });
    log("verified " + entry.key + " (" + String(observed.bytes) + " bytes, " +
      String(entry.featureCount === null ? "?" : entry.featureCount) + " features)");
  }

  const floorsDoc = await readFloors(args.floors);
  const report = buildReport({
    pointer: pointer,
    manifest: manifest,
    base: base,
    dest: args.dest,
    fetchedAt: fetchedAt,
    downloaded: downloaded,
    problems: problems,
    floorsDoc: floorsDoc
  });
  await Deno.writeTextFile(joinPath(args.dest, "report.json"),
    JSON.stringify(report, null, 2) + "\n");

  log("layers " + String(report.layersPresent) + "/" + String(report.layersExpected) +
    ", verified " + String(report.layersVerified) +
    ", pointer agrees " + String(report.pointerAgreesWithManifest));
  log("parksLayerHealthy " + String(parksLayerHealthy(report)) +
    " (polygon " + String(report.parks.polygonCount) +
    ", line " + String(report.parks.lineCount) + ")");
  for (let i = 0; i < problems.length; i = i + 1) {
    log("problem: " + problems[i]);
  }

  const failure = classifyManifestFailure(report);
  log("gate tier at fetch time: " + failure.tier);
  for (let i = 0; i < failure.reasons.length; i = i + 1) {
    log("  " + failure.reasons[i]);
  }
  // Printed unconditionally, including under a fatal verdict: the reason list
  // above always carries an unproven regionsDigestMatches and an unproven
  // sourceAgeDays, because this script computes neither. Without this line an
  // operator reads two alarming reasons that are structural, at exactly the
  // moment the log must not mislead.
  log("note: regionsDigestMatches and sourceAgeDays are evaluated by " +
    "discovery-batch.js, not here — they are unproven above by construction");
  if (failure.tier === "fatal") {
    log("FATAL: this layer set cannot be decoded — refusing to hand it to the batch");
    Deno.exit(1);
  }
  log("wrote " + joinPath(args.dest, "report.json"));
}

if (import.meta.main) {
  main().catch(function (err) {
    console.error("fetch-layers: FATAL: " + (err && err.stack ? err.stack : err));
    Deno.exit(1);
  });
}
