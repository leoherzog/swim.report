// src/waveSources/seaCavesWaves.js
//
// KIND: wave (src/waveSources supplemental fallback — matches(beach) + async
// waveFt(beach, nowIso, env) -> finite-ft-number | null).
//
// SOURCE: UW-Madison "Sea Caves Watch" single-point wave gauge at the
// Mainland Sea Caves / Meyers Beach unit of Apostle Islands National
// Lakeshore, Lake Superior. Static HTML page, no JSON API:
//   https://wavesatseacaves.cee.wisc.edu/index.htm
// Live shape confirmed by fetch on 2026-07-22 (200 OK). The page's
// "Latest Wave Info" block renders three stacked <h4> lines — a date, a
// time, and "Wave height N.N ft" — which the station's own logic already
// picks as the most recent NON-"N/A" reading (the 24-row table below it can
// have a leading "N/A" row while "Latest Wave Info" still reports the prior
// good reading). We deliberately parse ONLY that "Latest Wave Info" block,
// not the table, so we inherit the site's own "skip N/A" behavior for free.
//
// COLOR / FLOOR MAPPING: none — this is a wave-HEIGHT fallback, not a color
// or floor source. It returns a plain feet number (or null) that plugs into
// the SAME "waveFt >= 4 red / >= 2 yellow / else green" thresholds every
// other wave input already uses in src/rules.js. Do not reuse the page's own
// bgcolor-coded kayak-skill table (< 1 ft green / 1-2 ft yellow / > 2 ft red)
// — those bands are a much stricter kayaker scale, not this product's
// swimmer/wave-hazard thresholds, and mixing the two would silently double
// -apply a different rule set to the same number.
//
// INTEGRATOR DEDUP NOTE: single fixed point (~46.88, -91.03) — never write a
// "waves:"+beachId 24h strip from this source (mirrors the buoy/gridpoint
// single-point fallback convention: hoursFt stays whatever Open-Meteo left
// it, i.e. usually null). Consult this source ONLY for beaches still
// wave-null after the Open-Meteo marine batch + GLOS buoy gap-fill, and only
// as one entry in the ordered SUPPLEMENTAL_WAVE_SOURCES fallback chain —
// never additively alongside a primary reading.
//
// Cron-side only (two-path rule): waveFt performs the fetch and is reachable
// solely from runWaveRefresh. Parse defensively — a markup change on this
// static, unversioned site (it has changed schema/notices before) MUST
// degrade to null, never a wrong wave height that could mis-color a flag.

import { distanceKm } from "../geo.js";
import { fetchText } from "../officialSources/util.js";

export const SEA_CAVES_URL = "https://wavesatseacaves.cee.wisc.edu/index.htm";
export const SEA_CAVES_LABEL = "UW-Madison Sea Caves Watch";
export const SEA_CAVES_MODEL = "uw_sea_caves_watch";

// Approximate station location (Meyers Beach / Mainland Sea Caves unit).
const SEA_CAVES_LAT = 46.88;
const SEA_CAVES_LON = -91.03;
const SEA_CAVES_MAX_KM = 15;

// A beach names itself into scope if it mentions the sea caves / Meyers
// Beach / the lakeshore by name; otherwise proximity to the station point
// decides. Kept loose-but-scoped per the spec ("~15 km of ~46.88,-91.03").
const SEA_CAVES_NAME_PATTERN = /sea\s*caves?|meyers\s*beach|apostle\s*islands/i;

// The station updates roughly every 30 minutes; give generous slack for a
// missed cycle before calling a reading stale. Anything older is treated the
// same as no data — never served as "current".
const MAX_READING_AGE_MS = 3 * 60 * 60 * 1000; // 3 hours
// Small tolerance for a reading that looks slightly ahead of nowIso (clock
// skew between this server and the station); beyond this it is untrustworthy.
const MAX_READING_FUTURE_MS = 30 * 60 * 1000; // 30 minutes

function matches(beach) {
  if (!beach || typeof beach !== "object") {
    return false;
  }
  const haystack = (String(beach.name || "") + " " + String(beach.park_name || ""));
  if (SEA_CAVES_NAME_PATTERN.test(haystack)) {
    return true;
  }
  if (typeof beach.lat === "number" && typeof beach.lon === "number" &&
      isFinite(beach.lat) && isFinite(beach.lon)) {
    return distanceKm(beach.lat, beach.lon, SEA_CAVES_LAT, SEA_CAVES_LON) <= SEA_CAVES_MAX_KM;
  }
  return false;
}

// Pure. Single fixed gauge — waveFt fetches ONE URL regardless of which beach,
// so every matching beach shares one constant dedup key and the step-2b consult
// fetches the page ONCE per run, fanning the reading to all of them.
function keyOf(beach) {
  return matches(beach) ? SEA_CAVES_MODEL : null;
}

