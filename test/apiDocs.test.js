// test/apiDocs.test.js
// Covers renderApiDocsPage (src/frontend/apiDocs.js), the GET /api/ page: a
// complete document in the shared chrome, the footer disclaimer invariant,
// every documented endpoint, a table of contents whose anchors all resolve, no
// external script beyond what the other pages load, correctly escaped and
// parseable example JSON, and constants taken from their enforcing modules.

import { describe, it, expect } from "vitest";
import { renderApiDocsPage } from "../src/frontend/apiDocs.js";
import { distanceMi } from "../src/geo.js";
import { renderErrorPage } from "../src/frontend/render.js";
import { IDS_LIST_LIMIT } from "../src/idsListLimit.js";

const NOW = "2026-07-04T15:20:00.000Z";
const html = renderApiDocsPage({ nowIso: NOW });

function scriptSrcs(doc) {
  const out = [];
  const re = /<script\b[^>]*\bsrc="([^"]+)"/g;
  let m = re.exec(doc);
  while (m !== null) {
    out.push(m[1]);
    m = re.exec(doc);
  }
  return out;
}

function preBodies(doc) {
  const out = [];
  const re = /<pre id="([^"]+)"><code>([\s\S]*?)<\/code><\/pre>/g;
  let m = re.exec(doc);
  while (m !== null) {
    out.push({ id: m[1], body: m[2] });
    m = re.exec(doc);
  }
  return out;
}

function unescapeHtml(s) {
  return s
    .split("&lt;").join("<")
    .split("&gt;").join(">")
    .split("&quot;").join("\"")
    .split("&#39;").join("'")
    .split("&amp;").join("&");
}

describe("renderApiDocsPage — document", () => {
  it("renders a complete themed document", () => {
    expect(html.indexOf("<!doctype html>")).toBe(0);
    expect(html).toContain("<html lang=\"en\" class=\"wa-theme-matter wa-palette-mild wa-cloak\"");
    expect(html).toContain("<title>Swim Report API</title>");
    expect(html).toContain("<wa-page");
    expect(html).toContain("</wa-page>");
    expect(html.trim().slice(-7)).toBe("</html>");
  });

  it("carries the canonical /api/ URL", () => {
    expect(html).toContain("<link rel=\"canonical\" href=\"https://swim.report/api/\">");
  });

  it("has exactly one h1", () => {
    expect(html.split("<h1").length - 1).toBe(1);
  });

  it("carries the mandatory footer disclaimer", () => {
    expect(html).toContain("Estimated — not the official flag status.");
    expect(html).toContain("Always obey posted flags and lifeguards.");
  });

  it("is pure: same input, same output", () => {
    expect(renderApiDocsPage({ nowIso: NOW })).toBe(html);
  });

  it("renders without data", () => {
    const bare = renderApiDocsPage();
    expect(bare.indexOf("<!doctype html>")).toBe(0);
    expect(bare).toContain("Estimated — not the official flag status.");
  });

  it("echoes the passed render instant", () => {
    expect(html).toContain(NOW);
  });
});

describe("renderApiDocsPage — content", () => {
  it("documents every endpoint path", () => {
    const paths = [
      "/api/beaches",
      "/api/beaches/:beachId",
      "/api/flag/:beachId",
      "/api/beaches.geojson",
      "/health",
      "/beach/n123456.json"
    ];
    for (const p of paths) {
      expect(html).toContain("<code>" + p + "</code>");
    }
  });

  it("documents the three list parameters", () => {
    expect(html).toContain("<code>q</code>");
    expect(html).toContain("<code>near</code>");
    expect(html).toContain("<code>ids</code>");
  });

  it("states the ids cap from the imported constant", () => {
    expect(html).toContain("Up to " + String(IDS_LIST_LIMIT) + " beach ids");
    expect(html).toContain("at most " + String(IDS_LIST_LIMIT) + ".");
  });

  it("names the base URL, CORS and caching headers", () => {
    expect(html).toContain("https://swim.report");
    expect(html).toContain("Access-Control-Allow-Origin: *");
    expect(html).toContain("max-age=60, stale-while-revalidate=60");
    expect(html).toContain("If-None-Match");
  });

  it("states unknown is gray, never green", () => {
    expect(html).toContain("never as green");
  });
});

describe("renderApiDocsPage — table of contents", () => {
  it("has a labelled nav whose every anchor resolves to an id on the page", () => {
    expect(html).toContain("<nav aria-labelledby=\"toc-heading\"");
    const nav = html.slice(html.indexOf("<nav aria-labelledby=\"toc-heading\""), html.indexOf("</nav>"));
    const re = /href="#([^"]+)"/g;
    const anchors = [];
    let m = re.exec(nav);
    while (m !== null) {
      anchors.push(m[1]);
      m = re.exec(nav);
    }
    expect(anchors.length).toBeGreaterThan(10);
    for (const a of anchors) {
      expect(html).toContain("id=\"" + a + "\"");
    }
  });

  it("every in-page link resolves", () => {
    const re = /href="#([^"]+)"/g;
    let m = re.exec(html);
    while (m !== null) {
      expect(html).toContain("id=\"" + m[1] + "\"");
      m = re.exec(html);
    }
  });

  it("ids are unique", () => {
    const re = /\sid="([^"]+)"/g;
    const seen = {};
    let m = re.exec(html);
    while (m !== null) {
      expect(seen[m[1]]).toBeUndefined();
      seen[m[1]] = true;
      m = re.exec(html);
    }
  });
});

