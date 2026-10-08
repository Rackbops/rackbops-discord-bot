// The test-state guard's table: every module with module-level state a test can change, with the
// snapshot it reads, the decision it applies (test/stateLeaks.ts) and the module's reset hooks.
// What is deliberately left out, and why, is in CONTEXT.md's test-state guard gotcha.
// test/stateGuardHook.ts runs it after every test. No side effects here, so a test can import it.
//
// Imports modules that read `config` and `storage` at load, so it may only be loaded once
// test/setup.ts has primed the environment — bunfig.toml's preload order guarantees that for the
// hook; a test file is loaded after both preloads anyway.

import { announceStateForTest, resetDiscoveryGapForTest, resetPollStateForTest, resetTickGuardForTest } from "../src/announce";
import { configStateForTest, resetConfigForTest } from "../src/config";
import { pluginHostStateForTest, resetPluginHostForTest } from "../src/plugins/host";
import { pluginRequestsStateForTest, resetPluginRequestsForTest } from "../src/plugins/requests";
import { pluginUpdateStateForTest, resetPluginUpdateStateForTest } from "../src/plugins/updates";
import { resetForTest, stateForTest } from "../src/restart";
import { resetRoutingForTest, routingStateForTest } from "../src/routing/live";
import { resetRoutingWarningsForTest, resetRoutingWritesForTest, routingStoreStateForTest } from "../src/routing/store";
import { botStateForTest, resetBotStateForTest } from "../src/state";
import { resetUpdateForTest, updateStateForTest } from "../src/update";
import {
  announceLeaks,
  botStateLeaks,
  configLeaks,
  pluginHostLeaks,
  pluginRequestLeaks,
  pluginUpdateLeaks,
  restartStateLeaks,
  routingLeaks,
  routingStoreLeaks,
  updateLeaks,
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

// src/restart.ts stays first and src/plugins/updates.ts last: test/stateLeak.fixture.ts leaks from
// both ends to prove the real hook reaches the whole table.
export const GUARDED: readonly GuardedModule[] = [
  guarded("src/restart.ts", stateForTest, restartStateLeaks, [resetForTest]),
  guarded("src/config.ts", configStateForTest, configLeaks, [resetConfigForTest]),
  guarded("src/state.ts", botStateForTest, botStateLeaks, [resetBotStateForTest]),
  guarded("src/update.ts", updateStateForTest, updateLeaks, [resetUpdateForTest]),
  guarded("src/announce.ts", announceStateForTest, announceLeaks, [
    resetTickGuardForTest,
    resetDiscoveryGapForTest,
    resetPollStateForTest,
  ]),
  guarded("src/routing/live.ts", routingStateForTest, routingLeaks, [resetRoutingForTest]),
  guarded("src/routing/store.ts", routingStoreStateForTest, routingStoreLeaks, [
    resetRoutingWarningsForTest,
    resetRoutingWritesForTest,
  ]),
  guarded("src/plugins/host.ts", pluginHostStateForTest, pluginHostLeaks, [resetPluginHostForTest]),
  guarded("src/plugins/requests.ts", pluginRequestsStateForTest, pluginRequestLeaks, [resetPluginRequestsForTest]),
  guarded("src/plugins/updates.ts", pluginUpdateStateForTest, pluginUpdateLeaks, [resetPluginUpdateStateForTest]),
];

/** Every guarded module whose state differs from what its reset hooks leave, with what differs. */
export async function findStateLeaks(
  table: readonly GuardedModule[] = GUARDED,
): Promise<{ module: string; leaks: string[] }[]> {
  const found: { module: string; leaks: string[] }[] = [];
  for (const g of table) {
    const leaks = await g.leaks(g.snapshot() as never);
    if (leaks.length > 0) found.push({ module: g.module, leaks });
  }
  return found;
}

/** How long the hook waits, once it has found a leak, for queued work to finish. */
export const QUEUE_DRAIN_MS = 1_000;

/**
 * Waits — at most `ms` — for every promise any guarded module's snapshot holds (its work and write
 * queues) to settle, so work a test left queued finishes before the next test starts rather than
 * during it: the reset hooks that run next start fresh queues, which would not stop it. Resolves
 * `false` if `ms` ran out first. Work no snapshot holds a promise for — an update check, a release
 * poll, a tick — is not waited for at all.
 */
export async function drainQueues(table: readonly GuardedModule[] = GUARDED, ms = QUEUE_DRAIN_MS): Promise<boolean> {
  const pending = table.flatMap((g) =>
    Object.values(g.snapshot() as object).filter((v): v is Promise<unknown> => v instanceof Promise),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([Promise.allSettled(pending).then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs every guarded module's reset hooks. */
export function resetAllState(table: readonly GuardedModule[] = GUARDED): void {
  for (const g of table) for (const reset of g.resets) reset();
}