// Pure. "MM/DD/YYYY" + "H:MM AM/PM" (as printed on the page, station-local
// Central time) -> epoch ms, or null on anything unparseable. DST is
// approximated by calendar month (Mar-Oct => CDT/UTC-5, else CST/UTC-6) —
// adequate for a freshness check on a fallback source, not meant to be exact
// to the minute around the DST transition days themselves.
function centralTimestampToMs(dateStr, timeStr) {
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateStr || "");
  const timeMatch = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec((timeStr || "").trim());
  if (!dateMatch || !timeMatch) {
    return null;
  }
  const month = parseInt(dateMatch[1], 10);
  const day = parseInt(dateMatch[2], 10);
  const year = parseInt(dateMatch[3], 10);
  let hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);
  const meridiem = timeMatch[3].toUpperCase();
  if (!isFinite(month) || !isFinite(day) || !isFinite(year) ||
      !isFinite(hour) || !isFinite(minute) ||
      month < 1 || month > 12 || day < 1 || day > 31 || hour < 1 || hour > 12) {
    return null;
  }
  if (meridiem === "PM" && hour !== 12) {
    hour = hour + 12;
  }
  if (meridiem === "AM" && hour === 12) {
    hour = 0;
  }
  const offsetHours = (month >= 3 && month <= 10) ? 5 : 6; // CDT : CST
  const utcMs = Date.UTC(year, month - 1, day, hour + offsetHours, minute, 0, 0);
  if (!isFinite(utcMs)) {
    return null;
  }
  return utcMs;
}

// Pure, exported for tests. HTML body + nowIso -> finite feet, or null.
// Only ever looks at the "Latest Wave Info" block (the station's own
// most-recent-non-N/A reading), never the historical table and never the
// kayak-skill bgcolor legend.
export function extractSeaCavesWaveHeightFt(html, nowIso) {
  if (typeof html !== "string" || html.length === 0) {
    return null;
  }
  const markerIndex = html.indexOf("Latest Wave Info");
  if (markerIndex === -1) {
    return null;
  }
  // The three <h4> lines (date, time, wave height) sit within a few hundred
  // characters of the heading; bound the window so an unrelated "Model" note
  // or table row elsewhere on the page can never leak into this block.
  const snippet = html.slice(markerIndex, markerIndex + 600);

  if (/model/i.test(snippet)) {
    // Can't confirm this is a measured (vs. model-estimated) reading —
    // never guess. See the page's own red "Model" legend note.
    console.log("seaCavesWaves: latest reading marked Model, omitting");
    return null;
  }

  const heightMatch = /Wave\s*height\s*([0-9]+(?:\.[0-9]+)?)\s*ft/i.exec(snippet);
  if (!heightMatch) {
    // Covers "N/A", missing block, off-season empty content, or any other
    // unrecognized value — fail closed to null rather than guess.
    return null;
  }
  const waveHeightFt = parseFloat(heightMatch[1]);
  if (!isFinite(waveHeightFt)) {
    return null;
  }

  const dateMatch = /(\d{2}\/\d{2}\/\d{4})/.exec(snippet);
  const timeMatch = /(\d{1,2}:\d{2}\s*[AP]M)/i.exec(snippet);
  if (!dateMatch || !timeMatch) {
    // No timestamp to confirm freshness against — degrade to null rather
    // than serve a reading of unknown age.
    return null;
  }

  const readingMs = centralTimestampToMs(dateMatch[1], timeMatch[1]);
  const nowMs = Date.parse(nowIso);
  if (readingMs === null || !isFinite(nowMs)) {
    return null;
  }
  const ageMs = nowMs - readingMs;
  if (ageMs > MAX_READING_AGE_MS || ageMs < -MAX_READING_FUTURE_MS) {
    console.log("seaCavesWaves: latest reading is stale (ageMs=" + String(ageMs) + "), omitting");
    return null;
  }

  return waveHeightFt;
}

// Cron-side only. Fetches the page and returns feet-or-null; never throws
// across the module boundary (fetchText already degrades network/HTTP
// failures to null, and the parse above is fully defensive).
async function waveFt(beach, nowIso) {
  const html = await fetchText(SEA_CAVES_URL, {
    logPrefix: "seaCavesWaves: fetch failed"
  });
  if (html === null) {
    return null;
  }
  try {
    return extractSeaCavesWaveHeightFt(html, nowIso);
  } catch (err) {
    console.log("seaCavesWaves: parse threw: " + err.message);
    return null;
  }
}

export const seaCavesSource = {
  id: "uw-sea-caves-watch",
  model: SEA_CAVES_MODEL,
  label: SEA_CAVES_LABEL,
  url: SEA_CAVES_URL,
  matches: matches,
  keyOf: keyOf,
  waveFt: waveFt
};
