// src/rules.js
// Pure, deterministic, versioned flag-estimation rules engine.
// No fetch, no Date, no env, no imports from clients. Structured inputs in,
// complete FlagEstimate object out. This is the ONLY place in the codebase
// where a flag color is decided for an estimate.

export const RULES_VERSION = "1.5.0";

// Flag color severity ordering. The raise-only water-quality floor (step 7)
// uses this to compare an advisory's floor color against the already-decided
// color: it may raise the flag UP to at least the floor color but must NEVER
// pull a higher hazard color down. unknown ranks below green so an advisory can
// also lift a no-data unknown to yellow/red (a real advisory is more actionable
// than "no data"), matching how the NWS floor treats unknown.
const SEVERITY_RANK = { unknown: 0, green: 1, yellow: 2, red: 3, "double-red": 4 };

// Caveat appended to the reason when the cron reports that weather alerts
// were not checkable for this beach (neither NWS nor ECCC enrichment has
// resolved it yet). Distinguishes "alerts checked, none active" from "alerts
// never checked" so a wave-only green can never present itself as
// alert-verified.
export const ALERTS_UNAVAILABLE_CAVEAT = "Weather alerts not yet available for this beach";

// NWS alerts that SHORT-CIRCUIT the estimate at step 1, in precedence order
// (first match wins the color and reason). Beach-hazard products, life-threatening
// severe-weather WARNINGS (tornado, severe thunderstorm), high-wind and
// lakeshore/coastal-flood WARNINGS, plus the marine WARNINGS (storm/gale/special
// marine — matched via a beach's marine_zone) — all map to red or double-red, so
// their top precedence can only raise, never lower, the flag. ORDER MATTERS: the
// loop takes the first match regardless of color, so every double-red MUST precede
// every red or a red would shadow it. NWS WATCHES / ADVISORIES are deliberately NOT
// here: they are yellow and would mask a wave-height red if they short-circuited,
// so they are floored in separately (NWS_FLOOR_PRECEDENCE / step 6) where they can
// only upgrade a green/unknown estimate.
export const ALERT_PRECEDENCE = [
  // double-red (most severe) — must come first so a later red cannot shadow them
  "Tornado Warning",
  "High Surf Warning",
  "Storm Warning",                // marine, sustained >= 48 kt
  // red
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

// NWS severe-weather WATCHES and wind/flood/marine ADVISORIES, all mapped to
// yellow. Applied as a floor at step 6 (raise green/unknown to yellow, never
// downgrade a higher color), NOT as a step-1 short-circuit — see the
// ALERT_PRECEDENCE note above. "Floor" names the mechanism (step-6 worst-of),
// which is what unifies these members, not any single alert subtype.
export const NWS_FLOOR_PRECEDENCE = [
  "Tornado Watch",
  "Severe Thunderstorm Watch",
  "High Wind Watch",
  "Wind Advisory",
  "Lake Wind Advisory",
  "Small Craft Advisory",         // marine
  "Lakeshore Flood Advisory",
  "Coastal Flood Advisory"
];

const ALERT_COLOR_MAP = {
  "Tornado Warning": "double-red",
  "High Surf Warning": "double-red",
  "Storm Warning": "double-red",
  "Severe Thunderstorm Warning": "red",
  "Beach Hazards Statement": "red",
  "High Surf Advisory": "red",
  "Rip Current Statement": "red",
  "High Wind Warning": "red",
  "Gale Warning": "red",
  "Special Marine Warning": "red",
  "Lakeshore Flood Warning": "red",
  "Coastal Flood Warning": "red",
  "Tornado Watch": "yellow",
  "Severe Thunderstorm Watch": "yellow",
  "High Wind Watch": "yellow",
  "Wind Advisory": "yellow",
  "Lake Wind Advisory": "yellow",
  "Small Craft Advisory": "yellow",
  "Lakeshore Flood Advisory": "yellow",
  "Coastal Flood Advisory": "yellow"
};

// Environment and Climate Change Canada issues NO beach-specific hazard
// products (no rip current, high surf, or beach hazards analog exists in the
// Canadian system), so Canadian beaches map a curated set of severe weather
// WARNINGS for hazards dangerous to people in or on the water: storm surge,
// tornado/waterspout, squalls, lightning, and damaging onshore wind (ECCC's
// wind warning criteria — sustained >= 50 km/h or gusts >= 90 km/h — sit above
// this engine's own wind-fallback red thresholds). Watches are deliberately
// EXCLUDED: mapping a watch to yellow would let it mask a wave-height red
// under the strict step precedence. Event names are exact-match against the
// GeoMet weather-alerts alert_name_en strings, which ECCC serves lowercase.
// Marine warnings (ECCC's GeoMet marine-alerts collection, served via
// src/clients/ecccMarine.js) fold into this SAME lowercase namespace: "storm
// warning" (marine >= 48 kt — DISTINCT from the land "storm surge warning")
// short-circuits to double-red, "gale warning" (>= 34 kt) to red. The two
// weaker marine advisories ("strong wind warning", "marine weather advisory")
// are yellow FLOORS instead (ECCC_FLOOR_PRECEDENCE / step 6), so they can never
// mask a wave-height red.
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

// Marine yellow-floor events (raise-only, like NWS_FLOOR_PRECEDENCE). Kept out
// of the short-circuit precedence so a strong-wind / marine-advisory can only
// RAISE a green/unknown to yellow, never downgrade a decided higher color.
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

// The flag color a recognized alert maps to — NWS events (ALERT_PRECEDENCE
// warnings plus NWS_FLOOR_PRECEDENCE watches/advisories, Title Case) and ECCC
// events (ECCC_ALERT_PRECEDENCE, lowercase) share one lookup since the two
// namespaces can never collide — or null for any other event. Exported so the
// frontend's hazard lane colors alert bands from the exact same mapping the flag
// decision uses.
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

// The wave-height color thresholds (2 ft yellow, 4 ft red) live ONLY here, so the
// frontend can color per-hour wave forecast cells from the same numbers without
// restating them. Returns "red"/"yellow"/"green" for a finite numeric height, or
// null for anything non-numeric/non-finite (null, undefined, NaN, strings).
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
  // alertsCheckable: true when the cron could look up alerts for this beach
  // (it has an nws_zone or an eccc_zone), false when it could not (not yet
  // enriched for either authority), null/undefined for legacy callers
  // (treated as "no caveat").
  const alertsCheckable = source.alertsCheckable !== undefined ? source.alertsCheckable : null;
  // Raise-only water-quality advisory. Shape { color: "yellow"|"red", reason,
  // source } or null. A clean/absent reading is null and has ZERO effect — it
  // can only RAISE a flag (step 7), never pull a hazard estimate down, so a
  // clean water reading can never mask a wave/rip/alert red. This lives INSIDE
  // the estimate (official:false); it is never an official override.
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

  // Step 1b: active Environment Canada alerts, evaluated in
  // ECCC_ALERT_PRECEDENCE order. Same alerts input — the cron fills it from
  // ECCC for Canadian beaches (a beach is enriched for exactly one authority,
  // and the two event-name namespaces cannot collide).
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

  // Step 3: wave height from Open-Meteo Marine API (already converted to feet).
  // Color comes from waveColorForHeight (the single home of the 2/4 ft thresholds);
  // the per-branch reason strings are built here and are unchanged.
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
      reason = "No usable data from NWS alerts, surf zone forecast, or Open-Meteo wave and wind models";
      trigger = "no-data";
    }
  }

  // Step 6: NWS yellow-alert floor. An active severe-weather WATCH or wind/flood/
  // marine ADVISORY raises an otherwise green or unknown estimate to yellow, but
  // NEVER downgrades a higher color already decided by a warning, rip risk, or
  // wave/wind (worst-of, not strict short-circuit). Kept out of ALERT_PRECEDENCE
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
  // "marine weather advisory" (ECCC's below-gale marine products) raises a green
  // or unknown estimate to yellow, worst-of like the NWS floor — never
  // downgrades a decided higher color. Same lowercase namespace as the ECCC
  // short-circuit warnings; kept separate so it can only lift.
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

  // Step 7: raise-only water-quality floor. An active E. coli / bacteria / HAB
  // advisory raises the flag UP to at least its floor color (yellow or red)
  // using SEVERITY_RANK worst-of, but NEVER downgrades a higher color already
  // decided by an alert, rip risk, or wave/wind. Water quality is a DIFFERENT
  // axis from surf hazard, so a clean reading is modeled as the ABSENCE of an
  // advisory (waterQualityAdvisory === null) and has zero effect — it can never
  // present as a green that masks a hazard estimate. Baked into the estimate
  // (official:false), never an official override.
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

  // Honesty caveat: when alerts were not checkable for this beach (neither
  // nws_zone nor eccc_zone resolved yet), say so explicitly so a
  // wave/wind/no-data estimate is never read as "alerts were checked and none
  // were active". Skipped only when an alert itself decided the color
  // (contradictory input — alerts were evidently available).
  if (alertsCheckable === false && trigger !== "nws-alert" && trigger !== "eccc-alert" && trigger !== "nws-floor" && trigger !== "eccc-floor") {
    reason = reason + " (" + ALERTS_UNAVAILABLE_CAVEAT + ")";
  }

  // Echo the structured wave reading (finite number, else null) regardless of which
  // branch decided the color, so the UI can show a "now" wave stat without parsing
  // the reason string.
  const echoedWaveHeightFt =
    (typeof waveHeightFt === "number" && isFinite(waveHeightFt)) ? waveHeightFt : null;

  // Echo the structured NWS alert details ({ event, onset, ends } — onset/ends
  // ISO strings or null) and the rip-current risk level regardless of which
  // branch decided the color, so the UI's hazard lane never parses the reason
  // string. Sanitized copies: entries without a string event are dropped,
  // non-string timestamps become null, an unrecognized risk becomes null.
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
