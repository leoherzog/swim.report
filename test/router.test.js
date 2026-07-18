// test/router.test.js
// Pure-function coverage for the proximity-sorting helpers in src/router.js
// and the distance/sort-note rendering in src/frontend/render.js.

import { describe, it, expect } from "vitest";
import { distanceMi, resolveUserLocation, escapeLike, handleRequest } from "../src/router.js";
import { renderListPage, renderDetailPage } from "../src/frontend/render.js";

// Minimal D1/KV stand-in: records every prepared statement (sql + bound params)
// so tests can assert on the query the router built. all()/first() resolve to
// the supplied rows; KV always returns null (a bulk get with an array of keys
// resolves to a Map of key -> null, matching the Workers KV binding).
function nullFlags() {
  return {
    get: function (key) {
      if (Array.isArray(key)) {
        return Promise.resolve(new Map(key.map(function (k) { return [k, null]; })));
      }
      return Promise.resolve(null);
    }
  };
}

function makeEnv(rows, flags) {
  const statements = [];
  const db = {
    prepare: function (sql) {
      const st = {
        sql: sql,
        params: null,
        bind: function () {
          st.params = Array.prototype.slice.call(arguments);
          return st;
        },
        all: function () {
          statements.push(st);
          return Promise.resolve({ results: rows });
        },
        first: function () {
          statements.push(st);
          return Promise.resolve(rows[0] || null);
        }
      };
      return st;
    }
  };
  return { env: { DB: db, FLAGS: flags || nullFlags() }, statements: statements };
}

function homeRequest(search) {
  return { method: "GET", url: "https://swim.report/" + (search || ""), cf: {} };
}

function urlWith(search) {
  return new URL("https://swim.report/" + (search || ""));
}

describe("distanceMi", () => {
  it("returns 0 for identical points", () => {
    expect(distanceMi(42.4, -86.28, 42.4, -86.28)).toBe(0);
  });

  it("computes Chicago to Milwaukee as roughly 80 miles", () => {
    const d = distanceMi(41.8781, -87.6298, 43.0389, -87.9065);
    expect(d).toBeGreaterThan(75);
    expect(d).toBeLessThan(85);
  });

  it("is symmetric", () => {
    const a = distanceMi(41.8781, -87.6298, 43.0389, -87.9065);
    const b = distanceMi(43.0389, -87.9065, 41.8781, -87.6298);
    expect(a).toBeCloseTo(b, 10);
  });
});

describe("resolveUserLocation", () => {
  it("reads request.cf latitude/longitude strings", () => {
    const request = { cf: { latitude: "42.4088", longitude: "-86.2798" } };
    expect(resolveUserLocation(request, urlWith(""))).toEqual({ lat: 42.4088, lon: -86.2798 });
  });

  it("returns null when cf has no coordinates", () => {
    expect(resolveUserLocation({ cf: {} }, urlWith(""))).toBeNull();
    expect(resolveUserLocation({}, urlWith(""))).toBeNull();
  });

  it("lets a valid near param override cf", () => {
    const request = { cf: { latitude: "10", longitude: "10" } };
    const loc = resolveUserLocation(request, urlWith("?near=42.4,-86.28"));
    expect(loc).toEqual({ lat: 42.4, lon: -86.28 });
  });

  it("returns null for malformed or out-of-range near params", () => {
    const request = { cf: { latitude: "10", longitude: "10" } };
    expect(resolveUserLocation(request, urlWith("?near=banana"))).toBeNull();
    expect(resolveUserLocation(request, urlWith("?near=1,2,3"))).toBeNull();
    expect(resolveUserLocation(request, urlWith("?near=99,0"))).toBeNull();
    expect(resolveUserLocation(request, urlWith("?near=0,181"))).toBeNull();
  });
});

