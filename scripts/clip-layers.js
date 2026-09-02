// scripts/clip-layers.js — the build-side REGION FILTER and PROXIMITY CLIP.
//
// Runs on Deno inside .github/workflows/build-layers.yml, between the raw
// ogr2ogr conversion and the per-layer FlatGeobuf carve:
//
//   deno run --lock=deno.lock --frozen --allow-read --allow-write \
//     scripts/clip-layers.js --raw "$WORK/raw" --raw-lines "$WORK/raw-lines" \
//     --out "$WORK/clipped"
//
// It reads the FOUR raw GDAL layers (points, lines, multipolygons,
// other_relations) plus the lines-only second pass that carries coastline, and
// writes NINE line-delimited GeoJSONSeq files — one per published layer except
// lakes-polygon.fgb, which is carved straight from the raw multipolygons by
// ogr2ogr and is exempt from both predicates here (its six polygons span the
// whole mask by construction, and the proximity predicate would clip away
// exactly the shoreline the 150 m probe needs).
//
// WHY THIS SCRIPT EXISTS AT ALL — two independent reasons, neither optional.
//
// PREDICATE A, the region filter (contract 1.5 / D18). The ogr2ogr -spat mask is
// the UNION bounding box of src/regions.js REGIONS, and a single rectangle
// enclosing all five Great Lakes also encloses the entire continental interior
// between them — Wisconsin, lower Michigan, Ontario, upstate New York — which is
// dense with INLAND lakes and their beaches. src/regions.js:11-22 is a written
// argument against exactly that. The consequence is not merely wasted bytes: a
// row upserted from the interior sits OUTSIDE every REGIONS bbox, so
// pointInAnyRegion-scoped reconciliation can never consider it a delete
// candidate and it is permanently un-deletable. Predicate A makes the upsert
// universe and the delete-candidate universe the same set, which under Overpass
// they never were.
//
// PREDICATE B, the proximity clip (contract 1.5 / D8). Every layer except the
// beach layers themselves is reduced to features within WATER_CLIP_PAD_DEG
// (0.01 deg, ~1.1 km) of a beach envelope. That is an order of magnitude beyond
// the widest probe radius in the pipeline (OCEAN_RADIUS_M, 150 m) and beyond the
// pond padding (WATER_MATCH_PADDING_DEG 0.001 plus the 60 m evidence radius), so
// it cannot change any classification or park-association decision — and it
// makes every layer O(beaches) instead of O(continent), which is the single
// change that makes the North America expansion tractable. Deliberately NOT an
// area filter on water: the geofabrik survey's MbrArea >= 5e-6 filter would
// delete exactly the sub-threshold ponds isPondBeach needs as EVIDENCE, silently
// disabling the pond filter in the hide direction.
//
// STREAMING, ALWAYS. Every raw layer is consumed through readFgbStream, never
// readLayerFile: the raw water layer is ~120 MB packed and GeoJSON coordinate
// pairs cost roughly 10-20x their FlatGeobuf footprint in a JS heap. The only
// thing this script retains across a pass is the BEACH ENVELOPE SET — four
// numbers per beach — which is what predicate B indexes.
//
// OUTPUT INTEGRITY (contract 1.5, MJ-7/MJ-9). GeoJSONSeq is line-delimited and
// ogr2ogr on a truncated final line WARNS and exits 0, silently dropping the
// tail. So each layer is written to a .tmp path and atomically renamed, and each
// gets a sidecar recording the kept count that scripts/build-manifest.js
// cross-checks against ogrinfo's own count of the re-converted .fgb. A torn tail
// is spatially contiguous (FlatGeobuf is Hilbert-ordered), which is precisely
// the shape the proportional delete rails are worst at catching, so it has to be
// caught here by an exact equality instead.
//
// Project style: ES modules, const/let only, string concatenation with + (never
// template literals), console for logging.

import { REGIONS } from "../src/regions.js";
import { buildLayerGrid, queryGridByBounds } from "../src/layerGrid.js";
import { readFgbStream } from "./lib/fgbReader.js";

