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
// Two hazards this parser defends against, both of which would surface a wrong
// official color:
//   1. Stale prior-season rows are mixed in: an individual (beach, category)
//      record can be a year old while its siblings are fresh. Only the newest
//      record per beach is kept, and it is discarded outright past 36 hours.
//   2. "Red Afterhours - Swimming Prohibited" is CPD's blanket nightly
//      no-lifeguard closure, firing at every beach outside 11am-7pm. It is a
//      closure, not a hazard signal, so it is still reported red — swimming is
//      prohibited — but the reason string preserves the after-hours distinction
//      so it is never conflated with a genuine daytime hazard ban.
//
// The three category rows per beach disagree and carry independent timestamps.
// Water Quality is frequently the freshest while reading "Green" even when the
// Surf and Weather rows say "Red Afterhours - Swimming Prohibited", so picking
// the single newest row would report an official green for a beach where
// swimming is prohibited. Instead the most severe color among the beach's fresh
// rows wins (double-red > red > yellow > green): a green water-quality row can
// never override a red surf row. Over-reporting, a bacteria red while surf is
// green, is the safe direction for a product that must never emit a wrong green.
//
// Most-severe-wins protects a fresh red surf row but not a stale one. If a
// beach's Surf row goes stale while its Water Quality row stays fresh and green,
// the most severe survivor is that lone green — a false official green for a
// beach whose surf state is unknown. So a beach may report green only when its
// own Surf row is fresh and classifiable; a fresh green Water Quality or Weather
// row alone yields no data for that beach. Red, yellow and double-red keep the
// plain most-severe gate, which is the safe direction.

import { fetchText, FLAG_SEVERITY, perBeachResult } from "./util.js";

export const CHICAGO_FLAG_STATUS_URL =
  "https://www.chicagoparkdistrict.com/flag-status";

const CHICAGO_PROGRAM_LABEL =
  "Chicago Park District Beach Flag Program";

// The endpoint returns 200 to a browser-like User-Agent; Workers' fetch sends
// none by default.
export const CHICAGO_USER_AGENT =
  "Mozilla/5.0 (swim.report; +https://swim.report)";

// Records whose newest timestamp is older than this (relative to nowIso) are
// treated as stale prior-season leftovers and dropped.
const CHICAGO_MAX_AGE_HOURS = 36;

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
  // Double red = water fully closed, the most severe status. Checked first so it
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

// True when a record is the beach's Surf Conditions category, the only row that
// can justify a green resolution. CPD labels the category in both the title
// (" - Surf Conditions") and the type field; either matching is enough, so a
// label change on one field still classifies.
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

// Pure. (text, nowIso) -> sites[] | null; null only on malformed or non-array
// JSON, or an unparseable nowIso. Groups the three category rows by trimmed
// parent, discards any individual row older than CHICAGO_MAX_AGE_HOURS, and
// resolves each beach to the most severe color among its surviving fresh rows. A
// beach with no fresh, confidently classifiable row is omitted rather than given
// a guessed color, and a beach resolving to green is omitted too unless its own
// Surf row is among the fresh classified rows.
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
    // A green resolution is trustworthy only when the beach's own Surf row is
    // fresh. If green rests solely on a fresh Water Quality or Weather row, the
    // real surf state is unknown, so omit the beach rather than emit a false
    // green. Yellow, red and double-red keep the plain gate.
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
