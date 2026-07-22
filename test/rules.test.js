import { describe, it, expect } from "vitest";
import {
  RULES_VERSION,
  ALERT_PRECEDENCE,
  NWS_FLOOR_PRECEDENCE,
  ECCC_ALERT_PRECEDENCE,
  ECCC_FLOOR_PRECEDENCE,
  ALERTS_UNAVAILABLE_CAVEAT,
  waveColorForHeight,
  alertColorForEvent,
  alertAuthorityForEvent,
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
    waterQualityAdvisory: null,
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
      "Tornado Warning",
      "High Surf Warning",
      "Storm Warning",
      "Severe Thunderstorm Warning",
      "Beach Hazards Statement",
      "High Surf Advisory",
      "Rip Current Statement",
      "High Wind Warning",
      "Gale Warning",
      "Special Marine Warning",
      "Lakeshore Flood Warning",
      "Coastal Flood Warning"
    ]);
  });

  it("lists every double-red before every red (first-match loop must not shadow a double-red)", function () {
    const firstRed = ALERT_PRECEDENCE.findIndex(function (e) {
      return alertColorForEvent(e) === "red";
    });
    const lastDoubleRed = ALERT_PRECEDENCE.reduce(function (acc, e, i) {
      return alertColorForEvent(e) === "double-red" ? i : acc;
    }, -1);
    expect(lastDoubleRed).toBeLessThan(firstRed);
  });
});

describe("NWS_FLOOR_PRECEDENCE", function () {
  it("lists NWS yellow watches/advisories in the documented order", function () {
    expect(NWS_FLOOR_PRECEDENCE).toEqual([
      "Tornado Watch",
      "Severe Thunderstorm Watch",
      "High Wind Watch",
      "Wind Advisory",
      "Lake Wind Advisory",
      "Small Craft Advisory",
      "Lakeshore Flood Advisory",
      "Coastal Flood Advisory"
    ]);
  });

  it("every NWS_FLOOR_PRECEDENCE event maps to yellow", function () {
    NWS_FLOOR_PRECEDENCE.forEach(function (e) {
      expect(alertColorForEvent(e)).toBe("yellow");
    });
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
      alerts: ["Winter Storm Warning"],
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("green");
    expect(result.reason).toBe("Estimated wave height 1.0 ft (below 2 ft)");
  });

  it("7. Tornado Warning -> double-red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Tornado Warning"] }));
    expect(result.color).toBe("double-red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.reason).toBe("Active NWS alert: Tornado Warning");
  });

  it("8. Severe Thunderstorm Warning -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Severe Thunderstorm Warning"] }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.reason).toBe("Active NWS alert: Severe Thunderstorm Warning");
  });

  it("9. Tornado Warning wins over a lower simultaneous NWS alert", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Rip Current Statement", "Tornado Warning"]
    }));
    expect(result.color).toBe("double-red");
    expect(result.reason).toBe("Active NWS alert: Tornado Warning");
  });

  it("10. a severe-weather WARNING is not downgraded by a wave green", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Severe Thunderstorm Warning"],
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Active NWS alert: Severe Thunderstorm Warning");
  });

  it("11. High Wind Warning -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["High Wind Warning"] }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.reason).toBe("Active NWS alert: High Wind Warning");
  });

  it("12. Lakeshore Flood Warning -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Lakeshore Flood Warning"] }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Active NWS alert: Lakeshore Flood Warning");
  });

  it("13. Coastal Flood Warning -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Coastal Flood Warning"] }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Active NWS alert: Coastal Flood Warning");
  });

  it("14. marine Gale Warning -> red, Special Marine Warning -> red", function () {
    expect(estimateFlag(baseInputs({ alerts: ["Gale Warning"] })).color).toBe("red");
    expect(estimateFlag(baseInputs({ alerts: ["Special Marine Warning"] })).color).toBe("red");
  });

  it("15. marine Storm Warning -> double-red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Storm Warning"] }));
    expect(result.color).toBe("double-red");
    expect(result.reason).toBe("Active NWS alert: Storm Warning");
  });

  it("16. a double-red Storm Warning is NOT shadowed by a co-active red", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Rip Current Statement", "Storm Warning"]
    }));
    expect(result.color).toBe("double-red");
    expect(result.reason).toBe("Active NWS alert: Storm Warning");
  });
});

