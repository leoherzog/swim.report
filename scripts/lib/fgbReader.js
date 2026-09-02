// scripts/lib/fgbReader.js — reads FlatGeobuf bytes into plain feature records.
//
// This is the ONE module in the repo with an npm dependency. It runs on Deno
// (the offline layer pipeline: fetch-layers.js, clip-layers.js,
// discovery-batch.js) and on Node under vitest (the tests build their fixtures
// with the same library's serializer). Everything downstream of it is pure and
// dependency-free again: the record shape below (LayerFeature) is the single
// contract crossing the scripts/ to src/ boundary.
//
// It reads a WHOLE file and scans it SEQUENTIALLY — it never uses the packed
// R-tree — so it behaves identically on ogr2ogr-written layers (which carry an
// index, indexNodeSize 16) and on the JS-serialized in-memory fixtures the
// tests build (indexNodeSize 0, which cannot serve a bbox read at all).
//
// NEVER call deserialize(stream, rect). The library's dispatcher is
//   deserialize(input, rect, headerMetaFn) =>
//     input instanceof Uint8Array ? deserialize(input, rect, headerMetaFn)
//     : input instanceof ReadableStream ? deserializeStream(input, headerMetaFn)
//     : deserializeFiltered(...)
// so for a STREAM the second positional argument is read as headerMetaFn and a
// rect passed there is DISCARDED with no error. Measured during the migration
// design: the same rect returned 0 features from a Uint8Array and 314,600 from
// a stream. In this pipeline that would set coastlinePresent for every beach
// and reclassify the whole table. The two call sites below therefore pass the
// rect slot as an explicit undefined and never anything else.
//
// A CORRUPT LAYER MUST NEVER READ AS AN EMPTY ONE. That is the single most
// important property of this file, because an empty layer is indistinguishable
// from "the world has no beaches here" and feeds the only DELETE-bearing job in
// the repo. The library does not give us that for free: a buffer truncated
// inside the feature area throws an opaque RangeError, but one truncated in the
// header region yields ZERO features and no error at all (measured). So every
// read here compares the number of features actually decoded against the
// featuresCount the header declares and throws an identifiable Error on any
// mismatch. Callers must let that throw propagate — never catch it into a
// "layer is empty" branch.
//
// BARE SPECIFIER, per contract decision D17. Deno resolves it through the
// committed deno.json import map ("flatgeobuf/": "npm:/flatgeobuf@4.4.0/") plus
// deno.lock; vitest resolves it through the package.json devDependency and
// node_modules. A literal npm: URL here would make every test that touches this
// module fail at collection under vitest (npm: is a Deno-only URL scheme), and a
// bare specifier WITHOUT the map would need an npm install on the runner, which
// the workflows deliberately forbid (the private-registry E401 trap).
//
// DENO INVOCATION REQUIREMENT (measured, and it is not optional): any deno
// command whose module graph reaches this file must run with
// DENO_NO_PACKAGE_JSON=1. Deno auto-discovers the repo's package.json as soon as
// the graph contains an npm resolution and then eagerly resolves EVERY dependency
// declared there — including @web.awesome.me/webawesome-pro and
// @awesome.me/kit-*, which live behind token-gated private registries. On a CI
// runner with no .npmrc token that fails the whole command
// ("npm package '@awesome.me/kit-ddd41b2d81' does not exist"), which is exactly
// the E401 trap the import map exists to avoid. DENO_NO_PACKAGE_JSON=1 stops the
// package.json discovery; the import map still resolves flatgeobuf from the
// global deno cache, with no node_modules on the runner.
//
// Project style: ES modules, const/let only, string concatenation with + (never
// template literals), console for logging.

import { deserialize } from "flatgeobuf/lib/mjs/geojson.js";

// The OSM tag keys carried across the boundary. Everything the pure src/
// modules branch on (natural, leisure, boundary, water, wikidata) plus the two
// naming tags (name, loc_name). "type" is here because the published
// other-relations layer promotes it (contract 1.4) and it is the only place a
// consumer could ever need to tell a multipolygon relation from another relation
// type; no consumer branches on it today, and copying it costs one string.
//
// Values are copied VERBATIM (no trimming — src/osmSelect.js owns the loc_name
// trim). A property that is absent, null, or the empty string is OMITTED rather
// than carried as null, so tags.name behaves exactly like an Overpass
// element.tags.name: GDAL writes an unpromoted/unset field as null, and a
// downstream if (tags.name) and if (tags.name != null) must not disagree.
export const LAYER_TAG_KEYS = [
  "name",
  "loc_name",
  "natural",
  "leisure",
  "boundary",
  "water",
  "wikidata",
  "type"
];

