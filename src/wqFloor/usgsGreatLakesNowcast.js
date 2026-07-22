// src/wqFloor/usgsGreatLakesNowcast.js
//
// KIND: wq — RAISE-ONLY water-quality floor source (NOT an official override).
//   Feeds rules.js estimateFlag's "waterQualityAdvisory" input (step 7) via the
//   src/wqFloor registry: an active predicted-bacteria advisory can RAISE a flag
//   UP to yellow, but can NEVER pull a hazard estimate down. A clean/absent
//   reading is the ABSENCE of an advisory (no site -> resolves to null -> zero
//   effect), so a "Good" reading can never mask a wave/rip/alert red. This is
//   why it lives here and NOT in src/officialSources/ (an official color would
//   OVERRIDE the estimate everywhere).
//
// SOURCE: USGS Great Lakes NowCast (predicted E. coli), two no-auth JSON
//   endpoints on pa.water.usgs.gov:
//     - getbeaches.php          -> beach roster with LATITUDE/LONGITUDE/STATE/COOP_ID
//     - getconditions.php?queryDate=YYYY-MM-DD&timeFrame=7
//                               -> per-day records { DATE, COOP_ID, BEACH_NAME,
//                                  BEACH_CONDITIONS ("Good"/"Advisory"/"Closed"/""),
//                                  NOWCAST_ECOLI, ... }
//   getconditions carries no coordinates, so it is JOINED to the roster by
//   (COOP_ID + BEACH_NAME). Data lags ~1 week; queryDate is derived from nowIso
//   and timeFrame=7 pulls the trailing week. The LATEST record per beach wins.
//
// COLOR / FLOOR MAPPING (raise-only, worst-of yellow):
//     BEACH_CONDITIONS "Advisory" -> floorColor "yellow"
//     BEACH_CONDITIONS "Closed"   -> floorColor "yellow"  (this is a BACTERIA
//                                    closure, NOT a surf hazard -> NEVER red)
//     "Good" / "" / anything else -> NO site (no floor)
//   Only NY / OH / PA beaches (Lake Erie + Lake Ontario US south shore) are
//   emitted; other states (e.g. MI Monroe) are dropped. Readings older than
//   MAX_NOWCAST_AGE_DAYS are dropped so a prior-season advisory never
//   republishes forever.
//
// INTEGRATOR / DEDUP NOTE: this is a NEW axis (water quality), disjoint from
//   every hazard source (NWS/ECCC alerts, SRF rip, Open-Meteo/GLOS waves) — no
//   dedup concern. Register by appending "usgsGreatLakesNowcast" to
//   wqFloorSources in src/wqFloor/index.js (most-specific matches() first). The
//   resolver (scrapeWqFloorFromResult) reads site.floorColor + site.reason and
//   the source object's .label; it does NOT read result.source. Resolution is
//   PROXIMITY-ONLY (lat/lon) — names[] is deliberately omitted because NowCast
//   beach names are generic ("Ontario", "Lake Erie", "Cuyahoga") and a loose
//   substring would misattribute an advisory to a namesake beach.
//
// scrape() runs CRON-SIDE ONLY (does the fetch). Every parse helper is pure,
// takes the passed-in nowIso (no Date.now()), and degrades to null on any
// schema/markup change — never a wrong color.
//
// NOTE ON THE FETCH URLS: the documented endpoints returned the expected JSON
// shape when probed with a normal HTTP client; a bot-filtered fetcher may see
// 403, so scrape() sends a benign User-Agent and fails CLOSED to null.

import { fetchText, ageDays } from "../officialSources/util.js";

export const NOWCAST_BEACHES_URL =
  "https://pa.water.usgs.gov/apps/nowcast/getbeaches.php";
export const NOWCAST_CONDITIONS_BASE =
  "https://pa.water.usgs.gov/apps/nowcast/getconditions.php";
export const NOWCAST_INFO_URL =
  "https://pa.water.usgs.gov/apps/nowcast/";
export const NOWCAST_LABEL = "USGS Great Lakes NowCast";

// Some USGS endpoints 403 requests without a User-Agent; Workers' fetch sends
// none by default. A benign contact UA keeps the fetch from being bot-filtered.
export const NOWCAST_USER_AGENT = "swim.report (hello@swim.report)";

// Only Lake Erie + Lake Ontario US south-shore states carry NowCast data.
const ALLOWED_STATES = ["NY", "OH", "PA"];

// Predicted-bacteria data lags ~1 week; timeFrame=7 covers the trailing week.
// Anything older than this is treated as stale (prior sampling window / season)
// and dropped, so a leftover advisory never floors indefinitely.
const MAX_NOWCAST_AGE_DAYS = 14;

