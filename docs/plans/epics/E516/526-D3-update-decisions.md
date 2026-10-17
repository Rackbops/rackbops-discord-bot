<!-- Plan for #526 bundle D3 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #526): #505 items 1, 2, 4 and 6
(item 7 shipped in D1b, #582). Written by the orchestrating session on 2026-10-17; every `file:line` below was read
at main `6093ec4`. Re-find each anchor by its quoted text on the tree you cut from.
Files: `src/update.ts`, `src/docker.ts`, `src/announce.ts`, `src/commands.ts` (one new `case`), `src/plugins/updates.ts`
(an extraction, strings unchanged), a new `src/adminNotice.ts`, `src/update.test.ts`, `src/adminNotice.test.ts`, and
docs (`README.md`, `CONTEXT.md`, the comment in `src/github.ts`), and `test/stateLeaks.ts` / `test/stateGuard.test.ts`.
Audited read-only in round 1 (a Sonnet agent; Decisions 1, 3, 4 applied in a scratch tree, U1 and the unforced
compare-500 case drafted and run green; tsc run): applied: `DAEMON_ERROR_MAX` moves to `src/github.ts` (importing it
from `src/commands.ts` is a cycle); the notice dedupe is keyed by sha AND kind, and set only after a delivery that
reached someone (keyed by sha alone, an unreachable-daemon DM swallowed the later build failure's); the generic
delivery takes whole sentences, and U2e pins the plugin strings exactly (today only a substring is pinned); the two
new variables join the state-leak guard; `isSocketPath` is in Step 1; six more stale strings named (README:95,
CONTEXT.md:181-182/:324/:1216-1220, update.ts:54/:141-142/:169); U3 names the armed-attempt pin that flips. Checked
fine: `updateReply` is the only `UpdateDecision` consumer (tsc TS2366 without the new case), and the unreachable-
daemon reply reads honestly. -->

## Implementation plan -- #526 D3: a mounted socket whose daemon does not answer is reported, not an exit 75; an automatic update that fails tells the admins once; a failed compare makes the automatic check wait instead of acting on a guess; and an admin's /update can override `unpublished`

Children: **#505** (closes with this PR: items 1, 2, 4, 6 here; item 7 in #582). One PR, branch
`fix/526-D3-update-decisions`, worktree `S:\Repos\_wt\rdb-526-D3` cut from `origin/main`. Behaviour changes (a new
`UpdateDecision`, a new DM on the automatic path, a refused exit-75): three-reviewer gate.

### What is wrong, verified at `6093ec4`

- **Item 1.** `daemonReachable` (`src/docker.ts:183-189`) returns false on ANY error or timeout, and
  `redeployAvailable` (`src/redeploy.ts:1207-1209`) is just that. `checkForUpdate`'s restart branch reads it as "no
  socket" (`src/update.ts:329`), arms `attemptedUpdateToSha` and the report (`:330-336`), and `applyUpdate` calls
  `requestRestart` (`:366-369`): with the socket mounted and the daemon slow or failing its `/_ping`, the bot exits
  75, the same image respawns, and the automatic check then suppresses that commit. README's "With the socket mounted
  this shouldn't happen" (`README.md:108`) is about the no-op report, and holds only while the daemon answers.
- **Item 2.** `checkAutoUpdate` (`src/announce.ts:322-325`) discards `checkForUpdate`'s result. A failed swap on the
  automatic path is one `console.warn` (`src/update.ts:388`), `attemptedUpdateToSha` stays set (by design, #50,
  `:378-380`), so nobody in Discord hears of it. README `:67` says the original "tells you why" without saying that
  only a `/update` gets told; `:114` says an `AUTO_UPDATE` exit stays silent.
- **Item 4.** `decideUpdate` (`src/update.ts:85-89`) lets `unknown` (any compare failure, `:168-171`, `:181-185`)
  fall through to `restart`. On the socket path the swap SUCCEEDS onto `latestSha`; a build that was `ahead` of it
  (a supported case) is swapped onto an older commit, and the replacement reads `current`, so nothing reverts it. The
  hazard is disclosed in `src/github.ts:34-40` and pinned by `src/update.test.ts:123-126`; the docs
  (`CONTEXT.md:1229-1231`, "degrades the check") omit the consequence.
- **Item 6.** `decideUpdate` returns `disabled` for `unpublished` (`:83`) before `force` is read, and
  `src/update.test.ts:116` pins that `force` cannot override it. The rationale (`:64-66`, "can never be delivered") is
  false on the socket path: `redeploy` builds `latestSha` and never uses the running sha. Probed 2026-10-17: GitHub's
  compare answers `{"message":"Not Found"}` both for a commit it has never seen
  (`compare/main...0123456789abcdef0123456789abcdef01234567`) and for a repo that does not exist, so the 404 body
  cannot tell a never-pushed sha from a GC'd one. Distinguishing them is DECLINED (no signal to read); `force`
  overriding is the fix.

### Decisions (defaults, named so the gate can contest them)

1. **Item 1: a socket that is mounted but unanswering is a failed attempt, not an exit.** New in `src/docker.ts`:
   `export function dockerSocketMounted(): boolean` -- `statSync(BOT_DOCKER_SOCKET).isSocket()`, false on any throw.
   `RedeployDeps` gains two OPTIONAL fields, so every existing test stub keeps its meaning:
   `socketMounted?: () => boolean` (absent = `() => false`, today's behaviour) and `pingRetryDelayMs?: number`
   (absent = 2000). `liveRedeployDeps` passes `dockerSocketMounted`. In `checkForUpdate`'s restart branch:
   `let viaSocket = await deps.redeployAvailable();` and when `!viaSocket && (deps.socketMounted ?? (() => false))()`,
   wait `pingRetryDelayMs` and ask `redeployAvailable()` once more. If it is still false, the branch does NOT arm
   anything (no `attemptedUpdateToSha`, no report, no `swapInFlight`, no save) and does NOT call `applyUpdate`; it sets
   `lastFailure = { sha: latestSha, reason }` and `suppressedWarnedFor = undefined` as `applyUpdate`'s tail does, logs
   `[update] the docker socket is mounted but the daemon did not answer its ping (asked twice) -- not exiting, nothing
   was built; the next check tries again`, and returns `{ decision: "restart", latestSha, redeploy: { outcome:
   "failed", error: "the docker daemon did not answer its ping (asked twice); nothing was built and nothing
   restarted" }, daemonUnreachable: true }`. `UpdateCheck` gains `daemonUnreachable?: true`. Not arming is deliberate:
   the cause is transient, and the next tick (or the admin) should simply try again. `updateReply`'s existing failed-
   swap branch renders it (`outcome: "failed"` with the error), so `/update` gets an honest reply with no new text.
   Read `handoffFailureMessage` (`src/commands.ts`) first: if its wording would claim a replacement was created or
   removed when `replacement` is undefined, say so in the PR and keep `replacement` undefined (it reads as "nothing to
   clean up").
2. **Item 2: the automatic path DMs the admins once per failed commit per process.** A new `src/adminNotice.ts` holds
   the delivery `deliverPluginNotification` already does (DM each admin, fall back to the announce channel ONCE if any
   DM failed, warn when `ADMIN_USER_IDS` is empty), parameterised by its three log texts as whole sentences, not a
   subject spliced into the plugin wording: `deliverAdminNotice(message, adminUserIds, deliverers, log, texts: {
   noAdmins: string; dmFailed: (userId: string, reason: string) => string; fallbackFailed: string })`.
   `deliverPluginNotification` (`src/plugins/updates.ts:608-640`) becomes a wrapper passing its three current
   strings verbatim. Today's tests check only the substring `ADMIN_USER_IDS is empty`
   (`src/plugins/updates.test.ts:623`), so U2e pins all three plugin strings exactly. The update path's texts:
   `[update] a failed automatic update needs reporting but ADMIN_USER_IDS is empty — no one to notify`, `[update]
   couldn't DM admin <id> about a failed automatic update (<reason>) — will try the announce channel`, `[update]
   channel fallback for a failed automatic update notice failed`.
   In `src/update.ts`: a pure `autoUpdateFailureNotice(check: UpdateCheck, runningSha: string, updateCommand: string):
   string | undefined` -- undefined unless `check.decision === "restart" && check.redeploy`; else
   `⚠️ The automatic update to \`<short latest>\` failed: <reason>. Still running \`<short running>\`.` + (when
   `check.daemonUnreachable`) ` The next automatic check tries again.` or (otherwise) ` The automatic check will not
   retry this commit until a newer one lands; /<updateCommand> retries it now.` -- where `<reason>` is
   `check.redeploy.error ?? check.redeploy.outcome ?? "failed"` clamped with `clampReply(_, DAEMON_ERROR_MAX)`.
   `DAEMON_ERROR_MAX` is today a non-exported `const` in `src/commands.ts:417`, and `src/commands.ts` imports
   `./update`, so importing it from there is a cycle: MOVE it to `src/github.ts` as `export const DAEMON_ERROR_MAX =
   600` beside `clampReply`, and have `src/commands.ts` import it from there (no value change).
   And `notifyAutoUpdateFailure(check, deps: { deliver: (message: string) => Promise<boolean>; runningSha: string;
   updateCommand: string })`: builds the notice; the dedupe key is `check.latestSha + ":" + (check.daemonUnreachable ?
   "unreachable" : "failed")`; if there is a notice and `autoNotifiedFor !== key`, it awaits `deliver` and sets
   `autoNotifiedFor = key` only when `deliver` resolved true (a delivery that reached nobody is tried again at the
   next failure). `autoNotifiedFor` is a new module variable, added to `updateStateForTest` / `resetUpdateForTest`.
   Keyed by sha AND kind: an unreachable daemon is retried every tick (Decision 1) and must not DM every 15 minutes,
   but when it comes back and the BUILD then fails for that same sha, that failure is a different notice and is sent
   (round 1: keyed by sha alone it was swallowed, the original bug). `checkAutoUpdate`
   (`src/announce.ts:322`) becomes `checkAutoUpdate(client)`: `const check = await checkForUpdate(); await
   notifyAutoUpdateFailure(check, { deliver: (m) => deliverAdminNotice(m, config.adminUserIds, <deliverers as in
   livePluginUpdateDeps, :344-349>, console, { tag: "update", subject: "a failed automatic update" }), runningSha:
   config.gitSha!, updateCommand: prefixedName(config.commandPrefix, "update") })`; the tick at `:235` passes `client`.
   Factor the two deliverers out of `livePluginUpdateDeps` into one `liveAdminDeliverers(client)` used by both.
   A `/update` failure is NOT notified this way (it already gets its reply).
3. **Item 4: `unknown` without `force` waits.** `UpdateDecision` gains `"undetermined"` ("the compare failed; the
   automatic check acts on nothing and asks again next time", #505). In `decideUpdate`, after the
   `identical`/`ahead` line and before the suppression line: `if (o.relation === "unknown" && !o.force) return
   "undetermined";`. An admin's `/update` (always `force: true`, `src/commands.ts:118-119`) keeps today's `restart`:
   the admin asked. `checkForUpdate` logs `[update] could not tell whether <short running> contains <short latest>
   (the compare failed) -- not acting; the next check asks again` once per latest sha per process (reuse the
   `suppressedWarnedFor` pattern with its own variable `undeterminedWarnedFor`, added to the test-state pair), and
   returns `{ decision, latestSha }` with no save. `updateReply` gets a `case "undetermined":` (unreachable from
   `/update` today; TypeScript needs it): `❓ I couldn't tell whether this build contains \`<short>\` (GitHub's
   compare failed) — try again shortly.` Grep `UpdateDecision` and every `switch (decision` for any other consumer.
4. **Item 6: `force` overrides `unpublished`.** `decideUpdate`'s line becomes `if (o.relation === "unpublished" &&
   !o.force) return "disabled";`; with `force` the decision falls through to `restart` (the suppression line already
   yields to `force`). The doc comment (`:64-66`) is rewritten: an unpublished running sha cannot be COMPARED, so the
   automatic check stays off for it; an admin's `/update` still rebuilds the branch tip (`redeploy` builds
   `latestSha`, never the running sha) or, without the socket, exits 75 as for any restart. The 404-body distinction
   is declined (the probe above). `updateReply`'s `unpublished-sha` text stays (reachable from the automatic path's
   `UpdateCheck`, not from `/update` after this change); its comment says so.

### Steps

1. `src/docker.ts`: `export function isSocketPath(path: string): boolean` (`statSync(path).isSocket()`, false on any
   throw) and `dockerSocketMounted()` calling it with `BOT_DOCKER_SOCKET` (Decision 1), `statSync` from `node:fs`.
   `src/github.ts`: `DAEMON_ERROR_MAX` moved here and exported; `src/commands.ts` imports it.
2. `src/update.ts`: Decisions 1, 2 (the two functions, the variable), 3 and 4. Comments and strings that become false
   (round 1 found them; re-find by quote): the `ShaRelation` doc for `unknown` (`:54`, "fall back to treating a sha
   mismatch as stale"); `decideUpdate`'s doc (`:64-67`); `fetchShaRelation`'s doc (`:141-142`, "degrades the check")
   and its comment at `:154-156`; the runtime warn at `:169` ("compare failed: N — treating a sha mismatch as stale"
   -> "compare failed: N — the automatic check waits; /update still acts"); `checkForUpdate`'s disabled-branch comment
   (`:294`, now only the unforced `unpublished`).
   `test/stateLeaks.ts`'s `updateLeaks` and `test/stateGuard.test.ts`: the two new module variables
   (`autoNotifiedFor`, `undeterminedWarnedFor`) join `suppressedWarnedFor` there -- a leak line each, and the guard
   test's cases.
3. `src/adminNotice.ts` + the `src/plugins/updates.ts` wrapper (Decision 2).
4. `src/announce.ts`: `checkAutoUpdate(client)`, `liveAdminDeliverers`, the tick call.
5. `src/commands.ts`: the `undetermined` case and the `unpublished-sha` comment.
6. Docs:
   - `src/github.ts:34-40`: the "Not tighter than 10s" paragraph -- a timed-out compare now makes the automatic check
     wait (`undetermined`); only an admin's `/update` still acts on it, which is why the timeout stays generous.
   - `README.md:67`: "...and tells you why" gains "(a `/update` gets the reason as its reply; an automatic update
     DMs the admins once, below)". `:108`'s parenthetical gains: "and if the daemon doesn't answer, the bot reports
     that and does not exit". `:114` becomes: "Only a restart `/update` asked for produces a follow-up. A host
     reboot or a plain `docker compose up` stays silent; an `AUTO_UPDATE` attempt that FAILS DMs the admins (the
     announce channel if a DM fails) once per commit per process, and one that succeeds is silent." The bullet at
     `:116` ("with one the remote has never seen") gains "(an admin's `/update` still rebuilds the branch tip)".
     Grep `README.md` for any other sentence saying a compare failure restarts or that `force` cannot override.
   - `README.md:94-95`: the "unpushed commits" bullet ("instead of offering an update it could never deliver") gains
     that an admin's `/update` still rebuilds the branch tip; the "If the compare call fails" bullet becomes: the
     automatic check waits and asks again at the next tick; an admin's `/update` still acts on a mismatch.
   - `CONTEXT.md:181-182` (the `src/update.ts` and `src/update.test.ts` file-map rows), `:324` (`src/commands.test.ts`
     row, if it lists `updateReply`'s cases), and `:1216-1220` (the Self-update behaviour paragraph: `unknown` ->
     `undetermined` unforced, `restart` forced; `unpublished` -> `disabled` unforced, `restart` forced).
   - `CONTEXT.md:1227-1231` (the `BOT_BRANCH` gotcha): `unpublished` disables only the automatic check (an admin's
     `/update` overrides it); `unknown` now makes the automatic check wait (`undetermined`) and restarts only for a
     `/update`. Grep `CONTEXT.md` for `redeployAvailable` (`:1120`) and the `src/update.ts` / `src/docker.ts` /
     `src/announce.ts` file-map rows, and add `dockerSocketMounted`, `undetermined`, `notifyAutoUpdateFailure` and
     `src/adminNotice.ts` where the rows list exports.

### Tests (`src/update.test.ts`, new `src/adminNotice.test.ts`)

- **U1 (item 1):** with `stubGitHub()` (behind), `setExitFn` recording exits as in the no-socket test at `:562`:
  deps `{ redeployAvailable: async () => false, socketMounted: () => true, pingRetryDelayMs: 0, redeploy: throws }`,
  `checkForUpdate({ force: true, requester: REQUESTER }, deps)` -> `decision` `restart`, `daemonUnreachable` true,
  `redeploy.error` contains `did not answer`, `restartPending()` false, `exits` empty, `onDisk()` has no
  `attemptedUpdateToSha`, no `pendingUpdateReport`, no `swapInFlight`; and `redeployAvailable` was called exactly
  twice (count it).
- **U1b:** `redeployAvailable` false then true -> `redeploy` IS called once (the second ping won), and the markers
  are armed as on the ordinary socket path.
- **U1c:** the existing no-socket test (`:562-`) still passes unchanged (no `socketMounted` = today's exit-75).
- **U1d:** `dockerSocketMounted` -- skipIf(win32): false for a path that does not exist, false for a regular file
  (point `BOT_DOCKER_SOCKET` is module-level, so test the stat helper by extracting `isSocketPath(path)` and having
  `dockerSocketMounted` call it with `BOT_DOCKER_SOCKET`; test `isSocketPath` on a temp regular file and a missing
  path; a real unix socket from `Bun.listen({ unix })` -> true).
- **U2 (item 2):** `autoUpdateFailureNotice`: (a) a `restart` with a redeploy error -> names both short shas, the
  reason, and the "will not retry ... /update" tail; (b) the same with `daemonUnreachable` -> the "next automatic
  check" tail; (c) `current`, `suppressed`, `undetermined`, and `restart` without `redeploy` -> undefined; (d) a
  3000-char error is clamped (notice length < 1000).
- **U2b:** `notifyAutoUpdateFailure` called twice with the same failing check -> `deliver` called once; then with a
  new `latestSha` -> called again; with a non-failing check -> not called; an unreachable-daemon check then a failed
  build for the SAME sha -> called twice (one per kind); a `deliver` that resolves false -> the next identical call
  delivers again.
- **U2e:** `deliverPluginNotification` logs its three strings exactly as before (pin each in full: the no-admins
  warn, the DM-failed warn with an id and reason, the fallback error).
- **U2c (wiring):** a source pin in `src/announce.ts`: `checkAutoUpdate` passes `checkForUpdate()`'s result to
  `notifyAutoUpdateFailure`, and the tick calls `checkAutoUpdate(client)`.
- **U2d (`src/adminNotice.test.ts`):** `deliverAdminNotice`: every DM ok -> no announce post, true; one DM fails ->
  one announce post, true; no admins -> warn naming `ADMIN_USER_IDS`, false; the tag and subject appear in its log
  lines. The existing `deliverPluginNotification` tests stay green unchanged.
- **U3 (item 4):** `decideUpdate({ runningSha: OLD, latestSha: NEW, relation: "unknown" })` -> `undetermined`; with
  `force: true` -> `restart`. The existing `unknown` pins change to these (re-find by quote: the one that asserts
  `restart` for `unknown`, and the one asserting `suppressed` for `unknown` with an armed attempt -- unforced, that
  is now `undetermined`). `checkForUpdate({}, deps)` with the compare
  stubbed to 500 -> `undetermined`, `redeploy` not called, nothing saved (no `attemptedUpdateToSha` on disk). And
  `updateReply("undetermined", NEW, ...)` contains `couldn't tell`.
- **U4 (item 6):** `decideUpdate({ runningSha: OLD, latestSha: NEW, relation: "unpublished", force: true })` ->
  `restart` (the pin at `:116` flips); without `force` -> `disabled` (unchanged).

### Mutation table (detached scratch worktree; `bun test src/update.test.ts src/adminNotice.test.ts src/plugins/updates.test.ts`)

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | the `socketMounted` branch removed (unreachable = exit 75 again) | U1 |
| M1b | the second ping removed | U1 (call count), U1b |
| M1c | the unreachable branch arms `attemptedUpdateToSha` before returning | U1 |
| M1d | `isSocketPath` returns `existsSync(path)` | U1d (regular file) |
| M2 | `autoNotifiedFor` guard removed | U2b |
| M2e | the dedupe key drops the kind (sha alone) | U2b (unreachable-then-failed) |
| M2f | `autoNotifiedFor` set before `deliver` resolves | U2b (deliver false) |
| M2g | the plugin wrapper's no-admins text changed by one word | U2e |
| M2b | `checkAutoUpdate` drops the result again | U2c |
| M2c | `deliverAdminNotice` posts to the channel even when every DM succeeded | U2d |
| M2d | the notice picks the "will not retry" tail for an unreachable daemon | U2 (b) |
| M3 | the `undetermined` line removed | U3 |
| M3b | its `!o.force` dropped | U3 (force case) |
| M4 | `&& !o.force` dropped from the `unpublished` line | U4 |

### Coverage table

| Bullet | Step(s) | Test | Mutation |
|---|---|---|---|
| #505-1: a mounted socket whose daemon fails its ping is reported, not an exit 75, and nothing is armed | 1, 2, 6 | U1, U1b, U1c, U1d | M1, M1b, M1c, M1d |
| #505-2: a failed automatic update tells the admins once, and the README says who hears what | 2, 3, 4, 6 | U2, U2b, U2c, U2d, U2e | M2, M2b, M2c, M2d, M2e, M2f, M2g |
| #505-4: a failed compare makes the automatic check wait; only an admin's /update acts on it | 2, 5, 6 | U3 | M3, M3b |
| #505-6: an admin's /update overrides `unpublished`; the rationale is true | 2, 5, 6 | U4 | M4 |
| Docs state the new behaviour (README, CONTEXT, github.ts) | 6 | lens-B audit | -- (docs) |

### Verification

- `bun run check`; `bun test` (root, one unscoped run); `bun test --randomize` once.
- The mutation table, in a scratch worktree.
- Not verifiable on MILE: a real daemon that hangs on `/_ping` with the socket mounted (U1 drives it by stub); a real
  DM delivery (U2b/U2d drive the deliverers by stub). Name both in the PR.

### Acceptance (paste the output)

- U1-U4's pass lines, and M1-M4's failing output.
- `git grep -n "can never be delivered" src/update.ts` -> nothing.
- `git grep -n "undetermined" src/update.ts src/commands.ts` -> the decision, its use in `decideUpdate`, the log line
  and the reply case.

### PR

Title: `fix(update): report an unanswering daemon instead of exiting, tell the admins when an automatic update fails, wait on a failed compare, and let /update override an unpublished sha (#505)`. Body: what changed per item, the
declined 404 distinction with the probe, the not-verified rows, the gate rounds. End with `Closes #505.`

### Out of scope

- Expiring the suppression for a transient failure (#505 item 2's second suggestion): an unreachable daemon is no
  longer armed at all (Decision 1), which covers the transient case that motivated it; a build that fails stays
  suppressed by design (#50), and `/update` bypasses it.
- Retrying a failed compare within the same tick: the next tick (15 minutes) asks again.
