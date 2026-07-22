// test/nwsOmr.test.js
// Unit tests for the NWS Grand Rapids OMR "Lake Michigan Beach Reports" official
// scraper. Pure parsers (parseOmrBeachReport, normalizeOmrFlagColor,
// newestOmrProductId) are exercised against inline fixtures — no network. The
// scrape() network path is exercised with a stubbed global fetch. Project style:
// ES modules, NO template literals, string concat with +, function () {}
// callbacks.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  nwsOmr,
  parseOmrBeachReport,
  normalizeOmrFlagColor,
  newestOmrProductId,
  OMR_LIST_URL,
  OMR_URL,
  OMR_LABEL
} from "../src/officialSources/nwsOmr.js";
import { resolveSiteForBeach, scrapeOfficialFlagFromResult } from "../src/officialSources/index.js";
import { installFetch } from "./helpers/fetch.js";
import { makeBeach } from "./helpers/beach.js";

const NOW_ISO = "2026-07-21T18:00:00.000Z";
const ISSUANCE = "2026-07-21T14:56:00+00:00";

// The verbatim live product body (issued by KGRR), used as the canonical
// fixture. Each test may build a variant by swapping the table region.
function buildProduct(tableRows) {
  const header = [
    "000",
    "SXUS83 KGRR 211456",
    "OMRGRR",
    "",
    "Other Marine Reports",
    "National Weather Service Grand Rapids MI",
    "1056 AM EDT Tue Jul 21 2026",
    "",
    "Lake Michigan Beach Reports",
    "                               Water      Wave        Flag",
    "Location                       Temp       Height      Color "
  ];
  const trailer = [
    "",
    "Disclaimer",
    "These observations are reported during the morning hours and ",
    "may not be representative of conditions later in the day.",
    "",
    "Flag Definitions",
    "Green:  OK to swim",
    "Yellow: Caution is urged",
    "Red:    Hazardous to swim",
    "",
    "$$"
  ];
  return header.concat(tableRows).concat(trailer).join("\n");
}

const LIVE_ROWS = [
  "Ludington State Park           68 F       4 ft        Red",
  "Mears State Park (Pentwater)   66 F       3 ft        Yellow",
  "Muskegon State Park            68 F       4 ft        Red",
  "P.J. Hoffmaster State Park     73 F       5 ft        Red",
  "Grand Haven State Park         72 F       5 ft        Red",
  "Holland State Park             68 F       4 ft        Red",
  "Saugatuck Oval Beach           70 F       M ft        None"
];

function sitesById(sites) {
  const map = {};
  for (let i = 0; i < sites.length; i++) {
    map[sites[i].siteId] = sites[i];
  }
  return map;
}

describe("normalizeOmrFlagColor", function () {
  it("maps the three posted flag colors 1:1 (case-insensitive)", function () {
    expect(normalizeOmrFlagColor("Green")).toBe("green");
    expect(normalizeOmrFlagColor("YELLOW")).toBe("yellow");
    expect(normalizeOmrFlagColor("red")).toBe("red");
  });

  it("maps None and missing markers to null (no data, never a color)", function () {
    expect(normalizeOmrFlagColor("None")).toBe(null);
    expect(normalizeOmrFlagColor("M")).toBe(null);
  });

  it("never invents double-red (not a tier in this product)", function () {
    expect(normalizeOmrFlagColor("Double Red")).toBe(null);
  });

  it("returns null for non-string / unrecognized input", function () {
    expect(normalizeOmrFlagColor(null)).toBe(null);
    expect(normalizeOmrFlagColor("")).toBe(null);
    expect(normalizeOmrFlagColor("constructor")).toBe(null);
    expect(normalizeOmrFlagColor("purple")).toBe(null);
  });
});

