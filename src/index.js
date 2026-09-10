import { handleRequest } from "./router.js";
import { renderErrorPage } from "./frontend/render.js";
import { STALE_MS } from "./displayFlag.js";
import { estimateFlag, SEVERITY_RANK, alertsInEffect } from "./rules.js";
import {
  fetchAllActiveAlerts,
  nwsAlertsForZone,
  alertsUrlForZone,
  wfoFromGridUrl,
  fetchLatestSrfText,
  fetchPointMetadata,
  fetchPointMetadataDetailed,
  isMarineZoneId,
  landProbePoints
} from "./clients/nws.js";
import {
  fetchActiveEcccAlerts,
  fetchEcccForecastZones,
  ecccZoneNameForPoint
} from "./clients/eccc.js";
import { fetchActiveEcccMarineAlerts } from "./clients/ecccMarine.js";
import { parseRipCurrentRisk } from "./clients/srfParser.js";
import { FLAG_WORTHY_WATER_SQL } from "./waterClass.js";
import {
  fetchNearestWebcam,
  fetchWebcamsInBbox,
  parseNearestActiveWebcam,
  WEBCAM_FETCH_LIMIT
} from "./clients/windyWebcams.js";
import {
  findScraper,
  scrapeOfficialFlagFromResult,
  scrapeReadingFromResult
} from "./officialSources/index.js";
import { READING_MAX_AGE_MS } from "./officialReading.js";
import { findWqFloorSource, scrapeWqFloorFromResult } from "./wqFloor/index.js";
import { WIND_SOURCE, waveSourceLabel, waveSourceUrl } from "./waveModels.js";
import { resolveWaveInput } from "./waveInput.js";
import { nearestWaterTempStation, stationWaterTemp } from "./waveSources/ndbcBuoys.js";
import { updateScraperHealth } from "./scraperHealth.js";
import { HOT_VIEW_WINDOW_MS } from "./demandWindow.js";
import { FLAG_TTL_SECONDS } from "./flagTtl.js";
import {
  buildAlertInputs,
  buildEstimateInputs,
  sealFromSignals,
  signalsFromStanding
} from "./flagInputs.js";
import {
  WQFLOOR_TTL_SECONDS,
  beachStateUpsertStatements,
  estimateCasStatement,
  chunkStatements
} from "./beachState.js";
import { makeDeadline, runPool } from "./pool.js";

// Rows per hourly run. The cap bounds one run's wall clock and KV write budget
// against the 900 s scheduled ceiling; it does not have to cover the table.
// Cold rows rotate, and FLAG_TTL_SECONDS is what carries a beach between its
// turns, so the two must satisfy:
//
//   FLAG_TTL_SECONDS / 3600 >= ceil((flagWorthy - hot) / (this - hot)) + 2
//
// The hard requirement is that this stay above the hot count (last_viewed inside
// HOT_VIEW_WINDOW_MS, logged as hot=): hot rows are covered every run, so at
// hot >= this the cold tier gets no slots and starves whatever the TTL is. The
// run logs oldest=, the oldest cursor stamp it selected, so the left side of
// that inequality is measurable rather than assumed.
//
// The inequality, not wall clock, is what sets this number. At 9,068 flag-worthy
// rows and 719-837 hot, 3000 gives the cold tier ~2,160 slots, a four-run
// rotation, and 6 <= 7 with one run of slack. Lowering it eats that slack fast,
// because the hot tier comes off the top: 2600 lands exactly on 7 <= 7 with none
// left, and 2000 gives a ten-run rotation and ages half the cold coast out to
// unknown between turns. Wall clock is not the constraint here — the 3000-row run
// measures 187-206 s against the 900 s ceiling, at 1.0-2.7 s of CPU — so a cut
// made to save KV writes has to come from the rotation arithmetic or from the
// TTL, never from this number alone. Read oldest= and the run's own timestamps
// before moving it either way. Real pagination is still required past what one
// run can walk (TODO.md).
const MAX_BEACHES_PER_RUN = 3000;
// HOT_VIEW_WINDOW_MS is imported from ./demandWindow.js and deliberately not
// re-exported: workerd rejects any non-function named export on the entry module
// and fails the Worker at startup. See demandWindow.js.
// FLAG_TTL_SECONDS (25200) is imported from ./flagTtl.js and deliberately not
// re-exported: workerd rejects any non-function named export on the entry
// module and fails the Worker at startup.
// The estimate is rewritten on every rotation turn and never retracted, so this
// lease is pure expiry: it must outlive the gap between one beach's turns rather
// than bound how long a withdrawn reading keeps rendering. That gap is
// ceil((flagWorthy - hot) / (MAX_BEACHES_PER_RUN - hot)) hourly runs, plus one
// hour for every run killed before its trailing recompute_updated batch commits,
// plus the beach_state flush's position inside a run capped at 900 s. Seven
// hours covers a four-run rotation with two lost runs. A beach at the far end
// renders its last reading, marked stale on the detail page, instead of dropping
// to no-data; the list chip and the map marker carry no age signal, so a
// rotation-old color reads there exactly like a fresh one.
//
// The official record shares this lease by default. The two are the operands of
// displayFlag, so the estimate must never outlive the posted flag it is
// weighed against; a scraper on a reduced cadence may opt into a longer one
// through officialTtlSeconds, which every reader honors on its own column.
//
// The water-quality advisory keeps the shorter WQFLOOR_TTL_SECONDS lease
// (src/beachState.js): a run that finds no advisory writes nothing, so expiry is
// the only way a cleared one stops rendering.
// The water-temp reading is refreshed on the 6-hourly cron, so its KV must
// outlive the gap between runs plus slack for a failed one. The offline wave
// pipeline writes "waveinput:"/"waves:" on its own absolute expiration and does
// not read this constant.
const WAVE_DATA_TTL_SECONDS = 25200;
// Requested width for every fan-out pool in both crons. Cloudflare caps an
// invocation at six simultaneous open connections, and an upstream fetch or a KV
// get/put each counts toward that cap, so 12 yields ~6 in flight with the
// remainder queued: a modest oversubscription that keeps the pipe saturated
// across the long tail of request latencies, not a claim of 12x throughput. Size
// every wall-clock estimate for these passes at 6, never at 12. The per-beach
// D1 state is not pooled at all: it is collapsed into batches of 200 statements
// and applied sequentially (src/beachState.js).
const KV_WRITE_CONCURRENCY = 12;
// Wall-clock budgets for the 6-hourly water-temp cron, measured from the top of
// the invocation, against the 900 s scheduled ceiling. See src/pool.js for the
// rule these implement.
//
// WAVE_GATHER_DEADLINE_MS: no new station fetch starts after T+480 s. Checked
// between units of work, never inside one, so the clients' transport timeouts —
// not this deadline — are what bound a single hung request.
// WAVE_WRITE_DEADLINE_MS: the write pool yields here instead of being killed at
// 900 s. Beaches it never reached are neither written nor stamped, so they sort
// first next run.
const WAVE_GATHER_DEADLINE_MS = 480000;
const WAVE_WRITE_DEADLINE_MS = 840000;
// Wall-clock budget for the hourly cron's SRF gather, measured from the start of
// that step, not from the top of the invocation. The pool runs one fetch per
// distinct WFO at ~6 in flight, each bounded by the client's 45 s timeout, so a
// healthy nation of 60+ WFOs finishes in seconds and this only trips when
// several sockets hang at once. A WFO the pool never reaches gets a null entry,
// which is the same outcome as its own fetch failing: no rip input, never a
// wrong color. Sits after the three 45 s national alert fetches and leaves the
// per-beach pool most of the 900 s ceiling.
const SRF_GATHER_DEADLINE_MS = 120000;
// Ids per wave_updated D1 batch. The flush must be incremental: a single batch
// after the loop never runs when the invocation is killed mid-loop, so the cursor
// never moves and the same prefix of beaches is reprocessed every run forever.
const WAVE_CURSOR_FLUSH_SIZE = 100;
// Rotation cursor per cron. A column name cannot be a bind parameter, so the
// value is concatenated into the SQL as a literal: it must stay a lookup in this
// two-entry whitelist and must never be caller-derived text.
//
// The two crons cannot share one cursor. runFlagRecompute rewrites
// recompute_updated to a single shared nowIso for its entire run every hour,
// flattening the column to ~2 distinct values table-wide, so a cold-tier sort
// over it collapses to id ASC and a fixed tail of the table starves forever.
// Each cron is single-writer of its own column.
const ROTATION_COLUMNS = { flag: "recompute_updated", wave: "wave_updated" };
// Rows selected per run of the enrichment cron, 4x daily. The wall-clock
// deadline below, not this count, is what bounds a run: nearly every ocean
// centroid answers with a marine zone and costs a mean 3.25 nudge probes on
// top of its own lookup, so the run walks this list until the deadline and
// leaves the rest untouched for the next one. 400 is enough that the deadline
// is the binding limit, while a run of pure land hits (one request each) still
// ends well inside it. A beach without nws_zone is alert-blind, so the drain
// rate is a safety property; watch the enrichment log for 429s before raising
// either number.
const NWS_ENRICHMENT_LIMIT = 400;
// Wall-clock budget for the enrichment loop, measured from the run's start.
// Requests cost ~0.6 s each at ENRICHMENT_REQUEST_SPACING_MS plus api.weather.gov
// latency, so this is ~1,300 requests: ~300 marine beaches at their mean cost,
// with two minutes left under the 900 s ceiling for a few 45 s timeouts and the
// trailing COUNT. Checked before every beach and every probe; a beach the
// deadline interrupts is left untouched (no write, no bump) and re-selects.
const NWS_ENRICHMENT_DEADLINE_MS = 780000;
// Rows that fail fetchPointMetadata this many times are permanently parked.
// Otherwise non-US points that api.weather.gov 404s forever would occupy the
// whole nightly batch and starve US beaches (TODO.md).
const NWS_ENRICHMENT_MAX_ATTEMPTS = 5;
// ECCC zone enrichment, own cron, 4x daily: only rows NWS permanently parked
// (nws_zone NULL at the attempts cap) are candidates. Its own attempts cap parks
// points no ECCC region ever matches, such as mid-lake centroids, the same way
// the NWS cap parks non-US points.
const ECCC_ENRICHMENT_LIMIT = 50;
const ECCC_ENRICHMENT_MAX_ATTEMPTS = 5;
// Sanity floor for the bulk forecast-zones fetch, sized against the ~419 features
// the collection holds nationwide. A 200 that parses to far fewer — a degraded
// GeoMet response, or a schema change stripping every feature in the client's
// NAME+geometry filter — is treated exactly like a fetch failure and parks the
// run with no attempt bumps.
// Without it one under-delivered response would push up to
// ECCC_ENRICHMENT_LIMIT beaches at once toward the permanent attempts cap.
const ECCC_ZONES_SANITY_MIN = 100;
// Fixed pause between the sequential api.weather.gov / GeoMet requests the
// enrichment loops make. The Worker egresses from a shared IP pool, which
// api.weather.gov treats like a proxy, so firing hundreds of back-to-back /points requests
// risks a 429 the whole run inherits. Applied between iterations only, never
// before the first request or after the last.
const ENRICHMENT_REQUEST_SPACING_MS = 300;
// Webcam hydration, daily cron: nearest Windy webcam player per beach. Webcams
// appear and disappear slowly, so rows are rechecked on a 14-day cadence. Windy's
// free tier publishes no quota, so 100/night is deliberate polite guesswork
// (TODO.md).
const WEBCAM_ENRICHMENT_LIMIT = 100;
const WEBCAM_RECHECK_MS = 14 * 86400000;
// Webcam clustering: due beaches are bucketed onto a coarse lat/lon grid so a
// cell holding more than one beach shares a single bbox /webcams request instead
// of one nearby query each; a lone beach in a cell keeps the cheaper nearby
// query. The span is far under Windy's zoom-tiered bbox size cap, so the binding
// limit is the per-call cam cap, which the caller guards by falling back to
// per-beach nearby queries when a bucket's result comes back full. The bbox is
// grown by WEBCAM_BBOX_MARGIN_DEG on every side so each beach's full
// WEBCAM_RADIUS_KM neighborhood sits inside it.
const WEBCAM_CLUSTER_SPAN_DEG = 0.2;
const WEBCAM_BBOX_MARGIN_DEG = 0.07;

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i = i + size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// Wall-clock budgets for the water-temp cron, read from env with a fallback to
// the module constants. The override is a plain number, deliberately not a
// callable clock: a function smuggled through the binding object would be a
// namespace hazard on a real Worker env, and a number is enough to make every
// deadline branch reachable in a test, since makeDeadline's expired() uses >= and
// a 0 override trips immediately even under a frozen Date.
function runBudget(env) {
  const gather = env && typeof env.WAVE_GATHER_DEADLINE_MS === "number"
    ? env.WAVE_GATHER_DEADLINE_MS : WAVE_GATHER_DEADLINE_MS;
  const write = env && typeof env.WAVE_WRITE_DEADLINE_MS === "number"
    ? env.WAVE_WRITE_DEADLINE_MS : WAVE_WRITE_DEADLINE_MS;
  return {
    gatherDeadlineMs: gather,
    writeDeadlineMs: write
  };
}

