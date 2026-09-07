// test/renderSubtitle.test.js
// Covers the detail-page header composition (src/frontend/render.js), exercised
// through renderDetailPage: the park-first beach name in .beach-subtitle, and an
// optional NDBC water-temperature fragment on the coordinates line with its
// station, distance and observation age ("43.7842, -86.4400 • 72°F Water
// Muskegon, MI · ~3 mi · <wa-relative-time>"). The temp is display-only, never a
// flag input, and is shown only when fresh.

import { describe, it, expect } from "vitest";
import { renderDetailPage } from "../src/frontend/render.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

const OBSERVED_ISO = "2026-07-05T11:00:00.000Z";

// A fresh water-temp KV record (observedIso within the 12 h window of NOW_ISO).
function waterTempWith(extra) {
  return Object.assign(
    {
      beachId: "osm-way-505668572",
      tempF: 72,
      tempC: 22.2,
      station: { id: "45161", name: "Muskegon, MI", distanceKm: 5.0 },
      observedIso: OBSERVED_ISO,
      updated: NOW_ISO
    },
    extra
  );
}

// The live observation-age element, which carries the observedIso and never the
// cron's write time.
function relativeTime(iso) {
  return "<wa-relative-time date=\"" + iso + "\" sync></wa-relative-time>";
}

function detailHtml(beachExtra, waterTemp) {
  return renderDetailPage({
    beach: beachWith(beachExtra),
    estimate: null,
    official: null,
    waves: null,
    waterTemp: waterTemp,
    nowIso: NOW_ISO
  });
}

// The subtitle paragraph body, or null when the <p class="beach-subtitle"> is
// absent from the page entirely.
function subtitleText(html) {
  const m = html.match(/<p class="beach-subtitle">([^<]*)<\/p>/);
  return m ? m[1] : null;
}

// Everything the coordinates line carries after the OpenStreetMap link, as raw
// HTML: the temperature fragment, its provenance caption and its tooltip. "" when
// the line carries only the coordinates.
function metaTail(html) {
  const m = html.match(/<p class="beach-meta wa-caption-s"><a class="coords-link"[^>]*>[\s\S]*?<\/a>([\s\S]*?)<\/p>/);
  return m ? m[1] : null;
}

// The plain-text temperature fragment alone, without the provenance markup that
// follows it.
function tempText(html) {
  const tail = metaTail(html);
  return tail === null ? null : tail.split("<")[0].replace(/\s+$/, "");
}

