// test/paDcnrPresqueIsle.test.js
// Unit tests for the PA DCNR Presque Isle official HAZARD scraper. Pure parse
// functions are exercised against INLINE synthetic fixtures (the live payload
// is 100% off-axis boilerplate, so hazard mapping is only provable
// synthetically). Project style: ES modules, NO template literals, string
// concat with +, function () {} callbacks.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  parsePresqueIsleAdvisories,
  classifyAdvisoryMessage,
  htmlToText,
  paDcnrPresqueIsle,
  PRESQUE_ISLE_URL
} from "../src/officialSources/paDcnrPresqueIsle.js";
import { installFetch } from "./helpers/fetch.js";
import { makeBeach } from "./helpers/beach.js";
import { resolveSiteForBeach, scrapeOfficialFlagFromResult } from "../src/officialSources/index.js";

// Build the API's array-of-{IsAlert,Message} JSON body from advisory tuples.
function advisoryBody(advisories) {
  return JSON.stringify(advisories.map(function(a) {
    return { IsAlert: a.isAlert, Message: a.message };
  }));
}

// The real live shape: all off-axis boilerplate, every IsAlert:false.
const LIVE_BOILERPLATE_BODY = advisoryBody([
  { isAlert: false, message: "<p>The Spotted Lanternfly is an invasive insect that poses a serious threat.</p>" },
  { isAlert: false, message: "<p>A quarantine order for untreated firewood is in effect. Burn locally sourced wood.</p>" },
  { isAlert: false, message: "<p>Drones are only permitted on designated flying fields.</p>" }
]);

describe("htmlToText", function() {
  it("strips tags and common entities and collapses whitespace", function() {
    expect(htmlToText("<p>Beach   closed &amp; roped off.</p>")).toBe("Beach closed & roped off.");
  });

  it("returns empty string for non-string input", function() {
    expect(htmlToText(null)).toBe("");
    expect(htmlToText(undefined)).toBe("");
    expect(htmlToText(42)).toBe("");
  });
});

describe("classifyAdvisoryMessage", function() {
  it("classifies a swimming-hazard closure as hazard", function() {
    expect(classifyAdvisoryMessage("<p>The beach is closed due to dangerous conditions.</p>")).toBe("hazard");
    expect(classifyAdvisoryMessage("Swimming prohibited until further notice.")).toBe("hazard");
    expect(classifyAdvisoryMessage("High surf and rip current advisory in effect.")).toBe("hazard");
  });

  it("classifies a bacteria/E. coli/algae closure as water-quality (NOT hazard)", function() {
    expect(classifyAdvisoryMessage("Beach closed due to high E. coli bacteria levels.")).toBe("water-quality");
    expect(classifyAdvisoryMessage("Swimming prohibited: harmful algal bloom detected.")).toBe("water-quality");
    expect(classifyAdvisoryMessage("Water quality advisory in effect.")).toBe("water-quality");
  });

  it("classifies off-axis boilerplate as none", function() {
    expect(classifyAdvisoryMessage("<p>The Spotted Lanternfly is an invasive insect.</p>")).toBe("none");
    expect(classifyAdvisoryMessage("Firewood quarantine order in effect.")).toBe("none");
    expect(classifyAdvisoryMessage("")).toBe("none");
    expect(classifyAdvisoryMessage(null)).toBe("none");
  });
});

