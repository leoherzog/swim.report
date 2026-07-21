// src/officialSources/southHaven.js
// Official scraper for the City of South Haven, Michigan beach flag program.
//
// The flag information page itself only contains a STATIC LEGEND (one image
// each of Green/Yellow/Red/Grey2.png explaining what the colors mean) — it
// must never be parsed for a live color. The real live feed is the published
// Google Sheet linked from the page as the "text version" (ADA alternative):
// a headerless CSV with one sentence per line, e.g.
//   "Flag #6 North Beach is Green"
//   "North Pier is Open"
// Flags #6-#9 all belong to North Beach and #10-#12 to South Beach (multiple
// flag poles along one named beach); same-named flags are rolled up to the
// most severe color. Gray means unmonitored (9pm-9am local, or the Sept 15 -
// May 15 off-season) and maps to NO DATA for that site, never a color.
//
// scrape() runs cron-side only; parseSouthHavenCsv and
// extractSouthHavenCsvUrl are pure and exported for tests.

import { fetchText, FLAG_SEVERITY } from "./util.js";

export const SOUTH_HAVEN_URL =
  "https://www.southhavenmi.gov/parks_and_recreation/beach_flag_information.php";

// Known-good CSV export of the published Google Sheet (fallback when the
// page-scrape extraction fails). The docs.google.com pub URL 307-redirects to
// a signed, time-limited googleusercontent.com URL — always request this URL
// fresh and follow redirects; never cache the redirect target.
export const SOUTH_HAVEN_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRAdoBsn5LKoLXcUdFHtgEqB4b9T9XF8r6anhryOayDnG1rY3a50TfG-x-Jz0sZx38k3fexmwGj-rBH/pub?gid=1431034760&single=true&output=csv";

// southhavenmi.gov returns HTTP 403 to requests without a User-Agent, and
// Workers' fetch sends none by default.
export const SOUTH_HAVEN_USER_AGENT = "swim.report (hello@swim.report)";

// Monitored season and daily hours, in America/Detroit local time. Sourced
// from the flag page's own legend: "A GRAY FLAG ... conditions are not being
// monitored (9pm-9am), or the Beach Safety Program is out-of-season (Sept. 15
// - May 15)." The published Google Sheet carries NO timestamp, so an abandoned
// sheet left on a colored value would republish that stale color forever.
// Outside this window nobody is updating the sheet, so we drop colored output
// to no-data — the Gray/unmonitored convention already implies these windows.
// Boundaries are inclusive (roughly May 15 - Sept 15); hours are [9, 21).
const MONITOR_SEASON_START = { month: 5, day: 15 }; // May 15
const MONITOR_SEASON_END = { month: 9, day: 15 };   // Sept 15
const MONITOR_HOUR_START = 9;  // 9am local
const MONITOR_HOUR_END = 21;   // 9pm local (exclusive)

// Pure. Given the cron's passed-in ISO timestamp, is South Haven within its
// monitored season AND monitored hours in America/Detroit local time? Parses
// the passed-in string only (no Date.now()); uses Intl for the DST-correct
// local wall-clock. A missing/unparseable timestamp is treated as monitored
// (do not gate on a clock we do not have; scrape always supplies one, and the
// pure CSV tests exercise the parse without a clock).
export function isSouthHavenMonitored(nowIso) {
  if (typeof nowIso !== "string" || nowIso.length === 0) {
    return true;
  }
  const date = new Date(nowIso);
  if (isNaN(date.getTime())) {
    return true;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Detroit",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hour12: false
  }).formatToParts(date);
  let month = null;
  let day = null;
  let hour = null;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].type === "month") {
      month = parseInt(parts[i].value, 10);
    } else if (parts[i].type === "day") {
      day = parseInt(parts[i].value, 10);
    } else if (parts[i].type === "hour") {
      hour = parseInt(parts[i].value, 10);
    }
  }
  if (month === null || day === null || hour === null || isNaN(hour)) {
    return true;
  }
  // hour12:false renders midnight as 24 in some ICU builds; normalize to 0.
  if (hour === 24) {
    hour = 0;
  }
  if (hour < MONITOR_HOUR_START || hour >= MONITOR_HOUR_END) {
    return false;
  }
  if (month < MONITOR_SEASON_START.month || month > MONITOR_SEASON_END.month) {
    return false;
  }
  if (month === MONITOR_SEASON_START.month && day < MONITOR_SEASON_START.day) {
    return false;
  }
  if (month === MONITOR_SEASON_END.month && day > MONITOR_SEASON_END.day) {
    return false;
  }
  return true;
}

