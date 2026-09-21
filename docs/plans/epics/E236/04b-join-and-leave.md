## Implementation plan — written by the orchestrating session, to be executed as written

One PR, branch `claude/routing-join-leave` cut from `origin/main` (which now carries #239, #241 and #243), in an isolated worktree. Commit this plan as `docs/plans/epics/E236/04b-join-and-leave.md`. Small: two functions in `src/routing/live.ts`, two listeners in `src/index.ts`, tests, docs.

### One correction to the issue text

The issue says Discord "replays `guildCreate` for every server at start-up". discord.js does not surface it that way: its `GUILD_CREATE` handler emits `guildCreate` only for a guild that is **new to the cache while the client is already Ready**; a server that was listed unavailable in `READY` and then arrives emits `guildAvailable`, as does one coming back from an outage; and `guildDelete` is emitted only when the bot is really out (an outage is `guildUnavailable`). So there is nothing to filter — but the listeners still must be harmless if they fire early, and that is what the rules below give. The orchestrator read this in the installed discord.js 14.27.0 -- `src/client/websocket/handlers/GUILD_CREATE.js` (emits `guildCreate` only in the `else` branch, under `client.ws.status === Status.Ready`) and `src/client/actions/GuildDelete.js` (returns after `guildUnavailable` when `data.unavailable`) -- **read both yourself and quote the deciding lines in the PR**, since a discord.js bump could change them.

### Decided — not open for re-planning

- **A join re-runs the whole registration** (`applyRouting("joined <name>")`), not a one-server special case: it is the one path that is already planned, serialized, recorded in `discovery.json` and tested, and a bot joins a server a few times in its life.
- **In `single` mode a join registers nothing** — the one guild-or-global call already covers it, exactly as today — and only `discovery.json` is refreshed. The mode is decided by reading `routing.json` at that moment (`hasPlacements`), *outside* the serialized chain: `applyRouting` and `refreshDiscovery` each queue themselves, so calling either from inside a queued job would wait on itself forever.
- **A leave never touches `routing.json`.** Being kicked and re-invited must not lose a placement. It refreshes `discovery.json` only.
- **Before `initRouting`, both do nothing.** The boot registration that follows snapshots the cache, which already holds the new server. During the boot registration, a join queues behind it on the existing chain.
- **Neither may throw or reject into the event emitter.** An unhandled rejection in a listener is a process-level event.
- The listeners are attached in `activate()` next to the `InteractionCreate` one (before the boot registration, so no join is missed in that window). `CORE_INTENTS` already has `Guilds`, which delivers both events; no intent changes.
- **Do not edit the `src/index.ts` row of `CONTEXT.md`'s File Map** (the orchestrator updates it once, for #241, #243 and this child together). Put the facts in the `live.ts` row, Behavior and the gotcha.

### Step 1 — `src/routing/live.ts`

```ts
/** The bot has joined a server. Routed: register again (it is the only thing that gives the new server its
 *  commands) -- which also rewrites discovery.json. Single: nothing to register; refresh discovery only. */
export function guildJoined(guild: { id: string; name: string }): Promise<void>
/** The bot has left a server (kicked, or the server is gone). routing.json is not touched. */
export function guildLeft(guild: { id: string; name: string }): Promise<void>
```
- Both: `context === undefined` → resolve, do nothing. Both: never reject — a failure is logged (`[routing] …`) and swallowed.
- `guildJoined`: log `[routing] joined <name> (<id>)`; `hasPlacements(await readRouting(dataDir))` → `applyRouting(\`joined ${name}\`)`, else `refreshDiscovery()`. (`applyRouting` cannot throw in routed mode; catch anyway — between the read and the call the last placement may have been removed, which makes it a `single` run that can.)
- `guildLeft`: log `[routing] left <name> (<id>)`; `refreshDiscovery()`.
- A server's name is whatever Discord calls it; everything this code writes around it is ASCII.

### Step 2 — `src/index.ts`

Next to `client.on(Events.InteractionCreate, …)` in `activate()`:
```ts
client.on(Events.GuildCreate, (guild) => void guildJoined(guild));
client.on(Events.GuildDelete, (guild) => void guildLeft(guild));
```
with a comment saying why they are attached before the boot registration, and that a guild that becomes *available* or *unavailable* is a different pair of events on purpose.

### Step 3 — tests

`src/routing/live.test.ts` (add, on the file's existing fakes) —
`a join in routed mode registers again, the new server included, and discovery lists it with its outcome` · `a join in single mode makes no registration call and refreshes discovery` · `a join before initRouting does nothing` · `a join while the boot registration is running queues behind it` (its first `put` comes after the boot's discovery write) · `two joins are applied one after the other` · `a join whose registration fails is logged, not thrown` (remove the last placement between the read and the call, make the single-mode `put` reject) · `a leave refreshes discovery and leaves routing.json byte-identical` (read the file's bytes before and after) · `a leave before initRouting does nothing` · `a leave whose refresh fails is logged, not thrown`.

`src/index.test.ts` (add, its own `describe`, source pins in the file's idiom) — `joining and leaving a server are wired to guildJoined / guildLeft, inside activate(), before the boot registration` · `neither listener can reject into the emitter` (each call is `void …`, and the functions are the never-rejecting ones) · `availability events are not wired` (`Events.GuildAvailable` / `GuildUnavailable` do not appear).

### Step 4 — docs

`CONTEXT.md`: the `src/routing/live.ts` File-Map row; **Behavior** (registration now also runs on a join, in routed mode); and the routed-mode gotcha's last sentence — *"Nothing re-registers when the bot joins a server after boot … until the next boot"* is false twice over now (a `routing-set` has re-registered every server since #241, and a join does from this child): replace it with what is true. `README.md` only if it says anything about joining. Verify each sentence against the merged code.

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| a join in routed mode → one `applyRouting`, discovery lists the server with its outcome | 1 | `a join in routed mode registers again…` | call `refreshDiscovery` instead; build discovery before registering |
| a join in single mode → no registration, discovery refreshed | 1 | `a join in single mode makes no registration call…` | always call `applyRouting` |
| start-up never triggers a registration from these listeners | 1, 2 | `a join before initRouting does nothing`; `availability events are not wired` | drop the `context === undefined` return; wire `GuildAvailable` |
| a leave → discovery refreshed, `routing.json` byte-identical | 1 | `a leave refreshes discovery and leaves routing.json byte-identical` | remove the server's entries in `guildLeft` |
| two joins never interleave | 1 | `two joins are applied one after the other`; `a join while the boot registration is running queues behind it` | call the registration body directly instead of `applyRouting` |
| a listener can never reject | 1, 2 | `a join whose registration fails is logged, not thrown`; `a leave whose refresh fails…`; `neither listener can reject into the emitter` | drop the catch; `await` inside the listener without one |
| the listeners are really attached | 2 | `joining and leaving a server are wired…` | delete either `client.on` |
| on `debug`: a scratch server shows up within ten seconds with `/rreport` | — | manual — the deploy child (#247), or named unverified | — |

### Verification — paste the real output in the PR

```
bun run check
bun test
```
and what you read in discord.js's two handlers (the correction above). Mutation checks in a detached scratch worktree, one at a time, `bun test src/routing/live.test.ts src/index.test.ts`.

**Run every `bun test` with a private temp dir**, e.g. `TEMP=R:/repos/Scratch/tmp/bot-259 TMP=R:/repos/Scratch/tmp/bot-259 bun test` (create it first) — `test/setup.ts` sweeps every `rackbops-bot-test-data-*` directory in the system temp dir at start-up (#252), and another subordinate is testing in this repo at the same time.

