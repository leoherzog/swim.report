// test/nwsMarineBeachForecast.test.js
// Unit tests for the NWS Marine Beach Forecast official HAZARD scraper. All
// pure parsers are exercised against inline fixtures (no network); the scrape()
// path is exercised with a stubbed globalThis.fetch.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  normalizeRipColor,
  parseSurfFeet,
  surfColor,
  colorFromConditions,
  productDateMs,
  isFreshProduct,
  productIssuanceIso,
  parseLayerZones,
  buildSites,
  layerQueryUrl,
  nwsMarineBeachForecast,
  SITE_DEFS,
  STALE_MAX_DAYS,
  FORECAST_STALE_MS,
  NWS_MARINE_BEACH_MAP_URL
} from "../src/officialSources/nwsMarineBeachForecast.js";
import { resolveSiteForBeach, scrapeOfficialFlagFromResult } from "../src/officialSources/index.js";
import { perBeachResult } from "../src/officialSources/util.js";
import { displayFlag } from "../src/displayFlag.js";
import { installFetch } from "./helpers/fetch.js";
import { makeBeach } from "./helpers/beach.js";

const NOW_ISO = "2026-07-22T12:00:00Z";
// The issuance the feature() helper's "346 AM EDT" on 7/22/2026 resolves to.
const ISSUED_ISO = "2026-07-22T07:46:00.000Z";

// Real captures from 2026-10-13T13:33Z: MFL in season (layer 76, four zones
// issued 416 AM EDT) and CLE off season (layer 19, every product field null).
const MFL_FIXTURE = readFileSync(
  new URL("./fixtures/nwsMarineBeachForecast-mfl-day1-2026-10-13.json", import.meta.url), "utf8");
const CLE_OFFSEASON_FIXTURE = readFileSync(
  new URL("./fixtures/nwsMarineBeachForecast-cle-day1-offseason-2026-10-13.json", import.meta.url), "utf8");
const FIXTURE_NOW_ISO = "2026-10-13T13:33:57Z";

// A hand-built zone entry in the shape parseLayerZones emits.
function zone(beachname, color, updated) {
  return { beachname: beachname, color: color, updated: updated === undefined ? ISSUED_ISO : updated };
}

// Build one layer's Esri-JSON query response from attribute objects.
function layerJson(attrList) {
  const features = [];
  for (let i = 0; i < attrList.length; i++) {
    features.push({ attributes: attrList[i] });
  }
  return JSON.stringify({ features: features });
}

// A fresh Day-1 feature attribute object with sensible defaults. extra overrides
// any attribute, so a test can null producttim or set idp_filedate.
function feature(beachname, rip, surf, productdat, extra) {
  return Object.assign({
    beachname: beachname,
    rip: rip,
    surf: surf,
    productdat: productdat === undefined ? "7/22/2026" : productdat,
    producttim: "346 AM EDT",
    idp_filedate: null
  }, extra || {});
}

// A fetch Response stand-in whose text() resolves to body (fetchText uses text()).
function textResponse(body) {
  return {
    ok: true,
    text: function () {
      return Promise.resolve(body);
    }
  };
}

describe("normalizeRipColor", function () {
  it("maps the three recognized swim-risk words", function () {
    expect(normalizeRipColor("Low")).toBe("green");
    expect(normalizeRipColor("Moderate")).toBe("yellow");
    expect(normalizeRipColor("High")).toBe("red");
  });

  it("is case/whitespace tolerant", function () {
    expect(normalizeRipColor("  high ")).toBe("red");
    expect(normalizeRipColor("MODERATE")).toBe("yellow");
  });

  it("degrades to null for anything unrecognized (never guesses)", function () {
    expect(normalizeRipColor("None")).toBe(null);
    expect(normalizeRipColor("")).toBe(null);
    expect(normalizeRipColor("Extreme")).toBe(null);
    expect(normalizeRipColor(null)).toBe(null);
    expect(normalizeRipColor(5)).toBe(null);
    expect(normalizeRipColor(undefined)).toBe(null);
  });
});

