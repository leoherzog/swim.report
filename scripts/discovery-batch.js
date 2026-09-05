// scripts/discovery-batch.js — offline beach discovery + water-body
// classification, run from GitHub Actions on Deno (see
// .github/workflows/discovery.yml and docs/offline-discovery.md).
//
// Discovery and classification are pipeline work, not serving work: they run
// occasionally, tolerate hours of latency and produce a table. This script runs
// that logic — imported verbatim from src/ so it can never diverge — as a plain
// offline batch that loops for minutes, emits one idempotent .sql file and
// bulk-loads it into production D1 via
//   wrangler d1 execute swim-report --remote --file=<out>
// The Worker keeps serving, the hourly recompute, the water-temperature refresh
// and NWS/ECCC/webcam enrichment.
//
// The two-path rule is unchanged: the Worker request path still reads only D1 and
// KV. This is a third, offline path that writes D1 out of band and never runs
// inside the Worker.
//
// The batch makes zero network requests. Both halves read prebuilt spatial layers
// (FlatGeobuf files published to R2 by .github/workflows/build-layers.yml, then
// downloaded, verified and reported on by scripts/fetch-layers.js). Discovery is a
// local scan (src/layerDiscovery.js) and classification a local spatial join
// (src/layerSignals.js) against segment grids built once per run. The workflow
// runs this with --allow-read --allow-write and no --allow-net, which is the
// machine-enforced form of that claim: any surviving --allow-net on a
// discovery-batch.js invocation is a leftover upstream call, findable by one grep.
//
// The inverted failure mode — read this before touching the delete path. A wrong
// tag filter exits 0, the build exits 0, the manifest is well-formed, every
// checksum matches, and this run confidently deletes every beach the filter failed
// to match: silent, valid-looking and delete-bearing. That is why the gate is a
// manifest predicate (src/layerManifest.js), why the proportional delete rail is
// tight and has a per-region rail beside it, and why mass re-classification has a
// rail of its own. Deciding "inland" hides a beach, which is product loss of the
// same family as a wrong delete, arrives faster, and is invisible in the row
// count.
//
// Exactly one npm dependency, reached only through scripts/lib/fgbReader.js. Every
// src/ module reached from here is dependency-free. The workflows run
// "deno cache --lock=deno.lock --frozen" first, so the only delete-bearing job in
// the repo never resolves an unpinned transitive tree from the network.

import { mergeBeachRows } from "../src/discovery.js";
import {
  buildPondEvidenceFilter,
  classifyLayerFeature,
  discoverFromLayers,
  pondEvidenceCandidate
} from "../src/layerDiscovery.js";
import {
  addSignalsFeature,
  beachAbsentFromLayers,
  beginSignalsIndex,
  finishSignalsIndex,
  signalsIndexStats,
  waterClassSignals
} from "../src/layerSignals.js";
import {
  EXPECTED_LAYER_KEYS,
  MAX_SOURCE_AGE_DAYS,
  classificationAllowed as manifestClassificationAllowed,
  classifyManifestFailure,
  parksLayerHealthy,
  reconciliationAllowed as manifestReconciliationAllowed,
  regionsDigestInput
} from "../src/layerManifest.js";
import {
  classifyWaterBody,
  WATER_CLASS_VERSION,
  WATER_CLASS_MAX_ATTEMPTS
} from "../src/waterClass.js";
import { REGIONS, pointInAnyRegion } from "../src/regions.js";
import { buildMarineZoneIndex, nearestMarineZone } from "../src/marineZones.js";
import { readFgbStream, readLayerFile } from "./lib/fgbReader.js";

// --- Constants --------------------------------------------------------------
// The discovery regions and the point-in-region predicate come from the
// standalone src/regions.js, so this batch and the Worker share one definition.
// The reconciliation rails below stay local; the water-class constants are
// imported from src/waterClass.js so they cannot drift.

// Global proportional delete rail. A run may delete at most
// max(RECONCILE_MAX_DELETES, ceil(fraction * candidates)) stale rows; beyond that
// the entire reconciliation is refused, because a delete set that large is
// evidence about the layer set as a whole and partial deletes under suspicion are
// worse than none.
//
// Coverage under prebuilt layers is either verified-complete or gated off
// entirely, so a delete run reaching a quarter of the candidate set is never
// legitimate. At 0.05 a single-digit-percent parks-layer shrink, a single-region
// parks loss and a clip-mask bug that zeroes one lake are all refused. A false
// refusal costs close to nothing — the row is simply not deleted this run and
// reconciliation retries tomorrow — which is what makes the tight number the right
// trade against an irreversible delete.
const RECONCILE_MAX_DELETES = 10;
const RECONCILE_MAX_DELETE_FRACTION = 0.05;

// Per-region proportional delete rail, applied after the global one. The global
// rail's protection asymptotes toward zero as the number of independently
// breakable clip masks grows: a bug that zeroes one region's parks is a small
// fraction of the global candidate set and passes. Each region gets its own
// allowance over its own candidates.
//
// The floor is 2, not 10. The region tail is single-digit, so a floor of 10 makes
// the rail vacuous for exactly the regions a global rail can never protect. A
// floor of 2 still absorbs one mapper deleting a couple of polygons without
// admitting a whole-region wipe.
const REGION_RECONCILE_MIN_DELETES = 2;
const REGION_RECONCILE_MAX_DELETE_FRACTION = 0.05;

// The classification flip rail (see classificationFlipRailAllows). Deciding
// "inland" hides a beach, which is product loss of the same family as deleting it,
// and every flag-worthy row served classifies through one code path: a broken
// build plus a WATER_CLASS_VERSION bump would re-decide all of them in one delta
// and empty the site, with the row count unchanged and every delete rail green.
const CLASSIFY_MAX_HIDE_FLIPS = 10;
const CLASSIFY_MAX_HIDE_FRACTION = 0.10;

const FLAG_HISTORY_RETENTION_DAYS = 90;
// A re-discovered beach whose centroid moved further than this (~80-111 m at
// Great Lakes latitudes) may sit on different water, so its water_class is reset
// and it re-classifies.
const WATER_CLASS_MOVE_DEG = 0.001;

// The published layer files, fanned out to the logical layers the consumers take.
// One FlatGeobuf file holds exactly one geometry type, so a logical layer that
// legitimately arrives as several geometry types is published as several files and
// re-concatenated here.
//
// other-relations.fgb is deliberately in none of these lists: it carries both
// halves — beach relations GDAL could not assemble into a polygon, and park
// relations map_to_area produced no area for — and is split by tag through
// splitOtherRelations below. Publishing it is not optional, because a beach
// arriving only as an unassemblable relation would otherwise vanish.
export const LAYER_FILES = {
  beaches: ["beaches-point.fgb", "beaches-line.fgb", "beaches-polygon.fgb"],
  parksPoly: ["parks-polygon.fgb"],
  parksName: ["parks-polygon.fgb", "parks-line.fgb"],
  coastline: ["coastline-line.fgb"],
  water: ["water-line.fgb", "water-polygon.fgb"],
  lakes: ["lakes-polygon.fgb"],
  otherRelations: ["other-relations.fgb"]
};

// --- Tiny helpers -----------------------------------------------------------

