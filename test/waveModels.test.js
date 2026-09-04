// Model labels and provenance for the wave inputs the offline NOAA GRIB pipeline
// publishes. The table is static so the hourly flag cron can name a reading's
// source without importing any fetching module, and it lives outside
// src/index.js because workerd rejects non-function named exports on the Worker
// entry module.
import { describe, it, expect } from "vitest";
import {
  WAVE_MODEL_IDS,
  WIND_SOURCE,
  waveSourceLabel,
  waveSourceUrl
} from "../src/waveModels.js";
import { modelDisplayName } from "../src/frontend/waveStrip.js";

describe("waveSourceLabel / waveSourceUrl", function () {
  it("names each grid the pipeline can publish", function () {
    expect(waveSourceLabel("noaa_gfswave")).toBe("NOAA GFS Wave Model");
    expect(waveSourceLabel("noaa_gfswave_arctic")).toBe("NOAA GFS Wave Model (Arctic)");
    expect(waveSourceLabel("noaa_glwu")).toBe("NOAA Great Lakes Wave Model");
  });

  it("degrades an unrecognised id to the generic label instead of throwing", function () {
    expect(waveSourceLabel("some_future_grid")).toBe("Wave Forecast");
    expect(waveSourceLabel(null)).toBe("Wave Forecast");
    expect(waveSourceLabel(undefined)).toBe("Wave Forecast");
    // An id that happens to name an Object.prototype member must not resolve to
    // a function through the prototype chain.
    expect(waveSourceLabel("constructor")).toBe("Wave Forecast");
  });

  it("carries a provenance url for every id, known or not", function () {
    const ids = WAVE_MODEL_IDS.concat(["some_future_grid"]);
    for (let i = 0; i < ids.length; i++) {
      expect(waveSourceUrl(ids[i])).toBe("https://polar.ncep.noaa.gov/waves/");
    }
  });
});

describe("WIND_SOURCE", function () {
  it("is a { label, url } source entry crediting NOAA, not Open-Meteo", function () {
    expect(WIND_SOURCE.label).toBe("Wind Forecast");
    expect(WIND_SOURCE.url).toBe("https://polar.ncep.noaa.gov/waves/");
    expect(WIND_SOURCE.url.indexOf("open-meteo")).toBe(-1);
  });

  it("is frozen: the hourly cron pushes this exact object into an estimate", function () {
    expect(Object.isFrozen(WIND_SOURCE)).toBe(true);
  });
});

// The detail-page chart legend renders any id it does not know as the RAW id, so
// a model this module can label but waveStrip.js cannot name would ship a string
// like "noaa_gfswave" to visitors.
describe("every known model id is displayable in the wave strip", function () {
  it("has a MODEL_DISPLAY name for each id", function () {
    for (let i = 0; i < WAVE_MODEL_IDS.length; i++) {
      const id = WAVE_MODEL_IDS[i];
      expect(modelDisplayName(id)).not.toBe(id);
    }
  });
});
