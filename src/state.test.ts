import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// state.ts imports the `config` singleton (resolved from process.env at import time), so
// prime the required vars before pulling the module in — see config.test.ts.
process.env.DISCORD_TOKEN ??= "test-token";
process.env.ANNOUNCE_CHANNEL_ID ??= "100";
const { createStateWriter, loadStateFrom, normalizeSeenReleaseIds, saveStateTo } = await import("./state");

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

  test("a well-formed file round-trips through saveStateTo/loadStateFrom", async () => {
    const file = join(dir, "state.json");
    await saveStateTo(file, { seenReleaseIds: { "nazumods/wow": [1, 2, 3] }, dmfAnnouncedFor: "2026-7" });
    const result = await loadStateFrom(file);
    expect(result).toEqual({ seenReleaseIds: { "nazumods/wow": [1, 2, 3] }, dmfAnnouncedFor: "2026-7" });
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
