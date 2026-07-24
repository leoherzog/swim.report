// test/renderHomeMap.test.js
// Coverage for the homepage map MOUNT: the #home-map container, its
// accessibility attributes (aria-hidden, tabindex, no advertising aria-label),
// the data-center attribute, section ordering (intro -> map -> search), and the
// client script wiring (one-shot /api/beaches.geojson fetch feeding a clustered
// GeoJSON source, keyboard:false, click handlers, re-center-only nearupdate).
// The per-beach flag data now lives in the /api/beaches.geojson endpoint, so its
// color-keyword coverage is in test/router.test.js, not here.

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

  it("marks the visual-only map hidden and out of the tab order", () => {
    const html = renderListPage({ entries: [{ beach: makeBeach(), estimate: null, official: null, distanceMi: null }] });
    // The map is a purely visual supplement (search + list is the accessible
    // path), so the mount is aria-hidden and not keyboard-focusable.
    expect(html).toContain("aria-hidden=\"true\"");
    expect(html).toContain("tabindex=\"-1\"");
    // The old section aria-label advertised a now-hidden map; it must be gone.
    expect(html).not.toContain("aria-label=\"Map of nearby beaches");
  });

  it("no longer embeds per-beach marker JSON", () => {
    const html = renderListPage({
      entries: [{ beach: makeBeach(), estimate: { color: "green" }, official: null, distanceMi: null }]
    });
    // Marker data moved to the fetched GeoJSON endpoint — no inline block, and
    // no server-embedded iconClass/label.
    expect(html).not.toContain("id=\"home-map-data\"");
    expect(html).not.toContain("iconClass");
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
    // No embedded marker block at all — the client fetches the endpoint.
    expect(html).not.toContain("id=\"home-map-data\"");
  });

  it("fetches the GeoJSON endpoint once (on load, not moveend) and clusters it", () => {
    const html = renderListPage({ entries: [] });
    // One-shot fetch of the full flag-worthy directory, fed to a clustered source.
    expect(html).toContain("fetch(GEOJSON_URL");
    expect(html).toContain("'/api/beaches.geojson'");
    expect(html).toContain("cluster: true");
    expect(html).toContain("map.addSource('beaches'");
    // The removed viewport pan-to-load must be gone: no moveend fetch, no bbox.
    expect(html).not.toContain("scheduleViewportLoad");
    expect(html).not.toContain("/api/beaches?bbox=");
    expect(html).not.toContain("markersById");
  });

  it("disables MapLibre keyboard handling and adds no focusable NavigationControl", () => {
    const html = renderListPage({ entries: [] });
    expect(html).toContain("keyboard: false");
    // NavigationControl's zoom buttons would be focusable inside the aria-hidden
    // container, so the map no longer adds one.
    expect(html).not.toContain("NavigationControl");
  });

  it("wires cluster-expand and flag-click navigation handlers", () => {
    const html = renderListPage({ entries: [] });
    // Cluster click expands via the Promise-returning getClusterExpansionZoom.
    expect(html).toContain("getClusterExpansionZoom");
    // Unclustered flag click navigates to the beach page.
    expect(html).toContain("window.location.href = '/beach/' + encodeURIComponent(id)");
  });

  it("embeds the map script's live-update hook for the geolocation swap", () => {
    const html = renderListPage({ entries: [] });
    // geoScript.js swaps data-center in place and dispatches this event; the map
    // script re-reads data-center and eases to the new center. The source already
    // holds every beach, so it is a pure re-center (no refetch, no rebuild).
    expect(html).toContain("document.addEventListener('swimreport:nearupdate'");
    expect(html).toContain("map.easeTo({ center: updated.center, zoom: updated.zoom })");
  });
});
