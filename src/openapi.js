// src/openapi.js — the OpenAPI 3.2 description of the public JSON API, served at
// GET /api/openapi.json. Built as a plain object from the same constants the
// handlers enforce (the list cap, the ids cap, the cache policy, the rules
// version) and from the shared example payloads in src/apiExamples.js, so the
// document cannot quote a limit the code does not apply.
//
// test/openapi.test.js holds it to the implementation: every example validates
// against its schema, and real responses from handleRequest validate against the
// schemas of the operation that served them.
import { IDS_LIST_LIMIT } from "./idsListLimit.js";
import { HOME_LIST_LIMIT } from "./beachQueries.js";
import { CACHE_CONTROL_CACHEABLE } from "./cacheControl.js";
import { RULES_VERSION } from "./rules.js";
import { strongEtag, etaggedResponse } from "./etag.js";
import {
  EXAMPLE_LIST_RESPONSE,
  EXAMPLE_IDS_RESPONSE,
  EXAMPLE_BEACH_RESPONSE,
  EXAMPLE_OFFICIAL_BEACH_RESPONSE,
  EXAMPLE_GEOJSON_RESPONSE
} from "./apiExamples.js";

// The version of the API contract, not of the site. Bump the minor version for
// an additive change and the major one for anything a client could trip on.
export const API_VERSION = "1.0.0";

export const OPENAPI_PATH = "/api/openapi.json";

const OPENAPI_CONTENT_TYPE = "application/json; charset=utf-8";

const PUBLIC_ID_PATTERN = "^[nwr][1-9][0-9]*$";
const ANY_ID_PATTERN = "^([nwr][1-9][0-9]*|osm-(node|way|relation)-[1-9][0-9]*)$";

function ref(name) {
  return { $ref: "#/components/schemas/" + name };
}

// schema or null. description, when given, describes the field as a whole.
function nullable(schema, description) {
  const out = { anyOf: [schema, { type: "null" }] };
  if (description) {
    out.description = description;
  }
  return out;
}

function jsonContent(schemaName, examples) {
  const media = { schema: ref(schemaName) };
  if (examples) {
    media.examples = examples;
  }
  return { "application/json": media };
}

const CACHED_HEADERS = {
  "ETag": { $ref: "#/components/headers/ETag" },
  "Cache-Control": { $ref: "#/components/headers/CacheControl" },
  "Access-Control-Allow-Origin": { $ref: "#/components/headers/AccessControlAllowOrigin" }
};

