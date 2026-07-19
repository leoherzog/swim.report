import { handleRequest } from "./router.js";
import { renderErrorPage } from "./frontend/render.js";
import { estimateFlag } from "./rules.js";
// mergeBeachRows (and its park-association / unnamed-suffix helpers) moved to
// src/discovery.js so the offline batch discovery job can reuse it verbatim.
// Re-exported below so test/parkContainment.test.js keeps importing it from here.
import { mergeBeachRows } from "./discovery.js";
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
  fetchEcccZoneName,
  ECCC_ALERTS_INFO_URL
} from "./clients/eccc.js";
import { parseRipCurrentRisk } from "./clients/srfParser.js";
import { fetchWaveHeightsFt, fetchWinds } from "./clients/openMeteo.js";
import {
  fetchGlcfsWaveHeightsFt,
  GLCFS_WAVE_MODEL,
  SEAGULL_INFO_URL
} from "./clients/glerl.js";
import { FLAG_WORTHY_WATER_SQL } from "./waterClass.js";
import { fetchNearestWebcam } from "./clients/windyWebcams.js";
import { findScraper, scrapeOfficialFlagFromResult } from "./officialSources/index.js";
import { updateScraperHealth } from "./scraperHealth.js";

// Re-export the discovery merge helper from its new home (src/discovery.js) so
// existing importers (test/parkContainment.test.js) keep resolving it here.
export { mergeBeachRows };

// Must cover the whole beaches table in ONE run: the recompute rotation
// (ORDER BY recompute_updated) combined with the 2 h KV TTL means any beach
// not reached every other run shows "no data" until its next turn. The pilot
// region holds ~613 rows; at 1000 the full table recomputes hourly (~900
// subrequests worst case, well under the paid plan's 10,000/invocation).
// Real pagination is still required for nationwide scale-out (TODO.md).
const MAX_BEACHES_PER_RUN = 1000;
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
const OPEN_METEO_BATCH = 100;
const OPEN_METEO_CONCURRENCY = 2;
const OPEN_METEO_BATCH_GAP_MS = 12000;
const OPEN_METEO_RETRY_MS = 60000;
const KV_TTL_SECONDS = 7200;
// Wave inputs and the WaveSeries strip data are refreshed on the 6-hourly wave
// cron, so their KV must outlive the gap between runs (plus slack for a failed
// run): a 7 h TTL guarantees a beach's last-good wave data is still readable at
// the next refresh, so a transient upstream 429 leaves the strip showing
// slightly older — but still model-current — data instead of blanking it.
const WAVE_DATA_TTL_SECONDS = 25200;
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
// Webcam hydration (daily webcam cron): nearest Windy webcam player per
// beach. Webcams appear and disappear slowly, so rows are rechecked on a
// 14-day cadence; 100 lookups per night drains the pilot backlog in a few
// nights and keeps the recheck cycle comfortably ahead of the beach count.
// Deliberately NOT raised alongside the NWS limit — Windy's free tier
// publishes no quota and 100/night is polite guesswork (TODO.md).
const WEBCAM_ENRICHMENT_LIMIT = 100;
const WEBCAM_RECHECK_MS = 14 * 86400000;

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

function waveSourceLabel(model) {
  if (Object.prototype.hasOwnProperty.call(WAVE_MODEL_LABELS, model)) {
    return WAVE_MODEL_LABELS[model];
  }
  return "Wave Forecast";
}

