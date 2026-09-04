// test/alertMatch.test.js
// Direct coverage for the shared alert accumulate/dedupe walk in
// src/clients/alertMatch.js and the two invariants CLAUDE.md states but nothing
// else enforces: the predicate is called ONLY for entries that already passed the
// shape check, and a throw out of the predicate PROPAGATES here so only
// ecccMarine's own closure swallows one.
//
// The happy path is already exercised three times over through nwsAlertsForZone,
// ecccAlertsForPoint and ecccMarineAlertsForPoint; nothing below duplicates it.

import { describe, it, expect } from "vitest";
import { matchedAlerts, pickIsoString } from "../src/clients/alertMatch.js";
import { ecccMarineAlertsForPoint } from "../src/clients/ecccMarine.js";
import { ecccAlertsForPoint } from "../src/clients/eccc.js";
import { nwsAlertsForZone } from "../src/clients/nws.js";

function always() {
  return true;
}

describe("pickIsoString", function () {
  it("prefers a non-empty primary", function () {
    expect(pickIsoString("a", "b")).toBe("a");
  });

  it("falls through on an EMPTY primary — the guard is length, not truthiness", function () {
    expect(pickIsoString("", "b")).toBe("b");
  });

  it("falls through on a non-string primary", function () {
    expect(pickIsoString(5, "b")).toBe("b");
    expect(pickIsoString(null, "b")).toBe("b");
    expect(pickIsoString(undefined, "b")).toBe("b");
    expect(pickIsoString({}, "b")).toBe("b");
  });

  it("yields null when neither candidate is usable", function () {
    expect(pickIsoString(null, null)).toBe(null);
    expect(pickIsoString("", "")).toBe(null);
    expect(pickIsoString(undefined, "")).toBe(null);
    // A numeric 0 must never survive into an onset field as a timestamp.
    expect(pickIsoString(0, 0)).toBe(null);
  });
});

