// src/officialSources/metroparks.js
// Official scraper for the Huron-Clinton Metroparks "Park Closures" page.
// This is a CLOSURE-ONLY source: it reports a plain Open/Closed facility
// status per park amenity, not a rip-current/flag color. "Closed" maps to
// red (beach access closed); "Open" is NOT an affirmative water-quality
// all-clear, so it is simply omitted (no site, no green).
//
// Empty-success semantics: a scrape that fetches and parses the page cleanly
// but finds every beach Open has nothing to report, so scrape() returns an
// empty perBeachResult ([] sites) — a SUCCESSFUL run for scraper-health
// purposes, not a failure. null is reserved strictly for real failures (fetch
// failed, neither panel found, parse threw). This matters because all four
// beaches are Open most of the season; without it a perfectly working
// closure-only source would log a permanent consecutive-null "failure" streak.
//
// scrape() runs cron-side only; parseMetroparksHtml is pure and exported for
// tests. Parsing is scoped STRICTLY to the id="KensingtonMetropark" and
// id="StonyCreekMetropark" accordion panels — the page has ~40 other
// facility Open/Closed lines (trails, golf, marinas, nature centers, etc.)
// sharing identical markup, so beach lookups must never search outside those
// two panels. Lake St. Clair Metropark's own "beach" entry is an evergreen
// "Open For Season!" placeholder deferring to EGLE Beach Guard and is
// intentionally never scraped here.

import { distanceMi } from "../geo.js";
import { fetchText, perBeachResult } from "./util.js";

export const METROPARKS_URL = "https://www.metroparks.com/park-closures/";

const KENSINGTON_PANEL_ID = "KensingtonMetropark";
const STONY_CREEK_PANEL_ID = "StonyCreekMetropark";

// Approximate park-level coordinates (Huron-Clinton Metroparks, SE Michigan).
const KENSINGTON_LAT = 42.54;
const KENSINGTON_LON = -83.69;
const STONY_CREEK_LAT = 42.66;
const STONY_CREEK_LON = -83.115;

// The two beaches per park, in the exact label text used on the page.
const KENSINGTON_BEACHES = [
  { label: "Martindale Beach", siteId: "martindale-beach", names: ["martindale beach"] },
  { label: "Maple Beach", siteId: "maple-beach", names: ["maple beach"] }
];
const STONY_CREEK_BEACHES = [
  { label: "Baypoint Beach", siteId: "baypoint-beach", names: ["baypoint beach"] },
  { label: "Eastwood Beach", siteId: "eastwood-beach", names: ["eastwood beach"] }
];

// Pure. Slices the HTML from a panel's own opening tag up to (but not
// including) the next panel's opening tag, or to the end of the document if
// this is the last panel. Returns null if the panel id is not present at all
// (page redesign / renamed id).
function slicePanel(html, panelId) {
  const startMarker = "id=\"" + panelId + "\"";
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) {
    return null;
  }
  const nextPanelMarker = "class=\"vc_tta-panel\" id=\"";
  const nextIdx = html.indexOf(nextPanelMarker, startIdx + startMarker.length);
  const endIdx = nextIdx === -1 ? html.length : nextIdx;
  return html.slice(startIdx, endIdx);
}

// Pure. Finds <strong>Label:</strong> within panelHtml, normalizes the run of
// spaces/tabs/nbsp that follows, and returns the first word lowercased if (and
// only if) it is exactly "open" or "closed". Anything else (missing label,
// embedded sentence, ALL CAPS variant handled by case-insensitive match,
// unexpected word) returns null rather than guessing.
function extractBeachStatus(panelHtml, label) {
  if (!panelHtml) {
    return null;
  }
  const regex = new RegExp(
    "<strong>" + label + ":<\\/strong>[ \\t\\u00A0]*([A-Za-z]+)",
    "i"
  );
  const match = regex.exec(panelHtml);
  if (!match) {
    return null;
  }
  const word = match[1].toLowerCase();
  if (word === "open" || word === "closed") {
    return word;
  }
  return null;
}

