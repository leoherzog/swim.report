// src/mapFeatures.js — one GeoJSON Feature per beach_state JOIN row, for
// /api/beaches.geojson (PLAN.md sections 1 and 8).
//
// Pure: no fetch, no Date, no env. The row carries the estimate's and the
// official's color, updated stamp and expiry as scalar columns, and the marker
// keyword is displayFlag's, the one decision every surface that shows a beach's
// flag makes, so no two surfaces can disagree about one beach.
//
// Each record honors its own *_expires: an expired estimate reads as null
// without dropping a live official beside it, and the reverse. The expiry rule
// itself lives in src/beachState.js, so the map and the list surfaces cut a
// record off at the same instant.
import { displayFlag } from "./displayFlag.js";
import { liveChipState } from "./beachState.js";

// One Feature from a row of the geojson SELECT, or null when the coordinates are
// not finite — those rows are dropped rather than emitted as NaN geometry. name
// is the feature label: the containing park name when there is one.
//
// nowMs is the same instant as nowIso, passed by a caller that already has it so
// the per-row loop parses nothing; omitting it derives the instant from nowIso,
// which is what keeps the two arguments from naming different clocks.
export function mapFeatureFromRow(row, nowIso, nowMs) {
  if (!row) {
    return null;
  }
  const lat = (row.lat === null || row.lat === undefined) ? NaN : Number(row.lat);
  const lon = (row.lon === null || row.lon === undefined) ? NaN : Number(row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  const instantMs = (typeof nowMs === "number" && Number.isFinite(nowMs))
    ? nowMs
    : Date.parse(nowIso);
  const state = liveChipState(row, instantMs);
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      id: row.id,
      name: row.park_name || row.name || "",
      flag: displayFlag(state, nowIso).keyword
    }
  };
}
