// test/chautauquaCountyNy.test.js
// Unit tests for the Chautauqua County (NY) Health Department raise-only
// water-quality FLOOR source (src/wqFloor/chautauquaCountyNy.js). Pure parse
// functions are exercised against INLINE synthetic HTML fixtures — no
// network. Project style: ES modules, NO template literals, string concat
// with +, function () {} callbacks.
import { describe, it, expect, vi } from "vitest";
import {
  parseChautauquaBeachStatus,
  classifyStatusSnippet,
  htmlToPlainText,
  chautauquaCountyNy,
  CHAUTAUQUA_BEACH_STATUS_URL,
  CHAUTAUQUA_LABEL
} from "../src/wqFloor/chautauquaCountyNy.js";
import { makeBeach } from "./helpers/beach.js";
import { installFetch } from "./helpers/fetch.js";
import { scrapeFloorFromResult } from "../src/wqFloor/index.js";

const NOW_ISO = "2026-07-22T12:00:00.000Z";

// Builds a minimal HTML fixture from an array of beach status "rows" (already
// formatted HTML fragments), mirroring a server-rendered status table/listing.
function buildPage(rows) {
  const header = "<html><body><h1>Beach Monitoring</h1><table>";
  const footer = "</table></body></html>";
  return header + rows.join("") + footer;
}

function row(name, statusHtml) {
  return "<tr><td>" + name + "</td><td>" + statusHtml + "</td></tr>";
}

describe("htmlToPlainText", function() {
  it("strips tags and common entities and collapses whitespace", function() {
    expect(htmlToPlainText("<p>Point   Gratiot &mdash; Closed.</p>")).toBe("Point Gratiot - Closed.");
  });

  it("strips script/style blocks entirely", function() {
    const html = "<style>.x{color:red}</style><p>Wright Park</p><script>var x=1;</script>";
    expect(htmlToPlainText(html)).toBe("Wright Park");
  });

  it("returns empty string for non-string input", function() {
    expect(htmlToPlainText(null)).toBe("");
    expect(htmlToPlainText(undefined)).toBe("");
    expect(htmlToPlainText(42)).toBe("");
  });
});

describe("classifyStatusSnippet", function() {
  it("classifies a harmful algal bloom reading as hab", function() {
    expect(classifyStatusSnippet("closed due to harmful algal bloom")).toBe("hab");
    expect(classifyStatusSnippet("blue-green algae present, beach closed")).toBe("hab");
  });

  it("prefers hab over a plain closure keyword when both are present", function() {
    expect(classifyStatusSnippet("closed - cyanobacteria bloom detected")).toBe("hab");
  });

  it("classifies a generic closure/advisory as closure-advisory", function() {
    expect(classifyStatusSnippet("closed due to elevated bacteria levels")).toBe("closure-advisory");
    expect(classifyStatusSnippet("swim advisory in effect")).toBe("closure-advisory");
    expect(classifyStatusSnippet("use caution, unsafe conditions reported")).toBe("closure-advisory");
  });

  it("classifies an explicit clear reading as clear", function() {
    expect(classifyStatusSnippet("satisfactory")).toBe("clear");
    expect(classifyStatusSnippet("open, no advisory")).toBe("clear");
  });

  it("classifies unrecognized text as none", function() {
    expect(classifyStatusSnippet("last sampled 7/20/2026")).toBe("none");
  });

  it("returns none for empty/non-string input", function() {
    expect(classifyStatusSnippet("")).toBe("none");
    expect(classifyStatusSnippet(null)).toBe("none");
  });
});

