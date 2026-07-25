// Pure module: exports the literal text of the inline, client-side geolocation
// script used on the beach list page. This code RUNS IN THE BROWSER, not in the
// Worker. It still follows project style rules: const/let only, never var, no
// template literals / backticks.
//
// Behavior: on page load, when the URL has no "near" param yet, ask the browser
// for the visitor's position and upgrade the page IN PLACE: fetch the same list
// URL with "?near=lat,lon" appended, parse the response with DOMParser, and
// swap in the server-rendered pieces the location changes — the beach rows
// (the nearest-100 SET can differ, not just its order, so the server must
// re-select), the empty-state block, the "clear search" link, and the home-map
// container's data-center attribute — then rewrite the URL with
// history.replaceState so refreshes, copied links, and search submits keep the
// proximity sort. A hidden "near" input is appended to the search form for the
// same reason. A polite aria-live region announces the reorder to screen
// readers. All rendering stays server-side (render.js string builders); this
// script only moves finished HTML.
//
// The MAP re-center is deliberately DECOUPLED from that list fetch. The browser
// fix is authoritative for the center the moment it arrives, and the fix itself
// is all the map needs (mapScript.js's GeoJSON source already holds every beach,
// so a re-center refetches and rebuilds nothing). So applyMapCenter() writes the
// rounded fix onto #home-map's data-center and dispatches the
// "swimreport:nearupdate" CustomEvent IMMEDIATELY in the position callback —
// before the "/?near=" round-trip — and again after the swap with the
// server-rendered value (identical, since both round to 3 dp). Waiting for the
// fetch would leave the map sitting on the coarse Cloudflare IP estimate for the
// whole request, and a fetch failure (which falls back to a full navigation)
// would leave it there until the reload painted. Writing the attribute before
// dispatching also covers the load-order race where maplibre-gl.js has not
// finished loading yet: mapScript.js reads data-center at construction, so it
// picks up the fix even when it missed the event.
//
// Everything degrades silently to the existing IP-based ordering: no
// geolocation API, an insecure context, a denied prompt, or a timeout leave the
// page as-is, and a failed fetch or unexpected markup falls back to the old
// full navigation (location.replace) — the pre-swap behavior. Coordinates are
// rounded to 3 decimal places (~110 m) — matching the rough "~12 mi" distance
// labels while keeping precise coordinates out of URLs and server logs. An
// existing "near" param (from a previous grant, riding along in links and form
// submits) short-circuits the whole script, so the upgrade happens at most once
// per visit and can never loop.

const SCRIPT_LINES = [
  "(function () {",
  "  if (!('geolocation' in navigator)) {",
  "    return;",
  "  }",
  "  if (new URLSearchParams(window.location.search).get('near')) {",
  "    return;",
  "  }",
  // Point the live map at a "lat,lon" center and tell mapScript.js to ease over.
  // The attribute is written BEFORE the event so a map script that has not run
  // yet (maplibre-gl.js still loading) still reads the fix at construction.
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
  // Read the params FRESH here, not at load: the visitor may have typed a search
  // (which live search reflected into the URL via replaceState) during the
  // permission prompt. Overlay the current search box value as q so the upgrade
  // preserves an in-progress query instead of wiping it back to the full list.
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
  // Re-center NOW, on the fix itself — the map needs nothing from the list
  // response, so it must not wait on (or be lost to a failure of) the fetch.
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
  // Swap the list, empty state, and active-query line in place via the shared
  // helper (same merge the live search uses). A false return means the core list
  // nodes were missing, so fall back to a full navigation.
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
  // Re-apply the server's own data-center for the same fix. This is normally a
  // no-op re-center (both values are the same 3 dp rounding of the same
  // coordinates); it stands as the authoritative reconcile if the server ever
  // resolves a center differently than the raw fix. The #home-map node itself is
  // never replaced — that would destroy the live MapLibre instance — and the
  // source already holds every beach, so nothing is refetched or rebuilt.
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
  // A denied prompt, an unavailable position provider, or a timeout all leave
  // the page on its IP-ordered rendering — the documented degradation. It is
  // LOGGED rather than swallowed: an already-granted permission that still fails
  // (no location provider, a killed platform service) is otherwise
  // indistinguishable from a fix that simply lands near the IP estimate.
  "  }, function (err) {",
  "    console.log('geolocation unavailable (code ' + (err && err.code) + '): ' +",
  "      ((err && err.message) || 'no detail') + ' — keeping IP-based ordering');",
  "  }, { maximumAge: 300000, timeout: 10000 });",
  "})();"
];

export const LIST_GEO_SCRIPT = SCRIPT_LINES.join("\n");
