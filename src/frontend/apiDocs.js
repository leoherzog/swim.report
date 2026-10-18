// src/frontend/apiDocs.js — the GET /api/ documentation page: one pure renderer,
// data in (nowIso), complete HTML out. No fetch, no Date access, no env.
//
// The chrome (head, theme classes, kit, header, footer with the mandatory
// disclaimer) comes from render.js so this page can never drift from the other
// three. The page is a single contained docs column: no wa-page navigation slot
// (renderPageShell disables the toggle on every page), so the table of contents
// is an in-page nav at the top of main rather than a sidebar, which also keeps
// it readable at phone width.
//
// Every example payload is built as a JS object and serialized with
// JSON.stringify, so each sample is valid JSON by construction, and every code
// block goes through escapeHtml, so a "<" in a Link header example can never
// open a tag. The numbers the prose quotes (the ids cap, the estimate lease, the
// stale threshold, the list cap, the cache policy) are imported from the modules that enforce them.
import {
  escapeHtml,
  renderDocument,
  renderPageShell,
  renderBrandHeader,
  renderFooter
} from "./render.js";
import { IDS_LIST_LIMIT } from "../idsListLimit.js";
import { FLAG_TTL_SECONDS } from "../flagTtl.js";
import { STALE_MS } from "../displayFlag.js";
import { HOME_LIST_LIMIT } from "../beachQueries.js";
import { CACHE_CONTROL_CACHEABLE } from "../cacheControl.js";

const SITE_ORIGIN = "https://swim.report";

// The list cap and the cache policy come from the modules the router and the
// API handlers read them from, so the prose cannot drift from the behavior.
const LIST_LIMIT = HOME_LIST_LIMIT;

const LEASE_HOURS = FLAG_TTL_SECONDS / 3600;
const STALE_HOURS = STALE_MS / 3600000;

