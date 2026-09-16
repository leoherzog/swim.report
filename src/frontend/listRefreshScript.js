// Exports the literal text of the inline consumer that keeps the beach list
// current between reloads. It runs in the browser, not in the Worker.
//
// On every "swimreport:refresh" (refreshScript.js) it fetches the list URL the
// page is showing, through the same cacheable "near"-carrying form live search
// uses (window.__swimReportListFetchUrl), and hands the parsed document to
// window.__swimReportSwapList, so the rows, the empty state and the active-query
// line move exactly as they do for a search or a geolocation upgrade and the
// client filters re-apply through "swimreport:listswap". The URL is never
// rewritten: the visitor's q and near stay whatever they were.
//
// Three things stop a swap. A fetch already in flight, so ticks never stack. A
// list generation that moved while the fetch was out, because a search or geo
// swap that landed meanwhile describes a different query than this response.
// And a response whose list fragment serializes identically to the one already
// on the page (window.__swimReportListHtml), so an unchanged list is not
// rebuilt under a visitor who may be reading it. Focus inside the list also
// defers the swap to the next tick, since replacing the rows would drop a
// keyboard user's position to the body, as does a text selection inside it. A
// failed fetch is logged and the page keeps what it has.

const SCRIPT_LINES = [
  "(function () {",
  "  if (typeof fetch === 'undefined' || typeof DOMParser === 'undefined') {",
  "    return;",
  "  }",
  "  let inflight = false;",
  "  document.addEventListener('swimreport:refresh', function () {",
  "    if (inflight || !window.__swimReportSwapList || !window.__swimReportListFetchUrl) {",
  "      return;",
  "    }",
  "    const listEl = document.getElementById('beach-list-items');",
  "    if (!listEl) {",
  "      return;",
  "    }",
  "    const url = window.__swimReportListFetchUrl(new URLSearchParams(window.location.search));",
  "    const genAtStart = window.__swimReportListGen || 0;",
  "    inflight = true;",
  "    fetch(url, { cache: 'no-cache' }).then(function (res) {",
  "      if (!res.ok) {",
  "        throw new Error('unexpected status ' + res.status);",
  "      }",
  "      return res.text();",
  "    }).then(function (html) {",
  "      if ((window.__swimReportListGen || 0) !== genAtStart) {",
  "        return;",
  "      }",
  "      const doc = new DOMParser().parseFromString(html, 'text/html');",
  "      const nextList = doc.getElementById('beach-list-items');",
  "      if (!nextList || nextList.innerHTML === window.__swimReportListHtml) {",
  "        return;",
  "      }",
  "      if (document.activeElement && listEl.contains(document.activeElement)) {",
  "        return;",
  "      }",
  "      const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;",
  "      if (sel && !sel.isCollapsed && sel.rangeCount > 0 &&",
  "          listEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {",
  "        return;",
  "      }",
  "      window.__swimReportSwapList(doc);",
  "    }).catch(function (err) {",
  "      console.log('list refresh failed: ' + err.message);",
  "    }).then(function () {",
  "      inflight = false;",
  "    });",
  "  });",
  "})();"
];

export const LIST_REFRESH_SCRIPT = SCRIPT_LINES.join("\n");
