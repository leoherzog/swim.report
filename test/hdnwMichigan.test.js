// test/hdnwMichigan.test.js
// Pure-parse tests for the Health Department of Northwest Michigan scraper.
// No network: parseHdnwHtml is exercised against trimmed inline fixtures built
// from the real page markup (strings joined with + and "\n", never backticks).
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  parseHdnwHtml,
  hdnwMichigan,
  HDNW_URL,
  HDNW_USER_AGENT
} from "../src/officialSources/hdnwMichigan.js";
import { resolveSiteForBeach } from "../src/officialSources/index.js";
import { makeBeach } from "./helpers/beach.js";
import { findSite } from "./helpers/sites.js";
import { installFetch } from "./helpers/fetch.js";

const NOW = "2026-07-05T12:00:00.000Z";

// Real-shape rows: cell wrapping varies (plain <td>, <p>-wrapped, <strong>-wrapped,
// and split-<strong> "(Follow up)"), exactly as the hand-edited source emits.
const HEADER_ROW =
  "<tr><td width=\"84\"><p style=\"text-align: center;\"><strong>Date</strong></p></td>" +
  "<td style=\"text-align: center;\" width=\"90\"><strong>County</strong></td>" +
  "<td style=\"text-align: center;\" width=\"204\"><strong>Beach Name</strong></td>" +
  "<td style=\"text-align: center;\" width=\"138\"><strong> Sample results E. coli count per 100ml</strong></td>" +
  "<td style=\"text-align: center;\" width=\"96\"><strong>Water Quality Index</strong></td></tr>";

function dataRow(date, county, beach, ecoli, wqi) {
  return "<tr><td style=\"text-align: center;\" width=\"84\">" + date + "</td>" +
    "<td style=\"text-align: center;\" width=\"90\">" + county + "</td>" +
    "<td style=\"text-align: center;\" width=\"204\">" + beach + "</td>" +
    "<td style=\"text-align: center;\" width=\"138\">" + ecoli + "</td>" +
    "<td width=\"96\"><p style=\"text-align: center;\">" + wqi + "</p></td></tr>";
}

function tableHtml(rows) {
  return "<html><body><table>\n" + HEADER_ROW + "\n" + rows.join("\n") + "\n</table></body></html>";
}

describe("parseHdnwHtml WQI -> color mapping", function() {
  it("maps WQI 1/2/3/4 to green/yellow/red/double-red", function() {
    const html = tableHtml([
      dataRow("06/29/26", "Charlevoix", "Thumb Lake Beach", "7.3", "1"),
      dataRow("07/01/26", "Emmet", "Mackinaw 2", "365.4", "2"),
      dataRow("07/01/26", "Antrim", "Wooden Shoe Park", "410.6", "3"),
      dataRow("07/01/26", "Charlevoix", "Elm Point Beach", "517.2", "4")
    ]);
    const sites = parseHdnwHtml(html, NOW);
    expect(findSite(sites, "thumb lake beach").color).toBe("green");
    expect(findSite(sites, "mackinaw 2").color).toBe("yellow");
    expect(findSite(sites, "wooden shoe park").color).toBe("red");
    expect(findSite(sites, "elm point beach").color).toBe("double-red");
  });

  it("carries curated names[] and a reason with the sample date and E. coli", function() {
    const html = tableHtml([
      dataRow("06/29/26", "Charlevoix", "Thumb Lake Beach", "7.3", "1")
    ]);
    const sites = parseHdnwHtml(html, NOW);
    const site = findSite(sites, "thumb lake beach");
    expect(site.names).toEqual(["thumb lake"]);
    expect(site.reason.indexOf("06/29/26")).not.toBe(-1);
    expect(site.reason.indexOf("7.3")).not.toBe(-1);
  });

  it("stamps each site's updated with the winning row's sample date, not nowIso", function() {
    // Regression: this periodic sampling source must never present a days-old
    // reading as freshly updated — updated: nowIso would suppress the
    // frontend's 2-hour stale-data warning for up to 8 days.
    const html = tableHtml([
      dataRow("06/29/26", "Charlevoix", "Thumb Lake Beach", "7.3", "1"),
      dataRow("07/01/26", "Emmet", "Zorn Park", "5.0", "1"),
      dataRow("07/03/26", "Emmet", "Zorn Park", "&gt;2419.6", "3")
    ]);
    const sites = parseHdnwHtml(html, NOW);
    expect(findSite(sites, "thumb lake beach").updated).toBe("2026-06-29T00:00:00.000Z");
    // Most-recent-wins carries the WINNING row's date, not the older one.
    expect(findSite(sites, "zorn park").updated).toBe("2026-07-03T00:00:00.000Z");
  });
});

