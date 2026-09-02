// src/regions.js — the North America discovery expansion rail.
//
// This module replaces the single Michigan/Great-Lakes pilot bounding box
// (PILOT_BBOX in src/index.js and scripts/discovery-batch.js) with a CURATED
// SET of coastal bounding boxes that trace the entire Great Lakes shoreline —
// both the US and the Canadian shores (ECCC enrichment handles Canada). It is
// pure data plus one pure predicate, with NO imports, so the offline Deno batch
// (scripts/discovery-batch.js) can import it verbatim, exactly like src/geo.js
// and src/discovery.js.
//
// WHY COASTAL BOXES INSTEAD OF ONE CONTINENTAL RECTANGLE
// -----------------------------------------------------
// A single rectangle enclosing all five lakes would also enclose the entire
// continental interior between and around them — Wisconsin, lower Michigan,
// Ontario, upstate New York, etc. That interior is dense with INLAND lakes, and
// it carries thousands of inland-lake "beach" elements. The water-body
// classifier (src/waterClass.js) drops every one of those (they are not Great
// Lakes shoreline), so carrying them through the layer build, the download, the
// in-process index and the classification join is pure waste. Tracing the
// shoreline with coastal boxes and leaving the interior OUT keeps the discovery
// universe to actual coast: the layers stay small and almost every feature in
// them survives classification.
//
// Under the layer pipeline this stopped being merely an efficiency argument and
// became a CORRECTNESS one. A beach discovered from outside every box below
// would be UPSERTed but could never be deleted, because reconcileStaleRows only
// treats in-region rows as delete candidates (see the section below) — an
// interior inland-lake row would be immortal, not just wasteful.
//
// THE UNION RECTANGLE IS A PRE-FILTER; THIS ARRAY IS THE SCOPE
// ------------------------------------------------------------
// The layer build hands ogr2ogr ONE -spat rectangle, the union envelope of every
// box below (scripts/print-spat-bbox.js). That rectangle necessarily encloses
// the continental interior the section above argues against, so it is only a
// cheap first cut that keeps the extract pass from scanning all of North
// America. It is NOT the scope. The authoritative scope is per-box and is
// applied twice, after the extract:
//
//   (a) scripts/clip-layers.js keeps a feature only if its envelope intersects
//       some box below padded by REGION_SPAT_PAD_DEG, so the PUBLISHED layers
//       carry coastal features rather than the interior; and
//   (b) discoverFromLayers (src/layerDiscovery.js) applies pointInAnyRegion to
//       every beach candidate before park association, so the UPSERT universe
//       and the reconciliation DELETE-candidate universe are literally the same
//       set — which is the property the paragraph above depends on.
//
// So box SIZE is still not the constraint: open water inside a box is cheap
// (nothing there matches the layer filters, so it contributes no features), and
// merging adjacent lakes into one broad box or splitting one lake across a few
// boxes are both fine. Box COVERAGE is the constraint: anything outside every
// box is not clipped into the layers and not discovered from them at all. Size
// boxes for clean SHORELINE COVERAGE, with a ~10-20% margin inland so beaches
// set back from the waterline are still included.
//
// pointInAnyRegion ALSO SCOPES THE OFFLINE RECONCILIATION-DELETE
// --------------------------------------------------------------
// The offline batch's stale-row reconciliation (reconcileStaleRows in
// scripts/discovery-batch.js) only considers a D1 row a delete CANDIDATE if the
// row falls inside the discovery region. When that containment check moves from
// the single PILOT_BBOX to pointInAnyRegion(), the safety property is preserved
// and, importantly, it fails SAFE: shrinking (or removing) a box can only make
// pointInAnyRegion return false for MORE rows, which only REMOVES rows from the
// delete-candidate set. A row that is no longer a candidate is never deleted —
// it is simply left alone. So an editing mistake that makes a box too small
// under-deletes (leaves a stale row in place) rather than over-deleting a real,
// enriched beach. That is the direction we want a "never mass-delete" rail to
// err in.
//
// EXPANSION IS ADDITIVE
// ---------------------
// Bringing a new coast online (Pacific, Gulf, Atlantic — see the placeholder
// section at the bottom) means APPENDING boxes to REGIONS. Nothing about the
// existing Great Lakes boxes, clipping, classification, or reconciliation
// changes: the build's union rectangle, the per-box clip, discovery,
// pointInAnyRegion scoping, and the delete rail all iterate REGIONS, so they
// pick up new coasts automatically the moment their boxes are added. The one
// thing that does NOT come for free is data/layer-floors.json — the floors are
// keyed by a digest over REGIONS (src/layerManifest.js), so appending a box
// invalidates them and the next build REFUSES until the new coast's floors are
// seeded and committed. That refusal is deliberate: it is what stops a new coast
// from being published against floors that never measured it.
//
// Project style: plain JS, ES modules, const/let only, string concatenation with
// + only (never template literals), console.log for logging.

