// Covers the live refresh layer: the scheduler both pages embed, the list
// page's swap-through-fetch consumer, the shared fetch-URL and list-html
// values on the swap helper, and the detail page's keyed reconciler. The
// scripts are text, so the runtime tests execute them against thin stubs; the
// reconciler runs against a small fake DOM that implements only what the
// script touches.

import { describe, it, expect, afterEach, vi } from "vitest";
import { renderListPage, renderDetailPage } from "../src/frontend/render.js";
import { REFRESH_INTERVAL_MS, LIVE_REFRESH_SCRIPT } from "../src/frontend/refreshScript.js";
import { LIST_REFRESH_SCRIPT } from "../src/frontend/listRefreshScript.js";
import { DETAIL_REFRESH_SCRIPT } from "../src/frontend/detailRefreshScript.js";
import { LIST_SWAP_SCRIPT } from "../src/frontend/listSwapScript.js";
import { LIST_FAVORITES_SCRIPT } from "../src/frontend/favoritesScript.js";
import { WAVE_TICKS_SCRIPT } from "../src/frontend/waveTicksScript.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

const SAVED = {
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  fetch: globalThis.fetch,
  DOMParser: globalThis.DOMParser,
  CustomEvent: globalThis.CustomEvent
};
const REAL_CONSOLE = console;

afterEach(() => {
  delete globalThis.document;
  delete globalThis.window;
  globalThis.setInterval = SAVED.setInterval;
  globalThis.clearInterval = SAVED.clearInterval;
  globalThis.fetch = SAVED.fetch;
  globalThis.DOMParser = SAVED.DOMParser;
  globalThis.CustomEvent = SAVED.CustomEvent;
  globalThis.console = REAL_CONSOLE;
  vi.restoreAllMocks();
});

function settle() {
  return new Promise((r) => setTimeout(r, 0)).then(() => new Promise((r) => setTimeout(r, 0)));
}

function detailHtml(extra) {
  return renderDetailPage(Object.assign({
    beach: beachWith({}),
    estimate: { color: "green", reason: "calm", sources: [], updated: NOW_ISO },
    official: null,
    nowIso: NOW_ISO
  }, extra || {}));
}

function count(html, needle) {
  return html.split(needle).length - 1;
}

