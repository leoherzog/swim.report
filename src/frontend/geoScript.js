// Exports the literal text of the inline geolocation script on the beach list
// page. It runs in the browser, not in the Worker.
//
// The page never asks for the visitor's position on its own. The request is
// made only when the visitor presses the "Use my location" button rendered in
// the end slot of the #beach-search input (#locate-me). The button is served
// with the hidden attribute and this script reveals it when the browser exposes
// navigator.geolocation, so a page without JS or without the API never shows a
// control that can do nothing.
//
// On a press the script asks for the position and upgrades the page in place:
// it fetches the same list URL with "?near=lat,lon", parses the response with
// DOMParser, and swaps in the server-rendered pieces the location changes. The
// server must re-select, because the nearest-100 set can differ and not merely
// its order. history.replaceState then rewrites the URL, a hidden "near" input
// is appended to (or updated in) the search form for the same reason, and a
// polite aria-live region announces the reorder. All rendering stays
// server-side in render.js; this script only moves finished HTML.
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
// The button is a <wa-button> and its loading attribute is set for the whole
// request, position prompt included, so a second press cannot start a second
// fetch. A denied or failed position request is logged and announced into the
// live region, and the IP-based ordering stays. A failed fetch or unexpected
// markup falls back to a full navigation (location.replace). Coordinates are
// rounded to 3 decimal places (~110 m), matching the rough distance labels
// while keeping precise coordinates out of URLs and server logs. An existing
// "near" param does not stop a press: a visitor who opened someone else's
// shared "?near=" link can still ask for their own position, and nothing runs
// without a press, so the script can never loop.

const SCRIPT_LINES = [
  "(function () {",
  "  const button = document.getElementById('locate-me');",
  "  if (!button || !('geolocation' in navigator)) {",
  "    return;",
  "  }",
  "  button.hidden = false;",
  "  const live = document.getElementById('geo-live-region');",
  "  const announce = function (text) {",
  "    if (live) {",
  "      live.textContent = text;",
  "    }",
  "  };",
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
  "  let pending = false;",
  "  const setPending = function (value) {",
  "    pending = value;",
  "    if (value) {",
  "      button.setAttribute('loading', '');",
  "    } else {",
  "      button.removeAttribute('loading');",
  "    }",
  "  };",
  "  const onPosition = function (pos) {",
  "    const lat = pos.coords.latitude;",
  "    const lon = pos.coords.longitude;",
  "    if (typeof lat !== 'number' || typeof lon !== 'number' ||",
  "        !isFinite(lat) || !isFinite(lon)) {",
  "      setPending(false);",
  "      return;",
  "    }",
  // Read the params fresh here, not at load: the visitor may have typed a search
  // before pressing, which live search reflected into the URL. Overlaying the
  // current search box value as q preserves that query instead of wiping it
  // back to the full list.
  "    const params = new URLSearchParams(window.location.search);",
  "    params.set('near', lat.toFixed(3) + ',' + lon.toFixed(3));",
  "    const searchInput = document.getElementById('beach-search');",
  // <wa-input> may not have upgraded yet, in which case only the
  // server-rendered attribute carries the query and the value property is
  // undefined.
  "    const rawQuery = !searchInput ? '' :",
  "      (typeof searchInput.value === 'string' ? searchInput.value : searchInput.getAttribute('value'));",
  "    const currentQuery = (rawQuery || '').trim();",
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
  // A second press updates the hidden input the first one appended.
  "      const form = document.getElementById('beach-search-form');",
  "      if (form) {",
  "        let hidden = form.querySelector('input[name=near]');",
  "        if (!hidden) {",
  "          hidden = document.createElement('input');",
  "          hidden.type = 'hidden';",
  "          hidden.name = 'near';",
  "          form.appendChild(hidden);",
  "        }",
  "        hidden.value = params.get('near');",
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
  "      announce('Beaches sorted by distance from your location.');",
  "      setPending(false);",
  "    }).catch(function (err) {",
  "      console.log('geo upgrade failed, falling back to reload: ' + err.message);",
  "      fallbackReload();",
  "    });",
  "  };",
  // The failure is logged rather than swallowed, because an already-granted
  // permission that still fails is otherwise indistinguishable from a fix that
  // simply lands near the IP estimate. It is also announced, since the visitor
  // asked for something and the list visibly did nothing.
  "  const onPositionError = function (err) {",
  "    console.log('geolocation unavailable (code ' + (err && err.code) + '): ' +",
  "      ((err && err.message) || 'no detail') + ' — keeping IP-based ordering');",
  "    announce('Your location is unavailable.');",
  "    setPending(false);",
  "  };",
  "  button.addEventListener('click', function () {",
  "    if (pending) {",
  "      return;",
  "    }",
  "    setPending(true);",
  "    navigator.geolocation.getCurrentPosition(onPosition, onPositionError,",
  "      { maximumAge: 300000, timeout: 10000 });",
  "  });",
  "})();"
];

export const LIST_GEO_SCRIPT = SCRIPT_LINES.join("\n");
