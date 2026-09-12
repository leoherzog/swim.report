// test/flagGlyph.test.js
// Covers the shared flag glyph module (src/frontend/flagGlyph.js): the path and
// attribution match the upstream Font Awesome file, and renderFlagSvg draws one
// flag, or two stacked for double-red, with its light and dark fill inside the
// SVG. The document head's use of it is covered in test/headMeta.test.js.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FLAG_GLYPH_LICENSE,
  FLAG_GLYPH_PATH,
  FAVICON_HEX,
  renderFlagSvg
} from "../src/frontend/flagGlyph.js";

const UPSTREAM = fileURLToPath(new URL("../scripts/flag-solid-full.svg", import.meta.url));

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe("flag glyph source", () => {
  const svg = readFileSync(UPSTREAM, "utf8");

  it("carries the upstream path verbatim", () => {
    const d = /<path d="([^"]+)"/.exec(svg);
    expect(d).not.toBeNull();
    expect(FLAG_GLYPH_PATH).toBe(d[1]);
  });

  it("carries the upstream attribution verbatim", () => {
    const license = /<!--(.*?)-->/.exec(svg);
    expect(license).not.toBeNull();
    expect(FLAG_GLYPH_LICENSE).toBe(license[1]);
  });

  // Same steps styles.js gives --flag-* and its dark override.
  it("pairs each color with a one-step-lighter dark fill", () => {
    expect(FAVICON_HEX.green).toEqual({ light: "#4f8051", dark: "#6ea16f" });
    expect(FAVICON_HEX.yellow).toEqual({ light: "#c6ad4f", dark: "#e3c868" });
    expect(FAVICON_HEX.red).toEqual({ light: "#cf443b", dark: "#e47468" });
    expect(FAVICON_HEX["double-red"]).toEqual(FAVICON_HEX.red);
    expect(FAVICON_HEX.unknown).toEqual({ light: "#777478", dark: "#979498" });
    expect(FAVICON_HEX.brand).toEqual({ light: "#2e5b89", dark: "#88b2e4" });
  });
});

describe("renderFlagSvg", () => {
  it("draws one untransformed flag in the color's light and dark fills", () => {
    const svg = renderFlagSvg("green", "Green flag");
    expect(svg.indexOf("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 640 640\" " +
      "role=\"img\" aria-label=\"Green flag\">")).toBe(0);
    expect(svg).toContain("<!--" + FLAG_GLYPH_LICENSE + "-->");
    expect(svg).toContain("<style>path{fill:#4f8051}@media (prefers-color-scheme:dark){path{fill:#6ea16f}}</style>");
    expect(svg).toContain("<path d=\"" + FLAG_GLYPH_PATH + "\"/>");
    expect(count(svg, "<path")).toBe(1);
    expect(svg).not.toContain("transform=");
    expect(svg).not.toContain("<rect");
  });

  it("stacks two flags on one pole for double-red and fits the pair to one flag's height", () => {
    const svg = renderFlagSvg("double-red", "Double red flag");
    expect(count(svg, "<path")).toBe(2);
    expect(svg).toContain("<path transform=\"translate(0 370)\" d=\"");
    // (576 - 64) / (576 + 370 - 64) = 0.58050, centered in the 640 frame.
    expect(svg).toContain("<g transform=\"translate(134.240 26.848) scale(0.58050)\">");
    expect(svg).toContain("path{fill:#cf443b}");
  });

  it("draws unknown gray for any key it does not know", () => {
    const svg = renderFlagSvg("purple", "Flag status unknown");
    expect(svg).toContain("path{fill:#777478}");
    expect(count(svg, "<path")).toBe(1);
  });

  it("escapes the label into the attribute", () => {
    const svg = renderFlagSvg("brand", "Swim \"Report\" <&>");
    expect(svg).toContain("aria-label=\"Swim &quot;Report&quot; &lt;&amp;&gt;\"");
  });
});
