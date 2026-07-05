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
import { fetchBeaches, fetchParkBeaches } from "./clients/overpass.js";
import { findScraper, scrapeOfficialFlag } from "./officialSources/index.js";

const MAX_BEACHES_PER_RUN = 250;
const OPEN_METEO_BATCH = 50;
const KV_TTL_SECONDS = 7200;
const PILOT_BBOX = { minLon: -87.6, minLat: 41.6, maxLon: -82.3, maxLat: 46.6 };
const NWS_ENRICHMENT_LIMIT = 30;

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

function waveSourceLabel(model) {
  if (Object.prototype.hasOwnProperty.call(WAVE_MODEL_LABELS, model)) {
    return WAVE_MODEL_LABELS[model];
  }
  return "Wave Forecast via Open-Meteo";
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
      "SELECT * FROM beaches ORDER BY id LIMIT " + String(MAX_BEACHES_PER_RUN)
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
            url: OPEN_METEO_MARINE_URL
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

    // Step 8: officials, one scrape call per distinct matched scraper.
    const scraperGroups = new Map();
    const beachById = new Map();
    for (const beach of beaches) {
      beachById.set(beach.id, beach);
      const scraper = findScraper(beach);
      if (scraper) {
        if (!scraperGroups.has(scraper.id)) {
          scraperGroups.set(scraper.id, []);
        }
        scraperGroups.get(scraper.id).push(beach.id);
      }
    }
    for (const beachIds of scraperGroups.values()) {
      try {
        const representative = beachById.get(beachIds[0]);
        const result = await scrapeOfficialFlag(representative, nowIso);
        if (result !== null) {
          for (const beachId of beachIds) {
            const stamped = Object.assign({}, result, { beachId: beachId });
            await env.FLAGS.put(
              "official:" + beachId,
              JSON.stringify(stamped),
              { expirationTtl: KV_TTL_SECONDS }
            );
            officialCount = officialCount + 1;
          }
        }
      } catch (err) {
        console.log("index: official scrape failed: " + err.message);
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

async function runOverpassSync(env) {
  const nowIso = new Date().toISOString();
  let processed = 0;
  let enrichmentFailures = 0;

  try {
    const namedRows = await fetchBeaches(PILOT_BBOX);
    if (namedRows === null) {
      console.log("index: overpass sync aborted, fetchBeaches returned null");
      return;
    }

    // Park containment: failures degrade to the named-only sync and leave
    // every existing park_name untouched (legacy statement below).
    const parkBeaches = await fetchParkBeaches(PILOT_BBOX);
    if (parkBeaches === null) {
      console.log("index: fetchParkBeaches returned null, keeping existing park associations");
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

    const needsEnrichment = await env.DB.prepare(
      "SELECT id, lat, lon FROM beaches WHERE nws_zone IS NULL ORDER BY id LIMIT " +
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
        }
      } catch (err) {
        enrichmentFailures = enrichmentFailures + 1;
        console.log("index: nws enrichment failed for " + beach.id + ": " + err.message);
      }
    }

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
      " skipped_unnamed=" + String(merged.skippedUnnamed) +
      " enrichment_attempted=" + String(toEnrich.length) +
      " enrichment_failures=" + String(enrichmentFailures)
    );
  } catch (err) {
    console.log("index: overpass sync failed: " + err.message);
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
    } else {
      console.log("index: scheduled invoked with unknown cron: " + controller.cron);
    }
  }
};
