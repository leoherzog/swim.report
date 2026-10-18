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
// The reference half (endpoints, parameters, responses, schemas, examples) is
// rendered from buildOpenApiDocument(), so the page and /api/openapi.json are one
// source of truth; the guide half is hand-written. Every code block goes through
// escapeHtml, so a "<" in a Link header example can never open a tag, and the
// numbers the guide prose quotes (the estimate lease, the stale threshold, the
// cache policy) are imported from the modules that enforce them.
import {
  escapeHtml,
  renderDocument,
  renderPageShell,
  renderBrandHeader,
  renderFooter
} from "./render.js";
import { FLAG_TTL_SECONDS } from "../flagTtl.js";
import { STALE_MS } from "../displayFlag.js";
import { CACHE_CONTROL_CACHEABLE } from "../cacheControl.js";
import { OPENAPI_PATH, buildOpenApiDocument } from "../openapi.js";

const SITE_ORIGIN = "https://swim.report";

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

// The on-page table of contents, in page order: the hand-written guide sections
// around the endpoints and schemas generated from the OpenAPI document. Every id
// here is rendered as a section heading; test/apiDocs.test.js checks each anchor
// resolves.
function tocEntries(spec) {
  const endpoints = operationsOf(spec).map(function (entry) {
    return { id: entry.op.operationId, label: entry.method + " " + entry.path };
  });
  return [
    { id: "overview", label: "Overview" },
    { id: "quick-start", label: "Quick start" }
  ].concat(endpoints).concat([
    { id: "schemas", label: "Schemas" },
    { id: "openapi", label: "OpenAPI" },
    { id: "display", label: "Reading a flag" },
    { id: "beach-ids", label: "Beach ids" },
    { id: "discovery", label: "Finding the JSON for a page" },
    { id: "caching", label: "Caching and ETags" },
    { id: "cors", label: "CORS" },
    { id: "errors", label: "Errors" },
    { id: "units", label: "Units and coordinates" },
    { id: "freshness", label: "Freshness" },
    { id: "fair-use", label: "Attribution and fair use" }
  ]);
}

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

function renderToc(spec) {
  const items = tocEntries(spec).map(function (entry) {
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
    "account, only " + code("GET") + " (and " + code("HEAD") + ") requests. Base URL: " + code(SITE_ORIGIN) + ".</p>" +
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

// --- Reference sections, generated from the OpenAPI document ---------------
// Every endpoint, parameter, response, field and example below is read from
// buildOpenApiDocument(), the document test/openapi.test.js holds to the real
// responses, so the reference half of this page cannot drift from the API. The
// guide sections further down stay hand-written.

const SCHEMA_PREFIX = "#/components/schemas/";

function schemaAnchor(name) {
  return "schema-" + name;
}

// A component schema or response named by a $ref, or the value itself.
function deref(spec, value) {
  if (!value || typeof value.$ref !== "string") {
    return value;
  }
  const parts = value.$ref.slice(2).split("/");
  let node = spec;
  for (const part of parts) {
    node = node ? node[part] : undefined;
  }
  return node || {};
}

// The type of a schema as HTML: component names link to their table below,
// nullable fields read "X or null", arrays "array of X".
function typeHtml(schema) {
  if (!schema) {
    return "";
  }
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.slice(SCHEMA_PREFIX.length);
    return "<a href=\"#" + schemaAnchor(name) + "\">" + code(name) + "</a>";
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map(typeHtml).join(" or ");
  }
  if ("const" in schema) {
    return code(JSON.stringify(schema.const));
  }
  if (Array.isArray(schema.enum)) {
    return "one of " + schema.enum.map(function (v) { return code(String(v)); }).join(", ");
  }
  if (schema.type === "array") {
    return "array of " + (schema.items ? typeHtml(schema.items) : "values");
  }
  if (schema.type === "null") {
    return code("null");
  }
  const type = schema.type ? escapeHtml(String(schema.type)) : "any";
  return schema.format ? type + " (" + escapeHtml(schema.format) + ")" : type;
}

// A field's description: its own, else the first nullable branch's.
function descriptionOf(schema) {
  if (!schema) {
    return "";
  }
  if (typeof schema.description === "string") {
    return schema.description;
  }
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) {
      if (branch && typeof branch.description === "string") {
        return branch.description;
      }
    }
  }
  return "";
}

