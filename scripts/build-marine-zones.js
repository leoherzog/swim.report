// scripts/build-marine-zones.js — one-time / ~biannual generator for
// data/marine-zones-greatlakes.json, the committed Great Lakes marine-zone
// geometry that the offline discovery batch (scripts/discovery-batch.js
// --marine-zones) uses to derive beaches.marine_zone with zero runtime
// upstream requests.
//
// Run MANUALLY (never in CI) whenever NWS publishes a new coastal marine zone
// shapefile release (https://www.weather.gov/gis/MarineZones, ~1-2x/year):
//
//   deno run --allow-net --allow-read --allow-write scripts/build-marine-zones.js
//   deno run --allow-read --allow-write scripts/build-marine-zones.js --zip /path/to/mzXXxxYY.zip
//
// Then review the logged per-prefix counts against the previous release, diff
// the JSON, and commit. The zip filename changes each release (mz18mr25.zip ->
// mz16ap26.zip ...) — update DEFAULT_ZIP_URL below when a new one lands.
//
// The script is dependency-free (no npm shapefile/zip packages, matching the
// batch's ethos): it reads the zip central directory itself, inflates entries
// with the built-in DecompressionStream, and parses the DBF + SHP binary
// layouts directly (both are simple fixed-offset formats).
//
// Output shape (see docs/offline-discovery.md):
//   {
//     source, validDate, generated, simplifyToleranceDeg,
//     zones: [ { id: "LMZ874", polygons: [ [ [ [lon, lat], ... ] ] ] }, ... ]
//   }
// polygons is GeoJSON-MultiPolygon-shaped coordinates: polygons -> rings ->
// [lon, lat] points; ring 0 is the outer ring, the rest are holes; rings are
// closed (first point repeated last); coords rounded to 5 decimals (~1 m).
//
// Project style: ES modules, const/let only, string concatenation with +
// (never template literals), console for logging.

// Current release: mz16ap26.zip, 569 records, valid/effective 2026-04-16.
// Update BOTH constants when a new release lands.
const DEFAULT_ZIP_URL = "https://www.weather.gov/source/gis/Shapefiles/WSOM/mz16ap26.zip";
const RELEASE_VALID_DATE = "2026-04-16";
const DEFAULT_OUT = "data/marine-zones-greatlakes.json";
const DEFAULT_TOLERANCE_DEG = 0.001;

// Great Lakes (+ St. Lawrence / St. Clair) marine zone id prefixes. Extend this
// list when src/regions.js REGIONS grows coasts beyond the Great Lakes system.
export const GREAT_LAKES_ZONE_PREFIXES = ["LCZ", "LEZ", "LHZ", "LMZ", "LOZ", "LSZ", "SLZ"];

function log(msg) {
  console.error("build-marine-zones: " + msg);
}

export function parseArgs(argv) {
  const args = { zip: DEFAULT_ZIP_URL, out: DEFAULT_OUT, tolerance: DEFAULT_TOLERANCE_DEG };
  for (let i = 0; i < argv.length; i = i + 1) {
    const a = argv[i];
    if (a === "--zip") { args.zip = argv[++i]; }
    else if (a === "--out") { args.out = argv[++i]; }
    else if (a === "--tolerance") { args.tolerance = parseFloat(argv[++i]) || DEFAULT_TOLERANCE_DEG; }
    else { throw new Error("unknown argument: " + a); }
  }
  return args;
}

// --- Minimal zip reader -------------------------------------------------------
// Reads the End-Of-Central-Directory record, walks the central directory, and
// inflates each wanted entry. Supports method 0 (stored) and 8 (deflate) —
// everything the NWS zips use. Returns a Map of lowercased extension suffix
// (".shp", ".dbf") -> Uint8Array for the entries we ask for.

async function inflateRaw(compressed) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([compressed]).stream().pipeThrough(ds);
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

