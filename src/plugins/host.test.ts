import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlashCommandBuilder, type MessageComponentInteraction } from "discord.js";
import type { HostApi, HostStorage, Plugin, PluginCommand, PluginIndex, PluginIndexEntry, PluginModule, PluginStateFile } from "./contract";
import { installPlugins, type InstalledPlugin } from "./install";
import type { LoadedPlugin } from "./host";
import { pinsFromState, selectPlugins } from "./registry";
import { createJsonWriter, createKeyedJsonMutator, readJsonOrFresh, writeJsonAtomic } from "../storage";
// DISCORD_TOKEN/ANNOUNCE_CHANNEL_ID (some transitive imports read them at load time) are primed
// once, for every test file, by test/setup.ts's bunfig preload (#136).
const {
  createHostApi,
  loadPlugins,
  pluginCommandMap,
  buildCommandBody,
  autocompleteOptionPaths,
  pluginTicks,
  PLUGIN_TICK_TIMEOUT_MS,
  activatePlugins,
  disposePlugins,
  buildPluginStateFile,
  readPluginState,
  writePluginState,
  routeInteractionByPrefix,
  dispatchPluginInteraction,
} = await import("./host");
// The real consumers of pluginTicks' checks (#217): runTick drives the isolation/logging the bound
// relies on, and restart.ts's critical section is what a bounded wait lets a restart out of.
const { runTick, TICK_MS } = await import("../announce");
const { withCritical, requestRestart, setExitFn, resetForTest: resetRestartState } = await import("../restart");

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

/** A minimal fake component/modal interaction -- only what dispatchPluginInteraction actually
 *  touches (customId, replied/deferred, reply()), matching this file's existing `as unknown as`
 *  cast convention for discord.js interaction fakes (see commands.test.ts). */
