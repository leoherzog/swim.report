// src/clients/nws.js — the api.weather.gov client. Every function is async and
// never throws across the module boundary: any network error, non-2xx status or
// JSON parse failure is caught, logged, and resolved to null.

import { fetchJson, fetchJsonWithStatus } from "./http.js";
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

// Per-zone provenance URL for FlagEstimate source entries. The cron fetches
// NWS_ACTIVE_ALERTS_URL; the zone-scoped view is the more useful pointer for a
// given beach's payload.
export function alertsUrlForZone(zoneId) {
  return "https://api.weather.gov/alerts/active?zone=" + zoneId;
}

// Shared fetch-JSON wrapper for every api.weather.gov request: sends the required
// User-Agent and Accept headers, checks response.ok, parses JSON, and resolves to
// null on any failure rather than throwing.
function nwsRequestOptions(label) {
  return {
    headers: {
      "User-Agent": NWS_USER_AGENT,
      "Accept": "application/geo+json"
    },
    label: "nws: " + label,
    timeoutMs: NWS_TIMEOUT_MS
  };
}

function fetchNwsJson(url, label) {
  return fetchJson(url, nwsRequestOptions(label));
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
//   { alerts: [{ event, onset, ends, description, instruction, area, sender,
//                zones: [zone ids] }],
//     sourceUrl, featureCount, truncated }
// where onset/ends fall back onset -> effective / ends -> expires (null when
// the feed omits both), the four text fields are raw properties passed to
// matchedAlerts to cap, and zones comes from alertZoneIds. Features without an
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
      // Free text for the detail page's alert card, capped by matchedAlerts.
      // properties.headline is deliberately not carried: it restates the event
      // and the window in the issuing office's local time, which the card
      // already renders in the reader's.
      description: props.description,
      instruction: props.instruction,
      area: props.areaDesc,
      sender: props.senderName,
      zones: zones
    });
  }
  return {
    alerts: alerts,
    sourceUrl: NWS_ACTIVE_ALERTS_URL,
    // The RAW feature count, before the event/zone filter above: a parse that
    // understood the feed drops only features with no event name and features
    // with no resolvable zone, so featureCount far above alerts.length is the
    // visible signature of a schema drift.
    featureCount: features.length,
    // A paginated response is a partial view of the population.
    truncated: json.pagination ? true : false
  };
}

// Pure, exported for tests — the NWS counterpart of ecccAlertsForPoint.
// Filters a fetchAllActiveAlerts result's alerts down to those whose zones
// include zoneId, in the per-zone result shape the rules engine, hazard lane
// and detail page consume: { events: [deduped names], details: [{ event, onset,
// ends, description, instruction, area, sender }] } (details deduped only on
// exact (event, onset, ends) repeats). Malformed
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
// shapefile geometry), never by a live per-point probe here: the shapefile
// mapping changes only ~biannually, so resolving it live per beach would cost
// up to ~1,360 api.weather.gov requests a day for no benefit. The hourly
// recompute still READS marine_zone from D1 to match marine alerts; nothing in
// the Worker writes it.

// Marine forecast zone id prefixes. api.weather.gov/points answers a beach
// centroid over water with the MARINE forecast zone ("LMZ221", "ANZ050"), which
// no land product (High Surf Advisory, Beach Hazards Statement, Rip Current
// Statement, Coastal Flood Advisory) is ever issued for, so it must never be
// stored as nws_zone. No prefix collides with a US state code, so the first
// three characters decide exactly.
export const MARINE_ZONE_PREFIXES = [
  "AMZ", "ANZ", "GMZ", "PZZ", "PKZ", "PHZ", "PMZ", "PSZ",
  "LCZ", "LEZ", "LHZ", "LMZ", "LOZ", "LSZ", "SLZ"
];

// Pure. True when zoneId is a marine forecast zone id; false for any land zone
// and for malformed input.
export function isMarineZoneId(zoneId) {
  if (typeof zoneId !== "string" || zoneId.length < 3) {
    return false;
  }
  return MARINE_ZONE_PREFIXES.indexOf(zoneId.slice(0, 3).toUpperCase()) !== -1;
}

// Pure. The nudged coordinates runNwsEnrichment re-probes when a centroid
// resolves to a marine zone: the 8 compass directions at each of
// LAND_PROBE_RADII_M, nearest ring first, N clockwise within a ring, so the
// probe order is deterministic. Equirectangular offsets; the error at 1 km is
// metres and the land/water boundary is coarser than that.
export const LAND_PROBE_RADII_M = [300, 1000];
const COMPASS_UNIT = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [0, -1], [-1, -1], [-1, 0], [1, -1]
].map(function (v) {
  const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  return [v[0] / norm, v[1] / norm];
});
const METERS_PER_DEGREE_LAT = 111320;

export function landProbePoints(lat, lon) {
  const cosLat = Math.max(Math.cos(lat * Math.PI / 180), 0.01);
  const points = [];
  for (const radius of LAND_PROBE_RADII_M) {
    for (const unit of COMPASS_UNIT) {
      points.push({
        lat: lat + (unit[0] * radius) / METERS_PER_DEGREE_LAT,
        lon: lon + (unit[1] * radius) / (METERS_PER_DEGREE_LAT * cosLat)
      });
    }
  }
  return points;
}

// { meta, notFound }. meta is { nwsZone, nwsGridUrl } on success, which may
// carry a MARINE zone id the caller resolves via isMarineZoneId, and null on any
// failure. notFound is true only for an HTTP 404, which api.weather.gov answers
// for a point outside its domain; that is a definitive answer, never transient,
// so the enrichment cron parks such a row on the first touch instead of
// spending its attempts cap on it. A timeout, a 5xx or a malformed payload
// leaves notFound false.
export async function fetchPointMetadataDetailed(lat, lon) {
  const url = "https://api.weather.gov/points/" + lat.toFixed(4) + "," + lon.toFixed(4);
  const result = await fetchJsonWithStatus(url, nwsRequestOptions("points for " + lat + "," + lon));
  const notFound = result.status === 404;
  const json = result.json;
  if (json === null) {
    return { meta: null, notFound: notFound };
  }
  const properties = json.properties || {};
  const forecastZone = properties.forecastZone;
  const nwsGridUrl = properties.forecastGridData;
  if (!forecastZone || !nwsGridUrl) {
    console.log("nws: points fetch for " + lat + "," + lon + " missing forecastZone/forecastGridData");
    return { meta: null, notFound: false };
  }
  const segments = forecastZone.split("/");
  const nwsZone = segments[segments.length - 1];
  return { meta: { nwsZone: nwsZone, nwsGridUrl: nwsGridUrl }, notFound: false };
}

// Success -> { nwsZone, nwsGridUrl }; failure of any kind -> null.
export async function fetchPointMetadata(lat, lon) {
  const result = await fetchPointMetadataDetailed(lat, lon);
  return result.meta;
}
