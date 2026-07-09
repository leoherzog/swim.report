// test/officialSources.test.js
import { describe, it, expect } from "vitest";
import {
  parseSouthHavenCsv,
  extractSouthHavenCsvUrl,
  isSouthHavenMonitored,
  southHaven,
  SOUTH_HAVEN_CSV_URL
} from "../src/officialSources/southHaven.js";
import {
  scrapers,
  findScraper,
  resolveSiteForBeach,
  scrapeOfficialFlagFromResult,
  scrapeOfficialFlag
} from "../src/officialSources/index.js";

// Mirrors the live feed layout: CRLF line endings, no header row, flags
// #6-#9 all named North Beach, #10-#12 all named South Beach, and two
// unnumbered pier lines at the end.
function southHavenCsv(lines) {
  return lines.join("\r\n");
}

function siteById(sites, siteId) {
  for (const site of sites) {
    if (site.siteId === siteId) {
      return site;
    }
  }
  return null;
}

describe("parseSouthHavenCsv", function() {
  it("parses green, yellow, and red sites from a full monitored feed", function() {
    const csv = southHavenCsv([
      "Flag #1 Newcome Beach is Green",
      "Flag #2 Oak St. Beach is Green",
      "Flag #3 Packard Park Beach is Yellow",
      "Flag #4 Dyckman Ave. Beach is Green",
      "Flag #5 Woodman St. Beach is Green",
      "Flag #6 North Beach is Green",
      "Flag #7 North Beach is Green",
      "Flag #8 North Beach is Green",
      "Flag #9 North Beach is Green",
      "Flag #10 South Beach is Red",
      "Flag #11 South Beach is Red",
      "Flag #12 South Beach is Red",
      "Flag #13 Brown Stairs (Van Buren St.) is Yellow",
      "Flag #14 Blue Stairs (Kids Corner) is Green",
      "North Pier is Open",
      "South Pier is Open"
    ]);
    const sites = parseSouthHavenCsv(csv);
    expect(sites).not.toBe(null);
    expect(sites.length).toBe(9);
    expect(siteById(sites, "newcome-beach").color).toBe("green");
    expect(siteById(sites, "packard-park-beach").color).toBe("yellow");
    expect(siteById(sites, "north-beach").color).toBe("green");
    expect(siteById(sites, "south-beach").color).toBe("red");
    expect(siteById(sites, "brown-stairs").color).toBe("yellow");
    const north = siteById(sites, "north-beach");
    expect(north.names).toContain("north beach");
    expect(typeof north.lat).toBe("number");
    expect(typeof north.lon).toBe("number");
    expect(north.reason).toBe(
      "Official flag reported by City of South Haven Beach Flag Program for North Beach"
    );
  });

  it("rolls disagreeing same-named flags up to the most severe color", function() {
    const csv = southHavenCsv([
      "Flag #6 North Beach is Green",
      "Flag #7 North Beach is Yellow",
      "Flag #8 North Beach is Green",
      "Flag #9 North Beach is Green",
      "Flag #10 South Beach is Yellow",
      "Flag #11 South Beach is Red",
      "Flag #12 South Beach is Green"
    ]);
    const sites = parseSouthHavenCsv(csv);
    expect(sites.length).toBe(2);
    expect(siteById(sites, "north-beach").color).toBe("yellow");
    expect(siteById(sites, "south-beach").color).toBe("red");
  });

  it("omits gray (unmonitored) sites instead of reporting a color", function() {
    const csv = southHavenCsv([
      "Flag #1 Newcome Beach is Gray",
      "Flag #6 North Beach is Gray",
      "Flag #7 North Beach is Gray",
      "Flag #10 South Beach is Green"
    ]);
    const sites = parseSouthHavenCsv(csv);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("south-beach");
    expect(sites[0].color).toBe("green");
  });

  it("returns an empty list (not null) when every site is gray", function() {
    const csv = southHavenCsv([
      "Flag #6 North Beach is Gray",
      "Flag #10 South Beach is Gray",
      "North Pier is Open",
      "South Pier is Open"
    ]);
    expect(parseSouthHavenCsv(csv)).toEqual([]);
  });

  it("omits a site that mixes gray with real colors", function() {
    const csv = southHavenCsv([
      "Flag #6 North Beach is Green",
      "Flag #7 North Beach is Gray",
      "Flag #10 South Beach is Yellow"
    ]);
    const sites = parseSouthHavenCsv(csv);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("south-beach");
  });

  it("ignores pier lines (Open and Closed)", function() {
    const csv = southHavenCsv([
      "Flag #10 South Beach is Green",
      "North Pier is Closed",
      "South Pier is Open"
    ]);
    const sites = parseSouthHavenCsv(csv);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("south-beach");
  });

  it("accepts Grey spelling and trailing blank lines", function() {
    const csv = southHavenCsv([
      "Flag #6 North Beach is Grey",
      "Flag #10 South Beach is Green",
      ""
    ]);
    const sites = parseSouthHavenCsv(csv);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("south-beach");
  });

  it("skips a single unrecognized line without discarding the rest of the feed", function() {
    // A novel/garbage line must not null the whole feed (which would strip
    // every South Haven site of official data exactly when a new format
    // appears). The recognized sites still come through; only the bad line
    // drops. Never guesses a color from the skipped line.
    const csv = southHavenCsv([
      "Flag #6 North Beach is Green",
      "Something unexpected appeared",
      "Flag #10 South Beach is Red"
    ]);
    const sites = parseSouthHavenCsv(csv);
    expect(sites.length).toBe(2);
    expect(siteById(sites, "north-beach").color).toBe("green");
    expect(siteById(sites, "south-beach").color).toBe("red");
  });

  it("returns null when NOTHING in the feed is recognized", function() {
    // Skipping bad lines never becomes "all clear": a feed with no recognizable
    // line at all is unusable and must return null, not an empty site list.
    const csv = southHavenCsv([
      "Something unexpected appeared",
      "Another mystery row"
    ]);
    expect(parseSouthHavenCsv(csv)).toBe(null);
  });

  it("parses Double Red wording variants to the double-red color", function() {
    // The published sheet has no double-red tier today, but the parser must be
    // ready for it: the color capture must handle the two-word spacing and the
    // hyphenated/joined variants, never truncating to "Red".
    expect(parseSouthHavenCsv("Flag #6 North Beach is Double Red")[0].color)
      .toBe("double-red");
    expect(parseSouthHavenCsv("Flag #6 North Beach is Double-Red")[0].color)
      .toBe("double-red");
    expect(parseSouthHavenCsv("Flag #6 North Beach is DoubleRed")[0].color)
      .toBe("double-red");
    // double-red outranks red in the same-site rollup.
    const csv = southHavenCsv([
      "Flag #6 North Beach is Red",
      "Flag #7 North Beach is Double Red",
      "Flag #8 North Beach is Green"
    ]);
    expect(siteById(parseSouthHavenCsv(csv), "north-beach").color).toBe("double-red");
  });

  it("skips an unrecognized flag color instead of guessing", function() {
    // An unknown single-word color: the only line, so nothing is recognized and
    // the parse returns null (never a guessed color).
    expect(parseSouthHavenCsv("Flag #6 North Beach is Purple")).toBe(null);
    // Trailing punctuation must not be tolerated into a valid color either.
    expect(parseSouthHavenCsv("Flag #6 North Beach is Green.")).toBe(null);
    // "Constructor" (and other Object.prototype property names) must be treated
    // as an unknown color, NOT slip past a prototype-chain membership check.
    expect(parseSouthHavenCsv("Flag #6 North Beach is Constructor")).toBe(null);
  });

  it("does not let a prototype-name color smuggle a green past the rollup", function() {
    // "Constructor" must never be treated as a color. It taints North Beach
    // (unconfirmable flag), so the site is omitted rather than reporting the
    // sibling's green. With no other site, the feed collapses to no data ([]),
    // never an official green the source did not confirm for the whole site.
    const csv = southHavenCsv([
      "Flag #6 North Beach is Green",
      "Flag #7 North Beach is Constructor"
    ]);
    expect(parseSouthHavenCsv(csv)).toEqual([]);
  });

  it("keeps other sites when one site is tainted by an unconfirmable color", function() {
    const csv = southHavenCsv([
      "Flag #6 North Beach is Green",
      "Flag #7 North Beach is Constructor",
      "Flag #10 South Beach is Yellow"
    ]);
    const sites = parseSouthHavenCsv(csv);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("south-beach");
    expect(sites[0].color).toBe("yellow");
  });

  it("returns [] for the real off-season feed (every named flag Gray)", function() {
    // Byte-for-byte layout of the live probe on 2026-07-05: all 14 named flags
    // Gray (unmonitored / off-season) plus two Open pier lines. No site may be
    // reported with a color; the whole feed collapses to no data.
    const csv = southHavenCsv([
      "Flag #1 Newcome Beach is Gray",
      "Flag #2 Oak St. Beach is Gray",
      "Flag #3 Packard Park Beach is Gray",
      "Flag #4 Dyckman Ave. Beach is Gray",
      "Flag #5 Woodman St. Beach is Gray",
      "Flag #6 North Beach is Gray",
      "Flag #7 North Beach is Gray",
      "Flag #8 North Beach is Gray",
      "Flag #9 North Beach is Gray",
      "Flag #10 South Beach is Gray",
      "Flag #11 South Beach is Gray",
      "Flag #12 South Beach is Gray",
      "Flag #13 Brown Stairs (Van Buren St.) is Gray",
      "Flag #14 Blue Stairs (Kids Corner) is Gray",
      "North Pier is Open",
      "South Pier is Open"
    ]);
    expect(parseSouthHavenCsv(csv)).toEqual([]);
  });

  it("drops colored output to no-data for an out-of-season timestamp", function() {
    // The published sheet carries no timestamp; outside the monitored window it
    // is unattended and any color it still shows is stale. A colored feed must
    // collapse to [] (no data) when the cron timestamp is out of season, and
    // parse normally when it is in season.
    const csv = southHavenCsv([
      "Flag #6 North Beach is Green",
      "Flag #10 South Beach is Red"
    ]);
    // 2026-01-15 13:00 America/Detroit — deep off-season (Sept 15 - May 15).
    expect(parseSouthHavenCsv(csv, "2026-01-15T18:00:00.000Z")).toEqual([]);
    // 2026-07-09 02:00 America/Detroit — in season but outside 9am-9pm hours.
    expect(parseSouthHavenCsv(csv, "2026-07-09T06:00:00.000Z")).toEqual([]);
    // 2026-07-09 14:00 America/Detroit — in season, monitored hours.
    expect(parseSouthHavenCsv(csv, "2026-07-09T18:00:00.000Z").length).toBe(2);
  });

  it("skips a flag line for an unknown beach without failing known sites", function() {
    const csv = southHavenCsv([
      "Flag #10 South Beach is Green",
      "Flag #15 Brand New Beach is Red"
    ]);
    const sites = parseSouthHavenCsv(csv);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("south-beach");
  });

  it("returns null for HTML instead of CSV", function() {
    const html = "<!DOCTYPE html>\n<html><body>" +
      "Flag #6 North Beach is Green" +
      "</body></html>";
    expect(parseSouthHavenCsv(html)).toBe(null);
  });

  it("returns null for empty or non-string input", function() {
    expect(parseSouthHavenCsv("")).toBe(null);
    expect(parseSouthHavenCsv(null)).toBe(null);
    expect(parseSouthHavenCsv(undefined)).toBe(null);
  });
});

