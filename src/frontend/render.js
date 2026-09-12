// Pure, string-returning HTML renderers for every page. No fetch, no Date and
// no DOM APIs at render time; "now" is always passed in by the router.

import { PAGE_STYLES } from "./styles.js";
import { LIST_SEARCH_SCRIPT } from "./searchScript.js";
import { LIST_SWAP_SCRIPT } from "./listSwapScript.js";
import { LIST_GEO_SCRIPT } from "./geoScript.js";
import { LIST_FAVORITES_SCRIPT, DETAIL_FAVORITE_SCRIPT } from "./favoritesScript.js";
import { buildListMapScript } from "./mapScript.js";
import { COLOR_SCHEME_SCRIPT } from "./colorSchemeScript.js";
import { DETAIL_HERO_SCRIPT } from "./backLinkScript.js";
import { WAVE_TICKS_SCRIPT } from "./waveTicksScript.js";
import { ROW_TRANSITION_SCRIPT } from "./rowTransitionScript.js";
import { renderFlagSvg } from "./flagGlyph.js";
import { decidedAlertDetails, alertInEffectAt, normalizeColor } from "../rules.js";
import { STALE_MS, isStale, collapseFlagColor, displayFlag } from "../displayFlag.js";
import { alertsCheckable } from "../alertsCheckable.js";
import { READING_MAX_AGE_MS } from "../officialReading.js";
import { verdictSentence } from "./verdict.js";
import { nextSunEvent, utcClockLabel } from "./sun.js";
import {
  trimWaveSeries,
  computeWaveRuns,
  computeHazardBands,
  waveStripSummary,
  waveOutlookSentence,
  modelNowCaption,
  orderedModelIds,
  buildWaveModelChartConfig,
  waveModelSummary
} from "./waveStrip.js";

// WAVE_STALE_MS is 8 h because the wave cycle publishes on its own slower
// cadence than the hourly flag recompute.
const WAVE_STALE_MS = 28800000;
// The water-temperature tile shows a reading only when it is this fresh;
// matches the parser window (NDBC_WATER_TEMP_MAX_OBS_AGE_MS) — water temp is
// slow-moving, so a several-hour-old reading is still faithful.
const WATER_TEMP_STALE_MS = 43200000; // 12 h — matches the parser window; water temp is slow-moving

// The canonical origin, so the canonical link, the share meta and the detail
// page's share controls can hand out an absolute URL without the renderer
// reading the request.
const SITE_ORIGIN = "https://swim.report";

// Web Awesome Pro CDN kit: version-pinned theme (matter), color palette
// (mild), native styles/reset, CSS utilities, and the component autoloader.
// The matching wa-theme-matter / wa-palette-mild classes go on <html>.
const WA_KIT_BASE = "https://ka-p.webawesome.com/kit/aa896405367b46f6/webawesome@3.12.0";

// MapLibre GL JS (pinned) + the OpenFreeMap positron style: browser-only assets
// for the home-page map (src/frontend/mapScript.js). Loaded from renderListPage,
// not from renderDocument's shared <head> — detail/error pages never pay for
// them, and the Worker itself never fetches them (two-path rule).
//
// MapLibre 6 ships ES modules only, so the inline map script pulls the .mjs in
// with a dynamic import(). Keep both pins on the same version.
const MAPLIBRE_JS = "https://unpkg.com/maplibre-gl@6.8.0/dist/maplibre-gl.mjs";
const MAPLIBRE_CSS = "https://unpkg.com/maplibre-gl@6.8.0/dist/maplibre-gl.css";

// Kit theme overrides, minus the kit's webfont downloads: each family leads
// with genuine system fonts so the pinned matter.css @font-face rules (served
// from bunny.net) never download. Heading is absent on purpose — matter.css
// aliases --wa-font-family-heading to --wa-font-family-body.
const WA_THEME_OVERRIDES = ":root {" +
  " --wa-font-family-body: system-ui, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;" +
  " --wa-font-family-code: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace;" +
  " --wa-font-family-longform: Rockwell, 'Rockwell Nova', 'DejaVu Serif', 'Sitka Small', serif;" +
  " }";

// One 1200x630 share card per display color, committed under public/ and built
// by scripts/build-brand-assets.js. The cards carry the flag graphic and no
// text, so the estimated-or-official wording lives only in the title and
// description and can never disagree with the image.
const OG_IMAGE_BASE = SITE_ORIGIN + "/og/";
const OG_IMAGE_WIDTH = "1200";
const OG_IMAGE_HEIGHT = "630";

// Surface colors as literal hex, the one place the theme cannot reach: a
// theme-color meta takes no CSS var. Matter's light surface is white and its
// dark surface is neutral-05.
const THEME_COLOR_LIGHT = "#ffffff";
const THEME_COLOR_DARK = "#121214";

// The list page's own description; the detail pages build theirs per beach.
const SITE_DESCRIPTION = "Estimated beach hazard flags for Great Lakes and " +
  "ocean-coast beaches across the United States and Canada.";

// One label per color normalizeColor coerces to.
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

/**
 * The visitor's browser formats the instant; the renderer only interpolates it.
 * @param {string} iso ISO 8601 timestamp
 * @returns {string} a live-updating <wa-relative-time> element
 */
function renderRelativeTime(iso) {
  return "<wa-relative-time date=\"" + escapeHtml(iso) + "\" sync></wa-relative-time>";
}

/**
 * @param {string} id id of the element the tooltip anchors to
 * @param {string} text tooltip body, escaped here
 * @returns {string} a <wa-tooltip> bound to that id
 */
function renderTooltipFor(id, text) {
  return "<wa-tooltip for=\"" + id + "\">" + escapeHtml(text) + "</wa-tooltip>";
}

// The flag color's tint class, used by renderFlagIcon (the UI's flags).
function flagIconColorClass(color) {
  return "flag-icon-" + collapseFlagColor(color);
}

// Flag wording for a meta description. FLAG_LABELS carries the UI's longer
// double-red phrasing, which does not read as a noun phrase mid-sentence.
const META_FLAG_WORDS = {
  "green": "GREEN",
  "yellow": "YELLOW",
  "red": "RED",
  "double-red": "DOUBLE RED"
};

// Alt text for each share card, describing the picture and nothing else: the
// flag status itself is stated in the title and description, which are the only
// place the estimated-or-official distinction can be made honestly.
const OG_IMAGE_ALT = {
  "green": "A green beach flag flying over a wave",
  "yellow": "A yellow beach flag flying over a wave",
  "red": "A red beach flag flying over a wave",
  "double-red": "Two red beach flags flying over a wave",
  "unknown": "A gray beach flag flying over a wave"
};

// A detail page's meta description: the page's displayFlag color, worded by its
// source. The wave clause is omitted rather than invented without a finite height.
function detailMetaDescription(beach, estimate, flag) {
  const phrase = flag.source === "none"
    ? "flag status unknown right now"
    : ((flag.source === "official" ? "official " : "estimated ") +
      META_FLAG_WORDS[flag.color] + " flag right now");
  const waves = (estimate && typeof estimate.waveHeightFt === "number" &&
    isFinite(estimate.waveHeightFt))
    ? (", " + estimate.waveHeightFt.toFixed(1) + " ft waves")
    : "";
  return displayName(beach) + ": " + phrase + waves + ".";
}

// Only an absolute http(s) URL may become an href; anything else (javascript:,
// data:, a relative path, a non-string) renders no link.
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

// Every scraper sets a non-empty scraped-page URL on an official record's
// source field, so that is the sole field read.
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
    "Stale data — last updated " + renderRelativeTime(updatedIso) +
    "</wa-callout>";
}

// The honest middle ground for a point-in-time official reading past the 2 h
// default but still inside its source's own cadence: a warning would cry wolf,
// and silence would let a morning observation read as current. The scraper's
// readingNote fragment is rendered neutral with the age appended. Recoloring a
// wa-callout is the classic way to break text contrast in one color scheme, so
// the note stays neutral.
function renderReadingNote(note, updatedIso) {
  return "<wa-callout variant=\"neutral\" size=\"s\">" +
    "<wa-icon slot=\"icon\" name=\"clock\"></wa-icon>" +
    escapeHtml(note) + " " + renderRelativeTime(updatedIso) + "." +
    "</wa-callout>";
}

// labelText (optional): accessible name for a standalone icon (the detail-page
// title). Without it the icon renders decorative (aria-hidden), which is right
// wherever visible flag text sits next to it.
// transitionName (optional): the view-transition-name this icon carries as the
// morph target of a list row's flag chip. It names one element per document, so
// only the detail-page title passes it.
function renderFlagIcon(color, sizeClass, slotName, labelText, transitionName) {
  const normalized = normalizeColor(color);
  const colorClass = flagIconColorClass(color);
  const iconClass = sizeClass + " " + colorClass;
  const slotAttr = slotName ? (" slot=\"" + slotName + "\"") : "";
  const transitionAttr = transitionName
    ? (" style=\"view-transition-name: " + escapeHtml(transitionName) + ";\"")
    : "";
  if (normalized === "double-red") {
    const labelAttrs = labelText
      ? (" role=\"img\" aria-label=\"" + escapeHtml(labelText) + "\"")
      : "";
    return "<span" + slotAttr + labelAttrs + transitionAttr + " class=\"wa-cluster wa-gap-2xs\">" +
      "<wa-icon name=\"flag\" class=\"" + iconClass + "\"></wa-icon>" +
      "<wa-icon name=\"flag\" class=\"" + iconClass + "\"></wa-icon>" +
      "</span>";
  }
  const labelAttr = labelText ? (" label=\"" + escapeHtml(labelText) + "\"") : "";
  return "<wa-icon" + slotAttr + labelAttr + transitionAttr +
    " name=\"flag\" class=\"" + iconClass + "\"></wa-icon>";
}

// slotName (optional): the wa-card slot this badge is slotted into directly, so
// a card header needs no wrapper element around it.
function renderEstimateBadge(slotName) {
  const slotAttr = slotName ? (" slot=\"" + slotName + "\"") : "";
  return "<wa-badge" + slotAttr + " variant=\"neutral\" appearance=\"outlined\">ESTIMATE</wa-badge>";
}

function renderOfficialBadge(sizeClass, slotName) {
  const cls = sizeClass ? (" class=\"" + sizeClass + "\"") : "";
  const slotAttr = slotName ? (" slot=\"" + slotName + "\"") : "";
  return "<wa-badge" + slotAttr + " variant=\"success\" appearance=\"filled\"" + cls + ">" +
    "<wa-icon slot=\"start\" name=\"circle-check\"></wa-icon>OFFICIAL</wa-badge>";
}

