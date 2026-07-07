-- NWS enrichment attempt counter. api.weather.gov 404s for non-US points
-- (Ontario shoreline swept in by PILOT_BBOX), so those rows stay nws_zone IS
-- NULL forever. Without a cap, they sort first under the enrichment query's
-- ORDER BY id LIMIT 30 and permanently occupy the batch, starving US beaches.
-- The enrichment step skips rows whose attempts have reached the cap
-- (enrichment_attempts >= 5) so the backlog drains past permanent failures.
ALTER TABLE beaches ADD COLUMN enrichment_attempts INTEGER NOT NULL DEFAULT 0;
