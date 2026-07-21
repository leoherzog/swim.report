// runWebcamSync (cron "31 9 * * *"): due beaches are bucketed onto a coarse
// grid — a cell with >1 beach shares ONE bbox /webcams request, a lone cell
// keeps the nearby query — then the pure parser picks each beach's nearest
// in-radius active cam. A capped/failed bbox degrades safely.
import { describe, it, expect, vi, afterEach } from "vitest";
import { runScheduledCron } from "./helpers/cron.js";
import { WEBCAM_FETCH_LIMIT } from "../src/clients/windyWebcams.js";

// DB stub: bind().all() serves the due rows for the SELECT, first() the parked
// COUNT, and every bind().run() is recorded with its SQL + args.
function makeWebcamEnv(dueRows) {
  const runCalls = [];
  const env = {
    WINDY_WEBCAM_API_TOKEN: "test-token",
    DB: {
      prepare: function (sql) {
        return {
          all: function () { return Promise.resolve({ results: dueRows }); },
          first: function () { return Promise.resolve({ n: 0 }); },
          bind: function () {
            const args = Array.prototype.slice.call(arguments);
            return {
              all: function () { return Promise.resolve({ results: dueRows }); },
              run: function () {
                runCalls.push({ sql: sql, args: args });
                return Promise.resolve({ success: true });
              }
            };
          }
        };
      }
    }
  };
  return { env: env, runCalls: runCalls };
}

function runWebcamCron(env) {
  return runScheduledCron(env, "31 9 * * *");
}

function dayCam(id, lat, lon) {
  return {
    title: "cam " + String(id),
    webcamId: id,
    status: "active",
    location: { latitude: lat, longitude: lon },
    player: { day: "https://example.com/" + String(id) + "/day" }
  };
}

function okJson(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve(body); }
  });
}

// Two beaches mid-cell in the same 0.2-deg grid bucket (cluster) + one lone
// beach in a distinct bucket. Mid-cell coords avoid float wobble at the cell
// boundary (which would only cost the optimization, never correctness).
const BEACH_A = { id: "a", lat: 42.50, lon: -86.35 };
const BEACH_B = { id: "b", lat: 42.51, lon: -86.34 };
const BEACH_C = { id: "c", lat: 45.05, lon: -83.05 };

function webcamUpdates(runCalls) {
  return runCalls.filter(function (c) { return c.sql.indexOf("webcam_id = ?1") !== -1; });
}

describe("runWebcamSync clustering", function () {
  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("shares one bbox request across a cluster and a nearby request for a lone beach", async function () {
    const urls = [];
    vi.stubGlobal("fetch", function (url) {
      urls.push(url);
      if (url.indexOf("bbox=") !== -1) {
        // Two cams, each within radius of one clustered beach.
        return okJson({ webcams: [dayCam(11, 42.501, -86.351), dayCam(22, 42.509, -86.341)] });
      }
      // nearby query for the lone beach C.
      return okJson({ webcams: [dayCam(33, 45.051, -83.051)] });
    });

    const made = makeWebcamEnv([BEACH_A, BEACH_B, BEACH_C]);
    await runWebcamCron(made.env);

    const bboxCalls = urls.filter(function (u) { return u.indexOf("bbox=") !== -1; });
    const nearbyCalls = urls.filter(function (u) { return u.indexOf("nearby=") !== -1; });
    expect(bboxCalls.length).toBe(1);
    expect(nearbyCalls.length).toBe(1);

    const updates = webcamUpdates(made.runCalls);
    // A, B stamped from the shared bbox; C from its nearby query. Each row's
    // nearest in-radius cam.
    const byBeach = {};
    for (const u of updates) {
      byBeach[u.args[5]] = u.args[0]; // webcam_id keyed by beach id (?6)
    }
    expect(byBeach.a).toBe("11");
    expect(byBeach.b).toBe("22");
    expect(byBeach.c).toBe("33");
    // webcam_detail_url (?4) rides along: null when the API sent no urls.
    expect(updates[0].args[3]).toBeNull();
  });

  it("falls back to per-beach nearby when a bbox bucket hits the cam cap", async function () {
    const cappedWebcams = [];
    for (let i = 0; i < WEBCAM_FETCH_LIMIT; i++) {
      cappedWebcams.push(dayCam(1000 + i, 42.50 + i * 0.0001, -86.35));
    }
    const urls = [];
    vi.stubGlobal("fetch", function (url) {
      urls.push(url);
      if (url.indexOf("bbox=") !== -1) {
        return okJson({ webcams: cappedWebcams });
      }
      // per-beach nearby fallback: give each its own cam.
      if (url.indexOf("nearby=42.5,") !== -1) {
        return okJson({ webcams: [dayCam(77, 42.501, -86.351)] });
      }
      return okJson({ webcams: [dayCam(88, 42.509, -86.341)] });
    });

    const made = makeWebcamEnv([BEACH_A, BEACH_B]);
    await runWebcamCron(made.env);

    const bboxCalls = urls.filter(function (u) { return u.indexOf("bbox=") !== -1; });
    const nearbyCalls = urls.filter(function (u) { return u.indexOf("nearby=") !== -1; });
    expect(bboxCalls.length).toBe(1);
    // Cap hit -> both clustered beaches re-fetched via nearby.
    expect(nearbyCalls.length).toBe(2);
    expect(webcamUpdates(made.runCalls).length).toBe(2);
  });

  it("leaves rows untouched (no update) when the bbox fetch fails", async function () {
    vi.stubGlobal("fetch", function (url) {
      if (url.indexOf("bbox=") !== -1) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return okJson({ webcams: [] });
    });

    const made = makeWebcamEnv([BEACH_A, BEACH_B]);
    await runWebcamCron(made.env);

    // A failed bbox marks both as failures; no webcam_checked write, so they
    // stay at the front of the queue for next run.
    expect(made.runCalls.length).toBe(0);
  });
});
