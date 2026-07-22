// src/waveSources/nwsNshNearshore.js
//
// KIND: wave — a SUPPLEMENTAL fallback wave-height source (src/waveSources
// registry). It is NOT an official override and NOT a color source: it produces
// only a wave HEIGHT in feet that runWaveRefresh treats exactly like the
// primary Open-Meteo/GLOS reading (feeding the wave-height rule in
// src/rules.js: >=4 ft red, >=2 ft yellow, else green). Consulted ONLY for
// beaches whose primary wave height came back null, in registry order, first
// finite hit wins (never additive).
//
// SOURCE: NWS Nearshore Marine Forecast (product type "NSH"), keyed per beach
// by beach.marine_zone (e.g. "LMZ643"). The NSH product is issued per WFO and
// segmented per marine zone; each zone's segment carries a wrapped forecast
// phrase like "Waves 2 to 4 feet subsiding to 1 to 2 feet" or "Waves 1 foot or
// less". We take the UPPER bound of the FIRST wave phrase in the matched zone's
// segment as a representative near-term height, in whole feet.
//
// Fetch is a two-leg lookup keyed entirely off marine_zone (so the integrator's
// dedup-by-marine_zone covers both legs — see DEDUP NOTE):
//   1. GET https://api.weather.gov/zones/marine/{zone}  -> properties.cwa[0]
//      gives the issuing WFO (verified live: LMZ643 -> ["MKX"]).
//   2. GET https://api.weather.gov/products/types/NSH/locations/{WFO}/latest
//      -> productText (verified live; same /latest shape the SRF client uses).
// Then parseNshWaveFt(productText, zone, nowIso) pulls the zone's height.
//
// COLOR/FLOOR MAPPING: none. This source emits a numeric wave height only; the
// green/yellow/red decision stays solely in src/rules.js estimateFlag. We never
// emit a color and never a floor.
//
// INTEGRATOR DEDUP NOTE: many beaches share one marine_zone, and every beach in
// a WFO's coverage shares one NSH product. Dedup by marine_zone before fetching
// (fetch each unique zone ONCE per run and fan the ft to every beach sharing
// it) — otherwise a fully wave-null (winter) run issues two fetches per beach
// and blows the per-invocation subrequest budget. This module fetches for a
// single beach; the dedup/caps belong in the runWaveRefresh step-2b consult,
// not here. This is a WAVE-HEIGHT fallback only — do NOT read rip signal from
// the NSH text here; rip converges elsewhere and the SRF client stays primary.
//
// Two-path rule: waveFt fetches upstream and is reachable ONLY from the cron
// (runWaveRefresh). The request path never imports this network code. Error
// isolation: every path degrades to null on any missing field / unrecognized
// wording / unparseable segment — NEVER a wrong height (which would mis-color a
// flag). No template literals; string concat with + only; const/let only.

import { fetchJson } from "../clients/http.js";
import { NWS_USER_AGENT } from "../clients/nws.js";

export const NSH_MODEL = "nws_nsh_nearshore_wave";
export const NSH_LABEL = "NWS Nearshore Marine Forecast";
export const NSH_URL = "https://www.weather.gov/marine/";

// A marine/land UGC zone code: two letters, Z (zone) or C (county), 3 digits.
const ZONE_CODE_RE = /^[A-Z]{2}[ZC]\d{3}$/;

// Left-pad a zone number to the canonical 3 digits.
function pad3(n) {
  let s = String(n);
  while (s.length < 3) {
    s = "0" + s;
  }
  return s;
}

