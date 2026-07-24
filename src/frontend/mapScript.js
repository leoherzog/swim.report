// Pure module: exports the literal text of the inline, client-side map script
// used on the beach list (home) page. This code RUNS IN THE BROWSER, not in the
// Worker. It still follows project style rules: const/let only, never var, no
// template literals / backticks, console.log for logging.
//
// Behavior: build a MapLibre GL map with the OpenFreeMap positron style, then
// fetch EVERY flag-worthy beach ONCE from the cacheable /api/beaches.geojson
// endpoint and hand the FeatureCollection to a native clustered GeoJSON source.
// Zoomed out, beaches collapse into neutral count bubbles that expand on click;
// zoomed in, each beach is a rasterized fa-flag icon tinted by its `flag`
// keyword (green|yellow|red|unknown) to the EXACT flag-icon-* palette (the WA
// tokens are resolved at runtime so the map matches the rest of the UI, with the
// mild-palette hexes only as a fallback). Clicking a flag navigates to
// /beach/:id; clicking a cluster zooms to expand it.
//
// Centering precedence: the container's data-center attribute (the resolved user
// location — a browser fix or Cloudflare's IP estimate — at zoom 10 when
// data-center-precise is "1", else zoom 9) -> fitBounds over all fetched
// features (padding 40, maxZoom 10) -> the Great Lakes default center [-84, 44]
// at zoom 5. A "swimreport:nearupdate" CustomEvent on document (dispatched by
// geoScript.js after its in-place proximity swap) makes the LIVE map re-read the
// updated data-center and ease to it — the source already holds every beach, so
// nothing is refetched or rebuilt, it is a pure re-center.
//
// Accessibility: the map is a purely visual supplement — the search box +
// results list is the complete accessible path (it covers the full flag-worthy
// table server-side). So MapLibre keyboard handling is disabled (keyboard:
// false), the container is aria-hidden (set server-side in render.js) and kept
// out of the tab order, and the canvas is set to tabindex -1 at construction. No
// focusable control chrome is ever added — attributionControl is disabled (its
// links populate asynchronously and would otherwise become focusable inside the
// aria-hidden mount; OpenFreeMap's OSM credit lives in the static footer instead)
// and no NavigationControl is added — so the aria-hidden subtree holds no
// focusable node at any lifecycle point, tile load or not.
//
// Everything degrades silently: a missing maplibregl global, a missing
// container, an init throw, or a missing/failed/empty GeoJSON fetch simply
// leaves the page with its (server-rendered) beach list.

