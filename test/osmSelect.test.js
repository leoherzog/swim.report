// test/osmSelect.test.js
// Pure-function coverage for src/osmSelect.js — the OSM SELECTION semantics of
// beach discovery, relocated verbatim out of src/clients/overpass.js: the size
// thresholds, the pond filter, the park association rule, the pond-evidence
// seed set and the validated classification probe radii.
//
// These assertions moved here unchanged (from test/parkContainment.test.js and
// test/waterClass.test.js) when the functions moved. That is the whole point of
// the file: the rules survive the transport. src/osmSelect.js is pure — no
// fetch, no Date, no Worker imports — so nothing here stubs a global.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  isPondBeach,
  associateParkForBeach,
  pondWaterSeeds,
  WATER_MIN_AREA_DEG2,
  POND_TEST_MAX_BEACH_AREA_DEG2,
  OCEAN_RADIUS_M,
  GREAT_LAKE_RADIUS_M,
  INLAND_RADIUS_M,
  POND_EVIDENCE_RADIUS_M,
  sortLayerFeatures,
  envelopeCenter,
  probeVertices,
  beachRecord,
  parkRecord,
  waterRecord
} from "../src/osmSelect.js";

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

describe("pondWaterSeeds", () => {
  // The pond-water query (the around:60 water fetch that used to ride inside
  // the single park query) is seeded ONLY with beaches small enough to
  // plausibly need the pond test. Oversized multipolygons (Beaver Islands /
  // Sleeping Bear scale) made the server-side around evaluation exceed
  // [timeout:180] and took park discovery down for days — they must never
  // appear in the seed list.
  function beach(osmType, osmId, name, areaDeg2) {
    return { osmType: osmType, osmId: osmId, name: name, areaDeg2: areaDeg2 };
  }

  it("seeds every small beach, named ones included, when an unnamed candidate exists", () => {
    // Named beaches are seeded too: water found near a named beach fed
    // neighboring unnamed beaches' pond tests under the old single query.
    const seeds = pondWaterSeeds([
      beach("way", 1, null, 1e-6),
      beach("way", 2, "Named Beach", 1e-6),
      beach("node", 3, null, 0)
    ]);
    expect(seeds).toEqual([
      { osmType: "way", osmId: 1 },
      { osmType: "way", osmId: 2 },
      { osmType: "node", osmId: 3 }
    ]);
  });

  it("excludes beaches at or above POND_TEST_MAX_BEACH_AREA_DEG2 from the seed list", () => {
    const seeds = pondWaterSeeds([
      beach("relation", 2995932, null, 0.0111), // Beaver Islands scale: the pathological case
      beach("way", 1, null, POND_TEST_MAX_BEACH_AREA_DEG2), // exactly at the cutoff: excluded
      beach("way", 2, null, POND_TEST_MAX_BEACH_AREA_DEG2 - 1e-9)
    ]);
    expect(seeds).toEqual([{ osmType: "way", osmId: 2 }]);
  });

  it("returns [] when no UNNAMED beach is under the cutoff (query 2 is skipped)", () => {
    // Only named beaches under the cutoff: nothing can be pond-filtered, so
    // there is no reason to spend an Overpass query on water evidence.
    expect(pondWaterSeeds([
      beach("way", 1, "Named Beach", 1e-6),
      beach("relation", 2, null, 0.02) // unnamed but oversized: skips the pond test
    ])).toEqual([]);
    expect(pondWaterSeeds([])).toEqual([]);
  });
});

describe("classification probe radii", () => {
  it("exposes the validated radius constants", () => {
    // Relocated from test/waterClass.test.js with the constants themselves.
    // The 2026-07-18 audit of 698 production beaches validated exactly these
    // three numbers: every genuine-inland beach sits >= 3 km from a Great
    // Lake, so a 150 m probe never hides a real shore beach while avoiding the
    // cross-water false positive a wider radius caused. Widening any of them
    // re-opens that false positive, so they are pinned here.
    expect(OCEAN_RADIUS_M).toBe(150);
    expect(GREAT_LAKE_RADIUS_M).toBe(150);
    expect(INLAND_RADIUS_M).toBe(120);
  });
});

