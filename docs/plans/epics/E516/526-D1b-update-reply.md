<!-- Plan for #526 bundle D1b (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #526): the `/update` reply path in
`src/commands.ts` -- #449's text half, #505 item 7 and #503 items 2 and 3 (the same `editReply`). Written by the
orchestrating session on 2026-10-16 against main `1a4567d`; every `file:line` below was read at that sha. Audited
read-only before it was committed (round 1, Sonnet, 10 min, 87 tool uses): four blockers applied -- `prefixedName` is
NOT imported in `commands.ts` (the command name now comes from `interaction.commandName`, as `refuseUnlessAdmin` does);
the long failed-swap reply CAN be driven through the handler (the daemon calls are plain `fetch`, `docker.ts`'s `BASE`
is `http://docker`, and `HOSTNAME` names the self container -- the auditor reproduced the 3144-character unclamped
reply on main), so C2 is that end-to-end test; the `CONTEXT.md` anchor I gave was the `commands.test.ts` row (:179),
the `commands.ts` row is :165; and README:103's "pending restart" clause is only true once D1a's guard lands, so it is
left to D1a's CONTEXT text. Also applied: the busy text no longer says "in a minute" (a build runs up to 15 minutes)
nor "check" alone; a T4 variant keeps the first catch's `withoutRequest` guarded; the daemon's error is clamped
before `handoffFailureMessage` so the verdict at the message's tail survives the whole-reply clamp; the source pin
strips comments first; unverified items are named. Round 2 (same auditor, with length probes): the C2 assertions were
contradictory (the bounded reply is about 731 units and ends with the verdict, not the suffix); once the error is
bounded the whole-reply clamp is unreachable through the swap path (M3 is pinned by the source test; M4 gains a
long-Error case); the source test must transpile the whole file before slicing; and the handler's `commandName`
argument gets its own test (C6/M12). The implementer re-reads each anchor on the tree it works from.
D1a (`526-D1a-attempt-record.md`) runs in parallel on another sub and edits `update.ts`, `updateReport.ts`, `state.ts`,
`index.ts`, `redeploy.ts`, their tests, `README.md:106-112` and the `update.ts`/`state.ts`/`updateReport.ts` rows and
three gotchas of `CONTEXT.md`; this bundle edits none of those. Both touch `README.md` and `CONTEXT.md` on different
lines; whichever merges second merges `origin/main` and re-runs its checks. -->

## Implementation plan -- #526 D1b: a truthful busy reply, every /update reply clamped (the daemon's error first), and a reply Discord refuses sent by DM

