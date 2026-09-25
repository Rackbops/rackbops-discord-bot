import { describe, expect, test } from "bun:test";
import { freshRouting, type DiscoveryFile, type PluginRouting, type RoutingFile } from "./model";
import {
  announceTargets,
  commandAllowed,
  destinationChannel,
  hasPlacements,
  isPlaced,
  mappedDestinations,
  pluginsForGuild,
  validatePluginRouting,
} from "./resolve";

const HOME = "111111111111111111";
const OTHER = "222222222222222222";
const THIRD = "333333333333333333";
const HOME_CHAN = "111111111111111001";
const HOME_CHAN_2 = "111111111111111002";
const OTHER_CHAN = "222222222222222001";
const OTHER_CHAN_2 = "222222222222222002";
const THREAD = "555555555555555555";
const DEFAULT_CHANNEL = "999999999999999999";

function routing(plugins: Record<string, PluginRouting>): RoutingFile {
  return { ...freshRouting(), plugins };
}

function discovery(): DiscoveryFile {
  return {
    v: 1,
    generatedAt: "2026-09-21T00:00:00.000Z",
    bot: { id: "900000000000000000", username: "bot" },
    inviteUrl: "https://discord.com/oauth2/authorize?client_id=900000000000000000&scope=bot+applications.commands",
    homeGuildId: HOME,
    guilds: [
      {
        id: HOME,
        name: "Home",
        channels: [
          { id: HOME_CHAN, name: "general", canSend: true },
          { id: HOME_CHAN_2, name: "music", canSend: true },
        ],
        commands: { registered: 3, at: "2026-09-21T00:00:00.000Z" },
      },
      {
        id: OTHER,
        name: "Other",
        channels: [
          { id: OTHER_CHAN, name: "spotify", canSend: true },
          { id: OTHER_CHAN_2, name: "chat", canSend: false },
        ],
        commands: null,
      },
    ],
    plugins: {},
  };
}

describe("isPlaced / hasPlacements", () => {
  test("hasPlacements is false for a fresh file and true once a plugin is placed", () => {
    expect(hasPlacements(freshRouting())).toBe(false);
    expect(hasPlacements(routing({ music: { servers: { [OTHER]: { commands: "all" } } } }))).toBe(true);
    // A plugin placed nowhere is still a placement: the file asks for per-server registration.
    expect(hasPlacements(routing({ music: { servers: {} } }))).toBe(true);
  });

  test("a plugin is placed when it has an entry, even one with no servers", () => {
    const r = routing({ music: { servers: {} }, wow: { servers: { [HOME]: { commands: "all" } } } });
    expect(isPlaced(r, "music")).toBe(true);
    expect(isPlaced(r, "wow")).toBe(true);
    expect(isPlaced(r, "other")).toBe(false);
  });

  test("a plugin named like an inherited property is not placed just because Object has one", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(isPlaced(freshRouting(), name)).toBe(false);
      expect(pluginsForGuild(freshRouting(), OTHER, [name], HOME)).toEqual([]);
      expect(pluginsForGuild(freshRouting(), HOME, [name], HOME)).toEqual([name]);
      expect(commandAllowed(freshRouting(), name, OTHER, "1", undefined)).toEqual({ allowed: true });
      expect(announceTargets(freshRouting(), name, DEFAULT_CHANNEL)).toEqual([DEFAULT_CHANNEL]);
    }
  });
});

describe("a server id named like an inherited property", () => {
  test("is not a server a plugin lives in, and never throws", () => {
    // Real server ids are snowflakes; the point is that a lookup keyed by an arbitrary string must
    // not answer for `constructor` just because Object has one.
    const r = routing({ music: { servers: { [OTHER]: { commands: [OTHER_CHAN] } } } });
    for (const guildId of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(pluginsForGuild(r, guildId, ["music"], HOME)).toEqual([]);
      expect(commandAllowed(r, "music", guildId, OTHER_CHAN)).toEqual({ allowed: true });
      expect(commandAllowed(r, "music", guildId, "1", "2")).toEqual({ allowed: true });
    }
  });
});

