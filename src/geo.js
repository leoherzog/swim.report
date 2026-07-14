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