// --- Golden-fixture replay (temporary shadow-period scaffolding) ----------
// test/fixtures/overpass-golden.json holds REAL Overpass responses captured
// against the live mirrors for the representative beaches of contract 9.1 —
// a named shoreline beach, unnamed park beaches, the Hawthorn Pond sliver that
// must drop, a Georgian Bay Great Lake beach, a set-back Sleeping Bear
// multipolygon, an island-in-a-hole, an inland no-water beach — together with
// the records and signals the pure functions derived from them AT CAPTURE
// TIME, i.e. before the relocation.
//
// Replaying those recorded inputs through the relocated functions is the only
// mechanical proof that the move changed nothing on REAL data; the synthetic
// fixtures above pin the rules, this pins the outcomes. The fixture and this
// block are scaffolding for the prebuilt-layer migration's shadow period and
// are deleted together once its delete path is armed.
const golden = JSON.parse(
  readFileSync(new URL("./fixtures/overpass-golden.json", import.meta.url), "utf8")
);

describe("overpass-golden fixture replay", () => {
  it("reproduces every recorded keep/drop and park association from the real captured elements", () => {
    let replayedCases = 0;
    let replayedBeaches = 0;
    let replayedDrops = 0;
    for (const capture of golden.cases) {
      const park = capture.park;
      if (!park || !park.parsed) {
        continue;
      }
      replayedCases = replayedCases + 1;

      // 1. The pond-evidence seed set.
      expect(pondWaterSeeds(park.parsed.beaches)).toEqual(park.pondSeeds);

      // 2. The keep/drop pass and the park association, exactly as
      //    fetchParkBeaches runs them.
      const records = [];
      const dropped = [];
      for (const beach of park.parsed.beaches) {
        if (beach.name === null &&
            beach.areaDeg2 < POND_TEST_MAX_BEACH_AREA_DEG2 &&
            isPondBeach(beach, park.waters)) {
          dropped.push({ osmType: beach.osmType, osmId: beach.osmId, areaDeg2: beach.areaDeg2 });
          continue;
        }
        const associated = associateParkForBeach(beach, park.parsed.parks);
        records.push({
          osmType: beach.osmType,
          osmId: beach.osmId,
          name: beach.name,
          locality: beach.locality,
          lat: beach.lat,
          lon: beach.lon,
          areaDeg2: beach.areaDeg2,
          parkName: associated === null ? null : associated.name,
          parkKey: associated === null ? null : associated.osmType + "/" + String(associated.osmId)
        });
      }
      expect(records).toEqual(park.records);
      expect(dropped).toEqual(park.droppedPondBeaches);
      replayedBeaches = replayedBeaches + records.length;
      replayedDrops = replayedDrops + dropped.length;
    }
    // A silently empty fixture would make every assertion above vacuous, so
    // pin the shape of what was captured: 8 cases, 13 kept beaches and the 2
    // pond slivers (Hawthorn Pond way/161131900 and the Independence Oaks
    // sliver) that must exercise the DROP path.
    expect(replayedCases).toBe(8);
    expect(replayedBeaches).toBe(13);
    expect(replayedDrops).toBe(2);
  });
});

// --- The prebuilt-layer half ---------------------------------------------------
// Coverage for the NEW functions of src/osmSelect.js: the ones that reproduce
// what Overpass QL was doing implicitly (scan order, the recurse-down probe
// anchor) and the field derivations parseParkBeachElements used to own.
//
// Every fixture below is built IN MEMORY from readable primitives by the two
// helpers that follow — no committed binaries, no GDAL, no pretest step. The
// helpers take explicit MALFORMATION knobs (a null geometry, absent bounds, a
// missing name) so a malformed case is a named argument rather than a
// hand-rolled object that drifts away from the real record shape.

// One LayerFeature, the record shape scripts/lib/fgbReader.js produces. Note
// that absent tags are OMITTED, never set to null — that is the documented
// contract of toLayerFeature, and a builder that reads tags.name must cope with
// the key simply not being there.
function layerFeature(overrides) {
  const base = {
    layer: "beaches",
    osmType: "way",
    osmId: 1,
    tags: {},
    bounds: { minLat: 42.0, minLon: -86.0, maxLat: 42.2, maxLon: -85.6 },
    geometry: null
  };
  return Object.assign(base, overrides || {});
}

// A closed square ring as GeoJSON [lon, lat] positions, first position
// repeated last exactly as a real OSM closed way is emitted.
function squareRing(minLon, minLat, size) {
  return [
    [minLon, minLat],
    [minLon, minLat + size],
    [minLon + size, minLat + size],
    [minLon + size, minLat],
    [minLon, minLat]
  ];
}

