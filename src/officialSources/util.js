// src/officialSources/util.js
// Shared helpers for the official-source scrapers. This module imports only
// the dependency-free src/geo.js, so any scraper can import it without ever
// creating a cycle through src/officialSources/index.js (which imports every
// scraper; a scraper importing index.js back would hit the scrapers-array
// TDZ during module evaluation).
//
// Everything here is either pure or (for fetchText) a thin network wrapper
// used exclusively on the cron path. No Date.now(), no ambient clock.

import { distanceMi } from "../geo.js";

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Pure. Age of a reading in (fractional) days: how far thenMs lies in the
// past relative to nowMs. Negative when thenMs is in the future.
export function ageDays(nowMs, thenMs) {
  return (nowMs - thenMs) / MS_PER_DAY;
}

// Severity ranking shared by scrapers that must roll several observed flags
// up to the most restrictive one. Higher wins. Ordering matches
// OFFICIAL_COLORS in officialSources/index.js (double-red is the most severe
// official tier and must outrank red).
export const FLAG_SEVERITY = { green: 1, yellow: 2, red: 3, "double-red": 4 };

// Cron-side only. Fetches url and returns its body text, or null on ANY
// failure (non-2xx status, network error, body read error) — never throws
// across the module boundary. This wraps ONLY the fetch + ok-check + text;
// parsing stays inside each scraper so a parse failure keeps degrading to
// null in the scraper's own defensive code.
// options:
//   headers   — passed to fetch verbatim when present. Callers that send no
//               headers today must keep omitting this (never silently add a
//               User-Agent a source has not been probed with).
//   redirect  — passed to fetch verbatim when present (e.g. "follow").
//   logPrefix — console.log prefix; failures log as
//               logPrefix + ": HTTP " + status  /  logPrefix + ": " + message.
//   timeoutMs — outbound-request deadline in ms (default 30000). A hung
//               upstream aborts at this bound; the resulting AbortError is
//               caught below and degrades to null like any other failure, so
//               one slow source cannot stall the shared hourly flag cron.
export async function fetchText(url, options) {
  const opts = options || {};
  const prefix = opts.logPrefix || "officialSources: fetch failed";
  try {
    const init = { signal: AbortSignal.timeout(opts.timeoutMs || 30000) };
    if (opts.headers) {
      init.headers = opts.headers;
    }
    if (opts.redirect) {
      init.redirect = opts.redirect;
    }
    const response = await fetch(url, init);
    if (!response.ok) {
      console.log(prefix + ": HTTP " + response.status);
      return null;
    }
    return await response.text();
  } catch (err) {
    console.log(prefix + ": " + err.message);
    return null;
  }
}

// Pure. The standard multi-site (contract shape (b)) scrape result for the
// common single-source case where sources is exactly [source]. updated is the
// result-level fallback timestamp: real-time scrapers pass nowIso; periodic
// scrapers pass the source's own report timestamp, and per-site updated
// values (when present) still win in scrapeOfficialFlagFromResult.
export function perBeachResult(sites, source, updated) {
  return {
    perBeach: true,
    sites: sites,
    source: source,
    sources: [source],
    updated: updated
  };
}

export const DEFAULT_SITE_RADIUS_MI = 1.5;

// Pure. BeachRow + sites[] -> site | null.
// Pass 1 (names win over proximity): first site, in array order, with any
// names[] entry contained as a substring of
// ((beach.park_name || "") + " " + beach.name).toLowerCase().
// Pass 2: among sites with numeric lat/lon, the NEAREST one whose distance to
// the beach is within its radiusMi (default DEFAULT_SITE_RADIUS_MI = 1.5).
// Otherwise null.
// Lives here (not index.js) so scrapers whose matches() is exactly this
// name-or-proximity rule can reuse it without importing the registry;
// index.js re-exports it for the cron and tests.
export function resolveSiteForBeach(beach, sites) {
  if (!Array.isArray(sites)) {
    return null;
  }
  const haystack = ((beach.park_name || "") + " " + beach.name).toLowerCase();
  for (const site of sites) {
    if (Array.isArray(site.names)) {
      for (const name of site.names) {
        if (typeof name === "string" && name.length > 0 &&
            haystack.indexOf(name.toLowerCase()) !== -1) {
          return site;
        }
      }
    }
  }
  let best = null;
  let bestDistance = Infinity;
  for (const site of sites) {
    if (typeof site.lat !== "number" || typeof site.lon !== "number") {
      continue;
    }
    const radius = typeof site.radiusMi === "number"
      ? site.radiusMi
      : DEFAULT_SITE_RADIUS_MI;
    const distance = distanceMi(beach.lat, beach.lon, site.lat, site.lon);
    if (distance <= radius && distance < bestDistance) {
      best = site;
      bestDistance = distance;
    }
  }
  return best;
}
