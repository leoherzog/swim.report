// scripts/build-manifest.js — THE BUILD-SIDE GATE (contract section 5.3).
//
// Runs on Deno as the last step of .github/workflows/build-layers.yml before
// anything is uploaded:
//
//   deno run --allow-read --allow-write --allow-run scripts/build-manifest.js \
//     --layers "$WORK/layers" --floors data/layer-floors.json \
//     --previous "$WORK/prev-manifest.json" --snapshot "$OSM_SNAPSHOT" \
//     --build-id "..." --git-sha "..." --run-id "..." \
//     --allow-shrink "$ALLOW_SHRINK" --counts "$WORK/clipped" \
//     --relation-warnings "$REL_ASSEMBLY_WARNINGS" --out "$WORK/layers/manifest.json"
//
// It shells ogrinfo for the exact feature count AND schema of every published
// layer, hashes every .fgb, applies the Level 1-4 gates of contract 5.3, and
// either writes manifest.json plus SHA256SUMS or EXITS 1 with a specific reason.
//
// THIS IS THE PRIMARY DEFENCE AGAINST MASS DELETION, and it sits UPSTREAM of the
// delete rail on purpose. scripts/discovery-batch.js's proportional rail
// (RECONCILE_MAX_DELETE_FRACTION, 0.05) is the LAST line of defence; every
// threshold here is strictly tighter than it, so any regression large enough to
// reach the delete path has already been refused right here. A refused build
// fails SAFE: nothing is uploaded, the pointer stays on the last good set, and
// discovery keeps running on slightly older OSM data — which is delete-safe,
// because an older extract is OVER-inclusive.
//
// WHAT REVISION 2 CHANGED, AND WHY EACH ONE MATTERS (do not "simplify" these
// back):
//
//   * NO ABSOLUTE FLOOR IS EVER A CONTINENTAL MEASUREMENT. Revision 1's headline
//     floor (beaches >= 60,000) was measured over a North America bbox and then
//     applied to a Great-Lakes-only mask measuring ~4,031 raw elements. It was
//     either a day-one hard refusal that makes the pipeline unpublishable or —
//     if the union rectangle's interior surplus cleared it — a floor satisfied
//     entirely by inland-lake beaches, passing a build in which every Great
//     Lakes shoreline beach is missing. A floor whose basis is a different
//     bounding box than the mask is not a floor. Every floor now lives in
//     data/layer-floors.json, SEEDED FROM BUILD 1 UNDER THE PUBLISHED MASK and
//     KEYED BY regionsDigest.
//
//   * A regionsDigest WITH NO FLOORS ENTRY REFUSES TO AUTO-PUBLISH (D20/MJ-10).
//     That is what turns "remember to add a coastline floor when the first
//     saltwater box lands" from prose into a build-time behaviour: appending a
//     Pacific box changes the digest, the new footprint has no entry, and the
//     pointer is withheld until a human seeds one. Without it, the first build
//     after that commit would silently mass-hide every ocean beach.
//
//   * BUILD FLOORS ARE 0.95x, NOT 0.90x. The build gate must always be strictly
//     tighter than the delete rail so the build is always the FIRST refusal.
//
//   * THE MONOTONE-DECAY CHECK (Level 3b) EXISTS BECAUSE RATIO-TO-PREVIOUS
//     STRUCTURALLY CANNOT CATCH A SLOW BLEED. A regression removing 20% of a
//     region's features per build passes every ratio-to-previous check forever:
//     523 -> 418 -> 335 -> ... reaches double digits inside three months with
//     60-80 silent DELETEs a week and not one refusal. So current counts are
//     ALSO compared against the OLDEST RETAINED build in manifest.history.
//
//   * PER-REGION FLOORS COVER PARKS, NOT JUST BEACHES (BL-1). The delete
//     candidate set is EXCLUSIVELY park-origin rows, and producing those rows
//     requires the parks layers. A 15% single-region parks regression is ~4-5%
//     globally: it passes a global ratio, passes a beaches-only per-region
//     floor untouched, and lands ~45 deletes in Lake Michigan.
//
// PURITY. Every gate is a pure exported function over plain data — no file
// system, no subprocess, no clock — so all of it is unit-tested in
// test/buildManifest.test.js. main() does the I/O and calls them. Deno is
// reached through globalThis so importing this module under vitest is legal.
//
// Project style: ES modules, const/let only, string concatenation with + (never
// template literals), console for logging.

import { EXPECTED_LAYER_KEYS, LAYER_SCHEMA_VERSION, regionsDigestInput } from "../src/layerManifest.js";
import { REGIONS } from "../src/regions.js";
import { GREAT_LAKE_QIDS } from "../src/waterClass.js";
import { readFgbStream } from "./lib/fgbReader.js";

// --- gate constants (contract 5.3) ---------------------------------------------

// Level 3 / Level 2 ratio against the PREVIOUS accepted manifest. 0.95 and not
// 0.90: the build gate must refuse strictly before the delete rail can fire.
export const BUILD_SHRINK_MIN_RATIO = 0.95;

// Byte size ratio. Looser than the count ratio on purpose — FlatGeobuf packing
// and Hilbert ordering make byte size legitimately noisier than feature count —
// but it catches the one thing the count cannot: a truncated write carrying a
// plausible header count.
export const BUILD_BYTES_MIN_RATIO = 0.80;

// Growth WARNS rather than refuses because the consequences are asymmetric:
// extra features cause extra UPSERTs, which are idempotent and self-correcting,
// while missing features cause DELETEs, which are not.
export const BUILD_GROWTH_WARN_RATIO = 1.50;

// Level 3b, against the OLDEST retained build. Looser per step than the 0.95
// ratio-to-previous because it spans up to eight builds; the point is not
// sensitivity to one build, it is that a decay which is invisible step by step
// becomes visible across the window.
export const BUILD_DECAY_MIN_RATIO = 0.85;

// Level 2's absolute minimum per region per layer. The tail is tiny — Niagara
// has 7 rows — so a floor of 3 keeps a one- or two-polygon mapper edit in the
// smallest regions from being read as a regression by the ratio alone.
//
// IT IS CLAMPED TO THE PREVIOUS COUNT (see regionFloorRefusals). Contract 5.3
// writes the rule as max(3, floor(0.95 * previous)), and taken literally that
// INVERTS its own stated purpose for any region/layer with fewer than three
// features: an unchanged region of 1 would be required to reach 3 and would
// refuse every build forever. Measured against real data on the first end-to-end
// run of this script — six region/layer pairs refused with "1 is below max(3,
// floor(0.95 * 1)) = 3" while nothing had changed at all. Region/layer pairs
// that small are ordinary here (coastline is legitimately zero-to-tiny at Great
// Lakes scope, and Niagara River carries single digits), so the 3 is applied as
// a RELAXATION of the ratio, never as a requirement to grow. Nothing is loosened
// above previous = 3, and the Level 3 region-shrink and Level 3b decay checks
// still apply to the tail unchanged.
export const REGION_FLOOR_MIN = 3;

// Rolling window carried forward in manifest.history. Eight is ~one month of
// twice-weekly builds, and it is what makes Level 3b possible without N extra
// R2 fetches.
export const HISTORY_RETAIN = 8;