describe("parseOmrBeachReport", function () {
  it("parses the live table into the posted colors, omitting None rows", function () {
    const sites = parseOmrBeachReport(buildProduct(LIVE_ROWS), NOW_ISO);
    expect(sites).not.toBe(null);
    const byId = sitesById(sites);

    expect(byId["ludington-state-park"].color).toBe("red");
    expect(byId["mears-state-park"].color).toBe("yellow");
    expect(byId["muskegon-state-park"].color).toBe("red");
    expect(byId["pj-hoffmaster-state-park"].color).toBe("red");
    expect(byId["grand-haven-state-park"].color).toBe("red");
    expect(byId["holland-state-park"].color).toBe("red");

    // Saugatuck reported "None" (M ft) -> omitted entirely, no green guess.
    expect(byId["saugatuck-oval-beach"]).toBe(undefined);
    expect(sites.length).toBe(6);
  });

  it("emits names[] and lat/lon on each site for resolution", function () {
    const sites = parseOmrBeachReport(buildProduct(LIVE_ROWS), NOW_ISO);
    const byId = sitesById(sites);
    expect(byId["holland-state-park"].names).toEqual(["holland state park"]);
    expect(typeof byId["holland-state-park"].lat).toBe("number");
    expect(typeof byId["holland-state-park"].lon).toBe("number");
    expect(byId["holland-state-park"].reason.indexOf(OMR_LABEL)).not.toBe(-1);
  });

  it("maps a Green posted flag to green", function () {
    const sites = parseOmrBeachReport(buildProduct([
      "Holland State Park             68 F       1 ft        Green"
    ]), NOW_ISO);
    expect(sitesById(sites)["holland-state-park"].color).toBe("green");
  });

  it("returns [] when every beach reports None (off-season, nothing to report)", function () {
    const rows = [
      "Ludington State Park           M F        M ft        None",
      "Holland State Park             M F        M ft        None"
    ];
    const sites = parseOmrBeachReport(buildProduct(rows), NOW_ISO);
    // The table parsed (rows recognized structurally) but no posted flags -> [].
    expect(sites).toEqual([]);
  });

  it("skips a row whose beach name is not curated, keeping the rest", function () {
    const rows = [
      "Some New Pier Beach            70 F       2 ft        Red",
      "Holland State Park             68 F       4 ft        Red"
    ];
    const sites = parseOmrBeachReport(buildProduct(rows), NOW_ISO);
    const byId = sitesById(sites);
    expect(byId["holland-state-park"].color).toBe("red");
    expect(sites.length).toBe(1);
  });

  it("returns null when the table header is missing (wrong / changed product)", function () {
    const text = [
      "000",
      "SXUS83 KGRR 211456",
      "OMRGRR",
      "",
      "Some Other Marine Product",
      "Ludington State Park           68 F       4 ft        Red",
      "$$"
    ].join("\n");
    expect(parseOmrBeachReport(text, NOW_ISO)).toBe(null);
  });

  it("returns null when the header is present but no data row parses (format change)", function () {
    const text = [
      "Lake Michigan Beach Reports",
      "Beach                          Status",
      "Ludington State Park           closed until further notice",
      "$$"
    ].join("\n");
    expect(parseOmrBeachReport(text, NOW_ISO)).toBe(null);
  });

  it("never reads prose in the Disclaimer/Safety sections as a data row", function () {
    // A Safety line mentions "waves" and numbers; the table region stops at the
    // trailer so nothing past Disclaimer is scanned.
    const sites = parseOmrBeachReport(buildProduct(LIVE_ROWS), NOW_ISO);
    const ids = sites.map(function (s) { return s.siteId; });
    expect(ids.indexOf("disclaimer")).toBe(-1);
    expect(sites.length).toBe(6);
  });

  it("returns null for null / empty input", function () {
    expect(parseOmrBeachReport(null, NOW_ISO)).toBe(null);
    expect(parseOmrBeachReport("", NOW_ISO)).toBe(null);
  });

  it("does not throw on garbage input", function () {
    expect(parseOmrBeachReport("<<< not a product >>>", NOW_ISO)).toBe(null);
  });
});

