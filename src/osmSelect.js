// src/osmSelect.js — the pure OSM selection semantics of beach discovery: the
// size thresholds, the park tag allowlist, the bbox algebra, the pond filter,
// the park association rule, and the record builders the layer scan feeds.
// These are product rules: how big a water body has to be before a sand sliver
// on it counts as a beach, which tags make a polygon a "park" worth donating its
// name, how far a beach may stop short of the waterline and still associate.
//
// Pure: no fetch, no Date, no Worker imports. Imported by the offline batch
// (scripts/discovery-batch.js), by src/layerDiscovery.js and src/layerSignals.js,
// and by tests, never by src/index.js or src/router.js — the request path reads
// only D1 and KV.
//
// Every "area" here is a raw degree product (dLat * dLon), not a projected area.
// The thresholds were calibrated against that, so converting to m² would
// silently move every boundary. Comments quote km²/m² equivalents at Michigan
// latitudes for legibility only.

// A beach whose own bbox is at least this large is never pond-tested and never
// seeds the pond-water gather. 1e-3 deg² ≈ 8.7 km² at Michigan latitudes, 200x
// the WATER_MIN_AREA_DEG2 pond threshold, so a beach this size cannot plausibly
// sit only on pond-sized water; skipping the test can only err toward keeping,
// the same safe direction as the missing-water rule in isPondBeach.
export const POND_TEST_MAX_BEACH_AREA_DEG2 = 0.001;

// The pond/lake size boundary, dual use: it decides both whether an unnamed
// beach's adjacent water is too small to be a real swim water body (isPondBeach)
// and whether a natural=water way counts as real nearby water for the
// classification signals. One definition deliberately — the two uses are the
// same judgement about the same geometry.
//
// ~5e-6 deg² ≈ 45,000 m² bbox at Michigan latitudes, between the classic
// pond/lake boundary and the smallest real swim lakes with ~2x margin each
// way.
export const WATER_MIN_AREA_DEG2 = 0.000005;

// Beach bbox is padded by ~100 m when matching water bboxes so a beach that
// stops short of the waterline still associates with its water body.
export const WATER_MATCH_PADDING_DEG = 0.001;

// Water-body classification probe radii, in metres. Genuine-inland beaches sit
// at least 3 km from any Great Lake, so a 150 m probe never wrongly hides a real
// shore beach while avoiding the cross-water false positive a wide radius
// causes. These three numbers are the safety argument for the classifier: they
// are pinned by test, and widening any of them re-opens that false positive.
export const OCEAN_RADIUS_M = 150;       // coastline probe
export const GREAT_LAKE_RADIUS_M = 150;  // lake-relation probe
export const INLAND_RADIUS_M = 120;      // the beach's own adjacent water only

// Raw degree-product area of a bounds rectangle, not a projected area.
export function bboxAreaDeg2(bounds) {
  return (bounds.maxLat - bounds.minLat) * (bounds.maxLon - bounds.minLon);
}

// Inclusive bbox overlap: edge-touching counts. A beach way whose boundary is
// exactly the park boundary — they share nodes, which is how mappers draw them —
// must still associate.
export function boundsOverlap(a, b) {
  return a.minLat <= b.maxLat && a.maxLat >= b.minLat &&
    a.minLon <= b.maxLon && a.maxLon >= b.minLon;
}

// The park tag allowlist, deliberately broad: Van Buren State Park (MI) is
// leisure=nature_reserve + boundary=protected_area, not leisure=park, so all
// three alternatives are required. Any upstream element filter that pre-selects
// park polygons must stay in sync with this list, or parks silently stop
// donating their names.
export function isParkTagged(tags) {
  return tags.leisure === "park" ||
    tags.leisure === "nature_reserve" ||
    tags.boundary === "protected_area";
}

