// test/torontoBeachObs.test.js
// Pure-parser + resolver tests for the Toronto Beaches Observations supplemental
// wave source. No network: every CKAN response is built inline. Project style:
// ES modules, NO template literals (string concat with +), function () {}
// callbacks, one describe per exported pure function.

import { describe, it, expect } from "vitest";
import { makeBeach } from "./helpers/beach.js";
import {
  normalizeWaveAction,
  waveActionToFt,
  extractRecords,
  isInSeason,
  resolveSite,
  latestRowForBeach,
  parseTorontoWaveFt,
  matches,
  torontoBeachObsSource,
  torontoWaveSource,
  TORONTO_MODEL,
  TORONTO_SITES,
  WAVE_ACTION_FT
} from "../src/waveSources/torontoBeachObs.js";

const NOW = "2026-07-22T12:00:00Z";

// Build a single CKAN datastore record.
function rec(id, date, beachName, waveAction) {
  return {
    _id: id,
    dataCollectionDate: date,
    beachName: beachName,
    waveAction: waveAction,
    windSpeed: 15,
    windDirection: "SE"
  };
}

// Wrap records in the CKAN datastore_search envelope.
function ckan(records) {
  return {
    help: "https://example/help",
    success: true,
    result: {
      resource_id: "b1b87de1-e021-43c2-a80e-69028fe9fafa",
      records: records,
      fields: [],
      total: records.length
    }
  };
}

// A beach positioned at the curated Woodbine Beaches centroid (proximity gate).
function woodbineBeach() {
  return makeBeach({ id: "osm-woodbine", name: null, park_name: null, lat: 43.663, lon: -79.305 });
}

describe("normalizeWaveAction", function () {
  it("maps the known categories (case/space-insensitive)", function () {
    expect(normalizeWaveAction("HIGH")).toBe("HIGH");
    expect(normalizeWaveAction("high")).toBe("HIGH");
    expect(normalizeWaveAction("MOD")).toBe("MOD");
    expect(normalizeWaveAction("Moderate")).toBe("MOD");
    expect(normalizeWaveAction("LOW")).toBe("LOW");
    expect(normalizeWaveAction("None")).toBe("NONE");
    expect(normalizeWaveAction("  NONE  ")).toBe("NONE");
  });

  it("degrades any unrecognized or non-string token to null", function () {
    expect(normalizeWaveAction("Murky")).toBe(null);
    expect(normalizeWaveAction("")).toBe(null);
    expect(normalizeWaveAction(null)).toBe(null);
    expect(normalizeWaveAction(undefined)).toBe(null);
    expect(normalizeWaveAction(3)).toBe(null);
  });
});

describe("waveActionToFt", function () {
  it("HIGH lands in the red band (>=4 ft)", function () {
    const ft = waveActionToFt("HIGH");
    expect(ft).toBe(WAVE_ACTION_FT.HIGH);
    expect(ft).toBeGreaterThanOrEqual(4);
  });

  it("MOD lands in the yellow band (>=2 and <4 ft)", function () {
    const ft = waveActionToFt("MOD");
    expect(ft).toBeGreaterThanOrEqual(2);
    expect(ft).toBeLessThan(4);
  });

  it("LOW and NONE land in the green band (<2 ft)", function () {
    expect(waveActionToFt("LOW")).toBeLessThan(2);
    expect(waveActionToFt("None")).toBeLessThan(2);
  });

  it("returns null for an unrecognized category", function () {
    expect(waveActionToFt("Murky")).toBe(null);
    expect(waveActionToFt(null)).toBe(null);
  });
});

describe("extractRecords", function () {
  it("returns the records array for a well-formed response", function () {
    const json = ckan([rec(1, "2026-07-22", "Woodbine Beaches", "HIGH")]);
    const records = extractRecords(json);
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBe(1);
  });

  it("degrades to null on any unexpected shape", function () {
    expect(extractRecords(null)).toBe(null);
    expect(extractRecords({})).toBe(null);
    expect(extractRecords({ success: false, result: { records: [] } })).toBe(null);
    expect(extractRecords({ result: null })).toBe(null);
    expect(extractRecords({ result: { records: "nope" } })).toBe(null);
  });
});

describe("isInSeason", function () {
  it("is out of season before mid-May and after mid-September", function () {
    expect(isInSeason("2026-05-14T12:00:00Z")).toBe(false);
    expect(isInSeason("2026-09-16T12:00:00Z")).toBe(false);
    expect(isInSeason("2026-01-10T12:00:00Z")).toBe(false);
    expect(isInSeason("2026-11-01T12:00:00Z")).toBe(false);
  });

  it("is in season from mid-May through mid-September", function () {
    expect(isInSeason("2026-05-15T00:00:00Z")).toBe(true);
    expect(isInSeason("2026-07-22T12:00:00Z")).toBe(true);
    expect(isInSeason("2026-09-15T23:00:00Z")).toBe(true);
  });

  it("fails closed (false) on an invalid nowIso", function () {
    expect(isInSeason("")).toBe(false);
    expect(isInSeason(null)).toBe(false);
    expect(isInSeason("not-a-date")).toBe(false);
  });
});

describe("resolveSite", function () {
  it("resolves a Toronto beach by proximity when no name is present", function () {
    const site = resolveSite(woodbineBeach());
    expect(site).not.toBe(null);
    expect(site.beachName).toBe("Woodbine Beaches");
  });

  it("resolves by name substring (names win over proximity)", function () {
    const beach = makeBeach({ name: "Sunnyside Beach", lat: 0, lon: 0 });
    const site = resolveSite(beach);
    expect(site).not.toBe(null);
    expect(site.beachName).toBe("Sunnyside Beach");
  });

  it("returns null for a non-Toronto beach", function () {
    const chicago = makeBeach({ name: "Oak Street Beach", lat: 41.905, lon: -87.623 });
    expect(resolveSite(chicago)).toBe(null);
  });

  it("returns null for a null beach", function () {
    expect(resolveSite(null)).toBe(null);
  });
});

