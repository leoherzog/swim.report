// Builds the literal text of the inline map script on the beach list (home)
// page. It runs in the browser, not in the Worker.
//
// MapLibre GL JS 6 is ESM-only, so the library arrives through a dynamic
// import() from inside this classic inline script: a failed load stays a silent
// no-op via .catch, where a static import in a <script type="module"> would log
// an uncaught module error. buildListMapScript takes the pinned module URL so
// render.js stays the single place both CDN pins live.
//
// The map uses the OpenFreeMap positron style and fetches every flag-worthy
// beach once from the cacheable /api/beaches.geojson endpoint into a single
// unclustered GeoJSON source, rendered as one thing at every zoom: each beach
// paints an opaque disc in its `flag` color (green|yellow|red|unknown). Zoomed
// out the discs merge into a highlight that traces the coast, because the
// beaches are on the coast; zoomed in they separate into one disc per beach.
// There are no marker symbols and no clustering. The four hexes are resolved
// from the live --flag-* variables so the map matches the rest of the UI, with
// the mild-palette hexes only as a fallback. Clicking a merged highlight zooms
// in; clicking a separated disc navigates to /beach/:id.
//
// Centering precedence: the container's data-center attribute (the resolved user
// location, at zoom 10 when data-center-precise is "1", else zoom 9), then
// fitBounds over all fetched features (padding 40, maxZoom 10), then the Great
// Lakes default center [-84, 44] at zoom 5. A "swimreport:nearupdate"
// CustomEvent on document, dispatched by geoScript.js after its in-place
// proximity swap, makes the live map re-read the updated data-center and ease to
// it; the source already holds every beach, so it is a pure re-center.
//
// The map is a purely visual supplement: the search box plus results list is the
// complete accessible path, covering the full flag-worthy table server-side. So
// MapLibre keyboard handling is disabled, the container is aria-hidden (set
// server-side in render.js) and kept out of the tab order, and the canvas is set
// to tabindex -1 at construction. No focusable control chrome is ever added, so
// the aria-hidden subtree holds no focusable node at any lifecycle point, tile
// load or not.
//
// Everything degrades silently: a failed module import, a missing container, an
// init throw, a GPU/WebGL2 failure, or a missing, failed or empty GeoJSON fetch
// simply leaves the page with its server-rendered beach list. The server-rendered
// <wa-skeleton> inside the mount is removed on the map's load event and on every
// path that ends with no map, so it never outlives the wait it describes.

