// Pure module: exports the literal text of the inline, client-side geolocation
// script used on the beach list page. This code RUNS IN THE BROWSER, not in the
// Worker. It still follows project style rules: const/let only, never var, no
// template literals / backticks.
//
// Behavior: on page load, when the URL has no "near" param yet, ask the browser
// for the visitor's position and reload the list with "?near=lat,lon" so the
// server's proximity sort (PLAN.md section 8) upgrades from IP-derived
// request.cf coordinates to real browser geolocation. Everything degrades
// silently to the existing IP-based ordering: no geolocation API, an insecure
// context, a denied prompt, or a timeout all simply leave the page as-is.
// Coordinates are rounded to 3 decimal places (~110 m) — matching the rough
// "~12 mi" distance labels while keeping precise coordinates out of URLs and
// server logs. An existing "near" param (from a previous grant, riding along in
// links and form submits) short-circuits the whole script, so the reload
// happens at most once per visit and can never loop.

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
  "    window.location.replace('/?' + params.toString());",
  "  }, function () {}, { maximumAge: 300000, timeout: 10000 });",
  "})();"
];

export const LIST_GEO_SCRIPT = SCRIPT_LINES.join("\n");
