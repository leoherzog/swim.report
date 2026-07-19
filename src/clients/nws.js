// src/clients/nws.js
// Thin client for api.weather.gov. Every function here is fetch-based, async,
// and NEVER throws across the module boundary: any network error, non-2xx
// status, or JSON parse failure is caught, logged with console.log, and the
// function resolves to null.

import { fetchJson } from "./http.js";

export const NWS_USER_AGENT = "swim.report (hello@swim.report)";

// The national active-alerts endpoint fetched once per hourly run; zone
// matching happens locally in nwsAlertsForZone.
export const NWS_ACTIVE_ALERTS_URL = "https://api.weather.gov/alerts/active";

// Per-zone provenance URL for FlagEstimate source entries — no longer what
// the cron fetches (that is NWS_ACTIVE_ALERTS_URL), but the zone-scoped view
// is the more useful pointer for a given beach's payload.
export function alertsUrlForZone(zoneId) {
  return "https://api.weather.gov/alerts/active?zone=" + zoneId;
}

// Shared fetch-JSON wrapper for every api.weather.gov request: sends the
// required User-Agent/Accept headers, checks response.ok, parses JSON, and
// NEVER throws across the module boundary — any network error, non-2xx
// status, or JSON parse failure is caught, logged with console.log, and
// resolves to null.
function fetchNwsJson(url, label) {
  return fetchJson(url, {
    headers: {
      "User-Agent": NWS_USER_AGENT,
      "Accept": "application/geo+json"
    },
    label: "nws: " + label
  });
}

// Every zone id a single alert feature applies to, deduped: the UGC geocode
// list (forecast zones "MIZ071" and county codes "MIC161" share it) merged
// with the last path segment of each affectedZones URL. The two namespaces
// never collide, and beach.nws_zone is always a forecast-zone id, so exact
// membership here reproduces the old per-zone endpoint's matching.
function alertZoneIds(props) {
  const seen = {};
  const zones = [];
  const ugc = props.geocode && Array.isArray(props.geocode.UGC) ? props.geocode.UGC : [];
  for (const code of ugc) {
    if (typeof code === "string" && code.length > 0 && !seen[code]) {
      seen[code] = true;
      zones.push(code);
    }
  }
  const affected = Array.isArray(props.affectedZones) ? props.affectedZones : [];
  for (const zoneUrl of affected) {
    if (typeof zoneUrl !== "string" || zoneUrl.length === 0) {
      continue;
    }
    const segments = zoneUrl.split("/");
    const code = segments[segments.length - 1];
    if (code.length > 0 && !seen[code]) {
      seen[code] = true;
      zones.push(code);
    }
  }
  return zones;
}

// Every active alert nationwide in ONE fetch (the hourly cron calls this once
// per run regardless of zone count; per-zone filtering happens locally via
// nwsAlertsForZone). Success ->
//   { alerts: [{ event, onset, ends, zones: [zone ids] }], sourceUrl }
// where onset/ends fall back onset -> effective / ends -> expires (null when
// the feed omits both) and zones comes from alertZoneIds. Features without an
// event name or with zero resolvable zone ids are skipped (a zoneless alert
// could never match a beach). Failure -> null.
export async function fetchAllActiveAlerts() {
  const json = await fetchNwsJson(NWS_ACTIVE_ALERTS_URL, "all active alerts");
  if (json === null) {
    return null;
  }
  const features = Array.isArray(json.features) ? json.features : [];
  const alerts = [];
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    const props = feature && feature.properties ? feature.properties : null;
    const event = props ? props.event : null;
    if (!event) {
      continue;
    }
    const zones = alertZoneIds(props);
    if (zones.length === 0) {
      continue;
    }
    alerts.push({
      event: event,
      onset: pickIsoString(props.onset, props.effective),
      ends: pickIsoString(props.ends, props.expires),
      zones: zones
    });
  }
  return { alerts: alerts, sourceUrl: NWS_ACTIVE_ALERTS_URL };
}

