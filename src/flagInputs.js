// src/flagInputs.js — the shared assembly of an estimateFlag input bundle, and
// the seal that lets a later run rebuild the non-alert half of that bundle
// without refetching anything (PLAN.md sections 1 and 7).
//
// Pure: no fetch, no Date, no env. Both beach-touching crons call the same
// buildAlertInputs and the same buildEstimateInputs, and the hourly additionally
// calls sealFromSignals on the SAME signals object it fed the estimate, so the
// seal cannot omit a field the estimate consumed. test/flagInputs.test.js
// enforces that as a round-trip property rather than leaving it to discipline.
//
// The seal rides inside the "flag:" value, in the same put, with the same expiry
// instant as the color it explains. A null in it means "the hourly checked and
// found nothing", never "I do not know" — which is exactly what reassembling the
// advisory from the shorter-lived "wqfloor:" key could not say.
//
// alertsCheckable and waterClass are deliberately NOT sealed: each is read
// straight from D1 columns both crons hold, so recomputing them is cheaper and
// strictly more correct, since a beach enriched or reclassified between runs
// would otherwise carry a stale caveat beside a live alert or the wrong wave
// thresholds.

import { alertsCheckable } from "./alertsCheckable.js";
import { alertsInEffect, decidedAlertDetails } from "./rules.js";
import { ecccAlertsForPoint, ECCC_ALERTS_INFO_URL } from "./clients/eccc.js";
import { ecccMarineAlertsForPoint, ECCC_MARINE_INFO_URL } from "./clients/ecccMarine.js";

// Bumped whenever the seal's field set changes. A standing value carrying any
// other version is skipped whole by the refresh cron rather than partially read.
export const FLAG_SEAL_VERSION = 1;

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function riskOrNull(risk) {
  return (risk === "HIGH" || risk === "MODERATE" || risk === "LOW") ? risk : null;
}

