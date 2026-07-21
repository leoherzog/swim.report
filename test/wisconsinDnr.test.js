// test/wisconsinDnr.test.js
// Pure-parser + matches() tests for the Wisconsin DNR Beach Health scraper.
// No network: parseWisconsinDnrJson is exercised against a trimmed inline
// fixture built from real ArcGIS layer records. No backticks anywhere.
import { describe, it, expect } from "vitest";
import {
  parseWisconsinDnrJson,
  wisconsinDnr,
  WISCONSIN_DNR_URL,
  WISCONSIN_DNR_USER_AGENT,
  WISCONSIN_DNR_OFFICIAL_TTL_SECONDS,
  isWisconsinDnrInSeason,
  isWisconsinDnrFetchHour,
  shouldFetchWisconsinDnr
} from "../src/officialSources/wisconsinDnr.js";
import { makeBeach } from "./helpers/beach.js";

// A fixed "now" a few days after the fixture sample date (2026-06-30), so the
// default fixtures are all fresh. Staleness tests override SAMPLEDATE.
const NOW = "2026-07-05T12:00:00Z";
// 2026-06-30T05:00:00Z as epoch ms (midnight Central) — the default sample
// date for fixtures.
const SAMPLE_MS = 1782795600000;

// One feature per MAP_STATUS value observed live, plus one with missing
// geometry. Values are trimmed copies of real records from the layer. The
// optional final arg overrides SAMPLEDATE (pass null to drop the field).
function feature(objectId, name, mapStatus, x, y, includeGeometry, sampleMs) {
  const attrs = {
    OBJECTID: objectId,
    DNR_SWIMS_ID: "253201",
    OGW_BEACH_NAME_TEXT: name,
    STATUS: "trimmed",
    BEACH_ACTION: "Open",
    MAP_STATUS: mapStatus,
    ISSUED: "30-JUN-26 - 30-JUN-26"
  };
  if (sampleMs !== null) {
    attrs.SAMPLEDATE = sampleMs === undefined ? SAMPLE_MS : sampleMs;
  }
  const out = { attributes: attrs };
  if (includeGeometry) {
    out.geometry = { x: x, y: y };
  }
  return out;
}

function fixture(features, extra) {
  const base = {
    displayFieldName: "OGW_BEACH_NAME_TEXT",
    geometryType: "esriGeometryPoint",
    spatialReference: { wkid: 4326, latestWkid: 4326 },
    features: features
  };
  return JSON.stringify(Object.assign(base, extra || {}));
}

const ALL_STATUSES = fixture([
  feature(1, "Twin Valley Beach", "Open", -90.0913, 43.0313, true),
  feature(2, "Zoo Beach", "Advisory", -87.7814, 42.7486, true),
  feature(3, "Palmer Park Beach", "Closed", -88.985, 42.6826, true),
  feature(4, "Brule River State Forest Beach 1", "No Data Available", -91.6107, 46.7476, true),
  feature(5, "Upper Lake Park Beach", "Other Status", -87.8622, 43.396, true),
  feature(6, "Some Seasonal Beach", "Closed For Season", -87.9, 43.4, true),
  feature(7, "Ghost Beach", "Open", -88.0, 43.5, false)
]);

