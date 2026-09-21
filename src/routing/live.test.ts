import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, type Client, type RESTPostAPIChatInputApplicationCommandsJSONBody as CommandJson } from "discord.js";
import type { PluginCommand, PluginIndexEntry } from "../plugins/contract";
import type { PluginCommandMap } from "../plugins/host";
import { discoveryPath, type PluginSummary } from "./discovery";
import { applyRouting, initRouting, refreshDiscovery, resetRoutingForTest, type RoutingContext } from "./live";
import type { DiscoveryFile } from "./model";
import { mutateRouting, routingPath } from "./store";

const HOME = "111111111111111111";
const OTHER = "222222222222222222";
const APP = "900000000000000000";

const CORE = ["report", "update", "plugins"];
const MUSIC = ["setlist", "spotify"];
const WOW = ["dmf"];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "live-test-"));
});
afterEach(() => {
  resetRoutingForTest();
  rmSync(dir, { recursive: true, force: true });
});

function command(name: string): CommandJson {
  return { name, description: `the ${name} command` };
}

interface FakeChannel {
  id: string;
  name: string;
  type: ChannelType;
  rawPosition: number;
  permissionsFor: () => { has: () => boolean };
}

function textChannel(id: string, name: string, position: number): FakeChannel {
  return { id, name, type: ChannelType.GuildText, rawPosition: position, permissionsFor: () => ({ has: () => true }) };
}

/** A Client whose caches the test can change afterwards. */
function fakeWorld() {
  const channelCaches = new Map<string, Map<string, FakeChannel>>();
  const guilds = new Map<string, { id: string; name: string; channels: { cache: Map<string, FakeChannel> } }>();
  const addGuild = (id: string, name: string, channels: FakeChannel[]) => {
    const cache = new Map(channels.map((c) => [c.id, c]));
    channelCaches.set(id, cache);
    guilds.set(id, { id, name, channels: { cache } });
  };
  addGuild(HOME, "Home", [textChannel("1001", "general", 1)]);
  addGuild(OTHER, "Other", [textChannel("2001", "spotify", 1), textChannel("2002", "chat", 2)]);
  const client = { user: { id: APP, username: "Setlist Bot" }, guilds: { cache: guilds } } as unknown as Client<true>;
  return { client, guilds, addChannel: (guildId: string, c: FakeChannel) => channelCaches.get(guildId)!.set(c.id, c) };
}

function commandWorld(prefix = "") {
  const map: PluginCommandMap = new Map();
  for (const bare of MUSIC) map.set(bare, { entry: { name: "music" } as PluginIndexEntry, command: { name: bare } as PluginCommand });
  for (const bare of WOW) map.set(bare, { entry: { name: "wow" } as PluginIndexEntry, command: { name: bare } as PluginCommand });
  const fullBody = [...CORE, ...MUSIC, ...WOW].map((bare) => command(`${prefix}${bare}`));
  const plugins: PluginSummary[] = [
    { name: "music", commands: MUSIC.map((b) => `${prefix}${b}`), posts: false },
    { name: "wow", commands: WOW.map((b) => `${prefix}${b}`), posts: true },
  ];
  return { map, fullBody, plugins };
}

type Put = { route: string; body: CommandJson[] };

function harness(over: Partial<RoutingContext> & { failures?: Record<string, unknown>; onPut?: (route: string) => Promise<void> } = {}) {
  const world = fakeWorld();
  const cw = commandWorld(over.prefix ?? "");
  const puts: Put[] = [];
  const logs = { log: [] as string[], warn: [] as string[], error: [] as string[] };
  let tick = 0;
  const failures = over.failures ?? {};
  const ctx: RoutingContext = {
    client: world.client,
    put: async (route, body) => {
      puts.push({ route, body });
      await over.onPut?.(route);
      if (Object.hasOwn(failures, route)) throw failures[route];
      return undefined;
    },
    appId: APP,
    botUsername: "Setlist Bot",
    dataDir: dir,
    homeGuildId: HOME,
    prefix: "",
    fullBody: cw.fullBody,
    commandMap: cw.map,
    plugins: cw.plugins,
    now: () => new Date(Date.UTC(2026, 8, 21, 12, 0, tick++)),
    log: {
      log: (...a: unknown[]) => logs.log.push(a.map(String).join(" ")),
      warn: (...a: unknown[]) => logs.warn.push(a.map(String).join(" ")),
      error: (...a: unknown[]) => logs.error.push(a.map(String).join(" ")),
    },
    ...over,
  };
  delete (ctx as { failures?: unknown }).failures;
  delete (ctx as { onPut?: unknown }).onPut;
  return { ctx, world, cw, puts, logs };
}

