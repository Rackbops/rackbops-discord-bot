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

---

## Implementation notes (added by the implementer; everything above is the plan as posted)

Where the build differs from the plan, and why. Every behaviour change below is tested; the last two notes are documentation.

- **A join of the home server in single mode registers again.** The plan says a join in single mode registers nothing because "the one guild-or-global call already covers it". That holds for every server *except the one single mode registers to*: with `DISCORD_SERVER_ID` set the one call is a guild-scoped PUT to the home server, so a bot that was not in the home server at boot (that registration was refused) and is invited later, or that was removed from it and is added back, has nothing registered there until it is done again (Discord is understood to drop a server's commands when the bot leaves it; not verified against a live server). `guildJoined` therefore runs `applyRouting` for a join of the home server whatever the mode (in single mode that is exactly the one call it always made). Any other server in single mode is untouched when a home server is set (it gets no commands, as before), and a bot with no home server needs nothing (its one call is global, so the global list already reaches a new server). The acceptance bullet "a join in single mode -> no registration call" holds for every server that is not the home server. Not covered, and said so in the `CONTEXT.md` gotcha: re-authorizing a bot that is still a member (the usual cure for a 50001) emits no join event at all, and waits for the next registration (found in round 2, reproduced by both reviewers against discord.js's real handlers). Found in round 1, reproduced by reviewers A and B.
- **`guildJoined` / `guildLeft` swallow a logger that throws, and a malformed guild.** The plan's "never rejects" held only while `c.log.error` did not throw and the guild had a `name`: everything they write now goes through `tell`, which swallows a broken logger (and reads it outside its `try`, so a missing context is still seen, which keeps the plan's "before `initRouting` it does nothing" guard observable) and never lets the join's own line hold the work up, and `label` is total.
- **The plan's test for a failing join is deterministic, not timed.** The plan removes the last placement "between the read and the call"; that needs a `sleep` to line up the join's read with a held registration, which is timing-dependent by construction (its failure direction was not seen, but its sibling was: reviewer B measured 31 failures in 120 runs, with 30 concurrent test processes, of the `sleep(30)` in "a join while the boot registration is running queues behind it", which now waits on a latch instead). The failure paths are covered by a join of the home server in single mode whose put fails (single mode rethrows), and by a logger that throws while a routed run reports (which rejects `applyRouting`). The one remaining wait is a negative one, after a latch on the boot registration's first put. Every join and leave in those tests runs under a deadline, because the deadlock the mode-outside-the-chain rule prevents would otherwise hang the suite instead of failing it (reviewer A: `bun test` neither times out nor exits on a promise that never settles when nothing else is pending).
- **Documented gaps, accepted** (see the `CONTEXT.md` gotcha): a server invited while the gateway session is re-identified rather than resumed arrives as `guildAvailable`, not `guildCreate`; a kick while disconnected emits no `guildDelete`; and a server invited during an outage arrives first as a stub. Wiring `guildAvailable` was not built (it fires for every server coming back from an outage, which is not a join, and the orchestrator decided against it); a version filtered to servers not seen before would close the first and third gaps.
- **Docs beyond the plan's list:** the Discovery glossary entry; two "until the next boot" comments in `src/routing/register.ts` (false since #241, and a join is one more trigger); and the issue's claim that the panel "already shows" a server that is in routing but not in discovery (#246) is not repeated: #246 is still open and its issue text does not list that case, so `CONTEXT.md` says the panel has to be able to show it and that #246 does not yet say so.
