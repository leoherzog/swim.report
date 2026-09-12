// test/brandAssets.test.js
// Covers the committed brand assets under public/ (built by
// scripts/build-brand-assets.js) and the wrangler [assets] block that serves
// them: every file the document head links must exist, at the size its tag
// claims, and the manifest must be valid JSON pointing at files that are there.
// The head tags themselves are covered in test/headMeta.test.js.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function assetPath(relative) {
  return ROOT + "public/" + relative;
}

// Width and height out of a PNG's IHDR, which is always the first chunk: the
// 8-byte signature, a 4-byte length, "IHDR", then the two 32-bit dimensions.
function pngSize(relative) {
  const buf = readFileSync(assetPath(relative));
  expect(buf.slice(1, 4).toString("ascii")).toBe("PNG");
  expect(buf.slice(12, 16).toString("ascii")).toBe("IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("brand asset files", () => {
  it("ships the favicon as the bare flag glyph in brand blue", () => {
    const svg = readFileSync(assetPath("favicon.svg"), "utf8");
    expect(svg.indexOf("<svg")).toBe(0);
    // Mild-palette blue-40 with the blue-70 dark fill, the brand tint. The mark
    // is never a flag color, and it has no plate or wave behind it.
    expect(svg).toContain("path{fill:#2e5b89}");
    expect(svg).toContain("@media (prefers-color-scheme:dark){path{fill:#88b2e4}}");
    expect(svg).not.toContain("<rect");
    expect(svg.split("<path").length - 1).toBe(1);
    expect(svg).not.toContain("#4f8051");
    expect(svg).not.toContain("#c6ad4f");
    expect(svg).not.toContain("#cf443b");
  });

  // The committed file is exactly what the shared builder emits, so the static
  // icon and the per-beach data: URI can never drift apart.
  it("is byte-identical to renderFlagSvg's brand output", async () => {
    const { renderFlagSvg } = await import("../src/frontend/flagGlyph.js");
    expect(readFileSync(assetPath("favicon.svg"), "utf8")).toBe(renderFlagSvg("brand", "Swim Report"));
  });

  // The mark is Font Awesome's solid flag, which the Free license requires
  // attributing wherever the glyph ships.
  it("carries the Font Awesome attribution with the flag glyph", () => {
    const svg = readFileSync(assetPath("favicon.svg"), "utf8");
    expect(svg).toContain("Font Awesome Free");
    expect(svg).toContain("M160 96C160 78.3 145.7 64 128 64");
  });

  it("ships the apple-touch icon at the size its link tag claims", () => {
    expect(pngSize("apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
  });

  it("ships both manifest icon sizes", () => {
    expect(pngSize("icon-192.png")).toEqual({ width: 192, height: 192 });
    expect(pngSize("icon-512.png")).toEqual({ width: 512, height: 512 });
  });

  // Five cards, one per display color, all at the 1200x630 the og:image:width /
  // og:image:height tags declare.
  const colors = ["green", "yellow", "red", "double-red", "unknown"];
  for (let i = 0; i < colors.length; i = i + 1) {
    const color = colors[i];
    it("ships a 1200x630 share card for " + color, () => {
      expect(pngSize("og/" + color + ".png")).toEqual({ width: 1200, height: 630 });
    });
  }
});

describe("web manifest", () => {
  const manifest = JSON.parse(readFileSync(assetPath("manifest.webmanifest"), "utf8"));

  it("declares the installable app", () => {
    expect(manifest.name).toBe("Swim Report");
    expect(manifest.short_name).toBe("Swim Report");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  // The same light surface the light theme-color meta carries, so an installed
  // launch never flashes a color the site itself never shows.
  it("uses the light surface for both colors", () => {
    expect(manifest.theme_color).toBe("#ffffff");
    expect(manifest.background_color).toBe("#ffffff");
  });

  it("points every icon at a file that exists", () => {
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    for (let i = 0; i < manifest.icons.length; i = i + 1) {
      const src = manifest.icons[i].src;
      expect(src.indexOf("/")).toBe(0);
      expect(existsSync(assetPath(src.slice(1)))).toBe(true);
    }
  });
});

describe("wrangler static assets", () => {
  const toml = readFileSync(ROOT + "wrangler.toml", "utf8");

  it("serves public/ as static assets", () => {
    expect(toml).toContain("[assets]\ndirectory = \"public\"");
  });

  // A binding would put an asset read within reach of the request path; the
  // two-path rule wants these files served by the platform alone. Leaving
  // not_found_handling unset keeps every unmatched path reaching the Worker,
  // which owns "/" and every 404.
  it("declares no binding and no not_found_handling", () => {
    expect(toml).not.toContain("[assets]\nbinding");
    expect(toml).not.toContain("not_found_handling =");
  });
});