// Bounds that exactly enclose a list of [lon, lat] positions — the same walk
// toLayerFeature does, so a fixture's bounds and geometry never disagree.
function boundsOfPositions(positions) {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const position of positions) {
    minLon = Math.min(minLon, position[0]);
    maxLon = Math.max(maxLon, position[0]);
    minLat = Math.min(minLat, position[1]);
    maxLat = Math.max(maxLat, position[1]);
  }
  return { minLat: minLat, minLon: minLon, maxLat: maxLat, maxLon: maxLon };
}

describe("POND_EVIDENCE_RADIUS_M", () => {
  // Was the bare literal 60 inside the Overpass around.b:60 clause. Pinned
  // here with the other radii because it is a product rule (how close mapped
  // water counts as evidence), and widening it would silently change which
  // unnamed beaches the pond filter can see large water for.
  it("is the 60 m the Overpass around clause used", () => {
    expect(POND_EVIDENCE_RADIUS_M).toBe(60);
  });
});

describe("sortLayerFeatures", () => {
  it("restores node, then way, then relation, each id ascending", () => {
    const shuffled = [
      layerFeature({ osmType: "relation", osmId: 7 }),
      layerFeature({ osmType: "way", osmId: 900 }),
      layerFeature({ osmType: "node", osmId: 55 }),
      layerFeature({ osmType: "way", osmId: 12 }),
      layerFeature({ osmType: "relation", osmId: 3 }),
      layerFeature({ osmType: "node", osmId: 4 })
    ];
    const keys = sortLayerFeatures(shuffled).map(function (f) {
      return f.osmType + "/" + String(f.osmId);
    });
    expect(keys).toEqual([
      "node/4", "node/55", "way/12", "way/900", "relation/3", "relation/7"
    ]);
  });

  it("sorts ids numerically, not lexicographically", () => {
    // The trap that makes a first-seen tie flip: "9" > "10" as strings.
    const features = [
      layerFeature({ osmType: "way", osmId: 10 }),
      layerFeature({ osmType: "way", osmId: 9 }),
      layerFeature({ osmType: "way", osmId: 100 })
    ];
    expect(sortLayerFeatures(features).map(function (f) { return f.osmId; }))
      .toEqual([9, 10, 100]);
  });

  it("does not mutate the caller's array", () => {
    // The same layer array is handed to more than one pipeline step; an
    // in-place sort would make step order matter invisibly.
    const features = [
      layerFeature({ osmType: "way", osmId: 2 }),
      layerFeature({ osmType: "node", osmId: 1 })
    ];
    const sorted = sortLayerFeatures(features);
    expect(features[0].osmType).toBe("way");
    expect(sorted).not.toBe(features);
    // Element identity is preserved: it is a reordering, not a copy of records.
    expect(sorted[0]).toBe(features[1]);
  });

  it("sorts an unrecognised osmType last rather than throwing", () => {
    // Layer data is upstream input: a mystery element at the end of the scan
    // can at worst lose a first-seen tie, whereas a throw fails a whole run.
    const features = [
      layerFeature({ osmType: "wormhole", osmId: 1 }),
      layerFeature({ osmType: "node", osmId: 9 })
    ];
    expect(sortLayerFeatures(features).map(function (f) { return f.osmType; }))
      .toEqual(["node", "wormhole"]);
  });

  it("is a no-op on an empty array", () => {
    expect(sortLayerFeatures([])).toEqual([]);
  });
});

describe("envelopeCenter", () => {
  it("is the midpoint of the bounds rectangle", () => {
    expect(envelopeCenter({ minLat: 42.0, minLon: -86.4, maxLat: 42.5, maxLon: -86.0 }))
      .toEqual({ lat: 42.25, lon: -86.2 });
  });

  it("returns the point itself for a zero-extent (node) envelope", () => {
    expect(envelopeCenter({ minLat: 43.1, minLon: -85.2, maxLat: 43.1, maxLon: -85.2 }))
      .toEqual({ lat: 43.1, lon: -85.2 });
  });

  it("matches the beach coordinate the moved-guard was calibrated against", () => {
    // WATER_CLASS_MOVE_DEG is 0.001: any derivation that differs from the
    // envelope midpoint by more than that NULLs water_class table-wide on the
    // first run and re-exposes every inland beach the classifier had hidden.
    const bounds = { minLat: 42.7792907, minLon: -86.0260356, maxLat: 42.7793370, maxLon: -86.0259587 };
    const center = envelopeCenter(bounds);
    expect(center.lat).toBe((bounds.minLat + bounds.maxLat) / 2);
    expect(center.lon).toBe((bounds.minLon + bounds.maxLon) / 2);
  });
});