const guildRoute = (id: string) => `/applications/${APP}/guilds/${id}/commands`;
const readDiscovery = (): DiscoveryFile => JSON.parse(readFileSync(discoveryPath(dir), "utf8"));
const names = (body: readonly CommandJson[]) => body.map((c) => c.name);

async function placeMusicInOther(): Promise<void> {
  await mutateRouting(dir, (c) => ({ ...c, plugins: { music: { servers: { [OTHER]: { commands: "all" } } } } }));
}

describe("applyRouting", () => {
  test("boot with no routing: one put, discovery written, single mode reported", async () => {
    const h = harness();
    initRouting(h.ctx);
    const result = await applyRouting("boot");

    // Reported as single -- which is what makes index.ts print today's `Registered N slash commands`.
    expect(result.mode).toBe("single");
    // Exactly today's call: one PUT, to the home guild's commands, with the full body untouched.
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]!.route).toBe(guildRoute(HOME));
    expect(h.puts[0]!.body).toEqual(h.cw.fullBody);
    // Nothing is logged here in single mode: index.ts prints its own line.
    expect(h.logs.log).toEqual([]);
    expect(h.logs.error).toEqual([]);
    // Discovery is written, with the one registration against the home server and nothing elsewhere.
    const file = readDiscovery();
    expect(file.guilds.find((g) => g.id === HOME)!.commands).toEqual({ registered: h.cw.fullBody.length, at: result.results[0]!.at });
    expect(file.guilds.find((g) => g.id === OTHER)!.commands).toBeNull();
    // And reading the routing file that is not there created nothing.
    expect(readdirSync(dir)).toEqual(["discovery.json"]);
  });

  test("boot with no routing and no home server registers globally, as before", async () => {
    const h = harness({ homeGuildId: undefined });
    initRouting(h.ctx);
    const result = await applyRouting("boot");
    expect(result.mode).toBe("single");
    expect(h.puts.map((p) => p.route)).toEqual([`/applications/${APP}/commands`]);
    expect(h.puts[0]!.body).toEqual(h.cw.fullBody);
    expect(result.results.map((r) => r.guildId)).toEqual(["global"]);
    expect(readDiscovery().homeGuildId).toBeNull();
  });

  test("a routing file that places nobody, or is corrupt, is still today's single call", async () => {
    // A file that names no plugin at all...
    await mutateRouting(dir, (c) => ({ ...c, updatedBy: "someone" }));
    const a = harness();
    initRouting(a.ctx);
    expect((await applyRouting("boot")).mode).toBe("single");
    expect(a.puts.map((p) => p.route)).toEqual([guildRoute(HOME)]);

    // ...and one that will not even parse (it is moved aside and read as fresh).
    resetRoutingForTest();
    writeFileSync(routingPath(dir), "{ not json");
    const b = harness();
    initRouting(b.ctx);
    const originalError = console.error;
    console.error = () => {};
    try {
      expect((await applyRouting("boot")).mode).toBe("single");
    } finally {
      console.error = originalError;
    }
    expect(b.puts.map((p) => p.route)).toEqual([guildRoute(HOME)]);
    expect(b.puts[0]!.body).toEqual(b.cw.fullBody);
  });

  test("with a prefix, single mode still sends the full prefixed body untouched", async () => {
    const h = harness({ prefix: "r_" });
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(names(h.puts[0]!.body)).toEqual(["r_report", "r_update", "r_plugins", "r_setlist", "r_spotify", "r_dmf"]);
  });

  test("boot with routing: one put per server, discovery carries each result", async () => {
    await placeMusicInOther();
    const h = harness();
    initRouting(h.ctx);
    const result = await applyRouting("boot");

    expect(result.mode).toBe("routed");
    // Servers in name order: Home, then Other. music lives in Other; wow, unplaced, at home.
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(OTHER)]);
    expect(names(h.puts[0]!.body)).toEqual([...CORE, ...WOW]);
    expect(names(h.puts[1]!.body)).toEqual([...CORE, ...MUSIC]);
    // Discovery, written AFTER registering, carries what each server was told.
    const file = readDiscovery();
    expect(file.guilds.map((g) => [g.id, g.commands?.registered, g.commands?.error])).toEqual([
      [HOME, CORE.length + WOW.length, undefined],
      [OTHER, CORE.length + MUSIC.length, undefined],
    ]);
    expect(result.results.map((r) => r.guildId)).toEqual([HOME, OTHER]);
    // One line for the run, in ASCII, naming each server and how many commands it got.
    expect(h.logs.log).toEqual([`Registered commands in 2 servers (Home: ${CORE.length + WOW.length}, Other: ${CORE.length + MUSIC.length})`]);
    expect(h.logs.error).toEqual([]);
  });

  test("routed mode finds each command's owner through COMMAND_PREFIX", async () => {
    await placeMusicInOther();
    const h = harness({ prefix: "r_" });
    initRouting(h.ctx);
    await applyRouting("boot");
    // Every registered name carries the prefix; the owner is found by stripping it, so music's
    // commands still go only to Other and wow's (unplaced) only to Home.
    expect(names(h.puts[0]!.body)).toEqual(["r_report", "r_update", "r_plugins", "r_dmf"]);
    expect(names(h.puts[1]!.body)).toEqual(["r_report", "r_update", "r_plugins", "r_setlist", "r_spotify"]);
  });

  test("a refusal in one server is recorded against it in discovery and the others are registered", async () => {
    await placeMusicInOther();
    const refusal = Object.assign(new Error("Missing Access"), { code: 50001 });
    const h = harness({ failures: { [guildRoute(HOME)]: refusal } });
    initRouting(h.ctx);
    const result = await applyRouting("boot");

    // It did not throw, and it did not stop at the first refusal.
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(OTHER)]);
    const file = readDiscovery();
    expect(file.guilds.find((g) => g.id === HOME)!.commands).toEqual({ registered: 0, error: "Missing Access (50001)", at: result.results[0]!.at });
    expect(file.guilds.find((g) => g.id === OTHER)!.commands!.error).toBeUndefined();
    expect(file.guilds.find((g) => g.id === OTHER)!.commands!.registered).toBe(CORE.length + MUSIC.length);
    // The line counts only the servers that took it; the refusal has its own line.
    expect(h.logs.log).toEqual([`Registered commands in 1 server (Other: ${CORE.length + MUSIC.length})`]);
    expect(h.logs.error).toEqual([`[routing] couldn't register commands in Home (${HOME}): Missing Access (50001)`]);
  });

  test("routed mode with no home server empties the global scope, and a failure there is logged", async () => {
    await placeMusicInOther();
    const globalRoute = `/applications/${APP}/commands`;
    const h = harness({ homeGuildId: undefined, failures: { [globalRoute]: new Error("nope") } });
    initRouting(h.ctx);
    const result = await applyRouting("boot");
    expect(h.puts.at(-1)).toEqual({ route: globalRoute, body: [] });
    expect(result.mode).toBe("routed");
    expect(h.logs.error).toEqual(["[routing] couldn't empty the global command list, so commands may show twice: Error: nope"]);
  });

  test("routed mode with the bot in no servers registers nothing and still writes discovery", async () => {
    await placeMusicInOther();
    const h = harness();
    h.world.guilds.clear();
    initRouting(h.ctx);
    const result = await applyRouting("boot");
    expect(h.puts).toEqual([]);
    expect(result).toEqual({ mode: "routed", results: [] });
    expect(readDiscovery().guilds).toEqual([]);
    expect(h.logs.log).toEqual(["Registered commands in 0 servers"]);
  });

  test("a server the bot can read no channels in is still registered in, with an empty channel list", async () => {
    await placeMusicInOther();
    const h = harness();
    h.world.guilds.get(OTHER)!.channels.cache.clear();
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(OTHER)]);
    expect(readDiscovery().guilds.find((g) => g.id === OTHER)!.channels).toEqual([]);
  });

  test("two applyRouting calls never interleave", async () => {
    // Each put waits, so an unserialised second call would reach its own put while the first is still
    // in flight -- before the first has written discovery.json. Serialised, the second's put comes
    // strictly after the first's discovery write.
    const sawDiscovery: boolean[] = [];
    const h = harness({
      onPut: async () => {
        sawDiscovery.push(existsSync(discoveryPath(dir)));
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    initRouting(h.ctx);
    const first = applyRouting("first");
    const second = applyRouting("second");
    const results = await Promise.all([first, second]);
    expect(sawDiscovery).toEqual([false, true]);
    expect(h.puts).toHaveLength(2);
    expect(results.map((r) => r.mode)).toEqual(["single", "single"]);
  });

  test("a single-mode failure is rethrown after discovery records it", async () => {
    const refusal = Object.assign(new Error("Missing Access"), { code: 50001 });
    const h = harness({ failures: { [guildRoute(HOME)]: refusal } });
    initRouting(h.ctx);
    // Rethrown as it was, so index.ts's own catch (and its long operator message) is reached...
    await expect(applyRouting("boot")).rejects.toBe(refusal);
    // ...but only after the failure was written where the panel can see it.
    expect(readDiscovery().guilds.find((g) => g.id === HOME)!.commands).toEqual({
      registered: 0,
      error: "Missing Access (50001)",
      at: expect.any(String),
    });
    // Single mode logs nothing of its own on failure: that is index.ts's catch.
    expect(h.logs.error).toEqual([]);
  });

  test("a failed run does not stop the ones queued behind it", async () => {
    const refusal = new Error("Missing Access");
    const h = harness({ failures: { [guildRoute(HOME)]: refusal } });
    initRouting(h.ctx);
    const first = applyRouting("first");
    const second = applyRouting("second");
    await expect(first).rejects.toBe(refusal);
    await expect(second).rejects.toBe(refusal); // it ran, and failed the same way -- it was not skipped
    expect(h.puts).toHaveLength(2);
  });

  test("a discovery write failure is logged, not thrown", async () => {
    // A data directory that is a path under a regular file cannot be created.
    const file = join(dir, "not-a-directory");
    writeFileSync(file, "x");
    const h = harness({ dataDir: join(file, "data") });
    initRouting(h.ctx);
    const result = await applyRouting("boot");
    // The registration itself went ahead and its result is returned...
    expect(h.puts).toHaveLength(1);
    expect(result.mode).toBe("single");
    // ...and the write failure was said out loud, naming what was being done.
    expect(h.logs.error).toHaveLength(1);
    expect(h.logs.error[0]).toContain("writing discovery.json failed (boot)");
  });

  test("a client whose servers cannot be read does not stop today's registration", async () => {
    const h = harness();
    const broken = { user: h.world.client.user, get guilds(): never { throw new Error("cache exploded"); } } as unknown as Client<true>;
    initRouting({ ...h.ctx, client: broken });
    const result = await applyRouting("boot");
    expect(result.mode).toBe("single");
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME)]);
    expect(h.puts[0]!.body).toEqual(h.cw.fullBody);
    expect(h.logs.error[0]).toContain("could not read the bot's servers");
  });

  test("applyRouting before initRouting rejects, and the queue works afterwards", async () => {
    await expect(applyRouting("too early")).rejects.toThrow("routing used before initRouting()");
    const h = harness();
    initRouting(h.ctx);
    expect((await applyRouting("boot")).mode).toBe("single");
  });
});

