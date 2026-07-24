// Agent FRONTEND — src/frontend/render.js
//
// Pure, string-returning HTML renderers. No fetch, no Date, no DOM APIs at
// render time. "now" is always passed in by the caller (the router). HTML is
// built with string concatenation (+) and array.join("\n") — never template
// literals / backticks. const/let only, never var.

import { PAGE_STYLES } from "./styles.js";
import { LIST_SEARCH_SCRIPT } from "./searchScript.js";
import { LIST_SWAP_SCRIPT } from "./listSwapScript.js";
import { LIST_GEO_SCRIPT } from "./geoScript.js";
import { LIST_MAP_SCRIPT } from "./mapScript.js";
import { COLOR_SCHEME_SCRIPT } from "./colorSchemeScript.js";
import {
  trimWaveSeries,
  computeWaveRuns,
  computeHazardBands,
  waveStripSummary,
  modelNowCaption,
  orderedModelIds,
  buildWaveModelChartConfig,
  waveModelSummary
} from "./waveStrip.js";

// The flag estimate recomputes hourly, so 2 h without an update is genuinely
// stale. The wave strip is refreshed on the 6-hourly wave cron (its KV lives
// 7 h and the marine models only publish every 6–12 h), so it is only stale
// once it has clearly missed a cycle — an 8 h threshold, not the 2 h flag one.
//
// STALE_MS is the DEFAULT horizon, not a universal one: it is calibrated to our
// own hourly recompute cadence, which is the right yardstick for the estimate
// card and for official sources we re-read every hour. An official source that
// publishes on its OWN slower schedule (a once-daily NWS product, a
// human-posted beach status) is not stale merely because our 2 h window
// elapsed — the record is rewritten hourly and the color is still current. Such
// a scraper may declare an optional staleMs (see PLAN.md's scraper contract),
// which arrives on the official KV record and overrides the default for that
// source only. Anything that does not declare one keeps the honest 2 h signal.
const STALE_MS = 7200000;
const WAVE_STALE_MS = 28800000;
// The subtitle's NDBC water-temperature fragment is shown only when the reading
// is this fresh; matches the parser window (NDBC_WATER_TEMP_MAX_OBS_AGE_MS) —
// water temp is slow-moving, so a several-hour-old reading is still faithful.
const WATER_TEMP_STALE_MS = 43200000; // 12 h — matches the parser window; water temp is slow-moving

// Web Awesome Pro CDN kit: version-pinned theme (matter), color palette
// (mild), native styles/reset, CSS utilities, and the component autoloader.
// The matching wa-theme-matter / wa-palette-mild classes go on <html>.
const WA_KIT_BASE = "https://ka-p.webawesome.com/kit/aa896405367b46f6/webawesome@3.10.0";

// MapLibre GL JS (pinned) + the OpenFreeMap positron style: browser-only assets
// for the home-page map (src/frontend/mapScript.js). Loaded from renderListPage,
// not from renderDocument's shared <head> — detail/error pages never pay for
// them, and the Worker itself never fetches them (two-path rule).
const MAPLIBRE_JS = "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js";
const MAPLIBRE_CSS = "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css";

// Kit theme overrides, minus the kit's webfont downloads: body/heading lead
// with genuine system fonts so the pinned matter.css Roboto @font-face (served
// from bunny.net) never downloads.
const WA_THEME_OVERRIDES = ":root {" +
  " --wa-font-family-body: system-ui, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;" +
  " --wa-font-family-heading: system-ui, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;" +
  " --wa-font-family-code: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace;" +
  " --wa-font-family-longform: Rockwell, 'Rockwell Nova', 'DejaVu Serif', 'Sitka Small', serif;" +
  " }";

const FLAG_LABELS = {
  "green": "GREEN",
  "yellow": "YELLOW",
  "red": "RED",
  "double-red": "DOUBLE RED — water closed",
  "unknown": "UNKNOWN"
};

// Screen-reader label for the title flag icon only — the cards' and rows'
// icons sit next to visible GREEN/YELLOW/... text and stay decorative.
const FLAG_ICON_LABELS = {
  "green": "Green flag",
  "yellow": "Yellow flag",
  "red": "Red flag",
  "double-red": "Double red flags",
  "unknown": "Flag status unknown"
};

export function escapeHtml(str) {
  if (str === null || str === undefined) {
    return "";
  }
  const s = String(str);
  return s
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split("\"").join("&quot;")
    .split("'").join("&#39;");
}

function normalizeColor(color) {
  if (Object.prototype.hasOwnProperty.call(FLAG_LABELS, color)) {
    return color;
  }
  return "unknown";
}

// The single collapse rule for a flag color's display keyword: double-red shares
// the red tint (only its icon count differs), everything else normalizes to its
// own color (unknown as the honest fallback). Behind BOTH the UI's flag-icon
// class and the map marker's `flag` keyword, so the color-to-keyword rule lives
// in exactly one place. Always returns one of green|yellow|red|unknown.
function collapseFlagColor(color) {
  const normalized = normalizeColor(color);
  return normalized === "double-red" ? "red" : normalized;
}

// The flag color's tint class, used by renderFlagIcon (the UI's flags).
function flagIconColorClass(color) {
  return "flag-icon-" + collapseFlagColor(color);
}

// The collapsed map-flag color KEYWORD for a beach, given its cached estimate
// and official reading. Best-color precedence mirrors the detail page's
// titleColor: official wins over estimate, estimate wins over "unknown".
// double-red collapses to "red" (exactly as flagIconColorClass tints it), so
// the result is always one of green|yellow|red|unknown. Exported so the
// /api/beaches.geojson endpoint (router.js) stamps each feature's `flag`
// property from the same single color rule the UI flags use.
export function markerFlagColor(estimate, official) {
  const best = official ? official.color
    : (estimate ? estimate.color : "unknown");
  return collapseFlagColor(best);
}

function isStale(nowIso, updatedIso, thresholdMs) {
  if (!nowIso || !updatedIso) {
    return false;
  }
  const now = Date.parse(nowIso);
  const updated = Date.parse(updatedIso);
  if (Number.isNaN(now) || Number.isNaN(updated)) {
    return false;
  }
  const limit = typeof thresholdMs === "number" ? thresholdMs : STALE_MS;
  return (now - updated) > limit;
}

function isUrlLike(value) {
  return typeof value === "string" &&
    (value.indexOf("http://") === 0 || value.indexOf("https://") === 0);
}

// Hostname as a display label ("www." stripped for brevity) — used when a
// source has no human-written label of its own.
function hostnameOf(urlStr) {
  if (!urlStr) {
    return "";
  }
  try {
    const hostname = new URL(urlStr).hostname;
    return hostname.indexOf("www.") === 0 ? hostname.slice(4) : hostname;
  } catch {
    return urlStr;
  }
}