describe("pluginsForGuild", () => {
  test("an unplaced plugin lives in the home server only", () => {
    const loaded = ["music", "wow"];
    expect(pluginsForGuild(freshRouting(), HOME, loaded, HOME)).toEqual(["music", "wow"]);
    expect(pluginsForGuild(freshRouting(), OTHER, loaded, HOME)).toEqual([]);
  });

  test("with no home server an unplaced plugin lives everywhere", () => {
    const loaded = ["music", "wow"];
    expect(pluginsForGuild(freshRouting(), HOME, loaded, undefined)).toEqual(["music", "wow"]);
    expect(pluginsForGuild(freshRouting(), OTHER, loaded, undefined)).toEqual(["music", "wow"]);
    expect(pluginsForGuild(freshRouting(), THIRD, loaded, undefined)).toEqual(["music", "wow"]);
  });

  test("a placed plugin lives only in its servers", () => {
    // music is placed in OTHER only; wow has no entry, so it is unplaced and stays at home.
    const r = routing({ music: { servers: { [OTHER]: { commands: "all" } } } });
    const loaded = ["music", "wow"];
    expect(pluginsForGuild(r, HOME, loaded, HOME)).toEqual(["wow"]);
    expect(pluginsForGuild(r, OTHER, loaded, HOME)).toEqual(["music"]);
    expect(pluginsForGuild(r, THIRD, loaded, HOME)).toEqual([]);
    // Placement does not depend on there being a home server.
    expect(pluginsForGuild(r, HOME, loaded, undefined)).toEqual(["wow"]);
    expect(pluginsForGuild(r, OTHER, loaded, undefined)).toEqual(["music", "wow"]);
  });

  test("a plugin placed in several servers lives in each of them", () => {
    const r = routing({ music: { servers: { [HOME]: { commands: "all" }, [OTHER]: { commands: [OTHER_CHAN] } } } });
    expect(pluginsForGuild(r, HOME, ["music"], HOME)).toEqual(["music"]);
    expect(pluginsForGuild(r, OTHER, ["music"], HOME)).toEqual(["music"]);
    expect(pluginsForGuild(r, THIRD, ["music"], HOME)).toEqual([]);
  });

  test("a plugin placed nowhere lives nowhere", () => {
    // An entry with no servers is a decision ("nowhere"); no entry is the absence of one ("home").
    const r = routing({ music: { servers: {} } });
    expect(pluginsForGuild(r, HOME, ["music", "wow"], HOME)).toEqual(["wow"]);
    expect(pluginsForGuild(r, OTHER, ["music", "wow"], HOME)).toEqual([]);
    expect(pluginsForGuild(r, HOME, ["music"], undefined)).toEqual([]);
  });

  test("keeps the loaded order", () => {
    const r = routing({
      music: { servers: { [OTHER]: { commands: "all" } } },
      alpha: { servers: { [OTHER]: { commands: "all" } } },
    });
    // Neither the file's key order nor the alphabet: `loaded`'s.
    expect(pluginsForGuild(r, OTHER, ["wow", "music", "zeta", "alpha"], OTHER)).toEqual(["wow", "music", "zeta", "alpha"]);
    expect(pluginsForGuild(r, OTHER, ["alpha", "music"], HOME)).toEqual(["alpha", "music"]);
    expect(pluginsForGuild(r, OTHER, [], HOME)).toEqual([]);
  });
});