// The ratio a human uses when SEEDING data/layer-floors.json from build 1. Not
// applied by this script (seeding is a reviewed commit, never automatic) — it
// lives here so the number is stated once, next to the gates it feeds.
export const FLOOR_SEED_RATIO = 0.75;

// The fields the CONSUMER branches on, per published layer — the "fields" column
// of contract 1.4, asserted against ogrinfo's reported schema.
//
// WHY THIS IS A HARD REFUSAL (m10/B3). GDAL's GeoJSON schema inference scans
// features and creates only the fields it sees, so a field absent from the early
// features of a GeoJSONSeq file is silently dropped from the published layer. A
// dropped "wikidata" is the silent mass-hide of every Great Lakes beach
// (src/waterClass.js matches shoreline by QID); a dropped "natural" is the same
// for the coastline and pond-evidence branches of src/layerSignals.js. Neither
// shows up as an error anywhere — the layer parses, the counts look right, and
// the classification simply decides "inland" for everything.
//
// This table is DUPLICATED in scripts/clip-layers.js, deliberately: that script
// is the PRODUCER and this one is the GATE, and a gate that imported its
// expectations from the thing it gates would be checking the producer against
// itself. Both copies cite contract 1.4 and both must move together.
export const REQUIRED_LAYER_FIELDS = {
  "beaches-point.fgb": ["osm_id", "name", "loc_name", "natural", "leisure"],
  "beaches-line.fgb": ["osm_id", "name", "loc_name", "natural", "leisure"],
  "beaches-polygon.fgb": ["osm_id", "osm_way_id", "name", "loc_name", "natural", "leisure"],
  "parks-polygon.fgb": ["osm_id", "osm_way_id", "name", "leisure", "boundary"],
  "parks-line.fgb": ["osm_id", "name", "leisure", "boundary"],
  "coastline-line.fgb": ["osm_id", "natural"],
  "water-line.fgb": ["osm_id", "name", "natural", "water", "wikidata"],
  "water-polygon.fgb": ["osm_id", "osm_way_id", "name", "natural", "water", "wikidata"],
  "lakes-polygon.fgb": ["osm_id", "osm_way_id", "name", "natural", "water", "wikidata"],
  "other-relations.fgb": ["osm_id", "name", "loc_name", "type", "natural", "leisure", "boundary"]
};

// lakes-polygon.fgb is the ONE layer clip-layers.js does not produce (ogr2ogr
// carves it straight from the raw multipolygons), so it has no sidecar to
// cross-check and it is exempt from the proximity clip.
export const UNCLIPPED_LAYER_KEYS = ["lakes-polygon.fgb"];

// The six LOGICAL layer names the per-region floors are keyed by, and the
// published layers that feed each. These names are the ones committed in
// data/layer-floors.json regions[<name>]; the manifest emits the same tallies
// under the field names of REGION_COUNT_FIELDS.
export const REGION_LAYER_SOURCES = {
  "beaches": ["beaches-point", "beaches-line", "beaches-polygon"],
  "parks-polygon": ["parks-polygon"],
  "parks-line": ["parks-line"],
  "coastline": ["coastline-line"],
  "water": ["water-line", "water-polygon"],
  "other-relations": ["other-relations"]
};

export const REGION_LAYER_NAMES = Object.keys(REGION_LAYER_SOURCES);

// Logical region-layer name -> the manifest.regions[] field name of contract
// 5.1. Two vocabularies exist because the floors file is keyed by layer and the
// manifest region entry is a flat record; this table is the only place they meet.
export const REGION_COUNT_FIELDS = {
  "beaches": "beachCount",
  "parks-polygon": "parkPolyCount",
  "parks-line": "parkLineCount",
  "coastline": "coastlineCount",
  "water": "waterCount",
  "other-relations": "otherRelationsCount"
};

export const ATTRIBUTION = "(c) OpenStreetMap contributors, ODbL 1.0";

// --- small pure helpers ---------------------------------------------------------

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Every gate speaks this shape. overridable says whether --allow-shrink may
// demote it to a warning: COUNT-SHRINK refusals may (that is what the flag is
// for, "a KNOWN legitimate shrink"), INTEGRITY and IDENTITY refusals may NOT.
// A torn GeoJSONSeq tail, a dropped schema field or a lakes layer that is not
// the six Great Lakes are not "a legitimate shrink" under any circumstances, and
// a flag an operator reaches for during an incident must not be able to wave
// them through.
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

// --- ogrinfo parsing (pure) ------------------------------------------------------

// ogrinfo -json emits { layers: [ { name, featureCount, fields: [ { name, ... } ] } ] }.
// Parsed here rather than in main() so the whole schema/count gate is testable
// against captured GDAL output with no GDAL on the machine.
//
// Throws rather than returning a default on anything unexpected. An ogrinfo
// output this code cannot read is an artifact it cannot vouch for, and the one
// outcome worse than refusing is guessing a feature count.
export function parseOgrinfoLayer(text, what) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error("build-manifest: " + what + ": ogrinfo output is not JSON: " +
      (err && err.message ? err.message : String(err)));
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.layers) || parsed.layers.length === 0) {
    throw new Error("build-manifest: " + what + ": ogrinfo reported no layers");
  }
  if (parsed.layers.length > 1) {
    throw new Error("build-manifest: " + what + ": ogrinfo reported " +
      String(parsed.layers.length) + " layers; each published FlatGeobuf file must hold exactly one");
  }
  const layer = parsed.layers[0];
  if (!isPlainObject(layer)) {
    throw new Error("build-manifest: " + what + ": ogrinfo layer entry is not an object");
  }
  if (!isFiniteNumber(layer.featureCount)) {
    throw new Error("build-manifest: " + what + ": ogrinfo reported no usable featureCount");
  }
  const fields = [];
  const declared = Array.isArray(layer.fields) ? layer.fields : [];
  for (let i = 0; i < declared.length; i = i + 1) {
    const field = declared[i];
    if (isPlainObject(field) && typeof field.name === "string" && field.name !== "") {
      fields.push(field.name);
    }
  }
  return {
    name: typeof layer.name === "string" ? layer.name : null,
    featureCount: layer.featureCount,
    fields: fields
  };
}

// The wikidata QID carried by each record of the lakes layer.
//
// MEASURED: ogrinfo -json is SUMMARY ONLY — it emits no "features" array at any
// verbosity, so attribute VALUES cannot be read from it. Rather than adding a
// second tool invocation with its own text format to parse, the six values are
// read with scripts/lib/fgbReader.js, the very reader the discovery batch will
// use on this artifact. That makes the identity check an end-to-end property
// ("the pipeline's own reader can decode this published file and finds exactly
// the six Great Lakes") and it brings the reader's own truncation trip-wire —
// decoded count versus the header's declared featuresCount — to bear on the ONE
// layer that has no clip-layers.js sidecar to cross-check against.
export function lakesWikidataFrom(records) {
  const out = [];
  const list = Array.isArray(records) ? records : [];
  for (let i = 0; i < list.length; i = i + 1) {
    const record = list[i];
    const tags = isPlainObject(record) && isPlainObject(record.tags) ? record.tags : {};
    out.push(tags.wikidata);
  }
  return out;
}

