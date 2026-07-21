// test/renderErrorPage.test.js
// Covers renderErrorPage (src/frontend/render.js) — the HTML body served by
// src/router.js for 404s and by the src/index.js fetch catch-all for 500s.
// Router tests only assert status codes and cache headers; this file asserts
// the actual page markup: the danger callout, status/message rendering,
// defaulting when data is missing, HTML-escaping of the message, and the
// footer disclaimer invariant that every page must carry.

import { describe, it, expect } from "vitest";
import { renderErrorPage } from "../src/frontend/render.js";

describe("renderErrorPage — 404 shape", () => {
  const html = renderErrorPage({ status: 404, message: "Beach not found" });

  it("renders a danger callout with the status and message", () => {
    expect(html).toContain("<wa-callout variant=\"danger\">");
    expect(html).toContain("<strong>404</strong>");
    expect(html).toContain("Beach not found");
  });

  it("links back to the beach list", () => {
    expect(html).toContain("<a href=\"/\">Return to the beach list</a>");
  });

  it("titles the document with the status code", () => {
    expect(html).toContain("<title>Swim Report — 404</title>");
  });
});

describe("renderErrorPage — defaults", () => {
  it("falls back to 500 / generic message when data is null", () => {
    const html = renderErrorPage(null);
    expect(html).toContain("<strong>500</strong>");
    expect(html).toContain("Something went wrong.");
    expect(html).toContain("<title>Swim Report — 500</title>");
  });

  it("falls back to 500 / generic message when data is an empty object", () => {
    const html = renderErrorPage({});
    expect(html).toContain("<strong>500</strong>");
    expect(html).toContain("Something went wrong.");
  });

  it("falls back per-field: a status without a message still gets the generic message", () => {
    const html = renderErrorPage({ status: 404 });
    expect(html).toContain("<strong>404</strong>");
    expect(html).toContain("Something went wrong.");
  });
});

describe("renderErrorPage — escaping", () => {
  it("HTML-escapes the message so markup in it is inert", () => {
    const html = renderErrorPage({ status: 404, message: "<img src=x onerror=alert(1)>" });
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("escapes quotes and ampersands in the message", () => {
    const html = renderErrorPage({ status: 404, message: "\"a\" & 'b'" });
    expect(html).toContain("&quot;a&quot; &amp; &#39;b&#39;");
    expect(html).not.toContain("\"a\" & 'b'");
  });
});

describe("renderErrorPage — page invariants", () => {
  it("carries the footer disclaimer on error pages too", () => {
    const html = renderErrorPage({ status: 404, message: "Not found" });
    expect(html).toContain("Estimated — not the official flag status. " +
      "Always obey posted flags and lifeguards.");
  });
});
