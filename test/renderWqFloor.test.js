// test/renderWqFloor.test.js
// Covers the water-quality advisory callout on the detail page
// (src/frontend/render.js): it renders only for a well-formed WqFloorAdvisory
// with a yellow or red color and a non-empty reason, sits between the estimate
// card and the wave forecast, escapes every dynamic field, and never carries
// the OFFICIAL badge or the official-card border.

import { describe, it, expect } from "vitest";
import { renderDetailPage } from "../src/frontend/render.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

const ADVISORY = {
  beachId: "osm-way-505668572",
  color: "red",
  reason: "beach posted for elevated E. coli",
  source: "Lake County General Health District Beach Water Quality Program",
  updated: "2026-07-05T11:00:00.000Z"
};

function renderWith(wqfloor) {
  return renderDetailPage({
    beach: beachWith({}),
    estimate: null,
    official: null,
    wqfloor: wqfloor,
    nowIso: NOW_ISO
  });
}

describe("water-quality advisory callout", () => {
  it("renders a danger callout with reason, source and updated line for a red advisory", () => {
    const html = renderWith(ADVISORY);
    expect(html).toContain("<wa-callout class=\"wq-advisory\" variant=\"danger\" size=\"s\">");
    expect(html).toContain("<wa-icon slot=\"icon\" name=\"droplet\"></wa-icon>");
    expect(html).toContain("<strong>Water quality advisory</strong>");
    expect(html).toContain("beach posted for elevated E. coli");
    expect(html).toContain(
      "<span class=\"wq-advisory-meta wa-caption-s\">Source: " +
      "Lake County General Health District Beach Water Quality Program</span>");
    expect(html).toContain(
      "<span class=\"wq-advisory-meta wa-caption-s\">Updated " +
      "<wa-relative-time date=\"2026-07-05T11:00:00.000Z\" sync></wa-relative-time></span>");
  });

  it("renders a warning callout for a yellow advisory", () => {
    const html = renderWith(Object.assign({}, ADVISORY, {
      color: "yellow",
      reason: "swim advisory in effect"
    }));
    expect(html).toContain("<wa-callout class=\"wq-advisory\" variant=\"warning\" size=\"s\">");
    expect(html).toContain("swim advisory in effect");
  });

  it("never presents the advisory as an official reading", () => {
    const html = renderWith(ADVISORY);
    const start = html.indexOf("<wa-callout class=\"wq-advisory\"");
    const end = html.indexOf("</wa-callout>", start);
    const callout = html.slice(start, end);
    expect(callout).not.toContain("OFFICIAL");
    expect(callout).not.toContain("official-card");
  });

  it("places the callout after the estimate card and before the wave forecast", () => {
    const html = renderDetailPage({
      beach: beachWith({ water_class: "great_lakes" }),
      estimate: {
        color: "red",
        reason: "Waves 4.2 ft",
        official: false,
        rules_version: "1.7.0",
        sources: [],
        waveHeightFt: 4.2,
        updated: NOW_ISO
      },
      official: null,
      waves: {
        beachId: "osm-way-505668572",
        startIso: NOW_ISO,
        hoursFt: [4.2, 4.1, 3.9],
        models: ["noaa_glwu"],
        sources: [],
        updated: NOW_ISO
      },
      wqfloor: ADVISORY,
      nowIso: NOW_ISO
    });
    // Match the rendered markers, not the bare class names — .estimate-card and
    // .wave-forecast selectors also ship in the embedded <head> stylesheet.
    const estimateIndex = html.indexOf("class=\"estimate-card\"");
    const advisoryIndex = html.indexOf("<wa-callout class=\"wq-advisory\"");
    const forecastIndex = html.indexOf("<section class=\"wave-forecast");
    expect(estimateIndex).toBeGreaterThan(-1);
    expect(advisoryIndex).toBeGreaterThan(estimateIndex);
    expect(forecastIndex).toBeGreaterThan(advisoryIndex);
  });

  it("escapes the reason and the source", () => {
    const html = renderWith(Object.assign({}, ADVISORY, {
      reason: "E. coli <script>alert(1)</script> & high",
      source: "County \"Health\" <Dept>"
    }));
    expect(html).toContain("E. coli &lt;script&gt;alert(1)&lt;/script&gt; &amp; high");
    expect(html).toContain("County &quot;Health&quot; &lt;Dept&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("omits the source line when the record carries no source", () => {
    const html = renderWith(Object.assign({}, ADVISORY, { source: "" }));
    expect(html).toContain("<wa-callout class=\"wq-advisory\"");
    expect(html).not.toContain("wq-advisory-meta wa-caption-s\">Source: ");
  });

  it("omits the updated line when the record carries no timestamp", () => {
    const html = renderWith(Object.assign({}, ADVISORY, { updated: null }));
    expect(html).toContain("<wa-callout class=\"wq-advisory\"");
    expect(html).not.toContain("wq-advisory-meta wa-caption-s\">Updated ");
  });

  it("renders nothing when there is no advisory", () => {
    expect(renderWith(null)).not.toContain("wq-advisory");
    expect(renderWith(undefined)).not.toContain("wq-advisory");
    const bare = renderDetailPage({
      beach: beachWith({}),
      estimate: null,
      official: null,
      nowIso: NOW_ISO
    });
    expect(bare).not.toContain("wq-advisory");
  });

  it("renders nothing for a malformed record", () => {
    const malformed = [
      "red",
      42,
      [ADVISORY],
      Object.assign({}, ADVISORY, { color: "green" }),
      Object.assign({}, ADVISORY, { color: "double-red" }),
      Object.assign({}, ADVISORY, { color: null }),
      Object.assign({}, ADVISORY, { reason: "" }),
      Object.assign({}, ADVISORY, { reason: "   " }),
      Object.assign({}, ADVISORY, { reason: null }),
      Object.assign({}, ADVISORY, { reason: 12 })
    ];
    for (const value of malformed) {
      expect(renderWith(value)).not.toContain("wq-advisory");
    }
  });
});
