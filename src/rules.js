// src/rules.js — the pure, deterministic, versioned flag-estimation rules engine.
// No fetch, no Date, no env, no client imports: structured inputs in, a complete
// FlagEstimate out. This is the only place an estimated flag color is decided.

export const RULES_VERSION = "1.6.0";

// Flag color severity ordering. The raise-only water-quality floor (step 7)
// compares an advisory's floor color against the already-decided color: it may
// raise the flag to at least the floor color but must never pull a higher hazard
// color down. unknown ranks below green so an advisory can also lift a no-data
// unknown to yellow or red, matching how the NWS floor treats unknown.
//
// Exported because the frontend's displayFlagColor (src/frontend/render.js)
// applies the same raise-only comparison when a point-in-time official reading
// has aged past the recompute horizon. One severity ordering, one place.
export const SEVERITY_RANK = { unknown: 0, green: 1, yellow: 2, red: 3, "double-red": 4 };

// Caveat appended to the reason when the cron reports that weather alerts were
// not checkable for this beach. Distinguishes "alerts checked, none active" from
// "alerts never checked", so a wave-only green can never present itself as
// alert-verified.
export const ALERTS_UNAVAILABLE_CAVEAT = "Weather alerts not yet available for this beach";

// NWS alerts that short-circuit the estimate at step 1, in precedence order:
// tsunami and tropical-cyclone products, beach-hazard products, life-threatening
// severe-weather warnings, high-wind and lakeshore/coastal-flood warnings, and
// the marine warnings matched via a beach's marine_zone. All map to red or
// double-red, so their top precedence can only raise the flag.
//
// Order matters: the loop takes the first match regardless of color, so every
// double-red must precede every red or a red would shadow it. NWS watches and
// advisories are deliberately absent — they are yellow and would mask a
// wave-height red if they short-circuited, so they floor in separately
// (NWS_FLOOR_PRECEDENCE, step 6) where they can only upgrade a green or unknown
// estimate.
export const ALERT_PRECEDENCE = [
  // double-red (most severe) — must come first so a later red cannot shadow them
  "Tsunami Warning",
  "Hurricane Warning",
  "Storm Surge Warning",
  "Extreme Wind Warning",         // tropical-cyclone eyewall, sustained >= 100 kt
  "Tornado Warning",
  "High Surf Warning",
  "Hurricane Force Wind Warning", // marine, sustained >= 64 kt
  "Storm Warning",                // marine, sustained 48-63 kt
  // red
  "Tropical Storm Warning",
  "Tsunami Advisory",
  "Severe Thunderstorm Warning",
  "Beach Hazards Statement",
  "High Surf Advisory",
  "Rip Current Statement",
  "High Wind Warning",
  "Gale Warning",                 // marine, 34-47 kt
  "Special Marine Warning",       // marine, short-fused severe
  "Lakeshore Flood Warning",
  "Coastal Flood Warning"
];

// NWS severe-weather watches and wind/flood/marine advisories, all yellow.
// Applied as a floor at step 6 — raise green or unknown to yellow, never
// downgrade a higher color — rather than as a step-1 short-circuit. "Floor" names
// the mechanism, which is what unifies these members, not any alert subtype.
export const NWS_FLOOR_PRECEDENCE = [
  "Hurricane Watch",
  "Tropical Storm Watch",
  "Storm Surge Watch",
  "Tsunami Watch",
  "Tornado Watch",
  "Severe Thunderstorm Watch",
  "High Wind Watch",
  "Wind Advisory",
  "Lake Wind Advisory",
  "Hurricane Force Wind Watch",   // marine
  "Small Craft Advisory",         // marine
  "Lakeshore Flood Advisory",
  "Coastal Flood Advisory"
];

const ALERT_COLOR_MAP = {
  "Tsunami Warning": "double-red",
  "Hurricane Warning": "double-red",
  "Storm Surge Warning": "double-red",
  "Extreme Wind Warning": "double-red",
  "Tornado Warning": "double-red",
  "High Surf Warning": "double-red",
  "Hurricane Force Wind Warning": "double-red",
  "Storm Warning": "double-red",
  "Tropical Storm Warning": "red",
  "Tsunami Advisory": "red",
  "Severe Thunderstorm Warning": "red",
  "Beach Hazards Statement": "red",
  "High Surf Advisory": "red",
  "Rip Current Statement": "red",
  "High Wind Warning": "red",
  "Gale Warning": "red",
  "Special Marine Warning": "red",
  "Lakeshore Flood Warning": "red",
  "Coastal Flood Warning": "red",
  "Hurricane Watch": "yellow",
  "Tropical Storm Watch": "yellow",
  "Storm Surge Watch": "yellow",
  "Tsunami Watch": "yellow",
  "Tornado Watch": "yellow",
  "Severe Thunderstorm Watch": "yellow",
  "High Wind Watch": "yellow",
  "Wind Advisory": "yellow",
  "Lake Wind Advisory": "yellow",
  "Hurricane Force Wind Watch": "yellow",
  "Small Craft Advisory": "yellow",
  "Lakeshore Flood Advisory": "yellow",
  "Coastal Flood Advisory": "yellow"
};