// --- constants ----------------------------------------------------------------

// Predicate A's padding, and the same value scripts/print-spat-bbox.js pads the
// UNION rectangle by. The two scripts each hold their own copy on purpose: they
// are separate entrypoints with no shared module, and a shared constant module
// would exist solely to hold one number. If this ever moves, move both.
export const REGION_SPAT_PAD_DEG = 0.05;

// Predicate B's padding. ~1.1 km at these latitudes. See the header for why this
// is an order of magnitude beyond every probe radius rather than tight.
export const WATER_CLIP_PAD_DEG = 0.01;

// The tag keys osmconf.ini promotes for each GDAL SOURCE layer. A published
// layer carries every attribute its source promotes (contract 1.4: "no ogr2ogr
// invocation in this pipeline ever passes -select"), so this table is the
// starting point for each layer's emitted property set — never a subset of it.
//
// protect_class is promoted by osmconf.ini's [multipolygons] section but is
// absent here because it is absent from fgbReader's LAYER_TAG_KEYS: no consumer
// branches on it, and the reader is the only thing that could carry it across.
export const SOURCE_TAG_KEYS = {
  points: ["name", "loc_name", "natural", "leisure", "wikidata"],
  lines: ["name", "loc_name", "natural", "leisure", "boundary", "water", "wikidata"],
  multipolygons: ["name", "loc_name", "type", "natural", "leisure", "boundary", "water", "wikidata"],
  other_relations: ["name", "type", "natural", "water", "wikidata"]
};

// The fields the CONSUMER branches on, per published layer — the "fields" column
// of contract 1.4. Every one of these is emitted on EVERY feature of its layer,
// as an explicit JSON null when the tag is absent.
//
// THE NULLS ARE THE POINT (B3/m10). GDAL infers a GeoJSONSeq schema by scanning
// features, so a field that no early feature carries is simply not created — and
// a dropped wikidata or natural column is the silent mass-hide of every Great
// Lakes beach, since src/waterClass.js matches shoreline by QID. Emitting the
// key unconditionally makes the column exist regardless of which features happen
// to sort first under Hilbert ordering. scripts/build-manifest.js then asserts
// the same table against ogrinfo's reported schema and hard-refuses on a miss.
//
// This table is DUPLICATED in scripts/build-manifest.js, deliberately. That
// script is the gate; a gate that imported its expectations from the thing it
// gates would be checking the producer against itself. Both copies cite contract
// 1.4 and both must move together.
export const PUBLISHED_LAYER_FIELDS = {
  "beaches-point.fgb": ["osm_id", "name", "loc_name", "natural", "leisure"],
  "beaches-line.fgb": ["osm_id", "name", "loc_name", "natural", "leisure"],
  "beaches-polygon.fgb": ["osm_id", "osm_way_id", "name", "loc_name", "natural", "leisure"],
  "parks-polygon.fgb": ["osm_id", "osm_way_id", "name", "leisure", "boundary"],
  "parks-line.fgb": ["osm_id", "name", "leisure", "boundary"],
  "coastline-line.fgb": ["osm_id", "natural"],
  "water-line.fgb": ["osm_id", "name", "natural", "water", "wikidata"],
  "water-polygon.fgb": ["osm_id", "osm_way_id", "name", "natural", "water", "wikidata"],
  "other-relations.fgb": ["osm_id", "name", "loc_name", "type", "natural", "leisure", "boundary"]
};

// --- pure geometry predicates --------------------------------------------------

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// One bbox grown by padDeg on every edge. Degrees on BOTH axes, with no
// cos(lat) correction, exactly like every other envelope threshold in this
// pipeline (contract 1.4: "a raw degree product with no cos(lat) and no
// projection"). A longitude degree is shorter than a latitude degree at these
// latitudes, so the padding is CONSERVATIVE east-west, which is the direction a
// KEEP predicate must err in.
export function padBox(bbox, padDeg) {
  const box = normalizeBox(bbox);
  if (box === null) {
    return null;
  }
  const pad = isFiniteNumber(padDeg) ? padDeg : 0;
  return {
    minLon: box.minLon - pad,
    minLat: box.minLat - pad,
    maxLon: box.maxLon + pad,
    maxLat: box.maxLat + pad
  };
}

