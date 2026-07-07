// test/scraperHealth.test.js
import { describe, it, expect } from "vitest";
import {
  updateScraperHealth,
  SCRAPER_HEALTH_ALERT_THRESHOLD
} from "../src/scraperHealth.js";

const NOW = "2026-07-05T12:00:00.000Z";
const EARLIER = "2026-07-04T12:00:00.000Z";

describe("updateScraperHealth", function() {
  it("exposes a threshold of 24", function() {
    expect(SCRAPER_HEALTH_ALERT_THRESHOLD).toBe(24);
  });

  it("resets consecutiveNulls and stamps lastSuccess on success", function() {
    const prev = { consecutiveNulls: 5, lastSuccess: EARLIER, lastFailure: EARLIER };
    const out = updateScraperHealth("south-haven-mi", prev, true, NOW);
    expect(out.next.consecutiveNulls).toBe(0);
    expect(out.next.lastSuccess).toBe(NOW);
    expect(out.next.lastFailure).toBe(EARLIER);
    expect(out.alert).toBe(null);
  });

  it("increments consecutiveNulls and stamps lastFailure on failure", function() {
    const prev = { consecutiveNulls: 3, lastSuccess: EARLIER, lastFailure: EARLIER };
    const out = updateScraperHealth("south-haven-mi", prev, false, NOW);
    expect(out.next.consecutiveNulls).toBe(4);
    expect(out.next.lastSuccess).toBe(EARLIER);
    expect(out.next.lastFailure).toBe(NOW);
    expect(out.alert).toBe(null);
  });

  it("treats null prior state as a first failure", function() {
    const out = updateScraperHealth("south-haven-mi", null, false, NOW);
    expect(out.next.consecutiveNulls).toBe(1);
    expect(out.next.lastSuccess).toBe(null);
    expect(out.next.lastFailure).toBe(NOW);
    expect(out.alert).toBe(null);
  });

  it("treats missing/undefined prior state as a first failure", function() {
    const out = updateScraperHealth("south-haven-mi", undefined, false, NOW);
    expect(out.next.consecutiveNulls).toBe(1);
    expect(out.next.lastSuccess).toBe(null);
    expect(out.next.lastFailure).toBe(NOW);
    expect(out.alert).toBe(null);
  });

  it("treats null prior state as a first success", function() {
    const out = updateScraperHealth("south-haven-mi", null, true, NOW);
    expect(out.next.consecutiveNulls).toBe(0);
    expect(out.next.lastSuccess).toBe(NOW);
    expect(out.next.lastFailure).toBe(null);
    expect(out.alert).toBe(null);
  });

  it("does NOT alert at 23 consecutive nulls (below threshold)", function() {
    const prev = { consecutiveNulls: 22, lastSuccess: EARLIER, lastFailure: EARLIER };
    const out = updateScraperHealth("south-haven-mi", prev, false, NOW);
    expect(out.next.consecutiveNulls).toBe(23);
    expect(out.alert).toBe(null);
  });

  it("alerts exactly at 24 consecutive nulls (threshold boundary)", function() {
    const prev = { consecutiveNulls: 23, lastSuccess: EARLIER, lastFailure: EARLIER };
    const out = updateScraperHealth("south-haven-mi", prev, false, NOW);
    expect(out.next.consecutiveNulls).toBe(24);
    expect(out.alert).toBe(
      "ALERT: official scraper south-haven-mi has returned null for 24 " +
      "consecutive hourly runs (last success " + EARLIER + ")"
    );
  });

  it("continues alerting beyond the threshold", function() {
    const prev = { consecutiveNulls: 30, lastSuccess: EARLIER, lastFailure: EARLIER };
    const out = updateScraperHealth("south-haven-mi", prev, false, NOW);
    expect(out.next.consecutiveNulls).toBe(31);
    expect(out.alert).toBe(
      "ALERT: official scraper south-haven-mi has returned null for 31 " +
      "consecutive hourly runs (last success " + EARLIER + ")"
    );
  });

  it("reports 'never' when the scraper has never succeeded", function() {
    const prev = { consecutiveNulls: 23, lastSuccess: null, lastFailure: EARLIER };
    const out = updateScraperHealth("south-haven-mi", prev, false, NOW);
    expect(out.alert).toBe(
      "ALERT: official scraper south-haven-mi has returned null for 24 " +
      "consecutive hourly runs (last success never)"
    );
  });
});
