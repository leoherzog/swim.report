// src/displayFlag.js — the one decision of which flag a beach shows: its color,
// its collapsed keyword and the record that supplied it. Every surface that shows
// a beach's flag reads displayFlag and derives none of the three itself.
//
// Pure: no fetch, no clock, no env. It reads only each record's color and the
// official's updated, so liveChipState pairs and liveBeachState blobs decide alike.
import { SEVERITY_RANK, normalizeColor } from "./rules.js";

// The display gate and the default card stale horizon, calibrated to the hourly
// recompute. The alert refresh refuses to lower a flag from inputs this gate
// calls aged, so every reader imports this one value.
export const STALE_MS = 7200000;

// A missing or unparseable instant on either side reads as not stale.
export function isStale(nowIso, updatedIso, thresholdMs) {
  if (!nowIso || !updatedIso) {
    return false;
  }
  const now = Date.parse(nowIso);
  const updated = Date.parse(updatedIso);
  if (Number.isNaN(now) || Number.isNaN(updated)) {
    return false;
  }
  const limit = typeof thresholdMs === "number" ? thresholdMs : STALE_MS;
  return (now - updated) > limit;
}

// A color's four-value keyword: double-red shares red, anything else normalizes.
// The only keyword a data-flag attribute or a map feature may carry.
export function collapseFlagColor(color) {
  const normalized = normalizeColor(color);
  return normalized === "double-red" ? "red" : normalized;
}

function recordOf(value) {
  return value !== null && typeof value === "object" ? value : null;
}

function decision(color, source) {
  return Object.freeze({ color: color, keyword: collapseFlagColor(color), source: source });
}

// "Official" is not the same as "current": several sources are one morning
// reading. Past STALE_MS a posted flag decides only while strictly more severe
// than the estimate, so a fresher estimate can raise the flag but never lower it.
// The gate is the 2 h default, never the record's own staleMs.
/**
 * The flag a beach displays and the record that supplied it.
 * @param {{estimate: ?Object, official: ?Object}} state live records: chip pairs or parsed blobs
 * @param {?string} nowIso the instant the records were lease-resolved at
 * @returns {{color: string, keyword: string, source: string}} frozen decision
 */
export function displayFlag(state, nowIso) {
  const estimate = recordOf(state ? state.estimate : null);
  const official = recordOf(state ? state.official : null);
  const estimateColor = estimate ? normalizeColor(estimate.color) : "unknown";
  const officialColor = official ? normalizeColor(official.color) : "unknown";
  // An official naming no real color is not a posted flag, and decides nothing.
  if (officialColor !== "unknown") {
    // A non-string stamp reads as absent, as liveChipRecord reads it.
    const updated = typeof official.updated === "string" ? official.updated : null;
    if (!isStale(nowIso, updated, STALE_MS)) {
      return decision(officialColor, "official");
    }
    if (SEVERITY_RANK[officialColor] > SEVERITY_RANK[estimateColor]) {
      return decision(officialColor, "official");
    }
  }
  return decision(estimateColor, estimateColor === "unknown" ? "none" : "estimate");
}
