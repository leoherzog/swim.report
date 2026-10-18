// src/beachQueries.js — the list reads the home page and GET /api/beaches share:
// one statement builder and one row-fetching function per list mode, so the
// HTML page and the JSON API can never disagree about which beaches a URL names
// or in what order. Request-path only: D1 reads, no fetch, no KV, no writes.
//
// Rows come back as the beaches row plus CHIP_STATE_SELECT's scalar mirror
// columns; each caller resolves them through liveChipState and displayFlag.
import { distanceMi } from "./geo.js";
import { FLAG_WORTHY_WATER_SQL } from "./waterClass.js";
import { IDS_LIST_LIMIT } from "./idsListLimit.js";
import { parseAnyBeachId } from "./publicId.js";
import { CHIP_STATE_SELECT, BEACH_STATE_JOIN } from "./beachState.js";

export const HOME_LIST_LIMIT = 100;
// When sorting by proximity the fetch bound is wider than the display bound:
// SQL orders by an approximate planar distance and this cap keeps the nearest
// 500 of those, then the JS haversine re-sorts them and slices to
// HOME_LIST_LIMIT. Purely a safety cap on an already-ordered read.
export const HOME_GEO_FETCH_LIMIT = 500;

// Escapes the LIKE wildcards (% and _) plus the escape character itself so a
// user's search term is matched literally, not as a pattern. The result is
// meant to be wrapped in "%" ... "%" and bound to a "LIKE ?n ESCAPE '\'"
// clause. Pure.
export function escapeLike(term) {
  return String(term)
    .split("\\").join("\\\\")
    .split("%").join("\\%")
    .split("_").join("\\_");
}

// The storage ids a comma-separated ?ids= value names, deduped, in the order
// given and capped at IDS_LIST_LIMIT — the cap counts accepted ids. Pure. Each
// part is read in either the public or the storage form, and anything else is
// dropped, so the caller's list can never reach SQL as anything but a bound
// parameter. The storage form is accepted without a redirect because a
// returning visitor's localStorage holds ids in it.
export function parseBeachIds(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }
  const parts = raw.split(",");
  const ids = [];
  for (let i = 0; i < parts.length; i = i + 1) {
    const id = parseAnyBeachId(parts[i].trim());
    if (id === null || ids.indexOf(id) !== -1) {
      continue;
    }
    ids.push(id);
    if (ids.length === IDS_LIST_LIMIT) {
      break;
    }
  }
  return ids;
}

// A "lat,lon" near value as { lat, lon }, or null unless it is exactly two
// finite numbers in range. Pure.
export function parseNearParam(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const parts = raw.split(",");
  if (parts.length !== 2 || parts[0].trim() === "" || parts[1].trim() === "") {
    return null;
  }
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (Number.isFinite(lat) && Number.isFinite(lon) &&
      lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
    return { lat: lat, lon: lon };
  }
  return null;
}

// Optional ?q= search covers the entire beaches table, not just the rendered
// rows: a case-insensitive LIKE against both the display name
// (COALESCE(park_name, name)) and the beach's own name, with user wildcards
// escaped. When a user location resolves, the filter runs first and the matches
// are then distance-sorted, so proximity ordering holds for searches too.
const LIKE_WHERE =
  " WHERE (COALESCE(park_name, name) LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\')";

// The beach row plus the scalar mirror columns its displayFlag decision needs,
// never the four JSON blobs. The proximity branch ranks HOME_GEO_FETCH_LIMIT
// rows to render HOME_LIST_LIMIT of them, so a blob here would cross the binding
// five times for every row a visitor sees. beach_state's column names are all
// distinct from beaches', so every WHERE, ORDER BY and LIKE clause stays
// unqualified; only the splat needs the alias.
const BEACH_WITH_CHIP_FROM =
  "SELECT b.*, " + CHIP_STATE_SELECT + " FROM beaches b" + BEACH_STATE_JOIN;

// Builds the beach-plus-state statement shared by both name and distance
// branches: an optional LIKE_WHERE clause, an optional ORDER BY clause, and a
// caller-supplied LIMIT.
function buildListStatement(env, hasQuery, pattern, orderByClause, limit) {
  // Every list branch hides confirmed-inland (and parked-unresolved) beaches
  // via the canonical flag-worthy gate: AND it after the LIKE clause when a
  // query is present, use it as the WHERE otherwise.
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
// cheap for SQLite per row, while the JS haversine still decides the final
// top-100 ordering.
//
// The three interpolated values are always finite Numbers rendered via String()
// and never raw request text, which is what keeps this injection-safe. Every
// location reaching here passed a Number.isFinite check, and the guard below
// re-checks before building the clause. Returns null for an unusable location,
// keeping the unordered shape rather than emitting anything unsafe.
export function proximityOrderByClause(location) {
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

// The name and distance list modes: up to HOME_LIST_LIMIT flag-worthy rows,
// optionally filtered by query (already trimmed; empty means no filter), sorted
// by distance from location when there is one and alphabetically by display
// name otherwise. Returns { rows, hasMore }; with a location each row carries
// distance_mi, the haversine miles the order was decided by.
export async function queryBeachList(env, location, query) {
  const hasQuery = typeof query === "string" && query.length > 0;
  const pattern = hasQuery ? "%" + escapeLike(query) + "%" : null;
  if (location) {
    // LIMIT stays a pure safety cap: with the proximity ORDER BY in front of it
    // the 500 rows it keeps are the 500 NEAREST candidates, so the JS haversine
    // below re-sorts an already-relevant set.
    const stmt = buildListStatement(
      env, hasQuery, pattern, proximityOrderByClause(location), HOME_GEO_FETCH_LIMIT
    );
    const result = await stmt.all();
    const rows = (result && result.results) || [];
    for (const beach of rows) {
      beach.distance_mi = distanceMi(location.lat, location.lon, beach.lat, beach.lon);
    }
    rows.sort(function (a, b) { return a.distance_mi - b.distance_mi; });
    return {
      rows: rows.slice(0, HOME_LIST_LIMIT),
      hasMore: rows.length > HOME_LIST_LIMIT
    };
  }
  // Alphabetical by DISPLAY name: rows inside a park render under the park
  // name, so they must sort under it too (COALESCE matches the frontend's
  // displayName()). Fetch one extra row to detect whether more beaches exist
  // beyond the cap (drives the "search all beaches" empty-state affordance).
  const stmt = buildListStatement(
    env, hasQuery, pattern, "COALESCE(park_name, name), name", HOME_LIST_LIMIT + 1
  );
  const result = await stmt.all();
  const rows = (result && result.results) || [];
  return {
    rows: rows.slice(0, HOME_LIST_LIMIT),
    hasMore: rows.length > HOME_LIST_LIMIT
  };
}

// The ids list mode: the flag-worthy rows for ids (storage ids, as
// parseBeachIds returns them), in the order given. Unknown and non-flag-worthy
// ids are skipped silently, and an empty list reads nothing at all.
export async function queryBeachesByIds(env, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(function (id, index) { return "?" + String(index + 1); });
  const stmt = env.DB.prepare(
    BEACH_WITH_CHIP_FROM + " WHERE id IN (" + placeholders.join(", ") + ") AND " +
    FLAG_WORTHY_WATER_SQL
  );
  const result = await stmt.bind.apply(stmt, ids).all();
  const rows = (result && result.results) || [];
  // SQLite returns an IN-set in whatever order it likes, so the caller's order
  // is restored here rather than asked of the database.
  const byId = new Map();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  const ordered = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) {
      ordered.push(row);
    }
  }
  return ordered;
}