// Official records (the only caller is renderOfficialCard) always carry a
// non-empty scraped-page URL in its source field — every scraper sets it, via
// perBeachResult or its own result object — so that is the sole field read.
function firstSourceUrl(record) {
  if (!record || !record.source) {
    return "";
  }
  return record.source;
}

// The <wa-relative-time> element formats the timestamp in the visitor's
// browser (locale + live updates via sync) — the renderer itself stays pure:
// it only interpolates the ISO string into the date attribute.
function renderStaleWarning(updatedIso) {
  return "<wa-callout variant=\"warning\" size=\"s\">" +
    "<wa-icon slot=\"icon\" name=\"triangle-exclamation\"></wa-icon>" +
    "Stale data — last updated <wa-relative-time date=\"" + escapeHtml(updatedIso) +
    "\" sync></wa-relative-time>" +
    "</wa-callout>";
}

// The honest middle ground for a POINT-IN-TIME official reading whose source
// publishes on a slower schedule than our 2 h default: past 2 h the reading is
// no longer "just taken", but well inside the source's own cadence it is not
// stale either — it is simply an observation from earlier in the day, still the
// latest thing the source has published. A warning callout would cry wolf for
// most of every day; saying nothing would let a morning observation read as if
// it were current. So the scraper supplies a sentence FRAGMENT (readingNote)
// and we render it NEUTRAL, with the age appended — informative, not alarming.
// Deliberately not styled: recoloring a wa-callout is the classic way to break
// text contrast in one color scheme, and the theme's neutral tokens already
// handle both. Pure like renderStaleWarning — <wa-relative-time> does the
// locale-aware formatting client-side, so no Date access happens here.
function renderReadingNote(note, updatedIso) {
  return "<wa-callout variant=\"neutral\" size=\"s\">" +
    "<wa-icon slot=\"icon\" name=\"clock\"></wa-icon>" +
    escapeHtml(note) + " <wa-relative-time date=\"" + escapeHtml(updatedIso) +
    "\" sync></wa-relative-time>." +
    "</wa-callout>";
}

// labelText (optional): accessible name for a standalone icon (the detail-page
// title). Without it the icon renders decorative (aria-hidden), which is right
// wherever visible flag text sits next to it.
function renderFlagIcon(color, sizeClass, slotName, labelText) {
  const normalized = normalizeColor(color);
  const colorClass = flagIconColorClass(color);
  const iconClass = sizeClass + " " + colorClass;
  const slotAttr = slotName ? (" slot=\"" + slotName + "\"") : "";
  if (normalized === "double-red") {
    const labelAttrs = labelText
      ? (" role=\"img\" aria-label=\"" + escapeHtml(labelText) + "\"")
      : "";
    return "<span" + slotAttr + labelAttrs + " class=\"wa-cluster wa-gap-3xs\">" +
      "<wa-icon name=\"flag\" class=\"" + iconClass + "\"></wa-icon>" +
      "<wa-icon name=\"flag\" class=\"" + iconClass + "\"></wa-icon>" +
      "</span>";
  }
  const labelAttr = labelText ? (" label=\"" + escapeHtml(labelText) + "\"") : "";
  return "<wa-icon" + slotAttr + labelAttr + " name=\"flag\" class=\"" + iconClass + "\"></wa-icon>";
}

function renderFlagChip(estimate) {
  const color = estimate ? normalizeColor(estimate.color) : "unknown";
  // Short chip label only: the full "— water closed" text wraps badly beside
  // long park names; the detail card keeps the full FLAG_LABELS text.
  const label = color === "double-red" ? "DOUBLE RED" : FLAG_LABELS[color];
  return "<wa-badge variant=\"neutral\" appearance=\"outlined\">" +
    renderFlagIcon(color, "wa-font-size-l", "start") +
    escapeHtml(label) +
    "</wa-badge>";
}

function renderEstimateBadge() {
  return "<wa-badge variant=\"neutral\" appearance=\"outlined\">ESTIMATE</wa-badge>";
}

function renderOfficialBadge(sizeClass) {
  const cls = sizeClass ? (" class=\"" + sizeClass + "\"") : "";
  return "<wa-badge variant=\"success\" appearance=\"filled\"" + cls + ">" +
    "<wa-icon slot=\"start\" name=\"circle-check\"></wa-icon>OFFICIAL</wa-badge>";
}

// Wrapper for the small source cluster on a card header; its single caller is
// renderOfficialSourceLink (estimate sources render as badge chips instead).
function sourceCluster(innerHtml) {
  return "<span class=\"wa-cluster wa-gap-xs wa-font-size-s\">" + innerHtml + "</span>";
}

// Estimate sources are { label, url } objects (url is provenance only — never
// rendered as a hyperlink; only official scraper sources link out, see
// renderOfficialSourceLink). Bare strings are the legacy shape — KV entries
// written before the labeled format live for up to 2 h, so both must render
// (as their hostname when URL-like). Returns small badge chips for the card
// header, or "" when empty. Quiet filled-neutral pills, deliberately unlike
// the square outlined ESTIMATE badge — and never variant="success": green is
// reserved for OFFICIAL.
function renderSourceLabels(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const items = [];
  for (const source of list) {
    let label = "";
    if (source && typeof source === "object") {
      label = source.label ? String(source.label) : String(source.url || "");
      if (!source.label && isUrlLike(source.url)) {
        label = hostnameOf(source.url);
      }
    } else if (isUrlLike(source)) {
      label = hostnameOf(source);
    } else if (source) {
      label = String(source);
    }
    if (label) {
      items.push("<wa-badge variant=\"neutral\" appearance=\"filled\" pill>" +
        escapeHtml(label) + "</wa-badge>");
    }
  }
  if (items.length === 0) {
    return "";
  }
  return "<span class=\"source-badges wa-cluster wa-gap-2xs wa-justify-content-end " +
    "wa-font-size-2xs\">" + items.join("\n") + "</span>";
}

// Official cards are the one place a source renders as a hyperlink: the
// scraped page is where a visitor can verify the posted flag upstream.
// Estimate sources (NWS, Open-Meteo, GLOS) stay plain text — see
// renderSourceLabels. Returns "" when the url is missing or not URL-like.
function renderOfficialSourceLink(url) {
  if (!isUrlLike(url)) {
    return "";
  }
  return sourceCluster("<a href=\"" + escapeHtml(url) + "\" rel=\"noopener noreferrer\">" +
    escapeHtml(hostnameOf(url)) + "</a>");
}

