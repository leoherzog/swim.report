// src/wqFloor/illinoisBeachGuard.js
//
// KIND: wq (src/wqFloor raise-only water-quality floor source).
// SOURCE: Illinois Department of Public Health "BeachGuard" per-beach detail
// page, https://www.idph.state.il.us/envhealth/ilbeaches/public/
// BeachDetail.aspx?BeachID={n} — a plain server-rendered GET (no JS render
// required). Curated to Illinois's Lake Michigan shoreline beaches (Illinois
// Beach State Park / Winthrop Harbor / Waukegan / Zion, Lake County).
//
// FLOOR MAPPING (RAISE-ONLY, never a hazard override):
//   - Page shows an active advisory panel (elevated bacteria, beach still
//     open with caution)                       -> floorColor "yellow"
//   - Page shows an active closure panel (high bacteria, swimming
//     prohibited)                               -> floorColor "red"
//   - Page shows "no advisory or closure" / the green-flag "is open." state
//     -> NO site is emitted (never "green" — a clean reading is the ABSENCE
//        of a floor, not an affirmative color; see rules.js wq-floor step,
//        which only ever raises green/unknown/yellow up, never down).
//   - Any unrecognized/garbage markup (site redesign, unexpected id/text)
//     -> NO site is emitted and the page's fetch does not count as a
//        "clean" read either — see parseIllinoisBeachGuardDetail below.
//
// KEYING: this parser intentionally keys on the ABSENCE of the
// id="Main_pnlNoAdvisory" panel (whose body text reads "no advisory or
// closure" on a clean day), NOT on the id="Main_imgGreenFlag" image — the
// spec for this source explicitly calls out the green-flag image as an
// unreliable/secondary signal versus the advisory/closure panel state.
//
// *** LIVE-MARKUP CONFIRMATION NEEDED ***
// The exact BeachDetail.aspx markup (precise panel ids for the active
// advisory vs. active closure states, and the real numeric BeachIDs for each
// curated Lake Michigan site below) could not be confirmed against a live,
// currently-monitored beach page at build time — every BeachDetail.aspx
// fetch attempted during research returned either an off-season "no
// monitoring information for this year" placeholder or an unrelated inland
// beach record, never a live advisory/closure example. The parser below is
// written defensively against the documented panel/text shapes in the task
// spec and degrades to null (no floor) on anything it cannot positively
// recognize — "no data" always beats a guess. Before enabling this source in
// the wqFloor registry, an integrator MUST:
//   1. Confirm the real BeachID for each SITE_DEFS entry (placeholders below
//      are marked "UNCONFIRMED" and are best-effort guesses only).
//   2. Confirm the exact advisory-panel and closure-panel id/text markup
//      against a live BeachDetail.aspx response during an active advisory,
//      and tighten extractAdvisoryState()'s regexes to match verbatim.
// Until then this module fails closed: scrape() only ever produces a site
// for pages it can positively recognize as advisory/closure; anything else
// (including a fetch/parse it cannot confirm) yields no site for that beach.
//
// INTEGRATOR DEDUP NOTE: this is a NEW axis (water quality / bacteria), not a
// hazard source — it must be registered in src/wqFloor/index.js's
// wqFloorSources array, never in src/officialSources/index.js's scrapers
// array (which is a hazard-axis OVERRIDE registry; a clean "no advisory"
// reading here must never be able to mask a wave/rip/alert hazard estimate).
// No overlap with existing hazard sources (SRF rip, NWS/ECCC alerts, wave
// height) — this floor can only ever raise a color, never decide/lower one.

import { fetchText, resolveSiteForBeach, DEFAULT_SITE_RADIUS_MI } from "../officialSources/util.js";

export const ILLINOIS_BEACHGUARD_LABEL = "Illinois BeachGuard (IDPH)";
export const ILLINOIS_BEACHGUARD_INFO_URL =
  "https://www.idph.state.il.us/envhealth/ilbeaches/public/default.aspx";
export const ILLINOIS_BEACHGUARD_DETAIL_BASE =
  "https://www.idph.state.il.us/envhealth/ilbeaches/public/BeachDetail.aspx?BeachID=";

// Pure. Builds the per-beach detail page URL from a numeric/string BeachID.
export function buildIllinoisBeachDetailUrl(beachId) {
  return ILLINOIS_BEACHGUARD_DETAIL_BASE + String(beachId);
}

// **UNCONFIRMED — fail-closed inert gate.** The SITE_DEFS BeachIDs below are the
// module's own header-declared best-effort GUESSES, never verified against a
// live BeachDetail.aspx page, and the exact advisory/closure panel markup could
// not be confirmed either (see the module header). Until a human confirms both,
// scrape() returns null WITHOUT fetching — the same fail-closed-inert pattern
// erieCountyPaKml uses for its unconfirmed KML URL — so this source is present
// in the registry but incapable of emitting a color (or binding a possibly-wrong
// BeachID to a beach). Flip to true only after confirming the real BeachIDs AND
// the panel id/text markup against a live advisory/closure page.
export const ILLINOIS_BEACHGUARD_CONFIRMED = false;

