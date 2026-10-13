// test/winnetkaTowerBeach.test.js
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseTowerBeachSites,
  parseTowerBeachStatus,
  parseTowerBeachUpdated,
  winnetkaTowerBeach,
  TOWER_BEACH_URL,
  TOWER_BEACH_SITE_ID
} from "../src/officialSources/winnetkaTowerBeach.js";
import { scrapeOfficialFlagFromResult } from "../src/officialSources/index.js";
import { updateScraperHealth } from "../src/scraperHealth.js";
import { installFetch } from "./helpers/fetch.js";
import { makeBeach } from "./helpers/beach.js";

const NOW_ISO = "2026-07-21T21:43:00.000Z";

// The live page as captured after the 2026 season closed: a Closed status
// with a seasonal reason and a stamped "Last updated" line.
const CLOSED_SEASON_FIXTURE = readFileSync(
  new URL("./fixtures/winnetka-tower-beach-closed-season-2026-10-13.html", import.meta.url),
  "utf8"
);
const CLOSED_SEASON_NOW_ISO = "2026-10-13T13:40:00.000Z";

// Trimmed but structurally faithful fixture mirroring the rainoutline.com
// response: the status2 span, the "&nbsp;-&nbsp;" separator, free-text reason,
// then the "Last updated" clue span on the next line.
function buildPage(statusHtml, lastUpdatedLine) {
  return "<div class=\"floatleft gridcell7 padding5\">" +
    statusHtml +
    "<br /><br />" +
    "<span class=\"clue\"><em>" + lastUpdatedLine + "</em></span>" +
    "</div>";
}

function closedHazard() {
  return buildPage(
    "<span class=\"status2\">Closed</span>&nbsp;-&nbsp;Tower beach is closed for " +
      "swimming as there is a Beach Hazard Statement in effect and rip currents " +
      "are present. Please stay out of the water.",
    "Last updated at 7/21/26 4:43 pm\n                             by Matt Barton"
  );
}

function openPage() {
  return buildPage(
    "<span class=\"status2\">Open</span>&nbsp;-&nbsp;Tower beach is open for swimming.",
    "Last updated at 7/21/26 9:00 am\n                             by Matt Barton"
  );
}

function closedWaterQuality() {
  return buildPage(
    "<span class=\"status2\">Closed</span>&nbsp;-&nbsp;Tower beach is closed due to " +
      "elevated E.coli bacteria levels per a water quality advisory.",
    "Last updated at 7/21/26 8:15 am\n                             by Matt Barton"
  );
}

function closedMaintenance() {
  return buildPage(
    "<span class=\"status2\">Closed</span>&nbsp;-&nbsp;Tower beach is closed for " +
      "scheduled maintenance.",
    "Last updated at 7/21/26 7:00 am\n                             by Matt Barton"
  );
}