// Environment and Climate Change Canada issues no beach-specific hazard products
// — there is no rip current, high surf or beach hazards analog in the Canadian
// system — so Canadian beaches map a curated set of severe-weather warnings for
// hazards dangerous to people in or on the water: storm surge, tornado and
// waterspout, squalls, lightning, and damaging onshore wind. ECCC's wind warning
// criteria (sustained >= 50 km/h or gusts >= 90 km/h) sit above this engine's own
// wind-fallback red thresholds.
//
// Watches are deliberately excluded: mapping a watch to yellow would let it mask
// a wave-height red under the strict step precedence. Event names exact-match the
// GeoMet alert_name_en strings, which ECCC serves lowercase.
//
// Marine warnings (src/clients/ecccMarine.js) fold into this same lowercase
// namespace: "storm warning" (marine >= 48 kt, distinct from the land "storm
// surge warning") short-circuits to double-red and "gale warning" (>= 34 kt) to
// red. The two weaker marine products, "strong wind warning" and "marine weather
// advisory", are yellow floors instead (ECCC_FLOOR_PRECEDENCE, step 6), so they
// can never mask a wave-height red.
export const ECCC_ALERT_PRECEDENCE = [
  "tornado warning",
  "storm surge warning",
  "storm warning",
  "squall warning",
  "waterspout warning",
  "severe thunderstorm warning",
  "gale warning",
  "wind warning"
];

// Marine yellow-floor events, raise-only like NWS_FLOOR_PRECEDENCE. Kept out of
// the short-circuit precedence so a strong-wind or marine advisory can only raise
// a green or unknown to yellow, never downgrade a decided higher color.
export const ECCC_FLOOR_PRECEDENCE = [
  "strong wind warning",
  "marine weather advisory"
];

const ECCC_ALERT_COLOR_MAP = {
  "tornado warning": "double-red",
  "storm surge warning": "double-red",
  "storm warning": "double-red",
  "squall warning": "red",
  "waterspout warning": "red",
  "severe thunderstorm warning": "red",
  "gale warning": "red",
  "wind warning": "red",
  "strong wind warning": "yellow",
  "marine weather advisory": "yellow"
};

// The flag color a recognized alert maps to, or null for any other event. NWS
// events (Title Case) and ECCC events (lowercase) share one lookup, since the two
// namespaces cannot collide. Exported so the frontend's hazard lane colors alert
// bands from the same mapping the flag decision uses.
export function alertColorForEvent(eventName) {
  if (Object.prototype.hasOwnProperty.call(ALERT_COLOR_MAP, eventName)) {
    return ALERT_COLOR_MAP[eventName];
  }
  if (Object.prototype.hasOwnProperty.call(ECCC_ALERT_COLOR_MAP, eventName)) {
    return ECCC_ALERT_COLOR_MAP[eventName];
  }
  return null;
}

// The issuing body's display label for a recognized alert event ("NWS" or
// "Environment Canada"), null for unrecognized events. Single home of the
// authority attribution the frontend's hazard-band text uses.
export function alertAuthorityForEvent(eventName) {
  if (Object.prototype.hasOwnProperty.call(ALERT_COLOR_MAP, eventName)) {
    return "NWS";
  }
  if (Object.prototype.hasOwnProperty.call(ECCC_ALERT_COLOR_MAP, eventName)) {
    return "Environment Canada";
  }
  return null;
}

// The flag color a rip-current risk level maps to: HIGH -> red, MODERATE ->
// yellow, anything else (LOW, null, garbage) -> null. Single home of that
// mapping — estimateFlag step 2 and the frontend's hazard lane both use it.
export function ripRiskColor(risk) {
  if (risk === "HIGH") {
    return "red";
  }
  if (risk === "MODERATE") {
    return "yellow";
  }
  return null;
}

// The wave-height color thresholds (2 ft yellow, 4 ft red) live only here, so the
// frontend colors per-hour forecast cells from the same numbers without restating
// them. Returns "red"/"yellow"/"green" for a finite numeric height, null for
// anything else.
export function waveColorForHeight(waveHeightFt) {
  if (typeof waveHeightFt !== "number" || !isFinite(waveHeightFt)) {
    return null;
  }
  if (waveHeightFt >= 4) {
    return "red";
  }
  if (waveHeightFt >= 2) {
    return "yellow";
  }
  return "green";
}

