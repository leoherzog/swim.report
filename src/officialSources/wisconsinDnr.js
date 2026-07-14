// src/officialSources/wisconsinDnr.js
// Official scraper for the Wisconsin DNR Beach Health monitoring program.
// The public "Beach Health" map (https://apps.dnr.wi.gov/beachhealth/) is an
// Esri JS map shell backed by a public, unauthenticated ArcGIS Feature Service
// layer. We query that layer directly (JSON) rather than scraping HTML.
//
// scrape() runs cron-side only; parseWisconsinDnrJson is pure and exported for
// tests. A single query with outFields=* returns all ~441 statewide beaches in
// one response (no pagination needed).

// ArcGIS REST query: where=1=1 (all rows), full attributes, geometry in plain
// WGS84 lon/lat (outSR=4326), JSON.
export const WISCONSIN_DNR_URL =
  "https://dnrmaps.wi.gov/arcgis2/rest/services/OGW_Beach_Monitoring/" +
  "BEACH_MONITORING_LOCATIONS/MapServer/1/query" +
  "?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json";

import { fetchText, perBeachResult, ageDays } from "./util.js";

// dnrmaps.wi.gov throttles/blocks requests without a desktop-browser
// User-Agent (a bare request timed out at 30s in probing); the service is also
// slow (~30s even when it succeeds), so the cron client should allow 45s+.
export const WISCONSIN_DNR_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// MAP_STATUS is the small closed enum that drives the public map's pin colors
// (Open / Advisory / Closed / Closed For Season / No Data Available /
// Other Status). We map only the three we can trust to a flag color. Every
// other value degrades to "no site" (no official flag), never a guessed color.
const MAP_STATUS_COLOR = {
  "open": "green",
  "advisory": "yellow",
  "closed": "red"
};

// Statuses we deliberately omit WITHOUT a warning — they are expected,
// well-understood "no official color" states, not parse surprises.
const SILENT_OMIT_STATUS = {
  "closed for season": true,
  "no data available": true,
  "other status": true
};

// This is a PERIODIC (E. coli / bacteria) monitoring program: MAP_STATUS is
// driven by the most recent water sample (SAMPLEDATE). A colored status only
// reflects reality while the sample is recent. Off-season and unmonitored
// beaches can retain a stale summer sample; reporting that as an official
// green/yellow/red would be a wrong color. We therefore omit any site whose
// newest sample is older than this cutoff (degrade to "no official flag").
// In-season samples observed in live data topped out around 13 days old, so
// 21 days omits nothing current while reliably dropping off-season staleness.
const MAX_SAMPLE_AGE_DAYS = 21;

