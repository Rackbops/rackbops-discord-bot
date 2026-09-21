// The on-disk shapes behind per-plugin routing (ADR-0006, Epic #236): where a plugin's commands
// live, where it posts, and which webhooks exist. Types and pure repair functions only -- no I/O
// (`store.ts` reads and writes), no discord.js. The bot chain, `ops/bot-ops.sh` and the admin panel
// all build against these names and semantics, so they are a contract, not an implementation detail.
//
// Two files, on purpose (ADR-0006 decision 5): `routing.json` holds everything an operator or the
// panel may read; `routing.secrets.json` holds the webhook URLs and nothing else. A webhook URL is a
// credential, so it must never be reachable from a file the panel reads.
//
// Both files are read back from disk that a person may have edited, a crash may have truncated, or
// a future version may have written. A repair function therefore never throws and never trusts a
// key it did not check: an untrusted key is tested with a regex before it is used, and an object
// literal is built from scratch rather than copied, so a stray `url` or `__proto__` can neither ride
// through nor be assigned onto a prototype (see `repoForProject` in `src/config.ts` for the failure
// this style exists to prevent).

import { shown } from "./resolve";

export const ROUTING_VERSION = 1 as const;
/** Same rule as `PluginIndexEntry.name` (`src/plugins/requests.ts` and `src/plugins/index.ts`). */
export const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
/** A Discord snowflake as it appears in JSON. */
export const SNOWFLAKE_RE = /^[0-9]{5,25}$/;

/** "all", or a NON-EMPTY list of channel ids. */
export type CommandScope = "all" | string[];
export interface ServerRouting {
  commands: CommandScope;
  /**
   * absent = this server adds no post target. A plugin with no `postTo` in ANY of its servers posts
   * to the default announce channel instead (`announceTargets` in `resolve.ts`).
   */
  postTo?: string;
}
/** key: guild id */
export interface PluginRouting {
  servers: Record<string, ServerRouting>;
}
export interface WebhookMeta {
  id: string;
  guildId: string;
  addedAt: string;
  addedBy: string;
  /** why Discord refused it, once it has */
  broken?: string;
}
/**
 * What became of one panel request (#241), so the panel can show it: the panel chooses an `id`, drops
 * a request carrying it, and looks for that id here. `reason` is the operator-facing "no", and never
 * carries a webhook URL. `channelId` is the channel a webhook request landed on, when it did.
 */
export interface RequestResult {
  id: string;
  action: string;
  plugin?: string;
  channelId?: string;
  ok: boolean;
  reason?: string;
  at: string;
}
/** How many results `routing.json` keeps: the newest. */
export const MAX_RESULTS = 20;
/** What a panel may use as a request id: short, and nothing that needs escaping anywhere. */
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_REASON_LENGTH = 300;

/** `webhooks` key: channel id. Metadata only -- the URL is in `RoutingSecretsFile`. */
export interface RoutingFile {
  v: 1;
  updatedAt: string;
  updatedBy: string;
  plugins: Record<string, PluginRouting>;
  webhooks: Record<string, WebhookMeta>;
  /** Outcomes of panel requests, oldest first, at most `MAX_RESULTS`. */
  results: RequestResult[];
}
/**
 * channel id -> webhook URL. The only FILE the bot stores a webhook URL in -- though the same bytes
 * can sit beside it under another name: a corrupt copy moved aside by `readJsonOrFresh`
 * (`routing.secrets.json.corrupt-<timestamp>`), and the temp file of a write that died before its
 * rename. `store.ts` creates the file and its temp files owner-only, so every one of them is -- for a
 * file the bot wrote. One a deployment put there by hand keeps its own mode until the bot's first
 * write replaces it (and is moved aside at that mode if it will not parse).
 */
export interface RoutingSecretsFile {
  v: 1;
  webhooks: Record<string, string>;
}

