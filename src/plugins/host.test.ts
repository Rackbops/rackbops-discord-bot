import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlashCommandBuilder } from "discord.js";
import type { HostApi, HostStorage, Plugin, PluginCommand, PluginIndexEntry, PluginModule, PluginStateFile } from "./contract";
import type { InstalledPlugin } from "./install";
import type { LoadedPlugin } from "./host";
import { createJsonWriter, createKeyedJsonMutator, readJsonOrFresh, writeJsonAtomic } from "../storage";
// Prime the env some transitive imports read at load time (harmless if unused after the #104 cycle
// break moved commandNamer to ../commandNaming, so host.ts no longer imports ../commands/config).
process.env.DISCORD_TOKEN ??= "test-token";
process.env.ANNOUNCE_CHANNEL_ID ??= "100";
const {
  createHostApi,
  loadPlugins,
  pluginCommandMap,
  buildCommandBody,
  pluginTicks,
  activatePlugins,
  disposePlugins,
  buildPluginStateFile,
  readPluginState,
  writePluginState,
} = await import("./host");

const realStorage: HostStorage = { readJsonOrFresh, writeJsonAtomic, createJsonWriter, createKeyedJsonMutator };

function makeLog() {
  const calls: { level: "info" | "warn" | "error"; message: string }[] = [];
  return {
    log: {
      info: (m: string) => calls.push({ level: "info", message: m }),
      warn: (m: string) => calls.push({ level: "warn", message: m }),
      error: (m: string) => calls.push({ level: "error", message: m }),
    },
    calls,
  };
}

function entry(over: Partial<PluginIndexEntry> = {}): PluginIndexEntry {
  return {
    name: "demo",
    package: "@rackbops/plugin-demo",
    version: "1.0.0",
    description: "d",
    hostApiVersion: 1,
    intents: [],
    commands: [],
    env: [],
    releases: [],
    ...over,
  };
}

function loaded(e: PluginIndexEntry, plugin: Plugin, running = false): LoadedPlugin {
  return { entry: e, version: "1.0.0", plugin, running };
}

const cmd = (name: string, build?: PluginCommand["build"]): PluginCommand => ({
  name,
  build: build ?? ((b) => b.setDescription(`the ${name} command`)),
  handle: async () => {},
});

describe("createHostApi", () => {
  test("env is only the declared keys, and log is prefixed with the plugin name", () => {
    const { log, calls } = makeLog();
    const host = createHostApi({
      entry: entry({ name: "p", env: [{ key: "P_TOKEN", format: ".*", description: "d" }] }),
      processEnv: { P_TOKEN: "abc", UNRELATED: "leak" },
      dataDir: "/data",
      baseLog: log,
      storage: realStorage,
      announce: async () => {},
    });
    expect(host.name).toBe("p");
    expect(host.env).toEqual({ P_TOKEN: "abc" }); // UNRELATED not included
    expect(host.dataDir).toBe("/data");
    host.log.info("hello");
    expect(calls).toEqual([{ level: "info", message: "[p] hello" }]);
  });
});

describe("loadPlugins", () => {
  const makeHost = (e: PluginIndexEntry): HostApi =>
    createHostApi({ entry: e, processEnv: {}, dataDir: "/d", baseLog: makeLog().log, storage: realStorage, announce: async () => {} });

  test("isolates a rejecting import and a throwing createPlugin, naming each", async () => {
    const { log, calls } = makeLog();
    const installed: InstalledPlugin[] = [
      { entry: entry({ name: "importboom" }), version: "1.0.0", bundlePath: "/a" },
      { entry: entry({ name: "createboom" }), version: "1.0.0", bundlePath: "/b" },
      { entry: entry({ name: "ok" }), version: "1.0.0", bundlePath: "/c" },
    ];
    const importer = async (path: string): Promise<PluginModule> => {
      if (path === "/a") throw new Error("import failed");
      if (path === "/b") return { createPlugin: () => { throw new Error("create failed"); } };
      return { createPlugin: () => ({ commands: [] }) };
    };
    const { loaded: result, errors } = await loadPlugins(installed, makeHost, importer, log);
    expect(result.map((l) => l.entry.name)).toEqual(["ok"]);
    expect(errors.importboom).toContain("import failed");
    expect(errors.createboom).toContain("create failed");
    expect(calls.filter((c) => c.level === "error").map((c) => c.message)).toEqual([
      "[plugins] importboom: import failed",
      "[plugins] createboom: create failed",
    ]);
  });
});

