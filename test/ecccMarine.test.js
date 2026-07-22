// [experimental] ECCC marine-warnings client tests. Fixtures mirror real
// api.weather.gc.ca/collections/marineweather-realtime responses (pygeoapi
// GeoJSON: per-zone Polygon features; properties.area.region.en "Great Lakes";
// properties.warnings.locations[].events[] { name.en, type.en, category.en
// "marine", status.en "IN EFFECT"/"CONTINUED"/"ENDED" }; properties.lastUpdated
// ISO). No network — the pure parser + point matcher are exercised against
// inline fixtures; the fetch wrapper is exercised via a stubbed globalThis.fetch.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseEcccMarineAlerts,
  ecccMarineAlertsForPoint,
  fetchActiveEcccMarineAlerts,
  marineEventColor,
  MARINE_EVENT_COLOR_MAP,
  MARINE_FLOOR_EVENTS,
  ECCC_MARINE_MAX_EDGE_KM,
  ECCC_MARINE_GREAT_LAKES_REGION
} from "../src/clients/ecccMarine.js";

const NOW_ISO = "2026-07-22T12:00:00.000Z";

// A ~0.4-degree square Polygon centered on (lat, lon).
function squareAround(lat, lon) {
  return {
    type: "Polygon",
    coordinates: [[
      [lon - 0.2, lat - 0.2],
      [lon + 0.2, lat - 0.2],
      [lon + 0.2, lat + 0.2],
      [lon - 0.2, lat + 0.2],
      [lon - 0.2, lat - 0.2]
    ]]
  };
}

// Build one GeoMet marine Feature (a zone) with the given events. Centered on a
// Lake Erie point by default.
function marineFeature(opts) {
  const o = opts || {};
  const region = Object.prototype.hasOwnProperty.call(o, "region") ? o.region : "Great Lakes";
  const value = Object.prototype.hasOwnProperty.call(o, "value") ? o.value : "Lake Erie";
  const lat = typeof o.lat === "number" ? o.lat : 42.2;
  const lon = typeof o.lon === "number" ? o.lon : -81.2;
  const events = Array.isArray(o.events) ? o.events : [];
  return {
    type: "Feature",
    id: o.id || "m0000200",
    geometry: squareAround(lat, lon),
    properties: {
      area: {
        countryCode: "CA",
        region: { en: region, fr: region },
        value: { en: value, fr: value }
      },
      lastUpdated: o.lastUpdated || "2026-07-22T10:00:00Z",
      warnings: {
        locations: [
          {
            name: { en: value, fr: value },
            events: events
          }
        ]
      }
    }
  };
}

// Build one event object. status defaults to an active "IN EFFECT".
function marineEvent(name, status) {
  return {
    name: { en: name, fr: name },
    type: { en: /warning/i.test(name) ? "warning" : "watch", fr: "" },
    category: { en: "marine", fr: "maritime" },
    status: { en: status || "IN EFFECT", fr: "" }
  };
}

function collection(features) {
  return { type: "FeatureCollection", features: features };
}

function okJson(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve(body); }
  });
}

describe("marineEventColor", function () {
  it("maps warnings to their intended flag colors", function () {
    expect(marineEventColor("Storm warning")).toBe("double-red");
    expect(marineEventColor("gale warning")).toBe("red");
    expect(marineEventColor("Squall warning")).toBe("red");
    expect(marineEventColor("Waterspout warning")).toBe("red");
    expect(marineEventColor("Strong wind warning")).toBe("yellow");
    expect(marineEventColor("Marine weather advisory")).toBe("yellow");
  });

  it("leaves watches, ice warnings, and unknowns UNMAPPED (null)", function () {
    expect(marineEventColor("Gale watch")).toBe(null);
    expect(marineEventColor("Storm watch")).toBe(null);
    expect(marineEventColor("Special ice warning")).toBe(null);
    expect(marineEventColor("some brand new warning")).toBe(null);
  });

  it("does not confuse marine 'storm warning' with land 'storm surge warning'", function () {
    expect(marineEventColor("storm warning")).toBe("double-red");
    // land storm-surge is NOT this collection's concern -> unmapped here
    expect(marineEventColor("storm surge warning")).toBe(null);
  });

  it("returns null (does not throw) on non-string / empty input", function () {
    expect(marineEventColor(null)).toBe(null);
    expect(marineEventColor(undefined)).toBe(null);
    expect(marineEventColor("")).toBe(null);
    expect(marineEventColor(42)).toBe(null);
  });

  it("exports the floor events and never maps a floor event above yellow", function () {
    expect(MARINE_FLOOR_EVENTS).toEqual(["strong wind warning", "marine weather advisory"]);
    for (let i = 0; i < MARINE_FLOOR_EVENTS.length; i = i + 1) {
      expect(MARINE_EVENT_COLOR_MAP[MARINE_FLOOR_EVENTS[i]]).toBe("yellow");
    }
  });
});

