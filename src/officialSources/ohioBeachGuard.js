// src/officialSources/ohioBeachGuard.js
// Official scraper for Ohio Department of Health (ODH) BeachGuard, the
// authoritative statewide beach water-quality advisory system for Ohio's Lake
// Erie beaches. scrape() runs cron-side only; every parse helper below is pure
// and exported so tests exercise it against inline fixtures (no network).
//
// Data source: the BeachGuardPublic SPA calls an unauthenticated JSON API at
// the same origin. GET /beachguardpublic/api/beacheslist/{id} returns
//   { queryResults: [ <beachRecord> ], ... }
// where the record carries monitorings[] (per-year swim-season windows) and
// advisories[] (full historical + current advisory list). An unknown id still
// returns HTTP 200 with queryResults: [] (never 404), so callers must check the
// array length, not the HTTP status. Each object repeats a heavy "metadata"
// schema sibling — we never store it; the sites[] we emit contain only the few
// small fields resolution needs.
//
// Product semantics (why monitored-and-clear is an affirmative green):
// BeachGuard IS Ohio's official advisory system of record. When a beach is
// inside its current swim season AND has zero advisories flagged
// isCurrentAdvisory === true, the state is affirmatively reporting "no active
// advisory" — that is an official green, not an absence of data. Outside the
// season window the beach is unmonitored, so we omit it (no color, no KV write)
// rather than guess. Any unparseable date or unexpected shape also omits the
// site — never a guessed color.

import { distanceMi } from "../geo.js";
import { fetchText, perBeachResult } from "./util.js";

export const OHIO_BEACHGUARD_PAGE =
  "https://publicapps.odh.ohio.gov/BeachGuardPublic/";
export const OHIO_BEACHGUARD_API =
  "https://publicapps.odh.ohio.gov/beachguardpublic/api/beacheslist/";

// Workers' fetch sends no User-Agent by default; identify ourselves politely
// against this internal-looking ODH host.
export const OHIO_USER_AGENT = "swim.report (hello@swim.report)";

