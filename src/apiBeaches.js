// src/apiBeaches.js — GET /api/beaches, the JSON twin of the home page's three
// list modes, plus the pure helpers the router shares with it: the list items'
// shape, the display-name rule, the per-beach links and the alternate href the
// HTML pages advertise.
//
// Request path only: the rows come from src/beachQueries.js, the same functions
// the home page renders from, so a URL names the same beaches in the same order
// whichever representation asks. Never reads request.cf: near is explicit or
// absent, so every response is URL-determined and cacheable. Never touches
// last_viewed, which only the two single-beach routes stamp.
import { displayFlag } from "./displayFlag.js";
import { liveChipState } from "./beachState.js";
import { toPublicId } from "./publicId.js";
import { roundCoord } from "./mapFeatures.js";
import { strongEtag, etaggedResponse } from "./etag.js";
import { CACHE_CONTROL_CACHEABLE, CACHE_CONTROL_NO_STORE } from "./cacheControl.js";
import {
  parseBeachIds,
  parseNearParam,
  queryBeachList,
  queryBeachesByIds
} from "./beachQueries.js";

export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

// The name a beach is shown under: its containing park's when it has one, its
// own otherwise — the rule the list page, the map features and the detail
// title all follow.
export function beachDisplayName(beach) {
  if (beach && beach.park_name) {
    return beach.park_name;
  }
  return (beach && beach.name) || "";
}

// The two URLs a beach answers at, from its storage id. An id outside the
// storage shape is emitted as it stands, as every renderer does.
export function beachLinks(storageId) {
  const publicId = toPublicId(storageId) || storageId;
  return {
    page: "/beach/" + publicId,
    api: "/api/beaches/" + publicId
  };
}

// A coordinate rounded as the GeoJSON rounds it, or null when it is not finite.
export function apiCoord(value) {
  const n = (value === null || value === undefined) ? NaN : Number(value);
  return Number.isFinite(n) ? roundCoord(n) : null;
}

// Haversine miles to one decimal, or null.
function roundMiles(value) {
  return (typeof value === "number" && Number.isFinite(value))
    ? Math.round(value * 10) / 10
    : null;
}

// One list item from a CHIP_STATE_SELECT row. display is built field by field
// from the one displayFlag decision, exactly as /api/beaches/:id builds it, so
// no internal decision field (the collapsed keyword) reaches the public shape
// and double-red stays double-red.
export function beachListItem(row, nowIso, nowMs, distance) {
  const state = liveChipState(row, nowMs);
  const flag = displayFlag(state, nowIso);
  return {
    id: toPublicId(row.id) || row.id,
    name: beachDisplayName(row),
    lat: apiCoord(row.lat),
    lon: apiCoord(row.lon),
    display: { color: flag.color, source: flag.source, forecast: flag.forecast },
    distanceMi: roundMiles(distance),
    links: beachLinks(row.id)
  };
}

// The estimate_updated of the freshest live estimate among rows, or null when
// none is live. An expired estimate resolves to unknown and says nothing about
// how fresh a response is. It dates a body from its data rather than from the
// request instant, so an unchanged list hashes to an unchanged ETag. Shared with
// the GeoJSON's builtAt. Pure.
export function newestLiveEstimateUpdated(rows, nowMs) {
  const nowEpoch = Math.floor(nowMs / 1000);
  let newest = null;
  let newestMs = -Infinity;
  for (const row of rows) {
    const expires = row.estimate_expires;
    const updatedMs = Date.parse(row.estimate_updated);
    if (typeof expires === "number" && expires > nowEpoch &&
        Number.isFinite(updatedMs) && updatedMs > newestMs) {
      newestMs = updatedMs;
      newest = row.estimate_updated;
    }
  }
  return newest;
}

function badRequest(message) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "content-type": JSON_CONTENT_TYPE, "cache-control": CACHE_CONTROL_NO_STORE }
  });
}

// The query a request asks for, or { error } for a 400. Blank q reads as
// absent; ids rules out q and near, since the page's ids mode ignores both and
// a JSON caller should hear that rather than get a silently different list.
export function parseBeachesQuery(searchParams) {
  const rawQ = searchParams.get("q");
  const q = (typeof rawQ === "string" && rawQ.trim().length > 0) ? rawQ.trim() : null;
  const rawNear = searchParams.get("near");
  const rawIds = searchParams.get("ids");
  if (rawIds !== null) {
    if (q !== null || rawNear !== null) {
      return { error: "ids cannot be combined with q or near" };
    }
    return { mode: "ids", q: null, near: null, ids: parseBeachIds(rawIds) };
  }
  let near = null;
  if (rawNear !== null) {
    near = parseNearParam(rawNear);
    if (near === null) {
      return { error: "near must be lat,lon in decimal degrees, latitude -90 to 90 and longitude -180 to 180" };
    }
  }
  return { mode: near ? "distance" : "name", q: q, near: near, ids: null };
}

// GET /api/beaches. The body is its own validator: a strong SHA-256 ETag over
// the exact bytes, and a matching If-None-Match answers 304. The body carries no
// request instant (builtAt is data-derived), so the tag moves only when the
// beaches or their flags do.
export async function handleApiBeaches(env, searchParams, ifNoneMatch) {
  const parsed = parseBeachesQuery(searchParams);
  if (parsed.error) {
    return badRequest(parsed.error);
  }
  let rows;
  let hasMore = false;
  if (parsed.mode === "ids") {
    rows = await queryBeachesByIds(env, parsed.ids);
  } else {
    const list = await queryBeachList(env, parsed.near, parsed.q || "");
    rows = list.rows;
    hasMore = list.hasMore;
  }
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const beaches = [];
  for (const row of rows) {
    beaches.push(beachListItem(row, nowIso, nowMs,
      parsed.mode === "distance" ? row.distance_mi : null));
  }
  const payload = {
    builtAt: newestLiveEstimateUpdated(rows, nowMs),
    sort: parsed.mode,
    query: {
      q: parsed.q,
      near: parsed.near,
      ids: parsed.ids === null
        ? null
        : parsed.ids.map(function (id) { return toPublicId(id) || id; })
    },
    hasMore: hasMore,
    beaches: beaches
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const etag = await strongEtag(bytes);
  return etaggedResponse(bytes, etag, JSON_CONTENT_TYPE, CACHE_CONTROL_CACHEABLE, ifNoneMatch);
}

// The /api/beaches URL a list page's own URL corresponds to, for its
// rel="alternate" link. Only what the page URL itself carried rides along:
// an ids page links its ids (and nothing else, since the page ignores q and
// near there), and any other page its non-blank q and its near when that near
// is valid. A page located from request.cf links the un-near'd API, because the
// API never reads request.cf. Pure.
export function listAlternateHref(searchParams) {
  const rawIds = searchParams.get("ids");
  if (rawIds !== null) {
    const ids = parseBeachIds(rawIds).map(function (id) { return toPublicId(id) || id; });
    return "/api/beaches?ids=" + ids.join(",");
  }
  const params = [];
  const rawQ = searchParams.get("q");
  if (typeof rawQ === "string" && rawQ.trim().length > 0) {
    params.push("q=" + encodeURIComponent(rawQ.trim()));
  }
  const near = parseNearParam(searchParams.get("near"));
  if (near !== null) {
    params.push("near=" + String(near.lat) + "," + String(near.lon));
  }
  return "/api/beaches" + (params.length > 0 ? "?" + params.join("&") : "");
}

// The HTTP Link header advertising href as the page's JSON alternate.
export function alternateLinkHeader(href) {
  return "<" + href + ">; rel=\"alternate\"; type=\"application/json\"";
}