describe("probeVertices", () => {
  it("returns the point itself for a node", () => {
    const node = layerFeature({
      osmType: "node",
      osmId: 42,
      bounds: { minLat: 43.0, minLon: -85.5, maxLat: 43.0, maxLon: -85.5 },
      geometry: { type: "Point", coordinates: [-85.5, 43.0] }
    });
    expect(probeVertices(node)).toEqual([{ lat: 43.0, lon: -85.5 }]);
  });

  it("returns every member vertex of a way, in geometry order", () => {
    const positions = [[-86.2, 42.1], [-86.1, 42.15], [-86.0, 42.2]];
    const way = layerFeature({
      bounds: boundsOfPositions(positions),
      geometry: { type: "LineString", coordinates: positions }
    });
    expect(probeVertices(way)).toEqual([
      { lat: 42.1, lon: -86.2 },
      { lat: 42.15, lon: -86.1 },
      { lat: 42.2, lon: -86.0 }
    ]);
  });

  it("returns hole-ring vertices too, matching Overpass recurse-down", () => {
    // ">" returned the whole member-node set, holes included; an island-in-a-
    // hole beach depends on those vertices existing.
    const outer = squareRing(-86.0, 42.0, 0.1);
    const hole = squareRing(-85.97, 42.03, 0.02);
    const relation = layerFeature({
      osmType: "relation",
      osmId: 5,
      bounds: boundsOfPositions(outer),
      geometry: { type: "Polygon", coordinates: [outer, hole] }
    });
    const vertices = probeVertices(relation);
    expect(vertices.length).toBe(outer.length + hole.length);
    expect(vertices).toContainEqual({ lat: 42.03, lon: -85.97 });
  });

  it("walks every polygon of a MultiPolygon", () => {
    const a = squareRing(-86.0, 42.0, 0.05);
    const b = squareRing(-85.5, 42.4, 0.05);
    const multi = layerFeature({
      osmType: "relation",
      osmId: 6,
      bounds: boundsOfPositions(a.concat(b)),
      geometry: { type: "MultiPolygon", coordinates: [[a], [b]] }
    });
    const vertices = probeVertices(multi);
    expect(vertices.length).toBe(a.length + b.length);
    expect(vertices).toContainEqual({ lat: 42.4, lon: -85.5 });
  });

  it("is measured from vertices, not the centroid (the Sleeping Bear case)", () => {
    // A long shore-hugging beach whose ENVELOPE CENTRE sits well inland of the
    // waterline while its vertices are right on it. If any probe were anchored
    // to the centroid instead, this beach would classify inland.
    const positions = [[-86.06, 44.90], [-86.05, 44.95], [-86.04, 45.00]];
    const beach = layerFeature({
      bounds: { minLat: 44.90, minLon: -86.06, maxLat: 45.00, maxLon: -85.90 },
      geometry: { type: "LineString", coordinates: positions }
    });
    const center = envelopeCenter(beach.bounds);
    const vertices = probeVertices(beach);
    expect(vertices).toContainEqual({ lat: 44.90, lon: -86.06 });
    // The centre is nowhere in the probe set — that is the whole point.
    expect(vertices).not.toContainEqual(center);
  });

  it("falls back to the envelope centre when geometry yields no position", () => {
    // NOT to an empty set: an empty probe set reads to classifyWaterBody as a
    // clean "nothing in range" and becomes "inland", silently hiding a real
    // shore beach on the strength of missing data.
    const broken = layerFeature({ geometry: null });
    expect(probeVertices(broken)).toEqual([{ lat: 42.1, lon: -85.8 }]);
    const empty = layerFeature({ geometry: { type: "LineString", coordinates: [] } });
    expect(probeVertices(empty)).toEqual([{ lat: 42.1, lon: -85.8 }]);
  });

  it("skips a malformed position rather than emitting NaN", () => {
    const beach = layerFeature({
      geometry: {
        type: "LineString",
        coordinates: [[-86.0, 42.0], [null, 42.1], [-85.9, 42.2]]
      }
    });
    expect(probeVertices(beach)).toEqual([
      { lat: 42.0, lon: -86.0 },
      { lat: 42.2, lon: -85.9 }
    ]);
  });

  it("returns [] only when geometry AND bounds are both unusable", () => {
    expect(probeVertices(layerFeature({ geometry: null, bounds: null }))).toEqual([]);
  });
});

