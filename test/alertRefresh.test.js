// runAlertRefresh, the level-triggered alerts cron, driven through the scheduled
// handler.
//
// The cron recomputes every live estimate against the current national alert
// fetches and writes the rows whose payload moved. The regression this file
// exists for: a recompute must never lower a flag by LOSING a non-alert input.
// Every "lowering a flag" case below seeds a beach whose standing color came from
// an alert, clears that alert in the feed, and asserts the recomputed color still
// carries the rip-current risk, the wave height, the wind fallback or the
// water-quality advisory the estimate was originally decided from — all of which
// come back from the estimateInputs seal inside the same estimate blob, never
// from a second record and never from a refetch.
import { describe, it, expect, vi, afterEach } from "vitest";
import { estimateFlag, alertsInEffect, decidedAlertDetails } from "../src/rules.js";
import { buildEstimateInputs, sealFromSignals } from "../src/flagInputs.js";
import { alertsUrlForZone } from "../src/clients/nws.js";
import { ECCC_ALERTS_INFO_URL } from "../src/clients/eccc.js";
import { ECCC_MARINE_INFO_URL } from "../src/clients/ecccMarine.js";
import { runScheduledCron } from "./helpers/cron.js";
import { makeD1 } from "./helpers/d1.js";

const NOW = "2026-07-15T16:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const FLAG_TTL = 25200;
// The window a bare event name gets on both sides of the diff: a standing
// fixture named the same way as a feed feature must produce the same detail
// entry, or every case would read as "the payload moved".
const ALERT_ONSET = "2026-07-15T15:30:00.000Z";
const ALERT_ENDS = "2026-07-16T02:00:00.000Z";

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

// The alertSources buildAlertInputs attaches to this beach, so a standing
// fixture differs from its own recompute only where a case means it to.
function sourcesFor(beach) {
  if (beach.eccc_zone && !beach.nws_zone && !beach.marine_zone) {
    return [
      { label: "Environment Canada Alerts", url: ECCC_ALERTS_INFO_URL },
      { label: "Environment Canada Marine Alerts", url: ECCC_MARINE_INFO_URL }
    ];
  }
  const sources = [];
  if (beach.nws_zone) {
    sources.push({ label: "NWS Alerts", url: alertsUrlForZone(beach.nws_zone) });
  }
  if (beach.marine_zone) {
    sources.push({ label: "NWS Marine Alerts", url: alertsUrlForZone(beach.marine_zone) });
  }
  return sources;
}

