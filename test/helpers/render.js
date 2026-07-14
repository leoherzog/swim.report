// test/helpers/render.js
// Shared fixtures for the detail-page renderer tests (renderDetailPage).
export const NOW_ISO = "2026-07-05T12:00:00.000Z";

// Minimal valid BeachRow (PLAN.md section 1). Individual tests spread extra
// fields (webcam columns, etc.) on top of this base.
export function beachWith(extra) {
  const base = {
    id: "osm-way-505668572",
    name: "Ottawa Beach",
    park_name: null,
    lat: 42.775,
    lon: -86.211,
    nws_zone: null,
    nws_grid_url: null,
    osm_id: "way/505668572"
  };
  return Object.assign(base, extra);
}