describe("parseTowerBeachStatus", function () {
  it("maps a hazard closure (Beach Hazard Statement + rip currents) to red", function () {
    const site = parseTowerBeachStatus(closedHazard(), NOW_ISO);
    expect(site).not.toBe(null);
    expect(site.siteId).toBe(TOWER_BEACH_SITE_ID);
    expect(site.color).toBe("red");
    expect(site.reason.indexOf("Beach Hazard Statement")).not.toBe(-1);
    expect(site.names).toEqual(["tower road"]);
    expect(typeof site.lat).toBe("number");
    expect(typeof site.lon).toBe("number");
  });

  it("recognizes each individual hazard keyword", function () {
    const keywords = [
      "high waves are present",
      "high surf is expected",
      "dangerous surf conditions",
      "dangerous conditions in the water",
      "rip current risk is high"
    ];
    for (let i = 0; i < keywords.length; i++) {
      const page = buildPage(
        "<span class=\"status2\">Closed</span>&nbsp;-&nbsp;Beach closed because " +
          keywords[i] + ".",
        "Last updated at 7/21/26 4:43 pm"
      );
      const site = parseTowerBeachStatus(page, NOW_ISO);
      expect(site).not.toBe(null);
      expect(site.color).toBe("red");
    }
  });

  it("maps Open to green", function () {
    const site = parseTowerBeachStatus(openPage(), NOW_ISO);
    expect(site).not.toBe(null);
    expect(site.color).toBe("green");
    expect(site.siteId).toBe(TOWER_BEACH_SITE_ID);
  });

  it("returns null for a water-quality closure (belongs to the wqFloor path, not here)", function () {
    const site = parseTowerBeachStatus(closedWaterQuality(), NOW_ISO);
    expect(site).toBe(null);
  });

  it("returns null for each water-quality keyword variant", function () {
    const keywords = ["bacteria", "water quality", "e.coli", "advisory"];
    for (let i = 0; i < keywords.length; i++) {
      const page = buildPage(
        "<span class=\"status2\">Closed</span>&nbsp;-&nbsp;Beach closed due to " +
          keywords[i] + " concerns.",
        "Last updated at 7/21/26 4:43 pm"
      );
      expect(parseTowerBeachStatus(page, NOW_ISO)).toBe(null);
    }
  });

  it("returns null for a non-hazard closure (maintenance)", function () {
    expect(parseTowerBeachStatus(closedMaintenance(), NOW_ISO)).toBe(null);
  });

  it("returns null for an unrecognized closure reason", function () {
    const page = buildPage(
      "<span class=\"status2\">Closed</span>&nbsp;-&nbsp;Beach closed, reason " +
        "unspecified.",
      "Last updated at 7/21/26 4:43 pm"
    );
    expect(parseTowerBeachStatus(page, NOW_ISO)).toBe(null);
  });

  it("returns null for an unrecognized status word (markup/schema drift)", function () {
    const page = buildPage(
      "<span class=\"status2\">Unknown</span>&nbsp;-&nbsp;Something changed upstream.",
      "Last updated at 7/21/26 4:43 pm"
    );
    expect(parseTowerBeachStatus(page, NOW_ISO)).toBe(null);
  });

  it("returns null when the status2 span is missing entirely", function () {
    const page = "<div>completely different page structure</div>";
    expect(parseTowerBeachStatus(page, NOW_ISO)).toBe(null);
  });

  it("returns null for null and empty-string input", function () {
    expect(parseTowerBeachStatus(null, NOW_ISO)).toBe(null);
    expect(parseTowerBeachStatus("", NOW_ISO)).toBe(null);
  });

  it("returns null (does not throw) on garbage input", function () {
    expect(parseTowerBeachStatus("<<< not the expected format >>>", NOW_ISO)).toBe(null);
  });

  it("falls back to nowIso when the Last Updated line cannot be parsed", function () {
    const page = buildPage(
      "<span class=\"status2\">Open</span>&nbsp;-&nbsp;Tower beach is open for swimming.",
      "no timestamp here"
    );
    const site = parseTowerBeachStatus(page, NOW_ISO);
    expect(site).not.toBe(null);
    expect(site.updated).toBe(NOW_ISO);
  });

  it("parses a real Last Updated timestamp into a valid ISO string", function () {
    const site = parseTowerBeachStatus(closedHazard(), NOW_ISO);
    expect(site).not.toBe(null);
    expect(typeof site.updated).toBe("string");
    expect(isNaN(new Date(site.updated).getTime())).toBe(false);
  });
});

