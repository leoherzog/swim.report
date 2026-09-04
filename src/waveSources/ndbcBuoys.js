// src/waveSources/ndbcBuoys.js — water temperature, a display-only reading. It
// never reaches src/rules.js, colors no flag, and bumps no RULES_VERSION. The
// cron writes it to "watertemp:" + beachId; src/router.js reads that key and
// src/frontend/render.js renders it in the beach subtitle.
//
// Source: NOAA National Data Buoy Center realtime2 standard meteorological
// files, https://www.ndbc.noaa.gov/data/realtime2/{id}.txt — space-delimited
// text with two "#" header lines (column names, then units), then data rows
// newest first. WTMP, index 14 after a whitespace split, is water temperature in
// Celsius, or the literal "MM" when missing.
//
// The station table declares which readings each row may serve (caps), and each
// capability carries its own proximity cap. Select with
// nearestWaterTempStation; there is deliberately no capability-agnostic
// selector, so a second consumer cannot inherit an eligibility rule written for
// the first. Great Lakes platforms are seasonal, so a station 404, an all-"MM"
// column and a winter gap all degrade to null, which is expected rather than an
// error.
//
// Many beaches share one nearest station, so the cron dedups by station id and
// fetches each unique station once per run, fanning the reading out. This module
// fetches one station per call.
//
// stationWaterTemp fetches upstream and is reachable only from the cron; the
// request path never imports it. Every path degrades to null on a missing field,
// parse issue, or stale or masked reading — never a wrong temperature.

import { distanceKm, celsiusToFahrenheit } from "../geo.js";
import { fetchText } from "../officialSources/util.js";

// Base for a station's realtime2 standard-meteorological file.
const NDBC_REALTIME2_BASE = "https://www.ndbc.noaa.gov/data/realtime2/";

// Proximity cap for a water temperature, set by the cross-shore error a
// swimmer-facing number can absorb.
//   - Summer upwelling is the binding constraint. A west-wind event on Lake
//     Michigan puts the thermal front roughly 5-15 km offshore with an
//     alongshore extent of 100+ km, so the error is anisotropic: 25 km
//     alongshore is usually the same water mass, 25 km cross-shore can be a
//     15-20 F blunder. A scalar cap cannot tell those apart, so it is set by the
//     cross-shore tolerance.
//   - Cross-lake attribution, which 25 km reduces but does not eliminate. On the
//     open basins it is decisive: Lake Erie's central basin is ~57 km wide and
//     Lake Ontario ~85 km, so a beach stays on its own side of the median. The
//     shipped table has the two counterexamples — Lake St Clair is only ~40 km
//     across, so Michigan beaches select 45147 (Lake St Clair, ON) at ~19 km, and
//     Pelee Island (ON) beaches select 45201 (Erie Islands, OH) at ~22 km. Those
//     are short hops across genuinely shared water rather than cross-basin
//     borrowing, which is why they are accepted.
// A beach whose nearest station is mid-lake or across a headland gets an honest
// null instead: that is the band where a wrong number is most likely and least
// detectable.
export const NDBC_WATER_TEMP_MAX_DISTANCE_KM = 25;

// Small tolerance for observation timestamps slightly ahead of nowIso (upstream
// clock skew); anything further in the future is rejected.
const NDBC_MAX_OBS_FUTURE_MS = 600000;

// Index of the WTMP (water temperature) column after splitting a data row on
// whitespace.
const WTMP_INDEX = 14;

// 12 h: the cron cadence plus one skipped run of margin, not the flag TTL. A
// several-hour-old water temperature is still a faithful reading.
export const NDBC_WATER_TEMP_MAX_OBS_AGE_MS = 43200000;

// Great Lakes / coastal water-temp sanity band in Celsius; a token outside it is
// corrupt input (or a mis-parsed column), not a real reading -> null. Lake ice
// keeps the floor near freezing; summer surface temps never approach the ceiling.
const MIN_REASONABLE_C = -2;
const MAX_REASONABLE_C = 40;

