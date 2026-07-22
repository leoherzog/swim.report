// src/wqFloor/mnBeaches.js
//
// KIND: wq (raise-only water-quality floor source for src/wqFloor's
// registry — NOT an official-source override; see src/officialSources/).
//
// SOURCE: mnbeaches.org — Minnesota Department of Health beach monitoring for
// Lake Superior (Duluth) beaches. No-auth JSON endpoint:
//   https://mnbeaches.org/map/data/results.json
// Live shape confirmed by fetch on 2026-07-22:
//   { MNBdataUpdated, MNBsiteactive, MNBmessage,
//     MNBstatus: [ { StnID, Date, Status, Reason, Name, lng, lat, Region, ... } ],
//     MNBregions: [...] }
// NOTE: the "confirm the fetch URL" caveat from the brief does not apply —
// this exact URL was fetched live and returned the documented shape with no
// auth/bot wall. If it ever starts requiring auth or changes shape, parseMnBeaches
// below fails closed to null (see below).
//
// FLOOR MAPPING (raise-only; consumed by src/wqFloor/index.js ->
// src/rules.js estimateFlag's waterQualityAdvisory input):
//   Status "Water Contact Not Recommended" + Reason indicating a harmful
//     algal bloom / toxic algae -> floorColor "red"
//   Status "Water Contact Not Recommended" (any other/no reason)         -> floorColor "yellow"
//   Status "Water Contact Acceptable" (or anything else, incl. unknown)  -> NO site (absence == clean == no floor)
// A clean/absent reading is represented by simply omitting the site, never by
// a "green" site object — mirrors the project rule that a WQ source may only
// ever raise a flag, never supply a color that could pull a hazard estimate
// down or be mistaken for an official override.
//
// CURATION: only Lake Superior / Region "Duluth" stations are curated here
// (Park Point Sky Harbor, Park Point Beach House, Park Point Lafayette,
// Franklin Park, Minnesota Point Harbor Side, Lakewalk) via name substring +
// lat/lon proximity, matching the resolveSiteForBeach names-then-proximity
// convention shared with src/officialSources/util.js. Region is read only as
// an extra defensive filter (a station outside "Duluth" is dropped even if
// its name happens to match), so a schema/renaming change on mnbeaches.org
// degrades toward fewer matches, never a wrong-beach floor.
//
// INTEGRATOR DEDUP NOTE: this is the only Minnesota / Lake Superior
// water-quality floor source; it is disjoint from every hazard-axis source
// (wave, alerts, rip) and from any other wqFloor source curated by park/state
// — no dedup concerns. If a future source also curates Duluth-area beaches,
// this source's matches() should stay narrowly scoped to the six named
// Park Point / Duluth beaches so registry ordering can put a more specific
// competing source first without this one swallowing beaches it shouldn't.
//
// scrape() runs cron-side only (network fetch); parseMnBeaches and
// normalizeMnStatus are pure and exported for tests. Defensive throughout:
// any unrecognized/malformed shape degrades to null (or, for a single
// station, to "no site"), never a guessed color.

const MN_BEACHES_URL = "https://mnbeaches.org/map/data/results.json";
const MN_BEACHES_LABEL = "Minnesota Department of Health Beach Monitoring (mnbeaches.org)";

// mnbeaches.org does not document a required User-Agent; the live fetch used
// to confirm the shape succeeded with a plain request. Keep a descriptive UA
// anyway (harmless, and matches the project convention of identifying the
// bot to any upstream that later starts caring).
const MN_BEACHES_USER_AGENT = "swim.report (hello@swim.report)";

