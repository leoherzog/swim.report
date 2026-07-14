// test/ohioBeachGuard.test.js
// Pure-function tests for the Ohio ODH BeachGuard scraper. No network: every
// fixture is an inline object/string built with quoted strings and + (no
// backticks). Fixtures mirror the real /beacheslist/{id} payload shape, trimmed
// to the fields the parser reads (the heavy "metadata" siblings are omitted —
// the parser ignores them anyway).
import { describe, it, expect } from "vitest";
import {
  parseIsoToEpoch,
  parseAdvisoryDate,
  currentSeasonWindow,
  selectCurrentAdvisory,
  isCurrentAdvisory,
  advisoryColor,
  parseOhioBeach,
  parseBeachesListJson,
  ohioBeachGuard,
  OHIO_SITES
} from "../src/officialSources/ohioBeachGuard.js";
import { makeBeach } from "./helpers/beach.js";

// nowIso used across in-season tests (season runs ~05-23 .. 09-07).
const NOW_IN_SEASON = "2026-07-05T12:00:00.000Z";
const NOW_OUT_OF_SEASON = "2026-12-15T12:00:00.000Z";

function currentMonitorings() {
  // Two concurrent current-year plans with slightly different dates, as the
  // real payload has (Algae + Bacteria).
  return [
    {
      isCurrentYear: true,
      planTypeText: "Algae",
      swimSeasonStartDate: "2026-05-23T12:34:57.9370000-04:00",
      swimSeasonEndDate: "2026-09-07T12:35:00.6230000-04:00"
    },
    {
      isCurrentYear: true,
      planTypeText: "Bacteria",
      swimSeasonStartDate: "2026-05-25T15:56:47.3330000-04:00",
      swimSeasonEndDate: "2026-09-07T15:56:49.0830000-04:00"
    },
    {
      isCurrentYear: false,
      planTypeText: "Bacteria",
      swimSeasonStartDate: "2025-05-25T15:56:47.3330000-04:00",
      swimSeasonEndDate: "2025-09-07T15:56:49.0830000-04:00"
    }
  ];
}

const SITE_162 = OHIO_SITES[0];

describe("OHIO_SITES coverage", function() {
  it("keeps South Bass Island as the first entry (stable index for tests)", function() {
    expect(OHIO_SITES[0].id).toBe("162");
    expect(OHIO_SITES[0].siteId).toBe("south-bass-island");
  });

  it("covers the full curated Lake Erie public-beach set (well beyond the original 4)", function() {
    expect(OHIO_SITES.length).toBeGreaterThanOrEqual(50);
  });

  it("has a unique id and unique siteId for every entry", function() {
    const ids = OHIO_SITES.map(function(s) { return s.id; });
    const siteIds = OHIO_SITES.map(function(s) { return s.siteId; });
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(siteIds).size).toBe(siteIds.length);
  });

  it("only ever puts distinctive, lowercase, non-generic names in names[]", function() {
    // A bare generic token as a name substring would risk cross-attributing an
    // official flag to an unrelated same-named beach (a potential false color).
    const generic = ["beach", "park", "state park", "lakeview", "main street", "battery park", "lakeside"];
    for (const site of OHIO_SITES) {
      for (const name of site.names) {
        expect(typeof name).toBe("string");
        expect(name.length).toBeGreaterThan(4);
        expect(name).toBe(name.toLowerCase());
        expect(generic.indexOf(name)).toBe(-1);
      }
    }
  });
});

