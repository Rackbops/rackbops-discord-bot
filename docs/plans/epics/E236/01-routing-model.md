## Implementation plan — written by the orchestrating session, to be executed as written

One PR, branch `claude/routing-model` cut from `origin/main`, in an isolated worktree. Commit this plan as `docs/plans/epics/E236/01-routing-model.md`.

This child fixes the **contract** every other child of #236 builds against — the bot chain, `ops/bot-ops.sh` and the panel all read these shapes — so the names and semantics below are decided, not suggestions. Nothing here is wired into `src/index.ts`: with this merged the bot behaves exactly as before.

### Step 1 — `docs/adr/0006-per-plugin-routing.md` (commit this text; fix nothing but typos)

```markdown
# Where a plugin lives is bot-owned data, applied live

Until Epic #236 every slash command was registered to one guild (`DISCORD_SERVER_ID`, one
`rest.put` in `src/index.ts`) and every plugin's `announce` posted to one channel
(`ANNOUNCE_CHANNEL_ID`). Neither was a per-plugin setting, and neither could be reached from the
admin panel. Going live with the `music` plugin on 2026-09-20 made the cost concrete: its commands
were wanted in a second server the bot was already in, and the only way to get them there was a
hand-made call to the Discord API.

Three constraints shape the answer. The panel is a separate container that **never holds the Discord
token** (`docker-compose.yml`'s `admin` service is deliberately not given the instance `.env`), so it
cannot ask Discord which servers or channels exist. Configuration today is **flat `.env` scalars that
only take effect on a container recreate** (`ops/bot-ops.sh env-set`), which is the wrong shape and
the wrong latency for "this plugin, these servers, these channels". And `src/plugins/contract.ts` is
a **shipped contract**: changing `HostApi` affects every published plugin.

**Decision:** where a plugin lives is data the bot owns, in its data dir, changed through the
request mailbox and applied without a restart.

1. **`data/routing.json` is the record, and the bot is its only writer.** Per plugin, per server:
   where its commands work (`"all"`, or a list of channels) and the channel it posts to. The panel
   asks for a change by dropping a request in the mailbox (`src/plugins/requests.ts`), exactly as it
   already does for plugin updates; the bot validates it against what it can actually see, writes
   the file, re-registers commands and carries on. Nothing restarts.
2. **Routing is per plugin, not per command.** A plugin's whole command set goes where the plugin
   lives. Core commands (`report`, `update`, `plugins`) go to every server the bot is in; the two
   admin ones are already hidden from non-admins by `setDefaultMemberPermissions(0)`.
3. **A plugin nobody has placed lives in the home server.** `DISCORD_SERVER_ID` stops meaning "the
   only server" and becomes "the home server": a plugin with no entry in `routing.json` registers
   there and posts to `ANNOUNCE_CHANNEL_ID`, exactly as before. With no `routing.json` at all the
   bot makes byte-for-byte the registration call it makes today.
4. **The bot publishes what it can see, as `data/discovery.json`.** Its servers, their text
   channels and whether it can post in each, the outcome of the last command registration per
   server, and an invite URL carrying the `applications.commands` scope. The panel reads that file
   and offers names to pick from; nobody types a Discord id.
5. **Posting goes through the channel's webhook when one is registered, and as the bot when none
   is.** A webhook is an upgrade — its own name and avatar — never a requirement. A webhook URL is
   a secret: it is stored only in `data/routing.secrets.json`, never in `routing.json`,
   `discovery.json`, a log line or a rejected request.
6. **`HostApi.announce(message)` does not change.** The host resolves a plugin's channels where it
   builds that plugin's `announce`; `HOST_API_VERSION` does not move and no published plugin is
   affected.
7. **Channel restrictions are enforced by the bot at dispatch**, because a bot cannot edit
   Discord's per-channel command permissions (that needs a user's bearer token). A command used
   outside its channels gets a private reply naming the right ones; a thread counts as its parent.
8. **The panel may set plugin-declared secret keys, write-only.** A key the Plugin Index marks
   `secret: true` can be written through `env-set`, is never returned by `env-get`, and appears in
   `env-schema` only as `secret` + `isSet`. Core secrets stay uneditable. This loosens
   "secrets are never edited by ops tooling" deliberately: needing SSH to give a plugin its API key
   was half of what made adding one painful, and the panel is already behind Cloudflare Access, an
   email allow-list and the cross-site-write gate. A plugin's admin bundle already runs with the
   panel's authority (#226); write-only keeps a compromised one from *reading* a secret.

## Considered Options

- **Encode routing in `.env`** (a JSON value, or compound keys). Fits `env-set` with the least new
  plumbing, but every change costs a recreate — about twenty seconds offline to move a plugin into a
  channel — and a map of maps in an env var is unreviewable. Rejected.
- **Give the panel the Discord token** so it can list servers and register commands itself.
  Rejected: it would hand the root-equivalent panel container the one secret it is deliberately
  kept from, and create a second writer of Discord state racing the bot.
- **`announce(message, channelId?)`**, the plugin sourcing the id from its own env key (#219 as
  filed). Rejected for this case: it moves the pasted snowflake from one env key to many, makes every
  plugin re-implement "where do I post", and changes a shipped contract. Named destinations
  (`announce(message, "alerts")`, mapped to channels in the same panel row) remain a compatible
  later extension and stay open on #219.
- **Per-command routing.** Rejected as unneeded: the one apparently curated per-server command set
  in production turned out to be a stale registration, not a choice.
- **Global command registration.** Puts every command in every server, with up to an hour's
  propagation. Rejected: it is the opposite of choosing where a plugin lives.

## Consequences

- The bot manages the command list of **every** server it is in, not only the home server. A server
  no plugin lives in gets the core commands and nothing else, so a deployment must seed
  `routing.json` to mirror what is live before its first routed boot (#247).
- `ops/bot-ops.sh` gains a read of two more files and four request actions, and its schema number
  moves (#240); a deployed instance needs `ops/install.sh` re-run, which the panel's out-of-date
  banner already reports.
- Discovery is only as fresh as the bot's last write. The panel shows when it was generated and
  offers a refresh; it never guesses.
- Two bots in one server do not disturb each other: commands are scoped to the application, and
  `COMMAND_PREFIX` already keeps their names apart.
```

