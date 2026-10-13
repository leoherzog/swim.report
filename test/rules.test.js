import { describe, it, expect } from "vitest";
import {
  RULES_VERSION,
  ALERT_PRECEDENCE,
  NWS_FLOOR_PRECEDENCE,
  ECCC_ALERT_PRECEDENCE,
  ECCC_FLOOR_PRECEDENCE,
  ALERTS_UNAVAILABLE_CAVEAT,
  waveColorForHeight,
  waveThresholdsForWaterClass,
  WAVE_THRESHOLDS_FT,
  alertColorForEvent,
  alertAuthorityForEvent,
  ripRiskColor,
  alertInEffectAt,
  alertsInEffect,
  decidedAlertDetails,
  estimateFlag
} from "../src/rules.js";
import { metersToFeet } from "../src/geo.js";
import { readFileSync } from "node:fs";

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
      "Tsunami Warning",
      "Hurricane Warning",
      "Storm Surge Warning",
      "Extreme Wind Warning",
      "Tornado Warning",
      "High Surf Warning",
      "Hurricane Force Wind Warning",
      "Storm Warning",
      "Tropical Storm Warning",
      "Tsunami Advisory",
      "Severe Thunderstorm Warning",
      "Beach Hazards Statement",
      "High Surf Advisory",
      "Rip Current Statement",
      "High Wind Warning",
      "Gale Warning",
      "Hazardous Seas Warning",
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

  it("every entry maps to red or double-red, never yellow or null", function () {
    ALERT_PRECEDENCE.forEach(function (e) {
      expect(["red", "double-red"]).toContain(alertColorForEvent(e));
    });
  });

  it("the tropical and tsunami double-reds sit in the double-red block", function () {
    const firstRed = ALERT_PRECEDENCE.findIndex(function (e) {
      return alertColorForEvent(e) === "red";
    });
    ["Tsunami Warning", "Hurricane Warning", "Storm Surge Warning",
     "Extreme Wind Warning", "Hurricane Force Wind Warning"].forEach(function (e) {
      expect(alertColorForEvent(e)).toBe("double-red");
      expect(ALERT_PRECEDENCE.indexOf(e)).toBeLessThan(firstRed);
    });
  });
});

describe("NWS_FLOOR_PRECEDENCE", function () {
  it("lists NWS yellow watches/advisories in the documented order", function () {
    expect(NWS_FLOOR_PRECEDENCE).toEqual([
      "Hurricane Watch",
      "Tropical Storm Watch",
      "Storm Surge Watch",
      "Tsunami Watch",
      "Tornado Watch",
      "Severe Thunderstorm Watch",
      "High Wind Watch",
      "Wind Advisory",
      "Lake Wind Advisory",
      "Hurricane Force Wind Watch",
      "Small Craft Advisory",
      "Brisk Wind Advisory",
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

  it("17. Tsunami Warning -> double-red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Tsunami Warning"] }));
    expect(result.color).toBe("double-red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.reason).toBe("Active NWS alert: Tsunami Warning");
  });

  it("18. Hurricane Warning -> double-red ahead of a co-active High Surf Advisory", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["High Surf Advisory", "Hurricane Warning"],
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("double-red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.reason).toBe("Active NWS alert: Hurricane Warning");
  });

  it("19. Storm Surge Warning, Extreme Wind Warning, marine Hurricane Force Wind Warning -> double-red", function () {
    ["Storm Surge Warning", "Extreme Wind Warning", "Hurricane Force Wind Warning"].forEach(function (event) {
      const result = estimateFlag(baseInputs({ alerts: [event] }));
      expect(result.color).toBe("double-red");
      expect(result.reason).toBe("Active NWS alert: " + event);
    });
  });

  it("20. Tropical Storm Warning -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Tropical Storm Warning"] }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.reason).toBe("Active NWS alert: Tropical Storm Warning");
  });

  it("21. Tsunami Advisory -> red", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Tsunami Advisory"] }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Active NWS alert: Tsunami Advisory");
  });

  it("22. a Tropical Storm Warning red does not shadow a co-active Hurricane Warning", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Tropical Storm Warning", "Hurricane Warning"]
    }));
    expect(result.color).toBe("double-red");
    expect(result.reason).toBe("Active NWS alert: Hurricane Warning");
  });
});

