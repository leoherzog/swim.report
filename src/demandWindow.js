// src/demandWindow.js — the hot/cold demand window, in its own module because
// workerd treats every named export of the Worker entry module (src/index.js) as
// a potential entrypoint and rejects any that is not a function or an
// ExportedHandler. A bare "export const HOT_VIEW_WINDOW_MS = ..." there fails the
// Worker at startup with
//
//   Uncaught TypeError: Incorrect type for map entry 'HOT_VIEW_WINDOW_MS':
//   the provided value is not of type 'function or ExportedHandler'.
//
// which neither `wrangler deploy --dry-run` nor the test suite can see; it only
// surfaces when the runtime boots the Worker. Any constant the cron path shares
// with tests belongs in a plain module like this one, imported by src/index.js.
// Never re-add a non-function named export to src/index.js;
// test/workerExports.test.js guards this.
//
// 7 days: far longer than the 2 h flag KV TTL, so hotness never flaps with the
// flag lifecycle, and long enough to span weekly visit periodicity. Both
// beach-walking crons order their reads hot-first, so a beach with a last_viewed
// stamp inside this window is covered every run, ahead of the cold remainder
// rotating on the run's own cursor column.
export const HOT_VIEW_WINDOW_MS = 7 * 86400000;
