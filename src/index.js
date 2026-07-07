import { handleRequest } from "./router.js";
import { estimateFlag } from "./rules.js";
import {
  fetchActiveAlertEvents,
  wfoFromGridUrl,
  fetchLatestSrfText,
  fetchPointMetadata
} from "./clients/nws.js";
import { parseRipCurrentRisk } from "./clients/srfParser.js";
import { fetchWaveHeightsFt, fetchWinds } from "./clients/openMeteo.js";
import {
  fetchGlcfsWaveHeightsFt,
  GLCFS_WAVE_MODEL,
  SEAGULL_INFO_URL
} from "./clients/glerl.js";
import { fetchBeaches, fetchParkBeaches } from "./clients/overpass.js";
import { fetchNearestWebcam } from "./clients/windyWebcams.js";
import { findScraper, scrapeOfficialFlagFromResult } from "./officialSources/index.js";
import { updateScraperHealth } from "./scraperHealth.js";

// Must cover the whole beaches table in ONE run: the recompute rotation
// (ORDER BY recompute_updated) combined with the 2 h KV TTL means any beach
// not reached every other run shows "no data" until its next turn. The pilot
// region holds ~613 rows; at 1000 the full table recomputes hourly (~900
// subrequests worst case, well under the paid plan's 10,000/invocation).
// Real pagination is still required for nationwide scale-out (TODO.md).
const MAX_BEACHES_PER_RUN = 1000;
const OPEN_METEO_BATCH = 50;
const KV_TTL_SECONDS = 7200;
const PILOT_BBOX = { minLon: -87.6, minLat: 41.6, maxLon: -82.3, maxLat: 46.6 };
// Per RUN of the dedicated enrichment cron (4x daily = up to 300 points/day).
// api.weather.gov publishes no numeric rate limit (it 429s with Retry-After
// when unhappy); 75 sequential polite requests per run is well within
// reasonable use and drains a freshly discovered region in days, not weeks.
const NWS_ENRICHMENT_LIMIT = 75;
// Rows that fail fetchPointMetadata this many times are permanently parked and
// no longer queued for enrichment — otherwise non-US points (Ontario shoreline
// swept in by PILOT_BBOX) that api.weather.gov 404s forever would occupy the
// whole nightly batch and starve US beaches (TODO.md).
const NWS_ENRICHMENT_MAX_ATTEMPTS = 5;
// Both Overpass queries must never run concurrently with each other (or another
// sync invocation) -- overpass-api.de allows only 2 slots per IP and 429s beyond
// that. A single delayed retry smooths over most transient 429s/timeouts without
// risking overlap, since the retry always fully resolves before the next query
// starts (TODO.md "No Overpass retry inside the daily sync").
const OVERPASS_RETRY_DELAY_MS = 60000;
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
// reading; the url is a page a visitor can read, never the raw API request.
const OPEN_METEO_MARINE_URL = "https://open-meteo.com/en/docs/marine-weather-api";
const OPEN_METEO_FORECAST_URL = "https://open-meteo.com/en/docs";
const WAVE_MODEL_LABELS = {
  "ecmwf_wam025": "ECMWF Wave Forecast via Open-Meteo",
  "ncep_gfswave025": "NOAA GFS Wave Forecast via Open-Meteo",
  "meteofrance_wave": "Météo-France Wave Forecast via Open-Meteo"
};
WAVE_MODEL_LABELS[GLCFS_WAVE_MODEL] = "GLOS Great Lakes Buoy Observations via Seagull";

function waveSourceLabel(model) {
  if (Object.prototype.hasOwnProperty.call(WAVE_MODEL_LABELS, model)) {
    return WAVE_MODEL_LABELS[model];
  }
  return "Wave Forecast via Open-Meteo";
}

// Buoy readings come from the GLOS Seagull network, so their source entry
// links the human-readable Seagull portal, not the Open-Meteo docs (and never
// the raw API request).
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

