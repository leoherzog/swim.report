// test/router.test.js
// The request path end to end, against real SQLite through test/helpers/d1.js:
// every route reads its beach rows and their derived state from seeded tables,
// so the assertions are about what renders, not about the SQL that fetched it.
// Also covers the pure helpers in src/router.js and the rendering invariants in
// src/frontend/render.js.

import { describe, it, expect } from "vitest";
import {
  distanceMi,
  resolveUserLocation,
  escapeLike,
  parseBeachIds,
  handleRequest
} from "../src/router.js";
import { renderListPage, renderDetailPage } from "../src/frontend/render.js";
import { displayFlag } from "../src/displayFlag.js";
import { makeD1 } from "./helpers/d1.js";
import { PAGE_STYLES } from "../src/frontend/styles.js";
import { COLOR_SCHEME_SCRIPT } from "../src/frontend/colorSchemeScript.js";

const NOW_EPOCH = Math.floor(Date.now() / 1000);
// Every seeded record leases an hour out unless the fixture names its own epoch.
const LIVE_EXPIRES = NOW_EPOCH + 3600;

// KV stand-in for the two keys the request path still reads, waves: and
// watertemp:. Every requested key is recorded, so a test can assert that the
// four state records never go back to KV.
function makeFlags(values) {
  const store = values || {};
  const keys = [];
  return {
    keys: keys,
    get: function (key) {
      keys.push(key);
      return Promise.resolve(
        Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null
      );
    }
  };
}

// beach_state column values for a fixture's records. Each record's blob, color,
// updated stamp and expiry are seeded together, exactly as the cron upsert
// writes them; pass estimateExpires / officialExpires (etc.) to age one out.
function stateFields(records) {
  const fields = {};
  if (records.estimate) {
    fields.estimate = records.estimate;
    fields.estimate_color = records.estimate.color;
    fields.estimate_updated = records.estimate.updated;
    fields.estimate_expires = records.estimateExpires === undefined
      ? LIVE_EXPIRES : records.estimateExpires;
  }
  if (records.official) {
    fields.official = records.official;
    fields.official_color = records.official.color;
    fields.official_updated = records.official.updated;
    fields.official_expires = records.officialExpires === undefined
      ? LIVE_EXPIRES : records.officialExpires;
  }
  if (records.wqfloor) {
    fields.wqfloor = records.wqfloor;
    fields.wqfloor_expires = records.wqfloorExpires === undefined
      ? LIVE_EXPIRES : records.wqfloorExpires;
  }
  if (records.reading) {
    fields.reading = records.reading;
    fields.reading_expires = records.readingExpires === undefined
      ? LIVE_EXPIRES : records.readingExpires;
  }
  return fields;
}

// The request-path env, backed by real SQLite through the migrations.
//   beaches: fixture rows for the beaches table
//   state:   beachId -> the records stateFields() turns into columns
//   kv:      the remaining KV keys, by full key name
// Returns the env plus the D1 fake itself, whose statements array and sqlite
// handle back the few assertions that are about the read happening at all.
function makeEnv(options) {
  const opts = options || {};
  const db = makeD1({ beaches: opts.beaches || [] });
  const state = opts.state || {};
  for (const beachId of Object.keys(state)) {
    db.seedState(beachId, stateFields(state[beachId]));
  }
  const flags = makeFlags(opts.kv);
  return { env: { DB: db, FLAGS: flags }, db: db, flags: flags, statements: db.statements };
}

// Rendered beach rows, in document order, as their beach ids.
function renderedIds(html) {
  const ids = [];
  const pattern = /href="\/beach\/([^"]+)"/g;
  let match = pattern.exec(html);
  while (match !== null) {
    if (ids.indexOf(match[1]) === -1) {
      ids.push(match[1]);
    }
    match = pattern.exec(html);
  }
  return ids;
}

async function renderedIdsFor(request, env) {
  const res = await handleRequest(request, env);
  expect(res.status).toBe(200);
  return renderedIds(await res.text());
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
  const beaches = [
    { id: "b1", name: "Oval Beach", park_name: null, lat: 42.6, lon: -86.2 },
    { id: "b2", name: "Ottawa Beach", park_name: "Holland State Park", lat: 42.77, lon: -86.21 }
  ];

  it("matches on the display name and on the beach's own name", async () => {
    // COALESCE(park_name, name) is the display name, so a term hitting only the
    // park still returns its beach, and one hitting only the beach name does too.
    expect(await renderedIdsFor(homeRequest("?q=oval"), makeEnv({ beaches: beaches }).env))
      .toEqual(["b1"]);
    expect(await renderedIdsFor(homeRequest("?q=holland"), makeEnv({ beaches: beaches }).env))
      .toEqual(["b2"]);
    expect(await renderedIdsFor(homeRequest("?q=ottawa"), makeEnv({ beaches: beaches }).env))
      .toEqual(["b2"]);
  });

  it("echoes the active query into the search form", async () => {
    const res = await handleRequest(homeRequest("?q=oval"), makeEnv({ beaches: beaches }).env);
    const html = await res.text();
    expect(html).toContain("value=\"oval\"");
    expect(html).toContain("Showing results for <strong>oval</strong>");
  });

  it("matches a term's LIKE wildcards literally", async () => {
    // %25 decodes to "%", so the raw term is "50%_x". Unescaped it would read as
    // "50, anything, any one character, x" and match the second beach too.
    const wildcards = [
      { id: "literal", name: "50%_x Cove", lat: 42.6, lon: -86.2 },
      { id: "wildcard", name: "50 miles ax", lat: 42.6, lon: -86.2 }
    ];
    expect(await renderedIdsFor(homeRequest("?q=50%25_x"), makeEnv({ beaches: wildcards }).env))
      .toEqual(["literal"]);
  });

  it("combines q with near: filters first, then sorts the matches by distance", async () => {
    const matches = [
      { id: "far", name: "Oval Beach North", lat: 43.5, lon: -86.28 },
      { id: "near", name: "Oval Beach South", lat: 42.41, lon: -86.28 },
      { id: "other", name: "Ottawa Beach", lat: 42.4, lon: -86.28 }
    ];
    const res = await handleRequest(
      homeRequest("?q=oval&near=42.4,-86.28"), makeEnv({ beaches: matches }).env
    );
    const html = await res.text();
    expect(renderedIds(html)).toEqual(["near", "far"]);
    // The near param rides along in a hidden input so proximity survives submit.
    expect(html).toContain("<input type=\"hidden\" name=\"near\" value=\"42.4,-86.28\">");
  });

  it("ignores an empty or whitespace-only q, listing every beach by display name", async () => {
    // "Holland State Park" is b2's display name, so it sorts ahead of "Oval Beach".
    expect(await renderedIdsFor(homeRequest("?q=%20%20"), makeEnv({ beaches: beaches }).env))
      .toEqual(["b2", "b1"]);
    expect(await renderedIdsFor(homeRequest(""), makeEnv({ beaches: beaches }).env))
      .toEqual(["b2", "b1"]);
  });
});

