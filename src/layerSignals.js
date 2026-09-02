// src/layerSignals.js — the water-class SIGNAL PROVIDER for the FlatGeobuf
// layer pipeline. Replaces fetchWaterClassSignals in src/clients/overpass.js at
// the same seam (scripts/discovery-batch.js passes it as classifyQueue's
// opts.fetchSignals), with the same signature and the same null contract.
//
// Pure: no fetch, no Date, no filesystem. Imports src/osmSelect.js (the probe
// radii, the vertex anchor and the area threshold) and src/layerGrid.js (the
// spatial index). Loads verbatim under Deno, workerd and vitest.
//
// WHAT THIS MODULE MUST NOT CHANGE
// --------------------------------
// The object it returns is consumed by classifyWaterBody in src/waterClass.js,
// which is UNCHANGED by this migration. Every key, type and threshold below is a
// transcription of parseWaterClassElements plus the radius its Overpass "around"
// clause carried, because any divergence silently RE-CLASSIFIES live beaches —
// and a re-classification in the flag-worthy -> inland direction HIDES a beach
// that is being served today. The Overpass query this replaces was:
//
//   way["natural"="coastline"](around.a:150);                    -> coastlinePresent
//   relation["natural"="water"]["water"="lake"](around.a:150);    -> nearbyLakeQids
//   way["natural"="water"](around.a:120);                         -> nearbyWayWater
//
// where set .a was the beach element RECURSED DOWN to its member nodes. The
// layer pipeline reproduces .a with probeVertices (src/osmSelect.js) and the
// three "around" clauses with three SEGMENT GRIDS, which answer exactly the
// threshold question "is any part of this feature within R metres of any probe
// vertex" — the same question, evaluated locally instead of on a public mirror.
//
// WHY SEGMENT GRIDS AND NOT ENVELOPE GRIDS
// ----------------------------------------
// An envelope grid prunes nothing for the six Great Lake polygons: their
// bounding boxes contain essentially every Great Lakes beach, so every probe
// would return all six and then fall through to a linear scan of millions of
// ring segments. Mode B of src/layerGrid.js indexes the SEGMENTS themselves and
// keeps only { osmType, osmId, tags, bounds } per feature afterwards, which is
// what lets a ~3e6-vertex lakes layer be indexed in typed arrays instead of
// multiple gigabytes of GeoJSON heap.
//
// THE NULL CONTRACT IS THE WHOLE ATTEMPTS SEMANTICS (see beachAbsentFromLayers)
// ----------------------------------------------------------------------------
// null means TRANSIENT: the caller must NOT bump water_class_attempts and the
// row stays queued. A signals object — INCLUDING the all-empty one — is a CLEAN,
// complete answer that classifyWaterBody DECIDES on (all-empty decides inland).
// Under Overpass that distinction separated a mirror flake from a real negative;
// here it separates a data bug from a real negative, and the second failure mode
// Overpass never had (the beach's OSM element is simply not in the layer set) is
// disambiguated by the separate beachAbsentFromLayers predicate below rather
// than folded into the null.

import {
  sortLayerFeatures,
  probeVertices,
  bboxAreaDeg2,
  WATER_MIN_AREA_DEG2,
  OCEAN_RADIUS_M,
  GREAT_LAKE_RADIUS_M,
  INLAND_RADIUS_M
} from "./osmSelect.js";
import {
  buildSegmentGrid,
  addFeatureSegments,
  finishSegmentGrid,
  segmentGridStats,
  anySegmentWithinKmOfPoint,
  featuresWithinKmOfVertices
} from "./layerGrid.js";

// The three validated probe radii, in the kilometres the grid queries take. The
// metre constants stay the single source of truth in src/osmSelect.js — these
// are a unit conversion and nothing else. The radii DID NOT CHANGE in this
// migration, and that is the entire safety argument for it: the geometry source
// moved, the thresholds did not.
const COASTLINE_MAX_KM = OCEAN_RADIUS_M / 1000;
const LAKE_MAX_KM = GREAT_LAKE_RADIUS_M / 1000;
const WATER_MAX_KM = INLAND_RADIUS_M / 1000;

// The stored osm_id form ("way/N" | "relation/N" | "node/N"), relocated here
// from buildWaterClassAnchor in src/clients/overpass.js. It stays ANCHORED and
// digits-only: a loose match would turn a corrupt id into a lookup miss, which
// this module reports as ABSENT (and, under a verified layer set, bumps
// attempts for) rather than as the transient data bug it actually is.
const OSM_ID_PATTERN = /^(way|relation|node)\/(\d+)$/;