describe("escapeLike", () => {
  it("escapes the LIKE wildcards and the escape character itself", () => {
    expect(escapeLike("50% off")).toBe("50\\% off");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("c\\d")).toBe("c\\\\d");
    expect(escapeLike("%_\\")).toBe("\\%\\_\\\\");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeLike("Oval Beach")).toBe("Oval Beach");
  });
});

describe("handleHome ?q= search over the full table", () => {
  const rows = [{ id: "b1", name: "Oval Beach", park_name: null, lat: 42.6, lon: -86.2 }];

  it("filters D1 with a LIKE on both names when q is present (no location)", async () => {
    const { env, statements } = makeEnv(rows);
    const res = await handleRequest(homeRequest("?q=oval"), env);
    const stmt = statements[0];
    expect(stmt.sql).toContain("COALESCE(park_name, name) LIKE ?1 ESCAPE '\\'");
    expect(stmt.sql).toContain("OR name LIKE ?1 ESCAPE '\\'");
    expect(stmt.sql).toContain("ORDER BY COALESCE(park_name, name), name");
    expect(stmt.params).toEqual(["%oval%"]);
    const html = await res.text();
    expect(html).toContain("value=\"oval\"");
    expect(html).toContain("Showing results for <strong>oval</strong>");
  });

  it("escapes LIKE wildcards in the bound pattern", async () => {
    const { env, statements } = makeEnv(rows);
    await handleRequest(homeRequest("?q=50%25_x"), env);
    // %25 decodes to "%", so the raw term is "50%_x".
    expect(statements[0].params).toEqual(["%50\\%\\_x%"]);
  });

  it("combines q with near: filters first, then keeps the proximity query shape", async () => {
    const { env, statements } = makeEnv(rows);
    const res = await handleRequest(homeRequest("?q=oval&near=42.4,-86.28"), env);
    const stmt = statements[0];
    expect(stmt.sql).toContain("LIKE ?1 ESCAPE '\\'");
    expect(stmt.sql).toContain("LIMIT 500");
    expect(stmt.sql).not.toContain("ORDER BY");
    expect(stmt.params).toEqual(["%oval%"]);
    const html = await res.text();
    // The near param rides along in a hidden input so proximity survives submit.
    expect(html).toContain("<input type=\"hidden\" name=\"near\" value=\"42.4,-86.28\">");
  });

  it("ignores an empty or whitespace-only q (no LIKE clause, no bound pattern)", async () => {
    const blank = makeEnv(rows);
    await handleRequest(homeRequest("?q=%20%20"), blank.env);
    expect(blank.statements[0].sql).not.toContain("LIKE");
    expect(blank.statements[0].params).toBeNull();

    const missing = makeEnv(rows);
    await handleRequest(homeRequest(""), missing.env);
    expect(missing.statements[0].sql).not.toContain("LIKE");
    expect(missing.statements[0].params).toBeNull();
  });
});

