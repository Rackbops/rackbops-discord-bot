// The first (and only) signal handler in this codebase (#154 — `grep -rn "process.on(" src/`
// previously found nothing). SIGTERM/SIGINT means something EXTERNAL wants this process gone: a
// `docker stop` (an operator's, a compose restart, or — since #160 — the replacement's own
// `retireOriginal`), a host shutdown, or an operator's Ctrl-C. Exiting immediately can truncate a
// state write or half-post an announcement mid-critical-section — see `restart.ts`'s
// `handoffExemption`/`beginHandoff` docstrings and issue #154's own failure sequence (a release
// announcement posted, then the seen-id write lost, when the original was retired mid-`persist`).
// This drains whatever's already in flight first, bounded so a stuck drain can never turn a stop
// into a hang the daemon has to SIGKILL its way past. `destroyClient` below runs INSIDE that same
// bound, not after it — see `SHUTDOWN_GRACE_MS`'s own comment for why the two must nest, not add.
//
// A pure factory so index.ts's own wiring is a one-line `process.on(signal, handler)` and every
// branch here is exercised with fakes — no real process, timers, or Discord client.

/**
 * The TOTAL budget for a real signal, from the moment it's received to the moment `exit(0)` is
 * called — `index.ts`'s wiring passes this to every real handler invocation. `docker stop` sends
 * `SIGTERM` and SIGKILLs at its own timeout — this repo's `stopContainer` passes `t=10`
 * (`docker.ts`) and compose's own default is also 10s — so this must finish with real margin under
 * that, not tie it. One state write is milliseconds; a Discord send mid-retry can run a couple of
 * seconds; 8s is the whole budget (drain AND `destroyClient` together, see below), leaving ~2s of
 * margin under the 10s SIGKILL bound — the daemon's SIGKILL is the backstop if even that's not
 * enough. Deliberately NOT raising `stopContainer`'s own `t` to buy more room here — that
 * lengthens every handoff, and is #160's territory, not this one's.
 */
export const SHUTDOWN_GRACE_MS = 8_000;

export interface ShutdownDeps {
  /** Marks the process as shutting down (`restart.ts`'s `beginShutdown`) — folded into
   *  `restartPending()` so no new scheduler tick starts once a signal has arrived. */
  beginShutdown: (reason: string) => void;
  /** Resolves `true` once every critical section open when the signal arrived has unwound (or
   *  nothing was open to begin with), `false` if `graceMs` elapses first
   *  (`restart.ts`'s `awaitCriticalIdle`). */
  awaitIdle: (graceMs: number) => Promise<boolean>;
  /** Best-effort: closes the gateway connection. Bounded by `destroyClientTimeoutMs` below and its
   *  own rejection swallowed — a stuck or throwing `destroyClient` must never hold up the exit. */
  destroyClient: () => Promise<void> | void;
  exit: (code: number) => void;
  log: Pick<Console, "log" | "error">;
  /** The TOTAL budget — drain AND `destroyClient` together, see `SHUTDOWN_GRACE_MS`'s own comment
   *  for why they nest rather than add. `docker stop` SIGKILLs at its own timeout (10s by default,
   *  and this repo's own `stopContainer` passes `t=10` — see `docker.ts`) — this must finish with
   *  real margin under that: `SHUTDOWN_GRACE_MS` below is the real value every caller uses. */
  graceMs: number;
}

/**
 * The MOST `destroyClient` itself gets — a gateway disconnect is normally near-instant; this
 * exists only so a wedged one can't consume whatever's left of `graceMs` before the daemon's own
 * SIGKILL would have fired anyway. Not an addition to the overall budget: the handler below bounds
 * `destroyClient` to `min(DESTROY_CLIENT_TIMEOUT_MS, time remaining in graceMs after the drain)`,
 * so `awaitIdle` and `destroyClient` together can never exceed `graceMs` — see #154's review
 * finding that an earlier version of this handler ran them back-to-back (up to `graceMs` for the
 * drain, THEN up to this constant for `destroyClient`), which could tie the 10s SIGKILL bound
 * exactly rather than beating it.
 */
const DESTROY_CLIENT_TIMEOUT_MS = 2_000;

async function withTimeout(fn: () => Promise<void> | void, ms: number): Promise<void> {
  await Promise.race([
    Promise.resolve().then(fn),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

/**
 * Builds the signal handler. Register the SAME returned function for both `SIGTERM` and `SIGINT`
 * (`index.ts`) — the `draining` flag is closed over once, so a `SIGTERM` then a later `SIGINT`
 * (or either repeated) is recognised as "already draining," not two independent drains.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let draining = false;
  return async function handleShutdownSignal(signal: string): Promise<void> {
    if (draining) {
      // A second signal means "now" — an operator's second Ctrl-C, or a supervisor escalating.
      // Exit immediately rather than starting (or waiting out) a second drain.
      deps.log.log(`[shutdown] ${signal} received again — exiting immediately`);
      deps.exit(0);
      return;
    }
    draining = true;
    deps.beginShutdown(signal);
    deps.log.log(`[shutdown] ${signal} received — draining in-flight work (up to ${deps.graceMs}ms)`);
    const startedAt = Date.now();
    const drained = await deps.awaitIdle(deps.graceMs);
    const elapsedMs = Date.now() - startedAt;
    if (drained) {
      deps.log.log(`[shutdown] drained in ${elapsedMs}ms — exiting`);
    } else {
      deps.log.error(`[shutdown] grace elapsed after ${elapsedMs}ms — exiting with work still in flight`);
    }
    // #154: bound destroyClient to whatever's left of graceMs, not a fresh DESTROY_CLIENT_TIMEOUT_MS
    // on top of it — so the two nest inside one total budget instead of adding (see
    // DESTROY_CLIENT_TIMEOUT_MS's own comment). If the drain already used up the whole budget,
    // remainingMs is 0 and destroyClient gets essentially no extra time — the daemon's SIGKILL is
    // the backstop either way.
    const remainingMs = Math.max(0, deps.graceMs - elapsedMs);
    try {
      await withTimeout(() => deps.destroyClient(), Math.min(DESTROY_CLIENT_TIMEOUT_MS, remainingMs));
    } catch (err) {
      deps.log.error("[shutdown] destroyClient failed (exiting anyway)", err);
    }
    deps.exit(0);
  };
}
