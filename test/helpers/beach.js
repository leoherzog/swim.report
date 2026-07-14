// test/helpers/beach.js
// Shared BeachRow builder for scraper matches()/resolveSiteForBeach tests.
// Those code paths read only name, park_name, lat, and lon; id, osm_id,
// nws_zone, and nws_grid_url are boilerplate, so each test overrides only the
// fields that drive the behavior under test (name/lat/lon, and park_name where
// it is load-bearing).
export function makeBeach(overrides) {
  const base = {
    id: "osm-test",
    name: "Test Beach",
    park_name: null,
    lat: 0,
    lon: 0,
    nws_zone: null,
    nws_grid_url: null,
    osm_id: "node/test"
  };
  return Object.assign(base, overrides || {});
}