describe("estimateFlag - NWS yellow watch/advisory floor (step 6)", function () {
  it("Tornado Watch raises a wave green to yellow", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Tornado Watch"],
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("nws-floor");
    expect(result.reason).toBe("Active NWS alert: Tornado Watch");
  });

  it("Severe Thunderstorm Watch raises a wave green to yellow", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Severe Thunderstorm Watch"],
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("nws-floor");
    expect(result.reason).toBe("Active NWS alert: Severe Thunderstorm Watch");
  });

  it("Tornado Watch raises an unknown (no data) to yellow", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Tornado Watch"] }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("nws-floor");
    expect(result.reason).toBe("Active NWS alert: Tornado Watch");
  });

  it("a watch NEVER downgrades a higher wave-height red", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Tornado Watch"],
      waveHeightFt: 5.0
    }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("wave-height");
    expect(result.reason).toBe("Estimated wave height 5.0 ft (at or above 4 ft)");
  });

  it("a watch NEVER downgrades a rip-current red", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Tornado Watch"],
      ripCurrentRisk: "HIGH"
    }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("rip-current");
  });

  it("a watch leaves an existing wave yellow unchanged", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Tornado Watch"],
      waveHeightFt: 3.0
    }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("wave-height");
    expect(result.reason).toBe("Estimated wave height 3.0 ft (at or above 2 ft)");
  });

  it("a warning still wins outright over a co-active watch", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Tornado Watch", "Tornado Warning"]
    }));
    expect(result.color).toBe("double-red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.reason).toBe("Active NWS alert: Tornado Warning");
  });

  it("a watch-decided color suppresses the alerts-not-checkable caveat", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Tornado Watch"],
      alertsCheckable: false
    }));
    expect(result.color).toBe("yellow");
    expect(result.reason).toBe("Active NWS alert: Tornado Watch");
    expect(result.reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT)).toBe(-1);
  });

  it("Wind Advisory raises a wave green to yellow", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Wind Advisory"],
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("nws-floor");
    expect(result.reason).toBe("Active NWS alert: Wind Advisory");
  });

  it("each wind/flood/marine advisory floors green -> yellow", function () {
    ["High Wind Watch", "Lake Wind Advisory", "Small Craft Advisory",
     "Lakeshore Flood Advisory", "Coastal Flood Advisory"].forEach(function (event) {
      const result = estimateFlag(baseInputs({ alerts: [event], waveHeightFt: 1.0 }));
      expect(result.color).toBe("yellow");
      expect(result.trigger).toBe("nws-floor");
      expect(result.reason).toBe("Active NWS alert: " + event);
    });
  });

  it("an advisory NEVER downgrades a wave-height red", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Wind Advisory"],
      waveHeightFt: 5.0
    }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("wave-height");
  });

  it("a warning wins outright over a co-active advisory", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Wind Advisory", "High Wind Warning"]
    }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.reason).toBe("Active NWS alert: High Wind Warning");
  });
});

describe("estimateFlag - Environment Canada marine yellow floor (step 6b)", function () {
  it("strong wind warning raises a wave green to yellow", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["strong wind warning"],
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("eccc-floor");
    expect(result.reason).toBe("Active Environment Canada alert: strong wind warning");
  });

  it("marine weather advisory raises an unknown (no data) to yellow", function () {
    const result = estimateFlag(baseInputs({ alerts: ["marine weather advisory"] }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("eccc-floor");
    expect(result.reason).toBe("Active Environment Canada alert: marine weather advisory");
  });

  it("NEVER downgrades a wave-height red", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["strong wind warning"],
      waveHeightFt: 5.0
    }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("wave-height");
  });

  it("a marine gale warning still wins outright over a co-active strong wind warning", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["strong wind warning", "gale warning"]
    }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("eccc-alert");
    expect(result.reason).toBe("Active Environment Canada alert: gale warning");
  });

  it("an eccc-floor color suppresses the alerts-not-checkable caveat", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["strong wind warning"],
      alertsCheckable: false
    }));
    expect(result.color).toBe("yellow");
    expect(result.reason).toBe("Active Environment Canada alert: strong wind warning");
    expect(result.reason.indexOf(ALERTS_UNAVAILABLE_CAVEAT)).toBe(-1);
  });
});

