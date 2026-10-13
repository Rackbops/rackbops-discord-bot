// Drains the request mailbox every few seconds on its own timer (#241), so a change made in the admin
// panel shows up while the operator is still looking at it. The 60-second scheduler tick still drains it
// too (`pluginRequests` in `announce.ts`) and stays as the backstop; this is deliberately NOT part of the
// tick machinery, which is a busier place than one timer needs.
//
// Two drains never overlap: `consumePluginRequests` is single-flight, and a beat also does nothing while
// the drain it started last is still running, so a slow Discord lookup cannot queue a backlog of drains
// behind itself.
//
// #508: a beat waits on one drain -- and holds a restart for it -- for at most `REQUEST_DRAIN_TIMEOUT_MS`.
// No await in a drain is known to hang (each discord.js REST attempt carries its own timeout, though a
// 429's `retry_after` wait is uncapped), but one that did would otherwise have silenced every later beat
// and deferred every restart, a `/plugins update`'s included, until a SIGTERM. Past the bound the beat logs, lets go of its hold, and the next beat tries
// again; the drain itself is not cancelled, and since `consumePluginRequests` queues behind it, a drain
// that never settles keeps the mailbox stalled -- but logged every bound. The 60-second tick's
// `pluginRequests` pass queues behind the same drain inside the tick's own critical section, so it is
// bounded too, through `settledWithin` (announce.ts's PLUGIN_REQUESTS_TICK_WAIT_MS): a beat holds a
// restart for at most this bound, a tick for its own bound plus the rest of the tick. A slow drain cut
// loose by either may be interrupted by a restart; its writes are temp-then-rename and its request file
// is removed only once applied, so the boot drain replays it.

/** How often the mailbox is drained. */
export const REQUEST_DRAIN_MS = 5_000;
/** The most a beat waits on one drain, and holds `hold` for (#508). Generous, like `guardedTick`'s own
 *  5-minute watchdog: a real drain finishes in seconds. */
export const REQUEST_DRAIN_TIMEOUT_MS = 5 * 60_000;

export interface RequestDrainOptions {
  /** False until the boot state write and boot drain have landed: nothing is drained before then. */
  ready: () => boolean;
  /** True on the way out (a restart, a handoff, a shutdown): start no new work. */
  restartPending: () => boolean;
  drain: () => Promise<void>;
  /** What a restart waits for while a drain runs -- index.ts passes restart.ts's `withCritical` -- held
   *  until the drain settles or `timeoutMs` passes, whichever is first. Default: nothing is held. */
  hold?: (work: () => Promise<void>) => Promise<void>;
  log: Pick<Console, "error">;
  intervalMs?: number;
  /** Default `REQUEST_DRAIN_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Test seam. Default: `setInterval` / `clearInterval`. Returns the function that stops it. */
  schedule?: (beat: () => void, ms: number) => () => void;
}

function everyInterval(beat: () => void, ms: number): () => void {
  const timer = setInterval(beat, ms);
  return () => clearInterval(timer);
}

/** `work` settled, or `ms` passed first. A rejection before then rejects this; one after is dropped
 *  (the race's own subscription to `work` handles it, so it is never an unhandled rejection). Exported
 *  for the tick's `pluginRequests` pass (announce.ts), which needs the same bound (#508). */
export async function settledWithin(work: Promise<void>, ms: number): Promise<"settled" | "timed-out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), ms);
  });
  try {
    return await Promise.race([work.then(() => "settled" as const), deadline]);
  } finally {
    clearTimeout(timer); // a drain that settled in time leaves no timer behind, beat after beat
  }
}

/** Starts the timer; returns a function that stops it. */
export function startRequestDrain(opts: RequestDrainOptions): () => void {
  const { ready, restartPending, drain, log } = opts;
  const hold = opts.hold ?? ((work) => work());
  const timeoutMs = opts.timeoutMs ?? REQUEST_DRAIN_TIMEOUT_MS;
  let running = false;
  const beat = (): void => {
    if (running || !ready() || restartPending()) return;
    running = true;
    // An async wrapper, so a drain that throws before it returns a promise is a failure like any other
    // and never an uncaught exception out of a timer callback.
    void (async () => {
      try {
        await hold(async () => {
          if ((await settledWithin(drain(), timeoutMs)) === "timed-out") {
            log.error(
              `[plugins] request-mailbox drain still running after ${Math.round(timeoutMs / 1000)}s — no longer waited for ` +
                "(this beat lets go of its hold on a restart); the next beat tries again",
            );
          }
        });
      } catch (err) {
        log.error("[plugins] request-mailbox drain failed", err);
      } finally {
        running = false;
      }
    })();
  };
  return (opts.schedule ?? everyInterval)(beat, opts.intervalMs ?? REQUEST_DRAIN_MS);
}
