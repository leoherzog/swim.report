// Exports the literal text of the inline helper that merges a freshly
// server-rendered home-list document into the live page. It runs in the
// browser, not in the Worker.
//
// The geolocation upgrade (geoScript.js) and the live search (searchScript.js)
// both fetch the same server-rendered "/" page, so the swap is single-sourced
// here. #beach-list-empty and #list-active-query are updated by reference
// (innerHTML + style) and never replaced: searchScript.js captured
// #beach-list-empty at load, and replacing the node strands that reference.
// #home-map is deliberately not touched. The map holds its own live MapLibre
// instance and its callers update it or leave it alone.
//
// window.__swimReportSwapList(doc) returns true on success, false when the core
// list nodes are missing so the caller can fall back to a full navigation.

const SCRIPT_LINES = [
  "(function () {",
  // Monotonic generation counter, bumped on every successful swap. Each caller
  // captures it before its fetch and drops a stale response, so a slow fetch
  // from one can never overwrite a newer swap from the other.
  "  window.__swimReportListGen = window.__swimReportListGen || 0;",
  "  window.__swimReportSwapList = function (doc) {",
  "    const nextList = doc.getElementById('beach-list-items');",
  "    const currentList = document.getElementById('beach-list-items');",
  "    if (!nextList || !currentList) {",
  "      return false;",
  "    }",
  "    currentList.innerHTML = nextList.innerHTML;",
  // Update the empty state in place, never replace the node: searchScript.js
  // captured #beach-list-empty by reference at load.
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
  // A stable, always-present container, so it swaps in place; its inner markup
  // is empty on the default listing and populated on a q-filtered page.
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
