import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RestartStateForTest } from "../src/restart";
import { RESTART_STATE_GUARD, restartLeakMessage, restartStateLeaks } from "./restartState";
import { TEST_DATA_PREFIX } from "./sweep";

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
// so bunfig.toml's preload applies, and reads what the guard did to it from the child's JUnit
// report — structured, so the result doesn't hang on console formatting (FORCE_COLOR, for one,
// turns the console's `(fail)` marker into a coloured `✗`).
const CHILD_TIMEOUT_MS = 20_000;

/** Each `<testcase>` in a Bun JUnit report: its name, and its failure message if it failed. */
function testcases(xml: string): { name: string; failure: string | undefined }[] {
  const unescape = (s: string) =>
    s.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  return [...xml.matchAll(/<testcase name="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map((m) => {
    const failure = m[2]?.match(/<failure[^>]*\bmessage="([^"]*)"/)?.[1];
    return { name: unescape(m[1] ?? ""), failure: failure === undefined ? undefined : unescape(failure) };
  });
}

describe("the guard in test/setup.ts, run for real", () => {
  let exitCode: number | null = null;
  let cases: { name: string; failure: string | undefined }[] = [];
  beforeAll(() => {
    // Named like the suite's own data dirs (pid included), so test/setup.ts sweeps it if a crash
    // skips the `finally`.
    const dir = mkdtempSync(join(tmpdir(), `${TEST_DATA_PREFIX}${process.pid}-`));
    const report = join(dir, "junit.xml");
    try {
      const child = Bun.spawnSync(
        [process.execPath, "test", "./test/restartLeak.fixture.ts", "--reporter=junit", `--reporter-outfile=${report}`],
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

  test("fails the run, and the leaking test, when a test leaves a handoff active", () => {
    expect(exitCode).toBe(1);
    const leaking = cases.find((c) => c.name === "leaks a handoff");
    expect(leaking?.failure).toStartWith(RESTART_STATE_GUARD);
    expect(leaking?.failure).toContain('handoff active ("fixture leak")');
  });

  test("fails only the leaking test, then resets so the next one starts clean", () => {
    expect(cases.map((c) => [c.name, c.failure === undefined ? "pass" : "fail"])).toEqual([
      ["leaks a handoff", "fail"],
      ["starts clean after the guard caught the leak", "pass"],
    ]);
  });
});
