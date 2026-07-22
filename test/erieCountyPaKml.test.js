// test/erieCountyPaKml.test.js
// Unit tests for the Erie County (PA) Presque Isle water-quality FLOOR source
// (src/wqFloor/erieCountyPaKml.js). Pure-parser + classifier tests use inline
// KML fixtures (no network). scrape() tests lock the fail-closed contract
// (the KML export URL ships unconfirmed/empty, so scrape must never fetch).
//
// Project style: ES modules, NO template literals, string concat with +,
// function () {} callbacks. This is a RAISE-ONLY floor: the parser must never
// emit green/double-red/unknown, and a clean/open reading must produce NO site.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  parseErieCountyPaKml,
  classifyErieStatus,
  erieCountyPaKml,
  ERIE_COUNTY_PA_LABEL,
  ERIE_COUNTY_PA_INFO_URL,
  ERIE_COUNTY_PA_KML_URL
} from "../src/wqFloor/erieCountyPaKml.js";
import { scrapeWqFloorFromResult } from "../src/wqFloor/index.js";
import { installFetch } from "./helpers/fetch.js";
import { makeBeach } from "./helpers/beach.js";

const NOW_ISO = "2026-07-22T12:00:00.000Z";

// Inline KML fixture builder. Each entry is [name, description, "lon,lat"].
// Omit description/coords by passing null. A leading title placemark with no
// point/description mirrors the map's own title marker.
function buildPlacemark(name, description, coords) {
  let block = "<Placemark>";
  if (name !== null) {
    block = block + "<name>" + name + "</name>";
  }
  if (description !== null) {
    block = block + "<description><![CDATA[" + description + "]]></description>";
  }
  if (coords !== null) {
    block = block + "<Point><coordinates>" + coords + ",0</coordinates></Point>";
  }
  return block + "</Placemark>";
}

function buildKml(placemarks) {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
    "<kml xmlns=\"http://www.opengis.net/kml/2.2\"><Document>" +
    "<name>ECDH Presque Isle Beach Monitoring</name>" +
    placemarks.join("") +
    "</Document></kml>";
}

describe("classifyErieStatus", function () {
  it("maps an explicit closure to red", function () {
    expect(classifyErieStatus("Swimming is not permitted until water quality improves."))
      .toBe("red");
  });

  it("maps 'prohibited' and 'do not swim' to red", function () {
    expect(classifyErieStatus("Swimming prohibited.")).toBe("red");
    expect(classifyErieStatus("High bacteria - do not swim.")).toBe("red");
  });

  it("maps a HAB toxin exceedance to red", function () {
    expect(classifyErieStatus("Microcystin exceeds the recreational threshold."))
      .toBe("red");
  });

  it("maps an advisory / precaution to yellow", function () {
    expect(classifyErieStatus("Swimming advisory in effect. Use caution.")).toBe("yellow");
    expect(classifyErieStatus("Precautionary advisory - risk-reduction guidance.")).toBe("yellow");
    expect(classifyErieStatus("Elevated bacteria levels.")).toBe("yellow");
  });

  // --- Safety: clean readings and negations must NEVER produce a color. ---
  it("returns null for an open / permitted beach", function () {
    expect(classifyErieStatus("Beach is open to swimming. Swimming permitted."))
      .toBe(null);
  });

  it("does not false-red on 'does not exceed' (negated exceedance)", function () {
    expect(classifyErieStatus("Toxin levels do not exceed the threshold. Beach open."))
      .toBe(null);
  });

  it("does not false-red on 'not closed'", function () {
    expect(classifyErieStatus("The beach is not closed; open to swimming."))
      .toBe(null);
  });

  it("does not false-yellow on a lifted / no advisory (cleared) reading", function () {
    expect(classifyErieStatus("No swimming advisory in effect. Open.")).toBe(null);
    expect(classifyErieStatus("The swimming advisory has been lifted.")).toBe(null);
    expect(classifyErieStatus("No advisory at this time.")).toBe(null);
  });

  it("returns null for empty, null, and unrelated descriptions", function () {
    expect(classifyErieStatus("")).toBe(null);
    expect(classifyErieStatus(null)).toBe(null);
    expect(classifyErieStatus(undefined)).toBe(null);
    expect(classifyErieStatus("Water temperature is 68 degrees.")).toBe(null);
  });

  it("never returns green, double-red, or unknown", function () {
    const inputs = [
      "Swimming is not permitted.",
      "Advisory in effect.",
      "Open to swimming.",
      "Double red flag posted.",
      "Green flag today."
    ];
    for (let i = 0; i < inputs.length; i++) {
      const result = classifyErieStatus(inputs[i]);
      expect(result === "red" || result === "yellow" || result === null).toBe(true);
    }
  });
});

