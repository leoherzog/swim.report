// test/nwsMarineBeachForecast.test.js
// Unit tests for the NWS Marine Beach Forecast official HAZARD scraper. All
// pure parsers are exercised against inline fixtures (no network); the scrape()
// path is exercised with a stubbed globalThis.fetch. Project style: ES modules,
// NO template literals (string concat with +), function () {} callbacks.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  normalizeRipColor,
  parseSurfFeet,
  surfColor,
  colorFromConditions,
  productDateMs,
  isFreshProduct,
  parseLayerZones,
  buildSites,
  layerQueryUrl,
  nwsMarineBeachForecast,
  SITE_DEFS,
  STALE_MAX_DAYS,
  NWS_MARINE_BEACH_MAP_URL
} from "../src/officialSources/nwsMarineBeachForecast.js";
import { resolveSiteForBeach, scrapeOfficialFlagFromResult } from "../src/officialSources/index.js";
import { perBeachResult } from "../src/officialSources/util.js";
import { installFetch } from "./helpers/fetch.js";
import { makeBeach } from "./helpers/beach.js";

const NOW_ISO = "2026-07-22T12:00:00Z";

// Build one layer's Esri-JSON query response from attribute objects.
function layerJson(attrList) {
  const features = [];
  for (let i = 0; i < attrList.length; i++) {
    features.push({ attributes: attrList[i] });
  }
  return JSON.stringify({ features: features });
}

// A fresh Day-1 feature attribute object with sensible defaults.
function feature(beachname, rip, surf, productdat) {
  return {
    beachname: beachname,
    rip: rip,
    surf: surf,
    productdat: productdat === undefined ? "7/22/2026" : productdat,
    producttim: "346 AM EDT"
  };
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
      color: "yellow"
    });
    expect(zones["cuyahoga area beaches"].color).toBe("red");
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

describe("buildSites", function () {
  it("emits a contract-v2 site for each live curated zone", function () {
    const byLayer = new Map();
    byLayer.set(19, {
      "lucas area beaches": { beachname: "Lucas Area Beaches", color: "yellow" }
    });
    const sites = buildSites(byLayer);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("cle-lucas");
    expect(sites[0].color).toBe("yellow");
    expect(sites[0].names).toContain("maumee bay");
    expect(typeof sites[0].lat).toBe("number");
    expect(sites[0].reason).toContain("Lucas Area Beaches");
  });

  it("ignores zones with no live color and guards a bad map", function () {
    const byLayer = new Map();
    byLayer.set(19, { "unknown zone": { beachname: "Unknown", color: "red" } });
    expect(buildSites(byLayer)).toEqual([]);
    expect(buildSites(null)).toEqual([]);
  });

  it("keeps the two same-named 'Northern Erie' zones DISTINCT by layer", function () {
    const byLayer = new Map();
    byLayer.set(19, {
      "northern erie area beaches": { beachname: "Northern Erie Area Beaches", color: "red" }
    });
    byLayer.set(7, {
      "northern erie area beaches": { beachname: "Northern Erie Area Beaches", color: "green" }
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
      "lucas area beaches": { beachname: "Lucas Area Beaches", color: "yellow" }
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
      "monroe area beaches": { beachname: "Monroe Area Beaches", color: "red" }
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
      "lucas area beaches": { beachname: "Lucas Area Beaches", color: "yellow" }
    });
    const result = resultFor(byLayer);
    // Far from any centroid, no matching name -> null (never a guessed color).
    const beach = makeBeach({ id: "osm-3", name: "Random Beach", lat: 43.9, lon: -76.18 });
    // (43.9,-76.18 is the Jefferson centroid, but that zone has no live color here.)
    expect(scrapeOfficialFlagFromResult(beach, nwsMarineBeachForecast, result)).toBe(null);
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
