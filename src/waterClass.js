// src/waterClass.js
// The single home of the water-body classification DECISION and the Great
// Lakes allowlist DATA. Pure, versioned, unit-tested. Plain JS, ESM,
// const/let, string concatenation only (no template literals).
//
// Beach flags exist only for oceans and the Great Lakes. This module decides,
// from three independent OSM signals gathered by src/layerSignals.js,
// whether a beach's adjacent water body is flag-worthy (ocean / great_lake) or
// inland. The classification is stored on the beach row (migration 0009) and
// gates every consumer down to flag-worthy water.
//
// This module is PROVIDER-AGNOSTIC and did not change when the signal provider
// did. The signals used to come from a per-beach radius query against a public
// OSM query API; they now come from a local spatial join against prebuilt
// FlatGeobuf layers (src/layerSignals.js, same signature, same null contract).
// The keys, the types and the precedence below are identical either way — which
// is the whole point of keeping the DECISION in its own pure module.

// Bump when the allowlist, the predicate, OR THE SIGNAL PROVIDER changes IN A WAY
// THAT COULD CHANGE AN ALREADY-STORED DECISION. Rows with
// water_class_version < WATER_CLASS_VERSION are re-drained by the classification
// pass (like RULES_VERSION-stamped KV). This is INDEPENDENT of src/rules.js
// RULES_VERSION — it governs water-body classification, NOT flag color, so
// RULES_VERSION does NOT bump for this feature.
//
// 1 -> 2: the PROVIDER changed. classifyWaterBody below is byte-identical and the
// allowlist is untouched, but every signal it is handed is now measured by a local
// spatial join over FlatGeobuf layers (src/layerSignals.js) instead of a remote
// per-beach radius query. The two answer the same threshold question and agree on
// every clear-cut beach, yet they cannot agree on every MARGINAL one: the old
// probe matched a target way when one of its NODES fell inside the radius, while
// the local join measures to the target's full SEGMENT geometry, so a sparsely-
// vertexed coastline or lake ring now registers at distances the node test missed.
// That is a wider metric in the ocean/great_lake direction (the safe direction —
// it reveals beaches rather than hiding them), but it is still a different
// measurement, and a stored decision made by the old provider must be allowed to
// re-decide under the new one rather than being grandfathered in forever.
//
// WHY THIS CONSTANT CAN NOW MOVE FREELY. A bump used to be prohibitively
// expensive: it re-probed every already-decided row one request at a time against
// a rate-limited public API, metered at 25 rows per scheduled run — days of
// scheduled runs for a table this size, which is why the clean-but-empty ->
// 'inland' change below was deliberately shipped WITHOUT one. Under layers a full
// re-drain is a local pass over an in-process index: seconds of CPU on the runner,
// zero upstream requests. The version is now an ordinary correctness tool rather
// than a last resort. What makes bumping SAFE rather than merely cheap is
// classificationFlipRailAllows in scripts/discovery-batch.js: a re-drain that
// would flip flag-worthy rows to inland past its threshold refuses the whole
// water_class UPDATE block and prints the confusion matrix, so a bump can never
// quietly empty the site.
//
// The one thing a bump still does NOT reach: buildClassifyQueue in
// scripts/discovery-batch.js ANDs the version clause with
// attempts < WATER_CLASS_MAX_ATTEMPTS, so rows parked AT the cap are excluded no
// matter how high the version goes. Those are re-drained by the version-IS-NULL
// legacy marker there instead. (That trap is empty in production today — no row
// is unclassified and none is parked — but it is a real edge and it survives.)
export const WATER_CLASS_VERSION = 2;

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
// Returns 'ocean' | 'great_lake' | 'inland'; null ONLY for a missing signals
// object. A provider-level failure never reaches here (waterClassSignals in
// src/layerSignals.js returns null before this call for a beach the layer set
// cannot answer for), so ANY signals object we are handed is a COMPLETE probe
// result over a verified layer set — the manifest gate in src/layerManifest.js
// refuses to classify at all from an incomplete build. That is what makes the
// all-empty case decidable rather than pending.
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
  // Clean-but-empty: a complete probe found no coastline, no allowlisted lake
  // relation, and no qualifying water way within the radii. This used to return
  // null ("saw nothing usable"), which bumped water_class_attempts and left the
  // row unclassified — so the row stayed VISIBLE under the FLAG_WORTHY_WATER_SQL
  // fail-open for all WATER_CLASS_MAX_ATTEMPTS rounds while the site showed it an
  // estimated flag card. But the probe is DETERMINISTIC: re-running the identical
  // query returns the identical empty answer, so those retries could only ever
  // reach the same conclusion, at 5x the cost and 5x the exposure window. (Under
  // layers the cost is now negligible, but the exposure window is not: a row left
  // pending is a row FLAG_WORTHY_WATER_SQL fails open on and the site serves an
  // estimated flag card for. Deciding once is still the right answer.)
  // A beach set back from its water (real case: Locklin Pines Beach Park, Oakland
  // County MI — nearest water way ~150 m out and pond-sized, Cross Lake ~300 m)
  // is not flag-worthy, and saying so once is both cheaper and more honest than
  // parking it unresolved.
  //
  // Worst case this mislabels a genuine ocean/Great Lake beach whose polygon sits
  // beyond OCEAN_RADIUS_M/GREAT_LAKE_RADIUS_M from any mapped shoreline, or whose
  // shoreline is unmapped in OSM. That row's END STATE is unchanged — it parked
  // hidden at the attempts cap before and reads inland-hidden now — so this trades
  // no new false negatives, only 4 fewer chances for OSM to be edited in between.
  // Widening the radii is the fix for that class, not keeping the row pending.
  return "inland";
}
