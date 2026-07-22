// src/wqFloor/chautauquaCountyNy.js
//
// KIND: wq — RAISE-ONLY water-quality FLOOR source (src/wqFloor registry, NOT
// an official scraper). Its site colors feed rules.js estimateFlag's
// "waterQualityAdvisory" input (step 7), where an active bacteria/HAB
// advisory or closure can RAISE a flag UP to yellow/red (worst-of by
// SEVERITY_RANK) but can NEVER pull a hazard estimate down. A clean/open
// reading is modeled as the ABSENCE of a site (resolves to null -> zero
// color effect), so a clean-water "green" can never mask a wave/rip/alert
// red. This is water quality (bacteria / E. coli / harmful algal bloom), a
// DIFFERENT axis from posted-flag hazard sources — it must live here, not in
// src/officialSources/ (an official color OVERRIDES the estimate
// everywhere).
//
// SOURCE: Chautauqua County (NY) Health Department beach monitoring status
// page, covering the county's Lake Erie public bathing beaches: Point
// Gratiot (City of Dunkirk), Wright Park (City of Dunkirk), Irving (Town of
// Hanover), and Sunset Bay (Town of Hanover).
//
// FETCH URL: **UNCONFIRMED — needs integrator verification before wiring.**
// The county's site is served from chautauquacountyny.gov (a 2024
// county-website migration off chqgov.com); at the time this module was
// written, neither the historical chqgov.com Health Department path nor the
// obvious chautauquacountyny.gov equivalents (/health-human-services/
// environmental-health/beach-monitoring, /health-department/environmental-
// health/beach-monitoring) resolved — the health subdomain fails TLS
// hostname verification, and the migrated-domain paths returned 404. This
// module therefore ships with CHAUTAUQUA_BEACH_STATUS_URL left EMPTY and
// scrape() FAILS CLOSED (returns null without fetching) rather than trusting a
// plausible-but-wrong path to incidentally 404 into null — the same fail-
// closed-inert pattern erieCountyPaKml uses for its unconfirmed KML URL.
// Before registering this source in src/wqFloor/index.js, re-resolve the
// live URL (e.g. by browsing chautauquacountyny.gov's Health Department >
// Environmental Health section) and set the constant + update this comment.
//
// PARSER SHAPE: the page is assumed to be a server-rendered HTML status
// listing (a table or repeated status blocks), one entry per beach, each
// naming the beach and a status word/phrase. Because the exact markup could
// not be confirmed, parseChautauquaBeachStatus() does NOT depend on any
// specific tag structure — it strips all HTML to plain text, locates each
// curated beach name, and reads the status phrase in the text immediately
// following that name. This is deliberately tolerant of table/list/card
// markup differences, at the cost of being defeated by a beach name that
// appears with no nearby status text at all — which correctly degrades to
// "no site" for that beach, never a guessed color.
//
// FLOOR MAPPING (raise-only; nothing else produces a site):
//   status text contains a harmful-algal-bloom / HAB phrase           -> red
//   status text contains "closed" (bacteria/other non-HAB reason)     -> yellow
//   status text contains an advisory phrase ("advisory", "caution")   -> yellow
//   status text contains "satisfactory" / "open" / no matched keyword -> NO site
// HAB is checked before "closed" so a HAB closure is not miscategorized as
// only "yellow" — an active bloom is the more severe reading, so it maps to
// red. A generic "closed" (e.g. elevated bacteria / high turbidity / no
// lifeguard) maps to yellow, matching the raise-only floor's intent to flag
// something is off without asserting hazard-tier severity the source itself
// does not.
//
// CURATION: scoped to exactly the four Chautauqua County Lake Erie public
// beaches named in the source spec, matched by name substring (PASS 1, wins
// over proximity) and by lat/lon proximity (PASS 2 fallback) via the shared
// resolveSiteForBeach helper. Coordinates below are the beaches'
// approximate public-access points along the Dunkirk/Irving/Sunset Bay Lake
// Erie shoreline; treat as best-effort anchors for the proximity fallback,
// not surveyed precision — the name-substring match is the primary path.
//
// INTEGRATOR / DEDUP NOTE: register in src/wqFloor/index.js "wqFloorSources"
// (append; no ordering conflict with existing NY sources — nyOprhpBeachStatus
// covers NYS OPRHP *state park* beaches, which does not include any of these
// four county/municipal beaches). Do NOT add this to
// src/officialSources/index.js — water quality is a raise-only floor axis,
// disjoint from every hazard source (wave / rip / NWS alerts); no dedup
// concern. MUST confirm CHAUTAUQUA_BEACH_STATUS_URL (see above) before
// registering live.