export async function extractZipEntries(zipBytes, wantedSuffixes) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  // Find EOCD (signature 0x06054b50) scanning back from the end (comment can
  // trail it, max 65535 bytes).
  let eocd = -1;
  const scanStart = zipBytes.length - 22;
  const scanEnd = Math.max(0, zipBytes.length - 22 - 65535);
  for (let i = scanStart; i >= scanEnd; i = i - 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) {
    throw new Error("zip: no end-of-central-directory record found");
  }
  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("latin1");
  const out = new Map();
  let p = cdOffset;
  for (let e = 0; e < entryCount; e = e + 1) {
    if (view.getUint32(p, true) !== 0x02014b50) {
      throw new Error("zip: bad central directory entry signature at " + String(p));
    }
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(zipBytes.subarray(p + 46, p + 46 + nameLen));
    const lower = name.toLowerCase();
    for (const suffix of wantedSuffixes) {
      if (lower.endsWith(suffix)) {
        // Local header: name/extra lengths there may differ from the central
        // directory's — read them from the local header itself.
        if (view.getUint32(localOffset, true) !== 0x04034b50) {
          throw new Error("zip: bad local header signature for " + name);
        }
        const lNameLen = view.getUint16(localOffset + 26, true);
        const lExtraLen = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + lNameLen + lExtraLen;
        const raw = zipBytes.subarray(dataStart, dataStart + compSize);
        let data = null;
        if (method === 0) {
          data = new Uint8Array(raw);
        } else if (method === 8) {
          data = await inflateRaw(raw);
        } else {
          throw new Error("zip: unsupported compression method " + String(method) + " for " + name);
        }
        out.set(suffix, data);
        log("extracted " + name + " (" + String(data.length) + " bytes)");
      }
    }
    p = p + 46 + nameLen + extraLen + commentLen;
  }
  for (const suffix of wantedSuffixes) {
    if (!out.has(suffix)) {
      throw new Error("zip: entry " + suffix + " not found");
    }
  }
  return out;
}

// --- DBF parsing --------------------------------------------------------------
// dBASE III layout: records u32@4 LE, headerSize u16@8, recordSize u16@10;
// 32-byte field descriptors from offset 32 until the 0x0D terminator; record
// data at headerSize, each record = 1 deletion-flag byte + fixed-width ASCII
// fields. Returns an array of { fieldName: trimmedString }.

export function parseDbf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const recordCount = view.getUint32(4, true);
  const headerSize = view.getUint16(8, true);
  const recordSize = view.getUint16(10, true);
  const decoder = new TextDecoder("latin1");
  const fields = [];
  let p = 32;
  while (p < headerSize - 1 && bytes[p] !== 0x0d) {
    let nameEnd = p;
    while (nameEnd < p + 11 && bytes[nameEnd] !== 0) { nameEnd = nameEnd + 1; }
    fields.push({
      name: decoder.decode(bytes.subarray(p, nameEnd)),
      length: bytes[p + 16]
    });
    p = p + 32;
  }
  const records = [];
  for (let r = 0; r < recordCount; r = r + 1) {
    const base = headerSize + r * recordSize;
    if (base + recordSize > bytes.length) { break; }
    // 0x2A marks a deleted record; keep only active (0x20) rows.
    const deleted = bytes[base] === 0x2a;
    const rec = {};
    let off = base + 1;
    for (const f of fields) {
      rec[f.name] = decoder.decode(bytes.subarray(off, off + f.length)).trim();
      off = off + f.length;
    }
    if (!deleted) {
      records.push(rec);
    }
  }
  return records;
}

// --- SHP parsing --------------------------------------------------------------
// ESRI shapefile: 100-byte header; each record = 8-byte big-endian header
// (record number, content length in 16-bit words) then little-endian content.
// For shape type 5 (Polygon): type i32, bbox 4xf64, numParts i32, numPoints
// i32, part start indices i32[numParts], then [x=lon f64, y=lat f64] pairs.
// Record order matches the DBF. Returns an array (one per record, aligned with
// the DBF rows) of ring lists: [ [ [lon, lat], ... ], ... ] (null for empty /
// non-polygon records).

