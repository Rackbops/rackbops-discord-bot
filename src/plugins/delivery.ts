// Live discord.js deps for HostApi.post/dm/edit (#736) -- I/O kept at the edge, over an injected
// `Client`, so host.ts's decisions (destination resolution, validation, authorship) unit-test with a
// fake and never need a live Discord connection. Wired from src/index.ts's makeHost.
import { DiscordAPIError, type Client } from "discord.js";
import type { HostMember } from "./contract";
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
 * Discord's answers apart by it (10013 "Unknown User"). An error that carries no request (see below) is returned as it is, bar a `cause` or `errors` chain nested past the last level followed.
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
 * left alone. Such an error is replaced by a plain `Error` copy of itself, so it is not an `instanceof` the
 * original class and a non-Discord error with such a `url` loses its other properties too; only `message`,
 * `name`, `stack`, and those of `code`, `status` and `method` it has are kept.
 *
 * The error is also followed through `cause` and an `AggregateError`'s `errors`, `MAX_CAUSE_DEPTH` levels
 * down: a wrapper that holds a request-carrying error comes back as a plain copy of itself (message, name,
 * stack, `code`; its other properties are not kept) with the cleaned error in its place, and what hangs
 * below the last level followed is cut off, not left unexamined (also from an error that carries no request:
 * a plain `cause` or `errors` chain longer than that comes back as a truncated copy). Any other error comes back as it is.
 * Not followed: any other property that might hold an error.
 *
 * It fails closed and never throws -- it runs inside `catch` blocks, where a throw would cost the user's
 * "Something went wrong." reply and hide the real error. An error it cannot read (a throwing accessor, a
 * Proxy that throws) or that takes more than `MAX_NODES` visits to walk (the error itself counts, and one reached twice
 * counts twice), or whose `errors` array is longer than the visits left, is replaced by a fixed placeholder.
 */
export function withoutRequest(err: unknown): unknown {
  try {
    return clean(err, 0, { left: MAX_NODES });
  } catch {
    return new Error(UNCLEANABLE);
  }
}

/** How many `cause`/`errors` levels `withoutRequest` follows. A cycle in them ends here. */
const MAX_CAUSE_DEPTH = 5;

/** The most visits one `withoutRequest` call makes (the error itself counts, and one reached twice counts twice), so
 *  a wide, self-referencing AggregateError cannot make it do work that grows with the width to the power of the depth. */
const MAX_NODES = 1000;

const UNCLEANABLE = "an error that could not be inspected safely was replaced (its request may have been in it)";

const isHttpUrl = (value: unknown): boolean => typeof value === "string" && /^https?:\/\//i.test(value);

function carriesRequest(err: Error): boolean {
  const { url, path } = err as Error & { url?: unknown; path?: unknown };
  return "requestBody" in err || isHttpUrl(url) || isHttpUrl(path);
}

/** `message`, `name`, `stack` and whichever of `status`, `method`, `code` `err` has -- nothing that carries the request. */
function requestCopy(err: Error): Error {
  const { status, method, code } = err as Error & { status?: unknown; method?: unknown; code?: unknown };
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({ status, method, code })) if (value !== undefined) kept[key] = value;
  const copy = Object.assign(new Error(err.message), kept);
  copy.name = err.name;
  copy.stack = err.stack;
  return copy;
}

/** A plain copy of a wrapper: `message`, `name`, `stack`, `code`, and the given `cause` and members in place of its own. */
function wrapperCopy(err: Error, cause: { value: unknown } | undefined, members: unknown[] | undefined): Error {
  const copy = members !== undefined ? new AggregateError(members, err.message) : new Error(err.message);
  copy.name = err.name;
  copy.stack = err.stack;
  const { code } = err as Error & { code?: unknown };
  if (code !== undefined) Object.assign(copy, { code });
  if (cause !== undefined) Object.assign(copy, { cause: cause.value });
  return copy;
}

function clean(err: unknown, depth: number, budget: { left: number }): unknown {
  if (!(err instanceof Error)) return err;
  budget.left -= 1;
  if (budget.left < 0) throw new Error("too many nested errors");
  if (carriesRequest(err)) return requestCopy(err);
  const { cause } = err as Error & { cause?: unknown };
  const members = err instanceof AggregateError && Array.isArray(err.errors) ? (err.errors as unknown[]) : undefined;
  // Before any walk of it: a sparse array of a billion holes spends no budget as it is mapped.
  if (members !== undefined && members.length > budget.left) throw new Error("too many nested errors");
  if (depth >= MAX_CAUSE_DEPTH) {
    // Past the last level followed: cut what hangs below rather than leave it unexamined.
    if (cause === undefined && (members === undefined || members.length === 0)) return err;
    return wrapperCopy(err, undefined, members === undefined ? undefined : []);
  }
  const cleanCause = cause === undefined ? undefined : clean(cause, depth + 1, budget);
  const cleanMembers = members?.map((member) => clean(member, depth + 1, budget));
  const changed = cleanCause !== cause || (members !== undefined && cleanMembers!.some((member, i) => member !== members[i]));
  if (!changed) return err;
  return wrapperCopy(err, cause === undefined ? undefined : { value: cleanCause }, cleanMembers);
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

/** Discord's "no such member" and "no such user": the one answer `fetchMember` reads as "not in it". */
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;

/** One server member's role ids and the server's (`HostApi.member`), or null when Discord says the
 *  user is not in that server. `force: true`, so the answer is Discord's now, never discord.js's member
 *  cache (with only the Guilds intent the bot never hears that a member left). The server's roles are
 *  read from its cache, which the Guilds intent keeps; a server Discord reports unavailable (an
 *  outage) rejects, since its role cache cannot be trusted then. The member is not cached (`cache:
 *  false`): with only the Guilds intent nothing would ever evict it. Any other failure rejects
 *  without the request, a server the bot is not in among them. */
export async function fetchMember(client: Client, guildId: string, userId: string): Promise<HostMember | null> {
  return cleanly(async () => {
    const guild = await client.guilds.fetch(guildId);
    if (!guild.available) throw new Error(`server ${guildId} is unavailable`);
    try {
      const member = await guild.members.fetch({ user: userId, force: true, cache: false });
      return { roleIds: [...member.roles.cache.keys()], guildRoleIds: [...guild.roles.cache.keys()] };
    } catch (err) {
      if (err instanceof DiscordAPIError && (err.code === UNKNOWN_MEMBER || err.code === UNKNOWN_USER)) return null;
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
