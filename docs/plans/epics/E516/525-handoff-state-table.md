# #515 -- the self-update handoff state table

Part of Epic #516, sub-epic #525. Issue #515 is a read-only review: no code or behaviour changes in this
file's PR. Written by Subordinate #3 for the orchestrator on 2026-10-15 against `origin/main` @ `c783ad0`
(`c783ad05df4cd2ee2032c381edb3565786960cb6`). Every `file:line` below was read at that sha. The review that
filed the findings read `4ff8eef`; since then `redeploy.ts`, `handoff.ts`, `updateReport.ts`, `restart.ts`,
`docker.ts`, `shutdown.ts` and `docker-compose.yml` have no commit, `update.ts`/`state.ts`/`github.ts` gained
only test hooks (`f5e7bd7`), and `index.ts`, `announce.ts`, `commands.ts` and `ops/bot-ops.sh` moved, so line
numbers quoted in the issue bodies are stale for those four. An independent claims-vs-code audit of this file
ran before it was committed; its findings and what was done with each are in the PR body.

## What was checked, and how

Read in full: `src/update.ts`, `redeploy.ts`, `handoff.ts`, `updateReport.ts`, `restart.ts`, `docker.ts`,
`shutdown.ts`, `state.ts`, `index.ts`, `docker-compose.yml`; the self-update guard, the config-dir lock, `restart`,
`recreate` and `env-set` in `ops/bot-ops.sh`; the tick path in `src/announce.ts` and the `/update` handler and
reply in `src/commands.ts`; the four review reports (`redeploy`, `self-update-handoff`, `docker-restart`,
`ops-bot-ops-sh`) and `SUMMARY.md`'s Completeness section; issues #431, #433, #450, #451, #490, #473, #512 and the
sub-epic bodies #525, #526, #531.

Evidence tags used in the table:

- Unmarked = read in the cited code at `c783ad0`.
- **[probe]** = executed on this box. Two probes, below.
- **[D]** = depends on Docker or compose behaviour that nothing here executed (there is no `docker` on this box):
  what restarts after a crash, a reboot or an explicit `docker stop`, and how `docker compose` treats a second
  container that carries the service's labels. The code's own comments (`redeploy.ts:455-457`, `:704-713`;
  `bot-ops.sh:339-387`) are the source for what the code assumes.
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
makes an exited leftover a wedge. The fake does not prove Docker's `ps -a --filter name=` semantics; that part is
[D].

Probe 2, `Date.parse("2026-10-08T12:00:00.123456789Z")` on this box's Bun 1.4.2 returns `1791460800123`, a number
(the repo pins Bun 1.3.14, so this answers the open question in the `redeploy` and `docker-restart` reports for
1.4.2 only). The generation guard at `redeploy.ts:359-373` therefore compares real numbers for a nanosecond
`StartedAt` there.

## Vocabulary

- **O** = the original container and its bot process. **R** = the standby/replacement container, named
  `<N>-next`, where `<N>` is the canonical name (`container_name`, `docker-compose.yml:31`). **Corpse** = O,
  stopped but not removed.
- **A** = `state.attemptedUpdateToSha`. **P** = `state.pendingUpdateReport` (set only when `/update` supplied a
  requester). "Armed" = A (and P) saved to `state.json` at `update.ts:309`.
- **marker** = `handoff.json` in the shared `state:/app/data` volume (`handoff.ts:47`).
- **guard** = `guard_no_handoff_in_progress`: `restart`, `recreate` and `env-set` die when a container named
  `<N>-next` exists in any state AND `<N>` is running (`bot-ops.sh:388-393`, probe 1). Only `bot-ops.sh` checks
  this; a grep of the non-test, non-doc tree finds no other `-next` check, so a plain `docker compose up -d` or a
  Dockge restart has no guard.
- **`.env` and the lock.** The swap never writes `.env` (R is built from O's container env,
  `redeploy.ts:153-159`) and never takes the config-dir lock (`bot-ops.sh:403-409`; only `bot-ops.sh` runs take
  it). So the `.env`/lock part of column 7 reads "untouched, free" unless a row says otherwise.
- "Point of no return" = `stopContainer(O)` inside `retireOriginal` (`redeploy.ts:485-504`).

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
7. **R boots.** Loads `state.json` at import (`state.ts:41`), plugin index, `resolveBootMode`, arms the 90 s
   verify timer, logs in (`index.ts:69-128`, `:467-481`).