// Accepts either shape used in this repo — a REGIONS bbox
// ({minLon,minLat,maxLon,maxLat}) or a fgbReader bounds record
// ({minLat,minLon,maxLat,maxLon}) — and returns the canonical four numbers with
// the min/max ordering forced. They are the same object shape with different key
// ORDER, but forcing the ordering here means a hand-written test fixture with
// its corners swapped cannot silently match nothing.
function normalizeBox(box) {
  if (box === null || typeof box !== "object") {
    return null;
  }
  if (!isFiniteNumber(box.minLon) || !isFiniteNumber(box.minLat) ||
    !isFiniteNumber(box.maxLon) || !isFiniteNumber(box.maxLat)) {
    return null;
  }
  return {
    minLon: Math.min(box.minLon, box.maxLon),
    minLat: Math.min(box.minLat, box.maxLat),
    maxLon: Math.max(box.minLon, box.maxLon),
    maxLat: Math.max(box.minLat, box.maxLat)
  };
}

// INCLUSIVE rectangle overlap — edge-touching counts as intersecting, matching
// src/layerGrid.js queryGridByBounds and src/osmSelect.js boundsOverlap byte for
// byte. A feature straddling a region boundary must be KEPT by both boxes it
// touches; a strict inequality here would drop a park that sits exactly on the
// padded edge and, through it, the park-origin rows that park names.
export function boxesIntersect(a, b) {
  const boxA = normalizeBox(a);
  const boxB = normalizeBox(b);
  if (boxA === null || boxB === null) {
    return false;
  }
  return boxA.minLon <= boxB.maxLon && boxA.maxLon >= boxB.minLon &&
    boxA.minLat <= boxB.maxLat && boxA.maxLat >= boxB.minLat;
}

// The padded REGIONS boxes predicate A tests against. This is the same list
// scripts/print-spat-bbox.js --boxes prints; it is computed here rather than
// shelled out for so that the clip has no dependency on another script's stdout
// formatting, and so the predicate stays testable with synthetic boxes.
export function regionBoxes(regions, padDeg) {
  const source = Array.isArray(regions) ? regions : REGIONS;
  const pad = isFiniteNumber(padDeg) ? padDeg : REGION_SPAT_PAD_DEG;
  const out = [];
  for (let i = 0; i < source.length; i = i + 1) {
    const region = source[i];
    if (region === null || typeof region !== "object") {
      continue;
    }
    const box = padBox(region.bbox, pad);
    if (box === null) {
      continue;
    }
    out.push({ name: region.name, box: box });
  }
  return out;
}

// PREDICATE A. Keep a feature only if its envelope intersects at least one
// PADDED REGIONS bbox. boxes is the output of regionBoxes(). Pure.
//
// A feature with unusable bounds is DROPPED rather than kept: the reader already
// skips features it cannot derive an envelope for, so anything reaching here
// with bad bounds is corrupt, and a corrupt feature that cannot be placed in a
// region cannot be proven in scope either.
export function regionEnvelopeKeep(bounds, boxes) {
  const feature = normalizeBox(bounds);
  if (feature === null || !Array.isArray(boxes)) {
    return false;
  }
  for (let i = 0; i < boxes.length; i = i + 1) {
    const entry = boxes[i];
    const box = entry !== null && typeof entry === "object" && entry.box !== undefined
      ? entry.box
      : entry;
    if (boxesIntersect(feature, box)) {
      return true;
    }
  }
  return false;
}

