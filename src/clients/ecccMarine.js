// src/clients/ecccMarine.js
// [experimental] ECCC MSC GeoMet marine-warnings client — the marine-weather
// counterpart to the land weather-alerts path in src/clients/eccc.js, for the
// Great Lakes beaches on the Canadian shoreline that api.weather.gov 404s.
//
// KIND: eccc-marine (fetch + parse ONLY). This module does the network fetch
// and a pure defensive parse; it does NOT decide a flag color. It will be wired
// into the ECCC alert path for Canadian beaches at integration time, feeding the
// SAME alerts[] / alertDetails input estimateFlag already consumes (via
// ecccMarineAlertsForPoint) — NOT a parallel input.
//
// SOURCE: GET https://api.weather.gc.ca/collections/marineweather-realtime/items
//   ?f=json  (send ECCC_USER_AGENT from ./eccc.js). Returns a GeoJSON
//   FeatureCollection (~204 features). Each Feature is one per-zone Polygon:
//     - geometry: Polygon / MultiPolygon (the marine zone, over WATER)
//     - properties.area.region.en  e.g. "Great Lakes" / "St. Lawrence"
//     - properties.area.value.en   e.g. "Lake Erie"
//     - properties.lastUpdated     ISO timestamp (feature level; used as onset)
//     - properties.warnings.locations[] { name.en, events[] }
//         events[] = { name.en, type.en, category.en (=="marine"),
//                      status.en ("IN EFFECT" / "CONTINUED" / "ENDED") }
//   Marine events carry NO per-event datetime — only a status — so active vs
//   ended is authoritative (we keep IN EFFECT / CONTINUED, drop ENDED). We
//   scope to Great Lakes marine warnings only (area.region.en == "Great Lakes",
//   event category.en == "marine").
//
// COLOR / FLOOR MAPPING the rules layer will use (exported here as
// MARINE_EVENT_COLOR_MAP / marineEventColor for the integrator + tests; this
// module NEVER applies it — src/rules.js is the single source of color):
//     storm warning            -> double-red   (marine >=48kt; DISTINCT from the
//                                                land "storm surge warning")
//     gale warning             -> red
//     squall warning           -> red
//     waterspout warning       -> red
//     strong wind warning      -> yellow  (FLOOR — raise-only, like nws-floor)
//     marine weather advisory  -> yellow  (FLOOR)
//     everything else (all watches, "special ice warning", unknown) -> null
//                                                (UNMAPPED — safe-fail no-op)
// ECCC serves land alert names lowercase; marine name.en arrives Title-cased
// ("Gale warning"), so every event name is lowercased here to match the
// lowercase keys rules.js keys on — a wrong/unknown string maps to null (no
// floor), never a wrong color.
//
// INTEGRATOR DEDUP NOTE: verified DISJOINT from src/clients/eccc.js
// fetchActiveEcccAlerts (the land weather-alerts collection carries ZERO marine
// warnings), so this adds new signal for Canadian beaches, not duplicates. Do
// NOT also try to pull marine warnings out of the land weather-alerts
// collection. Feeds the same alerts[] input — concat marine matches onto the
// land matches in the Canadian-beach branch, exactly as the US branch concats
// marine onto land.
//
// Cron-side ONLY (two-path rule): nothing in src/router.js or
// src/frontend/render.js may reach this module. Every function returns
// data-or-null and NEVER throws across the module boundary.

import { fetchJson } from "./http.js";
import { pointInGeometry } from "../geo.js";
import { ECCC_API_BASE, ECCC_USER_AGENT } from "./eccc.js";

// The marine-realtime collection carrying per-zone Gale/Storm/Strong-wind
// warning Polygons. Confirmed live 2026-07 against the GeoMet catalog.
export const ECCC_MARINE_COLLECTION = "marineweather-realtime";

// Human-readable marine-forecast page for source { url } entries shown to
// visitors (reuses ECCC's public marine index).
export const ECCC_MARINE_INFO_URL = "https://weather.gc.ca/marine/index_e.html";

// Only Great Lakes marine zones are in scope for this product.
export const ECCC_MARINE_GREAT_LAKES_REGION = "Great Lakes";

// Nearest-edge leniency cap for ecccMarineAlertsForPoint's fallback. Marine
// polygons cover WATER while beach points sit on LAND, so pure PIP
// under-matches — a beach's adjacent marine zone can be up to ~15 km offshore
// (matches src/marineZones.js MARINE_ZONE_MAX_DISTANCE_KM).
export const ECCC_MARINE_MAX_EDGE_KM = 15;

// Feature-page items cap. The whole collection is ~204 features, so 2000
// leaves ample headroom for one page to suffice (pygeoapi clamps an over-max
// limit rather than erroring); a page that comes back exactly full logs a
// truncation warning below. Mirrors eccc.js's fetch-limit handling.
const ECCC_MARINE_FETCH_LIMIT = 2000;

