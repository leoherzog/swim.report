// test/renderWaveForecast.test.js
// Covers the wave-forecast section on the detail page (src/frontend/render.js),
// exercised through renderDetailPage (mirrors renderWebcam.test.js). Asserts the
// section's placement, the colored flex-row strip and its per-segment tooltips,
// the "now" stat, the buoy/legacy/absent variants, the stale warning, the
// ESTIMATE badge, and that the footer disclaimer survives.

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

const SUMMARY = "Under 2 ft for 5 hours from now, then 2–4 ft for 3 hours, " +
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
    // Match the rendered card's attribute, not the bare class name — a
    // .estimate-card selector also ships in the embedded <head> stylesheet,
    // which would make this order assertion vacuous.
    const estimateIdx = html.indexOf("class=\"estimate-card\"");
    const waveIdx = html.indexOf("class=\"wave-forecast");
    const webcamIdx = html.indexOf("webcam-section");
    expect(estimateIdx).toBeGreaterThan(-1);
    expect(waveIdx).toBeGreaterThan(estimateIdx);
    expect(webcamIdx).toBeGreaterThan(waveIdx);
    // The wave map demotes to supporting exploration: after the forecast,
    // before the webcam. (Match the rendered <section> marker, not the bare
    // class — .wave-map-frame also appears in the embedded stylesheet.)
    const mapIdx = html.indexOf("<section class=\"wave-map");
    expect(mapIdx).toBeGreaterThan(waveIdx);
    expect(webcamIdx).toBeGreaterThan(mapIdx);
  });

  it("renders the strip as a flex row of proportional colored segments", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({})
    });
    expect(html).toContain("<div class=\"wave-strip\" role=\"list\" " +
      "aria-label=\"Wave height forecast for the next 24 hours\">");
    expect(html).toContain("id=\"wave-seg-0\"");
    expect(html).toContain("style=\"flex: 5 5 0%; background: var(--wa-color-green-50);\"");
    expect(html).toContain("style=\"flex: 3 3 0%; background: var(--wa-color-yellow-70);\"");
    expect(html).toContain("style=\"flex: 2 2 0%; background: var(--wa-color-red-50);\"");
    expect(html).toContain("style=\"flex: 14 14 0%; background: var(--wa-color-gray-50);\"");
    expect(html).toContain("tabindex=\"0\"");
  });

  it("carries a wa-tooltip per segment with band label and hour range", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({})
    });
    expect(html).toContain(
      "<wa-tooltip for=\"wave-seg-0\">Under 2 ft waves (estimated) — now through +5 h</wa-tooltip>");
    expect(html).toContain(
      "<wa-tooltip for=\"wave-seg-1\">2–4 ft waves (estimated) — +5 h to +8 h</wa-tooltip>");
    expect(html).toContain(
      "<wa-tooltip for=\"wave-seg-2\">4 ft or more waves (estimated) — +8 h to +10 h</wa-tooltip>");
    expect(html).toContain(
      "<wa-tooltip for=\"wave-seg-3\">No wave data — +10 h to +24 h</wa-tooltip>");
  });

  it("keeps the prose summary for assistive tech and mirrors tooltip text in aria-labels", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({})
    });
    expect(html).toContain("<p class=\"wa-visually-hidden\">" + SUMMARY + "</p>");
    // Each segment's aria-label equals its tooltip text (spot-check the first).
    expect(html).toContain(
      "aria-label=\"Under 2 ft waves (estimated) — now through +5 h\"");
  });

  it("shows the 'now' wave stat with a toFixed(1) value", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.03 }),
      official: null,
      waves: wavesWith({})
    });
    expect(html).toContain("<span class=\"wave-now-value wa-font-size-xl wa-font-weight-bold\">1.0 ft</span>");
    expect(html).toContain("waves now");
  });

  it("buoy-fallback beach (estimate height set, waves null) shows the stat but no chart", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 2.6 }),
      official: null,
      waves: null
    });
    expect(html).toContain("<span class=\"wave-now-value wa-font-size-xl wa-font-weight-bold\">2.6 ft</span>");
    expect(html).not.toContain("<div class=\"wave-strip\"");
    expect(html).not.toContain("<wa-line-chart");
    // The section wrapper still renders (the stat alone justifies it).
    expect(html).toContain("<section class=\"wave-forecast wa-stack");
  });

  it("legacy estimate without waveHeightFt but with a series renders the strip, no stat", () => {
    const html = render({
      estimate: estimateWith({}), // no waveHeightFt field
      official: null,
      waves: wavesWith({})
    });
    expect(html).toContain("<div class=\"wave-strip\"");
    // The class ships in the stylesheet; assert the rendered span is absent.
    expect(html).not.toContain("<span class=\"wave-now-value");
  });

  it("renders no wave-forecast section when there is neither a height nor a series", () => {
    const html = render({ estimate: null, official: null, waves: null });
    // The section wrapper only exists when the section renders; the CSS class
    // names ship in the stylesheet regardless, so match the rendered marker,
    // not the bare class substring.
    expect(html).not.toContain("class=\"wave-forecast wa-stack");
  });

  it("defaults waves to null when the field is absent entirely", () => {
    const html = render({ estimate: estimateWith({}), official: null });
    // Legacy estimate (no height) + no waves -> no section, and no throw.
    expect(html).not.toContain("class=\"wave-forecast wa-stack");
  });

  it("shows the stale-data warning when waves.updated is more than 8 h old", () => {
    // The wave strip refreshes on the 6-hourly wave cron, so its staleness
    // threshold is 8 h (a clearly-missed cycle), not the flag's 2 h.
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({ updated: "2026-07-05T03:00:00.000Z" }) // 9 h before now
    });
    expect(html).toContain("Stale data — last updated " +
      "<wa-relative-time date=\"2026-07-05T03:00:00.000Z\" sync></wa-relative-time>");
  });

  it("does NOT warn on wave data a few hours old (within the 6-hourly cadence)", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({ updated: "2026-07-05T09:00:00.000Z" }) // 3 h before now
    });
    expect(html).not.toContain("Stale data — last updated");
  });

  it("puts the ESTIMATE badge on the now-stat line, with no section heading", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({})
    });
    // The badge rides the "waves now" stat line (the former "Wave forecast"
    // h2 heading row is gone).
    const nowStart = html.indexOf("<p class=\"wave-now");
    expect(nowStart).toBeGreaterThan(-1);
    const nowLine = html.slice(nowStart, html.indexOf("</p>", nowStart));
    expect(nowLine).toContain("waves now");
    expect(nowLine).toContain(">ESTIMATE</wa-badge>");
    expect(html).not.toContain("wave-forecast-heading");
  });

  it("legacy estimate without a now-stat still carries the ESTIMATE badge in the section", () => {
    const html = render({
      estimate: estimateWith({}), // no waveHeightFt -> no stat line
      official: null,
      waves: wavesWith({})
    });
    const section = html.slice(html.indexOf("<section class=\"wave-forecast"));
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
    const open = "<wa-details class=\"wave-model-compare\" summary=\"Compare wave models\" " +
      "appearance=\"plain\" icon-placement=\"start\">";
    expect(html).toContain(open);
    // The "ft" y-axis unit rides on the element via the yLabel attribute
    // (empirically the axis title renders from parsed HTML). The kebab
    // y-label spelling is dead and must never be emitted.
    expect(html).toContain("<wa-line-chart class=\"wave-model-chart\" without-animation yLabel=\"ft\"");
    expect(html).not.toContain("y-label=");
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
    expect(blocks).toHaveLength(1);
    const modelConfig = JSON.parse(blocks[0]);
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
    // Points are hidden via the --point-radius CSS custom property on the
    // .wave-model-chart element (styles.js), not a restated pointRadius key.
    // Positively assert the hiding mechanism ships in the page's embedded
    // styles, so deleting the CSS declaration fails the suite.
    expect(html).toContain("--point-radius: 0");
    expect(modelConfig.data.datasets[0]).not.toHaveProperty("pointRadius");
    expect(modelConfig.data.datasets[0].spanGaps).toBe(false);
    // The "ft" y-axis label rides on the element (yLabel attribute), not the
    // slotted config — so the config carries no scales block. It keeps only
    // plugins.title.display false to suppress the element's label leaking as
    // a visible chart title.
    expect(modelConfig.options.scales).toBeUndefined();
    expect(modelConfig.options.plugins.title.display).toBe(false);
  });

  it("never emits a literal closing script tag inside the JSON block", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: threeModelWaves()
    });
    const blocks = extractAllChartJson(html);
    expect(blocks).toHaveLength(1);
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
    expect(html).toContain("<div class=\"wave-strip\"");
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
    // The band strip is untouched, and no chart JSON ships at all.
    expect(html).toContain("<div class=\"wave-strip\"");
    expect(extractAllChartJson(html)).toHaveLength(0);
  });
});