describe("pluginCommandMap", () => {
  test("drops a whole plugin's commands on a collision with core or an earlier plugin", () => {
    const { log, calls } = makeLog();
    const a = loaded(entry({ name: "a" }), { commands: [cmd("x"), cmd("y")] });
    const b = loaded(entry({ name: "b" }), { commands: [cmd("y")] }); // collides with a's y
    const c = loaded(entry({ name: "c" }), { commands: [cmd("dmf")] }); // collides with core
    const map = pluginCommandMap([a, b, c], ["dmf"], log);
    expect([...map.keys()].sort()).toEqual(["x", "y"]); // only a's
    expect(map.get("y")?.entry.name).toBe("a");
    expect(calls.filter((l) => l.level === "warn")).toHaveLength(2); // b and c dropped
  });

  test("a malformed (non-iterable) commands field is skipped, not thrown — other plugins survive", () => {
    const { log, calls } = makeLog();
    const bad = loaded(entry({ name: "bad" }), { commands: 5 as unknown as [] });
    const good = loaded(entry({ name: "good" }), { commands: [cmd("hi")] });
    let map: ReturnType<typeof pluginCommandMap> = new Map();
    expect(() => {
      map = pluginCommandMap([bad, good], [], log);
    }).not.toThrow();
    expect([...map.keys()]).toEqual(["hi"]); // bad skipped, good kept
    expect(calls.some((l) => l.level === "error" && l.message.includes("malformed commands"))).toBe(true);
  });
});

describe("buildCommandBody", () => {
  const coreJson = [{ name: "dmf", description: "core", type: 1, options: [] }] as unknown as Parameters<typeof buildCommandBody>[1];

  test("core JSON first, then each plugin command built under the prefix", () => {
    const { log } = makeLog();
    const map = pluginCommandMap([loaded(entry(), { commands: [cmd("hello")] })], [], log);
    const body = buildCommandBody("r_", coreJson, map, log);
    expect(body.map((c) => c.name)).toEqual(["dmf", "r_hello"]);
    expect(body[1]?.description).toBe("the hello command");
  });

  test("a command that builds to the wrong name is dropped and logged", () => {
    const { log, calls } = makeLog();
    const evil = cmd("hello", () => new SlashCommandBuilder().setName("evil").setDescription("x"));
    const map = pluginCommandMap([loaded(entry(), { commands: [evil] })], [], log);
    const body = buildCommandBody("", coreJson, map, log);
    expect(body.map((c) => c.name)).toEqual(["dmf"]); // evil dropped
    expect(calls.some((l) => l.level === "warn" && l.message.includes("wrong name"))).toBe(true);
  });

  test("a command whose build()/toJSON() throws is dropped, not propagated (the bot must not crash)", () => {
    const { log, calls } = makeLog();
    const boom = cmd("boom", () => {
      throw new Error("build blew up");
    });
    // a valid discord.js builder with no description throws in toJSON() — the other realistic throw
    const noDesc = cmd("nodesc", (b) => b); // never calls setDescription
    const good = cmd("good");
    const map = pluginCommandMap(
      [loaded(entry({ name: "a" }), { commands: [boom] }), loaded(entry({ name: "b" }), { commands: [noDesc] }), loaded(entry({ name: "c" }), { commands: [good] })],
      [],
      log,
    );
    let body: ReturnType<typeof buildCommandBody> = [];
    expect(() => {
      body = buildCommandBody("", coreJson, map, log);
    }).not.toThrow();
    expect(body.map((c) => c.name)).toEqual(["dmf", "good"]); // boom + nodesc dropped, core + good kept
    expect(calls.filter((l) => l.level === "error")).toHaveLength(2);
  });
});

