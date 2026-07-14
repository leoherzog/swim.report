// src/clients/overpass.js
// Client for the Overpass API (OpenStreetMap). Used ONLY from the daily
// scheduled sync — never from the request path. Never throws across the
// module boundary: on any error, logs with console.log and returns null.

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// overpass-api.de rejects requests without a User-Agent with HTTP 406, and
// Workers' fetch sends none by default.
export const OVERPASS_USER_AGENT = "swim.report (hello@swim.report)";

function bboxLine(bbox) {
  return "(" + bbox.minLat + "," + bbox.minLon + "," + bbox.maxLat + "," + bbox.maxLon + ")";
}

function buildQuery(bbox) {
  const bb = bboxLine(bbox);
  return "[out:json][timeout:60];\n" +
    "(\n" +
    "  nwr[\"natural\"=\"beach\"][\"name\"]" + bb + ";\n" +
    "  nwr[\"leisure\"=\"beach_resort\"][\"name\"]" + bb + ";\n" +
    ");\n" +
    "out center tags;";
}

async function runQuery(query, label) {
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
      console.log("overpass: " + label + " fetch failed: HTTP " + response.status);
      return null;
    }
    const json = await response.json();
    // Overpass reports server-side runtime failures (most commonly the query
    // hitting its [timeout:N] mid-output) via a "remark" field on an otherwise
    // HTTP-200 body — and the elements array is then silently TRUNCATED. A
    // partial element set must be treated as a failed fetch, never success:
    // the sync's reconciliation pass would read every missing element as
    // "gone from OSM" and delete legitimate beach rows.
    if (typeof json.remark === "string" && json.remark.length > 0) {
      console.log(
        "overpass: " + label + " query returned remark (treating as failure): " + json.remark
      );
      return null;
    }
    return Array.isArray(json.elements) ? json.elements : [];
  } catch (err) {
    console.log("overpass: " + label + " fetch failed: " + err.message);
    return null;
  }
}

export async function fetchBeaches(bbox) {
  const elements = await runQuery(buildQuery(bbox), "beaches");
  if (elements === null) {
    return null;
  }
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
}

// --- Park containment ---------------------------------------------------
// Most OSM mappers name the park polygon (Holland State Park) and leave the
// beach way inside it unnamed, so the named-beach query above misses most
// state park swim beaches entirely. This second query finds every
// natural=beach element (named or not) that intersects a NAMED park-ish
// polygon, plus all named park-ish polygons in the bbox with their bounding
// boxes, so the caller can attach the park name people actually search for.
//
// The park tag set is deliberately broad — verified against real data:
// Van Buren State Park (MI) is leisure=nature_reserve + boundary=protected_area,
// not leisure=park, so all three filters are required.
//
// Association is done locally by bounding-box OVERLAP (not center-in-bbox):
// Overpass area matching is intersection-based, and shoreline beach polygons
// commonly bulge lakeward past the park boundary, pulling their center
// outside the park bbox. Smallest overlapping park bbox wins so a nested
// specific park beats a containing forest or protected area.

function buildParkBeachQuery(bbox) {
  const bb = bboxLine(bbox);
  return "[out:json][timeout:180];\n" +
    "(\n" +
    "  way[\"leisure\"=\"park\"][\"name\"]" + bb + ";\n" +
    "  relation[\"leisure\"=\"park\"][\"name\"]" + bb + ";\n" +
    "  way[\"leisure\"=\"nature_reserve\"][\"name\"]" + bb + ";\n" +
    "  relation[\"leisure\"=\"nature_reserve\"][\"name\"]" + bb + ";\n" +
    "  way[\"boundary\"=\"protected_area\"][\"name\"]" + bb + ";\n" +
    "  relation[\"boundary\"=\"protected_area\"][\"name\"]" + bb + ";\n" +
    ")->.parks;\n" +
    ".parks map_to_area->.pa;\n" +
    "nwr[\"natural\"=\"beach\"](area.pa)" + bb + "->.b;\n" +
    ".b out tags bb;\n" +
    ".parks out tags bb;";
}