// One numeric directive of CACHE_CONTROL_CACHEABLE in seconds, or 0 when the
// policy does not carry it.
function cacheDirectiveSeconds(name) {
  const parts = CACHE_CONTROL_CACHEABLE.split(",");
  for (const part of parts) {
    const d = part.trim();
    if (d.indexOf(name + "=") === 0) {
      const n = Number(d.slice(name.length + 1));
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}

// How old a served response can be, in whole minutes, derived from the policy
// itself: max-age plus stale-while-revalidate normally, max-age plus
// stale-if-error while the origin is failing.
const MAX_AGE_SECONDS = cacheDirectiveSeconds("max-age");
const NORMAL_STALE_MINUTES = Math.round(
  (MAX_AGE_SECONDS + cacheDirectiveSeconds("stale-while-revalidate")) / 60);
const ERROR_STALE_MINUTES = Math.round(
  (MAX_AGE_SECONDS + cacheDirectiveSeconds("stale-if-error")) / 60);

function minutesText(n) {
  return n + (n === 1 ? " minute" : " minutes");
}

const PAGE_TITLE = "Swim Report API";
const PAGE_DESCRIPTION = "Read-only JSON API for swim.report's estimated and " +
  "official beach hazard flags: search, nearby, saved lists, one beach, GeoJSON.";

// The on-page table of contents, in page order. Every id here is rendered as a
// section heading below; test/apiDocs.test.js checks each anchor resolves.
const TOC = [
  { id: "overview", label: "Overview" },
  { id: "quick-start", label: "Quick start" },
  { id: "list-beaches", label: "GET /api/beaches" },
  { id: "one-beach", label: "GET /api/beaches/:beachId" },
  { id: "flag-alias", label: "GET /api/flag/:beachId" },
  { id: "geojson", label: "GET /api/beaches.geojson" },
  { id: "health", label: "GET /health" },
  { id: "display", label: "Reading a flag" },
  { id: "beach-ids", label: "Beach ids" },
  { id: "discovery", label: "Finding the JSON for a page" },
  { id: "caching", label: "Caching and ETags" },
  { id: "cors", label: "CORS" },
  { id: "errors", label: "Errors" },
  { id: "units", label: "Units and coordinates" },
  { id: "freshness", label: "Freshness" },
  { id: "fair-use", label: "Attribution and fair use" }
];

// --- Example data -----------------------------------------------------------
// Plausible, mutually consistent records: Holland State Park is an estimate-
// driven yellow, Tunnel Park carries a posted red official flag.

const HOLLAND_LINKS = { page: "/beach/n123456", api: "/api/beaches/n123456" };
const TUNNEL_LINKS = { page: "/beach/w98765432", api: "/api/beaches/w98765432" };

const EXAMPLE_LIST_RESPONSE = {
  builtAt: "2026-07-04T15:00:03.000Z",
  sort: "distance",
  query: { q: null, near: { lat: 42.7712, lon: -86.2125 }, ids: null },
  hasMore: true,
  beaches: [
    {
      id: "n123456",
      name: "Holland State Park",
      lat: 42.77271,
      lon: -86.21245,
      display: { color: "yellow", source: "estimate", forecast: false },
      distanceMi: 0.1,
      links: HOLLAND_LINKS
    },
    {
      id: "w98765432",
      name: "Tunnel Park",
      lat: 42.82641,
      lon: -86.21533,
      display: { color: "red", source: "official", forecast: false },
      distanceMi: 3.8,
      links: TUNNEL_LINKS
    }
  ]
};

const EXAMPLE_IDS_RESPONSE = {
  builtAt: "2026-07-04T15:00:03.000Z",
  sort: "ids",
  query: { q: null, near: null, ids: ["w98765432", "n123456"] },
  hasMore: false,
  beaches: [
    {
      id: "w98765432",
      name: "Tunnel Park",
      lat: 42.82641,
      lon: -86.21533,
      display: { color: "red", source: "official", forecast: false },
      distanceMi: null,
      links: TUNNEL_LINKS
    },
    {
      id: "n123456",
      name: "Holland State Park",
      lat: 42.77271,
      lon: -86.21245,
      display: { color: "yellow", source: "estimate", forecast: false },
      distanceMi: null,
      links: HOLLAND_LINKS
    }
  ]
};

const EXAMPLE_BEACH_RESPONSE = {
  beachId: "n123456",
  name: "Holland State Park",
  lat: 42.77271,
  lon: -86.21245,
  estimate: {
    beachId: "osm-node-123456",
    color: "yellow",
    reason: "Estimated wave height 2.6 ft (at or above 2 ft)",
    trigger: "wave-height",
    rules_version: "1.9.0",
    official: false,
    waveHeightFt: 2.62,
    alertDetails: [],
    alertsAt: "2026-07-04T15:00:03.000Z",
    ripCurrentRisk: null,
    sources: [
      { label: "NWS Alerts", url: "https://api.weather.gov/alerts/active?zone=MIZ056" },
      { label: "NOAA Great Lakes Wave Model", url: "https://polar.ncep.noaa.gov/waves/" }
    ],
    updated: "2026-07-04T15:00:03.000Z",
    estimateInputs: {
      v: 1,
      alertsResolved: true,
      windSpeedMph: 14.3,
      windGustMph: null,
      waterQualityAdvisory: null,
      signalSources: [
        { label: "NOAA Great Lakes Wave Model", url: "https://polar.ncep.noaa.gov/waves/" }
      ]
    }
  },
  official: null,
  display: { color: "yellow", source: "estimate", forecast: false },
  links: HOLLAND_LINKS
};

const EXAMPLE_GEOJSON_RESPONSE = {
  type: "FeatureCollection",
  builtAt: "2026-07-04T15:00:03.000Z",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-86.21245, 42.77271] },
      properties: { id: "n123456", name: "Holland State Park", flag: "yellow" }
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-86.21533, 42.82641] },
      properties: { id: "w98765432", name: "Tunnel Park", flag: "red" }
    }
  ]
};

function json(value) {
  return JSON.stringify(value, null, 2);
}

// --- Markup helpers ---------------------------------------------------------

function code(text) {
  return "<code>" + escapeHtml(text) + "</code>";
}