// The active-status set. Marine events expose only a status word (no per-event
// datetime), so this is the authoritative active/ended signal. Fail CLOSED:
// only these explicit strings are treated as active — anything else (ENDED,
// missing, an unrecognized future status) is dropped, so a stale/ended warning
// can never be surfaced as a live one. Compared upper-cased.
const ACTIVE_STATUSES = { "IN EFFECT": true, "CONTINUED": true };

// The rules-layer color mapping (see header). Exported for the integrator and
// tests; NOT applied in this module. Keys are lowercase to match rules.js.
export const MARINE_EVENT_COLOR_MAP = {
  "storm warning": "double-red",
  "gale warning": "red",
  "squall warning": "red",
  "waterspout warning": "red",
  "strong wind warning": "yellow",
  "marine weather advisory": "yellow"
};

// The two events that map to a YELLOW FLOOR (raise-only), as opposed to a
// hazard-lane short-circuit. Exported so the integrator can fold them into
// rules.js ECCC_FLOOR_PRECEDENCE without re-deriving the split.
export const MARINE_FLOOR_EVENTS = ["strong wind warning", "marine weather advisory"];

// Pure. Maps a marine event name to its intended flag color, or null when the
// event is deliberately UNMAPPED (all watches, "special ice warning", unknown).
// Uses an explicit allowlist (own-property lookup), never a prototype-chain
// membership test, and lowercases defensively. Never throws.
export function marineEventColor(name) {
  if (typeof name !== "string" || name.length === 0) {
    return null;
  }
  const key = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MARINE_EVENT_COLOR_MAP, key)) {
    return MARINE_EVENT_COLOR_MAP[key];
  }
  return null;
}

// First non-empty string, else null.
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Reads the deep .en string off a { en, fr } localized object, else null.
function localizedEn(obj) {
  if (obj === null || typeof obj !== "object") {
    return null;
  }
  return nonEmptyString(obj.en);
}

// Pure, exported for tests. Given a raw GeoMet FeatureCollection JSON and
// nowIso, returns the ACTIVE Great Lakes marine warnings as a flat alerts
// array in the SAME shape as fetchActiveEcccAlerts's alerts entries:
//   [{ event, onset, ends, geometry, region, value }]
// where event = the LOWERCASED event name (e.g. "gale warning"), onset =
// properties.lastUpdated (marine events carry no per-event onset) falling back
// to nowIso, ends = null (no per-event expiry — active/ended is by status),
// geometry = the zone Polygon, and region/value ride along for provenance
// (estimateFlag ignores them; it consumes only event/onset/ends via
// ecccMarineAlertsForPoint). One entry is emitted per active event per zone.
//
// Only Great Lakes (area.region.en == "Great Lakes") features with an areal
// geometry are considered; only marine-category events with an active status
// are kept. A feature/event that cannot be understood is SKIPPED, never
// guessed. Returns null ONLY when the top-level payload is unusable (not an
// object / no features array); an all-clear collection returns [].
export function parseEcccMarineAlerts(json, nowIso) {
  if (json === null || typeof json !== "object") {
    return null;
  }
  const features = Array.isArray(json.features) ? json.features : null;
  if (features === null) {
    return null;
  }
  if (features.length >= ECCC_MARINE_FETCH_LIMIT) {
    console.log(
      "ecccMarine: fetch returned " + String(features.length) +
      " features at the " + String(ECCC_MARINE_FETCH_LIMIT) +
      " limit — result may be truncated"
    );
  }
  const fallbackOnset = nonEmptyString(nowIso);
  const alerts = [];
  for (const feature of features) {
    if (feature === null || typeof feature !== "object") {
      continue;
    }
    const props = feature.properties;
    if (props === null || typeof props !== "object") {
      continue;
    }
    const area = props.area;
    if (area === null || typeof area !== "object") {
      continue;
    }
    const region = localizedEn(area.region);
    if (region !== ECCC_MARINE_GREAT_LAKES_REGION) {
      continue;
    }
    const geometry = feature.geometry;
    if (geometry === null || typeof geometry !== "object") {
      continue;
    }
    const value = localizedEn(area.value);
    const onset = nonEmptyString(props.lastUpdated) !== null
      ? props.lastUpdated
      : fallbackOnset;
    const warnings = props.warnings;
    const locations = warnings !== null && typeof warnings === "object" && Array.isArray(warnings.locations)
      ? warnings.locations
      : [];
    for (const location of locations) {
      if (location === null || typeof location !== "object" || !Array.isArray(location.events)) {
        continue;
      }
      for (const event of location.events) {
        if (event === null || typeof event !== "object") {
          continue;
        }
        const category = localizedEn(event.category);
        if (category !== "marine") {
          continue;
        }
        const status = localizedEn(event.status);
        if (status === null || ACTIVE_STATUSES[status.toUpperCase()] !== true) {
          continue;
        }
        const rawName = localizedEn(event.name);
        if (rawName === null) {
          continue;
        }
        alerts.push({
          event: rawName.toLowerCase(),
          onset: onset,
          ends: null,
          geometry: geometry,
          region: region,
          value: value
        });
      }
    }
  }
  return alerts;
}

