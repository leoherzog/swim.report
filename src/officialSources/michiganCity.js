// src/officialSources/michiganCity.js
// Official scraper for the City of Michigan City, Indiana Parks &
// Recreation Department's Lake Michigan beach water-quality bulletin
// (Washington Park Beach + Stop 7 at Beachwalk). The page is a hand-edited
// WordPress/Fusion-Builder prose block, not a data feed, so the reading date
// legitimately lags several days over weekends (weekday-only manual
// updates) -- the scraper trusts the page's own reported date, not fetch
// time, and refuses to present a reading older than MAX_STALE_DAYS as
// current. The source itself only ever says "bacteria levels"/"counts" -- it
// never uses the terms "E. coli" or "CFU" -- so scraper copy sticks to the
// source's own wording.
// scrape() runs cron-side only; parseMichiganCityHtml is pure and exported
// for tests.

import { distanceMi } from "../geo.js";
import { fetchText, perBeachResult, ageDays } from "./util.js";

export const MICHIGAN_CITY_URL =
  "https://parks.michigancityin.gov/parks-and-facilities/washington-park/";

export const MICHIGAN_CITY_USER_AGENT =
  "Mozilla/5.0 (compatible; swim.report/1.0; +https://swim.report)";

// Washington Park Beach lakefront pin, from the page's own "Get Directions"
// Google Maps link.
export const MICHIGAN_CITY_LAT = 41.7281476;
export const MICHIGAN_CITY_LON = -86.9040495;
export const MICHIGAN_CITY_MATCH_RADIUS_MI = 2;
// A name hit ("Washington Park"/"Beachwalk") only counts as a match when the
// beach is also within this many miles of the Michigan City lakefront. Both
// terms are common Great Lakes place names, so an UNBOUNDED name match would
// hand this beach's bacteria reading to a same-named beach elsewhere (e.g. any
// of the many other "Washington Park" beaches) -- a wrong official color, the
// worst bug in this product. This generous radius still covers the Stop 7 /
// Beachwalk site (~1.7 mi from the pin, along Lake Shore Drive) with margin.
export const MICHIGAN_CITY_NAME_MATCH_RADIUS_MI = 6;

// Weekday-only manual updates legitimately lag over weekends/holidays; past
// this many days a reading is too stale to present as current.
const MAX_STALE_DAYS = 8;

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
];

// Pure. Bacteria count -> flag color, using the page's own stated
// thresholds verbatim (<=235 acceptable, 236-999 advisory, >=1000 closed).
// There is no source-provided double-red equivalent.
function bacteriaColorFor(value) {
  if (value <= 235) {
    return "green";
  }
  if (value < 1000) {
    return "yellow";
  }
  return "red";
}

// Pure. html string -> { dateLabel, isoDate } | null. Parses the prose
// "The bacteria levels reported for {Weekday}, {Month} {Day}{suffix},
// {Year}." line. Returns null on any drift from that exact phrasing
// (abbreviated month, missing comma, etc.) rather than guessing.
function parseReadingDate(html) {
  const match =
    /The bacteria levels reported for ([A-Za-z]+), ([A-Za-z]+) (\d{1,2})(st|nd|rd|th), (\d{4})\./
      .exec(html);
  if (!match) {
    return null;
  }
  const weekday = match[1];
  const monthName = match[2];
  const day = parseInt(match[3], 10);
  const suffix = match[4];
  const year = parseInt(match[5], 10);
  const monthIndex = MONTH_NAMES.indexOf(monthName.toLowerCase());
  if (monthIndex === -1 || isNaN(day) || isNaN(year)) {
    return null;
  }
  const asDate = new Date(Date.UTC(year, monthIndex, day, 12, 0, 0));
  if (isNaN(asDate.getTime())) {
    return null;
  }
  // Guard against the Date constructor silently rolling over an invalid
  // day (e.g. "February 30th") into the next month.
  if (asDate.getUTCFullYear() !== year || asDate.getUTCMonth() !== monthIndex ||
      asDate.getUTCDate() !== day) {
    return null;
  }
  const dateLabel = weekday + ", " + monthName + " " + day + suffix + ", " + year;
  return { dateLabel: dateLabel, isoDate: asDate.toISOString() };
}

