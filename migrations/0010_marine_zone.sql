-- NWS marine forecast zone enrichment. US Great Lakes beaches sit on land, so
-- their nws_zone is a land public forecast zone (e.g. "MIZ056") that NWS marine
-- warnings (Gale / Storm / Special Marine) and Small Craft Advisory are never
-- issued for — those products are zoned to the adjacent marine zone (e.g.
-- "LMZ874"). marine_zone holds that adjacent zone id, derived offline by the
-- discovery batch's nearestMarineZone pass (point-in-polygon, falling back to
-- nearest-edge within a 15 km cap) over the repo-committed NWS marine-zone
-- shapefile geometry (data/marine-zones.json), letting the hourly recompute
-- match marine alerts from the same national /alerts/active fetch it already
-- makes — no extra upstream call. marine_zone derivation is gated to US beaches
-- (nws_zone NOT NULL); Canadian marine waters belong to ECCC, not NWS.
-- marine_attempts is vestigial: the column stays but nothing writes it.
ALTER TABLE beaches ADD COLUMN marine_zone TEXT;
ALTER TABLE beaches ADD COLUMN marine_attempts INTEGER NOT NULL DEFAULT 0;