describe("parseWisconsinDnrJson", function() {
  it("maps Open/Advisory/Closed and omits every untrusted status", function() {
    const sites = parseWisconsinDnrJson(ALL_STATUSES, NOW);
    expect(Array.isArray(sites)).toBe(true);
    // Open, Advisory, Closed keep sites; No Data / Other / Closed For Season /
    // missing-geometry are all omitted.
    expect(sites.length).toBe(3);
    const byColor = {};
    for (let i = 0; i < sites.length; i++) {
      byColor[sites[i].color] = sites[i];
    }
    expect(byColor.green.siteId).toBe("wi-dnr-1");
    expect(byColor.yellow.siteId).toBe("wi-dnr-2");
    expect(byColor.red.siteId).toBe("wi-dnr-3");
  });

  it("carries lat/lon from geometry, radiusMi 1.0, and a dated reason", function() {
    const sites = parseWisconsinDnrJson(ALL_STATUSES, NOW);
    const open = sites[0];
    expect(open.lat).toBe(43.0313);
    expect(open.lon).toBe(-90.0913);
    expect(open.radiusMi).toBe(1.0);
    expect(open.reason).toBe(
      "Official flag reported by Wisconsin DNR Beach Health Program for Twin Valley Beach (sampled 2026-06-30)"
    );
  });

  it("stamps each site's updated with its own SAMPLEDATE, not nowIso", function() {
    // Regression: this periodic sampling source must never present an
    // up-to-21-day-old reading as freshly updated — updated: nowIso would
    // suppress the frontend's 2-hour stale-data warning.
    const sites = parseWisconsinDnrJson(ALL_STATUSES, NOW);
    expect(sites.length).toBe(3);
    for (let i = 0; i < sites.length; i++) {
      // SAMPLE_MS = 1782795600000 -> 2026-06-30T05:00:00.000Z.
      expect(sites[i].updated).toBe("2026-06-30T05:00:00.000Z");
    }
  });

  it("does NOT emit names[] (proximity-only; generic DNR names would mis-bind)", function() {
    // Statewide layer has generic names like "North Beach"/"South Beach"; since
    // a name match wins over proximity and ignores distance, emitting names
    // could bind a Great Lakes beach to a same-named site far away. Guard: no
    // site carries a names field, so resolution stays purely proximity-based.
    const sites = parseWisconsinDnrJson(ALL_STATUSES, NOW);
    expect(sites.length).toBeGreaterThan(0);
    for (let i = 0; i < sites.length; i++) {
      expect(sites[i].names).toBe(undefined);
    }
  });

  it("never emits a color outside the allowed set", function() {
    const sites = parseWisconsinDnrJson(ALL_STATUSES, NOW);
    const allowed = { green: true, yellow: true, red: true, "double-red": true };
    for (let i = 0; i < sites.length; i++) {
      expect(allowed[sites[i].color]).toBe(true);
    }
  });

  it("omits a feature with missing geometry rather than guessing a location", function() {
    const sites = parseWisconsinDnrJson(ALL_STATUSES, NOW);
    for (let i = 0; i < sites.length; i++) {
      expect(sites[i].siteId).not.toBe("wi-dnr-7");
    }
  });

  it("returns null for malformed JSON", function() {
    expect(parseWisconsinDnrJson("{not valid json", NOW)).toBe(null);
  });

  it("returns null for null or empty input", function() {
    expect(parseWisconsinDnrJson(null, NOW)).toBe(null);
    expect(parseWisconsinDnrJson("", NOW)).toBe(null);
  });

  it("returns null for an ArcGIS error object served with HTTP 200", function() {
    const body = JSON.stringify({ error: { code: 400, message: "Invalid" } });
    expect(parseWisconsinDnrJson(body, NOW)).toBe(null);
  });

  it("returns null when there is no features array", function() {
    expect(parseWisconsinDnrJson(JSON.stringify({ foo: 1 }), NOW)).toBe(null);
  });

  it("returns an empty array (not null) for a well-formed empty feature list", function() {
    const sites = parseWisconsinDnrJson(fixture([]), NOW);
    expect(sites).toEqual([]);
  });

  it("still parses trusted features when exceededTransferLimit is set", function() {
    const body = fixture(
      [feature(10, "Warner Beach", "Open", -89.3796, 43.1279, true)],
      { exceededTransferLimit: true }
    );
    const sites = parseWisconsinDnrJson(body, NOW);
    expect(sites.length).toBe(1);
    expect(sites[0].color).toBe("green");
  });

  it("returns null when nowIso is missing or unparseable (cannot verify freshness)", function() {
    const body = fixture([feature(20, "Warner Beach", "Open", -89.3796, 43.1279, true)]);
    expect(parseWisconsinDnrJson(body)).toBe(null);
    expect(parseWisconsinDnrJson(body, "not-a-date")).toBe(null);
  });

  it("omits a colored site whose newest sample is older than the cutoff", function() {
    // 40 days before NOW: well past the 21-day staleness cutoff. An off-season
    // "Open" row must degrade to no official flag, never a stale green.
    const staleMs = Date.parse(NOW) - 40 * 24 * 60 * 60 * 1000;
    const body = fixture([
      feature(30, "Stale Open Beach", "Open", -87.9, 43.3, true, staleMs),
      feature(31, "Fresh Open Beach", "Open", -87.8, 43.4, true)
    ]);
    const sites = parseWisconsinDnrJson(body, NOW);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("wi-dnr-31");
  });

  it("keeps a colored site sampled just inside the staleness cutoff", function() {
    const freshMs = Date.parse(NOW) - 20 * 24 * 60 * 60 * 1000;
    const body = fixture([
      feature(32, "Edge Open Beach", "Open", -87.9, 43.3, true, freshMs)
    ]);
    const sites = parseWisconsinDnrJson(body, NOW);
    expect(sites.length).toBe(1);
    expect(sites[0].color).toBe("green");
  });

  it("omits a colored site with a missing or non-numeric SAMPLEDATE", function() {
    const body = fixture([
      feature(33, "No Date Beach", "Open", -87.9, 43.3, true, null),
      feature(34, "Bad Date Beach", "Advisory", -87.8, 43.4, true, "yesterday")
    ]);
    const sites = parseWisconsinDnrJson(body, NOW);
    expect(sites).toEqual([]);
  });
});

