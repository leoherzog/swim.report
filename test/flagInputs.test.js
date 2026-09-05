// The safety proof for the estimateInputs seal (src/flagInputs.js).
//
// runAlertRefresh recomputes a beach from fresh alerts and the SEALED non-alert
// inputs. If the seal ever omitted a field estimateFlag consumes, the refresh
// would pass null for it and silently LOWER the flag: a rip-current red would
// become green, a wave red would become a wind-fallback green, a water-quality
// red would vanish. The round-trip property below is what makes that
// structurally impossible rather than a matter of discipline — adding an input to
// rules.js without adding it here fails this file.
//
// The JSON hop in that round trip is not optional. JSON.stringify emits null for
// both NaN and Infinity, so an in-memory-only comparison would not catch a
// non-finite value crossing the storage boundary and the two crons would decide
// different colors from one beach.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { estimateFlag } from "../src/rules.js";
import {
  FLAG_SEAL_VERSION,
  buildAlertInputs,
  buildEstimateInputs,
  sealFromSignals,
  signalsFromStanding,
  standingAlertEvents,
  eventKey
} from "../src/flagInputs.js";
import { ECCC_ALERTS_INFO_URL } from "../src/clients/eccc.js";
import { ECCC_MARINE_INFO_URL } from "../src/clients/ecccMarine.js";

const UPDATED = "2026-07-15T16:00:00.000Z";

function beachRow(overrides) {
  const row = {
    id: "osm-node-1",
    name: "Test Beach",
    park_name: null,
    lat: 44.8,
    lon: -83.3,
    nws_zone: null,
    marine_zone: null,
    eccc_zone: null
  };
  const extra = overrides || {};
  for (const key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) {
      row[key] = extra[key];
    }
  }
  return row;
}

function zoneEntry(events, sourceUrl) {
  return {
    events: events,
    details: events.map(function (e) {
      return { event: e, onset: "2026-07-15T14:00:00.000Z", ends: "2026-07-16T02:00:00.000Z" };
    }),
    sourceUrl: sourceUrl
  };
}

