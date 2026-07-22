// src/wqFloor/evanstonStatusfy.js
//
// KIND: wq — a RAISE-ONLY water-quality-style floor source (src/wqFloor). It
// feeds rules.js estimateFlag's "waterQualityAdvisory" input (step 7), where it
// may raise a flag UP to red (worst-of by SEVERITY_RANK) but can NEVER pull a
// hazard estimate down. It is NOT an official override (official:false) — a
// clean/absent reading is the ABSENCE of a site (resolves to null -> zero
// effect), so it can never mask a wave/rip/alert estimate.
//
// SOURCE: City of Evanston, Illinois beach status via RainoutLine / Statusfy.
// One server-rendered HTML page per beach at
//   https://statusfy.com/8474480034/{ext}   (ext 1..6)
// Each page carries a status element (documented as
//   <strong class="status-3">Closed</strong>) plus a free-text reason and a
// data-timestamp. The SIX Evanston Lake Michigan beaches are:
//   1 Lighthouse, 2 Clark St, 3 Dog Beach, 4 Greenwood, 5 Lee St, 6 South Blvd.
//
// COLOR / FLOOR MAPPING (extremely defensive, RAISE-ONLY):
//   status-3 "Closed" is AMBIGUOUS — it is posted BOTH for after-hours
//   OPERATIONAL closures ("closed ... outside of posted swimming hours ...
//   reopen when lifeguards go on duty") AND for genuine HAZARD closures
//   ("Beach Hazard Statement", "dangerous", "high waves/surf", "rip current",
//   "swim ban"). So:
//     - status-3 Closed AND the reason matches an explicit HAZARD-phrase
//       whitelist -> floorColor "red".
//     - EVERYTHING ELSE -> NO site (null): after-hours "outside posted swimming
//       hours" / "lifeguards go on duty", an "Open"/status-1 page (a staffing
//       gate, NOT a green surf flag), any non-whitelisted closure string, an
//       unknown status code, or unparseable markup. Mapping after-hours-closed
//       to red would false-red ~14 h every night; that is the bug this gate
//       exists to prevent.
//   No source ever emits yellow, green, or double-red here — only red, and only
//   on an affirmative hazard phrase. Absence of an advisory == no floor.
//
// DEDUP: this is a NEW axis (Evanston operational/hazard closure) surfaced
// through the water-quality floor mechanism. It does not overlap the NWS/ECCC
// alert lane, the SRF rip lane, or the Open-Meteo/GLOS wave lane — it only
// RAISES, never competes with, those estimates. No dedup concern.
//
// FETCH-URL / MARKUP CONFIRMATION: the live page renders through JS/markdown so
// the exact status-3 class + data-timestamp attribute markup could not be
// byte-verified here. The parser is written to the DOCUMENTED shape and FAILS
// CLOSED to null on any deviation (missing/unknown status code, no whitelisted
// hazard phrase). If the markup differs from the documented form, this source
// simply emits no floor (safe direction) until the selectors are confirmed.
//
// scrape() runs CRON-SIDE ONLY. parseStatusfyPage / isEvanstonHazardReason /
// parseStatusfyStatus / normalizeStatusfyTimestamp are pure and exported for
// unit tests (no network).

import { fetchText } from "../officialSources/util.js";

export const STATUSFY_BASE = "https://statusfy.com/8474480034/";
export const EVANSTON_LABEL = "City of Evanston Beach Status";

// The six Evanston Lake Michigan beaches, keyed by their Statusfy page ext.
// names[] feed resolveSiteForBeach (substring match against park_name + name);
// they are kept tight and distinctive so one beach's closure can never be
// attributed to a sibling. lat/lon are the proximity fallback; radiusMi is kept
// small (0.6 mi) because the six beaches sit close together along the shore, so
// a missing-name beach still resolves to its NEAREST site, not a neighbor.
export const EVANSTON_SITE_DEFS = [
  { ext: "1", siteId: "evanston-lighthouse", label: "Lighthouse Beach", names: ["lighthouse"], lat: 42.0611, lon: -87.6741, radiusMi: 0.6 },
  { ext: "2", siteId: "evanston-clark-st", label: "Clark Street Beach", names: ["clark st", "clark street"], lat: 42.0578, lon: -87.6721, radiusMi: 0.6 },
  { ext: "3", siteId: "evanston-dog-beach", label: "Dog Beach", names: ["dog beach"], lat: 42.0533, lon: -87.6707, radiusMi: 0.6 },
  { ext: "4", siteId: "evanston-greenwood", label: "Greenwood Street Beach", names: ["greenwood"], lat: 42.0500, lon: -87.6695, radiusMi: 0.6 },
  { ext: "5", siteId: "evanston-lee-st", label: "Lee Street Beach", names: ["lee st", "lee street"], lat: 42.0433, lon: -87.6668, radiusMi: 0.6 },
  { ext: "6", siteId: "evanston-south-blvd", label: "South Boulevard Beach", names: ["south blvd", "south boulevard"], lat: 42.0300, lon: -87.6640, radiusMi: 0.6 }
];