describe("parseEcccMarineAlerts", function () {
  it("extracts active Great Lakes marine warnings (Lake Erie: strong wind + gale)", function () {
    const json = collection([
      marineFeature({
        value: "Lake Erie",
        lat: 42.2,
        lon: -81.2,
        events: [
          marineEvent("Strong wind warning", "IN EFFECT"),
          marineEvent("Gale warning", "CONTINUED")
        ]
      })
    ]);
    const alerts = parseEcccMarineAlerts(json, NOW_ISO);
    expect(Array.isArray(alerts)).toBe(true);
    expect(alerts.length).toBe(2);
    // event names are lowercased to match the rules.js keying
    expect(alerts[0].event).toBe("strong wind warning");
    expect(alerts[1].event).toBe("gale warning");
    // onset falls back to properties.lastUpdated; ends is null (no per-event expiry)
    expect(alerts[0].onset).toBe("2026-07-22T10:00:00Z");
    expect(alerts[0].ends).toBe(null);
    expect(alerts[0].region).toBe(ECCC_MARINE_GREAT_LAKES_REGION);
    expect(alerts[0].value).toBe("Lake Erie");
    expect(alerts[0].geometry.type).toBe("Polygon");
  });

  it("drops ENDED events but keeps IN EFFECT / CONTINUED", function () {
    const json = collection([
      marineFeature({
        events: [
          marineEvent("Gale warning", "ENDED"),
          marineEvent("Strong wind warning", "IN EFFECT")
        ]
      })
    ]);
    const alerts = parseEcccMarineAlerts(json, NOW_ISO);
    expect(alerts.length).toBe(1);
    expect(alerts[0].event).toBe("strong wind warning");
  });

  it("drops an unrecognized/missing status (fail closed)", function () {
    const json = collection([
      marineFeature({ events: [marineEvent("Gale warning", "SOME NEW STATUS")] })
    ]);
    expect(parseEcccMarineAlerts(json, NOW_ISO)).toEqual([]);
    const noStatus = collection([
      marineFeature({
        events: [{
          name: { en: "Gale warning" },
          type: { en: "warning" },
          category: { en: "marine" }
        }]
      })
    ]);
    expect(parseEcccMarineAlerts(noStatus, NOW_ISO)).toEqual([]);
  });

  it("ignores non-Great-Lakes regions and non-marine categories", function () {
    const json = collection([
      marineFeature({
        region: "St. Lawrence",
        value: "Lake Saint-Jean",
        events: [marineEvent("Gale warning", "IN EFFECT")]
      }),
      marineFeature({
        value: "Lake Huron",
        events: [{
          name: { en: "Gale warning" },
          type: { en: "warning" },
          category: { en: "public" },
          status: { en: "IN EFFECT" }
        }]
      })
    ]);
    expect(parseEcccMarineAlerts(json, NOW_ISO)).toEqual([]);
  });

  it("uses nowIso as an onset fallback when lastUpdated is absent", function () {
    const feat = marineFeature({ events: [marineEvent("Gale warning", "IN EFFECT")] });
    delete feat.properties.lastUpdated;
    const alerts = parseEcccMarineAlerts(collection([feat]), NOW_ISO);
    expect(alerts.length).toBe(1);
    expect(alerts[0].onset).toBe(NOW_ISO);
  });

  it("returns [] for an all-clear collection (features with no active warnings)", function () {
    const json = collection([
      marineFeature({ value: "Lake Superior", events: [] })
    ]);
    expect(parseEcccMarineAlerts(json, NOW_ISO)).toEqual([]);
  });

  it("returns null for unusable top-level payloads (never throws)", function () {
    expect(parseEcccMarineAlerts(null, NOW_ISO)).toBe(null);
    expect(parseEcccMarineAlerts({}, NOW_ISO)).toBe(null);
    expect(parseEcccMarineAlerts({ features: "nope" }, NOW_ISO)).toBe(null);
    expect(parseEcccMarineAlerts("garbage", NOW_ISO)).toBe(null);
  });

  it("skips malformed features/events without throwing, keeping the good ones", function () {
    const good = marineFeature({ events: [marineEvent("Gale warning", "IN EFFECT")] });
    const json = collection([
      null,
      { type: "Feature" },
      { type: "Feature", properties: null },
      { type: "Feature", properties: { area: null } },
      { type: "Feature", properties: { area: { region: { en: "Great Lakes" } } } },
      good
    ]);
    const alerts = parseEcccMarineAlerts(json, NOW_ISO);
    expect(alerts.length).toBe(1);
    expect(alerts[0].event).toBe("gale warning");
  });
});

