// src/wqFloor/erieCountyPaKml.js
//
// KIND: water-quality FLOOR source (src/wqFloor). RAISE-ONLY. This is NOT an
// official-source scraper: it feeds rules.js estimateFlag's
// waterQualityAdvisory input (step 7), where an active advisory can lift a
// flag UP to yellow/red (worst-of) but can NEVER pull a hazard estimate down. A
// clean/open reading is modeled as the ABSENCE of an advisory (no site -> null
// -> zero effect), so a clean-water "green" can never mask a wave/rip/alert red.
// That is precisely why a water-quality source must live here and NEVER in
// src/officialSources/ (an official color OVERRIDES the estimate everywhere).
//
// SOURCE: Erie County (PA) Department of Health beach + HAB monitoring for
// Presque Isle State Park, published as a Google MyMaps map. The county's
// public status scheme (from the Beach Water Testing Results page) is:
//   green  = beach is OPEN to swimming
//   yellow = precautionary / swimming advisory with risk-reduction guidance
//   red    = swimming is NOT PERMITTED until water quality improves
// plus a separate Harmful Algal Bloom (HAB) task force that samples toxins
// (microcystin, etc.); a toxin EXCEEDANCE is a red-tier closure.
//
// COLOR / FLOOR MAPPING (raise-only; green/clean => NO site, never a floor):
//   description indicates a closure / "not permitted" / "prohibited" /
//     "no swimming" / a HAB toxin "exceed(s/ance)"      -> RED floor
//   description indicates an "advisory" / "precaution" / "caution" /
//     "elevated" (and is not a "no advisory"/"lifted" clear) -> YELLOW floor
//   anything else (open, permitted, clean, unrecognized)     -> no site (null)
// double-red / green / unknown are never emitted (WQ floors are yellow|red only;
// the registry resolver and rules.js step 7 both independently reject others).
//
// FETCH URL STATUS: **UNCONFIRMED**. The Google MyMaps KML export URL
// (https://www.google.com/maps/d/kml?mid=<MID>&forcekml=1) requires the map's
// opaque mid, which is not present in the raw HTML of the county pages fetched
// during authoring (the map is embedded via a client-side widget). Per the
// build brief this ships the PURE, tested parser and FAILS CLOSED: scrape()
// returns null (no fetch, no floor) until an integrator fills in a confirmed
// no-auth KML endpoint at ERIE_COUNTY_PA_KML_URL. Set it via the standard
// forcekml export once the mid is verified against the live MyMaps page. Do NOT
// probe for hidden endpoints or bypass any bot/auth protection to obtain it.
//
// DEDUP NOTE FOR THE INTEGRATOR: this is a NEW axis (water quality) for a NEW
// region (Presque Isle / Erie, PA). It does not overlap any registered hazard
// scraper or the Ohio/Chicago/Michigan water sources. No dedup concern.
//
// scrape() runs cron-side ONLY. parseErieCountyPaKml / classifyErieStatus are
// pure and exported for tests. There is NO DOMParser in Workers, so parsing is
// defensive regex/string work: any markup or schema change degrades to null (or
// omits the affected placemark), NEVER a wrong color.

import { fetchText } from "../officialSources/util.js";

// Human label for the estimate card and the advisory reason.
export const ERIE_COUNTY_PA_LABEL = "Erie County (PA) Department of Health";

// Confirmed human-readable page (used as the estimate-card infoUrl). This is an
// HTML info page, NOT the KML feed — never parse it for a color.
export const ERIE_COUNTY_PA_INFO_URL =
  "https://eriecountypa.gov/departments/health/services-and-programs/health-and-wellness/beach-water-testing-results/";

// **UNCONFIRMED** Google MyMaps KML export endpoint. Left empty on purpose so
// scrape() fails closed (returns null, no floor) until an integrator confirms
// the live map's mid and sets this to, e.g.,
//   "https://www.google.com/maps/d/kml?mid=<VERIFIED_MID>&forcekml=1"
// forcekml=1 makes MyMaps return inline KML rather than a KMZ zip.
export const ERIE_COUNTY_PA_KML_URL = "";

// Presque Isle State Park sits on a sandspit peninsula NW of Erie, PA. Bounding
// box used both to gate matches() and to sanity-check parsed KML coordinates so
// a garbage/relocated placemark can never bind to a beach.
const ERIE_BOX = { south: 42.05, north: 42.25, west: -80.30, east: -79.95 };

