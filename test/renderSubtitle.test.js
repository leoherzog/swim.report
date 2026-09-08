// test/renderSubtitle.test.js
// Covers the detail-page header composition (src/frontend/render.js), exercised
// through renderDetailPage: the park-first beach name in .beach-subtitle, the
// coordinates line with the Directions link that closes it, and the NDBC
// water-temperature reading in its "at a glance" tile, whose source line and
// tooltip state the same station and distance. The temp is display-only, never
// a flag input, and is shown only when fresh; the coordinates line carries the
// coordinates and the Directions link alone.

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
// HTML, so an addition to the line has to be spelled out rather than slipping
// past. "" for a beach with no coordinates to offer directions to.
function metaTail(html) {
  const m = html.match(/<p class="beach-meta wa-caption-s"><a class="coords-link"[^>]*>[\s\S]*?<\/a>([\s\S]*?)<\/p>/);
  return m ? m[1] : null;
}

// The water-temperature tile's markup, from its icon to the end of its card.
function tempTile(html) {
  const start = html.indexOf("name=\"temperature-half\"");
  if (start === -1) {
    return null;
  }
  return html.slice(start, html.indexOf("</wa-card>", start));
}

// The tile's value line. A page with no usable reading renders no tile at all,
// so this is null there rather than a placeholder.
function tempValue(html) {
  const tile = tempTile(html);
  const m = tile ? tile.match(/<span class="glance-value[^"]*">([^<]*)<\/span>/) : null;
  return m ? m[1] : null;
}

// The tile's quiet source line, with the relative-time element left intact.
function tempSource(html) {
  const tile = tempTile(html);
  const m = tile ? tile.match(/<span class="glance-source[^"]*">(.*?)<\/span><\/div>/) : null;
  return m ? m[1] : null;
}

// The Directions anchor the coordinates line always ends with for a beach that
// has coordinates (beachWith: 42.775, -86.211).
const DIRECTIONS = " • <a class=\"directions-link\"" +
  " href=\"https://www.google.com/maps/dir/?api=1&amp;destination=42.77500,-86.21100\"" +
  " rel=\"noopener noreferrer\" target=\"_blank\">" +
  "<wa-icon name=\"diamond-turn-right\"></wa-icon> Directions</a>";

describe("beach header composition (renderDetailPage)", function () {
  it("keeps the subtitle to the beach name and the temp off the coordinates line", function () {
    // Distinct park + beach name -> subtitle is the beach's own name.
    const html = detailHtml(
      { park_name: "Holland State Park", name: "Ottawa Beach" },
      waterTempWith({})
    );
    expect(subtitleText(html)).toBe("Ottawa Beach");
    // A fresh reading exists, and none of it is on this line: it belongs to the
    // tile, which is the only place the station is named.
    expect(metaTail(html)).toBe(DIRECTIONS);
    expect(html.indexOf("°F Water")).toBe(-1);
    expect(tempSource(html)).toContain("Muskegon, MI");
  });

  it("renders no subtitle paragraph when the beach has no distinct name", function () {
    const html = detailHtml({ park_name: null, name: "Ottawa Beach" }, null);
    expect(subtitleText(html)).toBe(null);
    expect(html.indexOf("class=\"beach-subtitle\"")).toBe(-1);
    expect(metaTail(html)).toBe(DIRECTIONS);
  });
});

describe("directions link on the coordinates line (renderDetailPage)", function () {
  it("links to Google Maps directions at 5 decimals, escaped, beside the OpenStreetMap link", function () {
    const html = detailHtml({ park_name: null, name: "Ottawa Beach" }, null);
    expect(html).toContain("<a class=\"directions-link\"" +
      " href=\"https://www.google.com/maps/dir/?api=1&amp;destination=42.77500,-86.21100\"" +
      " rel=\"noopener noreferrer\" target=\"_blank\">" +
      "<wa-icon name=\"diamond-turn-right\"></wa-icon> Directions</a>");
    // The OpenStreetMap link stays; the directions link is additive.
    expect(html).toContain("<a class=\"coords-link\" href=\"" +
      "https://www.openstreetmap.org/?mlat=42.7750&amp;mlon=-86.2110#map=15/42.7750/-86.2110\"");
  });

  it("renders no directions link when a coordinate is missing", function () {
    // Number(null) is 0, so a coordinate-less row must never route to 0,0.
    const missing = detailHtml({ lat: null, lon: null }, null);
    expect(missing).not.toContain("<a class=\"directions-link\"");
    expect(missing).not.toContain("maps/dir");
    expect(metaTail(missing)).toBe("");
    const undef = detailHtml({ lat: undefined, lon: -86.211 }, null);
    expect(undef).not.toContain("<a class=\"directions-link\"");
    const unparseable = detailHtml({ lat: "not-a-number", lon: -86.211 }, null);
    expect(unparseable).not.toContain("<a class=\"directions-link\"");
  });
});

