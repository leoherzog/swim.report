// Tests for scripts/build-marine-zones.js — the manual ~biannual generator for
// data/marine-zones-greatlakes.json. The module's entrypoint is guarded by
// import.meta.main (falsy under vitest/node), so importing the pure exports is
// safe: no Deno access, no network. All fixtures here are synthetic in-memory
// buffers built with DataView — no files, no fetch.

import { describe, it, expect } from "vitest";
import {
  extractZipEntries,
  parseDbf,
  parseShpPolygons,
  ringSignedArea,
  groupRingsToPolygons,
  simplifyRing
} from "../scripts/build-marine-zones.js";

// --- ring fixtures -------------------------------------------------------------

// Closed square ring traversed (minLon,minLat) -> up -> right -> down -> back:
// clockwise in shoelace terms (negative signed area) = shapefile OUTER ring.
function squareCW(minLon, minLat, size) {
  return [
    [minLon, minLat],
    [minLon, minLat + size],
    [minLon + size, minLat + size],
    [minLon + size, minLat],
    [minLon, minLat]
  ];
}

// Counter-clockwise (positive signed area) = shapefile HOLE ring.
function squareCCW(minLon, minLat, size) {
  return squareCW(minLon, minLat, size).slice().reverse();
}

// --- binary fixture builders ----------------------------------------------------

// Minimal in-memory zip: local headers + stored/deflated data, central
// directory, EOCD. entries: [{ name, data (Uint8Array), method (0|8|other),
// uncompressedLength (optional, defaults data.length) }].
function buildZip(entries) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data;
    const method = entry.method == null ? 0 : entry.method;
    const uncomp = entry.uncompressedLength == null ? data.length : entry.uncompressedLength;
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, uncomp, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, uncomp, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    locals.push(local);
    centrals.push(cd);
    offset = offset + local.length;
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const c of centrals) { cdSize = cdSize + c.length; }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  const out = new Uint8Array(cdOffset + cdSize + 22);
  let p = 0;
  for (const part of locals.concat(centrals)) {
    out.set(part, p);
    p = p + part.length;
  }
  out.set(eocd, p);
  return out;
}

async function deflateRaw(bytes) {
  const cs = new CompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  const chunks = [];
  const reader = stream.getReader();
  let total = 0;
  while (true) {
    const r = await reader.read();
    if (r.done) { break; }
    chunks.push(r.value);
    total = total + r.value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off = off + c.length;
  }
  return out;
}

// dBASE III buffer: fieldDefs [{ name, length }], records [{ deleted, values }]
// (values aligned with fieldDefs, padded to field length with spaces).
// declaredCount lets the header claim more records than the buffer holds.
function buildDbf(fieldDefs, records, declaredCount) {
  const headerSize = 32 + fieldDefs.length * 32 + 1;
  let recordSize = 1;
  for (const f of fieldDefs) { recordSize = recordSize + f.length; }
  const bytes = new Uint8Array(headerSize + records.length * recordSize);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x03;
  view.setUint32(4, declaredCount == null ? records.length : declaredCount, true);
  view.setUint16(8, headerSize, true);
  view.setUint16(10, recordSize, true);
  const encoder = new TextEncoder();
  for (let i = 0; i < fieldDefs.length; i = i + 1) {
    const base = 32 + i * 32;
    const nameBytes = encoder.encode(fieldDefs[i].name);
    bytes.set(nameBytes.subarray(0, 10), base);
    bytes[base + 11] = 0x43; // 'C'
    bytes[base + 16] = fieldDefs[i].length;
  }
  bytes[32 + fieldDefs.length * 32] = 0x0d;
  for (let r = 0; r < records.length; r = r + 1) {
    const base = headerSize + r * recordSize;
    bytes[base] = records[r].deleted ? 0x2a : 0x20;
    let off = base + 1;
    for (let f = 0; f < fieldDefs.length; f = f + 1) {
      let value = records[r].values[f];
      while (value.length < fieldDefs[f].length) { value = value + " "; }
      bytes.set(encoder.encode(value.slice(0, fieldDefs[f].length)), off);
      off = off + fieldDefs[f].length;
    }
  }
  return bytes;
}

