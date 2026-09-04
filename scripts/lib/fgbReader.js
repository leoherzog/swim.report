// scripts/lib/fgbReader.js — reads FlatGeobuf bytes into plain feature records.
//
// The one module in the repo with an npm dependency. It runs on Deno (the
// offline layer pipeline) and on Node under vitest, and everything downstream of
// it is pure and dependency-free: the LayerFeature record shape below is the
// single contract crossing the scripts/ to src/ boundary.
//
// It reads a whole file and scans it sequentially, never using the packed
// R-tree, so it behaves identically on ogr2ogr-written layers (indexNodeSize 16)
// and on the JS-serialized in-memory fixtures the tests build (indexNodeSize 0,
// which cannot serve a bbox read at all).
//
// Never call deserialize(stream, rect). The library's dispatcher is
//   deserialize(input, rect, headerMetaFn) =>
//     input instanceof Uint8Array ? deserialize(input, rect, headerMetaFn)
//     : input instanceof ReadableStream ? deserializeStream(input, headerMetaFn)
//     : deserializeFiltered(...)
// so for a stream the second positional argument is read as headerMetaFn and a
// rect passed there is discarded with no error, yielding the whole file instead
// of the filtered subset. Here that would set coastlinePresent for every beach
// and reclassify the whole table. Both call sites below pass the rect slot as an
// explicit undefined and never anything else.
//
// A corrupt layer must never read as an empty one, because an empty layer is
// indistinguishable from "the world has no beaches here" and feeds the only
// delete-bearing job in the repo. The library does not give that for free: a
// buffer truncated inside the feature area throws an opaque RangeError, but one
// truncated in the header region yields zero features and no error. So every
// read here compares the number of features decoded against the featuresCount
// the header declares and throws an identifiable Error on any mismatch. Callers
// must let that throw propagate, never catch it into a "layer is empty" branch.
//
// The flatgeobuf specifier is bare. Deno resolves it through the committed
// deno.json import map ("flatgeobuf/": "npm:/flatgeobuf@4.4.0/") plus deno.lock;
// vitest resolves it through the package.json devDependency and node_modules. A
// literal npm: URL would make every test touching this module fail at collection
// (npm: is a Deno-only URL scheme), and a bare specifier without the map would
// need an npm install on the runner, which the workflows forbid.
//
// Any deno command whose module graph reaches this file must run with
// DENO_NO_PACKAGE_JSON=1. Deno otherwise auto-discovers the repo's package.json
// once the graph contains an npm resolution and eagerly resolves every
// dependency declared there, including the token-gated private-registry
// packages, which fails the whole command on a runner with no .npmrc token. The
// env var stops that discovery; the import map still resolves flatgeobuf from
// the global deno cache with no node_modules on the runner.

import { deserialize } from "flatgeobuf/lib/mjs/geojson.js";

// The OSM tag keys carried across the boundary: everything the pure src/ modules
// branch on, plus the two naming tags, plus "type", which the other-relations
// layer promotes so a consumer can tell a multipolygon relation from another
// relation type.
//
// Values are copied verbatim; src/osmSelect.js owns the loc_name trim. A
// property that is absent, null or empty is omitted rather than carried as null,
// because GDAL writes an unpromoted field as null and a downstream
// if (tags.name) and if (tags.name != null) must not disagree.
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

// A FlatGeobuf file is 8 magic bytes plus a 4-byte header length plus the
// header, so anything shorter cannot be a layer. The guard matters because the
// library's magic-byte check is bytes.subarray(0, 3).every(...), and
// Array.prototype.every on an empty array is vacuously true: a zero-byte
// download would sail past it and read as an empty layer.
const MIN_FGB_BYTES = 12;

function errorMessage(err) {
  if (err && typeof err.message === "string" && err.message !== "") {
    return err.message;
  }
  return String(err);
}

// The truncation trip-wire. A writer that leaves featuresCount at 0 disables the
// check rather than failing every read: it can only fire on a count the file
// itself asserted.
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

