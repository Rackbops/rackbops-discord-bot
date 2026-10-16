import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stallBunWrite } from "../test/stallBunWrite";
import { settled } from "../test/stateLeaks";
import { failJsonRead, tempNameRegExp } from "../test/storageProbes";
import { config } from "./config";
import type { BotState } from "./state";
import { DATA_DIR } from "./storage";

// state.ts imports the `config` singleton (resolved from process.env at import time) -- the
// required vars are primed once by test/setup.ts's bunfig preload (#136).
const {
  botStateForTest,
  capSeenReleaseIds,
  createStateWriter,
  isRawBotState,
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

  // #457: the cap is wired into the real save path, not just correct as a pure function. The probe repo
  // is taken back out and saved again, so the file left under the test data dir carries nothing of it.
  test("saveState caps the live history before it writes", async () => {
    state.seenReleaseIds["cap/probe"] = Array.from({ length: 150 }, (_, i) => i);
    try {
      await saveState();
      const written = JSON.parse(readFileSync(join(DATA_DIR, "state.json"), "utf8"));
      expect(written.seenReleaseIds["cap/probe"]).toHaveLength(100);
      expect(written.seenReleaseIds["cap/probe"][0]).toBe(50);
    } finally {
      delete state.seenReleaseIds["cap/probe"];
      await saveState();
    }
  });
});

describe("capSeenReleaseIds (#457)", () => {
  test("keeps the newest 100 of 150, per repo, in place", () => {
    const ids = { "a/b": Array.from({ length: 150 }, (_, i) => i), "c/d": [1] };
    const same = capSeenReleaseIds(ids);
    expect(same).toBe(ids); // in place: every importer holds `state`
    expect(ids["a/b"]).toEqual(Array.from({ length: 100 }, (_, i) => i + 50));
    expect(ids["c/d"]).toEqual([1]);
  });
});

describe("isRawBotState (#509)", () => {
  test.each([
    ["an empty object", {}, true],
    ["a legacy global number list", { seenReleaseIds: [1] }, true],
    ["a map of number lists", { seenReleaseIds: { "a/b": [1] } }, true],
    ["a key the core no longer defines", { attemptedUpdateToSha: "x" }, true],
    ["a map value of null", { seenReleaseIds: { "a/b": null } }, false],
    ["a string seenReleaseIds", { seenReleaseIds: "abc" }, false],
    ["a list of strings", { seenReleaseIds: ["1"] }, false],
    ["null", null, false],
    ["a number", 42, false],
    ["a list", [], false],
  ])("%s", (_name, raw, expected) => {
    expect(isRawBotState(raw)).toBe(expected);
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
// overlapping writers tearing the file. `loadState` stays bound to the real STATE_FILE; `saveState` is
// driven for real by `dataIsolation.test.ts` (under the test data dir) and by the cap test below;
// loadStateFrom/saveStateTo/createStateWriter are the same code they delegate to, extracted so it's
// testable against a path we control.
describe("loadStateFrom / saveStateTo / createStateWriter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "state-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("absent file resolves fresh state, not an error, and logs nothing", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await loadStateFrom(join(dir, "state.json"));
      expect(result).toEqual({ seenReleaseIds: {} });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // #457: only the pure normalizer was tested, so a wrong repo at the call site stayed green.
  test("migrates a legacy global array under config.githubRepo", async () => {
    const file = join(dir, "state.json");
    writeFileSync(file, '{"seenReleaseIds":[1,2]}');
    expect(await loadStateFrom(file)).toEqual({ seenReleaseIds: { [config.githubRepo]: [1, 2] } });
  });

  // #509 item 8: these all parse, so they used to load (or load as {}) and then break every saveState
  // (`null.slice`), or silently drop the file's contents.
  test.each([
    ["a null map value", '{"seenReleaseIds":{"a/b":null}}'],
    ["a string seenReleaseIds", '{"seenReleaseIds":"abc"}'],
    ["a number", "42"],
    ["a list", "[]"],
    ["null", "null"],
  ])("a parseable file that is not a state object (%s) is moved aside and loads fresh", async (_name, text) => {
    const file = join(dir, "state.json");
    writeFileSync(file, text);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await loadStateFrom(file)).toEqual({ seenReleaseIds: {} });
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("not a state object"))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes(".corrupt-")).length).toBe(1);
  });

  // loadStateFrom delegates to readJsonOrFresh, so a read that fails for a reason other than corruption
  // surfaces here too (the top-level await in state.ts then fails the boot) instead of moving the file.
  test("a read error that is not corruption propagates, and nothing is moved aside", async () => {
    const file = join(dir, "state.json");
    writeFileSync(file, '{"seenReleaseIds":{}}');
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const failing = failJsonRead(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
    try {
      await expect(loadStateFrom(file)).rejects.toThrow(/EIO/);
    } finally {
      failing.restore();
      errorSpy.mockRestore();
    }
    expect(readFileSync(file, "utf8")).toBe('{"seenReleaseIds":{}}');
    expect(readdirSync(dir).filter((f) => f.includes(".corrupt-"))).toEqual([]);
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

  test("saveStateTo leaves no *.tmp entry in the directory on success", async () => {
    const file = join(dir, "state.json");
    await saveStateTo(file, { seenReleaseIds: {} });
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  // #510 item 9: it used to write a fixed `${path}.tmp`, with none of storage.ts's per-process token.
  test("saveStateTo writes through writeJsonAtomic's temp name, not a fixed .tmp", async () => {
    const file = join(dir, "state.json");
    const stall = stallBunWrite();
    try {
      void saveStateTo(file, { seenReleaseIds: {} }).catch(() => {});
      await stall.reached;
      expect(String(stall.calls[0]![0])).toMatch(tempNameRegExp(file));
    } finally {
      stall.restore();
    }
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
