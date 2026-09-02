// src/layerGrid.js — the in-process spatial index the offline layer pipeline
// queries instead of the Overpass server.
//
// Overpass answered every "what is near this beach" question remotely, with its
// own spatial index. Reading prebuilt FlatGeobuf layers moves that question into
// this process, and a naive linear scan does not survive the move: the lakes
// layer alone is on the order of 3e6 ring segments, and the classification pass
// probes it once per beach VERTEX (~30-50 per beach, ~1,669 beaches today and
// ~20k at the North America target). That is ~1e11 segment evaluations — hours,
// not the seconds a per-run job can afford.
//
// Pure: no fetch, no Date, no I/O, no npm dependency, no Deno/fs access. Imports
// src/geo.js and nothing else, exactly as src/marineZones.js does, so it is safe
// to import from the offline batch and from tests alike.
//
// TWO INDEX MODES, because one does not fit both jobs:
//
//   Mode A — ENVELOPE grid (buildLayerGrid / queryGridByBounds). For features
//   that are SMALL relative to a cell and whose
//   whole geometry the caller needs anyway: beaches and parks. It is a CANDIDACY
//   filter — the exact decision (point-in-polygon, nearest-edge distance) always
//   happens at the call site against the retained geometry.
//
//   Mode B — SEGMENT grid (buildSegmentGrid / addFeatureSegments /
//   finishSegmentGrid / anySegmentWithinKmOfPoint / featuresWithinKmOfVertices).
//   For coastline, water and lakes. An envelope grid provides ZERO pruning for
//   the six Great Lake polygons: their envelopes contain essentially every Great
//   Lakes beach, so an envelope query returns all six and then falls through to
//   an uncapped scan of every ring segment they own. Mode B indexes the
//   SEGMENTS themselves, in typed arrays, and never retains the source geometry
//   — that is both the speed fix and the memory fix (a ~3e6 vertex layer costs
//   ~100 MB of Float64Array/Int32Array instead of multiple GB of GeoJSON heap,
//   which is what lets the caller feed it from a streaming reader).
//
// Mode B is EXACT for the threshold question it answers ("is anything within
// maxKm"): the candidate cell neighbourhood provably contains every segment that
// could be within maxKm, and the per-segment test is the same local-planar math
// minEdgeDistanceKm uses. Mode A is deliberately NOT exact — it over-includes.
//
// Known scope limit, stated rather than handled: no antimeridian wrap. Cells are
// keyed off raw degrees, so a query at lon 179.99 does not see a feature at
// -179.99. Every region this pipeline covers (see src/regions.js) is far from
// the 180th meridian; a future Pacific region would need that wrap added here.

import {
  KM_PER_DEG,
  geometryPolygons,
  geometryLines,
  anySegmentWithinKm
} from "./geo.js";

// Cell size in degrees (~5.5 km north-south), an order of magnitude above every
// probe radius this pipeline uses (the largest is OCEAN_RADIUS_M / 150 m). A
// cell that large keeps the cell count small and the per-query neighbourhood at
// a handful of cells; a cell near the probe radius would explode the cell map
// for no gain, since the neighbourhood always widens by a full cell anyway.
export const GRID_CELL_DEG = 0.05;

// Cell coordinates are packed into ONE number so the cell map can be a
// Map<number, ...> rather than a Map<string, ...> — string keys would allocate
// a key per lookup in the hottest loop in the pipeline. The offset recentres
// cell indices to non-negative values and the stride keeps the two axes from
// colliding; the widest legitimate index is 180 / 0.05 = 3,600, so a 40,000
// offset with a 100,000 stride leaves four orders of magnitude of slack and the
// largest key (~4.4e9) stays far inside the safe-integer range.
const CELL_KEY_OFFSET = 40000;
const CELL_KEY_STRIDE = 100000;

// Cell indices are CLAMPED into the key range rather than rejected. Wild
// coordinates (a corrupt bound, a 1e12 longitude) then land in an edge bucket
// instead of producing a colliding or non-integer key; correctness is unharmed
// because the exact envelope / distance test still decides every candidate. This
// mirrors the "skip malformed, never throw" convention the rest of the geo code
// follows.
const CELL_INDEX_MIN = -(CELL_KEY_OFFSET - 1);
const CELL_INDEX_MAX = CELL_KEY_OFFSET - 1;