describe("handleHome bulk KV wiring", () => {
  // Regression pin for the bulk-get plumbing: the flag: map must feed the
  // estimate slot (the row's flag chip color) and the official: map the
  // official slot (the OFFICIAL badge). The two values carry DIFFERENT colors
  // so swapping maps[0]/maps[1] — which would render a scraped official color
  // as an estimate — fails the chip-color assertions below.
  it("renders the flag: value as the estimate chip and the official: value as the official badge", async () => {
    const rows = [{ id: "b1", name: "Oval Beach", park_name: null, lat: 42.6, lon: -86.2 }];
    const requestedKeyLists = [];
    const kvValues = {
      "flag:b1": {
        color: "yellow",
        reason: "Estimated wave height 2.5 ft (2–4 ft)",
        rules_version: "1.1.0",
        official: false,
        sources: [],
        updated: "2026-07-05T12:00:00.000Z"
      },
      "official:b1": {
        color: "red",
        reason: "Official flag reported by Example Beach Program",
        official: true,
        source: "https://example.gov/flags",
        sources: ["https://example.gov/flags"],
        updated: "2026-07-05T12:00:00.000Z"
      }
    };
    const flags = {
      get: function (key) {
        if (Array.isArray(key)) {
          requestedKeyLists.push(key);
          return Promise.resolve(new Map(key.map(function (k) {
            return [k, kvValues[k] || null];
          })));
        }
        return Promise.resolve(kvValues[key] || null);
      }
    };
    const { env } = makeEnv(rows, flags);
    const res = await handleRequest(homeRequest(""), env);
    expect(res.status).toBe(200);
    // Both key families were requested as bulk arrays, flag: first.
    expect(requestedKeyLists).toEqual([["flag:b1"], ["official:b1"]]);
    const html = await res.text();
    // Scope to the beach row: the embedded stylesheet legitimately mentions
    // every flag-icon-* class, so assertions must target the rendered markup.
    const rowStart = html.indexOf("<li class=\"beach-row\"");
    expect(rowStart).toBeGreaterThan(-1);
    const row = html.slice(rowStart, html.indexOf("</li>", rowStart));
    // The estimate slot drives the chip: yellow, never the official's red.
    expect(row).toContain("flag-icon-yellow");
    expect(row).toContain(">YELLOW</wa-badge>");
    expect(row).not.toContain("flag-icon-red");
    expect(row).not.toContain(">RED</wa-badge>");
    // The official slot drives the OFFICIAL badge on the row.
    expect(row).toContain(">OFFICIAL</wa-badge>");
  });
});

