// test/detailVerdict.test.js
// The verdict line and the flag legend as renderDetailPage emits them: which of
// the estimate and the posted flag the sentence credits, escaping, omission for
// a legacy estimate, and the once-per-page collapsed legend.

import { describe, it, expect } from "vitest";
import { renderDetailPage } from "../src/frontend/render.js";
import { PAGE_STYLES } from "../src/frontend/styles.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

// Inside the 2 h staleness horizon of NOW_ISO.
const FRESH = "2026-07-05T11:30:00.000Z";
// Well past it.
const AGED = "2026-07-05T08:00:00.000Z";

function estimateWith(extra) {
  return Object.assign(
    {
      beachId: "osm-way-505668572",
      color: "green",
      reason: "Estimated wave height 1.2 ft (below 2 ft)",
      trigger: "wave-height",
      rules_version: "1.7.0",
      official: false,
      sources: [],
      updated: FRESH,
      waveHeightFt: 1.2,
      alertDetails: [],
      ripCurrentRisk: null,
      // The seal the hourly cron writes beside every estimate; alertsResolved
      // true is what lets the sentence claim the alert check came back clear.
      estimateInputs: {
        v: 1,
        alertsResolved: true,
        windSpeedMph: null,
        windGustMph: null,
        waterQualityAdvisory: null,
        signalSources: []
      }
    },
    extra
  );
}

function officialWith(color, updated) {
  return {
    color: color,
    official: true,
    reason: "Posted flag",
    source: "https://example.gov/flags",
    updated: updated
  };
}

function render(extra) {
  return renderDetailPage(Object.assign(
    {
      beach: beachWith({ water_class: "great_lake" }),
      estimate: estimateWith({}),
      official: null,
      waves: null,
      waterTemp: null,
      nowIso: NOW_ISO
    },
    extra
  ));
}

// The verdict paragraph's text, or null when the line is absent.
function verdict(html) {
  const m = html.match(/<p class="wa-body-l">([^<]*)<\/p>/);
  return m ? m[1] : null;
}

describe("detail-page verdict line", function () {
  it("explains the estimate in plain language in the hero", function () {
    expect(verdict(render({}))).toBe("Calm water, no alerts.");
  });

  it("sits between the flag label and the coordinates line", function () {
    const html = render({});
    const label = html.indexOf("<span class=\"wa-heading-l\">");
    const line = html.indexOf("<p class=\"wa-body-l\">");
    const meta = html.indexOf("<a class=\"coords-link");
    expect(label).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(label);
    expect(meta).toBeGreaterThan(line);
  });

  it("credits a fresh posted flag rather than the estimate", function () {
    const html = render({ official: officialWith("red", FRESH) });
    expect(verdict(html)).toBe("A red flag is posted at the beach.");
  });

  it("credits the estimate when an aged posted flag only agrees with it", function () {
    const html = render({ official: officialWith("green", AGED) });
    expect(verdict(html)).toBe("Calm water, no alerts.");
  });

  it("credits an aged posted flag that is more severe than the estimate", function () {
    const html = render({ official: officialWith("double-red", AGED) });
    expect(verdict(html)).toBe("Water closed by the posted flag.");
  });

  it("is honest with no estimate at all", function () {
    expect(verdict(render({ estimate: null }))).toBe("No data yet for this beach.");
  });

  it("omits the line entirely for a legacy estimate with nothing to say", function () {
    const html = render({
      estimate: { color: "green", reason: "Estimated wave height 1.2 ft", updated: FRESH }
    });
    expect(verdict(html)).toBe(null);
    expect(html.indexOf("<p class=\"wa-body-l\">")).toBe(-1);
  });

  it("escapes an alert name from upstream", function () {
    const html = render({
      estimate: estimateWith({
        color: "red",
        trigger: "nws-alert",
        reason: "Active NWS alert",
        waveHeightFt: null,
        alertDetails: [{ event: "Beach \"Hazards\" <Statement>", onset: null, ends: null }]
      })
    });
    expect(html).toContain("<p class=\"wa-body-l\">Beach &quot;Hazards&quot; " +
      "&lt;Statement&gt; in effect.</p>");
  });

});

describe("detail-page flag legend", function () {
  it("renders one collapsed legend per page, between the tiles and the stack", function () {
    const html = render({});
    expect(html.split("What the flags mean").length - 1).toBe(1);
    expect(html).toContain("<wa-details class=\"wa-body-s\" summary=\"What the flags mean\" " +
      "appearance=\"plain\" icon-placement=\"start\">");
    const legend = html.indexOf("<wa-details class=\"wa-body-s\"");
    const glance = html.indexOf("aria-labelledby=\"glance-heading\"");
    const stack = html.indexOf("class=\"estimate-card\"");
    expect(glance).toBeGreaterThan(-1);
    expect(legend).toBeGreaterThan(glance);
    expect(stack).toBeGreaterThan(legend);
  });

  it("gives every flag color a line in the site's own words", function () {
    const html = render({});
    expect(html).toContain("<li class=\"wa-flank wa-gap-s\">" +
      "<wa-icon name=\"flag\" class=\"wa-font-size-l flag-icon-green\"></wa-icon>" +
      "<span><strong>Green</strong> — Calm water. Normal swimming conditions.</span></li>");
    expect(html).toContain("<span><strong>Yellow</strong> — Moderate surf or currents. " +
      "Swim with care.</span></li>");
    expect(html).toContain("<span><strong>Red</strong> — Dangerous surf or currents. " +
      "Swimming is discouraged.</span></li>");
    expect(html).toContain("<span><strong>Double red</strong> — The water is closed. " +
      "Stay out.</span></li>");
    expect(html).toContain("<span><strong>Unknown</strong> — No usable data right now. " +
      "A gray flag is never a guess.</span></li>");
  });

  it("says who computes an estimate, who posts an official flag, and which one wins", function () {
    expect(render({})).toContain("<p class=\"wa-color-text-quiet\">Estimated flags are computed " +
      "here from forecasts and alerts. Official flags are the ones posted at the beach. " +
      "Posted flags and lifeguards always win.</p>");
  });

  it("styles the legend", function () {
    expect(PAGE_STYLES).toContain(".flag-legend-list {");
  });
});