describe("parseChautauquaBeachStatus", function() {
  it("returns null for null/empty input", function() {
    expect(parseChautauquaBeachStatus(null, NOW_ISO)).toBe(null);
    expect(parseChautauquaBeachStatus("", NOW_ISO)).toBe(null);
  });

  it("returns null when no curated beach name appears anywhere in the page", function() {
    const html = buildPage([row("Some Other Beach", "Open")]);
    expect(parseChautauquaBeachStatus(html, NOW_ISO)).toBe(null);
  });

  it("returns [] when every curated beach reads clear (all-clear, health success)", function() {
    const html = buildPage([
      row("Point Gratiot", "Satisfactory"),
      row("Wright Park", "Open"),
      row("Irving", "Satisfactory"),
      row("Sunset Bay", "Open, no advisory")
    ]);
    expect(parseChautauquaBeachStatus(html, NOW_ISO)).toEqual([]);
  });

  it("produces a yellow site for a generic closure/advisory", function() {
    const html = buildPage([
      row("Point Gratiot", "Satisfactory"),
      row("Wright Park", "Closed - elevated bacteria levels"),
      row("Irving", "Satisfactory"),
      row("Sunset Bay", "Satisfactory")
    ]);
    const sites = parseChautauquaBeachStatus(html, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0]).toEqual({
      siteId: "wright-park",
      floorColor: "yellow",
      names: ["wright park"],
      lat: 42.4848,
      lon: -79.3311,
      reason: "Chautauqua County Health Dept: beach closure/advisory in effect",
      updated: NOW_ISO
    });
  });

  it("produces a red site for a harmful algal bloom closure", function() {
    const html = buildPage([
      row("Irving", "Closed due to harmful algal bloom"),
      row("Sunset Bay", "Satisfactory")
    ]);
    const sites = parseChautauquaBeachStatus(html, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("irving");
    expect(sites[0].floorColor).toBe("red");
    expect(sites[0].reason).toBe("Chautauqua County Health Dept: harmful algal bloom advisory");
  });

  it("handles multiple simultaneous advisories, each mapped independently", function() {
    const html = buildPage([
      row("Point Gratiot", "Closed - high bacteria"),
      row("Wright Park", "Satisfactory"),
      row("Irving", "Closed due to harmful algal bloom"),
      row("Sunset Bay", "Satisfactory")
    ]);
    const sites = parseChautauquaBeachStatus(html, NOW_ISO);
    expect(sites.length).toBe(2);
    const bySiteId = {};
    sites.forEach(function(s) { bySiteId[s.siteId] = s; });
    expect(bySiteId["point-gratiot"].floorColor).toBe("yellow");
    expect(bySiteId["irving"].floorColor).toBe("red");
  });

  it("never emits green/double-red/unknown — a clear reading omits the site entirely", function() {
    const html = buildPage([row("Point Gratiot", "Satisfactory")]);
    const sites = parseChautauquaBeachStatus(html, NOW_ISO);
    expect(sites).toEqual([]);
  });

  it("does not let one beach's status leak onto an unrelated beach far down the page", function() {
    // Wright Park's status window should not reach all the way to Sunset Bay's.
    const filler = "x".repeat(500);
    const html = buildPage([
      row("Wright Park", "Satisfactory " + filler),
      row("Sunset Bay", "Closed due to harmful algal bloom")
    ]);
    const sites = parseChautauquaBeachStatus(html, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("sunset-bay");
  });
});

describe("chautauquaCountyNy.matches", function() {
  it("matches beaches by curated name substring", function() {
    expect(chautauquaCountyNy.matches(makeBeach({ name: "Point Gratiot" }))).toBe(true);
    expect(chautauquaCountyNy.matches(makeBeach({ name: "Wright Park Beach" }))).toBe(true);
    expect(chautauquaCountyNy.matches(makeBeach({ park_name: "Sunset Bay", name: "Beach" }))).toBe(true);
  });

  it("does not match an unrelated beach", function() {
    expect(chautauquaCountyNy.matches(makeBeach({ name: "North Avenue Beach" }))).toBe(false);
  });
});

describe("chautauquaCountyNy end-to-end with the wqFloor resolver", function() {
  it("resolves a matched beach's advisory to the shape estimateFlag consumes", function() {
    const beach = makeBeach({ name: "Point Gratiot", lat: 42.4945, lon: -79.3348 });
    const html = buildPage([row("Point Gratiot", "Closed - elevated bacteria levels")]);
    const sites = parseChautauquaBeachStatus(html, NOW_ISO);
    const result = {
      perBeach: true,
      sites: sites,
      source: CHAUTAUQUA_LABEL,
      updated: NOW_ISO
    };
    const advisory = scrapeFloorFromResult(beach, chautauquaCountyNy, result);
    expect(advisory).toEqual({
      beachId: "osm-test",
      color: "yellow",
      reason: "Chautauqua County Health Dept: beach closure/advisory in effect",
      source: CHAUTAUQUA_LABEL,
      updated: NOW_ISO
    });
  });

  it("an all-clear parse resolves to no advisory for any beach", function() {
    const beach = makeBeach({ name: "Sunset Bay" });
    const html = buildPage([row("Sunset Bay", "Satisfactory")]);
    const sites = parseChautauquaBeachStatus(html, NOW_ISO);
    const result = { perBeach: true, sites: sites, source: CHAUTAUQUA_LABEL, updated: NOW_ISO };
    expect(scrapeFloorFromResult(beach, chautauquaCountyNy, result)).toBe(null);
  });
});

describe("chautauquaCountyNy.scrape", function() {
  it("ships with an empty (unconfirmed) status URL — fail-closed inert", function() {
    expect(CHAUTAUQUA_BEACH_STATUS_URL).toBe("");
  });

  it("returns null WITHOUT fetching while the status URL is unconfirmed", async function() {
    const calls = installFetch(function() {
      return Promise.reject(new Error("network must not be reached"));
    });
    try {
      const result = await chautauquaCountyNy.scrape(NOW_ISO);
      expect(result).toBe(null);
      // Fail-closed: no upstream request is made at all.
      expect(calls.length).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is an async function that never throws when fetch is unavailable", async function() {
    // No global.fetch stub installed — fetchText's own try/catch must degrade
    // this to null rather than throw across the module boundary.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = undefined;
    try {
      const result = await chautauquaCountyNy.scrape(NOW_ISO);
      expect(result).toBe(null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