describe("parseHdnwHtml defensive skipping", function() {
  it("skips a malformed row missing cells but keeps the good one", function() {
    const malformed = "<tr><td>07/01/26</td><td>Emmet</td></tr>";
    const html = tableHtml([
      malformed,
      dataRow("07/01/26", "Emmet", "Zorn Park", "32.7", "1")
    ]);
    const sites = parseHdnwHtml(html, NOW);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("zorn park");
  });

  it("skips a row with an out-of-range WQI instead of guessing", function() {
    const html = tableHtml([
      dataRow("07/01/26", "Emmet", "Zorn Park", "32.7", "9"),
      dataRow("07/01/26", "Emmet", "Middle Village", "8.5", "1")
    ]);
    const sites = parseHdnwHtml(html, NOW);
    expect(findSite(sites, "zorn park")).toBe(null);
    expect(findSite(sites, "middle village").color).toBe("green");
  });

  it("skips a row for a beach not in the curated name map", function() {
    const html = tableHtml([
      dataRow("07/01/26", "Emmet", "Nowhere Public Access", "1.0", "1"),
      dataRow("07/01/26", "Emmet", "Middle Village", "8.5", "1")
    ]);
    const sites = parseHdnwHtml(html, NOW);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("middle village");
  });

  it("returns an empty array (not null) when the only row is stale", function() {
    const html = tableHtml([
      dataRow("06/29/26", "Charlevoix", "Thumb Lake Beach", "7.3", "1")
    ]);
    // 06/29 -> 07/15 is 16 days; the only row is stale, so nothing survives.
    // The table parsed fine and rows were iterated, so this is a successful
    // parse with nothing current to report -> [], NOT a failure (null). This is
    // the seasonal steady state once sampling pauses.
    expect(parseHdnwHtml(html, "2026-07-15T12:00:00.000Z")).toEqual([]);
  });

  it("keeps a fresh row on the 8-day boundary", function() {
    const html = tableHtml([
      dataRow("07/07/26", "Charlevoix", "Thumb Lake Beach", "7.3", "1")
    ]);
    // 07/07 -> 07/15 is exactly 8 days, not stale.
    const sites = parseHdnwHtml(html, "2026-07-15T12:00:00.000Z");
    expect(findSite(sites, "thumb lake beach").color).toBe("green");
  });
});

describe("parseHdnwHtml most-recent-per-beach", function() {
  it("uses the newest sample when an elevated reading has a (Follow up) retest", function() {
    const elevated =
      "<tr><td style=\"text-align: center;\" width=\"84\">06/29/26</td>" +
      "<td style=\"text-align: center;\" width=\"90\"><strong>Charlevoix</strong></td>" +
      "<td style=\"text-align: center;\" width=\"204\"><strong>Elm Point Beach</strong></td>" +
      "<td style=\"text-align: center;\" width=\"138\"><strong>517.2</strong></td>" +
      "<td width=\"96\"><p style=\"text-align: center;\"><strong>2</strong></p></td></tr>";
    const followUp =
      "<tr><td width=\"84\"><p style=\"text-align: center;\">06/30/26</p></td>" +
      "<td style=\"text-align: center;\" width=\"90\"><strong>Charlevoix</strong></td>" +
      "<td style=\"text-align: center;\" width=\"204\"><strong>Elm Point Beach </strong><strong>(Follow up)</strong></td>" +
      "<td style=\"text-align: center;\" width=\"138\"><strong>48.7</strong></td>" +
      "<td style=\"text-align: center;\" width=\"96\"><strong>1</strong></td></tr>";
    const html = tableHtml([elevated, followUp]);
    const sites = parseHdnwHtml(html, NOW);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("elm point beach");
    expect(sites[0].color).toBe("green");
  });
});