// A station is admitted for a reading, never in the abstract, because the
// admission criterion differs per reading. Water temperature needs a platform
// that reports WTMP and is sited so its number is honest for a swimmer at the
// adjacent beach; a second reading must declare its own capability rather than
// reuse this one.
export const CAP_WATER_TEMP = "temp";
export const NDBC_CAPABILITIES = [CAP_WATER_TEMP];

// Per-capability proximity cap, keyed by the same strings.
const CAPABILITY_MAX_KM = {};
CAPABILITY_MAX_KM[CAP_WATER_TEMP] = NDBC_WATER_TEMP_MAX_DISTANCE_KM;

// Curated Great Lakes stations served by NDBC's realtime2 endpoint. lat/lon are
// the published station coordinates (decimal degrees, W longitude negative), each
// confirmed against the station's own NDBC page: a wrong coordinate silently
// attributes the wrong water body to a beach, which the proximity cap bounds but
// does not eliminate.
//
// realtime2 republishes far more than NDBC's own buoys, and this set leans on
// that. Some rows are NOAA National Ocean Service water-level gauges, served in
// the identical standard-met format at the identical URL; the rest are university
// and agency moored, waverider and spotter buoys. The NOS gauges report no wave
// height at all and carry most of the winter coverage, since moored buoys are
// largely pulled Nov-Apr. "NOS" and "year-round" are not interchangeable: two NOS
// gauges have no winter WTMP and two buoys overwinter.
//
// Ids are written exactly as the master station table spells them, which for the
// alphanumeric NOS-style stations is lowercase (hlnm4). The realtime2 path spells
// the same stations uppercase and is case-sensitive, so stationUrl upcases. Do not
// "fix" a row by upcasing it here — the table matches the audit source, and
// normalising in one place is what keeps the two spellings from having to agree
// by hand.
//
// Rejected on review, because these are judgments the rule cannot encode: St Marys
// and St Clair River navigation channels (swpm4, ltrm4, wnem4, rckm4, agcm4 —
// dredged shipping cuts, nearest beach 23-39 km away on a different water body),
// Lake Simcoe (45151 — an inland lake), implausible WTMP traces tracking air
// temperature (45199, 45028), duplicate platforms (twco1, 0.69 km from 45165 and
// same owner), and stations with no served beach inside any plausible cap (45006,
// 45137).
export const NDBC_STATIONS = [
  // Offshore and nearshore NDBC moored buoys whose realtime2 file demonstrably
  // reports a non-"MM" WTMP.
  { id: "45001", lat: 48.061, lon: -87.793, name: "Mid Superior", caps: [CAP_WATER_TEMP] },
  { id: "45002", lat: 45.344, lon: -86.411, name: "North Michigan", caps: [CAP_WATER_TEMP] },
  { id: "45012", lat: 43.621, lon: -77.401, name: "East Lake Ontario", caps: [CAP_WATER_TEMP] },
  { id: "45013", lat: 43.098, lon: -87.85, name: "Atwater Park, WI", caps: [CAP_WATER_TEMP] },
  { id: "45161", lat: 43.185, lon: -86.354, name: "Muskegon, MI", caps: [CAP_WATER_TEMP] },
  { id: "45164", lat: 41.748, lon: -81.698, name: "Cleveland, OH", caps: [CAP_WATER_TEMP] },
  { id: "45165", lat: 41.704, lon: -83.264, name: "Toledo Water Intake, OH", caps: [CAP_WATER_TEMP] },
  { id: "45167", lat: 42.185, lon: -80.135, name: "Erie Nearshore, PA", caps: [CAP_WATER_TEMP] },

  // University and agency nearshore buoys (seasonal, pulled roughly Nov-Apr)
  // plus NOAA National Ocean Service water-level gauges (6-minute cadence, and
  // the backbone of winter coverage). The trailing annotation on each row is its
  // siting and, where the archive shows January/February WTMP, "year-round".
  { id: "4403585", lat: 42.132, lon: -80.27, name: "Walnut Creek, PA", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "4403586", lat: 42.847, lon: -78.904, name: "Buffalo Outer Harbor, NY", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45014", lat: 44.794, lon: -87.758, name: "South Green Bay, WI", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45022", lat: 45.404, lon: -85.088, name: "Little Traverse Bay, MI", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45023", lat: 47.27, lon: -88.607, name: "Keweenaw North Entry, MI", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45024", lat: 43.98, lon: -86.56, name: "Ludington, MI", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45025", lat: 46.969, lon: -88.398, name: "Keweenaw South Entry, MI", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45026", lat: 41.982, lon: -86.619, name: "Stevensville, MI", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45027", lat: 46.86, lon: -91.93, name: "McQuade Harbor, MN", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45029", lat: 42.9, lon: -86.272, name: "Holland Buoy, MI", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45132", lat: 42.46, lon: -81.22, name: "Port Stanley, ON", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45135", lat: 43.78, lon: -76.87, name: "Prince Edward Point, ON", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45136", lat: 48.54, lon: -86.95, name: "Slate Island, ON", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45139", lat: 43.25, lon: -79.53, name: "Grimsby, ON", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45142", lat: 42.74, lon: -79.29, name: "Port Colborne, ON", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45143", lat: 44.94, lon: -80.627, name: "South Georgian Bay, ON", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45147", lat: 42.43, lon: -82.68, name: "Lake St Clair, ON", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45149", lat: 43.54, lon: -82.08, name: "Southern Lake Huron", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45154", lat: 46.05, lon: -82.64, name: "North Channel East, ON", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45159", lat: 43.77, lon: -78.98, name: "Ajax, ON", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45168", lat: 42.397, lon: -86.331, name: "South Haven, MI", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45170", lat: 41.755, lon: -86.968, name: "Michigan City, IN", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45174", lat: 42.135, lon: -87.655, name: "Wilmette Buoy, IL", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45175", lat: 45.825, lon: -84.772, name: "Mackinac Straits West, MI", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45176", lat: 41.55, lon: -81.765, name: "Cleveland Crib, OH", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45183", lat: 44.982, lon: -85.831, name: "Sleeping Bear Dunes, MI", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45186", lat: 42.368, lon: -87.795, name: "Waukegan Buoy, IL", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45187", lat: 42.491, lon: -87.779, name: "Winthrop Harbor Buoy, IL", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45191", lat: 43.388, lon: -78.192, name: "Oak Orchard, NY", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45194", lat: 45.803, lon: -84.792, name: "McGulpin Point, MI", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45197", lat: 41.619, lon: -81.617, name: "Euclid, OH", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45198", lat: 41.892, lon: -87.563, name: "Chicago Buoy, IL", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45200", lat: 41.724, lon: -83.37, name: "Maumee Bay, OH", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45201", lat: 41.601, lon: -82.781, name: "Erie Islands, OH", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45202", lat: 41.532, lon: -82.941, name: "Port Clinton, OH", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45203", lat: 41.393, lon: -82.512, name: "Huron, OH", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45204", lat: 41.508, lon: -82.115, name: "Sheffield Lake, OH", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45205", lat: 41.501, lon: -81.748, name: "Cleveland Edgewater, OH", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45207", lat: 41.731, lon: -81.367, name: "Mentor, OH", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45208", lat: 41.913, lon: -80.807, name: "Ashtabula, OH", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45209", lat: 43.129, lon: -82.391, name: "Lakeport, MI", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45210", lat: 44.055, lon: -87.05, name: "Rawley Point East, WI", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45211", lat: 46.973, lon: -86.568, name: "Grand Island North, MI", caps: [CAP_WATER_TEMP] },   // open_lake, seasonal
  { id: "45213", lat: 47.588, lon: -86.588, name: "East Superior Spotter", caps: [CAP_WATER_TEMP] },   // open_lake, year-round
  { id: "45215", lat: 43.501, lon: -76.539, name: "Oswego, NY", caps: [CAP_WATER_TEMP] },   // nearshore, year-round
  { id: "45216", lat: 46.907, lon: -89.354, name: "Ontonagon, MI", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45217", lat: 46.708, lon: -92, name: "Wisconsin Point, WI", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45222", lat: 42.126, lon: -80.148, name: "Presque Isle Beach 2, PA", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "45223", lat: 42.144, lon: -80.139, name: "Presque Isle Beach 6, PA", caps: [CAP_WATER_TEMP] },   // nearshore, seasonal
  { id: "alxn6", lat: 44.331, lon: -75.934, name: "Alexandria Bay, NY", caps: [CAP_WATER_TEMP] },   // channel, year-round
  { id: "bufn6", lat: 42.878, lon: -78.89, name: "Buffalo, NY", caps: [CAP_WATER_TEMP] },   // harbor, year-round
  { id: "cavn6", lat: 44.13, lon: -76.333, name: "Cape Vincent, NY", caps: [CAP_WATER_TEMP] },   // channel, year-round
  { id: "cndo1", lat: 41.542, lon: -81.637, name: "Cleveland (NOS), OH", caps: [CAP_WATER_TEMP] },   // nearshore, year-round
  { id: "dtlm4", lat: 45.993, lon: -83.898, name: "De Tour Village, MI", caps: [CAP_WATER_TEMP] },   // channel, year-round
  { id: "dulm5", lat: 46.776, lon: -92.092, name: "Duluth, MN", caps: [CAP_WATER_TEMP] },   // channel, year-round
  { id: "faio1", lat: 41.764, lon: -81.281, name: "Fairport Harbor, OH", caps: [CAP_WATER_TEMP] },   // river_mouth, year-round
  { id: "gdmm5", lat: 47.749, lon: -90.341, name: "Grand Marais, MN", caps: [CAP_WATER_TEMP] },   // harbor
  { id: "hlnm4", lat: 42.773, lon: -86.213, name: "Holland, MI", caps: [CAP_WATER_TEMP] },   // channel, year-round
  { id: "hrbm4", lat: 43.846, lon: -82.643, name: "Harbor Beach, MI", caps: [CAP_WATER_TEMP] },   // harbor, year-round
  { id: "lpnm4", lat: 45.063, lon: -83.429, name: "Alpena, MI", caps: [CAP_WATER_TEMP] },   // harbor
  { id: "macm4", lat: 45.777, lon: -84.721, name: "Mackinaw City, MI", caps: [CAP_WATER_TEMP] },   // harbor, year-round
  { id: "mnmm4", lat: 45.096, lon: -87.59, name: "Menominee, MI", caps: [CAP_WATER_TEMP] },   // river_mouth, year-round
  { id: "mrho1", lat: 41.544, lon: -82.731, name: "Marblehead, OH", caps: [CAP_WATER_TEMP] },   // nearshore, year-round
  { id: "pnlm4", lat: 45.968, lon: -85.869, name: "Port Inland, MI", caps: [CAP_WATER_TEMP] },   // harbor, year-round
];

// Pure. Every station carrying a capability. Never mutated; callers must treat
// the returned array as read-only.
export function stationsWithCapability(capability) {
  const out = [];
  for (let i = 0; i < NDBC_STATIONS.length; i++) {
    const st = NDBC_STATIONS[i];
    if (st.caps.indexOf(capability) !== -1) {
      out.push(st);
    }
  }
  return out;
}

// Pure. Nearest station able to serve the given capability and within that
// capability's own cap, as { id, lat, lon, name, distanceKm, capability }, or
// null when the point is invalid, the capability is unknown, or nothing is close
// enough.
//
// The capability is the first parameter and has no default: a default argument
// would let a call site inherit an eligibility rule it never asked for. An
// unknown capability is a programming error rather than a data condition, so it
// logs loudly and returns null rather than falling back to some list.
export function nearestStationFor(capability, lat, lon) {
  if (NDBC_CAPABILITIES.indexOf(capability) === -1) {
    console.log("ndbcBuoys: nearestStationFor called with unknown capability " + String(capability));
    return null;
  }
  if (typeof lat !== "number" || !isFinite(lat) ||
      typeof lon !== "number" || !isFinite(lon)) {
    return null;
  }
  const pool = stationsWithCapability(capability);
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < pool.length; i++) {
    const d = distanceKm(lat, lon, pool[i].lat, pool[i].lon);
    if (d < bestDist) {
      bestDist = d;
      best = pool[i];
    }
  }
  if (best === null || bestDist > CAPABILITY_MAX_KM[capability]) {
    return null;
  }
  return {
    id: best.id,
    lat: best.lat,
    lon: best.lon,
    name: best.name,
    distanceKm: bestDist,
    capability: capability
  };
}