describe("beachRecord", () => {
  const positions = [[-86.0260356, 42.7792907], [-86.0259587, 42.7793370]];
  const bounds = boundsOfPositions(positions);

  function beachFeature(tags) {
    return layerFeature({
      osmId: 161131900,
      tags: tags,
      bounds: bounds,
      geometry: { type: "LineString", coordinates: positions }
    });
  }

  it("derives every field the park pass has always produced", () => {
    const record = beachRecord(beachFeature({
      natural: "beach",
      name: "Ottawa Beach",
      loc_name: "  Hamlin Lake  "
    }));
    expect(Object.keys(record).sort()).toEqual([
      "areaDeg2", "bounds", "lat", "locality", "lon", "name", "osmId", "osmType", "vertices"
    ]);
    expect(record.osmType).toBe("way");
    expect(record.osmId).toBe(161131900);
    expect(record.name).toBe("Ottawa Beach");
    // loc_name is TRIMMED, never substituted for name.
    expect(record.locality).toBe("Hamlin Lake");
    expect(record.lat).toBe((bounds.minLat + bounds.maxLat) / 2);
    expect(record.lon).toBe((bounds.minLon + bounds.maxLon) / 2);
    expect(record.bounds).toBe(bounds);
    expect(record.areaDeg2).toBe(
      (bounds.maxLat - bounds.minLat) * (bounds.maxLon - bounds.minLon)
    );
    expect(record.vertices.length).toBe(2);
  });

  it("turns an absent or empty name into null", () => {
    // "|| null", verbatim from parseParkBeachElements: an empty name tag is not
    // a name, and the pond filter keys off name === null.
    expect(beachRecord(beachFeature({ natural: "beach" })).name).toBeNull();
    expect(beachRecord(beachFeature({ natural: "beach", name: "" })).name).toBeNull();
  });

  it("turns an absent, blank or non-string loc_name into null", () => {
    expect(beachRecord(beachFeature({ natural: "beach" })).locality).toBeNull();
    expect(beachRecord(beachFeature({ natural: "beach", loc_name: "   " })).locality).toBeNull();
    expect(beachRecord(beachFeature({ natural: "beach", loc_name: 7 })).locality).toBeNull();
  });

  it("gives a node beach a zero areaDeg2 so it is always pond-testable", () => {
    const node = layerFeature({
      osmType: "node",
      osmId: 3,
      tags: { natural: "beach" },
      bounds: { minLat: 42.5, minLon: -85.5, maxLat: 42.5, maxLon: -85.5 },
      geometry: { type: "Point", coordinates: [-85.5, 42.5] }
    });
    const record = beachRecord(node);
    expect(record.areaDeg2).toBe(0);
    expect(record.areaDeg2).toBeLessThan(POND_TEST_MAX_BEACH_AREA_DEG2);
  });

  it("applies NO tag test — branch precedence belongs to the caller", () => {
    // An element tagged both natural=beach and park-ish is a beach ONLY, but
    // that decision is made by src/layerDiscovery.js consulting beachRecord
    // first; this builder must not second-guess which layer a feature came from.
    const dualTagged = beachFeature({ natural: "beach", leisure: "park", name: "Dual" });
    expect(beachRecord(dualTagged).name).toBe("Dual");
    // Even a park-only feature yields a record if the caller asks for one.
    expect(beachRecord(beachFeature({ leisure: "park", name: "Park" })).name).toBe("Park");
  });

  it("returns null for a feature with unusable bounds", () => {
    expect(beachRecord(layerFeature({ bounds: null }))).toBeNull();
    expect(beachRecord(layerFeature({
      bounds: { minLat: NaN, minLon: -86, maxLat: 42, maxLon: -85 }
    }))).toBeNull();
  });
});

