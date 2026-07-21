// test/parkContainment.test.js
// Pure-function coverage for the park-containment discovery path:
// element parsing and bbox association in src/clients/overpass.js, the sync
// merge policy in src/index.js, and the park-name-first display treatment in
// src/frontend/render.js.

import { describe, it, expect } from "vitest";
import { parseParkBeachElements, associateParkForBeach, isPondBeach, WATER_MIN_AREA_DEG2 } from "../src/clients/overpass.js";
import { mergeBeachRows } from "../src/index.js";
import { renderListPage, renderDetailPage } from "../src/frontend/render.js";
import { distanceKm } from "../src/geo.js";

function bounds(minLat, minLon, maxLat, maxLon) {
  return { minlat: minLat, minlon: minLon, maxlat: maxLat, maxlon: maxLon };
}

describe("parseParkBeachElements", () => {
  it("splits elements into beaches and parks with bbox centers", () => {
    const parsed = parseParkBeachElements([
      { type: "way", id: 1, tags: { natural: "beach", name: "Ottawa Beach" },
        bounds: bounds(42.77, -86.22, 42.78, -86.21) },
      { type: "way", id: 2, tags: { natural: "beach" },
        bounds: bounds(42.90, -86.22, 42.92, -86.21) },
      { type: "node", id: 3, tags: { natural: "beach", name: "The First Curve" },
        lat: 43.99, lon: -86.48 },
      { type: "relation", id: 4, tags: { leisure: "park", name: "Holland State Park" },
        bounds: bounds(42.76, -86.23, 42.79, -86.20) },
      { type: "way", id: 5, tags: { leisure: "nature_reserve", boundary: "protected_area", name: "Van Buren State Park" },
        bounds: bounds(42.32, -86.32, 42.35, -86.29) }
    ]);
    expect(parsed.beaches.length).toBe(3);
    expect(parsed.parks.length).toBe(2);
    expect(parsed.beaches[0].name).toBe("Ottawa Beach");
    expect(parsed.beaches[0].lat).toBeCloseTo(42.775, 6);
    expect(parsed.beaches[0].lon).toBeCloseTo(-86.215, 6);
    expect(parsed.beaches[1].name).toBe(null);
    expect(parsed.beaches[2].lat).toBe(43.99);
    expect(parsed.parks[1].name).toBe("Van Buren State Park");
  });

  it("populates locality from the beach element's own loc_name tag", () => {
    // Feeds deriveUnnamedSuffix in src/index.js: an unnamed secondary polygon
    // carrying loc_name (e.g. "Hamlin Lake") is labeled by its water body
    // instead of a bare compass direction.
    const parsed = parseParkBeachElements([
      { type: "way", id: 1, tags: { natural: "beach", loc_name: "Hamlin Lake" },
        bounds: bounds(43.95, -86.49, 43.97, -86.47) },
      { type: "way", id: 2, tags: { natural: "beach", loc_name: "   " },
        bounds: bounds(43.90, -86.49, 43.92, -86.47) },
      { type: "way", id: 3, tags: { natural: "beach" },
        bounds: bounds(43.80, -86.49, 43.82, -86.47) }
    ]);
    expect(parsed.beaches[0].locality).toBe("Hamlin Lake");
    // Whitespace-only and absent loc_name both normalize to null.
    expect(parsed.beaches[1].locality).toBe(null);
    expect(parsed.beaches[2].locality).toBe(null);
  });

  it("skips park elements without a name and elements without coordinates", () => {
    const parsed = parseParkBeachElements([
      { type: "way", id: 1, tags: { leisure: "park" }, bounds: bounds(1, 1, 2, 2) },
      { type: "way", id: 2, tags: { natural: "beach", name: "No Coords Beach" } },
      { type: "way", id: 3, tags: { leisure: "park", name: "Real Park" }, bounds: bounds(1, 1, 2, 2) }
    ]);
    expect(parsed.beaches.length).toBe(0);
    expect(parsed.parks.length).toBe(1);
  });

  it("treats an element tagged both beach and park as a beach only", () => {
    const parsed = parseParkBeachElements([
      { type: "way", id: 1, tags: { natural: "beach", leisure: "park", name: "Grand Haven State Park" },
        bounds: bounds(43.04, -86.25, 43.06, -86.24) }
    ]);
    expect(parsed.beaches.length).toBe(1);
    expect(parsed.parks.length).toBe(0);
  });

  it("collects natural=water and natural=coastline elements as waters", () => {
    const parsed = parseParkBeachElements([
      { type: "way", id: 1, tags: { natural: "water", name: "Hawthorn Pond" },
        bounds: bounds(42.7776, -86.0273, 42.7793, -86.0258) },
      { type: "way", id: 2, tags: { natural: "coastline" },
        bounds: bounds(43.04, -86.26, 43.06, -86.25) }
    ]);
    expect(parsed.waters.length).toBe(2);
    expect(parsed.beaches.length).toBe(0);
    expect(parsed.parks.length).toBe(0);
    expect(parsed.waters[0].areaDeg2).toBeGreaterThan(0);
    expect(parsed.waters[0].shoreline).toBe(false);
    expect(parsed.waters[1].shoreline).toBe(true);
  });

  it("classifies a named park-tagged lake as a park, not water", () => {
    // A named protected lake must keep donating its name to contained beaches;
    // losing its water role only errs toward keeping a beach.
    const parsed = parseParkBeachElements([
      { type: "way", id: 1, tags: { natural: "water", boundary: "protected_area", name: "Hawthorn Pond Natural Area" },
        bounds: bounds(42.776, -86.028, 42.781, -86.018) }
    ]);
    expect(parsed.parks.length).toBe(1);
    expect(parsed.waters.length).toBe(0);
  });
});

