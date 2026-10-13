// src/clients/srfParser.js
// Pure parsers for NWS Surf Zone Forecast (SRF) text products: the per-zone rip
// current risk for the forecast period covering a run instant, and the per-zone
// tide tables. No fetch, no Date.now(), no env access; nothing here throws or
// mutates its input.

// A product older than this at the run instant yields no rip risk at all, even
// when one of its periods would still cover the instant. Period windows already
// bound a product to about 38 h of use; this is the hard ceiling for an office
// that skipped an issuance, and it keeps a bare weekday label unambiguous.
export const SRF_MAX_AGE_MS = 36 * 60 * 60 * 1000;

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

// Reads the UGC header starting at lines[i] (already known to match UGC_START),
// following wrapped continuation lines. Returns { zones, next } where next is
// the first line index past the header; zones is empty for an incomplete one.
function readUgcHeader(lines, i) {
  let header = lines[i].replace(/\s+$/, "");
  let j = i + 1;
  while (!UGC_COMPLETE.test(header) && j < lines.length &&
    UGC_CONTINUATION.test(lines[j].replace(/\s+$/, ""))) {
    header = header + lines[j].replace(/\s+$/, "");
    j = j + 1;
  }
  return { zones: UGC_COMPLETE.test(header) ? expandUgc(header) : [], next: j };
}

// ".TODAY...", ".REST OF TODAY...", ".WEDNESDAY...Surf height..." — the label
// is the capitalized run before the first ellipsis.
const PERIOD_LINE = /^\.([A-Z][A-Z ]*?)\.\.\./;

// The issuance stamp an office prints under the product header and again under
// each zone segment's name lines: "410 AM EDT Tue Oct 13 2026", "1200 PM ...".
const STAMP_LINE = /^(\d{1,2})(\d{2}) (AM|PM) ([A-Z]{2,4}) (SUN|MON|TUE|WED|THU|FRI|SAT) ([A-Z]{3}) (\d{1,2}) (\d{4})$/i;
// Fixed offsets for the abbreviations an SRF stamp carries; the stamp's own
// abbreviation already encodes daylight time, so no transition rule is needed.
const TZ_OFFSET_HOURS = {
  EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7,
  AKST: -9, AKDT: -8, HST: -10, AST: -4, CHST: 10, SST: -11
};
const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
};
const WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const DAY_LABEL = /^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)(?: (NIGHT|EVENING|AFTERNOON|MORNING))?$/;

// { offsetHours, year, month, day, issuedMs } for a stamp line, or null when the
// line is not a stamp or names a zone abbreviation outside TZ_OFFSET_HOURS.
function parseStamp(line) {
  const match = STAMP_LINE.exec(line);
  if (!match) {
    return null;
  }
  const tz = match[4].toUpperCase();
  const month = MONTHS[match[6].toUpperCase()];
  if (!Object.prototype.hasOwnProperty.call(TZ_OFFSET_HOURS, tz) || month === undefined) {
    return null;
  }
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === "PM") {
    hour = hour + 12;
  }
  const stamp = {
    offsetHours: TZ_OFFSET_HOURS[tz],
    year: Number(match[8]),
    month: month,
    day: Number(match[7])
  };
  stamp.issuedMs = wallMs(stamp, 0, hour, Number(match[2]));
  return stamp;
}

// The epoch instant of a local wall-clock time dayOffset days after the stamp
// date, in the stamp's zone. Date.UTC normalizes a day past the month's end.
function wallMs(stamp, dayOffset, hour, minute) {
  return Date.UTC(stamp.year, stamp.month, stamp.day + dayOffset, hour, minute || 0) -
    stamp.offsetHours * 60 * 60 * 1000;
}