// --- sidecar aggregation (pure) --------------------------------------------------

// clip-layers.js writes one <layer>.count sidecar per clipped layer, carrying
// the global kept count AND the per-REGION envelope tallies. Those tallies are
// the only per-region counts in the pipeline: this script has ogrinfo but no
// geometry, so it cannot compute them itself. The global count IS independently
// cross-checked against ogrinfo below (MJ-7), and a torn tail would fail that
// equality before any per-region number could matter.
export function aggregateRegionCounts(sidecars, regionNames) {
  const names = Array.isArray(regionNames) ? regionNames : [];
  const out = {};
  for (let r = 0; r < names.length; r = r + 1) {
    const region = names[r];
    const tally = {};
    for (let l = 0; l < REGION_LAYER_NAMES.length; l = l + 1) {
      const logical = REGION_LAYER_NAMES[l];
      const sources = REGION_LAYER_SOURCES[logical];
      let sum = 0;
      for (let s = 0; s < sources.length; s = s + 1) {
        const sidecar = sidecars[sources[s]];
        const regions = isPlainObject(sidecar) && isPlainObject(sidecar.regions)
          ? sidecar.regions
          : {};
        const value = regions[region];
        sum = sum + (isFiniteNumber(value) ? value : 0);
      }
      tally[logical] = sum;
    }
    out[region] = tally;
  }
  return out;
}

// { beaches: n, ... } -> { beachCount: n, ... } for the manifest.regions entry.
export function regionCountsToManifest(byLogical) {
  const out = {};
  for (let i = 0; i < REGION_LAYER_NAMES.length; i = i + 1) {
    const logical = REGION_LAYER_NAMES[i];
    const value = isPlainObject(byLogical) ? byLogical[logical] : undefined;
    out[REGION_COUNT_FIELDS[logical]] = isFiniteNumber(value) ? value : 0;
  }
  return out;
}

// The inverse, for reading a previous manifest's regions[] entry or a history
// entry back into the logical vocabulary the gates speak. A missing field comes
// back as null (NOT zero): "the previous build did not record this" and "the
// previous build recorded zero" must not be conflated, because the first must
// skip the ratio and the second must fail it.
export function regionCountsFromManifest(entry) {
  const out = {};
  for (let i = 0; i < REGION_LAYER_NAMES.length; i = i + 1) {
    const logical = REGION_LAYER_NAMES[i];
    const value = isPlainObject(entry) ? entry[REGION_COUNT_FIELDS[logical]] : undefined;
    out[logical] = isFiniteNumber(value) ? value : null;
  }
  return out;
}

// --- Level 1: absolute floors and identity ---------------------------------------

// The floors entry for this footprint, plus whether the pointer may be written
// automatically (D20/MJ-10).
//
// A MISSING DIGEST IS NOT A BUILD FAILURE — it is a refusal to AUTO-PUBLISH. The
// build still produces and uploads an immutable prefix, so a human can read the
// manifest and seed the floors from it; what it must not do is quietly make an
// ungated footprint live. status "bootstrap" is treated the same way, and the
// floors file says so in its own words: "status bootstrap is NOT a licence to
// auto-publish".
export function floorsEntryFor(floorsFile, regionsDigest) {
  const floors = isPlainObject(floorsFile) && isPlainObject(floorsFile.floors)
    ? floorsFile.floors
    : {};
  const entry = floors[regionsDigest];
  if (!isPlainObject(entry)) {
    return {
      entry: null,
      status: "unknown",
      autoPublishAllowed: false,
      reason: "no data/layer-floors.json entry for regionsDigest " + String(regionsDigest) +
        " — this footprint has never been seeded, so the pointer must not be written automatically"
    };
  }
  const status = typeof entry.status === "string" ? entry.status : "unknown";
  if (status !== "seeded") {
    return {
      entry: entry,
      status: status,
      autoPublishAllowed: false,
      reason: "data/layer-floors.json entry for " + String(regionsDigest) + " has status \"" +
        status + "\" — only \"seeded\" gates a footprint fully"
    };
  }
  return { entry: entry, status: status, autoPublishAllowed: true, reason: null };
}

// Level 1. A null floor means NO FLOOR HAS BEEN SEEDED YET and the check does not
// apply — deliberate and reviewable, where an invented number would either block
// every build forever or bless a broken one.
//
// parks-line's ZERO rule is separate and unconditional: named park ways exist
// unconditionally in this scope, so zero means the carve is broken, and the
// visible consequence is unnamed beaches plus DELETED park-origin rows (982 of
// 1669 rows are park-origin). It is NOT overridable.
export function absoluteFloorRefusals(layerCounts, floorsEntry) {
  const out = [];
  const floors = isPlainObject(floorsEntry) && isPlainObject(floorsEntry.layers)
    ? floorsEntry.layers
    : {};
  for (let i = 0; i < EXPECTED_LAYER_KEYS.length; i = i + 1) {
    const key = EXPECTED_LAYER_KEYS[i];
    const count = isPlainObject(layerCounts) ? layerCounts[key] : undefined;
    if (!isFiniteNumber(count)) {
      out.push(refusal("absolute-floor", key, "no feature count was measured", false));
      continue;
    }
    if (key === "parks-line.fgb" && count === 0) {
      out.push(refusal("parks-line-empty", key,
        "a parks-line count of ZERO is never legitimate — named park ways exist " +
        "unconditionally in this scope, so the carve is broken and the consequence is " +
        "unnamed beaches plus deleted park-origin rows", false));
      continue;
    }
    const floor = floors[key];
    if (!isFiniteNumber(floor)) {
      continue;
    }
    if (count < floor) {
      out.push(refusal("absolute-floor", key,
        String(count) + " features is below the seeded floor of " + String(floor), true));
    }
  }
  return out;
}

// Level 1, the ONLY hardcoded absolute in the set, and the sharpest canary in it:
// the six Great Lake relations are the largest and most reference-heavy objects
// in the data, so if the GDAL node index broke, lakes-polygon.fgb goes empty
// first. This is an IDENTITY — exactly six features carrying exactly these six
// QIDs — not a heuristic, so it never moves with the mask and --allow-shrink can
// never wave it through.
export function lakesIdentityRefusals(featureCount, wikidataValues, expectedQids) {
  const out = [];
  const expected = Array.isArray(expectedQids) ? expectedQids.slice() : Object.keys(GREAT_LAKE_QIDS);
  expected.sort();
  if (featureCount !== expected.length) {
    out.push(refusal("lakes-identity", "lakes-polygon.fgb",
      "expected exactly " + String(expected.length) + " features, ogrinfo reports " +
      String(featureCount), false));
  }
  const seen = [];
  const values = Array.isArray(wikidataValues) ? wikidataValues : [];
  for (let i = 0; i < values.length; i = i + 1) {
    const qid = values[i];
    if (typeof qid === "string" && qid !== "" && seen.indexOf(qid) === -1) {
      seen.push(qid);
    }
  }
  seen.sort();
  if (seen.join(",") !== expected.join(",")) {
    out.push(refusal("lakes-identity", "lakes-polygon.fgb",
      "wikidata set [" + seen.join(",") + "] does not equal GREAT_LAKE_QIDS [" +
      expected.join(",") + "]", false));
  }
  return out;
}