### Step 2 — `src/routing/model.ts`

```ts
export const ROUTING_VERSION = 1 as const;
/** Same rule as PluginIndexEntry.name. */
export const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
/** A Discord snowflake as it appears in JSON. */
export const SNOWFLAKE_RE = /^[0-9]{5,25}$/;

/** "all", or a NON-EMPTY list of channel ids. */
export type CommandScope = "all" | string[];
export interface ServerRouting { commands: CommandScope; /** absent = does not post in this server */ postTo?: string }
export interface PluginRouting { servers: Record<string, ServerRouting> }          // key: guild id
export interface WebhookMeta { id: string; guildId: string; addedAt: string; addedBy: string; /** why Discord refused it, once it has */ broken?: string }
export interface RoutingFile { v: 1; updatedAt: string; updatedBy: string; plugins: Record<string, PluginRouting>; webhooks: Record<string, WebhookMeta> } // webhooks key: channel id
export interface RoutingSecretsFile { v: 1; webhooks: Record<string, string> }      // channel id -> webhook URL

export interface DiscoveryChannel { id: string; name: string; canSend: boolean }
export interface DiscoveryGuild { id: string; name: string; channels: DiscoveryChannel[]; commands: { registered: number; error?: string; at: string } | null }
export interface DiscoveryFile { v: 1; generatedAt: string; bot: { id: string; username: string }; inviteUrl: string; homeGuildId: string | null; guilds: DiscoveryGuild[]; plugins: Record<string, { posts: boolean; commands: string[] }> }

export function freshRouting(): RoutingFile            // { v:1, updatedAt:"", updatedBy:"", plugins:{}, webhooks:{} }
export function freshSecrets(): RoutingSecretsFile
export function repairRouting(raw: unknown): RoutingFile
export function repairSecrets(raw: unknown): RoutingSecretsFile
```

