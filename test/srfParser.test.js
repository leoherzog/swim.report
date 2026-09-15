// test/srfParser.test.js
import { describe, it, expect } from "vitest";
import { parseRipCurrentRisk, parseSrfTides } from "../src/clients/srfParser.js";
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

// Ocean-office products carry a "Tides" block in every zone segment, in two
// grammars: times only ("High at 10:58 AM EDT.") and heights plus times
// ("High 3.8 feet (MLLW) 12:21 AM PDT."). The parser keeps each event string
// verbatim and keys the table by UGC zone id.
describe("parseSrfTides", function() {
  function segment(header, nameLines, periods) {
    const lines = [header].concat(nameLines).concat(["348 AM EDT Tue Sep 15 2026", ""]);
    for (const period of periods) {
      lines.push("." + period.label + "...");
      for (const line of period.lines) {
        lines.push(line);
      }
      lines.push("");
    }
    return lines.concat(["&&", "", "$$", ""]);
  }

  const ILM_TODAY = [
    "Rip Current Risk*...........Moderate. ",
    "Surf Height.................2 to 4 feet. ",
    "Winds.......................Northeast winds around 15 mph.",
    "Tides...",
    "   Topsail Inlet............High at 10:58 AM EDT.",
    "                            Low at 05:19 PM EDT. ",
    "Remarks.....................Strong north to south longshore current."
  ];
  const ILM_WEDNESDAY = [
    "Rip Current Risk*...........Moderate. ",
    "Tides...",
    "   Topsail Inlet............High at 11:44 AM EDT. ",
    "Remarks.....................Moderate north to south longshore current."
  ];

  it("keys the first period's block by zone, events verbatim and leaders stripped", function() {
    const text = buildSrf(segment("NCZ106-152115-", ["Coastal Pender-", "Including the beaches of Surf City and Topsail Beach"], [
      { label: "TODAY", lines: ILM_TODAY },
      { label: "WEDNESDAY", lines: ILM_WEDNESDAY }
    ]));
    expect(parseSrfTides(text)).toEqual({
      NCZ106: {
        period: "TODAY",
        locations: [
          { name: "Topsail Inlet", events: ["High at 10:58 AM EDT.", "Low at 05:19 PM EDT."] }
        ]
      }
    });
  });

  it("keeps heights and datum in the event string, several locations per zone", function() {
    const text = buildSrf(segment("MAZ022-152200-", ["Barnstable MA-"], [
      { label: "TODAY", lines: [
        "Rip Current Risk*...",
        "   East Coast...............Moderate. ",
        "Tides...",
        "   Nauset Beach.............Low 0.4 feet (MLLW) 07:56 AM EDT.",
        "                            High 4.5 feet (MLLW) 02:04 PM EDT.",
        "   Hyannisport..............Low 0.7 feet (MLLW) 09:11 AM EDT.",
        "                            High 3.8 feet (MLLW) 03:58 PM EDT."
      ] }
    ]));
    expect(parseSrfTides(text).MAZ022.locations).toEqual([
      { name: "Nauset Beach", events: ["Low 0.4 feet (MLLW) 07:56 AM EDT.", "High 4.5 feet (MLLW) 02:04 PM EDT."] },
      { name: "Hyannisport", events: ["Low 0.7 feet (MLLW) 09:11 AM EDT.", "High 3.8 feet (MLLW) 03:58 PM EDT."] }
    ]);
  });

  it("reads a label padded with leaders and a deeper indent, and stops at the next field", function() {
    const text = buildSrf(segment("CAZ552-152130-", ["Orange County Coastal Areas-"], [
      { label: "TODAY", lines: [
        "Tides.........................",
        "        Newport Beach.........High 3.8 feet (MLLW) 12:21 AM PDT.",
        "                              Low 2.0 feet (MLLW) 05:27 AM PDT.",
        "Remarks.......................Mixed swell from 150 and 280 degrees."
      ] }
    ]));
    expect(parseSrfTides(text).CAZ552).toEqual({
      period: "TODAY",
      locations: [{ name: "Newport Beach", events: ["High 3.8 feet (MLLW) 12:21 AM PDT.", "Low 2.0 feet (MLLW) 05:27 AM PDT."] }]
    });
  });

  it("expands a multi-zone header, a range and a wrapped header onto every zone", function() {
    const text = buildSrf(
      segment("MAZ015-016-152200-", ["Suffolk MA-Eastern Norfolk MA-"], [
        { label: "TODAY", lines: ["Tides...", "   Boston Harbor............High at 01:00 PM EDT."] }
      ]).concat(segment("RIZ006>008-", ["MAZ019-152200-", "Newport RI-"], [
        { label: "TODAY", lines: ["Tides...", "   Newport..................Low at 09:00 AM EDT."] }
      ]))
    );
    const tides = parseSrfTides(text);
    expect(Object.keys(tides).sort()).toEqual(["MAZ015", "MAZ016", "MAZ019", "RIZ006", "RIZ007", "RIZ008"]);
    expect(tides.MAZ016.locations[0].name).toBe("Boston Harbor");
    expect(tides.RIZ007.locations[0].events).toEqual(["Low at 09:00 AM EDT."]);
    expect(tides.MAZ019.locations[0].name).toBe("Newport");
  });

  it("keeps the period label as printed, whichever period comes first", function() {
    const text = buildSrf(segment("NCZ106-151430-", ["Coastal Pender-"], [
      { label: "TUESDAY", lines: ILM_TODAY }
    ]).concat(segment("MIZ037-152100-", ["Mason-"], [
      { label: "REST OF TODAY", lines: ["Tides...", "   Nowhere.................High at 01:00 PM EDT."] }
    ])));
    const tides = parseSrfTides(text);
    expect(tides.NCZ106.period).toBe("TUESDAY");
    expect(tides.MIZ037.period).toBe("REST OF TODAY");
  });

  it("yields nothing for a zone with no tides block, and an empty table for a Great Lakes product", function() {
    const text = buildSrf(segment("MIZ037-152100-", ["Mason-"], [
      { label: "REST OF TODAY", lines: [
        "Swim Risk*..................High. ",
        "Wave Height.................7 to 10 feet. ",
        "Sunrise.....................7:24 AM. ",
        "Sunset......................7:59 PM."
      ] }
    ]));
    expect(parseSrfTides(text)).toEqual({});
  });

  it("ignores a tides line outside any zone segment, and non-string input", function() {
    expect(parseSrfTides(buildSrf(["Tides...", "   Somewhere...............High at 01:00 PM EDT."]))).toEqual({});
    expect(parseSrfTides(null)).toEqual({});
    expect(parseSrfTides("")).toEqual({});
    expect(parseSrfTides(42)).toEqual({});
  });

  it("caps a runaway range so a malformed header cannot expand into thousands of zones", function() {
    const text = buildSrf(segment("MAZ001>999-152200-", ["Everywhere-"], [
      { label: "TODAY", lines: ["Tides...", "   Somewhere...............High at 01:00 PM EDT."] }
    ]));
    expect(parseSrfTides(text)).toEqual({});
  });
});
