import { renderListPage, renderDetailPage, renderErrorPage } from "./frontend/render.js";
import { distanceMi } from "./geo.js";
import { FLAG_WORTHY_WATER_SQL, isFlagWorthyWater } from "./waterClass.js";
import { IDS_LIST_LIMIT } from "./idsListLimit.js";
import { mapFeatureFromRow } from "./mapFeatures.js";
import { displayFlag } from "./displayFlag.js";
import { strongEtag, etagMatches } from "./etag.js";
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
export { distanceMi };

const HOME_LIST_LIMIT = 100;
// When sorting by proximity the fetch bound is wider than the display bound:
// SQL orders by an approximate planar distance and this cap keeps the nearest
// 500 of those, then the JS haversine re-sorts them and slices to
// HOME_LIST_LIMIT. Purely a safety cap on an already-ordered read.
const HOME_GEO_FETCH_LIMIT = 500;

// The id format discovery mints (src/discovery.js): "osm-" + node|way|relation
// + "-" + the OSM id. It gates ?ids= and the raw /beach/:id and /api/flag/:id
// path segment, which is never decoded, so anything else never reaches a bound
// parameter.
const BEACH_ID_PATTERN = /^osm-(node|way|relation)-\d+$/;

// Cache-control policy for the Workers Cache layer ([cache] in wrangler.toml).
// Every cacheable route is location-independent and its origin is one or two D1
// statements, so the stale-while-revalidate window is 60 s: Workers Cache serves
// stale asynchronously, which makes max-age + stale-while-revalidate (120 s) the
// bound on how old a served flag can be and so on flip latency. stale-if-error
// is set explicitly because Cloudflare's default on Worker error is to serve
// stale indefinitely, which would freeze the pages' embedded staleness warnings
// — nowIso is baked into the HTML — with no bound. The home page without near
// must never be cached: it is personalized by request.cf geolocation, which is
// not part of the cache key and not expressible via Vary.
const CACHE_CONTROL_CACHEABLE =
  "public, max-age=60, stale-while-revalidate=60, stale-if-error=600";
const CACHE_CONTROL_NO_STORE = "no-store";

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

// The valid, deduped beach ids in a comma-separated ?ids= value, in the order
// given and capped at IDS_LIST_LIMIT. Pure; exported for tests. Anything that
// is not a well-formed beach id is dropped, so the caller's list can never
// reach SQL as anything but a bound parameter.
export function parseBeachIds(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }
  const parts = raw.split(",");
  const ids = [];
  for (let i = 0; i < parts.length; i = i + 1) {
    const id = parts[i].trim();
    if (!BEACH_ID_PATTERN.test(id) || ids.indexOf(id) !== -1) {
      continue;
    }
    ids.push(id);
    if (ids.length === IDS_LIST_LIMIT) {
      break;
    }
  }
  return ids;
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

// Optional ?q= search covers the entire beaches table, not just the rendered
// rows: a case-insensitive LIKE against both the display name
// (COALESCE(park_name, name)) and the beach's own name, with user wildcards
// escaped. When a user location resolves, the filter runs first and the matches
// are then distance-sorted, so proximity ordering holds for searches too.
const LIKE_WHERE =
  " WHERE (COALESCE(park_name, name) LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\')";

// The beach row plus its derived state in one read. beach_state's column names
// are all distinct from beaches', so every WHERE, ORDER BY and LIKE clause below
// stays unqualified; only the splat needs the alias.
//
// The detail route is one of the two readers of the wave record, so it carries
// WAVE_STATE_SELECT on top: the 24 h series it draws rides the same read.
const BEACH_WITH_STATE_FROM =
  "SELECT b.*, " + BEACH_STATE_SELECT + ", " + WAVE_STATE_SELECT +
  " FROM beaches b" + BEACH_STATE_JOIN;