// The [start, end) window a period label covers, in local wall time on the
// stamp's calendar, or null for a label with no window ("EXTENDED", a region
// heading). A bare weekday is the first date on or after the stamp date with
// that weekday, so ".MONDAY..." in a Sunday-evening product is the next day.
function periodWindow(label, stamp) {
  if (label === "TODAY") {
    return { start: wallMs(stamp, 0, 6), end: wallMs(stamp, 0, 18) };
  }
  if (label === "TONIGHT") {
    return { start: wallMs(stamp, 0, 18), end: wallMs(stamp, 1, 6) };
  }
  if (label === "THIS AFTERNOON" || label === "REST OF THIS AFTERNOON") {
    return { start: wallMs(stamp, 0, 12), end: wallMs(stamp, 0, 18) };
  }
  if (label === "REST OF TODAY" || label === "THIS MORNING") {
    return { start: stamp.issuedMs, end: wallMs(stamp, 0, 18) };
  }
  if (label === "THIS EVENING" || label === "REST OF TONIGHT" ||
      label === "OVERNIGHT" || label === "EARLY THIS MORNING") {
    const dawn = wallMs(stamp, 0, 6);
    return { start: stamp.issuedMs, end: dawn > stamp.issuedMs ? dawn : wallMs(stamp, 1, 6) };
  }
  const day = DAY_LABEL.exec(label);
  if (!day) {
    return null;
  }
  const stampDow = new Date(Date.UTC(stamp.year, stamp.month, stamp.day)).getUTCDay();
  const offset = (WEEKDAYS.indexOf(day[1]) - stampDow + 7) % 7;
  const part = day[2] === undefined ? "" : day[2];
  if (part === "NIGHT" || part === "EVENING") {
    return { start: wallMs(stamp, offset, 18), end: wallMs(stamp, offset + 1, 6) };
  }
  if (part === "AFTERNOON") {
    return { start: wallMs(stamp, offset, 12), end: wallMs(stamp, offset, 18) };
  }
  if (part === "MORNING") {
    return { start: wallMs(stamp, offset, 6), end: wallMs(stamp, offset, 12) };
  }
  return { start: wallMs(stamp, offset, 6), end: wallMs(stamp, offset, 18) };
}

const RISK_RANK = { LOW: 1, MODERATE: 2, HIGH: 3 };
// The field label at line start, with or without the footnote asterisk and dot
// leaders, and whatever follows. Anchoring excludes the "* Low Risk - ..."
// legend bullets and the "...HIGH RIP CURRENT RISK..." headline. The "Rip
// Current Risk Category" legend heading and a "Rip Current Risks:" variant do
// match; they sit past the "&&" cut, and inside a block they carry no risk
// word where the value opens, so riskInBlock reads past them.
const RISK_LABEL = /^(?:RIP CURRENT RISK|SWIM RISK)\*?[\s.:]*(.*)$/i;
// An indented sub-area line under a label-only risk field: name, one or more
// dots, a value opening with a risk word. A name that fills the column is
// followed by a single dot ("East of Ocean Isle Beach.Low."), so the dot count
// cannot be the separator; anchoring the value on the risk word is what keeps
// a dotted name ("St. Augustine Beach...Low.") whole.
const SUB_AREA_LINE = /^\s+(.+?)\.+\s*((?:HIGH|MODERATE|LOW)\b.*)$/i;
// A value the formatter wrapped onto the next line, indented to the value
// column.
const CONTINUATION_LINE = /^\s+(\S.*)$/;
const RISK_WORD = /\b(HIGH|MODERATE|LOW)\b/gi;
// A segment headline naming an explicit end for the day's risk:
// "...MODERATE RIP CURRENT RISK IN EFFECT UNTIL 8 PM EDT THIS EVENING...". A
// weekday after the zone abbreviation places the time on that day; without one
// it falls on the stamp date.
const HEADLINE_UNTIL = /^\.\.\.(?:HIGH|MODERATE) RIP CURRENT RISK\b[^.]*?\bUNTIL (\d{1,2})(?::(\d{2}))? (AM|PM)(?: [A-Z]{2,4})?(?: (SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY))?/i;
// How far past a daytime period's 18:00 close a headline may carry it.
const HEADLINE_EXTENSION_MAX_MS = 6 * 60 * 60 * 1000;