describe("announceTargets", () => {
  test("a plugin with no postTo posts to the default channel", () => {
    expect(announceTargets(freshRouting(), "music", DEFAULT_CHANNEL)).toEqual([DEFAULT_CHANNEL]);
    // Placed, but only for its commands.
    const placed = routing({ music: { servers: { [OTHER]: { commands: "all" } } } });
    expect(announceTargets(placed, "music", DEFAULT_CHANNEL)).toEqual([DEFAULT_CHANNEL]);
    // Placed nowhere.
    expect(announceTargets(routing({ music: { servers: {} } }), "music", DEFAULT_CHANNEL)).toEqual([DEFAULT_CHANNEL]);
  });

  test("a plugin with a postTo posts there and not to the default channel", () => {
    const r = routing({ music: { servers: { [OTHER]: { commands: "all", postTo: OTHER_CHAN } } } });
    expect(announceTargets(r, "music", DEFAULT_CHANNEL)).toEqual([OTHER_CHAN]);
    // Another plugin's routing does not leak in.
    expect(announceTargets(r, "wow", DEFAULT_CHANNEL)).toEqual([DEFAULT_CHANNEL]);
  });

  test("several postTo are all used, once each, in guild order", () => {
    // Inserted out of order, and with two guilds naming the same channel. "99999" sorts before
    // "100000" as a NUMBER but after it as text, so this also pins the ordering itself.
    const r = routing({
      music: {
        servers: {
          [THIRD]: { commands: "all", postTo: "300" + "0".repeat(15) },
          "100000": { commands: "all", postTo: "888888888888888888" },
          [HOME]: { commands: "all", postTo: HOME_CHAN },
          "99999": { commands: "all", postTo: "777777777777777777" },
          [OTHER]: { commands: "all", postTo: HOME_CHAN },
          "55555": { commands: "all" },
        },
      },
    });
    expect(announceTargets(r, "music", DEFAULT_CHANNEL)).toEqual([
      "777777777777777777", // guild 99999
      "888888888888888888", // guild 100000
      HOME_CHAN, // guild HOME (and OTHER, which repeats it -- once)
      "300" + "0".repeat(15), // guild THIRD
    ]);
  });
});

describe("commandAllowed", () => {
  test("an unplaced plugin's command is allowed anywhere", () => {
    expect(commandAllowed(freshRouting(), "music", HOME, HOME_CHAN)).toEqual({ allowed: true });
    expect(commandAllowed(freshRouting(), "music", OTHER, OTHER_CHAN, undefined)).toEqual({ allowed: true });
  });

  test("a server with no entry allows the command", () => {
    // music is placed, but only for HOME; asked about OTHER, the file has nothing to say.
    const r = routing({ music: { servers: { [HOME]: { commands: [HOME_CHAN] } } } });
    expect(commandAllowed(r, "music", OTHER, OTHER_CHAN)).toEqual({ allowed: true });
    // A plugin placed nowhere is allowed wherever it is asked, too.
    expect(commandAllowed(routing({ music: { servers: {} } }), "music", HOME, HOME_CHAN)).toEqual({ allowed: true });
  });

  test('"all" allows any channel', () => {
    const r = routing({ music: { servers: { [OTHER]: { commands: "all" } } } });
    for (const channel of [OTHER_CHAN, OTHER_CHAN_2, "1", THREAD]) {
      expect(commandAllowed(r, "music", OTHER, channel)).toEqual({ allowed: true });
    }
  });

  test("a listed channel is allowed and an unlisted one names the list", () => {
    const r = routing({ music: { servers: { [OTHER]: { commands: [OTHER_CHAN, HOME_CHAN_2] } } } });
    expect(commandAllowed(r, "music", OTHER, OTHER_CHAN)).toEqual({ allowed: true });
    expect(commandAllowed(r, "music", OTHER, HOME_CHAN_2)).toEqual({ allowed: true });
    expect(commandAllowed(r, "music", OTHER, OTHER_CHAN_2)).toEqual({
      allowed: false,
      channels: [OTHER_CHAN, HOME_CHAN_2],
    });
  });

  test("the list a refusal names is a copy, so the reply cannot change the routing", () => {
    const r = routing({ music: { servers: { [OTHER]: { commands: [OTHER_CHAN] } } } });
    const refused = commandAllowed(r, "music", OTHER, OTHER_CHAN_2);
    if (refused.allowed) throw new Error("expected a refusal");
    refused.channels.push("tampered");
    expect(r.plugins.music!.servers[OTHER]!.commands).toEqual([OTHER_CHAN]);
  });

  test("a thread under a listed channel is allowed", () => {
    const r = routing({ music: { servers: { [OTHER]: { commands: [OTHER_CHAN] } } } });
    // The thread's own id is not on the list; its parent is.
    expect(commandAllowed(r, "music", OTHER, THREAD, OTHER_CHAN)).toEqual({ allowed: true });
    // A thread under an unlisted channel is refused, as is one with no parent at all.
    expect(commandAllowed(r, "music", OTHER, THREAD, OTHER_CHAN_2)).toEqual({ allowed: false, channels: [OTHER_CHAN] });
    expect(commandAllowed(r, "music", OTHER, THREAD)).toEqual({ allowed: false, channels: [OTHER_CHAN] });
    // The parent is only consulted when there is one.
    expect(commandAllowed(r, "music", OTHER, THREAD, undefined)).toEqual({ allowed: false, channels: [OTHER_CHAN] });
  });
});

