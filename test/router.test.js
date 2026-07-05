// test/router.test.js
// Pure-function coverage for the proximity-sorting helpers in src/router.js
// and the distance/sort-note rendering in src/frontend/render.js.

import { describe, it, expect } from "vitest";
import { distanceMi, resolveUserLocation } from "../src/router.js";
import { renderListPage, renderDetailPage } from "../src/frontend/render.js";

function urlWith(search) {
  return new URL("https://swim.report/" + (search || ""));
}

describe("distanceMi", () => {
  it("returns 0 for identical points", () => {
    expect(distanceMi(42.4, -86.28, 42.4, -86.28)).toBe(0);
  });

  it("computes Chicago to Milwaukee as roughly 80 miles", () => {
    const d = distanceMi(41.8781, -87.6298, 43.0389, -87.9065);
    expect(d).toBeGreaterThan(75);
    expect(d).toBeLessThan(85);
  });

  it("is symmetric", () => {
    const a = distanceMi(41.8781, -87.6298, 43.0389, -87.9065);
    const b = distanceMi(43.0389, -87.9065, 41.8781, -87.6298);
    expect(a).toBeCloseTo(b, 10);
  });
});

describe("resolveUserLocation", () => {
  it("reads request.cf latitude/longitude strings", () => {
    const request = { cf: { latitude: "42.4088", longitude: "-86.2798" } };
    expect(resolveUserLocation(request, urlWith(""))).toEqual({ lat: 42.4088, lon: -86.2798 });
  });

  it("returns null when cf has no coordinates", () => {
    expect(resolveUserLocation({ cf: {} }, urlWith(""))).toBeNull();
    expect(resolveUserLocation({}, urlWith(""))).toBeNull();
  });

  it("lets a valid near param override cf", () => {
    const request = { cf: { latitude: "10", longitude: "10" } };
    const loc = resolveUserLocation(request, urlWith("?near=42.4,-86.28"));
    expect(loc).toEqual({ lat: 42.4, lon: -86.28 });
  });

  it("returns null for malformed or out-of-range near params", () => {
    const request = { cf: { latitude: "10", longitude: "10" } };
    expect(resolveUserLocation(request, urlWith("?near=banana"))).toBeNull();
    expect(resolveUserLocation(request, urlWith("?near=1,2,3"))).toBeNull();
    expect(resolveUserLocation(request, urlWith("?near=99,0"))).toBeNull();
    expect(resolveUserLocation(request, urlWith("?near=0,181"))).toBeNull();
  });
});

