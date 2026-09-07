// test/detailHero.test.js
// Covers the detail page's flag hero, its "at a glance" tiles, the shared
// section headings and the resulting section order (src/frontend/render.js),
// plus the inline hero script that upgrades the back link and reveals the Share
// button. The hero is a heading, not a third flag card: it never presents an
// estimate as an official flag status, and the two cards below are untouched.

import { describe, it, expect } from "vitest";
import { renderDetailPage } from "../src/frontend/render.js";
import { DETAIL_HERO_SCRIPT } from "../src/frontend/backLinkScript.js";
import { PAGE_STYLES } from "../src/frontend/styles.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

// 30 min before NOW_ISO — inside the 2 h STALE_MS default.
const FRESH = "2026-07-05T11:30:00.000Z";
// 4 h before NOW_ISO — past it, so the official reading no longer decides alone.
const AGED = "2026-07-05T08:00:00.000Z";

function render(extra) {
  return renderDetailPage(Object.assign({
    beach: beachWith({}),
    estimate: null,
    official: null,
    waves: null,
    waterTemp: null,
    nowIso: NOW_ISO
  }, extra));
}

function estimateWith(extra) {
  return Object.assign({
    beachId: "osm-way-505668572",
    color: "green",
    reason: "Calm conditions",
    sources: [],
    updated: FRESH
  }, extra);
}

function officialWith(color, updated) {
  return {
    color: color,
    reason: "Posted at the beach",
    official: true,
    source: "https://www.weather.gov/grr/",
    updated: updated
  };
}

function hero(html) {
  const start = html.indexOf("<section class=\"detail-hero");
  return start === -1 ? null : html.slice(start, html.indexOf("</section>", start));
}

function tile(html, iconName) {
  const start = html.indexOf("name=\"" + iconName + "\"");
  return start === -1 ? null : html.slice(start, html.indexOf("</wa-card>", start));
}

function tileValue(html, iconName) {
  const block = tile(html, iconName);
  const m = block ? block.match(/<span class="glance-value([^"]*)">([^<]*)<\/span>/) : null;
  return m ? { text: m[2], quiet: m[1].indexOf("wa-color-text-quiet") > -1 } : null;
}

function tileSource(html, iconName) {
  const block = tile(html, iconName);
  const m = block ? block.match(/<span class="glance-source[^"]*">(.*?)<\/span><\/div>/) : null;
  return m ? m[1] : null;
}