// Pure. Extracts one site's numeric reading via "For {exact site name} is
// {number}". Returns a finite number or null (no match, or a non-numeric
// placeholder like "N/A"/"pending"/"--" on a day testing didn't happen) --
// a missing/unparseable reading here never blocks the other site's valid
// reading from being reported.
//
// CRITICAL: closure-level counts are exactly where a comma thousands
// separator appears (the page's own prose writes the "1,000" closure
// threshold with a comma). A capture that stopped at the comma would read
// "2,420" as "2" and bucket a CLOSED beach to green -- the worst possible
// bug. So the token capture includes commas, they are stripped, and the
// result must match a strict decimal shape or we degrade to null (never a
// guessed color) rather than trusting a malformed token.
function extractReading(html, siteNamePattern) {
  const match = new RegExp("For " + siteNamePattern + " is ([\\d.,]+)").exec(html);
  if (!match) {
    return null;
  }
  const raw = match[1].replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    return null;
  }
  const value = parseFloat(raw);
  if (!isFinite(value)) {
    return null;
  }
  return value;
}

// Pure. html + nowIso -> { updated, sites } | null. nowIso is the cron's
// current-time argument, used only to judge staleness -- never fabricated
// as the reading's own timestamp.
export function parseMichiganCityHtml(html, nowIso) {
  if (!html || typeof html !== "string") {
    return null;
  }
  const parsedDate = parseReadingDate(html);
  if (!parsedDate) {
    console.log("michiganCity: reading date not found or unparseable, skipping");
    return null;
  }
  const nowMs = Date.parse(nowIso);
  if (isNaN(nowMs)) {
    console.log("michiganCity: invalid nowIso, skipping");
    return null;
  }
  const readingMs = Date.parse(parsedDate.isoDate);
  const readingAgeDays = ageDays(nowMs, readingMs);
  if (readingAgeDays > MAX_STALE_DAYS) {
    console.log(
      "michiganCity: reading for " + parsedDate.dateLabel + " is " +
      readingAgeDays.toFixed(1) + " days old, treating as stale"
    );
    return null;
  }

  const sites = [];

  const washingtonParkValue = extractReading(html, "Washington Park Beach");
  if (washingtonParkValue !== null) {
    sites.push({
      siteId: "washington-park-beach",
      color: bacteriaColorFor(washingtonParkValue),
      reason:
        "Bacteria level reported by City of Michigan City for Washington Park Beach: " +
        washingtonParkValue + " (reported for " + parsedDate.dateLabel + ")",
      names: ["washington park beach", "washington park"],
      lat: MICHIGAN_CITY_LAT,
      lon: MICHIGAN_CITY_LON,
      radiusMi: 1
    });
  } else {
    console.log("michiganCity: Washington Park Beach reading missing or unparseable, omitting site");
  }

  const stop7Value = extractReading(html, "Stop 7 at Beachwalk");
  if (stop7Value !== null) {
    sites.push({
      siteId: "stop-7-beachwalk",
      color: bacteriaColorFor(stop7Value),
      reason:
        "Bacteria level reported by City of Michigan City for Stop 7 at Beachwalk: " +
        stop7Value + " (reported for " + parsedDate.dateLabel + ")",
      names: ["stop 7 at beachwalk", "stop 7", "beachwalk"]
    });
  } else {
    console.log("michiganCity: Stop 7 at Beachwalk reading missing or unparseable, omitting site");
  }

  if (sites.length === 0) {
    console.log("michiganCity: no readable site values found, skipping");
    return null;
  }

  return { updated: parsedDate.isoDate, sites: sites };
}

export const michiganCity = {
  id: "michigan-city-in",
  label: "City of Michigan City Beach Water Quality",
  url: MICHIGAN_CITY_URL,
  matches: function(beach) {
    const distMi = distanceMi(beach.lat, beach.lon, MICHIGAN_CITY_LAT, MICHIGAN_CITY_LON);
    if (distMi <= MICHIGAN_CITY_MATCH_RADIUS_MI) {
      return true;
    }
    // Name matching is geographically bounded: a "Washington Park"/"Beachwalk"
    // beach far from Michigan City can never inherit this reading.
    const haystack = ((beach.name || "") + " " + (beach.park_name || ""));
    if (/washington park|beachwalk/i.test(haystack)) {
      return distMi <= MICHIGAN_CITY_NAME_MATCH_RADIUS_MI;
    }
    return false;
  },
  scrape: async function(nowIso) {
    const html = await fetchText(MICHIGAN_CITY_URL, {
      headers: { "User-Agent": MICHIGAN_CITY_USER_AGENT },
      logPrefix: "michiganCity: fetch failed"
    });
    if (html === null) {
      return null;
    }
    try {
      const parsed = parseMichiganCityHtml(html, nowIso);
      if (!parsed) {
        return null;
      }
      return perBeachResult(parsed.sites, MICHIGAN_CITY_URL, parsed.updated);
    } catch (err) {
      console.log("michiganCity: fetch failed: " + err.message);
      return null;
    }
  }
};
