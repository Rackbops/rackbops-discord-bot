import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, type Client, type RESTPostAPIChatInputApplicationCommandsJSONBody as CommandJson } from "discord.js";
import type { PluginCommand, PluginIndexEntry } from "../plugins/contract";
import type { PluginCommandMap } from "../plugins/host";
import { discoveryPath, type PluginSummary } from "./discovery";
import { settled } from "../../test/stateLeaks";
import {
  applyRouting,
  guildJoined,
  guildLeft,
  initRouting,
  refreshDiscovery,
  resetRoutingForTest,
  resetRoutingQueueForTest,
  routingStateForTest,
  type RoutingContext,
} from "./live";
import type { DiscoveryFile } from "./model";
import { mutateRouting, routingPath } from "./store";
import { resetKeptCorruptForTest } from "../storage";

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
// Not the queue: a test awaits what it queues, and the test-state guard fails one that leaves a job
// running.
afterEach(() => {
  resetRoutingForTest();
  // A routing file that will not parse is kept in place by a read and remembered (#477).
  resetKeptCorruptForTest();
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

    // ...and one that will not even parse (it is left in place and read as fresh).
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
    // No server took a list, so the global one is the only one: nothing shows twice (#482).
    expect(h.logs.error.at(-1)).toBe("[routing] the global command list was left as it is: no server accepted its commands");
    expect(h.logs.error.join("\n")).not.toContain("show twice");
    expect(readDiscovery().global).toEqual({ registered: 0, error: "not attempted: no server accepted its commands", at: expect.any(String) });
  });

  test("L8: a failed empty reads \"was not emptied ... show twice\" and is recorded in discovery's global slot", async () => {
    await placeMusicInOther();
    const globalRoute = `/applications/${APP}/commands`;
    const h = harness({ homeGuildId: undefined, failures: { [globalRoute]: new Error("nope") } });
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.logs.error.join("\n")).toContain("show twice");
    expect(readDiscovery().global).toEqual({ registered: 0, error: "Error: nope", at: expect.any(String) });
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

  test("a single-mode failure of the global scope is rethrown, and discovery records it in the global slot", async () => {
    // With no home server the one PUT goes to the global scope, which belongs to no server's entry.
    // discovery.json is still written, and the failure also reaches the operator through index.ts's message.
    const failure = new Error("boom");
    const h = harness({ homeGuildId: undefined, failures: { [`/applications/${APP}/commands`]: failure } });
    initRouting(h.ctx);
    await expect(applyRouting("boot")).rejects.toBe(failure);
    const file = readDiscovery();
    expect(file.guilds.map((g) => g.commands)).toEqual([null, null]);
    // The global scope has a slot now (#482): the failure is recorded there, not on a server.
    expect(file.global).toEqual({ registered: 0, error: "Error: boom", at: expect.any(String) });
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
  const HOME_GUILD = { id: HOME, name: "Home" };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** A promise the test opens by hand, so a registration can be held in flight. */
  const latch = () => {
    let open: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { closed, open };
  };
  /**
   * Fails a test that would otherwise never end. A join that waits on the chain it is itself queued on
   * (the deadlock the mode-outside-the-chain rule exists to prevent) is a promise that never settles, and
   * a test awaiting it with nothing else pending neither times out nor exits: the suite hangs.
   */
  const withinDeadline = <T>(p: Promise<T>, what: string, ms = 3000): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms: is it waiting on the chain it is queued on?`)), ms);
        void p.then(() => clearTimeout(timer), () => clearTimeout(timer));
      }),
    ]);
  const handleJoin = (guild: { id: string; name: string }) => withinDeadline(guildJoined(guild), `guildJoined(${guild.name})`);
  const handleLeave = (guild: { id: string; name: string }) => withinDeadline(guildLeft(guild), `guildLeft(${guild.name})`);

  test("L6: a join in routed mode registers the joined server ALONE, merged into the last full run's record", async () => {
    await placeMusicInOther();
    const h = harness();
    leaveOther(h);
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME)]);
    expect(readDiscovery().guilds.map((g) => g.id)).toEqual([HOME]);
    const homeAt = readDiscovery().guilds[0]!.commands!.at;

    h.puts.length = 0;
    joinOther(h);
    await handleJoin(OTHER_GUILD);

    // ONE put, to the new server, with its commands (#482 item 5): not one per server the bot is in.
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(OTHER)]);
    expect(names(h.puts[0]!.body)).toEqual([...CORE, ...MUSIC]);
    // Discovery, written after registering, lists it with what it was told, and HOME's earlier record is intact.
    const file = readDiscovery();
    const other = file.guilds.find((g) => g.id === OTHER)!;
    expect(other.commands).toMatchObject({ registered: CORE.length + MUSIC.length });
    expect(other.commands?.error).toBeUndefined();
    expect(file.guilds.find((g) => g.id === HOME)!.commands).toMatchObject({ registered: CORE.length + WOW.length, at: homeAt });
    expect(h.logs.log).toContain(`[routing] joined Other (${OTHER})`);
    expect(h.logs.log).toContain(`Registered commands in 1 server (Other: ${CORE.length + MUSIC.length})`);
  });

  test("L6e: a join retries a global empty the last full run could not do (and not one that succeeded)", async () => {
    await placeMusicInOther();
    const globalRoute = `/applications/${APP}/commands`;
    // Only the global empty fails at boot, so it is recorded with an error while the servers took their lists.
    const h = harness({ homeGuildId: undefined, failures: { [globalRoute]: new Error("nope") } });
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(readDiscovery().global?.error).toContain("nope");
    h.puts.length = 0;
    await handleJoin(OTHER_GUILD);
    // The narrow join registers OTHER and retries the global empty (it fails again here: still recorded).
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(OTHER), globalRoute]);
    expect(readDiscovery().global?.error).toContain("nope");

    // A global empty that succeeded is not retried by a join.
    resetRoutingForTest();
    const ok = harness({ homeGuildId: undefined });
    initRouting(ok.ctx);
    await applyRouting("boot");
    expect(readDiscovery().global).toMatchObject({ registered: 0 });
    expect(readDiscovery().global?.error).toBeUndefined();
    ok.puts.length = 0;
    await handleJoin(OTHER_GUILD);
    expect(ok.puts.map((p) => p.route)).toEqual([guildRoute(OTHER)]);
    // A second join of the same server REPLACES its record rather than adding a second one beside it.
    const before = readDiscovery().guilds.find((g) => g.id === OTHER)!.commands!.at;
    await handleJoin(OTHER_GUILD);
    expect(readDiscovery().guilds.find((g) => g.id === OTHER)!.commands!.at).not.toBe(before);
  });

  test("L6b: a join while routing places nobody is the full single-mode run", async () => {
    const h = harness();
    initRouting(h.ctx);
    await applyRouting("boot");
    h.puts.length = 0;
    await mutateRouting(dir, (c) => ({ ...c, plugins: {} }));
    await handleJoin(HOME_GUILD); // the home server: single mode's one call IS its registration
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME)]);
    expect(names(h.puts[0]!.body)).toEqual([...CORE, ...MUSIC, ...WOW]);
  });

  test("L6c: a join of a server that is not in the snapshot falls back to the full run, never an undefined body", async () => {
    await placeMusicInOther();
    const h = harness();
    initRouting(h.ctx);
    await applyRouting("boot");
    h.puts.length = 0;
    await handleJoin({ id: "333333333333333333", name: "Ghost" }); // the fake world does not hold it
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(OTHER)]);
    for (const p of h.puts) expect(Array.isArray(p.body)).toBe(true);
  });

  test("L6d: a join after a boot that could not read the servers is the full run, and the file keeps every record", async () => {
    await placeMusicInOther();
    const h = harness();
    const real = h.ctx.client;
    let broken = true;
    const flaky = {
      user: real.user,
      get guilds() {
        if (broken) throw new Error("cache exploded");
        return real.guilds;
      },
    } as unknown as Client<true>;
    initRouting({ ...h.ctx, client: flaky });
    await applyRouting("boot");
    expect(h.puts).toEqual([]);
    broken = false;
    await handleJoin(OTHER_GUILD);
    // The full run: HOME and OTHER both registered, and the file holds both (not one record and a null).
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(OTHER)]);
    expect(readDiscovery().guilds.map((g) => g.commands !== null)).toEqual([true, true]);
    // A second join is now narrow.
    h.puts.length = 0;
    await handleJoin(OTHER_GUILD);
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(OTHER)]);
  });

  test("L7: a routed run that could not read the servers keeps the last registrations (#484 item 5)", async () => {
    await placeMusicInOther();
    const h = harness();
    const real = h.ctx.client;
    let broken = false;
    const flaky = {
      user: real.user,
      get guilds() {
        if (broken) throw new Error("cache exploded");
        return real.guilds;
      },
    } as unknown as Client<true>;
    initRouting({ ...h.ctx, client: flaky });
    await applyRouting("boot");
    broken = true;
    h.puts.length = 0;
    await applyRouting("again");
    expect(h.puts).toEqual([]);
    broken = false;
    await refreshDiscovery();
    // The boot's registrations survive the failed run: not null for every server.
    expect(readDiscovery().guilds.every((g) => g.commands !== null && g.commands.registered > 0)).toBe(true);
  });

  test("L7b: single mode with an unreadable server cache still makes its put and records it", async () => {
    const h = harness();
    const real = h.ctx.client;
    let broken = true;
    const flaky = {
      user: real.user,
      get guilds() {
        if (broken) throw new Error("cache exploded");
        return real.guilds;
      },
    } as unknown as Client<true>;
    initRouting({ ...h.ctx, client: flaky });
    await applyRouting("boot");
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME)]);
    broken = false;
    await refreshDiscovery();
    expect(readDiscovery().guilds.find((g) => g.id === HOME)!.commands).toMatchObject({ registered: CORE.length + MUSIC.length + WOW.length });
  });

  test("a join in single mode makes no registration call and refreshes discovery", async () => {
    const h = harness();
    leaveOther(h);
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.puts).toHaveLength(1);
    expect(readDiscovery().guilds.map((g) => g.id)).toEqual([HOME]);

    joinOther(h);
    await handleJoin(OTHER_GUILD);
    // Single mode registers to ONE place (here the home server) and a join of another server does not change
    // where: nothing more is sent ...
    expect(h.puts).toHaveLength(1);
    // ... and discovery now lists it, with nothing registered there, as before.
    const file = readDiscovery();
    expect(file.guilds.map((g) => g.id)).toEqual([HOME, OTHER]);
    expect(file.guilds.find((g) => g.id === OTHER)!.commands).toBeNull();

    // A routing.json that exists but places nobody is single mode too.
    await mutateRouting(dir, (c) => ({ ...c, plugins: {} }));
    await handleJoin(OTHER_GUILD);
    expect(h.puts).toHaveLength(1);
  });

  /** The bot's own server list, for the home server. */
  const leaveHome = (h: Harness) => void h.world.guilds.delete(HOME);
  const joinHome = (h: Harness) =>
    void h.world.guilds.set(HOME, { id: HOME, name: "Home", channels: { cache: new Map([["1001", textChannel("1001", "general", 1)]]) } });

  test("a join of the home server in single mode registers again: the bot was not in it at boot, and is invited later", async () => {
    // The boot registration was refused (the bot is not in the home server, so Discord answers 50001) and
    // single mode rethrew it; when the bot is invited, the join must put the commands there. Single mode's
    // one call is that registration.
    const failures: Record<string, unknown> = { [guildRoute(HOME)]: new Error("Missing Access (50001)") };
    const h = harness({ failures });
    leaveHome(h);
    initRouting(h.ctx);
    await expect(applyRouting("boot")).rejects.toThrow("Missing Access");
    expect(readDiscovery().guilds.map((g) => g.id)).toEqual([OTHER]);

    delete failures[guildRoute(HOME)];
    joinHome(h);
    await handleJoin(HOME_GUILD);
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(HOME)]);
    // Exactly the call it always made in single mode: the full body, to the home server.
    expect(names(h.puts[1]!.body)).toEqual([...CORE, ...MUSIC, ...WOW]);
    const home = readDiscovery().guilds.find((g) => g.id === HOME)!;
    expect(home.commands).toMatchObject({ registered: CORE.length + MUSIC.length + WOW.length });
    expect(home.commands?.error).toBeUndefined();
  });

  test("a join of the home server in single mode registers again: the bot was removed from it and is added back", async () => {
    const h = harness();
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.puts).toHaveLength(1);

    leaveHome(h);
    await handleLeave(HOME_GUILD);
    // A leave registers nothing, and the server stops being listed.
    expect(h.puts).toHaveLength(1);
    expect(readDiscovery().guilds.map((g) => g.id)).toEqual([OTHER]);

    joinHome(h);
    await handleJoin(HOME_GUILD);
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(HOME)]);
    expect(names(h.puts[1]!.body)).toEqual([...CORE, ...MUSIC, ...WOW]);
    expect(readDiscovery().guilds.find((g) => g.id === HOME)!.commands).toMatchObject({ registered: CORE.length + MUSIC.length + WOW.length });
  });

  test("a join in single mode with no home server registers nothing: the global list already reaches a new server", async () => {
    const h = harness({ homeGuildId: undefined });
    leaveOther(h);
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.puts.map((p) => p.route)).toEqual([`/applications/${APP}/commands`]);
    joinOther(h);
    await handleJoin(OTHER_GUILD);
    await handleJoin(HOME_GUILD);
    expect(h.puts).toHaveLength(1);
    expect(readDiscovery().guilds.map((g) => g.id)).toEqual([HOME, OTHER]);
  });

  test("a join before initRouting does nothing", async () => {
    const h = harness();
    await placeMusicInOther();
    await expect(handleJoin(OTHER_GUILD)).resolves.toBeUndefined();
    // The boot registration that follows snapshots a cache that already holds the server. (`h` was never passed
    // to initRouting, so its puts and logs could not have been touched either way; what can be seen is that no
    // discovery file was written.)
    void h;
    expect(existsSync(discoveryPath(dir))).toBe(false);
  });

  test("a join while the boot registration is running queues behind it", async () => {
    await placeMusicInOther();
    const held = latch();
    const reached = latch();
    const sawDiscovery: boolean[] = [];
    let first = true;
    const h = harness({
      onPut: async () => {
        sawDiscovery.push(existsSync(discoveryPath(dir)));
        if (first) {
          first = false;
          reached.open();
          await held.closed;
        }
      },
    });
    initRouting(h.ctx);
    const boot = applyRouting("boot");
    const joined = handleJoin(OTHER_GUILD);
    // Wait for the boot's first put to be reached (no guessing at how long that takes), then give the join every
    // chance to run its own: it must not, being queued behind the boot on the chain.
    await withinDeadline(reached.closed, "the boot registration's first put");
    await sleep(30);
    expect(sawDiscovery).toEqual([false]);
    held.open();
    await Promise.all([boot, joined]);
    // The boot's two puts come before discovery is written, the join's ONE (it registers its server alone) after it.
    expect(sawDiscovery).toEqual([false, false, true]);
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(OTHER), guildRoute(OTHER)]);
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
    await Promise.all([handleJoin(OTHER_GUILD), handleJoin(HOME_GUILD)]);
    // No boot ran, so the first join is the fallback full run (two puts) and the second registers its server
    // alone (one); that put comes after the first run's discovery write. The `await sleep(20)` in onPut is what
    // lets the test observe the ordering of the two discovery writes -- it is not a race guard.
    expect(sawDiscovery).toEqual([false, false, true]);
    // (Which join queues first depends on when each routing read settles, so only the shape is pinned.)
    expect(h.puts.map((p) => p.route).slice(0, 2)).toEqual([guildRoute(HOME), guildRoute(OTHER)]);
    expect([guildRoute(HOME), guildRoute(OTHER)]).toContain(h.puts[2]!.route);
  });

  test("a join whose registration fails is logged, not thrown", async () => {
    // Single mode rethrows a failed registration (once discovery has recorded it), and a join of the home
    // server in single mode is a registration: the rejection must not escape into the listener.
    const h = harness({ failures: { [guildRoute(HOME)]: new Error("Missing Access") } });
    initRouting(h.ctx);
    await applyRouting("boot").catch(() => {});
    h.logs.error.length = 0;
    await expect(handleJoin(HOME_GUILD)).resolves.toBeUndefined();
    expect(h.logs.error.some((line) => line.includes(`[routing] handling the join of Home (${HOME}) failed`))).toBe(true);
    expect(h.logs.error.some((line) => line.includes("Missing Access"))).toBe(true);
  });

  test("L5 (#421): a logger that throws while the run reports what it registered does not reject a routed registration", async () => {
    // Routed mode never throws once routing has been read: the logger's failure is swallowed (`tell`), and the
    // PUTs and the discovery write stand.
    await placeMusicInOther();
    const errors: string[] = [];
    const h = harness({
      log: {
        log: (line: unknown) => {
          if (String(line).startsWith("Registered commands")) throw new Error("the logger broke");
        },
        warn: () => {},
        error: (...a: unknown[]) => void errors.push(a.map(String).join(" ")),
      },
    });
    initRouting(h.ctx);
    await expect(applyRouting("boot")).resolves.toMatchObject({ mode: "routed" });
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(OTHER)]);
    expect(readDiscovery().guilds.map((g) => g.id)).toEqual([HOME, OTHER]);
    // ... and a join resolves with no "handling the join ... failed" line.
    await expect(handleJoin(OTHER_GUILD)).resolves.toBeUndefined();
    expect(errors.some((line) => line.includes("handling the join"))).toBe(false);
  });

  test("L5b/L5c (#421): a logger whose error() throws does not reject a run whose discovery write or server read failed", async () => {
    await placeMusicInOther();
    const broken = () => {
      throw new Error("logger broke");
    };
    // L5b: the discovery WRITE fails (a directory where the file goes) and the logger's error() throws.
    mkdirSync(discoveryPath(dir));
    const b = harness({ log: { log: () => {}, warn: () => {}, error: broken } });
    initRouting(b.ctx);
    await expect(applyRouting("boot")).resolves.toMatchObject({ mode: "routed" });
    resetRoutingForTest();
    rmSync(discoveryPath(dir), { recursive: true, force: true });
    // L5c: the server cache cannot be read and the logger's error() throws.
    const c = harness({
      client: { user: b.world.client.user, get guilds(): never { throw new Error("cache exploded"); } } as unknown as Client<true>,
      log: { log: () => {}, warn: () => {}, error: broken },
    });
    initRouting(c.ctx);
    await expect(applyRouting("boot")).resolves.toMatchObject({ mode: "routed" });
  });

  test("a logger that always throws does not make a join or a leave reject", async () => {
    const broken = () => {
      throw new Error("the logger broke");
    };
    const h = harness({ log: { log: broken, warn: broken, error: broken } });
    initRouting(h.ctx);
    await expect(handleJoin(OTHER_GUILD)).resolves.toBeUndefined();
    await expect(handleLeave(OTHER_GUILD)).resolves.toBeUndefined();
  });

  test("a logger that throws on the join's own line does not stop the work", async () => {
    // The line that says a server was joined is written before anything is done; a broken logger must not
    // be able to hold the registration up. (Routed mode, so the run's own report line is left alone.)
    await placeMusicInOther();
    const h = harness({
      log: {
        log: (line: unknown) => {
          if (String(line).startsWith("[routing] joined")) throw new Error("the logger broke");
        },
        warn: () => {},
        error: () => {},
      },
    });
    leaveOther(h);
    initRouting(h.ctx);
    await applyRouting("boot");
    h.puts.length = 0;
    joinOther(h);
    await expect(handleJoin(OTHER_GUILD)).resolves.toBeUndefined();
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(OTHER)]); // the joined server alone
    await expect(handleLeave(OTHER_GUILD)).resolves.toBeUndefined();
  });

  test("a malformed guild does not make a join or a leave reject", async () => {
    // discord.js always hands over a Guild; this is about the catch block, which names the server.
    const h = harness();
    initRouting(h.ctx);
    await expect(withinDeadline(guildJoined(null as never), "guildJoined(null)")).resolves.toBeUndefined();
    await expect(withinDeadline(guildLeft(undefined as never), "guildLeft(undefined)")).resolves.toBeUndefined();
    expect(h.logs.error.some((line) => line.includes("handling the join of undefined (undefined) failed"))).toBe(true);
  });

  test("a join's discovery write failure is logged, and names the join", async () => {
    await placeMusicInOther();
    mkdirSync(discoveryPath(dir)); // a directory where the file goes: the write fails
    const h = harness();
    initRouting(h.ctx);
    await expect(handleJoin(OTHER_GUILD)).resolves.toBeUndefined();
    expect(h.logs.error.some((line) => line.includes("writing discovery.json failed (joined Other)"))).toBe(true);
    // The registration itself still happened: a panel that cannot be told is no reason to skip the commands.
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(OTHER)]);
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
    await handleLeave(OTHER_GUILD);

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
    await handleLeave(OTHER_GUILD);
    expect(existsSync(routingPath(dir))).toBe(false);
    expect(readDiscovery().guilds.map((g) => g.id)).toEqual([HOME]);
  });

  test("a leave before initRouting does nothing", async () => {
    const h = harness();
    await placeMusicInOther();
    const before = readFileSync(routingPath(dir));
    await expect(handleLeave(OTHER_GUILD)).resolves.toBeUndefined();
    expect(existsSync(discoveryPath(dir))).toBe(false);
    expect(readFileSync(routingPath(dir)).equals(before)).toBe(true);
    // `h` was never passed to initRouting, so asserting on its puts or logs would be vacuous (#485 item 9).
    void h;
  });

  test("a leave whose refresh fails is logged, not thrown", async () => {
    // The write fails: logged by the refresh itself, and the leave still resolves.
    const file = join(dir, "not-a-directory");
    writeFileSync(file, "x");
    const failing = harness({ dataDir: join(file, "data") });
    initRouting(failing.ctx);
    await expect(handleLeave(OTHER_GUILD)).resolves.toBeUndefined();
    expect(failing.logs.error.some((line) => line.includes("writing discovery.json failed (refresh)"))).toBe(true);
    resetRoutingForTest();

    // The refresh itself rejects (here because the context's log GETTER throws once, while it reports the
    // unreadable server cache; `tell` reads `c.log` outside its try on purpose, #421): the leave logs that and
    // resolves, so nothing reaches the emitter.
    const world = fakeWorld();
    let reads = 0;
    const errors: string[] = [];
    const h = harness({ client: { user: world.client.user, get guilds(): never { throw new Error("cache exploded"); } } as unknown as Client<true> });
    const ctx: RoutingContext = {
      ...h.ctx,
      get log() {
        reads += 1;
        if (reads === 1) throw new Error("the logger broke");
        return { log: () => {}, warn: () => {}, error: (...a: unknown[]) => void errors.push(a.map(String).join(" ")) };
      },
    };
    initRouting(ctx);
    await expect(handleLeave(OTHER_GUILD)).resolves.toBeUndefined();
    expect(errors.some((line) => line.includes(`[routing] handling the departure from Other (${OTHER}) failed`))).toBe(true);
  });
});

// #260: a plugin nobody has placed lives in the home server, so when that server is not one the bot is in
// (kicked, or a typo in DISCORD_SERVER_ID) those plugins are registered nowhere. It is said, once.
describe("a home server the bot is not in (#260)", () => {
  const home = (h: ReturnType<typeof harness>) => h.world.guilds.delete(HOME);
  const NOWHERE = (ids: string, names: string) =>
    `[routing] the home server ${ids} is not one the bot is in, so these plugins, which nobody has placed, are registered nowhere: ${names}`;

  test("routed mode with a home server the bot is not in warns once, naming the unplaced plugins", async () => {
    await placeMusicInOther();
    const h = harness();
    home(h);
    initRouting(h.ctx);
    const first = await applyRouting("boot");
    await applyRouting("routing changed");
    await refreshDiscovery();

    // `music` is placed, `wow` is not: only `wow` is named, and only once across every registration.
    expect(first.mode).toBe("routed");
    expect(h.logs.warn).toEqual([NOWHERE(HOME, "wow")]);
    // It is only a log line: what was registered is what the plan said, and nothing else changed.
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(OTHER), guildRoute(OTHER)]);
    // ... and the warning is true: no server was told about `wow`'s command, the one server there is has music's.
    expect(names(h.puts[0]!.body)).toEqual([...CORE, ...MUSIC]);
  });

  test("it names every unplaced plugin, in the order they were loaded, and not the placed one", async () => {
    await placeMusicInOther();
    const h = harness({ plugins: [...commandWorld().plugins, { name: "extra", commands: ["extra"], posts: false }] });
    home(h);
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.logs.warn).toEqual([NOWHERE(HOME, "wow, extra")]);
  });

  test("a plugin with no commands has nothing to register, so it is not named", async () => {
    await placeMusicInOther();
    // `ticker` only posts (its announcements go to the default channel by id): it loses nothing.
    const h = harness({ plugins: [...commandWorld().plugins, { name: "ticker", commands: [], posts: true }] });
    home(h);
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.logs.warn).toEqual([NOWHERE(HOME, "wow")]);
  });

  test("no warning when the only unplaced plugin has no commands", async () => {
    await placeMusicInOther();
    const h = harness({ plugins: [commandWorld().plugins[0]!, { name: "ticker", commands: [], posts: true }] });
    home(h);
    initRouting(h.ctx);
    expect((await applyRouting("boot")).mode).toBe("routed");
    expect(h.logs.warn).toEqual([]);
  });

  test("a different home server is a different message, and is said once in its own right", async () => {
    await placeMusicInOther();
    const a = harness();
    home(a);
    initRouting(a.ctx);
    await applyRouting("boot");
    expect(a.logs.warn).toEqual([NOWHERE(HOME, "wow")]);

    // A second start-up in the same process (nothing resets what has been said): same problem, said no more.
    const b = harness();
    home(b);
    initRouting(b.ctx);
    await applyRouting("boot");
    expect(b.logs.warn).toEqual([]);

    // A different home server id is a different problem.
    const c = harness({ homeGuildId: "999999999999999999" });
    home(c);
    initRouting(c.ctx);
    await applyRouting("boot");
    expect(c.logs.warn).toEqual([NOWHERE("999999999999999999", "wow")]);
  });

  test("what has been said is forgotten on reset, so a test can see it again", async () => {
    await placeMusicInOther();
    const h = harness();
    home(h);
    initRouting(h.ctx);
    await applyRouting("boot");
    resetRoutingForTest();
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.logs.warn).toEqual([NOWHERE(HOME, "wow"), NOWHERE(HOME, "wow")]);
  });

  test("a hostile DISCORD_SERVER_ID is clipped, not quoted whole", async () => {
    await placeMusicInOther();
    const huge = "9".repeat(5000);
    const h = harness({ homeGuildId: huge });
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.logs.warn).toHaveLength(1);
    expect(h.logs.warn[0]).toContain(`the home server ${"9".repeat(37)}... is not one the bot is in`);
    expect(h.logs.warn[0]!.length).toBeLessThan(300);
  });

  test("a logger that throws on the warning does not turn a finished registration into a failure", async () => {
    await placeMusicInOther();
    const h = harness({
      log: {
        log: () => {},
        warn: () => {
          throw new Error("the log is closed");
        },
        error: () => {},
      },
    });
    home(h);
    initRouting(h.ctx);
    // Routed mode never throws: the registration and the discovery write were already done.
    const result = await applyRouting("boot");
    expect(result.mode).toBe("routed");
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(OTHER)]);
    expect(readDiscovery().guilds.map((g) => g.id)).toEqual([OTHER]);
  });

  test("a warning the logger failed to write is tried again at the next registration, not lost", async () => {
    await placeMusicInOther();
    let calls = 0;
    const written: string[] = [];
    const h = harness({
      log: {
        log: () => {},
        warn: (line: unknown) => {
          calls += 1;
          if (calls === 1) throw new Error("the log is closed");
          written.push(String(line));
        },
        error: () => {},
      },
    });
    home(h);
    initRouting(h.ctx);
    await applyRouting("boot"); // the logger throws: swallowed, not recorded as said
    await applyRouting("routing changed"); // tried again, written
    await applyRouting("routing changed"); // said: nothing more
    expect(written).toEqual([NOWHERE(HOME, "wow")]);
    expect(calls).toBe(2);
  });

  test("no warning when every loaded plugin is placed", async () => {
    await mutateRouting(dir, (c) => ({
      ...c,
      plugins: { music: { servers: { [OTHER]: { commands: "all" } } }, wow: { servers: { [OTHER]: { commands: "all" } } } },
    }));
    const h = harness();
    home(h);
    initRouting(h.ctx);
    const result = await applyRouting("boot");
    expect(result.mode).toBe("routed");
    expect(h.logs.warn).toEqual([]);
  });

  test("no warning when the home server is one the bot is in", async () => {
    await placeMusicInOther();
    const h = harness();
    initRouting(h.ctx);
    const result = await applyRouting("boot");
    expect(result.mode).toBe("routed");
    // `wow` is unplaced and lives in the home server, which is there: nothing is lost.
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(OTHER)]);
    expect(h.logs.warn).toEqual([]);
  });

  test("no warning when there is no home server to be missing", async () => {
    await placeMusicInOther();
    const h = harness({ homeGuildId: undefined });
    initRouting(h.ctx);
    expect((await applyRouting("boot")).mode).toBe("routed");
    expect(h.logs.warn).toEqual([]);
  });

  test("no warning in single mode", async () => {
    // Nothing is placed: today's one call, whatever the home server is.
    const h = harness();
    home(h);
    initRouting(h.ctx);
    expect((await applyRouting("boot")).mode).toBe("single");
    expect(h.logs.warn).toEqual([]);
  });

  test("no warning when the server list could not be read", async () => {
    await placeMusicInOther();
    const world = fakeWorld();
    const h = harness({
      client: {
        user: world.client.user,
        get guilds(): never {
          throw new Error("cache exploded");
        },
      } as unknown as Client<true>,
    });
    initRouting(h.ctx);
    await applyRouting("boot");
    // The read failure is what is reported: a home server the bot "is not in" would be a guess.
    expect(h.logs.error.some((line) => line.includes("could not read the bot's servers"))).toBe(true);
    expect(h.logs.warn).toEqual([]);
  });
});

// The test-state guard (test/stateGuard.ts) decides from this snapshot alone, so each field must
// track the live module. The file's afterEach puts the context and the warnings said back before
// the guard looks, and leaves the queue for it to check.
describe("routingStateForTest (what the test-state guard reads)", () => {
  /** Queues a registration that hangs at its put for good, and resolves once it is there: the job is
   *  held stuck, not hoped to be still running. */
  function stuckRegistration(): Promise<void> {
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    const h = harness({
      onPut: () => {
        reach();
        return new Promise<never>(() => {});
      },
    });
    initRouting(h.ctx);
    void applyRouting("stuck");
    return reached;
  }

  test("initialized tracks initRouting", () => {
    expect(routingStateForTest().initialized).toBe(false);
    initRouting(harness().ctx);
    expect(routingStateForTest().initialized).toBe(true);
  });

  test("said counts the home-server warnings already said", async () => {
    await placeMusicInOther();
    const h = harness();
    h.world.guilds.delete(HOME);
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(routingStateForTest().said).toBe(1);
  });

  test("chain is the queue's tail: pending while a registration waits, settled once it is done", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness({ onPut: () => gate });
    initRouting(h.ctx);
    const boot = applyRouting("boot");
    expect(await settled(routingStateForTest().chain)).toBe(false);
    release();
    await boot;
    expect(await settled(routingStateForTest().chain)).toBe(true);
  });

  // What the guard runs once it has waited, so a job that never finishes can't hold every later
  // test up.
  test("resetRoutingQueueForTest starts a fresh queue, dropping a job that never finishes", async () => {
    await stuckRegistration();
    const before = routingStateForTest().chain;
    resetRoutingQueueForTest();
    expect(await settled(routingStateForTest().chain)).toBe(true);
    expect(await settled(before)).toBe(false);
  });

  // Tests clean up with resetRoutingForTest, as this file's afterEach does: were it to drop the
  // queue too, a job the test leaked would be gone before the guard looked.
  test("resetRoutingForTest leaves the queue alone, so a leaked job still reaches the guard", async () => {
    await stuckRegistration();
    try {
      resetRoutingForTest();
      expect(await settled(routingStateForTest().chain)).toBe(false);
    } finally {
      resetRoutingQueueForTest(); // the stuck job would otherwise fail this test through the guard
    }
  });
});

// #420: leaving routed mode (or a global past) empties what the previous discovery.json says the bot owned.
describe("registration transitions (#420)", () => {
  const globalRoute = `/applications/${APP}/commands`;
  const unplace = () => mutateRouting(dir, (c) => ({ ...c, plugins: {} }));
  const ALL = CORE.length + MUSIC.length + WOW.length;

  test("L1: routed -> single-guild empties the other server once, then not again", async () => {
    await placeMusicInOther();
    const h = harness();
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.puts).toHaveLength(2);
    await unplace();
    h.puts.length = 0;
    await applyRouting("boot");
    // OTHER is emptied FIRST, then HOME gets the full body.
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(OTHER), guildRoute(HOME)]);
    expect(h.puts[0]!.body).toEqual([]);
    expect(names(h.puts[1]!.body)).toHaveLength(ALL);
    const file = readDiscovery();
    expect(file.guilds.find((g) => g.id === OTHER)!.commands).toMatchObject({ registered: 0 });
    expect(file.guilds.find((g) => g.id === OTHER)!.commands?.error).toBeUndefined();
    expect(file.guilds.find((g) => g.id === HOME)!.commands).toMatchObject({ registered: ALL });
    expect(file.global).toBeUndefined();
    // The empty is recorded, so OTHER is no longer a candidate: ONE put now.
    h.puts.length = 0;
    await applyRouting("boot");
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME)]);
  });

  test("L2: routed (no home) -> single-global empties both servers, and the global slot records the registration", async () => {
    await placeMusicInOther();
    const h = harness({ homeGuildId: undefined });
    initRouting(h.ctx);
    await applyRouting("boot"); // HOME, OTHER, global []
    await unplace();
    h.puts.length = 0;
    await applyRouting("boot");
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(OTHER), globalRoute]);
    expect(h.puts[0]!.body).toEqual([]);
    expect(h.puts[1]!.body).toEqual([]);
    expect(names(h.puts[2]!.body)).toHaveLength(ALL);
    const file = readDiscovery();
    expect(file.global).toMatchObject({ registered: ALL });
    expect(file.guilds.map((g) => g.commands?.registered)).toEqual([0, 0]);
  });

  test("L3: routed mode with a home server empties a global list an earlier global run left", async () => {
    const g = harness({ homeGuildId: undefined });
    initRouting(g.ctx);
    await applyRouting("boot"); // single-global: discovery.global.registered = ALL
    expect(readDiscovery().global).toMatchObject({ registered: ALL });
    resetRoutingForTest();

    await placeMusicInOther();
    const h = harness({ homeGuildId: HOME });
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(OTHER), globalRoute]);
    expect(h.puts[2]!.body).toEqual([]);
    expect(readDiscovery().global).toMatchObject({ registered: 0 });
    // The next routed run makes no global call.
    h.puts.length = 0;
    await applyRouting("again");
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME), guildRoute(OTHER)]);
  });

  test("L4: a first boot with no discovery.json makes exactly one put", async () => {
    const h = harness();
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME)]);
  });

  test("L4/L4b: a failed empty is recorded and said; the primary put still happens and resolves", async () => {
    await placeMusicInOther();
    const h = harness();
    initRouting(h.ctx);
    await applyRouting("boot");
    await unplace();
    resetRoutingForTest();
    const refusal = Object.assign(new Error("Missing Access"), { code: 50001 });
    const h2 = harness({ failures: { [guildRoute(OTHER)]: refusal } });
    initRouting(h2.ctx);
    // A clear's error is NOT rethrown as the primary's.
    await expect(applyRouting("boot")).resolves.toMatchObject({ mode: "single" });
    expect(h2.puts.map((p) => p.route)).toEqual([guildRoute(OTHER), guildRoute(HOME)]);
    expect(readDiscovery().guilds.find((g) => g.id === OTHER)!.commands).toMatchObject({ registered: 0, error: "Missing Access (50001)" });
    expect(h2.logs.error).toHaveLength(1);
    expect(h2.logs.error[0]).toContain("could not empty the stale command list of Other");
  });

  test("L4: a failed empty of the global scope is said too, in single mode", async () => {
    const g = harness({ homeGuildId: undefined });
    initRouting(g.ctx);
    await applyRouting("boot");
    resetRoutingForTest();
    const h = harness({ homeGuildId: HOME, failures: { [globalRoute]: new Error("nope") } });
    initRouting(h.ctx);
    await applyRouting("boot");
    expect(h.puts.map((p) => p.route)).toEqual([globalRoute, guildRoute(HOME)]);
    expect(h.logs.error.some((l) => l.includes("could not empty the stale command list of the global scope"))).toBe(true);
  });

  test("L4b: the primary put failing in single mode still rejects with that very error, after discovery is written", async () => {
    const boom = Object.assign(new Error("Missing Access"), { code: 50001 });
    const h = harness({ failures: { [guildRoute(HOME)]: boom } });
    initRouting(h.ctx);
    await expect(applyRouting("boot")).rejects.toBe(boom);
    expect(readDiscovery().guilds.find((g) => g.id === HOME)!.commands).toMatchObject({ registered: 0, error: "Missing Access (50001)" });
  });

  test("L4c: a discovery.json holding a null guild never stops single mode's put, and says nothing", async () => {
    writeFileSync(discoveryPath(dir), JSON.stringify({ guilds: [null], plugins: [], generatedAt: "x" }));
    const h = harness();
    initRouting(h.ctx);
    await expect(applyRouting("boot")).resolves.toMatchObject({ mode: "single" });
    expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME)]);
    expect(h.logs.error).toEqual([]);
  });

  test("L4c-fault: a previous discovery.json that cannot be read is said, and the put still happens", async () => {
    const real = Bun.file.bind(Bun);
    const spy = spyOn(Bun, "file").mockImplementation(((path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && path.endsWith("discovery.json")) {
        return {
          exists: async () => true,
          json: async () => {
            throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
          },
        } as unknown as ReturnType<typeof Bun.file>;
      }
      return (real as (...a: unknown[]) => unknown)(path, ...rest) as ReturnType<typeof Bun.file>;
    }) as typeof Bun.file);
    try {
      const h = harness();
      initRouting(h.ctx);
      await expect(applyRouting("boot")).resolves.toMatchObject({ mode: "single" });
      expect(h.puts.map((p) => p.route)).toEqual([guildRoute(HOME)]);
      const said = h.logs.error.filter((l) => l.includes("could not read the previous discovery.json"));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("EIO");
    } finally {
      spy.mockRestore();
    }
  });
});

// #485 item 8: a server's name in a log line is one bounded line.
describe("server names in log lines (#485)", () => {
  const ESC = String.fromCharCode(0x1b);
  const EVIL = `Evil\nforged [routing] line${ESC}`;
  const OTHER_EVIL = { id: OTHER, name: EVIL };
  const FFFD = String.fromCharCode(0xfffd);

  test("L9: a join and a leave name the server on one line, with the controls replaced and the name clipped", async () => {
    await placeMusicInOther();
    const h = harness();
    initRouting(h.ctx);
    await applyRouting("boot");
    h.world.guilds.get(OTHER)!.name = EVIL;
    await guildJoined(OTHER_EVIL);
    await guildLeft(OTHER_EVIL);
    const lines = [...h.logs.log, ...h.logs.error].filter((l) => l.includes("Evil"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).not.toContain("\n");
      expect(l).not.toContain(ESC);
      expect(l).toContain(FFFD);
    }
    await guildJoined({ id: OTHER, name: "x".repeat(300) });
    expect(h.logs.log.some((l) => l.includes(`${"x".repeat(80)} (${OTHER})`) && !l.includes("x".repeat(81)))).toBe(true);
  });

  // The join REASON reaches a log line only when the discovery write fails (writeView's catch prints it).
  const failingWrite = async (join: (h: ReturnType<typeof harness>) => Promise<void>) => {
    mkdirSync(discoveryPath(dir)); // a directory where the file goes: the write fails
    const h = harness();
    h.world.guilds.get(OTHER)!.name = EVIL;
    h.world.guilds.get(HOME)!.name = EVIL;
    initRouting(h.ctx);
    await join(h);
    const line = h.logs.error.find((l) => l.includes("writing discovery.json failed (joined"));
    expect(line).toBeDefined();
    expect(line).not.toContain("\n");
    expect(line).not.toContain(ESC);
    expect(line).toContain(FFFD);
  };

  test("L9b: the join reason is one line on the narrow path, the fallback path and a single-mode home join", async () => {
    await placeMusicInOther();
    // the fallback path: no full run has completed in this process
    await failingWrite(() => guildJoined(OTHER_EVIL));
    resetRoutingForTest();
    rmSync(discoveryPath(dir), { recursive: true, force: true });
    // the narrow path: a full run completed (its own discovery write fails, which is fine), then the join
    await failingWrite(async (h) => {
      await applyRouting("boot");
      h.logs.error.length = 0;
      await guildJoined(OTHER_EVIL);
    });
    resetRoutingForTest();
    rmSync(discoveryPath(dir), { recursive: true, force: true });
    // a single-mode join of the home server
    await mutateRouting(dir, (c) => ({ ...c, plugins: {} }));
    await failingWrite(() => guildJoined({ id: HOME, name: EVIL }));
  });
});
