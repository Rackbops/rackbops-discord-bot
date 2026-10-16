// #435: the ClientReady handler, extracted so its one invariant is driven by a test instead of read off
// index.ts's source: a standby takes over (retires the original) BEFORE anything that makes this process the
// bot is attached, and a normal boot never calls takeOver. Both instances hold the same DISCORD_TOKEN and
// Discord delivers every event to both sessions, so the other order doubles every reply and announcement.
export interface ReadyDeps<C> {
  mode: "standby" | "normal";
  /** `redeploy.ts`'s `takeOver`, already bound to the original's id. Crash-proof: a retire failure exits the
   *  process rather than returning, so a doomed handoff can never fall through to `activate`. */
  takeOver: () => Promise<void>;
  /** Everything that makes this process *the* bot (`index.ts`'s `activate`). */
  activate: (client: C) => Promise<void>;
  /** Cancels the standby's verify deadline; a no-op in normal mode. Cleared first: a completed login is the
   *  verification bar, whatever follows. */
  clearVerifyTimer: () => void;
  log: Pick<Console, "log">;
  describe: (client: C) => string;
}

export function createReadyHandler<C>(deps: ReadyDeps<C>): (client: C) => Promise<void> {
  return async (client) => {
    deps.log.log(deps.describe(client));
    deps.clearVerifyTimer();
    if (deps.mode === "standby") await deps.takeOver();
    await deps.activate(client);
  };
}
