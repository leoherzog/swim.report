// src/layerManifest.js — the delete-path gate for the FlatGeobuf layer pipeline,
// and the single choke point scripts/discovery-batch.js consults before any
// DELETE. Pure: no fetch, no Date, no filesystem, and its only import is
// src/regions.js, so the offline Deno batch, the build-side scripts and vitest
// all load it verbatim.
//
// The failure mode this gate exists for is inverted from a network one. A wrong
// tag filter exits 0, ogr2ogr exits 0, the manifest is well-formed, every
// checksum matches, and the run confidently deletes every beach the filter failed
// to match: silent, valid-looking and delete-bearing. Every conjunct below asks
// "do I have proof this layer set is a complete, intact, in-scope, fresh view of
// OSM?" and answers no whenever the proof is missing, malformed or merely absent.
//
// Fail-closed rule: every conjunct is a strict identity comparison against the
// value that means "proven", so a missing field refuses exactly as an explicit
// false does. That is the realistic failure, because the report is assembled by
// three separate scripts (scripts/fetch-layers.js, scripts/build-manifest.js,
// scripts/discovery-batch.js) rather than by one loop's own bookkeeping. A
// truthy-but-not-true value (1, "true", {}) is not proof and must never slip a
// delete through.
//
// Two predicates, not one. classificationAllowed is the weaker one and
// reconciliationAllowed is defined in terms of it, so the two cannot drift apart
// or be applied in the wrong order:
//
//   classificationAllowed  — "is this a complete view of OSM?"
//   reconciliationAllowed  — "...and is it scoped to this code's regions and fresh?"
//
// Classification must stop when the view is incomplete, because a partial water
// view makes classifyWaterBody's clean-but-empty branch decide "inland", which
// hides a beach — the same product loss as deleting it, arriving faster and
// invisible in the row count. It must keep running when the set is merely stale
// or out of scope:
//
//   - A 20-day-old extract's shoreline geometry is complete, just older.
//     Classifying from it beats leaving newly-discovered rows NULL and visible,
//     because FLAG_WORTHY_WATER_SQL is deliberately fail-open for NULL rows under
//     the attempts cap (the Locklin Pines exposure).
//   - A regions-digest mismatch is what an expansion commit produces by
//     construction. Deletes must stop, which is the digest guard's whole purpose,
//     but discovery keeps upserting, so gating classification here too would
//     publish thousands of unclassified new-coast beaches live until a rebuild
//     lands.

import { REGIONS } from "./regions.js";

// Bump only alongside a breaking change to the manifest shape written by
// scripts/build-manifest.js. A set written under a different schemaVersion is
// fatal, not degraded: this code cannot claim to understand it at all.
export const LAYER_SCHEMA_VERSION = 1;

// Wall-clock horizon for the published layer set, measured against the OSM data
// cutoff (manifest.oldestSourceTimestamp / osmosisReplicationTimestamp), never
// against the build's own wall clock.
//
// Staleness alone is delete-safe, so this is an operator tripwire rather than a
// correctness rail: an older extract is over-inclusive, still carrying beaches
// OSM has since removed and lacking only ones OSM has since added, which D1 also
// lacks. Tripping it stops deletes and makes the broken build unmissable in the
// run log; upserts and classification continue.
//
// 21 days, not 14, because GitHub skips schedule occurrences rather than
// deferring them. Against the twice-weekly build cadence that is three missed
// slots: wide enough that one skipped occurrence is not an alarm, tight enough
// that two consecutive silent build failures are.
export const MAX_SOURCE_AGE_DAYS = 21;

// The published layer object keys, in the order of the layer table. This is the
// code-side expectation scripts/fetch-layers.js derives its download list and its
// layersExpected count from; a set not carrying exactly these keys is undecodable
// here and refuses fatally.
//
// Splits exist because one FlatGeobuf file holds exactly one geometry type, so a
// logical layer arriving as more than one type is published as several files and
// re-concatenated by the reader under one name. There is no coastline-polygon
// file: the lines pass carries every coastline way, and publishing both
// double-counts island coastlines.
export const EXPECTED_LAYER_KEYS = [
  "beaches-point.fgb",
  "beaches-line.fgb",
  "beaches-polygon.fgb",
  "parks-polygon.fgb",
  "parks-line.fgb",
  "coastline-line.fgb",
  "water-line.fgb",
  "water-polygon.fgb",
  "lakes-polygon.fgb",
  "other-relations.fgb"
];

