# #515 -- the self-update handoff state table

Part of Epic #516, sub-epic #525. Issue #515 is a read-only review: no code or behaviour changes in this
file's PR. Written by Subordinate #3 for the orchestrator on 2026-10-15 against `origin/main` @ `c783ad0`
(`c783ad05df4cd2ee2032c381edb3565786960cb6`). Every `file:line` below was read at that sha. The review that
filed the findings read `4ff8eef`; since then `redeploy.ts`, `handoff.ts`, `updateReport.ts`, `restart.ts`,
`docker.ts`, `shutdown.ts` and `docker-compose.yml` have no commit, `update.ts`/`state.ts`/`github.ts` gained
only test hooks (`f5e7bd7`), and `index.ts`, `announce.ts`, `commands.ts` and `ops/bot-ops.sh` moved, so line
numbers quoted in the issue bodies are stale for those four. An independent claims-vs-code audit ran against this
file's first commit; its findings and what was done with each are in the PR body. Bundle S1 of #525 (the
original's verdict on the swap) later changed the code rows 14, 15 and 26 describe; those rows carry the change,
and every other row, and the "Interactions" text, still describes `c783ad0`.

## What was checked, and how

Read in full: `src/update.ts`, `redeploy.ts`, `handoff.ts`, `updateReport.ts`, `restart.ts`, `docker.ts`,
`shutdown.ts`, `state.ts`, `index.ts`, `docker-compose.yml`; the self-update guard, the config-dir lock, `restart`,
`recreate` and `env-set` in `ops/bot-ops.sh`; the tick path in `src/announce.ts` and the `/update` handler and
reply in `src/commands.ts`; the four review reports (`redeploy`, `self-update-handoff`, `docker-restart`,
`ops-bot-ops-sh`) and `SUMMARY.md`'s Completeness section; issues #431, #433, #450, #451, #490, #473, #512 and the
sub-epic bodies #525, #526, #531.

Evidence tags used in the table:

- Unmarked = read in the cited code at `c783ad0`.
- **[probe]** = executed on this box. Three probes, below.
- **[D]** = depends on Docker or compose behaviour that nothing here executed (there is no `docker` on this box):
  what restarts after a crash, a reboot or an explicit `docker stop`, what state a container is left in under
  restart policy `no`, and how `docker compose` treats a second container that carries the service's labels. The
  code's own comments (`redeploy.ts:455-457`, `:704-713`; `bot-ops.sh:339-387` at `c783ad0`) are the source for what the code
  assumes.
- **[inferred]** = a reading of how two code paths interleave; not executed.

Probe 1, the bot-ops guard's truth table. `guard_no_handoff_in_progress` (`ops/bot-ops.sh:388-393`) was cut out
of the script and run against a fake `docker` whose `ps -a` is state-blind (as the real `ps -a` is) and whose
`ps` shows the canonical name only when told to:

```
-next absent                 -> ALLOWED  (canonical running or not)
-next created/running/exited -> REFUSED  when the canonical name is running
-next created/running/exited -> ALLOWED  when the canonical name is not running
```

So the guard keys on the EXISTENCE of `<N>-next` in any state, never on whether it is running. That is what
makes an exited leftover a wedge (at `c783ad0`; since S3b-1 the guard keys on the state, and `ops/bot-ops.test.ts` pins that against the real script). The fake does not prove Docker's `ps -a --filter name=` semantics; that part is
[D].

Probe 2, `Date.parse("2026-10-08T12:00:00.123456789Z")` on this box's Bun 1.4.2 (the version `package.json:6`
pins) returns `1791460800123`, a number. That answers the open question in the `redeploy` and `docker-restart`
reports: the generation guard at `redeploy.ts:359-373` compares real numbers for a nanosecond `StartedAt`.

Probe 3, an `async` timer callback that rejects, on the same Bun: `setTimeout(async () => { await
Promise.reject(new Error("x")) }, 10)` ends the process with exit 1 and prints the error. So an unhandled
rejection in an async callback ends the bot's process; it does not leave it running.

## Vocabulary

- **O** = the original container and its bot process. **R** = the standby/replacement container, named
  `<N>-next`, where `<N>` is the canonical name (`container_name`, `docker-compose.yml:31`). **Corpse** = O,
  stopped but not removed. **O'** = O restarted in place by Docker.
- **A** = `state.attemptedUpdateToSha`. **P** = `state.pendingUpdateReport` (set only when `/update` supplied a
  requester). "Armed" = A (and P) saved to `state.json` at `update.ts:309`.
- **marker** = `handoff.json` in the shared `state:/app/data` volume (`handoff.ts:47`).
- **guard** = `guard_no_handoff_in_progress`: `restart`, `recreate` and `env-set` die when a container named
  `<N>-next` exists in any state AND `<N>` is running (`bot-ops.sh:388-393` at `c783ad0`, probe 1). Since bundle S3b-1 (#490) it reads the `-next` container's state instead and refuses only an ALIVE one (running, restarting, paused, removing or created); an exited or dead one is a leftover that blocks nothing, and the message says *in progress* when `<N>` runs and *finishing* when it does not. Only `bot-ops.sh` checks
  this; a grep of the non-test, non-doc tree finds no other `-next` check, so a plain `docker compose up -d` or a
  Dockge restart has no guard.
- **`.env` and the lock.** The swap never writes `.env` (R is built from O's container env,
  `redeploy.ts:153-159`) and never takes the config-dir lock (`bot-ops.sh:403-409`; only `bot-ops.sh` runs take
  it). So the `.env`/lock part of column 7 reads "untouched, free" unless a row says otherwise.
- "Point of no return" = `stopContainer(O)` inside `retireOriginal` (`redeploy.ts:485-504`). **Amended by S3a
  (#548, #490 items 5, 7 and 9):** the stop is no longer the point of no return. O is stopped at R's login and
  KEPT; the point of no return is now `completeTakeOver`'s removal, after R's `activate()` has returned and its
  first tick has settled (60 s cap). Until then O is a corpse that `docker start <N>` revives, and R steps aside
  when it finds O running. The rows below are as read at `c783ad0`; each row S3a changes carries an **S3a:** note.

Deadlines that matter: poll 2 s (`redeploy.ts:42`); every daemon call 60 s (`docker.ts:38`); build 15 min
(`docker.ts:40`); O waits 120 s for a verdict (`handoff.ts:26`, `:128`); R's verify timer 90 s (`handoff.ts:30`,
armed at `index.ts:467`); O waits 180 s after `ready` (`handoff.ts:43`); O's SIGTERM drain 8 s
(`shutdown.ts:34`) inside `docker stop`'s 10 s (`docker.ts:248`); tick watchdog 5 min (`announce.ts:149`); tick
60 s (`announce.ts:24`); AUTO poll gap 15 min (`announce.ts:32`); bot-ops lock wait 60 s (`bot-ops.sh:402`).

## The path, in order

1. **Decide.** `checkForUpdate` (`update.ts:249-275`): busy latch, GitHub newest sha, compare, `decideUpdate`.
2. **Arm.** `restart` decision: A and P set in memory and saved (`update.ts:299-309`) BEFORE any daemon work.
3. **Socket check.** `applyUpdate` -> `redeployAvailable()` (`update.ts:334`). False -> exit-75 fallback (rows 4-5).
4. **Build.** `buildImage` at the exact compared sha (`redeploy.ts:228-239`). The scheduler is not quiesced yet.
5. **Create the standby.** `beginHandoff` (`:260`), leftover sweep (`:263`), create with `RestartPolicy: no`
   (`:184`, `:264-267`), start (`:268`).
6. **Wait.** O polls the marker and R's container state every 2 s (`awaitHandoff`, `:398-418`).
7. **R boots.** Loads `state.json` at import (`state.ts:41`), plugin index, `resolveBootMode`, logs in; the 90 s
   verify timer is armed at `index.ts`'s module top, before the plugin index and `resolveBootMode` (**S3b-2**, #492: it used to be armed after them; `state.ts`'s import-time load still runs first) (`index.ts:69-128`, `:467-481`).
