// Exports the literal text of the inline geolocation script on the beach list
// page. It runs in the browser, not in the Worker.
//
// With no "near" param in the URL, the script asks for the visitor's position
// and upgrades the page in place: it fetches the same list URL with
// "?near=lat,lon", parses the response with DOMParser, and swaps in the
// server-rendered pieces the location changes. The server must re-select,
// because the nearest-100 set can differ and not merely its order.
// history.replaceState then rewrites the URL, a hidden "near" input is appended
// to the search form for the same reason, and a polite aria-live region
// announces the reorder. All rendering stays server-side in render.js; this
// script only moves finished HTML.
//
// The map re-center is decoupled from that list fetch. The browser fix is
// authoritative the moment it arrives and is all the map needs, since
// mapScript.js's GeoJSON source already holds every beach. So applyMapCenter()
// writes the rounded fix onto #home-map's data-center and dispatches
// "swimreport:nearupdate" immediately in the position callback, before the
// "/?near=" round-trip, and again after the swap with the server-rendered value.
// Waiting for the fetch would strand the map on the coarse Cloudflare IP
// estimate, and a fetch failure would strand it there until the fallback reload
// painted. Writing the attribute before dispatching also covers the load-order
// race where maplibre-gl.js has not finished loading: mapScript.js reads
// data-center at construction, so it picks up the fix even when it missed the
// event.
//
// Everything degrades silently to IP-based ordering, and a failed fetch or
// unexpected markup falls back to a full navigation (location.replace).
// Coordinates are rounded to 3 decimal places (~110 m), matching the rough
// distance labels while keeping precise coordinates out of URLs and server logs.
// An existing "near" param short-circuits the whole script, so the upgrade
// happens at most once per visit and can never loop.

const SCRIPT_LINES = [
  "(function () {",
  "  if (!('geolocation' in navigator)) {",
  "    return;",
  "  }",
  "  if (new URLSearchParams(window.location.search).get('near')) {",
  "    return;",
  "  }",
  // Point the live map at a "lat,lon" center and tell mapScript.js to ease over.
  // The attribute is written before the event so a map script that has not run
  // yet still reads the fix at construction.
  "  const applyMapCenter = function (center) {",
  "    const mapEl = document.getElementById('home-map');",
  "    if (!mapEl || !center) {",
  "      return;",
  "    }",
  "    mapEl.setAttribute('data-center', center);",
  "    mapEl.setAttribute('data-center-precise', '1');",
  "    document.dispatchEvent(new CustomEvent('swimreport:nearupdate'));",
  "  };",
  "  navigator.geolocation.getCurrentPosition(function (pos) {",
  "    const lat = pos.coords.latitude;",
  "    const lon = pos.coords.longitude;",
  "    if (typeof lat !== 'number' || typeof lon !== 'number' ||",
  "        !isFinite(lat) || !isFinite(lon)) {",
  "      return;",
  "    }",
  // Read the params fresh here, not at load: the visitor may have typed a search
  // during the permission prompt, which live search reflected into the URL.
  // Overlaying the current search box value as q preserves that query instead of
  // wiping it back to the full list.
  "    const params = new URLSearchParams(window.location.search);",
  "    params.set('near', lat.toFixed(3) + ',' + lon.toFixed(3));",
  "    const searchInput = document.getElementById('beach-search');",
  "    const currentQuery = searchInput ? searchInput.value.trim() : '';",
  "    if (currentQuery) {",
  "      params.set('q', currentQuery);",
  "    } else {",
  "      params.delete('q');",
  "    }",
  "    const nextUrl = '/?' + params.toString();",
  // Re-center on the fix itself: the map needs nothing from the list response,
  // so it must not wait on the fetch or be lost to its failure.
  "    applyMapCenter(params.get('near'));",
  "    const fallbackReload = function () {",
  "      window.location.replace(nextUrl);",
  "    };",
  "    fetch(nextUrl).then(function (res) {",
  "      if (!res.ok) {",
  "        throw new Error('unexpected status ' + res.status);",
  "      }",
  "      return res.text();",
  "    }).then(function (html) {",
  "      const doc = new DOMParser().parseFromString(html, 'text/html');",
  // A false return means the core list nodes were missing, so fall back to a
  // full navigation.
  "      if (!window.__swimReportSwapList || !window.__swimReportSwapList(doc)) {",
  "        fallbackReload();",
  "        return;",
  "      }",
  "      const form = document.getElementById('beach-search-form');",
  "      if (form && !form.querySelector('input[name=near]')) {",
  "        const hidden = document.createElement('input');",
  "        hidden.type = 'hidden';",
  "        hidden.name = 'near';",
  "        hidden.value = params.get('near');",
  "        form.appendChild(hidden);",
  "      }",
  // Re-apply the server's own data-center for the same fix. Normally a no-op
  // (both are the same 3 dp rounding), it stands as the authoritative reconcile
  // if the server ever resolves a center differently than the raw fix. The
  // #home-map node itself is never replaced, which would destroy the live
  // MapLibre instance.
  "      const nextMap = doc.getElementById('home-map');",
  "      if (nextMap) {",
  "        applyMapCenter(nextMap.getAttribute('data-center'));",
  "      }",
  "      window.history.replaceState(null, '', nextUrl);",
  "      const live = document.getElementById('geo-live-region');",
  "      if (live) {",
  "        live.textContent = 'Beaches sorted by distance from your location.';",
  "      }",
  "    }).catch(function (err) {",
  "      console.log('geo upgrade failed, falling back to reload: ' + err.message);",
  "      fallbackReload();",
  "    });",
  // The failure is logged rather than swallowed, because an already-granted
  // permission that still fails is otherwise indistinguishable from a fix that
  // simply lands near the IP estimate.
  "  }, function (err) {",
  "    console.log('geolocation unavailable (code ' + (err && err.code) + '): ' +",
  "      ((err && err.message) || 'no detail') + ' — keeping IP-based ordering');",
  "  }, { maximumAge: 300000, timeout: 10000 });",
  "})();"
];

export const LIST_GEO_SCRIPT = SCRIPT_LINES.join("\n");
