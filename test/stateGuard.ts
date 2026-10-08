// The test-state guard's table: every module whose module-level state outlives a test, with the
// snapshot it reads, the decision it applies (test/stateLeaks.ts) and the module's own reset hooks.
// test/stateGuardHook.ts runs it after every test. No side effects here, so a test can import it.
//
// Imports modules that read `config` and `storage` at load, so it may only be loaded once
// test/setup.ts has primed the environment — bunfig.toml's preload order guarantees that for the
// hook; a test file is loaded after both preloads anyway.

import { announceStateForTest, resetDiscoveryGapForTest, resetTickGuardForTest } from "../src/announce";
import { pluginRequestsStateForTest, resetPluginRequestsForTest } from "../src/plugins/requests";
import { pluginUpdateStateForTest, resetPluginUpdateStateForTest } from "../src/plugins/updates";
import { resetForTest, stateForTest } from "../src/restart";
import { resetRoutingForTest, routingStateForTest } from "../src/routing/live";
import { resetRoutingWarningsForTest, routingWarningsStateForTest } from "../src/routing/store";
import {
  announceLeaks,
  pluginRequestLeaks,
  pluginUpdateLeaks,
  restartStateLeaks,
  routingLeaks,
  routingWarningLeaks,
} from "./stateLeaks";

export interface GuardedModule {
  module: string;
  snapshot: () => unknown;
  leaks: (snapshot: never) => string[] | Promise<string[]>;
  resets: readonly (() => void)[];
}

/** Ties a snapshot to the decision that reads it, so the two can only be paired when their types agree. */
function guarded<S>(
  module: string,
  snapshot: () => S,
  leaks: (s: S) => string[] | Promise<string[]>,
  resets: (() => void)[],
): GuardedModule {
  return { module, snapshot, leaks, resets };
}

export const GUARDED: readonly GuardedModule[] = [
  guarded("src/restart.ts", stateForTest, restartStateLeaks, [resetForTest]),
  guarded("src/announce.ts", announceStateForTest, announceLeaks, [resetTickGuardForTest, resetDiscoveryGapForTest]),
  guarded("src/routing/live.ts", routingStateForTest, routingLeaks, [resetRoutingForTest]),
  guarded("src/routing/store.ts", routingWarningsStateForTest, routingWarningLeaks, [resetRoutingWarningsForTest]),
  guarded("src/plugins/requests.ts", pluginRequestsStateForTest, pluginRequestLeaks, [resetPluginRequestsForTest]),
  guarded("src/plugins/updates.ts", pluginUpdateStateForTest, pluginUpdateLeaks, [resetPluginUpdateStateForTest]),
];

/** Every guarded module whose state differs from what its reset hooks leave, with what differs. */
export async function findStateLeaks(): Promise<{ module: string; leaks: string[] }[]> {
  const found: { module: string; leaks: string[] }[] = [];
  for (const g of GUARDED) {
    const leaks = await g.leaks(g.snapshot() as never);
    if (leaks.length > 0) found.push({ module: g.module, leaks });
  }
  return found;
}

/** Runs every guarded module's reset hooks. */
export function resetAllState(): void {
  for (const g of GUARDED) for (const reset of g.resets) reset();
}
