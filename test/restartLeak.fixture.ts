// Run only by test/restartState.test.ts, as a child `bun test` — the `.fixture.ts` name keeps the
// main run's discovery from picking it up. Its first test leaks a handoff on purpose, so the child
// run shows whether test/setup.ts's restart-state guard is really wired in.

import { expect, test } from "bun:test";
import { beginHandoff, handoffActive } from "../src/restart";

test("leaks a handoff", () => {
  beginHandoff("fixture leak");
});

// Passes only if the guard reset the state after failing the test above, rather than leaving every
// later test to inherit the leak.
test("starts clean after the guard caught the leak", () => {
  expect(handoffActive()).toBe(false);
});
