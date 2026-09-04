// src/geo.js — dependency-free geographic helpers. It imports nothing else from
// src/, so importing it can never create a circular dependency, which is why the
// official-source scrapers can pull their distance math from here instead of
// copy-pasting a local haversine to dodge a cycle.
//
// Pure: no fetch, no Date, no I/O. Safe on both the request and cron paths.

// Spherical earth. The kilometre radius and the mile-per-kilometre ratio below
// pair 6371 km with a 3958.8 mi radius.
const EARTH_RADIUS_KM = 6371;
const MI_PER_KM = 3958.8 / 6371;
const METERS_TO_FEET = 3.28084;

export function toRadians(deg) {
  return deg * Math.PI / 180;
}

// Great-circle (haversine) distance in kilometres between two lat/lon points.
export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Great-circle distance in statute miles, derived from distanceKm.
export function distanceMi(lat1, lon1, lat2, lon2) {
  return distanceKm(lat1, lon1, lat2, lon2) * MI_PER_KM;
}

// Metres -> feet. Null-safe: null/undefined pass through as null (matching the
// masked/no-data convention used across the wave clients).
export function metersToFeet(m) {
  if (m === null || m === undefined) {
    return null;
  }
  return m * METERS_TO_FEET;
}

// Celsius -> Fahrenheit. Null-safe: null/undefined pass through as null (matching
// the masked/no-data convention used across the buoy clients — e.g. NDBC water
// temperature, whose missing token already resolves to null before conversion).
export function celsiusToFahrenheit(c) {
  if (c === null || c === undefined) {
    return null;
  }
  return c * 9 / 5 + 32;
}