describe("flag-worthy water gate", () => {
  // One of each classification state: two keepers, a still-pending NULL row, a
  // confirmed-inland row and a NULL row parked at the attempts cap.
  const mixed = [
    { id: "b-ocean", name: "Ocean Beach", lat: 42.1, lon: -86.2, water_class: "ocean", water_class_attempts: 0 },
    { id: "b-gl", name: "Great Lake Beach", lat: 42.2, lon: -86.2, water_class: "great_lake", water_class_attempts: 0 },
    { id: "b-pending", name: "Pending Beach", lat: 42.3, lon: -86.2, water_class: null, water_class_attempts: 0 },
    { id: "b-inland", name: "Inland Beach", lat: 42.4, lon: -86.2, water_class: "inland", water_class_attempts: 0 },
    { id: "b-parked", name: "Parked Beach", lat: 42.5, lon: -86.2, water_class: null, water_class_attempts: 5 }
  ];

  it("hides confirmed-inland and parked rows from the home list", async () => {
    expect(await renderedIdsFor(homeRequest(""), makeEnv({ beaches: mixed }).env))
      .toEqual(["b-gl", "b-ocean", "b-pending"]);
  });

  it("applies the same gate to a ?q= search", async () => {
    expect(await renderedIdsFor(homeRequest("?q=beach"), makeEnv({ beaches: mixed }).env))
      .toEqual(["b-gl", "b-ocean", "b-pending"]);
  });

  it("applies the same gate to /api/beaches.geojson", async () => {
    const res = await handleRequest(
      getRequest("/api/beaches.geojson"), makeEnv({ beaches: mixed }).env
    );
    const body = await res.json();
    expect(body.features.map(function (f) { return f.properties.id; }).sort())
      .toEqual(["b-gl", "b-ocean", "b-pending"]);
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

describe("handleHome reads the list's flags from beach_state", () => {
  const beaches = [{ id: "b1", name: "Oval Beach", park_name: null, lat: 42.6, lon: -86.2 }];
  const ESTIMATE = {
    color: "yellow",
    reason: "Estimated wave height 2.5 ft (2–4 ft)",
    rules_version: "1.1.0",
    official: false,
    sources: [],
    updated: "2026-07-05T12:00:00.000Z"
  };
  const OFFICIAL = {
    color: "red",
    reason: "Official flag reported by Example Beach Program",
    official: true,
    source: "https://example.gov/flags",
    sources: ["https://example.gov/flags"],
    updated: "2026-07-05T12:00:00.000Z"
  };

  async function rowFor(state) {
    const made = makeEnv({ beaches: beaches, state: { b1: state } });
    const res = await handleRequest(homeRequest(""), made.env);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Scope to the beach row: the embedded stylesheet legitimately mentions
    // every flag-icon-* class, so assertions must target the rendered markup.
    return { row: beachRowOf(html), keys: made.flags.keys };
  }

  // The two records carry DIFFERENT colors, so crossing the estimate and official
  // slots fails the chip-color assertions below. OFFICIAL's updated is aged
  // against the real clock and more severe than the yellow estimate, so the
  // aged official still supplies the displayed red.
  it("renders the display flag as the chip and credits the official only when it supplied the color", async () => {
    const out = await rowFor({ estimate: ESTIMATE, official: OFFICIAL });
    expect(out.row).toContain("flag-icon-red");
    expect(out.row).toContain(">RED</wa-badge>");
    expect(out.row).not.toContain("flag-icon-yellow");
    expect(out.row).not.toContain(">YELLOW</wa-badge>");
    expect(out.row).toContain(">OFFICIAL</wa-badge>");
    expect(out.row).toContain("data-flag=\"red\"");
    // The list page reads no KV at all: both records rode in on the row.
    expect(out.keys).toEqual([]);
  });

  it("credits the estimate, with no OFFICIAL badge, when an aged official is outranked", async () => {
    const out = await rowFor({
      estimate: Object.assign({}, ESTIMATE, { color: "red" }),
      official: Object.assign({}, OFFICIAL, { color: "yellow" })
    });
    expect(out.row).toContain(">RED</wa-badge>");
    expect(out.row).toContain("flag-icon-red");
    expect(out.row).not.toContain(">YELLOW</wa-badge>");
    expect(out.row).not.toContain(">OFFICIAL</wa-badge>");
    expect(out.row).toContain("data-flag=\"red\"");
  });

  it("renders an expired estimate as unknown rather than its stored yellow", async () => {
    const out = await rowFor({ estimate: ESTIMATE, estimateExpires: NOW_EPOCH });
    expect(out.row).toContain("flag-icon-unknown");
    expect(out.row).toContain(">UNKNOWN</wa-badge>");
    expect(out.row).not.toContain("flag-icon-yellow");
  });

  it("drops the OFFICIAL badge once the official column expires, keeping the estimate", async () => {
    const out = await rowFor({
      estimate: ESTIMATE,
      official: OFFICIAL,
      officialExpires: NOW_EPOCH
    });
    expect(out.row).toContain(">YELLOW</wa-badge>");
    expect(out.row).not.toContain(">OFFICIAL</wa-badge>");
  });

  it("renders unknown for a beach with no beach_state row at all", async () => {
    const made = makeEnv({ beaches: beaches });
    const html = await (await handleRequest(homeRequest(""), made.env)).text();
    const row = beachRowOf(html);
    expect(row).toContain("flag-icon-unknown");
    expect(row).not.toContain("flag-icon-green");
  });

  // The list renders one displayFlag decision per row, so it reads the scalar
  // mirror columns. The proximity branch ranks five times the rows it renders,
  // and an alert-bearing estimate blob runs kilobytes, so a blob on this select
  // would cross the binding five times per rendered row.
  it("selects the scalar chip columns and none of the JSON blobs", async () => {
    const made = makeEnv({ beaches: beaches, state: { b1: { estimate: ESTIMATE } } });
    // With a location: the proximity branch, the one that over-fetches.
    const request = {
      method: "GET",
      url: "https://swim.report/",
      cf: { latitude: "42.6", longitude: "-86.2" }
    };
    expect((await handleRequest(request, made.env)).status).toBe(200);
    const listSql = made.db.statements
      .map(function (st) { return st.sql; })
      .filter(function (sql) { return sql.indexOf("FROM beaches b") !== -1; });
    expect(listSql.length).toBeGreaterThan(0);
    for (const sql of listSql) {
      expect(sql).toContain("s.estimate_color");
      expect(sql).toContain("s.official_color");
      expect(sql).not.toContain("s.estimate,");
      expect(sql).not.toContain("s.official,");
      expect(sql).not.toContain("s.wqfloor");
      expect(sql).not.toContain("s.reading");
    }
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
      "<p id=\"geo-live-region\" class=\"wa-visually-hidden\" role=\"status\" aria-live=\"polite\"></p>"
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

  it("carries no closing tag in either raw-injected string", function () {
    // render.js injects both verbatim between <style>/<script> open and close tags,
    // so a '</' anywhere inside either one breaks the document out of the element.
    // A property of the injection site, not of the CSS or the script.
    expect(PAGE_STYLES).not.toContain("</");
    expect(COLOR_SCHEME_SCRIPT).not.toContain("</");
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
          { label: "NOAA Great Lakes Wave Model", url: "https://polar.ncep.noaa.gov/waves/" },
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
    // the card, and the footer credits NOAA/NWS rather than the wave-model page,
    // so a provenance url must not appear in the document at all.
    expect(html).toContain("<wa-badge variant=\"neutral\" appearance=\"filled\" pill>NOAA Great Lakes Wave Model</wa-badge>");
    expect(html.split("https://polar.ncep.noaa.gov/waves/").length - 1).toBe(0);
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

describe("handleDetail: state from the row, waves and water temperature from KV", () => {
  const beach = { id: "b-1", name: "Oval Beach", lat: 42.6579, lon: -86.2114, osm_id: "way/1" };

  function detailEnv(options) {
    const opts = options || {};
    return makeEnv({
      beaches: [beach],
      state: opts.state ? { "b-1": opts.state } : {},
      kv: opts.kv
    });
  }

  function detailRequest(id) {
    return { method: "GET", url: "https://swim.report/beach/" + id, cf: {} };
  }

  const ADVISORY = {
    beachId: "b-1",
    color: "red",
    reason: "beach posted for elevated E. coli",
    source: "Lake County General Health District Beach Water Quality Program",
    updated: "2026-07-15T13:00:00.000Z"
  };
  // A morning reading is dropped by render.js once it is READING_MAX_AGE_MS old,
  // so the fixture's observation is an hour before the request instant.
  const READING = {
    beachId: "b-1",
    waterTempF: 68,
    observedIso: new Date(Date.now() - 3600000).toISOString(),
    siteName: "Grand Haven Pier",
    sourceLabel: "NWS Grand Rapids"
  };

  it("reads only waves: and watertemp: from KV — the four state records ride on the row", async () => {
    const made = detailEnv({ state: { estimate: { color: "green", updated: NOW_ISO } } });
    const res = await handleRequest(detailRequest("b-1"), made.env);
    expect(res.status).toBe(200);
    expect(made.flags.keys.sort()).toEqual(["watertemp:b-1", "waves:b-1"]);
  });

  it("renders the water-quality advisory callout from the wqfloor column", async () => {
    const made = detailEnv({ state: { wqfloor: ADVISORY } });
    const res = await handleRequest(detailRequest("b-1"), made.env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<wa-callout class=\"wq-advisory\" variant=\"danger\" size=\"s\">");
    expect(html).toContain("beach posted for elevated E. coli");
  });

  it("drops the advisory once its own column expires", async () => {
    const made = detailEnv({ state: { wqfloor: ADVISORY, wqfloorExpires: NOW_EPOCH } });
    const html = await (await handleRequest(detailRequest("b-1"), made.env)).text();
    expect(html).not.toContain("beach posted for elevated E. coli");
  });

  it("renders the scraped reading from the reading column, and drops it when expired", async () => {
    const made = detailEnv({ state: { reading: READING } });
    const html = await (await handleRequest(detailRequest("b-1"), made.env)).text();
    expect(html).toContain("68°F");
    expect(html).toContain("Grand Haven Pier");

    const expired = detailEnv({ state: { reading: READING, readingExpires: NOW_EPOCH } });
    const goneHtml = await (await handleRequest(detailRequest("b-1"), expired.env)).text();
    expect(goneHtml).not.toContain("Grand Haven Pier");
  });

  it("still renders 200 when a WaveSeries is present", async () => {
    const series = {
      beachId: "b-1",
      startIso: "2026-07-15T16:00:00.000Z",
      hoursFt: [1.6, 1.7, 1.8],
      models: ["noaa_glwu"],
      sources: [{ label: "NOAA Great Lakes Wave Model", url: "https://polar.ncep.noaa.gov/waves/" }],
      updated: "2026-07-15T16:20:33.000Z"
    };
    const made = detailEnv({ kv: { "waves:b-1": series } });
    const res = await handleRequest(detailRequest("b-1"), made.env);
    expect(res.status).toBe(200);
  });

  it("renders an expired estimate as UNKNOWN rather than its stored green", async () => {
    const estimate = { color: "green", reason: "calm", official: false, sources: [], updated: NOW_ISO };
    const made = detailEnv({ state: { estimate: estimate, estimateExpires: NOW_EPOCH } });
    const card = estimateCardOf(await (await handleRequest(detailRequest("b-1"), made.env)).text());
    expect(card).toContain(">UNKNOWN</span>");
    expect(card).toContain("No estimate available yet");
    expect(card).not.toContain("flag-icon-green");
  });

  it("keeps an expired official out of the title flag and off the card", async () => {
    // The estimate is live and green; the expired official red must neither
    // render its own card nor raise the title flag.
    const made = detailEnv({
      state: {
        estimate: { color: "green", reason: "calm", official: false, sources: [], updated: NOW_ISO },
        official: { color: "red", reason: "posted", official: true, source: "https://ex.gov/f", updated: NOW_ISO },
        officialExpires: NOW_EPOCH
      }
    });
    const html = await (await handleRequest(detailRequest("b-1"), made.env)).text();
    const h1 = sliceBetween(html, "<h1 class=\"beach-title", "</h1>");
    expect(h1).toContain("flag-icon-green");
    expect(h1).not.toContain("flag-icon-red");
    expect(html).not.toContain("class=\"official-card\"");
  });
});

describe("handleDetail nearby beaches", () => {
  const self = { id: "b-self", name: "Oval Beach", lat: 42.6579, lon: -86.2114, osm_id: "way/1" };
  // Candidates deliberately out of distance order, with a far row past the 50 mi
  // cap and an inland row the flag-worthy gate must drop.
  const candidates = [
    self,
    { id: "b-far", name: "Far Beach", lat: 44.5, lon: -86.2 },
    { id: "b-3", name: "Third", lat: 42.70, lon: -86.21 },
    { id: "b-1", name: "Nearest", park_name: "Dune Park", lat: 42.66, lon: -86.21 },
    { id: "b-4", name: "Fourth", lat: 42.75, lon: -86.21 },
    { id: "b-2", name: "Second", lat: 42.68, lon: -86.21 },
    { id: "b-inland", name: "Inland", lat: 42.659, lon: -86.212, water_class: "inland", water_class_attempts: 0 }
  ];
  const NEARBY_STATE = {
    "b-2": { estimate: { color: "red", reason: "x", official: false, updated: "2026-07-05T11:00:00.000Z" } },
    "b-1": { official: { color: "green", official: true, source: "s", updated: "2026-07-05T11:00:00.000Z" } }
  };

  function nearbyEnv(beaches, state) {
    return makeEnv({ beaches: beaches, state: state || {} });
  }

  function detailRequest(id) {
    return { method: "GET", url: "https://swim.report/beach/" + id, cf: {} };
  }

  it("renders the three nearest as cards in distance order, dropping self, inland and the far row", async () => {
    const { env } = nearbyEnv(candidates, NEARBY_STATE);
    const res = await handleRequest(detailRequest("b-self"), env, makeCtx());
    expect(res.status).toBe(200);
    const html = await res.text();
    const section = sliceBetween(html, "<section class=\"nearby", "</section>");
    expect(section).toContain("Nearby beaches");
    expect(section.split("<wa-card class=\"nearby-card\"").length - 1).toBe(3);
    expect(section.indexOf("/beach/b-1")).toBeLessThan(section.indexOf("/beach/b-2"));
    expect(section.indexOf("/beach/b-2")).toBeLessThan(section.indexOf("/beach/b-3"));
    expect(section).not.toContain("/beach/b-4");
    expect(section).not.toContain("/beach/b-far");
    expect(section).not.toContain("/beach/b-self");
    expect(section).not.toContain("/beach/b-inland");
    // Each card's displayFlag chip and OFFICIAL badge come off its own joined
    // row, and read exactly as a list row's do.
    const first = sliceBetween(section, "<wa-card class=\"nearby-card\"", "</wa-card>");
    expect(first).toContain("Dune Park");
    expect(first).toContain("OFFICIAL");
    expect(first).toContain(">GREEN</wa-badge>");
    expect(first).not.toContain("UNKNOWN");
    expect(first).toContain("&lt;1 mi");
    expect(section).toContain("RED");
  });

  it("reads an expired nearby estimate as unknown", async () => {
    const { env } = nearbyEnv(candidates, {
      "b-1": {
        estimate: { color: "green", reason: "calm", official: false, updated: "2026-07-05T11:00:00.000Z" },
        estimateExpires: NOW_EPOCH
      }
    });
    const html = await (await handleRequest(detailRequest("b-self"), env, makeCtx())).text();
    const first = sliceBetween(
      sliceBetween(html, "<section class=\"nearby", "</section>"),
      "<wa-card class=\"nearby-card\"", "</wa-card>"
    );
    expect(first).toContain("UNKNOWN");
    expect(first).not.toContain("GREEN");
  });

  it("renders no section when nothing flag-worthy is nearby", async () => {
    const { env } = nearbyEnv([self]);
    const res = await handleRequest(detailRequest("b-self"), env, makeCtx());
    const html = await res.text();
    expect(html).not.toContain("<section class=\"nearby");
    expect(html).not.toContain("Nearby beaches");
  });

  it("drops candidates beyond the 50 mi cap", async () => {
    const { env } = nearbyEnv([self, candidates[1]]);
    const res = await handleRequest(detailRequest("b-self"), env, makeCtx());
    const html = await res.text();
    expect(html).not.toContain("<section class=\"nearby");
  });
});

describe("renderDetailPage nearby section placement", () => {
  const base = { id: "b-1", name: "Oval Beach", lat: 42.6579, lon: -86.2114, osm_id: "way/1",
    webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1/day" };
  const nearby = [
    { beach: { id: "n-1", name: "North Beach", lat: 42.67, lon: -86.21 }, estimate: null, official: null, distanceMi: 0.8 },
    { beach: { id: "n-2", name: "South Beach", lat: 42.64, lon: -86.21 }, estimate: null, official: null, distanceMi: 1.3 }
  ];

  it("sits last, below the wave map and the webcam", () => {
    const html = renderDetailPage({ beach: base, estimate: null, official: null, nearby: nearby, nowIso: "2026-07-05T12:00:00.000Z" });
    const map = html.indexOf("<section class=\"wave-map\"");
    const near = html.indexOf("<section class=\"nearby");
    const cam = html.indexOf("<section class=\"webcam");
    expect(map).toBeGreaterThan(-1);
    // A live picture of the beach outranks links away from it, so the webcam
    // comes first and the nearby cards close the page.
    expect(cam).toBeGreaterThan(map);
    expect(near).toBeGreaterThan(cam);
    expect(html).toContain("aria-labelledby=\"nearby-heading\"");
  });

  it("is absent when the router passes no nearby list", () => {
    const html = renderDetailPage({ beach: base, estimate: null, official: null, nowIso: "2026-07-05T12:00:00.000Z" });
    expect(html).not.toContain("<section class=\"nearby");
  });
});

// The single-beach env the cache-header and last_viewed tests use: one seeded
// row, or an empty table when the fixture is null.
function viewEnv(beach) {
  return makeEnv({ beaches: beach ? [beach] : [] });
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
const MAP_DIRECTORY_CACHE = "public, max-age=60, stale-while-revalidate=60, stale-if-error=600";

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

    // /api/beaches.geojson has its own policy, not the shared CACHEABLE one:
    // its origin is one scan of scalar columns, so the long stale-while-revalidate
    // would only add latency to a flag flip.
    const geoRes = await handleRequest(
      getRequest("/api/beaches.geojson"), viewEnv(beach).env
    );
    expect(geoRes.headers.get("cache-control")).toBe(MAP_DIRECTORY_CACHE);
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

  // The stamp as it landed in D1, or null when none was written.
  function stampOf(db) {
    return db.sqlite.prepare("SELECT last_viewed FROM beaches WHERE id = ?1")
      .get("b-1").last_viewed;
  }

  it("stamps a never-viewed beach via ctx.waitUntil on the detail page", async () => {
    const { env, db } = viewEnv(beachViewed(null));
    const ctx = makeCtx();
    const res = await handleRequest(getRequest("/beach/b-1"), env, ctx);
    expect(res.status).toBe(200);
    expect(ctx.promises.length).toBe(1);
    await Promise.all(ctx.promises);
    expect(Number.isFinite(Date.parse(stampOf(db)))).toBe(true);
  });

  it("stamps on /api/flag too, reading last_viewed for the throttle check", async () => {
    const { env, db } = viewEnv(beachViewed(null));
    const ctx = makeCtx();
    await handleRequest(getRequest("/api/flag/b-1"), env, ctx);
    await Promise.all(ctx.promises);
    expect(Number.isFinite(Date.parse(stampOf(db)))).toBe(true);
  });

  it("throttles: a stamp within the last hour is not repeated", async () => {
    const fresh = new Date(Date.now() - 60000).toISOString();
    const { env, db } = viewEnv(beachViewed(fresh));
    const ctx = makeCtx();
    await handleRequest(getRequest("/beach/b-1"), env, ctx);
    expect(ctx.promises.length).toBe(0);
    expect(stampOf(db)).toBe(fresh);
  });

  it("re-stamps once the previous view is over an hour old", async () => {
    const stale = new Date(Date.now() - 7200000).toISOString();
    const { env, db } = viewEnv(beachViewed(stale));
    const ctx = makeCtx();
    await handleRequest(getRequest("/beach/b-1"), env, ctx);
    await Promise.all(ctx.promises);
    expect(stampOf(db)).not.toBe(stale);
  });

  it("no-ops without ctx (render is unaffected)", async () => {
    const { env, db } = viewEnv(beachViewed(null));
    const res = await handleRequest(getRequest("/beach/b-1"), env);
    expect(res.status).toBe(200);
    expect(stampOf(db)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Worker entrypoint (error boundary and cron dispatch), router guards (405,
// proximity ordering), and render.js invariants (stale warnings, honest
// unknown, double-red, footer disclaimer, source labels, escapeHtml,
// formatMiles, search-script id contract).
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
    FLAGS: makeFlags(null)
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

describe("GET /api/beaches.geojson", () => {
  const NOW_MS = Date.now();

  function agoIso(ms) {
    return new Date(NOW_MS - ms).toISOString();
  }

  function beachRow(id, overrides) {
    const base = { id: id, name: id.toUpperCase(), park_name: null, lat: 42, lon: -86 };
    const extra = overrides || {};
    for (const key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        base[key] = extra[key];
      }
    }
    return base;
  }

  function geojson(env) {
    return handleRequest(getRequest("/api/beaches.geojson"), env);
  }

  async function bodyFor(beaches, state) {
    const made = makeEnv({ beaches: beaches, state: state || {} });
    const res = await geojson(made.env);
    expect(res.status).toBe(200);
    return { body: await res.json(), made: made };
  }

  it("emits one Feature per flag-worthy beach, reading no KV at all", async () => {
    const out = await bodyFor(
      [beachRow("b1", { park_name: "Big Park" })],
      { b1: { estimate: { color: "green", updated: agoIso(600000) } } }
    );
    expect(out.made.flags.keys).toEqual([]);
    expect(out.body.type).toBe("FeatureCollection");
    expect(out.body.degraded).toBeUndefined();
    expect(out.body.features.length).toBe(1);
    const f = out.body.features[0];
    expect(f.type).toBe("Feature");
    // GeoJSON coordinate order is [lon, lat], NOT [lat, lon].
    expect(f.geometry.coordinates).toEqual([-86, 42]);
    expect(f.properties.id).toBe("b1");
    expect(f.properties.name).toBe("Big Park");
    expect(f.properties.flag).toBe("green");
  });

  it("resolves every feature exactly as displayFlag does at read time", async () => {
    // Parity is the whole reason the row stores ingredients: the map marker and
    // every other surface that shows the beach's flag resolve through displayFlag.
    const fixtures = [
      { id: "est-only", estimate: { color: "yellow", updated: agoIso(600000) }, official: null },
      {
        id: "fresh-official",
        estimate: { color: "red", updated: agoIso(600000) },
        official: { color: "yellow", updated: agoIso(600000) }
      },
      {
        id: "aged-official",
        estimate: { color: "red", updated: agoIso(600000) },
        official: { color: "yellow", updated: agoIso(10800000) }
      },
      {
        id: "aged-floor",
        estimate: { color: "green", updated: agoIso(600000) },
        official: { color: "red", updated: agoIso(10800000) }
      },
      { id: "double-red", estimate: null, official: { color: "double-red", updated: agoIso(600000) } },
      { id: "garbage", estimate: null, official: { color: "magenta", updated: agoIso(600000) } },
      { id: "nothing", estimate: null, official: null }
    ];
    const beaches = fixtures.map(function (f) { return beachRow(f.id); });
    const state = {};
    for (const fixture of fixtures) {
      state[fixture.id] = { estimate: fixture.estimate, official: fixture.official };
    }
    const out = await bodyFor(beaches, state);
    const nowIso = new Date().toISOString();
    const byId = {};
    out.body.features.forEach(function (f) { byId[f.properties.id] = f.properties.flag; });
    for (const fixture of fixtures) {
      expect(byId[fixture.id]).toBe(
        displayFlag({ estimate: fixture.estimate, official: fixture.official }, nowIso).keyword
      );
    }
    expect(byId["est-only"]).toBe("yellow");
    expect(byId["fresh-official"]).toBe("yellow");
    expect(byId["aged-official"]).toBe("red");
    // Raise-only: a fresher green estimate never pulls an aged posted red down.
    expect(byId["aged-floor"]).toBe("red");
    expect(byId["double-red"]).toBe("red");
    expect(byId.garbage).toBe("unknown");
    expect(byId.nothing).toBe("unknown");
  });

  it("reads a beach whose estimate outlived its lease as unknown, not its stored green", async () => {
    const out = await bodyFor([beachRow("expired")], {
      expired: {
        estimate: { color: "green", updated: agoIso(600000) },
        estimateExpires: NOW_EPOCH
      }
    });
    expect(out.body.features[0].properties.flag).toBe("unknown");
  });

  it("expires the official on its own column, without dropping a live estimate", async () => {
    const out = await bodyFor([beachRow("b1")], {
      b1: {
        estimate: { color: "yellow", updated: agoIso(600000) },
        official: { color: "red", updated: agoIso(600000) },
        officialExpires: NOW_EPOCH
      }
    });
    expect(out.body.features[0].properties.flag).toBe("yellow");
  });

  it("dates the collection by the freshest live estimate, and null when none is live", async () => {
    const beaches = [beachRow("old"), beachRow("new", { lat: 43 }), beachRow("bare", { lat: 44 })];
    const out = await bodyFor(beaches, {
      old: { estimate: { color: "green", updated: agoIso(3600000) } },
      new: { estimate: { color: "green", updated: agoIso(60000) } }
    });
    expect(out.body.builtAt).toBe(agoIso(60000));

    const expired = await bodyFor(beaches, {
      old: { estimate: { color: "green", updated: agoIso(60000) }, estimateExpires: NOW_EPOCH }
    });
    expect(expired.body.builtAt).toBe(null);

    const empty = await bodyFor([]);
    expect(empty.body.builtAt).toBe(null);
    expect(empty.body.features).toEqual([]);
  });

  it("drops rows whose coordinates are not finite rather than emitting NaN geometry", async () => {
    const made = makeEnv({ beaches: [beachRow("b1"), beachRow("b2", { lat: 43, lon: -85 })] });
    // lat is NOT NULL in the schema, so the unusable coordinate is written past
    // the fixture seeder.
    made.db.sqlite.exec("UPDATE beaches SET lat = 'nope' WHERE id = 'b2'");
    const body = await (await geojson(made.env)).json();
    expect(body.features.map(function (f) { return f.properties.id; })).toEqual(["b1"]);
  });

  it("carries the map cache policy and the geo+json content type", async () => {
    const made = makeEnv({ beaches: [beachRow("b1")] });
    const res = await geojson(made.env);
    expect(res.headers.get("cache-control")).toBe(MAP_DIRECTORY_CACHE);
    expect(res.headers.get("content-type")).toContain("application/geo+json");
  });
});

// The cross-surface matrix: for each fixture, every route that shows the beach's
// flag must show the one displayFlag decision, and credit OFFICIAL exactly when
// the posted record supplied the color. Timestamps are relative to the real
// clock, since every route resolves at its own Date.now().
describe("every surface shows the one displayFlag decision", () => {
  const T = Date.now();
  function ago(ms) {
    return new Date(T - ms).toISOString();
  }
  function est(color) {
    return { color: color, reason: "r", official: false, sources: [], updated: ago(600000) };
  }
  function off(color, updated) {
    return {
      color: color,
      reason: "posted",
      official: true,
      source: "https://ex.gov/f",
      sources: ["https://ex.gov/f"],
      updated: updated
    };
  }
  function expected(color, keyword, source) {
    return { color: color, keyword: keyword, source: source };
  }

  const HOST = { id: "osm-way-9000", name: "Host Beach", lat: 42.6579, lon: -86.2114 };
  const FIXTURES = [
    { name: "holland", estimate: est("green"), official: off("yellow", ago(1800000)),
      want: expected("yellow", "yellow", "official") },
    { name: "holland-pm", estimate: est("green"), official: off("yellow", ago(14400000)),
      want: expected("yellow", "yellow", "official") },
    { name: "aged-red", estimate: est("green"), official: off("red", ago(10800000)),
      want: expected("red", "red", "official") },
    { name: "outranked", estimate: est("red"), official: off("yellow", ago(10800000)),
      want: expected("red", "red", "estimate") },
    { name: "tie", estimate: est("yellow"), official: off("yellow", ago(10800000)),
      want: expected("yellow", "yellow", "estimate") },
    { name: "official-only", estimate: null, official: off("green", ago(10800000)),
      want: expected("green", "green", "official") },
    { name: "fresh-lower", estimate: est("red"), official: off("yellow", ago(600000)),
      want: expected("yellow", "yellow", "official") },
    { name: "double", estimate: est("double-red"), official: null,
      want: expected("double-red", "red", "estimate") },
    { name: "engine-unknown", estimate: est("unknown"), official: null,
      want: expected("unknown", "unknown", "none") },
    { name: "bad-official", estimate: est("yellow"), official: off("magenta", ago(600000)),
      want: expected("yellow", "yellow", "estimate") },
    { name: "nothing", estimate: null, official: null,
      want: expected("unknown", "unknown", "none") }
  ];
  const HERO_LABELS = {
    "green": "GREEN",
    "yellow": "YELLOW",
    "red": "RED",
    "double-red": "DOUBLE RED — water closed",
    "unknown": "UNKNOWN"
  };

  function shortLabel(color) {
    return color === "double-red" ? "DOUBLE RED" : HERO_LABELS[color];
  }

  function envFor(fixture, id) {
    const beach = { id: id, name: "Fixture " + fixture.name, lat: 42.66, lon: -86.21 };
    const state = {};
    if (fixture.estimate || fixture.official) {
      state[id] = { estimate: fixture.estimate, official: fixture.official };
    }
    return makeEnv({ beaches: [beach, HOST], state: state }).env;
  }

  // The enclosing element of the link to /beach/<id>.
  function enclosing(html, id, openMarker, closeMarker) {
    const at = html.indexOf("href=\"/beach/" + id + "\"");
    expect(at).toBeGreaterThan(-1);
    const start = html.lastIndexOf(openMarker, at);
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf(closeMarker, at) + closeMarker.length);
  }

  function firstBadge(markup) {
    const start = markup.indexOf("<wa-badge");
    expect(start).toBeGreaterThan(-1);
    return markup.slice(start, markup.indexOf("</wa-badge>", start) + "</wa-badge>".length);
  }

  // The compact flag a row or a nearby card carries.
  function expectCompactFlag(markup, d) {
    const chip = firstBadge(markup);
    expect(chip).toContain("flag-icon-" + d.keyword);
    expect(chip).toContain(">" + shortLabel(d.color) + "</wa-badge>");
    if (d.source === "official") {
      expect(markup).toContain(">OFFICIAL</wa-badge>");
    } else {
      expect(markup).not.toContain(">OFFICIAL</wa-badge>");
    }
    expect(markup).not.toContain(">ESTIMATE</wa-badge>");
  }

  function metaDescription(html) {
    const marker = "<meta name=\"description\" content=\"";
    const start = html.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const from = start + marker.length;
    return html.slice(from, html.indexOf("\"", from));
  }

  FIXTURES.forEach(function (fixture, index) {
    const id = "osm-way-" + (100 + index);
    const d = fixture.want;

    it(fixture.name + ": the decision itself", () => {
      const nowIso = new Date().toISOString();
      expect(displayFlag({ estimate: fixture.estimate, official: fixture.official }, nowIso))
        .toEqual(d);
    });

    it(fixture.name + ": home list row", async () => {
      const html = await (await handleRequest(homeRequest(""), envFor(fixture, id))).text();
      const row = enclosing(html, id, "<li class=\"beach-row\"", "</li>");
      expect(row).toContain("data-flag=\"" + d.keyword + "\"");
      expectCompactFlag(row, d);
    });

    it(fixture.name + ": ?ids= row", async () => {
      const req = { method: "GET", url: "https://swim.report/?ids=" + id, cf: {} };
      const html = await (await handleRequest(req, envFor(fixture, id))).text();
      const row = enclosing(html, id, "<li class=\"beach-row\"", "</li>");
      expect(row).toContain("data-flag=\"" + d.keyword + "\"");
      expectCompactFlag(row, d);
    });

    it(fixture.name + ": nearby card on a neighbor's page", async () => {
      const res = await handleRequest(getRequest("/beach/" + HOST.id), envFor(fixture, id), makeCtx());
      expect(res.status).toBe(200);
      const html = await res.text();
      const section = sliceBetween(html, "<section class=\"nearby", "</section>");
      const card = enclosing(section, id, "<wa-card class=\"nearby-card\"", "</wa-card>");
      expectCompactFlag(card, d);
    });

    it(fixture.name + ": detail hero and share meta", async () => {
      const res = await handleRequest(getRequest("/beach/" + id), envFor(fixture, id), makeCtx());
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<section class=\"detail-hero wa-stack wa-gap-s\" data-flag=\"" +
        d.keyword + "\">");
      expect(sliceBetween(html, "<span class=\"hero-flag-label", "</span>")).toBe(
        "<span class=\"hero-flag-label wa-font-size-l wa-font-weight-bold\">" +
        HERO_LABELS[d.color] + "</span>");
      const h1 = sliceBetween(html, "<h1 class=\"beach-title", "</h1>");
      expect(h1).toContain("flag-icon-" + d.keyword);
      const heroFlag = sliceBetween(html, "<p class=\"hero-flag", "</p>");
      expect(heroFlag.indexOf("OFFICIAL</wa-badge>") !== -1).toBe(d.source === "official");
      expect(heroFlag.indexOf(">ESTIMATE</wa-badge>") !== -1).toBe(d.source === "estimate");
      expect(html).toContain("<meta property=\"og:image\" content=\"https://swim.report/og/" +
        d.color + ".png\">");
      const description = metaDescription(html);
      if (d.source === "official") {
        expect(description).toContain("official ");
      } else if (d.source === "estimate") {
        expect(description).toContain("estimated ");
      } else {
        expect(description).toContain("flag status unknown right now");
      }
      if (fixture.official) {
        // The official card keeps reporting its own record verbatim.
        const card = officialCardOf(html);
        const ownColor = ["green", "yellow", "red", "double-red"].indexOf(fixture.official.color) !== -1
          ? fixture.official.color : "unknown";
        expect(card).toContain(">" + HERO_LABELS[ownColor] + "</span>");
      }
    });

    it(fixture.name + ": geojson marker", async () => {
      const body = await (await handleRequest(getRequest("/api/beaches.geojson"), envFor(fixture, id))).json();
      const feature = body.features.filter(function (f) { return f.properties.id === id; })[0];
      expect(feature.properties.flag).toBe(d.keyword);
      expect(Object.keys(feature.properties)).toEqual(["id", "name", "flag"]);
    });

    it(fixture.name + ": /api/flag display field", async () => {
      const res = await handleRequest(getRequest("/api/flag/" + id), envFor(fixture, id), makeCtx());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Object.keys(body)).toEqual(["beachId", "estimate", "official", "display"]);
      expect(body.display).toEqual({ color: d.color, source: d.source });
      expect(body.estimate).toEqual(fixture.estimate);
      expect(body.official).toEqual(fixture.official);
    });
  });
});

describe("handleHome proximity branch: in-memory distance sort", () => {
  function rowNamed(id, name, lat, lon) {
    return { id: id, name: name, park_name: null, lat: lat, lon: lon };
  }

  it("orders the rendered rows by distance from the resolved location", async () => {
    // Alphabetical order is deliberately the reverse of distance order, so only
    // proximity sorting can put Near Beach ahead of Far Beach.
    const rows = [
      rowNamed("b-far", "A Far Beach", 43.5, -86.28),
      rowNamed("b-near", "Z Near Beach", 42.41, -86.28)
    ];
    const ids = await renderedIdsFor(
      homeRequest("?near=42.4,-86.28"), makeEnv({ beaches: rows }).env
    );
    expect(ids).toEqual(["b-near", "b-far"]);
  });

  it("slices the sorted rows to 100 rendered beach rows", async () => {
    const rows = [];
    for (let i = 0; i < 101; i++) {
      rows.push(rowNamed("b-" + String(i), "Beach " + String(i), 42.4 + i * 0.01, -86.28));
    }
    const { env } = makeEnv({ beaches: rows });
    const res = await handleRequest(homeRequest("?near=42.4,-86.28"), env);
    const html = await res.text();
    expect(html.split("<li class=\"beach-row\"").length - 1).toBe(100);
    // Nearest-first, so the row the cap dropped is the farthest one.
    expect(html).not.toContain("/beach/b-100");
  });

  it("never interpolates raw near text into the ORDER BY (injection guard)", async () => {
    const hostile = "42.4);DROP TABLE beaches;--,-86.28";
    const { env, db } = makeEnv({
      beaches: [rowNamed("b-1", "Oval Beach", 42.41, -86.28), rowNamed("b-2", "Ash Beach", 43.5, -86.28)]
    });
    const res = await handleRequest(
      homeRequest("?near=" + encodeURIComponent(hostile)), env
    );
    expect(res.status).toBe(200);
    // resolveUserLocation rejects the value outright, so the page falls back to
    // the alphabetical branch and the table is still there afterwards.
    expect(renderedIds(await res.text())).toEqual(["b-2", "b-1"]);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS c FROM beaches").get().c).toBe(2);
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

  it("leaves the detail-title icon pair decorative beside the hero's own label", () => {
    // The hero prints the full label under the title, so naming the icon pair
    // as well would read the color out twice.
    const html = detailPage(null, doubleRedOfficial);
    const h1 = sliceBetween(html, "<h1 class=\"beach-title", "</h1>");
    expect(h1).toContain("flag-icon-red");
    expect(h1).not.toContain("aria-label");
    expect(html).toContain(">DOUBLE RED — water closed</span>");
  });
});

describe("detail-page title flag precedence", () => {
  function titleOf(html) {
    return sliceBetween(html, "<h1 class=\"beach-title", "</h1>");
  }

  // The hero's flag label is what names the display color in text; the title
  // icon only tints it.
  function heroLabelOf(html) {
    return sliceBetween(html, "<span class=\"hero-flag-label", "</span>");
  }

  it("prefers the official color over the estimate", () => {
    const html = detailPage(
      { color: "green", reason: "calm", sources: [] },
      { color: "red", reason: "posted", official: true, source: "https://ex.gov/f", updated: NOW_ISO }
    );
    const h1 = titleOf(html);
    expect(h1).toContain("flag-icon-red");
    expect(heroLabelOf(html)).toContain("RED");
    expect(h1).not.toContain("flag-icon-green");
  });

  it("uses the estimate color when no official flag exists", () => {
    const html = detailPage({ color: "yellow", reason: "waves", sources: [] });
    expect(titleOf(html)).toContain("flag-icon-yellow");
    expect(heroLabelOf(html)).toContain("YELLOW");
  });

  it("renders gray unknown (never green) when both are null", () => {
    const html = detailPage(null, null);
    const h1 = titleOf(html);
    expect(h1).toContain("flag-icon-unknown");
    expect(heroLabelOf(html)).toContain("UNKNOWN");
    expect(h1).not.toContain("flag-icon-green");
  });
});

// An official record whose reading has aged past the 2 h STALE_MS default is a
// POINT-IN-TIME observation, not a live one (NWS GRR's morning OMR beach report
// is the canonical case). Past that horizon a fresher estimate may RAISE the
// displayed color but never lower it — the same raise-only floor shape rules.js
// uses for nws-floor / eccc-floor / wq-floor.
describe("detail-page title flag: raise-only over an aged official reading", () => {
  function titleOf(html) {
    return sliceBetween(html, "<h1 class=\"beach-title", "</h1>");
  }
  // 4 h before NOW_ISO — past the 2 h default, well inside the OMR's own 30 h
  // staleMs, which is deliberately NOT the gate.
  const AGED = "2026-07-05T08:00:00.000Z";
  // 30 min before NOW_ISO — still fresh.
  const FRESH = "2026-07-05T11:30:00.000Z";

  function official(color, updated) {
    return {
      color: color,
      reason: "posted",
      official: true,
      source: "https://www.weather.gov/grr/",
      updated: updated,
      staleMs: 30 * 60 * 60 * 1000,
      readingNote: "Morning reading — conditions may have changed since it was posted"
    };
  }

  it("raises an aged official yellow to a fresher estimate's red", () => {
    const html = detailPage(
      { color: "red", reason: "Active NWS alert: Beach Hazards Statement", sources: [] },
      official("yellow", AGED)
    );
    const h1 = titleOf(html);
    expect(h1).toContain("flag-icon-red");
    // The estimate supplied that red, so the hero credits the estimate for it.
    expect(html).toContain("<span class=\"hero-flag-label wa-font-size-l wa-font-weight-bold\">RED</span>");
    expect(h1).not.toContain("flag-icon-yellow");
  });

  it("never lowers an aged official red to a fresher estimate's green", () => {
    const h1 = titleOf(detailPage(
      { color: "green", reason: "calm", sources: [] },
      official("red", AGED)
    ));
    expect(h1).toContain("flag-icon-red");
    expect(h1).not.toContain("flag-icon-green");
  });

  it("keeps the official color outright while the reading is still fresh", () => {
    const h1 = titleOf(detailPage(
      { color: "red", reason: "Active NWS alert: Beach Hazards Statement", sources: [] },
      official("yellow", FRESH)
    ));
    expect(h1).toContain("flag-icon-yellow");
    expect(h1).not.toContain("flag-icon-red");
  });

  it("does not let an unknown estimate pull an aged official green down", () => {
    const h1 = titleOf(detailPage(null, official("green", AGED)));
    expect(h1).toContain("flag-icon-green");
    expect(h1).not.toContain("flag-icon-unknown");
  });

  it("leaves the OFFICIAL card reporting the scraped color verbatim", () => {
    // The raised title must never rewrite the official card: that card is the
    // posted flag, and an estimate may never be presented AS official.
    const html = detailPage(
      { color: "red", reason: "Active NWS alert: Beach Hazards Statement", sources: [] },
      official("yellow", AGED)
    );
    const card = officialCardOf(html);
    expect(card).toContain(">YELLOW</span>");
    expect(card).toContain("flag-icon-yellow");
    expect(card).not.toContain("flag-icon-red");
    expect(titleOf(html)).toContain("flag-icon-red");
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
    expect(LIST_SEARCH_SCRIPT).toContain("searchTerm() !== term");
    expect(LIST_SEARCH_SCRIPT).toContain("__swimReportListGen");
    // No sticky "last sent" term — a failed fetch must not disable retries.
    expect(LIST_SEARCH_SCRIPT).not.toContain("lastSent");
    // The fetch carries a near (URL's or the baked-in center) so the response is
    // cacheable, while the shareable replaceState url stays clean.
    expect(LIST_SEARCH_SCRIPT).toContain("data-complete");
    expect(LIST_SEARCH_SCRIPT).toContain("fetchUrl");
    expect(LIST_SEARCH_SCRIPT).toContain("bakedCenter");
    // The green-only filter: one persistence key, both accesses guarded, the
    // switch's id, the row attribute it reads, and the swap hook that re-applies
    // it after every row replacement.
    expect(LIST_SEARCH_SCRIPT).toContain("'swimreport:green-only'");
    expect(LIST_SEARCH_SCRIPT).toContain("window.localStorage.getItem(GREEN_ONLY_KEY)");
    expect(LIST_SEARCH_SCRIPT).toContain("window.localStorage.setItem(GREEN_ONLY_KEY");
    expect(LIST_SEARCH_SCRIPT).toContain("getElementById('green-only-filter')");
    expect(LIST_SEARCH_SCRIPT).toContain("getAttribute('data-flag') === 'green'");
    expect(LIST_SEARCH_SCRIPT).toContain("addEventListener('swimreport:listswap'");
    expect(LIST_SEARCH_SCRIPT).toContain("No green-flag beaches match your search.");
    expect(LIST_SEARCH_SCRIPT).not.toContain("estimated-green");
    // A restored state must be applied at load: wa-switch fires "change" only on a
    // real click or keypress, so without this the switch would read on above a
    // list still showing every red, yellow and unknown row.
    expect(LIST_SEARCH_SCRIPT).toContain("greenSwitch.checked = true;\n      filterRows();");
    // The filter owns the empty state only when the term itself matched rows, so a
    // plain search miss keeps the server's copy.
    expect(LIST_SEARCH_SCRIPT).toContain("greenOnly && visibleCount === 0 && termCount > 0");
    // The live region counts what is on screen, not the rows the filter hid.
    expect(LIST_SEARCH_SCRIPT).toContain("row.style.display !== 'none'");
    expect(LIST_SEARCH_SCRIPT).not.toContain("querySelectorAll('.beach-row').length");

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

  it("announces every successful list replacement so the client filters re-apply", () => {
    // The helper replaces #beach-list-items wholesale, so every row loses the
    // inline display the search and green-only filters wrote.
    expect(LIST_SWAP_SCRIPT).toContain("new CustomEvent('swimreport:listswap')");
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

describe("renderListPage color-coded rows", () => {
  function entryWith(color) {
    return {
      beach: { id: "b-" + String(color), name: "Beach " + String(color), lat: 42, lon: -86 },
      estimate: color === null ? null : { color: color, reason: "r", official: false, updated: NOW_ISO },
      official: null,
      distanceMi: null
    };
  }

  function firstRow(html) {
    const start = html.indexOf("<li class=\"beach-row\" data-flag=\"");
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("</li>", start));
  }

  function entryWithOfficial(estimateColor, officialColor, officialUpdated) {
    const entry = entryWith(estimateColor);
    entry.official = { color: officialColor, updated: officialUpdated };
    return entry;
  }

  it("stamps each row with its display flag's keyword", () => {
    const cases = [
      [entryWith("green"), "green"],
      [entryWith("yellow"), "yellow"],
      [entryWith("red"), "red"],
      // double-red shares the red tint, exactly as collapseFlagColor decides.
      [entryWith("double-red"), "red"],
      // No estimate is an honest gray, never an omitted attribute.
      [entryWith(null), "unknown"],
      // A fresh official decides outright, even below the estimate.
      [entryWithOfficial("green", "yellow", NOW_ISO), "yellow"],
      // An aged official yellow is outranked by the fresher estimate's red.
      [entryWithOfficial("red", "yellow", "2026-07-05T08:00:00.000Z"), "red"],
      // An aged official with no estimate still supplies the color.
      [entryWithOfficial(null, "green", "2026-07-05T08:00:00.000Z"), "green"]
    ];
    for (const pair of cases) {
      const row = firstRow(renderListPage({ entries: [pair[0]], nowIso: NOW_ISO }));
      expect(row).toContain("data-flag=\"" + pair[1] + "\"");
      // class="beach-row" stays the first attribute and gains no color class.
      expect(row.indexOf("<li class=\"beach-row\" data-flag=")).toBe(0);
      // The chip, the row's first badge, carries the same keyword as the border.
      const chip = row.slice(row.indexOf("<wa-badge"), row.indexOf("</wa-badge>"));
      expect(chip).toContain("flag-icon-" + pair[1]);
    }
  });

  it("carries one border rule per flag keyword, from the flag color tokens", () => {
    expect(PAGE_STYLES).toContain(".beach-row .beach-row-link {");
    expect(PAGE_STYLES).toContain("border-inline-start-width: var(--wa-border-width-l);");
    expect(PAGE_STYLES).toContain(
      ".beach-row[data-flag=\"green\"] .beach-row-link { border-inline-start-color: var(--flag-green); }");
    expect(PAGE_STYLES).toContain(
      ".beach-row[data-flag=\"yellow\"] .beach-row-link { border-inline-start-color: var(--flag-yellow); }");
    expect(PAGE_STYLES).toContain(
      ".beach-row[data-flag=\"red\"] .beach-row-link { border-inline-start-color: var(--flag-red); }");
    expect(PAGE_STYLES).toContain(
      ".beach-row[data-flag=\"unknown\"] .beach-row-link { border-inline-start-color: var(--flag-unknown); }");
  });

  // Every flag color in the sheet, the wave strip and mapScript reads one of
  // these four variables, so this is the only place a palette tint is named.
  it("declares the four flag variables once, on <html>", () => {
    expect(PAGE_STYLES).toContain("--flag-green: var(--wa-color-green-50);");
    expect(PAGE_STYLES).toContain("--flag-yellow: var(--wa-color-yellow-70);");
    expect(PAGE_STYLES).toContain("--flag-red: var(--wa-color-red-50);");
    expect(PAGE_STYLES).toContain("--flag-unknown: var(--wa-color-gray-50);");
    const palette = PAGE_STYLES.match(/--wa-color-(green-50|yellow-70|red-50|gray-50)/g);
    expect(palette).toHaveLength(4);
  });
});

describe("renderListPage green-only filter and distance origin", () => {
  const ROW = { beach: OVAL, estimate: null, official: null, distanceMi: 3.2 };

  it("renders the green-only switch above the list, inert without JS", () => {
    const html = renderListPage({ entries: [ROW], nowIso: NOW_ISO });
    expect(html).toContain("<div class=\"list-filter\">");
    // data-flag is the row's displayFlag keyword, which either record may supply.
    expect(html).toContain(
      "<wa-switch id=\"green-only-filter\" size=\"s\">Green flags only</wa-switch>");
    expect(html).not.toContain("Estimated green only");
    // The control sits above the list, and the server never pre-filters: the row
    // renders whether or not the switch would hide it.
    expect(html.indexOf("class=\"list-filter\"")).toBeLessThan(html.indexOf("id=\"beach-list-items\""));
    expect(html).toContain("data-flag=\"unknown\"");
  });

  it("omits the switch when the page has no rows to filter", () => {
    // The switch markup is gone; searchScript.js still carries the id as a
    // string constant, so the assertion names the element, not the id.
    const empty = renderListPage({ entries: [], nowIso: NOW_ISO });
    expect(empty).not.toContain("<wa-switch id=\"green-only-filter\"");
    expect(empty).not.toContain("class=\"list-filter\"");
    // The controls row collapses rather than leaving a gap of white space.
    expect(PAGE_STYLES).toContain(".list-controls:empty {");
    // A search miss is equally rowless, so it gets no filter over nothing either.
    const miss = renderListPage({ entries: [], nowIso: NOW_ISO, query: "zzz" });
    expect(miss).not.toContain("<wa-switch id=\"green-only-filter\"");
    expect(miss).toContain("No beaches match your search.");
  });

  it("heads a proximity-sorted list with Nearby, above the rows and below Your Beaches", () => {
    const html = renderListPage({
      entries: [ROW],
      nowIso: NOW_ISO,
      sortedByProximity: true,
      near: "42.658,-86.211"
    });
    expect(html).toContain(
      "<h2 id=\"nearby-heading\" class=\"nearby-heading\">Nearby</h2>");
    // The heading names its own section, so the list is a labelled region.
    expect(html).toContain(
      "<section class=\"beach-list-section wa-stack wa-gap-s\" aria-labelledby=\"nearby-heading\">");
    const headingAt = html.indexOf("id=\"nearby-heading\"");
    expect(html.indexOf("id=\"your-beaches-heading\"")).toBeLessThan(headingAt);
    expect(headingAt).toBeLessThan(html.indexOf("id=\"beach-list-items\""));
    // Both headings are one size, set by one grouped rule.
    expect(PAGE_STYLES).toContain(".nearby-heading {");
  });

  it("omits the Nearby heading when the list is not proximity-sorted", () => {
    const html = renderListPage({ entries: [ROW], nowIso: NOW_ISO });
    // The class still ships inside PAGE_STYLES, so the assertion names the
    // rendered heading rather than the string.
    expect(html).not.toContain("<h2 id=\"nearby-heading\"");
    expect(html).not.toContain("aria-labelledby=\"nearby-heading\"");
    expect(html).toContain("<section class=\"beach-list-section wa-stack wa-gap-s\">");
  });

  it("names no origin for the distance labels", () => {
    // The heading carries the claim now; a line under the search box explaining
    // where the distances are measured from would only repeat it.
    const html = renderListPage({
      entries: [ROW],
      nowIso: NOW_ISO,
      sortedByProximity: true,
      near: "42.658,-86.211"
    });
    expect(html).not.toContain("Distances from your");
    expect(html).not.toContain("list-origin");
    expect(LIST_GEO_SCRIPT).not.toContain("list-origin");
  });

  it("heads the list with Nearby whenever the router resolved a location", async () => {
    const rows = [{ id: "b1", name: "Oval Beach", park_name: null, lat: 42.6, lon: -86.2 }];
    const { env } = makeEnv({ beaches: rows });
    const located = await handleRequest(homeRequest("?near=42.6,-86.2"), env);
    expect(await located.text()).toContain(">Nearby</h2>");
    // With no near param and no request.cf coordinates the rows are alphabetical.
    const { env: env2 } = makeEnv({ beaches: rows });
    expect(await (await handleRequest(homeRequest(), env2)).text())
      .not.toContain(">Nearby</h2>");
  });
});

// GET /?ids=... — the bounded, order-preserving list mode the browser-side
// "Your Beaches" section fetches.
describe("GET /?ids= list mode", () => {
  const ONE = { id: "osm-way-1", name: "Oval Beach", lat: 42.6579, lon: -86.2114 };
  const TWO = { id: "osm-node-2", name: "Ottawa Beach", lat: 42.775, lon: -86.211 };

  function idsRequest(search) {
    return { method: "GET", url: "https://swim.report/?ids=" + search, cf: {} };
  }

  // Statements this route prepared against the beaches table, whatever their
  // shape: the point of the assertions below is whether the read happened.
  function beachReads(statements) {
    return statements.filter(function (st) {
      return st.sql.indexOf("FROM beaches") !== -1;
    });
  }

  it("renders the listed beaches behind the flag-worthy gate", async () => {
    const inland = { id: "osm-way-3", name: "Fremont Lake", lat: 43.4, lon: -85.9, water_class: "inland", water_class_attempts: 0 };
    const ids = await renderedIdsFor(
      idsRequest("osm-way-1,osm-node-2,osm-way-3"),
      makeEnv({ beaches: [ONE, TWO, inland] }).env
    );
    expect(ids).toEqual(["osm-way-1", "osm-node-2"]);
  });

  it("carries each beach's own estimate and official from its joined row", async () => {
    const made = makeEnv({
      beaches: [ONE, TWO],
      state: {
        "osm-way-1": {
          estimate: { color: "red", reason: "x", official: false, updated: "2026-07-05T11:00:00.000Z" }
        },
        "osm-node-2": {
          official: { color: "green", official: true, source: "s", updated: "2026-07-05T11:00:00.000Z" }
        }
      }
    });
    const html = await (await handleRequest(idsRequest("osm-way-1,osm-node-2"), made.env)).text();
    const first = beachRowOf(html);
    expect(first).toContain(">RED</wa-badge>");
    expect(first).not.toContain(">OFFICIAL</wa-badge>");
    const second = html.slice(html.indexOf("<li class=\"beach-row\"", html.indexOf("</li>")));
    expect(second).toContain(">OFFICIAL</wa-badge>");
    // The official-only row shows the posted green, not an unknown estimate chip.
    expect(second).toContain(">GREEN</wa-badge>");
    expect(second).not.toContain(">UNKNOWN</wa-badge>");
  });

  it("renders the rows in the requested order, not the order SQLite returned", async () => {
    expect(await renderedIdsFor(idsRequest("osm-way-1,osm-node-2"), makeEnv({ beaches: [TWO, ONE] }).env))
      .toEqual(["osm-way-1", "osm-node-2"]);
    expect(await renderedIdsFor(idsRequest("osm-node-2,osm-way-1"), makeEnv({ beaches: [TWO, ONE] }).env))
      .toEqual(["osm-node-2", "osm-way-1"]);
  });

  it("skips ids with no matching row and renders the rest", async () => {
    expect(await renderedIdsFor(idsRequest("osm-way-1,osm-way-999"), makeEnv({ beaches: [ONE] }).env))
      .toEqual(["osm-way-1"]);
  });

  it("drops malformed ids before they reach SQL and skips the read entirely when none survive", async () => {
    expect(await renderedIdsFor(
      idsRequest("osm-way-1,osm-boat-3,12345,osm-way-x"), makeEnv({ beaches: [ONE] }).env
    )).toEqual(["osm-way-1"]);

    const none = makeEnv({ beaches: [ONE] });
    const empty = await handleRequest(idsRequest("nope,%2E%2E%2F"), none.env);
    expect(empty.status).toBe(200);
    expect(beachReads(none.statements).length).toBe(0);
    expect(await empty.text()).not.toContain("class=\"beach-row\"");
  });

  it("names the ids rather than claiming the database is empty", async () => {
    const { env } = makeEnv({ beaches: [ONE] });
    const res = await handleRequest(idsRequest("osm-way-999"), env);
    const html = await res.text();
    expect(html).toContain("No beaches match those ids.");
    expect(html).not.toContain("No beaches found yet. Check back soon.");
    expect(html).not.toContain("No beaches match your search.");
  });

  it("caps the list at 10 ids", async () => {
    const many = [];
    const beaches = [];
    for (let i = 1; i <= 14; i = i + 1) {
      many.push("osm-way-" + i);
      beaches.push({ id: "osm-way-" + i, name: "Beach " + i, lat: 42.6, lon: -86.2 });
    }
    const ids = await renderedIdsFor(idsRequest(many.join(",")), makeEnv({ beaches: beaches }).env);
    expect(ids.length).toBe(10);
    expect(ids[9]).toBe("osm-way-10");
    expect(ids).not.toContain("osm-way-11");
  });

  it("is cacheable and never asserts data-complete", async () => {
    const { env } = makeEnv({ beaches: [ONE] });
    const res = await handleRequest(idsRequest("osm-way-1"), env);
    expect(res.headers.get("cache-control")).toBe(CACHEABLE);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    // data-complete asserts the rendered rows are the whole flag-worthy table,
    // which one caller-chosen slice never is.
    expect(html).not.toContain("data-complete=\"1\"");
  });

  it("writes no last_viewed stamp for the listed beaches", async () => {
    const { env, db } = makeEnv({ beaches: [ONE, TWO] });
    const ctx = makeCtx();
    await handleRequest(idsRequest("osm-way-1,osm-node-2"), env, ctx);
    expect(ctx.promises.length).toBe(0);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS c FROM beaches WHERE last_viewed IS NOT NULL").get().c)
      .toBe(0);
  });
});

describe("parseBeachIds", () => {
  it("keeps well-formed ids in order, deduped, trimmed and capped at 10", () => {
    expect(parseBeachIds("osm-way-1, osm-node-2 ,osm-relation-3"))
      .toEqual(["osm-way-1", "osm-node-2", "osm-relation-3"]);
    expect(parseBeachIds("osm-way-1,osm-way-1")).toEqual(["osm-way-1"]);
    const many = [];
    for (let i = 1; i <= 12; i = i + 1) {
      many.push("osm-way-" + i);
    }
    expect(parseBeachIds(many.join(",")).length).toBe(10);
  });

  it("drops anything that is not an osm-<type>-<digits> id", () => {
    expect(parseBeachIds("osm-boat-1")).toEqual([]);
    expect(parseBeachIds("osm-way-")).toEqual([]);
    expect(parseBeachIds("osm-way-1x")).toEqual([]);
    expect(parseBeachIds("' OR 1=1 --")).toEqual([]);
    expect(parseBeachIds("")).toEqual([]);
    expect(parseBeachIds(null)).toEqual([]);
  });
});