// Longitude degrees shrink with latitude. A pad expressed in degrees of LATITUDE
// covers KM_PER_DEG km north-south but only KM_PER_DEG * cos(lat) km east-west,
// so padding both axes by the same number of degrees would under-reach in
// longitude and could DROP a feature that is genuinely within the radius (at
// 49 N by a third). Every pad below is therefore divided by cos(lat) on the
// longitude axis. The clamp matches src/marineZones.js: it bounds the pad near
// the poles instead of letting it diverge.
const MIN_COS_LAT = 0.01;

// A feature whose envelope covers more cells than this is not registered per
// cell at all — it goes on an OVERSIZED list that every query scans
// unconditionally. Registering, say, a state-sized park envelope cell by cell
// would write tens of thousands of entries for a feature that is a candidate
// almost everywhere anyway. Correctness is unchanged (the oversized list is
// always consulted); only the memory profile is.
const MAX_CELLS_PER_FEATURE = 4096;

// Segments are SUBDIVIDED so that no indexed piece spans more than this many
// cells on either axis. A single long diagonal segment (a simplified lake ring
// edge, a coastline jump) has a bounding box covering span-x * span-y cells —
// quadratic in its length — and registering it into all of them is pure waste.
// Splitting a straight segment at interior points is exact (the pieces are
// colinear with the original), so this costs nothing but a few extra entries.
const MAX_CELL_SPAN_PER_SEGMENT = 1;

// Initial segment capacity of a segment-grid builder, grown by doubling.
const SEGMENT_INITIAL_CAPACITY = 1024;

// Slack added to the segment grid's cheap bounding-box rejection, in degrees
// (~0.1 mm). The rejection is computed in DEGREES while the decision it guards
// (anySegmentWithinKm) is computed in projected KILOMETRES, and the two round
// differently in the last bit: a segment lying at EXACTLY maxKm could be
// rejected here an ulp before the evaluator would have accepted it. geo.js
// deliberately refused a pre-reject inside the evaluator for that same
// bit-exactness reason, so the guard in front of it has to be strictly
// conservative rather than strictly tight. This is nine orders of magnitude
// below any radius in the pipeline, so it costs nothing.
const SEGMENT_BBOX_EPSILON_DEG = 1e-9;

function isFiniteNumber(value) {
  return typeof value === "number" && isFinite(value);
}

function cellIndexFor(degrees) {
  const raw = Math.floor(degrees / GRID_CELL_DEG);
  if (raw < CELL_INDEX_MIN) { return CELL_INDEX_MIN; }
  if (raw > CELL_INDEX_MAX) { return CELL_INDEX_MAX; }
  return raw;
}

function cellKeyFor(cx, cy) {
  return (cx + CELL_KEY_OFFSET) * CELL_KEY_STRIDE + (cy + CELL_KEY_OFFSET);
}

// The longitude half of a pad given in degrees of latitude, at this latitude.
function lonPadFor(lat, padDeg) {
  const cosLat = Math.cos(lat * Math.PI / 180);
  return padDeg / Math.max(Math.abs(cosLat), MIN_COS_LAT);
}

function validBounds(bounds) {
  return bounds !== null && typeof bounds === "object" &&
    isFiniteNumber(bounds.minLat) && isFiniteNumber(bounds.minLon) &&
    isFiniteNumber(bounds.maxLat) && isFiniteNumber(bounds.maxLon);
}

// --- Mode A: the envelope grid -------------------------------------------------

