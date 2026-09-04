// src/regions.js — the discovery scope: a curated set of coastal bounding boxes
// tracing the entire Great Lakes shoreline, US and Canadian. Pure data plus one
// pure predicate, with no imports, so the offline Deno batch imports it verbatim.
//
// Coastal boxes rather than one continental rectangle. A single rectangle
// enclosing all five lakes would also enclose the continental interior between
// them, which is dense with inland-lake "beach" elements. The water-body
// classifier drops every one of those, so carrying them through the layer build,
// the download, the in-process index and the classification join is waste — and
// worse than waste: a beach discovered from outside every box below would be
// upserted but could never be deleted, because reconcileStaleRows only treats
// in-region rows as delete candidates.
//
// The union rectangle is a pre-filter; this array is the scope. The layer build
// hands ogr2ogr one -spat rectangle, the union envelope of every box below
// (scripts/print-spat-bbox.js), which necessarily encloses that interior. It is a
// cheap first cut that keeps the extract pass from scanning all of North America,
// not the scope. The authoritative scope is per-box and applied twice after the
// extract:
//
//   (a) scripts/clip-layers.js keeps a feature only if its envelope intersects
//       some box below padded by REGION_SPAT_PAD_DEG, so the published layers
//       carry coastal features rather than the interior;
//   (b) discoverFromLayers (src/layerDiscovery.js) applies pointInAnyRegion to
//       every beach candidate before park association, so the upsert universe and
//       the reconciliation delete-candidate universe are the same set.
//
// Box size is not the constraint: open water inside a box contributes no
// features, and merging adjacent lakes into one broad box or splitting one lake
// across several are both fine. Box coverage is the constraint: anything outside
// every box is neither clipped into the layers nor discovered from them. Size
// boxes for clean shoreline coverage, with a ~10-20% margin inland so beaches set
// back from the waterline are still included.
//
// pointInAnyRegion also scopes the offline reconciliation delete, and it fails
// safe: shrinking or removing a box can only make it return false for more rows,
// which only removes rows from the delete-candidate set. A row that is no longer
// a candidate is left alone, so an editing mistake that makes a box too small
// under-deletes rather than deleting a real, enriched beach.
//
// Expansion is additive. Bringing a new coast online means appending boxes here;
// the build's union rectangle, the per-box clip, discovery, pointInAnyRegion
// scoping and the delete rail all iterate REGIONS and pick up new coasts
// automatically. Keep the coastal-box discipline — trace the shoreline with a
// ~10-20% inland margin and leave the continental interior out, because the
// per-box clip is the only thing keeping the layer set O(coast) rather than
// O(continent). The one thing that is not free is data/layer-floors.json: the
// floors are keyed by a digest over REGIONS (src/layerManifest.js), so appending
// a box invalidates them and the next build refuses until the new coast's floors
// are seeded and committed. That refusal is what stops a new coast from being
// published against floors that never measured it.

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

// True iff (lat, lon) lies inside any region bbox, bounds inclusive. A
// non-finite or non-number input answers false, so a row with missing or garbage
// coordinates is never treated as in-region and never becomes a reconciliation
// delete candidate.
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
