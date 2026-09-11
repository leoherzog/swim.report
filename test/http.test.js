// Tests for src/clients/http.js#fetchJson — the shared transport/error layer
// every client in src/clients/ builds on. Contract under test: parsed JSON on
// success; null (never a throw) on non-2xx, transport rejection, or JSON
// parse failure, each logged via console.log with the caller's label prefix;
// method/headers/body passed through to fetch verbatim; every request bounded
// by AbortSignal.timeout, at timeoutMs when > 0 and DEFAULT_TIMEOUT_MS
// otherwise; an unread non-2xx body cancelled without touching the status.
//
// AbortSignal.timeout does not obey vitest fake timers, so the hung-request
// case runs on real time with a short bound.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  fetchJson,
  fetchJsonWithStatus,
  cancelBody,
  DEFAULT_TIMEOUT_MS
} from "../src/clients/http.js";
import { installFetch, jsonResponse } from "./helpers/fetch.js";

const URL = "https://example.test/api";

afterEach(function () {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("fetchJsonWithStatus { json, status } contract", function () {
  it("carries the HTTP status beside the parsed body on success", async function () {
    installFetch(function () {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: 1 }); } });
    });
    const result = await fetchJsonWithStatus(URL, { label: "t" });
    expect(result).toEqual({ json: { ok: 1 }, status: 200 });
  });

  it("carries the status with a null body on a non-2xx response", async function () {
    vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function () {
      return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.resolve({}); } });
    });
    expect(await fetchJsonWithStatus(URL, { label: "t" })).toEqual({ json: null, status: 404 });
  });

  it("carries a null status when no response arrived at all", async function () {
    vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function () {
      return Promise.reject(new Error("network down"));
    });
    expect(await fetchJsonWithStatus(URL, { label: "t" })).toEqual({ json: null, status: null });
  });
});

describe("fetchJson data-or-null contract", function () {
  it("returns the parsed JSON body on success", async function () {
    installFetch(function () {
      return Promise.resolve(jsonResponse({ hello: "world", n: 3 }));
    });
    const result = await fetchJson(URL, { label: "test" });
    expect(result).toEqual({ hello: "world", n: 3 });
  });

  it("resolves to null on a non-2xx response and logs the labeled status", async function () {
    const log = vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function () {
      return Promise.resolve({ ok: false, status: 503, json: function () { return Promise.resolve({}); } });
    });
    const result = await fetchJson(URL, { label: "nws: alerts for MIZ001" });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith("nws: alerts for MIZ001 fetch failed: HTTP 503");
  });

  it("resolves to null (never throws) when fetch itself rejects", async function () {
    const log = vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function () {
      return Promise.reject(new Error("network down"));
    });
    const result = await fetchJson(URL, { label: "t" });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith("t fetch failed: network down");
  });

  it("resolves to null when the body's json() rejects", async function () {
    const log = vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function () {
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.reject(new Error("bad json")); }
      });
    });
    const result = await fetchJson(URL, { label: "t" });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith("t fetch failed: bad json");
  });

  it("passes method/headers/body through to fetch verbatim", async function () {
    const headers = { "User-Agent": "swim.report test", "Content-Type": "application/json" };
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    await fetchJson(URL, { method: "POST", headers: headers, body: "data=1", label: "t" });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(URL);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toBe(headers);
    expect(calls[0].init.body).toBe("data=1");
  });

  it("omits the body key from init when opts.body is undefined", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({}));
    });
    await fetchJson(URL, { method: "GET", label: "t" });
    expect(Object.prototype.hasOwnProperty.call(calls[0].init, "body")).toBe(false);
  });

  it("works with opts omitted entirely and logs with an empty label prefix", async function () {
    const log = vi.spyOn(console, "log").mockImplementation(function () {});
    const calls = installFetch(function () {
      return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({}); } });
    });
    const result = await fetchJson(URL);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(" fetch failed: HTTP 500");
    // No opts means a bare init: no method/headers/body keys, only the default bound.
    expect(Object.keys(calls[0].init)).toEqual(["signal"]);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("succeeds with opts omitted entirely", async function () {
    installFetch(function () {
      return Promise.resolve(jsonResponse({ plain: true }));
    });
    const result = await fetchJson(URL);
    expect(result).toEqual({ plain: true });
  });
});