// A labelled code block with a copy button. The copy button reads the <pre>'s
// textContent through from=, so it copies the decoded text, not the escaped
// markup. The block id is unique per sample.
function codeBlock(id, label, text, copyLabel) {
  const blockId = "sample-" + id;
  return "<div class=\"wa-stack wa-gap-2xs\">" +
    "<div class=\"wa-split wa-align-items-center\">" +
    "<span class=\"wa-caption-s wa-color-text-quiet\">" + escapeHtml(label) + "</span>" +
    "<wa-copy-button from=\"" + blockId + "\" copy-label=\"" +
    escapeHtml(copyLabel) + "\" success-label=\"Copied\"></wa-copy-button>" +
    "</div>" +
    "<pre id=\"" + blockId + "\"><code>" + escapeHtml(text) + "</code></pre>" +
    "</div>";
}

// A table wrapped in wa-scroller so a wide row scrolls inside its own region
// at phone width instead of widening the page. rows are arrays of HTML cells;
// the first cell of each row is its row header.
function table(caption, headers, rows) {
  const head = headers.map(function (h) {
    return "<th scope=\"col\">" + escapeHtml(h) + "</th>";
  }).join("");
  const body = rows.map(function (cells) {
    const first = "<th scope=\"row\">" + cells[0] + "</th>";
    const rest = cells.slice(1).map(function (c) { return "<td>" + c + "</td>"; }).join("");
    return "<tr>" + first + rest + "</tr>";
  }).join("");
  return "<wa-scroller>" +
    "<table class=\"wa-zebra-rows\">" +
    "<caption class=\"wa-visually-hidden\">" + escapeHtml(caption) + "</caption>" +
    "<thead><tr>" + head + "</tr></thead>" +
    "<tbody>" + body + "</tbody>" +
    "</table>" +
    "</wa-scroller>";
}

function sectionHeading(level, id, html) {
  return "<h" + level + " id=\"" + id + "\">" + html + "</h" + level + ">";
}

function endpointHeading(id, method, path) {
  return sectionHeading(3, id,
    "<span class=\"wa-cluster wa-gap-xs\">" +
    "<wa-badge variant=\"brand\" appearance=\"filled\">" + escapeHtml(method) + "</wa-badge>" +
    code(path) + "</span>");
}

function renderToc() {
  const items = TOC.map(function (entry) {
    return "<li><a href=\"#" + entry.id + "\">" + escapeHtml(entry.label) + "</a></li>";
  }).join("");
  return "<wa-card appearance=\"outlined\">" +
    "<nav aria-labelledby=\"toc-heading\" class=\"wa-stack wa-gap-xs\">" +
    "<h2 id=\"toc-heading\" class=\"wa-heading-s\">On this page</h2>" +
    "<ol>" + items + "</ol>" +
    "</nav>" +
    "</wa-card>";
}

// --- Sections ---------------------------------------------------------------

function renderOverview(nowIso) {
  const rendered = (typeof nowIso === "string" && nowIso.length > 0)
    ? ("<p>This page was rendered at " + code(nowIso) + ".</p>")
    : "";
  return "<section aria-labelledby=\"overview\">" +
    sectionHeading(2, "overview", "Overview") +
    "<p>The Swim Report API serves the same beach hazard flags the site shows, as JSON. " +
    "It is <strong>read-only</strong> and <strong>unauthenticated</strong>: no key, no " +
    "account, only " + code("GET") + " requests. Base URL: " + code(SITE_ORIGIN) + ".</p>" +
    "<wa-callout variant=\"warning\">" +
    "<wa-icon slot=\"icon\" name=\"triangle-exclamation\"></wa-icon>" +
    "<strong>Most flags here are estimates, not the official flag status.</strong> " +
    "A beach may carry a live " + code("estimate") + " computed from NWS and Environment " +
    "Canada alerts, surf-zone rip-current forecasts and wave models (otherwise " +
    code("estimate") + " is " + code("null") + " and " + code("display.color") + " is " +
    code("unknown") + "), and some carry an " +
    code("official") + " record scraped from the beach operator. " +
    code("display.source") + " says which one the shown color came from. If you show these " +
    "colors to people, label estimates as estimates, show " + code("unknown") +
    " as gray (never as green), and remind them to obey posted flags and lifeguards." +
    "</wa-callout>" +
    rendered +
    "</section>";
}