const SCRIPT_LINES = [
  "(function () {",
  "  if (typeof maplibregl === 'undefined') {",
  "    return;",
  "  }",
  "  const container = document.getElementById('home-map');",
  "  if (!container) {",
  "    return;",
  "  }",
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
  "  const initialCenter = readCenter();",
  "  let map;",
  "  try {",
  "    map = new maplibregl.Map({",
  "      container: container,",
  "      style: 'https://tiles.openfreemap.org/styles/positron',",
  "      center: initialCenter ? initialCenter.center : DEFAULT_CENTER,",
  "      zoom: initialCenter ? initialCenter.zoom : DEFAULT_ZOOM,",
  // keyboard: false disables MapLibre's KeyboardHandler so the visual-only map
  // never captures arrow/+/- keys; it is not in the tab order to begin with.
  "      keyboard: false,",
  // attributionControl: false — the compact control's attribution <a href> links
  // are populated asynchronously (on styledata, after construction), so they would
  // become focusable descendants of the aria-hidden mount at a lifecycle point no
  // synchronous sweep could reach. Disabling it leaves the map with NO focusable
  // control chrome ever; OpenFreeMap's required OpenStreetMap credit is rendered
  // as static footer text instead (renderFooter in render.js).
  "      attributionControl: false",
  "    });",
  "  } catch (e) {",
  "    return;",
  "  }",
  // The canvas is the only always-present focusable-ish node; keep it out of the
  // tab order. With no attribution control (and no NavigationControl), it is the
  // whole story — the aria-hidden mount holds no focusable node at any lifecycle
  // point, before or permanently without tile load.
  "  try { map.getCanvas().setAttribute('tabindex', '-1'); } catch (e) {}",
  // The four flag tint hexes: resolve the live WA palette tokens so the map
  // matches the rest of the UI exactly, falling back to the mild-palette hexes
  // only if resolution yields an empty string. The tint is resolved ONCE at init
  // and rasterized into the icon images; a later light/dark toggle does not
  // re-tint them (a rare cosmetic not worth a MutationObserver).
  "  const FLAG_HEX_FALLBACK = { green: '#4f8051', yellow: '#c6ad4f', red: '#cf443b', unknown: '#777478' };",
  "  const FLAG_TOKEN = {",
  "    green: '--wa-color-green-50',",
  "    yellow: '--wa-color-yellow-70',",
  "    red: '--wa-color-red-50',",
  "    unknown: '--wa-color-gray-50'",
  "  };",
  "  const resolveFlagHex = function (key) {",
  "    let v = '';",
  "    try {",
  "      v = getComputedStyle(document.documentElement).getPropertyValue(FLAG_TOKEN[key]).trim();",
  "    } catch (e) {}",
  "    return v || FLAG_HEX_FALLBACK[key];",
  "  };",
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
  // Register the four pre-tinted images BEFORE any layer references them. Decode
  // is async, so the layers are gated behind this Promise. Resolves regardless
  // of success — a decode failure leaves the styleimagemissing net below.
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
  // Safety net: if a layer ever references an unregistered icon-image, register a
  // 1px transparent placeholder so MapLibre neither throws nor spams the console.
  "  try {",
  "    map.on('styleimagemissing', function (e) {",
  "      if (map.hasImage(e.id)) { return; }",
  "      try { map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); } catch (err) {}",
  "    });",
  "  } catch (e) {}",
  // Fit the whole fetched set only when there is no explicit data-center — the
  // resolved user/IP center always wins, matching the previous precedence. Re-read
  // the LIVE center (not just the init snapshot): a geolocation swap that lands
  // while the geojson fetch is in flight must not be overridden by a whole-region
  // fitBounds.
  "  const fitToFeatures = function (fc) {",
  "    if (readCenter()) { return; }",
  "    if (!fc || !fc.features || !fc.features.length) { return; }",
  "    const bounds = new maplibregl.LngLatBounds();",
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
  // Add the clustered source + its three layers (cluster circle, count label,
  // unclustered flag icon), then wire the click/cursor handlers. Called once,
  // after the images are registered and the FeatureCollection is in hand.
  "  const addBeachLayers = function (fc) {",
  "    try {",
  "      map.addSource('beaches', {",
  "        type: 'geojson',",
  "        data: fc,",
  "        cluster: true,",
  "        clusterRadius: 50,",
  "        clusterMaxZoom: 12",
  "      });",
  "    } catch (e) { return; }",
  "    try {",
  "      map.addLayer({",
  "        id: 'clusters',",
  "        type: 'circle',",
  "        source: 'beaches',",
  "        filter: ['has', 'point_count'],",
  "        paint: {",
  "          'circle-color': ['step', ['get', 'point_count'], '#5a8fc7', 25, '#4178b5', 100, '#2b5f9e'],",
  "          'circle-radius': ['step', ['get', 'point_count'], 14, 25, 18, 100, 24],",
  "          'circle-stroke-width': 2,",
  "          'circle-stroke-color': '#ffffff',",
  "          'circle-opacity': 0.9",
  "        }",
  "      });",
  "      map.addLayer({",
  "        id: 'cluster-count',",
  "        type: 'symbol',",
  "        source: 'beaches',",
  "        filter: ['has', 'point_count'],",
  "        layout: {",
  "          'text-field': ['get', 'point_count_abbreviated'],",
  "          'text-size': 13,",
  "          'text-font': ['Noto Sans Regular'],",
  "          'text-allow-overlap': true",
  "        },",
  "        paint: { 'text-color': '#ffffff' }",
  "      });",
  "      map.addLayer({",
  "        id: 'unclustered',",
  "        type: 'symbol',",
  "        source: 'beaches',",
  "        filter: ['!', ['has', 'point_count']],",
  "        layout: {",
  "          'icon-image': ['match', ['get', 'flag'],",
  "            'green', 'flag-green',",
  "            'yellow', 'flag-yellow',",
  "            'red', 'flag-red',",
  "            'flag-unknown'],",
  "          'icon-allow-overlap': true,",
  "          'icon-anchor': 'bottom'",
  "        }",
  "      });",
  "    } catch (e) {}",
  // Cluster click: expand to the zoom that splits it. getClusterExpansionZoom
  // returns a Promise in MapLibre v4+ (the callback form is gone), so use .then.
  "    map.on('click', 'clusters', function (e) {",
  "      if (!e.features || !e.features.length) { return; }",
  "      const clusterId = e.features[0].properties.cluster_id;",
  "      const coords = e.features[0].geometry.coordinates;",
  "      const src = map.getSource('beaches');",
  "      if (!src || typeof src.getClusterExpansionZoom !== 'function') { return; }",
  "      src.getClusterExpansionZoom(clusterId).then(function (zoom) {",
  "        map.easeTo({ center: coords, zoom: zoom });",
  "      }).catch(function () {});",
  "    });",
  // Unclustered flag click: navigate to the beach page.
  "    map.on('click', 'unclustered', function (e) {",
  "      if (!e.features || !e.features.length) { return; }",
  "      const id = e.features[0].properties.id;",
  "      if (id === undefined || id === null) { return; }",
  "      window.location.href = '/beach/' + encodeURIComponent(id);",
  "    });",
  // Pointer cursor over both interactive layers.
  "    ['clusters', 'unclustered'].forEach(function (layerId) {",
  "      map.on('mouseenter', layerId, function () { map.getCanvas().style.cursor = 'pointer'; });",
  "      map.on('mouseleave', layerId, function () { map.getCanvas().style.cursor = ''; });",
  "    });",
  "  };",
  "  map.on('load', function () {",
  // The canvas/focusable sweep runs synchronously at construction above (an
  // aria-hidden subtree must never hold a focusable node, even if tiles never
  // load); this handler only fetches the beach directory once the style is ready.
  "    if (typeof fetch === 'undefined') { return; }",
  "    addFlagImages().then(function () {",
  "      return fetch(GEOJSON_URL, { headers: { 'Accept': 'application/geo+json' } });",
  "    }).then(function (resp) {",
  "      return resp && resp.ok ? resp.json() : null;",
  "    }).then(function (fc) {",
  "      if (!fc || !Array.isArray(fc.features)) { return; }",
  "      addBeachLayers(fc);",
  "      fitToFeatures(fc);",
  "    }).catch(function () {});",
  "  });",
  // Proximity swap (geoScript.js): the source already holds every beach, so this
  // is a pure re-center on the updated data-center — no refetch, no rebuild.
  "  document.addEventListener('swimreport:nearupdate', function () {",
  "    const updated = readCenter();",
  "    if (updated) {",
  "      try {",
  "        map.easeTo({ center: updated.center, zoom: updated.zoom });",
  "      } catch (e) {}",
  "    }",
  "  });",
  "})();"
];

export const LIST_MAP_SCRIPT = SCRIPT_LINES.join("\n");
