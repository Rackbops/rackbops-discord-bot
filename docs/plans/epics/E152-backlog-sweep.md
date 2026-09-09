# E152 — #60+ backlog sweep — implementation plan

Status: **CLOSED — epic complete 2026-09-08.** All twelve exit-criterion issues closed via merged
PRs with executed acceptance; live proofs on `debug`: #160 (standby on `no`, restore 17 ms before
the kill, direct observation on the second `/update`), #154 (`die exitCode=0`, then a real `docker
stop` showing the drain lines, 152 ms), #168, #173, #178. Closing comment on #152. Epic issue:
[#152](https://github.com/Rackbops/rackbops-discord-bot/issues/152). Standalone epic (no
predecessor chain — outcome 2 of the epic method is skipped). Written when the epic was picked up
for its second half; every claim verified against `main` @ `b966a90` and the live issues.

This epic is a **priority sweep**, not a feature: the children are disjoint and share no single
exit demo. The plan's job is the ledger, the build order for what is left, the two design decisions
that were still open, and the hand-off plan once E123's subordinates free up.

---

## 1. Exit criterion (as amended on the issue)

`gh issue list --state open` shows none of #61, #85, #88, #130, #138, #139, **#160, #154, #168**
still open, each closed via a merged PR whose acceptance was executed with real output pasted.
#169 (the answer-file decision) is excluded until roshne decides; #60 itself is closed (split).

## 2. Ledger — what is done (verified)

| Child | What | Landed as | State |
|---|---|---|---|
| #130 | bound every daemon call; quiesce only create→verify | PR #156 `ad195ec` | closed |
| #139 | contain the data dir so tests stop rewriting `state.json` | PR #158 `f04d6d6` | closed |
| #88 | bound every GitHub call | PR #159 `67b7b85` | closed |
| #61 | pin the addon-ci reusable workflow to a commit | PR #155 `ce5bf6e` | closed |
| #138 | qualify leftover `nazumods/wow#N` refs | PR #157 `d34b5d9` | closed |
| #60 items 3+4 | `mktemp` trap in install.sh; absolute `BOT_OPS_CONFIG_DIR` (both sites) | PR #162 `33644e9` | closed 2026-09-08 (items 5+6 declined with evidence; 1+2 split out) |
| #85 (removal-side attempt) | PR #161 | **closed unmerged** — the guard was inert (sampled `decidedAt` after the decision; the test stamped a future marker) and, even repaired, defended only a millisecond window | superseded by #160 |

## 3. What is left — build order

```
#160 standby non-resurrecting (M) ── DONE 2026-09-08, PR #177 `f63af29` (subordinate #2, one round;
     round-1 finding: observedAt must be resampled at the decision point, not when `ready` was first
     seen; orchestrator reproduced the restore-after-retire, late-stop and removal-guard mutations);
     #85 closed with it. LIVE PROOF PENDING: rebuild the debug bot from main (carries #160 + #168),
     then a real /update once a newer sha exists (#173 or #154 merging provides it) — that second
     update is the one the new code creates the standby for. ──► #154 SIGTERM drain (M) — DONE
     2026-09-08, PR #179 `e996cda` (subordinate #2, two rounds). **The plan's baseline-snapshot
     re-entrancy design was WRONG** (an interaction + an already-open tick made the snapshot swallow
     the tick); shipped instead: a live exemption of exactly one critical unit while a handoff is
     active — sound because both handoff initiators hold exactly one section. Grace and
     `destroyClient` timeouts now nest under 8 s. Correction recorded on #154 and §6.1 below.
     LIVE PROOF PENDING with #160's step 2 (the same /update exercises both).
#168 log env file + ops paths (S)   ──  DONE 2026-09-08, PR #172 `65d34e2` (subordinate #1, two rounds;
     round 1 caught a static `./storage` import that would have swallowed the env-file line on a bad
     BOT_DATA_DIR — fixed with a dynamic import + explicit exit; a TLA-vs-sibling-import exit race is
     recorded as non-blocking) → subordinate #1 moved on to #173
#169 answer-file shape, option A (S) ── DONE 2026-09-08, PR #174 `4209de0` (subordinate #2, one round;
     orchestrator ran the real install.sh end-to-end in a clean container + the call-site mutation on Linux)
     → subordinate #2 moved on to #160
#173 bot-ops.sh schema stamp + panel banner (S) ── DONE 2026-09-08, PR #176 `4b1d682` (subordinate #1,
     three rounds; the orchestrator's own live run caught round 3's finding: `version` sat behind the
     instance preconditions, so a current script with a broken config dir read as OUT OF DATE — fixed
     by dispatching `version` before any precondition). Deployed to debug's admin the same day.
#178 stack docker-compose.yml drift (S) ── DONE 2026-09-08, PR #180 `81e5ad3` (subordinate #1, one
     round). Found when the debug bot rebuild logged "[boot] env file: (not passed …)": the stack
     compose was the 09-05 copy. `x-rackbops-schema` stamp + `composeSchema` in `version` + a banner
     naming the drifted file. ALL CHILDREN MERGED — only the live proofs and the closing remain.
```