describe("isPondBeach", () => {
  // Real case: way/161131900, a ~5 m x 6 m unnamed beach on Hawthorn Pond
  // (bbox ~2.5e-6 deg², well under the threshold).
  const pondBeach = {
    bounds: { minLat: 42.7792907, minLon: -86.0260356, maxLat: 42.7793370, maxLon: -86.0259587 }
  };
  const pond = {
    bounds: { minLat: 42.7776573, minLon: -86.0273107, maxLat: 42.7792911, maxLon: -86.0258057 },
    areaDeg2: 0.00000246
  };
  const lake = {
    bounds: { minLat: 42.7, minLon: -86.3, maxLat: 43.0, maxLon: -86.0 },
    areaDeg2: 0.09
  };

  it("is true when every adjacent water body is pond-sized", () => {
    expect(isPondBeach(pondBeach, [pond])).toBe(true);
  });

  it("is false when any adjacent water body is large enough", () => {
    expect(isPondBeach(pondBeach, [pond, lake])).toBe(false);
  });

  it("is false when no water is mapped nearby (missing data never drops)", () => {
    expect(isPondBeach(pondBeach, [])).toBe(false);
    // A large lake far outside the padded bbox is not "nearby" either.
    const farLake = {
      bounds: { minLat: 45.0, minLon: -85.0, maxLat: 45.5, maxLon: -84.5 },
      areaDeg2: 0.25
    };
    expect(isPondBeach(pondBeach, [farLake])).toBe(false);
  });

  it("matches water through the ~100 m bbox padding", () => {
    // Water bbox stops ~0.0005 deg short of the beach bbox — still adjacent.
    const nearbySmall = {
      bounds: { minLat: 42.7794, minLon: -86.0259, maxLat: 42.7797, maxLon: -86.0255 },
      areaDeg2: WATER_MIN_AREA_DEG2 / 10
    };
    expect(isPondBeach(pondBeach, [nearbySmall])).toBe(true);
  });

  it("treats water at exactly the threshold as large enough", () => {
    const atThreshold = {
      bounds: pond.bounds,
      areaDeg2: WATER_MIN_AREA_DEG2
    };
    expect(isPondBeach(pondBeach, [atThreshold])).toBe(false);
  });

  it("treats an overlapping coastline way as large water regardless of its bbox", () => {
    // A short Great Lakes coastline segment can have a tiny bbox of its own;
    // its presence still proves sea-sized water (relation-mapped lakes carry
    // no way-water for around to find).
    const shortCoastline = {
      bounds: { minLat: 42.7790, minLon: -86.0262, maxLat: 42.7796, maxLon: -86.0258 },
      areaDeg2: 0.00000024,
      shoreline: true
    };
    expect(isPondBeach(pondBeach, [pond, shortCoastline])).toBe(false);
  });
});