export function parseShpPolygons(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = [];
  let p = 100;
  while (p + 8 <= bytes.length) {
    const contentWords = view.getUint32(p + 4, false);
    const contentStart = p + 8;
    const contentLen = contentWords * 2;
    if (contentStart + contentLen > bytes.length) { break; }
    const shapeType = view.getInt32(contentStart, true);
    if (shapeType === 5) {
      const numParts = view.getInt32(contentStart + 36, true);
      const numPoints = view.getInt32(contentStart + 40, true);
      const partsStart = contentStart + 44;
      const pointsStart = partsStart + numParts * 4;
      const partIndex = [];
      for (let i = 0; i < numParts; i = i + 1) {
        partIndex.push(view.getInt32(partsStart + i * 4, true));
      }
      partIndex.push(numPoints);
      const rings = [];
      for (let part = 0; part < numParts; part = part + 1) {
        const ring = [];
        for (let j = partIndex[part]; j < partIndex[part + 1]; j = j + 1) {
          const off = pointsStart + j * 16;
          ring.push([view.getFloat64(off, true), view.getFloat64(off + 8, true)]);
        }
        rings.push(ring);
      }
      records.push(rings);
    } else {
      // Null shape (type 0) or unexpected type — keep DBF alignment.
      records.push(null);
    }
    p = contentStart + contentLen;
  }
  return records;
}

// --- Ring orientation + hole grouping -----------------------------------------
// Shapefile polygons carry outer rings clockwise and holes counter-clockwise
// (Y-up), with no explicit grouping. Shoelace signed area: negative = clockwise
// = outer. Each hole is assigned to the first outer ring that contains its
// first vertex (planar ray cast); an orphan hole degrades to its own outer
// ring rather than being dropped.

export function ringSignedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i = i + 1) {
    sum = sum + (ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]);
  }
  return sum / 2;
}

function pointInRingPlanar(lon, lat, ring) {
  let inside = false;
  let j = ring.length - 1;
  for (let i = 0; i < ring.length; i = i + 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const crosses = (yi > lat) !== (yj > lat) &&
      lon < (xj - xi) * (lat - yi) / (yj - yi) + xi;
    if (crosses) { inside = !inside; }
    j = i;
  }
  return inside;
}

export function groupRingsToPolygons(rings) {
  const outers = [];
  const holes = [];
  for (const ring of rings) {
    if (ring.length < 4) { continue; }
    if (ringSignedArea(ring) < 0) {
      outers.push([ring]);
    } else {
      holes.push(ring);
    }
  }
  for (const hole of holes) {
    let placed = false;
    for (const poly of outers) {
      if (pointInRingPlanar(hole[0][0], hole[0][1], poly[0])) {
        poly.push(hole);
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Orphan (winding quirk in the source data) — keep it as an outer ring so
      // its edges still participate in nearest-edge distance.
      outers.push([hole]);
    }
  }
  return outers;
}

// --- Douglas-Peucker simplification -------------------------------------------
// Planar perpendicular distance in degrees; toleranceDeg 0.001 ~ 110 m max
// boundary displacement — negligible against the 15 km resolution cap and the
// 5 NM zone widths. Endpoints are always kept, so a closed ring stays closed.
// Rings that would drop under 4 points keep their original geometry.

function perpDistanceDeg(pt, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ex = pt[0] - a[0];
    const ey = pt[1] - a[1];
    return Math.sqrt(ex * ex + ey * ey);
  }
  const cross = Math.abs(dx * (a[1] - pt[1]) - dy * (a[0] - pt[0]));
  return cross / Math.sqrt(len2);
}