describe("parseIsoToEpoch", function() {
  it("parses a 7-digit-fractional offset timestamp", function() {
    // 2026-05-23T12:34:57.937-04:00 == 2026-05-23T16:34:57.937Z
    const epoch = parseIsoToEpoch("2026-05-23T12:34:57.9370000-04:00");
    expect(epoch).toBe(Date.UTC(2026, 4, 23, 16, 34, 57, 937));
  });

  it("parses a Z timestamp with millisecond fraction", function() {
    expect(parseIsoToEpoch("2026-07-05T12:00:00.000Z")).toBe(Date.UTC(2026, 6, 5, 12, 0, 0, 0));
  });

  it("parses a timestamp with no fractional seconds", function() {
    expect(parseIsoToEpoch("2026-07-05T12:00:00Z")).toBe(Date.UTC(2026, 6, 5, 12, 0, 0, 0));
  });

  it("returns null on malformed or non-string input", function() {
    expect(parseIsoToEpoch("not-a-date")).toBe(null);
    expect(parseIsoToEpoch("2026-13-01T00:00:00Z")).toBe(null);
    expect(parseIsoToEpoch("06/08/2010 9:44 AM")).toBe(null);
    expect(parseIsoToEpoch(null)).toBe(null);
    expect(parseIsoToEpoch(undefined)).toBe(null);
  });
});

describe("parseAdvisoryDate", function() {
  it("parses MM/DD/YYYY with 12-hour time", function() {
    expect(parseAdvisoryDate("08/19/2024 9:44 AM")).toBe(Date.UTC(2024, 7, 19, 9, 44, 0, 0));
  });

  it("handles 12 PM and 12 AM correctly", function() {
    expect(parseAdvisoryDate("06/10/2025 12:45 PM")).toBe(Date.UTC(2025, 5, 10, 12, 45, 0, 0));
    expect(parseAdvisoryDate("06/10/2025 12:05 AM")).toBe(Date.UTC(2025, 5, 10, 0, 5, 0, 0));
  });

  it("parses the bare MM/DD/YYYY (no time) legacy format", function() {
    expect(parseAdvisoryDate("06/08/2010")).toBe(Date.UTC(2010, 5, 8, 0, 0, 0, 0));
  });

  it("returns null on malformed or non-string input", function() {
    expect(parseAdvisoryDate("2026-05-23T12:34:57Z")).toBe(null);
    expect(parseAdvisoryDate("13/40/2020")).toBe(null);
    expect(parseAdvisoryDate("06/10/2025 13:00 PM")).toBe(null);
    expect(parseAdvisoryDate(null)).toBe(null);
  });
});

describe("currentSeasonWindow", function() {
  it("spans min(start)/max(end) across current-year plans", function() {
    const window = currentSeasonWindow(currentMonitorings());
    expect(window).not.toBe(null);
    // earliest of the two current-year starts (05-23), latest end (09-07).
    expect(window.start).toBe(parseIsoToEpoch("2026-05-23T12:34:57.9370000-04:00"));
    expect(window.end).toBe(parseIsoToEpoch("2026-09-07T15:56:49.0830000-04:00"));
  });

  it("ignores non-current-year plans", function() {
    const window = currentSeasonWindow(currentMonitorings());
    // The 2025 plan must not widen the window.
    expect(window.start).toBeGreaterThan(parseIsoToEpoch("2026-01-01T00:00:00Z"));
  });

  it("returns null when no current-year plan has parseable dates", function() {
    expect(currentSeasonWindow([
      { isCurrentYear: true, swimSeasonStartDate: "garbage", swimSeasonEndDate: "garbage" }
    ])).toBe(null);
    expect(currentSeasonWindow([])).toBe(null);
    expect(currentSeasonWindow(null)).toBe(null);
  });
});

