// runMarineEnrichment (cron "23 1,7,13,19 * * *"): US beaches (nws_zone set)
// get their adjacent NWS marine forecast zone id via resolveMarineZone's
// offshore probe. A resolved zone stamps marine_zone; a definitive "no zone
// nearby" or a transient fetch failure bumps marine_attempts so unresolvable
// rows eventually park, mirroring the NWS/ECCC attempts caps.
import { describe, it, expect, vi, afterEach } from "vitest";
import { runScheduledCron } from "./helpers/cron.js";

// DB stub: .all() serves the candidate rows for the SELECT, .first() serves the
// parked COUNT, and every .bind().run() is recorded with its SQL + args.
function makeEnrichmentEnv(candidateRows) {
  const runCalls = [];
  const env = {
    DB: {
      prepare: function (sql) {
        return {
          all: function () {
            return Promise.resolve({ results: candidateRows });
          },
          first: function () {
            return Promise.resolve({ n: 0 });
          },
          bind: function () {
            const args = Array.prototype.slice.call(arguments);
            return {
              sql: sql,
              args: args,
              run: function () {
                runCalls.push({ sql: sql, args: args });
                return Promise.resolve({ success: true });
              }
            };
          }
        };
      }
    },
    FLAGS: {
      get: function () { return Promise.resolve(null); },
      put: function () { return Promise.resolve(); }
    }
  };
  return { env: env, runCalls: runCalls };
}

function runMarineCron(env) {
  return runScheduledCron(env, "23 1,7,13,19 * * *");
}

// A /zones?type=marine FeatureCollection carrying the given zone ids.
function marineZonesResponse(ids) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () {
      return Promise.resolve({
        features: ids.map(function (id) { return { properties: { id: id } }; })
      });
    }
  });
}

describe("runMarineEnrichment", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("stamps marine_zone from the offshore probe on success", async function () {
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target.indexOf("type=marine") !== -1) {
        return marineZonesResponse(["LMZ874"]);
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnrichmentEnv([
      { id: "osm-node-1", lat: 42.775, lon: -86.211 }
    ]);
    await runMarineCron(made.env);

    const zoneUpdates = made.runCalls.filter(function (c) {
      return c.sql.indexOf("SET marine_zone") !== -1;
    });
    expect(zoneUpdates.length).toBe(1);
    expect(zoneUpdates[0].args).toEqual(["LMZ874", "osm-node-1"]);
    // No attempts bump for the enriched row.
    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("marine_attempts + 1") !== -1;
    })).toBe(false);
  });

  it("bumps marine_attempts when no probe finds a marine zone", async function () {
    vi.stubGlobal("fetch", function () {
      return marineZonesResponse([]); // every point (and probe ring) returns empty
    });

    const made = makeEnrichmentEnv([
      { id: "osm-node-inland", lat: 45.0, lon: -84.0 }
    ]);
    await runMarineCron(made.env);

    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("SET marine_zone") !== -1;
    })).toBe(false);
    const bumps = made.runCalls.filter(function (c) {
      return c.sql.indexOf("marine_attempts + 1") !== -1;
    });
    expect(bumps.length).toBe(1);
    expect(bumps[0].args).toEqual(["osm-node-inland"]);
  });

  it("bumps marine_attempts when the first probe fetch fails (transient)", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({}); } });
    });

    const made = makeEnrichmentEnv([
      { id: "osm-node-2", lat: 42.775, lon: -86.211 }
    ]);
    await runMarineCron(made.env);

    const bumps = made.runCalls.filter(function (c) {
      return c.sql.indexOf("marine_attempts + 1") !== -1;
    });
    expect(bumps.length).toBe(1);
    expect(bumps[0].args).toEqual(["osm-node-2"]);
  });
});
