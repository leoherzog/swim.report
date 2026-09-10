-- Per-beach derived state: the estimate, the scraped official flag, the
-- water-quality floor and the point-in-time reading, one row per beach. Holding
-- them here lets the request path resolve a beach and its state in one query,
-- and lets the map endpoint read scalar columns rather than a per-beach key.
--
-- Every *_expires column is absolute epoch seconds: a reader treats a record
-- whose expires <= floor(now/1000) as absent. Expiry is the only retraction
-- path, so a run that produces no official, wqfloor or reading leaves that
-- column alone rather than clearing it (the upsert in src/beachState.js
-- COALESCEs every column).
--
-- No foreign key. Reconciliation deletes beaches offline, so an orphan row here
-- is possible; it is invisible to every JOIN and costs only storage. Nothing
-- deletes it yet.
CREATE TABLE IF NOT EXISTS beach_state (
  beach_id TEXT PRIMARY KEY,
  estimate TEXT,
  estimate_color TEXT,
  estimate_updated TEXT,
  estimate_expires INTEGER,
  official TEXT,
  official_color TEXT,
  official_updated TEXT,
  official_expires INTEGER,
  wqfloor TEXT,
  wqfloor_expires INTEGER,
  reading TEXT,
  reading_expires INTEGER
);