// Generous coordinate-validity range (slightly wider than ERIE_BOX) — a
// placemark whose parsed point falls outside this is treated as having no
// usable coordinate (it may still resolve by a distinctive name).
const COORD_RANGE = { south: 41.9, north: 42.4, west: -80.5, east: -79.7 };

// Proximity radius for numeric ("Beach 6") placemarks that resolve by location
// only (see deriveNames). resolveSiteForBeach picks the NEAREST site within its
// radius, so a modest overlap between neighboring beaches is fine — the closest
// placemark wins. Kept tight because Presque Isle's numbered beaches are near
// one another.
const SITE_RADIUS_MI = 0.75;

// Cap on placemarks parsed from one document — defensive against a pathological
// or hostile body.
const MAX_PLACEMARKS = 300;

// Generic name tokens that carry no disambiguating power. A placemark whose name
// reduces to only these gets NO names[] (it must resolve by proximity), so a
// bare "Beach" can never substring-match every beach in the region.
const GENERIC_NAME_WORDS = {
  presque: true, isle: true, beach: true, beaches: true, state: true,
  park: true, the: true, at: true, of: true, and: true, area: true,
  guarded: true, lifeguarded: true, swimming: true, water: true
};

// Pure. Decode the handful of XML/HTML entities that appear in MyMaps text and
// strip CDATA wrappers + tags, then collapse whitespace. Used for both the
// placemark name and the description. Never throws on odd input.
function decodeAndStrip(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  let text = raw;
  // Unwrap CDATA sections (descriptions are almost always CDATA-wrapped HTML).
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Drop tags.
  text = text.replace(/<[^>]*>/g, " ");
  // Decode common entities (order matters: &amp; last would double-decode, so
  // decode the named ones first, then the numeric, then bare &amp;).
  text = text.replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#0*39;/g, "'")
    .replace(/&#0*34;/g, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
  return text.replace(/\s+/g, " ").trim();
}

// Pure. True when the normalized (lowercase) description names an algal-bloom /
// toxin hazard, so the reason string can say "harmful algal bloom" rather than a
// generic "water quality".
function detectHab(text) {
  return /\b(harmful algal|algal bloom|algae bloom|\bhab\b|cyanobacter|microcystin|anatoxin|saxitoxin|cylindrospermopsin|toxin)\b/.test(text);
}

// Pure, exported for tests. Classify one placemark's raw description into a
// water-quality FLOOR color, or null. null means "clean / open / unrecognized"
// -> NO floor (the absence of an advisory), which is the safe default: a floor
// can only ever RAISE a flag, so failing to a floor of null never masks a
// hazard. Never emits green/double-red/unknown. Never throws.
//
// Priority is worst-of: RED (closure / toxin exceedance) is checked before
// YELLOW (advisory / precaution). Risky tokens are guarded against their
// negations ("does not exceed", "no advisory", "lifted") so a clean placemark
// cannot false-positive to a color.
export function classifyErieStatus(rawDescription) {
  const text = decodeAndStrip(rawDescription).toLowerCase();
  if (text.length === 0) {
    return null;
  }

  // --- RED: affirmative closure or a toxin/bacteria threshold exceedance. ---
  // These phrases match the county's own "swimming is not permitted" red state
  // and a HAB "exceeds" reading. "closed"/"closure" are deliberately NOT used
  // as red triggers because "not closed" / "no closure" would false-red; the
  // documented red wording is "not permitted", which is unambiguous.
  if (/\bnot permitted\b/.test(text)) {
    return "red";
  }
  if (/\bprohibited\b/.test(text)) {
    return "red";
  }
  if (/\bdo not swim\b/.test(text)) {
    return "red";
  }
  // "no swimming" is red UNLESS it is the head of "no swimming advisory"
  // (which is the negated/clean form handled below as yellow-clear).
  if (/\bno swimming\b(?!\s+advisor)/.test(text)) {
    return "red";
  }
  // A toxin/bacteria exceedance, guarded so "does not exceed" / "not exceed" /
  // "below ... exceed" negations do not fire. Lookbehind is supported by the
  // V8 engine both Workers and Vitest run on.
  if (/(?<!not )(?<!not\s)(?<!doesn't )exceed(s|ed|ance)?\b/.test(text) &&
      !/\b(does not|do not|did not|below|within|under)\b[^.]*exceed/.test(text)) {
    return "red";
  }

  // --- YELLOW: an active advisory / precaution, but not a negated/lifted one. ---
  const isCleared =
    /\bno (current |active )?(swimming |water quality )?advisor(y|ies)\b/.test(text) ||
    /advisor(y|ies)[^.]*\b(lifted|rescinded|removed|cancell?ed|expired)\b/.test(text) ||
    /\b(lifted|rescinded)\b[^.]*advisor(y|ies)/.test(text) ||
    /\bno advisor(y|ies) (in effect|at this time|currently)\b/.test(text);
  if (!isCleared) {
    if (/\badvisor(y|ies)\b/.test(text)) {
      return "yellow";
    }
    if (/\bprecaution(ary)?\b/.test(text)) {
      return "yellow";
    }
    if (/\buse caution\b/.test(text)) {
      return "yellow";
    }
    if (/\belevated\b/.test(text)) {
      return "yellow";
    }
  }

  // Open / permitted / clean / anything unrecognized -> no floor.
  return null;
}

// Pure. Lowercase placemark name -> names[] for resolveSiteForBeach, or null to
// force proximity-only resolution.
//
// Substring matching (resolveSiteForBeach) makes numeric names dangerous:
// "beach 1" is a substring of "beach 10" and "beach 11", so a name ending in a
// digit could attribute one beach's advisory to a sibling. Such placemarks get
// NO names[] and resolve by proximity (nearest-wins) instead. A name is only
// turned into a names[] entry when it ends in a non-digit AND carries a
// distinctive (non-generic) alphabetic token, e.g. "barracks beach",
// "mill road beach".
function deriveNames(normName) {
  if (typeof normName !== "string" || normName.length === 0) {
    return null;
  }
  if (/\d\s*$/.test(normName)) {
    return null;
  }
  const tokens = normName.split(/[^a-z0-9]+/);
  let distinctive = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length >= 3 && /[a-z]/.test(t) && !GENERIC_NAME_WORDS[t]) {
      distinctive = true;
      break;
    }
  }
  if (!distinctive) {
    return null;
  }
  return [normName];
}

