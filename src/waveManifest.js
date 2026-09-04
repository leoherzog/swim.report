// src/waveManifest.js — the consumer gate for the NOAA GRIB2 wave pipeline: the
// one place that decides whether a published wave cycle may be written into
// production KV. Pure, fail-closed, and never imported by the Worker; it runs
// inside scripts/build-wave-kv.js on Deno, and is modelled on
// src/layerManifest.js.
//
// The keys this pipeline writes are the only wave input src/rules.js sees, and
// runFlagRecompute never reads waveinput.updated, so expiration is the entire
// staleness control on the color path. A merely well-formed cycle is therefore not
// enough: every checksum can match while the numbers describe a garbage plane, a
// sentinel, or an hour that has already aged out. The gate answers "do I have
// proof this cycle is decodable, intact, identity-checked and still fresh?" and
// answers no whenever the proof is missing, malformed or merely absent.
//
// Fail-closed: every conjunct is a strict !== true against the value that means
// "proven", so a missing field refuses exactly as an explicit false does. That is
// the realistic failure — the report is assembled by two separate scripts and one
// of them deliberately leaves two fields absent — so a dropped fold must refuse
// rather than sail through.
//
// Three tiers on one conjunct walk:
//   fatal    — nothing about this cycle can be trusted. Write no KV at all.
//   expired  — decodable and intact, but the lease it would grant is worthless.
//              Write no KV. A cycle with 40 minutes of life left costs a full bulk
//              write, buys almost nothing, and means the pipeline is more than six
//              hours late, which the operator must see rather than have papered
//              over.
//   degraded — write, and warn. Less data than a clean cycle, but every number in
//              it passed the identity and sentinel gates.
//
// The split matches the workflow's failure framing: anything that could produce a
// wrong number refuses, anything that is merely less data warns.

// Bump only alongside a breaking change to the manifest shape written by
// scripts/build-wave-manifest.js. A cycle written under a different schemaVersion
// is fatal, not degraded: this code cannot claim to understand it at all.
export const WAVE_SCHEMA_VERSION = 1;

// The artifact keys this code knows how to consume. The download list comes from
// here and never from manifest.artifacts[].key, so a manifest describing a third
// file is a cycle this code cannot decode rather than one to consume as-is, and
// every written filename stays a constant of this repo.
export const EXPECTED_WAVE_ARTIFACTS = ["waveinput.ndjson", "waves.ndjson"];

// Absolute lease granted to every emitted KV pair, measured from the model valid
// time and not from the write clock. 7 h covers the 3 h cron interval with two
// consecutive missed occurrences of margin.
export const WAVE_KV_LEASE_SECONDS = 25200;

// Below this, writing is pointless and the lateness is the actual news.
export const MIN_LEASE_SECONDS = 3600;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Strict finite-number test, typeof-checked rather than relying on comparison
// operators: the string "5" satisfies both "5" >= 0 and "5" <= 10 through numeric
// coercion, so a field that arrived as JSON text instead of a JSON number would sail
// through a bare range check.
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Short, deterministic rendering of an offending value. Never throws: a
// getter-bearing object or a symbol taking the gate down is the one outcome worse
// than refusing.
function describeValue(value) {
  if (value === null) { return "null"; }
  const kind = typeof value;
  if (kind === "undefined") { return "undefined"; }
  if (kind === "string") { return "string \"" + value + "\""; }
  if (kind === "number" || kind === "boolean") { return kind + " " + String(value); }
  if (Array.isArray(value)) { return "array(" + String(value.length) + ")"; }
  return kind;
}

