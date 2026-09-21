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
/** `webhooks` key: channel id. Metadata only -- the URL is in `RoutingSecretsFile`. */
export interface RoutingFile {
  v: 1;
  updatedAt: string;
  updatedBy: string;
  plugins: Record<string, PluginRouting>;
  webhooks: Record<string, WebhookMeta>;
}
/**
 * channel id -> webhook URL. The only FILE the bot stores a webhook URL in -- though the same bytes
 * can sit beside it under another name: a corrupt copy moved aside by `readJsonOrFresh`
 * (`routing.secrets.json.corrupt-<timestamp>`), and the temp file of a write that died before its
 * rename. `store.ts` creates the file and its temp files owner-only, so every one of them is.
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
  return { v: ROUTING_VERSION, updatedAt: "", updatedBy: "", plugins: {}, webhooks: {} };
}

export function freshSecrets(): RoutingSecretsFile {
  return { v: ROUTING_VERSION, webhooks: {} };
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
 * Whatever was on disk, as a valid `RoutingFile`. Never throws, and always returns a NEW object
 * (nothing is shared with `raw`, so a caller may mutate the result freely).
 *
 * Anything that is not a plain object is fresh. Inside an object, an entry that is malformed is
 * dropped on its own -- a plugin whose name fails `PLUGIN_NAME_RE`; a server whose id is not a
 * snowflake or whose `commands` is neither "all" nor a non-empty list of channel ids; a webhook that
 * lacks its ids -- and a bad `postTo` is dropped from a server that is otherwise kept. Unknown keys
 * are not carried over.
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
  return repaired;
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
