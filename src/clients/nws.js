// src/clients/nws.js
// Thin client for api.weather.gov. Every function here is fetch-based, async,
// and NEVER throws across the module boundary: any network error, non-2xx
// status, or JSON parse failure is caught, logged with console.log, and the
// function resolves to null.

import { fetchJson } from "./http.js";

export const NWS_USER_AGENT = "swim.report (hello@swim.report)";

function alertsUrlForZone(zoneId) {
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

export async function fetchActiveAlertEvents(zoneId) {
  const url = alertsUrlForZone(zoneId);
  const json = await fetchNwsJson(url, "alerts for " + zoneId);
  if (json === null) {
    return null;
  }
  const features = Array.isArray(json.features) ? json.features : [];
  const seen = {};
  const events = [];
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    const event = feature && feature.properties ? feature.properties.event : null;
    if (event && !seen[event]) {
      seen[event] = true;
      events.push(event);
    }
  }
  return { events: events, sourceUrl: url };
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
