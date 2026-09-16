// test/publicId.test.js
// The conversion between the storage id discovery mints and the public id a URL
// carries, including the rejections that keep one beach on exactly one URL.

import { describe, it, expect } from "vitest";
import {
  toPublicId,
  fromPublicId,
  fromLegacyId,
  parseAnyBeachId
} from "../src/publicId.js";

describe("toPublicId / fromPublicId", () => {
  it("round trips every element type", () => {
    const pairs = [
      ["osm-node-354000095", "n354000095"],
      ["osm-way-5", "w5"],
      ["osm-relation-7", "r7"]
    ];
    for (const pair of pairs) {
      expect(toPublicId(pair[0])).toBe(pair[1]);
      expect(fromPublicId(pair[1])).toBe(pair[0]);
    }
  });

  it("returns null for anything that is not a storage id", () => {
    for (const value of ["n1", "osm-point-1", "osm-node-", "osm-node-0", "", null, undefined, 7]) {
      expect(toPublicId(value)).toBe(null);
    }
  });

  it("rejects a non-canonical public segment", () => {
    for (const segment of ["n0", "n01", "N1", "n", "1", "nn1", "w-1", "osm-node-1", "", null]) {
      expect(fromPublicId(segment)).toBe(null);
    }
  });
});

describe("fromLegacyId", () => {
  it("returns a storage id unchanged", () => {
    expect(fromLegacyId("osm-node-1")).toBe("osm-node-1");
    expect(fromLegacyId("osm-way-505668572")).toBe("osm-way-505668572");
    expect(fromLegacyId("osm-relation-42")).toBe("osm-relation-42");
  });

  it("returns null for a public segment or junk", () => {
    for (const segment of ["n1", "osm-node-0", "osm-node-01", "OSM-node-1", "osm-node-", "nope", ""]) {
      expect(fromLegacyId(segment)).toBe(null);
    }
  });
});

describe("parseAnyBeachId", () => {
  it("resolves both forms to the storage id", () => {
    expect(parseAnyBeachId("n1")).toBe("osm-node-1");
    expect(parseAnyBeachId("osm-node-1")).toBe("osm-node-1");
    expect(parseAnyBeachId("w505668572")).toBe("osm-way-505668572");
    expect(parseAnyBeachId("osm-relation-7")).toBe("osm-relation-7");
  });

  it("returns null for junk", () => {
    for (const segment of ["x1", "n01", "beach-1", "osm-node-1/2", "%FF", "", null]) {
      expect(parseAnyBeachId(segment)).toBe(null);
    }
  });
});