// The index key, identical in construction to dedupByOsm's key in
// scripts/discovery-batch.js and to the stored osm_id column, so a D1 row's
// osm_id IS the key with no re-derivation: "way/123".
function featureKey(osmType, osmId) {
  return String(osmType) + "/" + String(osmId);
}

// Returns the canonical index key for a beach row's stored osm_id, or null when
// the id cannot be parsed at all.
function beachKey(beach) {
  if (beach === null || typeof beach !== "object") {
    return null;
  }
  const osmId = beach.osm_id;
  if (typeof osmId !== "string") {
    return null;
  }
  if (OSM_ID_PATTERN.test(osmId) !== true) {
    return null;
  }
  return osmId;
}

// A probe layer's per-feature sidecar: everything an answer needs and nothing
// the segment grid already holds. The GEOMETRY IS DELIBERATELY NOT RETAINED —
// see the module header. bounds is kept because nearbyWayWater's area test is a
// raw degree product over the envelope, exactly as parseWaterClassElements
// computed it from Overpass's "out ... bb".
function sidecarFor(feature) {
  return {
    osmType: feature.osmType,
    osmId: feature.osmId,
    tags: (feature.tags !== null && typeof feature.tags === "object") ? feature.tags : {},
    bounds: (feature.bounds !== null && typeof feature.bounds === "object") ? feature.bounds : null
  };
}

// Canonical answer order, as ranks over the sidecar array.
//
// featuresWithinKmOfVertices returns owning feature indices in ASCENDING INDEX
// order, i.e. in the order the features were fed to the builder. That is
// deterministic for a given feed but it is not the pipeline's canonical order,
// and nearbyLakeQids is an ORDER-SENSITIVE answer (classifyWaterBody scans it
// front to back, and the run-to-run diff of 9.3 compares the arrays). So the
// order is normalised HERE, after indexing, rather than by pre-sorting the input
// arrays: that is what lets the index be fed from readFgbStream one feature at a
// time without ever materialising a whole layer.
//
// The comparator is not re-implemented — sortLayerFeatures is called on a shim
// array carrying just { osmType, osmId, index }, so node-then-way-then-relation,
// id ascending, stable, can never drift from the discovery path's ordering.
function canonicalRanks(sidecars) {
  const shims = [];
  for (let i = 0; i < sidecars.length; i = i + 1) {
    shims.push({ osmType: sidecars[i].osmType, osmId: sidecars[i].osmId, index: i });
  }
  const sorted = sortLayerFeatures(shims);
  const ranks = new Int32Array(sidecars.length);
  for (let p = 0; p < sorted.length; p = p + 1) {
    ranks[sorted[p].index] = p;
  }
  return ranks;
}

// Reorder a hit list (feed-order feature indices) into canonical order.
function orderedHits(layer, hits) {
  const ranks = layer.ranks;
  const out = hits.slice();
  out.sort(function (a, b) {
    return ranks[a] - ranks[b];
  });
  return out;
}

function emptyProbeLayer() {
  return { builder: buildSegmentGrid(), sidecars: [] };
}

// --- the index ----------------------------------------------------------------

// Start an empty index. The three-call builder (begin / add / finish) exists so
// the caller can feed the index STRAIGHT OFF readFgbStream: scripts/lib/fgbReader.js
// yields one LayerFeature at a time and the whole point of mode B is that no
// layer is ever held in memory as GeoJSON. buildSignalsIndex below is the
// array-shaped convenience wrapper over the same three calls.
export function beginSignalsIndex() {
  return {
    beaches: new Map(),
    coastline: emptyProbeLayer(),
    water: emptyProbeLayer(),
    lakes: emptyProbeLayer(),
    // Diagnostic only: features handed in that carried nothing indexable.
    skipped: 0
  };
}

