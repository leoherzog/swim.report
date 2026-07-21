// test/metroparks.test.js
import { describe, it, expect, afterEach, vi } from "vitest";
import { parseMetroparksHtml, metroparks, METROPARKS_URL } from "../src/officialSources/metroparks.js";
import { installFetch } from "./helpers/fetch.js";
import { resolveSiteForBeach, scrapeOfficialFlagFromResult } from "../src/officialSources/index.js";
import { perBeachResult } from "../src/officialSources/util.js";
import { makeBeach } from "./helpers/beach.js";

// Trimmed fixture mirroring the real vc_tta accordion structure: several
// unrelated park panels (with facility Open/Closed lines using identical
// markup, including a DECOY "Baypoint Beach" line outside the real Stony
// Creek panel to prove panel-slicing prevents leakage), the two panels we
// care about, and the out-of-scope Lake St. Clair placeholder in between.
const FULL_FIXTURE =
  "<div class=\"vc_tta-panel\" id=\"HuronMeadowsMetropark\" data-vc-content=\".vc_tta-panel-body\">" +
  "<div class=\"vc_tta-panel-body\">" +
  "<p><strong>Splash Pad:</strong> Open</p>" +
  "<p><strong>Baypoint Beach:</strong> Closed</p>" +
  "</div></div>" +
  "<div class=\"vc_tta-panel\" id=\"KensingtonMetropark\" data-vc-content=\".vc_tta-panel-body\">" +
  "<div class=\"vc_tta-panel-body\">" +
  "<p><strong>Martindale Beach:</strong> Open</p>" +
  "<p><strong>Maple Beach:</strong> Closed</p>" +
  "<p><strong>Kensington Golf Course:</strong> Open</p>" +
  "</div></div>" +
  "<div class=\"vc_tta-panel\" id=\"LakeStClairMetropark\" data-vc-content=\".vc_tta-panel-body\">" +
  "<div class=\"vc_tta-panel-body\">" +
  "<p><strong>Lake St. Clair Metropark Beach:</strong> Open For Season! For conditions " +
  "please check Michigan Beach Guard at: https://www.egle.state.mi.us/beach/</p>" +
  "</div></div>" +
  "<div class=\"vc_tta-panel\" id=\"StonyCreekMetropark\" data-vc-content=\".vc_tta-panel-body\">" +
  "<div class=\"vc_tta-panel-body\">" +
  "<p><strong>Baypoint Beach:</strong>  Closed</p>" +
  "<p><strong>Eastwood Beach:</strong>    Open</p>" +
  "<p><strong>Stony Creek Golf Course:</strong>  Closed</p>" +
  "</div></div>" +
  "<div class=\"vc_tta-panel\" id=\"WillowMetropark\" data-vc-content=\".vc_tta-panel-body\">" +
  "<div class=\"vc_tta-panel-body\">" +
  "<p><strong>Willow Beach:</strong> Closed</p>" +
  "</div></div>";