export interface DiscoveryChannel {
  id: string;
  name: string;
  canSend: boolean;
}
export interface DiscoveryGuild {
  id: string;
  name: string;
  channels: DiscoveryChannel[];
  commands: { registered: number; error?: string; at: string } | null;
}
export interface DiscoveryFile {
  v: 1;
  generatedAt: string;
  bot: { id: string; username: string };
  inviteUrl: string;
  homeGuildId: string | null;
  guilds: DiscoveryGuild[];
  plugins: Record<string, { posts: boolean; commands: string[] }>;
}

export function freshRouting(): RoutingFile {
  return { v: ROUTING_VERSION, updatedAt: "", updatedBy: "", plugins: {}, webhooks: {}, results: [] };
}

export function freshSecrets(): RoutingSecretsFile {
  return { v: ROUTING_VERSION, webhooks: {} };
}

/**
 * `text` cut to at most `max` UTF-16 units, as well-formed text: a cut never ends on half of a surrogate
 * pair, and a lone surrogate (a `"\ud83d"` escape in some JSON, say) becomes U+FFFD. A value that is
 * about to go into `routing.json` for the panel to read needs this: a lone surrogate makes text that
 * `encodeURIComponent` throws on.
 */
export function clip(text: string, max: number): string {
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.toWellFormed();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE_RE.test(value);
}

/** "all", or a copy of a non-empty list of snowflake strings; anything else is not a scope. */
function repairScope(value: unknown): CommandScope | undefined {
  if (value === "all") return "all";
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const channels: string[] = [];
  for (const channel of value) {
    if (!isSnowflake(channel)) return undefined;
    channels.push(channel);
  }
  return channels;
}

function repairPlugin(value: unknown): PluginRouting | undefined {
  if (!isPlainObject(value) || !isPlainObject(value.servers)) return undefined;
  const servers: Record<string, ServerRouting> = {};
  for (const [guildId, entry] of Object.entries(value.servers)) {
    // The key is tested before it is used, so `__proto__` can never reach the assignment below.
    if (!SNOWFLAKE_RE.test(guildId) || !isPlainObject(entry)) continue;
    const commands = repairScope(entry.commands);
    if (commands === undefined) continue;
    const repaired: ServerRouting = { commands };
    // A bad `postTo` costs the server its posting channel, not its whole entry.
    if (isSnowflake(entry.postTo)) repaired.postTo = entry.postTo;
    servers[guildId] = repaired;
  }
  return { servers };
}

function repairWebhook(value: unknown): WebhookMeta | undefined {
  if (!isPlainObject(value)) return undefined;
  const { id, guildId, addedAt, addedBy, broken } = value;
  if (!isSnowflake(id) || !isSnowflake(guildId)) return undefined;
  if (typeof addedAt !== "string" || typeof addedBy !== "string") return undefined;
  // Only the known keys are copied, so a `url` or `token` a hand-edit put here is dropped, never
  // carried forward into the next write.
  const repaired: WebhookMeta = { id, guildId, addedAt, addedBy };
  if (typeof broken === "string") repaired.broken = broken;
  return repaired;
}

/**
 * One request result, or undefined. Only an `id` that a panel could have chosen, a string `action` and
 * `at`, and a boolean `ok` make one; `plugin` and `channelId` are kept when they have the shape of a
 * plugin name / snowflake, `reason` when it is text (clipped), and nothing else is copied.
 */
function repairResult(value: unknown): RequestResult | undefined {
  if (!isPlainObject(value)) return undefined;
  const { id, action, plugin, channelId, ok, reason, at } = value;
  if (typeof id !== "string" || !REQUEST_ID_RE.test(id)) return undefined;
  if (typeof action !== "string" || typeof at !== "string" || typeof ok !== "boolean") return undefined;
  const repaired: RequestResult = { id, action, ok, at };
  if (typeof plugin === "string" && PLUGIN_NAME_RE.test(plugin)) repaired.plugin = plugin;
  if (isSnowflake(channelId)) repaired.channelId = channelId;
  if (typeof reason === "string") repaired.reason = clip(reason, MAX_REASON_LENGTH);
  return repaired;
}

