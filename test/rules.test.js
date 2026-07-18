import { describe, it, expect } from "vitest";
import {
  RULES_VERSION,
  ALERT_PRECEDENCE,
  ALERTS_UNAVAILABLE_CAVEAT,
  waveColorForHeight,
  alertColorForEvent,
  ripRiskColor,
  estimateFlag
} from "../src/rules.js";
import { metersToFeet } from "../src/geo.js";

function baseInputs(overrides) {
  const merged = {
    beachId: "osm-node-123456",
    alerts: null,
    ripCurrentRisk: null,
    waveHeightFt: null,
    windSpeedMph: null,
    windGustMph: null,
    sources: [],
    updated: "2026-07-04T12:00:00.000Z"
  };
  const extra = overrides || {};
  for (const key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) {
      merged[key] = extra[key];
    }
  }
  return merged;
}

describe("ALERT_PRECEDENCE", function () {
  it("lists alerts in the documented precedence order", function () {
    expect(ALERT_PRECEDENCE).toEqual([
      "High Surf Warning",
      "Beach Hazards Statement",
      "High Surf Advisory",
      "Rip Current Statement"
    ]);
  });
});

describe("estimateFlag - alerts (step 1)", function () {
  it("1. High Surf Warning -> double-red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["High Surf Warning"] }));
    expect(result.color).toBe("double-red");
    expect(result.reason).toBe("Active NWS alert: High Surf Warning");
  });

  it("2. Beach Hazards Statement -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Beach Hazards Statement"] }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Active NWS alert: Beach Hazards Statement");
  });

  it("3. High Surf Advisory -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["High Surf Advisory"] }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Active NWS alert: High Surf Advisory");
  });

  it("4. Rip Current Statement -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Rip Current Statement"] }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Active NWS alert: Rip Current Statement");
  });

  it("5. ALERT_PRECEDENCE order wins over input order", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Rip Current Statement", "High Surf Warning"]
    }));
    expect(result.color).toBe("double-red");
    expect(result.reason).toBe("Active NWS alert: High Surf Warning");
  });

  it("6. unknown alert event is ignored, falls through to waves", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Tornado Warning"],
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("green");
    expect(result.reason).toBe("Estimated wave height 1.0 ft (below 2 ft)");
  });
});

