// scripts/build-brand-assets.js — regenerate the committed brand assets under
// public/ (node scripts/build-brand-assets.js [--dest public]).
//
// One flag-on-wave mark built on Font Awesome's solid flag glyph, placed once
// as unit-square geometry and emitted twice: as favicon.svg, and as PNGs
// rasterized here with a small supersampling scan and node:zlib. It also writes manifest.webmanifest from a JS object, so
// the manifest's colors and the icon files can never drift apart.
//
// A raster carries no CSS, so every color below is a Web Awesome mild-palette
// token value copied in literally.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Mild-palette token values (styles/color/palettes/mild.css).
const BLUE_20 = "#02345b";
const BLUE_40 = "#2e5b89";
const BLUE_50 = "#4c78a8";
const BLUE_70 = "#88b2e4";
const BLUE_95 = "#edf3ff";
const WHITE = "#ffffff";

// The four flag colors mean flag condition, so they appear only on the share
// cards, which are the flag. The app icon stays brand blue and white.
const FLAG_HEX = {
  "green": "#4f8051",
  "yellow": "#c6ad4f",
  "red": "#cf443b",
  "double-red": "#cf443b",
  "unknown": "#777478"
};

const OG_COLORS = ["green", "yellow", "red", "double-red", "unknown"];
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

function fail(message) {
  console.log("build-brand-assets: " + message);
  process.exit(1);
}

