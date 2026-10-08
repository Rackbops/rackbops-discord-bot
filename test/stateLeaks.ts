// The decisions behind the test-state guard (test/stateGuard.ts): which parts of a module's
// module-level state a test left behind. Pure — the promise checks only ask whether a promise has
// settled — so each unit-tests field by field without driving the real module
// (test/stateGuard.test.ts, which also runs a fixture through the real hook).

import type { AnnounceStateForTest } from "../src/announce";
import type { RestartStateForTest } from "../src/restart";
import type { RoutingStateForTest } from "../src/routing/live";

/** Prefixes the guard's failure, so a leak is recognisable in a long CI log. */
export const STATE_GUARD = "[test-state guard]";

/**
 * Whether `p` has settled, either way. Its `then` callbacks run as microtasks, which all drain
 * before a `setImmediate` fires, so a promise that already settled always wins the race; one still
 * waiting on I/O or a timer does not.
 */
export function settled(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
  ]);
}

/** One line per field of `s` that differs from what `resetForTest()` leaves; empty when clean. */
export function restartStateLeaks(s: RestartStateForTest): string[] {
  const leaks: string[] = [];
  if (s.critical !== 0) leaks.push(`critical depth ${s.critical} (a critical section never closed)`);
  if (s.pending !== undefined) leaks.push(`restart pending (${JSON.stringify(s.pending)})`);
  if (s.handoff !== undefined) {
    leaks.push(`handoff active (${JSON.stringify(s.handoff)}) — checkForUpdate answers busy until it ends`);
  }
  if (s.shuttingDown) leaks.push("shutdown begun");
  if (s.idleWaiters !== 0) leaks.push(`${s.idleWaiters} awaitCriticalIdle waiter(s) never resolved`);
  if (s.stopListeners !== 0) leaks.push(`${s.stopListeners} onStopRequested listener(s) still registered`);
  if (s.stopNotified) leaks.push("stop already notified — a later onStopRequested listener would never run");
  return leaks;
}

/** Against what `resetTickGuardForTest()`, `resetDiscoveryGapForTest()` and `resetPollStateForTest()` leave. */
export function announceLeaks(s: AnnounceStateForTest): string[] {
  const leaks: string[] = [];
  if (s.tickInFlight) leaks.push("a tick still in flight — the next guardedTick is skipped");
  if (s.consecutiveSkips !== 0) leaks.push(`${s.consecutiveSkips} skipped tick(s) counted`);
  if (s.lastDiscoveryAt !== 0) leaks.push("a discovery refresh time recorded — the next discovery check waits out its gap");
  if (s.lastReleasePollAt !== 0) leaks.push("a release poll time recorded — the next release check waits out its gap");
  if (s.lastUpdatePollAt !== 0) leaks.push("a self-update poll time recorded — the next auto-update check waits out its gap");
  if (s.lastPluginPollAt !== 0) leaks.push("a plugin-update poll time recorded — the next plugin-update check waits out its gap");
  if (s.pluginStateReady) leaks.push("plugin state marked ready — the plugin request and update checks now run");
  if (s.unreachableRepos !== 0) leaks.push(`${s.unreachableRepos} watched repo(s) recorded unreachable — not reported again`);
  return leaks;
}

/** Against what `resetRoutingForTest()` leaves. */
export async function routingLeaks(s: RoutingStateForTest): Promise<string[]> {
  const leaks: string[] = [];
  if (s.initialized) leaks.push("routing initialized (initRouting) — joins, leaves and registrations act on it");
  if (s.said !== 0) leaks.push(`${s.said} home-server warning(s) already said — they will not be said again`);
  if (!(await settled(s.chain))) leaks.push("a registration or discovery refresh still running");
  return leaks;
}

/** Against what `resetRoutingWarningsForTest()` leaves, and with no routing or secrets write pending. */
export async function routingStoreLeaks(s: { said: number; writes: Promise<void> }): Promise<string[]> {
  const leaks: string[] = [];
  if (s.said !== 0) leaks.push(`${s.said} routing.json warning(s) already said — a later read will not say them again`);
  if (!(await settled(s.writes))) leaks.push("a routing or secrets write still running");
  return leaks;
}

/** Against `state` as it was loaded, and with no state.json write pending. */
export async function botStateLeaks(s: { changedKeys: string[]; writes: Promise<void> }): Promise<string[]> {
  const leaks: string[] = [];
  if (s.changedKeys.length !== 0) leaks.push(`state changed since it was loaded: ${s.changedKeys.join(", ")}`);
  if (!(await settled(s.writes))) leaks.push("a state.json write still running");
  return leaks;
}

/** Against `config` as it was resolved. */
export function configLeaks(s: { changedKeys: string[] }): string[] {
  return s.changedKeys.length === 0 ? [] : [`config changed since it was resolved: ${s.changedKeys.join(", ")}`];
}

/** Against what `resetUpdateForTest()` leaves. */
export function updateLeaks(s: { checkInFlight: boolean }): string[] {
  return s.checkInFlight ? ["an update check still in flight — the next checkForUpdate answers busy"] : [];
}

/** With no plugin state.json write pending. */
export async function pluginHostLeaks(s: { writes: Promise<void> }): Promise<string[]> {
  return (await settled(s.writes)) ? [] : ["a plugin state.json write still running"];
}

/** Against what `resetPluginRequestsForTest()` leaves. */
export async function pluginRequestLeaks(s: { undeletable: number; draining: Promise<void> }): Promise<string[]> {
  const leaks: string[] = [];
  if (s.undeletable !== 0) leaks.push(`${s.undeletable} request file(s) remembered as undeletable — a later drain skips them`);
  if (!(await settled(s.draining))) leaks.push("a request drain still running — the next drain queues behind it");
  return leaks;
}

/** Against what `resetPluginUpdateStateForTest()` leaves. */
export function pluginUpdateLeaks(s: { deliveryFailures: number }): string[] {
  return s.deliveryFailures === 0
    ? []
    : [`${s.deliveryFailures} failed notice delivery count(s) kept — a later check gives up sooner`];
}

/** The error the guard throws for what it found, one entry per module that leaked. */
export function stateLeakMessage(found: { module: string; leaks: string[] }[]): string {
  const what = found.map(({ module, leaks }) => `${module}: ${leaks.join("; ")}`).join(" | ");
  return (
    `${STATE_GUARD} module state was left behind at the end of this test, and every later test ` +
    `file would inherit it — ${what}. Usually this test leaked it: clean up in its own afterEach ` +
    `or finally, with that module's reset...ForTest(). If it never touches that state, look at ` +
    `what ran just before it: a beforeAll or afterAll, an afterEach that threw (which skips this ` +
    `guard for its own test), or async work an earlier test left running.`
  );
}