describe("estimateFlag - rip current risk (step 2)", function () {
  it("7. alerts [] + ripCurrentRisk HIGH -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: [], ripCurrentRisk: "HIGH" }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("NWS surf zone forecast rip current risk: HIGH");
  });

  it("8. ripCurrentRisk MODERATE -> yellow", function () {
    const result = estimateFlag(baseInputs({ ripCurrentRisk: "MODERATE" }));
    expect(result.color).toBe("yellow");
    expect(result.reason).toBe("NWS surf zone forecast rip current risk: MODERATE");
  });

  it("9. alert beats rip: Beach Hazards Statement + MODERATE rip -> red", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Beach Hazards Statement"],
      ripCurrentRisk: "MODERATE"
    }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Active NWS alert: Beach Hazards Statement");
  });

  it("10. rip beats waves: MODERATE rip + 6.0 ft waves -> yellow", function () {
    const result = estimateFlag(baseInputs({
      ripCurrentRisk: "MODERATE",
      waveHeightFt: 6.0
    }));
    expect(result.color).toBe("yellow");
    expect(result.reason).toBe("NWS surf zone forecast rip current risk: MODERATE");
  });

  it("11. LOW rip risk falls through to waves", function () {
    const result = estimateFlag(baseInputs({
      ripCurrentRisk: "LOW",
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("green");
    expect(result.reason).toBe("Estimated wave height 1.0 ft (below 2 ft)");
  });
});

describe("estimateFlag - wave height (step 3)", function () {
  it("12. waveHeightFt 4.0 exactly -> red (boundary)", function () {
    const result = estimateFlag(baseInputs({ waveHeightFt: 4.0 }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Estimated wave height 4.0 ft (at or above 4 ft)");
  });

  it("13. waveHeightFt 3.99 -> yellow", function () {
    const result = estimateFlag(baseInputs({ waveHeightFt: 3.99 }));
    expect(result.color).toBe("yellow");
    expect(result.reason).toBe("Estimated wave height 4.0 ft (at or above 2 ft)");
  });

  it("14. waveHeightFt 2.0 exactly -> yellow (boundary)", function () {
    const result = estimateFlag(baseInputs({ waveHeightFt: 2.0 }));
    expect(result.color).toBe("yellow");
    expect(result.reason).toBe("Estimated wave height 2.0 ft (at or above 2 ft)");
  });

  it("15. waveHeightFt 1.99 -> green, exact toFixed rounding string", function () {
    const result = estimateFlag(baseInputs({ waveHeightFt: 1.99 }));
    expect(result.color).toBe("green");
    expect(result.reason).toBe("Estimated wave height 2.0 ft (below 2 ft)");
  });
});

describe("estimateFlag - wind fallback (step 4)", function () {
  it("16. waveHeightFt null, windSpeedMph 30 -> red", function () {
    const result = estimateFlag(baseInputs({ windSpeedMph: 30 }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe(
      "No wave data; wind 30 mph sustained, n/a mph gusts (at or above 25 mph sustained or 35 mph gust threshold)"
    );
  });

  it("17. windSpeedMph 25 exactly -> red (boundary)", function () {
    const result = estimateFlag(baseInputs({ windSpeedMph: 25 }));
    expect(result.color).toBe("red");
  });

  it("18. windSpeedMph 20, windGustMph 35 exactly -> red (gust boundary)", function () {
    const result = estimateFlag(baseInputs({ windSpeedMph: 20, windGustMph: 35 }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe(
      "No wave data; wind 20 mph sustained, 35 mph gusts (at or above 25 mph sustained or 35 mph gust threshold)"
    );
  });

  it("19. windSpeedMph 15 exactly -> yellow", function () {
    const result = estimateFlag(baseInputs({ windSpeedMph: 15 }));
    expect(result.color).toBe("yellow");
  });

  it("20. windSpeedMph 10, windGustMph 25 exactly -> yellow", function () {
    const result = estimateFlag(baseInputs({ windSpeedMph: 10, windGustMph: 25 }));
    expect(result.color).toBe("yellow");
    expect(result.reason).toBe(
      "No wave data; wind 10 mph sustained, 25 mph gusts (at or above 15 mph sustained or 25 mph gust threshold)"
    );
  });

  it("21. windSpeedMph 10, windGustMph 10 -> green wind reason", function () {
    const result = estimateFlag(baseInputs({ windSpeedMph: 10, windGustMph: 10 }));
    expect(result.color).toBe("green");
    expect(result.reason).toBe(
      "No wave data; wind 10 mph sustained, 10 mph gusts (below advisory thresholds)"
    );
  });

  it("22. windSpeedMph null, windGustMph 40 -> red, speedStr n/a", function () {
    const result = estimateFlag(baseInputs({ windGustMph: 40 }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe(
      "No wave data; wind n/a mph sustained, 40 mph gusts (at or above 25 mph sustained or 35 mph gust threshold)"
    );
  });

  it("23. waveHeightFt 5.0 + windSpeedMph 30 -> red with WAVE reason (wind ignored)", function () {
    const result = estimateFlag(baseInputs({ waveHeightFt: 5.0, windSpeedMph: 30 }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Estimated wave height 5.0 ft (at or above 4 ft)");
  });
});

describe("estimateFlag - terminal fallbacks (step 5)", function () {
  it("24. everything null -> unknown", function () {
    const result = estimateFlag(baseInputs({}));
    expect(result.color).toBe("unknown");
    expect(result.reason).toBe(
      "No usable data from NWS alerts, surf zone forecast, or Open-Meteo wave and wind models"
    );
  });

  it("25. alerts [] and everything else null -> unknown (empty alert list not usable)", function () {
    const result = estimateFlag(baseInputs({ alerts: [] }));
    expect(result.color).toBe("unknown");
    expect(result.reason).toBe(
      "No usable data from NWS alerts, surf zone forecast, or Open-Meteo wave and wind models"
    );
  });

  it("26. ripCurrentRisk LOW, everything else null -> green", function () {
    const result = estimateFlag(baseInputs({ ripCurrentRisk: "LOW" }));
    expect(result.color).toBe("green");
    expect(result.reason).toBe(
      "NWS surf zone forecast rip current risk: LOW; no wave or wind data available"
    );
  });
});

describe("estimateFlag - alerts-not-checkable caveat (alertsCheckable)", function () {
  it("bumped RULES_VERSION for the reason-format change", function () {
    expect(RULES_VERSION).toBe("1.2.0");
  });

  it("wave-only green with alertsCheckable false appends the caveat", function () {
    const result = estimateFlag(baseInputs({
      alertsCheckable: false,
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("green");
    expect(result.trigger).toBe("wave-height");
    expect(result.reason).toBe(
      "Estimated wave height 1.0 ft (below 2 ft) (" + ALERTS_UNAVAILABLE_CAVEAT + ")"
    );
  });

  it("wind fallback with alertsCheckable false appends the caveat", function () {
    const result = estimateFlag(baseInputs({
      alertsCheckable: false,
      windSpeedMph: 10,
      windGustMph: 10
    }));
    expect(result.color).toBe("green");
    expect(result.reason).toBe(
      "No wave data; wind 10 mph sustained, 10 mph gusts (below advisory thresholds) (" +
      ALERTS_UNAVAILABLE_CAVEAT + ")"
    );
  });

  it("no-data unknown with alertsCheckable false appends the caveat", function () {
    const result = estimateFlag(baseInputs({ alertsCheckable: false }));
    expect(result.color).toBe("unknown");
    expect(result.trigger).toBe("no-data");
    expect(result.reason).toBe(
      "No usable data from NWS alerts, surf zone forecast, or Open-Meteo wave and wind models (" +
      ALERTS_UNAVAILABLE_CAVEAT + ")"
    );
  });

  it("alertsCheckable true (alerts checked, none active) gets NO caveat", function () {
    const result = estimateFlag(baseInputs({
      alertsCheckable: true,
      alerts: [],
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("green");
    expect(result.reason).toBe("Estimated wave height 1.0 ft (below 2 ft)");
  });

  it("alertsCheckable omitted (legacy caller) gets NO caveat", function () {
    const result = estimateFlag(baseInputs({ waveHeightFt: 1.0 }));
    expect(result.reason).toBe("Estimated wave height 1.0 ft (below 2 ft)");
  });

  it("contradictory input: alert decided the color, caveat suppressed", function () {
    const result = estimateFlag(baseInputs({
      alertsCheckable: false,
      alerts: ["High Surf Warning"]
    }));
    expect(result.color).toBe("double-red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.reason).toBe("Active NWS alert: High Surf Warning");
  });

  it("rip-current color still carries the caveat when alerts were not checkable", function () {
    const result = estimateFlag(baseInputs({
      alertsCheckable: false,
      ripCurrentRisk: "MODERATE"
    }));
    expect(result.color).toBe("yellow");
    expect(result.reason).toBe(
      "NWS surf zone forecast rip current risk: MODERATE (" + ALERTS_UNAVAILABLE_CAVEAT + ")"
    );
  });
});

describe("alertColorForEvent / ripRiskColor", function () {
  it("maps every ALERT_PRECEDENCE event to its flag color, unknown events to null", function () {
    expect(alertColorForEvent("High Surf Warning")).toBe("double-red");
    expect(alertColorForEvent("Beach Hazards Statement")).toBe("red");
    expect(alertColorForEvent("High Surf Advisory")).toBe("red");
    expect(alertColorForEvent("Rip Current Statement")).toBe("red");
    expect(alertColorForEvent("Tornado Warning")).toBeNull();
    expect(alertColorForEvent("toString")).toBeNull(); // prototype key, not a mapping
  });

  it("maps HIGH -> red, MODERATE -> yellow, everything else -> null", function () {
    expect(ripRiskColor("HIGH")).toBe("red");
    expect(ripRiskColor("MODERATE")).toBe("yellow");
    expect(ripRiskColor("LOW")).toBeNull();
    expect(ripRiskColor(null)).toBeNull();
    expect(ripRiskColor("extreme")).toBeNull();
  });
});

describe("estimateFlag - output contract", function () {
  it("27. official false, rules_version, beachId, sources, updated propagate", function () {
    const sourcesArr = ["https://api.weather.gov/alerts/active?zone=MIZ071"];
    const inputs = baseInputs({
      beachId: "osm-node-999",
      alerts: ["High Surf Warning"],
      sources: sourcesArr,
      updated: "2026-07-04T15:00:03.000Z"
    });
    const result = estimateFlag(inputs);
    expect(result.official).toBe(false);
    expect(result.rules_version).toBe(RULES_VERSION);
    expect(result.beachId).toBe("osm-node-999");
    expect(result.sources).toBe(sourcesArr);
    expect(result.updated).toBe("2026-07-04T15:00:03.000Z");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("trigger identifies the deciding branch for every step", function () {
    expect(estimateFlag(baseInputs({ alerts: ["High Surf Warning"] })).trigger).toBe("nws-alert");
    expect(estimateFlag(baseInputs({ ripCurrentRisk: "HIGH" })).trigger).toBe("rip-current");
    expect(estimateFlag(baseInputs({ ripCurrentRisk: "MODERATE" })).trigger).toBe("rip-current");
    expect(estimateFlag(baseInputs({ waveHeightFt: 1.3 })).trigger).toBe("wave-height");
    expect(estimateFlag(baseInputs({ waveHeightFt: 5.0 })).trigger).toBe("wave-height");
    expect(estimateFlag(baseInputs({ windSpeedMph: 20 })).trigger).toBe("wind");
    expect(estimateFlag(baseInputs({ ripCurrentRisk: "LOW" })).trigger).toBe("rip-current-low");
    expect(estimateFlag(baseInputs({})).trigger).toBe("no-data");
    // LOW rip risk with wave data present: wave rule decides, not the LOW fallback.
    expect(estimateFlag(baseInputs({ ripCurrentRisk: "LOW", waveHeightFt: 1.0 })).trigger).toBe("wave-height");
  });

  it("reason strings are always non-empty across representative branches", function () {
    const cases = [
      baseInputs({ alerts: ["High Surf Warning"] }),
      baseInputs({ ripCurrentRisk: "HIGH" }),
      baseInputs({ waveHeightFt: 3.0 }),
      baseInputs({ windSpeedMph: 20 }),
      baseInputs({ ripCurrentRisk: "LOW" }),
      baseInputs({})
    ];
    for (let i = 0; i < cases.length; i++) {
      const result = estimateFlag(cases[i]);
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("sources defaults to [] when omitted", function () {
    const inputs = {
      beachId: "osm-node-1",
      updated: "2026-07-04T12:00:00.000Z"
    };
    const result = estimateFlag(inputs);
    expect(result.sources).toEqual([]);
  });

  it("echoes sanitized alertDetails on every branch, [] for legacy callers", function () {
    const details = [
      { event: "Beach Hazards Statement",
        onset: "2026-07-04T10:00:00.000Z", ends: "2026-07-05T02:00:00.000Z" },
      { event: "Tornado Warning", onset: 42, ends: "" }, // non-string/empty times -> null
      { onset: "2026-07-04T10:00:00.000Z" },             // no event -> dropped
      null,
      "garbage"
    ];
    // A wave-decided branch still echoes the alert details.
    const result = estimateFlag(baseInputs({ waveHeightFt: 1.0, alertDetails: details }));
    expect(result.trigger).toBe("wave-height");
    expect(result.alertDetails).toEqual([
      { event: "Beach Hazards Statement",
        onset: "2026-07-04T10:00:00.000Z", ends: "2026-07-05T02:00:00.000Z" },
      { event: "Tornado Warning", onset: null, ends: null }
    ]);
    // Legacy caller (no field) and malformed field both echo [].
    expect(estimateFlag(baseInputs({})).alertDetails).toEqual([]);
    expect(estimateFlag(baseInputs({ alertDetails: "nope" })).alertDetails).toEqual([]);
  });

  it("echoes ripCurrentRisk (known levels only) regardless of the deciding branch", function () {
    // An alert decides the color, but the risk level still echoes through.
    const result = estimateFlag(baseInputs({
      alerts: ["High Surf Warning"],
      ripCurrentRisk: "MODERATE"
    }));
    expect(result.trigger).toBe("nws-alert");
    expect(result.ripCurrentRisk).toBe("MODERATE");
    expect(estimateFlag(baseInputs({ ripCurrentRisk: "LOW" })).ripCurrentRisk).toBe("LOW");
    expect(estimateFlag(baseInputs({})).ripCurrentRisk).toBeNull();
    expect(estimateFlag(baseInputs({ ripCurrentRisk: "extreme" })).ripCurrentRisk).toBeNull();
  });
});

describe("estimateFlag - determinism and purity", function () {
  it("28. same frozen input twice -> deep-equal outputs, input unchanged", function () {
    const inputs = Object.freeze(baseInputs({
      alerts: Object.freeze(["Rip Current Statement"]),
      ripCurrentRisk: "HIGH",
      waveHeightFt: 3.0,
      windSpeedMph: 10,
      windGustMph: 10,
      sources: Object.freeze(["https://example.com/src"])
    }));

    expect(function () {
      const first = estimateFlag(inputs);
      const second = estimateFlag(inputs);
      expect(first).toEqual(second);
    }).not.toThrow();
  });
});

describe("waveColorForHeight", function () {
  it("4.0 exactly -> red (boundary)", function () {
    expect(waveColorForHeight(4.0)).toBe("red");
  });

  it("3.99 -> yellow", function () {
    expect(waveColorForHeight(3.99)).toBe("yellow");
  });

  it("2.0 exactly -> yellow (boundary)", function () {
    expect(waveColorForHeight(2.0)).toBe("yellow");
  });

  it("1.99 -> green", function () {
    expect(waveColorForHeight(1.99)).toBe("green");
  });

  it("0 -> green", function () {
    expect(waveColorForHeight(0)).toBe("green");
  });

  it("null -> null", function () {
    expect(waveColorForHeight(null)).toBe(null);
  });

  it("undefined -> null", function () {
    expect(waveColorForHeight(undefined)).toBe(null);
  });

  it("NaN -> null", function () {
    expect(waveColorForHeight(NaN)).toBe(null);
  });

  it("non-numeric string -> null", function () {
    expect(waveColorForHeight("3")).toBe(null);
  });
});

describe("estimateFlag - echoes waveHeightFt", function () {
  it("echoes a finite waveHeightFt input onto the result", function () {
    const result = estimateFlag(baseInputs({ waveHeightFt: 3.2 }));
    expect(result.waveHeightFt).toBe(3.2);
  });

  it("waveHeightFt null (or omitted) -> result.waveHeightFt null", function () {
    expect(estimateFlag(baseInputs({})).waveHeightFt).toBe(null);
    expect(estimateFlag(baseInputs({ waveHeightFt: null })).waveHeightFt).toBe(null);
  });

  it("alert decides the color but the wave reading is still echoed", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["High Surf Warning"],
      waveHeightFt: 1.5
    }));
    expect(result.color).toBe("double-red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.waveHeightFt).toBe(1.5);
  });
});

describe("metersToFeet", function () {
  it("29. converts meters to feet, and passes through null", function () {
    expect(metersToFeet(1)).toBeCloseTo(3.28084, 5);
    expect(metersToFeet(0)).toBe(0);
    expect(metersToFeet(null)).toBe(null);
    expect(metersToFeet(undefined)).toBe(null);
  });
});
