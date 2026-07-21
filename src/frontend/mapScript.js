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
// marker set can change with the location, not just the viewport. Everything
// degrades silently: a missing maplibregl global, a missing container, bad or
// empty JSON, or any MapLibre throw simply leaves the page with its
// (server-rendered) beach list.

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
  // Rebuilds the marker layer from a beaches array: every previously added
  // marker is removed first so a nearupdate swap never strands stale flags.
  "  let activeMarkers = [];",
  "  const renderMarkers = function (beaches) {",
  "    for (let i = 0; i < activeMarkers.length; i++) {",
  "      try { activeMarkers[i].remove(); } catch (e) {}",
  "    }",
  "    activeMarkers = [];",
  "    const bounds = new maplibregl.LngLatBounds();",
  "    let markerCount = 0;",
  "    for (let i = 0; i < beaches.length; i++) {",
  "      const b = beaches[i];",
  "      if (!b) { continue; }",
  "      const lat = Number(b.lat);",
  "      const lon = Number(b.lon);",
  "      if (!isFinite(lat) || !isFinite(lon)) { continue; }",
  // The tint class and the accessible label are computed server-side (the
  // shared flagIconColorClass / FLAG_ICON_LABELS in render.js) and ride in the
  // marker JSON, so this script never re-derives the icon or its color. The
  // <wa-icon name=\"flag\"> is the same component the rest of the UI uses; it
  // inherits the anchor's flag-icon-* color via currentColor.
  "      const iconClass = typeof b.iconClass === 'string' ? b.iconClass : 'flag-icon-unknown';",
  "      const label = typeof b.label === 'string' ? b.label : 'Flag';",
  "      const name = typeof b.name === 'string' ? b.name : '';",
  "      const el = document.createElement('a');",
  "      el.className = 'home-map-marker ' + iconClass;",
  "      el.setAttribute('href', '/beach/' + encodeURIComponent(b.id));",
  "      el.setAttribute('aria-label', name + ' \\u2014 ' + label);",
  "      el.setAttribute('title', name);",
  "      const icon = document.createElement('wa-icon');",
  "      icon.setAttribute('name', 'flag');",
  "      el.appendChild(icon);",
  "      let marker;",
  "      try {",
  "        marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([lon, lat]).addTo(map);",
  "      } catch (e) { continue; }",
  "      activeMarkers.push(marker);",
  "      bounds.extend([lon, lat]);",
  "      markerCount = markerCount + 1;",
  "    }",
  "    return { bounds: bounds, count: markerCount };",
  "  };",
  "  const initial = renderMarkers(readMarkerData());",
  "  if (!initialCenter && initial.count > 0) {",
  "    try {",
  "      map.fitBounds(initial.bounds, { padding: 40, maxZoom: 10, animate: false });",
  "    } catch (e) {}",
  "  }",
  "  document.addEventListener('swimreport:nearupdate', function () {",
  "    renderMarkers(readMarkerData());",
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
