// Graceful restart: the process exits, and the orchestrator respawns it.
//
// This is the FALLBACK update path. update.ts's applyUpdate() tries redeploy.ts's docker-socket
// redeploy first (it builds and hands off to the replacement in place, no exit involved) and only
// falls back to this exit when the socket isn't reachable — see update.ts:324. A clean exit here
// only picks up new code if whatever supervises the container supplies a rebuilt image. See README.
//
// A restart requested while an announcement or a state write is in flight is
// deferred until the critical section unwinds, so `data/state.json` is never
// truncated mid-write and no announcement is half-posted. Since #154 the same is true of an
// EXTERNAL stop, not just a self-requested restart: `shutdown.ts`'s `SIGTERM`/`SIGINT` handler
// awaits the same critical section (bounded by `SHUTDOWN_GRACE_MS`, kept meaningfully under
// `docker stop`'s own SIGKILL timeout) before letting the process exit — see `awaitCriticalIdle`
// and `handoffExemption` below for how a handoff's own holder avoids waiting on itself.
//
// A plugin tick holds its own unit of the critical section for as long as its call is pending, even
// past PLUGIN_TICK_TIMEOUT_MS (plugins/host.ts, #248). A restart request or a shutdown notifies the
// `onStopRequested` listeners below; the plugin host's listener aborts every pending tick's
// AbortSignal and lets go of each hold once the tick settles or PLUGIN_TICK_ABORT_GRACE_MS elapses —
// so a cooperating tick is never cut off mid-write, and one that ignores its signal delays a restart
// by that grace at most, never forever (the #217 trade-off this replaces).

/** Distinct from a crash, so a supervisor can tell an update apart from a failure. */
export const RESTART_EXIT_CODE = 75;

type ExitFn = (code: number) => void;

let critical = 0;
let pending: string | undefined;
let handoff: string | undefined;
let exitFn: ExitFn = (code) => process.exit(code);

// #154: true once a shutdown signal has been received. Folded into restartPending() so no NEW
// scheduler tick (or anything else gated on it) starts once one arrives — distinct from `pending`
// (a graceful self-restart) and `handoff` (this process expects to be retired by a replacement):
// a shutdown means something EXTERNAL wants this process gone, right now, bounded by its own grace
// period rather than "whenever the next critical section closes."
let shuttingDown = false;
// Resolvers waiting on awaitCriticalIdle, drained by maybeResolveIdle() below.
let idleResolvers: (() => void)[] = [];
// #248: called once, the first time the process is asked to stop (see onStopRequested).
let stopListeners: ((reason: string) => void)[] = [];
let stopNotified = false;

/**
 * #154: how much of `critical`'s current depth is the handoff's own, permanently-open holder —
 * always exactly 1 while a handoff is active, 0 otherwise. NOT a snapshot of `critical` taken at
 * `beginHandoff()` time (an earlier version of this file did that, and it was wrong — see below);
 * this is recomputed live on every check.
 *
 * By construction, `redeploy()` is always invoked from inside exactly one `withCritical` (never
 * nested — `commands.ts`'s interaction handlers and `announce.ts`'s tick each open just one), and
 * on a SUCCESSFUL handoff `redeploy()` never returns at all — the replacement kills this process
 * mid-await (see `redeploy()`'s own docstring). So that one specific unit of depth can never close
 * on its own while a handoff is in progress, and exempting a live, constant 1 — never a frozen
 * count of "whatever else happened to be open at the same instant" — is what correctly keeps
 * waiting for anything ELSE that's open, no matter when it opened relative to the handoff.
 *
 * A frozen snapshot (`handoffBaseline = critical` at `beginHandoff` time) gets this wrong twice
 * over, found in review: (1) if a genuinely unrelated critical section — a scheduler tick mid-
 * `persist`, the issue's own failure sequence — happens to ALSO be open at that exact instant, a
 * snapshot bakes its depth into the baseline too, so the drain reports "idle" immediately even
 * though that tick's write is still in flight; (2) even later, if a DIFFERENT, unrelated section
 * opens (a later tick, the 5-min watchdog letting a second one in) and coincidentally brings
 * `critical` back down to the same frozen number, the drain again wrongly treats it as already
 * accounted for. A live "exempt exactly 1 while a handoff is active" has no such window: it always
 * exempts precisely the one thing that structurally can never close, and genuinely waits for
 * everything else, however many things open and close and in whatever order.
 *
 * Known, accepted gap (found in review, not a #154 regression): the exemption only tracks
 * whether a handoff is active, not whether `redeploy()`'s OWN work is done — so if some
 * unrelated critical section is what's keeping `critical` above the exemption when a SIGTERM
 * arrives, `awaitCriticalIdle` can resolve as soon as THAT section closes, even while `redeploy()`
 * itself is still mid-flight (e.g. still awaiting `createContainer`/`startContainer`). The
 * shutdown handler then exits, abruptly killing the in-flight redeploy. This is not new: before
 * #154 there was no signal handler at all, so any external SIGTERM already killed the process
 * mid-redeploy unconditionally. #154's scope is state-write/announcement safety, not making a
 * mid-redeploy SIGTERM itself safe — an orphaned replacement from this path is cleaned up the
 * same way any other failed redeploy's leftover is, by the next redeploy's own removal step.
 */
