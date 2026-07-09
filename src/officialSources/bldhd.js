// src/officialSources/bldhd.js
// Official scraper for the Benzie-Leelanau District Health Department (BLDHD)
// weekly beach monitoring report (bldhd.org, Michigan). scrape() runs
// cron-side only; parseBldhdHtml is pure and exported for tests.
//
// IMPORTANT cadence note: BLDHD posts this report roughly once a week (not
// hourly like most other sources), so the frontend's 2-hour stale-data
// warning will almost always be showing for beaches resolved through this
// scraper. That is expected/correct behavior per the "estimated is honest"
// product principle, not a scraper bug -- see the staleness gate below, which
// additionally refuses to report anything at all once the *report itself* is
// more than BLDHD_STALE_DAYS old (the health department has simply stopped
// updating it, e.g. off-season).
//
// Color-mapping legend (CONFIRMED 2026-07-09): the beach-monitoring page's
// table reports a numeric "Water Quality Index" Level per beach. That page
// itself carries no definition of the Levels, but the SAME SITE's weekly PDF
// press release (linked from bldhd.org/publications/, e.g. the July 9 2026
// "Weekly Benzie and Leelanau Beach Report") publishes an authoritative Water
// Quality Index legend defining Levels 1-4 with exact E. coli thresholds and
// swim-safety meanings. BLDHD is the authority for its own index, so those
// verbatim meanings are the mapping source of record:
//   Level 1 = "E. coli levels meet EGLE swimming standards for full body
//             contact"                                              -> green
//   Level 2 = "contact above the waist not advised" (wading/fishing/boating
//             ok; an advisory is triggered)                         -> yellow
//   Level 3 = "E. coli levels exceed EGLE standards, no body contact
//             advised"                                              -> red
//   Level 4 = "Health Alert. ... Avoid contact with beach waters" (the most
//             severe index level)                              -> double-red
// A related Grand Traverse County release corroborates the semantics: media
// releases/advisories are issued only when a beach reaches "Level 2 or higher".
// Any Level number NOT in this legend (e.g. a future Level 5, or an
// unparseable cell) stays UNCONFIRMED and is omitted (logged, never reported)
// rather than guessed. Reporting a wrong official color is the worst possible
// bug in this product, so "no data" is always preferred over a guess.

export const BLDHD_URL = "https://www.bldhd.org/beach-monitoring/";

// bldhd.org has not been observed to require a User-Agent, but every other
// scraper in this repo sends an identifying one, and Workers' fetch sends
// none by default.
export const BLDHD_USER_AGENT = "swim.report (hello@swim.report)";

// The report is posted roughly weekly; treat anything older than this as a
// stale/abandoned page rather than trustworthy current data.
export const BLDHD_STALE_DAYS = 8;

// Slack (days) tolerated on the FUTURE side of the freshness gate. A
// legitimately current report is never dated ahead of nowIso, but a small
// window absorbs any timezone/parse edge; anything beyond it is a typo or an
// abandoned page and is refused rather than trusted.
export const BLDHD_FUTURE_SLACK_DAYS = 1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// BLDHD Water Quality Index Level -> estimated official flag color, taken
// verbatim from the health department's own weekly-report legend (see file
// header). A Level not present here is UNCONFIRMED and omitted, never guessed.
const LEVEL_COLORS = {
  1: "green",
  2: "yellow",
  3: "red",
  4: "double-red"
};