// parksLayerHealthy's ratio against the previous build's parks counts. Tighter
// than the 0.95x build-side shrink refusal on purpose: by the time the report
// reaches the discovery batch the build gate has already accepted the set, so
// this is the last valve between a quietly under-populated parks layer and a
// park_name wipe across every named row in the affected regions.
export const PARKS_PREVIOUS_MIN_RATIO = 0.98;

// --- internal helpers ---------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Strict finite-number test, typeof-checked rather than left to the comparison
// operators: the string "5" satisfies both "5" >= 0 and "5" <= 21 through numeric
// coercion, so a report field that arrived as JSON text would sail through a bare
// range check and arm the delete path.
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Short, deterministic rendering of an offending value for a reason string. Never
// throws (a getter-bearing object or a symbol would otherwise take the gate down,
// which is the one outcome worse than refusing).
function describeValue(value) {
  if (value === null) { return "null"; }
  const kind = typeof value;
  if (kind === "undefined") { return "undefined"; }
  if (kind === "string") { return "string \"" + value + "\""; }
  if (kind === "number" || kind === "boolean") { return kind + " " + String(value); }
  if (Array.isArray(value)) { return "array(" + String(value.length) + ")"; }
  return kind;
}

// The single evaluation of every conjunct, bucketed by tier. All three exported
// predicates are defined on top of this one walk, so they cannot disagree about a
// report however the conjunct list changes later.
//
//   fatal          — this set cannot be decoded at all. No SQL of any kind.
//   incomplete     — readable, but not provably a complete view of OSM. Upserts
//                    and the marine pass only: no deletes, no classification.
//   scope_or_stale — a complete view, but not scoped to this code's regions or
//                    not fresh. Upserts, marine and classification run normally;
//                    only deletes stop.
function collectFailures(report) {
  const fatal = [];
  const incomplete = [];
  const scopeOrStale = [];

  // A missing or malformed report is the same evidence as a missing manifest:
  // there is nothing here to decode. Arrays are rejected too — a JSON array
  // parsed where an object was expected is a torn or wrong file, not a report.
  if (!isPlainObject(report)) {
    fatal.push("manifest-missing: report is " + describeValue(report));
    return { fatal: fatal, incomplete: incomplete, scopeOrStale: scopeOrStale };
  }

  // --- tier: fatal — "can this code decode this set?" -------------------------

  if (report.schemaVersion !== LAYER_SCHEMA_VERSION) {
    fatal.push("schema-version: expected " + String(LAYER_SCHEMA_VERSION) +
      ", got " + describeValue(report.schemaVersion));
  }
  // The manifest read from the pinned immutable prefix must carry the buildId
  // layers/current.json named. A mismatch means a build completed mid-run and the
  // fetch mixed two sets, so every count comparison below would be measuring one
  // set against another's manifest.
  if (report.pointerAgreesWithManifest !== true) {
    fatal.push("pointer-mismatch: pointerAgreesWithManifest is " +
      describeValue(report.pointerAgreesWithManifest));
  }
  // sha256 and byte length of every downloaded file matched manifest.layers. A
  // truncated FlatGeobuf still parses far enough to yield a plausible feature
  // count, and because the format is Hilbert-ordered the missing tail is
  // spatially contiguous — exactly the shape the proportional delete rails are
  // worst at catching.
  if (report.layersVerified !== true) {
    fatal.push("layers-unverified: layersVerified is " + describeValue(report.layersVerified));
  }
  // Files on disk vs EXPECTED_LAYER_KEYS.length. Both operands must be real
  // numbers before they are compared: a bare "present !== expected" is fail-open
  // when both fields are absent, because undefined !== undefined is false, so a
  // report with no layer counting at all would pass the conjunct that exists to
  // prove the layer counting happened.
  if (!isFiniteNumber(report.layersPresent) || !isFiniteNumber(report.layersExpected)) {
    fatal.push("layer-count: layersPresent/layersExpected are " +
      describeValue(report.layersPresent) + "/" + describeValue(report.layersExpected));
  } else if (report.layersPresent !== report.layersExpected) {
    fatal.push("layer-count: " + String(report.layersPresent) + " of " +
      String(report.layersExpected) + " layers present");
  } else if (report.layersExpected !== EXPECTED_LAYER_KEYS.length) {
    // The fetcher counted a complete set of a different size than this code
    // expects, so a layer was added or dropped on one side only and "complete"
    // does not mean what the gate assumes.
    fatal.push("layer-count: expected " + String(EXPECTED_LAYER_KEYS.length) +
      " layers, report describes " + String(report.layersExpected));
  }
  // Optional, validated only when supplied: the exact key set the run read. It
  // catches the two cases equal counts cannot — a layer on disk the manifest
  // never described, and a manifest layer absent from disk, where the two errors
  // cancel in the count.
  if (report.layerKeys !== undefined) {
    const keyProblem = describeLayerKeyProblem(report.layerKeys);
    if (keyProblem !== null) {
      fatal.push("layer-keys: " + keyProblem);
    }
  }

  // --- tier: incomplete — "is this provably a COMPLETE view of OSM?" ----------

  // build-manifest.js writes "complete" on its last line and nowhere else, so any
  // other value means the build died partway and this manifest describes a set
  // that was never finished.
  if (report.buildStatus !== "complete") {
    incomplete.push("build-incomplete: buildStatus is " + describeValue(report.buildStatus));
  }
  // Every source extract's observed md5 equalled its published md5. This is the
  // download-completeness proof: a mid-download extract rotation shows as a
  // mismatch.
  if (report.sourcesVerified !== true) {
    incomplete.push("sources-unverified: sourcesVerified is " +
      describeValue(report.sourcesVerified));
  }
  // The build-side floors, per-region floors and shrink ratios all passed. The
  // discovery job structurally cannot make these checks — they need the previous
  // build's counts and per-region tallies — so the batch trusts the build's
  // verdict and refuses when it is anything but an explicit yes.
  if (report.buildSanityPassed !== true) {
    incomplete.push("build-sanity-failed: buildSanityPassed is " +
      describeValue(report.buildSanityPassed));
  }

  // --- tier: scope_or_stale — deletes only --------------------------------------

  // sha256 over regionsDigestInput(REGIONS) equals manifest.regionsDigest.
  // Appending a coastal box to src/regions.js immediately widens pointInAnyRegion,
  // so every D1 row in the new box becomes a delete candidate while a layer set
  // built before that commit produces zero beaches there. Without this conjunct
  // the first run after an expansion commit mass-deletes the entire new coast.
  if (report.regionsDigestMatches !== true) {
    scopeOrStale.push("regions-digest-mismatch: regionsDigestMatches is " +
      describeValue(report.regionsDigestMatches));
  }
  // The operator tripwire. NaN (an unparseable timestamp) fails the range check,
  // which is correct and intended.
  if (!isFiniteNumber(report.sourceAgeDays)) {
    scopeOrStale.push("source-age: sourceAgeDays is " + describeValue(report.sourceAgeDays));
  } else if (report.sourceAgeDays < 0 || report.sourceAgeDays > MAX_SOURCE_AGE_DAYS) {
    // A negative age is a clock or timestamp bug, not freshness, and it refuses
    // for the same reason a stale one does: the freshness claim is unproven.
    scopeOrStale.push("source-age: " + String(report.sourceAgeDays) +
      " days outside [0, " + String(MAX_SOURCE_AGE_DAYS) + "]");
  }

  return { fatal: fatal, incomplete: incomplete, scopeOrStale: scopeOrStale };
}