// The 9 named flag sites, in the CSV's document order. csvName is compared
// (lowercased) against the beach-name portion of each "Flag #N <name> is
// <Color>" line. names[]/lat/lon feed resolveSiteForBeach; coordinates are
// approximate positions along the South Haven lakeshore.
const SITE_DEFS = [
  { csvName: "newcome beach", siteId: "newcome-beach", label: "Newcome Beach", names: ["newcome"], lat: 42.4152, lon: -86.2757 },
  { csvName: "oak st. beach", siteId: "oak-st-beach", label: "Oak St. Beach", names: ["oak st", "oak street"], lat: 42.4135, lon: -86.2762 },
  { csvName: "packard park beach", siteId: "packard-park-beach", label: "Packard Park Beach", names: ["packard"], lat: 42.4118, lon: -86.2769 },
  { csvName: "dyckman ave. beach", siteId: "dyckman-ave-beach", label: "Dyckman Ave. Beach", names: ["dyckman"], lat: 42.4088, lon: -86.2779 },
  { csvName: "woodman st. beach", siteId: "woodman-st-beach", label: "Woodman St. Beach", names: ["woodman"], lat: 42.4075, lon: -86.2785 },
  { csvName: "north beach", siteId: "north-beach", label: "North Beach", names: ["north beach"], lat: 42.4059, lon: -86.2795 },
  { csvName: "south beach", siteId: "south-beach", label: "South Beach", names: ["south beach"], lat: 42.4008, lon: -86.2865 },
  // NOTE: names[] deliberately omits "van buren" — Van Buren State Park is a
  // SEPARATE DNR-monitored beach ~3 mi south that still falls inside the
  // matches() bbox, and "van buren" as a substring would wrongly resolve that
  // park's beach to this city stairway's flag (a wrong-beach, wrong-color
  // trap). "brown stairs" is unambiguous; the real Van Buren St. stairway
  // beach still resolves here by proximity.
  { csvName: "brown stairs (van buren st.)", siteId: "brown-stairs", label: "Brown Stairs (Van Buren St.)", names: ["brown stairs"], lat: 42.3968, lon: -86.2895 },
  { csvName: "blue stairs (kids corner)", siteId: "blue-stairs", label: "Blue Stairs (Kids Corner)", names: ["blue stairs", "kids corner"], lat: 42.3985, lon: -86.2885 }
];

// "Flag #N <name> is <Color>" — the color is captured as the whole remainder
// of the line (not a single token) so a multi-word status like "Double Red"
// is handed to normalizeSouthHavenColor rather than failing the line match (or
// truncating to "Red"). An unrecognized color still normalizes to null.
const FLAG_LINE_RE = /^Flag #(\d+) (.+?) is (.+)$/;
// Pier gate lines are piers, not swim flags — recognized and ignored.
const PIER_LINE_RE = /^(North|South) Pier is (Open|Closed)$/;

// double-red is the most severe official tier (see OFFICIAL_COLORS in
// officialSources/index.js); FLAG_SEVERITY (imported above) makes it outrank
// red in the same-site rollup.

// Pure. Canonicalize a raw color phrase to a known South Haven flag color, or
// null if it is not one. Case-insensitive; collapses interior spaces/hyphens
// so "Double Red", "Double-Red", and "DoubleRed" all map to "double-red".
// Uses an explicit allowlist (never a prototype-chain membership test) so a
// value like "constructor" can never smuggle itself past the guard. Never
// guesses a color from an unrecognized word — returns null so the caller skips
// the line.
function normalizeSouthHavenColor(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const key = raw.toLowerCase().replace(/[\s-]+/g, "");
  if (key === "green") {
    return "green";
  }
  if (key === "yellow") {
    return "yellow";
  }
  if (key === "red") {
    return "red";
  }
  if (key === "doublered") {
    return "double-red";
  }
  if (key === "gray" || key === "grey") {
    return "gray";
  }
  return null;
}