describe("fetchJson timeoutMs abort wiring", function () {
  it("exports a 30 s default bound", function () {
    expect(DEFAULT_TIMEOUT_MS).toBe(30000);
  });

  it("aborts a hung request after timeoutMs and resolves to null", async function () {
    const log = vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function (url, init) {
      // A hung connection: the promise settles only when the signal fires,
      // rejecting with the TimeoutError the runtime's fetch would surface.
      return new Promise(function (resolve, reject) {
        init.signal.addEventListener("abort", function () {
          reject(init.signal.reason);
        });
      });
    });
    const result = await fetchJson(URL, { timeoutMs: 20, label: "t" });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith("t fetch failed: The operation was aborted due to timeout");
  });

  it("arms AbortSignal.timeout when timeoutMs is absent", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({}));
    });
    await fetchJson(URL, { label: "t" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].init.signal.aborted).toBe(false);
  });

  it("falls back to the default bound when timeoutMs is 0", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({}));
    });
    await fetchJson(URL, { timeoutMs: 0, label: "t" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the default bound when timeoutMs is negative or not a number", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({}));
    });
    await fetchJson(URL, { timeoutMs: -5, label: "t" });
    await fetchJson(URL, { timeoutMs: "45000", label: "t" });
    expect(calls.length).toBe(2);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("wires init.signal when timeoutMs is set", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({}));
    });
    await fetchJson(URL, { timeoutMs: 5000, label: "t" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("leaves the signal unaborted after a fast success", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({ fast: true }));
    });
    const result = await fetchJson(URL, { timeoutMs: 5000, label: "t" });
    expect(result).toEqual({ fast: true });
    expect(calls[0].init.signal.aborted).toBe(false);
  });
});

describe("non-2xx body cancel", function () {
  it("cancels the unread body and still returns the status", async function () {
    vi.spyOn(console, "log").mockImplementation(function () {});
    const cancel = vi.fn(function () { return Promise.resolve(); });
    installFetch(function () {
      return Promise.resolve({ ok: false, status: 404, body: { cancel: cancel } });
    });
    expect(await fetchJsonWithStatus(URL, { label: "t" })).toEqual({ json: null, status: 404 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps the status when cancel throws synchronously", async function () {
    vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function () {
      return Promise.resolve({
        ok: false,
        status: 404,
        body: { cancel: function () { throw new Error("locked"); } }
      });
    });
    expect(await fetchJsonWithStatus(URL, { label: "t" })).toEqual({ json: null, status: 404 });
  });

  it("keeps the status when cancel rejects", async function () {
    vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function () {
      return Promise.resolve({
        ok: false,
        status: 404,
        body: { cancel: function () { return Promise.reject(new Error("locked")); } }
      });
    });
    expect(await fetchJsonWithStatus(URL, { label: "t" })).toEqual({ json: null, status: 404 });
  });

  it("leaves a response without a body untouched", async function () {
    vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function () {
      return Promise.resolve({ ok: false, status: 500 });
    });
    expect(await fetchJsonWithStatus(URL, { label: "t" })).toEqual({ json: null, status: 500 });
  });

  it("does not cancel a 2xx body before it is read", async function () {
    const cancel = vi.fn(function () { return Promise.resolve(); });
    installFetch(function () {
      return Promise.resolve({
        ok: true,
        status: 200,
        body: { cancel: cancel },
        json: function () { return Promise.resolve({ ok: 1 }); }
      });
    });
    expect(await fetchJson(URL, { label: "t" })).toEqual({ ok: 1 });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancelBody tolerates null, a missing body and a null body", function () {
    expect(function () { cancelBody(null); }).not.toThrow();
    expect(function () { cancelBody({}); }).not.toThrow();
    expect(function () { cancelBody({ body: null }); }).not.toThrow();
  });
});