describe("parseSurfFeet", function () {
  it("takes the MAX foot value across a range/phrase (conservative)", function () {
    expect(parseSurfFeet("2 to 4 feet subsiding to 2 feet or less.")).toBe(4);
    expect(parseSurfFeet("1 to 3 feet.")).toBe(3);
    expect(parseSurfFeet("5 to 8 feet.")).toBe(8);
    expect(parseSurfFeet("3 to 6 feet building to 4 to 7 feet.")).toBe(7);
  });

  it("handles a single sub-foot reading", function () {
    expect(parseSurfFeet("less than 1 foot")).toBe(1);
    expect(parseSurfFeet("1 foot or less")).toBe(1);
  });

  it("degrades to null with no feet token or no number", function () {
    expect(parseSurfFeet("calm")).toBe(null);
    expect(parseSurfFeet("flat")).toBe(null);
    expect(parseSurfFeet("no number but says feet")).toBe(null);
    expect(parseSurfFeet("")).toBe(null);
    expect(parseSurfFeet(null)).toBe(null);
    expect(parseSurfFeet(42)).toBe(null);
  });
});

describe("surfColor", function () {
  it("colors surf via the shared 2/4 ft thresholds using the peak", function () {
    expect(surfColor("1 to 3 feet.")).toBe("yellow");
    expect(surfColor("2 to 4 feet.")).toBe("red");
    expect(surfColor("1 to 2 feet.")).toBe("yellow");
    expect(surfColor("less than 1 foot")).toBe("green");
  });

  it("degrades to null when surf is unparseable", function () {
    expect(surfColor("calm")).toBe(null);
    expect(surfColor(null)).toBe(null);
  });
});

describe("colorFromConditions", function () {
  it("takes the MORE SEVERE of rip and surf color", function () {
    // rip Low(green) vs surf 1-3ft(yellow) -> yellow
    expect(colorFromConditions("Low", "1 to 3 feet.")).toBe("yellow");
    // rip High(red) vs surf 1-2ft(yellow) -> red
    expect(colorFromConditions("High", "1 to 2 feet.")).toBe("red");
    // rip Moderate(yellow) vs surf green -> yellow
    expect(colorFromConditions("Moderate", "less than 1 foot")).toBe("yellow");
  });

  it("uses the one axis that classifies when the other is null", function () {
    expect(colorFromConditions("High", "calm")).toBe("red");
    expect(colorFromConditions("bogus", "3 to 5 feet.")).toBe("red");
  });

  it("returns null when NEITHER axis classifies", function () {
    expect(colorFromConditions("None", "calm")).toBe(null);
    expect(colorFromConditions(null, null)).toBe(null);
  });
});

describe("productDateMs / isFreshProduct", function () {
  it("parses a M/D/YYYY product date to UTC-midnight ms", function () {
    expect(productDateMs("7/22/2026")).toBe(Date.UTC(2026, 6, 22));
    expect(productDateMs("12/1/2025")).toBe(Date.UTC(2025, 11, 1));
  });

  it("rejects malformed product dates", function () {
    expect(productDateMs("not a date")).toBe(null);
    expect(productDateMs("13/40/2026")).toBe(null);
    expect(productDateMs("")).toBe(null);
    expect(productDateMs(null)).toBe(null);
  });

  it("treats a same-day product as fresh", function () {
    expect(isFreshProduct("7/22/2026", NOW_ISO)).toBe(true);
    // within the STALE_MAX_DAYS slack
    expect(isFreshProduct("7/21/2026", NOW_ISO)).toBe(true);
  });

  it("treats a multi-day-old product as stale, and fails closed", function () {
    expect(isFreshProduct("7/18/2026", NOW_ISO)).toBe(false);
    expect(isFreshProduct("garbage", NOW_ISO)).toBe(false);
    expect(isFreshProduct("7/22/2026", "not-an-iso")).toBe(false);
    // sanity on the slack constant
    expect(STALE_MAX_DAYS).toBe(2);
  });
});