describe("isSouthHavenMonitored", function() {
  // All timestamps are UTC; America/Detroit is UTC-4 (EDT) in summer and
  // UTC-5 (EST) in winter, handled by Intl.
  it("is monitored in season during 9am-9pm local", function() {
    // 2026-07-09 14:00 America/Detroit (EDT).
    expect(isSouthHavenMonitored("2026-07-09T18:00:00.000Z")).toBe(true);
  });

  it("is not monitored deep in the off-season", function() {
    // 2026-01-15 13:00 America/Detroit (EST).
    expect(isSouthHavenMonitored("2026-01-15T18:00:00.000Z")).toBe(false);
  });

  it("is not monitored before 9am local, even in season", function() {
    // 2026-07-09 08:00 America/Detroit.
    expect(isSouthHavenMonitored("2026-07-09T12:00:00.000Z")).toBe(false);
  });

  it("is not monitored at/after 9pm local, even in season", function() {
    // 2026-07-08 22:00 America/Detroit.
    expect(isSouthHavenMonitored("2026-07-09T02:00:00.000Z")).toBe(false);
  });

  it("treats the season boundaries inclusively (Sept 15 in, Sept 16 out)", function() {
    expect(isSouthHavenMonitored("2026-09-15T18:00:00.000Z")).toBe(true);  // Sept 15 14:00 local
    expect(isSouthHavenMonitored("2026-09-16T18:00:00.000Z")).toBe(false); // Sept 16 14:00 local
  });

  it("treats the season start inclusively (May 15 in, May 14 out)", function() {
    expect(isSouthHavenMonitored("2026-05-15T18:00:00.000Z")).toBe(true);  // May 15 14:00 local
    expect(isSouthHavenMonitored("2026-05-14T18:00:00.000Z")).toBe(false); // May 14 14:00 local
  });

  it("does not gate when the timestamp is missing or unparseable", function() {
    // scrape always supplies a real ISO string; absence must not silently
    // suppress the feed, and the pure CSV tests run without a clock.
    expect(isSouthHavenMonitored(undefined)).toBe(true);
    expect(isSouthHavenMonitored("")).toBe(true);
    expect(isSouthHavenMonitored(null)).toBe(true);
    expect(isSouthHavenMonitored("not-a-date")).toBe(true);
  });
});