// --- integrity: sidecar cross-check and schema (MJ-7, m10/B3) ---------------------

// MJ-7. GeoJSONSeq is line-delimited and ogr2ogr on a truncated final line WARNS
// and exits 0, silently dropping the tail — and because FlatGeobuf is
// Hilbert-ordered, that tail is SPATIALLY CONTIGUOUS, which is precisely the
// shape the proportional delete rails are worst at catching. So the count
// clip-layers.js says it wrote and the count ogrinfo reads back must be EQUAL,
// with no tolerance and no override.
export function sidecarRefusals(layerCounts, sidecarCounts) {
  const out = [];
  for (let i = 0; i < EXPECTED_LAYER_KEYS.length; i = i + 1) {
    const key = EXPECTED_LAYER_KEYS[i];
    if (UNCLIPPED_LAYER_KEYS.indexOf(key) !== -1) {
      continue;
    }
    const name = key.slice(0, key.length - 4);
    const declared = isPlainObject(sidecarCounts) ? sidecarCounts[name] : undefined;
    const measured = isPlainObject(layerCounts) ? layerCounts[key] : undefined;
    if (!isFiniteNumber(declared)) {
      out.push(refusal("sidecar-missing", key,
        "clip-layers.js wrote no usable " + name + ".count sidecar", false));
      continue;
    }
    if (!isFiniteNumber(measured)) {
      out.push(refusal("sidecar-mismatch", key, "no ogrinfo feature count was measured", false));
      continue;
    }
    if (declared !== measured) {
      out.push(refusal("sidecar-mismatch", key,
        "clip-layers.js kept " + String(declared) + " feature(s) but ogrinfo reads " +
        String(measured) + " — a torn GeoJSONSeq tail is spatially contiguous and " +
        "cannot be caught by a proportional rail", false));
    }
  }
  return out;
}

// m10/B3. See the REQUIRED_LAYER_FIELDS comment for why a missing field is a
// silent mass-hide rather than a cosmetic problem.
//
// A layer with ZERO features is EXEMPT, and that exemption is not a loophole.
// coastline-line.fgb is legitimately empty at Great Lakes scope (the lakes are
// mapped as water relations, not natural=coastline ways), GDAL cannot infer a
// field list from no features, and an empty layer contributes to no decision
// downstream. An UNEXPECTEDLY empty layer is caught by the count gates instead —
// the absolute floor, the 0.95x ratio and the decay check all fire on zero, and
// parks-line and lakes-polygon each have their own hard zero refusal. Asserting
// a schema here would instead make the very first Great Lakes build fail.
export function schemaRefusals(layerFields, requiredFields, layerCounts) {
  const required = isPlainObject(requiredFields) ? requiredFields : REQUIRED_LAYER_FIELDS;
  const out = [];
  for (let i = 0; i < EXPECTED_LAYER_KEYS.length; i = i + 1) {
    const key = EXPECTED_LAYER_KEYS[i];
    const want = required[key];
    if (!Array.isArray(want)) {
      continue;
    }
    const count = isPlainObject(layerCounts) ? layerCounts[key] : undefined;
    if (count === 0) {
      continue;
    }
    const have = isPlainObject(layerFields) && Array.isArray(layerFields[key])
      ? layerFields[key]
      : null;
    if (have === null) {
      out.push(refusal("schema-missing", key, "no ogrinfo schema was read", false));
      continue;
    }
    const missing = [];
    for (let f = 0; f < want.length; f = f + 1) {
      if (have.indexOf(want[f]) === -1) {
        missing.push(want[f]);
      }
    }
    if (missing.length > 0) {
      out.push(refusal("schema-missing", key,
        "schema is missing required field(s) [" + missing.join(", ") +
        "] — GDAL drops a field no early feature carries, and a dropped wikidata or " +
        "natural hides every beach this layer classifies", false));
    }
  }
  return out;
}

// --- Level 2: per-REGION floors on EVERY clipped layer ---------------------------

// regionLayerCount >= max(REGION_FLOOR_MIN, floor(0.95 * previous))
//   AND regionLayerCount >= the seeded data/layer-floors.json floor.
//
// The ratio half is skipped when there is no previous build (bootstrap) or when
// the previous build did not record that region/layer (a newly added region), so
// a first build is never refused for having nothing to compare against.
export function regionFloorRefusals(regionCounts, previousRegionCounts, floorsEntry) {
  const out = [];
  const seeded = isPlainObject(floorsEntry) && isPlainObject(floorsEntry.regions)
    ? floorsEntry.regions
    : {};
  const regions = isPlainObject(regionCounts) ? regionCounts : {};
  const names = Object.keys(regions);
  for (let r = 0; r < names.length; r = r + 1) {
    const region = names[r];
    const current = regions[region];
    const previous = isPlainObject(previousRegionCounts) ? previousRegionCounts[region] : null;
    const seededRegion = isPlainObject(seeded[region]) ? seeded[region] : {};
    for (let l = 0; l < REGION_LAYER_NAMES.length; l = l + 1) {
      const logical = REGION_LAYER_NAMES[l];
      const count = isPlainObject(current) ? current[logical] : undefined;
      if (!isFiniteNumber(count)) {
        out.push(refusal("region-floor", region + "/" + logical,
          "no per-region count was measured", false));
        continue;
      }
      const previousCount = isPlainObject(previous) ? previous[logical] : null;
      if (isFiniteNumber(previousCount) && previousCount > 0) {
        // The clamp to previousCount is the correction described on
        // REGION_FLOOR_MIN: the 3 relaxes the ratio for a tiny region, it never
        // demands that a region GROW to three features.
        const floor = Math.min(previousCount, Math.max(REGION_FLOOR_MIN,
          Math.floor(BUILD_SHRINK_MIN_RATIO * previousCount)));
        if (count < floor) {
          out.push(refusal("region-floor", region + "/" + logical,
            String(count) + " is below min(" + String(previousCount) + ", max(" +
            String(REGION_FLOOR_MIN) + ", floor(" + String(BUILD_SHRINK_MIN_RATIO) + " * " +
            String(previousCount) + "))) = " + String(floor), true));
        }
      }
      const seededFloor = seededRegion[logical];
      if (isFiniteNumber(seededFloor) && count < seededFloor) {
        out.push(refusal("region-floor", region + "/" + logical,
          String(count) + " is below the seeded floor of " + String(seededFloor), true));
      }
    }
  }
  return out;
}

// --- Level 3: shrink ratios against the PREVIOUS accepted manifest ---------------

