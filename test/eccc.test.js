// ECCC (Environment and Climate Change Canada) client: the GeoMet
// weather-alerts fetch/filter pipeline, the pure point-in-polygon beach
// matching, and the per-point forecast-zone enrichment lookup. Fixture shapes
// mirror real api.weather.gc.ca responses (pygeoapi GeoJSON: alert_name_en
// lowercase, status_en issued/continued/ended, region Polygon geometry).
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  fetchActiveEcccAlerts,
  ecccAlertsForPoint,
  fetchEcccForecastZones,
  ecccZoneNameForPoint,
  fetchEcccJson,
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
    // MSC usage policy asks for a self-identifying User-Agent.
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
          alertFeature({ alert_name_en: "squall warning" }),
          alertFeature({ alert_name_en: "gale warning" }),
          alertFeature({ alert_name_en: "rainfall warning" }),
          alertFeature({ alert_name_en: "fog advisory" })
        ]
      });
    });
    const result = await fetchActiveEcccAlerts(NOW_ISO);
    expect(result.alerts.map(function (a) { return a.event; }))
      .toEqual(["squall warning", "gale warning", "rainfall warning", "fog advisory"]);
  });

  it("carries alert_text_en and feature_name_en as the alert's text and area", async function () {
    vi.stubGlobal("fetch", function () {
      return okJson({
        features: [alertFeature({
          alert_text_en: "Rain continues through parts of southern Ontario.",
          feature_name_en: "Windsor - Essex - Chatham-Kent"
        })]
      });
    });
    const alert = (await fetchActiveEcccAlerts(NOW_ISO)).alerts[0];
    expect(alert.description).toBe("Rain continues through parts of southern Ontario.");
    expect(alert.area).toBe("Windsor - Essex - Chatham-Kent");
    // ECCC folds the call to action into alert_text_en, so there is none to carry.
    expect(alert.instruction).toBeUndefined();
  });

  it("lowercases a proper-noun event name so the echo matches the rules.js lists", async function () {
    const feature = JSON.parse(readFileSync(
      new URL("./fixtures/eccc-les-suetes-wind-warning-2026-10-13.json", import.meta.url), "utf8"
    ));
    vi.stubGlobal("fetch", function () {
      return okJson({ features: [feature] });
    });
    const alert = (await fetchActiveEcccAlerts("2026-10-13T15:00:00Z")).alerts[0];
    expect(feature.properties.alert_name_en).toBe("Les Suêtes wind warning");
    expect(alert.event).toBe("les suêtes wind warning");
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

  it("recovers from a single HTTP 522 through the retry", async function () {
    let calls = 0;
    vi.stubGlobal("fetch", function () {
      calls++;
      if (calls === 1) {
        return Promise.resolve({ ok: false, status: 522 });
      }
      return okJson({ features: [alertFeature({})] });
    });
    const result = await fetchActiveEcccAlerts(NOW_ISO);
    expect(calls).toBe(2);
    expect(result.alerts.length).toBe(1);
  });
});