// Curated Illinois Lake Michigan shoreline beaches (Lake County). Each entry
// pairs a resolveSiteForBeach()-compatible names/lat/lon key with the IDPH
// BeachID this module fetches. beachId values are UNCONFIRMED placeholders
// (see the module header) — swap in the verified numeric BeachID for each
// site before this source is wired into the live wqFloor registry.
const SITE_DEFS = [
  {
    siteId: "illinois-beach-state-park",
    beachId: "1088", // UNCONFIRMED — verify against a live BeachDetail.aspx listing
    names: ["illinois beach state park", "illinois beach"],
    lat: 42.4633,
    lon: -87.8113,
    radiusMi: 3
  },
  {
    siteId: "waukegan-north-beach",
    beachId: "1091", // UNCONFIRMED
    names: ["waukegan north beach", "waukegan municipal beach", "waukegan beach"],
    lat: 42.3714,
    lon: -87.8114,
    radiusMi: 1.5
  },
  {
    siteId: "winthrop-harbor-beach",
    beachId: "1094", // UNCONFIRMED
    names: ["winthrop harbor beach", "north point marina beach", "spring bluff"],
    lat: 42.4808,
    lon: -87.8117,
    radiusMi: 2
  },
  {
    siteId: "zion-beach",
    beachId: "1097", // UNCONFIRMED
    names: ["zion beach", "zion"],
    lat: 42.4275,
    lon: -87.8078,
    radiusMi: 1.5
  }
];

// Pure. Lake Michigan / Lake County Illinois shoreline bounding box, used as
// a coarse matches() guard alongside the curated SITE_DEFS names/proximity
// resolution (resolveSiteForBeach, applied downstream by src/wqFloor/index.js
// scrapeWqFloorFromResult).
function inIllinoisLakeMichiganBox(beach) {
  if (typeof beach.lat !== "number" || typeof beach.lon !== "number") {
    return false;
  }
  return beach.lat >= 42.0 && beach.lat <= 42.55 &&
    beach.lon >= -87.9 && beach.lon <= -87.7;
}

// Pure, exported for tests. beach:{lat,lon,name,park_name,...} -> bool.
// Matches Illinois Lake Michigan shoreline beaches this source curates.
export function matches(beach) {
  if (!beach) {
    return false;
  }
  return inIllinoisLakeMichiganBox(beach);
}

// Pure. Locates a named ASP.NET panel by its id="..." start marker and returns
// the bounded slice of html from that marker (up to 1200 chars, enough to hold
// the panel body without bleeding far into the next panel), or null when the id
// is absent. Scoping every state check to its own panel container is what keeps
// this parser fail-closed — an off-season/placeholder page that carries none of
// these panels matches nothing and yields null, never a color.
function slicePanelById(html, panelId) {
  const startMarker = new RegExp("id=[\"']" + panelId + "[\"']", "i");
  const match = startMarker.exec(html);
  if (!match) {
    return null;
  }
  const start = match.index;
  const windowEnd = Math.min(html.length, start + 1200);
  return html.slice(start, windowEnd);
}

// Pure, exported for tests. html:string -> "clean" | "advisory" | "closure" |
// null. null means "could not positively recognize the page state" (fail
// closed — never guess). Defensive: matches on documented panel id + text
// shapes, not brittle DOM structure.
//
// FAIL CLOSED: a color is emitted ONLY when a POSITIVE, scoped advisory/closure
// container is matched (the id="Main_pnlClosure" / id="Main_pnlAdvisory" panels,
// each confirmed by its own body text). The earlier unscoped whole-page
// /\bclosed\b/ etc. fallback was removed — it red-flagged off-season placeholder
// pages (the only thing live probing ever returned), which is the worst-possible
// wrong-color bug. A page matching neither the clean panel nor a confirmed
// advisory/closure panel returns null.
export function parseIllinoisBeachGuardDetail(html) {
  if (typeof html !== "string" || html.length === 0) {
    return null;
  }

  const noAdvisoryPanel = slicePanelById(html, "Main_pnlNoAdvisory");
  if (noAdvisoryPanel !== null) {
    // Confirm the panel actually carries the expected clean-state text
    // before trusting its presence — a same-id panel used for something else
    // would otherwise be misread as an all-clear.
    if (/no\s+advisory\s+or\s+closure/i.test(noAdvisoryPanel)) {
      return "clean";
    }
    // Panel id present but text doesn't match what we expect: markup drift.
    // Fail closed rather than assume either state.
    return null;
  }

  // No clean panel: require a POSITIVE, scoped advisory/closure container.
  // Check the closure panel first (more severe) and only when its own body
  // text confirms a closure, so a closure is never under-classified as a mere
  // advisory — and, critically, a page carrying NEITHER panel falls through to
  // null below rather than red-flagging on stray whole-page wording.
  const closurePanel = slicePanelById(html, "Main_pnlClosure");
  if (closurePanel !== null &&
      (/\bclosed\b/i.test(closurePanel) || /\bclosure\b/i.test(closurePanel) ||
       /\bprohibited\b/i.test(closurePanel))) {
    return "closure";
  }
  const advisoryPanel = slicePanelById(html, "Main_pnlAdvisory");
  if (advisoryPanel !== null &&
      (/\badvisory\b/i.test(advisoryPanel) || /elevated\s+bacteria/i.test(advisoryPanel))) {
    return "advisory";
  }

  // Neither the clean panel nor a confirmed advisory/closure panel was
  // matched — an off-season/placeholder/error/unrecognized page. Fail closed.
  return null;
}