8. **R verifies and takes over.** `ClientReady` clears the timer and runs `takeOver` (`index.ts:130-138`):
   write `ready` (`redeploy.ts:621`), tag `:latest` (`:628`), restore the original restart policy (`:639`),
   `retireOriginal(O)` (`:640`: inspect, stop, remove, rename), clear the marker (`:641`). **S3a:** `takeOver` no
   longer tags, removes or renames: it writes `ready`, restores the policy, STOPS O (`retireOriginal`) and clears
   the marker. After `activate()` returns and the first tick settles (60 s cap) `finishProbation` runs
   `completeTakeOver`: tag `:latest`, remove O, take its name; a RUNNING O there, or at a re-entrant standby boot
   (`detectRollback`), is a rollback and R `stepAside()`s.
9. **O is stopped.** SIGTERM drain (<= 8 s), dispose, destroy, `exit(0)` (`shutdown.ts:104-143`). Its
   `redeploy()` never returns.
10. **R reports.** `activate()` then `reportUpdateOutcome` (`index.ts:138`, `:446`; `updateReport.ts:156-176`).

The exit-75 fallback is rows 4-5. The AUTO_UPDATE tick path is row 30 and the AUTO notes in rows 6-8.

## The table

Columns 3-7 are the state left behind at that instant. Rows are in path order, grouped by phase.

### A. Decide and arm

| # | Failure point | original (O) | standby (R) | handoff.json | state.json (A, P) | `-next` / guard / `.env` / lock | Recovered by, or WEDGES | Covered by |
|---|---|---|---|---|---|---|---|---|
| 0 | *Reference: no failure.* The swap lands (`redeploy.ts:621-641`, `index.ts:137-138`) | stopped by R (SIGTERM, drain <= 8 s, `exit(0)`; an explicit stop is exempt from `unless-stopped`, `redeploy.ts:455-457` [D]), then removed (**S3a:** by `completeTakeOver`, after R's probation, not at `takeOver`) | live, renamed `<N>`, policy = O's original name | absent (R clears it, `:641`) | A cleared by the first check that decides `current` (`update.ts:286-290`; needs AUTO_UPDATE or a `/update`). P consumed, saved before delivery (`updateReport.ts:160-161`) | `-next` gone after the rename; `:latest` now names R's sha tag (`:628`; **S3a:** tagged by `completeTakeOver` after probation, not at `takeOver`); `.env` untouched, lock free | -- | -- |
| 1 | GitHub unreachable: `fetchLatestBotSha` throws (`update.ts:263`, throws at `:122-130`) | running, not quiesced | none | absent | unchanged (nothing is written before `update.ts:309`) | none; guard allows; `checkInFlight` released in `finally` (`update.ts:314-316`) | Nothing to recover. AUTO: the next poll, 15 min later (`lastUpdatePollAt` is stamped before the call, `announce.ts:310`). `/update`: "Update check failed" (`commands.ts:127-129`) | n/a (nothing left behind) |
| 2 | The compare call fails and is swallowed as `unknown` (rate limit, 5xx, 10 s timeout: `update.ts:166-168`, `:181-183`). `decideUpdate` reads `unknown` as stale (`:84-88`), so a current or AHEAD build enters row 3 | running | none yet | absent | armed by row 3 | as row 3 | Nothing detects it. If the swap lands it targets the main tip, which can be OLDER than the running build; R then reads `current` and clears A, so nothing reverts it (`github.ts:23-31`) | #505 (self-update-handoff-4) |
| 3 | `saveState()` rejects at `update.ts:309` (full or read-only volume) after A and P were set in memory (`:300-308`) | running; memory armed, disk old | none | absent | disk: old values. Memory: armed | none; guard allows | The error reaches the caller (`/update` reply, `commands.ts:127-129`; tick log, `announce.ts:125`) and no swap starts. In memory A suppresses unforced ticks (`update.ts:87`) until a restart reloads the disk copy or `/update` (force) runs | n/a (not a wedge; a volume that cannot be written fails every other write too) |
| 4 | `redeployAvailable()` is false (`update.ts:334-338`): the socket is not mounted (the documented fallback), OR it is mounted and `/_ping` errored or timed out (`docker.ts:114-120` turns any error into false). `requestRestart` defers while the command's or tick's `withCritical` is open, then the process exits 75 (`restart.ts:168-171`, `:276-288`) | exits 75 with no plugin dispose and no `client.destroy()` (the SIGTERM handler is not involved, `index.ts:123-124`) | none | absent | armed: A = latest, P if `/update` | none; guard allows | Docker restarts the same container on the same image (`unless-stopped`, `docker-compose.yml:57`) [D]. Boot reads P and says "noop ... the image wasn't rebuilt. Redeploy with `--build`" (`updateReport.ts:38`, `:52-57`): right for no socket, wrong advice for a ping blip. Unforced ticks are `suppressed` (`update.ts:87`, `:292-297`) until the image is rebuilt and a check decides `current` (`:286-290`), a newer commit lands, or `/update` (force) retries the socket path | #505 (self-update-handoff-1: ping blip); #512 (docker-restart-4: the exit skips dispose, and a SIGTERM during the deferral exits 75 not 0 because `restart.ts:170` runs before `:174`) |
| 5 | A second `/update` while that exit is deferred: `checkInFlight` is already false and `handoffActive()` is false, so `checkForUpdate` is not refused (`update.ts:258`); with `force` it decides `restart` again | exit still pending | none | absent | P overwritten with the second requester (`update.ts:303-309`) | none | The first requester's report is lost. `requestRestart` is a no-op the second time (`restart.ts:277`). **D1a:** the busy guard now reads `restartPending()`, so the second `/update` is refused | #449 (commands-report-interaction-9) |

### B. Build

| # | Failure point | original (O) | standby (R) | handoff.json | state.json (A, P) | `-next` / guard / `.env` / lock | Recovered by, or WEDGES | Covered by |
|---|---|---|---|---|---|---|---|---|
| 6 | `inspectSelf()` throws (`redeploy.ts:218-221`): hostname lookup, daemon error or the 60 s bound (`docker.ts:141-156`) | running, not quiesced (`beginHandoff` is later, `:260`) | none | absent (`clearMarker` ran, `:214`) | A stays. P cleared and saved by `applyUpdate` (`update.ts:347-348`); if that save rejects, P stays on disk and the reply becomes "Update check failed: <fs error>" (`commands.ts:127-129`) | none; guard allows | `/update` (force) bypasses A (`update.ts:87`). Unforced ticks stay suppressed until a newer commit changes `latestSha`. The `/update` reply says "did not complete the handoff: could not inspect own container ... I removed it" (`handoff.ts:160-163`); nothing was ever created, so "I removed it" is false | AUTO silent plus suppression: #505 (self-update-handoff-2). Wording: #451 (it also fires when nothing was created) |
| 7 | The build fails, or the 15-min bound aborts it (`redeploy.ts:228-239`; `docker.ts:40`, `:204-228`) | running; scheduler NOT quiesced (`redeploy.ts:250-260`). `checkInFlight` is held for the whole build (`update.ts:261`, `:314-316`), so every other `/update` answers `busy` (`:258`), and that text promises a report (`commands.ts:376`). On the AUTO path the tick watchdog frees the tick guard after 5 min (`announce.ts:149`, `:182-191`) but not `checkInFlight` | none (the daemon may or may not keep building after the client gives up [D]; no container is created) | absent | as row 6 | none; guard allows | as row 6. A long build also outlives the `/update` interaction token (about 15 min, `updateReport.ts:13`), so the failure `editReply` can itself fail [inferred] | #505 (-2), #449 (busy text), #451 |
| 8 | O's process dies during the build (`redeploy.ts:228-232`): SIGTERM from `docker stop` or a reboot (the drain waits <= 8 s because no handoff exemption exists yet, then `exit(0)`: `shutdown.ts:34`, `:113-142`, `restart.ts:82-84`); an OOM kill; or a `bot-ops.sh` restart, recreate or env-set (so also the panel's Restart and Apply) whose guard PASSED because no `-next` exists before row 9 (`bot-ops.sh:389`) | dead; back via its policy unless explicitly stopped [D] | none | absent | A and P stay armed on disk | none; guard allows; a bot-ops run may hold the lock (`:403-409`) and knows nothing of the swap | Normal boot. P is consumed at `index.ts:446` and reads "noop ... image wasn't rebuilt" (false cause, `updateReport.ts:38`, `:52-57`). Unforced ticks stay `suppressed` (`update.ts:87`) until a newer commit or `/update` (force). **D1a:** the boot finds `swapInFlight` with no live `-next`, reports `interrupted`: the boot clears the record and A and marks P `interrupted` in one save (so the verdict survives a boot that dies before delivering it), and the report path then clears P and saves it BEFORE delivering it (at-most-once, as in row 28); a daemon that cannot be asked leaves all three for the next boot | #450 (self-update-handoff-3, docker-restart-7). The bot-ops trigger is new information: section "Interactions" |