// Global feature count per layer and byte size per layer, plus the growth
// WARNING. Returns refusals and warnings separately: growth is published, shrink
// is not.
export function shrinkRatioRefusals(layers, previousLayers) {
  const refusals = [];
  const warnings = [];
  const previous = isPlainObject(previousLayers) ? previousLayers : {};
  const list = Array.isArray(layers) ? layers : [];
  for (let i = 0; i < list.length; i = i + 1) {
    const layer = list[i];
    const prior = previous[layer.key];
    if (!isPlainObject(prior)) {
      // A layer the previous build did not describe (a layer added since) has
      // nothing to compare against. Not a refusal; the absolute floors and the
      // identity checks still apply to it.
      continue;
    }
    if (isFiniteNumber(prior.featureCount) && prior.featureCount > 0) {
      if (layer.featureCount < BUILD_SHRINK_MIN_RATIO * prior.featureCount) {
        refusals.push(refusal("shrink-ratio", layer.key,
          ratioText(layer.featureCount, prior.featureCount, BUILD_SHRINK_MIN_RATIO), true));
      } else if (layer.featureCount > BUILD_GROWTH_WARN_RATIO * prior.featureCount) {
        warnings.push("growth: " + layer.key + ": " +
          ratioText(layer.featureCount, prior.featureCount, BUILD_GROWTH_WARN_RATIO));
      }
    }
    if (isFiniteNumber(prior.bytes) && prior.bytes > 0 && isFiniteNumber(layer.bytes)) {
      if (layer.bytes < BUILD_BYTES_MIN_RATIO * prior.bytes) {
        refusals.push(refusal("shrink-bytes", layer.key,
          ratioText(layer.bytes, prior.bytes, BUILD_BYTES_MIN_RATIO) +
          " — a truncated write can carry a plausible header count", true));
      }
    }
  }
  return { refusals: refusals, warnings: warnings };
}

// Level 3's per-region half. Deliberately SEPARATE from regionFloorRefusals and
// deliberately NOT redundant with it: Level 2 compares against
// max(3, floor(0.95 * previous)) and this compares against 0.95 * previous
// exactly, so for any previous count above 3 this one is strictly tighter (a
// region of 7 falling to 6 clears floor(6.65) = 6 but not 6.65). Both are in the
// contract, and folding them together would silently loosen one of them.
export function regionShrinkRefusals(regionCounts, previousRegionCounts) {
  const out = [];
  const regions = isPlainObject(regionCounts) ? regionCounts : {};
  const names = Object.keys(regions);
  for (let r = 0; r < names.length; r = r + 1) {
    const region = names[r];
    const previous = isPlainObject(previousRegionCounts) ? previousRegionCounts[region] : null;
    if (!isPlainObject(previous)) {
      continue;
    }
    for (let l = 0; l < REGION_LAYER_NAMES.length; l = l + 1) {
      const logical = REGION_LAYER_NAMES[l];
      const count = regions[region][logical];
      const prior = previous[logical];
      if (!isFiniteNumber(count) || !isFiniteNumber(prior) || prior <= 0) {
        continue;
      }
      if (count < BUILD_SHRINK_MIN_RATIO * prior) {
        out.push(refusal("region-shrink", region + "/" + logical,
          ratioText(count, prior, BUILD_SHRINK_MIN_RATIO), true));
      }
    }
  }
  return out;
}

// --- Level 3b: monotone decay against the OLDEST retained build ------------------

// Every check above is a ratio to the PREVIOUS build, which permits an unbounded
// slow bleed: a regression removing 20% of a region's features per build passes a
// per-region floor, passes a global ratio, and lands 20% of that region's
// candidates as deletes under the proportional rail — EVERY BUILD, FOREVER, with
// not one refusal. This is the check a ratio-to-previous design structurally
// cannot make, and it costs one carried-forward array.
export function decayRefusals(layers, regionCounts, oldest) {
  const out = [];
  if (!isPlainObject(oldest)) {
    return out;
  }
  const oldestLayers = isPlainObject(oldest.layers) ? oldest.layers : {};
  const list = Array.isArray(layers) ? layers : [];
  for (let i = 0; i < list.length; i = i + 1) {
    const layer = list[i];
    const prior = oldestLayers[layer.key];
    if (!isFiniteNumber(prior) || prior <= 0) {
      continue;
    }
    if (layer.featureCount < BUILD_DECAY_MIN_RATIO * prior) {
      out.push(refusal("monotone-decay", layer.key,
        ratioText(layer.featureCount, prior, BUILD_DECAY_MIN_RATIO) +
        " against the oldest retained build " + String(oldest.buildId), true));
    }
  }
  const oldestRegions = isPlainObject(oldest.regions) ? oldest.regions : {};
  const regions = isPlainObject(regionCounts) ? regionCounts : {};
  const names = Object.keys(regions);
  for (let r = 0; r < names.length; r = r + 1) {
    const region = names[r];
    const priorRegion = oldestRegions[region];
    if (!isPlainObject(priorRegion)) {
      continue;
    }
    for (let l = 0; l < REGION_LAYER_NAMES.length; l = l + 1) {
      const logical = REGION_LAYER_NAMES[l];
      const count = regions[region][logical];
      const prior = priorRegion[logical];
      if (!isFiniteNumber(count) || !isFiniteNumber(prior) || prior <= 0) {
        continue;
      }
      if (count < BUILD_DECAY_MIN_RATIO * prior) {
        out.push(refusal("monotone-decay", region + "/" + logical,
          ratioText(count, prior, BUILD_DECAY_MIN_RATIO) +
          " against the oldest retained build " + String(oldest.buildId), true));
      }
    }
  }
  return out;
}

// --- history (contract 5.1) -------------------------------------------------------

// One history entry describing a manifest: its buildId, its per-layer global
// counts and its per-region tallies in the LOGICAL vocabulary the gates speak.
export function historyEntryFor(manifest) {
  if (!isPlainObject(manifest)) {
    return null;
  }
  const layers = {};
  const list = Array.isArray(manifest.layers) ? manifest.layers : [];
  for (let i = 0; i < list.length; i = i + 1) {
    const layer = list[i];
    if (isPlainObject(layer) && typeof layer.key === "string" && isFiniteNumber(layer.featureCount)) {
      layers[layer.key] = layer.featureCount;
    }
  }
  const regions = {};
  const regionList = Array.isArray(manifest.regions) ? manifest.regions : [];
  for (let i = 0; i < regionList.length; i = i + 1) {
    const entry = regionList[i];
    if (isPlainObject(entry) && typeof entry.name === "string") {
      regions[entry.name] = regionCountsToManifest(regionCountsFromManifest(entry));
    }
  }
  return {
    buildId: typeof manifest.buildId === "string" ? manifest.buildId : null,
    generated: typeof manifest.generated === "string" ? manifest.generated : null,
    layers: layers,
    regions: regions
  };
}

// The rolling window this build carries forward: the previous manifest's own
// history plus an entry describing the previous manifest itself, newest last,
// capped at HISTORY_RETAIN. The CURRENT build is deliberately not in its own
// history — the next build appends it.
export function buildHistory(previousManifest, retain) {
  const cap = isFiniteNumber(retain) && retain > 0 ? Math.floor(retain) : HISTORY_RETAIN;
  if (!isPlainObject(previousManifest)) {
    return [];
  }
  const carried = Array.isArray(previousManifest.history) ? previousManifest.history.slice() : [];
  const entry = historyEntryFor(previousManifest);
  if (entry !== null) {
    carried.push(entry);
  }
  if (carried.length <= cap) {
    return carried;
  }
  return carried.slice(carried.length - cap);
}