describe("wave-forecast hazard lane", () => {
  // NOW_ISO is 2026-07-05T12:00:00.000Z; this alert runs now -> +14 h.
  const BHS_DETAIL = {
    event: "Beach Hazards Statement",
    onset: "2026-07-05T10:00:00.000Z",
    ends: "2026-07-06T02:00:00.000Z"
  };

  it("renders an alert band positioned by the alert's period, above the strip", () => {
    const html = render({
      estimate: estimateWith({
        waveHeightFt: 3.1,
        alertDetails: [BHS_DETAIL]
      }),
      official: null,
      waves: wavesWith({})
    });
    const bandStart = html.indexOf("<div class=\"wave-alert-band\"");
    expect(bandStart).toBeGreaterThan(-1);
    const band = html.slice(bandStart, html.indexOf("</div></div>", bandStart));
    // Onset before now clamps to the window start; ends at +14 h of 24.
    expect(band).toContain("left: 0%; width: " + ((14 / 24) * 100) + "%;");
    expect(band).toContain("background: var(--wa-color-danger-fill-quiet);");
    expect(band).toContain(
      "<span class=\"wave-alert-label\">Beach Hazards Statement</span>");
    // Tooltip and aria-label carry the name plus the period.
    expect(html).toContain("<wa-tooltip for=\"wave-alert-0\">" +
      "NWS alert: Beach Hazards Statement — now through +14 h</wa-tooltip>");
    expect(band).toContain(
      "aria-label=\"NWS alert: Beach Hazards Statement — now through +14 h\"");
    // The lane renders before (above) the strip.
    expect(bandStart).toBeLessThan(html.indexOf("<div class=\"wave-strip\""));
  });

  it("an alert starting mid-window gets a mid-window band", () => {
    const html = render({
      estimate: estimateWith({
        waveHeightFt: 3.1,
        alertDetails: [{
          event: "High Surf Warning",
          onset: "2026-07-05T18:00:00.000Z", // +6 h
          ends: "2026-07-06T18:00:00.000Z"   // beyond the window -> clamped
        }]
      }),
      official: null,
      waves: wavesWith({})
    });
    expect(html).toContain("left: 25%; width: 75%;");
    expect(html).toContain("<wa-tooltip for=\"wave-alert-0\">" +
      "NWS alert: High Surf Warning — +6 h to +24 h</wa-tooltip>");
  });

  it("ignores non-flag-relevant alerts", () => {
    const html = render({
      estimate: estimateWith({
        waveHeightFt: 1.0,
        alertDetails: [{ event: "Winter Storm Warning", onset: null, ends: null }]
      }),
      official: null,
      waves: wavesWith({})
    });
    expect(html).not.toContain("<div class=\"wave-alert-band\"");
  });

  it("renders a full-window rip-current band naming the SRF source", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0, ripCurrentRisk: "HIGH" }),
      official: null,
      waves: wavesWith({})
    });
    const bandStart = html.indexOf("<div class=\"wave-alert-band\"");
    expect(bandStart).toBeGreaterThan(-1);
    const band = html.slice(bandStart, html.indexOf("</div></div>", bandStart));
    expect(band).toContain("left: 0%; width: 100%;");
    expect(band).toContain(
      "<span class=\"wave-alert-label\">Rip current risk: HIGH</span>");
    expect(html).toContain("<wa-tooltip for=\"wave-alert-0\">" +
      "Rip current risk HIGH — from the latest NWS surf zone forecast</wa-tooltip>");
  });

  it("legacy estimate without the echo fields renders no lane", () => {
    const html = render({
      estimate: estimateWith({ waveHeightFt: 1.0 }),
      official: null,
      waves: wavesWith({})
    });
    expect(html).not.toContain("<div class=\"wave-alert-band\"");
  });

  it("renders no lane without a series to overlay (buoy-fallback beach)", () => {
    const html = render({
      estimate: estimateWith({
        waveHeightFt: 2.6,
        alertDetails: [BHS_DETAIL]
      }),
      official: null,
      waves: null
    });
    expect(html).not.toContain("<div class=\"wave-alert-band\"");
  });
});
