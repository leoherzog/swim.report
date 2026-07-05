// src/officialSources/index.js
// Registry of official flag scrapers. Append future scrapers to the
// scrapers array. Runs cron-side only; the fetch handler never touches
// this module's network-calling functions.

import { southHaven } from "./southHaven.js";

export const scrapers = [southHaven];

export function findScraper(beach) {
  for (let i = 0; i < scrapers.length; i++) {
    const scraper = scrapers[i];
    if (scraper.matches(beach)) {
      return scraper;
    }
  }
  return null;
}

export async function scrapeOfficialFlag(beach, nowIso) {
  const scraper = findScraper(beach);
  if (!scraper) {
    return null;
  }
  try {
    const result = await scraper.scrape(nowIso);
    if (!result) {
      return null;
    }
    result.beachId = beach.id;
    return result;
  } catch (err) {
    console.log("officialSources: scrape failed for " + scraper.id + ": " + err.message);
    return null;
  }
}
