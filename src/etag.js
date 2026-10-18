// src/etag.js — the strong ETag over a response body, the If-None-Match
// comparison and the 200-or-304 response the JSON API routes answer with.
// No fetch, no Date.

const HEX = "0123456789abcdef";

// The quoted lowercase SHA-256 hex of bytes (a Uint8Array). Quoted because
// Cloudflare drops an ETag that is not in the RFC 9110 form.
export async function strongEtag(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (let i = 0; i < digest.length; i = i + 1) {
    hex = hex + HEX[digest[i] >> 4] + HEX[digest[i] & 15];
  }
  return "\"" + hex + "\"";
}

// True when an If-None-Match header names etag: "*" matches anything, a comma
// list matches on any entry, and a W/ prefix is ignored on the entry. The weak
// comparison is deliberate: Cloudflare re-compresses the origin body and hands
// the browser W/"<hash>", which is what comes back.
export function etagMatches(ifNoneMatch, etag) {
  if (typeof ifNoneMatch !== "string" || ifNoneMatch.length === 0) {
    return false;
  }
  if (ifNoneMatch.trim() === "*") {
    return true;
  }
  const entries = ifNoneMatch.split(",");
  for (let i = 0; i < entries.length; i = i + 1) {
    let entry = entries[i].trim();
    if (entry.indexOf("W/") === 0) {
      entry = entry.slice(2);
    }
    if (entry === etag) {
      return true;
    }
  }
  return false;
}

// The response for a body whose validator is its own bytes: an If-None-Match
// naming etag (weak comparison, comma list and * honored) answers 304 with the
// same ETag and cache-control and no body, and anything else gets the 200 with
// contentType. Cloudflare weakens the tag when it compresses the body, which is
// why the comparison ignores W/. No Vary: Workers Cache compares Vary values
// verbatim and would fragment the entry per Accept-Encoding spelling.
export function etaggedResponse(bytes, etag, contentType, cacheControl, ifNoneMatch) {
  if (etagMatches(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: { "etag": etag, "cache-control": cacheControl }
    });
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": cacheControl,
      "etag": etag
    }
  });
}
