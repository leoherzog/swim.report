// src/osmSelect.js — the PURE OSM selection semantics of beach discovery:
// the size thresholds, the park tag allowlist, the bbox algebra, the pond
// filter, and the park association rule.
//
// Every symbol here was relocated VERBATIM out of src/clients/overpass.js.
// Nothing about the behaviour changed in the move; the point of the move is
// that none of it was ever about Overpass. These are product rules — how big a
// water body has to be before a sand sliver on it counts as a beach, which
// tags make a polygon a "park" worth donating its name, how far a beach may
// stop short of the waterline and still associate with it — and they must
// outlive the transport that happened to deliver the elements. The Overpass
// client keeps working by re-exporting them (so every existing importer is
// unaffected); the prebuilt-layer discovery path imports them directly.
//
// Pure: no fetch, no Date, no Worker imports. Imported ONLY by the offline
// batch (scripts/discovery-batch.js), by src/clients/overpass.js, and by
// tests — NEVER by src/index.js or src/router.js. The two-path rule (the
// request path reads only D1 and KV) is unchanged by this file existing.
//
// A note on units: every "area" here is a RAW degree product
// (dLat * dLon), not a projected area. That is what the thresholds were
// calibrated against on live Great Lakes data, so converting to m² would
// silently move every boundary. The comments quote the km²/m² equivalents at
// Michigan latitudes for human legibility only.

// A beach whose own bbox is at least this large is never pond-tested and never
// seeds the pond-water query. 1e-3 deg² ≈ 8.7 km² at Michigan latitudes —
// 200x the WATER_MIN_AREA_DEG2 pond threshold, so a beach this size cannot
// plausibly sit ONLY on pond-sized water (its own footprint dwarfs any pond);
// skipping the test can only err toward KEEPING, the same safe direction as
// the missing-water rule in isPondBeach. Every pathological around seed
// observed in production (the 19-96 km² unnamed island/dune multipolygons on
// the northern Lake Michigan tile) sits far above this; every genuine pond
// sliver observed sits orders of magnitude below (~e-8 to e-6 deg²).
// Exported for tests and for the seed-selection helper below.
export const POND_TEST_MAX_BEACH_AREA_DEG2 = 0.001;

// The pond/lake size boundary, DUAL USE: it decides both whether an unnamed
// beach's adjacent water is too small to be a real swim water body
// (isPondBeach) and whether a natural=water way counts as real nearby water
// for the classification signals. Exactly one definition, deliberately — the
// two uses are the same judgement about the same OSM geometry.
//
// ~5e-6 deg² ≈ 45,000 m² (~4.5 ha) bbox at Michigan latitudes — between the
// classic pond/lake boundary and the smallest observed real swim lakes with
// ~2x margin each way (Hawthorn Pond bbox ≈ 2.5e-6; Hawk Lake, the smallest
// lake with a real township swim beach in the pilot bbox, ≈ 1.2e-5).
export const WATER_MIN_AREA_DEG2 = 0.000005;

// Beach bbox is padded by ~100 m when matching water bboxes so a beach that
// stops short of the waterline still associates with its water body.
export const WATER_MATCH_PADDING_DEG = 0.001;

// Water-body classification probe radii (metres), validated / conservative in
// the 2026-07-18 audit of 698 prod beaches: the 325 genuine-inland beaches are
// all >= 3 km from any Great Lake, so a 150 m probe never wrongly hides a real
// shore beach while avoiding the cross-water false positive a wide radius
// caused. These three numbers ARE the safety argument for the classifier —
// they are pinned by test, and widening any of them re-opens the cross-water
// false positive the audit closed.
export const OCEAN_RADIUS_M = 150;       // coastline probe (validated safe band)
export const GREAT_LAKE_RADIUS_M = 150;  // lake-relation probe (the 150 m the audit validated)
export const INLAND_RADIUS_M = 120;      // tighter: the beach's OWN adjacent water only

// Raw degree-product area of a bounds rectangle. Not a projected area — see
// the units note in the file header.
export function bboxAreaDeg2(bounds) {
  return (bounds.maxLat - bounds.minLat) * (bounds.maxLon - bounds.minLon);
}

// Inclusive bbox overlap: edge-touching counts as overlapping. The
// inclusiveness is deliberate and load-bearing — a beach way whose boundary is
// exactly the park boundary (they share nodes, which is how OSM mappers draw
// them) must still associate.
export function boundsOverlap(a, b) {
  return a.minLat <= b.maxLat && a.maxLat >= b.minLat &&
    a.minLon <= b.maxLon && a.maxLon >= b.minLon;
}