// Pure, exported for tests. Maps a parseIllinoisBeachGuardDetail() outcome to
// a floorColor, or null when there is no floor to report (clean or
// unrecognized). "clean" and null both yield null here — the resolver only
// ever emits a site for a positively-recognized active advisory/closure.
export function floorColorForState(state) {
  if (state === "closure") {
    return "red";
  }
  if (state === "advisory") {
    return "yellow";
  }
  return null;
}

// Pure, exported for tests. Builds one Site object (contract shape (b),
// floorColor field) for a curated SITE_DEFS entry given its already-parsed
// detail-page state, or null when there is nothing to report for this site.
export function buildSiteFromState(def, state, nowIso) {
  const floorColor = floorColorForState(state);
  if (floorColor === null) {
    return null;
  }
  const reasonWord = state === "closure" ? "closure" : "advisory";
  return {
    siteId: def.siteId,
    floorColor: floorColor,
    names: def.names,
    lat: def.lat,
    lon: def.lon,
    radiusMi: def.radiusMi || DEFAULT_SITE_RADIUS_MI,
    reason: "Active water-quality " + reasonWord + " posted by " + ILLINOIS_BEACHGUARD_LABEL,
    updated: nowIso
  };
}

export const illinoisBeachGuard = {
  id: "illinois-beachguard",
  label: ILLINOIS_BEACHGUARD_LABEL,
  infoUrl: ILLINOIS_BEACHGUARD_INFO_URL,
  matches: matches,
  // Cron-side ONLY: fetches one BeachDetail page per curated site (small,
  // fixed list — no per-beach fan-out beyond SITE_DEFS). Returns
  // { perBeach:true, sites, source, updated } | null. null is reserved for a
  // total failure (every fetch failed) so scraperHealth bookkeeping is
  // meaningful; a run where every beach is clean/unrecognized still returns
  // an (possibly empty) sites array as a successful run.
  scrape: async function (nowIso) {
    // Fail closed until a human confirms the BeachIDs + panel markup. A null
    // here means "no floor", never a wrong color from an unverified BeachID.
    if (!ILLINOIS_BEACHGUARD_CONFIRMED) {
      console.log("illinoisBeachGuard: BeachIDs/markup unconfirmed; skipping fetch (fail closed)");
      return null;
    }

    const sites = [];
    let fetchedCount = 0;

    for (const def of SITE_DEFS) {
      let html = null;
      try {
        html = await fetchText(buildIllinoisBeachDetailUrl(def.beachId), {
          logPrefix: "illinoisBeachGuard: fetch failed for " + def.siteId
        });
      } catch (err) {
        console.log("illinoisBeachGuard: fetch threw for " + def.siteId + ": " + err.message);
        html = null;
      }
      if (html === null) {
        continue;
      }
      fetchedCount = fetchedCount + 1;

      let state = null;
      try {
        state = parseIllinoisBeachGuardDetail(html);
      } catch (err) {
        console.log("illinoisBeachGuard: parse threw for " + def.siteId + ": " + err.message);
        state = null;
      }
      if (state === null || state === "clean") {
        continue;
      }

      const site = buildSiteFromState(def, state, nowIso);
      if (site !== null) {
        sites.push(site);
      }
    }

    if (fetchedCount === 0) {
      // Every fetch failed outright: a real failure, not a clean run.
      return null;
    }

    return {
      perBeach: true,
      sites: sites,
      source: ILLINOIS_BEACHGUARD_LABEL,
      updated: nowIso
    };
  }
};

// Re-exported for tests / potential downstream reuse (mirrors the
// officialSources util re-export pattern).
export { resolveSiteForBeach, DEFAULT_SITE_RADIUS_MI };
