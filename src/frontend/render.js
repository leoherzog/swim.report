// Agent FRONTEND — src/frontend/render.js
//
// Pure, string-returning HTML renderers. No fetch, no Date, no DOM APIs at
// render time. "now" is always passed in by the caller (the router). HTML is
// built with string concatenation (+) and array.join("\n") — never template
// literals / backticks. const/let only, never var.

import { PAGE_STYLES } from "./styles.js";
import { LIST_SEARCH_SCRIPT } from "./searchScript.js";
import {
  trimWaveSeries,
  computeWaveRuns,
  buildWaveChartConfig,
  waveStripSummary,
  modelNowCaption,
  orderedModelIds,
  buildWaveModelChartConfig,
  waveModelSummary
} from "./waveStrip.js";

const STALE_MS = 7200000;

// Web Awesome Pro CDN kit: version-pinned theme (matter), color palette
// (mild), native styles/reset, CSS utilities, and the component autoloader.
// The matching wa-theme-matter / wa-palette-mild classes go on <html>.
const WA_KIT_BASE = "https://ka-p.webawesome.com/kit/aa896405367b46f6/webawesome@3.10.0";

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

function isStale(nowIso, updatedIso) {
  if (!nowIso || !updatedIso) {
    return false;
  }
  const now = Date.parse(nowIso);
  const updated = Date.parse(updatedIso);
  if (Number.isNaN(now) || Number.isNaN(updated)) {
    return false;
  }
  return (now - updated) > STALE_MS;
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

function renderFlagIcon(color, sizeClass, slotName) {
  const normalized = normalizeColor(color);
  const colorClass = "flag-icon-" + (normalized === "double-red" ? "red" : normalized);
  const iconClass = sizeClass + " " + colorClass;
  const slotAttr = slotName ? (" slot=\"" + slotName + "\"") : "";
  if (normalized === "double-red") {
    return "<span" + slotAttr + " class=\"wa-cluster wa-gap-3xs\">" +
      "<wa-icon name=\"flag\" class=\"" + iconClass + "\"></wa-icon>" +
      "<wa-icon name=\"flag\" class=\"" + iconClass + "\"></wa-icon>" +
      "</span>";
  }
  return "<wa-icon" + slotAttr + " name=\"flag\" class=\"" + iconClass + "\"></wa-icon>";
}

function renderFlagChip(estimate) {
  const color = estimate ? normalizeColor(estimate.color) : "unknown";
  const label = FLAG_LABELS[color];
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

// Estimate sources are { label, url } objects (url is provenance only — never
// rendered as a hyperlink; only official scraper sources link out, see
// renderOfficialSourceLink). Bare strings are the legacy shape — KV entries
// written before the labeled format live for up to 2 h, so both must render
// (as their hostname when URL-like). Returns plain-text labels for the card
// header, or "" when empty.
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
      items.push("<span>" + escapeHtml(label) + "</span>");
    }
  }
  if (items.length === 0) {
    return "";
  }
  return "<span class=\"wa-cluster wa-gap-xs wa-font-size-s\">" + items.join("\n") + "</span>";
}

