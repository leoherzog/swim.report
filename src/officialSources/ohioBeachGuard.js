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

export const OHIO_BEACHGUARD_PAGE =
  "https://publicapps.odh.ohio.gov/BeachGuardPublic/";
export const OHIO_BEACHGUARD_API =
  "https://publicapps.odh.ohio.gov/beachguardpublic/api/beacheslist/";

// Workers' fetch sends no User-Agent by default; identify ourselves politely
// against this internal-looking ODH host.
export const OHIO_USER_AGENT = "swim.report (hello@swim.report)";

// Hardcoded ODH BeachGuard numeric ids for the four western Lake Erie beaches
// in scope, with coordinates and name substrings taken from the live payloads.
// beachName in the source has formatting quirks (e.g. a stray extra paren in
// "Maumee Bay State Park (ERIE))"), so we match on stable lowercase substrings.
// 162 also covers South Bass Island's "Stone Beach", but ONLY by proximity —
// "stone beach" is deliberately NOT in names[] because it is a generic label
// that recurs across the Great Lakes; matching it as a name substring would
// attribute South Bass Island's official flag to any unrelated "Stone Beach".
// The two Maumee Bay entries (ERIE lake shore vs INLAND lake) sit ~0.2 mi
// apart; ERIE is listed first and carries the generic "maumee bay" name so a
// lake-shore beach name-matches the correct (Lake Erie) site, with INLAND
// resolvable only by proximity.
export const OHIO_SITES = [
  {
    id: "162",
    siteId: "south-bass-island",
    beachName: "South Bass Island State Park",
    lat: 41.643074,
    lon: -82.839073,
    names: ["south bass island"]
  },
  {
    id: "153",
    siteId: "maumee-bay-erie",
    beachName: "Maumee Bay State Park (ERIE)",
    lat: 41.685799,
    lon: -83.378098,
    names: ["maumee bay"]
  },
  {
    id: "154",
    siteId: "maumee-bay-inland",
    beachName: "Maumee Bay State Park (INLAND)",
    lat: 41.683412,
    lon: -83.376428,
    names: []
  },
  {
    id: "148",
    siteId: "kelleys-island",
    beachName: "Kelleys Island State Park",
    lat: 41.613113,
    lon: -82.70105,
    names: ["kelleys island"]
  }
];

// matches() and resolution both treat a site as covering ~2 mi of shoreline.
export const OHIO_SITE_RADIUS_MI = 2;

// ODH's "Recreational Public Health Advisory" issued at the warning level
// (HAB_WARNING_ADV, typeSeverityLevel 4) tells the public to avoid all contact
// with the water — a no-swim / closure-equivalent condition -> red. Every other
// active advisory (bacteria contamination advisory, HAB watch, or any
// unrecognized current advisory) is a non-green caution -> yellow. A current
// advisory of ANY kind can never be green.
const RED_ADVISORY_TYPE_IDS = ["HAB_WARNING_ADV"];

// Pure. Haversine great-circle distance in statute miles.
function distanceMi(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const earthRadiusMi = 3958.8;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * earthRadiusMi * Math.asin(Math.sqrt(a));
}

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

// Pure. Maps a current advisory to a flag color. HAB_WARNING_ADV (or any
// severity >= 4) means avoid-all-contact / no-swim -> red; every other active
// advisory is a non-green caution -> yellow. Never returns green.
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
  matches: function(beach) {
    if (!beach) {
      return false;
    }
    const haystack = ((beach.park_name || "") + " " + (beach.name || "")).toLowerCase();
    for (const site of OHIO_SITES) {
      for (const name of site.names) {
        if (haystack.indexOf(name) !== -1) {
          return true;
        }
      }
      if (typeof beach.lat === "number" && typeof beach.lon === "number") {
        if (distanceMi(beach.lat, beach.lon, site.lat, site.lon) <= OHIO_SITE_RADIUS_MI) {
          return true;
        }
      }
    }
    return false;
  },
  scrape: async function(nowIso) {
    const sites = [];
    // Fetch each beach detail once (4 subrequests); isolate failures per id so
    // one bad upstream never poisons the others.
    for (const site of OHIO_SITES) {
      try {
        const response = await fetch(OHIO_BEACHGUARD_API + site.id, {
          headers: {
            "User-Agent": OHIO_USER_AGENT,
            "Accept": "application/json"
          }
        });
        if (!response.ok) {
          console.log(
            "ohioBeachGuard: fetch failed for id " + site.id +
            ": HTTP " + response.status
          );
          continue;
        }
        const record = parseBeachesListJson(await response.text());
        if (!record) {
          console.log("ohioBeachGuard: no record for id " + site.id);
          continue;
        }
        const parsed = parseOhioBeach(record, site, nowIso);
        if (parsed) {
          sites.push(parsed);
        }
      } catch (err) {
        console.log(
          "ohioBeachGuard: fetch failed for id " + site.id + ": " + err.message
        );
      }
    }
    if (sites.length === 0) {
      return null;
    }
    return {
      perBeach: true,
      sites: sites,
      source: OHIO_BEACHGUARD_PAGE,
      sources: [OHIO_BEACHGUARD_PAGE],
      // Fallback for sites without their own updated (monitored-and-clear
      // greens, whose "no advisory" state is live at query time). Advisory
      // sites carry updated: the advisory's issue date, which wins in
      // scrapeOfficialFlagFromResult.
      updated: nowIso
    };
  }
};
