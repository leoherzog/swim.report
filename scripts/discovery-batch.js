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

// --- Constants mirrored from src/index.js (keep in sync) --------------------
// PILOT_BBOX and the discovery/reconciliation rails are defined in src/index.js
// and are NOT exported there (exporting would drag the whole Worker import graph
// into this process). They change rarely; the values below MUST match
// src/index.js. The water-class constants ARE imported from src/waterClass.js
// (their single source of truth), so they can never drift.
const PILOT_BBOX = { minLon: -87.6, minLat: 41.6, maxLon: -82.3, maxLat: 46.6 };
const OVERPASS_RETRY_DELAY_MS = 60000;
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
    classify: true,
    classifyLimit: 0,       // 0 = classify the entire eligible queue
    classifyDelayMs: 300,   // polite gap between per-beach Overpass probes
    now: null
  };
  for (let i = 0; i < argv.length; i = i + 1) {
    const a = argv[i];
    if (a === "--snapshot") { args.snapshot = argv[++i]; }
    else if (a === "--out") { args.out = argv[++i]; }
    else if (a === "--no-classify") { args.classify = false; }
    else if (a === "--classify-limit") { args.classifyLimit = parseInt(argv[++i], 10) || 0; }
    else if (a === "--classify-delay-ms") { args.classifyDelayMs = parseInt(argv[++i], 10) || 0; }
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

// --- Discovery fetch (mirrors runOverpassSync's retry orchestration) --------
// The two Overpass queries never overlap (overpass-api.de allows 2 slots/IP);
// each gets a single delayed retry. namedRows null after retry => abort with no
// output (never emit a partial that could drive reconciliation deletes).
// parkBeaches null after retry => degrade to a named-only run (no park_name
// updates, no reconciliation), exactly like the Worker.
async function runDiscovery(retryMs) {
  let namedRows = await fetchBeaches(PILOT_BBOX);
  if (namedRows === null) {
    log("fetchBeaches returned null, retrying once after " + String(retryMs) + "ms");
    await sleep(retryMs);
    namedRows = await fetchBeaches(PILOT_BBOX);
    if (namedRows === null) {
      throw new Error("fetchBeaches retry also returned null — aborting, no SQL emitted");
    }
    log("fetchBeaches retry succeeded");
  }

  let parkBeaches = await fetchParkBeaches(PILOT_BBOX);
  if (parkBeaches === null) {
    log("fetchParkBeaches returned null, retrying once after " + String(retryMs) + "ms");
    await sleep(retryMs);
    parkBeaches = await fetchParkBeaches(PILOT_BBOX);
    if (parkBeaches === null) {
      log("fetchParkBeaches retry also returned null — degraded named-only run (no park updates, no reconciliation)");
    } else {
      log("fetchParkBeaches retry succeeded");
    }
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
// park_name) inside PILOT_BBOX from the D1 snapshot; stale = not produced this
// run. Refuse the whole delete if the stale set exceeds the allowance (a
// partial/truncated discovery must never mass-delete enriched rows).
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
export function reconcileStaleRows(snapshotRows, producedIds, producedParkRowCount) {
  if (producedParkRowCount === 0) {
    log("reconciliation skipped, run produced 0 park-containment rows");
    return [];
  }
  const inBbox = function (r) {
    return typeof r.lat === "number" && typeof r.lon === "number" &&
      r.lat >= PILOT_BBOX.minLat && r.lat <= PILOT_BBOX.maxLat &&
      r.lon >= PILOT_BBOX.minLon && r.lon <= PILOT_BBOX.maxLon;
  };
  const candidates = snapshotRows.filter(function (r) {
    return r.park_name !== null && r.park_name !== undefined &&
      r.name === r.park_name && inBbox(r);
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

async function classifyQueue(queue, limit, delayMs) {
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
  for (let i = 0; i < total; i = i + 1) {
    const beach = ordered[i];
    counts.attempted = counts.attempted + 1;
    let signals = null;
    try {
      signals = await fetchWaterClassSignals(beach);
    } catch (err) {
      log("water class fetch threw for " + beach.id + ": " + err.message);
      signals = null;
    }
    if (signals === null) {
      counts.transient = counts.transient + 1;
    } else {
      const cls = classifyWaterBody(signals);
      if (cls !== null) {
        statements.push(classifyUpdateSql(beach.id, cls));
        counts.classified = counts.classified + 1;
        counts[cls] = counts[cls] + 1;
      } else {
        statements.push(bumpAttemptsSql(beach.id));
        counts.bumped = counts.bumped + 1;
      }
    }
    if ((counts.attempted % 25) === 0) {
      log("classified " + String(counts.attempted) + "/" + String(total) + " (" +
        String(counts.classified) + " decided, " + String(counts.transient) + " transient)");
    }
    if (i < total - 1) {
      await sleep(delayMs);
    }
  }
  if (limit > 0 && queue.length > total) {
    log("NOTE: --classify-limit capped this run at " + String(total) + " of " +
      String(queue.length) + " eligible beaches; re-run to drain the rest");
  }
  return { statements: statements, counts: counts };
}

// --- Main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(Deno.args);
  const nowIso = args.now || new Date().toISOString();
  log("start now=" + nowIso + " out=" + args.out + " classify=" + String(args.classify));

  let snapshotRows = [];
  if (args.snapshot) {
    snapshotRows = parseSnapshot(await Deno.readTextFile(args.snapshot));
    log("snapshot rows=" + String(snapshotRows.length));
  } else {
    log("no --snapshot given: reconciliation deletes and classification-queue skipping will be conservative (treats table as empty)");
  }

  const discovery = await runDiscovery(OVERPASS_RETRY_DELAY_MS);
  const hasPark = discovery.parkBeaches !== null;
  const merged = mergeBeachRows(
    discovery.namedRows,
    discovery.parkBeaches === null ? [] : discovery.parkBeaches
  );
  log("discovery merged rows=" + String(merged.rows.length) +
    " skipped_unnamed=" + String(merged.skippedUnnamed) + " park_query=" + String(hasPark));

  const producedIds = new Set(merged.rows.map(function (r) { return r.id; }));
  const producedParkRowCount = merged.rows.filter(function (r) {
    return r.parkName !== null && r.name === r.parkName;
  }).length;

  const out = [];
  out.push("-- swim.report offline discovery + water-class delta");
  out.push("-- generated: " + nowIso);
  out.push("-- merged_rows: " + String(merged.rows.length) + ", park_query: " + String(hasPark));
  out.push("");

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
  let deletedIds = new Set();
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

  // 5. Water-body classification (the pipeline's slow part; offline it just
  //    loops, no per-run cap unless --classify-limit).
  if (args.classify) {
    const queue = buildClassifyQueue(snapshotRows, merged.rows, deletedIds);
    log("classification queue=" + String(queue.length) +
      (args.classifyLimit > 0 ? " (limit " + String(args.classifyLimit) + ")" : " (all)"));
    const result = await classifyQueue(queue, args.classifyLimit, args.classifyDelayMs);
    const c = result.counts;
    log("classification done attempted=" + String(c.attempted) + " classified=" + String(c.classified) +
      " ocean=" + String(c.ocean) + " great_lake=" + String(c.great_lake) + " inland=" + String(c.inland) +
      " bumped=" + String(c.bumped) + " transient=" + String(c.transient));
    if (result.statements.length > 0) {
      out.push("-- water-class updates (" + String(result.statements.length) + ")");
      for (const s of result.statements) { out.push(s); }
      out.push("");
    }
  } else {
    log("classification skipped (--no-classify)");
  }

  await Deno.writeTextFile(args.out, out.join("\n") + "\n");
  log("wrote " + args.out);
}

// Only run as an entrypoint (Deno). Importing this module (e.g. under vitest to
// test the pure SQL/queue builders above) does NOT trigger discovery.
if (import.meta.main) {
  main().catch(function (err) {
    console.error("discovery-batch: FATAL: " + (err && err.stack ? err.stack : err));
    Deno.exit(1);
  });
}