describe("extractSouthHavenCsvUrl", function() {
  it("rebuilds the CSV export URL from the page's pubhtml href", function() {
    // Real href shape from the live page: pubhtml viewer link with
    // HTML-entity-encoded ampersands.
    const html = "<p>...click here for a text version of the beach safety information.</p>" +
      "<a href=\"https://docs.google.com/spreadsheets/d/e/" +
      "2PACX-1vRAdoBsn5LKoLXcUdFHtgEqB4b9T9XF8r6anhryOayDnG1rY3a50TfG-x-Jz0sZx38k3fexmwGj-rBH" +
      "/pubhtml?gid=1431034760&amp;single=true\">click here</a>";
    expect(extractSouthHavenCsvUrl(html)).toBe(SOUTH_HAVEN_CSV_URL);
  });

  it("accepts a direct pub?output=csv href with a different publish id", function() {
    const html = "<a href=\"https://docs.google.com/spreadsheets/d/e/" +
      "2PACX-newid_123/pub?gid=42&single=true&output=csv\">text version</a>";
    expect(extractSouthHavenCsvUrl(html)).toBe(
      "https://docs.google.com/spreadsheets/d/e/2PACX-newid_123/pub?gid=42&single=true&output=csv"
    );
  });

  it("returns null when the href has no gid", function() {
    const html = "<a href=\"https://docs.google.com/spreadsheets/d/e/2PACX-newid_123/pubhtml?single=true\">x</a>";
    expect(extractSouthHavenCsvUrl(html)).toBe(null);
  });

  it("returns null when no spreadsheet link is present", function() {
    expect(extractSouthHavenCsvUrl("<html><body>no links here</body></html>")).toBe(null);
    expect(extractSouthHavenCsvUrl("")).toBe(null);
    expect(extractSouthHavenCsvUrl(null)).toBe(null);
  });
});

