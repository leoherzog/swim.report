// src/sitemap.js — GET /sitemap.xml: the home page, the API guide and every
// flag-worthy beach page, from one D1 read of scalar columns. A beach is listed
// exactly when its detail page answers 200, through the same
// FLAG_WORTHY_WATER_SQL gate and the same public-id conversion.

import { SITE_ORIGIN } from "./site.js";
import { toPublicId } from "./publicId.js";
import { FLAG_WORTHY_WATER_SQL } from "./waterClass.js";
import { BEACH_STATE_JOIN, liveChipState } from "./beachState.js";
import { strongEtag, etaggedResponse } from "./etag.js";
import { CACHE_CONTROL_CACHEABLE } from "./cacheControl.js";

// The sitemaps.org limit for one file. A table past it needs a sitemap index.
const SITEMAP_MAX_URLS = 50000;

const STATIC_PATHS = ["/", "/api/"];
const BEACH_URL_LIMIT = SITEMAP_MAX_URLS - STATIC_PATHS.length;

// The chip-state columns minus official_kind, whose json_extract would parse
// every official blob for nothing. Ordered by id so the body, and so the ETag,
// is stable between writes.
const SITEMAP_SQL =
  "SELECT b.id, s.estimate_color, s.estimate_updated, s.estimate_expires, " +
  "s.official_color, s.official_updated, s.official_expires" +
  " FROM beaches b" + BEACH_STATE_JOIN + " WHERE " + FLAG_WORTHY_WATER_SQL +
  " ORDER BY b.id LIMIT " + String(BEACH_URL_LIMIT);

const XML_CONTENT_TYPE = "application/xml; charset=utf-8";

function escapeXml(str) {
  return String(str)
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split("\"").join("&quot;")
    .split("'").join("&apos;");
}

// A W3C datetime to the second.
function w3cDatetime(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * When a beach page last changed: the newer updated stamp of its live estimate
 * and live official. An expired record no longer shows on the page, so it
 * cannot date it.
 * @param {object} row a row carrying the chip-state columns
 * @param {number} nowMs
 * @returns {?number} epoch ms, or null when neither record is live
 */
export function beachLastModifiedMs(row, nowMs) {
  const state = liveChipState(row, nowMs);
  let newest = null;
  const records = [state.estimate, state.official];
  for (const record of records) {
    const ms = record ? Date.parse(record.updated) : NaN;
    if (Number.isFinite(ms) && (newest === null || ms > newest)) {
      newest = ms;
    }
  }
  return newest;
}

function urlEntry(path, lastModifiedMs) {
  const lastmod = lastModifiedMs === null ? "" :
    ("<lastmod>" + w3cDatetime(lastModifiedMs) + "</lastmod>");
  return "<url><loc>" + escapeXml(SITE_ORIGIN + path) + "</loc>" + lastmod + "</url>";
}

/**
 * The sitemap document for the beach rows SITEMAP_SQL returns. A row whose id
 * has no public form is skipped, since its URL would only redirect. The home
 * page is dated by its newest beach, the API guide not at all.
 * @param {Array<object>} rows
 * @param {number} nowMs
 * @returns {string}
 */
export function buildSitemapXml(rows, nowMs) {
  const beachEntries = [];
  let newest = null;
  for (const row of rows) {
    const publicId = toPublicId(row ? row.id : null);
    if (publicId === null) {
      continue;
    }
    const lastModifiedMs = beachLastModifiedMs(row, nowMs);
    if (lastModifiedMs !== null && (newest === null || lastModifiedMs > newest)) {
      newest = lastModifiedMs;
    }
    beachEntries.push(urlEntry("/beach/" + encodeURIComponent(publicId), lastModifiedMs));
  }
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
    "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n" +
    urlEntry("/", newest) + "\n" +
    urlEntry("/api/", null) + "\n" +
    (beachEntries.length > 0 ? beachEntries.join("\n") + "\n" : "") +
    "</urlset>\n";
}

/**
 * GET /sitemap.xml, cacheable, with a body-hash ETag and a 304 for a match.
 * @param {object} env the Worker env; reads env.DB only
 * @param {?string} ifNoneMatch the request's If-None-Match
 * @returns {Promise<Response>}
 */
export async function handleSitemap(env, ifNoneMatch) {
  const result = await env.DB.prepare(SITEMAP_SQL).all();
  const rows = (result && result.results) || [];
  if (rows.length >= BEACH_URL_LIMIT) {
    console.log("sitemap: beach rows reached the " + String(BEACH_URL_LIMIT) +
      " cap; beaches past it are unlisted until the sitemap becomes an index");
  }
  const bytes = new TextEncoder().encode(buildSitemapXml(rows, Date.now()));
  const etag = await strongEtag(bytes);
  return etaggedResponse(bytes, etag, XML_CONTENT_TYPE, CACHE_CONTROL_CACHEABLE, ifNoneMatch);
}
