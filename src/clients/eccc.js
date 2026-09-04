// src/clients/eccc.js — the Environment and Climate Change Canada MSC GeoMet OGC
// API client (api.weather.gc.ca), the Canadian counterpart to src/clients/nws.js
// for the Ontario-shoreline beaches api.weather.gov 404s forever. Two collections
// are used:
//   - weather-alerts: active public alerts as GeoJSON features carrying the real
//     alert-region polygons, so one national fetch per run plus local
//     point-in-polygon replaces any per-beach or per-zone lookup.
//   - public-standard-forecast-zones: the full forecast-region polygon set,
//     fetched once per enrichment run with geometry and resolved locally against
//     each pending beach to stamp eccc_zone, the same shape as the alerts path.
//
// GeoMet needs no auth, but the MSC Open Data Service Usage Policy recommends a
// meaningful User-Agent — it is how ECCC reaches an app before rate-limiting it —
// so every request carries ECCC_USER_AGENT. Every fetching function is async,
// returns data or null, and never throws across the module boundary.

import { fetchJson } from "./http.js";
import { matchedAlerts, pickIsoString } from "./alertMatch.js";
import { pointInGeometry, minEdgeDistanceKm } from "../geo.js";

export const ECCC_API_BASE = "https://api.weather.gc.ca";
// MSC usage policy asks for a meaningful, self-identifying User-Agent so ECCC
// can reach the operator before throttling. Mirrors nws.js NWS_USER_AGENT.
export const ECCC_USER_AGENT = "swim.report (https://swim.report)";

// An unbounded fetch lets a single hung socket run a cron to the 900 s scheduled
// ceiling, because http.js arms its AbortController only when timeoutMs > 0. Both
// GeoMet calls behind this constant are bulk national collections, so the budget
// is generous: it bounds the invocation, it does not police latency.
export const ECCC_TIMEOUT_MS = 45000;
// Human-readable alerts page for source { url } entries shown to visitors.
export const ECCC_ALERTS_INFO_URL = "https://weather.gc.ca/warnings/index_e.html";
// weather-alerts features per fetch, sized so one page always suffices even in a
// busy period (pygeoapi clamps an over-max limit rather than erroring). A page
// that comes back exactly full logs a truncation warning below.
const ECCC_ALERTS_FETCH_LIMIT = 2000;
// public-standard-forecast-zones holds ~419 features nationwide, so one items
// request WITH geometry returns the whole set (pygeoapi clamps an over-max
// limit rather than erroring); 2000 leaves ample headroom.
const ECCC_ZONES_FETCH_LIMIT = 2000;

