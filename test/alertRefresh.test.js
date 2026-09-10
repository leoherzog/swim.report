// runAlertRefresh, the level-triggered alerts cron, driven through the scheduled
// handler.
//
// The regression this file exists for: a fast recompute must never lower a flag
// by LOSING a non-alert input. Every "lowering a flag" case below seeds a beach
// whose standing color came from an alert, clears that alert in the feed, and
// asserts the recomputed color still carries the rip-current risk, the wave
// height, the wind fallback or the water-quality advisory the estimate was
// originally decided from — all of which come back from the estimateInputs seal
// inside the same estimate blob, never from a second record and never from a
// refetch.
import { describe, it, expect, vi, afterEach } from "vitest";
import { estimateFlag, alertsInEffect } from "../src/rules.js";
import { buildEstimateInputs, sealFromSignals } from "../src/flagInputs.js";
import { runScheduledCron } from "./helpers/cron.js";
import { makeD1 } from "./helpers/d1.js";

const NOW = "2026-07-15T16:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const FLAG_TTL = 25200;

// The Great Lakes box both ECCC fixtures use; the Canadian beach below sits
// inside it and the US beaches sit outside every ECCC branch by authority, not
// by geometry.
const CA_POLYGON = {
  type: "Polygon",
  coordinates: [[[-84, 44], [-82, 44], [-82, 46], [-84, 46], [-84, 44]]]
};
// A narrower marine zone inside the land box. ecccMarineAlertsForPoint matches
// within 15 km of an edge, so a Canadian beach meant NOT to match a marine
// warning has to sit well outside this, not merely outside the ring.
const CA_MARINE_POLYGON = {
  type: "Polygon",
  coordinates: [[[-83.5, 44.8], [-82, 44.8], [-82, 46], [-83.5, 46], [-83.5, 44.8]]]
};

function beachRow(overrides) {
  const row = {
    id: "osm-node-us",
    name: "Test Beach",
    park_name: null,
    lat: 44.8,
    lon: -83.3,
    nws_zone: "MIZ071",
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

// A standing estimate exactly as runFlagRecompute writes it: estimateFlag
// over the same bundle, with the seal spread on afterwards. Built through the
// real functions so these fixtures cannot drift from what the hourly stores.
// alertEvents entries are event names (in effect since 06:00, open-ended) or
// whole { event, onset, ends } details. The alert half is built the way
// buildAlertInputs builds it: alerts is the in-effect subset at updatedIso and
// alertsAt is that instant. legacy true builds the pre-onset-rule shape instead,
// every name in alerts and no alertsAt.
function standingFlag(beach, alertEvents, signalOverrides, updatedIso, legacy) {
  let alertPart = { alerts: null, alertDetails: null, alertSources: [], alertsResolved: false, alertsAt: null };
  if (alertEvents !== null) {
    const details = alertEvents.map(function (e) {
      return typeof e === "string" ? { event: e, onset: "2026-07-15T06:00:00.000Z", ends: null } : e;
    });
    alertPart = {
      alerts: legacy ? details.map(function (d) { return d.event; }) : alertsInEffect(details, updatedIso),
      alertDetails: details,
      alertSources: [{ label: "NWS Alerts", url: "https://api.weather.gov/alerts/active?zone=MIZ071" }],
      alertsResolved: true,
      alertsAt: legacy ? null : updatedIso
    };
  }
  const signals = {
    alertsResolved: alertPart.alertsResolved,
    ripCurrentRisk: null,
    waveHeightFt: null,
    windSpeedMph: null,
    windGustMph: null,
    waterQualityAdvisory: null,
    signalSources: [],
    updated: updatedIso
  };
  const extra = signalOverrides || {};
  for (const key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) {
      signals[key] = extra[key];
    }
  }
  const estimate = estimateFlag(buildEstimateInputs(beach, alertPart, signals));
  return Object.assign({}, estimate, { estimateInputs: sealFromSignals(signals, alertPart) });
}

// Real in-memory SQLite with migrations/ applied. standings maps a beach id to
// the estimate the hourly left behind, seeded into beach_state the way the hourly
// writes it: the blob, its color, the instant it was decided at (both the CAS
// token and the stale-lower rail's clock) and an absolute expiry a full lease
// past that instant. leases overrides estimate_expires per beach, for the cases
// that turn on the remaining lease rather than on the alert set.
//
// This cron reads and writes D1 only, so the env carries no KV binding at all.
function makeEnv(rows, standings, leases) {
  const db = makeD1({ beaches: rows });
  const seeded = new Map();
  const byLease = leases || {};
  for (const id of Object.keys(standings || {})) {
    const standing = standings[id];
    const blob = JSON.stringify(standing);
    const updated = standing.updated;
    const expires = Object.prototype.hasOwnProperty.call(byLease, id)
      ? byLease[id]
      : Math.floor(Date.parse(updated) / 1000) + FLAG_TTL;
    db.seedState(id, {
      estimate: blob,
      estimate_color: standing.color,
      estimate_updated: updated,
      estimate_expires: Number.isFinite(expires) ? expires : null
    });
    seeded.set(id, blob);
  }
  return { env: { DB: db }, db: db, seeded: seeded };
}

// The estimate blob as it stands now, parsed, or null when the beach has no row.
function storedEstimate(made, id) {
  const row = made.db.stateOf(id);
  return row && row.estimate ? JSON.parse(row.estimate) : null;
}

// True when this run rewrote the beach: the CAS touches the blob and its color
// and nothing else, so a byte-identical blob means the beach was skipped.
function rewrote(made, id) {
  const row = made.db.stateOf(id);
  const blob = row ? row.estimate : null;
  return blob !== null && blob !== made.seeded.get(id);
}

function runAlertCron(env) {
  return runScheduledCron(env, "3-53/10 * * * *");
}

function okJson(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve(body); }
  });
}

