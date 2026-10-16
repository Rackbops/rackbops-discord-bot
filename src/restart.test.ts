import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  RESTART_DEFERRAL_MAX_MS,
  RESTART_EXIT_CODE,
  awaitCriticalIdle,
  beginCritical,
  beginHandoff,
  beginShutdown,
  endCritical,
  endHandoff,
  handoffActive,
  isShuttingDown,
  onBeforeExit,
  onStopRequested,
  requestRestart,
  resetForTest,
  restartPending,
  restartRequested,
  runExitHooks,
  setExitFn,
  stateForTest,
  withCritical,
} from "./restart";

let exits: number[] = [];
let restore: () => void;

beforeEach(() => {
  resetForTest();
  exits = [];
  restore?.();
  restore = setExitFn((code) => exits.push(code));
});

// Bun runs every test file in one process with one module registry (test/setup.ts), so restart.ts's
// module state outlives this file. Several tests here end mid-handoff, and when one of them ran last
// `handoffActive()` stayed true for every later file until something reset it — update.test.ts's
// checkForUpdate then refused with `busy` before doing anything. Reset on the way out, as
// redeploy.test.ts and plugins/host.test.ts do.
afterEach(() => {
  resetForTest();
});

describe("requestRestart", () => {
  // README.md (the supervisor section) and .env.example publish 75 as the contract a supervisor keys on.
  // Every exit assertion in this file compares to the imported constant, so only this pins the number (#512).
  test("the exit code the supervisor contract publishes is 75", () => {
    expect(RESTART_EXIT_CODE).toBe(75);
  });

  test("exits immediately when idle", () => {
    requestRestart("test");
    expect(exits).toEqual([RESTART_EXIT_CODE]);
  });

  test("defers while a critical section is open, then exits once it closes", () => {
    beginCritical();
    requestRestart("test");
    expect(exits).toEqual([]);
    expect(restartPending()).toBe(true);
    endCritical();
    expect(exits).toEqual([RESTART_EXIT_CODE]);
  });

  test("waits for nested critical sections to fully unwind", () => {
    beginCritical();
    beginCritical();
    requestRestart("test");
    endCritical();
    expect(exits).toEqual([]);
    endCritical();
    expect(exits).toEqual([RESTART_EXIT_CODE]);
  });

  test("exits exactly once when requested repeatedly", () => {
    beginCritical();
    requestRestart("first");
    requestRestart("second");
    endCritical();
    expect(exits).toEqual([RESTART_EXIT_CODE]);
  });

  test("does not exit when a critical section opens and closes with none pending", () => {
    beginCritical();
    endCritical();
    expect(exits).toEqual([]);
    expect(restartPending()).toBe(false);
  });

  // The observable the `Math.max(0, ...)` clamp in endCritical protects: without it the unmatched close
  // leaves the depth at -1, the next section only brings it back to 0, and a restart requested inside that
  // section would exit at once instead of waiting for it (#512).
  test("an unmatched endCritical never drives the depth negative", () => {
    endCritical();
    expect(stateForTest().critical).toBe(0);
    beginCritical();
    requestRestart("test");
    expect(exits).toEqual([]);
    endCritical();
    expect(exits).toEqual([RESTART_EXIT_CODE]);
  });
});