// The run queue shared by both beach-walking crons: flag-worthy rows ordered
// hot-first (a last_viewed demand stamp inside the hot window) ahead of the
// oldest-cursor rotation, capped at MAX_BEACHES_PER_RUN. Only the column list,
// the clock source and the rotation cursor column differ, so the WHERE, the
// hot-first guard, the id ASC tiebreak, the LIMIT and the single bind live here
// once. Returns the bound statement; the caller runs it.
//
// The hot-first demand term applies to both callers: dropping it from the
// 6-hourly cron would let a beach in active demand lose its reading to the
// rotation the moment the table outgrows one run, which is the contract PLAN.md
// section 7 makes. rotation selects the cursor column from the ROTATION_COLUMNS
// whitelist — a column name cannot be a bind parameter, so it is concatenated as
// a literal and the lookup is own-property-checked rather than trusting an
// arbitrary string to index the map.
function selectRunBeaches(env, columns, hotCutoffIso, rotation) {
  const cursorColumn = Object.prototype.hasOwnProperty.call(ROTATION_COLUMNS, rotation)
    ? ROTATION_COLUMNS[rotation]
    : ROTATION_COLUMNS.flag;
  return env.DB.prepare(
    "SELECT " + columns + " FROM beaches WHERE " + FLAG_WORTHY_WATER_SQL +
    " ORDER BY (last_viewed IS NOT NULL AND last_viewed >= ?1) DESC, " + cursorColumn +
    " ASC, id ASC LIMIT " + String(MAX_BEACHES_PER_RUN)
  ).bind(hotCutoffIso);
}

// Incremental wave_updated stamper (migration 0012). Flushes ids in batches of
// flushSize as the write pool reaches them, never once after the loop: a single
// trailing D1 batch does not run when the invocation is killed mid-loop, so the
// cursor never advances and every subsequent run reprocesses the same prefix
// while the tail starves. A truncated run must persist the progress it made.
//
// A D1 failure here is logged and swallowed. It must never poison KV writes that
// already succeeded; the only consequence of a lost flush is that those beaches
// repeat next run.
function makeWaveCursorStamper(env, nowIso, flushSize) {
  const pending = [];
  let flushing = false;

  async function flush(ids) {
    if (ids.length === 0) {
      return;
    }
    try {
      await env.DB.batch(ids.map(function (id) {
        return env.DB.prepare(
          "UPDATE beaches SET wave_updated = ?1 WHERE id = ?2"
        ).bind(nowIso, id);
      }));
    } catch (err) {
      console.log(
        "index: wave cursor flush failed for " + String(ids.length) + " beaches: " + err.message
      );
    }
  }

  return {
    // Called from inside the write pool, so several runners can be adding
    // concurrently. The flushing guard keeps at most one D1 batch in flight, and
    // splicing the whole pending array out in one synchronous step means no id is
    // flushed twice or dropped; ids added mid-flush ride the next one.
    add: async function (id) {
      pending.push(id);
      if (pending.length >= flushSize && !flushing) {
        flushing = true;
        const ids = pending.splice(0, pending.length);
        await flush(ids);
        flushing = false;
      }
    },
    // Called after the pool has fully settled, so nothing is in flight and
    // nothing can be added behind it.
    drain: async function () {
      const ids = pending.splice(0, pending.length);
      await flush(ids);
    }
  };
}

// One page of the alert refresh's working set: flag-worthy beaches carrying a
// live estimate, keyset-paged on b.id so a run walks the whole table without an
// OFFSET scan. ?1 is the run instant in epoch seconds and ?2 the cursor, the last
// id of the previous page (the empty string starts a run, since every id sorts
// after it). Beaches with no row, an expired estimate or a NULL blob are excluded
// by the join and the WHERE: there is nothing to compare a current alert set
// against, and the hourly owns publishing the first estimate.
//
// water_class rides along because this cron recomputes rules.js step 3 against
// the row's own thresholds; lat/lon and the three zone columns are what
// buildAlertInputs matches on.
//
// The SELECT carries the estimate blob, so a page is at most 500 estimates each
// holding capped alert text (TEXT_CAPS in src/clients/alertMatch.js); that is
// the memory bound of the run. The page size is this cron's only constant.
const ALERT_REFRESH_PAGE_SIZE = 500;
const ALERT_REFRESH_SQL =
  "SELECT b.id, b.lat, b.lon, b.nws_zone, b.marine_zone, b.eccc_zone, b.water_class, " +
  "s.estimate, s.estimate_updated, s.estimate_expires " +
  "FROM beaches b JOIN beach_state s ON s.beach_id = b.id WHERE " + FLAG_WORTHY_WATER_SQL +
  " AND s.estimate IS NOT NULL AND s.estimate_expires > ?1 AND b.id > ?2 " +
  "ORDER BY b.id LIMIT " + String(ALERT_REFRESH_PAGE_SIZE);

// D1 answers a transient "Connection closed" or "overloaded" by asking the
// caller to retry, so every state batch gets exactly one second try; a second
// rejection is the chunk's final answer.
const STATE_BATCH_RETRY_DELAY_MS = 1000;

async function batchWithRetry(env, group, label) {
  try {
    return await env.DB.batch(group);
  } catch (err) {
    console.log(
      "index: " + label + " chunk of " + String(group.length) +
      " failed, retrying once: " + err.message
    );
  }
  await sleep(STATE_BATCH_RETRY_DELAY_MS);
  return await env.DB.batch(group);
}

// Flushes one pass's beach_state descriptors and reports which beaches actually
// landed. Chunks are applied sequentially and each is its own D1 batch, so a
// rejected chunk costs only its own rows: they are absent from the returned id
// set, which is what keeps a flag_history row from claiming an estimate that was
// never persisted. rows and failures are row counts and sum to the descriptor
// total.
async function flushBeachState(env, writes) {
  const byBeach = new Map();
  for (const write of writes) {
    if (!write || !write.beachId) {
      continue;
    }
    if (!byBeach.has(write.beachId)) {
      byBeach.set(write.beachId, []);
    }
    byBeach.get(write.beachId).push(write);
  }
  const ids = [];
  const statements = [];
  for (const beachId of byBeach.keys()) {
    // One statement per beach: beachStateUpsertStatements merges the estimate
    // pass's descriptor with the official/reading pass's, so the id list and the
    // statement list stay index-aligned.
    const built = beachStateUpsertStatements(env.DB, byBeach.get(beachId));
    for (const statement of built) {
      ids.push(beachId);
      statements.push(statement);
    }
  }
  const persisted = new Set();
  let rows = 0;
  let failures = 0;
  let offset = 0;
  for (const group of chunkStatements(statements)) {
    const groupIds = ids.slice(offset, offset + group.length);
    offset = offset + group.length;
    try {
      await batchWithRetry(env, group, "beach_state");
      for (const id of groupIds) {
        persisted.add(id);
      }
      rows = rows + group.length;
    } catch (err) {
      failures = failures + group.length;
      console.log(
        "index: beach_state chunk of " + String(group.length) +
        " failed: " + err.message
      );
    }
  }
  return { persisted: persisted, rows: rows, failures: failures };
}