const SCHEMAS = {
  FlagColor: {
    type: "string",
    enum: ["green", "yellow", "red", "double-red", "unknown"],
    description: "unknown means no usable data: render it gray and neutral, never as green."
  },
  MapFlag: {
    type: "string",
    enum: ["green", "yellow", "red", "unknown"],
    description: "The map keyword: double-red is folded into red."
  },
  Display: {
    type: "object",
    description: "The one flag swim.report shows for the beach, decided the same way for " +
      "every page, the map and the API. source says which record supplied the color: an " +
      "estimate is not an official flag and must be labelled as one.",
    required: ["color", "source", "forecast"],
    additionalProperties: false,
    properties: {
      color: ref("FlagColor"),
      source: {
        type: "string",
        enum: ["official", "estimate", "none"],
        description: "none when no record supplies a color; color is then unknown."
      },
      forecast: {
        type: "boolean",
        description: "True only when the credited official record is the operator's " +
          "forecast for the day rather than a flag raised on the beach."
      }
    }
  },
  Links: {
    type: "object",
    required: ["page", "api"],
    additionalProperties: false,
    properties: {
      page: { type: "string", description: "The beach's HTML page, relative to the server." },
      api: { type: "string", description: "The beach's JSON record, relative to the server." }
    }
  },
  LatLon: {
    type: "object",
    required: ["lat", "lon"],
    additionalProperties: false,
    properties: {
      lat: { type: "number", minimum: -90, maximum: 90 },
      lon: { type: "number", minimum: -180, maximum: 180 }
    }
  },
  BeachListItem: {
    type: "object",
    required: ["id", "name", "lat", "lon", "display", "distanceMi", "links"],
    additionalProperties: false,
    properties: {
      id: { type: "string", pattern: PUBLIC_ID_PATTERN, description: "Public beach id." },
      name: { type: "string", description: "The containing park's name when the beach is inside one, else the beach's own." },
      lat: nullable({ type: "number" }, "Decimal degrees (WGS 84), rounded to 5 decimals."),
      lon: nullable({ type: "number" }, "Decimal degrees (WGS 84), rounded to 5 decimals."),
      display: ref("Display"),
      distanceMi: nullable({ type: "number", minimum: 0 },
        "Statute miles from near, rounded to 0.1. null unless sort is distance."),
      links: ref("Links")
    }
  },
  BeachList: {
    type: "object",
    required: ["builtAt", "sort", "query", "hasMore", "beaches"],
    additionalProperties: false,
    properties: {
      builtAt: nullable({ type: "string", format: "date-time" },
        "When the freshest live estimate among the returned beaches was computed; null " +
        "when none is live. Never the request time, so an unchanged list keeps its ETag."),
      sort: {
        type: "string",
        enum: ["name", "distance", "ids"],
        description: "name: alphabetical by park name then beach name. distance: nearest " +
          "to near first. ids: the order the ids were given."
      },
      query: {
        type: "object",
        description: "The parameters as understood.",
        required: ["q", "near", "ids"],
        additionalProperties: false,
        properties: {
          q: nullable({ type: "string" }, "The trimmed search text."),
          near: nullable(ref("LatLon"), "The parsed point."),
          ids: nullable({
            type: "array",
            maxItems: IDS_LIST_LIMIT,
            items: { type: "string", pattern: PUBLIC_ID_PATTERN }
          }, "The accepted ids, deduplicated and in public form.")
        }
      },
      hasMore: {
        type: "boolean",
        description: "True when more than " + HOME_LIST_LIMIT + " beaches matched. " +
          "There is no paging: narrow the query. Always false in ids mode."
      },
      beaches: {
        type: "array",
        maxItems: HOME_LIST_LIMIT,
        items: ref("BeachListItem"),
        description: "The matching beaches, in sort order."
      }
    }
  },
  Source: {
    description: "A provenance entry: { label, url } (url optional), or a bare URL " +
      "string in older records.",
    anyOf: [
      {
        type: "object",
        required: ["label"],
        properties: {
          label: { type: "string" },
          url: { type: "string" }
        }
      },
      { type: "string" }
    ]
  },
  AlertDetail: {
    type: "object",
    required: ["event"],
    properties: {
      event: { type: "string" },
      onset: nullable({ type: "string", format: "date-time" }),
      ends: nullable({ type: "string", format: "date-time" }),
      description: nullable({ type: "string" }),
      instruction: nullable({ type: "string" }),
      area: nullable({ type: "string" }),
      sender: nullable({ type: "string" })
    }
  },
  Estimate: {
    type: "object",
    description: "swim.report's estimated flag, as stored. Not an official flag. The " +
      "nested beachId is the internal storage id. Fields beyond those listed may appear; " +
      "estimateInputs is internal and may change without notice.",
    required: ["color", "reason", "rules_version", "official", "updated"],
    properties: {
      beachId: { type: "string" },
      color: ref("FlagColor"),
      reason: { type: "string" },
      trigger: { type: "string", description: "Which rule decided the color." },
      rules_version: {
        type: "string",
        description: "The estimation rules version; currently " + RULES_VERSION + "."
      },
      official: { const: false },
      waveHeightFt: nullable({ type: "number" }),
      alertDetails: { type: "array", items: ref("AlertDetail") },
      alertsAt: nullable({ type: "string", format: "date-time" }),
      ripCurrentRisk: nullable({ type: "string", enum: ["HIGH", "MODERATE", "LOW"] }),
      sources: { type: "array", items: ref("Source") },
      updated: { type: "string", format: "date-time" },
      estimateInputs: { type: "object", description: "Internal; do not depend on it." }
    }
  },
  Official: {
    type: "object",
    description: "A flag read from the beach operator's own site, as stored. The nested " +
      "beachId is the internal storage id.",
    required: ["color", "official", "updated"],
    properties: {
      beachId: { type: "string" },
      color: { type: "string", enum: ["green", "yellow", "red", "double-red"] },
      reason: { type: "string" },
      official: { const: true },
      scraperId: { type: "string" },
      source: { type: "string", description: "The operator page the flag was read from." },
      sources: { type: "array", items: ref("Source") },
      updated: { type: "string", format: "date-time" },
      kind: {
        type: "string",
        enum: ["forecast"],
        description: "Present only when the color is the operator's forecast for the day."
      }
    }
  },
  Beach: {
    type: "object",
    required: ["beachId", "name", "lat", "lon", "estimate", "official", "display", "links"],
    additionalProperties: false,
    properties: {
      beachId: { type: "string", pattern: PUBLIC_ID_PATTERN, description: "Public beach id." },
      name: { type: "string", description: "Display name, as in the list." },
      lat: nullable({ type: "number" }, "Decimal degrees (WGS 84), rounded to 5 decimals."),
      lon: nullable({ type: "number" }, "Decimal degrees (WGS 84), rounded to 5 decimals."),
      estimate: nullable(ref("Estimate"), "The live estimated flag; null when no live estimate exists."),
      official: nullable(ref("Official"), "The live flag read from the beach operator; null for most beaches."),
      display: ref("Display"),
      links: ref("Links")
    }
  },
  BeachFeatureCollection: {
    type: "object",
    description: "RFC 7946 GeoJSON. Coordinates are [longitude, latitude].",
    required: ["type", "builtAt", "features"],
    properties: {
      type: { const: "FeatureCollection" },
      builtAt: nullable({ type: "string", format: "date-time" },
        "When the newest live estimate on the map was computed; null when none is live."),
      features: {
        type: "array",
        items: {
          type: "object",
          required: ["type", "geometry", "properties"],
          properties: {
            type: { const: "Feature" },
            geometry: {
              type: "object",
              required: ["type", "coordinates"],
              properties: {
                type: { const: "Point" },
                coordinates: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } }
              }
            },
            properties: {
              type: "object",
              required: ["id", "name", "flag"],
              additionalProperties: false,
              properties: {
                id: { type: "string", pattern: PUBLIC_ID_PATTERN },
                name: { type: "string" },
                flag: ref("MapFlag")
              }
            }
          }
        }
      }
    }
  },
  Health: {
    type: "object",
    required: ["ok"],
    additionalProperties: false,
    properties: { ok: { const: true } }
  },
  Error: {
    type: "object",
    required: ["error"],
    additionalProperties: false,
    properties: {
      error: { type: "string", description: "Human-readable. Match on the status code, not this text." }
    }
  }
};