describe("renderApiDocsPage — scripts and code samples", () => {
  it("loads no external script the other pages do not", () => {
    const allowed = scriptSrcs(renderErrorPage({ status: 404, message: "x" }));
    const used = scriptSrcs(html);
    expect(used.length).toBeGreaterThan(0);
    for (const src of used) {
      expect(allowed).toContain(src);
    }
  });

  it("gives every code block a copy button pointing at it", () => {
    const blocks = preBodies(html);
    expect(blocks.length).toBeGreaterThan(5);
    for (const b of blocks) {
      expect(html).toContain("<wa-copy-button from=\"" + b.id + "\"");
    }
  });

  it("gives every copy button a distinct accessible name", () => {
    const re = /copy-label="([^"]+)"/g;
    const labels = [];
    let m = re.exec(html);
    while (m !== null) {
      labels.push(m[1]);
      m = re.exec(html);
    }
    expect(labels.length).toBe(preBodies(html).length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("shows the discovery sample as a GET, never a HEAD the router answers 405", () => {
    expect(html).not.toContain("curl -sI");
    expect(html).toContain("curl -s -o /dev/null -D - &#39;https://swim.report/?q=holland&#39;");
  });

  it("states both cache staleness bounds the policy allows", () => {
    expect(html).toContain("normally up to about 2 minutes old");
    expect(html).toContain("up to about 11 minutes while the service is failing");
  });

  it("does not claim every beach carries an estimate", () => {
    expect(html).not.toContain("Every beach carries");
  });

  it("escapes code samples: no raw < or > inside a pre", () => {
    const blocks = preBodies(html);
    for (const b of blocks) {
      expect(b.body.indexOf("<")).toBe(-1);
      expect(b.body.indexOf(">")).toBe(-1);
    }
    // The Link header sample's angle brackets survive as entities.
    expect(html).toContain("link: &lt;/api/beaches?q=holland&gt;; rel=&quot;alternate&quot;");
  });

  it("every Response sample is valid JSON in the documented shapes", () => {
    const blocks = preBodies(html).filter(function (b) {
      return /-response$/.test(b.id);
    });
    expect(blocks.length).toBe(4);
    const byId = {};
    for (const b of blocks) {
      byId[b.id] = JSON.parse(unescapeHtml(b.body));
    }
    const list = byId["sample-list-response"];
    expect(list.sort).toBe("distance");
    expect(Object.keys(list.query)).toEqual(["q", "near", "ids"]);
    expect(typeof list.hasMore).toBe("boolean");
    for (const beach of list.beaches) {
      expect(Object.keys(beach)).toEqual(["id", "name", "lat", "lon", "display", "distanceMi", "links"]);
      expect(Object.keys(beach.display)).toEqual(["color", "source", "forecast"]);
      expect(beach.links.page).toBe("/beach/" + beach.id);
      expect(beach.links.api).toBe("/api/beaches/" + beach.id);
    }
    // The documented distances are what the haversine and its 0.1 mi rounding give.
    for (const beach of list.beaches) {
      const d = distanceMi(list.query.near.lat, list.query.near.lon, beach.lat, beach.lon);
      expect(beach.distanceMi).toBe(Math.round(d * 10) / 10);
    }
    const ids = byId["sample-ids-response"];
    expect(ids.sort).toBe("ids");
    expect(ids.beaches.map(function (b) { return b.id; })).toEqual(ids.query.ids);
    for (const beach of ids.beaches) {
      expect(beach.distanceMi).toBeNull();
    }
    const one = byId["sample-beach-response"];
    expect(one.beachId).toBe("n123456");
    expect(one.estimate.official).toBe(false);
    expect(one.estimate.estimateInputs.v).toBe(1);
    expect(one.display.source).toBe("estimate");
    expect(one.links.api).toBe("/api/beaches/n123456");
    const geo = byId["sample-geojson-response"];
    expect(geo.type).toBe("FeatureCollection");
    // GeoJSON is [lon, lat]; the list sample is the same beach as named fields.
    expect(geo.features[0].geometry.coordinates).toEqual([list.beaches[0].lon, list.beaches[0].lat]);
  });
});

describe("renderApiDocsPage — source style", () => {
  it("self-closes no custom element", () => {
    expect(/<wa-[a-z-]+[^>]*\/>/.test(html)).toBe(false);
  });
});
