// The precomputed map directory (src/mapDirectory.js): the entry shape both
// beach-touching crons build and the read-time resolution the request path
// applies to it.
//
// The load-bearing case is parity. The artifact stores ingredients and resolves
// them through the real markerFlagColor at read time, so every case below is
// asserted against that function called directly on the same values — if the two
// ever diverge, the map marker and the detail page's title flag disagree about
// one beach.
import { describe, it, expect } from "vitest";
import {
  MAP_DIRECTORY_VERSION,
  mapDirectoryEntry,
  buildMapDirectory,
  mapDirectoryFeatures
} from "../src/mapDirectory.js";
import { markerFlagColor } from "../src/frontend/render.js";
import { FLAG_TTL_MS } from "../src/flagTtl.js";

const NOW_MS = Date.parse("2026-07-04T15:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();

function agoIso(ms) {
  return new Date(NOW_MS - ms).toISOString();
}

function row(overrides) {
  const base = { id: "b1", name: "One", park_name: null, lat: 42, lon: -86 };
  const extra = overrides || {};
  for (const key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) {
      base[key] = extra[key];
    }
  }
  return base;
}

function directoryOf(entries) {
  return buildMapDirectory(entries, NOW_ISO);
}

function flagOf(entry) {
  const features = mapDirectoryFeatures(directoryOf([entry]), NOW_ISO);
  expect(features.length).toBe(1);
  return features[0].properties.flag;
}

describe("mapDirectoryEntry", function () {
  it("drops a row with a non-finite lat or lon", function () {
    expect(mapDirectoryEntry(row({ lat: null }), null, null)).toBe(null);
    expect(mapDirectoryEntry(row({ lon: "nope" }), null, null)).toBe(null);
    expect(mapDirectoryEntry(row({ lat: 42, lon: -86 }), null, null)).not.toBe(null);
  });

  it("labels with park_name, falling back to name and then the empty string", function () {
    expect(mapDirectoryEntry(row({ park_name: "Big Park" }), null, null).name).toBe("Big Park");
    expect(mapDirectoryEntry(row({ park_name: null }), null, null).name).toBe("One");
    expect(mapDirectoryEntry(row({ park_name: null, name: null }), null, null).name).toBe("");
  });

  it("carries lon/lat as finite numbers in GeoJSON order", function () {
    const entry = mapDirectoryEntry(row({ lat: "42.5", lon: "-86.5" }), null, null);
    expect(entry.lat).toBe(42.5);
    expect(entry.lon).toBe(-86.5);
  });

  it("nulls both estimate fields for a null estimate and both official fields for a null official", function () {
    const entry = mapDirectoryEntry(row({}), null, null);
    expect(entry.estColor).toBe(null);
    expect(entry.estUpdated).toBe(null);
    expect(entry.offColor).toBe(null);
    expect(entry.offUpdated).toBe(null);
  });

  it("echoes color and updated from each record", function () {
    const entry = mapDirectoryEntry(
      row({}),
      { color: "yellow", updated: NOW_ISO },
      { color: "red", updated: agoIso(3600000) }
    );
    expect(entry.estColor).toBe("yellow");
    expect(entry.estUpdated).toBe(NOW_ISO);
    expect(entry.offColor).toBe("red");
    expect(entry.offUpdated).toBe(agoIso(3600000));
  });
});

describe("buildMapDirectory", function () {
  it("stamps the version, the build instant and the entry count", function () {
    const entries = [
      mapDirectoryEntry(row({ id: "a" }), null, null),
      mapDirectoryEntry(row({ id: "b" }), null, null)
    ];
    const directory = buildMapDirectory(entries, NOW_ISO);
    expect(directory.v).toBe(MAP_DIRECTORY_VERSION);
    expect(directory.builtAt).toBe(NOW_ISO);
    expect(directory.count).toBe(2);
    expect(directory.count).toBe(directory.entries.length);
  });
});

