// Agent CRON — src/demandWindow.js
//
// The hot/cold demand window, in its own module for one hard reason: workerd
// treats EVERY named export of the Worker entry module (src/index.js) as a
// potential entrypoint and rejects any that is not a function or an
// ExportedHandler. A bare "export const HOT_VIEW_WINDOW_MS = ..." there fails
// the whole Worker at STARTUP with
//
//   Uncaught TypeError: Incorrect type for map entry 'HOT_VIEW_WINDOW_MS':
//   the provided value is not of type 'function or ExportedHandler'.
//
// which neither `wrangler deploy --dry-run` nor the test suite can see — it
// only surfaces when the runtime boots the Worker (`npm run dev`, or a real
// deploy). So any constant the cron path wants to share with tests lives in a
// plain module like this one and is imported by src/index.js. Never re-add a
// non-function named export to src/index.js; test/workerExports.test.js guards
// this.
//
// 7-day window: >> the 2 h flag KV TTL so hotness never flaps with the flag
// lifecycle, and it spans weekly visit periodicity. Consumed by
// runFlagRecompute (hourly) and runWaterTempRefresh (6-hourly) to order their
// reads hot-first — a beach with a `last_viewed` demand stamp inside this window
// is always covered every run, ahead of the cold remainder that rotates on the
// run's own cursor column.
export const HOT_VIEW_WINDOW_MS = 7 * 86400000;