// The oldest retained build, in the logical vocabulary, for Level 3b. Null when
// the window is empty (build 1 and build 2).
export function oldestRetained(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return null;
  }
  const entry = history[0];
  if (!isPlainObject(entry)) {
    return null;
  }
  const regions = {};
  const source = isPlainObject(entry.regions) ? entry.regions : {};
  const names = Object.keys(source);
  for (let i = 0; i < names.length; i = i + 1) {
    regions[names[i]] = regionCountsFromManifest(source[names[i]]);
  }
  return {
    buildId: typeof entry.buildId === "string" ? entry.buildId : null,
    layers: isPlainObject(entry.layers) ? entry.layers : {},
    regions: regions
  };
}

// The previous build's per-layer counts and bytes, keyed by layer key.
export function previousLayerIndex(previousManifest) {
  const out = {};
  if (!isPlainObject(previousManifest)) {
    return out;
  }
  const list = Array.isArray(previousManifest.layers) ? previousManifest.layers : [];
  for (let i = 0; i < list.length; i = i + 1) {
    const layer = list[i];
    if (isPlainObject(layer) && typeof layer.key === "string") {
      out[layer.key] = {
        featureCount: isFiniteNumber(layer.featureCount) ? layer.featureCount : null,
        bytes: isFiniteNumber(layer.bytes) ? layer.bytes : null
      };
    }
  }
  return out;
}

// The previous build's per-region tallies in the logical vocabulary.
export function previousRegionIndex(previousManifest) {
  const out = {};
  if (!isPlainObject(previousManifest)) {
    return out;
  }
  const list = Array.isArray(previousManifest.regions) ? previousManifest.regions : [];
  for (let i = 0; i < list.length; i = i + 1) {
    const entry = list[i];
    if (isPlainObject(entry) && typeof entry.name === "string") {
      out[entry.name] = regionCountsFromManifest(entry);
    }
  }
  return out;
}

// --- the composed verdict ---------------------------------------------------------

// Every gate, in one pure pass. main() supplies measurements; this decides.
//
// BOOTSTRAP (Level 4): with no previous manifest the ratio checks (Level 3, 3b
// and the ratio half of Level 2) have nothing to compare against and are
// SKIPPED, the absolute floors still apply, and the pointer must not be written
// automatically.
//
// OVERRIDE (Level 4): --allow-shrink demotes the OVERRIDABLE refusals to
// warnings and stamps sanity.overridden true, visible forever. It cannot touch
// the integrity and identity refusals — see the comment on refusal().
export function evaluateGates(input) {
  const layers = Array.isArray(input.layers) ? input.layers : [];
  const layerCounts = {};
  const layerFields = {};
  for (let i = 0; i < layers.length; i = i + 1) {
    layerCounts[layers[i].key] = layers[i].featureCount;
    layerFields[layers[i].key] = layers[i].fields;
  }

  const floorsResult = floorsEntryFor(input.floorsFile, input.regionsDigest);
  const bootstrap = !isPlainObject(input.previousManifest);

  const integrity = sidecarRefusals(layerCounts, input.sidecarCounts)
    .concat(schemaRefusals(layerFields, REQUIRED_LAYER_FIELDS, layerCounts))
    .concat(lakesIdentityRefusals(layerCounts["lakes-polygon.fgb"], input.lakesWikidata,
      Object.keys(GREAT_LAKE_QIDS)));

  const absolute = absoluteFloorRefusals(layerCounts, floorsResult.entry);

  const previousLayers = previousLayerIndex(input.previousManifest);
  const previousRegions = bootstrap ? null : previousRegionIndex(input.previousManifest);

  const regionFloors = regionFloorRefusals(input.regionCounts, previousRegions, floorsResult.entry);

  const shrink = bootstrap
    ? { refusals: [], warnings: [] }
    : shrinkRatioRefusals(layers, previousLayers);
  const regionShrink = bootstrap ? [] : regionShrinkRefusals(input.regionCounts, previousRegions);
  const decay = bootstrap ? [] : decayRefusals(layers, input.regionCounts, input.oldest);

  const all = integrity
    .concat(absolute)
    .concat(regionFloors)
    .concat(shrink.refusals)
    .concat(regionShrink)
    .concat(decay);

  const allowShrink = input.allowShrink === true;
  const refusals = [];
  const warnings = shrink.warnings.slice();
  for (let i = 0; i < all.length; i = i + 1) {
    if (allowShrink && all[i].overridable) {
      warnings.push("OVERRIDDEN " + all[i].message);
      continue;
    }
    refusals.push(all[i]);
  }
  const overridden = allowShrink && warnings.length > shrink.warnings.length;

  if (floorsResult.reason !== null) {
    warnings.push("auto-publish withheld: " + floorsResult.reason);
  }
  if (bootstrap) {
    warnings.push("auto-publish withheld: no previous manifest — this is a bootstrap build, " +
      "so every ratio check was skipped and a human must read this manifest before the " +
      "pointer is written");
  }

  const passed = refusals.length === 0;
  return {
    refusals: refusals,
    warnings: warnings,
    bootstrap: bootstrap,
    sanity: {
      previousBuildId: bootstrap ? null : (input.previousManifest.buildId || null),
      absoluteFloorsPassed: countUnrefused(absolute, refusals),
      regionFloorsPassed: countUnrefused(regionFloors, refusals),
      shrinkRatiosPassed: countUnrefused(shrink.refusals.concat(regionShrink), refusals),
      decayPassed: countUnrefused(decay, refusals),
      integrityPassed: countUnrefused(integrity, refusals),
      growthWarnings: shrink.warnings.slice(),
      bootstrap: bootstrap,
      overridden: overridden,
      // Consumed by scripts/fetch-layers.js as report.buildSanityPassed, which
      // src/layerManifest.js treats as an INCOMPLETE-tier conjunct: anything but
      // an explicit true stops both deletes AND classification.
      passed: passed,
      // Consumed by the workflow's pointer step (D20/MJ-10). False means the
      // prefix is uploaded and readable but must not be made live without a
      // human: an unseeded footprint, a "bootstrap"-status floors entry, or a
      // build with no previous manifest to ratio against.
      autoPublishAllowed: passed && floorsResult.autoPublishAllowed && !bootstrap,
      floors: {
        digest: input.regionsDigest,
        status: floorsResult.status,
        layers: isPlainObject(floorsResult.entry) && isPlainObject(floorsResult.entry.layers)
          ? floorsResult.entry.layers
          : {},
        regions: isPlainObject(floorsResult.entry) && isPlainObject(floorsResult.entry.regions)
          ? floorsResult.entry.regions
          : {}
      }
    }
  };
}

// A gate "passed" when none of its refusals survived into the final list — i.e.
// it either produced none or every one it produced was overridden. Reported per
// gate so an overridden build still says exactly which gate it overrode.
function countUnrefused(produced, refusals) {
  for (let i = 0; i < produced.length; i = i + 1) {
    if (refusals.indexOf(produced[i]) !== -1) {
      return false;
    }
  }
  return true;
}

// --- SHA256SUMS (MJ-11) -----------------------------------------------------------