describe("newestOmrProductId", function () {
  it("picks the id with the greatest issuanceTime", function () {
    const json = {
      "@graph": [
        { id: "older", issuanceTime: "2026-07-20T14:56:00+00:00" },
        { id: "newest", issuanceTime: "2026-07-21T14:56:00+00:00" },
        { id: "middle", issuanceTime: "2026-07-21T08:00:00+00:00" }
      ]
    };
    expect(newestOmrProductId(json)).toBe("newest");
  });

  it("falls back to the first item with an id when issuanceTime is absent", function () {
    const json = { "@graph": [{ id: "first" }, { id: "second" }] };
    expect(newestOmrProductId(json)).toBe("first");
  });

  it("returns null for a missing / empty / malformed @graph", function () {
    expect(newestOmrProductId(null)).toBe(null);
    expect(newestOmrProductId({})).toBe(null);
    expect(newestOmrProductId({ "@graph": [] })).toBe(null);
    expect(newestOmrProductId({ "@graph": [{ issuanceTime: "2026-07-21T00:00:00Z" }] })).toBe(null);
  });
});

describe("nwsOmr.matches", function () {
  it("matches by curated park name (park_name + name)", function () {
    expect(nwsOmr.matches(makeBeach({
      name: "Beach", park_name: "Holland State Park", lat: 0, lon: 0
    }))).toBe(true);
  });

  it("matches Oval Beach by name", function () {
    expect(nwsOmr.matches(makeBeach({
      name: "Oval Beach", lat: 0, lon: 0
    }))).toBe(true);
  });

  it("matches by proximity to a site even with an unrelated name", function () {
    expect(nwsOmr.matches(makeBeach({
      name: "Swimming Area", lat: 42.7739, lon: -86.2090
    }))).toBe(true);
  });

  it("does not match a far-away namesake beach", function () {
    // A different "Grand Haven" spot far from Lake Michigan must not match: the
    // curated substring is the full park name and the coords are far away.
    expect(nwsOmr.matches(makeBeach({
      name: "Grand Haven Inn Pool", lat: 44.9, lon: -83.4
    }))).toBe(false);
  });

  it("does not match an unrelated far-away beach", function () {
    expect(nwsOmr.matches(makeBeach({
      name: "Chicago North Avenue Beach", lat: 41.91, lon: -87.62
    }))).toBe(false);
  });
});

describe("nwsOmr end-to-end resolution", function () {
  it("resolves a Holland beach to the posted red via scrapeOfficialFlagFromResult", function () {
    const sites = parseOmrBeachReport(buildProduct(LIVE_ROWS), NOW_ISO);
    const result = {
      perBeach: true, sites: sites, source: OMR_URL, sources: [OMR_URL], updated: ISSUANCE
    };
    const beach = makeBeach({
      id: "osm-holland", name: "Holland State Park Beach",
      park_name: "Holland State Park", lat: 42.7739, lon: -86.2090
    });
    const flag = scrapeOfficialFlagFromResult(beach, nwsOmr, result);
    expect(flag).not.toBe(null);
    expect(flag.color).toBe("red");
    expect(flag.official).toBe(true);
    expect(flag.scraperId).toBe("nws-omr-grr");
    expect(flag.updated).toBe(ISSUANCE);
  });

  it("a beach ~1.7 mi from a centroid (no name match) both matches AND resolves to that site", function () {
    // Regression: matchesOmr claims within OMR_MATCH_RADIUS_MI (2 mi), so the
    // resolve radius must also be 2 mi. A beach 1.5-2.0 mi from a centroid with
    // no name substring was previously CLAIMED yet resolved to null (silent
    // coverage gap) because resolveSiteForBeach fell back to the 1.5 mi default.
    const sites = parseOmrBeachReport(buildProduct(LIVE_ROWS), NOW_ISO);
    // 1.700 mi due north of the Holland State Park centroid (42.7739, -86.2090).
    const beach = makeBeach({
      name: "Public Access Point", park_name: "", lat: 42.7985, lon: -86.2090
    });
    // No name substring maps to a site, so this is purely the proximity claim.
    expect(nwsOmr.matches(beach)).toBe(true);
    const site = resolveSiteForBeach(beach, sites);
    expect(site).not.toBe(null);
    expect(site.siteId).toBe("holland-state-park");
  });

  it("gives a None-reporting beach (Saugatuck) no official flag", function () {
    const sites = parseOmrBeachReport(buildProduct(LIVE_ROWS), NOW_ISO);
    const result = {
      perBeach: true, sites: sites, source: OMR_URL, sources: [OMR_URL], updated: ISSUANCE
    };
    const beach = makeBeach({
      name: "Oval Beach", park_name: "Saugatuck Oval Beach", lat: 42.6640, lon: -86.2170
    });
    expect(resolveSiteForBeach(beach, sites)).toBe(null);
    expect(scrapeOfficialFlagFromResult(beach, nwsOmr, result)).toBe(null);
  });
});

