// test/winnetkaTowerBeach.test.js
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  parseTowerBeachStatus,
  parseTowerBeachUpdated,
  winnetkaTowerBeach,
  TOWER_BEACH_URL,
  TOWER_BEACH_SITE_ID
} from "../src/officialSources/winnetkaTowerBeach.js";
import { installFetch } from "./helpers/fetch.js";
import { makeBeach } from "./helpers/beach.js";

const NOW_ISO = "2026-07-21T21:43:00.000Z";

// Trimmed but structurally faithful fixture mirroring the real
// rainoutline.com response (confirmed live 2026-07-22): the status2 span,
// the "&nbsp;-&nbsp;" separator, free-text reason, then the "Last updated"
// clue span on the next line.
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

  it("returns null (collapses empty) for a non-hazard closure", async function () {
    installFetch(function () {
      return Promise.resolve({
        ok: true,
        text: function () { return Promise.resolve(closedMaintenance()); }
      });
    });
    const result = await winnetkaTowerBeach.scrape(NOW_ISO);
    expect(result).toBe(null);
  });

  it("returns null for a water-quality closure, never masquerading as hazard", async function () {
    installFetch(function () {
      return Promise.resolve({
        ok: true,
        text: function () { return Promise.resolve(closedWaterQuality()); }
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
