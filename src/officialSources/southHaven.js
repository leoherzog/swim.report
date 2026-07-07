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

// "Flag #N <name> is <Color>" — anchored, one color word (letters/hyphens
// only), so a novel multi-word color like "Double Red" fails the line match
// instead of truncating to "Red".
const FLAG_LINE_RE = /^Flag #(\d+) (.+?) is ([A-Za-z-]+)$/;
// Pier gate lines are piers, not swim flags — recognized and ignored.
const PIER_LINE_RE = /^(North|South) Pier is (Open|Closed)$/;

const SEVERITY = { green: 1, yellow: 2, red: 3 };

// Pure. CSV text -> sites[] (contract shape (b) sites) or null on any
// unrecognized content. Rules:
//   - every non-empty line must match FLAG_LINE_RE or PIER_LINE_RE, else the
//     whole parse returns null (defensive: never guess around new formats);
//   - a flag color outside green/yellow/red/gray/grey fails the whole parse;
//   - gray/grey = unmonitored; a site whose flags are all gray is omitted;
//   - a site mixing gray with real colors is omitted too (status of the whole
//     site cannot be confirmed — omitting is safer than a partial rollup);
//   - same-named flags roll up to the MOST SEVERE color (red > yellow >
//     green) so repeated names never silently resolve to a favorable flag;
//   - a flag line naming an unknown beach is skipped (it cannot map to a
//     site, and failing known sites because of a new one helps no one).
export function parseSouthHavenCsv(text) {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (/^\s*</.test(body)) {
    console.log("southHaven: CSV endpoint returned markup, not CSV");
    return null;
  }
  const lines = body.split(/\r?\n/);
  const grouped = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }
    if (PIER_LINE_RE.test(line)) {
      continue;
    }
    const match = FLAG_LINE_RE.exec(line);
    if (!match) {
      console.log("southHaven: unrecognized CSV line: " + line);
      return null;
    }
    const beachName = match[2].trim().toLowerCase();
    const colorWord = match[3].toLowerCase();
    const isGray = colorWord === "gray" || colorWord === "grey";
    // hasOwnProperty, not the "in" operator: "constructor" (and other
    // Object.prototype names) would pass an "in" check and smuggle a non-color
    // past the guard instead of failing the parse like any other unknown color.
    if (!isGray && !Object.prototype.hasOwnProperty.call(SEVERITY, colorWord)) {
      console.log("southHaven: unrecognized flag color: " + line);
      return null;
    }
    let def = null;
    for (let j = 0; j < SITE_DEFS.length; j++) {
      if (SITE_DEFS[j].csvName === beachName) {
        def = SITE_DEFS[j];
        break;
      }
    }
    if (!def) {
      console.log("southHaven: unknown beach name in CSV, skipping: " + line);
      continue;
    }
    if (!grouped[def.siteId]) {
      grouped[def.siteId] = { colors: [], grayCount: 0 };
    }
    if (isGray) {
      grouped[def.siteId].grayCount++;
    } else {
      grouped[def.siteId].colors.push(colorWord);
    }
  }
  const sites = [];
  for (let i = 0; i < SITE_DEFS.length; i++) {
    const def = SITE_DEFS[i];
    const group = grouped[def.siteId];
    if (!group) {
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
      if (SEVERITY[group.colors[j]] > SEVERITY[worst]) {
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
  matches: function(beach) {
    if (/south haven/i.test(beach.name)) {
      return true;
    }
    return inSouthHavenBox(beach);
  },
  scrape: async function(nowIso) {
    // Best effort: discover the current CSV href from the flag page so a
    // re-published sheet keeps working; fall back to the known CSV URL. The
    // legend images on the page are NEVER parsed for a color.
    let csvUrl = null;
    try {
      const pageResponse = await fetch(SOUTH_HAVEN_URL, {
        headers: { "User-Agent": SOUTH_HAVEN_USER_AGENT }
      });
      if (pageResponse.ok) {
        csvUrl = extractSouthHavenCsvUrl(await pageResponse.text());
      } else {
        console.log("southHaven: flag page fetch failed: HTTP " + pageResponse.status);
      }
    } catch (err) {
      console.log("southHaven: flag page fetch failed: " + err.message);
    }
    if (!csvUrl) {
      csvUrl = SOUTH_HAVEN_CSV_URL;
    }
    try {
      // The docs.google.com pub URL 307-redirects to a signed, single-use
      // googleusercontent.com URL — follow it fresh every tick.
      const response = await fetch(csvUrl, {
        redirect: "follow",
        headers: { "User-Agent": SOUTH_HAVEN_USER_AGENT }
      });
      if (!response.ok) {
        console.log("southHaven: CSV fetch failed: HTTP " + response.status);
        return null;
      }
      const sites = parseSouthHavenCsv(await response.text());
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
