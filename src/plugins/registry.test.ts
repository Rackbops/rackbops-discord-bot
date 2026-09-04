import { describe, expect, test } from "bun:test";
import { selectPlugins, collectIntents } from "./registry";
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

const CORE_COMMANDS = ["dmf", "reset", "status", "report", "update"];

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
    const idx = index([entry({ name: "clashes-core", commands: ["status"] })]);
    const result = selectPlugins(idx, [{ name: "clashes-core" }], 1, CORE_COMMANDS);
    expect(result[0]!.skipped).toBe('command "status" collides with the core command');
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
