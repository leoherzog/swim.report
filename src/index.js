import { handleRequest } from "./router.js";
import { renderErrorPage } from "./frontend/render.js";
import { estimateFlag } from "./rules.js";
import {
  fetchAllActiveAlerts,
  nwsAlertsForZone,
  alertsUrlForZone,
  wfoFromGridUrl,
  fetchLatestSrfText,
  fetchPointMetadata
} from "./clients/nws.js";
import {
  fetchActiveEcccAlerts,
  ecccAlertsForPoint,
  fetchEcccForecastZones,
  ecccZoneNameForPoint,
  ECCC_ALERTS_INFO_URL
} from "./clients/eccc.js";
import {
  fetchActiveEcccMarineAlerts,
  ecccMarineAlertsForPoint,
  ECCC_MARINE_INFO_URL
} from "./clients/ecccMarine.js";
import { parseRipCurrentRisk } from "./clients/srfParser.js";
import { fetchWaveHeightsFt, fetchWinds } from "./clients/openMeteo.js";
import {
  fetchGlcfsWaveHeightsFt,
  serializeWaveCatalogs,
  deserializeWaveCatalogs,
  GLCFS_WAVE_MODEL,
  SEAGULL_INFO_URL
} from "./clients/glerl.js";
import { FLAG_WORTHY_WATER_SQL } from "./waterClass.js";
import {
  fetchNearestWebcam,
  fetchWebcamsInBbox,
  parseNearestActiveWebcam,
  WEBCAM_FETCH_LIMIT
} from "./clients/windyWebcams.js";
import { findScraper, scrapeOfficialFlagFromResult } from "./officialSources/index.js";
import { findWqFloorSource, scrapeWqFloorFromResult } from "./wqFloor/index.js";
import { waveSources, resolveSupplementalWaveFt } from "./waveSources/index.js";
import { nearestStation, stationWaterTemp } from "./waveSources/ndbcBuoys.js";
import { updateScraperHealth } from "./scraperHealth.js";
import { HOT_VIEW_WINDOW_MS } from "./demandWindow.js";
import { makeDeadline, runPool } from "./pool.js";

// Must cover the whole beaches table in ONE run: the recompute rotation
// (ORDER BY the caller's rotation cursor) combined with the 2 h KV TTL means
// any beach not reached every other run shows "no data" until its next turn.
// Raised 1000 -> 1200 because the flag-worthy table had already grown to 1001
// rows: at LIMIT 1000 the SELECT silently EXCLUDED a row every run (not
// truncated by a timeout — never selected at all), and offline discovery adds
// rows daily, so that dead zone grew invisibly. 1200 clears today's count with
// headroom. Bounded above by Open-Meteo's free-tier DAILY weighted ceiling, not
// by wall clock: a fully wave-null winter run costs ~1200 wave + ~1200 wind
// weighted calls, x4 runs = ~9,600 of 10,000/day (and that counter is a known
// over-count — see the weighted-call note below). Real pagination is still
// required for nationwide scale-out (TODO.md).
const MAX_BEACHES_PER_RUN = 1200;
// HOT_VIEW_WINDOW_MS (the 7-day hot/cold demand window consumed by
// runFlagRecompute/runWaveRefresh) is imported from ./demandWindow.js above and
// deliberately NOT re-exported: workerd rejects any non-function named export
// on the entry module and fails the Worker at startup. See demandWindow.js.
// Open-Meteo's keyless API applies a per-minute WEIGHTED rate limit (cost scales
// with locations x variables x models x days) plus per-hour/day caps, and it
// throttles per source IP — which for a Cloudflare Worker is a shared egress
// pool. Firing every batch of a ~700 beach run at once (the old
// Promise.allSettled fan-out) burst past the per-minute ceiling: the first
// batches succeeded and the rest got HTTP 429, so every remaining beach fell
// back to the buoy (a single now-reading, no hourly series) and the detail-page
// strip went blank. Two fixes, together: (1) wave/wind fetching moved OUT of the
// hourly estimate into a dedicated 6-hourly cron (runWaveRefresh) — the marine
// models only publish every 6-12 h, so hourly refetching was 6-12x wasted quota;
// (2) that cron paces its batches (small concurrency window, a gap between
// waves, one backoff retry on a throttled batch) to stay under the per-minute
// limit. Sleeps burn no CPU, so the paced run stays well inside the scheduled
// invocation's time budget.
//
// The per-minute limit is NOT the binding constraint at scale — the free tier's
// per-DAY ceiling is. Open-Meteo weights a multi-location request by the number
// of locations (a 100-coordinate batch costs ~100 weighted calls, per the
// maintainer), so HTTP-level batching saves connections but NOT daily quota:
// the ceiling is 10,000 weighted calls/day. Today a full run stays well under it
// (each location's marine request is 1 variable over 2 days -> fractional
// per-location weight, and the wind fallback only fires for wave-null beaches),
// but once nationwide pagination lands (removing the MAX_BEACHES_PER_RUN cap) the daily
// ceiling binds first — well before the Workers subrequest limit. runWaveRefresh
// logs a per-run weighted-call estimate (locations + retries) against that
// 10,000/day ceiling so the constraint is visible before pagination ships; no
// behavioral throttling on the daily budget yet (TODO.md).
const OPEN_METEO_DAILY_WEIGHTED_CEILING = 10000;
const OPEN_METEO_BATCH = 100;
// The per-minute rate the pacing actually produces is
//   OPEN_METEO_BATCH x concurrency x 60000 / (gap + fetch)
// against Open-Meteo's documented 600 calls/min free-tier ceiling. At the old
// concurrency of 2 that was 200 locations per ~14 s = ~857/min = 143% of the
// ceiling — a marginal sustained overshoot, which is the most plausible cause of
// the exactly-two-HTTP-429s-per-run signature the wave cron logged (each 429
// costs a 60 s backoff out of a 900 s invocation budget). At 1 it is 100
// locations per ~15 s = ~400/min = 67% of the ceiling. Do NOT "optimize" the gap
// away without redoing that arithmetic: total gap time is roughly invariant under
// the concurrency/gap trade anyway (gaps = ceil(nBatches / concurrency) - 1), so
// dropping the concurrency cost this run ~0 s of extra wall clock. Leaving the
// backoff at 60 s is deliberate — the post-429 wait is the one number that must
// not shrink.
const OPEN_METEO_CONCURRENCY = 1;
const OPEN_METEO_BATCH_GAP_MS = 12000;
const OPEN_METEO_RETRY_MS = 60000;
const KV_TTL_SECONDS = 7200;
// Wave inputs and the WaveSeries strip data are refreshed on the 6-hourly wave
// cron, so their KV must outlive the gap between runs (plus slack for a failed
// run): a 7 h TTL guarantees a beach's last-good wave data is still readable at
// the next refresh, so a transient upstream 429 leaves the strip showing
// slightly older — but still model-current — data instead of blanking it.
const WAVE_DATA_TTL_SECONDS = 25200;
// Requested width for every fan-out KV write in the cron path (both crons).
// Cloudflare caps an invocation at SIX SIMULTANEOUS OPEN CONNECTIONS and KV
// get/put count toward that cap, so a requested width of 12 yields ~6 in flight
// with the remainder queued by the platform — 12 is a deliberate modest
// oversubscription that keeps the pipe saturated across the long tail of put
// latencies, NOT a claim of 12x throughput. Every wall-clock estimate for these
// write passes is computed at 6 (~13.3 puts/s at the ~0.45 s/put observed in
// production), never at 12. Raising this number does not buy more throughput;
// the platform simply queues the excess.
const KV_WRITE_CONCURRENCY = 12;
// Wall-clock budgets for runWaveRefresh, measured from the top of the
// invocation. The scheduled ceiling is 900 s and the run that motivated these
// was SIGKILLed at 899.989 s mid-write-loop, with no cursor, no partial-progress
// record and no completion log — the whole invocation's work was lost and the
// failure was invisible in the logs.
//
// WAVE_GATHER_DEADLINE_MS: no NEW upstream work starts after T+480 s. Checked at
// the batchByBeach wave boundary, the step-2b beach boundary and the step-3b
// station boundary — BETWEEN units of work, never inside one, so the transport
// timeouts in the clients (not this deadline) are what bound a single hung
// request.
// WAVE_SUPPLEMENTAL_BUDGET_MS: step 2b's own sub-budget. In a fully wave-null
// winter run step 2b wants ~660 SEQUENTIAL fetches (~500 s); without a
// sub-budget it would eat the entire gather deadline and starve the step-3 wind
// pass, which is the last input that keeps those beaches out of "unknown".
// WAVE_WRITE_DEADLINE_MS: the write pool YIELDS here instead of being killed at
// 900 s. Beaches it never reached are neither written nor stamped, so they sort
// first next run — a truncated run persists a prefix rather than losing
// everything.
const WAVE_GATHER_DEADLINE_MS = 480000;
const WAVE_SUPPLEMENTAL_BUDGET_MS = 120000;
const WAVE_WRITE_DEADLINE_MS = 840000;
// Ids per wave_updated D1 batch. The INCREMENTAL flush is the fix, not the
// column: the hourly cron's shape (one batch AFTER the loop) is exactly what
// failed — killed mid-loop, the post-loop batch never ran, the cursor never
// moved, and the same prefix of beaches was reprocessed every run forever.
const WAVE_CURSOR_FLUSH_SIZE = 100;
// Rotation cursor per cron. A column name cannot be a bind parameter, so the
// value is concatenated into the SQL as a literal — it MUST stay a lookup in
// this two-entry whitelist and must NEVER be caller-derived text.
//
// The two crons cannot share one cursor: runFlagRecompute rewrites
// recompute_updated to a single shared nowIso for the ENTIRE run's beach set
// every hour, which flattens the column to ~2 distinct values across the table.
// A cursor a different cron flattens hourly is not a cursor — the wave cron's
// cold-tier sort collapsed to id ASC permanently, so a fixed tail of the table
// starved forever. Each cron is now single-writer of its own column.
const ROTATION_COLUMNS = { flag: "recompute_updated", wave: "wave_updated" };
// The two GLOS Seagull catalogs (~5.5 MB combined) are semi-static reference
// data (buoy deployments change on week-plus timescales), so the wave cron
// caches the two SMALL derived structures parsed from them — the wave
// parameter-id Set and the wave-platform coordinate list — in KV for ~24 h
// instead of re-downloading both catalogs every 6-hourly run. Written and read
// by the wave cron ONLY (the request path never touches this key), so the
// two-path rule is untouched. A cache miss/corrupt/stale value degrades to a
// fresh fetch, never an error.
const GLCFS_CATALOG_KV_KEY = "glcfs:catalogs";
const GLCFS_CATALOG_TTL_SECONDS = 86400;
// Per RUN of the dedicated enrichment cron (4x daily = up to 300 points/day).
// api.weather.gov publishes no numeric rate limit (it 429s with Retry-After
// when unhappy); 75 sequential polite requests per run is well within
// reasonable use and drains a freshly discovered region in days, not weeks.
const NWS_ENRICHMENT_LIMIT = 75;
// Rows that fail fetchPointMetadata this many times are permanently parked and
// no longer queued for enrichment — otherwise non-US points (Ontario shoreline
// swept in by the Great Lakes region set, src/regions.js) that api.weather.gov
// 404s forever would occupy the whole nightly batch and starve US beaches
// (TODO.md).
const NWS_ENRICHMENT_MAX_ATTEMPTS = 5;
// ECCC zone enrichment (own cron, 4x daily): only rows NWS permanently parked
// (nws_zone NULL at the attempts cap) are candidates — the Ontario-shoreline
// sweep is ~50 rows, so one run drains the whole backlog. Its own attempts
// cap parks points no ECCC region ever matches (mid-lake centroids) the same
// way the NWS cap parks non-US points.
const ECCC_ENRICHMENT_LIMIT = 50;
const ECCC_ENRICHMENT_MAX_ATTEMPTS = 5;
// Sanity floor for the bulk forecast-zones fetch: the collection holds ~419
// features nationwide, so a 200 that parses to far fewer (a degraded/partial
// GeoMet response, or a schema change stripping every feature in the client's
// NAME+geometry filter) is treated exactly like a fetch failure — the run is
// PARKED with no attempt bumps. Without this, one under-delivered response
// would bump up to ECCC_ENRICHMENT_LIMIT beaches at once toward the permanent
// attempts cap (an amplification the old per-point lookup never had).
const ECCC_ZONES_SANITY_MIN = 100;
// Fixed pause BETWEEN the sequential api.weather.gov / GeoMet requests the
// enrichment loops make (F5). The Worker egresses from a shared IP pool, which
// api.weather.gov treats like a proxy ("Proxies are more likely to reach the
// limit"), so firing up to 75 back-to-back /points requests risks a 429 the
// whole run inherits. A short sleep between requests burns no CPU and adds no
// subrequests; it only spaces the burst out. Applied between iterations only
// (never before the first request or after the last).
const ENRICHMENT_REQUEST_SPACING_MS = 300;
// Webcam hydration (daily webcam cron): nearest Windy webcam player per
// beach. Webcams appear and disappear slowly, so rows are rechecked on a
// 14-day cadence; 100 lookups per night drains the pilot backlog in a few
// nights and keeps the recheck cycle comfortably ahead of the beach count.
// Deliberately NOT raised alongside the NWS limit — Windy's free tier
// publishes no quota and 100/night is polite guesswork (TODO.md).
const WEBCAM_ENRICHMENT_LIMIT = 100;
const WEBCAM_RECHECK_MS = 14 * 86400000;
// Webcam clustering (F14): due beaches are bucketed onto a coarse lat/lon grid
// so a cell holding more than one beach shares a SINGLE bbox /webcams request
// instead of one nearby query each; a lone beach in a cell keeps the cheaper
// nearby query. The grid span is far under Windy's zoom-tiered bbox size cap
// (22.5 deg lat / 45 deg lon at the tightest zoom), so span is never the
// binding limit — the 50-cam-per-call cap is, which the caller guards by
// falling back to per-beach nearby queries when a bucket's result comes back
// full (possibly truncated). The bbox is grown by WEBCAM_BBOX_MARGIN_DEG on
// every side so each beach's full WEBCAM_RADIUS_KM neighborhood sits inside it.
const WEBCAM_CLUSTER_SPAN_DEG = 0.2;
const WEBCAM_BBOX_MARGIN_DEG = 0.07;

