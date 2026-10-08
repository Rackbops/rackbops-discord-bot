import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announceStateForTest, resetDiscoveryGapForTest, resetPollStateForTest, resetTickGuardForTest, type AnnounceStateForTest } from "../src/announce";
import { configStateForTest, resetConfigForTest } from "../src/config";
import { pluginHostStateForTest, resetPluginHostForTest } from "../src/plugins/host";
import { pluginRequestsStateForTest, resetPluginRequestDrainForTest, resetPluginRequestsForTest } from "../src/plugins/requests";
import { pluginUpdateStateForTest, resetPluginUpdateStateForTest } from "../src/plugins/updates";
import { resetForTest, stateForTest, type RestartStateForTest } from "../src/restart";
import { resetRoutingForTest, resetRoutingQueueForTest, routingStateForTest } from "../src/routing/live";
import { resetRoutingWarningsForTest, resetRoutingWritesForTest, routingStoreStateForTest } from "../src/routing/store";
import { botStateForTest, resetBotStateForTest, resetStateWriterForTest } from "../src/state";
import { resetUpdateForTest, updateStateForTest } from "../src/update";
import { settleWithin } from "./settleWithin";
import { drainQueues, findStateLeaks, GUARDED, resetAllState, type GuardedModule } from "./stateGuard";
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
  settled,
  STATE_GUARD,
  stateLeakMessage,
  updateLeaks,
} from "./stateLeaks";
import { TEST_DATA_PREFIX } from "./sweep";

const NEVER = new Promise<never>(() => {});
const DONE = Promise.resolve();

describe("settled", () => {
  test("a resolved promise has settled", async () => {
    expect(await settled(Promise.resolve("x"))).toBe(true);
  });

  test("a rejected promise has settled too, and its rejection is handled", async () => {
    expect(await settled(Promise.reject(new Error("boom")))).toBe(true);
  });

  test("one still waiting has not", async () => {
    expect(await settled(NEVER)).toBe(false);
  });
});

const CLEAN_RESTART: RestartStateForTest = {
  critical: 0,
  pending: undefined,
  handoff: undefined,
  shuttingDown: false,
  idleWaiters: 0,
  stopListeners: 0,
  stopNotified: false,
};

describe("restartStateLeaks", () => {
  test("a clean state has no leaks", () => {
    expect(restartStateLeaks(CLEAN_RESTART)).toEqual([]);
  });

  // Each field dirty on its own, so dropping any one check from restartStateLeaks fails its own row.
  const rows: [keyof RestartStateForTest, Partial<RestartStateForTest>, string][] = [
    ["critical", { critical: 2 }, "critical depth 2"],
    ["pending", { pending: "update" }, 'restart pending ("update")'],
    ["handoff", { handoff: "redeploy" }, 'handoff active ("redeploy")'],
    ["shuttingDown", { shuttingDown: true }, "shutdown begun"],
    ["idleWaiters", { idleWaiters: 1 }, "1 awaitCriticalIdle waiter(s)"],
    ["stopListeners", { stopListeners: 3 }, "3 onStopRequested listener(s)"],
    ["stopNotified", { stopNotified: true }, "stop already notified"],
  ];
  for (const [field, dirty, expected] of rows) {
    test(`names ${field} when only it is dirty`, () => {
      const leaks = restartStateLeaks({ ...CLEAN_RESTART, ...dirty });
      expect(leaks).toHaveLength(1);
      expect(leaks[0]).toContain(expected);
    });
  }

  // restart.ts treats a pending restart or a handoff as set whenever it isn't `undefined`
  // (restartPending(), handoffActive()), so an empty reason is still a leak.
  test("an empty-string reason still counts as set", () => {
    expect(restartStateLeaks({ ...CLEAN_RESTART, pending: "", handoff: "" })).toHaveLength(2);
  });

  test("names every dirty field, not just the first", () => {
    const allDirty: RestartStateForTest = {
      critical: 1,
      pending: "p",
      handoff: "h",
      shuttingDown: true,
      idleWaiters: 1,
      stopListeners: 1,
      stopNotified: true,
    };
    expect(restartStateLeaks(allDirty)).toHaveLength(7);
  });
});