// Index an array of features by their bounding boxes. Features are identified by
// their ORIGINAL ARRAY INDEX throughout — every query returns indices, ascending
// — because the consumers' tie-break rules (associateParkForBeach's smallest-
// area-then-first-seen, mergeBeachRows' first-seen) ride on the caller's own
// ordering and a grid that reordered candidates would silently change answers.
//
// A feature with missing or malformed bounds is KEPT in the index positionally
// (so indices stay aligned with the caller's array) but is registered in no cell
// and matches no query: its stored bounds are NaN, and every comparison against
// NaN is false. Malformed input is upstream data, not a programming error, so it
// is skipped rather than thrown on.
export function buildLayerGrid(features) {
  const list = Array.isArray(features) ? features : [];
  const count = list.length;
  const minLat = new Float64Array(count);
  const minLon = new Float64Array(count);
  const maxLat = new Float64Array(count);
  const maxLon = new Float64Array(count);
  const cells = new Map();
  const oversized = [];
  for (let i = 0; i < count; i = i + 1) {
    const feature = list[i];
    const bounds = feature === null || typeof feature !== "object" ? null : feature.bounds;
    if (!validBounds(bounds)) {
      minLat[i] = NaN;
      minLon[i] = NaN;
      maxLat[i] = NaN;
      maxLon[i] = NaN;
      continue;
    }
    minLat[i] = bounds.minLat;
    minLon[i] = bounds.minLon;
    maxLat[i] = bounds.maxLat;
    maxLon[i] = bounds.maxLon;
    const cxLo = cellIndexFor(Math.min(bounds.minLon, bounds.maxLon));
    const cxHi = cellIndexFor(Math.max(bounds.minLon, bounds.maxLon));
    const cyLo = cellIndexFor(Math.min(bounds.minLat, bounds.maxLat));
    const cyHi = cellIndexFor(Math.max(bounds.minLat, bounds.maxLat));
    const spanned = (cxHi - cxLo + 1) * (cyHi - cyLo + 1);
    if (spanned > MAX_CELLS_PER_FEATURE) {
      oversized.push(i);
      continue;
    }
    for (let cx = cxLo; cx <= cxHi; cx = cx + 1) {
      for (let cy = cyLo; cy <= cyHi; cy = cy + 1) {
        const key = cellKeyFor(cx, cy);
        const bucket = cells.get(key);
        if (bucket === undefined) {
          cells.set(key, [i]);
        } else {
          bucket.push(i);
        }
      }
    }
  }
  // Buckets are built by ascending i, so each one is already ascending; freezing
  // them into Int32Arrays keeps the hot query loop off the megamorphic path a
  // growable array of numbers takes.
  const frozen = new Map();
  for (const entry of cells) {
    frozen.set(entry[0], Int32Array.from(entry[1]));
  }
  return {
    cellDeg: GRID_CELL_DEG,
    count: count,
    cells: frozen,
    oversized: Int32Array.from(oversized),
    minLat: minLat,
    minLon: minLon,
    maxLat: maxLat,
    maxLon: maxLon
  };
}

// Does feature i's envelope, padded by (latPad, lonPad), contain the point?
function paddedEnvelopeHit(grid, i, lat, lon, latPad, lonPad) {
  return lat >= grid.minLat[i] - latPad && lat <= grid.maxLat[i] + latPad &&
    lon >= grid.minLon[i] - lonPad && lon <= grid.maxLon[i] + lonPad;
}

// Walk the cell neighbourhood of one padded point, calling visit(featureIndex)
// for every registered candidate (duplicates included — the caller dedupes).
// The neighbourhood is widened by a full cell on every side so a query sitting
// on a cell boundary still sees the neighbouring cell's features.
function visitPointCells(grid, lat, lon, latPad, lonPad, visit) {
  const cxLo = cellIndexFor(lon - lonPad) - 1;
  const cxHi = cellIndexFor(lon + lonPad) + 1;
  const cyLo = cellIndexFor(lat - latPad) - 1;
  const cyHi = cellIndexFor(lat + latPad) + 1;
  for (let cx = cxLo; cx <= cxHi; cx = cx + 1) {
    for (let cy = cyLo; cy <= cyHi; cy = cy + 1) {
      const bucket = grid.cells.get(cellKeyFor(cx, cy));
      if (bucket === undefined) {
        continue;
      }
      for (let k = 0; k < bucket.length; k = k + 1) {
        visit(bucket[k]);
      }
    }
  }
  for (let k = 0; k < grid.oversized.length; k = k + 1) {
    visit(grid.oversized[k]);
  }
}

