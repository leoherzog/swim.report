// Covers the native motion layer: the cross-document view transition (the
// hero's static view-transition-names, the click-time naming script, and the
// @view-transition rule), the wave-strip fill-in and its "now" marker, and the
// home-map skeleton's styling. Every animation must sit behind
// prefers-reduced-motion: no-preference, and no flag icon may ever animate — a
// moving flag would imply live wind.

import { describe, it, expect } from "vitest";
import { renderDetailPage, renderListPage } from "../src/frontend/render.js";
import { PAGE_STYLES } from "../src/frontend/styles.js";
import { ROW_TRANSITION_SCRIPT } from "../src/frontend/rowTransitionScript.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

// True when the rule at ruleIdx sits inside a prefers-reduced-motion:
// no-preference block. Media blocks close on a line-start "}"; the rules nested
// inside them are indented, so the first such close after the guard ends it.
function insideNoPreference(ruleIdx) {
  const guardIdx = PAGE_STYLES.lastIndexOf("@media (prefers-reduced-motion: no-preference) {", ruleIdx);
  if (guardIdx === -1) {
    return false;
  }
  const closeIdx = PAGE_STYLES.indexOf("\n}", guardIdx);
  return ruleIdx > guardIdx && ruleIdx < closeIdx;
}

function detailPage(extra) {
  return renderDetailPage(Object.assign({
    beach: beachWith({}),
    estimate: { color: "green", reason: "calm", sources: [], updated: NOW_ISO },
    official: null,
    nowIso: NOW_ISO
  }, extra || {}));
}

function listPage() {
  return renderListPage({
    entries: [{
      beach: beachWith({}),
      estimate: { color: "yellow", reason: "waves", sources: [], updated: NOW_ISO },
      official: null,
      distanceMi: null
    }],
    nowIso: NOW_ISO
  });
}

describe("cross-document view transitions", () => {
  it("opts in behind a no-preference query", () => {
    expect(PAGE_STYLES).toContain("@view-transition {");
    expect(PAGE_STYLES).toContain("navigation: auto;");
    expect(insideNoPreference(PAGE_STYLES.indexOf("@view-transition {"))).toBe(true);
    expect(PAGE_STYLES).toContain("::view-transition-group(beach-title),");
    expect(PAGE_STYLES).toContain("::view-transition-group(beach-flag) {");
    // The opposite-polarity guard for the background swells stays, untouched.
    expect(PAGE_STYLES).toContain("@media (prefers-reduced-motion: reduce) {");
  });

  it("names both morph targets in the detail hero", () => {
    const html = detailPage();
    expect(html).toContain("<h1 class=\"beach-title wa-cluster wa-gap-s wa-flex-nowrap\"" +
      " style=\"view-transition-name: beach-title;\">");
    // The hero icon stays decorative — the flag label right below it names the
    // color — so the transition name is the only attribute it gains.
    expect(html).toContain("<wa-icon style=\"view-transition-name: beach-flag;\"" +
      " name=\"flag\" class=\"wa-font-size-4xl flag-icon-green\"></wa-icon>");
  });

  it("names the double-red icon pair as one element", () => {
    const html = detailPage({
      official: {
        color: "double-red",
        reason: "posted",
        official: true,
        source: "https://ex.gov/f",
        updated: NOW_ISO
      }
    });
    // Two icons make the double-red flag, so their wrapper carries the name;
    // naming each icon would be a duplicate and abort the transition.
    expect(html).toContain("<span style=\"view-transition-name: beach-flag;\"" +
      " class=\"wa-cluster wa-gap-3xs\">" +
      "<wa-icon name=\"flag\" class=\"wa-font-size-4xl flag-icon-red\"></wa-icon>" +
      "<wa-icon name=\"flag\" class=\"wa-font-size-4xl flag-icon-red\"></wa-icon>" +
      "</span>");
  });

  it("carries no transition name on a list row or a nearby card", () => {
    // Names are unique per document, so rows and cards get theirs at click time
    // from the script, never in the server-rendered markup.
    const html = listPage();
    expect(html).toContain("class=\"beach-row-name wa-font-weight-semibold\"");
    expect(html).not.toContain("class=\"beach-row-name wa-font-weight-semibold\" style=\"view-transition-name");
    const detail = detailPage({
      nearby: [{ beach: beachWith({ id: "osm-way-2", name: "Tunnel Park" }), estimate: null, official: null, distanceMi: 2 }]
    });
    expect(detail).toContain("class=\"nearby-card-name wa-font-weight-semibold\"");
    expect(detail).not.toContain("class=\"nearby-card-name wa-font-weight-semibold\" style=\"view-transition-name");
  });

  it("keeps the flag chip the first badge when an OFFICIAL badge follows it", () => {
    // The script claims the link's first wa-badge as beach-flag, so an official
    // that supplies the color must never put its badge ahead of the chip.
    const official = { color: "yellow", updated: NOW_ISO };
    const html = renderListPage({
      entries: [{
        beach: beachWith({}),
        estimate: { color: "green", updated: NOW_ISO },
        official: official,
        distanceMi: null
      }],
      nowIso: NOW_ISO
    });
    const row = html.slice(html.indexOf("<li class=\"beach-row\""));
    const first = row.slice(row.indexOf("<wa-badge"), row.indexOf("</wa-badge>"));
    expect(first).toContain("flag-icon-yellow");
    expect(first).not.toContain("OFFICIAL");
    expect(row.slice(0, row.indexOf("</li>"))).toContain("OFFICIAL</wa-badge>");
    const detail = detailPage({
      nearby: [{ beach: beachWith({ id: "osm-way-2", name: "Tunnel Park" }), estimate: null, official: official, distanceMi: 2 }]
    });
    const card = detail.slice(detail.indexOf("<wa-card class=\"nearby-card\""));
    const cardFirst = card.slice(card.indexOf("<wa-badge"), card.indexOf("</wa-badge>"));
    expect(cardFirst).toContain("flag-icon-yellow");
    expect(cardFirst).not.toContain("OFFICIAL");
  });

  it("ships the click-time naming script on both pages", () => {
    expect(listPage()).toContain(ROW_TRANSITION_SCRIPT);
    expect(detailPage()).toContain(ROW_TRANSITION_SCRIPT);
    // Inline <script> text may never carry a closing script tag.
    expect(ROW_TRANSITION_SCRIPT).not.toContain("</script");
  });

  it("claims the hero's names for the clicked row or card and hands them back", () => {
    expect(ROW_TRANSITION_SCRIPT).toContain("'a.beach-row-link, a.nearby-card-link'");
    expect(ROW_TRANSITION_SCRIPT).toContain("'.beach-row-name, .nearby-card-name'");
    expect(ROW_TRANSITION_SCRIPT).toContain("claim(link.querySelector(NAMES), 'beach-title');");
    expect(ROW_TRANSITION_SCRIPT).toContain("claim(link.querySelector('wa-badge'), 'beach-flag');");
    // The hero owns both names in the same document, so it gives them up for
    // the click and takes them back on a bfcache restore.
    expect(ROW_TRANSITION_SCRIPT).toContain("heroTitle.style.viewTransitionName = 'none';");
    expect(ROW_TRANSITION_SCRIPT).toContain("heroFlag.style.viewTransitionName = 'none';");
    expect(ROW_TRANSITION_SCRIPT).toContain("window.addEventListener('pageshow', release);");
  });

  it("does nothing for a reduced-motion visitor or an unsupporting browser", () => {
    expect(ROW_TRANSITION_SCRIPT).toContain("if (!document.startViewTransition) {");
    expect(ROW_TRANSITION_SCRIPT).toContain("'(prefers-reduced-motion: reduce)'");
  });

  it("ignores a click that does not navigate this document", () => {
    expect(ROW_TRANSITION_SCRIPT).toContain("if (event.defaultPrevented || event.button !== 0) {");
    expect(ROW_TRANSITION_SCRIPT).toContain(
      "if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {");
  });
});

