import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlashCommandBuilder } from "discord.js";
import type { HostApi, HostStorage, Plugin, PluginCommand, PluginIndexEntry, PluginModule, PluginStateFile } from "./contract";
import type { InstalledPlugin } from "./install";
import type { LoadedPlugin } from "./host";
import { createJsonWriter, createKeyedJsonMutator, readJsonOrFresh, writeJsonAtomic } from "../storage";
// host.ts imports ../commands, which resolves the config singleton from process.env at import time.
process.env.DISCORD_TOKEN ??= "test-token";
process.env.ANNOUNCE_CHANNEL_ID ??= "100";
const {
  createHostApi,
  loadPlugins,
  pluginCommandMap,
  buildCommandBody,
  pluginTicks,
  activatePlugins,
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
    const checks = pluginTicks([lp]);
    expect(checks[0]?.name).toBe("p:t");
    await checks[0]?.run();
    expect(ran).toBe(0); // running=false → skipped
    lp.running = true;
    await checks[0]?.run();
    expect(ran).toBe(1);
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
      loaded: [],
      loadErrors: {},
      processEnv: {},
      previous: { hostApiVersion: 1, writtenAt: "", plugins: [] },
      now: new Date("2026-09-04T00:00:00.000Z"),
    });
    expect(state.plugins[0]).toMatchObject({ configured: false, missingEnv: ["P_REQ"], active: false, error: "needs host API v2" });
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