function ascending(a, b) {
  return a - b;
}

// Candidates whose envelope OVERLAPS a query RECTANGLE, ascending index order.
// UNPADDED and inclusive (edge-touching counts), matching osmSelect's
// boundsOverlap byte for byte — associateParkForBeach matches bbox to bbox, not
// point to bbox, and its smallest-area-then-first-seen tie-break is only
// reproducible if this returns exactly the same set in exactly the same order as
// the full-list scan it replaces.
export function queryGridByBounds(grid, bounds) {
  if (grid === null || typeof grid !== "object" || grid.count === 0) {
    return [];
  }
  if (!validBounds(bounds)) {
    return [];
  }
  const qMinLon = Math.min(bounds.minLon, bounds.maxLon);
  const qMaxLon = Math.max(bounds.minLon, bounds.maxLon);
  const qMinLat = Math.min(bounds.minLat, bounds.maxLat);
  const qMaxLat = Math.max(bounds.minLat, bounds.maxLat);
  const cxLo = cellIndexFor(qMinLon);
  const cxHi = cellIndexFor(qMaxLon);
  const cyLo = cellIndexFor(qMinLat);
  const cyHi = cellIndexFor(qMaxLat);
  const out = [];
  const seen = new Set();
  const consider = function (i) {
    if (seen.has(i)) {
      return;
    }
    seen.add(i);
    if (grid.minLat[i] <= bounds.maxLat && grid.maxLat[i] >= bounds.minLat &&
      grid.minLon[i] <= bounds.maxLon && grid.maxLon[i] >= bounds.minLon) {
      out.push(i);
    }
  };
  for (let cx = cxLo; cx <= cxHi; cx = cx + 1) {
    for (let cy = cyLo; cy <= cyHi; cy = cy + 1) {
      const bucket = grid.cells.get(cellKeyFor(cx, cy));
      if (bucket === undefined) {
        continue;
      }
      for (let k = 0; k < bucket.length; k = k + 1) {
        consider(bucket[k]);
      }
    }
  }
  for (let k = 0; k < grid.oversized.length; k = k + 1) {
    consider(grid.oversized[k]);
  }
  out.sort(ascending);
  return out;
}

// --- Mode B: the segment grid --------------------------------------------------

// A mutable builder. Segments accumulate in growable typed arrays: coordinates
// as [ax, ay, bx, by] quads of DEGREES (lon, lat — the order anySegmentWithinKm
// expects) in a Float64Array, and the owning feature index in a parallel
// Int32Array. Nothing else is retained: after addFeatureSegments returns, the
// caller may drop the geometry entirely and keep only the small
// { osmType, osmId, tags, bounds } sidecar it needs for the answer.
export function buildSegmentGrid() {
  return {
    cells: new Map(),
    segs: new Float64Array(SEGMENT_INITIAL_CAPACITY * 4),
    owners: new Int32Array(SEGMENT_INITIAL_CAPACITY),
    count: 0,
    capacity: SEGMENT_INITIAL_CAPACITY,
    oversized: [],
    maxOwner: -1
  };
}

function growBuilder(builder) {
  const capacity = builder.capacity * 2;
  const segs = new Float64Array(capacity * 4);
  segs.set(builder.segs.subarray(0, builder.count * 4));
  const owners = new Int32Array(capacity);
  owners.set(builder.owners.subarray(0, builder.count));
  builder.segs = segs;
  builder.owners = owners;
  builder.capacity = capacity;
}