describe("pluginTicks", () => {
  test("a plugin's tick runs only while its running flag is true", async () => {
    let ran = 0;
    const lp = loaded(entry({ name: "p" }), { ticks: [{ name: "t", run: async () => { ran += 1; } }] });
    const checks = pluginTicks([lp], makeLog().log);
    expect(checks[0]?.name).toBe("p:t");
    await checks[0]?.run();
    expect(ran).toBe(0); // running=false → skipped
    lp.running = true;
    await checks[0]?.run();
    expect(ran).toBe(1);
  });

  test("a malformed (non-iterable) ticks field is skipped, not thrown — other plugins' ticks survive", () => {
    const { log, calls } = makeLog();
    // `ticks` typed readonly TickCheck[] but plugin-controlled; a bad bundle can return a non-array.
    const bad = loaded(entry({ name: "bad" }), { ticks: {} as unknown as [] });
    const good = loaded(entry({ name: "good" }), { ticks: [{ name: "t", run: async () => {} }] });
    let checks: ReturnType<typeof pluginTicks> = [];
    expect(() => {
      checks = pluginTicks([bad, good], log);
    }).not.toThrow();
    expect(checks.map((c) => c.name)).toEqual(["good:t"]); // bad skipped, good kept
    expect(calls.some((l) => l.level === "error" && l.message.includes("malformed ticks"))).toBe(true);
  });
});

describe("activatePlugins", () => {
  test("runs in order, isolates a throwing activate, and sets running/error", async () => {
    const { log } = makeLog();
    const order: string[] = [];
    const lp1 = loaded(entry({ name: "one" }), { activate: async () => { order.push("one"); } });
    const lp2 = loaded(entry({ name: "two" }), { activate: async () => { order.push("two"); throw new Error("boom"); } });
    const lp3 = loaded(entry({ name: "three" }), { activate: async () => { order.push("three"); } });
    await activatePlugins([lp1, lp2, lp3], log);
    expect(order).toEqual(["one", "two", "three"]); // isolation: lp2's throw didn't stop lp3
    expect(lp1.running).toBe(true);
    expect(lp2.running).toBe(false);
    expect(lp2.error).toContain("boom");
    expect(lp3.running).toBe(true);
  });
});

