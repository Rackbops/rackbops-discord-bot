// Live discord.js deps for HostApi.post/dm/edit (#736) -- I/O kept at the edge, over an injected
// `Client`, so host.ts's decisions (destination resolution, validation, authorship) unit-test with a
// fake and never need a live Discord connection. Wired from src/index.ts's makeHost.
import { DiscordAPIError, type Client } from "discord.js";
import type { BuiltPayload } from "./hostMessage";

/** Discord's code for "cannot send messages to this user" (DMs closed, or the bot is blocked). */
const CANNOT_MESSAGE_USER = 50007;

/** Posts `payload` to `channelId`, as the bot -- the same "fetch, check sendable, send" shape as
 *  `announce.ts`'s `sendToChannel` (announce.ts:87-97), reused here rather than shared, since that one
 *  also accepts plain-string content for its own two callers and this one always sends a built
 *  payload. `sent.guildId` is `null` only if discord.js could not resolve the channel's guild, which
 *  does not happen for a channel `post` already resolved through routing -- returned rather than
 *  assumed, so a caller never has to trust its own input back. */
export async function sendPayloadToChannel(
  client: Client,
  channelId: string,
  payload: BuiltPayload,
): Promise<{ messageId: string; guildId: string | null }> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable()) throw new Error(`Channel ${channelId} is not sendable`);
  const sent = await channel.send(payload);
  return { messageId: sent.id, guildId: sent.guildId };
}

/** DMs `userId`, as the bot -- `client.users.fetch` then `user.send`, the same shape
 *  `livePluginUpdateDeps`'s `dmUser` already uses (announce.ts:312-314). A closed-DMs refusal
 *  (Discord's 50007) is the one Discord error every caller needs to tell apart from "something went
 *  wrong", so it is the one rewritten here; anything else propagates as discord.js raised it. */
export async function sendPayloadDm(
  client: Client,
  userId: string,
  payload: BuiltPayload,
): Promise<{ messageId: string; channelId: string }> {
  const user = await client.users.fetch(userId);
  try {
    const sent = await user.send(payload);
    return { messageId: sent.id, channelId: sent.channelId };
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === CANNOT_MESSAGE_USER) {
      throw new Error("recipient cannot be messaged");
    }
    throw err;
  }
}

/** Edits a message this bot sent. Works for either a `post` or a `dm` delivery -- both a guild text
 *  channel and a DM channel are text-based, and `HostDelivery` already carries whichever `channelId`
 *  the original send returned, so no separate DM path is needed here. Refuses (decision 4) a message
 *  whose author is not this bot -- a plugin already reaches the live `Client` via
 *  `interaction.client`, so per-plugin ownership is not a boundary this can honestly enforce; a caller
 *  that needs that enforces it itself. A message id that does not exist rejects with whatever
 *  discord.js's own fetch raises for it -- not rewritten, unlike the DM-closed case above, since
 *  nothing here needs to tell that apart from any other fetch failure. */
export async function editOwnMessage(client: Client, channelId: string, messageId: string, payload: BuiltPayload): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error(`Channel ${channelId} is not a text channel`);
  const message = await channel.messages.fetch(messageId);
  if (message.author.id !== client.user?.id) throw new Error("message was not sent by this bot");
  await message.edit(payload);
}
