// src/officialSources/hdnwMichigan.js
// Official scraper for the Health Department of Northwest Michigan Beach
// Monitoring Program (Antrim, Charlevoix, Emmet, Otsego counties). This is a
// SEASONAL, water-quality (E. coli) source published as a hand-edited WordPress
// table that shows only a rolling window of recent samples — a beach appears
// only on the date(s) it was actually sampled. scrape() runs cron-side only;
// parseHdnwHtml is pure and exported for tests.
//
// Water Quality Index -> flag color mapping (per the page's legend):
//   1 = full body contact OK        -> green
//   2 = wading / limited contact    -> yellow
//   3 = no contact (EGLE exceeded)  -> red
//   4 = health alert / gross contam -> double-red
//
// Product safety: any row that does not parse cleanly and completely is
// SKIPPED, never guessed. A row older than STALE_MAX_DAYS relative to nowIso is
// dropped as stale rather than presented as current.
//
// Empty-success semantics: null means the parse FAILED (bad input, no <table>,
// no rows, unparseable nowIso) — the page may have changed shape and the health
// tracker should count it as a failure. A successful parse that finds the table
// and iterates rows but has nothing current to report (every sample stale,
// future-dated, unknown-named, or bad-WQI) returns an EMPTY sites array, which
// scrape() forwards as perBeachResult([], ...) — a healthy scrape with no data,
// NOT a failure. This is the seasonal steady state once sampling pauses.

import { fetchText, perBeachResult, ageDays } from "./util.js";

export const HDNW_URL = "https://nwhealth.org/beach-monitoring-program/";

export const HDNW_LABEL = "Health Department of Northwest Michigan Beach Monitoring Program";

// Sampling is periodic (roughly weekly with ad-hoc follow-up retests); a reading
// more than 8 days old is no longer a trustworthy "current" status.
export const STALE_MAX_DAYS = 8;

// Some WordPress/CDN hosts block UA-less requests with a 403; send a polite,
// identifying User-Agent. A block still degrades safely to null (no data), never
// a wrong color, but this keeps the source reachable in normal operation.
export const HDNW_USER_AGENT = "swim.report (hello@swim.report)";

const WQI_TO_COLOR = {
  "1": "green",
  "2": "yellow",
  "3": "red",
  "4": "double-red"
};

// Curated map: exact lowercased beach name as printed in the source table ->
// names[] substrings used by resolveSiteForBeach to match D1 beach rows. This is
// deliberately a fixed dictionary (NOT a loose regex): a name that appears in
// the table but is not a key here yields no site, so an unrecognized or newly
// added beach degrades to "no official data" rather than a wrong match. Aliases
// are lowercase and chosen as substrings of the expected OSM/D1 name.
const CURATED_NAME_MAP = {
  "thumb lake beach": ["thumb lake"],
  "zorn park": ["zorn park"],
  "mackinaw 1": ["mackinaw 1"],
  "mackinaw 2": ["mackinaw 2"],
  "middle village": ["middle village"],
  "cross village": ["cross village"],
  "wilderness state park": ["wilderness state park"],
  "sturgeon bay": ["sturgeon bay"],
  "wooden shoe park": ["wooden shoe park"],
  "young state park": ["young state park"],
  "elm point beach": ["elm point beach"],
  "east jordan tourist park": ["east jordan tourist park"],
  "whiting park": ["whiting park"],
  "melrose township park": ["melrose township park"],
  "barnes park": ["barnes park"],
  "elk rapids veterans memorial": ["elk rapids veterans memorial"],
  "elk rapids north beach": ["elk rapids north beach"],
  "richardi park": ["richardi park"],
  "torch lake day park": ["torch lake day park"],
  "petoskey state park": ["petoskey state park"],
  "camp petosega": ["camp petosega", "petosega"],
  // Leading space is deliberate: the bare substring "oden" is contained in
  // "wooden shoe park", so an un-spaced alias could resolve the Wooden Shoe Park
  // beach to the Oden site (a cross-beach wrong color). resolveSiteForBeach's
  // haystack is ((park_name||"") + " " + name), so a real Oden beach always has a
  // space immediately before "oden"; "wooden" never does.
  "oden": [" oden"],
  "little traverse township": ["little traverse township"],
  "arbutus beach": ["arbutus beach"],
  "otsego county park": ["otsego county park"],
  "otsego lake state park": ["otsego lake state park"],
  "wah wah soo beach": ["wah wah soo"],
  "big lake": ["big lake"],
  "fisherman's island": ["fisherman's island", "fisherman’s island"],
  "lake michigan beach": ["lake michigan beach"],
  "ferry beach": ["ferry beach"],
  "depot beach": ["depot beach"]
};