const BEACH_ID_PARAMETER = {
  name: "beachId",
  in: "path",
  required: true,
  description: "Public beach id: the OpenStreetMap element type (n, w or r) followed by " +
    "the OSM id. The storage form osm-<node|way|relation>-<id> answers 301 to it.",
  schema: { type: "string", pattern: ANY_ID_PATTERN },
  example: "n123456"
};

function singleBeachOperation(operationId, summary, extra) {
  const op = {
    tags: ["beaches"],
    operationId: operationId,
    summary: summary,
    parameters: [BEACH_ID_PARAMETER, { $ref: "#/components/parameters/IfNoneMatch" }],
    responses: {
      "200": {
        description: "The beach with both of its live records in full.",
        headers: CACHED_HEADERS,
        content: jsonContent("Beach", {
          estimate: { summary: "Estimate-driven yellow", value: EXAMPLE_BEACH_RESPONSE },
          official: { summary: "Posted official red", value: EXAMPLE_OFFICIAL_BEACH_RESPONSE }
        })
      },
      "301": { $ref: "#/components/responses/StorageIdRedirect" },
      "304": { $ref: "#/components/responses/NotModified" },
      "404": {
        description: "Unknown or malformed id, or a beach not on swimmable open water. " +
          "Cached for 60 s.",
        content: jsonContent("Error", {
          notFound: { value: { error: "beach not found" } }
        })
      }
    }
  };
  const keys = Object.keys(extra || {});
  for (const key of keys) {
    op[key] = extra[key];
  }
  return op;
}