describe("validatePluginRouting", () => {
  const ok = { servers: { [OTHER]: { commands: [OTHER_CHAN], postTo: OTHER_CHAN } } };

  test("a well-formed routing is accepted as it stands", () => {
    expect(validatePluginRouting(ok, discovery())).toEqual({ ok: true, value: ok });
    expect(validatePluginRouting({ servers: { [HOME]: { commands: "all" } } }, discovery())).toEqual({
      ok: true,
      value: { servers: { [HOME]: { commands: "all" } } },
    });
  });

  test("an empty servers map is valid", () => {
    expect(validatePluginRouting({ servers: {} }, discovery())).toEqual({ ok: true, value: { servers: {} } });
  });

  test("unknown keys are stripped from the value", () => {
    const result = validatePluginRouting(
      {
        servers: { [OTHER]: { commands: [OTHER_CHAN], postTo: OTHER_CHAN, note: "x", webhook: "https://example.invalid" } },
        extra: 1,
      },
      discovery(),
    );
    expect(result).toEqual({ ok: true, value: { servers: { [OTHER]: { commands: [OTHER_CHAN], postTo: OTHER_CHAN } } } });
  });

  test("the value is a copy, not the caller's objects", () => {
    const input = { servers: { [OTHER]: { commands: [OTHER_CHAN] } } };
    const result = validatePluginRouting(input, discovery());
    if (!result.ok) throw new Error("expected acceptance");
    expect(result.value.servers[OTHER]).not.toBe(input.servers[OTHER]);
    expect(result.value.servers[OTHER]!.commands).not.toBe(input.servers[OTHER].commands);
  });

  test("routing must be an object with a servers object", () => {
    const reason = "routing must be an object with a servers object";
    for (const input of [null, undefined, 5, "x", [], { servers: null }, { servers: [] }, { servers: "x" }, {}]) {
      expect(validatePluginRouting(input, discovery())).toEqual({ ok: false, reason });
    }
  });

  test("server <id> is not one the bot is in", () => {
    expect(validatePluginRouting({ servers: { [THIRD]: { commands: "all" } } }, discovery())).toEqual({
      ok: false,
      reason: `server ${THIRD} is not one the bot is in`,
    });
    // The first problem is reported, even when a valid server precedes it.
    expect(
      validatePluginRouting({ servers: { [HOME]: { commands: "all" }, [THIRD]: { commands: "all" } } }, discovery()),
    ).toEqual({ ok: false, reason: `server ${THIRD} is not one the bot is in` });
  });

  test("a server key that is an object property name is not a server the bot is in", () => {
    const hostile = JSON.parse('{"servers":{"__proto__":{"commands":"all"}}}') as unknown;
    expect(validatePluginRouting(hostile, discovery())).toEqual({
      ok: false,
      reason: "server __proto__ is not one the bot is in",
    });
    expect(validatePluginRouting({ servers: { constructor: { commands: "all" } } }, discovery())).toEqual({
      ok: false,
      reason: "server constructor is not one the bot is in",
    });
  });

  test('commands for server <id> must be "all" or a list of channels', () => {
    const reason = `commands for server ${OTHER} must be "all" or a list of channels`;
    for (const server of [{}, { commands: null }, { commands: "some" }, { commands: 7 }, { commands: {} }, null, "all", []]) {
      expect(validatePluginRouting({ servers: { [OTHER]: server } }, discovery())).toEqual({ ok: false, reason });
    }
  });

  test("the channel list for server <id> is empty", () => {
    expect(validatePluginRouting({ servers: { [OTHER]: { commands: [] } } }, discovery())).toEqual({
      ok: false,
      reason: `the channel list for server ${OTHER} is empty`,
    });
  });

  test("channel <id> is not in server <id>", () => {
    // A real channel, but of another server.
    expect(validatePluginRouting({ servers: { [OTHER]: { commands: [OTHER_CHAN, HOME_CHAN] } } }, discovery())).toEqual({
      ok: false,
      reason: `channel ${HOME_CHAN} is not in server ${OTHER}`,
    });
    // One that exists nowhere, and one that is not even text.
    expect(validatePluginRouting({ servers: { [OTHER]: { commands: ["12345"] } } }, discovery())).toEqual({
      ok: false,
      reason: `channel 12345 is not in server ${OTHER}`,
    });
    expect(validatePluginRouting({ servers: { [OTHER]: { commands: [42] } } }, discovery())).toEqual({
      ok: false,
      reason: `channel 42 is not in server ${OTHER}`,
    });
  });

  test("postTo <id> is not in server <id>", () => {
    expect(
      validatePluginRouting({ servers: { [OTHER]: { commands: "all", postTo: HOME_CHAN } } }, discovery()),
    ).toEqual({ ok: false, reason: `postTo ${HOME_CHAN} is not in server ${OTHER}` });
    expect(validatePluginRouting({ servers: { [OTHER]: { commands: "all", postTo: 7 } } }, discovery())).toEqual({
      ok: false,
      reason: `postTo 7 is not in server ${OTHER}`,
    });
    expect(validatePluginRouting({ servers: { [OTHER]: { commands: "all", postTo: null } } }, discovery())).toEqual({
      ok: false,
      reason: `postTo null is not in server ${OTHER}`,
    });
  });

  test("a channel the bot cannot post in is still a channel in the server", () => {
    // `canSend` is the panel's hint, not a validity rule: OTHER_CHAN_2 is listed with canSend false.
    expect(validatePluginRouting({ servers: { [OTHER]: { commands: [OTHER_CHAN_2] } } }, discovery())).toEqual({
      ok: true,
      value: { servers: { [OTHER]: { commands: [OTHER_CHAN_2] } } },
    });
  });

  test("a hostile value is not echoed back at length", () => {
    const long = "x".repeat(100_000);
    const result = validatePluginRouting({ servers: { [OTHER]: { commands: [long] } } }, discovery());
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason.length).toBeLessThan(150);
    expect(result.reason.startsWith("channel xxxxxxxx")).toBe(true);
    const bigServer = validatePluginRouting({ servers: { [long]: { commands: "all" } } }, discovery());
    if (bigServer.ok) throw new Error("expected rejection");
    expect(bigServer.reason.length).toBeLessThan(150);
  });

  test("an echoed value of 40 characters is kept whole and one of 41 is clipped to 37 and an ellipsis", () => {
    const reason = (value: string) => {
      const result = validatePluginRouting({ servers: { [OTHER]: { commands: [value] } } }, discovery());
      if (result.ok) throw new Error("expected rejection");
      return result.reason;
    };
    expect(reason("x".repeat(40))).toBe(`channel ${"x".repeat(40)} is not in server ${OTHER}`);
    expect(reason("x".repeat(41))).toBe(`channel ${"x".repeat(37)}... is not in server ${OTHER}`);
    expect(reason("x".repeat(1_000_000))).toBe(`channel ${"x".repeat(37)}... is not in server ${OTHER}`);
  });

  test("a clipped reason never cuts a surrogate pair in half, and a lone surrogate is replaced, so it can always be URL-encoded", () => {
    const reason = (value: string) => {
      const result = validatePluginRouting({ servers: { [OTHER]: { commands: [value] } } }, discovery());
      if (result.ok) throw new Error("expected rejection");
      return result.reason;
    };
    // 50 emoji is 100 UTF-16 units: a clip by units lands in the middle of one.
    const clipped = reason("\u{1F600}".repeat(50));
    expect(clipped).toBe(`channel ${"\u{1F600}".repeat(37)}... is not in server ${OTHER}`);
    expect(() => encodeURIComponent(clipped)).not.toThrow();
    // A lone surrogate straight from JSON (`"\ud83d"`), on its own and inside longer text.
    for (const lone of ["\ud83d", "a\udc00b", "\ude00\ud83d", `${"y".repeat(60)}\ud83d`]) {
      const echoed = reason(lone);
      expect(() => encodeURIComponent(echoed)).not.toThrow();
      expect(echoed).not.toMatch(/[\ud800-\udfff]/);
    }
    expect(reason("\ud83d")).toBe(`channel ${String.fromCharCode(0xfffd)} is not in server ${OTHER}`);
    // A lone surrogate INSIDE the part that is kept (position 10 of a long text) is replaced too --
    // replacing only in short texts would leave it there, because the clip only removes the tail.
    const inside = reason(`${"y".repeat(10)}\ud83d${"z".repeat(60)}`);
    expect(inside).toBe(`channel ${"y".repeat(10)}${String.fromCharCode(0xfffd)}${"z".repeat(26)}... is not in server ${OTHER}`);
    expect(() => encodeURIComponent(inside)).not.toThrow();
    // A well-formed pair is left alone.
    expect(reason("a\u{1F600}b")).toBe(`channel a\u{1F600}b is not in server ${OTHER}`);
  });

  test("whether to clip is decided on UTF-16 length, the cut on code points: a short emoji run still gets the ellipsis", () => {
    // Documents the two measures in `shown()`'s comment. 30 emoji are 60 UTF-16 units (over the 40
    // that trigger a clip) but only 30 code points (under the 37 that are kept): nothing is cut, and
    // the ellipsis is appended anyway. Only a hostile value ever looks like this.
    const result = validatePluginRouting({ servers: { [OTHER]: { commands: ["\u{1F600}".repeat(30)] } } }, discovery());
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toBe(`channel ${"\u{1F600}".repeat(30)}... is not in server ${OTHER}`);
  });

  test("an unserialisable value is reported rather than thrown on", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const bare = Object.create(null) as Record<string, unknown>;
    bare.self = bare;
    for (const bad of [circular, bare, 10n, Symbol("s"), () => 1]) {
      const result = validatePluginRouting({ servers: { [OTHER]: { commands: [bad] } } }, discovery());
      expect(result.ok).toBe(false);
    }
  });

  test("JSON nested far past the stack is reported, not thrown on", () => {
    // ~200,000 levels is only ~400 KB of JSON. Printing such a value overflows the stack in
    // JSON.stringify, and again in any fallback that tries String() on it -- so a rejection reason
    // must never print a list or an object, only name it.
    let deep: unknown = [];
    for (let i = 0; i < 200_000; i += 1) deep = [deep];
    const asChannel = validatePluginRouting({ servers: { [OTHER]: { commands: [deep] } } }, discovery());
    expect(asChannel).toEqual({ ok: false, reason: `channel [list] is not in server ${OTHER}` });
    const asPostTo = validatePluginRouting({ servers: { [OTHER]: { commands: "all", postTo: deep } } }, discovery());
    expect(asPostTo).toEqual({ ok: false, reason: `postTo [list] is not in server ${OTHER}` });
    // The same shape from JSON text, the way a request file would arrive.
    const text = `{"servers":{"${OTHER}":{"commands":[${"[".repeat(5000)}${"]".repeat(5000)}]}}}`;
    expect(validatePluginRouting(JSON.parse(text) as unknown, discovery()).ok).toBe(false);
  });

  test("a list or an object is named in the reason, not printed", () => {
    expect(validatePluginRouting({ servers: { [OTHER]: { commands: [{ a: 1 }] } } }, discovery())).toEqual({
      ok: false,
      reason: `channel [object] is not in server ${OTHER}`,
    });
    expect(validatePluginRouting({ servers: { [OTHER]: { commands: [[OTHER_CHAN]] } } }, discovery())).toEqual({
      ok: false,
      reason: `channel [list] is not in server ${OTHER}`,
    });
  });
});