describe("mapDirectoryFeatures", function () {
  it("emits Point features in [lon, lat] order carrying id and name", function () {
    const entry = mapDirectoryEntry(row({ id: "b1", park_name: "Big Park" }), null, null);
    const features = mapDirectoryFeatures(directoryOf([entry]), NOW_ISO);
    expect(features[0].type).toBe("Feature");
    expect(features[0].geometry.type).toBe("Point");
    expect(features[0].geometry.coordinates).toEqual([-86, 42]);
    expect(features[0].properties.id).toBe("b1");
    expect(features[0].properties.name).toBe("Big Park");
  });

  it("matches markerFlagColor called directly on the same records", function () {
    // Four fixtures spanning the whole displayFlagColor gate: no official; a
    // fresh official below its estimate; a fresh official above it; and an
    // official past the 2 h horizon with a more severe estimate.
    const fixtures = [
      { id: "no-official", estimate: { color: "yellow", updated: agoIso(600000) }, official: null },
      {
        id: "fresh-over-estimate",
        estimate: { color: "red", updated: agoIso(600000) },
        official: { color: "yellow", updated: agoIso(600000) }
      },
      {
        id: "fresh-above-estimate",
        estimate: { color: "green", updated: agoIso(600000) },
        official: { color: "red", updated: agoIso(600000) }
      },
      {
        id: "aged-official",
        estimate: { color: "red", updated: agoIso(600000) },
        official: { color: "yellow", updated: agoIso(10800000) }
      }
    ];
    const entries = fixtures.map(function (f) {
      return mapDirectoryEntry(row({ id: f.id }), f.estimate, f.official);
    });
    const features = mapDirectoryFeatures(directoryOf(entries), NOW_ISO);
    for (let i = 0; i < fixtures.length; i = i + 1) {
      expect(features[i].properties.id).toBe(fixtures[i].id);
      expect(features[i].properties.flag).toBe(
        markerFlagColor(fixtures[i].estimate, fixtures[i].official, NOW_ISO)
      );
    }
    // Sanity: the fixture set actually exercises more than one outcome.
    const colors = features.map(function (f) { return f.properties.flag; });
    expect(colors).toEqual(["yellow", "yellow", "red", "red"]);
  });

  it("resolves an expired estimate to unknown, never to its stored green", function () {
    const atTtl = mapDirectoryEntry(
      row({}), { color: "green", updated: agoIso(FLAG_TTL_MS) }, null
    );
    const pastTtl = mapDirectoryEntry(
      row({}), { color: "green", updated: agoIso(FLAG_TTL_MS + 60000) }, null
    );
    expect(flagOf(atTtl)).toBe("unknown");
    expect(flagOf(pastTtl)).toBe("unknown");
  });

  it("drops the official together with a provably expired estimate", function () {
    // Both keys are written in the same run and share FLAG_TTL_SECONDS, so an
    // expired estimate proves its paired official expired too. Without the
    // coupling this entry renders green where the live path renders unknown.
    const entry = mapDirectoryEntry(
      row({}),
      { color: "green", updated: agoIso(FLAG_TTL_MS + 1) },
      { color: "green", updated: agoIso(FLAG_TTL_MS + 1) }
    );
    expect(flagOf(entry)).toBe("unknown");
  });

  it("keeps an official that has no estimate beside it", function () {
    const entry = mapDirectoryEntry(row({}), null, { color: "green", updated: agoIso(600000) });
    expect(entry.estUpdated).toBe(null);
    expect(flagOf(entry)).toBe("green");
  });

  it("applies no independent expiry check to the official half", function () {
    // A point-in-time official reading legitimately carries an updated far older
    // than its write time. Dropping it would hand the marker the estimate's
    // color where the live path returns the worst of the two, which is never
    // lower — so the aged official is still weighed.
    const estimate = { color: "yellow", updated: agoIso(600000) };
    const official = { color: "red", updated: agoIso(43200000) };
    const entry = mapDirectoryEntry(row({}), estimate, official);
    expect(flagOf(entry)).toBe("red");
    expect(flagOf(entry)).toBe(markerFlagColor(estimate, official, NOW_ISO));
  });

  it("returns [] for a null, malformed or version-mismatched directory", function () {
    expect(mapDirectoryFeatures(null, NOW_ISO)).toEqual([]);
    expect(mapDirectoryFeatures({}, NOW_ISO)).toEqual([]);
    expect(mapDirectoryFeatures({ v: 2, entries: [] }, NOW_ISO)).toEqual([]);
    expect(mapDirectoryFeatures("nope", NOW_ISO)).toEqual([]);
  });

  it("collapses double-red and maps an unrecognized color to unknown", function () {
    expect(flagOf(mapDirectoryEntry(row({}), null, { color: "double-red" }))).toBe("red");
    expect(flagOf(mapDirectoryEntry(row({}), null, { color: "magenta" }))).toBe("unknown");
  });

  it("resolves an entry with neither color to unknown", function () {
    expect(flagOf(mapDirectoryEntry(row({}), null, null))).toBe("unknown");
  });
});
