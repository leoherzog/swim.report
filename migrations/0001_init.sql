CREATE TABLE beaches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  nws_zone TEXT,
  nws_grid_url TEXT,
  osm_id TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_beaches_osm_id ON beaches(osm_id);
CREATE INDEX idx_beaches_lon_lat ON beaches(lon, lat);
CREATE INDEX idx_beaches_nws_zone ON beaches(nws_zone);

CREATE TABLE sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated TEXT NOT NULL
);