// Every active public alert nationwide in one fetch; the hourly cron calls this
// once per run and matches beaches locally with ecccAlertsForPoint. nowIso drives
// the expiry filter, so there is no Date.now() inside. Success ->
//   { alerts: [{ event, onset, ends, geometry }], sourceUrl }
// where event = properties.alert_name_en (ECCC serves lowercase names, e.g.
// "severe thunderstorm warning"), onset = validity_datetime falling back to
// publication_datetime, ends = event_end_datetime falling back to
// expiration_datetime, geometry = the alert-region Polygon/MultiPolygon.
// The collection also returns recently-ended alerts and keeps rows briefly past
// expiry, so both are dropped here: a status_en of "ended", and a parseable
// expiration_datetime earlier than nowIso. Features without a usable event name or
// geometry are skipped. Failure -> null.
export async function fetchActiveEcccAlerts(nowIso) {
  const url = ECCC_API_BASE + "/collections/weather-alerts/items?f=json" +
    "&limit=" + String(ECCC_ALERTS_FETCH_LIMIT);
  const json = await fetchJson(url, {
    headers: { "User-Agent": ECCC_USER_AGENT },
    label: "eccc: active alerts",
    timeoutMs: ECCC_TIMEOUT_MS
  });
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

// Pure. Filters a fetchActiveEcccAlerts result down to the alerts whose region
// polygon contains the beach point, in the NWS-alert result shape:
//   { events: [deduped event names], details: [{ event, onset, ends }] }
// details dedupe only on exact (event, onset, ends) repeats. Malformed input gives
// { events: [], details: [] }. The accumulate and dedupe walk lives in
// ./alertMatch.js; only the containment test is local, and land alert polygons
// cover the beach itself, so it is pure point-in-polygon with no nearest-edge
// leniency, unlike the marine client.
export function ecccAlertsForPoint(alerts, lat, lon) {
  return matchedAlerts(alerts, function (alert) {
    return pointInGeometry(alert.geometry, lat, lon);
  });
}

// The entire ECCC public forecast-region set in one fetch, with geometry, so the
// enrichment cron resolves every pending beach locally with ecccZoneNameForPoint
// rather than one server-side lookup per point. Success ->
// [{ name: "Windsor - Essex - Chatham-Kent", geometry }], keeping only features
// carrying both a non-empty NAME and an areal geometry. Failure -> null, and the
// caller parks the whole run rather than bumping any per-beach attempt. Never
// throws.
export async function fetchEcccForecastZones() {
  const url = ECCC_API_BASE + "/collections/public-standard-forecast-zones/items?f=json" +
    "&limit=" + String(ECCC_ZONES_FETCH_LIMIT);
  const json = await fetchJson(url, {
    headers: { "User-Agent": ECCC_USER_AGENT },
    label: "eccc: forecast zones",
    timeoutMs: ECCC_TIMEOUT_MS
  });
  if (json === null) {
    return null;
  }
  const features = Array.isArray(json.features) ? json.features : [];
  if (features.length >= ECCC_ZONES_FETCH_LIMIT) {
    console.log(
      "eccc: forecast-zones fetch returned " + String(features.length) +
      " features at the " + String(ECCC_ZONES_FETCH_LIMIT) +
      " limit — result may be truncated"
    );
  }
  const zones = [];
  for (const feature of features) {
    const props = feature && feature.properties ? feature.properties : null;
    const name = props && typeof props.NAME === "string" && props.NAME.length > 0
      ? props.NAME
      : null;
    const geometry = feature && feature.geometry ? feature.geometry : null;
    if (name === null || geometry === null || typeof geometry !== "object") {
      continue;
    }
    zones.push({ name: name, geometry: geometry });
  }
  return zones;
}

// Nearest-edge leniency cap for ecccZoneNameForPoint's fallback, so a shoreline
// beach whose centroid sits just offshore of its land forecast-region polygon
// still resolves. A genuinely US point, many km from any Canadian region, still
// falls through to null and parks.
export const ECCC_ZONE_MAX_EDGE_KM = 2;

// Pure. Resolves a beach point to its forecast-region name against a
// fetchEcccForecastZones result: point-in-polygon first, with the first containing
// zone winning, then a nearest-edge fallback within ECCC_ZONE_MAX_EDGE_KM so a
// shoreline centroid nudged just offshore of its land region still resolves. A
// point farther than the cap from every region resolves to null and the caller
// parks it. Non-finite lat/lon or malformed input -> null.
export function ecccZoneNameForPoint(zones, lat, lon) {
  if (typeof lat !== "number" || !isFinite(lat) ||
      typeof lon !== "number" || !isFinite(lon)) {
    return null;
  }
  const list = Array.isArray(zones) ? zones : [];
  for (const zone of list) {
    if (zone === null || typeof zone !== "object" || typeof zone.name !== "string") {
      continue;
    }
    if (pointInGeometry(zone.geometry, lat, lon)) {
      return zone.name;
    }
  }
  let bestName = null;
  let bestDist = Infinity;
  for (const zone of list) {
    if (zone === null || typeof zone !== "object" || typeof zone.name !== "string") {
      continue;
    }
    const d = minEdgeDistanceKm(zone.geometry, lat, lon);
    if (d < bestDist) {
      bestDist = d;
      bestName = zone.name;
    }
  }
  if (bestName === null || bestDist > ECCC_ZONE_MAX_EDGE_KM) {
    return null;
  }
  return bestName;
}