// The compact flag a list row or nearby card carries. The chip comes first,
// because ROW_TRANSITION_SCRIPT claims the link's first wa-badge; OFFICIAL
// follows only when the posted record supplied the chip's color.
function renderCompactFlag(flag) {
  // Short label only: "— water closed" wraps badly beside long park names.
  const label = flag.color === "double-red" ? "DOUBLE RED" : FLAG_LABELS[flag.color];
  const officialHtml = flag.source === "official" ? (" " + renderOfficialBadge(null)) : "";
  return "<span class=\"wa-cluster wa-gap-xs\">" +
    "<wa-badge variant=\"neutral\" appearance=\"outlined\">" +
    renderFlagIcon(flag.color, "wa-font-size-l", "start") + escapeHtml(label) +
    "</wa-badge>" + officialHtml + "</span>";
}

// The hero badge names the record displayFlag says supplied the color; an
// unknown is supplied by neither, so it carries no badge.
function renderHeroSourceBadge(flag) {
  if (flag.source === "official") {
    return renderOfficialBadge(null);
  }
  if (flag.source === "estimate") {
    return renderEstimateBadge();
  }
  return "";
}

// Estimate sources are { label, url } objects whose url is provenance only and
// is never rendered as a hyperlink; only official scraper sources link out. A
// bare string is also accepted, since KV entries written before the labeled
// format live for up to 2 h, and renders as its hostname when URL-like. Returns
// quiet filled-neutral badge chips, never variant="success": green is reserved
// for the official badge. The cluster slots into the card header directly.
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
  return "<span slot=\"header-actions\" class=\"wa-cluster wa-gap-2xs " +
    "wa-justify-content-end wa-font-size-xs\">" + items.join("\n") + "</span>";
}

// Official cards are the one place a source renders as a hyperlink: the
// scraped page is where a visitor can verify the posted flag upstream.
// Estimate sources (NWS, ECCC, NOAA wave models) stay plain text — see
// renderSourceLabels. Returns "" when the url is missing or not URL-like.
function renderOfficialSourceLink(url) {
  if (!isUrlLike(url)) {
    return "";
  }
  return "<a slot=\"header-actions\" class=\"wa-body-s\" href=\"" + escapeHtml(url) +
    "\" rel=\"noopener noreferrer\">" + escapeHtml(hostnameOf(url)) + "</a>";
}

function renderFlagRow(color, reason) {
  return "<div class=\"wa-flank wa-gap-s\">" +
    renderFlagIcon(color, "wa-font-size-4xl") +
    "<div class=\"wa-stack wa-gap-2xs\">" +
    "<span class=\"wa-heading-xl\">" + escapeHtml(FLAG_LABELS[color]) + "</span>" +
    "<p>" + escapeHtml(reason) + "</p>" +
    "</div>" +
    "</div>";
}

// The quiet provenance line for an official reading posted at a different site
// (OfficialFlag.reportedFor, PLAN.md section 1), so a card whose reason names
// another beach explains itself. Returns "" unless reportedFor is an object with
// a non-empty name; the distance is appended only when the record carries a
// finite one, never inferred.
function renderReportedFor(reportedFor) {
  if (!reportedFor || typeof reportedFor !== "object") {
    return "";
  }
  const name = typeof reportedFor.name === "string" ? reportedFor.name.trim() : "";
  if (name.length === 0) {
    return "";
  }
  const miles = typeof reportedFor.distanceMi === "number" &&
    isFinite(reportedFor.distanceMi)
    ? formatMiles(reportedFor.distanceMi)
    : "";
  // formatMiles already hedges ("~2 mi", "<1 mi"), so the sentence adds no
  // second hedge of its own.
  const text = "Reported for " + name +
    (miles ? ", " + miles + " away" : "");
  return "<p class=\"wa-caption-s\">" + escapeHtml(text) + "</p>";
}

const UTC_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// An instant as "Sep 9, 07:00 UTC". It names UTC for the reason renderSunTile's
// fallback does: only the viewer's browser knows the clock posted at the beach.
function utcStampLabel(iso) {
  const clock = utcClockLabel(iso);
  if (clock === null) {
    return null;
  }
  const at = new Date(Date.parse(iso));
  return UTC_MONTHS[at.getUTCMonth()] + " " + String(at.getUTCDate()) + ", " + clock;
}

// One alert timestamp on the viewer's own clock, with the UTC stamp as the
// light-DOM fallback wa-format-date renders until the component upgrades.
// "" when the instant is missing or unparseable.
function renderAlertTime(iso) {
  const label = utcStampLabel(iso);
  if (label === null) {
    return "";
  }
  const attr = escapeHtml(iso);
  return "<wa-format-date date=\"" + attr + "\" month=\"short\" day=\"numeric\" " +
    "hour=\"numeric\" minute=\"numeric\">" +
    "<time datetime=\"" + attr + "\">" + escapeHtml(label) + "</time>" +
    "</wa-format-date>";
}

// The alert's own window, phrased against whether it has started yet: an alert
// echoed ahead of its onset says when it starts, so the line never reads as a
// hazard that is already here. "" when the feed gave neither timestamp.
function renderAlertWindow(entry, nowIso) {
  const onsetHtml = renderAlertTime(entry.onset);
  const endsHtml = renderAlertTime(entry.ends);
  if (!alertInEffectAt(entry, nowIso) && onsetHtml !== "") {
    return endsHtml === ""
      ? ("Starts " + onsetHtml)
      : ("Starts " + onsetHtml + ", ends " + endsHtml);
  }
  if (endsHtml !== "") {
    return "In effect until " + endsHtml;
  }
  return onsetHtml === "" ? "" : "In effect since " + onsetHtml;
}

// The section form an issuing office writes inside an alert description:
// "* WHAT...High waves expected.", hard-wrapped to the product's own column
// width. Bounded label so a stray asterisk in prose cannot swallow a paragraph.
const ALERT_SECTION = /^\*\s*([A-Z][A-Z0-9 '\/-]{1,40}?)\s*\.\.\.\s*([\s\S]+)$/;

// "ADDITIONAL DETAILS" -> "Additional details".
function sentenceCase(text) {
  return text.charAt(0) + text.slice(1).toLowerCase();
}

// The description as paragraphs. Blank lines separate paragraphs; the single
// newlines inside one are the product's fixed-width wrapping and collapse to
// spaces, so the text reflows to the reader's column instead of the office's.
// A paragraph in the "* WHAT..." section form leads with its label; ECCC's
// unlabelled prose and anything that does not parse stay plain paragraphs.
function renderAlertDescription(text) {
  const blocks = text.split(/\n[ \t]*\n/);
  const paragraphs = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].replace(/\s*\n\s*/g, " ").trim();
    if (block.length === 0) {
      continue;
    }
    const match = ALERT_SECTION.exec(block);
    if (match) {
      paragraphs.push("<p><strong>" + escapeHtml(sentenceCase(match[1].trim())) +
        "</strong> " + escapeHtml(match[2].trim()) + "</p>");
    } else {
      paragraphs.push("<p>" + escapeHtml(block) + "</p>");
    }
  }
  return paragraphs.join("");
}

// One alert as a collapsed disclosure: the event name and its window always
// visible, the issuing office's own words behind the toggle. An alert the feed
// carried no text for has nothing to disclose, so it renders as the same header
// row without a toggle rather than an expander onto an empty panel.
function renderAlertEntry(entry, nowIso) {
  const windowHtml = renderAlertWindow(entry, nowIso);
  const summaryHtml = "<span class=\"wa-font-weight-semibold\">" + escapeHtml(entry.event) + "</span>" +
    (windowHtml === "" ? "" :
      "<span class=\"wa-caption-s\">" + windowHtml + "</span>");

  const body = [];
  if (typeof entry.description === "string" && entry.description.length > 0) {
    body.push(renderAlertDescription(entry.description));
  }
  if (typeof entry.instruction === "string" && entry.instruction.length > 0) {
    // The office's own call to action, weighted above the description it
    // follows and top-aligned so the icon sits on the first line.
    body.push("<p class=\"wa-flank wa-gap-xs wa-align-items-start wa-font-weight-semibold\">" +
      "<wa-icon name=\"circle-exclamation\"></wa-icon>" +
      "<span>" + escapeHtml(entry.instruction) + "</span></p>");
  }
  const sender = (typeof entry.sender === "string" && entry.sender.length > 0)
    ? entry.sender : null;
  const area = (typeof entry.area === "string" && entry.area.length > 0)
    ? entry.area : null;
  if (sender !== null || area !== null) {
    const provenance = sender === null
      ? ("For " + area)
      : ("Issued by " + sender + (area === null ? "" : " for " + area));
    body.push("<p class=\"wa-caption-s\">" + escapeHtml(provenance) + "</p>");
  }

  if (body.length === 0) {
    return "<div class=\"alert-detail alert-detail-bare wa-cluster wa-align-items-baseline\">" +
      summaryHtml + "</div>";
  }
  return "<wa-details class=\"alert-detail\" appearance=\"plain\" icon-placement=\"start\">" +
    "<span slot=\"summary\" class=\"alert-detail-summary wa-cluster wa-align-items-baseline\">" +
    summaryHtml + "</span>" +
    "<div class=\"wa-stack wa-gap-s wa-body-s\">" + body.join("") + "</div>" +
    "</wa-details>";
}

// Every alert the estimate was weighed against, in-effect ones first and feed
// order within each group, so the alert that chose the color sits above one
// echoed ahead of its onset. The reason line names an event; this is where a
// reader finds out what that event actually says. "" when nothing was echoed,
// which covers an estimate with no alertDetails at all.
function renderAlertDetails(estimate, nowIso) {
  const details = (estimate && Array.isArray(estimate.alertDetails)) ? estimate.alertDetails : [];
  const active = [];
  const upcoming = [];
  for (let i = 0; i < details.length; i++) {
    const entry = details[i];
    if (entry === null || typeof entry !== "object" ||
        typeof entry.event !== "string" || entry.event.length === 0) {
      continue;
    }
    (alertInEffectAt(entry, nowIso) ? active : upcoming).push(entry);
  }
  const ordered = active.concat(upcoming);
  if (ordered.length === 0) {
    return "";
  }
  const entries = [];
  for (let i = 0; i < ordered.length; i++) {
    entries.push(renderAlertEntry(ordered[i], nowIso));
  }
  return "<div class=\"alert-details wa-stack wa-gap-2xs\">" + entries.join("\n") + "</div>";
}