function sleep(ms) {
  if (!(ms > 0)) {
    return Promise.resolve();
  }
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Pure wall-clock budget predicate for the classify loop. budgetMs <= 0 disables
// it; otherwise true once (nowMs - startMs) has reached budgetMs. Pure and
// three-arg so it is trivially unit-testable.
//
// The production call site passes no budget: the classification pass is a local
// join, not a per-beach network probe, and the whole pass costs seconds. The
// machinery stays wired and tested because the target footprint is several times
// the current table, and carrying it costs nothing.
export function budgetExhausted(startMs, budgetMs, nowMs) {
  return budgetMs > 0 && (nowMs - startMs) >= budgetMs;
}

// SQL string literal with single quotes doubled. Used for every text value in the
// emitted .sql; the only untrusted text is OSM-derived beach and park names.
export function sqlStr(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// A finite number inlined literally, or NULL. lat/lon are validated finite by
// the layer reader before they ever reach a row, but guard anyway.
export function sqlNum(value) {
  if (typeof value !== "number" || !isFinite(value)) {
    return "NULL";
  }
  return String(value);
}

function log(msg) {
  // Logs to stderr so stdout stays clean; the SQL goes to the --out file.
  console.error("discovery-batch: " + msg);
}

export function parseArgs(argv) {
  const args = {
    snapshot: null,
    out: "discovery-delta.sql",
    discovery: true,        // --no-discovery => classify-only run (no upserts, no reconciliation)
    classify: true,
    layers: null,           // directory holding the verified layer set + report.json
    report: null,           // defaults to <layers>/report.json once --layers is known
    marineZones: null,      // path to data/marine-zones.json => run the offline marine_zone pass
    now: null
  };
  for (let i = 0; i < argv.length; i = i + 1) {
    const a = argv[i];
    if (a === "--snapshot") { args.snapshot = argv[++i]; }
    else if (a === "--out") { args.out = argv[++i]; }
    else if (a === "--no-discovery") { args.discovery = false; }
    else if (a === "--no-classify") { args.classify = false; }
    else if (a === "--layers") { args.layers = argv[++i]; }
    else if (a === "--report") { args.report = argv[++i]; }
    else if (a === "--marine-zones") { args.marineZones = argv[++i]; }
    else if (a === "--now") { args.now = argv[++i]; }
    else { throw new Error("unknown argument: " + a); }
  }
  // Derived after the loop so the default holds regardless of flag order. An
  // explicit --report wins; without --layers there is nothing to derive from and
  // the value stays null, so the run refuses at the guard in main.
  if (args.report === null && args.layers !== null) {
    args.report = joinLayerPath(args.layers, "report.json");
  }
  return args;
}

// Join a layer directory and a file name with exactly one separator. The directory
// comes from a workflow env var, so a trailing slash is realistic and a doubled
// separator produces a path that reads fine in a log and fails to open.
export function joinLayerPath(dir, name) {
  const base = String(dir);
  if (base === "" || base.charAt(base.length - 1) === "/") {
    return base + name;
  }
  return base + "/" + name;
}

// wrangler d1 execute --json emits [{ results: [...], success, meta }]; accept
// that, a bare { results }, or a bare array, so a hand-fed snapshot also works.
export function parseSnapshot(text) {
  if (!text || text.trim() === "") {
    return [];
  }
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) {
    if (parsed.length > 0 && parsed[0] && Array.isArray(parsed[0].results)) {
      return parsed[0].results;
    }
    return parsed;
  }
  if (parsed && Array.isArray(parsed.results)) {
    return parsed.results;
  }
  return [];
}

// --- The layer set ----------------------------------------------------------

// Pure structural self-check on LAYER_FILES: every published key must be consumed
// by exactly one logical layer (parks-polygon.fgb is the one deliberate double,
// feeding both the membership tier and the naming tier), and no list may name a
// file the build does not publish. Drift here neither throws nor warns at runtime,
// it silently zeroes a logical layer, so it is asserted instead. Returns
// { missing, unexpected }; both empty means the plan is sound.
export function layerFilePlanProblems() {
  const named = [];
  const keys = Object.keys(LAYER_FILES);
  for (let i = 0; i < keys.length; i = i + 1) {
    const list = LAYER_FILES[keys[i]];
    for (let j = 0; j < list.length; j = j + 1) {
      if (named.indexOf(list[j]) === -1) {
        named.push(list[j]);
      }
    }
  }
  const missing = [];
  for (let i = 0; i < EXPECTED_LAYER_KEYS.length; i = i + 1) {
    if (named.indexOf(EXPECTED_LAYER_KEYS[i]) === -1) {
      missing.push(EXPECTED_LAYER_KEYS[i]);
    }
  }
  const unexpected = [];
  for (let i = 0; i < named.length; i = i + 1) {
    if (EXPECTED_LAYER_KEYS.indexOf(named[i]) === -1) {
      unexpected.push(named[i]);
    }
  }
  return { missing: missing, unexpected: unexpected };
}

// Split other-relations.fgb into its beach half and its park half by tag, using
// the same branch-precedence chain the rest of discovery uses
// (classifyLayerFeature): natural=beach wins over named-and-park-tagged, which
// wins over water. A named protected lake carries park tags and natural=water and
// must keep donating its name, so that order is load-bearing and is not
// re-implemented here. A feature that is neither is dropped: the layer also
// carries type=site relations.
export function splitOtherRelations(features) {
  const beaches = [];
  const parks = [];
  const list = Array.isArray(features) ? features : [];
  for (let i = 0; i < list.length; i = i + 1) {
    const classified = classifyLayerFeature(list[i]);
    if (classified === null) {
      continue;
    }
    if (classified.kind === "beach") {
      beaches.push(list[i]);
    } else if (classified.kind === "park") {
      parks.push(list[i]);
    }
  }
  return { beaches: beaches, parks: parks };
}

// Read one logical layer as an ARRAY of normalized LayerFeatures. Deno-only.
async function readLogicalLayer(dir, fileNames) {
  const out = [];
  for (let i = 0; i < fileNames.length; i = i + 1) {
    const name = fileNames[i];
    const rows = await readLayerFile(joinLayerPath(dir, name), name);
    for (let j = 0; j < rows.length; j = j + 1) {
      out.push(rows[j]);
    }
  }
  return out;
}

// One pass over a streamed probe layer, feeding two consumers per feature: the
// signals index builder (every feature, geometry chopped into typed-array
// segments and dropped) and the discovery retention list (only what the pond
// pool could use, see pondEvidenceCandidate). features may be any iterable or
// async iterable of LayerFeatures. builder may be null when this run builds no
// signals index. Returns { streamed, retained }.
export async function splitProbeLayer(features, layerName, builder, filter) {
  let streamed = 0;
  const retained = [];
  for await (const feature of features) {
    streamed = streamed + 1;
    if (builder !== null) {
      addSignalsFeature(builder, layerName, feature);
    }
    if (pondEvidenceCandidate(filter, feature)) {
      retained.push(feature);
    }
  }
  return { streamed: streamed, retained: retained };
}

// Stream one logical layer's files through splitProbeLayer. Deno-only.
async function streamLogicalLayer(dir, layerName, builder, filter) {
  let streamed = 0;
  let retained = [];
  const fileNames = LAYER_FILES[layerName];
  for (let i = 0; i < fileNames.length; i = i + 1) {
    const name = fileNames[i];
    const split = await splitProbeLayer(readFgbStream(joinLayerPath(dir, name), layerName),
      layerName, builder, filter);
    streamed = streamed + split.streamed;
    retained = retained.concat(split.retained);
  }
  return { streamed: streamed, retained: retained };
}

// Load the layer set discoverFromLayers consumes and, when wantSignals is true,
// build the classification index in the same pass.
//
// beaches and parks are materialised: membership, association and the pond
// filter all need whole geometry, not envelopes. coastline, water and lakes are
// streamed exactly once each and never held as arrays; every feature goes into
// the segment-grid index, and a coastline or water feature is retained for
// discovery only when it is a way whose radius-padded envelope overlaps a beach
// envelope, which is everything the pond pool can use. Peak memory for the
// retained subset is O(beaches), not O(coast), so a continental coastline costs
// this process only its typed-array segments.
//
// The index is built here rather than in a second read so both halves of the run
// see one identical view of the beach set: the beaches array below is the one
// discovery scans and the one the index is keyed on, so "absent from the layer
// set" can never mean "absent from the copy classification happened to read".
//
// Returns { layerSet, signalsIndex, counts } where layerSet is exactly the shape
// discoverFromLayers takes, signalsIndex is null unless wantSignals, and counts
// carries the streamed totals beside the retained sizes for the run log.
async function loadLayerSet(dir, wantSignals) {
  const beaches = await readLogicalLayer(dir, LAYER_FILES.beaches);
  const parksPoly = await readLogicalLayer(dir, LAYER_FILES.parksPoly);
  const parksName = await readLogicalLayer(dir, LAYER_FILES.parksName);
  const other = await readLogicalLayer(dir, LAYER_FILES.otherRelations);
  const split = splitOtherRelations(other);
  const allBeaches = beaches.concat(split.beaches);

  const builder = wantSignals ? beginSignalsIndex() : null;
  if (builder !== null) {
    for (let i = 0; i < allBeaches.length; i = i + 1) {
      addSignalsFeature(builder, "beaches", allBeaches[i]);
    }
  }
  const filter = buildPondEvidenceFilter(allBeaches);
  const coastline = await streamLogicalLayer(dir, "coastline", builder, filter);
  const water = await streamLogicalLayer(dir, "water", builder, filter);
  let lakesStreamed = 0;
  if (builder !== null) {
    // lakes feed the index only; discovery never reads them, so nothing is
    // retained and the filter is not consulted.
    for (let i = 0; i < LAYER_FILES.lakes.length; i = i + 1) {
      const name = LAYER_FILES.lakes[i];
      for await (const feature of readFgbStream(joinLayerPath(dir, name), "lakes")) {
        lakesStreamed = lakesStreamed + 1;
        addSignalsFeature(builder, "lakes", feature);
      }
    }
  }
  return {
    layerSet: {
      beaches: allBeaches,
      parksPoly: parksPoly,
      parksName: parksName.concat(split.parks),
      coastline: coastline.retained,
      water: water.retained
    },
    signalsIndex: builder === null ? null : finishSignalsIndex(builder),
    counts: {
      otherRelations: other.length,
      coastlineStreamed: coastline.streamed,
      coastlineRetained: coastline.retained.length,
      waterStreamed: water.streamed,
      waterRetained: water.retained.length,
      lakesStreamed: lakesStreamed
    }
  };
}

// --- The manifest gate ------------------------------------------------------

// sha256 hex of a UTF-8 string, through Web Crypto so it is identical under Deno,
// workerd and node — and identical to what scripts/build-manifest.js computes. The
// two sides must agree bit for bit or every run refuses to delete.
async function sha256OfText(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i = i + 1) {
    const b = view[i].toString(16);
    hex = hex + (b.length === 1 ? "0" + b : b);
  }
  return hex;
}