// Hardcoded ODH BeachGuard beach ids for Ohio's Lake Erie public beaches, with
// coordinates and (where safe) name substrings taken from the live payloads.
//
// This is a CURATED literal table, not a runtime registry fetch. The registry's
// bulk enumeration endpoint (GET /beachguardpublic/api/beacheslist, no id)
// returns all ~192 beaches in one call, but its per-beach monitorings/advisories
// are always null (a summary projection), so the color-bearing detail still
// requires one per-id fetch each — the table is curated here so the hourly
// scrape stays a fixed, budgeted set of subrequests (see PLAN.md section 7).
//
// Selection rule (conservative, objective): every beach whose waterbodyName is
// "Lake Erie" AND beachAccessTypeId is "PUB_PUB_ACC" (genuinely public access)
// AND whose id is a small registry integer. That rule drops (a) ODH's
// NOT_BEACH monitoring/reference stations, (b) PRV_PRV_ACC private beaches, and
// (c) the ~17 Ottawa County residential condo/marina "associations" (which
// carry huge 64-bit opaque ids). A few real public beaches also carry 64-bit
// ids (e.g. Conneaut Sandbar, the Bay Point beaches) and are therefore omitted
// here — under-claiming coverage is the safe direction; they can be added
// explicitly later. beach ids are treated as opaque strings throughout.
//
// beachName in the source has formatting quirks (e.g. a stray extra paren in
// "Maumee Bay State Park (ERIE))" and an escaped backslash in
// "Port Clinton (Deep\\Lakeview))"), so we match on stable lowercase
// substrings, and only DISTINCTIVE, low-collision names go in names[]. Generic
// or common names (e.g. "Battery Park", "Main Street Beach", "Lakeview Beach",
// "Huntington Beach") get an empty names[] and resolve by proximity only —
// putting a generic label in names[] would risk attributing an official flag to
// an unrelated same-named beach (a potential false color, including a false
// green). 162 likewise covers South Bass Island's "Stone Beach" ONLY by
// proximity. The two Maumee Bay entries (ERIE lake shore vs INLAND lake) sit
// ~0.2 mi apart; ERIE is listed first and carries the "maumee bay" name so a
// lake-shore beach name-matches the correct (Lake Erie) site, with INLAND
// resolvable only by proximity. The original four sites are listed first, in
// their original order, so downstream code referencing them by index is stable.
export const OHIO_SITES = [
  { id: "162", siteId: "south-bass-island", beachName: "South Bass Island State Park", lat: 41.643074, lon: -82.839073, names: ["south bass island"] },
  { id: "153", siteId: "maumee-bay-erie", beachName: "Maumee Bay State Park (ERIE)", lat: 41.685799, lon: -83.378098, names: ["maumee bay"] },
  { id: "154", siteId: "maumee-bay-inland", beachName: "Maumee Bay State Park (INLAND)", lat: 41.683412, lon: -83.376428, names: [] },
  { id: "148", siteId: "kelleys-island", beachName: "Kelleys Island State Park", lat: 41.613113, lon: -82.70105, names: ["kelleys island"] },
  { id: "132", siteId: "conneaut-township-park", beachName: "Conneaut Township Park", lat: 41.964471, lon: -80.564447, names: ["conneaut township park"] },
  { id: "141", siteId: "geneva-state-park", beachName: "Geneva State Park", lat: 41.857822, lon: -80.976639, names: ["geneva state park"] },
  { id: "149", siteId: "lakeshore-park", beachName: "Lakeshore Park", lat: 41.908371, lon: -80.774368, names: [] },
  { id: "167", siteId: "walnut-beach", beachName: "Walnut Beach", lat: 41.901466, lon: -80.809662, names: [] },
  { id: "173", siteId: "columbia-park-beach", beachName: "Columbia Park Beach", lat: 41.487000, lon: -81.902000, names: [] },
  { id: "136", siteId: "edgewater-state-park", beachName: "Edgewater State Park", lat: 41.489300, lon: -81.739197, names: ["edgewater state park"] },
  { id: "138", siteId: "euclid-state-park", beachName: "Euclid State Park", lat: 41.584301, lon: -81.568604, names: ["euclid state park"] },
  { id: "145", siteId: "huntington-beach", beachName: "Huntington Beach", lat: 41.490940, lon: -81.934143, names: [] },
  { id: "177", siteId: "parklawn-beach", beachName: "Parklawn Beach", lat: 41.483521, lon: -81.860649, names: [] },
  { id: "185", siteId: "sims-beach", beachName: "Sims Beach", lat: 41.616081, lon: -81.524223, names: [] },
  { id: "166", siteId: "villa-angela-state-park", beachName: "Villa Angela State Park", lat: 41.585098, lon: -81.567703, names: ["villa angela"] },
  { id: "168", siteId: "battery-park", beachName: "Battery Park", lat: 41.451847, lon: -82.673691, names: [] },
  { id: "125", siteId: "bay-view-east", beachName: "Bay View East", lat: 41.468971, lon: -82.819023, names: [] },
  { id: "126", siteId: "bay-view-west", beachName: "Bay View West", lat: 41.473484, lon: -82.826935, names: [] },
  { id: "131", siteId: "beulah-beach", beachName: "Beulah Beach", lat: 41.394360, lon: -82.441200, names: [] },
  { id: "129", siteId: "cedar-point-chausee", beachName: "Cedar Point Chausee", lat: 41.472710, lon: -82.670357, names: [] },
  { id: "133", siteId: "cranberry-creek", beachName: "Cranberry Creek", lat: 41.383141, lon: -82.473312, names: [] },
  { id: "170", siteId: "crystal-rock", beachName: "Crystal Rock", lat: 41.449081, lon: -82.842499, names: [] },
  { id: "134", siteId: "darby-creek", beachName: "Darby Creek", lat: 41.413155, lon: -82.398567, names: [] },
  { id: "140", siteId: "heidelberg-beach", beachName: "Heidelberg Beach", lat: 41.389469, lon: -82.455460, names: [] },
  { id: "164", siteId: "lagoons-beach", beachName: "Lagoons Beach", lat: 41.428600, lon: -82.358543, names: [] },
  { id: "147", siteId: "lake-front-park", beachName: "Lake Front Park", lat: 41.398251, lon: -82.553787, names: [] },
  { id: "1290", siteId: "linwood-beach", beachName: "Linwood Beach", lat: 41.427071, lon: -82.356827, names: [] },
  { id: "152", siteId: "lions-park", beachName: "Lion's Park", lat: 41.448376, lon: -82.747246, names: [] },
  { id: "165", siteId: "main-street-beach", beachName: "Main Street Beach", lat: 41.425282, lon: -82.366257, names: [] },
  { id: "146", siteId: "nickel-plate-beach", beachName: "Nickel Plate Beach", lat: 41.396881, lon: -82.543808, names: ["nickel plate"] },
  { id: "284", siteId: "nokomis-park", beachName: "Nokomis Park", lat: 41.427280, lon: -82.352638, names: [] },
  { id: "155", siteId: "oberlin-beach", beachName: "Oberlin Beach", lat: 41.383930, lon: -82.512543, names: [] },
  { id: "156", siteId: "old-woman-creek-beach", beachName: "Old Woman Creek Beach", lat: 41.384560, lon: -82.514717, names: ["old woman creek"] },
  { id: "1289", siteId: "orchard-beach", beachName: "Orchard Beach", lat: 41.407936, lon: -82.408676, names: [] },
  { id: "157", siteId: "pickerel-creek", beachName: "Pickerel Creek", lat: 41.437355, lon: -82.888077, names: [] },
  { id: "169", siteId: "pipe-creek-wildlife-area", beachName: "Pipe Creek Wildlife Area", lat: 41.451809, lon: -82.673698, names: ["pipe creek"] },
  { id: "159", siteId: "sawmill-creek", beachName: "Sawmill Creek", lat: 41.413715, lon: -82.588402, names: [] },
  { id: "160", siteId: "sherod-park-beach", beachName: "Sherod Park Beach", lat: 41.416969, lon: -82.389671, names: ["sherod park"] },
  { id: "161", siteId: "showse-park", beachName: "Showse Park", lat: 41.430000, lon: -82.309998, names: ["showse park"] },
  { id: "171", siteId: "whites-landing", beachName: "Whites Landing", lat: 41.430901, lon: -82.901520, names: [] },
  { id: "139", siteId: "fairport-harbor", beachName: "Fairport Harbor", lat: 41.758877, lon: -81.274658, names: ["fairport harbor"] },
  { id: "143", siteId: "headlands-state-park", beachName: "Headlands State Park", lat: 41.758127, lon: -81.291788, names: ["headlands"] },
  { id: "130", siteId: "century-beach", beachName: "Century Beach", lat: 41.477936, lon: -82.154121, names: [] },
  { id: "262", siteId: "community-park-beach", beachName: "Community Park Beach", lat: 41.490640, lon: -82.112300, names: [] },
  { id: "151", siteId: "lakeview-beach", beachName: "Lakeview Beach", lat: 41.463783, lon: -82.196075, names: [] },
  { id: "261", siteId: "lakewood-beach-park", beachName: "Lakewood Beach Park", lat: 41.487560, lon: -82.122610, names: [] },
  { id: "254", siteId: "miller-beach", beachName: "Miller Beach", lat: 41.502499, lon: -82.061394, names: [] },
  { id: "128", siteId: "catawba-island-state-park", beachName: "Catawba Island State Park", lat: 41.573357, lon: -82.857498, names: ["catawba island"] },
  { id: "135", siteId: "east-harbor-state-park", beachName: "East Harbor State Park", lat: 41.557709, lon: -82.803314, names: ["east harbor"] },
  { id: "150", siteId: "lakeside-beach", beachName: "Lakeside Beach", lat: 41.546539, lon: -82.750572, names: [] },
  { id: "158", siteId: "port-clinton", beachName: "Port Clinton (Deep\\Lakeview))", lat: 41.514610, lon: -82.925056, names: [] }
];