// The alert half of an estimateFlag bundle for one beach, matched locally from a
// run's national fetches and filtered to the alerts in effect at nowIso.
// alertCtx is { alertsMap, ecccAlerts, ecccMarineAlerts }, where alertsMap holds
// one entry per distinct NWS zone id ({ events, details, sourceUrl }) and the two
// ECCC values are whole national fetch results or null.
//
// Returns { alerts, alertDetails, alertSources, alertsResolved, alertsAt }.
// alertDetails is the whole matched set, upcoming alerts included, so the hazard
// lane can draw a band that starts later; alerts is the rules.js alertsInEffect
// subset at nowIso, which is the only list that may decide a color. Neither
// branch taken — an unenriched beach, or an authority whose fetch failed — yields
// alerts null, alertDetails null, alertSources [], alertsResolved false and
// alertsAt null, which is what keeps a failed fetch distinguishable from
// "checked, none active": estimateFlag treats alerts null as "no alert evidence"
// and the two look identical from the echoed alertDetails alone.
export function buildAlertInputs(beach, alertCtx, nowIso) {
  const ctx = alertCtx || {};
  const at = typeof nowIso === "string" ? nowIso : null;
  const alertsMap = ctx.alertsMap || null;
  const ecccAlerts = ctx.ecccAlerts === undefined ? null : ctx.ecccAlerts;
  const ecccMarineAlerts = ctx.ecccMarineAlerts === undefined ? null : ctx.ecccMarineAlerts;
  const alertSources = [];

  const landEntry = (alertsMap && beach.nws_zone) ? alertsMap.get(beach.nws_zone) : null;
  const marineEntry = (alertsMap && beach.marine_zone) ? alertsMap.get(beach.marine_zone) : null;
  if (landEntry || marineEntry) {
    // US beach: land forecast-zone alerts plus adjacent marine-zone alerts, both
    // matched from the one national NWS fetch. The concat leaves alerts null only
    // when both entries are absent — a failed fetch or an unenriched zone — so a
    // real failure keeps alertsCheckable true with no false caveat.
    if (landEntry) {
      alertSources.push({ label: "NWS Alerts", url: landEntry.sourceUrl });
    }
    if (marineEntry) {
      alertSources.push({ label: "NWS Marine Alerts", url: marineEntry.sourceUrl });
    }
    const usDetails = (landEntry ? landEntry.details : []).concat(marineEntry ? marineEntry.details : []);
    return {
      alerts: alertsInEffect(usDetails, at),
      alertDetails: usDetails,
      alertSources: alertSources,
      alertsResolved: true,
      alertsAt: at
    };
  }

  if (beach.eccc_zone && (ecccAlerts !== null || ecccMarineAlerts !== null)) {
    // Canadian beach: match the run's single ECCC land fetch and single marine
    // fetch to this point via their region polygons, then concat into one alerts
    // list, as the US branch does. A successful fetch with zero containing
    // polygons is a real "no active alerts". The branch still processes when only
    // one of the two fetches succeeded, so a land-alerts outage never hides an
    // active marine gale or the reverse.
    const landMatched = ecccAlerts !== null
      ? ecccAlertsForPoint(ecccAlerts.alerts, beach.lat, beach.lon)
      : { events: [], details: [] };
    const marineMatched = ecccMarineAlerts !== null
      ? ecccMarineAlertsForPoint(ecccMarineAlerts.alerts, beach.lat, beach.lon)
      : { events: [], details: [] };
    if (ecccAlerts !== null) {
      alertSources.push({ label: "Environment Canada Alerts", url: ECCC_ALERTS_INFO_URL });
    }
    if (ecccMarineAlerts !== null) {
      alertSources.push({ label: "Environment Canada Marine Alerts", url: ECCC_MARINE_INFO_URL });
    }
    const caDetails = landMatched.details.concat(marineMatched.details);
    return {
      alerts: alertsInEffect(caDetails, at),
      alertDetails: caDetails,
      alertSources: alertSources,
      alertsResolved: true,
      alertsAt: at
    };
  }

  return { alerts: null, alertDetails: null, alertSources: [], alertsResolved: false, alertsAt: null };
}

// The complete estimateFlag input bundle: the alert half from buildAlertInputs,
// the non-alert half from signals ({ alertsResolved, ripCurrentRisk,
// waveHeightFt, windSpeedMph, windGustMph, waterQualityAdvisory, signalSources,
// updated }), and alertsCheckable recomputed from the beach row.
//
// Three normalizations are applied before the values reach rules.js. They are
// caller-side input validation, not rules: rules.js step 3's else branch has no
// finite guard, so a non-finite wave height would decide green with a nonsense
// reason, and JSON.stringify emits null for NaN and Infinity alike, so an
// unguarded non-finite value would also read back differently than it was
// written and the two crons would decide different colors from one beach.
export function buildEstimateInputs(beach, alertPart, signals) {
  const alertHalf = alertPart || { alerts: null, alertDetails: null, alertSources: [], alertsAt: null };
  const signalSources = Array.isArray(signals.signalSources) ? signals.signalSources : [];
  const alertSources = Array.isArray(alertHalf.alertSources) ? alertHalf.alertSources : [];
  return {
    beachId: beach.id,
    alerts: alertHalf.alerts,
    alertDetails: alertHalf.alertDetails,
    alertsAt: typeof alertHalf.alertsAt === "string" ? alertHalf.alertsAt : null,
    alertsCheckable: alertsCheckable(beach),
    // Selects the step 3 wave thresholds; null and every non-ocean class share
    // the default set.
    waterClass: typeof beach.water_class === "string" ? beach.water_class : null,
    ripCurrentRisk: riskOrNull(signals.ripCurrentRisk),
    waveHeightFt: finiteOrNull(signals.waveHeightFt),
    windSpeedMph: finiteOrNull(signals.windSpeedMph),
    windGustMph: finiteOrNull(signals.windGustMph),
    waterQualityAdvisory: signals.waterQualityAdvisory === undefined ? null : signals.waterQualityAdvisory,
    sources: alertSources.concat(signalSources),
    updated: signals.updated === undefined ? null : signals.updated
  };
}

