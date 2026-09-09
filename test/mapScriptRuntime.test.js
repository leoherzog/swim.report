// Executes the generated home-page map script against stub MapLibre and DOM
// objects. renderHomeMap.test.js asserts on the script's text, which cannot see
// a script that parses and then throws: a const ordered after the ramp that
// reads it dies on the temporal dead zone and takes the whole map with it.
//
// The stubs are deliberately thin. This covers what the script does to a map,
// not what MapLibre does with it.

import { describe, it, expect, afterEach } from "vitest";
import { buildListMapScript } from "../src/frontend/mapScript.js";

// Vitest routes dynamic import() through Vite, which will not resolve a data:
// URL, so the script's one import line is swapped for an already-resolved stub
// module. Everything else runs verbatim, ordering included. The import wiring
// itself is covered textually in renderHomeMap.test.js.
const IMPORT_LINE = "import(MAPLIBRE_MODULE_URL).then(startMap).catch(clearSkeleton);";

function scriptWithStubModule() {
  const src = buildListMapScript("unused://maplibre");
  if (src.split(IMPORT_LINE).length !== 2) {
    throw new Error("map script no longer ends with the expected import line");
  }
  return src.replace(IMPORT_LINE,
    "Promise.resolve(globalThis.__maplibre).then(startMap).catch(clearSkeleton);");
}

// Captured before any test swaps globalThis.console for a log collector.
const REAL_CONSOLE = console;

const FEATURES = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [-86.2, 42.7] },
      properties: { id: "beach-1", name: "Ottawa Beach", flag: "green" } },
    { type: "Feature", geometry: { type: "Point", coordinates: [-87.6, 41.9] },
      properties: { id: "beach-2", name: "Oak Street", flag: "red" } }
  ]
};

function makeStubs(propertyValue) {
  const added = { sources: {}, layers: [], before: [], images: [] };
  const handlers = [];
  const logs = [];
  const nav = { href: null };

  const ctx = {
    clearRect() {}, drawImage() {}, fillRect() {},
    getImageData: () => ({ width: 1, height: 1, data: new Uint8Array(4) })
  };
  const style = { layers: [{ id: "water", type: "fill" }, { id: "labels", type: "symbol" }] };

  const map = {
    addSource(id, spec) { added.sources[id] = spec; },
    addLayer(spec, beforeId) { added.layers.push(spec); added.before.push(beforeId); },
    getStyle: () => style,
    on(type, a, b) { handlers.push({ type: type, layer: b ? a : null, fn: b || a }); },
    getCanvas: () => ({ setAttribute() {}, style: {} }),
    hasImage: () => false,
    addImage(id) { added.images.push(id); },
    setMissingStyleImageResolver() {},
    getSource: (id) => added.sources[id],
    fitBounds() { added.fitBounds = true; },
    easeTo(o) { added.easeTo = o; },
    getZoom: () => added.zoom
  };
  added.zoom = 5;

  globalThis.__maplibre = {
    Map: function () { return map; },
    LngLatBounds: function () { this.extend = function () {}; }
  };
  globalThis.window = { devicePixelRatio: 2, location: nav };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => propertyValue });
  globalThis.Image = class {
    set src(_v) { setTimeout(() => { if (this.onload) { this.onload(); } }, 0); }
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => FEATURES });
  globalThis.document = {
    getElementById: (id) => (id === "home-map"
      ? { getAttribute: () => null, querySelector: () => null }
      : null),
    createElement: () => ({ getContext: () => ctx, set width(_w) {}, set height(_h) {} }),
    addEventListener() {}
  };
  globalThis.console = Object.assign({}, REAL_CONSOLE, {
    log: (m) => { logs.push(String(m)); }
  });

  return { added: added, handlers: handlers, logs: logs, nav: nav };
}

// Runs the script and drives it to the point where the layers exist: the map's
// load event, then the icon decode and the directory fetch it chains.
async function runScript(propertyValue) {
  const stubs = makeStubs(propertyValue);
  // eslint-disable-next-line no-new-func
  new Function(scriptWithStubModule())();
  await new Promise((r) => setTimeout(r, 50));
  stubs.handlers.filter((h) => h.type === "load").forEach((h) => h.fn());
  await new Promise((r) => setTimeout(r, 50));
  return stubs;
}

