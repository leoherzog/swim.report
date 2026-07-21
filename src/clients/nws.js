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

// Latest SRF (Surf Zone Forecast) product text for a WFO in ONE request.
// api.weather.gov exposes /products/types/{type}/locations/{loc}/latest, which
// returns the newest matching product object with productText inline — no need
// for the old two-leg (list -> @graph[0].id -> /products/{id}) dance. Success ->
//   { text, productId: "SRF <wfo>", sourceUrl }  (sourceUrl is the /latest URL)
// Any fetch failure or a response missing productText -> null (data-or-null
// contract, consumed by parseRipCurrentRisk and the hourly cron).
export async function fetchLatestSrfText(wfo) {
  const latestUrl = "https://api.weather.gov/products/types/SRF/locations/" + wfo + "/latest";
  const latestJson = await fetchNwsJson(latestUrl, "SRF latest for " + wfo);
  if (latestJson === null) {
    return null;
  }
  if (!latestJson.productText) {
    console.log("nws: SRF latest fetch for " + wfo + " missing productText");
    return null;
  }
  return {
    text: latestJson.productText,
    productId: "SRF " + wfo,
    sourceUrl: latestUrl
  };
}

// beaches.marine_zone is derived OFFLINE by the GitHub Actions discovery batch
// (a nearest-marine-zone point-in-polygon pass over the NWS marine-zone
// shapefile geometry), not by any live probe here — the old in-Worker
// resolveMarineZone offshore probe and its fetchMarineZonesAtPoint helper were
// retired to stop deriving a static, ~biannually-updated mapping via up to
// ~1,360 live api.weather.gov requests/day. The hourly recompute still READS
// marine_zone from D1 to match marine alerts; nothing in the Worker writes it.

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
