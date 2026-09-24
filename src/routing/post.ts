// Where a plugin's announcements go (ADR-0006 decisions 5-6, #243). `HostApi.announce(message)` kept
// its signature (#219 added an optional named `destination`); what changed is what stands behind it. `announceTargets` (resolve.ts) says which
// channels the plugin posts to; for each one this posts through the channel's webhook when it has a
// usable one, and as the bot when it does not.
//
// The governing rule: with no routing, the call is exactly today's -- one post, as the bot, to the
// default channel, and a failure there propagates unchanged.
//
// A webhook URL is a secret (it is a bearer credential for the channel). It comes out of
// `routing.secrets.json` only to be handed to `executeWebhook`, and it is never put in a log line, an
// error, or `routing.json`: every reason in this file is a fixed string, and a fetch error is dropped
// rather than interpolated. There is no redaction step because no string in this file is ever built from
// the URL and other text.
//
// `postForPlugin` and `liveExecuteWebhook` are pure over injected deps (`fetch` included), so they are
// tested with no Discord, no network and no disk; `markWebhookBroken` writes `routing.json` and its tests
// use a temp directory.

import { freshRouting, type RoutingFile, type RoutingSecretsFile, type WebhookMeta } from "./model";
import { announceTargets } from "./resolve";
import { mutateRouting } from "./store";

/** `gone`: Discord says the webhook does not exist (any more). Only that marks it broken. */
export type WebhookPostResult = { ok: true } | { ok: false; gone: boolean; reason: string };

export interface PostDeps {
  readRouting: () => Promise<RoutingFile>;
  readSecrets: () => Promise<RoutingSecretsFile>;
  defaultChannelId: string;
  /** `announceTo` -- the bot's own send path; it prints the `[announce]` line itself. */
  sendAsBot: (channelId: string, message: string) => Promise<void>;
  executeWebhook: (url: string, message: string) => Promise<WebhookPostResult>;
  /** `seen` is the webhook's metadata as it was when the post was made: see `withWebhookBroken`. */
  markBroken: (channelId: string, reason: string, seen: WebhookMeta) => Promise<void>;
  log: Pick<Console, "log" | "warn" | "error">;
}

/** The channel's webhook, when `routing.json` has one that has not been found dead. */
function usableWebhook(routing: RoutingFile, channelId: string): WebhookMeta | undefined {
  const meta = Object.hasOwn(routing.webhooks, channelId) ? routing.webhooks[channelId] : undefined;
  return meta !== undefined && meta.broken === undefined ? meta : undefined;
}

/**
 * Posts `message` for `plugin`. Every target follows the same rule, the default channel included: a
 * registered, unbroken webhook with a stored URL is posted through; otherwise the bot posts. A webhook
 * that fails, for any reason, falls back to the bot for that post; only 401/404 (`gone`) also marks it
 * broken, so the panel can say so and the next post skips it. A rate limit, a 5xx, a timeout or a
 * message that is too long is a bad moment, not a dead webhook.
 *
 * A webhook that timed out or answered 5xx may still have delivered the message, so the fallback can put
 * a second copy in the channel: a message that must arrive is worth more here than one that arrives
 * exactly once.
 *
 * It rejects only when EVERY target failed, with the first error unchanged (the others are logged). A
 * plugin that sees a rejection typically posts again on its next tick, and that would post again to the
 * channels that DID get the message -- every minute, for as long as one channel stays unreachable. With
 * one target (the case with no routing) this is exactly today's behaviour: the failure propagates.
 */
