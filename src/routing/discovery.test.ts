import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import type { LoadedPlugin, PluginCommandMap } from "../plugins/host";
import type { Plugin, PluginCommand, PluginIndexEntry, TickCheck } from "../plugins/contract";
import { buildDiscovery, describePlugins, discoveryPath, inviteUrl, snapshotGuilds, writeDiscovery } from "./discovery";
import type { GuildSnapshot } from "./discovery";
import type { GuildRegistration } from "./register";

const HOME = "111111111111111111";
const OTHER = "222222222222222222";
const BOT = { id: "900000000000000000", username: "Setlist Bot" };
const NOW = new Date("2026-09-21T12:00:00.000Z");
const AT = "2026-09-21T11:59:00.000Z";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "discovery-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------
// snapshotGuilds -- structural fakes cast to Client<true>; only what the function reads is modelled.
// ---------------------------------------------------------------------------------------------------

type Perms = { has: (flags: unknown) => boolean } | null | undefined;
interface FakeChannel {
  id: string;
  name: string;
  type: ChannelType;
  rawPosition: number;
  permissionsFor: (user: unknown) => Perms;
}

const allowed: Perms = { has: () => true };

function channel(id: string, name: string, type: ChannelType, rawPosition: number, perms: Perms = allowed): FakeChannel {
  return { id, name, type, rawPosition, permissionsFor: () => perms };
}

function fakeClient(guilds: { id: string; name: string; channels: FakeChannel[] }[]): Client<true> {
  const cache = new Map(
    guilds.map((g) => [g.id, { id: g.id, name: g.name, channels: { cache: new Map(g.channels.map((c) => [c.id, c])) } }]),
  );
  return { user: { id: BOT.id }, guilds: { cache } } as unknown as Client<true>;
}