// The index predicate B queries: every beach envelope, PADDED by padDeg, in a
// src/layerGrid.js envelope grid. The padding lives in the index rather than in
// the query so that "padded by the same amount on both sides" (contract 1.5) is
// expressed once and cannot drift between the two halves.
//
// The grid is Mode A (envelope candidacy) and that is exactly right here: the
// decision IS the envelope test, so the candidate set the grid returns is the
// answer, not a prefilter for a finer one.
export function buildBeachIndex(beachBoundsList, padDeg) {
  const pad = isFiniteNumber(padDeg) ? padDeg : WATER_CLIP_PAD_DEG;
  const list = Array.isArray(beachBoundsList) ? beachBoundsList : [];
  const features = [];
  for (let i = 0; i < list.length; i = i + 1) {
    const padded = padBox(list[i], pad);
    if (padded === null) {
      continue;
    }
    features.push({
      bounds: {
        minLat: padded.minLat,
        minLon: padded.minLon,
        maxLat: padded.maxLat,
        maxLon: padded.maxLon
      }
    });
  }
  return { grid: buildLayerGrid(features), padDeg: pad, count: features.length };
}

// PREDICATE B. Keep a candidate feature iff its envelope, padded by the index's
// padDeg, intersects some PADDED beach envelope. Pure given the index.
//
// An EMPTY index keeps nothing, and that is deliberate: zero beaches in scope
// means every proximity layer is legitimately empty, and inventing a keep rule
// for that case would publish a full continental water layer the moment the
// beach carve broke. The empty layers it produces instead are caught by
// build-manifest.js's floors, which is where a broken carve belongs.
export function proximityKeep(bounds, index) {
  if (index === null || typeof index !== "object" || index.grid === undefined) {
    return false;
  }
  const padded = padBox(bounds, index.padDeg);
  if (padded === null) {
    return false;
  }
  return queryGridByBounds(index.grid, {
    minLat: padded.minLat,
    minLon: padded.minLon,
    maxLat: padded.maxLat,
    maxLon: padded.maxLon
  }).length > 0;
}

// --- pure attribute predicates (the -where column of contract 1.4) -------------

function tagOf(tags, key) {
  if (tags === null || typeof tags !== "object") {
    return null;
  }
  const value = tags[key];
  return typeof value === "string" && value !== "" ? value : null;
}

// natural='beach' OR leisure='beach_resort'.
export function isBeachTags(tags) {
  return tagOf(tags, "natural") === "beach" || tagOf(tags, "leisure") === "beach_resort";
}

// name IS NOT NULL AND (leisure='park' OR leisure='nature_reserve' OR
// boundary='protected_area'). The name requirement is not cosmetic: an unnamed
// park cannot name a beach, and membership comes from parks-polygon regardless.
export function isNamedParkTags(tags) {
  if (tagOf(tags, "name") === null) {
    return false;
  }
  const leisure = tagOf(tags, "leisure");
  return leisure === "park" || leisure === "nature_reserve" ||
    tagOf(tags, "boundary") === "protected_area";
}

// natural='coastline'.
export function isCoastlineTags(tags) {
  return tagOf(tags, "natural") === "coastline";
}

// natural='water'. NO area filter — see D8 and the header.
export function isWaterTags(tags) {
  return tagOf(tags, "natural") === "water";
}

// other-relations carries BOTH halves: beach relations (which become rows) and
// named park relations (which are NAMING ONLY — membership never comes from
// here, because GDAL yields GeometryCollection for other_relations and those
// features have no reliable ring structure).
export function isOtherRelationTags(tags) {
  return isBeachTags(tags) || isNamedParkTags(tags);
}

// --- the layer plan ------------------------------------------------------------