describe("parseMetroparksHtml", function() {
  it("returns red sites only for Closed beaches, scoped to the two real panels", function() {
    const sites = parseMetroparksHtml(FULL_FIXTURE);
    expect(sites).not.toBe(null);
    expect(sites.length).toBe(2);

    const bySiteId = {};
    for (let i = 0; i < sites.length; i++) {
      bySiteId[sites[i].siteId] = sites[i];
    }

    expect(bySiteId["maple-beach"]).toBeTruthy();
    expect(bySiteId["maple-beach"].color).toBe("red");
    expect(bySiteId["maple-beach"].names).toEqual(["maple beach"]);

    expect(bySiteId["baypoint-beach"]).toBeTruthy();
    expect(bySiteId["baypoint-beach"].color).toBe("red");
    expect(bySiteId["baypoint-beach"].names).toEqual(["baypoint beach"]);

    // Open beaches are omitted entirely (closure-only source, no green).
    expect(bySiteId["martindale-beach"]).toBe(undefined);
    expect(bySiteId["eastwood-beach"]).toBe(undefined);
  });

  it("does not leak the decoy Baypoint Beach line from outside the Stony Creek panel", function() {
    const sites = parseMetroparksHtml(FULL_FIXTURE);
    // Only one baypoint-beach site should appear, sourced from the real
    // Stony Creek panel slice, not the decoy line in HuronMeadowsMetropark.
    const baypointSites = sites.filter(function(site) { return site.siteId === "baypoint-beach"; });
    expect(baypointSites.length).toBe(1);
  });

  it("never treats unrelated facility Open/Closed lines as beach sites", function() {
    const sites = parseMetroparksHtml(FULL_FIXTURE);
    const siteIds = sites.map(function(site) { return site.siteId; });
    expect(siteIds.indexOf("kensington-golf-course")).toBe(-1);
    expect(siteIds.indexOf("stony-creek-golf-course")).toBe(-1);
    expect(siteIds.indexOf("willow-beach")).toBe(-1);
    expect(siteIds.indexOf("splash-pad")).toBe(-1);
  });

  it("never scrapes the Lake St. Clair Metropark placeholder beach line", function() {
    const sites = parseMetroparksHtml(FULL_FIXTURE);
    const siteIds = sites.map(function(site) { return site.siteId; });
    expect(siteIds.indexOf("lake-st-clair-metropark-beach")).toBe(-1);
  });

  it("omits a beach whose line is missing from its panel", function() {
    const fixture =
      "<div class=\"vc_tta-panel\" id=\"KensingtonMetropark\" data-vc-content=\".vc_tta-panel-body\">" +
      "<div class=\"vc_tta-panel-body\">" +
      "<p><strong>Martindale Beach:</strong> Closed</p>" +
      "</div></div>";
    const sites = parseMetroparksHtml(fixture);
    expect(sites).not.toBe(null);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("martindale-beach");
  });

  it("returns an empty array when both panels are present but every beach is Open", function() {
    const fixture =
      "<div class=\"vc_tta-panel\" id=\"KensingtonMetropark\" data-vc-content=\".vc_tta-panel-body\">" +
      "<div class=\"vc_tta-panel-body\">" +
      "<p><strong>Martindale Beach:</strong> Open</p>" +
      "<p><strong>Maple Beach:</strong> Open</p>" +
      "</div></div>" +
      "<div class=\"vc_tta-panel\" id=\"StonyCreekMetropark\" data-vc-content=\".vc_tta-panel-body\">" +
      "<div class=\"vc_tta-panel-body\">" +
      "<p><strong>Baypoint Beach:</strong> Open</p>" +
      "<p><strong>Eastwood Beach:</strong> Open</p>" +
      "</div></div>";
    const sites = parseMetroparksHtml(fixture);
    expect(sites).toEqual([]);

    // Empty-success flow: the all-Open [] is wrapped in an empty perBeachResult
    // (a SUCCESSFUL scrape with nothing to report, so scrape() returns this,
    // never null). It must resolve to no official flag for every metropark
    // beach without throwing, writing no official KV.
    const result = perBeachResult(sites, METROPARKS_URL, "2026-07-17T00:00:00.000Z");
    expect(result.perBeach).toBe(true);
    expect(result.sites).toEqual([]);
    const beaches = [
      makeBeach({ name: "Martindale Beach", park_name: "Kensington Metropark", lat: 42.541, lon: -83.691 }),
      makeBeach({ name: "Maple Beach", park_name: "Kensington Metropark", lat: 42.541, lon: -83.691 }),
      makeBeach({ name: "Baypoint Beach", park_name: "Stony Creek Metropark", lat: 42.66, lon: -83.115 }),
      makeBeach({ name: "Eastwood Beach", park_name: "Stony Creek Metropark", lat: 42.66, lon: -83.115 })
    ];
    for (let i = 0; i < beaches.length; i++) {
      expect(scrapeOfficialFlagFromResult(beaches[i], metroparks, result)).toBe(null);
    }
  });

  it("omits a beach whose status word is not a clean Open/Closed token", function() {
    const fixture =
      "<div class=\"vc_tta-panel\" id=\"KensingtonMetropark\" data-vc-content=\".vc_tta-panel-body\">" +
      "<div class=\"vc_tta-panel-body\">" +
      "<p><strong>Martindale Beach:</strong> CLOSED 7/5/26 due to power outage [updated 10:30 am]</p>" +
      "<p><strong>Maple Beach:</strong> will be CLOSED for repairs for the 2026 season.</p>" +
      "</div></div>";
    const sites = parseMetroparksHtml(fixture);
    // "CLOSED" at the start of "CLOSED 7/5/26..." IS a clean first word, so
    // Martindale legitimately resolves to closed/red here...
    const bySiteId = {};
    for (let i = 0; i < sites.length; i++) {
      bySiteId[sites[i].siteId] = sites[i];
    }
    expect(bySiteId["martindale-beach"].color).toBe("red");
    // ...but Maple's status word is "will", not Open/Closed, so it is
    // correctly omitted rather than guessed at.
    expect(bySiteId["maple-beach"]).toBe(undefined);
  });

  it("returns null when neither target panel can be found (renamed ids / redesign)", function() {
    const fixture =
      "<div class=\"vc_tta-panel\" id=\"KensingtonMetroparkRenamed\" data-vc-content=\".vc_tta-panel-body\">" +
      "<div class=\"vc_tta-panel-body\">" +
      "<p><strong>Martindale Beach:</strong> Closed</p>" +
      "</div></div>";
    expect(parseMetroparksHtml(fixture)).toBe(null);
  });

  it("returns null for garbage HTML", function() {
    expect(parseMetroparksHtml("<html><body>hello world</body></html>")).toBe(null);
  });

  it("returns null for empty or null input", function() {
    expect(parseMetroparksHtml("")).toBe(null);
    expect(parseMetroparksHtml(null)).toBe(null);
  });
});

