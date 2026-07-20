// scripts/discovery-batch.js — offline beach discovery + water-body
// classification, run from GitHub Actions on Deno (see
// .github/workflows/discovery.yml and docs/offline-discovery.md).
//
// WHY THIS EXISTS
// The in-Worker crons runOverpassSync (47 8 * * *) and runWaterClassification
// (37 1,7,13,19 * * *) do discovery + classification a rationed handful of rows
// at a time because a Cloudflare Worker invocation is bounded (CPU / subrequest
// / wall-clock caps) and Overpass allows only 2 slots per IP. Those are
// *pipeline* concerns (run occasionally, tolerate hours of latency, produce a
// table), not *serving* concerns. This script runs the exact same discovery and
// classification logic — imported verbatim from src/ so it can never diverge —
// as a plain offline batch: a loop that can run for minutes, emit one idempotent
// .sql file, and bulk-load it into production D1 via
//   wrangler d1 execute swim-report --remote --file=<out>
// The Worker keeps serving + the hourly recompute + the 6-hourly wave refresh +
// NWS/ECCC/webcam enrichment; only discovery + classification move here.
//
// TWO-PATH RULE: unchanged. The Worker request path still reads only D1 + KV.
// This is a third, OFFLINE path that writes D1 out-of-band — it never runs
// inside the Worker.
//
// PLUMBING, NOT ALGORITHM: the classification step reuses the already-shipped
// per-beach Overpass probe (fetchWaterClassSignals + classifyWaterBody). It is
// isolated in classifyQueue() below as a deliberate seam — swap that one call
// for a smarter bulk classifier (e.g. the segment-index approach in
// README's "One-time bulk backfill" note) without touching the rest of the
// pipeline, or pass --no-classify and emit water_class UPDATEs from a separate
// tool. This script does NOT author a new classifier.
//
// Project style: ES modules, const/let only, string concatenation with + (never
// template literals), console for logging. Runs on Deno (Deno.args / readTextFile
// / writeTextFile / exit); no npm dependencies — the imported src/ modules pull
// in only ./http.js and ./geo.js, both self-contained around global fetch.

import { mergeBeachRows } from "../src/discovery.js";
import {
  fetchBeaches,
  fetchParkBeaches,
  fetchWaterClassSignals
} from "../src/clients/overpass.js";
import {
  classifyWaterBody,
  WATER_CLASS_VERSION,
  WATER_CLASS_MAX_ATTEMPTS
} from "../src/waterClass.js";
import { REGIONS, pointInAnyRegion } from "../src/regions.js";

// --- Constants --------------------------------------------------------------
// The discovery regions and the point-in-region predicate come from the
// standalone src/regions.js (pure data + one pure function, no Worker import
// graph), so this offline batch and the Worker share ONE definition — the old
// PILOT_BBOX duplicated-and-kept-in-sync-by-hand copy is gone. The reconciliation
// rails below change rarely and stay local. The water-class constants ARE
// imported from src/waterClass.js (their single source of truth), so they can
// never drift.
// Per-tile fetch resilience. Public Overpass mirrors flake in bursts (in CI both
// mirrors returned HTTP 504 for an ~8-minute window and the run aborted on tile
// 1/33). One retry lands inside the same burst; OVERPASS_TILE_ATTEMPTS total tries
// (1 initial + 2 retries) with exponential backoff + jitter spread the attempts
// across several minutes so the last one usually lands after the burst clears.
// Attempts are capped (not unbounded) so a SUSTAINED outage fails fast and defers
// to the next scheduled run rather than grinding the whole 33-tile pass for hours.
const OVERPASS_TILE_ATTEMPTS = 3;
const OVERPASS_RETRY_BASE_MS = 30000;   // first retry delay; doubles each retry
const OVERPASS_RETRY_MAX_MS = 120000;   // cap on any single backoff sleep
// Overpass query tiling. Each REGION bbox is split into a grid of sub-boxes each
// at most TILE_MAX_SPAN_DEG on a side. Empirically, named-query EXECUTION is only
// seconds at <= ~4 deg^2 (a 0.5 deg dense box measured ~1.7s), while the original
// 26.5 deg^2 pilot box hit Overpass's 60s server-side [timeout:60] cap and came
// back a TRUNCATED remark (which the client correctly treats as a failure). A
// 2.0 deg tile is <= 4 deg^2, keeping ~6x execution headroom under the 60s cap.
// Wall-clock on public mirrors is dominated by queue latency, not query cost, so
// making tiles smaller than this buys nothing; total tile count is bounded by the
// coastal REGIONS (not a continental grid), which is what actually caps the run.
// Tiles carry a small overlap so a beach or park polygon straddling a tile
// boundary is captured whole in at least one tile (Overpass's (area.pa) park
// containment needs the park's edge inside the tile). Residual: a park polygon
// large enough to fully enclose a tile is not returned for that tile's park
// query — keep TILE_MAX_SPAN_DEG smaller than any relevant protected area, and
// the overlap covers the rest where the park edge lands in a neighbouring tile.
const TILE_MAX_SPAN_DEG = 2.0;
const TILE_OVERLAP_DEG = 0.05;
// Polite gap between successive tile queries (Overpass courtesy). The happy path
// has no retry delay, so without this the tiles would burst back-to-back.
const OVERPASS_TILE_GAP_MS = 1000;
const OVERPASS_RECONCILE_MAX_DELETES = 10;
const OVERPASS_RECONCILE_MAX_DELETE_FRACTION = 0.25;
const FLAG_HISTORY_RETENTION_DAYS = 90;
// A re-discovered beach whose centroid moved > this (~0.001 deg ~ 80-111 m at
// pilot latitudes) may now sit on different water — its water_class is reset so
// it re-classifies. Mirrors the "moved" fragment in runOverpassSync's upsert.
const WATER_CLASS_MOVE_DEG = 0.001;