const SCRIPT_LINES = [
  "  const container = document.getElementById('home-map');",
  "  if (!container) {",
  "    return;",
  "  }",
  // The server renders a <wa-skeleton> inside the mount. Every path that ends
  // with no map clears it too, so a sheening placeholder never stands in for a
  // map that is not coming.
  "  const clearSkeleton = function () {",
  "    const skeleton = container.querySelector('wa-skeleton');",
  "    if (skeleton) {",
  "      skeleton.remove();",
  "    }",
  "  };",
  // Set by startMap once the MapLibre module namespace has been imported. The
  // helpers below close over both, and none of them runs before startMap.
  "  let maplibre;",
  "  let map;",
  // Require exactly two non-empty parts before Number(): Number('') is 0, so a
  // truncated value like '42.7,' would otherwise center the map at 0 lon
  // instead of falling through to fitBounds.
  "  const readCenter = function () {",
  "    const centerAttr = container.getAttribute('data-center') || '';",
  "    const centerParts = centerAttr.split(',');",
  "    if (centerParts.length === 2 && centerParts[0] !== '' && centerParts[1] !== '') {",
  "      const clat = Number(centerParts[0]);",
  "      const clon = Number(centerParts[1]);",
  "      if (isFinite(clat) && isFinite(clon)) {",
  "        return {",
  "          center: [clon, clat],",
  "          zoom: container.getAttribute('data-center-precise') === '1' ? 10 : 9",
  "        };",
  "      }",
  "    }",
  "    return null;",
  "  };",
  "  const DEFAULT_CENTER = [-84, 44];",
  "  const DEFAULT_ZOOM = 5;",
  "  const GEOJSON_URL = '/api/beaches.geojson';",
  // The four flag hexes: resolve the flag variables styles.js declares on <html>
  // so the map matches the rest of the UI exactly, falling back to the
  // mild-palette hexes only if resolution yields an empty string. Resolved once,
  // when the layers are added, so a later light/dark toggle does not repaint
  // them.
  "  const FLAG_HEX_FALLBACK = { green: '#4f8051', yellow: '#c6ad4f', red: '#cf443b', unknown: '#777478' };",
  "  const FLAG_TOKEN = {",
  "    green: '--flag-green',",
  "    yellow: '--flag-yellow',",
  "    red: '--flag-red',",
  "    unknown: '--flag-unknown'",
  "  };",
  "  const resolveFlagHex = function (key) {",
  "    let v = '';",
  "    try {",
  "      v = getComputedStyle(document.documentElement).getPropertyValue(FLAG_TOKEN[key]).trim();",
  "    } catch (e) {}",
  "    return v || FLAG_HEX_FALLBACK[key];",
  "  };",

  // One highlight layer per flag color, painted in this order, so where two
  // colors meet the worse one takes the pixel. The unknown filter is the
  // complement of the other three rather than an equality test, so a keyword
  // outside the four falls to unknown rather than disappearing from the map.
  //
  // The discs are opaque and unblurred: every highlighted pixel is exactly one
  // of the four flag hexes. A translucent or blurred disc would composite two of
  // them into a third that reads as a flag color the coast does not carry.
  "  const HIGHLIGHT_LAYERS = [",
  "    { key: 'unknown', filter: ['!', ['in', ['get', 'flag'], ['literal', ['green', 'yellow', 'red']]]] },",
  "    { key: 'green', filter: ['==', ['get', 'flag'], 'green'] },",
  "    { key: 'yellow', filter: ['==', ['get', 'flag'], 'yellow'] },",
  "    { key: 'red', filter: ['==', ['get', 'flag'], 'red'] }",
  "  ];",
  // The highlight is opaque, so it is inserted beneath the style's first symbol
  // layer and the basemap's place labels stay legible on top of it. An undefined
  // beforeId is MapLibre's "add on top", which is the right fallback for a style
  // that carries no symbol layer at all.
  "  const firstSymbolLayerId = function () {",
  "    try {",
  "      const layers = map.getStyle().layers || [];",
  "      for (let i = 0; i < layers.length; i++) {",
  "        if (layers[i].type === 'symbol') { return layers[i].id; }",
  "      }",
  "    } catch (e) {}",
  "    return undefined;",
  "  };",
  // The radius peaks around zoom 6, where the discs have to be wide enough to
  // merge into a ribbon while the beaches under them are still spreading apart.
  // Above that they are markers, narrowed to stay distinct and widening again
  // only at beach scale. The radius is what changes with zoom, never
  // circle-opacity: opacity applies per feature, so two overlapping translucent
  // discs of one color composite into a darker third and the highlight would
  // mottle wherever the coast is densest.
  "  const HIGHLIGHT_RADIUS = ['interpolate', ['linear'], ['zoom'],",
  "    3, 4.5, 5, 4.5, 6, 6, 8, 5, 14, 8];",
  // Below this zoom the discs are merged, so whichever feature sits under the
  // cursor is arbitrary and a click zooms in rather than guessing a beach. At or
  // above it one disc is one beach and a click navigates. It is also the zoom the
  // map opens at once a user location is resolved, so a located visitor can click
  // straight through.
  "  const PICK_MIN_ZOOM = 9;",
  // Fit the whole fetched set only when there is no explicit data-center; the
  // resolved user/IP center always wins. Re-read the live center rather than the
  // init snapshot, so a geolocation swap that lands while the geojson fetch is in
  // flight is not overridden by a whole-region fitBounds.
  "  const fitToFeatures = function (fc) {",
  "    if (readCenter()) { return; }",
  "    if (!fc || !fc.features || !fc.features.length) { return; }",
  "    const bounds = new maplibre.LngLatBounds();",
  "    let extended = 0;",
  "    for (let i = 0; i < fc.features.length; i++) {",
  "      const g = fc.features[i] && fc.features[i].geometry;",
  "      if (!g || !g.coordinates) { continue; }",
  "      const lon = Number(g.coordinates[0]);",
  "      const lat = Number(g.coordinates[1]);",
  "      if (!isFinite(lon) || !isFinite(lat)) { continue; }",
  "      bounds.extend([lon, lat]);",
  "      extended = extended + 1;",
  "    }",
  "    if (extended > 0) {",
  "      try { map.fitBounds(bounds, { padding: 40, maxZoom: 10, animate: false }); } catch (e) {}",
  "    }",
  "  };",
  // Add the unclustered source and its four highlight layers, then wire the
  // click/cursor handlers. The source carries every beach at every zoom: the
  // zoomed-out view is a rendering choice, not a thinned dataset.
  "  const addBeachLayers = function (fc) {",
  "    try {",
  "      map.addSource('beaches', { type: 'geojson', data: fc });",
  "    } catch (e) { return; }",
  "    const beforeId = firstSymbolLayerId();",
  "    for (let i = 0; i < HIGHLIGHT_LAYERS.length; i++) {",
  "      try {",
  "        map.addLayer({",
  "          id: 'highlight-' + HIGHLIGHT_LAYERS[i].key,",
  "          type: 'circle',",
  "          source: 'beaches',",
  "          filter: HIGHLIGHT_LAYERS[i].filter,",
  "          paint: {",
  "            'circle-color': resolveFlagHex(HIGHLIGHT_LAYERS[i].key),",
  "            'circle-radius': HIGHLIGHT_RADIUS,",
  "            'circle-blur': 0,",
  "            'circle-opacity': 1",
  "          }",
  "        }, beforeId);",
  "      } catch (e) {}",
  "    }",
  // One click handler, split on PICK_MIN_ZOOM: zoom into a merged highlight,
  // navigate from a disc that stands alone.
  "    const highlightIds = HIGHLIGHT_LAYERS.map(function (h) { return 'highlight-' + h.key; });",
  "    highlightIds.forEach(function (layerId) {",
  "      map.on('click', layerId, function (e) {",
  "        if (map.getZoom() < PICK_MIN_ZOOM) {",
  "          map.easeTo({ center: e.lngLat, zoom: PICK_MIN_ZOOM });",
  "          return;",
  "        }",
  "        if (!e.features || !e.features.length) { return; }",
  "        const id = e.features[0].properties.id;",
  "        if (id === undefined || id === null) { return; }",
  "        window.location.href = '/beach/' + encodeURIComponent(id);",
  "      });",
  "      map.on('mouseenter', layerId, function () { map.getCanvas().style.cursor = 'pointer'; });",
  "      map.on('mouseleave', layerId, function () { map.getCanvas().style.cursor = ''; });",
  "    });",
  "  };",
  // startMap runs once the dynamic import below resolves: it constructs the map
  // and wires the lifecycle. readCenter() is called here, not at parse time, so a
  // geolocation swap that lands while the module is still downloading is picked
  // up by the construction itself.
  "  const startMap = function (mod) {",
  "    maplibre = mod;",
  "    const initialCenter = readCenter();",
  "    try {",
  "      map = new maplibre.Map({",
  "        container: container,",
  "        style: 'https://tiles.openfreemap.org/styles/positron',",
  "        center: initialCenter ? initialCenter.center : DEFAULT_CENTER,",
  "        zoom: initialCenter ? initialCenter.zoom : DEFAULT_ZOOM,",
  // keyboard: false disables MapLibre's KeyboardHandler so the visual-only map
  // never captures arrow/+/- keys; it is not in the tab order to begin with.
  "        keyboard: false,",
  // The compact attribution control's <a href> links are populated
  // asynchronously, on styledata after construction, so they would become
  // focusable descendants of the aria-hidden mount at a lifecycle point no
  // synchronous sweep could reach. OpenFreeMap's required OpenStreetMap credit is
  // rendered as static footer text instead (renderFooter in render.js).
  "        attributionControl: false",
  "      });",
  "    } catch (e) {",
  "      clearSkeleton();",
  "      return;",
  "    }",
  // MapLibre 6 reports a failed GPU/WebGL2 context through the map's 'error'
  // event (GPUInitializationError) rather than throwing out of the constructor,
  // so the try/catch above does not cover the browser-cannot-render case.
  // Listening keeps that, and any tile/source error, a logged no-op.
  "    map.on('error', function (e) {",
  "      clearSkeleton();",
  "      console.log('map error: ' + ((e && e.error && e.error.message) || 'unknown'));",
  "    });",
  // The canvas is the only always-present focusable-ish node; keep it out of the
  // tab order.
  "    try { map.getCanvas().setAttribute('tabindex', '-1'); } catch (e) {}",
  // Safety net for the basemap style's own sprite icons, the only icon-images
  // left on this map: an unregistered one gets a 1px transparent placeholder, so
  // MapLibre neither throws nor spams the console.
  // MapLibre 6 made 'styleimagemissing' notify-only, so a listener cannot satisfy
  // the request it is told about and the net has to be a missing-image resolver,
  // which is awaited before the image is given up on.
  "    try {",
  "      map.setMissingStyleImageResolver(function (id) {",
  "        if (map.hasImage(id)) { return; }",
  "        try { map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) }); } catch (err) {}",
  "      });",
  "    } catch (e) {}",
  "    map.on('load', function () {",
  // This handler only removes the placeholder and fetches the beach directory
  // once the style is ready; the focusable sweep already ran synchronously at
  // construction.
  "      clearSkeleton();",
  "      if (typeof fetch === 'undefined') { return; }",
  "      fetch(GEOJSON_URL, { headers: { 'Accept': 'application/geo+json' } }).then(function (resp) {",
  "        return resp && resp.ok ? resp.json() : null;",
  "      }).then(function (fc) {",
  "        if (!fc || !Array.isArray(fc.features)) { return; }",
  "        addBeachLayers(fc);",
  "        fitToFeatures(fc);",
  "      }).catch(function () {});",
  "    });",
  "  };",
  // Proximity swap (geoScript.js): a pure re-center on the updated data-center,
  // with no refetch or rebuild. Registered at parse time, before the import
  // resolves, so it is never missed; a swap that arrives with no map yet is
  // dropped, because startMap's own readCenter() picks that same live attribute
  // up at construction.
  "  document.addEventListener('swimreport:nearupdate', function () {",
  "    if (!map) { return; }",
  "    const updated = readCenter();",
  "    if (updated) {",
  "      try {",
  "        map.easeTo({ center: updated.center, zoom: updated.zoom });",
  "      } catch (e) {}",
  "    }",
  "  });",
  // import() works in a classic script, keeps the failure path silent, and never
  // blocks the parser.
  "  import(MAPLIBRE_MODULE_URL).then(startMap).catch(clearSkeleton);",
  "})();"
];

// moduleUrl is the version-pinned maplibre-gl.mjs URL, held in render.js next to
// the matching stylesheet pin so the two can never drift to different versions.
export function buildListMapScript(moduleUrl) {
  return [
    "(function () {",
    "  const MAPLIBRE_MODULE_URL = '" + moduleUrl + "';"
  ].concat(SCRIPT_LINES).join("\n");
}