// Every published layer except lakes-polygon.fgb, in two PHASES.
//
// Phase 1 is the beach layers plus other-relations: predicate A only. It also
// accumulates the beach envelope set that phase 2 indexes — which is why the
// phases cannot be merged into one pass per source file. Contract 1.5 states the
// order explicitly: "A on the beach layers first, then A+B on everything else."
//
// beachEnvelope says which phase-1 features contribute an envelope to that set:
// "always" for the three beach layers, "beachOnly" for other-relations (its park
// half is a naming source and must not widen the proximity neighbourhood).
export const LAYER_PLAN = [
  { key: "beaches-point.fgb", name: "beaches-point", source: "points", raw: "raw",
    phase: 1, select: isBeachTags, beachEnvelope: "always", region: "beaches" },
  { key: "beaches-line.fgb", name: "beaches-line", source: "lines", raw: "raw",
    phase: 1, select: isBeachTags, beachEnvelope: "always", region: "beaches" },
  { key: "beaches-polygon.fgb", name: "beaches-polygon", source: "multipolygons", raw: "raw",
    phase: 1, select: isBeachTags, beachEnvelope: "always", region: "beaches" },
  { key: "other-relations.fgb", name: "other-relations", source: "other_relations", raw: "raw",
    phase: 1, select: isOtherRelationTags, beachEnvelope: "beachOnly", region: "other-relations" },
  { key: "parks-polygon.fgb", name: "parks-polygon", source: "multipolygons", raw: "raw",
    phase: 2, select: isNamedParkTags, beachEnvelope: null, region: "parks-polygon" },
  { key: "parks-line.fgb", name: "parks-line", source: "lines", raw: "raw",
    phase: 2, select: isNamedParkTags, beachEnvelope: null, region: "parks-line" },
  { key: "water-line.fgb", name: "water-line", source: "lines", raw: "raw",
    phase: 2, select: isWaterTags, beachEnvelope: null, region: "water" },
  { key: "water-polygon.fgb", name: "water-polygon", source: "multipolygons", raw: "raw",
    phase: 2, select: isWaterTags, beachEnvelope: null, region: "water" },
  // The SOLE source of coastline features (D19): the second GDAL pass reads with
  // osmconf-lines.ini, whose reduced closed_ways_are_polygons list keeps CLOSED
  // coastline ways (islands) in the lines layer instead of routing them into
  // multipolygons. Reading coastline from the main pass instead would both
  // duplicate island coastlines and double-count them in the build floors.
  { key: "coastline-line.fgb", name: "coastline-line", source: "lines", raw: "rawLines",
    phase: 2, select: isCoastlineTags, beachEnvelope: null, region: "coastline" }
];

// --- feature serialization -----------------------------------------------------

// The id fields a published layer carries, by GDAL source layer. osm_id vs
// osm_way_id is the way/relation discriminator and it is load-bearing: the id
// feeds "osm-" + osmType + "-" + osmId, which is BOTH the D1 primary key and the
// KV flag key, so getting it wrong silently orphans every stored flag. Only the
// multipolygons layer has both columns; points and lines features are always
// nodes and ways and carry osm_id alone, and other_relations features are always
// relations.
function idFieldsFor(source) {
  return source === "multipolygons" ? ["osm_id", "osm_way_id"] : ["osm_id"];
}

// The full emitted property key list for a layer: its source layer's promoted
// tags, unioned with the fields contract 1.4 says the consumer branches on, plus
// the id fields. The union is what makes other-relations carry loc_name /
// leisure / boundary keys even though osmconf.ini's [other_relations] section
// does not promote them (see the note in the file header of build-manifest.js);
// they serialize as null today and become real the moment that section grows.
export function layerPropertyKeys(entry) {
  const keys = [];
  const push = function (key) {
    if (keys.indexOf(key) === -1) {
      keys.push(key);
    }
  };
  const ids = idFieldsFor(entry.source);
  for (let i = 0; i < ids.length; i = i + 1) {
    push(ids[i]);
  }
  const required = PUBLISHED_LAYER_FIELDS[entry.key];
  if (Array.isArray(required)) {
    for (let i = 0; i < required.length; i = i + 1) {
      push(required[i]);
    }
  }
  const promoted = SOURCE_TAG_KEYS[entry.source];
  if (Array.isArray(promoted)) {
    for (let i = 0; i < promoted.length; i = i + 1) {
      push(promoted[i]);
    }
  }
  return keys;
}