describe("estimateFlag - NWS yellow watch/advisory floor (step 6)", function () {
  it("Hurricane Watch raises a wave green to yellow", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Hurricane Watch"],
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("nws-floor");
    expect(result.reason).toBe("Active NWS alert: Hurricane Watch");
  });

  it("Hurricane Watch NEVER downgrades a wave-height red", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Hurricane Watch"],
      waveHeightFt: 5.0
    }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("wave-height");
    expect(result.reason).toBe("Estimated wave height 5.0 ft (at or above 4 ft)");
  });

  it("each tropical/tsunami watch floors green -> yellow", function () {
    ["Tropical Storm Watch", "Storm Surge Watch", "Tsunami Watch",
     "Hurricane Force Wind Watch"].forEach(function (event) {
      const result = estimateFlag(baseInputs({ alerts: [event], waveHeightFt: 1.0 }));
      expect(result.color).toBe("yellow");
      expect(result.trigger).toBe("nws-floor");
      expect(result.reason).toBe("Active NWS alert: " + event);
    });
  });

  it("a Hurricane Warning still wins outright over a co-active Hurricane Watch", function () {
    const result = estimateFlag(baseInputs({
      alerts: ["Hurricane Watch", "Hurricane Warning"]
    }));
    expect(result.color).toBe("double-red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.reason).toBe("Active NWS alert: Hurricane Warning");
  });

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
      "wind warning",
      "les su\u00eates wind warning",
      "wreckhouse wind warning"
    ]);
  });

  it("writes the Les Su\u00eates key NFC, matching the GeoMet feed byte for byte", function () {
    const key = ECCC_ALERT_PRECEDENCE[8];
    expect(key.charCodeAt(6)).toBe(0x00ea);
    expect(key.normalize("NFC")).toBe(key);
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

  it("ocean beach: 4.5 ft is yellow against the ocean set, quoting 3 ft", function () {
    const result = estimateFlag(baseInputs({ waveHeightFt: 4.5, waterClass: "ocean" }));
    expect(result.color).toBe("yellow");
    expect(result.reason).toBe("Estimated wave height 4.5 ft (at or above 3 ft)");
    expect(result.trigger).toBe("wave-height");
  });

  it("ocean beach: 6.0 ft exactly is red, quoting 6 ft", function () {
    const result = estimateFlag(baseInputs({ waveHeightFt: 6.0, waterClass: "ocean" }));
    expect(result.color).toBe("red");
    expect(result.reason).toBe("Estimated wave height 6.0 ft (at or above 6 ft)");
  });

  it("ocean beach: 2.9 ft is green, quoting 3 ft", function () {
    const result = estimateFlag(baseInputs({ waveHeightFt: 2.9, waterClass: "ocean" }));
    expect(result.color).toBe("green");
    expect(result.reason).toBe("Estimated wave height 2.9 ft (below 3 ft)");
  });

  it("great_lake and null water classes decide identically", function () {
    const lake = estimateFlag(baseInputs({ waveHeightFt: 4.5, waterClass: "great_lake" }));
    const none = estimateFlag(baseInputs({ waveHeightFt: 4.5 }));
    expect(lake.color).toBe("red");
    expect(lake.reason).toBe(none.reason);
  });

  it("ocean thresholds never outrank an alert or rip risk", function () {
    const rip = estimateFlag(baseInputs({ waveHeightFt: 7.0, waterClass: "ocean", ripCurrentRisk: "MODERATE" }));
    expect(rip.color).toBe("yellow");
    expect(rip.trigger).toBe("rip-current");
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
      "No wave or weather data is available for this beach yet"
    );
  });

  it("25. alerts [] and everything else null -> unknown (empty alert list not usable)", function () {
    const result = estimateFlag(baseInputs({ alerts: [] }));
    expect(result.color).toBe("unknown");
    expect(result.reason).toBe(
      "No wave or weather data is available for this beach yet"
    );
  });

  it("26. ripCurrentRisk LOW, everything else null -> unknown (LOW never decides a color)", function () {
    const result = estimateFlag(baseInputs({ ripCurrentRisk: "LOW" }));
    expect(result.color).toBe("unknown");
    expect(result.trigger).toBe("no-data");
    expect(result.reason).toBe(
      "No wave or weather data is available for this beach yet"
    );
    expect(result.ripCurrentRisk).toBe("LOW");
  });
});