// The same shape for every other guarded module: clean is no leaks, each field dirty on its own is
// named on its own, and every dirty field is named at once.
describe("announceLeaks", () => {
  const CLEAN: AnnounceStateForTest = {
    tickInFlight: false,
    consecutiveSkips: 0,
    lastDiscoveryAt: 0,
    lastReleasePollAt: 0,
    lastUpdatePollAt: 0,
    lastPluginPollAt: 0,
    pluginStateReady: false,
    unreachableRepos: 0,
  };
  test("a clean state has no leaks", () => {
    expect(announceLeaks(CLEAN)).toEqual([]);
  });
  // Each field dirty on its own, at the smallest dirty value.
  const rows: [keyof AnnounceStateForTest, Partial<AnnounceStateForTest>, string][] = [
    ["tickInFlight", { tickInFlight: true }, "a tick still in flight"],
    ["consecutiveSkips", { consecutiveSkips: 1 }, "1 skipped tick(s)"],
    ["lastDiscoveryAt", { lastDiscoveryAt: 1 }, "a discovery refresh time recorded"],
    ["lastReleasePollAt", { lastReleasePollAt: 1 }, "a release poll time recorded"],
    ["lastUpdatePollAt", { lastUpdatePollAt: 1 }, "a self-update poll time recorded"],
    ["lastPluginPollAt", { lastPluginPollAt: 1 }, "a plugin-update poll time recorded"],
    ["pluginStateReady", { pluginStateReady: true }, "plugin state marked ready"],
    ["unreachableRepos", { unreachableRepos: 1 }, "1 watched repo(s) recorded unreachable"],
  ];
  for (const [field, dirty, expected] of rows) {
    test(`names ${field} when only it is dirty`, () => {
      expect(announceLeaks({ ...CLEAN, ...dirty })).toEqual([expect.stringContaining(expected)]);
    });
  }
  test("names every dirty field", () => {
    const allDirty = Object.assign({}, CLEAN, ...rows.map(([, dirty]) => dirty));
    expect(announceLeaks(allDirty)).toHaveLength(rows.length);
  });
});

describe("routingLeaks", () => {
  const CLEAN = { initialized: false, said: 0, chain: DONE };
  test("a clean state has no leaks", async () => {
    expect(await routingLeaks(CLEAN)).toEqual([]);
  });
  test("names an initialized context", async () => {
    expect(await routingLeaks({ ...CLEAN, initialized: true })).toEqual([expect.stringContaining("routing initialized")]);
  });
  test("names warnings already said", async () => {
    expect(await routingLeaks({ ...CLEAN, said: 2 })).toEqual([expect.stringContaining("2 home-server warning(s)")]);
  });
  test("names a job still running", async () => {
    expect(await routingLeaks({ ...CLEAN, chain: NEVER })).toEqual([expect.stringContaining("still running")]);
  });
  test("names every dirty field", async () => {
    expect(await routingLeaks({ initialized: true, said: 1, chain: NEVER })).toHaveLength(3);
  });
});

describe("routingStoreLeaks", () => {
  const CLEAN = { said: 0, writes: DONE };
  test("a clean state has no leaks", async () => {
    expect(await routingStoreLeaks(CLEAN)).toEqual([]);
  });
  // 1, the smallest leak: most real ones are a single warning.
  test("names warnings already said", async () => {
    expect(await routingStoreLeaks({ ...CLEAN, said: 1 })).toEqual([expect.stringContaining("1 routing.json warning(s)")]);
  });
  test("names a write still running", async () => {
    expect(await routingStoreLeaks({ ...CLEAN, writes: NEVER })).toEqual([expect.stringContaining("a routing or secrets write still running")]);
  });
  test("names every dirty field", async () => {
    expect(await routingStoreLeaks({ said: 1, writes: NEVER })).toHaveLength(2);
  });
});

describe("botStateLeaks", () => {
  const CLEAN = { changedKeys: [], writes: DONE };
  test("a clean state has no leaks", async () => {
    expect(await botStateLeaks(CLEAN)).toEqual([]);
  });
  test("names every changed key", async () => {
    expect(await botStateLeaks({ ...CLEAN, changedKeys: ["attemptedUpdateToSha", "pendingUpdateReport"] })).toEqual([
      expect.stringContaining("state changed since it was loaded: attemptedUpdateToSha, pendingUpdateReport"),
    ]);
  });
  test("names a write still running", async () => {
    expect(await botStateLeaks({ ...CLEAN, writes: NEVER })).toEqual([expect.stringContaining("a state.json write still running")]);
  });
  test("names every dirty field", async () => {
    expect(await botStateLeaks({ changedKeys: ["x"], writes: NEVER })).toHaveLength(2);
  });
});

