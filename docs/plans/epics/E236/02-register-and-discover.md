## Implementation plan — written by the orchestrating session, to be executed as written

One PR, branch `claude/routing-register` cut from `origin/main` (which now carries #237: `src/routing/model.ts`, `resolve.ts`, `store.ts`, ADR-0006), in an isolated worktree. Commit this plan as `docs/plans/epics/E236/02-register-and-discover.md`.

This is the first child that changes what the bot does. Its governing rule: **with no `routing.json`, or one that places no plugin, the bot must make exactly the registration call it makes today and log exactly the line it logs today.** Everything new is behind `hasPlacements(routing)`.

### Decided — not open for re-planning

- **Build the command body once, filter it per server.** Today `buildCommandBody` (`src/plugins/host.ts:142`) runs every plugin's `build()` once and returns the full body. Per-server bodies are *filtered views* of that one array by owning plugin — plugin code is never run once per server, and a plugin whose builder fails is logged once, not once per server.
- **Core commands go to every server** the bot is in (ADR-0006 decision 2).
- **In routed mode the bot manages every server it is in**: a server no plugin lives in gets the core commands only.
- **One failure never stops the rest, or the boot.** A refusal in one server is recorded against that server and the loop continues — the same "a registration failure must not take the bot down" contract the existing `try/catch` at `src/index.ts:184-210` keeps.
- **`snapshotGuilds` is the only function that touches discord.js objects.** Everything else takes plain data, so it tests without a `Client`.
- **Everything that re-registers goes through one serialized entry point**, `applyRouting`, because the next child (#241) will call it from the request mailbox while a boot registration or a periodic refresh may be in flight.

### Step 1 — `src/routing/register.ts` (pure planning + one I/O function)

```ts
import type { RESTPostAPIChatInputApplicationCommandsJSONBody as CommandJson } from "discord.js";

/** The plugin that owns a built command, or null for a core command. `builtName` is the registered (prefixed) name. */
export function ownerOf(builtName: string, prefix: string, commandMap: PluginCommandMap): string | null

export type RegistrationPlan =
  | { mode: "single"; scope: "guild"; guildId: string; body: CommandJson[] }
  | { mode: "single"; scope: "global"; body: CommandJson[] }
  | { mode: "routed"; bodies: Map<string, CommandJson[]>; clearGlobal: boolean };

export function planRegistration(opts: {
  routing: RoutingFile;
  fullBody: readonly CommandJson[];      // what buildCommandBody returned
  prefix: string;
  commandMap: PluginCommandMap;
  loaded: readonly string[];             // loaded plugin names, in load order
  guildIds: readonly string[];           // every server the bot is in
  homeGuildId: string | undefined;       // config.guildId
}): RegistrationPlan

export interface GuildRegistration { guildId: string | "global"; registered: number; error?: string; at: string }

export async function registerPlan(
  put: (route: `/${string}`, body: CommandJson[]) => Promise<unknown>,
  appId: string,
  plan: RegistrationPlan,
  now: () => Date,
): Promise<GuildRegistration[]>
```

- `planRegistration`: `!hasPlacements(routing)` → `single` — `guild` with `homeGuildId` when it is set, else `global` — carrying `fullBody` **unchanged** (same array contents, same order). Otherwise `routed`: for each id in `guildIds` (in the order given), the body is every entry of `fullBody` whose `ownerOf` is `null` (core) or is in `pluginsForGuild(routing, guildId, loaded, homeGuildId)`, order preserved. `clearGlobal` is `homeGuildId === undefined` — a bot that was registering globally must empty the global scope once it goes per-server, or every command shows twice.
- `registerPlan`: `single` → exactly one `put` — `Routes.applicationGuildCommands(appId, guildId)` or `Routes.applicationCommands(appId)` — and **it lets a failure throw** (the caller keeps today's `catch` and its long message). `routed` → one `put` per server, **sequentially**, each in its own `try/catch`; when `clearGlobal`, a final `put(Routes.applicationCommands(appId), [])`, also guarded. A failure becomes `error`: `"<message> (<code>)"` for a `DiscordAPIError` (duck-typed on a numeric `code`), else `String(err)`, clipped to 200 characters. Never throws in routed mode.

### Step 2 — `src/routing/discovery.ts`

```ts
export interface GuildSnapshot { id: string; name: string; channels: DiscoveryChannel[] }
/** The ONLY function here that touches discord.js. Text and announcement channels, by position then name. */
export function snapshotGuilds(client: Client<true>): GuildSnapshot[]
/** `https://discord.com/oauth2/authorize?client_id=<appId>&scope=bot+applications.commands&permissions=2048` — the README's invite, with this bot's id. */
export function inviteUrl(appId: string): string
export function buildDiscovery(opts: {
  now: Date; bot: { id: string; username: string }; homeGuildId: string | undefined;
  snapshots: readonly GuildSnapshot[]; registrations: readonly GuildRegistration[];
  plugins: readonly { name: string; commands: string[]; posts: boolean }[];
}): DiscoveryFile                                              // pure
export function discoveryPath(dataDir: string): string         // `${dataDir}/discovery.json`
export async function writeDiscovery(dataDir: string, file: DiscoveryFile): Promise<void>   // writeJsonAtomic
```

- `snapshotGuilds`: iterate `client.guilds.cache`; per guild keep channels whose `type` is `ChannelType.GuildText` or `ChannelType.GuildAnnouncement`; `canSend` is `channel.permissionsFor(client.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) ?? false`; sort by `rawPosition`, then name. Guilds sorted by name. (`CORE_INTENTS` is `[Guilds]` — `src/client.ts` — which is what fills these caches; no new intent.)
- `buildDiscovery`: a guild's `commands` is its `GuildRegistration` (`{ registered, error?, at }`) or `null` when there is none for it — which is every guild in `single` mode except the home server. `homeGuildId` → `null` when unset. `plugins` keyed by name.
- A plugin "posts" when it has ticks: `(lp.plugin.ticks?.length ?? 0) > 0`, read defensively exactly as `pluginTicks` does (`src/plugins/host.ts:198` — a malformed or throwing `ticks` must not escape).

### Step 3 — `src/routing/live.ts` (the one stateful module)

```ts
export interface RoutingContext {
  client: Client<true>; put: (route: `/${string}`, body: CommandJson[]) => Promise<unknown>;
  appId: string; dataDir: string; homeGuildId: string | undefined; prefix: string;
  fullBody: readonly CommandJson[]; commandMap: PluginCommandMap;
  plugins: readonly { name: string; commands: string[]; posts: boolean }[];
  now: () => Date; log: Pick<Console, "log" | "warn" | "error">;
}
export function initRouting(ctx: RoutingContext): void
/** Read routing → plan → register → write discovery. Serialized: a second call queues behind the first. */
export function applyRouting(reason: string): Promise<GuildRegistration[]>
/** Re-snapshot and rewrite discovery.json with the last registrations. Serialized on the same chain. */
export function refreshDiscovery(): Promise<void>
export function resetRoutingForTest(): void
```

- `applyRouting` in `single` mode rethrows the registration error **after** writing discovery (with that failure recorded against the home server / `"global"`), so `index.ts` still reaches its existing `catch`. In `routed` mode it never throws.
- Log lines. `single`: **none here** — `index.ts` keeps printing `Registered ${n} slash commands` itself. `routed`: `Registered commands in <k> servers (<name>: <n>, …)` and, per failure, `[routing] couldn't register commands in <name> (<id>): <error>`. ASCII only.
- A discovery write failure is logged and swallowed — it is a view for the panel, never a reason to fail a registration.

### Step 4 — wire it: `src/index.ts` and `src/announce.ts`

- `index.ts`, in `activate()`: replace the body of the `try` at `:184-191` with `initRouting({...})` then `const results = await applyRouting("boot")`. Keep the `try/catch` and its message **verbatim**. After it, keep `console.log(\`Registered ${commandBody.length} slash commands\`)` for the `single` case only (the routed line comes from `live.ts`) — decide by `results.length === 1 && plan was single`; simplest is for `applyRouting` to return the mode alongside the results.
- `announce.ts`: one more core check in `tickChecks`, after `pluginUpdates` and before `...extra`: `{ name: "discovery", run: async () => { if (shouldRefreshDiscovery()) await refreshDiscovery(); } }` with a `DISCOVERY_REFRESH_GAP_MS = 15 * 60 * 1000` gap stamped at start, the same shape as `shouldPollReleases`. A `refreshDiscovery` before `initRouting` is a no-op. **Another session is working Epic #235 in `announce.ts` (#217 has merged; #248 is open) — keep this edit to those few lines, and `gh pr update-branch` rather than hand-merging if it conflicts; a conflict in the tick machinery itself is a stop-and-tell.**

### Step 5 — tests

`src/routing/register.test.ts` —
`with no routing the plan is today's single guild call, body untouched` · `with no routing and no home server the plan is today's global call` · `a file that places nobody is still single` · `a placed plugin's commands go only to its servers` · `an unplaced plugin's commands go to the home server only` · `core commands go to every server` · `a server nobody lives in gets core only` · `a plugin placed nowhere is registered nowhere` · `order within a body is the full body's order` · `ownerOf strips the prefix and names the plugin, or null for core` · `clearGlobal is set only when there is no home server` · `single mode issues exactly one put, to the guild route` · `… to the global route` · `single mode lets a failure throw` · `routed mode puts once per server, in order` · `a refusal in one server is recorded and the rest still register` · `a DiscordAPIError is reported as "message (code)"` · `a long error is clipped` · `routed mode empties the global scope when asked, and survives that failing`.

`src/routing/discovery.test.ts` —
`inviteUrl carries both scopes and the app id` · `a guild's commands are its registration, or null` · `homeGuildId is null when unset` · `a plugin with ticks posts, one without does not` · `snapshotGuilds keeps text and announcement channels only, in position order` · `canSend is false without Send Messages, and false when permissions cannot be computed` (structural fakes cast to `Client<true>`) · `writeDiscovery writes the documented shape` (temp dir).

`src/routing/live.test.ts` —
`boot with no routing: one put, discovery written, single mode reported` · `boot with routing: one put per server, discovery carries each result` · `two applyRouting calls never interleave` (the second's first `put` comes after the first's discovery write) · `a single-mode failure is rethrown after discovery records it` · `a discovery write failure is logged, not thrown` · `refreshDiscovery before initRouting is a no-op` · `refreshDiscovery reuses the last registrations`.

`src/announce.test.ts` — extend the existing `tickChecks` composition test: `discovery` sits after `pluginUpdates` and before the plugin ticks; `the discovery check respects its gap`.

### Step 6 — docs

`CONTEXT.md`: file-map rows for the three modules; in **Behavior**, how registration now decides (`single` vs `routed`) and when `discovery.json` is written; a gotcha — *in routed mode the bot owns the command list of every server it is in, so a server nobody lives in gets the core commands only; a deployment seeds `routing.json` before its first routed boot (#247)*. `README.md`: one paragraph under the `DISCORD_SERVER_ID` description — it is the **home server** once routing exists. Verify each sentence against the merged code.

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| no routing → today's call, byte for byte | 1, 4 | `with no routing the plan is today's single guild call…`, `single mode issues exactly one put…` | always take the routed path; filter `fullBody` in single mode |
| each server gets core + its plugins | 1 | `a placed plugin's commands go only to its servers`, `core commands go to every server` | drop the core rule; ignore `pluginsForGuild` |
| unplaced → home server only | 1 | `an unplaced plugin's commands go to the home server only` | pass `undefined` as the home server |
| one refusal never stops the rest | 1, 3 | `a refusal in one server is recorded and the rest still register` | remove the per-server `try/catch` |
| the refusal shows in discovery | 2, 3 | `boot with routing: … discovery carries each result` | build discovery before registering |
| discovery has the documented shape | 2 | the `discovery.test.ts` tests | emit `commands: {registered: 0}` instead of `null` |
| global scope emptied when leaving global mode | 1 | `clearGlobal is set only when there is no home server`, `routed mode empties the global scope…` | never send the empty global `put` |
| no interleaving | 3 | `two applyRouting calls never interleave` | call the body directly instead of chaining |
| a registration failure never kills the boot | 3, 4 | `a single-mode failure is rethrown after discovery records it` + the untouched `catch` in `index.ts` | swallow the single-mode error in `live.ts` (then today's operator message is lost) |
| `discovery.json` lists the real servers on `debug` | — | manual — the deploy child (#247) | — |

### Verification — paste the real output in the PR

```
bun run check
bun test
```

Mutation checks in a scratch worktree, one at a time, `bun test src/routing src/announce.test.ts`.

**Run every `bun test` — yours, your reviewers', your mutation runs — with a private temp dir**, e.g. `TEMP=R:/repos/Scratch/tmp/bot-239 TMP=R:/repos/Scratch/tmp/bot-239 bun test` (create the dir first). `test/setup.ts` sweeps every `rackbops-bot-test-data-*` directory in the system temp dir at start-up, so two suites running at once on this machine delete each other's data dir mid-run; another subordinate is testing in this repo at the same time. This is the likeliest cause of the unattributed first-run failures already seen.

---

**One signature in the plan above is settled here rather than left to the implementer**, because the next child (#241) calls it: `applyRouting(reason: string): Promise<{ mode: "single" | "routed"; results: GuildRegistration[] }>`. Step 3's code block shows the older `Promise<GuildRegistration[]>`; Step 4's "return the mode alongside the results" is the decision. `index.ts` prints today's `Registered ${commandBody.length} slash commands` only when `mode === "single"`.
