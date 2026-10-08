// The test-state guard's hook — bunfig.toml's second preload, after test/setup.ts, because the
// modules it checks (test/stateGuard.ts) read the environment setup.ts primes when they load.
//
// Some modules keep module-level state (src/restart.ts's critical-section depth and active handoff,
// src/announce.ts's tick guard, the routing and plugin-request warning records and queues, ...), and
// Bun runs every test file in one process, so every file shares one copy of each. A test that leaves
// some behind changes what every later file sees: #385's leaked handoff made update.test.ts's
// checkForUpdate answer `busy`, and only a randomized order ever showed it.
//
// A preload's afterEach runs after every test in every file, and after that file's own afterEach
// hooks (measured on Bun 1.4.2), so a leak made inside a test fails that test, whatever the order —
// unless that test's own afterEach throws, since Bun then skips this hook for it. Such a leak, and
// one made outside a test — by a beforeAll or afterAll, or by async work finishing late — lands on
// whichever test runs next, and goes uncaught if none does (nothing is left to inherit it then).
// After failing a test the guard resets every guarded module, so one leak fails one test instead of
// every test after it — except a queue left with a job still running: resetting a queue does not
// stop its job, which can change guarded state again while the next test runs and fail that one
// too. (The same is why a test should await the queue, e.g. routingIdleForTest(), before resetting.)
//
// Loading those modules here means config.ts loads for every run, even of a single file that never
// imports it — so a value config.ts refuses, left in your shell (HTTP_PORT=abc, a malformed
// PLUGINS, ...), stops every run before its first test. Unset it; CI sets none of them.

import { afterEach } from "bun:test";
import { findStateLeaks, resetAllState } from "./stateGuard";
import { stateLeakMessage } from "./stateLeaks";

afterEach(async () => {
  const found = await findStateLeaks();
  if (found.length === 0) return;
  resetAllState();
  throw new Error(stateLeakMessage(found));
});