function pushSegment(builder, featureIndex, ax, ay, bx, by) {
  if (builder.count === builder.capacity) {
    growBuilder(builder);
  }
  const index = builder.count;
  const base = index * 4;
  builder.segs[base] = ax;
  builder.segs[base + 1] = ay;
  builder.segs[base + 2] = bx;
  builder.segs[base + 3] = by;
  builder.owners[index] = featureIndex;
  builder.count = index + 1;
  if (featureIndex > builder.maxOwner) {
    builder.maxOwner = featureIndex;
  }
  const cxLo = cellIndexFor(Math.min(ax, bx));
  const cxHi = cellIndexFor(Math.max(ax, bx));
  const cyLo = cellIndexFor(Math.min(ay, by));
  const cyHi = cellIndexFor(Math.max(ay, by));
  if ((cxHi - cxLo + 1) * (cyHi - cyLo + 1) > MAX_CELLS_PER_FEATURE) {
    // Only reachable for a segment whose endpoints are pathological (clamped
    // coordinates); the subdivision below normally keeps this at a 2x2 box.
    builder.oversized.push(index);
    return;
  }
  for (let cx = cxLo; cx <= cxHi; cx = cx + 1) {
    for (let cy = cyLo; cy <= cyHi; cy = cy + 1) {
      const key = cellKeyFor(cx, cy);
      const bucket = builder.cells.get(key);
      if (bucket === undefined) {
        builder.cells.set(key, [index]);
      } else {
        bucket.push(index);
      }
    }
  }
}

// Add one segment, subdividing it first if its bounding box spans more cells
// than MAX_CELL_SPAN_PER_SEGMENT on either axis. A long diagonal segment's bbox
// covers spanX * spanY cells — quadratic in its length, and almost all of that
// box is nowhere near the segment — so registering it whole is both wasteful and
// a source of useless candidates. The split points are computed by linear
// interpolation, so the pieces are exactly colinear with the original: no
// geometry is distorted and no distance answer changes.
function addSubdividedSegment(builder, featureIndex, ax, ay, bx, by) {
  const spanX = Math.abs(bx - ax) / GRID_CELL_DEG;
  const spanY = Math.abs(by - ay) / GRID_CELL_DEG;
  const span = Math.max(spanX, spanY);
  let pieces = 1;
  if (span > MAX_CELL_SPAN_PER_SEGMENT) {
    pieces = Math.ceil(span / MAX_CELL_SPAN_PER_SEGMENT);
  }
  if (!isFinite(pieces) || pieces < 1) {
    pieces = 1;
  }
  if (pieces === 1) {
    pushSegment(builder, featureIndex, ax, ay, bx, by);
    return 1;
  }
  let px = ax;
  let py = ay;
  for (let p = 1; p <= pieces; p = p + 1) {
    const t = p / pieces;
    const qx = p === pieces ? bx : ax + (bx - ax) * t;
    const qy = p === pieces ? by : ay + (by - ay) * t;
    pushSegment(builder, featureIndex, px, py, qx, qy);
    px = qx;
    py = qy;
  }
  return pieces;
}

// Every coordinate SEQUENCE a geometry contributes: polygon rings (outer rings
// AND holes alike — an island beach sits inside a hole and its nearest water is
// that hole's edge) and linestrings. Point/MultiPoint geometries are handled
// separately, as degenerate zero-length segments, so a node-mapped water feature
// still answers a proximity probe instead of vanishing from the index.
function geometryPointRuns(geometry) {
  const runs = [];
  for (const polygon of geometryPolygons(geometry)) {
    if (!Array.isArray(polygon)) {
      continue;
    }
    for (const ring of polygon) {
      if (Array.isArray(ring) && ring.length >= 2) {
        runs.push(ring);
      }
    }
  }
  for (const line of geometryLines(geometry)) {
    if (Array.isArray(line) && line.length >= 2) {
      runs.push(line);
    }
  }
  return runs;
}

function geometrySinglePoints(geometry) {
  if (geometry === null || typeof geometry !== "object") {
    return [];
  }
  if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
    return [geometry.coordinates];
  }
  if (geometry.type === "MultiPoint" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }
  return [];
}

