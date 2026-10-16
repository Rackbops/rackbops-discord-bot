// Live discord.js deps for HostApi.post/dm/edit (#736) -- I/O kept at the edge, over an injected
// `Client`, so host.ts's decisions (destination resolution, validation, authorship) unit-test with a
// fake and never need a live Discord connection. Wired from src/index.ts's makeHost.
import { DiscordAPIError, type Client } from "discord.js";
import type { BuiltPayload } from "./hostMessage";

/** Discord's code for "cannot send messages to this user" (DMs closed, or the bot is blocked). */
const CANNOT_MESSAGE_USER = 50007;

/**
 * A discord.js REST error (`DiscordAPIError`, `HTTPError`) as a plugin may see it (#508): its message
 * (Discord's own wording of what it refused), `name`, Discord's `code`,
 * the HTTP `status` and `method`, and the stack. Never `requestBody`, which holds what was being sent --
 * a DM's text, a card -- nor `rawError` or `url`, so a plugin that logs the rejection whole
 * (`host.log.error("dm failed", err)`, which under LOG_FORMAT=json is `util.format`ted in full) logs
 * none of it. `code` is kept as is, since a plugin tells
 * Discord's answers apart by it (10013 "Unknown User"). Anything else is returned unchanged.
 *
 * The host's own log sites use it too (#545): a failed reply to an interaction carries the interaction
 * token in `url` and the reply in `requestBody`, so index.ts's handler, the plugin command, interaction and
 * autocomplete dispatchers, the `/update` report's delivery and `host.log.error` all log this view. The
 * `host.log.error` wrapper cleans only the LOGGED copy; the plugin's own error object is untouched. A
 * `RateLimitError` (`url`, no `requestBody`) passes the gate below unchanged and is unreachable at those
 * sites, since `rejectOnRateLimit` is unset.
 */
export function withoutRequest(err: unknown): unknown {
  if (!(err instanceof Error) || !("requestBody" in err)) return err;
  const { code, status, method } = err as Error & { code?: unknown; status?: unknown; method?: unknown };
  const clean = Object.assign(new Error(err.message), { status, method }, code === undefined ? {} : { code });
  clean.name = err.name;
  clean.stack = err.stack;
  return clean;
}

/** Runs one delivery's Discord calls, rejecting with `withoutRequest`'s view of whatever they throw. */
async function cleanly<T>(calls: () => Promise<T>): Promise<T> {
  try {
    return await calls();
  } catch (err) {
    throw withoutRequest(err);
  }
}

/** Posts `payload` to `channelId`, as the bot -- the same "fetch, check sendable, send" shape as
 *  `announce.ts`'s `sendToChannel`, reused here rather than shared, since that one also accepts
 *  plain-string content for its own two callers and this one always sends a built payload.
 *  `sent.guildId` is the guild the channel is in, `null` for a channel in none -- returned rather than
 *  assumed, so a caller need not trust its own input back. */
export async function sendPayloadToChannel(
  client: Client,
  channelId: string,
  payload: BuiltPayload,
): Promise<{ messageId: string; guildId: string | null }> {
  return cleanly(async () => {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`Channel ${channelId} is not sendable`);
    const sent = await channel.send(payload);
    return { messageId: sent.id, guildId: sent.guildId };
  });
}

/** DMs `userId`, as the bot -- `client.users.fetch` then `user.send`, the same shape
 *  `livePluginUpdateDeps`'s `dmUser` already uses (`announce.ts`). A closed-DMs refusal (Discord's
 *  50007) is the one Discord error every caller needs to tell apart from "something went wrong", so it
 *  is the one rewritten here; any other propagates as `withoutRequest` leaves it. */
export async function sendPayloadDm(
  client: Client,
  userId: string,
  payload: BuiltPayload,
): Promise<{ messageId: string; channelId: string }> {
  return cleanly(async () => {
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
  });
}

/** Edits a message this bot sent. Works for either a `post` or a `dm` delivery -- both a guild text
 *  channel and a DM channel are text-based, and `HostDelivery` already carries whichever `channelId`
 *  the original send returned, so no separate DM path is needed here. Refuses (decision 4) a message
 *  whose author is not this bot -- a plugin already reaches the live `Client` via
 *  `interaction.client`, so per-plugin ownership is not a boundary this can honestly enforce; a caller
 *  that needs that enforces it itself. A message id that does not exist rejects with whatever
 *  discord.js's own fetch raises for it, as `withoutRequest` leaves it -- not reworded, unlike the
 *  DM-closed case above, since nothing here needs to tell that apart from any other fetch failure. */
export async function editOwnMessage(client: Client, channelId: string, messageId: string, payload: BuiltPayload): Promise<void> {
  await cleanly(async () => {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error(`Channel ${channelId} is not a text channel`);
    const message = await channel.messages.fetch(messageId);
    if (message.author.id !== client.user?.id) throw new Error("message was not sent by this bot");
    await message.edit(payload);
  });
}
