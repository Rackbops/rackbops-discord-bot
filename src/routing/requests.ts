// The routing half of the request MAILBOX (#241, ADR-0006 decisions 1 and 5). The admin panel cannot
// write the bot's data and must not hold its token, so a routing change is a request file in
// `data/plugins/requests/`, exactly like a plugin update (`src/plugins/requests.ts` drains the
// directory and dispatches here for these four actions). The bot is the only writer of
// `routing.json` / `routing.secrets.json` / `discovery.json`.
//
//   routing-set        one plugin's server map        -> routing.json, then re-register, then discovery
//   webhook-add        a Discord webhook URL          -> routing.secrets.json, then routing.json
//   webhook-remove     a webhook, by channel          -> routing.json, then routing.secrets.json
//   discovery-refresh  re-snapshot what the bot sees  -> discovery.json
//
// This is a trust boundary and it stays one: a request can only act on what the bot already knows.
// Servers and channels are checked against `discovery.json` (after ONE refresh, so a server the bot
// joined a minute ago is not refused for missing from a fifteen-minute-old file); a webhook is checked
// by asking Discord about it. A request can never enable a plugin (that stays `PLUGINS=`-only).
//
// A WEBHOOK URL IS A SECRET from the moment it arrives. It is never logged, never part of a reason, and
// written only by `mutateSecrets`; no error text from a fetch or a parser is ever interpolated into
// anything, because runtimes put the URL in those. `redactWebhookUrls` is the belt to those braces.
//
// Pure over injected deps (`RoutingRequestDeps`) so it tests in a temp dir with no Discord.

import { PLUGIN_NAME_RE, REQUEST_ID_RE, SNOWFLAKE_RE, clip, type DiscoveryFile, type RoutingFile, type RoutingSecretsFile } from "./model";
import { validatePluginRouting } from "./resolve";

export const ROUTING_ACTIONS: ReadonlySet<string> = new Set(["routing-set", "webhook-add", "webhook-remove", "discovery-refresh"]);

/**
 * The webhook URLs the bot accepts: https, discord.com or discordapp.com (canary and ptb too), with or
 * without an API version. The panel's writer (#240) is meant to accept the same set; the bot checks it
 * again either way. Group 1 is the webhook id, group 2 its token. Anything the bot does with a URL is
 * built from these two groups, never from the string that was pasted.
 */
export const WEBHOOK_URL_RE = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{5,25})\/([A-Za-z0-9_-]{20,})$/;