// The path as the heading shows it, and the path with every parameter replaced
// by its example, for the sample request.
function samplePath(path, parameters) {
  let out = path;
  for (const param of parameters) {
    if (param.in === "path" && param.example !== undefined) {
      out = out.split("{" + param.name + "}").join(String(param.example));
    }
  }
  return out;
}

function operationsOf(spec) {
  const ops = [];
  for (const path of Object.keys(spec.paths)) {
    const item = spec.paths[path];
    for (const method of ["get"]) {
      if (item[method]) {
        ops.push({ path: path, method: method.toUpperCase(), op: item[method] });
      }
    }
  }
  return ops;
}

function renderParameters(spec, entry, parameters) {
  if (parameters.length === 0) {
    return "";
  }
  const rows = parameters.map(function (param) {
    const schema = param.schema || {};
    // Where the parameter goes rides under its name rather than in its own
    // column, so the meaning stays in view at phone width.
    return [
      code(param.name) + "<br><span class=\"wa-caption-s wa-color-text-quiet\">" +
        escapeHtml(param.in) + (param.required ? ", required" : "") + "</span>",
      typeHtml(schema),
      escapeHtml(param.description || "") +
        (param.example !== undefined ? " Example: " + code(String(param.example)) + "." : "")
    ];
  });
  return table("Parameters for " + entry.method + " " + entry.path,
    ["Name", "Type", "Meaning"], rows);
}

function renderResponses(spec, entry) {
  const responses = entry.op.responses || {};
  const rows = Object.keys(responses).map(function (status) {
    const response = deref(spec, responses[status]);
    const content = response.content || {};
    const bodies = Object.keys(content).map(function (media) {
      return typeHtml(content[media].schema) + " (" + code(media) + ")";
    });
    return [
      escapeHtml(status),
      escapeHtml(response.description || ""),
      bodies.length > 0 ? bodies.join("<br>") : "None."
    ];
  });
  return table("Responses of " + entry.method + " " + entry.path,
    ["Status", "When", "Body"], rows);
}

// The 2xx examples as copyable code blocks. A deprecated alias shows none, since
// its examples are the operation it aliases.
function renderExamples(spec, entry) {
  if (entry.op.deprecated) {
    return "";
  }
  let out = "";
  const responses = entry.op.responses || {};
  for (const status of Object.keys(responses)) {
    if (status.charAt(0) !== "2") {
      continue;
    }
    const content = deref(spec, responses[status]).content || {};
    for (const media of Object.keys(content)) {
      const examples = content[media].examples || {};
      for (const name of Object.keys(examples)) {
        const example = examples[name];
        const title = example.summary || name;
        out = out + codeBlock(entry.op.operationId + "-" + status + "-" + name,
          "Response " + status + ": " + title, json(example.value),
          "Copy " + title + " example for " + entry.path);
      }
    }
  }
  return out;
}

function renderOperation(spec, entry) {
  const op = entry.op;
  const parameters = (op.parameters || []).map(function (param) { return deref(spec, param); });
  const origin = (spec.servers && spec.servers[0] && spec.servers[0].url) || SITE_ORIGIN;
  const sample = "curl -s '" + origin + samplePath(entry.path, parameters) + "'";
  return "<section aria-labelledby=\"" + op.operationId + "\">" +
    endpointHeading(op.operationId, entry.method, entry.path) +
    (op.deprecated
      ? "<p><wa-badge variant=\"warning\" appearance=\"outlined\">Deprecated</wa-badge></p>"
      : "") +
    "<p><strong>" + escapeHtml(op.summary || "") + ".</strong> " +
    escapeHtml(op.description || "") + "</p>" +
    renderParameters(spec, entry, parameters) +
    renderResponses(spec, entry) +
    codeBlock(op.operationId + "-request", "Request", sample,
      "Copy request for " + entry.path) +
    renderExamples(spec, entry) +
    "</section>";
}