function renderQuickStart() {
  const sample = "curl -s 'https://swim.report/api/beaches?q=holland'\n" +
    "curl -s 'https://swim.report/api/beaches?near=42.7712,-86.2125'\n" +
    "curl -s 'https://swim.report/api/beaches/n123456'";
  return "<section aria-labelledby=\"quick-start\">" +
    sectionHeading(2, "quick-start", "Quick start") +
    "<p>Search by name, sort by distance from a point, or fetch one beach:</p>" +
    codeBlock("quick-start", "Shell", sample, "Copy quick start commands") +
    "</section>";
}

function renderListEndpoint() {
  const params = table("Query parameters for GET /api/beaches",
    ["Parameter", "Format", "Meaning"],
    [
      [code("q"), "text",
        "Case-insensitive substring match on the beach name or its park name. A blank " +
        code("q") + " counts as absent. Combines with " + code("near") + "."],
      [code("near"), code("lat,lon"),
        "Decimal degrees, latitude first, for example " + code("42.7712,-86.2125") +
        ". Sorts the results by distance from that point. Latitude must lie in -90 to 90 " +
        "and longitude in -180 to 180; anything else is a 400."],
      [code("ids"), "comma list",
        "Up to " + escapeHtml(String(IDS_LIST_LIMIT)) + " beach ids, in either id form. " +
        "Duplicates are dropped, ids past the cap are ignored, unknown or non-swimming " +
        "ids are skipped silently, and your order is kept. Cannot be combined with " +
        code("q") + " or " + code("near") + " (400)."]
    ]);

  const modes = table("How GET /api/beaches sorts", ["Request", "sort", "Rows"],
    [
      ["no parameters", code("\"name\""),
        "The first " + LIST_LIMIT + " beaches alphabetically, by park name then beach name."],
      [code("q"), code("\"name\""), "Matches alphabetically, at most " + LIST_LIMIT + "."],
      [code("near"), code("\"distance\""),
        "The nearest " + LIST_LIMIT + " (filtered by " + code("q") + " when given), " +
        "nearest first, each with " + code("distanceMi") + "."],
      [code("ids"), code("\"ids\""),
        "The named beaches in your order, at most " + escapeHtml(String(IDS_LIST_LIMIT)) + "."]
    ]);

  const fields = table("Fields of each beach in a list response", ["Field", "Type", "Meaning"],
    [
      [code("id"), "string", "Public beach id (see <a href=\"#beach-ids\">Beach ids</a>)."],
      [code("name"), "string",
        "Display name: the containing park's name when the beach sits inside a named park, " +
        "otherwise the beach's own name."],
      [code("lat") + ", " + code("lon"), "number", "Decimal degrees (WGS 84)."],
      [code("display"), "object",
        code("color") + ", " + code("source") + ", " + code("forecast") +
        " (see <a href=\"#display\">Reading a flag</a>)."],
      [code("distanceMi"), "number or null",
        "Miles from " + code("near") + ", rounded to 0.1. " + code("null") +
        " unless " + code("sort") + " is " + code("\"distance\"") + "."],
      [code("links"), "object",
        code("page") + " is the beach's HTML page, " + code("api") + " its JSON record."]
    ]);

  return "<section aria-labelledby=\"list-beaches\">" +
    endpointHeading("list-beaches", "GET", "/api/beaches") +
    "<p>A list of beaches with the flag swim.report shows for each: the API form of the " +
    "home page. Results are capped at " + LIST_LIMIT + "; " + code("hasMore") + " is " +
    code("true") + " when more beaches matched than were returned, so narrow the search " +
    "rather than paging. The response depends only on the URL: it never guesses your " +
    "location, so pass " + code("near") + " explicitly.</p>" +
    params +
    modes +
    "<p>Top-level fields: " + code("builtAt") + " (when the freshest live estimate among " +
    "the returned beaches was computed, or " + code("null") + " when none is live), " + code("sort") +
    ", " + code("query") + " (the parameters as understood, with " + code("ids") +
    " normalized to public ids), " + code("hasMore") + " and " + code("beaches") + ".</p>" +
    fields +
    codeBlock("list-request", "Request",
      "curl -s 'https://swim.report/api/beaches?near=42.7712,-86.2125'", "Copy list request") +
    codeBlock("list-response", "Response", json(EXAMPLE_LIST_RESPONSE),
      "Copy list response") +
    codeBlock("ids-request", "Request",
      "curl -s 'https://swim.report/api/beaches?ids=w98765432,n123456'", "Copy ids request") +
    codeBlock("ids-response", "Response", json(EXAMPLE_IDS_RESPONSE),
      "Copy ids response") +
    "<p>An " + code("ids") + " list that names no valid beach is not an error: it answers " +
    "200 with an empty " + code("beaches") + " array.</p>" +
    "</section>";
}