// Add one LayerFeature to the index under its LOGICAL layer name — one of
// "beaches", "coastline", "water", "lakes". Returns true when the feature was
// indexed, false when it was skipped.
//
// A skip is a per-feature data problem and is never thrown on, for the same
// reason toLayerFeature returns null rather than throwing: layer bytes are
// upstream input, and one unbuildable geometry must not take down a run. An
// ARTIFACT problem (a truncated file) is caught by the reader, upstream of here.
//
// beaches are keyed FIRST-SEEN-WINS, matching dedupByOsm in
// scripts/discovery-batch.js: the same (type, id) legitimately arrives from more
// than one published file (a beach relation appears in both beaches-polygon.fgb
// and other-relations.fgb), and the copies are equivalent for a distance probe.
export function addSignalsFeature(index, layerName, feature) {
  if (index === null || typeof index !== "object") {
    return false;
  }
  if (feature === null || typeof feature !== "object") {
    index.skipped = index.skipped + 1;
    return false;
  }
  if (feature.osmType === undefined || feature.osmId === undefined) {
    index.skipped = index.skipped + 1;
    return false;
  }
  if (layerName === "beaches") {
    const key = featureKey(feature.osmType, feature.osmId);
    if (!index.beaches.has(key)) {
      index.beaches.set(key, feature);
    }
    return true;
  }
  const layer = index[layerName];
  if (layer === undefined || layer === null || layer.builder === undefined) {
    index.skipped = index.skipped + 1;
    return false;
  }
  const featureIndex = layer.sidecars.length;
  layer.sidecars.push(sidecarFor(feature));
  addFeatureSegments(layer.builder, featureIndex, feature.geometry);
  return true;
}

// Freeze a builder into a query-ready index. The mutable builders are replaced
// by finished segment grids (which copy their typed arrays down to exact length)
// and each probe layer gains its canonical rank table.
export function finishSignalsIndex(builder) {
  const source = (builder !== null && typeof builder === "object")
    ? builder
    : beginSignalsIndex();
  const finishLayer = function (layer) {
    return {
      grid: finishSegmentGrid(layer.builder),
      sidecars: layer.sidecars,
      ranks: canonicalRanks(layer.sidecars)
    };
  };
  return {
    beaches: source.beaches,
    coastline: finishLayer(source.coastline),
    water: finishLayer(source.water),
    lakes: finishLayer(source.lakes),
    skipped: source.skipped
  };
}

// Build the whole index in one call from in-memory layer arrays. Each value may
// be an array or any sync iterable; a missing layer is an empty one.
//
//   layers = {
//     beaches:   Array<LayerFeature>,  // beaches-{point,line,polygon}.fgb + the
//                                      // beach half of other-relations.fgb
//     coastline: Array<LayerFeature>,  // coastline-line.fgb
//     water:     Array<LayerFeature>,  // water-line.fgb + water-polygon.fgb
//     lakes:     Array<LayerFeature>   // lakes-polygon.fgb
//   }
//
// water and lakes stay SEPARATE inputs and are never merged: the two probes ask
// different questions at different radii (a lake RELATION donates a QID at
// 150 m; an inland water WAY sets the pond-guarded nearbyWayWater at 120 m), and
// merging them would let a Great Lake polygon answer the inland probe.
export function buildSignalsIndex(layers) {
  const index = beginSignalsIndex();
  if (layers === null || typeof layers !== "object") {
    return finishSignalsIndex(index);
  }
  const names = ["beaches", "coastline", "water", "lakes"];
  for (let i = 0; i < names.length; i = i + 1) {
    const name = names[i];
    const input = layers[name];
    if (input === undefined || input === null) {
      continue;
    }
    for (const feature of input) {
      addSignalsFeature(index, name, feature);
    }
  }
  return finishSignalsIndex(index);
}

// Diagnostic snapshot for the batch's run log and for the 9.7 benchmark gate,
// which records the per-layer segment counts. Never consulted by any gate.
export function signalsIndexStats(index) {
  if (index === null || typeof index !== "object") {
    return { beaches: 0, coastline: null, water: null, lakes: null, skipped: 0 };
  }
  return {
    beaches: index.beaches ? index.beaches.size : 0,
    coastline: segmentGridStats(index.coastline ? index.coastline.grid : null),
    water: segmentGridStats(index.water ? index.water.grid : null),
    lakes: segmentGridStats(index.lakes ? index.lakes.grid : null),
    skipped: index.skipped === undefined ? 0 : index.skipped
  };
}

// A finished index carries the three probe layers with their grids and rank
// tables. A builder that never reached finishSignalsIndex does not, and querying
// one would either throw or quietly answer "nothing in range".
function isQueryableIndex(index) {
  if (index === null || typeof index !== "object" || !index.beaches) {
    return false;
  }
  const names = ["coastline", "water", "lakes"];
  for (let i = 0; i < names.length; i = i + 1) {
    const layer = index[names[i]];
    if (layer === null || typeof layer !== "object" ||
      layer.grid === undefined || layer.ranks === undefined ||
      !Array.isArray(layer.sidecars)) {
      return false;
    }
  }
  return true;
}