// The risk a value phrase states, or null when it does not open with a risk
// word. The phrase runs to its first period, and a range ("Low to Moderate")
// resolves to its worst word.
function riskFromValue(text) {
  const phrase = text.split(".")[0];
  if (!/^(HIGH|MODERATE|LOW)\b/i.test(phrase)) {
    return null;
  }
  let worst = null;
  const words = phrase.match(RISK_WORD) || [];
  for (const word of words) {
    const risk = word.toUpperCase();
    if (worst === null || RISK_RANK[risk] > RISK_RANK[worst]) {
      worst = risk;
    }
  }
  return worst;
}

// The risk stated inside one period block (lines[start, end)): an inline value
// on the label line, joined with any wrapped continuation lines, or the worst
// of the indented sub-area values under a label-only line. A label line whose
// value opens with no risk word is a heading, not the field, and the scan goes
// on past it. Null when the block carries no risk field.
function riskInBlock(lines, start, end) {
  let i = start;
  while (i < end) {
    const match = RISK_LABEL.exec(lines[i]);
    if (!match) {
      i = i + 1;
      continue;
    }
    let j = i + 1;
    if (match[1] !== "") {
      let value = match[1];
      for (; j < end && CONTINUATION_LINE.test(lines[j]); j = j + 1) {
        value = value + " " + lines[j].trim();
      }
      const risk = riskFromValue(value);
      if (risk !== null) {
        return risk;
      }
      i = j;
      continue;
    }
    let worst = null;
    for (; j < end && /^\s/.test(lines[j]); j = j + 1) {
      const sub = SUB_AREA_LINE.exec(lines[j]);
      const risk = sub ? riskFromValue(sub[2]) : null;
      if (risk !== null && (worst === null || RISK_RANK[risk] > RISK_RANK[worst])) {
        worst = risk;
      }
    }
    if (worst !== null) {
      return worst;
    }
    i = j;
  }
  return null;
}

// The local wall-clock hour of an instant in the stamp's zone.
function localHour(ms, stamp) {
  return new Date(ms + stamp.offsetHours * 60 * 60 * 1000).getUTCHours();
}

// The instant a segment's headline says the day's risk ends, or null when no
// headline before the first period names one. A wrapped headline is joined
// until the line that closes it with an ellipsis.
function headlineEndMs(lines, start, end, stamp) {
  for (let i = start; i < end; i = i + 1) {
    if (PERIOD_LINE.test(lines[i])) {
      return null;
    }
    if (lines[i].indexOf("...") !== 0) {
      continue;
    }
    let text = lines[i];
    let j = i;
    while (!/\.\.\.$/.test(text) && j + 1 < end && j - i < 3) {
      j = j + 1;
      text = text + " " + lines[j].trim();
    }
    const match = HEADLINE_UNTIL.exec(text);
    if (!match) {
      continue;
    }
    let hour = Number(match[1]) % 12;
    if (match[3].toUpperCase() === "PM") {
      hour = hour + 12;
    }
    let offset = 0;
    if (match[4] !== undefined) {
      const stampDow = new Date(Date.UTC(stamp.year, stamp.month, stamp.day)).getUTCDay();
      offset = (WEEKDAYS.indexOf(match[4].toUpperCase()) - stampDow + 7) % 7;
    }
    return wallMs(stamp, offset, hour, match[2] === undefined ? 0 : Number(match[2]));
  }
  return null;
}