// Age of the OSM data cutoff in days. Returns NaN for a missing or unparseable
// timestamp, which is correct: NaN fails the gate's range check, and refusing to
// delete because the age is unknowable is the same answer as refusing because it
// is too old.
export function sourceAgeDays(oldestSourceTimestamp, nowIso) {
  const then = Date.parse(String(oldestSourceTimestamp));
  const now = Date.parse(String(nowIso));
  if (!isFinite(then) || !isFinite(now)) {
    return NaN;
  }
  return (now - then) / 86400000;
}

// Fold in the two conjuncts scripts/fetch-layers.js cannot compute: it does not
// import src/regions.js and has no run clock. Their absence from the fetched
// report is fail-closed by design, since a strict !== true refuses exactly as
// false does, so this must run before the report reaches any predicate.
//
// Returns a new object rather than mutating, so a caller holding the fetched
// report still sees what fetch-layers.js wrote.
export function applyRunConjuncts(report, nowIso, regionsDigest) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return report;
  }
  const merged = Object.assign({}, report);
  merged.regionsDigestMatches = typeof report.regionsDigest === "string" &&
    report.regionsDigest !== "" && report.regionsDigest === regionsDigest;
  merged.sourceAgeDays = sourceAgeDays(report.oldestSourceTimestamp, nowIso);
  return merged;
}

// The delete-path choke point, kept as a thin wrapper rather than a bare re-export
// so this file names the invariant it depends on, and so the unit test proving
// "unproven coverage means no delete" keeps importing it from the module that
// emits the DELETEs.
//
// Every conjunct inside is a strict identity comparison, so a missing field
// refuses exactly as an explicitly false one does — the realistic failure, since
// the report is assembled by three separate scripts.
export function reconciliationAllowed(report) {
  return manifestReconciliationAllowed(report);
}

// The weaker predicate, and the one classification is gated on. A partial view of
// OSM makes classifyWaterBody's clean-but-empty branch decide "inland", which
// hides a beach, so genuine incompleteness must stop classification. Staleness and
// a regions-digest mismatch must not: an old extract's geometry is complete, just
// older, and a digest mismatch is what an expansion commit produces by
// construction. Gating classification on either would turn that commit into a mass
// fail-open event, publishing thousands of unclassified new-coast beaches live
// with estimated flag cards until a rebuild lands.
export function classificationAllowed(report) {
  return manifestClassificationAllowed(report);
}

// --- SQL builders (mirror the exact statements the Worker upsert used) -------

export function upsertSql(row, hasPark) {
  const idL = sqlStr(row.id);
  const nameL = sqlStr(row.name);
  const latL = sqlNum(row.lat);
  const lonL = sqlNum(row.lon);
  const osmL = sqlStr(row.osmId);
  // The "moved" guard: an unqualified column in ON CONFLICT ... DO UPDATE is the
  // existing row value; the literal lat/lon are the newly-discovered centroid.
  const moved = " CASE WHEN (abs(lat - " + latL + ") > " + String(WATER_CLASS_MOVE_DEG) +
    " OR abs(lon - " + lonL + ") > " + String(WATER_CLASS_MOVE_DEG) + ") THEN ";
  if (!hasPark) {
    return "INSERT INTO beaches (id, name, lat, lon, osm_id) VALUES (" +
      idL + ", " + nameL + ", " + latL + ", " + lonL + ", " + osmL + ") " +
      "ON CONFLICT(id) DO UPDATE SET name = " + nameL + ", lat = " + latL + ", lon = " + lonL + ", " +
      "water_class = " + moved + "NULL ELSE water_class END, " +
      "water_class_version = " + moved + "NULL ELSE water_class_version END, " +
      "water_class_attempts = " + moved + "0 ELSE water_class_attempts END;";
  }
  const parkL = sqlStr(row.parkName);
  return "INSERT INTO beaches (id, name, lat, lon, osm_id, park_name) VALUES (" +
    idL + ", " + nameL + ", " + latL + ", " + lonL + ", " + osmL + ", " + parkL + ") " +
    "ON CONFLICT(id) DO UPDATE SET name = " + nameL + ", lat = " + latL + ", lon = " + lonL +
    ", park_name = " + parkL + ", " +
    "water_class = " + moved + "NULL ELSE water_class END, " +
    "water_class_version = " + moved + "NULL ELSE water_class_version END, " +
    "water_class_attempts = " + moved + "0 ELSE water_class_attempts END;";
}

export function syncMetaSql(key, value, nowIso) {
  return "INSERT INTO sync_meta (key, value, updated) VALUES (" +
    sqlStr(key) + ", " + sqlStr(value) + ", " + sqlStr(nowIso) + ") " +
    "ON CONFLICT(key) DO UPDATE SET value = " + sqlStr(value) + ", updated = " + sqlStr(nowIso) + ";";
}

export function deleteBeachSql(id) {
  return "DELETE FROM beaches WHERE id = " + sqlStr(id) + ";";
}

// --- Stale park-beach reconciliation — the only delete path ------------------

// The first REGIONS entry whose bbox contains the point, or null. Boxes overlap by
// design, so first-match-wins is the tie-break, deterministic because REGIONS
// order is fixed source. Bounds are inclusive and non-finite inputs return null,
// matching pointInAnyRegion exactly: the two must never disagree about whether a
// row is in scope.
export function regionForPoint(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") {
    return null;
  }
  if (!isFinite(lat) || !isFinite(lon)) {
    return null;
  }
  for (let i = 0; i < REGIONS.length; i = i + 1) {
    const b = REGIONS[i].bbox;
    if (lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon) {
      return REGIONS[i].name;
    }
  }
  return null;
}

// The per-region proportional rail. Buckets candidates and stale rows by
// regionForPoint and refuses the entire reconciliation if any single region
// exceeds its own max(REGION_RECONCILE_MIN_DELETES, ceil(fraction * n)) allowance.
// Refusing everything rather than just that region is deliberate: a region-scale
// anomaly is evidence about the layer set as a whole, and partial deletes under
// suspicion are worse than none.
//
// Returns { allowed, region, staleCount, allowance, regions }. On a refusal,
// region/staleCount/allowance describe the first offending region in REGIONS
// order; on an allow, region is null, staleCount is the total stale rows bucketed
// and allowance the sum of the per-region allowances. The regions array carries
// the full tally for the run log.
export function regionDeleteRailAllows(candidates, stale) {
  const buckets = new Map();
  const bucketFor = function (name) {
    if (!buckets.has(name)) {
      buckets.set(name, { name: name, candidates: 0, stale: 0 });
    }
    return buckets.get(name);
  };
  const candidateList = Array.isArray(candidates) ? candidates : [];
  const staleList = Array.isArray(stale) ? stale : [];
  for (let i = 0; i < candidateList.length; i = i + 1) {
    const row = candidateList[i];
    const name = regionForPoint(row.lat, row.lon);
    if (name === null) {
      continue;
    }
    bucketFor(name).candidates = bucketFor(name).candidates + 1;
  }
  for (let i = 0; i < staleList.length; i = i + 1) {
    const row = staleList[i];
    const name = regionForPoint(row.lat, row.lon);
    if (name === null) {
      // reconcileStaleRows scopes out-of-region rows out upstream, so one
      // arriving here is a caller bug. Skipping it keeps the rail from silently
      // attributing a delete to the wrong region.
      continue;
    }
    bucketFor(name).stale = bucketFor(name).stale + 1;
  }
  // Walk in REGIONS order, not Map insertion order, so the reported offender is
  // deterministic no matter what order the snapshot happened to arrive in.
  const tallies = [];
  let totalStale = 0;
  let totalAllowance = 0;
  for (let i = 0; i < REGIONS.length; i = i + 1) {
    const bucket = buckets.get(REGIONS[i].name);
    if (bucket === undefined) {
      continue;
    }
    const allowance = Math.max(
      REGION_RECONCILE_MIN_DELETES,
      Math.ceil(bucket.candidates * REGION_RECONCILE_MAX_DELETE_FRACTION)
    );
    tallies.push({
      name: bucket.name,
      candidates: bucket.candidates,
      stale: bucket.stale,
      allowance: allowance
    });
    totalStale = totalStale + bucket.stale;
    totalAllowance = totalAllowance + allowance;
  }
  for (let i = 0; i < tallies.length; i = i + 1) {
    if (tallies[i].stale > tallies[i].allowance) {
      return {
        allowed: false,
        region: tallies[i].name,
        staleCount: tallies[i].stale,
        allowance: tallies[i].allowance,
        regions: tallies
      };
    }
  }
  return {
    allowed: true,
    region: null,
    staleCount: totalStale,
    allowance: totalAllowance,
    regions: tallies
  };
}