describe("parseHdnwHtml color derives from WQI, not E. coli format", function() {
  it("keeps a severe WQI-3 row whose E. coli is non-numeric (>2419.6) and lets it win over an older green row", function() {
    // Regression: the page's legend prints Level 3/4 E. coli as ">1000"; labs
    // report ">2419.6"/"TNTC". A numeric-E.coli gate would DROP this newer red
    // row and let the older green row win via most-recent-wins -> a wrong green.
    const html = tableHtml([
      dataRow("07/01/26", "Emmet", "Zorn Park", "5.0", "1"),
      dataRow("07/03/26", "Emmet", "Zorn Park", "&gt;2419.6", "3")
    ]);
    const sites = parseHdnwHtml(html, NOW);
    const site = findSite(sites, "zorn park");
    expect(site.color).toBe("red");
    expect(site.reason.indexOf("07/03/26")).not.toBe(-1);
    expect(site.reason.indexOf("2419.6")).not.toBe(-1);
  });

  it("still emits a reason when the E. coli cell is empty", function() {
    const html = tableHtml([
      dataRow("07/03/26", "Emmet", "Zorn Park", "", "3")
    ]);
    const sites = parseHdnwHtml(html, NOW);
    const site = findSite(sites, "zorn park");
    expect(site.color).toBe("red");
    expect(site.reason.indexOf("not reported")).not.toBe(-1);
  });
});

describe("parseHdnwHtml future-date guard", function() {
  it("drops an implausible future-dated row and keeps the current severe one", function() {
    // A future-dated green typo must never out-rank a current red reading.
    const html = tableHtml([
      dataRow("07/04/26", "Emmet", "Zorn Park", "1500.0", "3"),
      dataRow("07/20/26", "Emmet", "Zorn Park", "2.0", "1")
    ]);
    const sites = parseHdnwHtml(html, NOW);
    const site = findSite(sites, "zorn park");
    expect(site.color).toBe("red");
    expect(site.reason.indexOf("07/04/26")).not.toBe(-1);
  });

  it("drops a lone future-dated row entirely (returns an empty array)", function() {
    const html = tableHtml([
      dataRow("07/20/26", "Emmet", "Zorn Park", "2.0", "1")
    ]);
    // Table and row parsed, but the row is future-dated and dropped -> a
    // successful parse with nothing to report, not a failure.
    expect(parseHdnwHtml(html, NOW)).toEqual([]);
  });
});

describe("hdnwMichigan Oden vs Wooden Shoe Park resolution", function() {
  it("resolves a Wooden Shoe Park beach to its own site even when the Oden site is listed first", function() {
    // Regression: the bare substring "oden" is contained in "wooden shoe park".
    // With Oden emitted FIRST, resolveSiteForBeach's first-match-wins pass could
    // hand the Wooden Shoe Park beach the Oden color. The spaced alias prevents it.
    const html = tableHtml([
      dataRow("07/01/26", "Emmet", "Oden", "2.0", "1"),
      dataRow("07/01/26", "Antrim", "Wooden Shoe Park", "1500.0", "3")
    ]);
    const sites = parseHdnwHtml(html, NOW);
    const woodenBeach = makeBeach({ name: "Wooden Shoe Park", lat: 45.0, lon: -85.0 });
    const resolved = resolveSiteForBeach(woodenBeach, sites);
    expect(resolved).not.toBe(null);
    expect(resolved.siteId).toBe("wooden shoe park");
    expect(resolved.color).toBe("red");
  });

  it("still resolves a real Oden beach to the Oden site", function() {
    const html = tableHtml([
      dataRow("07/01/26", "Emmet", "Oden", "2.0", "1")
    ]);
    const sites = parseHdnwHtml(html, NOW);
    const odenBeach = makeBeach({ name: "Oden Beach", lat: 45.42, lon: -84.83 });
    const resolved = resolveSiteForBeach(odenBeach, sites);
    expect(resolved).not.toBe(null);
    expect(resolved.siteId).toBe("oden");
    expect(resolved.color).toBe("green");
  });
});