describe("metroparks site resolution (no proximity misattribution)", function() {
  // Regression: the two beaches in a park share the same lake and (previously)
  // the same park-centroid coordinates with a 3 mi site radius. When one beach
  // was closed and the sibling open, resolveSiteForBeach's proximity pass would
  // resolve the OPEN sibling to the CLOSED beach's red site — a false red on the
  // wrong beach. Sites are now name-only, so this can never happen.
  const oneClosedOneOpen =
    "<div class=\"vc_tta-panel\" id=\"KensingtonMetropark\" data-vc-content=\".vc_tta-panel-body\">" +
    "<div class=\"vc_tta-panel-body\">" +
    "<p><strong>Martindale Beach:</strong> Closed</p>" +
    "<p><strong>Maple Beach:</strong> Open</p>" +
    "</div></div>";

  it("does not carry lat/lon/radiusMi on emitted sites (name-only resolution)", function() {
    const sites = parseMetroparksHtml(oneClosedOneOpen);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("martindale-beach");
    expect(sites[0].lat).toBe(undefined);
    expect(sites[0].lon).toBe(undefined);
    expect(sites[0].radiusMi).toBe(undefined);
  });

  it("resolves the closed beach to red by name", function() {
    const sites = parseMetroparksHtml(oneClosedOneOpen);
    const martindale = makeBeach({
      name: "Martindale Beach", park_name: "Kensington Metropark",
      lat: 42.541, lon: -83.691
    });
    const site = resolveSiteForBeach(martindale, sites);
    expect(site).toBeTruthy();
    expect(site.siteId).toBe("martindale-beach");
    expect(site.color).toBe("red");
  });

  it("does NOT resolve the open sibling beach to the closed beach's red", function() {
    const sites = parseMetroparksHtml(oneClosedOneOpen);
    // A real, currently-OPEN Maple Beach node, at essentially the same coords
    // as its closed Martindale sibling. It must resolve to no site (fall back
    // to the estimate), never to Martindale's red.
    const maple = makeBeach({
      name: "Maple Beach", park_name: "Kensington Metropark",
      lat: 42.541, lon: -83.691
    });
    expect(resolveSiteForBeach(maple, sites)).toBe(null);
  });

  it("does NOT resolve a generically named nearby beach to a closure", function() {
    const sites = parseMetroparksHtml(oneClosedOneOpen);
    // A generically named OSM node near Kensington cannot be attributed to a
    // specific beach's closure, so it must resolve to no site.
    const generic = makeBeach({
      name: "Swimming Area", park_name: "Kensington Metropark",
      lat: 42.541, lon: -83.691
    });
    expect(resolveSiteForBeach(generic, sites)).toBe(null);
  });
});