describe("flagInputs seal round trip", function () {
  // Every field estimateFlag reads (src/rules.js), split by where the refresh
  // cron gets it back from. Compared against a literal so a new rules.js input
  // fails here instead of silently defaulting to null in a fast recompute.
  const SEAL_FIELDS = ["windSpeedMph", "windGustMph", "waterQualityAdvisory", "signalSources"];
  const ECHOED_FIELDS = ["ripCurrentRisk", "waveHeightFt", "updated"];
  const RECOMPUTED_FIELDS = ["alerts", "alertDetails", "alertsCheckable", "beachId"];

  it("covers every estimateFlag input between the seal, the echo and the D1 row", function () {
    // The input names are READ OUT OF src/rules.js, never transcribed: a
    // hand-typed list makes this assertion a tautology, and the whole point is
    // that adding an input to rules.js fails here. estimateFlag reads its bundle
    // as source.<field>, and nothing else in that file does.
    const rulesSource = readFileSync(new URL("../src/rules.js", import.meta.url), "utf8");
    const rulesInputs = [];
    const pattern = /\bsource\.([A-Za-z0-9_]+)/g;
    let match = pattern.exec(rulesSource);
    while (match !== null) {
      if (rulesInputs.indexOf(match[1]) === -1) {
        rulesInputs.push(match[1]);
      }
      match = pattern.exec(rulesSource);
    }
    // The matrix below is the other half of the guard, and it is only a proof
    // while it exercises every sealed field, so the field lists have to be real.
    expect(rulesInputs.length).toBeGreaterThan(5);

    // sources is the concat of the seal's signalSources and the freshly built
    // alertSources, so it is covered by signalSources plus the alert half.
    const covered = SEAL_FIELDS
      .concat(ECHOED_FIELDS)
      .concat(RECOMPUTED_FIELDS)
      .concat(["sources"]);
    const missing = rulesInputs.filter(function (name) {
      return covered.indexOf(name) === -1;
    });
    expect(missing).toEqual([]);

    // And the other direction: every sealed field must be one rules.js actually
    // consumes, so a field cannot be sealed in name only while the recompute
    // reads it from somewhere else.
    const unread = SEAL_FIELDS.filter(function (name) {
      return name !== "signalSources" && rulesInputs.indexOf(name) === -1;
    });
    expect(unread).toEqual([]);
  });

  it("recomputes the identical estimate from a JSON round trip of the seal", function () {
    const risks = ["HIGH", "MODERATE", "LOW", null];
    const waves = [null, 0.5, 2.6, 4.5];
    const winds = [null, 3, 18, 40];
    // windGustMph must vary, or a seal that dropped it would round-trip null to
    // null and this property would pass while a wind-gust red silently became
    // unknown on the next alert clear. 30 is rules.js step 4's yellow band, and
    // it pairs with windSpeedMph null to enter the wind branch on gust alone.
    const gusts = [null, 30];
    const advisories = [
      null,
      { color: "yellow", reason: "Elevated bacteria", source: "County Health" },
      { color: "red", reason: "E. coli exceedance", source: "County Health" }
    ];
    const sourceSets = [
      [],
      [{ label: "NOAA GFS Wave Model", url: "https://polar.ncep.noaa.gov/waves/" },
        { label: "County Health", url: "https://example.org/water" }]
    ];
    const alertCtxs = [
      // No authority resolved: alerts null, alertsResolved false.
      { alertsMap: new Map(), ecccAlerts: null, ecccMarineAlerts: null },
      // NWS land zone, nothing active.
      { alertsMap: new Map([["MIZ071", zoneEntry([], "u")]]), ecccAlerts: null, ecccMarineAlerts: null },
      // NWS land warning.
      { alertsMap: new Map([["MIZ071", zoneEntry(["High Surf Warning"], "u")]]), ecccAlerts: null, ecccMarineAlerts: null },
      // NWS yellow floor.
      { alertsMap: new Map([["MIZ071", zoneEntry(["Small Craft Advisory"], "u")]]), ecccAlerts: null, ecccMarineAlerts: null },
      // ECCC land warning matched by polygon.
      {
        alertsMap: new Map(),
        ecccAlerts: {
          alerts: [{
            event: "gale warning",
            onset: "2026-07-15T14:00:00.000Z",
            ends: null,
            geometry: { type: "Polygon", coordinates: [[[-84, 44], [-82, 44], [-82, 46], [-84, 46], [-84, 44]]] }
          }]
        },
        ecccMarineAlerts: { alerts: [] }
      }
    ];
    const beaches = [
      beachRow({ nws_zone: "MIZ071" }),
      beachRow({ nws_zone: "MIZ071", marine_zone: "LHZ441" }),
      beachRow({ eccc_zone: "Alpena - Ontario" }),
      beachRow({})
    ];

    let combos = 0;
    for (const beach of beaches) {
      for (const alertCtx of alertCtxs) {
        const alertPart = buildAlertInputs(beach, alertCtx);
        for (const risk of risks) {
          for (const wave of waves) {
            for (const wind of winds) {
              for (const gust of gusts) {
                for (const advisory of advisories) {
                  for (const signalSources of sourceSets) {
                    const signals = {
                      alertsResolved: alertPart.alertsResolved,
                      ripCurrentRisk: risk,
                      waveHeightFt: wave,
                      windSpeedMph: wind,
                      windGustMph: gust,
                      waterQualityAdvisory: advisory,
                      signalSources: signalSources,
                      updated: UPDATED
                    };
                    const estimate = estimateFlag(buildEstimateInputs(beach, alertPart, signals));
                    const stored = Object.assign({}, estimate, {
                      estimateInputs: sealFromSignals(signals, alertPart)
                    });
                    const back = JSON.parse(JSON.stringify(stored));
                    expect(signalsFromStanding(back)).toEqual(signals);
                    expect(
                      estimateFlag(buildEstimateInputs(beach, alertPart, signalsFromStanding(back)))
                    ).toEqual(estimate);
                    combos = combos + 1;
                  }
                }
              }
            }
          }
        }
      }
    }
    // The assertions above are only meaningful while the matrix is real.
    expect(combos).toBe(
      beaches.length * alertCtxs.length *
      risks.length * waves.length * winds.length * gusts.length *
      advisories.length * sourceSets.length
    );
  });
});