describe("announceTargets with a named destination (#219)", () => {
  const r = routing({
    feed: {
      servers: {
        [OTHER]: { commands: "all", postTo: OTHER_CHAN, destinations: { news: OTHER_CHAN_2 } },
        [HOME]: { commands: "all", postTo: HOME_CHAN, destinations: { news: HOME_CHAN_2, alerts: HOME_CHAN_2 } },
      },
    },
  });

  test("goes to every channel the name is mapped to, once each, in guild order -- and not to postTo", () => {
    expect(announceTargets(r, "feed", DEFAULT_CHANNEL, "news")).toEqual([HOME_CHAN_2, OTHER_CHAN_2]);
    expect(announceTargets(r, "feed", DEFAULT_CHANNEL, "alerts")).toEqual([HOME_CHAN_2]);
  });

  test("a name mapped nowhere posts where the plugin posts without one", () => {
    expect(announceTargets(r, "feed", DEFAULT_CHANNEL, "digest")).toEqual([HOME_CHAN, OTHER_CHAN]);
    const noPostTo = routing({ feed: { servers: { [HOME]: { commands: "all" } } } });
    expect(announceTargets(noPostTo, "feed", DEFAULT_CHANNEL, "news")).toEqual([DEFAULT_CHANNEL]);
    expect(announceTargets(freshRouting(), "feed", DEFAULT_CHANNEL, "news")).toEqual([DEFAULT_CHANNEL]);
  });

  test("an inherited key is not a mapped name, and another plugin's names do not leak in", () => {
    expect(announceTargets(r, "feed", DEFAULT_CHANNEL, "constructor")).toEqual([HOME_CHAN, OTHER_CHAN]);
    expect(announceTargets(r, "other", DEFAULT_CHANNEL, "news")).toEqual([DEFAULT_CHANNEL]);
  });
});

