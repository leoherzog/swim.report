// test/officialSourcesUtil.test.js
// Direct unit tests for the shared official-source scraper helpers in
// src/officialSources/util.js: the fetchText error-isolation contract
// ("null on ANY failure, never throw") every scraper relies on, and the
// ageDays staleness math backing the scrapers' freshness gates.
// No network access — fetchText runs against a stubbed globalThis.fetch.
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchText, ageDays, MS_PER_DAY } from "../src/officialSources/util.js";
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