// Pure. CSV text (+ the cron's ISO timestamp) -> sites[] (contract shape (b)
// sites), [] when there is no reportable data, or null when the feed is
// unusable. Rules:
//   - outside the monitored season/hours (isSouthHavenMonitored) the sheet is
//     unattended, so any color it still shows is stale: return [] (no data),
//     never a color;
//   - a line that matches neither FLAG_LINE_RE nor PIER_LINE_RE is LOGGED and
//     SKIPPED (only that line drops), so one novel line never discards every
//     site's official data — but if NOTHING in the feed is recognized the
//     parse returns null (do not present no-data as "all monitored and clear");
//   - a flag line whose color is not recognized is skipped and, if it names a
//     known site, TAINTS that site so it is omitted (we never guess a color,
//     and never report a color we cannot fully confirm for the site), while
//     every other site still comes through;
//   - "Double Red"/"Double-Red"/"DoubleRed" normalize to double-red;
//   - gray/grey = unmonitored; a site whose flags are all gray is omitted;
//   - a site mixing gray with real colors is omitted too (status of the whole
//     site cannot be confirmed — omitting is safer than a partial rollup);
//   - same-named flags roll up to the MOST SEVERE color (double-red > red >
//     yellow > green) so repeated names never silently resolve to a favorable
//     flag;
//   - a flag line naming an unknown beach is skipped (it cannot map to a
//     site, and failing known sites because of a new one helps no one).
export function parseSouthHavenCsv(text, nowIso) {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  if (!isSouthHavenMonitored(nowIso)) {
    // Unattended sheet outside the monitored window: drop any colored value
    // rather than republishing a stale official flag. No data this tick.
    console.log("southHaven: outside monitored season/hours, dropping colored output");
    return [];
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (/^\s*</.test(body)) {
    console.log("southHaven: CSV endpoint returned markup, not CSV");
    return null;
  }
  const lines = body.split(/\r?\n/);
  const grouped = {};
  // Count of lines we understood (a pier line, or a flag line with a known
  // color). If zero, the feed is unparseable and we return null rather than an
  // empty "all clear".
  let recognized = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }
    if (PIER_LINE_RE.test(line)) {
      recognized++;
      continue;
    }
    const match = FLAG_LINE_RE.exec(line);
    if (!match) {
      // Unrecognized line: log and skip only this line so one novel format
      // line never discards every site's data. Never guess a color from it.
      console.log("southHaven: unrecognized CSV line, skipping: " + line);
      continue;
    }
    const beachName = match[2].trim().toLowerCase();
    const color = normalizeSouthHavenColor(match[3]);
    let def = null;
    for (let j = 0; j < SITE_DEFS.length; j++) {
      if (SITE_DEFS[j].csvName === beachName) {
        def = SITE_DEFS[j];
        break;
      }
    }
    if (color === null) {
      // A flag line with a color we do not recognize (e.g. a brand-new status
      // word). Skip the line; if it names a known site, taint that site so we
      // omit it rather than report a color we cannot fully confirm — but keep
      // every other site. Never guess the color.
      console.log("southHaven: unrecognized flag color, skipping: " + line);
      if (def) {
        if (!grouped[def.siteId]) {
          grouped[def.siteId] = { colors: [], grayCount: 0, tainted: false };
        }
        grouped[def.siteId].tainted = true;
      }
      continue;
    }
    recognized++;
    if (!def) {
      console.log("southHaven: unknown beach name in CSV, skipping: " + line);
      continue;
    }
    if (!grouped[def.siteId]) {
      grouped[def.siteId] = { colors: [], grayCount: 0, tainted: false };
    }
    if (color === "gray") {
      grouped[def.siteId].grayCount++;
    } else {
      grouped[def.siteId].colors.push(color);
    }
  }
  if (recognized === 0) {
    // Nothing in the feed parsed. Treat as unusable, not "all clear".
    console.log("southHaven: no recognizable lines in CSV");
    return null;
  }
  const sites = [];
  for (let i = 0; i < SITE_DEFS.length; i++) {
    const def = SITE_DEFS[i];
    const group = grouped[def.siteId];
    if (!group) {
      continue;
    }
    if (group.tainted) {
      // A flag at this site had an unconfirmable color: omit the whole site.
      console.log("southHaven: unconfirmable flag color for " + def.label + ", omitting site");
      continue;
    }
    if (group.colors.length === 0) {
      // All flags gray: unmonitored, no data for this site.
      continue;
    }
    if (group.grayCount > 0) {
      // Mixed gray + real colors: the whole site's status cannot be
      // confirmed, so report nothing rather than a partial rollup.
      console.log("southHaven: mixed gray and colored flags for " + def.label + ", omitting site");
      continue;
    }
    let worst = group.colors[0];
    for (let j = 1; j < group.colors.length; j++) {
      if (FLAG_SEVERITY[group.colors[j]] > FLAG_SEVERITY[worst]) {
        worst = group.colors[j];
      }
    }
    sites.push({
      siteId: def.siteId,
      color: worst,
      reason: "Official flag reported by City of South Haven Beach Flag Program for " + def.label,
      names: def.names,
      lat: def.lat,
      lon: def.lon
    });
  }
  return sites;
}