// --- Tiny helpers -----------------------------------------------------------

function sleep(ms) {
  if (!(ms > 0)) {
    return Promise.resolve();
  }
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Pure wall-clock budget predicate for the classify loop. budgetMs <= 0 disables
// it (always false); otherwise true once (nowMs - startMs) has reached budgetMs.
// Kept pure + three-arg (no injected clock) so it is trivially unit-testable.
export function budgetExhausted(startMs, budgetMs, nowMs) {
  return budgetMs > 0 && (nowMs - startMs) >= budgetMs;
}

// SQL string literal with single quotes doubled. Used for every text value in
// the emitted .sql — the ONLY untrusted text is OSM-derived beach/park names.
export function sqlStr(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// A finite number inlined literally, or NULL. lat/lon are validated finite by
// the Overpass client before they ever reach a row, but guard anyway.
export function sqlNum(value) {
  if (typeof value !== "number" || !isFinite(value)) {
    return "NULL";
  }
  return String(value);
}

function log(msg) {
  // Logs to stderr so stdout stays clean; the SQL goes to the --out file.
  console.error("discovery-batch: " + msg);
}

export function parseArgs(argv) {
  const args = {
    snapshot: null,
    out: "discovery-delta.sql",
    discovery: true,        // --no-discovery => classify-only run (no Overpass tiling, no upserts/reconciliation)
    classify: true,
    classifyLimit: 0,       // 0 = classify the entire eligible queue
    classifyDelayMs: 300,   // polite gap between per-beach Overpass probes
    classifyBudgetMs: 0,    // 0 = disabled; self-imposed wall-clock cap on the classify loop
    now: null
  };
  for (let i = 0; i < argv.length; i = i + 1) {
    const a = argv[i];
    if (a === "--snapshot") { args.snapshot = argv[++i]; }
    else if (a === "--out") { args.out = argv[++i]; }
    else if (a === "--no-discovery") { args.discovery = false; }
    else if (a === "--no-classify") { args.classify = false; }
    else if (a === "--classify-limit") { args.classifyLimit = parseInt(argv[++i], 10) || 0; }
    else if (a === "--classify-delay-ms") { args.classifyDelayMs = parseInt(argv[++i], 10) || 0; }
    else if (a === "--classify-budget-ms") { args.classifyBudgetMs = parseInt(argv[++i], 10) || 0; }
    else if (a === "--now") { args.now = argv[++i]; }
    else { throw new Error("unknown argument: " + a); }
  }
  return args;
}

// wrangler d1 execute --json emits [{ results: [...], success, meta }]; accept
// that, a bare { results }, or a bare array, so a hand-fed snapshot also works.
export function parseSnapshot(text) {
  if (!text || text.trim() === "") {
    return [];
  }
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) {
    if (parsed.length > 0 && parsed[0] && Array.isArray(parsed[0].results)) {
      return parsed[0].results;
    }
    return parsed;
  }
  if (parsed && Array.isArray(parsed.results)) {
    return parsed.results;
  }
  return [];
}

// --- Bbox tiling ------------------------------------------------------------
// Pure; exported for tests. Splits a bbox into a grid of sub-boxes each at most
// maxSpanDeg on a side, then expands every tile by overlapDeg on all four edges
// (clamped back inside the original bbox) so an element straddling a tile
// boundary is captured whole in at least one tile. Column/row counts come from
// ceil(span / maxSpanDeg), so the base tiles are evenly sized and always tile
// the whole bbox with no gaps. A zero-area or sub-span bbox returns a single tile
// equal to the input.
export function tileBbox(bbox, maxSpanDeg, overlapDeg) {
  const span = maxSpanDeg > 0 ? maxSpanDeg : 1;
  const ov = overlapDeg > 0 ? overlapDeg : 0;
  const lonSpan = bbox.maxLon - bbox.minLon;
  const latSpan = bbox.maxLat - bbox.minLat;
  const cols = Math.max(1, Math.ceil(lonSpan / span));
  const rows = Math.max(1, Math.ceil(latSpan / span));
  const lonStep = lonSpan / cols;
  const latStep = latSpan / rows;
  const tiles = [];
  for (let r = 0; r < rows; r = r + 1) {
    for (let c = 0; c < cols; c = c + 1) {
      // Anchor interior edges on the step grid; snap the last column/row to the
      // original max so floating-point drift can never leave a sliver uncovered.
      const baseMinLon = bbox.minLon + c * lonStep;
      const baseMinLat = bbox.minLat + r * latStep;
      const baseMaxLon = c === cols - 1 ? bbox.maxLon : baseMinLon + lonStep;
      const baseMaxLat = r === rows - 1 ? bbox.maxLat : baseMinLat + latStep;
      tiles.push({
        minLon: Math.max(bbox.minLon, baseMinLon - ov),
        minLat: Math.max(bbox.minLat, baseMinLat - ov),
        maxLon: Math.min(bbox.maxLon, baseMaxLon + ov),
        maxLat: Math.min(bbox.maxLat, baseMaxLat + ov)
      });
    }
  }
  return tiles;
}

// Dedup a list of Overpass beach/park-beach records by their OSM identity. Tiles
// overlap, so a boundary element legitimately comes back from more than one tile;
// keep the first-seen copy (the park bbox in `out ... bb` is full geometry, not
// clipped to the tile, so the park association is identical across tiles).
function dedupByOsm(list) {
  const byKey = new Map();
  for (const item of list) {
    const key = item.osmType + "/" + String(item.osmId);
    if (!byKey.has(key)) {
      byKey.set(key, item);
    }
  }
  return Array.from(byKey.values());
}

// Pure; exported for tests. Backoff delay (ms) before retry number `retry`
// (1-based: the 1st retry, 2nd retry, ...). Exponential base * 2^(retry-1),
// capped at maxMs, then ±20% jitter so paced tiles do not resonate with a mirror's
// recovery cycle. `rand` is injectable (defaults to Math.random) for deterministic
// tests. Never returns negative.
export function backoffDelayMs(retry, baseMs, maxMs, rand) {
  const r = typeof rand === "function" ? rand : Math.random;
  const raw = baseMs * Math.pow(2, retry - 1);
  const capped = Math.min(raw, maxMs);
  const jitter = capped * 0.2 * (r() * 2 - 1); // +/- 20%
  const delay = capped + jitter;
  return delay > 0 ? delay : 0;
}

// One tile's fetch with bounded, backing-off retries. Runs fetchFn up to
// OVERPASS_TILE_ATTEMPTS times (each call is itself a full 2-mirror failover in
// the Overpass client); returns the rows on the first success, or null only after
// every attempt fails. Sleeps backoffDelayMs between attempts. The null contract
// is unchanged, so every caller's failure handling (the named all-or-nothing
// abort, the park degrade) is preserved exactly.
async function fetchTileWithRetry(fetchFn, tile, label) {
  let rows = await fetchFn(tile);
  let attempt = 1;
  while (rows === null && attempt < OVERPASS_TILE_ATTEMPTS) {
    const delay = backoffDelayMs(attempt, OVERPASS_RETRY_BASE_MS, OVERPASS_RETRY_MAX_MS);
    log(label + " returned null (attempt " + String(attempt) + "/" + String(OVERPASS_TILE_ATTEMPTS) +
      "), retrying after " + String(Math.round(delay)) + "ms");
    await sleep(delay);
    rows = await fetchFn(tile);
    attempt = attempt + 1;
    if (rows !== null) {
      log(label + " succeeded on attempt " + String(attempt));
    }
  }
  return rows;
}

// --- Discovery fetch (mirrors runOverpassSync's retry orchestration) --------
// Every REGION bbox is tiled (see TILE_MAX_SPAN_DEG) and the tiles concatenated
// into one flat list; each tile runs the two Overpass queries in turn — they
// never overlap (overpass-api.de allows 2 slots/IP) — with bounded backing-off
// retries apiece (fetchTileWithRetry) and a polite inter-tile gap.
//   named beaches: all-or-nothing. Any tile still null after all retries aborts
//     the whole run with no SQL — a partial named set would drive the reconciliation
//     pass to read the missing tiles' beaches as "gone from OSM" and delete them.
//   park beaches: any tile still null after all retries degrades the WHOLE run to
//     named-only (parkBeaches = null: no park_name updates, no reconciliation),
//     exactly like the single-box Worker path when its park query failed. This
//     guarantees the delete path never runs against a region whose park query we
//     could not fetch.
async function runDiscovery() {
  let tiles = [];
  for (let i = 0; i < REGIONS.length; i = i + 1) {
    tiles = tiles.concat(tileBbox(REGIONS[i].bbox, TILE_MAX_SPAN_DEG, TILE_OVERLAP_DEG));
  }
  log("discovery: " + String(REGIONS.length) + " region(s) tiled into " +
    String(tiles.length) + " sub-box(es) (<= " + String(TILE_MAX_SPAN_DEG) + " deg each)");

  const named = [];
  for (let i = 0; i < tiles.length; i = i + 1) {
    if (i > 0) {
      await sleep(OVERPASS_TILE_GAP_MS);
    }
    const label = "fetchBeaches tile " + String(i + 1) + "/" + String(tiles.length);
    const rows = await fetchTileWithRetry(fetchBeaches, tiles[i], label);
    if (rows === null) {
      throw new Error(label + " returned null after retry — aborting, no SQL emitted");
    }
    for (const row of rows) {
      named.push(row);
    }
  }
  const namedRows = dedupByOsm(named);
  log("named beaches: " + String(namedRows.length) + " unique across " + String(tiles.length) + " tile(s)");

  const park = [];
  let parkOk = true;
  for (let i = 0; i < tiles.length; i = i + 1) {
    await sleep(OVERPASS_TILE_GAP_MS);
    const label = "fetchParkBeaches tile " + String(i + 1) + "/" + String(tiles.length);
    const rows = await fetchTileWithRetry(fetchParkBeaches, tiles[i], label);
    if (rows === null) {
      log(label + " returned null after retry — degrading to named-only run (no park updates, no reconciliation)");
      parkOk = false;
      break;
    }
    for (const row of rows) {
      park.push(row);
    }
  }
  const parkBeaches = parkOk ? dedupByOsm(park) : null;
  if (parkOk) {
    log("park beaches: " + String(parkBeaches.length) + " unique across " + String(tiles.length) + " tile(s)");
  }
  return { namedRows: namedRows, parkBeaches: parkBeaches };
}

// --- SQL builders (mirror the exact statements in runOverpassSync) ----------

export function upsertSql(row, hasPark) {
  const idL = sqlStr(row.id);
  const nameL = sqlStr(row.name);
  const latL = sqlNum(row.lat);
  const lonL = sqlNum(row.lon);
  const osmL = sqlStr(row.osmId);
  // The "moved" guard: an unqualified column in ON CONFLICT ... DO UPDATE is the
  // EXISTING row value; the literal lat/lon are the newly-discovered centroid.
  const moved = " CASE WHEN (abs(lat - " + latL + ") > " + String(WATER_CLASS_MOVE_DEG) +
    " OR abs(lon - " + lonL + ") > " + String(WATER_CLASS_MOVE_DEG) + ") THEN ";
  if (!hasPark) {
    return "INSERT INTO beaches (id, name, lat, lon, osm_id) VALUES (" +
      idL + ", " + nameL + ", " + latL + ", " + lonL + ", " + osmL + ") " +
      "ON CONFLICT(id) DO UPDATE SET name = " + nameL + ", lat = " + latL + ", lon = " + lonL + ", " +
      "water_class = " + moved + "NULL ELSE water_class END, " +
      "water_class_version = " + moved + "NULL ELSE water_class_version END, " +
      "water_class_attempts = " + moved + "0 ELSE water_class_attempts END;";
  }
  const parkL = sqlStr(row.parkName);
  return "INSERT INTO beaches (id, name, lat, lon, osm_id, park_name) VALUES (" +
    idL + ", " + nameL + ", " + latL + ", " + lonL + ", " + osmL + ", " + parkL + ") " +
    "ON CONFLICT(id) DO UPDATE SET name = " + nameL + ", lat = " + latL + ", lon = " + lonL +
    ", park_name = " + parkL + ", " +
    "water_class = " + moved + "NULL ELSE water_class END, " +
    "water_class_version = " + moved + "NULL ELSE water_class_version END, " +
    "water_class_attempts = " + moved + "0 ELSE water_class_attempts END;";
}

export function syncMetaSql(key, value, nowIso) {
  return "INSERT INTO sync_meta (key, value, updated) VALUES (" +
    sqlStr(key) + ", " + sqlStr(value) + ", " + sqlStr(nowIso) + ") " +
    "ON CONFLICT(key) DO UPDATE SET value = " + sqlStr(value) + ", updated = " + sqlStr(nowIso) + ";";
}

// Stale park-beach reconciliation, replicated from runOverpassSync with the same
// proportional safety rail. Candidates are UNNAMED-origin park rows (name =
// park_name) inside any REGION (pointInAnyRegion) from the D1 snapshot; stale =
// not produced this run. Refuse the whole delete if the stale set exceeds the
// allowance (a partial/truncated discovery must never mass-delete enriched rows).
export function deleteBeachSql(id) {
  return "DELETE FROM beaches WHERE id = " + sqlStr(id) + ";";
}

// Returns the snapshot rows that WILL be deleted this run (post-rail), or [] when
// reconciliation is skipped/refused. SINGLE SOURCE for both the emitted DELETEs
// and the classify-universe exclusion set, so those can never diverge (an earlier
// bug computed the exclusion set with a different predicate than the DELETEs).
// NOTE on the allowance denominator: candidates come from the PRE-upsert snapshot
// only, whereas the Worker's runOverpassSync computes the 25% rail over the
// POST-upsert park rows (which include this run's brand-new park rows). The stale
// SET is identical either way (new rows are in producedIds, never stale); only the
// denominator differs, so the batch is at most STRICTER (refuses a delete the
// Worker would allow). That is the safe direction for a "never mass-delete" rail,
// so the pre-upsert basis is intentional.
// NOTE on region scoping: the candidate set is bounded by pointInAnyRegion, so a
// snapshot row outside every REGION bbox is never a delete candidate. Shrinking a
// REGION box therefore only ever REMOVES delete candidates (fail-safe: never
// mass-deletes rows a smaller discovery footprint no longer covers).
export function reconcileStaleRows(snapshotRows, producedIds, producedParkRowCount) {
  if (producedParkRowCount === 0) {
    log("reconciliation skipped, run produced 0 park-containment rows");
    return [];
  }
  const candidates = snapshotRows.filter(function (r) {
    return r.park_name !== null && r.park_name !== undefined &&
      r.name === r.park_name && pointInAnyRegion(r.lat, r.lon);
  });
  const stale = candidates.filter(function (r) { return !producedIds.has(r.id); });
  const allowance = Math.max(
    OVERPASS_RECONCILE_MAX_DELETES,
    Math.ceil(candidates.length * OVERPASS_RECONCILE_MAX_DELETE_FRACTION)
  );
  if (stale.length > allowance) {
    log("reconciliation REFUSING to delete " + String(stale.length) + " stale rows (allowance " +
      String(allowance) + " of " + String(candidates.length) + " candidates) — keeping all rows");
    return [];
  }
  log("reconciliation candidates=" + String(candidates.length) + " deleting=" + String(stale.length));
  return stale;
}

export function reconciliationSql(snapshotRows, producedIds, producedParkRowCount) {
  return reconcileStaleRows(snapshotRows, producedIds, producedParkRowCount)
    .map(function (r) { return deleteBeachSql(r.id); });
}

// --- Classification queue ---------------------------------------------------
// Build the post-upsert view of every beach (snapshot ∪ newly discovered, minus
// reconcile-deletes), then queue the ones that still need classifying. This
// unifies the Worker's whole-table runWaterClassification with runOverpassSync's
// synchronous discovery delta into one offline pass, respecting the same
// (water_class NULL OR version < WATER_CLASS_VERSION) AND attempts <
// WATER_CLASS_MAX_ATTEMPTS gate. New and moved rows enter as unclassified.
export function buildClassifyQueue(snapshotRows, mergedRows, deletedIds) {
  const byId = new Map();
  for (const r of snapshotRows) {
    byId.set(r.id, {
      id: r.id,
      osm_id: r.osm_id,
      lat: r.lat,
      lon: r.lon,
      water_class: r.water_class === undefined ? null : r.water_class,
      water_class_version: r.water_class_version === undefined ? null : r.water_class_version,
      water_class_attempts: typeof r.water_class_attempts === "number" ? r.water_class_attempts : 0
    });
  }
  for (const row of mergedRows) {
    const prev = byId.get(row.id);
    const moved = prev &&
      typeof prev.lat === "number" && typeof prev.lon === "number" &&
      (Math.abs(prev.lat - row.lat) > WATER_CLASS_MOVE_DEG ||
        Math.abs(prev.lon - row.lon) > WATER_CLASS_MOVE_DEG);
    if (!prev || moved) {
      // New row, or moved centroid — upsert resets water_class to NULL/0.
      byId.set(row.id, {
        id: row.id,
        osm_id: row.osmId,
        lat: row.lat,
        lon: row.lon,
        water_class: null,
        water_class_version: null,
        water_class_attempts: 0
      });
    } else {
      // Existing, not moved — keep its class/version/attempts, refresh geometry.
      prev.osm_id = row.osmId;
      prev.lat = row.lat;
      prev.lon = row.lon;
    }
  }
  const queue = [];
  for (const b of byId.values()) {
    if (deletedIds.has(b.id)) {
      continue;
    }
    const needs = (b.water_class === null || b.water_class === undefined ||
      (typeof b.water_class_version === "number" && b.water_class_version < WATER_CLASS_VERSION)) &&
      b.water_class_attempts < WATER_CLASS_MAX_ATTEMPTS;
    if (needs) {
      queue.push(b);
    }
  }
  // Lowest attempts first (mirrors ORDER BY water_class_attempts ASC), then id
  // for deterministic ordering under --classify-limit.
  queue.sort(function (a, b) {
    if (a.water_class_attempts !== b.water_class_attempts) {
      return a.water_class_attempts - b.water_class_attempts;
    }
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
  return queue;
}

// Probe + classify each queued beach sequentially (never overlap Overpass —
// 2 slots/IP), paced by delayMs. Mirrors classifyBeaches in src/index.js:
//   - transient fetch failure (null signals) -> no SQL, row stays queued;
//   - a decision -> store water_class + version, RESET attempts to 0;
//   - a clean-but-empty answer -> bump attempts.
// THE SEAM: replace the fetchWaterClassSignals + classifyWaterBody pair to drop
// in a smarter bulk classifier; everything else (queue, SQL, gating) is reused.
// The two production-mutating classify statements, mirrored from classifyBeaches
// in src/index.js: a decision stores water_class + version and RESETS attempts to
// 0; a clean-but-empty answer BUMPS attempts by 1. Exported as pure builders so
// the emitted SQL is unit-tested (a typo here silently mis-classifies at scale).
export function classifyUpdateSql(id, cls) {
  return "UPDATE beaches SET water_class = " + sqlStr(cls) +
    ", water_class_version = " + String(WATER_CLASS_VERSION) +
    ", water_class_attempts = 0 WHERE id = " + sqlStr(id) + ";";
}

export function bumpAttemptsSql(id) {
  return "UPDATE beaches SET water_class_attempts = water_class_attempts + 1 WHERE id = " +
    sqlStr(id) + ";";
}

export async function classifyQueue(queue, options) {
  // Options are read with backward-compatible defaults so main()'s production
  // call behaves exactly as before, while tests inject fetch/classify/now/flush
  // to drive the loop with zero network.
  const opts = options || {};
  const limit = opts.limit || 0;
  const delayMs = opts.delayMs || 0;
  const budgetMs = opts.budgetMs || 0;
  const now = opts.now || Date.now;
  const fetchSignals = opts.fetchSignals || fetchWaterClassSignals;
  const classify = opts.classify || classifyWaterBody;
  const flush = opts.flush || null;
  const statements = [];
  const counts = { attempted: 0, classified: 0, ocean: 0, great_lake: 0, inland: 0, bumped: 0, transient: 0 };
  const total = limit > 0 ? Math.min(limit, queue.length) : queue.length;
  // buildClassifyQueue returns a deterministic order (attempts ASC, id) — right
  // for the scheduled full drain (limit 0). But under a PARTIAL --classify-limit
  // run, always taking the lowest ids would starve the tail across repeated
  // dispatches (transient failures don't bump attempts, so the same rows resort
  // to the front every time). Mirror the Worker's ORDER BY attempts ASC, RANDOM()
  // by randomizing within equal-attempts groups only when we actually cap.
  let ordered = queue;
  if (limit > 0 && total < queue.length) {
    ordered = queue.slice();
    for (let j = ordered.length - 1; j > 0; j = j - 1) {
      const k = Math.floor(Math.random() * (j + 1));
      const tmp = ordered[j]; ordered[j] = ordered[k]; ordered[k] = tmp;
    }
    // Stable sort (V8) => attempts ASC preserved, random order within a group.
    ordered.sort(function (a, b) { return a.water_class_attempts - b.water_class_attempts; });
  }
  // Per-statement flush so a valid, statement-boundary-clean partial .sql always
  // exists on disk even under a hard SIGKILL — each stmt is a complete UPDATE.
  const emit = async function (stmt) {
    statements.push(stmt);
    if (flush) {
      await flush(stmt);
    }
  };
  const startMs = now();
  let stopped = false;
  let processed = 0;
  for (let i = 0; i < total; i = i + 1) {
    if (budgetExhausted(startMs, budgetMs, now())) {
      stopped = true;
      log("classify budget reached after " + String(now() - startMs) + "ms — stopping at " +
        String(i) + "/" + String(total) + "; " + String(total - i) + " remain queued for the next run");
      break;
    }
    const beach = ordered[i];
    counts.attempted = counts.attempted + 1;
    let signals = null;
    try {
      signals = await fetchSignals(beach);
    } catch (err) {
      log("water class fetch threw for " + beach.id + ": " + err.message);
      signals = null;
    }
    if (signals === null) {
      counts.transient = counts.transient + 1;
    } else {
      const cls = classify(signals);
      if (cls !== null) {
        await emit(classifyUpdateSql(beach.id, cls));
        counts.classified = counts.classified + 1;
        counts[cls] = counts[cls] + 1;
      } else {
        await emit(bumpAttemptsSql(beach.id));
        counts.bumped = counts.bumped + 1;
      }
    }
    if ((counts.attempted % 25) === 0) {
      log("classified " + String(counts.attempted) + "/" + String(total) + " (" +
        String(counts.classified) + " decided, " + String(counts.transient) + " transient)");
    }
    processed = i + 1;
    if (i < total - 1) {
      await sleep(delayMs);
    }
  }
  if (limit > 0 && queue.length > total) {
    log("NOTE: --classify-limit capped this run at " + String(total) + " of " +
      String(queue.length) + " eligible beaches; re-run to drain the rest");
  }
  return { statements: statements, counts: counts, stopped: stopped, processed: processed };
}

// --- Main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(Deno.args);
  // The batch runs in one of two modes, split across two GitHub Actions jobs so a
  // slow classify pass can never starve the fast, delete-bearing discovery pass:
  //   DISCOVERY  (default, discovery.yml --no-classify): Overpass tiling ->
  //     upserts + stale-row reconciliation (the ONLY delete path) + retention +
  //     sync_meta. No classification.
  //   CLASSIFY-ONLY (classify.yml --no-discovery --classify-limit N): NO Overpass
  //     tiling, NO upserts, NO reconciliation, NO deletes — emits ONLY water-class
  //     UPDATEs for snapshot rows still needing classification, N per run.
  if (!args.discovery && !args.classify) {
    throw new Error("--no-discovery with --no-classify does nothing — pick at least one mode");
  }
  const nowIso = args.now || new Date().toISOString();
  log("start now=" + nowIso + " out=" + args.out +
    " discovery=" + String(args.discovery) + " classify=" + String(args.classify));

  let snapshotRows = [];
  if (args.snapshot) {
    snapshotRows = parseSnapshot(await Deno.readTextFile(args.snapshot));
    log("snapshot rows=" + String(snapshotRows.length));
  } else {
    log("no --snapshot given: reconciliation deletes and classification-queue skipping will be conservative (treats table as empty)");
  }

  const out = [];
  out.push("-- swim.report offline discovery + water-class delta");
  out.push("-- generated: " + nowIso);
  out.push("-- mode: discovery=" + String(args.discovery) + " classify=" + String(args.classify));
  out.push("");

  // Inputs to the classification queue. In classify-only mode nothing is
  // discovered or deleted, so the queue is exactly (snapshot rows needing class).
  let mergedRows = [];
  let deletedIds = new Set();

  if (args.discovery) {
    const discovery = await runDiscovery();
    const hasPark = discovery.parkBeaches !== null;
    const merged = mergeBeachRows(
      discovery.namedRows,
      discovery.parkBeaches === null ? [] : discovery.parkBeaches
    );
    mergedRows = merged.rows;
    log("discovery merged rows=" + String(merged.rows.length) +
      " skipped_unnamed=" + String(merged.skippedUnnamed) + " park_query=" + String(hasPark));

    const producedIds = new Set(merged.rows.map(function (r) { return r.id; }));
    const producedParkRowCount = merged.rows.filter(function (r) {
      return r.parkName !== null && r.name === r.parkName;
    }).length;

    // 1. flag_history retention sweep (moved here from runOverpassSync).
    const cutoffIso = new Date(Date.parse(nowIso) - FLAG_HISTORY_RETENTION_DAYS * 86400000).toISOString();
    out.push("-- flag_history retention (" + String(FLAG_HISTORY_RETENTION_DAYS) + " days)");
    out.push("DELETE FROM flag_history WHERE observed_at < " + sqlStr(cutoffIso) + ";");
    out.push("");

    // 2. Beach upserts (enrichment columns — nws_zone/eccc_zone/webcam_* — are
    //    untouched by ON CONFLICT, exactly as the Worker upsert preserves them).
    out.push("-- beach upserts (" + String(merged.rows.length) + ")");
    for (const row of merged.rows) {
      out.push(upsertSql(row, hasPark));
    }
    out.push("");

    // 3. Stale park-beach reconciliation (only on a full park run + snapshot).
    //    deletedIds is derived from the SAME staleRows that produce the DELETEs, so
    //    the classify-universe exclusion set is exactly the set actually deleted
    //    (never a superset that could drop a still-present row from classification).
    if (hasPark && args.snapshot) {
      const staleRows = reconcileStaleRows(snapshotRows, producedIds, producedParkRowCount);
      if (staleRows.length > 0) {
        out.push("-- stale park-beach reconciliation (" + String(staleRows.length) + ")");
        for (const r of staleRows) { out.push(deleteBeachSql(r.id)); }
        out.push("");
      }
      deletedIds = new Set(staleRows.map(function (r) { return r.id; }));
    } else if (hasPark && !args.snapshot) {
      log("reconciliation skipped: no snapshot to compare against");
    }

    // 4. sync_meta bookkeeping.
    out.push("-- sync_meta");
    out.push(syncMetaSql("last_overpass_sync", nowIso, nowIso));
    out.push(syncMetaSql("last_overpass_count", String(merged.rows.length), nowIso));
    out.push("");
  } else {
    log("discovery skipped (--no-discovery): classify-only run — no Overpass tiling, no upserts, no reconciliation, no deletes");
  }

  // 5. Water-body classification (the pipeline's slow part; runs as its own job).
  // Classify statements are flushed INCREMENTALLY (one complete UPDATE per append)
  // so a run cancelled mid-queue by the job timeout still leaves a valid partial
  // .sql on disk — the Upload+Apply steps are always()-gated (a timeout cancel
  // would SKIP !cancelled() steps) to load it, truncating any torn tail first.
  let flushed = false;
  if (args.classify) {
    const queue = buildClassifyQueue(snapshotRows, mergedRows, deletedIds);
    log("classification queue=" + String(queue.length) +
      (args.classifyLimit > 0 ? " (limit " + String(args.classifyLimit) + ")" : " (all)"));
    // Write the preamble once so the file exists from the first statement. In
    // discovery+classify mode out[] already holds the completed discovery SQL
    // (runDiscovery/reconcile finished synchronously above); in classify-only
    // mode it holds just the header comment block.
    await Deno.writeTextFile(args.out, out.join("\n") + "\n");
    let headerWritten = false;
    const flush = async function (stmt) {
      let chunk = "";
      if (!headerWritten) {
        chunk = "-- water-class updates (incremental)\n";
        headerWritten = true;
      }
      chunk = chunk + stmt + "\n";
      await Deno.writeTextFile(args.out, chunk, { append: true });
    };
    const result = await classifyQueue(queue, {
      limit: args.classifyLimit,
      delayMs: args.classifyDelayMs,
      budgetMs: args.classifyBudgetMs,
      flush: flush
    });
    const c = result.counts;
    log("classification done attempted=" + String(c.attempted) + " classified=" + String(c.classified) +
      " ocean=" + String(c.ocean) + " great_lake=" + String(c.great_lake) + " inland=" + String(c.inland) +
      " bumped=" + String(c.bumped) + " transient=" + String(c.transient));
    log("stopped_on_budget=" + String(result.stopped) + " processed=" + String(result.processed));
    flushed = true;
  } else {
    log("classification skipped (--no-classify)");
  }

  // Discovery-only runs write the whole file atomically here, exactly as before.
  // Classify runs already flushed incrementally, so do NOT re-write (that would
  // clobber the appended water-class UPDATEs).
  if (!flushed) {
    await Deno.writeTextFile(args.out, out.join("\n") + "\n");
    log("wrote " + args.out);
  }
}

// Only run as an entrypoint (Deno). Importing this module (e.g. under vitest to
// test the pure SQL/queue builders above) does NOT trigger discovery.
if (import.meta.main) {
  main().catch(function (err) {
    console.error("discovery-batch: FATAL: " + (err && err.stack ? err.stack : err));
    Deno.exit(1);
  });
}
