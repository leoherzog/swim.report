// test/headMeta.test.js
// Covers the shared document head's identity and share tags
// (src/frontend/render.js renderDocument / renderShareMeta): favicon, manifest,
// the two theme colors, and the per-page description, canonical link and
// Open Graph / Twitter card. The description is the one place a shared link
// states a color, so it must always say estimated or official, and must read
// "unknown" honestly rather than defaulting to a color.

import { describe, it, expect } from "vitest";
import { renderListPage, renderDetailPage, renderErrorPage } from "../src/frontend/render.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

function estimateWith(extra) {
  return Object.assign(
    {
      color: "green",
      reason: "Waves 1.0 ft",
      rules_version: 1,
      official: false,
      sources: [],
      updated: NOW_ISO,
      waveHeightFt: 1.0
    },
    extra
  );
}

function officialWith(extra) {
  return Object.assign(
    {
      color: "red",
      official: true,
      source: "https://example.gov/beach",
      updated: NOW_ISO
    },
    extra
  );
}

function detailHtml(estimate, official, beachExtra) {
  return renderDetailPage({
    beach: beachWith(beachExtra),
    estimate: estimate,
    official: official,
    waves: null,
    waterTemp: null,
    nowIso: NOW_ISO
  });
}

// The content of one <meta name="..."> or <meta property="..."> tag, or null
// when the tag is absent. Matches the rendered tag exactly, since the whole head
// is built by hand as one line per tag.
function metaContent(html, kind, name) {
  const marker = "<meta " + kind + "=\"" + name + "\" content=\"";
  const start = html.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const from = start + marker.length;
  return html.slice(from, html.indexOf("\"", from));
}

function canonicalHref(html) {
  const marker = "<link rel=\"canonical\" href=\"";
  const start = html.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const from = start + marker.length;
  return html.slice(from, html.indexOf("\"", from));
}

describe("site identity tags", () => {
  const pages = [
    ["list page", renderListPage({ entries: [] })],
    ["detail page", detailHtml(estimateWith(), null)],
    ["error page", renderErrorPage({ status: 404, message: "Not found" })]
  ];

  for (let i = 0; i < pages.length; i = i + 1) {
    const label = pages[i][0];
    const html = pages[i][1];

    it("puts the favicon, apple-touch-icon and manifest on the " + label, () => {
      expect(html).toContain("<link rel=\"icon\" type=\"image/svg+xml\" href=\"/favicon.svg\">");
      expect(html).toContain("<link rel=\"apple-touch-icon\" sizes=\"180x180\" href=\"/apple-touch-icon.png\">");
      expect(html).toContain("<link rel=\"manifest\" href=\"/manifest.webmanifest\">");
    });

    it("carries both theme colors on the " + label, () => {
      expect(html).toContain(
        "<meta name=\"theme-color\" media=\"(prefers-color-scheme: light)\" content=\"#ffffff\">");
      expect(html).toContain(
        "<meta name=\"theme-color\" media=\"(prefers-color-scheme: dark)\" content=\"#121214\">");
    });
  }

  it("puts the identity tags after the title and before the theme stylesheet", () => {
    const html = renderListPage({ entries: [] });
    expect(html.indexOf("<title>")).toBeLessThan(html.indexOf("<link rel=\"icon\""));
    expect(html.indexOf("<link rel=\"icon\"")).toBeLessThan(
      html.indexOf("/styles/themes/matter.css"));
  });
});

