-- NWS marine forecast zone enrichment. US Great Lakes beaches sit on land, so
-- their nws_zone is a land public forecast zone (e.g. "MIZ056") that NWS marine
-- warnings (Gale / Storm / Special Marine) and Small Craft Advisory are NEVER
-- issued for — those products are zoned to the adjacent MARINE zone (e.g.
-- "LMZ874"). marine_zone holds that adjacent zone id, resolved by the marine
-- enrichment cron (an offshore probe of api.weather.gov/zones?type=marine),
-- letting the hourly recompute match marine alerts from the SAME national
-- /alerts/active fetch it already makes — no extra upstream call. marine_attempts
-- mirrors enrichment_attempts / eccc_attempts: a point with no nearby marine
-- zone (inland lake) parks at the cap instead of re-probing forever. Marine
-- enrichment is gated to US beaches (nws_zone NOT NULL); Canadian marine waters
-- belong to ECCC, not NWS.
ALTER TABLE beaches ADD COLUMN marine_zone TEXT;
ALTER TABLE beaches ADD COLUMN marine_attempts INTEGER NOT NULL DEFAULT 0;
