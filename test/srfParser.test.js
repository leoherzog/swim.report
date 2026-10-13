// test/srfParser.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ripRiskByZone, parseSrfTides, SRF_MAX_AGE_MS } from "../src/clients/srfParser.js";
import { wfoFromGridUrl } from "../src/clients/nws.js";

// Raw api.weather.gov /products/.../latest bodies captured on 2026-10-13,
// one per issuing office, each { issuanceTime, productText, ... }.
function fixtureText(wfo) {
  const raw = readFileSync(new URL("./fixtures/srf/" + wfo + ".json", import.meta.url), "utf8");
  return JSON.parse(raw).productText;
}

// A run instant inside every captured product's TODAY window.
const MIDDAY = "2026-10-13T13:30:00Z";

function buildSrf(bodyLines) {
  const header = [
    "000",
    "FZUS53 KGRR 041000",
    "SRFGRR",
    "SURF ZONE FORECAST FOR SOUTHWEST MICHIGAN",
    "NATIONAL WEATHER SERVICE GRAND RAPIDS MI",
    "600 AM EDT SAT JUL 4 2026",
    ""
  ];
  const footer = ["", "$$"];
  return header.concat(bodyLines).concat(footer).join("\n");
}

// One zone segment of a synthetic product: the UGC header, name lines, an
// optional stamp line (null omits it) and the body.
function segment(header, nameLines, stampLine, bodyLines) {
  const lines = [header].concat(nameLines);
  if (stampLine !== null) {
    lines.push(stampLine);
  }
  return lines.concat([""]).concat(bodyLines).concat(["", "$$", ""]);
}

// Saturday July 4 2026, 06:00 EDT issuance, matching buildSrf's header stamp.
const SAT_STAMP = "600 AM EDT Sat Jul 4 2026";
const SAT_MIDDAY = "2026-07-04T15:00:00Z";

