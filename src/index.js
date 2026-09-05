import { handleRequest } from "./router.js";
import { renderErrorPage } from "./frontend/render.js";
import { estimateFlag, SEVERITY_RANK } from "./rules.js";
import {
  fetchAllActiveAlerts,
  fetchActiveAlertCount,
  nwsAlertsForZone,
  alertsUrlForZone,
  wfoFromGridUrl,
  fetchLatestSrfText,
  fetchPointMetadata
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
import { findScraper, scrapeOfficialFlagFromResult } from "./officialSources/index.js";
import { findWqFloorSource, scrapeWqFloorFromResult } from "./wqFloor/index.js";
import { WIND_SOURCE, waveSourceLabel, waveSourceUrl } from "./waveModels.js";
import { nearestWaterTempStation, stationWaterTemp } from "./waveSources/ndbcBuoys.js";
import { updateScraperHealth } from "./scraperHealth.js";
import { HOT_VIEW_WINDOW_MS } from "./demandWindow.js";
import { FLAG_TTL_SECONDS } from "./flagTtl.js";
import {
  buildAlertInputs,
  buildEstimateInputs,
  sealFromSignals,
  signalsFromStanding,
  standingAlertEvents,
  eventKey
} from "./flagInputs.js";
import {
  MAP_DIRECTORY_KEY,
  MAP_DIRECTORY_TTL_SECONDS,
  mapDirectoryEntry,
  buildMapDirectory
} from "./mapDirectory.js";
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
// that inequality is measurable rather than assumed. Real pagination is still
// required for nationwide scale-out (TODO.md).
const MAX_BEACHES_PER_RUN = 1200;
// HOT_VIEW_WINDOW_MS is imported from ./demandWindow.js and deliberately not
// re-exported: workerd rejects any non-function named export on the entry module
// and fails the Worker at startup. See demandWindow.js.
// FLAG_TTL_SECONDS (25200) is imported from ./flagTtl.js and deliberately not
// re-exported: workerd rejects any non-function named export on the entry
// module and fails the Worker at startup. src/mapDirectory.js reads the same
// lease from there to reproduce KV expiry at read time.
// The "flag:" estimate is rewritten on every rotation turn and never retracted,
// so this TTL is pure expiry: it must outlive the gap between one beach's turns
// rather than bound how long a withdrawn reading keeps rendering. That gap is
// ceil((flagWorthy - hot) / (MAX_BEACHES_PER_RUN - hot)) hourly runs, plus one
// hour for every run killed before its trailing recompute_updated batch commits,
// plus the put's position inside a run capped at 900 s. Seven hours covers a
// four-run rotation with two lost runs. A beach at the far end renders its last
// reading, marked stale on the detail page, instead of dropping to no-data; the
// list chip and the map marker carry no age signal, so a rotation-old color
// reads there exactly like a fresh one.
//
// The "official:" put shares this TTL. The two keys are the operands of
// displayFlagColor, so the estimate must never outlive the posted flag it is
// weighed against.
//
// "wqfloor:" keeps the shorter TTL: nothing deletes a KV key, so expiry is the
// only way a cleared advisory stops rendering, and the advisory callout is
// display-only — it never decides a color.
const KV_TTL_SECONDS = 7200;
// The water-temp reading is refreshed on the 6-hourly cron, so its KV must
// outlive the gap between runs plus slack for a failed one. The offline wave
// pipeline writes "waveinput:"/"waves:" on its own absolute expiration and does
// not read this constant.
const WAVE_DATA_TTL_SECONDS = 25200;
// Requested width for every fan-out KV write in both crons. Cloudflare caps an
// invocation at six simultaneous open connections and KV get/put count toward
// that cap, so 12 yields ~6 in flight with the remainder queued: a modest
// oversubscription that keeps the pipe saturated across the long tail of put
// latencies, not a claim of 12x throughput. Size every wall-clock estimate for
// these passes at 6, never at 12.
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
// Ids per wave_updated D1 batch. The flush must be incremental: a single batch
// after the loop never runs when the invocation is killed mid-loop, so the cursor
// never moves and the same prefix of beaches is reprocessed every run forever.
const WAVE_CURSOR_FLUSH_SIZE = 100;
// Wall-clock rail on the map-directory scan, measured from the start of the
// scan. The scan is ~1.5 s over today's flag-worthy set and ~13 s at 10k rows at
// the ~6 simultaneous connections the platform grants, so this is a guard
// against a hung KV read rather than a routine truncation point, and it leaves
// the hourly run's 900 s budget intact.
const MAP_SCAN_DEADLINE_MS = 120000;
// Alerts refresh cron ("3-53/10 * * * *"). It fetches four national endpoints
// bounded at 45 s each, scans the flag-worthy set, and writes only the beaches
// whose alert set moved, so the worst case sits well inside the 600 s cadence.
//
// FAST_WRITE_DEADLINE_MS: the write pool yields here rather than being killed at
// the 900 s ceiling. A capped or truncated run is self-continuing — the beaches
// it never reached keep their old standing alert set, so the next run re-selects
// them. Measured from the pool's own start, not from the top of the invocation:
// the four sequential fetches can spend 180 s and the scan another 120 s ahead of
// it, which anchored at the invocation would leave the pool no budget at all and
// a run that writes nothing while every skip counter reads zero. 180 + 120 + 240
// still sits inside the 600 s cadence.
// FAST_MIN_REMAINING_TTL_SECONDS: a beach within five minutes of its lease
// expiring belongs to the hourly. KV's minimum expirationTtl is 60 s, and
// republishing a nearly-dead key buys nothing.
// FAST_LOWER_MAX_SEAL_AGE_MS: this cron will not publish a LOWERING decided by
// inputs the product itself would render with a stale-data warning. 7200000 is
// render.js STALE_MS. Raises are never gated on age, because age can only
// understate a hazard.
// FAST_MAX_BEACHES_PER_RUN caps WRITES, not reads, and is checked inside the pool
// worker rather than by slicing the candidate list. The binding ceiling is
// subrequests, not wall clock: 2000 puts plus the scan's bulk gets, four fetches
// and one artifact put lands near 2,030 against the 10,000-per-invocation cap.
// FAST_MAX_BEACHES_PER_RUN also caps the candidate list, so a nationwide event
// that moves every zone's alert set cannot materialize one retained candidate per
// table row against the 128 MB isolate; beyond the cap the run is self-continuing
// for the same reason a capped write run is.
// ALERT_COUNT_SLACK covers only the skew between two fetches taken about a second
// apart — the national issue rate is a few alerts per ten minutes — so a shortfall
// larger than this is truncation or schema drift, not timing.
// ALERT_PARSE_DROP_MAX is the second half of that cross-check and answers a
// different question: the count endpoint proves the whole population arrived,
// this proves the parse UNDERSTOOD it. featureCount is the raw pre-filter count,
// so a schema drift that renames properties.event or restructures the zone fields
// yields alerts: [] with featureCount still equal to the count endpoint's total —
// a nationwide clear-down licensed by a feed nobody could read. A healthy feed
// drops almost nothing at that filter, since an active alert carries an event
// name and at least one UGC or affectedZones id, so a larger drop is drift rather
// than routine loss.
const FAST_WRITE_DEADLINE_MS = 240000;
const FAST_MIN_REMAINING_TTL_SECONDS = 300;
const FAST_LOWER_MAX_SEAL_AGE_MS = 7200000;
const FAST_MAX_BEACHES_PER_RUN = 2000;
const ALERT_COUNT_SLACK = 5;
const ALERT_PARSE_DROP_MAX = 5;
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
// Per run of the enrichment cron, 4x daily. api.weather.gov publishes no numeric
// rate limit (it 429s with Retry-After when unhappy); 75 sequential polite
// requests per run drains a freshly discovered region in days, not weeks.
const NWS_ENRICHMENT_LIMIT = 75;
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
// api.weather.gov treats like a proxy, so firing 75 back-to-back /points requests
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

// Wall-clock budget for the alerts refresh cron's write pool, same plain-number
// env override idiom as runBudget(env) and for the same reason.
function fastRunBudget(env) {
  return {
    writeDeadlineMs: env && typeof env.FAST_WRITE_DEADLINE_MS === "number"
      ? env.FAST_WRITE_DEADLINE_MS : FAST_WRITE_DEADLINE_MS
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

// Every flag-worthy beach with the columns the map directory and the alert match
// both need, in a stable order. No bind parameters: FLAG_WORTHY_WATER_SQL is an
// inlined literal (src/waterClass.js). ORDER BY id makes the entry order
// deterministic, so one build diffs meaningfully against the next.
//
// recompute_updated rides along for the refresh cron alone: D1 is strongly
// consistent where KV is not, so the hourly's own stamp is what lets a stale
// "flag:" replica be recognized as superseded.
const MAP_DIRECTORY_SQL =
  "SELECT id, name, park_name, lat, lon, nws_zone, marine_zone, eccc_zone, recompute_updated " +
  "FROM beaches WHERE " + FLAG_WORTHY_WATER_SQL + " ORDER BY id";

// Scan budget read from env with a fallback to the module constant, the same
// plain-number override runBudget(env) uses and for the same reason: a 0 makes
// the deadline branch reachable under a frozen Date, where makeDeadline's
// expired() uses >=.
function mapScanBudgetMs(env) {
  return env && typeof env.MAP_SCAN_DEADLINE_MS === "number"
    ? env.MAP_SCAN_DEADLINE_MS : MAP_SCAN_DEADLINE_MS;
}

// Builds the map directory's entry list from rows plus the KV each row stands
// on, and returns { entries, byId } — or null when the deadline tripped.
//
// Three disciplines this must keep:
//
// Streaming. Each chunk keeps only the four scalars an entry needs and lets the
// parsed KV values go out of scope, so peak memory is one chunk plus the entry
// array rather than the whole table's parsed payloads. That is what pushes the
// 128 MB isolate ceiling out.
//
// Read-your-writes. KV offers no read-your-own-writes guarantee, so a cron that
// just wrote a key can read the pre-write value milliseconds later. preload is
// { estimates, officials }, two Maps of what this run already wrote; ids present
// there are never requested from KV at all. Preloading BOTH is load-bearing: with
// estimates only, a flag posted this run renders the previous hour's official
// color on the map for an hour. A beach whose put FAILED is deliberately absent
// from preload, so it falls through to the KV read and picks up its old standing
// value.
//
// Whole or nothing. A scan that trips its deadline returns null and the caller
// writes no artifact, leaving the previous one to ride its own TTL. A partial
// directory would drop beaches from the map entirely, which is worse than an
// unknown color.
//
// onRow(row, entry, standing, official) is synchronous, called once per row —
// including rows dropped for non-finite coordinates, where entry is null — and
// may be null. It exists so a caller can select on the standing estimate while it
// is still in hand, at no second read.
async function scanMapDirectory(env, rows, deadline, preload, onRow) {
  const preEstimates = preload && preload.estimates ? preload.estimates : null;
  const preOfficials = preload && preload.officials ? preload.officials : null;
  const entries = [];
  const byId = new Map();
  const groups = chunk(rows, 100);
  for (const group of groups) {
    if (deadline && deadline.expired()) {
      return null;
    }
    const flagKeys = [];
    const officialKeys = [];
    for (const row of group) {
      if (!preEstimates || !preEstimates.has(row.id)) {
        flagKeys.push("flag:" + row.id);
      }
      if (!preOfficials || !preOfficials.has(row.id)) {
        officialKeys.push("official:" + row.id);
      }
    }
    const reads = await Promise.all([
      flagKeys.length > 0 ? env.FLAGS.get(flagKeys, { type: "json" }) : Promise.resolve(null),
      officialKeys.length > 0 ? env.FLAGS.get(officialKeys, { type: "json" }) : Promise.resolve(null)
    ]);
    const flagMap = reads[0];
    const officialMap = reads[1];
    for (const row of group) {
      const standing = preEstimates && preEstimates.has(row.id)
        ? preEstimates.get(row.id)
        : (flagMap ? flagMap.get("flag:" + row.id) || null : null);
      const official = preOfficials && preOfficials.has(row.id)
        ? preOfficials.get(row.id)
        : (officialMap ? officialMap.get("official:" + row.id) || null : null);
      const entry = mapDirectoryEntry(row, standing, official);
      if (entry !== null) {
        entries.push(entry);
        byId.set(row.id, entry);
      }
      if (onRow) {
        onRow(row, entry, standing, official);
      }
    }
  }
  return { entries: entries, byId: byId };
}

// Publishes the directory as one whole value. Returns true on success, false on
// a throw, which is logged and never rethrown: a builder failure must not change
// the calling run's own accounting.
//
// An empty entry list is refused rather than published. A D1 read that resolves
// with no results — a response carrying no results array, a snapshot taken while
// classification had hidden everything — otherwise publishes a structurally valid
// directory the request path accepts as authoritative, blanking the map for three
// hours with no degraded marker and no log line. An empty directory is the
// maximal partial, and the whole-or-nothing rule the scan keeps applies to it.
async function putMapDirectory(env, entries, builtAtIso) {
  if (entries.length === 0) {
    console.log("index: map directory build produced no entries; keeping the previous directory");
    return false;
  }
  try {
    await env.FLAGS.put(
      MAP_DIRECTORY_KEY,
      JSON.stringify(buildMapDirectory(entries, builtAtIso)),
      { expirationTtl: MAP_DIRECTORY_TTL_SECONDS }
    );
    return true;
  } catch (err) {
    console.log("index: map directory put failed: " + err.message);
    return false;
  }
}

// Hourly estimate recompute. Fetches the fast-changing safety signals (alerts,
// rip-current risk) every hour but takes wave height and the wind fallback from
// the KV the offline NOAA GRIB pipeline bulk-writes; no wave fetch is reachable
// from this Worker at all.
async function runFlagRecompute(env) {
  const nowIso = new Date().toISOString();
  let estimateCount = 0;
  let officialCount = 0;
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

    // Step 5: wave inputs — read only, never fetched here. The offline NOAA GRIB
    // pipeline bulk-writes a "waveinput:" + id payload
    // ({ waveHeightFt, model, windSpeedMph, windGustMph, updated }) per beach. A
    // missing key — no cycle has landed, or its data aged past its expiration —
    // yields no wave input, and the estimate degrades to the wind fallback or
    // "unknown", never a wrong flag. Prefetched concurrently in chunks so the
    // per-beach loop below stays synchronous.
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
    // rather than a sequential walk — see src/pool.js. Nothing in the body
    // depends on the previous iteration. estimateCount / failureCount are
    // incremented with a single synchronous statement, no await between read and
    // write, so concurrent runners cannot lose a count.
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
        const alertPart = buildAlertInputs(beach, alertCtx);

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
        // input (or are absent when there is no fresh data for this beach).
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
        // source when it is the signal actually in play.
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
        // nor eccc_zone resolved); when false, estimateFlag appends a "Weather
        // alerts not yet available for this beach" caveat so a wave-only green is
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
        await env.FLAGS.put(
          "flag:" + beach.id,
          JSON.stringify(stored),
          { expirationTtl: FLAG_TTL_SECONDS }
        );

        // Persist the structured advisory so the request path can render a
        // distinct water-quality callout. Written only when non-null; a clean
        // reading writes nothing and the key expires naturally, as "official:"
        // does. Not an official override — never feeds markerFlagColor or
        // titleColor.
        if (waterQualityAdvisory !== null) {
          await env.FLAGS.put(
            "wqfloor:" + beach.id,
            JSON.stringify(waterQualityAdvisory),
            { expirationTtl: KV_TTL_SECONDS }
          );
        }

        // The detail-page WaveSeries ("waves:" + id) is bulk-written by the
        // offline pipeline; this loop only reads wave inputs.
        //
        // This set stays after the successful flag: put and inside the same try.
        // A failed write is caught, counted as a failure, and records no
        // estimate, so no flag_history row can claim an estimate that was never
        // published. Do not refactor this into a collect-descriptors-then-flush
        // shape: that silently inverts the guarantee.
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
        // Only the inner per-beach put loop is pooled. The outer scraperGroups
        // loop stays sequential: it does a read-modify-write on shared
        // per-scraper "scraperhealth:" KV state and carries the continue above,
        // neither of which survives a callback conversion intact.
        await runPool(group.beaches, KV_WRITE_CONCURRENCY, async function (beach) {
          const flag = scrapeOfficialFlagFromResult(beach, group.scraper, result);
          if (flag !== null) {
            // The default matches the estimate's TTL: displayFlagColor weighs
            // this record against the "flag:" estimate, so an official key that
            // lapses first hands a posted red to a stale green. Past the
            // renderer's 2 h gate the surviving record is raise-only and its
            // card carries the stale warning, so ageing together costs no
            // safety. A scraper on a reduced cadence may still opt into a
            // longer TTL via officialTtlSeconds.
            const officialTtl =
              typeof group.scraper.officialTtlSeconds === "number"
                ? group.scraper.officialTtlSeconds
                : FLAG_TTL_SECONDS;
            await env.FLAGS.put(
              "official:" + beach.id,
              JSON.stringify(flag),
              { expirationTtl: officialTtl }
            );
            // Same ordering rule as the estimate above: recorded only after the
            // put resolved, so flag_history never pairs against an official color
            // that was never published.
            officialsByBeach.set(beach.id, {
              color: flag.color,
              source: flag.scraperId || group.scraper.id,
              updated: flag.updated
            });
            officialCount = officialCount + 1;
          }
        });
      } catch (err) {
        console.log("index: official scrape failed: " + err.message);
      }
    }

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

    // Step 11: rebuild the map directory from KV truth plus the estimates and
    // officials this run wrote, and publish it whole. The preload is what keeps
    // this run's own writes out of a KV read that has no read-your-own-writes
    // guarantee. Its own try/catch: a builder failure must never change the
    // run's estimate, official or history accounting.
    let mapdirState = "failed";
    try {
      const dirResult = await env.DB.prepare(MAP_DIRECTORY_SQL).all();
      const dirRows = dirResult.results || [];
      const scan = await scanMapDirectory(
        env,
        dirRows,
        makeDeadline(Date.now(), mapScanBudgetMs(env)),
        { estimates: estimatesByBeach, officials: officialsByBeach },
        null
      );
      if (scan === null) {
        mapdirState = "truncated";
      } else {
        mapdirState = await putMapDirectory(env, scan.entries, nowIso)
          ? String(scan.entries.length)
          : "failed";
      }
    } catch (err) {
      console.log("index: map directory rebuild failed: " + err.message);
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
      " history=" + String(historyCount) +
      " failures=" + String(failureCount) +
      " hot=" + String(hotCount) +
      " waveinputs=" + String(waveInputs.size) +
      " oldest=" + (oldestCursor || "none") +
      " mapdir=" + mapdirState
    );
  } catch (err) {
    console.log("index: flag recompute failed: " + err.message);
  }
}

