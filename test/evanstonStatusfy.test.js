// test/evanstonStatusfy.test.js
// Pure-parser unit tests for the Evanston Statusfy water-quality floor source.
// No network: fixtures are built inline. Project style — ES modules, NO
// template literals (string concat with +), function () {} callbacks.
//
// The safety-critical property under test: a status-3 "Closed" floors to RED
// ONLY when the reason names a whitelisted surf hazard; the nightly after-hours
// operational closure, an Open page, an unknown status, and unparseable markup
// ALL degrade to null (no floor), never a wrong color.

import { describe, it, expect } from "vitest";
import {
  parseStatusfyPage,
  parseStatusfyStatus,
  isEvanstonHazardReason,
  normalizeStatusfyTimestamp,
  evanstonStatusfy,
  EVANSTON_LABEL,
  EVANSTON_SITE_DEFS
} from "../src/wqFloor/evanstonStatusfy.js";
import { scrapeWqFloorFromResult } from "../src/wqFloor/index.js";

const NOW_ISO = "2026-07-22T15:00:00.000Z";

// Build a Statusfy-shaped page. code: numeric status code; word: visible status
// text; reason: free-text following the status; timestamp: optional
// data-timestamp value. Mirrors the documented markup
// (<strong class="status-N">Word</strong> + reason + data-timestamp).
function statusfyPage(opts) {
  const parts = [];
  parts.push("<html><body><div class=\"beach\">");
  if (opts.timestamp !== undefined) {
    parts.push("<span class=\"stamp\" data-timestamp=\"" + opts.timestamp + "\">Updated</span>");
  }
  parts.push("<strong class=\"status status-" + String(opts.code) + "\">" + opts.word + "</strong>");
  parts.push("<p class=\"reason\">" + opts.reason + "</p>");
  parts.push("</div></body></html>");
  return parts.join("");
}

describe("isEvanstonHazardReason", function () {
  it("matches every whitelisted hazard phrase (case-insensitive)", function () {
    expect(isEvanstonHazardReason("A Beach Hazard Statement is in effect")).toBe(true);
    expect(isEvanstonHazardReason("Dangerous swimming conditions")).toBe(true);
    expect(isEvanstonHazardReason("High waves expected today")).toBe(true);
    expect(isEvanstonHazardReason("HIGH SURF advisory")).toBe(true);
    expect(isEvanstonHazardReason("Rip Current risk is elevated")).toBe(true);
    expect(isEvanstonHazardReason("Swim ban in effect")).toBe(true);
  });

  it("does NOT match an after-hours operational closure", function () {
    const reason = "The water is closed to swimming outside of posted swimming " +
      "hours. The water will reopen when lifeguards go on duty at 10:30 AM tomorrow.";
    expect(isEvanstonHazardReason(reason)).toBe(false);
  });

  it("returns false for non-string / empty input", function () {
    expect(isEvanstonHazardReason(null)).toBe(false);
    expect(isEvanstonHazardReason("")).toBe(false);
    expect(isEvanstonHazardReason(undefined)).toBe(false);
  });
});

describe("parseStatusfyStatus", function () {
  it("extracts the code, word, reason, and data-timestamp", function () {
    const html = statusfyPage({
      code: 3,
      word: "Closed",
      reason: "Beach Hazard Statement in effect",
      timestamp: "1721660400"
    });
    const result = parseStatusfyStatus(html);
    expect(result).not.toBe(null);
    expect(result.code).toBe(3);
    expect(result.word).toBe("closed");
    expect(result.reason).toContain("Beach Hazard Statement");
    expect(result.rawTimestamp).toBe("1721660400");
  });

  it("scopes the reason to text AFTER the status element", function () {
    // A hazard phrase sitting BEFORE the status element must not leak in.
    const html = "<div>Beach Hazard Statement legend text</div>" +
      "<strong class=\"status-3\">Closed</strong>" +
      "<p>closed outside of posted swimming hours</p>";
    const result = parseStatusfyStatus(html);
    expect(result.reason).toBe("closed outside of posted swimming hours");
  });

  it("returns null when no status element is present", function () {
    expect(parseStatusfyStatus("<html><body>no status here</body></html>")).toBe(null);
    expect(parseStatusfyStatus("")).toBe(null);
    expect(parseStatusfyStatus(null)).toBe(null);
  });
});

