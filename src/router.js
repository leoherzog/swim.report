import { renderListPage, renderDetailPage, renderErrorPage, markerFlagColor } from "./frontend/render.js";
import { distanceMi } from "./geo.js";
import { FLAG_WORTHY_WATER_SQL, isFlagWorthyWater } from "./waterClass.js";

// Re-exported so existing importers keep working.
export { distanceMi };

const HOME_LIST_LIMIT = 100;
// When sorting by proximity the fetch bound is wider than the display bound:
// SQL orders by an approximate planar distance and this cap keeps the nearest
// 500 of those, then the JS haversine re-sorts them and slices to
// HOME_LIST_LIMIT. Purely a safety cap on an already-ordered read.
const HOME_GEO_FETCH_LIMIT = 500;

// Cache-control policy for the Workers Cache layer ([cache] in wrangler.toml).
// Cacheable routes are location-independent and short-lived: 60 s fresh, up to
// 10 min served stale while revalidating. stale-if-error is set explicitly
// because Cloudflare's default on Worker error is to serve stale indefinitely,
// which would freeze the pages' embedded staleness warnings — nowIso is baked
// into the HTML — with no bound. The home page must never be cached: it is
// personalized by request.cf geolocation, which is not part of the cache key and
// not expressible via Vary.
const CACHE_CONTROL_CACHEABLE =
  "public, max-age=60, stale-while-revalidate=600, stale-if-error=600";
const CACHE_CONTROL_NO_STORE = "no-store";

// Throttle for the last_viewed demand stamp: at most one D1 write per beach per
// hour. The enrichment crons order their candidate queues with last_viewed as a
// tiebreak, and the two beach-walking crons split their rotation into a hot tier
// (viewed within HOT_VIEW_WINDOW_MS, covered every run) and a cold tier, so an
// hourly stamp is finer than any of them need.
const LAST_VIEWED_MIN_INTERVAL_MS = 3600000;

// Escapes the LIKE wildcards (% and _) plus the escape character itself so a
// user's search term is matched literally, not as a pattern. The result is
// meant to be wrapped in "%" ... "%" and bound to a "LIKE ?n ESCAPE '\'"
// clause. Pure; exported for tests.
export function escapeLike(term) {
  return String(term)
    .split("\\").join("\\\\")
    .split("%").join("\\%")
    .split("_").join("\\_");
}

// User location for proximity sorting: the "near" query param (lat,lon —
// deterministic override for dev and tests) wins over Cloudflare's IP-derived
// request.cf.latitude/longitude (strings; absent in local dev and behind some
// VPNs). Returns { lat, lon } or null; null means keep alphabetical order.
export function resolveUserLocation(request, url) {
  const nearParam = url.searchParams.get("near");
  if (nearParam !== null) {
    const parts = nearParam.split(",");
    if (parts.length === 2) {
      const lat = Number(parts[0]);
      const lon = Number(parts[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon) &&
          lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        return { lat: lat, lon: lon };
      }
    }
    return null;
  }
  const cf = request.cf || {};
  const lat = Number(cf.latitude);
  const lon = Number(cf.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return { lat: lat, lon: lon };
  }
  return null;
}

function htmlResponse(html, status, cacheControl) {
  const headers = { "content-type": "text/html; charset=utf-8" };
  if (cacheControl) {
    headers["cache-control"] = cacheControl;
  }
  return new Response(html, { status: status, headers: headers });
}

