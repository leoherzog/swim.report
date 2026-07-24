// Pure module: exports the literal text of the inline, client-side helper that
// merges a freshly server-rendered home-list document into the LIVE page in
// place. This code RUNS IN THE BROWSER, not in the Worker. It still follows
// project style rules: const/let only, never var, no template literals /
// backticks, console.log for logging.
//
// Both the geolocation upgrade (geoScript.js) and the live search
// (searchScript.js) fetch the same server-rendered "/" page for a new
// query/near and need to swap in exactly the pieces the parameters change. This
// helper single-sources that swap so the two callers can never diverge on the
// invariants: the #beach-list-empty and #list-active-query nodes are updated by
// reference (innerHTML + style), NEVER replaced — searchScript.js captured
// #beach-list-empty at load, and replacing the node would strand that
// reference. The #home-map node is deliberately NOT touched here; the map has
// its own live MapLibre instance and its callers update it (its data-center
// attribute) or leave it alone as appropriate.
//
// window.__swimReportSwapList(doc) applies doc's #beach-list-items,
// #beach-list-empty (content + inline style), and #list-active-query (the
// stable always-present container holding the "Showing results for ..." line)
// onto the current page. Returns true on success, false when the core list
// nodes are missing so the caller can fall back (a full navigation).

const SCRIPT_LINES = [
  "(function () {",
  // Monotonic generation counter, bumped on every successful swap. The two
  // callers (geo upgrade, live search) each capture it before their fetch and
  // drop/re-run a response whose generation is stale, so a slow fetch from one
  // can never overwrite a newer swap from the other (e.g. the geolocation
  // upgrade landing on top of a search the user typed while it was pending).
  "  window.__swimReportListGen = window.__swimReportListGen || 0;",
  "  window.__swimReportSwapList = function (doc) {",
  "    const nextList = doc.getElementById('beach-list-items');",
  "    const currentList = document.getElementById('beach-list-items');",
  "    if (!nextList || !currentList) {",
  "      return false;",
  "    }",
  "    currentList.innerHTML = nextList.innerHTML;",
  // Update the empty state IN PLACE (innerHTML + inline style), never replace
  // the node: searchScript.js captured #beach-list-empty by reference at load.
  "    const nextEmpty = doc.getElementById('beach-list-empty');",
  "    const currentEmpty = document.getElementById('beach-list-empty');",
  "    if (nextEmpty && currentEmpty) {",
  "      currentEmpty.innerHTML = nextEmpty.innerHTML;",
  "      const emptyStyle = nextEmpty.getAttribute('style');",
  "      if (emptyStyle) {",
  "        currentEmpty.setAttribute('style', emptyStyle);",
  "      } else {",
  "        currentEmpty.removeAttribute('style');",
  "      }",
  "    }",
  // The active-query line ("Showing results for X. Clear search") is a stable,
  // always-present container so it can be swapped in place — its inner markup is
  // empty on the default listing and populated on a q-filtered page.
  "    const nextActive = doc.getElementById('list-active-query');",
  "    const currentActive = document.getElementById('list-active-query');",
  "    if (nextActive && currentActive) {",
  "      currentActive.innerHTML = nextActive.innerHTML;",
  "    }",
  "    window.__swimReportListGen = window.__swimReportListGen + 1;",
  "    return true;",
  "  };",
  "})();"
];

export const LIST_SWAP_SCRIPT = SCRIPT_LINES.join("\n");
