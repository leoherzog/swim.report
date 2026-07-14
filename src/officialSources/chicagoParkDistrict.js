// src/officialSources/chicagoParkDistrict.js
// Official scraper for the Chicago Park District lakefront beach flag program.
// scrape() runs cron-side only; parseChicagoFlags is pure and exported for
// tests. Contract v2 multi-site (per-beach) shape.
//
// Source: an undocumented but unauthenticated Drupal JSON view that powers the
// CPD "flag-status" widget. It returns ~69 records (23 beaches x 3 categories:
// Surf Conditions / Weather / Water Quality), each shaped
//   { title, type, nid, date_1, date (unix seconds string), parent (beach
//     name, sometimes with a trailing space), weight, flag, url, description }.
//
// Two product hazards this parser must defend against (both would surface a
// WRONG official color, the worst possible bug):
//   1. Stale prior-season rows are mixed in — an individual (beach, category)
//      record can be ~1 year old while its siblings are fresh. We keep only the
//      newest record per beach AND hard-discard it if older than 36 hours.
//   2. "Red Afterhours - Swimming Prohibited" is CPD's blanket nightly
//      no-lifeguard closure that fires at every beach outside 11am-7pm — it is
//      a closure, not a hazard signal. We still report it as red (swimming IS
//      prohibited) but the reason string preserves the after-hours distinction
//      so it is never conflated with a genuine daytime hazard ban.
//
// Each beach carries THREE category rows: Surf Conditions (the real-time
// hazard flag), Weather, and Water Quality (bacteria). These rows disagree and
// carry independent timestamps. Water Quality is frequently the FRESHEST row
// while reading "Green", even while the Surf/Weather rows say
// "Red Afterhours - Swimming Prohibited". Picking the single newest row per
// beach would therefore report an official GREEN for a beach where swimming is
// prohibited — the worst possible bug. Instead we take the MOST SEVERE color
// among the beach's fresh rows (double-red > red > yellow > green): a "green"
// water-quality row can never override a "red" surf row, so we never
// under-report a hazard. Over-reporting (a bacteria red while surf is green) is
// safe and honest for a hazard product that must never emit a wrong green.
//
// CATEGORY-AWARE STALENESS (the residual false-green path): most-severe-wins
// protects a fresh RED surf row, but not a STALE one. If a beach's Surf row
// goes >36h stale (dropped by the per-row gate) while its Water Quality row
// stays fresh and green, most-severe among the survivors is that lone green —
// a false official green for a beach whose actual surf state is unknown. So a
// beach may report GREEN only when its OWN Surf/flag row is fresh and
// classifiable. A fresh green Water Quality (or Weather) row alone, with the
// Surf row stale or missing, yields NO DATA for that beach rather than green.
// Red/yellow/double-red resolutions keep the plain most-severe gate — those are
// the safe direction. We always fail toward no-data, never toward a wrong color.

import { fetchText, FLAG_SEVERITY, perBeachResult } from "./util.js";

export const CHICAGO_FLAG_STATUS_URL =
  "https://www.chicagoparkdistrict.com/flag-status";

export const CHICAGO_PROGRAM_LABEL =
  "Chicago Park District Beach Flag Program";

// The endpoint returns 200 to a browser-like User-Agent; Workers' fetch sends
// none by default.
export const CHICAGO_USER_AGENT =
  "Mozilla/5.0 (swim.report; +https://swim.report)";

// Records whose newest timestamp is older than this (relative to nowIso) are
// treated as stale prior-season leftovers and dropped.
export const CHICAGO_MAX_AGE_HOURS = 36;

// Build the ?q= cachebust from the digits of nowIso — deterministic, and never
// reads the wall clock.
export function cachebustFromNowIso(nowIso) {
  const digits = String(nowIso == null ? "" : nowIso).replace(/[^0-9]/g, "");
  return digits.length > 0 ? digits : "0";
}

