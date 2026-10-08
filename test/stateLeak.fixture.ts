// Run only by test/stateGuard.test.ts, as a child `bun test` — the `.fixture.ts` name keeps the
// main run's discovery from picking it up. It leaks on purpose from the FIRST and the LAST entry of
// test/stateGuard.ts's table (src/restart.ts, src/plugins/updates.ts), so the child run shows that
// test/stateGuardHook.ts reaches both ends of the table, not just its head, and resets after each;
// and it leaves a request drain running, to show the hook waits for the job before the next test.

import { expect, test } from "bun:test";
import { consumePluginRequests, type PluginRequestDeps } from "../src/plugins/requests";
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

let drainFinished = false;

test("leaks a request drain still running", () => {
  const none = async (): Promise<never> => {
    throw new Error("not reached: the mailbox is empty");
  };
  const deps: PluginRequestDeps = {
    requestsDir: "/fixture/requests",
    // The drain's only step: it reads an empty mailbox, 100 ms from now — well after this test ends.
    readDir: async () => {
      await Bun.sleep(100);
      drainFinished = true;
      return [];
    },
    readFile: none,
    unlink: none,
    rename: none,
    mkdir: none,
    loadIndex: none,
    readState: none,
    mutateState: none,
    requestRestart: () => {},
    hostApiVersion: 1,
    now: () => new Date("2026-09-05T12:00:00.000Z"),
    log: { info() {}, warn() {}, error() {} },
  };
  void consumePluginRequests(deps);
});

// Passes only if the guard waited for the leaked drain before this test began.
test("starts after the leaked drain has finished", () => {
  expect(drainFinished).toBe(true);
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