// Buoy readings come from the GLOS Seagull network, so their source entry
// carries the human-readable Seagull portal url, not the Open-Meteo docs (and
// never the raw API request).
function waveSourceUrl(model) {
  if (model === GLCFS_WAVE_MODEL) {
    return SEAGULL_INFO_URL;
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
// without a code change. Numeric env overrides only.
function batchTiming(env) {
  const gap = env && typeof env.OPEN_METEO_BATCH_GAP_MS === "number"
    ? env.OPEN_METEO_BATCH_GAP_MS : OPEN_METEO_BATCH_GAP_MS;
  const retry = env && typeof env.OPEN_METEO_RETRY_MS === "number"
    ? env.OPEN_METEO_RETRY_MS : OPEN_METEO_RETRY_MS;
  const concurrency = env && typeof env.OPEN_METEO_CONCURRENCY === "number"
    ? env.OPEN_METEO_CONCURRENCY : OPEN_METEO_CONCURRENCY;
  return { gapMs: gap, retryMs: retry, concurrency: Math.max(1, concurrency) };
}

// Fetch one batch, retrying once after a backoff when the first attempt returns
// null. The clients collapse a 429 / 5xx / network error to null (their
// data-or-null contract), so a null here is exactly the transient-throttle case
// the backoff is meant to ride out. A second null gives up (onBatchFail).
async function fetchBatchWithRetry(batch, fetchFn, retryMs) {
  const first = await fetchFn(batch);
  if (first !== null) {
    return first;
  }
  await sleep(retryMs);
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
// upstream-specific behavior.
async function batchByBeach(points, fetchFn, onEntry, onBatchFail, timing) {
  const t = timing || { gapMs: OPEN_METEO_BATCH_GAP_MS, retryMs: OPEN_METEO_RETRY_MS, concurrency: OPEN_METEO_CONCURRENCY };
  const batches = chunk(points, OPEN_METEO_BATCH);
  for (let start = 0; start < batches.length; start = start + t.concurrency) {
    if (start > 0) {
      await sleep(t.gapMs);
    }
    const wave = batches.slice(start, start + t.concurrency);
    const settled = await Promise.allSettled(
      wave.map(function (batch) { return fetchBatchWithRetry(batch, fetchFn, t.retryMs); })
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

  try {
    const beachesResult = await env.DB.prepare(
      "SELECT * FROM beaches WHERE " + FLAG_WORTHY_WATER_SQL +
      " ORDER BY recompute_updated ASC, id ASC LIMIT " + String(MAX_BEACHES_PER_RUN)
    ).all();
    const beaches = beachesResult.results || [];

    // Step 3: alerts — ONE national fetch, matched to the run's distinct
    // nws_zone values locally (nwsAlertsForZone). Costs a single subrequest
    // regardless of zone count, so nationwide scale-out never multiplies
    // alert calls. A failed fetch maps every zone to null (per-beach
    // alertsCheckable stays true, mirroring the old per-zone failure mode).
    // Each zone's entry keeps the zone-scoped provenance URL for its beaches'
    // source entries.
    const zones = Array.from(
      new Set(
        beaches
          .map(function (b) { return b.nws_zone; })
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
    if (ecccBeaches.length > 0) {
      try {
        ecccAlerts = await fetchActiveEcccAlerts(nowIso);
      } catch (err) {
        console.log("index: eccc alerts fetch threw: " + err.message);
        ecccAlerts = null;
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

    // Step 6: per-beach estimate, isolated failures.
    for (const beach of beaches) {
      try {
        const sources = [];

        let alerts = null;
        let alertDetails = null;
        if (beach.nws_zone) {
          const alertEntry = alertsMap.get(beach.nws_zone);
          if (alertEntry) {
            alerts = alertEntry.events;
            alertDetails = alertEntry.details;
            sources.push({
              label: "NWS Alerts",
              url: alertEntry.sourceUrl
            });
          }
        } else if (beach.eccc_zone && ecccAlerts !== null) {
          // Canadian beach: match the run's single ECCC fetch to this point
          // via the alert-region polygons. A successful fetch with zero
          // containing polygons is a real "no active alerts" ([]), exactly
          // like an empty NWS zone response.
          const matched = ecccAlertsForPoint(ecccAlerts.alerts, beach.lat, beach.lon);
          alerts = matched.events;
          alertDetails = matched.details;
          sources.push({
            label: "Environment Canada Alerts",
            url: ECCC_ALERTS_INFO_URL
          });
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
          alertsCheckable: (beach.nws_zone || beach.eccc_zone) ? true : false,
          ripCurrentRisk: ripCurrentRisk,
          waveHeightFt: waveHeightFt,
          windSpeedMph: windSpeedMph,
          windGustMph: windGustMph,
          sources: sources,
          updated: nowIso
        };

        const estimate = estimateFlag(inputs);
        await env.FLAGS.put(
          "flag:" + beach.id,
          JSON.stringify(estimate),
          { expirationTtl: KV_TTL_SECONDS }
        );

        // The detail-page WaveSeries ("waves:" + id) is written by the wave
        // cron, not here — this loop only reads wave inputs.
        estimatesByBeach.set(beach.id, {
          color: estimate.color,
          rulesVersion: estimate.rules_version
        });
        estimateCount = estimateCount + 1;
      } catch (err) {
        failureCount = failureCount + 1;
        console.log("index: flag estimate failed for beach " + beach.id + ": " + err.message);
      }
    }

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
        // was never invoked is never counted as failing. Costs one KV get +
        // one KV put per MATCHED scraper per run — at most a handful of extra
        // subrequests against the per-invocation budget (PLAN.md section 7).
        // The "scraperhealth:" key is written WITHOUT expirationTtl so the
        // consecutive-null streak persists across runs.
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

        if (result === null) {
          continue;
        }
        for (const beach of group.beaches) {
          const flag = scrapeOfficialFlagFromResult(beach, group.scraper, result);
          if (flag !== null) {
            await env.FLAGS.put(
              "official:" + beach.id,
              JSON.stringify(flag),
              { expirationTtl: KV_TTL_SECONDS }
            );
            officialsByBeach.set(beach.id, {
              color: flag.color,
              source: flag.scraperId || group.scraper.id
            });
            officialCount = officialCount + 1;
          }
        }
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

    console.log(
      "index: flag recompute complete, beaches=" + String(beaches.length) +
      " estimates=" + String(estimateCount) +
      " officials=" + String(officialCount) +
      " history=" + String(historyCount) +
      " failures=" + String(failureCount)
    );
  } catch (err) {
    console.log("index: flag recompute failed: " + err.message);
  }
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
async function runWaveRefresh(env) {
  const nowIso = new Date().toISOString();
  // Anchor the series start to the top of the run's UTC hour: hoursFt[0] is the
  // current-hour forecast, so the strip trims from the hour boundary.
  const wavesStartDate = new Date(Date.parse(nowIso));
  wavesStartDate.setUTCMinutes(0, 0, 0);
  const wavesStartIso = wavesStartDate.toISOString();
  const timing = batchTiming(env);
  let inputCount = 0;
  let seriesCount = 0;

  try {
    const beachesResult = await env.DB.prepare(
      "SELECT id, lat, lon FROM beaches WHERE " + FLAG_WORTHY_WATER_SQL +
      " ORDER BY recompute_updated ASC, id ASC LIMIT " + String(MAX_BEACHES_PER_RUN)
    ).all();
    const beaches = beachesResult.results || [];

    // Step 1: waves (marine), paced.
    const waveResults = new Map();
    const wavePoints = beaches.map(function (b) {
      return { beachId: b.id, lat: b.lat, lon: b.lon };
    });
    await batchByBeach(
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

    // Step 2: Great Lakes buoy gap-filler. Open-Meteo's wave models commonly
    // return masked/null cells on the Great Lakes; for beaches still wave-null,
    // ask the GLOS Seagull buoy client. One call — the client dedups platform
    // fetches internally and caps them, so this stays well under the subrequest
    // budget even on a fully wave-null run.
    const glcfsPoints = waveNullPoints(beaches, waveResults);
    if (glcfsPoints.length > 0) {
      try {
        const glcfsData = await fetchGlcfsWaveHeightsFt(glcfsPoints, nowIso);
        if (glcfsData !== null) {
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

    // Step 3: wind, only for beaches whose wave height is still null (the wind
    // fallback the estimate uses when every wave model is null). Recomputed
    // fresh — step 2 may have gap-filled some beaches out of the wave-null set.
    const windResults = new Map();
    const windPoints = waveNullPoints(beaches, waveResults);
    await batchByBeach(
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

    // Step 4: persist per-beach wave inputs (+ the strip series), isolated
    // failures. A beach whose marine fetch failed AND got no buoy fill is
    // SKIPPED so its last-good "waveinput:"/"waves:" KV survives the TTL rather
    // than being overwritten by a transient null (graceful degradation).
    for (const beach of beaches) {
      try {
        const waveEntry = waveResults.get(beach.id);
        const windEntry = windResults.get(beach.id);
        const waveHeightFt = waveEntry ? waveEntry.waveHeightFt : null;
        const windSpeedMph = windEntry && typeof windEntry.windSpeedMph === "number"
          ? windEntry.windSpeedMph : null;
        const windGustMph = windEntry && typeof windEntry.windGustMph === "number"
          ? windEntry.windGustMph : null;

        // hoursFt === null is the batch-failure sentinel (vs. an array of nulls
        // for a fetched-but-masked cell). A failed marine fetch with no buoy
        // reading has nothing trustworthy to record — leave the old KV alone.
        const marineFetchFailed = !waveEntry || waveEntry.hoursFt === null;
        if (waveHeightFt === null && marineFetchFailed) {
          continue;
        }
        // Fetched cleanly but nothing usable (masked, no buoy, no wind) — also
        // skip; the old key expires on its own.
        if (waveHeightFt === null && windSpeedMph === null && windGustMph === null) {
          continue;
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
        inputCount = inputCount + 1;

        // WaveSeries for the detail-page 24 h strip: only when the entry carries
        // a real hourly series with at least one finite cell (a masked series or
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
          seriesCount = seriesCount + 1;
        }
      } catch (err) {
        console.log("index: wave input write failed for beach " + beach.id + ": " + err.message);
      }
    }

    console.log(
      "index: wave refresh complete, beaches=" + String(beaches.length) +
      " inputs=" + String(inputCount) +
      " series=" + String(seriesCount)
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
// Increment a beach's enrichment_attempts counter so permanently-failing
// points (e.g. non-US shoreline api.weather.gov 404s) eventually park out of
// the queue. Self-isolating: a D1 write failure here is logged and swallowed
// so it never aborts the enrichment loop.
async function bumpAttempts(env, beachId) {
  try {
    await env.DB.prepare(
      "UPDATE beaches SET enrichment_attempts = enrichment_attempts + 1 WHERE id = ?1"
    ).bind(beachId).run();
  } catch (updateErr) {
    console.log("index: nws enrichment attempt bump failed for " + beachId + ": " + updateErr.message);
  }
}

async function runNwsEnrichment(env) {
  let enriched = 0;
  let enrichmentFailures = 0;

  try {
    const needsEnrichment = await env.DB.prepare(
      "SELECT id, lat, lon FROM beaches WHERE nws_zone IS NULL AND enrichment_attempts < " +
      String(NWS_ENRICHMENT_MAX_ATTEMPTS) + " AND " + FLAG_WORTHY_WATER_SQL +
      " ORDER BY enrichment_attempts ASC, RANDOM() LIMIT " +
      String(NWS_ENRICHMENT_LIMIT)
    ).all();
    const toEnrich = needsEnrichment.results || [];
    for (const beach of toEnrich) {
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
          await bumpAttempts(env, beach.id);
        }
      } catch (err) {
        enrichmentFailures = enrichmentFailures + 1;
        console.log("index: nws enrichment failed for " + beach.id + ": " + err.message);
        await bumpAttempts(env, beach.id);
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
async function bumpEcccAttempts(env, beachId) {
  try {
    await env.DB.prepare(
      "UPDATE beaches SET eccc_attempts = eccc_attempts + 1 WHERE id = ?1"
    ).bind(beachId).run();
  } catch (updateErr) {
    console.log("index: eccc enrichment attempt bump failed for " + beachId + ": " + updateErr.message);
  }
}

async function runEcccEnrichment(env) {
  let enriched = 0;
  let enrichmentFailures = 0;

  try {
    const needsEnrichment = await env.DB.prepare(
      "SELECT id, lat, lon FROM beaches WHERE nws_zone IS NULL AND enrichment_attempts >= " +
      String(NWS_ENRICHMENT_MAX_ATTEMPTS) + " AND eccc_zone IS NULL AND eccc_attempts < " +
      String(ECCC_ENRICHMENT_MAX_ATTEMPTS) + " AND " + FLAG_WORTHY_WATER_SQL +
      " ORDER BY eccc_attempts ASC, RANDOM() LIMIT " +
      String(ECCC_ENRICHMENT_LIMIT)
    ).all();
    const toEnrich = needsEnrichment.results || [];
    for (const beach of toEnrich) {
      try {
        const zone = await fetchEcccZoneName(beach.lat, beach.lon);
        if (zone !== null) {
          await env.DB.prepare(
            "UPDATE beaches SET eccc_zone = ?1 WHERE id = ?2"
          ).bind(zone.zoneName, beach.id).run();
          enriched = enriched + 1;
        } else {
          // fetchEcccZoneName returns null on any failure AND on a clean
          // zero-region answer (a US point) — both count an attempt so
          // unresolvable rows eventually park.
          enrichmentFailures = enrichmentFailures + 1;
          await bumpEcccAttempts(env, beach.id);
        }
      } catch (err) {
        enrichmentFailures = enrichmentFailures + 1;
        console.log("index: eccc enrichment failed for " + beach.id + ": " + err.message);
        await bumpEcccAttempts(env, beach.id);
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
      " ORDER BY webcam_checked ASC, id ASC LIMIT " + String(WEBCAM_ENRICHMENT_LIMIT)
    ).bind(webcamCutoffIso).all();
    const webcamDue = webcamDueResult.results || [];
    for (const beach of webcamDue) {
      try {
        const result = await fetchNearestWebcam(beach.lat, beach.lon, env.WINDY_WEBCAM_API_TOKEN);
        if (result === null) {
          webcamFailures = webcamFailures + 1;
          continue;
        }
        webcamsChecked = webcamsChecked + 1;
        if (result.webcam !== null) {
          webcamsFound = webcamsFound + 1;
          await env.DB.prepare(
            "UPDATE beaches SET webcam_id = ?1, webcam_title = ?2, webcam_player_url = ?3, " +
            "webcam_checked = ?4 WHERE id = ?5"
          ).bind(
            result.webcam.webcamId,
            result.webcam.title,
            result.webcam.playerUrl,
            nowIso,
            beach.id
          ).run();
        } else {
          await env.DB.prepare(
            "UPDATE beaches SET webcam_id = NULL, webcam_title = NULL, " +
            "webcam_player_url = NULL, webcam_checked = ?1 WHERE id = ?2"
          ).bind(nowIso, beach.id).run();
        }
      } catch (err) {
        webcamFailures = webcamFailures + 1;
        console.log("index: webcam hydration failed for " + beach.id + ": " + err.message);
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
  "0 * * * *": { run: runFlagRecompute, label: "flag recompute" },
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
