// Executes the generated home-page map script against stub MapLibre and DOM
// objects. renderHomeMap.test.js asserts on the script's text, which cannot see
// a script that parses and then throws: a const ordered after the ramp that
// reads it dies on the temporal dead zone and takes the whole map with it.
//
// The stubs are deliberately thin. This covers what the script does to a map,
// not what MapLibre does with it.

import { describe, it, expect, afterEach } from "vitest";
import { buildListMapScript } from "../src/frontend/mapScript.js";
import { distanceKm } from "../src/geo.js";

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

// Three beaches within about 10 km of Ottawa Beach and one across the lake in
// Chicago, so a center on the Michigan shore has a tight nearest-three box and
// an inland center reaches the whole set.
const FEATURES = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [-86.2, 42.7] },
      properties: { id: "beach-1", name: "Ottawa Beach", flag: "green" } },
    { type: "Feature", geometry: { type: "Point", coordinates: [-87.6, 41.9] },
      properties: { id: "beach-2", name: "Oak Street", flag: "red" } },
    { type: "Feature", geometry: { type: "Point", coordinates: [-86.21, 42.78] },
      properties: { id: "beach-3", name: "Holland State Park", flag: "yellow" } },
    { type: "Feature", geometry: { type: "Point", coordinates: [-86.15, 42.65] },
      properties: { id: "beach-4", name: "Kirk Park", flag: "green" } }
  ]
};

// Half-height of a fitBounds box in km, the measure the script's box is built
// from (the box is symmetric about the center, so this is its radius).
function boxRadiusKm(bounds) {
  return (bounds[1][1] - bounds[0][1]) / 2 * 111.32;
}

// Distance, with the script's 1.2 margin, from a center to the third-nearest
// of FEATURES: what the script's box radius has to come out to.
function expectedRadiusKm(lat, lon) {
  const ds = FEATURES.features
    .map((f) => distanceKm(lat, lon, f.geometry.coordinates[1], f.geometry.coordinates[0]))
    .sort((a, b) => a - b);
  return ds[2] * 1.2;
}

// attrs are the #home-map attributes the script reads (data-center and
// data-center-precise); the object is live, so a test can rewrite it before
// dispatching a nearupdate the way geoScript.js does.
function makeStubs(propertyValue, attrs) {
  const mapAttrs = attrs || {};
  const added = { sources: {}, layers: [], before: [], images: [], fits: [] };
  const handlers = [];
  const docHandlers = [];
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
    fitBounds(b, o) { added.fits.push({ bounds: b, options: o }); },
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
      ? {
        getAttribute: (name) => (Object.prototype.hasOwnProperty.call(mapAttrs, name) ? mapAttrs[name] : null),
        querySelector: () => null
      }
      : null),
    createElement: () => ({ getContext: () => ctx, set width(_w) {}, set height(_h) {} }),
    addEventListener(type, fn) { docHandlers.push({ type: type, fn: fn }); }
  };
  globalThis.console = Object.assign({}, REAL_CONSOLE, {
    log: (m) => { logs.push(String(m)); }
  });

  return { added: added, handlers: handlers, docHandlers: docHandlers, logs: logs, nav: nav, attrs: mapAttrs };
}