// Returns null when layerKeys is exactly EXPECTED_LAYER_KEYS as a set, or a short
// description of the first structural problem. Order is not required — the
// fetcher may list files in directory order — but membership is.
function describeLayerKeyProblem(layerKeys) {
  if (!Array.isArray(layerKeys)) {
    return "layerKeys is " + describeValue(layerKeys);
  }
  const seen = [];
  for (let i = 0; i < layerKeys.length; i = i + 1) {
    const key = layerKeys[i];
    if (typeof key !== "string") {
      return "non-string entry " + describeValue(key);
    }
    if (seen.indexOf(key) !== -1) {
      return "duplicate entry " + key;
    }
    if (EXPECTED_LAYER_KEYS.indexOf(key) === -1) {
      return "unexpected layer " + key;
    }
    seen.push(key);
  }
  for (let i = 0; i < EXPECTED_LAYER_KEYS.length; i = i + 1) {
    if (seen.indexOf(EXPECTED_LAYER_KEYS[i]) === -1) {
      return "missing layer " + EXPECTED_LAYER_KEYS[i];
    }
  }
  return null;
}

// --- exported predicates -------------------------------------------------------

// Splits the three tiers so main() can act on them differently: fatal exits 1
// with no SQL at all, incomplete suppresses deletes and classification, and
// scope_or_stale suppresses only deletes. Pure; never throws for any input.
//
// reasons carries every failing conjunct, not only the reported tier's, ordered
// fatal-first: the tier alone does not say which conjunct fired.
export function classifyManifestFailure(report) {
  const failures = collectFailures(report);
  const reasons = failures.fatal.concat(failures.incomplete, failures.scopeOrStale);
  let tier = "ok";
  if (failures.fatal.length > 0) {
    tier = "fatal";
  } else if (failures.incomplete.length > 0) {
    tier = "incomplete";
  } else if (failures.scopeOrStale.length > 0) {
    tier = "scope_or_stale";
  }
  return { tier: tier, reasons: reasons };
}

