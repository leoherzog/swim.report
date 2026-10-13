// src/officialSources/nwsMarineBeachForecast.js
//
// KIND: official HAZARD scraper (src/officialSources), declared kind
// "forecast": its color is the office's Day-1 beach forecast, not a flag anyone
// raised at the beach. displayFlag (src/displayFlag.js) credits a forecast only
// while it is strictly more severe than the estimate, so it can raise the
// displayed color at any age and never lower it. This source may only sit on the
// HAZARD axis — it reports the NWS-forecast swim risk (rip) and surf-height
// conditions, both genuine surf hazards.
//
// STAMP: every site's updated is the product's issuance instant, productdat +
// producttim in the office's own zone (productIssuanceIso), falling back to the
// layer's idp_filedate when the time or zone does not parse. A feature with no
// resolvable issuance is dropped rather than stamped with the cron tick: the
// displayFlag gate reads updated, and a stamp rewritten every hour would let a
// morning green outrank an afternoon red estimate all day. The scraper declares
// staleMs (30 h) and a readingNote, so the official card carries a neutral
// "Forecast issued" note between the 2 h gate and the next issuance instead of
// a daily stale warning.
//
// SOURCE: NWS Marine Beach Forecast ArcGIS MapServer, per-WFO "Day 1" layers.
//   Base: https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/
//         marine_beachforecast/MapServer
//   Per-WFO Day1 layer query:
//     /{layer}/query?where=1=1&outFields=*&f=json
//   Each feature carries attributes { beachname, rip, surf, wtemp, winds,
//   producttim, productdat, idp_filedate, srfprod, ... }; off season every
//   product field and idp_filedate are null. The two verified Great Lakes layers:
//     layer 19 = CLE (Cleveland, Lake Erie OH/PA Day 1)
//     layer  7 = BUF (Buffalo, Lake Erie/Ontario NY Day 1)
//   only verified layers are enabled below. Never enable an unverified layer id:
//   a wrong id silently yields no features.
//
// Color mapping, the most severe of the two hazard axes; this source emits no
// double-red:
//   rip / "Swim Risk":  Low -> green, Moderate -> yellow, High -> red
//   surf text ("2 to 4 feet subsiding to 2 feet or less.") is parsed to the max
//     foot value in the string, so the peak is never under-reported, and colored
//     via rules.js waveColorForHeight. A surf string with no foot value degrades
//     to null.
// If both degrade to null the zone is omitted rather than guessed.
//
// The features are zonal, not per-beach: county-scale polygons named like "Lucas
// Area Beaches", never individual beaches. A beach binds to a zone through the
// curated SITE_DEFS table — globally-unique name substrings first, then nearest
// shoreline centroid within radiusMi — and a beach binding to no curated zone
// gets no site and no KV write. Two different zones share the beachname
// "Northern Erie Area Beaches" (Erie County PA under CLE, Erie County NY under
// BUF); they stay distinct by layer and centroid, and their names[] never
// overlap.
//
// The rip signal here overlaps src/clients/srfParser.js, which is the primary rip
// path. This module emits a resolved official flag color rather than a rip-risk
// input, so it does not double-count into estimateFlag, but keep one
// authoritative rip path per zone: never also feed this source's rip into the SRF
// input lane. Register it last in the scrapers array, since its bbox is broad and
// tighter single-city scrapers must win findScraper first.
//
// scrape() fetches cron-side only; the parsers are pure. Every path degrades to
// null, never throws across the module boundary, and never emits a color it
// cannot confirm.

import { fetchText, perBeachResult, FLAG_SEVERITY } from "./util.js";
import { waveColorForHeight } from "../rules.js";

export const NWS_MARINE_BEACH_MAP_URL =
  "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/" +
  "marine_beachforecast/MapServer";

const NWS_MARINE_BEACH_LABEL = "NWS Marine Beach Forecast";

// A Day-1 product older than this many days (by productdat vs nowIso) is treated
// as a stale cached response and dropped. The gate reads the date alone, so a
// 2-day slack avoids rejecting a same-day product read across midnight UTC.
export const STALE_MAX_DAYS = 2;