// Hourly estimate recompute. Fetches the fast-changing safety signals (alerts,
// rip-current risk) every hour but takes wave height and the wind fallback from
// the KV the offline NOAA GRIB pipeline bulk-writes; no wave fetch is reachable
// from this Worker at all.
//
// Every derived record it produces — estimate, wqfloor, official, reading — is
// collected as a beach_state write descriptor and applied in batches: the
// estimates as soon as the pool returns, the officials and readings after the
// scrape pass. Both flushes COALESCE onto the same row, so a beach that produced
// both ends the run as one row.
async function runFlagRecompute(env) {
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const nowEpoch = Math.floor(nowMs / 1000);
  // Descriptors for the two beach_state flushes. A record this run did not
  // produce is simply absent: the upsert COALESCEs, so expiry stays the only
  // retraction path for a cleared advisory, official or reading. They are
  // flushed separately — estimates the moment the pool returns, officials and
  // readings after the scrape pass — because a run killed at the 900 s ceiling
  // inside the scrapes must still keep the estimates it already computed.
  const estimateWrites = [];
  const officialWrites = [];
  let estimateCount = 0;
  let officialCount = 0;
  let readingCount = 0;
  let failureCount = 0;

  // Calibration signal (migration 0006): capture per-beach estimate and official
  // readings this run, then log a flag_history row only where both exist.
  // Estimate-only beaches are never logged, so the table records
  // estimated-vs-official pairs instead of growing with the whole beach set.
  const estimatesByBeach = new Map();
  const officialsByBeach = new Map();

  const hotCutoffIso = new Date(Date.now() - HOT_VIEW_WINDOW_MS).toISOString();

  try {
    const beachesResult = await selectRunBeaches(env, "*", hotCutoffIso, "flag").all();
    const beaches = beachesResult.results || [];

    // Step 3: alerts — one national fetch, matched to the run's distinct zone ids
    // locally. Costs a single subrequest regardless of zone count, so nationwide
    // scale-out never multiplies alert calls. A failed fetch maps every zone to
    // null, leaving per-beach alertsCheckable true. Each zone's entry keeps the
    // zone-scoped provenance URL for its beaches' source entries.
    //
    // A beach's land forecast zone (nws_zone, "MIZ056") and its adjacent marine
    // zone (marine_zone, "LMZ874") go through the same map: marine warnings and
    // Small Craft Advisory are zoned to the marine zone, but they ride the same
    // national feed and the two id namespaces cannot collide.
    const zones = Array.from(
      new Set(
        beaches
          .reduce(function (acc, b) { return acc.concat([b.nws_zone, b.marine_zone]); }, [])
          .filter(function (z) { return z !== null && z !== undefined; })
      )
    );
    const alertsMap = new Map();
    if (zones.length > 0) {
      let nationalAlerts = null;
      try {
        nationalAlerts = await fetchAllActiveAlerts();
      } catch (err) {
        console.log("index: nws alerts fetch threw: " + err.message);
        nationalAlerts = null;
      }
      for (const zone of zones) {
        if (nationalAlerts === null) {
          alertsMap.set(zone, null);
        } else {
          const matched = nwsAlertsForZone(nationalAlerts.alerts, zone);
          alertsMap.set(zone, {
            events: matched.events,
            details: matched.details,
            sourceUrl: alertsUrlForZone(zone)
          });
        }
      }
    }

    // Step 3b: ECCC alerts for Canadian beaches (eccc_zone set by the ECCC
    // enrichment cron; such rows always have nws_zone NULL). One national fetch
    // returns every active alert with its region polygon and per-beach matching
    // is a local point-in-polygon in step 7, so this costs a single subrequest
    // regardless of beach count. Skipped when the run has no Canadian rows; null
    // means the fetch failed and alertsCheckable stays true.
    const ecccBeaches = beaches.filter(function (b) {
      return !b.nws_zone && b.eccc_zone;
    });
    let ecccAlerts = null;
    let ecccMarineAlerts = null;
    if (ecccBeaches.length > 0) {
      try {
        ecccAlerts = await fetchActiveEcccAlerts(nowIso);
      } catch (err) {
        console.log("index: eccc alerts fetch threw: " + err.message);
        ecccAlerts = null;
      }
      // ECCC marine warnings come from a separate GeoMet collection, disjoint
      // from the land weather-alerts one. Own try/catch so a marine-fetch failure
      // never nulls the land alerts or the reverse; one national fetch, matched
      // locally per beach in step 7.
      try {
        ecccMarineAlerts = await fetchActiveEcccMarineAlerts(nowIso);
      } catch (err) {
        console.log("index: eccc marine alerts fetch threw: " + err.message);
        ecccMarineAlerts = null;
      }
    }

    // Step 4: SRF, once per distinct WFO.
    const wfos = Array.from(
      new Set(
        beaches
          .map(function (b) { return wfoFromGridUrl(b.nws_grid_url); })
          .filter(function (w) { return w !== null; })
      )
    );
    // Pooled rather than sequential: one WFO at a time bounded only by the 45 s
    // transport timeout lets a handful of slow WFOs spend the 900 s ceiling
    // before any beach is written. Every WFO gets an entry, null on any failure,
    // on a throw, or when the gather deadline leaves it unreached, so one bad WFO
    // affects nothing but its own beaches.
    const srfMap = new Map();
    for (const wfo of wfos) {
      srfMap.set(wfo, null);
    }
    const srfDeadline = makeDeadline(Date.now(), SRF_GATHER_DEADLINE_MS);
    const srfReached = await runPool(wfos, KV_WRITE_CONCURRENCY, async function (wfo) {
      try {
        const srf = await fetchLatestSrfText(wfo);
        if (srf !== null) {
          const risk = parseRipCurrentRisk(srf.text);
          srfMap.set(wfo, { risk: risk, sourceUrl: srf.sourceUrl, productId: srf.productId });
        }
      } catch (err) {
        console.log("index: srf fetch threw for wfo " + wfo + ": " + err.message);
        srfMap.set(wfo, null);
      }
    }, srfDeadline);
    if (srfReached < wfos.length) {
      console.log(
        "index: srf gather deadline reached=" + String(srfReached) +
        " of " + String(wfos.length) + " wfos"
      );
    }

    // Step 5: wave inputs — read only, never fetched here. The offline NOAA GRIB
    // pipeline bulk-writes a "waveinput:" + id payload
    // ({ waveHeightFt, model, windSpeedMph, windGustMph, startIso, hoursFt, updated })
    // per beach. A missing key — no cycle has landed, or its data aged past its
    // expiration — yields no wave input, and the estimate degrades to the wind
    // fallback or "unknown", never a wrong flag. Prefetched concurrently in chunks
    // so the per-beach loop below stays synchronous.
    //
    // Each record is resolved through src/waveInput.js at nowMs, which indexes the
    // stored series at the hour this run is estimating rather than reading hour 0.
    // That is what lets one landed cycle color a day of runs, and it is why a
    // series-bearing key's lease is the length of its series. A spent series
    // resolves to null and is not stored, so the beach reads exactly as it would
    // with no key at all. Resolving here rather than in the loop below means every
    // beach in a run indexes the same instant.
    const waveInputs = new Map();
    const inputChunks = chunk(beaches, 50);
    for (const group of inputChunks) {
      const fetched = await Promise.all(
        group.map(function (b) {
          return env.FLAGS.get("waveinput:" + b.id, { type: "json" })
            .catch(function () { return null; });
        })
      );
      for (let i = 0; i < group.length; i = i + 1) {
        const resolved = resolveWaveInput(fetched[i], nowMs);
        if (resolved !== null) {
          waveInputs.set(group[i].id, resolved);
        }
      }
    }

    // Step 5b: water-quality floor gather, mirroring the step-8 official-scraper
    // grouping: group beaches by their matching wqFloor source and fetch each
    // source once per run, so a table-wide advisory source costs one fetch. The
    // resolved advisory feeds estimateFlag's waterQualityAdvisory input
    // (rules.js step 7) as a raise-only floor, so it must be in hand before the
    // per-beach estimate below; the step-8 official gather is too late.
    //
    // wqSourceByBeach caches each beach's resolved source so the step-6 loop
    // reuses it instead of re-running findWqFloorSource per beach;
    // wqDistinctSources is the fetch list, one entry per matched source id.
    const wqSourceByBeach = new Map();
    const wqDistinctSources = new Map();
    for (const beach of beaches) {
      const wqs = findWqFloorSource(beach);
      if (wqs) {
        wqSourceByBeach.set(beach.id, wqs);
        if (!wqDistinctSources.has(wqs.id)) {
          wqDistinctSources.set(wqs.id, wqs);
        }
      }
    }
    const wqResultsBySource = new Map();
    for (const wqSource of wqDistinctSources.values()) {
      let wqResult = null;
      try {
        wqResult = await wqSource.scrape(nowIso);
      } catch (err) {
        console.log("index: wqFloor scrape threw for " + wqSource.id + ": " + err.message);
        wqResult = null;
      }
      wqResultsBySource.set(wqSource.id, wqResult);
    }

    // Step 6: per-beach estimate, isolated failures, through the bounded pool
    // — see src/pool.js. The body is pure local work over signals steps 3
    // through 6b already gathered, and every write it produces is a descriptor
    // step 7b flushes, so the width buys no concurrency today; the pool stays as
    // the fan-out bound for any per-beach upstream or storage call added here,
    // and as pool.js's backstop around the body's own catch. Nothing in the body
    // depends on the previous iteration, and estimateCount / failureCount are
    // incremented with a single synchronous statement.
    //
    // The alert half of every beach's bundle is assembled by buildAlertInputs
    // (src/flagInputs.js), the same function the alerts refresh cron calls, so
    // the two crons cannot drift in how they match a zone or attribute a source.
    const alertCtx = {
      alertsMap: alertsMap,
      ecccAlerts: ecccAlerts,
      ecccMarineAlerts: ecccMarineAlerts
    };
    await runPool(beaches, KV_WRITE_CONCURRENCY, async function (beach) {
      try {
        // The non-alert source entries, kept separate from the alert ones so
        // buildEstimateInputs can concat them in the same order the payload has
        // always carried and sealFromSignals can store exactly this half.
        const signalSources = [];
        const alertPart = buildAlertInputs(beach, alertCtx, nowIso);

        let ripCurrentRisk = null;
        const wfo = wfoFromGridUrl(beach.nws_grid_url);
        if (wfo) {
          const srfEntry = srfMap.get(wfo);
          if (srfEntry) {
            ripCurrentRisk = srfEntry.risk;
            signalSources.push({
              label: "NWS Surf Zone Forecast",
              url: srfEntry.sourceUrl
            });
          }
        }

        // Wave height and the wind fallback both come from the stored wave
        // input, already resolved to this run's hour in step 5 (or absent when
        // there is no live data for this beach).
        const waveInput = waveInputs.get(beach.id);

        // Number.isFinite, not typeof "number": rules.js step 3's else branch has
        // no finite guard, so a non-finite reading would decide green with a
        // nonsense reason. Caller-side input validation, not a rule change.
        let waveHeightFt = null;
        if (waveInput && Number.isFinite(waveInput.waveHeightFt)) {
          waveHeightFt = waveInput.waveHeightFt;
          signalSources.push({
            label: waveSourceLabel(waveInput.model),
            url: waveSourceUrl(waveInput.model)
          });
        }

        // Wind is only a fallback for wave-null beaches, and only names its
        // source when it is the signal actually in play. resolveWaveInput has
        // already nulled both wind fields for any hour but the series' first,
        // since the stored wind is an hour-0 sample with no series behind it.
        let windSpeedMph = waveInput && Number.isFinite(waveInput.windSpeedMph)
          ? waveInput.windSpeedMph : null;
        let windGustMph = waveInput && Number.isFinite(waveInput.windGustMph)
          ? waveInput.windGustMph : null;
        if (waveHeightFt === null && (windSpeedMph !== null || windGustMph !== null)) {
          signalSources.push(WIND_SOURCE);
        }

        // Water-quality advisory floor: resolve this beach against its group's
        // already-fetched scrape result (step 5b). A raise-only floor baked into
        // the estimate, never an official override; a clean or absent reading
        // resolves to null and has no effect (rules.js step 7). When present,
        // cite the source so the reason's attribution is visible.
        let waterQualityAdvisory = null;
        const wqSourceForBeach = wqSourceByBeach.get(beach.id);
        if (wqSourceForBeach) {
          const wqResult = wqResultsBySource.get(wqSourceForBeach.id);
          if (wqResult) {
            waterQualityAdvisory = scrapeWqFloorFromResult(beach, wqSourceForBeach, wqResult);
          }
        }
        if (waterQualityAdvisory !== null) {
          signalSources.push({
            label: waterQualityAdvisory.source,
            url: typeof wqSourceForBeach.infoUrl === "string" ? wqSourceForBeach.infoUrl : ""
          });
        }

        // The complete non-alert half, in one object, so the seal below cannot
        // omit a field the estimate consumed: buildEstimateInputs and
        // sealFromSignals are handed the SAME object. buildEstimateInputs also
        // recomputes alertsCheckable, which distinguishes "alerts checked, none
        // active" (alerts === []) from "alerts not checkable" (neither nws_zone
        // nor eccc_zone resolved); when false, estimateFlag appends a "weather
        // alerts are not checked here yet" caveat so a wave-only green is
        // never presentable as alert-verified. A transient alerts-fetch failure
        // for an enriched beach stays alertsCheckable true.
        const signals = {
          alertsResolved: alertPart.alertsResolved,
          ripCurrentRisk: ripCurrentRisk,
          waveHeightFt: waveHeightFt,
          windSpeedMph: windSpeedMph,
          windGustMph: windGustMph,
          waterQualityAdvisory: waterQualityAdvisory,
          signalSources: signalSources,
          updated: nowIso
        };

        const estimate = estimateFlag(buildEstimateInputs(beach, alertPart, signals));
        // The seal is spread on AFTER estimateFlag returns, so rules.js neither
        // sees nor produces it. It is what lets runAlertRefresh recompute this
        // beach from fresh alerts without reconstructing — or losing — a single
        // non-alert input.
        const stored = Object.assign({}, estimate, {
          estimateInputs: sealFromSignals(signals, alertPart)
        });
        // The advisory rides the same descriptor on its own shorter lease, and
        // only when this run resolved one: a clean reading writes nothing and
        // the standing advisory ages out. It is display-only — never an official
        // override, and it never feeds displayFlag.
        estimateWrites.push({
          beachId: beach.id,
          estimate: stored,
          estimateExpires: nowEpoch + FLAG_TTL_SECONDS,
          wqfloor: waterQualityAdvisory,
          wqfloorExpires: waterQualityAdvisory === null
            ? null
            : nowEpoch + WQFLOOR_TTL_SECONDS
        });

        // The detail-page WaveSeries ("waves:" + id) is bulk-written by the
        // offline pipeline; this loop only reads wave inputs.
        //
        // Recording the estimate here does not license a flag_history row: step
        // 9 pairs only beaches whose beach_state chunk actually committed.
        estimatesByBeach.set(beach.id, {
          color: estimate.color,
          rulesVersion: estimate.rules_version,
          updated: estimate.updated
        });
        estimateCount = estimateCount + 1;
      } catch (err) {
        failureCount = failureCount + 1;
        console.log("index: flag estimate failed for beach " + beach.id + ": " + err.message);
      }
    });

    // Step 7b: persist the estimates before the scrape pass starts. Everything
    // below this line is upstream work bounded only by each scraper's own fetch
    // timeout, and a run killed at the 900 s ceiling in there must not cost the
    // beaches it has already estimated.
    const estimateFlush = await flushBeachState(env, estimateWrites);

    // Step 8: officials, one scrape call per distinct matched scraper, then
    // per-beach resolution of the shared result (contract v2). A beach that
    // resolves to no site contributes no official or reading field, so the
    // upsert leaves its stored columns alone and they age out on their own.
    const scraperGroups = new Map();
    for (const beach of beaches) {
      // Isolated per beach: matches() is scraper-supplied and runs outside every
      // other try in this pass, so one row it cannot parse costs its own beach's
      // official, never the whole scrape pass.
      let scraper = null;
      try {
        scraper = findScraper(beach);
      } catch (err) {
        console.log("index: scraper match failed for beach " + beach.id + ": " + err.message);
        scraper = null;
      }
      if (scraper) {
        if (!scraperGroups.has(scraper.id)) {
          scraperGroups.set(scraper.id, { scraper: scraper, beaches: [] });
        }
        scraperGroups.get(scraper.id).beaches.push(beach);
      }
    }
    for (const group of scraperGroups.values()) {
      try {
        let result = null;
        try {
          result = await group.scraper.scrape(nowIso);
        } catch (err) {
          console.log("index: official scrape threw for " + group.scraper.id + ": " + err.message);
          result = null;
        }

        // Scraper health monitoring. Only scrapers with matched beaches this run
        // reach here, so one that was never invoked is never counted as failing.
        // A scraper may also declare healthMonitored(nowIso) for deliberate
        // season or cadence skips; when it returns false this run's null is not
        // counted at all, neither a streak bump nor a reset. Otherwise an
        // off-season scraper crosses the alert threshold in a day, floods an
        // ALERT log every hour for months, and blinds the monitor to real
        // in-season breakage. Costs one KV get plus one KV put per matched
        // scraper per run (PLAN.md section 7). The "scraperhealth:" key is
        // written without expirationTtl so the streak persists across runs.
        const healthMonitored = typeof group.scraper.healthMonitored === "function"
          ? group.scraper.healthMonitored(nowIso) === true
          : true;
        if (healthMonitored) {
          try {
            const healthKey = "scraperhealth:" + group.scraper.id;
            const prevRaw = await env.FLAGS.get(healthKey);
            let prev = null;
            if (prevRaw) {
              try {
                prev = JSON.parse(prevRaw);
              } catch (parseErr) {
                prev = null;
              }
            }
            const health = updateScraperHealth(
              group.scraper.id, prev, result !== null, nowIso
            );
            await env.FLAGS.put(healthKey, JSON.stringify(health.next));
            if (health.alert) {
              console.log(health.alert);
            }
          } catch (err) {
            console.log("index: scraper health update failed for " + group.scraper.id + ": " + err.message);
          }
        }

        if (result === null) {
          continue;
        }
        // Resolving the shared result per beach is pure local work, so this
        // inner loop is sequential; the outer scraperGroups loop must be, since
        // it does a read-modify-write on shared per-scraper "scraperhealth:" KV
        // state and carries the continue above.
        for (const beach of group.beaches) {
          const flag = scrapeOfficialFlagFromResult(beach, group.scraper, result);
          if (flag !== null) {
            // The default matches the estimate's lease: displayFlag weighs
            // this record against the estimate, so an official that lapses first
            // hands a posted red to a stale green. Past displayFlag's 2 h gate
            // the surviving record is raise-only and its card carries the stale
            // warning, so ageing together costs no safety. A scraper on a
            // reduced cadence may opt into a longer lease via
            // officialTtlSeconds, which every reader honors on its own column.
            const officialTtl =
              typeof group.scraper.officialTtlSeconds === "number"
                ? group.scraper.officialTtlSeconds
                : FLAG_TTL_SECONDS;
            officialWrites.push({
              beachId: beach.id,
              official: flag,
              officialExpires: nowEpoch + officialTtl
            });
            officialsByBeach.set(beach.id, {
              color: flag.color,
              source: flag.scraperId || group.scraper.id,
              updated: flag.updated
            });
            officialCount = officialCount + 1;
          }
          // Point-in-time observations expire on their own column, resolved
          // independently of the flag: a site the source reports with no posted
          // flag still publishes a water temperature and a wave height, and the
          // official record above is absent for it.
          //
          // The expiry is ABSOLUTE, anchored to the observation instant rather
          // than the cron tick, so a morning reading dies four hours after it was
          // taken no matter which run picked it up and a re-scrape cannot extend
          // its life. A reading already within a minute of that horizon is not
          // worth publishing, so it is skipped instead.
          const reading = scrapeReadingFromResult(beach, group.scraper, result);
          if (reading !== null) {
            const expiration = Math.floor(
              (Date.parse(reading.observedIso) + READING_MAX_AGE_MS) / 1000
            );
            if (expiration - nowEpoch >= 60) {
              officialWrites.push({
                beachId: beach.id,
                reading: reading,
                readingExpires: expiration
              });
              readingCount = readingCount + 1;
            }
          }
        }
      } catch (err) {
        console.log("index: official scrape failed: " + err.message);
      }
    }

    // Step 8b: persist the officials and readings this run scraped. A rejected
    // chunk in either flush logs and counts toward stateFailures; the history
    // step below pairs only against the estimate flush's persisted set, so it can
    // never claim an estimate that never landed. The upsert COALESCEs every
    // column, so this flush's NULL estimate leaves step 7b's row intact.
    const officialFlush = await flushBeachState(env, officialWrites);
    const stateRows = estimateFlush.rows + officialFlush.rows;
    const stateFailures = estimateFlush.failures + officialFlush.failures;

    // Step 9: calibration history (migration 0006). One row per beach with both
    // a fresh estimate and a scraped official color this run — the paired signal
    // used to tune wave/wind thresholds in src/rules.js. Estimate-only beaches
    // are skipped so the table does not grow by the whole beach set hourly.
    // Written in a single D1 batch to stay within the subrequest budget (PLAN.md
    // section 7); a failure here never poisons the run.
    let historyCount = 0;
    try {
      const historyStatements = [];
      for (const beach of beaches) {
        const estimateEntry = estimatesByBeach.get(beach.id);
        const officialEntry = officialsByBeach.get(beach.id);
        if (estimateEntry && officialEntry && estimateFlush.persisted.has(beach.id)) {
          historyStatements.push(
            env.DB.prepare(
              "INSERT INTO flag_history (beach_id, observed_at, estimated_color, official_color, rules_version, official_source) " +
              "VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
            ).bind(
              beach.id,
              nowIso,
              estimateEntry.color,
              officialEntry.color,
              estimateEntry.rulesVersion,
              officialEntry.source
            )
          );
        }
      }
      if (historyStatements.length > 0) {
        await env.DB.batch(historyStatements);
        historyCount = historyStatements.length;
      }
    } catch (err) {
      console.log("index: failed to write flag_history rows: " + err.message);
    }

    if (beaches.length > 0) {
      try {
        const updateStatements = beaches.map(function (b) {
          return env.DB.prepare(
            "UPDATE beaches SET recompute_updated = ?1 WHERE id = ?2"
          ).bind(nowIso, b.id);
        });
        await env.DB.batch(updateStatements);
      } catch (err) {
        console.log("index: failed to update recompute_updated timestamps: " + err.message);
      }
    }

    const hotCount = beaches.filter(function (b) {
      return b.last_viewed && b.last_viewed >= hotCutoffIso;
    }).length;
    // Oldest cursor stamp in the selected set: the cold-tier wait
    // FLAG_TTL_SECONDS must span. Rows never recomputed carry no wait, so they
    // are skipped rather than reported as the oldest.
    const oldestCursor = beaches.reduce(function (acc, b) {
      if (!b.recompute_updated) {
        return acc;
      }
      return acc === null || b.recompute_updated < acc ? b.recompute_updated : acc;
    }, null);
    console.log(
      "index: flag recompute complete, beaches=" + String(beaches.length) +
      " estimates=" + String(estimateCount) +
      " officials=" + String(officialCount) +
      " readings=" + String(readingCount) +
      " history=" + String(historyCount) +
      " failures=" + String(failureCount) +
      " hot=" + String(hotCount) +
      " waveinputs=" + String(waveInputs.size) +
      " oldest=" + (oldestCursor || "none") +
      " stateRows=" + String(stateRows) +
      " stateFailures=" + String(stateFailures)
    );
  } catch (err) {
    console.log("index: flag recompute failed: " + err.message);
  }
}