describe("water-temperature tile (renderDetailPage)", function () {
  it("shows the reading with its station, distance and observation age", function () {
    const html = detailHtml(
      { park_name: "Holland State Park", name: "Ottawa Beach" },
      waterTempWith({})
    );
    expect(tempValue(html)).toBe("72°F");
    expect(tempTile(html)).toContain(">Water temperature</span>");
    // 5.0 km -> ~3 mi; the age rides a live <wa-relative-time>, never a
    // server-computed phrase. The tooltip states the same station and distance
    // as the visible source line, so the two can never disagree.
    expect(tempSource(html)).toBe(
      "<span class=\"water-temp-src\" id=\"water-temp\">Muskegon, MI · ~3 mi · " +
      relativeTime(OBSERVED_ISO) + "</span>" +
      "<wa-tooltip for=\"water-temp\">Water temperature measured at Muskegon, MI, " +
      "~3 mi away</wa-tooltip>");
  });

  it("rounds a fractional tempF to the nearest whole degree", function () {
    // parseNdbcWaterTempF always yields a fractional tempF (e.g. 24.6 C -> 76.28 F),
    // so the tile must round it — 72.6 F -> "73°F", never "72.6°F".
    const html = detailHtml({}, waterTempWith({ tempF: 72.6 }));
    expect(tempValue(html)).toBe("73°F");
  });

  it("renders no tile at all when there is no water temp", function () {
    expect(tempTile(detailHtml({}, null))).toBe(null);
  });

  it("renders no tile for a stale reading", function () {
    // observedIso 24 h before NOW_ISO -> older than WATER_TEMP_STALE_MS (12 h).
    const html = detailHtml({}, waterTempWith({ observedIso: "2026-07-04T12:00:00.000Z" }));
    expect(tempTile(html)).toBe(null);
    expect(html.indexOf("72°F")).toBe(-1);
  });

  it("renders no tile when observedIso is missing or unparseable", function () {
    expect(tempTile(detailHtml({}, waterTempWith({ observedIso: undefined })))).toBe(null);
    expect(tempTile(detailHtml({}, waterTempWith({ observedIso: "not-a-date" })))).toBe(null);
  });

  it("renders no tile for a non-finite tempF", function () {
    expect(tempTile(detailHtml({}, waterTempWith({ tempF: null })))).toBe(null);
    expect(tempTile(detailHtml({}, waterTempWith({ tempF: Number.NaN })))).toBe(null);
  });

  it("names only what it knows when the station block is partial", function () {
    const noName = detailHtml({}, waterTempWith({ station: { id: "45161", distanceKm: 5.0 } }));
    expect(tempValue(noName)).toBe("72°F");
    expect(tempSource(noName)).toBe(
      "<span class=\"water-temp-src\" id=\"water-temp\">~3 mi · " +
      relativeTime(OBSERVED_ISO) + "</span>" +
      "<wa-tooltip for=\"water-temp\">Water temperature measured ~3 mi away</wa-tooltip>");

    const noDistance = detailHtml({}, waterTempWith({ station: { id: "45161", name: "Muskegon, MI" } }));
    expect(tempSource(noDistance)).toBe(
      "<span class=\"water-temp-src\" id=\"water-temp\">Muskegon, MI · " +
      relativeTime(OBSERVED_ISO) + "</span>" +
      "<wa-tooltip for=\"water-temp\">Water temperature measured at Muskegon, MI</wa-tooltip>");

    // With neither fact left there is nothing for a tooltip to restate, so the
    // age stands alone and no tooltip is emitted.
    const noStation = detailHtml({}, waterTempWith({ station: null }));
    expect(tempValue(noStation)).toBe("72°F");
    expect(tempSource(noStation)).toBe(
      "<span class=\"water-temp-src\">" + relativeTime(OBSERVED_ISO) + "</span>");
    expect(noStation.indexOf("wa-tooltip for=\"water-temp\"")).toBe(-1);
  });

  it("escapes a station name carrying markup", function () {
    const html = detailHtml({}, waterTempWith({
      station: { id: "x", name: "Bay <script>alert(1)", distanceKm: 5.0 }
    }));
    // Escaped in both the source line and the sentence the tooltip repeats.
    expect(tempSource(html)).toContain("Bay &lt;script&gt;alert(1) · ~3 mi ·");
    expect(tempSource(html)).toContain("measured at Bay &lt;script&gt;alert(1), ~3 mi away");
    expect(html).not.toContain("<script>alert(1)");
  });

  it("keeps a sub-mile station honest with the <1 mi label", function () {
    const html = detailHtml({}, waterTempWith({
      station: { id: "45161", name: "Muskegon, MI", distanceKm: 1.2 }
    }));
    expect(tempSource(html)).toContain("Muskegon, MI · &lt;1 mi ·");
  });
});
