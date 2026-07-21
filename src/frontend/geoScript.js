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
// marker JSON + center attributes — then rewrite the URL with
// history.replaceState so refreshes, copied links, and search submits keep the
// proximity sort. A hidden "near" input is appended to the search form for the
// same reason. After the swap a "swimreport:nearupdate" CustomEvent tells the
// already-running map script (mapScript.js) to re-center and rebuild its
// markers, and a polite aria-live region announces the reorder to screen
// readers. All rendering stays server-side (render.js string builders); this
// script only moves finished HTML.
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
  "  const params = new URLSearchParams(window.location.search);",
  "  if (params.get('near')) {",
  "    return;",
  "  }",
  "  navigator.geolocation.getCurrentPosition(function (pos) {",
  "    const lat = pos.coords.latitude;",
  "    const lon = pos.coords.longitude;",
  "    if (typeof lat !== 'number' || typeof lon !== 'number' ||",
  "        !isFinite(lat) || !isFinite(lon)) {",
  "      return;",
  "    }",
  "    params.set('near', lat.toFixed(3) + ',' + lon.toFixed(3));",
  "    const nextUrl = '/?' + params.toString();",
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
  "      const nextList = doc.getElementById('beach-list-items');",
  "      const currentList = document.getElementById('beach-list-items');",
  "      if (!nextList || !currentList) {",
  "        fallbackReload();",
  "        return;",
  "      }",
  "      currentList.innerHTML = nextList.innerHTML;",
  // Update the empty state IN PLACE (innerHTML + inline style), never replace
  // the node: searchScript.js captured #beach-list-empty by reference at load.
  "      const nextEmpty = doc.getElementById('beach-list-empty');",
  "      const currentEmpty = document.getElementById('beach-list-empty');",
  "      if (nextEmpty && currentEmpty) {",
  "        currentEmpty.innerHTML = nextEmpty.innerHTML;",
  "        const emptyStyle = nextEmpty.getAttribute('style');",
  "        if (emptyStyle) {",
  "          currentEmpty.setAttribute('style', emptyStyle);",
  "        } else {",
  "          currentEmpty.removeAttribute('style');",
  "        }",
  "      }",
  "      const form = document.getElementById('beach-search-form');",
  "      if (form && !form.querySelector('input[name=near]')) {",
  "        const hidden = document.createElement('input');",
  "        hidden.type = 'hidden';",
  "        hidden.name = 'near';",
  "        hidden.value = params.get('near');",
  "        form.appendChild(hidden);",
  "      }",
  "      const nextClear = doc.querySelector('.clear-search');",
  "      const currentClear = document.querySelector('.clear-search');",
  "      if (nextClear && currentClear) {",
  "        currentClear.setAttribute('href', nextClear.getAttribute('href'));",
  "      }",
  // Refresh the map's data in place: new marker JSON into the (same, cached-
  // by-reference) #home-map-data tag, new center onto the container, then the
  // CustomEvent below tells mapScript.js to re-read both. The #home-map node
  // itself is never replaced — that would destroy the live MapLibre instance.
  "      const nextMapData = doc.getElementById('home-map-data');",
  "      const currentMapData = document.getElementById('home-map-data');",
  "      if (nextMapData && currentMapData) {",
  "        currentMapData.textContent = nextMapData.textContent;",
  "      }",
  "      const nextMap = doc.getElementById('home-map');",
  "      const currentMap = document.getElementById('home-map');",
  "      if (nextMap && currentMap) {",
  "        const center = nextMap.getAttribute('data-center');",
  "        if (center) {",
  "          currentMap.setAttribute('data-center', center);",
  "          currentMap.setAttribute('data-center-precise', '1');",
  "        }",
  "      }",
  "      window.history.replaceState(null, '', nextUrl);",
  "      document.dispatchEvent(new CustomEvent('swimreport:nearupdate'));",
  "      const live = document.getElementById('geo-live-region');",
  "      if (live) {",
  "        live.textContent = 'Beaches sorted by distance from your location.';",
  "      }",
  "    }).catch(function (err) {",
  "      console.log('geo upgrade failed, falling back to reload: ' + err.message);",
  "      fallbackReload();",
  "    });",
  "  }, function () {}, { maximumAge: 300000, timeout: 10000 });",
  "})();"
];

export const LIST_GEO_SCRIPT = SCRIPT_LINES.join("\n");
