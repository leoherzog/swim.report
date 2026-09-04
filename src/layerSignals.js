// src/layerSignals.js — the water-class signal provider for the FlatGeobuf
// layer pipeline. scripts/discovery-batch.js passes it as classifyQueue's
// opts.fetchSignals. Pure: no fetch, no Date, no filesystem; it imports the
// probe radii and vertex anchor from src/osmSelect.js and the spatial index from
// src/layerGrid.js, and loads verbatim under Deno, workerd and vitest.
//
// The object it returns is consumed by classifyWaterBody in src/waterClass.js.
// Every key, type and threshold below must stay fixed, because a divergence
// silently re-classifies live beaches, and a flag-worthy -> inland flip hides a
// beach that is being served today.
//
// Segment grids, not envelope grids: the six Great Lake bounding boxes contain
// essentially every Great Lakes beach, so an envelope index prunes nothing and
// every probe falls through to a linear scan of millions of ring segments. Mode
// B of src/layerGrid.js indexes the segments themselves and keeps only
// { osmType, osmId, tags, bounds } per feature, which is what lets a ~3e6-vertex
// lakes layer live in typed arrays instead of gigabytes of GeoJSON heap.
//
// The null contract carries the whole attempts semantics. null means transient:
// the caller must not bump water_class_attempts and the row stays queued. A
// signals object, including the all-empty one, is a clean complete answer that
// classifyWaterBody decides on (all-empty decides inland). The separate case of
// a beach whose OSM element is not in the layer set is answered by
// beachAbsentFromLayers below, never folded into the null.

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

// The three probe radii in the kilometres the grid queries take. The metre
// constants in src/osmSelect.js stay the single source of truth; these are a
// unit conversion and nothing else.
const COASTLINE_MAX_KM = OCEAN_RADIUS_M / 1000;
const LAKE_MAX_KM = GREAT_LAKE_RADIUS_M / 1000;
const WATER_MAX_KM = INLAND_RADIUS_M / 1000;

// The stored osm_id form ("way/N" | "relation/N" | "node/N"). Anchored and
// digits-only: a loose match would turn a corrupt id into a lookup miss, which
// this module reports as absent (and, under a verified layer set, bumps attempts
// for) rather than as the transient data bug it is.
const OSM_ID_PATTERN = /^(way|relation|node)\/(\d+)$/;

// Identical in construction to dedupByOsm's key in scripts/discovery-batch.js
// and to the stored osm_id column, so a D1 row's osm_id is the key with no
// re-derivation: "way/123".
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
// the segment grid already holds. Geometry is deliberately not retained. bounds
// is kept because nearbyWayWater's area test is a raw degree product over the
// envelope.
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
// featuresWithinKmOfVertices returns hits in feed order, but nearbyLakeQids is
// order-sensitive (classifyWaterBody scans it front to back). Normalising here,
// after indexing, rather than by pre-sorting the inputs is what lets the index be
// fed from readFgbStream one feature at a time without materialising a layer.
// sortLayerFeatures is called on a shim array of { osmType, osmId, index } so the
// comparator cannot drift from the discovery path's ordering.
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
// the caller can feed the index straight off readFgbStream one LayerFeature at a
// time, never holding a layer in memory as GeoJSON. buildSignalsIndex below is
// the array-shaped wrapper over the same three calls.
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

// Add one LayerFeature to the index under its logical layer name — one of
// "beaches", "coastline", "water", "lakes". Returns true when indexed, false
// when skipped.
//
// A skip is a per-feature data problem and is never thrown on: layer bytes are
// upstream input and one unbuildable geometry must not take down a run. A
// truncated file is an artifact problem, caught by the reader upstream of here.
//
// beaches are keyed first-seen-wins, matching dedupByOsm in
// scripts/discovery-batch.js: the same (type, id) legitimately arrives from more
// than one published file, and the copies are equivalent for a distance probe.
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

// Freeze a builder into a query-ready index: finished segment grids, with their
// typed arrays copied down to exact length, plus a canonical rank table per
// probe layer.
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
// water and lakes stay separate inputs and are never merged: the two probes ask
// different questions at different radii (a lake relation donates a QID at 150 m;
// an inland water way sets the pond-guarded nearbyWayWater at 120 m), and merging
// them would let a Great Lake polygon answer the inland probe.
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

// Diagnostic snapshot of per-layer segment counts for the batch's run log.
// Never consulted by any gate.
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

// A builder that never reached finishSignalsIndex lacks the grids and rank
// tables, and querying one would either throw or quietly answer "nothing in
// range".
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

