// Exports the literal text of the inline search script on the beach list (home)
// page. It runs in the browser, not in the Worker.
//
// Two layers filter as the user types: an instant local filter over the
// already-rendered rows, and a debounced, abortable fetch of the same
// server-rendered "/" page whose list/empty/active-query pieces are swapped in
// place via window.__swimReportSwapList. The server is authoritative for the
// empty state, because a term can match beaches that were never rendered, so
// the local filter only hides non-matching rows and never flashes a "no match"
// message the fetch would contradict.
//
// history.replaceState keeps the URL in sync with one mutating entry rather than
// one per keystroke. In-flight requests are aborted on each keystroke and a
// sequence guard drops stale responses, so out-of-order completions cannot
// clobber a newer result.
//
// The surrounding <form method="get" action="/"> still works with JS off. With
// JS a submit is intercepted to flush the pending search in place, and when
// fetch/AbortController are unavailable the script degrades to the local-only
// filter, which then owns the empty state itself.

const SCRIPT_LINES = [
  "(function () {",
  "  const input = document.getElementById('beach-search');",
  "  const emptyState = document.getElementById('beach-list-empty');",
  "  const form = document.getElementById('beach-search-form');",
  "  const live = document.getElementById('geo-live-region');",
  "  if (!input) {",
  "    return;",
  "  }",
  "  const hasFetch = typeof fetch !== 'undefined' && typeof AbortController !== 'undefined';",
  // The full-table server search owns the empty state when it is available, so
  // this only hides non-matching rows; without fetch it toggles the empty state.
  "  const filterRows = function () {",
  "    const rows = document.querySelectorAll('.beach-row');",
  "    const term = input.value.trim().toLowerCase();",
  "    let visibleCount = 0;",
  "    rows.forEach(function (row) {",
  "      const name = row.getAttribute('data-name') || '';",
  "      const matches = term.length === 0 || name.indexOf(term) !== -1;",
  "      row.style.display = matches ? '' : 'none';",
  "      if (matches) {",
  "        visibleCount = visibleCount + 1;",
  "      }",
  "    });",
  "    if (emptyState && !hasFetch) {",
  "      emptyState.style.display = visibleCount === 0 ? '' : 'none';",
  "    }",
  "  };",
  // Debounced full-table search. The display url (replaceState, shareable) is
  // built from the current URL's params; the fetch url additionally carries a
  // "near" so the response is cacheable, because resolveUserLocation
  // short-circuits on near and never reads request.cf, leaving /?q=...&near=...
  // fully URL-determined. With no near in the URL yet, fall back to the map's
  // baked-in data-center, the same server-resolved estimate the near-less page
  // would sort by. seq plus the value/generation guards drop stale responses;
  // controller aborts the previous in-flight request.
  "  const DEBOUNCE_MS = 250;",
  "  const mapEl = document.getElementById('home-map');",
  "  const bakedCenter = mapEl ? (mapEl.getAttribute('data-center') || '') : '';",
  "  let timer = null;",
  "  let controller = null;",
  "  let seq = 0;",
  "  const announce = function (term) {",
  "    if (!live) {",
  "      return;",
  "    }",
  "    const count = document.querySelectorAll('.beach-row').length;",
  "    if (!term) {",
  "      live.textContent = '';",
  "    } else {",
  "      live.textContent = count + (count === 1 ? ' beach matches ' : ' beaches match ') + 'your search.';",
  "    }",
  "  };",
  "  const runServerSearch = function () {",
  "    if (!hasFetch) {",
  "      return;",
  "    }",
  "    const term = input.value.trim();",
  // A 1-char term is skipped: the local filter already narrows the rendered
  // rows, and a server LIKE '%x%' for one character scans the whole table to
  // match almost everything. Empty and 2+ char terms proceed.
  "    if (term.length === 1) {",
  "      return;",
  "    }",
  // When the rendered rows are the whole table the local filter is exhaustive,
  // so no server round-trip can add a row.
  "    const listEl = document.getElementById('beach-list-items');",
  "    if (listEl && listEl.getAttribute('data-complete') === '1') {",
  "      return;",
  "    }",
  "    const params = new URLSearchParams(window.location.search);",
  "    if (term) {",
  "      params.set('q', term);",
  "    } else {",
  "      params.delete('q');",
  "    }",
  "    const queryString = params.toString();",
  "    const nextUrl = queryString ? ('/?' + queryString) : '/';",
  // Prefer the URL's near (precise, post-grant), else the baked-in server
  // center; near-less and uncacheable only when neither exists.
  "    const fetchParams = new URLSearchParams(params);",
  "    if (!fetchParams.get('near') && bakedCenter) {",
  "      fetchParams.set('near', bakedCenter);",
  "    }",
  "    const fetchUrl = '/?' + fetchParams.toString();",
  "    if (controller) {",
  "      controller.abort();",
  "    }",
  "    controller = new AbortController();",
  "    const mySeq = seq + 1;",
  "    seq = mySeq;",
  // Capture the swap generation so a swap landing mid-flight is reconciled below
  // rather than clobbered.
  "    const genAtStart = window.__swimReportListGen || 0;",
  "    fetch(fetchUrl, { signal: controller.signal }).then(function (res) {",
  "      if (!res.ok) {",
  "        throw new Error('unexpected status ' + res.status);",
  "      }",
  "      return res.text();",
  "    }).then(function (html) {",
  // seq: a newer search superseded this one. value: the user typed on, so this
  // response is for a stale term and a fresh debounced fetch is already coming.
  "      if (mySeq !== seq || input.value.trim() !== term) {",
  "        return;",
  "      }",
  // Another swap (typically the geo upgrade introducing "near") landed while we
  // were fetching, so re-run against the now-current near/q.
  "      if ((window.__swimReportListGen || 0) !== genAtStart) {",
  "        runServerSearch();",
  "        return;",
  "      }",
  "      const doc = new DOMParser().parseFromString(html, 'text/html');",
  "      if (window.__swimReportSwapList && window.__swimReportSwapList(doc)) {",
  "        window.history.replaceState(null, '', nextUrl);",
  "        announce(term);",
  "      }",
  "    }).catch(function (err) {",
  "      if (err && err.name === 'AbortError') {",
  "        return;",
  "      }",
  // A failed fetch leaves the local-filter result in place and is deliberately
  // not recorded, so the next keystroke or submit re-attempts it.
  "      console.log('live search failed: ' + err.message);",
  "    });",
  "  };",
  "  const onInput = function () {",
  "    filterRows();",
  "    if (timer) {",
  "      clearTimeout(timer);",
  "    }",
  "    timer = setTimeout(runServerSearch, DEBOUNCE_MS);",
  "  };",
  "  input.addEventListener('input', onInput);",
  "  input.addEventListener('wa-clear', onInput);",
  // Intercept enter/submit to run the search in place. Without fetch this
  // listener is not attached, so the native GET submit stands.
  "  if (form && hasFetch) {",
  "    form.addEventListener('submit', function (event) {",
  "      event.preventDefault();",
  "      if (timer) {",
  "        clearTimeout(timer);",
  "      }",
  "      runServerSearch();",
  "    });",
  "  }",
  "})();"
];

export const LIST_SEARCH_SCRIPT = SCRIPT_LINES.join("\n");