function renderBeachEndpoint() {
  const fields = table("Fields of a single-beach response", ["Field", "Type", "Meaning"],
    [
      [code("beachId"), "string", "Public beach id."],
      [code("name") + ", " + code("lat") + ", " + code("lon"), "string, number",
        "Display name and position, as in the list."],
      [code("estimate"), "object or null",
        "The live estimated flag: " + code("color") + ", " + code("reason") + ", " +
        code("rules_version") + ", " + code("sources") + ", " + code("updated") +
        " and the inputs it was decided from. " + code("official") + " is always " +
        code("false") + " here. " + code("null") + " when no live estimate exists. " +
        "Its " + code("estimateInputs") + " object is the internal record of the " +
        "non-alert inputs the estimate was decided from; its shape is versioned by " +
        code("estimateInputs.v") + " and may change without notice, so do not depend on it."],
      [code("official"), "object or null",
        "The live flag scraped from the beach operator, with " + code("official: true") +
        ", its " + code("source") + " and " + code("updated") + ". " + code("null") +
        " for most beaches."],
      [code("display"), "object", "The flag swim.report shows; see <a href=\"#display\">Reading a flag</a>."],
      [code("links"), "object", code("page") + " and " + code("api") + " URLs."]
    ]);
  return "<section aria-labelledby=\"one-beach\">" +
    endpointHeading("one-beach", "GET", "/api/beaches/:beachId") +
    "<p>One beach, with both of its stored records in full. The nested " +
    code("estimate.beachId") + " is the internal storage id; use the top-level " +
    code("beachId") + ".</p>" +
    fields +
    codeBlock("beach-request", "Request", "curl -s 'https://swim.report/api/beaches/n123456'",
      "Copy single-beach request") +
    codeBlock("beach-response", "Response", json(EXAMPLE_BEACH_RESPONSE),
      "Copy single-beach response") +
    "<p>An unknown id, a malformed one, or a beach that is not on swimmable open water " +
    "answers 404 with " + code("{\"error\":\"beach not found\"}") + ".</p>" +
    "</section>";
}

function renderFlagAlias() {
  return "<section aria-labelledby=\"flag-alias\">" +
    endpointHeading("flag-alias", "GET", "/api/flag/:beachId") +
    "<p>The original single-beach endpoint, kept as an alias. It returns exactly the same " +
    "body as " + code("/api/beaches/:beachId") + " and will keep working; new code should " +
    "use " + code("/api/beaches/:beachId") + ".</p>" +
    "</section>";
}

function renderGeojsonEndpoint() {
  return "<section aria-labelledby=\"geojson\">" +
    endpointHeading("geojson", "GET", "/api/beaches.geojson") +
    "<p>Every beach as one RFC 7946 " + code("FeatureCollection") + " (" +
    code("application/geo+json") + "), the data behind the home page map. Each feature's " +
    code("properties") + " carry " + code("id") + ", " + code("name") + " and " +
    code("flag") + ", a map keyword: " + code("green") + ", " + code("yellow") + ", " +
    code("red") + " or " + code("unknown") + ", with double red folded into " +
    code("red") + ". Fetch a beach's own record when you need the distinction. The " +
    "top-level " + code("builtAt") + " is the newest live estimate on the map, so a stalled " +
    "update is visible at a glance.</p>" +
    "<p>The body is large; send " + code("If-None-Match") + " (see " +
    "<a href=\"#caching\">Caching</a>) rather than downloading it again.</p>" +
    codeBlock("geojson-response", "Response (two features shown)",
      json(EXAMPLE_GEOJSON_RESPONSE), "Copy GeoJSON response") +
    "</section>";
}