// Each entry: { name, bbox: { minLon, minLat, maxLon, maxLat }, note }.
// Coordinates are decimal degrees, WGS84; minLon/minLat are the SW corner,
// maxLon/maxLat the NE corner (so minLon < maxLon and minLat < maxLat always).
// Margins of ~10-20% beyond the open-water extent are baked in so shoreline
// beaches set back from the waterline are captured.
export const REGIONS = [
  {
    name: "Lake Superior",
    bbox: { minLon: -92.4, minLat: 46.2, maxLon: -84.1, maxLat: 49.1 },
    note: "Largest of the lakes. US south shore (MN/WI/MI Upper Peninsula) and " +
      "Canadian north shore (Ontario). Includes the western tip at Duluth/" +
      "Superior and the Apostle Islands; the eastern edge meets the St. Marys."
  },
  {
    name: "St. Marys River / Sault",
    bbox: { minLon: -84.8, minLat: 45.9, maxLon: -83.6, maxLat: 46.8 },
    note: "Connecting water between Lake Superior and Lake Huron at Sault Ste. " +
      "Marie (US/Canada). Small box bridging the two lakes so the Soo shoreline " +
      "beaches are not orphaned between the Superior and Huron boxes."
  },
  {
    name: "Lake Michigan",
    bbox: { minLon: -88.3, minLat: 41.5, maxLon: -84.5, maxLat: 46.2 },
    note: "Wholly within the US (WI/IL/IN/MI). Runs from the Chicago/Indiana " +
      "Dunes south shore up both the Wisconsin and Michigan shores to the Straits " +
      "of Mackinac. This is the original pilot area — the densest beach coverage."
  },
  {
    name: "Lake Huron + Georgian Bay",
    bbox: { minLon: -84.9, minLat: 42.8, maxLon: -79.5, maxLat: 46.4 },
    note: "US (MI) west shore and the extensive Canadian (Ontario) shore " +
      "including Georgian Bay and the North Channel. Broad east-west span; " +
      "the open water inside it simply contributes no features."
  },
  {
    name: "Lake St. Clair + St. Clair / Detroit Rivers",
    bbox: { minLon: -83.6, minLat: 41.8, maxLon: -82.2, maxLat: 43.2 },
    note: "Connecting waters between Lake Huron and Lake Erie: the St. Clair " +
      "River, Lake St. Clair, and the Detroit River (US MI / Canada ON). Real " +
      "beaches at Metro Detroit and Windsor sit on this corridor."
  },
  {
    name: "Lake Erie",
    bbox: { minLon: -83.8, minLat: 41.2, maxLon: -78.6, maxLat: 43.1 },
    note: "Shallowest lake. US south shore (MI/OH/PA/NY) and Canadian north " +
      "shore (Ontario), from the Detroit River mouth east to Buffalo and the " +
      "head of the Niagara River."
  },
  {
    name: "Niagara River",
    bbox: { minLon: -79.3, minLat: 42.9, maxLon: -78.8, maxLat: 43.4 },
    note: "Connecting water between Lake Erie and Lake Ontario (US NY / Canada " +
      "ON). Small bridging box so shoreline spots along the river are covered " +
      "between the Erie and Ontario boxes."
  },
  {
    name: "Lake Ontario",
    bbox: { minLon: -80.1, minLat: 43.0, maxLon: -75.6, maxLat: 44.5 },
    note: "US south shore (NY) and Canadian north shore (Ontario), including the " +
      "Toronto/Hamilton waterfront and the eastern end near Kingston where the " +
      "lake drains into the St. Lawrence."
  },
  {
    name: "Upper St. Lawrence / Thousand Islands",
    bbox: { minLon: -76.7, minLat: 43.9, maxLon: -74.5, maxLat: 45.2 },
    note: "Connecting water below Lake Ontario: the upper St. Lawrence River and " +
      "Thousand Islands (US NY / Canada ON). Included because the region carries " +
      "genuine river beaches continuous with the Ontario shoreline."
  }
];

