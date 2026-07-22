// Pure module: exports the literal text of the inline, client-side map script
// used on the beach list (home) page. This code RUNS IN THE BROWSER, not in the
// Worker. It still follows project style rules: const/let only, never var, no
// template literals / backticks, console.log for logging.
//
// Behavior: read the embedded marker JSON (#home-map-data), build a MapLibre GL
// map with the OpenFreeMap positron style, and drop one clickable <a href> flag
// marker per beach. Centering precedence: the container's data-center attribute
// (the resolved user location — a browser fix or Cloudflare's IP estimate — at
// zoom 10 when data-center-precise is "1", else zoom 9) -> fitBounds over all
// markers (padding 40, maxZoom 10) -> the Great Lakes default center [-84, 44]
// at zoom 5. A "swimreport:nearupdate" CustomEvent on document (dispatched by
// geoScript.js after its in-place proximity swap) makes the LIVE map re-read
// the (updated) marker JSON and data-center: existing markers are removed, the
// new set is added, and the map eases to the new center — the nearest-100
// marker set can change with the location, not just the viewport.
//
// VIEWPORT LOADING: the embedded JSON is only the initial (nearest) set. On
// every 'load' and 'moveend' the script fetches /api/beaches?bbox=<current
// view> and ADDS any beach not already shown, so panning/zooming reveals every
// flag-worthy beach in view — markers accumulate (keyed by id, never
// duplicated) up to the whole directory. The fetch is debounced, single-flight
// with a trailing re-run, and skips a repeat of the last bbox. This still obeys
// the two-path rule: /api/beaches reads only D1 + KV.
//
// Everything degrades silently: a missing maplibregl global, a missing
// container, bad or empty JSON, a missing/failed fetch, or any MapLibre throw
// simply leaves the page with its (server-rendered) beach list.

