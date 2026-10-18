import { renderListPage, renderDetailPage, renderErrorPage } from "./frontend/render.js";
import { renderApiDocsPage } from "./frontend/apiDocs.js";
import { distanceMi } from "./geo.js";
import { FLAG_WORTHY_WATER_SQL, isFlagWorthyWater } from "./waterClass.js";
import { mapFeatureFromRow } from "./mapFeatures.js";
import { displayFlag } from "./displayFlag.js";
import { strongEtag, etaggedResponse } from "./etag.js";
import { toPublicId, fromPublicId, fromLegacyId, parseAnyBeachId } from "./publicId.js";
import { CACHE_CONTROL_CACHEABLE, CACHE_CONTROL_NO_STORE } from "./cacheControl.js";
import { isApiPath, withApiCors, apiPreflightResponse } from "./apiCors.js";
import { OPENAPI_PATH, handleOpenApi } from "./openapi.js";
import {
  escapeLike,
  parseBeachIds,
  parseNearParam,
  proximityOrderByClause,
  queryBeachList,
  queryBeachesByIds
} from "./beachQueries.js";
import {
  handleApiBeaches,
  beachDisplayName,
  beachLinks,
  apiCoord,
  listAlternateHref,
  alternateLinkHeader,
  newestLiveEstimateUpdated,
  JSON_CONTENT_TYPE
} from "./apiBeaches.js";
import {
  BEACH_STATE_SELECT,
  CHIP_STATE_SELECT,
  WAVE_STATE_SELECT,
  BEACH_STATE_JOIN,
  liveBeachState,
  liveChipState,
  liveWaveRecord
} from "./beachState.js";

// Re-exported so existing importers keep working.
export { distanceMi, escapeLike, parseBeachIds };

// Per-location KV cache for the watertemp: read. The key has one 6-hourly
// writer, is display-only, and the tile gates on observedIso, so an hour of
// edge caching (negative lookups included) cannot show a reading as fresher than
// it is.
const WATERTEMP_KV_CACHE_TTL_SECONDS = 3600;

// Throttle for the last_viewed demand stamp: at most one D1 write per beach per
// hour. The enrichment crons order their candidate queues with last_viewed as a
// tiebreak, and the two beach-walking crons split their rotation into a hot tier
// (viewed within HOT_VIEW_WINDOW_MS, covered every run) and a cold tier, so an
// hourly stamp is finer than any of them need.
const LAST_VIEWED_MIN_INTERVAL_MS = 3600000;

// User location for proximity sorting: the "near" query param (lat,lon —
// deterministic override for dev and tests) wins over Cloudflare's IP-derived
// request.cf.latitude/longitude (strings; absent in local dev and behind some
// VPNs). Returns { lat, lon } or null; null means keep alphabetical order.
export function resolveUserLocation(request, url) {
  const nearParam = url.searchParams.get("near");
  if (nearParam !== null) {
    return parseNearParam(nearParam);
  }
  const cf = request.cf || {};
  const lat = Number(cf.latitude);
  const lon = Number(cf.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return { lat: lat, lon: lon };
  }
  return null;
}