import { fetchText, perBeachResult } from "../officialSources/util.js";

// **UNCONFIRMED** live status URL. Left EMPTY on purpose so scrape() fails
// closed (returns null, no fetch, no floor) until an integrator confirms the
// live path — the same fail-closed-inert pattern erieCountyPaKml uses for its
// unconfirmed KML export URL. Do NOT rely on an incidental fetch failure to
// degrade a plausible-but-wrong URL to null; a blank URL cannot fetch at all.
// Set this to the verified chautauquacountyny.gov Health Department beach-
// monitoring path once confirmed, and update the header comment.
export const CHAUTAUQUA_BEACH_STATUS_URL = "";

export const CHAUTAUQUA_LABEL =
  "Chautauqua County (NY) Health Department Beach Monitoring";

export const CHAUTAUQUA_INFO_URL =
  "https://chautauquacountyny.gov/health-human-services/environmental-health";

// How far (chars) past a matched beach name to scan for its status phrase,
// as an UPPER bound — the actual window is also clipped to stop at whichever
// comes first: this many chars, or the next curated beach's page-alias
// (see findNextBeachMention), so one beach's status text can never bleed
// into a neighboring beach's cell in a dense table/listing.
const STATUS_WINDOW_CHARS = 200;

// Curated Chautauqua County Lake Erie beaches. Two distinct alias lists on
// purpose:
//   pageAliases — looser terms used ONLY to locate this beach's status block
//     within the county's OWN status page text. Broad matching here is safe
//     because the page is scoped to these four beaches already.
//   names — the tight set exposed as the emitted site's "names" (consumed by
//     the shared resolveSiteForBeach against a swim.report beach's
//     park_name + name, and by this module's own matches() gate). Kept
//     narrow so a same-named/word beach elsewhere (e.g. an "Irving Park"
//     beach far from Lake Erie) can never inherit this site's color — the
//     same namesake trap South Haven's scraper deliberately guards against.
// lat/lon are approximate public shoreline-access points, used only as the
// PASS 2 proximity fallback in resolveSiteForBeach.
const CHAUTAUQUA_SITES = [
  {
    siteId: "point-gratiot",
    pageAliases: ["point gratiot"],
    names: ["point gratiot"],
    lat: 42.4945,
    lon: -79.3348
  },
  {
    siteId: "wright-park",
    pageAliases: ["wright park"],
    names: ["wright park"],
    lat: 42.4848,
    lon: -79.3311
  },
  {
    siteId: "irving",
    pageAliases: ["irving beach", "irving town park", "irving"],
    names: ["irving beach", "irving town park"],
    lat: 42.5687,
    lon: -79.1548
  },
  {
    siteId: "sunset-bay",
    pageAliases: ["sunset bay"],
    names: ["sunset bay"],
    lat: 42.5498,
    lon: -79.1774
  }
];

// Pure. Flattened list of every curated beach's pageAliases, used to find
// where the NEXT beach mention begins so a status window never overruns it.
function allPageAliases() {
  const out = [];
  for (let s = 0; s < CHAUTAUQUA_SITES.length; s++) {
    for (let a = 0; a < CHAUTAUQUA_SITES[s].pageAliases.length; a++) {
      out.push(CHAUTAUQUA_SITES[s].pageAliases[a]);
    }
  }
  return out;
}

// Harmful-algal-bloom phrasing, checked FIRST — the most severe water-quality
// reading available from a status page like this, so it maps to red rather
// than the generic "closed" yellow.
const HAB_KEYWORDS = [
  "harmful algal bloom",
  "hab advisory",
  "algal bloom",
  "blue-green algae",
  "blue green algae",
  "cyanobacteria"
];

