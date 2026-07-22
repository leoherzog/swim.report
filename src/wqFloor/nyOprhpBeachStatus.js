// src/wqFloor/nyOprhpBeachStatus.js
//
// KIND: wq — RAISE-ONLY water-quality FLOOR source (src/wqFloor registry, NOT an
// official scraper). Its site colors feed rules.js estimateFlag's
// "waterQualityAdvisory" input (step 7), where an active advisory can RAISE a
// flag UP to yellow/red (worst-of by SEVERITY_RANK) but can NEVER pull a hazard
// estimate down. A clean/open reading is modeled as the ABSENCE of a site
// (resolves to null -> zero color effect), so a clean-water "green" can never
// mask a wave/rip/alert red. This is water quality (E. coli / Enterococci / HAB),
// a DIFFERENT axis from the posted-flag hazard sources — it must live here, not
// in src/officialSources/ (an official color OVERRIDES the estimate everywhere).
//
// SOURCE: New York OPRHP (State Parks) Beach Status View — an unauthenticated
// ArcGIS FeatureServer. GET
//   https://services.arcgis.com/1xFZPtKn1wKC6POA/arcgis/rest/services/
//     2025_Beach_Status_view/FeatureServer/0/query?where=1=1&outFields=*&f=json
// Each feature.attributes carries: StateParkBeach, Beach_status
// (Open / Reopened / Closed / "Open with Advisory" / Off-Season), Status_Reason
// (Exceedance / "Harmful Algal Bloom" / "Clear after resample" / ...),
// Indicator_ (E.coli / Enterococci), Results (double), Date_sampled ("13-Jul-26"),
// Latitude, Longitude.
//
// NOTE: the version YEAR in the layer path ("2025_...") rolls each season. When
// it rolls, the pinned URL 404s -> fetchJson returns null -> scrape returns null
// (fail closed to no-floor, never a wrong color). The URL below MUST be
// re-confirmed / bumped when NYS publishes the next season's view. The live
// response shape was confirmed 2026-07; the parser degrades to null on any
// shape change (missing features array, unrecognized status).
//
// FLOOR MAPPING (raise-only; nothing else produces a site):
//   Beach_status "Closed"  AND  Status_Reason contains "Exceedance" or
//                                "Harmful Algal Bloom"        -> floorColor "red"
//   Beach_status "Open with Advisory"                         -> floorColor "yellow"
//   Open / Reopened / clean / Off-Season / Closed-for-any-
//     other-reason (e.g. off-season closure)                 -> NO site (null)
// Only the two water-quality closure reasons floor a "Closed" — a generic /
// off-season closure must never raise a flag to red.
//
// CURATION: NY has many inland + ocean beaches; this floor is scoped to the
// GREAT LAKES beaches only (Lake Ontario: Hamlin Beach, Fair Haven, Selkirk
// Shores; Lake Erie / Niagara: Evangola, Beaver Island), by name substring and
// lat/lon. matches() and the emitted sites cover only those.
//
// INTEGRATOR / DEDUP NOTE: register in src/wqFloor/index.js "wqFloorSources"
// (append; there is no ordering conflict — it is the only NY source). Do NOT add
// it to src/officialSources/index.js. Water quality is a NEW axis, disjoint from
// every hazard source (wave / rip / NWS+ECCC alerts) — no dedup concern. Its
// color effect is entirely inside the estimate (official:false).

import { fetchJson } from "../clients/http.js";
import { perBeachResult, DEFAULT_SITE_RADIUS_MI } from "../officialSources/util.js";
import { distanceMi } from "../geo.js";

export const NY_OPRHP_QUERY_URL =
  "https://services.arcgis.com/1xFZPtKn1wKC6POA/arcgis/rest/services/" +
  "2025_Beach_Status_view/FeatureServer/0/query?where=1%3D1&outFields=*&f=json";

export const NY_OPRHP_LABEL =
  "New York State Parks (OPRHP) Beach Water Quality";

export const NY_OPRHP_INFO_URL = "https://parks.ny.gov/";