// #512: a deferred restart stops every new tick and mailbox drain (restartPending), so it must not wait
// forever on a critical section that never closes. These use a deadline of a few ms (requestRestart's second
// argument) and real timers, since the point is that a timer fires and does the exit.
describe("a deferred restart's deadline (#512)", () => {
  test("a deferred restart exits anyway once the deadline passes, and says so", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      beginCritical();
      requestRestart("test", 20);
      expect(exits).toEqual([]);
      expect(stateForTest().deferralArmed).toBe(true);
      await Bun.sleep(60);
      expect(exits).toEqual([RESTART_EXIT_CODE]);
      expect(stateForTest().deferralArmed).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const line = String(errorSpy.mock.calls[0]![0]);
      expect(line).toContain("did not finish within 20ms");
      expect(line).toContain("critical depth 1");
      // the exit carries the reason the restart was requested with
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("exiting (75): test"))).toBe(true);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("a section that closes in time exits once and disarms the deadline", async () => {
    beginCritical();
    requestRestart("test", 20);
    endCritical();
    expect(exits).toEqual([RESTART_EXIT_CODE]);
    expect(stateForTest().deferralArmed).toBe(false);
    await Bun.sleep(60);
    expect(exits).toEqual([RESTART_EXIT_CODE]); // the timer was cleared, not left to fire a second exit
  });

  test("the default deadline is the reviewed value, and is what the timer is armed with", () => {
    expect(RESTART_DEFERRAL_MAX_MS).toBe(30 * 60_000);
    const timerSpy = spyOn(globalThis, "setTimeout");
    try {
      beginCritical();
      requestRestart("test");
      const delays = (timerSpy.mock.calls as unknown[][]).map((c) => c[1]);
      expect(delays).toContain(RESTART_DEFERRAL_MAX_MS);
    } finally {
      timerSpy.mockRestore();
    }
    // the file's afterEach (resetForTest) disarms the half-hour timer this left
  });

  test("the deadline elapsing under an active handoff does not exit; it waits, and fires once the handoff has ended", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      beginCritical();
      beginHandoff("redeploy");
      requestRestart("test", 20);
      await Bun.sleep(60);
      expect(exits).toEqual([]); // the original must stay alive through a swap
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("a handoff is active"))).toBe(true);
      expect(stateForTest().deferralArmed).toBe(true); // renewed, not dropped
      endHandoff();
      await Bun.sleep(60);
      expect(exits).toEqual([RESTART_EXIT_CODE]);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("a shutdown in progress owns the exit: a pending restart's section closing releases the drain instead of exiting", async () => {
    beginCritical();
    requestRestart("test");
    beginShutdown("SIGTERM");
    const idle = awaitCriticalIdle(1000);
    endCritical();
    expect(exits).toEqual([]); // not 75: the handler goes on to dispose the plugins, close the gateway and exit 0
    expect(await idle).toBe(true);
  });

  // The reachable ordering: the SIGTERM handler has begun the shutdown and a tick, inside its section, then
  // asks for a restart (the case with nothing open cannot happen: every caller holds a section).
  test("a restart requested after a shutdown began, with a section open, arms no deadline and exits nothing", async () => {
    beginCritical();
    beginShutdown("SIGTERM");
    requestRestart("test", 20);
    expect(stateForTest().pending).toBe("test");
    expect(stateForTest().deferralArmed).toBe(false);
    await Bun.sleep(60);
    expect(exits).toEqual([]);
    endCritical();
    expect(exits).toEqual([]);
  });

  test("a shutdown that begins while a deferral is armed disarms it", async () => {
    beginCritical();
    requestRestart("test", 20);
    expect(stateForTest().deferralArmed).toBe(true);
    beginShutdown("SIGTERM");
    expect(stateForTest().deferralArmed).toBe(false);
    await Bun.sleep(60);
    expect(exits).toEqual([]);
  });

  test("resetForTest disarms a deferral", async () => {
    beginCritical();
    requestRestart("test", 20);
    resetForTest();
    await Bun.sleep(60);
    expect(exits).toEqual([]);
  });
});

// #419: the boot report-back waits only for an EXIT that is requested -- a handoff alone can still fail and
// leave this process running, owing the report.
describe("restartRequested (#419)", () => {
  test("false when nothing is in flight", () => {
    expect(restartRequested()).toBe(false);
  });

  test("false during a handoff alone, while restartPending() is true", () => {
    beginHandoff("redeploy");
    expect(restartPending()).toBe(true);
    expect(restartRequested()).toBe(false);
  });

  test("true for a restart deferred by a critical section", () => {
    beginCritical();
    requestRestart("test");
    expect(restartRequested()).toBe(true);
    expect(exits).toEqual([]);
  });

  test("true for a restart requested while a handoff is active too", () => {
    beginCritical();
    beginHandoff("redeploy");
    requestRestart("test");
    expect(restartRequested()).toBe(true);
    expect(exits).toEqual([]);
  });

  test("true once a shutdown has begun", () => {
    beginShutdown("SIGTERM");
    expect(restartRequested()).toBe(true);
  });
});