describe("selectCurrentAdvisory", function() {
  it("ignores historical advisories and trusts isCurrentAdvisory, not order", function() {
    const advisories = [
      { isCurrentAdvisory: false, typeId: "CONTAM_ADV", typeSeverityLevel: 1, startDate: "08/19/2024 9:44 AM" },
      { isCurrentAdvisory: true, typeId: "CONTAM_ADV", typeSeverityLevel: 1, startDate: "07/01/2026 8:51 AM" },
      { isCurrentAdvisory: false, typeId: "HAB_WARNING_ADV", typeSeverityLevel: 4, startDate: "06/10/2025 12:45 PM" }
    ];
    const chosen = selectCurrentAdvisory(advisories);
    expect(chosen).toBe(advisories[1]);
  });

  it("prefers the most severe among concurrent current advisories", function() {
    const advisories = [
      { isCurrentAdvisory: true, typeId: "CONTAM_ADV", typeSeverityLevel: 1, startDate: "07/01/2026 8:51 AM" },
      { isCurrentAdvisory: true, typeId: "HAB_WARNING_ADV", typeSeverityLevel: 4, startDate: "07/02/2026 9:00 AM" }
    ];
    expect(selectCurrentAdvisory(advisories).typeId).toBe("HAB_WARNING_ADV");
  });

  it("returns null when no advisory is current (array retains full history)", function() {
    const advisories = [
      { isCurrentAdvisory: false, typeId: "CONTAM_ADV", typeSeverityLevel: 1, startDate: "08/19/2024 9:44 AM" }
    ];
    expect(selectCurrentAdvisory(advisories)).toBe(null);
    expect(selectCurrentAdvisory([])).toBe(null);
    expect(selectCurrentAdvisory(null)).toBe(null);
  });

  it("treats reopenDate 'Ongoing' as current even if isCurrentAdvisory is missing", function() {
    // Defense in depth: a live hazard whose isCurrentAdvisory boolean is absent/
    // renamed must not be silently ignored (which would produce a false green).
    const advisories = [
      { typeId: "HAB_WARNING_ADV", typeSeverityLevel: 4, reopenDate: "Ongoing", startDate: "07/01/2026 8:51 AM" }
    ];
    expect(selectCurrentAdvisory(advisories).typeId).toBe("HAB_WARNING_ADV");
  });
});

describe("isCurrentAdvisory", function() {
  it("is true when isCurrentAdvisory === true", function() {
    expect(isCurrentAdvisory({ isCurrentAdvisory: true })).toBe(true);
  });

  it("is true when reopenDate is the literal 'Ongoing' (any case/whitespace)", function() {
    expect(isCurrentAdvisory({ reopenDate: "Ongoing" })).toBe(true);
    expect(isCurrentAdvisory({ reopenDate: "  ongoing " })).toBe(true);
  });

  it("is false for a resolved advisory with a real reopen timestamp", function() {
    expect(isCurrentAdvisory({ isCurrentAdvisory: false, reopenDate: "07/03/2026 8:00 AM" })).toBe(false);
    expect(isCurrentAdvisory(null)).toBe(false);
  });
});

describe("advisoryColor", function() {
  it("maps HAB warning (severity 4 / no-swim) to red", function() {
    expect(advisoryColor({ typeId: "HAB_WARNING_ADV", typeSeverityLevel: 4 })).toBe("red");
  });

  it("maps a bacteria contamination advisory to yellow", function() {
    expect(advisoryColor({ typeId: "CONTAM_ADV", typeSeverityLevel: 1 })).toBe("yellow");
  });

  it("maps an unrecognized current advisory to yellow (never green)", function() {
    expect(advisoryColor({ typeId: "SOMETHING_NEW", typeSeverityLevel: 2 })).toBe("yellow");
  });

  it("maps a HAB watch (severity 3, avoid-contact) UP to red, not yellow", function() {
    // ODH renders HAB_WATCH_ADV as its distinct orange tier and it advises
    // against water contact. swim.report has no orange, so we collapse it up to
    // red (only ever more cautious) rather than down to yellow — it must not be
    // presented as merely a bacteria-level caution.
    expect(advisoryColor({ typeId: "HAB_WATCH_ADV", typeSeverityLevel: 3 })).toBe("red");
  });
});