describe("beach header composition (renderDetailPage)", function () {
  it("keeps the subtitle to the beach name and puts the temp on the coordinates line", function () {
    // Distinct park + beach name -> subtitle is the beach's own name.
    const html = detailHtml(
      { park_name: "Holland State Park", name: "Ottawa Beach" },
      waterTempWith({})
    );
    expect(subtitleText(html)).toBe("Ottawa Beach");
    expect(metaTail(html)).toBe(
      " • 72°F Water " +
      "<span class=\"water-temp-src\" id=\"water-temp\">Muskegon, MI · ~3 mi · " +
      relativeTime(OBSERVED_ISO) + "</span>" +
      "<wa-tooltip for=\"water-temp\">Water temperature measured at Muskegon, MI, " +
      "~3 mi away</wa-tooltip>"
    );
  });

  it("rounds a fractional tempF to the nearest whole degree", function () {
    // parseNdbcWaterTempF always yields a fractional tempF (e.g. 24.6 C -> 76.28 F),
    // so the label must round it — 72.6 F -> "73°F Water", never "72.6°F Water".
    const html = detailHtml(
      { park_name: "Holland State Park", name: "Ottawa Beach" },
      waterTempWith({ tempF: 72.6 })
    );
    expect(tempText(html)).toBe(" • 73°F Water");
  });

  it("renders the temp on the coordinates line with no subtitle when there is no park", function () {
    // park_name null -> subtitleName is null, so no subtitle paragraph at all.
    const html = detailHtml({ park_name: null, name: "Ottawa Beach" }, waterTempWith({}));
    expect(subtitleText(html)).toBe(null);
    expect(tempText(html)).toBe(" • 72°F Water");
    expect(html.indexOf("Muskegon, MI · ~3 mi")).toBeGreaterThan(-1);
  });

  it("renders the coordinates alone when there is no water temp", function () {
    const html = detailHtml(
      { park_name: "Holland State Park", name: "Ottawa Beach" },
      null
    );
    expect(subtitleText(html)).toBe("Ottawa Beach");
    expect(metaTail(html)).toBe("");
  });

  it("omits a stale water temp and its provenance", function () {
    // observedIso 24 h before NOW_ISO -> older than WATER_TEMP_STALE_MS (12 h).
    const html = detailHtml(
      { park_name: "Holland State Park", name: "Ottawa Beach" },
      waterTempWith({ observedIso: "2026-07-04T12:00:00.000Z" })
    );
    expect(metaTail(html)).toBe("");
    expect(html.indexOf("°F Water")).toBe(-1);
    expect(html.indexOf("id=\"water-temp\"")).toBe(-1);
    expect(html.indexOf("Muskegon, MI")).toBe(-1);
  });

  it("omits the temp when observedIso is missing or unparseable", function () {
    const missing = detailHtml(
      { park_name: "Holland State Park", name: "Ottawa Beach" },
      waterTempWith({ observedIso: undefined })
    );
    expect(metaTail(missing)).toBe("");
    const bad = detailHtml(
      { park_name: "Holland State Park", name: "Ottawa Beach" },
      waterTempWith({ observedIso: "not-a-date" })
    );
    expect(metaTail(bad)).toBe("");
  });

  it("keeps the temp and the age when the record carries no station", function () {
    // A record missing its station still reports the reading; only the station
    // half of the provenance drops, and with it the tooltip it would anchor.
    const html = detailHtml({ park_name: null, name: "Ottawa Beach" }, waterTempWith({ station: null }));
    expect(metaTail(html)).toBe(
      " • 72°F Water <span class=\"water-temp-src\">" + relativeTime(OBSERVED_ISO) + "</span>"
    );
    expect(html.indexOf("wa-tooltip for=\"water-temp\"")).toBe(-1);
  });

  it("keeps the station name when distanceKm is not a finite number", function () {
    const html = detailHtml(
      { park_name: null, name: "Ottawa Beach" },
      waterTempWith({ station: { id: "45161", name: "Muskegon, MI", distanceKm: null } })
    );
    expect(metaTail(html)).toBe(
      " • 72°F Water " +
      "<span class=\"water-temp-src\" id=\"water-temp\">Muskegon, MI · " +
      relativeTime(OBSERVED_ISO) + "</span>" +
      "<wa-tooltip for=\"water-temp\">Water temperature measured at Muskegon, " +
      "MI</wa-tooltip>"
    );
  });

  it("renders a sub-mile station distance the way list rows do", function () {
    const html = detailHtml(
      { park_name: null, name: "Ottawa Beach" },
      waterTempWith({ station: { id: "45161", name: "", distanceKm: 0.8 } })
    );
    expect(metaTail(html)).toBe(
      " • 72°F Water " +
      "<span class=\"water-temp-src\" id=\"water-temp\">&lt;1 mi · " +
      relativeTime(OBSERVED_ISO) + "</span>" +
      "<wa-tooltip for=\"water-temp\">Water temperature measured &lt;1 mi away</wa-tooltip>"
    );
  });

  it("escapes a station name in both the caption and the tooltip", function () {
    const html = detailHtml(
      { park_name: null, name: "Ottawa Beach" },
      waterTempWith({ station: { id: "45029", name: "St. Joseph's <MI>", distanceKm: 5.0 } })
    );
    expect(html.indexOf("St. Joseph&#39;s &lt;MI&gt; · ~3 mi")).toBeGreaterThan(-1);
    expect(html.indexOf("measured at St. Joseph&#39;s &lt;MI&gt;, ~3 mi away")).toBeGreaterThan(-1);
    expect(html.indexOf("St. Joseph's")).toBe(-1);
  });

  it("renders no subtitle paragraph when the beach has no distinct name", function () {
    const html = detailHtml({ park_name: null, name: "Ottawa Beach" }, null);
    expect(subtitleText(html)).toBe(null);
    expect(html.indexOf("class=\"beach-subtitle\"")).toBe(-1);
    expect(metaTail(html)).toBe("");
  });
});
