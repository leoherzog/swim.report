// test/lenawee.test.js
import { describe, it, expect } from "vitest";
import { parseLenaweeHtml, lenawee } from "../src/officialSources/lenawee.js";
import { makeBeach } from "./helpers/beach.js";

// Trimmed fixture mirroring the real table structure on
// https://www.lenawee.mi.us/1099/Public-Beach-Monitoring : one <h2
// class="subhead1"> "Beaches" section marker, a two-column table with an
// <h2 class="subhead1"><strong>NAME</strong></h2> header per beach, a
// "Status: ..." div per beach, and a single shared "Last Updated: ..." line
// in the table's tfoot, followed by a "Public Beach Water Testing Results"
// marker that closes the section.
function lenaweePage(hayesStatus, hudsonStatus, lastUpdated) {
  return "<html><body>" +
    "<h2 class=\"subhead1\">Beaches</h2>" +
    "<p style=\"text-align: center;\"><em>Status will be updated by Thursday 5:00 PM each week during the swimming season</em></p>" +
    "<table style=\"width: 100%;\">" +
    "<tbody>" +
    "<tr>" +
    "<td><h2 class=\"subhead1\" style=\"text-align: center;\"><strong>Hayes State Park</strong></h2></td>" +
    "<td><h2 class=\"subhead1\" style=\"text-align: center;\"><strong>Lake Hudson Recreation Area</strong></h2></td>" +
    "</tr>" +
    "<tr>" +
    "<td><div style=\"text-align: center;\">Status: " + hayesStatus + "</div></td>" +
    "<td><div style=\"text-align: center;\">Status: " + hudsonStatus + "</div></td>" +
    "</tr>" +
    "<tr>" +
    "<td><img src=\"/ImageRepository/Document?documentId=9826\" alt=\"no advisory posted\"></td>" +
    "<td><img src=\"/ImageRepository/Document?documentId=9826\" alt=\"no advisory posted #2\"></td>" +
    "</tr>" +
    "</tbody>" +
    "<tfoot><tr><td colspan=\"2\" style=\"text-align: center;\">" +
    "<div style=\"text-align: center;\"><strong><em>Last Updated: " + lastUpdated + "</em></strong></div>" +
    "</td></tr></tfoot>" +
    "</table>" +
    "<h2 class=\"subhead1\"><strong>Public Beach Water Testing Results</strong></h2>" +
    "</body></html>";
}

