// runAlertRefresh, the level-triggered alerts cron, driven through the scheduled
// handler.
//
// The regression this file exists for: a fast recompute must never lower a flag
// by LOSING a non-alert input. Every "lowering a flag" case below seeds a beach
// whose standing color came from an alert, clears that alert in the feed, and
// asserts the recomputed color still carries the rip-current risk, the wave
// height, the wind fallback or the water-quality advisory the estimate was
// originally decided from — all of which come back from the estimateInputs seal
// inside the same "flag:" value, never from a second key and never from a
// refetch.
import { describe, it, expect, vi, afterEach } from "vitest";
import { estimateFlag } from "../src/rules.js";
import { buildEstimateInputs, sealFromSignals } from "../src/flagInputs.js";
import { MAP_DIRECTORY_KEY } from "../src/mapDirectory.js";
import { runScheduledCron } from "./helpers/cron.js";

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

// A standing "flag:" value exactly as runFlagRecompute writes it: estimateFlag
// over the same bundle, with the seal spread on afterwards. Built through the
// real functions so these fixtures cannot drift from what the hourly stores.
function standingFlag(beach, alertEvents, signalOverrides, updatedIso) {
  const alertPart = alertEvents === null
    ? { alerts: null, alertDetails: null, alertSources: [], alertsResolved: false }
    : {
      alerts: alertEvents,
      alertDetails: alertEvents.map(function (e) {
        return { event: e, onset: "2026-07-15T14:00:00.000Z", ends: null };
      }),
      alertSources: [{ label: "NWS Alerts", url: "https://api.weather.gov/alerts/active?zone=MIZ071" }],
      alertsResolved: true
    };
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

function makeEnv(rows, kvSeed) {
  const kvPuts = new Map();
  const kvGets = new Map(Object.entries(kvSeed || {}));
  const preparedSql = [];
  const batchCalls = [];
  const env = {
    DB: {
      prepare: function (sql) {
        preparedSql.push(sql);
        return {
          all: function () {
            return Promise.resolve({ results: rows });
          },
          bind: function () {
            return {
              all: function () { return Promise.resolve({ results: rows }); },
              run: function () { return Promise.resolve({ success: true }); }
            };
          }
        };
      },
      batch: function (statements) {
        batchCalls.push(statements);
        return Promise.resolve([]);
      }
    },
    FLAGS: {
      // Both get forms, as the Workers binding implements them: a string key
      // resolves to the value, an array to a Map. The scan reads in bulk.
      get: function (key) {
        if (Array.isArray(key)) {
          return Promise.resolve(new Map(key.map(function (k) {
            return [k, kvGets.has(k) ? kvGets.get(k) : null];
          })));
        }
        return Promise.resolve(kvGets.has(key) ? kvGets.get(key) : null);
      },
      put: function (key, value, opts) {
        kvPuts.set(key, { value: value, opts: opts });
        return Promise.resolve();
      }
    }
  };
  return { env: env, kvPuts: kvPuts, preparedSql: preparedSql, batchCalls: batchCalls };
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

function nwsFeature(event, zones) {
  return {
    properties: {
      event: event,
      onset: "2026-07-15T15:30:00.000Z",
      ends: "2026-07-16T02:00:00.000Z",
      geocode: { UGC: zones },
      affectedZones: []
    }
  };
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

function writtenFlag(kvPuts, id) {
  const put = kvPuts.get("flag:" + id);
  return put === undefined ? null : JSON.parse(put.value);
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
      "flag:osm-node-a": standingFlag(inZone, [], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "flag:osm-node-b": standingFlag(otherZone, [], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "flag:osm-node-c": standingFlag(marineOnly, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(writtenFlag(made.kvPuts, "osm-node-a").color).toBe("double-red");
    expect(made.kvPuts.has("flag:osm-node-b")).toBe(false);
    expect(made.kvPuts.has("flag:osm-node-c")).toBe(false);
  });

  it("matches a marine_zone from the same national feed", async function () {
    freezeClock();
    const marineOnly = beachRow({ id: "osm-node-c", nws_zone: null, marine_zone: "LHZ441" });
    const made = makeEnv([marineOnly], {
      "flag:osm-node-c": standingFlag(marineOnly, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [nwsFeature("Gale Warning", ["LHZ441"])] });
    await runAlertCron(made.env);

    expect(writtenFlag(made.kvPuts, "osm-node-c").color).toBe("red");
  });

  it("walks a beach back down when its standing alert is no longer in the feed", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "flag:osm-node-a": standingFlag(
        beach, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10)
      )
    });
    stubFetch({ features: [] });
    await runAlertCron(made.env);

    expect(writtenFlag(made.kvPuts, "osm-node-a").color).toBe("green");
  });

  it("selects a zone that swapped Small Craft Advisory for Gale Warning", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, ["Small Craft Advisory"], { waveHeightFt: 0.5 }, minutesAgo(10));
    expect(standing.color).toBe("yellow");
    const made = makeEnv([beach], { "flag:osm-node-a": standing });
    stubFetch({ features: [nwsFeature("Gale Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(writtenFlag(made.kvPuts, "osm-node-a").color).toBe("red");
  });

  it("selects a zone that lost one of two alerts and kept the other", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "flag:osm-node-a": standingFlag(
        beach, ["Gale Warning", "Small Craft Advisory"], { waveHeightFt: 0.5 }, minutesAgo(10)
      )
    });
    stubFetch({ features: [nwsFeature("Gale Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    const written = writtenFlag(made.kvPuts, "osm-node-a");
    // The color did not move, but the payload's alert provenance did, which is
    // why the write is unconditional for a selected beach.
    expect(written.color).toBe("red");
    expect(written.alertDetails.map(function (d) { return d.event; })).toEqual(["Gale Warning"]);
  });

  it("does not select a beach whose current and standing event sets are equal", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "flag:osm-node-a": standingFlag(
        beach, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10)
      )
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(made.kvPuts.has("flag:osm-node-a")).toBe(false);
  });

  it("selects a beach whose seal records a failed hourly alert fetch, even with both sets empty", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, null, { waveHeightFt: 0.5 }, minutesAgo(10));
    expect(standing.estimateInputs.alertsResolved).toBe(false);
    const made = makeEnv([beach], { "flag:osm-node-a": standing });
    stubFetch({ features: [] });
    await runAlertCron(made.env);

    const written = writtenFlag(made.kvPuts, "osm-node-a");
    expect(written).not.toBeNull();
    expect(written.estimateInputs.alertsResolved).toBe(true);
  });

  it("raises a Canadian beach on a gained ECCC land warning", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-ca", nws_zone: null, eccc_zone: "Alpena", lat: 45.5, lon: -83 });
    const made = makeEnv([beach], {
      "flag:osm-node-ca": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ ecccFeatures: [ecccFeature("wind warning")], ecccMarineFeatures: [] });
    await runAlertCron(made.env);

    expect(writtenFlag(made.kvPuts, "osm-node-ca").color).toBe("red");
  });

  it("restores the yellow floor a failed hourly alert fetch lost", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, null, { waveHeightFt: 0.5 }, minutesAgo(10));
    expect(standing.color).toBe("green");
    const made = makeEnv([beach], { "flag:osm-node-a": standing });
    stubFetch({ features: [nwsFeature("Small Craft Advisory", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(writtenFlag(made.kvPuts, "osm-node-a").color).toBe("yellow");
  });
});