// The risk one zone segment (lines[start, end)) states for the period covering
// nowMs, or null. headerStamp stands in for a segment that prints no stamp.
function riskForSegment(lines, start, end, headerStamp, nowMs) {
  let stamp = null;
  for (let i = start; i < end && stamp === null; i = i + 1) {
    if (STAMP_LINE.test(lines[i])) {
      stamp = parseStamp(lines[i]);
      if (stamp === null) {
        return null;
      }
    }
  }
  if (stamp === null) {
    stamp = headerStamp;
  }
  if (stamp === null || nowMs - stamp.issuedMs > SRF_MAX_AGE_MS) {
    return null;
  }
  // Period blocks in order: a label line opens one, the next label, "&&" or the
  // "EXTENDED" heading closes it. A label line that carries text after its
  // ellipsis is an extended-outlook summary and never a candidate.
  const periods = [];
  let stop = end;
  for (let i = start; i < end; i = i + 1) {
    const line = lines[i];
    if (line === "&&") {
      stop = i;
      break;
    }
    const match = PERIOD_LINE.exec(line);
    if (!match) {
      continue;
    }
    const label = match[1].trim().replace(/\s+/g, " ");
    if (label === "EXTENDED") {
      stop = i;
      break;
    }
    if (periods.length > 0) {
      periods[periods.length - 1].end = i;
    }
    const inline = line.slice(match[0].length).trim() !== "";
    periods.push({ label: label, start: i + 1, end: end, inline: inline });
  }
  if (periods.length > 0) {
    periods[periods.length - 1].end = stop;
  }
  const untilMs = headlineEndMs(lines, start, stop, stamp);
  for (const period of periods) {
    if (period.inline) {
      continue;
    }
    const window = periodWindow(period.label, stamp);
    if (window === null) {
      continue;
    }
    // A headline that says the risk runs past 18:00 the same evening carries
    // the daytime period to that hour; a headline never shortens one.
    if (untilMs !== null && untilMs > window.end &&
        untilMs - window.end <= HEADLINE_EXTENSION_MAX_MS && localHour(window.end, stamp) === 18) {
      window.end = untilMs;
    }
    if (nowMs < window.start || nowMs >= window.end) {
      continue;
    }
    return riskInBlock(lines, period.start, period.end);
  }
  return null;
}

/**
 * The rip current risk every zone segment of a Surf Zone Forecast states for
 * the forecast period covering nowIso, keyed by UGC zone id:
 * { NCZ106: "HIGH" | "MODERATE" | "LOW" }. A zone is absent when its segment
 * carries no risk field for that period, no period covers the instant, the
 * segment's stamp (or the product header's, when the segment prints none) is
 * older than SRF_MAX_AGE_MS or unreadable, or the segment is in the extended
 * outlook. The first segment naming a zone wins. Never throws; non-string input
 * or an unparseable nowIso yields an empty object.
 */
export function ripRiskByZone(srfText, nowIso) {
  const byZone = {};
  const nowMs = typeof nowIso === "string" ? Date.parse(nowIso) : NaN;
  if (typeof srfText !== "string" || srfText === "" || !Number.isFinite(nowMs)) {
    return byZone;
  }
  const lines = srfText.split(/\r?\n/).map(function (line) {
    return line.replace(/\s+$/, "");
  });
  let headerStamp = null;
  let i = 0;
  while (i < lines.length && !UGC_START.test(lines[i])) {
    if (headerStamp === null && STAMP_LINE.test(lines[i])) {
      headerStamp = parseStamp(lines[i]);
    }
    i = i + 1;
  }
  while (i < lines.length) {
    if (!UGC_START.test(lines[i])) {
      i = i + 1;
      continue;
    }
    const header = readUgcHeader(lines, i);
    let end = header.next;
    while (end < lines.length && lines[end] !== "$$" && !UGC_START.test(lines[end])) {
      end = end + 1;
    }
    if (header.zones.length > 0) {
      const risk = riskForSegment(lines, header.next, end, headerStamp, nowMs);
      if (risk !== null) {
        for (const zone of header.zones) {
          if (!Object.prototype.hasOwnProperty.call(byZone, zone)) {
            byZone[zone] = risk;
          }
        }
      }
    }
    i = end;
  }
  return byZone;
}

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
      const header = readUgcHeader(lines, i);
      zones = header.zones;
      i = header.next;
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
