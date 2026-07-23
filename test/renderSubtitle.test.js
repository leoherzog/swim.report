// test/renderSubtitle.test.js
// Covers the detail-page .beach-subtitle composition (src/frontend/render.js),
// exercised through renderDetailPage: the park-first beach name plus an optional
// NDBC water-temperature fragment ("Ottawa Beach • 72°F Water"). The temp is
// DISPLAY-ONLY (never a flag input) and is shown only when fresh. Project style:
// ES modules, NO template literals (string concat with +), function () {}
// callbacks.

import { describe, it, expect } from "vitest";
import { renderDetailPage } from "../src/frontend/render.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

// A fresh water-temp KV record (observedIso within the 12 h window of NOW_ISO).
function waterTempWith(extra) {
  return Object.assign(
    {
      beachId: "osm-way-505668572",
      tempF: 72,
      tempC: 22.2,
      station: { id: "45161", name: "Muskegon, MI", distanceKm: 5.0 },
      observedIso: "2026-07-05T11:00:00.000Z",
      updated: NOW_ISO
    },
    extra
  );
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

describe("beach-subtitle composition (renderDetailPage)", function () {
  it("renders base name and fresh water temp joined by a bullet", function () {
    // Distinct park + beach name -> base is the beach's own name.
    const html = detailHtml(
      { park_name: "Holland State Park", name: "Ottawa Beach" },
      waterTempWith({})
    );
    expect(subtitleText(html)).toBe("Ottawa Beach • 72°F Water");
  });

  it("rounds a fractional tempF to the nearest whole degree", function () {
    // parseNdbcWaterTempF always yields a fractional tempF (e.g. 24.6 C -> 76.28 F),
    // so the subtitle must round it — 72.6 F -> "73°F Water", never "72.6°F Water".
    const html = detailHtml(
      { park_name: "Holland State Park", name: "Ottawa Beach" },
      waterTempWith({ tempF: 72.6 })
    );
    expect(subtitleText(html)).toBe("Ottawa Beach • 73°F Water");
  });

  it("renders temp only when the beach has no distinct subtitle name", function () {
    // park_name null -> subtitleName is null, so only the temp fragment shows.
    const html = detailHtml({ park_name: null, name: "Ottawa Beach" }, waterTempWith({}));
    expect(subtitleText(html)).toBe("72°F Water");
  });

  it("renders base only when there is no water temp", function () {
    const html = detailHtml(
      { park_name: "Holland State Park", name: "Ottawa Beach" },
      null
    );
    expect(subtitleText(html)).toBe("Ottawa Beach");
  });

  it("omits a stale water temp, keeping the base name alone", function () {
    // observedIso 24 h before NOW_ISO -> older than WATER_TEMP_STALE_MS (12 h).
    const html = detailHtml(
      { park_name: "Holland State Park", name: "Ottawa Beach" },
      waterTempWith({ observedIso: "2026-07-04T12:00:00.000Z" })
    );
    expect(subtitleText(html)).toBe("Ottawa Beach");
  });

  it("omits the temp when observedIso is missing or unparseable", function () {
    const missing = detailHtml(
      { park_name: "Holland State Park", name: "Ottawa Beach" },
      waterTempWith({ observedIso: undefined })
    );
    expect(subtitleText(missing)).toBe("Ottawa Beach");
    const bad = detailHtml(
      { park_name: "Holland State Park", name: "Ottawa Beach" },
      waterTempWith({ observedIso: "not-a-date" })
    );
    expect(subtitleText(bad)).toBe("Ottawa Beach");
  });

  it("renders no subtitle paragraph when neither base nor temp is present", function () {
    // No distinct name and no water temp -> the <p class=\"beach-subtitle\"> is absent.
    const html = detailHtml({ park_name: null, name: "Ottawa Beach" }, null);
    expect(subtitleText(html)).toBe(null);
    expect(html.indexOf("class=\"beach-subtitle\"")).toBe(-1);
  });
});
