// src/layerDiscovery.js — beach discovery over PREBUILT SPATIAL LAYERS.
//
// This is the replacement for runDiscovery() in scripts/discovery-batch.js:
// same product, different transport. Where the old pass tiled the regions and
// asked Overpass two questions per tile ("named beaches here" and "beaches
// intersecting a named park polygon here, plus the water near them"), this one
// is handed five already-downloaded, already-clipped layer arrays and answers
// both questions locally, with no network at all.
//
// It returns EXACTLY the shape runDiscovery returned — { namedRows,
// parkBeaches } plus a diagnostic count bag — so everything downstream of the
// splice point (mergeBeachRows, upsertSql, reconcileStaleRows) is untouched.
//
// Pure: no fetch, no Date, no Deno, no npm. Imports only src/osmSelect.js,
// src/layerGrid.js, src/geo.js and src/regions.js. Runs identically under Deno
// (the offline batch) and under vitest.
//
// WHAT THIS FILE IS ACTUALLY REPRODUCING
// --------------------------------------
// Overpass was doing four things for us implicitly, and every one of them has
// to be rebuilt by hand here or a beach silently stops existing:
//
//   1. THE BBOX. Overpass only ever saw the tiles we asked for, so the result
//      set was scoped to REGIONS by construction. A prebuilt layer is cut with
//      a single -spat rectangle over the union of REGIONS, which is a very
//      different thing — see step 0.
//   2. (area.pa) MEMBERSHIP. "nwr[natural=beach](area.pa)" is an INTERSECTION
//      test against the named park polygons, and it is what turns an unnamed
//      sand way inside a state park into a row at all — see step 4.
//   3. THE SMALLEST-OVERLAPPING-PARK ASSOCIATION, which is local logic we
//      already own (associateParkForBeach) but which now has to be fed a
//      candidate list a grid produced rather than the whole park array — see
//      step 5.
//   4. (around.b:60) POND EVIDENCE. A server-side buffer around a SET of seed
//      ways, gathering the water that decides whether an unnamed sliver is a
//      real beach or a sand patch on a pond — see step 6, which is the
//      subtlest part of this file by a wide margin.
//
// Everything else — the size thresholds, the tag allowlist, the pond rule, the
// association rule, the field derivations — lives in src/osmSelect.js and is
// used here verbatim. This file is the WIRING, and the wiring is where a
// migration like this goes wrong.

import { pointInAnyRegion } from "./regions.js";
import {
  KM_PER_DEG,
  geometryLines,
  geometryPolygons,
  minGeometryDistanceKm,
  pointInGeometry
} from "./geo.js";
import { buildLayerGrid, queryGridByBounds } from "./layerGrid.js";
import {
  POND_EVIDENCE_RADIUS_M,
  POND_TEST_MAX_BEACH_AREA_DEG2,
  associateParkForBeach,
  beachRecord,
  envelopeCenter,
  isPondBeach,
  isParkTagged,
  parkRecord,
  pondWaterSeeds,
  probeVertices,
  sortLayerFeatures,
  waterRecord
} from "./osmSelect.js";

// --- small shared helpers --------------------------------------------------

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// A bounds rectangle is usable only when all four ordinates are finite. The
// record builders in osmSelect apply the same test and return null; this copy
// exists so step 0 can reject a broken feature BEFORE it derives a centre from
// NaN and asks pointInAnyRegion about it.
function hasUsableBounds(bounds) {
  return bounds !== null && typeof bounds === "object" &&
    Number.isFinite(bounds.minLat) && Number.isFinite(bounds.minLon) &&
    Number.isFinite(bounds.maxLat) && Number.isFinite(bounds.maxLon);
}

// The (type, id) identity of an OSM element, in the same "way/12345" form
// dedupByOsm and parkKey use. Ids are numbers on a LayerFeature and were
// numbers on an Overpass element, so String() is the only normalisation.
function osmKey(osmType, osmId) {
  return osmType + "/" + String(osmId);
}