// nazumods/wow#879: the outgoing bot has to stay alive through a handoff — it is the only thing that can
// remove a replacement which fails to verify, and the only thing that can report the failure.
describe("beginHandoff", () => {
  test("quiesces the scheduler without exiting", () => {
    beginHandoff("redeploy");
    expect(restartPending()).toBe(true);
    expect(handoffActive()).toBe(true);
    expect(exits).toEqual([]);
  });

  test("resuming lets normal work start again", () => {
    beginHandoff("redeploy");
    endHandoff();
    expect(restartPending()).toBe(false);
    expect(handoffActive()).toBe(false);
    expect(exits).toEqual([]);
  });

  test("resuming when no handoff is in flight is a no-op", () => {
    endHandoff();
    expect(restartPending()).toBe(false);
    expect(exits).toEqual([]);
  });

  // A handoff must not mask a genuine exit path, nor be masked by one.
  test("a restart requested during a handoff still exits", () => {
    beginHandoff("redeploy");
    requestRestart("test");
    expect(exits).toEqual([RESTART_EXIT_CODE]);
  });

  test("resuming does not clear a restart that is genuinely pending", () => {
    beginCritical();
    beginHandoff("redeploy");
    requestRestart("test");
    endHandoff();
    expect(restartPending()).toBe(true);
    expect(exits).toEqual([]);
    endCritical();
    expect(exits).toEqual([RESTART_EXIT_CODE]);
  });
});