function renderHealthEndpoint() {
  return "<section aria-labelledby=\"health\">" +
    endpointHeading("health", "GET", "/health") +
    "<p>A liveness check that touches no data: " + code("{\"ok\":true}") + ", never cached.</p>" +
    "</section>";
}

function renderDisplaySection() {
  const colors = table("display.color values", ["color", "Meaning"],
    [
      [code("green"), "Low hazard estimated or posted."],
      [code("yellow"), "Moderate hazard: use caution."],
      [code("red"), "High hazard: dangerous surf or currents."],
      [code("double-red"), "Water closed to the public."],
      [code("unknown"), "No usable data. Render it gray and neutral; never as green."]
    ]);
  const sources = table("display.source values", ["source", "Meaning"],
    [
      [code("official"), "The color is the beach operator's own flag, read from their site."],
      [code("estimate"), "The color is swim.report's estimate. It is <strong>not</strong> an official flag."],
      [code("none"), "No record supplies a color: neither record is live, or the live " +
        "estimate is itself " + code("unknown") + " (no alerts and no wave or wind data). " +
        "The color is " + code("unknown") + ", and " + code("estimate") + " may still be an object."]
    ]);
  return "<section aria-labelledby=\"display\">" +
    sectionHeading(2, "display", "Reading a flag") +
    "<p>" + code("display") + " is the one flag swim.report shows for a beach, decided " +
    "the same way for every page, the map and the API, so you never need to choose between " +
    code("estimate") + " and " + code("official") + " yourself.</p>" +
    colors +
    sources +
    "<p>" + code("display.forecast") + " is " + code("true") + " only when the credited " +
    "official record is the operator's forecast for the day rather than a flag raised on " +
    "the beach. Say \"forecast\" when you show it. A forecast can raise the shown flag above " +
    "the estimate but never lower it.</p>" +
    "<p>An official record older than " + STALE_HOURS + " hours is credited only while it " +
    "is strictly more severe than the estimate; otherwise the estimate is shown.</p>" +
    "</section>";
}

function renderIdsSection() {
  return "<section aria-labelledby=\"beach-ids\">" +
    sectionHeading(2, "beach-ids", "Beach ids") +
    "<p>A beach's public id is its OpenStreetMap element type letter (" + code("n") +
    " node, " + code("w") + " way, " + code("r") + " relation) followed by the OSM id, for " +
    "example " + code("n123456") + ". It is stable for as long as the OSM element exists.</p>" +
    "<p>The internal storage form, " + code("osm-node-123456") + ", is accepted everywhere: " +
    "the single-beach endpoints answer it with a 301 to the public id, and " + code("ids") +
    " accepts either form and reports public ids back.</p>" +
    "</section>";
}

function renderDiscoverySection() {
  const sample = "curl -s -o /dev/null -D - 'https://swim.report/?q=holland'\n" +
    "HTTP/2 200\n" +
    "content-type: text/html; charset=utf-8\n" +
    "link: </api/beaches?q=holland>; rel=\"alternate\"; type=\"application/json\"";
  return "<section aria-labelledby=\"discovery\">" +
    sectionHeading(2, "discovery", "Finding the JSON for a page") +
    "<p>Every list and beach page names its JSON twin twice: an HTML " +
    code("<link rel=\"alternate\" type=\"application/json\">") + " in its head and the same " +
    "link as an HTTP " + code("Link") + " header. A list page's alternate carries the " +
    code("q") + ", " + code("near") + " or " + code("ids") + " its own URL had.</p>" +
    codeBlock("discovery", "Shell", sample, "Copy discovery command") +
    "<p>A beach page URL also works with " + code(".json") + " appended: " +
    code("/beach/n123456.json") + " redirects (301) to " + code("/api/beaches/n123456") +
    ". Pages are never content-negotiated on " + code("Accept") + ": a page URL always " +
    "returns HTML, so caches and the browser's back button never mix the two up.</p>" +
    "</section>";
}