// matches() and resolution both treat a site as covering ~2 mi of shoreline.
export const OHIO_SITE_RADIUS_MI = 2;

// Coarse pre-fetch off-season window, in America/New_York local time. ODH
// BeachGuard is a summer-only program — samples are collected Memorial Day to
// Labor Day — so for roughly Nov-Apr every one of scrape()'s ~51 per-id
// subrequests returns a payload parseOhioBeach discards (the fine-grained
// per-plan swim-season gate at parseOhioBeach rejects it). isOhioSeasonPossible
// lets scrape() skip that whole fan-out during the off-season, mirroring
// southHaven's pre-fetch gate. The window is deliberately COARSE and wide (the
// fetch window is May 1 - Oct 31 inclusive, months 5..10) so it can never
// suppress in-season data — the real season sits well inside it, and the
// authoritative Memorial-Day-to-Labor-Day check in parseOhioBeach still gates
// the actual color inside the window. Ohio's Lake Erie shore is Eastern time.
const OHIO_FETCH_MONTH_START = 5;  // May
const OHIO_FETCH_MONTH_END = 10;   // October (inclusive)

// Pure. Given the cron's passed-in ISO timestamp, is the current date inside
// the coarse BeachGuard fetch window (May-Oct, America/New_York local)? Parses
// the passed-in string only (no Date.now()); uses Intl for the DST-correct
// local month. A missing/unparseable timestamp is treated as in-season (do not
// gate on a clock we do not have; scrape always supplies one).
export function isOhioSeasonPossible(nowIso) {
  if (typeof nowIso !== "string" || nowIso.length === 0) {
    return true;
  }
  const date = new Date(nowIso);
  if (isNaN(date.getTime())) {
    return true;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric"
  }).formatToParts(date);
  let month = null;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].type === "month") {
      month = parseInt(parts[i].value, 10);
    }
  }
  if (month === null || isNaN(month)) {
    return true;
  }
  return month >= OHIO_FETCH_MONTH_START && month <= OHIO_FETCH_MONTH_END;
}