describe("disposePlugins (#184)", () => {
  test("calls dispose only for running plugins, and flips running=false for each it disposes", async () => {
    const { log } = makeLog();
    const disposed: string[] = [];
    const running = loaded(entry({ name: "running" }), { dispose: async () => { disposed.push("running"); } }, true);
    const notRunning = loaded(entry({ name: "not-running" }), { dispose: async () => { disposed.push("not-running"); } }, false);
    await disposePlugins([running, notRunning], log, 50);
    expect(disposed).toEqual(["running"]); // not-running's dispose is never called
    expect(running.running).toBe(false);
    expect(notRunning.running).toBe(false); // already false — unaffected either way
  });

  test("a running plugin with no dispose() is simply skipped, and still flipped not-running", async () => {
    const { log } = makeLog();
    const noDispose = loaded(entry({ name: "no-dispose" }), {}, true); // no dispose() at all — the wow-plugin case
    await expect(disposePlugins([noDispose], log, 50)).resolves.toBeUndefined();
    expect(noDispose.running).toBe(false);
  });

  test("a throwing dispose is isolated and logged — the next plugin is still disposed", async () => {
    const { log, calls } = makeLog();
    const order: string[] = [];
    const boom = loaded(entry({ name: "boom" }), { dispose: async () => { order.push("boom"); throw new Error("dispose blew up"); } }, true);
    const ok = loaded(entry({ name: "ok" }), { dispose: async () => { order.push("ok"); } }, true);
    await disposePlugins([boom, ok], log, 50);
    expect(order).toEqual(["boom", "ok"]); // boom's throw didn't stop ok
    expect(boom.running).toBe(false);
    expect(ok.running).toBe(false);
    expect(calls.some((c) => c.level === "error" && c.message.includes("boom") && c.message.includes("dispose failed"))).toBe(true);
  });

  // A synchronously-throwing (or malformed, non-function) dispose must be isolated the same way an
  // async rejection is — plugin.dispose is plugin-controlled and only type-asserted, like commands/ticks.
  test("a synchronously-throwing dispose is isolated the same as an async rejection", async () => {
    const { log, calls } = makeLog();
    const syncBoom = loaded(entry({ name: "sync-boom" }), { dispose: () => { throw new Error("sync blew up"); } }, true);
    const ok = loaded(entry({ name: "ok" }), { dispose: async () => {} }, true);
    await expect(disposePlugins([syncBoom, ok], log, 50)).resolves.toBeUndefined();
    expect(syncBoom.running).toBe(false);
    expect(ok.running).toBe(false);
    expect(calls.some((c) => c.level === "error" && c.message.includes("sync-boom"))).toBe(true);
  });

  // The mutation this guards: dropping the per-plugin timeout entirely, which would leave this test
  // hanging on a dispose() that never resolves on its own.
  test("a dispose that never resolves is bounded by the per-plugin timeout", async () => {
    const { log } = makeLog();
    const wedged = loaded(entry({ name: "wedged" }), { dispose: () => new Promise<void>(() => {}) }, true);
    const settled = await Promise.race([
      disposePlugins([wedged], log, 20).then(() => "settled" as const),
      Bun.sleep(2_000).then(() => "hung" as const),
    ]);
    expect(settled).toBe("settled");
    expect(wedged.running).toBe(false); // still flipped false even though dispose itself never resolved
  });

  test("one wedged plugin's timeout doesn't block the next plugin's own dispose", async () => {
    const { log } = makeLog();
    const order: string[] = [];
    const wedged = loaded(entry({ name: "wedged" }), { dispose: () => new Promise<void>(() => {}) }, true);
    const after = loaded(entry({ name: "after" }), { dispose: async () => { order.push("after"); } }, true);
    const settled = await Promise.race([
      disposePlugins([wedged, after], log, 20).then(() => "settled" as const),
      Bun.sleep(2_000).then(() => "hung" as const),
    ]);
    expect(settled).toBe("settled");
    expect(order).toEqual(["after"]);
  });

  // Review finding: an earlier, sequential version disposed one plugin after another, so N wedged
  // plugins cost N * timeoutMs — at N=2 that already exceeds shutdown.ts's own outer
  // DISPOSE_PLUGINS_TIMEOUT_MS (3s), which could fire and let the process exit mid-way through a
  // LATER plugin's dispose, never having given it a real chance to run at all. Disposing
  // concurrently (Promise.allSettled, not a sequential loop) is what keeps N plugins' worst case
  // the SAME as one plugin's — this is the direct regression guard for that.
  test("multiple wedged plugins are disposed CONCURRENTLY — total time is one timeout, not the sum", async () => {
    const { log } = makeLog();
    const a = loaded(entry({ name: "a" }), { dispose: () => new Promise<void>(() => {}) }, true);
    const b = loaded(entry({ name: "b" }), { dispose: () => new Promise<void>(() => {}) }, true);
    const c = loaded(entry({ name: "c" }), { dispose: () => new Promise<void>(() => {}) }, true);
    const startedAt = Date.now();
    const settled = await Promise.race([
      disposePlugins([a, b, c], log, 100).then(() => "settled" as const),
      // A sequential implementation would take ~300ms (3 * 100ms) for three wedged plugins;
      // concurrent takes ~100ms. This bound sits between the two, so it separates them.
      Bun.sleep(220).then(() => "hung" as const),
    ]);
    const elapsedMs = Date.now() - startedAt;
    expect(settled).toBe("settled");
    expect(elapsedMs).toBeLessThan(220);
    expect(a.running).toBe(false);
    expect(b.running).toBe(false);
    expect(c.running).toBe(false);
  });
});