/**
 * `file` with `result` appended, keeping the newest `MAX_RESULTS`. Pure. An earlier result under the same
 * `id` is replaced rather than kept beside it: an id names one request, so a request that is handled
 * twice (replayed after a crash, or sent again by the panel) leaves one entry, and cannot push the
 * other requests' outcomes out of the list.
 */
export function withResult(file: RoutingFile, result: RequestResult): RoutingFile {
  return { ...file, results: [...file.results.filter((r) => r.id !== result.id), result].slice(-MAX_RESULTS) };
}

/**
 * Whatever was on disk, as a valid `RoutingFile`. Never throws, and always returns a NEW object
 * (nothing is shared with `raw`, so a caller may mutate the result freely).
 *
 * Anything that is not a plain object is fresh. Inside an object, an entry that is malformed is
 * dropped on its own -- a plugin whose name fails `PLUGIN_NAME_RE`; a server whose id is not a
 * snowflake or whose `commands` is neither "all" nor a non-empty list of channel ids; a webhook that
 * lacks its ids; a result without a valid `id`, `action`, `at` and `ok` -- and a bad `postTo` is
 * dropped from a server that is otherwise kept. Unknown keys are not carried over. A file written
 * before `results` existed has none and repairs to an empty list; the list is trimmed to the newest
 * `MAX_RESULTS`.
 *
 * The file's own `v` is not consulted: it is read by shape, and the result always says `v: 1`. That
 * is what keeps a hand-seeded file that forgot `v` from being thrown away whole. It also means that
 * rolling back from a newer version loses whatever only that version understood -- the next write
 * drops it -- so a version that changes the shape has to change this reader first.
 */
export function repairRouting(raw: unknown): RoutingFile {
  const repaired = freshRouting();
  if (!isPlainObject(raw)) return repaired;
  if (typeof raw.updatedAt === "string") repaired.updatedAt = raw.updatedAt;
  if (typeof raw.updatedBy === "string") repaired.updatedBy = raw.updatedBy;

  if (isPlainObject(raw.plugins)) {
    for (const [name, entry] of Object.entries(raw.plugins)) {
      if (!PLUGIN_NAME_RE.test(name)) continue;
      const plugin = repairPlugin(entry);
      if (plugin !== undefined) repaired.plugins[name] = plugin;
    }
  }
  if (isPlainObject(raw.webhooks)) {
    for (const [channelId, entry] of Object.entries(raw.webhooks)) {
      if (!SNOWFLAKE_RE.test(channelId)) continue;
      const webhook = repairWebhook(entry);
      if (webhook !== undefined) repaired.webhooks[channelId] = webhook;
    }
  }
  if (Array.isArray(raw.results)) {
    for (const entry of raw.results) {
      const result = repairResult(entry);
      if (result !== undefined) repaired.results.push(result);
    }
    repaired.results = repaired.results.slice(-MAX_RESULTS);
  }
  return repaired;
}

/**
 * What `repairRouting` would drop from `raw`, as short messages that NAME each dropped thing (#260). Pure,
 * silent, and, like `repairRouting`, not going to throw on anything `JSON.parse` can produce: `repairRouting`
 * stays tolerant and quiet, and `readRouting` says these once.
 *
 * A message names a key (a plugin name, a server id, a channel id), passed through `shown`, and, with one
 * exception, never a value: a value can be anything a person typed. `shown` shows at most 40 characters
 * (a longer text is cut to its first 37 and `...`). A token starts at character 39 of a Discord webhook URL
 * at the earliest (51 or later with a real id), so a URL used as a key is cut before its token. The
 * exception is a bad `postTo`, whose value is shown (through `shown` too) so the operator can see what was
 * wrong with it. A webhook entry that carried a stray `url` or `token` key is not a dropped entry -- the
 * repair keeps the entry and drops the key, by design -- so it reports nothing.
 *
 * The primitives are the repair's own (`repairScope`, `repairWebhook`, `isSnowflake` and the two regexes are
 * shared, not copied, and the reason a webhook is refused is asked of `repairWebhook` itself); how they are
 * combined is mirrored from `repairPlugin` and `repairRouting`, so a table-driven test in `model.test.ts`
 * pins that this says something exactly when the repair drops one of these kinds of thing. Also said: a
 * `raw` that is not an object at all (the file holds `[]` or `"x"`: a missing file is not that,
 * `readJsonOrFresh` reads it as a fresh object), and a `plugins` or `webhooks` that is not an object. NOT
 * reported: a `results` entry (the bot's own bookkeeping, not configuration), and an `undefined` `raw`
 * (nothing was read, which `readRouting` never hands over).
 */
