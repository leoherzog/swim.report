// src/robots.js — GET /robots.txt. Cloudflare's managed robots.txt is on for
// the zone and prepends its own block, which carries the AI-crawler and
// content-signal policy, so this file holds only what the Worker knows: where
// the sitemap is and which URLs are not pages of their own.

import { SITE_ORIGIN } from "./site.js";
import { CACHE_CONTROL_CACHEABLE } from "./cacheControl.js";

// Every ?q=, ?near= and ?ids= list is a view of / that canonicalizes to it,
// and near= alone spans every coordinate pair. Crawlers merge this group with
// the managed block's own "User-agent: *" group, where the longer Disallow
// outranks its "Allow: /".
export const ROBOTS_TXT =
  "User-agent: *\n" +
  "Disallow: /*?\n" +
  "\n" +
  "Sitemap: " + SITE_ORIGIN + "/sitemap.xml\n";

/**
 * @returns {Response} the robots.txt body, cacheable
 */
export function robotsResponse() {
  return new Response(ROBOTS_TXT, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": CACHE_CONTROL_CACHEABLE
    }
  });
}
