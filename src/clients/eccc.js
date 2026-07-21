// src/clients/eccc.js
// Thin client for Environment and Climate Change Canada's MSC GeoMet OGC API
// (api.weather.gc.ca) — the Canadian counterpart to src/clients/nws.js for
// beaches the Great Lakes region set (src/regions.js) sweeps in on the Ontario
// shoreline, which api.weather.gov 404s forever. Two collections are used:
//   - weather-alerts: active public alerts as GeoJSON features carrying the
//     REAL alert-region polygons, so one national fetch per run plus local
//     point-in-polygon replaces any per-beach or per-zone lookup.
//   - public-standard-forecast-zones: the full forecast-region polygon set,
//     fetched ONCE per enrichment run (with geometry) and resolved locally
//     against each pending beach to stamp it as Canadian (eccc_zone) — the
//     same one-fetch + local point-in-polygon shape as the alerts path.
// GeoMet needs no auth, but the MSC Open Data Service Usage Policy explicitly
// recommends "a meaningful HTTP User-Agent header" (it is how ECCC reaches an
// app before rate-limiting it), so every request carries ECCC_USER_AGENT.
// Every fetching function is async, returns data or null, and NEVER throws
// across the module boundary.

import { fetchJson } from "./http.js";
import { pointInGeometry } from "../geo.js";

export const ECCC_API_BASE = "https://api.weather.gc.ca";
// MSC usage policy asks for a meaningful, self-identifying User-Agent so ECCC
// can reach the operator before throttling. Mirrors nws.js NWS_USER_AGENT.
export const ECCC_USER_AGENT = "swim.report (https://swim.report)";
// Human-readable alerts page for source { url } entries shown to visitors.
export const ECCC_ALERTS_INFO_URL = "https://weather.gc.ca/warnings/index_e.html";
// weather-alerts features per fetch. The national active set runs ~500 in a
// busy period, so 2000 leaves ample headroom for one page to always suffice
// (pygeoapi clamps an over-max limit rather than erroring); a page that comes
// back exactly full logs a truncation warning below.
const ECCC_ALERTS_FETCH_LIMIT = 2000;
// public-standard-forecast-zones holds ~419 features nationwide, so one items
// request WITH geometry returns the whole set (pygeoapi clamps an over-max
// limit rather than erroring); 2000 leaves ample headroom.
const ECCC_ZONES_FETCH_LIMIT = 2000;

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
  const json = await fetchJson(url, {
    headers: { "User-Agent": ECCC_USER_AGENT },
    label: "eccc: active alerts"
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

// The ENTIRE ECCC public forecast-region set in ONE fetch, WITH geometry, so
// the enrichment cron resolves every pending beach locally via
// ecccZoneNameForPoint instead of one server-side per-point lookup each (the
// same one-national-fetch + local point-in-polygon shape as the alerts path).
// Success -> [{ name: "Windsor - Essex - Chatham-Kent", geometry }], keeping
// only features that carry BOTH a non-empty NAME and an areal geometry.
// Failure -> null (the caller parks the whole run rather than bumping any
// per-beach attempt). Never throws.
export async function fetchEcccForecastZones() {
  const url = ECCC_API_BASE + "/collections/public-standard-forecast-zones/items?f=json" +
    "&limit=" + String(ECCC_ZONES_FETCH_LIMIT);
  const json = await fetchJson(url, {
    headers: { "User-Agent": ECCC_USER_AGENT },
    label: "eccc: forecast zones"
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

// Nearest-edge leniency cap for ecccZoneNameForPoint's fallback. The retired
// per-point GeoMet lookup used a bbox INTERSECTS test with a +/-0.01 deg box
// (~1.1 km reach), so a shoreline beach whose centroid sat just offshore of
// its land forecast-region polygon still resolved. 2 km is a strict superset
// of that reach, so no beach the old lookup could resolve becomes
// unresolvable, while a genuinely-US point (many km from any Canadian region)
// still falls through to null and parks.
export const ECCC_ZONE_MAX_EDGE_KM = 2;

// Kilometres per degree of latitude (and of longitude at the equator) on the
// spherical earth used across src/geo.js: 2 * pi * 6371 / 360. Mirrors
// src/marineZones.js (which stays offline-only, hence the local copy).
const KM_PER_DEG = 111.195;

// Distance (km) from the origin (the point, already projected to 0,0 in a
// local equirectangular projection) to the segment a-b. Same local-projection
// approach as src/marineZones.js; error is negligible at <= 2 km.
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

// GeoJSON Polygon/MultiPolygon -> array of polygons (each an array of rings).
// Anything else (malformed, other types) -> [] so callers skip it.
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

// Minimum distance (km) from (lat, lon) to any ring edge of the geometry —
// outer rings and holes alike. Malformed rings/points are skipped, never
// thrown on (GeoMet data is upstream input, unlike the repo-committed marine
// file that fails loudly by design).
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

// Pure. Resolves a beach point to its forecast-region NAME against a
// fetchEcccForecastZones result: exact point-in-polygon first (the first zone
// whose polygon contains the point wins), then a nearest-edge fallback within
// ECCC_ZONE_MAX_EDGE_KM so a shoreline centroid nudged just offshore of its
// land region still resolves (restoring the leniency of the retired ~1 km
// bbox-intersection lookup; the same shape as src/marineZones.js'
// nearest-edge resolution). A point farther than the cap from every region
// (a US point) resolves to null and the caller parks it. Non-finite lat/lon
// or malformed input -> null.
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
