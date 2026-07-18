// Pure module: exports the literal text of the inline, client-side color-scheme
// script embedded in the <head> of every page. This code RUNS IN THE BROWSER,
// not in the Worker. It still follows project style rules: const/let only,
// never var, no template literals / backticks.
//
// Behavior: Web Awesome themes ship both light and dark styles but never detect
// the visitor's preference themselves — the docs ("Detecting Color Scheme
// Preference" in the webawesome skill's customizing.md) say to do it at the
// application level by toggling the wa-dark class on <html>. Bare
// .wa-theme-matter already defaults to light, so only wa-dark is ever toggled;
// no explicit wa-light class is needed. The script MUST run as a blocking
// inline script early in <head>, before the theme stylesheets paint, so a
// dark-preference visitor never sees a light flash. It also subscribes to
// matchMedia change events so a live OS light/dark switch restyles the open
// page without a reload.

const SCRIPT_LINES = [
  "(function () {",
  "  const query = window.matchMedia('(prefers-color-scheme: dark)');",
  "  const applyScheme = function (dark) {",
  "    document.documentElement.classList.toggle('wa-dark', dark);",
  "  };",
  "  applyScheme(query.matches);",
  "  query.addEventListener('change', function (event) {",
  "    applyScheme(event.matches);",
  "  });",
  "})();"
];

export const COLOR_SCHEME_SCRIPT = SCRIPT_LINES.join("\n");
