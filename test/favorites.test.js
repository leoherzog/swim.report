// test/favorites.test.js
// Covers the favorites and recently-viewed enhancement: the detail page's save
// toggle in the hero share row, the list page's empty "Your beaches" shell, and
// the two inline script constants that fill them from localStorage.

import { describe, it, expect } from "vitest";
import { renderListPage, renderDetailPage } from "../src/frontend/render.js";
import {
  FAVORITES_KEY,
  FAVORITES_RECENT_KEY,
  FAVORITES_RECENT_MAX,
  DETAIL_FAVORITE_SCRIPT,
  LIST_FAVORITES_SCRIPT
} from "../src/frontend/favoritesScript.js";
import { LIST_SEARCH_SCRIPT } from "../src/frontend/searchScript.js";
import { IDS_LIST_LIMIT } from "../src/idsListLimit.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

function detailHtml(extra) {
  return renderDetailPage({
    beach: beachWith(extra),
    estimate: null,
    official: null,
    nowIso: NOW_ISO
  });
}

function listHtml(data) {
  return renderListPage(Object.assign({ entries: [], nowIso: NOW_ISO }, data || {}));
}

// The section shell, from its opening tag through its closing tag.
function yourBeaches(html) {
  const start = html.indexOf("<section id=\"your-beaches\"");
  const end = html.indexOf("</section>", start);
  return start === -1 ? "" : html.slice(start, end + "</section>".length);
}

describe("detail-page favorite toggle", () => {
  it("renders a hidden aria-pressed star button carrying the beach id", () => {
    const html = detailHtml({});
    expect(html).toContain(
      "<wa-button id=\"favorite-toggle\" class=\"favorite-toggle\" " +
      "appearance=\"outlined\" size=\"s\" aria-pressed=\"false\" " +
      "data-beach-id=\"osm-way-505668572\" hidden>" +
      "<wa-icon id=\"favorite-icon\" slot=\"start\" name=\"star\" variant=\"regular\"></wa-icon>" +
      "<span id=\"favorite-label\">Save</span>" +
      "</wa-button>");
  });

  it("sits in the hero share row, after the copy and share controls", () => {
    const html = detailHtml({});
    const actionsAt = html.indexOf("<div class=\"hero-actions");
    const copyAt = html.indexOf("<wa-copy-button class=\"hero-copy\"");
    const shareAt = html.indexOf("<wa-button id=\"hero-share\"");
    const buttonAt = html.indexOf("<wa-button id=\"favorite-toggle\"");
    const glanceAt = html.indexOf("<section class=\"at-a-glance");
    expect(actionsAt).toBeLessThan(copyAt);
    expect(copyAt).toBeLessThan(shareAt);
    expect(shareAt).toBeLessThan(buttonAt);
    expect(buttonAt).toBeLessThan(glanceAt);
  });

  it("escapes the beach id in the attribute position", () => {
    const html = detailHtml({ id: "osm-way-1\" onload=\"x" });
    expect(html).toContain("data-beach-id=\"osm-way-1&quot; onload=&quot;x\"");
  });

  it("embeds the toggle script on the detail page only, beside the hero script", () => {
    const html = detailHtml({});
    expect(html).toContain("<script>" + DETAIL_FAVORITE_SCRIPT + "</script>");
    expect(listHtml()).not.toContain(DETAIL_FAVORITE_SCRIPT);
  });
});

describe("list-page \"Your beaches\" section", () => {
  it("renders the section empty and hidden, above the main list", () => {
    const html = listHtml();
    expect(yourBeaches(html)).toBe(
      "<section id=\"your-beaches\" class=\"your-beaches wa-stack wa-gap-s\" " +
      "aria-labelledby=\"your-beaches-heading\" hidden>" +
      "<h2 id=\"your-beaches-heading\" class=\"your-beaches-heading\">Your beaches</h2>" +
      "<p id=\"your-beaches-saved-label\" class=\"your-beaches-label wa-caption-s\" hidden>Saved</p>" +
      "<ul id=\"your-beaches-saved\" class=\"beach-list wa-list-plain wa-stack wa-gap-xs\"></ul>" +
      "<p id=\"your-beaches-recent-label\" class=\"your-beaches-label wa-caption-s\" hidden>" +
      "Recently viewed</p>" +
      "<ul id=\"your-beaches-recent\" class=\"beach-list wa-list-plain wa-stack wa-gap-xs\"></ul>" +
      "</section>");
    expect(html.indexOf("id=\"your-beaches\""))
      .toBeLessThan(html.indexOf("id=\"beach-list-items\""));
  });

  it("embeds the section script after the swap helper it never uses", () => {
    const html = listHtml();
    expect(html).toContain("<script>" + LIST_FAVORITES_SCRIPT + "</script>");
    expect(html.indexOf("window.__swimReportSwapList ="))
      .toBeLessThan(html.indexOf(LIST_FAVORITES_SCRIPT));
  });

  it("keeps data-complete on the default listing and drops it in ids mode", () => {
    expect(listHtml()).toContain("id=\"beach-list-items\" data-complete=\"1\"");
    expect(listHtml({ idsMode: true })).not.toContain("data-complete=\"1\"");
  });

  // An ids page with no rows means the ids were not recognized, which is neither
  // a search miss nor an empty database.
  it("gives an empty ids page its own copy", () => {
    expect(listHtml({ idsMode: true }))
      .toContain("<span class=\"empty-state-message\">No beaches match those ids.</span>");
    expect(listHtml())
      .toContain("<span class=\"empty-state-message\">No beaches found yet. Check back soon.</span>");
    expect(listHtml({ query: "oval" }))
      .toContain("<span class=\"empty-state-message\">No beaches match your search.</span>");
  });
});

