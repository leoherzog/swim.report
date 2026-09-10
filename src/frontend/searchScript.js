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
//
// The same pass applies the "Green flags only" switch, whose state persists
// in one localStorage key and is applied once at load, because a wa-switch fires
// "change" only on real interaction and a restored state would otherwise show a
// switch reading on above an unfiltered list. It hides rows the server rendered
// and cannot know about, so while it is on it owns the empty state and shows its
// own copy; switching it off hands ownership back. Without JS the switch is
// inert and every row shows. A swap replaces every row, so
// "swimreport:listswap" re-runs the pass.
//
// Two events re-run it, and they are not interchangeable. "swimreport:listswap"
// means fresh server markup replaced the list, so the server's empty-state copy
// is re-captured before the pass. "swimreport:rowsadded" means rows were merely
// appended elsewhere on the page (the "Your Beaches" section), where re-reading
// the empty state would capture whatever this script last wrote into it.
//
// Both filter passes cover every .beach-row on the page, so the section filters
// with the list, but every count is taken inside #beach-list-items: the section
// holds copies of rows that may also sit in the list below, and counting them
// would report matches twice and let a saved row suppress the main list's own
// empty state.

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
  // #beach-search is a <wa-input>, and this script runs before the kit module
  // that defines it: until the element upgrades, the "value" property does not
  // exist and only the server-rendered attribute carries the query. Reading it
  // directly throws on the first pass, which kills the whole listener setup.
  "  const searchTerm = function () {",
  "    const v = typeof input.value === 'string' ? input.value : input.getAttribute('value');",
  "    return (v || '').trim();",
  "  };",
  // Green-only filter state. One localStorage key, both reads and writes in
  // try/catch because private mode throws on access rather than returning null.
  "  const GREEN_ONLY_KEY = 'swimreport:green-only';",
  "  const GREEN_EMPTY_MESSAGE = 'No green-flag beaches match your search.';",
  "  const greenSwitch = document.getElementById('green-only-filter');",
  "  let greenOnly = false;",
  // The server's own empty-state copy and visibility, re-captured after every
  // swap so the green filter can hand ownership back when it is switched off.
  "  let serverMessage = null;",
  "  let serverDisplay = '';",
  "  const captureServerEmptyState = function () {",
  "    if (!emptyState) {",
  "      return;",
  "    }",
  "    const messageEl = emptyState.querySelector('.empty-state-message');",
  "    serverMessage = messageEl ? messageEl.textContent : null;",
  "    serverDisplay = emptyState.style.display;",
  "  };",
  "  captureServerEmptyState();",
  // The server owns the empty state whenever a term can match rows it never
  // rendered. The green filter hides rows the server did render and knows
  // nothing about, so while it is on it owns the empty state itself — but only
  // when the term itself matched something, or the filter would take the blame
  // for a plain search miss.
  "  const updateEmptyState = function (visibleCount, termCount) {",
  "    if (!emptyState) {",
  "      return;",
  "    }",
  "    const messageEl = emptyState.querySelector('.empty-state-message');",
  "    if (greenOnly && visibleCount === 0 && termCount > 0) {",
  "      if (messageEl) {",
  "        messageEl.textContent = GREEN_EMPTY_MESSAGE;",
  "      }",
  "      emptyState.style.display = '';",
  "      return;",
  "    }",
  "    if (messageEl && serverMessage !== null) {",
  "      messageEl.textContent = serverMessage;",
  "    }",
  "    if (greenOnly || !hasFetch) {",
  "      emptyState.style.display = visibleCount === 0 ? '' : 'none';",
  "      return;",
  "    }",
  "    emptyState.style.display = serverDisplay;",
  "  };",
  // Both filters resolve to one display write per row: two passes would let the
  // next keystroke clobber the green filter's result. Every row on the page is
  // filtered; only rows in the main list are counted, since the empty state the
  // counts drive belongs to that list alone.
  "  const filterRows = function () {",
  "    const rows = document.querySelectorAll('.beach-row');",
  "    const mainList = document.getElementById('beach-list-items');",
  "    const term = searchTerm().toLowerCase();",
  "    let visibleCount = 0;",
  "    let termCount = 0;",
  "    rows.forEach(function (row) {",
  "      const name = row.getAttribute('data-name') || '';",
  "      const matchesTerm = term.length === 0 || name.indexOf(term) !== -1;",
  "      const matchesFlag = !greenOnly || row.getAttribute('data-flag') === 'green';",
  "      const matches = matchesTerm && matchesFlag;",
  "      row.style.display = matches ? '' : 'none';",
  "      if (!mainList || !mainList.contains(row)) {",
  "        return;",
  "      }",
  "      if (matchesTerm) {",
  "        termCount = termCount + 1;",
  "      }",
  "      if (matches) {",
  "        visibleCount = visibleCount + 1;",
  "      }",
  "    });",
  "    updateEmptyState(visibleCount, termCount);",
  "  };",
  "  if (greenSwitch) {",
  "    let stored = null;",
  "    try {",
  "      stored = window.localStorage.getItem(GREEN_ONLY_KEY);",
  "    } catch (err) {",
  "      stored = null;",
  "    }",
  // A restored state has to be applied here: wa-switch dispatches "change" only
  // from a real click or keypress, never from this programmatic write, so
  // without the pass the switch would read on above an unfiltered list until the
  // next keystroke or toggle.
  "    if (stored === '1') {",
  "      greenOnly = true;",
  "      greenSwitch.checked = true;",
  "      filterRows();",
  "    }",
  "    greenSwitch.addEventListener('change', function (event) {",
  "      greenOnly = !!(event.target && event.target.checked);",
  "      try {",
  "        window.localStorage.setItem(GREEN_ONLY_KEY, greenOnly ? '1' : '0');",
  "      } catch (err) {",
  "        console.log('green-only filter not persisted: ' + err.message);",
  "      }",
  "      filterRows();",
  "    });",
  "  }",
  // A swap replaces every row, so both filters have to be re-applied to the new
  // markup and the server's fresh empty-state copy re-captured first.
  "  document.addEventListener('swimreport:listswap', function () {",
  "    captureServerEmptyState();",
  "    filterRows();",
  "  });",
  // Rows appended outside the main list carry no fresh server markup with them,
  // so the pass re-runs over them but the capture must not: re-reading the empty
  // state here would latch whatever updateEmptyState last wrote — the green
  // filter's own copy — as the server's, and it would then reappear above a full
  // list the moment the filter is switched off.
  "  document.addEventListener('swimreport:rowsadded', function () {",
  "    filterRows();",
  "  });",
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
  // Rows the green filter hid are on the page but not on screen, so the count
  // reads the display the filter pass wrote rather than the row total. It counts
  // the main list alone: the "Your Beaches" section holds copies of rows that
  // may also be in the list below, and counting both would report every match
  // twice.
  "    let count = 0;",
  "    const countList = document.getElementById('beach-list-items');",
  "    const countRows = countList ? countList.querySelectorAll('.beach-row') : [];",
  "    countRows.forEach(function (row) {",
  "      if (row.style.display !== 'none') {",
  "        count = count + 1;",
  "      }",
  "    });",
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
  "    const term = searchTerm();",
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
  "      if (mySeq !== seq || searchTerm() !== term) {",
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