function elementBounds(element) {
  if (typeof element.lat === "number" && typeof element.lon === "number") {
    return { minLat: element.lat, minLon: element.lon, maxLat: element.lat, maxLon: element.lon };
  }
  const b = element.bounds;
  if (b &&
      typeof b.minlat === "number" && typeof b.minlon === "number" &&
      typeof b.maxlat === "number" && typeof b.maxlon === "number") {
    return { minLat: b.minlat, minLon: b.minlon, maxLat: b.maxlat, maxLon: b.maxlon };
  }
  return null;
}

function bboxAreaDeg2(bounds) {
  return (bounds.maxLat - bounds.minLat) * (bounds.maxLon - bounds.minLon);
}

function isParkTagged(tags) {
  return tags.leisure === "park" ||
    tags.leisure === "nature_reserve" ||
    tags.boundary === "protected_area";
}

// Pure; exported for tests. Splits raw Overpass elements (from the park-beach
// query) into beach and park records. An element tagged both natural=beach
// and park-ish is treated as a beach only. Elements without usable
// coordinates are skipped.
export function parseParkBeachElements(elements) {
  const beaches = [];
  const parks = [];
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    const tags = element.tags || {};
    const bounds = elementBounds(element);
    if (bounds === null) {
      continue;
    }
    if (tags.natural === "beach") {
      beaches.push({
        osmType: element.type,
        osmId: element.id,
        name: tags.name || null,
        // Secondary locality label carried on the beach element's OWN tags
        // (loc_name — a local/unofficial name like "Hamlin Lake"). Feeds
        // deriveUnnamedSuffix in src/index.js so a park's secondary unnamed
        // beach can be labeled by its water body instead of a bare compass
        // direction. Never substitutes for tags.name.
        locality: (typeof tags.loc_name === "string" && tags.loc_name.trim() !== "")
          ? tags.loc_name.trim()
          : null,
        lat: (bounds.minLat + bounds.maxLat) / 2,
        lon: (bounds.minLon + bounds.maxLon) / 2,
        bounds: bounds,
        areaDeg2: bboxAreaDeg2(bounds)
      });
    } else if (tags.name && isParkTagged(tags)) {
      parks.push({
        osmType: element.type,
        osmId: element.id,
        name: tags.name,
        bounds: bounds,
        areaDeg2: bboxAreaDeg2(bounds)
      });
    }
  }
  return { beaches: beaches, parks: parks };
}

function boundsOverlap(a, b) {
  return a.minLat <= b.maxLat && a.maxLat >= b.minLat &&
    a.minLon <= b.maxLon && a.maxLon >= b.minLon;
}

// Pure; exported for tests. Returns the smallest-bbox park whose bounding box
// overlaps the beach's bounding box, or null when none overlaps.
export function associateParkForBeach(beach, parks) {
  let best = null;
  for (let i = 0; i < parks.length; i++) {
    const park = parks[i];
    if (boundsOverlap(beach.bounds, park.bounds)) {
      if (best === null || park.areaDeg2 < best.areaDeg2) {
        best = park;
      }
    }
  }
  return best;
}

// Fetches beaches that intersect named park polygons (unnamed beaches
// included) and attaches the containing park. Returns an array of
//   { osmType, osmId, name: string|null, locality: string|null, lat, lon,
//     areaDeg2, parkName: string|null, parkKey: string|null }
// (parkKey identifies the park ELEMENT — two same-named parks in different
// towns stay distinct; locality is the element's own loc_name tag, if any)
// or null on any failure.
export async function fetchParkBeaches(bbox) {
  const elements = await runQuery(buildParkBeachQuery(bbox), "park beaches");
  if (elements === null) {
    return null;
  }
  const parsed = parseParkBeachElements(elements);
  const out = [];
  for (let i = 0; i < parsed.beaches.length; i++) {
    const beach = parsed.beaches[i];
    const park = associateParkForBeach(beach, parsed.parks);
    out.push({
      osmType: beach.osmType,
      osmId: beach.osmId,
      name: beach.name,
      locality: beach.locality,
      lat: beach.lat,
      lon: beach.lon,
      areaDeg2: beach.areaDeg2,
      parkName: park === null ? null : park.name,
      parkKey: park === null ? null : park.osmType + "/" + String(park.osmId)
    });
  }
  return out;
}