// Ray-casting point-in-ring test on a GeoJSON linear ring ([[lon, lat], ...]).
// Planar math is fine at forecast-region scale, and boundary points are accepted
// or rejected by the crossing parity like any ray cast. Exported for
// scripts/build-marine-zones.js, whose hole-grouping pass needs the same planar
// ray cast.
export function pointInRing(lon, lat, ring) {
  let inside = false;
  let j = ring.length - 1;
  for (let i = 0; i < ring.length; i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const crosses = (yi > lat) !== (yj > lat) &&
      lon < (xj - xi) * (lat - yi) / (yj - yi) + xi;
    if (crosses) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

// True when the point sits inside a GeoJSON Polygon or MultiPolygon: inside an
// outer ring and inside none of that polygon's holes. Malformed or non-areal
// geometry returns false, and the caller treats "not contained" as "no match"
// rather than an error.
export function pointInGeometry(geometry, lat, lon) {
  if (geometry === null || typeof geometry !== "object") {
    return false;
  }
  let polygons = null;
  if (geometry.type === "Polygon") {
    polygons = [geometry.coordinates];
  } else if (geometry.type === "MultiPolygon") {
    polygons = geometry.coordinates;
  } else {
    return false;
  }
  if (!Array.isArray(polygons)) {
    return false;
  }
  for (const rings of polygons) {
    if (!Array.isArray(rings) || rings.length === 0 || !Array.isArray(rings[0])) {
      continue;
    }
    if (!pointInRing(lon, lat, rings[0])) {
      continue;
    }
    let inHole = false;
    for (let h = 1; h < rings.length; h++) {
      if (Array.isArray(rings[h]) && pointInRing(lon, lat, rings[h])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) {
      return true;
    }
  }
  return false;
}

// Kilometres per degree of latitude, and of longitude at the equator, on the
// spherical earth used above. Shared by every nearest-edge consumer so the value
// cannot drift between them.
export const KM_PER_DEG = 111.195;

// GeoJSON Polygon/MultiPolygon -> array of polygons (each an array of rings).
// Anything else (malformed, other types) -> [] so callers skip it.
export function geometryPolygons(geometry) {
  if (geometry === null || typeof geometry !== "object" || !Array.isArray(geometry.coordinates)) {
    return [];
  }
  if (geometry.type === "Polygon") {
    return [geometry.coordinates];
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates;
  }
  return [];
}

// Distance (km) from the origin (the point, already projected to 0,0 in a local
// equirectangular projection) to the segment a-b. The projection error is
// negligible at the <= 15 km leniency caps the callers apply.
export function pointToSegmentKm(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    // Project the origin onto the segment, clamped to [0, 1].
    t = -(ax * dx + ay * dy) / len2;
    if (t < 0) { t = 0; }
    if (t > 1) { t = 1; }
  }
  const px = ax + t * dx;
  const py = ay + t * dy;
  return Math.sqrt(px * px + py * py);
}

// Minimum distance in km from (lat, lon) to any ring edge of the geometry, outer
// rings and holes alike: an island beach sits inside a hole of a marine polygon
// and resolves via the nearest hole edge. Malformed rings and points are skipped,
// never thrown on, since GeoMet responses are upstream input. Returns Infinity
// when no usable edge exists. The per-caller distance cap stays at the call site;
// this returns a raw distance.
export function minEdgeDistanceKm(geometry, lat, lon) {
  const cosLat = Math.cos(lat * Math.PI / 180);
  let best = Infinity;
  for (const polygon of geometryPolygons(geometry)) {
    if (!Array.isArray(polygon)) {
      continue;
    }
    for (const ring of polygon) {
      if (!Array.isArray(ring)) {
        continue;
      }
      for (let i = 0; i < ring.length - 1; i = i + 1) {
        const a = ring[i];
        const b = ring[i + 1];
        if (!Array.isArray(a) || !Array.isArray(b) ||
            typeof a[0] !== "number" || typeof a[1] !== "number" ||
            typeof b[0] !== "number" || typeof b[1] !== "number") {
          continue;
        }
        const ax = (a[0] - lon) * cosLat * KM_PER_DEG;
        const ay = (a[1] - lat) * KM_PER_DEG;
        const bx = (b[0] - lon) * cosLat * KM_PER_DEG;
        const by = (b[1] - lat) * KM_PER_DEG;
        const d = pointToSegmentKm(ax, ay, bx, by);
        if (d < best) { best = d; }
      }
    }
  }
  return best;
}

// GeoJSON LineString/MultiLineString -> array of point arrays (each an array of
// [lon, lat] positions). Anything else -> [] so callers skip it.
//
// Deliberately a sibling of geometryPolygons rather than an extension: teaching
// geometryPolygons about lines would make pointInGeometry treat an open line as a
// closed ring, and a ray cast against an unclosed line answers a question nobody
// asked. Keeping them apart leaves pointInGeometry and minEdgeDistanceKm
// unaffected by line support.
//
// It exists because minEdgeDistanceKm returns Infinity for a LineString,
// silently, since geometryPolygons returns [] for one. The OSM coastline layer is
// predominantly LineString, so a nearest-shore probe routed through the
// polygon-only path would report "no coastline anywhere" for every ocean beach on
// earth.
export function geometryLines(geometry) {
  if (geometry === null || typeof geometry !== "object" || !Array.isArray(geometry.coordinates)) {
    return [];
  }
  if (geometry.type === "LineString") {
    return [geometry.coordinates];
  }
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates;
  }
  return [];
}

// Minimum distance in km from the local-planar origin to any vertex in a list of
// [lon, lat] positions. Shared by the line and point branches of
// minGeometryDistanceKm; malformed positions are skipped, never thrown on.
function minPositionsDistanceKm(positions, lat, lon, cosLat, asLine) {
  if (!Array.isArray(positions)) {
    return Infinity;
  }
  let best = Infinity;
  // A line of N positions has N-1 segments; a bag of points has N vertices. The
  // loop below handles both by treating a vertex as a degenerate segment from the
  // position to itself, which pointToSegmentKm evaluates correctly (len2 === 0
  // keeps t at 0, giving the distance to the point itself).
  const last = asLine ? positions.length - 1 : positions.length;
  for (let i = 0; i < last; i = i + 1) {
    const a = positions[i];
    const b = asLine ? positions[i + 1] : a;
    if (!Array.isArray(a) || !Array.isArray(b) ||
        typeof a[0] !== "number" || typeof a[1] !== "number" ||
        typeof b[0] !== "number" || typeof b[1] !== "number") {
      continue;
    }
    const ax = (a[0] - lon) * cosLat * KM_PER_DEG;
    const ay = (a[1] - lat) * KM_PER_DEG;
    const bx = (b[0] - lon) * cosLat * KM_PER_DEG;
    const by = (b[1] - lat) * KM_PER_DEG;
    const d = pointToSegmentKm(ax, ay, bx, by);
    if (d < best) { best = d; }
  }
  return best;
}

// Minimum distance in km from (lat, lon) to any geometry type: polygon and
// multipolygon ring edges (delegating to minEdgeDistanceKm), linestring and
// multilinestring segments, point and multipoint vertices, and a
// GeometryCollection's members — the coastline layer mixes open ways with closed
// island ways, so a caller handed one geometry cannot assume a family. Returns
// Infinity when no usable geometry exists; malformed input is skipped.
//
// No cap is applied: the caller owns the radius. Every branch uses the same local
// equirectangular frame anchored at (lat, lon) that minEdgeDistanceKm uses, so
// distances stay comparable across geometry families and against the segment
// grid, which is planar too. Haversine for the point branch would be marginally
// more accurate and would make a mixed-geometry minimum a comparison between two
// metrics.
//
// For diagnostics, tests and small geometries only. The hot probe path goes
// through the segment grid (src/layerGrid.js), which never touches whole
// geometries: this function iterates every edge with no radius short-circuit,
// correct at marine-zone scale and catastrophic against a lakes layer of ~3e6
// vertices probed once per beach vertex.
export function minGeometryDistanceKm(geometry, lat, lon) {
  if (geometry === null || typeof geometry !== "object") {
    return Infinity;
  }
  const cosLat = Math.cos(lat * Math.PI / 180);
  let best = minEdgeDistanceKm(geometry, lat, lon);
  for (const line of geometryLines(geometry)) {
    const d = minPositionsDistanceKm(line, lat, lon, cosLat, true);
    if (d < best) { best = d; }
  }
  if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
    const d = minPositionsDistanceKm([geometry.coordinates], lat, lon, cosLat, false);
    if (d < best) { best = d; }
  } else if (geometry.type === "MultiPoint" && Array.isArray(geometry.coordinates)) {
    const d = minPositionsDistanceKm(geometry.coordinates, lat, lon, cosLat, false);
    if (d < best) { best = d; }
  } else if (geometry.type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
    for (const member of geometry.geometries) {
      const d = minGeometryDistanceKm(member, lat, lon);
      if (d < best) { best = d; }
    }
  }
  return best;
}