async function runFlagRecompute(env) {
  const nowIso = new Date().toISOString();
  let estimateCount = 0;
  let officialCount = 0;
  let failureCount = 0;

  try {
    const beachesResult = await env.DB.prepare(
      "SELECT * FROM beaches ORDER BY recompute_updated ASC, id ASC LIMIT " + String(MAX_BEACHES_PER_RUN)
    ).all();
    const beaches = beachesResult.results || [];

    // Step 3: alerts, once per distinct non-null nws_zone.
    const zones = Array.from(
      new Set(
        beaches
          .map(function (b) { return b.nws_zone; })
          .filter(function (z) { return z !== null && z !== undefined; })
      )
    );
    const alertsMap = new Map();
    for (const zone of zones) {
      try {
        const result = await fetchActiveAlertEvents(zone);
        alertsMap.set(zone, result);
      } catch (err) {
        console.log("index: alerts fetch threw for zone " + zone + ": " + err.message);
        alertsMap.set(zone, null);
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

    // Step 5: waves, batched.
    const waveResults = new Map();
    const wavePoints = beaches.map(function (b) {
      return { beachId: b.id, lat: b.lat, lon: b.lon };
    });
    const waveBatches = chunk(wavePoints, OPEN_METEO_BATCH);
    const waveSettled = await Promise.allSettled(
      waveBatches.map(function (batch) { return fetchWaveHeightsFt(batch, nowIso); })
    );
    for (let i = 0; i < waveSettled.length; i = i + 1) {
      const settled = waveSettled[i];
      const batch = waveBatches[i];
      if (settled.status === "fulfilled" && settled.value !== null) {
        const data = settled.value;
        for (const point of batch) {
          const entry = data.results[point.beachId];
          if (entry) {
            waveResults.set(point.beachId, {
              waveHeightFt: entry.waveHeightFt,
              model: entry.model
            });
          }
        }
      } else {
        for (const point of batch) {
          waveResults.set(point.beachId, { waveHeightFt: null, model: null });
        }
        console.log("index: wave batch failed for " + String(batch.length) + " beaches");
      }
    }

    // Step 5b: Great Lakes buoy gap-filler. Open-Meteo's wave models commonly
    // return masked/null cells on the Great Lakes; for beaches still
    // wave-null, ask the GLOS Seagull buoy client (src/clients/glerl.js).
    // Where Open-Meteo answered, behavior is unchanged. One call — the client
    // dedups platform fetches internally and caps them at 62 subrequests
    // (budget math in glerl.js), so the run stays well under the 1000
    // subrequest/invocation limit even on a fully wave-null hour.
    const glcfsPoints = beaches
      .filter(function (b) {
        const w = waveResults.get(b.id);
        return !w || w.waveHeightFt === null;
      })
      .map(function (b) {
        return { beachId: b.id, lat: b.lat, lon: b.lon };
      });
    if (glcfsPoints.length > 0) {
      try {
        const glcfsData = await fetchGlcfsWaveHeightsFt(glcfsPoints, nowIso);
        if (glcfsData !== null) {
          for (const point of glcfsPoints) {
            const entry = glcfsData.results[point.beachId];
            if (entry && entry.waveHeightFt !== null) {
              waveResults.set(point.beachId, {
                waveHeightFt: entry.waveHeightFt,
                model: entry.model
              });
            }
          }
        } else {
          console.log("index: glcfs wave gap-fill failed for " + String(glcfsPoints.length) + " beaches");
        }
      } catch (err) {
        console.log("index: glcfs wave gap-fill threw: " + err.message);
      }
    }

    // Step 6: wind, only for beaches whose wave height is null.
    const windResults = new Map();
    const windPoints = beaches
      .filter(function (b) {
        const w = waveResults.get(b.id);
        return !w || w.waveHeightFt === null;
      })
      .map(function (b) {
        return { beachId: b.id, lat: b.lat, lon: b.lon };
      });
    const windBatches = chunk(windPoints, OPEN_METEO_BATCH);
    const windSettled = await Promise.allSettled(
      windBatches.map(function (batch) { return fetchWinds(batch); })
    );
    for (let i = 0; i < windSettled.length; i = i + 1) {
      const settled = windSettled[i];
      const batch = windBatches[i];
      if (settled.status === "fulfilled" && settled.value !== null) {
        const data = settled.value;
        for (const point of batch) {
          const entry = data.results[point.beachId];
          if (entry) {
            windResults.set(point.beachId, {
              windSpeedMph: entry.windSpeedMph,
              windGustMph: entry.windGustMph
            });
          }
        }
      } else {
        console.log("index: wind batch failed for " + String(batch.length) + " beaches");
      }
    }

    // Step 7: per-beach estimate, isolated failures.
    for (const beach of beaches) {
      try {
        const sources = [];

        let alerts = null;
        if (beach.nws_zone) {
          const alertEntry = alertsMap.get(beach.nws_zone);
          if (alertEntry) {
            alerts = alertEntry.events;
            sources.push({
              label: "NWS active alerts for zone " + beach.nws_zone,
              url: alertEntry.sourceUrl
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
              label: "NWS Surf Zone Forecast (" + srfEntry.productId + ")",
              url: srfEntry.sourceUrl
            });
          }
        }

        let waveHeightFt = null;
        const waveEntry = waveResults.get(beach.id);
        if (waveEntry && waveEntry.waveHeightFt !== null) {
          waveHeightFt = waveEntry.waveHeightFt;
          sources.push({
            label: waveSourceLabel(waveEntry.model),
            url: waveSourceUrl(waveEntry.model)
          });
        }

        let windSpeedMph = null;
        let windGustMph = null;
        const windEntry = windResults.get(beach.id);
        if (windEntry && (windEntry.windSpeedMph !== null || windEntry.windGustMph !== null)) {
          windSpeedMph = windEntry.windSpeedMph;
          windGustMph = windEntry.windGustMph;
          sources.push({
            label: "Wind Forecast via Open-Meteo",
            url: OPEN_METEO_FORECAST_URL
          });
        }

        const inputs = {
          beachId: beach.id,
          alerts: alerts,
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
            officialCount = officialCount + 1;
          }
        }
      } catch (err) {
        console.log("index: official scrape failed: " + err.message);
      }
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
      " failures=" + String(failureCount)
    );
  } catch (err) {
    console.log("index: flag recompute failed: " + err.message);
  }
}

// Pure; exported for tests. Merges the named-beach rows with the
// park-contained beaches (which include unnamed elements):
// - a named beach inside a park gains that park's name as parkName;
// - unnamed beaches are kept only when a park was associated, and only the
//   LARGEST (by bounding-box area) unnamed beach per park element survives —
//   several identical "X State Park" rows would be indistinguishable in the
//   UI, so the pilot keeps one per park (TODO.md notes the limitation). Its
//   display name becomes the park name.
// Returns { rows: [{ id, name, lat, lon, osmId, parkName }], skippedUnnamed }.
export function mergeBeachRows(namedRows, parkBeaches) {
  const byId = new Map();
  for (const row of namedRows) {
    const id = "osm-" + row.osmType + "-" + String(row.osmId);
    byId.set(id, {
      id: id,
      name: row.name,
      lat: row.lat,
      lon: row.lon,
      osmId: row.osmType + "/" + String(row.osmId),
      parkName: null
    });
  }

  let skippedUnnamed = 0;
  const largestUnnamedByPark = new Map();
  for (const beach of parkBeaches) {
    const id = "osm-" + beach.osmType + "-" + String(beach.osmId);
    if (beach.name) {
      const existing = byId.get(id);
      if (existing) {
        existing.parkName = beach.parkName;
      } else {
        byId.set(id, {
          id: id,
          name: beach.name,
          lat: beach.lat,
          lon: beach.lon,
          osmId: beach.osmType + "/" + String(beach.osmId),
          parkName: beach.parkName
        });
      }
      continue;
    }
    if (beach.parkName === null || beach.parkKey === null) {
      skippedUnnamed = skippedUnnamed + 1;
      continue;
    }
    const current = largestUnnamedByPark.get(beach.parkKey);
    if (!current || beach.areaDeg2 > current.areaDeg2) {
      if (current) {
        skippedUnnamed = skippedUnnamed + 1;
      }
      largestUnnamedByPark.set(beach.parkKey, beach);
    } else {
      skippedUnnamed = skippedUnnamed + 1;
    }
  }

  for (const beach of largestUnnamedByPark.values()) {
    const id = "osm-" + beach.osmType + "-" + String(beach.osmId);
    if (!byId.has(id)) {
      byId.set(id, {
        id: id,
        name: beach.parkName,
        lat: beach.lat,
        lon: beach.lon,
        osmId: beach.osmType + "/" + String(beach.osmId),
        parkName: beach.parkName
      });
    }
  }

  return { rows: Array.from(byId.values()), skippedUnnamed: skippedUnnamed };
}

export function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function runOverpassSync(env) {
  const nowIso = new Date().toISOString();
  let processed = 0;

  try {
    let namedRows = await fetchBeaches(PILOT_BBOX);
    if (namedRows === null) {
      console.log(
        "index: fetchBeaches returned null, retrying once after " +
        String(OVERPASS_RETRY_DELAY_MS) + "ms"
      );
      await sleep(OVERPASS_RETRY_DELAY_MS);
      namedRows = await fetchBeaches(PILOT_BBOX);
      if (namedRows === null) {
        console.log("index: overpass sync aborted, fetchBeaches retry also returned null");
        return;
      }
      console.log("index: fetchBeaches retry succeeded");
    }

    // Park containment: failures degrade to the named-only sync and leave
    // every existing park_name untouched (legacy statement below). The retry
    // only starts once the fetchBeaches call (and its own retry) has fully
    // resolved above, so the two Overpass queries never overlap.
    let parkBeaches = await fetchParkBeaches(PILOT_BBOX);
    if (parkBeaches === null) {
      console.log(
        "index: fetchParkBeaches returned null, retrying once after " +
        String(OVERPASS_RETRY_DELAY_MS) + "ms"
      );
      await sleep(OVERPASS_RETRY_DELAY_MS);
      parkBeaches = await fetchParkBeaches(PILOT_BBOX);
      if (parkBeaches === null) {
        console.log("index: fetchParkBeaches retry also returned null, keeping existing park associations");
      } else {
        console.log("index: fetchParkBeaches retry succeeded");
      }
    }

    const merged = mergeBeachRows(namedRows, parkBeaches === null ? [] : parkBeaches);
    const statements = merged.rows.map(function (row) {
      if (parkBeaches === null) {
        return env.DB.prepare(
          "INSERT INTO beaches (id, name, lat, lon, osm_id) VALUES (?1, ?2, ?3, ?4, ?5) " +
          "ON CONFLICT(id) DO UPDATE SET name = ?2, lat = ?3, lon = ?4"
        ).bind(row.id, row.name, row.lat, row.lon, row.osmId);
      }
      return env.DB.prepare(
        "INSERT INTO beaches (id, name, lat, lon, osm_id, park_name) VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
        "ON CONFLICT(id) DO UPDATE SET name = ?2, lat = ?3, lon = ?4, park_name = ?6"
      ).bind(row.id, row.name, row.lat, row.lon, row.osmId, row.parkName);
    });

    if (statements.length > 0) {
      await env.DB.batch(statements);
    }
    processed = statements.length;

    await env.DB.prepare(
      "INSERT INTO sync_meta (key, value, updated) VALUES (?1, ?2, ?3) " +
      "ON CONFLICT(key) DO UPDATE SET value = ?2, updated = ?3"
    ).bind("last_overpass_sync", nowIso, nowIso).run();
    await env.DB.prepare(
      "INSERT INTO sync_meta (key, value, updated) VALUES (?1, ?2, ?3) " +
      "ON CONFLICT(key) DO UPDATE SET value = ?2, updated = ?3"
    ).bind("last_overpass_count", String(processed), nowIso).run();

    const withPark = merged.rows.filter(function (r) { return r.parkName !== null; }).length;
    console.log(
      "index: overpass sync complete, processed=" + String(processed) +
      " with_park=" + String(withPark) +
      " skipped_unnamed=" + String(merged.skippedUnnamed)
    );
  } catch (err) {
    console.log("index: overpass sync failed: " + err.message);
  }
}

// NWS point enrichment (own cron, 4x daily): beaches with nws_zone NULL get
// their forecast zone + gridpoint URL from api.weather.gov/points. A beach
// without nws_zone silently skips rules steps 1-2 (alerts, SRF rip risk) in
// runFlagRecompute, so draining this queue fast is a safety property, not
// just throughput. Ordering: fresh rows (fewest failed attempts) first, then
// RANDOM() — the old ORDER BY id drained every osm-node-* row before any
// osm-way-* row, which left way-based beaches (Holland State Park) blind to
// active alerts for weeks (TODO.md).
async function runNwsEnrichment(env) {
  let enriched = 0;
  let enrichmentFailures = 0;

  try {
    const needsEnrichment = await env.DB.prepare(
      "SELECT id, lat, lon FROM beaches WHERE nws_zone IS NULL AND enrichment_attempts < " +
      String(NWS_ENRICHMENT_MAX_ATTEMPTS) + " ORDER BY enrichment_attempts ASC, RANDOM() LIMIT " +
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
          await env.DB.prepare(
            "UPDATE beaches SET enrichment_attempts = enrichment_attempts + 1 WHERE id = ?1"
          ).bind(beach.id).run();
        }
      } catch (err) {
        enrichmentFailures = enrichmentFailures + 1;
        console.log("index: nws enrichment failed for " + beach.id + ": " + err.message);
        try {
          await env.DB.prepare(
            "UPDATE beaches SET enrichment_attempts = enrichment_attempts + 1 WHERE id = ?1"
          ).bind(beach.id).run();
        } catch (updateErr) {
          console.log("index: nws enrichment attempt bump failed for " + beach.id + ": " + updateErr.message);
        }
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
      "SELECT id, lat, lon FROM beaches WHERE webcam_checked IS NULL OR webcam_checked < ?1 " +
      "ORDER BY webcam_checked ASC, id ASC LIMIT " + String(WEBCAM_ENRICHMENT_LIMIT)
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

export default {
  fetch: function (request, env, ctx) {
    return handleRequest(request, env);
  },
  scheduled: function (controller, env, ctx) {
    if (controller.cron === "0 * * * *") {
      ctx.waitUntil(
        runFlagRecompute(env).catch(function (err) {
          console.log("index: scheduled flag recompute threw: " + err.message);
        })
      );
    } else if (controller.cron === "47 8 * * *") {
      ctx.waitUntil(
        runOverpassSync(env).catch(function (err) {
          console.log("index: scheduled overpass sync threw: " + err.message);
        })
      );
    } else if (controller.cron === "17 3,9,15,21 * * *") {
      ctx.waitUntil(
        runNwsEnrichment(env).catch(function (err) {
          console.log("index: scheduled nws enrichment threw: " + err.message);
        })
      );
    } else if (controller.cron === "31 9 * * *") {
      ctx.waitUntil(
        runWebcamSync(env).catch(function (err) {
          console.log("index: scheduled webcam sync threw: " + err.message);
        })
      );
    } else {
      console.log("index: scheduled invoked with unknown cron: " + controller.cron);
    }
  }
};
