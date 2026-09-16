// Exports the literal text of the two inline favorites scripts: the detail
// page's save toggle and the list page's "Your Beaches" section. Both run in
// the browser, not in the Worker.
//
// Everything a visitor saves lives in localStorage under two keys — an array of
// favorite beach ids and a most-recent-first array of viewed ids capped at
// FAVORITES_RECENT_MAX. Nothing reaches the server except the bounded "/?ids="
// list the section fetches, and every read and write is wrapped in try/catch
// because a private-mode browser throws on access rather than returning null.
//
// The script bodies are text and cannot import, so the two key names, the recent
// cap and the ids bound are interpolated from the constants below rather than
// restated as literals.
//
// Both are progressive enhancements. The detail page ships the toggle with the
// hidden attribute and the script removes it, so a JS-less visitor never sees a
// control that cannot work; the list page ships the section empty and hidden,
// and a failed fetch leaves it that way.

import { IDS_LIST_LIMIT } from "../idsListLimit.js";

// The favorites array key, the recently-viewed array key, and the cap on the
// latter. Interpolated into both script bodies below.
export const FAVORITES_KEY = "swimreport:favorites";
export const FAVORITES_RECENT_KEY = "swimreport:recent";
export const FAVORITES_RECENT_MAX = 8;

// A stored value written by another version, another script, or a hostile
// extension is not trusted: anything but an array of strings reads as empty,
// and every id is normalized to the public form the pages link to and the
// server accepts. An id in the storage form maps to its public form, an id
// already public passes through, and anything else is dropped. The two writers
// below store what this returns, so a visitor's list converts on first use.
const READ_IDS_LINES = [
  "  const PUBLIC_ID = /^[nwr][1-9][0-9]*$/;",
  "  const STORAGE_ID = /^osm-(node|way|relation)-([1-9][0-9]*)$/;",
  "  const publicId = function (id) {",
  "    if (typeof id !== 'string') {",
  "      return '';",
  "    }",
  "    if (PUBLIC_ID.test(id)) {",
  "      return id;",
  "    }",
  "    const parts = id.match(STORAGE_ID);",
  "    return parts ? parts[1].charAt(0) + parts[2] : '';",
  "  };",
  "  const readIds = function (key) {",
  "    try {",
  "      const raw = window.localStorage.getItem(key);",
  "      if (!raw) {",
  "        return [];",
  "      }",
  "      const parsed = JSON.parse(raw);",
  "      if (!Array.isArray(parsed)) {",
  "        return [];",
  "      }",
  "      return parsed.map(publicId).filter(function (id) { return id.length > 0; });",
  "    } catch (err) {",
  "      return [];",
  "    }",
  "  };"
];

const DETAIL_LINES = [
  "(function () {",
  "  const btn = document.getElementById('favorite-toggle');",
  "  if (!btn) {",
  "    return;",
  "  }",
  "  const beachId = btn.getAttribute('data-beach-id');",
  "  if (!beachId) {",
  "    return;",
  "  }",
  "  const FAV_KEY = '" + FAVORITES_KEY + "';",
  "  const RECENT_KEY = '" + FAVORITES_RECENT_KEY + "';",
  "  const RECENT_MAX = " + String(FAVORITES_RECENT_MAX) + ";"
].concat(READ_IDS_LINES, [
  "  const writeIds = function (key, ids) {",
  "    try {",
  "      window.localStorage.setItem(key, JSON.stringify(ids));",
  "    } catch (err) {",
  "      console.log('favorites store unavailable: ' + err.message);",
  "    }",
  "  };",
  // Most-recent-first, deduped, capped: this beach moves to the head whether or
  // not it was already in the list.
  "  const recent = readIds(RECENT_KEY).filter(function (id) { return id !== beachId; });",
  "  recent.unshift(beachId);",
  "  writeIds(RECENT_KEY, recent.slice(0, RECENT_MAX));",
  // The label and the icon weight carry the state alongside aria-pressed, so
  // the toggle reads the same by sight and by screen reader.
  "  const label = document.getElementById('favorite-label');",
  "  const icon = document.getElementById('favorite-icon');",
  "  const apply = function (saved) {",
  "    btn.setAttribute('aria-pressed', saved ? 'true' : 'false');",
  "    if (label) {",
  "      label.textContent = saved ? 'Saved' : 'Save';",
  "    }",
  "    if (icon) {",
  "      icon.setAttribute('variant', saved ? 'solid' : 'regular');",
  "    }",
  "  };",
  "  apply(readIds(FAV_KEY).indexOf(beachId) !== -1);",
  "  btn.hidden = false;",
  "  btn.addEventListener('click', function () {",
  "    const favorites = readIds(FAV_KEY);",
  "    const at = favorites.indexOf(beachId);",
  "    if (at === -1) {",
  "      favorites.push(beachId);",
  "    } else {",
  "      favorites.splice(at, 1);",
  "    }",
  "    writeIds(FAV_KEY, favorites);",
  "    apply(at === -1);",
  "  });",
  "})();"
]);