// The OpenAPI document as a plain object. Pure.
export function buildOpenApiDocument() {
  return {
    openapi: "3.2.0",
    info: {
      title: "Swim Report API",
      version: API_VERSION,
      summary: "Estimated and official hazard flags for North American beaches",
      description: "Read-only and unauthenticated: no key, only GET (and HEAD). Most " +
        "flags are estimates computed from weather alerts, surf-zone forecasts and wave " +
        "models, not the official flag status. display.source says which record a color " +
        "came from: label estimates as estimates, show unknown as gray (never green), and " +
        "remind people to obey posted flags and lifeguards. Full guide: https://swim.report/api/",
      contact: { name: "Swim Report", url: "https://swim.report/api/" }
    },
    servers: [{ url: "https://swim.report" }],
    // No authentication anywhere, stated rather than left implicit.
    security: [],
    externalDocs: { description: "API guide", url: "https://swim.report/api/" },
    tags: [
      { name: "beaches", summary: "Beaches", description: "Lists and single-beach records." },
      { name: "map", summary: "Map", description: "Every beach as GeoJSON." },
      { name: "meta", summary: "Meta", description: "Liveness and this document." }
    ],
    paths: {
      "/api/beaches": {
        get: {
          tags: ["beaches"],
          operationId: "listBeaches",
          summary: "Search, sort by distance, or fetch a list of beaches",
          description: "The API form of the home page. With no parameters, the first " +
            HOME_LIST_LIMIT + " beaches alphabetically by park name then beach name. q " +
            "filters by name and keeps alphabetical order; near sorts nearest first, fills " +
            "distanceMi and combines with q; ids returns exactly those beaches in the order " +
            "given and cannot be combined with q or near. At most " + HOME_LIST_LIMIT +
            " rows: hasMore is true when more matched, so narrow the query, since there is " +
            "no paging. An ids list that names no valid beach answers 200 with an empty " +
            "beaches array. The response depends only on the URL: it never uses the " +
            "caller's IP location, so pass near explicitly.",
          parameters: [
            {
              name: "q",
              in: "query",
              description: "Case-insensitive substring of the beach name or its park name. " +
                "A blank q counts as absent.",
              schema: { type: "string" },
              example: "holland"
            },
            {
              name: "near",
              in: "query",
              description: "lat,lon in decimal degrees, latitude first. Sorts by distance " +
                "and fills distanceMi. Latitude must lie in -90 to 90 and longitude in -180 " +
                "to 180; anything else is a 400.",
              schema: { type: "string", pattern: "^-?[0-9.]+,-?[0-9.]+$" },
              example: "42.7712,-86.2125"
            },
            {
              name: "ids",
              in: "query",
              description: "Up to " + IDS_LIST_LIMIT + " comma-separated beach ids, in " +
                "either id form. Duplicates are dropped, ids past the cap are ignored, " +
                "unknown or non-swimming ids are skipped, and your order is kept. Cannot be " +
                "combined with q or near (400).",
              schema: { type: "string" },
              example: "w98765432,n123456"
            },
            { $ref: "#/components/parameters/IfNoneMatch" }
          ],
          responses: {
            "200": {
              description: "The matching beaches with their display flags.",
              headers: CACHED_HEADERS,
              content: jsonContent("BeachList", {
                near: { summary: "Sorted by distance", value: EXAMPLE_LIST_RESPONSE },
                ids: { summary: "A saved list", value: EXAMPLE_IDS_RESPONSE }
              })
            },
            "304": { $ref: "#/components/responses/NotModified" },
            "400": {
              description: "Invalid near, or ids combined with q or near. Not cached.",
              content: jsonContent("Error", {
                conflict: { value: { error: "ids cannot be combined with q or near" } }
              })
            }
          }
        }
      },
      "/api/beaches/{beachId}": {
        get: singleBeachOperation("getBeach", "One beach's estimate, official flag and display flag", {
          description: "One beach, with both of its live records in full. The nested " +
            "estimate.beachId and official.beachId are the internal storage id; use the " +
            "top-level beachId."
        })
      },
      "/api/flag/{beachId}": {
        get: singleBeachOperation("getBeachFlag",
          "Alias of /api/beaches/{beachId}", {
            deprecated: true,
            description: "The original single-beach endpoint. It returns exactly the same " +
              "body as /api/beaches/{beachId} and keeps working; new code should use that path."
          })
      },
      "/api/beaches.geojson": {
        get: {
          tags: ["map"],
          operationId: "getBeachesGeojson",
          summary: "Every beach as one GeoJSON FeatureCollection",
          description: "Every beach as one RFC 7946 FeatureCollection, the data behind the " +
            "home page map. Each feature's flag is the map keyword, with double-red folded " +
            "into red; fetch a beach's own record when you need the distinction. builtAt " +
            "is the newest live estimate on the map, so a stalled update is visible at a " +
            "glance. The body is large: revalidate with If-None-Match rather than " +
            "downloading it again.",
          parameters: [{ $ref: "#/components/parameters/IfNoneMatch" }],
          responses: {
            "200": {
              description: "Every beach that gets a flag.",
              headers: CACHED_HEADERS,
              content: {
                "application/geo+json": {
                  schema: ref("BeachFeatureCollection"),
                  examples: { twoBeaches: { value: EXAMPLE_GEOJSON_RESPONSE } }
                }
              }
            },
            "304": { $ref: "#/components/responses/NotModified" }
          }
        }
      },
      "/api/openapi.json": {
        get: {
          tags: ["meta"],
          operationId: "getOpenApiDocument",
          summary: "This OpenAPI document",
          parameters: [{ $ref: "#/components/parameters/IfNoneMatch" }],
          responses: {
            "200": {
              description: "The OpenAPI 3.2 description of this API.",
              headers: CACHED_HEADERS,
              content: { "application/json": { schema: { type: "object" } } }
            },
            "304": { $ref: "#/components/responses/NotModified" }
          }
        }
      },
      "/health": {
        get: {
          tags: ["meta"],
          operationId: "getHealth",
          summary: "Liveness check",
          description: "Touches no data and is never cached.",
          responses: {
            "200": {
              description: "The Worker is up.",
              content: jsonContent("Health", { ok: { value: { ok: true } } })
            }
          }
        }
      }
    },
    components: {
      schemas: SCHEMAS,
      parameters: {
        IfNoneMatch: {
          name: "If-None-Match",
          in: "header",
          description: "An ETag from an earlier response. A match answers 304 with no body.",
          schema: { type: "string" }
        }
      },
      headers: {
        ETag: {
          description: "Strong SHA-256 hash of the body. No body contains the request " +
            "time, so the tag changes exactly when the data does. There is deliberately no " +
            "Last-Modified: a flag can change (a record expiring, an official going stale) " +
            "with no stored timestamp moving.",
          schema: { type: "string" }
        },
        CacheControl: {
          description: "Responses may be served from cache for up to about two minutes.",
          schema: { type: "string", example: CACHE_CONTROL_CACHEABLE }
        },
        AccessControlAllowOrigin: {
          description: "Every /api/ response may be read from any origin.",
          schema: { type: "string", const: "*" }
        }
      },
      responses: {
        NotModified: {
          description: "The If-None-Match tag still matches. No body.",
          headers: {
            "ETag": { $ref: "#/components/headers/ETag" },
            "Cache-Control": { $ref: "#/components/headers/CacheControl" }
          }
        },
        StorageIdRedirect: {
          description: "The id was given in the internal storage form; Location names the " +
            "canonical public-id URL.",
          headers: {
            "Location": { description: "The canonical URL.", schema: { type: "string" } }
          }
        }
      }
    }
  };
}

// The serialized document and its ETag, computed once per isolate: the bytes
// change only with a deploy.
let cached = null;

async function openApiBytes() {
  if (cached === null) {
    const bytes = new TextEncoder().encode(JSON.stringify(buildOpenApiDocument()));
    cached = { bytes: bytes, etag: await strongEtag(bytes) };
  }
  return cached;
}

// GET /api/openapi.json, with the shared cacheable policy and a body-hash ETag.
export async function handleOpenApi(ifNoneMatch) {
  const doc = await openApiBytes();
  return etaggedResponse(doc.bytes, doc.etag, OPENAPI_CONTENT_TYPE,
    CACHE_CONTROL_CACHEABLE, ifNoneMatch);
}