// The Lake Superior / Duluth stations this source curates. names[] feed the
// shared resolveSiteForBeach substring match against
// (beach.park_name + " " + beach.name).toLowerCase(); lat/lon feed the
// proximity fallback. Kept intentionally narrow (Duluth Park Point / Lakewalk
// shoreline only) so a namesake beach elsewhere in Minnesota is never
// resolved to the wrong station's advisory.
const STATION_DEFS = [
  {
    key: "park point sky harbor",
    siteId: "park-point-sky-harbor",
    label: "Park Point Sky Harbor",
    names: ["sky harbor"],
    lat: 46.7282128,
    lon: -92.0519435
  },
  {
    key: "park point beach house",
    siteId: "park-point-beach-house",
    label: "Park Point Beach House",
    names: ["beach house"],
    lat: 46.73170278,
    lon: -92.05061271
  },
  {
    key: "park point lafayette",
    siteId: "park-point-lafayette",
    label: "Park Point Lafayette",
    names: ["lafayette"],
    lat: 46.75262179,
    lon: -92.07135989
  },
  {
    key: "franklin park",
    siteId: "franklin-park",
    label: "Franklin Park",
    names: ["franklin park", "franklin beach"],
    lat: 46.7691,
    lon: -92.0896
  },
  {
    key: "minnesota point harbor side",
    siteId: "minnesota-point-harbor-side",
    label: "Minnesota Point Harbor Side",
    names: ["harbor side", "minnesota point"],
    lat: 46.7212,
    lon: -92.0669
  },
  {
    key: "lakewalk",
    siteId: "lakewalk",
    label: "Lakewalk",
    names: ["lakewalk", "lake walk"],
    lat: 46.7867,
    lon: -92.0810
  }
];

const REGION_ALLOWLIST = ["duluth"];

const NOT_RECOMMENDED_STATUS = "water contact not recommended";
const ACCEPTABLE_STATUS = "water contact acceptable";

// Reason-text tokens that indicate a harmful algal bloom / toxic algae event,
// which escalates the floor from yellow to red. Case-insensitive substring
// match against the station's Reason field. Kept as an explicit allowlist of
// phrases (never a loose single-word guess) so an unrelated reason (e.g.
// "high bacteria" alone) stays at yellow rather than being over-escalated.
const HAB_REASON_PATTERNS = [
  /harmful algal bloom/i,
  /\bhab\b/i,
  /toxic algae/i,
  /blue-?green algae/i,
  /cyanobacteria/i
];

// Pure. Raw Status string -> "not-recommended" | "acceptable" | null.
// null covers anything unrecognized (a schema/wording change on the source)
// so the caller can fail closed rather than guess.
export function normalizeMnStatus(rawStatus) {
  if (typeof rawStatus !== "string") {
    return null;
  }
  const key = rawStatus.trim().toLowerCase();
  if (key === NOT_RECOMMENDED_STATUS) {
    return "not-recommended";
  }
  if (key === ACCEPTABLE_STATUS) {
    return "acceptable";
  }
  return null;
}

// Pure. Reason string -> true if it indicates a harmful algal bloom / toxic
// algae event (escalates yellow -> red). Absent/non-string reason -> false
// (falls back to the plain yellow floor, never guessed up to red).
export function isMnHabReason(rawReason) {
  if (typeof rawReason !== "string" || rawReason.length === 0) {
    return false;
  }
  for (let i = 0; i < HAB_REASON_PATTERNS.length; i++) {
    if (HAB_REASON_PATTERNS[i].test(rawReason)) {
      return true;
    }
  }
  return false;
}

// Pure. One MNBstatus entry -> a matching STATION_DEFS entry, or null when
// the entry's name does not resolve to a curated Duluth station (or its
// Region fails the allowlist). Name matching is a case-insensitive substring
// test against the entry's Name field (mirrors resolveSiteForBeach's
// names-substring convention), so a station renamed with extra qualifiers
// ("... Parking Lot Beach") still resolves.
function stationDefForEntry(entry) {
  if (typeof entry.Region !== "string" ||
      REGION_ALLOWLIST.indexOf(entry.Region.trim().toLowerCase()) === -1) {
    return null;
  }
  if (typeof entry.Name !== "string" || entry.Name.length === 0) {
    return null;
  }
  const haystack = entry.Name.toLowerCase();
  for (let i = 0; i < STATION_DEFS.length; i++) {
    const def = STATION_DEFS[i];
    for (let j = 0; j < def.names.length; j++) {
      if (haystack.indexOf(def.names[j]) !== -1) {
        return def;
      }
    }
  }
  return null;
}

