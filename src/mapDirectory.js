// src/mapDirectory.js — the precomputed map directory: the value shape both
// beach-touching crons build into "mapdirectory:v1" and the resolution the
// request path applies when it reads that key back (PLAN.md sections 1 and 3).
//
// Pure: no fetch, no Date, no env. It stores INGREDIENTS — each beach's standing
// estimate color and the official record's color, with their timestamps — and
// never a baked marker color. displayFlagColor (frontend/render.js) is
// raise-only in time: while the official record is fresher than STALE_MS it wins
// outright, and past that the gate becomes worst-of, which is never lower. So a
// build-time evaluation can only under-report, and it would split one color rule
// between the map marker and the detail page's title flag, which render.js's own
// contract forbids. markerFlagColor is called here, unchanged, at read time.
//
// Standing precondition for the read-time resolution below: no registered
// scraper declares officialTtlSeconds, so an official key's lease is never
// longer than its paired estimate's. If one ever declares a LONGER one, this
// artifact must start carrying the official's own expiry instant, because it
// infers the pair's expiry from the estimate's updated alone.
import { markerFlagColor } from "./frontend/render.js";
import { FLAG_TTL_MS } from "./flagTtl.js";

export const MAP_DIRECTORY_KEY = "mapdirectory:v1";
export const MAP_DIRECTORY_VERSION = 1;
// Three times the hourly build period, so two consecutive dead hourly builds are
// tolerated before the endpoint falls to its degraded all-unknown branch.
export const MAP_DIRECTORY_TTL_SECONDS = 10800;

function colorOf(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  return typeof record.color === "string" ? record.color : null;
}

function updatedOf(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  return typeof record.updated === "string" ? record.updated : null;
}

// One directory entry from a beach row plus the two KV records standing for it,
// either of which may be null. Returns null for a row whose coordinates are not
// finite — those rows are dropped rather than emitted as NaN geometry, exactly
// as the endpoint has always dropped them. name mirrors the feature label the
// endpoint has always emitted: the containing park name when there is one.
export function mapDirectoryEntry(row, estimate, official) {
  const lat = (row.lat === null || row.lat === undefined) ? NaN : Number(row.lat);
  const lon = (row.lon === null || row.lon === undefined) ? NaN : Number(row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return {
    id: row.id,
    name: row.park_name || row.name || "",
    lon: lon,
    lat: lat,
    estColor: colorOf(estimate),
    estUpdated: updatedOf(estimate),
    offColor: colorOf(official),
    offUpdated: updatedOf(official)
  };
}

export function buildMapDirectory(entries, builtAtIso) {
  return {
    v: MAP_DIRECTORY_VERSION,
    builtAt: builtAtIso,
    count: entries.length,
    entries: entries
  };
}

// Resolves a directory into GeoJSON Features against one nowIso, through the
// same markerFlagColor the detail page's title flag resolves through, so the two
// surfaces can never disagree about a beach. Returns [] for a null, malformed or
// version-mismatched directory; the caller serves its degraded branch instead.
//
// Two reconstructions happen here, and both are one-directional by design:
//
// The estimate carries an expiry check because it is exact for both writers. The
// key is written with expirationTtl FLAG_TTL_SECONDS against the same updated
// the value echoes, so an age at or past FLAG_TTL_MS reproduces KV expiry rather
// than papering over it, and the map reaches "unknown" at the instant the detail
// page does.
//
// The official carries no expiry check of its own, and that is a safety
// requirement. An official record legitimately carries an updated far older
// than its write time — a morning beach observation posted once a day — so an
// age check would drop live officials, handing the marker the estimate's color
// where the live path returns worst-of, which is never lower. Dropping an
// official lowers. It is dropped only together with a provably expired estimate,
// which closes the one case that would otherwise render a colour where the live
// path renders unknown.
export function mapDirectoryFeatures(directory, nowIso) {
  if (!directory || typeof directory !== "object" ||
      directory.v !== MAP_DIRECTORY_VERSION || !Array.isArray(directory.entries)) {
    return [];
  }
  const nowMs = Date.parse(nowIso);
  // Two scratch records reused across every entry: markerFlagColor reads them
  // synchronously and keeps no reference, so one allocation pair serves the
  // whole directory.
  const scratchEst = { color: null, updated: null };
  const scratchOff = { color: null, updated: null };
  const features = [];
  for (let i = 0; i < directory.entries.length; i = i + 1) {
    const entry = directory.entries[i];
    if (!entry) {
      continue;
    }
    const estUpdated = entry.estUpdated === undefined ? null : entry.estUpdated;
    const estColor = entry.estColor === undefined ? null : entry.estColor;
    const offColor = entry.offColor === undefined ? null : entry.offColor;
    const estAgeMs = estUpdated === null ? null : (nowMs - Date.parse(estUpdated));
    const estimateExpired = estAgeMs !== null && !Number.isNaN(estAgeMs) && estAgeMs >= FLAG_TTL_MS;
    let estimate = null;
    let official = null;
    if (!estimateExpired) {
      if (estColor !== null) {
        scratchEst.color = estColor;
        scratchEst.updated = estUpdated;
        estimate = scratchEst;
      }
      if (offColor !== null) {
        scratchOff.color = offColor;
        scratchOff.updated = entry.offUpdated === undefined ? null : entry.offUpdated;
        official = scratchOff;
      }
    }
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [entry.lon, entry.lat] },
      properties: {
        id: entry.id,
        name: entry.name,
        flag: markerFlagColor(estimate, official, nowIso)
      }
    });
  }
  return features;
}
