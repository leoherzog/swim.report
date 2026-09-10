// A beach's next sunrise and next sunset, delegated to SunCalc (Meeus). Pure:
// coordinates and a now instant in, ISO strings out — no Date.now, no fetch, so
// it is safe on the request path. SunCalc picks the solar day by the longitude's
// mean solar noon rather than a timezone lookup, which is enough to choose the
// right day for a next-event display.

import { getTimes } from "suncalc";

const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;

// Both events of the solar day containing atMs, as epoch milliseconds. Either
// value is null when the sun neither rises nor sets that day, which is the
// honest answer inside the polar circles.
function dayEvents(lat, lon, atMs) {
  const times = getTimes(new Date(atMs), lat, lon);
  return {
    sunrise: times.sunrise === null ? null : times.sunrise.getTime(),
    sunset: times.sunset === null ? null : times.sunset.getTime()
  };
}

// Truncated to the whole minute: sub-second precision on a sunrise is fiction,
// and the ISO string then reads as the same minute any clock renders it as.
function isoMinute(ms) {
  return ms === null ? null : new Date(Math.floor(ms / MS_PER_MINUTE) * MS_PER_MINUTE).toISOString();
}

/**
 * The next sunrise and next sunset strictly after nowIso, as ISO strings.
 * Either is null when this beach's day has no such event (polar day or night)
 * or when the coordinates or nowIso are unusable.
 */
export function nextSunEvents(lat, lon, nowIso) {
  const nowMs = (typeof nowIso === "string") ? Date.parse(nowIso) : NaN;
  // Number.isFinite, not the global: isFinite(null) is true and would place a
  // missing coordinate at 0,0.
  if (!Number.isFinite(nowMs) || !Number.isFinite(lat) || !Number.isFinite(lon) ||
    lat > 90 || lat < -90 || lon > 180 || lon < -180) {
    return { sunrise: null, sunset: null };
  }
  const today = dayEvents(lat, lon, nowMs);
  if (today.sunrise === null) {
    return { sunrise: null, sunset: null };
  }
  let sunrise = today.sunrise > nowMs ? today.sunrise : null;
  let sunset = today.sunset > nowMs ? today.sunset : null;
  if (sunrise === null || sunset === null) {
    const tomorrow = dayEvents(lat, lon, nowMs + 24 * MS_PER_HOUR);
    sunrise = sunrise === null ? tomorrow.sunrise : sunrise;
    sunset = sunset === null ? tomorrow.sunset : sunset;
  }
  return { sunrise: isoMinute(sunrise), sunset: isoMinute(sunset) };
}

/**
 * Whichever of the two events comes first after nowIso, as
 * { type: "sunrise" | "sunset", iso }, or null when neither exists.
 */
export function nextSunEvent(lat, lon, nowIso) {
  const events = nextSunEvents(lat, lon, nowIso);
  if (events.sunrise === null && events.sunset === null) {
    return null;
  }
  if (events.sunset === null) {
    return { type: "sunrise", iso: events.sunrise };
  }
  if (events.sunrise === null) {
    return { type: "sunset", iso: events.sunset };
  }
  return Date.parse(events.sunrise) <= Date.parse(events.sunset)
    ? { type: "sunrise", iso: events.sunrise }
    : { type: "sunset", iso: events.sunset };
}

/**
 * An instant as "01:26 UTC". The longitude offset picks the solar day but is up
 * to two hours from a beach's posted clock, so a rendered time never claims to
 * be local; only the viewer's browser can say that.
 */
export function utcClockLabel(iso) {
  const ms = (typeof iso === "string") ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) {
    return null;
  }
  const at = new Date(ms);
  const hour = at.getUTCHours();
  const minute = at.getUTCMinutes();
  return (hour < 10 ? ("0" + hour) : String(hour)) + ":" +
    (minute < 10 ? ("0" + minute) : String(minute)) + " UTC";
}