function nwsFeature(event, zones, period) {
  const p = period || {};
  return {
    properties: {
      event: event,
      onset: p.onset === undefined ? "2026-07-15T15:30:00.000Z" : p.onset,
      ends: p.ends === undefined ? "2026-07-16T02:00:00.000Z" : p.ends,
      geocode: { UGC: zones },
      affectedZones: []
    }
  };
}

function minutesAhead(n) {
  return new Date(NOW_MS + n * 60000).toISOString();
}

function ecccFeature(name) {
  return {
    properties: {
      alert_name_en: name,
      status_en: "active",
      validity_datetime: "2026-07-15T14:00:00.000Z",
      expiration_datetime: "2026-07-16T14:00:00.000Z"
    },
    geometry: CA_POLYGON
  };
}

function ecccMarineFeature(name) {
  return {
    properties: {
      area: { region: { en: "Great Lakes" }, value: { en: "Lake Huron" } },
      lastUpdated: "2026-07-15T14:00:00.000Z",
      warnings: {
        locations: [{
          name: { en: "Lake Huron" },
          events: [{
            name: { en: name },
            type: { en: "warning" },
            category: { en: "marine" },
            status: { en: "IN EFFECT" }
          }]
        }]
      }
    },
    geometry: CA_MARINE_POLYGON
  };
}

// The count endpoint URL is a prefix extension of the alerts one, so it must be
// matched first. Anything unrecognized rejects, as the rest of the suite does.
function stubFetch(opts) {
  const o = opts || {};
  vi.stubGlobal("fetch", function (url) {
    const target = typeof url === "string" ? url : (url && url.url) || "";
    if (target.indexOf("alerts/active/count") !== -1) {
      if (o.countFail) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      const total = o.countTotal === undefined ? (o.features || []).length : o.countTotal;
      return okJson({ total: total });
    }
    if (target.indexOf("alerts/active") !== -1) {
      if (o.nwsFail) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      const body = { features: o.features || [] };
      if (o.pagination) {
        body.pagination = { next: "https://api.weather.gov/alerts/active?cursor=2" };
      }
      return okJson(body);
    }
    if (target.indexOf("weather-alerts") !== -1) {
      if (o.ecccFail) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return okJson({ features: o.ecccFeatures || [] });
    }
    if (target.indexOf("marineweather-realtime") !== -1) {
      if (o.ecccMarineFail) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return okJson({ features: o.ecccMarineFeatures || [] });
    }
    return Promise.reject(new Error("network disabled in test"));
  });
}

function freezeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
}

function minutesAgo(n) {
  return new Date(NOW_MS - n * 60000).toISOString();
}

function writtenFlag(made, id) {
  return rewrote(made, id) ? storedEstimate(made, id) : null;
}