describe("ecccMarineAlertsForPoint", function () {
  function laker(events) {
    return parseEcccMarineAlerts(collection([
      marineFeature({ value: "Lake Erie", lat: 42.2, lon: -81.2, events: events })
    ]), NOW_ISO);
  }

  it("matches a point inside the zone polygon", function () {
    const alerts = laker([marineEvent("Gale warning", "IN EFFECT")]);
    const out = ecccMarineAlertsForPoint(alerts, 42.2, -81.2);
    expect(out.events).toEqual(["gale warning"]);
    expect(out.details.length).toBe(1);
    expect(out.details[0]).toEqual({ event: "gale warning", onset: "2026-07-22T10:00:00Z", ends: null });
  });

  it("matches a LAND point just outside the water zone via nearest-edge fallback", function () {
    const alerts = laker([marineEvent("Strong wind warning", "IN EFFECT")]);
    // zone spans lon [-81.4, -81.0]; a point ~8 km east of the edge (well within
    // the 15 km cap) still matches, mirroring a beach inland of its marine zone.
    const eastOfEdgeLon = -81.0 + 8 / (111.195 * Math.cos(42.2 * Math.PI / 180));
    expect(ECCC_MARINE_MAX_EDGE_KM).toBe(15);
    const out = ecccMarineAlertsForPoint(alerts, 42.2, eastOfEdgeLon);
    expect(out.events).toEqual(["strong wind warning"]);
  });

  it("does NOT match a point far beyond the edge cap", function () {
    const alerts = laker([marineEvent("Gale warning", "IN EFFECT")]);
    const out = ecccMarineAlertsForPoint(alerts, 42.2, -79.0);
    expect(out.events).toEqual([]);
    expect(out.details).toEqual([]);
  });

  it("dedupes repeated event names and returns empty on malformed/non-finite input", function () {
    const alerts = laker([
      marineEvent("Gale warning", "IN EFFECT"),
      marineEvent("Gale warning", "CONTINUED")
    ]);
    const out = ecccMarineAlertsForPoint(alerts, 42.2, -81.2);
    expect(out.events).toEqual(["gale warning"]);
    expect(ecccMarineAlertsForPoint(alerts, NaN, -81.2)).toEqual({ events: [], details: [] });
    expect(ecccMarineAlertsForPoint(null, 42.2, -81.2)).toEqual({ events: [], details: [] });
    expect(ecccMarineAlertsForPoint("nope", 42.2, -81.2)).toEqual({ events: [], details: [] });
  });
});

describe("fetchActiveEcccMarineAlerts", function () {
  afterEach(function () { vi.unstubAllGlobals(); });

  it("returns { alerts, sourceUrl } on a good response", async function () {
    vi.stubGlobal("fetch", function () {
      return okJson(collection([
        marineFeature({ value: "Lake Erie", events: [marineEvent("Gale warning", "IN EFFECT")] })
      ]));
    });
    const result = await fetchActiveEcccMarineAlerts(NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0].event).toBe("gale warning");
    expect(result.sourceUrl.indexOf("marineweather-realtime")).not.toBe(-1);
  });

  it("returns null on an HTTP failure", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.resolve({ ok: false, status: 503, json: function () { return Promise.resolve({}); } });
    });
    expect(await fetchActiveEcccMarineAlerts(NOW_ISO)).toBe(null);
  });

  it("returns null on a network throw (never propagates)", async function () {
    vi.stubGlobal("fetch", function () { return Promise.reject(new Error("boom")); });
    expect(await fetchActiveEcccMarineAlerts(NOW_ISO)).toBe(null);
  });

  it("returns null when the payload is unusable JSON", async function () {
    vi.stubGlobal("fetch", function () { return okJson({ nope: true }); });
    expect(await fetchActiveEcccMarineAlerts(NOW_ISO)).toBe(null);
  });
});