// Human-readable labels for estimate sources ({ label, url } entries — see
// PLAN.md section 1). Wave labels name the model that actually supplied the
// reading. Labels render as plain text on the flag cards (no hyperlinks); the
// url is kept in the payload for provenance and is a page a visitor could
// read, never the raw API request.
const OPEN_METEO_MARINE_URL = "https://open-meteo.com/en/docs/marine-weather-api";
const OPEN_METEO_FORECAST_URL = "https://open-meteo.com/en/docs";
const WAVE_MODEL_LABELS = {
  "ecmwf_wam025": "ECMWF Wave Forecast",
  "ncep_gfswave025": "NOAA GFS Wave Forecast",
  "meteofrance_wave": "Météo-France Wave Forecast"
};
WAVE_MODEL_LABELS[GLCFS_WAVE_MODEL] = "GLOS Buoy Observations";

// Supplemental fallback wave sources (src/waveSources/) are the single source of
// truth for their own model label + provenance url. Registering them here (once,
// at module load) keeps the flag source badge and the detail strip labeling a
// supplemental reading correctly instead of the generic "Wave Forecast" /
// Open-Meteo fallback. The registry holds five sources today, so this loop
// registers five model labels + provenance urls at module load.
const SUPPLEMENTAL_WAVE_URLS = {};
for (let i = 0; i < waveSources.length; i++) {
  const s = waveSources[i];
  WAVE_MODEL_LABELS[s.model] = s.label;
  SUPPLEMENTAL_WAVE_URLS[s.model] = s.url;
}

function waveSourceLabel(model) {
  if (Object.prototype.hasOwnProperty.call(WAVE_MODEL_LABELS, model)) {
    return WAVE_MODEL_LABELS[model];
  }
  return "Wave Forecast";
}