// --- the two exported predicates ----------------------------------------------

// TRUE iff this beach's osm_id PARSES and no beaches feature is indexed under
// it. Injected into classifyQueue as opts.isKnownAbsent, alongside
// opts.fetchSignals below.
//
// WHY THIS IS A SEPARATE PREDICATE AND NOT ANOTHER NULL (D21/M4).
// fetchWaterClassSignals never had this failure mode: Overpass answered for any
// osm_id, so "absent" did not exist. Under prebuilt layers it does, and folding
// it into the transient null would create a permanently-undecidable row class —
// a D1 row whose OSM element is missing from the set would re-queue forever with
// water_class_attempts stuck at 0, and FLAG_WORTHY_WATER_SQL's deliberate
// fail-open for NULL-under-the-cap would keep serving it live with an estimated
// flag card. That is the Locklin Pines exposure made unbounded.
//
// The decision of what to DO about it belongs to the caller and is gated on
// reconciliationAllowed(report) (src/layerManifest.js):
//   - verified set  -> the set is by definition a complete view of OSM, so
//                      absent means GONE FROM OSM: bump attempts, count
//                      absent_from_layers, park the row after the cap.
//   - unverified set -> the bump is DISARMED and the row stays transient.
//                      Critically this covers a regionsDigest mismatch, which is
//                      exactly what an NA-expansion commit produces: without the
//                      gate the first run after it would park and hide every
//                      beach on the newly added coast.
//
// FAIL-SAFE DIRECTION. Every unproven input answers FALSE (not absent), because
// false costs one more queued round and true costs an attempts bump toward
// hiding a live row. An UNPARSEABLE id answers false too: that is a data bug in
// the row, not evidence about layer coverage, and waterClassSignals already
// keeps it transient forever.
export function beachAbsentFromLayers(index, beach) {
  if (index === null || typeof index !== "object" || !index.beaches) {
    return false;
  }
  const key = beachKey(beach);
  if (key === null) {
    return false;
  }
  return !index.beaches.has(key);
}

