// test/srfParser.test.js
import { describe, it, expect } from "vitest";
import { parseRipCurrentRisk } from "../src/clients/srfParser.js";
import { wfoFromGridUrl } from "../src/clients/nws.js";

function buildSrf(bodyLines) {
  const header = [
    "000",
    "FZUS53 KGRR 041000",
    "SRFGRR",
    "SURF ZONE FORECAST FOR SOUTHWEST MICHIGAN",
    "NATIONAL WEATHER SERVICE GRAND RAPIDS MI",
    "600 AM EDT FRI JUL 4 2026",
    ""
  ];
  const footer = ["", "$$"];
  return header.concat(bodyLines).concat(footer).join("\n");
}

describe("parseRipCurrentRisk", function() {
  it("parses 'RIP CURRENT RISK...HIGH' as HIGH", function() {
    const text = buildSrf([
      ".TODAY...",
      "RIP CURRENT RISK...HIGH. DANGEROUS SWIMMING CONDITIONS.",
      "WATER TEMPERATURE...68 DEGREES."
    ]);
    expect(parseRipCurrentRisk(text)).toBe("HIGH");
  });

  it("parses 'RIP CURRENT RISK...MODERATE' as MODERATE", function() {
    const text = buildSrf([
      ".TODAY...",
      "RIP CURRENT RISK...MODERATE. USE CAUTION IN THE WATER.",
      "WATER TEMPERATURE...66 DEGREES."
    ]);
    expect(parseRipCurrentRisk(text)).toBe("MODERATE");
  });

  it("parses 'RIP CURRENT RISK...LOW' as LOW", function() {
    const text = buildSrf([
      ".TODAY...",
      "RIP CURRENT RISK...LOW. SWIMMING CONDITIONS ARE FAVORABLE.",
      "WATER TEMPERATURE...70 DEGREES."
    ]);
    expect(parseRipCurrentRisk(text)).toBe("LOW");
  });

  it("parses lowercase prose 'the risk of rip currents is moderate' as MODERATE", function() {
    const text = buildSrf([
      "Beach conditions today are generally favorable, though",
      "the risk of rip currents is moderate along the lakeshore",
      "this afternoon."
    ]);
    expect(parseRipCurrentRisk(text)).toBe("MODERATE");
  });

  it("parses 'there is a high risk of rip currents' as HIGH", function() {
    const text = buildSrf([
      "There is a high risk of rip currents along the entire",
      "shoreline today. Stay out of the water."
    ]);
    expect(parseRipCurrentRisk(text)).toBe("HIGH");
  });

  it("uses the first occurrence in a multi-period product (TODAY HIGH, TONIGHT LOW)", function() {
    const text = buildSrf([
      ".TODAY...",
      "RIP CURRENT RISK...HIGH. DANGEROUS SWIMMING CONDITIONS.",
      ".TONIGHT...",
      "RIP CURRENT RISK...LOW. CONDITIONS IMPROVING OVERNIGHT."
    ]);
    expect(parseRipCurrentRisk(text)).toBe("HIGH");
  });

  it("treats 'LOW TO MODERATE' as LOW (documented conservative-parse limitation)", function() {
    const text = buildSrf([
      ".TODAY...",
      "RIP CURRENT RISK...LOW TO MODERATE. CONDITIONS MAY WORSEN LATER."
    ]);
    expect(parseRipCurrentRisk(text)).toBe("LOW");
  });

  it("parses the Great Lakes 'SWIM RISK...HIGH' variant as HIGH", function() {
    const text = buildSrf([
      ".TODAY...",
      "SWIM RISK...HIGH. DANGEROUS SWIMMING CONDITIONS EXPECTED.",
      "WAVE HEIGHTS...4 TO 6 FEET."
    ]);
    expect(parseRipCurrentRisk(text)).toBe("HIGH");
  });

  it("parses 'SWIM RISK...MODERATE' as MODERATE", function() {
    const text = buildSrf([
      ".TODAY...",
      "SWIM RISK...MODERATE. USE CAUTION.",
      "WAVE HEIGHTS...2 TO 3 FEET."
    ]);
    expect(parseRipCurrentRisk(text)).toBe("MODERATE");
  });

  it("parses 'SWIM RISK: LOW' (colon form) as LOW", function() {
    const text = buildSrf([
      ".TODAY...",
      "SWIM RISK: LOW. CONDITIONS FAVORABLE."
    ]);
    expect(parseRipCurrentRisk(text)).toBe("LOW");
  });

  it("treats 'SWIM RISK...LOW TO MODERATE' conservatively as LOW", function() {
    const text = buildSrf([
      ".TODAY...",
      "SWIM RISK...LOW TO MODERATE. CONDITIONS MAY WORSEN LATER."
    ]);
    expect(parseRipCurrentRisk(text)).toBe("LOW");
  });

  it("prefers the explicit rip-current wording over a swim-risk line in the same product", function() {
    const text = buildSrf([
      ".TODAY...",
      "SWIM RISK...LOW.",
      "RIP CURRENT RISK...HIGH. DANGEROUS CONDITIONS."
    ]);
    expect(parseRipCurrentRisk(text)).toBe("HIGH");
  });

  it("returns null when there is no rip current mention", function() {
    const text = buildSrf([
      ".TODAY...",
      "WAVE HEIGHTS...1 FOOT OR LESS.",
      "WATER TEMPERATURE...72 DEGREES."
    ]);
    expect(parseRipCurrentRisk(text)).toBe(null);
  });

  it("returns null for null and empty-string input", function() {
    expect(parseRipCurrentRisk(null)).toBe(null);
    expect(parseRipCurrentRisk("")).toBe(null);
  });
});

describe("wfoFromGridUrl", function() {
  it("extracts the WFO code from a gridpoints URL", function() {
    expect(wfoFromGridUrl("https://api.weather.gov/gridpoints/GRR/33,33")).toBe("GRR");
  });

  it("returns null for null input", function() {
    expect(wfoFromGridUrl(null)).toBe(null);
  });

  it("returns null for a non-matching (garbage) URL", function() {
    expect(wfoFromGridUrl("https://example.com/not-a-gridpoints-url")).toBe(null);
  });
});