// Explicit HAZARD-phrase whitelist. A status-3 "Closed" reason must match one of
// these (case-insensitive substring) to become a red floor. Deliberately narrow
// and surf/safety-specific — anything not on this list (notably the nightly
// "outside of posted swimming hours" / "lifeguards go on duty" operational
// closure) yields NO floor. Never widen this to a generic "closed" match.
const HAZARD_PATTERNS = [
  /beach hazard statement/,
  /dangerous/,
  /high waves?/,
  /high surf/,
  /rip current/,
  /swim ban/
];

// Statusfy status codes we understand. 3 = Closed, 1 = Open. Any other code is
// unknown and fails closed to null (we never guess a status we do not
// recognize).
const STATUS_CLOSED = 3;

// Pure. True only if the free-text reason affirmatively names a surf/safety
// hazard from the whitelist. A missing/non-string reason -> false (no floor).
export function isEvanstonHazardReason(reason) {
  if (typeof reason !== "string" || reason.length === 0) {
    return false;
  }
  const lower = reason.toLowerCase();
  for (let i = 0; i < HAZARD_PATTERNS.length; i++) {
    if (HAZARD_PATTERNS[i].test(lower)) {
      return true;
    }
  }
  return false;
}

// Pure. Strip HTML tags to plain text and collapse whitespace.
function stripTags(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Pure. Normalize a raw data-timestamp value to an ISO string, or null if it
// cannot be confidently parsed. Accepts epoch seconds, epoch milliseconds, or a
// date string. Uses new Date() ONLY to interpret the GIVEN value (never for
// "current time"), consistent with the project's pure-parser rule.
export function normalizeStatusfyTimestamp(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const trimmed = raw.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    let ms = parseInt(trimmed, 10);
    if (!isFinite(ms)) {
      return null;
    }
    // <= 10 digits reads as epoch SECONDS; wider reads as milliseconds.
    if (trimmed.length <= 10) {
      ms = ms * 1000;
    }
    const dateFromEpoch = new Date(ms);
    if (isNaN(dateFromEpoch.getTime())) {
      return null;
    }
    return dateFromEpoch.toISOString();
  }
  const dateFromString = new Date(trimmed);
  if (isNaN(dateFromString.getTime())) {
    return null;
  }
  return dateFromString.toISOString();
}