describe("southHaven.matches", function() {
  it("matches a beach named South Haven South Beach", function() {
    const beach = { id: "osm-node-1", name: "South Haven South Beach", lat: 42.4, lon: -86.28, nws_zone: null, nws_grid_url: null, osm_id: "node/1" };
    expect(southHaven.matches(beach)).toBe(true);
  });

  it("matches a beach inside the South Haven bounding box with an unrelated name", function() {
    const beach = { id: "osm-node-2", name: "Packard Park Beach", lat: 42.39, lon: -86.28, nws_zone: null, nws_grid_url: null, osm_id: "node/2" };
    expect(southHaven.matches(beach)).toBe(true);
  });

  it("does not match Holland State Park coordinates", function() {
    const beach = { id: "osm-node-3", name: "Holland State Park", lat: 42.7739, lon: -86.2109, nws_zone: null, nws_grid_url: null, osm_id: "node/3" };
    expect(southHaven.matches(beach)).toBe(false);
  });
});

describe("Van Buren State Park name trap (wrong-beach guard)", function() {
  // Van Buren State Park is a SEPARATE DNR-monitored beach ~3 mi south of the
  // city, but its coordinates fall inside the South Haven matches() bbox. Its
  // name contains "van buren", which used to be a Brown Stairs (Van Buren St.)
  // name substring — so the park's beach would inherit the city stairway's
  // flag color. It must NOT resolve to any site: not by name (substring
  // removed) and not by proximity (>1.5 mi from every site).
  const vanBurenSp = {
    id: "osm-node-vbsp",
    name: "Van Buren State Park",
    park_name: "Van Buren State Park",
    lat: 42.3576,
    lon: -86.2865,
    nws_zone: null,
    nws_grid_url: null,
    osm_id: "node/vbsp"
  };

  it("is claimed by the bbox but resolves to no site (no borrowed color)", function() {
    expect(southHaven.matches(vanBurenSp)).toBe(true);
    const fullFeed = parseSouthHavenCsv(southHavenCsv([
      "Flag #13 Brown Stairs (Van Buren St.) is Green",
      "Flag #14 Blue Stairs (Kids Corner) is Green"
    ]));
    expect(resolveSiteForBeach(vanBurenSp, fullFeed)).toBe(null);
  });
});

