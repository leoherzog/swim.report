// test/apiBeaches.test.js
// The public JSON API end to end through handleRequest against real SQLite
// (test/helpers/d1.js): GET /api/beaches in its three list modes, the
// single-beach route and its /api/flag alias, the /beach/<id>.json and /api
// redirects, the /api/ documentation route, the CORS policy on every /api/*
// response, and the rel="alternate" discovery the HTML pages advertise.

import { describe, it, expect, vi } from "vitest";
import { handleRequest } from "../src/router.js";
import {
  parseBeachesQuery,
  listAlternateHref,
  alternateLinkHeader,
  beachDisplayName
} from "../src/apiBeaches.js";
import { parseNearParam, HOME_LIST_LIMIT } from "../src/beachQueries.js";
import { IDS_LIST_LIMIT } from "../src/idsListLimit.js";
import { makeD1 } from "./helpers/d1.js";

const NOW_EPOCH = Math.floor(Date.now() / 1000);
const LIVE_EXPIRES = NOW_EPOCH + 3600;
const CACHEABLE = "public, max-age=60, stale-while-revalidate=60, stale-if-error=600";
const ETAG_SHAPE = /^"[0-9a-f]{64}"$/;

const OVAL = { id: "osm-way-1", name: "Oval Beach", park_name: null, lat: 42.6579, lon: -86.2114 };
const OTTAWA = { id: "osm-node-2", name: "Ottawa Beach", park_name: "Holland State Park", lat: 42.775, lon: -86.211 };
const MONTROSE = { id: "osm-relation-3", name: "Montrose Beach", park_name: null, lat: 41.9658, lon: -87.6363 };
const INLAND = {
  id: "osm-way-4", name: "Fremont Lake", park_name: null, lat: 43.4, lon: -85.9,
  water_class: "inland", water_class_attempts: 0
};

