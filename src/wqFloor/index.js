// src/wqFloor/index.js — the registry of raise-only water-quality advisory floor
// sources. Modeled on src/officialSources/index.js but a different axis: these
// feed rules.js estimateFlag's waterQualityAdvisory input (step 7), where an
// active E. coli, bacteria or HAB advisory can raise a flag to yellow or red
// (worst-of by SEVERITY_RANK) but can never pull a hazard estimate down. A clean
// or absent reading is modeled as the absence of an advisory, resolving to null
// with no effect, so a clean-water green can never mask a wave, rip or alert red.
//
// That is why water quality must not live in src/officialSources/, where an
// official color overrides the estimate everywhere: this lives inside the estimate
// (official: false) and lifts only.
//
// Cron-side only. The fetch handler never calls any source.scrape(); the request
// path reads the already-computed "wqfloor:" + beachId KV.
//
// Registering a source: author the module, import it here, and append it to
// wqFloorSources. The cron gather in src/index.js and the rules.js step-7 floor do
// the rest.

import { resolveSiteForBeach, DEFAULT_SITE_RADIUS_MI } from "../officialSources/util.js";
import { nyOprhpBeachStatus } from "./nyOprhpBeachStatus.js";
import { lakeCountyOhBeaches } from "./lakeCountyOhBeaches.js";
import { kenoshaBeachConditions } from "./kenoshaBeachConditions.js";
import { mnBeaches } from "./mnBeaches.js";
import { greyBruceRecWater } from "./greyBruceRecWater.js";
import { ontarioParksBeachPostings } from "./ontarioParksBeachPostings.js";
import { evanstonStatusfy } from "./evanstonStatusfy.js";
import { usgsGreatLakesNowcast } from "./usgsGreatLakesNowcast.js";

// The only colors a water-quality floor may carry. green, double-red and unknown
// are invalid: a clean reading must never appear as a green floor, since its
// absence is the "no floor", and double-red is reserved for the hazard axis. Two
// gates on purpose — this resolver rejects anything outside the set, and rules.js
// step 7 independently only honors "yellow" and "red".
const WQ_FLOOR_COLORS = ["yellow", "red"];

// Each source object:
//   {
//     id:    stable kebab string. Used for log lines and the cron's per-run
//            fetch-once grouping key.
//     label: human string. The default advisory source label when a site does
//            not carry its own.
//     infoUrl: OPTIONAL canonical human-readable page for the estimate card's
//            { label, url } source entry (the cron reads it reflectively).
//     matches(beach): pure boolean, first-match-wins. beach has
//            { id, name, park_name, lat, lon, ... }.
//     scrape(nowIso): async, CRON-SIDE only. Returns a perBeach result
//            { perBeach: true, sites: Site[], source, updated } or null on any
//            failure/empty. Called ONCE per source per run, not per beach.
//   }
// Site shape (note floorColor, not color):
//   { siteId, floorColor: "yellow"|"red", names?: string[], lat?, lon?,
//     radiusMi?, reason?: string, updated?: string }
// Per-beach resolution reuses resolveSiteForBeach (names win over proximity),
// exactly like the official scrapers.
//
// Ordered most-specific-first, since findWqFloorSource is first-match-wins: the
// curated single-region sources precede usgsGreatLakesNowcast, whose matches() is
// a coarse Lake Erie/Ontario US-shore bbox, so a beach a curated source covers is
// resolved by that source and only unclaimed beaches fall through to the NowCast
// prediction.
//
// Deliberately not registered, though the modules stay on disk and fully tested:
// chautauquaCountyNy and erieCountyPaKml (fetch URL still "", so they fail closed
// before fetching) and illinoisBeachGuard (ILLINOIS_BEACHGUARD_CONFIRMED is false,
// its BeachIDs placeholders). Because matches() is first-match-wins and the cron
// resolves exactly one source per beach, registering a permanently-inert source
// suppresses the working source behind it: erieCountyPaKml's ERIE_BOX sits
// strictly inside usgsGreatLakesNowcast's region box, and illinoisBeachGuard's box
// overlaps kenoshaBeachConditions coverage around lat 42.517-42.55. Re-insert each
// above usgsGreatLakesNowcast, and Illinois above kenoshaBeachConditions, once its
// URL or BeachID gate is confirmed — never below.
export const wqFloorSources = [
  nyOprhpBeachStatus,
  lakeCountyOhBeaches,
  kenoshaBeachConditions,
  mnBeaches,
  greyBruceRecWater,
  ontarioParksBeachPostings,
  evanstonStatusfy,
  usgsGreatLakesNowcast
];

// Pure. First source whose matches(beach) is true, else null. Mirrors
// findScraper in officialSources/index.js.
export function findWqFloorSource(beach) {
  for (let i = 0; i < wqFloorSources.length; i++) {
    if (wqFloorSources[i].matches(beach)) {
      return wqFloorSources[i];
    }
  }
  return null;
}

// Pure. Resolves an already-fetched perBeach scrape result to one beach's
// advisory, or null when no site resolved, the floor color is invalid, the result
// is malformed, or the run was clean. Returns the shape rules.js estimateFlag's
// waterQualityAdvisory input consumes — { color, reason, source } — plus the
// stamped beachId and updated the request path persists.
//
// Note the field name flip: the Site carries floorColor, the emitted advisory
// carries color. Never throws: a schema change on a source degrades to null, never
// to a wrong color.
export function scrapeWqFloorFromResult(beach, source, result) {
  try {
    if (!result || result.perBeach !== true) {
      return null;
    }
    const site = resolveSiteForBeach(beach, result.sites);
    if (!site) {
      return null;
    }
    if (WQ_FLOOR_COLORS.indexOf(site.floorColor) === -1) {
      console.log(
        "wqFloor: invalid floorColor from " + source.id +
        " site " + String(site.siteId) + ", skipping"
      );
      return null;
    }
    const reason = typeof site.reason === "string" && site.reason.length > 0
      ? site.reason
      : "active water-quality advisory";
    // Per-reading timestamp wins over the result-level updated (periodic
    // sampling sources), so the frontend's stale-data warning reflects when the
    // advisory was actually issued, not the cron tick.
    const updated = typeof site.updated === "string" && site.updated.length > 0
      ? site.updated
      : result.updated;
    // Prefer a site-level source label if a source ever carries one; otherwise
    // fall back to the source's own label.
    const sourceLabel = typeof site.source === "string" && site.source.length > 0
      ? site.source
      : source.label;
    return {
      beachId: beach.id,
      color: site.floorColor,
      reason: reason,
      source: sourceLabel,
      updated: updated
    };
  } catch (err) {
    console.log("wqFloor: resolve failed for " + source.id + ": " + err.message);
    return null;
  }
}

// Alias, so either import spelling resolves to the same resolver.
export { scrapeWqFloorFromResult as scrapeFloorFromResult };

// Re-exported for the cron and tests (kept in officialSources/util.js to avoid
// duplicating the name-or-proximity resolution logic).
export { resolveSiteForBeach, DEFAULT_SITE_RADIUS_MI };
