import { describe, expect, spyOn, test } from "bun:test";
import { REQUEST_DRAIN_MS, REQUEST_DRAIN_TIMEOUT_MS, settledWithin, startRequestDrain, type RequestDrainOptions } from "./drain";

/** A drain whose timer the test turns by hand: `beat()` is one tick of the interval. */
function harness(over: Partial<RequestDrainOptions> = {}) {
  const state = { ready: true, restartPending: false, drains: 0, stops: 0, ms: undefined as number | undefined };
  const errors: unknown[][] = [];
  let beat: () => void = () => {
    throw new Error("the timer was never scheduled");
  };
  const stop = startRequestDrain({
    ready: () => state.ready,
    restartPending: () => state.restartPending,
    drain: async () => {
      state.drains += 1;
    },
    log: { error: (...args: unknown[]) => void errors.push(args) },
    schedule: (fn, ms) => {
      beat = fn;
      state.ms = ms;
      return () => {
        state.stops += 1;
      };
    },
    ...over,
  });
  // A beat starts the drain in a microtask-sized step; let it (and its `finally`) settle.
  const tick = async () => {
    beat();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { state, errors, stop, tick, beat: () => beat() };
}

describe("startRequestDrain", () => {
  test("does nothing until ready", async () => {
    const h = harness();
    h.state.ready = false;
    await h.tick();
    await h.tick();
    expect(h.state.drains).toBe(0);
    // Once the boot has landed, the next beat drains.
    h.state.ready = true;
    await h.tick();
    expect(h.state.drains).toBe(1);
  });

  test("does nothing while a restart is pending", async () => {
    const h = harness();
    h.state.restartPending = true;
    await h.tick();
    await h.tick();
    expect(h.state.drains).toBe(0);
    h.state.restartPending = false;
    await h.tick();
    expect(h.state.drains).toBe(1);
  });

  test("drains on each beat", async () => {
    const h = harness();
    await h.tick();
    await h.tick();
    await h.tick();
    expect(h.state.drains).toBe(3);
  });

  test("skips a beat while the previous drain is still running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const h = harness({
      drain: async () => {
        calls += 1;
        await gate;
      },
    });
    await h.tick();
    await h.tick();
    await h.tick();
    // One drain in flight; the beats behind it queued nothing.
    expect(calls).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Finished, so the next beat drains again.
    await h.tick();
    expect(calls).toBe(2);
  });

  test("a drain that rejects is logged and the next beat still drains", async () => {
    let calls = 0;
    const boom = new Error("Discord is down");
    const h = harness({
      drain: async () => {
        calls += 1;
        if (calls === 1) throw boom;
      },
    });
    await h.tick();
    expect(h.errors).toEqual([["[plugins] request-mailbox drain failed", boom]]);
    await h.tick();
    expect(calls).toBe(2);
    expect(h.errors).toHaveLength(1);
  });

  test("a drain that throws before it returns a promise is a failure like any other", async () => {
    let calls = 0;
    const h = harness({
      drain: () => {
        calls += 1;
        throw new Error("sync throw");
      },
    });
    await h.tick();
    await h.tick();
    expect(calls).toBe(2);
    expect(h.errors).toHaveLength(2);
  });

  // #508: a drain that never settles used to keep `running` set and its critical section held for good:
  // every later beat returned silently, and every restart -- a /plugins update's included -- waited on it.
  describe("one drain is waited on, and holds a restart, for at most timeoutMs (#508)", () => {
    /** A hold that records how many are open, like restart.ts's critical count. */
    const counting = () => {
      const held = { open: 0 };
      const hold = async (work: () => Promise<void>) => {
        held.open += 1;
        try {
          await work();
        } finally {
          held.open -= 1;
        }
      };
      return { held, hold };
    };
    const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    test("a drain that never settles is let go at the bound: logged, the hold released, and the next beat drains again", async () => {
      const { held, hold } = counting();
      let calls = 0;
      const h = harness({
        hold,
        timeoutMs: 20,
        drain: () => {
          calls += 1;
          return new Promise<void>(() => {}); // never settles
        },
      });
      await h.tick();
      expect(held.open).toBe(1); // held while it runs
      await h.tick();
      expect(calls).toBe(1); // a beat inside the bound still skips
      await settle(40);
      expect(held.open).toBe(0); // let go at the bound
      expect(h.errors).toEqual([
        ["[plugins] request-mailbox drain still running after 0s — no longer waited for (this beat lets go of its hold on a restart); the next beat tries again"],
      ]);
      await h.tick();
      expect(calls).toBe(2); // the next beat drains again
    });

    test("a drain that settles inside the bound releases the hold then, and logs nothing", async () => {
      const { held, hold } = counting();
      const h = harness({ hold, timeoutMs: 1_000 });
      await h.tick();
      expect(held.open).toBe(0);
      expect(h.state.drains).toBe(1);
      expect(h.errors).toEqual([]);
    });

    test("a drain that rejects inside the bound is logged as failed and releases the hold", async () => {
      const { held, hold } = counting();
      const boom = new Error("Discord is down");
      const h = harness({ hold, timeoutMs: 1_000, drain: async () => Promise.reject(boom) });
      await h.tick();
      expect(held.open).toBe(0);
      expect(h.errors).toEqual([["[plugins] request-mailbox drain failed", boom]]);
    });

    test("a drain that rejects after the bound is dropped, not an unhandled rejection or a second log line", async () => {
      let reject: (err: Error) => void = () => {};
      const h = harness({
        timeoutMs: 10,
        drain: () =>
          new Promise<void>((_resolve, rej) => {
            reject = rej;
          }),
      });
      await h.tick();
      await settle(30);
      expect(h.errors).toHaveLength(1); // the bound's own line
      reject(new Error("late"));
      await settle(10); // an unhandled rejection here would fail the test run
      expect(h.errors).toHaveLength(1);
    });

    test("a drain that settles in time leaves no bound timer pending behind it", async () => {
      const setSpy = spyOn(globalThis, "setTimeout");
      const clearSpy = spyOn(globalThis, "clearTimeout");
      try {
        const h = harness({ timeoutMs: 60_000 });
        await h.tick();
        const bound = setSpy.mock.results.find((_r, i) => setSpy.mock.calls[i]?.[1] === 60_000)?.value;
        expect(bound).toBeDefined();
        expect(clearSpy.mock.calls.some((call) => call[0] === bound)).toBe(true);
      } finally {
        setSpy.mockRestore();
        clearSpy.mockRestore();
      }
    });

    test("the default bound is REQUEST_DRAIN_TIMEOUT_MS, five minutes", async () => {
      expect(REQUEST_DRAIN_TIMEOUT_MS).toBe(300_000);
      const setSpy = spyOn(globalThis, "setTimeout");
      try {
        const h = harness();
        await h.tick();
        expect(setSpy.mock.calls.some((call) => call[1] === REQUEST_DRAIN_TIMEOUT_MS)).toBe(true);
      } finally {
        setSpy.mockRestore();
      }
    });
  });

  // The bound itself, which the tick's pluginRequests pass (announce.ts) uses too.
  describe("settledWithin (#508)", () => {
    test("settled in time is \"settled\"; still pending at the bound is \"timed-out\"", async () => {
      expect(await settledWithin(Promise.resolve(), 50)).toBe("settled");
      expect(await settledWithin(new Promise<void>(() => {}), 10)).toBe("timed-out");
    });

    test("a rejection inside the bound rejects; one after it is dropped, never unhandled", async () => {
      const boom = new Error("boom");
      await expect(settledWithin(Promise.reject(boom), 50)).rejects.toBe(boom);
      let reject: (err: Error) => void = () => {};
      const late = new Promise<void>((_resolve, rej) => {
        reject = rej;
      });
      expect(await settledWithin(late, 10)).toBe("timed-out");
      reject(new Error("late"));
      await new Promise((resolve) => setTimeout(resolve, 10)); // an unhandled rejection would fail the run
    });
  });

  test("stop stops it", () => {
    const h = harness();
    expect(h.state.stops).toBe(0);
    h.stop();
    expect(h.state.stops).toBe(1);
  });

  test("the default interval is REQUEST_DRAIN_MS, and intervalMs overrides it", () => {
    expect(REQUEST_DRAIN_MS).toBe(5_000);
    expect(harness().state.ms).toBe(REQUEST_DRAIN_MS);
    expect(harness({ intervalMs: 250 }).state.ms).toBe(250);
  });

  test("with no seam it schedules a real interval at REQUEST_DRAIN_MS, and stopping it clears that interval", async () => {
    // Through spies on setInterval / clearInterval, not a real timer: nothing here waits on a wall clock.
    const handle = { id: "the timer" } as unknown as ReturnType<typeof setInterval>;
    let beat: () => void = () => {
      throw new Error("no interval was scheduled");
    };
    let scheduledMs: number | undefined;
    const set = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
      beat = fn;
      scheduledMs = ms;
      return handle;
    }) as never);
    const cleared: unknown[] = [];
    const clear = spyOn(globalThis, "clearInterval").mockImplementation(((timer: unknown) => {
      cleared.push(timer);
    }) as never);
    try {
      let drains = 0;
      const stop = startRequestDrain({
        ready: () => true,
        restartPending: () => false,
        drain: async () => {
          drains += 1;
        },
        log: { error() {} },
      });
      expect(scheduledMs).toBe(REQUEST_DRAIN_MS);
      beat();
      await Promise.resolve();
      expect(drains).toBe(1);
      expect(cleared).toEqual([]);
      stop();
      expect(cleared).toEqual([handle]);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });
});
