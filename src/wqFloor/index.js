// src/wqFloor/index.js
// Registry of RAISE-ONLY water-quality advisory floor sources. Modeled on
// src/officialSources/index.js, but a fundamentally different axis: these
// sources feed rules.js estimateFlag's "waterQualityAdvisory" input (step 7),
// where an active E. coli / bacteria / HAB advisory can RAISE a flag UP to
// yellow/red (worst-of by SEVERITY_RANK) but can NEVER pull a hazard estimate
// down. A clean/absent reading is modeled as the ABSENCE of an advisory
// (resolves to null -> zero effect), so a clean-water "green" can never mask a
// wave/rip/alert red. This is precisely why water quality must NOT live in
// src/officialSources/ (an official color OVERRIDES the estimate everywhere):
// it lives INSIDE the estimate (official:false), lifting only.
//
// Runs cron-side ONLY. The fetch handler never calls any source.scrape(); the
// request path reads the already-computed "wqfloor:" + beachId KV.
//
// Registering a source: author the source module, import it here, and append it
// to wqFloorSources. The scaffolding (this file, the cron gather in src/index.js,
// and the rules.js step-7 floor) does the rest — resolve per beach, write the
// "wqfloor:" KV, and apply the raise-only floor.

import { resolveSiteForBeach, DEFAULT_SITE_RADIUS_MI } from "../officialSources/util.js";
import { nyOprhpBeachStatus } from "./nyOprhpBeachStatus.js";
import { chautauquaCountyNy } from "./chautauquaCountyNy.js";
import { lakeCountyOhBeaches } from "./lakeCountyOhBeaches.js";
import { erieCountyPaKml } from "./erieCountyPaKml.js";
import { illinoisBeachGuard } from "./illinoisBeachGuard.js";
import { kenoshaBeachConditions } from "./kenoshaBeachConditions.js";
import { mnBeaches } from "./mnBeaches.js";
import { greyBruceRecWater } from "./greyBruceRecWater.js";
import { ontarioParksBeachPostings } from "./ontarioParksBeachPostings.js";
import { evanstonStatusfy } from "./evanstonStatusfy.js";
import { usgsGreatLakesNowcast } from "./usgsGreatLakesNowcast.js";

// The ONLY colors a water-quality floor may carry. green/double-red/unknown are
// INVALID: a clean reading must never appear as a green floor (its absence IS
// the "no floor"), and double-red is reserved for the hazard axis. Two gates on
// purpose — this resolver rejects anything outside the set, and rules.js step 7
// independently only honors "yellow"/"red".
const WQ_FLOOR_COLORS = ["yellow", "red"];

// Ordered most-specific-match first, mirroring the official-scrapers registry.
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
//     scrape(nowIso): async, CRON-SIDE ONLY. Returns a perBeach result
//            { perBeach: true, sites: Site[], source, updated } or null on ANY
//            failure/empty. Called ONCE per source per run, not per beach.
//   }
// Site shape (note floorColor, NOT color):
//   { siteId, floorColor: "yellow"|"red", names?: string[], lat?, lon?,
//     radiusMi?, reason?: string, updated?: string }
// Per-beach resolution reuses resolveSiteForBeach (names win over proximity),
// exactly like the official scrapers.
// Ordered most-specific-first (findWqFloorSource is first-match-wins). The
// curated single-region sources (NY OPRHP state parks, Chautauqua County, Lake
// County OH, Presque Isle PA, IL BeachGuard, Kenosha WI, Duluth MN, Grey Bruce
// ON, Ontario Parks, Evanston IL) come before usgsGreatLakesNowcast, whose
// matches() is a COARSE Lake Erie/Ontario US-shore bbox — placing it last means
// a beach that a curated source covers is resolved by that curated source, and
// only beaches no curated source claims fall through to the NowCast prediction.
export const wqFloorSources = [
  nyOprhpBeachStatus,
  chautauquaCountyNy,
  lakeCountyOhBeaches,
  erieCountyPaKml,
  illinoisBeachGuard,
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

// Pure (no fetch). Resolves an already-fetched perBeach scrape result to ONE
// beach's advisory, or null (no site resolved / invalid floor color /
// malformed / clean run). Returns EXACTLY the shape rules.js estimateFlag's
// "waterQualityAdvisory" input consumes — { color, reason, source } plus the
// stamped beachId/updated the request path persists. estimateFlag reads only
// .color, .reason, .source; beachId/updated ride along for the KV payload.
//
// Note the field name flip: the Site carries "floorColor", the emitted advisory
// carries "color" (what estimateFlag reads). Never throws — a schema change on
// a source degrades to null (no floor), never a wrong color, per the
// error-isolation rule.
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

// Alias for the R3-design name, so either import spelling resolves to the same
// resolver.
export { scrapeWqFloorFromResult as scrapeFloorFromResult };

// Re-exported for the cron and tests (kept in officialSources/util.js to avoid
// duplicating the name-or-proximity resolution logic).
export { resolveSiteForBeach, DEFAULT_SITE_RADIUS_MI };
