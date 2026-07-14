// test/michiganCity.test.js
import { describe, it, expect } from "vitest";
import { parseMichiganCityHtml, michiganCity } from "../src/officialSources/michiganCity.js";
import { makeBeach } from "./helpers/beach.js";

// Trimmed inline fixture matching the live page's fusion-text-3 block
// (verified 2026-07-05). wpValue / stop7Value are injected as raw strings so
// tests can pass non-numeric placeholders ("N/A") to exercise the
// unparseable-reading path.
function buildFixtureHtml(dateSentence, wpValue, stop7Value) {
  return "<div class=\"fusion-text fusion-text-3\" style=\"--awb-content-alignment:center;\">" +
    "<p>Lake Michigan is tested for bacteria levels every day at Washington Park Beach, " +
    "Stop 1 at California Avenue, and Stop 7 at Beachwalk. Results are available the " +
    "following day by 11 am on our beach hotline (219) 873-1406 x: 2.</p>\n" +
    "<p>Acceptable levels of bacteria are 235 or below. An advisory will be issued for " +
    "levels of bacteria between 236 and 999. The beach will be closed to swimming with " +
    "counts of 1,000 or above.</p>\n" +
    "<p><strong>" + dateSentence + "</strong></p>\n" +
    "<p>For Washington Park Beach is " + wpValue + "<br />" +
    "For Stop 1 at California Avenue is 18.5<br />" +
    "For Stop 7 at Beachwalk is " + stop7Value + "</p>\n" +
    "<p>For additional information, please call the Park Office Monday through Friday " +
    "between 8:00 am and 4:30 pm at (219) 873-1506.</p>" +
    "</div>";
}

const FRESH_DATE_SENTENCE = "The bacteria levels reported for Thursday, July 2nd, 2026.";
const NOW_ISO = "2026-07-05T12:00:00.000Z";

describe("parseMichiganCityHtml", function() {
  it("parses both sites as green when at or below the 235 threshold", function() {
    const html = buildFixtureHtml(FRESH_DATE_SENTENCE, "6.3", "12.0");
    const result = parseMichiganCityHtml(html, NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.updated).toBe("2026-07-02T12:00:00.000Z");
    expect(result.sites.length).toBe(2);
    const wp = result.sites.find(function(s) { return s.siteId === "washington-park-beach"; });
    const stop7 = result.sites.find(function(s) { return s.siteId === "stop-7-beachwalk"; });
    expect(wp.color).toBe("green");
    expect(wp.reason.indexOf("6.3") !== -1).toBe(true);
    expect(wp.reason.indexOf("Thursday, July 2nd, 2026") !== -1).toBe(true);
    expect(wp.names).toContain("washington park beach");
    expect(wp.lat).toBeCloseTo(41.7281476, 4);
    expect(wp.lon).toBeCloseTo(-86.9040495, 4);
    expect(stop7.color).toBe("green");
    expect(stop7.names).toContain("beachwalk");
  });

  it("maps a value in the advisory band (236-999) to yellow", function() {
    const html = buildFixtureHtml(FRESH_DATE_SENTENCE, "450.0", "12.0");
    const result = parseMichiganCityHtml(html, NOW_ISO);
    const wp = result.sites.find(function(s) { return s.siteId === "washington-park-beach"; });
    expect(wp.color).toBe("yellow");
  });

  it("maps a value at or above the 1000 closure threshold to red", function() {
    const html = buildFixtureHtml(FRESH_DATE_SENTENCE, "1500.0", "12.0");
    const result = parseMichiganCityHtml(html, NOW_ISO);
    const wp = result.sites.find(function(s) { return s.siteId === "washington-park-beach"; });
    expect(wp.color).toBe("red");
  });

  it("maps the exact boundary values 235/236/999/1000 correctly", function() {
    const boundaries = [
      { value: "235", expected: "green" },
      { value: "236", expected: "yellow" },
      { value: "999", expected: "yellow" },
      { value: "1000", expected: "red" }
    ];
    for (const boundary of boundaries) {
      const html = buildFixtureHtml(FRESH_DATE_SENTENCE, boundary.value, "12.0");
      const result = parseMichiganCityHtml(html, NOW_ISO);
      const wp = result.sites.find(function(s) { return s.siteId === "washington-park-beach"; });
      expect(wp.color).toBe(boundary.expected);
    }
  });

  it("maps a comma-formatted closure-level count to red (never a wrong green)", function() {
    // Closure-level counts are exactly where the site would format with a
    // thousands separator (its own prose writes "1,000"). A naive capture
    // stopping at the comma would read "2,420" as 2 and bucket to green --
    // the worst possible bug. Assert the full number survives -> red.
    const html = buildFixtureHtml(FRESH_DATE_SENTENCE, "2,420", "1,050.0");
    const result = parseMichiganCityHtml(html, NOW_ISO);
    expect(result).not.toBe(null);
    const wp = result.sites.find(function(s) { return s.siteId === "washington-park-beach"; });
    const stop7 = result.sites.find(function(s) { return s.siteId === "stop-7-beachwalk"; });
    expect(wp.color).toBe("red");
    expect(wp.reason.indexOf("2420") !== -1).toBe(true);
    expect(stop7.color).toBe("red");
  });

  it("maps the exact comma-formatted 1,000 boundary to red", function() {
    const html = buildFixtureHtml(FRESH_DATE_SENTENCE, "1,000", "12.0");
    const result = parseMichiganCityHtml(html, NOW_ISO);
    const wp = result.sites.find(function(s) { return s.siteId === "washington-park-beach"; });
    expect(wp.color).toBe("red");
  });

  it("degrades a malformed numeric token to null rather than a guessed color", function() {
    // ">2420" (a censored/greater-than count) and "2,4,2,0" (garbled) must
    // not resolve to a color; the site is omitted, never mis-bucketed.
    const html = buildFixtureHtml(FRESH_DATE_SENTENCE, ">2420", "12.0");
    const result = parseMichiganCityHtml(html, NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.sites.length).toBe(1);
    expect(result.sites[0].siteId).toBe("stop-7-beachwalk");
  });

  it("returns null when the reading date is more than 8 days stale", function() {
    const staleDateSentence = "The bacteria levels reported for Friday, June 19th, 2026.";
    const html = buildFixtureHtml(staleDateSentence, "6.3", "12.0");
    expect(parseMichiganCityHtml(html, NOW_ISO)).toBe(null);
  });

  it("still parses a weekend-lag reading within the 8-day tolerance", function() {
    // 3 days old relative to NOW_ISO -- well within tolerance, mirrors the
    // live weekday-only cadence lagging over a weekend.
    const html = buildFixtureHtml(FRESH_DATE_SENTENCE, "6.3", "12.0");
    const result = parseMichiganCityHtml(html, NOW_ISO);
    expect(result).not.toBe(null);
  });

  it("omits a site whose reading is an unparseable placeholder, keeping the other", function() {
    const html = buildFixtureHtml(FRESH_DATE_SENTENCE, "N/A", "12.0");
    const result = parseMichiganCityHtml(html, NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.sites.length).toBe(1);
    expect(result.sites[0].siteId).toBe("stop-7-beachwalk");
  });

  it("omits both sites and returns null when neither reading is parseable", function() {
    const html = buildFixtureHtml(FRESH_DATE_SENTENCE, "pending", "--");
    expect(parseMichiganCityHtml(html, NOW_ISO)).toBe(null);
  });

  it("returns null for garbage input with no recognizable date sentence", function() {
    const html = "<div class=\"fusion-text fusion-text-3\"><p>Nothing useful here.</p></div>";
    expect(parseMichiganCityHtml(html, NOW_ISO)).toBe(null);
  });

  it("returns null for empty or null input", function() {
    expect(parseMichiganCityHtml("", NOW_ISO)).toBe(null);
    expect(parseMichiganCityHtml(null, NOW_ISO)).toBe(null);
  });

  it("returns null when the date sentence drifts from the expected phrasing", function() {
    const html = buildFixtureHtml(
      "The bacteria levels reported for Thu, July 2, 2026.",
      "6.3", "12.0"
    );
    expect(parseMichiganCityHtml(html, NOW_ISO)).toBe(null);
  });
});