// linkHeader is an optional HTTP Link value, the header twin of the page's
// rel="alternate" <link>.
function htmlResponse(html, status, cacheControl, linkHeader) {
  const headers = { "content-type": "text/html; charset=utf-8" };
  if (cacheControl) {
    headers["cache-control"] = cacheControl;
  }
  if (linkHeader) {
    headers["link"] = linkHeader;
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

// The beach row plus its derived state in one read. beach_state's column names
// are all distinct from beaches', so the WHERE clause stays unqualified; only
// the splat needs the alias.
//
// The detail route is one of the two readers of the wave record, so it carries
// WAVE_STATE_SELECT on top: the 24 h series it draws rides the same read. The
// list surfaces read through src/beachQueries.js instead, which the JSON API
// shares.
const BEACH_WITH_STATE_FROM =
  "SELECT b.*, " + BEACH_STATE_SELECT + ", " + WAVE_STATE_SELECT +
  " FROM beaches b" + BEACH_STATE_JOIN;

// alternateHref is the /api/beaches URL this page's own URL corresponds to,
// advertised as a <link rel="alternate"> and the matching Link header.
async function handleHome(env, location, rawQuery, nearParam, alternateHref) {
  const query = (typeof rawQuery === "string") ? rawQuery.trim() : "";
  const hasQuery = query.length > 0;
  const list = await queryBeachList(env, location, query);
  // Resolved after the slice: the proximity branch ranks five times what it
  // renders, and only the rendered rows need a chip.
  const nowMs = Date.now();
  const entries = [];
  for (const beach of list.rows) {
    const state = liveChipState(beach, nowMs);
    entries.push({
      beach: beach,
      estimate: state.estimate,
      official: state.official,
      distanceMi: location ? beach.distance_mi : null
    });
  }
  const nowIso = new Date(nowMs).toISOString();
  const html = renderListPage({
    entries: entries,
    nowIso: nowIso,
    sortedByProximity: !!location,
    // Same resolved location that sorted the rows above — the map centers on it
    // (browser "near" fix or Cloudflare IP estimate), so a first load with no
    // browser geolocation still opens on the visitor's area, not a fixed region.
    location: location,
    query: hasQuery ? query : "",
    hasMore: list.hasMore,
    near: (typeof nearParam === "string") ? nearParam : "",
    alternateHref: alternateHref
  });
  // A home URL carrying an explicit "near" is fully URL-determined:
  // resolveUserLocation short-circuits on it and never reads request.cf, so the
  // response is location-independent per its cache key and safe for the Workers
  // Cache. That is exactly the path live search and the geo upgrade hammer, which
  // would otherwise cost one D1 read per keystroke. Without a near param the page
  // is personalized by request.cf, which is not in the cache key and not
  // expressible via Vary, so it must stay no-store.
  const cacheControl = (nearParam !== null && nearParam !== undefined)
    ? CACHE_CONTROL_CACHEABLE
    : CACHE_CONTROL_NO_STORE;
  return htmlResponse(html, 200, cacheControl, alternateLinkHeader(alternateHref));
}

// GET /?ids=a,b,c — the same list page rendered for exactly those beaches, in
// the order asked for. It is what the browser-side "Your Beaches" section
// fetches for a visitor's saved and recently viewed ids, so it deliberately
// ignores q, near and request.cf: the response is fully URL-determined and
// therefore cacheable, and it holds nothing about the visitor beyond the ids
// the URL already carries. Unknown and non-flag-worthy ids are skipped
// silently, and no last_viewed stamp is written — only the two single-beach
// routes carry the demand signal.
async function handleIdsList(env, idsParam, alternateHref) {
  const ordered = await queryBeachesByIds(env, parseBeachIds(idsParam));
  const nowMs = Date.now();
  const entries = [];
  for (const beach of ordered) {
    const state = liveChipState(beach, nowMs);
    entries.push({
      beach: beach,
      estimate: state.estimate,
      official: state.official,
      distanceMi: null
    });
  }
  const html = renderListPage({
    entries: entries,
    nowIso: new Date(nowMs).toISOString(),
    sortedByProximity: false,
    location: null,
    query: "",
    hasMore: false,
    near: "",
    idsMode: true,
    alternateHref: alternateHref
  });
  return htmlResponse(html, 200, CACHE_CONTROL_CACHEABLE, alternateLinkHeader(alternateHref));
}

// Nearby cards on the detail page. A lat/lon window derived from NEARBY_MAX_MI
// lets D1 seek idx_beaches_lon_lat instead of scanning the table; the index
// leads with lon, so it is the lon predicate that seeks and a lat-only query
// scans. The planar ORDER BY then picks the NEARBY_FETCH_LIMIT nearest inside
// the window, the JS haversine decides the final order, and NEARBY_LIMIT of them
// render. NEARBY_MAX_MI drops the far tail so a lone beach never advertises
// "nearby" beaches a day's drive away; a beach with nothing inside it simply
// gets no section.
const NEARBY_FETCH_LIMIT = 12;
const NEARBY_LIMIT = 3;
const NEARBY_MAX_MI = 50;
// Under the 69.09 mi haversine degree, so the window rounds outward.
const MILES_PER_DEG_LAT = 69.0;

// The bounding box the nearby query seeks, { latLo, latHi, lonLo, lonHi }, or
// null when lat or lon is not finite. The box is a superset of the NEARBY_MAX_MI
// great-circle cap through 82 degrees of latitude, and REGIONS tops out at
// 67.2 N. lonLo and lonHi are null, dropping the lon predicate rather than
// wrapping it, when the window touches +-180 or the cap nears the pole; that
// beach pays the full scan. Pure; exported for tests.
export function nearbyBounds(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  const latSpan = NEARBY_MAX_MI / MILES_PER_DEG_LAT;
  const cosLat = Math.cos(lat * Math.PI / 180);
  const lonSpan = latSpan / cosLat;
  const bounds = { latLo: lat - latSpan, latHi: lat + latSpan, lonLo: null, lonHi: null };
  if (cosLat > 0 && Number.isFinite(lonSpan) && lonSpan < 180 &&
      lon - lonSpan >= -180 && lon + lonSpan <= 180) {
    bounds.lonLo = lon - lonSpan;
    bounds.lonHi = lon + lonSpan;
  }
  return bounds;
}

// The NEARBY_LIMIT nearest flag-worthy beaches to the beach, each carrying its
// distance and its own estimate and official, so the card resolves through
// displayFlag exactly as a list row does, or [] when none lies within
// NEARBY_MAX_MI or the coordinates are unusable. The beach's own row is excluded
// in SQL and again here, since the second guard costs nothing and keeps a stale
// id-less row out.
async function nearbyBeaches(env, beach, nowMs) {
  const orderBy = proximityOrderByClause({ lat: beach.lat, lon: beach.lon });
  const bounds = nearbyBounds(Number(beach.lat), Number(beach.lon));
  if (orderBy === null || bounds === null) {
    return [];
  }
  const withLon = bounds.lonLo !== null;
  const prepared = env.DB.prepare(
    "SELECT b.id, b.name, b.park_name, b.lat, b.lon, b.water_class, b.water_class_attempts, " +
    CHIP_STATE_SELECT + " FROM beaches b" + BEACH_STATE_JOIN + " WHERE " +
    FLAG_WORTHY_WATER_SQL + " AND id <> ?1 AND lat BETWEEN ?2 AND ?3" +
    (withLon ? " AND lon BETWEEN ?4 AND ?5" : "") +
    " ORDER BY " + orderBy + " LIMIT " + String(NEARBY_FETCH_LIMIT)
  );
  const stmt = withLon
    ? prepared.bind(beach.id, bounds.latLo, bounds.latHi, bounds.lonLo, bounds.lonHi)
    : prepared.bind(beach.id, bounds.latLo, bounds.latHi);
  const result = await stmt.all();
  const rows = (result && result.results) || [];
  const scored = [];
  for (const row of rows) {
    if (!row || row.id === beach.id) {
      continue;
    }
    const miles = distanceMi(beach.lat, beach.lon, row.lat, row.lon);
    if (!Number.isFinite(miles) || miles > NEARBY_MAX_MI) {
      continue;
    }
    scored.push({ beach: row, distanceMi: miles });
  }
  scored.sort(function (a, b) { return a.distanceMi - b.distanceMi; });
  const nearest = scored.slice(0, NEARBY_LIMIT);
  for (const entry of nearest) {
    const state = liveChipState(entry.beach, nowMs);
    entry.estimate = state.estimate;
    entry.official = state.official;
  }
  return nearest;
}

async function handleDetail(env, ctx, beachId) {
  const beach = await env.DB.prepare(
    BEACH_WITH_STATE_FROM + " WHERE b.id = ?1"
  ).bind(beachId).first();
  // A confirmed-inland beach (or a parked-unresolved one) is not flag-worthy,
  // so it 404s exactly like a missing row — the same gate the home list uses.
  if (!beach || !isFlagWorthyWater(beach)) {
    return detailNotFound();
  }
  touchLastViewed(env, ctx, beach);
  const nowMs = Date.now();
  // The estimate, the official flag, the water-quality advisory, the
  // point-in-time reading and the 24 h wave series all came back on the row
  // above. The NDBC water temperature and the nearby-beach rows are the detail
  // page's only extra reads: the list page must never gain a per-row KV get, and
  // /api/flag must not gain the advisory or the series.
  const results = await Promise.all([
    env.FLAGS.get("watertemp:" + beachId, {
      type: "json",
      cacheTtl: WATERTEMP_KV_CACHE_TTL_SECONDS
    }),
    nearbyBeaches(env, beach, nowMs)
  ]);
  const state = liveBeachState(beach, nowMs);
  const alternateHref = beachLinks(beachId).api;
  const html = renderDetailPage({
    beach: beach,
    estimate: state.estimate,
    official: state.official,
    waves: liveWaveRecord(beach, nowMs),
    waterTemp: results[0],
    reading: state.reading,
    wqfloor: state.wqfloor,
    tides: state.tides,
    nearby: results[1],
    nowIso: new Date(nowMs).toISOString(),
    alternateHref: alternateHref
  });
  return htmlResponse(html, 200, CACHE_CONTROL_CACHEABLE, alternateLinkHeader(alternateHref));
}

function detailNotFound() {
  const html = renderErrorPage({ status: 404, message: "Beach not found" });
  return htmlResponse(html, 404, CACHE_CONTROL_NO_STORE);
}

// Scalar columns only: the marker color is resolved from the estimate's and the
// official's color, updated stamp and expiry, never from their JSON blobs.
const MAP_FEATURE_SQL =
  "SELECT b.id, b.name, b.park_name, b.lat, b.lon, " + CHIP_STATE_SELECT +
  " FROM beaches b" + BEACH_STATE_JOIN + " WHERE " + FLAG_WORTHY_WATER_SQL;

// Cacheable GeoJSON directory of every flag-worthy beach: the homepage map
// fetches it once on load and hands it to one MapLibre GeoJSON source, drawn as
// a coast highlight when zoomed out and as flag icons from zoom 9 up.
// Location-independent, so fully cacheable.
//
// One D1 read, resolved per row through displayFlag, the decision every surface
// that shows a beach's flag makes, so no two surfaces can disagree about a
// beach. builtAt — the freshest live estimate on the map — rides along
// as a top-level GeoJSON foreign member (RFC 7946 section 6.1) so a dead hourly
// is visible to anyone hitting the endpoint. A D1 failure surfaces as the error
// boundary's 500, never as a silently all-unknown map.
//
// The body is the validator: its SHA-256 is the ETag, and a matching
// If-None-Match answers 304. There is no D1 shortcut before the hash, since no
// stored timestamp moves with every write that changes a marker.
async function handleBeachesGeojson(env, ifNoneMatch) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const result = await env.DB.prepare(MAP_FEATURE_SQL).all();
  const rows = (result && result.results) || [];
  const features = [];
  const mapped = [];
  for (let i = 0; i < rows.length; i = i + 1) {
    const row = rows[i];
    const feature = mapFeatureFromRow(row, nowIso, nowMs);
    if (feature === null) {
      continue;
    }
    features.push(feature);
    mapped.push(row);
  }
  const payload = {
    type: "FeatureCollection",
    builtAt: newestLiveEstimateUpdated(mapped, nowMs),
    features: features
  };
  // Hashed and sent as the same bytes, so the tag is byte-exact for the body.
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const etag = await strongEtag(bytes);
  // application/geo+json is the RFC 7946 media type (the client sends a
  // matching Accept).
  return etaggedResponse(bytes, etag, "application/geo+json; charset=utf-8",
    CACHE_CONTROL_CACHEABLE, ifNoneMatch);
}

// GET /api/beaches/:beachId and its alias /api/flag/:beachId: one handler, so
// the two answer identical bodies.
// The body is its own validator, as on the list: no field in it is the request
// instant, so the strong ETag moves exactly when the bytes do — a lease running
// out or an official going stale included, which a Last-Modified built from the
// records' updated stamps would miss.
async function handleApiBeach(env, ctx, beachId, ifNoneMatch) {
  const beach = await env.DB.prepare(
    "SELECT b.id, b.name, b.park_name, b.lat, b.lon, b.last_viewed, b.water_class, " +
    "b.water_class_attempts, " +
    BEACH_STATE_SELECT + " FROM beaches b" + BEACH_STATE_JOIN + " WHERE b.id = ?1"
  ).bind(beachId).first();
  // A confirmed-inland (or parked-unresolved) beach 404s like a missing row,
  // matching the detail page and the flag-worthy gate on the list/map.
  if (!beach || !isFlagWorthyWater(beach)) {
    return apiFlagNotFound();
  }
  touchLastViewed(env, ctx, beach);
  const nowMs = Date.now();
  const state = liveBeachState(beach, nowMs);
  const flag = displayFlag(state, new Date(nowMs).toISOString());
  const payload = {
      // The public id. The estimate and official blobs are stored records, so
      // their own nested beachId stays the storage id.
      beachId: toPublicId(beachId),
      name: beachDisplayName(beach),
      lat: apiCoord(beach.lat),
      lon: apiCoord(beach.lon),
      estimate: state.estimate,
      official: state.official,
      // Built field by field so no internal decision field reaches the public shape.
      display: { color: flag.color, source: flag.source, forecast: flag.forecast },
      links: beachLinks(beachId)
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const etag = await strongEtag(bytes);
  return etaggedResponse(bytes, etag, JSON_CONTENT_TYPE, CACHE_CONTROL_CACHEABLE, ifNoneMatch);
}

// Plain max-age (no stale-while-revalidate): a just-discovered beach should
// stop 404ing within a minute, not linger stale for the SWR window.
function apiFlagNotFound() {
  return Response.json(
    { error: "beach not found" },
    { status: 404, headers: { "cache-control": "public, max-age=60" } }
  );
}

// A permanent redirect from a beach's storage-form URL to its canonical public
// one. Neither single-beach route reads a query string, so the target is the
// whole of what the request asked for. It is cacheable like the page it names:
// the mapping is fixed, so no visitor needs to ask twice.
function canonicalRedirect(location) {
  return new Response(null, {
    status: 301,
    headers: {
      "location": location,
      "cache-control": CACHE_CONTROL_CACHEABLE
    }
  });
}

// The request's If-None-Match, tolerating a request object with no headers.
function ifNoneMatchOf(request) {
  return (request.headers && typeof request.headers.get === "function")
    ? request.headers.get("if-none-match")
    : null;
}

function apiNotFound() {
  return Response.json(
    { error: "not found" },
    { status: 404, headers: { "cache-control": CACHE_CONTROL_NO_STORE } }
  );
}

// The single-beach API routes, /api/beaches/:id and its alias /api/flag/:id,
// matched on the segment after prefix. A public-form segment is served, a
// storage-form one is redirected to the canonical URL under the same prefix.
// Returns null when the path is not under prefix.
function routeApiBeach(path, prefix, env, ctx, ifNoneMatch) {
  if (path.indexOf(prefix) !== 0) {
    return null;
  }
  const segment = path.slice(prefix.length);
  if (segment.length === 0 || segment.indexOf("/") !== -1) {
    return null;
  }
  const publicId = fromPublicId(segment);
  if (publicId !== null) {
    return handleApiBeach(env, ctx, publicId, ifNoneMatch);
  }
  const legacyId = fromLegacyId(segment);
  if (legacyId !== null) {
    return canonicalRedirect(prefix + toPublicId(legacyId));
  }
  return apiFlagNotFound();
}

async function routeApi(request, method, env, ctx, url) {
  const path = url.pathname;
  if (method === "OPTIONS") {
    return apiPreflightResponse();
  }
  if (method !== "GET") {
    return methodNotAllowed();
  }
  if (path === "/api") {
    return canonicalRedirect("/api/");
  }
  if (path === "/api/") {
    const html = renderApiDocsPage({ nowIso: new Date().toISOString() });
    const docs = htmlResponse(html, 200, CACHE_CONTROL_CACHEABLE);
    // RFC 8631: the machine-readable description of the API this page documents.
    docs.headers.set("link", "<" + OPENAPI_PATH + ">; rel=\"service-desc\"; type=\"application/json\"");
    return docs;
  }
  if (path === OPENAPI_PATH) {
    return handleOpenApi(ifNoneMatchOf(request));
  }
  if (path === "/api/beaches") {
    return handleApiBeaches(env, url.searchParams, ifNoneMatchOf(request));
  }
  if (path === "/api/beaches.geojson") {
    return handleBeachesGeojson(env, ifNoneMatchOf(request));
  }
  // The segment is matched raw. Neither id form has anything
  // encodeURIComponent changes, so a segment that needs decoding is not an id,
  // and decodeURIComponent would throw URIError on a bad escape (/beach/%FF)
  // and turn into the boundary's 500. A segment in the public form resolves to
  // its storage id and is served; one in the storage form is redirected to the
  // canonical URL, so one beach is never served under two.
  const beachRoute = routeApiBeach(path, "/api/beaches/", env, ctx, ifNoneMatchOf(request)) ||
    routeApiBeach(path, "/api/flag/", env, ctx, ifNoneMatchOf(request));
  if (beachRoute !== null) {
    return beachRoute;
  }
  return apiNotFound();
}

function methodNotAllowed() {
  return new Response("Method not allowed", {
    status: 405,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": CACHE_CONTROL_NO_STORE
    }
  });
}

// HEAD is GET without the body (RFC 9110 section 9.3.2): the same status and
// headers, ETag and 304 included, from the same handlers. It is not a view, so
// it runs without ctx and the single-beach routes write no last_viewed stamp.
export async function handleRequest(request, env, ctx) {
  if (request.method === "HEAD") {
    const response = await dispatchRequest(request, "GET", env, null);
    return new Response(null, { status: response.status, headers: response.headers });
  }
  return dispatchRequest(request, request.method, env, ctx);
}

async function dispatchRequest(request, method, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Every /api/* response, whatever its status, carries the CORS headers, and
  // an OPTIONS preflight there answers 204; nothing outside /api/ answers one.
  if (isApiPath(path)) {
    return withApiCors(await routeApi(request, method, env, ctx, url));
  }

  if (method !== "GET") {
    return methodNotAllowed();
  }

  if (path === "/health") {
    return Response.json(
      { ok: true },
      { status: 200, headers: { "cache-control": CACHE_CONTROL_NO_STORE } }
    );
  }

  if (path === "/") {
    const alternateHref = listAlternateHref(url.searchParams);
    const idsParam = url.searchParams.get("ids");
    if (idsParam !== null) {
      return handleIdsList(env, idsParam, alternateHref);
    }
    return handleHome(
      env,
      resolveUserLocation(request, url),
      url.searchParams.get("q"),
      url.searchParams.get("near"),
      alternateHref
    );
  }

  // /beach/<id>.json is a permanent redirect into the API, never a second
  // representation of the page: nothing is content-negotiated on Accept,
  // because the edge cache ignores Vary and a browser's back/forward cache can
  // show a fetch()'s JSON for a page URL. Either id form is accepted before the
  // .json; the API decides whether the beach exists. It carries the CORS
  // headers too, since a cross-origin fetch checks every redirect hop.
  const jsonMatch = path.match(/^\/beach\/([^/]+)\.json$/);
  if (jsonMatch) {
    const jsonId = parseAnyBeachId(jsonMatch[1]);
    if (jsonId !== null) {
      return withApiCors(canonicalRedirect(beachLinks(jsonId).api));
    }
    return withApiCors(apiFlagNotFound());
  }

  const detailMatch = path.match(/^\/beach\/([^/]+)$/);
  if (detailMatch) {
    const detailId = fromPublicId(detailMatch[1]);
    if (detailId !== null) {
      return handleDetail(env, ctx, detailId);
    }
    const legacyDetailId = fromLegacyId(detailMatch[1]);
    if (legacyDetailId !== null) {
      return canonicalRedirect("/beach/" + toPublicId(legacyDetailId));
    }
    return detailNotFound();
  }

  const html = renderErrorPage({ status: 404, message: "Not found" });
  return htmlResponse(html, 404, CACHE_CONTROL_NO_STORE);
}
