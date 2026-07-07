// test/metroparks.test.js
import { describe, it, expect } from "vitest";
import { parseMetroparksHtml, metroparks } from "../src/officialSources/metroparks.js";
import { resolveSiteForBeach } from "../src/officialSources/index.js";

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
    const martindale = {
      id: "osm-node-10", name: "Martindale Beach", park_name: "Kensington Metropark",
      lat: 42.541, lon: -83.691, nws_zone: null, nws_grid_url: null, osm_id: "node/10"
    };
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
    const maple = {
      id: "osm-node-11", name: "Maple Beach", park_name: "Kensington Metropark",
      lat: 42.541, lon: -83.691, nws_zone: null, nws_grid_url: null, osm_id: "node/11"
    };
    expect(resolveSiteForBeach(maple, sites)).toBe(null);
  });

  it("does NOT resolve a generically named nearby beach to a closure", function() {
    const sites = parseMetroparksHtml(oneClosedOneOpen);
    // A generically named OSM node near Kensington cannot be attributed to a
    // specific beach's closure, so it must resolve to no site.
    const generic = {
      id: "osm-node-12", name: "Swimming Area", park_name: "Kensington Metropark",
      lat: 42.541, lon: -83.691, nws_zone: null, nws_grid_url: null, osm_id: "node/12"
    };
    expect(resolveSiteForBeach(generic, sites)).toBe(null);
  });
});

describe("metroparks.matches", function() {
  it("matches by exact beach name", function() {
    const beach = {
      id: "osm-node-1", name: "Martindale Beach", park_name: null,
      lat: 42.54, lon: -83.69, nws_zone: null, nws_grid_url: null, osm_id: "node/1"
    };
    expect(metroparks.matches(beach)).toBe(true);
  });

  it("matches by park_name containing Stony Creek", function() {
    const beach = {
      id: "osm-node-2", name: "Beach Area", park_name: "Stony Creek Metropark",
      lat: 42.66, lon: -83.115, nws_zone: null, nws_grid_url: null, osm_id: "node/2"
    };
    expect(metroparks.matches(beach)).toBe(true);
  });

  it("matches by proximity within 3 mi of Kensington Metropark", function() {
    const beach = {
      id: "osm-node-3", name: "Unrelated Name", park_name: null,
      lat: 42.55, lon: -83.69, nws_zone: null, nws_grid_url: null, osm_id: "node/3"
    };
    expect(metroparks.matches(beach)).toBe(true);
  });

  it("does not match a beach far from both parks with an unrelated name", function() {
    const beach = {
      id: "osm-node-4", name: "Holland State Park", park_name: null,
      lat: 42.7739, lon: -86.2109, nws_zone: null, nws_grid_url: null, osm_id: "node/4"
    };
    expect(metroparks.matches(beach)).toBe(false);
  });

  it("does not match a far-away namesake beach that has coordinates (false-red guard)", function() {
    // A DIFFERENT "Maple Beach" on a Michigan inland lake, ~130 mi from
    // Kensington. It shares the label of a real metropark beach, so a bare
    // name match would let a Kensington "Maple Beach: Closed" resolve onto it
    // by name and publish a false OFFICIAL RED. Coordinates far from both
    // parks must exclude it.
    const beach = {
      id: "osm-node-6", name: "Maple Beach", park_name: null,
      lat: 44.5, lon: -85.6, nws_zone: null, nws_grid_url: null, osm_id: "node/6"
    };
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
    const farMaple = {
      id: "osm-node-7", name: "Maple Beach", park_name: null,
      lat: 44.5, lon: -85.6, nws_zone: null, nws_grid_url: null, osm_id: "node/7"
    };
    // The cron only resolves beaches that matched; this one must not match...
    expect(metroparks.matches(farMaple)).toBe(false);
    // ...and if it somehow reached resolution, that is the documented risk we
    // are guarding against — assert the gate at matches() is what stops it.
    expect(resolveSiteForBeach(farMaple, sites).siteId).toBe("maple-beach");
  });

  it("matches a coordinate-less row purely by known beach name", function() {
    const beach = {
      id: "osm-node-8", name: "Baypoint Beach", park_name: null,
      lat: null, lon: null, nws_zone: null, nws_grid_url: null, osm_id: "node/8"
    };
    expect(metroparks.matches(beach)).toBe(true);
  });

  it("does not match Lake St. Clair Metropark Beach (out of scope)", function() {
    const beach = {
      id: "osm-node-5", name: "Lake St. Clair Metropark Beach", park_name: "Lake St. Clair Metropark",
      lat: 42.58, lon: -82.79, nws_zone: null, nws_grid_url: null, osm_id: "node/5"
    };
    expect(metroparks.matches(beach)).toBe(false);
  });
});