// Buoy readings come from the GLOS Seagull network, so their source entry
// carries the human-readable Seagull portal url, not the Open-Meteo docs (and
// never the raw API request). Supplemental sources carry their own provenance
// url from the registry.
function waveSourceUrl(model) {
  if (model === GLCFS_WAVE_MODEL) {
    return SEAGULL_INFO_URL;
  }
  if (Object.prototype.hasOwnProperty.call(SUPPLEMENTAL_WAVE_URLS, model)) {
    return SUPPLEMENTAL_WAVE_URLS[model];
  }
  return OPEN_METEO_MARINE_URL;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i = i + size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// Pacing knobs for batchByBeach, read from env with a fallback to the module
// constants so a run can be tuned (or, in tests, zeroed to run instantly)
// without a code change. Numeric env overrides only. deadline is the wave
// cron's gather deadline (its only caller passes one); batchByBeach checks it at
// the wave boundary and stops starting new batches.
function batchTiming(env, deadline) {
  const gap = env && typeof env.OPEN_METEO_BATCH_GAP_MS === "number"
    ? env.OPEN_METEO_BATCH_GAP_MS : OPEN_METEO_BATCH_GAP_MS;
  const retry = env && typeof env.OPEN_METEO_RETRY_MS === "number"
    ? env.OPEN_METEO_RETRY_MS : OPEN_METEO_RETRY_MS;
  const concurrency = env && typeof env.OPEN_METEO_CONCURRENCY === "number"
    ? env.OPEN_METEO_CONCURRENCY : OPEN_METEO_CONCURRENCY;
  return {
    gapMs: gap,
    retryMs: retry,
    concurrency: Math.max(1, concurrency),
    deadline: deadline || null
  };
}

// Wall-clock budgets for runWaveRefresh, same numeric-env-override shape as
// batchTiming. The override is a plain NUMBER on env, deliberately not a
// callable clock: a function smuggled through the binding object would be a
// namespace hazard on a real Worker env, and a numeric budget is enough to make
// every deadline branch reachable in a test — makeDeadline's expired() uses >=,
// so a 0 override trips immediately even under the suite's frozen Date.
function runBudget(env) {
  const gather = env && typeof env.WAVE_GATHER_DEADLINE_MS === "number"
    ? env.WAVE_GATHER_DEADLINE_MS : WAVE_GATHER_DEADLINE_MS;
  const supplemental = env && typeof env.WAVE_SUPPLEMENTAL_BUDGET_MS === "number"
    ? env.WAVE_SUPPLEMENTAL_BUDGET_MS : WAVE_SUPPLEMENTAL_BUDGET_MS;
  const write = env && typeof env.WAVE_WRITE_DEADLINE_MS === "number"
    ? env.WAVE_WRITE_DEADLINE_MS : WAVE_WRITE_DEADLINE_MS;
  return {
    gatherDeadlineMs: gather,
    supplementalBudgetMs: supplemental,
    writeDeadlineMs: write
  };
}

// Fetch one batch, retrying once after a backoff when the first attempt returns
// null. The clients collapse a 429 / 5xx / network error to null (their
// data-or-null contract), so a null here is exactly the transient-throttle case
// the backoff is meant to ride out. A second null gives up (onBatchFail).
// onAttempt(batch.length) fires once per actual upstream fetch (the first try and
// the retry, if one happens) so the caller can tally Open-Meteo's weighted,
// location-multiplied call cost against the free-tier daily ceiling (U1). A
// 100-coordinate batch costs ~100 weighted calls, and the one backoff retry
// doubles that batch's cost, so counting per-attempt batch.length is the exact
// weighted estimate.
async function fetchBatchWithRetry(batch, fetchFn, retryMs, onAttempt) {
  onAttempt(batch.length);
  const first = await fetchFn(batch);
  if (first !== null) {
    return first;
  }
  await sleep(retryMs);
  onAttempt(batch.length);
  return fetchFn(batch);
}

// Shared batch scaffolding for the wave cron's Open-Meteo wave and wind passes:
// chunk the points, then fetch the chunks in small concurrency-limited waves
// with a gap between waves so the run never bursts past Open-Meteo's per-minute
// weighted rate limit (the burst that used to 429 most of the run and blank the
// strip). On a fulfilled non-null batch (possibly via its one retry),
// onEntry(point, entry) fires for each point with a result row; a still-null or
// rejected batch fires onBatchFail(batch) once. The wave-null sentinel handling
// and failure logging live in the callbacks, so this helper carries no
// upstream-specific behavior. Returns { weightedCalls, unattempted }:
// weightedCalls is the run's Open-Meteo weighted-call estimate (sum of
// batch.length over every attempt including retries) so the wave cron can log it
// against the free-tier daily ceiling (U1); unattempted is the list of points
// the gather deadline stopped this call from ever fetching.
//
// Deadline-skipped batches are deliberately NOT routed through onBatchFail: a
// failed batch is a beach the run TRIED and got nothing for (its last-good KV is
// preserved and its cursor still advances), whereas an unattempted beach is one
// the run never touched at all — it must be neither written nor stamped, so it
// sorts to the front of the queue next run. Collapsing the two would advance the
// cursor past work that never happened.
async function batchByBeach(points, fetchFn, onEntry, onBatchFail, timing) {
  const batches = chunk(points, OPEN_METEO_BATCH);
  let weightedCalls = 0;
  const unattempted = [];
  const onAttempt = function (n) { weightedCalls = weightedCalls + n; };
  for (let start = 0; start < batches.length; start = start + timing.concurrency) {
    // Checked BEFORE the gap sleep on purpose: a run that has already blown its
    // gather budget must not also burn a 12 s pacing sleep on its way out.
    if (timing.deadline && timing.deadline.expired()) {
      const remaining = batches.slice(start);
      for (const batch of remaining) {
        for (const point of batch) {
          unattempted.push(point);
        }
      }
      console.log(
        "index: batch pacing deadline reached, " + String(remaining.length) + " batches unattempted"
      );
      break;
    }
    if (start > 0) {
      await sleep(timing.gapMs);
    }
    const wave = batches.slice(start, start + timing.concurrency);
    const settled = await Promise.allSettled(
      wave.map(function (batch) { return fetchBatchWithRetry(batch, fetchFn, timing.retryMs, onAttempt); })
    );
    for (let k = 0; k < settled.length; k = k + 1) {
      const s = settled[k];
      const batch = wave[k];
      if (s.status === "fulfilled" && s.value !== null) {
        const data = s.value;
        for (const point of batch) {
          const entry = data.results[point.beachId];
          if (entry) {
            onEntry(point, entry);
          }
        }
      } else {
        onBatchFail(batch);
      }
    }
  }
  return { weightedCalls: weightedCalls, unattempted: unattempted };
}

// Beaches whose current wave height is still null (either no wave entry at all
// or an entry with waveHeightFt === null), mapped to fetch points. Called
// FRESH each time — the step-5b buoy gap-fill mutates waveResults between the
// step-5b and step-6 calls, so the result must never be cached.
function waveNullPoints(beaches, waveResults) {
  return beaches
    .filter(function (b) {
      const w = waveResults.get(b.id);
      return !w || w.waveHeightFt === null;
    })
    .map(function (b) {
      return { beachId: b.id, lat: b.lat, lon: b.lon };
    });
}

// The run queue shared by both beach-walking crons (hourly recompute, 6-hourly
// wave refresh): flag-worthy rows ordered hot-first (a last_viewed demand stamp
// inside the hot window) ahead of the oldest-cursor rotation, capped at
// MAX_BEACHES_PER_RUN. Only the column list, the caller's clock source and the
// ROTATION CURSOR COLUMN differ, so the WHERE, the hot-first guard, the id ASC
// tiebreak, the LIMIT and the single bind all live here once (precedent:
// buildHomeStatement in src/router.js). Returns the BOUND statement; the caller
// runs it.
//
// The hot-first demand term is preserved for BOTH callers: dropping it from the
// wave cron would let a beach in active demand lose its wave data to the
// rotation the moment the table outgrows one run, which is the exact contract
// PLAN.md section 7 makes. rotation selects the cursor column from the
// ROTATION_COLUMNS whitelist — a column name cannot be a bind parameter, so it
// is concatenated as a literal and the lookup is own-property-checked rather
// than trusting an arbitrary string to index the map.
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
// flushSize AS THE WRITE POOL REACHES THEM, not once after the loop: the hourly
// cron's post-loop-batch shape is precisely what failed in production — the
// invocation was SIGKILLed mid-loop, the single trailing D1 batch never ran, the
// cursor never advanced, and every subsequent run reprocessed the same prefix
// while the tail starved indefinitely. A truncated run must still persist the
// progress it made.
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
    // concurrently. The flushing guard keeps at most ONE D1 batch in flight —
    // splicing the whole pending array out in a single synchronous step means no
    // id can be flushed twice or dropped, and ids added while a flush is in
    // flight simply ride the next one.
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

// Hourly estimate recompute. Reads the freshest alerts / rip-current risk every
// hour (the fast-changing safety signals) but takes wave height and the wind
// fallback from KV that the 6-hourly wave cron (runWaveRefresh) wrote — the
// marine models only publish every 6-12 h, so refetching them hourly was wasted
// quota and the burst that got the whole run 429'd. No Open-Meteo fetch is
// reachable from here.
async function runFlagRecompute(env) {
  const nowIso = new Date().toISOString();
  let estimateCount = 0;
  let officialCount = 0;
  let failureCount = 0;

  // Calibration signal (migration 0006): capture per-beach estimate and
  // official readings THIS run, then log a flag_history row only where BOTH
  // exist. estimate map -> { color, rulesVersion }; official map -> { color,
  // source }. Estimate-only beaches are never logged, so the table records
  // estimated-vs-official pairs instead of growing with all ~613 beaches.
  const estimatesByBeach = new Map();
  const officialsByBeach = new Map();

  const hotCutoffIso = new Date(Date.now() - HOT_VIEW_WINDOW_MS).toISOString();

  try {
    const beachesResult = await selectRunBeaches(env, "*", hotCutoffIso, "flag").all();
    const beaches = beachesResult.results || [];

    // Step 3: alerts — ONE national fetch, matched to the run's distinct zone
    // ids locally (nwsAlertsForZone). Costs a single subrequest regardless of
    // zone count, so nationwide scale-out never multiplies alert calls. A failed
    // fetch maps every zone to null (per-beach alertsCheckable stays true,
    // mirroring the old per-zone failure mode). Each zone's entry keeps the
    // zone-scoped provenance URL for its beaches' source entries.
    //
    // Both a beach's land forecast zone (nws_zone, e.g. "MIZ056") and its
    // adjacent marine zone (marine_zone, e.g. "LMZ874") go through the SAME map:
    // marine warnings (Gale/Storm/Special Marine) and Small Craft Advisory are
    // zoned to the marine zone, not the land one, but they ride the same national
    // feed and the two id namespaces (MIZ.. vs LMZ..) can never collide.
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
    // enrichment cron; such rows always have nws_zone NULL). One national
    // fetch returns every active alert with its region polygon; per-beach
    // matching is a local point-in-polygon (ecccAlertsForPoint) in step 7, so
    // this costs a single subrequest regardless of beach count. Skipped when
    // the run has no Canadian rows. null = fetch failed (Canadian beaches
    // keep alertsCheckable true, mirroring a transient NWS alerts failure).
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
      // ECCC marine warnings (Gale/Storm/Strong-wind, per-zone polygons) come
      // from a SEPARATE GeoMet collection and add new signal for Canadian
      // beaches — verified disjoint from the land weather-alerts client. Own
      // try/catch so a marine-fetch failure never nulls the land alerts (and
      // vice versa); one national fetch, matched locally per beach in step 7.
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
    const srfMap = new Map();
    for (const wfo of wfos) {
      try {
        const srf = await fetchLatestSrfText(wfo);
        if (srf === null) {
          srfMap.set(wfo, null);
        } else {
          const risk = parseRipCurrentRisk(srf.text);
          srfMap.set(wfo, { risk: risk, sourceUrl: srf.sourceUrl, productId: srf.productId });
        }
      } catch (err) {
        console.log("index: srf fetch threw for wfo " + wfo + ": " + err.message);
        srfMap.set(wfo, null);
      }
    }

    // Step 5: wave inputs — READ ONLY, never fetched here. The 6-hourly wave
    // cron (runWaveRefresh) wrote a "waveinput:" + id payload
    // ({ waveHeightFt, model, windSpeedMph, windGustMph, updated }) per beach;
    // the estimate consumes the current wave height and the wind fallback from
    // it. A missing key (wave cron hasn't run yet, or its data has aged past the
    // 7 h TTL) simply yields no wave input — the estimate degrades to the wind
    // fallback or "unknown", never a wrong flag. Prefetch all keys concurrently
    // in chunks so the per-beach loop below stays synchronous.
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
        if (fetched[i]) {
          waveInputs.set(group[i].id, fetched[i]);
        }
      }
    }

    // Step 5b: water-quality floor gather. Mirrors the step-8 official-scraper
    // grouping: group beaches by their matching wqFloor source and fetch each
    // source ONCE per run (not per beach), so a table-wide advisory source
    // costs one fetch. The resolved advisory feeds estimateFlag's
    // waterQualityAdvisory input (rules.js step 7) as a RAISE-ONLY floor, so it
    // must be in hand BEFORE the per-beach estimate below — the step-8 official
    // gather is too late. The registry holds eight sources today, so a run
    // covering all of them issues up to eight scrape() calls (one each, never
    // per beach); a run whose beaches match none issues zero and every advisory
    // stays null.
    // wqSourceByBeach caches each beach's resolved source so the step-6 loop
    // reuses it instead of re-running findWqFloorSource per beach;
    // wqDistinctSources is the fetch list (one entry per matched source id).
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

    // Step 6: per-beach estimate, isolated failures. Bounded-concurrency rather
    // than sequential: at ~0.45 s per KV put a sequential walk of ~1000 beaches
    // was ~450 s of a 900 s invocation, which is what put this cron at 78-83% of
    // its ceiling. The body is UNCHANGED — nothing in it depends on the previous
    // iteration, and it contains no continue/break whose meaning a callback
    // conversion would silently invert. estimateCount / failureCount are
    // incremented with a single synchronous statement (no await between read and
    // write), so concurrent runners cannot lose a count.
    await runPool(beaches, KV_WRITE_CONCURRENCY, async function (beach) {
      try {
        const sources = [];

        let alerts = null;
        let alertDetails = null;
        const landEntry = beach.nws_zone ? alertsMap.get(beach.nws_zone) : null;
        const marineEntry = beach.marine_zone ? alertsMap.get(beach.marine_zone) : null;
        if (landEntry || marineEntry) {
          // US beach: land forecast-zone alerts plus adjacent marine-zone alerts
          // (Gale/Storm/Special Marine/Small Craft), both matched from the ONE
          // national NWS fetch. concat leaves alerts null only when BOTH entries
          // are absent — a failed fetch (null map entry) or an unenriched zone —
          // so a real failure keeps alertsCheckable true with no false caveat. No
          // dedup: alerts is read only via indexOf, and estimateFlag/the hazard
          // lane already tolerate repeated events.
          alerts = (landEntry ? landEntry.events : []).concat(marineEntry ? marineEntry.events : []);
          alertDetails = (landEntry ? landEntry.details : []).concat(marineEntry ? marineEntry.details : []);
          if (landEntry) {
            sources.push({ label: "NWS Alerts", url: landEntry.sourceUrl });
          }
          if (marineEntry) {
            sources.push({ label: "NWS Marine Alerts", url: marineEntry.sourceUrl });
          }
        } else if (beach.eccc_zone && (ecccAlerts !== null || ecccMarineAlerts !== null)) {
          // Canadian beach: match the run's single ECCC land fetch AND the
          // single marine fetch to this point via their region polygons, then
          // CONCAT into one alerts list (exactly like the US branch concats
          // marine warnings onto land). A successful fetch with zero containing
          // polygons is a real "no active alerts" ([]). The branch still
          // processes when only ONE of the two fetches succeeded (each defaults
          // to empty when null), so a land-alerts outage never hides an active
          // marine gale, and vice versa.
          const landMatched = ecccAlerts !== null
            ? ecccAlertsForPoint(ecccAlerts.alerts, beach.lat, beach.lon)
            : { events: [], details: [] };
          const marineMatched = ecccMarineAlerts !== null
            ? ecccMarineAlertsForPoint(ecccMarineAlerts.alerts, beach.lat, beach.lon)
            : { events: [], details: [] };
          alerts = landMatched.events.concat(marineMatched.events);
          alertDetails = landMatched.details.concat(marineMatched.details);
          if (ecccAlerts !== null) {
            sources.push({
              label: "Environment Canada Alerts",
              url: ECCC_ALERTS_INFO_URL
            });
          }
          if (ecccMarineAlerts !== null) {
            sources.push({
              label: "Environment Canada Marine Alerts",
              url: ECCC_MARINE_INFO_URL
            });
          }
        }

        let ripCurrentRisk = null;
        const wfo = wfoFromGridUrl(beach.nws_grid_url);
        if (wfo) {
          const srfEntry = srfMap.get(wfo);
          if (srfEntry) {
            ripCurrentRisk = srfEntry.risk;
            sources.push({
              label: "NWS Surf Zone Forecast",
              url: srfEntry.sourceUrl
            });
          }
        }

        // Wave height and the wind fallback both come from the wave cron's
        // stored input (or are absent when it has no fresh data for this beach).
        const waveInput = waveInputs.get(beach.id);

        let waveHeightFt = null;
        if (waveInput && typeof waveInput.waveHeightFt === "number") {
          waveHeightFt = waveInput.waveHeightFt;
          sources.push({
            label: waveSourceLabel(waveInput.model),
            url: waveSourceUrl(waveInput.model)
          });
        }

        // Wind is only a fallback for wave-null beaches (the wave cron only
        // records it for them), and only names its source when it is the signal
        // actually in play — i.e. no wave height was available.
        let windSpeedMph = waveInput && typeof waveInput.windSpeedMph === "number"
          ? waveInput.windSpeedMph : null;
        let windGustMph = waveInput && typeof waveInput.windGustMph === "number"
          ? waveInput.windGustMph : null;
        if (waveHeightFt === null && (windSpeedMph !== null || windGustMph !== null)) {
          sources.push({
            label: "Wind Forecast",
            url: OPEN_METEO_FORECAST_URL
          });
        }

        // Water-quality advisory floor: resolve this beach against its group's
        // already-fetched scrape result (step 5b). A RAISE-ONLY floor baked
        // INTO the estimate (never an official override) — a clean/absent
        // reading resolves to null and has zero effect (rules.js step 7). When
        // present, cite the WQ source on the estimate card so the reason's
        // "Water-quality advisory (...)" attribution is visible.
        let waterQualityAdvisory = null;
        const wqSourceForBeach = wqSourceByBeach.get(beach.id);
        if (wqSourceForBeach) {
          const wqResult = wqResultsBySource.get(wqSourceForBeach.id);
          if (wqResult) {
            waterQualityAdvisory = scrapeWqFloorFromResult(beach, wqSourceForBeach, wqResult);
          }
        }
        if (waterQualityAdvisory !== null) {
          sources.push({
            label: waterQualityAdvisory.source,
            url: typeof wqSourceForBeach.infoUrl === "string" ? wqSourceForBeach.infoUrl : ""
          });
        }

        // alertsCheckable distinguishes "alerts checked, none active"
        // (alerts === []) from "alerts not checkable" (neither nws_zone nor
        // eccc_zone resolved — beach not yet enriched for either authority).
        // When false, estimateFlag appends an explicit "Weather alerts not
        // yet available for this beach" caveat to the reason so a wave-only
        // green is never presentable as alert-verified. A transient
        // alerts-fetch failure for an enriched beach (either authority) stays
        // alertsCheckable: true (no caveat).
        const inputs = {
          beachId: beach.id,
          alerts: alerts,
          alertDetails: alertDetails,
          alertsCheckable: (beach.nws_zone || beach.eccc_zone || beach.marine_zone) ? true : false,
          ripCurrentRisk: ripCurrentRisk,
          waveHeightFt: waveHeightFt,
          windSpeedMph: windSpeedMph,
          windGustMph: windGustMph,
          waterQualityAdvisory: waterQualityAdvisory,
          sources: sources,
          updated: nowIso
        };

        const estimate = estimateFlag(inputs);
        await env.FLAGS.put(
          "flag:" + beach.id,
          JSON.stringify(estimate),
          { expirationTtl: KV_TTL_SECONDS }
        );

        // Persist the structured advisory for the request path (D1+KV only) to
        // render a distinct water-quality callout. Written ONLY when non-null;
        // a clean reading writes nothing, so the key expires naturally (exactly
        // like "official:"). NOT an official override — never feeds
        // markerFlagColor / titleColor.
        if (waterQualityAdvisory !== null) {
          await env.FLAGS.put(
            "wqfloor:" + beach.id,
            JSON.stringify(waterQualityAdvisory),
            { expirationTtl: KV_TTL_SECONDS }
          );
        }

        // The detail-page WaveSeries ("waves:" + id) is written by the wave
        // cron, not here — this loop only reads wave inputs.
        //
        // This set MUST stay AFTER the successful flag: put, inside the same
        // try: a failed write is caught, counted as a failure, and records no
        // estimate, so no flag_history row can ever claim an estimate that was
        // never published. Do not refactor this into a
        // collect-descriptors-then-flush shape — that silently inverts the
        // guarantee.
        estimatesByBeach.set(beach.id, {
          color: estimate.color,
          rulesVersion: estimate.rules_version
        });
        estimateCount = estimateCount + 1;
      } catch (err) {
        failureCount = failureCount + 1;
        console.log("index: flag estimate failed for beach " + beach.id + ": " + err.message);
      }
    });

    // Step 8: officials, one scrape call per distinct matched scraper, then
    // per-beach resolution of the shared result (contract v2). A beach that
    // resolves to no site gets NO KV write (its old key expires naturally).
    const scraperGroups = new Map();
    for (const beach of beaches) {
      const scraper = findScraper(beach);
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

        // Scraper health monitoring (hourly path only). Only scrapers that
        // actually had matched beaches this run reach here, so a scraper that
        // was never invoked is never counted as failing. The same intent
        // extends to DELIBERATE season/cadence pre-fetch skips: a scraper may
        // declare healthMonitored(nowIso), and when it returns false this
        // run's null is NOT counted (no streak bump, no reset) — otherwise an
        // off-season scraper would cross the alert threshold in a day, flood
        // an ALERT log every hour for months, and blind the monitor to real
        // in-season breakage. Costs one KV get + one KV put per MATCHED
        // scraper per run — at most a handful of extra subrequests against
        // the per-invocation budget (PLAN.md section 7). The "scraperhealth:"
        // key is written WITHOUT expirationTtl so the consecutive-null streak
        // persists across runs.
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
        // Only the INNER per-beach put loop is pooled. The OUTER
        // scraperGroups loop stays strictly sequential: it mutates shared
        // per-scraper "scraperhealth:" state (read-modify-write across a KV get
        // and put) and carries the continue above, neither of which survives a
        // callback conversion intact.
        await runPool(group.beaches, KV_WRITE_CONCURRENCY, async function (beach) {
          const flag = scrapeOfficialFlagFromResult(beach, group.scraper, result);
          if (flag !== null) {
            // A scraper may opt into a longer official-KV TTL (scraper.
            // officialTtlSeconds) when it fetches on a reduced cadence, so the
            // last color persists between its infrequent fetches; default 2h.
            const officialTtl =
              typeof group.scraper.officialTtlSeconds === "number"
                ? group.scraper.officialTtlSeconds
                : KV_TTL_SECONDS;
            await env.FLAGS.put(
              "official:" + beach.id,
              JSON.stringify(flag),
              { expirationTtl: officialTtl }
            );
            // Same ordering rule as the estimate above: recorded only AFTER the
            // put resolved, so flag_history never pairs against an official
            // color that was never published.
            officialsByBeach.set(beach.id, {
              color: flag.color,
              source: flag.scraperId || group.scraper.id
            });
            officialCount = officialCount + 1;
          }
        });
      } catch (err) {
        console.log("index: official scrape failed: " + err.message);
      }
    }

    // Step 9: calibration history (migration 0006). One row per beach that has
    // BOTH a fresh estimate AND a scraped official color this run — the paired
    // signal used to tune wave/wind thresholds in src/rules.js. Estimate-only
    // beaches are skipped so the table does not grow with all ~613 rows hourly.
    // Written in a single D1 batch to stay within the subrequest budget
    // (PLAN.md section 7); a failure here never poisons the run.
    let historyCount = 0;
    try {
      const historyStatements = [];
      for (const beach of beaches) {
        const estimateEntry = estimatesByBeach.get(beach.id);
        const officialEntry = officialsByBeach.get(beach.id);
        if (estimateEntry && officialEntry) {
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
    console.log(
      "index: flag recompute complete, beaches=" + String(beaches.length) +
      " estimates=" + String(estimateCount) +
      " officials=" + String(officialCount) +
      " history=" + String(historyCount) +
      " failures=" + String(failureCount) +
      " hot=" + String(hotCount)
    );
  } catch (err) {
    console.log("index: flag recompute failed: " + err.message);
  }
}

// The wave cron's per-beach KV write, lifted out of what used to be a sequential
// for-loop body so it can run inside a bounded-concurrency pool. Pure plumbing:
// the two graceful-degradation guards, both payload shapes and both
// { expirationTtl: WAVE_DATA_TTL_SECONDS } TTLs are unchanged — the old
// continue is now a return, which is the only behavioral difference and is
// exactly equivalent under the pool (the beach is skipped, its neighbours are
// not). Returns { input, series } as 0/1 counters so the caller can tally
// without sharing mutable state with this function.
async function writeWaveKvForBeach(env, beach, waveEntry, windEntry, wavesStartIso, nowIso) {
  const waveHeightFt = waveEntry ? waveEntry.waveHeightFt : null;
  const windSpeedMph = windEntry && typeof windEntry.windSpeedMph === "number"
    ? windEntry.windSpeedMph : null;
  const windGustMph = windEntry && typeof windEntry.windGustMph === "number"
    ? windEntry.windGustMph : null;

  // hoursFt === null is the batch-failure sentinel (vs. an array of nulls for a
  // fetched-but-masked cell). A failed marine fetch with no buoy reading has
  // nothing trustworthy to record — leave the old KV alone so it rides its TTL.
  const marineFetchFailed = !waveEntry || waveEntry.hoursFt === null;
  if (waveHeightFt === null && marineFetchFailed) {
    return { input: 0, series: 0 };
  }
  // Fetched cleanly but nothing usable (masked, no buoy, no wind) — also skip;
  // the old key expires on its own.
  if (waveHeightFt === null && windSpeedMph === null && windGustMph === null) {
    return { input: 0, series: 0 };
  }

  const waveInput = {
    beachId: beach.id,
    waveHeightFt: waveHeightFt,
    model: waveEntry ? waveEntry.model : null,
    windSpeedMph: windSpeedMph,
    windGustMph: windGustMph,
    updated: nowIso
  };
  await env.FLAGS.put(
    "waveinput:" + beach.id,
    JSON.stringify(waveInput),
    { expirationTtl: WAVE_DATA_TTL_SECONDS }
  );

  // WaveSeries for the detail-page 24 h strip: only when the entry carries a
  // real hourly series with at least one finite cell (a masked series or
  // buoy-only reading writes no series so the old one expires naturally).
  if (waveEntry && Array.isArray(waveEntry.hoursFt) &&
      waveEntry.hoursFt.some(function (v) { return typeof v === "number" && isFinite(v); })) {
    const models = waveEntry.models || [];
    const waveSeries = {
      beachId: beach.id,
      startIso: wavesStartIso,
      hoursFt: waveEntry.hoursFt,
      models: models,
      byModel: waveEntry.byModel || {},
      sources: [{
        label: models.length === 1 ? waveSourceLabel(models[0]) : "Open-Meteo Wave Models",
        url: OPEN_METEO_MARINE_URL
      }],
      updated: nowIso
    };
    await env.FLAGS.put(
      "waves:" + beach.id,
      JSON.stringify(waveSeries),
      { expirationTtl: WAVE_DATA_TTL_SECONDS }
    );
    return { input: 1, series: 1 };
  }
  return { input: 1, series: 0 };
}

// 6-hourly wave refresh (cron path). Owns ALL Open-Meteo/GLOS wave & wind
// fetching — deliberately separate from the hourly estimate so the marine
// models (which only publish every 6-12 h) are fetched at their own cadence,
// and so the fetching is paced (batchByBeach) to stay under Open-Meteo's
// per-minute weighted rate limit instead of bursting and getting 429'd. Writes
// two KV shapes per beach at the 7 h wave-data TTL: "waveinput:" + id (what the
// hourly estimate reads for wave height + the wind fallback) and "waves:" + id
// (the detail-page 24 h strip series, only when a real hourly series exists).
// A beach whose marine fetch merely failed this run is left untouched so its
// last-good KV rides the TTL — the same graceful-degradation contract the strip
// series has always had.
//
// The run is bounded in WALL CLOCK end to end (runBudget): gathering stops
// starting new upstream work at WAVE_GATHER_DEADLINE_MS and the write pool
// yields at WAVE_WRITE_DEADLINE_MS, so a bad run truncates and persists a prefix
// instead of being SIGKILLed at the 900 s scheduled ceiling with nothing to show
// for it. Progress is recorded incrementally in beaches.wave_updated (migration
// 0012), this cron's private rotation cursor.
async function runWaveRefresh(env) {
  // Measured from the top of the invocation (before the D1 SELECT) so the
  // budgets below bound TRUE elapsed time, not just the phases after the query.
  const startedMs = Date.now();
  const nowIso = new Date().toISOString();
  // Anchor the series start to the top of the run's UTC hour: hoursFt[0] is the
  // current-hour forecast, so the strip trims from the hour boundary.
  const wavesStartDate = new Date(Date.parse(nowIso));
  wavesStartDate.setUTCMinutes(0, 0, 0);
  const wavesStartIso = wavesStartDate.toISOString();
  const budget = runBudget(env);
  const gatherDeadline = makeDeadline(startedMs, budget.gatherDeadlineMs);
  const writeDeadline = makeDeadline(startedMs, budget.writeDeadlineMs);
  const timing = batchTiming(env, gatherDeadline);
  let inputCount = 0;
  let seriesCount = 0;
  let waterTempCount = 0;
  let stampedCount = 0;
  // Beaches the write pool REACHED but that persisted nothing because every
  // write threw. Distinct from truncation (the run stopping early) and from the
  // degradation skips (which deliberately write nothing and are still stamped).
  let writeFailureCount = 0;
  // Beaches the gather deadline stopped this run from ever fetching. They are
  // neither written nor stamped, so they sort to the front of next run's queue.
  const unattempted = new Set();

  const hotCutoffIso = new Date(Date.parse(nowIso) - HOT_VIEW_WINDOW_MS).toISOString();

  try {
    // nws_grid_url / nws_zone / marine_zone are selected so the supplemental
    // wave sources (step 2b) can key off them (gridpoint by nws_grid_url, NSH
    // by marine_zone) — the primary Open-Meteo/GLOS passes need only lat/lon,
    // but the fallback registry resolves per full beach row.
    const beachesResult = await selectRunBeaches(
      env,
      "id, lat, lon, nws_grid_url, nws_zone, marine_zone, last_viewed",
      hotCutoffIso,
      "wave"
    ).all();
    const beaches = beachesResult.results || [];

    // Step 1: waves (marine), paced. Own try/catch, like every gather step
    // below: before this, one unexpected throw anywhere in the gather skipped
    // the ENTIRE write pass and the run persisted nothing at all — the most
    // expensive possible failure mode for a 6-hourly cron.
    const waveResults = new Map();
    let waveWeightedCalls = 0;
    try {
      const wavePoints = beaches.map(function (b) {
        return { beachId: b.id, lat: b.lat, lon: b.lon };
      });
      const waveBatch = await batchByBeach(
        wavePoints,
        function (batch) { return fetchWaveHeightsFt(batch, nowIso); },
        function (point, entry) {
          waveResults.set(point.beachId, {
            waveHeightFt: entry.waveHeightFt,
            model: entry.model,
            hoursFt: entry.hoursFt,
            models: entry.models,
            byModel: entry.byModel
          });
        },
        function (batch) {
          for (const point of batch) {
            // hoursFt: null (not an all-null array) marks "fetch failed" distinctly
            // from "fetched, all cells masked" so the write step below can PRESERVE
            // a failed beach's last-good KV instead of clobbering it with a null.
            waveResults.set(point.beachId, { waveHeightFt: null, model: null, hoursFt: null, models: [], byModel: {} });
          }
          console.log("index: wave batch failed for " + String(batch.length) + " beaches");
        },
        timing
      );
      waveWeightedCalls = waveBatch.weightedCalls;
      for (const point of waveBatch.unattempted) {
        unattempted.add(point.beachId);
      }
    } catch (err) {
      console.log("index: wave marine pass threw: " + err.message);
    }

    // Step 2: Great Lakes buoy gap-filler. Open-Meteo's wave models commonly
    // return masked/null cells on the Great Lakes; for beaches still wave-null,
    // ask the GLOS Seagull buoy client. One call — the client dedups platform
    // fetches internally and caps them, so this stays well under the subrequest
    // budget even on a fully wave-null run.
    const glcfsPoints = waveNullPoints(beaches, waveResults);
    // Gate on the SAME gather deadline every other upstream step honors. Without
    // this, a marine pass that already consumed the budget still let this step
    // start a fresh catalog download plus up to MAX_PLATFORM_FETCHES buoy
    // fetches — hundreds of seconds of NEW upstream work begun AFTER the
    // deadline, and every reading it produced was then discarded anyway, since
    // those beaches are already in the unattempted set and the pool skips them.
    // It also falsified the invariant this file asserts: no new upstream work
    // starts after the gather deadline.
    if (glcfsPoints.length > 0 && gatherDeadline.expired()) {
      console.log(
        "index: glcfs gap-fill skipped, gather deadline reached (" +
        String(glcfsPoints.length) + " wave-null beaches)"
      );
    } else if (glcfsPoints.length > 0) {
      try {
        // Read the cron-cached derived catalogs (Set rehydrated from its array
        // form). A miss or corrupt payload deserializes to null, and the client
        // then fetches both catalogs fresh — never an error.
        let cachedCatalogs = null;
        try {
          const rawCatalogs = await env.FLAGS.get(GLCFS_CATALOG_KV_KEY, { type: "json" });
          cachedCatalogs = deserializeWaveCatalogs(rawCatalogs);
        } catch (cacheErr) {
          console.log("index: glcfs catalog cache read failed: " + cacheErr.message);
        }

        const glcfsData = await fetchGlcfsWaveHeightsFt(glcfsPoints, nowIso, cachedCatalogs);
        if (glcfsData !== null) {
          // Persist freshly fetched catalogs so the next ~24 h of runs reuse
          // them (skip when the client used the cache, so the TTL genuinely
          // expires and re-fetches). Empty catalogs are never cached — that
          // would suppress the gap-fill for a full day.
          if (glcfsData.catalogsFetched && glcfsData.catalogs &&
              glcfsData.catalogs.platforms.length > 0 &&
              glcfsData.catalogs.waveParameterIds.size > 0) {
            try {
              await env.FLAGS.put(
                GLCFS_CATALOG_KV_KEY,
                JSON.stringify(serializeWaveCatalogs(glcfsData.catalogs)),
                { expirationTtl: GLCFS_CATALOG_TTL_SECONDS }
              );
            } catch (writeErr) {
              console.log("index: glcfs catalog cache write failed: " + writeErr.message);
            }
          }
          for (const point of glcfsPoints) {
            const entry = glcfsData.results[point.beachId];
            if (entry && entry.waveHeightFt !== null) {
              // Buoys are nearest-point now-observations with no hourly series,
              // so preserve whatever hoursFt/models the Open-Meteo pass left on
              // the entry (both null/empty when Open-Meteo also missed) — never
              // synthesize a series from a single buoy reading.
              const existing = waveResults.get(point.beachId);
              const merged = existing
                ? { hoursFt: existing.hoursFt, models: existing.models, byModel: existing.byModel }
                : { hoursFt: null, models: [], byModel: {} };
              merged.waveHeightFt = entry.waveHeightFt;
              merged.model = entry.model;
              waveResults.set(point.beachId, merged);
            }
          }
        } else {
          console.log("index: glcfs wave gap-fill failed for " + String(glcfsPoints.length) + " beaches");
        }
      } catch (err) {
        console.log("index: glcfs wave gap-fill threw: " + err.message);
      }
    }

    // Step 2b: supplemental fallback wave sources (ordered registry). Consulted
    // ONLY for beaches STILL wave-null after Open-Meteo + the GLOS buoy pass —
    // an ordered fallback, never additive: the first matching source that
    // returns a finite ft wins (resolveSupplementalWaveFt breaks on it). Merged
    // into waveResults exactly like the buoy merge (waveHeightFt + model set,
    // hoursFt/models/byModel preserved — single-point fallbacks write no
    // "waves:" strip). MUST run BEFORE step 3 so wind stays the true last
    // resort. The full beach row is needed (gridpoint/NSH keys), so build a
    // beachById map — waveNullPoints only carries {beachId,lat,lon}. The
    // registry holds five sources today (gridpoint, NSH, Sea Caves, Toronto,
    // NDBC), so this block does real upstream work on every wave-null beach;
    // the length guard below only short-circuits the empty-registry case the
    // wave-source tests construct.
    //
    // Stays SEQUENTIAL by design. src/waveSources/index.js memoizes the RESOLVED
    // ft-or-null, not the in-flight promise, so pooling this loop would issue up
    // to N duplicate api.weather.gov fetches per key in production while every
    // existing (sequential) dedup test stayed green. Its wall time is bounded by
    // a sub-budget instead — see WAVE_SUPPLEMENTAL_BUDGET_MS.
    const supPoints = waveNullPoints(beaches, waveResults);
    if (supPoints.length > 0 && waveSources.length > 0) {
      try {
        // Two deadlines, either of which stops the loop: the run-wide gather
        // deadline, and this step's own sub-budget. The sub-budget is what keeps
        // the step-3 wind pass alive — in a fully wave-null winter run these
        // sequential fetches want ~500 s, which would consume the entire gather
        // deadline and leave every one of those beaches with no wind fallback
        // and therefore an "unknown" flag.
        const supDeadline = makeDeadline(Date.now(), budget.supplementalBudgetMs);
        const beachById = new Map();
        for (const b of beaches) {
          beachById.set(b.id, b);
        }
        // Run-scoped dedup memo: many wave-null beaches share one gridpoint cell
        // (nws_grid_url), one marine zone (NSH), or one nearest NDBC station, so
        // resolveSupplementalWaveFt fetches each unique (source, key) ONCE and
        // fans the ft-or-null to every beach sharing it — mirroring the step-2
        // GLOS platform dedup and the step-5b wqFloor gather grouping. Without
        // this a fully wave-null (winter) run would issue thousands of duplicate
        // upstream fetches and risk the per-invocation subrequest ceiling. Fallback
        // semantics are unchanged: ordered registry, first finite value wins.
        const supMemo = new Map();
        for (let i = 0; i < supPoints.length; i = i + 1) {
          if (gatherDeadline.expired() || supDeadline.expired()) {
            console.log(
              "index: supplemental wave deadline reached after " + String(i) +
              " of " + String(supPoints.length) + " beaches"
            );
            break;
          }
          const point = supPoints[i];
          const beach = beachById.get(point.beachId);
          if (!beach) {
            continue;
          }
          let resolved = null;
          try {
            resolved = await resolveSupplementalWaveFt(beach, nowIso, env, supMemo);
          } catch (err) {
            console.log("index: supplemental wave resolve threw for beach " + beach.id + ": " + err.message);
            resolved = null;
          }
          if (resolved && typeof resolved.waveHeightFt === "number" && isFinite(resolved.waveHeightFt)) {
            const existing = waveResults.get(point.beachId);
            const merged = existing
              ? { hoursFt: existing.hoursFt, models: existing.models, byModel: existing.byModel }
              : { hoursFt: null, models: [], byModel: {} };
            merged.waveHeightFt = resolved.waveHeightFt;
            merged.model = resolved.model;
            waveResults.set(point.beachId, merged);
          }
        }
      } catch (err) {
        console.log("index: supplemental wave pass threw: " + err.message);
      }
    }

    // Step 3: wind, only for beaches whose wave height is still null (the wind
    // fallback the estimate uses when every wave model is null). Recomputed
    // fresh — step 2 may have gap-filled some beaches out of the wave-null set.
    // Deliberately NOT capped by a coverage limit: truncating the wind pass
    // would change which INPUTS reach estimateFlag and turn wind-derived
    // greens/yellows into "unknown", which is a product regression, not a
    // performance fix. Only the shared gather deadline bounds it.
    const windResults = new Map();
    let windWeightedCalls = 0;
    try {
      const windPoints = waveNullPoints(beaches, waveResults);
      const windBatch = await batchByBeach(
        windPoints,
        function (batch) { return fetchWinds(batch); },
        function (point, entry) {
          windResults.set(point.beachId, {
            windSpeedMph: entry.windSpeedMph,
            windGustMph: entry.windGustMph
          });
        },
        function (batch) {
          console.log("index: wind batch failed for " + String(batch.length) + " beaches");
        },
        timing
      );
      windWeightedCalls = windBatch.weightedCalls;
      for (const point of windBatch.unattempted) {
        unattempted.add(point.beachId);
      }
    } catch (err) {
      console.log("index: wind pass threw: " + err.message);
    }

    // Step 3b: NDBC water temperature — FETCH half (DISPLAY-ONLY). Self-contained
    // pass over the beaches already SELECTed this run: never reads or mutates
    // waveResults / windResults / the wave KV, and never feeds src/rules.js (it
    // colors no flag and bumps no RULES_VERSION). Many beaches share one nearest
    // NDBC buoy, so dedup by station id (exactly like the step-2b supplemental
    // memo): fetch each unique station's realtime2 file ONCE via stationWaterTemp
    // and fan the parsed reading to every beach under it. It is fine that this
    // may re-fetch a couple of station files the wave fallback also touched
    // (<=10 unique stations total) — the pass is kept isolated on purpose rather
    // than sharing a cache across passes.
    //
    // This pass ran AFTER the write loop until now, which is why not one
    // "watertemp:" key has ever existed in production: the sequential ~1450-put
    // write loop consumed the entire invocation and this code was never reached.
    // Splitting it — the fetch here, the put folded into the write pool below —
    // makes it un-starvable by POSITION rather than merely bounded, and DELETES a
    // second ~1000-put sequential loop instead of parallelizing it. It is last in
    // the gather on purpose: if the gather deadline bites, display-only data is
    // the correct thing to sacrifice.
    const waterTempByBeach = new Map();
    try {
      const stationBeaches = new Map();
      for (const beach of beaches) {
        const station = nearestStation(beach.lat, beach.lon);
        if (station === null) {
          continue;
        }
        if (!stationBeaches.has(station.id)) {
          stationBeaches.set(station.id, []);
        }
        stationBeaches.get(station.id).push({ beachId: beach.id, station: station });
      }
      for (const entry of stationBeaches) {
        if (gatherDeadline.expired()) {
          console.log("index: water temp gather deadline reached");
          break;
        }
        const stationId = entry[0];
        const members = entry[1];
        let reading = null;
        try {
          reading = await stationWaterTemp(stationId, nowIso, env);
        } catch (err) {
          console.log("index: water temp fetch threw for station " + stationId + ": " + err.message);
          reading = null;
        }
        // Station fetch/parse returned null (winter gap, all-"MM", stale, 404):
        // record nothing, so every beach's old "watertemp:" key expires on its own.
        if (reading === null) {
          continue;
        }
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

    // Step 4: persist per-beach wave inputs (+ the strip series, + the water-temp
    // reading gathered in step 3b), isolated failures, at KV_WRITE_CONCURRENCY.
    // This loop was sequential and was ~80% of the run that got SIGKILLed; it is
    // embarrassingly parallel — nothing in the body depends on the previous
    // beach. The pool YIELDS at writeDeadline instead of being killed, and the
    // wave_updated cursor is flushed incrementally as it goes, so a truncated run
    // persists a prefix and the beaches it never reached sort first next run.
    const stamper = makeWaveCursorStamper(env, nowIso, WAVE_CURSOR_FLUSH_SIZE);
    const writeReached = await runPool(beaches, KV_WRITE_CONCURRENCY, async function (beach) {
      // The gather never attempted this beach (deadline), so the run genuinely
      // has no opinion about it: no writes and NO stamp — stamping here would
      // advance the cursor past work that never happened.
      if (unattempted.has(beach.id)) {
        return;
      }
      // A beach counts as DECIDED once any write path completed without
      // throwing — either it persisted something, or a degradation guard
      // deliberately chose to write nothing. A beach whose every write THREW
      // reached no decision at all, and must not be stamped (see below).
      let decided = false;
      try {
        const counts = await writeWaveKvForBeach(
          env,
          beach,
          waveResults.get(beach.id),
          windResults.get(beach.id),
          wavesStartIso,
          nowIso
        );
        inputCount = inputCount + counts.input;
        seriesCount = seriesCount + counts.series;
        decided = true;
      } catch (err) {
        console.log("index: wave input write failed for beach " + beach.id + ": " + err.message);
      }

      // Water temp is written INDEPENDENTLY of the two wave skip guards,
      // deliberately: a failed marine fetch says nothing about an NDBC buoy
      // reading, and coupling the two would re-create the zero-watertemp gap for
      // exactly the beaches whose wave data is missing and which most need a
      // fallback signal. Its own try/catch, so a rejected water-temp put can
      // neither lose the wave writes already made nor cost the beach its stamp.
      try {
        const waterTemp = waterTempByBeach.get(beach.id);
        if (waterTemp) {
          await env.FLAGS.put(
            "watertemp:" + beach.id,
            JSON.stringify(waterTemp),
            { expirationTtl: WAVE_DATA_TTL_SECONDS }
          );
          waterTempCount = waterTempCount + 1;
          decided = true;
        }
      } catch (err) {
        console.log("index: water temp write failed for beach " + beach.id + ": " + err.message);
      }

      // Stamped for EVERY beach that reached a write DECISION — INCLUDING the two
      // graceful-degradation skips, which write nothing. Stamping only on a
      // successful write would INVERT the starvation this cursor exists to fix:
      // Open-Meteo masking on the Great Lakes is documented as normal (not an
      // error), so a permanently-masked beach writes nothing on every single run
      // and would pin itself to the head of the queue forever.
      //
      // But a beach whose writes all THREW is the opposite case: it got nothing,
      // and stamping it would advance the cursor past a beach that still has no
      // data, sending it to the BACK of the queue on the strength of a failure.
      // An unstamped beach sorts first next run, which is the honest outcome.
      //
      // This is counted SEPARATELY from truncation rather than folded into it.
      // A write failure and a cut-short run are different operational events: a
      // single flaky put must not trip the truncated= alarm (that would cry wolf
      // every run), while a run where EVERY write failed — the shape a newly
      // enforced per-invocation KV ceiling would take — must be impossible to
      // miss. It shows up here as failures= equal to beaches= with stamped=0.
      if (!decided) {
        writeFailureCount = writeFailureCount + 1;
        return;
      }
      stampedCount = stampedCount + 1;
      await stamper.add(beach.id);
    }, writeDeadline);
    await stamper.drain();

    console.log("index: water temp writes this run=" + String(waterTempCount));

    // Open-Meteo weighted-call accounting (U1): each location in a batch costs
    // ~1 weighted call and the one backoff retry doubles a throttled batch, so
    // this is the run's contribution to the free-tier daily ceiling. Logged for
    // visibility only — no behavioral throttling on the daily budget yet. Once
    // nationwide pagination removes the MAX_BEACHES_PER_RUN cap, this ceiling
    // binds before the Workers subrequest limit does (TODO.md).
    //
    // peak= is the run's rolling PER-MINUTE rate against Open-Meteo's documented
    // 600/min free-tier ceiling, which is the limit actually producing the HTTP
    // 429s — and it was invisible in the logs, which reported only the daily
    // figure. Same arithmetic as the OPEN_METEO_CONCURRENCY comment: batch size x
    // concurrency per (gap + ~3 s fetch).
    const openMeteoWeightedCalls = waveWeightedCalls + windWeightedCalls;
    console.log(
      "index: open-meteo weighted calls this run=" + String(openMeteoWeightedCalls) +
      " (wave=" + String(waveWeightedCalls) +
      " wind=" + String(windWeightedCalls) +
      ") of " + String(OPEN_METEO_DAILY_WEIGHTED_CEILING) + "/day free-tier ceiling" +
      " peak=" + String(Math.round(OPEN_METEO_BATCH * timing.concurrency * 60000 / (timing.gapMs + 3000))) + "/min"
    );

    // The completion log is the operator trip-wire. The run that motivated all
    // of this produced THREE log lines and no completion record at all, so
    // diagnosing it needed Cloudflare observability rather than the logs.
    //
    // The two failure shapes are reported SEPARATELY on purpose:
    //   truncated=yes — the run ran out of clock. Either the gather deadline
    //     left beaches unattempted, or the write pool yielded before reaching
    //     every beach (writeReached is what runPool actually got to). This is
    //     the alarm: it means coverage now depends on the rotation cursor.
    //   failures=N   — beaches the pool reached whose every write threw. One
    //     flaky put is noise; failures= near beaches= with stamped=0 is a
    //     systemic write outage (the shape an enforced per-invocation KV
    //     operation ceiling would take) and needs immediate attention.
    // elapsedMs= is the number to watch if KV throughput turns out worse than
    // the ~0.45 s/put this design was sized against.
    const truncated = writeReached < beaches.length || unattempted.size > 0;
    console.log(
      "index: wave refresh complete, beaches=" + String(beaches.length) +
      " stamped=" + String(stampedCount) +
      " reached=" + String(writeReached) +
      " unattempted=" + String(unattempted.size) +
      " failures=" + String(writeFailureCount) +
      " inputs=" + String(inputCount) +
      " series=" + String(seriesCount) +
      " watertemp=" + String(waterTempCount) +
      " truncated=" + (truncated ? "yes" : "no") +
      " elapsedMs=" + String(Date.now() - startedMs)
    );
  } catch (err) {
    console.log("index: wave refresh failed: " + err.message);
  }
}

export function sleep(ms) {
  // A non-positive delay (e.g. pacing zeroed in tests) resolves immediately
  // rather than arming a timer.
  if (!(ms > 0)) {
    return Promise.resolve();
  }
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Increment a beach's attempts counter (enrichment_attempts for NWS,
// eccc_attempts for ECCC) so permanently-failing points (e.g. non-US shoreline
// api.weather.gov 404s, or a point no Canadian region contains) eventually park
// out of their queue. Both authorities run the identical nine lines, so they
// share this helper and pass their own UPDATE — kept as whole literals at the
// call sites so each statement stays greppable. Self-isolating: a D1 write
// failure here is logged and swallowed so it never aborts the enrichment loop.
async function bumpAttempts(env, beachId, sql, label) {
  try {
    await env.DB.prepare(sql).bind(beachId).run();
  } catch (updateErr) {
    console.log("index: " + label + " enrichment attempt bump failed for " + beachId + ": " + updateErr.message);
  }
}

const NWS_ATTEMPTS_BUMP_SQL = "UPDATE beaches SET enrichment_attempts = enrichment_attempts + 1 WHERE id = ?1";
const ECCC_ATTEMPTS_BUMP_SQL = "UPDATE beaches SET eccc_attempts = eccc_attempts + 1 WHERE id = ?1";

// NWS point enrichment (own cron, 4x daily): beaches with nws_zone NULL get
// their forecast zone + gridpoint URL from api.weather.gov/points. A beach
// without nws_zone skips rules steps 1-2 (alerts, SRF rip risk) in
// runFlagRecompute — its estimate now carries an explicit "NWS alerts not
// yet available for this beach" caveat (alertsCheckable: false into
// estimateFlag), but draining this queue fast is still a safety property,
// not just throughput. Ordering: fresh rows (fewest failed attempts) first, then
// RANDOM() — the old ORDER BY id drained every osm-node-* row before any
// osm-way-* row, which left way-based beaches (Holland State Park) blind to
// active alerts for weeks (TODO.md).
async function runNwsEnrichment(env) {
  let enriched = 0;
  let enrichmentFailures = 0;

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
      if (!firstRequest) {
        await sleep(ENRICHMENT_REQUEST_SPACING_MS);
      }
      firstRequest = false;
      try {
        const meta = await fetchPointMetadata(beach.lat, beach.lon);
        if (meta !== null) {
          await env.DB.prepare(
            "UPDATE beaches SET nws_zone = ?1, nws_grid_url = ?2 WHERE id = ?3"
          ).bind(meta.nwsZone, meta.nwsGridUrl, beach.id).run();
          enriched = enriched + 1;
        } else {
          // fetchPointMetadata returns null on any failure (e.g. a 404 for a
          // non-US point) rather than throwing — count that as an attempt so
          // permanent failures eventually stop being requeued.
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
      "index: nws enrichment complete, attempted=" + String(toEnrich.length) +
      " enriched=" + String(enriched) +
      " failures=" + String(enrichmentFailures) +
      " parked=" + String(parkedCount)
    );
  } catch (err) {
    console.log("index: nws enrichment failed: " + err.message);
  }
}

// ECCC zone enrichment (own cron, 4x daily, offset from the NWS trigger so
// the two enrichment upstreams never share a failure window): beaches that
// NWS point enrichment permanently parked (nws_zone NULL at the attempts cap
// — the Ontario shoreline swept in by the Great Lakes region set,
// src/regions.js) get their ECCC public
// forecast region name from the GeoMet public-standard-forecast-zones
// collection. A row with eccc_zone set is treated as Canadian by the hourly
// recompute: it joins the single weather-alerts bbox fetch and loses the
// alerts-unavailable caveat. Genuinely un-resolvable points (no Canadian
// region contains them) park at ECCC_ENRICHMENT_MAX_ATTEMPTS exactly like
// the NWS side.
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
    // ONE bulk fetch of the whole forecast-region polygon set per run (F12),
    // then resolve every pending beach locally via point-in-polygon — the same
    // one-fetch shape as the alerts path, replacing up to 50 per-point GeoMet
    // requests with a single one. A failed OR under-delivered bulk fetch
    // (below ECCC_ZONES_SANITY_MIN parsed zones) PARKS the run (every beach
    // skipped, no attempt bumped, no throw) so a transient GeoMet outage or a
    // degraded partial response never burns the attempts budget of
    // resolvable rows.
    // Env-tunable floor (tests use a tiny fixture zone set), defaulting to
    // the production sanity constant.
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
    // zones stays null when there is nothing to enrich or the run is parked
    // (both logged above), so the per-beach loop only runs on a good fetch.
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
            // No Canadian region contains the point OR sits within the
            // nearest-edge leniency cap (ECCC_ZONE_MAX_EDGE_KM) — a US point.
            // Count an attempt so unresolvable rows eventually park, exactly
            // like the old per-point null.
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

// Webcam hydration (own cron, daily): for beaches never checked
// (webcam_checked IS NULL sorts first in SQLite ASC) or last checked over
// 14 days ago, ask the Windy Webcams API for the nearest active cam and
// store its embed player URL. An API-success-with-no-cam is a confirmed
// answer (clear the webcam columns, stamp webcam_checked); a transport/API
// failure leaves the row untouched so it stays at the front of the queue
// for the next nightly run. The player URL itself is only ever fetched by
// the BROWSER on the detail page — the request path still reads only D1/KV.
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

    // Persist ONE beach's fetch result (the { webcam } | null shape both the
    // nearby and bbox paths produce): null = transport/API failure, leave the
    // row untouched so it stays at the front of the queue; { webcam: null } =
    // confirmed no cam here, clear + stamp; { webcam } = store the player.
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
        // untouched to retry next run (no request amplification).
        webcamFailures = webcamFailures + bucket.length;
        continue;
      }
      if (truncated) {
        // The result hit the 50-cam cap and may be incomplete, so a bbox-wide
        // "nearest" could be wrong — fall back to a per-beach nearby query,
        // which the API bounds to the radius server-side.
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

// Cron dispatch table (see the scheduled triggers in wrangler.toml).
// Each entry pairs a cron expression with its runner and the label used in
// the top-level throw log. Keeping this as data means adding a cron is one
// row, and the unknown-cron fallback below stays the single place that logs
// an unrecognized trigger.
const CRON_JOBS = {
  "7 * * * *": { run: runFlagRecompute, label: "flag recompute" },
  "15 */6 * * *": { run: runWaveRefresh, label: "wave refresh" },
  "17 3,9,15,21 * * *": { run: runNwsEnrichment, label: "nws enrichment" },
  "29 4,10,16,22 * * *": { run: runEcccEnrichment, label: "eccc enrichment" },
  "31 9 * * *": { run: runWebcamSync, label: "webcam sync" }
};

export default {
  fetch: async function (request, env, ctx) {
    // Request-path error boundary: an unhandled throw would otherwise surface
    // Cloudflare's generic error page instead of the project's own. Log the
    // failure and render a 500 in the same shape as the route's success case —
    // a JSON body for /api/ routes, renderErrorPage HTML otherwise — always
    // no-store so a transient error is never cached.
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