// A FlatGeobuf file is 8 magic bytes + a 4-byte header length + the header, so
// anything shorter than 12 bytes cannot be a layer. The guard matters because
// the library's magic-byte check is bytes.subarray(0, 3).every(...), and
// Array.prototype.every on an EMPTY array is vacuously true — a zero-byte
// download (a failed curl, a truncated artifact) would sail past it and read as
// an empty layer.
const MIN_FGB_BYTES = 12;

function errorMessage(err) {
  if (err && typeof err.message === "string" && err.message !== "") {
    return err.message;
  }
  return String(err);
}

// The truncation trip-wire described in the header comment. declared is the
// header's featuresCount. ogr2ogr always writes a real count; the library's own
// JS serializer does too. A writer that leaves it at 0 (a streaming writer that
// cannot know the count up front) disables the check rather than failing every
// read — the check can only ever fire on a count the file itself asserted.
function assertCompleteRead(header, decoded, what) {
  if (!header || header.featuresCount === undefined || header.featuresCount === null) {
    return;
  }
  const declared = Number(header.featuresCount);
  if (!Number.isFinite(declared) || declared <= 0) {
    return;
  }
  if (decoded !== declared) {
    throw new Error("fgbReader: truncated FlatGeobuf" + (what ? " (" + what + ")" : "") +
      ": header declares " + declared + " features, decoded " + decoded);
  }
}

// --- Pure record normalization ------------------------------------------------

// osm_id vs osm_way_id is the way/relation discriminator, and it is load-bearing:
// the id feeds "osm-" + osmType + "-" + osmId, which is the D1 primary key AND
// the KV flag key, and src/layerSignals.js gates nearbyWayWater on type "way"
// and nearbyLakeQids on type "relation". Getting it wrong silently orphans every
// stored flag.
//
// Contract 3.2 states the rule per GDAL SOURCE layer (points -> node, lines ->
// way, multipolygons -> osm_way_id ? way : relation). The reader cannot branch on
// that: its layerName argument is the LOGICAL layer ("beaches" spans the points,
// lines AND multipolygons files), so the source layer is not recoverable from it.
// The geometry type is, and it is in bijection with the source layer for exactly
// the layers this pipeline publishes — the points layer only ever yields Point,
// the lines layer LineString/MultiLineString, the multipolygons layer
// Polygon/MultiPolygon, and other_relations GeometryCollection (always a
// relation). So the derivation below is the same rule, read off the geometry.
function osmIdentity(geometry, properties) {
  const type = geometry.type;
  if (type === "Point" || type === "MultiPoint") {
    return { osmType: "node", rawId: properties.osm_id };
  }
  if (type === "LineString" || type === "MultiLineString") {
    return { osmType: "way", rawId: properties.osm_id };
  }
  if (type === "Polygon" || type === "MultiPolygon") {
    const wayId = properties.osm_way_id;
    if (wayId !== undefined && wayId !== null && String(wayId) !== "") {
      return { osmType: "way", rawId: wayId };
    }
    return { osmType: "relation", rawId: properties.osm_id };
  }
  if (type === "GeometryCollection") {
    // GDAL yields GeometryCollection for the other_relations layer, whose
    // features are relations by definition. These are consumed by ENVELOPE ONLY
    // downstream — they have no reliable ring structure and must never be fed to
    // a point-in-polygon test.
    return { osmType: "relation", rawId: properties.osm_id };
  }
  return null;
}

// Recursive coordinate walk. GeoJSON nests positions to a different depth per
// geometry type (Point, LineString/MultiPoint, Polygon/MultiLineString,
// MultiPolygon), and a GeometryCollection mixes depths inside one feature, so
// walking generically is both shorter and safer than a per-type switch. A
// position with a third element (elevation) is fine — only [0] and [1] are read.
function walkPositions(coords, visit) {
  if (!Array.isArray(coords) || coords.length === 0) {
    return;
  }
  if (typeof coords[0] === "number") {
    if (coords.length >= 2 && Number.isFinite(coords[0]) && Number.isFinite(coords[1])) {
      visit(coords[0], coords[1]);
    }
    return;
  }
  for (let i = 0; i < coords.length; i = i + 1) {
    walkPositions(coords[i], visit);
  }
}

