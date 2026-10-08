import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announceStateForTest, resetDiscoveryGapForTest, resetTickGuardForTest } from "../src/announce";
import { pluginRequestsStateForTest, resetPluginRequestsForTest } from "../src/plugins/requests";
import { pluginUpdateStateForTest, resetPluginUpdateStateForTest } from "../src/plugins/updates";
import { resetForTest, stateForTest, type RestartStateForTest } from "../src/restart";
import { resetRoutingForTest, routingStateForTest } from "../src/routing/live";
import { resetRoutingWarningsForTest, routingWarningsStateForTest } from "../src/routing/store";
import { findStateLeaks, GUARDED, resetAllState, type GuardedModule } from "./stateGuard";
import {
  announceLeaks,
  pluginRequestLeaks,
  pluginUpdateLeaks,
  restartStateLeaks,
  routingLeaks,
  routingWarningLeaks,
  settled,
  STATE_GUARD,
  stateLeakMessage,
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
  const CLEAN = { tickInFlight: false, consecutiveSkips: 0, lastDiscoveryAt: 0 };
  test("a clean state has no leaks", () => {
    expect(announceLeaks(CLEAN)).toEqual([]);
  });
  test("names a tick in flight", () => {
    expect(announceLeaks({ ...CLEAN, tickInFlight: true })).toEqual([expect.stringContaining("a tick still in flight")]);
  });
  test("names counted skips", () => {
    expect(announceLeaks({ ...CLEAN, consecutiveSkips: 2 })).toEqual([expect.stringContaining("2 skipped tick(s)")]);
  });
  test("names a recorded discovery refresh time", () => {
    expect(announceLeaks({ ...CLEAN, lastDiscoveryAt: 1 })).toEqual([expect.stringContaining("a discovery refresh time recorded")]);
  });
  test("names every dirty field", () => {
    expect(announceLeaks({ tickInFlight: true, consecutiveSkips: 1, lastDiscoveryAt: 1 })).toHaveLength(3);
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

describe("routingWarningLeaks", () => {
  test("nothing said is no leak", () => {
    expect(routingWarningLeaks({ said: 0 })).toEqual([]);
  });
  // 1, the smallest leak: most real ones are a single warning.
  test("names warnings already said", () => {
    expect(routingWarningLeaks({ said: 1 })).toEqual([expect.stringContaining("1 routing.json warning(s)")]);
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
});

// Each row is the module's own snapshot, decision and reset hooks — not lookalikes — so a module
// dropped from the table, or wired to another module's hooks, fails here.
describe("GUARDED", () => {
  test("guards exactly these modules, each with its own snapshot, decision and resets", () => {
    expect(GUARDED.map((g) => [g.module, g.snapshot, g.leaks, g.resets])).toEqual([
      ["src/restart.ts", stateForTest, restartStateLeaks, [resetForTest]],
      ["src/announce.ts", announceStateForTest, announceLeaks, [resetTickGuardForTest, resetDiscoveryGapForTest]],
      ["src/routing/live.ts", routingStateForTest, routingLeaks, [resetRoutingForTest]],
      ["src/routing/store.ts", routingWarningsStateForTest, routingWarningLeaks, [resetRoutingWarningsForTest]],
      ["src/plugins/requests.ts", pluginRequestsStateForTest, pluginRequestLeaks, [resetPluginRequestsForTest]],
      ["src/plugins/updates.ts", pluginUpdateStateForTest, pluginUpdateLeaks, [resetPluginUpdateStateForTest]],
    ]);
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
          // The child takes well under a second; this bounds it on its own, whatever the runner does.
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
  });

  test("fails only the leaking tests, and resets after each so the next one starts clean", () => {
    expect(cases.map((c) => [c.name, c.failure === undefined ? "pass" : "fail"])).toEqual([
      ["leaks a handoff", "fail"],
      ["starts clean after the guard caught the leak", "pass"],
      ["leaks a failed-delivery count", "fail"],
      ["starts clean after that leak too", "pass"],
    ]);
  });
});
