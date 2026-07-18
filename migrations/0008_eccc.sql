-- Environment and Climate Change Canada (ECCC) enrichment. Canadian beaches
-- swept in by PILOT_BBOX (Ontario shoreline) permanently fail NWS point
-- enrichment (api.weather.gov 404s non-US points) and park at
-- enrichment_attempts >= 5 with nws_zone NULL. eccc_zone holds the ECCC
-- public forecast region NAME (e.g. "Windsor - Essex - Chatham-Kent") from
-- the GeoMet public-standard-forecast-zones collection; NOT NULL marks the
-- beach as Canadian and alert-checkable via the weather-alerts collection.
-- eccc_attempts mirrors enrichment_attempts: failed zone lookups park at the
-- cap so a point no zone ever matches (mid-lake, US shoreline edge case)
-- cannot occupy the enrichment batch forever.
ALTER TABLE beaches ADD COLUMN eccc_zone TEXT;
ALTER TABLE beaches ADD COLUMN eccc_attempts INTEGER NOT NULL DEFAULT 0;