describe("estimateFlag - alerts-not-checkable caveat (alertsCheckable)", function () {
  it("bumped RULES_VERSION for LOW-is-unknown, the ECCC proper-noun wind warnings, the Hazardous Seas / Brisk Wind products and non-finite wave intake", function () {
    expect(RULES_VERSION).toBe("1.9.0");
  });

  it("pins the caveat wording, which every other caveat test uses symbolically", function () {
    expect(ALERTS_UNAVAILABLE_CAVEAT).toBe("weather alerts are not checked here yet");
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
      "No wave or weather data is available for this beach yet (" +
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
    expect(alertColorForEvent("Tsunami Warning")).toBe("double-red");
    expect(alertColorForEvent("Hurricane Warning")).toBe("double-red");
    expect(alertColorForEvent("Storm Surge Warning")).toBe("double-red");
    expect(alertColorForEvent("Extreme Wind Warning")).toBe("double-red");
    expect(alertColorForEvent("Tornado Warning")).toBe("double-red");
    expect(alertColorForEvent("High Surf Warning")).toBe("double-red");
    expect(alertColorForEvent("Hurricane Force Wind Warning")).toBe("double-red");
    expect(alertColorForEvent("Storm Warning")).toBe("double-red");
    expect(alertColorForEvent("Tropical Storm Warning")).toBe("red");
    expect(alertColorForEvent("Tsunami Advisory")).toBe("red");
    expect(alertColorForEvent("Severe Thunderstorm Warning")).toBe("red");
    expect(alertColorForEvent("Beach Hazards Statement")).toBe("red");
    expect(alertColorForEvent("High Surf Advisory")).toBe("red");
    expect(alertColorForEvent("Rip Current Statement")).toBe("red");
    expect(alertColorForEvent("High Wind Warning")).toBe("red");
    expect(alertColorForEvent("Gale Warning")).toBe("red");
    expect(alertColorForEvent("Hazardous Seas Warning")).toBe("red");
    expect(alertColorForEvent("Special Marine Warning")).toBe("red");
    expect(alertColorForEvent("Lakeshore Flood Warning")).toBe("red");
    expect(alertColorForEvent("Coastal Flood Warning")).toBe("red");
    expect(alertColorForEvent("Hurricane Watch")).toBe("yellow");
    expect(alertColorForEvent("Tropical Storm Watch")).toBe("yellow");
    expect(alertColorForEvent("Storm Surge Watch")).toBe("yellow");
    expect(alertColorForEvent("Tsunami Watch")).toBe("yellow");
    expect(alertColorForEvent("Hurricane Force Wind Watch")).toBe("yellow");
    expect(alertColorForEvent("Tornado Watch")).toBe("yellow");
    expect(alertColorForEvent("Severe Thunderstorm Watch")).toBe("yellow");
    expect(alertColorForEvent("High Wind Watch")).toBe("yellow");
    expect(alertColorForEvent("Wind Advisory")).toBe("yellow");
    expect(alertColorForEvent("Lake Wind Advisory")).toBe("yellow");
    expect(alertColorForEvent("Small Craft Advisory")).toBe("yellow");
    expect(alertColorForEvent("Brisk Wind Advisory")).toBe("yellow");
    expect(alertColorForEvent("Lakeshore Flood Advisory")).toBe("yellow");
    expect(alertColorForEvent("Coastal Flood Advisory")).toBe("yellow");
    expect(alertColorForEvent("Winter Storm Warning")).toBeNull();
    // Real marine event types left unmapped on purpose: watches are not floors here.
    expect(alertColorForEvent("Hazardous Seas Watch")).toBeNull();
    expect(alertColorForEvent("Gale Watch")).toBeNull();
    expect(alertColorForEvent("toString")).toBeNull(); // prototype key, not a mapping
  });

  it("maps every ECCC_ALERT_PRECEDENCE event to its flag color (case-folded)", function () {
    expect(alertColorForEvent("tornado warning")).toBe("double-red");
    expect(alertColorForEvent("storm surge warning")).toBe("double-red");
    expect(alertColorForEvent("storm warning")).toBe("double-red");
    expect(alertColorForEvent("squall warning")).toBe("red");
    expect(alertColorForEvent("waterspout warning")).toBe("red");
    expect(alertColorForEvent("severe thunderstorm warning")).toBe("red");
    expect(alertColorForEvent("gale warning")).toBe("red");
    expect(alertColorForEvent("wind warning")).toBe("red");
    expect(alertColorForEvent("les su\u00eates wind warning")).toBe("red");
    expect(alertColorForEvent("Les Su\u00eates wind warning")).toBe("red");
    expect(alertColorForEvent("wreckhouse wind warning")).toBe("red");
    expect(alertColorForEvent("Wreckhouse wind warning")).toBe("red");
    expect(alertColorForEvent("strong wind warning")).toBe("yellow");
    expect(alertColorForEvent("marine weather advisory")).toBe("yellow");
    // Watches and non-water ECCC products stay unmapped, whatever the case.
    expect(alertColorForEvent("severe thunderstorm watch")).toBeNull();
    expect(alertColorForEvent("heat warning")).toBeNull();
    expect(alertColorForEvent("Heat Warning")).toBeNull();
    // The ECCC lookup folds case, so Title Case lands on the ECCC key.
    expect(alertColorForEvent("Wind Warning")).toBe("red");
    // Non-strings never reach toLowerCase.
    expect(alertColorForEvent(null)).toBeNull();
    expect(alertColorForEvent(42)).toBeNull();
    expect(alertColorForEvent(undefined)).toBeNull();
  });

  it("alertAuthorityForEvent attributes events to their issuing body", function () {
    expect(alertAuthorityForEvent("High Surf Warning")).toBe("NWS");
    expect(alertAuthorityForEvent("Tornado Warning")).toBe("NWS");
    expect(alertAuthorityForEvent("Tornado Watch")).toBe("NWS");
    expect(alertAuthorityForEvent("Gale Warning")).toBe("NWS");
    expect(alertAuthorityForEvent("Wind Advisory")).toBe("NWS");
    expect(alertAuthorityForEvent("wind warning")).toBe("Environment Canada");
    expect(alertAuthorityForEvent("Les Su\u00eates wind warning")).toBe("Environment Canada");
    expect(alertAuthorityForEvent("Wreckhouse wind warning")).toBe("Environment Canada");
    expect(alertAuthorityForEvent("Hazardous Seas Warning")).toBe("NWS");
    expect(alertAuthorityForEvent("Brisk Wind Advisory")).toBe("NWS");
    // NWS names that fold onto an ECCC key are claimed by the exact NWS lookup first.
    expect(alertAuthorityForEvent("Storm Warning")).toBe("NWS");
    expect(alertAuthorityForEvent("Storm Surge Warning")).toBe("NWS");
    expect(alertAuthorityForEvent("heat warning")).toBeNull();
    expect(alertAuthorityForEvent("toString")).toBeNull();
    expect(alertAuthorityForEvent(null)).toBeNull();
    expect(alertAuthorityForEvent(42)).toBeNull();
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
    expect(estimateFlag(baseInputs({ ripCurrentRisk: "LOW" })).trigger).toBe("no-data");
    expect(estimateFlag(baseInputs({})).trigger).toBe("no-data");
    // LOW rip risk with wave or wind data present: that rule decides, never LOW.
    expect(estimateFlag(baseInputs({ ripCurrentRisk: "LOW", waveHeightFt: 1.0 })).trigger).toBe("wave-height");
    expect(estimateFlag(baseInputs({ ripCurrentRisk: "LOW", windSpeedMph: 10 })).trigger).toBe("wind");
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
        onset: "2026-07-04T10:00:00.000Z", ends: "2026-07-05T02:00:00.000Z",
        description: "* WHAT...High waves expected.",
        instruction: "Remain out of the water.",
        area: "Door; Kewaunee",
        sender: "NWS Green Bay WI" },
      // non-string/empty times and text -> null
      { event: "Tornado Warning", onset: 42, ends: "", description: 7, area: "" },
      { onset: "2026-07-04T10:00:00.000Z" },             // no event -> dropped
      null,
      "garbage"
    ];
    // A wave-decided branch still echoes the alert details.
    const result = estimateFlag(baseInputs({ waveHeightFt: 1.0, alertDetails: details }));
    expect(result.trigger).toBe("wave-height");
    expect(result.alertDetails).toEqual([
      { event: "Beach Hazards Statement",
        onset: "2026-07-04T10:00:00.000Z", ends: "2026-07-05T02:00:00.000Z",
        description: "* WHAT...High waves expected.",
        instruction: "Remain out of the water.",
        area: "Door; Kewaunee",
        sender: "NWS Green Bay WI" },
      { event: "Tornado Warning", onset: null, ends: null,
        description: null, instruction: null, area: null, sender: null }
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

  it("ocean class uses the 3 ft / 6 ft set, at boundaries", function () {
    expect(waveColorForHeight(6.0, "ocean")).toBe("red");
    expect(waveColorForHeight(5.99, "ocean")).toBe("yellow");
    expect(waveColorForHeight(3.0, "ocean")).toBe("yellow");
    expect(waveColorForHeight(2.99, "ocean")).toBe("green");
  });

  it("great_lake, inland, null and unknown classes all use the default set", function () {
    const classes = ["great_lake", "inland", null, undefined, "", "OCEAN", 42];
    for (let i = 0; i < classes.length; i++) {
      expect(waveColorForHeight(4.0, classes[i])).toBe("red");
      expect(waveColorForHeight(2.0, classes[i])).toBe("yellow");
      expect(waveColorForHeight(1.99, classes[i])).toBe("green");
    }
  });
});

describe("waveThresholdsForWaterClass", function () {
  it("carries the documented threshold pairs", function () {
    expect(WAVE_THRESHOLDS_FT).toEqual({
      "default": { yellow: 2, red: 4 },
      "ocean": { yellow: 3, red: 6 }
    });
  });

  it("selects ocean only for the exact string and never returns a copy", function () {
    expect(waveThresholdsForWaterClass("ocean")).toBe(WAVE_THRESHOLDS_FT.ocean);
    expect(waveThresholdsForWaterClass("great_lake")).toBe(WAVE_THRESHOLDS_FT["default"]);
    expect(waveThresholdsForWaterClass(null)).toBe(WAVE_THRESHOLDS_FT["default"]);
    expect(waveThresholdsForWaterClass(undefined)).toBe(WAVE_THRESHOLDS_FT["default"]);
  });

  it("every set keeps yellow strictly below red", function () {
    for (const key in WAVE_THRESHOLDS_FT) {
      if (Object.prototype.hasOwnProperty.call(WAVE_THRESHOLDS_FT, key)) {
        expect(WAVE_THRESHOLDS_FT[key].yellow).toBeLessThan(WAVE_THRESHOLDS_FT[key].red);
      }
    }
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

describe("alertInEffectAt / alertsInEffect / decidedAlertDetails", function () {
  const AT = "2026-07-15T16:00:00.000Z";
  const upcoming = { event: "Beach Hazards Statement", onset: "2026-07-16T07:00:00.000Z", ends: "2026-07-16T23:00:00.000Z" };
  const live = { event: "Gale Warning", onset: "2026-07-15T10:00:00.000Z", ends: "2026-07-15T22:00:00.000Z" };
  const ended = { event: "Small Craft Advisory", onset: "2026-07-15T02:00:00.000Z", ends: "2026-07-15T15:00:00.000Z" };
  const untimed = { event: "Rip Current Statement", onset: null, ends: null };

  it("keeps an alert only while onset <= at < ends", function () {
    expect(alertInEffectAt(upcoming, AT)).toBe(false);
    expect(alertInEffectAt(live, AT)).toBe(true);
    expect(alertInEffectAt(ended, AT)).toBe(false);
    // The onset instant itself is in effect; the ends instant is not.
    expect(alertInEffectAt(live, live.onset)).toBe(true);
    expect(alertInEffectAt(live, live.ends)).toBe(false);
    // Offsets parse like Zulu: the same instant written for Eastern time.
    expect(alertInEffectAt(upcoming, "2026-07-16T03:00:00-04:00")).toBe(true);
  });

  it("never hides an alert over a timestamp it cannot read", function () {
    expect(alertInEffectAt(untimed, AT)).toBe(true);
    expect(alertInEffectAt({ event: "x", onset: "garbage", ends: "garbage" }, AT)).toBe(true);
    expect(alertInEffectAt(upcoming, null)).toBe(true);
    expect(alertInEffectAt(upcoming, "not a date")).toBe(true);
    expect(alertInEffectAt(null, AT)).toBe(false);
  });

  it("alertsInEffect returns deduped in-effect names in feed order", function () {
    expect(alertsInEffect([upcoming, live, ended, untimed, live], AT))
      .toEqual(["Gale Warning", "Rip Current Statement"]);
    expect(alertsInEffect([upcoming], AT)).toEqual([]);
    expect(alertsInEffect([upcoming, { onset: AT }, null, 4], null)).toEqual(["Beach Hazards Statement"]);
    expect(alertsInEffect(null, AT)).toEqual([]);
  });

  it("a future Beach Hazards Statement built through alertsInEffect cannot color the flag", function () {
    const details = [upcoming];
    const result = estimateFlag(baseInputs({
      alerts: alertsInEffect(details, AT),
      alertDetails: details,
      alertsAt: AT,
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("green");
    expect(result.trigger).toBe("wave-height");
    expect(result.alertDetails).toMatchObject([upcoming]);
    expect(result.alertsAt).toBe(AT);

    const later = "2026-07-16T08:00:00.000Z";
    const afterOnset = estimateFlag(baseInputs({
      alerts: alertsInEffect(details, later),
      alertDetails: details,
      alertsAt: later,
      waveHeightFt: 1.0
    }));
    expect(afterOnset.color).toBe("red");
    expect(afterOnset.trigger).toBe("nws-alert");
  });

  it("a future yellow-floor alert cannot floor a green either", function () {
    const details = [{ event: "Small Craft Advisory", onset: "2026-07-16T07:00:00.000Z", ends: null }];
    const result = estimateFlag(baseInputs({
      alerts: alertsInEffect(details, AT),
      alertDetails: details,
      alertsAt: AT,
      waveHeightFt: 1.0
    }));
    expect(result.color).toBe("green");
  });

  it("echoes alertsAt as null when absent or not a string", function () {
    expect(estimateFlag(baseInputs({})).alertsAt).toBe(null);
    expect(estimateFlag(baseInputs({ alertsAt: 12 })).alertsAt).toBe(null);
    expect(estimateFlag(baseInputs({ alertsAt: "" })).alertsAt).toBe(null);
  });

  it("decidedAlertDetails is the in-effect subset at alertsAt, everything for a legacy payload", function () {
    const all = [upcoming, live, ended, untimed];
    expect(decidedAlertDetails({ alertDetails: all, alertsAt: AT })).toEqual([live, untimed]);
    expect(decidedAlertDetails({ alertDetails: all })).toEqual(all);
    expect(decidedAlertDetails({ alertDetails: all, alertsAt: null })).toEqual(all);
    expect(decidedAlertDetails({ alertDetails: "nope", alertsAt: AT })).toEqual([]);
    expect(decidedAlertDetails(null)).toEqual([]);
  });
});

describe("estimateFlag - LOW rip risk never decides a color", function () {
  it("LOW alone -> unknown, no-data, LOW still echoed", function () {
    const result = estimateFlag(baseInputs({ ripCurrentRisk: "LOW" }));
    expect(result.color).toBe("unknown");
    expect(result.trigger).toBe("no-data");
    expect(result.reason).toBe("No wave or weather data is available for this beach yet");
    expect(result.ripCurrentRisk).toBe("LOW");
  });

  it("LOW + alerts [] -> unknown (an empty alert list is still not usable)", function () {
    const result = estimateFlag(baseInputs({ ripCurrentRisk: "LOW", alerts: [] }));
    expect(result.color).toBe("unknown");
    expect(result.trigger).toBe("no-data");
  });

  it("LOW + alertsCheckable false -> unknown with the caveat appended", function () {
    const result = estimateFlag(baseInputs({ ripCurrentRisk: "LOW", alertsCheckable: false }));
    expect(result.color).toBe("unknown");
    expect(result.trigger).toBe("no-data");
    expect(result.reason).toBe(
      "No wave or weather data is available for this beach yet (" + ALERTS_UNAVAILABLE_CAVEAT + ")"
    );
  });

  it("LOW + a wave reading -> the wave rule decides, with the wave reason", function () {
    const result = estimateFlag(baseInputs({ ripCurrentRisk: "LOW", waveHeightFt: 1.0 }));
    expect(result.color).toBe("green");
    expect(result.trigger).toBe("wave-height");
    expect(result.reason).toBe("Estimated wave height 1.0 ft (below 2 ft)");
    const ocean = estimateFlag(baseInputs({ ripCurrentRisk: "LOW", waveHeightFt: 1.99, waterClass: "ocean" }));
    expect(ocean.color).toBe("green");
    expect(ocean.trigger).toBe("wave-height");
  });

  it("LOW + wind -> the wind fallback decides, with the wind reason", function () {
    const result = estimateFlag(baseInputs({ ripCurrentRisk: "LOW", windSpeedMph: 10 }));
    expect(result.color).toBe("green");
    expect(result.trigger).toBe("wind");
    expect(result.reason).toBe(
      "No wave data; wind 10 mph sustained, n/a mph gusts (below advisory thresholds)"
    );
  });

  it("LOW alone is still floorable: Small Craft Advisory -> yellow nws-floor", function () {
    const result = estimateFlag(baseInputs({ ripCurrentRisk: "LOW", alerts: ["Small Craft Advisory"] }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("nws-floor");
    expect(result.reason).toBe("Active NWS alert: Small Craft Advisory");
  });

  it("LOW alone + strong wind warning -> yellow eccc-floor", function () {
    const result = estimateFlag(baseInputs({ ripCurrentRisk: "LOW", alerts: ["strong wind warning"] }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("eccc-floor");
  });

  it("LOW alone + a yellow water-quality advisory -> yellow wq-floor", function () {
    const result = estimateFlag(baseInputs({
      ripCurrentRisk: "LOW",
      waterQualityAdvisory: { color: "yellow", reason: "E. coli exceedance", source: "Test Health Dept" }
    }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("wq-floor");
  });

  it("LOW + a non-finite wave reading -> unknown", function () {
    const result = estimateFlag(baseInputs({ ripCurrentRisk: "LOW", waveHeightFt: NaN }));
    expect(result.color).toBe("unknown");
    expect(result.trigger).toBe("no-data");
    expect(result.waveHeightFt).toBeNull();
  });

  it("no LOW case ever yields the retired rip-current-low trigger", function () {
    const cases = [
      baseInputs({ ripCurrentRisk: "LOW" }),
      baseInputs({ ripCurrentRisk: "LOW", alerts: [] }),
      baseInputs({ ripCurrentRisk: "LOW", alertsCheckable: false }),
      baseInputs({ ripCurrentRisk: "LOW", waveHeightFt: 1.0 }),
      baseInputs({ ripCurrentRisk: "LOW", windSpeedMph: 10 }),
      baseInputs({ ripCurrentRisk: "LOW", alerts: ["Small Craft Advisory"] }),
      baseInputs({ ripCurrentRisk: "LOW", waveHeightFt: NaN })
    ];
    for (let i = 0; i < cases.length; i++) {
      const result = estimateFlag(cases[i]);
      expect(result.trigger).not.toBe("rip-current-low");
      expect(result.color).not.toBe(null);
    }
  });
});

describe("estimateFlag - ECCC proper-noun wind warnings (Les Su\u00eates, Wreckhouse)", function () {
  const feature = JSON.parse(
    readFileSync(new URL("./fixtures/eccc-les-suetes-wind-warning-2026-10-13.json", import.meta.url), "utf8")
  );
  // The raw feed name, before the client's lowercase fold, so rules.js is
  // exercised on its own fold.
  const entry = {
    event: feature.properties.alert_name_en,
    onset: feature.properties.validity_datetime,
    ends: feature.properties.event_end_datetime,
    description: feature.properties.alert_text_en,
    area: feature.properties.feature_name_en,
    sender: null
  };

  it("the live GeoMet feature carries the proper noun capitalized, NFC", function () {
    expect(entry.event).toBe("Les Su\u00eates wind warning");
    expect(entry.event.charCodeAt(6)).toBe(0x00ea);
    expect(entry.onset).toBe("2026-10-14T18:00:00.000Z");
    expect(entry.ends).toBe("2026-10-15T01:00:00.000Z");
  });

  it("raw-case Les Su\u00eates wind warning -> red eccc-alert with the lowercase reason", function () {
    const result = estimateFlag(baseInputs({ alerts: [entry.event] }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("eccc-alert");
    expect(result.reason).toBe("Active Environment Canada alert: les su\u00eates wind warning");
  });

  it("Wreckhouse wind warning -> red in either case (feed string unverified until a product is live)", function () {
    expect(estimateFlag(baseInputs({ alerts: ["wreckhouse wind warning"] })).color).toBe("red");
    const raw = estimateFlag(baseInputs({ alerts: ["Wreckhouse wind warning"] }));
    expect(raw.color).toBe("red");
    expect(raw.trigger).toBe("eccc-alert");
    expect(raw.reason).toBe("Active Environment Canada alert: wreckhouse wind warning");
  });

  it("beats a calm wave reading, loses to a co-active double-red", function () {
    const overWaves = estimateFlag(baseInputs({ alerts: [entry.event], waveHeightFt: 1.0 }));
    expect(overWaves.color).toBe("red");
    expect(overWaves.trigger).toBe("eccc-alert");
    const surge = estimateFlag(baseInputs({ alerts: [entry.event, "storm surge warning"] }));
    expect(surge.color).toBe("double-red");
    expect(surge.reason).toBe("Active Environment Canada alert: storm surge warning");
  });

  it("the fixture entry decides nothing before its onset and red after it", function () {
    const before = "2026-10-13T12:00:00.000Z";
    const details = [entry];
    const early = estimateFlag(baseInputs({
      alerts: alertsInEffect(details, before),
      alertDetails: details,
      alertsAt: before,
      waveHeightFt: 1.0
    }));
    expect(alertsInEffect(details, before)).toEqual([]);
    expect(early.color).toBe("green");
    expect(early.trigger).toBe("wave-height");
    expect(early.alertDetails[0].event).toBe(entry.event);

    const after = "2026-10-14T19:00:00.000Z";
    expect(alertsInEffect(details, after)).toEqual([entry.event]);
    const live = estimateFlag(baseInputs({
      alerts: alertsInEffect(details, after),
      alertDetails: details,
      alertsAt: after,
      waveHeightFt: 1.0
    }));
    expect(live.color).toBe("red");
    expect(live.trigger).toBe("eccc-alert");
  });

  it("the ECCC floor folds case too", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Strong Wind Warning"], waveHeightFt: 1.0 }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("eccc-floor");
    expect(result.reason).toBe("Active Environment Canada alert: strong wind warning");
  });

  it("NWS steps still match exactly: a lowercase NWS-only name decides nothing", function () {
    const result = estimateFlag(baseInputs({ alerts: ["high surf warning"], waveHeightFt: 1.0 }));
    expect(result.color).toBe("green");
    expect(result.trigger).toBe("wave-height");
  });

  it("non-string alert entries do not throw and the string beside them still decides", function () {
    const result = estimateFlag(baseInputs({ alerts: [null, 42, undefined, "wind warning"] }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("eccc-alert");
    expect(estimateFlag(baseInputs({ alerts: [null, 42] })).color).toBe("unknown");
  });
});

describe("estimateFlag - Hazardous Seas Warning and Brisk Wind Advisory", function () {
  const types = JSON.parse(
    readFileSync(new URL("./fixtures/nws-alert-types-2026-10-13.json", import.meta.url), "utf8")
  );

  it("every mapped NWS name is a real api.weather.gov event type", function () {
    expect(Array.isArray(types.eventTypes)).toBe(true);
    ALERT_PRECEDENCE.concat(NWS_FLOOR_PRECEDENCE).forEach(function (e) {
      expect(types.eventTypes).toContain(e);
    });
  });

  it("Hazardous Seas Warning -> red nws-alert", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Hazardous Seas Warning"] }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.reason).toBe("Active NWS alert: Hazardous Seas Warning");
  });

  it("Hazardous Seas Warning beats calm waves and is shadowed by a co-active Storm Warning", function () {
    const overWaves = estimateFlag(baseInputs({ alerts: ["Hazardous Seas Warning"], waveHeightFt: 1.0 }));
    expect(overWaves.color).toBe("red");
    expect(overWaves.trigger).toBe("nws-alert");
    const storm = estimateFlag(baseInputs({ alerts: ["Hazardous Seas Warning", "Storm Warning"] }));
    expect(storm.color).toBe("double-red");
    expect(storm.reason).toBe("Active NWS alert: Storm Warning");
  });

  it("Hazardous Seas Warning sits directly after Gale Warning, in the red block", function () {
    const gale = ALERT_PRECEDENCE.indexOf("Gale Warning");
    expect(ALERT_PRECEDENCE[gale + 1]).toBe("Hazardous Seas Warning");
    expect(ALERT_PRECEDENCE.indexOf("Brisk Wind Advisory")).toBe(-1);
  });

  it("Brisk Wind Advisory sits directly after Small Craft Advisory in the floor list", function () {
    const sca = NWS_FLOOR_PRECEDENCE.indexOf("Small Craft Advisory");
    expect(NWS_FLOOR_PRECEDENCE[sca + 1]).toBe("Brisk Wind Advisory");
    expect(NWS_FLOOR_PRECEDENCE.indexOf("Hazardous Seas Warning")).toBe(-1);
  });

  it("Brisk Wind Advisory raises a wave green to yellow", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Brisk Wind Advisory"], waveHeightFt: 1.0 }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("nws-floor");
    expect(result.reason).toBe("Active NWS alert: Brisk Wind Advisory");
  });

  it("Brisk Wind Advisory raises an unknown to yellow", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Brisk Wind Advisory"] }));
    expect(result.color).toBe("yellow");
    expect(result.trigger).toBe("nws-floor");
  });

  it("Brisk Wind Advisory never downgrades a wave red or a rip red", function () {
    const wave = estimateFlag(baseInputs({ alerts: ["Brisk Wind Advisory"], waveHeightFt: 5.0 }));
    expect(wave.color).toBe("red");
    expect(wave.trigger).toBe("wave-height");
    const rip = estimateFlag(baseInputs({ alerts: ["Brisk Wind Advisory"], ripCurrentRisk: "HIGH" }));
    expect(rip.color).toBe("red");
    expect(rip.trigger).toBe("rip-current");
  });

  it("Brisk Wind Advisory loses outright to a co-active Gale Warning", function () {
    const result = estimateFlag(baseInputs({ alerts: ["Brisk Wind Advisory", "Gale Warning"] }));
    expect(result.color).toBe("red");
    expect(result.trigger).toBe("nws-alert");
    expect(result.reason).toBe("Active NWS alert: Gale Warning");
  });
});

describe("estimateFlag - non-finite waveHeightFt is treated as null", function () {
  const garbage = [NaN, Infinity, -Infinity, "3", "", {}, [], true];

  it("decides nothing, echoes null and never throws", function () {
    for (let i = 0; i < garbage.length; i++) {
      let result = null;
      expect(function () {
        result = estimateFlag(baseInputs({ waveHeightFt: garbage[i] }));
      }).not.toThrow();
      expect(result.color).toBe("unknown");
      expect(result.trigger).toBe("no-data");
      expect(result.reason).toBe("No wave or weather data is available for this beach yet");
      expect(result.waveHeightFt).toBeNull();
    }
  });

  it("leaves the wind fallback open: NaN + 30 mph -> red, NaN + 10 mph -> green", function () {
    const red = estimateFlag(baseInputs({ waveHeightFt: NaN, windSpeedMph: 30 }));
    expect(red.color).toBe("red");
    expect(red.trigger).toBe("wind");
    expect(red.reason).toBe(
      "No wave data; wind 30 mph sustained, n/a mph gusts (at or above 25 mph sustained or 35 mph gust threshold)"
    );
    const green = estimateFlag(baseInputs({ waveHeightFt: NaN, windSpeedMph: 10 }));
    expect(green.color).toBe("green");
    expect(green.trigger).toBe("wind");
  });

  it("is still floorable: Infinity + Small Craft Advisory -> yellow, Infinity + wq advisory -> yellow", function () {
    const nws = estimateFlag(baseInputs({ waveHeightFt: Infinity, alerts: ["Small Craft Advisory"] }));
    expect(nws.color).toBe("yellow");
    expect(nws.trigger).toBe("nws-floor");
    const wq = estimateFlag(baseInputs({
      waveHeightFt: Infinity,
      waterQualityAdvisory: { color: "yellow", reason: "E. coli exceedance", source: "Test Health Dept" }
    }));
    expect(wq.color).toBe("yellow");
    expect(wq.trigger).toBe("wq-floor");
  });

  it("a finite zero is still a reading", function () {
    const result = estimateFlag(baseInputs({ waveHeightFt: 0 }));
    expect(result.color).toBe("green");
    expect(result.trigger).toBe("wave-height");
    expect(result.reason).toBe("Estimated wave height 0.0 ft (below 2 ft)");
    expect(result.waveHeightFt).toBe(0);
  });
});