describe("parseOhioBeach", function() {
  it("returns green when in season with zero current advisories", function() {
    const record = {
      beachName: "South Bass Island State Park",
      monitorings: currentMonitorings(),
      advisories: [
        { isCurrentAdvisory: false, typeId: "CONTAM_ADV", typeSeverityLevel: 1, startDate: "06/10/2025 12:45 PM" }
      ]
    };
    const site = parseOhioBeach(record, SITE_162, NOW_IN_SEASON);
    expect(site).not.toBe(null);
    expect(site.color).toBe("green");
    expect(site.siteId).toBe("south-bass-island");
    expect(site.names).toEqual(SITE_162.names);
    expect(site.lat).toBe(SITE_162.lat);
    expect(site.reason.indexOf("Monitored and clear")).toBe(0);
  });

  it("returns the advisory color and includes the type in the reason", function() {
    const record = {
      beachName: "South Bass Island State Park",
      monitorings: currentMonitorings(),
      advisories: [
        {
          isCurrentAdvisory: true,
          typeId: "CONTAM_ADV",
          typeText: "Bacteria Contamination Advisory",
          typeSeverityLevel: 1,
          reasonTypeText: "High bacteria levels",
          startDate: "07/01/2026 8:51 AM"
        }
      ]
    };
    const site = parseOhioBeach(record, SITE_162, NOW_IN_SEASON);
    expect(site.color).toBe("yellow");
    expect(site.reason.indexOf("Bacteria Contamination Advisory")).toBeGreaterThan(-1);
    expect(site.reason.indexOf("High bacteria levels")).toBeGreaterThan(-1);
    // Periodic-testing source: the reason must carry the advisory's own issue
    // (sample) date, not just the cron tick timestamp.
    expect(site.reason.indexOf("07/01/2026 8:51 AM")).toBeGreaterThan(-1);
  });

  it("stamps an advisory site's updated with the advisory issue date, not nowIso", function() {
    // Regression: an advisory can have been issued days or weeks ago; stamping
    // nowIso would present it as freshly updated and suppress the frontend's
    // 2-hour stale-data warning.
    const record = {
      beachName: "South Bass Island State Park",
      monitorings: currentMonitorings(),
      advisories: [
        {
          isCurrentAdvisory: true,
          typeId: "CONTAM_ADV",
          typeText: "Bacteria Contamination Advisory",
          typeSeverityLevel: 1,
          startDate: "07/01/2026 8:51 AM"
        }
      ]
    };
    const site = parseOhioBeach(record, SITE_162, NOW_IN_SEASON);
    expect(site.updated).toBe(new Date(Date.UTC(2026, 6, 1, 8, 51, 0, 0)).toISOString());
    expect(site.updated).not.toBe(NOW_IN_SEASON);
  });

  it("leaves updated unset on an advisory with an unparseable startDate (falls back to nowIso downstream — never a color change)", function() {
    const record = {
      beachName: "South Bass Island State Park",
      monitorings: currentMonitorings(),
      advisories: [
        { isCurrentAdvisory: true, typeId: "CONTAM_ADV", typeSeverityLevel: 1, startDate: "sometime last week" }
      ]
    };
    const site = parseOhioBeach(record, SITE_162, NOW_IN_SEASON);
    expect(site.color).toBe("yellow");
    expect(site.updated).toBe(undefined);
  });

  it("leaves updated unset on a monitored-and-clear green (live state; resolver falls back to nowIso)", function() {
    const record = {
      beachName: "South Bass Island State Park",
      monitorings: currentMonitorings(),
      advisories: []
    };
    const site = parseOhioBeach(record, SITE_162, NOW_IN_SEASON);
    expect(site.color).toBe("green");
    expect(site.updated).toBe(undefined);
  });

  it("returns red for an active HAB watch advisory (avoid-contact, no orange tier)", function() {
    const record = {
      beachName: "South Bass Island State Park",
      monitorings: currentMonitorings(),
      advisories: [
        {
          isCurrentAdvisory: true,
          typeId: "HAB_WATCH_ADV",
          typeText: "Recreational Public Health Advisory",
          typeSeverityLevel: 3,
          reasonTypeText: "Algal Bloom/Toxin",
          startDate: "07/01/2026 8:51 AM"
        }
      ]
    };
    expect(parseOhioBeach(record, SITE_162, NOW_IN_SEASON).color).toBe("red");
  });

  it("returns red for an active HAB warning advisory", function() {
    const record = {
      beachName: "South Bass Island State Park",
      monitorings: currentMonitorings(),
      advisories: [
        {
          isCurrentAdvisory: true,
          typeId: "HAB_WARNING_ADV",
          typeText: "Recreational Public Health Advisory",
          typeSeverityLevel: 4,
          reasonTypeText: "Algal Bloom/Toxin",
          startDate: "07/01/2026 8:51 AM"
        }
      ]
    };
    expect(parseOhioBeach(record, SITE_162, NOW_IN_SEASON).color).toBe("red");
  });

  it("omits the site (null) when nowIso is outside the swim season", function() {
    const record = {
      beachName: "South Bass Island State Park",
      monitorings: currentMonitorings(),
      advisories: []
    };
    expect(parseOhioBeach(record, SITE_162, NOW_OUT_OF_SEASON)).toBe(null);
  });

  it("does NOT assert green when advisories is null/missing (malformed/partial payload)", function() {
    // The bulk endpoint returns advisories: null; a partial read or API change
    // could surface the same. "No advisory field" must never read as "no
    // advisory" -> the site is omitted, never an unverified official green.
    const nullAdvisories = {
      beachName: "South Bass Island State Park",
      monitorings: currentMonitorings(),
      advisories: null
    };
    expect(parseOhioBeach(nullAdvisories, SITE_162, NOW_IN_SEASON)).toBe(null);
    const missingAdvisories = {
      beachName: "South Bass Island State Park",
      monitorings: currentMonitorings()
    };
    expect(parseOhioBeach(missingAdvisories, SITE_162, NOW_IN_SEASON)).toBe(null);
    const nonArrayAdvisories = {
      beachName: "South Bass Island State Park",
      monitorings: currentMonitorings(),
      advisories: { isCurrentAdvisory: true }
    };
    expect(parseOhioBeach(nonArrayAdvisories, SITE_162, NOW_IN_SEASON)).toBe(null);
  });

  it("reports red for an in-season 'Ongoing' HAB advisory lacking isCurrentAdvisory", function() {
    // A live ongoing hazard whose isCurrentAdvisory boolean is absent must still
    // surface as a caution/hazard, never fall through to green.
    const record = {
      beachName: "South Bass Island State Park",
      monitorings: currentMonitorings(),
      advisories: [
        { typeId: "HAB_WARNING_ADV", typeText: "Recreational Public Health Advisory", typeSeverityLevel: 4, reopenDate: "Ongoing", startDate: "07/01/2026 8:51 AM" }
      ]
    };
    expect(parseOhioBeach(record, SITE_162, NOW_IN_SEASON).color).toBe("red");
  });

  it("omits the site (null) on malformed season dates or unexpected shape", function() {
    const badDates = {
      beachName: "South Bass Island State Park",
      monitorings: [
        { isCurrentYear: true, swimSeasonStartDate: "nonsense", swimSeasonEndDate: "nonsense" }
      ],
      advisories: []
    };
    expect(parseOhioBeach(badDates, SITE_162, NOW_IN_SEASON)).toBe(null);
    expect(parseOhioBeach(null, SITE_162, NOW_IN_SEASON)).toBe(null);
    expect(parseOhioBeach({ monitorings: currentMonitorings() }, SITE_162, "not-a-timestamp")).toBe(null);
  });
});