describe("detail-page hero", () => {
  it("washes the hero in the display flag color and names it", () => {
    const html = render({ estimate: estimateWith({ color: "yellow" }) });
    const block = hero(html);
    expect(block).toContain("data-flag=\"yellow\"");
    expect(block).toContain("<span class=\"hero-flag-label wa-font-size-l wa-font-weight-bold\">YELLOW</span>");
  });

  it("collapses double-red onto the red wash but keeps the full label", () => {
    const html = render({ estimate: estimateWith({ color: "double-red" }) });
    const block = hero(html);
    expect(block).toContain("data-flag=\"red\"");
    expect(block).toContain(">DOUBLE RED — water closed</span>");
  });

  it("washes gray, never green, when there is no flag data at all", () => {
    const block = hero(render({}));
    expect(block).toContain("data-flag=\"unknown\"");
    expect(block).toContain(">UNKNOWN</span>");
    expect(block).not.toContain("data-flag=\"green\"");
  });

  it("carries the ESTIMATE badge when the estimate decides the color", () => {
    const block = hero(render({ estimate: estimateWith({ color: "green" }) }));
    expect(block).toContain("data-flag=\"green\"");
    expect(block).toContain(">ESTIMATE</wa-badge>");
    expect(block).not.toContain("OFFICIAL");
  });

  it("carries the OFFICIAL badge when a fresh official record decides the color", () => {
    const html = render({
      estimate: estimateWith({ color: "green" }),
      official: officialWith("red", FRESH)
    });
    const block = hero(html);
    expect(block).toContain("data-flag=\"red\"");
    expect(block).toContain(">RED</span>");
    expect(block).toContain("OFFICIAL</wa-badge>");
    expect(block).not.toContain(">ESTIMATE</wa-badge>");
  });

  it("returns to the ESTIMATE badge once the estimate supplies the color again", () => {
    // Past STALE_MS the color is decided by the raise-only weighing in
    // displayFlagColor, and here the estimate is the more severe half, so the
    // hero must stop calling the color official.
    const html = render({
      estimate: estimateWith({ color: "red" }),
      official: officialWith("yellow", AGED)
    });
    const block = hero(html);
    expect(block).toContain("data-flag=\"red\"");
    expect(block).toContain(">ESTIMATE</wa-badge>");
    expect(block).not.toContain("OFFICIAL</wa-badge>");
  });

  it("keeps the OFFICIAL badge on an aged reading that is still the more severe half", () => {
    // displayFlagColor is raise-only past STALE_MS, so an aged official red
    // still decides the display color over a green estimate. Calling that red
    // an ESTIMATE would credit the estimate with a color it never produced.
    const html = render({
      estimate: estimateWith({ color: "green" }),
      official: officialWith("red", AGED)
    });
    const block = hero(html);
    expect(block).toContain("data-flag=\"red\"");
    expect(block).toContain(">RED</span>");
    expect(block).toContain("OFFICIAL</wa-badge>");
    expect(block).not.toContain(">ESTIMATE</wa-badge>");
  });

  it("credits the estimate when an aged official reading merely agrees with it", () => {
    // Both halves say yellow, so the estimate did produce the displayed color
    // and the honest badge is the quieter of the two.
    const html = render({
      estimate: estimateWith({ color: "yellow" }),
      official: officialWith("yellow", AGED)
    });
    const block = hero(html);
    expect(block).toContain("data-flag=\"yellow\"");
    expect(block).toContain(">ESTIMATE</wa-badge>");
    expect(block).not.toContain("OFFICIAL</wa-badge>");
  });

  it("leaves both flag cards standing below the hero", () => {
    const html = render({
      estimate: estimateWith({ color: "green" }),
      official: officialWith("red", FRESH)
    });
    const heroIdx = html.indexOf("<section class=\"detail-hero");
    const officialIdx = html.indexOf("class=\"official-card\"");
    const estimateIdx = html.indexOf("class=\"estimate-card\"");
    expect(officialIdx).toBeGreaterThan(heroIdx);
    expect(estimateIdx).toBeGreaterThan(officialIdx);
    expect(html).toContain("Posted at the beach");
    expect(html).toContain("Calm conditions");
  });

  it("renders the back link at / and the share controls for the canonical URL", () => {
    const block = hero(render({}));
    expect(block).toContain("<a class=\"back-link\" href=\"/\">");
    expect(block).toContain("Back to all beaches");
    expect(block).toContain(
      "<wa-copy-button class=\"hero-copy\" value=\"https://swim.report/beach/osm-way-505668572\" " +
      "copy-label=\"Copy link\" success-label=\"Link copied\"></wa-copy-button>");
    // The Share button ships hidden: navigator.share exists on some browsers
    // only, and a dead button is worse than no button.
    expect(block).toContain("<wa-button id=\"hero-share\" class=\"hero-share\" " +
      "appearance=\"outlined\" size=\"s\" hidden>");
  });

  it("styles the wash from tokens per flag keyword", () => {
    // A rule per keyword, mixed into the surface token so the wash follows
    // wa-dark; no hex, and gray for unknown rather than a green default.
    expect(PAGE_STYLES).toContain(".detail-hero[data-flag='green'] {");
    expect(PAGE_STYLES).toContain(
      "background: color-mix(in oklab, var(--wa-color-yellow-70) 12%, var(--wa-color-surface-default));");
    expect(PAGE_STYLES).toContain(
      "background: color-mix(in oklab, var(--wa-color-red-50) 12%, var(--wa-color-surface-default));");
    expect(PAGE_STYLES).toContain(
      "background: color-mix(in oklab, var(--wa-color-gray-50) 12%, var(--wa-color-surface-default));");
  });

  it("escapes a beach id into the copy value", () => {
    const html = render({ beach: beachWith({ id: "a\"b&c" }) });
    expect(hero(html)).toContain("value=\"https://swim.report/beach/a%22b%26c\"");
  });
});

