// test/windyWebcams.test.js
// Fixtures are shaped from a real Windy Webcams v3 /webcams response captured
// 2026-07-06 (Indian Grove: South Haven, webcamId 1595253287, day-only
// player). No network access — fetchNearestWebcam runs against a stubbed
// globalThis.fetch.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseNearestActiveWebcam,
  fetchNearestWebcam,
  WINDY_WEBCAMS_API_URL,
  WEBCAM_RADIUS_KM,
  WEBCAM_FETCH_LIMIT
} from "../src/clients/windyWebcams.js";
import { installFetch, jsonResponse } from "./helpers/fetch.js";

// South Haven beach target.
const LAT = 42.4;
const LON = -86.3;

function dayCam(id, title, lat, lon) {
  return {
    title: title,
    webcamId: id,
    status: "active",
    location: { latitude: lat, longitude: lon },
    player: { day: "https://webcams.windy.com/webcams/public/embed/player/" + String(id) + "/day" }
  };
}

describe("parseNearestActiveWebcam", function () {
  it("picks the nearest active cam even when it is not first in the array", function () {
    const json = {
      total: 2,
      webcams: [
        dayCam(111, "Far cam", 43.98, -86.56),
        dayCam(222, "Near cam", 42.397, -86.331)
      ]
    };
    const out = parseNearestActiveWebcam(json, LAT, LON);
    expect(out.webcamId).toBe("222");
    expect(out.title).toBe("Near cam");
    expect(out.playerUrl).toBe("https://webcams.windy.com/webcams/public/embed/player/222/day");
  });

  it("filters out inactive cams even when one is the nearest", function () {
    const inactive = dayCam(333, "Inactive but closest", 42.4, -86.3);
    inactive.status = "inactive";
    const json = {
      total: 2,
      webcams: [
        inactive,
        dayCam(222, "Active but farther", 42.397, -86.331)
      ]
    };
    const out = parseNearestActiveWebcam(json, LAT, LON);
    expect(out.webcamId).toBe("222");
  });

  it("prefers player.live over player.day when both are present and non-empty", function () {
    const cam = dayCam(444, "Live cam", 42.397, -86.331);
    cam.player.live = "https://webcams.windy.com/webcams/public/embed/player/444/live";
    const out = parseNearestActiveWebcam({ webcams: [cam] }, LAT, LON);
    expect(out.playerUrl).toBe("https://webcams.windy.com/webcams/public/embed/player/444/live");
  });

  it("falls back to player.day when live is missing", function () {
    const out = parseNearestActiveWebcam({ webcams: [dayCam(555, "Day only", 42.397, -86.331)] }, LAT, LON);
    expect(out.playerUrl).toBe("https://webcams.windy.com/webcams/public/embed/player/555/day");
  });

  it("ignores an empty-string live and falls back to day", function () {
    const cam = dayCam(666, "Empty live", 42.397, -86.331);
    cam.player.live = "";
    const out = parseNearestActiveWebcam({ webcams: [cam] }, LAT, LON);
    expect(out.playerUrl).toBe("https://webcams.windy.com/webcams/public/embed/player/666/day");
  });

  it("skips a cam missing its player entirely", function () {
    const cam = dayCam(777, "No player", 42.397, -86.331);
    delete cam.player;
    expect(parseNearestActiveWebcam({ webcams: [cam] }, LAT, LON)).toBe(null);
  });

  it("skips a cam whose player has neither a usable live nor day", function () {
    const cam = dayCam(778, "Empty player", 42.397, -86.331);
    cam.player = { month: "https://example.com/month" };
    expect(parseNearestActiveWebcam({ webcams: [cam] }, LAT, LON)).toBe(null);
  });

  it("skips a cam with non-finite or missing location coordinates", function () {
    const missing = dayCam(888, "No coords", 42.397, -86.331);
    missing.location = {};
    const nonFinite = dayCam(889, "Bad coords", 42.397, -86.331);
    nonFinite.location = { latitude: "42.4", longitude: -86.3 };
    expect(parseNearestActiveWebcam({ webcams: [missing] }, LAT, LON)).toBe(null);
    expect(parseNearestActiveWebcam({ webcams: [nonFinite] }, LAT, LON)).toBe(null);
  });

  it("returns null for an empty webcams array", function () {
    expect(parseNearestActiveWebcam({ total: 0, webcams: [] }, LAT, LON)).toBe(null);
  });

  it("returns null on malformed input", function () {
    expect(parseNearestActiveWebcam(null, LAT, LON)).toBe(null);
    expect(parseNearestActiveWebcam({}, LAT, LON)).toBe(null);
    expect(parseNearestActiveWebcam({ webcams: "nope" }, LAT, LON)).toBe(null);
  });

  it("coerces a numeric webcamId to a string", function () {
    const out = parseNearestActiveWebcam({ webcams: [dayCam(1595253287, "Indian Grove: South Haven", 42.397, -86.331)] }, LAT, LON);
    expect(out.webcamId).toBe("1595253287");
    expect(typeof out.webcamId).toBe("string");
  });

  it("falls back to an empty title when it is missing", function () {
    const cam = dayCam(999, "placeholder", 42.397, -86.331);
    delete cam.title;
    const out = parseNearestActiveWebcam({ webcams: [cam] }, LAT, LON);
    expect(out.title).toBe("");
  });
});