// Pure. Map a raw BEACH_CONDITIONS value to a floor color, or null.
// Advisory AND Closed both mean predicted bacteria exceedance -> yellow floor.
// "Closed" is a WATER-QUALITY closure, NOT a surf hazard, so it is NEVER red.
// "Good", blank, or any unrecognized value -> null (no floor). Explicit
// allowlist, never a prototype-chain membership test.
export function normalizeNowcastCondition(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const key = raw.trim().toLowerCase();
  if (key === "advisory") {
    return "yellow";
  }
  if (key === "closed") {
    return "yellow";
  }
  return null;
}

// Pure. Extract a YYYY-MM-DD queryDate from the passed-in ISO timestamp, or
// null if it is not a parseable ISO-date-prefixed string. Parses the given
// string only — no Date.now()/current-clock read.
export function deriveNowcastQueryDate(nowIso) {
  if (typeof nowIso !== "string") {
    return null;
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(nowIso);
  return match ? match[1] : null;
}

// Join key shared by both endpoints: COOP_ID + BEACH_NAME, lowercased. COOP_ID
// disambiguates generic beach names that repeat across counties ("Ontario",
// "Cuyahoga", "Lake Erie").
function joinKey(coopId, beachName) {
  return coopId.toLowerCase() + "|" + beachName.toLowerCase();
}

// Coerce a string-or-number field to a finite Number, or null.
function toFiniteNumber(value) {
  if (typeof value === "number") {
    return isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value.trim());
    return isFinite(n) ? n : null;
  }
  return null;
}

// Parse a JSON array body defensively. Returns the array, or null on any
// failure (empty body, JSON error, non-array). Never throws.
function safeJsonArray(text) {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.log("usgsGreatLakesNowcast: JSON parse failed: " + err.message);
    return null;
  }
  if (!Array.isArray(parsed)) {
    console.log("usgsGreatLakesNowcast: expected a JSON array");
    return null;
  }
  return parsed;
}

// Build a stable kebab siteId from the join fields.
function buildSiteId(coopId, beachName) {
  const raw = (coopId + "-" + beachName).toLowerCase();
  return raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Pure. getbeaches.php body -> [{ key, coopId, beachName, lat, lon, state }] or
// null. Records without a usable name or finite in-range coordinates are
// skipped; if nothing usable survives (or the body is not a JSON array), null.
export function parseNowcastBeaches(text) {
  const arr = safeJsonArray(text);
  if (arr === null) {
    return null;
  }
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rec = arr[i];
    if (!rec || typeof rec !== "object") {
      continue;
    }
    const beachName = typeof rec.BEACH_NAME === "string" ? rec.BEACH_NAME.trim() : "";
    if (beachName.length === 0) {
      continue;
    }
    const lat = toFiniteNumber(rec.LATITUDE);
    const lon = toFiniteNumber(rec.LONGITUDE);
    if (lat === null || lon === null) {
      continue;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      continue;
    }
    const state = typeof rec.STATE === "string" ? rec.STATE.trim().toUpperCase() : "";
    const coopId = typeof rec.COOP_ID === "string" ? rec.COOP_ID.trim() : "";
    out.push({
      key: joinKey(coopId, beachName),
      coopId: coopId,
      beachName: beachName,
      lat: lat,
      lon: lon,
      state: state
    });
  }
  if (out.length === 0) {
    console.log("usgsGreatLakesNowcast: no usable beach roster rows");
    return null;
  }
  return out;
}

// Pure. getconditions.php body -> [{ key, coopId, beachName, conditions, date }]
// or null. Records without a valid ISO DATE are dropped (DATE is required for
// latest-wins ordering + staleness). A non-empty body that yields ZERO usable
// rows is treated as a schema change -> null; a genuinely empty array [] is a
// legitimate no-data run -> [].
export function parseNowcastConditions(text) {
  const arr = safeJsonArray(text);
  if (arr === null) {
    return null;
  }
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rec = arr[i];
    if (!rec || typeof rec !== "object") {
      continue;
    }
    const beachName = typeof rec.BEACH_NAME === "string" ? rec.BEACH_NAME.trim() : "";
    if (beachName.length === 0) {
      continue;
    }
    const date = typeof rec.DATE === "string" ? rec.DATE.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      continue;
    }
    const coopId = typeof rec.COOP_ID === "string" ? rec.COOP_ID.trim() : "";
    const conditions = typeof rec.BEACH_CONDITIONS === "string" ? rec.BEACH_CONDITIONS.trim() : "";
    out.push({
      key: joinKey(coopId, beachName),
      coopId: coopId,
      beachName: beachName,
      conditions: conditions,
      date: date
    });
  }
  if (arr.length > 0 && out.length === 0) {
    console.log("usgsGreatLakesNowcast: conditions body had rows but none parseable");
    return null;
  }
  return out;
}