function renderFlagRow(color, reason) {
  return "<div class=\"wa-flank wa-gap-m\">" +
    renderFlagIcon(color, "wa-font-size-4xl") +
    "<div class=\"wa-stack wa-gap-3xs\">" +
    "<span class=\"wa-font-size-xl wa-font-weight-bold\">" + escapeHtml(FLAG_LABELS[color]) + "</span>" +
    "<p>" + escapeHtml(reason) + "</p>" +
    "</div>" +
    "</div>";
}

// Shared flag-card skeleton used by both the official and the estimate card so
// their layouts stay identical: badge in the header (left), source labels in
// header-actions (top right), flag row + stale warning in the body, "Updated"
// in the footer. The with-* attributes track slotted content per the wa-card
// SSR contract.
//
// Two optional options tune the body callout, and only renderOfficialCard ever
// passes them (the estimate card is on our own hourly cadence, so it always
// gets the plain 2 h behaviour):
//   staleMs     — this source's own staleness horizon; absent -> STALE_MS.
//   readingNote — copy for the neutral note shown between the 2 h default and
//                 that horizon.
// The two callouts are MUTUALLY EXCLUSIVE and the warning always wins: a card
// that is genuinely stale must never also carry a reassuring note next to the
// warning, which is exactly the mixed signal the never-present-stale-data-as-
// fresh constraint forbids.
function renderFlagCard(options) {
  const attrs = " with-header" +
    (options.sourcesHtml ? " with-header-actions" : "") +
    (options.updated ? " with-footer" : "");
  const lines = [];
  lines.push("<wa-card class=\"" + options.cardClass + "\" appearance=\"" +
    options.appearance + "\"" + attrs + ">");
  lines.push("<div slot=\"header\">" + options.badgeHtml + "</div>");
  if (options.sourcesHtml) {
    lines.push("<div slot=\"header-actions\">" + options.sourcesHtml + "</div>");
  }
  lines.push(renderFlagRow(options.color, options.reason));
  if (options.updated) {
    // A source-declared horizon replaces the default outright; anything else
    // (undefined on every record written before this contract existed, and on
    // every scraper that declares nothing) falls back to STALE_MS.
    const limit = typeof options.staleMs === "number" ? options.staleMs : STALE_MS;
    if (isStale(options.nowIso, options.updated, limit)) {
      lines.push(renderStaleWarning(options.updated));
    } else if (options.readingNote && isStale(options.nowIso, options.updated, STALE_MS)) {
      lines.push(renderReadingNote(options.readingNote, options.updated));
    }
  }
  if (options.updated) {
    lines.push("<div slot=\"footer\" class=\"wa-caption-s\">Updated " +
      "<wa-relative-time date=\"" + escapeHtml(options.updated) +
      "\" sync></wa-relative-time></div>");
  }
  lines.push("</wa-card>");
  return lines.join("\n");
}

function renderEstimateCard(estimate, nowIso) {
  const isMissing = estimate === null || estimate === undefined;
  return renderFlagCard({
    cardClass: "estimate-card",
    appearance: "outlined",
    badgeHtml: renderEstimateBadge(),
    color: isMissing ? "unknown" : normalizeColor(estimate.color),
    reason: isMissing ? "No estimate available yet" : (estimate.reason || "No data available"),
    sourcesHtml: isMissing ? "" : renderSourceLabels(estimate.sources),
    updated: isMissing ? null : (estimate.updated || null),
    nowIso: nowIso
  });
}

function renderOfficialCard(official, nowIso) {
  if (!official) {
    return "";
  }
  const sourceUrl = firstSourceUrl(official);
  const sourcesHtml = renderOfficialSourceLink(sourceUrl);
  return renderFlagCard({
    cardClass: "official-card",
    appearance: "filled-outlined",
    badgeHtml: renderOfficialBadge(null),
    color: normalizeColor(official.color),
    reason: official.reason || "",
    sourcesHtml: sourcesHtml,
    updated: official.updated || null,
    // Passed through raw: scrapeOfficialFlagFromResult is the validating
    // boundary (it omits both fields unless the scraper declared them well), so
    // undefined here means "no declaration" and renderFlagCard falls back to the
    // 2 h default — which is also what a legacy KV record written before this
    // contract yields, since it simply lacks the keys.
    staleMs: official.staleMs,
    readingNote: official.readingNote,
    nowIso: nowIso
  });
}

function renderBrandHeader() {
  return "<a class=\"brand-link wa-font-size-l wa-font-weight-bold\" href=\"/\">" +
    "<wa-icon name=\"person-swimming\"></wa-icon>" +
    "<span class=\"brand-name\">Swim Report</span>" +
    "</a>";
}

// The disclaimer sentence below is a product invariant (PLAN.md section 9):
// estimates must never read as official flag status, on any page.
// The second paragraph is the site-wide attribution for the data sources; the
// Windy credit links Windy.com to the webcams hub. This footer line is now the
// only Windy attribution on the page — renderWebcam no longer carries a
// per-cam credit. The third paragraph is the homepage map's basemap credit:
// mapScript.js runs the MapLibre map with attributionControl disabled (its
// async-populated links would otherwise become focusable inside the aria-hidden
// mount), so OpenFreeMap's required OpenStreetMap attribution lives here as
// static, in-reading-order text instead.
function renderFooter() {
  return "<p><small>Estimated — not the official flag status. " +
    "Always obey posted flags and lifeguards.</small></p>" +
    "<p><small>Thanks to " +
    "<a href=\"https://www.openstreetmap.org\" rel=\"noopener noreferrer\">OpenStreetMap</a> " +
    "for beach locations, " +
    "<a href=\"https://www.weather.gov\" rel=\"noopener noreferrer\">NOAA/NWS</a> + " +
    "<a href=\"https://weather.gc.ca\" rel=\"noopener noreferrer\">ECCC</a> + " +
    "<a href=\"https://open-meteo.com/en/docs/marine-weather-api\" rel=\"noopener noreferrer\">Open-Meteo</a> " +
    "for marine and weather data, and " +
    "<a href=\"https://www.windy.com/webcams\" rel=\"noopener noreferrer\">Windy.com</a> " +
    "for webcams.</small></p>" +
    "<p><small>Map tiles by " +
    "<a href=\"https://openfreemap.org\" rel=\"noopener noreferrer\">OpenFreeMap</a> " +
    "(data © " +
    "<a href=\"https://www.openstreetmap.org/copyright\" rel=\"noopener noreferrer\">OpenStreetMap</a> " +
    "contributors), rendered with " +
    "<a href=\"https://maplibre.org\" rel=\"noopener noreferrer\">MapLibre</a>.</small></p>";
}