8. **R verifies and takes over.** `ClientReady` clears the timer and runs `takeOver` (`index.ts:130-138`):
   write `ready` (`redeploy.ts:621`), tag `:latest` (`:628`), restore the original restart policy (`:639`),
   `retireOriginal(O)` (`:640`: inspect, stop, remove, rename), clear the marker (`:641`).
9. **O is stopped.** SIGTERM drain (<= 8 s), dispose, destroy, `exit(0)` (`shutdown.ts:104-143`). Its
   `redeploy()` never returns.
10. **R reports.** `activate()` then `reportUpdateOutcome` (`index.ts:138`, `:446`; `updateReport.ts:156-176`).

The exit-75 fallback is rows 4-5. The AUTO_UPDATE tick path is row 29 and the AUTO notes in rows 6-8.

## The table

Columns 3-7 are the state left behind at that instant. Rows are in path order, grouped by phase.

### A. Decide and arm

| # | Failure point | original (O) | standby (R) | handoff.json | state.json (A, P) | `-next` / guard / `.env` / lock | Recovered by, or WEDGES | Covered by |
|---|---|---|---|---|---|---|---|---|
| 0 | *Reference: no failure.* The swap lands (`redeploy.ts:621-641`, `index.ts:137-138`) | stopped by R (SIGTERM, drain <= 8 s, `exit(0)`; an explicit stop is exempt from `unless-stopped`, `redeploy.ts:455-457` [D]), then removed | live, renamed `<N>`, policy = O's original name | absent (R clears it, `:641`) | A cleared by the first check that decides `current` (`update.ts:286-290`; needs AUTO_UPDATE or a `/update`). P consumed, saved before delivery (`updateReport.ts:160-161`) | `-next` gone after the rename; `:latest` now names R's sha tag (`:628`); `.env` untouched, lock free | -- | -- |
| 1 | GitHub unreachable: `fetchLatestBotSha` throws (`update.ts:263`, throws at `:122-130`) | running, not quiesced | none | absent | unchanged (nothing is written before `update.ts:309`) | none; guard allows; `checkInFlight` released in `finally` (`update.ts:314-316`) | Nothing to recover. AUTO: the next poll, 15 min later (`lastUpdatePollAt` is stamped before the call, `announce.ts:310`). `/update`: "Update check failed" (`commands.ts:127-129`) | n/a (nothing left behind) |
| 2 | The compare call fails and is swallowed as `unknown` (rate limit, 5xx, 10 s timeout: `update.ts:166-168`, `:181-183`). `decideUpdate` reads `unknown` as stale (`:84-88`), so a current or AHEAD build enters row 3 | running | none yet | absent | armed by row 3 | as row 3 | Nothing detects it. If the swap lands it targets the main tip, which can be OLDER than the running build; R then reads `current` and clears A, so nothing reverts it (`github.ts:23-31`) | #505 (self-update-handoff-4) |
| 3 | `saveState()` rejects at `update.ts:309` (full or read-only volume) after A and P were set in memory (`:300-308`) | running; memory armed, disk old | none | absent | disk: old values. Memory: armed | none; guard allows | The error reaches the caller (`/update` reply, `commands.ts:127-129`; tick log, `announce.ts:125`) and no swap starts. In memory A suppresses unforced ticks (`update.ts:87`) until a restart reloads the disk copy or `/update` (force) runs | n/a (not a wedge; a volume that cannot be written fails every other write too) |
| 4 | `redeployAvailable()` is false (`update.ts:334-338`): the socket is not mounted (the documented fallback), OR it is mounted and `/_ping` errored or timed out (`docker.ts:114-120` turns any error into false). `requestRestart` defers while the command's or tick's `withCritical` is open, then the process exits 75 (`restart.ts:168-171`, `:276-288`) | exits 75 with no plugin dispose and no `client.destroy()` (the SIGTERM handler is not involved, `index.ts:123-124`) | none | absent | armed: A = latest, P if `/update` | none; guard allows | Docker restarts the same container on the same image (`unless-stopped`, `docker-compose.yml:57`) [D]. Boot reads P and says "noop ... the image wasn't rebuilt. Redeploy with `--build`" (`updateReport.ts:38`, `:52-57`): right for no socket, wrong advice for a ping blip. Unforced ticks are `suppressed` (`update.ts:87`, `:292-297`) until the image is rebuilt and a check decides `current` (`:286-290`), a newer commit lands, or `/update` (force) retries the socket path | #505 (self-update-handoff-1: ping blip); #512 (docker-restart-4: the exit skips dispose, and a SIGTERM during the deferral exits 75 not 0 because `restart.ts:170` runs before `:174`) |
| 5 | A second `/update` while that exit is deferred: `checkInFlight` is already false and `handoffActive()` is false, so `checkForUpdate` is not refused (`update.ts:258`); with `force` it decides `restart` again | exit still pending | none | absent | P overwritten with the second requester (`update.ts:303-309`) | none | The first requester's report is lost. `requestRestart` is a no-op the second time (`restart.ts:277`) | #449 (commands-report-interaction-9) |