describe("parseBeachesListJson", function() {
  it("extracts queryResults[0]", function() {
    const text = "{\"metadata\":null,\"queryResults\":[{\"id\":\"162\",\"beachName\":\"South Bass Island State Park\"}],\"hasResultsRemaining\":false}";
    const record = parseBeachesListJson(text);
    expect(record).not.toBe(null);
    expect(record.id).toBe("162");
  });

  it("returns null for an empty queryResults (unknown id, still HTTP 200)", function() {
    expect(parseBeachesListJson("{\"queryResults\":[]}")).toBe(null);
  });

  it("returns null for invalid JSON without throwing", function() {
    expect(parseBeachesListJson("<html>not json</html>")).toBe(null);
    expect(parseBeachesListJson("")).toBe(null);
  });
});

describe("ohioBeachGuard.matches", function() {
  it("matches by name substring", function() {
    const beach = makeBeach({
      name: "South Bass Island State Park Beach",
      lat: 41.7,
      lon: -82.9
    });
    expect(ohioBeachGuard.matches(beach)).toBe(true);
  });

  it("matches by proximity within ~2 mi even with an unrelated name", function() {
    const beach = makeBeach({
      name: "Unnamed Swimming Area",
      lat: 41.6135,
      lon: -82.7015
    });
    expect(ohioBeachGuard.matches(beach)).toBe(true);
  });

  it("does not match a far-away beach named 'Stone Beach' (generic name is proximity-only)", function() {
    // A "Stone Beach" elsewhere on the Great Lakes must NOT inherit South Bass
    // Island's official flag: "stone beach" is intentionally not a name substring.
    const beach = makeBeach({
      name: "Stone Beach",
      lat: 45.0,
      lon: -85.0
    });
    expect(ohioBeachGuard.matches(beach)).toBe(false);
  });

  it("still covers South Bass Island's Stone Beach by proximity", function() {
    // The real Stone Beach sits within ~2 mi of the South Bass Island site.
    const beach = makeBeach({
      name: "Stone Beach",
      lat: 41.643,
      lon: -82.84
    });
    expect(ohioBeachGuard.matches(beach)).toBe(true);
  });

  it("matches a newly-covered Erie-county beach by proximity", function() {
    // Nickel Plate Beach (id 146) is one of the expanded sites.
    const beach = makeBeach({
      name: "Some Swimming Spot",
      lat: 41.3969,
      lon: -82.5438
    });
    expect(ohioBeachGuard.matches(beach)).toBe(true);
  });

  it("matches a newly-covered beach by its distinctive name substring (inside the Ohio shore box)", function() {
    // In the Ohio Lake Erie bbox but beyond the 2 mi proximity radius of the
    // Geneva site, so only the names[] pass can produce this match.
    const beach = makeBeach({
      name: "Geneva State Park Beach",
      lat: 41.9,
      lon: -80.9
    });
    expect(ohioBeachGuard.matches(beach)).toBe(true);
  });

  it("never lets a name substring match a beach outside the Ohio Lake Erie box", function() {
    // Regression: names[] used to be geographically unbounded, so an
    // out-of-state beach whose name contained an Ohio site substring inherited
    // that Ohio site's OFFICIAL flag — potentially a false affirmative green.
    const ontarioGeneva = makeBeach({
      name: "Geneva State Park Beach",
      lat: 43.0,
      lon: -80.0
    });
    expect(ohioBeachGuard.matches(ontarioGeneva)).toBe(false);
  });

  it("does not claim the Michigan Headlands dark-sky park despite the 'headlands' name substring", function() {
    // Headlands International Dark Sky Park (Mackinaw City, MI) is inside the
    // discovery pilot bbox; an unnamed OSM beach there gets
    // name = park_name containing "headlands" via the daily sync. It must
    // never receive Headlands Beach State Park OH's official color.
    const beach = makeBeach({
      name: "Headlands International Dark Sky Park",
      park_name: "Headlands International Dark Sky Park",
      lat: 45.78,
      lon: -84.77
    });
    expect(ohioBeachGuard.matches(beach)).toBe(false);
  });

  it("does not claim a beach near Fairport, Michigan despite the 'fairport harbor' substring risk", function() {
    // Fairport on Michigan's Garden Peninsula is also in the pilot bbox.
    const beach = makeBeach({
      name: "Fairport Harbor Beach",
      lat: 45.63,
      lon: -86.66
    });
    expect(ohioBeachGuard.matches(beach)).toBe(false);
  });

  it("does not match a beach without numeric coordinates (the geographic gate requires them)", function() {
    const beach = makeBeach({
      name: "Geneva State Park Beach",
      lat: null,
      lon: null
    });
    expect(ohioBeachGuard.matches(beach)).toBe(false);
  });

  it("does not match a far-away beach", function() {
    const beach = makeBeach({
      name: "Holland State Park",
      lat: 42.7739,
      lon: -86.2109
    });
    expect(ohioBeachGuard.matches(beach)).toBe(false);
  });
});