// Ambient, Firewatch-style layered wave swells anchored to the bottom of the
// document, behind the footer — they come into view as the visitor reaches the
// end of the page (inspired by the "Pure CSS Waves" pen technique: one reusable path,
// four <use> layers drifting at staggered speeds for parallax). Decorative
// only — aria-hidden, pointer-events: none, and rendered behind all content
// (see .wave-bg in styles.js). The layers carry no fill here: styles.js tints
// them from the theme's own text token so they read as subtle dark-on-dark /
// light-on-light tonal swells and flip automatically with the wa-dark class.
function renderWaveBackground() {
  return "<div class=\"wave-bg\" aria-hidden=\"true\">" +
    "<svg class=\"wave-svg\" viewBox=\"0 24 150 28\" preserveAspectRatio=\"none\" " +
    "shape-rendering=\"auto\" xmlns=\"http://www.w3.org/2000/svg\">" +
    "<defs>" +
    "<path id=\"gentle-wave\" d=\"M-160 44c30 0 58-18 88-18s58 18 88 18 58-18 88-18 " +
    "58 18 88 18 v44h-352z\"></path>" +
    "</defs>" +
    "<g class=\"wave-layers\">" +
    "<use href=\"#gentle-wave\" x=\"48\" y=\"0\"></use>" +
    "<use href=\"#gentle-wave\" x=\"48\" y=\"3\"></use>" +
    "<use href=\"#gentle-wave\" x=\"48\" y=\"5\"></use>" +
    "<use href=\"#gentle-wave\" x=\"48\" y=\"7\"></use>" +
    "</g>" +
    "</svg>" +
    "</div>";
}

function renderPageShell(headerHtml, mainHtml, footerHtml) {
  const lines = [];
  lines.push("<wa-page>");
  lines.push("<header slot=\"header\" class=\"app-header\">" + headerHtml + "</header>");
  lines.push("<main class=\"app-main wa-stack wa-gap-l\">" + mainHtml + "</main>");
  lines.push("<footer slot=\"footer\" class=\"app-footer\">" + footerHtml + "</footer>");
  lines.push("</wa-page>");
  return lines.join("\n");
}

