-- Flag-worthy water-body classification. Beach flags exist only for oceans and
-- the Great Lakes, but neither Overpass discovery path checks the adjacent
-- water body, so the beaches table admits hundreds of inland-lake beaches that
-- can never have a flag (Fremont Lake Park, Clinton Lakes Dog Beach, ...). Each
-- beach is classified by its adjacent water body and the inland ones are hidden
-- (never deleted) behind the flag-worthy gate.
--
-- water_class: NULL (unclassified) | 'ocean' | 'great_lake' | 'inland'. Only
-- 'ocean' and 'great_lake' are flag-worthy; 'inland' is hidden.
-- water_class_attempts: per-row counter of SUCCESSFUL-BUT-EMPTY classification
-- probes (mirrors enrichment_attempts / eccc_attempts). Rows at the cap are
-- parked and hidden. A transient Overpass failure never bumps it.
-- water_class_version: the WATER_CLASS_VERSION under which water_class was
-- decided; bumping the constant re-drains rows below it (RULES_VERSION
-- discipline). NULL until first classified. Independent of RULES_VERSION.
ALTER TABLE beaches ADD COLUMN water_class TEXT;
ALTER TABLE beaches ADD COLUMN water_class_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE beaches ADD COLUMN water_class_version INTEGER;