const V2_BEACH = {
  id: "osm-node-99",
  name: "Oval Beach",
  park_name: null,
  lat: 42.4,
  lon: -86.28,
  nws_zone: null,
  nws_grid_url: null,
  osm_id: "node/99"
};

function multiSiteResult(sites) {
  return {
    perBeach: true,
    sites: sites,
    source: "https://example.gov/flags",
    sources: ["https://example.gov/flags"],
    updated: "2026-07-05T12:00:00.000Z"
  };
}

describe("resolveSiteForBeach", function() {
  it("matches by names[] substring against the beach name", function() {
    const sites = [
      { siteId: "north", color: "green", reason: "r", names: ["north beach"] },
      { siteId: "oval", color: "red", reason: "r", names: ["oval beach"] }
    ];
    expect(resolveSiteForBeach(V2_BEACH, sites)).toBe(sites[1]);
  });

  it("matches by names[] substring against park_name", function() {
    const beach = Object.assign({}, V2_BEACH, { name: "Swimming Area", park_name: "Warren Dunes State Park" });
    const sites = [
      { siteId: "warren", color: "yellow", reason: "r", names: ["warren dunes"] }
    ];
    expect(resolveSiteForBeach(beach, sites)).toBe(sites[0]);
  });

  it("prefers a name match over a closer proximity-only site", function() {
    const sites = [
      { siteId: "near", color: "green", reason: "r", lat: 42.4, lon: -86.28 },
      { siteId: "named", color: "red", reason: "r", names: ["oval"], lat: 42.41, lon: -86.28 }
    ];
    expect(resolveSiteForBeach(V2_BEACH, sites)).toBe(sites[1]);
  });

  it("falls back to the nearest site within the default 1.5 mi radius", function() {
    const sites = [
      { siteId: "far", color: "red", reason: "r", lat: 42.41, lon: -86.28 },
      { siteId: "near", color: "yellow", reason: "r", lat: 42.405, lon: -86.28 }
    ];
    // 42.41 is ~0.69 mi away, 42.405 is ~0.35 mi away; both within 1.5 mi.
    expect(resolveSiteForBeach(V2_BEACH, sites)).toBe(sites[1]);
  });

  it("does not proximity-match a site beyond the default 1.5 mi radius", function() {
    const sites = [
      // 0.03 deg latitude is ~2.1 mi.
      { siteId: "far", color: "red", reason: "r", lat: 42.43, lon: -86.28 }
    ];
    expect(resolveSiteForBeach(V2_BEACH, sites)).toBe(null);
  });

  it("honors a per-site radiusMi override", function() {
    const sites = [
      { siteId: "far", color: "red", reason: "r", lat: 42.43, lon: -86.28, radiusMi: 3 }
    ];
    expect(resolveSiteForBeach(V2_BEACH, sites)).toBe(sites[0]);
  });

  it("returns null when nothing matches", function() {
    const sites = [
      { siteId: "other", color: "green", reason: "r", names: ["silver beach"] },
      { siteId: "faraway", color: "green", reason: "r", lat: 43.5, lon: -86.28 }
    ];
    expect(resolveSiteForBeach(V2_BEACH, sites)).toBe(null);
    expect(resolveSiteForBeach(V2_BEACH, [])).toBe(null);
    expect(resolveSiteForBeach(V2_BEACH, null)).toBe(null);
  });

  it("ignores a site with neither names nor lat/lon", function() {
    const sites = [
      { siteId: "orphan", color: "green", reason: "r" }
    ];
    expect(resolveSiteForBeach(V2_BEACH, sites)).toBe(null);
  });
});