// Returns the snapshot rows that will be deleted this run, after the rails, or []
// when reconciliation is skipped or refused. The single source for both the
// emitted DELETEs and the classify-universe exclusion set, so those cannot
// diverge. Candidates are unnamed-origin park rows (name = park_name) inside any
// region from the D1 snapshot; stale means not produced this run.
//
// The allowance denominator comes from the pre-upsert snapshot only, so this run's
// brand-new park rows are not in it. The stale set is identical either way, since
// new rows are in producedIds and never stale; only the denominator differs, which
// makes this at most stricter — the safe direction for a never-mass-delete rail.
//
// The candidate set is bounded by pointInAnyRegion, so a snapshot row outside every
// REGION bbox is never a delete candidate. Shrinking a REGION box therefore only
// removes delete candidates, and widening one is refused upstream by the
// regions-digest conjunct of reconciliationAllowed, because a layer set built
// before the widening has no features in the new box and every D1 row there would
// read as gone.
export function reconcileStaleRows(snapshotRows, producedIds, producedParkRowCount) {
  if (producedParkRowCount === 0) {
    log("reconciliation skipped, run produced 0 park-containment rows");
    return [];
  }
  const candidates = snapshotRows.filter(function (r) {
    return r.park_name !== null && r.park_name !== undefined &&
      r.name === r.park_name && pointInAnyRegion(r.lat, r.lon);
  });
  const stale = candidates.filter(function (r) { return !producedIds.has(r.id); });
  const allowance = Math.max(
    RECONCILE_MAX_DELETES,
    Math.ceil(candidates.length * RECONCILE_MAX_DELETE_FRACTION)
  );
  if (stale.length > allowance) {
    log("reconciliation REFUSING to delete " + String(stale.length) + " stale rows (allowance " +
      String(allowance) + " of " + String(candidates.length) + " candidates) — keeping all rows");
    return [];
  }
  const regionRail = regionDeleteRailAllows(candidates, stale);
  if (!regionRail.allowed) {
    log("reconciliation REFUSING on the per-region rail: " + regionRail.region + " has " +
      String(regionRail.staleCount) + " stale rows against an allowance of " +
      String(regionRail.allowance) + " — keeping ALL rows in EVERY region");
    return [];
  }
  log("reconciliation candidates=" + String(candidates.length) + " deleting=" + String(stale.length) +
    " region_rail_total_allowance=" + String(regionRail.allowance));
  return stale;
}

// The delete rail's full composition, a real builder so nothing has to mirror
// main() by hand: reconcileStaleRows decides the set, deleteBeachSql renders it,
// and both the emitted SQL and the classify-universe exclusion set come from the
// same rows. Returns { rows, statements }.
// The three run-level preconditions on emitting any DELETE, as a pure predicate so
// the gate is unit-testable. main() is orchestration and is not exercised by the
// suite, so every decision it makes that can destroy data is pulled out to here.
//
// hasPark is a precondition rather than a warning because the delete-candidate set
// is exclusively park-origin rows (park_name != null && name === park_name).
// parksLayerHealthy is the only signal that the parks layer is under-populated,
// and an under-populated parks layer makes real beaches fail park membership, drop
// out of producedIds and read as stale. The proportional rails cannot see that
// band: a parks build at 0.96x clears every build gate, which refuse below 0.95x,
// while producing enough deletes to sit just under the global allowance. A false
// refusal costs one skipped day of reconciliation; a false delete is irreversible
// and discards enrichment that took weeks of cron runs to acquire.
export function reconciliationGate(coverageComplete, hasPark, hasSnapshot) {
  if (!coverageComplete) {
    return {
      allowed: false,
      reason: "the layer set is not provably complete, in-scope and fresh"
    };
  }
  if (!hasPark) {
    return {
      allowed: false,
      reason: "parksLayerHealthy=false — the parks layer is under-populated and delete " +
        "candidates are exclusively park-origin rows, so a missing polygon reads as a stale beach"
    };
  }
  if (!hasSnapshot) {
    return { allowed: false, reason: "no snapshot to compare against" };
  }
  return { allowed: true, reason: "layer set verified, parks layer healthy, snapshot present" };
}

export function reconciliationDelta(snapshotRows, producedIds, producedParkRowCount) {
  const rows = reconcileStaleRows(snapshotRows, producedIds, producedParkRowCount);
  const statements = [];
  for (let i = 0; i < rows.length; i = i + 1) {
    statements.push(deleteBeachSql(rows[i].id));
  }
  return { rows: rows, statements: statements };
}

// --- Offline marine_zone derivation ------------------------------------------
// Pure local math against the repo-committed data/marine-zones.json
// (see src/marineZones.js and scripts/build-marine-zones.js). Mirrors
// reconcileStaleRows:
//   - operates only on snapshot rows, so a beach discovered this run resolves on
//     the next daily run, once NWS enrichment has stamped nws_zone;
//   - skips rows in this run's reconciliation delete set;
//   - re-derives for every row with nws_zone set, not just marine_zone-NULL rows,
//     because taking the first ring hit is not the true nearest zone and historic
//     values must self-correct;
//   - emits an UPDATE only when the derived zone is non-null and differs from the
//     snapshot value; a derived null never NULLs out an existing value, since
//     marine alerts are a bonus signal and an old value beats nothing.
// Derivation is deterministic (see nearestMarineZone's tie-break), so a
// steady-state run emits zero statements. The SQL-side guards keep each statement
// idempotent and safe under a stale snapshot. beaches.marine_attempts is
// vestigial: the column stays but nothing writes it.
export function marineZoneSql(snapshotRows, deletedIds, index) {
  const statements = [];
  let considered = 0;
  let updates = 0;
  for (const row of snapshotRows) {
    if (deletedIds.has(row.id)) {
      continue;
    }
    if (typeof row.nws_zone !== "string" || row.nws_zone === "") {
      continue;
    }
    considered = considered + 1;
    const derived = nearestMarineZone(index, row.lat, row.lon);
    if (derived === null) {
      continue;
    }
    const existing = row.marine_zone === undefined ? null : row.marine_zone;
    if (derived === existing) {
      continue;
    }
    statements.push(
      "UPDATE beaches SET marine_zone = " + sqlStr(derived) + " WHERE id = " + sqlStr(row.id) +
      " AND nws_zone IS NOT NULL AND (marine_zone IS NULL OR marine_zone <> " + sqlStr(derived) + ");"
    );
    updates = updates + 1;
  }
  return { statements: statements, considered: considered, updates: updates };
}