describe("ripRiskByZone over captured products", function () {
  it("BOX: inline and sub-area forms, worst sub-area wins, inland zones absent", function () {
    const risk = ripRiskByZone(fixtureText("BOX"), MIDDAY);
    expect(risk.MAZ022).toBe("HIGH");
    // East Coast High and South Coast High under a label-only line.
    expect(risk.MAZ024).toBe("HIGH");
    expect(risk.MAZ023).toBe("MODERATE");
    expect(risk.MAZ020).toBe("LOW");
    expect(risk.RIZ006).toBe("LOW");
    expect(risk.MAZ007).toBe("HIGH");
    expect(Object.prototype.hasOwnProperty.call(risk, "MAZ005")).toBe(false);
    expect(Object.keys(risk).length).toBe(11);
  });

  it("BOX: nothing before TODAY begins, and nothing after it ends with no TONIGHT period", function () {
    // 5:30 AM EDT, before TODAY's 06:00 start.
    expect(ripRiskByZone(fixtureText("BOX"), "2026-10-13T09:30:00Z")).toEqual({});
    // 8:30 PM EDT: TODAY ended, the product forecasts no TONIGHT.
    expect(ripRiskByZone(fixtureText("BOX"), "2026-10-14T00:30:00Z")).toEqual({});
  });

  it("MHX: every zone resolves LOW from its own line, not from the legend", function () {
    const risk = ripRiskByZone(fixtureText("MHX"), MIDDAY);
    expect(risk).toEqual({
      NCZ203: "LOW", NCZ204: "LOW", NCZ205: "LOW",
      NCZ196: "LOW", NCZ195: "LOW", NCZ199: "LOW"
    });
  });

  it("GYX: a Monday afternoon product read Tuesday morning resolves its TUESDAY period", function () {
    const risk = ripRiskByZone(fixtureText("GYX"), MIDDAY);
    expect(risk).toEqual({
      NHZ014: "LOW",
      MEZ023: "MODERATE", MEZ024: "MODERATE", MEZ025: "MODERATE",
      MEZ026: "MODERATE", MEZ027: "MODERATE",
      MEZ028: "LOW"
    });
  });

  it("GYX: read Monday 10 PM, REST OF TODAY has ended and TUESDAY has not begun", function () {
    expect(ripRiskByZone(fixtureText("GYX"), "2026-10-13T02:00:00Z")).toEqual({});
  });

  it("AKQ: a Sunday-evening product's MONDAY period is the next day, then ends, then ages out", function () {
    const text = fixtureText("AKQ");
    // Monday 10 AM EDT: inside MONDAY, and the headline is not what is read.
    expect(ripRiskByZone(text, "2026-10-12T14:00:00Z")).toEqual({
      MDZ025: "HIGH", VAZ099: "HIGH", VAZ100: "HIGH", VAZ098: "MODERATE", NCZ102: "MODERATE"
    });
    // Tuesday morning: MONDAY has ended.
    expect(ripRiskByZone(text, MIDDAY)).toEqual({});
    // Past SRF_MAX_AGE_MS.
    expect(ripRiskByZone(text, "2026-10-14T06:00:00Z")).toEqual({});
  });

  it("JAX: the zone line decides, not the segment headline", function () {
    const risk = ripRiskByZone(fixtureText("JAX"), MIDDAY);
    expect(risk).toEqual({
      FLZ124: "MODERATE", FLZ125: "MODERATE", FLZ138: "MODERATE",
      FLZ233: "MODERATE", FLZ333: "MODERATE",
      GAZ154: "LOW", GAZ166: "LOW"
    });
  });

  it("BRO: resolves TODAY at midday and TONIGHT at 8 PM CDT", function () {
    const text = fixtureText("BRO");
    expect(ripRiskByZone(text, MIDDAY)).toEqual({
      TXZ451: "MODERATE", TXZ454: "MODERATE", TXZ455: "MODERATE"
    });
    expect(ripRiskByZone(text, "2026-10-14T01:00:00Z")).toEqual({
      TXZ451: "MODERATE", TXZ454: "MODERATE", TXZ455: "MODERATE"
    });
  });

  it("LOX: a segment with no rip line yields no zone, and the legend never matches", function () {
    const risk = ripRiskByZone(fixtureText("LOX"), MIDDAY);
    expect(risk).toEqual({
      CAZ362: "HIGH", CAZ364: "HIGH",
      CAZ354: "MODERATE", CAZ349: "MODERATE", CAZ350: "MODERATE"
    });
    expect(Object.prototype.hasOwnProperty.call(risk, "CAZ340")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(risk, "CAZ346")).toBe(false);
  });

  it("CAR: the label without an asterisk still parses", function () {
    expect(ripRiskByZone(fixtureText("CAR"), MIDDAY)).toEqual({ MEZ029: "LOW", MEZ030: "LOW" });
  });

  it("TAE: a segment's CDT stamp wins over the EDT header, and a stampless segment takes the header", function () {
    const text = fixtureText("TAE");
    expect(ripRiskByZone(text, MIDDAY)).toEqual({
      FLZ108: "LOW", FLZ112: "LOW", FLZ114: "LOW", FLZ115: "LOW"
    });
    // 5:30 PM CDT / 6:30 PM EDT: the CDT segments are still inside TODAY, the
    // EDT-stamped FLZ115 and the stampless FLZ114 (header EDT) have ended.
    expect(ripRiskByZone(text, "2026-10-13T22:30:00Z")).toEqual({ FLZ108: "LOW", FLZ112: "LOW" });
  });

  it("SJU: an AST stamp resolves", function () {
    expect(ripRiskByZone(fixtureText("SJU"), MIDDAY)).toEqual({
      PRZ001: "MODERATE", PRZ002: "MODERATE", PRZ005: "MODERATE", PRZ008: "MODERATE",
      PRZ010: "LOW", PRZ011: "LOW", PRZ007: "LOW", PRZ003: "LOW",
      PRZ012: "LOW", PRZ013: "LOW", VIZ001: "LOW", VIZ002: "LOW"
    });
  });

  it("MOB: resolves TONIGHT at 7:30 PM CDT", function () {
    expect(ripRiskByZone(fixtureText("MOB"), "2026-10-14T00:30:00Z")).toEqual({
      ALZ265: "LOW", ALZ266: "LOW", FLZ202: "LOW", FLZ204: "LOW", FLZ206: "LOW"
    });
  });

  it("ILM: every zone resolves LOW from its detailed periods", function () {
    expect(ripRiskByZone(fixtureText("ILM"), MIDDAY)).toEqual({
      NCZ106: "LOW", NCZ108: "LOW", NCZ110: "LOW", SCZ054: "LOW", SCZ056: "LOW"
    });
  });

  it("offices whose products carry no rip line in any segment yield nothing", function () {
    for (const wfo of ["HFO", "EKA", "MTR", "PQR", "MFR"]) {
      expect(ripRiskByZone(fixtureText(wfo), MIDDAY)).toEqual({});
    }
  });
});