function parseHex(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ];
}

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (function () {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n = n + 1) {
    let c = n;
    for (let k = 0; k < 8; k = k + 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i = i + 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

// 8-bit truecolor, no alpha channel: every asset paints an opaque background
// first, so an alpha channel would only cost bytes.
function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y = y + 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;
    rgb.copy(raw, rowStart + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// --- Rasterizer -------------------------------------------------------------

const SAMPLES = 3; // 3x3 supersampling, enough for these flat shapes

function makeCanvas(width, height, hex) {
  const rgb = Buffer.alloc(width * height * 3);
  const c = parseHex(hex);
  for (let i = 0; i < width * height; i = i + 1) {
    rgb[i * 3] = c[0];
    rgb[i * 3 + 1] = c[1];
    rgb[i * 3 + 2] = c[2];
  }
  return { width: width, height: height, rgb: rgb };
}

// Paints one shape, given as an inside(x, y) predicate in pixel coordinates,
// blending its color by each pixel's supersampled coverage.
function paint(canvas, hex, inside) {
  const c = parseHex(hex);
  const step = 1 / (SAMPLES + 1);
  for (let py = 0; py < canvas.height; py = py + 1) {
    for (let px = 0; px < canvas.width; px = px + 1) {
      let hits = 0;
      for (let sy = 1; sy <= SAMPLES; sy = sy + 1) {
        for (let sx = 1; sx <= SAMPLES; sx = sx + 1) {
          if (inside(px + sx * step, py + sy * step)) {
            hits = hits + 1;
          }
        }
      }
      if (hits === 0) {
        continue;
      }
      const a = hits / (SAMPLES * SAMPLES);
      const o = (py * canvas.width + px) * 3;
      canvas.rgb[o] = Math.round(canvas.rgb[o] * (1 - a) + c[0] * a);
      canvas.rgb[o + 1] = Math.round(canvas.rgb[o + 1] * (1 - a) + c[1] * a);
      canvas.rgb[o + 2] = Math.round(canvas.rgb[o + 2] * (1 - a) + c[2] * a);
    }
  }
}

function roundRect(x, y, w, h, r) {
  return function (px, py) {
    if (px < x || py < y || px > x + w || py > y + h) {
      return false;
    }
    const cx = Math.min(Math.max(px, x + r), x + w - r);
    const cy = Math.min(Math.max(py, y + r), y + h - r);
    const dx = px - cx;
    const dy = py - cy;
    return (dx * dx + dy * dy) <= r * r;
  };
}

// Everything below one sine crest: the wave band that grounds both marks.
function waveBand(baseY, amplitude, wavelength, phase) {
  return function (px, py) {
    const crest = baseY + amplitude * Math.sin((px / wavelength + phase) * Math.PI * 2);
    return py >= crest;
  };
}

// Shape intersection, the icon's clip: a wave band runs edge to edge, so it
// would square off the rounded background's bottom corners without one.
function intersect(a, b) {
  return function (px, py) {
    return a(px, py) && b(px, py);
  };
}

function polygon(points) {
  return function (px, py) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i = i + 1) {
      const xi = points[i][0];
      const yi = points[i][1];
      const xj = points[j][0];
      const yj = points[j][1];
      if ((yi > py) !== (yj > py) &&
          px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  };
}

// --- The mark ---------------------------------------------------------------

// Font Awesome's solid flag (scripts/flag-solid-full.svg), the same glyph the
// pages render as fa-flag, so the icon and the share cards match the UI. The
// path is read from that file so the glyph has one source; its license comment
// is carried into favicon.svg because the Free icons require attribution.
const GLYPH_SOURCE = fileURLToPath(new URL("./flag-solid-full.svg", import.meta.url));

function loadGlyph() {
  const svg = readFileSync(GLYPH_SOURCE, "utf8");
  const d = /<path d="([^"]+)"/.exec(svg);
  const license = /<!--(.*?)-->/.exec(svg);
  if (!d || !license) {
    fail("cannot find the flag path in " + GLYPH_SOURCE);
  }
  // The glyph's own box, so the pole (x 96..160) and stacked flags share a
  // frame the placement math can reason about.
  return { d: d[1], license: license[1], box: { x0: 96, y0: 64, x1: 544, y1: 576 },
    pole: { x: 96, w: 64 } };
}

const GLYPH = loadGlyph();

const CURVE_STEPS = 12;

// Flattens an absolute M/L/C/Z path into one polygon. The flag is a single
// closed contour, so the even-odd polygon test needs no sub-path handling.
function flattenPath(d) {
  const tokens = d.match(/[MLCZz]|-?\d*\.?\d+/g) || [];
  const points = [];
  let i = 0;
  let cursor = null;
  function num() {
    const value = Number(tokens[i]);
    i = i + 1;
    if (!Number.isFinite(value)) {
      fail("unexpected path token in " + GLYPH_SOURCE);
    }
    return value;
  }
  while (i < tokens.length) {
    const command = tokens[i];
    i = i + 1;
    if (command === "M" || command === "L") {
      cursor = [num(), num()];
      points.push(cursor);
    } else if (command === "C") {
      const c1 = [num(), num()];
      const c2 = [num(), num()];
      const end = [num(), num()];
      const from = cursor;
      for (let k = 1; k <= CURVE_STEPS; k = k + 1) {
        const t = k / CURVE_STEPS;
        const u = 1 - t;
        points.push([
          u * u * u * from[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * end[0],
          u * u * u * from[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * end[1]
        ]);
      }
      cursor = end;
    } else if (command === "Z" || command === "z") {
      break;
    } else {
      fail("unsupported path command " + command + " in " + GLYPH_SOURCE);
    }
  }
  return points;
}

const GLYPH_POINTS = flattenPath(GLYPH.d);

// Vertical distance, in glyph units, between stacked flags: a second banner
// hangs below the first with a gap, both on one pole. Two flags is double-red.
const STACK_UNITS = 370;

// Height of the mark as a fraction of its unit square, and where its center
// sits; a single flag and a stacked pair both fit the same frame, so the
// double-red card draws smaller flags rather than a taller card.
const MARK_HEIGHT = 0.72;
const MARK_CENTER_Y = 0.47;

// The mark in unit-square coordinates: one polygon per flag plus the shared
// pole, so the SVG and the rasterizer read the same numbers.
function flagMark(count) {
  const box = GLYPH.box;
  const y1 = box.y1 + (count - 1) * STACK_UNITS;
  const fit = MARK_HEIGHT / (y1 - box.y0);
  const offsetX = 0.5 - ((box.x0 + box.x1) / 2) * fit;
  const offsetY = MARK_CENTER_Y - ((box.y0 + y1) / 2) * fit;
  const flags = [];
  for (let i = 0; i < count; i = i + 1) {
    const shift = i * STACK_UNITS;
    flags.push(GLYPH_POINTS.map(function (p) {
      return [offsetX + p[0] * fit, offsetY + (p[1] + shift) * fit];
    }));
  }
  return {
    fit: fit,
    offsetX: offsetX,
    offsetY: offsetY,
    flags: flags,
    pole: {
      x: offsetX + GLYPH.pole.x * fit,
      y: offsetY + box.y0 * fit,
      w: GLYPH.pole.w * fit,
      h: (y1 - box.y0) * fit
    }
  };
}

function scalePoints(points, size, offsetX, offsetY) {
  return points.map(function (p) {
    return [offsetX + p[0] * size, offsetY + p[1] * size];
  });
}

// The app icon: brand-blue rounded square, a darker wave, one white flag.
// Never tinted with a flag color — the icon is identity, not condition.
function renderIcon(size) {
  const canvas = makeCanvas(size, size, WHITE);
  const plate = roundRect(0, 0, size, size, size * 0.22);
  paint(canvas, BLUE_40, plate);
  paint(canvas, BLUE_20,
    intersect(plate, waveBand(size * 0.80, size * 0.045, size * 0.9, 0.35)));
  const mark = flagMark(1);
  paint(canvas, WHITE, polygon(scalePoints(mark.flags[0], size, 0, 0)));
  return encodePng(size, size, canvas.rgb);
}

// One 1200x630 share card per display color, deliberately text-free: the
// estimated-or-official wording lives in the page's title and description, so
// the image can never contradict it. The banner takes the flag color and the
// pole is repainted brand blue over it.
function renderOgCard(color) {
  const canvas = makeCanvas(OG_WIDTH, OG_HEIGHT, BLUE_95);
  paint(canvas, BLUE_70, waveBand(OG_HEIGHT * 0.62, OG_HEIGHT * 0.05, OG_WIDTH * 0.55, 0.1));
  paint(canvas, BLUE_50, waveBand(OG_HEIGHT * 0.74, OG_HEIGHT * 0.045, OG_WIDTH * 0.42, 0.6));
  paint(canvas, BLUE_40, waveBand(OG_HEIGHT * 0.86, OG_HEIGHT * 0.04, OG_WIDTH * 0.33, 0.25));
  const mark = flagMark(color === "double-red" ? 2 : 1);
  const size = OG_HEIGHT * 0.86;
  const offsetX = (OG_WIDTH - size) / 2;
  const offsetY = (OG_HEIGHT - size) / 2;
  for (let i = 0; i < mark.flags.length; i = i + 1) {
    paint(canvas, FLAG_HEX[color],
      polygon(scalePoints(mark.flags[i], size, offsetX, offsetY)));
  }
  const pole = mark.pole;
  paint(canvas, BLUE_20, roundRect(offsetX + pole.x * size, offsetY + pole.y * size,
    pole.w * size, pole.h * size, pole.w * size * 0.5));
  return encodePng(OG_WIDTH, OG_HEIGHT, canvas.rgb);
}

function renderFaviconSvg() {
  const mark = flagMark(1);
  const lines = [];
  lines.push("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" " +
    "role=\"img\" aria-label=\"Swim Report\">");
  lines.push("<!--" + GLYPH.license + "-->");
  lines.push("<rect width=\"64\" height=\"64\" rx=\"14\" fill=\"" + BLUE_40 + "\"/>");
  lines.push("<path d=\"M0 48 C 10 42, 22 55, 32 49 S 54 42, 64 48 L64 64 L0 64 Z\" " +
    "fill=\"" + BLUE_20 + "\"/>");
  lines.push("<path transform=\"translate(" + (mark.offsetX * 64).toFixed(3) + " " +
    (mark.offsetY * 64).toFixed(3) + ") scale(" + (mark.fit * 64).toFixed(5) + ")\" " +
    "d=\"" + GLYPH.d + "\" fill=\"" + WHITE + "\"/>");
  lines.push("</svg>");
  return lines.join("\n") + "\n";
}

// Built from an object, never a hand-written string, so it is JSON by
// construction. theme_color and background_color are the light surface, so an
// installed launch never flashes a color the site itself never shows.
function renderManifest() {
  const manifest = {
    name: "Swim Report",
    short_name: "Swim Report",
    description: "Estimated beach hazard flags for Great Lakes and ocean-coast beaches.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: WHITE,
    background_color: WHITE,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }
    ]
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

// --- Main -------------------------------------------------------------------

let dest = "public";
for (let i = 2; i < process.argv.length; i = i + 1) {
  if (process.argv[i] === "--dest") {
    dest = process.argv[i + 1];
    i = i + 1;
  }
}
if (!dest) {
  fail("usage: node scripts/build-brand-assets.js [--dest public]");
}

try {
  mkdirSync(join(dest, "og"), { recursive: true });
  writeFileSync(join(dest, "favicon.svg"), renderFaviconSvg());
  writeFileSync(join(dest, "manifest.webmanifest"), renderManifest());
  writeFileSync(join(dest, "apple-touch-icon.png"), renderIcon(180));
  writeFileSync(join(dest, "icon-192.png"), renderIcon(192));
  writeFileSync(join(dest, "icon-512.png"), renderIcon(512));
  for (let i = 0; i < OG_COLORS.length; i = i + 1) {
    writeFileSync(join(dest, "og", OG_COLORS[i] + ".png"), renderOgCard(OG_COLORS[i]));
  }
} catch (err) {
  fail("cannot write into " + dest + ": " + err.message);
}

console.log("build-brand-assets: wrote " + String(5 + OG_COLORS.length) +
  " files into " + dest);