function agoIso(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function estimateOf(color) {
  return { color: color, reason: "x", official: false, updated: agoIso(600000) };
}

function makeEnv(beaches, estimates) {
  const db = makeD1({ beaches: beaches || [] });
  const colors = estimates || {};
  for (const id of Object.keys(colors)) {
    const estimate = estimateOf(colors[id]);
    db.seedState(id, {
      estimate: estimate,
      estimate_color: estimate.color,
      estimate_updated: estimate.updated,
      estimate_expires: LIVE_EXPIRES
    });
  }
  const flags = { get: function () { return Promise.resolve(null); } };
  return { DB: db, FLAGS: flags };
}

function makeCtx() {
  const promises = [];
  return {
    promises: promises,
    waitUntil: function (p) { promises.push(p); }
  };
}

function request(path, options) {
  const opts = options || {};
  return {
    method: opts.method || "GET",
    url: "https://swim.report" + path,
    cf: opts.cf || {},
    headers: new Headers(opts.headers || {})
  };
}

function lastViewedWrites(env) {
  return env.DB.statements.filter(function (st) {
    return st.sql.indexOf("UPDATE beaches SET last_viewed") === 0;
  });
}

function expectCors(res) {
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(res.headers.get("access-control-expose-headers")).toBe("ETag, Link");
}

async function listBody(path, env) {
  const res = await handleRequest(request(path), env || makeEnv([OVAL, OTTAWA, MONTROSE, INLAND]));
  expect(res.status).toBe(200);
  return res.json();
}

describe("GET /api/beaches name mode", () => {
  it("lists flag-worthy beaches alphabetically by display name with the documented shape", async () => {
    const env = makeEnv([OVAL, OTTAWA, MONTROSE, INLAND], { "osm-way-1": "double-red" });
    const res = await handleRequest(request("/api/beaches"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe(CACHEABLE);
    expect(res.headers.get("etag")).toMatch(ETAG_SHAPE);
    expectCors(res);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["builtAt", "sort", "query", "hasMore", "beaches"]);
    expect(Date.parse(body.builtAt)).not.toBeNaN();
    expect(body.sort).toBe("name");
    expect(body.query).toEqual({ q: null, near: null, ids: null });
    expect(body.hasMore).toBe(false);
    // Holland State Park sorts under its park name, between Montrose and Oval;
    // the inland row is hidden.
    expect(body.beaches.map(function (b) { return b.id; })).toEqual(["n2", "r3", "w1"]);
    expect(body.beaches[0]).toEqual({
      id: "n2",
      name: "Holland State Park",
      lat: 42.775,
      lon: -86.211,
      display: { color: "unknown", source: "none", forecast: false },
      distanceMi: null,
      links: { page: "/beach/n2", api: "/api/beaches/n2" }
    });
    // double-red is not collapsed to red.
    expect(body.beaches[2].display).toEqual({ color: "double-red", source: "estimate", forecast: false });
  });

  it("filters on q, treats a blank q as absent and matches LIKE wildcards literally", async () => {
    const q = await listBody("/api/beaches?q=%20oval%20");
    expect(q.query.q).toBe("oval");
    expect(q.beaches.map(function (b) { return b.id; })).toEqual(["w1"]);

    const park = await listBody("/api/beaches?q=holland");
    expect(park.beaches.map(function (b) { return b.id; })).toEqual(["n2"]);

    const blank = await listBody("/api/beaches?q=%20%20");
    expect(blank.query.q).toBe(null);
    expect(blank.beaches.length).toBe(3);

    const wildcard = await listBody("/api/beaches?q=%25");
    expect(wildcard.beaches).toEqual([]);
  });

  it("caps at HOME_LIST_LIMIT and reports hasMore", async () => {
    const many = [];
    for (let i = 1; i <= HOME_LIST_LIMIT + 1; i = i + 1) {
      many.push({ id: "osm-node-" + String(1000 + i), name: "Beach " + String(1000 + i), lat: 42, lon: -86 });
    }
    const body = await listBody("/api/beaches", makeEnv(many));
    expect(body.beaches.length).toBe(HOME_LIST_LIMIT);
    expect(body.hasMore).toBe(true);
    expect(body.beaches[0].id).toBe("n1001");
  });

  it("never stamps last_viewed", async () => {
    const env = makeEnv([OVAL]);
    const ctx = makeCtx();
    await handleRequest(request("/api/beaches"), env, ctx);
    expect(ctx.promises.length).toBe(0);
    expect(lastViewedWrites(env).length).toBe(0);
  });
});

describe("GET /api/beaches distance mode", () => {
  it("sorts by haversine distance from near and rounds distanceMi to 0.1", async () => {
    const body = await listBody("/api/beaches?near=41.97,-87.64");
    expect(body.sort).toBe("distance");
    expect(body.query).toEqual({ q: null, near: { lat: 41.97, lon: -87.64 }, ids: null });
    expect(body.beaches.map(function (b) { return b.id; })).toEqual(["r3", "w1", "n2"]);
    for (const beach of body.beaches) {
      expect(typeof beach.distanceMi).toBe("number");
      expect(Math.round(beach.distanceMi * 10) / 10).toBe(beach.distanceMi);
    }
    expect(body.beaches[0].distanceMi).toBeLessThan(1);
    expect(body.beaches[1].distanceMi).toBeGreaterThan(body.beaches[0].distanceMi);
  });

  it("combines near with q", async () => {
    const body = await listBody("/api/beaches?near=41.97,-87.64&q=beach");
    expect(body.sort).toBe("distance");
    expect(body.query.q).toBe("beach");
    expect(body.beaches.map(function (b) { return b.id; })).toEqual(["r3", "w1", "n2"]);
    const narrow = await listBody("/api/beaches?near=41.97,-87.64&q=oval");
    expect(narrow.beaches.map(function (b) { return b.id; })).toEqual(["w1"]);
  });

  it("never reads request.cf: no near means name order even with a cf location", async () => {
    const env = makeEnv([OVAL, OTTAWA, MONTROSE]);
    const res = await handleRequest(
      request("/api/beaches", { cf: { latitude: "41.97", longitude: "-87.64" } }), env
    );
    const body = await res.json();
    expect(body.sort).toBe("name");
    expect(body.query.near).toBe(null);
    expect(res.headers.get("cache-control")).toBe(CACHEABLE);
  });

  it("answers 400 no-store for an invalid near", async () => {
    const bad = ["banana", "1,2,3", "99,0", "0,181", "", ",5", "42,"];
    for (const value of bad) {
      const res = await handleRequest(
        request("/api/beaches?near=" + encodeURIComponent(value)), makeEnv([OVAL])
      );
      expect(res.status, value).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expectCors(res);
      const body = await res.json();
      expect(Object.keys(body)).toEqual(["error"]);
      expect(typeof body.error).toBe("string");
    }
  });
});

describe("GET /api/beaches ids mode", () => {
  it("returns the named beaches in caller order, either id form, deduped, gated", async () => {
    const body = await listBody("/api/beaches?ids=r3,osm-way-1,w1,w999,osm-way-4,nope");
    expect(body.sort).toBe("ids");
    expect(body.hasMore).toBe(false);
    expect(body.query).toEqual({ q: null, near: null, ids: ["r3", "w1", "w999", "w4"] });
    expect(body.beaches.map(function (b) { return b.id; })).toEqual(["r3", "w1"]);
    expect(body.beaches[0].distanceMi).toBe(null);
  });

  it("caps the accepted ids at IDS_LIST_LIMIT", async () => {
    const ids = [];
    for (let i = 1; i <= IDS_LIST_LIMIT + 3; i = i + 1) {
      ids.push("n" + String(i));
    }
    const body = await listBody("/api/beaches?ids=" + ids.join(","));
    expect(body.query.ids.length).toBe(IDS_LIST_LIMIT);
  });

  it("answers 200 with no beaches when ids names no valid id, reading nothing", async () => {
    const env = makeEnv([OVAL]);
    const res = await handleRequest(request("/api/beaches?ids=nope,%2E%2E"), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.beaches).toEqual([]);
    expect(body.query.ids).toEqual([]);
    expect(env.DB.statements.filter(function (st) {
      return st.sql.indexOf("FROM beaches") !== -1;
    }).length).toBe(0);
    const empty = await listBody("/api/beaches?ids=");
    expect(empty.sort).toBe("ids");
    expect(empty.beaches).toEqual([]);
  });

  it("answers 400 when ids is combined with q or near, but not with a blank q", async () => {
    for (const search of ["?ids=w1&q=oval", "?ids=w1&near=42,-86", "?ids=w1&near=banana"]) {
      const res = await handleRequest(request("/api/beaches" + search), makeEnv([OVAL]));
      expect(res.status, search).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect((await res.json()).error).toContain("ids");
    }
    const blank = await handleRequest(request("/api/beaches?ids=w1&q="), makeEnv([OVAL]));
    expect(blank.status).toBe(200);
  });
});

describe("GET /api/beaches validators", () => {
  it("hashes the exact body bytes and answers a matching If-None-Match with 304", async () => {
    const env = makeEnv([OVAL]);
    const first = await handleRequest(request("/api/beaches?ids=w1"), env);
    const etag = first.headers.get("etag");
    const bytes = new Uint8Array(await first.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    expect(etag).toBe("\"" + hex + "\"");

    // No field is the request instant, so a later render of unchanged data
    // revalidates against the earlier tag.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 90000));
      for (const value of [etag, "W/" + etag, "\"x\", W/" + etag]) {
        const res = await handleRequest(
          request("/api/beaches?ids=w1", { headers: { "if-none-match": value } }), env
        );
        expect(res.status, value).toBe(304);
        expect(await res.text()).toBe("");
        expect(res.headers.get("etag")).toBe(etag);
        expect(res.headers.get("cache-control")).toBe(CACHEABLE);
        expect(res.headers.get("content-type")).toBe(null);
        expectCors(res);
      }
    } finally {
      vi.useRealTimers();
    }
    const star = await handleRequest(
      request("/api/beaches", { headers: { "if-none-match": "*" } }), env
    );
    expect(star.status).toBe(304);
    expectCors(star);
    const miss = await handleRequest(
      request("/api/beaches", { headers: { "if-none-match": "\"0000\"" } }), env
    );
    expect(miss.status).toBe(200);
  });

  it("dates the list by its freshest live estimate, null when none is live", async () => {
    const env = makeEnv([OVAL, OTTAWA, MONTROSE]);
    const seeds = [
      ["osm-way-1", "2026-07-04T15:00:00.000Z", LIVE_EXPIRES],
      ["osm-node-2", "2026-07-04T16:00:00.000Z", LIVE_EXPIRES],
      // Newest, but its lease has run out, so it dates nothing.
      ["osm-relation-3", "2026-07-04T17:00:00.000Z", NOW_EPOCH - 60]
    ];
    for (const seed of seeds) {
      env.DB.seedState(seed[0], {
        estimate: { color: "green", reason: "x", official: false, updated: seed[1] },
        estimate_color: "green",
        estimate_updated: seed[1],
        estimate_expires: seed[2]
      });
    }
    const live = await listBody("/api/beaches", env);
    expect(live.builtAt).toBe("2026-07-04T16:00:00.000Z");
    const one = await listBody("/api/beaches?ids=w1", env);
    expect(one.builtAt).toBe("2026-07-04T15:00:00.000Z");
    const none = await listBody("/api/beaches", makeEnv([OVAL, OTTAWA]));
    expect(none.builtAt).toBe(null);
  });

  it("changes the tag when an estimate's lease runs out, with no write", async () => {
    const env = makeEnv([OVAL], { "osm-way-1": "red" });
    const before = (await handleRequest(request("/api/beaches/w1"), env)).headers.get("etag");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date((LIVE_EXPIRES + 1) * 1000));
      const after = await handleRequest(
        request("/api/beaches/w1", { headers: { "if-none-match": before } }), env
      );
      expect(after.status).toBe(200);
      expect((await after.json()).display.color).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /api/beaches/:id and the /api/flag alias", () => {
  const ESTIMATES = { "osm-node-2": "yellow" };

  it("answers one beach with the additive name, lat, lon and links", async () => {
    const env = makeEnv([OTTAWA], ESTIMATES);
    const res = await handleRequest(request("/api/beaches/n2"), env, makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(CACHEABLE);
    expectCors(res);
    const body = await res.json();
    expect(body.beachId).toBe("n2");
    expect(body.name).toBe("Holland State Park");
    expect(body.lat).toBe(42.775);
    expect(body.lon).toBe(-86.211);
    expect(body.links).toEqual({ page: "/beach/n2", api: "/api/beaches/n2" });
    expect(body.display).toEqual({ color: "yellow", source: "estimate", forecast: false });
    expect(body.estimate.color).toBe("yellow");
    expect(body.official).toBe(null);
  });

  it("sends a strong ETag and answers a matching If-None-Match with 304", async () => {
    const env = makeEnv([OTTAWA], ESTIMATES);
    const first = await handleRequest(request("/api/beaches/n2"), env, makeCtx());
    expect(first.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(ETAG_SHAPE);
    for (const path of ["/api/beaches/n2", "/api/flag/n2"]) {
      const res = await handleRequest(
        request(path, { headers: { "if-none-match": "W/" + etag } }), env, makeCtx()
      );
      expect(res.status, path).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("etag")).toBe(etag);
      expectCors(res);
    }
  });

  it("serves an identical body under /api/flag/:id", async () => {
    const env = makeEnv([OTTAWA], ESTIMATES);
    const a = await (await handleRequest(request("/api/beaches/n2"), env, makeCtx())).text();
    const b = await (await handleRequest(request("/api/flag/n2"), env, makeCtx())).text();
    expect(b).toBe(a);
  });

  it("stamps last_viewed on both routes", async () => {
    for (const path of ["/api/beaches/n2", "/api/flag/n2"]) {
      const env = makeEnv([OTTAWA]);
      const ctx = makeCtx();
      await handleRequest(request(path), env, ctx);
      await Promise.all(ctx.promises);
      expect(lastViewedWrites(env).length, path).toBe(1);
    }
  });

  it("answers HEAD with the GET headers, no body and no last_viewed stamp", async () => {
    const env = makeEnv([OTTAWA], ESTIMATES);
    const get = await handleRequest(request("/api/beaches/n2"), env, makeCtx());
    const ctx = makeCtx();
    const head = await handleRequest(request("/api/beaches/n2", { method: "HEAD" }), env, ctx);
    await Promise.all(ctx.promises);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const name of ["etag", "content-type", "cache-control", "access-control-allow-origin"]) {
      expect(head.headers.get(name), name).toBe(get.headers.get(name));
    }
    expect(lastViewedWrites(env).length).toBe(1);
    const revalidated = await handleRequest(
      request("/api/beaches/n2", { method: "HEAD", headers: { "if-none-match": get.headers.get("etag") } }),
      env, makeCtx()
    );
    expect(revalidated.status).toBe(304);
  });

  it("301s a storage-form id to the canonical URL under the same prefix", async () => {
    const env = makeEnv([OTTAWA]);
    const a = await handleRequest(request("/api/beaches/osm-node-2"), env);
    expect(a.status).toBe(301);
    expect(a.headers.get("location")).toBe("/api/beaches/n2");
    expectCors(a);
    const b = await handleRequest(request("/api/flag/osm-node-2"), env);
    expect(b.status).toBe(301);
    expect(b.headers.get("location")).toBe("/api/flag/n2");
    expectCors(b);
  });

  it("404s unknown, malformed and inland beaches with the route's JSON", async () => {
    const env = makeEnv([OTTAWA, INLAND]);
    for (const path of ["/api/beaches/n999", "/api/beaches/banana", "/api/beaches/w4", "/api/beaches/%FF",
      "/api/flag/w4"]) {
      const res = await handleRequest(request(path), env);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "beach not found" });
      expectCors(res);
    }
  });
});

describe("redirects into the API", () => {
  it("301s /beach/<id>.json in either id form to /api/beaches/<public id>", async () => {
    for (const path of ["/beach/n2.json", "/beach/osm-node-2.json"]) {
      const res = await handleRequest(request(path), makeEnv([OTTAWA]));
      expect(res.status, path).toBe(301);
      expect(res.headers.get("location")).toBe("/api/beaches/n2");
      expect(res.headers.get("cache-control")).toBe(CACHEABLE);
      expectCors(res);
    }
    const bad = await handleRequest(request("/beach/banana.json"), makeEnv([OTTAWA]));
    expect(bad.status).toBe(404);
  });

  it("does not content-negotiate the page on Accept", async () => {
    const res = await handleRequest(
      request("/beach/n2", { headers: { accept: "application/json" } }), makeEnv([OTTAWA]), makeCtx()
    );
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("301s /api to /api/", async () => {
    const res = await handleRequest(request("/api"), makeEnv([]));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/api/");
    expectCors(res);
  });
});

describe("GET /api/ documentation page", () => {
  it("serves the HTML docs page, cacheable, with the disclaimer", async () => {
    const res = await handleRequest(request("/api/"), makeEnv([]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe(CACHEABLE);
    expectCors(res);
    const html = await res.text();
    expect(html.indexOf("<!doctype html>")).toBe(0);
    expect(html).toContain("Estimated — not the official flag status");
    expect(html).toContain("/api/beaches");
  });

  it("keeps the JSON 404 for every other unmatched /api/* path", async () => {
    for (const path of ["/api/nope", "/api/beaches/", "/api/beaches/n2/extra", "/api/flag"]) {
      const res = await handleRequest(request(path), makeEnv([]));
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      expectCors(res);
    }
  });
});

describe("CORS on /api/*", () => {
  it("answers OPTIONS on any /api/* path with a 204 preflight", async () => {
    for (const path of ["/api/beaches", "/api/beaches/n2", "/api/beaches.geojson", "/api/nope", "/api/"]) {
      const res = await handleRequest(request(path, { method: "OPTIONS" }), makeEnv([]));
      expect(res.status, path).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
      expect(res.headers.get("access-control-allow-headers")).toBe("If-None-Match, Accept");
      expect(res.headers.get("access-control-max-age")).toBe("86400");
      expect(await res.text()).toBe("");
    }
  });

  it("puts the headers on the GeoJSON and its 304", async () => {
    const env = makeEnv([OVAL]);
    const res = await handleRequest(request("/api/beaches.geojson"), env);
    expectCors(res);
    const again = await handleRequest(
      request("/api/beaches.geojson", { headers: { "if-none-match": res.headers.get("etag") } }), env
    );
    expect(again.status).toBe(304);
    expectCors(again);
  });

  it("405s non-GET on /api/* with CORS, and leaves OPTIONS elsewhere a 405", async () => {
    const post = await handleRequest(request("/api/beaches", { method: "POST" }), makeEnv([]));
    expect(post.status).toBe(405);
    expectCors(post);
    const page = await handleRequest(request("/", { method: "OPTIONS" }), makeEnv([]));
    expect(page.status).toBe(405);
    expect(page.headers.get("access-control-allow-origin")).toBe(null);
  });

  it("answers HEAD on the list API, the GeoJSON and the HTML pages", async () => {
    const env = makeEnv([OVAL], { "osm-way-1": "green" });
    for (const path of ["/api/beaches", "/api/beaches.geojson", "/", "/beach/w1", "/api/", "/health"]) {
      const get = await handleRequest(request(path), env, makeCtx());
      const head = await handleRequest(request(path, { method: "HEAD" }), env, makeCtx());
      expect(head.status, path).toBe(get.status);
      expect(await head.text(), path).toBe("");
      expect(head.headers.get("content-type"), path).toBe(get.headers.get("content-type"));
    }
    const missing = await handleRequest(request("/beach/w999", { method: "HEAD" }), env, makeCtx());
    expect(missing.status).toBe(404);
  });

  it("adds no CORS headers to the HTML pages", async () => {
    const res = await handleRequest(request("/?near=42,-86"), makeEnv([OVAL]));
    expect(res.headers.get("access-control-allow-origin")).toBe(null);
  });
});

describe("rel=alternate discovery on the HTML pages", () => {
  function alternateLinkTag(html) {
    const match = html.match(/<link rel="alternate" type="application\/json" href="([^"]*)">/);
    return match ? match[1] : null;
  }

  async function alternatesFor(path, cf) {
    const res = await handleRequest(request(path, { cf: cf }), makeEnv([OVAL, OTTAWA]), makeCtx());
    expect(res.status).toBe(200);
    const html = await res.text();
    return { header: res.headers.get("link"), tag: alternateLinkTag(html), html: html };
  }

  const LIST_CASES = [
    ["/", "/api/beaches"],
    ["/?q=oval", "/api/beaches?q=oval"],
    ["/?q=%20", "/api/beaches"],
    ["/?q=a%26b%20c", "/api/beaches?q=a%26b%20c"],
    ["/?near=42.5,-86.2", "/api/beaches?near=42.5,-86.2"],
    ["/?q=oval&near=42.5,-86.2", "/api/beaches?q=oval&near=42.5,-86.2"],
    ["/?near=banana", "/api/beaches"],
    ["/?ids=w1,osm-node-2,nope", "/api/beaches?ids=w1,n2"],
    ["/?ids=w1&q=oval", "/api/beaches?ids=w1"]
  ];

  for (const pair of LIST_CASES) {
    it("list page " + pair[0] + " links " + pair[1], async () => {
      const out = await alternatesFor(pair[0]);
      expect(out.tag).toBe(pair[1].split("&").join("&amp;"));
      expect(out.header).toBe("<" + pair[1] + ">; rel=\"alternate\"; type=\"application/json\"");
    });
  }

  it("never derives near from request.cf", async () => {
    const out = await alternatesFor("/", { latitude: "41.97", longitude: "-87.64" });
    expect(out.header).toBe("</api/beaches>; rel=\"alternate\"; type=\"application/json\"");
    expect(out.tag).toBe("/api/beaches");
  });

  it("detail page links /api/beaches/<public id>", async () => {
    const out = await alternatesFor("/beach/n2");
    expect(out.tag).toBe("/api/beaches/n2");
    expect(out.header).toBe("</api/beaches/n2>; rel=\"alternate\"; type=\"application/json\"");
  });

  it("puts the API link in every page footer, beside the disclaimer", async () => {
    for (const path of ["/", "/?ids=w1", "/beach/n2", "/api/"]) {
      const res = await handleRequest(request(path), makeEnv([OVAL, OTTAWA]), makeCtx());
      const html = await res.text();
      const footer = html.slice(html.indexOf("<footer"), html.indexOf("</footer>"));
      expect(footer, path).toContain("<a href=\"/api/\">API</a>");
      expect(footer, path).toContain("Estimated — not the official flag status");
    }
    const notFound = await (await handleRequest(request("/nope"), makeEnv([]))).text();
    expect(notFound).toContain("<a href=\"/api/\">API</a>");
    // An error page advertises no alternate.
    expect(alternateLinkTag(notFound)).toBe(null);
  });
});

describe("pure helpers", () => {
  it("parseNearParam accepts exactly two finite in-range numbers", () => {
    expect(parseNearParam("42.5,-86.2")).toEqual({ lat: 42.5, lon: -86.2 });
    expect(parseNearParam("-90,180")).toEqual({ lat: -90, lon: 180 });
    expect(parseNearParam(null)).toBe(null);
    expect(parseNearParam("42.5")).toBe(null);
    expect(parseNearParam(",1")).toBe(null);
    expect(parseNearParam("NaN,1")).toBe(null);
  });

  it("parseBeachesQuery names the mode", () => {
    expect(parseBeachesQuery(new URLSearchParams("")).mode).toBe("name");
    expect(parseBeachesQuery(new URLSearchParams("q=x")).mode).toBe("name");
    expect(parseBeachesQuery(new URLSearchParams("near=1,2")).mode).toBe("distance");
    expect(parseBeachesQuery(new URLSearchParams("ids=w1")).mode).toBe("ids");
    expect(parseBeachesQuery(new URLSearchParams("ids=w1&q=x")).error).toBeTruthy();
  });

  it("listAlternateHref and alternateLinkHeader", () => {
    expect(listAlternateHref(new URLSearchParams("near=1,2&q=x"))).toBe("/api/beaches?q=x&near=1,2");
    expect(alternateLinkHeader("/api/beaches")).toBe("</api/beaches>; rel=\"alternate\"; type=\"application/json\"");
  });

  it("beachDisplayName prefers the park name", () => {
    expect(beachDisplayName(OTTAWA)).toBe("Holland State Park");
    expect(beachDisplayName(OVAL)).toBe("Oval Beach");
    expect(beachDisplayName({ name: null })).toBe("");
  });
});