// Great Lakes NYS-park beaches this floor covers. "aliases" are lowercase
// substrings matched BOTH against the ArcGIS StateParkBeach field (to pick the
// feature) and, as resolveSiteForBeach "names", against a swim.report beach's
// park_name + name. Keep them tight so a namesake elsewhere can never inherit a
// site's color. lat/lon anchor the proximity fallback and the emitted site.
const GREAT_LAKES_SITES = [
  { siteId: "hamlin-beach", aliases: ["hamlin beach"], lat: 43.362, lon: -77.947 },
  { siteId: "fair-haven", aliases: ["fair haven"], lat: 43.343, lon: -76.703 },
  { siteId: "selkirk-shores", aliases: ["selkirk shores", "selkirk"], lat: 43.535, lon: -76.203 },
  { siteId: "evangola", aliases: ["evangola"], lat: 42.601, lon: -79.160 },
  { siteId: "beaver-island", aliases: ["beaver island"], lat: 43.003, lon: -78.972 }
];

// How near (mi) a swim.report beach must sit to a curated site for the source's
// matches() proximity gate to fire, when the name substring does not.
const MATCH_RADIUS_MI = 4;

// Higher wins when a single park has several beach features (e.g. multiple swim
// areas) reporting different statuses — the most restrictive floor is kept.
const FLOOR_RANK = { yellow: 2, red: 3 };

const MONTH_INDEX = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

function pad2(n) {
  return n < 10 ? "0" + String(n) : String(n);
}

// Pure. Parse the ArcGIS "Date_sampled" string ("13-Jul-26", DD-Mon-YY) to an
// ISO-8601 UTC-midnight string, or null when it does not match the expected
// shape. Builds the string from parsed components only — no wall clock read.
export function parseSampledDate(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(raw.trim());
  if (!m) {
    return null;
  }
  const day = parseInt(m[1], 10);
  const month = MONTH_INDEX[m[2].toLowerCase()];
  const yy = parseInt(m[3], 10);
  if (!isFinite(day) || day < 1 || day > 31) {
    return null;
  }
  if (month === undefined) {
    return null;
  }
  if (!isFinite(yy)) {
    return null;
  }
  const fullYear = 2000 + yy;
  return String(fullYear) + "-" + pad2(month) + "-" + pad2(day) + "T00:00:00Z";
}

// Pure. Lowercase + trim a string field, or null when it is not a non-empty
// string. Used so a missing/blank status or reason degrades to "no floor".
function normalizeText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

// Pure. Map ONE feature's attributes to { floorColor, reason } or null (no
// floor). RAISE-ONLY: only "Open with Advisory" (yellow) and a "Closed" whose
// reason is a water-quality exceedance/HAB (red) produce a floor. Every other
// status — Open, Reopened, Off-Season, or a Closed for a non-water-quality
// reason — degrades to null so a benign/administrative state never raises a
// flag. Exported for tests.
export function mapStatusToFloor(attrs) {
  if (!attrs || typeof attrs !== "object") {
    return null;
  }
  const status = normalizeText(attrs.Beach_status);
  if (status === null) {
    return null;
  }
  const reasonText = normalizeText(attrs.Status_Reason);
  const isWaterQualityClosure = reasonText !== null &&
    (reasonText.indexOf("exceedance") !== -1 ||
      reasonText.indexOf("harmful algal") !== -1);

  if (status === "open with advisory") {
    return { floorColor: "yellow", reason: buildReason(attrs) };
  }
  if (status === "closed" && isWaterQualityClosure) {
    return { floorColor: "red", reason: buildReason(attrs) };
  }
  return null;
}

// Pure. Human-readable advisory detail from a feature's attributes. Defensive:
// each field is included only when it is a non-empty string.
function buildReason(attrs) {
  const status = typeof attrs.Beach_status === "string" ? attrs.Beach_status.trim() : "";
  const reason = typeof attrs.Status_Reason === "string" ? attrs.Status_Reason.trim() : "";
  const indicator = typeof attrs.Indicator_ === "string" ? attrs.Indicator_.trim() : "";
  let text = status.length > 0 ? status : "advisory";
  if (reason.length > 0) {
    text = text + " — " + reason;
  }
  if (indicator.length > 0) {
    text = text + " (" + indicator + ")";
  }
  return text;
}

// Pure. Does a curated site's aliases appear in a (lowercased) StateParkBeach
// field?
function siteMatchesFeatureName(site, loweredName) {
  for (let i = 0; i < site.aliases.length; i++) {
    if (loweredName.indexOf(site.aliases[i]) !== -1) {
      return true;
    }
  }
  return false;
}