describe("parseHdnwHtml empty/garbage", function() {
  // null is reserved for a parse that could not proceed (page-shape failure);
  // the health tracker counts it as a failure. A successful parse with nothing
  // current to report returns an empty array instead (see below).
  it("returns null for empty, null, or non-table input", function() {
    expect(parseHdnwHtml("", NOW)).toBe(null);
    expect(parseHdnwHtml(null, NOW)).toBe(null);
    expect(parseHdnwHtml("<html><body><p>no table here</p></body></html>", NOW)).toBe(null);
  });

  it("returns null when nowIso is not a parseable ISO date", function() {
    const html = tableHtml([
      dataRow("06/29/26", "Charlevoix", "Thumb Lake Beach", "7.3", "1")
    ]);
    expect(parseHdnwHtml(html, "not-a-date")).toBe(null);
  });

  it("returns an empty array (not null) when the table has only a header and no valid data rows", function() {
    // The <table> and its header <tr> are found and iterated — the parse
    // succeeded — but the header row carries no valid sample, so nothing
    // survives. That is empty-success ([]), not a page-shape failure (null).
    const html = "<table>\n" + HEADER_ROW + "\n</table>";
    expect(parseHdnwHtml(html, NOW)).toEqual([]);
  });
});

describe("hdnwMichigan.matches", function() {
  it("matches a beach inside the four-county bounding box", function() {
    const beach = makeBeach({ name: "Petoskey State Park", lat: 45.40, lon: -84.90 });
    expect(hdnwMichigan.matches(beach)).toBe(true);
  });

  it("does not match a South Haven beach far to the south", function() {
    const beach = makeBeach({ name: "South Haven South Beach", lat: 42.40, lon: -86.28 });
    expect(hdnwMichigan.matches(beach)).toBe(false);
  });

  it("does not match a beach with non-numeric coordinates", function() {
    const beach = makeBeach({ name: "Broken", lat: null, lon: null });
    expect(hdnwMichigan.matches(beach)).toBe(false);
  });
});

describe("hdnwMichigan.scrape empty-success vs failure", function() {
  afterEach(function() {
    vi.unstubAllGlobals();
  });

  // A fetch Response stand-in whose text() resolves to body.
  function textResponse(body) {
    return {
      ok: true,
      text: function() {
        return Promise.resolve(body);
      }
    };
  }

  it("returns a HEALTHY perBeachResult with empty sites when every row is stale (seasonal steady state)", async function() {
    // 06/20 -> 07/05 is 15 days: the table parses fine but nothing is current.
    // scrape() must forward the empty-success as perBeachResult([], ...), NOT
    // null — null would make the health tracker count a normal off-season
    // scrape as a failure.
    const html = tableHtml([
      dataRow("06/20/26", "Charlevoix", "Thumb Lake Beach", "7.3", "1")
    ]);
    installFetch(function() {
      return Promise.resolve(textResponse(html));
    });
    const result = await hdnwMichigan.scrape(NOW);
    expect(result).not.toBe(null);
    expect(result.perBeach).toBe(true);
    expect(result.sites).toEqual([]);
    expect(result.source).toBe(HDNW_URL);
    expect(result.sources).toEqual([HDNW_URL]);
    // Result-level fallback timestamp is the cron tick for this call.
    expect(result.updated).toBe(NOW);
  });

  it("returns null (a parse FAILURE) when the fetched page has no <table>", async function() {
    installFetch(function() {
      return Promise.resolve(
        textResponse("<html><body><p>maintenance page, no table</p></body></html>")
      );
    });
    const result = await hdnwMichigan.scrape(NOW);
    expect(result).toBe(null);
  });

  it("sends the polite identifying User-Agent on the single page fetch", async function() {
    const html = tableHtml([
      dataRow("07/01/26", "Emmet", "Zorn Park", "5.0", "1")
    ]);
    const calls = installFetch(function() {
      return Promise.resolve(textResponse(html));
    });
    await hdnwMichigan.scrape(NOW);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(HDNW_URL);
    expect(calls[0].init.headers["User-Agent"]).toBe(HDNW_USER_AGENT);
  });

  it("returns null when the fetch itself fails (non-2xx), distinct from empty-success", async function() {
    installFetch(function() {
      return Promise.resolve({ ok: false, status: 403 });
    });
    const result = await hdnwMichigan.scrape(NOW);
    expect(result).toBe(null);
  });
});
