// test/sitemap.test.js
// Covers the crawler routes end to end against real SQLite: GET /sitemap.xml
// (src/sitemap.js) lists exactly the beach pages that answer 200, each dated by
// its newest live record, with a body-hash ETag; GET /robots.txt (src/robots.js)
// points at the sitemap; and every /api/* response but the HTML guide carries
// x-robots-tag: noindex.

import { describe, it, expect } from "vitest";
import { handleRequest } from "../src/router.js";
import { buildSitemapXml, beachLastModifiedMs } from "../src/sitemap.js";
import { ROBOTS_TXT } from "../src/robots.js";
import { makeD1 } from "./helpers/d1.js";

const NOW_MS = Date.now();
const NOW_EPOCH = Math.floor(NOW_MS / 1000);
const LIVE = NOW_EPOCH + 3600;
const SPENT = NOW_EPOCH - 60;

function request(path, method, headers) {
  return {
    method: method || "GET",
    url: "https://swim.report" + path,
    cf: {},
    headers: new Headers(headers || {})
  };
}

function beach(id, extra) {
  return Object.assign({
    id: id,
    name: "Beach " + id,
    lat: 42.7,
    lon: -86.2,
    osm_id: id.replace(/^osm-/, "").replace("-", "/"),
    water_class: "great_lake",
    water_class_attempts: 0
  }, extra);
}

function chip(prefix, color, updated, expires) {
  const fields = {};
  fields[prefix] = { color: color, updated: updated };
  fields[prefix + "_color"] = color;
  fields[prefix + "_updated"] = updated;
  fields[prefix + "_expires"] = expires;
  return fields;
}

function envWith(beaches, state) {
  const db = makeD1({ beaches: beaches });
  for (const id of Object.keys(state || {})) {
    db.seedState(id, state[id]);
  }
  return { DB: db, FLAGS: { get: function () { return Promise.resolve(null); } } };
}

function locs(xml) {
  const out = [];
  const pattern = /<loc>([^<]+)<\/loc>/g;
  let match = pattern.exec(xml);
  while (match !== null) {
    out.push(match[1]);
    match = pattern.exec(xml);
  }
  return out;
}

// The <lastmod> of the <url> whose <loc> is loc, or null when it has none.
function lastmodOf(xml, loc) {
  const start = xml.indexOf("<loc>" + loc + "</loc>");
  const end = xml.indexOf("</url>", start);
  const entry = xml.slice(start, end);
  const match = entry.match(/<lastmod>([^<]+)<\/lastmod>/);
  return match ? match[1] : null;
}

