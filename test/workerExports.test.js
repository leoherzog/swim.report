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