describe("runAlertRefresh guards leave the standing value untouched", function () {
  function guardCase(kvSeed) {
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], kvSeed);
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    return { made: made, beach: beach };
  }

  it("skips a beach with no standing value (the hourly publishes the first estimate)", async function () {
    freezeClock();
    const c = guardCase({});
    await runAlertCron(c.made.env);
    expect(c.made.kvPuts.has("flag:osm-node-a")).toBe(false);
  });

  it("skips a standing value with no seal", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    delete standing.estimateInputs;
    const c = guardCase({ "flag:osm-node-a": standing });
    await runAlertCron(c.made.env);
    expect(c.made.kvPuts.has("flag:osm-node-a")).toBe(false);
  });

  it("skips a standing value carrying another seal version", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    standing.estimateInputs.v = 2;
    const c = guardCase({ "flag:osm-node-a": standing });
    await runAlertCron(c.made.env);
    expect(c.made.kvPuts.has("flag:osm-node-a")).toBe(false);
  });

  it("skips a standing value with a missing or unparseable updated", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const missing = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    missing.updated = null;
    const a = guardCase({ "flag:osm-node-a": missing });
    await runAlertCron(a.made.env);
    expect(a.made.kvPuts.has("flag:osm-node-a")).toBe(false);

    const unparseable = standingFlag(beach, [], { waveHeightFt: 0.5 }, "not-a-timestamp");
    const b = guardCase({ "flag:osm-node-a": unparseable });
    await runAlertCron(b.made.env);
    expect(b.made.kvPuts.has("flag:osm-node-a")).toBe(false);
  });

  it("skips a standing value stamped in the future", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const c = guardCase({
      "flag:osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(-10))
    });
    await runAlertCron(c.made.env);
    expect(c.made.kvPuts.has("flag:osm-node-a")).toBe(false);
  });

  it("skips a standing value with under five minutes of lease left", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const nearlyExpired = new Date(NOW_MS - (FLAG_TTL - 200) * 1000).toISOString();
    const c = guardCase({
      "flag:osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, nearlyExpired)
    });
    await runAlertCron(c.made.env);
    expect(c.made.kvPuts.has("flag:osm-node-a")).toBe(false);
  });

  it("skips a standing value the hourly has already superseded in D1", async function () {
    freezeClock();
    const logs = [];
    vi.spyOn(console, "log").mockImplementation(function (line) { logs.push(line); });
    // The KV read returned a replica from the previous hourly run; D1's stamp
    // says this beach was recomputed since. Recomputing the replica would
    // republish an hour-old bundle over the hourly's newer decision.
    const beach = beachRow({ id: "osm-node-a", recompute_updated: minutesAgo(5) });
    const made = makeEnv([beach], {
      "flag:osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(65))
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(made.kvPuts.has("flag:osm-node-a")).toBe(false);
    const line = logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
    expect(line.indexOf(" skipSuperseded=1 ")).toBeGreaterThan(-1);
  });

  it("recomputes a standing value whose stamp matches the hourly run that wrote it", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a", recompute_updated: minutesAgo(10) });
    const made = makeEnv([beach], {
      "flag:osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(writtenFlag(made.kvPuts, "osm-node-a").color).toBe("double-red");
  });

  it("skips a beach enriched for neither authority", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a", nws_zone: null });
    const made = makeEnv([beach], {
      "flag:osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);
    expect(made.kvPuts.has("flag:osm-node-a")).toBe(false);
  });
});

describe("runAlertRefresh degraded feeds", function () {
  const caBeach = beachRow({ id: "osm-node-ca", nws_zone: null, eccc_zone: "Alpena", lat: 45.5, lon: -83 });

  it("writes no US beach when the national alerts fetch fails, and still raises Canada", async function () {
    freezeClock();
    const us = beachRow({ id: "osm-node-us" });
    const made = makeEnv([us, caBeach], {
      "flag:osm-node-us": standingFlag(us, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "flag:osm-node-ca": standingFlag(caBeach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ nwsFail: true, ecccMarineFeatures: [ecccMarineFeature("Storm Warning")] });
    await runAlertCron(made.env);

    expect(made.kvPuts.has("flag:osm-node-us")).toBe(false);
    expect(writtenFlag(made.kvPuts, "osm-node-ca").color).toBe("double-red");
  });

  it("refuses a US lowering when the count endpoint is unavailable, but still raises", async function () {
    freezeClock();
    const logs = [];
    vi.spyOn(console, "log").mockImplementation(function (line) { logs.push(line); });
    const clearing = beachRow({ id: "osm-node-clear" });
    const gaining = beachRow({ id: "osm-node-gain", nws_zone: "MIZ049" });
    const made = makeEnv([clearing, gaining], {
      "flag:osm-node-clear": standingFlag(clearing, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "flag:osm-node-gain": standingFlag(gaining, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ countFail: true, features: [nwsFeature("High Surf Warning", ["MIZ049"])] });
    await runAlertCron(made.env);

    expect(made.kvPuts.has("flag:osm-node-clear")).toBe(false);
    expect(writtenFlag(made.kvPuts, "osm-node-gain").color).toBe("double-red");
    const line = logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
    expect(line.indexOf(" feed=unverified ")).toBeGreaterThan(-1);
    expect(line.indexOf(" skipFeedLower=1 ")).toBeGreaterThan(-1);
  });

  it("refuses a US lowering when the parse comes back short of the count total", async function () {
    freezeClock();
    const clearing = beachRow({ id: "osm-node-clear" });
    const made = makeEnv([clearing], {
      "flag:osm-node-clear": standingFlag(clearing, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [], countTotal: 183 });
    await runAlertCron(made.env);

    expect(made.kvPuts.has("flag:osm-node-clear")).toBe(false);
  });

  it("refuses a US lowering when the whole feed arrived but nothing in it parsed", async function () {
    freezeClock();
    const logs = [];
    vi.spyOn(console, "log").mockImplementation(function (line) { logs.push(line); });
    const clearing = beachRow({ id: "osm-node-clear" });
    const gaining = beachRow({ id: "osm-node-gain", nws_zone: "MIZ049" });
    const made = makeEnv([clearing, gaining], {
      "flag:osm-node-clear": standingFlag(clearing, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "flag:osm-node-gain": standingFlag(gaining, [], { waveHeightFt: 0.5 }, minutesAgo(10))
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

    expect(made.kvPuts.has("flag:osm-node-clear")).toBe(false);
    expect(writtenFlag(made.kvPuts, "osm-node-gain").color).toBe("double-red");
    const line = logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
    expect(line.indexOf(" feed=unverified ")).toBeGreaterThan(-1);
    expect(line.indexOf(" features=12 ")).toBeGreaterThan(-1);
    expect(line.indexOf(" parsed=1 ")).toBeGreaterThan(-1);
  });

  it("applies the clear when the feature count and the total agree", async function () {
    freezeClock();
    const clearing = beachRow({ id: "osm-node-clear" });
    const made = makeEnv([clearing], {
      "flag:osm-node-clear": standingFlag(clearing, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    // One feature in the feed, for another zone, and the total agrees.
    stubFetch({ features: [nwsFeature("Gale Warning", ["LMZ221"])], countTotal: 1 });
    await runAlertCron(made.env);

    expect(writtenFlag(made.kvPuts, "osm-node-clear").color).toBe("green");
  });

  it("refuses a lowering from a paginated feed even when the counts agree", async function () {
    freezeClock();
    const clearing = beachRow({ id: "osm-node-clear" });
    const made = makeEnv([clearing], {
      "flag:osm-node-clear": standingFlag(clearing, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [], countTotal: 0, pagination: true });
    await runAlertCron(made.env);

    expect(made.kvPuts.has("flag:osm-node-clear")).toBe(false);
  });

  it("writes no Canadian beach when only the marine collection failed", async function () {
    freezeClock();
    const us = beachRow({ id: "osm-node-us" });
    const made = makeEnv([us, caBeach], {
      "flag:osm-node-us": standingFlag(us, [], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "flag:osm-node-ca": standingFlag(caBeach, ["gale warning"], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({
      features: [nwsFeature("High Surf Warning", ["MIZ071"])],
      ecccFeatures: [],
      ecccMarineFail: true
    });
    await runAlertCron(made.env);

    // Without both collections a live "gale warning" red would recompute to a
    // wave-height green every ten minutes.
    expect(made.kvPuts.has("flag:osm-node-ca")).toBe(false);
    expect(writtenFlag(made.kvPuts, "osm-node-us").color).toBe("double-red");
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
    const made = makeEnv([beach], { "flag:osm-node-a": standing });
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
    expect(writtenFlag(made.kvPuts, "osm-node-a").color).toBe("red");
  });

  it("keeps a HIGH rip-current risk", async function () {
    const made = clearedWarning({ ripCurrentRisk: "HIGH", waveHeightFt: 0.5, windSpeedMph: 3 });
    await runAlertCron(made.env);
    expect(writtenFlag(made.kvPuts, "osm-node-a").color).toBe("red");
  });

  it("keeps a 4.5 ft wave reading rather than falling through to the wind branch", async function () {
    const made = clearedWarning({ waveHeightFt: 4.5, windSpeedMph: 3 });
    await runAlertCron(made.env);
    const written = writtenFlag(made.kvPuts, "osm-node-a");
    expect(written.color).toBe("red");
    expect(written.trigger).toBe("wave-height");
  });

  it("keeps a 40 mph wind fallback rather than dropping to unknown", async function () {
    const made = clearedWarning({ waveHeightFt: null, windSpeedMph: 40 });
    await runAlertCron(made.env);
    const written = writtenFlag(made.kvPuts, "osm-node-a");
    expect(written.color).toBe("red");
    expect(written.trigger).toBe("wind");
  });

  it("carries the sealed non-alert source entries into the republished payload", async function () {
    const made = clearedWarning({
      waveHeightFt: 4.5,
      signalSources: [{ label: "NOAA GFS Wave Model", url: "https://polar.ncep.noaa.gov/waves/" }]
    });
    await runAlertCron(made.env);
    expect(writtenFlag(made.kvPuts, "osm-node-a").sources.map(function (s) { return s.label; }))
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
      "flag:osm-node-ca1": standingFlag(clearing, ["gale warning"], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "flag:osm-node-ca2": standingFlag(gaining, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ ecccFeatures: [], ecccMarineFeatures: [ecccMarineFeature("Storm Warning")] });
    await runAlertCron(made.env);

    // ca1's standing gale warning is gone; ca2 gains the marine storm warning.
    expect(made.kvPuts.has("flag:osm-node-ca1")).toBe(false);
    expect(writtenFlag(made.kvPuts, "osm-node-ca2").color).toBe("double-red");
    const line = logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
    expect(line.indexOf(" skipCanadaLower=1 ")).toBeGreaterThan(-1);
  });

  it("refuses a lowering decided by inputs older than the renderer's stale horizon", async function () {
    freezeClock();
    const logs = [];
    vi.spyOn(console, "log").mockImplementation(function (line) { logs.push(line); });
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "flag:osm-node-a": standingFlag(beach, ["High Surf Warning"], { waveHeightFt: 0.5 }, minutesAgo(180))
    });
    stubFetch({ features: [] });
    await runAlertCron(made.env);

    expect(made.kvPuts.has("flag:osm-node-a")).toBe(false);
    const line = logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
    expect(line.indexOf(" skipStaleLower=1 ")).toBeGreaterThan(-1);
  });

  it("still raises a beach whose sealed inputs are three hours old", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "flag:osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(180))
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(writtenFlag(made.kvPuts, "osm-node-a").color).toBe("double-red");
  });
});

describe("runAlertRefresh write mechanics", function () {
  it("republishes with the remaining lease and never restamps updated", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standingUpdated = minutesAgo(10);
    const made = makeEnv([beach], {
      "flag:osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, standingUpdated)
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    const put = made.kvPuts.get("flag:osm-node-a");
    expect(put.opts).toEqual({ expirationTtl: FLAG_TTL - 600 });
    expect(put.opts.expirationTtl).toBeLessThan(FLAG_TTL);
    const written = JSON.parse(put.value);
    expect(written.updated).toBe(standingUpdated);
    expect(written.estimateInputs.v).toBe(1);
  });

  it("writes nothing but flag: and the map directory", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "flag:osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(Array.from(made.kvPuts.keys()).sort())
      .toEqual([MAP_DIRECTORY_KEY, "flag:osm-node-a"].sort());
    // No rotation cursor, no flag_history: recompute_updated belongs to the
    // hourly alone, and this cron scrapes no officials to pair against.
    expect(made.batchCalls.length).toBe(0);
    const updates = made.preparedSql.filter(function (sql) { return sql.indexOf("UPDATE") !== -1; });
    expect(updates).toEqual([]);
  });

  it("patches the artifact entry it just raised, and publishes once", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a", name: "Test Beach" });
    const made = makeEnv([beach], {
      "flag:osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10)),
      "official:osm-node-a": null
    });
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    const directory = JSON.parse(made.kvPuts.get(MAP_DIRECTORY_KEY).value);
    expect(directory.count).toBe(1);
    expect(directory.entries[0].estColor).toBe("double-red");
    // The standing instant, not the run's clock: the artifact carries the same
    // timestamp the republished key does.
    expect(directory.entries[0].estUpdated).toBe(minutesAgo(10));
  });

  it("writes no flag: key when the write deadline has already passed, but still rebuilds the artifact", async function () {
    freezeClock();
    const beach = beachRow({ id: "osm-node-a" });
    const standing = standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10));
    const made = makeEnv([beach], { "flag:osm-node-a": standing });
    made.env.FAST_WRITE_DEADLINE_MS = 0;
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(made.kvPuts.has("flag:osm-node-a")).toBe(false);
    const directory = JSON.parse(made.kvPuts.get(MAP_DIRECTORY_KEY).value);
    expect(directory.entries[0].estColor).toBe(standing.color);
  });

  it("publishes no directory at all when the flag-worthy read comes back empty", async function () {
    freezeClock();
    const logs = [];
    vi.spyOn(console, "log").mockImplementation(function (line) { logs.push(line); });
    const made = makeEnv([], {});
    stubFetch({ features: [] });
    await runAlertCron(made.env);

    // An empty directory is the maximal partial: the request path would serve it
    // as an authoritative, non-degraded, zero-feature map for three hours.
    expect(made.kvPuts.has(MAP_DIRECTORY_KEY)).toBe(false);
    const line = logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
    expect(line.indexOf(" mapdir=failed ")).toBeGreaterThan(-1);
  });

  it("writes nothing at all when the scan deadline trips", async function () {
    freezeClock();
    const logs = [];
    vi.spyOn(console, "log").mockImplementation(function (line) { logs.push(line); });
    const beach = beachRow({ id: "osm-node-a" });
    const made = makeEnv([beach], {
      "flag:osm-node-a": standingFlag(beach, [], { waveHeightFt: 0.5 }, minutesAgo(10))
    });
    made.env.MAP_SCAN_DEADLINE_MS = 0;
    stubFetch({ features: [nwsFeature("High Surf Warning", ["MIZ071"])] });
    await runAlertCron(made.env);

    expect(made.kvPuts.size).toBe(0);
    const line = logs.filter(function (l) { return l.indexOf("alert refresh complete") !== -1; })[0];
    expect(line.indexOf(" candidates=0 ")).toBeGreaterThan(-1);
    expect(line.indexOf(" mapdir=truncated ")).toBeGreaterThan(-1);
  });
});
