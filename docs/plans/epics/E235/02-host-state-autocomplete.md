<!-- Plan for Rackbops/rackbops-discord-bot#225 + #218 (Epic #235). Copy of the approved plan comment,
https://github.com/Rackbops/rackbops-discord-bot/issues/225#issuecomment-5768767541, as of when it was
approved, with the implementer's "Deviations from the plan" appended at the end. -->

## Implementation plan — written by the orchestrating session, to be executed as written

Covers **#225 + #218** as one PR (Epic #235's declared `src/plugins/host.ts` bundle). Written 2026-09-21 against `origin/main` @ `e1194e4`, every cite read from source that day; line numbers are as of that sha, cite by construct when you search. **Cut the branch from `origin/main` only after the #224 + #223 PR has merged** — both edit the same `CONTEXT.md` gotcha paragraph (the #222 one at ~L896-913), and a same-row conflict there is on the always-escalate list. Neither issue has an `## Acceptance` section, so this plan defines the observable outcome each demands; execute those and paste the real output.

**Files:** `src/plugins/host.ts`, `src/plugins/updates.ts`, `src/plugins/requests.ts`, `src/commands.ts`, `src/index.ts`, their tests (`src/plugins/host.test.ts`, `src/plugins/updates.test.ts`, `src/plugins/requests.test.ts`, `src/commands.test.ts`, `src/index.test.ts`), `CONTEXT.md`, `ops/README.md` only if a sentence there lies afterwards. **Never `src/plugins/contract.ts`** (vendored verbatim by `rackbops-bot-plugins` behind a CI drift check; a separate paired PR is editing its comments). **Nothing under `ops/`** — that is another lane.

### Decided — not open for re-planning

**#225 — an off plugin keeps its state entry.**

1. `buildPluginStateFile` (`host.ts:370`) today writes one entry per *selected* plugin (`opts.selected.map`, `:386`), so a plugin taken out of `PLUGINS=` loses its record on the next boot. It now **carries forward** every previous entry whose name is not selected this boot, as `enabled: false, active: false`, appended **after** the selected entries, in the previous file's order, de-duplicated by name (first wins — `previousByName` already exists at `:384`).
2. **Carried:** `installedVersion` (the pin — the whole point), `notifiedVersion`, `skippedVersion`, `remindAt`, `scheduled`, and `configured` / `missingEnv` exactly as the last boot it ran left them. **Dropped:** `targetVersion` (a one-boot transient; the update did not run because the plugin was off), `availableVersion` (recomputed each boot from the index, only for selected plugins), `error` (a this-boot outcome). An entry that was *already* `enabled: false` is carried again the same way — entries never expire.
3. **Nothing acts on an off entry.** `decidePluginUpdates` (`updates.ts:100`) skips it: no notification, no reminder. `runDueSchedules` (`updates.ts:584`) skips it: the schedule is **kept, paused**. `validate` (`requests.ts:413`) refuses `update-now` and `schedule` for it with `<name> is off — turn it on first`; `remind`, `skip` and `cancel` still apply (bookkeeping only). `/plugins update` (`commands.ts:216-259`) refuses the same way, `now` and `at:` alike; `/plugins remind|skip|cancel` still work.
4. **A paused schedule resumes.** When the plugin is turned back on, an overdue schedule fires at the first update tick after that boot, and the bot restarts into the update. That is two restarts close together, and it is what the operator asked for; `/plugins list` and the panel show the pending schedule throughout. Documented, not hidden.
5. `decidePluginReportOutcome` (`updates.ts:425`) gains a first branch: an entry with `enabled: false` → `{ ok: false, message: "⚠️ **<name>** is turned off, so the update to <to> did not run." }`. (The case: `update-now`, then turned off in the same restart.)
6. `/plugins list` (`renderPluginsList`, `updates.ts:169`) shows an off entry as `• **<name>** — off (installed <v>)` plus its pending-schedule line if any, and nothing else — no "available" line, no notes.
7. The panel is **not** edited here. Until #244 lands, a carried-off plugin shows its installed version in the panel and may be offered *Update now*; the bot refuses that request with the reason above, which the panel surfaces. The orchestrator folds "update actions only when `p.enabled`" into #244's plan.