// The seal spread onto the "flag:" value after estimateFlag returns. It carries
// only what the FlagEstimate does not already echo: ripCurrentRisk, waveHeightFt,
// sources and updated are echoed by rules.js, so repeating them here would be
// two sources of truth for one field.
//
// alertsResolved comes from the alert half rather than from signals, because it
// is a fact about this run's fetch: a false here is what tells the refresh cron
// that the standing estimate lost its alert short-circuit and its floors to a
// failed national fetch, where an echoed empty alertDetails would look exactly
// like "checked, none active".
export function sealFromSignals(signals, alertPart) {
  const alertHalf = alertPart || { alertsResolved: false };
  return {
    v: FLAG_SEAL_VERSION,
    alertsResolved: alertHalf.alertsResolved === true,
    windSpeedMph: finiteOrNull(signals.windSpeedMph),
    windGustMph: finiteOrNull(signals.windGustMph),
    waterQualityAdvisory: signals.waterQualityAdvisory === undefined ? null : signals.waterQualityAdvisory,
    signalSources: Array.isArray(signals.signalSources) ? signals.signalSources : []
  };
}

// The signals half read back out of a standing FlagEstimate: the four sealed
// fields plus the three rules.js already echoes. Returns null — never a partial
// bundle — for a value written before the seal shipped, one carrying another seal
// version, or one whose signalSources is not an array. Every way the seal can be
// wrong is a skip, so no caller can substitute a null for a field the estimate
// was actually decided from.
export function signalsFromStanding(standing) {
  if (!standing || typeof standing !== "object") {
    return null;
  }
  const seal = standing.estimateInputs;
  if (!seal || typeof seal !== "object" || seal.v !== FLAG_SEAL_VERSION ||
      !Array.isArray(seal.signalSources)) {
    return null;
  }
  return {
    alertsResolved: seal.alertsResolved === true,
    ripCurrentRisk: riskOrNull(standing.ripCurrentRisk),
    waveHeightFt: finiteOrNull(standing.waveHeightFt),
    windSpeedMph: finiteOrNull(seal.windSpeedMph),
    windGustMph: finiteOrNull(seal.windGustMph),
    waterQualityAdvisory: seal.waterQualityAdvisory === undefined ? null : seal.waterQualityAdvisory,
    signalSources: seal.signalSources,
    updated: typeof standing.updated === "string" ? standing.updated : null
  };
}

// The event names a standing estimate's color was decided against: the echoed
// alertDetails in effect at its alertsAt (rules.js decidedAlertDetails), or every
// echoed entry for a payload written before alertsAt existed. Comparing this
// against the current in-effect set is what lets the refresh see an onset
// arriving or an ends passing, since neither changes the matched name set.
// [] for a malformed or missing echo.
export function standingAlertEvents(standing) {
  const decided = decidedAlertDetails(standing);
  const events = [];
  for (let i = 0; i < decided.length; i = i + 1) {
    events.push(decided[i].event);
  }
  return events;
}

// The selection comparison: deduped, sorted, "|"-joined event names. Sets, not
// order and not timestamps, because estimateFlag only ever does indexOf over the
// four precedence lists — so only the in-effect name set can change a color,
// while onset/ends churn within that set would otherwise select thousands of
// beaches for no change.
export function eventKey(events) {
  if (!Array.isArray(events)) {
    return "";
  }
  const seen = [];
  for (let i = 0; i < events.length; i = i + 1) {
    const name = events[i];
    if (typeof name === "string" && seen.indexOf(name) === -1) {
      seen.push(name);
    }
  }
  seen.sort();
  return seen.join("|");
}