describe("live refresh wiring", () => {
  it("embeds the scheduler last on both pages, after every consumer", () => {
    const list = renderListPage({ entries: [], nowIso: NOW_ISO });
    const detail = detailHtml();
    const listTag = "<script>" + LIVE_REFRESH_SCRIPT + "</script>";
    expect(list.indexOf(listTag)).toBeGreaterThan(list.indexOf(LIST_REFRESH_SCRIPT));
    expect(list.indexOf(listTag)).toBeGreaterThan(list.indexOf("maplibre-gl.mjs"));
    expect(list.indexOf(LIST_REFRESH_SCRIPT)).toBeGreaterThan(list.indexOf(LIST_SWAP_SCRIPT));
    expect(detail.indexOf(listTag)).toBeGreaterThan(detail.indexOf(DETAIL_REFRESH_SCRIPT));
    expect(list).not.toContain(DETAIL_REFRESH_SCRIPT);
    expect(detail).not.toContain(LIST_REFRESH_SCRIPT);
  });

  it("seeds the detail reconciler before the tick relabeller rewrites the wave section", () => {
    const html = detailHtml({
      estimate: { color: "green", reason: "calm", sources: [], updated: NOW_ISO, waveHeightFt: 1.0 },
      waves: { startIso: NOW_ISO, hoursFt: new Array(24).fill(1.0), updated: NOW_ISO }
    });
    expect(html).toContain(WAVE_TICKS_SCRIPT);
    expect(html.indexOf(DETAIL_REFRESH_SCRIPT)).toBeLessThan(html.indexOf(WAVE_TICKS_SCRIPT));
  });

  it("interpolates the interval and never closes its own tag", () => {
    expect(REFRESH_INTERVAL_MS).toBe(300000);
    expect(LIVE_REFRESH_SCRIPT).toContain("const INTERVAL_MS = 300000;");
    for (const script of [LIVE_REFRESH_SCRIPT, LIST_REFRESH_SCRIPT, DETAIL_REFRESH_SCRIPT]) {
      expect(script).not.toContain("</script");
      expect(script).not.toContain("`");
    }
  });

  it("keys every refreshable block of the detail page exactly once", () => {
    const html = detailHtml({
      estimate: { color: "green", reason: "calm", sources: [], updated: NOW_ISO, waveHeightFt: 1.0,
        estimateInputs: { v: 1, alertsResolved: true, windSpeedMph: null, windGustMph: null,
          waterQualityAdvisory: null, signalSources: [] } },
      official: { color: "red", reason: "posted", official: true, source: "https://ex.gov/f", updated: NOW_ISO },
      wqfloor: { color: "yellow", reason: "Bacteria advisory", source: "County", updated: NOW_ISO },
      waves: { startIso: NOW_ISO, hoursFt: new Array(24).fill(1.0), updated: NOW_ISO },
      beach: beachWith({ webcam_player_url: "https://webcams.windy.com/p/1", webcam_title: "Pier" }),
      nearby: [{ beach: beachWith({ id: "osm-way-2", name: "Tunnel Park" }), estimate: null, official: null, distanceMi: 2 }]
    });
    const keys = ["hero", "title", "label", "verdict", "glance", "official", "estimate",
      "wqfloor", "waves", "wave-map", "webcam", "nearby"];
    for (const key of keys) {
      expect(count(html, "data-refresh=\"" + key + "\"")).toBe(1);
    }
    expect(count(html, "data-refresh=\"")).toBe(keys.length);
    // The hero is the one container: its keyed children sit inside it, and the
    // share row does not, so a refresh can never rebuild the Save control.
    const hero = html.slice(html.indexOf("data-refresh=\"hero\""), html.indexOf("id=\"favorite-toggle\""));
    expect(hero).toContain("data-refresh=\"title\"");
    expect(hero).toContain("data-refresh=\"label\"");
    expect(hero).toContain("data-refresh=\"verdict\"");
    // The official card precedes the estimate card, whose key places it.
    expect(html.indexOf("data-refresh=\"official\"")).toBeLessThan(html.indexOf("data-refresh=\"estimate\""));
  });

  it("keys nothing on the list page", () => {
    expect(renderListPage({ entries: [], nowIso: NOW_ISO })).not.toContain("data-refresh=");
  });

  it("re-runs the tick relabeller on the refreshed event, once per row", () => {
    expect(WAVE_TICKS_SCRIPT).toContain("document.addEventListener('swimreport:refreshed', relabel);");
    expect(WAVE_TICKS_SCRIPT).toContain("if (row.hasAttribute('data-relabeled')) {");
  });

  it("refills Your Beaches from stored ids on every tick, all ids fetched fresh", () => {
    expect(LIST_FAVORITES_SCRIPT).toContain("document.addEventListener('swimreport:refresh', function () {");
    expect(LIST_FAVORITES_SCRIPT).toContain("load(false);");
    expect(LIST_FAVORITES_SCRIPT).toContain("load(true);");
    expect(LIST_FAVORITES_SCRIPT).toContain("fetch(url, harvest ? {} : { cache: 'no-cache' })");
    expect(LIST_FAVORITES_SCRIPT).toContain("clearList(savedList);");
    expect(LIST_FAVORITES_SCRIPT.indexOf("const favorites = readIds(FAV_KEY);"))
      .toBeGreaterThan(LIST_FAVORITES_SCRIPT.indexOf("const load = function (harvest) {"));
  });
});