// Demand signal for cron prioritization (migration 0007): stamp last_viewed when
// a visitor opens a beach's detail page or flag API. Fire-and-forget via
// ctx.waitUntil so it can never delay or fail the render, throttled to once per
// LAST_VIEWED_MIN_INTERVAL_MS per beach. This is the request path's only D1 write
// (PLAN.md sections 0 and 8) and still never an upstream fetch. No-ops when ctx
// is absent.
function touchLastViewed(env, ctx, beach) {
  if (!ctx || typeof ctx.waitUntil !== "function") {
    return;
  }
  const now = Date.now();
  const last = beach.last_viewed ? Date.parse(beach.last_viewed) : NaN;
  if (Number.isFinite(last) && now - last < LAST_VIEWED_MIN_INTERVAL_MS) {
    return;
  }
  const nowIso = new Date(now).toISOString();
  ctx.waitUntil(
    env.DB.prepare("UPDATE beaches SET last_viewed = ?1 WHERE id = ?2")
      .bind(nowIso, beach.id)
      .run()
      .catch(function (err) {
        console.log("router: last_viewed stamp failed for " + beach.id + ": " + err.message);
      })
  );
}

async function readFlagAndOfficial(env, beachId) {
  const results = await Promise.all([
    env.FLAGS.get("flag:" + beachId, { type: "json" }),
    env.FLAGS.get("official:" + beachId, { type: "json" })
  ]);
  return { estimate: results[0], official: results[1] };
}

// Optional ?q= search covers the entire beaches table, not just the rendered
// rows: a case-insensitive LIKE against both the display name
// (COALESCE(park_name, name)) and the beach's own name, with user wildcards
// escaped. When a user location resolves, the filter runs first and the matches
// are then distance-sorted, so proximity ordering holds for searches too.
const LIKE_WHERE =
  " WHERE (COALESCE(park_name, name) LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\')";

// Builds the "SELECT * FROM beaches ..." statement shared by both home-page
// branches: an optional LIKE_WHERE clause, an optional ORDER BY clause, and a
// caller-supplied LIMIT. Resulting SQL strings are byte-identical to the
// hand-written per-branch queries this replaces.
function buildHomeStatement(env, hasQuery, pattern, orderByClause, limit) {
  // Every home-page branch hides confirmed-inland (and parked-unresolved)
  // beaches via the canonical flag-worthy gate: AND it after the LIKE clause
  // when a query is present, use it as the WHERE otherwise.
  const where = hasQuery
    ? LIKE_WHERE + " AND " + FLAG_WORTHY_WATER_SQL
    : " WHERE " + FLAG_WORTHY_WATER_SQL;
  const order = orderByClause ? " ORDER BY " + orderByClause : "";
  const stmt = env.DB.prepare(
    "SELECT * FROM beaches" + where + order + " LIMIT " + String(limit)
  );
  return hasQuery ? stmt.bind(pattern) : stmt;
}