describe("configLeaks", () => {
  test("nothing changed is no leak", () => {
    expect(configLeaks({ changedKeys: [] })).toEqual([]);
  });
  test("one changed key is a leak", () => {
    expect(configLeaks({ changedKeys: ["gitSha"] })).toEqual([expect.stringContaining("config changed since it was resolved: gitSha")]);
  });
  test("names every changed key", () => {
    expect(configLeaks({ changedKeys: ["gitSha", "githubToken"] })).toEqual([
      expect.stringContaining("config changed since it was resolved: gitSha, githubToken"),
    ]);
  });
});

describe("updateLeaks", () => {
  test("no check in flight is no leak", () => {
    expect(updateLeaks({ checkInFlight: false })).toEqual([]);
  });
  test("names a check in flight", () => {
    expect(updateLeaks({ checkInFlight: true })).toEqual([expect.stringContaining("an update check still in flight")]);
  });
});

describe("pluginHostLeaks", () => {
  test("no write pending is no leak", async () => {
    expect(await pluginHostLeaks({ writes: DONE })).toEqual([]);
  });
  test("names a write still running", async () => {
    expect(await pluginHostLeaks({ writes: NEVER })).toEqual([expect.stringContaining("a plugin state.json write still running")]);
  });
});

describe("pluginRequestLeaks", () => {
  const CLEAN = { undeletable: 0, draining: DONE };
  test("a clean state has no leaks", async () => {
    expect(await pluginRequestLeaks(CLEAN)).toEqual([]);
  });
  test("names remembered undeletable files", async () => {
    expect(await pluginRequestLeaks({ ...CLEAN, undeletable: 2 })).toEqual([expect.stringContaining("2 request file(s)")]);
  });
  test("names a drain still running", async () => {
    expect(await pluginRequestLeaks({ ...CLEAN, draining: NEVER })).toEqual([expect.stringContaining("a request drain still running")]);
  });
  test("names every dirty field", async () => {
    expect(await pluginRequestLeaks({ undeletable: 1, draining: NEVER })).toHaveLength(2);
  });
});

describe("pluginUpdateLeaks", () => {
  test("no counted failures is no leak", () => {
    expect(pluginUpdateLeaks({ deliveryFailures: 0 })).toEqual([]);
  });
  test("names counted delivery failures", () => {
    expect(pluginUpdateLeaks({ deliveryFailures: 1 })).toEqual([expect.stringContaining("1 failed notice delivery count(s)")]);
  });
});

describe("stateLeakMessage", () => {
  test("starts with the guard's prefix and names each module with each of its leaks", () => {
    const message = stateLeakMessage([
      { module: "src/a.ts", leaks: ["first leak", "second leak"] },
      { module: "src/b.ts", leaks: ["third leak"] },
    ]);
    expect(message.startsWith(STATE_GUARD)).toBe(true);
    expect(message).toContain("src/a.ts: first leak; second leak | src/b.ts: third leak");
  });

  // A reset hook starts a fresh queue but does not stop a write already running on the old one.
  test("says how to clean up a write or job still running, not just state", () => {
    expect(stateLeakMessage([{ module: "src/a.ts", leaks: ["x"] }])).toContain("await any write or job it started");
  });

  test("says when queued work outlasted the guard's wait, and only then", () => {
    const outlasted = "still running when the guard stopped waiting for it";
    expect(stateLeakMessage([{ module: "src/a.ts", leaks: ["x"] }], false)).toContain(outlasted);
    expect(stateLeakMessage([{ module: "src/a.ts", leaks: ["x"] }], true)).not.toContain(outlasted);
    expect(stateLeakMessage([{ module: "src/a.ts", leaks: ["x"] }])).not.toContain(outlasted);
  });
});