// Pure, exported for tests. (json, nowIso) -> Site[] | null.
// "json" may be the parsed FeatureServer object or its raw text. Returns null on
// a total shape change (non-object / missing features array / empty features) so
// the caller degrades to no-floor rather than a wrong color. Otherwise returns a
// site per curated Great Lakes beach that currently carries a water-quality
// floor (possibly an empty array on a fully-clean run). Multiple features for
// one park roll up to the MOST SEVERE floor.
export function parseNyOprhpBeachStatus(json, nowIso) {
  let data = json;
  if (typeof json === "string") {
    try {
      data = JSON.parse(json);
    } catch (err) {
      console.log("nyOprhpBeachStatus: JSON parse failed: " + err.message);
      return null;
    }
  }
  if (!data || typeof data !== "object") {
    return null;
  }
  if (!Array.isArray(data.features) || data.features.length === 0) {
    // Missing/empty features array => layer shape changed or empty response.
    // Fail closed to null (no floor), never a guessed color.
    console.log("nyOprhpBeachStatus: no features array in response");
    return null;
  }

  // Accumulate the most-severe floor per curated site.
  const accum = Object.create(null);
  for (let f = 0; f < data.features.length; f++) {
    const feature = data.features[f];
    const attrs = feature && feature.attributes;
    if (!attrs || typeof attrs !== "object") {
      continue;
    }
    const loweredName = normalizeText(attrs.StateParkBeach);
    if (loweredName === null) {
      continue;
    }
    let site = null;
    for (let s = 0; s < GREAT_LAKES_SITES.length; s++) {
      if (siteMatchesFeatureName(GREAT_LAKES_SITES[s], loweredName)) {
        site = GREAT_LAKES_SITES[s];
        break;
      }
    }
    if (site === null) {
      continue;
    }
    const mapped = mapStatusToFloor(attrs);
    if (mapped === null) {
      continue;
    }
    const rank = FLOOR_RANK[mapped.floorColor];
    const current = accum[site.siteId];
    if (!current || rank > current.rank) {
      accum[site.siteId] = {
        site: site,
        floorColor: mapped.floorColor,
        reason: mapped.reason,
        rank: rank,
        updated: parseSampledDate(attrs.Date_sampled) || nowIso
      };
    }
  }

  const sites = [];
  for (let s = 0; s < GREAT_LAKES_SITES.length; s++) {
    const site = GREAT_LAKES_SITES[s];
    const entry = accum[site.siteId];
    if (!entry) {
      continue;
    }
    sites.push({
      siteId: site.siteId,
      floorColor: entry.floorColor,
      names: site.aliases,
      lat: site.lat,
      lon: site.lon,
      radiusMi: DEFAULT_SITE_RADIUS_MI,
      reason: entry.reason,
      updated: entry.updated
    });
  }
  return sites;
}

// Pure. True when a swim.report beach is one of the curated Great Lakes NYS-park
// beaches — by name substring OR lat/lon proximity to a curated site.
function inGreatLakesNyParks(beach) {
  const haystack = ((beach.park_name || "") + " " + (beach.name || "")).toLowerCase();
  for (let s = 0; s < GREAT_LAKES_SITES.length; s++) {
    const site = GREAT_LAKES_SITES[s];
    for (let a = 0; a < site.aliases.length; a++) {
      if (haystack.indexOf(site.aliases[a]) !== -1) {
        return true;
      }
    }
    if (typeof beach.lat === "number" && typeof beach.lon === "number") {
      if (distanceMi(beach.lat, beach.lon, site.lat, site.lon) <= MATCH_RADIUS_MI) {
        return true;
      }
    }
  }
  return false;
}

export const nyOprhpBeachStatus = {
  id: "ny-oprhp-beach-status",
  label: NY_OPRHP_LABEL,
  infoUrl: NY_OPRHP_INFO_URL,
  matches: function(beach) {
    return inGreatLakesNyParks(beach);
  },
  scrape: async function(nowIso) {
    const json = await fetchJson(NY_OPRHP_QUERY_URL, {
      label: "nyOprhpBeachStatus: beach status"
    });
    if (json === null) {
      return null;
    }
    try {
      const sites = parseNyOprhpBeachStatus(json, nowIso);
      if (!sites || sites.length === 0) {
        return null;
      }
      return perBeachResult(sites, NY_OPRHP_QUERY_URL, nowIso);
    } catch (err) {
      console.log("nyOprhpBeachStatus: parse failed: " + err.message);
      return null;
    }
  }
};