const REDACTED = "[webhook url]";
// Anything webhook-URL-shaped, in any scheme or case, with or without a version segment or a JSON
// escape (`\/`), through the last character a URL could hold (a comma, a quote or a brace ends it).
// Every quantifier before `discord` is bounded, so this stays linear on a hostile megabyte of text.
const WEBHOOK_TEXT_RE =
  /(?:[a-z][a-z0-9+.-]{0,15}:\\?\/\\?\/)?(?:[a-z0-9-]{1,63}\.){0,5}discord(?:app)?\.com\\?\/api\\?\/(?:v\d+\\?\/)?webhooks\\?\/[\w\-.~%+=?&#:@/\\]*/gi;

// The same without a host: `webhooks/<id>/<token>`, however the slashes are spelled, so a URL with a port,
// a doubled slash or a trailing dot in its host (which the pattern above does not know) is still cut
// down to the part that matters.
const WEBHOOK_PATH_RE = /webhooks(?:\\?\/|%2f)\d{5,25}(?:\\?\/|%2f)[\w-]{20,}/gi;

/** `text` with anything that looks like a webhook URL replaced by `[webhook url]`. */
export function redactWebhookUrls(text: string): string {
  return text.replace(WEBHOOK_TEXT_RE, REDACTED).replace(WEBHOOK_PATH_RE, REDACTED);
}

export type RoutingRequest =
  | { action: "routing-set"; id?: string; plugin: string; servers: unknown; requestedBy: string }
  | { action: "webhook-add"; id?: string; url: string; requestedBy: string }
  | { action: "webhook-remove"; id?: string; channelId: string; requestedBy: string }
  | { action: "discovery-refresh"; id?: string; requestedBy: string };

export type ParsedRoutingRequest = { ok: true; request: RoutingRequest } | { ok: false; reason: string };

const MAX_REQUESTED_BY = 200;
// How much of `requestedBy` is looked at for a url before it is clipped to `MAX_REQUESTED_BY`. Redaction
// is linear but not free (about a second per megabyte of hostile text), so a value is cut to this first;
// a url cut short by it is still redacted, because the pattern matches from `webhooks/` on.
const MAX_REQUESTED_BY_SCAN = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The id a panel gave its request, when it is one a panel could have chosen; otherwise nothing. Kept
 * apart from `parseRoutingRequest` so a request that fails to parse can still be reported under its id.
 */
export function requestIdOf(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const id = raw.id;
  if (typeof id !== "string" || !REQUEST_ID_RE.test(id)) return undefined;
  // An id is stored in routing.json, where the panel reads it. A webhook-add's id that is the pasted url,
  // the token, or any stretch of either is that secret in another place: it is dropped (not fatal; the
  // request goes ahead and records no result). Every consumer of an id goes through here, so the parser
  // and the drain agree.
  if (raw.action === "webhook-add" && typeof raw.url === "string") {
    const token = WEBHOOK_URL_RE.exec(raw.url)?.[2];
    if (raw.url.includes(id) || (token !== undefined && id.includes(token))) return undefined;
  }
  return id;
}

/**
 * Shape only -- nothing here needs discovery. Pure, and it cannot throw on any JSON value: it reads
 * top-level fields and never walks into one, so a value nested a hundred thousand deep is only ever
 * "not a string". A malformed `id` is dropped, not fatal; the request goes ahead and records no result.
 *
 * A reason names the field and never quotes the value. In particular a bad webhook URL is refused
 * without any part of it -- not even its length -- in the reason.
 */
export function parseRoutingRequest(raw: unknown): ParsedRoutingRequest {
  const refuse = (reason: string): ParsedRoutingRequest => ({ ok: false, reason });
  if (!isRecord(raw)) return refuse("not an object");
  const action = raw.action;
  if (typeof action !== "string" || !ROUTING_ACTIONS.has(action)) return refuse("not a routing action");
  if (typeof raw.requestedBy !== "string" || raw.requestedBy.length === 0) return refuse("missing requestedBy");
  const submitted = raw.requestedBy;
  const submittedId = requestIdOf(raw);
  // `requestedBy` ends up in routing.json's `updatedBy` / `addedBy`, which the panel reads, and `id` in a
  // result, so neither may carry a webhook url. `requestedBy` is redacted BEFORE it is clipped (a clip
  // could leave half a url that the redaction no longer sees); and for a webhook-add the token itself is
  // taken out of it wherever it sits, in whatever shape, since it is the one thing that must not leak.
  // (The id is scrubbed in `requestIdOf`.)
  const base = (token?: string) => {
    const scrubbed = token === undefined ? submitted : submitted.split(token).join(REDACTED);
    const requestedBy = clip(redactWebhookUrls(scrubbed.slice(0, MAX_REQUESTED_BY_SCAN)), MAX_REQUESTED_BY);
    return submittedId === undefined ? { requestedBy } : { id: submittedId, requestedBy };
  };

  switch (action) {
    case "routing-set": {
      if (typeof raw.plugin !== "string" || !PLUGIN_NAME_RE.test(raw.plugin)) return refuse("bad plugin name");
      if (!isRecord(raw.servers)) return refuse("routing must be an object with a servers object");
      return { ok: true, request: { ...base(), action, plugin: raw.plugin, servers: raw.servers } };
    }
    case "webhook-add": {
      const url = raw.url;
      const match = typeof url === "string" ? WEBHOOK_URL_RE.exec(url) : null;
      if (typeof url !== "string" || match === null) return refuse("bad webhook url");
      return { ok: true, request: { ...base(match[2]), action, url } };
    }
    case "webhook-remove": {
      if (typeof raw.channelId !== "string" || !SNOWFLAKE_RE.test(raw.channelId)) return refuse("bad channel id");
      return { ok: true, request: { ...base(), action, channelId: raw.channelId } };
    }
    default:
      return { ok: true, request: { ...base(), action: "discovery-refresh" } };
  }
}

/** An expected "no": the reason is shown to the operator as it is. Anything else thrown is a fault. */
export class RoutingRefusal extends Error {}

/** What asking Discord about a webhook came to: the three ids it answered with, or why not. */
export type WebhookLookup = { ok: true; id: string; channelId: string; guildId: string } | { ok: false; reason: string };

export interface RoutingRequestDeps {
  /** `null` when the bot has not published discovery.json yet (or it is damaged). */
  readDiscovery: () => Promise<DiscoveryFile | null>;
  readRouting: () => Promise<RoutingFile>;
  /** For a webhook-remove: the secrets file may hold a URL that routing.json no longer names. */
  readSecrets: () => Promise<RoutingSecretsFile>;
  mutateRouting: (mutate: (current: RoutingFile) => RoutingFile) => Promise<void>;
  mutateSecrets: (mutate: (current: RoutingSecretsFile) => RoutingSecretsFile) => Promise<void>;
  fetchWebhook: (id: string, token: string) => Promise<WebhookLookup>;
  applyRouting: (reason: string) => Promise<unknown>;
  refreshDiscovery: () => Promise<void>;
  now: () => Date;
  log: Pick<Console, "warn">;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Runs `check` against what the bot can see. Without discovery, or if `check` refuses, the bot looks
 * once more after a refresh -- it may simply be that the file is stale -- and what that says is final.
 */
async function checkAgainstDiscovery<T>(deps: RoutingRequestDeps, check: (discovery: DiscoveryFile) => Check<T>): Promise<T> {
  const before = await deps.readDiscovery();
  if (before !== null) {
    try {
      const first = check(before);
      if (first.ok) return first.value;
    } catch {
      // A file damaged in a way `readDiscovery` cannot see (a guild with no channels list, say) is the
      // same as a stale one: look again after a refresh, which rewrites it.
    }
  }
  await deps.refreshDiscovery();
  const after = await deps.readDiscovery();
  if (after === null) throw new RoutingRefusal("the bot has not published what it can see yet");
  const second = check(after);
  if (second.ok) return second.value;
  throw new RoutingRefusal(second.reason);
}

/**
 * Carries out one parsed request. Resolves once it is APPLIED -- for `routing-set` that is once
 * `routing.json` is written; a server that then refuses its commands is not a failed request and shows
 * against that server in `discovery.json`. Throws `RoutingRefusal` for an expected no; anything else
 * thrown is a fault. `channelId` is the channel a webhook request landed on, so the result can name it.
 */
export async function applyRoutingRequest(request: RoutingRequest, deps: RoutingRequestDeps): Promise<{ channelId?: string }> {
  const stamp = () => deps.now().toISOString();

  switch (request.action) {
    case "routing-set": {
      const { plugin, requestedBy } = request;
      // The validator's clean value goes in, never the raw input: unknown keys cannot ride through.
      const clean = await checkAgainstDiscovery(deps, (discovery) => validatePluginRouting({ servers: request.servers }, discovery));
      await deps.mutateRouting((current) => ({
        ...current,
        plugins: { ...current.plugins, [plugin]: clean },
        updatedAt: stamp(),
        updatedBy: requestedBy,
      }));
      // Only now, so the registration reads what was just written. Its failure is not this request's:
      // the change is applied, and a refusing server shows in discovery.json.
      try {
        await deps.applyRouting(`routing-set ${plugin}`);
      } catch (err) {
        deps.log.warn(`[routing] re-registering commands after routing-set ${plugin} failed: ${redactWebhookUrls(errorText(err))}`);
      }
      return {};
    }

    case "webhook-add": {
      const match = WEBHOOK_URL_RE.exec(request.url);
      if (match === null) throw new RoutingRefusal("bad webhook url");
      const [, id, token] = match as unknown as [string, string, string];
      const found = await deps.fetchWebhook(id, token);
      if (!found.ok) throw new RoutingRefusal(found.reason);
      // Discord must be describing the webhook that was asked about, or the metadata and the stored URL
      // would disagree.
      if (found.id !== id) throw new RoutingRefusal("Discord does not know that webhook");
      const { channelId, guildId } = found;
      await checkAgainstDiscovery(deps, (discovery) => {
        const guild = discovery.guilds.find((g) => g.id === guildId);
        if (guild === undefined) return { ok: false, reason: "that webhook posts to a server the bot is not in" };
        if (!guild.channels.some((c) => c.id === channelId)) return { ok: false, reason: "that webhook posts to a channel the bot cannot see" };
        return { ok: true, value: undefined };
      });
      // The secret first, the metadata second: routing.json never names a webhook whose URL is missing.
      const canonical = `https://discord.com/api/webhooks/${id}/${token}`;
      let previous: string | undefined;
      await deps.mutateSecrets((current) => {
        previous = Object.hasOwn(current.webhooks, channelId) ? current.webhooks[channelId] : undefined;
        return { ...current, webhooks: { ...current.webhooks, [channelId]: canonical } };
      });
      const at = stamp();
      try {
        await deps.mutateRouting((current) => ({
          ...current,
          // One webhook per channel: a second replaces the first, and with it any `broken`.
          webhooks: { ...current.webhooks, [channelId]: { id, guildId, addedAt: at, addedBy: request.requestedBy } },
          updatedAt: at,
          updatedBy: request.requestedBy,
        }));
      } catch (err) {
        // routing.json still describes the webhook that was there before, so put its URL back rather than
        // leave the two files naming different webhooks (or, for a first add, a secret nobody names).
        try {
          await deps.mutateSecrets((current) => ({
            ...current,
            webhooks:
              previous === undefined
                ? Object.fromEntries(Object.entries(current.webhooks).filter(([channel]) => channel !== channelId))
                : { ...current.webhooks, [channelId]: previous },
          }));
        } catch {
          deps.log.warn(`[routing] could not put back the webhook secret for channel ${channelId} after a failed write`);
        }
        throw err;
      }
      return { channelId };
    }

    case "webhook-remove": {
      const { channelId } = request;
      // Either file may hold the channel without the other: a write that failed halfway, or a hand edit.
      // Whichever does is cleared, so a half-removed webhook can still be removed.
      const [routing, secrets] = await Promise.all([deps.readRouting(), deps.readSecrets()]);
      const named = Object.hasOwn(routing.webhooks, channelId);
      const stored = Object.hasOwn(secrets.webhooks, channelId);
      if (!named && !stored) throw new RoutingRefusal("no webhook is registered for that channel");
      // The reverse order of an add: the metadata goes first, so routing.json never names a webhook
      // whose URL is gone.
      if (named) {
        await deps.mutateRouting((current) => ({
          ...current,
          webhooks: Object.fromEntries(Object.entries(current.webhooks).filter(([channel]) => channel !== channelId)),
          updatedAt: stamp(),
          updatedBy: request.requestedBy,
        }));
      }
      if (stored) {
        await deps.mutateSecrets((current) => ({
          ...current,
          webhooks: Object.fromEntries(Object.entries(current.webhooks).filter(([channel]) => channel !== channelId)),
        }));
      }
      return { channelId };
    }

    case "discovery-refresh":
      await deps.refreshDiscovery();
      return {};
  }
}

const WEBHOOK_LOOKUP_TIMEOUT_MS = 10_000;
const UNKNOWN_WEBHOOK = "Discord does not know that webhook";
const UNREACHABLE = "could not reach Discord";

/**
 * Asks Discord about a webhook: `GET https://discord.com/api/v10/webhooks/<id>/<token>`, built from the
 * two captured groups and never from the pasted string, so the request can only ever go to discord.com
 * (and a redirect is an error, not followed). 401 / 403 / 404 mean Discord does not know it; any other
 * status, a thrown fetch, or an answer without string `id` / `channel_id` / `guild_id` is "could not
 * reach Discord". The error a fetch throws is dropped, not interpolated -- runtimes put the URL in it --
 * and the body, which contains the token, is never logged or returned beyond the three ids.
 */
export function liveFetchWebhook(fetchFn: typeof fetch = fetch): RoutingRequestDeps["fetchWebhook"] {
  return async (id, token) => {
    let response: Response;
    try {
      response = await fetchFn(`https://discord.com/api/v10/webhooks/${id}/${token}`, {
        signal: AbortSignal.timeout(WEBHOOK_LOOKUP_TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      return { ok: false, reason: UNREACHABLE };
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) return { ok: false, reason: UNKNOWN_WEBHOOK };
    if (!response.ok) return { ok: false, reason: UNREACHABLE };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: UNREACHABLE };
    }
    if (!isRecord(body) || typeof body.id !== "string" || typeof body.channel_id !== "string" || typeof body.guild_id !== "string") {
      return { ok: false, reason: UNREACHABLE };
    }
    return { ok: true, id: body.id, channelId: body.channel_id, guildId: body.guild_id };
  };
}