export async function postForPlugin(plugin: string, message: string, deps: PostDeps, destination?: string): Promise<void> {
  // Routing is read per use (one small file; no cache, so no invalidation bug). A read that fails must
  // not take a plugin's announcements down, so it reads as "no routing": the default channel.
  let routing: RoutingFile;
  try {
    routing = await deps.readRouting();
  } catch {
    deps.log.warn(`[announce] ${plugin}: could not read routing; posting to the default channel`);
    routing = freshRouting();
  }
  const targets = announceTargets(routing, plugin, deps.defaultChannelId, destination);

  // The secrets file is only opened when some target could use it.
  let secrets: RoutingSecretsFile | undefined;
  if (targets.some((channelId) => usableWebhook(routing, channelId) !== undefined)) {
    try {
      secrets = await deps.readSecrets();
    } catch {
      deps.log.warn(`[announce] ${plugin}: could not read the webhook secrets; posting as the bot`);
    }
  }

  /** True once the post has been made through the channel's webhook. */
  const viaWebhook = async (channelId: string): Promise<boolean> => {
    const meta = usableWebhook(routing, channelId);
    if (meta === undefined) return false;
    const url = secrets !== undefined && Object.hasOwn(secrets.webhooks, channelId) ? secrets.webhooks[channelId] : undefined;
    if (url === undefined || url.length === 0) return false;
    let result: WebhookPostResult;
    try {
      result = await deps.executeWebhook(url, message);
    } catch {
      // The seam should never throw, but if it does, the bot still posts. Whatever was thrown is dropped.
      result = { ok: false, gone: false, reason: "webhook post failed" };
    }
    if (result.ok) {
      deps.log.log("[announce]", message);
      return true;
    }
    deps.log.warn(`[announce] ${plugin}: the webhook for ${channelId} failed: ${result.reason}`);
    if (result.gone) {
      try {
        await deps.markBroken(channelId, result.reason, meta);
      } catch (err) {
        deps.log.error(`[announce] ${plugin}: could not mark the webhook for ${channelId} broken`, err);
      }
    }
    return false;
  };

  const failures: { channelId: string; err: unknown }[] = [];
  let posted = 0;
  for (const channelId of targets) {
    try {
      if (!(await viaWebhook(channelId))) await deps.sendAsBot(channelId, message);
      posted += 1;
    } catch (err) {
      failures.push({ channelId, err });
    }
  }
  // Every one that was not thrown is logged: the first failure is the plugin's to see, the rest would be lost.
  const unreported = posted === 0 ? failures.slice(1) : failures;
  for (const { channelId, err } of unreported) {
    deps.log.error(`[announce] ${plugin}: could not post to ${channelId}`, err);
  }
  if (posted === 0) throw failures[0]?.err;
}

const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * `POST <url>` with the message as `content`. `allowed_mentions: { parse: [] }` is a security property,
 * not a nicety: the Client sends with `allowedMentions: { parse: [] }` (#48), so a plugin message that
 * contains `@everyone` pings nobody when the bot posts it; without this field the same message would
 * ping everyone through a webhook. `fetchFn` is injected so nothing here needs the network to be tested.
 *
 * Never throws and never puts the URL, or the error a failed fetch threw, in a reason: those are fixed
 * strings (and the status number). A redirect is an error, not followed: Discord does not redirect a
 * webhook post, and following one would send the message on to whatever host answered and report success
 * for a message that never reached the channel; as an error it falls back to the bot.
 */
export function liveExecuteWebhook(fetchFn: typeof fetch = fetch): PostDeps["executeWebhook"] {
  return async (url, message) => {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      return { ok: false, gone: false, reason: "could not reach Discord" };
    }
    if (response.status >= 200 && response.status < 300) return { ok: true };
    if (response.status === 401 || response.status === 404) {
      return { ok: false, gone: true, reason: `Discord says that webhook is gone (${response.status})` };
    }
    return { ok: false, gone: false, reason: `webhook post failed (${response.status})` };
  };
}

/**
 * `routing` with the webhook for `channelId` marked broken: `webhooks[channel].broken` holds the reason,
 * where the model (#237) keeps it and the panel reads it. Only an entry that exists is touched, and
 * `updatedAt` / `updatedBy` are left alone -- nobody edited anything.
 *
 * And only the entry that was posted through. A post can be in flight for ten seconds; if the operator
 * replaced the webhook in that time, the old one's 404 must not mark the new one broken. `seen` is the
 * metadata the post was made with: a different `id`, or the same webhook added again (`addedAt`), is
 * a different webhook and is left alone.
 */
export function withWebhookBroken(routing: RoutingFile, channelId: string, reason: string, seen: WebhookMeta): RoutingFile {
  const meta = Object.hasOwn(routing.webhooks, channelId) ? routing.webhooks[channelId] : undefined;
  if (meta === undefined || meta.id !== seen.id || meta.addedAt !== seen.addedAt) return routing;
  return { ...routing, webhooks: { ...routing.webhooks, [channelId]: { ...meta, broken: reason } } };
}

/** `withWebhookBroken`, written to `routing.json`; serialized with every other routing write by `mutateRouting`. */
export function markWebhookBroken(dataDir: string): PostDeps["markBroken"] {
  return async (channelId, reason, seen) => {
    await mutateRouting(dataDir, (current) => withWebhookBroken(current, channelId, reason, seen));
  };
}