describe("associateParkForBeach", () => {
  const parks = [
    { osmType: "relation", osmId: 10, name: "Huge Forest",
      bounds: { minLat: 40, minLon: -90, maxLat: 47, maxLon: -80 }, areaDeg2: 70 },
    { osmType: "relation", osmId: 11, name: "Holland State Park",
      bounds: { minLat: 42.76, minLon: -86.23, maxLat: 42.79, maxLon: -86.20 }, areaDeg2: 0.0009 }
  ];

  it("picks the smallest overlapping park bbox", () => {
    const beach = { bounds: { minLat: 42.773, minLon: -86.213, maxLat: 42.777, maxLon: -86.209 } };
    const park = associateParkForBeach(beach, parks);
    expect(park.name).toBe("Holland State Park");
  });

  it("matches on bbox OVERLAP, not center containment (lakeward-bulging beaches)", () => {
    // Beach bbox pokes west of the park bbox so its center (-86.2325) lies
    // outside the park; the overlap must still associate (real case:
    // Van Buren State Park, MI — way 1280732934).
    const beach = { bounds: { minLat: 42.77, minLon: -86.245, maxLat: 42.78, maxLon: -86.22 } };
    const park = associateParkForBeach(beach, parks);
    expect(park.name).toBe("Holland State Park");
  });

  it("returns null when nothing overlaps", () => {
    const beach = { bounds: { minLat: 10, minLon: 10, maxLat: 11, maxLon: 11 } };
    expect(associateParkForBeach(beach, parks)).toBe(null);
  });
});

