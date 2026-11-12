// test/structuredData.test.js
// Covers the schema.org JSON-LD each indexable page embeds
// (src/frontend/structuredData.js, through renderShareMeta): the WebSite node,
// the beach page's Beach, WebPage and BreadcrumbList, the docs page's graph, the
// "<" escaping that keeps an OSM name from closing the script, and the rule that
// the graph never states a flag color.

import { describe, it, expect } from "vitest";
import { renderListPage, renderDetailPage, renderErrorPage } from "../src/frontend/render.js";
import { renderApiDocsPage } from "../src/frontend/apiDocs.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

const OPEN = "<script type=\"application/ld+json\">";

// The raw JSON text of the page's one JSON-LD script, or null.
function jsonLdText(html) {
  const start = html.indexOf(OPEN);
  if (start === -1) {
    return null;
  }
  const from = start + OPEN.length;
  return html.slice(from, html.indexOf("</script>", from));
}

function graphOf(html) {
  const doc = JSON.parse(jsonLdText(html));
  expect(doc["@context"]).toBe("https://schema.org");
  return doc["@graph"];
}

function nodeOfType(graph, type) {
  const matches = graph.filter(function (node) { return node["@type"] === type; });
  expect(matches.length).toBe(1);
  return matches[0];
}

function detailHtml(beachExtra, estimate) {
  return renderDetailPage({
    beach: beachWith(beachExtra),
    estimate: estimate === undefined ? {
      color: "yellow",
      reason: "Waves 2.4 ft",
      rules_version: 1,
      official: false,
      sources: [],
      updated: NOW_ISO,
      waveHeightFt: 2.4
    } : estimate,
    official: null,
    waves: null,
    waterTemp: null,
    nowIso: NOW_ISO
  });
}

describe("home page structured data", () => {
  const graph = graphOf(renderListPage({ entries: [] }));

  it("is one WebSite node naming the site", () => {
    expect(graph.length).toBe(1);
    const site = nodeOfType(graph, "WebSite");
    expect(site["@id"]).toBe("https://swim.report/#website");
    expect(site.url).toBe("https://swim.report/");
    expect(site.name).toBe("Swim Report");
    expect(site.inLanguage).toBe("en");
    expect(site.description).toBe(
      "Estimated beach hazard flags for Great Lakes and ocean-coast beaches " +
      "across the United States and Canada.");
  });

  it("sits in the head with the share meta", () => {
    const html = renderListPage({ entries: [] });
    expect(html.indexOf(OPEN)).toBeGreaterThan(html.indexOf("<link rel=\"canonical\""));
    expect(html.indexOf(OPEN)).toBeLessThan(html.indexOf("</head>"));
  });
});