describe("fetchNearestWebcam", function () {
  const API_KEY = "test-api-key";

  const GOOD_BODY = {
    total: 1,
    webcams: [dayCam(1595253287, "Indian Grove: South Haven", 42.397, -86.331)]
  };

  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("requests the exact nearby URL with the api-key header and returns the parsed cam", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse(GOOD_BODY));
    });
    const out = await fetchNearestWebcam(LAT, LON, API_KEY);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(
      WINDY_WEBCAMS_API_URL +
      "?nearby=42.4,-86.3," + String(WEBCAM_RADIUS_KM) +
      "&include=player,location&limit=" + String(WEBCAM_FETCH_LIMIT)
    );
    expect(calls[0].init.headers["x-windy-api-key"]).toBe(API_KEY);
    expect(out).not.toBe(null);
    expect(out.webcam.webcamId).toBe("1595253287");
    expect(out.webcam.title).toBe("Indian Grove: South Haven");
  });

  it("returns { webcam: null } on HTTP success with zero usable cams", async function () {
    installFetch(function () {
      return Promise.resolve(jsonResponse({ total: 0, webcams: [] }));
    });
    const out = await fetchNearestWebcam(LAT, LON, API_KEY);
    expect(out).toEqual({ webcam: null });
  });

  it("returns null on a non-2xx response", async function () {
    installFetch(function () {
      return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve(null); } });
    });
    expect(await fetchNearestWebcam(LAT, LON, API_KEY)).toBe(null);
  });

  it("returns null when fetch throws", async function () {
    installFetch(function () {
      return Promise.reject(new Error("network down"));
    });
    expect(await fetchNearestWebcam(LAT, LON, API_KEY)).toBe(null);
  });

  it("returns null on an unparseable JSON body", async function () {
    installFetch(function () {
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.reject(new Error("bad json")); }
      });
    });
    expect(await fetchNearestWebcam(LAT, LON, API_KEY)).toBe(null);
  });

  it("returns null and makes no fetch when the api key is falsy", async function () {
    const calls = installFetch(function () {
      return Promise.resolve(jsonResponse(GOOD_BODY));
    });
    expect(await fetchNearestWebcam(LAT, LON, "")).toBe(null);
    expect(await fetchNearestWebcam(LAT, LON, null)).toBe(null);
    expect(await fetchNearestWebcam(LAT, LON, undefined)).toBe(null);
    expect(calls.length).toBe(0);
  });
});