describe("mergeBeachRows", () => {
  const named = [
    { osmType: "way", osmId: 505668572, name: "Ottawa Beach", lat: 42.775, lon: -86.211 },
    { osmType: "way", osmId: 760796963, name: "Weko Beach", lat: 41.94, lon: -86.59 }
  ];

  it("attaches parkName to named beaches inside parks and leaves others null", () => {
    const merged = mergeBeachRows(named, [
      { osmType: "way", osmId: 505668572, name: "Ottawa Beach", lat: 42.775, lon: -86.211,
        areaDeg2: 0.0001, parkName: "Holland State Park", parkKey: "relation/8550215" }
    ]);
    const ottawa = merged.rows.find(function (r) { return r.id === "osm-way-505668572"; });
    const weko = merged.rows.find(function (r) { return r.id === "osm-way-760796963"; });
    expect(ottawa.parkName).toBe("Holland State Park");
    expect(ottawa.name).toBe("Ottawa Beach");
    expect(weko.parkName).toBe(null);
  });

  it("keeps only the largest when secondaries have no derivable distinction", () => {
    // Two unnamed beaches in one park whose centroids coincide (below the
    // compass separation threshold) and carry no locality — the smaller falls
    // back to skipped, the largest survives named after the park.
    const merged = mergeBeachRows([], [
      { osmType: "way", osmId: 1, name: null, lat: 41.90, lon: -86.60,
        areaDeg2: 0.0004, parkName: "Warren Dunes State Park", parkKey: "relation/99" },
      { osmType: "way", osmId: 2, name: null, lat: 41.90, lon: -86.60,
        areaDeg2: 0.0001, parkName: "Warren Dunes State Park", parkKey: "relation/99" },
      { osmType: "way", osmId: 3, name: null, lat: 43.66, lon: -86.49,
        areaDeg2: 0.0002, parkName: "Silver Lake State Park", parkKey: "way/50" }
    ]);
    expect(merged.rows.length).toBe(2);
    expect(merged.skippedUnnamed).toBe(1);
    const warren = merged.rows.find(function (r) { return r.id === "osm-way-1"; });
    expect(warren.name).toBe("Warren Dunes State Park");
    expect(warren.parkName).toBe("Warren Dunes State Park");
    expect(merged.rows.find(function (r) { return r.id === "osm-way-2"; })).toBe(undefined);
  });

  it("keeps separated secondary unnamed beaches with a compass-direction suffix", () => {
    // Ludington State Park: a Lake Michigan primary plus two more clearly
    // separated unnamed polygons (real park with 4 unnamed shore polygons).
    const merged = mergeBeachRows([], [
      { osmType: "way", osmId: 10, name: null, lat: 43.96, lon: -86.51,
        areaDeg2: 0.0006, parkName: "Ludington State Park", parkKey: "relation/123" },
      { osmType: "way", osmId: 11, name: null, lat: 43.98, lon: -86.51,
        areaDeg2: 0.0004, parkName: "Ludington State Park", parkKey: "relation/123" },
      { osmType: "way", osmId: 12, name: null, lat: 43.94, lon: -86.51,
        areaDeg2: 0.0003, parkName: "Ludington State Park", parkKey: "relation/123" }
    ]);
    expect(merged.rows.length).toBe(3);
    expect(merged.skippedUnnamed).toBe(0);
    const primary = merged.rows.find(function (r) { return r.id === "osm-way-10"; });
    const north = merged.rows.find(function (r) { return r.id === "osm-way-11"; });
    const south = merged.rows.find(function (r) { return r.id === "osm-way-12"; });
    // Largest keeps the bare park name (id + name derivation unchanged).
    expect(primary.name).toBe("Ludington State Park");
    expect(primary.parkName).toBe("Ludington State Park");
    // Secondaries carry a compass suffix in BOTH name and parkName so the
    // unnamed-origin (name === park_name) invariant holds for render/reconcile.
    expect(north.name).toBe("Ludington State Park — North Beach");
    expect(north.parkName).toBe("Ludington State Park — North Beach");
    expect(south.name).toBe("Ludington State Park — South Beach");
    expect(south.parkName).toBe("Ludington State Park — South Beach");
  });

  it("prefers a locality name from the beach's own tags over compass direction", () => {
    // The Hamlin Lake polygon in Ludington SP carries its own locality tag.
    const merged = mergeBeachRows([], [
      { osmType: "way", osmId: 10, name: null, lat: 43.96, lon: -86.51,
        areaDeg2: 0.0006, parkName: "Ludington State Park", parkKey: "relation/123" },
      { osmType: "way", osmId: 13, name: null, lat: 43.96, lon: -86.48,
        areaDeg2: 0.0002, parkName: "Ludington State Park", parkKey: "relation/123",
        locality: "Hamlin Lake" }
    ]);
    expect(merged.rows.length).toBe(2);
    const hamlin = merged.rows.find(function (r) { return r.id === "osm-way-13"; });
    expect(hamlin.name).toBe("Ludington State Park — Hamlin Lake");
    expect(hamlin.parkName).toBe("Ludington State Park — Hamlin Lake");
  });

  it("skips a secondary whose suffix collides with a sibling already kept", () => {
    // Two secondaries both due north of the primary would both derive
    // "North Beach"; only the first is kept, the colliding one is skipped.
    const merged = mergeBeachRows([], [
      { osmType: "way", osmId: 10, name: null, lat: 43.96, lon: -86.51,
        areaDeg2: 0.0006, parkName: "Ludington State Park", parkKey: "relation/123" },
      { osmType: "way", osmId: 11, name: null, lat: 43.98, lon: -86.51,
        areaDeg2: 0.0004, parkName: "Ludington State Park", parkKey: "relation/123" },
      { osmType: "way", osmId: 14, name: null, lat: 44.00, lon: -86.51,
        areaDeg2: 0.0002, parkName: "Ludington State Park", parkKey: "relation/123" }
    ]);
    expect(merged.rows.length).toBe(2);
    expect(merged.skippedUnnamed).toBe(1);
    expect(merged.rows.find(function (r) { return r.id === "osm-way-11"; }).name)
      .toBe("Ludington State Park — North Beach");
    expect(merged.rows.find(function (r) { return r.id === "osm-way-14"; })).toBe(undefined);
  });

  it("keeps same-named parks distinct via parkKey", () => {
    const merged = mergeBeachRows([], [
      { osmType: "way", osmId: 1, name: null, lat: 42.0, lon: -86.0,
        areaDeg2: 0.0001, parkName: "Riverside Park", parkKey: "way/1000" },
      { osmType: "way", osmId: 2, name: null, lat: 45.0, lon: -84.0,
        areaDeg2: 0.0001, parkName: "Riverside Park", parkKey: "way/2000" }
    ]);
    expect(merged.rows.length).toBe(2);
  });

  it("skips unnamed beaches with no associated park", () => {
    const merged = mergeBeachRows([], [
      { osmType: "way", osmId: 1, name: null, lat: 42.0, lon: -86.0,
        areaDeg2: 0.0001, parkName: null, parkKey: null }
    ]);
    expect(merged.rows.length).toBe(0);
    expect(merged.skippedUnnamed).toBe(1);
  });

  it("derives ids and osm_id the same way as the named-beach path", () => {
    const merged = mergeBeachRows(named, []);
    const ottawa = merged.rows.find(function (r) { return r.id === "osm-way-505668572"; });
    expect(ottawa.osmId).toBe("way/505668572");
  });
});