describe("beach page structured data", () => {
  const pageUrl = "https://swim.report/beach/w505668572";

  it("describes the beach as a place with coordinates and its OSM element", () => {
    const beach = nodeOfType(graphOf(detailHtml()), "Beach");
    expect(beach["@id"]).toBe(pageUrl + "#beach");
    expect(beach.url).toBe(pageUrl);
    expect(beach.name).toBe("Ottawa Beach");
    expect(beach.geo).toEqual({ "@type": "GeoCoordinates", latitude: 42.775, longitude: -86.211 });
    expect(beach.hasMap).toBe(
      "https://www.openstreetmap.org/?mlat=42.7750&mlon=-86.2110#map=15/42.7750/-86.2110");
    expect(beach.sameAs).toBe("https://www.openstreetmap.org/way/505668572");
    expect(beach.containedInPlace).toBeUndefined();
  });

  it("rounds coordinates to five decimals", () => {
    const beach = nodeOfType(graphOf(detailHtml({ lat: 42.7751234, lon: -86.2119876 })), "Beach");
    expect(beach.geo.latitude).toBe(42.77512);
    expect(beach.geo.longitude).toBe(-86.21199);
  });

  it("ties the page to the site and the beach", () => {
    const page = nodeOfType(graphOf(detailHtml()), "WebPage");
    expect(page["@id"]).toBe(pageUrl);
    expect(page.name).toBe("Ottawa Beach — Swim Report");
    expect(page.isPartOf).toEqual({ "@id": "https://swim.report/#website" });
    expect(page.about).toEqual({ "@id": pageUrl + "#beach" });
    expect(page.breadcrumb).toEqual({ "@id": pageUrl + "#breadcrumb" });
  });

  it("carries a two-step breadcrumb from the home page", () => {
    const crumbs = nodeOfType(graphOf(detailHtml()), "BreadcrumbList");
    expect(crumbs.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Swim Report", item: "https://swim.report/" },
      { "@type": "ListItem", position: 2, name: "Ottawa Beach", item: pageUrl }
    ]);
  });

  // The heading is park-first, but the place is the beach inside the park.
  it("names the beach itself and the park it sits in", () => {
    const graph = graphOf(detailHtml({ park_name: "Holland State Park" }));
    const beach = nodeOfType(graph, "Beach");
    expect(beach.name).toBe("Ottawa Beach");
    expect(beach.containedInPlace).toEqual({ "@type": "Park", name: "Holland State Park" });
    expect(nodeOfType(graph, "BreadcrumbList").itemListElement[1].name)
      .toBe("Holland State Park");
  });

  it("names no park when the beach carries the park's name", () => {
    const beach = nodeOfType(graphOf(detailHtml({
      name: "Holland State Park", park_name: "Holland State Park"
    })), "Beach");
    expect(beach.name).toBe("Holland State Park");
    expect(beach.containedInPlace).toBeUndefined();
  });

  it("omits geo and the map link rather than placing a beach at 0,0", () => {
    const beach = nodeOfType(graphOf(detailHtml({ lat: null, lon: null })), "Beach");
    expect(beach.geo).toBeUndefined();
    expect(beach.hasMap).toBeUndefined();
  });

  it("omits sameAs for an osm_id outside the stored form", () => {
    const beach = nodeOfType(graphOf(detailHtml({ osm_id: "way/0" })), "Beach");
    expect(beach.sameAs).toBeUndefined();
  });

  it("keeps a hostile name inside the script and intact once parsed", () => {
    const name = "</script><script>alert(1)</script><!--";
    const html = detailHtml({ name: name });
    const text = jsonLdText(html);
    expect(text).not.toContain("<");
    expect(html).not.toContain("</script><script>alert(1)");
    expect(nodeOfType(graphOf(html), "Beach").name).toBe(name);
  });

  // The color and its estimated-or-official wording live only in the
  // description and the page itself.
  it("states no flag color", () => {
    const colors = ["green", "yellow", "red", "double-red", null];
    for (const color of colors) {
      const estimate = color === null ? null : {
        color: color, reason: "x", rules_version: 1, official: false, sources: [],
        updated: NOW_ISO, waveHeightFt: 2.4
      };
      const text = jsonLdText(detailHtml({}, estimate));
      expect(text).not.toMatch(/GREEN|YELLOW|RED|right now|unknown/);
      expect(text).not.toMatch(/"(green|yellow|red|double-red)"/);
    }
  });
});

describe("API docs page structured data", () => {
  const graph = graphOf(renderApiDocsPage({ nowIso: NOW_ISO }));

  it("is the site, the page and a breadcrumb to it", () => {
    nodeOfType(graph, "WebSite");
    const page = nodeOfType(graph, "WebPage");
    expect(page["@id"]).toBe("https://swim.report/api/");
    expect(page.name).toBe("Swim Report API");
    expect(typeof page.description).toBe("string");
    expect(nodeOfType(graph, "BreadcrumbList").itemListElement[1]).toEqual(
      { "@type": "ListItem", position: 2, name: "API", item: "https://swim.report/api/" });
  });
});

describe("error page structured data", () => {
  it("has none", () => {
    expect(jsonLdText(renderErrorPage({ status: 404, message: "Not found" }))).toBeNull();
  });
});
