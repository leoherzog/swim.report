// Tests for src/clients/http.js#fetchJson — the shared transport/error layer
// every client in src/clients/ builds on. Contract under test: parsed JSON on
// success; null (never a throw) on non-2xx, transport rejection, or JSON
// parse failure, each logged via console.log with the caller's label prefix;
// method/headers/body passed through to fetch verbatim; optional timeoutMs
// wiring an AbortController that is cleared on completion.

import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchJson } from "../src/clients/http.js";
import { installFetch, jsonResponse } from "./helpers/fetch.js";

const URL = "https://example.test/api";

afterEach(function () {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
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
    // No opts means a bare init: no method/headers/body/signal keys.
    expect(calls[0].init).toEqual({});
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
  it("aborts a hung request after timeoutMs and resolves to null", async function () {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function (url, init) {
      // Simulate a hung connection: the promise settles only when the
      // AbortController signal fires.
      return new Promise(function (resolve, reject) {
        init.signal.addEventListener("abort", function () {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const pending = fetchJson(URL, { timeoutMs: 5000, label: "t" });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith("t fetch failed: This operation was aborted");
  });

  it("creates no AbortController when timeoutMs is absent", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({}));
    });
    await fetchJson(URL, { label: "t" });
    expect(calls[0].init.signal).toBeUndefined();
  });

  it("creates no AbortController when timeoutMs is 0", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({}));
    });
    await fetchJson(URL, { timeoutMs: 0, label: "t" });
    expect(calls[0].init.signal).toBeUndefined();
  });

  it("wires init.signal when timeoutMs is set", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse({}));
    });
    await fetchJson(URL, { timeoutMs: 5000, label: "t" });
    expect(calls[0].init.signal).toBeDefined();
  });

  it("clears the timeout after a fast success so no timer leaks", async function () {
    vi.useFakeTimers();
    installFetch(function () {
      return Promise.resolve(jsonResponse({ fast: true }));
    });
    const result = await fetchJson(URL, { timeoutMs: 5000, label: "t" });
    expect(result).toEqual({ fast: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout after a fast failure so no timer leaks", async function () {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(function () {});
    installFetch(function () {
      return Promise.reject(new Error("refused"));
    });
    const result = await fetchJson(URL, { timeoutMs: 5000, label: "t" });
    expect(result).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