describe("parseLayerZones", function () {
  it("maps fresh, classifiable features to lowercase beachname -> color", function () {
    const text = layerJson([
      feature("Lucas Area Beaches", "Low", "1 to 3 feet."),
      feature("Cuyahoga Area Beaches", "High", "3 to 5 feet subsiding to 2 to 4 feet.")
    ]);
    const zones = parseLayerZones(text, NOW_ISO);
    expect(zones["lucas area beaches"]).toEqual({
      beachname: "Lucas Area Beaches",
      color: "yellow",
      updated: ISSUED_ISO
    });
    expect(zones["cuyahoga area beaches"].color).toBe("red");
    expect(zones["cuyahoga area beaches"].updated).toBe(ISSUED_ISO);
  });

  it("drops stale features and unclassifiable features", function () {
    const text = layerJson([
      feature("Lucas Area Beaches", "Low", "1 to 3 feet."),
      feature("Ashtabula Area Beaches", "High", "3 to 5 feet.", "7/18/2026"),
      feature("Nowhere Area Beaches", "None", "calm")
    ]);
    const zones = parseLayerZones(text, NOW_ISO);
    expect(zones["lucas area beaches"].color).toBe("yellow");
    expect(zones["ashtabula area beaches"]).toBe(undefined);
    expect(zones["nowhere area beaches"]).toBe(undefined);
  });

  it("also reads GeoJSON feature.properties", function () {
    const body = JSON.stringify({
      features: [
        { properties: feature("Lucas Area Beaches", "High", "4 to 7 feet.") }
      ]
    });
    const zones = parseLayerZones(body, NOW_ISO);
    expect(zones["lucas area beaches"].color).toBe("red");
  });

  it("returns null on malformed / empty / all-stale bodies (never throws)", function () {
    expect(parseLayerZones("<<<not json>>>", NOW_ISO)).toBe(null);
    expect(parseLayerZones(JSON.stringify({ foo: 1 }), NOW_ISO)).toBe(null);
    expect(parseLayerZones(JSON.stringify({ features: [] }), NOW_ISO)).toBe(null);
    expect(parseLayerZones(layerJson([
      feature("Lucas Area Beaches", "Low", "1 to 3 feet.", "1/1/2000")
    ]), NOW_ISO)).toBe(null);
    expect(parseLayerZones(layerJson([feature("Lucas Area Beaches", "Low", "1 to 3 feet.")]), "bad-iso")).toBe(null);
  });
});

describe("productIssuanceIso", function () {
  it("maps productdat + producttim through the office zone to a UTC instant", function () {
    expect(productIssuanceIso("10/13/2026", "416 AM EDT", null)).toBe("2026-10-13T08:16:00.000Z");
    expect(productIssuanceIso("10/13/2026", "144 AM PDT", null)).toBe("2026-10-13T08:44:00.000Z");
    expect(productIssuanceIso("10/13/2026", "704 AM EDT", null)).toBe("2026-10-13T11:04:00.000Z");
  });

  it("reads 12 AM as midnight and 12 PM as noon", function () {
    expect(productIssuanceIso("10/13/2026", "1200 PM EST", null)).toBe("2026-10-13T17:00:00.000Z");
    expect(productIssuanceIso("10/13/2026", "1230 AM EDT", null)).toBe("2026-10-13T04:30:00.000Z");
    expect(productIssuanceIso("10/13/2026", "1215 PM CDT", null)).toBe("2026-10-13T17:15:00.000Z");
  });

  it("tolerates surrounding whitespace in producttim", function () {
    expect(productIssuanceIso("10/13/2026", " 416 AM EDT ", null)).toBe("2026-10-13T08:16:00.000Z");
  });

  it("falls back to a finite idp_filedate when the time or zone does not parse", function () {
    expect(productIssuanceIso("10/13/2026", "416 AM XYZ", 1791879765000)).toBe("2026-10-13T08:22:45.000Z");
    expect(productIssuanceIso("10/13/2026", null, 1791879765000)).toBe("2026-10-13T08:22:45.000Z");
    expect(productIssuanceIso("10/13/2026", "4:16 AM EDT", 1791879765000)).toBe("2026-10-13T08:22:45.000Z");
    expect(productIssuanceIso("10/13/2026", "1360 AM EDT", 1791879765000)).toBe("2026-10-13T08:22:45.000Z");
    expect(productIssuanceIso("10/13/2026", "000 AM EDT", 1791879765000)).toBe("2026-10-13T08:22:45.000Z");
    expect(productIssuanceIso(null, "416 AM EDT", 1791879765000)).toBe("2026-10-13T08:22:45.000Z");
  });

  it("prefers the product time over the file date when both resolve", function () {
    expect(productIssuanceIso("10/13/2026", "416 AM EDT", 1791879765000)).toBe("2026-10-13T08:16:00.000Z");
  });

  it("returns null when neither resolves, never guessing", function () {
    expect(productIssuanceIso(null, null, null)).toBe(null);
    expect(productIssuanceIso("10/13/2026", "416 AM XYZ", null)).toBe(null);
    expect(productIssuanceIso("10/13/2026", null, NaN)).toBe(null);
    expect(productIssuanceIso("10/13/2026", null, "1791879765000")).toBe(null);
    expect(productIssuanceIso("garbage", null, undefined)).toBe(null);
  });
});