// Thirty hours: a Day-1 product is reissued each morning, so a record that has
// outlived the next issuance is genuinely stale.
export const FORECAST_STALE_MS = 30 * 60 * 60 * 1000;

// producttim's zone abbreviation -> UTC offset in minutes. An abbreviation
// outside this table makes the time unparseable and the stamp falls back.
const ZONE_OFFSET_MINUTES = {
  EDT: -240, EST: -300,
  CDT: -300, CST: -360,
  MDT: -360, MST: -420,
  PDT: -420, PST: -480,
  AKDT: -480, AKST: -540,
  HST: -600,
  AST: -240, ADT: -180
};

// VERIFIED-live Great Lakes Day-1 layers only. Each id maps a WFO to the
// SITE_DEFS whose layer field matches. Add a layer here only after confirming
// it returns features live.
const ACTIVE_LAYERS = [
  { id: 19, wfo: "CLE" },
  { id: 7, wfo: "BUF" }
];

// Curated zone bindings. Each def ties a live zone (matched by lowercase
// beachname within a specific layer) to swim.report beaches via iconic
// name substrings (unique tokens only, to avoid cross-attributing a namesake
// beach) and a shoreline centroid + radiusMi proximity fallback. Colors are
// never stored here — they come live from the feature.
export const SITE_DEFS = [
  // --- CLE (layer 19): Lake Erie, Ohio west->east + Erie County PA ---
  { layer: 19, zone: "lucas area beaches", siteId: "cle-lucas",
    names: ["maumee bay"], lat: 41.686, lon: -83.375, radiusMi: 12 },
  { layer: 19, zone: "ottawa beach area", siteId: "cle-ottawa",
    names: ["east harbor", "catawba island", "marblehead"], lat: 41.545, lon: -82.760, radiusMi: 15 },
  { layer: 19, zone: "erie area beaches", siteId: "cle-erie-oh",
    names: ["vermilion"], lat: 41.405, lon: -82.560, radiusMi: 13 },
  { layer: 19, zone: "lorain area beaches", siteId: "cle-lorain",
    names: ["lakeview park", "lorain"], lat: 41.478, lon: -82.170, radiusMi: 11 },
  { layer: 19, zone: "cuyahoga area beaches", siteId: "cle-cuyahoga",
    names: ["edgewater", "euclid beach", "villa angela"], lat: 41.489, lon: -81.738, radiusMi: 16 },
  { layer: 19, zone: "lake area beaches", siteId: "cle-lake",
    names: ["headlands", "mentor"], lat: 41.757, lon: -81.283, radiusMi: 12 },
  { layer: 19, zone: "ashtabula area beaches", siteId: "cle-ashtabula",
    names: ["ashtabula", "geneva state", "geneva-on-the-lake"], lat: 41.900, lon: -80.790, radiusMi: 15 },
  { layer: 19, zone: "northern erie area beaches", siteId: "cle-erie-pa",
    names: ["presque isle"], lat: 42.155, lon: -80.115, radiusMi: 15 },

  // --- BUF (layer 7): Lake Erie NY + Lake Ontario NY, SW->NE ---
  { layer: 7, zone: "chautauqua area beaches", siteId: "buf-chautauqua",
    names: ["dunkirk", "barcelona", "wright park"], lat: 42.487, lon: -79.335, radiusMi: 15 },
  { layer: 7, zone: "southern erie area beaches", siteId: "buf-erie-south",
    names: ["evangola", "sturgeon point"], lat: 42.598, lon: -79.115, radiusMi: 12 },
  { layer: 7, zone: "northern erie area beaches", siteId: "buf-erie-north",
    names: ["woodlawn beach", "hamburg beach", "bennett beach"], lat: 42.795, lon: -78.845, radiusMi: 12 },
  { layer: 7, zone: "niagara area beaches", siteId: "buf-niagara",
    names: ["olcott", "wilson", "fort niagara", "krull park"], lat: 43.335, lon: -78.720, radiusMi: 16 },
  { layer: 7, zone: "orleans area beaches", siteId: "buf-orleans",
    names: ["lakeside beach", "point breeze"], lat: 43.372, lon: -78.195, radiusMi: 14 },
  { layer: 7, zone: "monroe area beaches", siteId: "buf-monroe",
    names: ["ontario beach", "durand", "hamlin beach"], lat: 43.258, lon: -77.605, radiusMi: 18 },
  { layer: 7, zone: "wayne area beaches", siteId: "buf-wayne",
    names: ["sodus", "pultneyville"], lat: 43.270, lon: -76.965, radiusMi: 14 },
  { layer: 7, zone: "northern cayuga area beaches", siteId: "buf-cayuga",
    names: ["fair haven"], lat: 43.330, lon: -76.700, radiusMi: 12 },
  { layer: 7, zone: "oswego area beaches", siteId: "buf-oswego",
    names: ["selkirk", "mexico point", "oswego"], lat: 43.550, lon: -76.205, radiusMi: 16 },
  { layer: 7, zone: "jefferson area beaches", siteId: "buf-jefferson",
    names: ["southwick", "sackets harbor"], lat: 43.905, lon: -76.180, radiusMi: 16 }
];

