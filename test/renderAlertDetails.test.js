// test/renderAlertDetails.test.js
// Detail-page estimate card: the per-alert disclosures under the flag row, where
// a reader finds what the alert named in the reason line actually says. Pure
// rendering, no fetch, no Date.
import { describe, it, expect } from "vitest";
import { renderDetailPage } from "../src/frontend/render.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

const BHS = {
  event: "Beach Hazards Statement",
  onset: "2026-07-05T10:00:00.000Z",
  ends: "2026-07-06T02:00:00.000Z",
  description: "* WHAT...High waves and dangerous currents expected.\n\n" +
    "* WHERE...Beaches along Lake Michigan in Door, Kewaunee and\nManitowoc Counties.",
  instruction: "Remain out of the water to avoid hazardous swimming conditions.",
  area: "Door; Kewaunee; Manitowoc",
  sender: "NWS Green Bay WI"
};

function estimateWith(alertDetails, extra) {
  return Object.assign({
    color: "red",
    reason: "Active NWS alert: Beach Hazards Statement",
    trigger: "nws-alert",
    rules_version: "1.8.0",
    official: false,
    waveHeightFt: null,
    ripCurrentRisk: null,
    alertsAt: NOW_ISO,
    alertDetails: alertDetails,
    sources: [{ label: "NWS Alerts", url: "https://api.weather.gov/alerts/active?zone=WIZ022" }],
    updated: NOW_ISO
  }, extra || {});
}

// The card is sliced out of the document on its rendered class attribute: the
// bare class names also appear in the embedded stylesheet.
function estimateCard(estimate) {
  const html = renderDetailPage({
    beach: beachWith({ nws_zone: "WIZ022" }),
    estimate: estimate,
    official: null,
    nowIso: NOW_ISO
  });
  const start = html.indexOf("class=\"estimate-card\"");
  return html.slice(start, html.indexOf("</wa-card>", start));
}

describe("estimate card: per-alert disclosures", function () {
  it("discloses the alert's own words behind a collapsed toggle", function () {
    const card = estimateCard(estimateWith([BHS]));
    expect(card).toContain("<wa-details class=\"alert-detail\" appearance=\"plain\" " +
      "icon-placement=\"start\">");
    // Collapsed by default: the page still leads with this beach's own answer.
    expect(card).not.toContain("<wa-details class=\"alert-detail\" open");
    expect(card).toContain("<span class=\"wa-font-weight-semibold\">Beach Hazards Statement</span>");
    expect(card).toContain("<strong>What</strong> High waves and dangerous currents expected.");
    expect(card).toContain("Remain out of the water to avoid hazardous swimming conditions.");
    expect(card).toContain("Issued by NWS Green Bay WI for Door; Kewaunee; Manitowoc");
  });

  it("reflows the product's fixed-width wrapping and keeps its blank-line breaks", function () {
    const card = estimateCard(estimateWith([BHS]));
    // The single newline inside the WHERE paragraph is the office's column
    // width, not a break the reader should see.
    expect(card).toContain("<strong>Where</strong> Beaches along Lake Michigan in Door, " +
      "Kewaunee and Manitowoc Counties.</p>");
    // The blank line between them is, so the two stay separate paragraphs.
    expect(card).toContain("expected.</p><p><strong>Where</strong>");
  });

  it("renders unlabelled prose as plain paragraphs", function () {
    const card = estimateCard(estimateWith([{
      event: "severe thunderstorm warning",
      onset: "2026-07-05T10:00:00.000Z",
      ends: "2026-07-05T21:00:00.000Z",
      description: "Rain continues this morning.\n\nWater will pool on roads.",
      instruction: null,
      area: "Windsor - Essex",
      sender: null
    }]));
    expect(card).toContain("<p>Rain continues this morning.</p><p>Water will pool on roads.</p>");
    expect(card).not.toContain("<strong>");
    expect(card).toContain("For Windsor - Essex");
  });

  it("names the window against whether the alert has started", function () {
    const card = estimateCard(estimateWith([
      BHS,
      Object.assign({}, BHS, {
        event: "Small Craft Advisory",
        onset: "2026-07-06T18:00:00.000Z",
        ends: "2026-07-07T06:00:00.000Z"
      })
    ]));
    expect(card).toContain("In effect until <wa-format-date date=\"2026-07-06T02:00:00.000Z\"");
    expect(card).toContain("Starts <wa-format-date date=\"2026-07-06T18:00:00.000Z\"");
    // In-effect first, so the alert that chose the color sits above one echoed
    // ahead of its onset.
    expect(card.indexOf("Beach Hazards Statement"))
      .toBeLessThan(card.indexOf("Small Craft Advisory"));
  });

  it("falls back to a UTC stamp until wa-format-date upgrades", function () {
    const card = estimateCard(estimateWith([BHS]));
    expect(card).toContain("<time datetime=\"2026-07-06T02:00:00.000Z\">Jul 6, 02:00 UTC</time>");
  });

  it("renders an alert with no text as a plain row, never an empty expander", function () {
    // Every "flag:" value written before the text fields shipped looks like this.
    const card = estimateCard(estimateWith([{
      event: "Rip Current Statement",
      onset: "2026-07-05T10:00:00.000Z",
      ends: "2026-07-06T02:00:00.000Z"
    }]));
    expect(card).toContain("<div class=\"alert-detail alert-detail-bare wa-cluster " +
      "wa-align-items-baseline\">");
    expect(card).not.toContain("<wa-details class=\"alert-detail\"");
    expect(card).toContain("Rip Current Statement");
  });

  it("renders nothing when no alert was echoed", function () {
    expect(estimateCard(estimateWith([], {
      color: "green",
      reason: "Estimated wave height 1.2 ft (below 2 ft)",
      trigger: "wave-height",
      waveHeightFt: 1.2
    }))).not.toContain("alert-details");
    expect(estimateCard(estimateWith(null))).not.toContain("alert-details");
  });

  it("escapes the office's text rather than trusting it as markup", function () {
    const card = estimateCard(estimateWith([Object.assign({}, BHS, {
      description: "Waves <script>alert(1)</script> & currents.",
      area: "Door & Kewaunee"
    })]));
    expect(card).not.toContain("<script>");
    expect(card).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; currents.");
    expect(card).toContain("Door &amp; Kewaunee");
  });

  it("keeps a stale warning above the disclosures", function () {
    const stale = "2026-07-05T06:00:00.000Z";
    const card = estimateCard(estimateWith([BHS], { updated: stale }));
    expect(card.indexOf("Stale data")).toBeLessThan(card.indexOf("alert-details"));
  });
});
