import { describe, expect, test } from "bun:test";
import { createShutdownHandler, SHUTDOWN_GRACE_MS, type ShutdownDeps } from "./shutdown";

interface Harness {
  handler: (signal: string) => Promise<void>;
  logs: string[];
  errors: unknown[];
  exits: number[];
  beginShutdownCalls: string[];
  /** #184: each default dep pushes its own tag here when called, so a test can assert relative
   *  order (`["awaitIdle", "disposePlugins", "destroyClient", "exit"]`) without needing its own
   *  bespoke recording — an override that replaces a dep is responsible for its own push if it
   *  still wants to appear in this list. */
  order: string[];
}

/** Builds a handler with every dep faked and recorded, so a test only overrides what it's testing. */
function makeHarness(overrides: Partial<ShutdownDeps> = {}): Harness {
  const logs: string[] = [];
  const errors: unknown[] = [];
  const exits: number[] = [];
  const beginShutdownCalls: string[] = [];
  const order: string[] = [];
  const deps: ShutdownDeps = {
    beginShutdown: (reason) => beginShutdownCalls.push(reason),
    awaitIdle: async () => {
      order.push("awaitIdle");
      return true;
    },
    disposePlugins: async () => {
      order.push("disposePlugins");
    },
    destroyClient: () => {
      order.push("destroyClient");
    },
    exit: (code) => {
      order.push("exit");
      exits.push(code);
    },
    log: {
      log: (msg: string) => logs.push(msg),
      error: (msg: string, ...rest: unknown[]) => {
        errors.push(msg);
        if (rest.length) errors.push(...rest);
      },
    },
    graceMs: 8_000,
    ...overrides,
  };
  return { handler: createShutdownHandler(deps), logs, errors, exits, beginShutdownCalls, order };
}