// The pond-evidence seed set: every beach whose bbox area is under
// POND_TEST_MAX_BEACH_AREA_DEG2, named ones included, because water found near a
// named beach is evidence for a neighbouring unnamed beach's pond test. Returns
// [] when no unnamed beach is under the cutoff, since there is then nothing for
// the evidence to decide.
//
// These three rules — oversized beaches never seed, named beaches do seed, no
// unnamed candidate means no gather — decide which beaches the pond filter can
// see evidence for. Narrowing the set silently starts dropping real beaches for
// want of evidence.
export function pondWaterSeeds(beaches) {
  const seeds = [];
  let unnamedCandidate = false;
  for (let i = 0; i < beaches.length; i++) {
    const beach = beaches[i];
    if (beach.areaDeg2 < POND_TEST_MAX_BEACH_AREA_DEG2) {
      seeds.push({ osmType: beach.osmType, osmId: beach.osmId });
      if (beach.name === null) {
        unnamedCandidate = true;
      }
    }
  }
  return unnamedCandidate ? seeds : [];
}

// --- Pond filtering -------------------------------------------------------
// Park containment keeps unnamed beaches, which sweeps in tiny sand patches on
// ponds inside named parks (a 5 m x 6 m unnamed beach way on a ~180 m pond in
// Hawthorn Pond Natural Area became a full beach row named after the park).
// Beach size alone cannot separate these from real beaches: sub-100 m² unnamed
// slivers sit on Lake Erie, Torch Lake and Mullett Lake. The separating signal
// is the adjacent water body's size, so the pond-evidence gather collects
// natural=water within POND_EVIDENCE_RADIUS_M of every candidate beach and this
// filter drops unnamed beaches whose nearby water is all smaller than
// WATER_MIN_AREA_DEG2.
//
// The evidence is ways only, since ponds are essentially always closed ways,
// plus natural=coastline ways as cheap large-water evidence so a Great Lakes
// shorefront beach whose lake is relation-mapped still associates with big
// water. Residual exposure: a beach on a relation-mapped inland lake whose only
// nearby way-water is a small pond is wrongly dropped.
//
// True when the beach sits only on pond-sized water: at least one water bbox
// overlaps its padded bbox and every overlapping one is smaller than
// WATER_MIN_AREA_DEG2 (a shoreline record always counts as large). A beach with
// no mapped water nearby returns false — missing data must never drop a beach,
// only positive evidence that all its water is tiny.
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

// Returns the smallest-bbox park whose bounding box overlaps the beach's
// bounding box, or null when none overlaps.
//
// Association is by bbox overlap, not center-in-bbox: shoreline beach polygons
// commonly bulge lakeward past the park boundary, pulling their center outside
// the park bbox. Smallest overlapping park bbox wins so a nested specific park
// beats a containing forest or protected area; ties go to the first-seen park,
// so the caller's scan order over the park list is part of the contract.
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

// --- The layer half -------------------------------------------------------
// The functions below take LayerFeatures as the FlatGeobuf reader produces them
// ({ layer, osmType, osmId, tags, bounds, geometry }) and supply the three
// things a raw layer scan does not: a deterministic scan order, the vertex
// probe anchor, and the field derivations that turn a feature into the beach /
// park / water record the pipeline consumes. Still pure: no fetch, no Date, no
// Worker imports.

// The pond-evidence probe radius, in metres: how close mapped water has to be to
// a candidate beach before it counts as evidence about what that beach sits on.
// It lives with the other calibrated radii so changing it is visibly a behaviour
// change.
export const POND_EVIDENCE_RADIUS_M = 60;

// Scan-order rank for an OSM element type: node, then way, then relation (see
// sortLayerFeatures). An unrecognised type sorts last rather than throwing —
// layer data is upstream input, and a mystery element at the end of the scan can
// at worst lose a first-seen tie, whereas a throw would fail a whole discovery
// run over one malformed row.
function osmTypeRank(osmType) {
  if (osmType === "node") {
    return 0;
  }
  if (osmType === "way") {
    return 1;
  }
  if (osmType === "relation") {
    return 2;
  }
  return 3;
}

