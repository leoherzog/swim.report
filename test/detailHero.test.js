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
  const m = block ? block.match(/<span class="(wa-font-size-[^"]*)">([^<]*)<\/span>/) : null;
  return m ? { text: m[2], quiet: m[1].indexOf("wa-color-text-quiet") > -1 } : null;
}

function tileSource(html, iconName) {
  const block = tile(html, iconName);
  const m = block ? block.match(/<span class="wa-caption-s">(.*?)<\/span><\/div>/) : null;
  return m ? m[1] : null;
}

describe("detail-page hero", () => {
  it("washes the hero in the display flag color and names it", () => {
    const html = render({ estimate: estimateWith({ color: "yellow" }) });
    const block = hero(html);
    expect(block).toContain("data-flag=\"yellow\"");
    expect(block).toContain("<span class=\"wa-font-size-l wa-font-weight-bold\">YELLOW</span>");
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
    // displayFlag, and here the estimate is the more severe half, so the
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
    // displayFlag is raise-only past STALE_MS, so an aged official red
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

  it("carries no source badge when no record supplies a color", () => {
    const block = hero(render({}));
    expect(block).not.toContain(">ESTIMATE</wa-badge>");
    expect(block).not.toContain("OFFICIAL</wa-badge>");
    expect(block).toContain(">UNKNOWN</span>");
    expect(block).toContain("data-flag=\"unknown\"");
  });

  it("carries no source badge beside an estimate the rules engine left unknown", () => {
    const block = hero(render({ estimate: estimateWith({ color: "unknown" }) }));
    expect(block).not.toContain(">ESTIMATE</wa-badge>");
    expect(block).not.toContain("OFFICIAL</wa-badge>");
    expect(block).toContain(">UNKNOWN</span>");
    expect(block).toContain("data-flag=\"unknown\"");
  });

  it("an official with an unusable color neither decides nor earns OFFICIAL", () => {
    const html = render({
      estimate: estimateWith({ color: "yellow" }),
      official: officialWith("magenta", FRESH)
    });
    const block = hero(html);
    expect(block).toContain("data-flag=\"yellow\"");
    expect(block).toContain(">ESTIMATE</wa-badge>");
    expect(block).not.toContain("OFFICIAL</wa-badge>");
    // The official card below still reports its own record, as UNKNOWN.
    const cardStart = html.indexOf("<wa-card class=\"official-card\"");
    expect(cardStart).toBeGreaterThan(-1);
    const card = html.slice(cardStart, html.indexOf("</wa-card>", cardStart));
    expect(card).toContain(">UNKNOWN</span>");
    expect(card).toContain("flag-icon-unknown");
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
    expect(block).toContain("<a class=\"back-link icon-link wa-gap-2xs wa-color-text-link\" href=\"/\">");
    expect(block).toContain("Back to all beaches");
    expect(block).toContain(
      "<wa-copy-button value=\"https://swim.report/beach/osm-way-505668572\" " +
      "copy-label=\"Copy link\" success-label=\"Link copied\"></wa-copy-button>");
    // The Share button ships hidden: navigator.share exists on some browsers
    // only, and a dead button is worse than no button.
    expect(block).toContain("<wa-button id=\"hero-share\" " +
      "appearance=\"outlined\" size=\"s\" hidden>");
  });

  it("styles the wash from tokens per flag keyword", () => {
    // A rule per keyword, mixed into the surface token so the wash follows
    // wa-dark; no hex, and gray for unknown rather than a green default.
    expect(PAGE_STYLES).toContain(".detail-hero[data-flag='green'] {");
    expect(PAGE_STYLES).toContain(
      "background: color-mix(in oklab, var(--flag-yellow) 12%, var(--wa-color-surface-default));");
    expect(PAGE_STYLES).toContain(
      "background: color-mix(in oklab, var(--flag-red) 12%, var(--wa-color-surface-default));");
    expect(PAGE_STYLES).toContain(
      "background: color-mix(in oklab, var(--flag-unknown) 12%, var(--wa-color-surface-default));");
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
    const glanceIdx = html.indexOf("aria-labelledby=\"glance-heading\"");
    const cardIdx = html.indexOf("class=\"estimate-card\"");
    expect(glanceIdx).toBeGreaterThan(heroIdx);
    expect(cardIdx).toBeGreaterThan(glanceIdx);
    expect(html).toContain("<h2 id=\"glance-heading\" class=\"wa-cluster wa-gap-xs wa-font-size-l\">");
    expect(html).toContain("<wa-icon name=\"gauge\"></wa-icon>At a glance</h2>");
  });

  it("shows the wave height the wave strip shows, with the ESTIMATE badge", () => {
    const html = render({ estimate: estimateWith({ waveHeightFt: 2.44 }) });
    expect(tileValue(html, "water")).toEqual({ text: "2.4 ft", quiet: false });
    expect(tile(html, "water")).toContain(">Waves now</span>");
    expect(tileSource(html, "water")).toBe(
      "<wa-badge variant=\"neutral\" appearance=\"outlined\">ESTIMATE</wa-badge>");
  });

  it("renders no wave tile, and no 0.0 ft, when the estimate carries no wave height", () => {
    const html = render({ estimate: estimateWith({}) });
    expect(tile(html, "water")).toBe(null);
    expect(html.indexOf("0.0 ft")).toBe(-1);
  });

  it("shows the rip-current risk level and its source", () => {
    const html = render({ estimate: estimateWith({ ripCurrentRisk: "HIGH" }) });
    expect(tileValue(html, "person-drowning")).toEqual({ text: "HIGH", quiet: false });
    expect(tile(html, "person-drowning")).toContain(">Rip current risk</span>");
    expect(tileSource(html, "person-drowning")).toBe("NWS surf zone forecast");
  });

  it("renders no rip-current tile when no rip risk was published", () => {
    const html = render({ estimate: estimateWith({ ripCurrentRisk: null }) });
    expect(tile(html, "person-drowning")).toBe(null);
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

  it("counts only the alerts in effect at alertsAt and names the upcoming one on the quiet tile", () => {
    const upcoming = { event: "Beach Hazards Statement", onset: "2026-07-06T11:00:00.000Z", ends: null };
    const live = { event: "High Surf Advisory", onset: "2026-07-05T06:00:00.000Z", ends: null };
    const mixed = render({
      beach: beachWith({ nws_zone: "MIZ037" }),
      estimate: estimateWith({ alertDetails: [upcoming, live], alertsAt: FRESH })
    });
    expect(tileValue(mixed, "triangle-exclamation")).toEqual({ text: "1", quiet: false });
    expect(tileSource(mixed, "triangle-exclamation")).toBe("High Surf Advisory");

    const onlyUpcoming = render({
      beach: beachWith({ nws_zone: "MIZ037" }),
      estimate: estimateWith({ alertDetails: [upcoming], alertsAt: FRESH })
    });
    expect(tileValue(onlyUpcoming, "triangle-exclamation")).toEqual({ text: "None active", quiet: true });
    expect(tileSource(onlyUpcoming, "triangle-exclamation")).toBe("Beach Hazards Statement not yet in effect");
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
    expect(tile(html, "triangle-exclamation")).toBe(null);
    expect(html.indexOf("None active")).toBe(-1);
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

  it("renders no alerts tile on a legacy estimate with no alert echo", () => {
    const html = render({
      beach: beachWith({ nws_zone: "MIZ037" }),
      estimate: estimateWith({})
    });
    expect(tile(html, "triangle-exclamation")).toBe(null);
  });

  it("escapes an alert event name into the source line", () => {
    const html = render({
      estimate: estimateWith({
        alertDetails: [{ event: "Surf <b>Warning</b>", onset: null, ends: null }]
      })
    });
    expect(tileSource(html, "triangle-exclamation")).toBe("Surf &lt;b&gt;Warning&lt;/b&gt;");
  });

  it("shows the next sun event on the viewer's clock, over a UTC fallback", () => {
    // NOW_ISO is morning at the fixture beach, so sunset is the next event.
    const html = render({});
    expect(tile(html, "sun")).toContain(
      "<span class=\"wa-font-size-xl wa-font-weight-bold\">" +
      "<wa-format-date date=\"2026-07-06T01:26:00.000Z\" hour=\"numeric\" minute=\"numeric\">" +
      "<time datetime=\"2026-07-06T01:26:00.000Z\">01:26 UTC</time></wa-format-date></span>");
    expect(tile(html, "sun")).toContain(">Sunset</span>");
    expect(tileSource(html, "sun")).toBe(null);
  });

  it("names sunrise when the sunrise is the nearer event", () => {
    const html = render({ nowIso: "2026-07-05T06:00:00.000Z" });
    expect(tile(html, "sun")).toContain(
      "<time datetime=\"2026-07-05T10:12:00.000Z\">10:12 UTC</time>");
    expect(tile(html, "sun")).toContain(">Sunrise</span>");
  });

  it("renders no sun tile, and no 0,0 sun, for a beach with no coordinates", () => {
    const html = render({ beach: beachWith({ lat: null, lon: null }) });
    expect(tile(html, "sun")).toBe(null);
  });

  it("renders no sun tile where the sun neither rises nor sets today", () => {
    const html = render({ beach: beachWith({ lat: 78.2232, lon: 15.6469 }) });
    expect(tile(html, "sun")).toBe(null);
  });

  it("keeps only the tiles that have a reading", () => {
    // Nothing but the beach's own coordinates, so the sun tile stands alone.
    const html = render({});
    const glance = html.slice(html.indexOf("aria-labelledby=\"glance-heading\""));
    expect(glance.split("<wa-card class=\"glance-tile\"").length - 1).toBe(1);
    expect(tile(html, "sun")).not.toBe(null);
    // No tile is ever blank, and none of them looks like the official card.
    expect(glance).not.toContain("No data");
    expect(glance).not.toContain("official-card");
  });

  it("renders all five tiles when every reading is present", () => {
    const html = render({
      beach: beachWith({ nws_zone: "MIZ037" }),
      waterTemp: {
        tempF: 72,
        observedIso: "2026-07-05T11:00:00.000Z",
        station: { id: "45161", name: "Muskegon, MI", distanceKm: 5.0 }
      },
      estimate: estimateWith({
        waveHeightFt: 2.4,
        ripCurrentRisk: "MODERATE",
        alertDetails: [{ event: "Beach Hazards Statement", onset: null, ends: null }]
      })
    });
    const glance = html.slice(html.indexOf("aria-labelledby=\"glance-heading\""));
    expect(glance.split("<wa-card class=\"glance-tile\"").length - 1).toBe(5);
  });

  it("omits the whole section when no reading has any data", () => {
    const html = render({ beach: beachWith({ lat: null, lon: null }) });
    expect(html.indexOf("aria-labelledby=\"glance-heading\"")).toBe(-1);
    expect(html.indexOf("glance-heading")).toBe(-1);
  });
});

// An official source's morning water-temperature and wave-height observation
// (beach_state.reading). Display-only: it adds tiles and outranks the buoy, and
// never touches a flag color.
describe("at a glance: the official morning reading", () => {
  // 1 h before NOW_ISO — inside READING_MAX_AGE_MS.
  const OBSERVED = "2026-07-05T11:00:00.000Z";
  // 5 h before NOW_ISO — past it.
  const EXPIRED = "2026-07-05T07:00:00.000Z";

  function readingWith(extra) {
    return Object.assign({
      beachId: "osm-way-505668572",
      waterTempF: 68,
      waveHeightFt: 1,
      observedIso: OBSERVED,
      siteName: "Holland State Park",
      sourceLabel: "NWS Grand Rapids Lake Michigan Beach Report",
      source: "https://www.weather.gov/grr/",
      scraperId: "nws-omr-grr"
    }, extra);
  }

  function glanceOf(html) {
    return html.slice(html.indexOf("aria-labelledby=\"glance-heading\""));
  }

  it("shows the observed wave height beside the modeled one, in whole feet", () => {
    const glance = glanceOf(render({
      reading: readingWith({}),
      estimate: estimateWith({ waveHeightFt: 2.4 })
    }));
    expect(glance).toContain("Waves now");
    expect(glance).toContain("2.4 ft");
    expect(glance).toContain("Waves this morning");
    expect(glance).toContain("1 ft");
  });

  it("outranks the NDBC buoy for water temperature and names the site instead", () => {
    const glance = glanceOf(render({
      reading: readingWith({ waterTempF: 68 }),
      waterTemp: {
        tempF: 72,
        observedIso: OBSERVED,
        station: { id: "45161", name: "Muskegon, MI", distanceKm: 5.0 }
      }
    }));
    expect(glance).toContain("68°F");
    expect(glance).not.toContain("72°F");
    expect(glance).toContain("Holland State Park");
    expect(glance).not.toContain("Muskegon, MI");
  });

  it("falls back to the buoy when the reading carries no temperature", () => {
    const glance = glanceOf(render({
      reading: readingWith({ waterTempF: null }),
      waterTemp: {
        tempF: 72,
        observedIso: OBSERVED,
        station: { id: "45161", name: "Muskegon, MI", distanceKm: 5.0 }
      }
    }));
    expect(glance).toContain("72°F");
    expect(glance).toContain("Muskegon, MI");
  });

  it("drops both tiles past the 4 h horizon rather than warning about them", () => {
    const html = render({
      reading: readingWith({ observedIso: EXPIRED }),
      beach: beachWith({ lat: null, lon: null })
    });
    expect(html.indexOf("aria-labelledby=\"glance-heading\"")).toBe(-1);
  });

  it("drops a reading whose observed instant does not parse", () => {
    const html = render({
      reading: readingWith({ observedIso: "not a date" }),
      beach: beachWith({ lat: null, lon: null })
    });
    expect(html.indexOf("aria-labelledby=\"glance-heading\"")).toBe(-1);
  });

  it("publishes a reading for a beach with no posted flag at all", () => {
    const glance = glanceOf(render({ reading: readingWith({}), official: null }));
    expect(glance).toContain("68°F");
    expect(glance).toContain("Waves this morning");
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
    expect(html).toContain("<h2 id=\"glance-heading\" class=\"wa-cluster wa-gap-xs wa-font-size-l\">");
    expect(html).toContain("<h2 id=\"wave-forecast-heading\" class=\"wa-cluster wa-gap-xs wa-font-size-l\">");
    expect(html).toContain("<h2 id=\"webcam-heading\" class=\"wa-cluster wa-gap-xs wa-font-size-l\">");
    expect(html).toContain("<h2 id=\"nearby-heading\" class=\"wa-cluster wa-gap-xs wa-font-size-l\">");
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
      html.indexOf("aria-labelledby=\"glance-heading\""),
      html.indexOf("class=\"estimate-card\""),
      html.indexOf("<section class=\"wave-forecast"),
      html.indexOf("<section class=\"wave-map"),
      html.indexOf("<section class=\"wa-stack wa-gap-s\" aria-labelledby=\"webcam-heading\">"),
      html.indexOf("<section class=\"wa-stack wa-gap-s\" aria-labelledby=\"nearby-heading\">")
    ];
    for (let i = 0; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(i === 0 ? -1 : order[i - 1]);
    }
  });
});