// Official cards are the one place a source renders as a hyperlink: the
// scraped page is where a visitor can verify the posted flag upstream.
// Estimate sources (NWS, Open-Meteo, GLOS) stay plain text — see
// renderSourceLabels. Returns "" when the url is missing or not URL-like.
function renderOfficialSourceLink(url) {
  if (!isUrlLike(url)) {
    return "";
  }
  return "<span class=\"wa-cluster wa-gap-xs wa-font-size-s\">" +
    "<a href=\"" + escapeHtml(url) + "\" rel=\"noopener noreferrer\">" +
    escapeHtml(hostnameOf(url)) + "</a></span>";
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

// Short description of which rule branch decided the color, keyed by the
// estimate's trigger (set in src/rules.js). The specific values (wave height,
// wind speed, alert name) already render in the reason line above this
// caption, so these stay generic. Keep in sync with the precedence chain in
// PLAN.md section 4.
const TRIGGER_DESCRIPTIONS = {
  "nws-alert": "Based on an active National Weather Service alert",
  "rip-current": "Based on the forecast rip current risk",
  "wave-height": "Based on the forecast wave height",
  "wind": "Based on the forecast wind speed (no wave data available)",
  "rip-current-low": "Based on the low rip current risk (no wave or wind data available)",
  "no-data": "No usable data available"
};

function renderTriggerLine(estimate) {
  const description = TRIGGER_DESCRIPTIONS[estimate.trigger];
  if (description) {
    return "<p class=\"wa-caption-s\">" + escapeHtml(description) + "</p>";
  }
  // Older KV payloads (written before triggers existed) fall back to the
  // rules-version line for the remainder of their 2 h TTL.
  return "<p class=\"wa-caption-s\">Rules version: " + escapeHtml(estimate.rules_version) + "</p>";
}

// Shared flag-card skeleton used by both the official and the estimate card so
// their layouts stay identical: badge in the header (left), source labels in
// header-actions (top right), flag row + optional detail line + stale warning
// in the body, "Updated" in the footer. The with-* attributes track slotted
// content per the wa-card SSR contract.
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
  if (options.detailHtml) {
    lines.push(options.detailHtml);
  }
  if (options.updated && isStale(options.nowIso, options.updated)) {
    lines.push(renderStaleWarning(options.updated));
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
    detailHtml: isMissing ? "" : renderTriggerLine(estimate),
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
    detailHtml: "",
    updated: official.updated || null,
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
function renderFooter() {
  return "<small>Beach locations via OpenStreetMap contributors. Marine and weather data via " +
    "NOAA/NWS and Open-Meteo. Estimated — not the official flag status. Always obey " +
    "posted flags and lifeguards.</small>";
}

function renderPageShell(headerHtml, mainHtml, footerHtml) {
  const lines = [];
  lines.push("<wa-page class=\"app-page\">");
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
  lines.push("<title>" + escapeHtml(title) + "</title>");
  lines.push("<link rel=\"stylesheet\" href=\"" + WA_KIT_BASE + "/styles/themes/matter.css\">");
  lines.push("<link rel=\"stylesheet\" href=\"" + WA_KIT_BASE + "/styles/native.css\">");
  lines.push("<link rel=\"stylesheet\" href=\"" + WA_KIT_BASE + "/styles/utilities.css\">");
  lines.push("<script type=\"module\" src=\"" + WA_KIT_BASE + "/webawesome.loader.js\"></script>");
  lines.push("<style>" + WA_THEME_OVERRIDES + "</style>");
  lines.push("<style>" + PAGE_STYLES + "</style>");
  lines.push("</head>");
  lines.push("<body>");
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
  const officialBadgeHtml = official ? (" " + renderOfficialBadge("wa-font-size-2xs")) : "";
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
      "appearance=\"outlined\" size=\"small\">Search all beaches</wa-button>") : "";

  const sortNoteHtml = data && data.sortedByProximity ?
    ("<p class=\"list-sort-note wa-caption-s\">" +
      "<wa-icon name=\"location-dot\"></wa-icon> " +
      "Sorted by approximate distance to you, based on your network location.</p>") : "";

  const introHtml = "<section class=\"list-intro wa-stack wa-gap-xs\">" +
    "<h1>Swim Report</h1>" +
    "<p class=\"wa-color-text-quiet\">Estimated beach hazard flags for pilot beaches across the " +
    "Great Lakes region.</p>" +
    sortNoteHtml +
    "</section>";

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
  // list (preserving any near param).
  const backHref = "/" + (nearParam ? ("?near=" + encodeURIComponent(nearParam)) : "");
  const activeQueryHtml = query.length > 0 ?
    ("<p class=\"list-active-query wa-color-text-quiet\">Showing results for <strong>" +
      escapeHtml(query) + "</strong>. " +
      "<a class=\"clear-search\" href=\"" + escapeHtml(backHref) + "\">Clear search</a></p>") : "";

  const listHtml = "<section class=\"beach-list-section\">" +
    "<ul class=\"beach-list wa-list-plain wa-stack wa-gap-xs\" id=\"beach-list-items\">" + rowsHtml + "</ul>" +
    "<p id=\"beach-list-empty\"" + emptyStyle + " class=\"empty-state\">" +
    "<span class=\"empty-state-message\">" + escapeHtml(emptyMessage) + "</span>" +
    searchAllHtml +
    "</p>" +
    "</section>";

  const mainHtml = introHtml + searchHtml + activeQueryHtml + listHtml;
  const bodyHtml = renderPageShell(renderBrandHeader(), mainHtml, renderFooter()) +
    "<script>" + LIST_SEARCH_SCRIPT + "</script>";

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
    "<iframe class=\"wave-map-frame\" src=\"" + escapeHtml(embedSrc) + "\"" +
    " title=\"Wave height map\" loading=\"lazy\" allowfullscreen></iframe>" +
    "</section>";
}

// Nearby-webcam player embedded from Windy's free webcam API, in the same
// plain-<iframe> wrapper as the wave map (title gives the frame an accessible
// name; the player's own play/scrub/fullscreen controls receive clicks
// normally). The browser fetches the embed — the request path itself still
// reads only D1/KV.
// Rendered only when webcam_player_url is a non-empty string; the columns are
// null (no nearby cam) or undefined (pre-migration rows), so both are skipped.
// The heading and caption stay honest that this is a NEARBY cam, and the free
// tier requires the Windy.com attribution link-back.
function renderWebcam(beach) {
  const playerUrl = beach.webcam_player_url;
  if (typeof playerUrl !== "string" || playerUrl.length === 0) {
    return "";
  }
  const title = (typeof beach.webcam_title === "string") ? beach.webcam_title : "";
  const frameTitle = title ? title : "Nearby webcam";
  const captionParts = [];
  if (title) {
    captionParts.push("<span class=\"webcam-title\">" + escapeHtml(title) + "</span>");
  }
  captionParts.push("Webcam via <a href=\"https://www.windy.com/webcams\" " +
    "rel=\"noopener noreferrer\">Windy.com</a>");
  const lines = [];
  lines.push("<section class=\"webcam-section wa-stack wa-gap-s\">");
  lines.push("<h2 class=\"webcam-heading wa-font-size-l\">Nearby webcam</h2>");
  lines.push("<iframe class=\"webcam-frame\" src=\"" + escapeHtml(playerUrl) + "\"" +
    " title=\"" + escapeHtml(frameTitle) + "\" loading=\"lazy\" allowfullscreen></iframe>");
  lines.push("<p class=\"webcam-caption wa-caption-s\">" + captionParts.join(" &middot; ") + "</p>");
  lines.push("</section>");
  return lines.join("\n");
}

// Quiet hour-tick row under the strip: "Now" pinned left, "+" + totalHours +
// " h" pinned right, and interior +6/+12/+18 h marks positioned by a
// server-computed left percentage (a genuinely per-instance value, so an inline
// style is the right tool here). aria-hidden — the chart's own description
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

// The slotted-JSON + pre-upgrade fallback-<p> tail shared by both wave charts:
// the config serialized to JSON with "<" escaped so it can never break out of
// the <script>, followed by the prose summary as the fallback paragraph. This
// is the single home for that XSS-hardening escape.
function chartScriptAndFallback(config, summary) {
  const configJson = JSON.stringify(config).split("<").join("\\u003c");
  return "<script type=\"application/json\">" + configJson + "</script>" +
    "<p class=\"wave-chart-fallback wa-caption-s\">" + escapeHtml(summary) + "</p>";
}

// The now-stat, per-model "now" caption, band-strip chart, and stale warning
// pieces of the wave forecast. Returned as named parts (not pre-joined) so the
// caller can interleave the model-comparison chart in the correct slot; hasNow
// gates whether the whole section renders. Pure.
function renderWaveStripParts(estimate, series, nowIso, wavesUpdated) {
  const hasNow = !!estimate && typeof estimate.waveHeightFt === "number" &&
    isFinite(estimate.waveHeightFt);
  const nowStat = hasNow
    ? ("<p class=\"wave-now\"><span class=\"wave-now-value wa-font-size-xl wa-font-weight-bold\">" +
        estimate.waveHeightFt.toFixed(1) + " ft</span> " +
        "<span class=\"wave-now-label wa-caption-s\">waves now (estimated)</span></p>")
    : "";

  let chartBlock = "";
  let staleHtml = "";
  let modelNowHtml = "";
  if (series) {
    const runs = computeWaveRuns(series.hoursFt);
    const summaryText = waveStripSummary(runs);
    const config = buildWaveChartConfig(runs);
    const totalHours = series.totalHours;
    const chartHtml = "<wa-bar-chart class=\"wave-chart\" index-axis=\"y\" " +
      "stacked min=\"0\" max=\"" + String(totalHours) + "\" grid=\"none\" without-legend " +
      "without-tooltip without-animation label=\"Wave height forecast for the next " +
      String(totalHours) + " hours\" description=\"" + escapeHtml(summaryText) + "\">" +
      chartScriptAndFallback(config, summaryText) + "</wa-bar-chart>";
    chartBlock = chartHtml + "\n" + renderWaveHourTicks(totalHours);
    if (isStale(nowIso, wavesUpdated)) {
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

// Collapsed model-comparison line chart: rendered only when two or more models
// are present in the trimmed window (a single model would just repeat the
// strip). Same slotted-JSON pattern as the strip. Returns "" otherwise. Pure.
function renderWaveModelCompare(series) {
  if (!series || orderedModelIds(series.byModel).length < 2) {
    return "";
  }
  const modelConfig = buildWaveModelChartConfig(series);
  const modelSummary = waveModelSummary(series);
  return "<wa-details class=\"wave-model-compare\" summary=\"Compare wave models\">" +
    "<wa-line-chart class=\"wave-model-chart\" without-animation y-label=\"ft\" " +
    "label=\"Wave height by forecast model\" description=\"" +
    escapeHtml(modelSummary) + "\">" +
    chartScriptAndFallback(modelConfig, modelSummary) +
    "</wa-line-chart></wa-details>";
}

// Wave forecast section (detail page): a "now" wave-height stat plus a Dark
// Sky-style horizontal color strip of the next up-to-24 hours, drawn by the
// <wa-bar-chart> component from a slotted JSON config (no inline JS). Colored by
// ESTIMATED wave height only — never the official flag. Returns "" when there
// is neither a finite now-height nor a renderable series.
function renderWaveForecast(estimate, waves, nowIso) {
  const series = trimWaveSeries(waves, nowIso);
  const strip = renderWaveStripParts(estimate, series, nowIso, waves && waves.updated);
  const modelCompareHtml = renderWaveModelCompare(series);

  // Neither the stat nor the strip has anything to render — omit the section.
  if (!strip.hasNow && !series) {
    return "";
  }

  const lines = [];
  lines.push("<section class=\"wave-forecast wa-stack wa-gap-s\">");
  lines.push("<div class=\"wa-cluster wa-gap-s\">" +
    "<h2 class=\"wave-forecast-heading wa-font-size-l\">Wave forecast</h2>" +
    renderEstimateBadge() + "</div>");
  if (strip.nowStat) {
    lines.push(strip.nowStat);
  }
  if (strip.modelNowHtml) {
    lines.push(strip.modelNowHtml);
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
  lines.push("<p class=\"wa-caption-s\">Colored by estimated wave height only — " +
    "green under 2 ft, yellow 2-4 ft, red 4 ft and up, gray no data. " +
    "Not the official flag.</p>");
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
  const title = displayName(beach) + " — Swim Report";
  const lat = Number(beach.lat).toFixed(4);
  const lon = Number(beach.lon).toFixed(4);

  // Title flag mirrors the best current reading: scraped official color when
  // available, otherwise the estimate (null-safe: no flag data renders gray).
  const titleColor = official ? official.color : (estimate ? estimate.color : null);
  const titleFlagHtml = renderFlagIcon(titleColor, "wa-font-size-4xl");

  const subtitle = subtitleName(beach);
  const subtitleHtml = subtitle ?
    ("<p class=\"beach-subtitle\">" + escapeHtml(subtitle) + "</p>") : "";

  const headerBlock = "<a class=\"back-link\" href=\"/\">" +
    "<wa-icon name=\"arrow-left\"></wa-icon> Back to all beaches</a>" +
    "<h1 class=\"beach-title wa-cluster wa-gap-s\">" + titleFlagHtml + "<span>" + escapeHtml(displayName(beach)) + "</span></h1>" +
    subtitleHtml +
    "<p class=\"wa-cluster wa-gap-2xs wa-color-text-quiet\">" +
    "<wa-icon name=\"location-dot\"></wa-icon> " + lat + ", " + lon +
    "</p>";

  const officialHtml = renderOfficialCard(official, nowIso);
  const estimateHtml = renderEstimateCard(estimate, nowIso);

  const stackParts = [];
  const waveMapHtml = renderWaveMap(beach);
  if (waveMapHtml) {
    stackParts.push(waveMapHtml);
  }
  if (officialHtml) {
    stackParts.push(officialHtml);
  }
  stackParts.push(estimateHtml);
  const waveForecastHtml = renderWaveForecast(estimate, waves, nowIso);
  if (waveForecastHtml) {
    stackParts.push(waveForecastHtml);
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
