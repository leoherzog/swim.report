// src/clients/alertMatch.js — the accumulate and dedupe walk shared by the three
// alert clients: nwsAlertsForZone (src/clients/nws.js), ecccAlertsForPoint
// (src/clients/eccc.js) and ecccMarineAlertsForPoint (src/clients/ecccMarine.js).
// Only the per-alert match test differs between them, so that is the one thing
// passed in.
//
// No fetch, no Date, no I/O. Filed under src/clients/ because the shapes it walks
// are the clients' wire shapes, not general geography.

// First non-empty string of the two candidates, else null (alert features
// commonly carry effective/expires but leave onset/ends null; the ECCC land
// collection does the same with publication_datetime/expiration_datetime).
export function pickIsoString(primary, fallback) {
  if (typeof primary === "string" && primary.length > 0) {
    return primary;
  }
  if (typeof fallback === "string" && fallback.length > 0) {
    return fallback;
  }
  return null;
}

// Per-field caps on the free text carried into details. A stored estimate holds
// one entry per matched alert and the refresh cron reads every beach's estimate
// every ten minutes, so the long-tail product whose description runs past 8 KB is
// a cost paid across the whole table. 4000 clears the longest description any
// event rules.js keys on — the Hurricane and Tropical Storm Warnings, where the
// full text is exactly what a swimmer needs — so the cap only bites on events
// that decide no color.
const TEXT_CAPS = {
  description: 4000,
  instruction: 800,
  area: 300,
  sender: 120
};

// A trimmed copy of one free-text field, capped at limit with an ellipsis, or
// null when the field is absent, not a string, or empty.
function cappedText(value, limit) {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (text.length === 0) {
    return null;
  }
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, limit).trimEnd() + "\u2026";
}

// Pure. Filters an alerts array down to the entries the matches predicate
// accepts, in the result shape the rules engine, hazard lane and detail page
// consume:
//   { events: [deduped event names],
//     details: [{ event, onset, ends, description, instruction, area, sender }] }
// events dedupe on the event name; details dedupe only on exact
// (event, onset, ends) repeats, so the first matched entry's text wins a tie.
// The four text fields are capped copies of whatever the client attached to the
// alert, null when it attached nothing — no client publishes all four. A
// non-array alerts argument, or an entry that is not an object with a string
// event, is skipped — malformed input degrades to { events: [], details: [] },
// never to a guess.
//
// matches(alert) is called only for entries that already passed the shape check,
// and is deliberately not wrapped in a try/catch here: the one caller whose
// predicate can throw on hostile upstream geometry (ecccMarine) puts the catch
// inside its own closure, so the other two keep propagating a genuine bug instead
// of silently dropping alerts.
export function matchedAlerts(alerts, matches) {
  const events = [];
  // Prototype-less: an event name that is an Object.prototype key ('constructor',
  // 'toString', '__proto__') reads back truthy on first sighting from a {} literal,
  // which drops it from events while details still carries it.
  const seen = Object.create(null);
  const details = [];
  const seenDetails = Object.create(null);
  const list = Array.isArray(alerts) ? alerts : [];
  for (const alert of list) {
    if (alert === null || typeof alert !== "object" || typeof alert.event !== "string") {
      continue;
    }
    if (!matches(alert)) {
      continue;
    }
    if (!seen[alert.event]) {
      seen[alert.event] = true;
      events.push(alert.event);
    }
    const onset = typeof alert.onset === "string" ? alert.onset : null;
    const ends = typeof alert.ends === "string" ? alert.ends : null;
    const detailKey = alert.event + "|" + String(onset) + "|" + String(ends);
    if (!seenDetails[detailKey]) {
      seenDetails[detailKey] = true;
      details.push({
        event: alert.event,
        onset: onset,
        ends: ends,
        description: cappedText(alert.description, TEXT_CAPS.description),
        instruction: cappedText(alert.instruction, TEXT_CAPS.instruction),
        area: cappedText(alert.area, TEXT_CAPS.area),
        sender: cappedText(alert.sender, TEXT_CAPS.sender)
      });
    }
  }
  return { events: events, details: details };
}