// Coarse overall gate: Lake Erie + Lake Ontario US shore. resolveSiteForBeach
// does the fine binding; this only decides which beaches this scraper OWNS in
// findScraper. Register Last so tighter scrapers win their own beaches first.
function inGreatLakesEastBox(beach) {
  return typeof beach.lat === "number" && typeof beach.lon === "number" &&
    beach.lat >= 41.3 && beach.lat <= 44.3 &&
    beach.lon >= -84.0 && beach.lon <= -75.7;
}

// Pure. NWS "Swim Risk" / rip word -> hazard color, or null (never guess).
// Only Low/Moderate/High are recognized; anything else degrades to null.
export function normalizeRipColor(rip) {
  if (typeof rip !== "string") {
    return null;
  }
  const key = rip.trim().toLowerCase();
  if (key === "low") {
    return "green";
  }
  if (key === "moderate") {
    return "yellow";
  }
  if (key === "high") {
    return "red";
  }
  return null;
}

// Pure. Parse a surf-condition string to the MAXIMUM foot value it names, or
// null when it names no height in feet. Conservative on purpose: a phrase like
// "2 to 4 feet subsiding to 2 feet or less." reports the 4 ft peak so we never
// under-report the day's hazard. Requires an explicit feet/foot/ft token AND at
// least one number, else null (so "flat"/"calm"/garbage -> null).
export function parseSurfFeet(surf) {
  if (typeof surf !== "string" || surf.length === 0) {
    return null;
  }
  if (!/\b(?:feet|foot|ft)\b/i.test(surf)) {
    return null;
  }
  const matches = surf.match(/\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) {
    return null;
  }
  let max = null;
  for (let i = 0; i < matches.length; i++) {
    const n = parseFloat(matches[i]);
    if (isFinite(n) && (max === null || n > max)) {
      max = n;
    }
  }
  return max;
}

// Pure. Surf string -> hazard color via the default (Great Lakes) wave
// thresholds, or null. Every enabled layer is a Great Lakes forecast.
export function surfColor(surf) {
  const feet = parseSurfFeet(surf);
  if (feet === null) {
    return null;
  }
  return waveColorForHeight(feet);
}

// Pure. Most severe of two colors by FLAG_SEVERITY. null is "no signal".
function mostSevereColor(a, b) {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  const ra = FLAG_SEVERITY[a];
  const rb = FLAG_SEVERITY[b];
  if (typeof ra !== "number" || typeof rb !== "number") {
    return null;
  }
  return ra >= rb ? a : b;
}

// Pure. Combine a zone's rip and surf into ONE hazard color, or null when
// neither axis is confidently classifiable.
export function colorFromConditions(rip, surf) {
  return mostSevereColor(normalizeRipColor(rip), surfColor(surf));
}