// Pure, exported for tests. (string|null, nowIso) -> sites[] | null.
// nowIso is the cron's current-time argument, used ONLY to judge sample
// staleness — it is never fabricated as a sample's own timestamp.
// Returns null only when the payload cannot be trusted at all (missing/
// malformed JSON, ArcGIS error object, no usable features array, or an
// unparseable nowIso — without a trustworthy clock a periodic source's colors
// cannot be freshness-verified). An empty but well-formed feature list yields
// an empty sites array (caller treats that as "no data"). Individual features
// that lack geometry, carry an untrusted MAP_STATUS, or whose newest sample is
// stale/undateable are simply omitted from sites.
export function parseWisconsinDnrJson(text, nowIso) {
  if (!text) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    console.log("wisconsinDnr: JSON parse failed: " + err.message);
    return null;
  }
  if (!data || typeof data !== "object") {
    return null;
  }
  // Without a valid current time we cannot verify that any sample is recent.
  // For a periodic-testing source, emitting colors we can't freshness-check
  // risks a stale wrong color, so degrade the whole response to no data.
  const nowMs = Date.parse(nowIso);
  if (isNaN(nowMs)) {
    console.log("wisconsinDnr: invalid nowIso, cannot judge staleness; skipping");
    return null;
  }
  // ArcGIS surfaces upstream failures as an { error: {...} } object with HTTP
  // 200 — treat that as no data, never as an empty/green result.
  if (data.error) {
    console.log(
      "wisconsinDnr: ArcGIS error response: " +
      String(data.error && data.error.message)
    );
    return null;
  }
  if (!Array.isArray(data.features)) {
    console.log("wisconsinDnr: response had no features array");
    return null;
  }
  // exceededTransferLimit means the layer truncated the result. We proceed
  // with what we got (partial data is still correct per-beach; unmatched
  // beaches just get no official flag), but log it for visibility.
  if (data.exceededTransferLimit === true) {
    console.log(
      "wisconsinDnr: exceededTransferLimit set; proceeding with partial features"
    );
  }

  const sites = [];
  for (let i = 0; i < data.features.length; i++) {
    const feature = data.features[i];
    if (!feature || typeof feature !== "object") {
      continue;
    }
    const attrs = feature.attributes;
    const geometry = feature.geometry;
    if (!attrs || !geometry) {
      // Missing attributes or geometry — cannot resolve a location. Omit.
      continue;
    }
    const lon = geometry.x;
    const lat = geometry.y;
    if (typeof lat !== "number" || typeof lon !== "number") {
      continue;
    }
    const rawStatus = attrs.MAP_STATUS;
    if (typeof rawStatus !== "string") {
      continue;
    }
    const statusKey = rawStatus.trim().toLowerCase();
    const color = MAP_STATUS_COLOR[statusKey];
    if (!color) {
      // Unknown/untrusted status -> no color. Log only the genuinely
      // unexpected ones so cron logs stay quiet for the known "no data" states.
      if (!SILENT_OMIT_STATUS[statusKey]) {
        console.log(
          "wisconsinDnr: unrecognized MAP_STATUS \"" + rawStatus +
          "\"; omitting site"
        );
      }
      continue;
    }
    // SAMPLEDATE is the epoch-ms timestamp of the sample that produced this
    // status. A colored status with no usable or stale sample date cannot be
    // trusted as current — omit it rather than emit a possibly-stale color.
    const sampleMs = attrs.SAMPLEDATE;
    if (typeof sampleMs !== "number" || !isFinite(sampleMs)) {
      continue;
    }
    const sampleAgeDays = ageDays(nowMs, sampleMs);
    if (sampleAgeDays > MAX_SAMPLE_AGE_DAYS) {
      // Expected off-season/unmonitored staleness — omit silently so cron logs
      // stay quiet; the beach simply gets no official flag from this source.
      continue;
    }
    // Pure computations over the payload's own epoch — no ambient clock.
    // sampleIso becomes the site's updated: this is a periodic (bacteria
    // sampling) source, so the flag is only as fresh as the sample itself;
    // stamping nowIso instead would hide up-to-21-day-old data behind a
    // fresh timestamp and defeat the UI's stale-data warning.
    const sampleIso = new Date(sampleMs).toISOString();
    const sampleDate = sampleIso.slice(0, 10);

    const rawName = attrs.OGW_BEACH_NAME_TEXT;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    // OBJECTID is the stable per-row key (DNR_SWIMS_ID is NOT unique across
    // rows). Fall back to array index if somehow absent.
    const objectId = attrs.OBJECTID;
    const siteId = "wi-dnr-" +
      (objectId === undefined || objectId === null ? "idx" + i : String(objectId));
    // Resolution is PROXIMITY-ONLY (radiusMi 1.0 against the DNR's own precise
    // geometry). We deliberately do NOT emit names[]: the layer is statewide
    // (441 rows, incl. inland lakes/rivers) and full of generic names like
    // "North Beach" / "South Beach" / "Sandy Beach". In resolveSiteForBeach a
    // name match WINS over proximity and ignores distance, so a generic name
    // could bind a Great Lakes beach to a same-named site hundreds of miles
    // away — a wrong color. Proximity alone binds only the actual same beach.
    const site = {
      siteId: siteId,
      color: color,
      reason: "Official flag reported by Wisconsin DNR Beach Health Program" +
        (name.length > 0 ? " for " + name : "") +
        " (sampled " + sampleDate + ")",
      lat: lat,
      lon: lon,
      radiusMi: 1.0,
      updated: sampleIso
    };
    sites.push(site);
  }
  return sites;
}

export const wisconsinDnr = {
  id: "wisconsin-dnr",
  label: "Wisconsin DNR Beach Health Program",
  url: WISCONSIN_DNR_URL,
  matches: function(beach) {
    // Wisconsin Great Lakes (Lake Michigan + Lake Superior) shoreline box.
    // This box overlaps Michigan's western Upper Peninsula. That is
    // ACCEPTABLE: resolution is per-beach and proximity-based, so a Michigan
    // beach that matches this box but sits far from any Wisconsin DNR site
    // resolves to no site and simply gets no official flag from this scraper.
    return beach.lon >= -92.95 && beach.lon <= -86.75 &&
      beach.lat >= 42.45 && beach.lat <= 47.15;
  },
  scrape: async function(nowIso) {
    const text = await fetchText(WISCONSIN_DNR_URL, {
      headers: { "User-Agent": WISCONSIN_DNR_USER_AGENT },
      logPrefix: "wisconsinDnr: fetch failed"
    });
    if (text === null) {
      return null;
    }
    try {
      const sites = parseWisconsinDnrJson(text, nowIso);
      if (!sites || sites.length === 0) {
        return null;
      }
      // result-level updated is a fallback only — every emitted site carries
      // updated: its own SAMPLEDATE, which wins in scrapeOfficialFlagFromResult.
      return perBeachResult(sites, WISCONSIN_DNR_URL, nowIso);
    } catch (err) {
      console.log("wisconsinDnr: fetch failed: " + err.message);
      return null;
    }
  }
};