// Bounds are computed HERE, by walking every coordinate — never taken from a
// driver-provided envelope. That is what makes a node degenerate to a
// zero-extent envelope exactly as the old Overpass elementBounds did, which is
// in turn what makes a node beach's areaDeg2 zero and therefore always
// pond-testable. Returns null when the geometry carries no usable position.
export function geometryBounds(geometry) {
  if (!geometry || typeof geometry !== "object") {
    return null;
  }
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  let seen = 0;
  const visit = function (lon, lat) {
    seen = seen + 1;
    if (lat < minLat) { minLat = lat; }
    if (lat > maxLat) { maxLat = lat; }
    if (lon < minLon) { minLon = lon; }
    if (lon > maxLon) { maxLon = lon; }
  };
  if (geometry.type === "GeometryCollection") {
    const parts = Array.isArray(geometry.geometries) ? geometry.geometries : [];
    for (let i = 0; i < parts.length; i = i + 1) {
      const part = parts[i];
      if (part && typeof part === "object") {
        walkPositions(part.coordinates, visit);
      }
    }
  } else {
    walkPositions(geometry.coordinates, visit);
  }
  if (seen === 0) {
    return null;
  }
  return { minLat: minLat, minLon: minLon, maxLat: maxLat, maxLon: maxLon };
}

function tagsFromProperties(properties) {
  const tags = {};
  for (let i = 0; i < LAYER_TAG_KEYS.length; i = i + 1) {
    const key = LAYER_TAG_KEYS[i];
    const value = properties[key];
    if (value === undefined || value === null) {
      continue;
    }
    const text = typeof value === "string" ? value : String(value);
    if (text === "") {
      continue;
    }
    tags[key] = text;
  }
  return tags;
}

// Pure, exported for tests. Maps one decoded GeoJSON feature onto the record
// shape the pure src/ modules consume:
//
//   { layer, osmType, osmId, tags, bounds, geometry }
//
// Returns null — SKIP, do not throw — when the geometry is null, the id is not a
// finite number, or the geometry yields no coordinates. A skip is a per-feature
// data problem (one row GDAL could not build a geometry for); a throw is an
// artifact problem (the whole file is unreadable). Conflating the two is how a
// bad download becomes an empty layer, so the two paths stay strictly separate
// and the CALLER logs skips.
export function toLayerFeature(feature, layerName) {
  if (!feature || typeof feature !== "object") {
    return null;
  }
  const geometry = feature.geometry;
  if (!geometry || typeof geometry !== "object") {
    return null;
  }
  const properties = (feature.properties && typeof feature.properties === "object")
    ? feature.properties
    : {};
  const identity = osmIdentity(geometry, properties);
  if (identity === null) {
    return null;
  }
  const rawId = identity.rawId;
  if (rawId === undefined || rawId === null || rawId === "") {
    return null;
  }
  const osmId = Number(rawId);
  if (!Number.isFinite(osmId)) {
    return null;
  }
  const bounds = geometryBounds(geometry);
  if (bounds === null) {
    return null;
  }
  return {
    layer: layerName === undefined ? null : layerName,
    osmType: identity.osmType,
    osmId: osmId,
    tags: tagsFromProperties(properties),
    bounds: bounds,
    geometry: geometry
  };
}

// --- Byte-level read ----------------------------------------------------------

// bytes: Uint8Array. Returns an ARRAY of { geometry, properties } in FILE order.
// Throws on undecodable bytes (a truncated or non-FlatGeobuf buffer) — a corrupt
// download must never read as an empty layer. Not layer-aware and not Deno-bound,
// so the tests exercise it directly on in-memory fixtures.
export async function readFgb(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("fgbReader: expected Uint8Array bytes, got " + typeof bytes);
  }
  if (bytes.length < MIN_FGB_BYTES) {
    throw new Error("fgbReader: not a FlatGeobuf file: " + bytes.length +
      " bytes is shorter than the " + MIN_FGB_BYTES + "-byte minimum header");
  }
  let header = null;
  const onHeader = function (meta) { header = meta; };
  const features = [];
  try {
    // Second argument is the rect slot and stays undefined FOREVER — see the
    // header comment. This is the Uint8Array branch, which does honour a rect,
    // but honouring it would mean trusting the packed R-tree that JS-serialized
    // fixtures do not have.
    for await (const feature of deserialize(bytes, undefined, onHeader)) {
      features.push({
        geometry: feature && feature.geometry !== undefined ? feature.geometry : null,
        properties: feature && feature.properties !== undefined ? feature.properties : {}
      });
    }
  } catch (err) {
    throw new Error("fgbReader: undecodable FlatGeobuf bytes: " + errorMessage(err));
  }
  assertCompleteRead(header, features.length, null);
  return features;
}