describe("parseLenaweeHtml", function() {
  const RECENT_NOW = "2026-07-05T12:00:00.000Z";

  it("parses No Advisory Posted for both beaches as green", function() {
    const html = lenaweePage(
      "No Advisory Posted", "No Advisory Posted", "7/1/26 8:40 AM"
    );
    const sites = parseLenaweeHtml(html, RECENT_NOW);
    expect(sites).not.toBe(null);
    expect(sites.length).toBe(2);
    const hayes = sites.filter(function(s) { return s.siteId === "hayes-state-park"; })[0];
    const hudson = sites.filter(function(s) { return s.siteId === "lake-hudson"; })[0];
    expect(hayes.color).toBe("green");
    expect(hayes.names).toEqual(["hayes state park"]);
    expect(typeof hayes.lat).toBe("number");
    expect(typeof hayes.lon).toBe("number");
    expect(hayes.reason).toContain("Hayes State Park");
    expect(hayes.reason).toContain("7/1/26 8:40 AM");
    expect(hudson.color).toBe("green");
    expect(hudson.names).toEqual(["lake hudson"]);
    expect(hudson.reason).toContain("Lake Hudson Recreation Area");
  });

  it("stamps each site's updated with the page's Last Updated timestamp, not nowIso", function() {
    // Regression: this periodic (weekly E. coli) source must never present a
    // days-old reading as freshly updated — updated: nowIso would suppress
    // the frontend's 2-hour stale-data warning.
    const html = lenaweePage(
      "No Advisory Posted", "No Advisory Posted", "7/1/26 8:40 AM"
    );
    const sites = parseLenaweeHtml(html, RECENT_NOW);
    expect(sites.length).toBe(2);
    for (const site of sites) {
      expect(site.updated).toBe("2026-07-01T08:40:00.000Z");
      expect(site.updated).not.toBe(RECENT_NOW);
    }
  });

  it("omits a beach with unrecognized status text instead of guessing a color", function() {
    const html = lenaweePage(
      "No Advisory Posted", "Advisory Posted", "7/1/26 8:40 AM"
    );
    const sites = parseLenaweeHtml(html, RECENT_NOW);
    expect(sites).not.toBe(null);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("hayes-state-park");
  });

  it("treats 'No Advisory Posted' with a trailing period as green (normalized)", function() {
    const html = lenaweePage(
      "No Advisory Posted.", "No Advisory Posted", "7/1/26 8:40 AM"
    );
    const sites = parseLenaweeHtml(html, RECENT_NOW);
    expect(sites).not.toBe(null);
    expect(sites.length).toBe(2);
    expect(sites.every(function(s) { return s.color === "green"; })).toBe(true);
  });

  it("does NOT green a status that merely embeds the phrase 'no advisory posted'", function() {
    // A dangerous status must never resolve to green just because the safe
    // phrase appears somewhere inside it. Exact-normalized match only.
    const html = lenaweePage(
      "Advisory posted; prior No Advisory Posted status void", "No Advisory Posted", "7/1/26 8:40 AM"
    );
    const sites = parseLenaweeHtml(html, RECENT_NOW);
    expect(sites).not.toBe(null);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("lake-hudson");
    expect(sites[0].color).toBe("green");
  });

  it("omits both beaches when the shared Last Updated is older than 10 days", function() {
    // Now is 2026-07-05; last updated 2026-06-20 is 15 days earlier.
    const html = lenaweePage(
      "No Advisory Posted", "No Advisory Posted", "6/20/26 8:40 AM"
    );
    const sites = parseLenaweeHtml(html, RECENT_NOW);
    expect(sites).toEqual([]);
  });

  it("keeps a beach exactly at 9 days old and omits one at 15 days old", function() {
    const nineDaysAgo = lenaweePage(
      "No Advisory Posted", "No Advisory Posted", "6/26/26 8:40 AM"
    );
    expect(parseLenaweeHtml(nineDaysAgo, RECENT_NOW).length).toBe(2);

    const fifteenDaysAgo = lenaweePage(
      "No Advisory Posted", "No Advisory Posted", "6/20/26 8:40 AM"
    );
    expect(parseLenaweeHtml(fifteenDaysAgo, RECENT_NOW)).toEqual([]);
  });

  it("ignores a stray 'Public Beach Water Testing Results' phrase appearing before the Beaches section", function() {
    // A nav/breadcrumb copy of the end-marker phrase earlier in the document
    // must not collapse the parsed region to empty (regression: the end-marker
    // search must start AFTER the Beaches header, not at index 0).
    const html = "<nav>Public Beach Water Testing Results</nav>" +
      lenaweePage("No Advisory Posted", "No Advisory Posted", "7/1/26 8:40 AM");
    const sites = parseLenaweeHtml(html, RECENT_NOW);
    expect(sites).not.toBe(null);
    expect(sites.length).toBe(2);
  });

  it("returns null when the page structure has changed (missing beach block)", function() {
    const html = "<html><body>" +
      "<h2 class=\"subhead1\">Beaches</h2>" +
      "<p>The beach monitoring table has been redesigned.</p>" +
      "<h2 class=\"subhead1\"><strong>Public Beach Water Testing Results</strong></h2>" +
      "</body></html>";
    expect(parseLenaweeHtml(html, RECENT_NOW)).toBe(null);
  });

  it("returns null when the Beaches section marker is entirely absent", function() {
    const html = "<html><body><p>Nothing relevant here.</p></body></html>";
    expect(parseLenaweeHtml(html, RECENT_NOW)).toBe(null);
  });

  it("returns null when the Last Updated timestamp cannot be parsed", function() {
    const html = "<html><body>" +
      "<h2 class=\"subhead1\">Beaches</h2>" +
      "<table><tbody><tr>" +
      "<td><h2 class=\"subhead1\"><strong>Hayes State Park</strong></h2></td>" +
      "<td><h2 class=\"subhead1\"><strong>Lake Hudson Recreation Area</strong></h2></td>" +
      "</tr><tr>" +
      "<td><div>Status: No Advisory Posted</div></td>" +
      "<td><div>Status: No Advisory Posted</div></td>" +
      "</tr></tbody></table>" +
      "<h2 class=\"subhead1\"><strong>Public Beach Water Testing Results</strong></h2>" +
      "</body></html>";
    expect(parseLenaweeHtml(html, RECENT_NOW)).toBe(null);
  });

  it("returns null for empty or null input", function() {
    expect(parseLenaweeHtml("", RECENT_NOW)).toBe(null);
    expect(parseLenaweeHtml(null, RECENT_NOW)).toBe(null);
  });
});

describe("lenawee.matches", function() {
  it("matches a beach named Hayes State Park by name", function() {
    const beach = makeBeach({
      name: "Hayes State Park Beach",
      lat: 40, lon: -80
    });
    expect(lenawee.matches(beach)).toBe(true);
  });

  it("matches a beach via park_name containing Lake Hudson", function() {
    const beach = makeBeach({
      name: "Swimming Beach", park_name: "Lake Hudson State Recreation Area",
      lat: 40, lon: -80
    });
    expect(lenawee.matches(beach)).toBe(true);
  });

  it("matches an unrelated-named beach within ~3 mi of Hayes State Park", function() {
    const beach = makeBeach({
      name: "Wamplers Lake Beach",
      lat: 42.07, lon: -84.14
    });
    expect(lenawee.matches(beach)).toBe(true);
  });

  it("does not match a beach far from both sites with an unrelated name", function() {
    const beach = makeBeach({
      name: "Holland State Park",
      lat: 42.7739, lon: -86.2109
    });
    expect(lenawee.matches(beach)).toBe(false);
  });
});
