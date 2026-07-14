// test/renderWaveForecast.test.js
// Covers the wave-forecast section on the detail page (src/frontend/render.js),
// exercised through renderDetailPage (mirrors renderWebcam.test.js). Asserts the
// section's placement, the <wa-bar-chart> attributes, the slotted Chart.js JSON
// (parsed end-to-end), the "now" stat, the buoy/legacy/absent variants, the
// stale warning, the ESTIMATE badge, and that the footer disclaimer survives.

import { describe, it, expect } from "vitest";
import { renderDetailPage } from "../src/frontend/render.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

// 24-hour series: 5 green (1 ft), 3 yellow (3 ft), 2 red (5 ft), 14 null.
function representativeHours() {
  const hours = [];
  for (let i = 0; i < 5; i++) { hours.push(1.0); }
  for (let i = 0; i < 3; i++) { hours.push(3.0); }
  for (let i = 0; i < 2; i++) { hours.push(5.0); }
  for (let i = 0; i < 14; i++) { hours.push(null); }
  return hours;
}

function wavesWith(extra) {
  return Object.assign(
    {
      beachId: "osm-way-505668572",
      startIso: NOW_ISO,
      hoursFt: representativeHours(),
      models: ["ecmwf_wam025"],
      sources: [{ label: "ECMWF Wave Forecast" }],
      updated: NOW_ISO
    },
    extra
  );
}

function estimateWith(extra) {
  return Object.assign(
    {
      color: "green",
      reason: "Estimated wave height 1.0 ft (below 2 ft)",
      trigger: "wave-height",
      rules_version: "1.2.0",
      official: false,
      sources: [],
      updated: NOW_ISO
    },
    extra
  );
}

function render(data) {
  return renderDetailPage(Object.assign({ beach: beachWith({}), nowIso: NOW_ISO }, data));
}

// Pull out the JSON string between the chart's application/json script tags.
function extractChartJson(html) {
  const openTag = "<script type=\"application/json\">";
  const start = html.indexOf(openTag);
  expect(start).toBeGreaterThan(-1);
  const from = start + openTag.length;
  const end = html.indexOf("</script>", from);
  expect(end).toBeGreaterThan(from);
  return html.slice(from, end);
}

// Every application/json config block on the page, in document order (the band
// strip first, then the model-comparison chart when present).
function extractAllChartJson(html) {
  const openTag = "<script type=\"application/json\">";
  const closeTag = "</script>";
  const out = [];
  let idx = html.indexOf(openTag);
  while (idx > -1) {
    const from = idx + openTag.length;
    const end = html.indexOf(closeTag, from);
    out.push(html.slice(from, end));
    idx = html.indexOf(openTag, end);
  }
  return out;
}

// A 24-length constant series (per-model raw-float fixture).
function modelHours(v) {
  const arr = [];
  for (let i = 0; i < 24; i++) { arr.push(v); }
  return arr;
}

// waves payload carrying three models finite at the now-hour.
function threeModelWaves() {
  return wavesWith({
    byModel: {
      ecmwf_wam025: modelHours(2.63),
      ncep_gfswave025: modelHours(2.44),
      meteofrance_wave: modelHours(2.9)
    }
  });
}

const SUMMARY = "Under 2 ft for 5 hours from now, then 2-4 ft for 3 hours, " +
  "then 4 ft or more for 2 hours, then no data for 14 hours.";