describe("createShutdownHandler (#154)", () => {
  test("drains then exits 0, logging that it drained", async () => {
    const h = makeHarness({ awaitIdle: async () => true });
    await h.handler("SIGTERM");
    expect(h.beginShutdownCalls).toEqual(["SIGTERM"]);
    expect(h.exits).toEqual([0]);
    expect(h.logs.some((l) => l.includes("SIGTERM received"))).toBe(true);
    expect(h.logs.some((l) => l.includes("drained in"))).toBe(true);
    expect(h.errors.length).toBe(0);
  });

  // The mutation this guards: exiting BEFORE awaiting the drain at all.
  test("actually awaits the drain before exiting — exit does not happen until awaitIdle resolves", async () => {
    let idleResolve!: (v: boolean) => void;
    const idlePromise = new Promise<boolean>((r) => (idleResolve = r));
    const h = makeHarness({ awaitIdle: async () => idlePromise });
    const handlerPromise = h.handler("SIGTERM");
    await Bun.sleep(10);
    expect(h.exits).toEqual([]); // still draining — must not have exited yet
    idleResolve(true);
    await handlerPromise;
    expect(h.exits).toEqual([0]);
  });

  test("grace elapsed (awaitIdle resolves false) still exits 0, logging that work was still in flight", async () => {
    const h = makeHarness({ awaitIdle: async () => false });
    await h.handler("SIGTERM");
    expect(h.exits).toEqual([0]);
    expect(h.errors.some((e) => typeof e === "string" && e.includes("grace elapsed"))).toBe(true);
    expect(h.logs.some((l) => l.includes("drained in"))).toBe(false); // the success line must not also fire
  });

  test("a second signal while draining exits immediately, without a second beginShutdown/awaitIdle call", async () => {
    let idleCalls = 0;
    let idleResolve!: (v: boolean) => void;
    const idlePromise = new Promise<boolean>((r) => (idleResolve = r));
    const h = makeHarness({
      awaitIdle: async () => {
        idleCalls++;
        return idlePromise;
      },
    });
    const first = h.handler("SIGTERM"); // starts draining, does not resolve yet
    await Bun.sleep(10);
    // Bounded: if a regression made the second call fall through to a real (never-resolving, in
    // this test) second drain instead of exiting immediately, this must fail fast, not hang the
    // whole suite waiting on a promise nothing will ever resolve in that branch.
    const second = await Promise.race([
      h.handler("SIGINT").then(() => "returned" as const), // the second signal — same handler instance
      Bun.sleep(500).then(() => "timed-out" as const),
    ]);
    expect(second).toBe("returned");
    expect(h.exits).toEqual([0]); // the SECOND call exited immediately
    expect(idleCalls).toBe(1); // no second drain started
    expect(h.beginShutdownCalls).toEqual(["SIGTERM"]); // beginShutdown only ever called once
    idleResolve(true);
    await first; // let the first call finish too, so it doesn't leak into another test
    expect(h.exits).toEqual([0, 0]); // both calls exited — first after draining, second immediately
  });

  test("a destroyClient rejection is swallowed — the process still exits 0", async () => {
    const h = makeHarness({
      destroyClient: async () => {
        throw new Error("gateway already gone");
      },
    });
    await h.handler("SIGTERM");
    expect(h.exits).toEqual([0]);
    expect(h.errors.some((e) => typeof e === "string" && e.includes("destroyClient failed"))).toBe(true);
  });

  // destroyClient that never resolves must not hang the exit either — it's bounded internally,
  // separate from the drain's own graceMs.
  test("a destroyClient that never resolves does not hang the exit", async () => {
    const h = makeHarness({ destroyClient: () => new Promise<void>(() => {}) });
    const handlerPromise = h.handler("SIGTERM");
    // If destroyClient's internal bound didn't exist, this would never resolve and the test itself
    // would time out — bun's own per-test timeout is the backstop, but we want a fast, deterministic
    // signal instead: await with a generous-but-bounded race.
    const settled = await Promise.race([
      handlerPromise.then(() => "settled"),
      Bun.sleep(4_000).then(() => "hung"),
    ]);
    expect(settled).toBe("settled");
    expect(h.exits).toEqual([0]);
  });

  test("SHUTDOWN_GRACE_MS leaves real margin under docker stop's 10s SIGKILL bound", () => {
    expect(SHUTDOWN_GRACE_MS).toBe(8_000);
    expect(SHUTDOWN_GRACE_MS).toBeLessThan(10_000);
  });

  // #154 review finding: an earlier version gave destroyClient a FRESH DESTROY_CLIENT_TIMEOUT_MS
  // on top of the full drain budget — additive, not nested — so a drain that used the whole grace
  // budget plus a wedged destroyClient could total graceMs + DESTROY_CLIENT_TIMEOUT_MS, tying (not
  // beating) docker's 10s SIGKILL bound. destroyClient must be bounded to whatever's actually left
  // of graceMs once the drain returns.
  test("destroyClient is bounded to what's left of graceMs, not a fresh timeout stacked on top of it", async () => {
    const h = makeHarness({
      graceMs: 100,
      awaitIdle: async () => {
        await Bun.sleep(90); // consumes nearly the whole 100ms budget
        return true;
      },
      destroyClient: () => new Promise<void>(() => {}), // never resolves on its own
    });
    const startedAt = Date.now();
    const settled = await Promise.race([
      h.handler("SIGTERM").then(() => "settled" as const),
      // Comfortably above graceMs(100) + its own scheduling slop, comfortably below
      // graceMs + DESTROY_CLIENT_TIMEOUT_MS(2000) — separates "nested" from "additive".
      Bun.sleep(500).then(() => "hung" as const),
    ]);
    const elapsedMs = Date.now() - startedAt;
    expect(settled).toBe("settled");
    expect(elapsedMs).toBeLessThan(500);
    expect(h.exits).toEqual([0]);
  });

  // #184: the middle step — release what a plugin's activate() acquired before the gateway
  // connection it might still be relying on goes away.
  test("order: drain -> disposePlugins -> destroyClient -> exit", async () => {
    const h = makeHarness();
    await h.handler("SIGTERM");
    expect(h.order).toEqual(["awaitIdle", "disposePlugins", "destroyClient", "exit"]);
  });

  test("a disposePlugins rejection is swallowed — the process still exits 0", async () => {
    const h = makeHarness({
      disposePlugins: async () => {
        throw new Error("a plugin's dispose blew up");
      },
    });
    await h.handler("SIGTERM");
    expect(h.exits).toEqual([0]);
    expect(h.errors.some((e) => typeof e === "string" && e.includes("disposePlugins failed"))).toBe(true);
  });

  // disposePlugins that never resolves must not hang the exit either — bounded internally, same as
  // destroyClient.
  test("a disposePlugins that never resolves does not hang the exit", async () => {
    const h = makeHarness({ disposePlugins: () => new Promise<void>(() => {}) });
    const handlerPromise = h.handler("SIGTERM");
    const settled = await Promise.race([
      handlerPromise.then(() => "settled"),
      Bun.sleep(4_000).then(() => "hung"),
    ]);
    expect(settled).toBe("settled");
    expect(h.exits).toEqual([0]);
  });

  // #184 mirrors #154's own "nested, not additive" lesson for the new middle step: disposePlugins
  // must be bounded to what's left of graceMs after the drain, not get a fresh timeout of its own
  // stacked on top — and destroyClient after it must see what's left AFTER disposePlugins too, not
  // just after the drain.
  test("disposePlugins and destroyClient are both bounded to what's left of graceMs — all three phases together, not additive", async () => {
    const h = makeHarness({
      graceMs: 100,
      awaitIdle: async () => {
        await Bun.sleep(40); // spends less than half the 100ms budget
        return true;
      },
      disposePlugins: () => new Promise<void>(() => {}), // never resolves on its own
      destroyClient: () => new Promise<void>(() => {}), // never resolves on its own
    });
    const startedAt = Date.now();
    const settled = await Promise.race([
      h.handler("SIGTERM").then(() => "settled" as const),
      // Comfortably above graceMs(100) + scheduling slop, comfortably below what an ADDITIVE
      // implementation would take (100 + DISPOSE_PLUGINS_TIMEOUT_MS(3000) + DESTROY_CLIENT_TIMEOUT_MS(2000)).
      Bun.sleep(1_000).then(() => "hung" as const),
    ]);
    const elapsedMs = Date.now() - startedAt;
    expect(settled).toBe("settled");
    expect(elapsedMs).toBeLessThan(1_000);
    expect(h.exits).toEqual([0]);
  });

  // Isolates a narrower regression than the test above: disposePlugins's own remaining-budget
  // calculation must actually SUBTRACT the drain's elapsed time from graceMs, not hand it the full
  // graceMs regardless of how much the drain already used. The "all three phases" test above alone
  // doesn't catch dropping just this subtraction — disposePlugins never resolving on its own means
  // it always consumes exactly its bounded time either way, and both the correct (~60ms) and buggy
  // (~100ms) bounds land well under that test's own generous 1000ms threshold. This test forces the
  // difference to show by making the drain itself take real, measurable time.
  test("disposePlugins's remaining budget accounts for time spent in the drain, not the full graceMs", async () => {
    const h = makeHarness({
      graceMs: 100,
      awaitIdle: async () => {
        await Bun.sleep(90); // consumes nearly the whole 100ms budget
        return true;
      },
      disposePlugins: () => new Promise<void>(() => {}), // never resolves on its own
    });
    const startedAt = Date.now();
    const settled = await Promise.race([
      h.handler("SIGTERM").then(() => "settled" as const),
      // Correct: disposePlugins sees only ~10ms left (100 - 90) -> total ~100ms, well under this.
      // Buggy (full graceMs, ignoring the drain): disposePlugins would see the full 100ms ->
      // total ~90 + 100 = 190ms, past this bound.
      Bun.sleep(150).then(() => "hung" as const),
    ]);
    expect(settled).toBe("settled");
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(150);
    expect(h.exits).toEqual([0]);
  });

  // Isolates a narrower regression than the test above: destroyClient's own remaining-budget
  // calculation must measure elapsed time from the SIGNAL (drain + disposePlugins together), not
  // just from the drain — using the drain-only elapsed figure would let destroyClient believe it
  // has more of the budget left than it actually does whenever disposePlugins itself took real
  // time (as opposed to being bounded away by its own timeout, which the test above exercises).
  test("destroyClient's remaining budget accounts for time spent in disposePlugins, not just the drain", async () => {
    const h = makeHarness({
      graceMs: 100,
      awaitIdle: async () => true, // resolves instantly — ~0ms spent draining
      disposePlugins: async () => {
        await Bun.sleep(80); // spends most of the 100ms budget, but resolves ON ITS OWN (not via its own timeout)
      },
      destroyClient: () => new Promise<void>(() => {}), // never resolves on its own
    });
    const startedAt = Date.now();
    const settled = await Promise.race([
      h.handler("SIGTERM").then(() => "settled" as const),
      // Correct: destroyClient sees only ~20ms left (100 - 80) -> total ~100ms, well under this.
      // Buggy (drain-only elapsed): destroyClient would see the full 100ms still available since
      // the drain itself took ~0ms -> total ~80 + 100 = 180ms, past this bound.
      Bun.sleep(140).then(() => "hung" as const),
    ]);
    expect(settled).toBe("settled");
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(140);
    expect(h.exits).toEqual([0]);
  });
});