### C. Create the standby, and the original's wait

| # | Failure point | original (O) | standby (R) | handoff.json | state.json (A, P) | `-next` / guard / `.env` / lock | Recovered by, or WEDGES | Covered by |
|---|---|---|---|---|---|---|---|---|
| 9 | After `beginHandoff` (`redeploy.ts:260`): the leftover sweep `removeContainer(<N>-next)` (`:263`), `createContainer` (`:264-267`) or `startContainer` (`:268`) throws. A throw inside `buildCreateSpec` (evaluated in the same `try`, `:266`) lands here too, and a tmpfs mount builds an invalid bind that `createContainer` rejects with a 400 (redeploy-10). The catch removes by id or name (`:286`) and calls `endHandoff()` (`:289`) | running, un-quiesced again | removed, best effort | absent | A stays, P cleared (`update.ts:347-348`) | normally none. If the cleanup removal also throws it is only logged (`:287`): a created or exited `-next` is left, and at `c783ad0` the guard REFUSES for either (`bot-ops.sh:389-391`); since S3b-1 only for a created one | Normal case: as row 6. Leftover: `/update` (force) sweeps it (`:263`) only when the decision is not `current`; a newer commit's AUTO redeploy sweeps it; or `docker rm <N>-next` | #491 (redeploy-10); #490 (redeploy-2 class); #451 |
| 10 | O's process dies after R started and before the verdict, daemon alive (an OOM kill, a crash) | Docker restarts O in place (`unless-stopped`) [D]: O' is a normal boot, ticks run, P consumed -> a false "noop" report | keeps booting (policy `no`, so Docker does not restart it, `redeploy.ts:184` [D]), logs in, `takeOver` finds O' running and stops it (`:477-494`): the swap LANDS | `ready`, then cleared by R (`:641`) | A armed (R's first `current` clears it). P consumed by O' and still in R's import-time snapshot (`state.ts:41`) [inferred] | `-next` exists until R's rename; guard REFUSES in that window | The swap completes by itself. The requester gets a false "noop" from O' and an "updated" from R [inferred]. **D1a:** O' finds `swapInFlight` and a RUNNING `-next`: it touches nothing and leaves the report to R | #450 for the false report; the second report is new information |
| 11 | Host reboot, power loss or `dockerd` restart between R's creation and the verdict. Also O's process dying between `createContainer` and `startContainer` (`redeploy.ts:264-268`): that leaves a `created` `-next` that nothing will ever start | back via its policy [D] as a normal boot; its `redeploy()` is gone | stays `exited` (policy `no`) or `created`, never started [D] | absent, or a stale value R wrote before the stop | A and P armed; P -> false "noop" (as row 8). After a power loss `state.json` may instead come back torn or empty [D]; `loadStateFrom` moves it aside (`state.ts:54-73`) and A and P are gone, so AUTO retries and nothing reports | an exited or created `-next` EXISTS and O runs: at `c783ad0` the guard REFUSES `restart`, `recreate` and `env-set` (probe 1), with "try again once it completes", which never becomes true. Since S3b-1 an exited `-next` no longer refuses; a `created` one still does. A plain `compose up -d` or Dockge has no guard | `docker rm <N>-next`; or `/update` (force) while the running sha is still stale (the sweep at `redeploy.ts:263`); or a newer commit's AUTO redeploy. NOT by `/update` once the build is current: `current` returns before `applyUpdate` (`update.ts:81`, `:286-290`, `:313`). **WEDGES** at `c783ad0` (bot-ops and panel mutations); since S3b-1 an exited `-next` no longer blocks them, and a `created` one clears with `docker rm <N>-next`. **D1a:** the boot finds `swapInFlight` with no live `-next` (a `created` leftover is `stopped` to the probe), reports `interrupted`: the boot clears the record and A and marks P `interrupted` in one save (so the verdict survives a boot that dies before delivering it), and the report path then clears P and saves it BEFORE delivering it (at-most-once, as in row 28); a daemon that cannot be asked leaves all three for the next boot | #490 (redeploy-2), fixed by S3b-1; #450 |
| 12 | An operator `docker stop <N>` of O alone during the wait | drains <= 8 s with the handoff exemption (`restart.ts:82-84`, `:255-269`), `exit(0)`, and stays down (an explicit stop is exempt from `unless-stopped`, `redeploy.ts:455-457` [D]) | continues, verifies, `takeOver` takes the non-live branch: stop is a no-op, remove, rename (`redeploy.ts:495-499`, `:505-523`; **S3a:** the remove and rename are `completeTakeOver`'s, after probation) | `ready`, then cleared | A armed; P in R's snapshot and delivered normally by R (no O' consumed it) | `-next` renamed away | R completes the swap; nothing to recover | n/a (works) |
| 13 | A bot-ops recreate or env-set (so also the panel's Apply or Restart) passes the guard just before R exists (`bot-ops.sh:689`, `:996`), waits <= 60 s on the config-dir lock (`:690`, `:997`, `:402-409`), then recreates (`up -d --force-recreate`, `:954`). The bot never takes that lock. `restart` has the same ordering (`:660-661`) with an in-place effect. A plain `compose up -d` has no guard at all | O's process is stopped by the recreate; O' is a NEW container id built from compose + `.env` + `<project>-bot:latest`, which still names the OLD image (`tagLatest` has not run) | `takeOver` retires `HANDOFF_FROM` = the old id: inspect 404 -> "already gone" -> returns before the rename (`redeploy.ts:513`; **S3a:** `completeTakeOver` finds no original and skips the rename, same outcome) -> R goes live named `<N>-next` | `ready`, then cleared | A armed; P in both snapshots | TWO live bots on one token: O' (old build, `<N>`) and R (new build, `<N>-next`). Whether compose also recreates R is unverified [D]. A re-run guard would REFUSE while R exists | Nothing recovers it; an operator stops one by hand. **WEDGES** (double replies until then). **S3a:** the same outcome was possible for the whole probation after the stop (the rest of the replacement's start-up plus up to 60 s for its first tick): a `recreate`/`env-set` creates a NEW container from the old `:latest`, whose id neither `detectRollback` nor `completeTakeOver` follows (they inspect the old `HANDOFF_FROM` id and get a 404). Since S3b-1 the guard refuses in that window too (an alive `-next` beside a canonical name that is not running gets the *finishing* message), so the bot-ops and panel paths are closed once R exists (a mutation that passed the guard before R existed and is still waiting on the config-dir lock can recreate in the window, as the row's first half says); a plain `compose up -d` still has no guard | #473 (ops-bot-ops-sh-1). Its suggested fix (re-check after the lock) does not close the build-window variant, row 8 |

### D. The standby boots; the original polls

| # | Failure point | original (O) | standby (R) | handoff.json | state.json (A, P) | `-next` / guard / `.env` / lock | Recovered by, or WEDGES | Covered by |
|---|---|---|---|---|---|---|---|---|
| 14 | O's poll throws once: `tryInspectContainer` gets a 5xx or hits the 60 s bound (`docker.ts:167-177`) inside `awaitHandoff` (`redeploy.ts:402-405`). The catch (`:333-342`) sets `failed` and `observedAt` is still 0 (`:299`) | the generation guard (`:359-373`) sees R running with `StartedAt` > 0 and SKIPS the removal; `endHandoff` (`:386`) and `clearMarker` (`:387`) run; returns `failed`; the requester is told "I removed it" (`handoff.ts:160-163`) | ALIVE and booting; still reaches `takeOver`, writes `ready` (nobody reads it), retires O: the swap LANDS after the reported failure | cleared by O (`:387`); R rewrites `ready`, then clears | A stays. P cleared and saved by O (`update.ts:347-348`), but R's import-time snapshot may predate that clear: R then still delivers "updated" [inferred] | `-next` exists until R renames; guard REFUSES while O runs. If R instead fails verification it exits (policy `no`, so it stays exited [D]) and an exited `-next` is left: row 11's wedge at `c783ad0` | At `c783ad0`: self-heals when R verifies, otherwise as row 11. Since bundle S1 of #525 a failed inspect no longer decides anything: the poll continues and the marker or the deadline decides, and a replacement judged `failed` or `timeout` is removed against a real verdict time, never epoch 0. The cost: a daemon that errors on every poll holds the original quiesced for the 120 s deadline, and one that hangs holds it for about 300 s (the 120 s, one last poll of up to 60 s, then the guard's inspect and the removal at up to 60 s each) | #431 (redeploy-1), fixed by S1; #451 |
| 15 | The same poll reads marker `ready` and its inspect throws (`Promise.all`, `redeploy.ts:402-405`): the `ready` is discarded, same catch. A second trigger needs no poll error: the marker is read at the start of the iteration, `elapsedMs` is computed after the inspect returns (`:401-415`), so a `ready` written in between loses to `timeout` (`handoff.ts:128`) when the 120 s boundary falls in that window; R's `ready` is written by about 107 s (90 s timer, armed after <= ~17 s of boot awaits; **S3b-2:** armed at the top of `index.ts` now, so by about 90 s plus the container's own start and import time), so this needs an inspect slower than ~13 s (about 30 s less that start time since S3b-2) [inferred] | as row 14 | may already be inside `retire`, stopping O | `ready` | as row 14 | Today the skipped removal masks the poll-error trigger, but only while the confirmation inspect at `:361` succeeds; if it also throws (`:366-370`) the removal proceeds now. Once #431 removes the skip, `:374` force-removes R while it is stopping O: ZERO bots. The deadline trigger removes R the same way today | Closed by bundle S1: a failed inspect is no verdict, and `redeploy()` re-reads the marker before acting on any verdict but `ready`, so a late `ready` wins. The residual window is the generation guard's inspect plus the removal call (two sequential 60 s bounds at worst). At `c783ad0` it was not recovered once it happened (O is stopping, R is gone); an operator runs `bot-ops.sh recreate` or `docker start <N>` [D]. **WEDGES (latent) at `c783ad0`** | #433 (redeploy-4), fixed by S1 for both triggers (the deadline trigger had no issue of its own; item 4 of "Interactions") |
| 16 | R crashes or exits before login (a config the new build refuses, an import error) | running, quiesced | `exited`, stays so (policy `no`) [D] | absent | armed | `-next` exists, exited, briefly | O's next poll sees `!running && status != created` -> `failed` (`handoff.ts:126-127`, poll `redeploy.ts:42`) -> `removeContainer(R)` (`:374`), `endHandoff`, `clearMarker`, report. Clean | n/a (works; wording #451) |
| 17 | R never reaches `ClientReady`: its 90 s verify timer (`index.ts:467-479`) writes `failed` and exits 1. The timer is created only after `loadPluginIndex` (<= 5 s), `readPluginState` and `resolveBootMode` (<= 10 s) (`index.ts:69-78`, `:128`), so O's own 120 s clock (`handoff.ts:128`, started at `redeploy.ts:399`) can fire first as `timeout`. **S3b-2:** the timer is now armed at the top of `index.ts`, before the first boot await, so those bounds run inside the 90 s and the margin to O's 120 s is 30 s less the container's own start and import time. The callback is `async` with no try/catch: if `writeMarker` throws, the rejection is unhandled and ends the process with exit 1 (probe 3), with no `failed` marker | quiesced up to 120 s | exits 1 (the timer fires, or the rejection above), or is still running when O's own clock fires first and O removes it | `failed`, or absent | armed | `-next` exists, exited [D] or running, until removed | O removes R (`:374`), `endHandoff`, clears the marker; "never reported in within 120s" (`handoff.ts:139-145`). With no marker, O sees R not running and decides `failed` (`handoff.ts:127`) within a poll. Clean | #506 (self-update-handoff-14); #494 (boot-config-http-13); #492 (redeploy-15) |

### E. R takes over

| # | Failure point | original (O) | standby (R) | handoff.json | state.json (A, P) | `-next` / guard / `.env` / lock | Recovered by, or WEDGES | Covered by |
|---|---|---|---|---|---|---|---|---|
| 18 | `takeOver`'s `write(ready)` throws (`redeploy.ts:621`; volume unwritable). The catch (`:642-662`) tries a `failed` write, which also fails (swallowed, `:660`), then `exit(1)` | quiesced, still the only live bot | exits 1; policy still `no` | absent | armed | `-next` exists, exited [D], briefly; O was never stopped | O sees R gone -> `failed` (`handoff.ts:127`) -> removes R. Clean | n/a (works) |
| 19 | `tagLatest` throws (`redeploy.ts:547-550`, `:628-633`): swallowed on purpose | quiesced | continues | `ready` | armed | `:latest` NOT moved: after the swap a later `bot-ops.sh` env-set or recreate (no `--build`, `bot-ops.sh:941-954`) recreates from the OLD `:latest` and silently rolls back | The swap lands. Repaired by the next successful update (the log line says so, `redeploy.ts:629-632`). **S3a:** the tag is `completeTakeOver`'s, after probation; a throw is still swallowed on purpose | n/a (documented in that log line) |
| 20 | `restorePolicy()` throws, or the daemon applied the update and the response was lost (`redeploy.ts:557-561`, `:639`): `failed`, `exit(1)` | quiesced -> reclaims on `failed` (<= 2 s) | exits 1 with policy still `no`. Lost-response variant: its policy is already `unless-stopped`, so Docker restarts it [D]; if that is after the decision the generation guard leaves it alone and it re-runs the whole standby cycle and can land the swap late (docstring `redeploy.ts:590-602`). **S3a:** the restarted R finds O RUNNING with its own policy restored, so `detectRollback` makes it step aside: it no longer re-runs the cycle or lands late, and O reclaims through the `failed` marker | `failed` | armed; P cleared | `:latest` ALREADY moved (`tagLatest` ran, `:628`; **S3a:** NOT moved any more, the tag follows probation, so a failed restore never moves it). `-next` exists, exited, until O removes it | O removes R and the requester is told "failed", but `:latest` names the new build, so a later env-set, recreate or compose up deploys it anyway | #490 (redeploy-7); #451 |
| 21 | `retireOriginal` throws BEFORE the stop took: `tryInspectContainer(O)` throws (`redeploy.ts:471`), or `stopContainer(O)` throws and the re-inspect at `:488` also throws or still shows O running (`:485-494`). Catch: `failed`, `exit(1)` | usually alive, reclaims. If the stop in fact took effect and both calls' answers were lost, O is down | exits 1 but its policy is ALREADY restored (`:639` precedes `:640`), so Docker restarts it [D] | `failed` | armed | `:latest` moved (**S3a:** NOT moved; and with O alive, R's restart finds O running, so `detectRollback` makes R step aside instead of re-running the cycle below). Before S3a, if O was alive and R restarted after O's decision, the generation guard left R alone and it re-ran the standby cycle and could land the swap late (as row 20); now it steps aside. If O was in fact down, R's restart finds the corpse and completes (docstring `redeploy.ts:574-588`): a bounded blip | as row 20; the down-O case self-recovers | #490 (redeploy-7) |
| 22 | After the stop (`redeploy.ts:500-504`): `removeContainer(O)` throws (`:505-511`), so the rename R -> `<N>` fails on the name conflict (`:515-523`). Both only warn | the corpse: stopped, still named `<N>` (explicit stop, stays down [D]) | LIVE and serving, still named `<N>-next`, policy restored | cleared (`:641`) | as row 0 | `-next` exists and IS the live bot; `<N>` is the corpse, so the guard ALLOWS at `c783ad0` (since S3b-1 it REFUSES, with the *finishing* message). `bot-ops.sh` `status` and `logs` look up `<N>` (`:623`, `:655`): the corpse, so the panel shows the bot stopped, and its natural button is Restart = `recreate`, which the guard allowed at `c783ad0` (S3b-1 refuses it). Compose recreates by label; if it had been allowed and left `<N>-next` alone, this would start a SECOND live bot on the token, row 13's outcome with no stale guard [D]. The next swap names its R `<N>-next-next` (`redeploy.ts:249`; **S3b-2:** `replacementName` derives from the base name and a bot named `-next` is refused on its own name, before any build) | A reboot, daemon restart or in-place restart of R heals it: boot -> `resolveBootMode` finds the corpse -> standby -> `takeOver` -> retire again (remove, rename); the retry is described at `redeploy.ts:459-466` and `:704-713`. Otherwise by hand: `docker rm <N>`, then `docker rename <N>-next <N>`. **WEDGES** (ops tooling blind; the bot is up). **S3a:** the corpse is now EVERY swap's state between R's login and the end of its probation, and the retry is `takeOver` (a stop that finds it stopped) -> `activate()` -> `finishProbation` -> `completeTakeOver` (remove, rename); a failed removal there leaves this row's state as before. The never-renamed live bot stays #547's: **S3b-2:** with the original gone the next boot of R is `normal`, and `healOwnName` renames it (row 23) | #492 (redeploy-16) names the state, but its fix (derive the name, sweep only non-running) does not heal it: #547 |
| 23 | No corpse, but R is never renamed: the rename call itself fails after a successful removal (`inspectSelf` or `renameContainer` error, `redeploy.ts:517-523`), or R dies or the host reboots after `stopContainer(O)` and before the rename (`:486`, `:517-518`) | stopped (explicit) [D] and removed, or still a corpse if the death came before `:505` | policy already restored (`:639` precedes `:640`), so Docker restarts a dead R [D] | `ready` left in the volume if R died before `:641`; inert until the next redeploy clears it (`:214`) | as row 0 | If the corpse still exists: R boots standby, retries, converges (as row 22). If O is already removed: `resolveBootMode` gets a 404 -> `normal` (`redeploy.ts:731`), R goes live and is NEVER renamed (the rename lives only in `retireOriginal`): it stays `<N>-next` with no `<N>` at all; the guard allows (at `c783ad0`; S3b-1 refuses); `status` says not running; the Restart button is `recreate`, with row 22's second-bot risk [D] | By hand: `docker rename <N>-next <N>`. **WEDGES** (ops tooling blind). **S3a:** unchanged for the never-renamed case (the rename is still `completeTakeOver`'s only, and a normal-mode boot does not re-enter it); R dying between the stop and the removal now leaves the corpse in place, so the retry through a standby boot converges as in row 22; between the removal and the rename it is the case described here (no corpse, never renamed). **S3b-2:** that case now heals at the next boot of R (`docker restart <N>-next`, a reboot, a crash restart): the boot is `normal` because the original is gone, and `healOwnName` takes `<N>` when it is free, or held by a STOPPED container of the same compose project and service (removed first, un-forced). A RUNNING `<N>` is left alone and logged as two bots on one token. Only a container created by a self-update (`HANDOFF_FROM` in its env) is healed, so that an ordinary boot never touches the socket: a compose-created container renamed to `*-next` by hand is not healed | #547 (same child as row 22) |
| 24 | R dies hard after writing `ready` and before retiring (an OOM kill). A thrown error writes `failed` instead (rows 20-21). Before `:639` its policy is still `no`; after `:639` it is restored, Docker restarts R [D], and the swap can still land inside O's 180 s. **S3a:** the restarted R finds O RUNNING with its policy restored and steps aside, so it can no longer land the swap there; O waits out the 180 s as if R had stayed down | quiesced for up to 180 s: `awaitRetirementFailure` polls only the marker (`redeploy.ts:316`, `:427-437`) | exited if it died before `:639` [D]; restarted by Docker if after | `ready` | armed | `-next` exists | If R stays down, after 180 s O decides `stalled` (`:321`), removes R, resumes, and tells the requester "verified but never retired me ... Check the daemon socket" (`handoff.ts:145-154`): the wrong hint when R simply died | #491 (redeploy-13) |
| 25 | R's `takeOver` completes and `activate()` or its first ticks then crash, deterministically (`index.ts:137-138`; the verification bar is a completed gateway login, `index.ts:133-136`). An unhandled rejection ends the process (probe 3) | gone: stopped and removed (or a corpse after row 22) | restarts under the restored policy [D]; `resolveBootMode` -> `normal` (O is 404); crashes again: a crash loop | cleared (`:641`) | A, P as armed: `reportUpdateOutcome` is the last step of `activate()` (`index.ts:446`) and never runs | `:latest` already names the new build (`:628`); no `-next`; guard allows | Nothing reclaims: O is gone and nothing points `:latest` back. The previous sha tag still exists (`KEEP_SHA_TAGS` = 3, `redeploy.ts:45`, `:96-115`), so an operator can `docker tag <repo>:<oldsha> <repo>:latest` and `bot-ops.sh recreate`, or ship a fix. **WEDGES** (outage until an operator acts; the standby's verification exists so that a bad build never replaces a good one, `index.ts:133-136`). **S3a (decision on #548: option 1):** O is stopped at R's login but KEPT until `activate()` has returned and the first tick has settled (60 s cap); `:latest` moves only then. A crash in that window restarts R as a standby (O still exists, stopped); the rollback is `docker stop <N>-next`, then `docker start <N>` (no overlap; a SIGTERM during probation also makes `completeTakeOver` leave O in place). `docker start <N>` alone works too, with an overlap: R finds O running at its next boot (`detectRollback`), right before it would stop O again (`takeOver`'s second look), or at `completeTakeOver`, and steps aside (`stepAside`: stops itself through the daemon and stays down as an exited `<N>-next`). A build that hangs rather than crashes never reaches either check, so stop it first (`docker stop <N>-next`; `docker rm -f <N>-next` ends it at once), then `docker start <N>`. Nothing automatic starts O, except `restart: always` after a daemon restart, which R reads as a rollback and steps aside for. `docker stop <N>-next` then `docker start <N>` has no overlap; `docker start <N>` alone leaves both bots answering until R looks (at its next boot, right before it would stop O again, or at the end of its probation: the rest of `activate()` plus up to 60 s). A `recreate` or `env-set` during the probation is NOT a rollback, and since S3b-1 the guard refuses it (R is alive and `<N>` is stopped: the *finishing* message); a plain `compose up -d` most likely just starts the stopped O (a rollback R steps aside for), whereas a forced recreate would create a new container from the old `:latest`, which R's checks do not follow (row 13's outcome) [D]. With `AUTO_UPDATE=true` the revived O can update to the same build again (R's first tick cleared A). Not demonstrated on a daemon here; that is the operator step on #548 | #548 |

### F. After the verdict

| # | Failure point | original (O) | standby (R) | handoff.json | state.json (A, P) | `-next` / guard / `.env` / lock | Recovered by, or WEDGES | Covered by |
|---|---|---|---|---|---|---|---|---|
| 26 | O's final cleanup: `removeContainer(R)` throws (409 mid-teardown, the 60 s bound; `redeploy.ts:374-380`), or the generation guard skips it (rows 14, 20) | running, un-quiesced (`endHandoff` first and synchronous, `:386`); marker cleared (`:387`); told "I removed it" regardless (`handoff.ts:141-142`, `:152-153`, `:162`), because `RedeployResult` carries no removal status (`redeploy.ts:390`) | removal failed: alive or exited. Skipped: alive | absent | A stays, P cleared | an exited `-next` -> the guard REFUSES at `c783ad0` (row 11's wedge); an alive R may still land the swap (row 14) | as rows 11 and 14. Since S1 the result says which (`remove-failed`, `left` or `none`) and the requester is told so (#451) | #451 (message), fixed by S1; #490 (redeploy-2) |
| 27 | A marker is left behind: R wrote `ready` or `failed` after O gave up, R died before `:641`, or a surviving earlier R writes during the next attempt's build. The marker is cleared only at `redeploy.ts:214`, before the build and the sweep | -- | -- | stale `ready` or `failed` | -- | -- | Inert until the next `redeploy()` clears it (`:214`). A still-alive earlier R can have its verdict attributed to the new attempt (redeploy-14). Nothing else reads it | #491 (redeploy-14); #506 (self-update-handoff-10) |
| 28 | R is live and `activate()` runs (`index.ts:138`, `:146-462`). It starts the scheduler (`:316`) BEFORE `reportUpdateOutcome` (`:446`). The report is cleared and saved before delivery (`updateReport.ts:160-161`): a rejecting `saveState` escapes and leaves P on disk (it re-fires next boot); three failed routes drop it (`:95-115`); an AUTO tick that decides `restart` first overwrites P with `undefined` (`update.ts:303-309`) | gone | live | absent | P consumed or lost; A cleared by R's first `current` | none | Delivery is at-most-once by design; a newer commit landing in R's first seconds drops the owed report. **D1a:** a rejecting save is logged and delivery goes ahead; an AUTO `restart` no longer assigns `undefined` to P, and an AUTO swap's failure no longer clears it | #506 (self-update-handoff-12); the tests that would pin it: #452 |
| 29 | Any later in-place restart of the swapped-in R (reboot, daemon restart, crash loop, `bot-ops.sh restart`, which the guard allows once the rename happened). `HANDOFF_FROM` is baked in and never clears (`redeploy.ts:459-466`) | gone | restarts under the restored policy (`:557-561`) [D] | absent | -- | none | `resolveBootMode` asks the daemon (`redeploy.ts:722-735`): O 404 -> `normal`, boots as the bot. A timed-out or erroring inspect stays `standby` (`:732-734`): verify timer plus `takeOver` (O gone: retire returns at `:513`) -> live; if the daemon keeps failing, `takeOver` exits 1 and Docker restarts R until the daemon answers [D] | n/a (documented, #46) |
| 30 | AUTO_UPDATE tick path. The `autoUpdate` check (`announce.ts:226-229`) runs `checkAutoUpdate` (`:309-312`) inside the tick's `withCritical` (`:301`). No requester, so P is `undefined` (`update.ts:109`, `:303-308`) and the result is discarded (`announce.ts:311`). Failed builds, create or start errors and every `failed`, `timeout` or `stalled` outcome end as one `console.warn` (`update.ts:349`) | running | per rows 6-26 | per rows 6-26 | A set, P `undefined` | per rows | Every later poll for that sha logs `suppressed` (`update.ts:292-297`; the text blames the orchestrator) until a newer commit changes `latestSha`, or an admin runs `/update` (force). Nobody is told. **D1a:** the `suppressed` line is logged once per pending sha per process (a new failed swap re-arms it) and names the failed swap | #505 (self-update-handoff-2); #506 (self-update-handoff-13); #429 |

## Rows that wedge

- **Row 11** (and its generators in rows 9, 14, 26): an exited or created `<N>-next` makes `bot-ops.sh` restart,
  recreate and env-set (so the panel's Restart and Apply) refuse forever. Covered by #490 and closed for an exited one by S3b-1 (a `created` one still blocks, and clears with
  `docker rm <N>-next`); see "Interactions", item 2.
- **Row 13**: two live bots after a recreate that outran a stale guard. Covered by #473.
- **Row 15** (latent): a `ready` replacement removed mid-retire, by a poll error (once #431 stops masking it) or by
  the deadline race. Closed by bundle S1 (the marker is re-read before any non-`ready` verdict is acted on); the
  residual window is the generation guard's inspect plus the removal call, two sequential 60 s bounds at worst.
- **Rows 22 and 23**: the live bot is left named `<N>-next` and nothing renames it back. #547.
- **Row 25**: the swap lands, the new build crash-loops, and nothing rolls back. #548 (**S3a:** the original is
  kept stopped until the new build has run, and `docker start <N>` rolls back; the on-daemon demonstration is the
  operator's step on #548).

Not wedges but silent stalls (recoverable with `/update` force or a newer commit, and nobody is told): rows 4, 6,
7, 8 and 30. Covered by #450, #505 and #506.

## Cross-check against the named findings

Every row was read against these seven. "Holds" means the finding is true as filed at `c783ad0`.

- **#431 (redeploy-1)**, rows 14 and 26. Holds. Refinements: (a) R is not always "healthy and finishing": if it
  fails verification it exits under policy `no` and leaves an exited `-next`, which is row 11's wedge. (b) The
  filed consequence "no follow-up report is sent" depends on timing. R snapshots `state.json` at import
  (`state.ts:41`); if the poll error lands after that, R's copy of P survives O's clear and R delivers "updated"
  after O said "failed"; if it lands before, the report is dropped [inferred]. (c) Its suggested fix alone turns
  #433 live (row 15). Fixed in bundle S1, which tolerates the blip instead (a failed inspect is no verdict) and
  keeps the real `observedAt` as the backstop's.
- **#433 (redeploy-4)**, row 15. Holds. It must land with #431. The decision it needs is wider than "read the
  marker first": a `ready` marker with a failing inspect should never end in removal, because R is about to stop O.
  And because `redeploy.ts:344` already re-reads the marker just before the removal, the same fix should gate the
  removal on that fresh read, which also closes the deadline-race trigger (row 15) that "read the marker first"
  does not. Fixed in bundle S1 with #431: S1 re-reads the marker once, right after the poll decides and before the
  generation guard's inspect (not at the removal call), so a window of that inspect plus the removal stays.
- **#450 (self-update-handoff-3, docker-restart-7)**, rows 8, 10 and 11. Holds. Refinements: (a) the triggers are
  wider than a reboot, OOM or operator restart: a `bot-ops.sh` mutation or the panel's Apply during the build
  passes the guard (no `-next` yet) and kills the swap. (b) In row 10 the swap lands anyway, so the requester gets
  two contradictory reports. (c) The review report's suggested fix (self-update-handoff-3: clear A "when a boot
  finds P with fromSha == running and no `-next` container"), and docker-restart-7's "when no handoff is in
  flight", would both misfire in row 10, where O' boots while R is alive and about to land the swap; #450 itself
  asks for an attempt timestamp or flag, which has no such problem. Whatever the condition, a live `-next` is a
  handoff in flight.
- **#451 (self-update-handoff-8)**, rows 6, 7, 9, 14, 20 and 26. Holds, and is wider than filed: "I removed it" is
  also false when nothing was ever created (build failure, `inspectSelf` failure, rows 6-7). A `removed: boolean`
  is too small; it needs "nothing was created", "removed" and "could not remove". Fixed in bundle S1 with a
  four-valued `replacement` on the result (`none`, `removed`, `left`, `remove-failed`).
- **redeploy-2 in #490**, rows 9, 11, 14 and 26. Holds as filed. Refinements: (a) reboot is only one generator;
  a failed cleanup (row 9), O dying between create and start (row 11), a failed removal (row 26) and a
  generation-guard skip followed by a failed verification (row 14) all leave the same leftover `-next`. (b) The
  verifier's recovery claim, "Admin /update (force) clears it", is false once the operator has followed the
  report's advice and rebuilt ("Interactions", item 2).
- **ops-bot-ops-sh-1 in #473**, row 13. Holds (order read at `bot-ops.sh:660-661`, `:689-690`, `:996-997`).
  Refinements: (a) the same hole exists across the build window, where no `-next` exists yet (row 8), and a
  re-check after the lock cannot close it; that needs a swap-in-progress signal visible from the start of the
  build. (b) The lock never serialises the bot's redeploy, only bot-ops runs. (c) A plain `compose up -d` or a
  Dockge restart has no guard ("Interactions", item 6).
- **docker-restart-4 in #512**, row 4. Holds (`restart.ts:168-175`, `:285-288`, `index.ts:123-124`). It adds nothing to
  the state columns: A and P are saved before the exit.

## Interactions the findings did not foresee

1. **The guard is blind for the whole build** (rows 8, 13). A bot-ops mutation or the panel's Apply, the most
   ordinary operator action, can kill an in-flight swap before R exists. Effects: a false "noop" report, A armed,
   AUTO suppressed (#450's symptoms) with a new trigger. #473's fix is necessary but not sufficient; #450 and #473
   should be designed together.
2. **Exited `-next` + guard + AUTO suppression + `current`** (rows 11, 8). Trace: a reboot mid-swap leaves an
   exited `-next` and A armed (row 11); after an `/update` (an AUTO attempt reports nothing) P tells the operator
   "Redeploy with `--build`" (`updateReport.ts:52-57`); they rebuild; the running sha now equals the latest, so
   `decideUpdate` takes the equality shortcut to `current` (`update.ts:81`) before it consults A, and the next
   check clears A (`:286-290`); `/update` answers "Already on the latest build" and returns without reaching the
   sweep (`update.ts:313`; the sweep is `redeploy.ts:263`); the exited `-next` stays (assuming compose does not
   remove it [D]), and `bot-ops.sh` restart, recreate and env-set refuse with "try again once it completes"
   (`bot-ops.sh:391`) until a NEW upstream commit triggers a redeploy, or someone runs `docker rm`. Following the
   report's own advice therefore locks the operator out of the panel's Apply and Restart. #490 rates this Low on
   the premise that `/update` (force) clears it; this trace says it does not once the build is current. Probe 1
   confirms the guard half; the rest is read. Bundle S3b-1 (#490) closes the lockout for an exited `-next`: the
   guard now reads the container's state, so the operator who rebuilt is no longer refused (a `created` leftover still
   is, and clears with `docker rm`).
3. **A stale snapshot makes the owed report neither lost nor single** (rows 10, 14). R reads `state.json` at import
   and rewrites it whole (`state.ts:41`, `updateReport.ts:160-161`), so O's clear of P (`update.ts:347-348`) does
   not reach R when R booted first. The requester can get "failed" from O and "updated" from R, or a false "noop"
   from a restarted O' and "updated" from R. #507 (self-update-handoff-15) and #509 (state-storage-shutdown-1)
   file the same stale snapshot for `seenReleaseIds`; the report consequence is in neither, and the #450 and #431
   fixes assume one writer of P per attempt [inferred].
4. **Fixing #431 alone activates #433, and #433 as filed does not close the deadline race** (rows 14, 15). Today the
   generation guard skips the removal on the poll-error path; the fix removes that skip, and a `ready` marker
   discarded by the same `Promise.all` then lets `:374` remove R mid-retire. Separately, a `ready` written between
   the marker read and the `elapsedMs` check loses to `timeout` (row 15) whatever #431 does. One change closes
   both: gate the removal on a fresh marker read. (Bundle S1 does that with one re-read before the guard's
   inspect, which leaves the window row 15 now names.)
5. **No code path renames a live `-next` bot back, and #492's fix would make that dangerous** (rows 22, 23). The
   rename exists only inside `retireOriginal` (`redeploy.ts:515-523`); a normal-mode boot (`resolveBootMode` 404,
   `:731`) never re-enters it. Today the next swap from a live `<N>-next` names its R `<N>-next-next`. If #492's
   suggested fix derives the name from `container_name` and sweeps only non-running containers (touching `:263`),
   the next swap's `createContainer("<N>-next")` hits the live bot's own name (409 [D]), and the catch at `:286`
   runs `removeContainer(replacementId ?? name, true)` with `replacementId` undefined: it force-removes the live
   bot by name [inferred]. So #547 and #492 must be planned together. The natural operator reaction to row 22 or
   23 (press Restart, which is `recreate`, allowed by the guard at `c783ad0`; S3b-1 refuses it while the `-next` bot is alive) is itself the second-bot risk of row 13 [D]. **S3b-2:** closed by the two together: `baseName` strips the reserved suffix so `replacementName` is always `<N>-next`; a bot that is itself named `<N>-next` is refused on its name alone, before the build; the leftover is inspected after the build and a RUNNING holder is refused with nothing quiesced; a stopped one is removed by id, un-forced; and the cleanup after a failed create is forced only with an id, by name un-forced otherwise, so nothing is ever force-removed by name. `healOwnName` converges the never-renamed live bot at its next boot.
6. **Only bot-ops has the guard.** The same hazards (rows 8, 13) are reachable through a plain `compose up -d` or a
   Dockge restart, which the code comments name as supported recreate paths (`redeploy.ts:79-85`). Nothing in the
   repo can guard those; the swap would have to expose its in-progress state to anything that recreates.
7. **R is built from O's container env, not `.env`** (`redeploy.ts:153-159`). A `.env` edit saved but not yet
   recreated (the recreate that failed after `.env` was rewritten, `CONTEXT.md:1741-1755`) is not carried into R.
   The swap reports success on the old values; the next recreate applies the edit. Not a wedge; recorded because
   the column asks about `.env`.
8. **The safety net ends at login** (row 25). Every failure up to and including `takeOver` returns to "O reclaims",
   but the bar R must clear before O is retired is a completed gateway login (`index.ts:133-136`). A new build that
   logs in and then crashes in `activate()` or its first ticks has no reclaim: O is already gone. #548. (**S3a:**
   the net now ends at the end of R's probation, not at the login: O is kept stopped until `activate()` has
   returned and the first tick has settled, and `docker start <N>` is the way back.)

## Children filed

#547 (rows 22 and 23) and #548 (row 25), both sub-issues of #525 and listed right after #515 in its
`## Issues (in order)`. Every other wedge row is covered by an existing issue (#490, fixed by S3b-1; #473; #433). #547 landed with bundle S3b-2, together with #492 items 15 and 16 (the verify timer armed at `index.ts`'s module top, the deadline constants pinned, `redeploy()` never touching its own id, the name and the sweep above) and #490 item 8 (the README's quiesce figure, about 11 minutes).

## What this did not verify

- Anything needing Docker: restart-policy outcomes after reboots, crashes and explicit stops, `ps -a --filter
  name=` semantics, name-conflict statuses, compose's treatment of a second labelled container (rows 4, 8, 10-13,
  22-25). Marked [D].
- The two-writer interleavings in "Interactions" 3, 4 and 5 and the deadline race in row 15 (marked [inferred]); no
  concurrency was executed.
- `ops/docker-compose.test.ts` skips on a box without `docker` (`ops/docker-compose.test.ts:45`); the guard was
  checked by probe 1 only. (`ops/bot-ops.test.ts` needs bash and jq, not docker, `ops/bot-ops.test.ts:44`; since
  S3b-1 it pins the guard.)