afterEach(function () {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runAlertRefresh selection (level trigger)", function () {
  it("raises only the beaches carrying the zone that gained an alert", async function () {
    freezeClock();
    const inZone = beachRow({ id: "osm-node-a", nws_zone: "MIZ071" });
    const otherZone = beachRow({ id: "osm-node-b", nws_zone: "MIZ049" });
    const marineOnly = beachRow({ id: "osm-node-c", nws_zone: null, marine_zone: "LHZ441" });
    const made = makeEnv([inZone, otherZone, marineOnly], {
      "osm-node-a": standingFlag(inZone, [], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "osm-node-b": standingFlag(otherZone, [], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "osm-node-c": standingFlag(marineOnly, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(writtenFlag(made, "osm-node-a").color).toBe("double-red");
    expect(rewrote(made, "osm-node-b")).toBe(false);
    expect(rewrote(made, "osm-node-c")).toBe(false);
  });

  it("matches a marine_zone from the same national feed", async function () {
    freezeClock();
    const marineOnly = beachRow({ id: "osm-node-c", nws_zone: null, marine_zone: "LHZ441" });
    const made = makeEnv([marineOnly], {
      "osm-node-c": standingFlag(marineOnly, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [nwsFeature("Gale Warning", ["LHZ441"])] });
    await runAlertCron(made.env);

    expect(writtenFlag(made, "osm-node-c").color).toBe("red");
  });

  it("walks a beach back down when its standing alert is no longer in the feed", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(
        beach, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10)
      )
    });
    stubFetch({ features: [] });
    await runAlertCron(made.env);

    expect(writtenFlag(made, "osm-node-a").color).toBe("green");
  });

  it("selects a zone that swapped Small Craft Advisory for Gale Warning", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, ["Small Craft Advisory"], { waveHeightFt: 0.5 }, minutesAgo(10));
    expect(standing.color).toBe("yellow");
    const made = makeEnv([beach], { "osm-node-a": standing });
    stubFetch({ features: [nwsFeature("Gale Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(writtenFlag(made, "osm-node-a").color).toBe("red");
  });

  it("selects a zone that lost one of two alerts and kept the other", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(
        beach, ["Gale Warning", "Small Craft Advisory"], { waveHeightFt: 0.5 }, minutesAgo(10)
      )
    });
    stubFetch({ features: [nwsFeature("Gale Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    const written = writtenFlag(made, "osm-node-a");
    // The color did not move, but the payload's alert provenance did, which is
    // why the write is unconditional for a selected beach.
    expect(written.color).toBe("red");
    expect(written.alertDetails.map(function (d) { return d.event; })).toEqual(["Gale Warning"]);
  });

  it("does not select a beach whose current and standing event sets are equal", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(
        beach, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10)
      )
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(rewrote(made, "osm-node-a")).toBe(false);
  });

  it("does not raise on an alert published ahead of its onset", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [nwsFeature("Beach Hazards Statement", ["MIZ071"], { onset: minutesAhead(120) })] });
    await runAlertCron(made.env);

    // In effect now: nothing, on both sides. The statement is a forecast until
    // its onset, so the standing green stands.
    expect(rewrote(made, "osm-node-a")).toBe(false);
  });

  it("raises once the onset arrives, with no change to the feed itself", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const statement = { event: "Beach Hazards Statement", onset: minutesAgo(5), ends: minutesAhead(600) };
    // Decided ten minutes ago, when the statement was still five minutes out.
    const standing = standingFlag(beach, [statement], { waveHeightFt: 0.5 }, minutesAgo(10));
    expect(standing.color).toBe("green");
    expect(standing.alertDetails.length).toBe(1);
    const made = makeEnv([beach], { "osm-node-a": standing });
    stubFetch({ features: [nwsFeature("Beach Hazards Statement", ["MIZ071"], { onset: statement.onset, ends: statement.ends })] });
    await runAlertCron(made.env);

    const written = writtenFlag(made, "osm-node-a");
    expect(written.color).toBe("red");
    expect(written.alertsAt).toBe(NOW);
    // updated stays the standing instant: alertsAt is what records when the
    // alert set was judged, so the next run compares against the same set.
    expect(written.updated).toBe(minutesAgo(10));
  });

  it("does not re-select a beach the refresh already raised at its onset", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const statement = { event: "Beach Hazards Statement", onset: minutesAgo(15), ends: minutesAhead(600) };
    // What the previous refresh wrote: decided against the in-effect set at its
    // own clock (alertsAt), under the hourly's older updated.
    const previous = standingFlag(beach, [statement], { waveHeightFt: 0.5 }, minutesAgo(10));
    previous.alertsAt = minutesAgo(10);
    previous.updated = minutesAgo(40);
    previous.estimateInputs = Object.assign({}, previous.estimateInputs);
    expect(previous.color).toBe("red");
    const made = makeEnv([beach], { "osm-node-a": previous });
    stubFetch({ features: [nwsFeature("Beach Hazards Statement", ["MIZ071"], { onset: statement.onset, ends: statement.ends })] });
    await runAlertCron(made.env);

    expect(rewrote(made, "osm-node-a")).toBe(false);
  });

  it("walks a beach back down once its standing alert's ends has passed, feed unchanged", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const gale = { event: "Gale Warning", onset: minutesAgo(300), ends: minutesAgo(5) };
    const standing = standingFlag(beach, [gale], { waveHeightFt: 0.5 }, minutesAgo(10));
    expect(standing.color).toBe("red");
    const made = makeEnv([beach], { "osm-node-a": standing });
    // Still in the active feed: the product has not expired, only ended.
    stubFetch({ features: [nwsFeature("Gale Warning", ["MIZ071"], { onset: gale.onset, ends: gale.ends })] });
    await runAlertCron(made.env);

    expect(writtenFlag(made, "osm-node-a").color).toBe("green");
  });

  it("lowers a legacy payload that a not-yet-effective alert colored", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const statement = { event: "Beach Hazards Statement", onset: minutesAhead(120), ends: minutesAhead(600) };
    const legacy = standingFlag(beach, [statement], { waveHeightFt: 0.5 }, minutesAgo(10), true);
    expect(legacy.color).toBe("red");
    expect(legacy.alertsAt).toBeNull();
    const made = makeEnv([beach], { "osm-node-a": legacy });
    stubFetch({ features: [nwsFeature("Beach Hazards Statement", ["MIZ071"], { onset: statement.onset, ends: statement.ends })] });
    await runAlertCron(made.env);

    // The legacy value was decided against every echoed entry, the current
    // in-effect set is empty, so the beach is selected and walked down.
    const written = writtenFlag(made, "osm-node-a");
    expect(written.color).toBe("green");
    expect(written.alertDetails.map(function (d) { return d.event; })).toEqual(["Beach Hazards Statement"]);
  });

  it("selects a beach whose seal records a failed hourly alert fetch, even with both sets empty", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, null, { waveHeightFt: 0.5 }, minutesAgo(10));
    expect(standing.estimateInputs.alertsResolved).toBe(false);
    const made = makeEnv([beach], { "osm-node-a": standing });
    stubFetch({ features: [] });
    await runAlertCron(made.env);

    const written = writtenFlag(made, "osm-node-a");
    expect(written).not.toBeNull();
    expect(written.estimateInputs.alertsResolved).toBe(true);
  });

  it("raises a Canadian beach on a gained ECCC land warning", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-ca", nws_zone: null, eccc_zone: "Alpena", lat: 45.5, lon: -83 });
    const made = makeEnv([beach], {
      "osm-node-ca": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ ecccFeatures: [ecccFeature("wind warning")], ecccMarineFeatures: [] });
    await runAlertCron(made.env);

    expect(writtenFlag(made, "osm-node-ca").color).toBe("red");
  });

  it("restores the yellow floor a failed hourly alert fetch lost", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, null, { waveHeightFt: 0.5 }, minutesAgo(10));
    expect(standing.color).toBe("green");
    const made = makeEnv([beach], { "osm-node-a": standing });
    stubFetch({ features: [nwsFeature("Small Craft Advisory", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(writtenFlag(made, "osm-node-a").color).toBe("yellow");
  });
});