// Level-triggered alerts refresh ("3-53/10 * * * *"). NWS alerts are the only
// event-driven input in the system, so this cron closes the gap between a warning
// being issued, taking effect or ending and the flag moving from up to an hour to
// about ten minutes.
//
// Its upstream cost does not scale with the beach table: three national fetches,
// matched to beaches locally. It recomputes every live estimate against those
// fetches through the hourly's own buildAlertInputs, buildEstimateInputs and
// estimateFlag, rebuilding the non-alert half from the estimateInputs seal inside
// the same blob, and writes only the rows whose recomputed payload moved. That is
// why there is no persisted baseline, no zone digest, no gained/changed/cleared
// classification and no first-run semantics: the standing payload arrives on the
// same row the recompute reads.
//
// The compare-and-set closes the write race with the hourly underneath: the
// UPDATE lands only while estimate_updated is still the instant this run
// recomputed against, so an hourly run that rewrote the beach in between wins and
// this one reports no change. If the hourly clobbers a raise with an older
// snapshot, the clobbered value recomputes to the raise again on the next
// cadence. Repair is automatic and bounded at one cadence.
//
// It writes exactly one thing: the estimate blob and its color, for the beaches
// whose payload moved. Never the wqfloor column (the hourly stays its single
// writer, so expiry remains the only way a cleared advisory is withdrawn), never
// the official or reading columns, never estimate_updated or estimate_expires
// (the standing instant is the CAS token and the original lease must not be
// extended), never a flag_history row (it scrapes no officials, so it has no pair
// to log), never a KV key, and above all never recompute_updated, which is
// runFlagRecompute's rotation cursor and single-writer by contract.
async function runAlertRefresh(env) {
  const startedMs = Date.now();
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const nowEpoch = Math.floor(nowMs / 1000);
  let rowCount = 0;
  let written = 0;
  let raised = 0;
  let lowered = 0;
  let skipNoSeal = 0;
  let skipAuthority = 0;
  let skipStaleLower = 0;
  let skipSuperseded = 0;
  let staleWritten = 0;
  let nationalAlerts = null;
  let nwsOk = false;
  let ecccOk = false;

  // skipStaleLower is cold-tier steady state, not an alarm: the hourly rotation
  // is sized at four runs, so a beach whose turn is further back than STALE_MS
  // keeps its color until that turn comes. features high with parsed 0 is the
  // visible signature of an NWS schema drift, which is why both are logged raw.
  function logComplete() {
    console.log(
      "index: alert refresh complete, rows=" + String(rowCount) +
      " written=" + String(written) +
      " raised=" + String(raised) +
      " lowered=" + String(lowered) +
      " skipNoSeal=" + String(skipNoSeal) +
      " skipAuthority=" + String(skipAuthority) +
      " skipStaleLower=" + String(skipStaleLower) +
      " skipSuperseded=" + String(skipSuperseded) +
      " staleWritten=" + String(staleWritten) +
      " nws=" + (nwsOk ? "ok" : "down") +
      " eccc=" + (ecccOk ? "ok" : "down") +
      " features=" + String(nationalAlerts === null ? "none" : nationalAlerts.featureCount) +
      " parsed=" + String(nationalAlerts === null ? "none" : nationalAlerts.alerts.length) +
      " elapsedMs=" + String(Date.now() - startedMs)
    );
  }

  try {
    // Step 1: three national fetches, issued concurrently, each caught on its own
    // and each already bounded by its client's timeoutMs. Nothing else is fetched
    // — no SRF, no wqFloor scrape, no official scrape, no "waveinput:" read — so a
    // 10-minute cadence costs county health departments and Ontario Parks nothing,
    // and there is no second source of truth for any non-alert input.
    const fetched = await Promise.all([
      fetchAllActiveAlerts().catch(function (err) {
        console.log("index: alert refresh nws alerts fetch threw: " + err.message);
        return null;
      }),
      fetchActiveEcccAlerts(nowIso).catch(function (err) {
        console.log("index: alert refresh eccc alerts fetch threw: " + err.message);
        return null;
      }),
      fetchActiveEcccMarineAlerts(nowIso).catch(function (err) {
        console.log("index: alert refresh eccc marine alerts fetch threw: " + err.message);
        return null;
      })
    ]);
    nationalAlerts = fetched[0];
    const ecccAlerts = fetched[1];
    const ecccMarineAlerts = fetched[2];
    // A paginated /alerts/active response is a partial view of the population, so
    // it reads as no feed at all: recomputing against it would clear every zone
    // past the page boundary.
    nwsOk = nationalAlerts !== null && nationalAlerts.truncated !== true;
    // Stricter than the hourly's deliberate proceed-on-partial-success: at 6x
    // cadence a marine-collection outage would repeatedly recompute Canadian
    // beaches with the marine events missing and drop a live "gale warning" red to
    // a wave-height green.
    ecccOk = ecccAlerts !== null && ecccMarineAlerts !== null;
    if (!nwsOk && !ecccOk) {
      // No authority answered, so no row could be recomputed from evidence.
      logComplete();
      return;
    }

    // Zone matches are memoized across pages: a zone is walked against the
    // national feed once per run however many beaches carry it. A plain loop,
    // never a concat reduce — this walks the whole flag-worthy table rather than
    // one capped run, and the quadratic form costs seconds of a sub-hourly cron's
    // 30 s CPU allowance past 20k rows.
    //
    // Invariant: an alertsMap entry is inserted for every non-null nws_zone and
    // marine_zone on the page, so buildAlertInputs takes its US branch for every
    // US row whenever the national fetch landed.
    const alertsMap = new Map();
    function resolveZones(pageRows) {
      if (!nwsOk) {
        return;
      }
      for (const row of pageRows) {
        for (const zone of [row.nws_zone, row.marine_zone]) {
          if (zone === null || zone === undefined || alertsMap.has(zone)) {
            continue;
          }
          const matched = nwsAlertsForZone(nationalAlerts.alerts, zone);
          alertsMap.set(zone, {
            events: matched.events,
            details: matched.details,
            sourceUrl: alertsUrlForZone(zone)
          });
        }
      }
    }
    const alertCtx = {
      alertsMap: alertsMap,
      ecccAlerts: ecccAlerts,
      ecccMarineAlerts: ecccMarineAlerts
    };

    // The diff projection: the whole decided payload, with the seal discarded and
    // alertsAt replaced by the set it decides. The seal's non-alert half is
    // identical because it is rebuilt from the standing blob — its alertsResolved
    // is the explicit first clause of the change test instead. Replacing rather
    // than nulling alertsAt is what makes an onset arriving or an ends lapsing
    // select the beach for every event name, not only the ones a precedence list
    // colors, while raw timestamp churn inside an unchanged set still does not:
    // for the recomputed payload the set resolves at this run's clock, and for the
    // standing one at the instant it was decided, which is what the detail page
    // renders through decidedAlertDetails.
    function comparable(estimate) {
      return JSON.stringify(
        Object.assign({}, estimate, {
          alertsAt: alertsInEffect(estimate.alertDetails, estimate.alertsAt).join("|"),
          estimateInputs: null
        })
      );
    }

    // This page's compare-and-set writes, index-aligned: casWrites[i] carries the
    // rank pair and seal age the completion counters need for casStatements[i].
    const casStatements = [];
    const casWrites = [];

    // Recompute one row and queue it only if its payload moved. Every rejection
    // is a SKIP that leaves the standing value untouched — there is no path here
    // in which estimateFlag is called with a null substituted for a sealed input.
    function recomputeRow(row) {
      let standing = null;
      try {
        standing = JSON.parse(row.estimate);
      } catch (err) {
        standing = null;
      }
      if (!standing || typeof standing !== "object") {
        skipNoSeal = skipNoSeal + 1;
        return;
      }
      const signals = signalsFromStanding(standing);
      const standingMs = signals === null ? NaN : Date.parse(signals.updated);
      if (signals === null || typeof signals.updated !== "string" ||
          !Number.isFinite(standingMs)) {
        // Written before the seal shipped, carrying another seal version, or
        // missing the standing instant the stale rail ages the seal against. An
        // instant the rail cannot age is not a fresh one, so it is a skip rather
        // than an unrailed lowering.
        skipNoSeal = skipNoSeal + 1;
        return;
      }
      // Authority comes off the row's own zone columns rather than from the alert
      // half: buildAlertInputs reports an unenriched beach and an authority whose
      // fetch failed with the same alertsResolved false, and a beach must never be
      // recomputed against a feed that did not arrive.
      const isUs = (row.nws_zone || row.marine_zone) ? true : false;
      const isCa = !isUs && row.eccc_zone ? true : false;
      if ((!isUs && !isCa) || (isUs && !nwsOk) || (isCa && !ecccOk)) {
        skipAuthority = skipAuthority + 1;
        return;
      }
      const alertPart = buildAlertInputs(row, alertCtx, nowIso);
      const next = estimateFlag(buildEstimateInputs(row, alertPart, signals));
      // The standing instant, never this run's clock: with estimate_updated and
      // estimate_expires left out of the CAS, the rewrite is lifetime-neutral and
      // staleness-neutral, so it can move a color and nothing else.
      next.updated = standing.updated;
      const stored = Object.assign({}, next, {
        estimateInputs: sealFromSignals(signals, alertPart)
      });
      // A sealed alertsResolved false is the repair for a failed hourly alert
      // fetch: that run passed alerts null, losing both the short-circuit and the
      // floors, and its echoed alertDetails is [] — indistinguishable from
      // "checked, none active" without the sealed boolean.
      const changed = signals.alertsResolved === false ||
        comparable(stored) !== comparable(standing);
      if (!changed) {
        return;
      }
      const standingRank = SEVERITY_RANK[standing.color] !== undefined
        ? SEVERITY_RANK[standing.color] : 0;
      const nextRank = SEVERITY_RANK[next.color] !== undefined
        ? SEVERITY_RANK[next.color] : 0;
      const sealAgeMs = nowMs - standingMs;
      const stale = sealAgeMs >= STALE_MS;
      // The one lowering rail: a clear-down decided on wave and wind inputs the
      // page itself would render with a stale-data warning waits for the hourly.
      // Raises are never gated on age, because age can only understate a hazard.
      if (nextRank < standingRank && stale) {
        skipStaleLower = skipStaleLower + 1;
        return;
      }
      casStatements.push(
        estimateCasStatement(env.DB, row.id, stored, row.estimate_updated)
      );
      casWrites.push({ nextRank: nextRank, standingRank: standingRank, stale: stale });
    }

    // Flushes one page's writes, each chunk its own D1 batch inside its own
    // try/catch, so a rejected chunk costs only its own beaches and the run still
    // reaches the rest of the table. Writing while paging is safe because the CAS
    // touches only rows at or before the cursor and sets estimate and
    // estimate_color only.
    async function flushPage() {
      let casIndex = 0;
      for (const group of chunkStatements(casStatements)) {
        const base = casIndex;
        casIndex = casIndex + group.length;
        let results = null;
        try {
          results = await batchWithRetry(env, group, "alert refresh");
        } catch (err) {
          console.log(
            "index: alert refresh chunk of " + String(group.length) +
            " failed: " + err.message
          );
          continue;
        }
        for (let i = 0; i < group.length; i = i + 1) {
          const result = results && results[i];
          const changes = result && result.meta ? result.meta.changes : 0;
          if (!changes) {
            // A statement that matched no row lost the CAS to an hourly run that
            // rewrote the beach after this one read it; the hourly's decision
            // stands.
            skipSuperseded = skipSuperseded + 1;
            continue;
          }
          written = written + 1;
          const ranks = casWrites[base + i];
          if (ranks.nextRank > ranks.standingRank) {
            raised = raised + 1;
          } else if (ranks.nextRank < ranks.standingRank) {
            lowered = lowered + 1;
          }
          if (ranks.stale) {
            staleWritten = staleWritten + 1;
          }
        }
      }
      casStatements.length = 0;
      casWrites.length = 0;
    }

    // Keyset paging over the live-estimate join. The cursor is the last id of the
    // page just read, so a run walks the table in id order at a bounded page size
    // and never re-reads a row. Only an empty page ends the walk: an estimate
    // expiring between two reads shortens a page, and treating a short page as the
    // end would abandon every beach past it.
    let cursor = "";
    for (;;) {
      const pageResult = await env.DB.prepare(ALERT_REFRESH_SQL).bind(nowEpoch, cursor).all();
      const pageRows = pageResult.results || [];
      if (pageRows.length === 0) {
        break;
      }
      rowCount = rowCount + pageRows.length;
      resolveZones(pageRows);
      for (const row of pageRows) {
        recomputeRow(row);
      }
      cursor = pageRows[pageRows.length - 1].id;
      await flushPage();
    }

    logComplete();
  } catch (err) {
    console.log("index: alert refresh failed: " + err.message);
  }
}