// --- Classification queue ---------------------------------------------------
// Build the post-upsert view of every beach (snapshot ∪ newly discovered, minus
// reconcile-deletes), then queue the ones that still need classifying. This
// unifies whole-table classification with the discovery delta into one offline
// pass, respecting the same (water_class NULL OR version < WATER_CLASS_VERSION)
// AND attempts < WATER_CLASS_MAX_ATTEMPTS gate. New and moved rows enter as
// unclassified.
//
// Plus a one-time legacy re-drain: rows left unclassified at or above the attempts
// cap by the pre-decisive classifier (see the clean-but-empty note in
// src/waterClass.js) are admitted despite the cap, identified by
// water_class_version IS NULL, since a row that ever reached a decision carries a
// stamped version. Their attempts are deliberately not reset: at the cap they stay
// hidden by FLAG_WORTHY_WATER_SQL, so they re-decide quietly instead of all
// reappearing on the live site with estimated flag cards while they drain. The set
// drains to empty and cannot refill, because the decisive classifier never returns
// null for a complete probe.
// Pure; exported for tests. Whole-table classification visibility, logged every
// classify run because a NULL-hide with no metric is silent product loss (PLAN.md
// section 7 requires these counts):
//   parked        - water_class IS NULL at or above the attempts cap: hidden, and
//                   under the decisive classifier this can only shrink. A rising
//                   parked count means the classifier regressed to a pending state.
//   hidden_inland - decided inland: hidden on purpose, the product working.
//   pending_visible - water_class IS NULL under the cap. These are fail-open: the
//                   site lists them and serves them estimated flag cards before
//                   they are known to be flag-worthy water. It should stay near the
//                   size of one discovery delta and drain to about zero after each
//                   classify run.
export function classifyCoverageCounts(snapshotRows, deletedIds) {
  const skip = deletedIds || new Set();
  const counts = { parked: 0, hidden_inland: 0, pending_visible: 0, flag_worthy: 0 };
  for (const r of snapshotRows) {
    if (skip.has(r.id)) {
      continue;
    }
    const wc = r.water_class === undefined ? null : r.water_class;
    const attempts = typeof r.water_class_attempts === "number" ? r.water_class_attempts : 0;
    if (wc === "ocean" || wc === "great_lake") {
      counts.flag_worthy = counts.flag_worthy + 1;
    } else if (wc === "inland") {
      counts.hidden_inland = counts.hidden_inland + 1;
    } else if (attempts >= WATER_CLASS_MAX_ATTEMPTS) {
      counts.parked = counts.parked + 1;
    } else {
      counts.pending_visible = counts.pending_visible + 1;
      counts.flag_worthy = counts.flag_worthy + 1;
    }
  }
  return counts;
}

