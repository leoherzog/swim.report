// src/rules.js
// Pure, deterministic, versioned flag-estimation rules engine.
// No fetch, no Date, no env, no imports from clients. Structured inputs in,
// complete FlagEstimate object out. This is the ONLY place in the codebase
// where a flag color is decided for an estimate.

export const RULES_VERSION = "1.2.0";

// Caveat appended to the reason when the cron reports that NWS alerts were
// not checkable for this beach (nws_zone still NULL — the beach has not been
// through NWS point enrichment yet). Distinguishes "alerts checked, none
// active" from "alerts never checked" so a wave-only green can never present
// itself as alert-verified.
export const ALERTS_UNAVAILABLE_CAVEAT = "NWS alerts not yet available for this beach";

export const ALERT_PRECEDENCE = [
  "High Surf Warning",
  "Beach Hazards Statement",
  "High Surf Advisory",
  "Rip Current Statement"
];

const ALERT_COLOR_MAP = {
  "High Surf Warning": "double-red",
  "Beach Hazards Statement": "red",
  "High Surf Advisory": "red",
  "Rip Current Statement": "red"
};

export function metersToFeet(m) {
  if (m === null || m === undefined) {
    return null;
  }
  return m * 3.28084;
}

export function estimateFlag(inputs) {
  const source = inputs || {};

  const beachId = source.beachId !== undefined ? source.beachId : null;
  const alerts = source.alerts !== undefined ? source.alerts : null;
  const ripCurrentRisk = source.ripCurrentRisk !== undefined ? source.ripCurrentRisk : null;
  const waveHeightFt = source.waveHeightFt !== undefined ? source.waveHeightFt : null;
  const windSpeedMph = source.windSpeedMph !== undefined ? source.windSpeedMph : null;
  const windGustMph = source.windGustMph !== undefined ? source.windGustMph : null;
  const sources = source.sources !== undefined ? source.sources : [];
  const updated = source.updated !== undefined ? source.updated : null;
  // alertsCheckable: true when the cron could look up alerts for this beach
  // (it has an nws_zone), false when it could not (not yet NWS-enriched),
  // null/undefined for legacy callers (treated as "no caveat").
  const alertsCheckable = source.alertsCheckable !== undefined ? source.alertsCheckable : null;

  let color = null;
  let reason = null;
  let trigger = null;

  // Step 1: active NWS alerts, evaluated in ALERT_PRECEDENCE order (not input order).
  if (color === null && alerts !== null) {
    for (let i = 0; i < ALERT_PRECEDENCE.length; i++) {
      const eventName = ALERT_PRECEDENCE[i];
      if (alerts.indexOf(eventName) !== -1) {
        color = ALERT_COLOR_MAP[eventName];
        reason = "Active NWS alert: " + eventName;
        trigger = "nws-alert";
        break;
      }
    }
  }

  // Step 2: rip current risk parsed from the NWS Surf Zone Forecast.
  if (color === null) {
    if (ripCurrentRisk === "HIGH") {
      color = "red";
      reason = "NWS surf zone forecast rip current risk: HIGH";
      trigger = "rip-current";
    } else if (ripCurrentRisk === "MODERATE") {
      color = "yellow";
      reason = "NWS surf zone forecast rip current risk: MODERATE";
      trigger = "rip-current";
    }
  }

  // Step 3: wave height from Open-Meteo Marine API (already converted to feet).
  if (color === null && waveHeightFt !== null) {
    trigger = "wave-height";
    if (waveHeightFt >= 4) {
      color = "red";
      reason = "Estimated wave height " + waveHeightFt.toFixed(1) + " ft (at or above 4 ft)";
    } else if (waveHeightFt >= 2) {
      color = "yellow";
      reason = "Estimated wave height " + waveHeightFt.toFixed(1) + " ft (at or above 2 ft)";
    } else {
      color = "green";
      reason = "Estimated wave height " + waveHeightFt.toFixed(1) + " ft (below 2 ft)";
    }
  }

  // Step 4: wind fallback, only when wave data is entirely unavailable.
  const hasWaveData = waveHeightFt !== null;
  const speedKnown = windSpeedMph !== null;
  const gustKnown = windGustMph !== null;

  if (color === null && !hasWaveData && (speedKnown || gustKnown)) {
    trigger = "wind";
    const speedStr = speedKnown ? String(Math.round(windSpeedMph)) : "n/a";
    const gustStr = gustKnown ? String(Math.round(windGustMph)) : "n/a";

    const isRed = (speedKnown && windSpeedMph >= 25) || (gustKnown && windGustMph >= 35);
    const isYellow = (speedKnown && windSpeedMph >= 15) || (gustKnown && windGustMph >= 25);

    if (isRed) {
      color = "red";
      reason = "No wave data; wind " + speedStr + " mph sustained, " + gustStr +
        " mph gusts (at or above 25 mph sustained or 35 mph gust threshold)";
    } else if (isYellow) {
      color = "yellow";
      reason = "No wave data; wind " + speedStr + " mph sustained, " + gustStr +
        " mph gusts (at or above 15 mph sustained or 25 mph gust threshold)";
    } else {
      color = "green";
      reason = "No wave data; wind " + speedStr + " mph sustained, " + gustStr +
        " mph gusts (below advisory thresholds)";
    }
  }

  // Step 5: terminal fallbacks.
  if (color === null) {
    if (ripCurrentRisk === "LOW") {
      color = "green";
      reason = "NWS surf zone forecast rip current risk: LOW; no wave or wind data available";
      trigger = "rip-current-low";
    } else {
      color = "unknown";
      reason = "No usable data from NWS alerts, surf zone forecast, or Open-Meteo wave and wind models";
      trigger = "no-data";
    }
  }

  // Honesty caveat: when alerts were not checkable for this beach (nws_zone
  // still NULL), say so explicitly so a wave/wind/no-data estimate is never
  // read as "alerts were checked and none were active". Skipped only when an
  // alert itself decided the color (contradictory input — alerts were
  // evidently available).
  if (alertsCheckable === false && trigger !== "nws-alert") {
    reason = reason + " (" + ALERTS_UNAVAILABLE_CAVEAT + ")";
  }

  return {
    beachId: beachId,
    color: color,
    reason: reason,
    trigger: trigger,
    rules_version: RULES_VERSION,
    official: false,
    sources: sources,
    updated: updated
  };
}