// Pure. Slugify a placemark name into a stable siteId. Falls back to an index.
function slugifyName(normName, index) {
  const slug = (normName || "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length > 0) {
    return slug;
  }
  return "placemark-" + String(index);
}

// Pure. Parse a "lon,lat[,alt]" coordinate string (KML order is lon,lat) into
// { lat, lon } within COORD_RANGE, or null. Only the first tuple is used
// (Points carry one; a stray LineString/Polygon coord list degrades to its
// first vertex, harmless because such features rarely classify to a floor).
function parseCoordinates(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const firstTuple = trimmed.split(/\s+/)[0];
  const parts = firstTuple.split(",");
  if (parts.length < 2) {
    return null;
  }
  const lon = parseFloat(parts[0]);
  const lat = parseFloat(parts[1]);
  if (!isFinite(lon) || !isFinite(lat)) {
    return null;
  }
  if (lat < COORD_RANGE.south || lat > COORD_RANGE.north ||
      lon < COORD_RANGE.west || lon > COORD_RANGE.east) {
    return null;
  }
  return { lat: lat, lon: lon };
}

// Pure. Extract the inner text of the FIRST <tag>...</tag> in block, or "".
function firstTag(block, tag) {
  const re = new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i");
  const m = re.exec(block);
  return m ? m[1] : "";
}

