// scripts/clip-layers.js — the build-side region filter and proximity clip.
//
// Runs on Deno inside .github/workflows/build-layers.yml, between the raw
// ogr2ogr conversion and the per-layer FlatGeobuf carve:
//
//   deno run --lock=deno.lock --frozen --allow-read --allow-write \
//     scripts/clip-layers.js --raw "$WORK/raw" --raw-lines "$WORK/raw-lines" \
//     --out "$WORK/clipped"
//
// It reads the four raw GDAL layers (points, lines, multipolygons,
// other_relations) plus the lines-only second pass that carries coastline, and
// writes nine line-delimited GeoJSONSeq files, one per published layer except
// lakes-polygon.fgb. That one is carved straight from the raw multipolygons by
// ogr2ogr and is exempt from both predicates here: its six polygons span the
// whole mask by construction, and the proximity predicate would clip away exactly
// the shoreline the 150 m probe needs.
//
// Predicate A, the region filter. The ogr2ogr -spat mask is the union bounding box
// of src/regions.js REGIONS, and a single rectangle enclosing all five Great Lakes
// also encloses the continental interior between them, which is dense with inland
// lakes and their beaches. The consequence is not merely wasted bytes: a row
// upserted from the interior sits outside every REGIONS bbox, so
// pointInAnyRegion-scoped reconciliation can never consider it a delete candidate
// and it is permanently un-deletable. Predicate A makes the upsert universe and
// the delete-candidate universe the same set.
//
// Predicate B, the proximity clip. Every layer except the beach layers is reduced
// to features within WATER_CLIP_PAD_DEG (0.01 deg, ~1.1 km) of a beach envelope.
// That is an order of magnitude beyond the widest probe radius in the pipeline
// (OCEAN_RADIUS_M, 150 m) and beyond the pond padding, so it cannot change a
// classification or park-association decision, and it makes every layer
// O(beaches) rather than O(continent). Deliberately not an area filter on water:
// an MbrArea threshold would delete exactly the sub-threshold ponds isPondBeach
// needs as evidence, silently disabling the pond filter in the hide direction.
//
// Streaming, always. Every raw layer is consumed through readFgbStream, never
// readLayerFile: the raw water layer is ~120 MB packed and GeoJSON coordinate
// pairs cost roughly 10-20x their FlatGeobuf footprint in a JS heap. The only
// thing retained across a pass is the beach envelope set, four numbers per beach,
// which is what predicate B indexes.
//
// Output integrity. GeoJSONSeq is line-delimited and ogr2ogr on a truncated final
// line warns and exits 0, silently dropping the tail. So each layer is written to
// a .tmp path and atomically renamed, and each gets a sidecar recording the kept
// count that scripts/build-manifest.js cross-checks against ogrinfo's own count of
// the re-converted .fgb. A torn tail is spatially contiguous, because FlatGeobuf
// is Hilbert-ordered, which is the shape the proportional delete rails are worst
// at catching, so it has to be caught here by an exact equality.

import { REGIONS } from "../src/regions.js";
import { buildLayerGrid, queryGridByBounds } from "../src/layerGrid.js";
import { readFgbStream } from "./lib/fgbReader.js";

// --- constants ----------------------------------------------------------------

// Predicate A's padding, and the same value scripts/print-spat-bbox.js pads the
// union rectangle by. Each script holds its own copy because they are separate
// entrypoints with no shared module. If this moves, move both.
export const REGION_SPAT_PAD_DEG = 0.05;

// Predicate B's padding. ~1.1 km at these latitudes. See the header for why this
// is an order of magnitude beyond every probe radius rather than tight.
export const WATER_CLIP_PAD_DEG = 0.01;

// The tag keys osmconf.ini promotes for each GDAL source layer. No ogr2ogr
// invocation in this pipeline passes -select, so a published layer carries every
// attribute its source promotes and this table is the starting point for each
// layer's emitted property set, never a subset of it.
//
// protect_class is promoted by osmconf.ini's [multipolygons] section but is absent
// here because it is absent from fgbReader's LAYER_TAG_KEYS: no consumer branches
// on it, and the reader is the only thing that could carry it across.
export const SOURCE_TAG_KEYS = {
  points: ["name", "loc_name", "natural", "leisure", "wikidata"],
  lines: ["name", "loc_name", "natural", "leisure", "boundary", "water", "wikidata"],
  multipolygons: ["name", "loc_name", "type", "natural", "leisure", "boundary", "water", "wikidata"],
  other_relations: ["name", "type", "natural", "water", "wikidata"]
};