const SCRIPT_LINES = [
  "(function () {",
  "  if (typeof maplibregl === 'undefined') {",
  "    return;",
  "  }",
  "  const container = document.getElementById('home-map');",
  "  if (!container) {",
  "    return;",
  "  }",
  // geoScript.js updates this tag's textContent in place (same node), so the
  // cached reference stays valid across a proximity swap.
  "  const dataTag = document.getElementById('home-map-data');",
  "  const readMarkerData = function () {",
  "    if (!dataTag) {",
  "      return [];",
  "    }",
  "    try {",
  "      const parsed = JSON.parse(dataTag.textContent);",
  "      return Array.isArray(parsed) ? parsed : [];",
  "    } catch (e) {",
  "      return [];",
  "    }",
  "  };",
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
  "  const initialCenter = readCenter();",
  "  let map;",
  "  try {",
  "    map = new maplibregl.Map({",
  "      container: container,",
  "      style: 'https://tiles.openfreemap.org/styles/positron',",
  "      center: initialCenter ? initialCenter.center : DEFAULT_CENTER,",
  "      zoom: initialCenter ? initialCenter.zoom : DEFAULT_ZOOM,",
  "      attributionControl: { compact: true }",
  "    });",
  "  } catch (e) {",
  "    return;",
  "  }",
  "  try {",
  "    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');",
  "  } catch (e) {}",
  // Keyed marker registry so viewport loads ACCUMULATE flags without ever
  // duplicating a beach already on the map: addMarkers is idempotent by id.
  // clearMarkers wipes the whole set and is used only by the proximity swap,
  // which rebuilds from a fresh nearest-set.
  "  const markersById = Object.create(null);",
  "  const clearMarkers = function () {",
  "    const ids = Object.keys(markersById);",
  "    for (let i = 0; i < ids.length; i++) {",
  "      try { markersById[ids[i]].remove(); } catch (e) {}",
  "      delete markersById[ids[i]];",
  "    }",
  "  };",
  // Adds a marker for each beach not already shown. Returns the bounds of the
  // NEWLY added markers plus how many were added (drives the initial fitBounds).
  "  const addMarkers = function (beaches) {",
  "    const bounds = new maplibregl.LngLatBounds();",
  "    let added = 0;",
  "    for (let i = 0; i < beaches.length; i++) {",
  "      const b = beaches[i];",
  "      if (!b) { continue; }",
  "      const id = b.id;",
  "      if (id === undefined || id === null || markersById[id]) { continue; }",
  "      const lat = Number(b.lat);",
  "      const lon = Number(b.lon);",
  "      if (!isFinite(lat) || !isFinite(lon)) { continue; }",
  // The tint class and the accessible label are computed server-side (the
  // shared markerFlagFields in render.js) and ride in the marker JSON / the
  // /api/beaches rows alike, so this script never re-derives the icon or its
  // color. The display name is the park name when set (embedded markers ship it
  // pre-coalesced as name; API rows carry park_name + name separately), so
  // b.park_name || b.name covers both sources. The <wa-icon name=\"flag\"> is the
  // same component the rest of the UI uses; it inherits the anchor's
  // flag-icon-* color via currentColor.
  "      const iconClass = typeof b.iconClass === 'string' ? b.iconClass : 'flag-icon-unknown';",
  "      const label = typeof b.label === 'string' ? b.label : 'Flag';",
  "      const name = b.park_name || b.name || '';",
  "      const el = document.createElement('a');",
  "      el.className = 'home-map-marker ' + iconClass;",
  "      el.setAttribute('href', '/beach/' + encodeURIComponent(id));",
  "      el.setAttribute('aria-label', name + ' \\u2014 ' + label);",
  "      el.setAttribute('title', name);",
  "      const icon = document.createElement('wa-icon');",
  "      icon.setAttribute('name', 'flag');",
  "      el.appendChild(icon);",
  "      let marker;",
  "      try {",
  "        marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([lon, lat]).addTo(map);",
  "      } catch (e) { continue; }",
  "      markersById[id] = marker;",
  "      bounds.extend([lon, lat]);",
  "      added = added + 1;",
  "    }",
  "    return { bounds: bounds, count: added };",
  "  };",
  "  const initial = addMarkers(readMarkerData());",
  "  if (!initialCenter && initial.count > 0) {",
  "    try {",
  "      map.fitBounds(initial.bounds, { padding: 40, maxZoom: 10, animate: false });",
  "    } catch (e) {}",
  "  }",
  // Viewport loading: fetch every flag-worthy beach in the current view and add
  // the ones not already shown. Debounced (one fetch 300 ms after the last
  // move), single-flight with a trailing re-run so a move during a fetch is not
  // lost, and skips a repeat of the identical bbox. lastBbox is cleared on any
  // failure so a transient error never permanently dedupes (and blanks) that
  // view — the next move retries it. An AbortController timeout guarantees the
  // chain always settles (clearing inFlight) even if a request hangs, so one
  // stuck fetch can't disable viewport loading for the rest of the session.
  "  const VIEWPORT_TIMEOUT_MS = 10000;",
  "  let viewportTimer = null;",
  "  let lastBbox = '';",
  "  let inFlight = false;",
  "  let pending = false;",
  "  const loadViewport = function () {",
  "    if (typeof fetch === 'undefined') { return; }",
  "    if (inFlight) { pending = true; return; }",
  "    let vb;",
  "    try { vb = map.getBounds(); } catch (e) { return; }",
  "    if (!vb) { return; }",
  "    const bbox = vb.getWest().toFixed(4) + ',' + vb.getSouth().toFixed(4) + ',' +",
  "      vb.getEast().toFixed(4) + ',' + vb.getNorth().toFixed(4);",
  "    if (bbox === lastBbox) { return; }",
  "    lastBbox = bbox;",
  "    inFlight = true;",
  "    let controller = null;",
  "    let timeoutId = null;",
  "    if (typeof AbortController !== 'undefined') {",
  "      controller = new AbortController();",
  "      timeoutId = setTimeout(function () { try { controller.abort(); } catch (e) {} }, VIEWPORT_TIMEOUT_MS);",
  "    }",
  "    fetch('/api/beaches?bbox=' + encodeURIComponent(bbox), controller ? { signal: controller.signal } : undefined)",
  "      .then(function (resp) { return resp && resp.ok ? resp.json() : null; })",
  "      .then(function (data) {",
  "        if (data && Array.isArray(data.beaches)) { addMarkers(data.beaches); }",
  "        else { lastBbox = ''; }",
  "      })",
  "      .catch(function () { lastBbox = ''; })",
  "      .then(function () {",
  "        if (timeoutId) { clearTimeout(timeoutId); }",
  "        inFlight = false;",
  "        if (pending) { pending = false; loadViewport(); }",
  "      });",
  "  };",
  "  const scheduleViewportLoad = function () {",
  "    if (viewportTimer) { clearTimeout(viewportTimer); }",
  "    viewportTimer = setTimeout(loadViewport, 300);",
  "  };",
  "  try {",
  "    map.on('moveend', scheduleViewportLoad);",
  "    map.on('load', scheduleViewportLoad);",
  "  } catch (e) {}",
  "  document.addEventListener('swimreport:nearupdate', function () {",
  "    clearMarkers();",
  // Force the next viewport load to run even if the view (hence bbox) does not
  // change: the markers were just wiped and must be repopulated.
  "    lastBbox = '';",
  "    addMarkers(readMarkerData());",
  "    const updated = readCenter();",
  "    if (updated) {",
  "      try {",
  "        map.easeTo({ center: updated.center, zoom: updated.zoom });",
  "      } catch (e) {}",
  "    }",
  "    scheduleViewportLoad();",
  "  });",
  "})();"
];

export const LIST_MAP_SCRIPT = SCRIPT_LINES.join("\n");