describe("runAlertRefresh guards leave the standing value untouched", function () {
  function guardCase(standings, leases) {
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], standings, leases);
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    return { made: made, beach: beach };
  }

  it("never visits a beach with no state row (the hourly publishes the first estimate)", async function () {
    freezeClock();
    const c = guardCase({});
    await runAlertCron(c.made.env);
    // The join drops it: there is no standing alert set to compare against.
    expect(c.made.db.stateOf("osm-node-a")).toBeNull();
    expect(c.made.db.batchCalls.length).toBe(0);
  });

  it("never visits a beach whose estimate has already expired", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    // Expiry is inclusive: a row expiring exactly now is already gone.
    const c = guardCase({ "osm-node-a": standing }, { "osm-node-a": Math.floor(NOW_MS / 1000) });
    await runAlertCron(c.made.env);
    expect(rewrote(c.made, "osm-node-a")).toBe(false);
  });

  it("skips a standing value with no seal", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    delete standing.estimateInputs;
    const c = guardCase({ "osm-node-a": standing });
    await runAlertCron(c.made.env);
    expect(rewrote(c.made, "osm-node-a")).toBe(false);
  });

  it("skips a standing value carrying another seal version", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    standing.estimateInputs.v = 2;
    const c = guardCase({ "osm-node-a": standing });
    await runAlertCron(c.made.env);
    expect(rewrote(c.made, "osm-node-a")).toBe(false);
  });

  it("skips a standing value with a missing or unparseable updated", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const lease = { "osm-node-a": Math.floor(NOW_MS / 1000) + FLAG_TTL };
    const missing = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    missing.updated = null;
    const a = guardCase({ "osm-node-a": missing }, lease);
    await runAlertCron(a.made.env);
    expect(rewrote(a.made, "osm-node-a")).toBe(false);

    const unparseable = standingFlag(beach, [], { waveHeightFt: 0.5 }, "not-a-timestamp");
    const b = guardCase({ "osm-node-a": unparseable }, lease);
    await runAlertCron(b.made.env);
    expect(rewrote(b.made, "osm-node-a")).toBe(false);
  });

  it("skips a state row whose estimate blob does not parse", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {});
    made.db.seedState("osm-node-a", {
      estimate: "not-json{{",
      estimate_color: "green",
      estimate_updated: minutesAgo(10),
      estimate_expires: Math.floor(NOW_MS / 1000) + FLAG_TTL
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);
    expect(made.db.stateOf("osm-node-a").estimate).toBe("not-json{{");
  });

  it("skips a standing value stamped in the future", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const c = guardCase({
      "osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(-10))
    });
    await runAlertCron(c.made.env);
    expect(rewrote(c.made, "osm-node-a")).toBe(false);
  });

  it("skips a standing value with under five minutes of lease left", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    // The lease comes off estimate_expires, and this cron never extends it, so a
    // beach inside the five-minute window belongs to the hourly.
    const c = guardCase(
      { "osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10)) },
      { "osm-node-a": Math.floor(NOW_MS / 1000) + 200 }
    );
    await runAlertCron(c.made.env);
    expect(rewrote(c.made, "osm-node-a")).toBe(false);
  });

  it("loses the compare-and-set to an hourly run that rewrote the beach mid-flight", async function () {
    freezeClock();
    const logs = [];
    vi.spyOn(console, "log").mockImplementation(function (line) { logs.push(line); });
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    // The hourly lands between this run's read and its write, moving the CAS
    // token. Its decision is the newer one, so this write must match no row.
    const realBatch = made.db.batch;
    made.db.batch = function (statements) {
      made.db.sqlite
        .prepare("UPDATE beach_state SET estimate_updated = ?1 WHERE beach_id = ?2")
        .run(NOW, "osm-node-a");
      return realBatch(statements);
    };
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(rewrote(made, "osm-node-a")).toBe(false);
    const line = logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
    expect(line.indexOf(" skipSuperseded=1 ")).toBeGreaterThan(-1);
    expect(line.indexOf(" written=0 ")).toBeGreaterThan(-1);
  });

  it("skips a beach enriched for neither authority", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a", nws_zone: null });
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);
    expect(rewrote(made, "osm-node-a")).toBe(false);
  });
});