// The feed-integrity gate: a body the client cannot read as the national
// population resolves to null, exactly as a failed fetch does, so neither cron
// recomputes Canadian beaches against a schema drift read as an alert-free day.
describe("fetchActiveEcccAlerts with missing or malformed features", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("treats a body with no features key, or a non-array one, as no feed", async function () {
    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    vi.stubGlobal("fetch", function () {
      return okJson({});
    });
    expect(await fetchActiveEcccAlerts(NOW_ISO)).toBeNull();
    vi.stubGlobal("fetch", function () {
      return okJson({ features: "nope" });
    });
    expect(await fetchActiveEcccAlerts(NOW_ISO)).toBeNull();
    expect(logSpy.mock.calls.map(function (c) { return String(c[0]); }).join("\n"))
      .toContain("eccc: alerts feed unreadable: features=none");
  });

  it("a quiet day (features: []) is a success with no alerts", async function () {
    vi.stubGlobal("fetch", function () {
      return okJson({ features: [] });
    });
    const result = await fetchActiveEcccAlerts(NOW_ISO);
    expect(result.alerts).toEqual([]);
    expect(result.sourceUrl).toContain("collections/weather-alerts/items");
  });

  it("a majority of features without alert_name_en reads as no feed", async function () {
    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    vi.stubGlobal("fetch", function () {
      return okJson({
        features: [
          alertFeature({ alert_name_en: null }),
          alertFeature({ alert_name_en: "" }),
          { type: "Feature", properties: { alert_name: "wind warning" }, geometry: squareAround(42, -82.9) },
          alertFeature({ alert_name_en: "squall warning" }),
          alertFeature({ alert_name_en: "gale warning" })
        ]
      });
    });
    expect(await fetchActiveEcccAlerts(NOW_ISO)).toBeNull();
    expect(logSpy.mock.calls.map(function (c) { return String(c[0]); }).join("\n"))
      .toContain("eccc: alerts feed unreadable: features=5 dropped=3");
  });

  it("a page where most features are ended or expired still succeeds with those dropped", async function () {
    vi.stubGlobal("fetch", function () {
      return okJson({
        features: [
          alertFeature({ alert_name_en: "wind warning", status_en: "ended" }),
          alertFeature({ alert_name_en: "rainfall warning", status_en: "ended" }),
          alertFeature({ alert_name_en: "fog advisory", expiration_datetime: "2026-07-18T09:00:00.000Z" }),
          alertFeature({ alert_name_en: "frost advisory", expiration_datetime: "2026-07-18T08:00:00.000Z" }),
          alertFeature({ alert_name_en: "squall warning" })
        ]
      });
    });
    const result = await fetchActiveEcccAlerts(NOW_ISO);
    expect(result.alerts.map(function (a) { return a.event; })).toEqual(["squall warning"]);
  });

  it("a trimmed real weather-alerts capture parses every feature", async function () {
    const raw = readFileSync(new URL("./fixtures/eccc/weather-alerts-2026-10-13.json", import.meta.url), "utf8");
    const body = JSON.parse(raw);
    vi.stubGlobal("fetch", function () {
      return okJson(body);
    });
    const result = await fetchActiveEcccAlerts("2026-10-13T13:30:00Z");
    expect(result.alerts.length).toBe(body.features.length);
    expect(result.alerts[0].event).toBe("special weather statement");
    expect(result.alerts[0].geometry.type).toBe("Polygon");
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
    expect(matched.details).toMatchObject([
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

// A 522 is the one status the GeoMet fetches retry, because Cloudflare never
// reached the origin; every other failure is final on the first attempt.
describe("fetchEcccJson", function () {
  const URL = "https://api.weather.gc.ca/collections/weather-alerts/items?f=json";

  afterEach(function () {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Answers call n with statuses[n], repeating the last; a 200 carries body.
  function stubStatuses(statuses, body, seen) {
    vi.stubGlobal("fetch", function (url, init) {
      seen.push({ url: url, init: init });
      const status = statuses[Math.min(seen.length, statuses.length) - 1];
      if (status === 200) {
        return okJson(body);
      }
      return Promise.resolve({ ok: false, status: status });
    });
  }

  it("retries a 522 once with the same URL and UA and returns the retried body", async function () {
    const seen = [];
    stubStatuses([522, 200], { features: [] }, seen);
    expect(await fetchEcccJson(URL, "eccc: test")).toEqual({ features: [] });
    expect(seen.length).toBe(2);
    expect(seen[1].url).toBe(URL);
    expect(seen[1].init.headers["User-Agent"]).toBe(ECCC_USER_AGENT);
  });

  it("gives up after one retry and logs the retry under its own label", async function () {
    const log = vi.spyOn(console, "log").mockImplementation(function () {});
    const seen = [];
    stubStatuses([522, 522, 200], { features: [] }, seen);
    expect(await fetchEcccJson(URL, "eccc: test")).toBeNull();
    expect(seen.length).toBe(2);
    const lines = log.mock.calls.map(function (c) { return c[0]; });
    expect(lines).toEqual([
      "eccc: test fetch failed: HTTP 522",
      "eccc: test retry fetch failed: HTTP 522"
    ]);
  });

  it("does not retry another HTTP failure or a thrown fetch", async function () {
    for (const status of [500, 503, 524]) {
      const seen = [];
      stubStatuses([status, 200], { features: [] }, seen);
      expect(await fetchEcccJson(URL, "eccc: test")).toBeNull();
      expect(seen.length).toBe(1);
    }
    let calls = 0;
    vi.stubGlobal("fetch", function () {
      calls++;
      return Promise.reject(new Error("network down"));
    });
    expect(await fetchEcccJson(URL, "eccc: test")).toBeNull();
    expect(calls).toBe(1);
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

// Both GeoMet calls are bulk national collections fetched once per run, each
// bounded by ECCC_TIMEOUT_MS so one hung socket cannot run the hourly (alerts)
// or enrichment (zones) cron to the 900 s scheduled ceiling.
describe("ECCC transport timeout", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("arms an abort signal on the national alerts fetch", async function () {
    let seenInit = null;
    vi.stubGlobal("fetch", function (url, init) {
      seenInit = init;
      return Promise.resolve(new Response(JSON.stringify({ features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    });
    await fetchActiveEcccAlerts("2026-07-15T16:00:00.000Z");
    expect(seenInit.signal).toBeDefined();
    expect(seenInit.signal.aborted).toBe(false);
  });

  it("arms an abort signal on the forecast-zones fetch", async function () {
    let seenInit = null;
    vi.stubGlobal("fetch", function (url, init) {
      seenInit = init;
      return Promise.resolve(new Response(JSON.stringify({ features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    });
    await fetchEcccForecastZones();
    expect(seenInit.signal).toBeDefined();
    expect(seenInit.signal.aborted).toBe(false);
  });
});