// 6-hourly water-temperature refresh. Display-only: the reading it publishes
// colors no flag, never reaches src/rules.js and bumps no RULES_VERSION. It is
// the only writer of "watertemp:" + id, which the detail page renders as its
// water-temperature subtitle.
//
// No wave fetching happens here or anywhere in this Worker; "waveinput:" and
// "waves:" are bulk-written by the offline NOAA GRIB pipeline. This cron owns
// beaches.wave_updated (migration 0012) as its rotation cursor: single writer,
// single reader, both inside this function.
//
// Bounded in wall clock end to end (runBudget): no station fetch starts after the
// gather deadline, and the write pool yields at the write deadline rather than
// being killed at the 900 s ceiling. The cursor is stamped incrementally, so a
// truncated run persists a prefix and the beaches it never reached sort first
// next run.
async function runWaterTempRefresh(env) {
  // Measured from the top of the invocation, before the D1 SELECT, so the
  // budgets bound true elapsed time rather than only the phases after it.
  const startedMs = Date.now();
  const nowIso = new Date().toISOString();
  const budget = runBudget(env);
  const gatherDeadline = makeDeadline(startedMs, budget.gatherDeadlineMs);
  const writeDeadline = makeDeadline(startedMs, budget.writeDeadlineMs);
  let waterTempCount = 0;
  let stampedCount = 0;
  // Beaches the write pool reached but whose put threw. Distinct from truncation
  // and from a beach with no reading at all, which writes nothing and is still
  // stamped.
  let writeFailureCount = 0;
  // Unique stations the gather fetched, and the subset that yielded a reading.
  // live=0 against a nonzero stations= is a station family gone dark.
  let stationCount = 0;
  let liveStationCount = 0;
  // Beaches whose station the gather deadline stopped this run from ever
  // fetching: neither written nor stamped, so they sort first next run.
  const unattempted = new Set();

  const hotCutoffIso = new Date(Date.parse(nowIso) - HOT_VIEW_WINDOW_MS).toISOString();

  try {
    const beachesResult = await selectRunBeaches(
      env,
      "id, lat, lon, last_viewed",
      hotCutoffIso,
      "wave"
    ).all();
    const beaches = beachesResult.results || [];

    // Gather. Many beaches share one nearest station, so dedup by station id and
    // fetch each unique station's realtime2 file once, fanning the parsed reading
    // out to every beach under it. Selection goes through nearestWaterTempStation
    // (25 km cap) rather than a capability-agnostic lookup, so a beach with a NOS
    // water-level gauge a few hundred metres away gets a reading; those gauges
    // publish ~1 MB realtime2 files, which is why stationWaterTemp Range-limits
    // every fetch.
    const waterTempByBeach = new Map();
    try {
      const stationBeaches = new Map();
      for (const beach of beaches) {
        const station = nearestWaterTempStation(beach.lat, beach.lon);
        if (station === null) {
          continue;
        }
        if (!stationBeaches.has(station.id)) {
          stationBeaches.set(station.id, []);
        }
        stationBeaches.get(station.id).push({ beachId: beach.id, station: station });
      }
      const stationEntries = Array.from(stationBeaches.entries());
      for (let i = 0; i < stationEntries.length; i = i + 1) {
        const stationId = stationEntries[i][0];
        const members = stationEntries[i][1];
        // Checked between stations, never inside a fetch: the client's own
        // transport timeout is what bounds a single hung request.
        if (gatherDeadline.expired()) {
          console.log(
            "index: water temp gather deadline reached, " +
            String(stationEntries.length - i) + " stations unattempted"
          );
          for (let k = i; k < stationEntries.length; k = k + 1) {
            for (const member of stationEntries[k][1]) {
              unattempted.add(member.beachId);
            }
          }
          break;
        }
        let reading = null;
        stationCount = stationCount + 1;
        try {
          reading = await stationWaterTemp(stationId, nowIso, env);
        } catch (err) {
          console.log("index: water temp fetch threw for station " + stationId + ": " + err.message);
          reading = null;
        }
        // A null fetch or parse (winter gap, all-"MM", stale, 404) records
        // nothing, so every beach's old "watertemp:" key expires on its own.
        if (reading === null) {
          continue;
        }
        liveStationCount = liveStationCount + 1;
        for (const member of members) {
          waterTempByBeach.set(member.beachId, {
            beachId: member.beachId,
            tempF: reading.tempF,
            tempC: reading.tempC,
            station: {
              id: member.station.id,
              name: member.station.name,
              distanceKm: member.station.distanceKm
            },
            observedIso: reading.observedIso,
            updated: nowIso
          });
        }
      }
    } catch (err) {
      console.log("index: water temp pass threw: " + err.message);
    }

    // Write pass, isolated failures, at KV_WRITE_CONCURRENCY. The pool yields at
    // writeDeadline instead of being killed, and the cursor flushes incrementally
    // as it goes.
    const stamper = makeWaveCursorStamper(env, nowIso, WAVE_CURSOR_FLUSH_SIZE);
    const writeReached = await runPool(beaches, KV_WRITE_CONCURRENCY, async function (beach) {
      // The gather never attempted this beach, so the run has no opinion about
      // it: no write and no stamp, or the cursor would advance past work that
      // never happened.
      if (unattempted.has(beach.id)) {
        return;
      }
      try {
        const waterTemp = waterTempByBeach.get(beach.id);
        if (waterTemp) {
          await env.FLAGS.put(
            "watertemp:" + beach.id,
            JSON.stringify(waterTemp),
            { expirationTtl: WAVE_DATA_TTL_SECONDS }
          );
          waterTempCount = waterTempCount + 1;
        }
      } catch (err) {
        // Stamping a beach whose write threw would send a beach with no data to
        // the back of the rotation on the strength of a failure. Unstamped sorts
        // first next run, which is the honest outcome.
        writeFailureCount = writeFailureCount + 1;
        console.log("index: water temp write failed for beach " + beach.id + ": " + err.message);
        return;
      }
      // Stamped for every beach the run reached, including ones with no station
      // in range and ones whose station published nothing: they write nothing on
      // every run, and stamping only on a successful write would pin them to the
      // head of the queue forever.
      stampedCount = stampedCount + 1;
      await stamper.add(beach.id);
    }, writeDeadline);
    await stamper.drain();

    // The completion log is the operator trip-wire and reports the two failure
    // shapes separately: truncated= means the run ran out of clock, so coverage
    // depends on the rotation cursor, while failures= near beaches= with
    // stamped=0 is a systemic KV write outage. stations= and live= report the
    // upstream side: live=0 with stations= intact is NDBC gone dark, not a
    // Worker fault.
    const truncated = writeReached < beaches.length || unattempted.size > 0;
    console.log(
      "index: water temp refresh complete, beaches=" + String(beaches.length) +
      " stamped=" + String(stampedCount) +
      " reached=" + String(writeReached) +
      " unattempted=" + String(unattempted.size) +
      " failures=" + String(writeFailureCount) +
      " watertemp=" + String(waterTempCount) +
      " truncated=" + (truncated ? "yes" : "no") +
      " stations=" + String(stationCount) +
      " live=" + String(liveStationCount) +
      " elapsedMs=" + String(Date.now() - startedMs)
    );
  } catch (err) {
    console.log("index: water temp refresh failed: " + err.message);
  }
}