describe("refresh scheduler runtime", () => {
  function run(visibility, now) {
    const timers = [];
    const docHandlers = {};
    const winHandlers = {};
    const fired = [];
    globalThis.setInterval = (fn, ms) => { timers.push({ fn: fn, ms: ms }); return timers.length; };
    globalThis.clearInterval = (id) => { timers[id - 1].cleared = true; };
    globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
    globalThis.document = {
      visibilityState: visibility,
      dispatchEvent(event) { fired.push(event.type); },
      addEventListener(type, fn) { docHandlers[type] = fn; }
    };
    globalThis.window = { addEventListener(type, fn) { winHandlers[type] = fn; } };
    const clock = { now: now };
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    // eslint-disable-next-line no-new-func
    new Function(LIVE_REFRESH_SCRIPT)();
    return { timers: timers, docHandlers: docHandlers, winHandlers: winHandlers, fired: fired, clock: clock };
  }

  it("fires on the interval while the tab is visible", () => {
    const s = run("visible", 1000);
    expect(s.timers.length).toBe(1);
    expect(s.timers[0].ms).toBe(REFRESH_INTERVAL_MS);
    s.clock.now = 1000 + REFRESH_INTERVAL_MS;
    s.timers[0].fn();
    expect(s.fired).toEqual(["swimreport:refresh"]);
  });

  it("skips a hidden tab's tick and fires when the tab is next shown, if due", () => {
    const s = run("hidden", 1000);
    s.clock.now = 1000 + REFRESH_INTERVAL_MS;
    s.timers[0].fn();
    expect(s.fired).toEqual([]);
    // Shown again a minute later: the skipped tick is owed.
    s.clock.now = 1000 + REFRESH_INTERVAL_MS + 60000;
    globalThis.document.visibilityState = "visible";
    s.docHandlers.visibilitychange();
    expect(s.fired).toEqual(["swimreport:refresh"]);
    // That fire re-armed the interval, so the old one cannot follow it early.
    expect(s.timers.length).toBe(2);
    expect(s.timers[0].cleared).toBe(true);
    expect(s.timers[1].ms).toBe(REFRESH_INTERVAL_MS);
    // Hidden and shown again well inside the interval: nothing owed.
    s.clock.now = s.clock.now + 1000;
    s.docHandlers.visibilitychange();
    expect(s.fired).toEqual(["swimreport:refresh"]);
  });

  it("fires on a bfcache restore only when an interval has passed", () => {
    const s = run("visible", 1000);
    s.winHandlers.pageshow({ persisted: true });
    expect(s.fired).toEqual([]);
    s.clock.now = 1000 + REFRESH_INTERVAL_MS;
    s.winHandlers.pageshow({ persisted: false });
    expect(s.fired).toEqual([]);
    s.winHandlers.pageshow({ persisted: true });
    expect(s.fired).toEqual(["swimreport:refresh"]);
  });
});

describe("list swap helper values", () => {
  function run(listInner, center) {
    const docHandlers = {};
    const fired = [];
    const list = { innerHTML: listInner };
    globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
    globalThis.document = {
      getElementById(id) {
        if (id === "beach-list-items") { return list; }
        if (id === "home-map") { return center === null ? null : { getAttribute: () => center }; }
        return null;
      },
      dispatchEvent(event) { fired.push(event.type); },
      addEventListener(type, fn) { docHandlers[type] = fn; }
    };
    globalThis.window = {};
    // eslint-disable-next-line no-new-func
    new Function(LIST_SWAP_SCRIPT)();
    return { list: list, fired: fired };
  }

  it("builds the cacheable fetch URL with the map center as near when the params carry none", () => {
    run("<li>a</li>", "42.700,-86.200");
    expect(globalThis.window.__swimReportListFetchUrl(new URLSearchParams("q=oak")))
      .toBe("/?q=oak&near=42.700%2C-86.200");
    expect(globalThis.window.__swimReportListFetchUrl(new URLSearchParams("q=oak&near=1%2C2")))
      .toBe("/?q=oak&near=1%2C2");
  });

  it("leaves the URL near-less with no center to bake in", () => {
    run("<li>a</li>", null);
    expect(globalThis.window.__swimReportListFetchUrl(new URLSearchParams(""))).toBe("/?");
  });

  it("seeds the list serialization at load and rewrites it on every swap", () => {
    const s = run("<li>a</li>", null);
    expect(globalThis.window.__swimReportListHtml).toBe("<li>a</li>");
    const doc = {
      getElementById(id) { return id === "beach-list-items" ? { innerHTML: "<li>b</li>" } : null; }
    };
    expect(globalThis.window.__swimReportSwapList(doc)).toBe(true);
    expect(s.list.innerHTML).toBe("<li>b</li>");
    expect(globalThis.window.__swimReportListHtml).toBe("<li>b</li>");
    expect(s.fired).toEqual(["swimreport:listswap"]);
  });
});

