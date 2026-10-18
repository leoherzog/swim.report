// src/cacheControl.js — the request path's two cache-control policies, in their
// own module because the router, the JSON API handlers and the CORS wrapper all
// stamp them and none of them may own the others.
//
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
export const CACHE_CONTROL_CACHEABLE =
  "public, max-age=60, stale-while-revalidate=60, stale-if-error=600";
export const CACHE_CONTROL_NO_STORE = "no-store";
