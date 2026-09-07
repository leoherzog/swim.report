// test/renderWebcam.test.js
// Covers the nearby-webcam section on the detail page (src/frontend/render.js):
// it renders only when beach.webcam_player_url is a non-empty string, stays
// absent for null and pre-migration (undefined) rows, always carries the "Nearby
// webcam" heading and the not-necessarily-this-beach note, links the cam's own
// Windy detail page only for an http(s) webcam_detail_url, and escapes all dynamic
// values (title, player URL and detail URL) into the markup.

import { describe, it, expect } from "vitest";
import { renderDetailPage } from "../src/frontend/render.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

const HEADING = "<h2 id=\"webcam-heading\" class=\"section-heading wa-cluster wa-gap-xs\">" +
  "<wa-icon name=\"video\"></wa-icon>Nearby webcam</h2>";
const NOTE = "<p class=\"webcam-note wa-caption-s\">This camera is near this beach " +
  "and may not show the beach itself.</p>";

function renderWith(extra) {
  return renderDetailPage({
    beach: beachWith(extra),
    estimate: null,
    official: null,
    nowIso: NOW_ISO
  });
}

describe("nearby-webcam section", () => {
  it("renders the section with the escaped player URL when a player URL is present", () => {
    const html = renderWith({
      webcam_id: "1595253287",
      webcam_title: "South Pier Cam",
      webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1595253287/day"
    });
    // the section is labeled by the shared detail-page heading, which keeps the
    // cam honestly described as nearby rather than as this beach's own view
    expect(html).toContain("aria-labelledby=\"webcam-heading\"");
    expect(html).toContain("<h2 id=\"webcam-heading\" class=\"section-heading wa-cluster wa-gap-xs\">");
    expect(html).toContain("<wa-icon name=\"video\"></wa-icon>Nearby webcam</h2>");
    // same plain-iframe wrapper as the wave map, so the player's own controls
    // work and the title reaches the frame as its accessible name
    expect(html).toContain("<iframe class=\"webcam-frame\"");
    expect(html).toContain(" allowfullscreen></iframe>");
    expect(html).toContain(
      "src=\"https://webcams.windy.com/webcams/public/embed/player/1595253287/day\"");
    expect(html).toContain("loading=\"lazy\"");
    expect(html).toContain("allowfullscreen");
    // caption carries the webcam title only — no per-cam attribution line
    expect(html).toContain("<span class=\"webcam-title\">South Pier Cam</span>");
    expect(html).not.toContain("Webcam via");
    // the honesty note sits under the caption, never claiming the cam sees the beach
    expect(html).toContain(NOTE);
    expect(html.indexOf(NOTE)).toBeGreaterThan(
      html.indexOf("<span class=\"webcam-title\">South Pier Cam</span>"));
  });

  it("uses the title as the embed's title attribute for accessibility", () => {
    const html = renderWith({
      webcam_id: "1595253287",
      webcam_title: "South Pier Cam",
      webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1595253287/live"
    });
    expect(html).toContain("title=\"South Pier Cam\"");
  });

  it("renders the heading and note but no caption when the title is an empty string", () => {
    const html = renderWith({
      webcam_id: "1595253287",
      webcam_title: "",
      webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1595253287/day"
    });
    expect(html).toContain("<iframe class=\"webcam-frame\"");
    expect(html).toContain(HEADING);
    // no visible title text, so no caption paragraph at all
    expect(html).not.toContain("webcam-title");
    expect(html).not.toContain("webcam-caption");
    // the note never depends on the cam's own title
    expect(html).toContain(NOTE);
    // the empty title still falls back to a generic embed accessible name
    expect(html).toContain("title=\"Nearby webcam\"");
  });

  it("renders nothing webcam-related when webcam_player_url is null", () => {
    const html = renderWith({
      webcam_id: null,
      webcam_title: null,
      webcam_player_url: null
    });
    expect(html).not.toContain("Nearby webcam");
    expect(html).not.toContain("class=\"webcam-frame\"");
    // no webcam section renders at all for a beach with no cam
    expect(html).not.toContain("class=\"webcam-caption");
    expect(html).not.toContain("webcam-note");
  });

  it("renders nothing and does not throw for a pre-migration row (fields undefined)", () => {
    let html;
    expect(function () { html = renderWith({}); }).not.toThrow();
    expect(html).not.toContain("Nearby webcam");
    expect(html).not.toContain("class=\"webcam-frame\"");
    expect(html).not.toContain("class=\"webcam-caption");
    expect(html).not.toContain("webcam-note");
  });

  it("renders nothing when webcam_player_url is an empty string", () => {
    const html = renderWith({
      webcam_id: "1595253287",
      webcam_title: "South Pier Cam",
      webcam_player_url: ""
    });
    expect(html).not.toContain("Nearby webcam");
    expect(html).not.toContain("class=\"webcam-frame\"");
  });

  it("escapes HTML special characters in the webcam title", () => {
    const html = renderWith({
      webcam_id: "1595253287",
      webcam_title: "Beach <Cam> & \"Pier\"",
      webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1595253287/day"
    });
    expect(html).toContain(
      "<span class=\"webcam-title\">Beach &lt;Cam&gt; &amp; &quot;Pier&quot;</span>");
    // the raw, unescaped title must never appear
    expect(html).not.toContain("Beach <Cam> & \"Pier\"");
  });

  it("escapes a quote in the player URL so it cannot break out of the src attribute", () => {
    const html = renderWith({
      webcam_id: "1595253287",
      webcam_title: "Cam",
      webcam_player_url: "https://webcams.windy.com/embed/\"><script>alert(1)</script>"
    });
    // the quote is escaped, so the src attribute stays intact
    expect(html).toContain(
      "src=\"https://webcams.windy.com/embed/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;\"");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("links the caption to the cam's own Windy detail page in a new tab", () => {
    const html = renderWith({
      webcam_id: "1595253287",
      webcam_title: "South Pier Cam",
      webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1595253287/day",
      webcam_detail_url: "https://windy.com/webcams/1595253287"
    });
    expect(html).toContain("<span class=\"webcam-title\">South Pier Cam</span>");
    expect(html).toContain(
      "<a class=\"webcam-link\" href=\"https://windy.com/webcams/1595253287\"" +
      " rel=\"noopener noreferrer\" target=\"_blank\">View on Windy</a>");
    expect(html).toContain(HEADING);
    expect(html).toContain(NOTE);
  });

  it("renders a link-only caption for an untitled cam with a detail URL", () => {
    const html = renderWith({
      webcam_id: "1595253287",
      webcam_title: "",
      webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1595253287/day",
      webcam_detail_url: "https://windy.com/webcams/1595253287"
    });
    expect(html).toContain("class=\"webcam-caption");
    expect(html).not.toContain("webcam-title");
    expect(html).toContain("href=\"https://windy.com/webcams/1595253287\"");
    expect(html).toContain(">View on Windy</a>");
    expect(html).toContain(HEADING);
    expect(html).toContain(NOTE);
  });

  it("renders the caption without a link when webcam_detail_url is null or undefined", () => {
    const nullUrl = renderWith({
      webcam_id: "1595253287",
      webcam_title: "South Pier Cam",
      webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1595253287/day",
      webcam_detail_url: null
    });
    expect(nullUrl).toContain("<span class=\"webcam-title\">South Pier Cam</span>");
    expect(nullUrl).not.toContain("webcam-link");
    expect(nullUrl).not.toContain("View on Windy");
    // heading and note stand on their own without a per-cam link
    expect(nullUrl).toContain(HEADING);
    expect(nullUrl).toContain(NOTE);
    const undefinedUrl = renderWith({
      webcam_id: "1595253287",
      webcam_title: "South Pier Cam",
      webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1595253287/day"
    });
    expect(undefinedUrl).toContain("<span class=\"webcam-title\">South Pier Cam</span>");
    expect(undefinedUrl).not.toContain("webcam-link");
    expect(undefinedUrl).toContain(HEADING);
    expect(undefinedUrl).toContain(NOTE);
  });

  it("emits no link for a non-http(s) detail URL", () => {
    const schemes = ["javascript:alert(1)", "data:text/html,hi", "/webcams/1", "ftp://x/y", ""];
    for (const bad of schemes) {
      const html = renderWith({
        webcam_id: "1595253287",
        webcam_title: "South Pier Cam",
        webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1595253287/day",
        webcam_detail_url: bad
      });
      expect(html).not.toContain("webcam-link");
      expect(html).not.toContain("javascript:");
    }
  });

  it("escapes a quote in the detail URL so it cannot break out of the href attribute", () => {
    const html = renderWith({
      webcam_id: "1595253287",
      webcam_title: "Cam",
      webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1595253287/day",
      webcam_detail_url: "https://windy.com/webcams/\"><script>alert(1)</script>"
    });
    expect(html).toContain(
      "href=\"https://windy.com/webcams/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;\"");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
