// test/renderHomeMap.test.js
// Coverage for the homepage map: the #home-map container, the embedded
// beach-marker JSON (#home-map-data), best-color precedence, double-red
// handling, non-finite coordinate skipping, XSS escaping, the data-center
// attribute, and section ordering (intro -> map -> search).

import { describe, it, expect } from "vitest";
import { renderListPage } from "../src/frontend/render.js";

function makeBeach(overrides) {
  return Object.assign({
    id: "beach-1",
    name: "Ottawa Beach",
    park_name: null,
    lat: 42.775,
    lon: -86.211
  }, overrides || {});
}

describe("renderListPage home map", () => {
  it("renders the map container and section", () => {
    const html = renderListPage({ entries: [{ beach: makeBeach(), estimate: null, official: null, distanceMi: null }] });
    expect(html).toContain("id=\"home-map\"");
    // The container reuses the shared .framed-embed border and the
    // wa-border-radius-m utility, so home-map is the first of several classes.
    expect(html).toContain("class=\"home-map framed-embed wa-border-radius-m\"");
  });

  it("orders intro before map before search", () => {
    const html = renderListPage({ entries: [{ beach: makeBeach(), estimate: null, official: null, distanceMi: null }] });
    const introIdx = html.indexOf("list-intro");
    const mapIdx = html.indexOf("home-map-section");
    const searchIdx = html.indexOf("beach-search-form");
    expect(introIdx).toBeGreaterThan(-1);
    expect(mapIdx).toBeGreaterThan(-1);
    expect(searchIdx).toBeGreaterThan(-1);
    expect(introIdx).toBeLessThan(mapIdx);
    expect(mapIdx).toBeLessThan(searchIdx);
  });

  it("wires the pinned MapLibre JS and CSS assets", () => {
    const html = renderListPage({ entries: [] });
    expect(html).toContain("maplibre-gl@5.24.0/dist/maplibre-gl.js");
    expect(html).toContain("maplibre-gl@5.24.0/dist/maplibre-gl.css");
  });

  it("uses official color over estimate color for the marker icon class", () => {
    const html = renderListPage({
      entries: [{
        beach: makeBeach({ id: "b-off", name: "Off Beach" }),
        estimate: { color: "yellow" },
        official: { color: "red" },
        distanceMi: null
      }]
    });
    expect(html).toContain("<script type=\"application/json\" id=\"home-map-data\">");
    expect(html).toContain("\"id\":\"b-off\"");
    expect(html).toContain("\"name\":\"Off Beach\"");
    expect(html).toContain("\"iconClass\":\"flag-icon-red\"");
    expect(html).toContain("\"label\":\"Red flag\"");
  });

  it("falls back to estimate color when official is null", () => {
    const html = renderListPage({
      entries: [{
        beach: makeBeach({ id: "b-est", name: "Est Beach" }),
        estimate: { color: "yellow" },
        official: null,
        distanceMi: null
      }]
    });
    expect(html).toContain("\"id\":\"b-est\"");
    expect(html).toContain("\"iconClass\":\"flag-icon-yellow\"");
    expect(html).toContain("\"label\":\"Yellow flag\"");
  });

  it("falls back to unknown when both official and estimate are null", () => {
    const html = renderListPage({
      entries: [{
        beach: makeBeach({ id: "b-unk", name: "Unk Beach" }),
        estimate: null,
        official: null,
        distanceMi: null
      }]
    });
    expect(html).toContain("\"id\":\"b-unk\"");
    expect(html).toContain("\"iconClass\":\"flag-icon-unknown\"");
    expect(html).toContain("\"label\":\"Flag status unknown\"");
  });

  it("tints double-red as the red icon class, with a double-red label", () => {
    const html = renderListPage({
      entries: [{
        beach: makeBeach({ id: "b-dr", name: "DR Beach" }),
        estimate: null,
        official: { color: "double-red" },
        distanceMi: null
      }]
    });
    expect(html).toContain("\"id\":\"b-dr\"");
    expect(html).toContain("\"iconClass\":\"flag-icon-red\"");
    expect(html).toContain("\"label\":\"Double red flags\"");
  });

  it("skips beaches with non-finite coordinates", () => {
    const html = renderListPage({
      entries: [
        { beach: makeBeach({ id: "b-good", name: "Good Beach" }), estimate: null, official: null, distanceMi: null },
        { beach: makeBeach({ id: "b-nulllat", name: "Null Lat", lat: null }), estimate: null, official: null, distanceMi: null },
        { beach: makeBeach({ id: "b-badlon", name: "Bad Lon", lon: "not-a-number" }), estimate: null, official: null, distanceMi: null }
      ]
    });
    expect(html).toContain("\"id\":\"b-good\"");
    expect(html).not.toContain("\"id\":\"b-nulllat\"");
    expect(html).not.toContain("\"id\":\"b-badlon\"");
  });

  it("escapes < in beach names for the embedded JSON", () => {
    const html = renderListPage({
      entries: [{
        beach: makeBeach({ id: "b-xss", name: "A<b" }),
        estimate: null,
        official: null,
        distanceMi: null
      }]
    });
    expect(html).toContain("A\\u003cb");
    expect(html).not.toContain("A<b");
  });

  it("centers precisely on a browser location (near + resolved location)", () => {
    const html = renderListPage({
      entries: [{ beach: makeBeach(), estimate: null, official: null, distanceMi: null }],
      near: "42.775,-86.211",
      location: { lat: 42.775, lon: -86.211 }
    });
    expect(html).toContain("data-center=\"42.775,-86.211\"");
    expect(html).toContain("data-center-precise=\"1\"");
  });

  it("centers on the Cloudflare IP estimate (coarse) when no near param is present", () => {
    const html = renderListPage({
      entries: [{ beach: makeBeach(), estimate: null, official: null, distanceMi: null }],
      location: { lat: 41.8781, lon: -87.6298 }
    });
    // Rounded to 3 dp; flagged as the coarser IP estimate, so the browser zooms
    // out one step relative to a precise fix.
    expect(html).toContain("data-center=\"41.878,-87.630\"");
    expect(html).toContain("data-center-precise=\"0\"");
  });

  it("omits data-center when no location is resolved", () => {
    const html = renderListPage({
      entries: [{ beach: makeBeach(), estimate: null, official: null, distanceMi: null }]
    });
    // LIST_MAP_SCRIPT references the attribute name (to read it), so assert on
    // the rendered attribute syntax, not the bare substring.
    expect(html).not.toContain("data-center=\"");
  });

  it("degrades cleanly with no entries", () => {
    expect(function () {
      renderListPage({ entries: [] });
    }).not.toThrow();
    const html = renderListPage({ entries: [] });
    expect(html).toContain("id=\"home-map\"");
    expect(html).toContain("<script type=\"application/json\" id=\"home-map-data\">[]</script>");
  });

  it("embeds the map script's live-update hook for the geolocation swap", () => {
    const html = renderListPage({ entries: [] });
    // geoScript.js swaps the marker JSON + data-center in place and dispatches
    // this event; the map script must re-read both and ease to the new center
    // (rebuilding markers — the nearest-100 set can change, not just the view).
    expect(html).toContain("document.addEventListener('swimreport:nearupdate'");
    expect(html).toContain("map.easeTo({ center: updated.center, zoom: updated.zoom })");
  });

  it("wires viewport pan-to-load against /api/beaches", () => {
    const html = renderListPage({ entries: [] });
    // On move/load the script fetches the current viewport bbox and adds any
    // beach not already shown, so panning reveals flags beyond the initial set.
    expect(html).toContain("map.on('moveend', scheduleViewportLoad)");
    expect(html).toContain("map.on('load', scheduleViewportLoad)");
    expect(html).toContain("fetch('/api/beaches?bbox=' + encodeURIComponent(bbox)");
    // A transient failure must clear lastBbox so the view retries instead of
    // staying permanently deduped (and blank).
    expect(html).toContain(".catch(function () { lastBbox = ''; })");
    // Markers accumulate by id (idempotent add), never a full-map rebuild on pan.
    expect(html).toContain("const markersById = Object.create(null)");
  });
});
