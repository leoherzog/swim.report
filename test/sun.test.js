// test/sun.test.js
// Covers src/frontend/sun.js: the NOAA sunrise/sunset math against published
// times for known places and dates, the polar day and night nulls, the
// next-event choice either side of a sunset, and the UTC fallback label.

import { describe, it, expect } from "vitest";
import { nextSunEvents, nextSunEvent, utcClockLabel } from "../src/frontend/sun.js";

// Holland, MI — the fixture beach's coordinates.
const HOLLAND_LAT = 42.775;
const HOLLAND_LON = -86.211;

// The algorithm is good to a couple of minutes, and published tables round to
// the minute, so every comparison carries the same tolerance.
const TOLERANCE_MS = 180000;

function expectNear(actualIso, expectedIso) {
  expect(typeof actualIso).toBe("string");
  const drift = Math.abs(Date.parse(actualIso) - Date.parse(expectedIso));
  expect(drift).toBeLessThanOrEqual(TOLERANCE_MS);
}

describe("sunrise and sunset math", () => {
  it("matches the published Holland, MI times on the summer solstice", () => {
    // 6:07 AM and 9:25 PM EDT on 2026-06-21.
    const events = nextSunEvents(HOLLAND_LAT, HOLLAND_LON, "2026-06-21T05:00:00.000Z");
    expectNear(events.sunrise, "2026-06-21T10:07:00.000Z");
    expectNear(events.sunset, "2026-06-22T01:25:00.000Z");
  });

  it("matches the published Holland, MI times on the September equinox", () => {
    // 7:32 AM and 7:42 PM EDT on 2026-09-22, a day just over 12 h long.
    const events = nextSunEvents(HOLLAND_LAT, HOLLAND_LON, "2026-09-22T05:00:00.000Z");
    expectNear(events.sunrise, "2026-09-22T11:32:00.000Z");
    expectNear(events.sunset, "2026-09-22T23:42:00.000Z");
    const dayLengthMin = (Date.parse(events.sunset) - Date.parse(events.sunrise)) / 60000;
    expect(dayLengthMin).toBeGreaterThan(720);
    expect(dayLengthMin).toBeLessThan(740);
  });

  it("handles a southern-hemisphere summer, where the longitude offset is positive", () => {
    // Sydney on 2026-01-15: 6:00 AM and 8:08 PM AEDT.
    const events = nextSunEvents(-33.8688, 151.2093, "2026-01-15T15:00:00.000Z");
    expectNear(events.sunrise, "2026-01-15T19:00:00.000Z");
    expectNear(events.sunset, "2026-01-16T09:08:00.000Z");
  });

  it("rolls to tomorrow's event once today's has passed", () => {
    const events = nextSunEvents(HOLLAND_LAT, HOLLAND_LON, "2026-07-05T12:00:00.000Z");
    // Today's sunrise is behind this instant, so the next one is tomorrow's.
    expect(events.sunrise).toBe("2026-07-06T10:13:00.000Z");
    expect(events.sunset).toBe("2026-07-06T01:26:00.000Z");
    expect(Date.parse(events.sunrise)).toBeGreaterThan(Date.parse("2026-07-05T12:00:00.000Z"));
  });

  it("reports whichever event comes first", () => {
    expect(nextSunEvent(HOLLAND_LAT, HOLLAND_LON, "2026-07-05T12:00:00.000Z"))
      .toEqual({ type: "sunset", iso: "2026-07-06T01:26:00.000Z" });
    expect(nextSunEvent(HOLLAND_LAT, HOLLAND_LON, "2026-07-05T06:00:00.000Z"))
      .toEqual({ type: "sunrise", iso: "2026-07-05T10:12:00.000Z" });
  });

  it("truncates every event to the whole minute", () => {
    const events = nextSunEvents(HOLLAND_LAT, HOLLAND_LON, "2026-03-20T06:00:00.000Z");
    expect(Date.parse(events.sunrise) % 60000).toBe(0);
    expect(Date.parse(events.sunset) % 60000).toBe(0);
  });

  it("returns null through the polar day and the polar night", () => {
    // Longyearbyen: the sun neither rises nor sets on either date.
    const summer = nextSunEvents(78.2232, 15.6469, "2026-07-05T12:00:00.000Z");
    expect(summer).toEqual({ sunrise: null, sunset: null });
    const winter = nextSunEvents(78.2232, 15.6469, "2026-01-05T12:00:00.000Z");
    expect(winter).toEqual({ sunrise: null, sunset: null });
    expect(nextSunEvent(78.2232, 15.6469, "2026-07-05T12:00:00.000Z")).toBe(null);
  });

  it("returns null rather than a 0,0 answer for unusable inputs", () => {
    const nulls = { sunrise: null, sunset: null };
    expect(nextSunEvents(null, null, "2026-07-05T12:00:00.000Z")).toEqual(nulls);
    expect(nextSunEvents(NaN, -86.211, "2026-07-05T12:00:00.000Z")).toEqual(nulls);
    expect(nextSunEvents(HOLLAND_LAT, HOLLAND_LON, "not a date")).toEqual(nulls);
    expect(nextSunEvents(HOLLAND_LAT, HOLLAND_LON, null)).toEqual(nulls);
    expect(nextSunEvents(120, 200, "2026-07-05T12:00:00.000Z")).toEqual(nulls);
    expect(nextSunEvent(null, null, "2026-07-05T12:00:00.000Z")).toBe(null);
  });
});

describe("utcClockLabel", () => {
  it("pads both fields and names the zone", () => {
    expect(utcClockLabel("2026-07-06T01:26:00.000Z")).toBe("01:26 UTC");
    expect(utcClockLabel("2026-07-06T23:04:00.000Z")).toBe("23:04 UTC");
    expect(utcClockLabel("2026-07-06T00:00:00.000Z")).toBe("00:00 UTC");
  });

  it("returns null for an unusable instant", () => {
    expect(utcClockLabel("not a date")).toBe(null);
    expect(utcClockLabel(null)).toBe(null);
  });
});