### B. Build

| # | Failure point | original (O) | standby (R) | handoff.json | state.json (A, P) | `-next` / guard / `.env` / lock | Recovered by, or WEDGES | Covered by |
|---|---|---|---|---|---|---|---|---|
| 6 | `inspectSelf()` throws (`redeploy.ts:218-221`): hostname lookup, daemon error or the 60 s bound (`docker.ts:141-156`) | running, not quiesced (`beginHandoff` is later, `:260`) | none | absent (`clearMarker` ran, `:214`) | A stays. P cleared and saved by `applyUpdate` (`update.ts:347-348`) | none; guard allows | `/update` (force) bypasses A (`update.ts:87`). Unforced ticks stay suppressed until a newer commit changes `latestSha`. The `/update` reply says "did not complete the handoff: could not inspect own container ... I removed it" (`handoff.ts:160-163`); nothing was ever created, so "I removed it" is false | AUTO silent plus suppression: #505 (self-update-handoff-2). Wording: #451 (it also fires when nothing was created) |
| 7 | The build fails, or the 15-min bound aborts it (`redeploy.ts:228-239`; `docker.ts:40`, `:204-228`) | running; scheduler NOT quiesced (`redeploy.ts:250-260`). `checkInFlight` is held for the whole build (`update.ts:261`, `:314-316`), so every other `/update` answers `busy` (`:258`), and that text promises a report (`commands.ts:376`). On the AUTO path the tick watchdog frees the tick guard after 5 min (`announce.ts:149`, `:182-191`) but not `checkInFlight` | none (the daemon may or may not keep building after the client gives up [D]; no container is created) | absent | as row 6 | none; guard allows | as row 6 | #505 (-2), #449 (busy text), #451 |
| 8 | O's process dies during the build (`redeploy.ts:228-232`): SIGTERM from `docker stop` or a reboot (the drain waits <= 8 s because no handoff exemption exists yet, then `exit(0)`: `shutdown.ts:34`, `:113-142`, `restart.ts:82-84`); an OOM kill; or a `bot-ops.sh` restart, recreate or env-set (so also the panel's Restart and Apply) whose guard PASSED because no `-next` exists before row 9 (`bot-ops.sh:389`) | dead; back via its policy unless explicitly stopped [D] | none | absent | A and P stay armed on disk | none; guard allows; a bot-ops run may hold the lock (`:403-409`) and knows nothing of the swap | Normal boot. P is consumed at `index.ts:446` and reads "noop ... image wasn't rebuilt" (false cause, `updateReport.ts:38`, `:52-57`). Unforced ticks stay `suppressed` (`update.ts:87`) until a newer commit or `/update` (force) | #450 (self-update-handoff-3, docker-restart-7). The bot-ops trigger is new information: section "Interactions" |

### C. Create the standby, and the original's wait

