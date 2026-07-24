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

describe("flag-worthy water gate", () => {
  const GATE = "water_class IN ('ocean','great_lake')";

  it("composes the gate into the home-list WHERE (no query)", async () => {
    const { env, statements } = makeEnv([]);
    await handleRequest(homeRequest(""), env);
    expect(statements[0].sql).toContain(GATE);
    expect(statements[0].sql).toContain("water_class IS NULL AND water_class_attempts < 5");
  });

  it("ANDs the gate after the LIKE clause on a ?q= search", async () => {
    const { env, statements } = makeEnv([]);
    await handleRequest(homeRequest("?q=oval"), env);
    expect(statements[0].sql).toContain("LIKE ?1 ESCAPE '\\'");
    expect(statements[0].sql).toContain(" AND " + "(water_class IN ('ocean','great_lake')");
  });

  it("ANDs the gate into the /api/beaches.geojson SELECT (no bbox predicate)", async () => {
    const { env, statements } = makeEnv([]);
    await handleRequest(getRequest("/api/beaches.geojson"), env);
    expect(statements[0].sql).toContain(GATE);
    // The full-directory read has no bbox range predicate and no LIMIT.
    expect(statements[0].sql).not.toContain("lon >=");
    expect(statements[0].sql).not.toContain("LIMIT");
  });

  it("404s the detail page for a confirmed-inland beach", async () => {
    const inland = { id: "b-in", name: "Fremont Lake", lat: 43.4, lon: -85.9, osm_id: "way/1", water_class: "inland", water_class_attempts: 0 };
    const { env } = viewEnv(inland);
    const res = await handleRequest(getRequest("/beach/b-in"), env);
    expect(res.status).toBe(404);
  });

  it("renders the detail page for a NULL-pending beach (still visible during backfill)", async () => {
    const pending = { id: "b-p", name: "Oval Beach", lat: 42.6, lon: -86.2, osm_id: "way/2", water_class: null, water_class_attempts: 0 };
    const { env } = viewEnv(pending);
    const res = await handleRequest(getRequest("/beach/b-p"), env);
    expect(res.status).toBe(200);
  });

  it("renders the detail page for a confirmed great_lake beach", async () => {
    const keeper = { id: "b-gl", name: "South Beach", lat: 42.4, lon: -86.3, osm_id: "way/3", water_class: "great_lake", water_class_attempts: 0 };
    const { env } = viewEnv(keeper);
    const res = await handleRequest(getRequest("/beach/b-gl"), env);
    expect(res.status).toBe(200);
  });

  it("hides a parked-unresolved beach (NULL at the attempts cap) from the detail page", async () => {
    const parked = { id: "b-parked", name: "Puddle", lat: 43.4, lon: -85.9, osm_id: "way/4", water_class: null, water_class_attempts: 5 };
    const { env } = viewEnv(parked);
    const res = await handleRequest(getRequest("/beach/b-parked"), env);
    expect(res.status).toBe(404);
  });

  it("404s /api/flag for a confirmed-inland beach and 200s a keeper", async () => {
    const inland = { id: "b-in", name: "Fremont Lake", lat: 43.4, lon: -85.9, osm_id: "way/1", last_viewed: null, water_class: "inland", water_class_attempts: 0 };
    const inRes = await handleRequest(getRequest("/api/flag/b-in"), viewEnv(inland).env);
    expect(inRes.status).toBe(404);

    const keeper = { id: "b-gl", name: "South Beach", lat: 42.4, lon: -86.3, osm_id: "way/3", last_viewed: null, water_class: "great_lake", water_class_attempts: 0 };
    const okRes = await handleRequest(getRequest("/api/flag/b-gl"), viewEnv(keeper).env);
    expect(okRes.status).toBe(200);
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

  it("marks the list data-complete only on an uncapped default listing", () => {
    const row = { beach: { id: "b", name: "A", lat: 42, lon: -86 }, estimate: null, official: null, distanceMi: null };
    const base = { entries: [row], nowIso: "2026-07-05T12:00:00.000Z" };
    // Whole table rendered (not capped, no query): local filter is exhaustive.
    // (Match the ul attribute specifically — the inline search script also
    // mentions data-complete, so a bare substring check would be meaningless.)
    expect(renderListPage(base)).toContain("id=\"beach-list-items\" data-complete=\"1\"");
    // More beaches exist than rendered: the client must still hit the server.
    expect(renderListPage({ ...base, hasMore: true }))
      .not.toContain("id=\"beach-list-items\" data-complete");
    // A q-filtered page's rows are matches, not the full table.
    expect(renderListPage({ ...base, query: "oval" }))
      .not.toContain("id=\"beach-list-items\" data-complete");
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
    // near param, the in-place fetch-and-swap (no navigation on success), the
    // URL rewrite that keeps refreshes/links/submits proximity-sorted, the map
    // notification event, and the full-navigation fallback for a failed fetch.
    expect(html).toContain("'geolocation' in navigator");
    expect(html).toContain("params.get('near')");
    expect(html).toContain("getCurrentPosition");
    expect(html).toContain("lat.toFixed(3) + ',' + lon.toFixed(3)");
    expect(html).toContain("fetch(nextUrl)");
    expect(html).toContain("new DOMParser().parseFromString(html, 'text/html')");
    expect(html).toContain("window.history.replaceState(null, '', nextUrl)");
    expect(html).toContain("document.dispatchEvent(new CustomEvent('swimreport:nearupdate'))");
    expect(html).toContain("window.location.replace(nextUrl)");
  });

  it("renders the polite live region the swap announces into", () => {
    const html = renderListPage({
      entries: [],
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    expect(html).toContain(
      "<p id=\"geo-live-region\" class=\"visually-hidden\" role=\"status\" aria-live=\"polite\"></p>"
    );
  });
});

describe("document shell color scheme", () => {
  it("embeds a blocking OS color-scheme script in head before the theme stylesheet", () => {
    const html = renderListPage({
      entries: [],
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    // Load-bearing pieces of the inline script: the media query, the wa-dark
    // class toggle on <html>, and the change-event subscription for live OS
    // switches.
    expect(html).toContain("window.matchMedia('(prefers-color-scheme: dark)')");
    expect(html).toContain("document.documentElement.classList.toggle('wa-dark', dark)");
    expect(html).toContain("query.addEventListener('change'");
    // It must run BEFORE the theme stylesheets paint (no light flash for
    // dark-preference visitors), so the script precedes the matter.css link.
    const scriptAt = html.indexOf("prefers-color-scheme: dark");
    const themeCssAt = html.indexOf("matter.css");
    expect(scriptAt).toBeGreaterThan(-1);
    expect(themeCssAt).toBeGreaterThan(scriptAt);
  });

  it("keeps the server-rendered html class list static — wa-dark is a runtime-only toggle", () => {
    const html = renderListPage({
      entries: [],
      nowIso: "2026-07-05T12:00:00.000Z"
    });
    expect(html).toContain("<html lang=\"en\" class=\"wa-theme-matter wa-palette-mild wa-cloak\" data-fa-kit-code=\"ddd41b2d81\">");
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
    // Labels render as quiet badge chips — the source url is never hyperlinked in
    // the card. (The one allowed occurrence of the docs url is the footer's own
    // Open-Meteo attribution link, unrelated to this beach's sources.)
    expect(html).toContain("<wa-badge variant=\"neutral\" appearance=\"filled\" pill>ECMWF Wave Forecast</wa-badge>");
    expect(html.split("https://open-meteo.com/en/docs/marine-weather-api").length - 1).toBe(1);
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

  it("never caches the home page WITHOUT near (personalized by request.cf geolocation)", async () => {
    const { env } = viewEnv(beach);
    const res = await handleRequest(getRequest("/"), env);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("caches the home page WITH an explicit near (URL-determined, no request.cf read)", async () => {
    // Every live-search / geo-upgrade fetch carries near, so this is the hot
    // path: resolveUserLocation short-circuits on near and never touches
    // request.cf, making the response safe for the Workers Cache.
    const near = await handleRequest(getRequest("/?near=42.658,-86.211"), viewEnv(beach).env);
    expect(near.status).toBe(200);
    expect(near.headers.get("cache-control")).toBe(CACHEABLE);

    const searchNear = await handleRequest(getRequest("/?q=oval&near=42.658,-86.211"), viewEnv(beach).env);
    expect(searchNear.headers.get("cache-control")).toBe(CACHEABLE);

    // A q search WITHOUT near still falls through to request.cf, so it stays no-store.
    const searchNoNear = await handleRequest(getRequest("/?q=oval"), viewEnv(beach).env);
    expect(searchNoNear.headers.get("cache-control")).toBe("no-store");
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

  it("marks /api/flag and /api/beaches.geojson cacheable, /api/flag 404 max-age only", async () => {
    const found = viewEnv(beach);
    const flagRes = await handleRequest(getRequest("/api/flag/b-1"), found.env);
    expect(flagRes.headers.get("cache-control")).toBe(CACHEABLE);

    const missing = viewEnv(null);
    const flag404 = await handleRequest(getRequest("/api/flag/nope"), missing.env);
    expect(flag404.status).toBe(404);
    expect(flag404.headers.get("cache-control")).toBe("public, max-age=60");

    const geoRes = await handleRequest(
      getRequest("/api/beaches.geojson"), viewEnv(beach).env
    );
    expect(geoRes.headers.get("cache-control")).toBe(CACHEABLE);
    expect(geoRes.headers.get("content-type")).toContain("application/geo+json");
  });

  it("never caches /health or generic 404s", async () => {
    const { env } = viewEnv(beach);
    expect((await handleRequest(getRequest("/health"), env)).headers.get("cache-control")).toBe("no-store");
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
    expect(statements[0].sql).toContain("SELECT id, last_viewed, water_class, water_class_attempts FROM beaches");
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

// ---------------------------------------------------------------------------
// Appended coverage: worker entrypoint (error boundary + cron dispatch),
// router guards (405, proximity ordering), and render.js
// invariants (stale warnings, honest unknown, double-red, footer disclaimer,
// source labels, escapeHtml, formatMiles, search-script id contract).
// ---------------------------------------------------------------------------

import { vi } from "vitest";
import worker from "../src/index.js";
import { escapeHtml } from "../src/frontend/render.js";
import { LIST_SEARCH_SCRIPT } from "../src/frontend/searchScript.js";
import { LIST_SWAP_SCRIPT } from "../src/frontend/listSwapScript.js";
import { LIST_GEO_SCRIPT } from "../src/frontend/geoScript.js";

const NOW_ISO = "2026-07-05T12:00:00.000Z";
const OVAL = { id: "b-1", name: "Oval Beach", lat: 42.6579, lon: -86.2114, osm_id: "way/1" };

// Env whose D1 binding throws synchronously on prepare — the simplest way to
// make any DB-touching route (or cron runner) fail.
function throwingEnv() {
  return {
    DB: {
      prepare: function () {
        throw new Error("boom");
      }
    },
    FLAGS: nullFlags()
  };
}

// Slices the rendered document to one element's markup so assertions never
// match the embedded stylesheet (which legitimately names every flag class).
function sliceBetween(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end + endMarker.length);
}

function estimateCardOf(html) {
  return sliceBetween(html, "<wa-card class=\"estimate-card\"", "</wa-card>");
}

function officialCardOf(html) {
  return sliceBetween(html, "<wa-card class=\"official-card\"", "</wa-card>");
}

function beachRowOf(html) {
  return sliceBetween(html, "<li class=\"beach-row\"", "</li>");
}

function detailPage(estimate, official, waves) {
  return renderDetailPage({
    beach: OVAL,
    estimate: estimate || null,
    official: official || null,
    waves: waves || null,
    nowIso: NOW_ISO
  });
}

describe("default fetch export: request-path error boundary", () => {
  it("renders the project 500 page (not a bare throw) when a page route fails", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    try {
      const res = await worker.fetch(homeRequest(""), throwingEnv(), makeCtx());
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Something went wrong.");
      const logged = logSpy.mock.calls.map(function (c) { return String(c[0]); }).join("\n");
      expect(logged).toContain("index: request handler threw: boom");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("returns 500 JSON {error: internal error} for a failing /api/ route", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    try {
      const res = await worker.fetch(
        getRequest("/api/beaches.geojson"), throwingEnv(), makeCtx()
      );
      expect(res.status).toBe(500);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body).toEqual({ error: "internal error" });
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("default scheduled export: cron dispatch", () => {
  it("logs and never calls waitUntil for an unknown cron", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    try {
      const ctx = makeCtx();
      worker.scheduled({ cron: "0 0 * * *" }, throwingEnv(), ctx);
      expect(ctx.promises.length).toBe(0);
      const logged = logSpy.mock.calls.map(function (c) { return String(c[0]); }).join("\n");
      expect(logged).toContain("index: scheduled invoked with unknown cron: 0 0 * * *");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("dispatches a known cron via waitUntil and its promise resolves even when D1 fails", async () => {
    // runFlagRecompute catches its own failures (logging "flag recompute
    // failed"), so a DB throw resolves the waitUntil promise rather than
    // reaching the scheduled .catch — either layer keeps the cron from
    // surfacing an unhandled rejection.
    const logSpy = vi.spyOn(console, "log").mockImplementation(function () {});
    try {
      const ctx = makeCtx();
      worker.scheduled({ cron: "7 * * * *" }, throwingEnv(), ctx);
      expect(ctx.promises.length).toBe(1);
      await expect(Promise.all(ctx.promises)).resolves.toBeDefined();
      const logged = logSpy.mock.calls.map(function (c) { return String(c[0]); }).join("\n");
      expect(logged).toContain("index: flag recompute failed: boom");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("router guards: method validation", () => {
  it("rejects non-GET requests with a 405 text/plain body", async () => {
    const { env } = viewEnv(null);
    const res = await handleRequest({ method: "POST", url: "https://swim.report/", cf: {} }, env);
    expect(res.status).toBe(405);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("Method not allowed");
  });
});

describe("GET /api/beaches.geojson (clustered map directory)", () => {
  // Bulk-get KV stub: resolves each requested key from a fixed color map,
  // matching the Workers binding's Map return for an array of keys.
  function flagsFrom(colors) {
    return {
      get: function (key) {
        if (!Array.isArray(key)) {
          return Promise.resolve(colors[key] || null);
        }
        return Promise.resolve(new Map(key.map(function (k) {
          return [k, colors[k] || null];
        })));
      }
    };
  }

  function geojson(env) {
    return handleRequest(getRequest("/api/beaches.geojson"), env);
  }

  it("returns a FeatureCollection of Point features in [lon, lat] order", async () => {
    const rows = [{ id: "b1", name: "One", park_name: null, lat: 42, lon: -86 }];
    const { env } = makeEnv(rows, nullFlags());
    const res = await geojson(env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("FeatureCollection");
    expect(Array.isArray(body.features)).toBe(true);
    const f = body.features[0];
    expect(f.type).toBe("Feature");
    expect(f.geometry.type).toBe("Point");
    // GeoJSON coordinate order is [lon, lat], NOT [lat, lon].
    expect(f.geometry.coordinates).toEqual([-86, 42]);
    expect(f.properties.id).toBe("b1");
    expect(f.properties.name).toBe("One");
  });

  it("uses park_name over name for the feature label", async () => {
    const rows = [{ id: "b1", name: "Inner Beach", park_name: "Big Park", lat: 42, lon: -86 }];
    const { env } = makeEnv(rows, nullFlags());
    const body = await (await geojson(env)).json();
    expect(body.features[0].properties.name).toBe("Big Park");
  });

  it("excludes beaches with non-finite coordinates", async () => {
    const rows = [
      { id: "good", name: "Good", park_name: null, lat: 42, lon: -86 },
      { id: "nulllat", name: "Null Lat", park_name: null, lat: null, lon: -86 },
      { id: "badlon", name: "Bad Lon", park_name: null, lat: 42, lon: "nope" }
    ];
    const { env } = makeEnv(rows, nullFlags());
    const body = await (await geojson(env)).json();
    const ids = body.features.map(function (f) { return f.properties.id; });
    expect(ids).toEqual(["good"]);
  });

  it("carries the cacheable header and the geo+json content type", async () => {
    const { env } = makeEnv([{ id: "b1", name: "One", park_name: null, lat: 42, lon: -86 }], nullFlags());
    const res = await geojson(env);
    expect(res.headers.get("cache-control")).toBe(CACHEABLE);
    expect(res.headers.get("content-type")).toContain("application/geo+json");
  });

  it("reads flag:/official: KV in bulk (Map) not per-beach single gets", async () => {
    // A stub that ONLY answers array (bulk) gets; a single-key get returns
    // undefined, so a per-beach two-key read path would surface as unknown-only
    // AND prove the endpoint never uses the single-key form. Here we assert the
    // bulk Map is consulted by returning real colors only through the array path.
    const rows = [{ id: "b1", name: "One", park_name: null, lat: 42, lon: -86 }];
    let sawArray = false;
    const flags = {
      get: function (key) {
        if (Array.isArray(key)) {
          sawArray = true;
          return Promise.resolve(new Map(key.map(function (k) {
            return [k, k === "flag:b1" ? { color: "green" } : null];
          })));
        }
        return Promise.resolve(null);
      }
    };
    const body = await (await geojson({ DB: makeEnv(rows).env.DB, FLAGS: flags })).json();
    expect(sawArray).toBe(true);
    expect(body.features[0].properties.flag).toBe("green");
  });

  it("stamps the flag keyword: official wins over estimate", async () => {
    const rows = [
      { id: "b1", name: "One", park_name: null, lat: 42, lon: -86 },
      { id: "b2", name: "Two", park_name: null, lat: 43, lon: -85 }
    ];
    const { env } = makeEnv(rows, flagsFrom({
      "flag:b1": { color: "yellow" },
      "official:b1": { color: "red" },
      "flag:b2": { color: "green" }
    }));
    const body = await (await geojson(env)).json();
    const byId = {};
    body.features.forEach(function (f) { byId[f.properties.id] = f.properties.flag; });
    // Official red beats the yellow estimate; b2 keeps its green estimate.
    expect(byId.b1).toBe("red");
    expect(byId.b2).toBe("green");
  });

  it("collapses double-red to the red keyword", async () => {
    const rows = [{ id: "dr", name: "DR", park_name: null, lat: 42, lon: -86 }];
    const { env } = makeEnv(rows, flagsFrom({ "official:dr": { color: "double-red" } }));
    const body = await (await geojson(env)).json();
    expect(body.features[0].properties.flag).toBe("red");
  });

  it("maps a beach with no cached flag to the honest unknown keyword", async () => {
    const rows = [{ id: "b3", name: "Three", park_name: null, lat: 42, lon: -86 }];
    const { env } = makeEnv(rows, nullFlags());
    const body = await (await geojson(env)).json();
    expect(body.features[0].properties.flag).toBe("unknown");
  });

  it("normalizes a garbage official color to the unknown keyword", async () => {
    const rows = [{ id: "b4", name: "Four", park_name: null, lat: 42, lon: -86 }];
    const { env } = makeEnv(rows, flagsFrom({ "official:b4": { color: "magenta" } }));
    const body = await (await geojson(env)).json();
    expect(body.features[0].properties.flag).toBe("unknown");
  });

  it("chunks KV bulk-gets to <=100 keys and maps colors across chunk boundaries", async () => {
    // 250 rows force multiple chunks per key family (flag:/official:), each
    // capped at the 100-key bulk-get ceiling. Distinct official colors on rows
    // that straddle chunk edges (b99->b100 crosses the first edge; b201 is deep
    // in the third chunk) prove the per-chunk index math lands each color on the
    // right feature.
    const rows = [];
    for (let i = 0; i < 250; i = i + 1) {
      rows.push({ id: "b" + i, name: "B" + i, park_name: null, lat: 42, lon: -86 });
    }
    const colors = {
      "official:b0": { color: "green" },
      "official:b99": { color: "yellow" },
      "official:b100": { color: "red" },
      "official:b201": { color: "double-red" }
    };
    const keyLengths = [];
    const flags = {
      get: function (key) {
        if (Array.isArray(key)) {
          keyLengths.push(key.length);
          return Promise.resolve(new Map(key.map(function (k) {
            return [k, colors[k] || null];
          })));
        }
        return Promise.resolve(null);
      }
    };
    const { env } = makeEnv(rows, flags);
    const body = await (await geojson(env)).json();
    // Every bulk-get key array stayed within the 100-key ceiling (and the
    // endpoint did use the bulk array form, not per-beach single gets).
    expect(keyLengths.length).toBeGreaterThan(0);
    keyLengths.forEach(function (len) { expect(len).toBeLessThanOrEqual(100); });
    // All 250 finite-coord rows became features, one per row.
    expect(body.features.length).toBe(250);
    const byId = {};
    body.features.forEach(function (f) { byId[f.properties.id] = f.properties.flag; });
    // Colors land on the correct rows across chunk boundaries; double-red
    // collapses to red; rows with no cached flag stay the honest unknown.
    expect(byId.b0).toBe("green");
    expect(byId.b99).toBe("yellow");
    expect(byId.b100).toBe("red");
    expect(byId.b201).toBe("red");
    expect(byId.b1).toBe("unknown");
    expect(byId.b249).toBe("unknown");
  });
});

describe("handleHome proximity branch: in-memory distance sort", () => {
  function rowNamed(id, name, lat, lon) {
    return { id: id, name: name, park_name: null, lat: lat, lon: lon };
  }

  it("fetches LIMIT 500 with no ORDER BY, then sorts rows by distance in JS", async () => {
    // DB order is deliberately farthest-first: only the in-memory sort can put
    // Near Beach ahead of Far Beach in the rendered page.
    const rows = [
      rowNamed("b-far", "Far Beach", 43.5, -86.28),
      rowNamed("b-near", "Near Beach", 42.41, -86.28)
    ];
    const { env, statements } = makeEnv(rows);
    const res = await handleRequest(homeRequest("?near=42.4,-86.28"), env);
    expect(res.status).toBe(200);
    expect(statements[0].sql).toContain("LIMIT 500");
    expect(statements[0].sql).not.toContain("ORDER BY");
    const html = await res.text();
    const nearAt = html.indexOf("Near Beach");
    const farAt = html.indexOf("Far Beach");
    expect(nearAt).toBeGreaterThan(-1);
    expect(farAt).toBeGreaterThan(-1);
    expect(nearAt).toBeLessThan(farAt);
  });

  it("slices the sorted rows to 100 rendered beach rows", async () => {
    const rows = [];
    for (let i = 0; i < 101; i++) {
      rows.push(rowNamed("b-" + String(i), "Beach " + String(i), 42.4 + i * 0.01, -86.28));
    }
    const { env } = makeEnv(rows);
    const res = await handleRequest(homeRequest("?near=42.4,-86.28"), env);
    const html = await res.text();
    expect(html.split("<li class=\"beach-row\"").length - 1).toBe(100);
  });
});

describe("2-hour stale-data warning on flag cards", () => {
  const STALE_UPDATED = "2026-07-05T09:00:00.000Z"; // 3 h before NOW_ISO

  function estimateUpdatedAt(iso) {
    return { color: "green", reason: "calm", official: false, sources: [], updated: iso };
  }

  it("warns on an estimate card 3 h out of date", () => {
    const card = estimateCardOf(detailPage(estimateUpdatedAt(STALE_UPDATED)));
    expect(card).toContain(
      "Stale data — last updated <wa-relative-time date=\"" + STALE_UPDATED +
      "\" sync></wa-relative-time>"
    );
  });

  it("stays quiet on a 1 h-old estimate", () => {
    const card = estimateCardOf(detailPage(estimateUpdatedAt("2026-07-05T11:00:00.000Z")));
    expect(card).not.toContain("Stale data");
  });

  it("treats exactly 2 h as fresh (strictly-greater-than threshold)", () => {
    const card = estimateCardOf(detailPage(estimateUpdatedAt("2026-07-05T10:00:00.000Z")));
    expect(card).not.toContain("Stale data");
  });

  it("warns on an official card 3 h out of date", () => {
    const official = {
      color: "green",
      reason: "Official flag",
      official: true,
      source: "https://example.gov/flags",
      updated: STALE_UPDATED
    };
    const card = officialCardOf(detailPage(null, official));
    expect(card).toContain("Stale data — last updated");
  });

  it("skips the warning (without throwing) on an unparseable timestamp", () => {
    const card = estimateCardOf(detailPage(estimateUpdatedAt("garbage")));
    expect(card).not.toContain("Stale data");
  });
});

// A source that publishes on its OWN slower schedule (a once-daily NWS product,
// a human-posted beach status) may declare staleMs — its real staleness horizon
// — and, for a point-in-time reading, readingNote. The 2 h default stays in
// force for every record that declares nothing, and the estimate card never
// gets either field.
describe("per-source staleness horizon on the official card", () => {
  // 11 h before NOW_ISO: past the 2 h default, inside a 30 h source horizon.
  const MORNING = "2026-07-05T01:00:00.000Z";
  // 31 h before NOW_ISO: past a 30 h horizon too.
  const SKIPPED = "2026-07-04T05:00:00.000Z";
  const NOTE = "Morning reading — conditions may have changed since it was posted";
  const THIRTY_HOURS = 30 * 60 * 60 * 1000;

  function officialAt(updated, extra) {
    return Object.assign({
      color: "green",
      reason: "Official flag",
      official: true,
      source: "https://example.gov/flags",
      updated: updated
    }, extra || {});
  }

  function estimateAt(iso) {
    return { color: "green", reason: "calm", official: false, sources: [], updated: iso };
  }

  it("keeps the 2 h default when the record declares no staleMs", () => {
    const card = officialCardOf(detailPage(null, officialAt(MORNING)));
    expect(card).toContain("Stale data — last updated");
    expect(card).not.toContain("variant=\"neutral\" size=\"s\"");
  });

  it("stays quiet within 2 h when the record declares no staleMs", () => {
    const card = officialCardOf(detailPage(null, officialAt("2026-07-05T11:00:00.000Z")));
    expect(card).not.toContain("Stale data");
    expect(card).not.toContain(NOTE);
  });

  it("suppresses the warning for a reading older than 2 h but inside staleMs", () => {
    const card = officialCardOf(
      detailPage(null, officialAt(MORNING, { staleMs: THIRTY_HOURS }))
    );
    expect(card).not.toContain("Stale data");
  });

  it("renders the neutral reading note inside that window, with a relative time", () => {
    const card = officialCardOf(
      detailPage(null, officialAt(MORNING, { staleMs: THIRTY_HOURS, readingNote: NOTE }))
    );
    expect(card).toContain(
      "<wa-callout variant=\"neutral\" size=\"s\">" +
      "<wa-icon slot=\"icon\" name=\"clock\"></wa-icon>" +
      NOTE + " <wa-relative-time date=\"" + MORNING + "\" sync></wa-relative-time>." +
      "</wa-callout>"
    );
    expect(card).not.toContain("Stale data");
  });

  it("shows neither callout for a reading younger than 2 h even with a readingNote", () => {
    const card = officialCardOf(
      detailPage(null, officialAt("2026-07-05T11:00:00.000Z", {
        staleMs: THIRTY_HOURS,
        readingNote: NOTE
      }))
    );
    expect(card).not.toContain("Stale data");
    expect(card).not.toContain(NOTE);
  });

  it("lets the warning win past staleMs and drops the note (mutually exclusive)", () => {
    const card = officialCardOf(
      detailPage(null, officialAt(SKIPPED, { staleMs: THIRTY_HOURS, readingNote: NOTE }))
    );
    expect(card).toContain("Stale data — last updated");
    expect(card).not.toContain(NOTE);
    expect(card).not.toContain("variant=\"neutral\" size=\"s\"");
  });

  it("shows neither callout with staleMs but no readingNote inside the window", () => {
    const card = officialCardOf(
      detailPage(null, officialAt(MORNING, { staleMs: THIRTY_HOURS }))
    );
    expect(card).not.toContain("Stale data");
    expect(card).not.toContain("<wa-callout");
  });

  it("treats exactly staleMs as fresh (strictly-greater-than, like the default)", () => {
    // 30 h before NOW_ISO exactly.
    const card = officialCardOf(
      detailPage(null, officialAt("2026-07-04T06:00:00.000Z", { staleMs: THIRTY_HOURS }))
    );
    expect(card).not.toContain("Stale data");
  });

  it("leaves the estimate card on the plain 2 h behaviour", () => {
    // The same 11 h-old timestamp that a declaring official source would treat
    // as fresh must still warn on the estimate card, which is on our own hourly
    // recompute; and no estimate card ever carries a reading note.
    const html = detailPage(
      estimateAt(MORNING),
      officialAt(MORNING, { staleMs: THIRTY_HOURS, readingNote: NOTE })
    );
    const estimate = estimateCardOf(html);
    expect(estimate).toContain("Stale data — last updated");
    expect(estimate).not.toContain(NOTE);
    expect(estimate).not.toContain("name=\"clock\"");
  });

  it("ignores an unparseable timestamp even with a horizon and a note", () => {
    const card = officialCardOf(
      detailPage(null, officialAt("garbage", { staleMs: THIRTY_HOURS, readingNote: NOTE }))
    );
    expect(card).not.toContain("Stale data");
    expect(card).not.toContain(NOTE);
  });

  it("escapes reading-note copy rather than emitting raw markup", () => {
    const card = officialCardOf(
      detailPage(null, officialAt(MORNING, {
        staleMs: THIRTY_HOURS,
        readingNote: "Morning <b>reading</b> & posted"
      }))
    );
    expect(card).toContain("Morning &lt;b&gt;reading&lt;/b&gt; &amp; posted <wa-relative-time");
    expect(card).not.toContain("<b>reading</b>");
  });
});

describe("honest unknown: missing estimate never defaults green", () => {
  it("renders a gray UNKNOWN estimate card when the estimate is null", () => {
    const card = estimateCardOf(detailPage(null, null));
    expect(card).toContain("<span class=\"wa-font-size-xl wa-font-weight-bold\">UNKNOWN</span>");
    expect(card).toContain("No estimate available yet");
    expect(card).toContain("flag-icon-unknown");
    expect(card).toContain(">ESTIMATE</wa-badge>");
    expect(card).not.toContain("GREEN");
    expect(card).not.toContain("flag-icon-green");
  });

  it("falls back to 'No data available' for an estimate with a falsy reason", () => {
    const card = estimateCardOf(detailPage({ color: "green", reason: "", sources: [], updated: null }));
    expect(card).toContain("No data available");
  });
});

describe("unrecognized flag colors normalize to unknown (corrupt-KV guard)", () => {
  it("renders a garbage estimate color as UNKNOWN in the list row", () => {
    const html = renderListPage({
      entries: [{ beach: OVAL, estimate: { color: "purple" }, official: null, distanceMi: null }],
      nowIso: NOW_ISO
    });
    const row = beachRowOf(html);
    expect(row).toContain("flag-icon-unknown");
    expect(row).toContain(">UNKNOWN</wa-badge>");
    expect(row).not.toContain("flag-icon-purple");
    expect(row).not.toContain("flag-icon-green");
  });

  it("treats a wrong-case color ('GREEN') as unknown on the detail card", () => {
    const card = estimateCardOf(detailPage({ color: "GREEN", reason: "x", sources: [] }));
    expect(card).toContain("flag-icon-unknown");
    expect(card).toContain(">UNKNOWN</span>");
    expect(card).not.toContain("flag-icon-green");
  });
});

describe("double-red presentation", () => {
  const doubleRedOfficial = {
    color: "double-red",
    reason: "x",
    official: true,
    source: "https://ex.gov/f",
    updated: NOW_ISO
  };

  it("shows the full label and TWO red-tinted flag icons on the official card", () => {
    const card = officialCardOf(detailPage(null, doubleRedOfficial));
    expect(card).toContain("DOUBLE RED — water closed");
    const iconWrap = sliceBetween(card, "<span class=\"wa-cluster wa-gap-3xs\">", "</span>");
    expect(iconWrap.split("<wa-icon name=\"flag\"").length - 1).toBe(2);
    expect(iconWrap).toContain("flag-icon-red");
  });

  it("shows only the short DOUBLE RED chip label on a list row", () => {
    const html = renderListPage({
      entries: [{ beach: OVAL, estimate: { color: "double-red" }, official: null, distanceMi: null }],
      nowIso: NOW_ISO
    });
    const row = beachRowOf(html);
    expect(row).toContain(">DOUBLE RED</wa-badge>");
    expect(row).not.toContain("water closed");
  });

  it("labels the standalone detail-title icon pair with role=img", () => {
    const html = detailPage(null, doubleRedOfficial);
    const h1 = sliceBetween(html, "<h1 class=\"beach-title", "</h1>");
    expect(h1).toContain("role=\"img\" aria-label=\"Double red flags\"");
    expect(h1).toContain("flag-icon-red");
  });
});

describe("detail-page title flag precedence", () => {
  function titleOf(html) {
    return sliceBetween(html, "<h1 class=\"beach-title", "</h1>");
  }

  it("prefers the official color over the estimate", () => {
    const html = detailPage(
      { color: "green", reason: "calm", sources: [] },
      { color: "red", reason: "posted", official: true, source: "https://ex.gov/f", updated: NOW_ISO }
    );
    const h1 = titleOf(html);
    expect(h1).toContain("flag-icon-red");
    expect(h1).toContain("label=\"Red flag\"");
    expect(h1).not.toContain("flag-icon-green");
  });

  it("uses the estimate color when no official flag exists", () => {
    const h1 = titleOf(detailPage({ color: "yellow", reason: "waves", sources: [] }));
    expect(h1).toContain("flag-icon-yellow");
    expect(h1).toContain("label=\"Yellow flag\"");
  });

  it("renders gray unknown (never green) when both are null", () => {
    const h1 = titleOf(detailPage(null, null));
    expect(h1).toContain("flag-icon-unknown");
    expect(h1).toContain("label=\"Flag status unknown\"");
    expect(h1).not.toContain("flag-icon-green");
  });
});

describe("footer disclaimer on the list page", () => {
  const DISCLAIMER = "Estimated — not the official flag status. " +
    "Always obey posted flags and lifeguards.";

  it("appears on the empty list page with the attribution links", () => {
    const html = renderListPage({ entries: [], nowIso: NOW_ISO });
    expect(html).toContain(DISCLAIMER);
    expect(html).toContain("<a href=\"https://www.openstreetmap.org\" rel=\"noopener noreferrer\">OpenStreetMap</a>");
    expect(html).toContain("<a href=\"https://www.weather.gov\" rel=\"noopener noreferrer\">NOAA/NWS</a>");
    expect(html).toContain("<a href=\"https://weather.gc.ca\" rel=\"noopener noreferrer\">ECCC</a>");
    expect(html).toContain("<a href=\"https://open-meteo.com/en/docs/marine-weather-api\" rel=\"noopener noreferrer\">Open-Meteo</a>");
    expect(html).toContain("<a href=\"https://www.windy.com/webcams\" rel=\"noopener noreferrer\">Windy.com</a>");
  });

  it("appears on a populated list page too", () => {
    const html = renderListPage({
      entries: [{ beach: OVAL, estimate: null, official: null, distanceMi: null }],
      nowIso: NOW_ISO
    });
    expect(html).toContain(DISCLAIMER);
  });
});

describe("renderSourceLabels edge shapes", () => {
  function cardWithSources(sources) {
    return estimateCardOf(detailPage({ color: "green", reason: "calm", sources: sources, updated: null }));
  }

  it("renders an unlabeled non-URL source url as its raw string", () => {
    const card = cardWithSources([{ url: "not-a-url" }]);
    expect(card).toContain(">not-a-url</wa-badge>");
  });

  it("renders a legacy bare non-URL string source verbatim", () => {
    const card = cardWithSources(["NWS Alerts"]);
    expect(card).toContain(">NWS Alerts</wa-badge>");
  });

  it("omits badges and header-actions entirely for an empty sources array", () => {
    const card = cardWithSources([]);
    expect(card).not.toContain("source-badges");
    expect(card).not.toContain("with-header-actions");
  });

  it("skips a source object with null label and url (no empty badge)", () => {
    const card = cardWithSources([{ label: null, url: null }]);
    expect(card).not.toContain("source-badges");
    expect(card).not.toContain("with-header-actions");
  });
});

describe("escapeHtml", () => {
  it("returns empty string for null and undefined", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("escapes all five entities, ampersand first (no double-escaping)", () => {
    expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("coerces non-strings", () => {
    expect(escapeHtml(42)).toBe("42");
  });

  it("re-escapes already-escaped input (never passes entities through)", () => {
    expect(escapeHtml("a&amp;b")).toBe("a&amp;amp;b");
  });
});

describe("formatMiles guard branches (via renderBeachRow)", () => {
  function rowWithDistance(dist) {
    const html = renderListPage({
      entries: [{ beach: OVAL, estimate: null, official: null, distanceMi: dist }],
      nowIso: NOW_ISO,
      sortedByProximity: true
    });
    return beachRowOf(html);
  }

  it("renders no distance span for negative or NaN distances", () => {
    expect(rowWithDistance(-3)).not.toContain("<span class=\"beach-row-distance");
    expect(rowWithDistance(NaN)).not.toContain("<span class=\"beach-row-distance");
  });

  it("labels exactly 1 mile as ~1 mi (the <1 boundary is strict)", () => {
    expect(rowWithDistance(1)).toContain("~1 mi");
  });

  it("labels 0.99 miles as the escaped &lt;1 mi", () => {
    expect(rowWithDistance(0.99)).toContain("&lt;1 mi");
  });

  it("rounds 12.5 miles up to ~13 mi", () => {
    expect(rowWithDistance(12.5)).toContain("~13 mi");
  });
});

describe("search script <-> rendered markup id contract", () => {
  it("pins the ids/attributes the client script queries to what renderListPage emits", () => {
    expect(LIST_SEARCH_SCRIPT).toContain("getElementById('beach-search')");
    expect(LIST_SEARCH_SCRIPT).toContain("getElementById('beach-list-empty')");
    expect(LIST_SEARCH_SCRIPT).toContain("getElementById('beach-search-form')");
    expect(LIST_SEARCH_SCRIPT).toContain("querySelectorAll('.beach-row')");
    expect(LIST_SEARCH_SCRIPT).toContain("getAttribute('data-name')");
    // Filters on every keystroke (input) and on the clear button, with no enter.
    expect(LIST_SEARCH_SCRIPT).toContain("addEventListener('input', onInput)");
    expect(LIST_SEARCH_SCRIPT).toContain("addEventListener('wa-clear', onInput)");
    // The debounced full-table pass fetches the server-rendered page and swaps it
    // in via the shared helper; a submit is intercepted rather than reloading.
    expect(LIST_SEARCH_SCRIPT).toContain("__swimReportSwapList");
    expect(LIST_SEARCH_SCRIPT).toContain("addEventListener('submit'");
    // A stale response (value moved on) or one overtaken by another swap
    // (generation advanced, e.g. the geo upgrade) must not be applied.
    expect(LIST_SEARCH_SCRIPT).toContain("input.value.trim() !== term");
    expect(LIST_SEARCH_SCRIPT).toContain("__swimReportListGen");
    // No sticky "last sent" term — a failed fetch must not disable retries.
    expect(LIST_SEARCH_SCRIPT).not.toContain("lastSent");
    // The fetch carries a near (URL's or the baked-in center) so the response is
    // cacheable, while the shareable replaceState url stays clean.
    expect(LIST_SEARCH_SCRIPT).toContain("data-complete");
    expect(LIST_SEARCH_SCRIPT).toContain("fetchUrl");
    expect(LIST_SEARCH_SCRIPT).toContain("bakedCenter");

    const html = renderListPage({
      entries: [{ beach: OVAL, estimate: null, official: null, distanceMi: null }],
      nowIso: NOW_ISO
    });
    expect(html).toContain("id=\"beach-search\"");
    expect(html).toContain("id=\"beach-list-empty\"");
    expect(html).toContain("id=\"list-active-query\"");
    expect(html).toContain("class=\"beach-row\"");
    expect(html).toContain("data-name=");
  });
});

describe("shared list-swap helper contract", () => {
  it("defines the swap helper and swaps the in-place-updated nodes by id", () => {
    expect(LIST_SWAP_SCRIPT).toContain("window.__swimReportSwapList");
    expect(LIST_SWAP_SCRIPT).toContain("getElementById('beach-list-items')");
    expect(LIST_SWAP_SCRIPT).toContain("getElementById('beach-list-empty')");
    expect(LIST_SWAP_SCRIPT).toContain("getElementById('list-active-query')");
  });

  it("has both the geo upgrade and the live search delegate to the shared helper", () => {
    expect(LIST_GEO_SCRIPT).toContain("__swimReportSwapList");
    expect(LIST_SEARCH_SCRIPT).toContain("__swimReportSwapList");
  });

  it("loads the swap helper before the scripts that call it", () => {
    const html = renderListPage({
      entries: [{ beach: OVAL, estimate: null, official: null, distanceMi: null }],
      nowIso: NOW_ISO
    });
    const swapAt = html.indexOf("window.__swimReportSwapList =");
    const searchCallAt = html.indexOf("window.__swimReportSwapList &&");
    expect(swapAt).toBeGreaterThan(-1);
    expect(searchCallAt).toBeGreaterThan(-1);
    expect(swapAt).toBeLessThan(searchCallAt);
  });
});
