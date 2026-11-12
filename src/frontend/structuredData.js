// src/frontend/structuredData.js — the schema.org JSON-LD graph each indexable
// page carries in its head, and the serializer that embeds it. Pure: values in,
// plain objects out.
//
// The graph states identity only (the site, the page, the beach and the park it
// sits in), never a flag color: a search feature that lifts a structured value
// out of the page would drop the wording that marks an estimate as estimated.

import { SITE_ORIGIN, SITE_NAME, SITE_DESCRIPTION } from "../site.js";

const WEBSITE_ID = SITE_ORIGIN + "/#website";

// The stored osm_id form; anything else gets no sameAs link.
const OSM_ELEMENT_PATTERN = /^(node|way|relation)\/[1-9][0-9]*$/;

/**
 * The script element embedding a graph of schema.org nodes. Every "<" is
 * written as <, so an OSM name can never close the element or open a
 * comment inside it.
 * @param {Array<object>} nodes
 * @returns {string}
 */
export function renderJsonLdScript(nodes) {
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": nodes });
  return "<script type=\"application/ld+json\">" + json.split("<").join("\\u003c") +
    "</script>";
}

function websiteNode() {
  return {
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    "url": SITE_ORIGIN + "/",
    "name": SITE_NAME,
    "description": SITE_DESCRIPTION,
    "inLanguage": "en"
  };
}

function webPageNode(pageUrl, title, extra) {
  return Object.assign({
    "@type": "WebPage",
    "@id": pageUrl,
    "url": pageUrl,
    "name": title,
    "isPartOf": { "@id": WEBSITE_ID },
    "breadcrumb": { "@id": pageUrl + "#breadcrumb" },
    "inLanguage": "en"
  }, extra);
}

// Home, then this page. Google reads a trail of at least two items.
function breadcrumbNode(pageUrl, name) {
  return {
    "@type": "BreadcrumbList",
    "@id": pageUrl + "#breadcrumb",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": SITE_NAME, "item": SITE_ORIGIN + "/" },
      { "@type": "ListItem", "position": 2, "name": name, "item": pageUrl }
    ]
  };
}

// A coordinate rounded to 5 decimals like the API's, or null. Null is rejected
// before coercion, since Number(null) is 0.
function coordinate(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100000) / 100000 : null;
}

/**
 * The home page's graph: the WebSite node search engines read the site name from.
 * @returns {Array<object>}
 */
export function homeStructuredData() {
  return [websiteNode()];
}

/**
 * A beach page's graph: the site, the page, the Beach it is about and its
 * breadcrumb trail.
 * @param {{path: string, title: string, crumbName: string, name: string,
 *   parkName: ?string, lat: *, lon: *, mapUrl: string, osmId: ?string}} page
 *   name is the beach's own name and parkName the park it sits in, when the two
 *   differ; crumbName is the park-first name the page heading shows
 * @returns {Array<object>}
 */
export function beachStructuredData(page) {
  const pageUrl = SITE_ORIGIN + page.path;
  const beachId = pageUrl + "#beach";
  const beach = { "@type": "Beach", "@id": beachId, "url": pageUrl };
  if (typeof page.name === "string" && page.name.length > 0) {
    beach.name = page.name;
  }
  if (typeof page.parkName === "string" && page.parkName.length > 0) {
    beach.containedInPlace = { "@type": "Park", "name": page.parkName };
  }
  const lat = coordinate(page.lat);
  const lon = coordinate(page.lon);
  if (lat !== null && lon !== null) {
    beach.geo = { "@type": "GeoCoordinates", "latitude": lat, "longitude": lon };
    if (typeof page.mapUrl === "string" && page.mapUrl.length > 0) {
      beach.hasMap = page.mapUrl;
    }
  }
  if (typeof page.osmId === "string" && OSM_ELEMENT_PATTERN.test(page.osmId)) {
    beach.sameAs = "https://www.openstreetmap.org/" + page.osmId;
  }
  return [
    websiteNode(),
    webPageNode(pageUrl, page.title, { "about": { "@id": beachId } }),
    beach,
    breadcrumbNode(pageUrl, page.crumbName)
  ];
}

/**
 * A documentation page's graph: the site, the page and its breadcrumb trail.
 * @param {{path: string, title: string, description: string, crumbName: string}} page
 * @returns {Array<object>}
 */
export function docsStructuredData(page) {
  const pageUrl = SITE_ORIGIN + page.path;
  return [
    websiteNode(),
    webPageNode(pageUrl, page.title, { "description": page.description }),
    breadcrumbNode(pageUrl, page.crumbName)
  ];
}