function renderDocument(title, bodyHtml) {
  const lines = [];
  lines.push("<!doctype html>");
  lines.push("<html lang=\"en\" class=\"wa-theme-matter wa-palette-mild wa-cloak\" data-fa-kit-code=\"ddd41b2d81\">");
  lines.push("<head>");
  lines.push("<meta charset=\"utf-8\">");
  lines.push("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
  // Blocking on purpose: toggles wa-dark from the OS color-scheme preference
  // before the theme stylesheets below paint (see colorSchemeScript.js).
  lines.push("<script>" + COLOR_SCHEME_SCRIPT + "</script>");
  lines.push("<title>" + escapeHtml(title) + "</title>");
  lines.push("<link rel=\"stylesheet\" href=\"" + WA_KIT_BASE + "/styles/themes/matter.css\">");
  lines.push("<link rel=\"stylesheet\" href=\"" + WA_KIT_BASE + "/styles/native.css\">");
  lines.push("<link rel=\"stylesheet\" href=\"" + WA_KIT_BASE + "/styles/utilities.css\">");
  lines.push("<script type=\"module\" src=\"" + WA_KIT_BASE + "/webawesome.loader.js\"></script>");
  lines.push("<style>" + WA_THEME_OVERRIDES + "</style>");
  lines.push("<style>" + PAGE_STYLES + "</style>");
  lines.push("</head>");
  lines.push("<body>");
  lines.push(renderWaveBackground());
  lines.push(bodyHtml);
  lines.push("</body>");
  lines.push("</html>");
  return lines.join("\n");
}

// Park-name-first display (PLAN.md section 9): visitors think "Holland State
// Park", not "Ottawa Beach", so when a beach sits inside a named park the park
// name is the primary title and the beach's own name demotes to a quiet
// subtitle. Unnamed park beaches get name === park_name at sync time, so the
// subtitle only renders when the two genuinely differ.
function displayName(beach) {
  if (beach.park_name) {
    return beach.park_name;
  }
  return beach.name || "";
}

function subtitleName(beach) {
  if (beach.park_name && beach.name && beach.name !== beach.park_name) {
    return beach.name;
  }
  return null;
}

// Composes the detail-page .beach-subtitle string from the beach's own name (the
// park-first subtitle) plus an optional NDBC water-temperature fragment. Pure —
// nowIso is passed in; no fetch, no Date. DISPLAY-ONLY: this reading never
// touches the flag color. The temp fragment is included only when waterTemp is a
// non-null object with a finite tempF AND its observedIso parses to within
// WATER_TEMP_STALE_MS of nowIso (a missing/unparseable observedIso -> omit temp,
// never a stale value). Returns the final subtitle string, or null when neither
// piece is present (the caller's guard then renders no <p class="beach-subtitle">).
function beachSubtitle(beach, waterTemp, nowIso) {
  const base = subtitleName(beach);
  let temp = null;
  if (waterTemp && typeof waterTemp === "object" &&
      typeof waterTemp.tempF === "number" && isFinite(waterTemp.tempF) &&
      !isStale(nowIso, waterTemp.observedIso, WATER_TEMP_STALE_MS) &&
      typeof waterTemp.observedIso === "string" &&
      !Number.isNaN(Date.parse(waterTemp.observedIso))) {
    temp = String(Math.round(waterTemp.tempF)) + "°F Water";
  }
  if (base && temp) {
    return base + " • " + temp;
  }
  if (base) {
    return base;
  }
  if (temp) {
    return temp;
  }
  return null;
}

// Rough distance label for a row, e.g. "<1 mi" or "~12 mi". Distances come
// from IP-level geolocation, so anything more precise would be false accuracy.
function formatMiles(distance) {
  if (typeof distance !== "number" || !isFinite(distance) || distance < 0) {
    return "";
  }
  if (distance < 1) {
    return "<1 mi";
  }
  return "~" + String(Math.round(distance)) + " mi";
}

// A class-carrying <span> around escaped text, or "" when text is empty —
// the conditional-wrapper shape shared by a beach row's distance and subtitle.
function span(cls, text) {
  if (!text) {
    return "";
  }
  return "<span class=\"" + cls + "\">" + escapeHtml(text) + "</span>";
}

function renderBeachRow(entry) {
  const beach = entry.beach;
  const estimate = entry.estimate;
  const official = entry.official;
  // data-name feeds the client-side search filter: both the park name and the
  // beach's own name must match, so "Holland State Park" and "Ottawa Beach"
  // each find the same row.
  const searchable = (beach.park_name ? beach.park_name + " " : "") + String(beach.name || "");
  const dataName = escapeHtml(searchable.toLowerCase());
  const href = "/beach/" + encodeURIComponent(beach.id);
  const officialBadgeHtml = official ? (" " + renderOfficialBadge(null)) : "";
  const milesLabel = formatMiles(entry.distanceMi);
  const distanceHtml = span("beach-row-distance wa-caption-s", milesLabel);
  const subtitle = subtitleName(beach);
  const subtitleHtml = span("beach-row-subtitle", subtitle);
  const lines = [];
  lines.push("<li class=\"beach-row\" data-name=\"" + dataName + "\">");
  lines.push("<a class=\"beach-row-link\" href=\"" + escapeHtml(href) + "\">");
  lines.push("<span class=\"beach-row-name\">" + escapeHtml(displayName(beach)) + distanceHtml +
    subtitleHtml + "</span>");
  lines.push("<span class=\"wa-cluster wa-gap-xs\">" + renderFlagChip(estimate) + officialBadgeHtml + "</span>");
  lines.push("<wa-icon name=\"chevron-right\" class=\"wa-color-text-quiet\"></wa-icon>");
  lines.push("</a>");
  lines.push("</li>");
  return lines.join("\n");
}

// Homepage map: a purely visual MapLibre mount. It carries NO per-beach data —
// the browser-side init script (mapScript.js) fetches every flag-worthy beach
// once from the cacheable /api/beaches.geojson endpoint and renders them as a
// native clustered GeoJSON source (count bubbles that expand on click, and
// individual rasterized fa-flag icons tinted by each feature's `flag` keyword at
// high zoom). This renderer only emits the mount plus the map center: the
// resolved user location (the same signal that sorts the list — a browser "near"
// fix or Cloudflare's IP estimate) rides along as a data-center attribute so the
// browser can center without another fetch; data-center-precise marks which
// source it came from.
//
// The map is a visual supplement only — the search box + results list is the
// complete accessible path (it covers the full flag-worthy table server-side).
// So the mount is aria-hidden and kept out of the tab order (mapScript.js also
// disables MapLibre keyboard handling, sets the canvas to tabindex -1, and adds
// no focusable control chrome — attributionControl is off, its OSM credit moved
// to the static footer); there is no landmark aria-label advertising a hidden map.
function renderHomeMap(near, location) {
  // Map center: the resolved user location that also sorts the list — the
  // browser "near" fix when the visitor granted geolocation, otherwise
  // Cloudflare's IP-derived request.cf estimate. data-center-precise ("1" for a
  // browser fix, "0" for the coarser IP estimate) lets the browser zoom tighter
  // on a real fix than on the estimate; with no location at all the attribute
  // is omitted and the browser falls back to fitting all the fetched features.
  // Coordinates round to ~110 m (3 dp) — the map never needs finer, and it keeps
  // precise coordinates out of the markup.
  const centerLat = location ? Number(location.lat) : NaN;
  const centerLon = location ? Number(location.lon) : NaN;
  const centerAttrs = (isFinite(centerLat) && isFinite(centerLon))
    ? (" data-center=\"" + centerLat.toFixed(3) + "," + centerLon.toFixed(3) + "\"" +
       " data-center-precise=\"" + (near ? "1" : "0") + "\"")
    : "";
  // The framed box reuses the existing .framed-embed border + the
  // wa-border-radius-m utility (same treatment as the detail-page wave map /
  // webcam); .home-map itself only adds the map's fixed height and the
  // clip-to-radius overflow. aria-hidden + tabindex="-1" keep the visual-only
  // map out of assistive-tech and keyboard tab order.
  return "<section class=\"home-map-section\">" +
    "<div id=\"home-map\" class=\"home-map framed-embed wa-border-radius-m\" " +
    "aria-hidden=\"true\" tabindex=\"-1\"" + centerAttrs + "></div>" +
    "</section>";
}

export function renderListPage(data) {
  const entries = (data && Array.isArray(data.entries)) ? data.entries : [];
  const rowsHtml = entries.map(renderBeachRow).join("\n");
  const hasEntries = entries.length > 0;
  // Active server-side search query (the ?q= parameter), if any. On a q-filtered
  // page the rendered rows are already the full-table matches, so the empty
  // state only needs the plain "no match" copy; on the default listing (no
  // query) it also offers to submit the search server-side when more beaches
  // exist than were rendered (hasMore).
  const query = data && data.query ? String(data.query) : "";
  const nearParam = data && data.near ? String(data.near) : "";
  // Resolved user location for map centering: the router's { lat, lon } (browser
  // "near" fix or Cloudflare IP estimate), the same signal that proximity-sorts
  // the list. null keeps the map fitting the markers instead.
  const location = data && data.location ? data.location : null;
  const hasMore = !!(data && data.hasMore);
  const offerSearchAll = hasMore && query.length === 0;

  // A q-filtered page with zero rows is a search miss, not an empty database —
  // it must get the no-match copy, same as the client-side filter miss.
  const emptyMessage = (hasEntries || query.length > 0)
    ? "No beaches match your search."
    : "No beaches found yet. Check back soon.";
  const emptyStyle = hasEntries ? " style=\"display: none;\"" : "";
  // Submits the same GET form (by id) with the current search value so the
  // filter runs against the whole beaches table, not just the rendered rows.
  const searchAllHtml = offerSearchAll ?
    ("<wa-button class=\"search-all-btn\" type=\"submit\" form=\"beach-search-form\" " +
      "appearance=\"outlined\" size=\"s\">Search all beaches</wa-button>") : "";

  const introHtml = "<section class=\"list-intro wa-stack wa-gap-xs\">" +
    "<h1>Swim Report</h1>" +
    "<p class=\"wa-color-text-quiet\">Estimated beach hazard flags for pilot beaches across the " +
    "Great Lakes region.</p>" +
    "</section>";

  const mapHtml = renderHomeMap(nearParam, location);

  // The search box submits to the server (method GET, name=q) so results cover
  // the whole table, while the inline script keeps filtering rendered rows as
  // the user types. Any active "near" param rides along in a hidden input so
  // proximity sorting survives the submit.
  const nearHiddenHtml = nearParam ?
    ("<input type=\"hidden\" name=\"near\" value=\"" + escapeHtml(nearParam) + "\">") : "";
  const searchHtml = "<form id=\"beach-search-form\" class=\"list-search\" method=\"get\" " +
    "action=\"/\" role=\"search\">" +
    "<wa-input id=\"beach-search\" name=\"q\" type=\"search\" value=\"" + escapeHtml(query) + "\" " +
    "label=\"Search beaches\" placeholder=\"Search by beach or park name\" with-clear>" +
    "<wa-icon slot=\"start\" name=\"magnifying-glass\"></wa-icon>" +
    "</wa-input>" +
    nearHiddenHtml +
    "</form>";

  // On a q-filtered page, surface the active query and a way back to the full
  // list (preserving any near param). The line lives inside a stable,
  // always-present #list-active-query container (empty on the default listing)
  // so the client scripts can swap it in place as the query changes — see
  // listSwapScript.js.
  const backHref = "/" + (nearParam ? ("?near=" + encodeURIComponent(nearParam)) : "");
  const activeQueryInner = query.length > 0 ?
    ("<p class=\"list-active-query wa-color-text-quiet\">Showing results for <strong>" +
      escapeHtml(query) + "</strong>. " +
      "<a class=\"clear-search\" href=\"" + escapeHtml(backHref) + "\">Clear search</a></p>") : "";
  const activeQueryHtml = "<div id=\"list-active-query\">" + activeQueryInner + "</div>";

  // Polite live region for the browser-geolocation upgrade: geoScript.js swaps
  // the list in place (no navigation), so the reorder would otherwise be
  // invisible to screen-reader users. Empty at render; the script fills it
  // after a successful swap.
  const geoLiveHtml =
    "<p id=\"geo-live-region\" class=\"visually-hidden\" role=\"status\" aria-live=\"polite\"></p>";

  // data-complete signals that the rendered rows ARE the whole flag-worthy
  // table (the default listing was not capped), so the client's instant local
  // filter is exhaustive and searchScript can skip the server round-trip
  // entirely. Only the default (no-query) listing can assert this — a q-filtered
  // page's rows are query matches, not the full table.
  const listComplete = !hasMore && query.length === 0;
  const completeAttr = listComplete ? " data-complete=\"1\"" : "";
  const listHtml = "<section class=\"beach-list-section\">" +
    "<ul class=\"beach-list wa-list-plain wa-stack wa-gap-xs\" id=\"beach-list-items\"" + completeAttr + ">" + rowsHtml + "</ul>" +
    "<p id=\"beach-list-empty\"" + emptyStyle + " class=\"empty-state\">" +
    "<span class=\"empty-state-message\">" + escapeHtml(emptyMessage) + "</span>" +
    searchAllHtml +
    "</p>" +
    "</section>";

  const mainHtml = introHtml + mapHtml + searchHtml + activeQueryHtml + geoLiveHtml + listHtml;
  const bodyHtml = renderPageShell(renderBrandHeader(), mainHtml, renderFooter()) +
    "<script>" + LIST_SWAP_SCRIPT + "</script>" +
    "<script>" + LIST_SEARCH_SCRIPT + "</script>" +
    "<script>" + LIST_GEO_SCRIPT + "</script>" +
    "<link rel=\"stylesheet\" href=\"" + MAPLIBRE_CSS + "\">" +
    "<script src=\"" + MAPLIBRE_JS + "\"></script>" +
    "<script>" + LIST_MAP_SCRIPT + "</script>";

  return renderDocument("Swim Report", bodyHtml);
}

// Windy.com wave-overlay embed centered on the beach. Loaded by the browser
// inside an iframe — the request path itself still fetches nothing upstream.
function renderWaveMap(beach) {
  // Number(null) is 0, so missing coordinates must be rejected before coercion
  // or the map would silently center on 0,0.
  const lat = (beach.lat === null || beach.lat === undefined) ? NaN : Number(beach.lat);
  const lon = (beach.lon === null || beach.lon === undefined) ? NaN : Number(beach.lon);
  if (!isFinite(lat) || !isFinite(lon)) {
    return "";
  }
  const embedSrc = "https://embed.windy.com/embed.html?type=map&location=coordinates" +
    "&metricRain=default&metricTemp=default&metricWind=default" +
    "&zoom=11&overlay=waves&product=ecmwfWaves&level=surface&marker=true" +
    "&lat=" + lat.toFixed(3) + "&lon=" + lon.toFixed(3);
  return "<section class=\"wave-map\">" +
    "<div class=\"wa-frame:landscape wa-border-radius-m framed-embed\">" +
    "<iframe class=\"wave-map-frame\" src=\"" + escapeHtml(embedSrc) + "\"" +
    " title=\"Wave height map\" loading=\"lazy\" allowfullscreen></iframe>" +
    "</div>" +
    "</section>";
}

// Nearby-webcam player embedded from Windy's free webcam API, in the same
// plain-<iframe> wrapper as the wave map (title gives the frame an accessible
// name; the player's own play/scrub/fullscreen controls receive clicks
// normally). The browser fetches the embed — the request path itself still
// reads only D1/KV.
// Rendered only when webcam_player_url is a non-empty string; the columns are
// null (no nearby cam) or undefined (pre-migration rows), so both are skipped.
// The site-wide Windy.com credit now lives once in the footer (renderFooter),
// so this section carries no per-cam heading or attribution line — just the
// player and, when known, the cam's own name as a quiet caption. The frame's
// accessible name falls back to "Nearby webcam" when the title is empty.
function renderWebcam(beach) {
  const playerUrl = beach.webcam_player_url;
  if (typeof playerUrl !== "string" || playerUrl.length === 0) {
    return "";
  }
  const title = (typeof beach.webcam_title === "string") ? beach.webcam_title : "";
  const frameTitle = title ? title : "Nearby webcam";
  const lines = [];
  lines.push("<section class=\"webcam-section wa-stack wa-gap-s\">");
  lines.push("<div class=\"wa-frame:landscape wa-border-radius-m framed-embed\">" +
    "<iframe class=\"webcam-frame\" src=\"" + escapeHtml(playerUrl) + "\"" +
    " title=\"" + escapeHtml(frameTitle) + "\" loading=\"lazy\" allowfullscreen></iframe>" +
    "</div>");
  if (title) {
    lines.push("<p class=\"webcam-caption wa-caption-s\">" +
      "<span class=\"webcam-title\">" + escapeHtml(title) + "</span></p>");
  }
  lines.push("</section>");
  return lines.join("\n");
}

// Quiet hour-tick row under the strip: "Now" pinned left, "+" + totalHours +
// " h" pinned right, and interior +6/+12/+18 h marks positioned by a
// server-computed left percentage (a genuinely per-instance value, so an inline
// style is the right tool here). aria-hidden — the strip's aria-label/summary
// already conveys the timeline to assistive tech.
function renderWaveHourTicks(totalHours) {
  const parts = [];
  parts.push("<div class=\"wave-chart-hours\" aria-hidden=\"true\">");
  parts.push("<span class=\"wave-chart-hour wave-chart-hour-start\">Now</span>");
  const marks = [6, 12, 18];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark < totalHours) {
      const pct = (mark / totalHours) * 100;
      parts.push("<span class=\"wave-chart-hour\" style=\"left: " + pct + "%;\">+" +
        mark + " h</span>");
    }
  }
  parts.push("<span class=\"wave-chart-hour wave-chart-hour-end\">+" + totalHours + " h</span>");
  parts.push("</div>");
  return parts.join("");
}