function handoffExemption(): number {
  return handoff !== undefined ? 1 : 0;
}

function maybeResolveIdle(): void {
  if (critical <= handoffExemption() && idleResolvers.length > 0) {
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

/** Swap the exit for tests. Returns a restore fn. */
export function setExitFn(fn: ExitFn): () => void {
  const prev = exitFn;
  exitFn = fn;
  return () => {
    exitFn = prev;
  };
}

/** Reset module state between tests. */
export function resetForTest(): void {
  critical = 0;
  pending = undefined;
  handoff = undefined;
  shuttingDown = false;
  idleResolvers = [];
  stopListeners = [];
  stopNotified = false;
}

/**
 * #248: registers `fn` to run once, the first time this process is asked to stop — a restart request
 * (`requestRestart`) or a shutdown (`beginShutdown`), whichever comes first. The plugin host uses it
 * to abort in-flight plugin ticks, so a stop waits for them to bail rather than for them to finish.
 * A listener runs synchronously, before `requestRestart` decides whether to exit now or defer; one
 * that throws is logged and never stops the others or the stop itself. Returns an unsubscribe.
 */
export function onStopRequested(fn: (reason: string) => void): () => void {
  stopListeners.push(fn);
  return () => {
    stopListeners = stopListeners.filter((l) => l !== fn);
  };
}

function notifyStop(reason: string): void {
  if (stopNotified) return;
  stopNotified = true;
  for (const listener of stopListeners) {
    try {
      listener(reason);
    } catch (err) {
      console.error("[restart] a stop listener threw (continuing)", err);
    }
  }
}

export function beginCritical(): void {
  critical += 1;
}

export function endCritical(): void {
  critical = Math.max(0, critical - 1);
  if (critical === 0 && pending !== undefined) doExit(pending);
  // #154: release everyone waiting on awaitCriticalIdle once we're back at (or below) the live
  // exemption — not just at 0, so a handoff's own holder never blocks itself (see
  // handoffExemption above).
  maybeResolveIdle();
}

/** Run `fn` with restarts deferred until it settles. */
export async function withCritical<T>(fn: () => Promise<T>): Promise<T> {
  beginCritical();
  try {
    return await fn();
  } finally {
    endCritical();
  }
}

/**
 * Quiesce for a handoff (nazumods/wow#879): no NEW scheduler tick starts, so nothing new begins writing
 * `data/state.json` while the replacement container is created and verifies, sharing that volume.
 * `redeploy()` calls this only just before the create — not before the build ahead of it, which
 * writes no state and is the one long call (#130).
 *
 * It does not itself await a tick already running (see `checkForUpdate`'s docstring) — that's the
 * shutdown handler's job (`shutdown.ts`, #154), triggered by the `SIGTERM` the replacement's own
 * `retireOriginal` sends once it stops this container. This just flips `handoff` on; the drain's
 * exemption (`handoffExemption` above) is computed live from that flag, not from a snapshot of
 * `critical` taken here — see that function's own comment for why a snapshot is wrong. Whatever's
 * open *at this instant* is the handoff's own holder (the tick or interaction that led here) and
 * is exempted for as long as the handoff stays active; anything that opens *after* this is a
 * genuinely new critical section and does get drained before the signal handler lets the process
 * exit.
 *
 * Deliberately *not* a restart — this process must stay alive through the handoff. It is the
 * only thing left that can remove a replacement which fails to verify, and the only thing that
 * can tell the requester it failed. The replacement does the retiring; we never exit ourselves.
 */
export function beginHandoff(reason: string): void {
  handoff = reason;
  console.log(`[handoff] quiesced: ${reason}`);
}

/**
 * Come back from a handoff that didn't happen, so the bot resumes its normal duties. Does not
 * itself call `maybeResolveIdle()`: dropping `handoffExemption()` from 1 to 0 only makes
 * `awaitCriticalIdle`'s wait condition stricter, never newly satisfies it, and `critical` itself
 * doesn't change here — nothing to re-check.
 */
export function endHandoff(): void {
  if (handoff === undefined) return;
  handoff = undefined;
  console.log("[handoff] resumed — still on the current build");
}

export function handoffActive(): boolean {
  return handoff !== undefined;
}

/** True while an exit, a handoff, or a shutdown is in flight — all three mean "start no new work". */
export function restartPending(): boolean {
  return pending !== undefined || handoff !== undefined || shuttingDown;
}

/**
 * #154: marks the process as shutting down — folded into `restartPending()` so `onTick`'s own
 * `if (restartPending()) return` guard (`announce.ts`) starts no new tick once a signal has
 * arrived, the same way it already refuses one during a handoff or a pending restart. Called once,
 * by the shutdown handler (`shutdown.ts`), before it awaits the drain — never cleared, since a
 * process that has started shutting down never un-shuts-down.
 */
export function beginShutdown(reason: string): void {
  shuttingDown = true;
  console.log(`[restart] shutdown in progress: ${reason}`);
  notifyStop(reason);
}

/**
 * Resolves `true` once `critical` has fallen back to (or was already at) `handoffExemption()` —
 * see that function's own comment for why a live exemption, not a frozen baseline, is the target.
 * Resolves `false` if `timeoutMs` elapses first, so a stuck critical section can never hang a
 * shutdown forever; the timer is ref'd and cleared on either path (the `docker.ts` reasoning on
 * ref'd-vs-unref'd timers applies the same way here — an unref'd one's firing would depend on
 * something else keeping the event loop open, which a process mid-exit cannot be relied on to
 * still be doing).
 */
export function awaitCriticalIdle(timeoutMs: number): Promise<boolean> {
  if (critical <= handoffExemption()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onIdle = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      const idx = idleResolvers.indexOf(onIdle);
      if (idx !== -1) idleResolvers.splice(idx, 1);
      resolve(false);
    }, timeoutMs);
    idleResolvers.push(onIdle);
  });
}

/**
 * Ask the process to exit so the orchestrator respawns it. Exits immediately when
 * idle, otherwise as soon as the in-flight critical section finishes. Repeat calls
 * while one is already pending are no-ops — the first reason wins.
 */
export function requestRestart(reason: string): void {
  if (pending !== undefined) return;
  pending = reason;
  // #248: first, so a plugin tick holding the critical section is told to bail before we wait on it.
  notifyStop(reason);
  if (critical === 0) doExit(reason);
  else console.log(`[restart] deferred until in-flight work finishes: ${reason}`);
}

function doExit(reason: string): void {
  console.log(`[restart] exiting (${RESTART_EXIT_CODE}): ${reason}`);
  exitFn(RESTART_EXIT_CODE);
}