// scrape() issues one detail subrequest per OHIO_SITES entry (~53). Run them in
// small concurrent chunks — bounded so we stay polite to the ODH host and
// within the subrequest/connection budget — instead of strictly serially.
export const OHIO_FETCH_CHUNK_SIZE = 8;

// Geographic gate for matches(): every BeachGuard site sits on Ohio's Lake
// Erie shoreline, so a beach outside this box can never be one of ours — no
// matter what its name contains. Without this gate the names[] substrings are
// UNBOUNDED and collide with same-named places elsewhere on the Great Lakes
// (real in-pilot examples: Headlands International Dark Sky Park in Mackinaw
// City MI vs "headlands"; Fairport on Michigan's Garden Peninsula vs
// "fairport harbor"), which would attribute an Ohio OFFICIAL flag — including
// an affirmative green — to a beach hundreds of miles away. The box spans the
// full Ohio Lake Erie shore (Toledo to Conneaut) with margin, and stays well
// south of Michigan/Ontario shorelines.
export const OHIO_MATCH_BBOX = {
  minLat: 41.2,
  maxLat: 42.1,
  minLon: -83.6,
  maxLon: -80.4
};

// Advisory typeId -> color, anchored to ODH BeachGuard's OWN published legend
// (reverse-engineered from the BeachGuardPublic SPA's advisory-marker color
// switch, which is literally how ODH renders each advisory type to the public):
//   HAB_WARNING_ADV  (typeSeverityLevel 4) -> ODH red    (#B30000)
//   HAB_WATCH_ADV    (typeSeverityLevel 3) -> ODH orange (#ff8000)
//   CONTAM_ADV       (typeSeverityLevel 1) -> ODH yellow (#e5e500)
//   HAB_CAUTION                            -> ODH blue   (never issued in
//                                             practice; treated as a caution)
//   (no current advisory)                  -> ODH green
// BOTH HAB_* advisories are "Recreational Public Health Advisory" records that
// tell the public to avoid recreational contact with the water — a no-swim /
// closure-equivalent condition. swim.report has only four flag colors
// (green/yellow/red/double-red), so ODH's distinct orange "watch" tier has no
// exact analog; per the project's "only ever more cautious, never a false
// green" bias we collapse it UP to red rather than down to yellow. That keeps a
// HAB watch from being presented as merely a bacteria-level caution. CONTAM_ADV
// (bacteria contamination advisory) is ODH's own lowest / yellow tier by
// design, so it stays yellow — that matches the source of truth, not a guess.
// Any other current advisory is a non-green caution -> yellow. A current
// advisory of ANY kind can never be green.
const RED_ADVISORY_TYPE_IDS = ["HAB_WARNING_ADV", "HAB_WATCH_ADV"];


