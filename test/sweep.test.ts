import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { isPidAlive, MAX_AGE_MS, parsePid, sweepStaleTestDirs, TEST_DATA_PREFIX } from "./sweep";

const NOW = 1_000_000_000; // an arbitrary epoch-ms anchor; only relative deltas below matter
const FIVE_MIN_MS = 5 * 60 * 1000;

/** `sweepStaleTestDirs` with sane defaults (one directory, alive, young), overridable per test. */
function sweep(
  entries: string[],
  opts: Partial<{ now: number; mtimeOf: (name: string) => number; isAlive: (pid: number) => boolean; maxAgeMs: number }> = {},
): { removedByReturn: string[]; removedByCallback: string[] } {
  const removedByCallback: string[] = [];
  const removedByReturn = sweepStaleTestDirs({
    tmp: "/tmp",
    entries,
    now: opts.now ?? NOW,
    mtimeOf: opts.mtimeOf ?? (() => NOW - FIVE_MIN_MS),
    isAlive: opts.isAlive ?? (() => true),
    maxAgeMs: opts.maxAgeMs ?? MAX_AGE_MS,
    remove: (name) => removedByCallback.push(name),
  });
  return { removedByReturn, removedByCallback };
}

describe("sweepStaleTestDirs (#252)", () => {
  test("a directory whose pid is alive and which is young is kept", () => {
    const name = `${TEST_DATA_PREFIX}12345-abcdef`;
    const { removedByReturn, removedByCallback } = sweep([name], { isAlive: () => true, mtimeOf: () => NOW - FIVE_MIN_MS });
    expect(removedByReturn).toEqual([]);
    expect(removedByCallback).toEqual([]);
  });

  test("a directory whose pid is dead is removed", () => {
    const name = `${TEST_DATA_PREFIX}12345-abcdef`;
    const { removedByReturn, removedByCallback } = sweep([name], { isAlive: () => false });
    expect(removedByReturn).toEqual([name]);
    expect(removedByCallback).toEqual([name]);
  });

  test("a directory older than the bound is removed even if its pid is alive", () => {
    const name = `${TEST_DATA_PREFIX}12345-abcdef`;
    const { removedByReturn } = sweep([name], { isAlive: () => true, mtimeOf: () => NOW - 2 * MAX_AGE_MS });
    expect(removedByReturn).toEqual([name]);
  });

  test("a name with no pid (the pre-#252 format) is removed", () => {
    const name = `${TEST_DATA_PREFIX}abc123`;
    const { removedByReturn } = sweep([name], { isAlive: () => true, mtimeOf: () => NOW - FIVE_MIN_MS });
    expect(removedByReturn).toEqual([name]);
    expect(parsePid(name)).toBeNull();
  });

  test("a name outside the prefix is never touched", () => {
    const { removedByReturn, removedByCallback } = sweep(["other-dir", "not-ours-at-all"], { isAlive: () => false, mtimeOf: () => 0 });
    expect(removedByReturn).toEqual([]);
    expect(removedByCallback).toEqual([]);
  });

  test("an entry a concurrent sweep already removed (mtimeOf throws ENOENT) is skipped, not removed again", () => {
    const name = `${TEST_DATA_PREFIX}12345-abcdef`;
    const removedByCallback: string[] = [];
    const removedByReturn = sweepStaleTestDirs({
      tmp: "/tmp",
      entries: [name],
      now: NOW,
      mtimeOf: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      isAlive: () => true,
      maxAgeMs: MAX_AGE_MS,
      remove: (n) => removedByCallback.push(n),
    });
    expect(removedByReturn).toEqual([]);
    expect(removedByCallback).toEqual([]);
  });

  test("a mix: only the stale ones are removed, the live young one survives", () => {
    const alive = `${TEST_DATA_PREFIX}1-a`;
    const dead = `${TEST_DATA_PREFIX}2-b`;
    const old = `${TEST_DATA_PREFIX}3-c`;
    const noPid = `${TEST_DATA_PREFIX}nope`;
    const { removedByReturn } = sweep(["other-dir", alive, dead, old, noPid], {
      isAlive: (pid) => pid === 1 || pid === 3,
      mtimeOf: (name) => (name === old ? NOW - 2 * MAX_AGE_MS : NOW - FIVE_MIN_MS),
    });
    expect(removedByReturn.sort()).toEqual([dead, noPid, old].sort());
  });
});

describe("parsePid", () => {
  test("extracts the pid from the current directory-name shape", () => {
    expect(parsePid(`${TEST_DATA_PREFIX}12345-abcdef`)).toBe(12345);
  });
  test("null for the pre-#252 format (no pid at all)", () => {
    expect(parsePid(`${TEST_DATA_PREFIX}abcdef`)).toBeNull();
  });
  test("null for a name that isn't this prefix's shape at all", () => {
    expect(parsePid("something-else")).toBeNull();
  });
});

// This test file runs INSIDE the same process test/setup.ts's preload already ran in (bun test
// runs the whole suite in one process — setup.ts's own header comment measures this), so
// process.env.BOT_DATA_DIR here is the real directory the preload just created for THIS run.
describe("setup: this run's data dir embeds this process's pid (#252)", () => {
  test("BOT_DATA_DIR's basename matches the prefix + this process's pid", () => {
    const dir = process.env.BOT_DATA_DIR;
    expect(dir).toBeDefined();
    expect(basename(dir!)).toMatch(new RegExp(`^${TEST_DATA_PREFIX}${process.pid}-`));
  });
});

describe("isPidAlive (#252)", () => {
  // The decision-2 probe, kept as a test: process.kill(pid, 0) must distinguish live from dead on
  // this box, or the sweep's liveness check is worthless. Confirmed on Windows (Bun 1.3.14) before
  // relying on it elsewhere in this PR.
  test("this process is alive, a pid that just exited is not", async () => {
    expect(isPidAlive(process.pid)).toBe(true);
    const proc = Bun.spawn(["bun", "-e", ""], { stdout: "ignore", stderr: "ignore" });
    const pid = proc.pid;
    await proc.exited;
    expect(isPidAlive(pid)).toBe(false);
  });
});
