// src/layerGrid.js — the in-process spatial index the offline layer pipeline
// probes. A naive linear scan does not work at this scale: the lakes layer alone
// is on the order of 3e6 ring segments, and the classification pass probes it
// once per beach vertex, tens per beach across the whole table. That is hours of
// segment evaluations, not the seconds a per-run job can afford.
//
// Pure: no fetch, no Date, no I/O, no npm dependency, no Deno or fs access.
// Imports src/geo.js and nothing else, so the offline batch and the tests both
// load it directly.
//
// Two index modes, because one does not fit both jobs:
//
//   Mode A, the envelope grid (buildLayerGrid / queryGridByBounds), for features
//   small relative to a cell whose whole geometry the caller needs anyway:
//   beaches and parks. It is a candidacy filter; the exact decision
//   (point-in-polygon, nearest-edge distance) happens at the call site against
//   the retained geometry.
//
//   Mode B, the segment grid (buildSegmentGrid / addFeatureSegments /
//   finishSegmentGrid / anySegmentWithinKmOfPoint / featuresWithinKmOfVertices),
//   for coastline, water and lakes. An envelope grid prunes nothing for the six
//   Great Lake polygons: their envelopes contain essentially every Great Lakes
//   beach, so an envelope query returns all six and falls through to an uncapped
//   scan of every ring segment they own. Mode B indexes the segments themselves,
//   in typed arrays, and never retains the source geometry — both the speed fix
//   and the memory fix, since a ~3e6-vertex layer costs ~100 MB of typed arrays
//   instead of gigabytes of GeoJSON heap, which is what lets the caller feed it
//   from a streaming reader.
//
// Mode B is exact for the threshold question it answers: the candidate cell
// neighbourhood provably contains every segment that could be within maxKm, and
// the per-segment test is the same local-planar math minEdgeDistanceKm uses.
// Mode A deliberately over-includes.
//
// The longitude axis is a circle. Cells are keyed off longitude wrapped into
// [-180, 180), a cell walk that runs past either edge continues on the other
// side, and an envelope or query box may reach past ±180 (a padded box) or be
// given with minLon > maxLon, which means it wraps through 180. Every segment is
// read as the shorter of its two arcs (src/geo.js lonSegmentEndOffsetDeg), so a
// way with vertices at 179.9 and -179.9 is indexed at the seam and measured 0.2
// degrees wide, and a probe at 179.99 sees a feature at -179.99. Away from the
// antimeridian every answer is unchanged bit for bit: wrapping is the identity
// on in-range longitude and the short-arc offset is the raw difference.

import {
  KM_PER_DEG,
  geometryPolygons,
  geometryLines,
  anySegmentWithinKm,
  lonOffsetDeg,
  lonSegmentEndOffsetDeg
} from "./geo.js";

// Cell size in degrees (~5.5 km north-south), an order of magnitude above every
// probe radius this pipeline uses (the largest is OCEAN_RADIUS_M / 150 m). A
// cell that large keeps the cell count small and the per-query neighbourhood at
// a handful of cells; a cell near the probe radius would explode the cell map
// for no gain, since the neighbourhood always widens by a full cell anyway.
export const GRID_CELL_DEG = 0.05;

// Cell coordinates are packed into one number so the cell map can be keyed by
// number rather than string; string keys would allocate a key per lookup in the
// hottest loop in the pipeline. The offset recentres cell indices to non-negative
// values and the stride keeps the two axes from colliding. The widest legitimate
// index is 180 / 0.05 = 3,600, so a 40,000 offset with a 100,000 stride leaves
// four orders of magnitude of slack and the largest key stays inside the
// safe-integer range.
const CELL_KEY_OFFSET = 40000;
const CELL_KEY_STRIDE = 100000;

// Longitude cells per full turn, and the index range a wrapped longitude maps
// to: [-180, 180) is cells LON_CELL_MIN .. LON_CELL_MAX, and the cell after
// LON_CELL_MAX is LON_CELL_MIN again.
const LON_CELLS = Math.round(360 / GRID_CELL_DEG);
const LON_CELL_MIN = -LON_CELLS / 2;
const LON_CELL_MAX = LON_CELL_MIN + LON_CELLS - 1;