// A closure or advisory that is NOT (as far as the page's own text says) a
// HAB event — elevated bacteria, high turbidity, no lifeguard closure, or an
// unspecified "advisory"/"caution" notice. Kept intentionally broad since a
// county status page rarely spells out the exact pathogen; the point of a
// raise-only floor is exactly to lift the flag without over-claiming a
// severity the source did not assert.
const CLOSURE_OR_ADVISORY_KEYWORDS = [
  "closed",
  "close ",
  "advisory",
  "caution",
  "unsafe",
  "elevated bacteria",
  "high bacteria"
];

// Negated/clear phrasing that would otherwise falsely trip a bare substring
// in CLOSURE_OR_ADVISORY_KEYWORDS (e.g. "no advisory" contains "advisory").
// Checked BEFORE the closure/advisory keywords for exactly that reason —
// an explicit all-clear statement must never be misread as an active one.
const CLEAR_KEYWORDS = [
  "satisfactory",
  "no advisory",
  "no advisories",
  "no closures",
  "not closed",
  "currently open",
  "open"
];

// Pure, exported for tests. Strips tags/entities, collapses whitespace.
// Non-string -> "".
export function htmlToPlainText(html) {
  if (typeof html !== "string") {
    return "";
  }
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/&mdash;/gi, "-")
    .replace(/&ndash;/gi, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// Pure. True if any needle in needles is a substring of hay.
function containsAny(hay, needles) {
  for (let i = 0; i < needles.length; i++) {
    if (hay.indexOf(needles[i]) !== -1) {
      return true;
    }
  }
  return false;
}

// Pure, exported for tests. Classifies a status-window snippet (already
// lowercased plain text) into "hab" | "closure-advisory" | "clear" | "none".
// An explicit clear/negated reading is checked FIRST — otherwise a phrase
// like "no advisory" would falsely trip the "advisory" substring below. HAB
// is checked next (the most severe reading), then a generic closure/advisory;
// otherwise "none" (nothing recognized -> no floor).
export function classifyStatusSnippet(snippet) {
  if (typeof snippet !== "string" || snippet.length === 0) {
    return "none";
  }
  if (containsAny(snippet, CLEAR_KEYWORDS)) {
    return "clear";
  }
  if (containsAny(snippet, HAB_KEYWORDS)) {
    return "hab";
  }
  if (containsAny(snippet, CLOSURE_OR_ADVISORY_KEYWORDS)) {
    return "closure-advisory";
  }
  return "none";
}

// Pure, exported for tests. Raw HTML (or already-plain text) -> Site[] | null.
//   - null ONLY on a total shape failure: empty/non-string input, or a page
//     whose text contains NONE of the four curated beach names at all (a
//     strong signal the page structure or URL has changed underneath us).
//     That is the health-failure signal a builder/integrator should notice.
//   - [] when the page parsed cleanly, named at least one curated beach, and
//     every named beach reads as clear/unrecognized (the all-clear case) —
//     a SUCCESSFUL parse with nothing to report.
//   - one site per beach whose status snippet classifies as "hab" (red) or
//     "closure-advisory" (yellow). A beach whose snippet reads "clear" or
//     "none" is simply omitted (no site), never guessed.
export function parseChautauquaBeachStatus(html, nowIso) {
  if (typeof html !== "string" || html.length === 0) {
    return null;
  }
  const text = htmlToPlainText(html);
  const lower = text.toLowerCase();

  let anyBeachNamed = false;
  const sites = [];
  const otherAliases = allPageAliases();

  for (let s = 0; s < CHAUTAUQUA_SITES.length; s++) {
    const site = CHAUTAUQUA_SITES[s];
    let matchIndex = -1;
    let matchedAlias = null;
    for (let a = 0; a < site.pageAliases.length; a++) {
      const idx = lower.indexOf(site.pageAliases[a]);
      if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
        matchIndex = idx;
        matchedAlias = site.pageAliases[a];
      }
    }
    if (matchIndex === -1) {
      continue;
    }
    anyBeachNamed = true;

    const windowStart = matchIndex + matchedAlias.length;
    // Clip the window at whichever comes first: STATUS_WINDOW_CHARS, or the
    // next OTHER curated beach's mention — so one beach's status text can
    // never bleed into a neighboring row/cell in a dense listing.
    let windowEnd = windowStart + STATUS_WINDOW_CHARS;
    for (let a = 0; a < otherAliases.length; a++) {
      const alias = otherAliases[a];
      if (alias === matchedAlias) {
        continue;
      }
      const nextIdx = lower.indexOf(alias, windowStart);
      if (nextIdx !== -1 && nextIdx < windowEnd) {
        windowEnd = nextIdx;
      }
    }
    const snippet = lower.slice(windowStart, windowEnd);
    const tag = classifyStatusSnippet(snippet);

    if (tag === "hab") {
      sites.push({
        siteId: site.siteId,
        floorColor: "red",
        names: site.names,
        lat: site.lat,
        lon: site.lon,
        reason: "Chautauqua County Health Dept: harmful algal bloom advisory",
        updated: nowIso
      });
    } else if (tag === "closure-advisory") {
      sites.push({
        siteId: site.siteId,
        floorColor: "yellow",
        names: site.names,
        lat: site.lat,
        lon: site.lon,
        reason: "Chautauqua County Health Dept: beach closure/advisory in effect",
        updated: nowIso
      });
    }
    // "clear" or "none": no site for this beach — clean/unrecognized reading.
  }

  if (!anyBeachNamed) {
    console.log("chautauquaCountyNy: no curated beach names found in page text");
    return null;
  }
  return sites;
}

