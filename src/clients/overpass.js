// src/clients/overpass.js
// Client for the Overpass API (OpenStreetMap). Used ONLY from the daily
// scheduled sync — never from the request path. Never throws across the
// module boundary: on any error, logs with console.log and returns null.

import { fetchJson } from "./http.js";

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
  const json = await fetchJson(OVERPASS_URL, {
    method: "POST",
    headers: { "User-Agent": OVERPASS_USER_AGENT },
    body: new URLSearchParams({ data: query }),
    label: "overpass: " + label
  });
  if (json === null) {
    return null;
  }
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
    "(\n" +
    "  way[\"natural\"=\"water\"](around.b:60);\n" +
    "  way[\"natural\"=\"coastline\"](around.b:60);\n" +
    ")->.water;\n" +
    ".b out tags bb;\n" +
    ".parks out tags bb;\n" +
    ".water out tags bb;";
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

// --- Pond filtering -------------------------------------------------------
// The park-containment query keeps UNNAMED beaches, which sweeps in tiny sand
// patches on ponds inside named parks (real case: Hawthorn Pond Natural Area,
// Holland Twp MI — a 5 m x 6 m unnamed beach way on a ~180 m pond became a
// full beach row named after the park). Beach size alone cannot separate these
// from real beaches: verified against live data, sub-100 m² unnamed slivers
// sit on Lake Erie, Torch Lake, and Mullett Lake. The separating signal is the
// ADJACENT WATER BODY's size, so the query also fetches natural=water within
// 60 m of every candidate beach and the client drops unnamed beaches whose
// nearby water is ALL smaller than WATER_MIN_AREA_DEG2.
//
// The water fetch is WAYS ONLY — around on natural=water RELATIONS forces the
// server to load the Great Lakes multipolygons' full geometry and is
// pathological (verified 2026-07-17: >10 min server-side vs 72 s without;
// [timeout:180] would kill it nightly). Ponds are essentially always closed
// ways, so way-water carries the entire pond signal. natural=coastline ways
// are fetched as cheap positive large-water evidence so a Great Lakes
// shorefront beach whose lake is relation-mapped still associates with big
// water. Known residual exposure: a beach on a relation-mapped INLAND lake
// whose only nearby way-water is a small pond would be wrongly dropped —
// rare, and a beach with no nearby way-water at all is kept.
//
// ~5e-6 deg² ≈ 45,000 m² (~4.5 ha) bbox at Michigan latitudes — between the
// classic pond/lake boundary and the smallest observed real swim lakes with
// ~2x margin each way (Hawthorn Pond bbox ≈ 2.5e-6; Hawk Lake, the smallest
// lake with a real township swim beach in the pilot bbox, ≈ 1.2e-5).
export const WATER_MIN_AREA_DEG2 = 0.000005;

// Beach bbox is padded by ~100 m when matching water bboxes so a beach that
// stops short of the waterline still associates with its water body.
const WATER_MATCH_PADDING_DEG = 0.001;

// Pure; exported for tests. Splits raw Overpass elements (from the park-beach
// query) into beach, park, and water records. An element tagged both
// natural=beach and park-ish is treated as a beach only. Elements without
// usable coordinates are skipped.
export function parseParkBeachElements(elements) {
  const beaches = [];
  const parks = [];
  const waters = [];
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
      // Before the water branch: a named protected lake (park tags +
      // natural=water) must keep donating its name to contained beaches —
      // losing its water role only errs toward KEEPING a beach.
      parks.push({
        osmType: element.type,
        osmId: element.id,
        name: tags.name,
        bounds: bounds,
        areaDeg2: bboxAreaDeg2(bounds)
      });
    } else if (tags.natural === "water" || tags.natural === "coastline") {
      // A coastline way IS the shoreline of sea-sized water (the Great Lakes
      // use coastline tagging), so it counts as large regardless of its own
      // segment bbox.
      waters.push({
        bounds: bounds,
        areaDeg2: bboxAreaDeg2(bounds),
        shoreline: tags.natural === "coastline"
      });
    }
  }
  return { beaches: beaches, parks: parks, waters: waters };
}

function boundsOverlap(a, b) {
  return a.minLat <= b.maxLat && a.maxLat >= b.minLat &&
    a.minLon <= b.maxLon && a.maxLon >= b.minLon;
}

// Pure; exported for tests. True when the beach sits ONLY on pond-sized water:
// at least one water bbox overlaps its (padded) bbox and every overlapping one
// is smaller than WATER_MIN_AREA_DEG2 (a shoreline record — a coastline way —
// always counts as large). A beach with NO mapped water nearby returns false —
// missing data must never drop a beach, only positive evidence that all its
// water is tiny.
export function isPondBeach(beach, waters) {
  const padded = {
    minLat: beach.bounds.minLat - WATER_MATCH_PADDING_DEG,
    minLon: beach.bounds.minLon - WATER_MATCH_PADDING_DEG,
    maxLat: beach.bounds.maxLat + WATER_MATCH_PADDING_DEG,
    maxLon: beach.bounds.maxLon + WATER_MATCH_PADDING_DEG
  };
  let sawWater = false;
  for (let i = 0; i < waters.length; i++) {
    const water = waters[i];
    if (boundsOverlap(padded, water.bounds)) {
      if (water.shoreline === true || water.areaDeg2 >= WATER_MIN_AREA_DEG2) {
        return false;
      }
      sawWater = true;
    }
  }
  return sawWater;
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
  let droppedPond = 0;
  for (let i = 0; i < parsed.beaches.length; i++) {
    const beach = parsed.beaches[i];
    // Pond filter applies to UNNAMED beaches only: they become rows purely by
    // park inference, so they need the water evidence. A beach someone named
    // in OSM is kept regardless (it also arrives via the named-beach query).
    if (beach.name === null && isPondBeach(beach, parsed.waters)) {
      droppedPond = droppedPond + 1;
      continue;
    }
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
  if (droppedPond > 0) {
    console.log("overpass: park beaches dropped " + String(droppedPond) + " unnamed pond beaches");
  }
  return out;
}