// Pure: (year, month 1-12, day) -> UTC-midnight epoch ms for that civil date.
// Date.UTC is a pure static computation over the supplied components, so both
// operands of a diff stay anchored to midnight and ageDays returns an exact
// whole-day integer — the same idiom bldhd/michiganCity/wisconsinDnr use.
function civilUtcMs(y, m, d) {
  return Date.UTC(y, m - 1, d);
}

// nowIso ("2026-07-05T...") -> UTC-midnight epoch ms of its DATE, or null if
// unparseable. Time-of-day is intentionally dropped so the staleness/future
// gates compare whole calendar days.
function nowIsoToUtcMs(nowIso) {
  if (typeof nowIso !== "string") {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(nowIso);
  if (!match) {
    return null;
  }
  return civilUtcMs(
    parseInt(match[1], 10),
    parseInt(match[2], 10),
    parseInt(match[3], 10)
  );
}

// "MM/DD/YY" -> { dayMs, iso } | null (not a well-formed/plausible date).
// One parse serves both consumers: dayMs (UTC-midnight epoch ms) drives the
// staleness/future gates, and iso ("20YY-MM-DDT00:00:00.000Z") stamps each
// site's updated with the SAMPLE date so the frontend's stale-data warning
// reflects how old the reading actually is, instead of the cron tick masking it.
function parseTableDate(dateStr) {
  const match = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(dateStr);
  if (!match) {
    return null;
  }
  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  const year = 2000 + parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return {
    dayMs: civilUtcMs(year, month, day),
    iso: "20" + match[3] + "-" + match[1] + "-" + match[2] + "T00:00:00.000Z"
  };
}

// Extract the visible text of one <td> with fragments SPACE-joined (never naive
// concatenation), so "Elm Point Beach </strong><strong>(Follow up)" does not
// collapse to "Beach(Follow up)". Returns a trimmed, whitespace-collapsed string.
function cellText(cellHtml) {
  let text = cellHtml.replace(/<[^>]*>/g, " ");
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/ /g, " ");
  text = text.replace(/&amp;/gi, "&");
  text = text.replace(/\s+/g, " ");
  return text.trim();
}

// Normalize a scraped beach name for map lookup: strip a "(Follow up)" retest
// suffix, normalize the curly apostrophe, lowercase, collapse whitespace.
function normalizeBeachName(raw) {
  let name = raw.replace(/\(\s*follow\s*up\s*\)/gi, " ");
  name = name.replace(/’/g, "'");
  name = name.replace(/\s+/g, " ").trim().toLowerCase();
  return name;
}

