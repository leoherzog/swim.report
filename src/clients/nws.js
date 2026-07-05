// src/clients/nws.js
// Thin client for api.weather.gov. Every function here is fetch-based, async,
// and NEVER throws across the module boundary: any network error, non-2xx
// status, or JSON parse failure is caught, logged with console.log, and the
// function resolves to null.

export const NWS_USER_AGENT = "swim.report (hello@swim.report)";

export function alertsUrlForZone(zoneId) {
  return "https://api.weather.gov/alerts/active?zone=" + zoneId;
}

export async function fetchActiveAlertEvents(zoneId) {
  const url = alertsUrlForZone(zoneId);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": NWS_USER_AGENT,
        "Accept": "application/geo+json"
      }
    });
    if (!response.ok) {
      console.log("nws: alerts fetch failed for " + zoneId + ": HTTP " + response.status);
      return null;
    }
    const json = await response.json();
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
  } catch (err) {
    console.log("nws: alerts fetch failed for " + zoneId + ": " + err.message);
    return null;
  }
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
  try {
    const locationsResponse = await fetch(locationsUrl, {
      headers: {
        "User-Agent": NWS_USER_AGENT,
        "Accept": "application/geo+json"
      }
    });
    if (!locationsResponse.ok) {
      console.log("nws: SRF locations fetch failed for " + wfo + ": HTTP " + locationsResponse.status);
      return null;
    }
    const locationsJson = await locationsResponse.json();
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
    const productResponse = await fetch(productUrl, {
      headers: {
        "User-Agent": NWS_USER_AGENT,
        "Accept": "application/geo+json"
      }
    });
    if (!productResponse.ok) {
      console.log("nws: SRF product fetch failed for " + wfo + ": HTTP " + productResponse.status);
      return null;
    }
    const productJson = await productResponse.json();
    if (!productJson.productText) {
      console.log("nws: SRF product fetch for " + wfo + " missing productText");
      return null;
    }
    return {
      text: productJson.productText,
      productId: "SRF " + wfo,
      sourceUrl: locationsUrl
    };
  } catch (err) {
    console.log("nws: SRF fetch failed for " + wfo + ": " + err.message);
    return null;
  }
}

export async function fetchPointMetadata(lat, lon) {
  const url = "https://api.weather.gov/points/" + lat.toFixed(4) + "," + lon.toFixed(4);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": NWS_USER_AGENT,
        "Accept": "application/geo+json"
      }
    });
    if (!response.ok) {
      console.log("nws: points fetch failed for " + lat + "," + lon + ": HTTP " + response.status);
      return null;
    }
    const json = await response.json();
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
  } catch (err) {
    console.log("nws: points fetch failed for " + lat + "," + lon + ": " + err.message);
    return null;
  }
}