// Puts an array of LayerFeatures into deterministic scan order: node, then way,
// then relation, each with ids ascending.
//
// Required, not tidy. Two rules resolve ties by first seen —
// associateParkForBeach breaks an equal-area park tie by scan position, and
// mergeBeachRows downstream keeps the first row for a duplicate id. FlatGeobuf
// stores features in Hilbert order, stable per file but reshuffled on every
// rebuild, so without this call a park name could flip between two same-area
// parks purely because the index moved, and a name flip on a park-origin beach
// rewrites its row. Every scanned layer array must pass through here before any
// consumer sees it.
//
// Returns a new array: the same layer array is handed to more than one pipeline
// step, so an in-place sort would make step order matter invisibly. The sort is
// stable, so features tying on both keys keep their file order.
export function sortLayerFeatures(features) {
  const sorted = features.slice();
  sorted.sort(function (a, b) {
    const rankDelta = osmTypeRank(a.osmType) - osmTypeRank(b.osmType);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    if (a.osmId < b.osmId) {
      return -1;
    }
    if (a.osmId > b.osmId) {
      return 1;
    }
    return 0;
  });
  return sorted;
}

// Midpoint of a bounds rectangle, and the only permitted beach coordinate
// derivation. The upsert has a moved-guard that NULLs water_class when a beach
// shifts by more than WATER_CLASS_MOVE_DEG (0.001), so any other derivation — a
// polygon centroid, a first vertex, a driver-supplied label point — would re-NULL
// classifications table-wide on the first run and re-expose every inland beach
// the classifier had hidden.
export function envelopeCenter(bounds) {
  return {
    lat: (bounds.minLat + bounds.maxLat) / 2,
    lon: (bounds.minLon + bounds.maxLon) / 2
  };
}

// Walks any nested GeoJSON coordinates structure and pushes every position onto
// out as { lat, lon }. Depth-agnostic on purpose: Point, LineString, Polygon and
// MultiPolygon differ only in nesting depth, and a position is recognisable as
// an array whose first element is a number. Malformed positions are skipped,
// never thrown on — layer geometry is upstream input and one bad vertex must not
// fail a run.
function collectPositions(node, out) {
  if (!Array.isArray(node) || node.length === 0) {
    return;
  }
  if (typeof node[0] === "number") {
    const lon = node[0];
    const lat = node[1];
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      out.push({ lat: lat, lon: lon });
    }
    return;
  }
  for (let i = 0; i < node.length; i++) {
    collectPositions(node[i], out);
  }
}

// The classification / pond probe anchor: every vertex of a feature's geometry,
// in geometry order. For a node element the geometry is a Point, so the walk
// yields the point itself and the two cases need no separate branch. Distances
// are measured from these points and from nothing else:
//
//   - not from the centroid, because a set-back beach has a centroid tens of
//     metres further from the water than its nearest vertex, and a 120-150 m
//     probe measured from it starts missing real shorefront;
//   - not from the bbox rectangle, because a large multipolygon beach like
//     Sleeping Bear has a centroid inland of the 150 m coastline band while its
//     vertices are right on it, which is the difference between great_lake and
//     inland for the whole dune complex.
//
// Duplicate vertices are not removed. A closed ring repeats its first position
// as its last and a relation repeats shared nodes, but both a minimum distance
// and a point-in-polygon test are idempotent under repeated points, so deduping
// would hash every vertex of every beach to buy nothing.
//
// A feature whose geometry yields no usable position degrades to its envelope
// centre rather than to an empty probe set. An empty set makes every distance
// probe report "nothing in range", which classifyWaterBody reads as a clean
// negative and turns into "inland", silently hiding a real shore beach on the
// strength of missing data.
export function probeVertices(feature) {
  const vertices = [];
  const geometry = feature.geometry;
  if (geometry !== null && typeof geometry === "object") {
    if (Array.isArray(geometry.geometries)) {
      // GeometryCollection: not emitted by the layer build, but a fixture or a
      // future layer could carry one, and returning zero vertices for it is the
      // failure mode above.
      for (let i = 0; i < geometry.geometries.length; i++) {
        const inner = geometry.geometries[i];
        if (inner !== null && typeof inner === "object") {
          collectPositions(inner.coordinates, vertices);
        }
      }
    } else {
      collectPositions(geometry.coordinates, vertices);
    }
  }
  if (vertices.length === 0 && hasUsableBounds(feature.bounds)) {
    const center = envelopeCenter(feature.bounds);
    vertices.push(center);
  }
  return vertices;
}