// The slotted-JSON + pre-upgrade fallback-<p> tail for the model-comparison
// chart (its only remaining consumer — the band strip is now a plain flex row):
// the config serialized to JSON with "<" escaped so it can never break out of
// the <script>, followed by the prose summary as the fallback paragraph. This
// is the single home for that XSS-hardening escape.
function chartScriptAndFallback(config, summary) {
  const configJson = JSON.stringify(config).split("<").join("\\u003c");
  return "<script type=\"application/json\">" + configJson + "</script>" +
    "<p class=\"wave-chart-fallback wa-caption-s\">" + escapeHtml(summary) + "</p>";
}

// Colored wave-strip: one flex segment per run, sized by flex-grow (run.hours —
// proportional, no percentage rounding drift) and colored by the run's palette
// token. width/background are genuinely per-instance values, the sanctioned
// inline-style case. Each segment is focusable so wa-tooltip's default
// "hover focus" trigger covers keyboard and tap; the tooltip and the segment's
// aria-label carry the same text. Tooltip hosts render position: absolute, so
// emitting them as siblings adds no layout space. The visually-hidden paragraph
// preserves the prose summary for assistive tech.
function renderWaveStrip(runs, totalHours, summaryText) {
  const segs = [];
  const tips = [];
  let offset = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const id = "wave-seg-" + i;
    const start = offset;
    const end = offset + run.hours;
    offset = end;
    const range = start === 0
      ? ("now through +" + end + " h")
      : ("+" + start + " h to +" + end + " h");
    const text = run.band === "no-data"
      ? ("No wave data — " + range)
      : (run.label + " waves (estimated) — " + range);
    segs.push("<div class=\"wave-strip-seg\" id=\"" + id + "\" role=\"listitem\"" +
      " tabindex=\"0\" aria-label=\"" + escapeHtml(text) + "\"" +
      " style=\"flex: " + run.hours + " " + run.hours + " 0%; background: " +
      run.tokenVar + ";\"></div>");
    tips.push("<wa-tooltip for=\"" + id + "\">" + escapeHtml(text) + "</wa-tooltip>");
  }
  return "<div class=\"wave-strip\" role=\"list\" aria-label=\"Wave height forecast " +
    "for the next " + totalHours + " hours\">" + segs.join("") + "</div>" +
    tips.join("") +
    "<p class=\"wa-visually-hidden\">" + escapeHtml(summaryText) + "</p>";
}