describe("detail-page hero script", () => {
  it("ships inline on the detail page and can never break out of its tag", () => {
    expect(render({})).toContain("<script>" + DETAIL_HERO_SCRIPT + "</script>");
    expect(DETAIL_HERO_SCRIPT.indexOf("</")).toBe(-1);
  });

  it("rewrites the back link only for a same-origin listing referrer", () => {
    expect(DETAIL_HERO_SCRIPT).toContain("const from = new URL(document.referrer);");
    expect(DETAIL_HERO_SCRIPT).toContain(
      "if (from.origin === window.location.origin && from.pathname === '/') {");
    // The search string is what carries ?q= and ?near= back to the listing.
    expect(DETAIL_HERO_SCRIPT).toContain("back.setAttribute('href', from.pathname + from.search);");
    // An empty or malformed referrer throws in new URL — the rendered href stands.
    expect(DETAIL_HERO_SCRIPT).toContain("} catch (err) {");
  });

  it("reveals the Share button only where navigator.share exists", () => {
    expect(DETAIL_HERO_SCRIPT).toContain("if (share && typeof navigator.share === 'function') {");
    expect(DETAIL_HERO_SCRIPT).toContain("share.hidden = false;");
    expect(DETAIL_HERO_SCRIPT).not.toContain("style.display");
  });
});

describe("at a glance tiles", () => {
  it("sits directly under the hero, above the flag cards", () => {
    const html = render({ estimate: estimateWith({}) });
    const heroIdx = html.indexOf("<section class=\"detail-hero");
    const glanceIdx = html.indexOf("<section class=\"at-a-glance");
    const cardIdx = html.indexOf("class=\"estimate-card\"");
    expect(glanceIdx).toBeGreaterThan(heroIdx);
    expect(cardIdx).toBeGreaterThan(glanceIdx);
    expect(html).toContain("<h2 id=\"glance-heading\" class=\"section-heading wa-cluster wa-gap-xs\">");
    expect(html).toContain("<wa-icon name=\"gauge\"></wa-icon>At a glance</h2>");
  });

  it("shows the wave height the wave strip shows, with the ESTIMATE badge", () => {
    const html = render({ estimate: estimateWith({ waveHeightFt: 2.44 }) });
    expect(tileValue(html, "water")).toEqual({ text: "2.4 ft", quiet: false });
    expect(tile(html, "water")).toContain(">Waves now</span>");
    expect(tileSource(html, "water")).toBe(
      "<wa-badge variant=\"neutral\" appearance=\"outlined\">ESTIMATE</wa-badge>");
  });

  it("reads No data rather than 0.0 ft when the estimate carries no wave height", () => {
    const html = render({ estimate: estimateWith({}) });
    expect(tileValue(html, "water")).toEqual({ text: "No data", quiet: true });
    expect(html.indexOf("0.0 ft")).toBe(-1);
  });

  it("shows the rip-current risk level and its source", () => {
    const html = render({ estimate: estimateWith({ ripCurrentRisk: "HIGH" }) });
    expect(tileValue(html, "person-drowning")).toEqual({ text: "HIGH", quiet: false });
    expect(tile(html, "person-drowning")).toContain(">Rip current risk</span>");
    expect(tileSource(html, "person-drowning")).toBe("NWS surf zone forecast");
  });

  it("says Not forecast, quietly, when no rip risk was published", () => {
    const html = render({ estimate: estimateWith({ ripCurrentRisk: null }) });
    expect(tileValue(html, "person-drowning")).toEqual({ text: "Not forecast", quiet: true });
  });

  it("counts the active alerts and names the first one", () => {
    const html = render({
      beach: beachWith({ nws_zone: "MIZ037" }),
      estimate: estimateWith({
        alertDetails: [
          { event: "Beach Hazards Statement", onset: null, ends: null },
          { event: "High Surf Advisory", onset: null, ends: null }
        ]
      })
    });
    expect(tileValue(html, "triangle-exclamation")).toEqual({ text: "2", quiet: false });
    expect(tile(html, "triangle-exclamation")).toContain(">Active alerts</span>");
    expect(tileSource(html, "triangle-exclamation")).toBe("Beach Hazards Statement");
  });

  it("says None active for a checkable beach with an empty alert list", () => {
    const html = render({
      beach: beachWith({ eccc_zone: "Grand Bend" }),
      estimate: estimateWith({ alertDetails: [] })
    });
    expect(tileValue(html, "triangle-exclamation")).toEqual({ text: "None active", quiet: true });
    expect(tileSource(html, "triangle-exclamation")).toBe("NWS and ECCC alerts");
  });

  it("never says None active for a beach whose alerts were never checkable", () => {
    // No nws_zone and no eccc_zone: buildEstimateInputs would read
    // alertsCheckable false, so "none active" would be a claim nobody made.
    const html = render({ estimate: estimateWith({ alertDetails: [] }) });
    expect(tileValue(html, "triangle-exclamation")).toEqual({ text: "No data", quiet: true });
    expect(tileSource(html, "triangle-exclamation")).toBe("Alerts not checked for this beach yet");
  });

  it("still counts a marine alert on a beach with no land zone", () => {
    const html = render({
      estimate: estimateWith({
        alertDetails: [{ event: "Small Craft Advisory", onset: null, ends: null }]
      })
    });
    expect(tileValue(html, "triangle-exclamation")).toEqual({ text: "1", quiet: false });
    expect(tileSource(html, "triangle-exclamation")).toBe("Small Craft Advisory");
  });

  it("reads No data on a legacy estimate with no alert echo", () => {
    const html = render({
      beach: beachWith({ nws_zone: "MIZ037" }),
      estimate: estimateWith({})
    });
    expect(tileValue(html, "triangle-exclamation")).toEqual({ text: "No data", quiet: true });
  });

  it("escapes an alert event name into the source line", () => {
    const html = render({
      estimate: estimateWith({
        alertDetails: [{ event: "Surf <b>Warning</b>", onset: null, ends: null }]
      })
    });
    expect(tileSource(html, "triangle-exclamation")).toBe("Surf &lt;b&gt;Warning&lt;/b&gt;");
  });

  it("renders every tile even when the page has no data at all", () => {
    const html = render({});
    const glance = html.slice(html.indexOf("<section class=\"at-a-glance"));
    expect(glance.split("<wa-card class=\"glance-tile\"").length - 1).toBe(4);
    // No tile is ever blank, and none of them looks like the official card.
    expect(glance).not.toContain("official-card");
  });
});