// The fields the consumer branches on, per published layer. Every one is emitted
// on every feature of its layer, as an explicit JSON null when the tag is absent.
//
// The nulls are the point. GDAL infers a GeoJSONSeq schema by scanning features,
// so a field no early feature carries is never created, and a dropped wikidata or
// natural column silently mass-hides every Great Lakes beach, since
// src/waterClass.js matches shoreline by QID. Emitting the key unconditionally
// makes the column exist regardless of which features sort first under Hilbert
// ordering. scripts/build-manifest.js then asserts the same table against
// ogrinfo's reported schema and hard-refuses on a miss.
//
// This table is duplicated in scripts/build-manifest.js deliberately: that script
// is the gate, and a gate importing its expectations from the thing it gates would
// be checking the producer against itself. Both copies must move together.
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

// One bbox grown by padDeg on every edge. Degrees on both axes with no cos(lat)
// correction, like every other envelope threshold in this pipeline. A longitude
// degree is shorter than a latitude degree at these latitudes, so the padding is
// conservative east-west, which is the direction a keep predicate must err in.
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

// Inclusive rectangle overlap: edge-touching counts as intersecting, matching
// src/layerGrid.js queryGridByBounds and src/osmSelect.js boundsOverlap byte for
// byte. A feature straddling a region boundary must be kept by both boxes it
// touches; a strict inequality here would drop a park sitting exactly on the
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

// The padded REGIONS boxes predicate A tests against, the same list
// scripts/print-spat-bbox.js --boxes prints. Computed here rather than shelled out
// for, so the clip depends on no other script's stdout formatting and the
// predicate stays testable with synthetic boxes.
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

// Predicate A: keep a feature only if its envelope intersects at least one padded
// REGIONS bbox. boxes is the output of regionBoxes(). Pure.
//
// A feature with unusable bounds is dropped rather than kept. The reader already
// skips features it cannot derive an envelope for, so anything reaching here with
// bad bounds is corrupt, and a corrupt feature that cannot be placed in a region
// cannot be proven in scope either.
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

// The index predicate B queries: every beach envelope, padded by padDeg, in a
// src/layerGrid.js envelope grid. The padding lives in the index rather than the
// query so that padding both sides by the same amount is expressed once and cannot
// drift between the halves.
//
// The grid is in envelope-candidacy mode, which is right here: the decision is the
// envelope test, so the candidate set the grid returns is the answer rather than a
// prefilter for a finer one.
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

// Predicate B: keep a candidate feature iff its envelope, padded by the index's
// padDeg, intersects some padded beach envelope. Pure given the index.
//
// An empty index keeps nothing, deliberately. Zero beaches in scope means every
// proximity layer is legitimately empty, and inventing a keep rule for that case
// would publish a full continental water layer the moment the beach carve broke.
// The empty layers it produces instead are caught by build-manifest.js's floors.
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

// --- pure attribute predicates ------------------------------------------------

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

// natural='water'. No area filter — see the header.
export function isWaterTags(tags) {
  return tagOf(tags, "natural") === "water";
}

// other-relations carries both halves: beach relations, which become rows, and
// named park relations, which are naming only. Membership never comes from here,
// because GDAL yields GeometryCollection for other_relations and those features
// have no reliable ring structure.
export function isOtherRelationTags(tags) {
  return isBeachTags(tags) || isNamedParkTags(tags);
}

// --- the layer plan ------------------------------------------------------------

// Every published layer except lakes-polygon.fgb, in two phases: A on the beach
// layers first, then A and B on everything else.
//
// Phase 1 is the beach layers plus other-relations under predicate A alone. It
// also accumulates the beach envelope set phase 2 indexes, which is why the phases
// cannot be merged into one pass per source file.
//
// beachEnvelope says which phase-1 features contribute an envelope to that set:
// "always" for the three beach layers, "beachOnly" for other-relations, whose park
// half is a naming source and must not widen the proximity neighbourhood.
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
  // The sole source of coastline features: the second GDAL pass reads with
  // osmconf-lines.ini, whose reduced closed_ways_are_polygons list keeps closed
  // coastline ways (islands) in the lines layer instead of routing them into
  // multipolygons. Reading coastline from the main pass would both duplicate
  // island coastlines and double-count them in the build floors.
  { key: "coastline-line.fgb", name: "coastline-line", source: "lines", raw: "rawLines",
    phase: 2, select: isCoastlineTags, beachEnvelope: null, region: "coastline" }
];

// --- feature serialization -----------------------------------------------------

// The id fields a published layer carries, by GDAL source layer. osm_id vs
// osm_way_id is the way/relation discriminator and it is load-bearing: the id
// feeds "osm-" + osmType + "-" + osmId, which is both the D1 primary key and the
// KV flag key, so getting it wrong silently orphans every stored flag. Only the
// multipolygons layer has both columns; points and lines features carry osm_id
// alone, and other_relations features are always relations.
function idFieldsFor(source) {
  return source === "multipolygons" ? ["osm_id", "osm_way_id"] : ["osm_id"];
}

