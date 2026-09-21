// Keeping a plugin's commands to their channels (ADR-0006 decision 7, #243). When a plugin's routing
// lists channels for a server, its commands run only there -- a thread counts as its parent -- and
// anywhere else the reply is private and names the channels that would have worked. `commandAllowed`
// (resolve.ts) makes the decision; this file gathers what it needs from an interaction and words the
// refusal.
//
// The gate FAILS OPEN. If the gate itself fails (a routing read that rejects -- `readRouting` reads a file
// it cannot parse as fresh, which allows everything, and says so in its own `[routing]` line), or where
// the command was typed cannot be worked out, the command runs: a routing fault must never take a plugin's
// commands down, and a gate that wrongly refuses is worse than one that wrongly lets a command through.
// Each way it lets a command through that it would otherwise have refused leaves a `[gate]` line. Core
// commands never reach it (commands.ts), and only chat-input commands are gated -- a button or a modal
// belongs to a message that is already in an allowed channel.
//
// `whereOf` is the only function here that touches discord.js objects; everything else is data.

import type { ChatInputCommandInteraction } from "discord.js";
import type { RoutingFile } from "./model";
import { commandAllowed } from "./resolve";

export interface Where {
  guildId: string | null;
  channelId: string;
  /** Set when the channel is a thread: the channel it lives in. */
  parentChannelId?: string;
  /**
   * The channel could not be looked at, or it is a thread whose parent is not known, so whether the
   * command may run here cannot be decided. The gate lets it run.
   */
  parentUnknown?: true;
}

/** What a thread contributes to `Where`: its parent (`{ parentChannelId }`), nothing (`{}`), or that it cannot be told. */
function threadPart(channel: unknown): Pick<Where, "parentChannelId" | "parentUnknown"> {
  if (typeof channel !== "object" || channel === null) return { parentUnknown: true };
  try {
    const candidate = channel as { isThread?: () => boolean; parentId?: string | null };
    if (typeof candidate.isThread !== "function" || !candidate.isThread()) return {};
    return typeof candidate.parentId === "string" ? { parentChannelId: candidate.parentId } : { parentUnknown: true };
  } catch {
    return { parentUnknown: true };
  }
}

/**
 * Where a command was typed. A thread's own id is not on any channel list, so its parent's is what
 * counts. `interaction.channel` comes from the cache; a thread that is not cached yet is `null`, in which
 * case the channel is fetched once. A fetch that fails means the parent is not known.
 */
export async function whereOf(
  interaction: Pick<ChatInputCommandInteraction, "guildId" | "channelId" | "channel">,
  fetchChannel: (id: string) => Promise<unknown>,
): Promise<Where> {
  let channel: unknown = interaction.channel;
  if (channel === null || channel === undefined) {
    try {
      channel = await fetchChannel(interaction.channelId);
    } catch {
      channel = null;
    }
  }
  return { guildId: interaction.guildId, channelId: interaction.channelId, ...threadPart(channel) };
}

/** How many channels a refusal names before it says "and N more". */
const NAMED_CHANNELS = 5;

/**
 * "`/rsetlist` works in <#1> here." · "... in <#1> or <#2> here." · "... in <#1>, <#2> or <#3> here." ·
 * more than five: the first five, then "and N more". `<#id>` is a channel mention: Discord shows the
 * channel's name and makes it a link, which is what naming the right channels means.
 */
export function refusalMessage(commandName: string, channels: readonly string[]): string {
  const mention = (id: string) => `<#${id}>`;
  let where: string;
  if (channels.length > NAMED_CHANNELS) {
    where = `${channels.slice(0, NAMED_CHANNELS).map(mention).join(", ")} and ${channels.length - NAMED_CHANNELS} more`;
  } else if (channels.length > 1) {
    where = `${channels.slice(0, -1).map(mention).join(", ")} or ${mention(channels[channels.length - 1]!)}`;
  } else {
    where = channels.map(mention).join("");
  }
  return `\`/${commandName}\` works in ${where} here.`;
}

/**
 * The refusal to show, or `undefined` to let the command run. `plugin` is the plugin that owns the
 * command, or `undefined` for anything else. Never throws.
 *
 * Most commands are decided by the channel they were typed in, which is known from the interaction, so
 * `whereOf` -- which may have to fetch the channel from Discord -- is only called when that channel is not
 * one the plugin's routing lists and its parent could make the difference. No routing, "all", a listed
 * channel, a DM and a core command never look anything up.
 */
export async function gateCommand(
  plugin: string | undefined,
  commandName: string,
  here: Pick<Where, "guildId" | "channelId">,
  whereOf: () => Promise<Where>,
  readRouting: () => Promise<RoutingFile>,
  log: Pick<Console, "error">,
): Promise<string | undefined> {
  if (plugin === undefined || here.guildId === null) return undefined;
  try {
    const routing = await readRouting();
    if (commandAllowed(routing, plugin, here.guildId, here.channelId).allowed) return undefined;
    // Not listed under its own id: it may be a thread under a channel that is.
    const where = await whereOf();
    const verdict = commandAllowed(routing, plugin, here.guildId, here.channelId, where.parentChannelId);
    if (verdict.allowed) return undefined;
    if (where.parentUnknown === true) {
      log.error(`[gate] could not tell where /${commandName} was typed, so it is not refused`);
      return undefined;
    }
    return refusalMessage(commandName, verdict.channels);
  } catch (err) {
    log.error(`[gate] could not decide whether /${commandName} may run here; letting it run`, err);
    return undefined;
  }
}