describe("parkRecord", () => {
  const ring = squareRing(-86.3, 42.7, 0.2);
  function parkFeature(tags) {
    return layerFeature({
      layer: "parks",
      osmId: 555,
      tags: tags,
      bounds: boundsOfPositions(ring),
      geometry: { type: "Polygon", coordinates: [ring] }
    });
  }

  it("builds a record for a named park-tagged polygon and retains geometry", () => {
    const feature = parkFeature({ leisure: "park", name: "Holland State Park" });
    const record = parkRecord(feature);
    expect(Object.keys(record).sort()).toEqual([
      "areaDeg2", "bounds", "geometry", "name", "osmId", "osmType"
    ]);
    expect(record.name).toBe("Holland State Park");
    expect(record.areaDeg2).toBeCloseTo(0.04, 12);
    // Geometry is retained by reference: membership needs the actual rings,
    // not the envelope.
    expect(record.geometry).toBe(feature.geometry);
  });

  it("accepts all three park tag alternatives", () => {
    expect(parkRecord(parkFeature({ leisure: "park", name: "A" }))).not.toBeNull();
    expect(parkRecord(parkFeature({ leisure: "nature_reserve", name: "B" }))).not.toBeNull();
    expect(parkRecord(parkFeature({ boundary: "protected_area", name: "C" }))).not.toBeNull();
  });

  it("returns null for an unnamed park and for a named non-park", () => {
    // An unnamed park has nothing to donate; a named non-park is not a park.
    expect(parkRecord(parkFeature({ leisure: "park" }))).toBeNull();
    expect(parkRecord(parkFeature({ leisure: "park", name: "" }))).toBeNull();
    expect(parkRecord(parkFeature({ amenity: "parking", name: "Lot 3" }))).toBeNull();
  });

  it("keeps a named protected LAKE as a park (branch 2 precedes branch 3)", () => {
    // A named protected lake carries park tags AND natural=water. It must keep
    // donating its name to the beaches inside it: losing its water role only
    // errs toward KEEPING a beach, whereas losing its park role would unname
    // beaches and delete their park-origin rows.
    const protectedLake = parkFeature({
      natural: "water",
      boundary: "protected_area",
      name: "Hawthorn Pond Natural Area"
    });
    expect(parkRecord(protectedLake).name).toBe("Hawthorn Pond Natural Area");
  });

  it("returns null for a feature with unusable bounds", () => {
    expect(parkRecord(layerFeature({ tags: { leisure: "park", name: "X" }, bounds: null })))
      .toBeNull();
  });
});

describe("waterRecord", () => {
  const ring = squareRing(-86.03, 42.777, 0.0015);

  function waterFeature(tags, overrides) {
    return layerFeature(Object.assign({
      layer: "water",
      osmId: 77,
      tags: tags,
      bounds: boundsOfPositions(ring),
      geometry: { type: "Polygon", coordinates: [ring] }
    }, overrides || {}));
  }

  it("builds the pond-evidence record with the fields isPondBeach needs", () => {
    const feature = waterFeature({ natural: "water" });
    const record = waterRecord(feature);
    expect(Object.keys(record).sort()).toEqual([
      "areaDeg2", "bounds", "geometry", "osmType", "shoreline"
    ]);
    expect(record.shoreline).toBe(false);
    expect(record.areaDeg2).toBeCloseTo(0.0015 * 0.0015, 15);
    expect(record.geometry).toBe(feature.geometry);
    expect(record.osmType).toBe("way");
  });

  it("flags a coastline segment as shoreline so it always counts as large", () => {
    // A coastline feature is one SEGMENT of a shore, so its own envelope is
    // tiny — often far under WATER_MIN_AREA_DEG2. Without the flag, isPondBeach
    // would see only pond-sized water beside a Lake Michigan beach and drop it.
    const segment = waterFeature({ natural: "coastline" }, { layer: "coastline" });
    const record = waterRecord(segment);
    expect(record.shoreline).toBe(true);
    expect(record.areaDeg2).toBeLessThan(WATER_MIN_AREA_DEG2);
    // Proof of the consequence, not just of the boolean: a tiny beach beside a
    // tiny coastline segment is NOT a pond beach.
    const beach = {
      bounds: { minLat: 42.7776, minLon: -86.0301, maxLat: 42.7777, maxLon: -86.0300 }
    };
    expect(isPondBeach(beach, [record])).toBe(false);
  });

  it("applies no tag test — the layer build guarantees the tags", () => {
    expect(waterRecord(waterFeature({})).shoreline).toBe(false);
  });

  it("returns null for a feature with unusable bounds", () => {
    expect(waterRecord(layerFeature({ bounds: undefined }))).toBeNull();
  });
});

