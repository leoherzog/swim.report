// Exports the literal text of the inline color-scheme script embedded in the
// <head> of every page. It runs in the browser, not in the Worker.
//
// Web Awesome themes ship both light and dark styles but do not detect the
// visitor's preference, so the application toggles the wa-dark class on <html>;
// bare .wa-theme-matter already defaults to light, so no wa-light class exists.
// The script has to be a blocking inline script early in <head>, before the
// theme stylesheets paint, or a dark-preference visitor sees a light flash. It
// also subscribes to matchMedia change events so a live OS switch restyles the
// open page without a reload.

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
