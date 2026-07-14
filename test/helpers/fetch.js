// test/helpers/fetch.js
// Shared globalThis.fetch stubbing scaffold for client tests. Built on
// vi.stubGlobal (per Vitest's documented mocking API) instead of manually
// saving/restoring globalThis.fetch. Callers still own their own
// afterEach(function () { vi.unstubAllGlobals(); }) so cleanup runs even if
// a test throws before installFetch is called.
import { vi } from "vitest";

// A minimal fetch Response stand-in whose json() resolves to data.
export function jsonResponse(data) {
  return {
    ok: true,
    json: function () {
      return Promise.resolve(data);
    }
  };
}

// Stubs globalThis.fetch to call handler(url, init) and records every call
// as { url, init } in the array this returns, so tests can assert on
// requested URLs and request options without hand-rolling the same tracking
// array per file.
export function installFetch(handler) {
  const calls = [];
  vi.stubGlobal("fetch", function (url, init) {
    calls.push({ url: url, init: init });
    return handler(url, init);
  });
  return calls;
}