// Each row is the module's own snapshot, decision and reset hooks — not lookalikes — so a module
// dropped from the table, or wired to another module's hooks, fails here.
describe("GUARDED", () => {
  test("guards exactly these modules, each with its own snapshot, decision and resets", () => {
    expect(GUARDED.map((g) => [g.module, g.snapshot, g.leaks, g.resets])).toEqual([
      ["src/restart.ts", stateForTest, restartStateLeaks, [resetForTest]],
      ["src/config.ts", configStateForTest, configLeaks, [resetConfigForTest]],
      ["src/state.ts", botStateForTest, botStateLeaks, [resetBotStateForTest, resetStateWriterForTest]],
      ["src/update.ts", updateStateForTest, updateLeaks, [resetUpdateForTest]],
      ["src/announce.ts", announceStateForTest, announceLeaks, [resetTickGuardForTest, resetDiscoveryGapForTest, resetPollStateForTest]],
      ["src/routing/live.ts", routingStateForTest, routingLeaks, [resetRoutingForTest, resetRoutingQueueForTest]],
      ["src/routing/store.ts", routingStoreStateForTest, routingStoreLeaks, [resetRoutingWarningsForTest, resetRoutingWritesForTest]],
      ["src/plugins/host.ts", pluginHostStateForTest, pluginHostLeaks, [resetPluginHostForTest]],
      ["src/plugins/requests.ts", pluginRequestsStateForTest, pluginRequestLeaks, [resetPluginRequestsForTest, resetPluginRequestDrainForTest]],
      ["src/plugins/updates.ts", pluginUpdateStateForTest, pluginUpdateLeaks, [resetPluginUpdateStateForTest]],
    ]);
  });

  // The hook waits for a queue at most QUEUE_DRAIN_MS, then relies on a reset to start a fresh one;
  // a row holding a queue with no reset at all (as src/plugins/host.ts's row was, before #394's
  // round 1) would let a job that never finishes fail every later test. This catches only a row
  // with no reset; that a reset really replaces its queue is pinned by each queue's own test.
  test("every row whose snapshot holds a queue has a reset hook", () => {
    const holdsQueue = (g: GuardedModule) => Object.values(g.snapshot() as object).some((v) => v instanceof Promise);
    expect(GUARDED.filter(holdsQueue).length).toBeGreaterThan(0);
    expect(GUARDED.filter((g) => holdsQueue(g) && g.resets.length === 0).map((g) => g.module)).toEqual([]);
  });
});

describe("drainQueues", () => {
  const table = (snapshot: () => unknown): GuardedModule[] => [{ module: "src/q.ts", snapshot, leaks: () => [], resets: [] }];

  test("waits for every promise a snapshot holds to settle, rejected ones included", async () => {
    const finished: string[] = [];
    const slow = Bun.sleep(30).then(() => void finished.push("slow"));
    const failing = Bun.sleep(10).then(() => {
      finished.push("failing");
      throw new Error("boom");
    });
    failing.catch(() => {});
    const done = await drainQueues(table(() => ({ slow, failing, notAPromise: 1 })), 1_000);
    expect(done).toBe(true);
    expect(finished.sort()).toEqual(["failing", "slow"]);
  });

  test("gives up after its bound when something never settles, and says so", async () => {
    const outcome = await settleWithin(drainQueues(table(() => ({ stuck: NEVER })), 20), "drainQueues", 500);
    expect(outcome).toEqual({ ok: true, v: false });
  });

  // Otherwise every caught leak leaves a timer running out the whole bound after the hook moved on.
  test("clears its timer when everything settles first", async () => {
    const set = spyOn(globalThis, "setTimeout");
    const clear = spyOn(globalThis, "clearTimeout");
    try {
      const done = drainQueues(table(() => ({ ready: DONE })), 60_000);
      const timer = set.mock.results[0]?.value; // set before drainQueues first awaits
      expect(timer).toBeDefined();
      expect(await done).toBe(true);
      expect(clear.mock.calls.some(([t]) => t === timer)).toBe(true);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });
});

// The two loops the hook runs, over a table of fakes that record what they were given and asked.
describe("findStateLeaks and resetAllState", () => {
  function fakeTable() {
    const seen: unknown[] = [];
    const resets: string[] = [];
    const table: GuardedModule[] = [
      { module: "src/clean.ts", snapshot: () => "clean-snap", leaks: (s: never) => (seen.push(s), []), resets: [() => resets.push("clean")] },
      { module: "src/sync.ts", snapshot: () => "sync-snap", leaks: (s: never) => (seen.push(s), ["sync leak"]), resets: [() => resets.push("sync")] },
      {
        module: "src/async.ts",
        snapshot: () => "async-snap",
        leaks: async (s: never) => (seen.push(s), ["async leak", "another"]),
        resets: [() => resets.push("async-1"), () => resets.push("async-2")],
      },
    ];
    return { table, seen, resets };
  }

  test("findStateLeaks hands each module its own snapshot and reports only the ones that leaked, in order", async () => {
    const { table, seen } = fakeTable();
    expect(await findStateLeaks(table)).toEqual([
      { module: "src/sync.ts", leaks: ["sync leak"] },
      { module: "src/async.ts", leaks: ["async leak", "another"] },
    ]);
    expect(seen).toEqual(["clean-snap", "sync-snap", "async-snap"]);
  });

  test("resetAllState runs every reset hook of every module, leaked or not", () => {
    const { table, resets } = fakeTable();
    resetAllState(table);
    expect(resets).toEqual(["clean", "sync", "async-1", "async-2"]);
  });
});

// The consumer boundary: the table is only worth anything if test/stateGuardHook.ts really runs it
// after every test. This runs test/stateLeak.fixture.ts as a child `bun test`, rooted at the repo
// so bunfig.toml's preloads apply, and reads what the guard did to it from the child's JUnit
// report — structured, so the result doesn't hang on console formatting (FORCE_COLOR, for one,
// turns the console's `(fail)` marker into a coloured `✗`).
const CHILD_TIMEOUT_MS = 20_000;

/**
 * Each `<testcase>` in a Bun JUnit report: its name, and its failure message if it failed. Decodes
 * only `&quot;`, the one entity this fixture's names and messages produce; any other entity would
 * stay encoded and fail the assertions below rather than let them pass.
 */
function testcases(xml: string): { name: string; failure: string | undefined }[] {
  return [...xml.matchAll(/<testcase name="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map((m) => ({
    name: m[1] ?? "",
    failure: m[2]?.match(/<failure[^>]*\bmessage="([^"]*)"/)?.[1]?.replaceAll("&quot;", '"'),
  }));
}