| # | Failure point | original (O) | standby (R) | handoff.json | state.json (A, P) | `-next` / guard / `.env` / lock | Recovered by, or WEDGES | Covered by |
|---|---|---|---|---|---|---|---|---|
| 9 | After `beginHandoff` (`redeploy.ts:260`): the leftover sweep `removeContainer(<N>-next)` (`:263`), `createContainer` (`:264-267`; a throw inside `buildCreateSpec` is also caught here, e.g. a tmpfs mount yields an invalid bind, redeploy-10) or `startContainer` (`:268`) throws. The catch removes by id or name (`:286`) and calls `endHandoff()` (`:289`) | running, un-quiesced again | removed, best effort | absent | A stays, P cleared (`update.ts:347-348`) | normally none. If the cleanup removal also throws it is only logged (`:287`): a created or exited `-next` is left and the guard REFUSES (`bot-ops.sh:389-391`) | Normal case: as row 6. Leftover: `/update` (force) sweeps it (`:263`) only when the decision is not `current`; a newer commit's AUTO redeploy sweeps it; or `docker rm <N>-next` | #491 (redeploy-10); #490 (redeploy-2 class); #451 |
| 10 | O's process dies after R started and before the verdict, daemon alive (an OOM kill, a crash) | Docker restarts O in place (`unless-stopped`) [D]: a normal boot, ticks run, P consumed -> a false "noop" report | keeps booting (policy `no`, never restarted by Docker, `redeploy.ts:184`), logs in, `takeOver` finds O running again and stops it (`:477-494`): the swap LANDS | `ready`, then cleared by R (`:641`) | A armed (R's first `current` clears it). P consumed by O' and still in R's import-time snapshot (`state.ts:41`) [inferred] | `-next` exists until R's rename; guard REFUSES in that window | The swap completes by itself. The requester gets a false "noop" from O' and an "updated" from R [inferred] | #450 for the false report; the second report is new information |
| 11 | Host reboot, power loss or `dockerd` restart between R's start and the verdict | back via its policy [D] as a normal boot; its `redeploy()` is gone | stays `exited`: policy `no` [D] | absent, or a stale value R wrote before the stop | A and P armed; P -> false "noop" (as row 8) | an exited `-next` EXISTS and O runs: the guard REFUSES `restart`, `recreate` and `env-set` (probe 1), with "try again once it completes", which never becomes true. A plain `compose up -d` or Dockge has no guard | `docker rm <N>-next`; or `/update` (force) while the running sha is still stale (the sweep at `redeploy.ts:263`); or a newer commit's AUTO redeploy. NOT by `/update` once the build is current: `current` returns before `applyUpdate` (`update.ts:81`, `:286-290`, `:313`). **WEDGES** (bot-ops and panel mutations) | #490 (redeploy-2); #450 |
| 12 | An operator `docker stop <N>` of O alone during the wait | drains <= 8 s with the handoff exemption (`restart.ts:82-84`, `:255-269`), `exit(0)`, STAYS down (explicit stop) | continues, verifies, `takeOver` takes the non-live branch: stop is a no-op, remove, rename (`redeploy.ts:495-499`, `:505-523`) | `ready`, then cleared | as row 10 | `-next` renamed away | R completes the swap; nothing to recover | n/a (works) |
| 13 | A bot-ops recreate or env-set (so also the panel's Apply or Restart) passes the guard just before R exists (`bot-ops.sh:689`, `:996`), waits <= 60 s on the config-dir lock (`:690`, `:997`, `:402-409`), then recreates (`up -d --force-recreate`, `:954`). The bot never takes that lock. `restart` has the same ordering (`:660-661`) with an in-place effect. A plain `compose up -d` has no guard at all | O's process is stopped by the recreate; O' is a NEW container id built from compose + `.env` + `<project>-bot:latest`, which still names the OLD image (`tagLatest` has not run) | `takeOver` retires `HANDOFF_FROM` = the old id: inspect 404 -> "already gone" -> returns before the rename (`redeploy.ts:513`) -> R goes live named `<N>-next` | `ready`, then cleared | A armed; P in both snapshots | TWO live bots on one token: O' (old build, `<N>`) and R (new build, `<N>-next`). Whether compose also recreates R is unverified [D]. A re-run guard would REFUSE while R exists | Nothing recovers it; an operator stops one by hand. **WEDGES** (double replies until then) | #473 (ops-bot-ops-sh-1). Its suggested fix (re-check after the lock) does not close the build-window variant, row 8 |

### D. The standby boots; the original polls

| # | Failure point | original (O) | standby (R) | handoff.json | state.json (A, P) | `-next` / guard / `.env` / lock | Recovered by, or WEDGES | Covered by |
|---|---|---|---|---|---|---|---|---|
| 14 | O's poll throws once: `tryInspectContainer` gets a 5xx or hits the 60 s bound (`docker.ts:167-177`) inside `awaitHandoff` (`redeploy.ts:402-405`). The catch (`:333-342`) sets `failed` and `observedAt` is still 0 (`:299`) | the generation guard (`:359-373`) sees R running with `StartedAt` > 0 and SKIPS the removal; `endHandoff` (`:386`) and `clearMarker` (`:387`) run; returns `failed`; the requester is told "I removed it" (`handoff.ts:160-163`) | ALIVE and booting; still reaches `takeOver`, writes `ready` (nobody reads it), retires O: the swap LANDS after the reported failure | cleared by O (`:387`); R rewrites `ready`, then clears | A stays. P cleared and saved by O (`update.ts:347-348`), but R's import-time snapshot may predate that clear: R then still delivers "updated" [inferred] | `-next` exists until R renames; guard REFUSES while O runs. If R instead fails verification it exits (policy `no`) and an exited `-next` is left: row 11's wedge | Self-heals when R verifies. Otherwise as row 11 | #431 (redeploy-1); #451 |
| 15 | The same poll reads marker `ready` and its inspect throws (`Promise.all`, `redeploy.ts:402-405`): the `ready` is discarded, same catch | as row 14 | may already be inside `retire`, stopping O | `ready` | as row 14 | as row 14 today, where the skipped removal masks it. Once #431 removes that skip, `:374` force-removes R while it is stopping O: ZERO bots | Not recovered once it happens (O is stopping, R is gone); an operator runs `bot-ops.sh recreate` or `docker start <N>` [D]. **WEDGES (latent)** | #433 (redeploy-4) |
| 16 | R crashes or exits before login (a config the new build refuses, an import error) | running, quiesced | `exited`, stays so (policy `no`) [D] | absent | armed | `-next` exists, exited, briefly | O's next poll sees `!running && status != created` -> `failed` (`handoff.ts:126-127`, poll `redeploy.ts:42`) -> `removeContainer(R)` (`:374`), `endHandoff`, `clearMarker`, report. Clean | n/a (works; wording #451) |
| 17 | R never reaches `ClientReady`: its 90 s verify timer (`index.ts:467-479`) writes `failed` and exits 1. The timer is created only after `loadPluginIndex` (<= 5 s), `readPluginState` and `resolveBootMode` (<= 10 s) (`index.ts:69-78`, `:128`), so O's own 120 s clock (`handoff.ts:128`, started at `redeploy.ts:399`) can fire first as `timeout`. The callback has no try/catch: a throwing `writeMarker` skips the `exit(1)` | quiesced up to 120 s | exits 1, or lives on after a thrown write until O removes it | `failed`, or absent | armed | `-next` exists until removed | O removes R (`:374`), `endHandoff`, clears the marker; "never reported in within 120s" (`handoff.ts:139-145`). Clean | #506 (self-update-handoff-14); #494 (boot-config-http-13); #492 (redeploy-15) |

### E. R takes over

| # | Failure point | original (O) | standby (R) | handoff.json | state.json (A, P) | `-next` / guard / `.env` / lock | Recovered by, or WEDGES | Covered by |
|---|---|---|---|---|---|---|---|---|
| 18 | `takeOver`'s `write(ready)` throws (`redeploy.ts:621`; volume unwritable). The catch (`:642-662`) tries a `failed` write, which also fails (swallowed, `:660`), then `exit(1)` | quiesced, still the only live bot | exits 1 | absent | armed | `-next` exists, exited, briefly; O was never stopped | O sees R gone -> `failed` (`handoff.ts:127`) -> removes R. Clean | n/a (works) |
| 19 | `tagLatest` throws (`redeploy.ts:547-550`, `:628-633`): swallowed on purpose | quiesced | continues | `ready` | armed | `:latest` NOT moved: after the swap a later `bot-ops.sh` env-set or recreate (no `--build`, `bot-ops.sh:941-954`) rebuilds from the OLD `:latest` and silently rolls back | The swap lands. Repaired by the next successful update (the log line says so, `redeploy.ts:629-632`) | n/a (documented in that log line) |
| 20 | `restorePolicy()` throws, or the daemon applied the update and the response was lost (`redeploy.ts:557-561`, `:639`): `failed`, `exit(1)` | quiesced -> reclaims on `failed` (<= 2 s) | exits 1. Lost-response variant: its policy is already `unless-stopped`, so Docker restarts it; if that is after the decision the generation guard leaves it alone and it re-runs the whole standby cycle and can land the swap late (docstring `redeploy.ts:590-602`) | `failed` | armed; P cleared | `:latest` ALREADY moved (`tagLatest` ran, `:628`). `-next` exists, exited, until O removes it | O removes R and the requester is told "failed", but `:latest` names the new build, so a later env-set, recreate or compose up deploys it anyway | #490 (redeploy-7); #451 |
| 21 | `retireOriginal` throws BEFORE the stop took: `tryInspectContainer(O)` throws (`redeploy.ts:471`), or `stopContainer(O)` throws and the re-inspect still shows O running (`:485-494`). Catch: `failed`, `exit(1)` | alive, reclaims | exits 1 | `failed` | armed | as row 20 (`:latest` moved) | as row 20 | #490 (redeploy-7) |
| 22 | After the stop (`redeploy.ts:500-504`): `removeContainer(O)` throws (`:505-511`), then the rename R -> `<N>` fails: the corpse holds the name, or `inspectSelf` or the rename errors (`:515-523`). Both only warn | the corpse: stopped, still named `<N>` (explicit stop, stays down [D]) | LIVE and serving, still named `<N>-next`, policy restored | cleared (`:641`) | as row 0 | `-next` exists and IS the live bot; `<N>` is the corpse, so the guard ALLOWS. `bot-ops.sh` `status` and `logs` look up `<N>` (`:623`, `:655`): the corpse, so the panel shows the bot stopped. The next swap names its R `<N>-next-next` (`redeploy.ts:249`) | A reboot, daemon restart or in-place restart of R heals it: boot -> `resolveBootMode` finds the corpse -> standby -> `takeOver` -> retire again (remove, rename), documented at `redeploy.ts:704-713`. Otherwise by hand: `docker rm <N>`, then `docker rename <N>-next <N>`. Whether `bot-ops.sh recreate` heals it is unverified [D]. **WEDGES** (ops tooling blind; the bot is up) | #492 (redeploy-16) names the state, but its fix (derive the name, sweep only non-running) does not heal it: NEW-1 |
| 23 | R dies, or the host reboots, after `stopContainer(O)` and before the rename (`redeploy.ts:486`, `:517-518`) | stopped (explicit) [D], or already removed | policy already restored (`:639` precedes `:640`), so Docker restarts it | `ready` left in the volume if R died before `:641`; inert until the next redeploy clears it (`:214`) | as row 0 | If O's corpse still exists: R boots standby, retries, converges (as row 22). If O was already removed: `resolveBootMode` gets a 404 -> `normal` (`redeploy.ts:731`), R goes live and is NEVER renamed (the rename lives only in `retireOriginal`): it stays `<N>-next` with no `<N>` at all; the guard allows; `status` says not running | By hand: `docker rename <N>-next <N>` (a `recreate` is unverified [D]). **WEDGES** (ops tooling blind) | NEW-1 (same child as row 22) |
| 24 | R dies hard after writing `ready` and before retiring (SIGKILL, OOM). A thrown error writes `failed` instead (rows 20-21) | quiesced for up to 180 s: `awaitRetirementFailure` polls only the marker (`redeploy.ts:316`, `:427-437`) | exited | `ready` | armed | `-next` exists, exited | After 180 s O decides `stalled` (`:321`), removes R, resumes, and tells the requester "verified but never retired me ... Check the daemon socket" (`handoff.ts:145-154`): the wrong hint when R simply died | #491 (redeploy-13) |

### F. After the verdict

| # | Failure point | original (O) | standby (R) | handoff.json | state.json (A, P) | `-next` / guard / `.env` / lock | Recovered by, or WEDGES | Covered by |
|---|---|---|---|---|---|---|---|---|
| 25 | O's final cleanup: `removeContainer(R)` throws (409 mid-teardown, the 60 s bound; `redeploy.ts:374-380`), or the generation guard skips it (rows 14, 20) | running, un-quiesced (`endHandoff` first and synchronous, `:386`); marker cleared (`:387`); told "I removed it" regardless (`handoff.ts:141-142`, `:152-153`, `:162`), because `RedeployResult` carries no removal status (`redeploy.ts:390`) | removal failed: alive or exited. Skipped: alive | absent | A stays, P cleared | an exited `-next` -> the guard REFUSES (row 11's wedge); an alive R may still land the swap (row 14) | as rows 11 and 14 | #451 (message); #490 (redeploy-2) |
| 26 | A marker is left behind: R wrote `ready` or `failed` after O gave up, R died before `:641`, or a surviving earlier R writes during the next attempt's build. The marker is cleared only at `redeploy.ts:214`, before the build and the sweep | -- | -- | stale `ready` or `failed` | -- | -- | Inert until the next `redeploy()` clears it (`:214`). A still-alive earlier R can have its verdict attributed to the new attempt (redeploy-14). Nothing else reads it | #491 (redeploy-14); #506 (self-update-handoff-10) |
| 27 | R is live and `activate()` runs (`index.ts:138`, `:146-462`). It starts the scheduler (`:316`) BEFORE `reportUpdateOutcome` (`:446`). The report is cleared and saved before delivery (`updateReport.ts:160-161`): a rejecting `saveState` escapes and leaves P on disk (it re-fires next boot); three failed routes drop it (`:95-115`); an AUTO tick that decides `restart` first overwrites P with `undefined` (`update.ts:303-309`) | gone | live | absent | P consumed or lost; A cleared by R's first `current` | none | Delivery is at-most-once by design; a newer commit landing in R's first seconds drops the owed report | #506 (self-update-handoff-12); #452 |
| 28 | Any later in-place restart of the swapped-in R (reboot, daemon restart, crash loop, `bot-ops.sh restart`, which the guard allows once the rename happened). `HANDOFF_FROM` is baked in and never clears (`redeploy.ts:459-466`) | gone | restarts under the restored policy (`:557-561`) | absent | -- | none | `resolveBootMode` asks the daemon (`redeploy.ts:722-735`): O 404 -> `normal`, boots as the bot. A timed-out or erroring inspect stays `standby` (`:732-734`): verify timer plus `takeOver` (O gone: retire returns at `:513`) -> live; if the daemon keeps failing, `takeOver` exits 1 and Docker restarts R until the daemon answers | n/a (documented, #46) |
| 29 | AUTO_UPDATE tick path. The `autoUpdate` check (`announce.ts:226-229`) runs `checkAutoUpdate` (`:309-312`) inside the tick's `withCritical` (`:301`). No requester, so P is `undefined` (`update.ts:109`, `:303-308`) and the result is discarded (`announce.ts:311`). Failed builds, create or start errors and every `failed`, `timeout` or `stalled` outcome end as one `console.warn` (`update.ts:349`) | running | per rows 6-25 | per rows 6-25 | A set, P `undefined` | per rows | Every later poll for that sha logs `suppressed` (`update.ts:292-297`; the text blames the orchestrator) until a newer commit changes `latestSha`, or an admin runs `/update` (force). Nobody is told | #505 (self-update-handoff-2); #506 (self-update-handoff-13); #429 |

## Rows that wedge

- **Row 11** (and its generators in rows 9, 14, 25): an exited `<N>-next` makes `bot-ops.sh` restart, recreate and
  env-set (so the panel's Restart and Apply) refuse forever. Covered by #490; see "Interactions", item 2.
- **Row 13**: two live bots after a recreate that outran a stale guard. Covered by #473.
- **Row 15** (latent): a poll error on a `ready` replacement, once #431 stops masking it, removes the only verified
  bot. Covered by #433, which must land with #431.
- **Rows 22 and 23**: the live bot is left named `<N>-next` and nothing renames it back. NEW-1.

Not wedges but silent stalls (recoverable with `/update` force or a newer commit, and nobody is told): rows 4, 6,
7, 8 and 29. Covered by #450, #505 and #506.

## Cross-check against the named findings

Every row was read against these seven. "Holds" means the finding is true as filed at `c783ad0`.

- **#431 (redeploy-1)**, rows 14 and 25. Holds. Refinements: (a) R is not always "healthy and finishing": if it
  fails verification it exits under policy `no` and leaves an exited `-next`, which is row 11's wedge. (b) The
  filed consequence "no follow-up report is sent" depends on timing. R snapshots `state.json` at import
  (`state.ts:41`); if the poll error lands after that, R's copy of P survives O's clear and R delivers "updated"
  after O said "failed"; if it lands before, the report is dropped [inferred]. (c) Its suggested fix alone turns
  #433 live (row 15).
- **#433 (redeploy-4)**, row 15. Holds. It must land with #431. The decision it needs is wider than "read the
  marker first": a `ready` marker with a failing inspect should never end in removal, because R is about to stop O.
- **#450 (self-update-handoff-3, docker-restart-7)**, rows 8, 10 and 11. Holds. Refinements: (a) the triggers are
  wider than a reboot, OOM or operator restart: a `bot-ops.sh` mutation or the panel's Apply during the build
  passes the guard (no `-next` yet) and kills the swap. (b) In row 10 the swap lands anyway, so the requester gets
  two contradictory reports. (c) Its suggested "clear A when a boot finds P with no `-next` container" would be
  wrong in row 10, where R is alive and will land the swap.
- **#451 (self-update-handoff-8)**, rows 6, 7, 9, 14, 20 and 25. Holds, and is wider than filed: "I removed it" is
  also false when nothing was ever created (build failure, `inspectSelf` failure, rows 6-7). A `removed: boolean`
  is too small; it needs "nothing was created", "removed" and "could not remove".
- **redeploy-2 in #490**, rows 9, 11, 14 and 25. Holds as filed. Refinements: (a) reboot is only one generator;
  a failed cleanup (row 9), a failed removal (row 25) and a generation-guard skip followed by a failed
  verification (row 14) all leave the same exited `-next`. (b) The verifier's recovery claim, "Admin /update
  (force) clears it", is false once the operator has followed the report's advice and rebuilt (item 2 below).
- **ops-bot-ops-sh-1 in #473**, row 13. Holds (order read at `bot-ops.sh:660-661`, `:689-690`, `:996-997`).
  Refinements: (a) the same hole exists across the build window, where no `-next` exists yet (row 8), and a
  re-check after the lock cannot close it; that needs a swap-in-progress signal visible from the start of the
  build. (b) The lock never serialises the bot's redeploy, only bot-ops runs. (c) A plain `compose up -d` or a
  Dockge restart has no guard (item 6 below).
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
   confirms the guard half; the rest is read.
3. **A stale snapshot makes the owed report neither lost nor single** (rows 10, 14). R reads `state.json` at import
   and rewrites it whole (`state.ts:41`, `updateReport.ts:160-161`), so O's clear of P (`update.ts:347-348`) does
   not reach R when R booted first. The requester can get "failed" from O and "updated" from R, or a false "noop"
   from a restarted O' and "updated" from R. The #450 and #431 fixes assume one writer of P per attempt [inferred].
4. **Fixing #431 alone activates #433** (rows 14, 15). Today the generation guard skips the removal on the poll-error
   path; the fix removes that skip, and a `ready` marker discarded by the same `Promise.all` then lets `:374`
   remove R mid-retire. The two are one change.
5. **No code path renames a live `-next` bot back** (rows 22, 23). The rename exists only inside `retireOriginal`
   (`redeploy.ts:515-523`); a normal-mode boot (`resolveBootMode` 404, `:731`) never re-enters it. #492's fix stops the
   name drifting but does not heal the live container. NEW-1.
6. **Only bot-ops has the guard.** The same hazards (rows 8, 13) are reachable through a plain `compose up -d` or a
   Dockge restart, which the code comments name as supported recreate paths (`redeploy.ts:79-85`). Nothing in the
   repo can guard those; the swap would have to expose its in-progress state to anything that recreates.
7. **R is built from O's container env, not `.env`** (`redeploy.ts:153-159`). A `.env` edit saved but not yet
   recreated (the recreate that failed after `.env` was rewritten, `CONTEXT.md:1741-1755`) is not carried into R. The swap
   reports success on the old values; the next recreate applies the edit. Not a wedge; recorded because the
   column asks about `.env`.

## Children filed

NEW-1 only: rows 22 and 23. Every other wedge row is covered by an existing issue (#490, #473, #433). See the PR
body for the issue number, its sub-issue link and the edit to #525's list.

## What this did not verify

- Anything needing Docker: restart-policy outcomes after reboots and explicit stops, `ps -a --filter name=`
  semantics, compose's treatment of a second labelled container (rows 4, 8, 10-13, 22-23). Marked [D].
- The two-writer interleavings in "Interactions" 3 (marked [inferred]); no concurrency was executed.
- `ops/bot-ops.test.ts` and `ops/docker-compose.test.ts` skip on this box (no `docker compose`); the guard was
  checked by probe 1 only.