// Pure. Parses an ISO-8601 timestamp with an explicit offset or "Z" (the format
// used by monitorings swimSeason dates, e.g.
// "2026-05-23T12:34:57.9370000-04:00" with 7-digit fractional seconds) into a
// UTC epoch (ms). Uses only Date.UTC (a pure static computation over supplied
// components — no ambient clock). Returns null on any format surprise.
export function parseIsoToEpoch(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);
  const fraction = match[7] || "";
  const ms = fraction.length > 0
    ? parseInt((fraction + "000").slice(0, 3), 10)
    : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  let offsetMs = 0;
  const zone = match[8];
  if (zone !== "Z") {
    const sign = zone.charAt(0) === "-" ? -1 : 1;
    const offHour = parseInt(zone.slice(1, 3), 10);
    const offMin = parseInt(zone.slice(4, 6), 10);
    offsetMs = sign * (offHour * 60 + offMin) * 60000;
  }
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  if (Number.isNaN(wallUtc)) {
    return null;
  }
  return wallUtc - offsetMs;
}

// Pure. Parses the advisories[] date format, which differs from monitorings:
// "MM/DD/YYYY h:mm AM/PM" for modern records and a bare "MM/DD/YYYY" (no time)
// for old ones, with no timezone published. These are Eastern-time local
// stamps; we compute a timezone-agnostic comparable epoch via Date.UTC (applied
// identically to every record, so relative ordering is correct). Used to break
// ties when picking among concurrent current advisories and to stamp an
// advisory site's updated with its issue date (treating Eastern as UTC skews
// the stamp up to 5h OLDER than reality — the safe direction for a staleness
// signal) — never to gate a color. Returns null on any format surprise.
export function parseAdvisoryDate(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);
  let hour = match[4] !== undefined ? parseInt(match[4], 10) : 0;
  const minute = match[5] !== undefined ? parseInt(match[5], 10) : 0;
  const meridiem = match[6] ? match[6].toUpperCase() : null;
  if (month < 1 || month > 12 || day < 1 || day > 31 || minute > 59) {
    return null;
  }
  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    if (meridiem === "PM" && hour !== 12) {
      hour = hour + 12;
    } else if (meridiem === "AM" && hour === 12) {
      hour = 0;
    }
  } else if (hour > 23) {
    return null;
  }
  const epoch = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(epoch)) {
    return null;
  }
  return epoch;
}

// Pure. Computes the current-year swim-season window as
// { start, end } epoch ms from monitorings[]. There are up to two concurrent
// current-year plans (Algae + Bacteria) with slightly different dates, so we
// take min(swimSeasonStartDate) / max(swimSeasonEndDate) across every
// current-year plan whose dates parse. Returns null when no current-year plan
// has a parseable start AND end (season indeterminable -> omit the site).
export function currentSeasonWindow(monitorings) {
  if (!Array.isArray(monitorings)) {
    return null;
  }
  let start = null;
  let end = null;
  for (const plan of monitorings) {
    if (!plan || plan.isCurrentYear !== true) {
      continue;
    }
    const planStart = parseIsoToEpoch(plan.swimSeasonStartDate);
    const planEnd = parseIsoToEpoch(plan.swimSeasonEndDate);
    if (planStart === null || planEnd === null) {
      continue;
    }
    if (start === null || planStart < start) {
      start = planStart;
    }
    if (end === null || planEnd > end) {
      end = planEnd;
    }
  }
  if (start === null || end === null) {
    return null;
  }
  return { start: start, end: end };
}

