// src/regions.js — the discovery scope: a curated set of coastal bounding boxes
// tracing the Great Lakes shoreline and the Pacific, Gulf, Atlantic and Alaskan
// coasts of the United States and Canada. Pure data plus one pure predicate,
// with no imports, so the offline Deno batch imports it verbatim.
//
// Coastal boxes rather than continental rectangles. A rectangle enclosing a
// whole coast also encloses the interior behind it, which is dense with
// inland-lake "beach" elements. The water-body classifier drops every one of
// those, so carrying them through the layer build, the download, the in-process
// index and the classification join is waste — and worse than waste: a beach
// discovered from outside every box below would be upserted but could never be
// deleted, because reconcileStaleRows only treats in-region rows as delete
// candidates.
//
// The union rectangle is a pre-filter; this array is the scope. The layer build
// hands ogr2ogr one -spat rectangle, the union envelope of every box below
// (scripts/print-spat-bbox.js). At continental scope that envelope is nearly
// the whole extract and prunes little; it is a cheap first cut, not the scope.
// The authoritative scope is per-box and applied twice after the extract:
//
//   (a) scripts/clip-layers.js keeps a feature only if its envelope intersects
//       some box below padded by REGION_SPAT_PAD_DEG, so the published layers
//       carry coastal features rather than the interior;
//   (b) discoverFromLayers (src/layerDiscovery.js) applies pointInAnyRegion to
//       every beach candidate before park association, so the upsert universe and
//       the reconciliation delete-candidate universe are the same set.
//
// Box size is not the constraint: open water inside a box contributes no
// features, and merging adjacent coasts into one broad box or splitting one
// coast across several are both fine. Box coverage is the constraint: anything
// outside every box is neither clipped into the layers nor discovered from them.
// Size boxes for clean shoreline coverage, with a ~10-20% margin inland so
// beaches set back from the waterline are still included. Tidal estuaries and
// sounds (Puget Sound, the Chesapeake, the St. Lawrence estuary) are coastline
// in OSM and belong inside a box; non-tidal river reaches classify inland and
// need no box.
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
// automatically. No box may cross the antimeridian: src/layerGrid.js keys cells
// off raw degrees with no wrap, so the Aleutian box stops at -180 and the
// islands west of it are out of scope. Two things are not free. (1)
// data/layer-floors.json: the floors are keyed by a digest over REGIONS
// (src/layerManifest.js), so appending a box invalidates them and the next build
// refuses to move the pointer until the new coast's floors are seeded and
// committed. That refusal is what stops a new coast from being published against
// floors that never measured it. (2) data/wave-floors.json is keyed by the wave
// grid set, not by REGIONS, so a new coast prompts no refusal there; seed the
// ocean grid floors by hand after the first cycle that samples ocean beaches.
//
// Out of scope by choice, not omission: Mexico (no NWS or ECCC alert coverage,
// and every row would burn NWS_ENRICHMENT_MAX_ATTEMPTS api.weather.gov 404s
// ahead of US rows in the shared queue), Labrador and Hudson Bay (no wave grid
// north of 52.58°N on the east side), Arctic Alaska and Canada, and Greenland.

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
  },

  // --- Pacific ---------------------------------------------------------------
  {
    name: "Southern California",
    bbox: { minLon: -121.0, minLat: 32.4, maxLon: -116.8, maxLat: 35.2 },
    note: "Mexican border to Point Conception, with the Channel Islands. San " +
      "Diego, Orange County and Los Angeles County beaches."
  },
  {
    name: "Central California",
    bbox: { minLon: -123.2, minLat: 35.0, maxLon: -120.5, maxLat: 38.4 },
    note: "Point Conception to Bodega Bay: Big Sur, Monterey Bay, Santa Cruz, " +
      "San Francisco Bay and the Marin coast."
  },
  {
    name: "Northern California + Oregon",
    bbox: { minLon: -125.0, minLat: 38.2, maxLon: -123.0, maxLat: 46.4 },
    note: "Bodega Bay to the Columbia River mouth. The east edge stops short " +
      "of the Willamette Valley; Portland's river beaches are non-tidal."
  },
  {
    name: "Washington + Puget Sound",
    bbox: { minLon: -125.0, minLat: 46.2, maxLon: -121.8, maxLat: 49.1 },
    note: "Columbia mouth to the Canadian border, the Olympic coast, the " +
      "Strait of Juan de Fuca, Puget Sound and the San Juan Islands."
  },
  {
    name: "British Columbia South Coast",
    bbox: { minLon: -128.6, minLat: 48.2, maxLon: -121.8, maxLat: 51.3 },
    note: "Vancouver Island, the Strait of Georgia, Vancouver and the Sunshine " +
      "Coast up to Cape Scott and the head of Knight Inlet."
  },
  {
    name: "British Columbia North Coast + Haida Gwaii",
    bbox: { minLon: -133.5, minLat: 51.0, maxLon: -125.5, maxLat: 55.2 },
    note: "Central and north coast fjords, Bella Coola, Prince Rupert and Haida " +
      "Gwaii."
  },
  {
    name: "Alaska Panhandle",
    bbox: { minLon: -141.0, minLat: 54.5, maxLon: -129.5, maxLat: 60.2 },
    note: "Ketchikan to Yakutat: the Inside Passage, Sitka, Juneau, Haines and " +
      "Glacier Bay."
  },
  {
    name: "Alaska Southcentral",
    bbox: { minLon: -156.0, minLat: 56.8, maxLon: -143.5, maxLat: 61.7 },
    note: "Prince William Sound, the Kenai Peninsula, Cook Inlet and Anchorage, " +
      "and Kodiak Island."
  },
  {
    name: "Alaska Peninsula + Aleutians + Bristol Bay",
    bbox: { minLon: -180.0, minLat: 51.0, maxLon: -155.0, maxLat: 59.6 },
    note: "Stops at the antimeridian by construction; Attu and the islands " +
      "west of 180 are out of scope until src/layerGrid.js wraps longitude."
  },
  {
    name: "Alaska Bering Sea Coast",
    bbox: { minLon: -168.2, minLat: 59.5, maxLon: -159.5, maxLat: 67.2 },
    note: "Bethel, the Yukon-Kuskokwim delta, Norton Sound, Nome and Kotzebue " +
      "Sound. The Arctic coast north of here is deliberately excluded."
  },
  {
    name: "Hawaii",
    bbox: { minLon: -160.4, minLat: 18.8, maxLon: -154.7, maxLat: 22.4 },
    note: "The eight main islands, Niihau to the Big Island."
  },

  // --- Gulf of Mexico --------------------------------------------------------
  {
    name: "Texas Coast",
    bbox: { minLon: -97.9, minLat: 25.8, maxLon: -93.5, maxLat: 30.2 },
    note: "Brownsville and South Padre to Sabine Pass, with Corpus Christi, " +
      "Matagorda and Galveston Bay."
  },
  {
    name: "Louisiana + Mississippi + Alabama Coast",
    bbox: { minLon: -94.0, minLat: 28.9, maxLon: -87.4, maxLat: 31.0 },
    note: "The Louisiana delta, Lake Pontchartrain, the Mississippi Sound and " +
      "Mobile Bay."
  },
  {
    name: "Florida Panhandle + Big Bend",
    bbox: { minLon: -87.7, minLat: 29.0, maxLon: -82.6, maxLat: 31.0 },
    note: "Pensacola to Cedar Key, including Apalachicola and Apalachee Bay."
  },
  {
    name: "Florida Peninsula + Keys",
    bbox: { minLon: -83.2, minLat: 24.3, maxLon: -79.8, maxLat: 30.9 },
    note: "Both coasts from the Georgia line round the Keys and Dry Tortugas " +
      "to Tampa Bay. The interior lakes inside the box classify inland."
  },

  // --- Atlantic --------------------------------------------------------------
  {
    name: "Georgia + South Carolina Coast",
    bbox: { minLon: -82.0, minLat: 30.6, maxLon: -78.3, maxLat: 34.0 },
    note: "The Sea Islands, Savannah, Charleston and the Grand Strand."
  },
  {
    name: "North Carolina Coast",
    bbox: { minLon: -78.8, minLat: 33.7, maxLon: -75.2, maxLat: 36.7 },
    note: "Cape Fear to the Virginia line, with the Outer Banks and the " +
      "Pamlico and Albemarle sounds."
  },
  {
    name: "Chesapeake + Delmarva",
    bbox: { minLon: -77.6, minLat: 36.5, maxLon: -74.9, maxLat: 39.8 },
    note: "Virginia Beach, the whole Chesapeake Bay, the Delmarva ocean coast " +
      "and Delaware Bay. The tidal Potomac and James are coastline in OSM."
  },
  {
    name: "New Jersey + New York Bight",
    bbox: { minLon: -75.6, minLat: 38.8, maxLon: -71.7, maxLat: 41.4 },
    note: "Cape May to Montauk: the Jersey Shore, New York Harbor, the " +
      "Rockaways and both shores of Long Island."
  },
  {
    name: "Southern New England",
    bbox: { minLon: -73.9, minLat: 40.9, maxLon: -69.8, maxLat: 42.95 },
    note: "Long Island Sound, Rhode Island, Cape Cod and the islands, and " +
      "Massachusetts Bay up to the New Hampshire line."
  },
  {
    name: "Northern New England",
    bbox: { minLon: -71.2, minLat: 42.8, maxLon: -66.8, maxLat: 45.3 },
    note: "New Hampshire and the Maine coast to Eastport."
  },
  {
    name: "Maritimes",
    bbox: { minLon: -67.5, minLat: 43.3, maxLon: -59.5, maxLat: 48.2 },
    note: "Bay of Fundy, Nova Scotia, Cape Breton, Prince Edward Island, the " +
      "New Brunswick gulf shore and Chaleur Bay."
  },
  {
    name: "St. Lawrence Estuary + Gaspé + Magdalen Islands",
    bbox: { minLon: -71.5, minLat: 46.5, maxLon: -61.0, maxLat: 50.5 },
    note: "Québec City downstream: the tidal estuary, the Gaspé Peninsula, " +
      "Anticosti and the Magdalen Islands."
  },
  {
    name: "Quebec Lower North Shore",
    bbox: { minLon: -66.5, minLat: 49.9, maxLon: -57.0, maxLat: 51.6 },
    note: "Sept-Îles east to the Labrador border at Blanc-Sablon. Above the " +
      "gfswave domain in its northern half; those rows will carry no wave input."
  },
  {
    name: "Newfoundland",
    bbox: { minLon: -59.6, minLat: 46.5, maxLon: -52.5, maxLat: 52.0 },
    note: "The island only. Labrador is excluded: no wave grid covers it."
  },
  {
    name: "Puerto Rico + US Virgin Islands",
    bbox: { minLon: -67.4, minLat: 17.6, maxLon: -64.5, maxLat: 18.7 },
    note: "Inside the us Geofabrik extract and the NWS San Juan office's " +
      "products, so it rides the same enrichment path as the mainland."
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