// Pure. Extract the status code, the visible status word, the reason snippet,
// and any raw data-timestamp from ONE Statusfy page's HTML. Returns
//   { code:number, word:string, reason:string, rawTimestamp:string|null }
// or null when no status element can be located (unusable markup).
// Defensive: matches the status-N class anywhere in a (possibly multi-class)
// class attribute; the reason is scoped to the text that FOLLOWS the status
// element (a bounded window) so unrelated page chrome/legend before it cannot
// leak a hazard phrase in.
export function parseStatusfyStatus(html) {
  if (typeof html !== "string" || html.length === 0) {
    return null;
  }
  const statusRe = /class\s*=\s*["'][^"']*\bstatus-([0-9]+)\b[^"']*["'][^>]*>\s*([^<]*)/i;
  const match = statusRe.exec(html);
  if (match === null) {
    return null;
  }
  const code = parseInt(match[1], 10);
  if (!isFinite(code)) {
    return null;
  }
  const word = match[2].trim().toLowerCase();
  // Reason = the text immediately following the status element, bounded so a
  // distant legend/footer cannot contribute a hazard phrase.
  const after = html.slice(match.index + match[0].length);
  const reason = stripTags(after).slice(0, 400).trim();
  let rawTimestamp = null;
  const tsMatch = /data-timestamp\s*=\s*["']([^"']+)["']/i.exec(html);
  if (tsMatch !== null) {
    rawTimestamp = tsMatch[1];
  }
  return { code: code, word: word, reason: reason, rawTimestamp: rawTimestamp };
}

// Pure. ONE beach page's HTML (+ the cron's ISO timestamp) -> a floor decision
// for that beach, or null when there is no hazard floor to report.
//   Returns { floorColor:"red", reason, updated } when the page shows a
//   status-3 Closed AND the reason matches the hazard whitelist.
//   Returns null for EVERYTHING else (after-hours/operational closure, Open,
//   unknown status, unparseable markup) — the safe RAISE-ONLY direction.
// nowIso is accepted for signature consistency with the project's pure parsers;
// timestamp fallback is handled by the resolver, so nowIso is not consulted here.
export function parseStatusfyPage(html, nowIso) {
  const status = parseStatusfyStatus(html);
  if (status === null) {
    return null;
  }
  // Only a genuine Closed status can be a floor. Open / unknown / a Closed word
  // that disagrees with the code all fail closed to null.
  if (status.code !== STATUS_CLOSED) {
    return null;
  }
  if (status.word.length > 0 && status.word.indexOf("closed") === -1) {
    // Code says closed but the visible word disagrees — contradictory markup,
    // do not guess.
    console.log("evanstonStatusfy: status-3 with non-closed word '" + status.word + "', skipping");
    return null;
  }
  if (!isEvanstonHazardReason(status.reason)) {
    // Closed, but NOT for a whitelisted hazard (e.g. the nightly after-hours
    // closure). No floor — mapping this to red would false-red every night.
    return null;
  }
  const floor = {
    floorColor: "red",
    reason: "City of Evanston beach closure: " + status.reason
  };
  const updated = normalizeStatusfyTimestamp(status.rawTimestamp);
  if (updated !== null) {
    floor.updated = updated;
  }
  return floor;
}

function inEvanstonBox(beach) {
  return typeof beach.lat === "number" && typeof beach.lon === "number" &&
    beach.lat >= 42.02 && beach.lat <= 42.07 &&
    beach.lon >= -87.69 && beach.lon <= -87.66;
}

export const evanstonStatusfy = {
  id: "evanston-statusfy",
  label: EVANSTON_LABEL,
  infoUrl: "https://www.cityofevanston.org/residents/parks-recreation/beaches",
  matches: function(beach) {
    if (/evanston/i.test(beach.name || "")) {
      return true;
    }
    if (/evanston/i.test(beach.park_name || "")) {
      return true;
    }
    return inEvanstonBox(beach);
  },
  // CRON-SIDE ONLY. Fetches all six Statusfy pages and builds a perBeach result
  // of ONLY the beaches under a genuine hazard closure. Returns null only when
  // EVERY page fetch failed (total upstream outage); otherwise returns a
  // perBeach result (possibly with an empty sites[] on a clean run) so a
  // clean-but-nothing run reads as success, not failure. Never throws.
  scrape: async function(nowIso) {
    const sites = [];
    let fetchedAny = false;
    for (let i = 0; i < EVANSTON_SITE_DEFS.length; i++) {
      const def = EVANSTON_SITE_DEFS[i];
      const url = STATUSFY_BASE + def.ext;
      const html = await fetchText(url, {
        logPrefix: "evanstonStatusfy: fetch failed for " + def.siteId
      });
      if (html === null) {
        continue;
      }
      fetchedAny = true;
      try {
        const floor = parseStatusfyPage(html, nowIso);
        if (floor === null) {
          continue;
        }
        const site = {
          siteId: def.siteId,
          floorColor: floor.floorColor,
          reason: floor.reason,
          names: def.names,
          lat: def.lat,
          lon: def.lon,
          radiusMi: def.radiusMi
        };
        if (typeof floor.updated === "string") {
          site.updated = floor.updated;
        }
        sites.push(site);
      } catch (err) {
        console.log("evanstonStatusfy: parse failed for " + def.siteId + ": " + err.message);
        continue;
      }
    }
    if (!fetchedAny) {
      // Total outage — no page could be read. Signal no data (null), not a
      // clean run.
      return null;
    }
    return {
      perBeach: true,
      sites: sites,
      source: EVANSTON_LABEL,
      sources: [EVANSTON_LABEL],
      updated: nowIso
    };
  }
};