describe("wisconsinDnr.matches", function() {
  it("matches a Wisconsin Lake Michigan beach", function() {
    const beach = makeBeach({ name: "Bradford Beach", lat: 43.058, lon: -87.874 });
    expect(wisconsinDnr.matches(beach)).toBe(true);
  });

  it("matches a Wisconsin Lake Superior beach", function() {
    const beach = makeBeach({ name: "Maslowski Beach", lat: 46.591, lon: -90.921 });
    expect(wisconsinDnr.matches(beach)).toBe(true);
  });

  it("matches a western-UP Michigan beach inside the shared box (acceptable; resolution is per-beach)", function() {
    const beach = makeBeach({ name: "Ontonagon Township Park Beach", lat: 46.874, lon: -89.316 });
    expect(wisconsinDnr.matches(beach)).toBe(true);
  });

  it("does not match a Lake Michigan beach on the Michigan (eastern) side", function() {
    const beach = makeBeach({ name: "South Haven South Beach", lat: 42.4, lon: -86.28 });
    expect(wisconsinDnr.matches(beach)).toBe(false);
  });

  it("does not match a beach south of the box", function() {
    const beach = makeBeach({ name: "Illinois Beach", lat: 42.2, lon: -87.8 });
    expect(wisconsinDnr.matches(beach)).toBe(false);
  });
});

describe("wisconsinDnr registry entry", function() {
  it("has the expected id, label, and query URL", function() {
    expect(wisconsinDnr.id).toBe("wisconsin-dnr");
    expect(wisconsinDnr.label).toBe("Wisconsin DNR Beach Health Program");
    expect(wisconsinDnr.url).toBe(WISCONSIN_DNR_URL);
    expect(WISCONSIN_DNR_URL.indexOf("where=1%3D1")).not.toBe(-1);
    expect(WISCONSIN_DNR_URL.indexOf("outSR=4326")).not.toBe(-1);
  });

  it("exposes a longer per-scraper official-KV TTL that outlasts the fetch gap", function() {
    // F2: fetches are ~6h apart (FETCH_HOURS every 6h); the official flag must
    // survive that gap, so the TTL must exceed 6h. 8h gives a one-missed-fetch
    // margin. The official-scrape step reads scraper.officialTtlSeconds.
    expect(wisconsinDnr.officialTtlSeconds).toBe(WISCONSIN_DNR_OFFICIAL_TTL_SECONDS);
    expect(WISCONSIN_DNR_OFFICIAL_TTL_SECONDS).toBe(28800);
    expect(WISCONSIN_DNR_OFFICIAL_TTL_SECONDS).toBeGreaterThan(6 * 3600);
  });
});