// "Is this a complete view of OSM?" — the only question classification needs.
// True for a complete set that is merely stale or out of delete scope, false for
// anything fatal or incomplete. Null and malformed input answer false, never a
// throw and never a default true.
export function classificationAllowed(report) {
  const failures = collectFailures(report);
  return failures.fatal.length === 0 && failures.incomplete.length === 0;
}

// "Is this a complete view, scoped to this code's regions, and fresh?" — the gate
// for the stale-row reconciliation and DELETE pass, and the one choke point that
// holds the invariant "incomplete coverage means no DELETE".
//
// By construction:
//   reconciliationAllowed(report) === classificationAllowed(report)
//                                    && regionsDigestMatches === true
//                                    && sourceAgeDays in [0, MAX_SOURCE_AGE_DAYS]
export function reconciliationAllowed(report) {
  const failures = collectFailures(report);
  return failures.fatal.length === 0 && failures.incomplete.length === 0 &&
    failures.scopeOrStale.length === 0;
}

// Parks-layer health, consumed by scripts/discovery-batch.js as hasPark.
//
// Not hardcoded true, because "the parks layer is present under a verified
// manifest" and "the parks layer is correctly populated" are different
// predicates and layer failures are valid-looking. hasPark false makes upsertSql
// emit the five-column variant, leaving park_name untouched on existing rows;
// hardcoding it true lets a short parks layer blank park_name on every named row
// in the missing parks and, through mergeBeachRows' skippedUnnamed path, strand
// the park-origin rows those names produced as stale delete candidates. False is
// the safe direction and every unproven input resolves to it.
//
// Inputs (assembled by scripts/fetch-layers.js from the manifest, its history
// array and data/layer-floors.json, which is keyed by regionsDigest):
//
//   report.parks = {
//     polygonCount:         number,  // this set's parks-polygon.fgb featureCount
//     lineCount:            number,  // this set's parks-line.fgb featureCount
//     polygonFloor:         number,  // seeded floor for this regionsDigest
//     lineFloor:            number,
//     previousPolygonCount: number,  // newest manifest.history entry
//     previousLineCount:    number
//   }
//
// A bootstrap set has no previous counts and an unseeded floors entry, so this
// returns false and the first discovery against it leaves park_name alone. The
// next build carries history and the valve opens.
export function parksLayerHealthy(report) {
  // The parks counts come from the manifest, so they are only worth reading once
  // the set is a decodable, complete build. This is the complete-view question,
  // not the delete question: a stale or out-of-scope set still has a fully
  // populated parks layer and should keep refreshing park_name.
  if (!classificationAllowed(report)) {
    return false;
  }
  const parks = report.parks;
  if (!isPlainObject(parks)) {
    return false;
  }
  const fields = ["polygonCount", "lineCount", "polygonFloor", "lineFloor",
    "previousPolygonCount", "previousLineCount"];
  for (let i = 0; i < fields.length; i = i + 1) {
    const value = parks[fields[i]];
    if (!isFiniteNumber(value) || value < 0) {
      return false;
    }
  }
  // A parks-polygon count of zero is a hard refusal: membership comes from that
  // layer alone, membership produces park-origin rows, and park-origin rows are
  // the entire delete-candidate set.
  //
  // A parks-line count of zero is not a refusal. GDAL routes every closed
  // area-tagged way to the polygon layer and leaves only unclosed ways in the
  // lines layer, and essentially every mapped Great Lakes park is closed or a
  // relation, so an empty parks-line is legitimate. Refusing on it would mean
  // park_name never refreshing and, since reconciliation requires hasPark,
  // deletes never running at all.
  //
  // The floor and previous-count ratio checks below still apply to lineCount and
  // are the right guards for it: they are no-ops at 0 against a 0 floor and a 0
  // previous count, and they still fire if a layer that had named park lines
  // empties. That case is genuinely delete-bearing, because parks-line feeds the
  // parksName tier and a beach that loses its park name loses its row.
  if (parks.polygonCount <= 0) {
    return false;
  }
  if (parks.polygonCount < parks.polygonFloor || parks.lineCount < parks.lineFloor) {
    return false;
  }
  if (parks.polygonCount < PARKS_PREVIOUS_MIN_RATIO * parks.previousPolygonCount) {
    return false;
  }
  if (parks.lineCount < PARKS_PREVIOUS_MIN_RATIO * parks.previousLineCount) {
    return false;
  }
  return true;
}