describe("scrapeOfficialFlagFromResult", function() {
  const fakeScraper = { id: "fake-v2", label: "Fake Flag Program", url: "https://example.gov/flags" };

  it("stamps beachId onto a legacy single-color result without mutating it", function() {
    const result = {
      color: "red",
      reason: "Official flag reported by Fake Flag Program",
      official: true,
      scraperId: "fake-v2",
      source: "https://example.gov/flags",
      sources: ["https://example.gov/flags"],
      updated: "2026-07-05T12:00:00.000Z"
    };
    const flag = scrapeOfficialFlagFromResult(V2_BEACH, fakeScraper, result);
    expect(flag).not.toBe(null);
    expect(flag.beachId).toBe("osm-node-99");
    expect(flag.color).toBe("red");
    expect(flag.official).toBe(true);
    expect(result.beachId).toBe(undefined);
  });

  it("resolves a multi-site result to the matching site", function() {
    const result = multiSiteResult([
      { siteId: "north", color: "green", reason: "North flag is green", names: ["north beach"] },
      { siteId: "oval", color: "double-red", reason: "Oval flag is double red", names: ["oval beach"] }
    ]);
    const flag = scrapeOfficialFlagFromResult(V2_BEACH, fakeScraper, result);
    expect(flag).toEqual({
      beachId: "osm-node-99",
      color: "double-red",
      reason: "Oval flag is double red",
      official: true,
      scraperId: "fake-v2",
      source: "https://example.gov/flags",
      sources: ["https://example.gov/flags"],
      updated: "2026-07-05T12:00:00.000Z"
    });
  });

  it("prefers a per-site updated (the source's own reading date) over the result-level updated", function() {
    // Regression: periodic sources (E. coli sampling, weekly reports) stamp
    // each site with the reading's own timestamp; using the result-level
    // nowIso would present days-old data as fresh and suppress the UI's
    // 2-hour stale-data warning.
    const result = multiSiteResult([
      {
        siteId: "oval",
        color: "yellow",
        reason: "Sampled days ago",
        names: ["oval beach"],
        updated: "2026-06-28T00:00:00.000Z"
      }
    ]);
    const flag = scrapeOfficialFlagFromResult(V2_BEACH, fakeScraper, result);
    expect(flag).not.toBe(null);
    expect(flag.updated).toBe("2026-06-28T00:00:00.000Z");
  });

  it("falls back to the result-level updated when a site has no (or an empty) updated", function() {
    const result = multiSiteResult([
      { siteId: "oval", color: "green", reason: "r", names: ["oval beach"], updated: "" }
    ]);
    const flag = scrapeOfficialFlagFromResult(V2_BEACH, fakeScraper, result);
    expect(flag.updated).toBe("2026-07-05T12:00:00.000Z");
  });

  it("returns null for a multi-site result when no site resolves", function() {
    const result = multiSiteResult([
      { siteId: "other", color: "green", reason: "r", names: ["silver beach"] }
    ]);
    expect(scrapeOfficialFlagFromResult(V2_BEACH, fakeScraper, result)).toBe(null);
  });

  it("returns null for an invalid site color instead of guessing", function() {
    const result = multiSiteResult([
      { siteId: "oval", color: "purple", reason: "r", names: ["oval beach"] }
    ]);
    expect(scrapeOfficialFlagFromResult(V2_BEACH, fakeScraper, result)).toBe(null);
  });

  it("returns null for an invalid legacy color instead of guessing", function() {
    const result = { color: "blue", reason: "r", official: true, scraperId: "fake-v2", source: "u", sources: ["u"], updated: "2026-07-05T12:00:00.000Z" };
    expect(scrapeOfficialFlagFromResult(V2_BEACH, fakeScraper, result)).toBe(null);
  });

  it("returns null for a null result", function() {
    expect(scrapeOfficialFlagFromResult(V2_BEACH, fakeScraper, null)).toBe(null);
  });
});