// The sanctioned call-site entry point. The reading is in the function name, so a
// reviewer sees which list is consulted without opening this module.
export function nearestWaterTempStation(lat, lon) {
  return nearestStationFor(CAP_WATER_TEMP, lat, lon);
}

// There is deliberately no capability-agnostic nearestStation export: the absent
// name turns "the wrong list" from a silent wrong answer into an esbuild "No
// matching export" build failure and an immediate vitest failure.

// Pure. Realtime2 file URL for a station id.
//
// Upcasing the id is load-bearing. NDBC's realtime2 filenames are uppercase and
// the path is case-sensitive, answering a lowercase alphanumeric id with a 404,
// while the master station table spells those same stations lowercase. The
// failure is invisible: fetchText logs "HTTP 404" and returns null,
// stationWaterTemp returns null, and a null reading is indistinguishable from the
// winter gap this module treats as normal, so the beach silently loses its
// temperature. A no-op for every numeric id.
export function stationUrl(stationId) {
  return NDBC_REALTIME2_BASE + String(stationId).toUpperCase() + ".txt";
}

// Pure. Parse a data row's leading "YYYY MM DD hh mm" fields into an epoch-ms
// UTC timestamp, or null when any field is missing/non-numeric. NDBC realtime2
// timestamps are UTC.
function rowTimestampMs(fields) {
  if (!Array.isArray(fields) || fields.length < 5) {
    return null;
  }
  const yr = parseInt(fields[0], 10);
  const mo = parseInt(fields[1], 10);
  const dy = parseInt(fields[2], 10);
  const hr = parseInt(fields[3], 10);
  const mn = parseInt(fields[4], 10);
  if (!isFinite(yr) || !isFinite(mo) || !isFinite(dy) ||
      !isFinite(hr) || !isFinite(mn)) {
    return null;
  }
  const ms = Date.UTC(yr, mo - 1, dy, hr, mn, 0);
  if (!isFinite(ms)) {
    return null;
  }
  return ms;
}

