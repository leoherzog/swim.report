// Exports the literal text of the inline scheduler that keeps an open page
// current without a reload. It runs in the browser, not in the Worker, and is
// embedded on both the list and the detail page.
//
// It does no fetching of its own. Every REFRESH_INTERVAL_MS while the tab is
// visible it dispatches "swimreport:refresh" on document, and the consumers
// registered on each page (listRefreshScript.js, detailRefreshScript.js,
// mapScript.js, favoritesScript.js) fetch what they own and swap it in place.
// A hidden tab skips its ticks and fires once on the next visibilitychange or
// bfcache pageshow if an interval has passed since the last tick, so a visitor
// coming back to a tab sees current data at once rather than at the next tick.
//
// The interval is five minutes: the alerts refresh cron moves a color every
// ten minutes and the edge cache bounds a served page at two minutes old, so a
// finer cadence would spend requests without seeing a change sooner. Each tick
// costs one cacheable request per consumer on the page.

export const REFRESH_INTERVAL_MS = 300000;

const SCRIPT_LINES = [
  "(function () {",
  "  if (typeof CustomEvent === 'undefined') {",
  "    return;",
  "  }",
  "  const INTERVAL_MS = " + String(REFRESH_INTERVAL_MS) + ";",
  "  let lastAt = Date.now();",
  "  let timer = null;",
  // A hidden tab's tick is skipped rather than deferred: lastAt stays where it
  // was, so the visibility handler below fires the moment the tab is due.
  "  const tick = function () {",
  "    if (document.visibilityState !== 'hidden') {",
  "      fire();",
  "    }",
  "  };",
  // Every fire re-arms the interval, so a fire owed to a visibility change
  // starts a fresh interval rather than being followed early by the old one.
  "  const arm = function () {",
  "    if (timer !== null) {",
  "      clearInterval(timer);",
  "    }",
  "    timer = setInterval(tick, INTERVAL_MS);",
  "  };",
  "  const fire = function () {",
  "    lastAt = Date.now();",
  "    document.dispatchEvent(new CustomEvent('swimreport:refresh'));",
  "    arm();",
  "  };",
  "  const due = function () {",
  "    return Date.now() - lastAt >= INTERVAL_MS;",
  "  };",
  "  arm();",
  "  document.addEventListener('visibilitychange', function () {",
  "    if (document.visibilityState === 'visible' && due()) {",
  "      fire();",
  "    }",
  "  });",
  // A bfcache restore resumes the page with its timers intact and its data as
  // old as when it was left.
  "  window.addEventListener('pageshow', function (event) {",
  "    if (event && event.persisted && due()) {",
  "      fire();",
  "    }",
  "  });",
  "})();"
];

export const LIVE_REFRESH_SCRIPT = SCRIPT_LINES.join("\n");