describe("parseTowerBeachSites", function () {
  it("reads the live closed-season page as a recognized page with nothing to report", function () {
    expect(parseTowerBeachSites(CLOSED_SEASON_FIXTURE, CLOSED_SEASON_NOW_ISO)).toEqual([]);
    expect(parseTowerBeachUpdated(CLOSED_SEASON_FIXTURE, CLOSED_SEASON_NOW_ISO))
      .toBe("2026-09-10T20:13:00.000Z");
  });

  it("yields one green site for Open, equal to parseTowerBeachStatus", function () {
    const sites = parseTowerBeachSites(openPage(), NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].color).toBe("green");
    expect(sites[0]).toEqual(parseTowerBeachStatus(openPage(), NOW_ISO));
  });

  it("yields one red site for a hazard closure", function () {
    const sites = parseTowerBeachSites(closedHazard(), NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].color).toBe("red");
    expect(sites[0].siteId).toBe(TOWER_BEACH_SITE_ID);
  });

  it("yields an empty list for a maintenance closure", function () {
    expect(parseTowerBeachSites(closedMaintenance(), NOW_ISO)).toEqual([]);
  });

  it("yields an empty list for a water-quality closure", function () {
    expect(parseTowerBeachSites(closedWaterQuality(), NOW_ISO)).toEqual([]);
  });

  it("yields an empty list for each water-quality keyword variant", function () {
    const keywords = ["bacteria", "water quality", "e.coli", "e. coli", "advisory"];
    for (let i = 0; i < keywords.length; i++) {
      const page = buildPage(
        "<span class=\"status2\">Closed</span>&nbsp;-&nbsp;Beach closed due to " +
          keywords[i] + " concerns.",
        "Last updated at 7/21/26 4:43 pm"
      );
      expect(parseTowerBeachSites(page, NOW_ISO)).toEqual([]);
    }
  });

  it("yields an empty list for a hazard phrased with the word advisory", function () {
    const page = buildPage(
      "<span class=\"status2\">Closed</span>&nbsp;-&nbsp;High Surf Advisory in effect.",
      "Last updated at 7/21/26 4:43 pm"
    );
    expect(parseTowerBeachSites(page, NOW_ISO)).toEqual([]);
  });

  it("yields an empty list for a Closed line with an empty reason", function () {
    const page = buildPage(
      "<span class=\"status2\">Closed</span>&nbsp;-&nbsp;",
      "Last updated at 7/21/26 4:43 pm"
    );
    expect(parseTowerBeachSites(page, NOW_ISO)).toEqual([]);
  });

  it("returns null for an unrecognized status word", function () {
    const page = buildPage(
      "<span class=\"status2\">Unknown</span>&nbsp;-&nbsp;Something changed upstream.",
      "Last updated at 7/21/26 4:43 pm"
    );
    expect(parseTowerBeachSites(page, NOW_ISO)).toBe(null);
  });

  it("returns null when the status2 span is missing", function () {
    expect(parseTowerBeachSites("<div>completely different page structure</div>", NOW_ISO))
      .toBe(null);
  });

  it("returns null for garbage, null and empty-string input", function () {
    expect(parseTowerBeachSites("<<< not the expected format >>>", NOW_ISO)).toBe(null);
    expect(parseTowerBeachSites(null, NOW_ISO)).toBe(null);
    expect(parseTowerBeachSites("", NOW_ISO)).toBe(null);
  });
});

describe("parseTowerBeachUpdated", function () {
  it("parses a well-formed Last Updated line to a valid ISO timestamp", function () {
    const iso = parseTowerBeachUpdated(
      "Last updated at 7/21/26 4:43 pm by Matt Barton",
      NOW_ISO
    );
    expect(iso).not.toBe(null);
    expect(isNaN(new Date(iso).getTime())).toBe(false);
  });

  it("returns null when no Last Updated text is present", function () {
    expect(parseTowerBeachUpdated("nothing to see here", NOW_ISO)).toBe(null);
  });

  it("returns null for null/invalid input", function () {
    expect(parseTowerBeachUpdated(null, NOW_ISO)).toBe(null);
    expect(parseTowerBeachUpdated("Last updated at 7/21/26 4:43 pm", null)).toBe(null);
    expect(parseTowerBeachUpdated("Last updated at 7/21/26 4:43 pm", "not-a-date")).toBe(null);
  });
});

describe("winnetkaTowerBeach.matches", function () {
  it("matches by name substring 'tower road'", function () {
    const beach = makeBeach({ name: "Tower Road Beach", lat: 0, lon: 0 });
    expect(winnetkaTowerBeach.matches(beach)).toBe(true);
  });

  it("matches by park_name substring 'tower road'", function () {
    const beach = makeBeach({ name: "Beach", park_name: "Tower Road Beach Park", lat: 0, lon: 0 });
    expect(winnetkaTowerBeach.matches(beach)).toBe(true);
  });

  it("matches by proximity within the Winnetka bbox even without the name", function () {
    const beach = makeBeach({ name: "Unnamed Beach", lat: 42.1156, lon: -87.7338 });
    expect(winnetkaTowerBeach.matches(beach)).toBe(true);
  });

  it("does not match a beach far outside Winnetka", function () {
    const beach = makeBeach({ name: "Some Other Beach", lat: 44.8, lon: -83.3 });
    expect(winnetkaTowerBeach.matches(beach)).toBe(false);
  });
});

