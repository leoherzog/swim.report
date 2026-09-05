// src/clients/ecccMarine.js — the ECCC MSC GeoMet marine-warnings client, the
// marine counterpart to the land weather-alerts path in src/clients/eccc.js, for
// every Canadian beach api.weather.gov 404s: Great Lakes, St. Lawrence, Atlantic,
// Pacific, Arctic and Hudson Bay shorelines alike.
//
// Fetch and defensive parse only; it decides no flag color. src/index.js matches
// its output per beach with ecccMarineAlertsForPoint and concats it onto the
// land alerts, feeding the same alerts[] / alertDetails input estimateFlag
// already consumes rather than a parallel one.
//
// Source: GET https://api.weather.gc.ca/collections/marineweather-realtime/items
//   ?f=json  (send ECCC_USER_AGENT from ./eccc.js). Returns a GeoJSON
//   FeatureCollection. Each Feature is one per-zone Polygon:
//     - geometry: Polygon / MultiPolygon (the marine zone, over WATER)
//     - properties.area.region.en  e.g. "Great Lakes" / "Atlantic - Nova Scotia"
//     - properties.area.value.en   e.g. "Lake Erie" / "Halifax Harbour"
//     - properties.lastUpdated     ISO timestamp (feature level; used as onset)
//     - properties.warnings.locations[] { name.en, events[] }
//         events[] = { name.en, type.en, category.en (=="marine"),
//                      status.en ("IN EFFECT" / "CONTINUED" / "ENDED") }
//   Marine events carry no per-event datetime, only a status, so status is the
//   authoritative active/ended signal: keep IN EFFECT and CONTINUED, drop ENDED.
//   Every region in the collection is a candidate; the only event-level scope is
//   category.en == "marine". Geography is decided per beach by the point match,
//   never by a region-name filter, so region rides along as provenance only.
//
// The color and floor mapping src/rules.js applies to these event names, recorded
// here only as provenance. This module never decides or exports a color:
//     storm warning            -> double-red   (marine >=48kt; distinct from the
//                                                land "storm surge warning")
//     gale warning             -> red
//     squall warning           -> red
//     waterspout warning       -> red
//     strong wind warning      -> yellow  (raise-only floor, like nws-floor)
//     marine weather advisory  -> yellow  (floor)
//     everything else (all watches, "special ice warning", unknown) -> null,
//                                                unmapped and a safe-fail no-op
// ECCC serves land alert names lowercase while marine name.en arrives
// Title-cased, so every event name is lowercased here to match the keys rules.js
// keys on; an unknown string maps to null, never a wrong color.
//
// This collection is disjoint from src/clients/eccc.js fetchActiveEcccAlerts —
// the land weather-alerts collection carries no marine warnings — so it adds new
// signal rather than duplicates. Do not also try to pull marine warnings out of
// the land collection.
//
// Cron-side only: nothing in src/router.js or src/frontend/render.js may reach
// this module. Every function returns data-or-null and never throws across the
// module boundary.

import { fetchJson } from "./http.js";
import { matchedAlerts } from "./alertMatch.js";
import { pointInGeometry, minEdgeDistanceKm } from "../geo.js";
import { ECCC_API_BASE, ECCC_USER_AGENT, ECCC_TIMEOUT_MS } from "./eccc.js";

// The marine-realtime collection carrying per-zone Gale/Storm/Strong-wind
// warning Polygons.
const ECCC_MARINE_COLLECTION = "marineweather-realtime";

// Human-readable marine-forecast page for source { url } entries shown to
// visitors (reuses ECCC's public marine index).
export const ECCC_MARINE_INFO_URL = "https://weather.gc.ca/marine/index_e.html";

// Nearest-edge leniency cap for ecccMarineAlertsForPoint's fallback. Marine
// polygons cover water while beach points sit on land, so point-in-polygon alone
// under-matches. The cap bounds beach-to-nearest-edge distance, not zone size,
// so an ocean zone reaching hundreds of km offshore is no different from a lake
// zone: what matters is how far inshore of the polygon's landward edge the beach
// point sits, and ~15 km covers a coarsely drawn shoreline edge either way
// (matches src/marineZones.js MARINE_ZONE_MAX_DISTANCE_KM).
export const ECCC_MARINE_MAX_EDGE_KM = 15;