// The park tag allowlist. Deliberately broad — verified against real data:
// Van Buren State Park (MI) is leisure=nature_reserve + boundary=protected_area,
// not leisure=park, so all three alternatives are required. Any upstream
// element filter that pre-selects park polygons MUST stay in sync with this
// list, or parks silently stop donating their names.
export function isParkTagged(tags) {
  return tags.leisure === "park" ||
    tags.leisure === "nature_reserve" ||
    tags.boundary === "protected_area";
}

// Selects the seed elements for the pond-water evidence gather from the parsed
// beach list: every beach (NAMED ones too — water found near a named beach fed
// neighboring unnamed beaches' pond tests under the old single query, so
// keeping them preserves that coverage) whose bbox area is under
// POND_TEST_MAX_BEACH_AREA_DEG2. Returns [] when NO unnamed beach is under the
// cutoff — named beaches are never pond-filtered and oversized ones skip the
// test, so there is nothing for the water evidence to decide and the gather is
// skipped entirely.
//
// This is the DEFINITION OF THE POND-EVIDENCE SEED SET, not a transport
// detail: the three rules above (oversized beaches never seed, named beaches
// DO seed, no unnamed candidate means no gather) decide which beaches the pond
// filter can see evidence for, and narrowing the set would silently start
// dropping real beaches for want of evidence.
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
// Park containment keeps UNNAMED beaches, which sweeps in tiny sand patches on
// ponds inside named parks (real case: Hawthorn Pond Natural Area, Holland Twp
// MI — a 5 m x 6 m unnamed beach way on a ~180 m pond became a full beach row
// named after the park). Beach size alone cannot separate these from real
// beaches: verified against live data, sub-100 m² unnamed slivers sit on Lake
// Erie, Torch Lake, and Mullett Lake. The separating signal is the ADJACENT
// WATER BODY's size, so the pond-evidence gather collects natural=water within
// ~60 m of every candidate beach and this filter drops unnamed beaches whose
// nearby water is ALL smaller than WATER_MIN_AREA_DEG2.
//
// The evidence is WAYS ONLY (ponds are essentially always closed ways, so
// way-water carries the entire pond signal), plus natural=coastline ways as
// cheap positive large-water evidence so a Great Lakes shorefront beach whose
// lake is relation-mapped still associates with big water. Known residual
// exposure: a beach on a relation-mapped INLAND lake whose only nearby
// way-water is a small pond would be wrongly dropped — rare, and a beach with
// no nearby way-water at all is kept.
//
// True when the beach sits ONLY on pond-sized water: at least one water bbox
// overlaps its (padded) bbox and every overlapping one is smaller than
// WATER_MIN_AREA_DEG2 (a shoreline record — a coastline way — always counts as
// large). A beach with NO mapped water nearby returns false — missing data
// must never drop a beach, only positive evidence that all its water is tiny.
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
// Association is by bbox OVERLAP, not center-in-bbox: shoreline beach polygons
// commonly bulge lakeward past the park boundary, pulling their center outside
// the park bbox. Smallest overlapping park bbox wins so a nested specific park
// beats a containing forest or protected area; ties go to the FIRST SEEN park,
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

// --- The prebuilt-layer half ----------------------------------------------
// Everything above this line was relocated verbatim out of the Overpass
// client. Everything below is NEW, and exists for one reason: the prebuilt
// FlatGeobuf layers deliver the same OSM elements the Overpass API used to,
// but in a different order and a different record shape. These functions
// reproduce — exactly, not approximately — the three things the Overpass query
// language was doing for us implicitly:
//
//   1. ORDER. Overpass emitted node, then way, then relation, each id
//      ascending. FlatGeobuf emits Hilbert (spatial) order. Two of our rules
//      resolve ties by FIRST SEEN, so order is semantics here, not cosmetics.
//   2. THE ELEMENT ANCHOR. "way(N);>->.a;" recursed down to member nodes and
//      every around: probe measured from THOSE, never from a centroid or a
//      bbox rectangle.
//   3. THE FIELD DERIVATIONS of parseParkBeachElements, which turned a raw
//      element into the beach / park / water record the pipeline consumes.
//
// Still pure: no fetch, no Date, no Worker imports. The input record shape is
// the LayerFeature the FlatGeobuf reader produces
// ({ layer, osmType, osmId, tags, bounds, geometry }); nothing here reads a
// field the old Overpass element did not also carry, except geometry, which is
// the whole point — Overpass gave us geometry through a second recursed query
// and the layers hand it to us directly.

