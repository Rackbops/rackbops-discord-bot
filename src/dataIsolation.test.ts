import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
/** What the checkout's file looks like now — `null` if absent, matching the snapshot's encoding. */
function live(name: string): string | null {
  const p = join(import.meta.dir, "..", "data", name);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function snapshot(name: string): string | null {
  const all = (globalThis as { __repoDataSnapshots?: Record<string, string | null> }).__repoDataSnapshots;
  if (!all || !(name in all)) {
    throw new Error(`preload did not snapshot ${name} — test/setup.ts did not run`);
  }
  return all[name]!;
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

    expect(live("state.json")).toBe(snapshot("state.json"));
  });

  test("a real writeMarker() writes to the override and leaves the checkout untouched", async () => {
    await writeMarker({ status: "ready", sha: "abc1234", at: Date.now() });
    try {
      expect(MARKER_FILE.startsWith(DATA_DIR)).toBe(true);
      expect(existsSync(MARKER_FILE)).toBe(true);
      expect(live("handoff.json")).toBe(snapshot("handoff.json"));
    } finally {
      await clearMarker();
    }
  });
});
