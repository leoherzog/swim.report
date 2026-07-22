// test/illinoisBeachGuard.test.js
// Pure-parser + pure-resolver unit tests for src/wqFloor/illinoisBeachGuard.js
// (KIND: wq raise-only water-quality floor). No network — every case builds
// an inline HTML fixture and exercises the exported pure functions directly.
// Project style: ES modules, no template literals, string concat with +,
// function () {} callbacks.

import { describe, it, expect, vi } from "vitest";
import {
  illinoisBeachGuard,
  matches,
  parseIllinoisBeachGuardDetail,
  floorColorForState,
  buildSiteFromState,
  buildIllinoisBeachDetailUrl,
  ILLINOIS_BEACHGUARD_CONFIRMED,
  ILLINOIS_BEACHGUARD_DETAIL_BASE,
  ILLINOIS_BEACHGUARD_LABEL
} from "../src/wqFloor/illinoisBeachGuard.js";
import { installFetch } from "./helpers/fetch.js";

const NOW_ISO = "2026-07-21T12:00:00.000Z";

// Inline fixture builders mirroring the buildSrf/southHavenCsv pattern: keep
// the fixed page chrome here so each test supplies only the meaningful body.
function cleanPage(beachName) {
  return "<html><body>" +
    "<div>Beach Name: " + beachName + "</div>" +
    "<img id=\"Main_imgGreenFlag\" src=\"green.png\" />" +
    "<div>" + beachName + " is open.</div>" +
    "<div id=\"Main_pnlNoAdvisory\">There is no advisory or closure in effect for this beach.</div>" +
    "</body></html>";
}

function advisoryPage(beachName) {
  return "<html><body>" +
    "<div>Beach Name: " + beachName + "</div>" +
    "<img id=\"Main_imgYellowFlag\" src=\"yellow.png\" />" +
    "<div id=\"Main_pnlAdvisory\">A swim advisory is in effect due to elevated bacteria levels.</div>" +
    "</body></html>";
}

function closurePage(beachName) {
  return "<html><body>" +
    "<div>Beach Name: " + beachName + "</div>" +
    "<img id=\"Main_imgRedFlag\" src=\"red.png\" />" +
    "<div id=\"Main_pnlClosure\">This beach is closed. Swimming is prohibited due to high bacteria levels.</div>" +
    "</body></html>";
}

function driftedNoAdvisoryPanel() {
  // Panel id present, but its text no longer matches the documented "no
  // advisory or closure" wording (simulates a markup/content redesign).
  return "<html><body>" +
    "<div id=\"Main_pnlNoAdvisory\">Please check back later for updates.</div>" +
    "</body></html>";
}

describe("buildIllinoisBeachDetailUrl", function () {
  it("appends the beach id to the documented base URL", function () {
    expect(buildIllinoisBeachDetailUrl("1088")).toBe(
      ILLINOIS_BEACHGUARD_DETAIL_BASE + "1088"
    );
  });

  it("stringifies a numeric beach id", function () {
    expect(buildIllinoisBeachDetailUrl(42)).toBe(
      ILLINOIS_BEACHGUARD_DETAIL_BASE + "42"
    );
  });
});

describe("parseIllinoisBeachGuardDetail", function () {
  it("recognizes a clean no-advisory page", function () {
    const html = cleanPage("Illinois Beach State Park");
    expect(parseIllinoisBeachGuardDetail(html)).toBe("clean");
  });

  it("recognizes an active advisory page", function () {
    const html = advisoryPage("Waukegan North Beach");
    expect(parseIllinoisBeachGuardDetail(html)).toBe("advisory");
  });

  it("recognizes an active closure page", function () {
    const html = closurePage("Zion Beach");
    expect(parseIllinoisBeachGuardDetail(html)).toBe("closure");
  });

  it("prefers closure over advisory when both words appear", function () {
    const html = "<html><body>" +
      "<div id=\"Main_pnlClosure\">Beach closed. An earlier advisory has been superseded by this closure.</div>" +
      "</body></html>";
    expect(parseIllinoisBeachGuardDetail(html)).toBe("closure");
  });

  it("fails closed when the no-advisory panel id is present but its text has drifted", function () {
    expect(parseIllinoisBeachGuardDetail(driftedNoAdvisoryPanel())).toBe(null);
  });

  it("fails closed on unrecognized markup with no advisory/closure signal", function () {
    const html = "<html><body><div>Beach Name: Some Beach</div></body></html>";
    expect(parseIllinoisBeachGuardDetail(html)).toBe(null);
  });

  it("returns null for empty string and null input", function () {
    expect(parseIllinoisBeachGuardDetail("")).toBe(null);
    expect(parseIllinoisBeachGuardDetail(null)).toBe(null);
  });

  it("returns null (does not throw) on garbage input", function () {
    expect(parseIllinoisBeachGuardDetail("<<< not the expected format >>>")).toBe(null);
  });

  it("fails closed on an off-season placeholder page even when it says 'closed'", function () {
    // The only thing live probing ever returned: an off-season placeholder
    // with no advisory/closure panel. Stray whole-page "closed"/"closure"
    // wording must NOT red-flag it — only a scoped Main_pnlClosure/pnlAdvisory
    // container yields a color, so this must be null (no floor), never "red".
    const html = "<html><body>" +
      "<div>Beach Name: Illinois Beach State Park</div>" +
      "<div>No monitoring information for this year. The beach is closed for the season.</div>" +
      "</body></html>";
    expect(parseIllinoisBeachGuardDetail(html)).toBe(null);
  });
});