// The pond-evidence probe radius (metres). Was the bare literal 60 inside the
// Overpass QL string "way[natural=water](around.b:60)" — a number that read
// like a query-tuning knob and is actually a product rule: how close mapped
// water has to be to a candidate beach before it counts as evidence about what
// that beach sits on. It lives here now with the other calibrated radii so a
// reader can see all four in one place, and so changing it is visibly a
// behaviour change rather than a string edit.
export const POND_EVIDENCE_RADIUS_M = 60;

// Scan-order rank for an OSM element type. Overpass's output order was
// node, then way, then relation, and that is not incidental — see
// sortLayerFeatures. An unrecognised type sorts LAST rather than throwing:
// layer data is upstream input, and a mystery element that lands at the end of
// the scan can at worst lose a first-seen tie, whereas a throw here would fail
// a whole discovery run over one malformed row.
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

// Restores the deterministic Overpass scan order — node, then way, then
// relation, each with ids ascending — over an array of LayerFeatures.
//
// This is REQUIRED, not tidy. Two rules in this file resolve ties by FIRST
// SEEN: associateParkForBeach breaks an equal-area park tie by scan position,
// and mergeBeachRows downstream keeps the first row for a duplicate id. Under
// Overpass the scan order was a stable property of the transport, so those
// ties resolved the same way on every run. FlatGeobuf stores features in
// Hilbert (spatial) order, which is stable per FILE but changes whenever the
// layer is rebuilt — so without this call, a park name could flip between two
// same-area parks purely because a weekly rebuild reshuffled the index, and a
// name flip on a park-origin beach rewrites its row. Every scanned layer array
// must pass through here before any consumer sees it.
//
// Returns a NEW array: the caller's input is never mutated, because the same
// layer array is handed to more than one pipeline step and an in-place sort
// would make step order matter invisibly. The sort is stable (ES2019
// guarantees it), so features that tie on both keys — which real layers should
// never contain, since (type, id) is unique in OSM — keep their file order
// rather than moving unpredictably.
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

// Midpoint of a bounds rectangle.
//
// This is the ONLY permitted beach coordinate derivation, and the reason is
// numeric rather than aesthetic: it is what Overpass "out center" produced for
// the named pass and what parseParkBeachElements computed for the park pass,
// so the two passes agreed to the last bit and a beach that appeared in both
// never looked like it had moved. The upsert has a moved-guard that NULLs
// water_class when a beach shifts by more than WATER_CLASS_MOVE_DEG (0.001),
// so any other derivation — a polygon centroid, a first vertex, a
// driver-supplied label point — would re-NULL classifications table-wide on
// the first run and re-expose every inland beach the classifier had hidden.
export function envelopeCenter(bounds) {
  return {
    lat: (bounds.minLat + bounds.maxLat) / 2,
    lon: (bounds.minLon + bounds.maxLon) / 2
  };
}

// Walks any nested GeoJSON coordinates structure and pushes every position it
// finds onto out as { lat, lon }. Depth-agnostic on purpose: Point,
// LineString, Polygon and MultiPolygon differ only in nesting depth, and a
// position is recognisable as "an array whose first element is a number".
// Malformed positions (a non-finite ordinate, a one-element array) are
// SKIPPED, never thrown on, for the same reason src/geo.js skips them — layer
// geometry is upstream input and one bad vertex must not fail a run.
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