describe("renderListPage search form", () => {
  it("wraps the search input in a GET form posting name=q, preserving near", () => {
    const html = renderListPage({
      entries: [],
      nowIso: "2026-07-05T12:00:00.000Z",
      near: "42.4,-86.28"
    });
    expect(html).toContain("<form id=\"beach-search-form\"");
    expect(html).toContain("method=\"get\"");
    expect(html).toContain("action=\"/\"");
    expect(html).toContain("name=\"q\"");
    expect(html).toContain("<input type=\"hidden\" name=\"near\" value=\"42.4,-86.28\">");
  });

  it("shows the no-match empty state (not the empty-database copy) on a q-filtered page with zero results", () => {
    // Regression: a search miss against a populated table used to fall through
    // to "No beaches found yet. Check back soon.", telling the searcher the
    // site has no beaches at all.
    const html = renderListPage({
      entries: [],
      nowIso: "2026-07-05T12:00:00.000Z",
      query: "xyzzy"
    });
    expect(html).toContain("No beaches match your search.");
    expect(html).not.toContain("No beaches found yet");
  });

  it("keeps the empty-database copy on the default listing with zero rows", () => {
    const html = renderListPage({
      entries: [],
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    expect(html).toContain("No beaches found yet. Check back soon.");
  });

  it("shows the active query and a clear-search link on a q-filtered page", () => {
    const html = renderListPage({
      entries: [],
      nowIso: "2026-07-05T12:00:00.000Z",
      query: "oval",
      near: "42.4,-86.28"
    });
    expect(html).toContain("value=\"oval\"");
    expect(html).toContain("Showing results for <strong>oval</strong>");
    expect(html).toContain("href=\"/?near=42.4%2C-86.28\"");
  });

  it("offers a submit-to-server button in the empty state only when more beaches exist and no query is active", () => {
    const withMore = renderListPage({
      entries: [{ beach: { id: "b", name: "A", lat: 42, lon: -86 }, estimate: null, official: null, distanceMi: null }],
      nowIso: "2026-07-05T12:00:00.000Z",
      hasMore: true
    });
    expect(withMore).toContain("form=\"beach-search-form\"");
    expect(withMore).toContain("Search all beaches");

    // On a q-filtered page the rendered rows are already whole-table matches.
    const onQueryPage = renderListPage({
      entries: [{ beach: { id: "b", name: "A", lat: 42, lon: -86 }, estimate: null, official: null, distanceMi: null }],
      nowIso: "2026-07-05T12:00:00.000Z",
      hasMore: true,
      query: "oval"
    });
    expect(onQueryPage).not.toContain("Search all beaches");

    // No extra beaches beyond those rendered: nothing to offer.
    const noMore = renderListPage({
      entries: [{ beach: { id: "b", name: "A", lat: 42, lon: -86 }, estimate: null, official: null, distanceMi: null }],
      nowIso: "2026-07-05T12:00:00.000Z",
      hasMore: false
    });
    expect(noMore).not.toContain("Search all beaches");
  });
});

describe("renderListPage geolocation script", () => {
  it("embeds the browser geolocation upgrade script with its runtime guards", () => {
    const html = renderListPage({
      entries: [],
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    // The script is always embedded; skipping is a RUNTIME decision so the
    // near-less page can upgrade itself. Assert the load-bearing pieces: the
    // capability check, the near short-circuit (loop prevention), the rounded
    // near param, and the replace-not-assign navigation.
    expect(html).toContain("'geolocation' in navigator");
    expect(html).toContain("params.get('near')");
    expect(html).toContain("getCurrentPosition");
    expect(html).toContain("lat.toFixed(3) + ',' + lon.toFixed(3)");
    expect(html).toContain("window.location.replace('/?' + params.toString())");
  });
});

describe("renderListPage proximity output", () => {
  function entryFor(name, dist) {
    return {
      beach: { id: "b-" + name, name: name, lat: 42, lon: -86 },
      estimate: null,
      official: null,
      distanceMi: dist
    };
  }

  it("shows rounded distance labels when sorted (the sort note is gone — row distances carry the signal)", () => {
    const html = renderListPage({
      entries: [entryFor("Near Beach", 0.4), entryFor("Far Beach", 12.4)],
      nowIso: "2026-07-05T12:00:00.000Z",
      sortedByProximity: true
    });
    expect(html).toContain("&lt;1 mi");
    expect(html).toContain("~12 mi");
    expect(html).not.toContain("Sorted by approximate distance");
  });

  it("embeds a Windy wave map on the detail page centered on the beach", () => {
    const html = renderDetailPage({
      beach: { id: "b-1", name: "Oval Beach", lat: 42.6579, lon: -86.2114, osm_id: "way/1" },
      estimate: null,
      official: null,
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    expect(html).toContain("<iframe class=\"wave-map-frame\"");
    expect(html).toContain(" title=\"Wave height map\" loading=\"lazy\" allowfullscreen></iframe>");
    expect(html).toContain("https://embed.windy.com/embed.html");
    expect(html).toContain("overlay=waves");
    expect(html).toContain("lat=42.658");
    expect(html).toContain("lon=-86.211");
  });

  it("puts labeled sources in the card header and Updated in the footer", () => {
    const html = renderDetailPage({
      beach: { id: "b-1", name: "Oval Beach", lat: 42.6579, lon: -86.2114, osm_id: "way/1" },
      estimate: {
        color: "green",
        reason: "Estimated wave height 1.3 ft (below 2 ft)",
        trigger: "wave-height",
        rules_version: "1.1.0",
        official: false,
        sources: [
          { label: "ECMWF Wave Forecast", url: "https://open-meteo.com/en/docs/marine-weather-api" },
          { label: "NWS Surf Zone Forecast" },
          "https://api.weather.gov/alerts/active?zone=MIZ071"
        ],
        updated: "2026-07-05T12:00:00.000Z"
      },
      official: null,
      nowIso: "2026-07-05T12:30:00.000Z"
    });
    expect(html).toContain("with-header-actions");
    expect(html).toContain("<div slot=\"header-actions\">");
    // Labels render as quiet badge chips — the upstream url is never hyperlinked.
    expect(html).toContain("<wa-badge variant=\"neutral\" appearance=\"filled\" pill>ECMWF Wave Forecast</wa-badge>");
    expect(html).not.toContain("https://open-meteo.com/en/docs/marine-weather-api");
    expect(html).toContain("<wa-badge variant=\"neutral\" appearance=\"filled\" pill>NWS Surf Zone Forecast</wa-badge>");
    // Legacy bare-string sources render as their hostname, unlinked.
    expect(html).toContain("<wa-badge variant=\"neutral\" appearance=\"filled\" pill>api.weather.gov</wa-badge>");
    expect(html).not.toContain("https://api.weather.gov");
    expect(html).toContain(
      "<div slot=\"footer\" class=\"wa-caption-s\">Updated " +
      "<wa-relative-time date=\"2026-07-05T12:00:00.000Z\" sync></wa-relative-time></div>"
    );
    expect(html).not.toContain("Sources:");
  });

  it("renders the official card with the same layout: source top right, Updated in footer", () => {
    const html = renderDetailPage({
      beach: { id: "b-1", name: "South Beach", lat: 42.3991, lon: -86.2842, osm_id: "way/9" },
      estimate: null,
      official: {
        color: "green",
        reason: "Official flag reported by City of South Haven Beach Flag Program",
        official: true,
        scraperId: "south-haven-mi",
        source: "https://www.southhavenmi.gov/parks_and_recreation/beach_flag_information.php",
        sources: ["https://www.southhavenmi.gov/parks_and_recreation/beach_flag_information.php"],
        updated: "2026-07-05T14:00:00.000Z"
      },
      nowIso: "2026-07-05T14:30:00.000Z"
    });
    // Slice on the rendered card markers — the bare class names also appear
    // in the embedded stylesheet.
    const officialCard = html.slice(html.indexOf("class=\"official-card\""),
      html.indexOf("class=\"estimate-card\""));
    expect(officialCard).toContain("with-header-actions");
    expect(officialCard).toContain("<div slot=\"header-actions\">");
    // Scraped official sources are the one case that links out — hostname
    // ("www." stripped) linking to the source page.
    expect(officialCard).toContain(
      "<a href=\"https://www.southhavenmi.gov/parks_and_recreation/beach_flag_information.php\" " +
      "rel=\"noopener noreferrer\">southhavenmi.gov</a>"
    );
    expect(officialCard).toContain(
      "<div slot=\"footer\" class=\"wa-caption-s\">Updated " +
      "<wa-relative-time date=\"2026-07-05T14:00:00.000Z\" sync></wa-relative-time></div>"
    );
    expect(officialCard).not.toContain("Source:");
  });

  it("omits header actions and footer when there is no estimate", () => {
    const html = renderDetailPage({
      beach: { id: "b-1", name: "Oval Beach", lat: 42.6579, lon: -86.2114, osm_id: "way/1" },
      estimate: null,
      official: null,
      nowIso: "2026-07-05T12:30:00.000Z"
    });
    expect(html).not.toContain("with-header-actions");
    expect(html).not.toContain("with-footer");
    expect(html).not.toContain("class=\"wa-caption-s\">Updated ");
  });

  it("omits the wave map when the beach has no usable coordinates", () => {
    const html = renderDetailPage({
      beach: { id: "b-2", name: "No Coords Beach", lat: null, lon: null, osm_id: "way/2" },
      estimate: null,
      official: null,
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    expect(html).not.toContain("<iframe class=\"wave-map-frame\"");
  });

  it("omits distances and the note when not sorted", () => {
    const html = renderListPage({
      entries: [entryFor("Some Beach", null)],
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    expect(html).not.toContain("<span class=\"beach-row-distance");
    expect(html).not.toContain("Sorted by approximate distance");
  });
});

describe("handleDetail waves: KV read", () => {
  // DB stand-in whose first() always yields the beach row; FLAGS records every
  // requested key. 'wavesValue' is returned for the "waves:" key (null else).
  function detailEnv(beach, wavesValue) {
    const keys = [];
    const db = {
      prepare: function () {
        const st = {
          bind: function () { return st; },
          first: function () { return Promise.resolve(beach); }
        };
        return st;
      }
    };
    const flags = {
      get: function (key) {
        keys.push(key);
        if (key.indexOf("waves:") === 0) {
          return Promise.resolve(wavesValue || null);
        }
        return Promise.resolve(null);
      }
    };
    return { env: { DB: db, FLAGS: flags }, keys: keys };
  }

  function detailRequest(id) {
    return { method: "GET", url: "https://swim.report/beach/" + id, cf: {} };
  }

  const beach = { id: "b-1", name: "Oval Beach", lat: 42.6579, lon: -86.2114, osm_id: "way/1" };

  it("requests the waves: series alongside the flag/official keys", async () => {
    const { env, keys } = detailEnv(beach, null);
    const res = await handleRequest(detailRequest("b-1"), env);
    expect(res.status).toBe(200);
    expect(keys).toContain("waves:b-1");
    expect(keys).toContain("flag:b-1");
    expect(keys).toContain("official:b-1");
  });

  it("still renders 200 when a WaveSeries is present", async () => {
    const series = {
      beachId: "b-1",
      startIso: "2026-07-15T16:00:00.000Z",
      hoursFt: [1.6, 1.7, 1.8],
      models: ["ecmwf_wam025"],
      sources: [{ label: "ECMWF Wave Forecast", url: "https://open-meteo.com/en/docs/marine-weather-api" }],
      updated: "2026-07-15T16:20:33.000Z"
    };
    const { env } = detailEnv(beach, series);
    const res = await handleRequest(detailRequest("b-1"), env);
    expect(res.status).toBe(200);
  });
});

// D1/KV stand-in for the cache-header and last_viewed tests: every prepared
// statement is recorded (sql + params) and first()/all()/run() all resolve.
// first() yields 'beach' (or null), all() yields it as the only row.
function viewEnv(beach) {
  const statements = [];
  const db = {
    prepare: function (sql) {
      const st = {
        sql: sql,
        params: null,
        bind: function () {
          st.params = Array.prototype.slice.call(arguments);
          return st;
        },
        first: function () {
          statements.push(st);
          return Promise.resolve(beach || null);
        },
        all: function () {
          statements.push(st);
          return Promise.resolve({ results: beach ? [beach] : [] });
        },
        run: function () {
          statements.push(st);
          return Promise.resolve({ success: true });
        }
      };
      return st;
    }
  };
  return { env: { DB: db, FLAGS: nullFlags() }, statements: statements };
}

function makeCtx() {
  const promises = [];
  return {
    promises: promises,
    waitUntil: function (p) {
      promises.push(p);
    }
  };
}

function getRequest(path) {
  return { method: "GET", url: "https://swim.report" + path, cf: {} };
}

const CACHEABLE = "public, max-age=60, stale-while-revalidate=600, stale-if-error=600";

describe("cache-control policy (Workers Cache)", () => {
  const beach = { id: "b-1", name: "Oval Beach", lat: 42.6579, lon: -86.2114, osm_id: "way/1", last_viewed: null };

  it("never caches the home page (personalized by request.cf geolocation)", async () => {
    const { env } = viewEnv(beach);
    const res = await handleRequest(getRequest("/"), env);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("marks a found detail page cacheable with bounded stale windows", async () => {
    const { env } = viewEnv(beach);
    const res = await handleRequest(getRequest("/beach/b-1"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(CACHEABLE);
  });

  it("never caches a detail 404", async () => {
    const { env } = viewEnv(null);
    const res = await handleRequest(getRequest("/beach/nope"), env);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("marks /api/flag and /api/beaches cacheable, /api/flag 404 max-age only", async () => {
    const found = viewEnv(beach);
    const flagRes = await handleRequest(getRequest("/api/flag/b-1"), found.env);
    expect(flagRes.headers.get("cache-control")).toBe(CACHEABLE);

    const missing = viewEnv(null);
    const flag404 = await handleRequest(getRequest("/api/flag/nope"), missing.env);
    expect(flag404.status).toBe(404);
    expect(flag404.headers.get("cache-control")).toBe("public, max-age=60");

    const bboxRes = await handleRequest(
      getRequest("/api/beaches?bbox=-87,41,-82,47"), viewEnv(beach).env
    );
    expect(bboxRes.headers.get("cache-control")).toBe(CACHEABLE);
  });

  it("never caches /health, invalid bbox, or generic 404s", async () => {
    const { env } = viewEnv(beach);
    expect((await handleRequest(getRequest("/health"), env)).headers.get("cache-control")).toBe("no-store");
    expect((await handleRequest(getRequest("/api/beaches?bbox=bad"), env)).headers.get("cache-control")).toBe("no-store");
    expect((await handleRequest(getRequest("/api/nope"), env)).headers.get("cache-control")).toBe("no-store");
    expect((await handleRequest(getRequest("/nope"), env)).headers.get("cache-control")).toBe("no-store");
  });
});

describe("last_viewed demand stamping", () => {
  function beachViewed(lastViewed) {
    return { id: "b-1", name: "Oval Beach", lat: 42.6579, lon: -86.2114, osm_id: "way/1", last_viewed: lastViewed };
  }

  function updateStatements(statements) {
    return statements.filter(function (st) {
      return st.sql.indexOf("UPDATE beaches SET last_viewed") === 0;
    });
  }

  it("stamps a never-viewed beach via ctx.waitUntil on the detail page", async () => {
    const { env, statements } = viewEnv(beachViewed(null));
    const ctx = makeCtx();
    const res = await handleRequest(getRequest("/beach/b-1"), env, ctx);
    expect(res.status).toBe(200);
    expect(ctx.promises.length).toBe(1);
    await Promise.all(ctx.promises);
    const updates = updateStatements(statements);
    expect(updates.length).toBe(1);
    expect(updates[0].params[1]).toBe("b-1");
    // Param 1 is a fresh ISO timestamp.
    expect(Number.isFinite(Date.parse(updates[0].params[0]))).toBe(true);
  });

  it("stamps on /api/flag too, selecting last_viewed for the throttle check", async () => {
    const { env, statements } = viewEnv(beachViewed(null));
    const ctx = makeCtx();
    await handleRequest(getRequest("/api/flag/b-1"), env, ctx);
    expect(statements[0].sql).toContain("SELECT id, last_viewed FROM beaches");
    await Promise.all(ctx.promises);
    expect(updateStatements(statements).length).toBe(1);
  });

  it("throttles: a stamp within the last hour is not repeated", async () => {
    const fresh = new Date(Date.now() - 60000).toISOString();
    const { env, statements } = viewEnv(beachViewed(fresh));
    const ctx = makeCtx();
    await handleRequest(getRequest("/beach/b-1"), env, ctx);
    expect(ctx.promises.length).toBe(0);
    expect(updateStatements(statements).length).toBe(0);
  });

  it("re-stamps once the previous view is over an hour old", async () => {
    const stale = new Date(Date.now() - 7200000).toISOString();
    const { env, statements } = viewEnv(beachViewed(stale));
    const ctx = makeCtx();
    await handleRequest(getRequest("/beach/b-1"), env, ctx);
    await Promise.all(ctx.promises);
    expect(updateStatements(statements).length).toBe(1);
  });

  it("no-ops without ctx (render is unaffected)", async () => {
    const { env, statements } = viewEnv(beachViewed(null));
    const res = await handleRequest(getRequest("/beach/b-1"), env);
    expect(res.status).toBe(200);
    expect(updateStatements(statements).length).toBe(0);
  });
});
