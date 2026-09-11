// test/officialSourcesUtil.test.js
// Direct unit tests for the shared official-source scraper helpers in
// src/officialSources/util.js: the fetchText error-isolation contract
// ("null on ANY failure, never throw") every scraper relies on, the ageDays
// staleness math backing the scrapers' freshness gates, and the shared
// siteNamesMatchBeach predicate.
// No network access — fetchText runs against a stubbed globalThis.fetch.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchText,
  ageDays,
  MS_PER_DAY,
  siteNamesMatchBeach
} from "../src/officialSources/util.js";
import { installFetch } from "./helpers/fetch.js";

const URL = "https://example.test/flags";

afterEach(function () {
  vi.unstubAllGlobals();
});

describe("fetchText", function () {
  it("resolves to the body string when the response is ok", async function () {
    installFetch(function () {
      return Promise.resolve({
        ok: true,
        text: function () {
          return Promise.resolve("<html>flags</html>");
        }
      });
    });
    const body = await fetchText(URL);
    expect(body).toBe("<html>flags</html>");
  });

  it("resolves null on a non-ok status without reading the body", async function () {
    const text = vi.fn(function () {
      return Promise.resolve("server error page");
    });
    installFetch(function () {
      return Promise.resolve({ ok: false, status: 500, text: text });
    });
    const body = await fetchText(URL);
    expect(body).toBeNull();
    expect(text).not.toHaveBeenCalled();
  });

  it("cancels the unread body on a non-ok status", async function () {
    const cancel = vi.fn(function () {
      return Promise.resolve();
    });
    installFetch(function () {
      return Promise.resolve({ ok: false, status: 503, body: { cancel: cancel } });
    });
    expect(await fetchText(URL)).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("still resolves null (does not reject) when the non-ok body's cancel throws", async function () {
    installFetch(function () {
      return Promise.resolve({
        ok: false,
        status: 503,
        body: { cancel: function () { throw new Error("locked"); } }
      });
    });
    expect(await fetchText(URL)).toBeNull();
  });

  it("resolves null (does not reject) when fetch itself rejects", async function () {
    installFetch(function () {
      return Promise.reject(new Error("network down"));
    });
    const body = await fetchText(URL);
    expect(body).toBeNull();
  });

  it("resolves null when the body read rejects", async function () {
    installFetch(function () {
      return Promise.resolve({
        ok: true,
        text: function () {
          return Promise.reject(new Error("body stream torn"));
        }
      });
    });
    const body = await fetchText(URL);
    expect(body).toBeNull();
  });

  it("passes headers and redirect verbatim in the fetch init", async function () {
    const calls = installFetch(function () {
      return Promise.resolve({
        ok: true,
        text: function () {
          return Promise.resolve("ok");
        }
      });
    });
    const headers = { "User-Agent": "swim-report-test", Accept: "text/html" };
    await fetchText(URL, { headers: headers, redirect: "follow" });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(URL);
    expect(calls[0].init.headers).toEqual(headers);
    expect(calls[0].init.redirect).toBe("follow");
  });

  it("omits headers and redirect from the init when the caller passes neither", async function () {
    const calls = installFetch(function () {
      return Promise.resolve({
        ok: true,
        text: function () {
          return Promise.resolve("ok");
        }
      });
    });
    await fetchText(URL);
    expect(calls.length).toBe(1);
    expect("headers" in calls[0].init).toBe(false);
    expect("redirect" in calls[0].init).toBe(false);
  });

  it("always arms an AbortSignal timeout on the request", async function () {
    const calls = installFetch(function () {
      return Promise.resolve({
        ok: true,
        text: function () {
          return Promise.resolve("ok");
        }
      });
    });
    await fetchText(URL);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the shared default when timeoutMs is 0 or negative", async function () {
    const calls = installFetch(function () {
      return Promise.resolve({
        ok: true,
        text: function () {
          return Promise.resolve("ok");
        }
      });
    });
    await fetchText(URL, { timeoutMs: 0 });
    await fetchText(URL, { timeoutMs: -1 });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1].init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("ageDays", function () {
  const NOW_MS = Date.parse("2026-07-20T12:00:00.000Z");

  it("MS_PER_DAY is 86400000", function () {
    expect(MS_PER_DAY).toBe(86400000);
  });

  it("returns 1 for a timestamp exactly one day in the past", function () {
    expect(ageDays(NOW_MS, NOW_MS - MS_PER_DAY)).toBe(1);
  });

  it("returns fractional days (36 hours ago is 1.5)", function () {
    expect(ageDays(NOW_MS, NOW_MS - 36 * 3600 * 1000)).toBe(1.5);
  });

  it("returns a negative age for a future timestamp", function () {
    expect(ageDays(NOW_MS, NOW_MS + MS_PER_DAY)).toBe(-1);
  });
});

// The name pass of resolveSiteForBeach, shared with the registry's reportedFor
// decision: a beach the curated names[] claim is the report site itself, never a
// neighbor borrowing its flag.
describe("siteNamesMatchBeach", function () {
  const SITE = { siteId: "mears", names: ["mears state park", "charles mears"] };

  it("matches a names[] substring of the beach name", function () {
    expect(siteNamesMatchBeach({ name: "Charles Mears State Park Beach" }, SITE))
      .toBe(true);
  });

  it("matches against park_name too", function () {
    expect(siteNamesMatchBeach(
      { name: "Beach", park_name: "Charles Mears State Park" }, SITE)).toBe(true);
  });

  it("is case-insensitive on both sides", function () {
    expect(siteNamesMatchBeach({ name: "CHARLES MEARS state park" },
      { names: ["Charles Mears"] })).toBe(true);
  });

  it("is false for an unrelated beach", function () {
    expect(siteNamesMatchBeach({ name: "Grand Haven City Beach" }, SITE)).toBe(false);
  });

  it("is false for a missing site, a non-array names[] and a non-string entry", function () {
    expect(siteNamesMatchBeach({ name: "Mears State Park" }, null)).toBe(false);
    expect(siteNamesMatchBeach({ name: "Mears State Park" }, { names: "mears" }))
      .toBe(false);
    expect(siteNamesMatchBeach({ name: "Mears State Park" }, { names: [42, ""] }))
      .toBe(false);
  });
});