// Point-to-segment distance in the same local-planar frame minEdgeDistanceKm
// uses, over a packed segment buffer rather than a GeoJSON structure. This is
// what the segment grid (src/layerGrid.js) evaluates.
//
//   segs:  Float64Array of [ax, ay, bx, by, ...] in degrees — each group of four
//          is one segment as two (lon, lat) pairs, so segment s occupies
//          segs[4*s] .. segs[4*s + 3].
//   idx:   Int32Array (or any indexable) of segment indices to evaluate, as
//          handed back by the grid's cell neighbourhood.
//   count: how many entries of idx are live; the grid's arrays grow in blocks, so
//          idx.length is not the answer.
//
// Returns true as soon as some segment is within maxKm, false if none is. The
// early exit is the point: every probe in this pipeline is a threshold question,
// never "how far exactly", and answering on the first hit rather than scanning
// every candidate is the difference between a build that finishes and one that
// does not.
export function anySegmentWithinKm(segs, idx, count, lat, lon, maxKm) {
  if (!segs || !idx || !(count > 0) || !(maxKm >= 0)) {
    return false;
  }
  const cosLat = Math.cos(lat * Math.PI / 180);
  for (let i = 0; i < count; i = i + 1) {
    const s = idx[i];
    const base = s * 4;
    // Defensive bounds guard: the grid owns idx and segs together, so an
    // out-of-range entry means a builder bug, not bad data. Skipping keeps a
    // corrupt index from throwing mid-probe and taking down a whole build.
    if (!(s >= 0) || base + 3 >= segs.length) {
      continue;
    }
    const ax = (segs[base] - lon) * cosLat * KM_PER_DEG;
    const ay = (segs[base + 1] - lat) * KM_PER_DEG;
    const bx = (segs[base + 2] - lon) * cosLat * KM_PER_DEG;
    const by = (segs[base + 3] - lat) * KM_PER_DEG;
    // No cheap axis-aligned pre-reject here, deliberately. The obvious one —
    // both endpoints beyond maxKm on the same axis, so skip — is mathematically
    // sound but not bit-exact against pointToSegmentKm, whose
    // sqrt(px*px + py*py) round-trip can land an ulp below the raw coordinate it
    // came from: an endpoint at exactly -maxKm is rejected by the comparison
    // while the sqrt reports <= maxKm. Exactness is worth more than the saved
    // multiply, because the safety argument for this evaluator is that it answers
    // bit-for-bit the same threshold question as
    // minGeometryDistanceKm(geometry, lat, lon) <= maxKm, which the cross-check
    // test asserts. Pruning is the grid's job; this function only ever sees one
    // cell neighbourhood's worth of segments.
    if (pointToSegmentKm(ax, ay, bx, by) <= maxKm) {
      return true;
    }
  }
  return false;
}