Children: **#503** (closes: items 2 and 3 are what is left; 7, 10 and 11 landed in R2 and L1 -- confirm on the issue
before claiming the close, and if item 7 is still open say so in the PR instead of closing), **#505 item 7** (the
issue stays open for items 1, 2, 4 and 6), **#449**'s text half (D1a has the guard; #449 is closed by hand once both
PRs are in). One PR, branch `fix/526-D1b-update-reply`, worktree `S:\Repos\_wt\rdb-526-D1b` cut from `origin/main` at
or after `1a4567d`. Behaviour changes (a reply's text, a clamp, a new delivery path) -> the **three-reviewer gate**
applies; every changed production line mutation-tested in a scratch worktree.

### What is wrong, verified at `1a4567d`

- **#449 (the busy reply promises a report to someone who never gets one).** `updateReply`'s `busy` branch
  (`src/commands.ts:401-402`): "⏳ An update is already in progress — I'll report how it went; ask again after that."
  `checkForUpdate` answers `busy` before it reads the requester (`src/update.ts:259`), so the refused admin's token is
  never recorded; only the call that decided `restart` wrote `pendingUpdateReport`, with its own requester
  (`:304-309`), and the report goes to that one user. When the in-flight call is the AUTO tick (`src/announce.ts:316-319`,
  no requester) or a plain check that ends `current`/`suppressed`, no report exists at all. The existing test
  (`src/commands.test.ts:208-212`) pins only `already in progress` and the absence of `Restarting`. After D1a, `busy`
  also covers a deferred exit-75 restart and a shutdown (`restartPending()`), which a text about "an update check"
  would misdescribe.
- **#505 item 7 / #503 item 3 (the success-path reply is not clamped).** The `/update` handler (`commands.ts:109-135`)
  passes `updateReply(...)` to `editReply` with no bound (`:125-127`); the three catch blocks in the file clamp
  (`:132`, `:196`, `:294`), the success-path edits do not. `handoffFailureMessage` interpolates the daemon's error
  text first and the verdict last (`src/handoff.ts:191`, `replacementTail` `:196-214`; `redeploy.ts:334` passes the
  build error through unbounded), so a build error past 2000 UTF-16 units makes the edit reject and the catch replies
  "Update check failed: Invalid Form Body", hiding the real reason -- and a whole-reply clamp alone would cut the
  verdict ("I stayed on the current build", "remove the `-next` container by hand") off the tail. The describe at
  `commands.test.ts:1076` is titled "clampReply guards every editReply failure path" and pins three catch blocks
  (`:1081-1110`); its lead comment (`:1069-1075`) says "these three catch blocks".
- **#503 item 2 (the reply to a long failed swap cannot be delivered).** The build is bounded at 15 minutes
  (`src/docker.ts:53`, started after the interaction), and Discord accepts a reply to an interaction for 15 minutes
  (`src/updateReport.ts:14-15`), so the reply to a build that hits its bound arrives after the token died: `editReply`
  (`:125`) rejects, the catch's `editReply` (`:132`) rejects again, the error reaches `index.ts`'s catch and is only
  logged, and `pendingUpdateReport` was already cleared (`update.ts:348`). The admin sees an unanswered interaction.
  `README.md:62` says "a build failure is reported straight back to you".

### Decisions (defaults, named so the gate can contest them)

1. **The busy text promises nothing to the refused caller and does not pretend the wait is short:**
   "⏳ An update or restart is already in progress — ask again once it has finished (a /<command> that started it
   reports back to whoever ran it)." The command is named from `interaction.commandName`, passed into `updateReply` as
   an option (`commandNaming.ts:12-14`: an interaction's `commandName` IS the registered, prefixed name;
   `refuseUnlessAdmin`, `commands.ts:47-56`, already does this) -- never a bare `/update` (the `commandNaming.test.ts`
   scan fails one written after a quote, backtick or space anywhere under `src/`), and not `prefixedName(...)` either:
   `commands.ts` does not import it, and the interaction already carries the name. The clause is true in every case:
   a `/update` in flight reports to its own requester; an AUTO tick, a plain check, a plugin-update restart or a
   shutdown have no requester and no report.
2. **The handler is restructured so one `content` is built, clamped once, and delivered once.** The check's result
   or its failure text becomes `content` (both through `clampReply`); the delivery is a separate try: `editReply`, and
   on rejection a DM to the requester (`interaction.user.send(content)`), logged with `withoutRequest` (#545). A DM
   that also fails rejects out of the handler, as the double failure does today, so `index.ts`'s catch still logs it
   and the interaction line still says `error`. No retry of `editReply` after a failed `editReply`. On the exit-75
   path the restart is deferred behind the handler's own `withCritical` (`update.ts:337`; `restart.ts:365-370`,
   `:240`), so both the edit and the DM are awaited before the exit fires at the section's close.
3. **The daemon's error is clamped before it is interpolated**, to 600 UTF-16 units with `clampReply`'s suffix, at
   the `handoffFailureMessage` call in `updateReply` (`:427-432`, `error` and `replacementError`), so the verdict and
   the operator instruction at the tail of a failed-swap reply survive; the whole-reply `clampReply` stays as the
   backstop. 600 leaves room for the head, the tail and a `remove-failed` clause.
4. **The DM is the fallback for every refused reply, not only an expired token.** Discord's codes could narrow it
   (10062 Unknown interaction, 10015 Unknown Webhook, 50027 Invalid Webhook Token), but the requester is the same
   user either way, `updateReport.ts:137-140` already DMs them, and the one redundant case (an edit that landed but
   whose response was lost) costs a duplicate message. Closed DMs (50007) are the double failure, which rejects out.
5. **`README.md:62` and `:103` say what happens.** The reply reaches the requester by DM when the reply window has
   closed; a second `/update` during a swap or another update check is refused without a report being promised.
   README:103 does NOT mention a pending restart: that refusal is D1a's guard, and D1a's `CONTEXT.md` text carries it;
   the README sentence can gain it in #533's docs pass once both are on main.

### Step 1 -- `src/commands.ts`

1a. The `/update` row's `handle` (`:109-135`) becomes:

```ts
    handle: async (interaction) => {
      if (await refuseUnlessAdmin(interaction)) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // Inside a critical section so the restart waits for the reply to be delivered.
      await withCritical(async () => {
        // One reply, built first and clamped once (#505 item 7, #503 item 3): the failure path's text used to be the
        // only one through clampReply, while a failed swap's reply carries the daemon's error text unbounded.
        let content: string;
        try {
          const { decision, latestSha, reason, redeploy } = await checkForUpdate({
            force: true,
            // Recorded so the next boot can report back what build it actually landed on.
            requester: {
              userId: interaction.user.id,
              channelId: interaction.channelId ?? undefined,
              applicationId: interaction.applicationId,
              interactionToken: interaction.token,
            },
          });
          content = clampReply(
            updateReply(decision, latestSha, { runningSha: config.gitSha, reason, redeploy, commandName: interaction.commandName }),
          );
        } catch (err) {
          // #503 item 11: the failure used to be swallowed into the reply alone, leaving `outcome=answered` and no
          // trace. withoutRequest: a failed reply carries the interaction token and the reply text (#545).
          console.warn(`[update] /${interaction.commandName} failed`, withoutRequest(err));
          content = clampReply(`⚠️ Update check failed: ${(err as Error).message}`);
        }
        try {
          await interaction.editReply(content);
        } catch (err) {
          // #503 item 2: Discord accepts the reply for 15 minutes after the command, and a build can run that long
          // (docker.ts's BUILD_TIMEOUT_MS), so the reply to a long failed swap can arrive after the token died. The
          // requester is known: tell them by DM. A DM that fails too rejects out of here, as the double failure did
          // before, so index.ts logs it and the interaction line says `error`.
          console.warn(`[update] /${interaction.commandName}: the reply was refused — sending it by DM`, withoutRequest(err));
          await interaction.user.send(content);
        }
      });
    },
```

(`console.warn` in the first catch stays BEFORE the text is built. `MessageFlags` (`:2`), `config` (`:6`),
`clampReply` (`:7`), `withCritical` (`:10`) and `withoutRequest` (`:17`) are imported already; `:14` imports only
`commandNamer` from `./commandNaming`, and nothing here needs more.)