function renderCachingSection() {
  const sample = "curl -s -o /dev/null -D - 'https://swim.report/api/beaches.geojson'\n" +
    "# note the etag, then:\n" +
    "curl -s -o /dev/null -w '%{http_code}\\n' \\\n" +
    "  -H 'If-None-Match: \"3q2-7w\"' 'https://swim.report/api/beaches.geojson'\n" +
    "304";
  return "<section aria-labelledby=\"caching\">" +
    sectionHeading(2, "caching", "Caching and ETags") +
    "<p>Successful responses send " + code("Cache-Control: " + CACHE_CONTROL_CACHEABLE) +
    ": a response is normally up to about " + minutesText(NORMAL_STALE_MINUTES) + " old, " +
    "and up to about " + minutesText(ERROR_STALE_MINUTES) + " while the service is failing " +
    "(" + code("stale-if-error") + "). Polling more than once every " +
    MAX_AGE_SECONDS + " seconds returns the same bytes.</p>" +
    "<p>Every JSON endpoint sends a strong " + code("ETag") + " computed from the response " +
    "body. Send it back as " + code("If-None-Match") + " and an unchanged body answers " +
    code("304 Not Modified") + " with no body. No body contains the time of the request, so " +
    "the tag changes exactly when the data you would receive does: a new reading, but also " +
    "a record expiring or an official flag going stale, which no stored timestamp records. " +
    "That is why there is no " + code("Last-Modified") + " header to revalidate against.</p>" +
    "<p>Every route also answers " + code("HEAD") + " with the headers " + code("GET") +
    " would send, " + code("ETag") + " included, and no body.</p>" +
    codeBlock("caching", "Shell", sample, "Copy caching commands") +
    "</section>";
}

function renderCorsSection() {
  return "<section aria-labelledby=\"cors\">" +
    sectionHeading(2, "cors", "CORS") +
    "<p>Every " + code("/api/") + " response sends " + code("Access-Control-Allow-Origin: *") +
    " and exposes the " + code("ETag") + " and " + code("Link") + " headers, so a web page on " +
    "any origin can call the API with " + code("fetch()") + ". A preflight " +
    code("OPTIONS") + " request answers 204, allowing " + code("GET") + ", " + code("HEAD") + " and the " +
    code("If-None-Match") + " and " + code("Accept") + " request headers, cached for a day. " +
    "No credentials are needed or accepted.</p>" +
    codeBlock("cors", "JavaScript",
      "const res = await fetch(\"https://swim.report/api/beaches/n123456\");\n" +
      "const beach = await res.json();\n" +
      "console.log(beach.display.color, beach.display.source);", "Copy CORS example") +
    "</section>";
}

function renderErrorsSection() {
  const errors = table("Error responses", ["Status", "When", "Body"],
    [
      ["301", "A storage-form id, or a " + code(".json") + " page URL.",
        "None; follow " + code("Location") + "."],
      ["304", "Your " + code("If-None-Match") + " matches.", "None."],
      ["400", "Invalid " + code("near") + ", or " + code("ids") + " combined with " +
        code("q") + " or " + code("near") + ".",
        code("{\"error\":\"<message>\"}") + ", not cached."],
      ["404", "Unknown, malformed or non-swimming beach id.",
        code("{\"error\":\"beach not found\"}") + ", cached 60 s."],
      ["404", "Any other path under " + code("/api/") + ".",
        code("{\"error\":\"not found\"}") + ", not cached."],
      ["405", "A method other than " + code("GET") + " or " + code("HEAD") + " (or " +
        code("OPTIONS") + " on " + code("/api/") + ").", "Plain text."],
      ["500", "The database could not be read.", "Not cached. Retry later."]
    ]);
  return "<section aria-labelledby=\"errors\">" +
    sectionHeading(2, "errors", "Errors") +
    "<p>Errors are JSON with a single human-readable " + code("error") + " string. Match " +
    "on the status code, not the message text.</p>" +
    errors +
    "</section>";
}