`repairRouting` never throws. Anything that is not a plain object → fresh. `plugins` / `webhooks` that are not plain objects → `{}`. Inside `plugins`: drop an entry whose name fails `PLUGIN_NAME_RE`, whose `servers` is not a plain object, or — per server — whose key fails `SNOWFLAKE_RE`, whose `commands` is neither `"all"` nor a non-empty array of snowflake strings, or whose `postTo` is present but not a snowflake string (drop the `postTo`, keep the server). Use `Object.hasOwn` / `Object.entries`, never a bare bracket lookup on untrusted keys (see `repoForProject` in `src/config.ts` for why). Always returns a new object.

### Step 3 — `src/routing/resolve.ts` (pure; no I/O, no discord.js import)

```ts
/** Has the operator placed this plugin at all? An entry with `servers: {}` IS placed — it lives nowhere. */
export function isPlaced(routing: RoutingFile, plugin: string): boolean
/** Does anything in the file ask for per-server registration? */
export function hasPlacements(routing: RoutingFile): boolean
/** Loaded plugins that live in `guildId`, in `loaded`'s order. Unplaced → the home server only; with no home server, every server. */
export function pluginsForGuild(routing: RoutingFile, guildId: string, loaded: readonly string[], homeGuildId: string | undefined): string[]
/** Channels a plugin posts to: every `postTo` it has, de-duplicated, ordered by guild id; none → `[defaultChannelId]`. */
export function announceTargets(routing: RoutingFile, plugin: string, defaultChannelId: string): string[]
export type GateResult = { allowed: true } | { allowed: false; channels: string[] }
/** May `plugin`'s command run here? Unplaced, no entry for this server, or "all" → allowed. A list → allowed iff `channelId` or `parentChannelId` is on it. */
export function commandAllowed(routing: RoutingFile, plugin: string, guildId: string, channelId: string, parentChannelId?: string): GateResult
/** One plugin's routing as the panel sent it, checked against what the bot can see. Returns a clean value (unknown keys stripped) or the first problem. */
export function validatePluginRouting(input: unknown, discovery: DiscoveryFile): { ok: true; value: PluginRouting } | { ok: false; reason: string }
```

`validatePluginRouting` reasons, exact wording (they surface in the panel): `routing must be an object with a servers object` · `server <id> is not one the bot is in` · `commands for server <id> must be "all" or a list of channels` · `the channel list for server <id> is empty` · `channel <id> is not in server <id>` · `postTo <id> is not in server <id>`. `servers: {}` is valid.

### Step 4 — `src/routing/store.ts`

```ts
export function routingPath(dataDir: string): string          // `${dataDir}/routing.json`
export function secretsPath(dataDir: string): string          // `${dataDir}/routing.secrets.json`
export async function readRouting(dataDir: string): Promise<RoutingFile>            // readJsonOrFresh, then repairRouting
export async function mutateRouting(dataDir: string, mutate: (current: RoutingFile) => RoutingFile): Promise<void>
export async function readSecrets(dataDir: string): Promise<RoutingSecretsFile>
export async function mutateSecrets(dataDir: string, mutate: (current: RoutingSecretsFile) => RoutingSecretsFile, chmod?: (path: string, mode: number) => Promise<void>): Promise<void>
```

Both mutators go through **one module-level `createKeyedJsonMutator`** each (the `stateMutator` pattern at `src/plugins/host.ts:411`), so a read-modify-write is serialized per file; `mutate` always receives a **repaired** value. `mutateSecrets` then sets the file to `0o600` — `chmod` defaults to `node:fs/promises`'s and its failure is logged, not thrown. Callers always pass `dataDir`; nothing here reads `DATA_DIR` (read CONTEXT.md's `BOT_DATA_DIR` gotcha first).

