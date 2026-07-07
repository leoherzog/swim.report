// src/scraperHealth.js
// Pure health-tracking helper for official scrapers. The hourly cron
// (runFlagRecompute in src/index.js) persists the returned next object as
// JSON under KV key "scraperhealth:" + scraperId with NO expirationTtl, so the
// consecutive-null streak survives across runs. See PLAN.md section 7.
//
// A scraper is only tracked on runs where it actually had matched beaches (the
// cron only reaches this helper for scrapers it invoked), so a scraper that is
// never invoked is never counted as "failing".

export const SCRAPER_HEALTH_ALERT_THRESHOLD = 24;

// Pure. Given the previously persisted state and this run's outcome, returns
// the new state to persist plus an optional LOUD alert message.
//
//   scraperId  stable registry id, used to build the alert string.
//   prev       previously stored state (parsed JSON) or null/undefined when no
//              prior state exists. Shape { consecutiveNulls, lastSuccess,
//              lastFailure }.
//   succeeded  true when the scraper returned a usable result this run, false
//              when scrape() returned null.
//   nowIso     the cron run timestamp (never generated here).
//
// Returns { next, alert }:
//   next   { consecutiveNulls, lastSuccess, lastFailure } to write back to KV.
//   alert  null, or the exact message to log once when the consecutive-null
//          streak has reached SCRAPER_HEALTH_ALERT_THRESHOLD (>= 24 runs).
export function updateScraperHealth(scraperId, prev, succeeded, nowIso) {
  const prevConsecutive =
    prev && typeof prev.consecutiveNulls === "number" ? prev.consecutiveNulls : 0;
  const prevLastSuccess = prev && prev.lastSuccess ? prev.lastSuccess : null;
  const prevLastFailure = prev && prev.lastFailure ? prev.lastFailure : null;

  if (succeeded) {
    return {
      next: {
        consecutiveNulls: 0,
        lastSuccess: nowIso,
        lastFailure: prevLastFailure
      },
      alert: null
    };
  }

  const consecutiveNulls = prevConsecutive + 1;
  const next = {
    consecutiveNulls: consecutiveNulls,
    lastSuccess: prevLastSuccess,
    lastFailure: nowIso
  };

  let alert = null;
  if (consecutiveNulls >= SCRAPER_HEALTH_ALERT_THRESHOLD) {
    const lastSuccessText = prevLastSuccess ? prevLastSuccess : "never";
    alert =
      "ALERT: official scraper " + scraperId +
      " has returned null for " + String(consecutiveNulls) +
      " consecutive hourly runs (last success " + lastSuccessText + ")";
  }

  return { next: next, alert: alert };
}