// Curated from the 10 rows observed live in the BLDHD weekly table (see
// docs/official-sources-verified.json). matchKey is a normalized substring
// used to identify which curated site a scraped row text belongs to (row
// order in the source table is not guaranteed to be stable). names[] are
// lowercase substrings handed downstream to resolveSiteForBeach() to match
// against real D1 beach records; lat/lon are approximate shoreline
// coordinates for the named site, used as a proximity fallback.
const KNOWN_SITES = [
  {
    siteId: "beulah-crystal-lake",
    matchKey: "beulah",
    // NOT "crystal lake": Crystal Lake is a ~9-mile lake and BLDHD only
    // samples the Beulah end, so a "crystal lake" substring would wrongly
    // inherit Beulah's green onto any unmonitored beach elsewhere on the
    // lake. Resolution falls back to the 1.5-mi proximity guard for beaches
    // actually near the sampling point.
    names: ["beulah beach", "beulah"],
    lat: 44.6336,
    lon: -86.0908
  },
  {
    siteId: "empire-beach",
    matchKey: "empire beach",
    names: ["empire beach"],
    lat: 44.8195,
    lon: -86.0517
  },
  {
    siteId: "frankfort-beach",
    matchKey: "frankfort",
    names: ["frankfort beach"],
    lat: 44.6325,
    lon: -86.2358
  },
  {
    siteId: "greilickville-harbor-park",
    matchKey: "greilickville",
    names: ["greilickville harbor park", "greilickville"],
    lat: 44.7767,
    lon: -85.6702
  },
  {
    siteId: "vans-beach-leland",
    matchKey: "vans beach",
    names: ["van's beach", "vans beach", "leland"],
    lat: 45.0189,
    lon: -85.7539
  },
  {
    siteId: "northport-marina",
    matchKey: "northport",
    names: ["northport marina", "northport"],
    lat: 45.1364,
    lon: -85.6122
  },
  {
    siteId: "omena-beach",
    matchKey: "omena",
    names: ["omena beach", "omena"],
    lat: 45.0669,
    lon: -85.6353
  },
  {
    siteId: "south-bar-lake",
    matchKey: "south bar lake",
    names: ["south bar lake"],
    lat: 44.8064,
    lon: -86.0403
  },
  {
    siteId: "suttons-bay-marina",
    matchKey: "suttons bay marina",
    names: ["suttons bay marina"],
    lat: 44.9464,
    lon: -85.6733
  },
  {
    siteId: "suttons-bay-park",
    matchKey: "suttons bay park",
    names: ["suttons bay park"],
    lat: 44.9481,
    lon: -85.6717
  }
];

