// scripts/print-spat-bbox.js — prints the ogr2ogr -spat mask (and, under
// --boxes, the per-region box list) derived from src/regions.js REGIONS.
//
// Run from .github/workflows/build-layers.yml, on Deno, with read permission
// only (it touches no network and writes no files):
//
//   SPAT=$(deno run --allow-read scripts/print-spat-bbox.js)
//   ogr2ogr ... -spat $SPAT ...
//
//   deno run --allow-read scripts/print-spat-bbox.js --boxes
//   # one "minLon minLat maxLon maxLat" line per REGIONS entry
//
// WHAT THE UNION RECTANGLE IS, AND WHAT IT IS EMPHATICALLY NOT
// ------------------------------------------------------------
// The default output is the UNION bounding box of every REGIONS entry, padded
// by REGION_SPAT_PAD_DEG on each edge. It is a COARSE PRE-FILTER ONLY. Its one
// job is to bound the raw layer bytes that land on the runner's disk so a
// continental OSM extract does not have to be carved in full.
//
// It is NOT the discovery universe, and no comment, log line or doc may ever
// describe it as one. src/regions.js:11-22 spells out why: a single rectangle
// enclosing all five Great Lakes also encloses the entire continental interior
// between and around them, which is dense with inland lakes. Publishing a layer
// set cut to that rectangle and treating it as the scope would UPSERT thousands
// of interior inland-lake rows that sit OUTSIDE every REGIONS bbox — and are
// therefore permanently un-deletable, because reconciliation scopes its
// delete-candidate set with pointInAnyRegion. The upsert universe and the
// delete-candidate universe would stop being the same set, which is precisely
// the defect this pipeline must not reintroduce.
//
// The AUTHORITATIVE scope is the per-region filter, applied twice:
//
//   1. scripts/clip-layers.js predicate A — keep a feature only if its envelope
//      intersects at least one PADDED REGIONS box. That is the list --boxes
//      prints, and clip-layers.js is its consumer.
//   2. discoverFromLayers' pointInAnyRegion pass, redundantly and finally, on
//      every beach candidate before park association.
//
// Belt and braces on purpose: (1) is what makes the published layers O(beaches)
// instead of O(continent), and (2) is what guarantees the invariant even if (1)
// is ever misconfigured.
//
// WHY THE PADDING
// ---------------
// REGION_SPAT_PAD_DEG (0.05 deg, ~5.5 km) is added to every edge of every box.
// A -spat / envelope filter keeps a feature whose envelope INTERSECTS the mask,
// so a park polygon or a water way that straddles a region edge is kept anyway;
// the pad exists for the features that matter and do NOT straddle — a lake
// polygon whose envelope sits just outside the box while its shoreline sits
// just inside it, which the 150 m classification probe still needs to see. The
// pad is deliberately an order of magnitude wider than every probe radius in
// src/waterClass.js so no padding choice can ever change a classification.
//
// Project style: plain JS, ES modules, const/let only, string concatenation
// with + (never template literals), console for logging.

import { REGIONS } from "../src/regions.js";

// The pad applied to every edge of every region box, for BOTH outputs. Shared
// deliberately: the union mask must be a strict superset of the per-box list,
// or the coarse pre-filter would discard features the authoritative filter
// would have kept — a silent, spatially-contiguous hole in a published layer,
// which is the exact shape the proportional delete rails are worst at catching.
export const REGION_SPAT_PAD_DEG = 0.05;

// Emitted coordinates are rounded to this many decimals (~0.1 m at the equator)
// so 46.2 + 0.05 prints as 46.25 rather than 46.25000000000001. Shell word
// splitting hands the result straight to ogr2ogr, and a 17-significant-digit
// float there is merely ugly — but the rounding below is directional anyway.
const OUTPUT_DECIMALS = 6;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Round OUTWARD, never to nearest: min edges floor, max edges ceil. At 1e-6 deg
// the difference is ~11 cm and cannot matter physically, but the DIRECTION is
// free and the invariant it buys is not — a rounded mask that is never smaller
// than the computed one can never drop a feature the pad was added to keep.
function roundOut(value, direction) {
  const scale = Math.pow(10, OUTPUT_DECIMALS);
  const scaled = value * scale;
  const rounded = direction < 0 ? Math.floor(scaled) : Math.ceil(scaled);
  return rounded / scale;
}

// Renders one number for shell consumption. Number() collapses "-92.450000"
// back to "-92.45"; String() on the result never produces exponent notation in
// the coordinate ranges this pipeline uses (|value| between 1e-6 and 180).
function formatNumber(value) {
  return String(Number(value.toFixed(OUTPUT_DECIMALS)));
}

// Pads one bbox and CLAMPS it to the valid WGS84 domain. Clamping is not
// theoretical once the expansion boxes of src/regions.js land: an Alaska box
// reaches -180 lon and padding it would emit -180.05, which some GDAL builds
// reject outright and others silently reinterpret. Latitude beyond +/-90 is
// meaningless everywhere.
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
// name. This is the list scripts/clip-layers.js consumes for predicate A —
// either by importing this function or by reading the --boxes output.
//
// Throws on a malformed REGIONS entry rather than skipping it. REGIONS is
// repo-committed source, so a bad entry is a commit bug: failing the build
// loudly is right, and silently dropping a region from the mask would carve a
// whole lake out of the published layers with every gate still green.
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

// The union of a list of already-padded boxes. Taking the union AFTER padding
// (rather than padding the union) is the same rectangle here, and it keeps the
// superset relationship between the two outputs true by construction rather
// than by arithmetic coincidence.
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
// actually prints rather than an approximation of it. Returns the complete
// stdout text WITHOUT a trailing newline (main adds it via console.log).
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

// import.meta.main is Deno-only and falsy under vitest/node, so importing the
// pure exports above never reads Deno.args and never prints anything.
if (import.meta.main) {
  const args = parseArgs(Deno.args);
  console.log(renderOutput(REGIONS, args.mode));
}