describe("ripRiskByZone period and label rules", function () {
  it("reads the Great Lakes Swim Risk variant inside a stamped segment", function () {
    // Unverified against a live product until a Great Lakes office issues an SRF.
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], SAT_STAMP, [
      ".TODAY...",
      "Swim Risk*..................High. ",
      "Wave Height.................7 to 10 feet. "
    ]));
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({ MIZ037: "HIGH" });
  });

  it("takes the worst word of a range value", function () {
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], SAT_STAMP, [
      ".TODAY...",
      "RIP CURRENT RISK...LOW TO MODERATE. CONDITIONS MAY WORSEN LATER."
    ]));
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({ MIZ037: "MODERATE" });
  });

  it("reads only the value phrase, not the prose after it", function () {
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], SAT_STAMP, [
      ".TODAY...",
      "RIP CURRENT RISK...LOW. HIGH SURF EXPECTED LATE."
    ]));
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({ MIZ037: "LOW" });
  });

  it("never reads a headline, a legend heading, a legend bullet or an inline extended day", function () {
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], SAT_STAMP, [
      "...HIGH RIP CURRENT RISK IN EFFECT THROUGH THIS EVENING...",
      "",
      ".TODAY...",
      "Rip Current Risk Category...High.",
      "Rip Current Risks: High.",
      "* High Risk - Life-threatening rip currents are likely.",
      ".SUNDAY...High rip current risk*. Surf height 4 to 6 feet.",
      ".EXTENDED...",
      ".MONDAY...",
      "Rip Current Risk*...........High."
    ]));
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({});
    // Sunday midday: the inline SUNDAY line is a summary, never a candidate.
    expect(ripRiskByZone(text, "2026-07-05T15:00:00Z")).toEqual({});
  });

  it("picks the period covering the instant: TODAY, TONIGHT, then nothing before dawn", function () {
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], SAT_STAMP, [
      ".TODAY...",
      "Rip Current Risk*...........High.",
      ".TONIGHT...",
      "Rip Current Risk*...........Low.",
      ".SUNDAY...",
      "Rip Current Risk*...........Moderate."
    ]));
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({ MIZ037: "HIGH" });
    // 9 PM EDT Saturday.
    expect(ripRiskByZone(text, "2026-07-05T01:00:00Z")).toEqual({ MIZ037: "LOW" });
    // 5 AM EDT Sunday: TONIGHT runs to 06:00.
    expect(ripRiskByZone(text, "2026-07-05T09:00:00Z")).toEqual({ MIZ037: "LOW" });
    // Sunday 10 AM EDT.
    expect(ripRiskByZone(text, "2026-07-05T14:00:00Z")).toEqual({ MIZ037: "MODERATE" });
    // Sunday 11 PM EDT: no period covers it and the product is 41 h old.
    expect(ripRiskByZone(text, "2026-07-06T03:00:00Z")).toEqual({});
  });

  it("REST OF TODAY runs from issuance, and a day-part label covers only its hours", function () {
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], "241 PM EDT Sat Jul 4 2026", [
      ".REST OF TODAY...",
      "Rip Current Risk*...........High.",
      ".SUNDAY MORNING...",
      "Rip Current Risk*...........Low.",
      ".SUNDAY AFTERNOON...",
      "Rip Current Risk*...........Moderate.",
      ".SUNDAY NIGHT...",
      "Rip Current Risk*...........High."
    ]));
    // 2:00 PM EDT, before issuance.
    expect(ripRiskByZone(text, "2026-07-04T18:00:00Z")).toEqual({});
    // 3:00 PM EDT.
    expect(ripRiskByZone(text, "2026-07-04T19:00:00Z")).toEqual({ MIZ037: "HIGH" });
    // Sunday 8 AM, 1 PM and 8 PM EDT.
    expect(ripRiskByZone(text, "2026-07-05T12:00:00Z")).toEqual({ MIZ037: "LOW" });
    expect(ripRiskByZone(text, "2026-07-05T17:00:00Z")).toEqual({ MIZ037: "MODERATE" });
    expect(ripRiskByZone(text, "2026-07-06T00:00:00Z")).toEqual({ MIZ037: "HIGH" });
  });

  it("yields nothing once the product is older than SRF_MAX_AGE_MS, whatever the periods say", function () {
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], SAT_STAMP, [
      ".TODAY...",
      "Rip Current Risk*...........High.",
      ".SUNDAY...",
      "Rip Current Risk*...........High.",
      ".SUNDAY NIGHT...",
      "Rip Current Risk*...........High."
    ]));
    const issuedMs = Date.parse("2026-07-04T10:00:00Z");
    // Sunday 7 PM EDT: inside SUNDAY NIGHT, one hour past the ceiling.
    const late = new Date(issuedMs + SRF_MAX_AGE_MS + 3600000).toISOString();
    expect(ripRiskByZone(text, late)).toEqual({});
    expect(ripRiskByZone(text, "2026-07-05T15:00:00Z")).toEqual({ MIZ037: "HIGH" });
  });

  it("a stampless segment takes the product header's stamp", function () {
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], null, [
      ".TODAY...",
      "Rip Current Risk*...........Moderate."
    ]));
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({ MIZ037: "MODERATE" });
  });

  it("a segment with no stamp anywhere, or one in an unknown zone abbreviation, yields nothing", function () {
    const noStamp = segment("MIZ037-042200-", ["Mason-"], null, [
      ".TODAY...",
      "Rip Current Risk*...........High."
    ]).join("\n");
    expect(ripRiskByZone(noStamp, SAT_MIDDAY)).toEqual({});
    const oddZone = buildSrf(segment("MIZ037-042200-", ["Mason-"], "600 AM XYZ Sat Jul 4 2026", [
      ".TODAY...",
      "Rip Current Risk*...........High."
    ]));
    expect(ripRiskByZone(oddZone, SAT_MIDDAY)).toEqual({});
  });

  it("reads a 1200 PM stamp and an uppercase header stamp", function () {
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], "1200 PM EDT SAT JUL 4 2026", [
      ".REST OF TODAY...",
      "Rip Current Risk*...........High."
    ]));
    // 11:30 AM EDT, before the noon issuance.
    expect(ripRiskByZone(text, "2026-07-04T15:30:00Z")).toEqual({});
    expect(ripRiskByZone(text, "2026-07-04T16:30:00Z")).toEqual({ MIZ037: "HIGH" });
  });

  it("expands a wrapped multi-zone header and lets the first segment naming a zone win", function () {
    const text = buildSrf(
      segment("RIZ006>008-", ["MAZ019-042200-", "Newport RI-"], SAT_STAMP, [
        ".TODAY...",
        "Rip Current Risk*...........Moderate."
      ]).concat(segment("MAZ019-042200-", ["Plymouth MA-"], SAT_STAMP, [
        ".TODAY...",
        "Rip Current Risk*...........High."
      ]))
    );
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({
      RIZ006: "MODERATE", RIZ007: "MODERATE", RIZ008: "MODERATE", MAZ019: "MODERATE"
    });
  });

  it("caps a runaway range so a malformed header cannot expand into thousands of zones", function () {
    const text = buildSrf(segment("MAZ001>999-042200-", ["Everywhere-"], SAT_STAMP, [
      ".TODAY...",
      "Rip Current Risk*...........High."
    ]));
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({});
  });

  it("yields nothing for non-string, empty, no-UGC input or an unparseable instant", function () {
    expect(ripRiskByZone(null, SAT_MIDDAY)).toEqual({});
    expect(ripRiskByZone("", SAT_MIDDAY)).toEqual({});
    expect(ripRiskByZone(42, SAT_MIDDAY)).toEqual({});
    expect(ripRiskByZone(buildSrf([".TODAY...", "RIP CURRENT RISK...HIGH."]), SAT_MIDDAY)).toEqual({});
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], SAT_STAMP, [
      ".TODAY...",
      "Rip Current Risk*...........High."
    ]));
    expect(ripRiskByZone(text, "not a date")).toEqual({});
    expect(ripRiskByZone(text, null)).toEqual({});
  });

  it("a label-only line followed by no indented values yields nothing", function () {
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], SAT_STAMP, [
      ".TODAY...",
      "Rip Current Risk*...",
      "Surf Height.................2 to 4 feet."
    ]));
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({});
  });
});