// Latitude cell indices are clamped into the key range rather than rejected, so
// a corrupt bound or a 1e12 latitude lands in an edge bucket instead of producing
// a colliding or non-integer key. Correctness is unharmed because the exact
// envelope or distance test still decides every candidate.
const CELL_INDEX_MIN = -(CELL_KEY_OFFSET - 1);
const CELL_INDEX_MAX = CELL_KEY_OFFSET - 1;

// Longitude degrees shrink with latitude. A pad expressed in degrees of latitude
// covers KM_PER_DEG km north-south but only KM_PER_DEG * cos(lat) km east-west,
// so padding both axes by the same number of degrees under-reaches in longitude
// and could drop a feature genuinely within the radius — by a third at 49 N.
// Every pad below is divided by cos(lat) on the longitude axis, with a clamp
// matching src/marineZones.js so it does not diverge near the poles.
const MIN_COS_LAT = 0.01;

// A feature whose envelope covers more cells than this goes on an oversized list
// every query scans unconditionally rather than being registered per cell.
// Registering a state-sized park envelope cell by cell would write tens of
// thousands of entries for a feature that is a candidate almost everywhere
// anyway. Correctness is unchanged; only the memory profile is.
const MAX_CELLS_PER_FEATURE = 4096;

// Segments are subdivided so no indexed piece spans more than this many cells on
// either axis. A long diagonal segment has a bounding box covering spanX * spanY
// cells, quadratic in its length, and registering it into all of them is waste.
// Splitting a straight segment at interior points is exact, since the pieces stay
// colinear with the original.
const MAX_CELL_SPAN_PER_SEGMENT = 1;

// Initial segment capacity of a segment-grid builder, grown by doubling.
const SEGMENT_INITIAL_CAPACITY = 1024;

// Slack added to the segment grid's cheap bounding-box rejection, in degrees
// (~0.1 mm). The rejection is computed in degrees while the decision it guards
// (anySegmentWithinKm) is computed in projected kilometres, and the two round
// differently in the last bit: a segment lying at exactly maxKm could be rejected
// here an ulp before the evaluator would have accepted it. geo.js deliberately
// refuses a pre-reject inside the evaluator for that same bit-exactness reason,
// so the guard in front of it has to be conservative rather than tight. Nine
// orders of magnitude below any radius in the pipeline, so it costs nothing.
const SEGMENT_BBOX_EPSILON_DEG = 1e-9;

function isFiniteNumber(value) {
  return typeof value === "number" && isFinite(value);
}

// Longitude wrapped into [-180, 180). The identity, bit for bit, for a value
// already inside that range.
function wrapLon(lon) {
  if (lon >= -180 && lon < 180) {
    return lon;
  }
  return lon - 360 * Math.floor((lon + 180) / 360);
}

// A longitude cell index in continuous (unwrapped) space brought onto the
// circle, so a walk that ran past LON_CELL_MAX continues at LON_CELL_MIN.
function wrapLonCell(cx) {
  const m = (cx - LON_CELL_MIN) % LON_CELLS;
  return (m < 0 ? m + LON_CELLS : m) + LON_CELL_MIN;
}

// The continuous longitude cell index of a degree value, wrapped later by the
// walk that consumes it. Kept unwrapped here so a span across the seam is still
// cxHi - cxLo + 1.
function lonCellIndexFor(degrees) {
  return Math.floor(degrees / GRID_CELL_DEG);
}

// How many longitude cells a continuous index range covers, capped at one full
// turn so no walk visits a cell twice.
function lonCellSpan(cxLo, cxHi) {
  const span = cxHi - cxLo + 1;
  return span > LON_CELLS ? LON_CELLS : span;
}

function nextLonCell(cx) {
  return cx === LON_CELL_MAX ? LON_CELL_MIN : cx + 1;
}

