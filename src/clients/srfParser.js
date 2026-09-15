// src/clients/srfParser.js
// Pure regex parser for NWS Surf Zone Forecast (SRF) text products. No fetch,
// no Date, no env access — this module never throws and never mutates input.

// Ordered most-specific/most-common first; parseRipCurrentRisk returns the first
// regex that matches anywhere in the product (each regex itself matches its
// first occurrence, so a multi-period product resolves to the earliest period).
// The ocean "Rip Current Risk" wordings (regexes 0-2) are listed before the
// Great Lakes "Swim Risk" variant (regex 3) so a product carrying the explicit
// rip wording always matches one of regexes 0-2 before regex 3 is tried; the
// Swim Risk regex fires only on Great Lakes beach-hazard products that use that
// label and no rip wording.
// NWS Great Lakes forecasts express the swimming hazard as "SWIM RISK...HIGH"
// (High/Moderate/Low), which maps onto the same HIGH/MODERATE/LOW the estimator
// already consumes via ripCurrentRisk.
const RISK_REGEXES = [
  /RIP\s+CURRENT\s+RISK[\s.:]*(?:IS\s+)?[\s.]*\b(HIGH|MODERATE|LOW)\b/i,
  /\b(HIGH|MODERATE|LOW)\s+RISK\s+OF\s+RIP\s+CURRENTS?/i,
  /RISK\s+OF\s+RIP\s+CURRENTS?\s+(?:IS|WILL\s+BE|REMAINS)\s+(HIGH|MODERATE|LOW)/i,
  /SWIM\s+RISK[\s.:]*(?:IS\s+)?[\s.]*\b(HIGH|MODERATE|LOW)\b/i
];

export function parseRipCurrentRisk(srfText) {
  if (!srfText) {
    return null;
  }
  for (let i = 0; i < RISK_REGEXES.length; i++) {
    const match = RISK_REGEXES[i].exec(srfText);
    if (match) {
      return match[1].toUpperCase();
    }
  }
  return null;
}

// A UGC header line: the segment's zone list ending in its DDHHMM expiry,
// e.g. "NCZ106-152115-", "MAZ015-016-152200-" or "RIZ006>008-152200-". A long
// list wraps onto lines that carry only tokens, so the header is complete once
// it ends in the six-digit expiry.
const UGC_START = /^[A-Z]{2}[CZ]\d{3}[A-Z0-9>-]*-$/;
const UGC_CONTINUATION = /^[A-Z0-9>-]+-$/;
const UGC_COMPLETE = /\d{6}-$/;
// Bounds a malformed ">" range so a stray token cannot expand into thousands
// of zones.
const UGC_RANGE_CAP = 100;

// Zone ids named by one complete UGC header, in order. Tokens after the first
// inherit the prefix of the last prefixed token; "a>b" is an inclusive range.
function expandUgc(header) {
  const tokens = header.split("-");
  // Drop the trailing empty token and the expiry.
  tokens.pop();
  tokens.pop();
  const zones = [];
  let prefix = null;
  for (const token of tokens) {
    const match = /^([A-Z]{2}[CZ])?(\d{3})(?:>(\d{3}))?$/.exec(token);
    if (!match) {
      continue;
    }
    if (match[1]) {
      prefix = match[1];
    }
    if (prefix === null) {
      continue;
    }
    const start = Number(match[2]);
    const end = match[3] === undefined ? start : Number(match[3]);
    if (end < start || end - start > UGC_RANGE_CAP) {
      continue;
    }
    for (let n = start; n <= end; n = n + 1) {
      zones.push(prefix + ("00" + String(n)).slice(-3));
    }
  }
  return zones;
}

// ".TODAY...", ".REST OF TODAY...", ".WEDNESDAY...Surf height..." — the label
// is the capitalized run before the first ellipsis.
const PERIOD_LINE = /^\.([A-Z][A-Z ]*?)\.\.\./;
// The tides field label, with or without dot leaders, and anything after them.
const TIDES_LINE = /^TIDES\.*\s*(.*)$/i;
// An indented location line: name, dot leaders, first event.
const LOCATION_LINE = /^\s+(.+?)\.{2,}\s*(.+?)\s*$/;
// An indented continuation line: one more event for the current location.
const EVENT_LINE = /^\s+(\S.*?)\s*$/;

// Parses the indented block under a "Tides" label, starting at lines[start].
// Returns { locations, next } where next is the first line index past the block.
function readTidesBlock(lines, start, labelRemainder) {
  const locations = [];
  let current = null;
  if (labelRemainder !== "") {
    current = { name: "", events: [labelRemainder] };
    locations.push(current);
  }
  let i = start;
  for (; i < lines.length; i = i + 1) {
    const line = lines[i];
    const location = LOCATION_LINE.exec(line);
    if (location) {
      current = { name: location[1].trim(), events: [location[2]] };
      locations.push(current);
      continue;
    }
    const event = EVENT_LINE.exec(line);
    if (!event) {
      break;
    }
    if (current === null) {
      current = { name: "", events: [] };
      locations.push(current);
    }
    current.events.push(event[1]);
  }
  return { locations: locations, next: i };
}

/**
 * The tide table of every zone segment in a Surf Zone Forecast, keyed by UGC
 * zone id ("NCZ108"). Each value is the first forecast period that carries a
 * "Tides" block, as { period, locations: [{ name, events }] } with every event
 * string verbatim from the product ("High at 10:58 AM EDT.",
 * "Low 0.4 feet (MLLW) 07:56 AM EDT."). Zones with no tides block are absent, so
 * a Great Lakes product yields an empty object. Never throws; non-string input
 * yields an empty object.
 */
export function parseSrfTides(srfText) {
  const byZone = {};
  if (typeof srfText !== "string" || srfText === "") {
    return byZone;
  }
  const lines = srfText.split(/\r?\n/);
  let zones = [];
  let period = null;
  let found = null;
  function closeSegment() {
    if (found !== null) {
      for (const zone of zones) {
        if (!Object.prototype.hasOwnProperty.call(byZone, zone)) {
          byZone[zone] = { period: found.period, locations: found.locations };
        }
      }
    }
    zones = [];
    period = null;
    found = null;
  }
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, "");
    if (line === "$$") {
      closeSegment();
      i = i + 1;
      continue;
    }
    if (UGC_START.test(line)) {
      closeSegment();
      let header = line;
      let j = i + 1;
      while (!UGC_COMPLETE.test(header) && j < lines.length &&
        UGC_CONTINUATION.test(lines[j].replace(/\s+$/, ""))) {
        header = header + lines[j].replace(/\s+$/, "");
        j = j + 1;
      }
      zones = UGC_COMPLETE.test(header) ? expandUgc(header) : [];
      i = j;
      continue;
    }
    const periodMatch = PERIOD_LINE.exec(line);
    if (periodMatch) {
      period = periodMatch[1].trim();
      i = i + 1;
      continue;
    }
    const tidesMatch = TIDES_LINE.exec(line);
    if (tidesMatch && found === null && zones.length > 0) {
      const block = readTidesBlock(lines, i + 1, tidesMatch[1].trim());
      if (block.locations.length > 0) {
        found = { period: period, locations: block.locations };
      }
      i = block.next;
      continue;
    }
    i = i + 1;
  }
  closeSegment();
  return byZone;
}
