// scripts/build-wave-sql.js — applies the fail-closed consumer gate to a sampled
// wave cycle and, when it passes, emits the SQL delta that writes each beach's
// wave record into beach_state.
//
//   deno run --allow-read --allow-write scripts/build-wave-sql.js \
//     --dir ./cycle --out ./sql
//
// --dir holds manifest.json and the two NDJSON artifacts, handed from the sample
// job to the publish-d1 job as a workflow artifact. No --allow-net. Every artifact
// is verified by byte length and sha256 against the manifest before a record is
// parsed, so a truncated or mismatched file is refused rather than measured as a
// legitimate shrink. Length is checked as well as the digest for a legible message
// on the likelier failure, a truncated transfer.
//
// Units, restated because this file assembles what production reads. Every
// waveHeightFt and hoursFt cell arriving here is already feet (metersToFeet in
// src/geo.js) and every windSpeedMph is already mph (metersPerSecondToMph in
// src/waveGrids.js). windGustMph is always null: gfswave publishes no GUST
// element. Nothing here converts anything, it stringifies and stamps an
// expiration, so a unit error upstream is invisible from this file — which is
// why test/buildWaveSql.test.js pins both conversions directly.
//
// Absolute expiration, never a TTL, and one of two leases per record. A record
// carrying the hourly series expires at validStartEpoch + WAVE_SERIES_LEASE_SECONDS,
// the span it describes, because runFlagRecompute indexes it at the hour it is
// estimating (src/waveInput.js). A wind-only record is one hour-0 sample with no
// series behind it and keeps the short validStartEpoch + WAVE_SCALAR_LEASE_SECONDS.
// Either way the lease is measured from the model valid time and not from the write
// clock: a TTL from write time is wrong for a scheduler that skips occurrences,
// since a run firing 9 h late would grant a fresh lease to data already 9 h old.
// Republishing an old cycle therefore yields a short or negative lease and is
// refused by construction.
//
// The delta's own traps. wave_expires is a column value, so a malformed lease
// fails the statement rather than being dropped with a warning — but only
// waveRowRefusals proves the number is one of the cycle's two computed epochs and
// is still in the future, and it runs before any file is written. Every statement
// is one line, because scripts/apply-local-sql.js splits on line boundaries only
// and hard-fails on a line over its chunk cap. The upsert is idempotent, so
// re-applying the same delta repairs a half-landed import and writes the same
// absolute wave_expires, which is correct: the lease is anchored to the model
// valid time, never to the apply clock.

import {
  EXPECTED_WAVE_ARTIFACTS,
  WAVE_SERIES_LEASE_SECONDS,
  classifyWaveManifestFailure,
  waveWriteAllowed
} from "../src/waveManifest.js";
import { gridsDigest } from "../src/waveGrids.js";
import { parseNdjson } from "./build-wave-manifest.js";

