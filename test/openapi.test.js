// test/openapi.test.js
// The OpenAPI document held to the implementation. Every example it carries
// validates against its own schema, and real responses from handleRequest
// (against real SQLite through test/helpers/d1.js) validate against the schema
// of the operation that served them, so the document cannot drift from the code.
// The validator below covers exactly the JSON Schema subset src/openapi.js uses:
// $ref, anyOf, type, const, enum, required, properties, additionalProperties
// false, items, min/maxItems, minimum/maximum and pattern.

import { describe, it, expect } from "vitest";
import { handleRequest } from "../src/router.js";
import { buildOpenApiDocument, API_VERSION, OPENAPI_PATH } from "../src/openapi.js";
import { IDS_LIST_LIMIT } from "../src/idsListLimit.js";
import { HOME_LIST_LIMIT } from "../src/beachQueries.js";
import { makeD1 } from "./helpers/d1.js";

const DOC = buildOpenApiDocument();

function resolve(schema) {
  if (schema && typeof schema.$ref === "string") {
    const prefix = "#/components/schemas/";
    expect(schema.$ref.indexOf(prefix)).toBe(0);
    const target = DOC.components.schemas[schema.$ref.slice(prefix.length)];
    expect(target, schema.$ref).toBeTruthy();
    return target;
  }
  return schema;
}

function typeOf(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function typeMatches(expected, value) {
  const actual = typeOf(value);
  return actual === expected || (expected === "number" && actual === "integer");
}

// The list of violations of value against schema, each prefixed with its path.
function validate(schemaIn, value, path) {
  const schema = resolve(schemaIn);
  const errors = [];
  if (schema.anyOf) {
    const ok = schema.anyOf.some(function (alt) { return validate(alt, value, path).length === 0; });
    if (!ok) {
      errors.push(path + ": matches no anyOf branch");
    }
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(function (t) { return typeMatches(t, value); })) {
      errors.push(path + ": expected " + types.join("|") + ", got " + typeOf(value));
      return errors;
    }
  }
  if ("const" in schema && value !== schema.const) {
    errors.push(path + ": expected const " + JSON.stringify(schema.const));
  }
  if (schema.enum && schema.enum.indexOf(value) === -1) {
    errors.push(path + ": " + JSON.stringify(value) + " not in enum");
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push(path + ": " + JSON.stringify(value) + " does not match " + schema.pattern);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(path + ": below minimum");
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(path + ": above maximum");
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(path + ": fewer than minItems");
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(path + ": more than maxItems");
    }
    if (schema.items) {
      value.forEach(function (item, i) {
        errors.push.apply(errors, validate(schema.items, item, path + "[" + i + "]"));
      });
    }
  }
  if (typeOf(value) === "object") {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (!(key in value)) {
        errors.push(path + ": missing required " + key);
      }
    }
    for (const key of Object.keys(value)) {
      if (props[key]) {
        errors.push.apply(errors, validate(props[key], value[key], path + "." + key));
      } else if (schema.additionalProperties === false) {
        errors.push(path + ": unexpected property " + key);
      }
    }
  }
  return errors;
}

function expectValid(schema, value, label) {
  expect(validate(schema, value, label || "$")).toEqual([]);
}

function responseSchema(path, status, mediaType) {
  const response = DOC.paths[path].get.responses[status];
  return response.content[mediaType || "application/json"].schema;
}

// --- Fixture ---------------------------------------------------------------

const NOW_EPOCH = Math.floor(Date.now() / 1000);
const LIVE = NOW_EPOCH + 3600;
const UPDATED = new Date(Date.now() - 600000).toISOString();

const OVAL = { id: "osm-way-1", name: "Oval Beach", park_name: null, lat: 42.6579, lon: -86.2114 };
const OTTAWA = { id: "osm-node-2", name: "Ottawa Beach", park_name: "Holland State Park", lat: 42.775, lon: -86.211 };
const MONTROSE = { id: "osm-relation-3", name: "Montrose Beach", park_name: null, lat: 41.9658, lon: -87.6363 };

function makeEnv() {
  const db = makeD1({ beaches: [OVAL, OTTAWA, MONTROSE] });
  const estimate = {
    beachId: "osm-way-1", color: "double-red", reason: "x", trigger: "nws-alert",
    rules_version: "1.9.0", official: false, waveHeightFt: null, alertDetails: [],
    alertsAt: UPDATED, ripCurrentRisk: null,
    sources: [{ label: "NWS Alerts", url: "https://api.weather.gov/alerts/active?zone=MIZ071" }],
    updated: UPDATED, estimateInputs: { v: 1 }
  };
  db.seedState("osm-way-1", {
    estimate: estimate, estimate_color: estimate.color,
    estimate_updated: UPDATED, estimate_expires: LIVE
  });
  const official = {
    beachId: "osm-node-2", color: "red", reason: "Official flag", official: true,
    scraperId: "example", source: "https://example.org/", sources: ["https://example.org/"],
    updated: UPDATED, kind: "forecast"
  };
  db.seedState("osm-node-2", {
    official: official, official_color: official.color,
    official_updated: UPDATED, official_expires: LIVE
  });
  const flags = { get: function () { return Promise.resolve(null); } };
  return { DB: db, FLAGS: flags };
}

function request(path) {
  return { method: "GET", url: "https://swim.report" + path, cf: {}, headers: new Headers() };
}

async function getJson(path, env) {
  const res = await handleRequest(request(path), env || makeEnv());
  return { res: res, body: await res.json() };
}

// --- Tests -----------------------------------------------------------------

