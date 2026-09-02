// Guards the Worker ENTRY module's export shape.
//
// workerd treats every named export of the entry module (src/index.js, the
// wrangler.toml `main`) as a potential entrypoint and rejects any that is not a
// function or an ExportedHandler. A single "export const FOO = 123" there kills
// the Worker at STARTUP:
//
//   Uncaught TypeError: Incorrect type for map entry 'FOO': the provided value
//   is not of type 'function or ExportedHandler'.
//
// Nothing else in CI sees this: the module imports fine under vitest, and
// `wrangler deploy --dry-run` only bundles — it never boots the runtime. So the
// failure shows up at `npm run dev` or, worse, on a real deploy. Shared
// constants belong in a plain module (src/demandWindow.js) that src/index.js
// imports.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as workerEntry from "../src/index.js";

describe("Worker entry module exports", function () {
  it("exports a default handler object", function () {
    expect(typeof workerEntry.default).toBe("object");
    expect(typeof workerEntry.default.fetch).toBe("function");
    expect(typeof workerEntry.default.scheduled).toBe("function");
  });

  it("has no non-function named export (workerd rejects them at startup)", function () {
    const offenders = [];
    const names = Object.keys(workerEntry);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (name === "default") {
        continue;
      }
      const value = workerEntry[name];
      if (typeof value !== "function") {
        offenders.push(name + " (" + typeof value + ")");
      }
    }
    // If this fails: move the constant into its own module and import it here,
    // the way src/demandWindow.js holds HOT_VIEW_WINDOW_MS.
    expect(offenders).toEqual([]);
    // Sanity: the assertion above is only meaningful while there is something
    // to check — src/index.js does export helpers (e.g. sleep) for tests.
    expect(names.length).toBeGreaterThan(1);
  });
});

// Guards the TWO-PATH RULE against the prebuilt-layer migration.
//
// The layer pipeline (src/layer*.js, scripts/lib/fgbReader.js) reads FlatGeobuf
// files and is OFFLINE-ONLY: it runs in the Deno batch under GitHub Actions and
// must never become reachable from the Worker. Two things break if it does. The
// flatgeobuf dependency resolves through a Deno-only import map that workerd
// cannot load, so the Worker would fail at startup rather than at test time; and
// more importantly, the request path is contractually limited to D1 and KV, so a
// module that opens layer bytes has no business in its import closure.
//
// Static analysis, deliberately: importing src/index.js and inspecting it at
// runtime would only catch what the module graph happens to evaluate. Walking
// the import statements catches a module that is imported but lazily used.
describe("Worker import closure (two-path rule)", function () {
  const SRC_ROOT = new URL("../src/", import.meta.url);

  // Collect every specifier in a module's import/export-from statements. A
  // regex is enough here: this repo is plain ES modules with static imports and
  // no dynamic import() in src/, which the assertion below re-checks.
  function specifiersOf(source) {
    const found = [];
    const re = /(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|[\s;}])import\s*["']([^"']+)["']/g;
    let match = re.exec(source);
    while (match !== null) {
      found.push(match[1] || match[2]);
      match = re.exec(source);
    }
    return found;
  }

  function walkFromIndex() {
    const seen = new Set();
    const bare = new Map();
    const queue = ["index.js"];
    while (queue.length > 0) {
      const rel = queue.shift();
      if (seen.has(rel)) {
        continue;
      }
      seen.add(rel);
      const source = readFileSync(new URL(rel, SRC_ROOT), "utf8");
      const specifiers = specifiersOf(source);
      for (let i = 0; i < specifiers.length; i++) {
        const spec = specifiers[i];
        if (spec.charAt(0) !== ".") {
          // A bare or absolute specifier: npm package, node: builtin, etc.
          const importers = bare.get(spec) || [];
          importers.push(rel);
          bare.set(spec, importers);
          continue;
        }
        // Resolve relative to the importing module, then back to src-relative.
        const abs = new URL(spec, new URL(rel, SRC_ROOT));
        const resolved = abs.href.slice(SRC_ROOT.href.length);
        queue.push(resolved);
      }
    }
    return { modules: seen, bare: bare };
  }

  it("never reaches flatgeobuf or any offline layer module from src/index.js", function () {
    const walked = walkFromIndex();

    // 1. No npm/bare specifier naming the layer reader's dependency.
    const bareOffenders = [];
    walked.bare.forEach(function (importers, spec) {
      if (spec.indexOf("flatgeobuf") !== -1) {
        bareOffenders.push(spec + " imported by " + importers.join(", "));
      }
    });
    expect(bareOffenders).toEqual([]);

    // 2. No offline layer module in the closure. These are Deno-batch modules;
    //    if one shows up here, something in the request or cron path started
    //    importing the layer pipeline.
    const offlineOffenders = [];
    walked.modules.forEach(function (rel) {
      if (/^layer[A-Z]/.test(rel) || rel.indexOf("lib/fgbReader") !== -1) {
        offlineOffenders.push(rel);
      }
    });
    expect(offlineOffenders).toEqual([]);

    // 3. The walk is only meaningful if it actually traversed the Worker. If a
    //    refactor ever makes src/index.js import nothing relatively, this pins
    //    the failure here rather than letting the assertions above pass vacuously.
    expect(walked.modules.size).toBeGreaterThan(20);
    expect(walked.modules.has("router.js")).toBe(true);
    expect(walked.modules.has("rules.js")).toBe(true);
  });

  it("uses no real dynamic import() in src/, which would evade the static walk", function () {
    const walked = walkFromIndex();
    const dynamic = [];
    walked.modules.forEach(function (rel) {
      const source = readFileSync(new URL(rel, SRC_ROOT), "utf8");
      // Comments and string literals must come out first. src/frontend/mapScript.js
      // legitimately contains the text import(MAPLIBRE_MODULE_URL) inside a STRING —
      // it is browser-side inline script for MapLibre's ESM-only build, not a module
      // edge in this graph — and several modules discuss dynamic import in prose.
      let code = source.replace(/\/\*[\s\S]*?\*\//g, " ");
      code = code.replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1 ");
      code = code.replace(/"(?:[^"\\]|\\.)*"/g, "\"\"");
      code = code.replace(/'(?:[^'\\]|\\.)*'/g, "''");
      if (/[^A-Za-z0-9_$.]import\s*\(/.test(code)) {
        dynamic.push(rel);
      }
    });
    expect(dynamic).toEqual([]);
  });
});
