// src/clients/nws.js — the api.weather.gov client. Every function is async and
// never throws across the module boundary: any network error, non-2xx status or
// JSON parse failure is caught, logged, and resolved to null.

import { fetchJson } from "./http.js";
import { matchedAlerts, pickIsoString } from "./alertMatch.js";

export const NWS_USER_AGENT = "swim.report (hello@swim.report)";

// src/clients/http.js arms its AbortController only when timeoutMs > 0, so a call
// site that omits it is genuinely unbounded: one hung socket runs the hourly cron
// to the 900 s scheduled ceiling and kills it mid-run. A wall-clock deadline
// cannot save it, because deadlines are checked between units of work, never
// inside a pending fetch. 45 s is generous against the national /alerts/active
// payload, the largest response this wrapper carries, while still bounding the
// invocation.
const NWS_TIMEOUT_MS = 45000;

// The national active-alerts endpoint fetched once per hourly run; zone
// matching happens locally in nwsAlertsForZone.
export const NWS_ACTIVE_ALERTS_URL = "https://api.weather.gov/alerts/active";

// The count view of the same active-alert population, produced by a different
// code path upstream. The alerts refresh cron cross-checks one against the other:
// fetchAllActiveAlerts cannot tell a genuinely quiet nation from a 200 whose
// schema drifted, because both parse to zero alerts, and a parse materially short
// of the API's own total is truncation or drift whatever its magnitude.
export const NWS_ACTIVE_ALERTS_COUNT_URL = "https://api.weather.gov/alerts/active/count";

// Per-zone provenance URL for FlagEstimate source entries. The cron fetches
// NWS_ACTIVE_ALERTS_URL; the zone-scoped view is the more useful pointer for a
// given beach's payload.
export function alertsUrlForZone(zoneId) {
  return "https://api.weather.gov/alerts/active?zone=" + zoneId;
}

// Shared fetch-JSON wrapper for every api.weather.gov request: sends the required
// User-Agent and Accept headers, checks response.ok, parses JSON, and resolves to
// null on any failure rather than throwing.
function fetchNwsJson(url, label) {
  return fetchJson(url, {
    headers: {
      "User-Agent": NWS_USER_AGENT,
      "Accept": "application/geo+json"
    },
    label: "nws: " + label,
    timeoutMs: NWS_TIMEOUT_MS
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
//   { alerts: [{ event, onset, ends, zones: [zone ids] }], sourceUrl,
//     featureCount, truncated }
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
  return {
    alerts: alerts,
    sourceUrl: NWS_ACTIVE_ALERTS_URL,
    // The RAW feature count, before the event/zone filter above, because that is
    // the only figure comparable to the count endpoint's total: this parse
    // legitimately drops features with no event name and features with no
    // resolvable zone.
    featureCount: features.length,
    // A paginated response is a partial view of the population, so the refusal
    // it drives is the same one a short parse drives.
    truncated: json.pagination ? true : false
  };
}

// Total active alerts nationwide in one small fetch. Success -> { total },
// failure -> null. A response whose total is not a finite non-negative number is
// a failure: an unusable cross-check must read as "unverified", never as a
// license to clear flags.
export async function fetchActiveAlertCount() {
  const json = await fetchNwsJson(NWS_ACTIVE_ALERTS_COUNT_URL, "active alert count");
  if (json === null) {
    return null;
  }
  const total = json.total;
  if (typeof total !== "number" || !isFinite(total) || total < 0) {
    console.log("nws: active alert count missing total");
    return null;
  }
  return { total: total };
}

// Pure, exported for tests — the NWS counterpart of ecccAlertsForPoint.
// Filters a fetchAllActiveAlerts result's alerts down to those whose zones
// include zoneId, in the per-zone result shape the rules engine and hazard
// lane consume: { events: [deduped names], details: [{ event, onset, ends }] }
// (details deduped only on exact (event, onset, ends) repeats). Malformed
// input -> { events: [], details: [] }. The accumulate/dedupe walk lives in
// ./alertMatch.js; only the zone-membership test is local.
export function nwsAlertsForZone(alerts, zoneId) {
  return matchedAlerts(alerts, function (alert) {
    return Array.isArray(alert.zones) && alert.zones.indexOf(zoneId) !== -1;
  });
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
// any fetch failure or a response missing productText -> null (data-or-null
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