describe("refreshDiscovery", () => {
  test("refreshDiscovery before initRouting is a no-op", async () => {
    await expect(refreshDiscovery()).resolves.toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("refreshDiscovery reuses the last registrations", async () => {
    await placeMusicInOther();
    const h = harness();
    initRouting(h.ctx);
    const boot = await applyRouting("boot");
    const before = readDiscovery();

    // A channel appears in Discord between the boot and the refresh.
    h.world.addChannel(OTHER, textChannel("2003", "new-channel", 3));
    await refreshDiscovery();
    const after = readDiscovery();

    expect(after.guilds.find((g) => g.id === OTHER)!.channels.map((c) => c.name)).toEqual(["spotify", "chat", "new-channel"]);
    // The registrations are the boot's, with the boot's timestamps -- a refresh registers nothing.
    expect(after.guilds.map((g) => g.commands)).toEqual(before.guilds.map((g) => g.commands));
    expect(h.puts).toHaveLength(boot.results.length);
    // It is a new snapshot, though.
    expect(after.generatedAt).not.toBe(before.generatedAt);
  });

  test("a refresh queues behind a registration in flight rather than racing it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ onPut: () => gate });
    initRouting(h.ctx);
    const applying = applyRouting("boot");
    const refreshing = refreshDiscovery();
    // The refresh cannot have written yet: the registration it queued behind is still waiting on its put.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(discoveryPath(dir))).toBe(false);
    release();
    await Promise.all([applying, refreshing]);
    expect(readDiscovery().guilds.find((g) => g.id === HOME)!.commands).not.toBeNull();
  });

  test("a refresh whose write fails is logged, not thrown", async () => {
    const file = join(dir, "not-a-directory");
    writeFileSync(file, "x");
    const h = harness({ dataDir: join(file, "data") });
    initRouting(h.ctx);
    await applyRouting("boot");
    h.logs.error.length = 0;
    await expect(refreshDiscovery()).resolves.toBeUndefined();
    expect(h.logs.error).toHaveLength(1);
    expect(h.logs.error[0]).toContain("writing discovery.json failed (refresh)");
  });
});