describe("the test's validator", () => {
  it("rejects what the schemas forbid", () => {
    const item = DOC.components.schemas.BeachListItem;
    const good = {
      id: "n1", name: "A", lat: 1, lon: 2,
      display: { color: "green", source: "estimate", forecast: false },
      distanceMi: null, links: { page: "/beach/n1", api: "/api/beaches/n1" }
    };
    expect(validate(item, good, "$")).toEqual([]);
    const bad = [
      Object.assign({}, good, { id: "osm-node-1" }),
      Object.assign({}, good, { extra: 1 }),
      Object.assign({}, good, { display: { color: "purple", source: "estimate", forecast: false } }),
      Object.assign({}, good, { distanceMi: "1" }),
      Object.assign({}, good, { lat: undefined })
    ];
    delete bad[4].lat;
    for (const value of bad) {
      expect(validate(item, value, "$").length, JSON.stringify(value)).toBeGreaterThan(0);
    }
    expect(validate(DOC.components.schemas.Estimate, { color: "green", reason: "x",
      rules_version: "1", official: true, updated: "t" }, "$").length).toBeGreaterThan(0);
  });
});

describe("the OpenAPI document", () => {
  it("is OpenAPI 3.2 with its info, server and every public path", () => {
    expect(DOC.openapi).toBe("3.2.0");
    expect(DOC.info.version).toBe(API_VERSION);
    expect(DOC.servers).toEqual([{ url: "https://swim.report" }]);
    expect(Object.keys(DOC.paths).sort()).toEqual([
      "/api/beaches", "/api/beaches.geojson", "/api/beaches/{beachId}",
      "/api/flag/{beachId}", "/api/openapi.json", "/health"
    ]);
  });

  it("gives every operation a unique operationId", () => {
    const ids = [];
    for (const path of Object.keys(DOC.paths)) {
      ids.push(DOC.paths[path].get.operationId);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("quotes the limits the code enforces", () => {
    const list = resolve(DOC.components.schemas.BeachList);
    expect(list.properties.beaches.maxItems).toBe(HOME_LIST_LIMIT);
    expect(list.properties.query.properties.ids.anyOf[0].maxItems).toBe(IDS_LIST_LIMIT);
  });

  it("resolves every $ref", () => {
    const text = JSON.stringify(DOC);
    const refs = text.match(/"\$ref":"[^"]+"/g) || [];
    expect(refs.length).toBeGreaterThan(0);
    for (const raw of refs) {
      const target = raw.slice(8, -1).split("/").slice(1);
      let node = DOC;
      for (const part of target) {
        node = node ? node[part] : undefined;
      }
      expect(node, raw).toBeTruthy();
    }
  });

  it("validates every example against its own schema", () => {
    let count = 0;
    for (const path of Object.keys(DOC.paths)) {
      const responses = DOC.paths[path].get.responses;
      for (const status of Object.keys(responses)) {
        const content = responses[status].content || {};
        for (const media of Object.keys(content)) {
          const examples = content[media].examples || {};
          for (const name of Object.keys(examples)) {
            expectValid(content[media].schema, examples[name].value,
              path + " " + status + " " + name);
            count = count + 1;
          }
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(8);
  });
});

describe("real responses conform to the document", () => {
  it("/api/beaches in every mode", async () => {
    const schema = responseSchema("/api/beaches", "200");
    for (const path of ["/api/beaches", "/api/beaches?q=beach", "/api/beaches?near=42.7,-86.2",
      "/api/beaches?ids=w1,osm-node-2,zzz"]) {
      const out = await getJson(path);
      expect(out.res.status, path).toBe(200);
      expectValid(schema, out.body, path);
    }
  });

  it("/api/beaches 400", async () => {
    const out = await getJson("/api/beaches?ids=w1&q=x");
    expect(out.res.status).toBe(400);
    expectValid(responseSchema("/api/beaches", "400"), out.body);
  });

  it("/api/beaches/{beachId} and its alias, with estimate, official and neither", async () => {
    for (const prefix of ["/api/beaches/", "/api/flag/"]) {
      const schema = responseSchema(prefix === "/api/flag/" ? "/api/flag/{beachId}" : "/api/beaches/{beachId}", "200");
      for (const id of ["w1", "n2", "r3"]) {
        const out = await getJson(prefix + id);
        expect(out.res.status, prefix + id).toBe(200);
        expectValid(schema, out.body, prefix + id);
      }
    }
  });

  it("the single-beach 404", async () => {
    const out = await getJson("/api/beaches/n999");
    expect(out.res.status).toBe(404);
    expectValid(responseSchema("/api/beaches/{beachId}", "404"), out.body);
  });

  it("/api/beaches.geojson", async () => {
    const out = await getJson("/api/beaches.geojson");
    expect(out.res.headers.get("content-type")).toContain("application/geo+json");
    expectValid(responseSchema("/api/beaches.geojson", "200", "application/geo+json"), out.body);
  });

  it("/health", async () => {
    const out = await getJson("/health");
    expectValid(responseSchema("/health", "200"), out.body);
  });
});

describe("GET /api/openapi.json", () => {
  it("serves the document with an ETag, CORS and the cacheable policy", async () => {
    const env = makeEnv();
    const res = await handleRequest(request(OPENAPI_PATH), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toContain("max-age=60");
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(DOC)));
    const etag = res.headers.get("etag");
    const again = await handleRequest({
      method: "GET", url: "https://swim.report" + OPENAPI_PATH, cf: {},
      headers: new Headers({ "if-none-match": etag })
    }, env);
    expect(again.status).toBe(304);
  });

  it("is advertised from the /api/ page as its service-desc", async () => {
    const res = await handleRequest(request("/api/"), makeEnv());
    expect(res.headers.get("link")).toBe("</api/openapi.json>; rel=\"service-desc\"; type=\"application/json\"");
    expect(await res.text()).toContain("href=\"/api/openapi.json\"");
  });
});