// Pure. True when an advisory record describes a CURRENTLY active advisory.
// Primary signal is isCurrentAdvisory === true. As defense in depth against a
// missing/renamed boolean silently downgrading a live hazard to an affirmative
// green, we ALSO treat reopenDate === "Ongoing" as current: the source stamps
// resolved advisories with a real reopen timestamp and active ones with the
// literal string "Ongoing" (live-confirmed on beachId 147). This only ever
// widens detection (a stale "Ongoing" at worst yields a safe caution), never
// narrows it — a false green is unacceptable, a false yellow is tolerable.
export function isCurrentAdvisory(advisory) {
  if (!advisory || typeof advisory !== "object") {
    return false;
  }
  if (advisory.isCurrentAdvisory === true) {
    return true;
  }
  if (typeof advisory.reopenDate === "string" &&
      advisory.reopenDate.trim().toLowerCase() === "ongoing") {
    return true;
  }
  return false;
}

// Pure. Returns the single most relevant CURRENT advisory, or null if none.
// Advisories are NOT in chronological or any reliable document order and the
// array retains full history, so we filter strictly on isCurrentAdvisory (never
// trust index position). Among concurrent current advisories we pick the most
// severe (highest typeSeverityLevel), breaking ties by most recent startDate.
export function selectCurrentAdvisory(advisories) {
  if (!Array.isArray(advisories)) {
    return null;
  }
  let best = null;
  let bestSeverity = -Infinity;
  let bestDate = -Infinity;
  for (const advisory of advisories) {
    if (!isCurrentAdvisory(advisory)) {
      continue;
    }
    const severity = typeof advisory.typeSeverityLevel === "number"
      ? advisory.typeSeverityLevel
      : 0;
    const parsedDate = parseAdvisoryDate(advisory.startDate);
    const dateValue = typeof parsedDate === "number" ? parsedDate : -Infinity;
    if (severity > bestSeverity ||
        (severity === bestSeverity && dateValue > bestDate)) {
      best = advisory;
      bestSeverity = severity;
      bestDate = dateValue;
    }
  }
  return best;
}

// Pure. Maps a current advisory to a flag color. Any HAB advisory
// (HAB_WARNING_ADV or HAB_WATCH_ADV — both advise against water contact — or
// any severity >= 4) means avoid-all-contact / no-swim -> red; every other
// active advisory (bacteria contamination, or an unrecognized current advisory)
// is a non-green caution -> yellow. Never returns green.
export function advisoryColor(advisory) {
  if (!advisory) {
    return null;
  }
  const typeId = typeof advisory.typeId === "string" ? advisory.typeId : "";
  const severity = typeof advisory.typeSeverityLevel === "number"
    ? advisory.typeSeverityLevel
    : 0;
  if (RED_ADVISORY_TYPE_IDS.indexOf(typeId) !== -1 || severity >= 4) {
    return "red";
  }
  return "yellow";
}

function advisoryReason(beachName, advisory) {
  const typeText = typeof advisory.typeText === "string" && advisory.typeText.length > 0
    ? advisory.typeText
    : (typeof advisory.typeId === "string" && advisory.typeId.length > 0
      ? advisory.typeId
      : "active advisory");
  const reasonSuffix = typeof advisory.reasonTypeText === "string" && advisory.reasonTypeText.length > 0
    ? " (" + advisory.reasonTypeText + ")"
    : "";
  // BeachGuard is a periodic-testing source; cite the advisory's own issue date
  // (the sample date) so the reason carries the source's timestamp, not just the
  // cron tick, and a reader can judge how recent the underlying reading is.
  const issued = typeof advisory.startDate === "string" && advisory.startDate.length > 0
    ? ", issued " + advisory.startDate
    : "";
  return "Official advisory reported by Ohio BeachGuard (ODH) for " +
    beachName + ": " + typeText + reasonSuffix + issued;
}