describe("nwsOmr.scrape", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  const LIST_JSON = {
    "@graph": [
      { id: "newest-id", issuanceTime: ISSUANCE },
      { id: "older-id", issuanceTime: "2026-07-20T14:56:00+00:00" }
    ]
  };

  // A JSON Response stand-in.
  function jsonResponse(data) {
    return { ok: true, json: function () { return Promise.resolve(data); } };
  }

  it("fetches list then product and returns a perBeachResult with issuanceTime", async function () {
    const calls = installFetch(function (url) {
      if (String(url) === OMR_LIST_URL) {
        return Promise.resolve(jsonResponse(LIST_JSON));
      }
      if (String(url).indexOf("/products/newest-id") !== -1) {
        return Promise.resolve(jsonResponse({
          productText: buildProduct(LIVE_ROWS),
          issuanceTime: ISSUANCE
        }));
      }
      return Promise.reject(new Error("unexpected url " + url));
    });
    const result = await nwsOmr.scrape(NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.perBeach).toBe(true);
    expect(result.source).toBe(OMR_URL);
    expect(result.updated).toBe(ISSUANCE);
    expect(result.sites.length).toBe(6);
    // Newest id was chosen for the second fetch.
    expect(calls.length).toBe(2);
    expect(String(calls[1].url).indexOf("newest-id")).not.toBe(-1);
    // NWS User-Agent sent on both legs.
    expect(calls[0].init.headers["User-Agent"].indexOf("swim.report")).not.toBe(-1);
  });

  it("returns null when the product list fetch fails", async function () {
    installFetch(function () {
      return Promise.resolve({ ok: false, status: 503, json: function () { return Promise.resolve({}); } });
    });
    expect(await nwsOmr.scrape(NOW_ISO)).toBe(null);
  });

  it("returns null when the product text is missing", async function () {
    installFetch(function (url) {
      if (String(url) === OMR_LIST_URL) {
        return Promise.resolve(jsonResponse(LIST_JSON));
      }
      return Promise.resolve(jsonResponse({ issuanceTime: ISSUANCE }));
    });
    expect(await nwsOmr.scrape(NOW_ISO)).toBe(null);
  });

  it("returns null on a network error", async function () {
    installFetch(function () {
      return Promise.reject(new Error("connect timeout"));
    });
    expect(await nwsOmr.scrape(NOW_ISO)).toBe(null);
  });

  it("returns an empty perBeachResult (not null) when every beach reports None", async function () {
    installFetch(function (url) {
      if (String(url) === OMR_LIST_URL) {
        return Promise.resolve(jsonResponse(LIST_JSON));
      }
      return Promise.resolve(jsonResponse({
        productText: buildProduct([
          "Ludington State Park           M F        M ft        None",
          "Holland State Park             M F        M ft        None"
        ]),
        issuanceTime: ISSUANCE
      }));
    });
    const result = await nwsOmr.scrape(NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.perBeach).toBe(true);
    expect(result.sites).toEqual([]);
  });
});