// Pure. A WTMP token in Celsius, or null. "MM" (missing), non-numeric, or
// outside the [MIN_REASONABLE_C, MAX_REASONABLE_C] sanity band all degrade to
// null. 0 C (near-freezing water) is a legitimate finite reading and passes.
function wtmpCelsius(token) {
  if (typeof token !== "string") {
    return null;
  }
  if (token === "MM") {
    return null;
  }
  const v = parseFloat(token);
  if (!isFinite(v) || v < MIN_REASONABLE_C || v > MAX_REASONABLE_C) {
    return null;
  }
  return v;
}

// Pure. Walks data rows newest-first and returns { value, tsMs } for the first
// row whose column at columnIndex parses to a non-null value and whose UTC
// timestamp is fresh: within maxAgeMs of nowIso and no more than
// NDBC_MAX_OBS_FUTURE_MS in the future. Because rows are newest-first, once the
// freshest row carrying a real value is itself too old, every row below it is
// older, so the walk stops and returns null. Comment and blank lines are skipped;
// every guard or parse failure degrades to null, never a wrong reading.
//
// Carries no color or flag knowledge of its own, so a second consumer cannot
// reach src/rules.js through it.
function freshestRow(text, nowIso, columnIndex, parseToken, maxAgeMs) {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  if (typeof nowIso !== "string" || nowIso.length === 0) {
    return null;
  }
  const nowMs = Date.parse(nowIso);
  if (!isFinite(nowMs)) {
    return null;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0 || line.charAt(0) === "#") {
      continue;
    }
    const fields = line.split(/\s+/);
    if (fields.length <= columnIndex) {
      continue;
    }
    const value = parseToken(fields[columnIndex]);
    if (value === null) {
      // Newer row with a masked/invalid column — keep scanning older rows.
      continue;
    }
    const tsMs = rowTimestampMs(fields);
    if (tsMs === null) {
      continue;
    }
    // Reject readings too far in the future (clock skew) or older than the
    // freshness window. Rows are newest-first, so once the first row carrying a
    // real value is stale, every row below it is older.
    if (tsMs - nowMs > NDBC_MAX_OBS_FUTURE_MS) {
      continue;
    }
    if (nowMs - tsMs > maxAgeMs) {
      return null;
    }
    return { value: value, tsMs: tsMs };
  }
  return null;
}

