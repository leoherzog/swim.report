// src/clients/alertMatch.js
// Pure helpers shared by the three alert clients — nwsAlertsForZone
// (src/clients/nws.js), ecccAlertsForPoint (src/clients/eccc.js) and
// ecccMarineAlertsForPoint (src/clients/ecccMarine.js). Each of those used to
// carry a byte-identical copy of the accumulate/dedupe loop below; only the
// per-alert match test differed, so that is the one thing passed in.
//
// No fetch, no Date, no I/O — nothing here can violate the two-path rule on its
// own. It is filed under src/clients/ because the alerts shapes it walks are
// the clients' wire shapes, not general geography.

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

// Pure. Filters an alerts array down to the entries the matches predicate
// accepts, in the result shape the rules engine and hazard lane consume:
//   { events: [deduped event names], details: [{ event, onset, ends }] }
// events dedupe on the event name; details dedupe only on exact
// (event, onset, ends) repeats. A non-array alerts argument, or an entry that
// is not an object with a string event, is skipped — malformed input degrades
// to { events: [], details: [] }, never to a guess.
//
// matches(alert) is called only for entries that already passed the shape
// check, and is NOT wrapped in a try/catch here: a caller whose predicate can
// throw on hostile upstream geometry (ecccMarine) puts the catch INSIDE its own
// closure, so the other two callers keep propagating a genuine bug instead of
// silently dropping alerts.
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
      details.push({ event: alert.event, onset: onset, ends: ends });
    }
  }
  return { events: events, details: details };
}