// The single evaluation of every conjunct, bucketed by tier. Both exported
// predicates are defined on top of this one walk, so they cannot disagree about a
// report no matter how the conjunct list changes later.
function collectFailures(report) {
  const fatal = [];
  const expired = [];
  const degraded = [];

  // A missing or malformed report is the same evidence as a missing manifest. Arrays
  // are rejected too: a JSON array parsed where an object was expected is a torn or
  // wrong file, not a report.
  if (!isPlainObject(report)) {
    fatal.push("manifest-missing: report is " + describeValue(report));
    return { fatal: fatal, expired: expired, degraded: degraded };
  }

  // --- tier: fatal ---------------------------------------------------------------

  if (report.schemaVersion !== WAVE_SCHEMA_VERSION) {
    fatal.push("schema-version: expected " + String(WAVE_SCHEMA_VERSION) +
      ", got " + describeValue(report.schemaVersion));
  }
  // The manifest read from the pinned immutable prefix must carry the cycleId
  // waves/current.json named. A mismatch means a cycle completed mid-run and the
  // fetch mixed two sets, so every count below would be measuring one cycle
  // against another's manifest.
  if (report.pointerAgreesWithManifest !== true) {
    fatal.push("pointer-mismatch: pointerAgreesWithManifest is " +
      describeValue(report.pointerAgreesWithManifest));
  }
  // sha256 AND byte length of every downloaded artifact matched the manifest. A
  // truncated NDJSON still parses line by line and yields a plausible record count,
  // so the count alone proves nothing.
  if (report.artifactsVerified !== true) {
    fatal.push("artifacts-unverified: artifactsVerified is " +
      describeValue(report.artifactsVerified));
  }
  // Both operands must be real numbers before they are compared. A bare
  // "present !== expected" is fail-open when both fields are absent, because
  // undefined !== undefined is false, so a report with no artifact counting at all
  // would pass the conjunct that exists to prove the counting happened.
  if (!isFiniteNumber(report.artifactsPresent) || !isFiniteNumber(report.artifactsExpected)) {
    fatal.push("artifact-count: artifactsPresent/artifactsExpected are " +
      describeValue(report.artifactsPresent) + "/" + describeValue(report.artifactsExpected));
  } else if (report.artifactsPresent !== report.artifactsExpected) {
    fatal.push("artifact-count: " + String(report.artifactsPresent) + " of " +
      String(report.artifactsExpected) + " artifacts present");
  } else if (report.artifactsExpected !== EXPECTED_WAVE_ARTIFACTS.length) {
    // A complete set of a DIFFERENT size than this code expects: the two halves have
    // drifted, so "complete" does not mean what the gate assumes.
    fatal.push("artifact-count: expected " + String(EXPECTED_WAVE_ARTIFACTS.length) +
      " artifacts, report describes " + String(report.artifactsExpected));
  }
  // build-wave-manifest.js writes "complete" as the last key of the manifest object
  // and nowhere else, so any other value means the build died partway.
  if (report.buildStatus !== "complete") {
    fatal.push("build-incomplete: buildStatus is " + describeValue(report.buildStatus));
  }
  // Per band, GRIB_VALID_TIME === validStartEpoch + i*3600. This catches an .idx
  // off-by-one, which otherwise produces a complete, plausible, silently
  // time-shifted 24 h series.
  if (report.validTimesPassed !== true) {
    fatal.push("valid-times: validTimesPassed is " + describeValue(report.validTimesPassed));
  }
  // No emitted value equals any grid's header nodata, exceeds 100 ft, or is
  // negative. 9999 m is 32808.4 ft and colors a flag red with a straight-faced
  // reason string; a negative sentinel colors it green.
  if (report.sentinelScanPassed !== true) {
    fatal.push("sentinel-scan: sentinelScanPassed is " +
      describeValue(report.sentinelScanPassed));
  }
  // The build emitted at least one wave value, the beach total it measured against
  // is real, and every required grid sampled. A cycle carrying no wave value at all
  // cannot color a flag and must never be written.
  if (report.minimumRecordsPassed !== true) {
    fatal.push("minimum-records: minimumRecordsPassed is " +
      describeValue(report.minimumRecordsPassed));
  }

  // --- tier: expired -------------------------------------------------------------

  // sha256 over gridsDigestInput(GRIDS) equals manifest.gridsDigest. A mismatch
  // means the grid set moved since this cycle was built, so its coverage floors and
  // per-grid counts describe a different world. Tiered with expiry rather than
  // fatal because the operator response is identical: stop writing, rebuild.
  if (report.gridsDigestMatches !== true) {
    expired.push("grids-digest-mismatch: gridsDigestMatches is " +
      describeValue(report.gridsDigestMatches));
  }
  // NaN, from an unparseable validStartIso, fails this range check, which is
  // correct: refusing because the age is unknowable is the same answer as refusing
  // because it is too old.
  if (!isFiniteNumber(report.secondsRemaining)) {
    expired.push("lease: secondsRemaining is " + describeValue(report.secondsRemaining));
  } else if (report.secondsRemaining < MIN_LEASE_SECONDS) {
    expired.push("lease: " + String(Math.round(report.secondsRemaining)) +
      "s remaining, below the " + String(MIN_LEASE_SECONDS) + "s floor");
  }

  // --- tier: degraded ------------------------------------------------------------

  // Every enabled grid contributed records. False means one upstream was out —
  // NOMADS down leaves every Great Lakes beach unsampled — which is less data, not
  // wrong data.
  if (report.gridsComplete !== true) {
    degraded.push("grids-incomplete: gridsComplete is " +
      describeValue(report.gridsComplete));
  }
  // A human ran the build with --allow-shrink, demoting a coverage refusal to a
  // warning. Published separately by build-wave-manifest.js so an overridden cycle
  // stays distinguishable downstream, and flattened onto the report by
  // scripts/build-wave-kv.js.
  if (report.sanityOverridden === true) {
    degraded.push("sanity-overridden: a coverage gate was demoted to a warning by " +
      "--allow-shrink");
  }

  return { fatal: fatal, expired: expired, degraded: degraded };
}

// Splits the tiers so the caller can act on them differently. reasons carries every
// failing conjunct, not only the reported tier's, ordered fatal-first: the tier
// alone does not say which conjunct fired. Pure; never throws for any input.
export function classifyWaveManifestFailure(report) {
  const failures = collectFailures(report);
  const reasons = failures.fatal.concat(failures.expired, failures.degraded);
  let tier = "ok";
  if (failures.fatal.length > 0) {
    tier = "fatal";
  } else if (failures.expired.length > 0) {
    tier = "expired";
  } else if (failures.degraded.length > 0) {
    tier = "degraded";
  }
  return { tier: tier, reasons: reasons };
}

// "May this cycle be written into production KV?" True for a clean or degraded
// cycle, false for anything fatal or expired. Null and malformed input answer
// false, never a throw and never a default true.
export function waveKvWriteAllowed(report) {
  const failures = collectFailures(report);
  return failures.fatal.length === 0 && failures.expired.length === 0;
}