// Pure. True when a swim.report beach is one of the curated Chautauqua
// County Lake Erie beaches — by name substring OR lat/lon proximity to a
// curated site.
function isChautauquaBeach(beach) {
  const haystack = ((beach.park_name || "") + " " + (beach.name || "")).toLowerCase();
  for (let s = 0; s < CHAUTAUQUA_SITES.length; s++) {
    const site = CHAUTAUQUA_SITES[s];
    for (let a = 0; a < site.names.length; a++) {
      if (haystack.indexOf(site.names[a]) !== -1) {
        return true;
      }
    }
  }
  // No coordinate-proximity fallback in matches(): "Irving"/"Sunset Bay" are
  // common enough words that a bare-name substring outside a tight radius
  // would risk resolving a namesake beach elsewhere. resolveSiteForBeach's
  // own PASS 2 proximity (radiusMi, applied downstream at resolution time)
  // is scoped per-site and already guards this on the resolve side; matches()
  // itself only needs to admit rows that could plausibly be one of these four
  // named beaches.
  return false;
}

export const chautauquaCountyNy = {
  id: "chautauqua-county-ny",
  label: CHAUTAUQUA_LABEL,
  infoUrl: CHAUTAUQUA_INFO_URL,
  matches: function(beach) {
    return isChautauquaBeach(beach);
  },
  scrape: async function(nowIso) {
    // Fail closed until the live status URL is confirmed (see header). A null
    // here simply means "no floor", never a wrong color.
    if (!CHAUTAUQUA_BEACH_STATUS_URL) {
      console.log("chautauquaCountyNy: status URL not confirmed; skipping fetch (fail closed)");
      return null;
    }
    const html = await fetchText(CHAUTAUQUA_BEACH_STATUS_URL, {
      logPrefix: "chautauquaCountyNy: fetch failed"
    });
    if (html === null) {
      return null;
    }
    try {
      const sites = parseChautauquaBeachStatus(html, nowIso);
      // null => real parse failure / unrecognizable page (health failure).
      // [] => clean parse, nothing currently flagged (health success, no
      // sites, no KV writes for any beach this run).
      if (sites === null) {
        return null;
      }
      return perBeachResult(sites, CHAUTAUQUA_BEACH_STATUS_URL, nowIso);
    } catch (err) {
      console.log("chautauquaCountyNy: parse failed: " + err.message);
      return null;
    }
  }
};