// Pure, exported for tests. string|null -> sites[] | null.
// Returns null only when NEITHER the Kensington nor the Stony Creek panel can
// be found at all (page redesign, renamed ids, or unrelated/garbage HTML) —
// that is a total parse failure, never an empty-but-trustworthy result.
// When at least one panel is found, beaches whose line is missing or whose
// status word is not a clean Open/Closed are simply omitted (that beach gets
// no site, not a guessed color). Open beaches are also omitted — this source
// is closure-only, so "Open" is not an affirmative all-clear.
export function parseMetroparksHtml(html) {
  if (!html) {
    return null;
  }
  const kensingtonPanel = slicePanel(html, KENSINGTON_PANEL_ID);
  const stonyCreekPanel = slicePanel(html, STONY_CREEK_PANEL_ID);
  if (!kensingtonPanel && !stonyCreekPanel) {
    console.log("metroparks: neither Kensington nor Stony Creek panel found; page may have changed");
    return null;
  }

  const sites = [];

  // Sites are resolved by NAME ONLY (no lat/lon/radiusMi). The two beaches in
  // a park sit on the same small lake and would have to share the same
  // park-centroid coordinates, so proximity resolution cannot tell them apart:
  // an OPEN beach (which produces no site) would resolve by proximity to its
  // CLOSED sibling's red — a false red on the wrong beach. Whenever one beach
  // is closed and the other open (a routine maintenance situation) that is
  // exactly what would happen. Name-only resolution means a beach only ever
  // gets a closure attributed to it when its own name matches; a generically
  // named or sibling beach resolves to no site and falls back to the estimate.
  function addClosedSites(panelHtml, beaches) {
    if (!panelHtml) {
      return;
    }
    for (let i = 0; i < beaches.length; i++) {
      const beach = beaches[i];
      const status = extractBeachStatus(panelHtml, beach.label);
      if (status !== "closed") {
        continue;
      }
      sites.push({
        siteId: beach.siteId,
        color: "red",
        reason: "Huron-Clinton Metroparks reports " + beach.label + " closed",
        names: beach.names
      });
    }
  }

  addClosedSites(kensingtonPanel, KENSINGTON_BEACHES);
  addClosedSites(stonyCreekPanel, STONY_CREEK_BEACHES);

  return sites;
}


export const metroparks = {
  id: "huron-clinton-metroparks",
  label: "Huron-Clinton Metroparks Park Closures",
  url: METROPARKS_URL,
  matches: function(beach) {
    const hasCoords = typeof beach.lat === "number" && typeof beach.lon === "number";
    const nearPark = hasCoords && (
      distanceMi(beach.lat, beach.lon, KENSINGTON_LAT, KENSINGTON_LON) <= 3 ||
      distanceMi(beach.lat, beach.lon, STONY_CREEK_LAT, STONY_CREEK_LON) <= 3
    );

    // Proximity to a park is the strongest, unambiguous signal.
    if (nearPark) {
      return true;
    }

    // park_name naming one of the two metroparks is specific to them.
    const parkName = (beach.park_name || "").toLowerCase();
    if (parkName.indexOf("kensington") !== -1 || parkName.indexOf("stony creek") !== -1) {
      return true;
    }

    // A bare beach-NAME match ("Maple Beach", "Eastwood Beach", ...) is only
    // trusted when we cannot geographically rule the beach out, i.e. it has no
    // coordinates at all. A namesake beach elsewhere on the Great Lakes (there
    // are other "Maple Beach"es on Michigan inland lakes) has coordinates far
    // from BOTH parks; if we matched it here it would then resolve — by the
    // same name — to a Kensington/Stony Creek closure and be published as a
    // FALSE OFFICIAL RED on an unrelated beach. Requiring "no coordinates"
    // means only a coordinate-less row (never produced by OSM discovery) can
    // match purely on name; every real beach must be geographically near a
    // park to be attributed a closure.
    if (!hasCoords) {
      const name = (beach.name || "").toLowerCase();
      const knownNames = ["martindale beach", "maple beach", "baypoint beach", "eastwood beach"];
      for (let i = 0; i < knownNames.length; i++) {
        if (name.indexOf(knownNames[i]) !== -1) {
          return true;
        }
      }
    }
    return false;
  },
  scrape: async function(nowIso) {
    // No headers: metroparks.com has only been probed without a User-Agent.
    const html = await fetchText(METROPARKS_URL, {
      logPrefix: "metroparks: fetch failed"
    });
    if (html === null) {
      return null;
    }
    try {
      const sites = parseMetroparksHtml(html);
      // null means a real parse failure (neither panel found / bad input) and
      // must surface as a failure. An empty array means the page parsed cleanly
      // with every beach Open — a successful scrape with nothing to report, so
      // it flows through as an empty perBeachResult (resolves to no site for
      // every beach, writes no official KV) and counts as a health success.
      if (sites === null) {
        return null;
      }
      return perBeachResult(sites, METROPARKS_URL, nowIso);
    } catch (err) {
      console.log("metroparks: fetch failed: " + err.message);
      return null;
    }
  }
};