// The same read for the list surfaces, which render one displayFlag decision per
// row from the scalar mirror columns instead of the four JSON blobs.
// The proximity branch ranks HOME_GEO_FETCH_LIMIT rows to render
// HOME_LIST_LIMIT of them, so a blob here would cross the binding five times for
// every row a visitor sees.
const BEACH_WITH_CHIP_FROM =
  "SELECT b.*, " + CHIP_STATE_SELECT + " FROM beaches b" + BEACH_STATE_JOIN;

// Builds the beach-plus-state statement shared by both home-page branches: an
// optional LIKE_WHERE clause, an optional ORDER BY clause, and a caller-supplied
// LIMIT.
function buildHomeStatement(env, hasQuery, pattern, orderByClause, limit) {
  // Every home-page branch hides confirmed-inland (and parked-unresolved)
  // beaches via the canonical flag-worthy gate: AND it after the LIKE clause
  // when a query is present, use it as the WHERE otherwise.
  const where = hasQuery
    ? LIKE_WHERE + " AND " + FLAG_WORTHY_WATER_SQL
    : " WHERE " + FLAG_WORTHY_WATER_SQL;
  const order = orderByClause ? " ORDER BY " + orderByClause : "";
  const stmt = env.DB.prepare(
    BEACH_WITH_CHIP_FROM + where + order + " LIMIT " + String(limit)
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
  // Resolved after the slice above: the proximity branch ranks five times what
  // it renders, and only the rendered rows need a chip.
  const nowMs = Date.now();
  const entries = [];
  for (const beach of rows) {
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
    hasMore: hasMore,
    near: (typeof nearParam === "string") ? nearParam : ""
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
  return htmlResponse(html, 200, cacheControl);
}

// GET /?ids=a,b,c — the same list page rendered for exactly those beaches, in
// the order asked for. It is what the browser-side "Your Beaches" section
// fetches for a visitor's saved and recently viewed ids, so it deliberately
// ignores q, near and request.cf: the response is fully URL-determined and
// therefore cacheable, and it holds nothing about the visitor beyond the ids
// the URL already carries. Unknown and non-flag-worthy ids are skipped
// silently, and no last_viewed stamp is written — only the two single-beach
// routes carry the demand signal.
async function handleIdsList(env, idsParam) {
  const ids = parseBeachIds(idsParam);
  const ordered = [];
  if (ids.length > 0) {
    const placeholders = ids.map(function (id, index) { return "?" + String(index + 1); });
    const stmt = env.DB.prepare(
      BEACH_WITH_CHIP_FROM + " WHERE id IN (" + placeholders.join(", ") + ") AND " +
      FLAG_WORTHY_WATER_SQL
    );
    const result = await stmt.bind.apply(stmt, ids).all();
    const rows = (result && result.results) || [];
    // SQLite returns an IN-set in whatever order it likes, so the caller's
    // order is restored here rather than asked of the database.
    const byId = new Map();
    for (const row of rows) {
      byId.set(row.id, row);
    }
    for (const id of ids) {
      const row = byId.get(id);
      if (row) {
        ordered.push(row);
      }
    }
  }
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
    idsMode: true
  });
  return htmlResponse(html, 200, CACHE_CONTROL_CACHEABLE);
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
  const html = renderDetailPage({
    beach: beach,
    estimate: state.estimate,
    official: state.official,
    waves: liveWaveRecord(beach, nowMs),
    waterTemp: results[0],
    reading: state.reading,
    wqfloor: state.wqfloor,
    nearby: results[1],
    nowIso: new Date(nowMs).toISOString()
  });
  return htmlResponse(html, 200, CACHE_CONTROL_CACHEABLE);
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
  const nowEpoch = Math.floor(nowMs / 1000);
  const result = await env.DB.prepare(MAP_FEATURE_SQL).all();
  const rows = (result && result.results) || [];
  const features = [];
  let builtAt = null;
  let builtAtMs = -Infinity;
  for (let i = 0; i < rows.length; i = i + 1) {
    const row = rows[i];
    const feature = mapFeatureFromRow(row, nowIso, nowMs);
    if (feature === null) {
      continue;
    }
    features.push(feature);
    // Only an unexpired estimate dates the collection: an expired one resolved
    // to unknown above and says nothing about how fresh the map is.
    const expires = row.estimate_expires;
    const updatedMs = Date.parse(row.estimate_updated);
    if (typeof expires === "number" && expires > nowEpoch &&
        Number.isFinite(updatedMs) && updatedMs > builtAtMs) {
      builtAtMs = updatedMs;
      builtAt = row.estimate_updated;
    }
  }
  const payload = { type: "FeatureCollection", builtAt: builtAt, features: features };
  // Hashed and sent as the same bytes, so the tag is byte-exact for the body.
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const etag = await strongEtag(bytes);
  return geojsonResponse(bytes, etag, CACHE_CONTROL_CACHEABLE, ifNoneMatch);
}