// ORDER BY expression that puts the geographically nearest rows first, so the
// HOME_GEO_FETCH_LIMIT cap slices by distance rather than by table scan order;
// without it a visitor at the far end of the table gets a "nearest beaches" list
// with no nearby beach in it. Planar squared distance in degrees with the
// longitude axis scaled by cos(lat): monotonic in true distance at this scale and
// cheap for SQLite per row, while the JS haversine still decides the rendered
// top-100 ordering.
//
// The three interpolated values are always finite Numbers rendered via String()
// and never raw request text, which is what keeps this injection-safe.
// resolveUserLocation only returns Number.isFinite coordinates, and the guard
// below re-checks before building the clause. Returns null for an unusable
// location, keeping the unordered shape rather than emitting anything unsafe.
function proximityOrderByClause(location) {
  const lat = Number(location.lat);
  const lon = Number(location.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  const cosLat = Math.cos(lat * Math.PI / 180);
  const lonScale = cosLat * cosLat;
  if (!Number.isFinite(lonScale)) {
    return null;
  }
  const dLat = "(lat - (" + String(lat) + "))";
  const dLon = "(lon - (" + String(lon) + "))";
  return dLat + " * " + dLat + " + " +
    dLon + " * " + dLon + " * " + String(lonScale);
}

async function handleHome(env, location, rawQuery, nearParam) {
  const query = (typeof rawQuery === "string") ? rawQuery.trim() : "";
  const hasQuery = query.length > 0;
  const pattern = hasQuery ? "%" + escapeLike(query) + "%" : null;
  let rows;
  let hasMore = false;
  if (location) {
    // LIMIT stays a pure safety cap: with the proximity ORDER BY in front of it
    // the 500 rows it keeps are the 500 NEAREST candidates, so the JS haversine
    // below re-sorts an already-relevant set.
    const stmt = buildHomeStatement(
      env, hasQuery, pattern, proximityOrderByClause(location), HOME_GEO_FETCH_LIMIT
    );
    const result = await stmt.all();
    rows = result.results || [];
    for (const beach of rows) {
      beach.distance_mi = distanceMi(location.lat, location.lon, beach.lat, beach.lon);
    }
    rows.sort(function (a, b) { return a.distance_mi - b.distance_mi; });
    hasMore = rows.length > HOME_LIST_LIMIT;
    rows = rows.slice(0, HOME_LIST_LIMIT);
  } else {
    // Alphabetical by DISPLAY name: rows inside a park render under the park
    // name, so they must sort under it too (COALESCE matches the frontend's
    // displayName()). Fetch one extra row to detect whether more beaches exist
    // beyond the cap (drives the "search all beaches" empty-state affordance).
    const detectLimit = HOME_LIST_LIMIT + 1;
    const stmt = buildHomeStatement(
      env, hasQuery, pattern, "COALESCE(park_name, name), name", detectLimit
    );
    const result = await stmt.all();
    rows = result.results || [];
    hasMore = rows.length > HOME_LIST_LIMIT;
    if (hasMore) {
      rows = rows.slice(0, HOME_LIST_LIMIT);
    }
  }
  // Bulk KV read: one get() per key family instead of two round-trips per
  // beach. rows is capped at HOME_LIST_LIMIT (100), which is exactly the
  // bulk-get key limit, so a single call per family always suffices.
  const entries = [];
  if (rows.length > 0) {
    const flagKeys = rows.map(function (beach) { return "flag:" + beach.id; });
    const officialKeys = rows.map(function (beach) { return "official:" + beach.id; });
    const maps = await Promise.all([
      env.FLAGS.get(flagKeys, { type: "json" }),
      env.FLAGS.get(officialKeys, { type: "json" })
    ]);
    for (const beach of rows) {
      entries.push({
        beach: beach,
        estimate: maps[0].get("flag:" + beach.id) || null,
        official: maps[1].get("official:" + beach.id) || null,
        distanceMi: location ? beach.distance_mi : null
      });
    }
  }
  const nowIso = new Date().toISOString();
  const html = renderListPage({
    entries: entries,
    nowIso: nowIso,
    sortedByProximity: !!location,
    // Same resolved location that sorted the rows above — the map centers on it
    // (browser "near" fix or Cloudflare IP estimate), so a first load with no
    // browser geolocation still opens on the visitor's area, not a fixed region.
    location: location,
    query: hasQuery ? query : "",
    hasMore: hasMore,
    near: (typeof nearParam === "string") ? nearParam : ""
  });
  // A home URL carrying an explicit "near" is fully URL-determined:
  // resolveUserLocation short-circuits on it and never reads request.cf, so the
  // response is location-independent per its cache key and safe for the Workers
  // Cache. That is exactly the path live search and the geo upgrade hammer, which
  // would otherwise cost one D1 LIKE plus a KV bulk read per keystroke. Without a
  // near param the page is personalized by request.cf, which is not in the cache
  // key and not expressible via Vary, so it must stay no-store.
  const cacheControl = (nearParam !== null && nearParam !== undefined)
    ? CACHE_CONTROL_CACHEABLE
    : CACHE_CONTROL_NO_STORE;
  return htmlResponse(html, 200, cacheControl);
}

async function handleDetail(env, ctx, beachId) {
  const beach = await env.DB.prepare("SELECT * FROM beaches WHERE id = ?1").bind(beachId).first();
  // A confirmed-inland beach (or a parked-unresolved one) is not flag-worthy,
  // so it 404s exactly like a missing row — the same gate the home list uses.
  if (!beach || !isFlagWorthyWater(beach)) {
    const html = renderErrorPage({ status: 404, message: "Beach not found" });
    return htmlResponse(html, 404, CACHE_CONTROL_NO_STORE);
  }
  touchLastViewed(env, ctx, beach);
  // The 24 h wave-forecast series and the NDBC water-temperature reading are
  // both detail-page-only reads (the list page must never gain a per-row KV
  // get). Fetched alongside the flag/official reads so the extra keys cost no
  // added latency.
  const results = await Promise.all([
    readFlagAndOfficial(env, beachId),
    env.FLAGS.get("waves:" + beachId, { type: "json" }),
    env.FLAGS.get("watertemp:" + beachId, { type: "json" })
  ]);
  const data = results[0];
  const waves = results[1];
  const waterTemp = results[2];
  const nowIso = new Date().toISOString();
  const html = renderDetailPage({
    beach: beach,
    estimate: data.estimate,
    official: data.official,
    waves: waves,
    waterTemp: waterTemp,
    nowIso: nowIso
  });
  return htmlResponse(html, 200, CACHE_CONTROL_CACHEABLE);
}

// Cacheable GeoJSON directory of every flag-worthy beach: the homepage map
// fetches it once on load and hands it to a native MapLibre clustered GeoJSON
// source. Location-independent, so fully cacheable, and it reads only D1 and KV.
// Each feature is a Point [lon, lat] carrying { id, name, flag }, where flag is
// the collapsed color keyword (green|yellow|red|unknown, double-red collapsing to
// red) the browser keys its icon tint off. Beaches with non-finite coordinates
// are skipped so no NaN coordinate is emitted. No LIMIT: the full flag-worthy set
// is a few hundred KB and the 60 s edge cache absorbs the cost. A server
// clustering or paging story is needed before the 10k-100k North America scaling
// target (see PLAN.md / TODO.md).
async function handleBeachesGeojson(env) {
  const result = await env.DB.prepare(
    "SELECT id, name, park_name, lat, lon FROM beaches WHERE " + FLAG_WORTHY_WATER_SQL
  ).all();
  const rows = result.results || [];
  // Drop non-finite-coordinate rows BEFORE the KV flag reads: only finite-coord
  // rows become features, so filtering first means attachFeatureFlags never
  // spends a bulk-get key on a row that would be discarded anyway.
  const finite = [];
  for (let i = 0; i < rows.length; i = i + 1) {
    const row = rows[i];
    const lat = (row.lat === null || row.lat === undefined) ? NaN : Number(row.lat);
    const lon = (row.lon === null || row.lon === undefined) ? NaN : Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    row.lat = lat;
    row.lon = lon;
    finite.push(row);
  }
  // Same "now" the detail page's title flag is rendered against: the marker
  // color rule is staleness-aware (render.js displayFlagColor), so it needs one.
  await attachFeatureFlags(env, finite, new Date().toISOString());
  const features = [];
  for (let i = 0; i < finite.length; i = i + 1) {
    const row = finite[i];
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [row.lon, row.lat] },
      properties: {
        id: row.id,
        // Retained for a possible future hover/popup label; the current
        // clustered-map client does not read it.
        name: row.park_name || row.name || "",
        flag: row.flag
      }
    });
  }
  // application/geo+json is the RFC 7946 media type (the client sends a matching
  // Accept). Build the Response by hand so the content-type is set while keeping
  // the same cacheable policy the other request-path routes use.
  const body = JSON.stringify({ type: "FeatureCollection", features: features });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/geo+json; charset=utf-8",
      "cache-control": CACHE_CONTROL_CACHEABLE
    }
  });
}

