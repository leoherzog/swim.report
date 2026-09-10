// The map's read-time feature resolution (src/mapFeatures.js): one beach_state
// JOIN row in, one GeoJSON Feature out.
//
// The load-bearing case is parity. The row stores ingredients — each record's
// color, updated stamp and expiry — and resolves them through the real
// markerFlagColor, so every case below is asserted against that function called
// directly on the same values. If the two ever diverge, the map marker and the
// detail page's title flag disagree about one beach.
import { describe, it, expect } from "vitest";
import { mapFeatureFromRow } from "../src/mapFeatures.js";
import { markerFlagColor } from "../src/frontend/render.js";

const NOW_MS = Date.parse("2026-07-04T15:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();
const NOW_EPOCH = Math.floor(NOW_MS / 1000);

function agoIso(ms) {
  return new Date(NOW_MS - ms).toISOString();
}

// A row as the geojson SELECT returns it. Records default to absent; pass
// estimate / official as { color, updated, expires } to fill them in.
function row(overrides) {
  const extra = overrides || {};
  const base = {
    id: "b1",
    name: "One",
    park_name: null,
    lat: 42,
    lon: -86,
    estimate_color: null,
    estimate_updated: null,
    estimate_expires: null,
    official_color: null,
    official_updated: null,
    official_expires: null
  };
  for (const key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) {
      base[key] = extra[key];
    }
  }
  return base;
}

// The live column set for a record: an expiry an hour out unless one is given.
function live(record, expires) {
  return {
    color: record.color,
    updated: record.updated === undefined ? null : record.updated,
    expires: expires === undefined ? NOW_EPOCH + 3600 : expires
  };
}

function withRecords(estimate, official, overrides) {
  const fields = overrides || {};
  if (estimate) {
    fields.estimate_color = estimate.color;
    fields.estimate_updated = estimate.updated;
    fields.estimate_expires = estimate.expires;
  }
  if (official) {
    fields.official_color = official.color;
    fields.official_updated = official.updated;
    fields.official_expires = official.expires;
  }
  return row(fields);
}

function flagOf(rowValue) {
  return mapFeatureFromRow(rowValue, NOW_ISO).properties.flag;
}

describe("mapFeatureFromRow geometry and label", function () {
  it("returns null for a missing row or a non-finite lat or lon", function () {
    expect(mapFeatureFromRow(null, NOW_ISO)).toBe(null);
    expect(mapFeatureFromRow(row({ lat: null }), NOW_ISO)).toBe(null);
    expect(mapFeatureFromRow(row({ lon: "nope" }), NOW_ISO)).toBe(null);
    expect(mapFeatureFromRow(row({}), NOW_ISO)).not.toBe(null);
  });

  it("emits a Point in [lon, lat] order, coercing numeric strings", function () {
    const feature = mapFeatureFromRow(row({ lat: "42.5", lon: "-86.5" }), NOW_ISO);
    expect(feature.type).toBe("Feature");
    expect(feature.geometry.type).toBe("Point");
    expect(feature.geometry.coordinates).toEqual([-86.5, 42.5]);
    expect(feature.properties.id).toBe("b1");
  });

  it("labels with park_name, falling back to name and then the empty string", function () {
    expect(mapFeatureFromRow(row({ park_name: "Big Park" }), NOW_ISO).properties.name)
      .toBe("Big Park");
    expect(mapFeatureFromRow(row({}), NOW_ISO).properties.name).toBe("One");
    expect(mapFeatureFromRow(row({ name: null }), NOW_ISO).properties.name).toBe("");
  });
});

