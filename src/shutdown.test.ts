import { describe, expect, test } from "bun:test";
import { createShutdownHandler, SHUTDOWN_GRACE_MS, type ShutdownDeps } from "./shutdown";

interface Harness {
  handler: (signal: string) => Promise<void>;
  logs: string[];
  errors: unknown[];
  exits: number[];
  beginShutdownCalls: string[];
}

/** Builds a handler with every dep faked and recorded, so a test only overrides what it's testing. */
function makeHarness(overrides: Partial<ShutdownDeps> = {}): Harness {
  const logs: string[] = [];
  const errors: unknown[] = [];
  const exits: number[] = [];
  const beginShutdownCalls: string[] = [];
  const deps: ShutdownDeps = {
    beginShutdown: (reason) => beginShutdownCalls.push(reason),
    awaitIdle: async () => true,
    destroyClient: () => {},
    exit: (code) => exits.push(code),
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
  return { handler: createShutdownHandler(deps), logs, errors, exits, beginShutdownCalls };
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
});