// osm_id vs osm_way_id is the way/relation discriminator, and it is
// load-bearing: the id feeds "osm-" + osmType + "-" + osmId, which is both the
// D1 primary key and the KV flag key, and src/layerSignals.js gates
// nearbyWayWater on type "way" and nearbyLakeQids on type "relation". Getting it
// wrong silently orphans every stored flag.
//
// The rule is stated per GDAL source layer (points -> node, lines -> way,
// multipolygons -> osm_way_id ? way : relation), but layerName here is the
// logical layer ("beaches" spans the points, lines and multipolygons files), so
// the source layer is not recoverable from it. The geometry type is, and it is
// in bijection with the source layer for the layers this pipeline publishes, so
// the derivation below is the same rule read off the geometry.
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
    // features are relations by definition. They are consumed by envelope only:
    // they have no reliable ring structure and must never reach a
    // point-in-polygon test.
    return { osmType: "relation", rawId: properties.osm_id };
  }
  return null;
}

// Recursive coordinate walk. GeoJSON nests positions to a different depth per
// geometry type and a GeometryCollection mixes depths inside one feature, so
// walking generically is safer than a per-type switch. A position carrying a
// third element is fine: only [0] and [1] are read.
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

// Bounds are computed here by walking every coordinate, never taken from a
// driver-provided envelope, so a node degenerates to a zero-extent envelope.
// That is what makes a node beach's areaDeg2 zero and therefore always
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

// Maps one decoded GeoJSON feature onto the record shape the pure src/ modules
// consume:
//
//   { layer, osmType, osmId, tags, bounds, geometry }
//
// Returns null (skip, never throw) when the geometry is null, the id is not a
// finite number, or the geometry yields no coordinates. A skip is a per-feature
// data problem; a throw is an artifact problem. Conflating the two is how a bad
// download becomes an empty layer, so the paths stay separate and the caller
// logs skips.
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

// Returns an array of { geometry, properties } in file order. Throws on
// undecodable bytes: a corrupt download must never read as an empty layer. Not
// layer-aware and not Deno-bound, so the tests exercise it on in-memory
// fixtures.
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
    // The second argument is the rect slot and stays undefined. This is the
    // Uint8Array branch, which does honour a rect, but honouring it would mean
    // trusting the packed R-tree that JS-serialized fixtures lack.
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

// Deno.readFile and Deno.open are reached through globalThis so that importing
// this module stays legal under Node, where vitest tests the pure half. The two
// file readers below are the Deno-only surface and say so when called elsewhere.
function requireDeno(what) {
  const runtime = globalThis.Deno;
  if (!runtime || typeof runtime.readFile !== "function" || typeof runtime.open !== "function") {
    throw new Error("fgbReader: " + what + " requires Deno (globalThis.Deno is unavailable) — " +
      "use readFgb(bytes) on other runtimes");
  }
  return runtime;
}

// Reads a file path, decodes it and normalizes every feature. Deno-only.
//
// Only for layers whose whole geometry must be retained: beaches and parks.
// Never for coastline, water or lakes, where GeoJSON coordinate pairs cost
// roughly 10-20x their packed FlatGeobuf footprint in a JS heap. Those go
// through readFgbStream.
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
// once it is fully read or cancelled, so this second close usually throws
// BadResource, which is the case being swallowed. It protects the other case: a
// consumer that breaks out early, where nothing else closes the descriptor.
function closeQuietly(file) {
  try {
    file.close();
  } catch (err) {
    // Already closed by the stream, or never opened. Nothing to do.
  }
}

// The streaming path: an async generator yielding one normalized LayerFeature at
// a time, never materialising the layer. Deno-only. Every consumer of a
// coastline, water or lakes layer, and clip-layers.js for every raw layer, must
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
    // file.readable is a web ReadableStream, so this takes the library's stream
    // branch, where the dispatcher discards the second argument and reads the
    // third as headerMetaFn. The rect slot stays an explicit undefined.
    const source = deserialize(file.readable, undefined, onHeader);
    iterator = source[Symbol.asyncIterator]();
    while (true) {
      let step;
      // Only the decode is inside the try. Yielding from inside it would let a
      // consumer's exception be rewrapped as an artifact error, and "undecodable
      // FlatGeobuf bytes" is a claim this reader makes only about bytes.
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
  // Reached only when the loop ran to the end of the file. A consumer that
  // breaks out early terminates the generator at the yield above, so a
  // deliberate early exit is never mistaken for a truncated artifact.
  if (completed) {
    assertCompleteRead(header, decoded, path);
  }
}