// Bulk-reads flag: and official: KV for every row and stamps the collapsed color
// keyword onto row.flag in place. nowIso feeds markerFlagColor's staleness gate,
// where an aged point-in-time official reading may be raised by a fresher, more
// severe estimate (see render.js displayFlagColor). Chunked to the 100-key
// bulk-get ceiling and read in parallel, scaling linearly with row count. A
// missing or expired KV value maps to the honest "unknown" keyword, never a green
// default.
async function attachFeatureFlags(env, rows, nowIso) {
  if (!rows || rows.length === 0) {
    return;
  }
  const chunks = [];
  for (let i = 0; i < rows.length; i = i + 100) {
    chunks.push(rows.slice(i, i + 100));
  }
  const reads = await Promise.all(chunks.map(function (chunk) {
    const flagKeys = chunk.map(function (row) { return "flag:" + row.id; });
    const officialKeys = chunk.map(function (row) { return "official:" + row.id; });
    return Promise.all([
      env.FLAGS.get(flagKeys, { type: "json" }),
      env.FLAGS.get(officialKeys, { type: "json" })
    ]);
  }));
  for (let i = 0; i < chunks.length; i = i + 1) {
    const flagMap = reads[i][0];
    const officialMap = reads[i][1];
    const chunk = chunks[i];
    for (let j = 0; j < chunk.length; j = j + 1) {
      const row = chunk[j];
      const estimate = flagMap.get("flag:" + row.id) || null;
      const official = officialMap.get("official:" + row.id) || null;
      row.flag = markerFlagColor(estimate, official, nowIso);
    }
  }
}

