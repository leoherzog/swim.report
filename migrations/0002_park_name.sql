-- Containing park (from OSM leisure=park / leisure=nature_reserve /
-- boundary=protected_area polygons). Null when the beach is not inside any
-- named park. When set, the UI shows the park name as the primary title and
-- the beach's own name as a subtitle.
ALTER TABLE beaches ADD COLUMN park_name TEXT;