// Pure, exported for tests — the NWS counterpart of ecccAlertsForPoint.
// Filters a fetchAllActiveAlerts result's alerts down to those whose zones
// include zoneId, in the per-zone result shape the rules engine and hazard
// lane consume: { events: [deduped names], details: [{ event, onset, ends }] }
// (details deduped only on exact (event, onset, ends) repeats). Malformed
// input -> { events: [], details: [] }.
export function nwsAlertsForZone(alerts, zoneId) {
  const events = [];
  const seen = {};
  const details = [];
  const seenDetails = {};
  const list = Array.isArray(alerts) ? alerts : [];
  for (const alert of list) {
    if (alert === null || typeof alert !== "object" || typeof alert.event !== "string") {
      continue;
    }
    if (!Array.isArray(alert.zones) || alert.zones.indexOf(zoneId) === -1) {
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

// First non-empty string of the two candidates, else null (alert features
// commonly carry effective/expires but leave onset/ends null).
function pickIsoString(primary, fallback) {
  if (typeof primary === "string" && primary.length > 0) {
    return primary;
  }
  if (typeof fallback === "string" && fallback.length > 0) {
    return fallback;
  }
  return null;
}

export function wfoFromGridUrl(nwsGridUrl) {
  if (!nwsGridUrl) {
    return null;
  }
  const match = /\/gridpoints\/([A-Z0-9]{3})\//.exec(nwsGridUrl);
  if (!match) {
    return null;
  }
  return match[1];
}

export async function fetchLatestSrfText(wfo) {
  const locationsUrl = "https://api.weather.gov/products/types/SRF/locations/" + wfo;
  const locationsJson = await fetchNwsJson(locationsUrl, "SRF locations for " + wfo);
  if (locationsJson === null) {
    return null;
  }
  const graph = locationsJson["@graph"];
  if (!Array.isArray(graph) || graph.length === 0) {
    console.log("nws: SRF locations fetch for " + wfo + " returned empty @graph");
    return null;
  }
  const id = graph[0].id;
  if (!id) {
    console.log("nws: SRF locations fetch for " + wfo + " missing product id");
    return null;
  }
  const productUrl = "https://api.weather.gov/products/" + id;
  const productJson = await fetchNwsJson(productUrl, "SRF product for " + wfo);
  if (productJson === null) {
    return null;
  }
  if (!productJson.productText) {
    console.log("nws: SRF product fetch for " + wfo + " missing productText");
    return null;
  }
  return {
    text: productJson.productText,
    productId: "SRF " + wfo,
    sourceUrl: locationsUrl
  };
}

// Marine forecast zone ids (e.g. "LMZ874") whose polygon contains a point, as a
// string array (possibly empty), or null on any fetch/parse failure. Marine
// polygons cover open water, so a shore point usually returns [] —
// resolveMarineZone probes offshore to compensate.
async function fetchMarineZonesAtPoint(lat, lon) {
  const url = "https://api.weather.gov/zones?type=marine&point=" +
    lat.toFixed(4) + "," + lon.toFixed(4);
  const json = await fetchNwsJson(url, "marine zones at " + lat + "," + lon);
  if (json === null) {
    return null;
  }
  const features = Array.isArray(json.features) ? json.features : [];
  const zones = [];
  for (let i = 0; i < features.length; i++) {
    const props = features[i] && features[i].properties ? features[i].properties : null;
    if (props && typeof props.id === "string" && props.id.length > 0) {
      zones.push(props.id);
    }
  }
  return zones;
}

// Concentric offshore probe offsets (degrees, ~5.5 km and ~11 km latitudinally):
// a beach point sits on land outside every marine polygon, so we sample the
// point itself, then rings of 8 compass directions at increasing distance, and
// take the FIRST marine zone hit — nearest wins because the rings widen outward.
// Which direction is "offshore" is unknown per beach, so all 8 are tried; land
// (or across-lake) directions simply return no marine zone.
const MARINE_PROBE_RINGS_DEG = [0.05, 0.10];
const MARINE_PROBE_DIRECTIONS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]
];

// Resolve a beach (lat/lon) to its adjacent NWS marine forecast zone id.
// Returns:
//   { marineZone: "LMZ874" }  — a zone was found (at the point or a probe ring)
//   { marineZone: null }      — probes succeeded but NO marine zone is nearby
//                               (inland lake) — a definitive "none", so the
//                               caller parks it rather than re-probing forever
//   null                      — the FIRST lookup failed to fetch (transient);
//                               caller counts an attempt and retries next run
// Never throws (fetchMarineZonesAtPoint upholds the data-or-null contract).
export async function resolveMarineZone(lat, lon) {
  const atPoint = await fetchMarineZonesAtPoint(lat, lon);
  if (atPoint === null) {
    return null;
  }
  if (atPoint.length > 0) {
    return { marineZone: atPoint[0] };
  }
  for (let r = 0; r < MARINE_PROBE_RINGS_DEG.length; r++) {
    const d = MARINE_PROBE_RINGS_DEG[r];
    for (let k = 0; k < MARINE_PROBE_DIRECTIONS.length; k++) {
      const dir = MARINE_PROBE_DIRECTIONS[k];
      const probed = await fetchMarineZonesAtPoint(lat + dir[0] * d, lon + dir[1] * d);
      if (probed !== null && probed.length > 0) {
        return { marineZone: probed[0] };
      }
    }
  }
  return { marineZone: null };
}

export async function fetchPointMetadata(lat, lon) {
  const url = "https://api.weather.gov/points/" + lat.toFixed(4) + "," + lon.toFixed(4);
  const json = await fetchNwsJson(url, "points for " + lat + "," + lon);
  if (json === null) {
    return null;
  }
  const properties = json.properties || {};
  const forecastZone = properties.forecastZone;
  const nwsGridUrl = properties.forecastGridData;
  if (!forecastZone || !nwsGridUrl) {
    console.log("nws: points fetch for " + lat + "," + lon + " missing forecastZone/forecastGridData");
    return null;
  }
  const segments = forecastZone.split("/");
  const nwsZone = segments[segments.length - 1];
  return { nwsZone: nwsZone, nwsGridUrl: nwsGridUrl };
}
