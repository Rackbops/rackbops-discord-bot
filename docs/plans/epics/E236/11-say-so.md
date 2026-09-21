## Implementation plan — written by the orchestrating session, to be executed as written

One small PR, branch `claude/routing-say-so` cut from `origin/main`, in an isolated worktree. Commit this plan as `docs/plans/epics/E236/11-say-so.md`. Log output only: nothing here changes what the bot registers, posts or refuses.

### Decided — not open for re-planning

- **`repairRouting` stays pure and silent.** What it dropped is worked out beside it, by a second pure function, and logged at the I/O edge (`readRouting`).
- **A dropped thing is NAMED, never quoted.** The report carries keys (a plugin name, a server id, a channel id) passed through `shown()` (which clips at 40 characters — a webhook token starts past that in any URL), and never a value. A webhook entry that carried a stray `url` or `token` key is *not* a dropped entry (the repair keeps the entry and drops the key, by design) and is not reported.
- **Once per distinct message per process.** `readRouting` has been on the path of every command and every announcement since #243; a damaged file must not write a line per command. A module-level `Set` of messages already said, with a reset seam for tests.
- `results` entries that fail repair are **not** reported — they are the bot's own bookkeeping, not configuration.
- The home-server warning is said by `applyRouting`, in routed mode only, and also once per distinct message.

### Step 1 — `src/routing/model.ts`

```ts
/** What `repairRouting` would drop from `raw`, as short messages naming each dropped thing. Pure; never throws. */
export function droppedByRepair(raw: unknown): string[]
```
Messages, exactly: `plugin <name> is not a valid plugin name` · `plugin <name> is not an object with a servers object` · `plugin <name>: server <id> is not a server id` · `plugin <name>: server <id> has no valid commands ("all" or a list of channel ids)` · `plugin <name>: server <id>: postTo <value> is not a channel id` (the server entry is kept, as the repair keeps it) · `webhook for <channel> is not a channel id` · `webhook for <channel> is missing its ids`. Every `<…>` goes through `shown()`. A `raw` that is not an object reports nothing (a missing file is the normal case). Pin, by test, that for every fixture `droppedByRepair` says something **iff** `repairRouting` dropped something of those kinds — the two must not drift.

### Step 2 — `src/routing/store.ts`

`readRouting`: after reading, `for (const message of droppedByRepair(raw))` → if not already said → `console.warn(\`[routing] routing.json: ${message}; it is ignored\`)`. Export `resetRoutingWarningsForTest()`.

### Step 3 — `src/routing/live.ts`

In `applyRouting`, when the plan is `routed`, `homeGuildId` is set, the server list was read (`snapshots !== null`) and the home server is not in it: the unplaced loaded plugins (`!isPlaced(routing, name)`) live nowhere. If there are any, once per distinct message: `[routing] the home server <id> is not one the bot is in, so these plugins, which nobody has placed, are registered nowhere: <a>, <b>`. Reset with `resetRoutingForTest()`.

### Step 4 — tests

`src/routing/model.test.ts` — one test per message above · `a file with nothing wrong reports nothing` · `a webhook entry with a stray url key reports nothing, and the message list never contains the url` · `droppedByRepair and repairRouting agree on every fixture` (table-driven: the same fixtures through both) · `a hostile key is clipped`.
`src/routing/store.test.ts` — `a malformed server entry is warned about once, naming the plugin and the server, and a second read says nothing more` · `a different problem is warned about separately` · `a good file warns about nothing`.
`src/routing/live.test.ts` — `routed mode with a home server the bot is not in warns once, naming the unplaced plugins` · `no warning when every loaded plugin is placed` · `no warning in single mode` · `no warning when the server list could not be read`.

### Step 5 — docs

`CONTEXT.md`: one sentence in the `model.ts` / `store.ts` rows and one gotcha — *a hand-seeded `routing.json` that is partly malformed is repaired silently in memory but says what it ignored, once, in the log (`[routing] routing.json: …`); #247 seeds this file by hand*. Do not edit the `src/index.ts` row.

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| good entry kept, malformed dropped, exactly one warning naming plugin + server, a second read silent | 1, 2 | `a malformed server entry is warned about once…` | drop the already-said check; never call `droppedByRepair` |
| routed mode, home server the bot is not in → one warning naming it and the unplaced plugins | 3 | `routed mode with a home server the bot is not in warns once…`; `no warning in single mode` | warn in single mode too; list placed plugins |
| neither warning ever contains a webhook URL | 1 | `a webhook entry with a stray url key reports nothing…`; `a hostile key is clipped` | report dropped KEYS of a webhook entry with their values; skip `shown()` |
| the report cannot drift from the repair | 1 | `droppedByRepair and repairRouting agree on every fixture` | make `repairRouting` drop something `droppedByRepair` does not know (e.g. tighten the snowflake length in one only) |

### Verification — paste the real output in the PR

```
bun run check
bun test
```
Mutation checks in a detached scratch worktree, one at a time, `bun test src/routing`. **Every `bun test` with a private temp dir**: `TEMP=R:/repos/Scratch/tmp/bot-260 TMP=R:/repos/Scratch/tmp/bot-260 bun test` (create it first; #252).