describe("ripRiskByZone sub-area, continuation, heading and headline forms", function () {
  // The live ILM NCZ110 segment, whose eastern sub-area name fills the column
  // and is followed by one dot, with that sub-area raised to High.
  const ILM_STAMP = "252 AM EDT Tue Oct 13 2026";
  function ilmSegment(eastRisk, westRisk) {
    return segment("NCZ110-132015-", [
      "Coastal Brunswick-",
      "Including the beaches of Bald Head Island, Oak Island, Holden Beach, ",
      "Ocean Isle Beach, and Sunset Beach"
    ], ILM_STAMP, [
      ".TODAY...",
      "Rip Current Risk*...",
      "   East of Ocean Isle Beach." + eastRisk + ". ",
      "   Ocean Isle Beach West...." + westRisk + ". ",
      "Surf Height...",
      "   East of Ocean Isle Beach.1 to 3 feet. ",
      "   Ocean Isle Beach West....1 to 3 feet. ",
      "Thunderstorm Potential**....None. ",
      ".WEDNESDAY...",
      "Rip Current Risk*...",
      "   East of Ocean Isle Beach.Low. ",
      "   Ocean Isle Beach West....Low. "
    ]);
  }

  it("ILM NCZ110: a sub-area name followed by a single dot still decides", function () {
    expect(ripRiskByZone(buildSrf(ilmSegment("High", "Low")), MIDDAY)).toEqual({ NCZ110: "HIGH" });
    expect(ripRiskByZone(buildSrf(ilmSegment("Low", "Moderate")), MIDDAY)).toEqual({ NCZ110: "MODERATE" });
    expect(ripRiskByZone(buildSrf(ilmSegment("Low", "Low")), MIDDAY)).toEqual({ NCZ110: "LOW" });
  });

  it("a dotted sub-area name stays whole and its value is read", function () {
    const text = buildSrf(segment("FLZ124-042200-", ["Coastal Duval-"], SAT_STAMP, [
      ".TODAY...",
      "Rip Current Risk*...",
      "   St. Augustine Beach...Low.",
      "   Jacksonville Beach....Moderate."
    ]));
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({ FLZ124: "MODERATE" });
  });

  it("a sub-area line whose value opens with no risk word decides nothing", function () {
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], SAT_STAMP, [
      ".TODAY...",
      "Rip Current Risk*...",
      "   North Beach.............See the high surf advisory.",
      "   South Beach.............Low."
    ]));
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({ MIZ037: "LOW" });
  });

  it("joins a value the formatter wrapped onto a continuation line", function () {
    // Unverified against a live product: no captured product wraps the rip
    // value, only Weather, Winds and Water Temperature.
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], SAT_STAMP, [
      ".TODAY...",
      "Rip Current Risk*...........Moderate in the morning, becoming ",
      "                            high in the afternoon.",
      "Surf Height.................2 to 4 feet."
    ]));
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({ MIZ037: "HIGH" });
  });

  it("a continuation line never reaches past the value's first period", function () {
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], SAT_STAMP, [
      ".TODAY...",
      "Rip Current Risk*...........Low. Conditions may become ",
      "                            high late in the afternoon.",
      "Surf Height.................2 to 4 feet."
    ]));
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({ MIZ037: "LOW" });
  });

  it("reads past a legend heading or a label variant placed ahead of the field", function () {
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], SAT_STAMP, [
      ".TODAY...",
      "Rip Current Risk Category",
      "Rip Current Risks: High.",
      "Rip Current Risk*...........High.",
      "Surf Height.................4 to 6 feet."
    ]));
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({ MIZ037: "HIGH" });
  });

  it("reads past a label-only line with no sub-area values to a later field", function () {
    const text = buildSrf(segment("MIZ037-042200-", ["Mason-"], SAT_STAMP, [
      ".TODAY...",
      "Rip Current Risk*...",
      "Surf Height.................4 to 6 feet.",
      "Rip Current Risk*...........Moderate."
    ]));
    expect(ripRiskByZone(text, SAT_MIDDAY)).toEqual({ MIZ037: "MODERATE" });
  });

  // MHX prints only REST OF TODAY and WEDNESDAY under a headline that runs the
  // risk to 8 PM, so the 18:00 close would leave two uncovered hours.
  const MHX_STAMP = "257 AM EDT Tue Oct 13 2026";
  function mhxSegment(headline) {
    return segment("NCZ203-132015-", ["Northern Outer Banks-"], MHX_STAMP, [
      headline,
      "",
      ".REST OF TODAY...",
      "Rip Current Risk*...........Moderate. ",
      "Surf Height.................2 to 4 feet. ",
      ".WEDNESDAY...",
      "Rip Current Risk*...........Low. "
    ]);
  }

  it("a headline's explicit evening end carries the daytime period past 18:00", function () {
    const text = buildSrf(mhxSegment("...MODERATE RIP CURRENT RISK IN EFFECT UNTIL 8 PM EDT THIS EVENING..."));
    // 5:30 PM, 6:30 PM and 7:30 PM EDT.
    expect(ripRiskByZone(text, "2026-10-13T21:30:00Z")).toEqual({ NCZ203: "MODERATE" });
    expect(ripRiskByZone(text, "2026-10-13T22:30:00Z")).toEqual({ NCZ203: "MODERATE" });
    expect(ripRiskByZone(text, "2026-10-13T23:30:00Z")).toEqual({ NCZ203: "MODERATE" });
    // 8:30 PM EDT: past the headline's end, nothing covers the instant.
    expect(ripRiskByZone(text, "2026-10-14T00:30:00Z")).toEqual({});
  });

  it("a wrapped headline is read whole", function () {
    const text = buildSrf(segment("NCZ203-132015-", ["Northern Outer Banks-"], MHX_STAMP, [
      "...MODERATE RIP CURRENT RISK IN EFFECT UNTIL 8 PM EDT THIS",
      "EVENING...",
      "",
      ".REST OF TODAY...",
      "Rip Current Risk*...........Moderate. "
    ]));
    expect(ripRiskByZone(text, "2026-10-13T23:30:00Z")).toEqual({ NCZ203: "MODERATE" });
  });

  it("a headline never shortens a period, and one without an explicit end changes nothing", function () {
    const early = buildSrf(mhxSegment("...MODERATE RIP CURRENT RISK IN EFFECT UNTIL 4 PM EDT THIS AFTERNOON..."));
    // 5:30 PM EDT: REST OF TODAY still runs to 18:00.
    expect(ripRiskByZone(early, "2026-10-13T21:30:00Z")).toEqual({ NCZ203: "MODERATE" });
    expect(ripRiskByZone(early, "2026-10-13T22:30:00Z")).toEqual({});
    const through = buildSrf(mhxSegment("...MODERATE RIP CURRENT RISK IN EFFECT THROUGH THIS EVENING..."));
    expect(ripRiskByZone(through, "2026-10-13T22:30:00Z")).toEqual({});
  });

  it("a headline naming a weekday extends that day's period", function () {
    // Sunday-evening product, MONDAY period, risk until 8 PM Monday.
    const text = buildSrf(segment("VAZ099-130200-", ["Virginia Beach-"], "400 PM EDT Sun Oct 11 2026", [
      "...HIGH RIP CURRENT RISK IN EFFECT FROM 8 AM EDT MONDAY UNTIL 8 PM EDT",
      "MONDAY...",
      "",
      ".MONDAY...",
      "Rip Current Risk*...........High. "
    ]));
    // Monday 7:30 PM EDT.
    expect(ripRiskByZone(text, "2026-10-12T23:30:00Z")).toEqual({ VAZ099: "HIGH" });
    // Monday 8:30 PM EDT.
    expect(ripRiskByZone(text, "2026-10-13T00:30:00Z")).toEqual({});
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
  function tideSegment(header, nameLines, periods) {
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
    const text = buildSrf(tideSegment("NCZ106-152115-", ["Coastal Pender-", "Including the beaches of Surf City and Topsail Beach"], [
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
    const text = buildSrf(tideSegment("MAZ022-152200-", ["Barnstable MA-"], [
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
    const text = buildSrf(tideSegment("CAZ552-152130-", ["Orange County Coastal Areas-"], [
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
      tideSegment("MAZ015-016-152200-", ["Suffolk MA-Eastern Norfolk MA-"], [
        { label: "TODAY", lines: ["Tides...", "   Boston Harbor............High at 01:00 PM EDT."] }
      ]).concat(tideSegment("RIZ006>008-", ["MAZ019-152200-", "Newport RI-"], [
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
    const text = buildSrf(tideSegment("NCZ106-151430-", ["Coastal Pender-"], [
      { label: "TUESDAY", lines: ILM_TODAY }
    ]).concat(tideSegment("MIZ037-152100-", ["Mason-"], [
      { label: "REST OF TODAY", lines: ["Tides...", "   Nowhere.................High at 01:00 PM EDT."] }
    ])));
    const tides = parseSrfTides(text);
    expect(tides.NCZ106.period).toBe("TUESDAY");
    expect(tides.MIZ037.period).toBe("REST OF TODAY");
  });

  it("yields nothing for a zone with no tides block, and an empty table for a Great Lakes product", function() {
    const text = buildSrf(tideSegment("MIZ037-152100-", ["Mason-"], [
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
    const text = buildSrf(tideSegment("MAZ001>999-152200-", ["Everywhere-"], [
      { label: "TODAY", lines: ["Tides...", "   Somewhere...............High at 01:00 PM EDT."] }
    ]));
    expect(parseSrfTides(text)).toEqual({});
  });

  it("reads the captured BOX product's Nauset Beach table for MAZ022", function () {
    const tides = parseSrfTides(fixtureText("BOX"));
    expect(tides.MAZ022.period).toBe("TODAY");
    expect(tides.MAZ022.locations[0]).toEqual({
      name: "Nauset Beach",
      events: ["Low 0.4 feet (MLLW) 06:42 AM EDT.", "High 4.6 feet (MLLW) 12:48 PM EDT."]
    });
  });
});