describe("GET /sitemap.xml", () => {
  const beaches = [
    beach("osm-way-10"),
    beach("osm-node-20"),
    beach("osm-relation-30"),
    beach("osm-way-40", { water_class: "inland" }),
    beach("osm-way-50", { water_class: null, water_class_attempts: 5 }),
    beach("osm-way-60", { water_class: null, water_class_attempts: 0 }),
    beach("not-a-storage-id")
  ];
  const state = {
    "osm-way-10": Object.assign(
      chip("estimate", "green", "2026-11-12T18:07:12.345Z", LIVE),
      chip("official", "red", "2026-11-12T18:30:00.000Z", LIVE)),
    "osm-node-20": chip("estimate", "yellow", "2026-11-12T19:07:00.000Z", SPENT),
    "osm-relation-30": Object.assign(
      chip("estimate", "green", "2026-11-12T17:07:00.000Z", LIVE),
      chip("official", "green", "2026-11-12T19:00:00.000Z", SPENT))
  };

  it("serves XML, cacheable, with an ETag", async () => {
    const res = await handleRequest(request("/sitemap.xml"), envWith(beaches, state));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=60, stale-if-error=600");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    const xml = await res.text();
    expect(xml.indexOf("<?xml version=\"1.0\" encoding=\"UTF-8\"?>")).toBe(0);
    expect(xml).toContain("<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">");
  });

  // Inland, parked and id-less rows 404 or redirect, so they are not listed.
  it("lists the home page, the API guide and every flag-worthy beach page", async () => {
    const res = await handleRequest(request("/sitemap.xml"), envWith(beaches, state));
    expect(locs(await res.text())).toEqual([
      "https://swim.report/",
      "https://swim.report/api/",
      "https://swim.report/beach/n20",
      "https://swim.report/beach/r30",
      "https://swim.report/beach/w10",
      "https://swim.report/beach/w60"
    ]);
  });

  it("dates each beach by its newest live record, to the second", async () => {
    const xml = await (await handleRequest(request("/sitemap.xml"), envWith(beaches, state))).text();
    expect(lastmodOf(xml, "https://swim.report/beach/w10")).toBe("2026-11-12T18:30:00Z");
    // The spent official does not date the page; the live estimate does.
    expect(lastmodOf(xml, "https://swim.report/beach/r30")).toBe("2026-11-12T17:07:00Z");
    // Nothing live, nothing to date by.
    expect(lastmodOf(xml, "https://swim.report/beach/n20")).toBeNull();
    expect(lastmodOf(xml, "https://swim.report/beach/w60")).toBeNull();
  });

  it("dates the home page by its newest beach and the API guide not at all", async () => {
    const xml = await (await handleRequest(request("/sitemap.xml"), envWith(beaches, state))).text();
    expect(lastmodOf(xml, "https://swim.report/")).toBe("2026-11-12T18:30:00Z");
    expect(lastmodOf(xml, "https://swim.report/api/")).toBeNull();
  });

  it("answers a matching If-None-Match with 304", async () => {
    const env = envWith(beaches, state);
    const first = await handleRequest(request("/sitemap.xml"), env);
    const etag = first.headers.get("etag");
    const second = await handleRequest(
      request("/sitemap.xml", "GET", { "if-none-match": "W/" + etag }), env);
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("answers HEAD with the headers and no body", async () => {
    const res = await handleRequest(request("/sitemap.xml", "HEAD"), envWith(beaches, state));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await res.text()).toBe("");
  });

  it("lists only the two static pages for an empty table", async () => {
    const xml = await (await handleRequest(request("/sitemap.xml"), envWith([], {}))).text();
    expect(locs(xml)).toEqual(["https://swim.report/", "https://swim.report/api/"]);
    expect(lastmodOf(xml, "https://swim.report/")).toBeNull();
  });
});

describe("buildSitemapXml and beachLastModifiedMs", () => {
  it("ignores a record with no color, matching liveChipState", () => {
    const row = {
      id: "osm-way-1",
      estimate_color: null,
      estimate_updated: "2026-11-12T18:00:00.000Z",
      estimate_expires: LIVE
    };
    expect(beachLastModifiedMs(row, NOW_MS)).toBeNull();
  });

  it("ignores an unparseable updated stamp", () => {
    const row = {
      id: "osm-way-1",
      estimate_color: "green",
      estimate_updated: "not a date",
      estimate_expires: LIVE
    };
    expect(beachLastModifiedMs(row, NOW_MS)).toBeNull();
    expect(buildSitemapXml([row], NOW_MS)).toContain(
      "<url><loc>https://swim.report/beach/w1</loc></url>");
  });
});

describe("GET /robots.txt", () => {
  it("serves plain text that names the sitemap by absolute URL", async () => {
    const res = await handleRequest(request("/robots.txt"), envWith([], {}));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=60, stale-if-error=600");
    const body = await res.text();
    expect(body).toBe(ROBOTS_TXT);
    expect(body.split("\n")).toContain("Sitemap: https://swim.report/sitemap.xml");
  });

  // The ?q=, ?near= and ?ids= views canonicalize to /, so only those are kept
  // out; the map's GeoJSON has no query string and stays fetchable.
  it("disallows query-string URLs and nothing else", () => {
    const rules = ROBOTS_TXT.split("\n").filter(function (line) {
      return line.indexOf("Disallow:") === 0 || line.indexOf("Allow:") === 0;
    });
    expect(rules).toEqual(["Disallow: /*?"]);
    expect(ROBOTS_TXT.indexOf("User-agent: *\n")).toBe(0);
  });
});

describe("x-robots-tag on the API", () => {
  const env = function () {
    return envWith([beach("osm-way-10")], { "osm-way-10": chip("estimate", "green", "2026-11-12T18:00:00.000Z", LIVE) });
  };
  const noindexed = [
    "/api/beaches",
    "/api/beaches.geojson",
    "/api/beaches/w10",
    "/api/flag/w10",
    "/api/beaches/w999",
    "/api/openapi.json",
    "/api/nope",
    "/api"
  ];
  for (const path of noindexed) {
    it("marks " + path + " noindex", async () => {
      const res = await handleRequest(request(path), env());
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
  }

  it("marks the OPTIONS preflight noindex too", async () => {
    const res = await handleRequest(request("/api/beaches", "OPTIONS"), env());
    expect(res.status).toBe(204);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("leaves the /api/ guide indexable", async () => {
    const res = await handleRequest(request("/api/"), env());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  it("leaves the HTML pages indexable", async () => {
    const res = await handleRequest(request("/beach/w10"), env());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });
});