function fakeInteraction(
  customId: string,
  over: Partial<{ replied: boolean; deferred: boolean; reply: (opts: unknown) => Promise<unknown> }> = {},
): MessageComponentInteraction {
  return {
    customId,
    replied: false,
    deferred: false,
    reply: async () => {},
    ...over,
  } as unknown as MessageComponentInteraction;
}

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

  // #218: a command asking for autocomplete still registers (a live command with a dead picker beats
  // dropping a working command), but warns once, naming every option path that asked for it.
  test("a command with an autocomplete option is registered, and the warning names the option", () => {
    const { log, calls } = makeLog();
    const withAutocomplete = cmd("search", (b) =>
      b.setDescription("d").addStringOption((o) => o.setName("q").setDescription("d").setAutocomplete(true)),
    );
    const map = pluginCommandMap([loaded(entry(), { commands: [withAutocomplete] })], [], log);
    const body = buildCommandBody("", coreJson, map, log);
    expect(body.map((c) => c.name)).toEqual(["dmf", "search"]);
    const warn = calls.find((l) => l.level === "warn" && l.message.includes("autocomplete"));
    expect(warn?.message).toContain('"q"');
  });

  test("an autocomplete option inside a subcommand group is named by its path", () => {
    const { log, calls } = makeLog();
    const withGroup = cmd("browse", (b) =>
      b
        .setDescription("d")
        .addSubcommandGroup((g) =>
          g
            .setName("g")
            .setDescription("d")
            .addSubcommand((s) =>
              s
                .setName("s")
                .setDescription("d")
                .addStringOption((o) => o.setName("q").setDescription("d").setAutocomplete(true)),
            ),
        ),
    );
    const map = pluginCommandMap([loaded(entry(), { commands: [withGroup] })], [], log);
    buildCommandBody("", coreJson, map, log);
    const warn = calls.find((l) => l.level === "warn" && l.message.includes("autocomplete"));
    expect(warn?.message).toContain('"g s q"');
  });

  test("a command without autocomplete options warns nothing", () => {
    const { log, calls } = makeLog();
    const map = pluginCommandMap([loaded(entry(), { commands: [cmd("plain")] })], [], log);
    buildCommandBody("", coreJson, map, log);
    expect(calls.some((l) => l.message.includes("autocomplete"))).toBe(false);
  });

  test("autocompleteOptionPaths: no options is [], a non-array options is [], nesting is walked", () => {
    expect(autocompleteOptionPaths({ name: "x", description: "d", type: 1 } as never)).toEqual([]);
    expect(autocompleteOptionPaths({ name: "x", description: "d", type: 1, options: "nope" } as never)).toEqual([]);
    const nested = {
      name: "x",
      description: "d",
      type: 1,
      options: [
        {
          name: "g",
          description: "d",
          type: 2,
          options: [
            {
              name: "s",
              description: "d",
              type: 1,
              options: [
                { name: "q", description: "d", type: 3, autocomplete: true },
                { name: "r", description: "d", type: 3, autocomplete: false },
              ],
            },
          ],
        },
      ],
    };
    expect(autocompleteOptionPaths(nested as never)).toEqual(["g s q"]);
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

  // #217: `timeoutMs` (pluginTicks' third parameter) is the test seam, the same shape as
  // guardedTick's `watchdogMs`. The 2s `Bun.sleep` sentinel is what a regression that drops the
  // bound looks like -- a check that never settles -- surfaced as a plain "hung" assertion failure
  // rather than a bun-level test timeout.
  const HUNG = (): Promise<void> => new Promise<void>(() => {});
  const settleOrHang = (run: () => Promise<void>) =>
    Promise.race([
      run().then(() => "resolved" as const, (err: unknown) => err),
      Bun.sleep(2_000).then(() => "hung" as const),
    ]);
  const checkFor = (lp: LoadedPlugin, timeoutMs: number, log = makeLog().log) => {
    const checks = pluginTicks([lp], log, timeoutMs);
    expect(checks).toHaveLength(1);
    return checks[0]!;
  };
  // pluginTicks' checks run on every 60s scheduler tick, so a timer left armed after its tick settled
  // would sit dead for up to `ms`, holding the event loop open: spy setTimeout/clearTimeout around
  // `body` and assert every timer armed for `ms` was cleared.
  const expectTimerCleared = async (ms: number, body: () => Promise<void>) => {
    const setSpy = spyOn(globalThis, "setTimeout");
    const clearSpy = spyOn(globalThis, "clearTimeout");
    try {
      await body();
      await Bun.sleep(0); // let the settle's .finally() run
      const armed = setSpy.mock.calls.flatMap((call, i) => (call[1] === ms ? [setSpy.mock.results[i]?.value] : []));
      expect(armed.length).toBeGreaterThanOrEqual(1); // a timer WAS armed for this bound...
      // ...and every one of them was cleared. Identity, not toHaveBeenCalledWith: bun compares timer
      // objects structurally, so that would pass for a clearTimeout of ANY timer.
      for (const handle of armed) expect(clearSpy.mock.calls.some((call) => call[0] === handle)).toBe(true);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  };

  test("a plugin tick that never settles is abandoned after timeoutMs, as a rejection (#217)", async () => {
    const lp = loaded(entry({ name: "wedged" }), { ticks: [{ name: "t", run: HUNG }] }, true);
    const outcome = await settleOrHang(() => checkFor(lp, 20).run());
    expect(outcome).not.toBe("hung"); // the never-settling tick no longer holds its check open
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("plugin tick wedged:t exceeded 20ms");
  });

  test("the running gate still holds -- a not-running plugin's tick is never called, and the flag is read per call (#217)", async () => {
    let started = 0;
    const lp = loaded(entry({ name: "gated" }), { ticks: [{ name: "t", run: () => { started += 1; return HUNG(); } }] }, false);
    const check = checkFor(lp, 20);
    // Gate closed: resolves without calling the tick, which would otherwise never settle and reject.
    expect(await settleOrHang(() => check.run())).toBe("resolved");
    expect(started).toBe(0);
    // Gate open: the same check now calls the tick, and bounds it.
    lp.running = true;
    expect(await settleOrHang(() => check.run())).toBeInstanceOf(Error);
    expect(started).toBe(1);
  });

  // Through runTick, the real consumer (announce.ts): it awaits checks one after another, so without
  // the bound the later plugin's tick sits behind the wedged one for as long as that one hangs.
  test("a hung plugin tick doesn't starve the plugins behind it, and is logged under its own name (#217)", async () => {
    let laterRan = false;
    const wedged = loaded(entry({ name: "wedged" }), { ticks: [{ name: "t", run: HUNG }] }, true);
    const later = loaded(entry({ name: "later" }), { ticks: [{ name: "t", run: async () => { laterRan = true; } }] }, true);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const settled = await Promise.race([
        runTick(pluginTicks([wedged, later], makeLog().log, 20)).then(() => "settled" as const),
        Bun.sleep(2_000).then(() => "hung" as const),
      ]);
      expect(settled).toBe("settled");
      expect(laterRan).toBe(true);
      expect(errorSpy.mock.calls[0]?.[0]).toBe("[tick:wedged:t]");
      expect((errorSpy.mock.calls[0]?.[1] as Error).message).toContain("exceeded");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("a tick that settles in time clears its timer, and the default bound is PLUGIN_TICK_TIMEOUT_MS (#217)", async () => {
    const lp = loaded(entry({ name: "fast" }), { ticks: [{ name: "t", run: async () => {} }] }, true);
    await expectTimerCleared(PLUGIN_TICK_TIMEOUT_MS, async () => {
      const [check] = pluginTicks([lp], makeLog().log); // no third argument: the real default
      await check?.run();
    });
  });

  test("a tick that rejects surfaces its own error at once, not a timeout, and clears its timer (#217)", async () => {
    const boom = new Error("tick blew up");
    const lp = loaded(entry({ name: "boom" }), { ticks: [{ name: "t", run: async () => { throw boom; } }] }, true);
    await expectTimerCleared(60_000, async () => {
      // 60s bound against a 2s sentinel: only the tick's own rejection can settle this in time.
      expect(await settleOrHang(() => checkFor(lp, 60_000).run())).toBe(boom);
    });
  });

  // `TickCheck.run` is typed Promise<void>, but plugin code is only type-asserted (see above) and a
  // plain `await` used to tolerate a bundle that returns nothing.
  test("a tick whose run() returns a plain value still runs, as it did under a bare await (#217)", async () => {
    let started = 0;
    const plain = (() => { started += 1; }) as unknown as () => Promise<void>;
    const lp = loaded(entry({ name: "plain" }), { ticks: [{ name: "t", run: plain }] }, true);
    expect(await settleOrHang(() => checkFor(lp, 20).run())).toBe("resolved");
    expect(started).toBe(1);
  });

  // withTickTimeout's doc comment promises the abandoned call's late settle is dropped, never an
  // unhandled rejection -- this is the test that reads that claim.
  test("an abandoned tick that rejects after its timeout is dropped quietly -- no unhandled rejection (#217)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const late = new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("too late")), 60));
      const lp = loaded(entry({ name: "late" }), { ticks: [{ name: "t", run: () => late }] }, true);
      expect(await settleOrHang(() => checkFor(lp, 20).run())).toBeInstanceOf(Error); // times out first...
      await Bun.sleep(150); // ...then `late` rejects, with nothing listening to it but the helper
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // The in-flight guard (#217). The timeout abandons the WAIT, not the call (cancelling needs an
  // AbortSignal in TickCheck.run -- a contract change), so without the guard the next tick would start a
  // second call on top of the first, still-pending one. A plugin author reading TickCheck's doc
  // reasonably assumes their tick never overlaps itself.
  test("a plugin whose previous tick is still in flight is skipped, not re-entered (#217)", async () => {
    let started = 0;
    const { log, calls } = makeLog();
    const lp = loaded(entry({ name: "stuck" }), { ticks: [{ name: "t", run: () => { started += 1; return HUNG(); } }] }, true);
    const check = checkFor(lp, 20, log);
    expect(await settleOrHang(() => check.run())).toBeInstanceOf(Error); // first call hangs, abandoned at 20ms
    expect(started).toBe(1);
    // Every later tick finds the abandoned call still pending: skipped with a warning, never re-entered.
    expect(await settleOrHang(() => check.run())).toBe("resolved");
    expect(await settleOrHang(() => check.run())).toBe("resolved");
    expect(started).toBe(1); // tick.run() was not called again
    expect(calls.filter((c) => c.level === "warn" && c.message.includes("stuck:t"))).toHaveLength(2);
  });

  test("a plugin that stopped running is skipped silently even while its previous call is still pending (#217)", async () => {
    const { log, calls } = makeLog();
    const lp = loaded(entry({ name: "gone" }), { ticks: [{ name: "t", run: HUNG }] }, true);
    const check = checkFor(lp, 20, log);
    expect(await settleOrHang(() => check.run())).toBeInstanceOf(Error); // the call hangs and is abandoned
    lp.running = false; // e.g. disposePlugins flipped it on the way out
    expect(await settleOrHang(() => check.run())).toBe("resolved");
    expect(calls.filter((c) => c.level === "warn")).toHaveLength(0); // the running gate answers first: no skip warning
  });

  test("a slow tick that eventually settles releases the guard, so the plugin ticks again (#217)", async () => {
    let started = 0;
    // Slow only the first time: 60ms against a 20ms bound, then instant.
    const run = () => (++started === 1 ? Bun.sleep(60).then(() => {}) : Promise.resolve());
    const check = checkFor(loaded(entry({ name: "slow" }), { ticks: [{ name: "t", run }] }, true), 20);
    expect(await settleOrHang(() => check.run())).toBeInstanceOf(Error); // abandoned at 20ms...
    await Bun.sleep(100); // ...the call itself finishes at ~60ms, releasing the guard
    expect(await settleOrHang(() => check.run())).toBe("resolved"); // ticks again, this time in time
    expect(started).toBe(2);
  });

  test("a tick that rejects releases the guard -- it is retried next tick, not skipped for good (#217)", async () => {
    let started = 0;
    const boom = new Error("tick blew up");
    const lp = loaded(entry({ name: "flaky" }), { ticks: [{ name: "t", run: async () => { started += 1; throw boom; } }] }, true);
    const check = checkFor(lp, 60_000);
    expect(await settleOrHang(() => check.run())).toBe(boom);
    expect(await settleOrHang(() => check.run())).toBe(boom); // ran (and failed) again: not skipped
    expect(started).toBe(2);
  });

  test("a tick that throws synchronously releases the guard too (#217)", async () => {
    let started = 0;
    const lp = loaded(entry({ name: "sync" }), { ticks: [{ name: "t", run: () => { started += 1; throw new Error("sync boom"); } }] }, true);
    const check = checkFor(lp, 60_000);
    expect(((await settleOrHang(() => check.run())) as Error).message).toBe("sync boom");
    expect(await settleOrHang(() => check.run())).toBeInstanceOf(Error); // called again, not skipped
    expect(started).toBe(2);
  });

  test("the in-flight guard is per check: a stuck tick doesn't block its siblings, even one with the same name (#217)", async () => {
    let siblingRuns = 0;
    const stuck = loaded(
      entry({ name: "stuck" }),
      { ticks: [{ name: "t", run: HUNG }, { name: "t", run: async () => { siblingRuns += 1; } }] },
      true,
    );
    const other = loaded(entry({ name: "other" }), { ticks: [{ name: "t", run: async () => { siblingRuns += 10; } }] }, true);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const checks = pluginTicks([stuck, other], makeLog().log, 20);
      await runTick(checks); // pass 1: the first stuck:t hangs and is abandoned; its same-named sibling and the other plugin still run
      await runTick(checks); // pass 2: the first stuck:t is skipped; the rest run again
    } finally {
      errorSpy.mockRestore();
    }
    expect(siblingRuns).toBe(22); // (1 + 10) x 2
  });

  // The documented exception to restart.ts's "no announcement is half-posted" (#217): the host stops
  // waiting on a plugin tick that overruns its bound rather than let one hung plugin hold every
  // restart forever, so the tick's critical section closes -- and a pending restart lands -- while
  // the abandoned call is still running. Composes what announce.ts's onTick does (one withCritical
  // around the whole runTick), so this pins pluginTicks' side of the trade-off, not onTick itself.
  test("a plugin tick that overruns the bound lets a pending restart land while its call is still running (#217)", async () => {
    resetRestartState();
    let exited = false;
    let callSettled = false;
    const restoreExit = setExitFn(() => { exited = true; });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const run = async () => {
        requestRestart("update"); // deferred: this tick's critical section is still open
        await Bun.sleep(80);
        callSettled = true;
      };
      const lp = loaded(entry({ name: "slow" }), { ticks: [{ name: "t", run }] }, true);
      await withCritical(() => runTick(pluginTicks([lp], makeLog().log, 20)));
      expect(exited).toBe(true); // the section closed on the abandoned wait, so the deferred restart landed...
      expect(callSettled).toBe(false); // ...while the call was still running
      await Bun.sleep(120);
      expect(callSettled).toBe(true); // (and it does finish on its own afterwards)
    } finally {
      restoreExit();
      logSpy.mockRestore();
      errorSpy.mockRestore();
      resetRestartState();
    }
  });

  test("PLUGIN_TICK_TIMEOUT_MS stays under the 60s scheduler tick (#217)", () => {
    expect(TICK_MS).toBe(60_000); // the "60s TICK_MS" host.ts's doc comments name -- change both together
    expect(PLUGIN_TICK_TIMEOUT_MS).toBe(30_000);
    expect(PLUGIN_TICK_TIMEOUT_MS).toBeLessThan(TICK_MS);
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

describe("routeInteractionByPrefix", () => {
  test("exact split on the first colon", () => {
    expect(routeInteractionByPrefix("wow:realm:pick", ["warbandeer", "wow"])).toBe("wow");
  });

  test("no colon at all -> undefined", () => {
    expect(routeInteractionByPrefix("noColonHere", ["warbandeer", "wow"])).toBeUndefined();
  });

  test("a prefix that matches no known plugin name -> undefined", () => {
    expect(routeInteractionByPrefix("unknown:thing", ["warbandeer", "wow"])).toBeUndefined();
  });

  // Distinguishes an EXACT colon-split from a mere `startsWith` prefix scan: "wowie" is not "wow",
  // even though "wowie:x" starts with the string "wow". Mutation: swapping the exact split for
  // `names.find(n => customId.startsWith(n))` wrongly returns "wow" here.
  test("a name that is a PREFIX of the actual segment (not equal to it) does not match", () => {
    expect(routeInteractionByPrefix("wowie:x", ["wow"])).toBeUndefined();
  });

  // The reverse direction of the case above: the SEGMENT is a strict prefix of a real plugin name
  // ("wo" vs "wow"). Round-1 review flagged this direction as untested by direct execution; the
  // exact split already handles it correctly (routeInteractionByPrefix normalizes list-membership,
  // not a fuzzy match either way), but pin it so both directions are covered, not just one.
  test("a segment that is a strict PREFIX of a real plugin name does not match either", () => {
    expect(routeInteractionByPrefix("wo:x", ["wow"])).toBeUndefined();
  });
});

describe("dispatchPluginInteraction", () => {
  test("a routed interaction reaches the plugin's interactions with the FULL customId, unstripped", async () => {
    const { log } = makeLog();
    let received: string | undefined;
    const lp = loaded(
      entry({ name: "wow" }),
      { interactions: async (i) => { received = i.customId; } },
      true, // running
    );
    const claimed = await dispatchPluginInteraction([lp], fakeInteraction("wow:realm:pick"), log);
    expect(claimed).toBe(true);
    expect(received).toBe("wow:realm:pick"); // mutation: stripping the prefix fails this
  });

  test("a non-running plugin's interactions are not dispatched", async () => {
    const { log } = makeLog();
    let called = false;
    const lp = loaded(
      entry({ name: "wow" }),
      { interactions: async () => { called = true; } },
      false, // NOT running
    );
    const claimed = await dispatchPluginInteraction([lp], fakeInteraction("wow:realm:pick"), log);
    expect(claimed).toBe(false); // mutation: ignoring `running` makes this true and `called` true
    expect(called).toBe(false);
  });

  test("no plugin's prefix matches -> not claimed, nothing throws", async () => {
    const { log } = makeLog();
    const lp = loaded(entry({ name: "wow" }), { interactions: async () => {} }, true);
    const claimed = await dispatchPluginInteraction([lp], fakeInteraction("unrelated:thing"), log);
    expect(claimed).toBe(false);
  });

  test("a plugin with no `interactions` handler at all is not dispatched to, even if running and routed", async () => {
    const { log } = makeLog();
    const lp = loaded(entry({ name: "wow" }), {}, true); // no `interactions` key
    const claimed = await dispatchPluginInteraction([lp], fakeInteraction("wow:x"), log);
    expect(claimed).toBe(false);
  });

  test("a throwing handler is isolated and logged; the NEXT interaction still routes normally", async () => {
    const { log, calls } = makeLog();
    let secondCallReceived: string | undefined;
    const lp = loaded(
      entry({ name: "wow" }),
      {
        interactions: async (i) => {
          if (i.customId === "wow:first") throw new Error("boom");
          secondCallReceived = i.customId;
        },
      },
      true,
    );
    const first = await dispatchPluginInteraction([lp], fakeInteraction("wow:first"), log);
    expect(first).toBe(true); // claimed even though the handler threw
    expect(calls).toEqual([{ level: "error", message: "[plugins] wow interaction failed" }]);

    const second = await dispatchPluginInteraction([lp], fakeInteraction("wow:second"), log);
    expect(second).toBe(true);
    expect(secondCallReceived).toBe("wow:second"); // the throw didn't corrupt anything for the next call
  });

  test("a throwing handler gets a best-effort ephemeral reply IF it hadn't already replied/deferred", async () => {
    const { log } = makeLog();
    let replyCalledWith: unknown;
    const lp = loaded(entry({ name: "wow" }), { interactions: async () => { throw new Error("boom"); } }, true);
    const interaction = fakeInteraction("wow:x", {
      reply: async (opts) => { replyCalledWith = opts; },
    });
    await dispatchPluginInteraction([lp], interaction, log);
    expect(replyCalledWith).toMatchObject({ content: expect.any(String) });
  });

  test("a throwing handler that ALREADY replied/deferred gets no extra reply attempt", async () => {
    const { log } = makeLog();
    let replyCalls = 0;
    const lp = loaded(entry({ name: "wow" }), { interactions: async () => { throw new Error("boom"); } }, true);
    const interaction = fakeInteraction("wow:x", {
      replied: true,
      reply: async () => { replyCalls++; },
    });
    await dispatchPluginInteraction([lp], interaction, log);
    // Mutation: dropping the replied/deferred guard would call reply() here too.
    expect(replyCalls).toBe(0);
  });

  // #185 acceptance bullet 3: a plugin built against the PRE-#185 contract (no `interactions`
  // field at all -- exactly the published shape of warbandeer 1.x and wow 1.0.0, both of which
  // declare only `commands` and `activate()`) must load, activate, and safely no-op on interaction
  // dispatch against the new host -- `interactions` being optional is what makes this compatible,
  // no HOST_API_VERSION bump.
  test("a pre-#185 plugin shape (commands + activate, no interactions) loads/activates/no-ops safely", async () => {
    const { log } = makeLog();
    const warbandeerLike: Plugin = { commands: [cmd("link"), cmd("unlink")], activate: async () => {} };
    const installed: InstalledPlugin[] = [{ entry: entry({ name: "warbandeer" }), version: "1.1.0", bundlePath: "/w" }];
    const makeHost = (e: PluginIndexEntry): HostApi =>
      createHostApi({ entry: e, processEnv: {}, dataDir: "/d", baseLog: log, storage: realStorage, announce: async () => {} });
    const { loaded: loadedPlugins } = await loadPlugins(installed, makeHost, async () => ({ createPlugin: () => warbandeerLike }), log);
    await activatePlugins(loadedPlugins, log);
    expect(loadedPlugins[0]!.running).toBe(true);
    // A button whose customId happens to be prefixed "warbandeer:" still resolves to this plugin by
    // NAME (routing doesn't require `interactions` to exist) but is safely dropped, not thrown.
    const claimed = await dispatchPluginInteraction(loadedPlugins, fakeInteraction("warbandeer:link-confirm"), log);
    expect(claimed).toBe(false);
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
  //
  // #255: this used to prove concurrency by WALL CLOCK — three wedged plugins raced against a
  // hand-tuned window between "concurrent" (~100ms) and "sequential" (~300ms), an 80-120ms margin a
  // loaded machine slips past (observed failing at 237ms isolated and 550ms under load, then
  // passing 57 times in a row — a flake that cost a review round every time it appeared, with
  // nothing in the actual diff to explain it). Proved STRUCTURALLY instead: each fake dispose
  // records when it was CALLED, and every plugin's dispose must have been called within one turn of
  // the event loop — a sequential implementation calls only the first plugin's dispose in that
  // window, and cannot reach the second before the first plugin's own timeout fires. No elapsed-time
  // assertion anywhere, so no machine speed can fail this test the property doesn't depend on.
  // timeoutMs is 500 (not 100) so that even a badly starved `Bun.sleep(0)` cannot resume after a
  // sequential loop's first 100ms-scale timeout would already have fired.
  test("multiple wedged plugins are disposed CONCURRENTLY — total time is one timeout, not the sum", async () => {
    const { log } = makeLog();
    const calls: string[] = [];
    const wedge = (name: string): Plugin["dispose"] => () => {
      calls.push(name);
      return new Promise<void>(() => {}); // never settles — "wedged"
    };
    const a = loaded(entry({ name: "a" }), { dispose: wedge("a") }, true);
    const b = loaded(entry({ name: "b" }), { dispose: wedge("b") }, true);
    const c = loaded(entry({ name: "c" }), { dispose: wedge("c") }, true);
    const disposePromise = disposePlugins([a, b, c], log, 500);
    await Bun.sleep(0); // one turn of the event loop — enough for every CONCURRENT dispose to start
    expect([...calls].sort()).toEqual(["a", "b", "c"]); // a sequential loop could only have reached "a" by now
    const settled = await Promise.race([
      disposePromise.then(() => "settled" as const),
      Bun.sleep(5_000).then(() => "hung" as const), // a generous hang guard, not a timing assertion
    ]);
    expect(settled).toBe("settled");
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

  // #225: a plugin taken out of PLUGINS= no longer loses its state.json entry.
  test("a plugin taken out of PLUGINS keeps its entry as enabled: false, with its pin and its bookkeeping", () => {
    const prevOff: PluginStateFile = {
      hostApiVersion: 1,
      writtenAt: "",
      plugins: [
        {
          name: "p",
          enabled: true,
          installedVersion: "1.0.0",
          configured: false,
          missingEnv: ["P_REQ"],
          active: true,
          notifiedVersion: "0.9.0",
          skippedVersion: "0.8.0",
          remindAt: "2026-09-10T00:00:00.000Z",
          scheduled: { version: "1.1.0", at: "2026-09-11T00:00:00.000Z", requestedBy: "u1" },
        },
      ],
    };
    const state = buildPluginStateFile({
      selected: [],
      installed: [],
      installSkips: {},
      fallbacks: {},
      loaded: [],
      loadErrors: {},
      processEnv: {},
      previous: prevOff,
      now: new Date("2026-09-04T00:00:00.000Z"),
    });
    expect(state.plugins).toHaveLength(1);
    expect(state.plugins[0]).toEqual({
      name: "p",
      enabled: false,
      active: false,
      configured: false,
      missingEnv: ["P_REQ"],
      installedVersion: "1.0.0",
      notifiedVersion: "0.9.0",
      skippedVersion: "0.8.0",
      remindAt: "2026-09-10T00:00:00.000Z",
      scheduled: { version: "1.1.0", at: "2026-09-11T00:00:00.000Z", requestedBy: "u1" },
    });
  });

  test("an off entry drops what only a boot can know: targetVersion, availableVersion and error", () => {
    const prevWithTransients: PluginStateFile = {
      hostApiVersion: 1,
      writtenAt: "",
      plugins: [
        {
          name: "p",
          enabled: true,
          installedVersion: "1.0.0",
          targetVersion: "1.1.0",
          availableVersion: "1.1.0",
          error: "boom",
          configured: true,
          missingEnv: [],
          active: true,
        },
      ],
    };
    const state = buildPluginStateFile({
      selected: [],
      installed: [],
      installSkips: {},
      fallbacks: {},
      loaded: [],
      loadErrors: {},
      processEnv: {},
      previous: prevWithTransients,
      now: new Date("2026-09-04T00:00:00.000Z"),
    });
    expect(state.plugins[0]?.targetVersion).toBeUndefined();
    expect(state.plugins[0]?.availableVersion).toBeUndefined();
    expect(state.plugins[0]?.error).toBeUndefined();
    expect(state.plugins[0]?.installedVersion).toBe("1.0.0");
  });

  test("off entries follow the selected ones in the previous file's order, and a plugin in both is written once, as selected", () => {
    const mkPrev = (name: string) => ({ name, enabled: false, configured: true, missingEnv: [], active: false, installedVersion: "1.0.0" });
    const prevThree: PluginStateFile = { hostApiVersion: 1, writtenAt: "", plugins: [mkPrev("a"), mkPrev("b"), mkPrev("c")] };
    const eB = entry({ name: "b", version: "1.0.0" });
    const state = buildPluginStateFile({
      selected: [{ name: "b", entry: eB }],
      installed: [{ entry: eB, version: "1.0.0", bundlePath: "/a" }],
      installSkips: {},
      fallbacks: {},
      loaded: [loaded(eB, { commands: [] }, true)],
      loadErrors: {},
      processEnv: {},
      previous: prevThree,
      now: new Date("2026-09-04T00:00:00.000Z"),
    });
    expect(state.plugins.map((p) => p.name)).toEqual(["b", "a", "c"]);
    expect(state.plugins).toHaveLength(3);
    expect(state.plugins[0]?.enabled).toBe(true);
  });

  test("an entry that was already off is carried again unchanged", () => {
    const alreadyOff = { name: "p", enabled: false, installedVersion: "1.0.0", configured: true, missingEnv: [], active: false, skippedVersion: "0.8.0" };
    const prevOff: PluginStateFile = { hostApiVersion: 1, writtenAt: "", plugins: [alreadyOff] };
    const state = buildPluginStateFile({
      selected: [],
      installed: [],
      installSkips: {},
      fallbacks: {},
      loaded: [],
      loadErrors: {},
      processEnv: {},
      previous: prevOff,
      now: new Date("2026-09-04T00:00:00.000Z"),
    });
    expect(state.plugins).toEqual([alreadyOff]);
  });

  test("a duplicated name in a corrupt previous file is carried once", () => {
    const prevDup: PluginStateFile = {
      hostApiVersion: 1,
      writtenAt: "",
      plugins: [
        { name: "p", enabled: true, installedVersion: "1.0.0", configured: true, missingEnv: [], active: false },
        { name: "p", enabled: true, installedVersion: "2.0.0", configured: true, missingEnv: [], active: false },
      ],
    };
    const state = buildPluginStateFile({
      selected: [],
      installed: [],
      installSkips: {},
      fallbacks: {},
      loaded: [],
      loadErrors: {},
      processEnv: {},
      previous: prevDup,
      now: new Date("2026-09-04T00:00:00.000Z"),
    });
    expect(state.plugins).toHaveLength(1);
    expect(state.plugins[0]?.installedVersion).toBe("1.0.0");
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

  // #222: the producer and the consumer of the version pins, joined through a real file. selectPlugins
  // can only keep a plugin that is last-good — rather than explicitly pinned, which needs no state — past
  // an index host-API bump if the state.json a boot WROTE carries the installedVersion the NEXT boot's
  // pinsFromState reads back; a unit test of either half passes while the join between them is broken.
  describe("the state.json pins that selectPlugins reads back (#222)", () => {
    const bumped: PluginIndex = {
      schemaVersion: 1,
      generatedAt: "2026-09-20T00:00:00.000Z",
      plugins: [entry({ name: "wow", version: "2.0.0", hostApiVersion: 2 })], // the bot is host API 1
    };
    const HOST_API_SKIP = "needs host API v2, this bot is v1";
    const wowState = (over: Record<string, unknown> = {}) => ({
      name: "wow", enabled: true, installedVersion: "1.5.0", configured: true, missingEnv: [], active: true, ...over,
    });

    test("a boot that came up on 1.5.0 keeps the plugin selectable once the index moves to 2.0.0 / host API 2", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pluginstate-test-"));
      try {
        const v150 = entry({ name: "wow", version: "1.5.0" });
        await writePluginState({
          dataDir: dir,
          storage: realStorage,
          selected: [{ name: "wow", entry: v150 }],
          installed: [{ entry: v150, version: "1.5.0", bundlePath: "/a" }],
          installSkips: {},
          fallbacks: {},
          loaded: [loaded(v150, { commands: [] }, true)],
          loadErrors: {},
          processEnv: {},
          previous: await readPluginState(dir, realStorage),
          now: () => new Date("2026-09-04T00:00:00.000Z"),
        });

        // the next boot reads its pins exactly as index.ts does
        const pins = pinsFromState(await readPluginState(dir, realStorage));
        expect(pins.get("wow")).toEqual({ installedVersion: "1.5.0" });
        expect(selectPlugins(bumped, [{ name: "wow" }], 1, [], pins)[0]!.skipped).toBeUndefined();

        // no state.json at all (a fresh install) has nothing to honor, so the same bump still skips it
        const fresh = pinsFromState(await readPluginState(join(dir, "elsewhere"), realStorage));
        expect(selectPlugins(bumped, [{ name: "wow" }], 1, [], fresh)[0]!.skipped).toBe(HOST_API_SKIP);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // A bot that already booted under the bug had the plugin skipped and rewrote state.json. The last-good
    // must survive that write, or the fix would only help bots that were never hit. (buildPluginStateFile
    // records an explicit PLUGINS pin as installedVersion in preference to the previous one — host.ts:340 —
    // so this holds when nothing pins the plugin explicitly, which is what recovery is about.)
    test("a boot that SKIPPED the plugin (the pre-#222 outcome) keeps its last-good installedVersion when nothing pins it explicitly, so the next boot recovers it", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pluginstate-test-"));
      try {
        await writeJsonAtomic(join(dir, "plugins", "state.json"), { hostApiVersion: 1, writtenAt: "old", plugins: [wowState()] });
        await writePluginState({
          dataDir: dir,
          storage: realStorage,
          selected: [{ name: "wow", entry: bumped.plugins[0], skipped: HOST_API_SKIP }],
          installed: [],
          installSkips: {},
          fallbacks: {},
          loaded: [],
          loadErrors: {},
          processEnv: {},
          previous: await readPluginState(dir, realStorage),
          now: () => new Date("2026-09-05T00:00:00.000Z"),
        });

        const written = await readPluginState(dir, realStorage);
        expect(written.plugins[0]).toMatchObject({ name: "wow", installedVersion: "1.5.0", active: false, error: HOST_API_SKIP });
        const pins = pinsFromState(written);
        expect(selectPlugins(bumped, [{ name: "wow" }], 1, [], pins)[0]!.skipped).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // The join with no other test: selection ASSUMES which versions installPlugins will reach for. If a plugin
    // that selection kept ever had its installer ask the registry for the incompatible current, the fix would
    // load the very bundle the skip exists to refuse. A fetch that always 404s records every version the
    // installer reaches for, fallbacks included. This table pins the exact versions for representative shapes;
    // the grid test below proves the safety property across every combination in it.
    test("for representative kept shapes, the installer reaches for exactly the versions selection assumed", async () => {
      type Pins = { installedVersion?: string; targetVersion?: string };
      const dir = mkdtempSync(join(tmpdir(), "pluginstate-test-"));
      try {
        const cases: { label: string; pinned?: string; pins?: Pins; reaches: string[] }[] = [
          { label: "explicit pin", pinned: "1.5.0", reaches: ["1.5.0"] },
          { label: "explicit pin over a state entry naming the current", pinned: "1.5.0", pins: { installedVersion: "2.0.0", targetVersion: "2.0.0" }, reaches: ["1.5.0"] },
          { label: "last-good only", pins: { installedVersion: "1.5.0" }, reaches: ["1.5.0"] },
          { label: "target only", pins: { targetVersion: "1.4.0" }, reaches: ["1.4.0"] },
          { label: "target, then its last-good fallback", pins: { installedVersion: "1.5.0", targetVersion: "1.4.0" }, reaches: ["1.4.0", "1.5.0"] },
        ];
        for (const c of cases) {
          const configured = c.pinned === undefined ? [{ name: "wow" }] : [{ name: "wow", version: c.pinned }];
          const selected = selectPlugins(bumped, configured, 1, [], new Map<string, Pins>(c.pins ? [["wow", c.pins]] : []));
          expect(selected[0]!.skipped, c.label).toBeUndefined();
          const requested: string[] = [];
          await installPlugins(selected, dir, c.pins ? { wow: c.pins } : {}, {
            fetch: async (url) => {
              requested.push(url.split("/").pop()!);
              return new Response("not found", { status: 404 });
            },
            extract: async () => {},
            now: () => 0,
            log: makeLog().log,
          });
          expect(requested, c.label).toEqual(c.reaches);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Safety across a grid, not a hand-picked table: a change that widens the keep rule along ANY of these
    // dimensions (an equal or newer version counted as older, "some" instead of "every" candidate, no candidate
    // at all, a last-good fallback that is ignored) keeps a plugin whose installer then asks for the
    // incompatible current — and fails here, whichever shape it happens to break.
    test("across a grid of pins and state, whenever selection keeps a plugin the installer never reaches for the current or anything newer", async () => {
      type Pins = { installedVersion?: string; targetVersion?: string };
      const dir = mkdtempSync(join(tmpdir(), "pluginstate-test-"));
      try {
        const older = new Set(["1.4.0", "1.5.0"]); // every grid value below the incompatible current, 2.0.0
        let kept = 0;
        let skipped = 0;
        for (const pinned of [undefined, "1.5.0", "2.0.0", "2.5.0"]) {
          for (const installedVersion of [undefined, "1.4.0", "1.5.0", "2.0.0", "3.0.0"]) {
            for (const targetVersion of [undefined, "1.4.0", "2.0.0", "3.0.0"]) {
              const pins: Pins = {};
              if (installedVersion !== undefined) pins.installedVersion = installedVersion;
              if (targetVersion !== undefined) pins.targetVersion = targetVersion;
              const label = `PLUGINS pin=${pinned} installedVersion=${installedVersion} targetVersion=${targetVersion}`;
              const configured = pinned === undefined ? [{ name: "wow" }] : [{ name: "wow", version: pinned }];
              const selected = selectPlugins(bumped, configured, 1, [], new Map<string, Pins>([["wow", pins]]));
              if (selected[0]!.skipped !== undefined) {
                skipped++;
                continue;
              }
              kept++;
              const requested: string[] = [];
              await installPlugins(selected, dir, { wow: pins }, {
                fetch: async (url) => {
                  requested.push(url.split("/").pop()!);
                  return new Response("not found", { status: 404 });
                },
                extract: async () => {},
                now: () => 0,
                log: makeLog().log,
              });
              expect(requested.length, label).toBeGreaterThan(0);
              for (const version of requested) expect(older.has(version), `${label} -> the installer reached for ${version}`).toBe(true);
            }
          }
        }
        expect(kept).toBeGreaterThan(0); // the grid is not vacuous in either direction
        expect(skipped).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // #225's actual scenario, through real files: a plugin turned off for one boot and back on must
    // come back on its PIN (1.1.0), never the newer cached 1.2.0 a hand-lowered pin moved away from —
    // the same silent-upgrade guard #104's update-fallback already has, extended to the off/on cycle.
    // The trap half documents the pre-#225 rule with a hand-written state.json, not by mutating the
    // code, so this test keeps working as its own regression guard even after the fix is old news.
    test("a plugin turned off for a boot and on again comes back on its pinned version, not the newest cached one (#225)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pluginstate-test-"));
      try {
        // two cached version dirs: 1.2.0 is newer on disk, 1.1.0 is the operator's actual pin.
        mkdirSync(join(dir, "plugins", "p", "1.1.0", "dist"), { recursive: true });
        writeFileSync(join(dir, "plugins", "p", "1.1.0", "dist", "plugin.js"), "v1.1.0");
        mkdirSync(join(dir, "plugins", "p", "1.2.0", "dist"), { recursive: true });
        writeFileSync(join(dir, "plugins", "p", "1.2.0", "dist", "plugin.js"), "v1.2.0");

        const pinsAsIndexTsDoes = (state: PluginStateFile) =>
          Object.fromEntries(state.plugins.map((p) => [p.name, { installedVersion: p.installedVersion, targetVersion: p.targetVersion }]));

        const e110 = entry({ name: "p", version: "1.1.0" });
        // Boot 1: p selected, comes up on 1.1.0.
        await writePluginState({
          dataDir: dir,
          storage: realStorage,
          selected: [{ name: "p", entry: e110 }],
          installed: [{ entry: e110, version: "1.1.0", bundlePath: "/a" }],
          installSkips: {},
          fallbacks: {},
          loaded: [loaded(e110, { commands: [] }, true)],
          loadErrors: {},
          processEnv: {},
          previous: await readPluginState(dir, realStorage),
          now: () => new Date("2026-09-01T00:00:00.000Z"),
        });

        // Boot 2: p taken out of PLUGINS= — nothing selected.
        await writePluginState({
          dataDir: dir,
          storage: realStorage,
          selected: [],
          installed: [],
          installSkips: {},
          fallbacks: {},
          loaded: [],
          loadErrors: {},
          processEnv: {},
          previous: await readPluginState(dir, realStorage),
          now: () => new Date("2026-09-02T00:00:00.000Z"),
        });
        const boot2State = await readPluginState(dir, realStorage);
        expect(boot2State.plugins[0]).toMatchObject({ name: "p", enabled: false, installedVersion: "1.1.0" });

        // Boot 3: p turned back on — pins built exactly as index.ts:137-139 does.
        const throwingFetch = async (): Promise<Response> => {
          throw new Error("must not fetch — the pinned version is already cached");
        };
        const result = await installPlugins([{ name: "p", entry: e110 }], dir, pinsAsIndexTsDoes(boot2State), {
          fetch: throwingFetch,
          extract: async () => {},
          now: () => 0,
          log: makeLog().log,
        });
        expect(result.installed[0]?.version).toBe("1.1.0");
        expect(result.skips).toEqual({});

        // The pre-#225 trap: boot 2's state.json had NO entry for p at all (hand-written here, not by
        // mutating buildPluginStateFile, so this documents the trap independently of the fix above).
        await writeJsonAtomic(join(dir, "plugins", "state.json"), { hostApiVersion: 1, writtenAt: "old", plugins: [] });
        const oldRuleState = await readPluginState(dir, realStorage);
        const trapResult = await installPlugins([{ name: "p", entry: e110 }], dir, pinsAsIndexTsDoes(oldRuleState), {
          fetch: throwingFetch,
          extract: async () => {},
          now: () => 0,
          log: makeLog().log,
        });
        expect(trapResult.installed[0]?.version).toBe("1.2.0"); // newestCachedVersion — the trap
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