// Feature-page items cap, sized so one page covers the whole collection with
// headroom (pygeoapi clamps an over-max limit rather than erroring). A page that
// comes back exactly full logs a truncation warning below.
const ECCC_MARINE_FETCH_LIMIT = 2000;

// The active-status set. Marine events expose only a status word, so this is the
// authoritative active/ended signal, and it fails closed: only these explicit
// strings count as active, so anything else — ENDED, missing, an unrecognized
// future status — is dropped and a stale warning can never surface as a live
// one. Compared upper-cased.
const ACTIVE_STATUSES = { "IN EFFECT": true, "CONTINUED": true };

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

// Pure. Given a raw GeoMet FeatureCollection and nowIso, returns every active
// marine warning nationwide as a flat alerts array in the same shape as
// fetchActiveEcccAlerts's entries:
//   [{ event, onset, ends, geometry, region, value }]
// event is the lowercased event name, onset is properties.lastUpdated falling
// back to nowIso (marine events carry no per-event onset), ends is null
// (active/ended is by status), geometry is the zone Polygon, and region/value
// ride along for provenance. One entry per active event per zone.
//
// Only features with an area object and an areal geometry are considered, and
// only marine-category events with an active status are kept. A feature or event
// that cannot be understood is skipped, never guessed. Returns null only when the
// top-level payload is unusable; an all-clear collection returns [].
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

// Every active marine warning nationwide in one fetch; the caller
// matches beaches locally with ecccMarineAlertsForPoint. nowIso is threaded to
// the pure parser as an onset fallback. Success ->
//   { alerts: [{ event, onset, ends, geometry, region, value }], sourceUrl }
// Failure -> null. Never throws.
export async function fetchActiveEcccMarineAlerts(nowIso) {
  const url = ECCC_API_BASE + "/collections/" + ECCC_MARINE_COLLECTION +
    "/items?f=json&limit=" + String(ECCC_MARINE_FETCH_LIMIT);
  const json = await fetchJson(url, {
    headers: { "User-Agent": ECCC_USER_AGENT },
    label: "ecccMarine: active marine alerts",
    timeoutMs: ECCC_TIMEOUT_MS
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

// Pure. Filters a fetchActiveEcccMarineAlerts result down to the alerts whose
// marine zone covers the beach point, in the same shape as ecccAlertsForPoint:
//   { events: [deduped event names], details: [{ event, onset, ends }] }
// Marine polygons cover water and beach points sit on land, so this is
// point-in-polygon first, then a nearest-edge fallback within
// ECCC_MARINE_MAX_EDGE_KM, so a beach whose centroid sits just inland of its
// adjacent marine zone still matches. details dedupe only on exact
// (event, onset, ends) repeats. Malformed input or a non-finite lat/lon gives
// { events: [], details: [] }; it never throws.
//
// The accumulate and dedupe walk lives in ./alertMatch.js; only the coverage test
// is local. The try/catch stays inside this predicate deliberately: this client
// alone runs the ring math over raw GeoMet geometry, so this client alone
// swallows a throw there. The land and NWS matchers must keep propagating one.
export function ecccMarineAlertsForPoint(alerts, lat, lon) {
  if (typeof lat !== "number" || !isFinite(lat) ||
      typeof lon !== "number" || !isFinite(lon)) {
    return { events: [], details: [] };
  }
  return matchedAlerts(alerts, function (alert) {
    try {
      return pointInGeometry(alert.geometry, lat, lon) ||
        minEdgeDistanceKm(alert.geometry, lat, lon) <= ECCC_MARINE_MAX_EDGE_KM;
    } catch (err) {
      console.log("ecccMarine: point match failed for " + alert.event + ": " + err.message);
      return false;
    }
  });
}