// The full emitted property key list for a layer: its source layer's promoted
// tags, unioned with the fields the consumer branches on, plus the id fields. The
// union is what makes other-relations carry loc_name, leisure and boundary keys
// even though osmconf.ini's [other_relations] section does not promote them; they
// serialize as null and become real the moment that section grows.
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

// One LayerFeature -> one GeoJSON Feature object with a fixed property key set.
// Ids are emitted as strings because that is how the GDAL OSM driver types osm_id
// and osm_way_id, and fgbReader coerces with Number() on the way back in; keeping
// the type identical means the published schema and the raw schema agree field for
// field.
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

// Deno is reached through globalThis so importing this module stays legal under
// Node, where vitest exercises the pure predicates above.
function requireDeno(what) {
  const runtime = globalThis.Deno;
  if (!runtime || typeof runtime.open !== "function") {
    throw new Error("clip-layers: " + what + " requires Deno (globalThis.Deno is unavailable)");
  }
  return runtime;
}

// A buffered line writer. GeoJSONSeq is one JSON object per line, and a per-line
// write syscall on a layer this size is minutes of syscall overhead, so lines
// accumulate until the buffer passes the flush threshold.
const WRITE_FLUSH_BYTES = 1 << 20;

// What a zero-feature layer is written as, and it is not an empty file. GDAL
// cannot identify a zero-byte or newline-only .geojsonseq at all ("not recognized
// as being in a supported file format"), so the workflow's ogr2ogr conversion loop
// would die under set -euo pipefail. A zero-feature layer is not hypothetical:
// coastline-line.fgb is legitimately empty at Great Lakes scope, because the lakes
// are mapped as water relations rather than natural=coastline ways. A single empty
// FeatureCollection line is opened by GDAL's GeoJSON driver and converts to a real
// 0-feature FlatGeobuf.
//
// It is not counted in the sidecar: the sidecar says zero, ogrinfo reads zero, and
// build-manifest.js's equality holds. The layer's schema is empty too, which is
// why that script skips the required-field assertion for a layer whose feature
// count is zero.
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
    // A line that is not a kept feature and must not move the count; the
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

// Region tallies are counted against the same padded boxes predicate A uses, so
// "kept by region R" and "counted in region R" cannot disagree. Boxes overlap
// where two lakes meet, so a feature may be counted in more than one region and
// the per-region sum can exceed the global count. That is correct for a floor,
// which asks whether region R lost features rather than whether the regions
// partition the layer; turning it into a first-match partition would make a
// feature's region depend on REGIONS array order.
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

// One streaming pass over one raw source file, feeding every plan entry that reads
// it. Grouping by file matters: the raw lines layer feeds several published layers
// and re-reading a multi-gigabyte layer once per output would dominate the build.
async function runSourcePass(sourcePath, entries, context) {
  let read = 0;
  for await (const record of readFgbStream(sourcePath, null)) {
    read = read + 1;
    // Predicate A is evaluated once per feature rather than once per entry: it
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

// The sidecar build-manifest.js reads. JSON rather than a bare integer because it
// carries the per-region tallies as well as the global count, and those tallies
// are the only place in the pipeline where per-region counts are computed from
// feature envelopes; build-manifest.js has no geometry access. The global "count"
// field is the one cross-checked against ogrinfo.
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

  // Phase 1 — predicate A on the beach layers and other-relations, accumulating
  // the beach envelope set.
  const phase1 = LAYER_PLAN.filter(function (e) { return e.phase === 1; });
  const groups1 = groupBySource(args, phase1);
  for (let i = 0; i < groups1.length; i = i + 1) {
    await runSourcePass(groups1[i].path, groups1[i].entries, context);
  }
  context.beachIndex = buildBeachIndex(context.beachBounds, WATER_CLIP_PAD_DEG);
  console.log("clip-layers: beach envelope set: " + String(context.beachIndex.count) +
    " envelope(s), padded by " + String(WATER_CLIP_PAD_DEG) + " deg");

  // Phase 2 — predicate A then predicate B on parks, coastline and water.
  const phase2 = LAYER_PLAN.filter(function (e) { return e.phase === 2; });
  const groups2 = groupBySource(args, phase2);
  for (let i = 0; i < groups2.length; i = i + 1) {
    await runSourcePass(groups2[i].path, groups2[i].entries, context);
  }

  // Close, then atomically rename. Every downstream reader sees either the
  // previous absence or the finished file, never a half-written one.
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