describe("snapshotGuilds", () => {
  test("snapshotGuilds keeps text and announcement channels only, in position order", () => {
    const client = fakeClient([
      {
        id: HOME,
        name: "Home",
        channels: [
          channel("1001", "voice-chat", ChannelType.GuildVoice, 0),
          channel("1002", "zeta", ChannelType.GuildText, 3),
          channel("1003", "General Stuff", ChannelType.GuildCategory, 0),
          channel("1004", "alpha", ChannelType.GuildText, 1),
          channel("1005", "news", ChannelType.GuildAnnouncement, 2),
          channel("1006", "the-forum", ChannelType.GuildForum, 4),
          channel("1007", "stage", ChannelType.GuildStageVoice, 5),
          channel("1008", "a-thread", ChannelType.PublicThread, 6),
        ],
      },
    ]);
    expect(snapshotGuilds(client)).toEqual([
      {
        id: HOME,
        name: "Home",
        channels: [
          { id: "1004", name: "alpha", canSend: true },
          { id: "1005", name: "news", canSend: true },
          { id: "1002", name: "zeta", canSend: true },
        ],
      },
    ]);
  });

  test("channels with the same position are ordered by name, then by id", () => {
    const client = fakeClient([
      {
        id: HOME,
        name: "Home",
        channels: [
          channel("1003", "beta", ChannelType.GuildText, 1),
          channel("1002", "alpha", ChannelType.GuildText, 1),
          channel("1001", "alpha", ChannelType.GuildText, 1),
        ],
      },
    ]);
    expect(snapshotGuilds(client)[0]!.channels.map((c) => c.id)).toEqual(["1001", "1002", "1003"]);
  });

  test("servers are ordered by name", () => {
    const client = fakeClient([
      { id: OTHER, name: "Zebra", channels: [] },
      { id: HOME, name: "Aardvark", channels: [] },
    ]);
    expect(snapshotGuilds(client).map((g) => g.name)).toEqual(["Aardvark", "Zebra"]);
  });

  test("canSend is false without Send Messages, and false when permissions cannot be computed", () => {
    const asked: unknown[] = [];
    const view = { has: (flags: unknown) => { asked.push(flags); return false; } };
    const client = fakeClient([
      {
        id: HOME,
        name: "Home",
        channels: [
          channel("1001", "can", ChannelType.GuildText, 1),
          // A permission set that says no (e.g. Send Messages is denied here).
          channel("1002", "cannot", ChannelType.GuildText, 2, view),
          // permissionsFor returns null when the bot's member is not cached, and undefined never
          // should -- both must read as "cannot", not throw.
          channel("1003", "unknown", ChannelType.GuildText, 3, null),
          // (built by hand: `channel()`'s default parameter would turn an explicit undefined into "allowed")
          { ...channel("1004", "undefined", ChannelType.GuildText, 4), permissionsFor: () => undefined },
        ],
      },
    ]);
    expect(snapshotGuilds(client)[0]!.channels.map((c) => [c.name, c.canSend])).toEqual([
      ["can", true],
      ["cannot", false],
      ["unknown", false],
      ["undefined", false],
    ]);
    // It asked for BOTH: seeing the channel and sending in it.
    expect(asked).toEqual([[PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]]);
  });

  test("an unavailable server, whose name discord.js leaves unset, is listed under its id", () => {
    const client = fakeClient([
      { id: OTHER, name: "Zebra", channels: [] },
      { id: HOME, name: undefined as unknown as string, channels: [] },
    ]);
    const snapshots = snapshotGuilds(client);
    // A name is always text (so the file has the `name` its shape promises) and the order is by it.
    expect(snapshots.map((g) => g.name)).toEqual([HOME, "Zebra"]);
    expect(JSON.parse(JSON.stringify(snapshots))[0]).toHaveProperty("name", HOME);
  });

  test("a server the bot can see no channels in is still listed, with none", () => {
    expect(snapshotGuilds(fakeClient([{ id: HOME, name: "Home", channels: [] }]))).toEqual([{ id: HOME, name: "Home", channels: [] }]);
  });

  test("a bot in no servers is an empty list", () => {
    expect(snapshotGuilds(fakeClient([]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// inviteUrl / describePlugins
// ---------------------------------------------------------------------------------------------------

describe("inviteUrl", () => {
  test("inviteUrl carries both scopes and the app id", () => {
    const url = inviteUrl(BOT.id);
    expect(url).toBe(`https://discord.com/oauth2/authorize?client_id=${BOT.id}&scope=bot+applications.commands&permissions=2048`);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("client_id")).toBe(BOT.id);
    // `+` in a query is a space: two scopes, `bot` and `applications.commands`.
    expect(parsed.searchParams.get("scope")?.split(" ")).toEqual(["bot", "applications.commands"]);
    expect(parsed.searchParams.get("permissions")).toBe("2048");
  });
});

function loaded(name: string, plugin: Partial<Plugin>): LoadedPlugin {
  return { entry: { name } as PluginIndexEntry, version: "1.0.0", plugin: plugin as Plugin, running: true };
}

const tick: TickCheck = { name: "poll", run: async () => {} };

describe("describePlugins", () => {
  const map: PluginCommandMap = new Map([
    ["setlist", { entry: { name: "music" } as PluginIndexEntry, command: { name: "setlist" } as PluginCommand }],
    ["dmf", { entry: { name: "wow" } as PluginIndexEntry, command: { name: "dmf" } as PluginCommand }],
  ]);
  const fullBody = [{ name: "r_report" }, { name: "r_setlist" }, { name: "r_dmf" }];

  test("a plugin with ticks posts, one without does not", () => {
    const summary = describePlugins([loaded("wow", { ticks: [tick] }), loaded("music", {}), loaded("quiet", { ticks: [] })], fullBody, "r_", map);
    expect(summary.map((p) => [p.name, p.posts])).toEqual([
      ["wow", true],
      ["music", false],
      ["quiet", false],
    ]);
  });

  test("a malformed or throwing ticks value reads as no ticks and never escapes", () => {
    const throwing = {
      get ticks(): TickCheck[] {
        throw new Error("plugin bug");
      },
    };
    const summary = describePlugins(
      [loaded("a", throwing), loaded("b", { ticks: 5 as unknown as TickCheck[] }), loaded("c", { ticks: null as unknown as TickCheck[] })],
      [],
      "",
      new Map(),
    );
    // A throwing getter, a value that is not iterable, and null: none reads as "posts", none throws.
    expect(summary.map((p) => p.posts)).toEqual([false, false, false]);
  });

  test("each plugin lists the commands it registered, as registered (prefixed), core excluded", () => {
    const summary = describePlugins([loaded("music", {}), loaded("wow", {}), loaded("silent", {})], fullBody, "r_", map);
    expect(summary.map((p) => [p.name, p.commands])).toEqual([
      ["music", ["r_setlist"]],
      ["wow", ["r_dmf"]],
      ["silent", []],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------
// buildDiscovery / writeDiscovery
// ---------------------------------------------------------------------------------------------------

const snapshots: GuildSnapshot[] = [
  { id: HOME, name: "Home", channels: [{ id: "1001", name: "general", canSend: true }, { id: "1002", name: "locked", canSend: false }] },
  { id: OTHER, name: "Other", channels: [] },
];
const plugins = [
  { name: "music", commands: ["setlist", "spotify"], posts: false },
  { name: "wow", commands: ["dmf"], posts: true },
];

function build(over: Partial<Parameters<typeof buildDiscovery>[0]> = {}) {
  return buildDiscovery({ now: NOW, bot: BOT, homeGuildId: HOME, snapshots, registrations: [], plugins, ...over });
}

describe("buildDiscovery", () => {
  test("a guild's commands are its registration, or null", () => {
    const registrations: GuildRegistration[] = [{ guildId: HOME, registered: 7, at: AT }];
    const file = build({ registrations });
    expect(file.guilds.find((g) => g.id === HOME)!.commands).toEqual({ registered: 7, at: AT });
    // OTHER was never registered in (single mode registers only in the home server): null, not zero.
    expect(file.guilds.find((g) => g.id === OTHER)!.commands).toBeNull();
  });

  test("a refusal is carried against its server, and only there", () => {
    const registrations: GuildRegistration[] = [
      { guildId: HOME, registered: 7, at: AT },
      { guildId: OTHER, registered: 0, error: "Missing Access (50001)", at: AT },
    ];
    const file = build({ registrations });
    expect(file.guilds.find((g) => g.id === HOME)!.commands).toEqual({ registered: 7, at: AT });
    expect(file.guilds.find((g) => g.id === OTHER)!.commands).toEqual({ registered: 0, error: "Missing Access (50001)", at: AT });
  });

  test("a global registration belongs to no one server, so every server reads null", () => {
    const file = build({ registrations: [{ guildId: "global", registered: 7, at: AT }] });
    expect(file.guilds.map((g) => g.commands)).toEqual([null, null]);
  });

  test("homeGuildId is null when unset", () => {
    expect(build({ homeGuildId: undefined }).homeGuildId).toBeNull();
    expect(build().homeGuildId).toBe(HOME);
  });

  test("a server with no text channels and a plugin with no ticks are both represented", () => {
    const file = build();
    expect(file.guilds.find((g) => g.id === OTHER)).toEqual({ id: OTHER, name: "Other", channels: [], commands: null });
    expect(file.plugins.music).toEqual({ posts: false, commands: ["setlist", "spotify"] });
    expect(file.plugins.wow).toEqual({ posts: true, commands: ["dmf"] });
  });

  test("the file has exactly the documented top-level shape", () => {
    const file = build();
    expect(Object.keys(file).sort()).toEqual(["bot", "generatedAt", "guilds", "homeGuildId", "inviteUrl", "plugins", "v"]);
    expect(file.v).toBe(1);
    expect(file.generatedAt).toBe(NOW.toISOString());
    expect(file.bot).toEqual(BOT);
    expect(file.inviteUrl).toBe(inviteUrl(BOT.id));
  });

  test("a plugin named like an inherited property is an ordinary entry", () => {
    const file = build({ plugins: [{ name: "constructor", commands: ["x"], posts: true }] });
    expect(Object.hasOwn(file.plugins, "constructor")).toBe(true);
    expect(file.plugins["constructor"]).toEqual({ posts: true, commands: ["x"] });
    expect(Object.getPrototypeOf(file.plugins)).toBe(Object.prototype);
  });

  test("no servers and no plugins are empty, not missing", () => {
    const file = build({ snapshots: [], plugins: [] });
    expect(file.guilds).toEqual([]);
    expect(file.plugins).toEqual({});
  });

  test("the file shares nothing with its inputs", () => {
    const file = build();
    file.guilds[0]!.channels.push({ id: "9", name: "x", canSend: true });
    file.plugins.music!.commands.push("x");
    expect(snapshots[0]!.channels).toHaveLength(2);
    expect(plugins[0]!.commands).toEqual(["setlist", "spotify"]);
  });
});

describe("writeDiscovery", () => {
  test("writeDiscovery writes the documented shape", async () => {
    const registrations: GuildRegistration[] = [
      { guildId: HOME, registered: 7, at: AT },
      { guildId: OTHER, registered: 0, error: "Missing Access (50001)", at: AT },
    ];
    await writeDiscovery(dir, build({ registrations }));
    // Read back off disk, not from memory: the panel reads this file, not the process.
    const onDisk = JSON.parse(readFileSync(discoveryPath(dir), "utf8"));
    expect(onDisk).toEqual({
      v: 1,
      generatedAt: NOW.toISOString(),
      bot: BOT,
      inviteUrl: `https://discord.com/oauth2/authorize?client_id=${BOT.id}&scope=bot+applications.commands&permissions=2048`,
      homeGuildId: HOME,
      guilds: [
        {
          id: HOME,
          name: "Home",
          channels: [
            { id: "1001", name: "general", canSend: true },
            { id: "1002", name: "locked", canSend: false },
          ],
          commands: { registered: 7, at: AT },
        },
        { id: OTHER, name: "Other", channels: [], commands: { registered: 0, error: "Missing Access (50001)", at: AT } },
      ],
      plugins: { music: { posts: false, commands: ["setlist", "spotify"] }, wow: { posts: true, commands: ["dmf"] } },
    });
  });

  test("the path is discovery.json in the directory given, and the write leaves nothing else behind", async () => {
    expect(discoveryPath("/data")).toBe("/data/discovery.json");
    await writeDiscovery(dir, build());
    expect(readdirSync(dir)).toEqual(["discovery.json"]);
  });

  test("it creates the data directory when it does not exist yet", async () => {
    const nested = join(dir, "a", "b");
    await writeDiscovery(nested, build());
    expect(JSON.parse(readFileSync(discoveryPath(nested), "utf8")).v).toBe(1);
  });
});