// Shared flag-card skeleton used by both the official and the estimate card so
// their layouts stay identical: badge in the header (left), source labels in
// header-actions (top right), flag row + stale warning in the body, "Updated"
// in the footer. badgeHtml and sourcesHtml carry their own slot attribute and
// are slotted with no wrapper element. The with-* attributes track slotted
// content per the wa-card SSR contract.
//
// Four optional options tune the body. Only renderOfficialCard passes the first
// three, so the estimate card always gets the plain 2 h behaviour; only
// renderEstimateCard passes the fourth, since no scraper publishes alert text:
//   staleMs          — this source's own staleness horizon; absent means STALE_MS.
//   readingNote      — copy for the neutral note shown between the 2 h default
//                      and that horizon.
//   reportedForHtml  — the provenance line for a reading posted at another site,
//                      shown under the flag row and above any callout.
//   alertDetailsHtml — the per-alert disclosures, below any callout so a stale
//                      warning is never pushed under an expander.
// The two callouts are mutually exclusive and the warning always wins: a card
// that is genuinely stale must never also carry a reassuring note beside it.
function renderFlagCard(options) {
  const attrs = " with-header" +
    (options.sourcesHtml ? " with-header-actions" : "") +
    (options.updated ? " with-footer" : "");
  const lines = [];
  lines.push("<wa-card class=\"" + options.cardClass + "\" appearance=\"" +
    options.appearance + "\"" + attrs + ">");
  lines.push(options.badgeHtml);
  if (options.sourcesHtml) {
    lines.push(options.sourcesHtml);
  }
  lines.push(renderFlagRow(options.color, options.reason));
  if (options.reportedForHtml) {
    lines.push(options.reportedForHtml);
  }
  if (options.updated) {
    // A source-declared horizon replaces the default outright; anything else
    // falls back to STALE_MS.
    const limit = typeof options.staleMs === "number" ? options.staleMs : STALE_MS;
    if (isStale(options.nowIso, options.updated, limit)) {
      lines.push(renderStaleWarning(options.updated));
    } else if (options.readingNote && isStale(options.nowIso, options.updated, STALE_MS)) {
      lines.push(renderReadingNote(options.readingNote, options.updated));
    }
  }
  if (options.alertDetailsHtml) {
    lines.push(options.alertDetailsHtml);
  }
  if (options.updated) {
    lines.push("<div slot=\"footer\" class=\"wa-caption-s\">Updated " +
      renderRelativeTime(options.updated) + "</div>");
  }
  lines.push("</wa-card>");
  return lines.join("\n");
}

function renderEstimateCard(estimate, nowIso) {
  const isMissing = estimate === null || estimate === undefined;
  return renderFlagCard({
    cardClass: "estimate-card",
    appearance: "outlined",
    badgeHtml: renderEstimateBadge("header"),
    color: isMissing ? "unknown" : normalizeColor(estimate.color),
    reason: isMissing ? "No estimate available yet" : (estimate.reason || "No data available"),
    sourcesHtml: isMissing ? "" : renderSourceLabels(estimate.sources),
    updated: isMissing ? null : (estimate.updated || null),
    alertDetailsHtml: isMissing ? "" : renderAlertDetails(estimate, nowIso),
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
    badgeHtml: renderOfficialBadge(null, "header"),
    color: normalizeColor(official.color),
    reason: official.reason || "",
    sourcesHtml: sourcesHtml,
    updated: official.updated || null,
    // Passed through raw: scrapeOfficialFlagFromResult is the validating
    // boundary and omits both fields unless the scraper declared them well, so
    // undefined here means no declaration and renderFlagCard falls back to the
    // 2 h default.
    staleMs: official.staleMs,
    readingNote: official.readingNote,
    reportedForHtml: renderReportedFor(official.reportedFor),
    nowIso: nowIso
  });
}

function renderBrandHeader() {
  return "<a class=\"icon-link wa-gap-xs wa-color-text-normal wa-heading-l\" href=\"/\">" +
    "<wa-icon name=\"person-swimming\"></wa-icon>Swim Report</a>";
}

// The disclaimer sentence below is a product invariant (PLAN.md section 9):
// estimates must never read as official flag status, on any page.
//
// wa-page makes the slotted <footer> a flex row (::slotted([slot='footer']) is
// display:flex; justify-content:space-between; flex-wrap:wrap), so sibling
// paragraphs would spread across it as wrapping flex items. The footer therefore
// carries one child: a centered <p> of three <small> lines. Line 1 is the
// disclaimer, line 2 the site-wide data-source attribution including the only
// Windy credit on the page, and line 3 the homepage map's basemap credit, which
// lives here as static text because mapScript.js disables attributionControl.
function renderFooter() {
  return "<p class=\"footer-lines wa-text-center\">" +
    "<small>Estimated — not the official flag status. " +
    "Always obey posted flags and lifeguards.</small><br>" +
    "<small>Thanks to " +
    "<a href=\"https://www.openstreetmap.org\" rel=\"noopener noreferrer\">OpenStreetMap</a> " +
    "for beach locations, " +
    "<a href=\"https://www.weather.gov\" rel=\"noopener noreferrer\">NOAA/NWS</a> + " +
    "<a href=\"https://weather.gc.ca\" rel=\"noopener noreferrer\">ECCC</a> " +
    "for marine and weather data, and " +
    "<a href=\"https://www.windy.com/webcams\" rel=\"noopener noreferrer\">Windy.com</a> " +
    "for webcams.</small><br>" +
    "<small>Map tiles by " +
    "<a href=\"https://openfreemap.org\" rel=\"noopener noreferrer\">OpenFreeMap</a> " +
    "(data © " +
    "<a href=\"https://www.openstreetmap.org/copyright\" rel=\"noopener noreferrer\">OpenStreetMap</a> " +
    "contributors), rendered with " +
    "<a href=\"https://maplibre.org\" rel=\"noopener noreferrer\">MapLibre</a>.</small>" +
    "</p>";
}

// Decorative layered wave swells anchored to the bottom of the document, behind
// all content. The layers carry no fill here; styles.js tints them from the
// theme's own text token so they flip with the wa-dark class.
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

// mainClass is an optional extra class on <main>, the hook a page widens its
// own measure with.
function renderPageShell(headerHtml, mainHtml, footerHtml, mainClass) {
  const lines = [];
  const extraClass = (typeof mainClass === "string" && mainClass.length > 0)
    ? (" " + mainClass) : "";
  // No navigation slot on any page, so the drawer this toggles is empty by
  // construction. Drop this attribute if a navigation slot is ever added.
  lines.push("<wa-page disable-navigation-toggle>");
  lines.push("<header slot=\"header\" class=\"app-header\">" + headerHtml + "</header>");
  lines.push("<main class=\"app-main" + extraClass + " wa-stack wa-gap-l\">" + mainHtml + "</main>");
  lines.push("<footer slot=\"footer\" class=\"app-footer wa-color-text-quiet\">" + footerHtml + "</footer>");
  lines.push("</wa-page>");
  return lines.join("\n");
}

// The tab icon. With no color it is the static brand flag under public/; on a
// beach page it is the same glyph in the beach's display color, inlined as a
// data: URI so the request path serves nothing new for it and the tab reads the
// flag before the page does. The SVG carries its own dark-scheme fill.
function renderIconTag(iconColor) {
  if (!iconColor) {
    return "<link rel=\"icon\" type=\"image/svg+xml\" href=\"/favicon.svg\">";
  }
  const color = normalizeColor(iconColor);
  const label = color === "unknown" ? "Flag status unknown" : color.replace("-", " ") + " flag";
  return "<link rel=\"icon\" type=\"image/svg+xml\" href=\"data:image/svg+xml," +
    encodeURIComponent(renderFlagSvg(color, label)) + "\">";
}

// Site identity, on every page including the error page: the touch icon, the
// installable manifest, and the two surface colors a browser paints its chrome
// with. All three files are static assets under public/, so nothing here is a
// request-path read.
const HEAD_IDENTITY_TAGS = [
  "<link rel=\"apple-touch-icon\" sizes=\"180x180\" href=\"/apple-touch-icon.png\">",
  "<link rel=\"manifest\" href=\"/manifest.webmanifest\">",
  "<meta name=\"theme-color\" media=\"(prefers-color-scheme: light)\" content=\"" +
    THEME_COLOR_LIGHT + "\">",
  "<meta name=\"theme-color\" media=\"(prefers-color-scheme: dark)\" content=\"" +
    THEME_COLOR_DARK + "\">"
];

// Description, canonical URL and share cards for one page, from a meta object of
// { title, description, path, flagColor, iconColor }; iconColor is read only by
// renderIconTag. Returns no lines at all when meta is
// absent, which is how the error page opts out: a 404 must never claim a
// canonical URL or offer itself as a share card.
function renderShareMeta(meta) {
  if (!meta) {
    return [];
  }
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const canonical = escapeHtml(SITE_ORIGIN + meta.path);
  const color = normalizeColor(meta.flagColor);
  const image = escapeHtml(OG_IMAGE_BASE + color + ".png");
  return [
    "<meta name=\"description\" content=\"" + description + "\">",
    "<link rel=\"canonical\" href=\"" + canonical + "\">",
    "<meta property=\"og:type\" content=\"website\">",
    "<meta property=\"og:site_name\" content=\"Swim Report\">",
    "<meta property=\"og:title\" content=\"" + title + "\">",
    "<meta property=\"og:description\" content=\"" + description + "\">",
    "<meta property=\"og:url\" content=\"" + canonical + "\">",
    "<meta property=\"og:image\" content=\"" + image + "\">",
    "<meta property=\"og:image:width\" content=\"" + OG_IMAGE_WIDTH + "\">",
    "<meta property=\"og:image:height\" content=\"" + OG_IMAGE_HEIGHT + "\">",
    "<meta property=\"og:image:alt\" content=\"" + escapeHtml(OG_IMAGE_ALT[color]) + "\">",
    "<meta name=\"twitter:card\" content=\"summary_large_image\">",
    "<meta name=\"twitter:title\" content=\"" + title + "\">",
    "<meta name=\"twitter:description\" content=\"" + description + "\">",
    "<meta name=\"twitter:image\" content=\"" + image + "\">"
  ];
}