describe("park-name-first rendering", () => {
  const parkBeach = {
    id: "osm-way-505668572",
    name: "Ottawa Beach",
    park_name: "Holland State Park",
    lat: 42.775, lon: -86.211,
    osm_id: "way/505668572"
  };

  it("shows the park name as the row title and the beach name as a subtitle", () => {
    const html = renderListPage({
      entries: [{ beach: parkBeach, estimate: null, official: null, distanceMi: null }],
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    const nameIdx = html.indexOf("<span class=\"beach-row-name\">Holland State Park");
    expect(nameIdx).toBeGreaterThan(-1);
    expect(html).toContain("<span class=\"beach-row-subtitle\">Ottawa Beach</span>");
    // search filter must match both names
    expect(html).toContain("data-name=\"holland state park ottawa beach\"");
  });

  it("renders no subtitle when the names are identical (unnamed park beach)", () => {
    const beach = {
      id: "osm-way-1", name: "Warren Dunes State Park",
      park_name: "Warren Dunes State Park", lat: 41.9, lon: -86.6, osm_id: "way/1"
    };
    const html = renderListPage({
      entries: [{ beach: beach, estimate: null, official: null, distanceMi: null }],
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    expect(html).not.toContain("<span class=\"beach-row-subtitle\"");
  });

  it("renders no subtitle when there is no park", () => {
    const beach = { id: "osm-way-2", name: "Weko Beach", park_name: null, lat: 41.9, lon: -86.6, osm_id: "way/2" };
    const html = renderListPage({
      entries: [{ beach: beach, estimate: null, official: null, distanceMi: null }],
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    expect(html).toContain("<span class=\"beach-row-name\">Weko Beach");
    expect(html).not.toContain("<span class=\"beach-row-subtitle\"");
  });

  it("uses the park name in the detail title and h1 with the beach name below", () => {
    const html = renderDetailPage({
      beach: parkBeach,
      estimate: null,
      official: null,
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    expect(html).toContain("<title>Holland State Park — Swim Report</title>");
    expect(html).toContain("<span>Holland State Park</span></h1>");
    expect(html).toContain("<p class=\"beach-subtitle\">Ottawa Beach</p>");
  });
});

describe("mergeBeachRows: named park beach missed by the named pass", () => {
  it("creates its own row carrying the park name when the id is not in namedRows", () => {
    // The park containment query can return a NAMED beach the tiled named
    // query never saw (e.g. a polygon straddling a tile edge). That beach must
    // still become a full row — with its own name, not the park's — and carry
    // parkName from the containment association.
    const merged = mergeBeachRows([], [
      { osmType: "way", osmId: 77, name: "Hidden Cove Beach", lat: 43.1, lon: -86.3,
        areaDeg2: 0.0001, parkName: "Some State Park", parkKey: "relation/5" }
    ]);
    expect(merged.rows.length).toBe(1);
    expect(merged.skippedUnnamed).toBe(0);
    const row = merged.rows[0];
    expect(row.id).toBe("osm-way-77");
    expect(row.name).toBe("Hidden Cove Beach");
    expect(row.parkName).toBe("Some State Park");
    expect(row.osmId).toBe("way/77");
    expect(row.lat).toBe(43.1);
    expect(row.lon).toBe(-86.3);
    // Named-origin row: name !== parkName, so downstream unnamed-origin
    // detection (name === park_name) must NOT fire for it.
    expect(row.name).not.toBe(row.parkName);
  });

  it("prefers the named-pass row when the same id came through namedRows", () => {
    // Same beach seen by BOTH passes: the named-pass row wins (only parkName
    // is grafted on), so coordinates stay those of the named pass.
    const merged = mergeBeachRows(
      [{ osmType: "way", osmId: 77, name: "Hidden Cove Beach", lat: 43.1, lon: -86.3 }],
      [{ osmType: "way", osmId: 77, name: "Hidden Cove Beach", lat: 43.100001, lon: -86.300001,
        areaDeg2: 0.0001, parkName: "Some State Park", parkKey: "relation/5" }]
    );
    expect(merged.rows.length).toBe(1);
    expect(merged.rows[0].lat).toBe(43.1);
    expect(merged.rows[0].lon).toBe(-86.3);
    expect(merged.rows[0].parkName).toBe("Some State Park");
  });
});

describe("mergeBeachRows: compass-separation threshold boundary", () => {
  // Latitude offsets derived from the SAME haversine the code uses
  // (src/geo.js distanceKm), so these fixtures cannot drift from the math:
  // due north on a sphere, km scale linearly with delta-lat.
  const primaryLat = 43.96;
  const primaryLon = -86.51;
  const kmPerDegLat = distanceKm(primaryLat, primaryLon, primaryLat + 1, primaryLon);
  const latAtKm = function (km) { return primaryLat + km / kmPerDegLat; };

  it("keeps a secondary ~0.25 km due north with a North Beach suffix", () => {
    const northLat = latAtKm(0.25);
    // Sanity: this fixture really sits at/above the 0.2 km threshold.
    expect(distanceKm(primaryLat, primaryLon, northLat, primaryLon)).toBeGreaterThanOrEqual(0.2);
    const merged = mergeBeachRows([], [
      { osmType: "way", osmId: 20, name: null, lat: primaryLat, lon: primaryLon,
        areaDeg2: 0.0006, parkName: "Ludington State Park", parkKey: "relation/123" },
      { osmType: "way", osmId: 21, name: null, lat: northLat, lon: primaryLon,
        areaDeg2: 0.0002, parkName: "Ludington State Park", parkKey: "relation/123" }
    ]);
    expect(merged.rows.length).toBe(2);
    expect(merged.skippedUnnamed).toBe(0);
    const secondary = merged.rows.find(function (r) { return r.id === "osm-way-21"; });
    expect(secondary.name).toBe("Ludington State Park — North Beach");
    expect(secondary.parkName).toBe("Ludington State Park — North Beach");
  });

  it("skips a secondary only ~0.1 km away (sub-threshold separation is noise)", () => {
    const nearLat = latAtKm(0.1);
    // Sanity: this fixture really sits below the 0.2 km threshold.
    expect(distanceKm(primaryLat, primaryLon, nearLat, primaryLon)).toBeLessThan(0.2);
    const merged = mergeBeachRows([], [
      { osmType: "way", osmId: 20, name: null, lat: primaryLat, lon: primaryLon,
        areaDeg2: 0.0006, parkName: "Ludington State Park", parkKey: "relation/123" },
      { osmType: "way", osmId: 22, name: null, lat: nearLat, lon: primaryLon,
        areaDeg2: 0.0002, parkName: "Ludington State Park", parkKey: "relation/123" }
    ]);
    expect(merged.rows.length).toBe(1);
    expect(merged.skippedUnnamed).toBe(1);
    expect(merged.rows[0].id).toBe("osm-way-20");
    expect(merged.rows.find(function (r) { return r.id === "osm-way-22"; })).toBe(undefined);
  });

  it("keeps a secondary at exactly the 0.2 km threshold (>= is inclusive)", () => {
    // Nudge just past the boundary so float rounding in the reconstructed
    // latitude cannot flip the >= comparison.
    const boundaryLat = latAtKm(0.2000001);
    expect(distanceKm(primaryLat, primaryLon, boundaryLat, primaryLon)).toBeGreaterThanOrEqual(0.2);
    const merged = mergeBeachRows([], [
      { osmType: "way", osmId: 20, name: null, lat: primaryLat, lon: primaryLon,
        areaDeg2: 0.0006, parkName: "Ludington State Park", parkKey: "relation/123" },
      { osmType: "way", osmId: 23, name: null, lat: boundaryLat, lon: primaryLon,
        areaDeg2: 0.0002, parkName: "Ludington State Park", parkKey: "relation/123" }
    ]);
    expect(merged.rows.length).toBe(2);
    expect(merged.skippedUnnamed).toBe(0);
    expect(merged.rows.find(function (r) { return r.id === "osm-way-23"; }).name)
      .toBe("Ludington State Park — North Beach");
  });
});
