-- Demand signal for the recompute rotation: ISO timestamp of the last time a
-- visitor viewed this beach (detail page or /api/flag/:beachId), stamped
-- fire-and-forget from the request path via ctx.waitUntil, at most once per
-- hour per beach. NULL = never viewed. Read by nothing yet — the hourly cron
-- still covers the whole table at pilot scale; nationwide scale-out will
-- prioritize recently viewed rows (TODO.md "Scale-out").
ALTER TABLE beaches ADD COLUMN last_viewed TEXT;
