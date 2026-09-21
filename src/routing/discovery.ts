// What the bot can see of Discord, published as `data/discovery.json` (ADR-0006 decision 4) so the
// admin panel -- which is deliberately not configured with the Discord token -- can offer servers and
// channels by name. The bot is the only writer; the panel only reads it.
//
// `snapshotGuilds` is the ONLY function in this module that touches discord.js objects. Everything
// else takes plain data, so it tests without a `Client`.

import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import type { LoadedPlugin, PluginCommandMap } from "../plugins/host";
import { readJsonOrFresh, writeJsonAtomic } from "../storage";
import type { DiscoveryChannel, DiscoveryFile } from "./model";
import { ownerOf, type GuildRegistration } from "./register";

export interface GuildSnapshot {
  id: string;
  name: string;
  channels: DiscoveryChannel[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The servers the bot is in, from the Client's caches (`CORE_INTENTS` is `[Guilds]`, which is what
 * fills them -- no new intent). Channels are the text and announcement ones, ordered by position and
 * then name; servers by name. `canSend` is whether the bot can view the channel AND send in it, and
 * is false when the permissions cannot be computed at all.
 */
export function snapshotGuilds(client: Client<true>): GuildSnapshot[] {
  const snapshots: GuildSnapshot[] = [];
  for (const guild of client.guilds.cache.values()) {
    const channels: { position: number; channel: DiscoveryChannel }[] = [];
    for (const channel of guild.channels.cache.values()) {
      // Text and announcement channels are the two the bot can post to; everything else (voice,
      // categories, forums, threads) is left out. Narrowing on `type` inline is what tells the
      // compiler these are position-carrying guild channels.
      if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) continue;
      const canSend =
        channel.permissionsFor(client.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) ?? false;
      channels.push({ position: channel.rawPosition, channel: { id: channel.id, name: channel.name, canSend } });
    }
    channels.sort(
      (a, b) => a.position - b.position || compareText(a.channel.name, b.channel.name) || compareText(a.channel.id, b.channel.id),
    );
    // discord.js leaves `name` unset on the stub of a server that is unavailable (an outage); its id
    // stands in, so `discovery.json` always carries the `name` its shape promises.
    const name = typeof guild.name === "string" ? guild.name : guild.id;
    snapshots.push({ id: guild.id, name, channels: channels.map((c) => c.channel) });
  }
  return snapshots.sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
}

/**
 * `https://discord.com/oauth2/authorize?client_id=<appId>&scope=bot+applications.commands&permissions=2048`
 * -- the invite the README documents, with this bot's own id. `applications.commands` is what lets
 * the bot register slash commands in a server at all; a server invited without it is what Discord
 * refuses with 50001.
 */
export function inviteUrl(appId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=2048`;
}

/** One loaded plugin as `discovery.json` describes it. */
export interface PluginSummary {
  name: string;
  commands: string[];
  posts: boolean;
}

/**
 * The loaded plugins as the panel needs them: the commands each one registered (as registered, so
 * with `COMMAND_PREFIX`), and whether it "posts" -- has ticks to run on its own. Read defensively,
 * exactly as `pluginTicks` reads them: `ticks` is plugin-controlled and only type-asserted, so a
 * malformed or throwing value counts as no ticks and never escapes.
 */
export function describePlugins(
  loaded: readonly LoadedPlugin[],
  fullBody: readonly { name: string }[],
  prefix: string,
  commandMap: PluginCommandMap,
): PluginSummary[] {
  return loaded.map((lp) => {
    let posts = false;
    try {
      for (const tick of lp.plugin.ticks ?? []) {
        void tick;
        posts = true;
        break;
      }
    } catch {
      posts = false;
    }
    const commands = fullBody.filter((c) => ownerOf(c.name, prefix, commandMap) === lp.entry.name).map((c) => c.name);
    return { name: lp.entry.name, commands, posts };
  });
}

/**
 * The file, from plain data. A server's `commands` is the registration made in it, or `null` when
 * there is none -- which, when nothing is placed, is every server except the home one (and every
 * server when registration is global, since that outcome belongs to no one server).
 */
export function buildDiscovery(opts: {
  now: Date;
  bot: { id: string; username: string };
  homeGuildId: string | undefined;
  snapshots: readonly GuildSnapshot[];
  registrations: readonly GuildRegistration[];
  plugins: readonly PluginSummary[];
}): DiscoveryFile {
  const { now, bot, homeGuildId, snapshots, registrations, plugins } = opts;
  return {
    v: 1,
    generatedAt: now.toISOString(),
    bot: { id: bot.id, username: bot.username },
    inviteUrl: inviteUrl(bot.id),
    homeGuildId: homeGuildId ?? null,
    guilds: snapshots.map((snapshot) => {
      const registration = registrations.find((r) => r.guildId === snapshot.id);
      return {
        id: snapshot.id,
        name: snapshot.name,
        channels: snapshot.channels.map((c) => ({ ...c })),
        commands:
          registration === undefined
            ? null
            : {
                registered: registration.registered,
                ...(registration.error !== undefined ? { error: registration.error } : {}),
                at: registration.at,
              },
      };
    }),
    // `Object.fromEntries` creates own data properties, so a plugin named like an inherited key
    // (`constructor` is a legal plugin name) is an ordinary entry.
    plugins: Object.fromEntries(plugins.map((p) => [p.name, { posts: p.posts, commands: [...p.commands] }])),
  };
}

export function discoveryPath(dataDir: string): string {
  return `${dataDir}/discovery.json`;
}

/** Atomic write, like every other data file. The panel reads this file; nothing else writes it. */
export async function writeDiscovery(dataDir: string, file: DiscoveryFile): Promise<void> {
  await writeJsonAtomic(discoveryPath(dataDir), file);
}

/**
 * The published file, for the bot's own validation of a panel request (#241): null when there is none
 * to go on. A missing file is null; an unparseable one is moved aside by `readJsonOrFresh`, as every
 * data file is, and is null too; and so is anything that is not an object with a `guilds` list, so a
 * file damaged by hand reads as "not published yet" instead of throwing inside validation. Beyond that
 * the bot is the only writer and the shape is trusted.
 */
export async function readDiscovery(dataDir: string): Promise<DiscoveryFile | null> {
  const raw = await readJsonOrFresh<unknown>(discoveryPath(dataDir), () => null, "discovery");
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { guilds?: unknown }).guilds)) return null;
  return raw as DiscoveryFile;
}
