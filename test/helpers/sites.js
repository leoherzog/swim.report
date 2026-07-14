// test/helpers/sites.js
// Finds a per-beach scraper site by its siteId, or null when none matches.
export function findSite(sites, siteId) {
  for (let i = 0; i < sites.length; i++) {
    if (sites[i].siteId === siteId) {
      return sites[i];
    }
  }
  return null;
}
