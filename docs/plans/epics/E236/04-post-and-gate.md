## Implementation plan — written by the orchestrating session, to be executed as written

One PR, branch `claude/routing-post-and-gate` cut from `origin/main` **now** (amended 2026-09-21: it does not need #241's code -- only `routing.json`'s `webhooks` metadata and `routing.secrets.json`, whose shapes and readers have been on `main` since #237 -- so it runs in parallel with #241's last round), in an isolated worktree. #241 adds one call and one test block to `src/index.ts` / `src/index.test.ts`; keep this child's edits to those two files to the `makeHost` announce line, the interaction handler and their own pins, and **do not edit the `src/index.ts` row of `CONTEXT.md`'s File Map at all** (two other branches touch that row; the orchestrator updates it once, afterwards). Commit this plan as `docs/plans/epics/E236/04-post-and-gate.md`.

Its governing rule is the same as #239's: **with no `routing.json`, a plugin's `announce` makes exactly the call it makes today** — `announceTo(client, config.announceChannelId, message)` — and a command is never refused.

Read first: ADR-0006 decisions 5–7, `src/routing/resolve.ts` (`announceTargets`, `commandAllowed` — both already written and tested by #237; this child *calls* them, it does not change them), and `sendToChannel` / `announceTo` in `src/announce.ts`.

### One correction to the issue text

The issue says a dead webhook is "marked broken in `discovery.json`". The model (#237) already put that flag where the webhook's other metadata lives: `routing.json` → `webhooks[channelId].broken`. That is where this child writes it; `discovery.json` is untouched here. (The panel reads both files together, so it sees it either way.)

### Decided — not open for re-planning

- **`src/plugins/contract.ts` is not touched.** `HostApi.announce(message)` keeps its signature; `contract.test.ts` stays green unedited.
- **Every target gets the same rule, the default channel included:** a registered, unbroken webhook with a stored URL → post through it; otherwise the bot posts. A webhook failure of *any* kind falls back to the bot for that post.
- **Only "gone" marks a webhook broken** — `401` or `404` from Discord. A rate limit, a `5xx`, a timeout or an over-long message is a bad moment, not a dead webhook. A broken webhook is skipped from then on (the bot posts) until it is added again, which clears the flag (#241).
- **A webhook post must be as mention-safe as a bot post.** The Client sends with `allowedMentions: { parse: [] }` (#48); the webhook body carries `allowed_mentions: { parse: [] }`. Without it a plugin message containing `@everyone` would ping through the webhook and not through the bot.
- **Partial failure does not throw.** `announce` rejects only when **every** target failed. A plugin that sees a rejection typically retries on its next tick, and a retry re-posts to the channels that *did* succeed — once a minute, forever. One unreachable channel is logged; it must not turn a healthy channel into a spam target. With a single target (today's case) this is exactly today's behaviour: the failure propagates.
- **The URL never appears** in a log line, an error message, or `routing.json`. Reasons are fixed strings; a caught fetch error is dropped, not interpolated.
- **The gate fails open.** If routing cannot be read, or the channel's parent cannot be determined, the command runs. A routing fault must never take a plugin's commands down.
- **Core commands never reach the gate at all**, and only chat-input commands are gated (a button or modal belongs to a message that is already in an allowed channel).
- Routing is **read from disk per use** (`readRouting` — one small file). No cache, so no invalidation bug; commands and announcements are human- and tick-rate.
- Core's own release announcements (`announce(client, "release", …)`) are out of scope — this is about plugins.

### Step 1 — `src/routing/post.ts` (new)

```ts
export type WebhookPostResult = { ok: true } | { ok: false; gone: boolean; reason: string };

export interface PostDeps {
  readRouting: () => Promise<RoutingFile>;
  readSecrets: () => Promise<RoutingSecretsFile>;
  defaultChannelId: string;
  sendAsBot: (channelId: string, message: string) => Promise<void>;     // announceTo -- it prints the [announce] line itself
  executeWebhook: (url: string, message: string) => Promise<WebhookPostResult>;
  markBroken: (channelId: string, reason: string) => Promise<void>;
  log: Pick<Console, "log" | "warn" | "error">;
}
export async function postForPlugin(plugin: string, message: string, deps: PostDeps): Promise<void>
export function liveExecuteWebhook(fetchFn?: typeof fetch): PostDeps["executeWebhook"]
export function markWebhookBroken(dataDir: string, now: () => Date): PostDeps["markBroken"]
```

`postForPlugin`:
1. `targets = announceTargets(routing, plugin, deps.defaultChannelId)`.
2. `readSecrets()` **only if** some target has webhook metadata (`Object.hasOwn(routing.webhooks, target)`) that is not `broken`.
3. For each target, in order, each in its own `try`:
   - metadata present, not broken, and a URL stored (`Object.hasOwn`) → `executeWebhook`. `ok` → `log.log("[announce]", message)` (the same line the bot path prints) and this target is done. Not ok → `log.warn` naming the **channel id and the reason only**; when `gone`, `await markBroken(target, reason)` (a failure of that write is logged and swallowed); then fall through.
   - `sendAsBot(target, message)`.
4. Every target failed → rethrow the **first** error, unchanged. Some failed → `log.error("[announce] <plugin>: could not post to <channelId>", err)` for each, and resolve.

`liveExecuteWebhook`: `POST <url>` with `Content-Type: application/json`, body `{ content: message, allowed_mentions: { parse: [] } }`, `AbortSignal.timeout(10_000)`. `2xx` → ok. `401` / `404` → `{ ok:false, gone:true, reason:"Discord says that webhook is gone (<status>)" }`. Any other status → `gone:false`, `webhook post failed (<status>)`. A thrown fetch → `gone:false`, `could not reach Discord` — the error object is dropped.

`markWebhookBroken`: `mutateRouting(dataDir, …)` setting `webhooks[channelId].broken = reason` when that entry exists (and only then); it does **not** touch `updatedAt` / `updatedBy` — nobody edited anything.

### Step 2 — `src/routing/gate.ts` (new)

```ts
export interface Where { guildId: string | null; channelId: string; parentChannelId?: string }
/** The only function here that touches discord.js objects. */
export async function whereOf(
  interaction: Pick<ChatInputCommandInteraction, "guildId" | "channelId" | "channel">,
  fetchChannel: (id: string) => Promise<unknown>,
): Promise<Where>
/** "`/rsetlist` works in <#1> here." · "… in <#1> or <#2> here." · more than five: the first five, then "and N more". */
export function refusalMessage(commandName: string, channels: readonly string[]): string
/** The refusal to show, or undefined to let the command run. Never throws. */
export async function gateCommand(
  plugin: string | undefined, commandName: string, where: Where,
  readRouting: () => Promise<RoutingFile>, log: Pick<Console, "error">,
): Promise<string | undefined>
```
- `whereOf`: uses `interaction.channel`; when that is `null` (an uncached thread) it tries `fetchChannel(interaction.channelId)` once, guarded — a failure means "no parent known". A thread (`isThread()`) contributes its `parentId`.
- `gateCommand`: no plugin, or a DM (`guildId === null`) → allowed. `readRouting` throwing → logged, allowed. Otherwise `commandAllowed(…)`; a refusal becomes `refusalMessage`. `<#id>` is a channel mention: Discord shows the channel's name and makes it a link, which is what "names the right channels" means.

### Step 3 — wire it

- `src/commands.ts` — `handleCommand(interaction, lookup, gate?)`, `gate: (bare: string, interaction: ChatInputCommandInteraction) => Promise<string | undefined>` defaulting to allow. Resolve core first and **return through it without consulting the gate**; for a plugin command, a refusal is `interaction.reply({ content, flags: MessageFlags.Ephemeral })` and the handler is not called.
- `src/index.ts`:
  - `makeHost`'s `announce: (message) => postForPlugin(entry.name, message, postDeps)`, with `postDeps` built once in `activate()`: `readRouting` / `readSecrets` bound to `DATA_DIR`, `defaultChannelId: config.announceChannelId`, `sendAsBot: (channelId, message) => announceTo(client, channelId, message)`, `executeWebhook: liveExecuteWebhook()`, `markBroken: markWebhookBroken(DATA_DIR, () => new Date())`, `log: console`.
  - the interaction handler passes `(bare, interaction) => whereOf(interaction, (id) => client.channels.fetch(id)).then((where) => gateCommand(commandMap.get(bare)?.entry.name, interaction.commandName, where, () => readRouting(DATA_DIR), console))`.
  - Keep both edits small; `index.ts` was just changed by #239 and #241.

### Step 4 — tests

`src/routing/post.test.ts` —
`with no routing it posts once, as the bot, to the default channel` · `… and a failure there rejects with the bot path's own error, unchanged` · `a plugin with two postTo channels posts to both` · `a channel with a webhook is posted through it and the bot is not used for it` · `two channels, one with a webhook: one webhook post and one bot post` (the acceptance bullet, literally) · `the default channel uses its webhook too` · `a webhook with no stored url posts as the bot` · `a broken webhook is skipped and the bot posts` · `a 404 falls back to the bot and marks the webhook broken` · `a 401 does the same` · `a 429, a 500 and a timeout fall back to the bot and do NOT mark it broken` · `a failing markBroken is logged and the post still arrives` · `secrets are not read when no target has a usable webhook` · `one channel failing does not stop the others, and does not reject` · `every channel failing rejects` · `the webhook success prints the same [announce] line`.
`liveExecuteWebhook`: `sends content with allowed_mentions parse []` · `maps 204 to ok, 404/401 to gone, 429/500 to not gone` · `a thrown fetch is "could not reach Discord" and its text is dropped`.
`markWebhookBroken`: `sets broken on an existing entry, leaves updatedAt and updatedBy alone` · `does nothing for a channel with no entry` (temp dir).
`the url appears in no log line and no error` — a distinctive token, a capturing `log`, all the failure paths above; the token is found nowhere.

`src/routing/gate.test.ts` —
`refusalMessage: one channel, two channels, more than five` · `a plugin with no entry for the server is allowed` · `a command in a listed channel is allowed` · `a command in an unlisted channel is refused, naming the channels` · `a thread under a listed channel is allowed` · `a DM is allowed` · `no plugin (a core command) is allowed` · `a routing read that throws is logged and allowed` · `whereOf reads the parent of a thread` · `whereOf fetches a channel that is not cached, once` · `whereOf survives the fetch failing`.

`src/commands.test.ts` (add) — `a core command never consults the gate` · `a refused plugin command gets a private reply and its handler is not called` · `an allowed plugin command runs` · `with no gate argument a plugin command runs` (today's callers).

`src/index.test.ts` (add, source pins in the file's own idiom) — `a plugin's announce goes through postForPlugin with its own name and the default channel` · `the interaction handler passes a gate built from whereOf and gateCommand` · `announceTo is still the bot's send path` (it appears inside `postDeps`, and `config.announceChannelId` is its default).

### Step 5 — docs

`CONTEXT.md`: file-map rows for `post.ts` and `gate.ts`; **Behavior** — where a plugin posts and how the gate decides; gotchas — *`announce` rejects only when every target failed (a partial rejection would make a retrying plugin spam the healthy channels)*; *only 401/404 marks a webhook broken, and the flag lives in `routing.json`, not `discovery.json`*; *a webhook post carries `allowed_mentions: {parse: []}` to match the Client default*. `README.md`: `ANNOUNCE_CHANNEL_ID` is now the **default** channel. Verify each sentence against the merged code.

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| no routing → one post to the default channel, as today | 1, 3 | `with no routing it posts once, as the bot…`; the `index.test.ts` pins | ignore `defaultChannelId`; always read secrets and try a webhook |
| two `postTo`, one with a webhook → one webhook post, one bot post | 1 | `two channels, one with a webhook…` | post through the bot for every target; stop after the first target |
| a 404 → still arrives via the bot, webhook marked broken | 1 | `a 404 falls back to the bot and marks the webhook broken` | return after the webhook failure; never call `markBroken` |
| only "gone" marks it broken | 1 | `a 429, a 500 and a timeout … do NOT mark it broken` | treat every failure as gone |
| a webhook post cannot ping | 1 | `sends content with allowed_mentions parse []` | drop `allowed_mentions` |
| the URL is never logged | 1 | `the url appears in no log line and no error` | put the url in the warn; interpolate the fetch error |
| partial failure does not reject | 1 | `one channel failing does not stop the others, and does not reject` | rethrow on the first failure |
| listed channel runs; unlisted refused privately, naming channels; thread runs; core never refused | 2, 3 | the `gate.test.ts` cases; `a refused plugin command gets a private reply…`; `a core command never consults the gate` | drop the parent check; gate core commands; reply publicly; call the handler after refusing |
| the gate fails open | 2 | `a routing read that throws is logged and allowed` | let it throw |
| `contract.ts` untouched | — | `contract.test.ts`, unedited | — |
| it really posts through a webhook, and really refuses, on Discord | — | manual — the deploy child (#247) | — |

### Verification — paste the real output in the PR

```
bun run check
bun test
git diff --stat origin/main -- src/plugins/contract.ts     # must print nothing
git grep -n "webhooks/" -- src ':!*.test.ts'                # nothing new from this PR
```

Mutation checks in a scratch worktree, one at a time, `bun test src/routing src/commands.test.ts src/index.test.ts`.

**Run every `bun test` — yours, your reviewers', your mutation runs — with a private temp dir**, e.g. `TEMP=R:/repos/Scratch/tmp/bot-243 TMP=R:/repos/Scratch/tmp/bot-243 bun test` (create it first). `test/setup.ts` sweeps every `rackbops-bot-test-data-*` directory in the system temp dir at start-up (#252), so two suites running at once on this machine delete each other's data dir mid-run.