describe("michiganCity.matches", function() {
  it("matches a beach named Washington Park Beach", function() {
    const beach = makeBeach({
      name: "Washington Park Beach",
      lat: 41.7281, lon: -86.9040
    });
    expect(michiganCity.matches(beach)).toBe(true);
  });

  it("matches a beach named Stop 7 / Beachwalk by name even if far from the lakefront point", function() {
    const beach = makeBeach({
      name: "Stop 7 at Beachwalk",
      lat: 41.705, lon: -86.895
    });
    expect(michiganCity.matches(beach)).toBe(true);
  });

  it("matches an unrelated-name beach within ~2 mi of the lakefront point", function() {
    const beach = makeBeach({
      name: "Michigan City Public Beach",
      lat: 41.735, lon: -86.905
    });
    expect(michiganCity.matches(beach)).toBe(true);
  });

  it("does not match a distant, unrelated beach", function() {
    const beach = makeBeach({
      name: "Holland State Park",
      lat: 42.7739, lon: -86.2109
    });
    expect(michiganCity.matches(beach)).toBe(false);
  });

  it("does NOT match a same-named 'Washington Park Beach' elsewhere on the Great Lakes", function() {
    // "Washington Park" is one of the most common park names in the US; other
    // Great Lakes beaches carry it. An unbounded name match would hand Michigan
    // City's bacteria reading to this beach -- a wrong official color. The name
    // hit must be geographically bounded. Coordinates: Washington Park,
    // Kenosha WI (~90 mi north on Lake Michigan).
    const beach = makeBeach({
      name: "Washington Park Beach", park_name: "Washington Park",
      lat: 42.5806, lon: -87.8103
    });
    expect(michiganCity.matches(beach)).toBe(false);
  });

  it("does NOT match a distant beach named Beachwalk", function() {
    const beach = makeBeach({
      name: "Beachwalk Resort",
      lat: 43.0, lon: -87.9
    });
    expect(michiganCity.matches(beach)).toBe(false);
  });
});