describe("buildPluginStateFile", () => {
  const previous: PluginStateFile = {
    hostApiVersion: 1,
    writtenAt: "2026-01-01T00:00:00.000Z",
    plugins: [
      { name: "p", enabled: true, installedVersion: "1.0.0", configured: true, missingEnv: [], active: false, notifiedVersion: "0.9.0", skippedVersion: "0.8.0" },
    ],
    pendingReport: { plugin: "p", toVersion: "1.0.0", userId: "u1", requestedAt: 5 },
  };

  test("records this boot's outcome and preserves bookkeeping + pendingReport", () => {
    const e = entry({ name: "p", version: "1.0.0" });
    const state = buildPluginStateFile({
      selected: [{ name: "p", entry: e }],
      installed: [{ entry: e, version: "1.0.0", bundlePath: "/a" }],
      installSkips: {},
      fallbacks: {},
      loaded: [loaded(e, { commands: [] }, true)],
      loadErrors: {},
      processEnv: {},
      previous,
      now: new Date("2026-09-04T00:00:00.000Z"),
    });
    expect(state.writtenAt).toBe("2026-09-04T00:00:00.000Z");
    expect(state.plugins[0]).toMatchObject({ name: "p", enabled: true, active: true, installedVersion: "1.0.0" });
    // bookkeeping preserved from the previous file
    expect(state.plugins[0]?.notifiedVersion).toBe("0.9.0");
    expect(state.plugins[0]?.skippedVersion).toBe("0.8.0");
    expect(state.pendingReport).toEqual(previous.pendingReport);
  });

  test("a required env unset makes the plugin configured:false with missingEnv; error is the first failure", () => {
    const e = entry({ name: "p", env: [{ key: "P_REQ", format: ".*", required: true, description: "d" }] });
    const state = buildPluginStateFile({
      selected: [{ name: "p", entry: e, skipped: "needs host API v2" }],
      installed: [],
      installSkips: {},
      fallbacks: {},
      loaded: [],
      loadErrors: {},
      processEnv: {},
      previous: { hostApiVersion: 1, writtenAt: "", plugins: [] },
      now: new Date("2026-09-04T00:00:00.000Z"),
    });
    expect(state.plugins[0]).toMatchObject({ configured: false, missingEnv: ["P_REQ"], active: false, error: "needs host API v2" });
  });

  // #104: targetVersion is a one-boot transient — consumed here, never carried forward.
  const withTarget: PluginStateFile = {
    hostApiVersion: 1,
    writtenAt: "",
    plugins: [{ name: "p", enabled: true, installedVersion: "1.0.0", targetVersion: "1.1.0", configured: true, missingEnv: [], active: false }],
  };

  test("consumes targetVersion on a successful update: installedVersion becomes the target, targetVersion dropped", () => {
    const e = entry({ name: "p", version: "1.1.0" });
    const state = buildPluginStateFile({
      selected: [{ name: "p", entry: e }],
      installed: [{ entry: e, version: "1.1.0", bundlePath: "/a" }],
      installSkips: {},
      fallbacks: {},
      loaded: [loaded(e, { commands: [] }, true)],
      loadErrors: {},
      processEnv: {},
      previous: withTarget,
      now: new Date("2026-09-05T00:00:00.000Z"),
    });
    expect(state.plugins[0]?.installedVersion).toBe("1.1.0");
    expect(state.plugins[0]?.targetVersion).toBeUndefined();
    expect(state.plugins[0]?.error).toBeUndefined();
  });

  test("on an update fallback: installedVersion stays the previous, error names the failure, targetVersion dropped", () => {
    const e = entry({ name: "p", version: "1.1.0" });
    const state = buildPluginStateFile({
      selected: [{ name: "p", entry: e }],
      installed: [{ entry: e, version: "1.0.0", bundlePath: "/a" }], // fell back to the previous bundle
      installSkips: {},
      fallbacks: { p: { attempted: "1.1.0", reason: "integrity mismatch for @rackbops/plugin-p@1.1.0" } },
      loaded: [loaded(e, { commands: [] }, true)],
      loadErrors: {},
      processEnv: {},
      previous: withTarget,
      now: new Date("2026-09-05T00:00:00.000Z"),
    });
    expect(state.plugins[0]?.installedVersion).toBe("1.0.0"); // reverted to the last-good
    expect(state.plugins[0]?.targetVersion).toBeUndefined(); // consumed either way — no retry loop
    expect(state.plugins[0]?.error).toContain("integrity mismatch");
  });
});

describe("readPluginState / writePluginState round-trip", () => {
  test("writes state.json and preserves bookkeeping across a re-read/re-write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pluginstate-test-"));
    try {
      const e = entry({ name: "p", version: "1.0.0" });
      // seed a previous state with bookkeeping
      await writeJsonAtomic(join(dir, "plugins", "state.json"), {
        hostApiVersion: 1,
        writtenAt: "old",
        plugins: [{ name: "p", enabled: true, installedVersion: "1.0.0", configured: true, missingEnv: [], active: false, skippedVersion: "0.8.0" }],
      });
      const previous = await readPluginState(dir, realStorage);
      expect(previous.plugins[0]?.skippedVersion).toBe("0.8.0");
      await writePluginState({
        dataDir: dir,
        storage: realStorage,
        selected: [{ name: "p", entry: e }],
        installed: [{ entry: e, version: "1.0.0", bundlePath: "/a" }],
        installSkips: {},
        fallbacks: {},
        loaded: [loaded(e, { commands: [] }, true)],
        loadErrors: {},
        processEnv: {},
        previous,
        now: () => new Date("2026-09-04T00:00:00.000Z"),
      });
      const written = await readPluginState(dir, realStorage);
      expect(written.plugins[0]).toMatchObject({ name: "p", active: true, skippedVersion: "0.8.0" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
