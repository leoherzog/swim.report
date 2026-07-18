// ECCC (Environment and Climate Change Canada) client: the GeoMet
// weather-alerts fetch/filter pipeline, the pure point-in-polygon beach
// matching, and the per-point forecast-zone enrichment lookup. Fixture shapes
// mirror real api.weather.gc.ca responses (pygeoapi GeoJSON: alert_name_en
// lowercase, status_en issued/continued/ended, region Polygon geometry).
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchActiveEcccAlerts,
  ecccAlertsForPoint,
  fetchEcccZoneName
} from "../src/clients/eccc.js";
import { pointInGeometry } from "../src/geo.js";

const NOW_ISO = "2026-07-18T12:00:00.000Z";

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

function alertFeature(overrides) {
  const props = {
    alert_name_en: "severe thunderstorm warning",
    alert_type: "warning",
    status_en: "issued",
    validity_datetime: "2026-07-18T11:00:00.000Z",
    publication_datetime: "2026-07-18T10:55:00.000Z",
    expiration_datetime: "2026-07-18T20:00:00.000Z",
    event_end_datetime: "2026-07-18T21:00:00.000Z"
  };
  const extra = overrides || {};
  for (const key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) {
      props[key] = extra[key];
    }
  }
  return { type: "Feature", properties: props, geometry: squareAround(42.0, -82.9) };
}

function okJson(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve(body); }
  });
}

describe("pointInGeometry", function () {
  const square = squareAround(42.0, -82.9);

  it("contains an interior point, excludes an exterior one", function () {
    expect(pointInGeometry(square, 42.0, -82.9)).toBe(true);
    expect(pointInGeometry(square, 42.0, -86.0)).toBe(false);
  });

  it("excludes a point inside a hole", function () {
    const withHole = {
      type: "Polygon",
      coordinates: [
        square.coordinates[0],
        [
          [-82.95, 41.95],
          [-82.85, 41.95],
          [-82.85, 42.05],
          [-82.95, 42.05],
          [-82.95, 41.95]
        ]
      ]
    };
    expect(pointInGeometry(withHole, 42.0, -82.9)).toBe(false);
    expect(pointInGeometry(withHole, 42.15, -82.9)).toBe(true);
  });

  it("handles MultiPolygon: contained by the second polygon", function () {
    const multi = {
      type: "MultiPolygon",
      coordinates: [
        squareAround(46.3, -84.0).coordinates,
        square.coordinates
      ]
    };
    expect(pointInGeometry(multi, 42.0, -82.9)).toBe(true);
    expect(pointInGeometry(multi, 46.3, -84.0)).toBe(true);
    expect(pointInGeometry(multi, 44.0, -83.5)).toBe(false);
  });

  it("malformed / non-areal geometry is never contained", function () {
    expect(pointInGeometry(null, 42.0, -82.9)).toBe(false);
    expect(pointInGeometry({ type: "Point", coordinates: [-82.9, 42.0] }, 42.0, -82.9)).toBe(false);
    expect(pointInGeometry({ type: "Polygon" }, 42.0, -82.9)).toBe(false);
    expect(pointInGeometry({ type: "Polygon", coordinates: [] }, 42.0, -82.9)).toBe(false);
  });
});