describe("list page description, canonical and share card", () => {
  const html = renderListPage({ entries: [] });

  it("describes the site in one sentence", () => {
    expect(metaContent(html, "name", "description")).toBe(
      "Estimated beach hazard flags for Great Lakes and ocean-coast beaches " +
      "across the United States and Canada.");
  });

  it("canonicalizes to the bare origin", () => {
    expect(canonicalHref(html)).toBe("https://swim.report/");
    expect(metaContent(html, "property", "og:url")).toBe("https://swim.report/");
  });

  // A q or near param is a filtered or geolocated view of the same page, so the
  // canonical must not vary with it.
  it("keeps the same canonical under a query and a near param", () => {
    const filtered = renderListPage({ entries: [], query: "ottawa", near: "42.7,-86.2" });
    expect(canonicalHref(filtered)).toBe("https://swim.report/");
  });

  // The index reports no one beach's color, so it takes the honest gray card.
  it("shares the unknown card", () => {
    expect(metaContent(html, "property", "og:image")).toBe(
      "https://swim.report/og/unknown.png");
    expect(metaContent(html, "name", "twitter:image")).toBe(
      "https://swim.report/og/unknown.png");
    expect(metaContent(html, "property", "og:image:alt")).toBe(
      "A gray beach flag flying over a wave");
  });

  it("carries the full Open Graph and Twitter card set", () => {
    expect(metaContent(html, "property", "og:type")).toBe("website");
    expect(metaContent(html, "property", "og:site_name")).toBe("Swim Report");
    expect(metaContent(html, "property", "og:title")).toBe("Swim Report");
    expect(metaContent(html, "property", "og:description")).toBe(
      metaContent(html, "name", "description"));
    expect(metaContent(html, "property", "og:image:width")).toBe("1200");
    expect(metaContent(html, "property", "og:image:height")).toBe("630");
    expect(metaContent(html, "name", "twitter:card")).toBe("summary_large_image");
    expect(metaContent(html, "name", "twitter:title")).toBe("Swim Report");
    expect(metaContent(html, "name", "twitter:description")).toBe(
      metaContent(html, "name", "description"));
  });
});

describe("detail page description", () => {
  it("says estimated when only an estimate decides the color", () => {
    const html = detailHtml(estimateWith({ color: "yellow", waveHeightFt: 2.4 }), null);
    expect(metaContent(html, "name", "description")).toBe(
      "Ottawa Beach: estimated YELLOW flag right now, 2.4 ft waves.");
  });

  it("says official when a fresh official record decides the color", () => {
    const html = detailHtml(estimateWith({ color: "green", waveHeightFt: 1.0 }), officialWith());
    expect(metaContent(html, "name", "description")).toBe(
      "Ottawa Beach: official RED flag right now, 1.0 ft waves.");
  });

  // Past STALE_MS the official record stops deciding alone and only floors the
  // estimate, so the wording follows displayFlag's source: "estimated" when the
  // estimate supplied the color, "official" when the aged record still did.
  it("says estimated once an aged official record is outranked by the estimate", () => {
    const stale = officialWith({ color: "green", updated: "2026-07-05T08:00:00.000Z" });
    const html = detailHtml(estimateWith({ color: "yellow", waveHeightFt: 2.4 }), stale);
    expect(metaContent(html, "name", "description")).toBe(
      "Ottawa Beach: estimated YELLOW flag right now, 2.4 ft waves.");
  });

  it("says official when an aged official record is the more severe half", () => {
    const aged = officialWith({ color: "red", updated: "2026-07-05T08:00:00.000Z" });
    const html = detailHtml(estimateWith({ color: "green", waveHeightFt: 1.0 }), aged);
    expect(metaContent(html, "name", "description")).toBe(
      "Ottawa Beach: official RED flag right now, 1.0 ft waves.");
  });

  it("says official for an aged official with no estimate", () => {
    const aged = officialWith({ color: "green", updated: "2026-07-05T08:00:00.000Z" });
    const html = detailHtml(null, aged);
    expect(metaContent(html, "name", "description")).toBe(
      "Ottawa Beach: official GREEN flag right now.");
  });

  it("says estimated when an aged official merely ties", () => {
    const aged = officialWith({ color: "yellow", updated: "2026-07-05T08:00:00.000Z" });
    const html = detailHtml(estimateWith({ color: "yellow", waveHeightFt: 2.4 }), aged);
    expect(metaContent(html, "name", "description")).toBe(
      "Ottawa Beach: estimated YELLOW flag right now, 2.4 ft waves.");
  });

  it("names the double red without the water-closed phrasing", () => {
    const html = detailHtml(estimateWith({ color: "double-red", waveHeightFt: 8.2 }), null);
    expect(metaContent(html, "name", "description")).toBe(
      "Ottawa Beach: estimated DOUBLE RED flag right now, 8.2 ft waves.");
  });

  it("reads unknown honestly and never green", () => {
    const html = detailHtml(null, null);
    const description = metaContent(html, "name", "description");
    expect(description).toBe("Ottawa Beach: flag status unknown right now.");
    expect(description).not.toContain("GREEN");
  });

  it("omits the wave clause rather than inventing a height", () => {
    const html = detailHtml(estimateWith({ color: "green", waveHeightFt: null }), null);
    expect(metaContent(html, "name", "description")).toBe(
      "Ottawa Beach: estimated GREEN flag right now.");
  });

  it("uses the park-first display name", () => {
    const html = detailHtml(estimateWith(), null, { park_name: "Holland State Park" });
    expect(metaContent(html, "name", "description")).toBe(
      "Holland State Park: estimated GREEN flag right now, 1.0 ft waves.");
  });

  it("escapes the beach name in the description and the title tags", () => {
    const html = detailHtml(estimateWith(), null, { name: "Ann & \"Bill\" Beach" });
    expect(metaContent(html, "name", "description")).toBe(
      "Ann &amp; &quot;Bill&quot; Beach: estimated GREEN flag right now, 1.0 ft waves.");
    expect(html).not.toContain("Ann & \"Bill\"");
  });
});