describe("metroparks.matches", function() {
  it("matches by exact beach name", function() {
    const beach = makeBeach({
      name: "Martindale Beach",
      lat: 42.54, lon: -83.69
    });
    expect(metroparks.matches(beach)).toBe(true);
  });

  it("matches by park_name containing Stony Creek", function() {
    const beach = makeBeach({
      name: "Beach Area", park_name: "Stony Creek Metropark",
      lat: 42.66, lon: -83.115
    });
    expect(metroparks.matches(beach)).toBe(true);
  });

  it("matches by proximity within 3 mi of Kensington Metropark", function() {
    const beach = makeBeach({
      name: "Unrelated Name",
      lat: 42.55, lon: -83.69
    });
    expect(metroparks.matches(beach)).toBe(true);
  });

  it("does not match a beach far from both parks with an unrelated name", function() {
    const beach = makeBeach({
      name: "Holland State Park",
      lat: 42.7739, lon: -86.2109
    });
    expect(metroparks.matches(beach)).toBe(false);
  });

  it("does not match a far-away namesake beach that has coordinates (false-red guard)", function() {
    // A DIFFERENT "Maple Beach" on a Michigan inland lake, ~130 mi from
    // Kensington. It shares the label of a real metropark beach, so a bare
    // name match would let a Kensington "Maple Beach: Closed" resolve onto it
    // by name and publish a false OFFICIAL RED. Coordinates far from both
    // parks must exclude it.
    const beach = makeBeach({
      name: "Maple Beach",
      lat: 44.5, lon: -85.6
    });
    expect(metroparks.matches(beach)).toBe(false);
  });

  it("does not attribute a Kensington closure to a far-away namesake beach", function() {
    // End-to-end: even the parse+resolve path must not paint a false red on a
    // namesake. Since matches() already excludes it cron-side, this documents
    // the intended full-pipeline outcome for the namesake case.
    const html =
      "<div class=\"vc_tta-panel\" id=\"KensingtonMetropark\" data-vc-content=\".vc_tta-panel-body\">" +
      "<div class=\"vc_tta-panel-body\">" +
      "<p><strong>Martindale Beach:</strong> Open</p>" +
      "<p><strong>Maple Beach:</strong> Closed</p>" +
      "</div></div>" +
      "<div class=\"vc_tta-panel\" id=\"StonyCreekMetropark\" data-vc-content=\".vc_tta-panel-body\">" +
      "<div class=\"vc_tta-panel-body\">" +
      "<p><strong>Baypoint Beach:</strong> Open</p>" +
      "<p><strong>Eastwood Beach:</strong> Open</p>" +
      "</div></div>";
    const sites = parseMetroparksHtml(html);
    const farMaple = makeBeach({
      name: "Maple Beach",
      lat: 44.5, lon: -85.6
    });
    // The cron only resolves beaches that matched; this one must not match...
    expect(metroparks.matches(farMaple)).toBe(false);
    // ...and if it somehow reached resolution, that is the documented risk we
    // are guarding against — assert the gate at matches() is what stops it.
    expect(resolveSiteForBeach(farMaple, sites).siteId).toBe("maple-beach");
  });

  it("matches a coordinate-less row purely by known beach name", function() {
    const beach = makeBeach({
      name: "Baypoint Beach",
      lat: null, lon: null
    });
    expect(metroparks.matches(beach)).toBe(true);
  });

  it("does not match Lake St. Clair Metropark Beach (out of scope)", function() {
    const beach = makeBeach({
      name: "Lake St. Clair Metropark Beach", park_name: "Lake St. Clair Metropark",
      lat: 42.58, lon: -82.79
    });
    expect(metroparks.matches(beach)).toBe(false);
  });
});