// Chop one feature's geometry into segments and register them under
// featureIndex. Returns the number of indexed segments (diagnostic — the 9.7
// benchmark gate records the per-layer segment count). Malformed coordinates are
// skipped silently: layer bytes are upstream data.
export function addFeatureSegments(builder, featureIndex, geometry) {
  if (builder === null || typeof builder !== "object") {
    return 0;
  }
  if (!isFiniteNumber(featureIndex) || featureIndex < 0) {
    return 0;
  }
  let added = 0;
  for (const run of geometryPointRuns(geometry)) {
    for (let i = 0; i < run.length - 1; i = i + 1) {
      const a = run[i];
      const b = run[i + 1];
      if (!Array.isArray(a) || !Array.isArray(b) ||
        !isFiniteNumber(a[0]) || !isFiniteNumber(a[1]) ||
        !isFiniteNumber(b[0]) || !isFiniteNumber(b[1])) {
        continue;
      }
      added = added + addSubdividedSegment(builder, featureIndex, a[0], a[1], b[0], b[1]);
    }
  }
  for (const point of geometrySinglePoints(geometry)) {
    if (!Array.isArray(point) || !isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) {
      continue;
    }
    pushSegment(builder, featureIndex, point[0], point[1], point[0], point[1]);
    added = added + 1;
  }
  return added;
}

// Freeze a builder into a query-ready grid. The coordinate and owner arrays are
// COPIED down to their exact length, so the doubling slack is released and the
// finished grid holds only what it indexes.
export function finishSegmentGrid(builder) {
  if (builder === null || typeof builder !== "object") {
    return {
      cells: new Map(),
      segs: new Float64Array(0),
      owners: new Int32Array(0),
      count: 0,
      oversized: new Int32Array(0),
      featureCount: 0,
      stats: { probes: 0, segmentsExamined: 0 }
    };
  }
  const cells = new Map();
  for (const entry of builder.cells) {
    cells.set(entry[0], Int32Array.from(entry[1]));
  }
  return {
    cells: cells,
    segs: builder.segs.slice(0, builder.count * 4),
    owners: builder.owners.slice(0, builder.count),
    count: builder.count,
    oversized: Int32Array.from(builder.oversized),
    featureCount: builder.maxOwner + 1,
    // Diagnostic counters, mutated by the query functions. They exist because
    // the failure this whole module prevents — a probe degenerating to a full
    // scan — is invisible in a correctness test and only shows up as a slow job
    // hours later. A test can assert segments-examined-per-probe directly, which
    // is deterministic where wall clock is not.
    stats: { probes: 0, segmentsExamined: 0 }
  };
}

// Diagnostic snapshot: indexed segment count, occupied cells, distinct feature
// slots, and the cumulative query counters. Read by the batch's run log (the
// 9.7 benchmark gate records lakes/coastline/water segment counts) and by tests.
export function segmentGridStats(segGrid) {
  if (segGrid === null || typeof segGrid !== "object") {
    return { segments: 0, cells: 0, features: 0, probes: 0, segmentsExamined: 0 };
  }
  return {
    segments: segGrid.count,
    cells: segGrid.cells.size,
    features: segGrid.featureCount,
    probes: segGrid.stats.probes,
    segmentsExamined: segGrid.stats.segmentsExamined
  };
}

function segmentBboxMiss(segs, index, lat, lon, latPad, lonPad) {
  const base = index * 4;
  const ax = segs[base];
  const ay = segs[base + 1];
  const bx = segs[base + 2];
  const by = segs[base + 3];
  const lonSlack = lonPad + SEGMENT_BBOX_EPSILON_DEG;
  const latSlack = latPad + SEGMENT_BBOX_EPSILON_DEG;
  if (lon < Math.min(ax, bx) - lonSlack || lon > Math.max(ax, bx) + lonSlack) {
    return true;
  }
  if (lat < Math.min(ay, by) - latSlack || lat > Math.max(ay, by) + latSlack) {
    return true;
  }
  return false;
}

// Walk the cell neighbourhood of a probe point, handing each cell's segment
// index array to visit(). The neighbourhood is the padded query box widened by a
// full cell, and the pad is scaled by 1/cos(lat) on the longitude axis — that
// scaling is what makes this mode EXACT: every segment within maxKm of the point
// is provably inside the cells visited here.
function visitSegmentCells(segGrid, lat, lon, latPad, lonPad, visit) {
  const cxLo = cellIndexFor(lon - lonPad) - 1;
  const cxHi = cellIndexFor(lon + lonPad) + 1;
  const cyLo = cellIndexFor(lat - latPad) - 1;
  const cyHi = cellIndexFor(lat + latPad) + 1;
  for (let cx = cxLo; cx <= cxHi; cx = cx + 1) {
    for (let cy = cyLo; cy <= cyHi; cy = cy + 1) {
      const bucket = segGrid.cells.get(cellKeyFor(cx, cy));
      if (bucket === undefined) {
        continue;
      }
      if (visit(bucket) === true) {
        return true;
      }
    }
  }
  if (segGrid.oversized.length > 0) {
    return visit(segGrid.oversized) === true;
  }
  return false;
}