// SCOPE: the .fgb files and NOTHING ELSE. It cannot cover LICENSE.txt (copied in
// after this script runs) and it must not cover manifest.json (which would make
// the workflow's read-back check fail every run for a file it does not download
// through that loop). manifest.json is instead read back and byte-compared on
// its own. Format is sha256sum's: hash, two spaces, filename.
export function sha256SumsText(layers) {
  const list = Array.isArray(layers) ? layers.slice() : [];
  list.sort(function (a, b) {
    if (a.key < b.key) { return -1; }
    if (a.key > b.key) { return 1; }
    return 0;
  });
  const lines = [];
  for (let i = 0; i < list.length; i = i + 1) {
    if (typeof list[i].key === "string" && list[i].key.slice(-4) === ".fgb") {
      lines.push(list[i].sha256 + "  " + list[i].key);
    }
  }
  return lines.join("\n") + "\n";
}

// --- argument parsing --------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    layers: null, floors: null, previous: null, snapshot: null, buildId: null,
    gitSha: null, runId: null, allowShrink: false, counts: null,
    relationWarnings: 0, out: null, sources: null,
    filters: ".github/build/expressions.txt", retain: HISTORY_RETAIN
  };
  for (let i = 0; i < argv.length; i = i + 1) {
    const a = argv[i];
    if (a === "--layers") { args.layers = argv[++i]; }
    else if (a === "--floors") { args.floors = argv[++i]; }
    else if (a === "--previous") { args.previous = argv[++i]; }
    else if (a === "--snapshot") { args.snapshot = argv[++i]; }
    else if (a === "--build-id") { args.buildId = argv[++i]; }
    else if (a === "--git-sha") { args.gitSha = argv[++i]; }
    else if (a === "--run-id") { args.runId = argv[++i]; }
    else if (a === "--allow-shrink") { args.allowShrink = argv[++i] === "true"; }
    else if (a === "--counts") { args.counts = argv[++i]; }
    else if (a === "--relation-warnings") { args.relationWarnings = parseInt(argv[++i], 10) || 0; }
    else if (a === "--out") { args.out = argv[++i]; }
    else if (a === "--sources") { args.sources = argv[++i]; }
    else if (a === "--filters") { args.filters = argv[++i]; }
    else if (a === "--retain") { args.retain = parseInt(argv[++i], 10) || HISTORY_RETAIN; }
    else { throw new Error("build-manifest: unknown argument: " + a); }
  }
  const missing = [];
  if (!args.layers) { missing.push("--layers"); }
  if (!args.floors) { missing.push("--floors"); }
  if (!args.counts) { missing.push("--counts"); }
  if (!args.buildId) { missing.push("--build-id"); }
  if (!args.out) { missing.push("--out"); }
  if (missing.length > 0) {
    throw new Error("build-manifest: missing required argument(s): " + missing.join(", "));
  }
  return args;
}

// --- source verification (contract 5.1) --------------------------------------------

// sourcesVerified is the download-completeness proof that replaces the Overpass
// era's "did every tile fetch": a mid-download Geofabrik extract rotation shows
// as an md5 mismatch and can never publish. src/layerManifest.js treats anything
// but an explicit true as INCOMPLETE, which stops deletes AND classification.
//
// It is derived here, never asserted by a flag: the workflow passes --sources
// pointing at the JSON array it accumulated while downloading, and this reads it.
// With NO --sources there is no evidence, so sourcesVerified is FALSE and the
// build says so loudly rather than claiming a proof it does not have.
export function verifySources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return {
      verified: false,
      oldestTimestamp: null,
      reason: "no --sources evidence was supplied, so the md5 download-completeness proof " +
        "cannot be made; the published set will refuse deletes AND classification"
    };
  }
  let oldest = null;
  for (let i = 0; i < sources.length; i = i + 1) {
    const source = sources[i];
    if (!isPlainObject(source)) {
      return { verified: false, oldestTimestamp: null, reason: "source " + String(i) + " is not an object" };
    }
    if (typeof source.md5Published !== "string" || source.md5Published === "" ||
      source.md5Published !== source.md5Observed) {
      return {
        verified: false,
        oldestTimestamp: null,
        reason: "source " + String(source.name) + " md5 mismatch: published " +
          String(source.md5Published) + " vs observed " + String(source.md5Observed)
      };
    }
    const stamp = source.osmosisReplicationTimestamp;
    if (typeof stamp === "string" && stamp !== "" && (oldest === null || stamp < oldest)) {
      oldest = stamp;
    }
  }
  return { verified: true, oldestTimestamp: oldest, reason: null };
}

// --- Deno I/O ----------------------------------------------------------------------

function requireDeno(what) {
  const runtime = globalThis.Deno;
  if (!runtime || typeof runtime.readTextFile !== "function") {
    throw new Error("build-manifest: " + what + " requires Deno (globalThis.Deno is unavailable)");
  }
  return runtime;
}

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i = i + 1) {
    const part = bytes[i].toString(16);
    out = out + (part.length === 1 ? "0" + part : part);
  }
  return out;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}

async function sha256OfText(text) {
  return await sha256Hex(new TextEncoder().encode(text));
}

async function readJsonIfPresent(runtime, path) {
  if (!path) {
    return null;
  }
  let text = null;
  try {
    text = await runtime.readTextFile(path);
  } catch (err) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error("build-manifest: " + path + " is not valid JSON: " +
      (err && err.message ? err.message : String(err)));
  }
}

async function runCommand(runtime, bin, cmdArgs) {
  const command = new runtime.Command(bin, { args: cmdArgs, stdout: "piped", stderr: "piped" });
  const output = await command.output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr)
  };
}

// "ubuntu24/20260815.1" from the runner's own env vars, or null off a runner.
// Null rather than an empty string: an empty string reads as "we recorded the
// image and it was blank", which is a different and untrue claim.
export function runnerImageOf(imageOs, imageVersion) {
  const os = typeof imageOs === "string" ? imageOs : "";
  const version = typeof imageVersion === "string" ? imageVersion : "";
  if (os === "" && version === "") {
    return null;
  }
  return version === "" ? os : os + "/" + version;
}

async function toolVersion(runtime, bin, cmdArgs) {
  try {
    const result = await runCommand(runtime, bin, cmdArgs);
    const text = (result.stdout + result.stderr).split("\n")[0];
    return text.trim() === "" ? null : text.trim();
  } catch (err) {
    return null;
  }
}

// --- main ----------------------------------------------------------------------------