// ESRI .shp buffer: 100-byte header (content ignored by the parser) followed by
// records. Each record spec is { type: 5, rings } | { type: 0 } |
// { overrunWords } (a bare 8-byte header whose declared content overruns).
function buildShp(recordSpecs) {
  const chunks = [];
  let recNum = 1;
  for (const spec of recordSpecs) {
    if (spec.overrunWords != null) {
      const h = new Uint8Array(8);
      const hv = new DataView(h.buffer);
      hv.setUint32(0, recNum, false);
      hv.setUint32(4, spec.overrunWords, false);
      chunks.push(h);
    } else if (spec.type === 0) {
      const b = new Uint8Array(12);
      const v = new DataView(b.buffer);
      v.setUint32(0, recNum, false);
      v.setUint32(4, 2, false);
      v.setInt32(8, 0, true);
      chunks.push(b);
    } else {
      let numPoints = 0;
      for (const ring of spec.rings) { numPoints = numPoints + ring.length; }
      const numParts = spec.rings.length;
      const contentLen = 44 + numParts * 4 + numPoints * 16;
      const b = new Uint8Array(8 + contentLen);
      const v = new DataView(b.buffer);
      v.setUint32(0, recNum, false);
      v.setUint32(4, contentLen / 2, false);
      const cs = 8;
      v.setInt32(cs, 5, true);
      v.setInt32(cs + 36, numParts, true);
      v.setInt32(cs + 40, numPoints, true);
      let firstPoint = 0;
      for (let i = 0; i < numParts; i = i + 1) {
        v.setInt32(cs + 44 + i * 4, firstPoint, true);
        firstPoint = firstPoint + spec.rings[i].length;
      }
      let off = cs + 44 + numParts * 4;
      for (const ring of spec.rings) {
        for (const pt of ring) {
          v.setFloat64(off, pt[0], true);
          v.setFloat64(off + 8, pt[1], true);
          off = off + 16;
        }
      }
      chunks.push(b);
    }
    recNum = recNum + 1;
  }
  let total = 100;
  for (const c of chunks) { total = total + c.length; }
  const out = new Uint8Array(total);
  let p = 100;
  for (const c of chunks) {
    out.set(c, p);
    p = p + c.length;
  }
  return out;
}

// --- ringSignedArea --------------------------------------------------------------

describe("ringSignedArea", function () {
  it("returns a negative area for a clockwise closed ring", function () {
    const cw = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]];
    expect(ringSignedArea(cw)).toBe(-1);
  });

  it("returns a positive area for the reversed (counter-clockwise) ring", function () {
    const ccw = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]].reverse();
    expect(ringSignedArea(ccw)).toBe(1);
  });
});

// --- groupRingsToPolygons ---------------------------------------------------------

describe("groupRingsToPolygons", function () {
  it("appends a CCW hole to the CW outer ring that contains its first vertex", function () {
    const outer = squareCW(0, 0, 10);
    const hole = squareCCW(2, 2, 6);
    const polys = groupRingsToPolygons([outer, hole]);
    expect(polys.length).toBe(1);
    expect(polys[0].length).toBe(2);
    expect(polys[0][0]).toBe(outer);
    expect(polys[0][1]).toBe(hole);
  });

  it("assigns each hole to the containing outer when several outers exist", function () {
    const westOuter = squareCW(0, 0, 10);
    const eastOuter = squareCW(20, 0, 10);
    const eastHole = squareCCW(23, 3, 2);
    const polys = groupRingsToPolygons([westOuter, eastOuter, eastHole]);
    expect(polys.length).toBe(2);
    expect(polys[0]).toEqual([westOuter]);
    expect(polys[1].length).toBe(2);
    expect(polys[1][0]).toBe(eastOuter);
    expect(polys[1][1]).toBe(eastHole);
  });

  it("promotes an orphan hole (contained by no outer) to its own outer polygon", function () {
    const outer = squareCW(0, 0, 10);
    const orphan = squareCCW(50, 50, 2);
    const polys = groupRingsToPolygons([outer, orphan]);
    expect(polys.length).toBe(2);
    expect(polys[0]).toEqual([outer]);
    expect(polys[1]).toEqual([orphan]);
  });

  it("drops rings with fewer than 4 points entirely", function () {
    const degenerate = [[0, 0], [1, 1], [0, 0]];
    expect(groupRingsToPolygons([degenerate])).toEqual([]);
    const outer = squareCW(0, 0, 10);
    const polys = groupRingsToPolygons([degenerate, outer]);
    expect(polys).toEqual([[outer]]);
  });
});

// --- simplifyRing -----------------------------------------------------------------