describe("signalsFromStanding rejection", function () {
  function sealed(extra) {
    const standing = {
      color: "green",
      updated: UPDATED,
      waveHeightFt: 1.2,
      ripCurrentRisk: null,
      estimateInputs: {
        v: FLAG_SEAL_VERSION,
        alertsResolved: true,
        windSpeedMph: null,
        windGustMph: null,
        waterQualityAdvisory: null,
        signalSources: []
      }
    };
    const overrides = extra || {};
    for (const key in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        standing[key] = overrides[key];
      }
    }
    return standing;
  }

  it("returns null for a null standing value", function () {
    expect(signalsFromStanding(null)).toBeNull();
  });

  it("returns null for a value written before the seal shipped", function () {
    expect(signalsFromStanding(sealed({ estimateInputs: undefined }))).toBeNull();
  });

  it("returns null for a mismatched seal version", function () {
    const standing = sealed();
    standing.estimateInputs.v = 2;
    expect(signalsFromStanding(standing)).toBeNull();
  });

  it("returns null when signalSources is not an array", function () {
    const standing = sealed();
    standing.estimateInputs.signalSources = "nope";
    expect(signalsFromStanding(standing)).toBeNull();
  });

  it("reads the echoed fields off the estimate, not the seal", function () {
    const signals = signalsFromStanding(sealed({ waveHeightFt: 3.4, ripCurrentRisk: "HIGH" }));
    expect(signals.waveHeightFt).toBe(3.4);
    expect(signals.ripCurrentRisk).toBe("HIGH");
    expect(signals.updated).toBe(UPDATED);
  });

  it("normalizes a non-finite echoed wave height and an unrecognized rip risk", function () {
    const signals = signalsFromStanding(sealed({ waveHeightFt: "3.4", ripCurrentRisk: "EXTREME" }));
    expect(signals.waveHeightFt).toBeNull();
    expect(signals.ripCurrentRisk).toBeNull();
  });
});

describe("buildEstimateInputs normalization", function () {
  function signalsWith(extra) {
    const signals = {
      alertsResolved: false,
      ripCurrentRisk: null,
      waveHeightFt: null,
      windSpeedMph: null,
      windGustMph: null,
      waterQualityAdvisory: null,
      signalSources: [],
      updated: UPDATED
    };
    for (const key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        signals[key] = extra[key];
      }
    }
    return signals;
  }

  const noAlerts = { alerts: null, alertDetails: null, alertSources: [], alertsResolved: false };

  it("normalizes non-finite wave, wind and gust readings to null", function () {
    const inputs = buildEstimateInputs(
      beachRow({}),
      noAlerts,
      signalsWith({ waveHeightFt: Infinity, windSpeedMph: NaN, windGustMph: -Infinity })
    );
    expect(inputs.waveHeightFt).toBeNull();
    expect(inputs.windSpeedMph).toBeNull();
    expect(inputs.windGustMph).toBeNull();
  });

  it("normalizes an unrecognized rip-current risk to null", function () {
    const inputs = buildEstimateInputs(beachRow({}), noAlerts, signalsWith({ ripCurrentRisk: "SEVERE" }));
    expect(inputs.ripCurrentRisk).toBeNull();
  });

  it("computes alertsCheckable false only when all three zone columns are absent", function () {
    expect(buildEstimateInputs(beachRow({}), noAlerts, signalsWith({})).alertsCheckable).toBe(false);
    expect(buildEstimateInputs(beachRow({ nws_zone: "MIZ071" }), noAlerts, signalsWith({})).alertsCheckable).toBe(true);
    expect(buildEstimateInputs(beachRow({ marine_zone: "LHZ441" }), noAlerts, signalsWith({})).alertsCheckable).toBe(true);
    expect(buildEstimateInputs(beachRow({ eccc_zone: "Alpena" }), noAlerts, signalsWith({})).alertsCheckable).toBe(true);
  });

  it("puts the alert source entries ahead of the signal ones", function () {
    const alertPart = {
      alerts: [], alertDetails: [], alertsResolved: true,
      alertSources: [{ label: "NWS Alerts", url: "u" }]
    };
    const inputs = buildEstimateInputs(
      beachRow({ nws_zone: "MIZ071" }),
      alertPart,
      signalsWith({ signalSources: [{ label: "NOAA GFS Wave Model", url: "w" }] })
    );
    expect(inputs.sources.map(function (s) { return s.label; }))
      .toEqual(["NWS Alerts", "NOAA GFS Wave Model"]);
  });
});