// Pure. Given a trimmed beach name, produce lowercase substring keys used by
// resolveSiteForBeach: the full name and, when it ends in " beach", the name
// with that suffix removed. Deduplicated, empty entries dropped.
export function beachNameKeys(parentTrimmed) {
  const keys = [];
  const lower = String(parentTrimmed).trim().toLowerCase();
  if (lower.length > 0) {
    keys.push(lower);
    if (/ beach$/.test(lower)) {
      const shorter = lower.replace(/ beach$/, "").trim();
      if (shorter.length > 0 && keys.indexOf(shorter) === -1) {
        keys.push(shorter);
      }
    }
  }
  return keys;
}

// FLAG_SEVERITY (imported above) picks the most restrictive fresh row per
// beach. Higher wins. CPD never flies double-red, but the shared ranking
// includes it for completeness.

// Classify a single CPD flag string. Returns { color, afterhours } or null when
// the string is not a confidently mappable green/yellow/red (anything
// unexpected degrades to null -> that row is ignored, never guessed).
function classifyFlag(flag) {
  if (typeof flag !== "string" || flag.length === 0) {
    return null;
  }
  // Double red = water fully closed, the most severe status. Checked FIRST so it
  // can never be down-graded to a plain "red" (or dropped to no-data, which
  // would let the beach fall back to a benign swim.report estimate — an
  // effective under-report of an official water-closed).
  if (/double[\s-]?red/i.test(flag)) {
    return { color: "double-red", afterhours: /afterhours/i.test(flag) };
  }
  // After-hours no-lifeguard closure: swimming is prohibited (red), but flag it
  // so the reason string can note it is a scheduling closure, not a hazard.
  if (/afterhours/i.test(flag)) {
    return { color: "red", afterhours: true };
  }
  if (/^green/i.test(flag)) {
    return { color: "green", afterhours: false };
  }
  if (/^yellow/i.test(flag)) {
    return { color: "yellow", afterhours: false };
  }
  if (/^red/i.test(flag)) {
    return { color: "red", afterhours: false };
  }
  return null;
}

// True when a record is the beach's Surf Conditions (real-time hazard flag)
// category — the only row that can justify a GREEN resolution. CPD labels the
// category in both the title (" - Surf Conditions") and type fields; match
// either defensively so a label change on one field still classifies. Weather
// and Water Quality rows return false and can never, on their own, produce green.
function isSurfCategory(record) {
  const title = typeof record.title === "string" ? record.title : "";
  const type = typeof record.type === "string" ? record.type : "";
  return /surf/i.test(title) || /surf/i.test(type);
}

// Build the per-site reason string for a resolved beach color.
function reasonForBeach(afterhours, parentTrimmed) {
  if (afterhours) {
    return "Official flag reported by " + CHICAGO_PROGRAM_LABEL + " for " +
      parentTrimmed +
      " (after-hours closure — swimming prohibited while lifeguards are off duty)";
  }
  return "Official flag reported by " + CHICAGO_PROGRAM_LABEL + " for " +
    parentTrimmed;
}

