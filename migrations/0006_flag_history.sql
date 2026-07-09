-- Calibration signal for wave/wind threshold tuning in src/rules.js: one row
-- per beach per hourly recompute ONLY when that beach has BOTH a fresh estimate
-- AND a scraped official color in the same run (South Haven, Chicago, etc.).
-- Estimate-only rows are deliberately NOT logged, so the table records the
-- estimated-vs-official pairs and never grows with all ~613 beaches hourly.
CREATE TABLE flag_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beach_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  estimated_color TEXT NOT NULL,
  official_color TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  official_source TEXT
);

-- Calibration queries pull a beach's paired history in chronological order.
CREATE INDEX idx_flag_history_beach_observed ON flag_history(beach_id, observed_at);