// matches() falls through to a bbox covering the whole Winnetka lakefront, and
// the single site carries coordinates, so a neighboring park-district beach
// resolves to Tower Road Beach by proximity and is shown its posted flag. The
// card must name whose flag it is.
describe("winnetkaTowerBeach transferred readings", function () {
  const RESULT_SOURCE = TOWER_BEACH_URL;

  function towerResult() {
    const site = parseTowerBeachStatus(openPage(), NOW_ISO);
    return {
      perBeach: true, sites: [site], source: RESULT_SOURCE,
      sources: [RESULT_SOURCE], updated: NOW_ISO
    };
  }

  it("declares reportSiteName on the open site", function () {
    expect(parseTowerBeachStatus(openPage(), NOW_ISO).reportSiteName)
      .toBe("Tower Road Beach");
  });

  it("declares reportSiteName on the hazard-closure site", function () {
    expect(parseTowerBeachStatus(closedHazard(), NOW_ISO).reportSiteName)
      .toBe("Tower Road Beach");
  });

  it("labels a neighboring Winnetka beach with reportedFor", function () {
    // Elder Lane Beach is a Winnetka Park District beach ~0.6 mi south of the
    // Tower Road pole: inside the bbox, named by no site substring, so it
    // resolves by proximity and reads Tower Road's posted status.
    const beach = makeBeach({
      id: "osm-elder-lane", name: "Elder Lane Beach", park_name: null,
      lat: 42.1078, lon: -87.7397
    });
    expect(winnetkaTowerBeach.matches(beach)).toBe(true);
    const flag = scrapeOfficialFlagFromResult(beach, winnetkaTowerBeach, towerResult());
    expect(flag).not.toBe(null);
    expect(flag.color).toBe("green");
    expect(flag.reportedFor.name).toBe("Tower Road Beach");
    // Measured, not guessed: both the beach and the site carry coordinates.
    expect(flag.reportedFor.distanceMi).toBeCloseTo(0.62, 1);
  });

  it("does not label Tower Road Beach itself", function () {
    const beach = makeBeach({
      id: "osm-tower-road", name: "Tower Road Beach", park_name: null,
      lat: 42.115585, lon: -87.733837
    });
    const flag = scrapeOfficialFlagFromResult(beach, winnetkaTowerBeach, towerResult());
    expect(flag).not.toBe(null);
    expect("reportedFor" in flag).toBe(false);
  });
});

// The scraper stamps updated from the page's OWN human-posted "Last updated"
// line, which only advances when a park-district staffer posts a status change,
// so the frontend's 2 h default would cry wolf on an accurate posted status.
describe("winnetkaTowerBeach staleness contract", function () {
  it("declares a 72 h staleMs (covers a Friday post read Monday morning)", function () {
    expect(winnetkaTowerBeach.staleMs).toBe(72 * 60 * 60 * 1000);
    expect(winnetkaTowerBeach.staleMs).toBe(259200000);
    expect(Number.isFinite(winnetkaTowerBeach.staleMs)).toBe(true);
    expect(winnetkaTowerBeach.staleMs).toBeGreaterThan(0);
  });

  it("declares NO readingNote (a latched posted state, not a point-in-time reading)", function () {
    expect(winnetkaTowerBeach.readingNote).toBe(undefined);
  });
});

