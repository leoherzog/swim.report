// NOAA solar-position math for a beach's next sunrise and next sunset. Pure:
// coordinates and a now instant in, ISO strings out — no Date.now, no fetch, so
// it is safe on the request path. The beach's local day is approximated by its
// longitude (lon / 15 hours) rather than a timezone lookup, which is enough to
// pick the right solar day for a next-event display.

// Refraction plus the sun's apparent radius: the standard rise/set zenith.
const ZENITH_DEG = 90.833;
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;

function toRadians(deg) {
  return deg * Math.PI / 180;
}

function toDegrees(rad) {
  return rad * 180 / Math.PI;
}

// Julian day at 00:00 UT of a Gregorian calendar date.
function julianDay(year, month, day) {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) +
    day + b - 1524.5;
}

// Solar declination in degrees and the equation of time in minutes, both at the
// given Julian century. The NOAA general solar position series, term for term.
function solarTerms(t) {
  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const center = Math.sin(toRadians(meanAnom)) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(toRadians(2 * meanAnom)) * (0.019993 - 0.000101 * t) +
    Math.sin(toRadians(3 * meanAnom)) * 0.000289;
  const trueLong = meanLong + center;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(toRadians(125.04 - 1934.136 * t));
  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * Math.cos(toRadians(125.04 - 1934.136 * t));
  const declination = toDegrees(Math.asin(
    Math.sin(toRadians(obliqCorr)) * Math.sin(toRadians(appLong))));
  const varY = Math.tan(toRadians(obliqCorr / 2)) * Math.tan(toRadians(obliqCorr / 2));
  const eqTime = 4 * toDegrees(
    varY * Math.sin(2 * toRadians(meanLong)) -
    2 * eccentricity * Math.sin(toRadians(meanAnom)) +
    4 * eccentricity * varY * Math.sin(toRadians(meanAnom)) * Math.cos(2 * toRadians(meanLong)) -
    0.5 * varY * varY * Math.sin(4 * toRadians(meanLong)) -
    1.25 * eccentricity * eccentricity * Math.sin(2 * toRadians(meanAnom)));
  return { declination: declination, eqTime: eqTime };
}

// Both events of one approximate local day, as epoch milliseconds. Either value
// is null when the sun neither rises nor sets that day, which is the honest
// answer inside the polar circles.
function dayEvents(lat, lon, year, month, day) {
  const offsetHours = lon / 15;
  const terms = solarTerms((julianDay(year, month, day) + 0.5 - offsetHours / 24 - 2451545) / 36525);
  const hourAngleCos = Math.cos(toRadians(ZENITH_DEG)) /
    (Math.cos(toRadians(lat)) * Math.cos(toRadians(terms.declination))) -
    Math.tan(toRadians(lat)) * Math.tan(toRadians(terms.declination));
  if (!(hourAngleCos >= -1 && hourAngleCos <= 1)) {
    return { sunrise: null, sunset: null };
  }
  const hourAngle = toDegrees(Math.acos(hourAngleCos));
  // Solar noon sits at 12:00 of the longitude-derived local clock by
  // construction, so only the equation of time moves it.
  const noonMinutes = 720 - terms.eqTime;
  const localMidnightMs = Date.UTC(year, month - 1, day) - offsetHours * MS_PER_HOUR;
  return {
    sunrise: localMidnightMs + (noonMinutes - 4 * hourAngle) * MS_PER_MINUTE,
    sunset: localMidnightMs + (noonMinutes + 4 * hourAngle) * MS_PER_MINUTE
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
  const local = new Date(nowMs + (lon / 15) * MS_PER_HOUR);
  const today = dayEvents(lat, lon, local.getUTCFullYear(), local.getUTCMonth() + 1,
    local.getUTCDate());
  if (today.sunrise === null) {
    return { sunrise: null, sunset: null };
  }
  let sunrise = today.sunrise > nowMs ? today.sunrise : null;
  let sunset = today.sunset > nowMs ? today.sunset : null;
  if (sunrise === null || sunset === null) {
    const next = new Date(local.getTime() + 24 * MS_PER_HOUR);
    const tomorrow = dayEvents(lat, lon, next.getUTCFullYear(), next.getUTCMonth() + 1,
      next.getUTCDate());
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
