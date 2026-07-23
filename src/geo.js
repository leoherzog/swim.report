// src/geo.js
// Dependency-free geographic helpers shared across the worker. This module
// imports nothing from the rest of src/, so importing it can never create a
// circular dependency — which is why the official-source scrapers (registered
// into src/officialSources/index.js) can pull their distance math from here
// instead of copy-pasting a local haversine to dodge a cycle.
//
// Pure: no fetch, no Date, no I/O. Safe on both the request and cron paths.

// Great Lakes / CONUS distance math uses a spherical earth. The kilometre
// radius (6371 km) and the mile-per-kilometre ratio below are carried over
// from the pre-consolidation copies (which paired 6371 km with a 3958.8 mi
// radius) so distances stay numerically identical to the originals.
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
// Planar math is fine at forecast-region scale; boundary points are accepted
// or rejected by the crossing parity like any ray cast (no special casing).
function pointInRing(lon, lat, ring) {
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

// True when the point sits inside a GeoJSON Polygon or MultiPolygon geometry:
// inside an outer ring and inside none of that polygon's holes. Malformed or
// non-areal geometry (null, Point, missing coordinates) returns false — the
// caller treats "not contained" as "no match", never as an error. Used by the
// ECCC alerts client to match beaches to alert-region polygons.
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
