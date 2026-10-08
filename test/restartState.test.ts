import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RestartStateForTest } from "../src/restart";
import { RESTART_STATE_GUARD, restartLeakMessage, restartStateLeaks } from "./restartState";

const CLEAN: RestartStateForTest = {
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
    expect(restartStateLeaks(CLEAN)).toEqual([]);
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
      const leaks = restartStateLeaks({ ...CLEAN, ...dirty });
      expect(leaks).toHaveLength(1);
      expect(leaks[0]).toContain(expected);
    });
  }

  // restart.ts treats a pending restart or a handoff as set whenever it isn't `undefined`
  // (restartPending(), handoffActive()), so an empty reason is still a leak.
  test("an empty-string reason still counts as set", () => {
    expect(restartStateLeaks({ ...CLEAN, pending: "", handoff: "" })).toHaveLength(2);
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

describe("restartLeakMessage", () => {
  test("starts with the guard's prefix and lists every leak", () => {
    const message = restartLeakMessage(["first leak", "second leak"]);
    expect(message.startsWith(RESTART_STATE_GUARD)).toBe(true);
    expect(message).toContain("first leak; second leak");
  });
});

// The consumer boundary: restartStateLeaks is only worth anything if test/setup.ts really runs it
// after every test. This runs test/restartLeak.fixture.ts as a child `bun test`, rooted at the repo
// so bunfig.toml's preload applies, and reads what the guard did to it.
const CHILD_TIMEOUT_MS = 20_000;

describe("the guard in test/setup.ts, run for real", () => {
  let exitCode: number | null = null;
  let output = "";
  beforeAll(() => {
    const child = Bun.spawnSync([process.execPath, "test", "./test/restartLeak.fixture.ts"], {
      cwd: join(import.meta.dir, ".."),
      // The child takes about a second; this bounds it on its own, whatever the runner does.
      timeout: CHILD_TIMEOUT_MS,
      stdout: "pipe",
      stderr: "pipe",
    });
    output = `${child.stdout.toString()}\n${child.stderr.toString()}`;
    if (child.exitedDueToTimeout) {
      throw new Error(`fixture run was killed after ${CHILD_TIMEOUT_MS}ms:\n${output}`);
    }
    exitCode = child.exitCode;
  }, CHILD_TIMEOUT_MS + 10_000); // longer than the child's own bound, so that bound is what fires

  test("fails the run when a test leaves a handoff active", () => {
    expect(exitCode).toBe(1);
    expect(output).toContain(RESTART_STATE_GUARD);
    expect(output).toContain('handoff active ("fixture leak")');
  });

  test("fails only the leaking test, then resets so the next one starts clean", () => {
    expect(output).toMatch(/^\(fail\) leaks a handoff/m);
    expect(output).toMatch(/^\s*1 pass\s*$/m);
    expect(output).toMatch(/^\s*1 fail\s*$/m);
  });
});