describe("runAlertRefresh degraded feeds", function () {
  const caBeach = beachRow({ id: "osm-node-ca", nws_zone: null, eccc_zone: "Alpena", lat: 45.5, lon: -83 });

  it("writes no US beach when the national alerts fetch fails, and still raises Canada", async function () {
    freezeClock();
    const us = beachRow({ id: "osm-node-us" });
    const made = makeEnv([us, caBeach], {
      "osm-node-us": standingFlag(us, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "osm-node-ca": standingFlag(caBeach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ nwsFail: true, ecccMarineFeatures: [ecccMarineFeature("Storm Warning")] });
    await runAlertCron(made.env);

    expect(rewrote(made, "osm-node-us")).toBe(false);
    expect(writtenFlag(made, "osm-node-ca").color).toBe("double-red");
  });

  it("refuses a US lowering when the count endpoint is unavailable, but still raises", async function () {
    freezeClock();
    const logs = [];
    vi.spyOn(console, "log").mockImplementation(function (line) { logs.push(line); });
    const clearing = beachRow({ id: "osm-node-clear" });
    const gaining = beachRow({ id: "osm-node-gain", nws_zone: "MIZ049" });
    const made = makeEnv([clearing, gaining], {
      "osm-node-clear": standingFlag(clearing, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "osm-node-gain": standingFlag(gaining, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ countFail: true, features: [nwsFeature("High Surf Warning", ["MIZ049"])] });
    await runAlertCron(made.env);

    expect(rewrote(made, "osm-node-clear")).toBe(false);
    expect(writtenFlag(made, "osm-node-gain").color).toBe("double-red");
    const line = logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
    expect(line.indexOf(" feed=unverified ")).toBeGreaterThan(-1);
    expect(line.indexOf(" skipFeedLower=1 ")).toBeGreaterThan(-1);
  });

  it("refuses a US lowering when the parse comes back short of the count total", async function () {
    freezeClock();
    const clearing = beachRow({ id: "osm-node-clear" });
    const made = makeEnv([clearing], {
      "osm-node-clear": standingFlag(clearing, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [], countTotal: 183 });
    await runAlertCron(made.env);

    expect(rewrote(made, "osm-node-clear")).toBe(false);
  });

  it("refuses a US lowering when the whole feed arrived but nothing in it parsed", async function () {
    freezeClock();
    const logs = [];
    vi.spyOn(console, "log").mockImplementation(function (line) { logs.push(line); });
    const clearing = beachRow({ id: "osm-node-clear" });
    const gaining = beachRow({ id: "osm-node-gain", nws_zone: "MIZ049" });
    const made = makeEnv([clearing, gaining], {
      "osm-node-clear": standingFlag(clearing, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "osm-node-gain": standingFlag(gaining, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    // Schema drift: every feature arrives and the count endpoint agrees, but the
    // per-feature shape no longer carries an event name, so the parse yields one
    // usable alert out of twelve. The count cross-check alone cannot see this.
    const drifted = [];
    for (let i = 0; i < 11; i = i + 1) {
      drifted.push({ properties: { geocode: { UGC: ["MIZ071"] }, affectedZones: [] } });
    }
    drifted.push(nwsFeature("High Surf Warning", ["MIZ049"]));
    stubFetch({ features: drifted, countTotal: 12 });
    await runAlertCron(made.env);

    expect(rewrote(made, "osm-node-clear")).toBe(false);
    expect(writtenFlag(made, "osm-node-gain").color).toBe("double-red");
    const line = logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
    expect(line.indexOf(" feed=unverified ")).toBeGreaterThan(-1);
    expect(line.indexOf(" features=12 ")).toBeGreaterThan(-1);
    expect(line.indexOf(" parsed=1 ")).toBeGreaterThan(-1);
  });

  it("applies the clear when the feature count and the total agree", async function () {
    freezeClock();
    const clearing = beachRow({ id: "osm-node-clear" });
    const made = makeEnv([clearing], {
      "osm-node-clear": standingFlag(clearing, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    // One feature in the feed, for another zone, and the total agrees.
    stubFetch({ features: [nwsFeature("Gale Warning", ["LMZ221"])], countTotal: 1 });
    await runAlertCron(made.env);

    expect(writtenFlag(made, "osm-node-clear").color).toBe("green");
  });

  it("refuses a lowering from a paginated feed even when the counts agree", async function () {
    freezeClock();
    const clearing = beachRow({ id: "osm-node-clear" });
    const made = makeEnv([clearing], {
      "osm-node-clear": standingFlag(clearing, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [], countTotal: 0, pagination: true });
    await runAlertCron(made.env);

    expect(rewrote(made, "osm-node-clear")).toBe(false);
  });

  it("writes no Canadian beach when only the marine collection failed", async function () {
    freezeClock();
    const us = beachRow({ id: "osm-node-us" });
    const made = makeEnv([us, caBeach], {
      "osm-node-us": standingFlag(us, [], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "osm-node-ca": standingFlag(caBeach, ["gale warning"], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({
      features: [nwsFeature("High Surf Warning", ["MIZ071"])],
      ecccFeatures: [],
      ecccMarineFail: true
    });
    await runAlertCron(made.env);

    // Without both collections a live "gale warning" red would recompute to a
    // wave-height green every ten minutes.
    expect(rewrote(made, "osm-node-ca")).toBe(false);
    expect(writtenFlag(made, "osm-node-us").color).toBe("double-red");
  });
});

describe("runAlertRefresh cannot lower a flag by losing a non-alert input", function () {
  // Each case: standing double-red from a High Surf Warning, that warning gone
  // from the feed, and one sealed non-alert input that must survive the
  // recompute. A lost input would land "green" (or "unknown") in every one.
  function clearedWarning(signalOverrides) {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, ["High Surf Warning"], signalOverrides, minutesAgo(10));
    expect(standing.color).toBe("double-red");
    const made = makeEnv([beach], { "osm-node-a": standing });
    stubFetch({ features: [] });
    return made;
  }

  it("keeps a sealed water-quality advisory (the wqfloor: key's 7200 s TTL cannot)", async function () {
    const made = clearedWarning({
      waterQualityAdvisory: { color: "red", reason: "E. coli exceedance", source: "County Health" },
      ripCurrentRisk: null,
      waveHeightFt: 0.5,
      windSpeedMph: 3
    });
    await runAlertCron(made.env);
    expect(writtenFlag(made, "osm-node-a").color).toBe("red");
  });

  it("keeps a HIGH rip-current risk", async function () {
    const made = clearedWarning({ ripCurrentRisk: "HIGH", waveHeightFt: 0.5, windSpeedMph: 3 });
    await runAlertCron(made.env);
    expect(writtenFlag(made, "osm-node-a").color).toBe("red");
  });

  it("keeps a 4.5 ft wave reading rather than falling through to the wind branch", async function () {
    const made = clearedWarning({ waveHeightFt: 4.5, windSpeedMph: 3 });
    await runAlertCron(made.env);
    const written = writtenFlag(made, "osm-node-a");
    expect(written.color).toBe("red");
    expect(written.trigger).toBe("wave-height");
  });

  it("keeps a 40 mph wind fallback rather than dropping to unknown", async function () {
    const made = clearedWarning({ waveHeightFt: null, windSpeedMph: 40 });
    await runAlertCron(made.env);
    const written = writtenFlag(made, "osm-node-a");
    expect(written.color).toBe("red");
    expect(written.trigger).toBe("wind");
  });

  it("carries the sealed non-alert source entries into the republished payload", async function () {
    const made = clearedWarning({
      waveHeightFt: 4.5,
      signalSources: [{ label: "NOAA GFS Wave Model", url: "https://polar.ncep.noaa.gov/waves/" }]
    });
    await runAlertCron(made.env);
    expect(writtenFlag(made, "osm-node-a").sources.map(function (s) { return s.label; }))
      .toEqual(["NWS Alerts", "NOAA GFS Wave Model"]);
  });
});

describe("runAlertRefresh lowering rails", function () {
  it("never lowers a Canadian beach, and still raises one", async function () {
    freezeClock();
    const logs = [];
    vi.spyOn(console, "log").mockImplementation(function (line) { logs.push(line); });
    // ca1 sits well clear of the marine zone, so its standing gale warning is a
    // pure clear-down; ca2 sits inside it and gains the storm warning.
    const clearing = beachRow({ id: "osm-node-ca1", nws_zone: null, eccc_zone: "Alpena", lat: 44.2, lon: -83.6 });
    const gaining = beachRow({ id: "osm-node-ca2", nws_zone: null, eccc_zone: "Alpena", lat: 45.5, lon: -83 });
    const made = makeEnv([clearing, gaining], {
      "osm-node-ca1": standingFlag(clearing, ["gale warning"], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "osm-node-ca2": standingFlag(gaining, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ ecccFeatures: [], ecccMarineFeatures: [ecccMarineFeature("Storm Warning")] });
    await runAlertCron(made.env);

    // ca1's standing gale warning is gone; ca2 gains the marine storm warning.
    expect(rewrote(made, "osm-node-ca1")).toBe(false);
    expect(writtenFlag(made, "osm-node-ca2").color).toBe("double-red");
    const line = logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
    expect(line.indexOf(" skipCanadaLower=1 ")).toBeGreaterThan(-1);
  });

  it("refuses a lowering decided by inputs older than the renderer's stale horizon", async function () {
    freezeClock();
    const logs = [];
    vi.spyOn(console, "log").mockImplementation(function (line) { logs.push(line); });
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(beach, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(180))
    });
    stubFetch({ features: [] });
    await runAlertCron(made.env);

    expect(rewrote(made, "osm-node-a")).toBe(false);
    const line = logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
    expect(line.indexOf(" skipStaleLower=1 ")).toBeGreaterThan(-1);
  });

  it("still raises a beach whose sealed inputs are three hours old", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(180))
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(writtenFlag(made, "osm-node-a").color).toBe("double-red");
  });
});

describe("runAlertRefresh write mechanics", function () {
  it("moves the color and nothing else: updated and the lease survive", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standingUpdated = minutesAgo(10);
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, standingUpdated)
    });
    const before = made.db.stateOf("osm-node-a");
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    const after = made.db.stateOf("osm-node-a");
    const written = storedEstimate(made, "osm-node-a");
    expect(written.color).toBe("double-red");
    expect(after.estimate_color).toBe("double-red");
    // The CAS omits both columns from its SET list, so the standing instant
    // (the token and the stale-lower clock) and the original lease stand.
    expect(after.estimate_updated).toBe(standingUpdated);
    expect(after.estimate_expires).toBe(before.estimate_expires);
    expect(written.updated).toBe(standingUpdated);
    expect(written.estimateInputs.v).toBe(1);
  });

  it("writes the estimate columns and nothing else", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    const row = made.db.stateOf("osm-node-a");
    // Never the wqfloor column (the hourly stays its single writer, so expiry is
    // the only retraction path), never official, never reading.
    expect(row.wqfloor).toBeNull();
    expect(row.official).toBeNull();
    expect(row.reading).toBeNull();
    // No rotation cursor and no flag_history: recompute_updated belongs to the
    // hourly alone, and this cron scrapes no officials to pair against.
    const other = made.db.statements.filter(function (st) {
      return st.sql.indexOf("UPDATE beaches") === 0 ||
        st.sql.indexOf("INSERT INTO flag_history") === 0 ||
        st.sql.indexOf("INSERT INTO beach_state") === 0;
    });
    expect(other).toEqual([]);
    // One batch, carrying the run's compare-and-set statements.
    expect(made.db.batchCalls.length).toBe(1);
  });

  it("pages the whole table and chunks the writes at 200 statements", async function () {
    freezeClock();
    const rows = [];
    const standings = {};
    for (let i = 0; i < 520; i = i + 1) {
      const id = "osm-node-" + String(1000 + i);
      const beach = beachRow({ id: id });
      rows.push(beach);
      standings[id] = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    }
    const logs = [];
    vi.spyOn(console, "log").mockImplementation(function (line) { logs.push(line); });
    const made = makeEnv(rows, standings);
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    // Keyset paging at 500 a page: every beach past the first page is reached.
    for (const beach of rows) {
      expect(storedEstimate(made, beach.id).color).toBe("double-red");
    }
    expect(made.db.batchCalls.map(function (c) { return c.length; })).toEqual([200, 200, 120]);
    const line = logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
    expect(line.indexOf(" rows=520 ")).toBeGreaterThan(-1);
    expect(line.indexOf(" written=520 ")).toBeGreaterThan(-1);
  });

  it("a rejected chunk costs its own beaches only and the run still reports", async function () {
    // Each chunk is its own batch inside its own try/catch: a D1 rejection
    // leaves that chunk's beaches on their standing color and the remaining
    // chunks are still attempted, so one transient failure costs ten minutes
    // for 200 beaches rather than for every selected one.
    freezeClock();
    const rows = [];
    const standings = {};
    for (let i = 0; i < 520; i = i + 1) {
      const id = "osm-node-" + String(1000 + i);
      const beach = beachRow({ id: id });
      rows.push(beach);
      standings[id] = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    }
    const logs = [];
    vi.spyOn(console, "log").mockImplementation(function (line) { logs.push(line); });
    const made = makeEnv(rows, standings);
    // The first chunk: its statements carry the first 200 ids in id order.
    made.db.failWhen(function (sql, args) {
      return sql.indexOf("UPDATE beach_state") === 0 && args[2] === "osm-node-1000";
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(made.db.batchCalls.map(function (c) { return c.length; })).toEqual([200, 200, 120]);
    for (let i = 0; i < 520; i = i + 1) {
      const id = "osm-node-" + String(1000 + i);
      expect(storedEstimate(made, id).color).toBe(i < 200 ? "green" : "double-red");
    }
    expect(logs.filter(function (l) {
      return l.indexOf("index: alert refresh chunk of 200 failed") === 0;
    }).length).toBe(1);
    const line = logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
    expect(line.indexOf(" written=320 ")).toBeGreaterThan(-1);
    expect(line.indexOf(" skipSuperseded=0 ")).toBeGreaterThan(-1);
  });
});
