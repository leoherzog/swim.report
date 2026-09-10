// src/flagTtl.js — the estimate and official lease length, in its own module
// because workerd treats every named export of the Worker entry module
// (src/index.js) as a potential entrypoint and rejects any that is not a
// function or an ExportedHandler. A bare constant export there fails the Worker
// at startup with
//
//   Uncaught TypeError: Incorrect type for map entry 'FLAG_TTL_SECONDS':
//   the provided value is not of type 'function or ExportedHandler'.
//
// which neither wrangler deploy --dry-run nor the test suite can see; it only
// surfaces when the runtime boots the Worker. src/demandWindow.js is the
// precedent and test/workerExports.test.js is the guard.
//
// The hourly cron stamps beach_state.estimate_expires and official_expires this
// many seconds past its write instant, and readers compare those columns against
// the request instant. See PLAN.md section 2 for the columns and section 7 for
// the rotation math that sizes the lease.
export const FLAG_TTL_SECONDS = 25200;