describe("parseLayerZones over real captured layers", function () {
  it("stamps every in-season MFL zone with the 416 AM EDT issuance", function () {
    const zones = parseLayerZones(MFL_FIXTURE, FIXTURE_NOW_ISO);
    const names = Object.keys(zones);
    expect(names.length).toBe(4);
    expect(names).toContain("miami beach area");
    for (let i = 0; i < names.length; i++) {
      expect(zones[names[i]].updated).toBe("2026-10-13T08:16:00.000Z");
    }
    // Rip Low everywhere; "1 foot or less." is green and "1 to 2 feet." reaches
    // the 2 ft yellow threshold.
    expect(zones["naples and marco island area beaches"].color).toBe("green");
    expect(zones["miami beach area"].color).toBe("yellow");
  });

  it("returns null for the off-season CLE layer, whose product fields are all null", function () {
    expect(parseLayerZones(CLE_OFFSEASON_FIXTURE, FIXTURE_NOW_ISO)).toBe(null);
  });

  it("drops a feature with no resolvable issuance even when its color classifies", function () {
    const text = layerJson([
      feature("Lucas Area Beaches", "Low", "1 to 3 feet."),
      feature("Cuyahoga Area Beaches", "High", "3 to 5 feet.", undefined,
        { producttim: null, idp_filedate: null }),
      feature("Lorain Area Beaches", "High", "3 to 5 feet.", undefined,
        { producttim: "bogus", idp_filedate: null })
    ]);
    const zones = parseLayerZones(text, NOW_ISO);
    expect(zones["lucas area beaches"].updated).toBe(ISSUED_ISO);
    expect(zones["cuyahoga area beaches"]).toBe(undefined);
    expect(zones["lorain area beaches"]).toBe(undefined);
  });

  it("stamps the file date when only producttim is missing", function () {
    const text = layerJson([
      feature("Lucas Area Beaches", "Low", "1 to 3 feet.", undefined,
        { producttim: null, idp_filedate: Date.UTC(2026, 6, 22, 7, 52, 45) })
    ]);
    const zones = parseLayerZones(text, NOW_ISO);
    expect(zones["lucas area beaches"].updated).toBe("2026-07-22T07:52:45.000Z");
  });

  it("returns null when every classifiable feature lacks an issuance", function () {
    const text = layerJson([
      feature("Lucas Area Beaches", "Low", "1 to 3 feet.", undefined,
        { producttim: null, idp_filedate: null })
    ]);
    expect(parseLayerZones(text, NOW_ISO)).toBe(null);
  });

  it("takes the last fresh feature when a zone is named twice with different issuances", function () {
    const text = layerJson([
      feature("Lucas Area Beaches", "Low", "1 foot or less.", undefined, { producttim: "346 AM EDT" }),
      feature("Lucas Area Beaches", "High", "3 to 5 feet.", undefined, { producttim: "1130 AM EDT" })
    ]);
    const zones = parseLayerZones(text, NOW_ISO);
    expect(zones["lucas area beaches"].color).toBe("red");
    expect(zones["lucas area beaches"].updated).toBe("2026-07-22T15:30:00.000Z");
  });
});

