import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, type Client, type RESTPostAPIChatInputApplicationCommandsJSONBody as CommandJson } from "discord.js";
import type { PluginCommand, PluginIndexEntry } from "../plugins/contract";
import type { PluginCommandMap } from "../plugins/host";
import { discoveryPath, type PluginSummary } from "./discovery";
import { applyRouting, guildJoined, guildLeft, initRouting, refreshDiscovery, resetRoutingForTest, type RoutingContext } from "./live";
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
    expect(h.logs.error).toEqual(["[routing] the global command list was not emptied (Error: nope), so commands may show twice"]);
  });

  test("routed mode with no home server leaves the global scope alone when every server refused, and logs it", async () => {
    await placeMusicInOther();
    const refusal = Object.assign(new Error("Missing Access"), { code: 50001 });
    const h = harness({ homeGuildId: undefined, failures: { [guildRoute(HOME)]: refusal, [guildRoute(OTHER)]: refusal } });
    initRouting(h.ctx);
    await applyRouting("boot");
    // Both servers were tried and no empty put followed: the global list is all they have.
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(OTHER)]);
    expect(h.logs.error.at(-1)).toBe(
      "[routing] the global command list was not emptied (not attempted: no server accepted its commands), so commands may show twice",
    );
  });

  test("routed mode with no home server does not empty the global scope when the servers could not be read", async () => {
    await placeMusicInOther();
    const h = harness({ homeGuildId: undefined });
    const broken = { user: h.world.client.user, get guilds(): never { throw new Error("cache exploded"); } } as unknown as Client<true>;
    initRouting({ ...h.ctx, client: broken });
    const result = await applyRouting("boot");
    // No server list means no servers registered -- and above all no empty put, which would leave the
    // bot with no commands anywhere.
    expect(h.puts).toEqual([]);
    expect(result).toEqual({ mode: "routed", results: [] });
    // And no discovery.json written from a read that failed.
    expect(existsSync(discoveryPath(dir))).toBe(false);
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

  test("a single-mode failure of the global scope is rethrown, and discovery has no place for it", async () => {
    // With no home server the one PUT goes to the global scope, which belongs to no server's entry.
    // discovery.json is still written, and the failure reaches the operator through index.ts's message.
    const failure = new Error("boom");
    const h = harness({ homeGuildId: undefined, failures: { [`/applications/${APP}/commands`]: failure } });
    initRouting(h.ctx);
    await expect(applyRouting("boot")).rejects.toBe(failure);
    const file = readDiscovery();
    expect(file.guilds.map((g) => g.commands)).toEqual([null, null]);
    expect(JSON.stringify(file)).not.toContain("boom");
    expect(h.logs.error).toEqual([]);
  });

  test("a home server the bot cannot see is still tried in single mode, and its failure rethrown", async () => {
    const refusal = Object.assign(new Error("Unknown Guild"), { code: 10004 });
    const h = harness({ failures: { [guildRoute(HOME)]: refusal } });
    h.world.guilds.delete(HOME);
    initRouting(h.ctx);
    await expect(applyRouting("boot")).rejects.toBe(refusal);
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME)]);
    // The failure is recorded against the home server's entry, and there is no such entry to carry it.
    expect(readDiscovery().guilds.map((g) => [g.id, g.commands])).toEqual([[OTHER, null]]);
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
    // A read that failed is not a server list: nothing is written from it.
    expect(existsSync(discoveryPath(dir))).toBe(false);
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

  test("a refresh whose server cache cannot be read keeps the discovery.json it already has", async () => {
    const h = harness();
    let broken = false;
    const client = {
      user: h.world.client.user,
      get guilds() {
        if (broken) throw new Error("cache exploded");
        return h.world.client.guilds;
      },
    } as unknown as Client<true>;
    initRouting({ ...h.ctx, client });
    await applyRouting("boot");
    const before = readFileSync(discoveryPath(dir), "utf8");
    // The read fails for a while: the file the panel is showing is not blanked by it.
    broken = true;
    await refreshDiscovery();
    expect(readFileSync(discoveryPath(dir), "utf8")).toBe(before);
    expect(h.logs.error.at(-1)).toContain("could not read the bot's servers");
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

// #259: a server the bot joins or leaves after boot.
describe("guildJoined / guildLeft (#259)", () => {
  type Harness = ReturnType<typeof harness>;
  /** The bot was not in Other at boot ... */
  const leaveOther = (h: Harness) => void h.world.guilds.delete(OTHER);
  /** ... and is invited to it later. */
  const joinOther = (h: Harness) =>
    void h.world.guilds.set(OTHER, {
      id: OTHER,
      name: "Other",
      channels: { cache: new Map([["2001", textChannel("2001", "spotify", 1)], ["2002", textChannel("2002", "chat", 2)]]) },
    });
  const OTHER_GUILD = { id: OTHER, name: "Other" };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** A promise the test opens by hand, so a registration can be held in flight. */
  const latch = () => {
    let open: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { closed, open };
  };

  test("a join in routed mode registers again, the new server included, and discovery lists it with its outcome", async () => {
    await placeMusicInOther();
    const h = harness();
    leaveOther(h);
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME)]);
    expect(readDiscovery().guilds.map((g) => g.id)).toEqual([HOME]);

    h.puts.length = 0;
    joinOther(h);
    await guildJoined(OTHER_GUILD);

    // One run, the whole registration: every server, in name order, the new one with its commands.
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(OTHER)]);
    expect(names(h.puts[1]!.body)).toEqual([...CORE, ...MUSIC]);
    // Discovery, written after registering, lists it with what it was told.
    const other = readDiscovery().guilds.find((g) => g.id === OTHER)!;
    expect(other.commands).toMatchObject({ registered: CORE.length + MUSIC.length });
    expect(other.commands?.error).toBeUndefined();
    expect(h.logs.log).toContain(`[routing] joined Other (${OTHER})`);
  });

  test("a join in single mode makes no registration call and refreshes discovery", async () => {
    const h = harness();
    leaveOther(h);
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.puts).toHaveLength(1);
    expect(readDiscovery().guilds.map((g) => g.id)).toEqual([HOME]);

    joinOther(h);
    await guildJoined(OTHER_GUILD);
    // The one guild-or-global call already covers a new server, as it always has: nothing more is sent ...
    expect(h.puts).toHaveLength(1);
    // ... and discovery now lists it, with nothing registered there by this run.
    const file = readDiscovery();
    expect(file.guilds.map((g) => g.id)).toEqual([HOME, OTHER]);
    expect(file.guilds.find((g) => g.id === OTHER)!.commands).toBeNull();

    // A routing.json that exists but places nobody is single mode too.
    await mutateRouting(dir, (c) => ({ ...c, plugins: {} }));
    await guildJoined(OTHER_GUILD);
    expect(h.puts).toHaveLength(1);
  });

  test("a join before initRouting does nothing", async () => {
    const h = harness();
    await placeMusicInOther();
    await expect(guildJoined(OTHER_GUILD)).resolves.toBeUndefined();
    // The boot registration that follows snapshots a cache that already holds the server.
    expect(h.puts).toEqual([]);
    expect(h.logs.log).toEqual([]);
    expect(existsSync(discoveryPath(dir))).toBe(false);
  });

  test("a join while the boot registration is running queues behind it", async () => {
    await placeMusicInOther();
    const held = latch();
    const sawDiscovery: boolean[] = [];
    let first = true;
    const h = harness({
      onPut: async () => {
        sawDiscovery.push(existsSync(discoveryPath(dir)));
        if (first) {
          first = false;
          await held.closed;
        }
      },
    });
    initRouting(h.ctx);
    const boot = applyRouting("boot");
    const joined = guildJoined(OTHER_GUILD);
    await sleep(30);
    // Only the boot's first put has happened; the join has read routing and is waiting on the chain.
    expect(sawDiscovery).toEqual([false]);
    held.open();
    await Promise.all([boot, joined]);
    // The boot's two puts come before discovery is written, the join's two after it.
    expect(sawDiscovery).toEqual([false, false, true, true]);
  });

  test("two joins are applied one after the other", async () => {
    await placeMusicInOther();
    const sawDiscovery: boolean[] = [];
    const h = harness({
      onPut: async () => {
        sawDiscovery.push(existsSync(discoveryPath(dir)));
        await sleep(20);
      },
    });
    initRouting(h.ctx);
    await Promise.all([guildJoined(OTHER_GUILD), guildJoined({ id: HOME, name: "Home" })]);
    // Each run puts to two servers; the second run's first put comes after the first run's discovery write.
    expect(sawDiscovery).toEqual([false, false, true, true]);
    expect(h.puts).toHaveLength(4);
  });

  test("a join whose registration fails is logged, not thrown", async () => {
    // The join reads routing (placements: routed mode), queues behind a registration in flight, and the last
    // placement is removed while it waits. Its run is then a single-mode one, and single mode rethrows a
    // failed registration -- which must not escape into the listener.
    await placeMusicInOther();
    const held = latch();
    let first = true;
    const h = harness({
      failures: { [guildRoute(HOME)]: new Error("Missing Access") }, // single mode's one PUT goes to the home server
      onPut: async () => {
        if (first) {
          first = false;
          await held.closed;
        }
      },
    });
    initRouting(h.ctx);
    const boot = applyRouting("boot");
    const joined = guildJoined(OTHER_GUILD);
    await sleep(30);
    await mutateRouting(dir, (c) => ({ ...c, plugins: {} }));
    held.open();
    await boot;
    await expect(joined).resolves.toBeUndefined();
    expect(h.logs.error.some((line) => line.includes(`[routing] handling the join of Other (${OTHER}) failed`))).toBe(true);
    expect(h.logs.error.some((line) => line.includes("Missing Access"))).toBe(true);
  });

  test("a leave refreshes discovery and leaves routing.json byte-identical", async () => {
    await placeMusicInOther();
    const h = harness();
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(readDiscovery().guilds.map((g) => g.id)).toEqual([HOME, OTHER]);
    const before = readFileSync(routingPath(dir));
    const putsBefore = h.puts.length;

    leaveOther(h);
    await guildLeft(OTHER_GUILD);

    // The server stops being offered ...
    expect(readDiscovery().guilds.map((g) => g.id)).toEqual([HOME]);
    // ... but its placement is kept, so being kicked and re-invited loses nothing, and nothing is registered.
    expect(readFileSync(routingPath(dir)).equals(before)).toBe(true);
    expect(h.puts).toHaveLength(putsBefore);
    expect(h.logs.log).toContain(`[routing] left Other (${OTHER})`);
  });

  test("a leave with no routing.json does not create one", async () => {
    const h = harness();
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(existsSync(routingPath(dir))).toBe(false);
    leaveOther(h);
    await guildLeft(OTHER_GUILD);
    expect(existsSync(routingPath(dir))).toBe(false);
    expect(readDiscovery().guilds.map((g) => g.id)).toEqual([HOME]);
  });

  test("a leave before initRouting does nothing", async () => {
    const h = harness();
    await placeMusicInOther();
    const before = readFileSync(routingPath(dir));
    await expect(guildLeft(OTHER_GUILD)).resolves.toBeUndefined();
    expect(existsSync(discoveryPath(dir))).toBe(false);
    expect(readFileSync(routingPath(dir)).equals(before)).toBe(true);
    expect(h.puts).toEqual([]);
    expect(h.logs.log).toEqual([]);
  });

  test("a leave whose refresh fails is logged, not thrown", async () => {
    // The write fails: logged by the refresh itself, and the leave still resolves.
    const file = join(dir, "not-a-directory");
    writeFileSync(file, "x");
    const failing = harness({ dataDir: join(file, "data") });
    initRouting(failing.ctx);
    await expect(guildLeft(OTHER_GUILD)).resolves.toBeUndefined();
    expect(failing.logs.error.some((line) => line.includes("writing discovery.json failed (refresh)"))).toBe(true);
    resetRoutingForTest();

    // The refresh itself rejects (here because the logger throws once, while it reports the unreadable
    // server cache): the leave logs that and resolves, so nothing reaches the emitter.
    const world = fakeWorld();
    let logged = false;
    const errors: string[] = [];
    const h = harness({
      client: {
        user: world.client.user,
        get guilds(): never {
          throw new Error("cache exploded");
        },
      } as unknown as Client<true>,
      log: {
        log: () => {},
        warn: () => {},
        error: (...a: unknown[]) => {
          if (!logged) {
            logged = true;
            throw new Error("the logger broke");
          }
          errors.push(a.map(String).join(" "));
        },
      },
    });
    initRouting(h.ctx);
    await expect(guildLeft(OTHER_GUILD)).resolves.toBeUndefined();
    expect(errors.some((line) => line.includes(`[routing] handling the departure from Other (${OTHER}) failed`))).toBe(true);
  });
});