describe("simplifyRing", function () {
  // Closed square with one extra near-collinear point on the bottom edge.
  function noisySquare(deviation) {
    return [
      [0, 0],
      [5, deviation],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0]
    ];
  }

  it("keeps a mid-point whose deviation exceeds the tolerance", function () {
    const ring = noisySquare(0.5);
    const out = simplifyRing(ring, 0.01);
    expect(out).toContainEqual([5, 0.5]);
    expect(out.length).toBe(6);
  });

  it("drops a mid-point whose deviation is under the tolerance", function () {
    const ring = noisySquare(0.001);
    const out = simplifyRing(ring, 0.01);
    expect(out).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
  });

  it("always keeps the first and last points so a closed ring stays closed", function () {
    const ring = noisySquare(0.001);
    const out = simplifyRing(ring, 0.01);
    expect(out[0]).toEqual(ring[0]);
    expect(out[out.length - 1]).toEqual(ring[ring.length - 1]);
    expect(out[0]).toEqual(out[out.length - 1]);
  });

  it("returns a ring of 4 or fewer points unchanged (same reference)", function () {
    const tri = [[0, 0], [1, 0], [0, 1], [0, 0]];
    expect(simplifyRing(tri, 0.01)).toBe(tri);
  });

  it("returns the ring unchanged for zero or negative tolerance", function () {
    const ring = noisySquare(0.001);
    expect(simplifyRing(ring, 0)).toBe(ring);
    expect(simplifyRing(ring, -1)).toBe(ring);
    expect(simplifyRing(ring, NaN)).toBe(ring);
  });

  it("returns the ORIGINAL ring when simplification would leave under 4 points", function () {
    // Near-collinear closed sliver: every interior deviation is below the
    // tolerance, so only the (identical) endpoints would survive.
    const sliver = [[0, 0], [1, 0.0001], [2, 0], [1, -0.0001], [0, 0]];
    const out = simplifyRing(sliver, 3);
    expect(out).toBe(sliver);
    expect(out.length).toBe(5);
  });
});

// --- parseDbf ---------------------------------------------------------------------

describe("parseDbf", function () {
  it("returns active records with trimmed field values and skips deleted rows", function () {
    const bytes = buildDbf(
      [{ name: "ID", length: 8 }],
      [
        { deleted: false, values: ["LMZ874"] },
        { deleted: true, values: ["LEZ142"] }
      ]
    );
    const records = parseDbf(bytes);
    expect(records.length).toBe(1);
    expect(records[0]).toEqual({ ID: "LMZ874" });
  });

  it("reads multiple fields at their fixed offsets", function () {
    const bytes = buildDbf(
      [{ name: "ID", length: 6 }, { name: "NAME", length: 12 }],
      [{ deleted: false, values: ["LHZ361", "Lake Huron"] }]
    );
    const records = parseDbf(bytes);
    expect(records).toEqual([{ ID: "LHZ361", NAME: "Lake Huron" }]);
  });

  it("breaks cleanly on a truncated trailing record instead of reading garbage", function () {
    // Header claims 3 records but the buffer only holds 1 complete row.
    const bytes = buildDbf(
      [{ name: "ID", length: 8 }],
      [{ deleted: false, values: ["LOZ043"] }],
      3
    );
    const records = parseDbf(bytes);
    expect(records).toEqual([{ ID: "LOZ043" }]);
  });
});

// --- parseShpPolygons -------------------------------------------------------------

describe("parseShpPolygons", function () {
  it("parses a type-5 polygon record into its ring point lists", function () {
    const ring = squareCW(-86, 43, 1);
    const bytes = buildShp([{ type: 5, rings: [ring] }]);
    const records = parseShpPolygons(bytes);
    expect(records.length).toBe(1);
    expect(records[0]).toEqual([ring]);
  });

  it("splits a multi-part record into one ring per part", function () {
    const outer = squareCW(0, 0, 10);
    const hole = squareCCW(2, 2, 6);
    const bytes = buildShp([{ type: 5, rings: [outer, hole] }]);
    const records = parseShpPolygons(bytes);
    expect(records.length).toBe(1);
    expect(records[0].length).toBe(2);
    expect(records[0][0]).toEqual(outer);
    expect(records[0][1]).toEqual(hole);
  });

  it("yields null for a type-0 null record, keeping DBF alignment", function () {
    const ring = squareCW(-86, 43, 1);
    const bytes = buildShp([
      { type: 0 },
      { type: 5, rings: [ring] }
    ]);
    const records = parseShpPolygons(bytes);
    expect(records.length).toBe(2);
    expect(records[0]).toBe(null);
    expect(records[1]).toEqual([ring]);
  });

  it("terminates the loop when a record's declared content overruns the buffer", function () {
    const ring = squareCW(-86, 43, 1);
    const bytes = buildShp([
      { type: 5, rings: [ring] },
      { overrunWords: 10000 }
    ]);
    const records = parseShpPolygons(bytes);
    expect(records.length).toBe(1);
    expect(records[0]).toEqual([ring]);
  });
});

