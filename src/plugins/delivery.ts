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
 * `host.log.error` wrapper cleans only the LOGGED copy; the plugin's own error object is untouched.
 *
 * What counts as carrying the request (`carriesRequest`): `requestBody` (a `DiscordAPIError`, an `HTTPError`),
 * or an `http(s)://` URL in `url` (also a `RateLimitError`, which has no `requestBody`) or in `path` -- the
 * bare `TypeError` Bun throws when the call never reached Discord (connection refused or reset, DNS), whose
 * `path` is the full request URL, the interaction token in it. A `path` that is not a URL (an `fs` error's) is
 * left alone. The error is also followed through `cause` and an `AggregateError`'s `errors`, up to
 * `MAX_CAUSE_DEPTH` deep: a wrapper that holds a request-carrying error is returned as a plain copy of
 * itself (message, name, stack, `code`) with the cleaned error in its place, and any other error comes back
 * as it is. Not followed: any other property that might hold an error.
 */
export function withoutRequest(err: unknown): unknown {
  return clean(err, 0);
}

/** How many `cause`/`errors` levels `withoutRequest` follows. A cycle in them ends here. */
const MAX_CAUSE_DEPTH = 5;

const isHttpUrl = (value: unknown): boolean => typeof value === "string" && /^https?:\/\//i.test(value);

function carriesRequest(err: Error): boolean {
  const { url, path } = err as Error & { url?: unknown; path?: unknown };
  return "requestBody" in err || isHttpUrl(url) || isHttpUrl(path);
}

function clean(err: unknown, depth: number): unknown {
  if (!(err instanceof Error)) return err;
  const { code } = err as Error & { code?: unknown };
  if (carriesRequest(err)) {
    const { status, method } = err as Error & { status?: unknown; method?: unknown };
    const copy = Object.assign(new Error(err.message), { status, method }, code === undefined ? {} : { code });
    copy.name = err.name;
    copy.stack = err.stack;
    return copy;
  }
  if (depth >= MAX_CAUSE_DEPTH) return err;
  const { cause } = err as Error & { cause?: unknown };
  const cleanCause = cause === undefined ? undefined : clean(cause, depth + 1);
  const inner = err instanceof AggregateError && Array.isArray(err.errors) ? (err.errors as unknown[]) : undefined;
  const cleanInner = inner?.map((e) => clean(e, depth + 1));
  const changed = cleanCause !== cause || (inner !== undefined && cleanInner!.some((e, i) => e !== inner[i]));
  if (!changed) return err;
  const copy = err instanceof AggregateError ? new AggregateError(cleanInner ?? [], err.message) : new Error(err.message);
  copy.name = err.name;
  copy.stack = err.stack;
  if (code !== undefined) Object.assign(copy, { code });
  if (cause !== undefined) Object.assign(copy, { cause: cleanCause });
  return copy;
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
