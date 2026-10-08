// Run only by test/stateGuard.test.ts, as a child `bun test` — the `.fixture.ts` name keeps the
// main run's discovery from picking it up. It leaks on purpose from the FIRST and the LAST entry of
// test/stateGuard.ts's table (src/restart.ts, src/plugins/updates.ts), so the child run shows that
// test/stateGuardHook.ts checks and resets the whole table, not just its head.

import { expect, test } from "bun:test";
import { checkPluginUpdates, pluginUpdateStateForTest, type PluginUpdateDeps } from "../src/plugins/updates";
import { beginHandoff, handoffActive } from "../src/restart";

test("leaks a handoff", () => {
  beginHandoff("fixture leak");
});

// Passes only if the guard reset the state after failing the test above, rather than leaving every
// later test to inherit the leak.
test("starts clean after the guard caught the leak", () => {
  expect(handoffActive()).toBe(false);
});

test("leaks a failed-delivery count", async () => {
  const fails = async (): Promise<void> => {
    throw new Error("undeliverable");
  };
  const deps: PluginUpdateDeps = {
    loadIndex: async () => ({
      schemaVersion: 1,
      generatedAt: "",
      plugins: [
        { name: "a", package: "@rackbops/plugin-a", version: "1.1.0", description: "a", hostApiVersion: 1, commands: [], env: [], releases: [] },
      ],
    }),
    readState: async () => ({
      hostApiVersion: 1,
      writtenAt: "",
      plugins: [{ name: "a", enabled: true, configured: true, missingEnv: [], active: true, installedVersion: "1.0.0" }],
    }),
    mutateState: async () => {},
    deliverers: { dmUser: fails, postAnnounce: fails },
    adminUserIds: ["admin"],
    hostApiVersion: 1,
    pluginsCommand: "plugins",
    now: () => new Date("2026-09-05T12:00:00.000Z"),
    log: { info() {}, warn() {}, error() {} },
    restartPending: () => false,
    requestRestart: () => {},
  };
  await checkPluginUpdates(deps); // one failed delivery: counted, below the give-up cap
});

test("starts clean after that leak too", () => {
  expect(pluginUpdateStateForTest().deliveryFailures).toBe(0);
});