describe("the guard in test/stateGuardHook.ts, run for real", () => {
  let exitCode: number | null = null;
  let cases: { name: string; failure: string | undefined }[] = [];
  beforeAll(() => {
    // Named like the suite's own data dirs (pid included), so test/setup.ts sweeps it if a crash
    // skips the `finally`.
    const dir = mkdtempSync(join(tmpdir(), `${TEST_DATA_PREFIX}${process.pid}-`));
    const report = join(dir, "junit.xml");
    try {
      const child = Bun.spawnSync(
        [process.execPath, "test", "./test/stateLeak.fixture.ts", "--reporter=junit", `--reporter-outfile=${report}`],
        {
          cwd: join(import.meta.dir, ".."),
          // The child takes about a second (one leak waits out QUEUE_DRAIN_MS); this bounds it on
          // its own, whatever the runner does.
          timeout: CHILD_TIMEOUT_MS,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      if (child.exitedDueToTimeout) {
        throw new Error(`fixture run was killed after ${CHILD_TIMEOUT_MS}ms:\n${child.stderr.toString()}`);
      }
      exitCode = child.exitCode;
      cases = testcases(readFileSync(report, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, CHILD_TIMEOUT_MS + 10_000); // longer than the child's own bound, so that bound is what fires

  // The literal, not STATE_GUARD: it is what someone searches a CI log for.
  test("fails the run, and each leaking test, naming the first and the last module in the table", () => {
    expect(exitCode).toBe(1);
    const handoff = cases.find((c) => c.name === "leaks a handoff");
    expect(handoff?.failure).toStartWith("[test-state guard]");
    expect(handoff?.failure).toContain('src/restart.ts: handoff active ("fixture leak")');
    const delivery = cases.find((c) => c.name === "leaks a failed-delivery count");
    expect(delivery?.failure).toStartWith("[test-state guard]");
    expect(delivery?.failure).toContain("src/plugins/updates.ts: 1 failed notice delivery count(s)");
    const drain = cases.find((c) => c.name === "leaks a request drain still running");
    expect(drain?.failure).toContain("src/plugins/requests.ts: a request drain still running");
  });

  // Only the write that never finished outlasted the wait; the drain finished inside it.
  test("says so when queued work outlasted its wait, and only then", () => {
    const outlasted = "still running when the guard stopped waiting for it";
    const stuck = cases.find((c) => c.name === "leaks a write that never finishes");
    expect(stuck?.failure).toContain("src/routing/store.ts: a routing or secrets write still running");
    expect(stuck?.failure).toContain(outlasted);
    const others = cases.filter((c) => c.failure !== undefined && c !== stuck);
    expect(others).toHaveLength(3);
    for (const c of others) expect(c.failure).not.toContain(outlasted);
  });

  test("fails only the leaking tests, and resets — after waiting out a running job — so the next starts clean", () => {
    expect(cases.map((c) => [c.name, c.failure === undefined ? "pass" : "fail"])).toEqual([
      ["leaks a handoff", "fail"],
      ["starts clean after the guard caught the leak", "pass"],
      ["leaks a request drain still running", "fail"],
      ["starts after the leaked drain has finished", "pass"],
      ["leaks a write that never finishes", "fail"],
      ["starts with that write no longer queued", "pass"],
      ["leaks a failed-delivery count", "fail"],
      ["starts clean after that leak too", "pass"],
    ]);
  });
});