1b. `updateReply` (`:393-397`): the options type gains `commandName?: string` (documented: "the `/update` command as
this instance registered it, from the interaction; the busy text names it"), and the `busy` branch (`:401-402`)
becomes:

```ts
    case "busy":
      // #449: the refused caller is never recorded, so nothing is promised to them, and the wait is not called short
      // (a build runs up to 15 minutes). The clause is true in every case: a /update in flight reports to its own
      // requester; an AUTO tick, a plain check, a plugin-update restart or a shutdown have no requester.
      return `⏳ An update or restart is already in progress — ask again once it has finished (a /${o.commandName ?? "update"} that started it reports back to whoever ran it).`;
```

(The scan's regex is `(?<![\w.}/\\-])/(?:report|update|plugins)(?![\w/-])`: `/${...}` does not match it; a literal
`/update` in the string would.)

1c. The `handoffFailureMessage` call (`:427-432`): `error: o.redeploy.error` becomes
`error: o.redeploy.error === undefined ? undefined : clampReply(o.redeploy.error, DAEMON_ERROR_MAX)` and the same for
`replacementError`, with `const DAEMON_ERROR_MAX = 600;` beside `updateReply` and the comment "the daemon's build or
inspect error comes first in `handoffFailureMessage`'s text and the verdict last; unbounded, a long one pushed the
verdict past the whole-reply clamp (#505 item 7)". `clampReply(text: string, max = 1900)` is `src/github.ts:191`
(`src/announce.ts:525` already calls it with a bound, `RELEASE_NAME_MAX`). With both clauses clamped, the longest
failed-swap reply (`timeout`, `remove-failed`) is about 1399 units, so the verdict and the instruction always fit.

### Step 2 -- docs

- `README.md:62`: old `Its Discord connection stays up, so a build failure is reported straight back to you and nothing is torn down.` -> new `Its Discord connection stays up, so a build failure is reported straight back to you and nothing is torn down (by DM when Discord no longer accepts the command's reply: it accepts one for 15 minutes, and a build can take that long).`
- `README.md:103`: old `- A second \`/update\` while a swap is in flight is **refused**, not queued — it would otherwise tear down the in-flight replacement.` -> new `- A second \`/update\` while a swap or another update check is in flight is **refused**, not queued — it would otherwise tear down the in-flight replacement or overwrite the first requester's follow-up. The refusal promises nothing: only the \`/update\` that started the attempt gets its report.`
  (Grep each old sentence first: exactly one hit.)
- `CONTEXT.md:165` (the `commands.ts` row; one long line): at the END of the sentence that contains ``renders the `/update` acknowledgement`` (one hit, on this row; the sentence runs on to "— a `redeploy` result present at all means the swap **failed**…", so append after its full stop, never mid-sentence) append ``; **#449/#503/#505:** the `busy` reply promises no report to the refused caller and names the command from the interaction, every `/update` reply (the check's result or its failure text) goes through `clampReply` once with the daemon's error clamped to `DAEMON_ERROR_MAX` first so the verdict survives, and a reply Discord refuses (the token lasts 15 minutes after the command; a build can take that long) is sent to the requester by DM instead, a failing DM rejecting out as the double failure did``.
- `CONTEXT.md:179` (the `commands.test.ts` row): append the new tests in one clause.

### Step 3 -- tests (`src/commands.test.ts`)

- **C1 (#449):** in `describe("updateReply")`, the test at `:208-212` becomes "a second /update is refused without
  promising a report, naming the command as registered": `updateReply("busy", "", { commandName: "pipupdate" })`
  contains `already in progress`, `once it has finished` and `/pipupdate`, and does NOT contain `I'll report`,
  `in a minute`, `Restarting` or `/update `; without `commandName` it names `/update`.
- **C2 (#505 item 7 / #503 item 3, end to end through the handler):** the daemon calls are plain `fetch` and the
  self-inspect reads `process.env.HOSTNAME` (`docker.ts:195-197`: 12 hex that prefix the container `Id`;
  `redeploy.test.ts:1597-1651` uses the same seam). An admin interaction (`config.adminUserIds.push("999")`),
  `config.gitSha = "0123456789abcdef0123456789abcdef01234567"`, `process.env.HOSTNAME = "aaaaaaaaaaaa"`, and
  `globalThis.fetch` stubbed by URL:
  - `/commits?` -> `[{ sha: NEW }]`; `/compare/` -> `{ status: "behind" }` (as `update.test.ts:256-267`);
  - `http://docker/_ping` (`docker.ts:26`'s `BASE` + `/_ping`) -> 200;
  - `/containers/aaaaaaaaaaaa/json` -> `{ Id: "a".repeat(64), Name: "/bot", Image: "sha256:deadbeef", State: { Running: true, Status: "running", ExitCode: 0 }, Config: { Image: "bot:latest", Env: [], Labels: {} }, HostConfig: { Binds: [], RestartPolicy: { Name: "unless-stopped" } }, Mounts: [], NetworkSettings: { Networks: {} } }`;
  - `/build` -> 200 with the body `{"error":"<3000 x's>"}\n` (so `parseBuildOutput` reads `ok: false`);
  - anything else -> throw.
  (`NEW` is not defined in this file: define it, `"2".repeat(40)`.) Then `handleCommand(interaction)` -> `edits` has
  ONE entry of about 731 UTF-16 units, which ENDS WITH `stayed on the current build.` (the verdict, Decision 3) and
  matches `/build failed: x{586}… — /` (the error clause is 600 units: the 14 of `build failed: ` plus 586 x's, then
  `clampReply`'s suffix, then the dash before the verdict); `dmCalls === 0` (a landed edit sends no DM). Do NOT assert
  that the reply ends with the suffix: that is true only of the unbounded mutant (1901 units, the verdict cut off),
  which the verdict assertion catches. A second case: `editReply` rejects with `replyFailure("webhook").error` ->
  `edits` empty, `dms[0]` is that same clamped text, and the warn
  `[update] /update: the reply was refused — sending it by DM` exists with `expectCleanedLog`. Restore in `finally`:
  `config.gitSha`, `config.adminUserIds`, `globalThis.fetch`, `process.env.HOSTNAME` (to its prior value or deleted;
  CI's Linux sets one, `docker.test.ts:355-387`), `state.attemptedUpdateToSha = undefined` and
  `state.pendingUpdateReport = undefined` (`applyUpdate` leaves the first armed, `update.ts:301`, `:348`; import
  `state` from `./state`), and `resetUpdateForTest()` (import from `./update`). On main today this case produces one
  unclamped reply of about 3144 characters (the auditor reproduced it): that is the bug. Once the daemon error is
  bounded (1c), no failed-swap reply can exceed 2000 units (the longest, `timeout` with `remove-failed` and both
  clauses clamped, is about 1399), so the whole-reply `clampReply` on this path is a backstop that no end-to-end test
  can reach; C3 pins it.
- **C3 (the source pin, replacing `:1081-1089`):** the describe at `:1076` is renamed
  `commands.ts — clampReply guards every editReply (#55, #186, #503)` and its lead comment (`:1069-1075`) rewritten
  to say the `/update` row has one clamped `content` and the two other rows keep their catch-block clamps; the
  `/update` test becomes "/update builds one clamped reply and edits with it": transpile the WHOLE file first
  (`new Bun.Transpiler({ loader: "ts" }).transformSync(source)`, as `commandNaming.test.ts:39-53` does; a slice of the
  file alone is not parseable and `transformSync` throws on it), then slice the OUTPUT between `name: "update"` and
  `name: "plugins"` (each occurs once in the transpiled output); in that slice `clampReply(` appears exactly twice
  (both `content = clampReply(` assignments; `updateReply`'s own clamps in 1c sit outside it),
  `await interaction.editReply(content)` exactly once, and `editReply(` exactly once.
- **C4 (#503 item 2, end to end):** the test at `:761-803` is rewritten as "a /update whose reply Discord rejects is
  sent by DM, logged without the token; a DM that fails too rejects out": for `rejections` of 1 and 2 with
  `config.gitSha = ""` (`disabled`: no fetch, a reply to send): the stub interaction gains
  `user: { id: "999", send: async (c: string) => { dmCalls += 1; if (rejections === 2) throw failure.error; dms.push(c); } }`;
  `editReply` throws `failure.error` on its first call only. With `rejections === 1`: `handleCommand` resolves
  `"answered"`, `edits` is `[]`, `dms` is `["⚠️ Self-update is disabled — this build has no \`GIT_SHA\` baked in."]`,
  `editReply` was called once (no second edit), and the warn whose first argument is
  `[update] /update: the reply was refused — sending it by DM` exists with `expectCleanedLog`; the
  `[update] /update failed` warn does NOT exist (the check did not fail). With `rejections === 2`: `handleCommand`
  rejects with `failure.error`, `edits` and `dms` are empty, `editReply` and `send` were each called once, and the
  same cleaned warn exists.
- **C5 (keeps the first catch's `withoutRequest` guarded):** T4 (`:722-756`, "a failed update check is logged, not
  only replied") stays, and gains a sibling: `fetch` throws `replyFailure("webhook").error` -> `edits` is
  `["⚠️ Update check failed: Unknown interaction"]` and the `[update] /update failed` warn exists with
  `expectCleanedLog` (the test at `:761` used to be the only one that passed a token-carrying error through that
  catch; C4 no longer does). And a third sibling, for the failure text's clamp: `fetch` throws
  `new Error("y".repeat(3000))` -> `edits[0].length === 1901` and it ends with `…` (`clampReply(text, max = 1900)`,
  `src/github.ts:191`, plus its suffix).
- **C6 (the handler passes the registered name):** in `describe("handleCommand — /update")`, in the pattern of
  `:126-142`: `CORE_COMMANDS.find((c) => c.name === "update")!.handle(interaction)` with an admin interaction whose
  `commandName` is `"pipupdate"` (`handleCommand` cannot dispatch a prefixed name in this process), after
  `beginHandoff("c6")` from `./restart` so `checkForUpdate` answers `busy` at `update.ts:259` -> the single edit
  contains `/pipupdate` and not `/update `; `resetRestartForTest()` in `finally`. (Every other handler test runs with
  an empty prefix and `commandName: "update"`, which equals the `?? "update"` fallback, so without this the argument
  could be dropped unnoticed.)
- `test/prefixedInstance.ts:34-50` and `commandPrefix.test.ts:104-106` dispatch the `disabled` path through the
  restructured handler and still pass (the auditor checked); run them.

### Mutation table (run in a scratch worktree, never in the shared tree)

Commit the work in progress first, then:

```bash
git -C /s/repos/rackbops-discord-bot worktree add --detach /s/Repos/_wt/rdb-526-D1b-mut fix/526-D1b-update-reply
cd /s/Repos/_wt/rdb-526-D1b-mut && bun install --frozen-lockfile
```

Run `bun test src/commands.test.ts src/commandNaming.test.ts src/commandPrefix.test.ts` per mutant.

| # | Mutation (production line, after the steps) | Test that must fail |
|---|---|---|
| M1 | 1b: restore the old busy text | C1 (`I'll report` present) |
| M2 | 1b: a literal `` `/update` `` instead of `/${o.commandName ?? "update"}` | `commandNaming.test.ts`'s scan, and C1 (`/pipupdate` absent) |
| M3 | 1a: `content = clampReply(updateReply(...))` -> `content = updateReply(...)` | C3 only (once 1c bounds the error, no failed-swap reply reaches 2000 units, so this clamp is a backstop no end-to-end test can trip) |
| M4 | 1a: the failure text's `clampReply` dropped | C3, and C5's long-Error case (`edits[0].length === 1901`) |
| M5 | 1a: the DM fallback deleted (the catch rethrows) | C4 (`rejections === 1`: rejects instead of `answered`; `dms` empty), C2's second case |
| M6 | 1a: the fallback retries `editReply` instead of `user.send` | C4 (`editReply` called twice; `dms` empty) |
| M7 | 1a: the second catch swallows the DM's failure | C4 (`rejections === 2` resolves) |
| M8 | 1a: the fallback's warn logs the raw `err` | C4 (`expectCleanedLog`: the token is printed) |
| M9 | 1a: the first catch's warn logs the raw `err` | C5 (`expectCleanedLog`) |
| M10 | 1c: the daemon error not clamped before `handoffFailureMessage` | C2 (`stayed on the current build` cut off) |
| M11 | 1a: `user.send(content)` called after a SUCCESSFUL edit too | C2's first case (`dmCalls === 0`) |
| M12 | 1a: drop `commandName: interaction.commandName` from the `updateReply` call | C6 (`/update` instead of `/pipupdate`) |

### Coverage table

| Bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| #449 (text): the busy reply promises no report, names the command as registered (through the handler too), and does not call the wait short | 1a, 1b | C1, C6 | M1, M2, M12 |
| #505-7 / #503-3: every `/update` reply is clamped, the daemon's error first so the verdict survives; the describe names what it pins | 1a, 1c, C3 | C2, C3, C5 | M3, M4, M10 |
| #503-2: a reply Discord refuses reaches the requester by DM; a DM that fails rejects out; the log carries no token; a landed edit sends no DM | 1a | C4, C2, C5 | M5-M9, M11 |
| README says both | 2 | (docs; lens-B audit) | -- |

### Verification

```bash
bun install --frozen-lockfile
cd ops/admin && bun install --frozen-lockfile && cd ../..
bun run check
bunx tsc --noEmit -p ops/tsconfig.json
cd ops/admin && bun run check && cd ../..
bun test src/commands.test.ts src/commandNaming.test.ts src/commandPrefix.test.ts src/interactionLog.test.ts src/update.test.ts
bun test
```

Not verified here, name it in the PR: a real expired-token rejection from Discord (the tests use a constructed
`DiscordAPIError`), and a real DM.

### Acceptance to paste per issue

- **#449 (text half):** C1's pass line, M1's failing output, the new busy text; note the guard half is D1a's PR.
- **#505 (item 7 only):** C2 and C3 pass lines, M3 and M10 failing output, the length of the reply before the change
  (the ~3144-character edit on main) and after. Comment on #505 naming the PR and that items 1, 2, 4 and 6 remain.
- **#503 (items 2 and 3):** C4's pass line with the DM text, M5 and M7 failing output, the new `README.md:62`
  sentence. Close #503 if items 7, 10 and 11 are confirmed landed (check the issue's comments; R2 was PR #566, L1 was
  PR #573); otherwise "Part of #503" and say which item is left.

### PR

- Title: `fix(commands): stop promising a report to a refused /update, clamp every /update reply with the daemon's error first, and send one Discord refuses by DM (#449, #503, #505)`.
- Body: the three items, Decisions 1-5, the typecheck + test output, the mutation table, the unverified items.
  End with `Closes #503.` (if confirmed) and name #449 and #505 as "Part of".
- After merge: tick #503 on #530 if it is listed there (it is #530's; check) and nothing on #526 until #449 closes.
