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
  nwsAlertsForZone,
  resolveMarineZone
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

describe("resolveMarineZone", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  // Build a marine /zones FeatureCollection with the given zone ids.
  function marineZones(ids) {
    return okJson({
      features: ids.map(function (id) {
        return { properties: { id: id, name: id + " name" } };
      })
    });
  }

  // Stub fetch so only points matching one of matchPrefixes (a substring of the
  // "point=lat,lon" query) return a zone; everything else returns empty. Also
  // records every requested point= value for probe-count assertions.
  function stubMarine(matchSubstr, zoneId, requested) {
    vi.stubGlobal("fetch", function (url) {
      if (requested) {
        requested.push(url);
      }
      if (matchSubstr !== null && url.indexOf(matchSubstr) !== -1) {
        return marineZones([zoneId]);
      }
      return marineZones([]);
    });
  }

  it("returns the zone at the exact point without probing when present", async function () {
    const requested = [];
    // The un-nudged point is lat.toFixed(4),lon.toFixed(4) = 42.7750,-86.2110.
    stubMarine("point=42.7750,-86.2110", "LMZ844", requested);
    const result = await resolveMarineZone(42.775, -86.211);
    expect(result).toEqual({ marineZone: "LMZ844" });
    expect(requested.length).toBe(1); // no offshore probe needed
  });

  it("finds the zone via an offshore probe when the shore point is empty", async function () {
    const requested = [];
    // Only the first ring, west direction (lon - 0.10 -> -86.3110) has a zone.
    stubMarine("point=42.7750,-86.3110", "LMZ874", requested);
    const result = await resolveMarineZone(42.775, -86.211);
    expect(result).toEqual({ marineZone: "LMZ874" });
    expect(requested.length).toBeGreaterThan(1); // probed offshore
  });

  it("returns { marineZone: null } when no probe finds a marine zone", async function () {
    stubMarine(null, null, null); // every point returns empty
    const result = await resolveMarineZone(45.0, -84.0);
    expect(result).toEqual({ marineZone: null });
  });

  it("returns null when the first lookup fails to fetch (transient)", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({}); } });
    });
    const result = await resolveMarineZone(42.775, -86.211);
    expect(result).toBeNull();
  });
});