describe("parseErieCountyPaKml", function () {
  it("emits floor sites only for advisory/closure placemarks, omitting open ones", function () {
    const kml = buildKml([
      buildPlacemark("Beach 6", "Swimming is not permitted until water quality improves.", "-80.115,42.158"),
      buildPlacemark("Beach 8", "Swimming advisory in effect. Use caution.", "-80.100,42.160"),
      buildPlacemark("Beach 10", "Beach is open to swimming.", "-80.090,42.162")
    ]);
    const sites = parseErieCountyPaKml(kml, NOW_ISO);
    expect(sites).not.toBe(null);
    expect(sites.length).toBe(2);

    const bySiteId = {};
    for (let i = 0; i < sites.length; i++) {
      bySiteId[sites[i].siteId] = sites[i];
    }
    expect(bySiteId["beach-6"].floorColor).toBe("red");
    expect(bySiteId["beach-8"].floorColor).toBe("yellow");
    // Open beach produced no site (absence == no floor).
    expect(bySiteId["beach-10"]).toBe(undefined);
  });

  it("carries lat/lon + radius but NO names[] for numeric beaches (substring-collision guard)", function () {
    const kml = buildKml([
      buildPlacemark("Beach 1", "Swimming is not permitted.", "-80.130,42.150"),
      buildPlacemark("Beach 10", "Swimming advisory in effect.", "-80.090,42.162")
    ]);
    const sites = parseErieCountyPaKml(kml, NOW_ISO);
    const bySiteId = {};
    for (let i = 0; i < sites.length; i++) {
      bySiteId[sites[i].siteId] = sites[i];
    }
    // "beach 1" is a substring of "beach 10"; numeric names must be omitted so
    // resolution falls to proximity (nearest wins), never a wrong sibling.
    expect(bySiteId["beach-1"].names).toBe(undefined);
    expect(bySiteId["beach-10"].names).toBe(undefined);
    expect(typeof bySiteId["beach-1"].lat).toBe("number");
    expect(typeof bySiteId["beach-1"].lon).toBe("number");
    expect(bySiteId["beach-1"].radiusMi).toBe(0.75);
  });

  it("carries names[] for a distinctively-named beach", function () {
    const kml = buildKml([
      buildPlacemark("Barracks Beach", "Swimming advisory in effect.", "-80.080,42.155")
    ]);
    const sites = parseErieCountyPaKml(kml, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].names).toEqual(["barracks beach"]);
  });

  it("labels a HAB reason distinctly from a bacteria closure", function () {
    const kml = buildKml([
      buildPlacemark("Mill Road Beach", "Harmful algal bloom: microcystin exceeds threshold. Swimming not permitted.", "-80.070,42.153")
    ]);
    const sites = parseErieCountyPaKml(kml, NOW_ISO);
    expect(sites[0].floorColor).toBe("red");
    expect(sites[0].reason.indexOf("harmful algal bloom")).not.toBe(-1);
  });

  it("stamps the passed-in nowIso as the site updated timestamp", function () {
    const kml = buildKml([
      buildPlacemark("Beach 6", "Swimming is not permitted.", "-80.115,42.158")
    ]);
    const sites = parseErieCountyPaKml(kml, NOW_ISO);
    expect(sites[0].updated).toBe(NOW_ISO);
  });

  it("omits a flagged placemark with an out-of-region coordinate and no distinctive name", function () {
    // Numeric name (no names[]) + coordinate far outside the Erie box: cannot be
    // bound, so it is dropped rather than guessed.
    const kml = buildKml([
      buildPlacemark("Beach 6", "Swimming is not permitted.", "-95.000,30.000")
    ]);
    const sites = parseErieCountyPaKml(kml, NOW_ISO);
    expect(sites).toEqual([]);
  });

  it("keeps a distinctively-named flagged placemark even without a usable coordinate", function () {
    const kml = buildKml([
      buildPlacemark("Barracks Beach", "Swimming advisory in effect.", "-95.000,30.000")
    ]);
    const sites = parseErieCountyPaKml(kml, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].names).toEqual(["barracks beach"]);
    expect(sites[0].lat).toBe(undefined);
    expect(sites[0].lon).toBe(undefined);
  });

  it("ignores a title/legend placemark with no point or advisory description", function () {
    const kml = buildKml([
      buildPlacemark("Presque Isle Beaches", null, null),
      buildPlacemark("Beach 6", "Swimming is not permitted.", "-80.115,42.158")
    ]);
    const sites = parseErieCountyPaKml(kml, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("beach-6");
  });

  it("returns an empty array for a clean map (every beach open)", function () {
    const kml = buildKml([
      buildPlacemark("Beach 6", "Open to swimming.", "-80.115,42.158"),
      buildPlacemark("Beach 8", "Beach is open to swimming.", "-80.100,42.160")
    ]);
    expect(parseErieCountyPaKml(kml, NOW_ISO)).toEqual([]);
  });

  it("one unparseable placemark does not discard the others", function () {
    const kml = buildKml([
      buildPlacemark(null, null, null),
      buildPlacemark("Beach 6", "Swimming is not permitted.", "-80.115,42.158")
    ]);
    const sites = parseErieCountyPaKml(kml, NOW_ISO);
    expect(sites.length).toBe(1);
    expect(sites[0].siteId).toBe("beach-6");
  });

  it("returns null for non-KML / garbage / empty input (fail closed)", function () {
    expect(parseErieCountyPaKml("<html><body>hello</body></html>", NOW_ISO)).toBe(null);
    expect(parseErieCountyPaKml("", NOW_ISO)).toBe(null);
    expect(parseErieCountyPaKml(null, NOW_ISO)).toBe(null);
    expect(parseErieCountyPaKml("{\"json\":true}", NOW_ISO)).toBe(null);
  });

  it("never emits an invalid floor color from any placemark", function () {
    const kml = buildKml([
      buildPlacemark("Beach 6", "Swimming is not permitted.", "-80.115,42.158"),
      buildPlacemark("Beach 8", "Advisory in effect.", "-80.100,42.160"),
      buildPlacemark("Beach 10", "Open to swimming.", "-80.090,42.162"),
      buildPlacemark("Beach 11", "Green flag.", "-80.085,42.163")
    ]);
    const sites = parseErieCountyPaKml(kml, NOW_ISO);
    for (let i = 0; i < sites.length; i++) {
      expect(sites[i].floorColor === "yellow" || sites[i].floorColor === "red").toBe(true);
    }
  });
});

