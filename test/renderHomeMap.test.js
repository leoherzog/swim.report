// Coverage for the homepage map mount: the #home-map container, its
// accessibility attributes (aria-hidden, tabindex, no advertising aria-label),
// the data-center attribute, section ordering (intro -> map -> search), and the
// client script wiring (one-shot /api/beaches.geojson fetch feeding one
// unclustered GeoJSON source rendered only as the coast highlight, keyboard:false,
// click handlers, re-center-only nearupdate).
// The per-beach flag data lives in the /api/beaches.geojson endpoint, so its
// color-keyword coverage is in test/router.test.js.

import { describe, it, expect } from "vitest";
import { renderListPage } from "../src/frontend/render.js";
import { PAGE_STYLES } from "../src/frontend/styles.js";

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
    // A section aria-label would advertise a map that is hidden from assistive
    // tech, so there must not be one.
    expect(html).not.toContain("aria-label=\"Map of nearby beaches");
  });

  it("fills the mount with a skeleton until the map loads", () => {
    const html = renderListPage({ entries: [{ beach: makeBeach(), estimate: null, official: null, distanceMi: null }] });
    expect(html).toContain("<wa-skeleton class=\"home-map-skeleton\" effect=\"sheen\"></wa-skeleton>");
    // Inside the mount, so it inherits the aria-hidden subtree and needs no
    // label of its own; MapLibre appends its canvas alongside it.
    expect(html).toContain("tabindex=\"-1\">" +
      "<wa-skeleton class=\"home-map-skeleton\" effect=\"sheen\"></wa-skeleton></div>");
    // The indicator's default pill radius is squared off to the mount's, and
    // its always-on sheen stops for a reduced-motion visitor.
    expect(PAGE_STYLES).toContain(".home-map-skeleton::part(indicator) {");
    expect(PAGE_STYLES).toContain("  border-radius: var(--wa-border-radius-m);");
    expect(PAGE_STYLES).toContain("@media (prefers-reduced-motion: reduce) {\n" +
      "  .home-map-skeleton::part(indicator) {\n    animation: none;\n  }\n}");
  });

  it("removes the skeleton on load and on every path that ends with no map", () => {
    const html = renderListPage({ entries: [] });
    expect(html).toContain("const skeleton = container.querySelector('wa-skeleton');");
    // On the map's load event, in the construction catch, on the map 'error'
    // event, and when the MapLibre module import fails.
    expect(html).toContain("map.on('load', function () {\n      clearSkeleton();");
    expect(html).toContain("} catch (e) {\n      clearSkeleton();\n      return;");
    expect(html).toContain("map.on('error', function (e) {\n      clearSkeleton();");
    expect(html).toContain("import(MAPLIBRE_MODULE_URL).then(startMap).catch(clearSkeleton);");
  });

  it("embeds no per-beach marker JSON", () => {
    const html = renderListPage({
      entries: [{ beach: makeBeach(), estimate: { color: "green" }, official: null, distanceMi: null }]
    });
    // Marker data comes from the fetched GeoJSON endpoint, so there is no inline
    // block and no server-embedded iconClass or label.
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
    // MapLibre 6 is ESM-only — the pinned bundle is the .mjs module, pulled in
    // by the inline script's dynamic import, and both pins share one version.
    expect(html).toContain("maplibre-gl@6.1.0/dist/maplibre-gl.mjs");
    expect(html).toContain("maplibre-gl@6.1.0/dist/maplibre-gl.css");
    expect(html).toContain("import(MAPLIBRE_MODULE_URL).then(startMap)");
    // The retired UMD bundle must not come back as a <script src>: it is no
    // longer published, so the tag would 404 and the map would never load.
    expect(html).not.toContain("<script src=\"https://unpkg.com/maplibre-gl");
    expect(html).not.toContain("/dist/maplibre-gl.js");
  });

  it("registers the missing-icon net as a resolver, not the notify-only event", () => {
    const html = renderListPage({ entries: [] });
    // MapLibre 6 demoted styleimagemissing to notify-only — a listener can no
    // longer supply the image it is told about, so the placeholder net has to
    // be a resolver or unregistered icons would render as nothing.
    expect(html).toContain("map.setMissingStyleImageResolver(function (id)");
    expect(html).not.toContain("'styleimagemissing'");
  });

  it("logs a GPU/WebGL failure instead of letting it surface unhandled", () => {
    const html = renderListPage({ entries: [] });
    // MapLibre 6 reports a failed WebGL2 context through the map's 'error'
    // event rather than throwing out of the constructor, so the construction
    // try/catch does not cover it.
    expect(html).toContain("map.on('error', function (e)");
    expect(html).toContain("console.log('map error: '");
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

  it("fetches the GeoJSON endpoint once (on load, not moveend) into one source", () => {
    const html = renderListPage({ entries: [] });
    // One-shot fetch of the full flag-worthy directory into a single source that
    // carries every beach at every zoom: the zoomed-out view is a rendering
    // choice, not a thinned dataset.
    expect(html).toContain("fetch(GEOJSON_URL");
    expect(html).toContain("'/api/beaches.geojson'");
    expect(html).toContain("map.addSource('beaches', { type: 'geojson', data: fc });");
    // The retired clustering must not come back: a bubble's count is beach
    // density, which competes with its color for the same symbol.
    expect(html).not.toContain("cluster: true");
    expect(html).not.toContain("clusterProperties");
    expect(html).not.toContain("getClusterExpansionZoom");
    expect(html).not.toContain("point_count");
    // The removed viewport pan-to-load must be gone: no moveend fetch, no bbox.
    expect(html).not.toContain("scheduleViewportLoad");
    expect(html).not.toContain("/api/beaches?bbox=");
    expect(html).not.toContain("markersById");
  });

  // Zoomed out, each beach paints a wide disc in its flag color and the discs
  // merge into a highlight along the coast, so the continental view reads as a
  // hazard map without a count competing with the color.
  it("paints one highlight layer per flag color, worst last", () => {
    const html = renderListPage({ entries: [] });
    expect(html).toContain("const HIGHLIGHT_LAYERS = [");
    expect(html).toContain("{ key: 'green', filter: ['==', ['get', 'flag'], 'green'] },");
    expect(html).toContain("{ key: 'yellow', filter: ['==', ['get', 'flag'], 'yellow'] },");
    expect(html).toContain("{ key: 'red', filter: ['==', ['get', 'flag'], 'red'] }");
    // Paint order is the precedence: where two colors meet, the worse one takes
    // the pixel.
    const order = ["'unknown'", "'green'", "'yellow'", "'red'"].map(function (k) {
      return html.indexOf("{ key: " + k + ",");
    });
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    expect(order[2]).toBeLessThan(order[3]);
    // The disc colors are the same four hexes the icons are tinted with.
    expect(html).toContain("'circle-color': resolveFlagHex(HIGHLIGHT_LAYERS[i].key),");
  });

  it("keeps every highlighted pixel on one flag hex", () => {
    const html = renderListPage({ entries: [] });
    // Opaque and unblurred: a translucent or blurred disc would composite two
    // flag hexes into a third that reads as a color the coast does not carry.
    expect(html).toContain("'circle-blur': 0,");
    expect(html).toContain("'circle-opacity': 1");
    expect(html).not.toContain("'circle-opacity': 0.");
  });

  it("filters the unknown highlight as the complement of the three known flags", () => {
    const html = renderListPage({ entries: [] });
    // An equality test on 'unknown' would drop a keyword outside the four; the
    // complement falls to unknown exactly as the flag layer's match fallback does.
    expect(html).toContain("{ key: 'unknown', filter: " +
      "['!', ['in', ['get', 'flag'], ['literal', ['green', 'yellow', 'red']]]] },");
  });

  it("changes the highlight with zoom by radius, never by opacity", () => {
    const html = renderListPage({ entries: [] });
    // The discs widen to stay merged as the beaches spread apart, then settle at
    // marker size. circle-opacity applies per feature, so varying it would
    // composite overlapping discs of one color into a darker third wherever the
    // coast is densest.
    expect(html).toContain("const HIGHLIGHT_RADIUS = ['interpolate', ['linear'], ['zoom'],\n" +
      "    3, 4.5, 5, 4.5, 6, 6, 8, 5, 14, 8];");
    expect(html).toContain("'circle-radius': HIGHLIGHT_RADIUS,");
    // The highlight is the whole rendering, so it is never cut off by zoom.
    expect(html).not.toContain("maxzoom:");
    expect(html).not.toContain("minzoom:");
  });

  it("renders no marker symbols at all", () => {
    const html = renderListPage({ entries: [] });
    // The highlight is the only rendering of the source: no symbol layer, and
    // none of the machinery that rasterized and tinted the fa-flag glyph.
    expect(html).not.toContain("type: 'symbol'");
    expect(html).not.toContain("icon-image");
    expect(html).not.toContain("FLAG_SVG");
    expect(html).not.toContain("tintToImageData");
    expect(html).not.toContain("addFlagImages");
    expect(html).not.toContain("'flag-green'");
  });

  it("inserts the highlight beneath the basemap's labels", () => {
    const html = renderListPage({ entries: [] });
    // The discs are opaque, so place labels have to stay on top of them.
    expect(html).toContain("const firstSymbolLayerId = function () {");
    expect(html).toContain("if (layers[i].type === 'symbol') { return layers[i].id; }");
    expect(html).toContain("}, beforeId);");
  });

  it("disables MapLibre keyboard handling and adds no focusable NavigationControl", () => {
    const html = renderListPage({ entries: [] });
    expect(html).toContain("keyboard: false");
    // NavigationControl's zoom buttons would be focusable inside the aria-hidden
    // container, so the map adds none.
    expect(html).not.toContain("NavigationControl");
  });

  it("splits one click handler on the zoom where a disc stands alone", () => {
    const html = renderListPage({ entries: [] });
    // Below PICK_MIN_ZOOM the discs are merged, so the feature under the cursor
    // is arbitrary and a click zooms in rather than guessing a beach. At or above
    // it, one disc is one beach and a click navigates.
    expect(html).toContain("const PICK_MIN_ZOOM = 9;");
    expect(html).toContain("if (map.getZoom() < PICK_MIN_ZOOM) {\n" +
      "          map.easeTo({ center: e.lngLat, zoom: PICK_MIN_ZOOM });\n" +
      "          return;\n        }");
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

  it("re-centers the map on the browser fix immediately, not after the list fetch", () => {
    const html = renderListPage({ entries: [] });
    // The map needs nothing from the "/?near=" response (its GeoJSON source
    // already holds every beach), so the re-center must fire in the position
    // callback — before the round-trip, and surviving a fetch failure. Leaving
    // it downstream of the fetch parks the map on the coarse Cloudflare IP
    // estimate for the whole request.
    expect(html).toContain("applyMapCenter(params.get('near'));");
    // The attribute is set BEFORE the event so a map script that has not built
    // its map yet (the maplibre-gl.mjs import still in flight) still reads the
    // fix at construction.
    const helper = html.indexOf("const applyMapCenter = function (center) {");
    expect(helper).toBeGreaterThan(-1);
    const setAttr = html.indexOf("mapEl.setAttribute('data-center', center);", helper);
    const dispatch = html.indexOf("dispatchEvent(new CustomEvent('swimreport:nearupdate'))", helper);
    expect(setAttr).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(setAttr);
    // The immediate re-center precedes the fetch, never waiting on it.
    expect(html.indexOf("applyMapCenter(params.get('near'));"))
      .toBeLessThan(html.indexOf("fetch(nextUrl)"));
  });

  it("logs a geolocation failure instead of swallowing it", () => {
    const html = renderListPage({ entries: [] });
    // An already-granted permission that still fails (no location provider, a
    // killed platform service) was indistinguishable from a fix landing near the
    // IP estimate while the error callback was an empty function.
    expect(html).not.toContain("}, function () {}, { maximumAge:");
    expect(html).toContain("console.log('geolocation unavailable (code '");
  });
});