// One LayerFeature -> one GeoJSON Feature object with a FIXED property key set.
// Ids are emitted as STRINGS because that is how the GDAL OSM driver types
// osm_id / osm_way_id, and fgbReader coerces with Number() on the way back in;
// keeping the type identical to the raw layer means the published schema and the
// raw schema agree field for field.
export function toGeoJsonFeature(record, keys) {
  const properties = {};
  for (let i = 0; i < keys.length; i = i + 1) {
    properties[keys[i]] = null;
  }
  if (Object.prototype.hasOwnProperty.call(properties, "osm_way_id") &&
    record.osmType === "way") {
    properties.osm_way_id = String(record.osmId);
  } else {
    properties.osm_id = String(record.osmId);
  }
  const tags = record.tags === null || typeof record.tags !== "object" ? {} : record.tags;
  for (let i = 0; i < keys.length; i = i + 1) {
    const key = keys[i];
    if (key === "osm_id" || key === "osm_way_id") {
      continue;
    }
    const value = tags[key];
    if (typeof value === "string" && value !== "") {
      properties[key] = value;
    }
  }
  return { type: "Feature", properties: properties, geometry: record.geometry };
}

// --- Deno I/O ------------------------------------------------------------------

// Deno is reached through globalThis so that merely IMPORTING this module stays
// legal under Node (vitest imports it to exercise the pure predicates above).
// Same discipline as scripts/lib/fgbReader.js.
function requireDeno(what) {
  const runtime = globalThis.Deno;
  if (!runtime || typeof runtime.open !== "function") {
    throw new Error("clip-layers: " + what + " requires Deno (globalThis.Deno is unavailable)");
  }
  return runtime;
}

// A buffered line writer. GeoJSONSeq is one JSON object per line, and a per-line
// write syscall on a multi-hundred-thousand-feature layer is minutes of pure
// syscall overhead, so lines accumulate until the buffer passes the flush
// threshold.
const WRITE_FLUSH_BYTES = 1 << 20;

// What a ZERO-FEATURE layer is written as, and it is not an empty file.
//
// MEASURED, and it is a day-one build failure otherwise: GDAL cannot IDENTIFY a
// zero-byte (or newline-only) .geojsonseq at all — "not recognized as being in a
// supported file format" — so the workflow's ogr2ogr conversion loop dies under
// set -euo pipefail. And a zero-feature layer is not hypothetical here:
// coastline-line.fgb is LEGITIMATELY EMPTY at Great Lakes scope, because the
// lakes are mapped as water relations rather than natural=coastline ways (which
// is why 100% of the served Great Lakes rows classify through the wikidata QID
// path). A single empty FeatureCollection line is opened by GDAL's GeoJSON
// driver and converts to a real 0-feature FlatGeobuf.
//
// It is NOT counted in the sidecar: the sidecar says zero, ogrinfo reads zero,
// and build-manifest.js's MJ-7 equality holds. The layer's SCHEMA is empty too,
// which is why that script skips the required-field assertion for a layer whose
// feature count is zero — GDAL cannot infer fields from no features, and an
// empty layer contributes to no decision anyway.
const EMPTY_LAYER_LINE = "{\"type\":\"FeatureCollection\",\"features\":[]}";

function makeWriter(runtime, path) {
  return {
    path: path,
    file: null,
    encoder: new TextEncoder(),
    pending: [],
    pendingBytes: 0,
    count: 0,
    open: async function () {
      this.file = await runtime.open(path, { write: true, create: true, truncate: true });
    },
    writeLine: async function (text) {
      await this.writeRaw(text);
      this.count = this.count + 1;
    },
    // A line that is NOT a kept feature and must not move the count — the
    // zero-feature placeholder above is the only caller.
    writeRaw: async function (text) {
      this.pending.push(text);
      this.pendingBytes = this.pendingBytes + text.length + 1;
      if (this.pendingBytes >= WRITE_FLUSH_BYTES) {
        await this.flush();
      }
    },
    flush: async function () {
      if (this.pending.length === 0) {
        return;
      }
      const chunk = this.encoder.encode(this.pending.join("\n") + "\n");
      this.pending = [];
      this.pendingBytes = 0;
      let offset = 0;
      while (offset < chunk.length) {
        const written = await this.file.write(chunk.subarray(offset));
        if (written <= 0) {
          throw new Error("clip-layers: short write to " + this.path);
        }
        offset = offset + written;
      }
    },
    close: async function () {
      await this.flush();
      this.file.close();
      this.file = null;
    }
  };
}