describe("buildSites", function () {
  it("emits a contract-v2 site for each live curated zone", function () {
    const byLayer = new Map();
    byLayer.set(19, {
      "lucas area beaches": zone("Lucas Area Beaches", "yellow")
    });
    const sites = buildSites(byLayer);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("cle-lucas");
    expect(sites[0].color).toBe("yellow");
    expect(sites[0].updated).toBe(ISSUED_ISO);
    expect(sites[0].names).toContain("maumee bay");
    expect(typeof sites[0].lat).toBe("number");
    expect(sites[0].reason).toContain("Lucas Area Beaches");
    expect(sites[0].reason.indexOf("Forecast")).toBe(0);
    expect(sites[0].reason).not.toContain("Official");
  });

  it("emits no site for a zone with no issuance stamp, so the cron tick never stamps one", function () {
    const byLayer = new Map();
    byLayer.set(19, {
      "lucas area beaches": { beachname: "Lucas Area Beaches", color: "yellow" },
      "lorain area beaches": zone("Lorain Area Beaches", "red", ""),
      "lake area beaches": zone("Lake Area Beaches", "red", 1791879765000)
    });
    expect(buildSites(byLayer)).toEqual([]);
  });

  it("ignores zones with no live color and guards a bad map", function () {
    const byLayer = new Map();
    byLayer.set(19, { "unknown zone": zone("Unknown", "red") });
    expect(buildSites(byLayer)).toEqual([]);
    expect(buildSites(null)).toEqual([]);
  });

  it("keeps the two same-named 'Northern Erie' zones DISTINCT by layer", function () {
    const byLayer = new Map();
    byLayer.set(19, {
      "northern erie area beaches": zone("Northern Erie Area Beaches", "red")
    });
    byLayer.set(7, {
      "northern erie area beaches": zone("Northern Erie Area Beaches", "green")
    });
    const sites = buildSites(byLayer);
    const ids = sites.map(function (s) { return s.siteId; });
    expect(ids).toContain("cle-erie-pa");
    expect(ids).toContain("buf-erie-north");
    // The PA (Presque Isle) site carries the CLE red; the NY site the BUF green.
    const pa = sites.filter(function (s) { return s.siteId === "cle-erie-pa"; })[0];
    const ny = sites.filter(function (s) { return s.siteId === "buf-erie-north"; })[0];
    expect(pa.color).toBe("red");
    expect(ny.color).toBe("green");
    // names never overlap, so a Presque Isle beach can only bind to the PA site.
    expect(pa.names).toContain("presque isle");
    expect(ny.names).not.toContain("presque isle");
  });
});

describe("nwsMarineBeachForecast.matches", function () {
  it("owns Lake Erie / Ontario US-shore beaches only", function () {
    expect(nwsMarineBeachForecast.matches(makeBeach({ lat: 41.49, lon: -81.74 }))).toBe(true);
    expect(nwsMarineBeachForecast.matches(makeBeach({ lat: 43.26, lon: -77.61 }))).toBe(true);
    // Pacific / far-west beaches are not owned.
    expect(nwsMarineBeachForecast.matches(makeBeach({ lat: 36.9, lon: -122.0 }))).toBe(false);
    // Lake Michigan (Chicago) is outside the eastern box.
    expect(nwsMarineBeachForecast.matches(makeBeach({ lat: 41.9, lon: -87.63 }))).toBe(false);
  });
});