// First-seen dedupe by (type, id), replicating dedupByOsm in
// scripts/discovery-batch.js. Overpass returned the same element once per tile
// it touched (tiles overlap by TILE_OVERLAP_DEG), so the old pass deduped both
// output lists; layers have no tiles and should produce no duplicates at all,
// but a way that lands in two source layers (a closed way GDAL emits to both
// lines and multipolygons, say) would otherwise be upserted twice with
// different geometry. Keeping the dedupe makes the layer path's output
// identical to the Overpass path's on any input, including a malformed one.
function dedupByOsm(list) {
  const byKey = new Map();
  for (let i = 0; i < list.length; i++) {
    const key = osmKey(list[i].osmType, list[i].osmId);
    if (!byKey.has(key)) {
      byKey.set(key, list[i]);
    }
  }
  return Array.from(byKey.values());
}

// The longitude half of a latitude-degree pad, at this latitude. A degree of
// longitude shrinks with cos(lat), so a pad expressed in degrees of latitude
// has to be divided by cos(lat) to reach the same ground distance east-west.
// The floor keeps the division finite near the poles; at Great Lakes latitudes
// it never binds.
function lonPadFor(lat, padDeg) {
  const cosLat = Math.cos(lat * Math.PI / 180);
  return padDeg / Math.max(Math.abs(cosLat), 0.01);
}

// --- branch precedence (the parseParkBeachElements chain) ------------------
//
// parseParkBeachElements was ONE loop with an if / else-if chain over every
// element the park query returned, and the chain ORDER was load-bearing:
//
//   1. natural=beach            -> a beach, even if it is ALSO park-tagged.
//   2. named AND park-tagged    -> a park.
//   3. natural=water|coastline  -> water evidence.
//
// Branch 2 precedes branch 3 for a specific reason worth repeating wherever
// the order is written down: a named protected lake carries park tags AND
// natural=water, and it must keep donating its name to the beaches inside it.
// Losing its water role only errs toward KEEPING a beach (the safe direction);
// losing its park role would unname beaches and delete their park-origin rows.
//
// The layers arrive pre-split into beach / park / water files, so nothing else
// forces the three tests to be applied in order any more — which is exactly
// why they are applied in order HERE, explicitly, rather than being left to
// the layer a feature happened to come from. A build-side -where clause that
// drifts (a park polygon that also carries natural=beach landing in
// parks-polygon.fgb) must produce the same answer it produced under Overpass.
//
// Returns { kind, record } with kind one of "beach" | "park" | "water", or
// null when the feature is none of the three or has no usable bounds.
export function classifyLayerFeature(feature) {
  if (feature === null || typeof feature !== "object") {
    return null;
  }
  const tags = feature.tags || {};
  if (tags.natural === "beach") {
    const record = beachRecord(feature);
    return record === null ? null : { kind: "beach", record: record };
  }
  if (tags.name && isParkTagged(tags)) {
    const record = parkRecord(feature);
    return record === null ? null : { kind: "park", record: record };
  }
  if (tags.natural === "water" || tags.natural === "coastline") {
    const record = waterRecord(feature);
    return record === null ? null : { kind: "water", record: record };
  }
  return null;
}

// --- step 4: (area.pa) membership ------------------------------------------

// True when a geometry has the ring / line / point structure the exact
// membership tests need. GDAL emits GeometryCollection for the other_relations
// layer, and a GeometryCollection assembled from a relation's members has no
// reliable ring structure: feeding it to pointInGeometry would answer "not
// inside" for every point, which is the DELETE direction. Those features fall
// back to envelope overlap instead — a documented KEEP-direction widening
// (1.4). A feature with no geometry at all takes the same fallback for the
// same reason.
function hasReliableGeometry(geometry) {
  if (geometry === null || typeof geometry !== "object") {
    return false;
  }
  const type = geometry.type;
  return type === "Point" || type === "MultiPoint" ||
    type === "LineString" || type === "MultiLineString" ||
    type === "Polygon" || type === "MultiPolygon";
}