// Every active Great Lakes marine warning nationwide in ONE fetch (no bbox —
// the caller matches beaches locally via ecccMarineAlertsForPoint). nowIso is
// threaded to the pure parser (used as an onset fallback). Success ->
//   { alerts: [{ event, onset, ends, geometry, region, value }], sourceUrl }
// Failure -> null. Never throws.
export async function fetchActiveEcccMarineAlerts(nowIso) {
  const url = ECCC_API_BASE + "/collections/" + ECCC_MARINE_COLLECTION +
    "/items?f=json&limit=" + String(ECCC_MARINE_FETCH_LIMIT);
  const json = await fetchJson(url, {
    headers: { "User-Agent": ECCC_USER_AGENT },
    label: "ecccMarine: active marine alerts"
  });
  if (json === null) {
    return null;
  }
  try {
    const alerts = parseEcccMarineAlerts(json, nowIso);
    if (alerts === null) {
      return null;
    }
    return { alerts: alerts, sourceUrl: url };
  } catch (err) {
    console.log("ecccMarine: parse failed: " + err.message);
    return null;
  }
}

// GeoJSON Polygon/MultiPolygon -> array of polygons (each an array of rings).
// Anything else (malformed, other types) -> [] so callers skip it. Local
// defensive copy — the same shape as eccc.js's private helper, kept here
// because GeoMet responses are upstream input (unlike the repo-committed marine
// file that fails loudly by design in src/marineZones.js).
function geometryPolygons(geometry) {
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

// Kilometres per degree of latitude on the spherical earth used across
// src/geo.js: 2 * pi * 6371 / 360.
const KM_PER_DEG = 111.195;

// Distance (km) from the origin (the beach point, projected to 0,0 in a local
// equirectangular projection) to the segment a-b. Same approach as eccc.js /
// marineZones.js; error is negligible at <= 15 km.
function pointToSegmentKm(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = -(ax * dx + ay * dy) / len2;
    if (t < 0) { t = 0; }
    if (t > 1) { t = 1; }
  }
  const px = ax + t * dx;
  const py = ay + t * dy;
  return Math.sqrt(px * px + py * py);
}

// Minimum distance (km) from (lat, lon) to any ring edge of the geometry —
// outer rings and holes alike. Malformed rings/points are skipped, never
// thrown on (GeoMet data is upstream input).
function minEdgeDistanceKm(geometry, lat, lon) {
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

// Pure. Filters a fetchActiveEcccMarineAlerts result's alerts down to those
// whose marine zone covers the beach point, in the SAME shape as
// ecccAlertsForPoint:
//   { events: [deduped event names], details: [{ event, onset, ends }] }
// Marine polygons cover WATER and beach points sit on LAND, so this does PIP
// first, then a NEAREST-EDGE fallback within ECCC_MARINE_MAX_EDGE_KM — a beach
// whose centroid sits just inland of its adjacent marine zone still matches.
// details dedupe only on exact (event, onset, ends) repeats. Malformed input,
// or a non-finite lat/lon -> { events: [], details: [] } (never throws).
export function ecccMarineAlertsForPoint(alerts, lat, lon) {
  const events = [];
  const seen = {};
  const details = [];
  const seenDetails = {};
  if (typeof lat !== "number" || !isFinite(lat) ||
      typeof lon !== "number" || !isFinite(lon)) {
    return { events: events, details: details };
  }
  const list = Array.isArray(alerts) ? alerts : [];
  for (const alert of list) {
    if (alert === null || typeof alert !== "object" || typeof alert.event !== "string") {
      continue;
    }
    let covers = false;
    try {
      covers = pointInGeometry(alert.geometry, lat, lon) ||
        minEdgeDistanceKm(alert.geometry, lat, lon) <= ECCC_MARINE_MAX_EDGE_KM;
    } catch (err) {
      console.log("ecccMarine: point match failed for " + alert.event + ": " + err.message);
      covers = false;
    }
    if (!covers) {
      continue;
    }
    if (!seen[alert.event]) {
      seen[alert.event] = true;
      events.push(alert.event);
    }
    const onset = typeof alert.onset === "string" ? alert.onset : null;
    const ends = typeof alert.ends === "string" ? alert.ends : null;
    const detailKey = alert.event + "|" + String(onset) + "|" + String(ends);
    if (!seenDetails[detailKey]) {
      seenDetails[detailKey] = true;
      details.push({ event: alert.event, onset: onset, ends: ends });
    }
  }
  return { events: events, details: details };
}