export function droppedByRepair(raw: unknown): string[] {
  const dropped: string[] = [];
  if (raw === undefined) return dropped;
  if (!isPlainObject(raw)) {
    dropped.push("the file is not an object");
    return dropped;
  }

  if (raw.plugins !== undefined && !isPlainObject(raw.plugins)) dropped.push("plugins is not an object");
  if (isPlainObject(raw.plugins)) {
    for (const [name, entry] of Object.entries(raw.plugins)) {
      const plugin = `plugin ${shown(name)}`;
      if (!PLUGIN_NAME_RE.test(name)) {
        dropped.push(`${plugin} is not a valid plugin name`);
        continue;
      }
      if (!isPlainObject(entry) || !isPlainObject(entry.servers)) {
        dropped.push(`${plugin} is not an object with a servers object`);
        continue;
      }
      for (const [guildId, server] of Object.entries(entry.servers)) {
        const where = `${plugin}: server ${shown(guildId)}`;
        if (!SNOWFLAKE_RE.test(guildId)) {
          dropped.push(`${where} is not a server id`);
        } else if (!isPlainObject(server) || repairScope(server.commands) === undefined) {
          dropped.push(`${where} has no valid commands ("all" or a list of channel ids)`);
        } else if (server.postTo !== undefined && !isSnowflake(server.postTo)) {
          // The server entry is kept, as the repair keeps it; only its posting channel is lost.
          dropped.push(`${where}: postTo ${shown(server.postTo)} is not a channel id`);
        }
      }
    }
  }

  if (raw.webhooks !== undefined && !isPlainObject(raw.webhooks)) dropped.push("webhooks is not an object");
  if (isPlainObject(raw.webhooks)) {
    for (const [channelId, entry] of Object.entries(raw.webhooks)) {
      const webhook = `webhook for ${shown(channelId)}`;
      if (!SNOWFLAKE_RE.test(channelId)) {
        dropped.push(`${webhook} is not a channel id`);
      } else if (repairWebhook(entry) === undefined) {
        // `repairWebhook` refuses for two reasons and the message says which: naming the wrong one would
        // send whoever is reading the log to the wrong field. The repair is asked, not second-guessed: would
        // it keep this entry if it had an addedAt and an addedBy? If so, those were what was missing. (Any
        // string will do for them today; a stricter rule for those two fields would have to change this.)
        const withDates = isPlainObject(entry) ? { ...entry, addedAt: "-", addedBy: "-" } : entry;
        if (repairWebhook(withDates) === undefined) dropped.push(`${webhook} is missing its ids`);
        else dropped.push(`${webhook} is missing its addedAt or addedBy`);
      }
    }
  }
  return dropped;
}

/**
 * The secrets file, repaired the same way (never throws, a new object, `v` not consulted): only
 * `channel id -> non-empty string` pairs survive.
 */
export function repairSecrets(raw: unknown): RoutingSecretsFile {
  const repaired = freshSecrets();
  if (!isPlainObject(raw) || !isPlainObject(raw.webhooks)) return repaired;
  for (const [channelId, url] of Object.entries(raw.webhooks)) {
    if (SNOWFLAKE_RE.test(channelId) && typeof url === "string" && url !== "") repaired.webhooks[channelId] = url;
  }
  return repaired;
}