describe("the layer-feature pipeline (composed)", () => {
  it("threads Hilbert-ordered features through sort, the builders and the pond filter", () => {
    // One end-to-end pass in the order src/layerDiscovery.js runs it, on the
    // Hawthorn Pond shape that motivated the pond filter: a tiny unnamed beach
    // way inside a named protected area whose only nearby water is the pond
    // itself. Features arrive in deliberately scrambled (Hilbert) order.
    const pondRing = squareRing(-86.0273107, 42.7776573, 0.0015);
    const beachPositions = [[-86.0260356, 42.7792907], [-86.0259587, 42.7793370]];
    const parkRing = squareRing(-86.030, 42.775, 0.006);
    const bigBeachPositions = [[-86.21, 42.77], [-86.19, 42.79]];

    const features = [
      // relation first, way ids descending: everything sortLayerFeatures fixes.
      layerFeature({
        layer: "parks", osmType: "relation", osmId: 900,
        tags: { boundary: "protected_area", natural: "water", name: "Hawthorn Pond Natural Area" },
        bounds: boundsOfPositions(parkRing),
        geometry: { type: "Polygon", coordinates: [parkRing] }
      }),
      layerFeature({
        layer: "water", osmType: "way", osmId: 800,
        tags: { natural: "water" },
        bounds: boundsOfPositions(pondRing),
        geometry: { type: "Polygon", coordinates: [pondRing] }
      }),
      layerFeature({
        layer: "beaches", osmType: "way", osmId: 161131900,
        tags: { natural: "beach" },
        bounds: boundsOfPositions(beachPositions),
        geometry: { type: "LineString", coordinates: beachPositions }
      }),
      layerFeature({
        layer: "beaches", osmType: "way", osmId: 100,
        tags: { natural: "beach", name: "Tunnel Park Beach" },
        bounds: boundsOfPositions(bigBeachPositions),
        geometry: { type: "LineString", coordinates: bigBeachPositions }
      })
    ];

    const sorted = sortLayerFeatures(features);
    expect(sorted.map(function (f) { return f.osmType + "/" + String(f.osmId); }))
      .toEqual(["way/100", "way/800", "way/161131900", "relation/900"]);

    const beaches = [];
    const parks = [];
    const waters = [];
    for (const feature of sorted) {
      // The caller's branch precedence, in the one order that is load-bearing.
      if (feature.layer === "beaches") {
        beaches.push(beachRecord(feature));
      } else if (feature.layer === "parks") {
        parks.push(parkRecord(feature));
      } else {
        waters.push(waterRecord(feature));
      }
    }

    // Both beaches seed the pond gather (named ones seed too), because both are
    // under the oversize cutoff and one of them is unnamed.
    expect(pondWaterSeeds(beaches)).toEqual([
      { osmType: "way", osmId: 100 },
      { osmType: "way", osmId: 161131900 }
    ]);

    const kept = [];
    const dropped = [];
    for (const beach of beaches) {
      if (beach.name === null &&
          beach.areaDeg2 < POND_TEST_MAX_BEACH_AREA_DEG2 &&
          isPondBeach(beach, waters)) {
        dropped.push(beach.osmId);
        continue;
      }
      const park = associateParkForBeach(beach, parks);
      kept.push({
        osmId: beach.osmId,
        name: beach.name,
        lat: beach.lat,
        lon: beach.lon,
        parkName: park === null ? null : park.name
      });
    }

    // The unnamed sliver on the pond is dropped; the named Great Lakes beach
    // survives and is far enough away to associate with no park.
    expect(dropped).toEqual([161131900]);
    expect(kept.length).toBe(1);
    expect(kept[0].osmId).toBe(100);
    expect(kept[0].name).toBe("Tunnel Park Beach");
    expect(kept[0].parkName).toBeNull();
    // Coordinates are the envelope midpoint to the last bit — asserted against
    // envelopeCenter rather than a decimal literal, because a rounded literal
    // would hide exactly the sub-0.001-degree drift the moved-guard cares about.
    expect(kept[0].lat).toBe(envelopeCenter(boundsOfPositions(bigBeachPositions)).lat);
    expect(kept[0].lon).toBe(envelopeCenter(boundsOfPositions(bigBeachPositions)).lon);
  });
});
