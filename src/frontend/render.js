// Agent FRONTEND — src/frontend/render.js
//
// Pure, string-returning HTML renderers. No fetch, no Date, no DOM APIs at
// render time. "now" is always passed in by the caller (the router). HTML is
// built with string concatenation (+) and array.join("\n") — never template
// literals / backticks. const/let only, never var.

import { PAGE_STYLES } from "./styles.js";
import { LIST_SEARCH_SCRIPT } from "./searchScript.js";

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

function hostnameOf(urlStr) {
  if (!urlStr) {
    return "";
  }
  try {
    return new URL(urlStr).hostname;
  } catch {
    return urlStr;
  }
}

function firstSourceUrl(record) {
  if (!record) {
    return "";
  }
  if (record.source) {
    return record.source;
  }
  if (Array.isArray(record.sources) && record.sources.length > 0) {
    const first = record.sources[0];
    if (first && typeof first === "object") {
      return first.url || "";
    }
    return first;
  }
  return "";
}

function renderStaleWarning(updatedIso) {
  return "<wa-callout variant=\"warning\" size=\"s\">" +
    "<wa-icon slot=\"icon\" name=\"triangle-exclamation\"></wa-icon>" +
    "Stale data — last updated " + escapeHtml(updatedIso) + " UTC" +
    "</wa-callout>";
}

function renderFlagIcon(color, sizeClass, slotName) {
  const normalized = normalizeColor(color);
  const colorClass = "flag-icon-" + (normalized === "double-red" ? "red" : normalized);
  const iconClass = "flag-icon " + sizeClass + " " + colorClass;
  const slotAttr = slotName ? (" slot=\"" + slotName + "\"") : "";
  if (normalized === "double-red") {
    return "<span" + slotAttr + " class=\"flag-icon-stack\">" +
      "<wa-icon name=\"flag\" variant=\"solid\" class=\"" + iconClass + "\"></wa-icon>" +
      "<wa-icon name=\"flag\" variant=\"solid\" class=\"" + iconClass + "\"></wa-icon>" +
      "</span>";
  }
  return "<wa-icon" + slotAttr + " name=\"flag\" variant=\"solid\" class=\"" + iconClass + "\"></wa-icon>";
}

