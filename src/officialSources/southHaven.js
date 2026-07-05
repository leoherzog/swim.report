// src/officialSources/southHaven.js
// Official scraper for South Haven, Michigan public beach flag status.
// scrape() runs cron-side only; parseSouthHavenHtml is pure and exported for
// tests.

export const SOUTH_HAVEN_URL =
  "https://www.southhavenmi.gov/parks_and_recreation/beach_flag_information.php";

// southhavenmi.gov returns HTTP 403 to requests without a User-Agent, and
// Workers' fetch sends none by default.
export const SOUTH_HAVEN_USER_AGENT = "swim.report (hello@swim.report)";

export function parseSouthHavenHtml(html) {
  if (!html) {
    return null;
  }
  const match = /\b(Green|Yellow|Red|Grey|Gray)2?\.png\b/i.exec(html);
  if (!match) {
    return null;
  }
  const label = match[1].toLowerCase();
  if (label === "green" || label === "yellow" || label === "red") {
    return label;
  }
  // Grey/Gray means unmonitored (9pm-9am / off-season) — no official data.
  return null;
}

function inSouthHavenBox(beach) {
  return beach.lat >= 42.35 && beach.lat <= 42.45 && beach.lon >= -86.32 && beach.lon <= -86.24;
}

export const southHaven = {
  id: "south-haven-mi",
  label: "City of South Haven Beach Flag Program",
  url: SOUTH_HAVEN_URL,
  matches: function(beach) {
    if (/south haven/i.test(beach.name)) {
      return true;
    }
    return inSouthHavenBox(beach);
  },
  scrape: async function(nowIso) {
    try {
      const response = await fetch(SOUTH_HAVEN_URL, {
        headers: { "User-Agent": SOUTH_HAVEN_USER_AGENT }
      });
      if (!response.ok) {
        console.log("southHaven: fetch failed: HTTP " + response.status);
        return null;
      }
      const html = await response.text();
      const color = parseSouthHavenHtml(html);
      if (!color) {
        return null;
      }
      return {
        color: color,
        reason: "Official flag reported by City of South Haven Beach Flag Program",
        official: true,
        scraperId: "south-haven-mi",
        source: SOUTH_HAVEN_URL,
        sources: [SOUTH_HAVEN_URL],
        updated: nowIso
      };
    } catch (err) {
      console.log("southHaven: fetch failed: " + err.message);
      return null;
    }
  }
};
