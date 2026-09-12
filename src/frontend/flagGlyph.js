// The Font Awesome solid flag glyph and the favicon SVG drawn from it, shared by
// the document head (src/frontend/render.js) and scripts/build-brand-assets.js so
// the tab icon, the static favicon and the share cards are one shape. Pure: no
// fetch, no Date, no DOM.

// Copied from scripts/flag-solid-full.svg, the upstream Font Awesome file;
// test/flagGlyph.test.js holds the two equal. The Free license requires the
// attribution wherever the glyph ships, so every SVG built here carries it.
export const FLAG_GLYPH_LICENSE = "!Font Awesome Free 7.3.1 by @fontawesome - " +
  "https://fontawesome.com License - https://fontawesome.com/license/free " +
  "Copyright 2026 Fonticons, Inc.";

export const FLAG_GLYPH_PATH = "M160 96C160 78.3 145.7 64 128 64C110.3 64 96 78.3 96 96" +
  "L96 544C96 561.7 110.3 576 128 576C145.7 576 160 561.7 160 544L160 422.4L222.7 403.6" +
  "C264.6 391 309.8 394.9 348.9 414.5C391.6 435.9 441.4 438.5 486.1 421.7L523.2 407.8" +
  "C535.7 403.1 544 391.2 544 377.8L544 130.1C544 107.1 519.8 92.1 499.2 102.4" +
  "L487.4 108.3C442.5 130.8 389.6 130.8 344.6 108.3C308.2 90.1 266.3 86.5 227.4 98.2" +
  "L160 118.4L160 96z";

// The glyph's frame, the flag's own box inside it and the pole's column, all in
// glyph units. The flag sits centered in the frame, so a single flag needs no
// placement at all.
export const FLAG_GLYPH_FRAME = 640;
export const FLAG_GLYPH_BOX = { x0: 96, y0: 64, x1: 544, y1: 576 };
export const FLAG_GLYPH_POLE = { x: 96, w: 64 };

// Vertical distance between stacked flags: a second banner hangs below the
// first on the same pole, which is double-red.
export const FLAG_STACK_UNITS = 370;

// Favicon colors as mild-palette hex pairs, light then dark. An SVG favicon reads
// no page CSS, so like the theme-color metas these are the token values copied
// in literally; the dark step is the one styles.js gives --flag-*. Brand is
// blue-40 / blue-70, the identity color, never a condition.
export const FAVICON_HEX = {
  "brand": { light: "#2e5b89", dark: "#88b2e4" },
  "green": { light: "#4f8051", dark: "#6ea16f" },
  "yellow": { light: "#c6ad4f", dark: "#e3c868" },
  "red": { light: "#cf443b", dark: "#e47468" },
  "double-red": { light: "#cf443b", dark: "#e47468" },
  "unknown": { light: "#777478", dark: "#979498" }
};

function escapeAttr(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The flag glyph as a complete SVG document in the color keyed by colorKey
// (a FAVICON_HEX key; anything else draws unknown). double-red stacks two flags
// on one pole and scales the pair to the height of one, so both read at favicon
// size. The fill swaps for a dark color scheme inside the SVG itself.
export function renderFlagSvg(colorKey, label) {
  const hex = FAVICON_HEX[colorKey] || FAVICON_HEX.unknown;
  const count = colorKey === "double-red" ? 2 : 1;
  const box = FLAG_GLYPH_BOX;
  const lines = [];
  lines.push("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 " +
    FLAG_GLYPH_FRAME + " " + FLAG_GLYPH_FRAME + "\" role=\"img\" aria-label=\"" +
    escapeAttr(label) + "\">");
  lines.push("<!--" + FLAG_GLYPH_LICENSE + "-->");
  lines.push("<style>path{fill:" + hex.light + "}@media (prefers-color-scheme:dark){path{fill:" +
    hex.dark + "}}</style>");
  if (count === 1) {
    lines.push("<path d=\"" + FLAG_GLYPH_PATH + "\"/>");
  } else {
    const y1 = box.y1 + (count - 1) * FLAG_STACK_UNITS;
    const scale = (box.y1 - box.y0) / (y1 - box.y0);
    const tx = (FLAG_GLYPH_FRAME - (box.x1 - box.x0) * scale) / 2 - box.x0 * scale;
    const ty = box.y0 - box.y0 * scale;
    lines.push("<g transform=\"translate(" + tx.toFixed(3) + " " + ty.toFixed(3) +
      ") scale(" + scale.toFixed(5) + ")\">");
    for (let i = 0; i < count; i = i + 1) {
      const shift = i === 0 ? "" : (" transform=\"translate(0 " + (i * FLAG_STACK_UNITS) + ")\"");
      lines.push("<path" + shift + " d=\"" + FLAG_GLYPH_PATH + "\"/>");
    }
    lines.push("</g>");
  }
  lines.push("</svg>");
  return lines.join("\n") + "\n";
}