describe("destinationChannel (#736)", () => {
  const r = routing({
    feed: {
      servers: {
        [HOME]: { commands: "all", destinations: { news: HOME_CHAN_2 } },
        [OTHER]: { commands: "all", destinations: { alerts: OTHER_CHAN_2 } },
      },
    },
  });

  test("a mapped destination resolves to its channel", () => {
    expect(destinationChannel(r, "feed", HOME, "news")).toBe(HOME_CHAN_2);
  });

  test("an unplaced plugin resolves to undefined", () => {
    expect(destinationChannel(r, "other", HOME, "news")).toBeUndefined();
  });

  test("placed, but not in this server, resolves to undefined", () => {
    expect(destinationChannel(r, "feed", THIRD, "news")).toBeUndefined();
  });

  test("a name mapped only in another guild resolves to undefined here -- no fallback, unlike announceTargets", () => {
    expect(destinationChannel(r, "feed", HOME, "alerts")).toBeUndefined();
    expect(destinationChannel(r, "feed", OTHER, "news")).toBeUndefined();
  });

  test("an inherited key is never a match, for the plugin, the guild id or the destination name", () => {
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(destinationChannel(r, "feed", key, "news")).toBeUndefined();
      expect(destinationChannel(r, "feed", HOME, key)).toBeUndefined();
      expect(destinationChannel(r, key, HOME, "news")).toBeUndefined();
    }
  });
});