function renderEndpoints(spec) {
  return "<section aria-labelledby=\"endpoints-heading\">" +
    "<h2 id=\"endpoints-heading\">Endpoints</h2>" +
    operationsOf(spec).map(function (entry) { return renderOperation(spec, entry); }).join("") +
    "</section>";
}

// One table per object schema, one line per value schema. Field types link to
// each other, so a reader can walk from a response down to any nested record.
function renderSchema(name, schema) {
  const heading = sectionHeading(3, schemaAnchor(name), code(name));
  const description = descriptionOf(schema);
  const intro = description ? "<p>" + escapeHtml(description) + "</p>" : "";
  const props = schema.properties || {};
  const keys = Object.keys(props);
  if (keys.length === 0) {
    return "<section aria-labelledby=\"" + schemaAnchor(name) + "\">" + heading + intro +
      "<p>Type: " + typeHtml(schema) + ".</p></section>";
  }
  const required = schema.required || [];
  const rows = keys.map(function (key) {
    return [
      code(key),
      typeHtml(props[key]),
      required.indexOf(key) !== -1 ? "always" : "optional",
      escapeHtml(descriptionOf(props[key]))
    ];
  });
  const open = schema.additionalProperties === false
    ? ""
    : "<p>Other fields may appear; do not depend on fields not listed here.</p>";
  return "<section aria-labelledby=\"" + schemaAnchor(name) + "\">" + heading + intro +
    table("Fields of " + name, ["Field", "Type", "Present", "Meaning"], rows) +
    open + "</section>";
}

function renderSchemas(spec) {
  const schemas = (spec.components && spec.components.schemas) || {};
  return "<section aria-labelledby=\"schemas\">" +
    sectionHeading(2, "schemas", "Schemas") +
    "<p>Every object the endpoints return, field by field. \"Present\" says whether a " +
    "field is always in the object; a present field may still be " + code("null") +
    " where its type says so.</p>" +
    Object.keys(schemas).map(function (name) { return renderSchema(name, schemas[name]); }).join("") +
    "</section>";
}

function renderOpenApiSection() {
  return "<section aria-labelledby=\"openapi\">" +
    sectionHeading(2, "openapi", "OpenAPI") +
    "<p>A machine-readable description of every endpoint above, its parameters, response " +
    "schemas and examples, is at <a href=\"" + OPENAPI_PATH + "\">" + code(OPENAPI_PATH) +
    "</a> (OpenAPI 3.2). Load it into a client generator, an API explorer or a test " +
    "suite. This page also points to it with a " +
    code("Link: <" + OPENAPI_PATH + ">; rel=\"service-desc\"") + " header.</p>" +
    codeBlock("openapi", "Shell", "curl -s '" + SITE_ORIGIN + OPENAPI_PATH + "'",
      "Copy OpenAPI command") +
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
  const errors = table("Errors any route can answer", ["Status", "When", "Body"],
    [
      ["404", "Any path under " + code("/api/") + " that is not an endpoint above.",
        code("{\"error\":\"not found\"}") + ", not cached."],
      ["405", "A method other than " + code("GET") + " or " + code("HEAD") + " (or " +
        code("OPTIONS") + " on " + code("/api/") + ").", "Plain text."],
      ["500", "The database could not be read.", "Not cached. Retry later."]
    ]);
  return "<section aria-labelledby=\"errors\">" +
    sectionHeading(2, "errors", "Errors") +
    "<p>Errors are JSON with a single human-readable " + code("error") + " string. Match " +
    "on the status code, not the message text. Each endpoint above lists the statuses it " +
    "answers; these apply everywhere.</p>" +
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
  const spec = buildOpenApiDocument();
  const mainHtml = "<article class=\"wa-prose api-docs\">" +
    "<h1>Swim Report API</h1>" +
    "<p class=\"wa-body-l wa-color-text-quiet\">Estimated and official hazard flags " +
    "for North American beaches</p>" +
    renderToc(spec) +
    renderOverview(nowIso) +
    renderQuickStart() +
    renderEndpoints(spec) +
    renderSchemas(spec) +
    renderOpenApiSection() +
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
