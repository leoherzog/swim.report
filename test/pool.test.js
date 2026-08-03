// Unit tests for src/pool.js — the bounded-concurrency write pool and the
// wall-clock budget the cron path uses to yield before workerd's 900 s
// scheduled ceiling SIGKILLs the invocation.
//
// These two primitives are tested standalone, before anything in src/index.js
// depends on them, because every claim the cron makes about termination and
// about persisting a PREFIX of a truncated run reduces to two properties
// asserted here: the pool never exceeds its width, never loses or duplicates an
// item, and never lets one throwing worker poison the batch; and the deadline
// is FIREABLE under the suite's frozen-clock idiom
// (vi.useFakeTimers({ toFake: ["Date"] })), which a > guard would not be.
import { describe, it, expect, afterEach, vi } from "vitest";
import { makeDeadline, runPool } from "../src/pool.js";

afterEach(function () {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Yields the microtask queue a few times so the runners actually interleave.
// Real timers are deliberately NOT used: several cases freeze Date, and a
// setTimeout-based worker would hang under fake timers.
async function tick(times) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function range(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push("item-" + String(i));
  }
  return out;
}

describe("runPool concurrency", function () {
  it("never exceeds limit in flight and saturates the window", async function () {
    const items = range(37);
    let inFlight = 0;
    let maxInFlight = 0;
    const processed = await runPool(items, 5, async function () {
      inFlight = inFlight + 1;
      if (inFlight > maxInFlight) {
        maxInFlight = inFlight;
      }
      await tick(3);
      inFlight = inFlight - 1;
    });
    expect(processed).toBe(37);
    expect(maxInFlight).toBe(5);
  });

  it("visits every item exactly once, passing the item and its index", async function () {
    const items = range(41);
    const seen = new Map();
    const processed = await runPool(items, 7, async function (item, index) {
      await tick(2);
      seen.set(item, (seen.get(item) || 0) + 1);
      expect(items[index]).toBe(item);
    });
    expect(processed).toBe(41);
    expect(seen.size).toBe(41);
    for (const item of items) {
      expect(seen.get(item)).toBe(1);
    }
  });

  it("clamps a limit of 0 up to 1 rather than deadlocking on zero runners", async function () {
    const items = range(4);
    let inFlight = 0;
    let maxInFlight = 0;
    const processed = await runPool(items, 0, async function () {
      inFlight = inFlight + 1;
      if (inFlight > maxInFlight) {
        maxInFlight = inFlight;
      }
      await tick(2);
      inFlight = inFlight - 1;
    });
    expect(processed).toBe(4);
    expect(maxInFlight).toBe(1);
  });

  it("handles items.length < limit without spawning idle runners", async function () {
    const items = range(3);
    let inFlight = 0;
    let maxInFlight = 0;
    const processed = await runPool(items, 12, async function () {
      inFlight = inFlight + 1;
      if (inFlight > maxInFlight) {
        maxInFlight = inFlight;
      }
      await tick(2);
      inFlight = inFlight - 1;
    });
    expect(processed).toBe(3);
    expect(maxInFlight).toBe(3);
  });

  it("resolves to 0 on an empty item list without calling the worker", async function () {
    const worker = vi.fn(async function () {});
    const processed = await runPool([], 12, worker);
    expect(processed).toBe(0);
    expect(worker).not.toHaveBeenCalled();
  });
});

describe("runPool error isolation", function () {
  it("logs a throwing worker and keeps processing the remaining items", async function () {
    // The load-bearing property: in production this is one rejecting
    // env.FLAGS.put out of ~1000 beaches. It must cost that one beach, not the
    // run.
    const log = vi.spyOn(console, "log").mockImplementation(function () {});
    const items = range(20);
    const done = [];
    const processed = await runPool(items, 4, async function (item) {
      await tick(1);
      if (item === "item-7") {
        throw new Error("kv put rejected");
      }
      done.push(item);
    });
    expect(processed).toBe(20);
    expect(done.length).toBe(19);
    expect(done.indexOf("item-7")).toBe(-1);
    expect(done.indexOf("item-19")).toBeGreaterThan(-1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("pool: worker threw: kv put rejected");
  });

  it("survives a thrown non-Error without producing an undefined log line", async function () {
    const log = vi.spyOn(console, "log").mockImplementation(function () {});
    const processed = await runPool(range(3), 2, async function (item) {
      if (item === "item-1") {
        throw "plain string failure";
      }
    });
    expect(processed).toBe(3);
    expect(log).toHaveBeenCalledWith("pool: worker threw: plain string failure");
  });
});

describe("makeDeadline", function () {
  it("is not expired at the start of a positive budget", function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));
    const deadline = makeDeadline(Date.now(), 480000);
    expect(deadline.expired()).toBe(false);
    expect(deadline.elapsedMs()).toBe(0);
  });

  it("expires once the clock passes startedMs + budgetMs", function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-08-03T12:00:00Z").getTime();
    vi.setSystemTime(start);
    const deadline = makeDeadline(start, 5000);
    vi.setSystemTime(start + 4999);
    expect(deadline.expired()).toBe(false);
    expect(deadline.elapsedMs()).toBe(4999);
    // Exactly at the budget, not one ms past it: the >= is what makes the
    // boundary inclusive.
    vi.setSystemTime(start + 5000);
    expect(deadline.expired()).toBe(true);
    vi.setSystemTime(start + 900000);
    expect(deadline.expired()).toBe(true);
    expect(deadline.elapsedMs()).toBe(900000);
  });

  it("expires IMMEDIATELY at a zero budget under a frozen clock", function () {
    // This is the case that makes every cron budget testable: the suite freezes
    // Date, so a numeric env override of 0 is the only way to reach the
    // deadline branch without advancing time. A > guard would make this
    // false forever.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));
    const deadline = makeDeadline(Date.now(), 0);
    expect(deadline.expired()).toBe(true);
    expect(deadline.elapsedMs()).toBe(0);
  });
});

describe("runPool deadline", function () {
  it("processes nothing when the deadline is already expired", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-03T12:00:00Z"));
    const worker = vi.fn(async function () {});
    const processed = await runPool(range(50), 6, worker, makeDeadline(Date.now(), 0));
    expect(processed).toBe(0);
    expect(worker).not.toHaveBeenCalled();
  });

  it("stops pulling new items once the deadline trips mid-run", async function () {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-08-03T12:00:00Z").getTime();
    vi.setSystemTime(start);
    const items = range(10);
    const done = [];
    // Width 1 makes the cutoff deterministic: each item advances the frozen
    // clock by 2000 ms, so the 3rd item ends at exactly the 5000 ms budget and
    // the 4th is never claimed.
    const processed = await runPool(items, 1, async function (item) {
      done.push(item);
      vi.setSystemTime(Date.now() + 2000);
      await tick(1);
    }, makeDeadline(start, 5000));
    expect(processed).toBe(3);
    expect(done).toEqual(["item-0", "item-1", "item-2"]);
  });

  it("honors any object exposing expired(), and leaves the tail unprocessed", async function () {
    const items = range(12);
    const done = [];
    const deadline = {
      expired: function () {
        return done.length >= 4;
      }
    };
    const processed = await runPool(items, 1, async function (item) {
      await tick(1);
      done.push(item);
    }, deadline);
    expect(processed).toBe(4);
    expect(done).toEqual(["item-0", "item-1", "item-2", "item-3"]);
  });

  it("drains everything when no deadline is passed at all", async function () {
    const processed = await runPool(range(25), 6, async function () {
      await tick(1);
    });
    expect(processed).toBe(25);
  });
});