export function sleep(ms) {
  // A non-positive delay resolves immediately rather than arming a timer.
  if (!(ms > 0)) {
    return Promise.resolve();
  }
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Increment a beach's attempts counter (enrichment_attempts for NWS,
// eccc_attempts for ECCC) so permanently-failing points park out of their queue.
// Both authorities pass their own UPDATE, kept as whole literals at the call
// sites so each statement stays greppable. A D1 write failure here is logged and
// swallowed so it never aborts the enrichment loop.
async function bumpAttempts(env, beachId, sql, label) {
  try {
    await env.DB.prepare(sql).bind(beachId).run();
  } catch (updateErr) {
    console.log("index: " + label + " enrichment attempt bump failed for " + beachId + ": " + updateErr.message);
  }
}

const NWS_ATTEMPTS_BUMP_SQL = "UPDATE beaches SET enrichment_attempts = enrichment_attempts + 1 WHERE id = ?1";
// A /points 404 is api.weather.gov saying the point is outside its domain, which
// never changes between runs, so the row parks on the first touch and reaches
// the ECCC cron that night instead of after five wasted requests.
const NWS_ATTEMPTS_PARK_SQL = "UPDATE beaches SET enrichment_attempts = " +
  String(NWS_ENRICHMENT_MAX_ATTEMPTS) + " WHERE id = ?1";
const ECCC_ATTEMPTS_BUMP_SQL = "UPDATE beaches SET eccc_attempts = eccc_attempts + 1 WHERE id = ?1";

// NWS point enrichment (own cron, 4x daily): beaches with nws_zone NULL get
// their forecast zone and gridpoint URL from api.weather.gov/points. A beach
// without nws_zone skips rules steps 1-2 (alerts, SRF rip risk) and carries an
// explicit "weather alerts are not checked here yet" caveat, so draining this
// queue fast is a safety property, not just throughput. Ordering is fewest failed
// attempts first, then last_viewed, then RANDOM(): ordering by id instead drains
// every osm-node-* row before any osm-way-* row, leaving way-based beaches blind
// to active alerts for weeks (TODO.md).
async function runNwsEnrichment(env) {
  let enriched = 0;
  let enrichmentFailures = 0;
  let marineRecovered = 0;
  let marineUnrecovered = 0;
  let deferred = 0;
  let attempted = 0;
  let notFound = 0;
  const spacingMs = env && typeof env.ENRICHMENT_REQUEST_SPACING_MS === "number"
    ? env.ENRICHMENT_REQUEST_SPACING_MS : ENRICHMENT_REQUEST_SPACING_MS;
  const deadlineMs = env && typeof env.NWS_ENRICHMENT_DEADLINE_MS === "number"
    ? env.NWS_ENRICHMENT_DEADLINE_MS : NWS_ENRICHMENT_DEADLINE_MS;
  const deadline = makeDeadline(Date.now(), deadlineMs);

  try {
    const needsEnrichment = await env.DB.prepare(
      "SELECT id, lat, lon FROM beaches WHERE nws_zone IS NULL AND enrichment_attempts < " +
      String(NWS_ENRICHMENT_MAX_ATTEMPTS) + " AND " + FLAG_WORTHY_WATER_SQL +
      " ORDER BY enrichment_attempts ASC, last_viewed DESC NULLS LAST, RANDOM() LIMIT " +
      String(NWS_ENRICHMENT_LIMIT)
    ).all();
    const toEnrich = needsEnrichment.results || [];
    let firstRequest = true;
    for (const beach of toEnrich) {
      if (deadline.expired()) {
        deferred = toEnrich.length - attempted;
        break;
      }
      if (!firstRequest) {
        await sleep(spacingMs);
      }
      firstRequest = false;
      attempted = attempted + 1;
      try {
        const lookup = await fetchPointMetadataDetailed(beach.lat, beach.lon);
        if (lookup.notFound) {
          notFound = notFound + 1;
          enrichmentFailures = enrichmentFailures + 1;
          await bumpAttempts(env, beach.id, NWS_ATTEMPTS_PARK_SQL, "nws");
          continue;
        }
        let meta = lookup.meta;
        if (meta !== null && isMarineZoneId(meta.nwsZone)) {
          // A centroid over water resolves to the marine zone, which no land
          // product is issued for. Re-probe nudged coordinates for the land zone
          // and take the first land hit, grid URL included; the marine id is
          // never stored, so an unrecoverable point parks like any other failure.
          const probes = landProbePoints(beach.lat, beach.lon);
          let landMeta = null;
          let probesUsed = 0;
          let interrupted = false;
          for (const probe of probes) {
            if (deadline.expired()) {
              interrupted = true;
              break;
            }
            await sleep(spacingMs);
            probesUsed = probesUsed + 1;
            const probeMeta = await fetchPointMetadata(probe.lat, probe.lon);
            if (probeMeta !== null && !isMarineZoneId(probeMeta.nwsZone)) {
              landMeta = probeMeta;
              break;
            }
          }
          if (interrupted && landMeta === null) {
            // Out of time mid-probe: leave the row untouched so it re-selects
            // with its attempts intact, rather than parking it for lack of time.
            attempted = attempted - 1;
            deferred = toEnrich.length - attempted;
            break;
          }
          console.log(
            "index: nws enrichment marine zone " + meta.nwsZone + " for " + beach.id +
            (landMeta ? " recovered " + landMeta.nwsZone : " unrecovered") +
            " after " + String(probesUsed) + " probes"
          );
          if (landMeta) {
            marineRecovered = marineRecovered + 1;
          } else {
            marineUnrecovered = marineUnrecovered + 1;
          }
          meta = landMeta;
        }
        if (meta !== null) {
          await env.DB.prepare(
            "UPDATE beaches SET nws_zone = ?1, nws_grid_url = ?2 WHERE id = ?3"
          ).bind(meta.nwsZone, meta.nwsGridUrl, beach.id).run();
          enriched = enriched + 1;
        } else {
          // fetchPointMetadata returns null on any failure rather than throwing,
          // so count that as an attempt and permanent failures stop being
          // requeued.
          enrichmentFailures = enrichmentFailures + 1;
          await bumpAttempts(env, beach.id, NWS_ATTEMPTS_BUMP_SQL, "nws");
        }
      } catch (err) {
        enrichmentFailures = enrichmentFailures + 1;
        console.log("index: nws enrichment failed for " + beach.id + ": " + err.message);
        await bumpAttempts(env, beach.id, NWS_ATTEMPTS_BUMP_SQL, "nws");
      }
    }

    const parkedResult = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM beaches WHERE nws_zone IS NULL AND enrichment_attempts >= " +
      String(NWS_ENRICHMENT_MAX_ATTEMPTS)
    ).first();
    const parkedCount = parkedResult ? parkedResult.n : 0;

    console.log(
      "index: nws enrichment complete, selected=" + String(toEnrich.length) +
      " attempted=" + String(attempted) +
      " enriched=" + String(enriched) +
      " failures=" + String(enrichmentFailures) +
      " marineRecovered=" + String(marineRecovered) +
      " marineUnrecovered=" + String(marineUnrecovered) +
      " notFound=" + String(notFound) +
      " deferred=" + String(deferred) +
      " elapsedMs=" + String(deadline.elapsedMs()) +
      " parked=" + String(parkedCount)
    );
  } catch (err) {
    console.log("index: nws enrichment failed: " + err.message);
  }
}