// application/geo+json is the RFC 7946 media type (the client sends a matching
// Accept). Built by hand so the media type is set alongside the shared cacheable
// policy. The 200 carries the strong SHA-256 ETag over the body; an If-None-Match
// naming it (weak comparison, comma list and * honored) answers 304 with the same
// ETag and cache-control and no body. Cloudflare weakens the tag when it
// compresses the body, which is why the comparison ignores W/. No Vary: Workers
// Cache compares Vary values verbatim and would fragment the entry per
// Accept-Encoding spelling.
function geojsonResponse(bytes, etag, cacheControl, ifNoneMatch) {
  if (etagMatches(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: { "etag": etag, "cache-control": cacheControl }
    });
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "application/geo+json; charset=utf-8",
      "cache-control": cacheControl,
      "etag": etag
    }
  });
}

async function handleApiFlag(env, ctx, beachId) {
  const beach = await env.DB.prepare(
    "SELECT b.id, b.last_viewed, b.water_class, b.water_class_attempts, " +
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
  return Response.json(
    {
      beachId: beachId,
      estimate: state.estimate,
      official: state.official,
      // Built field by field so no internal decision field reaches the public shape.
      display: { color: flag.color, source: flag.source }
    },
    { status: 200, headers: { "cache-control": CACHE_CONTROL_CACHEABLE } }
  );
}

// Plain max-age (no stale-while-revalidate): a just-discovered beach should
// stop 404ing within a minute, not linger stale for the SWR window.
function apiFlagNotFound() {
  return Response.json(
    { error: "beach not found" },
    { status: 404, headers: { "cache-control": "public, max-age=60" } }
  );
}

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": CACHE_CONTROL_NO_STORE
      }
    });
  }

  if (path === "/health") {
    return Response.json(
      { ok: true },
      { status: 200, headers: { "cache-control": CACHE_CONTROL_NO_STORE } }
    );
  }

  if (path === "/") {
    const idsParam = url.searchParams.get("ids");
    if (idsParam !== null) {
      return handleIdsList(env, idsParam);
    }
    return handleHome(
      env,
      resolveUserLocation(request, url),
      url.searchParams.get("q"),
      url.searchParams.get("near")
    );
  }

  if (path === "/api/beaches.geojson") {
    return handleBeachesGeojson(env, request.headers.get("if-none-match"));
  }

  // The segment is matched raw. An id's alphabet has nothing
  // encodeURIComponent changes, so a segment that needs decoding is not an id,
  // and decodeURIComponent would throw URIError on a bad escape (/beach/%FF)
  // and turn into the boundary's 500.
  const flagMatch = path.match(/^\/api\/flag\/([^/]+)$/);
  if (flagMatch) {
    if (!BEACH_ID_PATTERN.test(flagMatch[1])) {
      return apiFlagNotFound();
    }
    return handleApiFlag(env, ctx, flagMatch[1]);
  }

  const detailMatch = path.match(/^\/beach\/([^/]+)$/);
  if (detailMatch) {
    if (!BEACH_ID_PATTERN.test(detailMatch[1])) {
      return detailNotFound();
    }
    return handleDetail(env, ctx, detailMatch[1]);
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