describe("favorites script constants", () => {
  it("names the two localStorage keys and the recent cap", () => {
    expect(FAVORITES_KEY).toBe("swimreport:favorites");
    expect(FAVORITES_RECENT_KEY).toBe("swimreport:recent");
    expect(FAVORITES_RECENT_MAX).toBe(8);
    // The script bodies are built from those constants, so the two halves cannot
    // drift apart.
    expect(DETAIL_FAVORITE_SCRIPT).toContain("const FAV_KEY = '" + FAVORITES_KEY + "';");
    expect(DETAIL_FAVORITE_SCRIPT).toContain("const RECENT_KEY = '" + FAVORITES_RECENT_KEY + "';");
    expect(DETAIL_FAVORITE_SCRIPT).toContain("const RECENT_MAX = " + FAVORITES_RECENT_MAX + ";");
    expect(LIST_FAVORITES_SCRIPT).toContain("const FAV_KEY = '" + FAVORITES_KEY + "';");
    expect(LIST_FAVORITES_SCRIPT).toContain("const RECENT_KEY = '" + FAVORITES_RECENT_KEY + "';");
  });

  it("wraps every localStorage access in try/catch and reveals the toggle itself", () => {
    expect(DETAIL_FAVORITE_SCRIPT).toContain("window.localStorage.getItem(key)");
    expect(DETAIL_FAVORITE_SCRIPT).toContain("window.localStorage.setItem(key, JSON.stringify(ids))");
    expect(DETAIL_FAVORITE_SCRIPT).toContain("} catch (err) {");
    expect(DETAIL_FAVORITE_SCRIPT).toContain("btn.setAttribute('aria-pressed', saved ? 'true' : 'false');");
    expect(DETAIL_FAVORITE_SCRIPT).toContain("label.textContent = saved ? 'Saved' : 'Save';");
    expect(DETAIL_FAVORITE_SCRIPT).toContain("btn.hidden = false;");
    // The recently-viewed list is most-recent-first and capped.
    expect(DETAIL_FAVORITE_SCRIPT).toContain("recent.unshift(beachId);");
    expect(DETAIL_FAVORITE_SCRIPT).toContain("writeIds(RECENT_KEY, recent.slice(0, RECENT_MAX));");
    expect(LIST_FAVORITES_SCRIPT).toContain("window.localStorage.getItem(key)");
    expect(LIST_FAVORITES_SCRIPT).toContain("} catch (err) {");
    // Nothing is written back from the list page.
    expect(LIST_FAVORITES_SCRIPT).not.toContain("setItem");
  });

  it("fetches only the ids the page does not already hold", () => {
    expect(LIST_FAVORITES_SCRIPT).toContain("const IDS_MAX = " + IDS_LIST_LIMIT + ";");
    // Rows already rendered in the main list are harvested first, and only what
    // is left over costs a request.
    expect(LIST_FAVORITES_SCRIPT).toContain(
      "collect(document.querySelectorAll('#beach-list-items .beach-row'));");
    expect(LIST_FAVORITES_SCRIPT).toContain(
      "const missing = ids.filter(function (id) { return !byId.has(id); });");
    expect(LIST_FAVORITES_SCRIPT).toContain(
      "if (missing.length === 0 || typeof fetch === 'undefined' || " +
      "typeof DOMParser === 'undefined') {");
    expect(LIST_FAVORITES_SCRIPT).toContain(
      "const url = '/?ids=' + missing.map(encodeURIComponent).join(',');");
    expect(LIST_FAVORITES_SCRIPT.indexOf("const missing ="))
      .toBeLessThan(LIST_FAVORITES_SCRIPT.indexOf("const url = '/?ids='"));
    expect(LIST_FAVORITES_SCRIPT).toContain(
      "const doc = new DOMParser().parseFromString(html, 'text/html');");
    expect(LIST_FAVORITES_SCRIPT).toContain(
      "collect(doc.querySelectorAll('#beach-list-items .beach-row'));");
    // Favorites first, then recently viewed with the favorites removed.
    expect(LIST_FAVORITES_SCRIPT).toContain("const ids = favorites.concat(recent).slice(0, IDS_MAX);");
    // A failed fetch leaves the section hidden.
    expect(LIST_FAVORITES_SCRIPT).toContain("}).catch(function (err) {");
    expect(LIST_FAVORITES_SCRIPT).toContain("section.hidden = false;");
    // Server-owned markup: rows are copied as they came, never rebuilt, and the
    // caller's id order decides where each one lands.
    expect(LIST_FAVORITES_SCRIPT).toContain("const copy = document.importNode(row, true);");
    expect(LIST_FAVORITES_SCRIPT).not.toContain(".sort(");
    expect(LIST_FAVORITES_SCRIPT).not.toContain("innerHTML");
  });

  // The inserted rows arrive after the search and green-only passes have run, so
  // they carry no inline display until an event re-applies both filters over
  // them. It is deliberately not the swap event: nothing replaced the main list.
  it("dispatches the rows-added event, after revealing the section", () => {
    const dispatch = "document.dispatchEvent(new CustomEvent('swimreport:rowsadded'));";
    expect(LIST_FAVORITES_SCRIPT).toContain(dispatch);
    expect(LIST_FAVORITES_SCRIPT.indexOf("section.hidden = false;"))
      .toBeLessThan(LIST_FAVORITES_SCRIPT.indexOf(dispatch));
    expect(LIST_SEARCH_SCRIPT).toContain(
      "document.addEventListener('swimreport:rowsadded', function () {");
    // The main list was never replaced, so the swap generation must not move:
    // bumping it would restart an in-flight live search.
    expect(LIST_FAVORITES_SCRIPT).not.toContain("__swimReportListGen");
    expect(LIST_FAVORITES_SCRIPT).not.toContain("swimreport:listswap");
  });

  // Re-capturing the empty state on these rows would read back whatever
  // updateEmptyState last wrote — the green filter's own copy — and then restore
  // it as the server's the next time the filter is switched off.
  it("leaves the captured server empty state alone on added rows", () => {
    const rowsAddedAt = LIST_SEARCH_SCRIPT.indexOf(
      "document.addEventListener('swimreport:rowsadded', function () {");
    const swapAt = LIST_SEARCH_SCRIPT.indexOf(
      "document.addEventListener('swimreport:listswap', function () {");
    expect(rowsAddedAt).toBeGreaterThan(-1);
    expect(swapAt).toBeGreaterThan(-1);
    const rowsAddedBody = LIST_SEARCH_SCRIPT.slice(rowsAddedAt, rowsAddedAt + 200);
    const rowsAddedListener = rowsAddedBody.slice(0, rowsAddedBody.indexOf("});"));
    expect(rowsAddedListener).toContain("filterRows();");
    expect(rowsAddedListener).not.toContain("captureServerEmptyState();");
    // The swap listener, where fresh server markup really did arrive, still
    // captures before it filters.
    const swapBody = LIST_SEARCH_SCRIPT.slice(swapAt, swapAt + 200);
    expect(swapBody.indexOf("captureServerEmptyState();"))
      .toBeLessThan(swapBody.indexOf("filterRows();"));
  });

  it("counts only main-list rows while filtering every row on the page", () => {
    // The display pass covers the whole page, so the section filters with the list.
    expect(LIST_SEARCH_SCRIPT).toContain("const rows = document.querySelectorAll('.beach-row');");
    // Both the empty-state counts and the live-region count stop at the main
    // list: the section holds copies of rows that may also sit below it.
    expect(LIST_SEARCH_SCRIPT).toContain(
      "const mainList = document.getElementById('beach-list-items');");
    expect(LIST_SEARCH_SCRIPT).toContain("      if (!mainList || !mainList.contains(row)) {");
    expect(LIST_SEARCH_SCRIPT).toContain(
      "const countList = document.getElementById('beach-list-items');");
    expect(LIST_SEARCH_SCRIPT).toContain(
      "const countRows = countList ? countList.querySelectorAll('.beach-row') : [];");
  });

  it("never contains a closing script tag", () => {
    expect(DETAIL_FAVORITE_SCRIPT).not.toContain("</script");
    expect(LIST_FAVORITES_SCRIPT).not.toContain("</script");
  });
});
