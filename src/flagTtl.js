// src/flagTtl.js — the "flag:" / "official:" KV lease, in its own module because
// workerd treats every named export of the Worker entry module (src/index.js) as
// a potential entrypoint and rejects any that is not a function or an
// ExportedHandler. A bare "export const FLAG_TTL_SECONDS = ..." there fails the
// Worker at startup with
//
//   Uncaught TypeError: Incorrect type for map entry 'FLAG_TTL_SECONDS':
//   the provided value is not of type 'function or ExportedHandler'.
//
// which neither wrangler deploy --dry-run nor the test suite can see; it only
// surfaces when the runtime boots the Worker. src/demandWindow.js is the
// precedent and test/workerExports.test.js is the guard.
//
// The cron path writes the lease; src/mapDirectory.js reads FLAG_TTL_MS on the
// request path to reproduce KV expiry for a stored estimate, which is what puts
// a cron-owned constant in a module both paths import. See PLAN.md section 3 for
// the lease itself and section 7 for the rotation math that sizes it.
export const FLAG_TTL_SECONDS = 25200;
export const FLAG_TTL_MS = 25200000;