async function main() {
  const runtime = requireDeno("main");
  const args = parseArgs(runtime.args);

  const floorsFile = await readJsonIfPresent(runtime, args.floors);
  if (floorsFile === null) {
    throw new Error("build-manifest: could not read the floors file at " + args.floors);
  }
  const previousManifest = await readJsonIfPresent(runtime, args.previous);
  const sourcesFile = await readJsonIfPresent(runtime, args.sources);

  const regionsDigest = "sha256:" + await sha256OfText(regionsDigestInput(REGIONS));
  console.log("build-manifest: regionsDigest " + regionsDigest);

  // Measure every published layer: exact feature count and schema from ogrinfo,
  // byte length from stat, sha256 from the bytes themselves.
  const layers = [];
  for (let i = 0; i < EXPECTED_LAYER_KEYS.length; i = i + 1) {
    const key = EXPECTED_LAYER_KEYS[i];
    const path = args.layers + "/" + key;
    let stat = null;
    try {
      stat = await runtime.stat(path);
    } catch (err) {
      throw new Error("build-manifest: published layer is missing: " + path);
    }
    const info = await runCommand(runtime, "ogrinfo", ["-json", "-so", "-al", path]);
    if (info.code !== 0) {
      throw new Error("build-manifest: ogrinfo failed on " + path + " (exit " +
        String(info.code) + "): " + info.stderr.trim());
    }
    const parsed = parseOgrinfoLayer(info.stdout, key);
    const bytes = await runtime.readFile(path);
    layers.push({
      key: key,
      featureCount: parsed.featureCount,
      bytes: stat.size,
      sha256: await sha256Hex(bytes),
      fields: parsed.fields
    });
    console.log("build-manifest: " + key + ": " + String(parsed.featureCount) +
      " feature(s), " + String(stat.size) + " bytes, fields [" + parsed.fields.join(",") + "]");
  }

  // lakes-polygon identity: six features carrying exactly the six Great Lake
  // QIDs. Read with the pipeline's OWN reader (see lakesWikidataFrom), streamed
  // so the simplified megapolygons are never all resident at once, and left to
  // THROW on a truncated artifact rather than degrading to an empty list.
  const lakesPath = args.layers + "/lakes-polygon.fgb";
  const lakesRecords = [];
  for await (const record of readFgbStream(lakesPath, "lakes")) {
    lakesRecords.push({ tags: record.tags });
  }
  const lakesWikidata = lakesWikidataFrom(lakesRecords);
  console.log("build-manifest: lakes-polygon.fgb: reader decoded " +
    String(lakesRecords.length) + " feature(s), wikidata [" +
    lakesWikidata.join(",") + "]");

  // The clip-layers.js sidecars: the global kept count MJ-7 cross-checks, and the
  // per-region envelope tallies this script has no geometry to compute itself.
  const sidecars = {};
  const sidecarCounts = {};
  for (let i = 0; i < EXPECTED_LAYER_KEYS.length; i = i + 1) {
    const key = EXPECTED_LAYER_KEYS[i];
    if (UNCLIPPED_LAYER_KEYS.indexOf(key) !== -1) {
      continue;
    }
    const name = key.slice(0, key.length - 4);
    const sidecar = await readJsonIfPresent(runtime, args.counts + "/" + name + ".count");
    if (sidecar !== null) {
      sidecars[name] = sidecar;
      if (isFiniteNumber(sidecar.count)) {
        sidecarCounts[name] = sidecar.count;
      }
    }
  }

  const regionNames = [];
  for (let i = 0; i < REGIONS.length; i = i + 1) {
    regionNames.push(REGIONS[i].name);
  }
  const regionCounts = aggregateRegionCounts(sidecars, regionNames);

  const history = buildHistory(previousManifest, args.retain);
  const oldest = oldestRetained(history);

  const verdict = evaluateGates({
    layers: layers,
    sidecarCounts: sidecarCounts,
    regionCounts: regionCounts,
    lakesWikidata: lakesWikidata,
    floorsFile: floorsFile,
    regionsDigest: regionsDigest,
    previousManifest: previousManifest,
    oldest: oldest,
    allowShrink: args.allowShrink
  });

  for (let i = 0; i < verdict.warnings.length; i = i + 1) {
    console.log("build-manifest: WARNING: " + verdict.warnings[i]);
  }
  if (verdict.refusals.length > 0) {
    for (let i = 0; i < verdict.refusals.length; i = i + 1) {
      console.error("build-manifest: REFUSED: " + verdict.refusals[i].message);
    }
    throw new Error("build-manifest: refusing to publish: " +
      String(verdict.refusals.length) + " gate(s) failed — the pointer stays on the last " +
      "good set and discovery keeps running on it, which is delete-safe");
  }

  const sourceCheck = verifySources(sourcesFile);
  if (!sourceCheck.verified) {
    console.log("build-manifest: WARNING: sourcesVerified false: " + sourceCheck.reason);
  }

  const regionEntries = [];
  for (let i = 0; i < REGIONS.length; i = i + 1) {
    const region = REGIONS[i];
    const entry = { name: region.name, bbox: region.bbox };
    const counts = regionCountsToManifest(regionCounts[region.name]);
    const fields = Object.keys(counts);
    for (let f = 0; f < fields.length; f = f + 1) {
      entry[fields[f]] = counts[fields[f]];
    }
    regionEntries.push(entry);
  }

  let filtersDigest = null;
  try {
    filtersDigest = "sha256:" + await sha256OfText(await runtime.readTextFile(args.filters));
  } catch (err) {
    console.log("build-manifest: WARNING: could not digest " + args.filters);
  }

  const manifest = {
    schemaVersion: LAYER_SCHEMA_VERSION,
    buildId: args.buildId,
    generated: new Date().toISOString(),
    gitSha: args.gitSha || null,
    workflowRunId: args.runId || null,
    attribution: ATTRIBUTION,
    sources: Array.isArray(sourcesFile) ? sourcesFile : [],
    sourcesVerified: sourceCheck.verified,
    oldestSourceTimestamp: sourceCheck.oldestTimestamp || args.snapshot || null,
    tools: {
      osmium: await toolVersion(runtime, "osmium", ["--version"]),
      gdal: await toolVersion(runtime, "ogrinfo", ["--version"]),
      runnerImage: runnerImageOf(runtime.env.get("ImageOS"), runtime.env.get("ImageVersion")),
      filtersDigest: filtersDigest
    },
    regionsDigest: regionsDigest,
    regions: regionEntries,
    layers: layers,
    history: history,
    relationAssemblyWarnings: args.relationWarnings,
    sanity: verdict.sanity,
    // LAST, and assigned only here. src/layerManifest.js treats any value other
    // than "complete" as an INCOMPLETE-tier failure, and this script reaches this
    // line only after every gate passed — so a manifest that claims completeness
    // is a manifest that earned it. Emitted as the final key so a torn write
    // cannot produce a file that both parses and claims to be complete.
    buildStatus: "complete"
  };

  const text = JSON.stringify(manifest, null, 2) + "\n";
  await runtime.writeTextFile(args.out + ".tmp", text);
  await runtime.rename(args.out + ".tmp", args.out);

  const sumsPath = args.layers + "/SHA256SUMS";
  await runtime.writeTextFile(sumsPath + ".tmp", sha256SumsText(layers));
  await runtime.rename(sumsPath + ".tmp", sumsPath);

  console.log("build-manifest: wrote " + args.out + " and " + sumsPath);
  console.log("build-manifest: autoPublishAllowed=" + String(verdict.sanity.autoPublishAllowed) +
    " overridden=" + String(verdict.sanity.overridden) +
    " bootstrap=" + String(verdict.bootstrap));
}

if (import.meta.main) {
  main().catch(function (err) {
    console.error("build-manifest: FATAL: " + (err && err.stack ? err.stack : err));
    Deno.exit(1);
  });
}
