import { describe, expect, test } from "bun:test";
import { selectPlugins, collectIntents, describeSkips, pinsFromState } from "./registry";
import type { PluginIndex, PluginIndexEntry } from "./contract";

function entry(overrides: Partial<PluginIndexEntry> & { name: string }): PluginIndexEntry {
  return {
    package: `@rackbops/plugin-${overrides.name}`,
    version: "1.0.0",
    description: "test plugin",
    hostApiVersion: 1,
    commands: [],
    env: [],
    releases: [],
    ...overrides,
  };
}

function index(plugins: PluginIndexEntry[]): PluginIndex {
  return { schemaVersion: 1, generatedAt: "2026-09-04T00:00:00.000Z", plugins };
}

const CORE_COMMANDS = ["report", "update", "plugins"];

describe("selectPlugins", () => {
  test("selects a plugin present in the index with no collisions", () => {
    const idx = index([entry({ name: "warbandeer", commands: ["link", "unlink"] })]);
    const result = selectPlugins(idx, [{ name: "warbandeer" }], 1, CORE_COMMANDS);
    expect(result).toEqual([{ name: "warbandeer", entry: idx.plugins[0], pinnedVersion: undefined }]);
  });

  test("selects in PLUGINS order, not index order", () => {
    const idx = index([entry({ name: "a" }), entry({ name: "b" })]);
    const result = selectPlugins(idx, [{ name: "b" }, { name: "a" }], 1, CORE_COMMANDS);
    expect(result.map((r) => r.name)).toEqual(["b", "a"]);
  });

  test("a name absent from the index is skipped with no entry attached", () => {
    const result = selectPlugins(index([]), [{ name: "nope" }], 1, CORE_COMMANDS);
    expect(result).toEqual([{ name: "nope", pinnedVersion: undefined, skipped: "not in the plugin index" }]);
  });

  test("a hostApiVersion mismatch is skipped, entry still attached", () => {
    const idx = index([entry({ name: "future", hostApiVersion: 2 })]);
    const result = selectPlugins(idx, [{ name: "future" }], 1, CORE_COMMANDS);
    expect(result[0]!.skipped).toBe("needs host API v2, this bot is v1");
    expect(result[0]!.entry).toBe(idx.plugins[0]);
  });

  test("a command colliding with a core command is skipped, naming the command", () => {
    const idx = index([entry({ name: "clashes-core", commands: ["plugins"] })]);
    const result = selectPlugins(idx, [{ name: "clashes-core" }], 1, CORE_COMMANDS);
    expect(result[0]!.skipped).toBe('command "plugins" collides with the core command');
  });

  // #185: a plugin literally named "report" would take over the "report:" interaction-routing
  // prefix core's own report modal already owns (src/report.ts's MODAL_PREFIX) -- refused even
  // when its OWN commands don't collide with anything, since it's the plugin's NAME (not its
  // commands) that becomes the routing prefix.
  test("a plugin named after a reserved core command is skipped, even with non-colliding commands", () => {
    const idx = index([entry({ name: "report", commands: ["totally-unrelated"] })]);
    const result = selectPlugins(idx, [{ name: "report" }], 1, CORE_COMMANDS);
    expect(result[0]!.skipped).toBe(
      'plugin name "report" collides with the core command "report" — its interaction-routing prefix "report:" is reserved',
    );
    expect(result[0]!.entry).toBe(idx.plugins[0]);
  });

  test("a plugin NOT named after a reserved core command is unaffected by this guard", () => {
    const idx = index([entry({ name: "warbandeer", commands: ["link"] })]);
    const result = selectPlugins(idx, [{ name: "warbandeer" }], 1, CORE_COMMANDS);
    expect(result[0]!.skipped).toBeUndefined();
  });

  test("a command colliding with an earlier-selected plugin is skipped, naming that plugin", () => {
    const idx = index([entry({ name: "first", commands: ["hello"] }), entry({ name: "second", commands: ["hello"] })]);
    const result = selectPlugins(idx, [{ name: "first" }, { name: "second" }], 1, CORE_COMMANDS);
    expect(result[0]!.skipped).toBeUndefined();
    expect(result[1]!.skipped).toBe('command "hello" collides with plugin "first"');
  });

  test("a skipped plugin's commands never block a later plugin from claiming the same name", () => {
    const idx = index([
      entry({ name: "skipped", hostApiVersion: 2, commands: ["hello"] }),
      entry({ name: "selected", commands: ["hello"] }),
    ]);
    const result = selectPlugins(idx, [{ name: "skipped" }, { name: "selected" }], 1, CORE_COMMANDS);
    expect(result[0]!.skipped).toContain("host API");
    expect(result[1]!.skipped).toBeUndefined();
  });

  test("carries the pinned version from name@version", () => {
    const idx = index([entry({ name: "warbandeer" })]);
    const result = selectPlugins(idx, [{ name: "warbandeer", version: "1.2.3" }], 1, CORE_COMMANDS);
    expect(result[0]!.pinnedVersion).toBe("1.2.3");
  });

  // #222: the index's hostApiVersion describes ONLY its current version (PluginRelease carries no
  // host API), so it can rule out that version and no other. These build the reported failure: the
  // index moves to 2.0.0 declaring host API 2 while the bot (host API 1) is pinned to — or last
  // came up on — an older version.
  describe("the host-API skip and an older pinned / last-good version (#222)", () => {
    const bumped = () => index([entry({ name: "wow", version: "2.0.0", hostApiVersion: 2 })]);
    const HOST_API_SKIP = "needs host API v2, this bot is v1";

    test("a pin to a compatible older version is NOT skipped past an index host-API bump", () => {
      const idx = bumped();
      const result = selectPlugins(idx, [{ name: "wow", version: "1.5.0" }], 1, CORE_COMMANDS);
      expect(result[0]!.skipped).toBeUndefined();
      expect(result[0]!.entry).toBe(idx.plugins[0]);
      expect(result[0]!.pinnedVersion).toBe("1.5.0");
    });

    test("a last-good installedVersion (no explicit pin) is honored over the incompatible current", () => {
      const pins = new Map([["wow", { installedVersion: "1.5.0" }]]);
      const result = selectPlugins(bumped(), [{ name: "wow" }], 1, CORE_COMMANDS, pins);
      expect(result[0]!.skipped).toBeUndefined();
    });

    test("an explicit pin to the incompatible CURRENT version is still skipped", () => {
      const result = selectPlugins(bumped(), [{ name: "wow", version: "2.0.0" }], 1, CORE_COMMANDS);
      expect(result[0]!.skipped).toBe(HOST_API_SKIP);
    });

    test("a last-good installedVersion that IS the incompatible current is still skipped", () => {
      const pins = new Map([["wow", { installedVersion: "2.0.0" }]]);
      const result = selectPlugins(bumped(), [{ name: "wow" }], 1, CORE_COMMANDS, pins);
      expect(result[0]!.skipped).toBe(HOST_API_SKIP);
    });

    test("no pin at all (a fresh install) of an incompatible current is still skipped", () => {
      const result = selectPlugins(bumped(), [{ name: "wow" }], 1, CORE_COMMANDS, new Map());
      expect(result[0]!.skipped).toBe(HOST_API_SKIP);
    });

    test("another plugin's pin is not applied to this one", () => {
      const pins = new Map([["other", { installedVersion: "1.5.0" }]]);
      const result = selectPlugins(bumped(), [{ name: "wow" }], 1, CORE_COMMANDS, pins);
      expect(result[0]!.skipped).toBe(HOST_API_SKIP);
    });

    // installPlugins uses an explicit PLUGINS pin and only that (install.ts:186-187, and no fallback when one
    // is set: :199), so state.json's versions are irrelevant once the operator has pinned.
    test("the explicit PLUGINS pin outranks state.json's versions", () => {
      const lastGood = new Map([["wow", { installedVersion: "1.5.0" }]]);
      expect(selectPlugins(bumped(), [{ name: "wow", version: "2.0.0" }], 1, CORE_COMMANDS, lastGood)[0]!.skipped).toBe(
        HOST_API_SKIP,
      );
      const atCurrent = new Map([["wow", { installedVersion: "2.0.0" }]]);
      expect(selectPlugins(bumped(), [{ name: "wow", version: "1.5.0" }], 1, CORE_COMMANDS, atCurrent)[0]!.skipped).toBeUndefined();
    });

    // installPlugins tries #104's targetVersion first and, if that install fails, falls back to the last-good
    // installedVersion (install.ts:198-208) — so BOTH must be provably older than the incompatible current.
    test("a target that can fall back to the last-good is kept only if BOTH are older than the incompatible current", () => {
      const select = (pins: { installedVersion?: string; targetVersion?: string }) =>
        selectPlugins(bumped(), [{ name: "wow" }], 1, CORE_COMMANDS, new Map([["wow", pins]]))[0]!.skipped;
      expect(select({ installedVersion: "1.4.0", targetVersion: "1.5.0" })).toBeUndefined();
      expect(select({ targetVersion: "1.5.0" })).toBeUndefined(); // no last-good, so no fallback to reach the current
      expect(select({ installedVersion: "1.5.0", targetVersion: "2.0.0" })).toBe(HOST_API_SKIP); // the target IS the current
      expect(select({ installedVersion: "2.0.0", targetVersion: "1.5.0" })).toBe(HOST_API_SKIP); // the fallback IS the current
    });

    // The opposite direction: the bot moved AHEAD of every published version (a HOST_API_VERSION bump the
    // plugin hasn't caught up with). An older version can only target an older host still, so no pin can
    // make one fit — the skip must stand.
    test("a current version needing an OLDER host than the bot's is skipped whatever is pinned", () => {
      const idx = index([entry({ name: "old", version: "1.0.0", hostApiVersion: 1 })]);
      const reason = "needs host API v1, this bot is v2";
      expect(selectPlugins(idx, [{ name: "old", version: "0.9.0" }], 2, CORE_COMMANDS)[0]!.skipped).toBe(reason);
      const lastGood = new Map([["old", { installedVersion: "0.9.0" }]]);
      expect(selectPlugins(idx, [{ name: "old" }], 2, CORE_COMMANDS, lastGood)[0]!.skipped).toBe(reason);
      expect(selectPlugins(idx, [{ name: "old" }], 2, CORE_COMMANDS)[0]!.skipped).toBe(reason);
    });

    // A version is kept only when it is PROVABLY older than the current: by the premise that a plugin's host
    // API never decreases across its versions, a version at or above the current needs a host at least as new.
    test("a version equal to, newer than, or unorderable against the incompatible current is still skipped", () => {
      const pinned = (version: string) => selectPlugins(bumped(), [{ name: "wow", version }], 1, CORE_COMMANDS)[0]!.skipped;
      expect(pinned("2.0.0")).toBe(HOST_API_SKIP); // equal
      expect(pinned("2.0.1")).toBe(HOST_API_SKIP); // newer, patch
      expect(pinned("2.5.0")).toBe(HOST_API_SKIP); // newer, minor
      expect(pinned("3.0.0")).toBe(HOST_API_SKIP); // newer, major
      expect(pinned("2.0.0-rc.1")).toBe(HOST_API_SKIP); // same numbers plus a prerelease tag: not PROVABLY older
      expect(pinned("banana")).toBe(HOST_API_SKIP); // not a version at all
      expect(pinned("1.9.9")).toBeUndefined();
      const lastGood = (installedVersion: string) =>
        selectPlugins(bumped(), [{ name: "wow" }], 1, CORE_COMMANDS, new Map([["wow", { installedVersion }]]))[0]!.skipped;
      expect(lastGood("3.0.0")).toBe(HOST_API_SKIP);
      expect(lastGood("1.9.9")).toBeUndefined();
    });

    test("versions are ordered numerically, field by field — not as text", () => {
      const idx = index([entry({ name: "wow", version: "1.10.0", hostApiVersion: 2 })]);
      const pinned = (version: string) => selectPlugins(idx, [{ name: "wow", version }], 1, CORE_COMMANDS)[0]!.skipped;
      expect(pinned("1.9.0")).toBeUndefined(); // 9 < 10, though as text "1.9.0" > "1.10.0"
      expect(pinned("1.10.1")).toBe(HOST_API_SKIP);
      expect(pinned("0.99.99")).toBeUndefined(); // a lower major wins over a higher minor and patch
    });

    test("ordering reaches the patch field, sees past a prerelease tag on older numbers, and rejects text that only looks like a version", () => {
      const idx = index([entry({ name: "wow", version: "2.0.5", hostApiVersion: 2 })]);
      const pinned = (version: string) => selectPlugins(idx, [{ name: "wow", version }], 1, CORE_COMMANDS)[0]!.skipped;
      expect(pinned("2.0.4")).toBeUndefined(); // only the patch differs
      expect(pinned("2.0.5")).toBe(HOST_API_SKIP);
      expect(pinned("1.9.0-rc.1")).toBeUndefined(); // a prerelease tag on OLDER numbers is still provably older
      const lastGood = (installedVersion: string) =>
        selectPlugins(idx, [{ name: "wow" }], 1, CORE_COMMANDS, new Map([["wow", { installedVersion }]]))[0]!.skipped;
      expect(lastGood("v1.9.0")).toBe(HOST_API_SKIP); // a leading "v" is not a prefix this parses
      expect(lastGood("x1.9.0")).toBe(HOST_API_SKIP); // nor is anything else before the numbers
    });

    // The index's shape check only wants a string for `version` ("latest" passes it), and Number() loses exactness
    // above 2^53 — neither may throw, or be treated as orderable.
    test("an index version that is not a version, or is too large to compare exactly, keeps nothing and never throws", () => {
      const skippedFor = (current: string, pinned: string) =>
        selectPlugins(index([entry({ name: "wow", version: current, hostApiVersion: 2 })]), [{ name: "wow", version: pinned }], 1, CORE_COMMANDS)[0]!
          .skipped;
      expect(skippedFor("2.0.0", "1.5.0")).toBeUndefined(); // control: the same pin against a real current is kept
      expect(skippedFor("latest", "1.5.0")).toBe(HOST_API_SKIP);
      expect(skippedFor("9007199254740992.1.0", "9007199254740993.0.0")).toBe(HOST_API_SKIP);
    });

    // The entry's intents describe the version that will NOT run. Keeping the plugin would union them into
    // the whole Client (collectIntents), and a privileged one the operator hasn't enabled fails the bot's login.
    test("an entry that declares intents is still skipped — keeping the plugin would change the Client's intents", () => {
      const withIntents = index([entry({ name: "wow", version: "2.0.0", hostApiVersion: 2, intents: [32768] })]);
      const skipped = selectPlugins(withIntents, [{ name: "wow", version: "1.5.0" }], 1, CORE_COMMANDS)[0]!.skipped;
      expect(skipped).toBe(HOST_API_SKIP);
      const noIntents = index([entry({ name: "wow", version: "2.0.0", hostApiVersion: 2, intents: [] })]);
      const kept = selectPlugins(noIntents, [{ name: "wow", version: "1.5.0" }], 1, CORE_COMMANDS);
      expect(kept[0]!.skipped).toBeUndefined();
      expect(collectIntents([1], kept)).toEqual([1]);
    });

    // Honoring the pin only lifts the host-API skip; every later check still applies to the entry.
    test("a pin honored past the host-API check still goes through the name and command collision checks", () => {
      const idx = index([
        entry({ name: "report", version: "2.0.0", hostApiVersion: 2 }),
        entry({ name: "first", version: "2.0.0", hostApiVersion: 2, commands: ["hello"] }),
        entry({ name: "second", commands: ["hello"] }),
      ]);
      const pins = new Map([
        ["report", { installedVersion: "1.5.0" }],
        ["first", { installedVersion: "1.5.0" }],
      ]);
      const result = selectPlugins(idx, [{ name: "report" }, { name: "first" }, { name: "second" }], 1, CORE_COMMANDS, pins);
      expect(result[0]!.skipped).toContain('plugin name "report" collides with the core command');
      expect(result[1]!.skipped).toBeUndefined();
      expect(result[2]!.skipped).toBe('command "hello" collides with plugin "first"');
    });
  });
});