describe("winnetkaTowerBeach.scrape", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("returns a perBeach result with the red site for a hazard closure", async function () {
    installFetch(function (url) {
      expect(String(url)).toBe(TOWER_BEACH_URL);
      return Promise.resolve({
        ok: true,
        text: function () { return Promise.resolve(closedHazard()); }
      });
    });
    const result = await winnetkaTowerBeach.scrape(NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.perBeach).toBe(true);
    expect(result.sites.length).toBe(1);
    expect(result.sites[0].color).toBe("red");
  });

  it("returns null when the fetch fails (non-2xx)", async function () {
    installFetch(function () {
      return Promise.resolve({ ok: false, status: 500 });
    });
    const result = await winnetkaTowerBeach.scrape(NOW_ISO);
    expect(result).toBe(null);
  });

  it("returns null when fetch throws a network error", async function () {
    installFetch(function () {
      return Promise.reject(new Error("network down"));
    });
    const result = await winnetkaTowerBeach.scrape(NOW_ISO);
    expect(result).toBe(null);
  });

  function expectEmptyResult(result, nowIso) {
    expect(result).not.toBe(null);
    expect(result.perBeach).toBe(true);
    expect(result.sites).toEqual([]);
    expect(result.source).toBe(TOWER_BEACH_URL);
    expect(result.sources[0]).toBe(TOWER_BEACH_URL);
    expect(result.updated).toBe(nowIso);
  }

  it("returns an empty result for the live closed-season page", async function () {
    installFetch(function () {
      return Promise.resolve({
        ok: true,
        text: function () { return Promise.resolve(CLOSED_SEASON_FIXTURE); }
      });
    });
    const result = await winnetkaTowerBeach.scrape(CLOSED_SEASON_NOW_ISO);
    expectEmptyResult(result, CLOSED_SEASON_NOW_ISO);
  });

  it("returns an empty result for a non-hazard closure", async function () {
    installFetch(function () {
      return Promise.resolve({
        ok: true,
        text: function () { return Promise.resolve(closedMaintenance()); }
      });
    });
    const result = await winnetkaTowerBeach.scrape(NOW_ISO);
    expectEmptyResult(result, NOW_ISO);
  });

  it("returns an empty result for a water-quality closure, never masquerading as hazard", async function () {
    installFetch(function () {
      return Promise.resolve({
        ok: true,
        text: function () { return Promise.resolve(closedWaterQuality()); }
      });
    });
    const result = await winnetkaTowerBeach.scrape(NOW_ISO);
    expectEmptyResult(result, NOW_ISO);
  });

  it("returns null for an unrecognized status word (markup drift)", async function () {
    const page = buildPage(
      "<span class=\"status2\">Unknown</span>&nbsp;-&nbsp;Something changed upstream.",
      "Last updated at 7/21/26 4:43 pm"
    );
    installFetch(function () {
      return Promise.resolve({
        ok: true,
        text: function () { return Promise.resolve(page); }
      });
    });
    const result = await winnetkaTowerBeach.scrape(NOW_ISO);
    expect(result).toBe(null);
  });

  it("never throws even if text() rejects", async function () {
    installFetch(function () {
      return Promise.resolve({
        ok: true,
        text: function () { return Promise.reject(new Error("body read failed")); }
      });
    });
    await expect(winnetkaTowerBeach.scrape(NOW_ISO)).resolves.toBe(null);
  });
});

// An empty result is a success for the health tracker and writes no official
// for any matched beach.
describe("winnetkaTowerBeach empty-result health contract", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("resets the consecutive-null streak and resolves to no official", async function () {
    installFetch(function () {
      return Promise.resolve({
        ok: true,
        text: function () { return Promise.resolve(CLOSED_SEASON_FIXTURE); }
      });
    });
    const result = await winnetkaTowerBeach.scrape(CLOSED_SEASON_NOW_ISO);
    expect(result).not.toBe(null);
    const health = updateScraperHealth(
      "winnetka-tower-beach", { consecutiveNulls: 5 }, result !== null, CLOSED_SEASON_NOW_ISO
    );
    expect(health.next.consecutiveNulls).toBe(0);
    expect(health.next.lastSuccess).toBe(CLOSED_SEASON_NOW_ISO);
    expect(health.alert).toBe(null);

    const beach = makeBeach({ name: "Tower Road Beach", lat: 42.115585, lon: -87.733837 });
    expect(winnetkaTowerBeach.matches(beach)).toBe(true);
    expect(scrapeOfficialFlagFromResult(beach, winnetkaTowerBeach, result)).toBe(null);
  });
});