describe("end-to-end resolution via resolveSiteForBeach + scrapeOfficialFlagFromResult", function () {
  function resultFor(byLayer) {
    return perBeachResult(buildSites(byLayer), NWS_MARINE_BEACH_MAP_URL, NOW_ISO);
  }

  it("binds a named beach to its zone color and stamps an official flag", function () {
    const byLayer = new Map();
    byLayer.set(19, {
      "lucas area beaches": zone("Lucas Area Beaches", "yellow")
    });
    const result = resultFor(byLayer);
    const beach = makeBeach({
      id: "osm-1", name: "Maumee Bay State Park Beach",
      park_name: "Maumee Bay State Park", lat: 41.686, lon: -83.375
    });
    const site = resolveSiteForBeach(beach, result.sites);
    expect(site.siteId).toBe("cle-lucas");
    const flag = scrapeOfficialFlagFromResult(beach, nwsMarineBeachForecast, result);
    expect(flag.official).toBe(true);
    expect(flag.color).toBe("yellow");
    expect(flag.scraperId).toBe("nws-marine-beach-forecast");
  });

  it("binds an unnamed beach by nearest shoreline centroid within radius", function () {
    const byLayer = new Map();
    byLayer.set(7, {
      "monroe area beaches": zone("Monroe Area Beaches", "red")
    });
    const result = resultFor(byLayer);
    // A generic Rochester-area beach with no curated name token, near the
    // Monroe centroid (43.258, -77.605).
    const beach = makeBeach({ id: "osm-2", name: "Some Lakefront Park", lat: 43.27, lon: -77.62 });
    const flag = scrapeOfficialFlagFromResult(beach, nwsMarineBeachForecast, result);
    expect(flag).not.toBe(null);
    expect(flag.color).toBe("red");
  });

  it("yields NO flag (null) for a beach that binds to no curated zone", function () {
    const byLayer = new Map();
    byLayer.set(19, {
      "lucas area beaches": zone("Lucas Area Beaches", "yellow")
    });
    const result = resultFor(byLayer);
    // Far from any centroid, no matching name -> null (never a guessed color).
    const beach = makeBeach({ id: "osm-3", name: "Random Beach", lat: 43.9, lon: -76.18 });
    // (43.9,-76.18 is the Jefferson centroid, but that zone has no live color here.)
    expect(scrapeOfficialFlagFromResult(beach, nwsMarineBeachForecast, result)).toBe(null);
  });
  it("stamps the record with the site issuance, never the cron tick", function () {
    const byLayer = new Map();
    byLayer.set(19, {
      "lucas area beaches": zone("Lucas Area Beaches", "green")
    });
    const result = resultFor(byLayer);
    expect(result.updated).toBe(NOW_ISO);
    const beach = makeBeach({
      id: "osm-1", name: "Maumee Bay State Park Beach",
      park_name: "Maumee Bay State Park", lat: 41.686, lon: -83.375
    });
    const flag = scrapeOfficialFlagFromResult(beach, nwsMarineBeachForecast, result);
    expect(flag.updated).toBe(ISSUED_ISO);
    expect(flag.updated).not.toBe(NOW_ISO);
    expect(flag.kind).toBe("forecast");
    expect(flag.staleMs).toBe(FORECAST_STALE_MS);
    expect(flag.staleMs).toBe(108000000);
    expect(flag.readingNote).toBe("Forecast issued");
    expect(flag.reason).toBe("Forecast swim risk and surf conditions from " +
      "NWS Marine Beach Forecast for the Lucas Area Beaches zone");
  });

  // What the issuance stamp buys: the 2 h displayFlag gate now measures from
  // the morning product, so an afternoon estimate can outrank a morning green.
  describe("displayFlag over the stamped forecast record", function () {
    function forecastFlag(color) {
      const byLayer = new Map();
      byLayer.set(19, { "lucas area beaches": zone("Lucas Area Beaches", color) });
      const beach = makeBeach({
        id: "osm-1", name: "Maumee Bay State Park Beach",
        park_name: "Maumee Bay State Park", lat: 41.686, lon: -83.375
      });
      return scrapeOfficialFlagFromResult(beach, nwsMarineBeachForecast, resultFor(byLayer));
    }
    const estimate = function (color) {
      return { color: color, updated: NOW_ISO };
    };
    const ISSUED_PLUS_1H = "2026-07-22T08:46:00.000Z";
    const ISSUED_PLUS_3H = "2026-07-22T10:46:00.000Z";

    it("keeps a red estimate over a green forecast one hour after issuance", function () {
      const decision = displayFlag({ estimate: estimate("red"), official: forecastFlag("green") }, ISSUED_PLUS_1H);
      expect(decision.color).toBe("red");
      expect(decision.source).toBe("estimate");
    });

    it("lets a fresh yellow forecast raise a green estimate one hour after issuance", function () {
      const decision = displayFlag({ estimate: estimate("green"), official: forecastFlag("yellow") }, ISSUED_PLUS_1H);
      expect(decision.color).toBe("yellow");
      expect(decision.source).toBe("official");
      expect(decision.forecast).toBe(true);
    });

    it("credits the red estimate over the green forecast three hours after issuance", function () {
      const decision = displayFlag({ estimate: estimate("red"), official: forecastFlag("green") }, ISSUED_PLUS_3H);
      expect(decision.color).toBe("red");
      expect(decision.source).toBe("estimate");
    });

    it("still lets an aged yellow forecast raise a green estimate", function () {
      const decision = displayFlag({ estimate: estimate("green"), official: forecastFlag("yellow") }, ISSUED_PLUS_3H);
      expect(decision.color).toBe("yellow");
      expect(decision.source).toBe("official");
    });

    it("credits the estimate when an aged forecast merely ties it", function () {
      const decision = displayFlag({ estimate: estimate("yellow"), official: forecastFlag("yellow") }, ISSUED_PLUS_3H);
      expect(decision.color).toBe("yellow");
      expect(decision.source).toBe("estimate");
    });
  });
});

