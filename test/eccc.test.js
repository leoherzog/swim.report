// ECCC (Environment and Climate Change Canada) client: the GeoMet
// weather-alerts fetch/filter pipeline, the pure point-in-polygon beach
// matching, and the per-point forecast-zone enrichment lookup. Fixture shapes
// mirror real api.weather.gc.ca responses (pygeoapi GeoJSON: alert_name_en
// lowercase, status_en issued/continued/ended, region Polygon geometry).
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchActiveEcccAlerts,
  ecccAlertsForPoint,
  fetchEcccForecastZones,
  ecccZoneNameForPoint,
  ECCC_USER_AGENT
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
    let requestedInit = null;
    vi.stubGlobal("fetch", function (url, init) {
      requestedUrl = url;
      requestedInit = init;
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

    const result = await fetchActiveEcccAlerts(NOW_ISO);
    expect(result).not.toBeNull();
    // MSC usage policy asks for a self-identifying User-Agent (F11).
    expect(requestedInit.headers["User-Agent"]).toBe(ECCC_USER_AGENT);
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0].event).toBe("severe thunderstorm warning");
    // onset = validity_datetime, ends = event_end_datetime (preferred over
    // expiration_datetime).
    expect(result.alerts[0].onset).toBe("2026-07-18T11:00:00.000Z");
    expect(result.alerts[0].ends).toBe("2026-07-18T21:00:00.000Z");
    expect(result.alerts[0].geometry.type).toBe("Polygon");
    expect(result.sourceUrl).toBe(requestedUrl);
    expect(requestedUrl).toContain("collections/weather-alerts/items");
    expect(requestedUrl).toContain("limit=2000");
    expect(requestedUrl.indexOf("bbox=")).toBe(-1);
  });

  it("falls back to publication/expiration when validity/event-end are absent", async function () {
    vi.stubGlobal("fetch", function () {
      return okJson({
        features: [alertFeature({ validity_datetime: null, event_end_datetime: null })]
      });
    });
    const result = await fetchActiveEcccAlerts(NOW_ISO);
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
    const result = await fetchActiveEcccAlerts(NOW_ISO);
    expect(result.alerts.map(function (a) { return a.event; })).toEqual(["squall warning"]);
  });

  it("returns null on HTTP failure and on a thrown fetch, never throws", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.resolve({ ok: false, status: 500 });
    });
    expect(await fetchActiveEcccAlerts(NOW_ISO)).toBeNull();

    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network down"));
    });
    expect(await fetchActiveEcccAlerts(NOW_ISO)).toBeNull();
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

describe("fetchEcccForecastZones", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  function zoneFeature(name, lat, lon) {
    return {
      type: "Feature",
      properties: { NAME: name, PROVINCE_C: "ON" },
      geometry: squareAround(lat, lon)
    };
  }

  it("fetches the whole set once WITH geometry and a self-identifying UA", async function () {
    let requestedUrl = null;
    let requestedInit = null;
    vi.stubGlobal("fetch", function (url, init) {
      requestedUrl = url;
      requestedInit = init;
      return okJson({
        features: [
          zoneFeature("Windsor - Essex - Chatham-Kent", 42.0, -82.9),
          zoneFeature("Blind River - Thessalon", 46.26, -83.28)
        ]
      });
    });
    const zones = await fetchEcccForecastZones();
    expect(zones.length).toBe(2);
    expect(zones[0]).toEqual({
      name: "Windsor - Essex - Chatham-Kent",
      geometry: squareAround(42.0, -82.9)
    });
    expect(requestedUrl).toContain("collections/public-standard-forecast-zones/items");
    expect(requestedUrl.indexOf("skipGeometry")).toBe(-1);
    expect(requestedUrl).toContain("limit=2000");
    expect(requestedInit.headers["User-Agent"]).toBe(ECCC_USER_AGENT);
  });

  it("skips features missing a NAME or an areal geometry", async function () {
    vi.stubGlobal("fetch", function () {
      const noGeom = zoneFeature("No geometry", 45.0, -80.0);
      noGeom.geometry = null;
      return okJson({
        features: [
          { type: "Feature", properties: null, geometry: squareAround(42, -82.9) },
          { type: "Feature", properties: { NAME: "" }, geometry: squareAround(42, -82.9) },
          noGeom,
          zoneFeature("Keeper", 42.0, -82.9)
        ]
      });
    });
    const zones = await fetchEcccForecastZones();
    expect(zones.map(function (z) { return z.name; })).toEqual(["Keeper"]);
  });

  it("returns null on HTTP failure and on a thrown fetch, never throws", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.resolve({ ok: false, status: 503 });
    });
    expect(await fetchEcccForecastZones()).toBeNull();

    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network down"));
    });
    expect(await fetchEcccForecastZones()).toBeNull();
  });
});

