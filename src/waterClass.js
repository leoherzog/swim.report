// src/waterClass.js — the single home of the water-body classification decision
// and the Great Lakes allowlist data. Pure, versioned, unit-tested.
//
// Beach flags exist only for oceans and the Great Lakes. This module decides,
// from three independent OSM signals gathered by src/layerSignals.js, whether a
// beach's adjacent water body is flag-worthy (ocean / great_lake) or inland. The
// classification is stored on the beach row (migration 0009) and gates every
// consumer down to flag-worthy water.
//
// The decision is provider-agnostic: it reads the signals object and nothing
// else, which is why it lives in its own pure module.

// Bump when the allowlist, the predicate, or the signal provider changes in a way
// that could change an already-stored decision. Rows with
// water_class_version < WATER_CLASS_VERSION are re-drained by the classification
// pass. Independent of src/rules.js RULES_VERSION: this governs water-body
// classification, not flag color, so RULES_VERSION does not bump with it.
//
// A full re-drain is a local pass over an in-process index — seconds of CPU, no
// upstream requests — so this is an ordinary correctness tool rather than a last
// resort. What makes a bump safe rather than merely cheap is
// classificationFlipRailAllows in scripts/discovery-batch.js: a re-drain that
// would flip flag-worthy rows to inland past its threshold refuses the whole
// water_class UPDATE block and prints the confusion matrix, so a bump cannot
// quietly empty the site.
//
// What a bump does not reach: buildClassifyQueue in scripts/discovery-batch.js
// ANDs the version clause with attempts < WATER_CLASS_MAX_ATTEMPTS, so rows
// parked at the cap are excluded however high the version goes. Those are
// re-drained by the version-IS-NULL legacy marker there instead.
export const WATER_CLASS_VERSION = 2;

// Data-driven allowlist: wikidata QID -> lake name. Editing this table plus
// bumping WATER_CLASS_VERSION is the entire "add a Great Lake" operation; no
// branching logic changes. Matched by QID and never by name, because a pond
// literally named "Lake Superior" exists in OSM. The major bays (Georgian Bay,
// Green Bay, Saginaw Bay) are members of the parent lake relation and resolve to
// the parent QID at the probe, so they need no entries. Connecting rivers and
// other large inland lakes are deliberately excluded — product decisions,
// editable by changing this data and bumping the version.
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

// Rows that classify successful-but-empty this many times are permanently parked
// and drop out of the classification queue and every consumer gate. Matches the
// NWS/ECCC enrichment caps.
export const WATER_CLASS_MAX_ATTEMPTS = 5;

// The hide-until-flag-worthy gate, as one shared SQL fragment so every consumer's
// WHERE clause is byte-identical and cannot drift. Shows confirmed keepers
// (ocean / great_lake) plus still-pending unclassified rows (NULL under the
// attempts cap); hides confirmed inland and parked-unresolved rows. The fail-open
// for pending NULLs is what keeps the live site from being blanked during a
// backfill, and it collapses to the pure "water_class IN ('ocean','great_lake')"
// state once none remain, with no second code change. An inlined literal rather
// than a bind param so it composes into the existing SELECT strings.
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
// Returns 'ocean' | 'great_lake' | 'inland'; null only for a missing signals
// object. A provider-level failure never reaches here — waterClassSignals in
// src/layerSignals.js returns null first for a beach the layer set cannot answer
// for — so any signals object handed in is a complete probe result over a
// verified layer set, since src/layerManifest.js refuses to classify at all from
// an incomplete build. That is what makes the all-empty case decidable rather
// than pending.
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
  // relation and no qualifying water way within the radii. Deciding "inland" here
  // rather than returning null is deliberate. The probe is deterministic, so
  // retrying reaches the same answer, and every pending round is a round
  // FLAG_WORTHY_WATER_SQL fails open on while the site serves an estimated flag
  // card. A beach set back from its water — Locklin Pines Beach Park, Oakland
  // County MI, nearest water way ~150 m out and pond-sized, Cross Lake ~300 m —
  // is not flag-worthy, and saying so once is more honest than parking it.
  //
  // Worst case this mislabels a genuine ocean or Great Lake beach whose polygon
  // sits beyond OCEAN_RADIUS_M / GREAT_LAKE_RADIUS_M from any mapped shoreline,
  // or whose shoreline is unmapped in OSM. Such a row parks hidden at the attempts
  // cap either way, so the end state is the same. Widening the radii is the fix
  // for that class, not keeping the row pending.
  return "inland";
}