// Every closed ring and open line of a geometry, as arrays of [lon, lat]
// positions. Polygon rings and linestrings are the same thing for a crossing
// test — a ring is just a line whose ends meet — so they are returned in one
// flat list.
function geometryRingsAndLines(geometry) {
  const out = [];
  const polygons = geometryPolygons(geometry);
  for (let i = 0; i < polygons.length; i++) {
    const rings = polygons[i];
    if (!Array.isArray(rings)) {
      continue;
    }
    for (let r = 0; r < rings.length; r++) {
      if (Array.isArray(rings[r]) && rings[r].length > 1) {
        out.push(rings[r]);
      }
    }
  }
  const lines = geometryLines(geometry);
  for (let i = 0; i < lines.length; i++) {
    if (Array.isArray(lines[i]) && lines[i].length > 1) {
      out.push(lines[i]);
    }
  }
  return out;
}

// Orientation sign of the triplet (a, b, c) in the lon/lat plane. Returns a
// number whose SIGN is what matters: negative / zero / positive for clockwise,
// collinear, counter-clockwise.
function orientation(ax, ay, bx, by, cx, cy) {
  return (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
}

// True when the closed segments p1-p2 and p3-p4 intersect, including the
// collinear-overlap and shared-endpoint cases. Standard orientation test.
// Touching COUNTS as intersecting, deliberately and for the same reason
// boundsOverlap is inclusive: OSM mappers routinely draw a beach way whose
// boundary shares nodes with the park boundary, and Overpass's area matching
// admitted those.
function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = orientation(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1]);
  const d2 = orientation(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1]);
  const d3 = orientation(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  const d4 = orientation(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1]);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  // Collinear / touching cases: a zero orientation plus containment in the
  // other segment's bounding box.
  if (d1 === 0 && onSegment(p3, p4, p1)) { return true; }
  if (d2 === 0 && onSegment(p3, p4, p2)) { return true; }
  if (d3 === 0 && onSegment(p1, p2, p3)) { return true; }
  if (d4 === 0 && onSegment(p1, p2, p4)) { return true; }
  return false;
}