describe("scrapeOfficialFlag (dual-shape via registry)", function() {
  function withFakeScraper(scraper, fn) {
    scrapers.unshift(scraper);
    return Promise.resolve(fn()).finally(function() {
      scrapers.shift();
    });
  }

  const testBeach = Object.assign({}, V2_BEACH, { name: "Contract V2 Test Beach" });

  it("handles a legacy single-color scrape result", async function() {
    const scraper = {
      id: "fake-legacy",
      label: "Fake Legacy Program",
      url: "https://example.gov/legacy",
      matches: function(beach) { return beach.name === "Contract V2 Test Beach"; },
      scrape: async function(nowIso) {
        return {
          color: "yellow",
          reason: "Official flag reported by Fake Legacy Program",
          official: true,
          scraperId: "fake-legacy",
          source: "https://example.gov/legacy",
          sources: ["https://example.gov/legacy"],
          updated: nowIso
        };
      }
    };
    await withFakeScraper(scraper, async function() {
      const flag = await scrapeOfficialFlag(testBeach, "2026-07-05T12:00:00.000Z");
      expect(flag.beachId).toBe("osm-node-99");
      expect(flag.color).toBe("yellow");
      expect(flag.official).toBe(true);
      expect(flag.updated).toBe("2026-07-05T12:00:00.000Z");
    });
  });

  it("handles a multi-site scrape result and returns null for unresolved beaches", async function() {
    const scraper = {
      id: "fake-multi",
      label: "Fake Multi Program",
      url: "https://example.gov/multi",
      matches: function(beach) { return beach.name === "Contract V2 Test Beach"; },
      scrape: async function(nowIso) {
        return {
          perBeach: true,
          sites: [
            { siteId: "v2", color: "red", reason: "Site flag is red", names: ["contract v2"] }
          ],
          source: "https://example.gov/multi",
          sources: ["https://example.gov/multi"],
          updated: nowIso
        };
      }
    };
    await withFakeScraper(scraper, async function() {
      const flag = await scrapeOfficialFlag(testBeach, "2026-07-05T12:00:00.000Z");
      expect(flag.beachId).toBe("osm-node-99");
      expect(flag.color).toBe("red");
      expect(flag.reason).toBe("Site flag is red");
      expect(flag.scraperId).toBe("fake-multi");
    });
    const unresolvedScraper = Object.assign({}, scraper, {
      scrape: async function(nowIso) {
        return {
          perBeach: true,
          sites: [
            { siteId: "elsewhere", color: "green", reason: "r", names: ["some other beach"] }
          ],
          source: "https://example.gov/multi",
          sources: ["https://example.gov/multi"],
          updated: nowIso
        };
      }
    });
    await withFakeScraper(unresolvedScraper, async function() {
      const flag = await scrapeOfficialFlag(testBeach, "2026-07-05T12:00:00.000Z");
      expect(flag).toBe(null);
    });
  });

  it("returns null when the scraper throws", async function() {
    const scraper = {
      id: "fake-throwing",
      label: "Fake Throwing Program",
      url: "https://example.gov/throw",
      matches: function(beach) { return beach.name === "Contract V2 Test Beach"; },
      scrape: async function(nowIso) { throw new Error("boom"); }
    };
    await withFakeScraper(scraper, async function() {
      const flag = await scrapeOfficialFlag(testBeach, "2026-07-05T12:00:00.000Z");
      expect(flag).toBe(null);
    });
  });
});

describe("findScraper", function() {
  it("returns southHaven for a matching BeachRow", function() {
    const beach = { id: "osm-node-1", name: "South Haven North Beach", lat: 42.41, lon: -86.29, nws_zone: null, nws_grid_url: null, osm_id: "node/1" };
    expect(findScraper(beach)).toBe(southHaven);
  });

  it("returns null for a non-matching BeachRow", function() {
    const beach = { id: "osm-node-3", name: "Holland State Park", lat: 42.7739, lon: -86.2109, nws_zone: null, nws_grid_url: null, osm_id: "node/3" };
    expect(findScraper(beach)).toBe(null);
  });
});