// ECCC zone enrichment (own cron, 4x daily, offset from the NWS trigger so the
// two enrichment upstreams never share a failure window): beaches NWS enrichment
// permanently parked get their ECCC public forecast region name from the GeoMet
// public-standard-forecast-zones collection. A row with eccc_zone set is treated
// as Canadian by the hourly recompute: it joins the single weather-alerts fetch
// and loses the alerts-unavailable caveat. Points no Canadian region contains
// park at ECCC_ENRICHMENT_MAX_ATTEMPTS exactly like the NWS side.
async function runEcccEnrichment(env) {
  let enriched = 0;
  let enrichmentFailures = 0;

  try {
    const needsEnrichment = await env.DB.prepare(
      "SELECT id, lat, lon FROM beaches WHERE nws_zone IS NULL AND enrichment_attempts >= " +
      String(NWS_ENRICHMENT_MAX_ATTEMPTS) + " AND eccc_zone IS NULL AND eccc_attempts < " +
      String(ECCC_ENRICHMENT_MAX_ATTEMPTS) + " AND " + FLAG_WORTHY_WATER_SQL +
      " ORDER BY eccc_attempts ASC, last_viewed DESC NULLS LAST, RANDOM() LIMIT " +
      String(ECCC_ENRICHMENT_LIMIT)
    ).all();
    const toEnrich = needsEnrichment.results || [];
    // One bulk fetch of the whole forecast-region polygon set per run, then
    // resolve every pending beach locally by point-in-polygon — the same
    // one-fetch shape as the alerts path. A failed or under-delivered fetch
    // (below ECCC_ZONES_SANITY_MIN parsed zones) parks the run: every beach
    // skipped, no attempt bumped, no throw, so a transient GeoMet outage or a
    // degraded partial response never burns resolvable rows' attempts budget.
    // The floor is env-tunable so tests can use a tiny fixture zone set.
    const zonesSanityMin = typeof env.ECCC_ZONES_SANITY_MIN === "number"
      ? env.ECCC_ZONES_SANITY_MIN
      : ECCC_ZONES_SANITY_MIN;
    let zones = null;
    if (toEnrich.length > 0) {
      const fetched = await fetchEcccForecastZones();
      if (fetched === null) {
        console.log("index: eccc enrichment parked run — forecast-zones fetch failed");
      } else if (fetched.length < zonesSanityMin) {
        console.log(
          "index: eccc enrichment parked run — forecast-zones fetch under-delivered (" +
          String(fetched.length) + " zones, expected ~419)"
        );
      } else {
        zones = fetched;
      }
    }
    // zones stays null when there is nothing to enrich or the run is parked, so
    // the per-beach loop only runs on a good fetch.
    if (zones !== null) {
      for (const beach of toEnrich) {
        try {
          const zoneName = ecccZoneNameForPoint(zones, beach.lat, beach.lon);
          if (zoneName !== null) {
            await env.DB.prepare(
              "UPDATE beaches SET eccc_zone = ?1 WHERE id = ?2"
            ).bind(zoneName, beach.id).run();
            enriched = enriched + 1;
          } else {
            // No Canadian region contains the point or sits within the
            // nearest-edge leniency cap (ECCC_ZONE_MAX_EDGE_KM), so it is a US
            // point. Count an attempt so unresolvable rows eventually park.
            enrichmentFailures = enrichmentFailures + 1;
            await bumpAttempts(env, beach.id, ECCC_ATTEMPTS_BUMP_SQL, "eccc");
          }
        } catch (err) {
          enrichmentFailures = enrichmentFailures + 1;
          console.log("index: eccc enrichment failed for " + beach.id + ": " + err.message);
          await bumpAttempts(env, beach.id, ECCC_ATTEMPTS_BUMP_SQL, "eccc");
        }
      }
    }

    const parkedResult = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM beaches WHERE nws_zone IS NULL AND eccc_zone IS NULL " +
      "AND enrichment_attempts >= " + String(NWS_ENRICHMENT_MAX_ATTEMPTS) +
      " AND eccc_attempts >= " + String(ECCC_ENRICHMENT_MAX_ATTEMPTS)
    ).first();
    const parkedCount = parkedResult ? parkedResult.n : 0;

    console.log(
      "index: eccc enrichment complete, attempted=" + String(toEnrich.length) +
      " enriched=" + String(enriched) +
      " failures=" + String(enrichmentFailures) +
      " parked=" + String(parkedCount)
    );
  } catch (err) {
    console.log("index: eccc enrichment failed: " + err.message);
  }
}