// Pure. Flag-page HTML -> CSV export URL or null. The page links the "text
// version" as a docs.google.com/spreadsheets .../pubhtml (or /pub) viewer
// URL with HTML-entity-encoded ampersands; rebuild the canonical
// pub?gid=...&single=true&output=csv export from its publish ID and gid so a
// re-published sheet does not silently break the scraper.
export function extractSouthHavenCsvUrl(html) {
  if (typeof html !== "string" || html.length === 0) {
    return null;
  }
  const match = /https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/([A-Za-z0-9_-]+)\/pub(?:html)?\?([^"'\s<>]*)/.exec(html);
  if (!match) {
    return null;
  }
  const query = match[2].replace(/&amp;/g, "&");
  const gidMatch = /(?:^|&)gid=(\d+)(?:&|$)/.exec(query);
  if (!gidMatch) {
    return null;
  }
  return "https://docs.google.com/spreadsheets/d/e/" + match[1] +
    "/pub?gid=" + gidMatch[1] + "&single=true&output=csv";
}

function inSouthHavenBox(beach) {
  return beach.lat >= 42.35 && beach.lat <= 42.45 && beach.lon >= -86.32 && beach.lon <= -86.24;
}

export const southHaven = {
  id: "south-haven-mi",
  label: "City of South Haven Beach Flag Program",
  url: SOUTH_HAVEN_URL,
  // Health-monitor gate (see the scraper-health step in src/index.js): the
  // season/hours pre-fetch skip in scrape() is a DELIBERATE null, not a
  // failure — unmonitored hours must not count toward the consecutive-null
  // alert streak.
  healthMonitored: function(nowIso) {
    return isSouthHavenMonitored(nowIso);
  },
  matches: function(beach) {
    if (/south haven/i.test(beach.name)) {
      return true;
    }
    return inSouthHavenBox(beach);
  },
  scrape: async function(nowIso) {
    // Freshness gate: outside the monitored season/hours the published sheet
    // is unattended and any color it shows is stale. Skip the fetch entirely
    // and report no data rather than republishing a stale official flag.
    if (!isSouthHavenMonitored(nowIso)) {
      console.log("southHaven: outside monitored season/hours, skipping fetch");
      return null;
    }
    // Best effort: discover the current CSV href from the flag page so a
    // re-published sheet keeps working; fall back to the known CSV URL. The
    // legend images on the page are NEVER parsed for a color.
    const pageHtml = await fetchText(SOUTH_HAVEN_URL, {
      headers: { "User-Agent": SOUTH_HAVEN_USER_AGENT },
      logPrefix: "southHaven: flag page fetch failed"
    });
    let csvUrl = pageHtml === null ? null : extractSouthHavenCsvUrl(pageHtml);
    if (!csvUrl) {
      csvUrl = SOUTH_HAVEN_CSV_URL;
    }
    // The docs.google.com pub URL 307-redirects to a signed, single-use
    // googleusercontent.com URL — follow it fresh every tick.
    const csvText = await fetchText(csvUrl, {
      redirect: "follow",
      headers: { "User-Agent": SOUTH_HAVEN_USER_AGENT },
      logPrefix: "southHaven: CSV fetch failed"
    });
    if (csvText === null) {
      return null;
    }
    try {
      const sites = parseSouthHavenCsv(csvText, nowIso);
      if (!sites || sites.length === 0) {
        // null: unparseable. []: every site gray/unmonitored. Either way
        // there is no official data this tick.
        return null;
      }
      return {
        perBeach: true,
        sites: sites,
        source: SOUTH_HAVEN_URL,
        sources: [SOUTH_HAVEN_URL, csvUrl],
        updated: nowIso
      };
    } catch (err) {
      console.log("southHaven: CSV fetch failed: " + err.message);
      return null;
    }
  }
};