// --- Deno file readers --------------------------------------------------------

// Deno.readFile / Deno.open are referenced through globalThis so that merely
// IMPORTING this module stays legal under Node (vitest imports it to test the
// pure half). The two file readers below are the Deno-only surface and say so
// when called anywhere else.
function requireDeno(what) {
  const runtime = globalThis.Deno;
  if (!runtime || typeof runtime.readFile !== "function" || typeof runtime.open !== "function") {
    throw new Error("fgbReader: " + what + " requires Deno (globalThis.Deno is unavailable) — " +
      "use readFgb(bytes) on other runtimes");
  }
  return runtime;
}

// Convenience for the batch: read a file path, decode, and normalize every
// feature through toLayerFeature. Deno-only.
//
// ONLY for layers whose whole geometry must be RETAINED — beaches and parks.
// Never for coastline / water / lakes: GeoJSON coordinate pairs cost roughly
// 10-20x their packed FlatGeobuf footprint in a JS heap, so a 120 MB water layer
// is 1-2 GB live. Those go through readFgbStream.
export async function readLayerFile(path, layerName) {
  const runtime = requireDeno("readLayerFile");
  const bytes = await runtime.readFile(path);
  const features = await readFgb(bytes);
  const out = [];
  let skipped = 0;
  for (let i = 0; i < features.length; i = i + 1) {
    const record = toLayerFeature(features[i], layerName);
    if (record === null) {
      skipped = skipped + 1;
      continue;
    }
    out.push(record);
  }
  if (skipped > 0) {
    console.log("fgbReader: " + path + ": skipped " + skipped + " unusable feature(s) of " +
      features.length);
  }
  return out;
}

// Best-effort close. A ReadableStream taken from a Deno.FsFile closes the file
// itself once it is fully read or cancelled, so this second close usually throws
// BadResource — which is exactly the case we want to swallow. What it protects
// against is the OTHER case: a consumer that breaks out of the loop early, where
// nothing else would ever close the descriptor.
function closeQuietly(file) {
  try {
    file.close();
  } catch (err) {
    // Already closed by the stream, or never opened. Nothing to do.
  }
}

// THE STREAMING PATH. Async generator yielding one normalized LayerFeature at a
// time from a file, never materialising the layer. Deno-only. Every consumer of a
// coastline / water / lakes layer, and clip-layers.js for EVERY raw layer, must
// use this rather than readLayerFile.
//
// layerName is optional: pass it to stamp the logical layer onto each record
// (the discovery/signals consumers want it), omit it for a pass that only
// re-serializes what it reads (clip-layers.js).
export async function* readFgbStream(path, layerName) {
  const runtime = requireDeno("readFgbStream");
  const file = await runtime.open(path, { read: true });
  let header = null;
  const onHeader = function (meta) { header = meta; };
  let decoded = 0;
  let completed = false;
  let iterator = null;
  try {
    // file.readable is a web ReadableStream, so this takes the library's STREAM
    // branch: the second argument is the rect slot the dispatcher DISCARDS for
    // streams and the third is the headerMetaFn it actually reads. Passing the
    // rect explicitly as undefined is the whole point — see the header comment.
    const source = deserialize(file.readable, undefined, onHeader);
    iterator = source[Symbol.asyncIterator]();
    while (true) {
      let step;
      // Only the DECODE is inside the try. Yielding from inside it would let an
      // exception thrown by the consumer be rewrapped as an artifact error, and
      // "undecodable FlatGeobuf bytes" is a claim this reader must only ever make
      // about bytes.
      try {
        step = await iterator.next();
      } catch (err) {
        throw new Error("fgbReader: undecodable FlatGeobuf bytes: " + errorMessage(err));
      }
      if (step.done) {
        break;
      }
      decoded = decoded + 1;
      const feature = step.value;
      const record = toLayerFeature({
        geometry: feature && feature.geometry !== undefined ? feature.geometry : null,
        properties: feature && feature.properties !== undefined ? feature.properties : {}
      }, layerName);
      if (record !== null) {
        yield record;
      }
    }
    completed = true;
  } finally {
    if (iterator !== null && typeof iterator.return === "function") {
      try {
        await iterator.return();
      } catch (err) {
        // The underlying reader is already released; nothing to unwind.
      }
    }
    closeQuietly(file);
  }
  // Reached only when the loop ran to the end of the file. A consumer that breaks
  // out early terminates the generator at the yield above, so a deliberate early
  // exit can never be mistaken for a truncated artifact.
  if (completed) {
    assertCompleteRead(header, decoded, path);
  }
}
