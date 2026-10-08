// The test-state guard's hook — bunfig.toml's second preload, after test/setup.ts, because the
// modules it checks (test/stateGuard.ts) read the environment setup.ts primes when they load.
//
// Many modules keep module-level state (src/restart.ts's critical-section depth and active handoff,
// src/announce.ts's tick guard and poll times, the shared `config` and `state` objects, the warning
// records and write queues, ...), and Bun runs every test file in one process, so every file shares
// one copy of each. A test that leaves some behind changes what every later file sees: #385's leaked
// handoff made update.test.ts's checkForUpdate answer `busy`, and only a randomized order ever
// showed it.
//
// A preload's afterEach runs after every test in every file, and after that file's own afterEach
// hooks (measured on Bun 1.4.2), so a leak made inside a test fails that test, whatever the order —
// unless that test's own afterEach throws, since Bun then skips this hook for it. Such a leak, and
// one made outside a test — by a beforeAll or afterAll, or by async work finishing late — lands on
// whichever test runs next, and goes uncaught if none does (nothing is left to inherit it then).
// After failing a test the guard first waits, up to QUEUE_DRAIN_MS, for the work still running on
// the queues the snapshots hold (the write queues, routing/live.ts's registration queue, the
// plugin-request drain) — the fresh queues the resets start would not stop it — then resets every
// guarded module, queues included, so one leak fails one test instead of every test after it. Two
// kinds of job can still change guarded state during the next test and fail that one too: one on
// those queues that outlasts the wait (the message then says so), and one on no queue at all — an
// update check, a release poll, a tick — which is not waited for, and runs on after its flag or
// poll time is reset, possibly against `config` or `state` already put back under it.
//
// Loading those modules here means config.ts loads for every run, even of a single file that never
// imports it — so a value config.ts refuses, left in your shell (HTTP_PORT=abc, a malformed
// PLUGINS, ...), stops every run before its first test. Unset it; CI sets none of them.

import { afterEach } from "bun:test";
import { drainQueues, findStateLeaks, resetAllState } from "./stateGuard";
import { stateLeakMessage } from "./stateLeaks";

afterEach(async () => {
  const found = await findStateLeaks();
  if (found.length === 0) return;
  const drained = await drainQueues();
  resetAllState();
  throw new Error(stateLeakMessage(found, drained));
});