describe("estimateFlag - raise-only water-quality floor (step 7)", function () {
  function advisory(color) {
    return { color: color, reason: "E. coli exceedance", source: "Test Health Dept" };
  }

  it("a yellow advisory raises a wave green to yellow", function () {
    const result = estimateFlag(baseInputs({
      waterQualityAdvisory: advisory("yellow"),
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("wq-floor");
    expect(result.reason).toBe("Water-quality advisory (Test Health Dept): E. coli exceedance");
  });

  it("a red advisory raises a wave green to red", function () {
    const result = estimateFlag(baseInputs({
      waterQualityAdvisory: advisory("red"),
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("wq-floor");
    expect(result.reason).toBe("Water-quality advisory (Test Health Dept): E. coli exceedance");
  });

  it("a yellow advisory raises an unknown (no data) to yellow", function () {
    const result = estimateFlag(baseInputs({ waterQualityAdvisory: advisory("yellow") }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("wq-floor");
  });

  it("a red advisory raises an unknown (no data) to red", function () {
    const result = estimateFlag(baseInputs({ waterQualityAdvisory: advisory("red") }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("wq-floor");
  });

  it("a yellow advisory NEVER downgrades a wave-height red", function () {
    const result = estimateFlag(baseInputs({
      waterQualityAdvisory: advisory("yellow"),
      waveHeightFt: 5.0
    }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("wave-height");
    expect(result.reason).toBe("Estimated wave height 5.0 ft (at or above 4 ft)");
  });

  it("a yellow advisory NEVER downgrades a rip-current red", function () {
    const result = estimateFlag(baseInputs({
      waterQualityAdvisory: advisory("yellow"),
      ripCurrentRisk: "HIGH"
    }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("rip-current");
  });

  it("a red advisory NEVER downgrades a double-red warning", function () {
    const result = estimateFlag(baseInputs({
      waterQualityAdvisory: advisory("red"),
      alerts: ["High Surf Warning"]
    }));
    expect(result.color).toBe("double-red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.reason).toBe("Active NWS alert: High Surf Warning");
  });

  it("a yellow advisory leaves an existing wave yellow unchanged (equal rank does not re-decide)", function () {
    const result = estimateFlag(baseInputs({
      waterQualityAdvisory: advisory("yellow"),
      waveHeightFt: 3.0
    }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("wave-height");
    expect(result.reason).toBe("Estimated wave height 3.0 ft (at or above 2 ft)");
  });

  it("a red advisory raises a wave yellow to red", function () {
    const result = estimateFlag(baseInputs({
      waterQualityAdvisory: advisory("red"),
      waveHeightFt: 3.0
    }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("wq-floor");
  });

  it("a null advisory has zero effect (wave green stays green)", function () {
    const result = estimateFlag(baseInputs({
      waterQualityAdvisory: null,
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("green");
    expect(result.trigger).toBe("wave-height");
    expect(result.reason).toBe("Estimated wave height 1.0 ft (below 2 ft)");
  });

  it("green/double-red/unknown floor colors are rejected (invalid, no effect)", function () {
    ["green", "double-red", "unknown", "gray", null].forEach(function (bad) {
      const result = estimateFlag(baseInputs({
        waterQualityAdvisory: { color: bad, reason: "x", source: "Y" },
        waveHeightFt: 1.0
      }));
      expect(result.color).toBe("green");
      expect(result.trigger).toBe("wave-height");
    });
  });

  it("stacks on the NWS floor: an advisory red beats a nws-floored yellow", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Wind Advisory"],
      waterQualityAdvisory: advisory("red"),
      waveHeightFt: 1.0
    }));
    // NWS floor lifts green -> yellow, then the red WQ advisory lifts it further.
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("wq-floor");
  });

  it("does NOT override the nws-floor yellow with an equal-rank yellow advisory", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Wind Advisory"],
      waterQualityAdvisory: advisory("yellow"),
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("nws-floor");
    expect(result.reason).toBe("Active NWS alert: Wind Advisory");
  });

  it("missing reason/source degrade to sane strings, still raises", function () {
    const result = estimateFlag(baseInputs({
      waterQualityAdvisory: { color: "yellow" },
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("wq-floor");
    expect(result.reason).toBe("Water-quality advisory (unknown): ");
  });

  it("a wq-floored color still carries the alerts-not-checkable caveat (WQ says nothing about alert coverage)", function () {
    const result = estimateFlag(baseInputs({
      alertsCheckable: false,
      waterQualityAdvisory: advisory("yellow"),
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("wq-floor");
    expect(result.reason).toBe(
      "Water-quality advisory (Test Health Dept): E. coli exceedance (" + ALERTS_UNAVAILABLE_CAVEAT + ")"
    );
  });
});

describe("ECCC_ALERT_PRECEDENCE", function () {
  it("lists Environment Canada alerts in the documented precedence order", function () {
    expect(ECCC_ALERT_PRECEDENCE).toEqual([
      "tornado warning",
      "storm surge warning",
      "storm warning",
      "squall warning",
      "waterspout warning",
      "severe thunderstorm warning",
      "gale warning",
      "wind warning"
    ]);
  });

  it("lists every double-red before every red", function () {
    const firstRed = ECCC_ALERT_PRECEDENCE.findIndex(function (e) {
      return alertColorForEvent(e) === "red";
    });
    const lastDoubleRed = ECCC_ALERT_PRECEDENCE.reduce(function (acc, e, i) {
      return alertColorForEvent(e) === "double-red" ? i : acc;
    }, -1);
    expect(lastDoubleRed).toBeLessThan(firstRed);
  });
});

describe("ECCC_FLOOR_PRECEDENCE", function () {
  it("lists the marine yellow-floor events", function () {
    expect(ECCC_FLOOR_PRECEDENCE).toEqual([
      "strong wind warning",
      "marine weather advisory"
    ]);
  });

  it("every ECCC_FLOOR_PRECEDENCE event maps to yellow", function () {
    ECCC_FLOOR_PRECEDENCE.forEach(function (e) {
      expect(alertColorForEvent(e)).toBe("yellow");
    });
  });
});

describe("estimateFlag - Environment Canada alerts (step 1b)", function () {
  it("tornado warning -> double-red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["tornado warning"] }));
    expect(result.color).toBe("double-red");
    expect(result.trigger).toBe("eccc-alert");
    expect(result.reason).toBe("Active Environment Canada alert: tornado warning");
  });

  it("storm surge warning -> double-red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["storm surge warning"] }));
    expect(result.color).toBe("double-red");
    expect(result.reason).toBe("Active Environment Canada alert: storm surge warning");
  });

  it("squall warning -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["squall warning"] }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Active Environment Canada alert: squall warning");
  });

  it("waterspout warning -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["waterspout warning"] }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Active Environment Canada alert: waterspout warning");
  });

  it("severe thunderstorm warning -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["severe thunderstorm warning"] }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Active Environment Canada alert: severe thunderstorm warning");
  });

  it("wind warning -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["wind warning"] }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Active Environment Canada alert: wind warning");
  });

  it("marine storm warning -> double-red (distinct from storm surge)", function () {
    const result = estimateFlag(baseInputs({ alerts: ["storm warning"] }));
    expect(result.color).toBe("double-red");
    expect(result.trigger).toBe("eccc-alert");
    expect(result.reason).toBe("Active Environment Canada alert: storm warning");
  });

  it("marine gale warning -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["gale warning"] }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("eccc-alert");
    expect(result.reason).toBe("Active Environment Canada alert: gale warning");
  });

  it("marine gale warning wins over a wave-height yellow", function () {
    const result = estimateFlag(baseInputs({ alerts: ["gale warning"], waveHeightFt: 2.5 }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("eccc-alert");
  });

  it("ECCC_ALERT_PRECEDENCE order wins over input order", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["wind warning", "tornado warning"]
    }));
    expect(result.color).toBe("double-red");
    expect(result.reason).toBe("Active Environment Canada alert: tornado warning");
  });

  it("watches and non-water products are ignored, falls through to waves", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["severe thunderstorm watch", "heat warning", "air quality warning"],
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("green");
    expect(result.reason).toBe("Estimated wave height 1.0 ft (below 2 ft)");
  });

  it("a recognized NWS event wins over a recognized ECCC event (step 1 before 1b)", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["wind warning", "Rip Current Statement"]
    }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.reason).toBe("Active NWS alert: Rip Current Statement");
  });

  it("ECCC alert beats wave height under strict precedence", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["severe thunderstorm warning"],
      waveHeightFt: 0.5
    }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Active Environment Canada alert: severe thunderstorm warning");
  });

  it("contradictory input: ECCC alert decided the color, caveat suppressed", function () {
    const result = estimateFlag(baseInputs({
      alertsCheckable: false,
      alerts: ["wind warning"]
    }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("eccc-alert");
    expect(result.reason).toBe("Active Environment Canada alert: wind warning");
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
  it("bumped RULES_VERSION for the raise-only water-quality floor", function () {
    expect(RULES_VERSION).toBe("1.5.0");
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
  it("maps every ALERT_PRECEDENCE / NWS_FLOOR_PRECEDENCE event to its flag color, unknown events to null", function () {
    expect(alertColorForEvent("Tornado Warning")).toBe("double-red");
    expect(alertColorForEvent("High Surf Warning")).toBe("double-red");
    expect(alertColorForEvent("Storm Warning")).toBe("double-red");
    expect(alertColorForEvent("Severe Thunderstorm Warning")).toBe("red");
    expect(alertColorForEvent("Beach Hazards Statement")).toBe("red");
    expect(alertColorForEvent("High Surf Advisory")).toBe("red");
    expect(alertColorForEvent("Rip Current Statement")).toBe("red");
    expect(alertColorForEvent("High Wind Warning")).toBe("red");
    expect(alertColorForEvent("Gale Warning")).toBe("red");
    expect(alertColorForEvent("Special Marine Warning")).toBe("red");
    expect(alertColorForEvent("Lakeshore Flood Warning")).toBe("red");
    expect(alertColorForEvent("Coastal Flood Warning")).toBe("red");
    expect(alertColorForEvent("Tornado Watch")).toBe("yellow");
    expect(alertColorForEvent("Severe Thunderstorm Watch")).toBe("yellow");
    expect(alertColorForEvent("High Wind Watch")).toBe("yellow");
    expect(alertColorForEvent("Wind Advisory")).toBe("yellow");
    expect(alertColorForEvent("Lake Wind Advisory")).toBe("yellow");
    expect(alertColorForEvent("Small Craft Advisory")).toBe("yellow");
    expect(alertColorForEvent("Lakeshore Flood Advisory")).toBe("yellow");
    expect(alertColorForEvent("Coastal Flood Advisory")).toBe("yellow");
    expect(alertColorForEvent("Winter Storm Warning")).toBeNull();
    expect(alertColorForEvent("toString")).toBeNull(); // prototype key, not a mapping
  });

  it("maps every ECCC_ALERT_PRECEDENCE event to its flag color (lowercase, exact match)", function () {
    expect(alertColorForEvent("tornado warning")).toBe("double-red");
    expect(alertColorForEvent("storm surge warning")).toBe("double-red");
    expect(alertColorForEvent("storm warning")).toBe("double-red");
    expect(alertColorForEvent("squall warning")).toBe("red");
    expect(alertColorForEvent("waterspout warning")).toBe("red");
    expect(alertColorForEvent("severe thunderstorm warning")).toBe("red");
    expect(alertColorForEvent("gale warning")).toBe("red");
    expect(alertColorForEvent("wind warning")).toBe("red");
    expect(alertColorForEvent("strong wind warning")).toBe("yellow");
    expect(alertColorForEvent("marine weather advisory")).toBe("yellow");
    // Watches and non-water ECCC products stay unmapped.
    expect(alertColorForEvent("severe thunderstorm watch")).toBeNull();
    expect(alertColorForEvent("heat warning")).toBeNull();
    // Title Case would be an NWS-style string, not what GeoMet serves.
    expect(alertColorForEvent("Wind Warning")).toBeNull();
  });

  it("alertAuthorityForEvent attributes events to their issuing body", function () {
    expect(alertAuthorityForEvent("High Surf Warning")).toBe("NWS");
    expect(alertAuthorityForEvent("Tornado Warning")).toBe("NWS");
    expect(alertAuthorityForEvent("Tornado Watch")).toBe("NWS");
    expect(alertAuthorityForEvent("Gale Warning")).toBe("NWS");
    expect(alertAuthorityForEvent("Wind Advisory")).toBe("NWS");
    expect(alertAuthorityForEvent("wind warning")).toBe("Environment Canada");
    expect(alertAuthorityForEvent("heat warning")).toBeNull();
    expect(alertAuthorityForEvent("toString")).toBeNull();
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
