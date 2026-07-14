// test/renderWebcam.test.js
// Covers the nearby-webcam section on the detail page (src/frontend/render.js):
// it renders only when beach.webcam_player_url is a non-empty string, stays
// absent for null and pre-migration (undefined) rows, and escapes all dynamic
// values (title and player URL) into the markup.

import { describe, it, expect } from "vitest";
import { renderDetailPage } from "../src/frontend/render.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

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
    expect(html).toContain("<h2 class=\"webcam-heading wa-font-size-l\">Nearby webcam</h2>");
    // same plain-iframe wrapper as the wave map, so the player's own controls
    // work and the title reaches the frame as its accessible name
    expect(html).toContain("<iframe class=\"webcam-frame\"");
    expect(html).toContain(" allowfullscreen></iframe>");
    expect(html).toContain(
      "src=\"https://webcams.windy.com/webcams/public/embed/player/1595253287/day\"");
    expect(html).toContain("loading=\"lazy\"");
    expect(html).toContain("allowfullscreen");
    // caption carries the webcam title and the Windy.com attribution link
    expect(html).toContain("<span class=\"webcam-title\">South Pier Cam</span>");
    expect(html).toContain(
      "<a href=\"https://www.windy.com/webcams\" rel=\"noopener noreferrer\">Windy.com</a>");
  });

  it("uses the title as the embed's title attribute for accessibility", () => {
    const html = renderWith({
      webcam_id: "1595253287",
      webcam_title: "South Pier Cam",
      webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1595253287/live"
    });
    expect(html).toContain("title=\"South Pier Cam\"");
  });

  it("renders the section but no title span when the title is an empty string", () => {
    const html = renderWith({
      webcam_id: "1595253287",
      webcam_title: "",
      webcam_player_url: "https://webcams.windy.com/webcams/public/embed/player/1595253287/day"
    });
    expect(html).toContain("<h2 class=\"webcam-heading wa-font-size-l\">Nearby webcam</h2>");
    expect(html).not.toContain("webcam-title");
    // falls back to a generic embed title
    expect(html).toContain("title=\"Nearby webcam\"");
    // attribution still renders
    expect(html).toContain(
      "<a href=\"https://www.windy.com/webcams\" rel=\"noopener noreferrer\">Windy.com</a>");
  });

  it("renders nothing webcam-related when webcam_player_url is null", () => {
    const html = renderWith({
      webcam_id: null,
      webcam_title: null,
      webcam_player_url: null
    });
    expect(html).not.toContain("Nearby webcam");
    expect(html).not.toContain("class=\"webcam-frame\"");
    expect(html).not.toContain("windy.com/webcams");
  });

  it("renders nothing and does not throw for a pre-migration row (fields undefined)", () => {
    let html;
    expect(function () { html = renderWith({}); }).not.toThrow();
    expect(html).not.toContain("Nearby webcam");
    expect(html).not.toContain("class=\"webcam-frame\"");
    expect(html).not.toContain("windy.com/webcams");
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
});