// TRUE iff some indexed segment is within maxKm of (lat, lon). Only the padded
// cell neighbourhood is evaluated, and anySegmentWithinKm early-exits inside each
// cell's array — the probes here are all threshold questions ("is there
// coastline within 150 m"), never "how far exactly", so nothing ever needs the
// full minimum.
export function anySegmentWithinKmOfPoint(segGrid, lat, lon, maxKm) {
  if (segGrid === null || typeof segGrid !== "object" || segGrid.count === 0) {
    return false;
  }
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon) || !isFiniteNumber(maxKm) || maxKm < 0) {
    return false;
  }
  const latPad = maxKm / KM_PER_DEG;
  const lonPad = lonPadFor(lat, latPad);
  const segs = segGrid.segs;
  const stats = segGrid.stats;
  stats.probes = stats.probes + 1;
  return visitSegmentCells(segGrid, lat, lon, latPad, lonPad, function (bucket) {
    stats.segmentsExamined = stats.segmentsExamined + bucket.length;
    return anySegmentWithinKm(segs, bucket, bucket.length, lat, lon, maxKm);
  });
}

// The feature indices owning any segment within maxKm of ANY probe vertex,
// deduped, ASCENDING feature-index order — the callers' answers (nearbyLakeQids
// in particular) are order-sensitive and must not depend on which vertex found a
// feature first.
export function featuresWithinKmOfVertices(segGrid, vertices, maxKm) {
  if (segGrid === null || typeof segGrid !== "object" || segGrid.count === 0) {
    return [];
  }
  if (!Array.isArray(vertices) || vertices.length === 0) {
    return [];
  }
  if (!isFiniteNumber(maxKm) || maxKm < 0) {
    return [];
  }
  const segs = segGrid.segs;
  const owners = segGrid.owners;
  const stats = segGrid.stats;
  const accepted = new Set();
  const out = [];
  // A one-element index window: anySegmentWithinKm is the single evaluator for
  // segment distance in this pipeline, and asking it about one segment at a time
  // is what lets an ACCEPTED feature short-circuit every remaining segment it
  // owns (a lake ring has hundreds of thousands of them).
  const single = new Int32Array(1);
  for (const vertex of vertices) {
    if (vertex === null || typeof vertex !== "object" ||
      !isFiniteNumber(vertex.lat) || !isFiniteNumber(vertex.lon)) {
      continue;
    }
    const lat = vertex.lat;
    const lon = vertex.lon;
    const latPad = maxKm / KM_PER_DEG;
    const lonPad = lonPadFor(lat, latPad);
    stats.probes = stats.probes + 1;
    visitSegmentCells(segGrid, lat, lon, latPad, lonPad, function (bucket) {
      stats.segmentsExamined = stats.segmentsExamined + bucket.length;
      for (let k = 0; k < bucket.length; k = k + 1) {
        const index = bucket[k];
        const owner = owners[index];
        if (accepted.has(owner)) {
          continue;
        }
        // Cheap rejection first: a point within maxKm of the segment is within
        // (latPad, lonPad) degrees of the segment's own bounding box, so a miss
        // here cannot be a false negative.
        if (segmentBboxMiss(segs, index, lat, lon, latPad, lonPad)) {
          continue;
        }
        single[0] = index;
        if (anySegmentWithinKm(segs, single, 1, lat, lon, maxKm)) {
          accepted.add(owner);
          out.push(owner);
        }
      }
      // Never short-circuit: this query wants EVERY owning feature, not the
      // first one, so the visitor always reports "keep going".
      return false;
    });
  }
  out.sort(ascending);
  return out;
}