// meta is optional: a page that passes none still gets the site identity tags,
// and no description, canonical or share card.
function renderDocument(title, bodyHtml, meta) {
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
  const metaLines = renderShareMeta(meta);
  for (let i = 0; i < metaLines.length; i = i + 1) {
    lines.push(metaLines[i]);
  }
  lines.push(renderIconTag(meta ? meta.iconColor : null));
  for (let i = 0; i < HEAD_IDENTITY_TAGS.length; i = i + 1) {
    lines.push(HEAD_IDENTITY_TAGS[i]);
  }
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

// The detail page's water-temperature reading ("72°F"), rendered as the value of
// the "at a glance" tile. Pure — nowIso is passed in; no fetch, no Date. The
// reading is display-only and never touches the flag color. Returns the reading
// only when waterTemp is a non-null object with a finite tempF and its
// observedIso parses to within WATER_TEMP_STALE_MS of nowIso; a missing or
// unparseable observedIso yields null rather than a stale value.
function waterTempLabel(waterTemp, nowIso) {
  if (waterTemp && typeof waterTemp === "object" &&
      typeof waterTemp.tempF === "number" && isFinite(waterTemp.tempF) &&
      !isStale(nowIso, waterTemp.observedIso, WATER_TEMP_STALE_MS) &&
      typeof waterTemp.observedIso === "string" &&
      !Number.isNaN(Date.parse(waterTemp.observedIso))) {
    return String(Math.round(waterTemp.tempF)) + "°F";
  }
  return null;
}

// The id the water-temperature tooltip anchors to; one detail page carries at
// most one water-temperature reading.
const WATER_TEMP_TOOLTIP_ID = "water-temp";

// Kilometres to miles, mirroring MI_PER_KM in src/geo.js (private there).
// Station distances arrive in km and every rendered distance is miles.
const KM_TO_MILES = 3958.8 / 6371;

// Provenance under the water temperature: which station read it, how far away
// that station sits, and how old the observation is. The source line and its tooltip
// state the same station and distance; the age renders live through
// <wa-relative-time>, so no time string is formatted here. A record with no
// station name and no usable distance yields the age alone, with no tooltip.
//
// wa-tooltip's default "hover focus" trigger only reaches an anchor the keyboard
// can land on, so a caption carrying a tooltip is focusable. The caption carries
// no aria-label: wa-tooltip points the anchor's aria-labelledby at itself while
// open and releases it on close, so the visible caption — the age included —
// stays the accessible name the rest of the time.
function waterTempProvenance(waterTemp) {
  const station = waterTemp && waterTemp.station && typeof waterTemp.station === "object"
    ? waterTemp.station : null;
  const name = station && typeof station.name === "string" ? station.name : "";
  const km = station ? station.distanceKm : null;
  const miles = typeof km === "number" && isFinite(km) ? formatMiles(km * KM_TO_MILES) : "";
  const facts = [];
  if (name) {
    facts.push(name);
  }
  if (miles) {
    facts.push(miles);
  }
  if (facts.length === 0) {
    return "<span class=\"water-temp-src\">" +
      renderRelativeTime(waterTemp.observedIso) + "</span>";
  }
  let labelText = "Water temperature measured ";
  if (name && miles) {
    labelText += "at " + name + ", " + miles + " away";
  } else if (name) {
    labelText += "at " + name;
  } else {
    labelText += miles + " away";
  }
  const caption = "<span class=\"water-temp-src\" id=\"" + WATER_TEMP_TOOLTIP_ID +
    "\" role=\"note\" tabindex=\"0\">" +
    escapeHtml(facts.join(" · ") + " · ") +
    renderRelativeTime(waterTemp.observedIso) + "</span>";
  return caption + renderTooltipFor(WATER_TEMP_TOOLTIP_ID, labelText);
}

// The ids the official morning reading's tooltips anchor to; one detail page
// carries at most one such reading.
const READING_TEMP_TOOLTIP_ID = "reading-temp";
const READING_WAVE_TOOLTIP_ID = "reading-wave";

// Pure. The official point-in-time reading a source scraped this morning, or null
// when there is none to show. The cron stamps the record an absolute expiry at
// READING_MAX_AGE_MS past the observation, so this check normally never fires; it
// is what guarantees a record that outlived its horizon — an old one replayed — is
// dropped rather than presented as this afternoon's water. A missing or unparseable observedIso
// yields null for the same reason it does for the buoy reading.
function usableReading(reading, nowIso) {
  if (!reading || typeof reading !== "object") {
    return null;
  }
  if (typeof reading.observedIso !== "string" ||
      Number.isNaN(Date.parse(reading.observedIso)) ||
      isStale(nowIso, reading.observedIso, READING_MAX_AGE_MS)) {
    return null;
  }
  return reading;
}

// Provenance under an official morning reading: the site the observation was
// taken at and how old it is, with a tooltip naming the source that published
// it. The site name is always rendered, so a beach reading a neighboring site's
// observation says whose it is. A record naming no site yields the age alone,
// with no tooltip.
//
// A caption carrying a tooltip is focusable, and names itself, for the same
// reasons waterTempProvenance's does.
function readingProvenance(reading, tooltipId) {
  const site = typeof reading.siteName === "string" ? reading.siteName.trim() : "";
  const label = typeof reading.sourceLabel === "string" ? reading.sourceLabel.trim() : "";
  if (!site) {
    return "<span class=\"water-temp-src\">" +
      renderRelativeTime(reading.observedIso) + "</span>";
  }
  const labelText = "Observed at " + site +
    (label ? (" and published by " + label) : "") +
    ". A morning reading, not a live one.";
  const caption = "<span class=\"water-temp-src\" id=\"" + tooltipId +
    "\" role=\"note\" tabindex=\"0\">" +
    escapeHtml(site + " · ") + renderRelativeTime(reading.observedIso) + "</span>";
  return caption + renderTooltipFor(tooltipId, labelText);
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

// The one heading shape every detail-page section below the hero uses: a
// leading decorative icon, sized between the h1 and body text so the page reads
// as a sequence of named parts. Every call site puts the h2 directly in a
// wa-stack, whose child reset supplies the zero margin. The id is what each
// section's aria-labelledby points at.
function renderSectionHeading(id, iconName, text) {
  return "<h2 id=\"" + id + "\" class=\"wa-cluster wa-gap-xs wa-heading-l\">" +
    "<wa-icon name=\"" + iconName + "\"></wa-icon>" + escapeHtml(text) + "</h2>";
}

function renderBeachRow(entry, nowIso) {
  const beach = entry.beach;
  const flag = displayFlag(entry, nowIso);
  // data-name feeds the client-side search filter: both the park name and the
  // beach's own name must match, so "Holland State Park" and "Ottawa Beach"
  // each find the same row.
  const searchable = (beach.park_name ? beach.park_name + " " : "") + String(beach.name || "");
  const dataName = escapeHtml(searchable.toLowerCase());
  const href = "/beach/" + encodeURIComponent(beach.id);
  const milesLabel = formatMiles(entry.distanceMi);
  const distanceHtml = span("beach-row-distance wa-caption-s", milesLabel);
  const subtitle = subtitleName(beach);
  const subtitleHtml = span("beach-row-subtitle wa-caption-s", subtitle);
  // data-flag is the row's displayFlag keyword, read by the green-only filter
  // and the inline-start border in styles.js, so chip, border, map marker and
  // detail title are one decision; unknown is a visible gray keyword, never omitted.
  const lines = [];
  lines.push("<li class=\"beach-row\" data-flag=\"" + flag.keyword + "\" data-name=\"" + dataName + "\">");
  lines.push("<a class=\"beach-row-link wa-cluster wa-flex-nowrap wa-border-radius-m\" " +
    "href=\"" + escapeHtml(href) + "\">");
  lines.push("<span class=\"beach-row-name wa-font-weight-semibold\">" + escapeHtml(displayName(beach)) + distanceHtml +
    subtitleHtml + "</span>");
  lines.push(renderCompactFlag(flag));
  lines.push("<wa-icon name=\"chevron-right\" class=\"wa-color-text-quiet\"></wa-icon>");
  lines.push("</a>");
  lines.push("</li>");
  return lines.join("\n");
}

// Homepage map: a purely visual MapLibre mount carrying no per-beach data.
// mapScript.js fetches the beaches from /api/beaches.geojson itself, so this
// renderer emits only the mount and the map center.
//
// The map is a visual supplement; the search box plus results list is the
// complete accessible path. The mount is therefore aria-hidden and out of the
// tab order, and it carries no landmark aria-label advertising a hidden map.
function renderHomeMap(near, location) {
  // Map center: the resolved user location that also sorts the list.
  // data-center-precise ("1" for a browser fix, "0" for the coarser IP estimate)
  // lets the browser zoom tighter on a real fix; with no location the attribute
  // is omitted and the browser fits all fetched features instead. Coordinates
  // round to 3 dp (~110 m), which keeps precise coordinates out of the markup.
  const centerLat = location ? Number(location.lat) : NaN;
  const centerLon = location ? Number(location.lon) : NaN;
  const centerAttrs = (isFinite(centerLat) && isFinite(centerLon))
    ? (" data-center=\"" + centerLat.toFixed(3) + "," + centerLon.toFixed(3) + "\"" +
       " data-center-precise=\"" + (near ? "1" : "0") + "\"")
    : "";
  // aria-hidden plus tabindex="-1" keep the visual-only map out of
  // assistive-tech and the keyboard tab order. The skeleton stands in until
  // mapScript.js removes it on the map's load event; MapLibre appends its canvas
  // to the mount rather than clearing it, so the two never collide.
  return "<div id=\"home-map\" class=\"home-map framed-embed wa-border-radius-m\" " +
    "aria-hidden=\"true\" tabindex=\"-1\"" + centerAttrs + ">" +
    "<wa-skeleton class=\"home-map-skeleton\" effect=\"sheen\"></wa-skeleton>" +
    "</div>";
}

// Empty, hidden shell for the visitor's saved and recently viewed beaches,
// filled in the browser by LIST_FAVORITES_SCRIPT from localStorage plus one
// "/?ids=" fetch. The server renders no rows here and knows nothing about the
// visitor: with no script, no stored ids or a failed fetch the section simply
// stays hidden. The two sub-labels ship hidden and are revealed only when both
// groups have rows.
function renderYourBeaches() {
  return "<section id=\"your-beaches\" class=\"wa-stack wa-gap-s\" " +
    "aria-labelledby=\"your-beaches-heading\" hidden>" +
    "<h2 id=\"your-beaches-heading\" class=\"wa-heading-l\">Your Beaches</h2>" +
    "<p id=\"your-beaches-saved-label\" class=\"wa-caption-s\" hidden>Saved</p>" +
    "<ul id=\"your-beaches-saved\" class=\"beach-list wa-list-plain wa-stack wa-gap-xs\"></ul>" +
    "<p id=\"your-beaches-recent-label\" class=\"wa-caption-s\" hidden>Recently viewed</p>" +
    "<ul id=\"your-beaches-recent\" class=\"beach-list wa-list-plain wa-stack wa-gap-xs\"></ul>" +
    "</section>";
}

// The empty-state copy for a list with no rows. Each of the three cases is a
// different claim, and the honest one matters: an ids page names ids, a
// q-filtered page names the search, and only the bare listing may say the
// database is empty.
function listEmptyMessage(idsMode, hasEntries, query) {
  if (idsMode) {
    return "No beaches match those ids";
  }
  if (hasEntries || query.length > 0) {
    return "No beaches match your search";
  }
  return "No beaches found yet";
}

// Supporting copy under the empty-state heading. Only the empty database has a
// next step to offer; a search miss and an unrecognized id list say it all in
// the heading.
function listEmptyNote(idsMode, hasEntries, query) {
  return (!idsMode && !hasEntries && query.length === 0) ? "Check back soon." : "";
}

export function renderListPage(data) {
  const entries = (data && Array.isArray(data.entries)) ? data.entries : [];
  const nowIso = (data && typeof data.nowIso === "string") ? data.nowIso : null;
  const rowsHtml = entries.map(function (entry) { return renderBeachRow(entry, nowIso); }).join("\n");
  const hasEntries = entries.length > 0;
  // On a q-filtered page the rendered rows are already the full-table matches;
  // only the default listing offers to submit the search server-side, and only
  // when more beaches exist than were rendered.
  const query = data && data.query ? String(data.query) : "";
  const nearParam = data && data.near ? String(data.near) : "";
  // Resolved user location for map centering, the same signal that
  // proximity-sorts the list. null keeps the map fitting the markers instead.
  const location = data && data.location ? data.location : null;
  const hasMore = !!(data && data.hasMore);
  const offerSearchAll = hasMore && query.length === 0;
  // Whether the rows were sorted by distance. The router decides it; the page
  // only heads the list with it.
  const sortedByProximity = !!(data && data.sortedByProximity);
  // The ?ids= mode renders one caller-chosen slice of the table, so it may not
  // assert data-complete however few rows it holds.
  const idsMode = !!(data && data.idsMode);

  // A q-filtered page with zero rows is a search miss, not an empty database, so
  // it gets the no-match copy just like the client-side filter miss, and an ids
  // page with zero rows is an unrecognized id list rather than either.
  const emptyMessage = listEmptyMessage(idsMode, hasEntries, query);
  const emptyNote = listEmptyNote(idsMode, hasEntries, query);
  const emptyHiddenAttr = hasEntries ? " hidden" : "";
  const searchAllHtml = offerSearchAll ?
    ("<wa-button type=\"submit\" form=\"beach-search-form\" variant=\"brand\">" +
      "Search all beaches</wa-button>") : "";

  const introHtml = "<section class=\"wa-stack wa-gap-xs\">" +
    "<h1>Swim Report</h1>" +
    "<p class=\"wa-color-text-quiet\">Estimated beach hazard flags across the " +
    "United States and Canada.</p>" +
    "</section>";

  const mapHtml = renderHomeMap(nearParam, location);

  // An active "near" param rides along in a hidden input so proximity sorting
  // survives a server-side submit.
  const nearHiddenHtml = nearParam ?
    ("<input type=\"hidden\" name=\"near\" value=\"" + escapeHtml(nearParam) + "\">") : "";
  const searchHtml = "<form id=\"beach-search-form\" method=\"get\" " +
    "action=\"/\" role=\"search\">" +
    "<wa-input id=\"beach-search\" name=\"q\" type=\"search\" value=\"" + escapeHtml(query) + "\" " +
    "label=\"Search beaches\" placeholder=\"Search by beach or park name\" with-clear>" +
    "<wa-icon slot=\"start\" name=\"magnifying-glass\"></wa-icon>" +
    "</wa-input>" +
    nearHiddenHtml +
    "</form>";

  // The active-query line lives inside a stable, always-present
  // #list-active-query container, empty on the default listing, so the client
  // scripts can swap it in place as the query changes.
  const backHref = "/" + (nearParam ? ("?near=" + encodeURIComponent(nearParam)) : "");
  const activeQueryInner = query.length > 0 ?
    ("<p class=\"wa-color-text-quiet\">Showing results for <strong>" +
      escapeHtml(query) + "</strong>. " +
      "<a href=\"" + escapeHtml(backHref) + "\">Clear search</a></p>") : "";
  const activeQueryHtml = "<div id=\"list-active-query\">" + activeQueryInner + "</div>";

  // Client-side green-only filter over each row's displayFlag keyword, which
  // either record may supply, so the label names no source. With no JS the
  // switch is inert and every row stays visible. It sits on the end edge of the
  // page stack, and a list with no rows to filter omits it entirely.
  const controlsHtml = hasEntries ?
    ("<wa-switch id=\"green-only-filter\" size=\"s\" class=\"wa-align-self-end\">" +
      "Green flags only</wa-switch>") : "";

  // Polite live region for the geolocation upgrade: geoScript.js swaps the list
  // in place with no navigation, so the reorder would otherwise be invisible to
  // screen-reader users. The script fills it after a successful swap.
  const geoLiveHtml =
    "<p id=\"geo-live-region\" class=\"wa-visually-hidden\" role=\"status\" aria-live=\"polite\"></p>";

  // data-complete is the contract searchScript reads to decide whether it may
  // skip the server round-trip: it asserts that the rendered rows are the whole
  // flag-worthy table, so the local filter is exhaustive. Only the default
  // no-query listing can assert it, because a q-filtered page's rows are query
  // matches rather than the full table.
  const listComplete = !hasMore && query.length === 0 && !idsMode;
  const completeAttr = listComplete ? " data-complete=\"1\"" : "";
  // The list names itself only when its rows are sorted by distance: an
  // alphabetical list is not nearby anything and may not claim to be. The
  // heading is not swapped, and it does not have to be — filtering or
  // re-fetching a distance-sorted list yields distance-sorted rows.
  const nearbyHeadingHtml = sortedByProximity ?
    "<h2 id=\"nearby-heading\" class=\"wa-heading-l\">Nearby</h2>" : "";
  const listLabelAttr = sortedByProximity ? " aria-labelledby=\"nearby-heading\"" : "";
  const listHtml = "<section class=\"beach-list-section wa-stack wa-gap-s\"" + listLabelAttr + ">" +
    nearbyHeadingHtml +
    "<ul class=\"beach-list wa-list-plain wa-stack wa-gap-xs\" id=\"beach-list-items\"" + completeAttr + ">" + rowsHtml + "</ul>" +
    // The centered empty-state block: glyph, heading, optional note, CTA. Both
    // client scripts hold #beach-list-empty by reference and toggle its hidden
    // attribute, and searchScript.js rewrites .empty-state-message in place, so
    // the id, the class and the attribute are the contract.
    "<div id=\"beach-list-empty\" class=\"empty-state wa-stack wa-gap-l wa-align-items-center wa-text-center\"" +
    emptyHiddenAttr + ">" +
    "<wa-icon name=\"umbrella-beach\" class=\"wa-font-size-4xl wa-color-text-quiet\"></wa-icon>" +
    "<h2 class=\"empty-state-message wa-heading-l\">" + escapeHtml(emptyMessage) + "</h2>" +
    (emptyNote ? ("<p class=\"wa-color-text-quiet\">" + escapeHtml(emptyNote) + "</p>") : "") +
    searchAllHtml +
    "</div>" +
    "</section>";

  const mainHtml = introHtml + mapHtml + searchHtml + activeQueryHtml + controlsHtml +
    geoLiveHtml + renderYourBeaches() + listHtml;
  const bodyHtml = renderPageShell(renderBrandHeader(), mainHtml, renderFooter()) +
    "<script>" + LIST_SWAP_SCRIPT + "</script>" +
    "<script>" + LIST_SEARCH_SCRIPT + "</script>" +
    "<script>" + LIST_GEO_SCRIPT + "</script>" +
    "<script>" + LIST_FAVORITES_SCRIPT + "</script>" +
    "<script>" + ROW_TRANSITION_SCRIPT + "</script>" +
    "<link rel=\"stylesheet\" href=\"" + MAPLIBRE_CSS + "\">" +
    "<script>" + buildListMapScript(MAPLIBRE_JS) + "</script>";

  // The canonical is the bare "/" whatever the q or near params are: those are a
  // filtered or geolocated view of the same page, not pages of their own. The
  // share card is the gray unknown flag, because the index reports no one
  // beach's color and must not imply one.
  return renderDocument("Swim Report", bodyHtml, {
    title: "Swim Report",
    description: SITE_DESCRIPTION,
    path: "/",
    flagColor: "unknown"
  });
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

// Nearby beaches, last in the detail stack: one card per entry in a responsive
// wa-grid. Each card is one link carrying the same displayFlag chip, and
// OFFICIAL badge when earned, that a list row does, so the estimated/official
// distinction reads the same on every surface. Entries arrive distance-sorted
// from the router; an empty list renders nothing rather than an empty heading.
function renderNearbyCard(entry, nowIso) {
  const beach = entry.beach;
  const href = "/beach/" + encodeURIComponent(beach.id);
  const flag = displayFlag(entry, nowIso);
  const subtitleHtml = span("wa-caption-s", subtitleName(beach));
  const distanceHtml = span("wa-caption-s", formatMiles(entry.distanceMi));
  return "<wa-card class=\"nearby-card\" appearance=\"outlined\">" +
    "<a class=\"nearby-card-link wa-link-plain wa-stack wa-gap-xs\" href=\"" + escapeHtml(href) + "\">" +
    "<span class=\"nearby-card-name wa-font-weight-semibold\">" + escapeHtml(displayName(beach)) + "</span>" +
    subtitleHtml +
    renderCompactFlag(flag) +
    distanceHtml +
    "</a>" +
    "</wa-card>";
}

function renderNearby(nearby, nowIso) {
  const entries = Array.isArray(nearby) ? nearby : [];
  if (entries.length === 0) {
    return "";
  }
  const cards = entries.map(function (entry) { return renderNearbyCard(entry, nowIso); }).join("\n");
  return "<section class=\"wa-stack wa-gap-s\" aria-labelledby=\"nearby-heading\">" +
    renderSectionHeading("nearby-heading", "location-dot", "Nearby beaches") +
    "<div class=\"wa-grid wa-gap-m nearby-grid\">" + cards + "</div>" +
    "</section>";
}

// Nearby-webcam player embedded from Windy's free webcam API, in the same
// plain-<iframe> wrapper as the wave map. The browser fetches the embed; the
// request path itself still reads only D1 and KV. Rendered only when
// webcam_player_url is a non-empty string, so both null (no nearby cam) and
// undefined are skipped. The cam is the nearest active one within a few kilometres,
// so the "Nearby webcam" heading and the always-rendered note keep the page from
// implying the view is of this beach. The caption carries the cam's own Windy
// detail page as a "View on Windy" link when webcam_detail_url is an http(s) URL:
// the Windy webcams Terms require every displayed cam to link its webcam page or
// player, and the footer credit alone does not satisfy that per-cam obligation. The
// site-wide credit stays in the footer. The frame's accessible name falls back to
// "Nearby webcam" when the title is empty.
function renderWebcam(beach) {
  const playerUrl = beach.webcam_player_url;
  if (typeof playerUrl !== "string" || playerUrl.length === 0) {
    return "";
  }
  const title = (typeof beach.webcam_title === "string") ? beach.webcam_title : "";
  const detailUrl = isUrlLike(beach.webcam_detail_url) ? beach.webcam_detail_url : null;
  const frameTitle = title ? title : "Nearby webcam";
  const lines = [];
  lines.push("<section class=\"wa-stack wa-gap-s\" " +
    "aria-labelledby=\"webcam-heading\">");
  lines.push(renderSectionHeading("webcam-heading", "video", "Nearby webcam"));
  lines.push("<div class=\"wa-frame:landscape wa-border-radius-m framed-embed\">" +
    "<iframe class=\"webcam-frame\" src=\"" + escapeHtml(playerUrl) + "\"" +
    " title=\"" + escapeHtml(frameTitle) + "\" loading=\"lazy\" allowfullscreen></iframe>" +
    "</div>");
  if (title || detailUrl !== null) {
    const captionParts = [];
    if (title) {
      captionParts.push("<span>" + escapeHtml(title) + "</span>");
    }
    if (detailUrl !== null) {
      captionParts.push("<a href=\"" + escapeHtml(detailUrl) + "\"" +
        " rel=\"noopener noreferrer\" target=\"_blank\">View on Windy</a>");
    }
    lines.push("<p class=\"wa-caption-s wa-cluster wa-gap-xs\">" +
      captionParts.join("") + "</p>");
  }
  lines.push("<p class=\"wa-caption-s\">This camera is near this beach and " +
    "may not show the beach itself.</p>");
  lines.push("</section>");
  return lines.join("\n");
}

// Rendered marker for the tick row, matched by the detail page to decide
// whether to ship the relabelling script. Kept beside the renderer that emits
// it so the two cannot drift apart.
const WAVE_TICKS_ROW_MARKER = "<div class=\"wave-chart-hours";

// The data-iso attribute a tick carries so waveTicksScript.js can relabel it in
// the viewer's own clock: the trimmed series start advanced by the tick's hour
// offset. An unparseable start emits no attribute, leaving the relative label
// as the only claim rather than one rewritten from a guessed instant.
function tickIsoAttr(startMs, hourOffset) {
  if (Number.isNaN(startMs)) {
    return "";
  }
  return " data-iso=\"" +
    escapeHtml(new Date(startMs + hourOffset * 3600000).toISOString()) + "\"";
}

// Quiet hour-tick row under the strip, with interior marks positioned by a
// server-computed left percentage. The relative labels are the rendered truth,
// since D1 carries no per-beach timezone; data-iso is what the browser upgrades
// them from. aria-hidden, since the strip's aria-label and summary already
// convey the timeline.
function renderWaveHourTicks(totalHours, startIso) {
  const startMs = Date.parse(startIso);
  const parts = [];
  parts.push("<div class=\"wave-chart-hours wa-caption-xs\" aria-hidden=\"true\">");
  parts.push("<span class=\"wave-chart-hour wave-chart-hour-start\"" +
    tickIsoAttr(startMs, 0) + ">Now</span>");
  const marks = [6, 12, 18];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark < totalHours) {
      const pct = (mark / totalHours) * 100;
      parts.push("<span class=\"wave-chart-hour\"" + tickIsoAttr(startMs, mark) +
        " style=\"left: " + pct + "%;\">+" + mark + " h</span>");
    }
  }
  parts.push("<span class=\"wave-chart-hour wave-chart-hour-end\"" +
    tickIsoAttr(startMs, totalHours) + ">+" + totalHours + " h</span>");
  parts.push("</div>");
  return parts.join("");
}

// The slotted-JSON and pre-upgrade fallback-<p> tail for the model-comparison
// chart: the config serialized to JSON with "<" escaped so it can never break
// out of the <script>, followed by the prose summary as the fallback paragraph.
// This is the single home for that XSS-hardening escape.
function chartScriptAndFallback(config, summary) {
  const configJson = JSON.stringify(config).split("<").join("\\u003c");
  return "<script type=\"application/json\">" + configJson + "</script>" +
    "<p class=\"wave-chart-fallback wa-caption-s\">" + escapeHtml(summary) + "</p>";
}

// Colored wave-strip: one flex segment per run, sized by flex-grow on run.hours
// so there is no percentage rounding drift, and colored by the run's palette
// token. Each segment is focusable so wa-tooltip's default "hover focus" trigger
// covers keyboard and tap, and the tooltip and aria-label carry the same text.
// Tooltip hosts render position: absolute, so emitting them as siblings adds no
// layout space. The visually-hidden paragraph preserves the prose summary.
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
    // --i is the segment's index, the stagger step for the fill-in animation.
    segs.push("<div class=\"wave-strip-seg\" id=\"" + id + "\" role=\"listitem\"" +
      " tabindex=\"0\" aria-label=\"" + escapeHtml(text) + "\"" +
      " style=\"flex: " + run.hours + " " + run.hours + " 0%; background: " +
      run.tokenVar + "; --i: " + i + ";\"></div>");
    tips.push(renderTooltipFor(id, text));
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
//
// The outlook sentence rides the same line as the now-stat, or the badge-only
// row that stands in for it, so the ESTIMATE framing always covers it.
function renderWaveStripParts(estimate, series, nowIso, wavesUpdated, waterClass) {
  const runs = series ? computeWaveRuns(series.hoursFt, waterClass) : [];
  const outlook = waveOutlookSentence(runs);
  const outlookHtml = outlook
    ? (" <span class=\"wave-outlook wa-caption-s\">" + escapeHtml(outlook) + "</span>")
    : "";

  const hasNow = !!estimate && typeof estimate.waveHeightFt === "number" &&
    isFinite(estimate.waveHeightFt);
  const nowStat = hasNow
    ? ("<p class=\"wave-now wa-cluster wa-gap-s\"><span class=\"wave-now-value wa-heading-xl\">" +
        estimate.waveHeightFt.toFixed(1) + " ft</span> " +
        "<span class=\"wave-now-label wa-caption-s\">waves now</span> " +
        renderEstimateBadge() + outlookHtml + "</p>")
    : "";

  let chartBlock = "";
  let staleHtml = "";
  let modelNowHtml = "";
  if (series) {
    const summaryText = waveStripSummary(runs);
    const totalHours = series.totalHours;
    const chartHtml = renderWaveStrip(runs, totalHours, summaryText);
    chartBlock = chartHtml + "\n" + renderWaveHourTicks(totalHours, series.startIso);
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
    outlookHtml: outlookHtml,
    modelNowHtml: modelNowHtml,
    chartBlock: chartBlock,
    staleHtml: staleHtml
  };
}

// Hazard lane above the wave strip: one positioned band row per active hazard,
// either a flag-relevant NWS alert with its time period or a rip-current risk.
// The visible label carries the hazard name, CSS-ellipsized when the span is
// short, and the tooltip and aria-label carry the full name-plus-period text.
// Returns "" for no bands.
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
      "<div class=\"wave-alert-band " + band.variantClass + "\" id=\"" + id + "\"" +
      " role=\"note\" tabindex=\"0\"" +
      " aria-label=\"" + escapeHtml(band.text) + "\"" +
      " style=\"left: " + band.leftPct + "%; width: " + band.widthPct + "%;\">" +
      "<span class=\"wave-alert-label wa-text-truncate\">" + escapeHtml(band.label) + "</span>" +
      "</div></div>");
    tips.push(renderTooltipFor(id, band.text));
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
    "<wa-line-chart class=\"wave-model-chart\" without-animation y-label=\"ft\" " +
    "label=\"Wave height by forecast model\" description=\"" +
    escapeHtml(modelSummary) + "\">" +
    chartScriptAndFallback(modelConfig, modelSummary) +
    "</wa-line-chart></wa-details>";
}