describe("withCritical", () => {
  test("defers a restart requested from inside", async () => {
    const seen: number[] = [];
    await withCritical(async () => {
      requestRestart("test");
      seen.push(...exits);
    });
    expect(seen).toEqual([]);
    expect(exits).toEqual([RESTART_EXIT_CODE]);
  });

  test("still releases the section when the body throws", async () => {
    await expect(
      withCritical(async () => {
        requestRestart("test");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(exits).toEqual([RESTART_EXIT_CODE]);
  });
});

// #154: the re-entrancy problem a plain "wait for critical === 0" would hit — redeploy() on the
// auto-update path runs INSIDE the very tick's withCritical section that would be waiting on
// itself. The fix is a LIVE exemption (handoffExemption(), private to restart.ts): while a
// handoff is active, exactly 1 unit of critical depth — the handoff's own, structurally-can-
// never-close-itself holder — is exempted, recomputed on every check rather than snapshotted once
// at beginHandoff() time. See restart.ts's own handoffExemption() docstring for why a frozen
// snapshot (an earlier version of this fix, reverted after review) is wrong.
describe("awaitCriticalIdle (the live handoff exemption, #154)", () => {
  test("resolves immediately when critical is exactly the exemption — the auto-update case (exemption 1, critical 1)", async () => {
    beginCritical(); // the tick's own withCritical, already open when the handoff begins
    beginHandoff("redeploy");
    const idle = await awaitCriticalIdle(50);
    expect(idle).toBe(true);
    endCritical();
  });

  test("resolves immediately with no handoff at all — exemption 0, nothing open", async () => {
    const idle = await awaitCriticalIdle(50);
    expect(idle).toBe(true);
  });

  // A straight "compare to 0" (the mutation) would make this test hang/timeout instead of
  // resolving true at the exemption — this is the row the plan calls out explicitly.
  test("a straight compare-to-zero would wrongly wait here — mutation guard", async () => {
    beginCritical();
    beginHandoff("redeploy");
    const idlePromise = awaitCriticalIdle(1000);
    // Resolves well under the 1000ms bound because it's comparing to the exemption (1), not 0.
    const idle = await idlePromise;
    expect(idle).toBe(true);
    endCritical();
  });

  // The scenario review Finding 1 was about: an interaction's own critical section (the handoff's
  // holder) plus a genuinely UNRELATED, concurrently-open scheduler tick, BOTH open at the instant
  // beginHandoff() runs. A frozen baseline snapshot (critical=2 at that instant) would wrongly
  // treat the whole thing as already idle and resolve immediately — the exact bug #154 exists to
  // fix. The live exemption (always 1) must keep waiting until the unrelated tick's own section
  // closes.
  test("an interaction handoff plus a concurrently-open unrelated tick both open at handoff time — waits for the tick to close, not just the handoff holder", async () => {
    beginCritical(); // the unrelated tick — e.g. mid-persist elsewhere, nothing to do with the handoff
    beginCritical(); // the interaction's own section — becomes the handoff's holder
    beginHandoff("redeploy"); // critical is 2 here; exemption is only ever 1
    let resolved = false;
    const idlePromise = awaitCriticalIdle(1000).then((v) => {
      resolved = true;
      return v;
    });
    await Bun.sleep(10);
    expect(resolved).toBe(false); // the unrelated tick's section is still open — must still be waiting
    endCritical(); // the unrelated tick closes — critical drops to 1, matching the exemption
    expect(await idlePromise).toBe(true);
    endCritical(); // clean up the handoff holder's own section
  });

  // A section that opens AFTER the handoff began — the 5-min watchdog releasing tickInFlight
  // mid-window, or a plugin tick — is exactly as unrelated to the handoff's own holder as one that
  // was already open before it. `beginHandoff()` is only ever called from inside exactly one
  // `withCritical`: the one call site in `redeploy()`, reached via `checkForUpdate` under the
  // `withCritical` of `announce.ts`'s `onTick` (which wraps the whole tick) and of `commands.ts`'s
  // `/update` handler. So critical is always >= 1 — never 0 — at that instant;
  // this test opens that holder section first, matching the real invariant.
  test("waits for a critical section opened AFTER the handoff began, then resolves true", async () => {
    beginCritical(); // the handoff's own holder — open before beginHandoff, as it always is in production
    beginHandoff("redeploy"); // critical=1, exemption=1
    beginCritical(); // a genuinely new, unrelated section opening after the handoff began
    let resolved = false;
    const idlePromise = awaitCriticalIdle(1000).then((v) => {
      resolved = true;
      return v;
    });
    await Bun.sleep(10);
    expect(resolved).toBe(false); // critical=2 still above the exemption(1) — must not have resolved yet
    endCritical(); // the unrelated section closes — critical drops back to 1, matching the exemption
    expect(await idlePromise).toBe(true);
    endCritical(); // clean up the handoff holder's own section
  });

  // Guards maybeResolveIdle()'s own condition, not just handoffExemption() — a resolver that fires
  // on ANY endCritical() call, rather than checking critical against the exemption each time,
  // would wrongly resolve as soon as the FIRST of two unrelated sections closes even though the
  // second is still holding a state write open.
  test("with two unrelated sections open alongside the holder, resolves only once BOTH have closed", async () => {
    beginCritical(); // the handoff's own holder
    beginHandoff("redeploy"); // critical=1, exemption=1
    beginCritical(); // unrelated section A
    beginCritical(); // unrelated section B
    let resolved = false;
    const idlePromise = awaitCriticalIdle(1000).then((v) => {
      resolved = true;
      return v;
    });
    await Bun.sleep(10);
    expect(resolved).toBe(false); // critical=3, still above the exemption(1)
    endCritical(); // A closes — critical=2, still above the exemption(1)
    await Bun.sleep(10);
    expect(resolved).toBe(false); // must NOT have resolved after only one of the two closed
    endCritical(); // B closes — critical=1, matches the exemption
    expect(await idlePromise).toBe(true);
    endCritical(); // clean up the holder
  });

  test("resolves false once the timeout elapses with critical still above the exemption", async () => {
    beginCritical(); // the handoff's own holder
    beginHandoff("redeploy"); // critical=1, exemption=1
    beginCritical(); // an unrelated section that never closes within the timeout
    const idle = await awaitCriticalIdle(20);
    expect(idle).toBe(false);
    expect(stateForTest().idleWaiters).toBe(0); // the timed-out wait took its resolver with it (#512)
    endCritical(); // clean up — nothing left listening after the timeout fired
    endCritical();
  });

  test("exemption drops to 0 at endHandoff — a later shutdown with no active handoff waits for full idle", async () => {
    beginCritical();
    beginHandoff("redeploy");
    endHandoff(); // exemption is live, so it's immediately back to 0
    // Now simulate an unrelated later shutdown: critical is still 1 (never closed), exemption is 0.
    const idlePromise = awaitCriticalIdle(1000);
    let resolved = false;
    idlePromise.then(() => (resolved = true));
    await Bun.sleep(10);
    expect(resolved).toBe(false); // must wait for FULL idle now, exemption is back to 0
    endCritical();
    expect(await idlePromise).toBe(true);
  });
});

describe("beginShutdown (#154)", () => {
  test("makes restartPending() true, the same as a handoff or a pending restart", () => {
    expect(restartPending()).toBe(false);
    beginShutdown("SIGTERM");
    expect(restartPending()).toBe(true);
  });

  // #548: a replacement's probation stops completing when IT is being stopped, but keeps completing while a
  // pending restart or a handoff of its own is in flight, so isShuttingDown is narrower than restartPending.
  test("isShuttingDown is true after beginShutdown only: not for a pending restart or an in-flight handoff", () => {
    expect(isShuttingDown()).toBe(false);
    beginHandoff("redeploy");
    expect(restartPending()).toBe(true);
    expect(isShuttingDown()).toBe(false);
    endHandoff();
    beginCritical();
    requestRestart("update");
    expect(isShuttingDown()).toBe(false);
    beginShutdown("SIGTERM");
    expect(isShuttingDown()).toBe(true);
  });
});

// The test-state guard (test/stateGuard.ts) decides from this snapshot alone, so each field must
// track the live module state — a field stuck at its clean value would hide that kind of leak from
// the guard. The file's afterEach resets everything before the guard looks.
describe("stateForTest (what the test-state guard reads)", () => {
  test("reads clean after a reset", () => {
    expect(stateForTest()).toEqual({
      critical: 0,
      pending: undefined,
      handoff: undefined,
      shuttingDown: false,
      idleWaiters: 0,
      stopListeners: 0,
      stopNotified: false,
      deferralArmed: false,
      exitHooks: 0,
    });
  });

  test("critical tracks the open sections", () => {
    beginCritical();
    beginCritical();
    expect(stateForTest().critical).toBe(2);
  });

  test("pending holds a deferred restart's reason", () => {
    beginCritical();
    requestRestart("update");
    expect(stateForTest().pending).toBe("update");
  });

  test("handoff holds the active handoff's reason", () => {
    beginHandoff("redeploy");
    expect(stateForTest().handoff).toBe("redeploy");
  });

  test("a shutdown sets shuttingDown and stopNotified", () => {
    beginShutdown("SIGTERM");
    expect(stateForTest().shuttingDown).toBe(true);
    expect(stateForTest().stopNotified).toBe(true);
  });

  test("idleWaiters counts awaitCriticalIdle calls still waiting", async () => {
    beginCritical();
    const idle = awaitCriticalIdle(1000);
    expect(stateForTest().idleWaiters).toBe(1);
    endCritical();
    expect(await idle).toBe(true);
    expect(stateForTest().idleWaiters).toBe(0);
  });

  test("stopListeners counts registered listeners", () => {
    const off = onStopRequested(() => {});
    expect(stateForTest().stopListeners).toBe(1);
    off();
    expect(stateForTest().stopListeners).toBe(0);
  });
});

// #446: a log line that the exit would otherwise lose (the interaction line of the command that asked for
// it) is written by a hook that runs right before the process exits -- `doExit` for a requested restart,
// `runExitHooks` for the shutdown handler's exit (index.ts wires it in).
describe("onBeforeExit (#446)", () => {
  test("a requested restart runs the hooks, in registration order, before the exit function", () => {
    const order: string[] = [];
    restore();
    restore = setExitFn((code) => {
      order.push("exit");
      exits.push(code);
    });
    onBeforeExit(() => order.push("a"));
    onBeforeExit(() => order.push("b"));
    requestRestart("t");
    expect(order).toEqual(["a", "b", "exit"]);
    expect(exits).toEqual([RESTART_EXIT_CODE]);
  });

  test("a deferred restart runs the hooks when the section closes, once", () => {
    const hook = mock(() => {});
    beginCritical();
    onBeforeExit(hook);
    requestRestart("t");
    expect(hook).not.toHaveBeenCalled();
    endCritical();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([RESTART_EXIT_CODE]);
    expect(stateForTest().exitHooks).toBe(0);
  });

  test("runExitHooks runs and empties the list; beginShutdown does not run them", () => {
    const hook = mock(() => {});
    onBeforeExit(hook);
    beginShutdown("SIGTERM");
    expect(hook).not.toHaveBeenCalled();
    expect(stateForTest().exitHooks).toBe(1);
    runExitHooks();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(stateForTest().exitHooks).toBe(0);
    runExitHooks();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  test("a throwing hook is isolated: the others run and the exit still happens", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const seen: string[] = [];
      onBeforeExit(() => {
        throw new Error("boom");
      });
      onBeforeExit(() => seen.push("second"));
      requestRestart("t");
      expect(seen).toEqual(["second"]);
      expect(exits).toEqual([RESTART_EXIT_CODE]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain("an exit hook threw");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("an unsubscribed hook is not run", () => {
    const hook = mock(() => {});
    const off = onBeforeExit(hook);
    off();
    expect(stateForTest().exitHooks).toBe(0);
    requestRestart("t");
    expect(hook).not.toHaveBeenCalled();
  });

  test("unsubscribing one hook leaves the others registered", () => {
    const a = mock(() => {});
    const b = mock(() => {});
    const offA = onBeforeExit(a);
    onBeforeExit(b);
    offA();
    expect(stateForTest().exitHooks).toBe(1);
    runExitHooks();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  test("resetForTest clears the hooks, and stateForTest counts them", () => {
    onBeforeExit(() => {});
    onBeforeExit(() => {});
    expect(stateForTest().exitHooks).toBe(2);
    resetForTest();
    expect(stateForTest().exitHooks).toBe(0);
  });

  test("a hook registered after beginShutdown still runs at the exit (an interaction that arrives in the drain)", () => {
    const hook = mock(() => {});
    beginShutdown("SIGTERM");
    onBeforeExit(hook);
    runExitHooks();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  test("a hook that unsubscribes itself, or a later one, while the hooks run does not change who runs", () => {
    const seen: string[] = [];
    let offB: () => void = () => {};
    onBeforeExit(() => {
      seen.push("a");
      offB();
    });
    offB = onBeforeExit(() => seen.push("b"));
    runExitHooks();
    expect(seen).toEqual(["a", "b"]);
  });

  test("the deadline exit of a stuck section runs the hooks too (#512)", async () => {
    const hook = mock(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      beginCritical();
      onBeforeExit(hook);
      requestRestart("t", 20);
      expect(hook).not.toHaveBeenCalled();
      await Bun.sleep(60);
      expect(hook).toHaveBeenCalledTimes(1);
      expect(exits).toEqual([RESTART_EXIT_CODE]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("onStopRequested (#248)", () => {
  test("runs once, before requestRestart decides to exit, with the reason", () => {
    const seen: string[] = [];
    onStopRequested((reason) => seen.push(`${reason} exits=${exits.length}`));
    requestRestart("update");
    requestRestart("again");
    expect(seen).toEqual(["update exits=0"]);
    expect(exits).toEqual([RESTART_EXIT_CODE]);
  });

  test("a shutdown notifies too, and a later restart request does not notify again", () => {
    const seen: string[] = [];
    onStopRequested((reason) => seen.push(reason));
    beginShutdown("SIGTERM");
    requestRestart("update");
    expect(seen).toEqual(["SIGTERM"]);
    expect(exits).toEqual([]); // the shutdown owns the exit (#512): the restart is only recorded as pending
  });

  test("a throwing listener is isolated: the others run and the restart still lands", () => {
    const seen: string[] = [];
    const errorSpy = console.error;
    console.error = () => {};
    try {
      onStopRequested(() => {
        throw new Error("boom");
      });
      onStopRequested((reason) => seen.push(reason));
      requestRestart("update");
    } finally {
      console.error = errorSpy;
    }
    expect(seen).toEqual(["update"]);
    expect(exits).toEqual([RESTART_EXIT_CODE]);
  });

  test("an unsubscribed listener is not called", () => {
    const seen: string[] = [];
    const off = onStopRequested((reason) => seen.push(reason));
    off();
    requestRestart("update");
    expect(seen).toEqual([]);
  });
});