// A single beach's record approaching this size is a data-shape bug the sampler
// and sentinelRefusals should have caught, so an oversize statement is a refusal
// rather than a reason to split. Sized under scripts/apply-local-sql.js's 90,000
// byte chunk cap, itself under D1's 100,000 byte SQL call cap.
export const MAX_STATEMENT_BYTES = 80000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function log(msg) {
  console.error("build-wave-sql: " + msg);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseArgs(argv) {
  const args = { dir: null, now: null, out: null };
  for (let i = 0; i < argv.length; i = i + 1) {
    const a = argv[i];
    if (a === "--dir") { args.dir = argv[++i]; }
    else if (a === "--now") { args.now = argv[++i]; }
    else if (a === "--out") { args.out = argv[++i]; }
    else { throw new Error("unknown argument: " + a); }
  }
  if (typeof args.dir !== "string" || args.dir === "") {
    throw new Error("build-wave-sql: --dir is required");
  }
  if (typeof args.out !== "string" || args.out === "") {
    throw new Error("build-wave-sql: --out is required");
  }
  return args;
}

// --- artifact verification -------------------------------------------------------------

// Returns null when the file's bytes match the manifest entry, or a reason string.
// The entry is validated first: bytes and sha256 are the entire integrity story for
// a file this script cannot otherwise judge.
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
    return entry.key + ": file missing";
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
// every filename read from the cycle directory a compile-time constant of this repo.
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
// because it is too old. It measures the SERIES lease, the one the color path
// stands on; a cycle down to its last hours of series is the news MIN_LEASE_SECONDS
// exists to surface.
export function buildConsumerReport(input) {
  const manifest = isPlainObject(input.manifest) ? input.manifest : null;
  const verified = Array.isArray(input.verified) ? input.verified : [];
  const problems = Array.isArray(input.problems) ? input.problems.slice() : [];
  const sanity = manifest !== null && isPlainObject(manifest.sanity) ? manifest.sanity : null;

  const artifactsPresent = verified.length;
  const artifactsExpected = EXPECTED_WAVE_ARTIFACTS.length;
  const validStartMs = manifest !== null ? Date.parse(manifest.validStartIso) : NaN;
  const secondsRemaining = validStartMs / 1000 + WAVE_SERIES_LEASE_SECONDS - input.nowEpoch;

  return {
    schemaVersion: manifest !== null ? manifest.schemaVersion : null,
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
    optionalGridCountsWarned: sanity !== null ? sanity.optionalGridCountsWarned : null,
    gridsComplete: manifest !== null ? manifest.gridsComplete : null,

    // --- the two conjuncts the producer leaves absent ---------------------------
    gridsDigestMatches: manifest !== null && typeof input.localGridsDigest === "string" &&
      manifest.gridsDigest === input.localGridsDigest,
    secondsRemaining: secondsRemaining,

    // --- provenance -------------------------------------------------------------
    cycleId: manifest !== null && typeof manifest.cycleId === "string"
      ? manifest.cycleId : null,
    validStartIso: manifest !== null ? manifest.validStartIso : null,
    validStartEpoch: manifest !== null ? manifest.validStartEpoch : null,
    kvExpirationEpoch: manifest !== null ? manifest.kvExpirationEpoch : null,
    kvScalarExpirationEpoch: manifest !== null ? manifest.kvScalarExpirationEpoch : null,
    localGridsDigest: input.localGridsDigest || null,
    // Provenance: what the build managed with each grid. Not a conjunct, because
    // a gate on it would refuse a manifest that carries no per-grid counts.
    gridStatus: manifest !== null && isPlainObject(manifest.gridStatus)
      ? manifest.gridStatus : null,
    artifacts: verified.slice(),
    problems: problems
  };
}

// --- SQL literals ----------------------------------------------------------------------

// SQL string literal with single quotes doubled, and a finite number inlined
// literally or NULL. Both carry the semantics scripts/discovery-batch.js uses for
// every value in its own delta; they are duplicated rather than imported because
// that module pulls the whole layer pipeline, flatgeobuf included, in behind them.
export function sqlStr(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return "'" + String(value).replace(/'/g, "''") + "'";
}

export function sqlNum(value) {
  if (typeof value !== "number" || !isFinite(value)) {
    return "NULL";
  }
  return String(value);
}

// --- row assembly ----------------------------------------------------------------------

// One merged record per beach, ready to become one statement.
//
// leases is { series, scalar, nowEpoch }. A record's own shape picks its lease: a
// waveinput carrying hoursFt is indexed at read time and gets the series lease, and
// a wind-only one gets the scalar lease. Both are absolute instants, so a wind-only
// record whose lease has already run out is dropped: a reader treats it as absent
// from the instant of expiry, so writing it would land a row nothing can read. The
// series lease cannot run out here — MIN_LEASE_SECONDS refused the cycle long
// before.
//
// startIso and hoursFt are taken from the waveinput copy, the array the color path
// indexes; scanRecords has already proved the two copies identical across the NDJSON
// round trip. The waves record contributes models, byModel and sources, which the
// detail page's model-compare chart draws.
export function waveRowsFor(waveinputRecords, wavesRecords, leases) {
  const series = isPlainObject(leases) ? leases.series : null;
  const scalar = isPlainObject(leases) ? leases.scalar : null;
  const nowEpoch = isPlainObject(leases) && isFiniteNumber(leases.nowEpoch)
    ? leases.nowEpoch : null;
  const rows = [];
  const byBeach = new Map();
  const inputs = Array.isArray(waveinputRecords) ? waveinputRecords : [];
  for (let i = 0; i < inputs.length; i = i + 1) {
    const record = inputs[i];
    if (!isPlainObject(record) || typeof record.beachId !== "string") { continue; }
    const hasSeries = Array.isArray(record.hoursFt) && typeof record.startIso === "string";
    const expiration = hasSeries ? series : scalar;
    if (!hasSeries && nowEpoch !== null && isFiniteNumber(expiration) &&
        expiration <= nowEpoch) {
      continue;
    }
    const row = {
      beachId: record.beachId,
      record: Object.assign({}, record),
      expiration: expiration
    };
    byBeach.set(record.beachId, row);
    rows.push(row);
  }
  const wavesList = Array.isArray(wavesRecords) ? wavesRecords : [];
  for (let i = 0; i < wavesList.length; i = i + 1) {
    const record = wavesList[i];
    if (!isPlainObject(record) || typeof record.beachId !== "string") { continue; }
    const row = byBeach.get(record.beachId);
    if (row === undefined) {
      // waveRecordsForBeach cannot produce a series with no waveinput, but a
      // hand-edited artifact could; it gets its own row rather than being dropped
      // silently. Its lease still follows the record's own shape, so a waves
      // record missing its series takes the scalar lease and its spent-drop rule
      // rather than the series lease on trust.
      const ownSeries = Array.isArray(record.hoursFt) && typeof record.startIso === "string";
      const ownExpiration = ownSeries ? series : scalar;
      if (!ownSeries && nowEpoch !== null && isFiniteNumber(ownExpiration) &&
          ownExpiration <= nowEpoch) {
        continue;
      }
      const own = {
        beachId: record.beachId,
        record: Object.assign({}, record),
        expiration: ownExpiration
      };
      byBeach.set(record.beachId, own);
      rows.push(own);
      continue;
    }
    // The detail-page strip trims itself to the hours from now forward
    // (trimWaveSeries), so it stays correct for exactly as long as the series the
    // color path indexes: one lease for one merged record.
    row.record.models = record.models;
    row.record.byModel = record.byModel;
    row.record.sources = record.sources;
  }
  return rows;
}

// The single-row upsert. One statement per beach and one line per statement, so a
// statement can never exceed the applier's chunk cap by accident, a poison row
// loses only its own beach, and grepping the delta for a beach id returns exactly
// one line.
export function waveRowStatement(row) {
  return "INSERT INTO beach_state (beach_id, wave, wave_expires) VALUES (" +
    sqlStr(row.beachId) + ", " + sqlStr(JSON.stringify(row.record)) + ", " +
    sqlNum(row.expiration) + ") ON CONFLICT(beach_id) DO UPDATE SET " +
    "wave = excluded.wave, wave_expires = excluded.wave_expires;";
}

// Every emitted row's gate, applied before any file is written. leases is
// { series, scalar, nowEpoch }: an expiration must be exactly one of the cycle's
// two computed epochs and must still be in the future, which is the invariant that
// keeps a wave record's staleness control — the absolute lease and the series hour
// index — the only things bounding it. Returns a list of reason strings, empty when
// every row may be written.
export function waveRowRefusals(rows, leases) {
  const out = [];
  const list = Array.isArray(rows) ? rows : [];
  const series = isPlainObject(leases) ? leases.series : null;
  const scalar = isPlainObject(leases) ? leases.scalar : null;
  const nowEpoch = isPlainObject(leases) ? leases.nowEpoch : null;
  if (list.length === 0) {
    // An empty .sql applies cleanly and makes a broken cycle look landed.
    out.push("no rows: a cycle that resolved nothing must not read as a landed cycle");
  }
  for (let i = 0; i < list.length; i = i + 1) {
    const row = list[i];
    const subject = isPlainObject(row) && typeof row.beachId === "string" && row.beachId !== ""
      ? row.beachId : "row " + String(i);
    if (!isPlainObject(row)) {
      out.push(subject + ": row is not an object");
      continue;
    }
    if (typeof row.beachId !== "string" || row.beachId === "") {
      out.push(subject + ": beachId is not a non-empty string");
    }
    let json = null;
    try {
      json = JSON.stringify(row.record);
    } catch (err) {
      json = null;
    }
    if (typeof json !== "string") {
      out.push(subject + ": record does not stringify to a JSON string");
    } else if (json.indexOf("\n") !== -1 || json.indexOf("\r") !== -1) {
      // JSON.stringify escapes both, but apply-local-sql.js splits on line
      // boundaries only, so a raw newline would tear the statement in half.
      out.push(subject + ": record stringifies with a raw newline");
    }
    if (!isFiniteNumber(row.expiration)) {
      out.push(subject + ": expiration is not a finite number");
    } else {
      if (row.expiration !== series && row.expiration !== scalar) {
        out.push(subject + ": expiration " + String(row.expiration) +
          " is neither the series nor the scalar epoch of this cycle");
      }
      if (isFiniteNumber(nowEpoch) && row.expiration <= nowEpoch) {
        out.push(subject + ": expiration " + String(row.expiration) +
          " has already passed, so the row would read as absent the moment it lands");
      }
    }
    const bytes = new TextEncoder().encode(waveRowStatement(row)).length;
    if (bytes > MAX_STATEMENT_BYTES) {
      out.push(subject + ": statement is " + String(bytes) + " bytes, over the " +
        String(MAX_STATEMENT_BYTES) + " byte budget");
    }
  }
  return out;
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

async function main() {
  const args = parseArgs(Deno.args);
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
      problems.push(key + ": not readable");
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
    writeAllowed: waveWriteAllowed(report),
    validStartIso: report.validStartIso,
    kvExpirationEpoch: report.kvExpirationEpoch,
    kvScalarExpirationEpoch: report.kvScalarExpirationEpoch,
    secondsRemaining: report.secondsRemaining,
    minimumRecordsPassed: report.minimumRecordsPassed,
    gridStatus: report.gridStatus,
    rows: 0,
    statements: 0,
    deltaBytes: 0,
    maxStatementBytes: 0
  };

  if (!waveWriteAllowed(report)) {
    await Deno.writeTextFile(args.out + "/wave-sql-report.json",
      JSON.stringify(summary, null, 2) + "\n");
    log("REFUSED: writing no rows — the previous cycle's records ride their own " +
      "expiration and the flags age out to unknown, which is gray and honest");
    Deno.exit(1);
  }

  const leases = {
    series: report.kvExpirationEpoch,
    scalar: report.kvScalarExpirationEpoch,
    nowEpoch: nowEpoch
  };
  const rows = waveRowsFor(parsed[EXPECTED_WAVE_ARTIFACTS[0]],
    parsed[EXPECTED_WAVE_ARTIFACTS[1]], leases);

  const refusals = waveRowRefusals(rows, leases);
  if (refusals.length > 0) {
    await Deno.writeTextFile(args.out + "/wave-sql-report.json",
      JSON.stringify(summary, null, 2) + "\n");
    for (let i = 0; i < refusals.length; i = i + 1) {
      log("REFUSED: " + refusals[i]);
    }
    log("REFUSED: " + String(refusals.length) + " row(s) failed the emitted-row gate — " +
      "no delta was written");
    Deno.exit(1);
  }

  const lines = [];
  lines.push("-- wave cycle " + String(report.cycleId));
  lines.push("-- validStart " + String(report.validStartIso) +
    " seriesExpires " + String(report.kvExpirationEpoch) +
    " scalarExpires " + String(report.kvScalarExpirationEpoch));
  lines.push("-- wave rows (" + String(rows.length) + ")");
  let maxStatementBytes = 0;
  for (let i = 0; i < rows.length; i = i + 1) {
    const statement = waveRowStatement(rows[i]);
    const bytes = new TextEncoder().encode(statement).length;
    if (bytes > maxStatementBytes) { maxStatementBytes = bytes; }
    lines.push(statement);
  }

  // Written atomically, once, at the end, so the run has a binary outcome: exit 0
  // with a complete delta, or exit 1 with no file at all.
  const delta = lines.join("\n") + "\n";
  await Deno.writeTextFile(args.out + "/wave-delta.sql", delta);

  summary.rows = rows.length;
  summary.statements = rows.length;
  summary.deltaBytes = new TextEncoder().encode(delta).length;
  summary.maxStatementBytes = maxStatementBytes;
  await Deno.writeTextFile(args.out + "/wave-sql-report.json",
    JSON.stringify(summary, null, 2) + "\n");
  log("wrote " + String(rows.length) + " row(s) in " + String(summary.deltaBytes) +
    " bytes, largest statement " + String(maxStatementBytes) + " bytes, expiration " +
    String(report.kvExpirationEpoch) +
    " (" + String(Math.round(report.secondsRemaining)) + "s remaining)");
}

if (import.meta.main) {
  main().catch(function (err) {
    console.error("build-wave-sql: FATAL: " + (err && err.stack ? err.stack : err));
    Deno.exit(1);
  });
}