describe("parseStatusfyPage", function () {
  it("floors to red on a status-3 Closed with a hazard reason", function () {
    const html = statusfyPage({
      code: 3,
      word: "Closed",
      reason: "Beach Hazard Statement: dangerous swimming conditions."
    });
    const floor = parseStatusfyPage(html, NOW_ISO);
    expect(floor).not.toBe(null);
    expect(floor.floorColor).toBe("red");
    expect(floor.reason).toContain("City of Evanston beach closure:");
    expect(floor.reason).toContain("Beach Hazard Statement");
  });

  it("returns null for an after-hours operational closure (never false-reds)", function () {
    const html = statusfyPage({
      code: 3,
      word: "Closed",
      reason: "The water is closed to swimming outside of posted swimming hours. " +
        "The water will reopen when lifeguards go on duty at 10:30 AM tomorrow."
    });
    expect(parseStatusfyPage(html, NOW_ISO)).toBe(null);
  });

  it("returns null for an Open (status-1) page", function () {
    const html = statusfyPage({ code: 1, word: "Open", reason: "Lifeguards on duty" });
    expect(parseStatusfyPage(html, NOW_ISO)).toBe(null);
  });

  it("returns null for an unknown status code even with a hazard word", function () {
    const html = statusfyPage({ code: 2, word: "Caution", reason: "rip current risk" });
    expect(parseStatusfyPage(html, NOW_ISO)).toBe(null);
  });

  it("returns null when the code says closed but the word contradicts it", function () {
    const html = statusfyPage({ code: 3, word: "Open", reason: "rip current risk" });
    expect(parseStatusfyPage(html, NOW_ISO)).toBe(null);
  });

  it("returns null on null / empty / garbage input", function () {
    expect(parseStatusfyPage(null, NOW_ISO)).toBe(null);
    expect(parseStatusfyPage("", NOW_ISO)).toBe(null);
    expect(parseStatusfyPage("<<< not the expected format >>>", NOW_ISO)).toBe(null);
  });

  it("stamps updated from a parseable data-timestamp", function () {
    const html = statusfyPage({
      code: 3,
      word: "Closed",
      reason: "high waves and dangerous conditions",
      timestamp: "2026-07-22T14:00:00Z"
    });
    const floor = parseStatusfyPage(html, NOW_ISO);
    expect(floor.updated).toBe("2026-07-22T14:00:00.000Z");
  });

  it("omits updated when the timestamp is unparseable", function () {
    const html = statusfyPage({
      code: 3,
      word: "Closed",
      reason: "swim ban due to high surf",
      timestamp: "not-a-date"
    });
    const floor = parseStatusfyPage(html, NOW_ISO);
    expect(floor.updated).toBeUndefined();
  });
});

describe("normalizeStatusfyTimestamp", function () {
  it("parses epoch seconds", function () {
    expect(normalizeStatusfyTimestamp("1721660400")).toBe("2024-07-22T15:00:00.000Z");
  });

  it("parses epoch milliseconds", function () {
    expect(normalizeStatusfyTimestamp("1721660400000")).toBe("2024-07-22T15:00:00.000Z");
  });

  it("parses an ISO date string", function () {
    expect(normalizeStatusfyTimestamp("2026-07-22T14:00:00Z")).toBe("2026-07-22T14:00:00.000Z");
  });

  it("returns null for garbage / empty / non-string", function () {
    expect(normalizeStatusfyTimestamp("not-a-date")).toBe(null);
    expect(normalizeStatusfyTimestamp("")).toBe(null);
    expect(normalizeStatusfyTimestamp(null)).toBe(null);
  });
});

describe("evanstonStatusfy source object", function () {
  it("carries the locked contract fields", function () {
    expect(evanstonStatusfy.id).toBe("evanston-statusfy");
    expect(evanstonStatusfy.label).toBe(EVANSTON_LABEL);
    expect(typeof evanstonStatusfy.matches).toBe("function");
    expect(typeof evanstonStatusfy.scrape).toBe("function");
    expect(EVANSTON_SITE_DEFS.length).toBe(6);
  });

  it("matches Evanston beaches by name and by bbox, rejects others", function () {
    expect(evanstonStatusfy.matches({ name: "Lighthouse Beach", park_name: "Evanston Lakefront", lat: 0, lon: 0 })).toBe(true);
    expect(evanstonStatusfy.matches({ name: "Clark Street Beach", lat: 42.0578, lon: -87.6721 })).toBe(true);
    expect(evanstonStatusfy.matches({ name: "Oak Street Beach", lat: 41.9026, lon: -87.6226 })).toBe(false);
  });
});

describe("integration with the wqFloor resolver", function () {
  it("a parsed hazard closure resolves to a red advisory for the matched beach", function () {
    const def = EVANSTON_SITE_DEFS[0]; // Lighthouse
    const html = statusfyPage({
      code: 3,
      word: "Closed",
      reason: "Beach Hazard Statement: dangerous high waves."
    });
    const floor = parseStatusfyPage(html, NOW_ISO);
    const site = {
      siteId: def.siteId,
      floorColor: floor.floorColor,
      reason: floor.reason,
      names: def.names,
      lat: def.lat,
      lon: def.lon,
      radiusMi: def.radiusMi
    };
    const result = {
      perBeach: true,
      sites: [site],
      source: EVANSTON_LABEL,
      sources: [EVANSTON_LABEL],
      updated: NOW_ISO
    };
    const beach = { id: "osm-node-evanston-1", name: "Lighthouse Beach", park_name: "", lat: def.lat, lon: def.lon };
    const advisory = scrapeWqFloorFromResult(beach, evanstonStatusfy, result);
    expect(advisory).not.toBe(null);
    expect(advisory.color).toBe("red");
    expect(advisory.beachId).toBe("osm-node-evanston-1");
    expect(advisory.source).toBe(EVANSTON_LABEL);
    expect(advisory.reason).toContain("Beach Hazard Statement");
  });

  it("a clean run (no sites) resolves to null — no floor, no masking", function () {
    const result = {
      perBeach: true,
      sites: [],
      source: EVANSTON_LABEL,
      sources: [EVANSTON_LABEL],
      updated: NOW_ISO
    };
    const beach = { id: "osm-node-evanston-1", name: "Lighthouse Beach", park_name: "", lat: 42.0611, lon: -87.6741 };
    expect(scrapeWqFloorFromResult(beach, evanstonStatusfy, result)).toBe(null);
  });
});