// The classification / pond probe anchor: every vertex of a feature's
// geometry, in geometry order.
//
// This reproduces Overpass's recurse-down anchor ("way(N);>->.a;") exactly.
// For a way or a relation it is the element's member NODES; for a node
// element the geometry is a Point, so the walk yields the point itself and the
// two cases need no separate branch. Distances are then measured from these
// points and from nothing else:
//
//   - NOT from the centroid, because a set-back beach (a sand polygon that
//     stops short of the waterline) has a centroid tens of metres further from
//     the water than its nearest vertex, and a 120-150 m probe measured from
//     the centroid starts missing real shorefront.
//   - NOT from the bbox rectangle, because a large multipolygon beach like
//     Sleeping Bear has a bbox whose nearest edge is nowhere near its actual
//     sand — its centroid sits inland of the 150 m coastline band while its
//     vertices are right on it, which is the difference between great_lake and
//     inland for the whole dune complex.
//
// Duplicate vertices are NOT removed. A closed ring repeats its first position
// as its last, and a relation repeats shared nodes between members; Overpass's
// ">" returned a node SET, so it did not. That difference is invisible to
// every consumer here — both a minimum distance and a point-in-polygon test
// are idempotent under repeated points — and deduping would cost a hash of
// every vertex of every beach in the run to buy nothing.
//
// The fallback matters more than it looks: a feature whose geometry yields no
// usable position degrades to its envelope centre rather than to an EMPTY
// probe set. An empty set would make every distance probe report "nothing in
// range", which classifyWaterBody reads as a clean negative and turns into
// "inland" — silently hiding a real shore beach on the strength of missing
// data. Falling back to the centre keeps a bad-geometry beach in the same
// keep-direction the rest of this file errs toward.
export function probeVertices(feature) {
  const vertices = [];
  const geometry = feature.geometry;
  if (geometry !== null && typeof geometry === "object") {
    if (Array.isArray(geometry.geometries)) {
      // GeometryCollection: not emitted by our layer build, but a
      // hand-assembled fixture or a future layer could carry one, and
      // silently returning zero vertices for it is the failure mode above.
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

// A bounds rectangle is usable only when all four ordinates are finite
// numbers. elementBounds returned null for an Overpass element without usable
// coordinates and parseParkBeachElements skipped it; the record builders below
// keep that behaviour by returning null, so a layer row with broken geometry
// is dropped from the pipeline rather than becoming a row at NaN, NaN.
function hasUsableBounds(bounds) {
  return bounds !== null && typeof bounds === "object" &&
    Number.isFinite(bounds.minLat) && Number.isFinite(bounds.minLon) &&
    Number.isFinite(bounds.maxLat) && Number.isFinite(bounds.maxLon);
}

// --- The three record builders --------------------------------------------
// These replace parseParkBeachElements. The FIELD DERIVATIONS below are
// verbatim from it — same name-emptiness rule, same loc_name trimming, same
// envelope-midpoint coordinates, same raw-degree areas, same shoreline flag.
//
// What did NOT move here is the BRANCH PRECEDENCE. parseParkBeachElements was
// one loop with an if/else-if chain, and the chain order was load-bearing:
// beach first (an element tagged both natural=beach and park-ish is a beach
// ONLY), then park, then water. That ordering now lives in the CALLER
// (src/layerDiscovery.js), which consults these three in that same order,
// because the layers arrive pre-split into beach / park / water files and only
// the caller knows which logical layer a feature came from. The reason park
// precedes water is worth repeating wherever the order is written down: a
// named protected lake carries park tags AND natural=water, and it must keep
// donating its name to the beaches inside it. Losing its water role only errs
// toward KEEPING a beach, which is the safe direction; losing its park role
// would unname beaches and delete their park-origin rows.

// A beach record, exactly the shape the park pass has always produced, plus
// the probe vertices the layer pipeline needs (Overpass fetched those in a
// separate recursed query per beach; the layers carry them inline, so
// computing them once here saves re-walking the geometry in every consumer).
// Returns null for a feature with no usable bounds.
//
// No tag test here, deliberately: which features are beaches is the caller's
// branch-precedence decision, not this builder's.
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
    // "|| null" and not a typeof check, verbatim from the original: an OSM
    // name tag that is the empty string is not a name, and an unnamed beach
    // must be null so the pond filter and the unnamed-suffix deriver can see
    // it as unnamed.
    name: tags.name || null,
    // Secondary locality label carried on the beach element's OWN tags
    // (loc_name — a local/unofficial name like "Hamlin Lake"). Feeds
    // deriveUnnamedSuffix in src/index.js so a park's secondary unnamed
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

// A park record: a NAMED, park-tagged polygon or way that can donate its name
// to beaches inside it. Returns null unless BOTH conditions hold, which is the
// same gate the original "else if (tags.name && isParkTagged(tags))" applied —
// an unnamed park has nothing to donate, and a named non-park polygon is not a
// park.
//
// geometry is retained because membership (is this beach inside this park?)
// needs the actual rings, not the envelope: park bboxes overlap wildly along a
// coastline and envelope-only membership would admit beaches into parks they
// are nowhere near. The NAMING tier passes envelope-only records and simply
// ignores this field.
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

// A water record for the pond-evidence pool. Returns null for a feature with
// no usable bounds; otherwise it always produces a record, because the caller
// only ever hands it features from the water and coastline layers, whose tags
// are guaranteed by the layer build.
//
// shoreline is the "always counts as large" flag and it is the single most
// important field here. A natural=coastline feature is one SEGMENT of a shore,
// so its own envelope is tiny — often far under WATER_MIN_AREA_DEG2. Without
// this flag, isPondBeach would look at a Lake Michigan beach, see only
// pond-sized water bboxes next to it, and drop it as a pond sliver. Every
// Great Lakes beach on a relation-mapped lake depends on this one boolean.
//
// osmType is carried so the caller can enforce the ways-only pool of the pond
// gather (Overpass ran way[natural=water] and way[natural=coastline], never
// relations), and geometry so the 60 m seed-to-water distance can be measured
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