export function estimateFlag(inputs) {
  const source = inputs || {};

  const beachId = source.beachId !== undefined ? source.beachId : null;
  const alerts = source.alerts !== undefined ? source.alerts : null;
  const alertDetails = source.alertDetails !== undefined ? source.alertDetails : null;
  const ripCurrentRisk = source.ripCurrentRisk !== undefined ? source.ripCurrentRisk : null;
  const waveHeightFt = source.waveHeightFt !== undefined ? source.waveHeightFt : null;
  const windSpeedMph = source.windSpeedMph !== undefined ? source.windSpeedMph : null;
  const windGustMph = source.windGustMph !== undefined ? source.windGustMph : null;
  const sources = source.sources !== undefined ? source.sources : [];
  const updated = source.updated !== undefined ? source.updated : null;
  // alertsCheckable: true when the cron could look up alerts for this beach,
  // false when neither authority has enriched it, absent for callers that want no
  // caveat.
  const alertsCheckable = source.alertsCheckable !== undefined ? source.alertsCheckable : null;
  // Raise-only water-quality advisory: { color: "yellow"|"red", reason, source }
  // or null. A clean or absent reading is null and has no effect. It can only
  // raise a flag (step 7), never pull a hazard estimate down, so a clean water
  // reading can never mask a wave, rip or alert red. It lives inside the estimate
  // (official: false) and is never an official override.
  const waterQualityAdvisory = source.waterQualityAdvisory !== undefined ? source.waterQualityAdvisory : null;

  let color = null;
  let reason = null;
  let trigger = null;

  // Step 1: active NWS alerts, evaluated in ALERT_PRECEDENCE order (not input order).
  if (color === null && alerts !== null) {
    for (let i = 0; i < ALERT_PRECEDENCE.length; i++) {
      const eventName = ALERT_PRECEDENCE[i];
      if (alerts.indexOf(eventName) !== -1) {
        color = alertColorForEvent(eventName);
        reason = "Active NWS alert: " + eventName;
        trigger = "nws-alert";
        break;
      }
    }
  }

  // Step 1b: active Environment Canada alerts, in ECCC_ALERT_PRECEDENCE order.
  // Same alerts input, which the cron fills from ECCC for Canadian beaches: a
  // beach is enriched for exactly one authority and the two event-name namespaces
  // cannot collide.
  if (color === null && alerts !== null) {
    for (let i = 0; i < ECCC_ALERT_PRECEDENCE.length; i++) {
      const eventName = ECCC_ALERT_PRECEDENCE[i];
      if (alerts.indexOf(eventName) !== -1) {
        color = alertColorForEvent(eventName);
        reason = "Active Environment Canada alert: " + eventName;
        trigger = "eccc-alert";
        break;
      }
    }
  }

  // Step 2: rip current risk parsed from the NWS Surf Zone Forecast.
  if (color === null) {
    const riskColor = ripRiskColor(ripCurrentRisk);
    if (riskColor !== null) {
      color = riskColor;
      reason = "NWS surf zone forecast rip current risk: " + ripCurrentRisk;
      trigger = "rip-current";
    }
  }

  // Step 3: wave height from the NOAA wave grids, already in feet. Color comes
  // from waveColorForHeight; the per-branch reason strings are built here.
  if (color === null && waveHeightFt !== null) {
    trigger = "wave-height";
    const waveColor = waveColorForHeight(waveHeightFt);
    if (waveColor === "red") {
      color = "red";
      reason = "Estimated wave height " + waveHeightFt.toFixed(1) + " ft (at or above 4 ft)";
    } else if (waveColor === "yellow") {
      color = "yellow";
      reason = "Estimated wave height " + waveHeightFt.toFixed(1) + " ft (at or above 2 ft)";
    } else {
      color = "green";
      reason = "Estimated wave height " + waveHeightFt.toFixed(1) + " ft (below 2 ft)";
    }
  }

  // Step 4: wind fallback, only when wave data is entirely unavailable.
  const speedKnown = windSpeedMph !== null;
  const gustKnown = windGustMph !== null;

  if (color === null && waveHeightFt === null && (speedKnown || gustKnown)) {
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
      reason = "No usable data from NWS alerts, surf zone forecast, or NOAA wave and wind models";
      trigger = "no-data";
    }
  }

  // Step 6: NWS yellow-alert floor. An active severe-weather watch or wind, flood
  // or marine advisory raises an otherwise green or unknown estimate to yellow,
  // but never downgrades a higher color already decided by a warning, rip risk or
  // wave/wind: worst-of, not a short-circuit. Kept out of ALERT_PRECEDENCE
  // precisely so a yellow alert can never mask a wave-height red — the concern
  // that leaves ECCC watches unmapped, resolved for NWS by flooring instead.
  if (alerts !== null && (color === "green" || color === "unknown")) {
    for (let i = 0; i < NWS_FLOOR_PRECEDENCE.length; i++) {
      const eventName = NWS_FLOOR_PRECEDENCE[i];
      if (alerts.indexOf(eventName) !== -1) {
        color = "yellow";
        reason = "Active NWS alert: " + eventName;
        trigger = "nws-floor";
        break;
      }
    }
  }

  // Step 6b: Environment Canada marine yellow floor. A "strong wind warning" or
  // "marine weather advisory" raises a green or unknown estimate to yellow,
  // worst-of like the NWS floor, and never downgrades a decided higher color.
  // Same lowercase namespace as the ECCC short-circuit warnings, kept separate so
  // it can only lift.
  if (alerts !== null && (color === "green" || color === "unknown")) {
    for (let i = 0; i < ECCC_FLOOR_PRECEDENCE.length; i++) {
      const eventName = ECCC_FLOOR_PRECEDENCE[i];
      if (alerts.indexOf(eventName) !== -1) {
        color = "yellow";
        reason = "Active Environment Canada alert: " + eventName;
        trigger = "eccc-floor";
        break;
      }
    }
  }

  // Step 7: raise-only water-quality floor. An active E. coli, bacteria or HAB
  // advisory raises the flag to at least its floor color using SEVERITY_RANK
  // worst-of, and never downgrades a higher color already decided by an alert,
  // rip risk or wave/wind. Water quality is a different axis from surf hazard, so
  // a clean reading is modeled as the absence of an advisory and has no effect —
  // it can never present as a green masking a hazard estimate. Baked into the
  // estimate (official: false), never an official override.
  if (waterQualityAdvisory !== null && typeof waterQualityAdvisory === "object") {
    const floorColor = waterQualityAdvisory.color;
    const decidedRank = SEVERITY_RANK[color] !== undefined ? SEVERITY_RANK[color] : 0;
    if ((floorColor === "yellow" || floorColor === "red") && SEVERITY_RANK[floorColor] > decidedRank) {
      color = floorColor;
      const wqSource = typeof waterQualityAdvisory.source === "string" ? waterQualityAdvisory.source : "unknown";
      const wqDetail = typeof waterQualityAdvisory.reason === "string" ? waterQualityAdvisory.reason : "";
      reason = "Water-quality advisory (" + wqSource + "): " + wqDetail;
      trigger = "wq-floor";
    }
  }

  // Honesty caveat: when alerts were not checkable for this beach, say so
  // explicitly, so a wave, wind or no-data estimate is never read as "alerts were
  // checked and none were active". Skipped only when an alert itself decided the
  // color, since alerts were evidently available.
  if (alertsCheckable === false && trigger !== "nws-alert" && trigger !== "eccc-alert" && trigger !== "nws-floor" && trigger !== "eccc-floor") {
    reason = reason + " (" + ALERTS_UNAVAILABLE_CAVEAT + ")";
  }

  // Echo the structured wave reading whichever branch decided the color, so the UI
  // can show a "now" wave stat without parsing the reason string.
  const echoedWaveHeightFt =
    (typeof waveHeightFt === "number" && isFinite(waveHeightFt)) ? waveHeightFt : null;

  // Echo the structured alert details ({ event, onset, ends }) and the rip-current
  // risk level whichever branch decided the color, so the UI's hazard lane never
  // parses the reason string. Sanitized copies: entries without a string event are
  // dropped, non-string timestamps become null, an unrecognized risk becomes
  // null.
  const echoedAlertDetails = [];
  if (Array.isArray(alertDetails)) {
    for (let i = 0; i < alertDetails.length; i++) {
      const entry = alertDetails[i];
      if (entry === null || typeof entry !== "object" || typeof entry.event !== "string") {
        continue;
      }
      echoedAlertDetails.push({
        event: entry.event,
        onset: (typeof entry.onset === "string" && entry.onset.length > 0) ? entry.onset : null,
        ends: (typeof entry.ends === "string" && entry.ends.length > 0) ? entry.ends : null
      });
    }
  }
  const echoedRipCurrentRisk =
    (ripCurrentRisk === "HIGH" || ripCurrentRisk === "MODERATE" || ripCurrentRisk === "LOW")
      ? ripCurrentRisk : null;

  return {
    beachId: beachId,
    color: color,
    reason: reason,
    trigger: trigger,
    rules_version: RULES_VERSION,
    official: false,
    sources: sources,
    updated: updated,
    waveHeightFt: echoedWaveHeightFt,
    alertDetails: echoedAlertDetails,
    ripCurrentRisk: echoedRipCurrentRisk
  };
}