function latCellIndexFor(degrees) {
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

// Inclusive overlap of two longitude spans read on the circle. The raw line test
// comes first and is boundsOverlap byte for byte; the shifted tests can only
// succeed when a span reaches ±180, so away from the seam nothing changes.
function lonSpansOverlap(aLo, aHi, bLo, bHi) {
  if (aLo <= bHi && aHi >= bLo) {
    return true;
  }
  if (aLo + 360 <= bHi && aHi + 360 >= bLo) {
    return true;
  }
  return aLo - 360 <= bHi && aHi - 360 >= bLo;
}

// Index an array of features by their bounding boxes. Features are identified by
// their original array index throughout and every query returns indices in
// ascending order, because the consumers' tie-break rules
// (associateParkForBeach's smallest-area-then-first-seen, mergeBeachRows'
// first-seen) ride on the caller's own ordering, and a grid that reordered
// candidates would silently change answers.
//
// A feature with missing or malformed bounds is kept in the index positionally,
// so indices stay aligned with the caller's array, but is registered in no cell
// and matches no query: its stored bounds are NaN and every comparison against
// NaN is false. Malformed input is upstream data, not a programming error.
//
// A bounds record with minLon > maxLon wraps through 180 and is stored in its
// continuous form, maxLon + 360, so the overlap test above sees one span.
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
    const lonLo = bounds.minLon;
    const lonHi = bounds.maxLon < lonLo ? bounds.maxLon + 360 : bounds.maxLon;
    minLat[i] = bounds.minLat;
    minLon[i] = lonLo;
    maxLat[i] = bounds.maxLat;
    maxLon[i] = lonHi;
    const cxLo = lonCellIndexFor(lonLo);
    const cxHi = lonCellIndexFor(lonHi);
    const cyLo = latCellIndexFor(Math.min(bounds.minLat, bounds.maxLat));
    const cyHi = latCellIndexFor(Math.max(bounds.minLat, bounds.maxLat));
    const spanX = lonCellSpan(cxLo, cxHi);
    const spanned = spanX * (cyHi - cyLo + 1);
    if (spanned > MAX_CELLS_PER_FEATURE) {
      oversized.push(i);
      continue;
    }
    let cx = wrapLonCell(cxLo);
    for (let k = 0; k < spanX; k = k + 1) {
      for (let cy = cyLo; cy <= cyHi; cy = cy + 1) {
        const key = cellKeyFor(cx, cy);
        const bucket = cells.get(key);
        if (bucket === undefined) {
          cells.set(key, [i]);
        } else {
          bucket.push(i);
        }
      }
      cx = nextLonCell(cx);
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

function ascending(a, b) {
  return a - b;
}

// Candidates whose envelope overlaps a query rectangle, in ascending index order.
// Unpadded and inclusive, matching osmSelect's boundsOverlap byte for byte away
// from the antimeridian: associateParkForBeach matches bbox to bbox rather than
// point to bbox, and its smallest-area-then-first-seen tie-break is only
// reproducible if this returns the same set in the same order as a full-list
// scan. At the seam the longitude axis is read on the circle: a query reaching
// past ±180, or given with minLon > maxLon, overlaps envelopes on the other side.
export function queryGridByBounds(grid, bounds) {
  if (grid === null || typeof grid !== "object" || grid.count === 0) {
    return [];
  }
  if (!validBounds(bounds)) {
    return [];
  }
  const qLonLo = bounds.minLon;
  const qLonHi = bounds.maxLon < qLonLo ? bounds.maxLon + 360 : bounds.maxLon;
  const qMinLat = Math.min(bounds.minLat, bounds.maxLat);
  const qMaxLat = Math.max(bounds.minLat, bounds.maxLat);
  const cxLo = lonCellIndexFor(qLonLo);
  const cxHi = lonCellIndexFor(qLonHi);
  const cyLo = latCellIndexFor(qMinLat);
  const cyHi = latCellIndexFor(qMaxLat);
  const spanX = lonCellSpan(cxLo, cxHi);
  const out = [];
  const seen = new Set();
  const consider = function (i) {
    if (seen.has(i)) {
      return;
    }
    seen.add(i);
    if (grid.minLat[i] <= bounds.maxLat && grid.maxLat[i] >= bounds.minLat &&
      lonSpansOverlap(grid.minLon[i], grid.maxLon[i], qLonLo, qLonHi)) {
      out.push(i);
    }
  };
  let cx = wrapLonCell(cxLo);
  for (let k = 0; k < spanX; k = k + 1) {
    for (let cy = cyLo; cy <= cyHi; cy = cy + 1) {
      const bucket = grid.cells.get(cellKeyFor(cx, cy));
      if (bucket === undefined) {
        continue;
      }
      for (let b = 0; b < bucket.length; b = b + 1) {
        consider(bucket[b]);
      }
    }
    cx = nextLonCell(cx);
  }
  for (let k = 0; k < grid.oversized.length; k = k + 1) {
    consider(grid.oversized[k]);
  }
  out.sort(ascending);
  return out;
}

// --- Mode B: the segment grid --------------------------------------------------

// A mutable builder. Segments accumulate in growable typed arrays: coordinates as
// [ax, ay, bx, by] quads of degrees (lon, lat, the order anySegmentWithinKm
// expects) in a Float64Array, and the owning feature index in a parallel
// Int32Array. Nothing else is retained, so after addFeatureSegments returns the
// caller may drop the geometry and keep only the small
// { osmType, osmId, tags, bounds } sidecar.
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

// Register one segment given in continuous longitude (the endpoints differ by at
// most a half turn, and one may lie past ±180). Cells come from the continuous
// span so a piece across the seam lands in the seam cells alone; the stored
// endpoints are wrapped, so segs always holds longitudes in [-180, 180) and the
// evaluator's short-arc rule recovers the piece.
function pushSegment(builder, featureIndex, ax, ay, bx, by) {
  if (builder.count === builder.capacity) {
    growBuilder(builder);
  }
  const index = builder.count;
  const base = index * 4;
  builder.segs[base] = wrapLon(ax);
  builder.segs[base + 1] = ay;
  builder.segs[base + 2] = wrapLon(bx);
  builder.segs[base + 3] = by;
  builder.owners[index] = featureIndex;
  builder.count = index + 1;
  if (featureIndex > builder.maxOwner) {
    builder.maxOwner = featureIndex;
  }
  const cxLo = lonCellIndexFor(Math.min(ax, bx));
  const cxHi = lonCellIndexFor(Math.max(ax, bx));
  const cyLo = latCellIndexFor(Math.min(ay, by));
  const cyHi = latCellIndexFor(Math.max(ay, by));
  const spanX = lonCellSpan(cxLo, cxHi);
  if (spanX * (cyHi - cyLo + 1) > MAX_CELLS_PER_FEATURE) {
    // Only reachable for a segment whose endpoints are pathological (clamped
    // coordinates); the subdivision below normally keeps this at a 2x2 box.
    builder.oversized.push(index);
    return;
  }
  let cx = wrapLonCell(cxLo);
  for (let k = 0; k < spanX; k = k + 1) {
    for (let cy = cyLo; cy <= cyHi; cy = cy + 1) {
      const key = cellKeyFor(cx, cy);
      const bucket = builder.cells.get(key);
      if (bucket === undefined) {
        builder.cells.set(key, [index]);
      } else {
        bucket.push(index);
      }
    }
    cx = nextLonCell(cx);
  }
}

// Add one segment, subdividing it first if its bounding box spans more cells than
// MAX_CELL_SPAN_PER_SEGMENT on either axis. A long diagonal segment's bbox covers
// spanX * spanY cells, almost all of it nowhere near the segment, so registering
// it whole is both wasteful and a source of useless candidates. Split points come
// from linear interpolation, so the pieces stay exactly colinear with the
// original: no geometry is distorted and no distance answer changes.
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

// Every coordinate sequence a geometry contributes: polygon rings, outer rings
// and holes alike (an island beach sits inside a hole and its nearest water is
// that hole's edge), and linestrings. Point and MultiPoint geometries are handled
// separately as degenerate zero-length segments, so a node-mapped water feature
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

// Chop one feature's geometry into segments and register them under featureIndex.
// Returns the number of indexed segments, for diagnostics. Malformed coordinates
// are skipped silently: layer bytes are upstream data.
//
// Each segment is read as the shorter of its two arcs: after wrapping both
// endpoints, an endpoint pair more than a half turn apart has the second moved
// by a full turn, so a way crossing the antimeridian is subdivided and indexed
// across the seam instead of around the globe.
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
      const ax = wrapLon(a[0]);
      let bx = wrapLon(b[0]);
      if (bx - ax > 180) {
        bx = bx - 360;
      } else if (bx - ax < -180) {
        bx = bx + 360;
      }
      added = added + addSubdividedSegment(builder, featureIndex, ax, a[1], bx, b[1]);
    }
  }
  for (const point of geometrySinglePoints(geometry)) {
    if (!Array.isArray(point) || !isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) {
      continue;
    }
    const x = wrapLon(point[0]);
    pushSegment(builder, featureIndex, x, point[1], x, point[1]);
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
    // Diagnostic counters, mutated by the query functions. The failure this
    // module prevents — a probe degenerating to a full scan — is invisible in a
    // correctness test and only shows up as a slow job hours later. A test can
    // assert segments-examined-per-probe directly, which is deterministic where
    // wall clock is not.
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

// The cheap rejection, in the probe's own short-arc frame: the endpoints become
// offsets from the probe, so a segment just across the seam sits at its true
// small offset and one on the far side of the globe at a large one.
function segmentBboxMiss(segs, index, lat, lon, latPad, lonPad) {
  const base = index * 4;
  const dax = lonOffsetDeg(segs[base], lon);
  const ay = segs[base + 1];
  const dbx = lonSegmentEndOffsetDeg(segs[base + 2], lon, dax);
  const by = segs[base + 3];
  const lonSlack = lonPad + SEGMENT_BBOX_EPSILON_DEG;
  const latSlack = latPad + SEGMENT_BBOX_EPSILON_DEG;
  if (Math.min(dax, dbx) - lonSlack > 0 || Math.max(dax, dbx) + lonSlack < 0) {
    return true;
  }
  if (lat < Math.min(ay, by) - latSlack || lat > Math.max(ay, by) + latSlack) {
    return true;
  }
  return false;
}

// Walk the cell neighbourhood of a probe point (lon already wrapped), handing
// each cell's segment index array to visit(). The neighbourhood is the padded
// query box widened by a full cell, and the pad is scaled by 1/cos(lat) on the
// longitude axis — that scaling is what makes this mode exact: every segment
// within maxKm of the point is provably inside the cells visited here. The
// longitude walk continues across the seam.
function visitSegmentCells(segGrid, lat, lon, latPad, lonPad, visit) {
  const cxLo = lonCellIndexFor(lon - lonPad) - 1;
  const cxHi = lonCellIndexFor(lon + lonPad) + 1;
  const cyLo = latCellIndexFor(lat - latPad) - 1;
  const cyHi = latCellIndexFor(lat + latPad) + 1;
  const spanX = lonCellSpan(cxLo, cxHi);
  let cx = wrapLonCell(cxLo);
  for (let k = 0; k < spanX; k = k + 1) {
    for (let cy = cyLo; cy <= cyHi; cy = cy + 1) {
      const bucket = segGrid.cells.get(cellKeyFor(cx, cy));
      if (bucket === undefined) {
        continue;
      }
      if (visit(bucket) === true) {
        return true;
      }
    }
    cx = nextLonCell(cx);
  }
  if (segGrid.oversized.length > 0) {
    return visit(segGrid.oversized) === true;
  }
  return false;
}

// True iff some indexed segment is within maxKm of (lat, lon). Only the padded
// cell neighbourhood is evaluated, and anySegmentWithinKm early-exits inside each
// cell's array: every probe here is a threshold question, never "how far
// exactly", so nothing needs the full minimum.
export function anySegmentWithinKmOfPoint(segGrid, lat, lon, maxKm) {
  if (segGrid === null || typeof segGrid !== "object" || segGrid.count === 0) {
    return false;
  }
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon) || !isFiniteNumber(maxKm) || maxKm < 0) {
    return false;
  }
  const qLon = wrapLon(lon);
  const latPad = maxKm / KM_PER_DEG;
  const lonPad = lonPadFor(lat, latPad);
  const segs = segGrid.segs;
  const stats = segGrid.stats;
  stats.probes = stats.probes + 1;
  return visitSegmentCells(segGrid, lat, qLon, latPad, lonPad, function (bucket) {
    stats.segmentsExamined = stats.segmentsExamined + bucket.length;
    return anySegmentWithinKm(segs, bucket, bucket.length, lat, qLon, maxKm);
  });
}

// The feature indices owning any segment within maxKm of any probe vertex,
// deduped, in ascending feature-index order: the callers' answers, nearbyLakeQids
// in particular, are order-sensitive and must not depend on which vertex found a
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
  // A one-element index window. anySegmentWithinKm is the single evaluator for
  // segment distance in this pipeline, and asking it about one segment at a time
  // is what lets an accepted feature short-circuit the hundreds of thousands of
  // remaining segments a lake ring owns.
  const single = new Int32Array(1);
  for (const vertex of vertices) {
    if (vertex === null || typeof vertex !== "object" ||
      !isFiniteNumber(vertex.lat) || !isFiniteNumber(vertex.lon)) {
      continue;
    }
    const lat = vertex.lat;
    const lon = wrapLon(vertex.lon);
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
      // Never short-circuit: this query wants every owning feature, not the
      // first one, so the visitor always reports "keep going".
      return false;
    });
  }
  out.sort(ascending);
  return out;
}