// A standing estimate exactly as runFlagRecompute writes it: estimateFlag
// over the same bundle, with the seal spread on afterwards. Built through the
// real functions so these fixtures cannot drift from what the hourly stores.
// alertEvents entries are event names (the shared ALERT_ONSET window) or whole
// { event, onset, ends } details; null means the hourly's alert fetch failed.
// The alert half is built the way buildAlertInputs builds it: alerts is the
// in-effect subset at updatedIso and alertsAt is that instant. legacy true builds
// the pre-onset-rule shape instead, every name in alerts and no alertsAt.
function standingFlag(beach, alertEvents, signalOverrides, updatedIso, legacy) {
  let alertPart = { alerts: null, alertDetails: null, alertSources: [], alertsResolved: false, alertsAt: null };
  if (alertEvents !== null) {
    const details = alertEvents.map(function (e) {
      return typeof e === "string" ? { event: e, onset: ALERT_ONSET, ends: ALERT_ENDS } : e;
    });
    alertPart = {
      alerts: legacy ? details.map(function (d) { return d.event; }) : alertsInEffect(details, updatedIso),
      alertDetails: details,
      alertSources: sourcesFor(beach),
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
// that turn on the lease rather than on the payload.
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

// Makes the walk see a SHORT page: the first page comes back trimmed to size,
// with every later page whole.
function shortenFirstPage(db, size) {
  const realPrepare = db.prepare;
  const counter = { pages: 0 };
  db.prepare = function (sql) {
    const statement = realPrepare.call(db, sql);
    if (sql.indexOf("JOIN beach_state") === -1) {
      return statement;
    }
    return {
      bind: function () {
        const bound = statement.bind.apply(statement, arguments);
        return {
          all: async function () {
            const out = await bound.all();
            counter.pages = counter.pages + 1;
            return counter.pages === 1
              ? { results: out.results.slice(0, size), success: true, meta: out.meta }
              : out;
          }
        };
      }
    };
  };
  return counter;
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
      onset: p.onset === undefined ? ALERT_ONSET : p.onset,
      ends: p.ends === undefined ? ALERT_ENDS : p.ends,
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

// Three national endpoints and nothing else; anything unrecognized rejects, as
// the rest of the suite does.
function stubFetch(opts) {
  const o = opts || {};
  vi.stubGlobal("fetch", function (url) {
    const target = typeof url === "string" ? url : (url && url.url) || "";
    if (target.indexOf("alerts/active") !== -1) {
      if (o.nwsFail) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      const body = { features: o.features || [] };
      if (o.nwsPaginated) {
        body.pagination = { next: "https://api.weather.gov/alerts/active?cursor=next" };
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

function captureLogs() {
  const logs = [];
  vi.spyOn(console, "log").mockImplementation(function (line) { logs.push(line); });
  return logs;
}

function completionLine(logs) {
  return logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
}

afterEach(function () {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runAlertRefresh recompute and diff", function () {
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

  it("treats a paginated national feed as no feed, so a partial view lowers nothing", async function () {
    freezeClock();
    const us = beachRow({ id: "osm-node-a", nws_zone: "MIZ071" });
    const made = makeEnv([us], {
      "osm-node-a": standingFlag(us, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    const logs = captureLogs();
    stubFetch({ features: [], nwsPaginated: true });
    await runAlertCron(made.env);

    expect(rewrote(made, "osm-node-a")).toBe(false);
    expect(storedEstimate(made, "osm-node-a").color).toBe("double-red");
    expect(completionLine(logs).indexOf(" skipAuthority=1 ")).toBeGreaterThan(-1);
    expect(completionLine(logs).indexOf(" nws=down ")).toBeGreaterThan(-1);
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

  it("rewrites a zone that swapped Small Craft Advisory for Gale Warning", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, ["Small Craft Advisory"], { waveHeightFt: 0.5 }, minutesAgo(10));
    expect(standing.color).toBe("yellow");
    const made = makeEnv([beach], { "osm-node-a": standing });
    stubFetch({ features: [nwsFeature("Gale Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(writtenFlag(made, "osm-node-a").color).toBe("red");
  });

  it("rewrites a zone that lost one of two alerts and kept the other", async function () {
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
    // what the diff is over.
    expect(written.color).toBe("red");
    expect(written.alertDetails.map(function (d) { return d.event; })).toEqual(["Gale Warning"]);
  });

  it("writes nothing when the recomputed payload is identical", async function () {
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
    expect(made.db.batchCalls.length).toBe(0);
  });

  it("converges: a second run against an unchanged feed writes nothing", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);
    const afterFirst = made.db.stateOf("osm-node-a").estimate;
    expect(JSON.parse(afterFirst).color).toBe("double-red");

    const logs = captureLogs();
    await runAlertCron(made.env);

    expect(made.db.stateOf("osm-node-a").estimate).toBe(afterFirst);
    expect(made.db.batchCalls.length).toBe(1);
    expect(completionLine(logs).indexOf(" written=0 ")).toBeGreaterThan(-1);
  });

  it("publishes an alert ahead of its onset as detail, without moving the color", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [nwsFeature("Beach Hazards Statement", ["MIZ071"], { onset: minutesAhead(120) })] });
    await runAlertCron(made.env);

    // The statement is a forecast until its onset, so the hazard lane gains a
    // band that starts later and the standing green stands.
    const written = writtenFlag(made, "osm-node-a");
    expect(written.color).toBe("green");
    expect(written.alertDetails.map(function (d) { return d.event; }))
      .toEqual(["Beach Hazards Statement"]);
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
    // alert set was judged.
    expect(written.updated).toBe(minutesAgo(10));
  });

  it("selects a beach whose alert crossed its onset without deciding a color", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    // Flood Watch is in no precedence list, so the payload moves only in which
    // echoed entries are in effect.
    const watch = { event: "Flood Watch", onset: minutesAgo(5), ends: minutesAhead(600) };
    const standing = standingFlag(beach, [watch], { waveHeightFt: 0.5 }, minutesAgo(10));
    expect(standing.color).toBe("green");
    expect(decidedAlertDetails(standing)).toEqual([]);
    const made = makeEnv([beach], { "osm-node-a": standing });
    stubFetch({ features: [nwsFeature("Flood Watch", ["MIZ071"], { onset: watch.onset, ends: watch.ends })] });
    await runAlertCron(made.env);

    const written = writtenFlag(made, "osm-node-a");
    expect(written.color).toBe("green");
    expect(written.alertsAt).toBe(NOW);
    expect(decidedAlertDetails(written).map(function (d) { return d.event; }))
      .toEqual(["Flood Watch"]);
  });

  it("selects a beach whose non-deciding alert has ended, feed unchanged", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const watch = { event: "Flood Watch", onset: minutesAgo(300), ends: minutesAgo(5) };
    const standing = standingFlag(beach, [watch], { waveHeightFt: 0.5 }, minutesAgo(10));
    expect(decidedAlertDetails(standing).length).toBe(1);
    const made = makeEnv([beach], { "osm-node-a": standing });
    // Still in the active feed: the product has not expired, only ended.
    stubFetch({ features: [nwsFeature("Flood Watch", ["MIZ071"], { onset: watch.onset, ends: watch.ends })] });
    await runAlertCron(made.env);

    const written = writtenFlag(made, "osm-node-a");
    expect(written.color).toBe("green");
    expect(decidedAlertDetails(written)).toEqual([]);
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

    // Nothing is in effect now, so the recompute drops back to the wave branch
    // and keeps the statement as an upcoming band.
    const written = writtenFlag(made, "osm-node-a");
    expect(written.color).toBe("green");
    expect(written.alertDetails.map(function (d) { return d.event; })).toEqual(["Beach Hazards Statement"]);
  });

  it("repairs a beach whose seal records a failed hourly alert fetch, both sets empty", async function () {
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

  it("lowers a Canadian beach whose standing warning is gone from both collections", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-ca", nws_zone: null, eccc_zone: "Alpena", lat: 45.5, lon: -83 });
    const made = makeEnv([beach], {
      "osm-node-ca": standingFlag(beach, ["gale warning"], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ ecccFeatures: [], ecccMarineFeatures: [] });
    await runAlertCron(made.env);

    expect(writtenFlag(made, "osm-node-ca").color).toBe("green");
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
    // The join drops it: there is no standing payload to recompute against.
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
    const logs = captureLogs();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    delete standing.estimateInputs;
    const c = guardCase({ "osm-node-a": standing });
    await runAlertCron(c.made.env);
    expect(rewrote(c.made, "osm-node-a")).toBe(false);
    expect(completionLine(logs).indexOf(" skipNoSeal=1 ")).toBeGreaterThan(-1);
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

  it("skips a standing value with no updated instant to anchor the write", async function () {
    freezeClock();
    const logs = captureLogs();
    const beach = beachRow({ id: "osm-node-a" });
    const missing = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    missing.updated = null;
    const c = guardCase(
      { "osm-node-a": missing },
      { "osm-node-a": Math.floor(NOW_MS / 1000) + FLAG_TTL }
    );
    await runAlertCron(c.made.env);
    expect(rewrote(c.made, "osm-node-a")).toBe(false);
    expect(completionLine(logs).indexOf(" skipNoSeal=1 ")).toBeGreaterThan(-1);
  });

  it("skips a standing value whose updated instant does not parse", async function () {
    freezeClock();
    const logs = captureLogs();
    const beach = beachRow({ id: "osm-node-a" });
    // An age the stale rail cannot compute would otherwise read as fresh and let
    // a lowering through unrailed.
    const unparseable = standingFlag(beach, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(180));
    unparseable.updated = "not-a-date";
    const c = guardCase(
      { "osm-node-a": unparseable },
      { "osm-node-a": Math.floor(NOW_MS / 1000) + FLAG_TTL }
    );
    stubFetch({ features: [] });
    await runAlertCron(c.made.env);
    expect(rewrote(c.made, "osm-node-a")).toBe(false);
    expect(completionLine(logs).indexOf(" skipNoSeal=1 ")).toBeGreaterThan(-1);
  });

  it("skips a state row whose estimate blob does not parse", async function () {
    freezeClock();
    const logs = captureLogs();
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
    expect(completionLine(logs).indexOf(" skipNoSeal=1 ")).toBeGreaterThan(-1);
  });

  it("loses the compare-and-set to an hourly run that rewrote the beach mid-flight", async function () {
    freezeClock();
    const logs = captureLogs();
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
    const line = completionLine(logs);
    expect(line.indexOf(" skipSuperseded=1 ")).toBeGreaterThan(-1);
    expect(line.indexOf(" written=0 ")).toBeGreaterThan(-1);
  });

  it("skips a beach enriched for neither authority", async function () {
    freezeClock();
    const logs = captureLogs();
    const beach = beachRow({ id: "osm-node-a", nws_zone: null });
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);
    expect(rewrote(made, "osm-node-a")).toBe(false);
    expect(completionLine(logs).indexOf(" skipAuthority=1 ")).toBeGreaterThan(-1);
  });
});

describe("runAlertRefresh degraded feeds", function () {
  const caBeach = beachRow({ id: "osm-node-ca", nws_zone: null, eccc_zone: "Alpena", lat: 45.5, lon: -83 });

  it("writes no US beach when the national alerts fetch fails, and still raises Canada", async function () {
    freezeClock();
    const logs = captureLogs();
    const us = beachRow({ id: "osm-node-us" });
    const made = makeEnv([us, caBeach], {
      "osm-node-us": standingFlag(us, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "osm-node-ca": standingFlag(caBeach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ nwsFail: true, ecccMarineFeatures: [ecccMarineFeature("Storm Warning")] });
    await runAlertCron(made.env);

    expect(rewrote(made, "osm-node-us")).toBe(false);
    expect(writtenFlag(made, "osm-node-ca").color).toBe("double-red");
    const line = completionLine(logs);
    expect(line.indexOf(" nws=down eccc=ok ")).toBeGreaterThan(-1);
    expect(line.indexOf(" skipAuthority=1 ")).toBeGreaterThan(-1);
  });

  it("writes no Canadian beach when only the marine collection failed, and still serves the US", async function () {
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

  it("touches D1 zero times when neither authority answered", async function () {
    freezeClock();
    const logs = captureLogs();
    const us = beachRow({ id: "osm-node-us" });
    const made = makeEnv([us, caBeach], {
      "osm-node-us": standingFlag(us, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "osm-node-ca": standingFlag(caBeach, ["gale warning"], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ nwsFail: true, ecccFail: true, ecccMarineFail: true });
    await runAlertCron(made.env);

    expect(made.db.statements.length).toBe(0);
    expect(made.db.batchCalls.length).toBe(0);
    const line = completionLine(logs);
    expect(line.indexOf(" rows=0 ")).toBeGreaterThan(-1);
    expect(line.indexOf(" nws=down eccc=down ")).toBeGreaterThan(-1);
    expect(line.indexOf(" features=none parsed=none ")).toBeGreaterThan(-1);
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

describe("runAlertRefresh stale-lower rail", function () {
  it("refuses a lowering decided by inputs older than the renderer's stale horizon", async function () {
    freezeClock();
    const logs = captureLogs();
    const beach = beachRow({ id: "osm-node-a" });
    // In effect when the hourly decided it three hours ago, gone from the feed
    // now: the clear-down is licensed by inputs the page would mark stale.
    const warning = { event: "High Surf Warning", onset: minutesAgo(300), ends: null };
    const standing = standingFlag(beach, [warning], { waveHeightFt: 0.5 }, minutesAgo(180));
    expect(standing.color).toBe("double-red");
    const made = makeEnv([beach], { "osm-node-a": standing });
    stubFetch({ features: [] });
    await runAlertCron(made.env);

    expect(rewrote(made, "osm-node-a")).toBe(false);
    const line = completionLine(logs);
    expect(line.indexOf(" skipStaleLower=1 ")).toBeGreaterThan(-1);
    expect(line.indexOf(" lowered=0 ")).toBeGreaterThan(-1);
  });

  it("still raises a beach whose sealed inputs are three hours old", async function () {
    freezeClock();
    const logs = captureLogs();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(180))
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(writtenFlag(made, "osm-node-a").color).toBe("double-red");
    // The rail refuses every lowering at this age, so staleWritten carries raises
    // and same-rank rewrites.
    expect(completionLine(logs).indexOf(" staleWritten=1 ")).toBeGreaterThan(-1);
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
    // One batch, carrying this page's compare-and-set statements.
    expect(made.db.batchCalls.length).toBe(1);
  });

  it("logs the run's field map", async function () {
    freezeClock();
    const logs = captureLogs();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(completionLine(logs)).toBe(
      "index: alert refresh complete, rows=1 written=1 raised=1 lowered=0" +
      " skipNoSeal=0 skipAuthority=0 skipStaleLower=0 skipSuperseded=0 staleWritten=0" +
      " nws=ok eccc=ok features=1 parsed=1 elapsedMs=0"
    );
  });

  it("pages the whole table, flushing each page's writes at 200 statements", async function () {
    freezeClock();
    const rows = [];
    const standings = {};
    for (let i = 0; i < 520; i = i + 1) {
      const id = "osm-node-" + String(1000 + i);
      const beach = beachRow({ id: id });
      rows.push(beach);
      standings[id] = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    }
    const logs = captureLogs();
    const made = makeEnv(rows, standings);
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    // Keyset paging at 500 a page: every beach past the first page is reached,
    // and the first page's writes land before the second page is read.
    for (const beach of rows) {
      expect(storedEstimate(made, beach.id).color).toBe("double-red");
    }
    expect(made.db.batchCalls.map(function (c) { return c.length; })).toEqual([200, 200, 100, 20]);
    const line = completionLine(logs);
    expect(line.indexOf(" rows=520 ")).toBeGreaterThan(-1);
    expect(line.indexOf(" written=520 ")).toBeGreaterThan(-1);
  });

  it("counts each chunk's writes against its own rows", async function () {
    freezeClock();
    const rows = [];
    const standings = {};
    // One page, two chunks: 200 lowerings, then 30 fresh raises and 20 raises on
    // a three-hour-old seal. A second chunk read against the first chunk's ranks
    // would report the whole page lowered, with staleWritten at zero.
    for (let i = 0; i < 250; i = i + 1) {
      const id = "osm-node-" + String(1000 + i);
      const beach = beachRow({ id: id, nws_zone: i < 200 ? "MIZ049" : "MIZ071" });
      rows.push(beach);
      standings[id] = i < 200
        ? standingFlag(beach, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10))
        : standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(i < 230 ? 10 : 180));
    }
    const logs = captureLogs();
    const made = makeEnv(rows, standings);
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(made.db.batchCalls.map(function (c) { return c.length; })).toEqual([200, 50]);
    const line = completionLine(logs);
    expect(line.indexOf(" written=250 ")).toBeGreaterThan(-1);
    expect(line.indexOf(" raised=50 ")).toBeGreaterThan(-1);
    expect(line.indexOf(" lowered=200 ")).toBeGreaterThan(-1);
    expect(line.indexOf(" staleWritten=20 ")).toBeGreaterThan(-1);
  });

  it("keeps walking past a short page and stops only on an empty one", async function () {
    freezeClock();
    const rows = [];
    const standings = {};
    for (let i = 0; i < 5; i = i + 1) {
      const id = "osm-node-" + String(1000 + i);
      const beach = beachRow({ id: id });
      rows.push(beach);
      standings[id] = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    }
    const made = makeEnv(rows, standings);
    const pages = shortenFirstPage(made.db, 2);
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    for (const beach of rows) {
      expect(storedEstimate(made, beach.id).color).toBe("double-red");
    }
    // Two rows, then the remaining three, then the empty page that ends it.
    expect(pages.pages).toBe(3);
  });

  it("a rejected chunk costs its own beaches only and the run still reports", async function () {
    // Each chunk is its own batch inside its own try/catch: a D1 rejection
    // leaves that chunk's beaches on their standing color and the remaining
    // chunks, and pages, are still attempted.
    freezeClock();
    const rows = [];
    const standings = {};
    for (let i = 0; i < 520; i = i + 1) {
      const id = "osm-node-" + String(1000 + i);
      const beach = beachRow({ id: id });
      rows.push(beach);
      standings[id] = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    }
    const logs = captureLogs();
    const made = makeEnv(rows, standings);
    // The first chunk: its statements carry the first 200 ids in id order.
    made.db.failWhen(function (sql, args) {
      return sql.indexOf("UPDATE beach_state") === 0 && args[2] === "osm-node-1000";
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(made.db.batchCalls.map(function (c) { return c.length; })).toEqual([200, 200, 200, 100, 20]);
    for (let i = 0; i < 520; i = i + 1) {
      const id = "osm-node-" + String(1000 + i);
      expect(storedEstimate(made, id).color).toBe(i < 200 ? "green" : "double-red");
    }
    // One retry line, then one final rejection.
    expect(logs.filter(function (l) {
      return l.indexOf("index: alert refresh chunk of 200 failed, retrying once") === 0;
    }).length).toBe(1);
    expect(logs.filter(function (l) {
      return l.indexOf("index: alert refresh chunk of 200 failed: ") === 0;
    }).length).toBe(1);
    const line = completionLine(logs);
    expect(line.indexOf(" written=320 ")).toBeGreaterThan(-1);
    expect(line.indexOf(" skipSuperseded=0 ")).toBeGreaterThan(-1);
  });

  it("a failing page SELECT rejects the scheduled promise and writes nothing", async function () {
    // The one failure the run does not swallow: a throw escaping its top level
    // is logged and rejects the waitUntil promise, so the invocation records as
    // failed rather than as an ok run that touched nothing.
    freezeClock();
    const beach = beachRow({ id: "osm-node-1" });
    const standings = {};
    standings["osm-node-1"] = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    const logs = captureLogs();
    const made = makeEnv([beach], standings);
    made.db.failWhen(function (sql) {
      return sql.indexOf("JOIN beach_state") !== -1;
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });

    await expect(runAlertCron(made.env)).rejects.toThrow(/D1 fake: forced failure/);
    expect(rewrote(made, "osm-node-1")).toBe(false);
    expect(made.db.batchCalls.length).toBe(0);
    expect(logs.some(function (l) {
      return l.indexOf("index: alert refresh failed: D1 fake: forced failure") === 0;
    })).toBe(true);
    expect(completionLine(logs)).toBeUndefined();
  });
});