// True when point q lies within the bounding box of the collinear segment a-b.
function onSegment(a, b, q) {
  return Math.min(a[0], b[0]) <= q[0] && q[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= q[1] && q[1] <= Math.max(a[1], b[1]);
}

// True when any segment of the beach geometry crosses any ring of the park
// geometry.
//
// WHY THE CROSSING TEST IS REQUIRED AND NOT AN OPTIMISATION (m8). Overpass's
// (area.pa) is an INTERSECTION test: a way that enters a park and leaves it
// again is inside the area even if not one of its vertices is. A
// vertex-in-polygon test alone is therefore a strict SUBSET of what Overpass
// admitted, and a subset of the park-membership set is a subset of the
// park-origin ROWS — which reconcileStaleRows reads as "gone from OSM" and
// DELETES. Membership decides EXISTENCE here, so the only acceptable error
// direction is admitting slightly too much.
function geometriesCross(beachGeometry, parkGeometry) {
  const beachLines = geometryRingsAndLines(beachGeometry);
  if (beachLines.length === 0) {
    return false;
  }
  const parkLines = geometryRingsAndLines(parkGeometry);
  if (parkLines.length === 0) {
    return false;
  }
  for (let a = 0; a < beachLines.length; a++) {
    const bl = beachLines[a];
    for (let i = 0; i + 1 < bl.length; i++) {
      const p1 = bl[i];
      const p2 = bl[i + 1];
      if (!Array.isArray(p1) || !Array.isArray(p2)) {
        continue;
      }
      for (let b = 0; b < parkLines.length; b++) {
        const pl = parkLines[b];
        for (let j = 0; j + 1 < pl.length; j++) {
          const p3 = pl[j];
          const p4 = pl[j + 1];
          if (!Array.isArray(p3) || !Array.isArray(p4)) {
            continue;
          }
          if (segmentsIntersect(p1, p2, p3, p4)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

// The (area.pa) reproduction. A beach is a member of the park set iff some
// probe vertex of the beach is INSIDE some named park polygon, or some beach
// segment CROSSES some park ring.
//
// Candidates come from the parks-polygon envelope grid, queried by the beach's
// own bounding box rather than by its vertices. Bbox-to-bbox is the right
// query here and vertex-to-bbox is not: a beach whose only relationship with a
// park is a segment crossing its boundary can have every vertex outside the
// park envelope, and the vertex query would never surface the park at all. The
// grid is a CANDIDACY filter — queryGridByBounds' overlap test is byte-for-byte
// boundsOverlap, so its result is exactly the set the exact tests below could
// possibly accept, and the exact tests then decide.
//
// parksPoly is parks-polygon and NOTHING ELSE (D7/M1). map_to_area silently
// converts nothing for an unclosed named way or an unassemblable relation, so
// membership is polygon-only; naming is not, and uses the wider parksName tier
// in step 5.
export function beachInAnyParkPolygon(beach, geometry, parksPoly, parksPolyGrid) {
  const candidates = queryGridByBounds(parksPolyGrid, beach.bounds);
  if (candidates.length === 0) {
    return false;
  }
  // Envelope-only features (other-relations GeometryCollections, and anything
  // with no usable geometry) are admitted on envelope overlap alone, which the
  // grid query has already established.
  if (!hasReliableGeometry(geometry)) {
    return true;
  }
  const vertices = Array.isArray(beach.vertices) ? beach.vertices : [];
  for (let c = 0; c < candidates.length; c++) {
    const park = parksPoly[candidates[c]];
    if (park === undefined) {
      continue;
    }
    // The mirror of the beach-side fallback above, and it exists for the same
    // delete-direction reason. parks-polygon is polygon-only by construction,
    // so a park record here normally carries real rings — but if the reader
    // ever hands back a feature whose geometry failed to decode (a null
    // geometry, a GeometryCollection), pointInGeometry and geometriesCross
    // both answer "no" for EVERY beach in that park, and every one of its
    // unnamed park-origin rows becomes a name === park_name stale row that
    // reconcileStaleRows deletes. Under Overpass, map_to_area produced an area
    // for exactly these elements (a closed way or an assemblable relation is
    // what lands in parks-polygon at all), so admitting on the envelope
    // overlap the grid already established is the parity-preserving answer as
    // well as the safe one.
    if (!hasReliableGeometry(park.geometry)) {
      return true;
    }
    for (let v = 0; v < vertices.length; v++) {
      if (pointInGeometry(park.geometry, vertices[v].lat, vertices[v].lon)) {
        return true;
      }
    }
    if (geometriesCross(geometry, park.geometry)) {
      return true;
    }
  }
  return false;
}

// --- step 6: the pooled pond-evidence set ----------------------------------

// True when a seed beach and a water feature are within POND_EVIDENCE_RADIUS_M
// of each other, measured GEOMETRY TO GEOMETRY.
//
// This is the shape of Overpass's around.b:60 and getting it wrong in either
// direction moves real rows. The seed set .b was built with way(id:...) and NO
// recurse-down, so the server buffered each seed way's FULL linestring, not its
// nodes — the distance is between two polylines, not between a point set and a
// polyline. It is computed symmetrically:
//
//   min( min over WATER vertices of distance-to-SEED-geometry,
//        min over SEED  vertices of distance-to-WATER-geometry )
//
// which is EXACT for non-intersecting polylines — the minimum distance between
// two disjoint segments is always attained at an endpoint of one of them — and
// returns a small positive number for crossing ones, comfortably under 60 m
// either way. Both halves are needed: a long water way passing beside a short
// beach has no vertex near it, and a long beach way passing beside a small pond
// is the mirror case.
//
// Early-exits on the first hit: this is a threshold question, never "how far".
function withinPondEvidenceRadius(seed, water, waterVertices, radiusKm) {
  const seedGeometry = seed.geometry;
  if (seedGeometry !== null && typeof seedGeometry === "object") {
    for (let i = 0; i < waterVertices.length; i++) {
      if (minGeometryDistanceKm(seedGeometry, waterVertices[i].lat, waterVertices[i].lon) <= radiusKm) {
        return true;
      }
    }
  }
  const waterGeometry = water.geometry;
  if (waterGeometry !== null && typeof waterGeometry === "object") {
    const vertices = Array.isArray(seed.vertices) ? seed.vertices : [];
    for (let i = 0; i < vertices.length; i++) {
      if (minGeometryDistanceKm(waterGeometry, vertices[i].lat, vertices[i].lon) <= radiusKm) {
        return true;
      }
    }
  }
  return false;
}

// Builds the RUN-SCOPED pond-evidence pool: every way-tagged water or
// coastline feature within POND_EVIDENCE_RADIUS_M of the geometry of SOME
// seed beach.
//
// THIS IS THE POOL, AND IT IS POOLED ON PURPOSE (B1/BL-1). The obvious
// translation of around.b:60 — filter water per beach, at 60 m, inside the
// pond test — is WRONG, and wrong in the delete direction. Production gathered
// the evidence ONCE per tile, seeded by every small beach in the tile
// INCLUDING NAMED ONES (see pondWaterSeeds, whose comment states exactly why),
// and then bounded it per beach only through isPondBeach's own +/-0.001 deg
// (~111 m) padded-bbox overlap. A per-beach 60 m set is a strict subset of
// that: an unnamed park beach whose only large-water evidence came from a
// NEIGHBOURING named beach's seed would lose that evidence, be dropped as a
// pond sliver, become a name === park_name stale row, and be DELETED by
// reconcileStaleRows well inside every proportional rail.
//
// THE ONE ACCEPTED DEVIATION: the pool widens from PER-TILE to PER-RUN,
// because there are no tiles any more. isPondBeach's ~111 m bbox bound means
// this can only matter for an unnamed park beach with a pond within ~111 m
// that is more than 60 m from every small beach in its own old tile but within
// 60 m of a small beach in an adjacent one. That is a tiny class and its
// direction is toward DROPPING, so it is the one part of this fix that is not
// automatically delete-safe: the dry-run diff must list every id it affects
// rather than asserting it away.
//
// waterFeatures must already be filtered to osmType === "way" — see the
// caller. Returns water records in input order; isPondBeach's answer does not
// depend on the order, but a stable one keeps diffs readable.
export function poolPondWaters(seeds, waterFeatures, radiusM) {
  if (seeds.length === 0 || waterFeatures.length === 0) {
    return [];
  }
  const radiusKm = (typeof radiusM === "number" ? radiusM : POND_EVIDENCE_RADIUS_M) / 1000;
  const padDeg = radiusKm / KM_PER_DEG;
  const seedGrid = buildLayerGrid(seeds);
  const pooled = [];
  for (let w = 0; w < waterFeatures.length; w++) {
    const feature = waterFeatures[w];
    const water = waterRecord(feature);
    if (water === null) {
      continue;
    }
    // Candidacy bound: every seed whose ENVELOPE comes within the radius of
    // this water feature's envelope. A seed within radiusKm of the water
    // geometry necessarily satisfies this, so the exact test below never
    // misses one; without a bound the pass is O(waters x seeds) over the whole
    // run, which is what makes the continental target intractable.
    const midLat = (water.bounds.minLat + water.bounds.maxLat) / 2;
    const lonPad = lonPadFor(midLat, padDeg);
    const paddedWaterBounds = {
      minLat: water.bounds.minLat - padDeg,
      maxLat: water.bounds.maxLat + padDeg,
      minLon: water.bounds.minLon - lonPad,
      maxLon: water.bounds.maxLon + lonPad
    };
    const candidates = queryGridByBounds(seedGrid, paddedWaterBounds);
    if (candidates.length === 0) {
      continue;
    }
    const waterVertices = probeVertices(feature);
    for (let c = 0; c < candidates.length; c++) {
      const seed = seeds[candidates[c]];
      if (seed === undefined) {
        continue;
      }
      if (withinPondEvidenceRadius(seed, water, waterVertices, radiusKm)) {
        pooled.push(water);
        break;
      }
    }
  }
  return pooled;
}

// --- the splice point ------------------------------------------------------

// Replaces runDiscovery(). Returns { namedRows, parkBeaches, layerCounts };
// namedRows and parkBeaches are byte-for-byte the shapes fetchBeaches and
// fetchParkBeaches produced, so mergeBeachRows and everything below it are
// untouched. namedComplete is NOT returned — under layers, coverage is no
// longer a property of how many tiles answered, it is a property of the
// manifest (see src/layerManifest.js), and the caller owns that gate.
//
// layers: {
//   beaches:   beaches-point + beaches-line + beaches-polygon + the beach half
//              of other-relations
//   parksPoly: parks-polygon — MEMBERSHIP + naming
//   parksName: parks-polygon + parks-line + the park half of other-relations —
//              NAMING ONLY
//   coastline: coastline-line
//   water:     water-line + water-polygon
// }
export function discoverFromLayers(layers) {
  const input = layers === null || typeof layers !== "object" ? {} : layers;

  // Step 1. Deterministic scan order on every input array, BEFORE anything
  // reads them. FlatGeobuf stores features in Hilbert order, which is stable
  // per file and reshuffles on every rebuild; associateParkForBeach's
  // equal-area tie and mergeBeachRows' duplicate-id rule both resolve by first
  // seen, so an unsorted input would flip park names between rebuilds.
  const beachFeatures = sortLayerFeatures(asArray(input.beaches));
  const parksPolyFeatures = sortLayerFeatures(asArray(input.parksPoly));
  const parksNameFeatures = sortLayerFeatures(asArray(input.parksName));
  const coastlineFeatures = sortLayerFeatures(asArray(input.coastline));
  const waterFeatures = sortLayerFeatures(asArray(input.water));

  // Step 0. REGION SCOPING — and it is step 0 in behaviour even though the
  // sort has to happen first, because nothing else may look at a beach feature
  // until this filter has.
  //
  // The published layers are cut with ONE -spat rectangle over the union of
  // REGIONS. src/regions.js:11-22 is a written argument against exactly that
  // rectangle: it encloses the entire continental interior between and around
  // the lakes — Wisconsin, lower Michigan, southern Ontario, upstate New York,
  // northern Indiana and Ohio — which is dense with inland-lake beach
  // elements. Under Overpass those never arrived, because we only ever queried
  // the coastal tiles.
  //
  // Admitting them would not merely be wasteful. Every one of them would be
  // UPSERTed, would sit OUTSIDE every REGIONS bbox, and would therefore be
  // PERMANENTLY UN-DELETABLE, because reconcileStaleRows scopes its delete
  // candidates with pointInAnyRegion and would never consider them again. It
  // would also blow the 11-column D1 --json snapshot past its size cap, which
  // aborts the only delete path there is.
  //
  // Applying pointInAnyRegion here is the first time the UPSERT universe and
  // the DELETE-CANDIDATE universe are the same set. It is measured on the
  // envelope centre, which is the same coordinate the row is written at.
  const inRegion = [];
  let outOfRegion = 0;
  for (let i = 0; i < beachFeatures.length; i++) {
    const feature = beachFeatures[i];
    const bounds = feature === null || typeof feature !== "object" ? null : feature.bounds;
    if (!hasUsableBounds(bounds)) {
      // No usable envelope means no derivable coordinate, so this could never
      // have become a row; it is counted with the out-of-region drops rather
      // than silently vanishing from the diagnostics.
      outOfRegion = outOfRegion + 1;
      continue;
    }
    const center = envelopeCenter(bounds);
    if (!pointInAnyRegion(center.lat, center.lon)) {
      outOfRegion = outOfRegion + 1;
      continue;
    }
    inRegion.push(feature);
  }

  // The named pass — the reproduction of buildQuery + fetchBeaches. Its filter
  // is the query's filter: a non-empty name AND (natural=beach OR
  // leisure=beach_resort). Coordinates are the envelope midpoint, which is
  // numerically what "out center" produced.
  const named = [];
  for (let i = 0; i < inRegion.length; i++) {
    const feature = inRegion[i];
    const tags = feature.tags || {};
    const name = tags.name;
    if (typeof name !== "string" || name === "") {
      continue;
    }
    if (tags.natural !== "beach" && tags.leisure !== "beach_resort") {
      continue;
    }
    const center = envelopeCenter(feature.bounds);
    named.push({
      osmType: feature.osmType,
      osmId: feature.osmId,
      name: name,
      lat: center.lat,
      lon: center.lon
    });
  }
  const namedRows = dedupByOsm(named);

  // Step 3. Beach candidates for the PARK pass: natural=beach, named or not.
  // leisure=beach_resort is deliberately absent — the park query ran
  // nwr[natural=beach](area.pa) and nothing else, so a beach_resort never
  // entered the park pass and never got a park name from it. Each candidate
  // keeps its source feature alongside its record: membership needs the raw
  // geometry, and the pond pool needs it too.
  const beachCandidates = [];
  for (let i = 0; i < inRegion.length; i++) {
    const feature = inRegion[i];
    const classified = classifyLayerFeature(feature);
    if (classified === null || classified.kind !== "beach") {
      continue;
    }
    beachCandidates.push({
      record: classified.record,
      geometry: feature.geometry,
      // The pond pool indexes seeds by envelope and probes them by geometry;
      // carrying bounds and vertices at the top level lets buildLayerGrid and
      // withinPondEvidenceRadius consume a candidate directly.
      bounds: classified.record.bounds,
      vertices: classified.record.vertices
    });
  }

  // Step 2. The two park tiers. parksPoly is MEMBERSHIP + naming and comes
  // from parks-polygon alone; parksName is NAMING ONLY and is the union of
  // parks-polygon, parks-line and the park half of other-relations. Merging
  // them would over-admit unnamed beaches into parks that have no assembled
  // area (map_to_area converts nothing for an unclosed named way or an
  // unassemblable relation); keeping only the polygon tier would unname
  // beaches whose park is line- or relation-mapped and delete their
  // park-origin rows. Both errors move rows, in opposite directions.
  const parksPoly = [];
  for (let i = 0; i < parksPolyFeatures.length; i++) {
    const classified = classifyLayerFeature(parksPolyFeatures[i]);
    if (classified !== null && classified.kind === "park") {
      parksPoly.push(classified.record);
    }
  }
  const parksName = [];
  for (let i = 0; i < parksNameFeatures.length; i++) {
    const classified = classifyLayerFeature(parksNameFeatures[i]);
    if (classified !== null && classified.kind === "park") {
      parksName.push(classified.record);
    }
  }

  // Step 6a. The pond-evidence SEED SET, straight from pondWaterSeeds — the
  // definition, not a query bound. Its three product rules all still apply:
  // an oversized beach never seeds and is never pond-tested, NAMED beaches DO
  // seed (their nearby water feeds neighbouring unnamed beaches' tests), and
  // an empty return means no unnamed candidate is under the cutoff so the
  // whole gather is skipped.
  const seedRecords = [];
  for (let i = 0; i < beachCandidates.length; i++) {
    seedRecords.push(beachCandidates[i].record);
  }
  const seedIds = pondWaterSeeds(seedRecords);
  const seedKeys = new Set();
  for (let i = 0; i < seedIds.length; i++) {
    seedKeys.add(osmKey(seedIds[i].osmType, seedIds[i].osmId));
  }
  const seeds = [];
  if (seedKeys.size > 0) {
    for (let i = 0; i < beachCandidates.length; i++) {
      const candidate = beachCandidates[i];
      if (seedKeys.has(osmKey(candidate.record.osmType, candidate.record.osmId))) {
        seeds.push(candidate);
      }
    }
  }

  // Step 6b. The water half of the pool: WAYS ONLY, from both the water and
  // the coastline logical layers. Ways-only is not a performance choice — the
  // production query ran way[natural=water](around.b:60) AND
  // way[natural=coastline](around.b:60), never relations, because an around
  // filter on natural=water RELATIONS forces the server to load the Great
  // Lakes multipolygons' full geometry and is pathological. Admitting
  // relations here would change what the pond filter sees.
  //
  // Every candidate still goes through the branch chain, exactly as production
  // did (fetchParkBeaches re-parsed the water response with the SHARED parser
  // so a named park-tagged lake routed to the park branch and contributed no
  // water evidence).
  const waterWayFeatures = [];
  for (let i = 0; i < waterFeatures.length; i++) {
    const feature = waterFeatures[i];
    if (feature === null || typeof feature !== "object" || feature.osmType !== "way") {
      continue;
    }
    const classified = classifyLayerFeature(feature);
    if (classified !== null && classified.kind === "water") {
      waterWayFeatures.push(feature);
    }
  }
  for (let i = 0; i < coastlineFeatures.length; i++) {
    const feature = coastlineFeatures[i];
    if (feature === null || typeof feature !== "object" || feature.osmType !== "way") {
      continue;
    }
    const classified = classifyLayerFeature(feature);
    if (classified !== null && classified.kind === "water") {
      waterWayFeatures.push(feature);
    }
  }
  const pooledWaters = poolPondWaters(seeds, waterWayFeatures, POND_EVIDENCE_RADIUS_M);

  // Steps 4, 6d, 5, 7 — one pass per candidate, in production's order.
  // fetchParkBeaches ran the pond test BEFORE association and skipped the
  // association entirely for a dropped beach; the two are independent (a
  // beach's park does not depend on any other beach), so the output is
  // identical either way and doing the cheap drop first keeps the grid queries
  // off beaches that are about to be discarded.
  const parksPolyGrid = buildLayerGrid(parksPoly);
  const parksNameGrid = buildLayerGrid(parksName);
  const parkRows = [];
  let droppedPond = 0;
  let membershipRejected = 0;
  for (let i = 0; i < beachCandidates.length; i++) {
    const candidate = beachCandidates[i];
    const beach = candidate.record;
    if (!beachInAnyParkPolygon(beach, candidate.geometry, parksPoly, parksPolyGrid)) {
      membershipRejected = membershipRejected + 1;
      continue;
    }
    // The pond filter applies to UNNAMED beaches only: they become rows purely
    // by park inference, so they are the ones that need water evidence. A
    // beach someone named in OSM is kept regardless (it also arrives via the
    // named pass). Oversized beaches skip the test — they never seeded the
    // evidence pool, and a beach that big cannot sit only on pond-sized water.
    if (beach.name === null &&
        beach.areaDeg2 < POND_TEST_MAX_BEACH_AREA_DEG2 &&
        isPondBeach(beach, pooledWaters)) {
      droppedPond = droppedPond + 1;
      continue;
    }
    // Step 5. Association over the NAMING tier. Candidates come from the
    // envelope grid queried by the beach's UNPADDED bbox, which is exactly
    // what associateParkForBeach's own boundsOverlap tests, returned in
    // ascending original index order — so the smallest-area-then-FIRST-SEEN
    // tie-break resolves bit-identically to the full-list scan this replaces.
    // (Envelope overlap and not centre-containment is deliberate: shoreline
    // beach polygons commonly bulge lakeward past the park boundary, pulling
    // their centre outside the park bbox.)
    const candidateIdx = queryGridByBounds(parksNameGrid, beach.bounds);
    const candidateParks = [];
    for (let c = 0; c < candidateIdx.length; c++) {
      candidateParks.push(parksName[candidateIdx[c]]);
    }
    const park = associateParkForBeach(beach, candidateParks);
    // Step 7. The nine-field record — the exact shape fetchParkBeaches
    // emitted. bounds and vertices are deliberately dropped here: nothing
    // downstream of the splice point reads them, and carrying geometry into
    // the SQL builders is how a delta file grows by an order of magnitude.
    parkRows.push({
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
  const parkBeaches = dedupByOsm(parkRows);

  // Diagnostic only. Logged by the batch, consulted by NO gate — the delete
  // gate is the manifest (src/layerManifest.js) and the proportional rails in
  // scripts/discovery-batch.js, and wiring a count from here into either of
  // them would make a discovery-side bug able to authorise a mass delete.
  const layerCounts = {
    beaches: beachFeatures.length,
    parksPoly: parksPolyFeatures.length,
    parksName: parksNameFeatures.length,
    coastline: coastlineFeatures.length,
    water: waterFeatures.length,
    named: namedRows.length,
    parkBeaches: parkBeaches.length,
    droppedPond: droppedPond,
    membershipRejected: membershipRejected,
    outOfRegion: outOfRegion
  };

  return { namedRows: namedRows, parkBeaches: parkBeaches, layerCounts: layerCounts };
}