function renderFlagChip(estimate) {
  const color = estimate ? normalizeColor(estimate.color) : "unknown";
  const label = FLAG_LABELS[color];
  return "<wa-badge variant=\"neutral\" appearance=\"outlined\">" +
    renderFlagIcon(color, "flag-icon-s", "start") +
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

// Sources are { label, url } objects (label is the link text; url optional).
// Bare strings are the legacy shape — KV entries written before the labeled
// format live for up to 2 h, so both must render (as their hostname when
// URL-like). Returns inline links for the card header, or "" when empty.
function renderSourceLinks(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const items = [];
  for (const source of list) {
    if (source && typeof source === "object") {
      const label = source.label ? String(source.label) : String(source.url || "");
      if (isUrlLike(source.url)) {
        items.push("<a href=\"" + escapeHtml(source.url) + "\" rel=\"noopener noreferrer\">" +
          escapeHtml(label) + "</a>");
      } else if (label) {
        items.push("<span>" + escapeHtml(label) + "</span>");
      }
    } else if (isUrlLike(source)) {
      items.push("<a href=\"" + escapeHtml(source) + "\" rel=\"noopener noreferrer\">" +
        escapeHtml(hostnameOf(source)) + "</a>");
    } else if (source) {
      items.push("<span>" + escapeHtml(source) + "</span>");
    }
  }
  if (items.length === 0) {
    return "";
  }
  return "<span class=\"card-sources wa-cluster wa-gap-xs\">" + items.join("\n") + "</span>";
}

function renderFlagRow(color, reason) {
  return "<div class=\"wa-flank wa-gap-m\">" +
    renderFlagIcon(color, "flag-icon-l") +
    "<div class=\"wa-stack wa-gap-3xs\">" +
    "<span class=\"flag-color-label\">" + escapeHtml(FLAG_LABELS[color]) + "</span>" +
    "<p>" + escapeHtml(reason) + "</p>" +
    "</div>" +
    "</div>";
}

// Natural-language description of which rule branch decided the color, keyed
// by the estimate's trigger (set in src/rules.js). Keep in sync with the
// precedence chain in PLAN.md section 4.
const TRIGGER_DESCRIPTIONS = {
  "nws-alert": "Set by an active National Weather Service hazard alert — the highest-priority rule.",
  "rip-current": "Set by the rip current risk in the NWS surf zone forecast.",
  "wave-height": "Set by forecast wave height: 2 ft or higher raises yellow, 4 ft or higher raises red.",
  "wind": "No wave data was available, so this estimate fell back to wind-speed thresholds.",
  "rip-current-low": "No wave or wind data was available; based on the surf zone forecast's low rip current risk.",
  "no-data": "No usable data was available, so the flag is shown as unknown rather than guessed."
};

function renderTriggerLine(estimate) {
  const description = TRIGGER_DESCRIPTIONS[estimate.trigger];
  if (description) {
    return "<p class=\"card-trigger\">" + escapeHtml(description) + "</p>";
  }
  // Older KV payloads (written before triggers existed) fall back to the
  // rules-version line for the remainder of their 2 h TTL.
  return "<p class=\"card-trigger\">Rules version: " + escapeHtml(estimate.rules_version) + "</p>";
}

// Shared flag-card skeleton used by both the official and the estimate card so
// their layouts stay identical: badge in the header (left), source links in
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
    lines.push("<div slot=\"footer\" class=\"card-updated\">Updated " +
      escapeHtml(options.updated) + " UTC</div>");
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
    sourcesHtml: isMissing ? "" : renderSourceLinks(estimate.sources),
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
  const sourcesHtml = sourceUrl ?
    renderSourceLinks([{ label: hostnameOf(sourceUrl), url: sourceUrl }]) : "";
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
  return "<a class=\"brand-link\" href=\"/\">" +
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

function renderBeachRow(entry) {
  const beach = entry.beach;
  const estimate = entry.estimate;
  const official = entry.official;
  const dataName = escapeHtml(String(beach.name || "").toLowerCase());
  const href = "/beach/" + encodeURIComponent(beach.id);
  const officialBadgeHtml = official ? (" " + renderOfficialBadge("badge-s")) : "";
  const milesLabel = formatMiles(entry.distanceMi);
  const distanceHtml = milesLabel ?
    ("<span class=\"beach-row-distance\">" + escapeHtml(milesLabel) + "</span>") : "";
  const lines = [];
  lines.push("<li class=\"beach-row\" data-name=\"" + dataName + "\">");
  lines.push("<a class=\"beach-row-link\" href=\"" + escapeHtml(href) + "\">");
  lines.push("<span class=\"beach-row-name\">" + escapeHtml(beach.name) + distanceHtml + "</span>");
  lines.push("<span class=\"wa-cluster wa-gap-xs\">" + renderFlagChip(estimate) + officialBadgeHtml + "</span>");
  lines.push("<wa-icon name=\"chevron-right\" class=\"beach-row-chevron\"></wa-icon>");
  lines.push("</a>");
  lines.push("</li>");
  return lines.join("\n");
}

export function renderListPage(data) {
  const entries = (data && Array.isArray(data.entries)) ? data.entries : [];
  const rowsHtml = entries.map(renderBeachRow).join("\n");
  const hasEntries = entries.length > 0;
  const emptyMessage = hasEntries ? "No beaches match your search." : "No beaches found yet. Check back soon.";
  const emptyStyle = hasEntries ? " style=\"display: none;\"" : "";

  const sortNoteHtml = data && data.sortedByProximity ?
    ("<p class=\"list-sort-note wa-color-text-quiet\">" +
      "<wa-icon name=\"location-dot\"></wa-icon> " +
      "Sorted by approximate distance to you, based on your network location.</p>") : "";

  const introHtml = "<section class=\"list-intro wa-stack wa-gap-xs\">" +
    "<h1>Swim Report</h1>" +
    "<p class=\"wa-color-text-quiet\">Estimated beach hazard flags for pilot beaches across the " +
    "Great Lakes region.</p>" +
    sortNoteHtml +
    "</section>";

  const searchHtml = "<section class=\"list-search\">" +
    "<wa-input id=\"beach-search\" type=\"search\" label=\"Search beaches\" " +
    "placeholder=\"Search by beach name\" with-clear>" +
    "<wa-icon slot=\"start\" name=\"magnifying-glass\"></wa-icon>" +
    "</wa-input>" +
    "</section>";

  const listHtml = "<section class=\"beach-list-section\">" +
    "<ul class=\"beach-list wa-stack wa-gap-xs\" id=\"beach-list-items\">" + rowsHtml + "</ul>" +
    "<p id=\"beach-list-empty\"" + emptyStyle + " class=\"empty-state\">" +
    escapeHtml(emptyMessage) + "</p>" +
    "</section>";

  const mainHtml = introHtml + searchHtml + listHtml;
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
    "&zoom=11&overlay=waves&product=ecmwfWaves&level=surface" +
    "&lat=" + lat.toFixed(3) + "&lon=" + lon.toFixed(3);
  return "<section class=\"wave-map\">" +
    "<wa-zoomable-frame class=\"wave-map-frame\" src=\"" + escapeHtml(embedSrc) + "\"" +
    " loading=\"lazy\" without-controls></wa-zoomable-frame>" +
    "</section>";
}

export function renderDetailPage(data) {
  const beach = data.beach;
  const estimate = data.estimate;
  const official = data.official;
  const nowIso = data.nowIso;
  const title = beach.name + " — Swim Report";
  const lat = Number(beach.lat).toFixed(4);
  const lon = Number(beach.lon).toFixed(4);

  // Title flag mirrors the best current reading: scraped official color when
  // available, otherwise the estimate (null-safe: no flag data renders gray).
  const titleColor = official ? official.color : (estimate ? estimate.color : null);
  const titleFlagHtml = renderFlagIcon(titleColor, "flag-icon-l");

  const headerBlock = "<a class=\"back-link\" href=\"/\">" +
    "<wa-icon name=\"arrow-left\"></wa-icon> Back to all beaches</a>" +
    "<h1 class=\"beach-title\">" + titleFlagHtml + "<span>" + escapeHtml(beach.name) + "</span></h1>" +
    "<p class=\"beach-meta wa-cluster wa-gap-2xs\">" +
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

  const mainHtml = headerBlock +
    "<div class=\"detail-stack wa-stack wa-gap-l\">" + stackParts.join("\n") + "</div>";

  const bodyHtml = renderPageShell(renderBrandHeader(), mainHtml, renderFooter());
  return renderDocument(title, bodyHtml);
}

export function renderErrorPage(data) {
  const status = (data && data.status) ? data.status : 500;
  const message = (data && data.message) ? data.message : "Something went wrong.";

  const mainHtml = "<div class=\"error-panel wa-stack wa-gap-m wa-align-items-center\">" +
    "<wa-icon name=\"triangle-exclamation\" class=\"error-icon\"></wa-icon>" +
    "<h1>" + escapeHtml(String(status)) + "</h1>" +
    "<p>" + escapeHtml(message) + "</p>" +
    "<a href=\"/\">Return to the beach list</a>" +
    "</div>";

  const bodyHtml = renderPageShell(renderBrandHeader(), mainHtml, renderFooter());
  return renderDocument("Swim Report — " + String(status), bodyHtml);
}
