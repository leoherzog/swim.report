import { renderListPage, renderDetailPage, renderErrorPage } from "./frontend/render.js";

const HOME_LIST_LIMIT = 100;
const API_BEACHES_LIMIT = 500;
// When sorting by proximity we need every candidate row before slicing to
// HOME_LIST_LIMIT, so the fetch bound is wider than the display bound.
const HOME_GEO_FETCH_LIMIT = 500;

const EARTH_RADIUS_MI = 3958.8;

function toRadians(deg) {
  return deg * Math.PI / 180;
}

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

// Great-circle distance (haversine) in statute miles. Pure; exported for tests.
export function distanceMi(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
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

function jsonResponse(body, status, extraHeaders) {
  const headers = Object.assign(
    { "content-type": "application/json" },
    extraHeaders || {}
  );
  return new Response(JSON.stringify(body), { status: status, headers: headers });
}

function htmlResponse(html, status) {
  return new Response(html, {
    status: status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function parseBbox(bboxParam) {
  if (!bboxParam) {
    return null;
  }
  const parts = bboxParam.split(",");
  if (parts.length !== 4) {
    return null;
  }
  const nums = parts.map(function (p) { return Number(p); });
  for (const n of nums) {
    if (!Number.isFinite(n)) {
      return null;
    }
  }
  const bbox = { minLon: nums[0], minLat: nums[1], maxLon: nums[2], maxLat: nums[3] };
  if (bbox.minLon >= bbox.maxLon || bbox.minLat >= bbox.maxLat) {
    return null;
  }
  return bbox;
}

async function readFlagAndOfficial(env, beachId) {
  const estimate = await env.FLAGS.get("flag:" + beachId, { type: "json" });
  const official = await env.FLAGS.get("official:" + beachId, { type: "json" });
  return { estimate: estimate, official: official };
}

// Optional ?q= search covers the ENTIRE beaches table, not just the rendered
// rows: a case-insensitive LIKE against both the display name
// (COALESCE(park_name, name)) and the beach's own name, with user wildcards
// escaped. When a user location resolves we filter first, then distance-sort
// the matches, so proximity ordering is preserved for searches too. Stays on
// the request path's D1+KV-only contract.
const LIKE_WHERE =
  " WHERE (COALESCE(park_name, name) LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\')";

async function handleHome(env, location, rawQuery, nearParam) {
  const query = (typeof rawQuery === "string") ? rawQuery.trim() : "";
  const hasQuery = query.length > 0;
  const pattern = hasQuery ? "%" + escapeLike(query) + "%" : null;
  let rows;
  let hasMore = false;
  if (location) {
    let stmt;
    if (hasQuery) {
      stmt = env.DB.prepare(
        "SELECT * FROM beaches" + LIKE_WHERE + " LIMIT " + String(HOME_GEO_FETCH_LIMIT)
      ).bind(pattern);
    } else {
      stmt = env.DB.prepare("SELECT * FROM beaches LIMIT " + String(HOME_GEO_FETCH_LIMIT));
    }
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
    let stmt;
    if (hasQuery) {
      stmt = env.DB.prepare(
        "SELECT * FROM beaches" + LIKE_WHERE +
        " ORDER BY COALESCE(park_name, name), name LIMIT " + String(detectLimit)
      ).bind(pattern);
    } else {
      stmt = env.DB.prepare(
        "SELECT * FROM beaches ORDER BY COALESCE(park_name, name), name LIMIT " +
        String(detectLimit)
      );
    }
    const result = await stmt.all();
    rows = result.results || [];
    hasMore = rows.length > HOME_LIST_LIMIT;
    if (hasMore) {
      rows = rows.slice(0, HOME_LIST_LIMIT);
    }
  }
  const entries = [];
  for (const beach of rows) {
    const data = await readFlagAndOfficial(env, beach.id);
    entries.push({
      beach: beach,
      estimate: data.estimate,
      official: data.official,
      distanceMi: location ? beach.distance_mi : null
    });
  }
  const nowIso = new Date().toISOString();
  const html = renderListPage({
    entries: entries,
    nowIso: nowIso,
    sortedByProximity: !!location,
    query: hasQuery ? query : "",
    hasMore: hasMore,
    near: (typeof nearParam === "string") ? nearParam : ""
  });
  return htmlResponse(html, 200);
}

async function handleDetail(env, beachId) {
  const beach = await env.DB.prepare("SELECT * FROM beaches WHERE id = ?1").bind(beachId).first();
  if (!beach) {
    const html = renderErrorPage({ status: 404, message: "Beach not found" });
    return htmlResponse(html, 404);
  }
  const data = await readFlagAndOfficial(env, beachId);
  const nowIso = new Date().toISOString();
  const html = renderDetailPage({
    beach: beach,
    estimate: data.estimate,
    official: data.official,
    nowIso: nowIso
  });
  return htmlResponse(html, 200);
}

async function handleApiBeaches(env, url) {
  const bboxParam = url.searchParams.get("bbox");
  const bbox = parseBbox(bboxParam);
  if (bbox === null) {
    return jsonResponse({ error: "invalid bbox" }, 400, {});
  }
  const result = await env.DB.prepare(
    "SELECT id,name,park_name,lat,lon,nws_zone,osm_id FROM beaches WHERE lon >= ?1 AND lon <= ?3 " +
    "AND lat >= ?2 AND lat <= ?4 LIMIT " + String(API_BEACHES_LIMIT)
  ).bind(bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat).all();
  const rows = result.results || [];
  return jsonResponse({ beaches: rows }, 200, { "cache-control": "public, max-age=60" });
}

async function handleApiFlag(env, beachId) {
  const beach = await env.DB.prepare("SELECT id FROM beaches WHERE id = ?1").bind(beachId).first();
  if (!beach) {
    return jsonResponse({ error: "beach not found" }, 404, { "cache-control": "public, max-age=60" });
  }
  const data = await readFlagAndOfficial(env, beachId);
  return jsonResponse(
    { beachId: beachId, estimate: data.estimate, official: data.official },
    200,
    { "cache-control": "public, max-age=60" }
  );
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  if (path === "/health") {
    return jsonResponse({ ok: true }, 200, {});
  }

  if (path === "/") {
    return handleHome(
      env,
      resolveUserLocation(request, url),
      url.searchParams.get("q"),
      url.searchParams.get("near")
    );
  }

  if (path === "/api/beaches") {
    return handleApiBeaches(env, url);
  }

  const flagMatch = path.match(/^\/api\/flag\/([^/]+)$/);
  if (flagMatch) {
    const beachId = decodeURIComponent(flagMatch[1]);
    return handleApiFlag(env, beachId);
  }

  const detailMatch = path.match(/^\/beach\/([^/]+)$/);
  if (detailMatch) {
    const beachId = decodeURIComponent(detailMatch[1]);
    return handleDetail(env, beachId);
  }

  if (path.indexOf("/api/") === 0) {
    return jsonResponse({ error: "not found" }, 404, {});
  }

  const html = renderErrorPage({ status: 404, message: "Not found" });
  return htmlResponse(html, 404);
}
