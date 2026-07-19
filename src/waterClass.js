// src/waterClass.js
// The single home of the water-body classification DECISION and the Great
// Lakes allowlist DATA. Pure, versioned, unit-tested. Plain JS, ESM,
// const/let, string concatenation only (no template literals).
//
// Beach flags exist only for oceans and the Great Lakes. This module decides,
// from three independent OSM signals gathered by src/clients/overpass.js,
// whether a beach's adjacent water body is flag-worthy (ocean / great_lake) or
// inland. The classification is stored on the beach row (migration 0009) and
// gates every consumer down to flag-worthy water.

// Bump when the allowlist OR the predicate changes. Rows with
// water_class_version < WATER_CLASS_VERSION are re-drained by the
// classification cron (like RULES_VERSION-stamped KV). This is INDEPENDENT of
// src/rules.js RULES_VERSION — it governs water-body classification, NOT flag
// color, so RULES_VERSION does NOT bump for this feature.
export const WATER_CLASS_VERSION = 1;

// Data-driven allowlist: wikidata QID -> lake name. Editing this table (adding
// a lake / rescuing a QID split) plus bumping WATER_CLASS_VERSION is the entire
// "add a Great Lake" operation — no branching logic changes. Matched by QID,
// NEVER by name (a POND literally named "Lake Superior" exists in OSM, so name
// matching false-fires). The major bays (Georgian Bay, Green Bay, Saginaw Bay)
// are members of the parent lake relation and resolve to the parent QID at the
// probe, so they need no separate entries. Connecting rivers (Detroit /
// Niagara / St. Marys / upper St. Lawrence) and other large inland lakes
// (Winnipeg, Simcoe, Champlain) are deliberately excluded — documented product
// decisions, editable by changing this data and bumping the version.
export const GREAT_LAKE_QIDS = {
  "Q1066": "Lake Superior",
  "Q1169": "Lake Michigan",
  "Q1383": "Lake Huron",
  "Q5492": "Lake Erie",
  "Q1062": "Lake Ontario",
  "Q736707": "Lake St. Clair"
};

export function isGreatLakeQid(qid) {
  return typeof qid === "string" &&
    Object.prototype.hasOwnProperty.call(GREAT_LAKE_QIDS, qid);
}

// Rows that classify successful-but-empty this many times are permanently
// parked (no flag-worthy water found) and drop out of the classification
// queue and every consumer gate. Matches the NWS/ECCC enrichment caps.
export const WATER_CLASS_MAX_ATTEMPTS = 5;

// Canonical HIDE-UNTIL-FLAG-WORTHY gate, as a single shared SQL fragment so
// every consumer's WHERE clause is byte-identical and cannot drift. Shows
// confirmed keepers (ocean / great_lake) PLUS still-pending unclassified rows
// (NULL under the attempts cap); hides confirmed inland + parked-unresolved
// rows. During backfill a still-pending NULL row stays visible so the live
// site is never blanked; post-backfill no pending NULLs remain and the clause
// collapses to the pure "water_class IN ('ocean','great_lake')" state with no
// second code change. Inlined literal (no bind param) so it composes into the
// existing SELECT strings.
export const FLAG_WORTHY_WATER_SQL =
  "(water_class IN ('ocean','great_lake') OR (water_class IS NULL AND water_class_attempts < " +
  String(WATER_CLASS_MAX_ATTEMPTS) + "))";

// JS mirror of FLAG_WORTHY_WATER_SQL for the request path's per-row checks
// (detail page, /api/flag): a fetched beach row that fails this returns 404. A
// row missing the column (older stub rows, pre-migration reads) is treated as
// NULL-pending and therefore visible.
export function isFlagWorthyWater(beach) {
  if (!beach) {
    return false;
  }
  const wc = beach.water_class;
  if (wc === "ocean" || wc === "great_lake") {
    return true;
  }
  if (wc === null || wc === undefined) {
    const attempts = typeof beach.water_class_attempts === "number"
      ? beach.water_class_attempts : 0;
    return attempts < WATER_CLASS_MAX_ATTEMPTS;
  }
  return false;
}

// Pure. Precedence ocean > great_lake > inland. Never throws.
//   signals = {
//     coastlinePresent: boolean,   // natural=coastline way within OCEAN_RADIUS_M
//     nearbyLakeQids: [string],    // wikidata QIDs of water=lake RELATIONS in range
//     nearbyWayWater: boolean      // real inland water WAY (>= WATER_MIN_AREA_DEG2) in range
//   }
// Returns 'ocean' | 'great_lake' | 'inland' | null. null == "saw nothing
// usable" -> the caller bumps water_class_attempts; a null is NEVER returned
// for a transient upstream failure (that path never reaches here — see
// fetchWaterClassSignals in src/clients/overpass.js).
export function classifyWaterBody(signals) {
  if (!signals) {
    return null;
  }
  if (signals.coastlinePresent === true) {
    return "ocean";
  }
  if (Array.isArray(signals.nearbyLakeQids)) {
    for (let i = 0; i < signals.nearbyLakeQids.length; i = i + 1) {
      if (isGreatLakeQid(signals.nearbyLakeQids[i])) {
        return "great_lake";
      }
    }
  }
  if (signals.nearbyWayWater === true) {
    return "inland";
  }
  return null;
}
