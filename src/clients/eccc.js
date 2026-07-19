// src/clients/eccc.js
// Thin client for Environment and Climate Change Canada's MSC GeoMet OGC API
// (api.weather.gc.ca) — the Canadian counterpart to src/clients/nws.js for
// beaches the Great Lakes region set (src/regions.js) sweeps in on the Ontario
// shoreline, which api.weather.gov 404s forever. Two collections are used:
//   - weather-alerts: active public alerts as GeoJSON features carrying the
//     REAL alert-region polygons, so one national fetch per run plus local
//     point-in-polygon replaces any per-beach or per-zone lookup.
//   - public-standard-forecast-zones: per-point region lookup used by the
//     enrichment cron to stamp beaches as Canadian (eccc_zone).
// Unlike api.weather.gov, GeoMet needs no auth and no User-Agent header.
// Every fetching function is async, returns data or null, and NEVER throws
// across the module boundary.

import { fetchJson } from "./http.js";
import { pointInGeometry } from "../geo.js";

export const ECCC_API_BASE = "https://api.weather.gc.ca";
// Human-readable alerts page for source { url } entries shown to visitors.
export const ECCC_ALERTS_INFO_URL = "https://weather.gc.ca/warnings/index_e.html";
// weather-alerts features per fetch. The national active set runs ~500 in a
// busy period, so 2000 leaves ample headroom for one page to always suffice
// (pygeoapi clamps an over-max limit rather than erroring); a page that comes
// back exactly full logs a truncation warning below.
const ECCC_ALERTS_FETCH_LIMIT = 2000;
// Half-width in degrees of the bbox used for the per-point forecast-zone
// lookup. Zone polygons are forecast-region sized (thousands of km2), so a
// ~1 km box behaves as a point-in-polygon test server-side; a US point
// returns zero features.
const ECCC_ZONE_LOOKUP_EPSILON_DEG = 0.01;

// First non-empty string of the two candidates, else null (mirrors the NWS
// client's onset/ends fallback handling).
function pickIsoString(primary, fallback) {
  if (typeof primary === "string" && primary.length > 0) {
    return primary;
  }
  if (typeof fallback === "string" && fallback.length > 0) {
    return fallback;
  }
  return null;
}

// Every active public alert nationwide in ONE fetch (no bbox — the hourly
// cron calls this once per run and matches beaches locally via
// ecccAlertsForPoint). nowIso drives the expiry filter — no Date.now()
// inside. Success ->
//   { alerts: [{ event, onset, ends, geometry }], sourceUrl }
// where event = properties.alert_name_en (ECCC serves lowercase names, e.g.
// "severe thunderstorm warning"), onset = validity_datetime falling back to
// publication_datetime, ends = event_end_datetime falling back to
// expiration_datetime, geometry = the alert-region Polygon/MultiPolygon.
// The collection also returns recently-ENDED alerts (status_en "ended") and
// keeps rows briefly past expiry, so both are dropped here: status_en of
// "ended", and a parseable expiration_datetime earlier than nowIso. Features
// without a usable event name or geometry are skipped. Failure -> null.
export async function fetchActiveEcccAlerts(nowIso) {
  const url = ECCC_API_BASE + "/collections/weather-alerts/items?f=json" +
    "&limit=" + String(ECCC_ALERTS_FETCH_LIMIT);
  const json = await fetchJson(url, { label: "eccc: active alerts" });
  if (json === null) {
    return null;
  }
  const nowMs = Date.parse(nowIso);
  const features = Array.isArray(json.features) ? json.features : [];
  if (features.length >= ECCC_ALERTS_FETCH_LIMIT) {
    console.log(
      "eccc: alerts fetch returned " + String(features.length) +
      " features at the " + String(ECCC_ALERTS_FETCH_LIMIT) +
      " limit — result may be truncated"
    );
  }
  const alerts = [];
  for (const feature of features) {
    const props = feature && feature.properties ? feature.properties : null;
    if (!props || typeof props.alert_name_en !== "string" || props.alert_name_en.length === 0) {
      continue;
    }
    if (props.status_en === "ended") {
      continue;
    }
    const expiryMs = typeof props.expiration_datetime === "string"
      ? Date.parse(props.expiration_datetime)
      : NaN;
    if (!Number.isNaN(nowMs) && !Number.isNaN(expiryMs) && expiryMs < nowMs) {
      continue;
    }
    const geometry = feature.geometry;
    if (geometry === null || typeof geometry !== "object") {
      continue;
    }
    alerts.push({
      event: props.alert_name_en,
      onset: pickIsoString(props.validity_datetime, props.publication_datetime),
      ends: pickIsoString(props.event_end_datetime, props.expiration_datetime),
      geometry: geometry
    });
  }
  return { alerts: alerts, sourceUrl: url };
}

// Pure. Filters a fetchActiveEcccAlerts result's alerts down to those whose
// region polygon contains the beach point, in the NWS-alert result shape:
//   { events: [deduped event names], details: [{ event, onset, ends }] }
// details dedupe only on exact (event, onset, ends) repeats, matching
// fetchActiveAlertEvents. Malformed input -> { events: [], details: [] }.
export function ecccAlertsForPoint(alerts, lat, lon) {
  const events = [];
  const seen = {};
  const details = [];
  const seenDetails = {};
  const list = Array.isArray(alerts) ? alerts : [];
  for (const alert of list) {
    if (alert === null || typeof alert !== "object" || typeof alert.event !== "string") {
      continue;
    }
    if (!pointInGeometry(alert.geometry, lat, lon)) {
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

// Per-point ECCC public forecast region lookup (the enrichment counterpart of
// nws.js fetchPointMetadata). skipGeometry=true keeps the response tiny (the
// region polygons are large); the tiny bbox acts as a server-side containment
// test. Success with a region -> { zoneName: "Windsor - Essex - Chatham-Kent" }.
// A clean answer of ZERO regions (a US point) -> null, indistinguishable from
// failure by design: both count an attempt, and the attempts cap parks the row
// either way. Failure -> null.
export async function fetchEcccZoneName(lat, lon) {
  const url = ECCC_API_BASE + "/collections/public-standard-forecast-zones/items?f=json" +
    "&skipGeometry=true&limit=2" +
    "&bbox=" + String(lon - ECCC_ZONE_LOOKUP_EPSILON_DEG) +
    "," + String(lat - ECCC_ZONE_LOOKUP_EPSILON_DEG) +
    "," + String(lon + ECCC_ZONE_LOOKUP_EPSILON_DEG) +
    "," + String(lat + ECCC_ZONE_LOOKUP_EPSILON_DEG);
  const json = await fetchJson(url, { label: "eccc: zone for " + lat + "," + lon });
  if (json === null) {
    return null;
  }
  const features = Array.isArray(json.features) ? json.features : [];
  for (const feature of features) {
    const props = feature && feature.properties ? feature.properties : null;
    if (props && typeof props.NAME === "string" && props.NAME.length > 0) {
      return { zoneName: props.NAME };
    }
  }
  console.log("eccc: zone lookup for " + lat + "," + lon + " matched no region");
  return null;
}