describe("wisconsinDnr User-Agent (F3)", function() {
  it("self-identifies rather than spoofing a browser", function() {
    // Re-probed 2026-07-20: the self-identifying UA returns HTTP 200 on the full
    // statewide query, so the earlier timeout was from sending NO UA, not from
    // failing a browser check. Must name swim.report and carry a contact link.
    expect(WISCONSIN_DNR_USER_AGENT).toBe("Mozilla/5.0 (swim.report; +https://swim.report)");
    expect(WISCONSIN_DNR_USER_AGENT.indexOf("swim.report")).not.toBe(-1);
    expect(WISCONSIN_DNR_USER_AGENT.indexOf("Chrome")).toBe(-1);
  });
});

describe("wisconsinDnr season guard (F2)", function() {
  // America/Chicago local months; season is the wide May-October window.
  it("is in season for May through October", function() {
    expect(isWisconsinDnrInSeason("2026-05-15T12:00:00Z")).toBe(true);
    expect(isWisconsinDnrInSeason("2026-07-05T12:00:00Z")).toBe(true);
    expect(isWisconsinDnrInSeason("2026-10-15T12:00:00Z")).toBe(true);
  });

  it("is out of season November through April", function() {
    expect(isWisconsinDnrInSeason("2026-01-15T12:00:00Z")).toBe(false);
    expect(isWisconsinDnrInSeason("2026-04-15T12:00:00Z")).toBe(false);
    expect(isWisconsinDnrInSeason("2026-11-15T12:00:00Z")).toBe(false);
    expect(isWisconsinDnrInSeason("2026-12-15T12:00:00Z")).toBe(false);
  });

  it("uses local-time month at the boundaries", function() {
    // 2026-05-01T02:00Z is still Apr 30 21:00 in Chicago (CDT, UTC-5) -> out.
    expect(isWisconsinDnrInSeason("2026-05-01T02:00:00Z")).toBe(false);
    // 2026-05-01T06:00Z is May 1 01:00 local -> in.
    expect(isWisconsinDnrInSeason("2026-05-01T06:00:00Z")).toBe(true);
  });

  it("treats a missing/unparseable timestamp as in season (safe default)", function() {
    expect(isWisconsinDnrInSeason(undefined)).toBe(true);
    expect(isWisconsinDnrInSeason("")).toBe(true);
    expect(isWisconsinDnrInSeason("not-a-date")).toBe(true);
  });
});

describe("wisconsinDnr fetch-cadence gate (F2)", function() {
  // July -> Chicago is CDT (UTC-5), so local hour = UTC hour - 5.
  it("fetches only on the evenly-spread cadence hours (0/6/12/18 local)", function() {
    expect(isWisconsinDnrFetchHour("2026-07-15T05:00:00Z")).toBe(true);  // 00 local
    expect(isWisconsinDnrFetchHour("2026-07-15T11:00:00Z")).toBe(true);  // 06 local
    expect(isWisconsinDnrFetchHour("2026-07-15T17:00:00Z")).toBe(true);  // 12 local
    expect(isWisconsinDnrFetchHour("2026-07-15T23:00:00Z")).toBe(true);  // 18 local
  });

  it("skips off-cadence hours so the query runs a few times/day, not hourly", function() {
    expect(isWisconsinDnrFetchHour("2026-07-15T12:00:00Z")).toBe(false); // 07 local
    expect(isWisconsinDnrFetchHour("2026-07-15T08:00:00Z")).toBe(false); // 03 local
    expect(isWisconsinDnrFetchHour("2026-07-15T18:00:00Z")).toBe(false); // 13 local
  });

  it("treats a missing/unparseable timestamp as a fetch hour (safe default)", function() {
    expect(isWisconsinDnrFetchHour(undefined)).toBe(true);
    expect(isWisconsinDnrFetchHour("not-a-date")).toBe(true);
  });
});

describe("wisconsinDnr combined pre-fetch gate (F2)", function() {
  it("fetches only when in season AND on a cadence hour", function() {
    // In season + cadence hour -> fetch.
    expect(shouldFetchWisconsinDnr("2026-07-15T17:00:00Z")).toBe(true);
    // In season, off-cadence hour -> skip.
    expect(shouldFetchWisconsinDnr("2026-07-15T12:00:00Z")).toBe(false);
    // Off season, cadence hour -> skip.
    expect(shouldFetchWisconsinDnr("2026-01-15T06:00:00Z")).toBe(false);
  });
});