describe("detail page canonical and share card", () => {
  it("canonicalizes to the beach's own path with the id encoded", () => {
    const html = detailHtml(estimateWith(), null, { id: "osm:node/42" });
    expect(canonicalHref(html)).toBe("https://swim.report/beach/osm%3Anode%2F42");
    expect(metaContent(html, "property", "og:url")).toBe(
      "https://swim.report/beach/osm%3Anode%2F42");
  });

  it("titles the card with the page title", () => {
    const html = detailHtml(estimateWith(), null);
    expect(metaContent(html, "property", "og:title")).toBe("Ottawa Beach — Swim Report");
    expect(metaContent(html, "name", "twitter:title")).toBe("Ottawa Beach — Swim Report");
  });

  // One card per display color, so the picture cannot disagree with the title
  // flag: both come from displayFlag.
  const cards = [
    ["green", "https://swim.report/og/green.png", "A green beach flag flying over a wave"],
    ["yellow", "https://swim.report/og/yellow.png", "A yellow beach flag flying over a wave"],
    ["red", "https://swim.report/og/red.png", "A red beach flag flying over a wave"],
    ["double-red", "https://swim.report/og/double-red.png", "Two red beach flags flying over a wave"]
  ];
  for (let i = 0; i < cards.length; i = i + 1) {
    const color = cards[i][0];
    const image = cards[i][1];
    const alt = cards[i][2];
    it("shares the " + color + " card for a " + color + " display color", () => {
      const html = detailHtml(estimateWith({ color: color }), null);
      expect(metaContent(html, "property", "og:image")).toBe(image);
      expect(metaContent(html, "name", "twitter:image")).toBe(image);
      expect(metaContent(html, "property", "og:image:alt")).toBe(alt);
    });
  }

  it("shares the unknown card when there is no flag data", () => {
    const html = detailHtml(null, null);
    expect(metaContent(html, "property", "og:image")).toBe(
      "https://swim.report/og/unknown.png");
  });

  // A fresh official record decides the color, so it decides the card too.
  it("takes the card from the official color when the official record is fresh", () => {
    const html = detailHtml(estimateWith({ color: "green" }), officialWith());
    expect(metaContent(html, "property", "og:image")).toBe("https://swim.report/og/red.png");
  });
});

describe("error page share meta", () => {
  const html = renderErrorPage({ status: 404, message: "Not found" });

  // A 404 must not advertise itself as a page: no canonical, no share card.
  it("claims no canonical and offers no card", () => {
    expect(html).not.toContain("<link rel=\"canonical\"");
    expect(html).not.toContain("property=\"og:");
    expect(html).not.toContain("name=\"twitter:");
    expect(html).not.toContain("<meta name=\"description\"");
  });
});
