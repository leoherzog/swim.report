// src/etag.js — the strong ETag over a response body and the If-None-Match
// comparison /api/beaches.geojson answers 304 from. Pure: no fetch, no Date.

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
