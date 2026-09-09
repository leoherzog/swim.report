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
// Everything degrades to the server-rendered beach list: a failed module import,
// a missing container, a GPU/WebGL2 failure or init throw, or a missing, failed
// or empty GeoJSON fetch. Every one of those but the module import logs a named
// console line, because a blank map area and a map that never got its data look
// identical from the outside. The server-rendered
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
  // A custom property whose own value is a var() reference does not always come
  // back substituted: an engine that cannot resolve the reference may return the
  // literal "var(--wa-color-green-50)" rather than an empty string, and the kit
  // stylesheets those tokens live in are a third-party CDN that can be slow,
  // blocked or unreachable. That string is fatal as a paint color — addLayer
  // throws on it and the layer never renders — so anything still carrying a
  // var() is treated as unresolved and takes the fallback hex.
  //
  // The computed value of a custom property is a token stream, and Firefox
  // keeps comments in it while Chrome drops them: the kit declares each palette
  // token as a hex followed by an oklch comment, so the resolved value arrives
  // as "#4f8051 /* oklch(...) */" and is equally fatal to addLayer. Strip any
  // comment before the var() check.
  "  const stripCssComments = function (s) {",
  "    let out = s;",
  "    let open = out.indexOf('/*');",
  "    while (open !== -1) {",
  "      const close = out.indexOf('*/', open + 2);",
  "      out = close === -1 ? out.slice(0, open) : (out.slice(0, open) + ' ' + out.slice(close + 2));",
  "      open = out.indexOf('/*');",
  "    }",
  "    return out.trim();",
  "  };",
  "  const resolveFlagHex = function (key) {",
  "    let v = '';",
  "    try {",
  "      v = stripCssComments(getComputedStyle(document.documentElement).getPropertyValue(FLAG_TOKEN[key]));",
  "    } catch (e) {}",
  "    if (!v || v.indexOf('var(') !== -1) {",
  "      return FLAG_HEX_FALLBACK[key];",
  "    }",
  "    return v;",
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
  // The handoff zoom, in three roles: the discs stop being a ribbon and become
  // markers, the flag icons start fading in, and a click stops zooming in and
  // starts navigating. Below it the discs are merged, so whichever feature sits
  // under the cursor is arbitrary and guessing a beach from it would be a coin
  // flip. It is also the zoom the map opens at once a user location is resolved,
  // so a located visitor lands on flags and can click straight through.
  //
  // Declared before the ramps below, which read them: these are emitted as plain
  // const declarations in one browser scope, so a ramp placed above them dies on
  // the temporal dead zone and takes the whole script with it.
  "  const PICK_MIN_ZOOM = 9;",
  "  const FLAG_FULL_ZOOM = 10;",
  // The radius peaks around zoom 6, where the discs have to be wide enough to
  // merge into a ribbon while the beaches under them are still spreading apart,
  // then narrows to a marker and collapses to nothing as the flags take over.
  // The radius is what changes with zoom, never circle-opacity: opacity applies
  // per feature, so two overlapping translucent discs of one color composite
  // into a darker third and the highlight would mottle wherever it is densest.
  // The flag layer has no such problem — its glyphs are thin and sparse — so it
  // fades in on icon-opacity over the same band.
  "  const HIGHLIGHT_RADIUS = ['interpolate', ['linear'], ['zoom'],",
  "    3, 4.5, 5, 4.5, 6, 6, 8, 5, PICK_MIN_ZOOM, 5, FLAG_FULL_ZOOM, 0];",
  "  const FLAG_OPACITY = ['interpolate', ['linear'], ['zoom'],",
  "    PICK_MIN_ZOOM, 0, FLAG_FULL_ZOOM, 1];",
  // The fa-flag single-path glyph. Explicit width/height give it an intrinsic
  // size so every browser rasterizes it (a viewBox-only SVG can draw blank).
  "  const FLAG_SVG =",
  "    \"<svg xmlns='http://www.w3.org/2000/svg' width='640' height='640' viewBox='0 0 640 640'>\" +",
  "    \"<path d='M160 96C160 78.3 145.7 64 128 64C110.3 64 96 78.3 96 96L96 544C96 561.7 110.3 576 128 576C145.7 576 160 561.7 160 544L160 422.4L222.7 403.6C264.6 391 309.8 394.9 348.9 414.5C391.6 435.9 441.4 438.5 486.1 421.7L523.2 407.8C535.7 403.1 544 391.2 544 377.8L544 130.1C544 107.1 519.8 92.1 499.2 102.4L487.4 108.3C442.5 130.8 389.6 130.8 344.6 108.3C308.2 90.1 266.3 86.5 227.4 98.2L160 118.4L160 96z'/>\" +",
  "    \"</svg>\";",
  "  const CSS_SIZE = 28;",
  "  const DPR = Math.max(1, Math.min(4, Math.round(window.devicePixelRatio || 1)));",
  // Paint the resolved hex into the glyph's own alpha via source-in compositing:
  // the tint is pixel-exact and the anti-aliased edges are preserved (no SDF).
  "  const tintToImageData = function (baseImg, hex) {",
  "    const w = CSS_SIZE * DPR;",
  "    const h = CSS_SIZE * DPR;",
  "    const canvas = document.createElement('canvas');",
  "    canvas.width = w;",
  "    canvas.height = h;",
  "    const ctx = canvas.getContext('2d');",
  "    ctx.clearRect(0, 0, w, h);",
  "    ctx.drawImage(baseImg, 0, 0, w, h);",
  "    ctx.globalCompositeOperation = 'source-in';",
  "    ctx.fillStyle = hex;",
  "    ctx.fillRect(0, 0, w, h);",
  "    ctx.globalCompositeOperation = 'source-over';",
  "    return ctx.getImageData(0, 0, w, h);",
  "  };",
  // Register the four pre-tinted images before any layer references them. Decode
  // is async, so the layers are gated behind this Promise, which resolves
  // regardless of success: a decode failure leaves the resolver net below.
  "  const addFlagImages = function () {",
  "    return new Promise(function (resolve) {",
  "      const img = new Image();",
  "      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(FLAG_SVG);",
  "      img.onload = function () {",
  "        const keys = ['green', 'yellow', 'red', 'unknown'];",
  "        for (let i = 0; i < keys.length; i++) {",
  "          const id = 'flag-' + keys[i];",
  "          try {",
  "            if (!map.hasImage(id)) {",
  "              map.addImage(id, tintToImageData(img, resolveFlagHex(keys[i])), { pixelRatio: DPR });",
  "            }",
  "          } catch (e) {}",
  "        }",
  "        resolve();",
  "      };",
  "      img.onerror = function () { resolve(); };",
  "      img.src = url;",
  "    });",
  "  };",
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
  "    } catch (e) {",
  "      console.log('map source failed: ' + ((e && e.message) || 'unknown'));",
  "      return;",
  "    }",
  "    const beforeId = firstSymbolLayerId();",
  "    for (let i = 0; i < HIGHLIGHT_LAYERS.length; i++) {",
  "      try {",
  "        map.addLayer({",
  "          id: 'highlight-' + HIGHLIGHT_LAYERS[i].key,",
  "          type: 'circle',",
  "          source: 'beaches',",
  "          maxzoom: FLAG_FULL_ZOOM,",
  "          filter: HIGHLIGHT_LAYERS[i].filter,",
  "          paint: {",
  "            'circle-color': resolveFlagHex(HIGHLIGHT_LAYERS[i].key),",
  "            'circle-radius': HIGHLIGHT_RADIUS,",
  "            'circle-blur': 0,",
  "            'circle-opacity': 1",
  "          }",
  "        }, beforeId);",
  "      } catch (e) {",
  "        console.log('map layer failed: highlight-' + HIGHLIGHT_LAYERS[i].key +",
  "          ' (' + ((e && e.message) || 'unknown') + ')');",
  "      }",
  "    }",
  "    try {",
  "      map.addLayer({",
  "        id: 'flags',",
  "        type: 'symbol',",
  "        source: 'beaches',",
  "        minzoom: PICK_MIN_ZOOM,",
  "        layout: {",
  "          'icon-image': ['match', ['get', 'flag'],",
  "            'green', 'flag-green',",
  "            'yellow', 'flag-yellow',",
  "            'red', 'flag-red',",
  "            'flag-unknown'],",
  "          'icon-allow-overlap': true,",
  "          'icon-anchor': 'bottom'",
  "        },",
  "        paint: {",
  "          'icon-opacity': FLAG_OPACITY",
  "        }",
  "      });",
  "    } catch (e) {",
  "      console.log('map layer failed: flags (' + ((e && e.message) || 'unknown') + ')');",
  "    }",
  // The highlight click is split on PICK_MIN_ZOOM: zoom into a merged ribbon,
  // navigate from a disc that stands alone. Above the handoff the flag layer
  // carries the same navigation, so both marks lead to the same page.
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
  "    map.on('click', 'flags', function (e) {",
  "      if (!e.features || !e.features.length) { return; }",
  "      const id = e.features[0].properties.id;",
  "      if (id === undefined || id === null) { return; }",
  "      window.location.href = '/beach/' + encodeURIComponent(id);",
  "    });",
  "    map.on('mouseenter', 'flags', function () { map.getCanvas().style.cursor = 'pointer'; });",
  "    map.on('mouseleave', 'flags', function () { map.getCanvas().style.cursor = ''; });",
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
  "      console.log('map init failed: ' + ((e && e.message) || 'unknown'));",
  "      return;",
  "    }",
  // A failed GPU/WebGL2 context (GPUInitializationError) throws out of the
  // constructor as of MapLibre 6.7.0, so the catch above is the browser-cannot-
  // render path and has to name it. The 'error' listener still covers every
  // tile, source and style failure after construction, which never throws there.
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
  "      addFlagImages().then(function () {",
  "        return fetch(GEOJSON_URL, { headers: { 'Accept': 'application/geo+json' } });",
  "      }).then(function (resp) {",
  "        return resp && resp.ok ? resp.json() : null;",
  "      }).then(function (fc) {",
  "        if (!fc || !Array.isArray(fc.features)) {",
  "          console.log('map directory unusable');",
  "          return;",
  "        }",
  "        console.log('map directory: ' + fc.features.length + ' features');",
  "        addBeachLayers(fc);",
  "        fitToFeatures(fc);",
  "      }).catch(function (e) {",
  "        console.log('map directory failed: ' + ((e && e.message) || 'unknown'));",
  "      });",
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