// The now-stat, per-model "now" caption, band-strip block, and stale warning
// pieces of the wave forecast. Returned as named parts (not pre-joined) so the
// caller can interleave the model-comparison chart in the correct slot; hasNow
// gates whether the whole section renders. Pure.
function renderWaveStripParts(estimate, series, nowIso, wavesUpdated) {
  const hasNow = !!estimate && typeof estimate.waveHeightFt === "number" &&
    isFinite(estimate.waveHeightFt);
  const nowStat = hasNow
    ? ("<p class=\"wave-now wa-cluster wa-gap-s\"><span class=\"wave-now-value wa-font-size-xl wa-font-weight-bold\">" +
        estimate.waveHeightFt.toFixed(1) + " ft</span> " +
        "<span class=\"wave-now-label wa-caption-s\">waves now</span> " +
        renderEstimateBadge() + "</p>")
    : "";

  let chartBlock = "";
  let staleHtml = "";
  let modelNowHtml = "";
  if (series) {
    const runs = computeWaveRuns(series.hoursFt);
    const summaryText = waveStripSummary(runs);
    const totalHours = series.totalHours;
    const chartHtml = renderWaveStrip(runs, totalHours, summaryText);
    chartBlock = chartHtml + "\n" + renderWaveHourTicks(totalHours);
    if (isStale(nowIso, wavesUpdated, WAVE_STALE_MS)) {
      staleHtml = renderStaleWarning(wavesUpdated);
    }

    // Per-model "now" caption: only when two or more models report a current
    // reading (a single model would just repeat the stat above).
    const nowCaption = modelNowCaption(series);
    if (nowCaption) {
      modelNowHtml = "<p class=\"wave-model-now wa-caption-s\">" +
        escapeHtml(nowCaption) + "</p>";
    }
  }

  return {
    hasNow: hasNow,
    nowStat: nowStat,
    modelNowHtml: modelNowHtml,
    chartBlock: chartBlock,
    staleHtml: staleHtml
  };
}

// Hazard lane above the wave strip: one positioned band row per active hazard
// (a flag-relevant NWS alert with its time period, or a HIGH/MODERATE
// rip-current risk). The band's left/width percentages and color tokens are
// genuinely per-instance values (the sanctioned inline-style case); its
// visible label carries the hazard name (CSS-ellipsized when the span is
// short) and the tooltip/aria-label carry the full name-plus-period text —
// the same pattern as the strip segments. Returns "" for no bands.
function renderHazardLane(bands) {
  if (bands.length === 0) {
    return "";
  }
  const rows = [];
  const tips = [];
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    const id = "wave-alert-" + i;
    rows.push("<div class=\"wave-alert-lane\">" +
      "<div class=\"wave-alert-band\" id=\"" + id + "\" role=\"note\" tabindex=\"0\"" +
      " aria-label=\"" + escapeHtml(band.text) + "\"" +
      " style=\"left: " + band.leftPct + "%; width: " + band.widthPct + "%;" +
      " background: " + band.bgVar + "; color: " + band.fgVar + ";" +
      " border-color: " + band.edgeVar + ";\">" +
      "<span class=\"wave-alert-label\">" + escapeHtml(band.label) + "</span>" +
      "</div></div>");
    tips.push("<wa-tooltip for=\"" + id + "\">" + escapeHtml(band.text) + "</wa-tooltip>");
  }
  return rows.join("") + tips.join("");
}

// Collapsed model-comparison line chart: rendered only when two or more models
// are present in the trimmed window (a single model would just repeat the
// strip). Same slotted-JSON pattern as the strip. Returns "" otherwise. Pure.
function renderWaveModelCompare(series) {
  if (!series || orderedModelIds(series.byModel).length < 2) {
    return "";
  }
  const modelConfig = buildWaveModelChartConfig(series);
  const modelSummary = waveModelSummary(series);
  return "<wa-details class=\"wave-model-compare\" summary=\"Compare wave models\" " +
    "appearance=\"plain\" icon-placement=\"start\">" +
    "<wa-line-chart class=\"wave-model-chart\" without-animation yLabel=\"ft\" " +
    "label=\"Wave height by forecast model\" description=\"" +
    escapeHtml(modelSummary) + "\">" +
    chartScriptAndFallback(modelConfig, modelSummary) +
    "</wa-line-chart></wa-details>";
}

