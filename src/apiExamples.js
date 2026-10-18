// src/apiExamples.js — the example payloads the public API documents, shared by
// the /api/ page (src/frontend/apiDocs.js) and the OpenAPI document
// (src/openapi.js), so the two can never show different samples.
// test/openapi.test.js validates every one against the spec's schemas.
import { RULES_VERSION } from "./rules.js";

// Plausible, mutually consistent records: Holland State Park is an estimate-
// driven yellow, Tunnel Park carries a posted red official flag.

const HOLLAND_LINKS = { page: "/beach/n123456", api: "/api/beaches/n123456" };
const TUNNEL_LINKS = { page: "/beach/w98765432", api: "/api/beaches/w98765432" };

export const EXAMPLE_LIST_RESPONSE = {
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

export const EXAMPLE_IDS_RESPONSE = {
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

export const EXAMPLE_BEACH_RESPONSE = {
  beachId: "n123456",
  name: "Holland State Park",
  lat: 42.77271,
  lon: -86.21245,
  estimate: {
    beachId: "osm-node-123456",
    color: "yellow",
    reason: "Estimated wave height 2.6 ft (at or above 2 ft)",
    trigger: "wave-height",
    rules_version: RULES_VERSION,
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

export const EXAMPLE_GEOJSON_RESPONSE = {
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

// Tunnel Park's single-beach record: a posted official red over an estimate
// yellow, so the OpenAPI document shows an official record in full.
export const EXAMPLE_OFFICIAL_BEACH_RESPONSE = {
  beachId: "w98765432",
  name: "Tunnel Park",
  lat: 42.82641,
  lon: -86.21533,
  estimate: {
    beachId: "osm-way-98765432",
    color: "yellow",
    reason: "Estimated wave height 2.4 ft (at or above 2 ft)",
    trigger: "wave-height",
    rules_version: RULES_VERSION,
    official: false,
    waveHeightFt: 2.41,
    alertDetails: [],
    alertsAt: "2026-07-04T15:00:03.000Z",
    ripCurrentRisk: null,
    sources: [
      { label: "NWS Alerts", url: "https://api.weather.gov/alerts/active?zone=MIZ056" },
      { label: "NOAA Great Lakes Wave Model", url: "https://polar.ncep.noaa.gov/waves/" }
    ],
    updated: "2026-07-04T15:00:03.000Z"
  },
  official: {
    beachId: "osm-way-98765432",
    color: "red",
    reason: "Official flag reported by Example Beach Operator",
    official: true,
    scraperId: "example-operator",
    source: "https://example.org/beach-flags",
    sources: ["https://example.org/beach-flags"],
    updated: "2026-07-04T14:45:00.000Z"
  },
  display: { color: "red", source: "official", forecast: false },
  links: TUNNEL_LINKS
};
