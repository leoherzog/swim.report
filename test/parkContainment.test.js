// Pure-function coverage for the park-containment discovery path downstream of
// the OSM reader: the sync merge policy in src/discovery.js and the
// park-name-first display treatment in src/frontend/render.js. Both are
// provider-agnostic, taking already-derived records.
//
// The upstream halves live elsewhere: the selection rules in
// test/osmSelect.test.js, and the layer reader in test/layerDiscovery.test.js.

import { describe, it, expect } from "vitest";
import { mergeBeachRows } from "../src/discovery.js";
import { renderListPage, renderDetailPage } from "../src/frontend/render.js";
import { distanceKm } from "../src/geo.js";

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