// Pure, exported for tests. Expand one NWS UGC header line into the explicit
// list of zone codes it names. Handles the list form ("LMZ643-644-645-646"),
// the range form ("LMZ643>646"), and mixed forms, tracking the running
// alpha prefix across bare 3-digit continuation tokens exactly like the UGC
// spec. The trailing 6-digit purge time (DDHHMM) and any unrecognized token are
// ignored defensively. Never throws; returns [] on garbage.
export function expandUgcZones(line) {
  if (typeof line !== "string") {
    return [];
  }
  const tokens = line.trim().split("-");
  const zones = [];
  let prefix = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].trim();
    if (t.length === 0) {
      continue;
    }
    // Trailing purge time (DDHHMM) — six digits, not a zone.
    if (/^\d{6}$/.test(t)) {
      continue;
    }
    // Range token: LMZ643>646 or a bare 643>646 continuation.
    const rangeM = /^(?:([A-Z]{2}[ZC]))?(\d{3})>(?:([A-Z]{2}[ZC]))?(\d{3})$/.exec(t);
    if (rangeM !== null) {
      if (rangeM[1]) {
        prefix = rangeM[1];
      }
      if (rangeM[3]) {
        prefix = rangeM[3];
      }
      if (prefix === null) {
        continue;
      }
      const start = parseInt(rangeM[2], 10);
      const end = parseInt(rangeM[4], 10);
      if (isFinite(start) && isFinite(end) && end >= start && (end - start) <= 999) {
        for (let n = start; n <= end; n++) {
          zones.push(prefix + pad3(n));
        }
      }
      continue;
    }
    // Full zone code: sets the running prefix.
    const fullM = /^([A-Z]{2}[ZC])(\d{3})$/.exec(t);
    if (fullM !== null) {
      prefix = fullM[1];
      zones.push(prefix + fullM[2]);
      continue;
    }
    // Bare 3-digit continuation, inherits the running prefix.
    if (/^\d{3}$/.test(t) && prefix !== null) {
      zones.push(prefix + t);
      continue;
    }
    // Anything else: ignore (defensive).
  }
  return zones;
}

// Is this line a UGC header (the zone list that opens a product segment)?
// Must start with a zone code, contain only UGC characters, and end with the
// 6-digit purge stamp. Anything else is forecast prose, not a header.
function isUgcHeader(line) {
  const s = line.trim();
  if (!/^[A-Z]{2}[ZC]\d{3}/.test(s)) {
    return false;
  }
  if (!/^[A-Z0-9>-]+$/.test(s)) {
    return false;
  }
  return /\d{6}-?$/.test(s);
}

// Does this product segment's UGC header(s) name the target zone?
function segmentCoversZone(segment, zone) {
  const lines = segment.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!isUgcHeader(lines[i])) {
      continue;
    }
    if (expandUgcZones(lines[i]).indexOf(zone) !== -1) {
      return true;
    }
  }
  return false;
}

// Extract the representative wave height (whole feet) from one segment's prose,
// or null. Whitespace is flattened first so a line-wrapped phrase ("Waves 2 to\n
// 4 feet") reads as one string. We match the FIRST "waves ... feet/foot" phrase
// and take the LAST number before that "feet"/"foot" — the upper bound of the
// leading range ("2 to 4 feet" -> 4; "1 foot or less" -> 1; "less than 1 foot"
// -> 1). The 0-60 char cap between "waves" and the unit keeps a stray "waves"
// mention from binding to a distant number. Implausible values (>30 ft, e.g. a
// misparsed stamp) degrade to null rather than a wrong height.
function extractWaveFt(segment) {
  const flat = segment.replace(/\s+/g, " ").toLowerCase();
  const m = /\bwaves\b(.{0,60}?)\b(?:feet|foot)\b/.exec(flat);
  if (m === null) {
    return null;
  }
  const nums = m[1].match(/\d+/g);
  if (nums === null || nums.length === 0) {
    return null;
  }
  const upper = parseInt(nums[nums.length - 1], 10);
  if (!isFinite(upper) || upper < 0 || upper > 30) {
    return null;
  }
  return upper;
}

// Pure, exported for tests. (productText, marineZone, nowIso) -> finite feet |
// null. Locates the zone's segment in the NSH product and returns the upper
// bound of its first wave phrase. nowIso is accepted for contract symmetry with
// the other supplemental sources (no clock is read — the parser stays pure).
// Any missing zone / unrecognized wording / malformed input degrades to null,
// never a wrong height.
export function parseNshWaveFt(text, marineZone, nowIso) {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  if (typeof marineZone !== "string" || marineZone.length === 0) {
    return null;
  }
  const zone = marineZone.trim().toUpperCase();
  if (!ZONE_CODE_RE.test(zone)) {
    return null;
  }
  const segments = text.split("$$");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!segmentCoversZone(seg, zone)) {
      continue;
    }
    const ft = extractWaveFt(seg);
    if (ft !== null) {
      return ft;
    }
    // Zone matched but this segment (e.g. the synopsis) carries no wave phrase;
    // keep scanning for the per-zone forecast segment.
  }
  return null;
}