// --- the regions digest --------------------------------------------------------

// Canonical digest input for the regions guard: name plus bbox only, sorted by
// name, with a fixed key order, JSON.stringify'd. The caller hashes the returned
// string with sha256 and compares it with manifest.regionsDigest. Both the build
// (scripts/build-manifest.js) and the batch (scripts/discovery-batch.js) must
// hash the output of this function so the two cannot disagree about
// canonicalisation.
//
// What must not invalidate a layer set: comment edits, reformatting, note-text
// rewrites, reordering the REGIONS array, or reordering the keys inside a bbox
// literal. None change the discovery footprint, and invalidating a set over them
// would stop deletes for a week over a typo fix.
//
// What must invalidate it: adding, removing or renaming a box, or moving any bbox
// edge. All four change which D1 rows pointInAnyRegion admits as delete
// candidates, and a layer set built before the change has no features in the
// newly-admitted area.
//
// Throws on malformed input. REGIONS is repo-committed source, so a malformed
// entry is a commit bug that must fail the batch loudly rather than digest to
// something that happens to match or happens not to.
export function regionsDigestInput(regions) {
  const source = regions === undefined ? REGIONS : regions;
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error("regionsDigestInput: expected a non-empty regions array");
  }
  const entries = [];
  for (let i = 0; i < source.length; i = i + 1) {
    const region = source[i];
    if (!isPlainObject(region) || typeof region.name !== "string" || region.name === "") {
      throw new Error("regionsDigestInput: region " + String(i) + " has no name");
    }
    const bbox = region.bbox;
    if (!isPlainObject(bbox)) {
      throw new Error("regionsDigestInput: region " + region.name + " has no bbox");
    }
    const edges = ["minLon", "minLat", "maxLon", "maxLat"];
    for (let e = 0; e < edges.length; e = e + 1) {
      if (!isFiniteNumber(bbox[edges[e]])) {
        throw new Error("regionsDigestInput: region " + region.name + " bbox." +
          edges[e] + " is not a finite number");
      }
    }
    // Rebuilt object literal, not the source object: this is what fixes the key
    // order and drops note/any other incidental field from the digest.
    entries.push({
      name: region.name,
      bbox: {
        minLon: bbox.minLon,
        minLat: bbox.minLat,
        maxLon: bbox.maxLon,
        maxLat: bbox.maxLat
      }
    });
  }
  // Sort by name, then by the canonical bbox rendering, so two identically-named
  // boxes order deterministically instead of depending on Array.sort's stability
  // across engines.
  entries.sort(function (a, b) {
    if (a.name < b.name) { return -1; }
    if (a.name > b.name) { return 1; }
    const aBox = JSON.stringify(a.bbox);
    const bBox = JSON.stringify(b.bbox);
    if (aBox < bBox) { return -1; }
    if (aBox > bBox) { return 1; }
    return 0;
  });
  return JSON.stringify(entries);
}
