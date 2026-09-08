// The detail page's plain-language verdict: one sentence saying what the
// displayed flag means for a swimmer right now, built from the estimate the
// rules engine already decided (its trigger, wave height, rip risk and echoed
// alerts) or from the posted flag when an official record is what the page
// displays. Pure — data in, plain text out; the caller escapes it.
//
// A sentence names a flag color only alongside who decided it: the official
// branch always says the flag is posted, and the estimated branch names no
// color at all, so no estimate can read as an official flag status.
//
// Wave thresholds are never restated here. The band comes from
// waveColorForHeight and its wording from bandLabelsForWaterClass, both built
// from the numbers in src/rules.js.

import {
  waveColorForHeight,
  ripRiskColor,
  SEVERITY_RANK,
  ALERTS_UNAVAILABLE_CAVEAT,
  ALERT_PRECEDENCE,
  ECCC_ALERT_PRECEDENCE,
  NWS_FLOOR_PRECEDENCE,
  ECCC_FLOOR_PRECEDENCE,
  decidedAlertDetails,
  normalizeColor
} from "../rules.js";
import { bandLabelsForWaterClass, lowerFirst } from "./waveStrip.js";

const OFFICIAL_SENTENCES = {
  "green": "A green flag is posted at the beach.",
  "yellow": "A yellow flag is posted at the beach.",
  "red": "A red flag is posted at the beach.",
  "double-red": "Water closed by the posted flag.",
  "unknown": "No data yet for this beach."
};

const RIP_CLAUSES = {
  "HIGH": "high rip current risk",
  "MODERATE": "moderate rip current risk",
  "LOW": "low rip current risk"
};

// Triggers whose deciding step was a named weather alert; they lead the
// sentence and take a semicolon before the next clause.
const ALERT_TRIGGERS = ["nws-alert", "eccc-alert", "nws-floor", "eccc-floor"];

const NO_DATA_SENTENCE = "No data yet for this beach.";

// Every alert rules.js can act on, concatenated in the order estimateFlag
// consults the lists: the two short-circuit precedences first, then the two
// yellow floors. NWS names are Title Case and ECCC names lowercase, so the two
// namespaces cannot collide in one flat list.
const EVENT_PRECEDENCE = ALERT_PRECEDENCE
  .concat(ECCC_ALERT_PRECEDENCE)
  .concat(NWS_FLOOR_PRECEDENCE)
  .concat(ECCC_FLOOR_PRECEDENCE);

function upperFirst(text) {
  return text.length === 0 ? text : (text.charAt(0).toUpperCase() + text.slice(1));
}

// The estimate's echoed alert events, deduped and ordered by EVENT_PRECEDENCE,
// unrecognized events last in feed order. alertDetails arrives in upstream feed
// order, which is not the order rules.js decided in, so the head of this list —
// never alertDetails[0] — is the alert that chose an alert-triggered color.
function orderedAlertEvents(alertDetails) {
  if (!Array.isArray(alertDetails)) {
    return [];
  }
  const events = [];
  for (let i = 0; i < alertDetails.length; i++) {
    const entry = alertDetails[i];
    if (!entry || typeof entry.event !== "string" || entry.event.length === 0) {
      continue;
    }
    if (events.indexOf(entry.event) === -1) {
      events.push(entry.event);
    }
  }
  const ranked = [];
  for (let i = 0; i < events.length; i++) {
    const rank = EVENT_PRECEDENCE.indexOf(events[i]);
    ranked.push({
      event: events[i],
      rank: rank === -1 ? EVENT_PRECEDENCE.length : rank,
      seen: i
    });
  }
  ranked.sort(function (a, b) {
    return a.rank === b.rank ? (a.seen - b.seen) : (a.rank - b.rank);
  });
  const ordered = [];
  for (let i = 0; i < ranked.length; i++) {
    ordered.push(ranked[i].event);
  }
  return ordered;
}

// "X", "X and Y" or "X and N more alerts" over an ordered event list, "" when
// the list is empty.
function eventList(events) {
  if (events.length === 0) {
    return "";
  }
  if (events.length === 1) {
    return events[0];
  }
  if (events.length === 2) {
    return events[0] + " and " + events[1];
  }
  return events[0] + " and " + String(events.length - 1) + " more alerts";
}

// The active-alert clause, e.g. "Beach Hazards Statement in effect" or "Tsunami
// Warning and 2 more alerts in effect", over the entries the color was decided
// against (decidedAlertDetails). "" when none was in effect, including legacy
// payloads with nothing echoed.
function alertClause(estimate) {
  const list = eventList(orderedAlertEvents(decidedAlertDetails(estimate)));
  return list === "" ? "" : list + " in effect";
}

// The upcoming-alert clause, e.g. "Beach Hazards Statement not yet in effect",
// over the echoed entries the color was NOT decided against because their
// onset had not arrived. Named so a reader sees the alert the hazard lane
// draws without reading it as the reason for the color. "" when none.
function upcomingClause(estimate) {
  if (!estimate || !Array.isArray(estimate.alertDetails)) {
    return "";
  }
  const decided = decidedAlertDetails(estimate);
  const pending = [];
  for (let i = 0; i < estimate.alertDetails.length; i++) {
    const entry = estimate.alertDetails[i];
    if (entry && typeof entry.event === "string" && decided.indexOf(entry) === -1) {
      pending.push(entry);
    }
  }
  const list = eventList(orderedAlertEvents(pending));
  return list === "" ? "" : list + " not yet in effect";
}

