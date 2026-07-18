// runEcccEnrichment (cron "29 4,10,16,22 * * *"): beaches that NWS point
// enrichment permanently parked get their ECCC public forecast region name;
// a null lookup (US point or transient failure) bumps eccc_attempts so
// unresolvable rows eventually park, mirroring the NWS attempts cap.
import { describe, it, expect, vi, afterEach } from "vitest";
import { runScheduledCron } from "./helpers/cron.js";

// DB stub: .all() serves the candidate rows for the SELECT, .first() serves
// the parked COUNT, and every .bind().run() is recorded with its SQL + args.
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
      },
      batch: function (statements) {
        return Promise.resolve(statements.map(function () { return { success: true }; }));
      }
    },
    FLAGS: {
      get: function () { return Promise.resolve(null); },
      put: function () { return Promise.resolve(); }
    }
  };
  return { env: env, runCalls: runCalls };
}

function runEcccCron(env) {
  return runScheduledCron(env, "29 4,10,16,22 * * *");
}

describe("runEcccEnrichment", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("stamps eccc_zone from the region lookup on success", async function () {
    vi.stubGlobal("fetch", function (url) {
      const target = typeof url === "string" ? url : (url && url.url) || "";
      if (target.indexOf("public-standard-forecast-zones") !== -1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () {
            return Promise.resolve({
              features: [{ properties: { NAME: "Windsor - Essex - Chatham-Kent" } }]
            });
          }
        });
      }
      return Promise.reject(new Error("network disabled in test"));
    });

    const made = makeEnrichmentEnv([
      { id: "osm-way-175343424", lat: 41.9836774, lon: -82.9343626 }
    ]);
    await runEcccCron(made.env);

    const zoneUpdates = made.runCalls.filter(function (c) {
      return c.sql.indexOf("SET eccc_zone") !== -1;
    });
    expect(zoneUpdates.length).toBe(1);
    expect(zoneUpdates[0].args).toEqual(["Windsor - Essex - Chatham-Kent", "osm-way-175343424"]);
    // No attempts bump for the enriched row.
    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("eccc_attempts + 1") !== -1;
    })).toBe(false);
  });

  it("bumps eccc_attempts when the lookup returns null (zero regions / failure)", async function () {
    vi.stubGlobal("fetch", function () {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve({ features: [] }); }
      });
    });

    const made = makeEnrichmentEnv([
      { id: "osm-node-us-1", lat: 42.401, lon: -86.288 }
    ]);
    await runEcccCron(made.env);

    expect(made.runCalls.some(function (c) {
      return c.sql.indexOf("SET eccc_zone") !== -1;
    })).toBe(false);
    const bumps = made.runCalls.filter(function (c) {
      return c.sql.indexOf("eccc_attempts + 1") !== -1;
    });
    expect(bumps.length).toBe(1);
    expect(bumps[0].args).toEqual(["osm-node-us-1"]);
  });

  it("isolates per-beach failures: a thrown fetch bumps attempts and continues", async function () {
    let call = 0;
    vi.stubGlobal("fetch", function () {
      call = call + 1;
      if (call === 1) {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () {
          return Promise.resolve({
            features: [{ properties: { NAME: "Blind River - Thessalon" } }]
          });
        }
      });
    });

    const made = makeEnrichmentEnv([
      { id: "osm-node-ca-1", lat: 46.26, lon: -83.28 },
      { id: "osm-node-ca-2", lat: 46.27, lon: -83.29 }
    ]);
    await runEcccCron(made.env);

    const bumps = made.runCalls.filter(function (c) {
      return c.sql.indexOf("eccc_attempts + 1") !== -1;
    });
    const zoneUpdates = made.runCalls.filter(function (c) {
      return c.sql.indexOf("SET eccc_zone") !== -1;
    });
    expect(bumps.length).toBe(1);
    expect(bumps[0].args).toEqual(["osm-node-ca-1"]);
    expect(zoneUpdates.length).toBe(1);
    expect(zoneUpdates[0].args).toEqual(["Blind River - Thessalon", "osm-node-ca-2"]);
  });
});
