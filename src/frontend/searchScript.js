// Pure module: exports the literal text of the inline, client-side search script
// used on the beach list (home) page. This code RUNS IN THE BROWSER, not in the
// Worker. It still follows project style rules: const/let only, never var, no
// template literals / backticks, console.log for logging.
//
// Behavior: the search box filters as the user types, with no need to press
// enter. Two layers work together:
//
//   1. Instant local filter over the already-rendered rows (the input event),
//      so the visible list narrows with zero latency.
//   2. A debounced, abortable fetch of the same server-rendered "/" page for the
//      current "?q=" (plus any active "near"), whose list/empty/active-query
//      pieces are swapped in place via window.__swimReportSwapList. This covers
//      the WHOLE beaches table, not just the rendered rows, so a match beyond
//      the rendered set appears without a full page navigation. The server is
//      authoritative for the empty state (a term can match beaches that were
//      never rendered), so the instant local filter only hides non-matching
//      rows and never flashes a "no match" message the fetch would contradict.
//
// The URL is kept in sync with history.replaceState (one mutating entry, not one
// per keystroke) so a refresh or copied link preserves the search. In-flight
// requests are aborted on each new keystroke and a sequence guard drops any
// stale response, so out-of-order completions can never clobber a newer result.
//
// Progressive enhancement: the surrounding <form method="get" action="/"> still
// works when JS is off (enter navigates to /?q=...). With JS, a submit is
// intercepted to flush the pending search in place instead of full-reloading.
// When fetch/AbortController are unavailable the script degrades to the legacy
// local-only filter (which then owns the empty state itself).

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
  // Instant local filter over the rendered rows. When the full-table server
  // search is available it owns the empty state, so here we only hide
  // non-matching rows; without fetch we fall back to toggling the empty state
  // locally (the legacy behavior).
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
  // Debounced full-table search. The DISPLAY url (replaceState, shareable) is
  // built from the current URL's params; the FETCH url additionally carries a
  // "near" so the response is cacheable (resolveUserLocation short-circuits on
  // near and never reads request.cf, so /?q=...&near=... is URL-determined and
  // gets max-age from the Worker). When the URL has no near yet (the common
  // pre-geolocation first visit), fall back to the server-resolved center baked
  // into the map's data-center (the same cf estimate the near-less page would
  // sort by) — identical rows, but now cacheable at the edge AND in the browser
  // HTTP cache, so backspacing/retyping repeats hit cache instead of D1. seq +
  // the value/generation guards drop stale responses; controller aborts the
  // previous in-flight request.
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
  // A 1-char term is skipped: local filtering already narrows the rendered rows,
  // and a server "LIKE '%x%'" for one character matches almost everything while
  // scanning the whole table. Empty (restore the default listing) and 2+ char
  // terms proceed.
  "    if (term.length === 1) {",
  "      return;",
  "    }",
  // When the rendered rows are the whole table, the instant local filter is
  // exhaustive — no server round-trip can add a row, so skip it entirely.
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
  // Fetch url: guarantee a near so the response is cacheable. Reuse the URL's
  // near when present (precise, post-grant); otherwise fall back to the baked-in
  // server center. Left as-is (near-less, no-store) only when neither exists.
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
  // Capture the swap generation so a swap from the geo upgrade (or a later
  // search) that lands while this fetch is in flight is reconciled below rather
  // than clobbered.
  "    const genAtStart = window.__swimReportListGen || 0;",
  "    fetch(fetchUrl, { signal: controller.signal }).then(function (res) {",
  "      if (!res.ok) {",
  "        throw new Error('unexpected status ' + res.status);",
  "      }",
  "      return res.text();",
  "    }).then(function (html) {",
  // seq: a newer search superseded this one. value: the user typed on, so this
  // response is for a stale term (a fresh debounced fetch is already coming).
  "      if (mySeq !== seq || input.value.trim() !== term) {",
  "        return;",
  "      }",
  // Another swap (typically the geo upgrade introducing "near") landed while we
  // were fetching: re-run so we read the now-current near/q instead of applying
  // this now-stale response.
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
  // A failed fetch leaves the instant local-filter result in place. lastSent is
  // deliberately not tracked, so the next keystroke or a submit re-attempts the
  // fetch — the failure is transient, not sticky.
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
  // Intercept enter/submit: run the search in place instead of full-reloading.
  // Without fetch this listener is not attached, so the native GET submit stands.
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
