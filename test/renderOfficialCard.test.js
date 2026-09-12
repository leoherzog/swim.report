// test/renderOfficialCard.test.js
// Detail-page official card: the "Reported for ..." provenance line shown when a
// posted flag was read at a neighboring report site (OfficialFlag.reportedFor).
// Pure rendering, no fetch, no Date.
import { describe, it, expect } from "vitest";
import { renderDetailPage } from "../src/frontend/render.js";
import { NOW_ISO, beachWith } from "./helpers/render.js";

const OMR_URL = "https://forecast.weather.gov/product.php?site=GRR&issuedby=GRR&product=OMR";

function officialWith(extra) {
  const base = {
    color: "red",
    reason: "Official flag reported by NWS Grand Rapids for Grand Haven State Park",
    official: true,
    scraperId: "nws-omr-grr",
    source: OMR_URL,
    sources: [OMR_URL],
    updated: NOW_ISO
  };
  return Object.assign(base, extra || {});
}

// The card is sliced out of the document on its rendered class attribute: the
// bare class names also appear in the embedded stylesheet.
function officialCard(official) {
  const html = renderDetailPage({
    beach: beachWith({ name: "Grand Haven City Beach" }),
    estimate: null,
    official: official,
    nowIso: NOW_ISO
  });
  return html.slice(html.indexOf("class=\"official-card\""),
    html.indexOf("class=\"estimate-card\""));
}

describe("official card: reported-for-another-site provenance line", function () {
  it("names the report site and its distance when the record carries one", function () {
    const card = officialCard(officialWith({
      reportedFor: { name: "Grand Haven State Park", distanceMi: 1.4 }
    }));
    expect(card).toContain(
      "<p class=\"wa-caption-s\">Reported for Grand Haven State Park, " +
      "~1 mi away</p>"
    );
  });

  it("uses the shared sub-mile label for a very close site", function () {
    const card = officialCard(officialWith({
      reportedFor: { name: "Grand Haven State Park", distanceMi: 0.4 }
    }));
    expect(card).toContain(
      "<p class=\"wa-caption-s\">Reported for Grand Haven State Park, " +
      "&lt;1 mi away</p>"
    );
  });

  it("names the site alone when no distance is known, never inventing one", function () {
    const card = officialCard(officialWith({
      reportedFor: { name: "Grand Haven State Park", distanceMi: null }
    }));
    expect(card).toContain(
      "<p class=\"wa-caption-s\">Reported for Grand Haven State Park</p>"
    );
    expect(card).not.toContain("away");
  });

  it("renders no line at all when the record carries no reportedFor", function () {
    const card = officialCard(officialWith(null));
    expect(card).not.toContain("Reported for");
  });

  it("ignores a malformed or empty-named reportedFor", function () {
    expect(officialCard(officialWith({ reportedFor: {} }))).not.toContain("Reported for");
    expect(officialCard(officialWith({ reportedFor: { name: "  " } })))
      .not.toContain("Reported for");
    expect(officialCard(officialWith({ reportedFor: "Grand Haven State Park" })))
      .not.toContain("Reported for");
    expect(officialCard(officialWith({ reportedFor: null }))).not.toContain("Reported for");
  });

  it("drops a non-finite distance rather than rendering NaN", function () {
    const card = officialCard(officialWith({
      reportedFor: { name: "Grand Haven State Park", distanceMi: NaN }
    }));
    expect(card).toContain(
      "<p class=\"wa-caption-s\">Reported for Grand Haven State Park</p>"
    );
    expect(card).not.toContain("NaN");
  });

  it("escapes the site name", function () {
    const card = officialCard(officialWith({
      reportedFor: { name: "Ottawa <script>x</script> Beach", distanceMi: null }
    }));
    expect(card).toContain("Reported for Ottawa &lt;script&gt;x&lt;/script&gt; Beach");
    expect(card).not.toContain("<script>x</script>");
  });

  it("sits inside the official card body, under the flag row", function () {
    const card = officialCard(officialWith({
      reportedFor: { name: "Grand Haven State Park", distanceMi: 1.4 }
    }));
    expect(card.indexOf("Official flag reported by")).toBeLessThan(
      card.indexOf("Reported for Grand Haven State Park")
    );
  });

  it("never appears on the estimate card", function () {
    // The estimate card shares renderFlagCard but is never passed the line: an
    // estimate has no report site, and only official readings are transferred.
    const html = renderDetailPage({
      beach: beachWith({ name: "Grand Haven City Beach" }),
      estimate: {
        color: "green",
        reason: "Estimated wave height 1.3 ft (below 2 ft)",
        official: false,
        rules_version: "1.7.0",
        sources: [],
        updated: NOW_ISO,
        reportedFor: { name: "Grand Haven State Park", distanceMi: 1.4 }
      },
      official: null,
      nowIso: NOW_ISO
    });
    expect(html).not.toContain("Reported for");
  });
});
