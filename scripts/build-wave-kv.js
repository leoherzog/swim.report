// scripts/build-wave-kv.js — applies the fail-closed consumer gate to a published
// wave cycle and, when it passes, emits the wrangler kv bulk put chunk files.
//
//   deno run --allow-read --allow-write scripts/build-wave-kv.js --mode plan \
//     --pointer ./dl/current.json --out ./dl/plan.json
//   deno run --allow-read --allow-write scripts/build-wave-kv.js --mode emit \
//     --dir ./dl --pointer ./dl/current.json --out ./kv
//
// No --allow-net. The workflow shell does the HTTPS reads into a quarantine
// directory nothing else consumes, and this script verifies byte length and
// sha256 against the manifest before a record is parsed. Length is checked as
// well as the digest for a legible message on the likelier failure, a truncated
// transfer.
//
// Units, restated because this file assembles what production reads. Every
// waveHeightFt and hoursFt cell arriving here is already feet (metersToFeet in
// src/geo.js) and every windSpeedMph is already mph (metersPerSecondToMph in
// src/waveGrids.js). windGustMph is always null: gfswave publishes no GUST
// element. Nothing here converts anything, it stringifies and stamps an
// expiration, so a unit error upstream is invisible from this file — which is
// why test/buildWaveKv.test.js pins both conversions directly.
//
// Absolute expiration, never a TTL. Each pair carries
// "expiration": validStartEpoch + 25200, so a key expires 7 h after the hour it
// describes regardless of when the job ran. A TTL measured from write time is
// wrong for a scheduler that skips occurrences: a run firing 9 h late would grant
// 7 more hours of life to data already 9 h old. Republishing an old cycle
// therefore yields a short or negative lease and is refused by construction.
//
// The spelling trap: the pair field is snake_case "expiration" /
// "expiration_ttl". wrangler accepts the Worker runtime's camelCase
// expirationTtl as an unexpected property, warns, ignores it and exits 0,
// producing a key that never expires. Because runFlagRecompute never reads
// waveinput.updated, expiration is the only staleness control on the color path,
// so that key would color flags from dead data indefinitely. ttlSpellingRefusals
// is applied to every emitted pair, and the workflow greps wrangler's output for
// "unexpected properties".

import {
  EXPECTED_WAVE_ARTIFACTS,
  WAVE_KV_LEASE_SECONDS,
  classifyWaveManifestFailure,
  waveKvWriteAllowed
} from "../src/waveManifest.js";
import { gridsDigest } from "../src/waveGrids.js";
import { ttlSpellingRefusals, parseNdjson } from "./build-wave-manifest.js";

// wrangler accepts up to 10,000 pairs and 100 MB per request. 5,000 stays clear
// of both ceilings and keeps a failed chunk cheap to retry.
export const MAX_PAIRS_PER_CHUNK = 5000;