// Pure, exported for tests. KML text (+ the cron's ISO timestamp) -> floor
// sites[] (possibly empty for a parsed-but-all-clean map), or null when the body
// is not usable KML at all (empty, non-string, or no <kml>/<Placemark> markers
// -> a total parse failure, treated as no-data rather than "all clear").
//
// Each placemark is classified by its description; only yellow/red placemarks
// with a resolvable binding (valid coordinate OR a distinctive name) become
// sites. Green/clean/unrecognized placemarks are omitted (no site). One
// unparseable placemark never discards the others.
export function parseErieCountyPaKml(kmlText, nowIso) {
  if (typeof kmlText !== "string" || kmlText.length === 0) {
    return null;
  }
  const body = kmlText.charCodeAt(0) === 0xfeff ? kmlText.slice(1) : kmlText;
  if (!/<kml\b/i.test(body) && !/<Placemark\b/i.test(body)) {
    console.log("erieCountyPaKml: body is not KML (no <kml>/<Placemark>)");
    return null;
  }

  const placemarkRe = /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi;
  const sites = [];
  const usedSiteIds = {};
  let match = null;
  let count = 0;
  while ((match = placemarkRe.exec(body)) !== null) {
    count = count + 1;
    if (count > MAX_PLACEMARKS) {
      console.log("erieCountyPaKml: placemark cap reached, ignoring the rest");
      break;
    }
    const block = match[1];

    const rawDescription = firstTag(block, "description");
    const floorColor = classifyErieStatus(rawDescription);
    if (floorColor === null) {
      // Clean / open / unrecognized: the absence of an advisory. No floor.
      continue;
    }

    const normName = decodeAndStrip(firstTag(block, "name")).toLowerCase();
    const coords = parseCoordinates(firstTag(block, "coordinates"));
    const names = deriveNames(normName);
    if (!coords && !names) {
      // A flagged placemark we cannot bind to a beach (no usable coordinate and
      // no distinctive name). Omit it rather than guess a binding.
      console.log("erieCountyPaKml: flagged placemark has no usable coordinate or name, omitting");
      continue;
    }

    let siteId = slugifyName(normName, count);
    if (usedSiteIds[siteId]) {
      siteId = siteId + "-" + String(count);
    }
    usedSiteIds[siteId] = true;

    const descText = decodeAndStrip(rawDescription).toLowerCase();
    const hab = detectHab(descText);
    const displayName = normName.length > 0 ? normName : "presque isle beach";
    let reason;
    if (floorColor === "red") {
      reason = displayName +
        (hab ? ": harmful algal bloom exceedance - swimming not permitted"
             : ": water-quality closure - swimming not permitted");
    } else {
      reason = displayName +
        (hab ? ": harmful algal bloom advisory" : ": water-quality advisory");
    }

    const site = {
      siteId: siteId,
      floorColor: floorColor,
      reason: reason,
      radiusMi: SITE_RADIUS_MI,
      updated: typeof nowIso === "string" && nowIso.length > 0 ? nowIso : undefined
    };
    if (names) {
      site.names = names;
    }
    if (coords) {
      site.lat = coords.lat;
      site.lon = coords.lon;
    }
    sites.push(site);
  }

  return sites;
}

// Pure. matches() gate: a Presque Isle / Erie, PA lakefront beach.
function inErieBox(beach) {
  return typeof beach.lat === "number" && typeof beach.lon === "number" &&
    beach.lat >= ERIE_BOX.south && beach.lat <= ERIE_BOX.north &&
    beach.lon >= ERIE_BOX.west && beach.lon <= ERIE_BOX.east;
}

export const erieCountyPaKml = {
  id: "erie-county-pa-kml",
  label: ERIE_COUNTY_PA_LABEL,
  infoUrl: ERIE_COUNTY_PA_INFO_URL,
  matches: function(beach) {
    if (/presque isle/i.test(beach.name || "")) {
      return true;
    }
    if (/presque isle/i.test(beach.park_name || "")) {
      return true;
    }
    return inErieBox(beach);
  },
  scrape: async function(nowIso) {
    // Fail closed until the KML export URL is confirmed. Shipping the parser
    // without a live endpoint is intentional (see the header note): a null here
    // simply means "no floor", never a wrong color.
    if (!ERIE_COUNTY_PA_KML_URL) {
      console.log("erieCountyPaKml: KML export URL not confirmed; skipping fetch (fail closed)");
      return null;
    }
    // MyMaps 302-redirects the export to a signed googleusercontent URL; follow
    // it. No User-Agent is sent unless the endpoint has been probed to need one.
    const kmlText = await fetchText(ERIE_COUNTY_PA_KML_URL, {
      redirect: "follow",
      logPrefix: "erieCountyPaKml: KML fetch failed"
    });
    if (kmlText === null) {
      return null;
    }
    try {
      const sites = parseErieCountyPaKml(kmlText, nowIso);
      if (sites === null) {
        // Unusable body (not KML) — a real failure.
        return null;
      }
      // sites may be [] (map parsed cleanly, every beach open) — a clean run
      // with nothing to report. It resolves to no floor for every beach.
      return {
        perBeach: true,
        sites: sites,
        source: ERIE_COUNTY_PA_LABEL,
        updated: nowIso
      };
    } catch (err) {
      console.log("erieCountyPaKml: parse failed: " + err.message);
      return null;
    }
  }
};