describe("layerQueryUrl", function () {
  it("builds the per-layer Esri query URL", function () {
    const url = layerQueryUrl(19);
    expect(url).toContain("/MapServer/19/query");
    expect(url).toContain("f=json");
    expect(url).toContain("outFields=*");
  });
});

describe("nwsMarineBeachForecast.scrape (network stubbed)", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("fetches the active layers and returns a perBeach result", async function () {
    installFetch(function (url) {
      if (String(url).indexOf("/MapServer/19/") !== -1) {
        return Promise.resolve(textResponse(layerJson([
          feature("Lucas Area Beaches", "Low", "1 to 3 feet."),
          feature("Cuyahoga Area Beaches", "High", "3 to 5 feet.")
        ])));
      }
      if (String(url).indexOf("/MapServer/7/") !== -1) {
        return Promise.resolve(textResponse(layerJson([
          feature("Monroe Area Beaches", "High", "3 to 6 feet.")
        ])));
      }
      return Promise.reject(new Error("unexpected url " + url));
    });
    const result = await nwsMarineBeachForecast.scrape(NOW_ISO);
    expect(result).not.toBe(null);
    expect(result.perBeach).toBe(true);
    const ids = result.sites.map(function (s) { return s.siteId; });
    expect(ids).toContain("cle-lucas");
    expect(ids).toContain("cle-cuyahoga");
    expect(ids).toContain("buf-monroe");
  });

  it("returns null when every layer fetch fails (health failure)", async function () {
    installFetch(function () {
      return Promise.resolve({ ok: false, status: 503 });
    });
    const result = await nwsMarineBeachForecast.scrape(NOW_ISO);
    expect(result).toBe(null);
  });

  it("survives a partial outage — one layer down still yields the other's sites", async function () {
    installFetch(function (url) {
      if (String(url).indexOf("/MapServer/19/") !== -1) {
        return Promise.resolve(textResponse(layerJson([
          feature("Lucas Area Beaches", "High", "4 to 6 feet.")
        ])));
      }
      return Promise.reject(new Error("layer 7 down"));
    });
    const result = await nwsMarineBeachForecast.scrape(NOW_ISO);
    expect(result).not.toBe(null);
    const ids = result.sites.map(function (s) { return s.siteId; });
    expect(ids).toContain("cle-lucas");
  });

  it("returns null (not a throw) when a fetch rejects on the last layer too", async function () {
    installFetch(function () {
      return Promise.reject(new Error("network down"));
    });
    const result = await nwsMarineBeachForecast.scrape(NOW_ISO);
    expect(result).toBe(null);
  });
  it("stamps the file date for a feature whose producttim is null", async function () {
    const fileDate = Date.UTC(2026, 6, 22, 7, 52, 45);
    installFetch(function (url) {
      if (String(url).indexOf("/MapServer/19/") !== -1) {
        return Promise.resolve(textResponse(layerJson([
          feature("Lucas Area Beaches", "Low", "1 to 3 feet.", undefined,
            { producttim: null, idp_filedate: fileDate })
        ])));
      }
      return Promise.reject(new Error("layer 7 down"));
    });
    const result = await nwsMarineBeachForecast.scrape(NOW_ISO);
    expect(result.sites.length).toBe(1);
    expect(result.sites[0].siteId).toBe("cle-lucas");
    expect(result.sites[0].updated).toBe("2026-07-22T07:52:45.000Z");
    expect(result.updated).toBe(NOW_ISO);
  });

  it("returns null when every feature classifies but none carries an issuance", async function () {
    installFetch(function () {
      return Promise.resolve(textResponse(layerJson([
        feature("Lucas Area Beaches", "Low", "1 to 3 feet.", undefined,
          { producttim: null, idp_filedate: null })
      ])));
    });
    expect(await nwsMarineBeachForecast.scrape(NOW_ISO)).toBe(null);
  });

  it("carries the issuance on every site of a live layer", async function () {
    installFetch(function (url) {
      if (String(url).indexOf("/MapServer/19/") !== -1) {
        return Promise.resolve(textResponse(layerJson([
          feature("Lucas Area Beaches", "Low", "1 to 3 feet."),
          feature("Cuyahoga Area Beaches", "High", "3 to 5 feet.")
        ])));
      }
      return Promise.resolve(textResponse(layerJson([
        feature("Monroe Area Beaches", "High", "3 to 6 feet.", undefined, { producttim: "500 AM EDT" })
      ])));
    });
    const result = await nwsMarineBeachForecast.scrape(NOW_ISO);
    const byId = Object.create(null);
    for (let i = 0; i < result.sites.length; i++) {
      byId[result.sites[i].siteId] = result.sites[i];
    }
    expect(byId["cle-lucas"].updated).toBe(ISSUED_ISO);
    expect(byId["cle-cuyahoga"].updated).toBe(ISSUED_ISO);
    expect(byId["buf-monroe"].updated).toBe("2026-07-22T09:00:00.000Z");
  });
});

describe("nwsMarineBeachForecast scraper object", function () {
  it("declares the forecast kind, the 30 h horizon and the issuance note", function () {
    expect(nwsMarineBeachForecast.kind).toBe("forecast");
    expect(nwsMarineBeachForecast.staleMs).toBe(30 * 60 * 60 * 1000);
    expect(nwsMarineBeachForecast.readingNote).toBe("Forecast issued");
    expect("officialMaxAgeMs" in nwsMarineBeachForecast).toBe(false);
  });
});

describe("SITE_DEFS integrity", function () {
  it("has unique siteIds and well-formed centroids", function () {
    const seen = Object.create(null);
    for (let i = 0; i < SITE_DEFS.length; i++) {
      const def = SITE_DEFS[i];
      expect(seen[def.siteId]).toBe(undefined);
      seen[def.siteId] = true;
      expect(typeof def.lat).toBe("number");
      expect(typeof def.lon).toBe("number");
      expect(typeof def.radiusMi).toBe("number");
      expect(Array.isArray(def.names)).toBe(true);
      expect(def.layer === 19 || def.layer === 7).toBe(true);
    }
  });
});
