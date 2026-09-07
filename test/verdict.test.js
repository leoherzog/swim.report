// test/verdict.test.js
// The pure hero-verdict sentence (src/frontend/verdict.js): one branch per
// rules.js trigger, the official-display branch, and the honest fallbacks for
// unknown, absent and legacy estimates.

import { describe, it, expect } from "vitest";
import { verdictSentence } from "../src/frontend/verdict.js";
import { ALERTS_UNAVAILABLE_CAVEAT } from "../src/rules.js";

// A full estimate payload in the shape rules.js returns.
function estimateWith(extra) {
  return Object.assign(
    {
      beachId: "osm-way-505668572",
      color: "green",
      reason: "Estimated wave height 1.2 ft (below 2 ft)",
      trigger: "wave-height",
      rules_version: "1.7.0",
      official: false,
      sources: [],
      updated: "2026-07-05T11:30:00.000Z",
      waveHeightFt: 1.2,
      alertDetails: [],
      ripCurrentRisk: null,
      // The seal the hourly cron writes beside every estimate; alertsResolved
      // true is what lets the sentence claim the alert check came back clear.
      estimateInputs: {
        v: 1,
        alertsResolved: true,
        windSpeedMph: null,
        windGustMph: null,
        waterQualityAdvisory: null,
        signalSources: []
      }
    },
    extra
  );
}

function alert(event) {
  return { event: event, onset: null, ends: null };
}

describe("verdictSentence: no estimate to explain", function () {
  it("answers honestly with no estimate at all", function () {
    expect(verdictSentence(null, null, false, null)).toBe("No data yet for this beach.");
  });

  it("answers honestly for an unknown estimate", function () {
    const estimate = estimateWith({
      color: "unknown",
      trigger: "no-data",
      reason: "No wave or weather data is available for this beach yet",
      waveHeightFt: null
    });
    expect(verdictSentence(estimate, null, false, null)).toBe("No data yet for this beach.");
  });

  it("renders nothing for a legacy payload with no trigger or echoed signals", function () {
    const legacy = {
      color: "green",
      reason: "Estimated wave height 1.2 ft",
      updated: "2026-07-05T11:30:00.000Z"
    };
    expect(verdictSentence(legacy, null, false, null)).toBe("");
  });
});

