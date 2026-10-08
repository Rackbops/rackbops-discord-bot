// The decision behind test/setup.ts's restart-state guard: which parts of src/restart.ts's
// module-level state a test left behind. Pure, so it unit-tests field by field without driving the
// real module (test/restartState.test.ts, which also runs a fixture through the real hook).

import type { RestartStateForTest } from "../src/restart";

/** Prefixes the guard's failure, so a leak is recognisable in a long CI log. */
export const RESTART_STATE_GUARD = "[restart-state guard]";

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

/** The error the guard throws for `leaks`. */
export function restartLeakMessage(leaks: string[]): string {
  return (
    `${RESTART_STATE_GUARD} this test left src/restart.ts state behind, which every later test ` +
    `file would inherit: ${leaks.join("; ")}. Clean up in the test's own afterEach or finally ` +
    `(resetForTest(), endHandoff(), ...).`
  );
}