describe("wave-forecast section", () => {
  it("renders between the estimate card and the webcam section", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({}),
      beach: beachWith({
        webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1/day",
        webcam_title: "Cam"
      })
    });
    const estimateIdx = html.indexOf("estimate-card");
    const waveIdx = html.indexOf("class=\"wave-forecast");
    const webcamIdx = html.indexOf("webcam-section");
    expect(estimateIdx).toBeGreaterThan(-1);
    expect(waveIdx).toBeGreaterThan(estimateIdx);
    expect(webcamIdx).toBeGreaterThan(waveIdx);
  });

  it("sets the wa-bar-chart attributes, with max matching the trimmed hour count", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({})
    });
    expect(html).toContain("<wa-bar-chart class=\"wave-chart\"");
    expect(html).toContain("index-axis=\"y\"");
    expect(html).toContain("stacked");
    expect(html).toContain("without-tooltip");
    expect(html).toContain("min=\"0\"");
    expect(html).toContain("max=\"24\"");
  });

  it("carries a parseable Chart.js config whose datasets match the runs and colors", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({})
    });
    const json = extractChartJson(html);
    // Never a literal closing script tag inside the slotted JSON.
    expect(json).not.toContain("</script");
    const config = JSON.parse(json);
    // The chart type comes from the <wa-bar-chart> element itself — the
    // slotted config must not restate it.
    expect(config.type).toBeUndefined();
    expect(config.data.datasets).toHaveLength(4);
    expect(config.data.datasets.map(function (d) { return d.label; })).toEqual([
      "Under 2 ft", "2-4 ft", "4 ft or more", "No data"
    ]);
    expect(config.data.datasets.map(function (d) { return d.data[0]; })).toEqual([5, 3, 2, 14]);
    expect(config.data.datasets.map(function (d) { return d.backgroundColor; })).toEqual([
      "var(--wa-color-green-50)",
      "var(--wa-color-yellow-70)",
      "var(--wa-color-red-50)",
      "var(--wa-color-gray-50)"
    ]);
    expect(config.options.plugins.title.display).toBe(false);
  });

  it("uses the same summary text for the aria description and the fallback paragraph", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({})
    });
    expect(html).toContain("description=\"" + SUMMARY + "\"");
    expect(html).toContain("<p class=\"wave-chart-fallback wa-caption-s\">" + SUMMARY + "</p>");
  });

  it("shows the 'now' wave stat with a toFixed(1) value", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.03 }),
      official: null,
      waves: wavesWith({})
    });
    expect(html).toContain("<span class=\"wave-now-value wa-font-size-xl wa-font-weight-bold\">1.0 ft</span>");
    expect(html).toContain("waves now (estimated)");
  });

  it("buoy-fallback beach (estimate height set, waves null) shows the stat but no chart", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 2.6 }),
      official: null,
      waves: null
    });
    expect(html).toContain("<span class=\"wave-now-value wa-font-size-xl wa-font-weight-bold\">2.6 ft</span>");
    expect(html).not.toContain("<wa-bar-chart");
    expect(html).not.toContain("<wa-line-chart");
    // The section heading still appears (the stat alone justifies it).
    expect(html).toContain("Wave forecast");
  });

  it("legacy estimate without waveHeightFt but with a series renders the chart, no stat", () => {
    const html = render({
      estimate: estimateWith({}), // no waveHeightFt field
      official: null,
      waves: wavesWith({})
    });
    expect(html).toContain("<wa-bar-chart");
    // The class ships in the stylesheet; assert the rendered span is absent.
    expect(html).not.toContain("<span class=\"wave-now-value");
  });

  it("renders no wave-forecast section when there is neither a height nor a series", () => {
    const html = render({ estimate: null, official: null, waves: null });
    // "Wave forecast" (the visible heading) and the section wrapper only exist
    // when the section renders; the CSS class names ship in the stylesheet
    // regardless, so match the rendered markers, not the bare class substring.
    expect(html).not.toContain("Wave forecast");
    expect(html).not.toContain("class=\"wave-forecast wa-stack");
  });

  it("defaults waves to null when the field is absent entirely", () => {
    const html = render({ estimate: estimateWith({}), official: null });
    // Legacy estimate (no height) + no waves -> no section, and no throw.
    expect(html).not.toContain("Wave forecast");
  });

  it("shows the stale-data warning when waves.updated is more than 2 h old", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({ updated: "2026-07-05T09:00:00.000Z" }) // 3 h before now
    });
    expect(html).toContain("Stale data — last updated " +
      "<wa-relative-time date=\"2026-07-05T09:00:00.000Z\" sync></wa-relative-time>");
  });

  it("includes the ESTIMATE badge in the section", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({})
    });
    const section = html.slice(html.indexOf("class=\"wave-forecast"));
    expect(section).toContain(">ESTIMATE</wa-badge>");
  });

  it("keeps the footer disclaimer on the page", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({})
    });
    expect(html).toContain(
      "Estimated — not the official flag status. Always obey posted flags and lifeguards.");
  });
});

