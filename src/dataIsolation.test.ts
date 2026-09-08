import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const { state, saveState } = await import("./state");
const { writeMarker, clearMarker, MARKER_FILE } = await import("./handoff");
const { DATA_DIR } = await import("./storage");

/**
 * The regression guard for #139: the suite must never read or write the checkout's own `data/`.
 *
 * These assert against the REAL write path — `saveState()` and `writeMarker()` on the real
 * singletons — deliberately. The obvious version of this test (asserting on `resolveDataDir()` or
 * on `DATA_DIR`) is **vacuous**: it pins `storage.ts` and says nothing about the path `state.ts`
 * actually writes to. Proven during review — reverting `state.ts` to its hardcoded path left a
 * `resolveDataDir`-based suite fully green while the corruption came straight back.
 *
 * Each test therefore (1) forces a genuine write, (2) asserts it landed under the override, and
 * (3) asserts the checkout file is byte-identical to the snapshot the preload took before any
 * module loaded. Step 2 is what stops the whole thing passing when no write happens at all.
 */
const repoDataDir = join(import.meta.dir, "..", "data");

/** What the checkout's file looks like now — `null` if absent, matching the snapshot's encoding. */
function live(rel: string): string | null {
  const p = join(repoDataDir, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function snapshots(): Record<string, string | null> {
  const all = (globalThis as { __repoDataSnapshots?: Record<string, string | null> }).__repoDataSnapshots;
  if (!all) throw new Error("preload did not snapshot data/ — test/setup.ts did not run");
  return all;
}

/** Every file the preload saw, still byte-identical — plus nothing new having appeared. */
function assertCheckoutUntouched(): void {
  const before = snapshots();
  for (const [rel, content] of Object.entries(before)) expect(live(rel)).toBe(content);

  const now: string[] = [];
  (function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else now.push(relative(repoDataDir, p).replaceAll("\\", "/"));
    }
  })(repoDataDir);
  // A regression CREATES files (saveStateTo does mkdirSync + write), which on CI — where there is
  // no data/ at all — is the only way it would show. Comparing the file list catches that.
  expect(now.sort()).toEqual(Object.keys(before).sort());
}

describe("the test run is isolated from the checkout's data/ (#139)", () => {
  test("the data dir is the override, not the repo's own", () => {
    expect(process.env.BOT_DATA_DIR).toBeTruthy();
    expect(DATA_DIR).toBe(process.env.BOT_DATA_DIR!);
    expect(DATA_DIR).not.toBe(join(import.meta.dir, "..", "data"));
  });

  test("a real saveState() writes to the override and leaves the checkout untouched", async () => {
    state.seenReleaseIds["rackbops/isolation-probe"] = [1, 2, 3];
    await saveState();

    const written = join(DATA_DIR, "state.json");
    expect(existsSync(written)).toBe(true); // the write really happened — not a vacuous pass
    expect(readFileSync(written, "utf8")).toContain("rackbops/isolation-probe");

    assertCheckoutUntouched();
  });

  test("a real writeMarker() writes to the override and leaves the checkout untouched", async () => {
    await writeMarker({ status: "ready", sha: "abc1234", at: Date.now() });
    try {
      expect(MARKER_FILE.startsWith(DATA_DIR)).toBe(true);
      expect(existsSync(MARKER_FILE)).toBe(true);
      assertCheckoutUntouched();
    } finally {
      await clearMarker();
    }
  });
});