function normalizeWhitespace(s) {
  return s.replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

function normalizeName(s) {
  return s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function findKnownSite(rawName) {
  const normalized = normalizeName(rawName);
  for (let i = 0; i < KNOWN_SITES.length; i++) {
    if (normalized.indexOf(KNOWN_SITES[i].matchKey) !== -1) {
      return KNOWN_SITES[i];
    }
  }
  return null;
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

// Pure. html -> { raw: "7/2/2026", iso: "2026-07-02T00:00:00Z" } | null.
export function parseBldhdReportDate(html) {
  if (!html || typeof html !== "string") {
    return null;
  }
  const match = /Beach Report\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(html);
  if (!match) {
    return null;
  }
  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return {
    raw: month + "/" + day + "/" + year,
    iso: year + "-" + pad2(month) + "-" + pad2(day) + "T00:00:00Z",
    index: match.index
  };
}

// Pure. Full parse: report-date extraction + staleness gate + per-beach Level
// row extraction. Returns a shape-(b) multi-site result or null. Never
// throws, never fetches, never reads the system clock -- nowIso arrives as an
// argument (see openMeteo.js's findHourIndex for the same new Date(nowIso)
// pattern used elsewhere in this repo).
export function parseBldhdHtml(html, nowIso) {
  if (!html || typeof html !== "string") {
    console.log("bldhd: empty or non-string html");
    return null;
  }
  const reportDate = parseBldhdReportDate(html);
  if (!reportDate) {
    console.log("bldhd: no \"Beach Report M/D/YYYY\" header found");
    return null;
  }
  const reportTime = new Date(reportDate.iso).getTime();
  const nowTime = new Date(nowIso).getTime();
  if (isNaN(reportTime) || isNaN(nowTime)) {
    console.log("bldhd: could not parse report date or nowIso for staleness check");
    return null;
  }
  const ageDays = (nowTime - reportTime) / MS_PER_DAY;
  if (ageDays > BLDHD_STALE_DAYS) {
    console.log(
      "bldhd: report dated " + reportDate.raw + " is " + ageDays.toFixed(1) +
      " days old (> " + BLDHD_STALE_DAYS + "), treating as stale, skipping"
    );
    return null;
  }
  // The staleness gate must be two-sided. The report header carries a
  // manually-typed date; a wrong year (e.g. "7/2/2027") or an abandoned page
  // frozen on a future date would otherwise sail past the "> STALE_DAYS" check
  // forever and keep reporting Level 1 -> official green indefinitely. A
  // legitimate report can never be dated in the future (the source date is a
  // Michigan calendar day parsed as UTC midnight, and Michigan is behind UTC,
  // so nowTime is always >= reportTime for a same-day report). Allow a small
  // slack for any timezone edge, then refuse a future-dated report rather than
  // trusting a typo/stale page.
  if (ageDays < -BLDHD_FUTURE_SLACK_DAYS) {
    console.log(
      "bldhd: report dated " + reportDate.raw + " is " + (-ageDays).toFixed(1) +
      " days in the FUTURE (typo or abandoned page), refusing to report"
    );
    return null;
  }

  const tableStart = html.indexOf("<table", reportDate.index);
  if (tableStart === -1) {
    console.log("bldhd: no table found after report header");
    return null;
  }
  const tableEnd = html.indexOf("</table>", tableStart);
  if (tableEnd === -1) {
    console.log("bldhd: unterminated table after report header");
    return null;
  }
  const tableHtml = html.substring(tableStart, tableEnd);

  const rowRegex = /<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/gi;
  const sites = [];
  let rowMatch = rowRegex.exec(tableHtml);
  let sawAnyRow = false;
  while (rowMatch !== null) {
    sawAnyRow = true;
    const name = normalizeWhitespace(rowMatch[1]);
    const levelCell = normalizeWhitespace(rowMatch[2]);
    const levelMatch = /Level\s*(\d)/i.exec(levelCell);
    if (!levelMatch) {
      console.log("bldhd: row \"" + name + "\" has no parseable Level, skipping");
      rowMatch = rowRegex.exec(tableHtml);
      continue;
    }
    const level = parseInt(levelMatch[1], 10);
    const known = findKnownSite(name);
    if (!known) {
      console.log("bldhd: unrecognized beach name \"" + name + "\", skipping");
      rowMatch = rowRegex.exec(tableHtml);
      continue;
    }
    const color = LEVEL_COLORS[level];
    if (color) {
      sites.push({
        siteId: known.siteId,
        color: color,
        reason: "Official flag reported by Benzie-Leelanau District Health Department " +
          "(Level " + level + ", report dated " + reportDate.raw + ")",
        names: known.names,
        lat: known.lat,
        lon: known.lon
      });
    } else {
      // A Level outside the confirmed 1-4 legend (e.g. a future Level 5 or a
      // malformed cell) has no authoritative meaning -- omit rather than guess.
      console.log(
        "bldhd: beach \"" + name + "\" reported Level " + level +
        " which is not in the confirmed BLDHD Water Quality Index legend " +
        "(Levels 1-4), omitting rather than guessing"
      );
    }
    rowMatch = rowRegex.exec(tableHtml);
  }
  if (!sawAnyRow) {
    console.log("bldhd: no rows found in table");
    return null;
  }
  if (sites.length === 0) {
    return null;
  }
  return {
    perBeach: true,
    sites: sites,
    source: BLDHD_URL,
    sources: [BLDHD_URL],
    // updated is the REPORT date, not nowIso. BLDHD posts roughly weekly, so
    // stamping nowIso (as real-time scrapers do) would make every official
    // green look freshly-updated in the UI and permanently suppress the
    // frontend's 2-hour stale-data warning -- the exact opposite of this
    // file's header note and the product's honesty principle. Reporting the
    // report date instead makes the footer show when the data was actually
    // published and lets the stale warning surface honestly.
    updated: reportDate.iso
  };
}

export const bldhd = {
  id: "bldhd-mi",
  label: "Benzie-Leelanau District Health Department Beach Monitoring",
  url: BLDHD_URL,
  matches: function(beach) {
    return beach.lat >= 44.55 && beach.lat <= 45.15 &&
      beach.lon >= -86.30 && beach.lon <= -85.55;
  },
  scrape: async function(nowIso) {
    try {
      const response = await fetch(BLDHD_URL, {
        headers: { "User-Agent": BLDHD_USER_AGENT }
      });
      if (!response.ok) {
        console.log("bldhd: fetch failed: HTTP " + response.status);
        return null;
      }
      const html = await response.text();
      return parseBldhdHtml(html, nowIso);
    } catch (err) {
      console.log("bldhd: fetch failed: " + err.message);
      return null;
    }
  }
};