async function handleApiFlag(env, ctx, beachId) {
  const beach = await env.DB.prepare(
    "SELECT id, last_viewed, water_class, water_class_attempts FROM beaches WHERE id = ?1"
  ).bind(beachId).first();
  // A confirmed-inland (or parked-unresolved) beach 404s like a missing row,
  // matching the detail page and the flag-worthy gate on the list/map.
  if (!beach || !isFlagWorthyWater(beach)) {
    // Plain max-age (no stale-while-revalidate): a just-discovered beach
    // should stop 404ing within a minute, not linger stale for the SWR window.
    return Response.json(
      { error: "beach not found" },
      { status: 404, headers: { "cache-control": "public, max-age=60" } }
    );
  }
  touchLastViewed(env, ctx, beach);
  const data = await readFlagAndOfficial(env, beachId);
  return Response.json(
    { beachId: beachId, estimate: data.estimate, official: data.official },
    { status: 200, headers: { "cache-control": CACHE_CONTROL_CACHEABLE } }
  );
}

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  if (path === "/health") {
    return Response.json(
      { ok: true },
      { status: 200, headers: { "cache-control": CACHE_CONTROL_NO_STORE } }
    );
  }

  if (path === "/") {
    return handleHome(
      env,
      resolveUserLocation(request, url),
      url.searchParams.get("q"),
      url.searchParams.get("near")
    );
  }

  if (path === "/api/beaches.geojson") {
    return handleBeachesGeojson(env);
  }

  const flagMatch = path.match(/^\/api\/flag\/([^/]+)$/);
  if (flagMatch) {
    const beachId = decodeURIComponent(flagMatch[1]);
    return handleApiFlag(env, ctx, beachId);
  }

  const detailMatch = path.match(/^\/beach\/([^/]+)$/);
  if (detailMatch) {
    const beachId = decodeURIComponent(detailMatch[1]);
    return handleDetail(env, ctx, beachId);
  }

  if (path.indexOf("/api/") === 0) {
    return Response.json(
      { error: "not found" },
      { status: 404, headers: { "cache-control": CACHE_CONTROL_NO_STORE } }
    );
  }

  const html = renderErrorPage({ status: 404, message: "Not found" });
  return htmlResponse(html, 404, CACHE_CONTROL_NO_STORE);
}