describe("pinsFromState", () => {
  test("keys each plugin's installedVersion and targetVersion by name", () => {
    const pins = pinsFromState({
      hostApiVersion: 1,
      writtenAt: "2026-09-20T00:00:00.000Z",
      plugins: [
        { name: "a", enabled: true, installedVersion: "1.5.0", configured: true, missingEnv: [], active: true },
        { name: "b", enabled: true, installedVersion: "1.0.0", targetVersion: "1.1.0", configured: true, missingEnv: [], active: false },
      ],
    });
    expect(pins.get("a")).toEqual({ installedVersion: "1.5.0" });
    expect(pins.get("b")).toEqual({ installedVersion: "1.0.0", targetVersion: "1.1.0" });
    expect(pins.size).toBe(2);
  });

  test("a plugin that was never installed carries no pin", () => {
    const pins = pinsFromState({
      plugins: [{ name: "never", enabled: true, configured: true, missingEnv: [], active: false, error: "not in the plugin index" }],
    });
    expect(pins.has("never")).toBe(false);
  });

  // readJsonOrFresh only guarantees the file PARSED; index.ts calls this in its top-level boot block,
  // where a throw would crash the bot instead of degrading to "no pins" (the pre-#222 behaviour).
  test("tolerates any parsed shape it does not recognise — no pins, and never a throw", () => {
    const garbage: unknown[] = [
      undefined,
      null,
      42,
      "state",
      [],
      {},
      { plugins: null },
      { plugins: "nope" },
      { plugins: { a: { installedVersion: "1.0.0" } } },
      { plugins: [null, 5, "s", [], { installedVersion: "1.0.0" }, { name: 7, installedVersion: "1.0.0" }] },
      { plugins: [{ name: "a", installedVersion: 1, targetVersion: {} }] },
    ];
    for (const g of garbage) expect(pinsFromState(g).size).toBe(0);
  });

  test("skips only the unusable entries — the well-formed ones alongside still count", () => {
    const pins = pinsFromState({ plugins: [null, { name: "a", installedVersion: "1.5.0" }, 7, { name: "b", installedVersion: 3 }] });
    expect([...pins.keys()]).toEqual(["a"]);
  });
});

