// src/officialReading.js — the staleness horizon for an official point-in-time
// reading (water temperature, wave height) scraped alongside a posted flag.
//
// Its own module because both the request path (src/frontend/render.js) and the
// cron path (src/index.js, src/officialSources/index.js) need the value, and
// render.js must never import the scraper registry: that module pulls in every
// scraper, which would make an upstream fetch reachable from the request path.
// Same rule that put FLAG_TTL_SECONDS in src/flagTtl.js.

// 4 h. These readings are taken once, in the morning, at the beach itself; past
// this horizon the tile is removed rather than shown with a warning, because a
// morning water temperature is not a claim about the afternoon. The cron stamps
// beach_state.reading_expires at the same horizon, so the record normally lapses
// on its own and this check is the render-side guarantee.
//
// A scraper whose posted flag is the same morning observation declares it as
// officialMaxAgeMs, and the cron anchors official_expires to the record's
// updated instant the same way.
export const READING_MAX_AGE_MS = 4 * 60 * 60 * 1000;
