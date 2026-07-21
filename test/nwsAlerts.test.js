// NWS active-alerts client: the national one-fetch pipeline
// (fetchAllActiveAlerts), the pure per-zone filter (nwsAlertsForZone), and the
// zone-scoped provenance URL helper (alertsUrlForZone). Fixture shapes mirror
// real api.weather.gov/alerts/active GeoJSON features (properties.event,
// onset/effective, ends/expires, geocode.UGC codes, affectedZones URLs).
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  NWS_ACTIVE_ALERTS_URL,
  NWS_USER_AGENT,
  alertsUrlForZone,
  fetchAllActiveAlerts,
  fetchLatestSrfText,
  fetchPointMetadata,
  nwsAlertsForZone
} from "../src/clients/nws.js";

// A single alert feature. overrides.props merge into properties (so an
// override of null blanks a field); overrides may drop properties entirely.
function alertFeature(overrides) {
  const props = {
    event: "Beach Hazards Statement",
    onset: "2026-07-18T14:00:00.000Z",
    effective: "2026-07-18T13:55:00.000Z",
    ends: "2026-07-19T06:00:00.000Z",
    expires: "2026-07-19T05:00:00.000Z",
    geocode: { UGC: ["MIZ071"] },
    affectedZones: ["https://api.weather.gov/zones/forecast/MIZ071"]
  };
  const extra = (overrides && overrides.props) || {};
  for (const key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) {
      props[key] = extra[key];
    }
  }
  return { type: "Feature", properties: props };
}

function okJson(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve(body); }
  });
}

describe("fetchAllActiveAlerts", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("parses a multi-feature payload with onset/ends fallbacks and dedupes zones", async function () {
    let requestedUrl = null;
    let requestedInit = null;
    vi.stubGlobal("fetch", function (url, init) {
      requestedUrl = url;
      requestedInit = init;
      return okJson({
        features: [
          // onset/ends present; a zone appears in BOTH geocode.UGC and
          // affectedZones and must be deduped to a single entry.
          alertFeature({
            props: {
              event: "High Surf Warning",
              geocode: { UGC: ["MIZ071"] },
              affectedZones: ["https://api.weather.gov/zones/forecast/MIZ071"]
            }
          }),
          // onset absent -> effective fallback; ends absent -> expires
          // fallback; zones only from geocode.UGC.
          alertFeature({
            props: {
              event: "Rip Current Statement",
              onset: null,
              ends: null,
              affectedZones: []
            }
          }),
          // No geocode -> zones resolved from affectedZones last path segment.
          alertFeature({
            props: {
              event: "High Surf Advisory",
              geocode: null,
              affectedZones: ["https://api.weather.gov/zones/forecast/MIZ049"]
            }
          })
        ]
      });
    });

    const result = await fetchAllActiveAlerts();
    expect(result).not.toBeNull();
    expect(result.sourceUrl).toBe(NWS_ACTIVE_ALERTS_URL);
    expect(requestedUrl).toBe(NWS_ACTIVE_ALERTS_URL);
    // The User-Agent header rides on the second fetch arg.
    expect(requestedInit.headers["User-Agent"]).toBe(NWS_USER_AGENT);
    expect(NWS_USER_AGENT).toBe("swim.report (hello@swim.report)");

    expect(result.alerts.length).toBe(3);

    const first = result.alerts[0];
    expect(first.event).toBe("High Surf Warning");
    expect(first.onset).toBe("2026-07-18T14:00:00.000Z");
    expect(first.ends).toBe("2026-07-19T06:00:00.000Z");
    expect(first.zones).toEqual(["MIZ071"]); // deduped across both sources

    const second = result.alerts[1];
    expect(second.event).toBe("Rip Current Statement");
    expect(second.onset).toBe("2026-07-18T13:55:00.000Z"); // effective fallback
    expect(second.ends).toBe("2026-07-19T05:00:00.000Z");   // expires fallback
    expect(second.zones).toEqual(["MIZ071"]);

    const third = result.alerts[2];
    expect(third.event).toBe("High Surf Advisory");
    expect(third.zones).toEqual(["MIZ049"]); // affectedZones last-segment
  });

  it("skips a feature with no event and one with no resolvable zones", async function () {
    vi.stubGlobal("fetch", function () {
      return okJson({
        features: [
          alertFeature({ props: { event: null } }),
          alertFeature({
            props: {
              event: "Gale Warning",
              geocode: null,
              affectedZones: []
            }
          }),
          alertFeature({ props: { event: "Small Craft Advisory" } })
        ]
      });
    });

    const result = await fetchAllActiveAlerts();
    expect(result.alerts.map(function (a) { return a.event; }))
      .toEqual(["Small Craft Advisory"]);
  });

  it("returns null on HTTP failure and on a rejected fetch, never throws", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.resolve({ ok: false, status: 500 });
    });
    expect(await fetchAllActiveAlerts()).toBeNull();

    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network down"));
    });
    expect(await fetchAllActiveAlerts()).toBeNull();
  });
});