describe("verdictSentence: wave height", function () {
  it("calls a below-threshold reading calm and confirms the clear alert check", function () {
    expect(verdictSentence(estimateWith({}), null, false, null))
      .toBe("Calm water, no alerts.");
  });

  it("names the band from the default thresholds", function () {
    const estimate = estimateWith({
      color: "yellow",
      waveHeightFt: 2.6,
      reason: "Estimated wave height 2.6 ft (at or above 2 ft)"
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Waves 2 to 4 ft, no alerts.");
  });

  it("uses the ocean thresholds for an ocean beach", function () {
    const estimate = estimateWith({
      color: "yellow",
      waveHeightFt: 4.1,
      reason: "Estimated wave height 4.1 ft (at or above 3 ft)"
    });
    expect(verdictSentence(estimate, null, false, "ocean"))
      .toBe("Waves 3 to 6 ft, no alerts.");
  });

  it("stays silent about alerts when the estimate could not check them", function () {
    const estimate = estimateWith({
      color: "red",
      waveHeightFt: 5.4,
      reason: "Estimated wave height 5.4 ft (at or above 4 ft) (" + ALERTS_UNAVAILABLE_CAVEAT + ")"
    });
    expect(verdictSentence(estimate, null, false, null)).toBe("Waves 4 ft or more.");
  });

  it("stays silent about alerts when the national fetch never resolved", function () {
    const estimate = estimateWith({
      estimateInputs: {
        v: 1,
        alertsResolved: false,
        windSpeedMph: null,
        windGustMph: null,
        waterQualityAdvisory: null,
        signalSources: []
      }
    });
    expect(verdictSentence(estimate, null, false, null)).toBe("Calm water.");
  });

  it("stays silent about alerts for an estimate written before the seal", function () {
    const estimate = estimateWith({ estimateInputs: undefined });
    expect(verdictSentence(estimate, null, false, null)).toBe("Calm water.");
  });

  it("falls back to the wave clause for an unrecognized trigger", function () {
    expect(verdictSentence(estimateWith({ trigger: "some-future-step" }), null, false, null))
      .toBe("Calm water, no alerts.");
  });
});

describe("verdictSentence: rip current and wind", function () {
  it("leads with a high rip risk", function () {
    const estimate = estimateWith({
      color: "red",
      trigger: "rip-current",
      reason: "NWS surf zone forecast rip current risk: HIGH",
      waveHeightFt: null,
      ripCurrentRisk: "HIGH"
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("High rip current risk, no alerts.");
  });

  it("adds the wave band after the rip risk that decided the color", function () {
    const estimate = estimateWith({
      color: "yellow",
      trigger: "rip-current",
      reason: "NWS surf zone forecast rip current risk: MODERATE",
      waveHeightFt: 2.6,
      ripCurrentRisk: "MODERATE"
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Moderate rip current risk, waves 2 to 4 ft, no alerts.");
  });

  it("adds a rip risk after the wave band when waves decided", function () {
    const estimate = estimateWith({
      color: "yellow",
      waveHeightFt: 2.6,
      reason: "Estimated wave height 2.6 ft (at or above 2 ft)",
      ripCurrentRisk: "MODERATE"
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Waves 2 to 4 ft, moderate rip current risk, no alerts.");
  });

  it("leads with a low rip risk when it is the terminal fallback", function () {
    const estimate = estimateWith({
      trigger: "rip-current-low",
      reason: "NWS surf zone forecast rip current risk: LOW; no wave or wind data available",
      waveHeightFt: null,
      ripCurrentRisk: "LOW"
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Low rip current risk, no alerts.");
  });

  it("says so when wind is the only signal", function () {
    const estimate = estimateWith({
      color: "yellow",
      trigger: "wind",
      reason: "No wave data; wind 18 mph sustained, n/a mph gusts (at or above 15 mph sustained or 25 mph gust threshold)",
      waveHeightFt: null
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("No wave data, so this estimate is from wind alone, no alerts.");
  });
});

describe("verdictSentence: alerts and floors", function () {
  it("leads with one NWS alert and follows it with the rip risk", function () {
    const estimate = estimateWith({
      color: "red",
      trigger: "nws-alert",
      reason: "Active NWS alert: Beach Hazards Statement",
      waveHeightFt: null,
      alertDetails: [alert("Beach Hazards Statement")],
      ripCurrentRisk: "HIGH"
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Beach Hazards Statement in effect; high rip current risk.");
  });

  it("names the alert ALERT_PRECEDENCE chose, not the first one the feed sent", function () {
    const estimate = estimateWith({
      color: "double-red",
      trigger: "nws-alert",
      reason: "Active NWS alert: Tsunami Warning",
      waveHeightFt: null,
      alertDetails: [
        alert("Rip Current Statement"),
        alert("Small Craft Advisory"),
        alert("Tsunami Warning")
      ]
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Tsunami Warning and 2 more alerts in effect; stay out of the water.");
  });

  it("orders two alerts by precedence rather than feed order", function () {
    const estimate = estimateWith({
      color: "red",
      trigger: "nws-alert",
      reason: "Active NWS alert: Beach Hazards Statement",
      waveHeightFt: null,
      alertDetails: [alert("Small Craft Advisory"), alert("Beach Hazards Statement")]
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Beach Hazards Statement and Small Craft Advisory in effect.");
  });

  it("keeps an unrecognized event last, in feed order", function () {
    const estimate = estimateWith({
      color: "red",
      trigger: "nws-alert",
      reason: "Active NWS alert: Gale Warning",
      waveHeightFt: null,
      alertDetails: [alert("Dense Fog Advisory"), alert("Gale Warning")]
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Gale Warning and Dense Fog Advisory in effect.");
  });

  it("joins two ECCC alerts in their own precedence order", function () {
    const estimate = estimateWith({
      color: "red",
      trigger: "eccc-alert",
      reason: "Active Environment Canada alert: severe thunderstorm warning",
      waveHeightFt: null,
      alertDetails: [alert("wind warning"), alert("severe thunderstorm warning")]
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Severe thunderstorm warning and wind warning in effect.");
  });

  it("counts the remainder past two alerts and dedupes repeats", function () {
    const estimate = estimateWith({
      color: "double-red",
      trigger: "nws-alert",
      reason: "Active NWS alert: High Surf Warning",
      waveHeightFt: null,
      alertDetails: [
        alert("Beach Hazards Statement"),
        alert("High Surf Warning"),
        alert("Rip Current Statement"),
        alert("High Surf Warning")
      ]
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("High Surf Warning and 2 more alerts in effect; stay out of the water.");
  });

  it("names the alert behind an NWS yellow floor", function () {
    const estimate = estimateWith({
      color: "yellow",
      trigger: "nws-floor",
      reason: "Active NWS alert: Small Craft Advisory",
      alertDetails: [alert("Small Craft Advisory")]
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Small Craft Advisory in effect; calm water.");
  });

  it("names the alert behind an ECCC yellow floor", function () {
    const estimate = estimateWith({
      color: "yellow",
      trigger: "eccc-floor",
      reason: "Active Environment Canada alert: marine weather advisory",
      waveHeightFt: null,
      alertDetails: [alert("marine weather advisory")]
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Marine weather advisory in effect.");
  });

  it("degrades to a generic alert clause when a legacy payload echoed none", function () {
    const legacy = {
      color: "red",
      trigger: "nws-alert",
      reason: "Active NWS alert: Beach Hazards Statement",
      updated: "2026-07-05T11:30:00.000Z"
    };
    expect(verdictSentence(legacy, null, false, null)).toBe("A weather alert is in effect.");
  });

  it("names the water-quality advisory floor", function () {
    const estimate = estimateWith({
      color: "red",
      trigger: "wq-floor",
      reason: "Water-quality advisory (mn-beaches): E. coli advisory",
      waveHeightFt: null
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("A water-quality advisory covers this beach.");
  });

  it("says a yellow advisory once, with the alert behind it", function () {
    const estimate = estimateWith({
      color: "yellow",
      trigger: "wq-floor",
      reason: "Water-quality advisory (mn-beaches): swimming not advised",
      alertDetails: [alert("Small Craft Advisory")]
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("A water-quality advisory covers this beach; Small Craft Advisory in effect, calm water.");
  });

  it("closes an estimated double red with the swim instruction", function () {
    const estimate = estimateWith({
      color: "double-red",
      trigger: "nws-alert",
      reason: "Active NWS alert: Tsunami Warning",
      waveHeightFt: null,
      alertDetails: [alert("Tsunami Warning")]
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Tsunami Warning in effect; stay out of the water.");
  });
});

// The wave grids model wind waves only, so a sub-threshold height beside a
// tsunami, hurricane or surge warning is the ordinary case, not an edge.
describe("verdictSentence: an alert-decided red keeps only what reinforces it", function () {
  it("drops a sub-threshold wave height from a double red", function () {
    const estimate = estimateWith({
      color: "double-red",
      trigger: "nws-alert",
      reason: "Active NWS alert: Tsunami Warning",
      waveHeightFt: 1.2,
      alertDetails: [alert("Tsunami Warning")]
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Tsunami Warning in effect; stay out of the water.");
  });

  it("drops a low rip risk and calm water from a double red", function () {
    const estimate = estimateWith({
      color: "double-red",
      trigger: "nws-alert",
      reason: "Active NWS alert: Hurricane Warning",
      waveHeightFt: 0.4,
      ripCurrentRisk: "LOW",
      alertDetails: [alert("Hurricane Warning")]
    });
    expect(verdictSentence(estimate, null, false, "ocean"))
      .toBe("Hurricane Warning in effect; stay out of the water.");
  });

  it("drops a yellow wave band and a moderate rip risk from an alert-decided red", function () {
    const estimate = estimateWith({
      color: "red",
      trigger: "nws-alert",
      reason: "Active NWS alert: Tropical Storm Warning",
      waveHeightFt: 2.6,
      ripCurrentRisk: "MODERATE",
      alertDetails: [alert("Tropical Storm Warning")]
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Tropical Storm Warning in effect.");
  });

  it("keeps a wave band that reaches the same red", function () {
    const estimate = estimateWith({
      color: "red",
      trigger: "nws-alert",
      reason: "Active NWS alert: Tropical Storm Warning",
      waveHeightFt: 5.4,
      alertDetails: [alert("Tropical Storm Warning")]
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Tropical Storm Warning in effect; waves 4 ft or more.");
  });

  it("keeps every signal under an alert-decided yellow", function () {
    const estimate = estimateWith({
      color: "yellow",
      trigger: "nws-floor",
      reason: "Active NWS alert: Small Craft Advisory",
      ripCurrentRisk: "MODERATE",
      alertDetails: [alert("Small Craft Advisory")]
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Small Craft Advisory in effect; moderate rip current risk, calm water.");
  });

  it("keeps a low rip risk under a red the waves decided", function () {
    const estimate = estimateWith({
      color: "red",
      waveHeightFt: 5.4,
      reason: "Estimated wave height 5.4 ft (at or above 4 ft)",
      ripCurrentRisk: "LOW"
    });
    expect(verdictSentence(estimate, null, false, null))
      .toBe("Waves 4 ft or more, low rip current risk, no alerts.");
  });
});

describe("verdictSentence: the posted flag", function () {
  it("credits the posted flag for each color it displays", function () {
    expect(verdictSentence(estimateWith({}), { color: "green" }, true, null))
      .toBe("A green flag is posted at the beach.");
    expect(verdictSentence(estimateWith({}), { color: "yellow" }, true, null))
      .toBe("A yellow flag is posted at the beach.");
    expect(verdictSentence(estimateWith({}), { color: "red" }, true, null))
      .toBe("A red flag is posted at the beach.");
  });

  it("says the water is closed for a posted double red", function () {
    expect(verdictSentence(estimateWith({}), { color: "double-red" }, true, null))
      .toBe("Water closed by the posted flag.");
  });

  it("stays honest for an official record with an unusable color", function () {
    expect(verdictSentence(estimateWith({}), { color: "chartreuse" }, true, null))
      .toBe("No data yet for this beach.");
  });

  it("explains the estimate when the official record did not decide the display", function () {
    expect(verdictSentence(estimateWith({}), { color: "green" }, false, null))
      .toBe("Calm water, no alerts.");
  });
});