// A bounds rectangle is usable only when all four ordinates are finite. The
// record builders below return null otherwise, so a layer row with broken
// geometry is dropped rather than becoming a row at NaN, NaN.
function hasUsableBounds(bounds) {
  return bounds !== null && typeof bounds === "object" &&
    Number.isFinite(bounds.minLat) && Number.isFinite(bounds.minLon) &&
    Number.isFinite(bounds.maxLat) && Number.isFinite(bounds.maxLon);
}

// --- The three record builders --------------------------------------------
// Branch precedence lives in the caller (src/layerDiscovery.js), which consults
// these three in order: beach first (an element tagged both natural=beach and
// park-ish is a beach only), then park, then water. Park precedes water because
// a named protected lake carries park tags and natural=water and must keep
// donating its name to the beaches inside it. Losing its water role only errs
// toward keeping a beach; losing its park role would unname beaches and delete
// their park-origin rows.

// A beach record plus its probe vertices, computed once here so no consumer has
// to re-walk the geometry. Returns null for a feature with no usable bounds.
//
// No tag test here, deliberately: which features are beaches is the caller's
// branch-precedence decision.
export function beachRecord(feature) {
  if (!hasUsableBounds(feature.bounds)) {
    return null;
  }
  const tags = feature.tags || {};
  const bounds = feature.bounds;
  const center = envelopeCenter(bounds);
  return {
    osmType: feature.osmType,
    osmId: feature.osmId,
    // "|| null" and not a typeof check: an OSM name tag that is the empty
    // string is not a name, and an unnamed beach must be null so the pond
    // filter and the unnamed-suffix deriver can see it as unnamed.
    name: tags.name || null,
    // Secondary locality label from the beach element's own loc_name tag.
    // Feeds deriveUnnamedSuffix in src/index.js so a park's secondary unnamed
    // beach can be labeled by its water body instead of a bare compass
    // direction. Never substitutes for tags.name.
    locality: (typeof tags.loc_name === "string" && tags.loc_name.trim() !== "")
      ? tags.loc_name.trim()
      : null,
    lat: center.lat,
    lon: center.lon,
    bounds: bounds,
    areaDeg2: bboxAreaDeg2(bounds),
    vertices: probeVertices(feature)
  };
}

// A park record: a named, park-tagged polygon or way that can donate its name to
// beaches inside it. Returns null unless both conditions hold — an unnamed park
// has nothing to donate, and a named non-park polygon is not a park.
//
// geometry is retained because membership needs the actual rings, not the
// envelope: park bboxes overlap wildly along a coastline and envelope-only
// membership would admit beaches into parks they are nowhere near. The naming
// tier passes envelope-only records and ignores this field.
export function parkRecord(feature) {
  if (!hasUsableBounds(feature.bounds)) {
    return null;
  }
  const tags = feature.tags || {};
  if (!tags.name || !isParkTagged(tags)) {
    return null;
  }
  const bounds = feature.bounds;
  return {
    osmType: feature.osmType,
    osmId: feature.osmId,
    name: tags.name,
    bounds: bounds,
    areaDeg2: bboxAreaDeg2(bounds),
    geometry: feature.geometry
  };
}

// A water record for the pond-evidence pool. Returns null for a feature with no
// usable bounds; otherwise it always produces a record, because the caller only
// hands it features from the water and coastline layers.
//
// shoreline is the "always counts as large" flag. A natural=coastline feature is
// one segment of a shore, so its own envelope is often far under
// WATER_MIN_AREA_DEG2; without this flag isPondBeach would look at a Lake
// Michigan beach, see only pond-sized water bboxes, and drop it as a pond
// sliver. Every Great Lakes beach on a relation-mapped lake depends on it.
//
// osmType is carried so the caller can enforce the ways-only pond pool, and
// geometry so the POND_EVIDENCE_RADIUS_M seed-to-water distance is measured
// between real linestrings rather than between rectangles.
export function waterRecord(feature) {
  if (!hasUsableBounds(feature.bounds)) {
    return null;
  }
  const tags = feature.tags || {};
  const bounds = feature.bounds;
  return {
    bounds: bounds,
    areaDeg2: bboxAreaDeg2(bounds),
    shoreline: tags.natural === "coastline",
    osmType: feature.osmType,
    geometry: feature.geometry
  };
}