// Pure. Turns one beach record (queryResults[0]) plus its hardcoded site
// metadata into a site object for the multi-site scrape result, or null to omit
// the site. Omission (out of season, indeterminable season, malformed shape) is
// a correct outcome — the beach simply gets no official flag, never a guess.
export function parseOhioBeach(record, siteMeta, nowIso) {
  if (!record || typeof record !== "object" || !siteMeta) {
    return null;
  }
  const nowEpoch = parseIsoToEpoch(nowIso);
  if (nowEpoch === null) {
    return null;
  }
  const window = currentSeasonWindow(record.monitorings);
  if (!window) {
    return null;
  }
  // Outside the monitored swim season -> unmonitored, not a color.
  if (nowEpoch < window.start || nowEpoch > window.end) {
    return null;
  }
  const beachName = typeof record.beachName === "string" && record.beachName.length > 0
    ? record.beachName
    : siteMeta.beachName;
  // An affirmative green requires POSITIVE evidence of zero current advisories:
  // a present advisories[] array we can inspect. A null/missing/non-array
  // advisories field is a malformed or partial payload (the BULK endpoint, for
  // instance, returns advisories: null) — we must NOT read "no advisory field"
  // as "no advisory". Omit the site rather than assert an unverified green.
  if (!Array.isArray(record.advisories)) {
    return null;
  }
  const advisory = selectCurrentAdvisory(record.advisories);
  let color;
  let reason;
  let updated = null;
  if (advisory) {
    color = advisoryColor(advisory);
    reason = advisoryReason(beachName, advisory);
    // updated is the advisory's own issue date, not nowIso: the underlying
    // reading can be arbitrarily old, and stamping the cron tick would hide
    // that behind a fresh timestamp and suppress the UI's stale-data warning.
    // If startDate is unparseable, updated stays null and the resolver falls
    // back to result.updated (nowIso) — an over-fresh timestamp on a
    // yellow/red caution is tolerable; it can never freshen a green.
    const issuedEpoch = parseAdvisoryDate(advisory.startDate);
    if (typeof issuedEpoch === "number") {
      updated = new Date(issuedEpoch).toISOString();
    }
  } else {
    // In season, zero current advisories: BeachGuard is affirmatively reporting
    // no advisory. Monitored-and-clear is an official green. updated stays
    // null -> nowIso: unlike the advisory case there is no source-side record
    // date to cite — "no active advisory" is the live state of Ohio's system
    // of record at query time (advisories are posted and lifted continuously,
    // not on a sampling cadence), so the scrape time IS the assertion time.
    color = "green";
    reason = "Monitored and clear — no active advisory reported by " +
      "Ohio BeachGuard (ODH) for " + beachName;
  }
  const site = {
    siteId: siteMeta.siteId,
    color: color,
    reason: reason,
    names: siteMeta.names,
    lat: siteMeta.lat,
    lon: siteMeta.lon,
    radiusMi: OHIO_SITE_RADIUS_MI
  };
  if (updated) {
    site.updated = updated;
  }
  return site;
}

// Pure. JSON text -> beach record (queryResults[0]) | null. An unknown id
// returns 200 with queryResults: [] (never 404), so an empty array is a valid
// "not found" that must yield null, not throw.
export function parseBeachesListJson(text) {
  try {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.queryResults) || data.queryResults.length === 0) {
      return null;
    }
    return data.queryResults[0];
  } catch (err) {
    console.log("ohioBeachGuard: JSON parse failed: " + err.message);
    return null;
  }
}

