import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stallBunWrite } from "../test/stallBunWrite";
import { settled } from "../test/stateLeaks";
import type { BotState } from "./state";

// state.ts imports the `config` singleton (resolved from process.env at import time) -- the
// required vars are primed once by test/setup.ts's bunfig preload (#136).
const {
  botStateForTest,
  createStateWriter,
  loadStateFrom,
  normalizeSeenReleaseIds,
  resetBotStateForTest,
  resetStateWriterForTest,
  saveState,
  saveStateTo,
  state,
} = await import("./state");

// The test-state guard (test/stateGuard.ts) decides from this snapshot alone, so it must track the
// live `state` object and the live writer, and the reset must really put `state` back.
describe("botStateForTest / resetBotStateForTest", () => {
  afterEach(resetBotStateForTest);

  test("names each key changed since load, and the reset puts them back in place", () => {
    const same = state;
    expect(botStateForTest().changedKeys).toEqual([]);
    state.attemptedUpdateToSha = "a".repeat(40);
    state.seenReleaseIds["x/y"] = [1];
    expect(botStateForTest().changedKeys.sort()).toEqual(["attemptedUpdateToSha", "seenReleaseIds"]);
    resetBotStateForTest();
    expect(botStateForTest().changedKeys).toEqual([]);
    expect(state.attemptedUpdateToSha).toBeUndefined();
    expect(state).toBe(same); // the one object every importer holds
  });

  test("a key put back to undefined counts as unchanged", () => {
    state.attemptedUpdateToSha = undefined;
    expect(botStateForTest().changedKeys).toEqual([]);
  });

  // Each is a separate way a leak could go unseen: a key only one side has, a key the reset leaves
  // behind, and a field the reset shares with the snapshot instead of copying.
  test("a key added or removed counts, and the reset removes it and shares nothing with the snapshot", () => {
    const loose = state as unknown as Record<string, unknown>;
    loose.notAStateKey = "added by a test";
    delete loose.seenReleaseIds; // always loaded, {} when there is no state.json
    expect(botStateForTest().changedKeys.sort()).toEqual(["notAStateKey", "seenReleaseIds"]);
    resetBotStateForTest();
    expect("notAStateKey" in state).toBe(false);
    expect(botStateForTest().changedKeys).toEqual([]);
    state.seenReleaseIds["x/y"] = [1]; // would change the snapshot too, were the map shared
    expect(botStateForTest().changedKeys).toEqual(["seenReleaseIds"]);
  });

  // What the guard runs once it has waited, so a save that never finishes can't hold every later
  // test up. The old save is held stuck, not hoped to be still running.
  test("resetStateWriterForTest starts the writer on a fresh queue, dropping a save that never finishes", async () => {
    const stall = stallBunWrite();
    try {
      void saveState();
      await stall.reached;
      const before = botStateForTest().writes;
      resetStateWriterForTest();
      expect(await settled(botStateForTest().writes)).toBe(true);
      expect(await settled(before)).toBe(false);
    } finally {
      stall.restore();
    }
  });

  // Tests clean up with resetBotStateForTest: were it to drop the writer's queue too, a save the
  // test leaked would be gone before the guard looked.
  test("resetBotStateForTest leaves the writer's queue alone, so a leaked save still reaches the guard", async () => {
    const stall = stallBunWrite();
    try {
      void saveState();
      await stall.reached;
      resetBotStateForTest();
      expect(await settled(botStateForTest().writes)).toBe(false);
    } finally {
      stall.restore();
      resetStateWriterForTest(); // the stuck save would otherwise fail this test through the guard
    }
  });

  test("writes settles only once a queued save has", async () => {
    let saved = false;
    void saveState().then(() => (saved = true));
    await botStateForTest().writes;
    expect(saved).toBe(true);
  });
});