// The pointer is remote input that becomes a URL path, so its charset is constrained
// rather than trusted.
const CYCLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function log(msg) {
  console.error("build-wave-kv: " + msg);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseArgs(argv) {
  const args = { mode: "emit", dir: null, pointer: null, now: null, out: null };
  for (let i = 0; i < argv.length; i = i + 1) {
    const a = argv[i];
    if (a === "--mode") { args.mode = argv[++i]; }
    else if (a === "--dir") { args.dir = argv[++i]; }
    else if (a === "--pointer") { args.pointer = argv[++i]; }
    else if (a === "--now") { args.now = argv[++i]; }
    else if (a === "--out") { args.out = argv[++i]; }
    else { throw new Error("unknown argument: " + a); }
  }
  if (args.mode !== "plan" && args.mode !== "emit") {
    throw new Error("build-wave-kv: --mode must be plan or emit");
  }
  if (typeof args.pointer !== "string" || args.pointer === "") {
    throw new Error("build-wave-kv: --pointer is required");
  }
  if (typeof args.out !== "string" || args.out === "") {
    throw new Error("build-wave-kv: --out is required");
  }
  if (args.mode === "emit" && (typeof args.dir !== "string" || args.dir === "")) {
    throw new Error("build-wave-kv: --dir is required in emit mode");
  }
  return args;
}

// --- pointer -------------------------------------------------------------------------

// Parses waves/current.json and refuses anything that is not a plain, safe pointer.
// Absolute URLs, absolute paths, parent traversal and backslashes are all rejected,
// and the prefix must actually contain the cycleId it claims: a pointer that names
// one cycle and points at another prefix is either a corrupt publish or a tampered
// object, and neither is a cycle to write production KV from.
export function parseWavePointer(text) {
  let pointer = null;
  try {
    pointer = JSON.parse(text);
  } catch (err) {
    throw new Error("build-wave-kv: pointer is not valid JSON: " +
      (err && err.message ? err.message : String(err)));
  }
  if (!isPlainObject(pointer)) {
    throw new Error("build-wave-kv: pointer is not an object");
  }
  const cycleId = pointer.cycleId;
  if (typeof cycleId !== "string" || !CYCLE_ID_PATTERN.test(cycleId)) {
    throw new Error("build-wave-kv: pointer cycleId is missing or malformed");
  }
  const prefix = pointer.prefix;
  if (typeof prefix !== "string" || prefix === "") {
    throw new Error("build-wave-kv: pointer prefix is missing or malformed");
  }
  if (prefix.indexOf("..") !== -1 || prefix.indexOf("\\") !== -1 ||
      prefix.indexOf("://") !== -1 || prefix.charAt(0) === "/" ||
      prefix.charAt(prefix.length - 1) === "/") {
    throw new Error("build-wave-kv: pointer prefix is not a plain relative path: " + prefix);
  }
  if (prefix.indexOf(cycleId) === -1) {
    throw new Error("build-wave-kv: pointer prefix " + prefix +
      " does not contain cycleId " + cycleId);
  }
  return { cycleId: cycleId, prefix: prefix };
}

// --- artifact verification -------------------------------------------------------------

// Returns null when the downloaded bytes match the manifest entry, or a reason
// string. The entry is validated first: bytes and sha256 are the entire integrity
// story for a file this script cannot otherwise judge.
export function verifyArtifact(entry, observed) {
  if (!isPlainObject(entry)) {
    return "manifest describes no entry";
  }
  if (!isFiniteNumber(entry.bytes) || entry.bytes < 0) {
    return entry.key + ": manifest bytes is not a byte count";
  }
  if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
    return entry.key + ": manifest sha256 is not a lowercase 64-hex digest";
  }
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

// The manifest entry for one artifact key, or null. The list of keys comes from
// EXPECTED_WAVE_ARTIFACTS and never from manifest.artifacts[].key: a manifest
// describing a third file is a cycle this code cannot decode, and this keeps
// every downloaded filename a compile-time constant of this repo.
export function manifestArtifact(manifest, key) {
  if (!isPlainObject(manifest) || !Array.isArray(manifest.artifacts)) {
    return null;
  }
  for (let i = 0; i < manifest.artifacts.length; i = i + 1) {
    const entry = manifest.artifacts[i];
    if (isPlainObject(entry) && entry.key === key) {
      return entry;
    }
  }
  return null;
}

// --- the consumer report ----------------------------------------------------------------

// Assembles the object src/waveManifest.js consumes, folding in the two conjuncts
// the producer leaves absent: gridsDigestMatches and secondsRemaining are facts
// about this code and the clock at consume time, not about the cycle.
//
// secondsRemaining is derived from validStartIso, not manifest.kvExpirationEpoch,
// so an unparseable validStartIso yields NaN and fails the range check. That is
// correct: refusing because the age is unknowable is the same answer as refusing
// because it is too old.
export function buildConsumerReport(input) {
  const manifest = isPlainObject(input.manifest) ? input.manifest : null;
  const pointer = isPlainObject(input.pointer) ? input.pointer : null;
  const verified = Array.isArray(input.verified) ? input.verified : [];
  const problems = Array.isArray(input.problems) ? input.problems.slice() : [];
  const sanity = manifest !== null && isPlainObject(manifest.sanity) ? manifest.sanity : null;

  const artifactsPresent = verified.length;
  const artifactsExpected = EXPECTED_WAVE_ARTIFACTS.length;
  const validStartMs = manifest !== null ? Date.parse(manifest.validStartIso) : NaN;
  const secondsRemaining = validStartMs / 1000 + WAVE_KV_LEASE_SECONDS - input.nowEpoch;

  return {
    schemaVersion: manifest !== null ? manifest.schemaVersion : null,
    pointerAgreesWithManifest: pointer !== null && manifest !== null &&
      typeof manifest.cycleId === "string" && manifest.cycleId === pointer.cycleId,
    artifactsVerified: problems.length === 0 && artifactsPresent === artifactsExpected,
    artifactsPresent: artifactsPresent,
    artifactsExpected: artifactsExpected,
    buildStatus: manifest !== null ? manifest.buildStatus : null,
    // Copied verbatim from the build's own verdict: this code never sees a GRIB
    // band and cannot re-derive them, and an absent field refuses fail-closed.
    validTimesPassed: sanity !== null ? sanity.validTimesPassed : null,
    sentinelScanPassed: sanity !== null ? sanity.sentinelScanPassed : null,
    minimumRecordsPassed: sanity !== null ? sanity.minimumRecordsPassed : null,
    sanityOverridden: sanity !== null ? sanity.overridden : null,
    gridsComplete: manifest !== null ? manifest.gridsComplete : null,

    // --- the two conjuncts the producer leaves absent ---------------------------
    gridsDigestMatches: manifest !== null && typeof input.localGridsDigest === "string" &&
      manifest.gridsDigest === input.localGridsDigest,
    secondsRemaining: secondsRemaining,

    // --- provenance -------------------------------------------------------------
    cycleId: pointer !== null ? pointer.cycleId : null,
    prefix: pointer !== null ? pointer.prefix : null,
    validStartIso: manifest !== null ? manifest.validStartIso : null,
    validStartEpoch: manifest !== null ? manifest.validStartEpoch : null,
    kvExpirationEpoch: manifest !== null ? manifest.kvExpirationEpoch : null,
    localGridsDigest: input.localGridsDigest || null,
    // Provenance: what the build managed with each grid. Not a conjunct, because
    // a gate on it would refuse a manifest that carries no per-grid counts.
    gridStatus: manifest !== null && isPlainObject(manifest.gridStatus)
      ? manifest.gridStatus : null,
    artifacts: verified.slice(),
    problems: problems
  };
}

// --- pair assembly -----------------------------------------------------------------------

// One beach's pairs, kept together. Chunking is otherwise free, but a beach's
// waveinput and waves must land in the same request or a partially applied chunk
// set leaves a detail page showing a 24 h strip that disagrees with the flag card
// above it.
export function kvPairGroups(waveinputRecords, wavesRecords, expiration) {
  const groups = [];
  const byBeach = new Map();
  const inputs = Array.isArray(waveinputRecords) ? waveinputRecords : [];
  for (let i = 0; i < inputs.length; i = i + 1) {
    const record = inputs[i];
    if (!isPlainObject(record) || typeof record.beachId !== "string") { continue; }
    const group = [{
      key: "waveinput:" + record.beachId,
      value: JSON.stringify(record),
      expiration: expiration
    }];
    byBeach.set(record.beachId, group);
    groups.push(group);
  }
  const series = Array.isArray(wavesRecords) ? wavesRecords : [];
  for (let i = 0; i < series.length; i = i + 1) {
    const record = series[i];
    if (!isPlainObject(record) || typeof record.beachId !== "string") { continue; }
    const pair = {
      key: "waves:" + record.beachId,
      value: JSON.stringify(record),
      expiration: expiration
    };
    const group = byBeach.get(record.beachId);
    if (group === undefined) {
      // waveRecordsForBeach cannot produce a series with no waveinput, but a
      // hand-edited artifact could; it gets its own group rather than being
      // dropped silently.
      byBeach.set(record.beachId, [pair]);
      groups.push([pair]);
      continue;
    }
    group.push(pair);
  }
  return groups;
}

// Packs whole groups into chunks of at most maxPairs pairs. A group larger than
// maxPairs still ships as one chunk: keeping a beach whole outranks chunk size.
export function chunkGroups(groups, maxPairs) {
  const limit = isFiniteNumber(maxPairs) && maxPairs > 0 ? maxPairs : MAX_PAIRS_PER_CHUNK;
  const chunks = [];
  let current = [];
  const list = Array.isArray(groups) ? groups : [];
  for (let i = 0; i < list.length; i = i + 1) {
    const group = list[i];
    if (current.length > 0 && current.length + group.length > limit) {
      chunks.push(current);
      current = [];
    }
    for (let p = 0; p < group.length; p = p + 1) {
      current.push(group[p]);
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export function chunkFileName(index) {
  let s = String(index);
  while (s.length < 3) { s = "0" + s; }
  return "wave-kv-" + s + ".json";
}

// --- I/O (main only) ------------------------------------------------------------------

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

async function runPlan(args) {
  const pointer = parseWavePointer(await Deno.readTextFile(args.pointer));
  const plan = {
    cycleId: pointer.cycleId,
    prefix: pointer.prefix,
    // manifest.json is fetched too but stays out of SHA256SUMS: it is the gate's
    // sole input and is byte-compared on its own.
    files: ["manifest.json"].concat(EXPECTED_WAVE_ARTIFACTS)
  };
  await Deno.writeTextFile(args.out, JSON.stringify(plan, null, 2) + "\n");
  log("plan: prefix " + pointer.prefix + ", " + String(plan.files.length) + " file(s)");
}

async function runEmit(args) {
  const pointer = parseWavePointer(await Deno.readTextFile(args.pointer));
  const nowEpoch = args.now === null
    ? Math.floor(Date.now() / 1000)
    : Math.floor(Date.parse(args.now) / 1000);

  let manifest = null;
  const problems = [];
  try {
    manifest = JSON.parse(await Deno.readTextFile(args.dir + "/manifest.json"));
  } catch (err) {
    problems.push("manifest.json is not readable JSON");
  }

  const verified = [];
  const parsed = {};
  for (let i = 0; i < EXPECTED_WAVE_ARTIFACTS.length; i = i + 1) {
    const key = EXPECTED_WAVE_ARTIFACTS[i];
    const entry = manifestArtifact(manifest, key);
    let bytes = null;
    try {
      bytes = await Deno.readFile(args.dir + "/" + key);
    } catch (err) {
      problems.push(key + ": not downloaded");
      continue;
    }
    const observed = { bytes: bytes.length, sha256: await sha256Hex(bytes) };
    const problem = verifyArtifact(entry, observed);
    if (problem !== null) {
      problems.push(problem);
      log("REFUSED " + problem);
      continue;
    }
    parsed[key] = parseNdjson(new TextDecoder().decode(bytes), key);
    verified.push({ key: key, bytes: observed.bytes, sha256: observed.sha256 });
    log("verified " + key + " (" + String(observed.bytes) + " bytes, " +
      String(parsed[key].length) + " records)");
  }

  const report = buildConsumerReport({
    manifest: manifest,
    pointer: pointer,
    verified: verified,
    problems: problems,
    nowEpoch: nowEpoch,
    localGridsDigest: await gridsDigest()
  });

  const failure = classifyWaveManifestFailure(report);
  log("gate tier: " + failure.tier);
  for (let i = 0; i < failure.reasons.length; i = i + 1) {
    log("  " + failure.reasons[i]);
  }

  await Deno.mkdir(args.out, { recursive: true });
  const summary = {
    cycleId: report.cycleId,
    tier: failure.tier,
    reasons: failure.reasons,
    writeAllowed: waveKvWriteAllowed(report),
    validStartIso: report.validStartIso,
    kvExpirationEpoch: report.kvExpirationEpoch,
    secondsRemaining: report.secondsRemaining,
    minimumRecordsPassed: report.minimumRecordsPassed,
    gridStatus: report.gridStatus,
    pairs: 0,
    chunks: 0
  };

  if (!waveKvWriteAllowed(report)) {
    await Deno.writeTextFile(args.out + "/kv-report.json",
      JSON.stringify(summary, null, 2) + "\n");
    log("REFUSED: writing no KV — the previous cycle rides its own expiration and the " +
      "flags age out to unknown, which is gray and honest");
    Deno.exit(1);
  }

  const groups = kvPairGroups(parsed[EXPECTED_WAVE_ARTIFACTS[0]],
    parsed[EXPECTED_WAVE_ARTIFACTS[1]], report.kvExpirationEpoch);
  const chunks = chunkGroups(groups, MAX_PAIRS_PER_CHUNK);

  let pairCount = 0;
  for (let i = 0; i < chunks.length; i = i + 1) {
    const spelling = ttlSpellingRefusals({
      validStartEpoch: report.validStartEpoch,
      kvExpirationEpoch: report.kvExpirationEpoch,
      pairs: chunks[i]
    });
    if (spelling.length > 0) {
      for (let r = 0; r < spelling.length; r = r + 1) {
        console.error("build-wave-kv: REFUSED: " + spelling[r].message);
      }
      throw new Error("build-wave-kv: chunk " + String(i) + " failed the pair-spelling gate");
    }
    await Deno.writeTextFile(args.out + "/" + chunkFileName(i),
      JSON.stringify(chunks[i]) + "\n");
    pairCount = pairCount + chunks[i].length;
  }

  summary.pairs = pairCount;
  summary.chunks = chunks.length;
  await Deno.writeTextFile(args.out + "/kv-report.json",
    JSON.stringify(summary, null, 2) + "\n");
  log("wrote " + String(pairCount) + " pair(s) in " + String(chunks.length) +
    " chunk(s), expiration " + String(report.kvExpirationEpoch) +
    " (" + String(Math.round(report.secondsRemaining)) + "s remaining)");
}

async function main() {
  const args = parseArgs(Deno.args);
  if (args.mode === "plan") {
    await runPlan(args);
    return;
  }
  await runEmit(args);
}

if (import.meta.main) {
  main().catch(function (err) {
    console.error("build-wave-kv: FATAL: " + (err && err.stack ? err.stack : err));
    Deno.exit(1);
  });
}