afterEach(() => {
  delete globalThis.__maplibre;
  delete globalThis.window;
  delete globalThis.getComputedStyle;
  delete globalThis.Image;
  delete globalThis.fetch;
  delete globalThis.document;
  globalThis.console = REAL_CONSOLE;
});

describe("map script runtime", () => {
  it("runs to completion and adds every layer", async () => {
    const s = await runScript("#4f8051");
    const ids = s.added.layers.map((l) => l.id);
    expect(ids).toEqual([
      "highlight-unknown", "highlight-green", "highlight-yellow", "highlight-red", "flags"
    ]);
    expect(Object.keys(s.added.sources)).toEqual(["beaches"]);
    // Worst-on-top is paint order, so the four highlights must be added before
    // the flags and in severity order.
    expect(s.added.layers[4].type).toBe("symbol");
    // The highlights go under the style's first symbol layer; the flags on top.
    expect(s.added.before.slice(0, 4)).toEqual(["labels", "labels", "labels", "labels"]);
    expect(s.added.before[4]).toBeUndefined();
    expect(s.added.images).toEqual(["flag-green", "flag-yellow", "flag-red", "flag-unknown"]);
  });

  it("survives a custom property that comes back as an unresolved var()", async () => {
    // The kit stylesheets the --wa-color-* tokens live in are a third-party CDN.
    // An engine that returns the literal var() token rather than an empty string
    // would otherwise hand circle-color a value addLayer throws on, and every
    // highlight layer would vanish with the map still drawing its basemap.
    const s = await runScript("var(--wa-color-green-50)");
    expect(s.added.layers.map((l) => l.id)).toContain("highlight-red");
    const colors = s.added.layers
      .filter((l) => l.type === "circle")
      .map((l) => l.paint["circle-color"]);
    expect(colors).toEqual(["#777478", "#4f8051", "#c6ad4f", "#cf443b"]);
    colors.forEach((c) => expect(c).not.toContain("var("));
  });

  it("takes the resolved theme color when the property does resolve", async () => {
    const s = await runScript("#123456");
    const colors = s.added.layers
      .filter((l) => l.type === "circle")
      .map((l) => l.paint["circle-color"]);
    colors.forEach((c) => expect(c).toBe("#123456"));
  });

  it("zooms in on a merged highlight and navigates from a separated one", async () => {
    const s = await runScript("#4f8051");
    const click = s.handlers.find((h) => h.type === "click" && h.layer === "highlight-green");
    const event = { lngLat: { lng: -86.2, lat: 42.7 }, features: [{ properties: { id: "beach-1" } }] };

    s.added.zoom = 5;
    click.fn(event);
    expect(s.added.easeTo).toEqual({ center: event.lngLat, zoom: 9 });
    expect(s.nav.href).toBeNull();

    s.added.zoom = 11;
    click.fn(event);
    expect(s.nav.href).toBe("/beach/beach-1");
  });

  it("navigates from a flag click", async () => {
    const s = await runScript("#4f8051");
    const click = s.handlers.find((h) => h.type === "click" && h.layer === "flags");
    click.fn({ features: [{ properties: { id: "beach-2" } }] });
    expect(s.nav.href).toBe("/beach/beach-2");
  });

  it("names the feature count so a silent map has one line to check", async () => {
    const s = await runScript("#4f8051");
    expect(s.logs).toContain("map directory: 2 features");
  });

  it("logs rather than swallows a failed directory fetch", async () => {
    const stubs = makeStubs("#4f8051");
    globalThis.fetch = async () => { throw new Error("network down"); };
    // eslint-disable-next-line no-new-func
    new Function(scriptWithStubModule())();
    await new Promise((r) => setTimeout(r, 50));
    stubs.handlers.filter((h) => h.type === "load").forEach((h) => h.fn());
    await new Promise((r) => setTimeout(r, 50));
    expect(stubs.logs.some((l) => l.indexOf("map directory failed: network down") === 0)).toBe(true);
    expect(stubs.added.layers).toEqual([]);
  });
});
