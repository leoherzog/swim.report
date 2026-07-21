// src/clients/windyWebcams.js
// Nearest-beach webcam lookup against the Windy Webcams v3 API
// (https://api.windy.com/webcams — authenticated with an x-windy-api-key
// header). This is a presentation-only enrichment: a live/timelapse player
// embed for the beach page, never an input to the flag estimate. A cam only
// "belongs" to a beach when it sits within WEBCAM_RADIUS_KM; the API's own
// nearby filter is a coarse first pass, so the pure parser re-checks distance
// and picks the true nearest active cam.
//
// Every fetching export is async, takes structured args, and NEVER throws
// across the module boundary: on any error it logs with console.log and
// resolves to null. The pure parse helper is exported for tests. No Date
// access anywhere — nothing here depends on the clock.
//
// Failure vs. absence is a distinction the cron relies on: an HTTP success
// with zero usable cams resolves to { webcam: null } (a confirmed "no cam
// here" the caller can persist), while any transport/API failure resolves to
// null (unknown — the caller leaves the row untouched and retries later).

import { distanceKm } from "./glerl.js";
import { fetchJson } from "./http.js";

export const WINDY_WEBCAMS_API_URL = "https://api.windy.com/webcams/api/v3/webcams";
// A cam farther than this from the beach is not "at the beach".
export const WEBCAM_RADIUS_KM = 5;
// API max limit per request.
export const WEBCAM_FETCH_LIMIT = 50;

// Pure. Windy v3 /webcams response body (already-parsed object) ->
//   { webcamId, title, playerUrl, detailUrl } for the nearest usable active
// cam WITHIN WEBCAM_RADIUS_KM of (lat, lon), or null. A candidate is usable
// only when it is an object, status === "active", it has a player object
// exposing a non-empty-string .live or .day, and its location.latitude /
// location.longitude are finite numbers. playerUrl prefers player.live (a
// live stream) over player.day (a timelapse). detailUrl is the cam's OWN
// Windy detail page (urls.detail from include=urls) or null when absent —
// the Terms' "link every image with our webcam page" target; renderWebcam
// falls back to the generic hub when it is null (pre-refresh rows). The
// radius guard makes this safe
// against a bbox query's wider result set (a shared bbox may return cams
// nearer some OTHER beach in the bucket) — for a nearby query nothing changes,
// since the API already constrained the response to WEBCAM_RADIUS_KM. Malformed
// input (null, missing/non-array webcams, etc.) -> null, never a throw.
export function parseNearestActiveWebcam(json, lat, lon) {
  if (!json || !Array.isArray(json.webcams)) {
    return null;
  }
  let best = null;
  let bestDistance = null;
  for (const cam of json.webcams) {
    if (!cam || typeof cam !== "object" || cam.status !== "active") {
      continue;
    }
    const player = cam.player;
    if (!player || typeof player !== "object") {
      continue;
    }
    const live = typeof player.live === "string" && player.live.length > 0 ? player.live : null;
    const day = typeof player.day === "string" && player.day.length > 0 ? player.day : null;
    const playerUrl = live !== null ? live : day;
    if (playerUrl === null) {
      continue;
    }
    const location = cam.location;
    if (!location || typeof location !== "object") {
      continue;
    }
    const camLat = location.latitude;
    const camLon = location.longitude;
    if (typeof camLat !== "number" || !isFinite(camLat) ||
        typeof camLon !== "number" || !isFinite(camLon)) {
      continue;
    }
    const d = distanceKm(lat, lon, camLat, camLon);
    if (d > WEBCAM_RADIUS_KM) {
      continue;
    }
    const urls = cam.urls;
    const detailUrl = urls && typeof urls === "object" &&
      typeof urls.detail === "string" && urls.detail.length > 0
      ? urls.detail
      : null;
    if (bestDistance === null || d < bestDistance) {
      bestDistance = d;
      best = {
        webcamId: String(cam.webcamId),
        title: cam.title === undefined || cam.title === null ? "" : String(cam.title),
        playerUrl: playerUrl,
        detailUrl: detailUrl
      };
    }
  }
  return best;
}

// -> { webcam: <parseNearestActiveWebcam result, may be null> } on HTTP
// success, null on ANY failure. Never throws. A falsy apiKey short-circuits to
// null before any fetch. One GET to WINDY_WEBCAMS_API_URL with the beach as the
// nearby center; non-2xx or a JSON parse failure -> log + null.
export async function fetchNearestWebcam(lat, lon, apiKey) {
  if (!apiKey) {
    console.log("windyWebcams: missing api key, skipping fetch");
    return null;
  }
  const url = WINDY_WEBCAMS_API_URL +
    "?nearby=" + String(lat) + "," + String(lon) + "," + String(WEBCAM_RADIUS_KM) +
    "&include=player,location,urls&limit=" + String(WEBCAM_FETCH_LIMIT);
  const json = await fetchJson(url, {
    headers: { "x-windy-api-key": apiKey },
    label: "windyWebcams:"
  });
  if (json === null) {
    return null;
  }
  return { webcam: parseNearestActiveWebcam(json, lat, lon) };
}

// One /webcams request bounded by a bbox rectangle so a bucket of nearby
// beaches (runWebcamSync clustering) shares a single round trip instead of one
// nearby query each. Returns the RAW parsed body ({ webcams: [...] }) for the
// caller to run parseNearestActiveWebcam per beach against, or null on ANY
// failure. Never throws. A falsy apiKey short-circuits to null before any
// fetch. bbox order is Windy's documented north,east,south,west; the 50-cam
// cap (WEBCAM_FETCH_LIMIT) means the caller must treat a full-length result as
// possibly truncated and fall back to per-beach nearby queries.
export async function fetchWebcamsInBbox(north, east, south, west, apiKey) {
  if (!apiKey) {
    console.log("windyWebcams: missing api key, skipping bbox fetch");
    return null;
  }
  const url = WINDY_WEBCAMS_API_URL +
    "?bbox=" + String(north) + "," + String(east) + "," + String(south) + "," + String(west) +
    "&include=player,location,urls&limit=" + String(WEBCAM_FETCH_LIMIT);
  return await fetchJson(url, {
    headers: { "x-windy-api-key": apiKey },
    label: "windyWebcams: bbox"
  });
}