describe("list refresh runtime", () => {
  function run(opts) {
    const docHandlers = {};
    const calls = { fetch: [], swap: [] };
    const listEl = { contains: () => !!opts.focusInside || !!opts.selectionInside };
    globalThis.document = {
      activeElement: opts.focusInside ? {} : null,
      getElementById(id) { return id === "beach-list-items" ? listEl : null; },
      addEventListener(type, fn) { docHandlers[type] = fn; }
    };
    globalThis.window = {
      location: { search: "?q=oak" },
      getSelection: () => (opts.selectionInside
        ? { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ commonAncestorContainer: {} }) }
        : { isCollapsed: true, rangeCount: 0 }),
      __swimReportListGen: 0,
      __swimReportListHtml: "<li>same</li>",
      __swimReportSwapList(doc) { calls.swap.push(doc); return true; },
      __swimReportListFetchUrl(params) { return "/?" + params.toString() + "&near=1%2C2"; }
    };
    globalThis.fetch = async (url, init) => {
      calls.fetch.push({ url: url, init: init });
      if (opts.bumpGen) { globalThis.window.__swimReportListGen = 1; }
      return { ok: true, status: 200, text: async () => "html" };
    };
    globalThis.DOMParser = class {
      parseFromString() {
        return { getElementById: () => ({ innerHTML: opts.listHtml }) };
      }
    };
    // eslint-disable-next-line no-new-func
    new Function(LIST_REFRESH_SCRIPT)();
    return { docHandlers: docHandlers, calls: calls };
  }

  it("fetches the cacheable list URL fresh and swaps a changed list", async () => {
    const s = run({ listHtml: "<li>new</li>" });
    s.docHandlers["swimreport:refresh"]();
    await settle();
    expect(s.calls.fetch).toEqual([{ url: "/?q=oak&near=1%2C2", init: { cache: "no-cache" } }]);
    expect(s.calls.swap.length).toBe(1);
  });

  it("leaves an unchanged list alone", async () => {
    const s = run({ listHtml: "<li>same</li>" });
    s.docHandlers["swimreport:refresh"]();
    await settle();
    expect(s.calls.fetch.length).toBe(1);
    expect(s.calls.swap.length).toBe(0);
  });

  it("drops a response overtaken by a search or geo swap", async () => {
    const s = run({ listHtml: "<li>new</li>", bumpGen: true });
    s.docHandlers["swimreport:refresh"]();
    await settle();
    expect(s.calls.swap.length).toBe(0);
  });

  it("defers while a text selection sits inside the list", async () => {
    const s = run({ listHtml: "<li>new</li>", selectionInside: true });
    s.docHandlers["swimreport:refresh"]();
    await settle();
    expect(s.calls.fetch.length).toBe(1);
    expect(s.calls.swap.length).toBe(0);
  });

  it("defers while focus is inside the list, and never stacks ticks", async () => {
    const s = run({ listHtml: "<li>new</li>", focusInside: true });
    s.docHandlers["swimreport:refresh"]();
    s.docHandlers["swimreport:refresh"]();
    await settle();
    expect(s.calls.fetch.length).toBe(1);
    expect(s.calls.swap.length).toBe(0);
  });
});

// A fake DOM implementing only what detailRefreshScript.js touches: keyed
// lookup, sibling walks, serialization, attribute sync and the four mutation
// calls. Selectors cover a tag, classes and [attr] / [attr="value"] parts.
class FakeText {
  constructor(text) { this.text = text; this.parent = null; }
  get outerHTML() { return this.text; }
  clone() { return new FakeText(this.text); }
}

