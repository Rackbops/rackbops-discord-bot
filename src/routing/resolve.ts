// Pure routing decisions (ADR-0006): which plugins live in a server, where a plugin posts, whether a
// command may run in a channel, and whether one plugin's routing, as the panel sent it, is
// acceptable. No I/O and no discord.js -- every function takes a `RoutingFile` (and, where it
// needs to know what the bot can see, a `DiscoveryFile`) and returns data, so all of it is tested
// as data. Nothing calls this yet: with #237 merged the bot behaves exactly as before.
//
// Placed vs unplaced is the one distinction to hold on to. A plugin with NO entry in
// `routing.json` is *unplaced* and lives in the home server; a plugin WITH an entry is *placed* and
// lives exactly where its `servers` say -- and an entry with `servers: {}` is placed, so it lives
// nowhere. The two are different on purpose: "nowhere" is a choice the operator made, while "no
// entry" is the state every plugin is in until someone chooses.
//
// A plugin name comes from the caller (the Plugin Index) and every key inside `routing.plugins` came
// from a file, so nothing here does a bare `routing.plugins[name]` lookup: it would answer for an
// inherited key like `constructor`. Lookups go through `Object.hasOwn`.

import type { CommandScope, DiscoveryFile, PluginRouting, RoutingFile, ServerRouting } from "./model";

/** The plugin's routing, or `undefined` when it has no entry of its own. */
function entryOf(routing: RoutingFile, plugin: string): PluginRouting | undefined {
  return Object.hasOwn(routing.plugins, plugin) ? routing.plugins[plugin] : undefined;
}

/** Has the operator placed this plugin at all? An entry with `servers: {}` IS placed -- it lives nowhere. */
export function isPlaced(routing: RoutingFile, plugin: string): boolean {
  return entryOf(routing, plugin) !== undefined;
}

/** Does anything in the file ask for per-server registration? */
export function hasPlacements(routing: RoutingFile): boolean {
  return Object.keys(routing.plugins).length > 0;
}

/**
 * Loaded plugins that live in `guildId`, in `loaded`'s order. An unplaced plugin lives in the home
 * server only; with no home server (`DISCORD_SERVER_ID` unset) it lives in every server.
 */
export function pluginsForGuild(
  routing: RoutingFile,
  guildId: string,
  loaded: readonly string[],
  homeGuildId: string | undefined,
): string[] {
  return loaded.filter((plugin) => {
    if (!isPlaced(routing, plugin)) return homeGuildId === undefined || homeGuildId === guildId;
    return Object.hasOwn(entryOf(routing, plugin)?.servers ?? {}, guildId);
  });
}

/** Snowflakes order numerically, not as strings ("99999" comes before "100000"). */
function compareIds(a: string, b: string): number {
  if (/^[0-9]+$/.test(a) && /^[0-9]+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Channels a plugin posts to: every `postTo` it has, de-duplicated, ordered by guild id; none
 * (unplaced, placed nowhere, or placed without a `postTo`) -> `[defaultChannelId]`.
 */
export function announceTargets(routing: RoutingFile, plugin: string, defaultChannelId: string): string[] {
  const servers = entryOf(routing, plugin)?.servers ?? {};
  const targets = new Set<string>();
  for (const guildId of Object.keys(servers).sort(compareIds)) {
    const postTo = servers[guildId]?.postTo;
    if (postTo !== undefined) targets.add(postTo);
  }
  return targets.size > 0 ? [...targets] : [defaultChannelId];
}

export type GateResult = { allowed: true } | { allowed: false; channels: string[] };

/**
 * May `plugin`'s command run here? Unplaced, no entry for this server, or "all" -> allowed. A list ->
 * allowed iff `channelId` or `parentChannelId` is on it (a thread counts as its parent channel);
 * otherwise refused, with the channels that would have worked so the reply can name them.
 */
export function commandAllowed(
  routing: RoutingFile,
  plugin: string,
  guildId: string,
  channelId: string,
  parentChannelId?: string,
): GateResult {
  const entry = entryOf(routing, plugin);
  const server = entry !== undefined && Object.hasOwn(entry.servers, guildId) ? entry.servers[guildId] : undefined;
  // No entry for this server -- the plugin is unplaced, or placed only elsewhere -- means nothing
  // restricts it here.
  if (server === undefined) return { allowed: true };
  const scope: CommandScope = server.commands;
  if (scope === "all") return { allowed: true };
  if (scope.includes(channelId) || (parentChannelId !== undefined && scope.includes(parentChannelId))) {
    return { allowed: true };
  }
  return { allowed: false, channels: [...scope] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A value that is about to be put in a message the panel shows. It cannot throw: a string is used as
 * it is, a list or an object is named rather than printed (printing one walks it, and JSON a hundred
 * kilobytes deep overflows the stack in `JSON.stringify` and again in any fallback), and everything
 * else is a primitive. Ids are at most 25 characters, so the clip changes nothing for a real request
 * and only stops a hostile one from echoing itself back at length.
 */
function shown(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "object" && value !== null) text = Array.isArray(value) ? "[list]" : "[object]";
  else if (typeof value === "function") text = "[function]";
  else text = String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

type Validation = { ok: true; value: PluginRouting } | { ok: false; reason: string };

/**
 * One plugin's routing as the panel sent it, checked against what the bot can see. Returns a clean
 * value (unknown keys stripped) or the FIRST problem, worded for the panel. `servers: {}` is valid:
 * it places the plugin nowhere.
 */
export function validatePluginRouting(input: unknown, discovery: DiscoveryFile): Validation {
  const fail = (reason: string): Validation => ({ ok: false, reason });
  if (!isRecord(input) || !isRecord(input.servers)) return fail("routing must be an object with a servers object");

  const servers: Record<string, ServerRouting> = {};
  for (const [guildId, raw] of Object.entries(input.servers)) {
    const guild = discovery.guilds.find((g) => g.id === guildId);
    if (guild === undefined) return fail(`server ${shown(guildId)} is not one the bot is in`);
    const badCommands = `commands for server ${guildId} must be "all" or a list of channels`;
    if (!isRecord(raw)) return fail(badCommands);
    const channels = new Set(guild.channels.map((c) => c.id));

    let commands: CommandScope;
    if (raw.commands === "all") {
      commands = "all";
    } else if (Array.isArray(raw.commands)) {
      if (raw.commands.length === 0) return fail(`the channel list for server ${guildId} is empty`);
      const listed: string[] = [];
      for (const channel of raw.commands) {
        if (typeof channel !== "string" || !channels.has(channel)) {
          return fail(`channel ${shown(channel)} is not in server ${guildId}`);
        }
        listed.push(channel);
      }
      commands = listed;
    } else {
      return fail(badCommands);
    }

    const clean: ServerRouting = { commands };
    if (raw.postTo !== undefined) {
      if (typeof raw.postTo !== "string" || !channels.has(raw.postTo)) {
        return fail(`postTo ${shown(raw.postTo)} is not in server ${guildId}`);
      }
      clean.postTo = raw.postTo;
    }
    servers[guildId] = clean;
  }
  return { ok: true, value: { servers } };
}
