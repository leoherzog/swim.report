// src/layerDiscovery.js — beach discovery over prebuilt spatial layers. It is
// handed five already-downloaded, already-clipped layer arrays and answers both
// discovery questions locally, with no network at all: which named beaches
// exist, and which unnamed sand ways sit inside a named park polygon.
//
// Returns { namedRows, parkBeaches } plus a diagnostic count bag, the shape
// everything downstream of the splice point (mergeBeachRows, upsertSql,
// reconcileStaleRows) consumes.
//
// Pure: no fetch, no Date, no Deno, no npm. Imports only src/osmSelect.js,
// src/layerGrid.js, src/geo.js and src/regions.js, and runs identically under
// Deno and under vitest.
//
// The size thresholds, tag allowlist, pond rule, association rule and field
// derivations all live in src/osmSelect.js. This file is the wiring: region
// scoping (step 0), park membership (step 4), park association (step 5) and the
// pooled pond evidence (step 6, the subtlest part by a wide margin).

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

// The (type, id) identity of an OSM element, in the "way/12345" form dedupByOsm
// and parkKey use.
function osmKey(osmType, osmId) {
  return osmType + "/" + String(osmId);
}

// First-seen dedupe by (type, id), matching dedupByOsm in
// scripts/discovery-batch.js. A well-formed layer set produces no duplicates,
// but a way landing in two source layers — a closed way GDAL emits to both lines
// and multipolygons — would otherwise be upserted twice with different
// geometry.
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