describe("fetchLatestSrfText", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("reads productText from the single /latest call and reports the /latest URL", async function () {
    const latestUrl = "https://api.weather.gov/products/types/SRF/locations/MFL/latest";
    let requestedUrl = null;
    let requestedInit = null;
    let callCount = 0;
    vi.stubGlobal("fetch", function (url, init) {
      callCount++;
      requestedUrl = url;
      requestedInit = init;
      return okJson({
        id: "abc-123",
        issuanceTime: "2026-07-20T12:00:00.000Z",
        productText: "SURF ZONE FORECAST\nRIP CURRENT RISK...HIGH"
      });
    });

    const result = await fetchLatestSrfText("MFL");
    // A single request, to the /latest endpoint, with the NWS User-Agent.
    expect(callCount).toBe(1);
    expect(requestedUrl).toBe(latestUrl);
    expect(requestedInit.headers["User-Agent"]).toBe(NWS_USER_AGENT);
    // Shape consumed by parseRipCurrentRisk and the hourly cron is preserved,
    // with sourceUrl now pointing at the /latest URL.
    expect(result).toEqual({
      text: "SURF ZONE FORECAST\nRIP CURRENT RISK...HIGH",
      productId: "SRF MFL",
      sourceUrl: latestUrl
    });
  });

  it("returns null when productText is missing or malformed", async function () {
    vi.stubGlobal("fetch", function () {
      return okJson({ id: "abc-123", issuanceTime: "2026-07-20T12:00:00.000Z" });
    });
    expect(await fetchLatestSrfText("MFL")).toBeNull();
  });

  it("returns null on HTTP failure and on a rejected fetch, never throws", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.resolve({ ok: false, status: 500 });
    });
    expect(await fetchLatestSrfText("MFL")).toBeNull();

    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network down"));
    });
    expect(await fetchLatestSrfText("MFL")).toBeNull();
  });
});

describe("nwsAlertsForZone", function () {
  it("filters by zone membership", function () {
    const alerts = [
      { event: "High Surf Warning", onset: "a", ends: "b", zones: ["MIZ071"] },
      { event: "Rip Current Statement", onset: "c", ends: "d", zones: ["MIZ049"] }
    ];
    const matched = nwsAlertsForZone(alerts, "MIZ071");
    expect(matched.events).toEqual(["High Surf Warning"]);
    expect(matched.details).toEqual([
      { event: "High Surf Warning", onset: "a", ends: "b" }
    ]);
  });

  it("dedupes repeated event names but keeps distinct (event, onset, ends) details", function () {
    const alerts = [
      { event: "High Surf Advisory", onset: "a", ends: "b", zones: ["MIZ071"] },
      // Same event, different window -> one event name, two detail entries.
      { event: "High Surf Advisory", onset: "c", ends: "d", zones: ["MIZ071"] },
      // Exact duplicate of the first -> collapsed away entirely.
      { event: "High Surf Advisory", onset: "a", ends: "b", zones: ["MIZ071"] }
    ];
    const matched = nwsAlertsForZone(alerts, "MIZ071");
    expect(matched.events).toEqual(["High Surf Advisory"]);
    expect(matched.details).toEqual([
      { event: "High Surf Advisory", onset: "a", ends: "b" },
      { event: "High Surf Advisory", onset: "c", ends: "d" }
    ]);
  });

  it("normalizes non-string onset/ends to null", function () {
    const alerts = [
      { event: "Beach Hazards Statement", onset: 5, ends: undefined, zones: ["MIZ071"] }
    ];
    const matched = nwsAlertsForZone(alerts, "MIZ071");
    expect(matched.details).toEqual([
      { event: "Beach Hazards Statement", onset: null, ends: null }
    ]);
  });

  it("malformed input degrades to empty, never throws", function () {
    expect(nwsAlertsForZone(null, "MIZ071")).toEqual({ events: [], details: [] });
    expect(nwsAlertsForZone({}, "MIZ071")).toEqual({ events: [], details: [] });
    expect(nwsAlertsForZone([null, {}, { event: 5, zones: ["MIZ071"] }], "MIZ071"))
      .toEqual({ events: [], details: [] });
  });
});

