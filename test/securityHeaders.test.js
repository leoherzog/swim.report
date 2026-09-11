// The security headers every Worker response carries: the pure helper, the
// fetch export that applies it after the error boundary, the CSP assumptions
// the rendered markup must keep, and the public/_headers mirror the platform
// applies to the static assets it serves ahead of the Worker.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { SECURITY_HEADERS, withSecurityHeaders } from "../src/securityHeaders.js";
import { renderListPage, renderDetailPage, renderErrorPage } from "../src/frontend/render.js";
import { beachWith, NOW_ISO } from "./helpers/render.js";

const EXPECTED = {
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy": "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'"
};

function expectSecurityHeaders(res) {
  for (const name of Object.keys(EXPECTED)) {
    expect(res.headers.get(name)).toBe(EXPECTED[name]);
  }
}

function getRequest(path, method) {
  return {
    method: method || "GET",
    url: "https://swim.report" + path,
    cf: {},
    headers: new Headers()
  };
}

function throwingEnv() {
  return {
    DB: { prepare: function () { throw new Error("boom"); } },
    FLAGS: { get: function () { return Promise.resolve(null); } }
  };
}

function makeCtx() {
  return { waitUntil: function () {} };
}

describe("SECURITY_HEADERS", function () {
  it("names exactly the four headers at their specified values", function () {
    const asObject = {};
    for (const pair of SECURITY_HEADERS) {
      asObject[pair[0]] = pair[1];
    }
    expect(asObject).toEqual(EXPECTED);
  });
});

describe("withSecurityHeaders", function () {
  it("adds the four headers in place and leaves the route's own header untouched", function () {
    const original = new Response("x", { headers: { "content-type": "text/plain" } });
    const res = withSecurityHeaders(original);
    expect(res).toBe(original);
    expectSecurityHeaders(res);
    expect(res.headers.get("content-type")).toBe("text/plain");
  });

  it("never overrides a header the route already set", function () {
    const res = withSecurityHeaders(new Response("x", {
      headers: {
        "content-security-policy": "frame-ancestors 'self'",
        "cache-control": "no-store"
      }
    }));
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("strict-transport-security")).toBe(EXPECTED["strict-transport-security"]);
    expect(res.headers.get("x-content-type-options")).toBe(EXPECTED["x-content-type-options"]);
    expect(res.headers.get("referrer-policy")).toBe(EXPECTED["referrer-policy"]);
  });

  it("rebuilds a response whose headers are immutable, keeping status and location", function () {
    const redirect = Response.redirect("https://example.test/", 302);
    const res = withSecurityHeaders(redirect);
    expect(res).not.toBe(redirect);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.test/");
    expectSecurityHeaders(res);
  });

  it("mutates a null-body response in place", function () {
    const original = new Response(null, { status: 304 });
    const res = withSecurityHeaders(original);
    expect(res).toBe(original);
    expect(res.body).toBeNull();
    expectSecurityHeaders(res);
  });
});

describe("fetch export applies the headers to every response", function () {
  it("GET /health keeps its own cache-control and content-type", async function () {
    const res = await worker.fetch(getRequest("/health"), {}, makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
    expectSecurityHeaders(res);
  });

  it("the 405 text/plain branch", async function () {
    const res = await worker.fetch(getRequest("/", "POST"), {}, makeCtx());
    expect(res.status).toBe(405);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expectSecurityHeaders(res);
  });

  it("the 404 HTML page", async function () {
    const res = await worker.fetch(getRequest("/nope"), {}, makeCtx());
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expectSecurityHeaders(res);
  });

  it("the /api/ 404 JSON", async function () {
    const res = await worker.fetch(getRequest("/api/nope"), {}, makeCtx());
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expectSecurityHeaders(res);
  });

  it("both error-boundary 500s", async function () {
    const lines = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(function (line) { lines.push(String(line)); });
    try {
      const html = await worker.fetch(getRequest("/"), throwingEnv(), makeCtx());
      expect(html.status).toBe(500);
      expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(html.headers.get("cache-control")).toBe("no-store");
      expectSecurityHeaders(html);

      const json = await worker.fetch(getRequest("/api/beaches.geojson"), throwingEnv(), makeCtx());
      expect(json.status).toBe(500);
      expect(json.headers.get("cache-control")).toBe("no-store");
      expect(await json.json()).toEqual({ error: "internal error" });
      expectSecurityHeaders(json);

      // Both 500s must come from the D1 throw reaching the boundary, not from
      // the request stub failing earlier.
      expect(lines).toEqual([
        "index: request handler threw: boom",
        "index: request handler threw: boom"
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// Pins base-uri 'none', object-src 'none' and form-action 'self' to the markup
// the renderers emit: a <base>, <object>, <embed>, a meta CSP or a form posting
// off-origin would be silently blocked by the policy.
describe("the CSP assumptions hold on the rendered markup", function () {
  const pages = [
    renderListPage({
      entries: [], nowIso: NOW_ISO, sortedByProximity: false, location: null,
      query: "", hasMore: false, near: ""
    }),
    renderDetailPage({
      beach: beachWith({}), estimate: null, official: null, waves: null, nowIso: NOW_ISO
    }),
    renderErrorPage({ status: 404, message: "x" })
  ];

  it("emits no <base>, <object>, <embed> or meta CSP", function () {
    for (const html of pages) {
      expect(html).not.toContain("<base");
      expect(html).not.toContain("<object");
      expect(html).not.toContain("<embed");
      expect(html).not.toContain("http-equiv=\"Content-Security-Policy\"");
    }
  });

  it("every form posts to the site root", function () {
    let forms = 0;
    for (const html of pages) {
      const re = /<form[^>]*\saction="([^"]*)"/g;
      let match = re.exec(html);
      while (match !== null) {
        forms = forms + 1;
        expect(match[1]).toBe("/");
        match = re.exec(html);
      }
    }
    expect(forms).toBeGreaterThan(0);
  });
});

// The platform serves public/ before the Worker runs, so those responses get
// their headers from public/_headers; the file must mirror SECURITY_HEADERS.
describe("public/_headers mirrors SECURITY_HEADERS", function () {
  const text = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  const lines = text.split("\n").filter(function (l) { return l.trim() !== ""; });

  it("has exactly one pattern line, /*, and no line over 2,000 characters", function () {
    const patterns = lines.filter(function (l) { return l.charAt(0) !== " "; });
    expect(patterns).toEqual(["/*"]);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(2000);
    }
  });

  it("carries the same header pairs", function () {
    const pairs = lines
      .filter(function (l) { return l.charAt(0) === " "; })
      .map(function (l) {
        const idx = l.indexOf(":");
        return [l.slice(0, idx).trim().toLowerCase(), l.slice(idx + 1).trim()];
      })
      .sort();
    expect(pairs).toEqual(SECURITY_HEADERS.slice().sort());
  });
});