describe("buildAlertInputs branches", function () {
  const landOnly = { alertsMap: new Map([["MIZ071", zoneEntry(["High Surf Advisory"], "land-url")]]) };
  const marineOnly = { alertsMap: new Map([["LHZ441", zoneEntry(["Gale Warning"], "marine-url")]]) };
  const both = {
    alertsMap: new Map([
      ["MIZ071", zoneEntry(["High Surf Advisory"], "land-url")],
      ["LHZ441", zoneEntry(["Gale Warning"], "marine-url")]
    ])
  };

  it("concats land and marine with no dedup and cites both sources", function () {
    const part = buildAlertInputs(beachRow({ nws_zone: "MIZ071", marine_zone: "LHZ441" }), both);
    expect(part.alerts).toEqual(["High Surf Advisory", "Gale Warning"]);
    expect(part.alertDetails.length).toBe(2);
    expect(part.alertSources.map(function (s) { return s.label; }))
      .toEqual(["NWS Alerts", "NWS Marine Alerts"]);
    expect(part.alertsResolved).toBe(true);
  });

  it("handles a land-only and a marine-only beach", function () {
    const land = buildAlertInputs(beachRow({ nws_zone: "MIZ071" }), landOnly);
    expect(land.alerts).toEqual(["High Surf Advisory"]);
    expect(land.alertSources.map(function (s) { return s.label; })).toEqual(["NWS Alerts"]);

    const marine = buildAlertInputs(beachRow({ marine_zone: "LHZ441" }), marineOnly);
    expect(marine.alerts).toEqual(["Gale Warning"]);
    expect(marine.alertSources.map(function (s) { return s.label; })).toEqual(["NWS Marine Alerts"]);
  });

  it("concats both ECCC collections and cites each that succeeded", function () {
    const geometry = {
      type: "Polygon",
      coordinates: [[[-84, 44], [-82, 44], [-82, 46], [-84, 46], [-84, 44]]]
    };
    const ctx = {
      alertsMap: new Map(),
      ecccAlerts: { alerts: [{ event: "wind warning", onset: null, ends: null, geometry: geometry }] },
      ecccMarineAlerts: { alerts: [{ event: "gale warning", onset: null, ends: null, geometry: geometry }] }
    };
    const part = buildAlertInputs(beachRow({ eccc_zone: "Alpena" }), ctx);
    expect(part.alerts).toEqual(["wind warning", "gale warning"]);
    expect(part.alertSources.map(function (s) { return s.url; }))
      .toEqual([ECCC_ALERTS_INFO_URL, ECCC_MARINE_INFO_URL]);
  });

  it("still resolves when only one ECCC collection succeeded", function () {
    const ctx = { alertsMap: new Map(), ecccAlerts: { alerts: [] }, ecccMarineAlerts: null };
    const landOnlyPart = buildAlertInputs(beachRow({ eccc_zone: "Alpena" }), ctx);
    expect(landOnlyPart.alerts).toEqual([]);
    expect(landOnlyPart.alertsResolved).toBe(true);
    expect(landOnlyPart.alertSources.length).toBe(1);

    const marineCtx = { alertsMap: new Map(), ecccAlerts: null, ecccMarineAlerts: { alerts: [] } };
    const marinePart = buildAlertInputs(beachRow({ eccc_zone: "Alpena" }), marineCtx);
    expect(marinePart.alertsResolved).toBe(true);
    expect(marinePart.alertSources.length).toBe(1);
  });

  it("resolves nothing for an unenriched beach or a failed fetch", function () {
    const part = buildAlertInputs(beachRow({}), { alertsMap: new Map(), ecccAlerts: null, ecccMarineAlerts: null });
    expect(part.alerts).toBeNull();
    expect(part.alertDetails).toBeNull();
    expect(part.alertSources).toEqual([]);
    expect(part.alertsResolved).toBe(false);

    // An enriched US beach whose national fetch failed: the hourly maps its zone
    // to null, so neither branch is taken and alertsResolved is false.
    const failed = buildAlertInputs(
      beachRow({ nws_zone: "MIZ071" }),
      { alertsMap: new Map([["MIZ071", null]]), ecccAlerts: null, ecccMarineAlerts: null }
    );
    expect(failed.alerts).toBeNull();
    expect(failed.alertsResolved).toBe(false);
  });
});

describe("eventKey and standingAlertEvents", function () {
  it("is order-independent and dedupes", function () {
    expect(eventKey(["Gale Warning", "Small Craft Advisory"]))
      .toBe(eventKey(["Small Craft Advisory", "Gale Warning"]));
    expect(eventKey(["Gale Warning", "Gale Warning"])).toBe("Gale Warning");
    expect(eventKey(null)).toBe("");
    expect(eventKey([])).toBe("");
  });

  it("distinguishes a swap and a partial loss, which a count test would miss", function () {
    expect(eventKey(["Small Craft Advisory"])).not.toBe(eventKey(["Gale Warning"]));
    expect(eventKey(["Gale Warning", "Small Craft Advisory"])).not.toBe(eventKey(["Gale Warning"]));
  });

  it("reads the standing event set off alertDetails, [] when malformed", function () {
    expect(standingAlertEvents({ alertDetails: [{ event: "Gale Warning" }, { onset: "x" }] }))
      .toEqual(["Gale Warning"]);
    expect(standingAlertEvents({})).toEqual([]);
    expect(standingAlertEvents(null)).toEqual([]);
  });
});