describe("mapFeatureFromRow color resolution", function () {
  it("matches markerFlagColor called directly on the same records", function () {
    // Four fixtures spanning the whole displayFlagColor gate: no official; a
    // fresh official below its estimate; a fresh official above it; and an
    // official past the 2 h horizon with a more severe estimate.
    const fixtures = [
      { estimate: { color: "yellow", updated: agoIso(600000) }, official: null },
      {
        estimate: { color: "red", updated: agoIso(600000) },
        official: { color: "yellow", updated: agoIso(600000) }
      },
      {
        estimate: { color: "green", updated: agoIso(600000) },
        official: { color: "red", updated: agoIso(600000) }
      },
      {
        estimate: { color: "red", updated: agoIso(600000) },
        official: { color: "yellow", updated: agoIso(10800000) }
      }
    ];
    const colors = [];
    for (const fixture of fixtures) {
      const flag = flagOf(withRecords(
        fixture.estimate ? live(fixture.estimate) : null,
        fixture.official ? live(fixture.official) : null
      ));
      expect(flag).toBe(markerFlagColor(fixture.estimate, fixture.official, NOW_ISO));
      colors.push(flag);
    }
    // Sanity: the fixture set actually exercises more than one outcome.
    expect(colors).toEqual(["yellow", "yellow", "red", "red"]);
  });

  it("resolves a row with no state at all to unknown", function () {
    expect(flagOf(row({}))).toBe("unknown");
  });

  it("collapses double-red and maps an unrecognized color to unknown", function () {
    expect(flagOf(withRecords(null, live({ color: "double-red", updated: NOW_ISO })))).toBe("red");
    expect(flagOf(withRecords(null, live({ color: "magenta", updated: NOW_ISO })))).toBe("unknown");
  });

  it("keeps an official that has no estimate beside it", function () {
    expect(flagOf(withRecords(null, live({ color: "green", updated: agoIso(600000) }))))
      .toBe("green");
  });

  it("weighs an official whose reading is far older than its lease", function () {
    // A point-in-time official reading legitimately carries an updated far older
    // than its write time. Its lease, not its timestamp, decides whether it is
    // still stored; past the 2 h display horizon it becomes a raise-only floor,
    // which is never lower than the estimate alone.
    const estimate = { color: "yellow", updated: agoIso(600000) };
    const official = { color: "red", updated: agoIso(43200000) };
    const flag = flagOf(withRecords(live(estimate), live(official)));
    expect(flag).toBe("red");
    expect(flag).toBe(markerFlagColor(estimate, official, NOW_ISO));
  });
});

describe("mapFeatureFromRow expiry", function () {
  const GREEN = { color: "green", updated: agoIso(600000) };

  it("reads an expired estimate as unknown, never as its stored green", function () {
    expect(flagOf(withRecords(live(GREEN, NOW_EPOCH), null))).toBe("unknown");
    expect(flagOf(withRecords(live(GREEN, NOW_EPOCH - 60), null))).toBe("unknown");
    expect(flagOf(withRecords(live(GREEN, NOW_EPOCH + 1), null))).toBe("green");
  });

  it("reads a NULL or non-numeric expiry as expired", function () {
    expect(flagOf(withRecords(live(GREEN, null), null))).toBe("unknown");
    expect(flagOf(withRecords(live(GREEN, "soon"), null))).toBe("unknown");
  });

  it("expires each record on its own column", function () {
    // The two records carry independent leases: an expired estimate leaves a live
    // posted flag on the map, and an expired official leaves the estimate deciding
    // alone.
    const red = { color: "red", updated: agoIso(600000) };
    expect(flagOf(withRecords(live(GREEN, NOW_EPOCH - 1), live(red)))).toBe("red");
    expect(flagOf(withRecords(live(GREEN), live(red, NOW_EPOCH - 1)))).toBe("green");
  });

  it("takes the instant from the caller's nowMs, falling back to nowIso", function () {
    // The geojson loop hands down the nowMs it already has, so the per-row call
    // parses nothing; with the argument omitted the instant still comes from
    // nowIso, which is what keeps the two from naming different clocks.
    const expiring = withRecords(live(GREEN, NOW_EPOCH + 10), null);
    expect(mapFeatureFromRow(expiring, NOW_ISO, NOW_MS).properties.flag).toBe("green");
    expect(mapFeatureFromRow(expiring, NOW_ISO, NOW_MS + 20000).properties.flag)
      .toBe("unknown");
    expect(mapFeatureFromRow(expiring, NOW_ISO, "later").properties.flag).toBe("green");
    expect(mapFeatureFromRow(expiring, NOW_ISO).properties.flag).toBe("green");
  });
});