describe("detail-page section headings and order", () => {
  const beach = beachWith({
    lat: 42.775,
    lon: -86.211,
    webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1/day"
  });
  const nearby = [
    { beach: beachWith({ id: "n-1", name: "North Beach" }), estimate: null, official: null, distanceMi: 0.8 }
  ];

  it("gives every section below the hero the same heading shape", () => {
    const html = render({
      beach: beach,
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      nearby: nearby
    });
    expect(html).toContain("<h2 id=\"glance-heading\" class=\"section-heading wa-cluster wa-gap-xs\">");
    expect(html).toContain("<h2 id=\"wave-forecast-heading\" class=\"section-heading wa-cluster wa-gap-xs\">");
    expect(html).toContain("<h2 id=\"webcam-heading\" class=\"section-heading wa-cluster wa-gap-xs\">");
    expect(html).toContain("<h2 id=\"nearby-heading\" class=\"section-heading wa-cluster wa-gap-xs\">");
    expect(html).toContain("<wa-icon name=\"location-dot\"></wa-icon>Nearby beaches</h2>");
  });

  it("puts the webcam ahead of the nearby beaches", () => {
    const html = render({
      beach: beach,
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      nearby: nearby
    });
    const order = [
      html.indexOf("<section class=\"detail-hero"),
      html.indexOf("<section class=\"at-a-glance"),
      html.indexOf("class=\"estimate-card\""),
      html.indexOf("<section class=\"wave-forecast"),
      html.indexOf("<section class=\"wave-map"),
      html.indexOf("<section class=\"webcam-section"),
      html.indexOf("<section class=\"nearby ")
    ];
    for (let i = 0; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(i === 0 ? -1 : order[i - 1]);
    }
  });
});