// THE SEAM. Signature and null contract match fetchWaterClassSignals exactly, so
// classifyQueue's body does not change: it is handed a beach row carrying the D1
// column names and gets back the signals object classifyWaterBody consumes, or
// null.
//
// Returns EXACTLY the three keys and no more:
//   { coastlinePresent: boolean, nearbyLakeQids: string[], nearbyWayWater: boolean }
//
// null in exactly two cases, both TRANSIENT for the caller (no SQL, no attempts
// bump), and distinguishable through beachAbsentFromLayers above:
//   1. the osm_id does not parse — a data bug in the row;
//   2. no beaches feature is indexed under it — a coverage question.
export function waterClassSignals(index, beach) {
  // A malformed or half-built index answers TRANSIENT rather than throwing or
  // fabricating an all-empty (and therefore DECIDING) answer: an index this
  // module cannot read is not evidence that a beach has no water near it.
  if (!isQueryableIndex(index)) {
    return null;
  }
  const key = beachKey(beach);
  if (key === null) {
    console.log("layerSignals: water class skipped, unparseable osm_id " +
      String(beach && beach.osm_id));
    return null;
  }
  const feature = index.beaches.get(key);
  if (feature === undefined) {
    // No log line here on purpose: a broken layer build makes this fire for
    // every row in the queue, and the caller already reports it as one
    // absent_from_layers= counter, which is the form an operator can act on.
    return null;
  }

  // The probe anchor. Every distance below is measured from the beach element's
  // member VERTICES and from nothing else — never its centroid and never its
  // bbox — because a set-back beach's centroid sits tens of metres further out
  // than its nearest vertex, and a large multipolygon like Sleeping Bear has a
  // centroid well inland of the 150 m coastline band while its sand is right on
  // it. That is the difference between great_lake and inland for the whole dune
  // complex, and it is why probeVertices reproduces Overpass's "way(N);>->.a;".
  const vertices = probeVertices(feature);

  const signals = {
    coastlinePresent: false,
    nearbyLakeQids: [],
    nearbyWayWater: false
  };

  // 1. coastlinePresent — any coastline segment within OCEAN_RADIUS_M of any
  // probe vertex. No area test (parity: the Overpass clause had none), and the
  // per-vertex loop early-exits on the first hit.
  //
  // No natural=coastline tag test either, and that omission is deliberate rather
  // than an oversight: coastline-line.fgb is cut with -where natural='coastline',
  // so the test is vacuous on a well-formed set — while on a MALFORMED one (GDAL
  // dropping the "natural" field from the inferred schema, the B3 failure) a
  // defensive test here would silently flip every ocean beach to a non-coastline
  // answer, i.e. would HIDE them. Missing-field detection belongs in
  // build-manifest.js, which hard-refuses the whole set, not in a per-beach probe
  // that can only fail in the hiding direction.
  for (let i = 0; i < vertices.length; i = i + 1) {
    const vertex = vertices[i];
    if (anySegmentWithinKmOfPoint(index.coastline.grid, vertex.lat, vertex.lon, COASTLINE_MAX_KM)) {
      signals.coastlinePresent = true;
      break;
    }
  }

  // 2. nearbyLakeQids — the wikidata QID of every water=lake RELATION within
  // GREAT_LAKE_RADIUS_M of any probe vertex, pushed VERBATIM.
  //
  // The three tag conditions and the relation-only type test are transcribed
  // from parseWaterClassElements, which mirrored
  // relation["natural"="water"]["water"="lake"]. They matter here in a way the
  // coastline test does not: an untagged or way-mapped feature contributing a
  // QID would classify a beach great_lake on the strength of the wrong geometry,
  // and dropping the natural/water tags from the layer would empty this array
  // for every served beach — which is why 1.4 carries natural on lakes-polygon.fgb
  // and build-manifest.js asserts it.
  //
  // NO DEDUPE and NO NORMALISATION, both for Overpass parity: the same QID may
  // legitimately appear twice (a lake published as two relations), and
  // isGreatLakeQid is an exact, case-sensitive hasOwnProperty lookup, so a value
  // of " Q1066" or "Q1066;Q123" must be allowed to fail to match here exactly as
  // it failed to match before. Order is canonical (see canonicalRanks) so the
  // array is byte-stable run to run.
  const lakeHits = orderedHits(index.lakes, featuresWithinKmOfVertices(index.lakes.grid, vertices, LAKE_MAX_KM));
  for (let i = 0; i < lakeHits.length; i = i + 1) {
    const lake = index.lakes.sidecars[lakeHits[i]];
    if (lake === undefined || lake.osmType !== "relation") {
      continue;
    }
    const tags = lake.tags;
    if (tags.natural !== "water" || tags.water !== "lake") {
      continue;
    }
    if (typeof tags.wikidata === "string" && tags.wikidata !== "") {
      signals.nearbyLakeQids.push(tags.wikidata);
    }
  }

  // 3. nearbyWayWater — a real inland water WAY within INLAND_RADIUS_M. The
  // radius is tighter than the other two on purpose: this probe answers "does
  // this beach have its OWN adjacent water body", not "is there water nearby".
  //
  // WAYS ONLY, matching way["natural"="water"](around.a:120): a relation-mapped
  // water body never sets this flag, and never did.
  //
  // The area gate is the pond threshold, >= WATER_MIN_AREA_DEG2 on the raw degree
  // product of the envelope — the same >= parseWaterClassElements applied to
  // Overpass's "bb", and deliberately not the strict < used in the pond skip.
  //
  // The tags.natural === "water" test IS kept here, unlike the coastline probe,
  // and it is free: nearbyWayWater true and nearbyWayWater false BOTH resolve to
  // "inland" in classifyWaterBody (it is the last positive branch before the
  // clean-but-empty default), so this test cannot move a verdict in either
  // direction. What it does preserve is the run log's inland_no_water counter,
  // the one diagnostic that separates a data-coverage failure from a genuinely
  // set-back beach — which is why classifyQueue reads this signal directly rather
  // than only the verdict.
  const waterHits = featuresWithinKmOfVertices(index.water.grid, vertices, WATER_MAX_KM);
  for (let i = 0; i < waterHits.length; i = i + 1) {
    const water = index.water.sidecars[waterHits[i]];
    if (water === undefined || water.osmType !== "way") {
      continue;
    }
    if (water.tags.natural !== "water") {
      continue;
    }
    if (water.bounds === null) {
      continue;
    }
    if (bboxAreaDeg2(water.bounds) >= WATER_MIN_AREA_DEG2) {
      signals.nearbyWayWater = true;
      break;
    }
  }

  return signals;
}