### Step 5 — tests

`src/routing/model.test.ts` — `repairRouting`: `a non-object becomes fresh` · `a wrong-typed plugins or webhooks map becomes empty` · `drops a plugin with a malformed name` · `drops a server with a malformed id` · `drops a server whose channel list is empty` · `drops a malformed postTo but keeps the server` · `is not fooled by prototype keys` (`__proto__`, `constructor`) · `returns a new object, never the input`.

`src/routing/resolve.test.ts` — `an unplaced plugin lives in the home server only` · `with no home server an unplaced plugin lives everywhere` · `a placed plugin lives only in its servers` · `a plugin placed nowhere lives nowhere` · `keeps the loaded order` · `hasPlacements is false for a fresh file and true once a plugin is placed` · `a plugin with no postTo posts to the default channel` · `several postTo are all used, once each, in guild order` · `an unplaced plugin's command is allowed anywhere` · `a server with no entry allows the command` · `"all" allows any channel` · `a listed channel is allowed and an unlisted one names the list` · `a thread under a listed channel is allowed` · one test per `validatePluginRouting` reason above, plus `an empty servers map is valid` and `unknown keys are stripped from the value`.

`src/routing/store.test.ts` (a fresh `mkdtemp` dir per test) — `a missing file reads as fresh` · `an unparseable file reads as fresh and is moved aside` · `a wrong-shaped file reads as fresh` · `mutateRouting persists and the next read sees it` · `two overlapping mutateRouting calls both land` · `mutate always receives a repaired value` · `the secrets file is owner-only after a write` (`skipIf(process.platform === "win32")` — name it as CI-only in the PR) · `a chmod failure is logged, not thrown`.

### Step 6 — docs

`CONTEXT.md`: file-map rows for the three modules; glossary entries **Routing**, **Home server**, **Placed / unplaced plugin**, **Discovery**; one gotcha — *a plugin with an entry and no servers lives nowhere, while a plugin with no entry lives in the home server; the two are different on purpose*. `README.md` is not touched until the feature is wired.

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| unplaced → home server | 3 | `an unplaced plugin lives in the home server only` | return every guild for an unplaced plugin |
| placed → only its servers | 3 | `a placed plugin lives only in its servers` | ignore `isPlaced` and fall through to the home rule |
| placed nowhere ≠ unplaced | 3 | `a plugin placed nowhere lives nowhere` | make `isPlaced` require a non-empty `servers` |
| `"all"` vs a list; threads | 3 | the four `commandAllowed` tests | drop the `parentChannelId` check; treat a missing server entry as refused |
| posting targets | 3 | `a plugin with no postTo…`, `several postTo…` | return `[]` when there is no `postTo`; remove the de-duplication |
| validation rejects, naming the problem | 3 | one test per reason | accept an empty channel list; skip the channel-belongs-to-server check |
| wrong-shaped files load fresh | 2, 4 | the `repairRouting` tests, `a wrong-shaped file reads as fresh` | return `raw as RoutingFile`; skip `repairRouting` in `readRouting` |
| no lost update | 4 | `two overlapping mutateRouting calls both land` | replace the keyed mutator with a plain read then write |
| secrets file is owner-only | 4 | `the secrets file is owner-only after a write` (CI-only) | remove the `chmod` |
| nothing is wired yet | — | `git grep -n "routing/" src/index.ts` prints nothing — paste it | — |

### Verification — paste the real output in the PR

```
bun run check
bun test
git grep -n "routing/" src/index.ts src/commands.ts src/announce.ts
```

Mutation checks: scratch worktree (`git worktree add --detach <path> <sha>`), one mutation at a time, `bun test src/routing`, paste the failing test's name, `git worktree remove <path>`.
