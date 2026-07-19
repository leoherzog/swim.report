// Discovery merge logic — the pure, dependency-light half of runOverpassSync.
//
// Extracted from src/index.js so BOTH the in-Worker cron (src/index.js) and the
// offline batch discovery job (scripts/discovery-batch.js, run from GitHub
// Actions on Deno) import the SAME merge/park-association/unnamed-suffix logic
// instead of forking it. This module imports ONLY src/geo.js (itself
// dependency-free), so it carries no Worker-only baggage and is safe to import
// from a plain Deno/Node process — the same reuse pattern src/geo.js established
// for the distance/units math.
//
// Pure: no fetch, no Date, no env. String concatenation with + only (never
// template literals), const/let only — the project style rules apply here too.

import { distanceKm, toRadians } from "./geo.js";

// Eight-point compass labels, indexed by round(bearing / 45) with bearing in
// degrees clockwise from due north.
const COMPASS_POINTS = [
  "North", "Northeast", "East", "Southeast",
  "South", "Southwest", "West", "Northwest"
];

// Two unnamed beaches in the same park must be at least this far apart before
// we distinguish them by compass direction. Polygons a few dozen metres apart
// are effectively the same spot, and a direction label there would be noise,
// not signal — those fall back to keeping the largest only.
const COMPASS_MIN_SEPARATION_KM = 0.2;

// Initial bearing (degrees, 0 = north, clockwise) from one point to another,
// mapped to its eight-point compass label.
function compassDirection(fromLat, fromLon, toLat, toLon) {
  const dLon = toRadians(toLon - fromLon);
  const y = Math.sin(dLon) * Math.cos(toRadians(toLat));
  const x = Math.cos(toRadians(fromLat)) * Math.sin(toRadians(toLat)) -
    Math.sin(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.cos(dLon);
  const brng = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return COMPASS_POINTS[Math.round(brng / 45) % 8];
}

// Derive a human-meaningful suffix that distinguishes a secondary unnamed beach
// from the park's largest ("primary") unnamed beach, in priority order:
//   (a) a water-body / locality name carried on the beach element's OWN OSM
//       tags — the optional string beach.locality, populated by the Overpass
//       client (parseParkBeachElements) from the element's loc_name tag;
//   (b) a compass-direction label relative to the primary beach, but only when
//       the two are clearly separated (>= COMPASS_MIN_SEPARATION_KM);
//   (c) null — no meaningful distinction is derivable, so the caller keeps the
//       largest only (previous behavior).
// Never returns a label that implies official signage — (b) yields plain
// wayfinding like "East Beach", not an official beach name.
function deriveUnnamedSuffix(beach, primary) {
  if (typeof beach.locality === "string" && beach.locality.trim() !== "") {
    return beach.locality.trim();
  }
  const km = distanceKm(primary.lat, primary.lon, beach.lat, beach.lon);
  if (km >= COMPASS_MIN_SEPARATION_KM) {
    return compassDirection(primary.lat, primary.lon, beach.lat, beach.lon) + " Beach";
  }
  return null;
}

// Adds an unnamed-origin park beach row whose display name AND park_name are
// both displayName. Unnamed-origin rows are identified downstream (render's
// park-name-first treatment, the sync's stale-row reconciliation) by
// name === park_name, so both fields must carry the same value — whether it is
// the plain park name (the primary row) or "<Park> — <suffix>" (a distinguished
// secondary). The !has guard mirrors the named path: a pre-existing row wins.
function addUnnamedParkRow(byId, beach, displayName) {
  const id = "osm-" + beach.osmType + "-" + String(beach.osmId);
  if (!byId.has(id)) {
    byId.set(id, {
      id: id,
      name: displayName,
      lat: beach.lat,
      lon: beach.lon,
      osmId: beach.osmType + "/" + String(beach.osmId),
      parkName: displayName
    });
  }
}

// Pure; exported for tests. Merges the named-beach rows with the
// park-contained beaches (which include unnamed elements):
// - a named beach inside a park gains that park's name as parkName;
// - unnamed beaches are kept only when a park was associated. The LARGEST (by
//   bounding-box area) unnamed beach per park keeps the park's name as
//   its display name (its id and name derivation are unchanged — existing KV
//   flags key off beach id). Each ADDITIONAL unnamed beach is kept only when
//   deriveUnnamedSuffix produces a distinct, human-meaningful label; that row's
//   display name (and park_name) becomes "<Park> — <suffix>" so no two rows are
//   indistinguishable. Beaches with no derivable distinction — or one that
//   collides with a sibling already kept — fall back to skipped (counted in
//   skippedUnnamed), preserving the previous largest-only behavior.
// Returns { rows: [{ id, name, lat, lon, osmId, parkName }], skippedUnnamed }.
export function mergeBeachRows(namedRows, parkBeaches) {
  const byId = new Map();
  for (const row of namedRows) {
    const id = "osm-" + row.osmType + "-" + String(row.osmId);
    byId.set(id, {
      id: id,
      name: row.name,
      lat: row.lat,
      lon: row.lon,
      osmId: row.osmType + "/" + String(row.osmId),
      parkName: null
    });
  }

  let skippedUnnamed = 0;
  const unnamedByPark = new Map();
  for (const beach of parkBeaches) {
    const id = "osm-" + beach.osmType + "-" + String(beach.osmId);
    if (beach.name) {
      const existing = byId.get(id);
      if (existing) {
        existing.parkName = beach.parkName;
      } else {
        byId.set(id, {
          id: id,
          name: beach.name,
          lat: beach.lat,
          lon: beach.lon,
          osmId: beach.osmType + "/" + String(beach.osmId),
          parkName: beach.parkName
        });
      }
      continue;
    }
    if (beach.parkName === null || beach.parkKey === null) {
      skippedUnnamed = skippedUnnamed + 1;
      continue;
    }
    if (!unnamedByPark.has(beach.parkKey)) {
      unnamedByPark.set(beach.parkKey, []);
    }
    unnamedByPark.get(beach.parkKey).push(beach);
  }

  for (const group of unnamedByPark.values()) {
    // Primary = largest by bbox area, first-seen winning ties (matches the
    // previous single-row policy exactly so its id/name — and its KV flag —
    // stay stable).
    let primary = group[0];
    for (const beach of group) {
      if (beach.areaDeg2 > primary.areaDeg2) {
        primary = beach;
      }
    }
    const usedNames = new Set();
    addUnnamedParkRow(byId, primary, primary.parkName);
    usedNames.add(primary.parkName);
    for (const beach of group) {
      if (beach === primary) {
        continue;
      }
      const suffix = deriveUnnamedSuffix(beach, primary);
      if (suffix === null) {
        skippedUnnamed = skippedUnnamed + 1;
        continue;
      }
      const displayName = primary.parkName + " — " + suffix;
      if (usedNames.has(displayName)) {
        // Another sibling already claimed this exact label (e.g. two beaches in
        // the same compass direction) — keeping both would be indistinguishable.
        skippedUnnamed = skippedUnnamed + 1;
        continue;
      }
      usedNames.add(displayName);
      addUnnamedParkRow(byId, beach, displayName);
    }
  }

  return { rows: Array.from(byId.values()), skippedUnnamed: skippedUnnamed };
}