// Pure. (realtime2 body text, nowIso) -> { tempF, tempC, observedIso } | null.
// A wrapper over freshestRow on the WTMP column: the freshest row whose WTMP is a
// finite non-"MM" Celsius value inside the sanity band and whose UTC timestamp is
// within NDBC_WATER_TEMP_MAX_OBS_AGE_MS of nowIso. Any parse issue, masked column
// or stale reading degrades to null, never a wrong temperature. Display-only:
// this value never reaches src/rules.js.
export function parseNdbcWaterTempF(text, nowIso) {
  const row = freshestRow(text, nowIso, WTMP_INDEX, wtmpCelsius, NDBC_WATER_TEMP_MAX_OBS_AGE_MS);
  if (row === null) {
    return null;
  }
  const tempF = celsiusToFahrenheit(row.value);
  if (typeof tempF === "number" && isFinite(tempF)) {
    return { tempF: tempF, tempC: row.value, observedIso: new Date(row.tsMs).toISOString() };
  }
  return null;
}

// Range ceiling for a water-temp fetch. The NOS gauges that dominate the station
// set publish every 6 minutes, so their realtime2 files run to ~1 MB where an
// hourly buoy's is ~50 KB; fetching all of that to read one row would put tens of
// megabytes into a deadline-bounded cron gather.
//
// Rows are newest first, so the wanted reading is always in the first few KB, and
// 32 KB holds ~34 h of six-minute rows against a 12 h freshness window.
// Truncation can only drop the oldest rows, and a half-row at the tail fails the
// field-count guard in freshestRow. NDBC honors Range and fetchText treats 206 as
// ok; a server that ignored Range returns the full body, which parses
// identically.
export const NDBC_HEAD_BYTES = 32768;

// Cron-side only. Fetches a station's realtime2 file and resolves its freshest
// valid water temperature at nowIso as { tempF, tempC, observedIso }, or null.
// Keyed by station id rather than beach, so the cron fetches each unique station
// once and fans the reading out. Never throws across the boundary. Display-only:
// it never reaches src/rules.js and colors no flag.
export async function stationWaterTemp(stationId, nowIso, env) {
  const text = await fetchText(stationUrl(stationId), {
    headers: { Range: "bytes=0-" + String(NDBC_HEAD_BYTES - 1) },
    logPrefix: "ndbcBuoys: water-temp fetch failed for station " + stationId
  });
  if (text === null) {
    return null;
  }
  try {
    return parseNdbcWaterTempF(text, nowIso);
  } catch (err) {
    console.log(
      "ndbcBuoys: water-temp parse failed for station " + stationId + ": " + err.message
    );
    return null;
  }
}