class FakeEl {
  constructor(tag, attrs, children) {
    this.tag = tag;
    this.attrs = Object.assign({}, attrs || {});
    this.children = [];
    this.parent = null;
    for (const child of children || []) {
      this.appendChild(typeof child === "string" ? new FakeText(child) : child);
    }
  }
  appendChild(node) { node.parent = this; this.children.push(node); return node; }
  get attributes() {
    return Object.keys(this.attrs).map((name) => ({ name: name, value: this.attrs[name] }));
  }
  getAttribute(name) { return this.hasAttribute(name) ? this.attrs[name] : null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  get outerHTML() {
    const attrs = Object.keys(this.attrs).map((n) => " " + n + "=\"" + this.attrs[n] + "\"").join("");
    return "<" + this.tag + attrs + ">" + this.children.map((c) => c.outerHTML).join("") + "</" + this.tag + ">";
  }
  get elementChildren() { return this.children.filter((c) => c instanceof FakeEl); }
  get textContent() {
    return this.children.map((c) => (c instanceof FakeEl ? c.textContent : c.text)).join("");
  }
  get previousElementSibling() {
    const sibs = this.parent.elementChildren;
    const i = sibs.indexOf(this);
    return i > 0 ? sibs[i - 1] : null;
  }
  get nextElementSibling() {
    const sibs = this.parent.elementChildren;
    const i = sibs.indexOf(this);
    return i < sibs.length - 1 ? sibs[i + 1] : null;
  }
  matches(selector) {
    const m = selector.match(/^([a-z0-9-]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/);
    if (!m) { throw new Error("unsupported selector " + selector); }
    if (m[1] && m[1] !== this.tag) { return false; }
    for (const cls of m[2].split(".").filter(Boolean)) {
      if ((this.getAttribute("class") || "").split(" ").indexOf(cls) === -1) { return false; }
    }
    for (const part of m[3].split("]").filter(Boolean)) {
      const inner = part.slice(1);
      const eq = inner.indexOf("=");
      if (eq === -1) {
        if (!this.hasAttribute(inner)) { return false; }
      } else if (this.getAttribute(inner.slice(0, eq)) !== inner.slice(eq + 1).replace(/^"|"$/g, "")) {
        return false;
      }
    }
    return true;
  }
  querySelectorAll(selector) {
    const out = [];
    for (const child of this.elementChildren) {
      if (child.matches(selector)) { out.push(child); }
      out.push(...child.querySelectorAll(selector));
    }
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) {
    if (node === this) { return true; }
    return this.children.some((c) => c === node || (c instanceof FakeEl && c.contains(node)));
  }
  insertSibling(node, offset) {
    const i = this.parent.children.indexOf(this);
    node.parent = this.parent;
    this.parent.children.splice(i + offset, 0, node);
  }
  after(node) { this.insertSibling(node, 1); }
  before(node) { this.insertSibling(node, 0); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  replaceWith(node) { this.after(node); this.remove(); }
  clone() { return new FakeEl(this.tag, this.attrs, this.children.map((c) => c.clone())); }
}

function el(tag, attrs, children) { return new FakeEl(tag, attrs, children); }

// A detail page with the keyed blocks render.js emits, in the same nesting.
function page(o) {
  const hero = el("section", { class: "detail-hero", "data-flag": o.flag, "data-refresh": "hero" }, [
    el("a", { class: "back-link", href: "/" }, ["Back"]),
    el("h1", { class: "beach-title", "data-refresh": "title" }, [el("wa-icon", { class: "flag-icon-" + o.flag }), "Ottawa Beach"]),
    el("p", { class: "wa-cluster", "data-refresh": "label" }, [o.label]),
    o.verdict ? el("p", { "data-refresh": "verdict" }, [o.verdict]) : null,
    el("div", { class: "actions" }, [el("wa-button", { id: "favorite-toggle", "aria-pressed": "true" })])
  ].filter(Boolean));
  const verdictColumn = el("div", { class: "wa-stack" }, [
    o.official ? el("wa-card", { class: "official-card", "data-refresh": "official" }, [o.official]) : null,
    el("wa-card", { class: "estimate-card", "data-refresh": "estimate" }, [
      o.estimate,
      o.slotted
        ? el("wa-details", o.open ? { open: "" } : {}, [el("span", { slot: "summary" }, ["Beach Hazards Statement"]), "x"])
        : el("wa-details", Object.assign({ summary: "Alert details" }, o.open ? { open: "" } : {}), ["x"])
    ]),
    o.wqfloor ? el("wa-callout", { "data-refresh": "wqfloor" }, [o.wqfloor]) : null,
    o.waves ? el("section", { class: "wave-forecast", "data-refresh": "waves" }, [o.waves]) : null
  ].filter(Boolean));
  const exploreColumn = el("div", { class: "wa-stack" }, [
    el("section", { class: "wave-map", "data-refresh": "wave-map" }, [el("iframe", { src: "https://embed.windy.com/embed.html?lat=1" })]),
    o.nearby ? el("section", { "data-refresh": "nearby" }, [o.nearby]) : null
  ].filter(Boolean));
  const main = el("main", { class: "app-main detail-main" }, [
    hero,
    el("wa-details", { summary: "What the flags mean" }, ["legend"]),
    el("div", { class: "detail-columns" }, [verdictColumn, exploreColumn])
  ]);
  return el("html", {}, [
    el("head", {}, [el("link", { rel: "icon", href: o.icon || "data:green" })]),
    el("body", {}, [main])
  ]);
}

const BASE = { flag: "green", label: "GREEN", verdict: "Calm water.", estimate: "calm" };

describe("detail refresh runtime", () => {
  function run(live, fresh, opts) {
    const docHandlers = {};
    const fired = [];
    const logs = [];
    const fetches = [];
    globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
    globalThis.document = {
      activeElement: (opts && opts.activeElement) || null,
      querySelectorAll: (s) => live.querySelectorAll(s),
      querySelector: (s) => live.querySelector(s),
      importNode: (node) => node.clone(),
      dispatchEvent(event) { fired.push(event.type); },
      addEventListener(type, fn) { docHandlers[type] = fn; }
    };
    globalThis.window = {
      location: { pathname: "/beach/w505668572" },
      getSelection: () => ((opts && opts.selection) || { isCollapsed: true, rangeCount: 0 })
    };
    globalThis.fetch = async (url, init) => {
      fetches.push({ url: url, init: init });
      return { ok: true, status: 200, text: async () => "fresh" };
    };
    globalThis.DOMParser = class { parseFromString() { return fresh; } };
    globalThis.console = Object.assign({}, REAL_CONSOLE, { log: (m) => { logs.push(String(m)); } });
    // eslint-disable-next-line no-new-func
    new Function(DETAIL_REFRESH_SCRIPT)();
    return {
      tick: async () => { docHandlers["swimreport:refresh"](); await settle(); },
      fired: fired, logs: logs, fetches: fetches
    };
  }

  function keyed(root, key) { return root.querySelector("[data-refresh=\"" + key + "\"]"); }

  it("replaces the blocks that changed and leaves the rest untouched", async () => {
    const live = page(BASE);
    const fresh = page(Object.assign({}, BASE, { flag: "red", label: "RED", verdict: "High rip current risk.", estimate: "waves" }));
    const hero = keyed(live, "hero");
    const save = live.querySelector("[id=\"favorite-toggle\"]");
    const waveMap = keyed(live, "wave-map");
    const legend = live.querySelector("wa-details[summary=\"What the flags mean\"]");
    const s = run(live, fresh);
    await s.tick();

    expect(s.fetches).toEqual([{ url: "/beach/w505668572", init: { cache: "no-cache" } }]);
    // The hero itself is synced, never rebuilt: same node, new wash, same Save.
    expect(keyed(live, "hero")).toBe(hero);
    expect(hero.getAttribute("data-flag")).toBe("red");
    expect(live.querySelector("[id=\"favorite-toggle\"]")).toBe(save);
    expect(keyed(live, "title").outerHTML).toContain("flag-icon-red");
    expect(keyed(live, "label").outerHTML).toContain("RED");
    expect(keyed(live, "verdict").outerHTML).toContain("High rip current risk.");
    expect(keyed(live, "estimate").outerHTML).toContain("waves");
    // The unchanged iframe block and the unkeyed legend are the same nodes.
    expect(keyed(live, "wave-map")).toBe(waveMap);
    expect(live.querySelector("wa-details[summary=\"What the flags mean\"]")).toBe(legend);
    expect(s.fired).toEqual(["swimreport:refreshed"]);
  });

  it("does not rebuild a block whose markup came back identical", async () => {
    const live = page(BASE);
    const fresh = page(BASE);
    const estimate = keyed(live, "estimate");
    const title = keyed(live, "title");
    const s = run(live, fresh);
    await s.tick();
    expect(keyed(live, "estimate")).toBe(estimate);
    expect(keyed(live, "title")).toBe(title);
  });

  it("inserts a newly posted official before the estimate and drops a lifted advisory", async () => {
    const live = page(Object.assign({}, BASE, { wqfloor: "Bacteria advisory" }));
    const fresh = page(Object.assign({}, BASE, { official: "posted red" }));
    const s = run(live, fresh);
    await s.tick();
    const column = keyed(live, "estimate").parent;
    expect(column.elementChildren.map((c) => c.getAttribute("data-refresh"))).toEqual(["official", "estimate"]);
    expect(keyed(live, "official").outerHTML).toContain("posted red");
    expect(keyed(live, "wqfloor")).toBeNull();
    // A second tick with the same page changes nothing more.
    const official = keyed(live, "official");
    await s.tick();
    expect(keyed(live, "official")).toBe(official);
  });

  it("places a raised advisory after the estimate card", async () => {
    const live = page(BASE);
    const fresh = page(Object.assign({}, BASE, { wqfloor: "Bacteria advisory", waves: "strip" }));
    const s = run(live, fresh);
    await s.tick();
    const column = keyed(live, "estimate").parent;
    expect(column.elementChildren.map((c) => c.getAttribute("data-refresh"))).toEqual(["estimate", "wqfloor", "waves"]);
  });

  it("leaves a block the visitor is inside for the next tick", async () => {
    const live = page(BASE);
    const fresh = page(Object.assign({}, BASE, { estimate: "waves", label: "RED" }));
    const estimate = keyed(live, "estimate");
    const s = run(live, fresh, { activeElement: estimate.querySelector("wa-details") });
    await s.tick();
    expect(keyed(live, "estimate")).toBe(estimate);
    expect(keyed(live, "label").outerHTML).toContain("RED");
  });

  it("leaves a block holding the visitor's selection", async () => {
    const live = page(BASE);
    const fresh = page(Object.assign({}, BASE, { estimate: "waves" }));
    const estimate = keyed(live, "estimate");
    const s = run(live, fresh, {
      selection: { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ commonAncestorContainer: estimate.children[0] }) }
    });
    await s.tick();
    expect(keyed(live, "estimate")).toBe(estimate);
  });

  it("keeps an expander the visitor opened open across a rebuild", async () => {
    const live = page(Object.assign({}, BASE, { open: true }));
    const fresh = page(Object.assign({}, BASE, { estimate: "waves" }));
    const s = run(live, fresh);
    await s.tick();
    const details = keyed(live, "estimate").querySelector("wa-details");
    expect(details.hasAttribute("open")).toBe(true);
    expect(keyed(live, "estimate").outerHTML).toContain("waves");
  });

  it("keeps an alert expander open, keyed by its slotted summary text", async () => {
    const live = page(Object.assign({}, BASE, { open: true, slotted: true }));
    const fresh = page(Object.assign({}, BASE, { estimate: "waves", slotted: true }));
    const s = run(live, fresh);
    await s.tick();
    const details = keyed(live, "estimate").querySelector("wa-details");
    expect(details.hasAttribute("open")).toBe(true);
    expect(keyed(live, "estimate").outerHTML).toContain("waves");
  });

  it("follows the tab icon to the fresh page's color", async () => {
    const live = page(BASE);
    const fresh = page(Object.assign({}, BASE, { icon: "data:red" }));
    const s = run(live, fresh);
    await s.tick();
    expect(live.querySelector("link[rel=\"icon\"]").getAttribute("href")).toBe("data:red");
  });

  it("changes nothing on a response that is not a detail page", async () => {
    const live = page(BASE);
    const before = live.outerHTML;
    const fresh = el("html", {}, [el("body", {}, [el("main", { class: "app-main" }, ["Not found"])])]);
    const s = run(live, fresh);
    await s.tick();
    expect(live.outerHTML).toBe(before);
    expect(s.fired).toEqual([]);
    expect(s.logs).toEqual(["detail refresh failed: not a detail page"]);
  });

  it("changes nothing on a failed fetch", async () => {
    const live = page(BASE);
    const before = live.outerHTML;
    const s = run(live, page(Object.assign({}, BASE, { estimate: "waves" })));
    globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => "" });
    await s.tick();
    expect(live.outerHTML).toBe(before);
    expect(s.logs).toEqual(["detail refresh failed: unexpected status 404"]);
  });
});