// Pure, exported for tests. (text, nowIso) -> sites[] | null.
// null only on malformed / non-array JSON or unparseable nowIso. Groups the
// three category rows by trimmed parent, discards any INDIVIDUAL row older than
// CHICAGO_MAX_AGE_HOURS relative to nowIso, and resolves each beach to the MOST
// SEVERE color among its surviving fresh rows (so a fresh "green" water-quality
// row can never override a "red" surf row). A beach with no fresh, confidently
// classifiable row is omitted entirely — never assigned a guessed color. A beach
// that resolves to GREEN is ALSO omitted unless its own Surf row is among the
// fresh classified rows: a green resting only on a fresh Water Quality/Weather
// row (Surf row stale or missing) is no-data, never a false official green.
export function parseChicagoFlags(text, nowIso) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    console.log("chicagoParkDistrict: JSON parse failed: " + err.message);
    return null;
  }
  if (!Array.isArray(data)) {
    return null;
  }

  const nowMs = Date.parse(nowIso);
  if (!isFinite(nowMs)) {
    console.log("chicagoParkDistrict: unparseable nowIso: " + String(nowIso));
    return null;
  }
  const minEpochSec = Math.floor(nowMs / 1000) - CHICAGO_MAX_AGE_HOURS * 3600;

  // Per beach, track the most severe fresh classified row. On a severity tie,
  // prefer a genuine (non-after-hours) row so a real daytime hazard is never
  // relabeled as a mere after-hours closure.
  const byBeach = Object.create(null);
  for (const record of data) {
    if (!record || typeof record.parent !== "string") {
      continue;
    }
    const parentTrimmed = record.parent.trim();
    if (parentTrimmed.length === 0) {
      continue;
    }
    const epochSec = parseInt(record.date, 10);
    if (!isFinite(epochSec)) {
      continue;
    }
    // MANDATORY staleness gate, applied PER ROW: a stale prior-season row must
    // never contribute a color (in either direction).
    if (epochSec < minEpochSec) {
      continue;
    }
    const classified = classifyFlag(record.flag);
    if (!classified) {
      continue;
    }
    // This row is fresh AND confidently classified. Ensure a beach entry exists
    // so hasFreshSurf can accumulate independently of which row wins on severity.
    let current = byBeach[parentTrimmed];
    if (!current) {
      current = {
        parent: parentTrimmed,
        color: null,
        afterhours: false,
        severity: 0,
        hasFreshSurf: false
      };
      byBeach[parentTrimmed] = current;
    }
    // A fresh, classifiable Surf row is the sole license for a GREEN resolution.
    if (isSurfCategory(record)) {
      current.hasFreshSurf = true;
    }
    const severity = FLAG_SEVERITY[classified.color];
    const better = current.color === null ||
      severity > current.severity ||
      (severity === current.severity && current.afterhours && !classified.afterhours);
    if (better) {
      current.color = classified.color;
      current.afterhours = classified.afterhours;
      current.severity = severity;
    }
  }

  const sites = [];
  const parents = Object.keys(byBeach);
  for (const parent of parents) {
    const entry = byBeach[parent];
    // Category-aware staleness: a GREEN resolution is trustworthy only when the
    // beach's own Surf/flag row is fresh. If green rests solely on a fresh Water
    // Quality / Weather row while the Surf row is stale or missing, the real surf
    // state is unknown — omit the beach (no data) rather than emit a false green.
    // Yellow/red/double-red keep the plain gate: those are the safe direction.
    if (entry.color === "green" && !entry.hasFreshSurf) {
      continue;
    }
    sites.push({
      siteId: parent.toLowerCase(),
      color: entry.color,
      reason: reasonForBeach(entry.afterhours, parent),
      names: beachNameKeys(parent)
    });
  }
  return sites;
}

function inChicagoBox(beach) {
  return beach.lat >= 41.64 && beach.lat <= 42.10 &&
    beach.lon >= -87.70 && beach.lon <= -87.50;
}

export const chicagoParkDistrict = {
  id: "chicago-park-district",
  label: CHICAGO_PROGRAM_LABEL,
  url: CHICAGO_FLAG_STATUS_URL,
  matches: function(beach) {
    return inChicagoBox(beach);
  },
  scrape: async function(nowIso) {
    const requestUrl = CHICAGO_FLAG_STATUS_URL + "?q=" + cachebustFromNowIso(nowIso);
    const text = await fetchText(requestUrl, {
      headers: { "User-Agent": CHICAGO_USER_AGENT },
      logPrefix: "chicagoParkDistrict: fetch failed"
    });
    if (text === null) {
      return null;
    }
    try {
      const sites = parseChicagoFlags(text, nowIso);
      if (!sites || sites.length === 0) {
        return null;
      }
      return perBeachResult(sites, CHICAGO_FLAG_STATUS_URL, nowIso);
    } catch (err) {
      console.log("chicagoParkDistrict: fetch failed: " + err.message);
      return null;
    }
  }
};