// "calm water" below the yellow threshold, otherwise the band's own label as
// prose ("waves 2 to 4 ft"). "" when no height was echoed.
function waveClause(band, waterClass) {
  if (band === null) {
    return "";
  }
  if (band === "green") {
    return "calm water";
  }
  return "waves " + lowerFirst(bandLabelsForWaterClass(waterClass)[band]).replace("–", " to ");
}

// "no alerts" is a claim about what was checked, and an echoed empty
// alertDetails cannot carry it: a failed national fetch leaves a zone-enriched
// beach with an empty list and no caveat either. The estimateInputs seal's
// alertsResolved is the fact about that run's fetch, read fail-closed so a
// legacy or reshaped seal drops the claim rather than guessing.
function noAlertsClause(estimate) {
  if (!Array.isArray(estimate.alertDetails) || estimate.alertDetails.length > 0) {
    return "";
  }
  const seal = estimate.estimateInputs;
  if (!seal || typeof seal !== "object" || seal.alertsResolved !== true) {
    return "";
  }
  const reason = typeof estimate.reason === "string" ? estimate.reason : "";
  if (reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT) !== -1) {
    return "";
  }
  return "no alerts";
}

// Whether a follower clause still reinforces the color it trails. A red or
// double-red led by a named event is explained by that event alone: the wave
// grids model wind waves and are neither tsunami- nor surge-aware, so a
// sub-threshold height under a tsunami, hurricane or storm-surge warning is
// ordinary, and printing it as "calm water" would reassure against the hazard
// the sentence exists to explain. Below red every signal still adds context.
function reinforces(clauseColor, color, leadIsEvent) {
  if (!leadIsEvent || SEVERITY_RANK[color] < SEVERITY_RANK.red) {
    return true;
  }
  const own = SEVERITY_RANK[clauseColor];
  return own !== undefined && own >= SEVERITY_RANK.red;
}

// One sentence for the detail hero, or "" when the estimate carries nothing
// worth saying (a legacy payload with no trigger and no echoed signals), in
// which case the caller renders no verdict line at all.
//
// displayIsOfficial is the caller's already-decided "the displayed color came
// from the posted flag" signal, the same one that picks the hero's OFFICIAL
// badge; official != null alone is not that signal, since an aged official
// record that merely agrees with the estimate is the estimate's verdict to
// explain.
export function verdictSentence(estimate, official, displayIsOfficial, waterClass) {
  if (displayIsOfficial && official) {
    return OFFICIAL_SENTENCES[normalizeColor(official.color)];
  }
  if (!estimate) {
    return NO_DATA_SENTENCE;
  }
  const color = normalizeColor(estimate.color);
  if (color === "unknown") {
    return NO_DATA_SENTENCE;
  }

  const trigger = typeof estimate.trigger === "string" ? estimate.trigger : "";
  const alerts = alertClause(estimate);
  const upcoming = upcomingClause(estimate);
  const rip = RIP_CLAUSES[estimate.ripCurrentRisk] ? RIP_CLAUSES[estimate.ripCurrentRisk] : "";
  const waveBand = waveColorForHeight(
    typeof estimate.waveHeightFt === "number" ? estimate.waveHeightFt : null, waterClass);
  const waves = waveClause(waveBand, waterClass);

  // The deciding step leads the sentence; every other signal follows it. The
  // advisory lead avoids "in effect" so an alert clause behind it does not
  // repeat the phrase.
  let lead = "";
  let leadIsEvent = false;
  if (trigger === "wq-floor") {
    lead = "a water-quality advisory covers this beach";
    leadIsEvent = true;
  } else if (ALERT_TRIGGERS.indexOf(trigger) !== -1) {
    lead = alerts ? alerts : "a weather alert is in effect";
    leadIsEvent = true;
  } else if (trigger === "rip-current" || trigger === "rip-current-low") {
    lead = rip;
  } else if (trigger === "wave-height") {
    lead = waves;
  } else if (trigger === "wind") {
    lead = "no wave data, so this estimate is from wind alone";
  }
  if (!lead) {
    lead = alerts ? alerts : (rip ? rip : (waves ? waves : upcoming));
  }
  if (!lead) {
    return "";
  }

  const parts = [lead];
  if (alerts && alerts !== lead) {
    parts.push(alerts);
  }
  // An alert that has not started is context, never reassurance, so it follows
  // an event-led red as readily as any other lead.
  if (upcoming && upcoming !== lead) {
    parts.push(upcoming);
  }
  if (rip && rip !== lead && reinforces(ripRiskColor(estimate.ripCurrentRisk), color, leadIsEvent)) {
    parts.push(rip);
  }
  if (waves && waves !== lead && reinforces(waveBand, color, leadIsEvent)) {
    parts.push(waves);
  }
  // A clear alert check is a green-level datum, so an event-led red drops it too.
  if (!alerts && reinforces("green", color, leadIsEvent)) {
    const clear = noAlertsClause(estimate);
    if (clear) {
      parts.push(clear);
    }
  }
  if (color === "double-red") {
    parts.push("stay out of the water");
  }

  let sentence = upperFirst(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    sentence = sentence + ((i === 1 && leadIsEvent) ? "; " : ", ") + parts[i];
  }
  return sentence + ".";
}
