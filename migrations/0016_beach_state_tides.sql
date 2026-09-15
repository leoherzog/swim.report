-- The per-beach tide table: the "Tides" block of the beach's own zone segment
-- in the latest NWS Surf Zone Forecast, stored as the product's own event
-- strings. Display-only: it never reaches src/rules.js.
--
-- tides_expires is absolute epoch seconds under migration 0014's rule: a reader
-- treats expires <= floor(now/1000) as absent. Written by the hourly cron on the
-- estimate's lease and COALESCEd like every other cron-owned column, so a run
-- whose SRF fetch fails leaves the standing table to age out.
ALTER TABLE beach_state ADD COLUMN tides TEXT;
ALTER TABLE beach_state ADD COLUMN tides_expires INTEGER;