// --- argument parsing ----------------------------------------------------------

export function parseArgs(argv) {
  const args = { raw: null, rawLines: null, out: null };
  for (let i = 0; i < argv.length; i = i + 1) {
    const a = argv[i];
    if (a === "--raw") { args.raw = argv[++i]; }
    else if (a === "--raw-lines") { args.rawLines = argv[++i]; }
    else if (a === "--out") { args.out = argv[++i]; }
    else { throw new Error("clip-layers: unknown argument: " + a); }
  }
  const missing = [];
  if (!args.raw) { missing.push("--raw"); }
  if (!args.rawLines) { missing.push("--raw-lines"); }
  if (!args.out) { missing.push("--out"); }
  if (missing.length > 0) {
    throw new Error("clip-layers: missing required argument(s): " + missing.join(", "));
  }
  return args;
}

function sourcePathFor(args, entry) {
  const dir = entry.raw === "rawLines" ? args.rawLines : args.raw;
  return dir + "/" + entry.source + ".fgb";
}

// --- the pass ------------------------------------------------------------------

// Region tallies are counted against the SAME padded boxes predicate A uses, so
// "kept by region R" and "counted in region R" can never disagree. Boxes overlap
// where two lakes meet, so a feature may be counted in more than one region and
// the per-region sum can exceed the global count. That is correct for a FLOOR
// (build-manifest.js Level 2 asks "did region R lose features", never "do the
// regions partition the layer") and stating it here is cheaper than a reader
// later "fixing" it into a first-match partition, which would make a feature's
// region depend on REGIONS array order.
function emptyRegionTally(boxes) {
  const tally = {};
  for (let i = 0; i < boxes.length; i = i + 1) {
    tally[boxes[i].name] = 0;
  }
  return tally;
}

function tallyRegions(tally, boxes, bounds) {
  for (let i = 0; i < boxes.length; i = i + 1) {
    if (boxesIntersect(bounds, boxes[i].box)) {
      tally[boxes[i].name] = tally[boxes[i].name] + 1;
    }
  }
}

// One streaming pass over one raw source file, feeding every plan entry that
// reads it. Grouping by file matters: the raw lines layer feeds FOUR published
// layers (beaches-line, parks-line, water-line in the main pass) and re-reading
// a multi-gigabyte layer once per output would dominate the build.
async function runSourcePass(sourcePath, entries, context) {
  let read = 0;
  for await (const record of readFgbStream(sourcePath, null)) {
    read = read + 1;
    // Predicate A is evaluated ONCE per feature rather than once per entry: it
    // does not depend on the layer, and it is the cheap rejection that keeps the
    // continental interior out of every downstream test.
    if (!regionEnvelopeKeep(record.bounds, context.boxes)) {
      continue;
    }
    for (let i = 0; i < entries.length; i = i + 1) {
      const entry = entries[i];
      if (!entry.select(record.tags)) {
        continue;
      }
      if (entry.phase === 2 && !proximityKeep(record.bounds, context.beachIndex)) {
        continue;
      }
      const state = context.states[entry.key];
      await state.writer.writeLine(JSON.stringify(toGeoJsonFeature(record, state.keys)));
      tallyRegions(state.regions, context.boxes, record.bounds);
      if (entry.beachEnvelope === "always" ||
        (entry.beachEnvelope === "beachOnly" && isBeachTags(record.tags))) {
        context.beachBounds.push(record.bounds);
      }
    }
  }
  console.log("clip-layers: read " + String(read) + " feature(s) from " + sourcePath);
}

function groupBySource(args, entries) {
  const groups = [];
  for (let i = 0; i < entries.length; i = i + 1) {
    const path = sourcePathFor(args, entries[i]);
    let group = null;
    for (let g = 0; g < groups.length; g = g + 1) {
      if (groups[g].path === path) {
        group = groups[g];
        break;
      }
    }
    if (group === null) {
      group = { path: path, entries: [] };
      groups.push(group);
    }
    group.entries.push(entries[i]);
  }
  return groups;
}