describe("renderListPage proximity output", () => {
  function entryFor(name, dist) {
    return {
      beach: { id: "b-" + name, name: name, lat: 42, lon: -86 },
      estimate: null,
      official: null,
      distanceMi: dist
    };
  }

  it("shows rounded distance labels and the sort note when sorted", () => {
    const html = renderListPage({
      entries: [entryFor("Near Beach", 0.4), entryFor("Far Beach", 12.4)],
      nowIso: "2026-07-05T12:00:00.000Z",
      sortedByProximity: true
    });
    expect(html).toContain("&lt;1 mi");
    expect(html).toContain("~12 mi");
    expect(html).toContain("Sorted by approximate distance");
  });

  it("embeds a Windy wave map on the detail page centered on the beach", () => {
    const html = renderDetailPage({
      beach: { id: "b-1", name: "Oval Beach", lat: 42.6579, lon: -86.2114, osm_id: "way/1" },
      estimate: null,
      official: null,
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    expect(html).toContain("<wa-zoomable-frame");
    expect(html).toContain(" without-controls>");
    expect(html).toContain("https://embed.windy.com/embed.html");
    expect(html).toContain("overlay=waves");
    expect(html).toContain("lat=42.658");
    expect(html).toContain("lon=-86.211");
  });

  it("puts labeled sources in the card header and Updated in the footer", () => {
    const html = renderDetailPage({
      beach: { id: "b-1", name: "Oval Beach", lat: 42.6579, lon: -86.2114, osm_id: "way/1" },
      estimate: {
        color: "green",
        reason: "Estimated wave height 1.3 ft (below 2 ft)",
        trigger: "wave-height",
        rules_version: "1.1.0",
        official: false,
        sources: [
          { label: "ECMWF Wave Forecast via Open-Meteo", url: "https://open-meteo.com/en/docs/marine-weather-api" },
          { label: "NWS Surf Zone Forecast (SRF-MKX)" },
          "https://api.weather.gov/alerts/active?zone=MIZ071"
        ],
        updated: "2026-07-05T12:00:00.000Z"
      },
      official: null,
      nowIso: "2026-07-05T12:30:00.000Z"
    });
    expect(html).toContain("with-header-actions");
    expect(html).toContain("<div slot=\"header-actions\">");
    expect(html).toContain(
      "<a href=\"https://open-meteo.com/en/docs/marine-weather-api\" rel=\"noopener noreferrer\">" +
      "ECMWF Wave Forecast via Open-Meteo</a>"
    );
    expect(html).toContain("<span>NWS Surf Zone Forecast (SRF-MKX)</span>");
    // Legacy bare-string sources render as their hostname.
    expect(html).toContain(">api.weather.gov</a>");
    expect(html).toContain(
      "<div slot=\"footer\" class=\"card-updated\">Updated 2026-07-05T12:00:00.000Z UTC</div>"
    );
    expect(html).not.toContain("Sources:");
    expect(html).toContain(
      "Set by forecast wave height: 2 ft or higher raises yellow, 4 ft or higher raises red."
    );
    expect(html).not.toContain("Rules version:");
  });

  it("renders the official card with the same layout: source top right, Updated in footer", () => {
    const html = renderDetailPage({
      beach: { id: "b-1", name: "South Beach", lat: 42.3991, lon: -86.2842, osm_id: "way/9" },
      estimate: null,
      official: {
        color: "green",
        reason: "Official flag reported by City of South Haven Beach Flag Program",
        official: true,
        scraperId: "south-haven-mi",
        source: "https://www.southhavenmi.gov/parks_and_recreation/beach_flag_information.php",
        sources: ["https://www.southhavenmi.gov/parks_and_recreation/beach_flag_information.php"],
        updated: "2026-07-05T14:00:00.000Z"
      },
      nowIso: "2026-07-05T14:30:00.000Z"
    });
    const officialCard = html.slice(html.indexOf("official-card"), html.indexOf("estimate-card"));
    expect(officialCard).toContain("with-header-actions");
    expect(officialCard).toContain("<div slot=\"header-actions\">");
    expect(officialCard).toContain(">www.southhavenmi.gov</a>");
    expect(officialCard).toContain(
      "<div slot=\"footer\" class=\"card-updated\">Updated 2026-07-05T14:00:00.000Z UTC</div>"
    );
    expect(officialCard).not.toContain("Source:");
  });

  it("falls back to the rules-version line for payloads without a trigger", () => {
    const html = renderDetailPage({
      beach: { id: "b-1", name: "Oval Beach", lat: 42.6579, lon: -86.2114, osm_id: "way/1" },
      estimate: {
        color: "green",
        reason: "Estimated wave height 1.3 ft (below 2 ft)",
        rules_version: "1.0.0",
        official: false,
        sources: [],
        updated: "2026-07-05T12:00:00.000Z"
      },
      official: null,
      nowIso: "2026-07-05T12:30:00.000Z"
    });
    expect(html).toContain("Rules version: 1.0.0");
  });

  it("omits header actions and footer when there is no estimate", () => {
    const html = renderDetailPage({
      beach: { id: "b-1", name: "Oval Beach", lat: 42.6579, lon: -86.2114, osm_id: "way/1" },
      estimate: null,
      official: null,
      nowIso: "2026-07-05T12:30:00.000Z"
    });
    expect(html).not.toContain("with-header-actions");
    expect(html).not.toContain("with-footer");
    expect(html).not.toContain("card-updated\">");
  });

  it("omits the wave map when the beach has no usable coordinates", () => {
    const html = renderDetailPage({
      beach: { id: "b-2", name: "No Coords Beach", lat: null, lon: null, osm_id: "way/2" },
      estimate: null,
      official: null,
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    expect(html).not.toContain("<wa-zoomable-frame");
  });

  it("omits distances and the note when not sorted", () => {
    const html = renderListPage({
      entries: [entryFor("Some Beach", null)],
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    expect(html).not.toContain("<span class=\"beach-row-distance\"");
    expect(html).not.toContain("Sorted by approximate distance");
  });
});
