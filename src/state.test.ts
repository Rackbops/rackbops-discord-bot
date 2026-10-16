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
  clearRetirement,
  createStateWriter,
  isRawBotState,
  loadStateFrom,
  normalizeSeenReleaseIds,
  recordRetirement,
  reloadState,
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
    ["a null seenReleaseIds (read as absent, as it always was)", { seenReleaseIds: null }, true],
    ["a string seenReleaseIds", { seenReleaseIds: "abc" }, false],
    ["a number seenReleaseIds", { seenReleaseIds: 42 }, false],
    ["a boolean seenReleaseIds", { seenReleaseIds: true }, false],
    ["a list of strings", { seenReleaseIds: ["1"] }, false],
    ["a list of lists", { seenReleaseIds: [[1, 2]] }, false],
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

  // `null` loaded as an empty map before the shape check (the normalizer's `??`), and still does: the
  // other keys, `attemptedUpdateToSha` among them, must not be moved aside with the file.
  test("a null seenReleaseIds loads as an empty map and keeps the file's other keys", async () => {
    const file = join(dir, "state.json");
    writeFileSync(file, '{"seenReleaseIds":null,"attemptedUpdateToSha":"abc"}');
    expect(await loadStateFrom(file)).toEqual({ seenReleaseIds: {}, attemptedUpdateToSha: "abc" });
    expect(existsSync(file)).toBe(true);
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

// #507, #558: the replacement's re-read of the shared file and the record of who retired whom. These touch the real
// test-dir state.json (the file `reloadState` reads), so each test restores its prior bytes -- or absence -- and the
// shared `state` keys: restoring only the keys would leave a polluted file for the next reload.
describe("reloadState / recordRetirement / clearRetirement (#507, #558)", () => {
  const FILE = join(DATA_DIR, "state.json");
  const OLD = "a".repeat(40);
  const NEW = "b".repeat(40);
  let prior: string | undefined;
  const quiet = () => {
    const warns: string[] = [];
    const logs: string[] = [];
    return {
      warns,
      logs,
      log: {
        warn: (...a: unknown[]) => void warns.push(a.map(String).join(" ")),
        log: (...a: unknown[]) => void logs.push(a.map(String).join(" ")),
      },
    };
  };
  const onDisk = () => JSON.parse(readFileSync(FILE, "utf8")) as Record<string, any>;
  const corruptSiblings = () => readdirSync(DATA_DIR).filter((f) => f.startsWith("state.json.corrupt-"));

  beforeEach(() => {
    prior = existsSync(FILE) ? readFileSync(FILE, "utf8") : undefined;
  });
  afterEach(async () => {
    await settled(botStateForTest().writes);
    resetBotStateForTest();
    for (const f of corruptSiblings()) rmSync(join(DATA_DIR, f), { force: true });
    if (prior === undefined) rmSync(FILE, { force: true });
    else writeFileSync(FILE, prior);
  });

  // Mutations: keeping memory when the file parses (never replacing it); replacing in a new object (every importer
  // holds this one); leaving a key the file lacks behind.
  test("S1: re-reads the file into the shared object, in place: the longer id list, the new key, and a key the file lacks is gone", async () => {
    const same = state;
    state.seenReleaseIds["a/b"] = [1];
    state.attemptedUpdateToSha = "z".repeat(40); // in memory only
    writeFileSync(FILE, JSON.stringify({ seenReleaseIds: { "a/b": [1, 2, 3] }, retiredBy: { sha: NEW, originalSha: OLD, at: 5 } }));
    const q = quiet();

    expect(await reloadState(q.log)).toBe("reloaded");
    expect(state).toBe(same);
    expect(state.seenReleaseIds["a/b"]).toEqual([1, 2, 3]);
    expect(state.retiredBy).toEqual({ sha: NEW, originalSha: OLD, at: 5 });
    expect("attemptedUpdateToSha" in state).toBe(false);
    expect(q.warns).toEqual([]);
  });

  // Mutation: replacing memory with an empty state when there is no file (or an unreadable one).
  test("S2: no file keeps what is in memory and says so", async () => {
    state.seenReleaseIds["a/b"] = [1, 2];
    rmSync(FILE, { force: true });
    const q = quiet();

    expect(await reloadState(q.log)).toBe("kept");
    expect(state.seenReleaseIds["a/b"]).toEqual([1, 2]);
    expect(q.warns).toHaveLength(1);
    expect(q.warns[0]).toContain("absent");
  });

  test("S3: a file that will not parse is moved aside by readJsonOrFresh and the snapshot is kept", async () => {
    state.seenReleaseIds["a/b"] = [1, 2];
    writeFileSync(FILE, "{ not json");
    const q = quiet();

    expect(await reloadState(q.log)).toBe("kept");
    expect(state.seenReleaseIds["a/b"]).toEqual([1, 2]);
    expect(q.warns).toHaveLength(1);
    expect(corruptSiblings()).toHaveLength(1); // the evidence outlives the replacement's next save
    expect(existsSync(FILE)).toBe(false);
  });

  // Mutation: dropping the `isRawBotState` check assigns whatever parsed (here a number where the map belongs).
  test("S3b: a file that parses but is not a state object is ignored and left on disk", async () => {
    state.seenReleaseIds["a/b"] = [1, 2];
    writeFileSync(FILE, '{"seenReleaseIds": 5}');
    const q = quiet();

    expect(await reloadState(q.log)).toBe("kept");
    expect(state.seenReleaseIds["a/b"]).toEqual([1, 2]);
    expect(q.warns).toHaveLength(1);
    expect(q.warns[0]).toContain("not a state object");
    expect(readFileSync(FILE, "utf8")).toBe('{"seenReleaseIds": 5}');
    expect(corruptSiblings()).toEqual([]);
  });

  // Mutations: reading `toSha` instead of `fromSha`; dropping the early return for a build already recorded (a write
  // and a warn where there should be neither).
  test("S4: recordRetirement writes who retired whom from the swap record, in memory and on disk", async () => {
    state.swapInFlight = { fromSha: OLD, toSha: NEW, startedAt: 1 };
    const q = quiet();

    await recordRetirement(NEW, q.log);
    expect(state.retiredBy).toEqual({ sha: NEW, originalSha: OLD, at: expect.any(Number) });
    expect(onDisk().retiredBy).toEqual({ sha: NEW, originalSha: OLD, at: expect.any(Number) });
    expect(q.warns).toEqual([]);
    expect(q.logs).toHaveLength(1);
  });

  test("S4: no swap record to read writes nothing and warns once, naming the AUTO_UPDATE advice", async () => {
    const write = spyOn(Bun, "write");
    const q = quiet();
    try {
      await recordRetirement(NEW, q.log);
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
    expect(state.retiredBy).toBeUndefined();
    expect(q.warns).toHaveLength(1);
    expect(q.warns[0]).toContain("no swap record");
    expect(q.warns[0]).toContain("AUTO_UPDATE=false");
  });

  test("S4: a restart of the replacement that already recorded itself writes nothing and says nothing", async () => {
    state.retiredBy = { sha: NEW, originalSha: OLD, at: 5 }; // no swap record: its first life resolved it as landed
    const write = spyOn(Bun, "write");
    const q = quiet();
    try {
      await recordRetirement(NEW, q.log);
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
    expect(state.retiredBy).toEqual({ sha: NEW, originalSha: OLD, at: 5 });
    expect(q.warns).toEqual([]);
    expect(q.logs).toEqual([]);
  });

  test("S4: a build with no GIT_SHA records nothing and says why", async () => {
    state.swapInFlight = { fromSha: OLD, toSha: NEW, startedAt: 1 };
    const write = spyOn(Bun, "write");
    const q = quiet();
    try {
      await recordRetirement(undefined, q.log);
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
    expect(state.retiredBy).toBeUndefined();
    expect(q.warns).toHaveLength(1);
    expect(q.warns[0]).toContain("no GIT_SHA");
  });

  test("S5: clearRetirement clears and saves the record; with none set it writes nothing", async () => {
    state.retiredBy = { sha: NEW, originalSha: OLD, at: 5 };
    await clearRetirement();
    expect(state.retiredBy).toBeUndefined();
    expect("retiredBy" in onDisk()).toBe(false);

    const write = spyOn(Bun, "write");
    try {
      await clearRetirement();
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});
