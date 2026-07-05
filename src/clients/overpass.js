// src/clients/overpass.js
// Client for the Overpass API (OpenStreetMap). Used ONLY from the daily
// scheduled sync — never from the request path. Never throws across the
// module boundary: on any error, logs with console.log and returns null.

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// overpass-api.de rejects requests without a User-Agent with HTTP 406, and
// Workers' fetch sends none by default.
export const OVERPASS_USER_AGENT = "swim.report (hello@swim.report)";

function buildQuery(bbox) {
  return "[out:json][timeout:60];\n" +
    "(\n" +
    "  nwr[\"natural\"=\"beach\"][\"name\"](" + bbox.minLat + "," + bbox.minLon + "," + bbox.maxLat + "," + bbox.maxLon + ");\n" +
    "  nwr[\"leisure\"=\"beach_resort\"][\"name\"](" + bbox.minLat + "," + bbox.minLon + "," + bbox.maxLat + "," + bbox.maxLon + ");\n" +
    ");\n" +
    "out center tags;";
}

export async function fetchBeaches(bbox) {
  const query = buildQuery(bbox);
  try {
    const response = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": OVERPASS_USER_AGENT
      },
      body: "data=" + encodeURIComponent(query)
    });
    if (!response.ok) {
      console.log("overpass: fetch failed: HTTP " + response.status);
      return null;
    }
    const json = await response.json();
    const elements = Array.isArray(json.elements) ? json.elements : [];
    const beaches = [];
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      const name = element.tags ? element.tags.name : null;
      if (!name) {
        continue;
      }
      let lat = null;
      let lon = null;
      if (typeof element.lat === "number" && typeof element.lon === "number") {
        lat = element.lat;
        lon = element.lon;
      } else if (element.center && typeof element.center.lat === "number" && typeof element.center.lon === "number") {
        lat = element.center.lat;
        lon = element.center.lon;
      }
      if (lat === null || lon === null) {
        continue;
      }
      beaches.push({
        osmType: element.type,
        osmId: element.id,
        name: name,
        lat: lat,
        lon: lon
      });
    }
    return beaches;
  } catch (err) {
    console.log("overpass: fetch failed: " + err.message);
    return null;
  }
}