describe("fetchActiveEcccAlerts", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("keeps live alerts, drops ended and expired ones, and maps the fields", async function () {
    let requestedUrl = null;
    vi.stubGlobal("fetch", function (url) {
      requestedUrl = url;
      return okJson({
        features: [
          alertFeature({}),
          alertFeature({ alert_name_en: "wind warning", status_en: "ended" }),
          alertFeature({
            alert_name_en: "rainfall warning",
            expiration_datetime: "2026-07-18T09:00:00.000Z" // before NOW_ISO
          })
        ]
      });
    });

    const result = await fetchActiveEcccAlerts(
      { minLon: -87.6, minLat: 41.6, maxLon: -82.3, maxLat: 46.6 }, NOW_ISO
    );
    expect(result).not.toBeNull();
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0].event).toBe("severe thunderstorm warning");
    // onset = validity_datetime, ends = event_end_datetime (preferred over
    // expiration_datetime).
    expect(result.alerts[0].onset).toBe("2026-07-18T11:00:00.000Z");
    expect(result.alerts[0].ends).toBe("2026-07-18T21:00:00.000Z");
    expect(result.alerts[0].geometry.type).toBe("Polygon");
    expect(result.sourceUrl).toBe(requestedUrl);
    expect(requestedUrl).toContain("collections/weather-alerts/items");
    expect(requestedUrl).toContain("bbox=-87.6,41.6,-82.3,46.6");
  });

  it("falls back to publication/expiration when validity/event-end are absent", async function () {
    vi.stubGlobal("fetch", function () {
      return okJson({
        features: [alertFeature({ validity_datetime: null, event_end_datetime: null })]
      });
    });
    const result = await fetchActiveEcccAlerts(
      { minLon: -87.6, minLat: 41.6, maxLon: -82.3, maxLat: 46.6 }, NOW_ISO
    );
    expect(result.alerts[0].onset).toBe("2026-07-18T10:55:00.000Z");
    expect(result.alerts[0].ends).toBe("2026-07-18T20:00:00.000Z");
  });

  it("skips features without a usable event name or geometry", async function () {
    vi.stubGlobal("fetch", function () {
      const noGeometry = alertFeature({ alert_name_en: "wind warning" });
      noGeometry.geometry = null;
      return okJson({
        features: [
          { type: "Feature", properties: null, geometry: squareAround(42, -82.9) },
          alertFeature({ alert_name_en: "" }),
          noGeometry,
          alertFeature({ alert_name_en: "squall warning" })
        ]
      });
    });
    const result = await fetchActiveEcccAlerts(
      { minLon: -87.6, minLat: 41.6, maxLon: -82.3, maxLat: 46.6 }, NOW_ISO
    );
    expect(result.alerts.map(function (a) { return a.event; })).toEqual(["squall warning"]);
  });

  it("returns null on HTTP failure and on a thrown fetch, never throws", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.resolve({ ok: false, status: 500 });
    });
    expect(await fetchActiveEcccAlerts(
      { minLon: -87.6, minLat: 41.6, maxLon: -82.3, maxLat: 46.6 }, NOW_ISO
    )).toBeNull();

    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network down"));
    });
    expect(await fetchActiveEcccAlerts(
      { minLon: -87.6, minLat: 41.6, maxLon: -82.3, maxLat: 46.6 }, NOW_ISO
    )).toBeNull();
  });
});

describe("ecccAlertsForPoint", function () {
  it("returns only alerts whose polygon contains the point, deduped", function () {
    const alerts = [
      { event: "severe thunderstorm warning", onset: "a", ends: "b", geometry: squareAround(42.0, -82.9) },
      { event: "severe thunderstorm warning", onset: "a", ends: "b", geometry: squareAround(42.0, -82.9) },
      { event: "wind warning", onset: null, ends: null, geometry: squareAround(46.3, -84.0) }
    ];
    const matched = ecccAlertsForPoint(alerts, 42.0, -82.9);
    expect(matched.events).toEqual(["severe thunderstorm warning"]);
    expect(matched.details).toEqual([
      { event: "severe thunderstorm warning", onset: "a", ends: "b" }
    ]);
  });

  it("no containing polygon -> empty result (a real 'no active alerts')", function () {
    const alerts = [
      { event: "wind warning", onset: null, ends: null, geometry: squareAround(46.3, -84.0) }
    ];
    const matched = ecccAlertsForPoint(alerts, 42.0, -82.9);
    expect(matched.events).toEqual([]);
    expect(matched.details).toEqual([]);
  });

  it("malformed input degrades to empty, never throws", function () {
    expect(ecccAlertsForPoint(null, 42, -82.9)).toEqual({ events: [], details: [] });
    expect(ecccAlertsForPoint([null, {}, { event: 5 }], 42, -82.9))
      .toEqual({ events: [], details: [] });
  });
});

describe("fetchEcccZoneName", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("returns the first region NAME for a Canadian point", async function () {
    let requestedUrl = null;
    vi.stubGlobal("fetch", function (url) {
      requestedUrl = url;
      return okJson({
        features: [{
          type: "Feature",
          properties: { NAME: "Windsor - Essex - Chatham-Kent", PROVINCE_C: "ON" }
        }]
      });
    });
    const result = await fetchEcccZoneName(41.9836774, -82.9343626);
    expect(result).toEqual({ zoneName: "Windsor - Essex - Chatham-Kent" });
    expect(requestedUrl).toContain("collections/public-standard-forecast-zones/items");
    expect(requestedUrl).toContain("skipGeometry=true");
  });

  it("returns null for a US point (zero regions) and on failure", async function () {
    vi.stubGlobal("fetch", function () {
      return okJson({ features: [] });
    });
    expect(await fetchEcccZoneName(42.401, -86.288)).toBeNull();

    vi.stubGlobal("fetch", function () {
      return Promise.resolve({ ok: false, status: 503 });
    });
    expect(await fetchEcccZoneName(41.98, -82.93)).toBeNull();
  });
});
