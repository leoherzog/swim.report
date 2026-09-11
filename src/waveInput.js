// src/waveInput.js — resolves one stored beach_state.wave record into the wave
// and wind signals src/rules.js consumes, indexing the record's hourly series at
// the hour being estimated rather than always reading hour 0.
//
// That indexing is what lets one landed cycle color FORECAST_HOURS of hourly runs
// instead of one, so the offline NOAA pipeline can publish a few times a day
// rather than every three hours. It is also why a series-bearing record's lease
// is the length of the series it carries (WAVE_SERIES_LEASE_SECONDS) rather than
// one pipeline interval.
//
// The record's own lease is the caller's gate, not this module's: the blob sits
// in the row whether or not wave_expires has passed, so a caller resolves the row
// through liveWaveRecord (src/beachState.js) before calling here. Both gates
// apply — an expired lease and a spent series each yield no wave input.
//
// Two rules hold the staleness line:
//
// The series is authoritative whenever it is present. A record carrying hoursFt
// never falls back to its own waveHeightFt, which is hour 0 and is exactly the
// stale reading the indexing exists to avoid. Once the series is spent, the beach
// has no wave input and the estimate degrades to unknown.
//
// The wind is offered only at hour 0. It is a single hour-0 sample with no series
// behind it, so it may not ride the long lease that the series earns. A wind-only
// record carries no series at all and is bounded instead by the short scalar
// lease the pipeline stamps on its wave_expires.
//
// Pure: the clock arrives as a parameter, so the cron and the tests walk the same
// code. Never throws for any input; a malformed record resolves to nulls, which
// reach rules.js as "no wave data" and color gray.

// Hours in a published series. Mirrors FORECAST_HOURS in src/waveGrids.js, which
// is offline-only and must not be imported into the Worker; the length actually
// used is the stored array's own, so a shorter cycle indexes correctly anyway.
export const WAVE_SERIES_HOURS = 24;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The stored series, or null when the record carries none or carries a malformed
// one. A malformed series is treated as absent rather than repaired, and the
// caller's authoritative-series rule then applies to the absent case: a record
// whose series will not parse falls through to its hour-0 scalar, which is bounded
// by the short lease it was written under.
function seriesOf(record) {
  const hoursFt = record.hoursFt;
  if (!Array.isArray(hoursFt) || hoursFt.length === 0) {
    return null;
  }
  for (let i = 0; i < hoursFt.length; i = i + 1) {
    const cell = hoursFt[i];
    if (cell !== null && !Number.isFinite(cell)) {
      return null;
    }
  }
  const startMs = Date.parse(record.startIso);
  if (Number.isNaN(startMs)) {
    return null;
  }
  return { startMs: startMs, hoursFt: hoursFt };
}

// Whole hours elapsed since the series start, or null when the series cannot
// answer for this instant. Matches trimWaveSeries in src/frontend/waveStrip.js so
// the flag card and the detail-page strip read the same hour of the same array:
// a start in the future clamps to hour 0, and an unreadable clock does the same,
// while a spent series answers null.
export function waveSeriesHourIndex(startMs, nowMs, length) {
  if (!Number.isFinite(startMs) || !Number.isFinite(length) || length <= 0) {
    return null;
  }
  const elapsed = Math.floor((nowMs - startMs) / 3600000);
  if (Number.isNaN(elapsed) || elapsed < 0) {
    return 0;
  }
  if (elapsed >= length) {
    return null;
  }
  return elapsed;
}

// One stored record plus the instant being estimated -> the signals the hourly
// cron pushes into rules.js, or null when the record can contribute nothing.
//
// Returns { waveHeightFt, model, windSpeedMph, windGustMph, hourIndex }. model is
// null whenever waveHeightFt is, and the wind fields are populated only when the
// resolved wave height is null, so src/index.js's "Wind Forecast" source
// attribution stays true: it names wind exactly when wind is the signal in play.
export function resolveWaveInput(record, nowMs) {
  if (!isPlainObject(record)) {
    return null;
  }

  const series = seriesOf(record);
  let waveHeightFt = null;
  let hourIndex = null;
  if (series !== null) {
    hourIndex = waveSeriesHourIndex(series.startMs, nowMs, series.hoursFt.length);
    if (hourIndex === null) {
      // The series ran out. Falling back to the record's hour-0 scalar or its
      // hour-0 wind here would resurrect data a full series older than the flag
      // it would color, which is the one outcome this module exists to prevent.
      return null;
    }
    const cell = series.hoursFt[hourIndex];
    waveHeightFt = Number.isFinite(cell) ? cell : null;
  } else if (Number.isFinite(record.waveHeightFt)) {
    waveHeightFt = record.waveHeightFt;
  }

  const windUsable = waveHeightFt === null && (hourIndex === null || hourIndex === 0);
  return {
    waveHeightFt: waveHeightFt,
    model: waveHeightFt === null || typeof record.model !== "string" ? null : record.model,
    windSpeedMph: windUsable && Number.isFinite(record.windSpeedMph)
      ? record.windSpeedMph : null,
    windGustMph: windUsable && Number.isFinite(record.windGustMph)
      ? record.windGustMph : null,
    hourIndex: hourIndex
  };
}
