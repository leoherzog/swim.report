// src/apiCors.js — the CORS policy of the public JSON API. Every /api/* response
// (200, 304, 301, 400, 404, the GeoJSON and the /api/ documentation page) and
// the /beach/<id>.json redirect into it carry the same two headers, applied once
// by the router rather than per handler, and an OPTIONS preflight on any /api/*
// path answers 204 from here.
//
// The API is unauthenticated, read-only and serves the same bytes to everyone,
// so "*" is the whole policy: no credentials, no per-origin echo, and therefore
// no Vary: Origin to fragment the Workers Cache entry. ETag and Link are exposed
// so a cross-origin client can revalidate and discover alternates.

export const API_CORS_HEADERS = [
  ["access-control-allow-origin", "*"],
  ["access-control-expose-headers", "ETag, Link"]
];

// The preflight's own answer. Max-Age is a day: Chromium caps it at two hours
// and Firefox at a day, and the policy never varies, so the longest
// cache any browser keeps costs nothing.
const PREFLIGHT_HEADERS = [
  ["access-control-allow-origin", "*"],
  ["access-control-allow-methods", "GET, HEAD, OPTIONS"],
  ["access-control-allow-headers", "If-None-Match, Accept"],
  ["access-control-max-age", "86400"]
];

// True for the paths this policy covers: /api, /api/ and anything under it.
export function isApiPath(path) {
  return path === "/api" || (typeof path === "string" && path.indexOf("/api/") === 0);
}

function applyCors(headers) {
  for (const pair of API_CORS_HEADERS) {
    headers.set(pair[0], pair[1]);
  }
}

// The same Response with the CORS headers set, or a copy carrying the same
// status, headers and body when its headers are immutable.
export function withApiCors(response) {
  try {
    applyCors(response.headers);
    return response;
  } catch (err) {
    const copy = new Response(response.body, response);
    applyCors(copy.headers);
    return copy;
  }
}

// 204 No Content for an OPTIONS preflight on any /api/* path. no-store, so a
// shared cache never answers a GET with it.
export function apiPreflightResponse() {
  const headers = new Headers();
  for (const pair of PREFLIGHT_HEADERS) {
    headers.set(pair[0], pair[1]);
  }
  headers.set("access-control-expose-headers", "ETag, Link");
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 204, headers: headers });
}