export const DETAIL_FAVORITE_SCRIPT = DETAIL_LINES.join("\n");

const LIST_LINES = [
  "(function () {",
  "  const section = document.getElementById('your-beaches');",
  "  const savedList = document.getElementById('your-beaches-saved');",
  "  const recentList = document.getElementById('your-beaches-recent');",
  "  if (!section || !savedList || !recentList) {",
  "    return;",
  "  }",
  "  const FAV_KEY = '" + FAVORITES_KEY + "';",
  "  const RECENT_KEY = '" + FAVORITES_RECENT_KEY + "';",
  // The server caps ?ids= at IDS_LIST_LIMIT and drops anything it does not
  // recognize, so this cap only avoids asking for rows that would be discarded.
  "  const IDS_MAX = " + String(IDS_LIST_LIMIT) + ";"
].concat(READ_IDS_LINES, [
  // The row's own link is the id: matching on it keeps the section from needing
  // any markup the server does not already render.
  "  const rowBeachId = function (row) {",
  "    const link = row.querySelector('.beach-row-link');",
  "    const href = link ? (link.getAttribute('href') || '') : '';",
  "    if (href.indexOf('/beach/') !== 0) {",
  "      return '';",
  "    }",
  "    try {",
  "      return decodeURIComponent(href.slice('/beach/'.length));",
  "    } catch (err) {",
  "      return '';",
  "    }",
  "  };",
  "  const clearList = function (list) {",
  "    while (list.firstChild) {",
  "      list.removeChild(list.firstChild);",
  "    }",
  "  };",
  // One fill of the section from the ids stored right now. With harvest the
  // main list's own rows are reused and only the ids still missing are fetched;
  // without it every id is fetched, which is the refresh path, where the page's
  // rows may be as old as the copies they would refill.
  "  let inflight = false;",
  "  const load = function (harvest) {",
  "    const favorites = readIds(FAV_KEY);",
  "    const recent = readIds(RECENT_KEY).filter(function (id) { return favorites.indexOf(id) === -1; });",
  "    const ids = favorites.concat(recent).slice(0, IDS_MAX);",
  "    const byId = new Map();",
  "    const collect = function (rows) {",
  "      for (let i = 0; i < rows.length; i = i + 1) {",
  "        const id = rowBeachId(rows[i]);",
  "        if (id && ids.indexOf(id) !== -1 && !byId.has(id)) {",
  "          byId.set(id, rows[i]);",
  "        }",
  "      }",
  "    };",
  // The server owns row markup and the requested order; rows are only copied
  // and split between the two lists, never re-sorted or rebuilt. Both lists
  // are emptied first, so a refill never doubles a row.
  "    const insertRows = function () {",
  "      clearList(savedList);",
  "      clearList(recentList);",
  "      let savedCount = 0;",
  "      let recentCount = 0;",
  "      for (let i = 0; i < ids.length; i = i + 1) {",
  "        const row = byId.get(ids[i]);",
  "        if (!row) {",
  "          continue;",
  "        }",
  "        const copy = document.importNode(row, true);",
  // A copy repeats its source row's ids, and a wa-tooltip binds to the first
  // element carrying its for id, so ids and for references are prefixed before
  // the copy connects.
  "        const named = copy.querySelectorAll('[id]');",
  "        for (let j = 0; j < named.length; j = j + 1) {",
  "          named[j].id = 'your-' + named[j].id;",
  "        }",
  "        const tips = copy.querySelectorAll('wa-tooltip[for]');",
  "        for (let j = 0; j < tips.length; j = j + 1) {",
  "          tips[j].setAttribute('for', 'your-' + tips[j].getAttribute('for'));",
  "        }",
  "        if (favorites.indexOf(ids[i]) !== -1) {",
  "          savedList.appendChild(copy);",
  "          savedCount = savedCount + 1;",
  "        } else {",
  "          recentList.appendChild(copy);",
  "          recentCount = recentCount + 1;",
  "        }",
  "      }",
  // The sub-labels only earn their space when both groups are present; one
  // group alone is already named by the section heading.
  "      const both = savedCount > 0 && recentCount > 0;",
  "      const savedLabel = document.getElementById('your-beaches-saved-label');",
  "      const recentLabel = document.getElementById('your-beaches-recent-label');",
  "      if (savedLabel) {",
  "        savedLabel.hidden = !both;",
  "      }",
  "      if (recentLabel) {",
  "        recentLabel.hidden = !both;",
  "      }",
  "      section.hidden = savedCount === 0 && recentCount === 0;",
  "      if (section.hidden) {",
  "        return;",
  "      }",
  // These rows land after the search and green-only filters have already run,
  // so a copy taken from the fetched document carries no display of its own.
  // "swimreport:rowsadded" is what makes searchScript.js re-apply both passes
  // over them. It is deliberately not the swap event: no fresh server markup
  // arrived, so re-capturing the empty state would latch the green filter's own
  // message as the server's. The swap generation is left alone for the same
  // reason — the main list was never replaced, and a bump would restart an
  // in-flight live search.
  "      document.dispatchEvent(new CustomEvent('swimreport:rowsadded'));",
  "    };",
  "    if (ids.length === 0) {",
  "      insertRows();",
  "      return;",
  "    }",
  // The main list already holds up to a hundred server-rendered rows, so a
  // wanted beach is often on the page already. Harvesting those first is what
  // keeps the common return visit from fetching a second whole list document,
  // and only the ids still missing are asked for. A harvested row carries the
  // distance label the proximity sort gave it and a fetched one carries none,
  // which is a difference in what the server knew, not in what the row says.
  "    if (harvest) {",
  "      collect(document.querySelectorAll('#beach-list-items .beach-row'));",
  "    }",
  "    const missing = ids.filter(function (id) { return !byId.has(id); });",
  // Every wanted row was already on the page, so the section costs no request
  // at all. The same branch covers a browser without fetch or DOMParser: it
  // shows the rows it has rather than nothing.
  "    if (missing.length === 0 || typeof fetch === 'undefined' || typeof DOMParser === 'undefined') {",
  "      insertRows();",
  "      return;",
  "    }",
  "    const url = '/?ids=' + missing.map(encodeURIComponent).join(',');",
  "    inflight = true;",
  "    fetch(url, harvest ? {} : { cache: 'no-cache' }).then(function (res) {",
  "      if (!res.ok) {",
  "        throw new Error('unexpected status ' + res.status);",
  "      }",
  "      return res.text();",
  "    }).then(function (html) {",
  "      const doc = new DOMParser().parseFromString(html, 'text/html');",
  "      collect(doc.querySelectorAll('#beach-list-items .beach-row'));",
  "      insertRows();",
  "    }).catch(function (err) {",
  // A failed fetch leaves the section as it was: hidden and empty on a first
  // load, which is the same page a first-time visitor sees, and its last rows
  // on a refresh.
  "      console.log('your beaches unavailable: ' + err.message);",
  "    }).then(function () {",
  "      inflight = false;",
  "    });",
  "  };",
  "  load(true);",
  // Live refresh (refreshScript.js): every copy is refetched, and the stored ids
  // are re-read, so a beach saved in another tab appears too. A visitor whose
  // focus is inside the section keeps it until the next tick.
  "  document.addEventListener('swimreport:refresh', function () {",
  "    if (inflight || (document.activeElement && section.contains(document.activeElement))) {",
  "      return;",
  "    }",
  "    load(false);",
  "  });",
  "})();"
]);

export const LIST_FAVORITES_SCRIPT = LIST_LINES.join("\n");