describe("ecccZoneNameForPoint", function () {
  const zones = [
    { name: "Windsor - Essex - Chatham-Kent", geometry: squareAround(42.0, -82.9) },
    { name: "Blind River - Thessalon", geometry: squareAround(46.26, -83.28) }
  ];

  it("returns the NAME of the containing region", function () {
    expect(ecccZoneNameForPoint(zones, 42.0, -82.9)).toBe("Windsor - Essex - Chatham-Kent");
    expect(ecccZoneNameForPoint(zones, 46.26, -83.28)).toBe("Blind River - Thessalon");
  });

  it("returns null for a point no region contains (a US point far from every zone)", function () {
    expect(ecccZoneNameForPoint(zones, 42.401, -86.288)).toBeNull();
  });

  it("nearest-edge fallback: a shoreline centroid just OUTSIDE the polygon (within 2 km) still resolves", function () {
    // Zone edge at lat 42.2 (squareAround top edge = 42.0 + 0.2); a centroid
    // nudged ~1.1 km north of it (0.01 deg) is outside the polygon but well
    // inside ECCC_ZONE_MAX_EDGE_KM.
    expect(pointInGeometry(zones[0].geometry, 42.21, -82.9)).toBe(false);
    expect(ecccZoneNameForPoint(zones, 42.21, -82.9)).toBe("Windsor - Essex - Chatham-Kent");
  });

  it("nearest-edge fallback picks the CLOSEST zone, not the first listed", function () {
    // Just north of the Blind River square's top edge (46.26 + 0.2 = 46.46).
    expect(ecccZoneNameForPoint(zones, 46.47, -83.28)).toBe("Blind River - Thessalon");
  });

  it("a point beyond the 2 km cap from every edge resolves to null", function () {
    // ~3.3 km north of the top edge (0.03 deg of latitude).
    expect(ecccZoneNameForPoint(zones, 42.23, -82.9)).toBeNull();
  });

  it("malformed input degrades to null, never throws", function () {
    expect(ecccZoneNameForPoint(null, 42, -82.9)).toBeNull();
    expect(ecccZoneNameForPoint([null, {}, { name: 5 }], 42, -82.9)).toBeNull();
    expect(ecccZoneNameForPoint(zones, NaN, -82.9)).toBeNull();
    expect(ecccZoneNameForPoint([{ name: "Bad", geometry: { type: "Polygon", coordinates: [[["x", 1]]] } }], 42, -82.9)).toBeNull();
  });
});

describe("truncation warning at the 2000-feature fetch limit", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function logCallsContaining(spy, needle) {
    return spy.mock.calls.filter(function (args) {
      return args.some(function (arg) {
        return typeof arg === "string" && arg.indexOf(needle) !== -1;
      });
    });
  }

  it("fetchActiveEcccAlerts logs the truncation warning at exactly 2000 features but still returns them all", async function () {
    const features = [];
    for (let i = 0; i < 2000; i = i + 1) {
      features.push(alertFeature({ alert_name_en: "wind warning " + String(i) }));
    }
    vi.stubGlobal("fetch", function () {
      return okJson({ features: features });
    });
    const logSpy = vi.spyOn(console, "log");

    const result = await fetchActiveEcccAlerts(NOW_ISO);
    expect(result).not.toBeNull();
    // The full page is still parsed and returned — truncation is warned
    // about, never treated as a failure.
    expect(result.alerts.length).toBe(2000);
    const warnings = logCallsContaining(logSpy, "at the 2000 limit");
    expect(warnings.length).toBe(1);
    expect(warnings[0][0]).toContain("eccc: alerts fetch returned 2000 features");
  });

  it("fetchActiveEcccAlerts does NOT warn below the limit", async function () {
    vi.stubGlobal("fetch", function () {
      return okJson({ features: [alertFeature({})] });
    });
    const logSpy = vi.spyOn(console, "log");
    const result = await fetchActiveEcccAlerts(NOW_ISO);
    expect(result.alerts.length).toBe(1);
    expect(logCallsContaining(logSpy, "at the 2000 limit").length).toBe(0);
  });

  it("fetchEcccForecastZones logs the truncation warning at exactly 2000 features but still returns them all", async function () {
    const features = [];
    for (let i = 0; i < 2000; i = i + 1) {
      features.push({
        type: "Feature",
        properties: { NAME: "Zone " + String(i), PROVINCE_C: "ON" },
        geometry: squareAround(42.0, -82.9)
      });
    }
    vi.stubGlobal("fetch", function () {
      return okJson({ features: features });
    });
    const logSpy = vi.spyOn(console, "log");

    const zones = await fetchEcccForecastZones();
    expect(zones).not.toBeNull();
    expect(zones.length).toBe(2000);
    expect(zones[1999].name).toBe("Zone 1999");
    const warnings = logCallsContaining(logSpy, "at the 2000 limit");
    expect(warnings.length).toBe(1);
    expect(warnings[0][0]).toContain("eccc: forecast-zones fetch returned 2000 features");
  });

  it("fetchEcccForecastZones does NOT warn below the limit", async function () {
    vi.stubGlobal("fetch", function () {
      return okJson({
        features: [{
          type: "Feature",
          properties: { NAME: "Windsor - Essex - Chatham-Kent" },
          geometry: squareAround(42.0, -82.9)
        }]
      });
    });
    const logSpy = vi.spyOn(console, "log");
    const zones = await fetchEcccForecastZones();
    expect(zones.length).toBe(1);
    expect(logCallsContaining(logSpy, "at the 2000 limit").length).toBe(0);
  });
});