describe("describeSkips", () => {
  test("renders only skipped plugins, as \"name: reason\"", () => {
    const selected = [
      { name: "ok", entry: entry({ name: "ok" }) },
      { name: "bad", skipped: "not in the plugin index" },
      { name: "old", entry: entry({ name: "old", hostApiVersion: 2 }), skipped: "needs host API v2, this bot is v1" },
    ];
    expect(describeSkips(selected)).toEqual([
      "bad: not in the plugin index",
      "old: needs host API v2, this bot is v1",
    ]);
  });

  test("no skipped plugins yields an empty array", () => {
    expect(describeSkips([{ name: "ok", entry: entry({ name: "ok" }) }])).toEqual([]);
  });
});

describe("collectIntents", () => {
  const core = [1];

  test("no plugins selected returns core unchanged", () => {
    expect(collectIntents(core, [])).toEqual([1]);
  });

  test("unions a selected plugin's intents, deduped, first-seen order", () => {
    const selected = [
      { name: "a", entry: entry({ name: "a", intents: [1, 512] }) },
      { name: "b", entry: entry({ name: "b", intents: [512, 4096] }) },
    ];
    expect(collectIntents(core, selected)).toEqual([1, 512, 4096]);
  });

  test("a plugin with no declared intents contributes none", () => {
    const selected = [{ name: "a", entry: entry({ name: "a" }) }];
    expect(collectIntents(core, selected)).toEqual([1]);
  });

  test("a skipped plugin's intents are excluded even if its entry declares some", () => {
    const selected = [{ name: "a", entry: entry({ name: "a", intents: [512] }), skipped: "not in the plugin index" }];
    expect(collectIntents(core, selected)).toEqual([1]);
  });

  test("a skipped plugin with no entry at all is handled without throwing", () => {
    const selected = [{ name: "a", skipped: "not in the plugin index" }];
    expect(collectIntents(core, selected)).toEqual([1]);
  });
});