describe("mappedDestinations (#736)", () => {
  test("lists every mapped destination, guilds ordered by id, destinations in insertion order", () => {
    const r = routing({
      feed: {
        servers: {
          [OTHER]: { commands: "all", destinations: { news: OTHER_CHAN_2 } },
          [HOME]: { commands: "all", destinations: { news: HOME_CHAN_2, alerts: HOME_CHAN_2 } },
        },
      },
    });
    expect(mappedDestinations(r, "feed")).toEqual([
      { guildId: HOME, destination: "news", channelId: HOME_CHAN_2 },
      { guildId: HOME, destination: "alerts", channelId: HOME_CHAN_2 },
      { guildId: OTHER, destination: "news", channelId: OTHER_CHAN_2 },
    ]);
    expect(mappedDestinations(r, "other")).toEqual([]);
  });

  test("a server with no destinations contributes nothing, and placed-nowhere is empty", () => {
    const noDestinations = routing({ feed: { servers: { [HOME]: { commands: "all" } } } });
    expect(mappedDestinations(noDestinations, "feed")).toEqual([]);
    expect(mappedDestinations(routing({ feed: { servers: {} } }), "feed")).toEqual([]);
  });
});

describe("validatePluginRouting with destinations (#219)", () => {
  test("a declared name mapped to a channel in that server is kept", () => {
    const input = { servers: { [HOME]: { commands: "all" as const, destinations: { news: HOME_CHAN_2 } } } };
    expect(validatePluginRouting(input, discovery(), ["news"])).toEqual({ ok: true, value: input });
  });

  test("an empty map is dropped from the value rather than written", () => {
    const result = validatePluginRouting({ servers: { [HOME]: { commands: "all", destinations: {} } } }, discovery(), ["news"]);
    expect(result).toEqual({ ok: true, value: { servers: { [HOME]: { commands: "all" } } } });
  });

  test("a name the plugin does not declare is refused -- by default it declares none", () => {
    const input = { servers: { [HOME]: { commands: "all", destinations: { news: HOME_CHAN_2 } } } };
    expect(validatePluginRouting(input, discovery(), ["alerts"])).toEqual({ ok: false, reason: "destination news is not one this plugin declares" });
    expect(validatePluginRouting(input, discovery())).toMatchObject({ ok: false });
  });

  test("a channel from another server, or not a string, is refused", () => {
    expect(validatePluginRouting({ servers: { [HOME]: { commands: "all", destinations: { news: OTHER_CHAN } } } }, discovery(), ["news"])).toEqual({
      ok: false,
      reason: `destination news: channel ${OTHER_CHAN} is not in server ${HOME}`,
    });
    expect(validatePluginRouting({ servers: { [HOME]: { commands: "all", destinations: { news: 5 } } } }, discovery(), ["news"])).toMatchObject({ ok: false });
  });

  test("a declared name that is not a valid destination name is refused, whatever discovery.json says", () => {
    const input = JSON.parse(`{"servers":{"${HOME}":{"commands":"all","destinations":{"__proto__":"${HOME_CHAN_2}"}}}}`);
    expect(validatePluginRouting(input, discovery(), ["__proto__"])).toMatchObject({ ok: false });
  });

  test("destinations that is not an object is refused", () => {
    for (const destinations of [[HOME_CHAN], "x", null]) {
      expect(validatePluginRouting({ servers: { [HOME]: { commands: "all", destinations } } }, discovery(), ["news"])).toEqual({
        ok: false,
        reason: `destinations for server ${HOME} must be an object`,
      });
    }
  });

  test("the kept map is a copy, not the caller's object", () => {
    const destinations = { news: HOME_CHAN_2 };
    const result = validatePluginRouting({ servers: { [HOME]: { commands: "all", destinations } } }, discovery(), ["news"]);
    if (!result.ok) throw new Error("expected acceptance");
    expect(result.value.servers[HOME]!.destinations).not.toBe(destinations);
  });
});