// Wave forecast section (detail page): a "now" wave-height stat plus a
// horizontal color strip of the next up-to-24 hours. Colored by estimated wave
// height only, against the beach's water-class thresholds, never the official
// flag. Returns "" when there is neither a finite now-height nor a renderable
// series.
function renderWaveForecast(estimate, waves, nowIso, waterClass) {
  const series = trimWaveSeries(waves, nowIso);
  const strip = renderWaveStripParts(estimate, series, nowIso, waves && waves.updated, waterClass);
  const modelCompareHtml = renderWaveModelCompare(series);
  // The hazard lane needs the strip's timeline to position bands against, and
  // with no renderable series there is nothing to overlay; the estimate card
  // still names any active alert in its reason.
  const hazardHtml = series
    ? renderHazardLane(computeHazardBands(estimate, series.totalHours, nowIso))
    : "";

  // Neither the stat nor the strip has anything to render — omit the section.
  if (!strip.hasNow && !series) {
    return "";
  }

  const lines = [];
  lines.push("<section class=\"wave-forecast wa-stack wa-gap-s\" " +
    "aria-labelledby=\"wave-forecast-heading\">");
  lines.push(renderSectionHeading("wave-forecast-heading", "chart-line", "Wave forecast"));
  if (strip.nowStat) {
    lines.push(strip.nowStat);
  } else {
    // With no now-stat the ESTIMATE badge normally riding the stat line still
    // has to mark the section as estimated; that framing is a product invariant.
    lines.push("<div class=\"wa-cluster wa-gap-s\">" + renderEstimateBadge() +
      strip.outlookHtml + "</div>");
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

// The raise-only water-quality floor the estimate already folded in (rules.js
// step 7), surfaced beside the estimate card so a bacteria advisory under a
// wave-height red stays visible. Advisory context only: no OFFICIAL badge and
// no official-card border, since the record is never a posted flag status.
// An absent, malformed or unknown-color record renders nothing.
function renderWqFloorCallout(wqfloor) {
  if (!wqfloor || typeof wqfloor !== "object" || Array.isArray(wqfloor)) {
    return "";
  }
  const color = wqfloor.color;
  if (color !== "yellow" && color !== "red") {
    return "";
  }
  const reason = typeof wqfloor.reason === "string" ? wqfloor.reason.trim() : "";
  if (reason === "") {
    return "";
  }
  // The record's source is a human label, never a URL, so it renders as plain
  // escaped text with no link.
  const source = typeof wqfloor.source === "string" ? wqfloor.source.trim() : "";
  const updated = typeof wqfloor.updated === "string" ? wqfloor.updated.trim() : "";
  const variant = color === "red" ? "danger" : "warning";
  let html = "<wa-callout variant=\"" + variant + "\" size=\"s\">" +
    "<wa-icon slot=\"icon\" name=\"droplet\"></wa-icon>" +
    "<strong>Water quality advisory</strong><br>" +
    escapeHtml(reason);
  if (source !== "") {
    html += "<br><span class=\"wa-caption-s\">Source: " +
      escapeHtml(source) + "</span>";
  }
  if (updated !== "") {
    html += "<br><span class=\"wa-caption-s\">Updated " +
      renderRelativeTime(updated) + "</span>";
  }
  return html + "</wa-callout>";
}

// One "at a glance" tile: a quiet icon, the reading, its caption, and an
// optional quiet source line saying where the reading comes from. Callers
// render a tile only when they have a reading, so there is no empty-value
// branch here.
// options.quiet renders a present-but-negative answer ("None active") in the
// same quiet weight, so only a real reading carries the loud value type.
// options.valueHtml is inserted raw and wins over options.value, for the one
// reading that is a formatted time rather than text; the caller escapes it.
function renderGlanceTile(options) {
  const hasValueHtml = typeof options.valueHtml === "string" && options.valueHtml.length > 0;
  const valueClass = options.quiet
    ? "wa-body-l wa-color-text-quiet"
    : "wa-heading-xl";
  const valueHtml = hasValueHtml ? options.valueHtml : escapeHtml(options.value);
  const sourceHtml = typeof options.sourceHtml === "string" && options.sourceHtml.length > 0
    ? "<span class=\"wa-caption-s\">" + options.sourceHtml + "</span>"
    : "";
  return "<wa-card class=\"glance-tile\" appearance=\"outlined\">" +
    "<div class=\"wa-stack wa-gap-2xs\">" +
    "<wa-icon class=\"wa-color-text-quiet wa-font-size-l\" name=\"" + options.icon + "\"></wa-icon>" +
    "<span class=\"" + valueClass + "\">" + valueHtml + "</span>" +
    "<span class=\"wa-caption-s wa-font-weight-semibold\">" + escapeHtml(options.caption) + "</span>" +
    sourceHtml +
    "</div>" +
    "</wa-card>";
}

// The next sunrise or sunset for this beach, computed from its coordinates and
// the passed-in now (src/frontend/sun.js) rather than fetched. Returns the empty
// string where there is no next event — no coordinates, or a polar day or night.
// wa-format-date renders the instant on the viewer's own clock, and renders
// nothing until the component upgrades, so its light-DOM child is the tile's
// server-rendered answer. That fallback names UTC: the beach's longitude only
// fixes its solar day, and is up to two hours from the clock posted at the beach.
function renderSunTile(beach, nowIso) {
  const lat = (beach.lat === null || beach.lat === undefined) ? NaN : Number(beach.lat);
  const lon = (beach.lon === null || beach.lon === undefined) ? NaN : Number(beach.lon);
  const hasCoords = isFinite(lat) && isFinite(lon);
  const event = hasCoords ? nextSunEvent(lat, lon, nowIso) : null;
  if (!event) return "";
  const iso = escapeHtml(event.iso);
  return renderGlanceTile({
    icon: "sun",
    valueHtml: "<wa-format-date date=\"" + iso + "\" hour=\"numeric\" minute=\"numeric\">" +
      "<time datetime=\"" + iso + "\">" + escapeHtml(utcClockLabel(event.iso)) + "</time>" +
      "</wa-format-date>",
    caption: event.type === "sunset" ? "Sunset" : "Sunrise"
  });
}

// The readings a visitor scans before reading the cards, as small tiles under
// the hero. A reading nobody published gets no tile at all, so the row carries
// only answers; with no readings at all the whole section is omitted. Every tile
// is estimated or display-only data — the ESTIMATE badge and the quiet source
// lines say which for each — so the tiles stay outlined and carry none of the
// official card's treatment.
//
// alertsCheckable is not on the estimate and is deliberately not in the seal
// (src/flagInputs.js), so the tile reads it from the beach row through the same
// shared predicate the cron uses. A beach whose alerts were never checkable has
// no alerts tile: "none active" would be a claim nobody made.
function renderAtAGlance(beach, estimate, waterTemp, reading, nowIso) {
  const tiles = [];
  const morning = usableReading(reading, nowIso);

  const hasWave = !!estimate && typeof estimate.waveHeightFt === "number" &&
    isFinite(estimate.waveHeightFt);
  if (hasWave) {
    tiles.push(renderGlanceTile({
      icon: "water",
      value: estimate.waveHeightFt.toFixed(1) + " ft",
      caption: "Waves now",
      sourceHtml: renderEstimateBadge()
    }));
  }

  // The observed morning wave height sits BESIDE the modeled "Waves now" tile
  // rather than replacing it: one is a measurement taken hours ago, the other a
  // model value for this hour, and the reader wants both. Whole feet, as
  // reported — a .0 here would claim a precision the source does not publish.
  if (morning && typeof morning.waveHeightFt === "number" &&
      isFinite(morning.waveHeightFt)) {
    tiles.push(renderGlanceTile({
      icon: "water",
      value: String(morning.waveHeightFt) + " ft",
      caption: "Waves this morning",
      sourceHtml: readingProvenance(morning, READING_WAVE_TOOLTIP_ID)
    }));
  }

  // An official reading taken at the beach wins over the NDBC buoy, which may
  // sit up to 25 km offshore. Either way the tile's source line and tooltip name
  // where the water was measured.
  if (morning && typeof morning.waterTempF === "number" &&
      isFinite(morning.waterTempF)) {
    tiles.push(renderGlanceTile({
      icon: "temperature-half",
      value: String(Math.round(morning.waterTempF)) + "°F",
      caption: "Water temperature",
      sourceHtml: readingProvenance(morning, READING_TEMP_TOOLTIP_ID)
    }));
  } else {
    // The reading's station, distance and age are the tile's source line, tooltip
    // included, so a temperature read up to 25 km away always says so.
    const tempLabel = waterTempLabel(waterTemp, nowIso);
    if (tempLabel) {
      tiles.push(renderGlanceTile({
        icon: "temperature-half",
        value: tempLabel,
        caption: "Water temperature",
        sourceHtml: waterTempProvenance(waterTemp)
      }));
    }
  }

  const risk = estimate ? estimate.ripCurrentRisk : null;
  if (risk === "HIGH" || risk === "MODERATE" || risk === "LOW") {
    tiles.push(renderGlanceTile({
      icon: "person-drowning",
      value: risk,
      caption: "Rip current risk",
      sourceHtml: "NWS surf zone forecast"
    }));
  }

  // Counts only the alerts the color was decided against. An alert echoed
  // ahead of its onset is named on the quiet tile instead, so the count never
  // contradicts the flag it sits under.
  const details = (estimate && Array.isArray(estimate.alertDetails)) ? estimate.alertDetails : null;
  const active = decidedAlertDetails(estimate);
  if (active.length > 0) {
    const first = active[0];
    const alertSource = (typeof first.event === "string" && first.event.length > 0)
      ? first.event : "NWS and ECCC alerts";
    tiles.push(renderGlanceTile({
      icon: "triangle-exclamation",
      value: String(active.length),
      caption: "Active alerts",
      sourceHtml: escapeHtml(alertSource)
    }));
  } else if (details && alertsCheckable(beach)) {
    let upcoming = null;
    for (let i = 0; i < details.length && upcoming === null; i++) {
      const entry = details[i];
      if (entry && typeof entry.event === "string" && entry.event.length > 0) {
        upcoming = entry.event;
      }
    }
    tiles.push(renderGlanceTile({
      icon: "triangle-exclamation",
      value: "None active",
      quiet: true,
      caption: "Active alerts",
      sourceHtml: escapeHtml(upcoming === null ? "NWS and ECCC alerts" : upcoming + " not yet in effect")
    }));
  }

  const sunHtml = renderSunTile(beach, nowIso);
  if (sunHtml !== "") tiles.push(sunHtml);

  if (tiles.length === 0) return "";

  return "<section class=\"wa-stack wa-gap-s\" aria-labelledby=\"glance-heading\">" +
    renderSectionHeading("glance-heading", "gauge", "At a glance") +
    "<div class=\"wa-grid wa-gap-m glance-grid\">" + tiles.join("\n") + "</div>" +
    "</section>";
}

// The five flag colors in the site's own words, collapsed by default so the
// page still leads with this beach's own answer. Static copy, so nothing here
// needs escaping. Each line says who decides that color, since the hero verdict
// names no color on its own.
function renderFlagLegend() {
  const entries = [
    { color: "green", label: "Green", text: "Calm water. Normal swimming conditions." },
    { color: "yellow", label: "Yellow", text: "Moderate surf or currents. Swim with care." },
    { color: "red", label: "Red", text: "Dangerous surf or currents. Swimming is discouraged." },
    { color: "double-red", label: "Double red", text: "The water is closed. Stay out." },
    { color: "unknown", label: "Unknown", text: "No usable data right now. A gray flag is never a guess." }
  ];
  const lines = [];
  lines.push("<wa-details class=\"wa-body-s\" summary=\"What the flags mean\" " +
    "appearance=\"plain\" icon-placement=\"start\">");
  lines.push("<ul class=\"flag-legend-list wa-list-plain wa-stack wa-gap-xs\">");
  for (const entry of entries) {
    lines.push("<li class=\"wa-flank wa-gap-s\">" +
      renderFlagIcon(entry.color, "wa-font-size-l") +
      "<span><strong>" + entry.label + "</strong> — " + entry.text + "</span></li>");
  }
  lines.push("</ul>");
  lines.push("<p class=\"wa-color-text-quiet\">Estimated flags are computed here from " +
    "forecasts and alerts. Official flags are the ones posted at the beach. " +
    "Posted flags and lifeguards always win.</p>");
  lines.push("</wa-details>");
  return lines.join("\n");
}

export function renderDetailPage(data) {
  const beach = data.beach;
  const estimate = data.estimate;
  const official = data.official;
  const nowIso = data.nowIso;
  // Absent for masked beaches and for a record past its lease, so default to null
  // and the wave forecast section omits itself.
  const waves = (data.waves === undefined || data.waves === null) ? null : data.waves;
  // NDBC water-temperature reading, display-only and never a flag input. Absent
  // until the water-temperature cron writes it, so default to null; the tile
  // reads "No data" when it is null or stale.
  const waterTemp = (data.waterTemp === undefined || data.waterTemp === null) ? null : data.waterTemp;
  // An official source's morning water-temperature and wave-height observation.
  // Display-only and never a flag input, like the buoy reading it outranks. Absent for every beach no scraper reports observations for.
  const reading = (data.reading === undefined || data.reading === null) ? null : data.reading;
  // Active water-quality advisory written by the hourly cron. Absent means no
  // advisory stands, never a clean reading.
  const wqfloor = (data.wqfloor === undefined || data.wqfloor === null) ? null : data.wqfloor;
  // Distance-sorted nearby entries from the router; absent renders no section.
  const nearby = Array.isArray(data.nearby) ? data.nearby : [];
  const title = displayName(beach) + " — Swim Report";
  const lat = Number(beach.lat).toFixed(4);
  const lon = Number(beach.lon).toFixed(4);

  // The title flag is displayFlag's color. Decorative: the hero label below
  // names the color.
  const flag = displayFlag({ estimate: estimate, official: official }, nowIso);
  const titleFlagHtml = renderFlagIcon(flag.color, "wa-font-size-4xl", null, null,
    "beach-flag");

  // The park-first beach name, only when it differs from the title. The guard
  // keeps the <p> off the page when there is none.
  const subtitle = subtitleName(beach);
  const subtitleHtml = subtitle ?
    ("<p class=\"wa-body-l wa-color-text-quiet\">" + escapeHtml(subtitle) + "</p>") : "";

  // Coordinates link out to OpenStreetMap (consistent with the footer's OSM
  // attribution), demoted to caption size. The water temperature is a tile
  // under the hero, not a fragment of this line.
  const osmHref = "https://www.openstreetmap.org/?mlat=" + lat + "&mlon=" + lon +
    "#map=15/" + lat + "/" + lon;
  const metaHtml = "<p class=\"wa-caption-s\"><a class=\"coords-link icon-link wa-gap-xs wa-color-text-quiet\" href=\"" +
    escapeHtml(osmHref) + "\" rel=\"noopener noreferrer\">" +
    "<wa-icon name=\"location-dot\"></wa-icon> " + lat + ", " + lon + "</a></p>";

  // The badge names displayFlag's source, never freshness alone. Same two badge
  // builders as the cards, so the official/estimated distinction cannot drift.
  const heroBadgeHtml = renderHeroSourceBadge(flag);

  // One plain-language sentence under the flag label, branched on the same
  // displayFlag decision the label and badge read. Empty for an estimate with
  // nothing to say (a legacy payload with no trigger and no echoed signals),
  // which renders no line at all.
  const verdictText = verdictSentence(estimate, flag,
    typeof beach.water_class === "string" ? beach.water_class : null);
  const verdictHtml = verdictText ?
    ("<p class=\"wa-body-l\">" + escapeHtml(verdictText) + "</p>") : "";
  const canonicalUrl = SITE_ORIGIN + "/beach/" + encodeURIComponent(beach.id);

  // Save toggle for the visitor's own list, in the hero's share row beside the
  // copy and share controls. It ships hidden and DETAIL_FAVORITE_SCRIPT reveals
  // it, so a page without JS never shows a control that cannot work. The state
  // lives only in the visitor's browser; nothing about it reaches the server,
  // and it says nothing about the flag, so it carries no flag color.
  const favoriteHtml = "<wa-button id=\"favorite-toggle\" " +
    "appearance=\"outlined\" size=\"s\" aria-pressed=\"false\" data-beach-id=\"" +
    escapeHtml(String(beach.id)) + "\" hidden>" +
    "<wa-icon id=\"favorite-icon\" slot=\"start\" name=\"star\" variant=\"regular\"></wa-icon>" +
    "<span id=\"favorite-label\">Save</span>" +
    "</wa-button>";

  // The hero carries the beach's identity and nothing but the display flag,
  // washed in that flag's own color (data-flag drives the color-mix in
  // styles.js, so no color literal reaches the markup). The verdicts themselves
  // stay in the two cards below: this is a heading, not a third flag card.
  //
  // The stack zero-margins its children, so the title and subtitle carry no
  // margins of their own. wa-flex-nowrap keeps the flag icon and beach name on
  // one flex line, so a long name wraps beside the icon rather than below it.
  // The back link renders href="/" and stays correct with no JS; the hero
  // script upgrades it to the listing the visitor actually came from.
  //
  // The hero holds the beach-title view-transition-name statically (the flag
  // icon holds beach-flag): it is the one element per document a list row or a
  // nearby card morphs into.
  const heroHtml = "<section class=\"detail-hero wa-stack wa-gap-s\" data-flag=\"" +
    flag.keyword + "\">" +
    "<a class=\"back-link icon-link wa-gap-xs wa-color-text-link\" href=\"/\">" +
    "<wa-icon name=\"arrow-left\"></wa-icon> Back to all beaches</a>" +
    "<h1 class=\"beach-title wa-cluster wa-gap-s wa-flex-nowrap\" style=\"view-transition-name: beach-title;\">" + titleFlagHtml + "<span>" + escapeHtml(displayName(beach)) + "</span></h1>" +
    subtitleHtml +
    "<p class=\"wa-cluster wa-gap-s\">" +
    "<span class=\"wa-heading-l\">" +
    escapeHtml(FLAG_LABELS[flag.color]) + "</span>" +
    heroBadgeHtml +
    "</p>" +
    verdictHtml +
    metaHtml +
    "<div class=\"wa-cluster wa-gap-xs\">" +
    "<wa-copy-button value=\"" + escapeHtml(canonicalUrl) + "\" " +
    "copy-label=\"Copy link\" success-label=\"Link copied\"></wa-copy-button>" +
    "<wa-button id=\"hero-share\" appearance=\"outlined\" size=\"s\" hidden>" +
    "<wa-icon slot=\"start\" name=\"share-nodes\"></wa-icon>Share</wa-button>" +
    favoriteHtml +
    "</div>" +
    "</section>";

  const glanceHtml = renderAtAGlance(beach, estimate, waterTemp, reading, nowIso);

  const officialHtml = renderOfficialCard(official, nowIso);
  const estimateHtml = renderEstimateCard(estimate, nowIso);

  // Answer first, exploration second: the flag verdict (official above
  // estimate) leads and the forecast elaborates.
  const verdictParts = [];
  if (officialHtml) {
    verdictParts.push(officialHtml);
  }
  verdictParts.push(estimateHtml);
  // Directly under the estimate it qualifies: the floor is part of that color,
  // not a competing verdict.
  const wqFloorHtml = renderWqFloorCallout(wqfloor);
  if (wqFloorHtml) {
    verdictParts.push(wqFloorHtml);
  }
  const waveForecastHtml = renderWaveForecast(estimate, waves, nowIso,
    typeof beach.water_class === "string" ? beach.water_class : null);
  if (waveForecastHtml) {
    verdictParts.push(waveForecastHtml);
  }

  // The lazy-loading embeds and the links away from this beach: supporting
  // exploration, and the column that moves beside the verdict on a wide page.
  const exploreParts = [];
  const waveMapHtml = renderWaveMap(beach);
  if (waveMapHtml) {
    exploreParts.push(waveMapHtml);
  }
  // The webcam precedes the nearby beaches: a live picture of the water nearby
  // is the most engaging thing on the page, and links away from this beach
  // belong last.
  const webcamHtml = renderWebcam(beach);
  if (webcamHtml) {
    exploreParts.push(webcamHtml);
  }
  const nearbyHtml = renderNearby(nearby, nowIso);
  if (nearbyHtml) {
    exploreParts.push(nearbyHtml);
  }

  // Two columns from tablet width up, one below it, decided by wa-grid's own
  // auto-fit against --min-column-size rather than by a breakpoint: Web Awesome
  // ships no breakpoint tokens, and a container-sized rule cannot disagree with
  // the viewport the way a media query can. The grid holds exactly two children,
  // so it can never open a third column, and it collapses in source order, which
  // keeps the phone page in the order it already had. A beach with nothing to
  // explore renders the verdict column alone rather than an empty second one.
  const columnsHtml = exploreParts.length === 0
    ? verdictParts.join("\n")
    : ("<div class=\"wa-grid wa-gap-l detail-columns\">" +
      "<div class=\"wa-stack wa-gap-l\">" + verdictParts.join("\n") + "</div>" +
      "<div class=\"wa-stack wa-gap-l\">" + exploreParts.join("\n") + "</div>" +
      "</div>");

  // The hero, the glance tiles and the legend span the full measure above the
  // columns, each keeping --wa-space-l from its neighbour through main's own
  // wa-stack.
  const mainHtml = heroHtml + glanceHtml + renderFlagLegend() + columnsHtml;

  // The tick relabeller ships only when there are ticks to relabel: the wave
  // section also renders as a bare now-stat (the buoy case), which has no strip.
  const ticksScriptHtml = waveForecastHtml.indexOf(WAVE_TICKS_ROW_MARKER) === -1
    ? ""
    : ("<script>" + WAVE_TICKS_SCRIPT + "</script>");

  const bodyHtml = renderPageShell(renderBrandHeader(), mainHtml, renderFooter(),
    "detail-main") +
    "<script>" + DETAIL_HERO_SCRIPT + "</script>" +
    "<script>" + DETAIL_FAVORITE_SCRIPT + "</script>" +
    "<script>" + ROW_TRANSITION_SCRIPT + "</script>" + ticksScriptHtml;
  // The share card, title, hero, rows and map marker are one displayFlag decision.
  return renderDocument(title, bodyHtml, {
    title: title,
    description: detailMetaDescription(beach, estimate, flag),
    path: "/beach/" + encodeURIComponent(beach.id),
    flagColor: flag.color,
    iconColor: flag.color
  });
}

export function renderErrorPage(data) {
  const status = (data && data.status) ? data.status : 500;
  const message = (data && data.message) ? data.message : "Something went wrong.";

  // The error page is a whole page body, so it takes the centered empty-state
  // block rather than a callout, which belongs inline beside other content. The
  // icon carries the signal the callout's color band used to.
  //
  // The status code is this page's title, so it must be a real heading rather
  // than a styled <strong>; the error page would otherwise be the only page with
  // no h1. wa-heading-xl keeps it from reading louder than the sibling pages'
  // titles, and the stack zero-margins its children, so the heading needs no
  // margin rule of its own.
  const mainHtml = "<div class=\"wa-stack wa-gap-l wa-align-items-center wa-text-center\">" +
    "<wa-icon name=\"triangle-exclamation\" class=\"wa-font-size-4xl wa-color-text-quiet\"></wa-icon>" +
    "<h1 class=\"wa-heading-xl\">" + escapeHtml(String(status)) + "</h1>" +
    "<p class=\"wa-color-text-quiet\">" + escapeHtml(message) + "</p>" +
    "<wa-button variant=\"brand\" href=\"/\">Return to the beach list</wa-button>" +
    "</div>";

  const bodyHtml = renderPageShell(renderBrandHeader(), mainHtml, renderFooter());
  // No meta: an error page keeps the site's icon and theme colors but claims no
  // canonical URL and offers no share card.
  return renderDocument("Swim Report — " + String(status), bodyHtml);
}