**#218 — the minimum, plus an honest answer; no contract change.**

8. `buildCommandBody` (`host.ts:142`) registers a command whose built JSON asks for autocomplete **unchanged** (an autocomplete option still accepts typed text) and **warns once per command**, naming every option path that asks for it. Dropping the command would remove a working command over a dead picker; silence is what the issue is about.
9. `index.ts`'s `InteractionCreate` handler (`:186-213`) answers **every** autocomplete interaction with an empty choice list (`interaction.respond([])`), so the picker shows "no options" at once instead of "Loading options failed" after three seconds. Core has no autocomplete option (verified: no `setAutocomplete` / `isAutocomplete` anywhere in `src/`), so there is nothing to route past this.
10. The routing seam the issue calls "full" — an optional `autocomplete?(interaction)` on `PluginCommand` — is a `contract.ts` change and is **out of scope**. File it as its own issue (`enhancement`, `priority: medium`, `effort: S`; body: prerequisite = Epic #236 closed, lands with the post-#236 contract batch #219 / #248 / #220, paired with a `rackbops-bot-plugins` re-vendor; cite this PR), then cite its number in the warn text and the CONTEXT.md sentence.

### Step 1 — `host.ts`: carry forward off entries

In `buildPluginStateFile`, after the `selected.map` builds `plugins`, compute `const selectedNames = new Set(opts.selected.map((sp) => sp.name))` and append, for each previous entry not in it (dedupe by name, first wins), an entry built **only** from the fields in decision 2, with `enabled: false` and `active: false`; copy an optional field only when it is defined (the file's existing `if (prev?.x !== undefined) entry.x = prev.x` idiom). Rewrite the function's doc comment (`:364-368`) to say what is carried and what is dropped, and why (#225: the pin survives a disable, so re-enabling never falls through to `newestCachedVersion`).

### Step 2 — `updates.ts`: nothing acts on an off entry

- `decidePluginUpdates`: `if (!p.enabled) continue;` as the first line of the loop body, with a one-line comment.
- `runDueSchedules`: the same guard as the first line of its loop body.
- `renderPluginsList`: the off line per decision 6.
- `decidePluginReportOutcome`: the branch per decision 5, first.

### Step 3 — `requests.ts`: refuse an update for an off plugin

In `validate`, after the shape checks (`version`, `at`, `days`) and **before** the "already on" check (`:458`): `if ((action === "update-now" || action === "schedule") && !stateEntry.enabled) return { ok: false, reason: \`${plugin} is off — turn it on first\` };`. Order matters for the reason an operator sees: a malformed version is still "bad version"; an off plugin is "off" before it is "already on".

### Step 4 — `updates.ts` + `commands.ts`: the same refusal on `/plugins update`, decided in the pure function

The `/plugins` handler does real I/O and `commands.test.ts` pins it by source scan only, so the decision goes where the repo keeps decisions: `PluginActionContext` (`updates.ts:253`) gains `/** Listed in PLUGINS= this boot (#225): an off plugin is never updated. */ enabled: boolean;`, and `planPluginAction` (`:364`), after the `cancel` branch and before `hasNewer`, returns `{ reply: "⚠️ **<name>** is turned off (not in \`PLUGINS=\`) — turn it on first, then update." }` (no `mutate`, no `restart`) when `action.kind === "update"` and `!ctx.enabled`. `remind`, `skip` and `cancel` are unaffected. `commands.ts:248-259` passes `enabled: stateEntry.enabled`. The existing `planPluginAction` tests gain `enabled: true` in their context literal and nothing else.

### Step 5 — `host.ts`: name the autocomplete options

Export `autocompleteOptionPaths(json: RESTPostAPIChatInputApplicationCommandsJSONBody): string[]` — walks `options` recursively (a subcommand group and a subcommand carry their own `options`), returns each option with `autocomplete === true` as its path, names joined by a space (`"group sub q"`); `[]` when there are no options. Total: a malformed `options` (not an array) yields `[]`. In `buildCommandBody`, after the name check and before `body.push(built)`: if the list is non-empty, `log.warn(\`[plugins] ${entry.name}: command "${bare}" asks for autocomplete on ${paths.map((p) => \`"${p}"\`).join(", ")} — the host does not route autocomplete to plugins (#<follow-up>), so the picker offers no suggestions; a typed value still works\`)`. The command is pushed regardless.

### Step 6 — `index.ts`: answer every autocomplete interaction

In the `InteractionCreate` handler, a final `else if (interaction.isAutocomplete())` branch: a two-line comment (#218: the host routes no autocomplete to plugins; an empty answer closes the picker cleanly, an unanswered one fails after 3 s; core has none) and `await interaction.respond([]);`. Inside the existing `try`, so a failed respond logs `[interaction]` like everything else.

### Step 7 — docs

- `CONTEXT.md` ~L904-906 (the #222 gotcha): the sentence "`state.json` only records the plugins listed in `PLUGINS`, so one left out for a boot loses its record: pin `PLUGINS=name@version` to recover" is **false after this PR** — rewrite it: an off plugin keeps its entry (#225), so the no-record case is a fresh install or a deleted `state.json` only. Verify the rest of that paragraph still holds after #224's own edit to it.
- `CONTEXT.md` Plugin State glossary entry (~L75-79): add that a plugin taken out of `PLUGINS` keeps its entry as `enabled: false`.
- A new gotcha beside the plugin ones: **Off plugins stay in `state.json` (#225)** — decisions 1-6 in prose: what is carried and dropped, that nothing notifies, schedules or updates an off plugin, that a paused schedule fires at the first tick after the plugin is turned back on, and the panel note from decision 7 until #244.
- A new gotcha: **A plugin option that asks for autocomplete (#218)** — registered and warned about at build time; the host answers with no suggestions; the seam is #<follow-up>.
- `ops/README.md`: read ~L55-95 (the panel's plugin actions) and ~L600-640; fix any sentence that now lies. Expect none.

### Tests

`src/plugins/host.test.ts`, `describe("buildPluginStateFile")`:

| # | Test name | Pins |
|---|---|---|
| 1 | `a plugin taken out of PLUGINS keeps its entry as enabled: false, with its pin and its bookkeeping` | previous `p` with `installedVersion`, `notifiedVersion`, `skippedVersion`, `remindAt`, `scheduled`, `configured: false`, `missingEnv: ["P_REQ"]`; `selected: []` → one entry, `enabled: false`, `active: false`, every listed field equal |
| 2 | `an off entry drops what only a boot can know: targetVersion, availableVersion and error` | previous `p` with all three → all three absent |
| 3 | `off entries follow the selected ones in the previous file's order, and a plugin in both is written once, as selected` | previous `[a, b, c]`, selected `[b]` → names `[b, a, c]`, `b.enabled === true`, exactly three entries |
| 4 | `an entry that was already off is carried again unchanged` | previous `p` with `enabled: false` and a pin → identical entry |
| 5 | `a duplicated name in a corrupt previous file is carried once` | previous `[p@1.0.0, p@2.0.0]`, selected `[]` → one `p`, `installedVersion: "1.0.0"` |

`src/plugins/host.test.ts`, `describe("the state.json pins that selectPlugins reads back (#222)")` — the round-trip through real files that IS #225's scenario:

| # | Test name | Pins |
|---|---|---|
| 6 | `a plugin turned off for a boot and on again comes back on its pinned version, not the newest cached one (#225)` | seed `data/plugins/p/1.1.0/dist/plugin.js` and `.../1.2.0/dist/plugin.js`; write state with `p` on `1.1.0` (selected); boot 2: `writePluginState` with `selected: []`; boot 3: read the state, build `pins` exactly as `index.ts:137-139` does, `installPlugins([{ name: "p", entry }], dir, pins, deps)` with a fetch that throws → installed version is `1.1.0`, fetch never called. Then the same with boot 2's state written by the OLD rule (no entry) → `1.2.0` — asserted with a hand-written previous file, not by mutating the code, so the test documents the trap |

`src/plugins/updates.test.ts`:

| # | Test name | Pins |
|---|---|---|
| 7 | `decidePluginUpdates: an off plugin is never notified or reminded` | `enabled: false`, installed `1.0.0`, index `1.1.0`, `remindAt` in the past → `[]` |
| 8 | `renderPluginsList: an off plugin shows off and its installed version, a pending schedule, and nothing else` | line matches `/^• \*\*p\*\* — off \(installed 1\.0\.0\)$/` for the first line; a `scheduled` entry adds the ⏳ line; no "available", no notes |
| 9 | `checkPluginUpdates: a due schedule on an off plugin does not fire and is kept` | (in `describe("checkPluginUpdates")`, its deps harness) `requestRestart` never called, `mutateState` never called for it, `scheduled` still present |
| 10 | `decidePluginReportOutcome: an off plugin reports that the update did not run` | `{ ok: false, message: "⚠️ **p** is turned off, so the update to 1.1.0 did not run." }` |

`src/plugins/requests.test.ts`, `describe("validate (#105 trust boundary)")`:

| # | Test name | Pins |
|---|---|---|
| 11 | `update-now and schedule are refused for an off plugin; remind, skip and cancel still apply` | five assertions; the reason is `p is off — turn it on first` |
| 12 | `an off plugin's bad version is still "bad version"` | the off check sits after the shape checks |

`src/plugins/updates.test.ts`, `describe("planPluginAction (#104)")`, plus one source pin in `src/commands.test.ts`, `describe("handleCommand — /plugins")` (that file's idiom for this handler):

| # | Test name | Pins |
|---|---|---|
| 13 | `update on an off plugin is refused with no mutation and no restart, now and at a time alike` | `enabled: false`, a newer version available → `reply` names the plugin and says turn it on; `mutate` and `restart` both `undefined`; both `{ kind: "update" }` and `{ kind: "update", at }` |
| 14 | `remind, skip and cancel still apply to an off plugin` | each returns its `mutate` as today |
| 14b | `/plugins passes the state entry's enabled flag into planPluginAction (source guard)` | the `planPluginAction(action, {` literal in `commands.ts` contains `enabled: stateEntry.enabled,` |

`src/plugins/host.test.ts`, `describe("buildCommandBody")`:

| # | Test name | Pins |
|---|---|---|
| 15 | `a command with an autocomplete option is registered, and the warning names the option` | a real `SlashCommandBuilder` with `.addStringOption((o) => o.setName("q").setDescription("d").setAutocomplete(true))` → the command is in the body; one warn containing `"q"` and `autocomplete` |
| 16 | `an autocomplete option inside a subcommand group is named by its path` | group `g` → sub `s` → option `q` → warn contains `"g s q"` |
| 17 | `a command without autocomplete options warns nothing` | |
| 18 | `autocompleteOptionPaths: no options is [], a non-array options is [], nesting is walked` | direct unit test |

`src/index.test.ts`, the source-pinning idiom the file already uses for the handler (`describe("plugin announcements and the channel gate are routed (#243)")` shows the shape):

| # | Test name | Pins |
|---|---|---|
| 19 | `an autocomplete interaction is answered with an empty list inside the InteractionCreate handler (#218)` | the slice between `client.on(Events.InteractionCreate` and `client.on(Events.GuildCreate` matches `/else if \(interaction\.isAutocomplete\(\)\)\s*\{[\s\S]*?await interaction\.respond\(\[\]\);/`, and `respond([])` appears exactly once in the file |

### Coverage table

| Outcome demanded | Step | Test | Mutation that must fail it |
|---|---|---|---|
| #225: a disabled plugin keeps its pin and bookkeeping | 1 | 1, 4 | drop the carry-forward |
| #225: re-enabling comes back on the pin, never `newestCachedVersion` | 1 | 6 | drop the carry-forward (6 resolves `1.2.0`) |
| #225: only bookkeeping is carried | 1 | 2 | copy `targetVersion` / `error` / `availableVersion` |
| #225: order and de-duplication | 1 | 3, 5 | prepend instead of append; skip the de-dupe |
| #225: an off plugin is never notified | 2 | 7 | remove the `decidePluginUpdates` guard |
| #225: an off plugin's schedule is paused, not fired | 2 | 9 | remove the `runDueSchedules` guard |
| #225: the boot report is honest | 2 | 10 | remove the report branch |
| #225: `/plugins list` says off | 2 | 8 | remove the off line |
| #225: the mailbox refuses an update for an off plugin | 3 | 11, 12 | remove the `validate` check; move it before the shape checks |
| #225: `/plugins update` refuses too, and the rest still work | 4 | 13, 14, 14b | remove the branch; widen it to every action kind; pass `enabled: true` from `commands.ts` |
| #218: the command is kept and the warning names the option | 5 | 15, 17 | drop the warn; drop the command; warn unconditionally |
| #218: nested options are found | 5 | 16, 18 | walk only the top level |
| #218: the picker gets an answer | 6 | 19 | delete the branch |
| docs | 7 | — single read of the merged text against the code | — |

### Acceptance — execute these, paste the real output

1. `bun test src/plugins/host.test.ts src/plugins/updates.test.ts src/plugins/requests.test.ts src/commands.test.ts src/index.test.ts` — green, every test above present by name. (Never the repo-wide `bun test` on this box.)
2. `bun run check` — exit 0.
3. **#225's observable outcome** is test 6, through real files: paste its passing output, and paste the `1.2.0` result of its old-rule half, so the PR shows the trap and the fix side by side.
4. **#218's observable outcome:** paste the captured warn line from test 15 verbatim, and the `index.ts` hunk.
5. The mutation table: every row above, run one mutant at a time in a detached scratch worktree, each with the failing test names.

### PR

One PR, branch `claude/plugin-state-off-and-autocomplete`, title `fix(plugins): keep an off plugin's state entry, and say so when a command asks for autocomplete (#225, #218)`, body with `Closes #225` and `Closes #218`, the follow-up issue's number, the plan committed as `docs/plans/epics/E235/02-host-state-autocomplete.md` (with a "Deviations from the plan" section in the shape `docs/plans/epics/E236/06-one-apply.md` carries), deviations, the acceptance output pasted, the mutation table, the round list with dispositions. Behaviour change: the full gate — two adversarial read-only reviewers with different lenses (A: correctness and failure modes — a corrupt previous file, an entry with no `installedVersion`, the pause/resume of a schedule, the report branch, the panel's transitional behaviour; B: claims-vs-code and test quality — every coverage row's mutant really fails only the test it names). At most four rounds, then stop and tell the orchestrator. **Never merge.**

## Deviations from the plan (recorded at implementation)

- **Line cites re-verified against `8faed15` (the #224/#223 PR's merge), not the plan's original `e1194e4`**, per the hand-off brief: `CONTEXT.md`'s `#222` gotcha paragraph had shifted only slightly (the false "no-record" claim landed at L904-906, effectively unchanged); `host.ts`'s `buildPluginStateFile` (`:370`), `updates.ts`'s `decidePluginUpdates`/`renderPluginsList`/`PluginActionContext`/`planPluginAction`, `requests.ts`'s `validate`, and `commands.ts`'s `planPluginAction` call site all matched their cited constructs — no line numbers had moved enough to matter, since neither #285 nor this bundle touch the same functions.
- **The follow-up issue for #218's "full" routing seam was filed as [#287](https://github.com/Rackbops/rackbops-discord-bot/issues/287)** before writing Step 5's warn text and the CONTEXT.md gotcha, per decision 10 — cited in both by number.
- No other deviations: all eight "Decided" items, all seven steps, and all 19+1 named tests were implemented as specified.