describe("parsePresqueIsleAdvisories", function() {
  it("emits a single park-wide red site for an active swimming-hazard closure", function() {
    const body = advisoryBody([
      { isAlert: true, message: "<p>All Presque Isle beaches are closed to swimming due to dangerous conditions and high water.</p>" }
    ]);
    const sites = parsePresqueIsleAdvisories(body);
    expect(sites).not.toBe(null);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("presque-isle-state-park");
    expect(sites[0].color).toBe("red");
    expect(sites[0].names).toEqual(["presque isle"]);
    expect(sites[0].reason.indexOf("PA DCNR park advisory")).toBe(0);
    expect(sites[0].reason.indexOf("closed to swimming")).not.toBe(-1);
  });

  it("returns [] (clean success) for the live all-boilerplate payload", function() {
    expect(parsePresqueIsleAdvisories(LIVE_BOILERPLATE_BODY)).toEqual([]);
  });

  it("IGNORES a hazard message that is not an active alert (IsAlert:false)", function() {
    const body = advisoryBody([
      { isAlert: false, message: "<p>Swimming prohibited when lifeguards are off duty.</p>" }
    ]);
    expect(parsePresqueIsleAdvisories(body)).toEqual([]);
  });

  it("routes a bacteria/E. coli Danger advisory to no-data (wqFloor axis), NEVER red", function() {
    const body = advisoryBody([
      { isAlert: true, message: "<p>Beach closed: elevated E. coli bacteria levels detected in the water.</p>" }
    ]);
    // Even though the text says "beach closed", the water-quality gate wins:
    // this is the raise-only floor axis, never a hazard override red.
    expect(parsePresqueIsleAdvisories(body)).toEqual([]);
  });

  it("ignores off-axis Danger advisories (road / facility / event)", function() {
    const body = advisoryBody([
      { isAlert: true, message: "<p>The main park road is closed for repaving. Expect delays.</p>" },
      { isAlert: true, message: "<p>Fireworks event this Saturday; parking lots fill early.</p>" }
    ]);
    expect(parsePresqueIsleAdvisories(body)).toEqual([]);
  });

  it("a real hazard closure wins even when off-axis and water-quality advisories are also present", function() {
    const body = advisoryBody([
      { isAlert: false, message: "<p>Spotted Lanternfly advisory.</p>" },
      { isAlert: true, message: "<p>Trail closed for maintenance.</p>" },
      { isAlert: true, message: "<p>Water quality advisory: elevated bacteria.</p>" },
      { isAlert: true, message: "<p>Swimming is prohibited due to hazardous conditions.</p>" }
    ]);
    const sites = parsePresqueIsleAdvisories(body);
    expect(sites.length).toBe(1);
    expect(sites[0].color).toBe("red");
    expect(sites[0].reason.indexOf("hazardous conditions")).not.toBe(-1);
  });

  it("never emits green (or any color other than red)", function() {
    // No affirmative all-clear color can ever be produced by this source.
    const sites = parsePresqueIsleAdvisories(LIVE_BOILERPLATE_BODY);
    for (let i = 0; i < sites.length; i++) {
      expect(sites[i].color).toBe("red");
    }
  });

  it("returns null on unparseable JSON", function() {
    expect(parsePresqueIsleAdvisories("<<< not json >>>")).toBe(null);
    expect(parsePresqueIsleAdvisories("")).toBe(null);
  });

  it("returns null on a non-array payload (schema change)", function() {
    expect(parsePresqueIsleAdvisories(JSON.stringify({ IsAlert: true, Message: "x" }))).toBe(null);
    expect(parsePresqueIsleAdvisories(JSON.stringify(null))).toBe(null);
  });

  it("skips malformed records without throwing", function() {
    const body = JSON.stringify([
      null,
      { IsAlert: true },
      { IsAlert: true, Message: 123 },
      { IsAlert: true, Message: "<p>Beach closed due to dangerous surf.</p>" }
    ]);
    const sites = parsePresqueIsleAdvisories(body);
    expect(sites.length).toBe(1);
    expect(sites[0].color).toBe("red");
  });
});

describe("paDcnrPresqueIsle.matches", function() {
  it("matches a Presque Isle beach inside the peninsula bbox", function() {
    const beach = makeBeach({ name: "Beach 6", park_name: "Presque Isle State Park", lat: 42.16, lon: -80.11 });
    expect(paDcnrPresqueIsle.matches(beach)).toBe(true);
  });

  it("matches a coordinate-carrying beach in the bbox even without a Presque Isle name", function() {
    const beach = makeBeach({ name: "Barracks Beach", lat: 42.15, lon: -80.09 });
    expect(paDcnrPresqueIsle.matches(beach)).toBe(true);
  });

  it("does NOT match a far-away Presque Isle namesake that has coordinates", function() {
    // Presque Isle on Lake Huron, Michigan — same name, far from PA. A bare
    // name match would let PA's closure paint a false red here.
    const beach = makeBeach({ name: "Presque Isle Beach", lat: 45.29, lon: -83.49 });
    expect(paDcnrPresqueIsle.matches(beach)).toBe(false);
  });

  it("does not match an unrelated Great Lakes beach", function() {
    const beach = makeBeach({ name: "Holland State Park", lat: 42.7739, lon: -86.2109 });
    expect(paDcnrPresqueIsle.matches(beach)).toBe(false);
  });

  it("matches a coordinate-less row purely by name substring", function() {
    const beach = makeBeach({ name: "Presque Isle State Park Beach", lat: null, lon: null });
    expect(paDcnrPresqueIsle.matches(beach)).toBe(true);
  });
});

