// scripts/print-spat-bbox.js — prints the ogr2ogr -spat mask (and, under
// --boxes, the per-region box list) derived from src/regions.js REGIONS.
//
// Run from .github/workflows/build-layers.yml, on Deno, with read permission
// only:
//
//   SPAT=$(deno run --allow-read scripts/print-spat-bbox.js)
//   ogr2ogr ... -spat $SPAT ...
//
//   deno run --allow-read scripts/print-spat-bbox.js --boxes
//   # one "minLon minLat maxLon maxLat" line per REGIONS entry
//
// The default output is the union bounding box of every REGIONS entry, padded
// by REGION_SPAT_PAD_DEG on each edge. It is a coarse pre-filter whose only job
// is to bound the raw layer bytes that land on the runner's disk.
//
// It is not the discovery universe, and no comment, log line or doc may
// describe it as one. A single rectangle enclosing all five Great Lakes also
// encloses the continental interior between them, which is dense with inland
// lakes; treating it as the scope would upsert thousands of interior rows that
// sit outside every REGIONS bbox and are therefore permanently un-deletable,
// since reconciliation scopes its delete candidates with pointInAnyRegion. The
// upsert universe and the delete-candidate universe must stay the same set.
//
// The authoritative scope is the per-region filter, applied twice: predicate A
// in scripts/clip-layers.js keeps a feature only if its envelope intersects at
// least one padded REGIONS box (the list --boxes prints), and discoverFromLayers
// runs pointInAnyRegion again on every beach candidate before park association.
// The first makes the published layers O(beaches) rather than O(continent); the
// second holds the invariant even if the first is ever misconfigured.
//
// REGION_SPAT_PAD_DEG (0.05 deg, ~5.5 km) is added to every edge of every box.
// An envelope filter already keeps a feature that straddles a region edge, so
// the pad exists for the ones that do not: a lake polygon whose envelope sits
// just outside the box while its shoreline sits just inside, which the 150 m
// classification probe still needs to see. The pad is an order of magnitude
// wider than every probe radius in src/waterClass.js, so no padding choice can
// change a classification.

import { REGIONS } from "../src/regions.js";

// Shared by both outputs: the union mask must be a strict superset of the
// per-box list, or the coarse pre-filter would discard features the
// authoritative filter would have kept, leaving a spatially-contiguous hole in
// a published layer — the shape the proportional delete rails catch worst.
export const REGION_SPAT_PAD_DEG = 0.05;

// Emitted coordinates are rounded to this many decimals (~0.1 m at the equator)
// so 46.2 + 0.05 prints as 46.25 rather than 46.25000000000001.
const OUTPUT_DECIMALS = 6;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Round outward, never to nearest: min edges floor, max edges ceil. A rounded
// mask that is never smaller than the computed one cannot drop a feature the
// pad was added to keep.
function roundOut(value, direction) {
  const scale = Math.pow(10, OUTPUT_DECIMALS);
  const scaled = value * scale;
  const rounded = direction < 0 ? Math.floor(scaled) : Math.ceil(scaled);
  return rounded / scale;
}

// Number() collapses "-92.450000" back to "-92.45"; String() never produces
// exponent notation in the coordinate range this pipeline uses.
function formatNumber(value) {
  return String(Number(value.toFixed(OUTPUT_DECIMALS)));
}

// Pads one bbox and clamps it to the valid WGS84 domain. An Alaska box reaches
// -180 lon and padding it would emit -180.05, which some GDAL builds reject
// outright and others silently reinterpret.
export function padBbox(bbox, padDeg) {
  if (bbox === null || typeof bbox !== "object") {
    throw new Error("print-spat-bbox: bbox is not an object");
  }
  const edges = ["minLon", "minLat", "maxLon", "maxLat"];
  for (let i = 0; i < edges.length; i = i + 1) {
    if (!isFiniteNumber(bbox[edges[i]])) {
      throw new Error("print-spat-bbox: bbox." + edges[i] + " is not a finite number");
    }
  }
  return {
    minLon: Math.max(-180, roundOut(bbox.minLon - padDeg, -1)),
    minLat: Math.max(-90, roundOut(bbox.minLat - padDeg, -1)),
    maxLon: Math.min(180, roundOut(bbox.maxLon + padDeg, 1)),
    maxLat: Math.min(90, roundOut(bbox.maxLat + padDeg, 1))
  };
}

// One padded box per REGIONS entry, in REGIONS order, each carrying its region
// name — the list clip-layers.js consumes for predicate A.
//
// Throws on a malformed REGIONS entry rather than skipping it: silently
// dropping a region from the mask would carve a whole lake out of the published
// layers with every gate still green.
export function paddedRegionBoxes(regions, padDeg) {
  const source = regions === undefined ? REGIONS : regions;
  const pad = padDeg === undefined ? REGION_SPAT_PAD_DEG : padDeg;
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error("print-spat-bbox: expected a non-empty regions array");
  }
  const out = [];
  for (let i = 0; i < source.length; i = i + 1) {
    const region = source[i];
    if (region === null || typeof region !== "object") {
      throw new Error("print-spat-bbox: region " + String(i) + " is not an object");
    }
    if (typeof region.name !== "string" || region.name === "") {
      throw new Error("print-spat-bbox: region " + String(i) + " has no name");
    }
    out.push({ name: region.name, bbox: padBbox(region.bbox, pad) });
  }
  return out;
}

// The union of already-padded boxes. Taking the union after padding, rather
// than padding the union, keeps the superset relationship between the two
// outputs true by construction.
export function unionBbox(boxes) {
  if (!Array.isArray(boxes) || boxes.length === 0) {
    throw new Error("print-spat-bbox: expected a non-empty box list");
  }
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (let i = 0; i < boxes.length; i = i + 1) {
    const bbox = boxes[i].bbox === undefined ? boxes[i] : boxes[i].bbox;
    minLon = Math.min(minLon, bbox.minLon);
    minLat = Math.min(minLat, bbox.minLat);
    maxLon = Math.max(maxLon, bbox.maxLon);
    maxLat = Math.max(maxLat, bbox.maxLat);
  }
  return { minLon: minLon, minLat: minLat, maxLon: maxLon, maxLat: maxLat };
}

// "minLon minLat maxLon maxLat" — the exact argument order ogr2ogr -spat wants.
export function formatBbox(bbox) {
  return formatNumber(bbox.minLon) + " " + formatNumber(bbox.minLat) + " " +
    formatNumber(bbox.maxLon) + " " + formatNumber(bbox.maxLat);
}

// The whole program as one pure function, so the tests exercise what the CLI
// prints. Returns the stdout text without a trailing newline.
export function renderOutput(regions, mode) {
  const boxes = paddedRegionBoxes(regions, REGION_SPAT_PAD_DEG);
  if (mode === "boxes") {
    const lines = [];
    for (let i = 0; i < boxes.length; i = i + 1) {
      lines.push(formatBbox(boxes[i].bbox));
    }
    return lines.join("\n");
  }
  return formatBbox(unionBbox(boxes));
}

export function parseArgs(argv) {
  const args = { mode: "union" };
  for (let i = 0; i < argv.length; i = i + 1) {
    const a = argv[i];
    if (a === "--boxes") { args.mode = "boxes"; }
    else { throw new Error("unknown argument: " + a); }
  }
  return args;
}

if (import.meta.main) {
  const args = parseArgs(Deno.args);
  console.log(renderOutput(REGIONS, args.mode));
}
