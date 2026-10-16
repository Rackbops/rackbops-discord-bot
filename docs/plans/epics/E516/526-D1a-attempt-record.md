<!-- Plan for #526 bundle D1a (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #526): the self-update attempt
record and the report that follows it -- #450 (the whole issue), #449's guard half, #452 (the tests), #411 and #429 (the
docs that follow the code), and #506 items 12 and 13. Written by the orchestrating session on 2026-10-16 against main
`1a4567d` (PR #576 merged); every `file:line` below was read at that sha. Audited read-only before it was committed
(round 1, Sonnet, 14 min, 92 tool uses, the snippets type-checked against a replica with the repo's flags): five
blockers applied -- the in-flight log line read `.status` off a union member that has none; the existing `afterEach`
blocks in `update.test.ts` never call `resetUpdateForTest()`, so the new module values would have tripped the
test-state guard on four existing tests; `probeReplacement` had no test seam (it now takes `deps` like `healOwnName`);
R3 seeded the report in memory only, so the clear-before-deliver mutant survived; the `current` clear, the `finally`
release and the third-sha `interrupted` case had no mutant. Two design calls taken from it: a failed AUTO swap no
longer wipes an owed `/update` report (the failure tail clears only the report this call armed), and a probe that
cannot tell (`unknown`) is treated like a swap in flight (the record, the marker and the report are left for the next
boot) instead of consuming the report with a claim that may be false. Also applied: the swap record is shape-checked
(a hand-edited one is `stale`, never a throw before the scheduler starts), the `interrupted` text no longer asserts
what cannot be proved after a rollback, the "re-fire" wording says "at most one repeat", the busy doc comment, the
index.ts/updateReport.ts/two-flags-gotcha rows are in the docs step, `suppressedWarnedFor` is reset when a new failure
is recorded, the `exitFn` restore, the placement anchors, and D1b's merge order. The implementer re-reads each anchor
on the tree it works from. D1b (`526-D1b-update-reply.md`, the `/update` reply path in `commands.ts`) runs in parallel
on another sub: it edits `commands.ts`, `commands.test.ts`, `README.md:62` and `:103` and the `commands.ts`/
`commands.test.ts` rows of `CONTEXT.md`; this bundle edits none of those. S4b (#525, PR #577) edits `redeploy.ts` in
`buildCreateSpec`, `awaitRetirementFailure`, `stepAside` and `finishProbation`; this bundle adds one exported function
at a different place in that file (step 3). -->

## Implementation plan -- #526 D1a: record a socket-path swap, resolve it at the next boot, refuse a second /update while a restart is pending, keep an owed report through an AUTO restart, pin the report's persistence, and make the docs say what the code does

Children: **#450** (closes), **#452** (closes), **#411** (closes), **#429** (closes), **#449** (its guard half: the
`restartPending()` leg and the test; the busy text is D1b's, and #449 is closed by hand once both PRs are in), **#506**
items **12** and **13** (the issue stays open for items 10, 11 and 14, which go with #507 and #558 in a later bundle).
One PR, branch `fix/526-D1a-attempt-record`, worktree `S:\Repos\_wt\rdb-526-D1a` cut from `origin/main` at or after
`1a4567d`. Behaviour changes on the update decision and the boot path -> the **three-reviewer gate** applies; every
changed production line mutation-tested in a scratch worktree (never the shared tree). **Merge order with D1b:** when
both are green, merge D1b first: its busy text ("An update or restart is already in progress") covers the cases this
bundle's wider guard adds (a pending exit-75 restart, a shutdown); with D1a first, those cases show the old text for
the interval between the two merges, which is already false today for the AUTO case.

### What is wrong, verified at `1a4567d`

- **#450 (a death mid-swap leaves the attempt armed).** `checkForUpdate` arms `state.attemptedUpdateToSha` (A) and
  `state.pendingUpdateReport` (P) and saves them (`src/update.ts:300-310`) BEFORE `applyUpdate` (`:311`) decides the
  path (`:335`: `redeployAvailable()`), builds (`src/redeploy.ts:324-328`, up to 15 minutes), creates the standby and
  waits for its verdict. The exit-75 path (`update.ts:335-339`) arms the same two keys and exits; there the armed
  state across the respawn is the design (the next boot reports `noop` when the image was not rebuilt, and A stops
  the exit loop, #50). On the socket path a process that dies between the save and the standby's takeover (a reboot,
  an OOM kill, a `bot-ops.sh restart` or the panel's Restart during the build: handoff state table rows 8, 10 and 11,
  `docs/plans/epics/E516/525-handoff-state-table.md:128-136`) comes back on the same sha with A and P still armed:
  `decideUpdateOutcome` returns `noop` (`src/updateReport.ts:38-39`) and the requester reads "the image wasn't
  rebuilt. Redeploy with `--build`" (`:53-58`), the wrong cause; and every unforced check is `suppressed` (`update.ts:87`)
  until a newer commit lands or an admin forces it. Nothing in `state.json` says which path armed the keys, so a boot
  cannot tell the genuine no-op from the interrupted swap. Row 10 is the hard case: the original restarted in place
  by Docker while the standby is alive and about to take over -- its boot must leave the report to the standby.
- **#449, the guard half (`commands-report-interaction-9`, `self-update-handoff-5`).** The busy guard is
  `handoffActive() || checkInFlight` (`update.ts:259`). On the exit-75 path `requestRestart` (`:337`) is deferred
  behind the command's own `withCritical` (`src/commands.ts:113`; `src/restart.ts:365-370`), `checkInFlight` is
  released in `finally` (`update.ts:316`) and `handoffActive()` is false, so a second forced `/update` in that window
  passes the guard, decides `restart` again and overwrites P with its own requester (`:304-310`); the first requester
  never hears (handoff state table row 5). `restartPending()` (`restart.ts:299-301`: `pending || handoff ||
  shuttingDown`) is true in exactly that window, a superset of `handoffActive()`, and `onTick` (`announce.ts`)
  already uses it as "start no new work", so the scheduler reaches `checkForUpdate` while a restart is pending only
  when the restart began mid-tick.
- **#452 (the persistence and clearing lines are unguarded).** No test passes a `requester` to `checkForUpdate`, so
  nothing pins that P and A are on disk before `redeploy` runs (`update.ts:310`), that P is cleared after a failed
  redeploy (`:348-349`), that A is cleared on `current` (`:287-291`), or the no-socket branch (`:335-339`); the
  "guard releases" test (`src/update.test.ts:374-384`) uses `resetUpdateForTest`, and the one after it (`:388-397`)
  the `current` path, so a thrown fetch releasing the latch in `finally` (`:315-317`) is unpinned;
  `reportUpdateOutcome` (`updateReport.ts:159-179`) has no test at all (its deliverers are built inside it, `:177`),
  and `liveDeliverers.viaToken`/`viaDm` (`:131-140`) have none (`updateReport.test.ts:203-240` covers `viaChannel`).
- **#506 item 12 ("nothing here throws" is false; an AUTO restart wipes an owed report).** `reportUpdateOutcome`
  awaits `saveState()` (`updateReport.ts:164`) with no catch, so a rejecting save (a full or read-only volume)
  escapes to `index.ts:538`'s `.catch` and the report is never delivered (and re-fires next boot). Separately,
  `checkForUpdate` assigns `state.pendingUpdateReport = buildUpdateReport(...)` on every `restart` decision
  (`update.ts:304-309`); with no requester (the AUTO tick, `src/announce.ts:316-319`) that is `undefined`, so an
  AUTO tick that decides `restart` before `reportUpdateOutcome` has run (the scheduler starts at `src/index.ts:398`,
  the report is sent at `:538`; handoff state table row 28) overwrites an owed `/update` report with nothing -- and
  `applyUpdate`'s failure tail (`:348`) would wipe it too when that AUTO swap fails.
- **#506 item 13 (the suppression log is wrong and not once).** The `suppressed` branch (`update.ts:293-298`) warns
  on every check -- with `AUTO_UPDATE=true` every 15 minutes, about 96 lines a day (#429) -- and always blames "the
  orchestrator is not supplying new code. Rebuild the image", which is the exit-75 diagnosis; on the socket path the
  real cause was a failed build or handoff whose reason `applyUpdate` logged once (`:350-352`) and then forgot.
  `CONTEXT.md:325-326` ("Stale → persist `attemptedUpdateToSha`, then exit 75 for the orchestrator to respawn")
  describes exit 75 as the mechanism. `fetchShaRelation` reads only `status` (`update.ts:170`) but fetches the whole
  compare payload (GitHub's compare endpoint takes `per_page`, which bounds its commits list).
- **#411 (the File Map says a failed redeploy clears A).** `CONTEXT.md:180`: "A failed redeploy clears
  `attemptedUpdateToSha` + `pendingUpdateReport` again, since the restart never happened — leaving them would owe a
  follow-up for nothing and let the anti-loop guard suppress the next genuine attempt". `applyUpdate` clears only P
  (`update.ts:344-349`) and keeps A on purpose (`update.test.ts:273-295` pins it: the second unforced check is
  `suppressed`). Same row: "404 → `unpublished`, any other failure → `unknown`" and the gotcha at `CONTEXT.md:1203-1204`
  ("the compare 404s, which is its own `ShaRelation` (`unpublished`)"), while `fetchShaRelation` returns `diverged`
  for a 404 whose body says "no common ancestor" (`update.ts:157-165`; `update.test.ts:176-186`), which restarts.
- **#429 (README says once).** `README.md:112`: "it says so once in the log and **stops trying**". The code warns on
  every check (above); "stops trying" is true.

### Decisions (defaults, named so the gate can contest them)

1. **A socket-path swap is recorded in `state.json` before the build, as its own key.** `swapInFlight: { fromSha,
   toSha, startedAt }` is written beside A and P in the same save that arms them (one save, not two: `applyUpdate`'s
   `redeployAvailable()` call moves ahead of the arming so the path is known), is absent on the exit-75 path, and is
   cleared with P when `redeploy()` returns (a failed swap). A and P keep their names and meanings: they are
   saved-data keys (personal **Escalation**), and the exit-75 path still needs both as they are. A record whose shape
   is wrong (a hand edit) is `stale`: `loadStateFrom` checks no key but `seenReleaseIds`, so the resolver checks this
   one itself and never throws.
2. **The next boot resolves the record before the scheduler starts, with one bounded daemon probe only in the
   ambiguous case.** `resolveUpdateAttempt()` runs in `activate()` after the #541 shutdown guard and before
   `startScheduler` (so an interrupted attempt's A is cleared before the first tick can read it, and the verdict
   reaches `reportUpdateOutcome`). `swapInFlight.toSha` matching the running sha is the swap that LANDED (this is the
   new build): clear the record, nothing else. `fromSha` matching is the original back on the old build: probe
   `<name>-next` through the daemon (bounded by `RESOLVE_BOOT_MODE_TIMEOUT_MS`, as `resolveBootMode` and
   `healOwnName` are). A running or restarting `-next` is a swap IN FLIGHT (row 10): touch nothing, log, and leave the
   report to the new build. A probe that cannot tell (no daemon, a timeout, a failed inspect) is treated the same way:
   the record, A and P stay for the next boot to resolve (P ages out at 24 h, `reportTooOld`), because clearing A on a
   guess could start a build beside a standby that is about to retire this process, and telling the requester "nothing
   changed" while that standby may be about to say "updated" would be two contradictory messages. Anything else --
   stopped, never started (`created`), gone -- is INTERRUPTED: clear the record and A (the automatic check retries),
   keep P so the requester is told. Neither sha matching (a third build, or no `GIT_SHA`) is STALE: clear the record,
   leave A and P to the existing paths. An ordinary boot (no record) still never touches the socket. Known limit,
   named in the PR and the docs: a record left as `in-flight` by a standby that then dies without taking over stays
   until this container's next boot (the automatic check stays off that sha; `/update` still works, its guard does not
   read the record).
3. **`interrupted` is a fifth report outcome**, between `noop` and `unexpected`, worded for what the boot can prove:
   "the update to X did not take: this process is back on the build it left on (it restarted before the new build had
   taken over, or the swap was rolled back). Run /update again." -- with the command name through
   `prefixedName(config.commandPrefix, "update")`, as `redeploy.ts:305` does, because `commandNaming.test.ts` fails a
   bare `/update` written after a quote, backtick or space anywhere under `src/`. (A rollback after the new build
   crashed is #558's case, D2: it will make that boot keep A instead of re-arming an automatic retry.)
4. **`reportUpdateOutcome` never throws, and a swap in flight leaves the report alone.** The clear-and-save is kept
   first (the gotcha's reason stands) but a rejecting save is logged and delivery goes ahead: one report now beats
   none, and the cost is at most one repeat at the next boot (the disk still holds P if the save failed and the
   delivery succeeded). With resolution `in-flight` it returns without consuming P. Its deliverers become an
   injectable third parameter (default `liveDeliverers(client)`), which is what lets #452's test drive it.
5. **An AUTO restart never overwrites, and an AUTO swap's failure never wipes, a pending report.** `buildUpdateReport`
   is assigned only when it returns a report, and `applyUpdate`'s failure tail clears P only when it is the report
   this very call armed (identity), so an owed `/update` report survives an automatic attempt that decides `restart`
   in the first-tick window and then fails. A report that survives an automatic swap that LANDS is delivered on the
   next boot as `unexpected` (the new build is neither its `fromSha` nor its `toSha`), whose text gains "(an
   automatic update, or a redeploy by hand)".
6. **The suppressed warning is logged once per pending sha per process and names the last failure.** `applyUpdate`
   remembers the failed swap's reason (in memory; it is this process's own history) and resets the once-guard when it
   records a new failure, so a second failed swap on the same sha re-explains itself; the warning says "the last
   attempt failed: <reason>" when it has one for that sha, or that the process came back on the same build (the
   exit-75 case) or the swap did not take. Once per process is what README's "once" becomes: a restart repeats it
   once. Both new module values join `updateStateForTest`/`resetUpdateForTest` and the test-state guard's
   `updateLeaks`, so a test that triggers the warning cannot leave the next test's assertion silently skipped -- and
   the two existing `afterEach` blocks in `update.test.ts` gain `resetUpdateForTest()`, because four of their tests
   make a failing `redeploy()` return, which now records a failure.
7. **The busy guard is `restartPending() || checkInFlight`.** `restartPending()` covers `handoffActive()`, a deferred
   exit and a shutdown; nothing that was refused before is admitted now. The second requester is not recorded as an
   extra recipient (declined: the truthful refusal text, D1b's, is enough).
8. **The compare URL gets `?per_page=1`** (it bounds the commits list the compare endpoint returns, which the caller
   never reads; the changed-files list is unaffected). The existing URL test gains the assertion.

### Step 1 -- `src/state.ts`

1a. After `PendingUpdateReport` (`:10-18`):

```ts
/**
 * A socket-path self-update this container started and has not resolved (#450): written in the same save that
 * arms `attemptedUpdateToSha`/`pendingUpdateReport`, before the build; cleared when `redeploy()` returns (the swap
 * failed) or by the next boot's `resolveUpdateAttempt` (`update.ts`), which reads it to tell a swap that landed
 * (this is the new build), one still in flight (the original restarted beside a live `<name>-next`) and one that was
 * interrupted (nothing took over) apart -- the exit-75 path never writes it, so its absence means "what the two
 * markers say is the whole story".
 */
export interface SwapInFlight {
  fromSha: string; // the build that started the swap
  toSha: string; // the build it was swapping to
  startedAt: number; // ms epoch, for the log
}
```

1b. `BotState` (`:21-34`), after `pendingUpdateReport` (`:33`):
`swapInFlight?: SwapInFlight; // #450: a socket-path swap from before its build until redeploy() returns or the next boot resolves it`.

(`loadStateFrom` spreads unknown keys through, `:87`, and checks none but `seenReleaseIds` (`:38-53`), so the
resolver in step 2 checks this key's shape itself; `botStateForTest`/`resetBotStateForTest` compare and restore every
key, `:146-158`; nothing else to change here.)

### Step 2 -- `src/update.ts`

2a. Imports: `:2` becomes `import { state, saveState, type PendingUpdateReport, type SwapInFlight } from "./state";`;
`:3` becomes `import { restartPending, requestRestart } from "./restart";` (`handoffActive` is no longer used here;
drop it); add `import { prefixedName } from "./commandNaming";` and extend the `./redeploy` import at `:4` with
`probeReplacement, type ReplacementProbe` (step 3).

2b. The `UpdateDecision` doc comment for `busy` (`:28`): `/** A handoff is already in flight — this call refuses before touching anything. */`
-> `/** A handoff, another check or a pending restart is already in flight — this call refuses before touching anything (#449). */`.
The compare URL (`:149-151`): append `?per_page=1` --
`` `${encodeURIComponent(latestSha)}...${encodeURIComponent(runningSha)}?per_page=1` `` -- with the comment line
`// per_page=1 (#506): only \`status\` is read; this bounds the commits list the compare endpoint attaches (30 by default).`

2c. Module state (after `let checkInFlight = false;`, `:225`):

```ts
/** #506 item 13: the sha the `suppressed` warning was last logged for, so it is logged once per pending sha per process. */
let suppressedWarnedFor: string | undefined;
/** #506 item 13: why the last socket-path swap this process ran failed, so the `suppressed` warning can say so. */
let lastFailure: { sha: string; reason: string } | undefined;
```

`updateStateForTest` (`:228-230`) returns `{ checkInFlight, suppressedWarnedFor, lastFailure }`; `resetUpdateForTest`
(`:233-235`) clears all three. `test/stateLeaks.ts:89-92` `updateLeaks` takes
`s: { checkInFlight: boolean; suppressedWarnedFor?: string; lastFailure?: { sha: string; reason: string } }` (the two
new fields OPTIONAL, so the existing calls at `test/stateGuard.test.ts:218` and `:221` still typecheck) and gains:
`if (s.suppressedWarnedFor !== undefined) leaks.push(\`the suppressed warning already logged for ${s.suppressedWarnedFor} — a later check would not log it\`);`
and `if (s.lastFailure !== undefined) leaks.push("a failed swap remembered — a later suppressed warning would name it");`.
`test/stateGuard.test.ts`'s update-module cases gain one each for the new fields.

2d. The guard (`:254-259`): the comment's first sentence becomes "Refused before anything else — even reading the
shas. A second `/update` mid-swap would otherwise overwrite the in-flight attempt's pendingUpdateReport, then
force-remove its replacement; and a second one while an exit-75 restart is DEFERRED behind the first command's
critical section (#449) would overwrite that requester's report too, since `checkInFlight` is released in `finally`
and no handoff is active on that path — `restartPending()` is true in all three cases (a handoff, a pending exit, a
shutdown)." and the line becomes
`if (restartPending() || checkInFlight) return { decision: "busy", latestSha: "" };`.

2e. The `suppressed` branch (`:293-298`) becomes:

```ts
    if (decision === "suppressed" && suppressedWarnedFor !== latestSha) {
      // #506 item 13 / #429: once per pending sha per process (README says "once"), and with the real cause when this
      // process has one: a swap that failed names its reason; otherwise this process came back on the same build
      // after exiting for it (the exit-75 path: whatever respawned it supplied no new code) or the swap did not take
      // (#450 logs that case at boot).
      suppressedWarnedFor = latestSha;
      const why =
        lastFailure && sameSha(lastFailure.sha, latestSha)
          ? `the last attempt failed: ${lastFailure.reason}`
          : "this process came back on the same build after exiting for it (whatever respawned it did not supply new code — rebuild the image, see README), or the swap did not take";
      console.warn(
        `[update] ${shortSha(latestSha)} is still pending — ${why}. The automatic check will not retry it until a ` +
          `newer commit lands; /${prefixedName(config.commandPrefix, "update")} retries it now. Not exiting again.`,
      );
    }
```

2f. The `restart` block (`:300-312`) becomes (the path is decided first, so one save arms everything):

```ts
    if (decision === "restart") {
      // The path first, so ONE save records everything the next boot needs: the socket path writes `swapInFlight`
      // beside the two markers (#450); the exit-75 path writes only the markers, whose meaning across its respawn
      // is unchanged. Written before the replacement starts and read by it after — never by both at once, which
      // is what keeps two containers off the same state file (nazumods/wow#879).
      const viaSocket = await deps.redeployAvailable();
      state.attemptedUpdateToSha = latestSha;
      const report = buildUpdateReport({ runningSha: config.gitSha, latestSha, requester: o.requester, now: Date.now() });
      // #506 item 12: an AUTO tick (no requester) must not wipe a /update follow-up still owed — the scheduler's
      // first tick can run before reportUpdateOutcome has delivered it.
      if (report) state.pendingUpdateReport = report;
      state.swapInFlight = viaSocket ? { fromSha: config.gitSha, toSha: latestSha, startedAt: Date.now() } : undefined;
      await saveState();
      return { decision, latestSha, redeploy: await applyUpdate(latestSha, deps, viaSocket, report) };
    }
```

2g. `applyUpdate` (`:328-354`) takes `viaSocket: boolean` and `armed: PendingUpdateReport | undefined` as its third
and fourth parameters and no longer calls `deps.redeployAvailable()` itself (`:335` becomes `if (!viaSocket) {`); its
docstring's second paragraph says the caller decided the path and which report it armed. The failure tail
(`:344-353`) becomes:

```ts
  // We're still the live bot, so no restart occurred: the follow-up report THIS call armed is un-owed and would
  // otherwise describe a restart that never happened — only that one (#506 item 12: an AUTO attempt, which arms
  // none, must not wipe a /update report still owed from before this process's boot report ran) — and the swap
  // record (#450) is resolved here, not by a later boot. `attemptedUpdateToSha` stays set, though — it's what makes
  // decideUpdate suppress the NEXT scheduler tick for this same failing sha (#50) instead of rebuilding it every 15
  // minutes; an admin's /update (force: true) still bypasses it, and the suppressed warning names this failure.
  if (armed !== undefined && state.pendingUpdateReport === armed) state.pendingUpdateReport = undefined;
  state.swapInFlight = undefined;
  lastFailure = { sha: latestSha, reason: result.error ?? result.outcome ?? "failed" };
  suppressedWarnedFor = undefined; // a new failure re-explains itself once
  await saveState();
  console.warn(
    `[update] redeploy to ${shortNew} failed: ${result.error ?? result.outcome} (replacement: ${result.replacement ?? "unknown"})`,
  );
  return result;
```

(`RedeployResult.outcome` is optional, `redeploy.ts:248`, hence the second `??`; the identity check works because
`checkForUpdate` assigned the very object it passes; the no-socket branch stays as it is: `requestRestart`, return
`undefined`.)

2h. New, after `applyUpdate`:

```ts
/** What a boot makes of the swap record its previous life left (#450). */
export type AttemptResolution =
  /** No record: the two markers say the whole story (an exit-75 respawn, or nothing pending). */
  | "none"
  /** `toSha` is this build: the swap landed and this is the replacement. The record is cleared. */
  | "landed"
  /** Back on `fromSha` with a live `<name>-next` — or with a probe that could not tell: the original restarted beside a
   *  standby that is (or may be) taking over. Nothing is touched; the report is left for the new build, or for this
   *  container's next boot to resolve. */
  | "in-flight"
  /** Back on `fromSha` with no live replacement: nothing took over. The record and the attempt marker are cleared and
   *  the report says so instead of "the image wasn't rebuilt". */
  | "interrupted"
  /** Neither sha is this build (a third build, no GIT_SHA, or a record of the wrong shape): the record is cleared and
   *  the markers are left to the existing paths. */
  | "stale";

/** Pure: the verdict from the record, this build's sha and (when it matters) the probe of `<name>-next`. */
export function decideAttemptResolution(o: {
  swap?: SwapInFlight;
  runningSha?: string;
  probe?: ReplacementProbe;
}): AttemptResolution {
  if (!o.swap) return "none";
  if (!o.runningSha) return "stale";
  if (sameSha(o.swap.toSha, o.runningSha)) return "landed";
  if (!sameSha(o.swap.fromSha, o.runningSha)) return "stale";
  if (o.probe?.kind === "alive" || o.probe?.kind === "unknown") return "in-flight";
  return "interrupted";
}

/** A `swapInFlight` as written by this bot; a hand-edited or truncated one must not throw at boot. */
function isSwapInFlight(v: unknown): v is SwapInFlight {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as SwapInFlight).fromSha === "string" &&
    typeof (v as SwapInFlight).toSha === "string" &&
    typeof (v as SwapInFlight).startedAt === "number"
  );
}

/** Test seams for {@link resolveUpdateAttempt}. */
export interface ResolveAttemptDeps {
  probe?: () => Promise<ReplacementProbe>;
  log?: Pick<Console, "log" | "warn">;
}

/**
 * Resolve the swap record at boot (#450): called by `index.ts`'s `activate()` before `startScheduler`, so an
 * interrupted attempt's marker is gone before the first tick can read it and the verdict reaches
 * `reportUpdateOutcome`. The daemon is asked only in the ambiguous case (back on `fromSha`), bounded like
 * `resolveBootMode`; an ordinary boot, and the replacement's own boot, make no daemon call here. Never throws.
 */
export async function resolveUpdateAttempt(deps: ResolveAttemptDeps = {}): Promise<AttemptResolution> {
  const log = deps.log ?? console;
  const raw: unknown = state.swapInFlight;
  if (raw === undefined) return "none";
  const swap = isSwapInFlight(raw) ? raw : undefined;
  const needsProbe = !!swap && !!config.gitSha && !sameSha(swap.toSha, config.gitSha) && sameSha(swap.fromSha, config.gitSha);
  const probe = needsProbe ? await (deps.probe ?? probeReplacement)() : undefined;
  const resolution = swap ? decideAttemptResolution({ swap, runningSha: config.gitSha, probe }) : "stale";
  const target = swap ? shortSha(swap.toSha) : "an unknown build";
  if (resolution === "in-flight") {
    const seen = probe?.kind === "alive" ? `${probe.name} is ${probe.status}` : `whether ${probe?.name ?? "the replacement"} is alive could not be told: ${probe?.kind === "unknown" ? probe.error : "no probe"}`;
    log.log(`[update] the swap to ${target} this container started may be in flight (${seen}) — leaving its record, the attempt marker and its report for the new build or the next boot`);
    return resolution;
  }
  state.swapInFlight = undefined;
  if (resolution === "interrupted") {
    state.attemptedUpdateToSha = undefined;
    const seen = probe?.kind === "absent" ? "gone" : probe?.kind === "stopped" ? probe.status : "not alive";
    log.warn(`[update] the swap to ${target} this container started did not take (${probe?.name ?? "the replacement"} is ${seen}) — cleared the attempt marker, so the next check tries it again`);
  } else if (resolution === "landed") {
    log.log(`[update] the swap to ${target} landed — this is the new build; cleared its record`);
  } else {
    log.log(`[update] a swap record for ${target} belongs to another build or is malformed — cleared it`);
  }
  try {
    await saveState();
  } catch (err) {
    log.warn("[update] could not save the resolved swap record (it is resolved in memory; the next boot resolves it again)", err);
  }
  return resolution;
}
```

(Every `probe.` access above sits behind a `kind` check, so it narrows; the auditor type-checked the earlier draft
and the `in-flight` line was the one that did not.)

### Step 3 -- `src/redeploy.ts`: the probe

Above the docblock of `RollbackDeps` (the `/** Test seams for ... */` comment at `:1194`, the interface at `:1195`;
after `healOwnName`), so it sits with the other bounded boot-time daemon helpers and away from S4b's edits:

```ts
/** What `<name>-next` is, as far as a boot resolving a swap record cares (#450). */
export type ReplacementProbe =
  /** Running or restarting: a swap in flight. */
  | { kind: "alive"; name: string; status: string }
  /** Exists but will not take over by itself: exited, dead, or created and never started. */
  | { kind: "stopped"; name: string; status: string }
  | { kind: "absent"; name: string }
  /** No daemon, a timeout, or an inspect that failed: nothing can be concluded. */
  | { kind: "unknown"; name: string; error: string };

/** Test seams for {@link probeReplacement}; each defaults to the real daemon call (the `HealDeps` shape). */
export interface ProbeDeps {
  inspectSelf?: typeof inspectSelf;
  inspect?: typeof tryInspectContainer;
}

/**
 * One bounded look at this container's replacement name (#450), for `update.ts`'s `resolveUpdateAttempt`: the own
 * inspect (for the name, as `redeploy()` derives it) and one inspect by that name, together under the same bound
 * `resolveBootMode` uses. Any failure is `unknown`, never a throw. Only a boot that finds a swap record calls it,
 * so an ordinary boot still never touches the socket.
 */
export async function probeReplacement(deps: ProbeDeps = {}, timeoutMs = RESOLVE_BOOT_MODE_TIMEOUT_MS): Promise<ReplacementProbe> {
  let name = "the replacement";
  try {
    return await withTimeout(
      (async () => {
        const self = await (deps.inspectSelf ?? inspectSelf)();
        name = replacementName(self.Name, projectOf(self));
        const found = await (deps.inspect ?? tryInspectContainer)(name);
        if (!found) return { kind: "absent", name } as const;
        const status = found.State.Status;
        return found.State.Running || status === "restarting"
          ? ({ kind: "alive", name, status } as const)
          : ({ kind: "stopped", name, status } as const);
      })(),
      timeoutMs,
    );
  } catch (err) {
    return { kind: "unknown", name, error: (err as Error).message };
  }
}
```

(`projectOf` is the local helper at `:70`, used by `redeploy()` at `:303`/`:345`; `replacementName` is `:101`;
`inspectSelf` and `tryInspectContainer` are `docker.ts:166` and `:219`, and the latter accepts a name, as `:351`
already uses it; `withTimeout` and `RESOLVE_BOOT_MODE_TIMEOUT_MS` are `:1050-1066`. `update.ts` calls it with no
arguments.)

### Step 4 -- `src/updateReport.ts`

4a. `UpdateOutcome` (`:23-31`) gains, after `noop`:
`/** Came back on the sha we left on because the process restarted before the new build took over, or the swap was rolled back (#450). */ | "interrupted"`.
Import `type AttemptResolution` from `./update` (beside `sameSha`, `:4`) and `prefixedName` from `./commandNaming`.

4b. `decideUpdateOutcome` (`:33-41`) takes `resolution?: AttemptResolution` and, before the `noop` line:
`if (o.resolution === "interrupted" && sameSha(o.runningSha, o.report.fromSha)) return "interrupted";`.

4c. `updateOutcomeMessage` (`:44-71`): a `case "interrupted"` returning
`` `⚠️ Back up on \`${now}\` — the update to \`${short(report.toSha)}\` did not take: this process is back on the build it left on (it restarted before the new build had taken over, or the swap was rolled back). Run /${prefixedName(config.commandPrefix, "update")} again.` ``;
`unexpected`'s text ends `— something else deployed in between (an automatic update, or a redeploy by hand).`
(Decision 5).

4d. `reportUpdateOutcome` (`:152-179`) becomes:

```ts
/**
 * Deliver the follow-up owed from a `/update`-initiated restart, if any. `resolution` is what this boot made of the
 * swap record (`resolveUpdateAttempt`, #450): `in-flight` leaves the report in place for the new build, which is about
 * to retire this process and has the same report in its own snapshot (or for this container's next boot, when the
 * probe could not tell); `interrupted` turns a would-be `noop` into the truthful outcome.
 *
 * The marker is cleared and persisted *before* delivery is attempted: a delivery that fails must not leave a report
 * that re-fires on every subsequent boot. A save that fails is logged and delivery goes ahead anyway (#506 item 12:
 * one report beats none, at the cost of at most one repeat at the next boot). Nothing here throws.
 */
export async function reportUpdateOutcome(
  client: Client,
  resolution: AttemptResolution = "none",
  deliverers: Deliverers = liveDeliverers(client),
): Promise<void> {
  const report = state.pendingUpdateReport;
  if (!report) return;
  if (resolution === "in-flight") {
    console.log(`[updateReport] a swap to ${short(report.toSha)} may be in flight — leaving its report to the new build or the next boot`);
    return;
  }

  state.pendingUpdateReport = undefined;
  try {
    await saveState();
  } catch (err) {
    console.warn("[updateReport] could not clear the pending report before delivering it (it may repeat once at the next boot)", err);
  }

  const now = Date.now();
  if (reportTooOld(report, now)) {
    console.log(
      `[updateReport] dropping a stale report for ${short(report.toSha)} ` +
        `(requested ${Math.round((now - report.requestedAt) / 3_600_000)}h ago)`,
    );
    return;
  }

  const outcome = decideUpdateOutcome({ report, runningSha: config.gitSha, resolution });
  const content = updateOutcomeMessage(outcome, report, config.gitSha);
  const route = await deliverUpdateReport(report, content, deliverers, now);
  console.log(`[updateReport] ${outcome} (delivered via ${route}): ${content}`);
}
```

(`liveDeliverers(client)` as a default parameter is evaluated per call, only when the caller passes none.)

### Step 5 -- `src/index.ts`

5a. `:15` stays; add `import { resolveUpdateAttempt } from "./update";` (there is no `./update` import today).

5b. Inside `activate()`, DIRECTLY after the #541 guard's closing brace (`:385`), before the blank line and the #248
comment that precedes `const tickControl` (`:387-390`):

```ts
  // #450: what the previous life of this container left behind — a socket-path swap it started and never finished —
  // is resolved BEFORE the scheduler's first tick can read the attempt marker, and its verdict goes to the report
  // below. One bounded daemon call, and only when such a record exists; an ordinary boot still never touches the
  // socket. In standby this runs after takeOver, like every other state write of the replacement's.
  const attempt = await resolveUpdateAttempt();
```

5c. `:538` becomes `reportUpdateOutcome(client, attempt).catch((err) => console.error("[updateReport]", err));` and
the comment above it (`:536-537`) adds "and `attempt` is what this boot made of the swap record (#450)".

### Step 6 -- docs

Substrings to anchor on; Grep each before editing (one hit) and after (none). `CONTEXT.md`'s File Map rows are
single long lines, so anchor each Edit on the exact fragment; the Behavior and Gotchas bullets below are WRAPPED, so
anchor on one line at a time and reflow the bullet by hand.

- `CONTEXT.md:180` (the `update.ts` row), four edits:
  - old ``answering `busy` while a handoff is in flight (guard before any state write — see the gotcha)`` -> new
    ``answering `busy` while a handoff, another check or a pending restart is in flight (`restartPending() || checkInFlight`, before any state write — see the gotcha; #449)``.
  - old ``404 → `unpublished`, any other failure → `unknown`, never throws`` -> new ``a 404 → `unpublished`, unless its body says "no common ancestor", which is `diverged` (a rewritten branch: it restarts; #411); any other failure → `unknown`, never throws``.
  - old ``and, on `restart`, routing through `applyUpdate()`: a self-contained `redeploy()` when the daemon socket is mounted, else the original exit-75 fallback so a deployment on an older compose file keeps working.`` -> new ``and, on `restart`, deciding the path (`redeployAvailable()`) BEFORE the one arming save, then `applyUpdate()`: a self-contained `redeploy()` when the daemon socket is mounted, else the original exit-75 fallback so a deployment on an older compose file keeps working.`` (Grep the exact old text; the row's wording may differ by a word -- anchor on `routing through `applyUpdate()``.)
  - old ``A failed redeploy clears `attemptedUpdateToSha` + `pendingUpdateReport` again, since the restart never happened — leaving them would owe a follow-up for nothing and let the anti-loop guard suppress the next genuine attempt`` -> new ``A failed redeploy clears `swapInFlight` and the `pendingUpdateReport` this very call armed (the restart never happened, so no follow-up is owed; an owed report from before this process's boot report ran is left alone, #506) and KEEPS `attemptedUpdateToSha`, so the next unforced check is `suppressed` instead of rebuilding the same failing sha every 15 minutes (#50; `/update`'s `force` retries it), and the `suppressed` warning is logged once per pending sha per process, naming that failure (#506, #411)``.
  - and append to the row (Grep its last 40 characters for the anchor): `` `swapInFlight` is written in the arming save on the socket path only (#450), and `resolveUpdateAttempt()` (pure `decideAttemptResolution` + one bounded `probeReplacement` of `<name>-next`, `redeploy.ts`) resolves it at the next boot before the scheduler starts: `landed` (this is the new build), `in-flight` (a live `-next`, or a probe that could not tell: touch nothing), `interrupted` (clear it and the attempt marker; the report says so) or `stale` (a third build, no GIT_SHA, or a malformed record).``
- `CONTEXT.md:181` (the `update.test.ts` row): append the new tests in one clause (U1-U9 below, named by what they
  pin). `CONTEXT.md`'s `updateReport.test.ts`, `redeploy.test.ts` (`:193`), `index.test.ts` and `stateGuard.test.ts`
  rows (Grep each ``| `src/<file>` |`` / ``| `test/<file>` |``): likewise for R1-R4, the probe tests, the order pin and
  the two leak cases.
- `CONTEXT.md:156` (the `index.ts` row, which narrates `activate()`'s order): after the clause about returning when
  `isShuttingDown()` and before "then the scheduler" (Grep ``returns right after it when `isShuttingDown()``), insert
  ``, then resolves the swap record (`resolveUpdateAttempt`, #450: one bounded daemon call only when a record exists)``.
- `CONTEXT.md:182` (the `updateReport.ts` row): old ``reportUpdateOutcome(client)`` -> new
  ``reportUpdateOutcome(client, resolution?, deliverers?)`` and append `` ; `interrupted` is the fifth outcome (#450); a failing clear-save is logged, not thrown, and delivery goes ahead (at most one repeat at the next boot, #506); `in-flight` leaves the report in place; the deliverers are injectable``.
- `CONTEXT.md:194` (the `state.ts` row): old ``attemptedUpdateToSha` guards the self-update exit loop;`` -> new
  ``attemptedUpdateToSha` guards the self-update exit loop; `swapInFlight` (#450) records a socket-path swap from the arming save until `redeploy()` returns or the next boot's `resolveUpdateAttempt` resolves it (shape-checked there, never by `loadStateFrom`);``.
- `CONTEXT.md:192` (the `redeploy.ts` row): append `` ; `probeReplacement()` (#450): one bounded look at `<name>-next` for the boot's swap-record resolution``.
- `CONTEXT.md:325-326` (Behavior, wrapped): old line 325 ``  `/update` checks on demand with `force`). Stale → persist `attemptedUpdateToSha`, then exit 75`` and line 326 ``  for the orchestrator to respawn. `/update` is gated on the `ADMIN_USER_IDS` allowlist and fails`` -> the sentence becomes ``Stale → persist `attemptedUpdateToSha` (and the `/update` follow-up, and `swapInFlight` on the socket path), then `applyUpdate()`: a self-contained `redeploy()` when the daemon socket is mounted, else exit 75 for the orchestrator to respawn.`` (reflow; keep the `/update` gating sentence).
- `CONTEXT.md:330` (Update follow-up): old ``the build it actually came back on — `updated` / `noop` / `unexpected` named explicitly, since`` -> new ``the build it actually came back on — `updated` / `noop` / `interrupted` / `unexpected` named explicitly (#450: a boot that finds a socket-path swap it started and never finished, with no live `<name>-next`, says `interrupted` and clears the attempt marker instead of calling it a no-op; one that finds the `-next` alive, or cannot tell, leaves the report for the new build or the next boot), since`` (reflow).
- `CONTEXT.md:1095` (the busy gotcha's last line, ``  `pendingUpdateReport` and then force-remove its replacement.``): append `` Since #449 the guard is `restartPending() || checkInFlight`: a pending exit-75 restart (the no-socket path, deferred behind the command's own critical section) refuses a second `/update` too, which used to overwrite the first requester's `pendingUpdateReport`.`` And the next bullet (`:1096-...`, "**The guard is two flags, not one (#51 item 4).** `handoffActive()` alone doesn't read true until ..."): old ``**The guard is two flags, not one (#51 item 4).** `handoffActive()` alone`` -> new ``**The guard is two flags, not one (#51 item 4; the first is `restartPending()` since #449).** `handoffActive()` alone`` (read the bullet and keep it true: `checkInFlight` still covers the stretch before a handoff begins).
- `CONTEXT.md:1190` (``  bot has exited for a sha and come back unchanged, it warns instead of exiting again.``): old ``it warns instead of exiting again.`` -> new ``it warns once per pending sha per process — naming the failed swap when there was one (#506 item 13) — instead of exiting again.``
- `CONTEXT.md:1204` (``  own `ShaRelation` (`unpublished`) and resolves to `disabled` naming the sha — so such a deploy``): after ``(`unpublished`)`` insert `` — a 404 whose body says "no common ancestor" is `diverged` instead, a rewritten branch, which restarts (#411) —``.
- `CONTEXT.md:1212` (``  `startScheduler` and doesn't await it: an owed follow-up must never delay or crash startup.``): append `` A save that fails there is logged and the report is delivered anyway (#506 item 12: "nothing here throws" was false; the cost is at most one repeat at the next boot, since the disk then still holds the report). `resolveUpdateAttempt()` runs before `startScheduler` (#450), so an interrupted attempt's marker is cleared before the first tick can read it and its verdict reaches `reportUpdateOutcome`; a swap still in flight — or one whose `-next` the daemon could not be asked about — leaves the report in place for the new build or the next boot (the record then stays until that boot; `/update` does not read it).``
- `README.md:106`: old ``which of three things happened:`` -> new ``which of five things happened:``; after line 109 (the `❓ **unexpected**` bullet) insert
  ``  - ⚠️ **interrupted** — came back on the same build because the process restarted before the new build had taken over (a reboot, an OOM kill, a `bot-ops.sh restart` or the panel's Restart during the build), or because the swap was rolled back; nothing changed, and the next `/update` or automatic check tries again. If a stopped `<name>-next` was left behind, the next update removes it. (If the bot cannot ask the daemon whether a `<name>-next` is still alive, it keeps the report for its next start instead of guessing.)``
  and ``  - ❓ **unknown** — came back with no `GIT_SHA` baked in, so it cannot tell.``
- `README.md:112`: old ``it says so once in the log and **stops trying**`` -> new ``it says so once per pending build in the log (per process: a restart says it again once; naming the failed swap when there was one) and **stops trying**``.
- `docs/plans/epics/E516/525-handoff-state-table.md`: one `**D1a:**` note at the end of the "Recovered by" cell of
  rows 5, 8, 10, 11, 28 and 30 (anchor each on the cell's last words; the rows are single lines): row 5 "the busy
  guard now reads `restartPending()`, so the second `/update` is refused"; rows 8 and 11 "the boot finds
  `swapInFlight` with no live `-next`, reports `interrupted`, clears A and P (P after delivery); row 11's `created`
  leftover is `stopped` to the probe; a daemon that cannot be asked leaves all three for the next boot"; row 10 "O'
  finds `swapInFlight` and a RUNNING `-next`: it touches nothing and leaves the report to R"; row 28 "a rejecting save
  is logged and delivery goes ahead; an AUTO `restart` no longer assigns `undefined` to P, and an AUTO swap's failure
  no longer clears it"; row 30 "the `suppressed` line is logged once per pending sha per process and names the failed
  swap".

### Step 7 -- tests

Helpers shared by the new `update.test.ts` tests: `readFileSync` and `join` (import at the top), `DATA_DIR` from
`./storage` (the test override, as `announce.test.ts:36` reads it), `const onDisk = () => JSON.parse(readFileSync(join(DATA_DIR, "state.json"), "utf8"))`,
a parameterised `stubGitHub(latest = NEW)` (the file has two copies, `:256-267` and `:331-342`; one shared helper
taking the sha), `setExitFn` (its RETURN value restores `exitFn`; `resetForTest` does not), `resetForTest as
resetRestartForTest`, `restartPending`, `withCritical`, `RESTART_EXIT_CODE` from `./restart`. The two existing
`afterEach` blocks (`:245-254`, `:323-329`) gain `resetUpdateForTest();` (Decision 6). Every new test restores
`config.gitSha`, the three state keys (A, P, `swapInFlight`: `delete`/`= undefined` then `await saveState()` when the
test wrote the file), calls `resetUpdateForTest()`/`resetRestartForTest()` and the `setExitFn` restore in `finally`;
the test-state guard fails the one that does not. The requester fixture:
`{ userId: "42", channelId: "100", applicationId: "999", interactionToken: "tok" }`.

**`src/update.test.ts`.**

- **U1 (`decideAttemptResolution`, pure):** a `describe("decideAttemptResolution (#450)")` with one `test` per row:
  no swap -> `none`; no running sha -> `stale`; `toSha` running -> `landed` (also with a short running sha);
  `fromSha` running + probe `alive` (`status: "running"` and `"restarting"`) -> `in-flight`; `fromSha` running + probe
  `unknown` -> `in-flight`; `fromSha` running + probe `stopped` (`"exited"`, `"created"`, `"dead"`), `absent`, and no
  probe at all -> `interrupted`; neither sha -> `stale`; `toSha` running with a probe `alive` -> `landed` (the sha
  check wins before the probe is read).
- **U2 (#452, #450: on disk before `redeploy`, cleared after):** `config.gitSha = OLD`, `stubGitHub()`, a requester;
  `deps.redeployAvailable: async () => true`; `deps.redeploy: async () => { seenOnDisk = onDisk(); return { outcome: "failed", error: "boom" }; }`.
  Assert `seenOnDisk.attemptedUpdateToSha === NEW`, `seenOnDisk.pendingUpdateReport` equals the requester plus
  `fromSha: OLD, toSha: NEW` and a numeric `requestedAt`, `seenOnDisk.swapInFlight` has `fromSha: OLD, toSha: NEW` and a
  numeric `startedAt`; after the call `onDisk().pendingUpdateReport` and `.swapInFlight` are absent and
  `.attemptedUpdateToSha === NEW`; `updateStateForTest().lastFailure` equals `{ sha: NEW, reason: "boom" }`.
- **U3 (#452: the no-socket branch) and U6 (#449: the guard reads a pending restart):** in one test, inside
  `withCritical(async () => { ... })` so the exit is deferred: `const restoreExit = setExitFn((c) => exits.push(c))`;
  `deps.redeployAvailable: async () => false`, `deps.redeploy` throws if called; first call with requester A ->
  `decision "restart"`, `redeploy` undefined, `restartPending()` true, `exits` empty (deferred), on disk A = NEW, P =
  requester A, no `swapInFlight`; second call `{ force: true, requester: B }` -> `decision "busy"`, on disk P still
  requester A; then outside the section `exits` is `[RESTART_EXIT_CODE]` (the section closing exits into the stub).
  `resetRestartForTest()` and `restoreExit()` in `finally`.
- **U4 (#452: `current` clears A on disk):** `config.gitSha = NEW`, `state.attemptedUpdateToSha = NEW; await saveState()`,
  `stubGitHub()` -> `current`; `state.attemptedUpdateToSha` undefined and `onDisk().attemptedUpdateToSha` absent.
- **U5 (#452: a thrown fetch releases the latch):** `fetch` rejects -> `checkForUpdate()` rejects with that error;
  `updateStateForTest().checkInFlight` false; a second call (fetch stubbed good, `config.gitSha = NEW`) answers `current`,
  not `busy`.
- **U7 (#506 item 12: an AUTO attempt neither overwrites nor wipes an owed report):** `state.pendingUpdateReport =
  owed` (a report for another sha pair), no requester, `deps` failing as in U2 -> during `redeploy`,
  `onDisk().pendingUpdateReport` equals `owed`, A and `swapInFlight` armed; AFTER the failed redeploy
  `state.pendingUpdateReport` still equals `owed` in memory and on disk (the failure tail cleared only what it armed,
  which was nothing), `swapInFlight` absent. And the complement in U2: the `/update` call's own report IS cleared
  after its failure.
- **U8 (#506 item 13, #429: once per sha, naming the failure):** a `console.warn` spy; U2's failing first call, then
  two unforced calls -> both `suppressed`; the warn calls whose first argument starts `[update] ` and contains
  `still pending` are exactly ONE, and it contains `the last attempt failed: boom`, `/update` (the prefix is empty in
  this process, `config.commandPrefix`), and `Not exiting again`; then a SECOND failing forced call with
  `error: "boom again"` followed by an unforced one -> one more such warn containing `boom again` (the once-guard was
  reset by the new failure); then `const NEWER = "c".repeat(40)`: `stubGitHub(NEWER)` with A = NEWER already set
  (`state.attemptedUpdateToSha = NEWER`) -> one more such warn, for NEWER, WITHOUT `the last attempt failed` (no
  failure recorded for it) and containing `came back on the same build`; `updateStateForTest().suppressedWarnedFor === NEWER`;
  `resetUpdateForTest()` clears it and `lastFailure`.
- **U9 (`resolveUpdateAttempt`):** a `describe("resolveUpdateAttempt (#450)")`, each test seeding
  `state.swapInFlight` (and A = NEW, P = report(owed)) in memory AND on disk (`await saveState()`), with a recording
  `probe` seam and a quiet `log` seam:
  - `config.gitSha = NEW` (landed): resolves `landed`, the probe is NOT called, `swapInFlight` undefined in memory and
    absent on disk, A and P untouched.
  - `config.gitSha = OLD`, probe `{ kind: "alive", name: "bot-next", status: "running" }`: `in-flight`, nothing
    changed in memory or on disk (compare `onDisk()` before and after), the log line names `bot-next`.
  - probe `{ kind: "unknown", name: "bot-next", error: "timed out after 10000ms" }`: `in-flight` too, nothing changed
    in memory or on disk, the log line contains `could not be told` and the error.
  - probe `stopped` (`"exited"`), then separately `absent`: `interrupted`, `swapInFlight` and A cleared in memory and on
    disk, P still there (memory and disk), the warn line says `cleared the attempt marker`.
  - `config.gitSha = "d".repeat(40)` (a third build): `stale`, probe not called, `swapInFlight` cleared, A and P untouched.
  - `config.gitSha = ""`: `stale`, probe not called.
  - a malformed record (`state.swapInFlight = { toSha: 5 } as never`): `stale`, probe not called, cleared, no throw.
  - no record: `none`, no save (spy `Bun.write` and assert not called).
  - a rejecting save (`spyOn(Bun, "write")` rejecting, as `announce.test.ts:698` does): still returns
    `interrupted` and does not throw; the warn says `could not save the resolved swap record`.
- The compare URL test (`:205-213`): add `expect(seen).toContain("?per_page=1")`.

**`src/updateReport.test.ts`** (imports to add: `config` from `./config`, `state`, `saveState` from `./state`,
`DATA_DIR` from `./storage`, `readFileSync`/`join`; the `REST` class from `discord.js`).

- **R1:** `decideUpdateOutcome` with `resolution: "interrupted"` and running `FROM` -> `interrupted`; with
  `"interrupted"` and running `TO` -> `updated`; with `"interrupted"` and running `THIRD` -> `unexpected` (the
  `fromSha` leg); with `"none"`/`"landed"`/`"stale"` and running `FROM` -> `noop` (unchanged). `updateOutcomeMessage`:
  the distinct-text test's set size becomes 5; a new test pins that `interrupted` names `TO` and `now`, contains
  `did not take` and `/update`, and does NOT contain `wasn't rebuilt`; `unexpected` contains `automatic update`.
- **R2 (`reportUpdateOutcome`, in-flight):** `state.pendingUpdateReport = report()`, a `console.log` spy, deliverers
  whose every route throws if called: `await reportUpdateOutcome({} as Client, "in-flight", deliverers)` ->
  `state.pendingUpdateReport` still the report, no deliverer called, the log line contains `in flight`.
- **R3 (`reportUpdateOutcome`, clear-before-deliver and the failing save):** `config.gitSha = TO`,
  `state.pendingUpdateReport = report({ requestedAt: Date.now() }); await saveState()` (ON DISK, or the
  clear-before-deliver mutant survives), deliverers whose `viaToken` records `onDisk().pendingUpdateReport` AND
  `state.pendingUpdateReport` at the moment it is called and resolves: after the call both recorded values are
  `undefined` (cleared in memory and on disk BEFORE delivery) and the log line says `updated (delivered via token)`.
  Then the same with `spyOn(Bun, "write")` rejecting (`disk full`): the call resolves (does not throw), `viaToken` was
  still called once, and a `console.warn` spy saw `could not clear the pending report before delivering it`. And with
  `resolution: "interrupted"` and `config.gitSha = FROM`: the delivered `content` starts `⚠️ Back up on` and contains
  `did not take`.
- **R4 (#452: `viaToken` and `viaDm`):** `viaDm`: a fake client `{ users: { fetch: async (id) => ({ send: async (c) => sends.push([id, c]) }) } }`
  -> `sends` is `[["42", "hi"]]`. `viaToken`: `spyOn(REST.prototype, "post")` resolving `{}` -> called once with
  `"/webhooks/999/tok"` and an options object whose `body` is `{ content: "hi", flags: 64, allowed_mentions: { parse: [] } }`
  and whose `auth` is `false`; `mockRestore` in `finally`. Two tests, so M19a/M19b each have one.

**`src/index.test.ts`** (the source-order pins, same shape as the #541 test at `:91-116`): inside `activate(`, the
index of `const attempt = await resolveUpdateAttempt();` is after the index of `if (isShuttingDown()) {` and before
the index of `firstTick = startScheduler(`; and the source contains `reportUpdateOutcome(client, attempt)` exactly
once and `reportUpdateOutcome(client)` never.

**`src/redeploy.test.ts`** (`probeReplacement` through `ProbeDeps`, the `healOwnName` pattern at `:2836-2868`): self
named `/bot` with the compose labels the fixtures use, `-next` running -> `alive`/`running` and `name === "bot-next"`
(or whatever `replacementName` yields for that fixture -- read it); status `restarting` with `Running: false` ->
`alive`; `exited` -> `stopped`; `created` -> `stopped`; `inspect` returns `undefined` -> `absent` (named); `inspectSelf`
throws -> `unknown` naming `the replacement`; a never-resolving `inspect` with `timeoutMs: 20` -> `unknown` with
`timed out`.

**`test/stateGuard.test.ts`:** the update module's leak cases gain the two new fields (one case each: set, expect the
line; unset, expect none).

### Mutation table (run in a scratch worktree, never in the shared tree)

Commit the work in progress first, then:

```bash
git -C /s/repos/rackbops-discord-bot worktree add --detach /s/Repos/_wt/rdb-526-D1a-mut fix/526-D1a-attempt-record
cd /s/Repos/_wt/rdb-526-D1a-mut && bun install --frozen-lockfile
```

Apply one mutation at a time there (with the Edit tool), run
`bun test src/update.test.ts src/updateReport.test.ts src/index.test.ts src/redeploy.test.ts test/stateGuard.test.ts src/commandNaming.test.ts`,
record the failing test, revert (`git -C /s/Repos/_wt/rdb-526-D1a-mut checkout -- .`), next; remove the worktree at
the end.

| # | Mutation (production line, after the steps) | Test that must fail |
|---|---|---|
| M1 | 2f: `state.swapInFlight = viaSocket ? {...} : undefined` -> `= undefined` | U2 (not on disk before `redeploy`) |
| M2 | 2g: delete `state.swapInFlight = undefined;` | U2 (still on disk after the failed redeploy) |
| M3 | 2g: add `state.attemptedUpdateToSha = undefined;` | the existing #50 test (`update.test.ts:273-295`) and U2 |
| M4 | 2d: `restartPending() \|\| checkInFlight` -> `handoffActive() \|\| checkInFlight` (re-import it) | U6 (the second call decides `restart` and overwrites P) |
| M5 | 2f: `if (report) state.pendingUpdateReport = report;` -> `state.pendingUpdateReport = report;` | U7 (P is `undefined` on disk during `redeploy`) |
| M5b | 2g: `if (armed !== undefined && state.pendingUpdateReport === armed)` -> unconditional clear | U7 (the owed report is gone after the failure) |
| M6 | 2e: drop `&& suppressedWarnedFor !== latestSha` | U8 (two warns for NEW) |
| M7 | 2e: `why` is always the second string | U8 (no `the last attempt failed: boom`) |
| M7b | 2g: delete `suppressedWarnedFor = undefined;` | U8 (no `boom again` warn) |
| M8 | 2h `decideAttemptResolution`: delete the `landed` line | U1; U9's landed case (the resolution is `stale`: the record is cleared the same way, so pin the RETURN VALUE, and U1 pins the row) |
| M9 | 2h: `o.probe?.kind === "alive" \|\| o.probe?.kind === "unknown"` -> drop the `alive` leg | U1; U9's alive case (disk changes) |
| M9b | 2h: drop the `unknown` leg | U1; U9's unknown case (A cleared, P consumed) |
| M10 | 2h `resolveUpdateAttempt`: `isSwapInFlight` check dropped | U9's malformed case (a throw) |
| M11 | 2h: delete the `await saveState()` in `resolveUpdateAttempt` | U9 (disk still has the record) |
| M12 | 4d: move `state.pendingUpdateReport = undefined; await saveState()` below `deliverUpdateReport` | R3 (the deliverer sees P in memory and on disk) |
| M13 | 4d: drop the try/catch around the save | R3's rejecting-save case (throws) |
| M14 | 4b: delete the `interrupted` line | R1; R3's interrupted case (`noop` text) |
| M14b | 4b: drop `&& sameSha(o.runningSha, o.report.fromSha)` | R1's THIRD case (`interrupted` instead of `unexpected`) |
| M15 | 4d: delete the `in-flight` early return | R2 (P consumed, a deliverer called) |
| M16 | 5b/5c: move `resolveUpdateAttempt()` below `startScheduler(` | index.test.ts's order pin |
| M17 | 2b: drop `?per_page=1` | the compare URL test |
| M18 | 4c: `interrupted` returns the `noop` text | R1 (`wasn't rebuilt` present; set size 4) |
| M19a | `viaDm`: `user.send` not called | R4's viaDm test |
| M19b | `viaToken`: `auth: true` | R4's viaToken test |
| M20 | 2f: `const viaSocket = await deps.redeployAvailable();` -> `= true` (the no-socket path writes a record and never exits) | U3 (`swapInFlight` on disk; `redeploy` throws) |
| M21 | step 3: `status === "restarting"` dropped | redeploy.test.ts's restarting case |
| M22 | 2c/`updateLeaks`: the `suppressedWarnedFor` line deleted | test/stateGuard.test.ts's new case |
| M23 | `:287-291`: delete the `current` clear of A (and, separately, only its `saveState`) | U4 (memory; then disk) |
| M24 | `:315-317`: `finally { checkInFlight = false }` -> release only on the normal return | U5 (the second call answers `busy`) |

### Coverage table

| Bullet (the issue's observable outcome) | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| #450: a boot after a death mid-swap reports `interrupted`, not `noop`, and the automatic check retries | 1, 2f-2h, 3, 4, 5 | U1, U2, U9, R1, R3, index pin, redeploy probe tests | M1, M2, M8-M11, M14, M16, M18, M20, M21 |
| #450: a boot beside a live `-next`, or one that cannot ask, touches nothing and leaves the report | 2h, 4d | U9's alive and unknown cases, R2 | M9, M9b, M15 |
| #449 (guard): a second `/update` during a deferred exit-75 restart is refused and the first report survives | 2d | U6 | M4 |
| #452: P and A are on disk before `redeploy`; P cleared after a failure; A cleared on `current`; the no-socket branch; a thrown fetch releases the latch; `reportUpdateOutcome` clears before delivering; `viaToken`/`viaDm` | 2f, 2g, 4d | U2, U3, U4, U5, R3, R4 | M1-M3, M12, M13, M19a, M19b, M20, M23, M24 |
| #506-12: a rejecting save does not stop delivery; an AUTO attempt neither overwrites nor wipes an owed report | 2f, 2g, 4d | R3, U7 | M5, M5b, M13 |
| #506-13: the suppressed warning is logged once per pending sha per process and names the failure, re-explaining a new one; the compare payload is bounded; `CONTEXT.md` stops describing exit 75 as the mechanism | 2b, 2c, 2e, 2g, 6 | U8, compare URL test (+ docs by the lens-B audit) | M6, M7, M7b, M17, M22 |
| #411: the File Map says what a failed redeploy clears and keeps, and that a "no common ancestor" 404 is `diverged` | 6 | (docs; the lens-B audit walks them against `update.ts`) | -- |
| #429: README's "once" is true | 2e, 6 | U8 | M6 |

### Verification (run from the worktree root; paste real output in the PR)

```bash
bun install --frozen-lockfile
cd ops/admin && bun install --frozen-lockfile && cd ../..
bun run check
bunx tsc --noEmit -p ops/tsconfig.json
cd ops/admin && bun run check && cd ../..
bun test src/update.test.ts src/updateReport.test.ts src/index.test.ts src/redeploy.test.ts src/state.test.ts src/commandNaming.test.ts test/stateGuard.test.ts
bun test --randomize src/update.test.ts src/updateReport.test.ts
bun test
```

- `commandNaming.test.ts` is in the list on purpose: the new texts name `/update` through `prefixedName`; a bare
  one fails that scan.
- The full `bun test` is slow on this box (the `ops/` subprocess tests, about 8 minutes): run it in the background
  and paste its tail.
- Not verifiable here, name it in the PR: the daemon probe against a real `-next` (no Docker on this box), and the
  `in-flight` limit (a standby that dies after the probe saw it alive leaves the record until the next boot). The
  on-daemon check is roshne's, batched with the #548 steps: a `docker stop <name>` during a `/update` build,
  `docker start <name>`, and the log plus the DM say the update did not take.

### Acceptance to paste per issue

- **#450:** U1, U2, U9 and R1-R3 pass lines; M8, M9b, M10 and M14 failing output; the new `interrupted` message text;
  the log lines from U9's interrupted, in-flight and unknown cases.
- **#449 (the guard half):** U6's pass line and M4's failing output; note that the busy text is D1b's.
- **#452:** U2-U5, R3, R4 pass lines; M1, M3, M12, M19a, M20, M23, M24 failing output (each names the line the issue said was unguarded).
- **#411:** the four `CONTEXT.md:180` fragments and the `:1204` fragment, before and after.
- **#429:** U8's pass line, M6's failing output, the new `README.md:112` sentence.
- **#506 (items 12 and 13 only):** U7 and R3's rejecting-save case, M5, M5b and M13; U8 and M7, M7b; the compare URL
  test; the new `CONTEXT.md:325-326` sentence. Comment on #506 naming the PR and the two items, and that 10, 11 and
  14 remain.

### PR

- Title: `fix(update): record a socket-path swap and resolve it at boot, refuse a second /update while a restart is pending, keep an owed report through an AUTO attempt, warn once per suppressed sha, and pin the report's persistence (#450, #449, #452, #506, #411, #429)`.
- Body: one line per item, Decisions 1-8, the typecheck + test output, the mutation table, the on-daemon step and
  the `in-flight` limit named as not verified here, and the merge order with D1b. End with `Closes #450. Closes #452.
  Closes #411. Closes #429.` on their own lines; name #449 as "Part of #449 (the guard; the busy text is PR <D1b's>)"
  and #506 as "Part of #506 (items 12 and 13)".
- After merge: tick #450, #452, #411 and #429 on #526 (byte-exact; the body is CRLF); comment on #506; #449 is
  ticked when D1b has merged too.

### Out of scope, on purpose

- The busy reply's text, the `/update` reply's clamp and its DM fallback: D1b.
- #505 items 1, 2, 4 and 6 (the ping-blip exit, the AUTO-path notification, `unknown` on the unforced path, `force`
  over `unpublished`): a later bundle on the same files, after this one lands.
- #506 items 10, 11 and 14 and #507, #558 (the replacement's stale snapshot and the rollback re-arm; the rollback
  case of the `interrupted` message above is #558's to refine): the next bundle, D2, on `redeploy.ts`/`handoff.ts`;
  it will reuse `swapInFlight`'s shape if it needs more state.
- A live re-resolve of an `in-flight` record after the standby's verify deadline (Decision 2's known limit).
- Recording a second `/update`'s requester as an extra recipient (Decision 7).