// Pure. Is a reading dated dateStr stale relative to the passed-in nowIso?
// Parses both given strings (no current-clock read). Unparseable -> not stale
// (do not drop everything on a clock we cannot interpret).
function isNowcastStale(dateStr, nowIso) {
  if (typeof nowIso !== "string" || nowIso.length === 0) {
    return false;
  }
  const nowMs = new Date(nowIso).getTime();
  const thenMs = new Date(dateStr + "T00:00:00Z").getTime();
  if (isNaN(nowMs) || isNaN(thenMs)) {
    return false;
  }
  return ageDays(nowMs, thenMs) > MAX_NOWCAST_AGE_DAYS;
}

// Pure. Join the two endpoint bodies into wqFloor Site[] (floorColor sites), or
// null when either body is unusable. Only Advisory/Closed readings become
// sites; Good/blank produce none. The LATEST record per beach wins, so a beach
// that cleared (Good today) after an earlier Advisory is not floored. Sites are
// resolved to swim.report beaches by PROXIMITY (lat/lon) downstream — no names[]
// (NowCast names are too generic to substring-match safely).
export function buildNowcastFloorSites(beachesText, conditionsText, nowIso) {
  const beaches = parseNowcastBeaches(beachesText);
  if (beaches === null) {
    return null;
  }
  const conditions = parseNowcastConditions(conditionsText);
  if (conditions === null) {
    return null;
  }
  const beachByKey = new Map();
  for (let i = 0; i < beaches.length; i++) {
    beachByKey.set(beaches[i].key, beaches[i]);
  }
  // Keep the most recent (max DATE) condition per beach. YYYY-MM-DD compares
  // lexicographically, so string > is a valid date ordering here.
  const latestByKey = new Map();
  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i];
    const prev = latestByKey.get(c.key);
    if (!prev || c.date > prev.date) {
      latestByKey.set(c.key, c);
    }
  }
  const sites = [];
  for (const c of latestByKey.values()) {
    const floorColor = normalizeNowcastCondition(c.conditions);
    if (floorColor === null) {
      continue;
    }
    const beach = beachByKey.get(c.key);
    if (!beach) {
      // No roster row: cannot geolocate this advisory, so it cannot be floored
      // onto any beach. Drop it rather than guess.
      continue;
    }
    if (ALLOWED_STATES.indexOf(beach.state) === -1) {
      continue;
    }
    if (isNowcastStale(c.date, nowIso)) {
      continue;
    }
    sites.push({
      siteId: buildSiteId(c.coopId, c.beachName),
      floorColor: floorColor,
      lat: beach.lat,
      lon: beach.lon,
      reason: "predicted E. coli exceedance (" + c.conditions + ") for " + beach.beachName,
      updated: c.date
    });
  }
  return sites;
}

// Coarse Lake Erie + Lake Ontario US south-shore bounding box (NY/OH/PA). A
// beach outside this box never consults NowCast. Broad on purpose (the precise
// gate is the per-site proximity resolution downstream); a matched beach with
// no nearby advisory site simply resolves to null (no floor).
function inNowcastRegion(beach) {
  if (typeof beach.lat !== "number" || typeof beach.lon !== "number") {
    return false;
  }
  return beach.lat >= 41.2 && beach.lat <= 44.1 &&
    beach.lon >= -83.6 && beach.lon <= -75.8;
}

export const usgsGreatLakesNowcast = {
  id: "usgs-great-lakes-nowcast",
  label: NOWCAST_LABEL,
  infoUrl: NOWCAST_INFO_URL,
  matches: function(beach) {
    return inNowcastRegion(beach);
  },
  scrape: async function(nowIso) {
    const queryDate = deriveNowcastQueryDate(nowIso);
    if (queryDate === null) {
      console.log("usgsGreatLakesNowcast: could not derive queryDate from nowIso");
      return null;
    }
    const beachesText = await fetchText(NOWCAST_BEACHES_URL, {
      headers: { "User-Agent": NOWCAST_USER_AGENT },
      logPrefix: "usgsGreatLakesNowcast: beaches fetch failed"
    });
    if (beachesText === null) {
      return null;
    }
    const conditionsUrl = NOWCAST_CONDITIONS_BASE +
      "?queryDate=" + queryDate + "&timeFrame=7";
    const conditionsText = await fetchText(conditionsUrl, {
      headers: { "User-Agent": NOWCAST_USER_AGENT },
      logPrefix: "usgsGreatLakesNowcast: conditions fetch failed"
    });
    if (conditionsText === null) {
      return null;
    }
    try {
      const sites = buildNowcastFloorSites(beachesText, conditionsText, nowIso);
      if (sites === null) {
        return null;
      }
      // A successful fetch/parse with zero advisories is an honest clean run:
      // return the perBeach result (empty sites resolve to null per beach -> no
      // floor, no KV write), reserving null strictly for real fetch/parse
      // failures.
      return {
        perBeach: true,
        sites: sites,
        source: NOWCAST_LABEL,
        updated: nowIso
      };
    } catch (err) {
      console.log("usgsGreatLakesNowcast: build failed: " + err.message);
      return null;
    }
  }
};