// Pure. productdat like "7/22/2026" -> epoch ms at UTC midnight of that date, or
// null on unparseable input.
export function productDateMs(productdat) {
  if (typeof productdat !== "string") {
    return null;
  }
  const m = productdat.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) {
    return null;
  }
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (!isFinite(month) || !isFinite(day) || !isFinite(year) ||
      month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const ms = Date.UTC(year, month - 1, day);
  return isFinite(ms) ? ms : null;
}

// Pure. Is the product date within STALE_MAX_DAYS of nowIso? Unparseable
// productdat or nowIso -> false (fail closed: a reading we cannot date is not
// trusted as fresh). Interprets the passed-in nowIso only; no wall clock.
export function isFreshProduct(productdat, nowIso) {
  const productMs = productDateMs(productdat);
  if (productMs === null) {
    return false;
  }
  const nowMs = Date.parse(nowIso);
  if (!isFinite(nowMs)) {
    return false;
  }
  const diffDays = Math.abs(nowMs - productMs) / (24 * 60 * 60 * 1000);
  return diffDays <= STALE_MAX_DAYS;
}

/**
 * The product's issuance instant: productdat + producttim ("416 AM EDT") in the
 * office's zone, else a finite idp_filedate (epoch ms), else null.
 * @param {?string} productdat "M/D/YYYY"
 * @param {?string} producttim "HMM AM ZONE" or "HHMM PM ZONE"
 * @param {?number} idpFileDate the layer's GIS file date, epoch ms
 * @returns {?string} ISO instant, never guessed
 */
export function productIssuanceIso(productdat, producttim, idpFileDate) {
  const dateMs = productDateMs(productdat);
  if (dateMs !== null && typeof producttim === "string") {
    const m = producttim.trim().match(/^(\d{1,2})(\d{2}) (AM|PM) ([A-Z]{2,4})$/);
    if (m) {
      let hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      const offset = ZONE_OFFSET_MINUTES[m[4]];
      if (hour >= 1 && hour <= 12 && minute <= 59 && offset !== undefined) {
        if (m[3] === "AM" && hour === 12) {
          hour = 0;
        } else if (m[3] === "PM" && hour !== 12) {
          hour = hour + 12;
        }
        const ms = dateMs + hour * 3600000 + minute * 60000 - offset * 60000;
        return new Date(ms).toISOString();
      }
    }
  }
  if (typeof idpFileDate === "number" && Number.isFinite(idpFileDate)) {
    return new Date(idpFileDate).toISOString();
  }
  return null;
}

// Pure, exported for tests. One layer's ArcGIS query JSON text -> a plain object
// mapping lowercase beachname -> { beachname, color, updated } for every fresh,
// confidently-classifiable feature with a resolvable issuance. Returns null on
// malformed/non-feature JSON, unparseable nowIso, or when zero features were
// recognized (unusable body). Tolerates both Esri (feature.attributes) and
// GeoJSON (feature.properties). A zone named twice takes the last fresh feature.
export function parseLayerZones(text, nowIso) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    console.log("nwsMarineBeachForecast: JSON parse failed: " + err.message);
    return null;
  }
  if (!data || !Array.isArray(data.features)) {
    return null;
  }
  if (!isFinite(Date.parse(nowIso))) {
    console.log("nwsMarineBeachForecast: unparseable nowIso: " + String(nowIso));
    return null;
  }
  const zones = Object.create(null);
  let recognized = 0;
  for (const feature of data.features) {
    if (!feature) {
      continue;
    }
    let attrs = null;
    if (feature.attributes && typeof feature.attributes === "object") {
      attrs = feature.attributes;
    } else if (feature.properties && typeof feature.properties === "object") {
      attrs = feature.properties;
    }
    if (!attrs) {
      continue;
    }
    const name = typeof attrs.beachname === "string" ? attrs.beachname.trim() : "";
    if (name.length === 0) {
      continue;
    }
    // Staleness gate: drop a feature whose product date is missing or too old,
    // so a stale cached response can never surface an official color.
    if (!isFreshProduct(attrs.productdat, nowIso)) {
      continue;
    }
    const color = colorFromConditions(attrs.rip, attrs.surf);
    if (color === null) {
      continue;
    }
    // A color with no issuance instant is dropped: the stamp is what lets
    // displayFlag age the forecast, and a cron-tick stamp would never age.
    const updated = productIssuanceIso(attrs.productdat, attrs.producttim, attrs.idp_filedate);
    if (updated === null) {
      continue;
    }
    zones[name.toLowerCase()] = { beachname: name, color: color, updated: updated };
    recognized = recognized + 1;
  }
  if (recognized === 0) {
    console.log("nwsMarineBeachForecast: no classifiable zones in layer body");
    return null;
  }
  return zones;
}