// Pure, exported for tests. (html, nowIso) -> sites[] | null.
// Parses the first table on the page, keeps only rows that parse cleanly, map to
// a known curated beach, carry a valid WQI (1-4), and are not stale. When a beach
// has several rows (e.g. an elevated reading plus a "(Follow up)" retest) the
// MOST RECENT sample wins.
// Returns null only when the parse could not proceed: empty/garbage input, no
// <table>, no <tr> rows, or an unparseable nowIso (page-shape failure). When the
// table and rows are found and iterated but no site survives the gates (stale,
// future-dated, unknown name, bad WQI), returns an EMPTY array — a successful
// parse with nothing current to report, not a failure.
export function parseHdnwHtml(html, nowIso) {
  if (!html || typeof html !== "string") {
    return null;
  }
  const nowMs = nowIsoToUtcMs(nowIso);
  if (nowMs === null) {
    return null;
  }
  const tableMatch = /<table[\s\S]*?<\/table>/i.exec(html);
  if (!tableMatch) {
    return null;
  }
  const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi);
  if (!rows) {
    return null;
  }

  // key -> best row so far { dayMs, iso, color, dateStr, ecoli }
  const bestByKey = {};

  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].match(/<td[\s\S]*?<\/td>/gi);
    if (!cells || cells.length !== 5) {
      continue;
    }
    const dateStr = cellText(cells[0]);
    const beachRaw = cellText(cells[2]);
    const ecoli = cellText(cells[3]);
    const wqi = cellText(cells[4]);

    const parsedDate = parseTableDate(dateStr);
    if (parsedDate === null) {
      continue;
    }
    const sampleMs = parsedDate.dayMs;
    const color = WQI_TO_COLOR[wqi];
    if (!color) {
      continue;
    }
    // NOTE: color is decided SOLELY by the WQI cell. E. coli is informational
    // only and is NOT used as a skip gate: the page's own legend prints the
    // dangerous Level 3/4 tiers as ">1000" (and labs report ">2419.6"/"TNTC"),
    // so gating on a numeric E. coli would silently drop the most-severe rows and
    // let an older, less-severe row win via most-recent-wins -> a wrong (possibly
    // green) color. Column misalignment is already caught by the 5-cell shape, the
    // MM/DD/YY date gate, the WQI-in-1..4 gate, and the curated-name gate.
    if (!beachRaw) {
      continue;
    }
    const key = normalizeBeachName(beachRaw);
    if (!Object.prototype.hasOwnProperty.call(CURATED_NAME_MAP, key)) {
      continue;
    }
    // Drop stale samples relative to nowIso. Both operands are UTC-midnight, so
    // ageDays is an exact whole-day integer and the boundary matches the old
    // integer day-number diff.
    if (ageDays(nowMs, sampleMs) > STALE_MAX_DAYS) {
      continue;
    }
    // Drop implausible future-dated rows (hand-edit typos): a sample can never be
    // meaningfully ahead of "now". A future green typo must never out-rank a
    // current severe reading. One day of slack absorbs UTC-vs-local date skew.
    if (ageDays(nowMs, sampleMs) < -1) {
      continue;
    }
    const prev = bestByKey[key];
    if (!prev || sampleMs > prev.dayMs) {
      bestByKey[key] = {
        dayMs: sampleMs,
        iso: parsedDate.iso,
        color: color,
        dateStr: dateStr,
        ecoli: ecoli
      };
    }
  }

  const sites = [];
  const keys = Object.keys(bestByKey);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const row = bestByKey[key];
    const ecoliText = row.ecoli
      ? "E. coli " + row.ecoli + " per 100ml"
      : "E. coli not reported";
    const reason =
      "Official water-quality result from " + HDNW_LABEL + " for " + key +
      " based on sample dated " + row.dateStr +
      " (" + ecoliText + ")";
    const site = {
      siteId: key,
      color: row.color,
      reason: reason,
      names: CURATED_NAME_MAP[key]
    };
    // updated is the sample date, NOT nowIso: a periodic (roughly weekly)
    // E. coli reading stamped with the cron tick would render as freshly
    // updated and suppress the UI's honest stale-data warning. row.iso came
    // from the same parseTableDate call that validated the row, so it is
    // always set; the guard just avoids emitting updated: null on a logic
    // drift.
    if (row.iso) {
      site.updated = row.iso;
    }
    sites.push(site);
  }

  // Zero survivors is a SUCCESSFUL parse with nothing current to report (the
  // table and rows were found and iterated, but every sample was stale,
  // future-dated, unknown-named, or bad-WQI). Return the empty array, not null:
  // null is reserved for a parse that could not proceed (page-shape failure).
  return sites;
}

// Four-county NW Lower Michigan shoreline bounding box (Antrim, Charlevoix,
// Emmet, Otsego). A broad box is safe: unresolved beaches simply get no official
// flag, so over-inclusion here never produces a wrong color.
function inHdnwBox(beach) {
  return beach.lat >= 44.85 && beach.lat <= 45.80 &&
    beach.lon >= -85.45 && beach.lon <= -84.55;
}

export const hdnwMichigan = {
  id: "hdnw-michigan",
  label: HDNW_LABEL,
  url: HDNW_URL,
  matches: function(beach) {
    if (typeof beach.lat !== "number" || typeof beach.lon !== "number") {
      return false;
    }
    return inHdnwBox(beach);
  },
  scrape: async function(nowIso) {
    const html = await fetchText(HDNW_URL, {
      headers: { "User-Agent": HDNW_USER_AGENT },
      logPrefix: "hdnwMichigan: fetch failed"
    });
    if (html === null) {
      return null;
    }
    try {
      const sites = parseHdnwHtml(html, nowIso);
      // null is a parse failure (page may have changed) -> null. An empty array
      // is a healthy parse with nothing current to report (seasonal steady state
      // once sampling pauses) -> perBeachResult([], ...), NOT a failure. A
      // non-empty array carries the resolved sites unchanged.
      if (sites === null) {
        return null;
      }
      // result-level updated is a fallback only — every emitted site carries
      // updated: its own sample date, which wins in
      // scrapeOfficialFlagFromResult.
      return perBeachResult(sites, HDNW_URL, nowIso);
    } catch (err) {
      console.log("hdnwMichigan: fetch failed: " + err.message);
      return null;
    }
  }
};