// Pure guard: this source can serve a beach only if it carries a marine zone.
export function matches(beach) {
  return !!beach && typeof beach.marine_zone === "string" &&
    beach.marine_zone.trim().length > 0;
}

// Pure. The run-scoped dedup key: the NORMALIZED marine zone (same normalization
// waveFt applies), so all beaches in one zone — and every beach a WFO's NSH
// product covers — share one two-leg fetch. Matches the value keyed on so the
// memo's cached ft is exactly what waveFt would have produced. null when absent.
export function keyOf(beach) {
  if (!matches(beach)) {
    return null;
  }
  return beach.marine_zone.trim().toUpperCase();
}

// Cron-side ONLY. Resolve the beach's marine zone to its issuing WFO via the
// zone-metadata endpoint. Returns the WFO code or null. NEVER throws.
async function fetchWfoForZone(zone) {
  const url = "https://api.weather.gov/zones/marine/" + encodeURIComponent(zone);
  const json = await fetchJson(url, {
    headers: { "User-Agent": NWS_USER_AGENT, "Accept": "application/geo+json" },
    label: "nwsNshNearshore: zone " + zone
  });
  if (json === null) {
    return null;
  }
  try {
    const props = json.properties;
    if (!props || typeof props !== "object") {
      return null;
    }
    const cwa = props.cwa;
    if (Array.isArray(cwa) && cwa.length > 0 &&
        typeof cwa[0] === "string" && cwa[0].length > 0) {
      return cwa[0];
    }
    return null;
  } catch (err) {
    console.log("nwsNshNearshore: zone lookup parse failed for " + zone + ": " + err.message);
    return null;
  }
}

// Cron-side ONLY. Fetch the latest NSH product text for a WFO, or null. NEVER
// throws. Mirrors fetchLatestSrfText's /latest one-request pattern.
async function fetchNshProductText(wfo) {
  const url = "https://api.weather.gov/products/types/NSH/locations/" +
    encodeURIComponent(wfo) + "/latest";
  const json = await fetchJson(url, {
    headers: { "User-Agent": NWS_USER_AGENT },
    label: "nwsNshNearshore: NSH latest for " + wfo
  });
  if (json === null) {
    return null;
  }
  if (typeof json.productText !== "string" || json.productText.length === 0) {
    console.log("nwsNshNearshore: NSH latest for " + wfo + " missing productText");
    return null;
  }
  return json.productText;
}

// Cron-side ONLY. Resolves the beach's nearshore wave height in feet valid for
// its marine zone, or null. NEVER throws across the boundary.
async function waveFt(beach, nowIso, env) {
  if (!matches(beach)) {
    return null;
  }
  const zone = beach.marine_zone.trim().toUpperCase();
  const wfo = await fetchWfoForZone(zone);
  if (wfo === null) {
    return null;
  }
  const productText = await fetchNshProductText(wfo);
  if (productText === null) {
    return null;
  }
  try {
    return parseNshWaveFt(productText, zone, nowIso);
  } catch (err) {
    console.log("nwsNshNearshore: parse failed for beach " + beach.id + ": " + err.message);
    return null;
  }
}

// The supplemental wave-source object the registry (src/waveSources/index.js)
// consumes. Shape locked to { id, model, label, url, matches, waveFt }.
export const nwsNshNearshoreSource = {
  id: "nws-nsh-nearshore",
  model: NSH_MODEL,
  label: NSH_LABEL,
  url: NSH_URL,
  matches: matches,
  keyOf: keyOf,
  waveFt: waveFt
};

// Aliases so the integrator can import under either spelling used in the
// scaffolding notes without rework.
export { nwsNshNearshoreSource as nshSource };
export { nwsNshNearshoreSource as nshWaveSource };