describe("alertsUrlForZone", function () {
  it("returns the zone-scoped active-alerts URL", function () {
    expect(alertsUrlForZone("MIZ071"))
      .toBe("https://api.weather.gov/alerts/active?zone=MIZ071");
  });
});

describe("fetchAllActiveAlerts with missing or malformed features", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("treats a 200 body with no features key as an empty success, not a failure", async function () {
    vi.stubGlobal("fetch", function () {
      return okJson({});
    });
    // The hourly cron treats null as a fetch failure; an alert-free body must
    // instead resolve to an empty alerts list with the source URL intact.
    const result = await fetchAllActiveAlerts();
    expect(result).toEqual({ alerts: [], sourceUrl: NWS_ACTIVE_ALERTS_URL });
  });

  it("treats a non-array features value as an empty success, never throws", async function () {
    vi.stubGlobal("fetch", function () {
      return okJson({ features: "nope" });
    });
    const result = await fetchAllActiveAlerts();
    expect(result).toEqual({ alerts: [], sourceUrl: NWS_ACTIVE_ALERTS_URL });
  });
});

describe("fetchPointMetadata", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("resolves zone id and grid URL from /points, with 4-decimal coords and the NWS User-Agent", async function () {
    let requestedUrl = null;
    let requestedInit = null;
    vi.stubGlobal("fetch", function (url, init) {
      requestedUrl = url;
      requestedInit = init;
      return okJson({
        properties: {
          forecastZone: "https://api.weather.gov/zones/forecast/MIZ071",
          forecastGridData: "https://api.weather.gov/gridpoints/GRR/33,33"
        }
      });
    });

    const result = await fetchPointMetadata(42.4001, -86.2758);
    expect(requestedUrl).toBe("https://api.weather.gov/points/42.4001,-86.2758");
    expect(requestedInit.headers["User-Agent"]).toBe(NWS_USER_AGENT);
    // nwsZone is the last path segment of the forecastZone URL; nwsGridUrl is
    // the forecastGridData URL verbatim (the enrichment cron stamps both).
    expect(result).toEqual({
      nwsZone: "MIZ071",
      nwsGridUrl: "https://api.weather.gov/gridpoints/GRR/33,33"
    });
  });

  it("pads short coordinates to exactly four decimal places", async function () {
    let requestedUrl = null;
    vi.stubGlobal("fetch", function (url) {
      requestedUrl = url;
      return okJson({
        properties: {
          forecastZone: "https://api.weather.gov/zones/forecast/MIZ049",
          forecastGridData: "https://api.weather.gov/gridpoints/GRR/40,40"
        }
      });
    });

    await fetchPointMetadata(42.4, -86.25);
    expect(requestedUrl).toBe("https://api.weather.gov/points/42.4000,-86.2500");
  });

  it("returns null when forecastZone or forecastGridData is missing (the parked-row path)", async function () {
    // A beach whose /points response lacks either field must park as null —
    // this is how Canadian rows that NWS will never cover stay un-enriched.
    vi.stubGlobal("fetch", function () {
      return okJson({
        properties: {
          forecastGridData: "https://api.weather.gov/gridpoints/GRR/33,33"
        }
      });
    });
    expect(await fetchPointMetadata(45.0, -82.0)).toBeNull();

    vi.stubGlobal("fetch", function () {
      return okJson({
        properties: {
          forecastZone: "https://api.weather.gov/zones/forecast/MIZ071"
        }
      });
    });
    expect(await fetchPointMetadata(45.0, -82.0)).toBeNull();
  });

  it("returns null when properties is absent entirely", async function () {
    vi.stubGlobal("fetch", function () {
      return okJson({ title: "Not the shape you wanted" });
    });
    expect(await fetchPointMetadata(45.0, -82.0)).toBeNull();
  });

  it("returns null on HTTP failure and on a rejected fetch, never throws", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.resolve({ ok: false, status: 404 });
    });
    expect(await fetchPointMetadata(45.0, -82.0)).toBeNull();

    vi.stubGlobal("fetch", function () {
      return Promise.reject(new Error("network down"));
    });
    expect(await fetchPointMetadata(45.0, -82.0)).toBeNull();
  });
});