describe("erieCountyPaKml site resolution end-to-end", function () {
  it("resolves a numeric beach by proximity and a named beach by name", function () {
    const kml = buildKml([
      buildPlacemark("Beach 6", "Swimming is not permitted.", "-80.115,42.158"),
      buildPlacemark("Barracks Beach", "Swimming advisory in effect.", "-80.080,42.155")
    ]);
    const sites = parseErieCountyPaKml(kml, NOW_ISO);
    const result = {
      perBeach: true,
      sites: sites,
      source: ERIE_COUNTY_PA_LABEL,
      updated: NOW_ISO
    };

    const beach6 = makeBeach({
      id: "osm-b6", name: "Beach 6", park_name: "Presque Isle State Park",
      lat: 42.1581, lon: -80.1149
    });
    const advisory6 = scrapeWqFloorFromResult(beach6, erieCountyPaKml, result);
    expect(advisory6).not.toBe(null);
    expect(advisory6.color).toBe("red");
    expect(advisory6.beachId).toBe("osm-b6");

    const barracks = makeBeach({
      id: "osm-bar", name: "Barracks Beach", park_name: "Presque Isle State Park",
      lat: 42.1552, lon: -80.0803
    });
    const advisoryB = scrapeWqFloorFromResult(barracks, erieCountyPaKml, result);
    expect(advisoryB).not.toBe(null);
    expect(advisoryB.color).toBe("yellow");
  });

  it("does not resolve a far-away beach to any Presque Isle site", function () {
    const kml = buildKml([
      buildPlacemark("Beach 6", "Swimming is not permitted.", "-80.115,42.158")
    ]);
    const sites = parseErieCountyPaKml(kml, NOW_ISO);
    const result = { perBeach: true, sites: sites, source: ERIE_COUNTY_PA_LABEL, updated: NOW_ISO };
    const far = makeBeach({ id: "osm-far", name: "Somewhere Beach", lat: 43.5, lon: -82.5 });
    expect(scrapeWqFloorFromResult(far, erieCountyPaKml, result)).toBe(null);
  });
});

describe("erieCountyPaKml.matches", function () {
  it("matches a beach named Presque Isle", function () {
    expect(erieCountyPaKml.matches(makeBeach({ name: "Presque Isle Beach 6", lat: 0, lon: 0 })))
      .toBe(true);
  });

  it("matches a beach whose park_name is Presque Isle State Park", function () {
    expect(erieCountyPaKml.matches(makeBeach({
      name: "Beach 8", park_name: "Presque Isle State Park", lat: 42.16, lon: -80.10
    }))).toBe(true);
  });

  it("matches a beach inside the Erie, PA lakefront box", function () {
    expect(erieCountyPaKml.matches(makeBeach({ name: "Unnamed", lat: 42.15, lon: -80.10 })))
      .toBe(true);
  });

  it("does not match a beach outside the box with an unrelated name", function () {
    expect(erieCountyPaKml.matches(makeBeach({ name: "South Haven Beach", lat: 42.40, lon: -86.28 })))
      .toBe(false);
  });
});

describe("erieCountyPaKml.scrape (fail-closed until URL confirmed)", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("ships with the KML export URL unconfirmed (empty)", function () {
    expect(ERIE_COUNTY_PA_KML_URL).toBe("");
  });

  it("exposes a confirmed human-readable info URL for the estimate card", function () {
    expect(typeof ERIE_COUNTY_PA_INFO_URL).toBe("string");
    expect(ERIE_COUNTY_PA_INFO_URL.indexOf("eriecountypa.gov")).not.toBe(-1);
    expect(erieCountyPaKml.infoUrl).toBe(ERIE_COUNTY_PA_INFO_URL);
  });

  it("returns null WITHOUT fetching while the URL is unconfirmed", async function () {
    const calls = installFetch(function () {
      return Promise.reject(new Error("network must not be reached"));
    });
    const result = await erieCountyPaKml.scrape(NOW_ISO);
    expect(result).toBe(null);
    // Fail-closed: no upstream request is made at all.
    expect(calls.length).toBe(0);
  });
});