// --- branch precedence -----------------------------------------------------
//
// The chain order is load-bearing:
//
//   1. natural=beach            -> a beach, even if it is also park-tagged.
//   2. named and park-tagged    -> a park.
//   3. natural=water|coastline  -> water evidence.
//
// Branch 2 precedes branch 3 because a named protected lake carries park tags
// and natural=water and must keep donating its name to the beaches inside it.
// Losing its water role only errs toward keeping a beach; losing its park role
// would unname beaches and delete their park-origin rows.
//
// The layers arrive pre-split into beach / park / water files, so the three
// tests are applied here explicitly rather than left to the layer a feature came
// from: a build-side -where clause that drifts, putting a park polygon that also
// carries natural=beach into parks-polygon.fgb, must still get the right answer.
//
// Returns { kind, record } with kind one of "beach" | "park" | "water", or null
// when the feature is none of the three or has no usable bounds.
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
// layer, and one assembled from a relation's members has no reliable ring
// structure: feeding it to pointInGeometry answers "not inside" for every point,
// which is the delete direction. Those features, and features with no geometry
// at all, fall back to envelope overlap — a deliberate keep-direction
// widening.
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
// number whose sign is what matters: negative, zero or positive for clockwise,
// collinear, counter-clockwise.
function orientation(ax, ay, bx, by, cx, cy) {
  return (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
}

// True when the closed segments p1-p2 and p3-p4 intersect, including the
// collinear-overlap and shared-endpoint cases. Touching counts as intersecting,
// for the same reason boundsOverlap is inclusive: mappers routinely draw a beach
// way whose boundary shares nodes with the park boundary.
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
// The crossing test is required, not an optimisation. A way that enters a park
// and leaves it again is a member even if not one of its vertices is, so a
// vertex-in-polygon test alone is a strict subset of park membership — and a
// subset of the membership set is a subset of the park-origin rows, which
// reconcileStaleRows reads as "gone from OSM" and deletes. Membership decides
// existence, so the only acceptable error direction is admitting too much.
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

// Park membership: a beach is a member iff some probe vertex is inside some
// named park polygon, or some beach segment crosses some park ring.
//
// Candidates come from the parks-polygon envelope grid, queried by the beach's
// bounding box rather than by its vertices. A beach whose only relationship with
// a park is a segment crossing its boundary can have every vertex outside the
// park envelope, so a vertex query would never surface the park. The grid is a
// candidacy filter: queryGridByBounds' overlap test is byte-for-byte
// boundsOverlap, so its result is exactly the set the exact tests below could
// accept, and the exact tests then decide.
//
// parksPoly is parks-polygon and nothing else: membership is polygon-only,
// because an unclosed named way or an unassemblable relation has no area.
// Naming is not, and uses the wider parksName tier in step 5.
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
    // The mirror of the beach-side fallback above, for the same
    // delete-direction reason. If the reader hands back a park whose geometry
    // failed to decode, pointInGeometry and geometriesCross answer "no" for
    // every beach in that park, and each of its unnamed park-origin rows
    // becomes a stale row reconcileStaleRows deletes. Admitting on the envelope
    // overlap the grid already established is the safe answer.
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
// of each other, measured geometry to geometry — between two polylines, not
// between a point set and a polyline. Getting this wrong in either direction
// moves real rows. It is computed symmetrically:
//
//   min( min over water vertices of distance-to-seed-geometry,
//        min over seed  vertices of distance-to-water-geometry )
//
// which is exact for non-intersecting polylines, since the minimum distance
// between two disjoint segments is always attained at an endpoint of one of
// them, and returns a small positive number for crossing ones. Both halves are
// needed: a long water way passing beside a short beach has no vertex near it,
// and a long beach way passing beside a small pond is the mirror case.
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

// Builds the run-scoped pond-evidence pool: every way-tagged water or coastline
// feature within POND_EVIDENCE_RADIUS_M of the geometry of some seed beach.
//
// The pool is pooled per run on purpose. Filtering water per beach instead, at
// the same radius inside the pond test, is wrong in the delete direction: an
// unnamed park beach whose only large-water evidence comes from a neighbouring
// named beach's seed would lose that evidence, be dropped as a pond sliver,
// become a name === park_name stale row, and be deleted by reconcileStaleRows
// well inside every proportional rail. isPondBeach then bounds the pool per
// beach through its own +/-0.001 deg padded-bbox overlap.
//
// waterFeatures must already be filtered to osmType === "way". Returns water
// records in input order; isPondBeach does not depend on the order, but a stable
// one keeps diffs readable.
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
    // Candidacy bound: every seed whose envelope comes within the radius of
    // this water feature's envelope. A seed within radiusKm of the water
    // geometry necessarily satisfies this, so the exact test below never misses
    // one; without a bound the pass is O(waters x seeds) over the whole run.
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

// Returns { namedRows, parkBeaches, layerCounts }. Coverage is not reported
// here: it is a property of the manifest (src/layerManifest.js) and the caller
// owns that gate.
//
// layers: {
//   beaches:   beaches-point + beaches-line + beaches-polygon + the beach half
//              of other-relations
//   parksPoly: parks-polygon — membership and naming
//   parksName: parks-polygon + parks-line + the park half of other-relations,
//              naming only
//   coastline: coastline-line
//   water:     water-line + water-polygon
// }
export function discoverFromLayers(layers) {
  const input = layers === null || typeof layers !== "object" ? {} : layers;

  // Step 1. Deterministic scan order on every input array, before anything
  // reads them. FlatGeobuf stores features in Hilbert order, stable per file and
  // reshuffled on every rebuild; associateParkForBeach's equal-area tie and
  // mergeBeachRows' duplicate-id rule both resolve by first seen, so an unsorted
  // input would flip park names between rebuilds.
  const beachFeatures = sortLayerFeatures(asArray(input.beaches));
  const parksPolyFeatures = sortLayerFeatures(asArray(input.parksPoly));
  const parksNameFeatures = sortLayerFeatures(asArray(input.parksName));
  const coastlineFeatures = sortLayerFeatures(asArray(input.coastline));
  const waterFeatures = sortLayerFeatures(asArray(input.water));

  // Step 0. Region scoping — step 0 in behaviour even though the sort has to
  // happen first, because nothing else may look at a beach feature until this
  // filter has.
  //
  // The published layers are cut with one -spat rectangle over the union of the
  // boxes in src/regions.js, and that rectangle encloses the whole continental
  // interior between and around the lakes, which is dense with inland-lake beach
  // elements. Admitting them would upsert rows that sit outside every region
  // box, which makes them permanently un-deletable — reconcileStaleRows scopes
  // its delete candidates with pointInAnyRegion and would never consider them
  // again — and would blow the 11-column D1 --json snapshot past its size cap,
  // aborting the only delete path there is.
  //
  // pointInAnyRegion here is what makes the upsert universe and the
  // delete-candidate universe the same set. It is measured on the envelope
  // centre, the same coordinate the row is written at.
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

  // The named pass. Filter: a non-empty name and (natural=beach or
  // leisure=beach_resort). Coordinates are the envelope midpoint.
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

  // Step 3. Beach candidates for the park pass: natural=beach, named or not.
  // leisure=beach_resort is deliberately absent — a beach_resort never gets a
  // park name. Each candidate keeps its source feature alongside its record:
  // both membership and the pond pool need the raw geometry.
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

  // Step 2. The two park tiers. parksPoly is membership plus naming and comes
  // from parks-polygon alone; parksName is naming only and unions parks-polygon,
  // parks-line and the park half of other-relations. Merging them would
  // over-admit unnamed beaches into parks with no assembled area; keeping only
  // the polygon tier would unname beaches whose park is line- or relation-mapped
  // and delete their park-origin rows. Both errors move rows.
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

  // Step 6a. The pond-evidence seed set from pondWaterSeeds: an oversized beach
  // never seeds and is never pond-tested, named beaches do seed (their nearby
  // water feeds neighbouring unnamed beaches' tests), and an empty return means
  // no unnamed candidate is under the cutoff, so the whole gather is skipped.
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

  // Step 6b. The water half of the pool: ways only, from both the water and the
  // coastline logical layers. Admitting relations would change what the pond
  // filter sees. Every candidate still goes through the branch chain, so a named
  // park-tagged lake routes to the park branch and contributes no water
  // evidence.
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

  // Steps 4, 6d, 5, 7 — one pass per candidate. The pond test runs before
  // association; the two are independent, so the output is identical either way
  // and the cheap drop first keeps grid queries off beaches about to be
  // discarded.
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
    // The pond filter applies to unnamed beaches only: they become rows purely
    // by park inference, so they are the ones needing water evidence. A named
    // beach is kept regardless. Oversized beaches skip the test — they never
    // seeded the pool, and a beach that big cannot sit only on pond-sized
    // water.
    if (beach.name === null &&
        beach.areaDeg2 < POND_TEST_MAX_BEACH_AREA_DEG2 &&
        isPondBeach(beach, pooledWaters)) {
      droppedPond = droppedPond + 1;
      continue;
    }
    // Step 5. Association over the naming tier. Candidates come from the
    // envelope grid queried by the beach's unpadded bbox, which is exactly what
    // associateParkForBeach's own boundsOverlap tests, returned in ascending
    // original index order, so the smallest-area-then-first-seen tie-break
    // resolves bit-identically to a full-list scan. Envelope overlap and not
    // centre-containment: shoreline beach polygons commonly bulge lakeward past
    // the park boundary, pulling their centre outside the park bbox.
    const candidateIdx = queryGridByBounds(parksNameGrid, beach.bounds);
    const candidateParks = [];
    for (let c = 0; c < candidateIdx.length; c++) {
      candidateParks.push(parksName[candidateIdx[c]]);
    }
    const park = associateParkForBeach(beach, candidateParks);
    // Step 7. The nine-field record. bounds and vertices are deliberately
    // dropped: nothing downstream reads them, and carrying geometry into the SQL
    // builders is how a delta file grows by an order of magnitude.
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

  // Diagnostic only. Logged by the batch, consulted by no gate: the delete gate
  // is the manifest (src/layerManifest.js) plus the proportional rails in
  // scripts/discovery-batch.js, and wiring a count from here into either would
  // let a discovery-side bug authorise a mass delete.
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
