// Drains the request mailbox every few seconds on its own timer (#241), so a change made in the admin
// panel shows up while the operator is still looking at it. The 60-second scheduler tick still drains it
// too (`pluginRequests` in `announce.ts`) and stays as the backstop; this is deliberately NOT part of the
// tick machinery, which is a busier place than one timer needs.
//
// Two drains never overlap: `consumePluginRequests` is single-flight, and a beat also does nothing while
// the drain it started last is still running, so a slow Discord lookup cannot queue a backlog of drains
// behind itself.

/** How often the mailbox is drained. */
export const REQUEST_DRAIN_MS = 5_000;

export interface RequestDrainOptions {
  /** False until the boot state write and boot drain have landed: nothing is drained before then. */
  ready: () => boolean;
  /** True on the way out (a restart, a handoff, a shutdown): start no new work. */
  restartPending: () => boolean;
  drain: () => Promise<void>;
  log: Pick<Console, "error">;
  intervalMs?: number;
  /** Test seam. Default: `setInterval` / `clearInterval`. Returns the function that stops it. */
  schedule?: (beat: () => void, ms: number) => () => void;
}

function everyInterval(beat: () => void, ms: number): () => void {
  const timer = setInterval(beat, ms);
  return () => clearInterval(timer);
}

/** Starts the timer; returns a function that stops it. */
export function startRequestDrain(opts: RequestDrainOptions): () => void {
  const { ready, restartPending, drain, log } = opts;
  let running = false;
  const beat = (): void => {
    if (running || !ready() || restartPending()) return;
    running = true;
    // An async wrapper, so a drain that throws before it returns a promise is a failure like any other
    // and never an uncaught exception out of a timer callback.
    void (async () => {
      try {
        await drain();
      } catch (err) {
        log.error("[plugins] request-mailbox drain failed", err);
      } finally {
        running = false;
      }
    })();
  };
  return (opts.schedule ?? everyInterval)(beat, opts.intervalMs ?? REQUEST_DRAIN_MS);
}
