import { beforeEach, describe, expect, test } from "bun:test";
import {
  RESTART_EXIT_CODE,
  awaitCriticalIdle,
  beginCritical,
  beginHandoff,
  beginShutdown,
  endCritical,
  endHandoff,
  handoffActive,
  requestRestart,
  resetForTest,
  restartPending,
  setExitFn,
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

describe("requestRestart", () => {
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
  // withCritical (redeploy.ts:256, reached via checkForUpdate under withCritical in both
  // announce.ts:225 and commands.ts:124), so critical is always >= 1 — never 0 — at that instant;
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
});
