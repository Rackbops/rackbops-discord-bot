// Pure routing decisions (ADR-0006): which plugins live in a server, where a plugin posts, whether a
// command may run in a channel, and whether one plugin's routing, as the panel sent it, is
// acceptable. No I/O and no discord.js -- every function takes plain data (a `RoutingFile`, or for
// `validatePluginRouting` the routing a panel sent plus the `DiscoveryFile` of what the bot can see)
// and returns data, so all of it is tested as data. Its importers: `register.ts` (#239) uses `hasPlacements` and
// `pluginsForGuild`, `requests.ts` (#241) `validatePluginRouting`, `post.ts` (#243) `announceTargets`, `gate.ts`
// (#243) `commandAllowed`, `live.ts` `hasPlacements`, `isPlaced` and `shown`, `plugins/host.ts`
// `destinationChannel`, `mappedDestinations` and `shown`, `plugins/requests.ts` and `src/interactionLog.ts` `shown`.
// (`shown` lives in `text.ts` and is re-exported here; `model.ts` and `store.ts` import it from there, so this file
// imports `model.ts` and `model.ts` no longer imports this one.)
//
// Placed vs unplaced is the one distinction to hold on to. A plugin with NO entry in
// `routing.json` is *unplaced* and lives in the home server; a plugin WITH an entry is *placed* and
// lives exactly where its `servers` say -- and an entry with `servers: {}` is placed, so it lives
// nowhere. The two are different on purpose: "nowhere" is a choice the operator made, while "no
// entry" is the state every plugin is in until someone chooses.
//
// Placement is registration-level (#478): it decides where a plugin's commands are REGISTERED, and
// `announceTargets` where it posts when its servers name a `postTo`. Dispatch checks a channel list, not
// placement, so a command still registered in a server the plugin is not placed in runs there (a stale list; #420
// is what removes such lists), and a plugin placed nowhere still posts to the default
// channel. Refusing unplaced servers at dispatch is declined: the registration is the mechanism.
//
// A plugin name comes from the caller (the Plugin Index) and every key inside `routing.plugins` came
// from a file, so nothing here does a bare `routing.plugins[name]` lookup: it would answer for an
// inherited key like `constructor`. Lookups go through `Object.hasOwn`.

import { shown } from "./text";
import { DESTINATION_NAME_RE, type CommandScope, type DiscoveryFile, type PluginRouting, type RoutingFile, type ServerRouting } from "./model";

/** `shown` lives in `text.ts` (so `model.ts` can use it without importing this file); re-exported for its importers. */
export { shown };

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
 *
 * With a `destination` (#219): every channel that name is mapped to, the same way; a name mapped in no
 * server falls through to the targets above, so an unmapped destination posts where the plugin posts
 * anyway. Whether the plugin declares the name is the caller's check (`createHostApi`). A name mapped
 * somewhere is honoured as mapped: if every mapped channel then fails, the post fails, as a `postTo`
 * that fails does -- it does not fall back to the plugin's usual channels.
 */
export function announceTargets(routing: RoutingFile, plugin: string, defaultChannelId: string, destination?: string): string[] {
  const servers = entryOf(routing, plugin)?.servers ?? {};
  const guildIds = Object.keys(servers).sort(compareIds);
  if (destination !== undefined) {
    const named = new Set<string>();
    for (const guildId of guildIds) {
      const map = servers[guildId]?.destinations;
      if (map !== undefined && Object.hasOwn(map, destination)) named.add(map[destination]!);
    }
    if (named.size > 0) return [...named];
  }
  const targets = new Set<string>();
  for (const guildId of guildIds) {
    const postTo = servers[guildId]?.postTo;
    if (postTo !== undefined) targets.add(postTo);
  }
  return targets.size > 0 ? [...targets] : [defaultChannelId];
}

/** The channel `destination` is mapped to in `guildId`, for `plugin` -- `undefined` when the plugin is
 *  not placed there, the server has no entry, or the name is not mapped in it (#736, `HostApi.post`).
 *  Unlike `announceTargets`, there is no fallback: an unmapped destination is the caller's rejection to
 *  make, not a route to fall back through. */
export function destinationChannel(routing: RoutingFile, plugin: string, guildId: string, destination: string): string | undefined {
  const entry = entryOf(routing, plugin);
  const server = entry !== undefined && Object.hasOwn(entry.servers, guildId) ? entry.servers[guildId] : undefined;
  const map = server?.destinations;
  return map !== undefined && Object.hasOwn(map, destination) ? map[destination] : undefined;
}

/** Every destination `plugin` has mapped, across every server it lives in (#736, `HostApi.destinations`)
 *  -- guilds ordered by `compareIds`, destinations within a guild in the order `Object.keys` gives its
 *  `destinations` map (insertion order, since it is built key-by-key by `validatePluginRouting`). */
export function mappedDestinations(routing: RoutingFile, plugin: string): { guildId: string; destination: string; channelId: string }[] {
  const servers = entryOf(routing, plugin)?.servers ?? {};
  const guildIds = Object.keys(servers).sort(compareIds);
  const out: { guildId: string; destination: string; channelId: string }[] = [];
  for (const guildId of guildIds) {
    const map = servers[guildId]?.destinations ?? {};
    for (const destination of Object.keys(map)) out.push({ guildId, destination, channelId: map[destination]! });
  }
  return out;
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

type Validation = { ok: true; value: PluginRouting } | { ok: false; reason: string };

/**
 * One plugin's routing as the panel sent it, checked against what the bot can see. Returns a clean
 * value (unknown keys stripped) or the FIRST problem, worded for the panel. `servers: {}` is valid:
 * it places the plugin nowhere. `declared` (#219) is the destination names the plugin's manifest
 * declares; a server's `destinations` may map only those, each to a channel in that server.
 */
export function validatePluginRouting(input: unknown, discovery: DiscoveryFile, declared: readonly string[] = []): Validation {
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
    if (raw.destinations !== undefined) {
      if (!isRecord(raw.destinations)) return fail(`destinations for server ${guildId} must be an object`);
      const mapped: Record<string, string> = {};
      for (const [name, channel] of Object.entries(raw.destinations)) {
        if (!DESTINATION_NAME_RE.test(name) || !declared.includes(name)) {
          return fail(`destination ${shown(name)} is not one this plugin declares`);
        }
        if (typeof channel !== "string" || !channels.has(channel)) {
          return fail(`destination ${name}: channel ${shown(channel)} is not in server ${guildId}`);
        }
        mapped[name] = channel;
      }
      if (Object.keys(mapped).length > 0) clean.destinations = mapped;
    }
    servers[guildId] = clean;
  }
  return { ok: true, value: { servers } };
}