describe("floorColorForState", function () {
  it("maps closure to red", function () {
    expect(floorColorForState("closure")).toBe("red");
  });

  it("maps advisory to yellow", function () {
    expect(floorColorForState("advisory")).toBe("yellow");
  });

  it("maps clean to null (no floor)", function () {
    expect(floorColorForState("clean")).toBe(null);
  });

  it("maps null (unrecognized) to null (no floor)", function () {
    expect(floorColorForState(null)).toBe(null);
  });
});

describe("buildSiteFromState", function () {
  const def = {
    siteId: "waukegan-north-beach",
    names: ["waukegan north beach"],
    lat: 42.3714,
    lon: -87.8114,
    radiusMi: 1.5
  };

  it("builds a yellow-floor site for an advisory state", function () {
    const site = buildSiteFromState(def, "advisory", NOW_ISO);
    expect(site.siteId).toBe("waukegan-north-beach");
    expect(site.floorColor).toBe("yellow");
    expect(site.names).toEqual(["waukegan north beach"]);
    expect(site.lat).toBe(42.3714);
    expect(site.lon).toBe(-87.8114);
    expect(site.updated).toBe(NOW_ISO);
    expect(site.reason.indexOf(ILLINOIS_BEACHGUARD_LABEL) !== -1).toBe(true);
  });

  it("builds a red-floor site for a closure state", function () {
    const site = buildSiteFromState(def, "closure", NOW_ISO);
    expect(site.floorColor).toBe("red");
  });

  it("never emits a green or double-red floorColor", function () {
    const advisorySite = buildSiteFromState(def, "advisory", NOW_ISO);
    const closureSite = buildSiteFromState(def, "closure", NOW_ISO);
    expect(["yellow", "red"]).toContain(advisorySite.floorColor);
    expect(["yellow", "red"]).toContain(closureSite.floorColor);
  });

  it("returns null (no site) for a clean state", function () {
    expect(buildSiteFromState(def, "clean", NOW_ISO)).toBe(null);
  });

  it("returns null (no site) for an unrecognized/null state", function () {
    expect(buildSiteFromState(def, null, NOW_ISO)).toBe(null);
  });
});

describe("matches", function () {
  it("matches a beach inside the curated Illinois Lake Michigan box", function () {
    expect(matches({ lat: 42.3714, lon: -87.8114 })).toBe(true);
  });

  it("does not match a beach far outside the box (e.g. a Michigan beach)", function () {
    expect(matches({ lat: 44.8, lon: -83.3 })).toBe(false);
  });

  it("does not match a beach with missing/non-numeric coordinates", function () {
    expect(matches({ lat: null, lon: -87.8 })).toBe(false);
    expect(matches({})).toBe(false);
  });

  it("returns false for a null/undefined beach rather than throwing", function () {
    expect(matches(null)).toBe(false);
    expect(matches(undefined)).toBe(false);
  });
});

describe("illinoisBeachGuard source object shape", function () {
  it("exposes the locked wq source contract fields", function () {
    expect(illinoisBeachGuard.id).toBe("illinois-beachguard");
    expect(typeof illinoisBeachGuard.label).toBe("string");
    expect(typeof illinoisBeachGuard.infoUrl).toBe("string");
    expect(typeof illinoisBeachGuard.matches).toBe("function");
    expect(typeof illinoisBeachGuard.scrape).toBe("function");
  });

  it("matches() on the object delegates to the exported pure matcher", function () {
    expect(illinoisBeachGuard.matches({ lat: 42.4633, lon: -87.8113 })).toBe(true);
    expect(illinoisBeachGuard.matches({ lat: 10, lon: 10 })).toBe(false);
  });
});

describe("illinoisBeachGuard fail-closed inert gate", function () {
  it("ships unconfirmed (BeachIDs/markup guesses)", function () {
    expect(ILLINOIS_BEACHGUARD_CONFIRMED).toBe(false);
  });

  it("scrape() returns null WITHOUT fetching while unconfirmed", async function () {
    const calls = installFetch(function () {
      return Promise.reject(new Error("network must not be reached"));
    });
    try {
      const result = await illinoisBeachGuard.scrape(NOW_ISO);
      expect(result).toBe(null);
      // Fail-closed inert: no BeachDetail.aspx request is made at all, so an
      // unverified BeachID can never bind a color to a beach.
      expect(calls.length).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