describe("wave-forecast model comparison", () => {
  it("renders the per-model 'now' caption with the exact ' · ' text", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: threeModelWaves()
    });
    expect(html).toContain(
      "<p class=\"wave-model-now wa-caption-s\">" +
      "ECMWF 2.6 ft · NOAA GFS 2.4 ft · Météo-France 2.9 ft</p>");
  });

  it("renders a collapsed 'Compare wave models' disclosure (no open attribute)", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: threeModelWaves()
    });
    const open = "<wa-details class=\"wave-model-compare\" summary=\"Compare wave models\">";
    expect(html).toContain(open);
    // The dedicated line-chart element carries the y-axis unit as an attribute.
    expect(html).toContain("<wa-line-chart class=\"wave-model-chart\" without-animation y-label=\"ft\"");
    // Collapsed by default: the model disclosure's opening tag must not carry "open".
    const tagStart = html.indexOf("<wa-details class=\"wave-model-compare\"");
    const tagEnd = html.indexOf(">", tagStart);
    expect(html.slice(tagStart, tagEnd)).not.toContain(" open");
  });

  it("carries a parseable line config with model datasets, labels, and 1-decimal rounding", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: threeModelWaves()
    });
    const blocks = extractAllChartJson(html);
    expect(blocks).toHaveLength(2);
    const modelConfig = JSON.parse(blocks[1]);
    // The chart type comes from the <wa-line-chart> element itself — the
    // slotted config must not restate it.
    expect(modelConfig.type).toBeUndefined();
    expect(modelConfig.data.datasets.map(function (d) { return d.label; }))
      .toEqual(["ECMWF", "NOAA GFS", "Météo-France"]);
    expect(modelConfig.data.labels[0]).toBe("Now");
    expect(modelConfig.data.labels).toHaveLength(24);
    // 2.63 / 2.44 / 2.9 rounded to a single decimal.
    expect(modelConfig.data.datasets.map(function (d) { return d.data[0]; }))
      .toEqual([2.6, 2.4, 2.9]);
    expect(modelConfig.data.datasets[0].pointRadius).toBe(0);
    expect(modelConfig.data.datasets[0].spanGaps).toBe(false);
    // The "ft" y-axis label rides on the element's y-label attribute now — the
    // config carries no hand-written scales block.
    expect(modelConfig.options.scales).toBeUndefined();
  });

  it("never emits a literal closing script tag inside either JSON block", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: threeModelWaves()
    });
    const blocks = extractAllChartJson(html);
    expect(blocks).toHaveLength(2);
    blocks.forEach(function (json) {
      expect(json).not.toContain("</script");
    });
  });

  it("carries the same model summary in the aria description and the fallback", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: threeModelWaves()
    });
    const summary = "Wave height by model, next 24 hours — ECMWF now 2.6 ft, " +
      "NOAA GFS now 2.4 ft, Météo-France now 2.9 ft.";
    expect(html).toContain("label=\"Wave height by forecast model\" description=\"" + summary + "\"");
    expect(html).toContain("<p class=\"wave-chart-fallback wa-caption-s\">" + summary + "</p></wa-line-chart></wa-details>");
  });

  it("a single-model payload renders no caption and no disclosure, strip intact", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({ byModel: { ecmwf_wam025: modelHours(2.6) } })
    });
    // The class names ship in the stylesheet regardless — match rendered markers.
    expect(html).not.toContain("<p class=\"wave-model-now");
    expect(html).not.toContain("<wa-details class=\"wave-model-compare");
    expect(html).toContain("<wa-bar-chart class=\"wave-chart\"");
  });

  it("a legacy payload without byModel renders exactly as before (no caption/disclosure)", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({}) // no byModel field at all
    });
    // The class names ship in the stylesheet regardless — match rendered markers.
    expect(html).not.toContain("<p class=\"wave-model-now");
    expect(html).not.toContain("<wa-details class=\"wave-model-compare");
    // The band strip is untouched.
    expect(html).toContain("<wa-bar-chart class=\"wave-chart\"");
    expect(extractAllChartJson(html)).toHaveLength(1);
  });

  it("leaves the band strip's own config unchanged when the model chart is added", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: threeModelWaves()
    });
    const stripConfig = JSON.parse(extractAllChartJson(html)[0]);
    expect(stripConfig.type).toBeUndefined();
    expect(stripConfig.data.datasets.map(function (d) { return d.label; })).toEqual([
      "Under 2 ft", "2-4 ft", "4 ft or more", "No data"
    ]);
  });
});