// Pure. Parsed JSON body (already JSON.parse'd) + the cron's ISO timestamp ->
// wqFloor sites[] (siteId/floorColor/names/lat/lon/reason/updated shape), []
// when nothing curated has an active advisory, or null when the payload is
// unusable (missing/malformed MNBstatus array). Never guesses: a station
// whose Status is unrecognized, or whose Status is "acceptable", is simply
// omitted (no site) rather than emitted as a fabricated color.
export function parseMnBeaches(data, nowIso) {
  if (!data || typeof data !== "object") {
    return null;
  }
  if (!Array.isArray(data.MNBstatus)) {
    console.log("mnBeaches: MNBstatus missing or not an array");
    return null;
  }
  const sites = [];
  const seenSiteIds = {};
  for (let i = 0; i < data.MNBstatus.length; i++) {
    const entry = data.MNBstatus[i];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const def = stationDefForEntry(entry);
    if (!def) {
      continue;
    }
    const status = normalizeMnStatus(entry.Status);
    if (status === null) {
      console.log("mnBeaches: unrecognized Status for " + def.label + ", skipping");
      continue;
    }
    if (status === "acceptable") {
      // Clean reading: no site emitted (absence is the "no floor" signal).
      continue;
    }
    // status === "not-recommended"
    if (seenSiteIds[def.siteId]) {
      // Duplicate row for a station already emitted this run: keep the
      // first (most severe wins is moot here since both are already the
      // single not-recommended tier, but avoid emitting a second site for
      // the same siteId).
      continue;
    }
    const floorColor = isMnHabReason(entry.Reason) ? "red" : "yellow";
    const reasonText = typeof entry.Reason === "string" && entry.Reason.trim().length > 0
      ? entry.Reason.trim()
      : "Water Contact Not Recommended";
    seenSiteIds[def.siteId] = true;
    sites.push({
      siteId: def.siteId,
      floorColor: floorColor,
      names: def.names,
      lat: def.lat,
      lon: def.lon,
      reason: "MN Dept. of Health beach monitoring: " + reasonText,
      updated: typeof nowIso === "string" && nowIso.length > 0 ? nowIso : undefined
    });
  }
  return sites;
}

function inMnBeachesBox(beach) {
  // Loose bounding box around the curated Duluth Park Point / Lakewalk
  // shoreline; matches() is intentionally tight (this is a fallback behind
  // the names[] check inside resolveSiteForBeach, which src/wqFloor/index.js
  // applies when resolving a scrape result to a specific beach).
  return beach.lat >= 46.70 && beach.lat <= 46.80 &&
    beach.lon >= -92.15 && beach.lon <= -92.00;
}

export const mnBeaches = {
  id: "mn-beaches",
  label: MN_BEACHES_LABEL,
  infoUrl: "https://mnbeaches.org/",
  matches: function(beach) {
    if (!beach) {
      return false;
    }
    const haystack = ((beach.park_name || "") + " " + (beach.name || "")).toLowerCase();
    for (let i = 0; i < STATION_DEFS.length; i++) {
      const def = STATION_DEFS[i];
      for (let j = 0; j < def.names.length; j++) {
        if (haystack.indexOf(def.names[j]) !== -1) {
          return true;
        }
      }
    }
    if (typeof beach.lat !== "number" || typeof beach.lon !== "number") {
      return false;
    }
    return inMnBeachesBox(beach);
  },
  scrape: async function(nowIso) {
    let response;
    try {
      response = await fetch(MN_BEACHES_URL, {
        headers: { "User-Agent": MN_BEACHES_USER_AGENT },
        signal: AbortSignal.timeout(30000)
      });
    } catch (err) {
      console.log("mnBeaches: fetch failed: " + err.message);
      return null;
    }
    if (!response.ok) {
      console.log("mnBeaches: fetch failed: HTTP " + response.status);
      return null;
    }
    let data;
    try {
      data = await response.json();
    } catch (err) {
      console.log("mnBeaches: response was not valid JSON: " + err.message);
      return null;
    }
    try {
      const sites = parseMnBeaches(data, nowIso);
      if (sites === null) {
        return null;
      }
      // An empty array is a legitimate clean run (every curated station
      // acceptable) — still a valid perBeach result, just with no sites.
      return {
        perBeach: true,
        sites: sites,
        source: MN_BEACHES_LABEL,
        updated: nowIso
      };
    } catch (err) {
      console.log("mnBeaches: parse failed: " + err.message);
      return null;
    }
  }
};