1. **#160 — create the standby with `RestartPolicy: no`, restore the original's policy *before*
   retiring it, treat a late-answering stop as a stop, and key the final removal guard on Docker's
   `State.StartedAt` generation.** Plan embedded on the issue (2026-09-08). Closes #85. Effort M,
   full gate. **The one invariant to carry in your head:** `write ready → tagLatest → restore
   policy → retire → clear`. A restore after the stop plus #130's 60 s bound is a permanent
   zero-bots outage.
2. **#154 — a `SIGTERM`/`SIGINT` handler that drains in-flight critical sections before exiting.**
   Direction 1 decided (2026-09-08); plan embedded. The re-entrancy deadlock is solved with a
   **baseline**: `beginHandoff` records the critical depth at that instant, and the drain waits for
   `critical <= baseline`, so the handoff's own holder never blocks itself while a tick that
   entered later is still waited for. Also makes `writeJsonAtomic`'s temp name per-process (the
   second write site the issue names). After #160, not alongside: same files, and #160's retire
   path is what sends the signal.
3. **#168 — log the env file (bot, via a `BOT_ENV_FILE` env entry in compose and a first-import
   `bootLog` module so it prints before `config.ts` can throw), print it from `bot-ops.sh
   restart/env-set` on stderr, and log the bot-ops script path from the panel.** Plan embedded.
   Effort S, full gate (small). Independent — can run in parallel with #160.
4. **#169 — the deployment answer-file shape.** Options A/B/C on the issue with a recommendation
   for **A** (accept the two-file shape, delete the redundant step-2 prefix, add install-time
   validation of the generated params, record the deviation). Nothing is worked until roshne
   picks; the A plan is written and executable.

## 4. Cross-cutting decisions

| # | Decision | Resolution | Where |
|---|---|---|---|
| 1 | #85's fix direction | **Settled: restart-policy juggling (#160)**; the removal-side guard (#161) is closed as insufficient. Roshne, 2026-09-08 (on #161/#85). | #160 |
| 2 | #154's direction | **Decided: 1 (signal handler + drain).** The re-entrancy rule as first planned (a snapshot baseline) was wrong and was replaced during review by a live one-unit exemption — see §3. Directions 2 and 3 closed. | #154 |
| 3 | Grace period for the drain | **8 s**, under `stopContainer`'s `t=10` and compose's default 10 s SIGKILL. Do not raise the stop timeout to make room. | #154 |
| 4 | #60 item 1 | **Decided A** (roshne, 2026-09-08): accept the two-file shape, delete the redundant step-2 prefix, add install-time validation naming the field, record the deviation. B/C closed. | #169 |
| 5 | Ordering #160 → #154 | Sequential, same files; #168 parallel. | §3 |

## 5. Mutation guards (the load-bearing ones)

