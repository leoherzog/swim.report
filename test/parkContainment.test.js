// test/parkContainment.test.js
// Pure-function coverage for the park-containment discovery path:
// element parsing and bbox association in src/clients/overpass.js, the sync
// merge policy in src/index.js, and the park-name-first display treatment in
// src/frontend/render.js.

import { describe, it, expect } from "vitest";
import { parseParkBeachElements, associateParkForBeach } from "../src/clients/overpass.js";
import { mergeBeachRows } from "../src/index.js";
import { renderListPage, renderDetailPage } from "../src/frontend/render.js";

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

  it("keeps only the largest unnamed beach per park, named after the park", () => {
    const merged = mergeBeachRows([], [
      { osmType: "way", osmId: 1, name: null, lat: 41.90, lon: -86.60,
        areaDeg2: 0.0004, parkName: "Warren Dunes State Park", parkKey: "relation/99" },
      { osmType: "way", osmId: 2, name: null, lat: 41.91, lon: -86.61,
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