describe("metroparks.scrape", function() {
  afterEach(function() {
    vi.unstubAllGlobals();
  });

  const NOW_ISO = "2026-07-17T00:00:00.000Z";

  // A fetch Response stand-in whose text() resolves to body.
  function textResponse(body) {
    return {
      ok: true,
      text: function() {
        return Promise.resolve(body);
      }
    };
  }

  // Both real panels present, every beach Open — the all-season-normal page.
  const ALL_OPEN_FIXTURE =
    "<div class=\"vc_tta-panel\" id=\"KensingtonMetropark\" data-vc-content=\".vc_tta-panel-body\">" +
    "<div class=\"vc_tta-panel-body\">" +
    "<p><strong>Martindale Beach:</strong> Open</p>" +
    "<p><strong>Maple Beach:</strong> Open</p>" +
    "</div></div>" +
    "<div class=\"vc_tta-panel\" id=\"StonyCreekMetropark\" data-vc-content=\".vc_tta-panel-body\">" +
    "<div class=\"vc_tta-panel-body\">" +
    "<p><strong>Baypoint Beach:</strong> Open</p>" +
    "<p><strong>Eastwood Beach:</strong> Open</p>" +
    "</div></div>";

  // Neither target panel id present (page redesign / renamed ids).
  const RENAMED_PANEL_FIXTURE =
    "<div class=\"vc_tta-panel\" id=\"KensingtonMetroparkRenamed\" data-vc-content=\".vc_tta-panel-body\">" +
    "<div class=\"vc_tta-panel-body\">" +
    "<p><strong>Martindale Beach:</strong> Closed</p>" +
    "</div></div>";

  it("returns an empty perBeachResult (NOT null) when every beach is Open", async function() {
    const calls = installFetch(function() {
      return Promise.resolve(textResponse(ALL_OPEN_FIXTURE));
    });
    const result = await metroparks.scrape(NOW_ISO);
    // Empty-success semantics: a clean all-Open parse is a SUCCESSFUL scrape
    // with nothing to report, never a null "failure".
    expect(result).not.toBe(null);
    expect(result.perBeach).toBe(true);
    expect(result.sites).toEqual([]);
    expect(result.source).toBe(METROPARKS_URL);
    expect(result.sources).toEqual([METROPARKS_URL]);
    expect(result.updated).toBe(NOW_ISO);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(METROPARKS_URL);
  });

  it("returns closed-beach sites through the real scrape() path", async function() {
    installFetch(function() {
      return Promise.resolve(textResponse(FULL_FIXTURE));
    });
    const result = await metroparks.scrape(NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.perBeach).toBe(true);
    const siteIds = result.sites.map(function(site) { return site.siteId; });
    siteIds.sort();
    expect(siteIds).toEqual(["baypoint-beach", "maple-beach"]);
  });

  it("returns null when neither target panel is found (real parse failure)", async function() {
    installFetch(function() {
      return Promise.resolve(textResponse(RENAMED_PANEL_FIXTURE));
    });
    const result = await metroparks.scrape(NOW_ISO);
    expect(result).toBe(null);
  });

  it("returns null on a non-2xx response", async function() {
    installFetch(function() {
      return Promise.resolve({
        ok: false,
        status: 503,
        text: function() {
          return Promise.resolve("Service Unavailable");
        }
      });
    });
    expect(await metroparks.scrape(NOW_ISO)).toBe(null);
  });

  it("returns null on a network error", async function() {
    installFetch(function() {
      return Promise.reject(new Error("connect timeout"));
    });
    expect(await metroparks.scrape(NOW_ISO)).toBe(null);
  });

  it("sends NO headers (metroparks.com has only been probed without a User-Agent)", async function() {
    const calls = installFetch(function() {
      return Promise.resolve(textResponse(ALL_OPEN_FIXTURE));
    });
    await metroparks.scrape(NOW_ISO);
    expect(calls.length).toBe(1);
    // A regression that silently adds a User-Agent (or any header) to this
    // un-probed source must fail here: the init has no headers key at all.
    expect("headers" in calls[0].init).toBe(false);
  });
});