describe("latestRowForBeach", function () {
  it("picks the freshest row by date, not by record order/_id", function () {
    const records = [
      rec(5, "2026-07-21", "Woodbine Beaches", "MOD"),
      rec(9, "2026-07-22", "Woodbine Beaches", "HIGH"),
      rec(7, "2026-07-20", "Woodbine Beaches", "NONE")
    ];
    const row = latestRowForBeach(records, "Woodbine Beaches", NOW);
    expect(row).not.toBe(null);
    expect(row.dataCollectionDate).toBe("2026-07-22");
    expect(row.waveAction).toBe("HIGH");
  });

  it("ignores rows for other beaches", function () {
    const records = [
      rec(9, "2026-07-22", "Sunnyside Beach", "HIGH"),
      rec(8, "2026-07-21", "Woodbine Beaches", "MOD")
    ];
    const row = latestRowForBeach(records, "Woodbine Beaches", NOW);
    expect(row.dataCollectionDate).toBe("2026-07-21");
    expect(row.waveAction).toBe("MOD");
  });

  it("rejects a row dated in the future", function () {
    const records = [rec(9, "2026-07-23", "Woodbine Beaches", "HIGH")];
    expect(latestRowForBeach(records, "Woodbine Beaches", NOW)).toBe(null);
  });

  it("rejects a stale row older than the freshness window", function () {
    const records = [rec(9, "2026-07-19", "Woodbine Beaches", "HIGH")];
    expect(latestRowForBeach(records, "Woodbine Beaches", NOW)).toBe(null);
  });

  it("returns null when no row matches or input is malformed", function () {
    expect(latestRowForBeach([], "Woodbine Beaches", NOW)).toBe(null);
    expect(latestRowForBeach(null, "Woodbine Beaches", NOW)).toBe(null);
    expect(latestRowForBeach([rec(1, "2026-07-22", "Woodbine Beaches", "HIGH")], "Woodbine Beaches", "bad")).toBe(null);
  });
});

describe("parseTorontoWaveFt", function () {
  it("maps a fresh HIGH observation to the red band", function () {
    const json = ckan([rec(1, "2026-07-22", "Woodbine Beaches", "HIGH")]);
    const ft = parseTorontoWaveFt(json, woodbineBeach(), NOW);
    expect(ft).toBe(WAVE_ACTION_FT.HIGH);
    expect(ft).toBeGreaterThanOrEqual(4);
  });

  it("maps a fresh MOD observation to the yellow band", function () {
    const json = ckan([rec(1, "2026-07-22", "Woodbine Beaches", "MOD")]);
    const ft = parseTorontoWaveFt(json, woodbineBeach(), NOW);
    expect(ft).toBeGreaterThanOrEqual(2);
    expect(ft).toBeLessThan(4);
  });

  it("maps a fresh NONE observation to the green band", function () {
    const json = ckan([rec(1, "2026-07-22", "Woodbine Beaches", "None")]);
    const ft = parseTorontoWaveFt(json, woodbineBeach(), NOW);
    expect(ft).toBeLessThan(2);
  });

  it("returns null (never a wrong height) for an unrecognized waveAction", function () {
    const json = ckan([rec(1, "2026-07-22", "Woodbine Beaches", "Murky")]);
    expect(parseTorontoWaveFt(json, woodbineBeach(), NOW)).toBe(null);
  });

  it("returns null when the freshest row is stale", function () {
    const json = ckan([rec(1, "2026-07-18", "Woodbine Beaches", "HIGH")]);
    expect(parseTorontoWaveFt(json, woodbineBeach(), NOW)).toBe(null);
  });

  it("returns null for a beach that resolves to no curated site", function () {
    const chicago = makeBeach({ name: "Oak Street Beach", lat: 41.905, lon: -87.623 });
    const json = ckan([rec(1, "2026-07-22", "Woodbine Beaches", "HIGH")]);
    expect(parseTorontoWaveFt(json, chicago, NOW)).toBe(null);
  });

  it("returns null on a malformed response", function () {
    expect(parseTorontoWaveFt(null, woodbineBeach(), NOW)).toBe(null);
    expect(parseTorontoWaveFt({ success: false }, woodbineBeach(), NOW)).toBe(null);
  });
});

describe("matches", function () {
  it("is true for a Toronto beach and false for a non-Toronto beach", function () {
    expect(matches(woodbineBeach())).toBe(true);
    expect(matches(makeBeach({ name: "Oak Street Beach", lat: 41.905, lon: -87.623 }))).toBe(false);
  });
});

describe("torontoBeachObsSource object", function () {
  it("exposes the locked supplemental wave-source contract shape", function () {
    expect(torontoBeachObsSource.id).toBe("toronto-beach-obs");
    expect(torontoBeachObsSource.model).toBe(TORONTO_MODEL);
    expect(typeof torontoBeachObsSource.label).toBe("string");
    expect(typeof torontoBeachObsSource.url).toBe("string");
    expect(typeof torontoBeachObsSource.matches).toBe("function");
    expect(typeof torontoBeachObsSource.waveFt).toBe("function");
  });

  it("is re-exported under the torontoWaveSource alias", function () {
    expect(torontoWaveSource).toBe(torontoBeachObsSource);
  });

  it("curates exactly the 10 Lake Ontario beaches", function () {
    expect(TORONTO_SITES.length).toBe(10);
  });
});
