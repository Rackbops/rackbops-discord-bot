import { describe, expect, spyOn, test } from "bun:test";
import { REQUEST_DRAIN_MS, startRequestDrain, type RequestDrainOptions } from "./drain";

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