| Property | Guard | Mutation that must fail |
|---|---|---|
| policy restored **before** the original is stopped | call-order test: `/update` on self precedes `/stop` on the original | reorder → red |
| a failed restore aborts the takeover (never a silent `no` on the survivor) | `takeOver` restore-throws test | swallow → red |
| late stop re-inspected, not treated as failure | `retireOriginal` stop-throws-but-down test | drop re-inspect → red |
| standby created non-resurrecting; policy rides in env; never stacks | `buildCreateSpec` tests (the two at `:231/:236` rewritten) | copy policy / drop strip → red |
| removal guard keyed on `StartedAt > observedAt` | `redeploy()` generation tests + `wasRemovalAttempted()` on `stalled` | flip comparison / status-only guard → red |
| drain waits for post-handoff critical sections only | `awaitCriticalIdle` baseline tests | compare to 0 → auto-update-path test red |
| handler exits after drain; second signal exits now | `shutdown.test.ts` with fakes | exit early / ignore second → red |
| per-process temp name in `writeJsonAtomic` | concurrent-writers test | fixed `.tmp` → red |
| env-file line prints **before** `config.ts` can throw | first-import source pin + the `/nonexistent` run | move the import → red |

## 5b. Live proofs so far (2026-09-08)

- **#160 — proven.** A real `/update` `4b1d682 → e996cda`: Docker's event log shows `update`
  (the policy restore) on the replacement at 23:09:55.073, then `kill`/`stop` on the original at
  .088/.190 — the ordering invariant live. Survivor on `unless-stopped`, `RestartCount=0`, no
  `-next` leftover. The standby's `no` policy was inferred (creating code + `update` event + final
  state), not read directly — the next run is polled from before the command.
- **#154 — pending.** The original in that run was pre-#154 code (`exitCode=143`, no handler);
  the drain lines and `exitCode=0` are expected on the next stop/update of the `e996cda` bot.
- **#168** — env-file line live after the stack compose refresh. **#173** — schema line live.

## 6. Exit demo

Two live proofs on `debug`, both escalation-gated (they restart the live bot), both after the
corresponding PR merges and is deployed:

- **#160:** a real `/update` **from a bot already running the change** (two-step: rebuild once,
  then `/update` once more) — `<bot>-next` shows `RestartPolicy.Name = no` during verify; the
  survivor shows `unless-stopped`; `docker restart` brings it back.
- **#154:** `docker stop` the bot — logs show `[shutdown] SIGTERM received — draining` then
  `drained … exiting`, exit code 0; a self-update afterwards shows the original's drain lines
  before the replacement's `retired the previous container`.

#168's live check (`[boot] env file: /opt/rackbops-discord-bot/debug/.env` in `docker logs`)
rides on whichever of those deploys comes first.

## 7. Hand-off plan

Both E123 subordinates become free when #165/#166 land. Then, in this order:

- **#168 → first free subordinate** (S, independent, fully planned).
- **#160 → the other** (M, fully planned, full gate; the orchestrator verifies the call-order
  guard personally before merging).
- **#154 → whoever finishes first**, after #160 merges (M, fully planned).
- **#169** stays with the orchestrator until roshne decides; then A is an S for a subordinate.

Footprint checks every 30–45 min; four review rounds then the orchestrator takes the branch.

## 8. Escalations for roshne

1. ~~#169: A, B, or C~~ — **A decided 2026-09-08**; #169 is now an ordinary S child, independent
   of the others (`ops/install.sh` + docs), and joins the exit criterion.
2. **Live proofs** for #160 and #154 each restart the debug bot; each needs your go when its PR
   is ready to deploy. #160's needs two updates back-to-back.
3. Nothing else: #154's direction and the drain grace were decided under your "implement what's
   needed" standing instruction; say so if you'd rather it had been a question.

---

*Once #169 is decided, every remaining child is a `/work-on <n>` in the §3 order. This doc is the
plan of record for E152; update it if the sequence changes.*