export function simplifyRing(ring, toleranceDeg) {
  if (!(toleranceDeg > 0) || ring.length <= 4) {
    return ring;
  }
  const keep = new Array(ring.length).fill(false);
  keep[0] = true;
  keep[ring.length - 1] = true;
  const stack = [[0, ring.length - 1]];
  while (stack.length > 0) {
    const seg = stack.pop();
    const s = seg[0];
    const e = seg[1];
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = s + 1; i < e; i = i + 1) {
      const d = perpDistanceDeg(ring[i], ring[s], ring[e]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > toleranceDeg) {
      keep[maxIdx] = true;
      stack.push([s, maxIdx]);
      stack.push([maxIdx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < ring.length; i = i + 1) {
    if (keep[i]) { out.push(ring[i]); }
  }
  if (out.length < 4) {
    return ring;
  }
  return out;
}

function round5(v) {
  return Math.round(v * 100000) / 100000;
}

// --- Main ---------------------------------------------------------------------

async function main() {
  const args = parseArgs(Deno.args);
  let zipBytes = null;
  if (args.zip.indexOf("http://") === 0 || args.zip.indexOf("https://") === 0) {
    log("downloading " + args.zip);
    const res = await fetch(args.zip);
    if (!res.ok) {
      throw new Error("download failed: HTTP " + String(res.status) + " for " + args.zip);
    }
    zipBytes = new Uint8Array(await res.arrayBuffer());
  } else {
    log("reading local zip " + args.zip);
    zipBytes = await Deno.readFile(args.zip);
  }
  log("zip bytes: " + String(zipBytes.length));

  const entries = await extractZipEntries(zipBytes, [".shp", ".dbf"]);
  const dbfRecords = parseDbf(entries.get(".dbf"));
  const shpRecords = parseShpPolygons(entries.get(".shp"));
  log("dbf records: " + String(dbfRecords.length) + ", shp records: " + String(shpRecords.length));
  if (dbfRecords.length !== shpRecords.length) {
    throw new Error("dbf/shp record count mismatch (" + String(dbfRecords.length) +
      " vs " + String(shpRecords.length) + ") — refusing to misalign attributes");
  }

  // Filter to Great Lakes zones by id prefix and merge polygons by zone id
  // (defensive: a zone split across records merges into one MultiPolygon).
  const byId = new Map();
  for (let i = 0; i < dbfRecords.length; i = i + 1) {
    const id = dbfRecords[i].ID;
    if (!id || shpRecords[i] === null) { continue; }
    const prefix = id.slice(0, 3).toUpperCase();
    if (GREAT_LAKES_ZONE_PREFIXES.indexOf(prefix) < 0) { continue; }
    if (!byId.has(id)) { byId.set(id, []); }
    const polys = groupRingsToPolygons(shpRecords[i]);
    for (const poly of polys) {
      byId.get(id).push(poly);
    }
  }

  const prefixCounts = {};
  let totalPoints = 0;
  let totalRings = 0;
  const zones = [];
  for (const entry of byId.entries()) {
    const id = entry[0];
    const polygons = [];
    for (const poly of entry[1]) {
      const rings = [];
      for (const ring of poly) {
        const simplified = simplifyRing(ring, args.tolerance).map(function (pt) {
          return [round5(pt[0]), round5(pt[1])];
        });
        rings.push(simplified);
        totalPoints = totalPoints + simplified.length;
        totalRings = totalRings + 1;
      }
      polygons.push(rings);
    }
    zones.push({ id: id, polygons: polygons });
    const prefix = id.slice(0, 3).toUpperCase();
    prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
  }
  zones.sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });

  for (const prefix of GREAT_LAKES_ZONE_PREFIXES) {
    log("prefix " + prefix + ": " + String(prefixCounts[prefix] || 0) + " zone(s)");
  }
  log("total zones: " + String(zones.length) + ", rings: " + String(totalRings) +
    ", points after simplification (tol " + String(args.tolerance) + " deg): " + String(totalPoints));

  const doc = {
    source: args.zip.indexOf("http") === 0 ? args.zip : DEFAULT_ZIP_URL,
    validDate: RELEASE_VALID_DATE,
    generated: new Date().toISOString(),
    simplifyToleranceDeg: args.tolerance,
    zones: zones
  };
  // One zone per line keeps the committed file diffable across refreshes.
  const lines = [];
  lines.push("{");
  lines.push("\"source\": " + JSON.stringify(doc.source) + ",");
  lines.push("\"validDate\": " + JSON.stringify(doc.validDate) + ",");
  lines.push("\"generated\": " + JSON.stringify(doc.generated) + ",");
  lines.push("\"simplifyToleranceDeg\": " + JSON.stringify(doc.simplifyToleranceDeg) + ",");
  lines.push("\"zones\": [");
  for (let i = 0; i < zones.length; i = i + 1) {
    lines.push(JSON.stringify(zones[i]) + (i < zones.length - 1 ? "," : ""));
  }
  lines.push("]");
  lines.push("}");
  await Deno.writeTextFile(args.out, lines.join("\n") + "\n");
  log("wrote " + args.out);
}

if (import.meta.main) {
  main().catch(function (err) {
    console.error("build-marine-zones: FATAL: " + (err && err.stack ? err.stack : err));
    Deno.exit(1);
  });
}
