-- Requeue beaches whose nws_zone holds a MARINE forecast zone id. A beach
-- centroid over water makes api.weather.gov/points answer with the adjacent
-- marine zone ("LMZ221", "ANZ050"), which no land product (High Surf Advisory,
-- Beach Hazards Statement, Rip Current Statement, Coastal Flood Advisory) is
-- ever issued for, so such a row reads alert-checkable while it can never match
-- one. runNwsEnrichment now rejects a marine forecastZone and re-probes nudged
-- coordinates for the land zone; clearing the zone, the grid URL and the attempts
-- counter sends these rows back through that path. marine_zone is untouched: it
-- is derived offline from beach coordinates and stays correct.
UPDATE beaches
SET nws_zone = NULL, nws_grid_url = NULL, enrichment_attempts = 0
WHERE nws_zone IS NOT NULL AND substr(nws_zone, 1, 3) IN (
  'AMZ', 'ANZ', 'GMZ', 'PZZ', 'PKZ', 'PHZ', 'PMZ', 'PSZ',
  'LCZ', 'LEZ', 'LHZ', 'LMZ', 'LOZ', 'LSZ', 'SLZ'
);