describe("normalizeSeenReleaseIds", () => {
  test("migrates a legacy global array under the default repo", () => {
    expect(normalizeSeenReleaseIds([1, 2, 3], "nazumods/wow")).toEqual({
      "nazumods/wow": [1, 2, 3],
    });
  });

  test("an empty legacy array yields an empty map (nothing to file)", () => {
    expect(normalizeSeenReleaseIds([], "nazumods/wow")).toEqual({});
  });

  test("an already-keyed map passes through untouched", () => {
    const map = { "nazumods/wow": [1], "roshne/ActionBarMaster": [2] };
    expect(normalizeSeenReleaseIds(map, "nazumods/wow")).toEqual(map);
  });

  test("undefined (fresh install) yields an empty map", () => {
    expect(normalizeSeenReleaseIds(undefined, "nazumods/wow")).toEqual({});
  });
});

// Real file I/O against a temp dir — never the actual data/state.json — for the two failure
// modes issue #42 fixed: a corrupt file crashing the top-level `await` at import, and two
// overlapping writers tearing the file. `loadState`/`saveState` themselves stay bound to the
// real STATE_FILE and untested here directly; loadStateFrom/saveStateTo/createStateWriter are
// the same code they delegate to, extracted so it's testable against a path we control.
describe("loadStateFrom / saveStateTo / createStateWriter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "state-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("absent file resolves fresh state, not an error", async () => {
    const result = await loadStateFrom(join(dir, "state.json"));
    expect(result).toEqual({ seenReleaseIds: {} });
  });

  test("preserves unknown/legacy keys (e.g. a removed feature's dedup key) across load→save", async () => {
    const file = join(dir, "state.json");
    // `dmfAnnouncedFor` is a legacy WoW key the core no longer defines (#107) — it must round-trip
    // untouched (the additive-migration guarantee). Typed through a Record so the compiler allows the
    // now-unknown key while the runtime value is asserted below. Dropping loadStateFrom's `{ ...raw }`
    // spread — or saveStateTo re-serialising the whole object — would lose it and turn this red.
    const payload: BotState & Record<string, unknown> = {
      seenReleaseIds: { "nazumods/wow": [1, 2, 3] },
      dmfAnnouncedFor: "2026-7",
    };
    await saveStateTo(file, payload);
    const result = await loadStateFrom(file);
    expect(result).toEqual(payload); // the legacy dmfAnnouncedFor survives the round-trip untouched
  });

  test("an empty file loads as fresh state, logs a warning, and is moved aside — not a throw", async () => {
    const file = join(dir, "state.json");
    writeFileSync(file, "");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await loadStateFrom(file);
      expect(result).toEqual({ seenReleaseIds: {} });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
    expect(existsSync(file)).toBe(false); // moved aside, not left in place
    const corruptFiles = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    expect(corruptFiles.length).toBe(1);
  });

  test("a truncated/malformed-JSON file loads as fresh state, not a throw", async () => {
    const file = join(dir, "state.json");
    writeFileSync(file, '{"seenReleaseIds": {"a/b": [1, 2');
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await loadStateFrom(file);
      expect(result).toEqual({ seenReleaseIds: {} });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("saveStateTo never leaves a .tmp file behind on success", async () => {
    const file = join(dir, "state.json");
    await saveStateTo(file, { seenReleaseIds: {} });
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  // Issue #42's own probe: 160/300 overlapping bare-Bun.write pairs left invalid JSON. This is
  // the mutation-check target — reverting createStateWriter/saveStateTo to a bare unguarded
  // Bun.write per call (no queue, no temp+rename) reproduces exactly that under concurrency.
  test("100 concurrent saves through one writer leave a parseable, uncorrupted file", async () => {
    const file = join(dir, "state.json");
    const writer = createStateWriter(file);
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        writer.save({ seenReleaseIds: { "nazumods/wow": [i] } }),
      ),
    );
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.seenReleaseIds["nazumods/wow"]).toBeArray();
    expect(parsed.seenReleaseIds["nazumods/wow"].length).toBe(1);
  });
});