// Runs the script and drives it to the point where the layers exist: the map's
// load event, then the icon decode and the directory fetch it chains.
async function runScript(propertyValue, attrs) {
  const stubs = makeStubs(propertyValue, attrs);
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

  it("strips the comment Firefox keeps in a custom property's computed value", async () => {
    // The kit declares each palette token as a hex followed by an oklch comment.
    // Firefox returns the comment with the value, and "#4f8051 /* oklch(...) */"
    // is as fatal to addLayer as an unresolved var().
    const s = await runScript("#4f8051 /* oklch(55.201% 0.08939 145.16) */");
    const colors = s.added.layers
      .filter((l) => l.type === "circle")
      .map((l) => l.paint["circle-color"]);
    colors.forEach((c) => expect(c).toBe("#4f8051"));
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
    expect(s.logs).toContain("map directory: 4 features");
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

  it("fits the whole directory when the page carries no center", async () => {
    const s = await runScript("#4f8051");
    expect(s.added.fits.length).toBe(1);
    expect(s.added.fits[0].options).toEqual({ padding: 40, maxZoom: 10, animate: false });
  });

  it("opens a coastal visitor on a box around the nearest three beaches, capped at the fix zoom", async () => {
    const s = await runScript("#4f8051", { "data-center": "42.700,-86.200", "data-center-precise": "1" });
    expect(s.added.fits.length).toBe(1);
    const fit = s.added.fits[0];
    expect(fit.options).toEqual({ padding: 40, maxZoom: 10, animate: false });
    const km = boxRadiusKm(fit.bounds);
    expect(km).toBeCloseTo(expectedRadiusKm(42.7, -86.2), 0);
    // A box a few km wide: the cap, not the box, decides the zoom here.
    expect(km).toBeLessThan(15);
    // Symmetric about the visitor, so the fit keeps them centered.
    expect((fit.bounds[0][0] + fit.bounds[1][0]) / 2).toBeCloseTo(-86.2, 6);
    expect((fit.bounds[0][1] + fit.bounds[1][1]) / 2).toBeCloseTo(42.7, 6);
  });

  it("opens an inland visitor zoomed out to the nearest coast", async () => {
    // Indianapolis: the nearest coast is Lake Michigan, some 300 km north.
    const s = await runScript("#4f8051", { "data-center": "39.770,-86.160", "data-center-precise": "0" });
    expect(s.added.fits.length).toBe(1);
    const fit = s.added.fits[0];
    expect(fit.options.maxZoom).toBe(9);
    const km = boxRadiusKm(fit.bounds);
    expect(km).toBeCloseTo(expectedRadiusKm(39.77, -86.16), 0);
    expect(km).toBeGreaterThan(300);
  });

  it("fits at construction when the directory lands before the module", async () => {
    const stubs = makeStubs("#4f8051", { "data-center": "42.700,-86.200", "data-center-precise": "1" });
    const mod = globalThis.__maplibre;
    // Promise.resolve adopts a promise, so a delayed module import is one that
    // resolves after the (immediate) stub fetch has landed.
    globalThis.__maplibre = new Promise((r) => setTimeout(() => r(mod), 20));
    // eslint-disable-next-line no-new-func
    new Function(scriptWithStubModule())();
    await new Promise((r) => setTimeout(r, 50));
    // Fitted before the load event, so before the first render.
    expect(stubs.added.fits.length).toBe(1);
    expect(stubs.added.fits[0].options.animate).toBe(false);
    stubs.handlers.filter((h) => h.type === "load").forEach((h) => h.fn());
    await new Promise((r) => setTimeout(r, 50));
    // The load chain adds the layers but does not fit a second time.
    expect(stubs.added.layers.length).toBe(5);
    expect(stubs.added.fits.length).toBe(1);
  });

  it("refits around a browser fix, animated, and only eases while the directory is in flight", async () => {
    const stubs = makeStubs("#4f8051", { "data-center": "39.770,-86.160", "data-center-precise": "0" });
    let releaseFetch;
    globalThis.fetch = () => new Promise((r) => { releaseFetch = r; });
    // eslint-disable-next-line no-new-func
    new Function(scriptWithStubModule())();
    await new Promise((r) => setTimeout(r, 50));
    const nearupdate = stubs.docHandlers.find((h) => h.type === "swimreport:nearupdate");
    expect(nearupdate).toBeTruthy();

    // geoScript.js rewrites the attributes and dispatches; with no directory yet
    // the map can only ease to the fix at its cap.
    stubs.attrs["data-center"] = "42.700,-86.200";
    stubs.attrs["data-center-precise"] = "1";
    nearupdate.fn();
    expect(stubs.added.fits.length).toBe(0);
    expect(stubs.added.easeTo).toEqual({ center: [-86.2, 42.7], zoom: 10 });

    releaseFetch({ ok: true, json: async () => FEATURES });
    await new Promise((r) => setTimeout(r, 50));
    stubs.handlers.filter((h) => h.type === "load").forEach((h) => h.fn());
    await new Promise((r) => setTimeout(r, 50));
    // The load chain widens the eased view once the directory lands.
    expect(stubs.added.fits.length).toBe(1);
    expect(stubs.added.fits[0].options).toEqual({ padding: 40, maxZoom: 10, animate: false });

    // A later fix refits around the new center, animated, at the coarser cap.
    stubs.attrs["data-center"] = "39.770,-86.160";
    stubs.attrs["data-center-precise"] = "0";
    nearupdate.fn();
    expect(stubs.added.fits.length).toBe(2);
    expect(stubs.added.fits[1].options).toEqual({ padding: 40, maxZoom: 9, animate: true });
    expect(boxRadiusKm(stubs.added.fits[1].bounds)).toBeCloseTo(expectedRadiusKm(39.77, -86.16), 0);
  });
});