export const ohioBeachGuard = {
  id: "ohio-beachguard",
  label: "Ohio Department of Health BeachGuard",
  url: OHIO_BEACHGUARD_PAGE,
  // Health-monitor gate (see the scraper-health step in src/index.js): the
  // off-season pre-fetch skip in scrape() is a DELIBERATE null, not a
  // failure — outside the coarse season window this scraper's nulls must not
  // count toward the consecutive-null alert streak.
  healthMonitored: function(nowIso) {
    return isOhioSeasonPossible(nowIso);
  },
  matches: function(beach) {
    if (!beach) {
      return false;
    }
    // Hard geographic gate FIRST: name substrings only apply to beaches that
    // are physically on Ohio's Lake Erie shore. A Michigan/Ontario beach whose
    // (park) name happens to contain an Ohio site substring must never claim
    // this scraper — resolveSiteForBeach's name pass would then bind it to the
    // Ohio site and publish a wrong official color (possibly a false green).
    if (typeof beach.lat !== "number" || typeof beach.lon !== "number" ||
        beach.lat < OHIO_MATCH_BBOX.minLat || beach.lat > OHIO_MATCH_BBOX.maxLat ||
        beach.lon < OHIO_MATCH_BBOX.minLon || beach.lon > OHIO_MATCH_BBOX.maxLon) {
      return false;
    }
    const haystack = ((beach.park_name || "") + " " + (beach.name || "")).toLowerCase();
    for (const site of OHIO_SITES) {
      for (const name of site.names) {
        if (haystack.indexOf(name) !== -1) {
          return true;
        }
      }
      if (distanceMi(beach.lat, beach.lon, site.lat, site.lon) <= OHIO_SITE_RADIUS_MI) {
        return true;
      }
    }
    return false;
  },
  scrape: async function(nowIso) {
    // Coarse off-season pre-fetch guard: BeachGuard is summer-only, so for
    // roughly Nov-Apr the whole ~51-request fan-out returns payloads
    // parseOhioBeach discards. Skip every fetch and report no data, mirroring
    // southHaven's pre-fetch gate. The authoritative per-plan swim-season check
    // in parseOhioBeach still applies inside the window.
    if (!isOhioSeasonPossible(nowIso)) {
      console.log("ohioBeachGuard: outside coarse swim season, skipping fetch");
      return null;
    }
    // Fetch each beach detail once (one subrequest per OHIO_SITES entry — the
    // bulk listing endpoint omits monitorings/advisories, so per-id detail is
    // required; see PLAN.md section 7 for the budget). Resolve one site to its
    // parsed color-or-null; never throws so Promise.allSettled below isolates
    // failures per id and one bad upstream never poisons the others.
    async function fetchOhioSite(site) {
      const text = await fetchText(OHIO_BEACHGUARD_API + site.id, {
        headers: {
          "User-Agent": OHIO_USER_AGENT,
          "Accept": "application/json"
        },
        logPrefix: "ohioBeachGuard: fetch failed for id " + site.id
      });
      if (text === null) {
        return null;
      }
      try {
        const record = parseBeachesListJson(text);
        if (!record) {
          console.log("ohioBeachGuard: no record for id " + site.id);
          return null;
        }
        return parseOhioBeach(record, site, nowIso);
      } catch (err) {
        console.log(
          "ohioBeachGuard: fetch failed for id " + site.id + ": " + err.message
        );
        return null;
      }
    }
    // Small concurrent chunks (in OHIO_SITES order) rather than one awaited
    // subrequest at a time, so a slow id no longer serially delays every id
    // after it. Order and total subrequest count are unchanged.
    const sites = [];
    for (let i = 0; i < OHIO_SITES.length; i += OHIO_FETCH_CHUNK_SIZE) {
      const chunk = OHIO_SITES.slice(i, i + OHIO_FETCH_CHUNK_SIZE);
      const settled = await Promise.allSettled(chunk.map(fetchOhioSite));
      for (const outcome of settled) {
        if (outcome.status === "fulfilled" && outcome.value) {
          sites.push(outcome.value);
        }
      }
    }
    if (sites.length === 0) {
      return null;
    }
    // perBeachResult's updated (nowIso) is the fallback for sites without their
    // own updated (monitored-and-clear greens, whose "no advisory" state is live
    // at query time). Advisory sites carry updated: the advisory's issue date,
    // which wins in scrapeOfficialFlagFromResult.
    return perBeachResult(sites, OHIO_BEACHGUARD_PAGE, nowIso);
  }
};