describe("paDcnrPresqueIsle site resolution (end-to-end)", function() {
  const CLOSED_BODY = advisoryBody([
    { isAlert: true, message: "<p>All beaches closed to swimming due to dangerous conditions.</p>" }
  ]);

  it("resolves a named Presque Isle beach to the red closure site", function() {
    const sites = parsePresqueIsleAdvisories(CLOSED_BODY);
    const beach = makeBeach({ name: "Beach 8", park_name: "Presque Isle State Park", lat: 42.17, lon: -80.10 });
    const site = resolveSiteForBeach(beach, sites);
    expect(site).toBeTruthy();
    expect(site.color).toBe("red");
  });

  it("resolves a bbox beach with no Presque Isle name by proximity", function() {
    const sites = parsePresqueIsleAdvisories(CLOSED_BODY);
    const beach = makeBeach({ name: "Barracks Beach", lat: 42.15, lon: -80.09 });
    const site = resolveSiteForBeach(beach, sites);
    expect(site).toBeTruthy();
    expect(site.color).toBe("red");
  });
});

describe("paDcnrPresqueIsle.scrape", function() {
  afterEach(function() {
    vi.unstubAllGlobals();
  });

  const NOW_ISO = "2026-07-22T15:00:00.000Z";

  function jsonTextResponse(body) {
    return {
      ok: true,
      text: function() {
        return Promise.resolve(body);
      }
    };
  }

  it("returns an empty perBeachResult (health success), NOT null, on the all-clear payload", async function() {
    const calls = installFetch(function() {
      return Promise.resolve(jsonTextResponse(LIVE_BOILERPLATE_BODY));
    });
    const result = await paDcnrPresqueIsle.scrape(NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.perBeach).toBe(true);
    expect(result.sites).toEqual([]);
    expect(result.source).toBe(PRESQUE_ISLE_URL);
    expect(result.updated).toBe(NOW_ISO);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(PRESQUE_ISLE_URL);
  });

  it("sends NO headers (host not probed for a User-Agent requirement)", async function() {
    const calls = installFetch(function() {
      return Promise.resolve(jsonTextResponse(LIVE_BOILERPLATE_BODY));
    });
    await paDcnrPresqueIsle.scrape(NOW_ISO);
    expect("headers" in calls[0].init).toBe(false);
  });

  it("returns a red site through the real scrape() path on an active hazard closure", async function() {
    const body = advisoryBody([
      { isAlert: true, message: "<p>Swimming prohibited due to high surf and rip current danger.</p>" }
    ]);
    installFetch(function() {
      return Promise.resolve(jsonTextResponse(body));
    });
    const result = await paDcnrPresqueIsle.scrape(NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.perBeach).toBe(true);
    expect(result.sites.length).toBe(1);
    expect(result.sites[0].color).toBe("red");

    // End-to-end: a matched Presque Isle beach gets a stamped official red.
    const beach = makeBeach({ name: "Beach 1", park_name: "Presque Isle State Park", lat: 42.14, lon: -80.08 });
    const flag = scrapeOfficialFlagFromResult(beach, paDcnrPresqueIsle, result);
    expect(flag).not.toBe(null);
    expect(flag.color).toBe("red");
    expect(flag.official).toBe(true);
    expect(flag.scraperId).toBe("pa-dcnr-presque-isle");
  });

  it("returns null on a non-2xx response", async function() {
    installFetch(function() {
      return Promise.resolve({ ok: false, status: 403, text: function() { return Promise.resolve("forbidden"); } });
    });
    expect(await paDcnrPresqueIsle.scrape(NOW_ISO)).toBe(null);
  });

  it("returns null on a network error", async function() {
    installFetch(function() {
      return Promise.reject(new Error("connect timeout"));
    });
    expect(await paDcnrPresqueIsle.scrape(NOW_ISO)).toBe(null);
  });

  it("returns null on a malformed (non-JSON) body", async function() {
    installFetch(function() {
      return Promise.resolve(jsonTextResponse("<html>error</html>"));
    });
    expect(await paDcnrPresqueIsle.scrape(NOW_ISO)).toBe(null);
  });
});