// Pure, exported for tests. Map(layerId -> zonesObject) -> sites[]. Walks the
// curated SITE_DEFS and, for each whose live zone color and issuance stamp are
// present, emits one contract-v2 site (names + centroid for resolveSiteForBeach)
// carrying updated. A zone with no live color or no stamp yields no site, so
// the registry's result-level updated fallback is never reached from here.
export function buildSites(zoneColorsByLayer) {
  const sites = [];
  if (!zoneColorsByLayer || typeof zoneColorsByLayer.get !== "function") {
    return sites;
  }
  for (let i = 0; i < SITE_DEFS.length; i++) {
    const def = SITE_DEFS[i];
    const zones = zoneColorsByLayer.get(def.layer);
    if (!zones) {
      continue;
    }
    const entry = zones[def.zone];
    if (!entry || FLAG_SEVERITY[entry.color] === undefined) {
      continue;
    }
    if (typeof entry.updated !== "string" || entry.updated.length === 0) {
      continue;
    }
    sites.push({
      siteId: def.siteId,
      color: entry.color,
      reason: "Forecast swim risk and surf conditions from " +
        NWS_MARINE_BEACH_LABEL + " for the " + entry.beachname + " zone",
      updated: entry.updated,
      names: def.names,
      lat: def.lat,
      lon: def.lon,
      radiusMi: def.radiusMi
    });
  }
  return sites;
}

// Pure. The per-layer query URL.
export function layerQueryUrl(layerId) {
  return NWS_MARINE_BEACH_MAP_URL + "/" + String(layerId) +
    "/query?where=1%3D1&outFields=*&returnGeometry=false&f=json";
}

export const nwsMarineBeachForecast = {
  id: "nws-marine-beach-forecast",
  label: NWS_MARINE_BEACH_LABEL,
  url: NWS_MARINE_BEACH_MAP_URL,
  // A forecast for the day, not a flag someone raised; the registry copies it
  // onto the record and the detail page words the badge and verdict by it.
  kind: "forecast",
  staleMs: FORECAST_STALE_MS,
  // Rendered with the age appended: "Forecast issued 6 hours ago."
  readingNote: "Forecast issued",
  matches: function(beach) {
    return inGreatLakesEastBox(beach);
  },
  scrape: async function(nowIso) {
    const zoneColorsByLayer = new Map();
    let anyOk = false;
    for (let i = 0; i < ACTIVE_LAYERS.length; i++) {
      const layer = ACTIVE_LAYERS[i];
      const text = await fetchText(layerQueryUrl(layer.id), {
        logPrefix: "nwsMarineBeachForecast: fetch failed for layer " + layer.id
      });
      if (text === null) {
        continue;
      }
      try {
        const zones = parseLayerZones(text, nowIso);
        if (zones !== null) {
          zoneColorsByLayer.set(layer.id, zones);
          anyOk = true;
        }
      } catch (err) {
        console.log("nwsMarineBeachForecast: parse threw for layer " +
          layer.id + ": " + err.message);
      }
    }
    // No layer produced usable data -> null (a real failure for health).
    if (!anyOk) {
      return null;
    }
    const sites = buildSites(zoneColorsByLayer);
    if (sites.length === 0) {
      return null;
    }
    // Every site carries its own issuance stamp, which the registry prefers;
    // nowIso here is the result-level default no site falls back to.
    return perBeachResult(sites, NWS_MARINE_BEACH_MAP_URL, nowIso);
  }
};