// Wave forecast section (detail page): a "now" wave-height stat plus a Dark
// Sky-style horizontal color strip of the next up-to-24 hours (a flex row of
// tooltip-carrying segments). Colored by ESTIMATED wave height only — never
// the official flag. Returns "" when there is neither a finite now-height nor
// a renderable series.
function renderWaveForecast(estimate, waves, nowIso) {
  const series = trimWaveSeries(waves, nowIso);
  const strip = renderWaveStripParts(estimate, series, nowIso, waves && waves.updated);
  const modelCompareHtml = renderWaveModelCompare(series);
  // Hazard lane needs the strip's timeline to position bands against — with
  // no renderable series there is no bar graph to overlay (the estimate card
  // still names any active alert in its reason).
  const hazardHtml = series
    ? renderHazardLane(computeHazardBands(estimate, series.totalHours, nowIso))
    : "";

  // Neither the stat nor the strip has anything to render — omit the section.
  if (!strip.hasNow && !series) {
    return "";
  }

  const lines = [];
  lines.push("<section class=\"wave-forecast wa-stack wa-gap-s\">");
  if (strip.nowStat) {
    lines.push(strip.nowStat);
  } else {
    // No now-stat (legacy payload without waveHeightFt): the ESTIMATE badge
    // normally riding the stat line still has to mark the section as
    // estimated — that framing is a product invariant.
    lines.push("<div class=\"wa-cluster wa-gap-s\">" + renderEstimateBadge() + "</div>");
  }
  if (strip.modelNowHtml) {
    lines.push(strip.modelNowHtml);
  }
  if (hazardHtml) {
    lines.push(hazardHtml);
  }
  if (strip.chartBlock) {
    lines.push(strip.chartBlock);
  }
  if (modelCompareHtml) {
    lines.push(modelCompareHtml);
  }
  if (strip.staleHtml) {
    lines.push(strip.staleHtml);
  }
  lines.push("</section>");
  return lines.join("\n");
}

export function renderDetailPage(data) {
  const beach = data.beach;
  const estimate = data.estimate;
  const official = data.official;
  const nowIso = data.nowIso;
  // Absent on legacy KV payloads and for buoy-fallback/masked beaches — default
  // to null so the wave forecast section simply omits itself.
  const waves = (data.waves === undefined || data.waves === null) ? null : data.waves;
  // NDBC water-temperature reading (DISPLAY-ONLY, never a flag input). Absent
  // until the wave cron writes it, so default to null; the subtitle omits the
  // temp fragment when it is null or stale.
  const waterTemp = (data.waterTemp === undefined || data.waterTemp === null) ? null : data.waterTemp;
  const title = displayName(beach) + " — Swim Report";
  const lat = Number(beach.lat).toFixed(4);
  const lon = Number(beach.lon).toFixed(4);

  // Title flag mirrors the best current reading: scraped official color when
  // available, otherwise the estimate (null-safe: no flag data renders gray).
  const titleColor = official ? official.color : (estimate ? estimate.color : null);
  const titleFlagHtml = renderFlagIcon(titleColor, "wa-font-size-4xl", null,
    FLAG_ICON_LABELS[normalizeColor(titleColor)]);

  // Subtitle = the park-first beach name plus, when fresh, an NDBC water-temp
  // fragment (e.g. "Ottawa Beach • 72°F Water"). The ° and • pass through
  // escapeHtml unchanged; the guard keeps the <p> off the page when null.
  const subtitle = beachSubtitle(beach, waterTemp, nowIso);
  const subtitleHtml = subtitle ?
    ("<p class=\"beach-subtitle\">" + escapeHtml(subtitle) + "</p>") : "";

  // Coordinates link out to OpenStreetMap (consistent with the footer's OSM
  // attribution), demoted to caption size.
  const osmHref = "https://www.openstreetmap.org/?mlat=" + lat + "&mlon=" + lon +
    "#map=15/" + lat + "/" + lon;

  // Identity block wrapped in its own tight nested stack (wa-gap-xs) so the
  // back-link, title, subtitle, and coords group together; the outer app-main
  // stack's wa-gap-l then separates the whole header from the cards below.
  // (A stack zero-margins its children, so .beach-title/.beach-subtitle carry
  // no margins of their own.) wa-flex-nowrap keeps the flag icon and beach
  // name on one flex line at narrow widths — long names wrap inside their own
  // span, beside the icon, instead of dropping below it.
  const headerBlock = "<div class=\"beach-identity wa-stack wa-gap-l\">" +
    "<a class=\"back-link\" href=\"/\">" +
    "<wa-icon name=\"arrow-left\"></wa-icon> Back to all beaches</a>" +
    "<h1 class=\"beach-title wa-cluster wa-gap-s wa-flex-nowrap\">" + titleFlagHtml + "<span>" + escapeHtml(displayName(beach)) + "</span></h1>" +
    subtitleHtml +
    "<p class=\"wa-caption-s\"><a class=\"coords-link\" href=\"" + escapeHtml(osmHref) +
    "\" rel=\"noopener noreferrer\">" +
    "<wa-icon name=\"location-dot\"></wa-icon> " + lat + ", " + lon + "</a></p>" +
    "</div>";

  const officialHtml = renderOfficialCard(official, nowIso);
  const estimateHtml = renderEstimateCard(estimate, nowIso);

  // Answer first, exploration second: the flag verdict (official above
  // estimate) leads, the forecast elaborates, and the lazy-loading map/webcam
  // embeds follow as supporting exploration.
  const stackParts = [];
  if (officialHtml) {
    stackParts.push(officialHtml);
  }
  stackParts.push(estimateHtml);
  const waveForecastHtml = renderWaveForecast(estimate, waves, nowIso);
  if (waveForecastHtml) {
    stackParts.push(waveForecastHtml);
  }
  const waveMapHtml = renderWaveMap(beach);
  if (waveMapHtml) {
    stackParts.push(waveMapHtml);
  }
  const webcamHtml = renderWebcam(beach);
  if (webcamHtml) {
    stackParts.push(webcamHtml);
  }

  const mainHtml = headerBlock +
    "<div class=\"detail-stack wa-stack wa-gap-l\">" + stackParts.join("\n") + "</div>";

  const bodyHtml = renderPageShell(renderBrandHeader(), mainHtml, renderFooter());
  return renderDocument(title, bodyHtml);
}

export function renderErrorPage(data) {
  const status = (data && data.status) ? data.status : 500;
  const message = (data && data.message) ? data.message : "Something went wrong.";

  const mainHtml = "<wa-callout variant=\"danger\">" +
    "<wa-icon slot=\"icon\" name=\"triangle-exclamation\"></wa-icon>" +
    "<strong>" + escapeHtml(String(status)) + "</strong><br>" +
    escapeHtml(message) + "<br>" +
    "<a href=\"/\">Return to the beach list</a>" +
    "</wa-callout>";

  const bodyHtml = renderPageShell(renderBrandHeader(), mainHtml, renderFooter());
  return renderDocument("Swim Report — " + String(status), bodyHtml);
}
