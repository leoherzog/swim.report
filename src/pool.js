// src/pool.js
// Wall-clock budgets and bounded-concurrency fan-out for the cron path.
//
// Why this is its own module and not part of src/index.js: src/index.js is the
// Worker ENTRY module, and workerd treats every named export there as a
// potential entrypoint. These two are functions, so they would survive the
// startup check — but they are also needed standalone by the unit tests, and
// the entry module is the wrong place to grow a general-purpose helper.
// Precedent: src/demandWindow.js.
//
// The problem these solve: a sequential per-beach await env.FLAGS.put(...) fan-out
// costs ~0.45 s per put, so a few thousand keys exceed the 900 s scheduled
// invocation ceiling and the run is SIGKILLed mid-loop, with no cursor, no
// partial-progress record and no completion log. runPool bounds the fan-out;
// makeDeadline lets a phase YIELD before the platform kills it, so a truncated
// run persists a prefix instead of losing the whole invocation.

// A wall-clock budget measured from a fixed start instant.
//
// expired() uses >=, NOT >, deliberately: the test suite's dominant idiom
// is vi.useFakeTimers({ toFake: ["Date"] }), which FREEZES Date.now(). Under
// a frozen clock a > guard can never fire, which would make every budget in
// the cron untestable; with >=, a numeric env override of 0 trips
// immediately and the deadline branch becomes reachable in a test that never
// advances time. In production the difference is one millisecond.
export function makeDeadline(startedMs, budgetMs) {
  return {
    expired: function () {
      return (Date.now() - startedMs) >= budgetMs;
    },
    elapsedMs: function () {
      return Date.now() - startedMs;
    }
  };
}

// Bounded-concurrency map over items, worker-PULL rather than fixed chunks.
//
// limit runner promises each loop pulling the next unclaimed index off a
// shared counter. A fixed chunk + Promise.all would stall the whole window on
// its slowest member every chunk boundary; a pull pool keeps the window
// saturated, which matters because per-beach KV puts have a long tail.
//
// limit is the REQUESTED width. Cloudflare caps an invocation at six
// SIMULTANEOUS OPEN CONNECTIONS and KV get/put count toward that cap, so a
// requested width above ~6 yields ~6 in flight with the remainder queued by the
// platform. Callers should size their wall-clock math at 6, never at the
// requested width.
//
// worker is called as worker(item, index) and its result is ignored — a
// throw is caught, logged, and the pool CONTINUES. One rejecting KV put must
// never abort the other 1000 beaches, which is the whole reason this catch is
// here rather than left to Promise.all's fail-fast semantics. Callers that
// need their own log line or counter bookkeeping should still wrap their body
// in a try/catch; this catch is the backstop, not the contract.
//
// deadline is OPTIONAL (anything with an expired() method — normally a
// makeDeadline result). It is checked BETWEEN items, never inside one, so the
// pool can overshoot by at most the duration of the longest single unit of
// work in flight; bounding that unit is the transport timeout's job, not this
// function's. Omit deadline and the pool always drains.
//
// Returns the number of items the pool REACHED — including items whose worker
// threw, excluding items skipped because the deadline tripped. Callers use the
// shortfall against items.length to log truncation.
export async function runPool(items, limit, worker, deadline) {
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  let processed = 0;

  async function runner() {
    for (;;) {
      if (deadline && deadline.expired()) {
        break;
      }
      // Claim an index. next is read and incremented in one synchronous
      // step with no await between the two, so no two runners can ever claim
      // the same item and no item can be skipped.
      const i = next;
      next = next + 1;
      if (i >= items.length) {
        break;
      }
      try {
        await worker(items[i], i);
      } catch (err) {
        console.log("pool: worker threw: " + (err && err.message ? err.message : String(err)));
      }
      processed = processed + 1;
    }
  }

  const runners = [];
  for (let w = 0; w < width; w++) {
    runners.push(runner());
  }
  await Promise.all(runners);
  return processed;
}