function renderUnitsSection() {
  return "<section aria-labelledby=\"units\">" +
    sectionHeading(2, "units", "Units and coordinates") +
    "<ul>" +
    "<li>Positions are WGS 84 decimal degrees. JSON objects use named " + code("lat") +
    " and " + code("lon") + " fields; GeoJSON geometry is " + code("[lon, lat]") +
    ", longitude first, per RFC 7946.</li>" +
    "<li>Distances (" + code("distanceMi") + ") are statute miles.</li>" +
    "<li>Wave heights are feet and wind speeds miles per hour.</li>" +
    "<li>Timestamps are ISO 8601 in UTC.</li>" +
    "</ul>" +
    "</section>";
}

function renderFreshnessSection() {
  return "<section aria-labelledby=\"freshness\">" +
    sectionHeading(2, "freshness", "Freshness") +
    "<p>Estimates are recomputed every hour, and re-checked against new weather alerts " +
    "every ten minutes. Each record carries its own lease: an estimate expires " +
    LEASE_HOURS + " hours after it was written, and an expired record is returned as " +
    code("null") + " rather than as an old color. When nothing live remains the shown " +
    "flag is " + code("unknown") + ".</p>" +
    "<p>Use each record's " + code("updated") + " to judge its age yourself; the site " +
    "warns when an official record is more than " + STALE_HOURS + " hours old.</p>" +
    "</section>";
}

function renderFairUseSection() {
  return "<section aria-labelledby=\"fair-use\">" +
    sectionHeading(2, "fair-use", "Attribution and fair use") +
    "<ul>" +
    "<li>Credit swim.report and link to the beach's " + code("links.page") +
    " where you show a flag.</li>" +
    "<li>Beach locations come from OpenStreetMap: show \"© OpenStreetMap contributors\" " +
    "(ODbL). Weather and marine data come from NOAA/NWS and Environment and Climate " +
    "Change Canada.</li>" +
    "<li>Never present an estimate as an official flag, and tell people to obey posted " +
    "flags and lifeguards.</li>" +
    "<li>Cache responses and use " + code("If-None-Match") + "; there is no point " +
    "polling faster than once a minute.</li>" +
    "<li>There is no key, quota or SLA. Fields may be added without notice; existing " +
    "fields will not change meaning.</li>" +
    "</ul>" +
    "</section>";
}

/**
 * The complete /api/ documentation page.
 * @param {{nowIso: string}} data the render instant, passed in so the renderer
 *   reads no clock
 * @returns {string} a complete HTML document
 */
export function renderApiDocsPage(data) {
  const nowIso = data && typeof data.nowIso === "string" ? data.nowIso : null;
  const mainHtml = "<article class=\"wa-prose api-docs\">" +
    "<h1>Swim Report API</h1>" +
    "<p class=\"wa-body-l wa-color-text-quiet\">Estimated and official beach hazard flags " +
    "for Great Lakes and ocean-coast beaches in the United States and Canada, as JSON.</p>" +
    renderToc() +
    renderOverview(nowIso) +
    renderQuickStart() +
    "<section aria-labelledby=\"endpoints-heading\">" +
    "<h2 id=\"endpoints-heading\">Endpoints</h2>" +
    renderListEndpoint() +
    renderBeachEndpoint() +
    renderFlagAlias() +
    renderGeojsonEndpoint() +
    renderHealthEndpoint() +
    "</section>" +
    renderDisplaySection() +
    renderIdsSection() +
    renderDiscoverySection() +
    renderCachingSection() +
    renderCorsSection() +
    renderErrorsSection() +
    renderUnitsSection() +
    renderFreshnessSection() +
    renderFairUseSection() +
    "</article>";
  const bodyHtml = renderPageShell(renderBrandHeader(), mainHtml, renderFooter(), "api-docs-main");
  return renderDocument(PAGE_TITLE, bodyHtml, {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    path: "/api/",
    flagColor: "unknown"
  });
}