describe("wave-strip fill-in and now marker", () => {
  function waves() {
    const hours = [];
    for (let i = 0; i < 6; i++) { hours.push(1.0); }
    for (let i = 0; i < 18; i++) { hours.push(3.0); }
    return {
      beachId: "osm-way-505668572",
      startIso: NOW_ISO,
      hoursFt: hours,
      models: ["noaa_glwu"],
      sources: [{ label: "NOAA Great Lakes Wave Model" }],
      updated: NOW_ISO
    };
  }

  it("sets the stagger index inline on every segment", () => {
    const html = detailPage({
      estimate: { color: "green", reason: "calm", sources: [], updated: NOW_ISO, waveHeightFt: 1.0 },
      waves: waves()
    });
    expect(html).toContain("style=\"flex: 6 6 0%; background: var(--flag-green); --i: 0;\"");
    expect(html).toContain("style=\"flex: 18 18 0%; background: var(--flag-yellow); --i: 1;\"");
  });

  it("animates the segments only behind a no-preference query", () => {
    expect(PAGE_STYLES).toContain("@keyframes wave-strip-fill {");
    expect(PAGE_STYLES).toContain("animation-delay: calc(var(--i, 0) * 70ms);");
    expect(PAGE_STYLES).toContain("transform-origin: left center;");
    expect(insideNoPreference(PAGE_STYLES.indexOf("animation: wave-strip-fill"))).toBe(true);
    expect(insideNoPreference(PAGE_STYLES.indexOf("@keyframes wave-strip-fill {"))).toBe(true);
    // No flag icon animates: a moving flag would read as live wind.
    expect(PAGE_STYLES).not.toContain("@keyframes flag");
  });

  it("marks the strip's left edge as now", () => {
    expect(PAGE_STYLES).toContain(".wave-strip::after {");
    expect(PAGE_STYLES).toContain("inset-inline-start: 0;");
    expect(PAGE_STYLES).toContain("width: var(--wa-border-width-m);");
    // Neutral, not one of the four flag colors, which mean flag condition only.
    expect(PAGE_STYLES).toContain("background: var(--wa-color-neutral-fill-loud);");
  });
});