// --- extractZipEntries ------------------------------------------------------------

describe("extractZipEntries", function () {
  it("extracts a stored (method 0) entry keyed by wanted suffix", async function () {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const zip = buildZip([{ name: "mz16ap26.dbf", data: payload }]);
    const out = await extractZipEntries(zip, [".dbf"]);
    expect(out instanceof Map).toBe(true);
    expect(Array.from(out.get(".dbf"))).toEqual([1, 2, 3, 4, 5]);
  });

  it("inflates a deflated (method 8) entry via DecompressionStream", async function () {
    const payload = new TextEncoder().encode("marine zone shapefile payload");
    const compressed = await deflateRaw(payload);
    const zip = buildZip([{
      name: "zones.shp",
      data: compressed,
      method: 8,
      uncompressedLength: payload.length
    }]);
    const out = await extractZipEntries(zip, [".shp"]);
    expect(Array.from(out.get(".shp"))).toEqual(Array.from(payload));
  });

  it("extracts multiple wanted suffixes from one archive", async function () {
    const shp = new Uint8Array([9, 9, 9]);
    const dbf = new Uint8Array([7, 7]);
    const zip = buildZip([
      { name: "a.shp", data: shp },
      { name: "a.dbf", data: dbf },
      { name: "a.prj", data: new Uint8Array([1]) }
    ]);
    const out = await extractZipEntries(zip, [".shp", ".dbf"]);
    expect(out.size).toBe(2);
    expect(Array.from(out.get(".shp"))).toEqual([9, 9, 9]);
    expect(Array.from(out.get(".dbf"))).toEqual([7, 7]);
  });

  it("throws when no end-of-central-directory record exists", async function () {
    const junk = new Uint8Array(64);
    await expect(extractZipEntries(junk, [".dbf"])).rejects.toThrow("no end-of-central-directory");
  });

  it("throws on an unsupported compression method", async function () {
    const zip = buildZip([{ name: "a.dbf", data: new Uint8Array([1, 2]), method: 99 }]);
    await expect(extractZipEntries(zip, [".dbf"])).rejects.toThrow("unsupported compression method 99");
  });

  it("throws when a wanted suffix is absent from the archive", async function () {
    const zip = buildZip([{ name: "a.dbf", data: new Uint8Array([1]) }]);
    await expect(extractZipEntries(zip, [".shp"])).rejects.toThrow("entry .shp not found");
  });
});

// --- pipeline sanity: zip -> dbf/shp -> grouped polygons ---------------------------

describe("end-to-end parse of a synthetic shapefile zip", function () {
  it("round-trips a zone polygon through zip, dbf, shp, and ring grouping", async function () {
    const outer = squareCW(-87, 44, 2);
    const hole = squareCCW(-86.5, 44.5, 1);
    const dbfBytes = buildDbf(
      [{ name: "ID", length: 8 }],
      [{ deleted: false, values: ["LMZ876"] }]
    );
    const shpBytes = buildShp([{ type: 5, rings: [outer, hole] }]);
    const zip = buildZip([
      { name: "mz.dbf", data: dbfBytes },
      { name: "mz.shp", data: shpBytes }
    ]);
    const entries = await extractZipEntries(zip, [".shp", ".dbf"]);
    const dbfRecords = parseDbf(entries.get(".dbf"));
    const shpRecords = parseShpPolygons(entries.get(".shp"));
    expect(dbfRecords.length).toBe(shpRecords.length);
    expect(dbfRecords[0].ID).toBe("LMZ876");
    const polys = groupRingsToPolygons(shpRecords[0]);
    expect(polys.length).toBe(1);
    expect(polys[0][0]).toEqual(outer);
    expect(polys[0][1]).toEqual(hole);
  });
});
