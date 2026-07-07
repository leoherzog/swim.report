-- Tracks the last time this beach had its flag recomputed (timestamp in ISO format).
-- Used for pagination to prioritize beaches with the oldest recompute time.
ALTER TABLE beaches ADD COLUMN recompute_updated TEXT;