// Webcam hydration (own cron, daily): for beaches never checked or last checked
// over 14 days ago, ask the Windy Webcams API for the nearest active cam and
// store its embed player URL. An API success with no cam is a confirmed answer
// (clear the webcam columns, stamp webcam_checked); a transport or API failure
// leaves the row untouched so it stays at the front of the queue. The player URL
// itself is only ever fetched by the browser on the detail page — the request
// path still reads only D1 and KV.
async function runWebcamSync(env) {
  const nowIso = new Date().toISOString();
  let webcamsChecked = 0;
  let webcamsFound = 0;
  let webcamFailures = 0;

  if (!env.WINDY_WEBCAM_API_TOKEN) {
    console.log("index: WINDY_WEBCAM_API_TOKEN not set, skipping webcam hydration");
    return;
  }
  try {
    const webcamCutoffIso = new Date(Date.parse(nowIso) - WEBCAM_RECHECK_MS).toISOString();
    const webcamDueResult = await env.DB.prepare(
      "SELECT id, lat, lon FROM beaches WHERE (webcam_checked IS NULL OR webcam_checked < ?1) " +
      "AND " + FLAG_WORTHY_WATER_SQL +
      " ORDER BY (webcam_checked IS NULL) DESC, last_viewed DESC NULLS LAST, webcam_checked ASC, id ASC LIMIT " + String(WEBCAM_ENRICHMENT_LIMIT)
    ).bind(webcamCutoffIso).all();
    const webcamDue = webcamDueResult.results || [];

    // Persist one beach's fetch result (the { webcam } | null shape both the
    // nearby and bbox paths produce). null is a transport or API failure: leave
    // the row untouched so it stays at the front of the queue. { webcam: null }
    // is a confirmed no-cam: clear and stamp. { webcam } stores the player.
    async function persistWebcamResult(beach, result) {
      if (result === null) {
        webcamFailures = webcamFailures + 1;
        return;
      }
      webcamsChecked = webcamsChecked + 1;
      if (result.webcam !== null) {
        webcamsFound = webcamsFound + 1;
        await env.DB.prepare(
          "UPDATE beaches SET webcam_id = ?1, webcam_title = ?2, webcam_player_url = ?3, " +
          "webcam_detail_url = ?4, webcam_checked = ?5 WHERE id = ?6"
        ).bind(
          result.webcam.webcamId,
          result.webcam.title,
          result.webcam.playerUrl,
          result.webcam.detailUrl === undefined ? null : result.webcam.detailUrl,
          nowIso,
          beach.id
        ).run();
      } else {
        await env.DB.prepare(
          "UPDATE beaches SET webcam_id = NULL, webcam_title = NULL, " +
          "webcam_player_url = NULL, webcam_detail_url = NULL, webcam_checked = ?1 WHERE id = ?2"
        ).bind(nowIso, beach.id).run();
      }
    }

    // One beach via the nearby query (lone-cell path and truncation fallback).
    async function syncBeachNearby(beach) {
      try {
        const result = await fetchNearestWebcam(beach.lat, beach.lon, env.WINDY_WEBCAM_API_TOKEN);
        await persistWebcamResult(beach, result);
      } catch (err) {
        webcamFailures = webcamFailures + 1;
        console.log("index: webcam hydration failed for " + beach.id + ": " + err.message);
      }
    }

    // Bucket due beaches onto a coarse grid; cells with >1 beach share a bbox.
    const buckets = {};
    for (const beach of webcamDue) {
      const key = String(Math.floor(beach.lat / WEBCAM_CLUSTER_SPAN_DEG)) + ":" +
        String(Math.floor(beach.lon / WEBCAM_CLUSTER_SPAN_DEG));
      if (!buckets[key]) {
        buckets[key] = [];
      }
      buckets[key].push(beach);
    }

    for (const key in buckets) {
      if (!Object.prototype.hasOwnProperty.call(buckets, key)) {
        continue;
      }
      const bucket = buckets[key];
      if (bucket.length === 1) {
        await syncBeachNearby(bucket[0]);
        continue;
      }
      // Shared bbox for the cell, grown so every beach's radius sits inside.
      let north = -Infinity;
      let south = Infinity;
      let east = -Infinity;
      let west = Infinity;
      for (const beach of bucket) {
        if (beach.lat > north) { north = beach.lat; }
        if (beach.lat < south) { south = beach.lat; }
        if (beach.lon > east) { east = beach.lon; }
        if (beach.lon < west) { west = beach.lon; }
      }
      let bboxJson = null;
      try {
        bboxJson = await fetchWebcamsInBbox(
          north + WEBCAM_BBOX_MARGIN_DEG,
          east + WEBCAM_BBOX_MARGIN_DEG,
          south - WEBCAM_BBOX_MARGIN_DEG,
          west - WEBCAM_BBOX_MARGIN_DEG,
          env.WINDY_WEBCAM_API_TOKEN
        );
      } catch (err) {
        bboxJson = null;
        console.log("index: webcam bbox fetch threw for bucket " + key + ": " + err.message);
      }
      const truncated = bboxJson !== null && Array.isArray(bboxJson.webcams) &&
        bboxJson.webcams.length >= WEBCAM_FETCH_LIMIT;
      if (bboxJson === null) {
        // Bbox fetch failed: every beach in the bucket is a failure, left
        // untouched to retry next run, with no request amplification.
        webcamFailures = webcamFailures + bucket.length;
        continue;
      }
      if (truncated) {
        // The result hit the cam cap and may be incomplete, so a bbox-wide
        // "nearest" could be wrong. Fall back to a per-beach nearby query, which
        // the API bounds to the radius server-side.
        console.log("index: webcam bbox bucket " + key + " hit the cam cap, using nearby per beach");
        for (const beach of bucket) {
          await syncBeachNearby(beach);
        }
        continue;
      }
      for (const beach of bucket) {
        try {
          const webcam = parseNearestActiveWebcam(bboxJson, beach.lat, beach.lon);
          await persistWebcamResult(beach, { webcam: webcam });
        } catch (err) {
          webcamFailures = webcamFailures + 1;
          console.log("index: webcam hydration failed for " + beach.id + ": " + err.message);
        }
      }
    }
    console.log(
      "index: webcam sync complete, due=" + String(webcamDue.length) +
      " webcams_checked=" + String(webcamsChecked) +
      " webcams_found=" + String(webcamsFound) +
      " webcam_failures=" + String(webcamFailures)
    );
  } catch (err) {
    console.log("index: webcam sync failed: " + err.message);
  }
}

// Cron dispatch table, paired with the scheduled triggers in wrangler.toml. Each
// entry carries a runner and the label used in the top-level throw log; the
// unknown-cron fallback below is the single place an unrecognized trigger is
// logged.
const CRON_JOBS = {
  "7 * * * *": { run: runFlagRecompute, label: "flag recompute" },
  "3-53/10 * * * *": { run: runAlertRefresh, label: "alert refresh" },
  "15 */6 * * *": { run: runWaterTempRefresh, label: "water temp refresh" },
  "17 3,9,15,21 * * *": { run: runNwsEnrichment, label: "nws enrichment" },
  "29 4,10,16,22 * * *": { run: runEcccEnrichment, label: "eccc enrichment" },
  "31 9 * * *": { run: runWebcamSync, label: "webcam sync" }
};

export default {
  fetch: async function (request, env, ctx) {
    // Request-path error boundary: an unhandled throw would otherwise surface
    // Cloudflare's generic error page instead of the project's own. Renders a 500
    // in the same shape as the route's success case — a JSON body for /api/
    // routes, renderErrorPage HTML otherwise — always no-store so a transient
    // error is never cached.
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      console.log("index: request handler threw: " + err.message);
      const path = new URL(request.url).pathname;
      if (path.indexOf("/api/") === 0) {
        return Response.json(
          { error: "internal error" },
          { status: 500, headers: { "cache-control": "no-store" } }
        );
      }
      const html = renderErrorPage({ status: 500, message: "Something went wrong." });
      return new Response(html, {
        status: 500,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    }
  },
  scheduled: function (controller, env, ctx) {
    const job = CRON_JOBS[controller.cron];
    if (job) {
      ctx.waitUntil(
        job.run(env).catch(function (err) {
          console.log("index: scheduled " + job.label + " threw: " + err.message);
        })
      );
    } else {
      console.log("index: scheduled invoked with unknown cron: " + controller.cron);
    }
  }
};