// pointInAnyRegion(lat, lon) — true iff (lat, lon) lies inside ANY region bbox,
// bounds inclusive. Guards non-finite inputs (NaN / Infinity / non-number) by
// returning false, so a row with missing or garbage coordinates is never treated
// as in-region (and therefore never becomes a reconciliation delete candidate).
export function pointInAnyRegion(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") {
    return false;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return false;
  }
  for (let i = 0; i < REGIONS.length; i = i + 1) {
    const b = REGIONS[i].bbox;
    if (lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon) {
      return true;
    }
  }
  return false;
}

// --- FUTURE COAST EXPANSION (placeholder — NOT yet live) --------------------
// Expansion is purely additive: append coastal boxes for the next coast to the
// REGIONS array above and everything downstream (the build's union rectangle,
// the per-box clip, discovery, pointInAnyRegion scoping, reconciliation) picks
// them up automatically. Keep the same coastal-box discipline — trace the
// shoreline with a ~10-20% inland margin and leave the continental interior OUT,
// because the per-box clip is the only thing keeping the layer set O(coast)
// rather than O(continent). Both US and Canadian/Mexican shores are welcome;
// ECCC handles Canada, and the classifier drops anything that is not genuine
// ocean/gulf/lake shoreline. Remember the floors: a new box changes the REGIONS
// digest, so data/layer-floors.json must gain that coast's seeded counts in the
// same change or the first build after it refuses.
//
// Rough starting extents to REFINE before going live (do NOT paste as-is):
//
//   // Pacific coast (US West + optionally BC): roughly
//   //   lon -125.0..-117.0, lat 32.5..49.0  (CA/OR/WA; extend north for BC)
//   // { name: "US Pacific Coast", bbox: { minLon: -125.0, minLat: 32.5,
//   //     maxLon: -117.0, maxLat: 49.0 }, note: "..." },
//
//   // Gulf of Mexico coast: roughly
//   //   lon -97.5..-80.5, lat 25.8..30.7  (TX/LA/MS/AL/FL panhandle + peninsula)
//   // { name: "US Gulf Coast", bbox: { minLon: -97.5, minLat: 25.8,
//   //     maxLon: -80.5, maxLat: 30.7 }, note: "..." },
//
//   // Atlantic coast: roughly
//   //   lon -81.5..-66.9, lat 25.0..45.0  (FL Atlantic up through Maine;
//   //   extend north for the Canadian Maritimes)
//   // { name: "US Atlantic Coast", bbox: { minLon: -81.5, minLat: 25.0,
//   //     maxLon: -66.9, maxLat: 45.0 }, note: "..." },
//
// A very long, thin coast (the Atlantic) may be better expressed as several
// stacked boxes than one tall rectangle, to keep the inland margin from swelling
// where the coastline bends far west — but that is a refinement, not a
// requirement, since the per-box clip handles the size either way.