// The sidecar build-manifest.js reads. JSON rather than a bare integer because
// it carries the per-REGION tallies as well as the global count, and those
// tallies are the ONLY place in the pipeline where per-region counts are
// computed from feature envelopes — build-manifest.js has no geometry access.
// The global "count" field is the one MJ-7 cross-checks against ogrinfo.
function sidecarText(entry, state) {
  return JSON.stringify({
    layer: entry.name,
    key: entry.key,
    count: state.writer.count,
    regions: state.regions
  }, null, 2) + "\n";
}

async function main() {
  const runtime = requireDeno("main");
  const args = parseArgs(runtime.args);
  await runtime.mkdir(args.out, { recursive: true });

  const boxes = regionBoxes(REGIONS, REGION_SPAT_PAD_DEG);
  if (boxes.length === 0) {
    throw new Error("clip-layers: src/regions.js REGIONS yielded no usable boxes");
  }
  console.log("clip-layers: predicate A against " + String(boxes.length) +
    " REGIONS box(es) padded by " + String(REGION_SPAT_PAD_DEG) + " deg");

  const states = {};
  for (let i = 0; i < LAYER_PLAN.length; i = i + 1) {
    const entry = LAYER_PLAN[i];
    const writer = makeWriter(runtime, args.out + "/" + entry.name + ".geojsonseq.tmp");
    await writer.open();
    states[entry.key] = {
      writer: writer,
      keys: layerPropertyKeys(entry),
      regions: emptyRegionTally(boxes)
    };
  }

  const context = {
    boxes: boxes,
    states: states,
    beachBounds: [],
    beachIndex: null
  };

  // PHASE 1 — predicate A on the beach layers and other-relations, accumulating
  // the beach envelope set.
  const phase1 = LAYER_PLAN.filter(function (e) { return e.phase === 1; });
  const groups1 = groupBySource(args, phase1);
  for (let i = 0; i < groups1.length; i = i + 1) {
    await runSourcePass(groups1[i].path, groups1[i].entries, context);
  }
  context.beachIndex = buildBeachIndex(context.beachBounds, WATER_CLIP_PAD_DEG);
  console.log("clip-layers: beach envelope set: " + String(context.beachIndex.count) +
    " envelope(s), padded by " + String(WATER_CLIP_PAD_DEG) + " deg");

  // PHASE 2 — predicate A then predicate B on parks, coastline and water.
  const phase2 = LAYER_PLAN.filter(function (e) { return e.phase === 2; });
  const groups2 = groupBySource(args, phase2);
  for (let i = 0; i < groups2.length; i = i + 1) {
    await runSourcePass(groups2[i].path, groups2[i].entries, context);
  }

  // Close, then atomically rename. Every reader downstream (ogr2ogr, and
  // build-manifest.js reading the sidecar) sees either the previous absence or
  // the finished file, never a half-written one.
  for (let i = 0; i < LAYER_PLAN.length; i = i + 1) {
    const entry = LAYER_PLAN[i];
    const state = states[entry.key];
    if (state.writer.count === 0) {
      await state.writer.writeRaw(EMPTY_LAYER_LINE);
    }
    await state.writer.close();
    const finalPath = args.out + "/" + entry.name + ".geojsonseq";
    await runtime.rename(state.writer.path, finalPath);
    const sidecarTmp = args.out + "/" + entry.name + ".count.tmp";
    await runtime.writeTextFile(sidecarTmp, sidecarText(entry, state));
    await runtime.rename(sidecarTmp, args.out + "/" + entry.name + ".count");
    console.log("clip-layers: " + entry.name + ": kept " + String(state.writer.count) +
      " feature(s)");
  }
  console.log("clip-layers: done");
}

if (import.meta.main) {
  main().catch(function (err) {
    console.error("clip-layers: FATAL: " + (err && err.stack ? err.stack : err));
    Deno.exit(1);
  });
}