// Level-triggered alerts refresh ("3-53/10 * * * *"). NWS alerts are the only
// event-driven input in the system, so this cron closes the gap between a warning
// being issued and the flag moving from up to an hour to about ten minutes.
//
// Its upstream cost does not scale with the beach table: four national fetches,
// matched to beaches locally. Its per-beach cost is paid only for beaches whose
// alert situation actually changed, which it detects by comparing each beach's
// CURRENT alert event set against the set its STANDING estimate was decided
// against — echoed into the "flag:" value as alertDetails by rules.js. That is
// why there is no persisted baseline, no zone digest, no gained/changed/cleared
// classification and no first-run semantics: the standing set is already in hand,
// because the map-directory scan bulk-reads every flag-worthy beach's "flag:" key
// anyway.
//
// Level-triggering is also what removes the hourly/fast interlock. The hourly can
// clobber a fast raise with its own older snapshot, and no KV lock can close that
// race (no CAS, a lock reads stale for up to 60 s, and a run killed at the 900 s
// ceiling never deletes it). Under level-triggering the clobbered value's
// alertDetails reverts to the old set, which differs from current, so the next run
// re-selects the beach and re-raises it. Repair is automatic and bounded at one
// cadence.
//
// What that costs, since it is the Worker's one recurring O(N) term: the scan
// reads both key families for every flag-worthy beach on every run, and KV bills
// a bulk read per key, so 144 runs a day is 288N key-reads a day — about 320k at
// today's 1,102 rows, 2.9M at 10k and 29M at 100k, spent to find the handful of
// beaches whose alert set actually moved. There is no cheaper selection: the
// standing alert set lives in the "flag:" value. TODO.md carries the figure as
// the thing that decides when the endpoint needs tiles rather than one artifact.
//
// It writes exactly two things: "flag:" for the beaches it recomputed, and the map
// directory. Never "wqfloor:" (the hourly stays its single writer, so expiry
// remains the only way a cleared advisory is withdrawn), never "official:", never
// a flag_history row (it scrapes no officials, so it has no pair to log), and
// above all never recompute_updated, which is runFlagRecompute's rotation cursor
// and single-writer by contract.
async function runAlertRefresh(env) {
  const startedMs = Date.now();
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const budget = fastRunBudget(env);
  const candidates = [];
  let written = 0;
  let raised = 0;
  let lowered = 0;
  let skipNoStanding = 0;
  let skipNoSeal = 0;
  let skipAuthority = 0;
  let skipLease = 0;
  let skipStaleLower = 0;
  let skipFeedLower = 0;
  let skipCanadaLower = 0;
  let skipSuperseded = 0;
  let capped = false;

  try {
    // Step 1: one full-table statement, the same one the artifact builder needs
    // anyway. No zone IN list, no bind chunking and no marine_zone index: zone
    // matching is a Map lookup per beach in memory.
    const rowsResult = await env.DB.prepare(MAP_DIRECTORY_SQL).all();
    const rows = rowsResult.results || [];

    // Step 2: four national fetches, each in its own try/catch and each already
    // bounded by its client's timeoutMs. Nothing else is fetched — no SRF, no
    // wqFloor scrape, no official scrape, no "waveinput:" read — so a 10-minute
    // cadence costs county health departments and Ontario Parks nothing, and
    // there is no second source of truth for any non-alert input.
    let nationalAlerts = null;
    try {
      nationalAlerts = await fetchAllActiveAlerts();
    } catch (err) {
      console.log("index: alert refresh nws alerts fetch threw: " + err.message);
      nationalAlerts = null;
    }
    let alertCount = null;
    try {
      alertCount = await fetchActiveAlertCount();
    } catch (err) {
      console.log("index: alert refresh nws alert count fetch threw: " + err.message);
      alertCount = null;
    }
    let ecccAlerts = null;
    try {
      ecccAlerts = await fetchActiveEcccAlerts(nowIso);
    } catch (err) {
      console.log("index: alert refresh eccc alerts fetch threw: " + err.message);
      ecccAlerts = null;
    }
    let ecccMarineAlerts = null;
    try {
      ecccMarineAlerts = await fetchActiveEcccMarineAlerts(nowIso);
    } catch (err) {
      console.log("index: alert refresh eccc marine alerts fetch threw: " + err.message);
      ecccMarineAlerts = null;
    }

    // Step 3: the feed integrity gate, entirely intra-run. fetchAllActiveAlerts
    // cannot distinguish a genuinely quiet nation from a 200 whose schema drifted
    // — both yield alerts: [] — so the count endpoint is the independent view
    // that separates them. A parse materially short of the API's own total is
    // truncation or drift whatever its magnitude, which is the gap every
    // fraction-based rail leaves open.
    //
    // A missing feed is never evidence of clearing: usFeedUsable false excludes
    // every US beach outright, and usLowerAllowed false keeps raises at
    // 10-minute latency while lowerings wait for the hourly, which is the status
    // quo. The ECCC rule is stricter than the hourly's deliberate
    // proceed-on-partial-success, because at 6x cadence a marine-collection
    // outage would repeatedly recompute Canadian beaches with the marine events
    // missing and drop a live "gale warning" red to a wave-height green.
    //
    // The count check alone proves only that the whole population arrived. The
    // parse-drop check is what proves the parse understood it: featureCount is
    // raw, so a drift that renames properties.event or restructures the zone
    // fields would otherwise pass the count check with alerts: [] and license a
    // nationwide clear-down.
    const usFeedUsable = nationalAlerts !== null;
    const usLowerAllowed =
      usFeedUsable &&
      nationalAlerts.truncated === false &&
      alertCount !== null &&
      nationalAlerts.featureCount + ALERT_COUNT_SLACK >= alertCount.total &&
      nationalAlerts.featureCount - nationalAlerts.alerts.length <= ALERT_PARSE_DROP_MAX;
    const ecccUsable = ecccAlerts !== null && ecccMarineAlerts !== null;

    const alertsMap = new Map();
    if (usFeedUsable) {
      // A plain loop into a Set, never a concat reduce: this walks the whole
      // flag-worthy table rather than one capped run, and the quadratic form
      // costs seconds of a sub-hourly cron's 30 s CPU allowance past 20k rows.
      const zoneSet = new Set();
      for (const row of rows) {
        if (row.nws_zone !== null && row.nws_zone !== undefined) {
          zoneSet.add(row.nws_zone);
        }
        if (row.marine_zone !== null && row.marine_zone !== undefined) {
          zoneSet.add(row.marine_zone);
        }
      }
      for (const zone of zoneSet) {
        const matched = nwsAlertsForZone(nationalAlerts.alerts, zone);
        alertsMap.set(zone, {
          events: matched.events,
          details: matched.details,
          sourceUrl: alertsUrlForZone(zone)
        });
      }
    }
    const alertCtx = {
      alertsMap: alertsMap,
      ecccAlerts: ecccAlerts,
      ecccMarineAlerts: ecccMarineAlerts
    };

    // Step 4: one scan of the flag-worthy set, selecting as it goes. onRow runs
    // synchronously while the standing estimate is still in hand, so selection
    // costs no second read. Every rejection is a SKIP that leaves the standing
    // value untouched — there is no path here in which estimateFlag is called
    // with a null substituted for a sealed input.
    function onRow(row, entry, standing) {
      if (!standing) {
        // No standing value: nothing to compare against and no lease to inherit,
        // so the hourly publishes this beach's first estimate.
        skipNoStanding = skipNoStanding + 1;
        return;
      }
      const signals = signalsFromStanding(standing);
      if (signals === null) {
        // Written before the seal shipped, or carrying another seal version.
        skipNoSeal = skipNoSeal + 1;
        return;
      }
      const isUs = (row.nws_zone || row.marine_zone) ? true : false;
      const isCa = !isUs && row.eccc_zone ? true : false;
      if ((!isUs && !isCa) || (isUs && !usFeedUsable) || (isCa && !ecccUsable)) {
        skipAuthority = skipAuthority + 1;
        return;
      }
      const updatedMs = Date.parse(standing.updated);
      if (Number.isNaN(updatedMs)) {
        skipNoSeal = skipNoSeal + 1;
        return;
      }
      // Supersession check, against D1's strongly consistent stamp rather than
      // KV's eventually consistent one. The hourly writes "flag:" with
      // updated = its run instant and stamps recompute_updated with that same
      // instant, so a standing value older than the stamp is either a stale KV
      // replica of a beach the hourly has already rewritten or a put that failed.
      // Recomputing either one would republish an hour-old bundle over the
      // hourly's newer decision, and none of the lowering rails would see it:
      // they compare against this same superseded value. Skipping is the status
      // quo the hourly already owns.
      const stampMs = row.recompute_updated ? Date.parse(row.recompute_updated) : NaN;
      if (!Number.isNaN(stampMs) && stampMs > updatedMs) {
        skipSuperseded = skipSuperseded + 1;
        return;
      }
      const ageSec = (nowMs - updatedMs) / 1000;
      if (ageSec < 0 || FLAG_TTL_SECONDS - ageSec < FAST_MIN_REMAINING_TTL_SECONDS) {
        skipLease = skipLease + 1;
        return;
      }
      const alertPart = buildAlertInputs(row, alertCtx);
      // Set inequality selects; estimateFlag decides. Comparing severities here
      // would reimplement ALERT_PRECEDENCE outside rules.js, and a "has any
      // alert" test would miss a zone swapping Small Craft Advisory for Gale
      // Warning, or losing one of two alerts.
      //
      // signals.alertsResolved false is the repair for a failed hourly alert
      // fetch: that run passed alerts null, losing both the short-circuit and the
      // floors, and its echoed alertDetails is [] — indistinguishable from
      // "checked, none active" without the sealed boolean.
      const selected =
        alertPart.alertsResolved === false ||
        signals.alertsResolved === false ||
        eventKey(alertPart.alerts) !== eventKey(standingAlertEvents(standing));
      if (!selected) {
        return;
      }
      if (candidates.length >= FAST_MAX_BEACHES_PER_RUN) {
        // The write cap is checked inside the pool, far too late to bound this
        // list: a nationwide event moves most zones' alert sets at once, and one
        // retained candidate per row would carry the whole table's parsed KV
        // payloads into the 128 MB isolate. Beaches past the cap keep their old
        // standing alert set, so the next run re-selects them.
        capped = true;
        return;
      }
      // Only the standing color survives into the candidate; the parsed standing
      // payload goes out of scope with its chunk, which is the streaming
      // discipline scanMapDirectory documents.
      candidates.push({
        row: row,
        standingColor: standing.color,
        signals: signals,
        alertPart: alertPart,
        updatedMs: updatedMs,
        isCa: isCa
      });
    }

    const scan = await scanMapDirectory(
      env,
      rows,
      makeDeadline(Date.now(), mapScanBudgetMs(env)),
      null,
      onRow
    );

    let mapdirState = "truncated";
    if (scan !== null) {
      // Step 5: recompute and write. Unconditional for a selected beach that
      // clears its rails, not gated on a strict color change: selection already
      // means the alert set moved, so the reason string, alertDetails and sources
      // are stale by definition, and a color-only gate would leave the detail
      // page citing an expired alert for up to an hour.
      await runPool(candidates, KV_WRITE_CONCURRENCY, async function (candidate) {
        if (written >= FAST_MAX_BEACHES_PER_RUN) {
          capped = true;
          return;
        }
        const row = candidate.row;
        const next = estimateFlag(
          buildEstimateInputs(row, candidate.alertPart, candidate.signals)
        );
        const standingRank = SEVERITY_RANK[candidate.standingColor] !== undefined
          ? SEVERITY_RANK[candidate.standingColor] : 0;
        const nextRank = SEVERITY_RANK[next.color] !== undefined
          ? SEVERITY_RANK[next.color] : 0;
        // Three rails, on the lowering direction only. A lowering is published
        // only from evidence this run could verify: Canada is raise-only for want
        // of a count endpoint on either GeoMet collection, the US needs the count
        // cross-check, and neither authority may lower on inputs old enough that
        // the product itself would mark them stale.
        if (nextRank < standingRank) {
          if (candidate.isCa) {
            skipCanadaLower = skipCanadaLower + 1;
            return;
          }
          if (!usLowerAllowed) {
            skipFeedLower = skipFeedLower + 1;
            return;
          }
          if (Date.now() - candidate.updatedMs >= FAST_LOWER_MAX_SEAL_AGE_MS) {
            skipStaleLower = skipStaleLower + 1;
            return;
          }
        }
        // The remaining lease, never a fresh one: the republished key expires no
        // later than the hourly's own write would have, so this cron cannot keep
        // any flag alive past the rotation that is supposed to judge it. Combined
        // with next.updated carrying the standing instant rather than the run's
        // clock, it is lifetime-neutral and staleness-neutral — it can move a
        // color and nothing else.
        const ageSec = Math.floor((Date.now() - candidate.updatedMs) / 1000);
        const ttl = FLAG_TTL_SECONDS - ageSec;
        if (ttl < FAST_MIN_REMAINING_TTL_SECONDS) {
          skipLease = skipLease + 1;
          return;
        }
        const stored = Object.assign({}, next, {
          estimateInputs: sealFromSignals(candidate.signals, candidate.alertPart)
        });
        await env.FLAGS.put("flag:" + row.id, JSON.stringify(stored), { expirationTtl: ttl });
        written = written + 1;
        if (nextRank > standingRank) {
          raised = raised + 1;
        } else if (nextRank < standingRank) {
          lowered = lowered + 1;
        }
        // Patch the scan's own entry rather than re-reading the key KV has no
        // read-your-own-writes guarantee for.
        const entry = scan.byId.get(row.id);
        if (entry) {
          entry.estColor = next.color;
          entry.estUpdated = next.updated;
        }
      }, makeDeadline(Date.now(), budget.writeDeadlineMs));

      // Step 6: publish the directory as a full rebuild from this scan, with the
      // entries this run wrote patched in place. Not a read-modify-write of the
      // published key: both writers derive the whole value from KV truth, so a
      // lost update discards one truth-derived build for another, bounded at one
      // build period, with no torn state and nothing to reconcile.
      mapdirState = await putMapDirectory(env, scan.entries, nowIso)
        ? String(scan.entries.length)
        : "failed";
    }

    // skipStaleLower= and feed=unverified are the operator trip-wires: the first
    // means the hourly rotation has fallen behind, the second that the count
    // cross-check is failing and US clear-down has silently reverted to hourly
    // latency.
    const feedState = usFeedUsable ? (usLowerAllowed ? "complete" : "unverified") : "down";
    console.log(
      "index: alert refresh complete, rows=" + String(rows.length) +
      " candidates=" + String(candidates.length) +
      " written=" + String(written) +
      " raised=" + String(raised) +
      " lowered=" + String(lowered) +
      " skipNoStanding=" + String(skipNoStanding) +
      " skipNoSeal=" + String(skipNoSeal) +
      " skipAuthority=" + String(skipAuthority) +
      " skipLease=" + String(skipLease) +
      " skipStaleLower=" + String(skipStaleLower) +
      " skipFeedLower=" + String(skipFeedLower) +
      " skipCanadaLower=" + String(skipCanadaLower) +
      " skipSuperseded=" + String(skipSuperseded) +
      " capped=" + (capped ? "1" : "0") +
      " feed=" + feedState +
      " features=" + String(nationalAlerts === null ? "none" : nationalAlerts.featureCount) +
      " parsed=" + String(nationalAlerts === null ? "none" : nationalAlerts.alerts.length) +
      " count=" + String(alertCount === null ? "none" : alertCount.total) +
      " eccc=" + (ecccUsable ? "ok" : "down") +
      " mapdir=" + mapdirState +
      " elapsedMs=" + String(Date.now() - startedMs)
    );
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
    // stamped=0 is a systemic KV write outage.
    const truncated = writeReached < beaches.length || unattempted.size > 0;
    console.log(
      "index: water temp refresh complete, beaches=" + String(beaches.length) +
      " stamped=" + String(stampedCount) +
      " reached=" + String(writeReached) +
      " unattempted=" + String(unattempted.size) +
      " failures=" + String(writeFailureCount) +
      " watertemp=" + String(waterTempCount) +
      " truncated=" + (truncated ? "yes" : "no") +
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
const ECCC_ATTEMPTS_BUMP_SQL = "UPDATE beaches SET eccc_attempts = eccc_attempts + 1 WHERE id = ?1";

// NWS point enrichment (own cron, 4x daily): beaches with nws_zone NULL get
// their forecast zone and gridpoint URL from api.weather.gov/points. A beach
// without nws_zone skips rules steps 1-2 (alerts, SRF rip risk) and carries an
// explicit "NWS alerts not yet available for this beach" caveat, so draining this
// queue fast is a safety property, not just throughput. Ordering is fewest failed
// attempts first, then last_viewed, then RANDOM(): ordering by id instead drains
// every osm-node-* row before any osm-way-* row, leaving way-based beaches blind
// to active alerts for weeks (TODO.md).
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
      "index: nws enrichment complete, attempted=" + String(toEnrich.length) +
      " enriched=" + String(enriched) +
      " failures=" + String(enrichmentFailures) +
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