export function buildClassifyQueue(snapshotRows, mergedRows, deletedIds) {
  const byId = new Map();
  for (const r of snapshotRows) {
    byId.set(r.id, {
      id: r.id,
      osm_id: r.osm_id,
      lat: r.lat,
      lon: r.lon,
      water_class: r.water_class === undefined ? null : r.water_class,
      water_class_version: r.water_class_version === undefined ? null : r.water_class_version,
      water_class_attempts: typeof r.water_class_attempts === "number" ? r.water_class_attempts : 0
    });
  }
  for (const row of mergedRows) {
    const prev = byId.get(row.id);
    const moved = prev &&
      typeof prev.lat === "number" && typeof prev.lon === "number" &&
      (Math.abs(prev.lat - row.lat) > WATER_CLASS_MOVE_DEG ||
        Math.abs(prev.lon - row.lon) > WATER_CLASS_MOVE_DEG);
    if (!prev || moved) {
      // New row, or moved centroid: the upsert resets water_class.
      byId.set(row.id, {
        id: row.id,
        osm_id: row.osmId,
        lat: row.lat,
        lon: row.lon,
        water_class: null,
        water_class_version: null,
        water_class_attempts: 0
      });
    } else {
      // Existing, not moved — keep its class/version/attempts, refresh geometry.
      prev.osm_id = row.osmId;
      prev.lat = row.lat;
      prev.lon = row.lon;
    }
  }
  const queue = [];
  for (const b of byId.values()) {
    if (deletedIds.has(b.id)) {
      continue;
    }
    const unclassified = b.water_class === null || b.water_class === undefined;
    const staleVersion = typeof b.water_class_version === "number" &&
      b.water_class_version < WATER_CLASS_VERSION;
    const underCap = b.water_class_attempts < WATER_CLASS_MAX_ATTEMPTS;
    // Legacy park marker: unclassified, at or above the cap, never versioned.
    const parkedPreDecisive = unclassified && !underCap &&
      (b.water_class_version === null || b.water_class_version === undefined);
    const needs = ((unclassified || staleVersion) && underCap) || parkedPreDecisive;
    if (needs) {
      queue.push(b);
    }
  }
  // Lowest attempts first, mirroring ORDER BY water_class_attempts ASC, then id
  // for deterministic ordering under an injected limit.
  queue.sort(function (a, b) {
    if (a.water_class_attempts !== b.water_class_attempts) {
      return a.water_class_attempts - b.water_class_attempts;
    }
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
  return queue;
}

// The two production-mutating classify statements: a decision stores water_class
// and version and resets attempts to 0; a clean-but-empty answer bumps attempts by
// 1. Pure builders so the emitted SQL is unit-tested, since a typo here silently
// mis-classifies at scale.
export function classifyUpdateSql(id, cls) {
  return "UPDATE beaches SET water_class = " + sqlStr(cls) +
    ", water_class_version = " + String(WATER_CLASS_VERSION) +
    ", water_class_attempts = 0 WHERE id = " + sqlStr(id) + ";";
}

export function bumpAttemptsSql(id) {
  return "UPDATE beaches SET water_class_attempts = water_class_attempts + 1 WHERE id = " +
    sqlStr(id) + ";";
}

// Probe and classify each queued beach. The probe is a local spatial join
// (src/layerSignals.js) rather than a per-beach network call, so the production
// call site passes no limit, delay or budget; the parameters and their code paths
// stay wired and tested because the join's cost at continental scale is a
// prediction.
//
// Outcomes, and why they differ:
//   - a decision -> store water_class and version, reset attempts to 0;
//   - a clean-but-empty answer (classify returns null) -> bump attempts;
//   - null signals, known absent from a verified layer set -> bump attempts. The
//     element is gone from OSM, which is a real answer rather than a failure.
//     Without this the row would re-queue forever with attempts stuck at 0 and
//     FLAG_WORTHY_WATER_SQL's fail-open would serve it live with an estimated flag
//     card permanently. The bump is armed only under a verified set (see
//     isKnownAbsent's wiring in main): under an unverified one, absent means "we
//     cannot see it", and parking every beach on a newly-added coast is the
//     failure that gate stops.
//   - null signals otherwise -> transient: no SQL, row stays queued.
//
// opts.fetchSignals, opts.classify and opts.isKnownAbsent are injected, so the
// loop runs in tests with zero I/O and a different provider can be dropped in
// without touching the queue, the SQL or the gating.
export async function classifyQueue(queue, options) {
  const opts = options || {};
  const limit = opts.limit || 0;
  const delayMs = opts.delayMs || 0;
  const budgetMs = opts.budgetMs || 0;
  const now = opts.now || Date.now;
  // The signals index is built per run and must be injected. A missing provider is
  // a wiring bug and fails loudly on first use rather than silently marking the
  // whole table transient, which would emit an empty delta that looks like a
  // healthy no-op run.
  const fetchSignals = opts.fetchSignals || function () {
    throw new Error("classifyQueue: no fetchSignals provider was injected");
  };
  const classify = opts.classify || classifyWaterBody;
  const isKnownAbsent = opts.isKnownAbsent || function () { return false; };
  const flush = opts.flush || null;
  const statements = [];
  // verdicts feeds classificationFlipRailAllows: id -> the class this run decided.
  // Bumps are absent, because the rail measures re-decisions and a bump is the
  // absence of one.
  const verdicts = new Map();
  // inland_no_water is a subset of inland, not a separate class: the rows decided
  // by the clean-but-empty branch rather than by a real adjacent water way. Both
  // store 'inland', but the split is the only way a run log can tell "confirmed on
  // an inland lake" from "nothing mapped within the probe radii".
  // absent_from_layers is likewise a subset of bumped, and a rising value is a
  // build alarm rather than a data observation: it says D1 holds beaches the
  // published layer set does not.
  const counts = {
    attempted: 0, classified: 0, ocean: 0, great_lake: 0, inland: 0,
    inland_no_water: 0, bumped: 0, absent_from_layers: 0, transient: 0
  };
  const total = limit > 0 ? Math.min(limit, queue.length) : queue.length;
  // buildClassifyQueue returns a deterministic order (attempts ASC, id), which is
  // right for the scheduled full drain. Under a partial limit, always taking the
  // lowest ids would starve the tail across repeated dispatches, since transient
  // failures do not bump attempts and the same rows resort to the front every
  // time. So randomize within equal-attempts groups, but only when capping.
  let ordered = queue;
  if (limit > 0 && total < queue.length) {
    ordered = queue.slice();
    for (let j = ordered.length - 1; j > 0; j = j - 1) {
      const k = Math.floor(Math.random() * (j + 1));
      const tmp = ordered[j]; ordered[j] = ordered[k]; ordered[k] = tmp;
    }
    // Stable sort (V8) => attempts ASC preserved, random order within a group.
    ordered.sort(function (a, b) { return a.water_class_attempts - b.water_class_attempts; });
  }
  // Per-statement flush so a statement-boundary-clean partial .sql always exists
  // on disk even under a hard kill; each statement is a complete UPDATE. Unused by
  // the production call site, which writes the whole delta atomically, and kept
  // because it has to come back at continental scale.
  const emit = async function (stmt) {
    statements.push(stmt);
    if (flush) {
      await flush(stmt);
    }
  };
  const startMs = now();
  let stopped = false;
  let processed = 0;
  for (let i = 0; i < total; i = i + 1) {
    if (budgetExhausted(startMs, budgetMs, now())) {
      stopped = true;
      log("classify budget reached after " + String(now() - startMs) + "ms — stopping at " +
        String(i) + "/" + String(total) + "; " + String(total - i) + " remain queued for the next run");
      break;
    }
    const beach = ordered[i];
    counts.attempted = counts.attempted + 1;
    let signals = null;
    let threw = false;
    try {
      signals = await fetchSignals(beach);
    } catch (err) {
      log("water class signals threw for " + beach.id + ": " + err.message);
      signals = null;
      threw = true;
    }
    if (signals === null) {
      // A thrown provider is always transient: it says the probe failed, never
      // that the element is missing. Only a clean null is eligible for the
      // absent-from-layers reading.
      let absent = false;
      if (!threw) {
        try {
          absent = isKnownAbsent(beach) === true;
        } catch (err) {
          log("absent-from-layers check threw for " + beach.id + ": " + err.message);
          absent = false;
        }
      }
      if (absent) {
        await emit(bumpAttemptsSql(beach.id));
        counts.bumped = counts.bumped + 1;
        counts.absent_from_layers = counts.absent_from_layers + 1;
      } else {
        counts.transient = counts.transient + 1;
      }
    } else {
      const cls = classify(signals);
      if (cls !== null) {
        await emit(classifyUpdateSql(beach.id, cls));
        verdicts.set(beach.id, cls);
        counts.classified = counts.classified + 1;
        counts[cls] = counts[cls] + 1;
        if (cls === "inland" && signals.nearbyWayWater !== true) {
          counts.inland_no_water = counts.inland_no_water + 1;
        }
      } else {
        await emit(bumpAttemptsSql(beach.id));
        counts.bumped = counts.bumped + 1;
      }
    }
    if ((counts.attempted % 250) === 0) {
      log("classified " + String(counts.attempted) + "/" + String(total) + " (" +
        String(counts.classified) + " decided, " + String(counts.transient) + " transient)");
    }
    processed = i + 1;
    if (i < total - 1) {
      await sleep(delayMs);
    }
  }
  if (limit > 0 && queue.length > total) {
    log("NOTE: the injected limit capped this run at " + String(total) + " of " +
      String(queue.length) + " eligible beaches; re-run to drain the rest");
  }
  return {
    statements: statements,
    counts: counts,
    verdicts: verdicts,
    stopped: stopped,
    processed: processed
  };
}

// --- The classification flip rail -------------------------------------------

const FLIP_RAIL_CLASSES = ["great_lake", "ocean", "inland"];

function flipRailRowKey(value) {
  return FLIP_RAIL_CLASSES.indexOf(value) === -1 ? "unclassified" : value;
}

function isFlagWorthyClass(value) {
  return value === "ocean" || value === "great_lake";
}

// The one rail that is not on the delete path. Structurally identical to
// reconcileStaleRows: it refuses the entire water_class UPDATE block when the
// proposed flag-worthy -> inland flip set is too large.
//
// A hide needs a rail because deciding "inland" removes a beach from
// FLAG_WORTHY_WATER_SQL and the site stops serving it. That is the same product
// loss as deleting the row, it arrives faster, and it is invisible in the row
// count, so no delete rail can see it. Every served flag-worthy row classifies
// through one code path, so a broken build plus a WATER_CLASS_VERSION bump
// re-decides all of them in a single delta.
//
// Asymmetric by design: inland -> flag-worthy only warns, because un-hiding
// beaches is recoverable and self-correcting and refusing it would make a
// legitimate coverage improvement undeployable. A NULL -> inland decision is the
// normal drain and is not a flip.
//
// Refusing the whole block, bumps included, follows the delete rails: at this
// magnitude the evidence is about the layer set, and a mass attempts-bump parks
// rows just as effectively as a mass inland decision hides them.
//
// verdictsById may be a Map or a plain object. Returns
// { allowed, hideFlips, unhideFlips, allowance, flagWorthy, matrix }.
export function classificationFlipRailAllows(snapshotRows, verdictsById) {
  const rows = Array.isArray(snapshotRows) ? snapshotRows : [];
  const lookup = function (id) {
    if (verdictsById === null || verdictsById === undefined) {
      return undefined;
    }
    if (typeof verdictsById.get === "function") {
      return verdictsById.get(id);
    }
    return verdictsById[id];
  };
  const matrix = {};
  const rowKeys = FLIP_RAIL_CLASSES.concat(["unclassified"]);
  for (let i = 0; i < rowKeys.length; i = i + 1) {
    matrix[rowKeys[i]] = { great_lake: 0, ocean: 0, inland: 0 };
  }
  let flagWorthy = 0;
  let hideFlips = 0;
  let unhideFlips = 0;
  for (let i = 0; i < rows.length; i = i + 1) {
    const row = rows[i];
    const before = row.water_class === undefined ? null : row.water_class;
    if (isFlagWorthyClass(before)) {
      flagWorthy = flagWorthy + 1;
    }
    const after = lookup(row.id);
    if (after === undefined || after === null) {
      continue;
    }
    if (FLIP_RAIL_CLASSES.indexOf(after) === -1) {
      continue;
    }
    matrix[flipRailRowKey(before)][after] = matrix[flipRailRowKey(before)][after] + 1;
    if (isFlagWorthyClass(before) && after === "inland") {
      hideFlips = hideFlips + 1;
    }
    if (before === "inland" && isFlagWorthyClass(after)) {
      unhideFlips = unhideFlips + 1;
    }
  }
  const allowance = Math.max(
    CLASSIFY_MAX_HIDE_FLIPS,
    Math.ceil(flagWorthy * CLASSIFY_MAX_HIDE_FRACTION)
  );
  return {
    allowed: hideFlips <= allowance,
    hideFlips: hideFlips,
    unhideFlips: unhideFlips,
    allowance: allowance,
    flagWorthy: flagWorthy,
    matrix: matrix
  };
}

// One-line rendering of the confusion matrix, logged every run whether or not the
// rail fires: it is the standing signal that mass re-classification happened.
export function formatFlipMatrix(matrix) {
  const rowKeys = FLIP_RAIL_CLASSES.concat(["unclassified"]);
  const parts = [];
  for (let i = 0; i < rowKeys.length; i = i + 1) {
    const key = rowKeys[i];
    const row = matrix[key] || { great_lake: 0, ocean: 0, inland: 0 };
    parts.push(key + "->{great_lake=" + String(row.great_lake) +
      " ocean=" + String(row.ocean) + " inland=" + String(row.inland) + "}");
  }
  return parts.join(" ");
}

// --- Main -------------------------------------------------------------------

// A run with discovery, classify and the marine pass all switched off does nothing
// and is a caller error. Layers are an input to discovery and classification, not
// a fourth mode, so --layers does not appear here.
export function nothingToDo(args) {
  return !args.discovery && !args.classify && !args.marineZones;
}

async function readReportFile(path) {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (err) {
    log("layer report unreadable at " + path + ": " + (err && err.message ? err.message : String(err)));
    return null;
  }
}

// Exported so the three argument guards below are reachable from a test; they all
// fire before a single layer byte is read.
export async function main() {
  const runStartMs = Date.now();
  const args = parseArgs(Deno.args);
  // Discovery and classification run in one pass over one verified layer set, so
  // a beach is classified in the run that discovers it and the
  // FLAG_WORTHY_WATER_SQL fail-open window — an unclassified beach served live
  // with an estimated flag card — is zero rather than hours:
  //   discovery (--layers <dir>): local scan -> upserts + stale-row reconciliation
  //     (the only delete path) + retention + sync_meta.
  //   classify (--layers <dir>): local spatial join -> water_class UPDATEs.
  //   Either half may be switched off (--no-discovery / --no-classify), and either
  //   mode may also carry the offline marine_zone pass (--marine-zones), a pure
  //   local derivation over the snapshot that needs no layers.
  if (nothingToDo(args)) {
    throw new Error("nothing to do — pick at least one of discovery, classify, --marine-zones");
  }
  if ((args.discovery || args.classify) && args.layers === null) {
    throw new Error("--layers <dir> is required for discovery and classification " +
      "(run scripts/fetch-layers.js first); use --no-discovery --no-classify for a marine-only run");
  }
  const planProblems = layerFilePlanProblems();
  if (planProblems.missing.length > 0 || planProblems.unexpected.length > 0) {
    throw new Error("LAYER_FILES drifted from EXPECTED_LAYER_KEYS: missing=" +
      planProblems.missing.join(",") + " unexpected=" + planProblems.unexpected.join(","));
  }
  const nowIso = args.now || new Date().toISOString();
  log("start now=" + nowIso + " out=" + args.out +
    " discovery=" + String(args.discovery) + " classify=" + String(args.classify) +
    " layers=" + String(args.layers) + " marineZones=" + String(args.marineZones));

  let snapshotRows = [];
  if (args.snapshot) {
    snapshotRows = parseSnapshot(await Deno.readTextFile(args.snapshot));
    log("snapshot rows=" + String(snapshotRows.length));
  } else {
    log("no --snapshot given: reconciliation deletes and classification-queue skipping will be conservative (treats table as empty)");
  }

  // --- The manifest gate, and the three tiers it splits into ----------------
  // fatal          — the set cannot be decoded: exit 1, no SQL at all.
  // incomplete     — readable but not provably a complete view of OSM: upserts and
  //                  marine only. No deletes and no classification, because a
  //                  partial water view makes classifyWaterBody's clean-but-empty
  //                  branch decide inland, which hides beaches.
  // scope_or_stale — a complete view, but not scoped to this code's regions or not
  //                  fresh: upserts, marine and classification all run normally.
  //                  No deletes, and the absent-from-layers attempts bump is
  //                  disarmed. Coupling classification to staleness or to a
  //                  regions-digest change would turn an expansion commit into a
  //                  mass fail-open event.
  let report = null;
  let coverageComplete = false;
  let classifyAllowed = false;
  let armAbsentBump = false;
  let hasPark = false;
  if (args.discovery || args.classify) {
    const regionsDigest = "sha256:" + await sha256OfText(regionsDigestInput(REGIONS));
    report = applyRunConjuncts(await readReportFile(args.report), nowIso, regionsDigest);
    const failure = classifyManifestFailure(report);
    log("layer set buildId=" + String(report === null ? null : report.buildId) +
      " sourceTs=" + String(report === null ? null : report.oldestSourceTimestamp) +
      " sourceAgeDays=" + String(report === null ? null : report.sourceAgeDays) +
      " (horizon " + String(MAX_SOURCE_AGE_DAYS) + ")" +
      " regionsDigest=" + regionsDigest);
    log("manifest gate tier=" + failure.tier +
      (failure.reasons.length > 0 ? " reasons=" + failure.reasons.join(" | ") : ""));
    if (failure.tier === "fatal") {
      throw new Error("layer set is UNDECODABLE (" + failure.reasons.join(" | ") +
        ") — aborting, no SQL emitted; deferring to the next run");
    }
    coverageComplete = reconciliationAllowed(report);
    classifyAllowed = classificationAllowed(report);
    armAbsentBump = coverageComplete;
    hasPark = parksLayerHealthy(report);
    if (failure.tier === "incomplete") {
      log("DEGRADED (incomplete): the layer set is readable but NOT provably a complete view of " +
        "OSM — emitting upserts + marine only. NO deletes and NO water_class UPDATEs.");
    } else if (failure.tier === "scope_or_stale") {
      log("DEGRADED (scope_or_stale): the layer set is complete but out of scope or stale — " +
        "emitting upserts + marine + classification, with NO deletes and the absent-from-layers " +
        "attempts bump DISARMED.");
    }
    if (!hasPark) {
      log("WARNING: parksLayerHealthy=false — upserts emit the five-column variant and leave " +
        "park_name UNTOUCHED on existing rows. Delete candidates are exclusively park-origin " +
        "rows, so watch the reconciliation counts below; the proportional rails are what stand " +
        "between an under-populated parks layer and a park-origin delete run.");
    }
  }

  const out = [];
  out.push("-- swim.report offline discovery + water-class delta");
  out.push("-- generated: " + nowIso);
  out.push("-- mode: discovery=" + String(args.discovery) + " classify=" + String(args.classify));
  out.push("-- layer build: " + String(report === null ? null : report.buildId));
  out.push("");

  // --- Load the layer set ---------------------------------------------------
  // The signals index is built in the same streaming pass, so whether this run
  // classifies has to be known here; the gate above already decided it.
  let layerSet = null;
  let signalsIndex = null;
  if (args.discovery || args.classify) {
    const loadStartMs = Date.now();
    const loaded = await loadLayerSet(args.layers, args.classify && classifyAllowed);
    layerSet = loaded.layerSet;
    signalsIndex = loaded.signalsIndex;
    const lc = loaded.counts;
    log("layers loaded in " + String(Date.now() - loadStartMs) + "ms: beaches=" +
      String(layerSet.beaches.length) + " parksPoly=" + String(layerSet.parksPoly.length) +
      " parksName=" + String(layerSet.parksName.length) +
      " coastline_streamed=" + String(lc.coastlineStreamed) +
      " coastline_retained=" + String(lc.coastlineRetained) +
      " water_streamed=" + String(lc.waterStreamed) +
      " water_retained=" + String(lc.waterRetained) +
      " lakes_streamed=" + String(lc.lakesStreamed) +
      " otherRelations=" + String(lc.otherRelations));
    if (signalsIndex !== null) {
      log("signals index built during load: " + JSON.stringify(signalsIndexStats(signalsIndex)));
    }
  }

  // Inputs to the classification queue. With discovery off nothing is discovered
  // or deleted, so the queue is exactly the snapshot rows needing a class.
  let mergedRows = [];
  let deletedIds = new Set();

  if (args.discovery) {
    const discoveryStartMs = Date.now();
    const discovery = discoverFromLayers(layerSet);
    const counts = discovery.layerCounts;
    log("discovery scan in " + String(Date.now() - discoveryStartMs) + "ms: named=" +
      String(counts.named) + " park_beaches=" + String(counts.parkBeaches) +
      " dropped_pond=" + String(counts.droppedPond) +
      " membership_rejected=" + String(counts.membershipRejected) +
      " out_of_region=" + String(counts.outOfRegion));
    // parkBeaches is always merged, even when hasPark is false. Passing [] would
    // be wrong: producedIds is what keeps an existing park-origin row out of the
    // stale set, so dropping the park rows would turn every one of them into a
    // delete candidate in the very run that already suspects the parks layer.
    // hasPark controls only the upsert's column set, which leaves park_name
    // untouched on existing rows. The residual is that a park-origin row
    // discovered for the first time during an unhealthy-parks run is inserted with
    // park_name NULL and is not a delete candidate until a healthy run stamps it,
    // which is self-correcting and the safe direction.
    const merged = mergeBeachRows(discovery.namedRows, discovery.parkBeaches);
    mergedRows = merged.rows;
    log("discovery merged rows=" + String(merged.rows.length) +
      " skipped_unnamed=" + String(merged.skippedUnnamed) + " park_query=" + String(hasPark) +
      " coverage_complete=" + String(coverageComplete));

    const producedIds = new Set(merged.rows.map(function (r) { return r.id; }));
    const producedParkRowCount = merged.rows.filter(function (r) {
      return r.parkName !== null && r.name === r.parkName;
    }).length;

    // 1. flag_history retention sweep.
    const cutoffIso = new Date(Date.parse(nowIso) - FLAG_HISTORY_RETENTION_DAYS * 86400000).toISOString();
    out.push("-- flag_history retention (" + String(FLAG_HISTORY_RETENTION_DAYS) + " days)");
    out.push("DELETE FROM flag_history WHERE observed_at < " + sqlStr(cutoffIso) + ";");
    out.push("");

    // 2. Beach upserts. The enrichment columns are untouched by ON CONFLICT.
    out.push("-- beach upserts (" + String(merged.rows.length) + ")");
    for (const row of merged.rows) {
      out.push(upsertSql(row, hasPark));
    }
    out.push("");

    // 3. Stale park-beach reconciliation, the only delete path, gated on a
    //    manifest that proves the layer set is a complete, intact, in-scope, fresh
    //    view of OSM (reconciliationAllowed) plus a snapshot to diff against.
    //    Anything less and this branch never runs: the delta is upserts only.
    //    deletedIds comes from the same rows that produce the DELETEs, so the
    //    classify-universe exclusion set is exactly the set actually deleted,
    //    never a superset that could drop a still-present row from classification.
    //
    // hasPark is part of this condition on purpose; see reconciliationGate for the
    // 0.96x band the proportional rails cannot see. An intended consequence is
    // that a bootstrap build, whose empty history makes hasPark false, performs no
    // deletes on its first run.
    const gate = reconciliationGate(coverageComplete, hasPark, Boolean(args.snapshot));
    if (gate.allowed) {
      const delta = reconciliationDelta(snapshotRows, producedIds, producedParkRowCount);
      if (delta.statements.length > 0) {
        out.push("-- stale park-beach reconciliation (" + String(delta.statements.length) + ")");
        for (const stmt of delta.statements) { out.push(stmt); }
        out.push("");
      }
      deletedIds = new Set(delta.rows.map(function (r) { return r.id; }));
    } else {
      log("reconciliation SKIPPED: " + gate.reason +
        " — emitting upserts only, no deletes; reconciliation retries next run");
    }

    // 4. sync_meta bookkeeping. last_discovery_count is this run's produced-row
    //    count; a degraded run undercounts, which is why the companion completeness
    //    marker exists so a small count is never read as a shrink. The two layer
    //    rows make the exact input set answerable from D1 alone. The one-time
    //    DELETE clears three superseded rows and is a no-op on every later run.
    out.push("-- sync_meta");
    out.push("DELETE FROM sync_meta WHERE key IN ('last_overpass_sync', 'last_overpass_count', 'last_overpass_complete');");
    out.push(syncMetaSql("last_discovery_sync", nowIso, nowIso));
    out.push(syncMetaSql("last_discovery_count", String(merged.rows.length), nowIso));
    out.push(syncMetaSql("last_discovery_complete", coverageComplete ? "true" : "false", nowIso));
    out.push(syncMetaSql("last_layer_build_id", report === null ? null : report.buildId, nowIso));
    out.push(syncMetaSql("last_layer_source_ts", report === null ? null : report.oldestSourceTimestamp, nowIso));
    out.push("");
  } else {
    log("discovery skipped (--no-discovery): no upserts, no reconciliation, no deletes");
  }

  // 4b. Offline marine_zone derivation (see marineZoneSql). Pure local math over
  // the committed geometry: no layers, no network, and no effect on
  // reconciliationAllowed or the delete path, since it only appends change-only
  // UPDATEs.
  //
  // Isolated from the delete-bearing discovery output. Everything that can throw —
  // a missing or malformed data/marine-zones.json, and
  // buildMarineZoneIndex, which throws by design on malformed geometry — is
  // computed into a local buffer inside try/catch and appended to out[] only once
  // the whole pass succeeded. A broken marine data file therefore degrades to a
  // logged "no marine changes" while the discovery delta still writes. A bonus
  // signal must never abort the project's only delete path.
  if (args.marineZones) {
    if (!args.snapshot) {
      log("marine zone pass skipped: marine pass needs --snapshot");
    } else {
      try {
        const zonesData = JSON.parse(await Deno.readTextFile(args.marineZones));
        const index = buildMarineZoneIndex(zonesData);
        const marine = marineZoneSql(snapshotRows, deletedIds, index);
        const marineOut = [];
        marineOut.push("-- marine zone derivation (" + String(marine.updates) + ")");
        for (const stmt of marine.statements) {
          marineOut.push(stmt);
        }
        marineOut.push(syncMetaSql("last_marine_zone_pass", nowIso, nowIso));
        marineOut.push(syncMetaSql("last_marine_zone_count", String(marine.updates), nowIso));
        marineOut.push("");
        for (const line of marineOut) {
          out.push(line);
        }
        log("marine zones: considered=" + String(marine.considered) + " updates=" + String(marine.updates));
      } catch (err) {
        log("marine zone pass FAILED (skipped, no marine UPDATEs emitted; " +
          "discovery/classify output unaffected): " +
          (err && err.message ? err.message : String(err)));
      }
    }
  }

  // 5. Water-body classification: a local spatial join against the same layer set
  // discovery just read, in the same run, so a beach discovered above is
  // classified below and never reaches the site unclassified.
  if (args.classify && classifyAllowed) {
    const queue = buildClassifyQueue(snapshotRows, mergedRows, deletedIds);
    log("classification queue=" + String(queue.length) + " absent_bump_armed=" + String(armAbsentBump));
    const classifyStartMs = Date.now();
    const result = await classifyQueue(queue, {
      fetchSignals: function (beach) { return waterClassSignals(signalsIndex, beach); },
      isKnownAbsent: function (beach) {
        return armAbsentBump && beachAbsentFromLayers(signalsIndex, beach);
      }
    });
    const classifyMs = Date.now() - classifyStartMs;
    const c = result.counts;
    log("classification done in " + String(classifyMs) + "ms attempted=" + String(c.attempted) +
      " classified=" + String(c.classified) +
      " ocean=" + String(c.ocean) + " great_lake=" + String(c.great_lake) + " inland=" + String(c.inland) +
      " (no_water=" + String(c.inland_no_water) + ")" +
      " bumped=" + String(c.bumped) + " (absent_from_layers=" + String(c.absent_from_layers) + ")" +
      " transient=" + String(c.transient));
    log("stopped_on_budget=" + String(result.stopped) + " processed=" + String(result.processed));
    // The classification flip rail, logged every run whether or not it fires: a
    // hide is invisible in the row count, so the confusion matrix is the only
    // standing signal that mass re-classification happened.
    const rail = classificationFlipRailAllows(snapshotRows, result.verdicts);
    log("classification flips hide=" + String(rail.hideFlips) + "/" + String(rail.allowance) +
      " unhide=" + String(rail.unhideFlips) + " snapshot_flag_worthy=" + String(rail.flagWorthy) +
      " matrix " + formatFlipMatrix(rail.matrix));
    if (rail.unhideFlips > 0) {
      log("NOTE: " + String(rail.unhideFlips) + " inland -> flag-worthy flip(s) — this UN-hides " +
        "beaches and is allowed unconditionally; only hides are railed.");
    }
    if (rail.allowed) {
      out.push("-- water-class updates (" + String(result.statements.length) + ")");
      for (const stmt of result.statements) {
        out.push(stmt);
      }
      out.push("");
    } else {
      log("classification REFUSING the whole water_class block: " + String(rail.hideFlips) +
        " flag-worthy -> inland flips exceed the allowance of " + String(rail.allowance) +
        " (snapshot flag-worthy " + String(rail.flagWorthy) + ") — emitting NO water_class " +
        "UPDATEs of any kind this run");
    }
    // Whole-table visibility as of the snapshot, since this run's UPDATEs are not
    // applied to D1 yet, so pending_visible is the exposure the run started with.
    const cov = classifyCoverageCounts(snapshotRows, deletedIds);
    log("classification coverage parked=" + String(cov.parked) +
      " hidden_inland=" + String(cov.hidden_inland) +
      " pending_visible=" + String(cov.pending_visible) +
      " flag_worthy=" + String(cov.flag_worthy) + " (pre-apply snapshot)");
  } else if (args.classify) {
    log("classification SKIPPED: the layer set is not provably a COMPLETE view of OSM, and a " +
      "partial water view makes the classifier decide inland, which hides beaches");
  } else {
    log("classification skipped (--no-classify)");
  }

  // The whole delta is written atomically, once, at the end, so the run has a
  // binary outcome: exit 0 with a complete file, or exit 1 with no file. The
  // workflow's Apply step therefore needs no torn-tail truncation and no always()
  // belt.
  await Deno.writeTextFile(args.out, out.join("\n") + "\n");
  log("wrote " + args.out + " (" + String(out.length) + " lines) in " +
    String(Date.now() - runStartMs) + "ms total");
}

// Only runs as an entrypoint. Importing this module, as vitest does to test the
// pure SQL, queue and rail builders above, triggers no discovery.
if (import.meta.main) {
  main().catch(function (err) {
    console.error("discovery-batch: FATAL: " + (err && err.stack ? err.stack : err));
    Deno.exit(1);
  });
}