describe("matchedAlerts", function () {
  it("returns accepted entries in input order", function () {
    const alerts = [
      { event: "High Surf Advisory", onset: "2026-07-05T10:00:00Z", ends: "2026-07-05T22:00:00Z" },
      { event: "Rip Current Statement", onset: null, ends: "2026-07-05T18:00:00Z" }
    ];
    expect(matchedAlerts(alerts, always)).toEqual({
      events: ["High Surf Advisory", "Rip Current Statement"],
      details: [
        {
          event: "High Surf Advisory",
          onset: "2026-07-05T10:00:00Z",
          ends: "2026-07-05T22:00:00Z"
        },
        { event: "Rip Current Statement", onset: null, ends: "2026-07-05T18:00:00Z" }
      ]
    });
  });

  it("dedupes events on the name alone but details on the whole triple", function () {
    // The asymmetry is the contract: one repeated name yields one event and as many
    // detail rows as there are distinct (event, onset, ends) triples.
    const alerts = [
      { event: "Gale Warning", onset: "2026-07-05T10:00:00Z", ends: "2026-07-05T18:00:00Z" },
      { event: "Gale Warning", onset: "2026-07-05T10:00:00Z", ends: "2026-07-05T18:00:00Z" },
      { event: "Gale Warning", onset: "2026-07-05T20:00:00Z", ends: "2026-07-06T04:00:00Z" }
    ];
    const out = matchedAlerts(alerts, always);
    expect(out.events).toEqual(["Gale Warning"]);
    expect(out.details).toEqual([
      { event: "Gale Warning", onset: "2026-07-05T10:00:00Z", ends: "2026-07-05T18:00:00Z" },
      { event: "Gale Warning", onset: "2026-07-05T20:00:00Z", ends: "2026-07-06T04:00:00Z" }
    ]);
  });

  it("normalizes a non-string onset/ends to null before the detail key is built", function () {
    const alerts = [
      { event: "Wind Advisory", onset: 1751716800000, ends: undefined },
      { event: "Wind Advisory", onset: { at: "soon" }, ends: null }
    ];
    // Both rows normalize to (Wind Advisory, null, null), so they collapse to one.
    expect(matchedAlerts(alerts, always).details).toEqual([
      { event: "Wind Advisory", onset: null, ends: null }
    ]);
  });

  it("keeps an event name that is an Object.prototype key", function () {
    // A bare {} dedupe map reads 'constructor' back truthy on FIRST sighting, which
    // silently drops it from events while details still carries it.
    const out = matchedAlerts([{ event: "constructor" }], always);
    expect(out.events).toEqual(["constructor"]);
    expect(out.details).toEqual([{ event: "constructor", onset: null, ends: null }]);

    const proto = matchedAlerts([{ event: "__proto__" }, { event: "toString" }], always);
    expect(proto.events).toEqual(["__proto__", "toString"]);
    expect(proto.details).toEqual([
      { event: "__proto__", onset: null, ends: null },
      { event: "toString", onset: null, ends: null }
    ]);
  });

  it("degrades a non-array alerts argument to an empty result", function () {
    const empty = { events: [], details: [] };
    expect(matchedAlerts(null, always)).toEqual(empty);
    expect(matchedAlerts(undefined, always)).toEqual(empty);
    expect(matchedAlerts({}, always)).toEqual(empty);
    expect(matchedAlerts("nope", always)).toEqual(empty);
  });

  it("skips entries that are not objects carrying a string event", function () {
    expect(matchedAlerts([null, {}, { event: 5 }], always)).toEqual({
      events: [],
      details: []
    });
  });

  it("calls the predicate ONLY for entries that passed the shape check", function () {
    // Hoisting matches(alert) above the shape guard would hand ecccMarine's
    // geometry closure a null alert.
    let calls = 0;
    matchedAlerts([null, {}, { event: 5 }, { event: "ok" }], function () {
      calls = calls + 1;
      return true;
    });
    expect(calls).toBe(1);
  });

  it("PROPAGATES a throw out of the predicate", function () {
    // Wrapping the predicate call in a try/catch here would make nws and eccc
    // silently drop alerts on a genuine bug.
    expect(function () {
      matchedAlerts([{ event: "boom" }], function () {
        throw new Error("predicate blew up");
      });
    }).toThrow("predicate blew up");
  });

  it("is deterministic and does not mutate its input", function () {
    const first = Object.freeze({
      event: "High Surf Warning",
      onset: "2026-07-05T10:00:00Z",
      ends: "2026-07-05T22:00:00Z"
    });
    const second = Object.freeze({ event: "High Surf Warning", onset: null, ends: null });
    const alerts = Object.freeze([first, second]);
    const a = matchedAlerts(alerts, always);
    const b = matchedAlerts(alerts, always);
    expect(a).toEqual(b);
    expect(alerts).toEqual([first, second]);
    expect(first.onset).toBe("2026-07-05T10:00:00Z");
  });
});

// The shared walk propagating is only half of CLAUDE.md's rule. The other half is
// that ecccMarine ALONE swallows, inside its own predicate closure. These two fail
// on either direction of the change: deleting the marine try/catch, or adding one
// to the land matchers.
describe("only the marine matcher swallows a predicate throw", function () {
  function hostileGeometryAlert(name) {
    const alert = { event: name };
    Object.defineProperty(alert, "geometry", {
      get: function () {
        throw new Error("geometry exploded");
      }
    });
    return alert;
  }

  function hostileZonesAlert(name) {
    const alert = { event: name };
    Object.defineProperty(alert, "zones", {
      get: function () {
        throw new Error("zones exploded");
      }
    });
    return alert;
  }

  it("ecccMarineAlertsForPoint swallows it and returns an empty result", function () {
    expect(ecccMarineAlertsForPoint([hostileGeometryAlert("marine storm warning")], 44.0, -79.0))
      .toEqual({ events: [], details: [] });
  });

  it("ecccAlertsForPoint lets it propagate", function () {
    expect(function () {
      ecccAlertsForPoint([hostileGeometryAlert("tornado warning")], 44.0, -79.0);
    }).toThrow("geometry exploded");
  });

  it("nwsAlertsForZone lets it propagate", function () {
    expect(function () {
      nwsAlertsForZone([hostileZonesAlert("Tornado Warning")], "ILZ103");
    }).toThrow("zones exploded");
  });
});