// True iff this beach's osm_id parses and no beaches feature is indexed under
// it. Injected into classifyQueue as opts.isKnownAbsent, alongside
// opts.fetchSignals below.
//
// This is a separate predicate rather than another null because folding it into
// the transient null creates a permanently-undecidable row class: a D1 row whose
// OSM element is missing from the set would re-queue forever with
// water_class_attempts stuck at 0, and FLAG_WORTHY_WATER_SQL's deliberate
// fail-open for NULL-under-the-cap would keep serving it live with an estimated
// flag card — the Locklin Pines exposure made unbounded.
//
// What to do about it belongs to the caller and is gated on
// reconciliationAllowed(report) (src/layerManifest.js):
//   - verified set   -> the set is a complete view of OSM, so absent means gone
//                       from OSM: bump attempts, count absent_from_layers, park
//                       the row after the cap.
//   - unverified set -> the bump is disarmed and the row stays transient. This
//                       covers a regionsDigest mismatch, which is what a
//                       region-expansion commit produces: without the gate the
//                       first run after it parks and hides every beach on the
//                       newly added coast.
//
// Fail-safe direction: every unproven input answers false (not absent), because
// false costs one more queued round and true costs an attempts bump toward
// hiding a live row. An unparseable id answers false too — that is a data bug in
// the row, not evidence about layer coverage.
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

// classifyQueue's seam: takes a beach row carrying the D1 column names, returns
// exactly the three keys classifyWaterBody consumes and no more —
//   { coastlinePresent: boolean, nearbyLakeQids: string[], nearbyWayWater: boolean }
//
// null in exactly two cases, both transient for the caller (no SQL, no attempts
// bump) and distinguishable through beachAbsentFromLayers above:
//   1. the osm_id does not parse — a data bug in the row;
//   2. no beaches feature is indexed under it — a coverage question.
export function waterClassSignals(index, beach) {
  // A malformed or half-built index answers transient rather than throwing or
  // fabricating an all-empty (and therefore deciding) answer: an index this
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
  // member vertices and from nothing else — never its centroid, never its bbox.
  // A set-back beach's centroid sits tens of metres further out than its nearest
  // vertex, and a large multipolygon like Sleeping Bear has a centroid well
  // inland of the 150 m coastline band while its sand is right on it: that is
  // the difference between great_lake and inland for the whole dune complex.
  const vertices = probeVertices(feature);

  const signals = {
    coastlinePresent: false,
    nearbyLakeQids: [],
    nearbyWayWater: false
  };

  // 1. coastlinePresent — any coastline segment within OCEAN_RADIUS_M of any
  // probe vertex. No area test, and the per-vertex loop early-exits on the first
  // hit.
  //
  // No natural=coastline tag test either, deliberately: coastline-line.fgb is
  // cut with -where natural='coastline', so the test is vacuous on a well-formed
  // set, while on a set where GDAL dropped the "natural" field from the inferred
  // schema a defensive test here would silently flip every ocean beach to a
  // non-coastline answer and hide it. Missing-field detection belongs in
  // build-manifest.js, which hard-refuses the whole set, not in a per-beach probe
  // that can only fail in the hiding direction.
  for (let i = 0; i < vertices.length; i = i + 1) {
    const vertex = vertices[i];
    if (anySegmentWithinKmOfPoint(index.coastline.grid, vertex.lat, vertex.lon, COASTLINE_MAX_KM)) {
      signals.coastlinePresent = true;
      break;
    }
  }

  // 2. nearbyLakeQids — the wikidata QID of every water=lake relation within
  // GREAT_LAKE_RADIUS_M of any probe vertex, pushed verbatim.
  //
  // The three tag conditions and the relation-only type test matter here in a
  // way the coastline test does not: an untagged or way-mapped feature
  // contributing a QID would classify a beach great_lake on the strength of the
  // wrong geometry, and dropping the natural/water tags from the layer would
  // empty this array for every served beach. That is why lakes-polygon.fgb
  // carries natural and build-manifest.js asserts it.
  //
  // No dedupe and no normalisation. The same QID may legitimately appear twice
  // (a lake published as two relations), and isGreatLakeQid is an exact,
  // case-sensitive hasOwnProperty lookup, so a value of " Q1066" or "Q1066;Q123"
  // must be allowed to fail to match. Order is canonical (see canonicalRanks) so
  // the array is byte-stable run to run.
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

  // 3. nearbyWayWater — a real inland water way within INLAND_RADIUS_M. The
  // radius is tighter than the other two on purpose: this probe answers "does
  // this beach have its own adjacent water body", not "is there water nearby".
  //
  // Ways only: a relation-mapped water body never sets this flag.
  //
  // The area gate is the pond threshold, >= WATER_MIN_AREA_DEG2 on the raw degree
  // product of the envelope, deliberately not the strict < used in the pond skip.
  //
  // The tags.natural === "water" test is kept here, unlike the coastline probe,
  // and it is free: nearbyWayWater true and false both resolve to "inland" in
  // classifyWaterBody, so it cannot move a verdict either way. What it preserves
  // is the run log's inland_no_water counter, the one diagnostic separating a
  // data-coverage failure from a genuinely set-back beach, which is why
  // classifyQueue reads this signal directly rather than only the verdict.
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
