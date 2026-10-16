<!-- Plan for sub-epic #525 of Epic #516 (Rackbops/rackbops-discord-bot), bundle S3b-1: the bot-ops swap guard.
Written by the orchestrating session on 2026-10-16 against `main` @ `cccd683`; audited read-only against that
tree before it was committed (14 findings, all applied: `created` now refuses, multi-match fails closed, the
runbook branches on the log instead of a clock). Every file:line below was read from that tree; the implementer
re-reads each one on the tree it works from and corrects any that moved. -->

## Implementation plan -- #525 bundle S3b-1: the swap guard keys on an ALIVE `-next`, not on its existence

Children: **#490 item 2** (`redeploy-2`), and the probation window bundle S3a leaves open (its decision 4). One
PR: `ops/bot-ops.sh`, `ops/bot-ops.test.ts`, two comment ranges in `src/redeploy.ts` and `src/redeploy.test.ts`
that describe the guard, the docs that describe it, and the state table. A behaviour change (the guard
decides whether an operator can recreate the bot), so the **three-reviewer gate** applies: you plus two
read-only adversarial reviewers, up to four rounds. The `bot-ops.test.ts` subprocess tests run on this box
(jq, bash and shellcheck are present; `flock` tests stay CI-only) at roughly 400 s a file, so run the two
guard describes with `-t` while iterating and the whole file once at the end.

Independent of S3a and S3b-2 in CODE. Three files overlap in prose: `ops/README.md` (S3a edits `:413-414`;
S3b-2 adds a sentence beside this bundle's runbook), the state table (S3a edits rows 19-25 and the
"Children filed" section; S3b-2 rows 22-23) and `CONTEXT.md` (S3a and S3b-2 edit bot rows; this bundle only
the `ops/bot-ops.sh` row and the lock gotcha). Whichever PR lands second rebases those files onto the
first's wording. It can start now, from `origin/main`.

### What is wrong, verified at `cccd683`

`guard_no_handoff_in_progress` (`ops/bot-ops.sh:388-393`), called before `restart` (`:660`), `env-set`
(`:689`) and `recreate` (`:996`), refuses when a `<name>-next` container EXISTS (`docker ps -a`, `:389`)
AND the canonical name is RUNNING (`:390`). Two wrong answers:

- **An exited `-next` locks the operator out.** A host reboot or daemon restart between
  `startContainer` and the handoff's resolution leaves the standby exited for good (its own policy is
  `no` since #160, `src/redeploy.ts:184`) while the original comes back under `unless-stopped` and runs on.
  The guard then refuses `restart`, `env-set` and `recreate` with "try again once it completes" until a
  later redeploy sweeps the name (`src/redeploy.ts:263`), which the anti-loop suppression can defer
  indefinitely for the same sha. (#490 item 2; the verifier confirmed the mechanism and narrowed it to
  "needs a reboot inside the swap window".)
- **A running `-next` beside a non-running canonical passes.** After bundle S3a the original is STOPPED
  but kept for the seconds between the replacement's login and the end of its probation (`activate()`
  plus the first tick), with the canonical name on the corpse and the live bot still `<name>-next`. In
  that window the guard allows a `recreate` (the panel's Restart is `recreate` since #277), which
  `compose up -d --force-recreate`s the canonical container beside the live `-next`: two bots on one token
  (state table rows 22-23 name this "row 13's outcome"). S3a makes the replacement step aside when it
  finds the original running, so the damage is one inspect long, but the guard should not have allowed
  it. The same pass happens today for #547's state (a live bot never renamed back).

### Decisions (defaults, named so the gate can contest them)

1. **The signal is the `-next` container's STATE, read once with `--format '{{.State}}'`, and only
   `exited` and `dead` are leftovers.** Everything else refuses: `running`, `restarting` (a crash loop
   between restarts), `paused`, `removing`, and `created`. `created` refuses on purpose: EVERY swap passes
   through it for the length of the `startContainer` call (`src/redeploy.ts:264-268` runs create and
   start back to back), and the old guard closed exactly that window (its comment at
   `ops/bot-ops.sh:345-353`); treating it as a leftover would reopen a race on every swap to spare a
   lockout that needs a process death inside that same gap (cleared with `docker rm <name>-next`,
   documented). Two or more matches (the filter is a regex and `CONTAINER` may contain `.`,
   `ops/bot-ops.sh:150`) fail closed: one alive line refuses.
2. **Two messages, one per refusal.** `-next` alive and the canonical running: the existing
   "a self-update is in progress (…) — try again once it completes", now naming the state. `-next` alive
   and the canonical NOT running: "a self-update is finishing (container '<name>-next' is <state> and
   '<name>' is not running) — try again in a minute; if it persists, read `docker logs <name>-next` and see
   ops/README.md (a new build that keeps crashing: `docker start <name>` rolls back; one that is up but
   never took the name: rename it)". The second case is S3a's probation (seconds), S3a's crash loop
   (until the operator rolls back) or #547's never-renamed bot; in every one of them a `recreate` would
   start a second bot, and the old behaviour allowed it.
3. **The way out of a persistent "finishing" refusal is written into `ops/README.md`, keyed on the log,
   never on a clock** (`activate()` can legitimately take longer than a minute on a cold plugin install):
   `docker ps -a --filter name='^/<name>' --format '{{.Names}} {{.State}}'` and `docker logs --tail 50
   <name>-next`. (a) The log shows repeated boots (`Logged in as`, then a crash, again and again), or the
   state flips through `restarting`: the new build is crash-looping in probation; `docker start <name>`
   brings the old build back and the new container steps aside and stays stopped (S3a). (b) The log ends
   in `[handoff] could not take the name` or `could not remove the stopped original` and the bot is up:
   the swap finished but the rename did not; `docker rm -f <name>` (the stopped corpse) then
   `docker rename <name>-next <name>`. (c) Neither yet: wait; probation is still running. Nothing here
   says what S3b-2 will add; that bundle writes its own sentence.
4. **This reverses the three "stuck-but-healthy" tests of #51** (`ops/bot-ops.test.ts:1084-1105`:
   restart/stopped, env-set/stopped, restart/gone): a running `-next` beside a stopped or gone canonical
   is now REFUSED. Their rationale (the only such state was a cosmetic rename failure) no longer holds:
   S3a makes that state every swap's normal probation, where a recreate is exactly the two-bots race the
   guard exists to stop. Rewrite the describe's comment, do not delete the history.
5. **No `BOT_OPS_SCHEMA` bump:** no subcommand and no `ALLOWED_SPEC` row changes (`ops/bot-ops.sh:70`'s
   own rule). No `ops/admin` change: the panel's Restart posts `/api/recreate` (`ops/admin/server.ts:559-560`)
   and relays the script's stderr verbatim as a 502 (`:2118`). Rollout: the deployed `bin/bot-ops.sh`
   changes only when `ops/install.sh` is re-run on the box; say so in the PR (an operator step, not a
   schema bump).

### Step 1 -- `ops/bot-ops.sh`

Replace `:388-393` with:

```bash
guard_no_handoff_in_progress() {
  local states alive
  # One `ps -a` with `{{.State}}` (not `{{.Names}}`): the question is whether the replacement is ALIVE,
  # not whether it exists — an exited (or dead) `-next` is a leftover the next self-update sweeps (#490).
  # Anything else — running, restarting (a crash loop), paused, removing, and `created` (every swap sits
  # there for the length of its start call) — means a swap is in flight or just finished. The filter is a
  # regex, so more than one line is possible; one alive line is enough to refuse (fail closed).
  states="$(docker ps -a --filter "name=^/${CONTAINER}-next$" --format '{{.State}}' 2>/dev/null || true)"
  [ -n "$states" ] || return 0
  alive="$(grep -vxE 'exited|dead' <<<"$states" | head -n1 || true)"
  [ -n "$alive" ] || return 0
  if docker ps --filter "name=^/${CONTAINER}$" --format '{{.Names}}' 2>/dev/null | grep -q .; then
    die "a self-update is in progress (container '${CONTAINER}-next' is ${alive} and '${CONTAINER}' is still running) — try again once it completes"
  fi
  # The replacement is alive and the canonical name is not running: the seconds after its login while
  # the new build proves itself (#548), a new build crash-looping in that probation, or a swap whose
  # rename never landed (#547). In each a recreate would start a second bot beside it, so refuse and
  # point at the runbook, which tells the three apart by the replacement's log.
  die "a self-update is finishing (container '${CONTAINER}-next' is ${alive} and '${CONTAINER}' is not running) — try again in a minute; if it persists, read 'docker logs ${CONTAINER}-next' and see ops/README.md (a new build that keeps crashing: 'docker start ${CONTAINER}' rolls back; one that is up but never took the name: rename it)"
}
```

Check the script's `set` options at its top for `pipefail` (the `|| true` after `head` is there for it)
and that `die` is defined above `:388`. Rewrite the comment block above the function (`:339-387`; both
`:339-343` and `:363-373` state the old signal "exists AND the canonical name still resolves to a RUNNING
container", `:376` starts "guard):"): the signal is now the `-next` state alone, with the canonical's
running state choosing the message; keep the #51/#160 history in two sentences; keep `:345-353`'s point
about the early window (it is why `created` refuses). `bash -n ops/bot-ops.sh` and `shellcheck
ops/bot-ops.sh` clean (shellcheck is installed on this box).

### Step 2 -- `ops/bot-ops.test.ts`

- The shim (`:143-154`, `:232-240`): replace `opts.nextRunning: boolean` with `opts.nextState?: string`
  (every existing `nextRunning: true` becomes `nextState: "running"`; the stale `nextRunning` mentions at
  `:88`, `:90`, `:98`, `:102`, `:144`, `:147`, `:243` and `:1062` are reworded). The `-next` branch answers
  the state when the query carries `{{.State}}` and the name otherwise:

  ```bash
  if [[ "$1" == "ps" ]] && [[ "$*" == *"-next"* ]]; then
    if [[ "$*" == *'{{.State}}'* ]]; then printf '%s\n' "<nextState>"; else printf '%s\n' "probe-container-next"; fi
  elif ...
  ```

  The `containerMeta` block (`:244-250`) is a separate `if`, not an `elif`, so give it
  `&& [[ "$*" != *"-next"* ]]` and reword its comment (`{{.State}}` is no longer unique to `status`). The
  `answersCanonicalQuery` logic (`:152-154`) is unchanged: the guard's second query still asks for the
  canonical name without `-a`.
- The describe at `:1040` ("refuses restart/env-set while a swap is mid-flight"): the three tests stay,
  with `nextState: "running"`; the two refusals also assert the message names the state
  (`toContain("is running and 'probe-container' is still running")`).
- The describe at `:1078` becomes "bot-ops.sh refuses a recreate while the live bot is still `-next`,
  and ignores an exited leftover (#490, #548)" with the comment rewritten per decision 4, and these tests:

| # | Test | Pins |
|---|---|---|
| G1 | "restart refuses when <container>-next is running and the original is a stopped corpse — the probation window" (`nextState: "running"`, `originalState: "stopped"`) | exit non-zero; stderr contains `a self-update is finishing` and `is running and 'probe-container' is not running`; no `compose` call |
| G2 | "env-set refuses in the same state — .env untouched, no backup" | as G1 plus `envText` unchanged, no `backups/` |
| G3 | "recreate refuses in the same state, before any compose call" (the shape of `:1791-1796`) | exit non-zero; `finishing`; no `compose` call |
| G4 | "restart refuses when <container>-next is running and the original is fully gone — a swap whose rename never landed" (`originalState: "gone"`) | exit non-zero; `finishing`; stderr contains `docker logs probe-container-next` and `see ops/README.md` |
| G5 | "restart proceeds when <container>-next is exited and the original runs — a leftover of an interrupted swap" (`nextState: "exited"`, `originalState: "running"`) | exit 0; a `compose … restart` call |
| G6 | "env-set proceeds in the same state" | exit 0; `changed: ["ANNOUNCE_CHANNEL_ID"]` |
| G7 | "a created-but-never-started <container>-next still refuses — every swap passes through that state" (`nextState: "created"`, original running) | exit non-zero; `in progress`; message contains `is created` |
| G8 | "the guard reads the -next state with one `ps -a` and `{{.State}}`" (`nextState: "exited"`, original running) | `dockerCalls(fx)` has exactly one entry containing both `-next` and `{{.State}}`, and none containing both `-next` and `{{.Names}}` |
| G9 | table-driven over `nextState` with the original running: `restarting`, `paused`, `removing` refuse (`in progress`, message names the state); `dead` proceeds | one `test.each` |
| G10 | "two matches fail closed: one alive line among exited ones refuses" (`nextState: "exited\nrunning"`, which the shim prints as two lines) | exit non-zero; `in progress` |

- `:1791-1796`'s recreate test keeps its fixture (`nextState: "running"`, original running).

### Step 3 -- comments and docs, in the same PR

- `src/redeploy.ts:270-285` (the create/start failure comment) and `src/redeploy.test.ts:884-887`,
  `:972-974`: they say a lingering `-next` "reads as 'a swap is still in progress'" to the guard. Still
  true for a `created` one (decision 1), no longer for an exited one: add "(a `created` or running one;
  an exited leftover no longer blocks the guard since #490)". Comment-only edits, outside S1's and S3a's
  line ranges; say so in the PR.
- `ops/README.md`: the `restart` / `env-set` / `recreate` rows (`:29-32`) do not describe the guard
  today; ADD one sentence to the `recreate` row (the one the panel's Restart reaches): "refused while a
  `<name>-next` container is alive (running, restarting, paused or created); an exited leftover does not
  block it (#490)". Add the decision-3 runbook paragraph under the env-set section (`:408-414`, beside
  S3a's sentence at `:413-414` if it has merged), headed "A refused restart, env-set or recreate that says
  *finishing*".
- `CONTEXT.md`: the `ops/bot-ops.sh` row (`:201`; grep `guard_no_handoff_in_progress`, which today
  appears only in the lock gotcha at `:658`): ADD the guard's signal in one sentence. `:1757` ("the
  self-update guard") stays true.
- `docs/plans/epics/E516/525-handoff-state-table.md`: the vocabulary line `:62-63` ("exists in any
  state AND `<N>` is running"); rows 9, 11, 13, 14 and 26 and Interactions item 2 (`:221-231`), wherever
  they state the old signal or its consequence; the `bot-ops.sh:339-387` cite; the inline #490 mention at
  `:264-265`. Grep `guard` in the file and list every cell you touched in the PR.

### Coverage table

| Outcome | Step | Test | Mutation that must turn it red |
|---|---|---|---|
| an exited `-next` no longer refuses | 1 | G5, G6, G8 | M1: restore the old body (the `{{.Names}}` existence check plus canonical-running, no state read) — G5, G6, G7, G8 and G1-G4 all red |
| `created`, `restarting`, `paused`, `removing` refuse; `dead` does not | 1 | G7, G9 | M2: `grep -vxE 'exited|dead|created'` (G7 red); M3: `grep -vxE 'exited'` (G9's `dead` row red) |
| a running `-next` beside a stopped canonical refuses, with the finishing message | 1 | G1, G2, G3 | M4: `return 0` when the canonical is not running (the old behaviour) |
| a running `-next` beside a gone canonical refuses, pointing at the log and runbook | 1 | G4 | M4 again; M5: drop `docker logs` and the runbook pointer from the message (G4 red) |
| a running `-next` beside a running canonical refuses as before | 1 | `:1041`, `:1051`, `:1791` | M6: replace the first `die` with `:` |
| the state is read once, with `{{.State}}` | 1 | G8 | M7: a second `ps -a … {{.Names}}` probe added before the state read |
| several matches fail closed | 1 | G10 | M8: `head -n1` BEFORE the `grep -v` (so the first line decides) |
| the docs say what the guard does | 3 | manual: reviewer B reads each edited sentence against `ops/bot-ops.sh` | -- |

Run each mutation in a scratch worktree (`git worktree add --detach <path> <sha>`), with `-t` on the
named test, never in the tree a reviewer is reading. Paste the red test's name per row in the PR.

### Checks, gate, PR

- `bash -n ops/bot-ops.sh`; `shellcheck ops/bot-ops.sh`; `bunx tsc --noEmit -p ops/tsconfig.json`;
  `bun test ops/bot-ops.test.ts` once in full (about 400 s) plus `bun test` from the root once. The
  `flock` tests skip here; CI's Linux run is the evidence for them.
- Gate: reviewer A on correctness (walk every `-next` × canonical state pair: absent / created / exited /
  dead / restarting / running × running / stopped / gone, against the new function and the three call
  sites; the panel's Restart path through `recreate`; a `docker ps` that errors, which `|| true` turns
  into "absent" — fail-open as before, say so; two matching containers; `set -u`/`pipefail` safety);
  reviewer B on claims-vs-code (every edited sentence in `ops/README.md`, `CONTEXT.md`, the two
  `src/` comment ranges, the test comments and the state table against the script). Both read-only.
- Branch `fix/525-S3b1-ops-guard`; title
  `fix(ops): key the swap guard on an alive -next, ignore an exited leftover, refuse a recreate beside the live bot (#490)`.
  Body: `Part of #490 (item 2 lands here)`, `Part of #525` and `Refs #548 #547` (why the second refusal
  exists); the pasted checks; the mutation rows; the gate's rounds; decisions 1-5 as assumptions taken,
  decision 1 (`created` refuses) and decision 4 (the reversed #51 tests) each in their own paragraph; the
  rollout note (re-run `ops/install.sh` on the box). Do not merge.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot. Work in a NEW worktree, never the shared checkout:
  git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-525-S3b1 origin/main -b fix/525-S3b1-ops-guard
Issues: Rackbops/rackbops-discord-bot #490 (item 2; sub-epic #525 of Epic #516). Read #490's body and comments, #548's Decision comment and #547's body first, and rows 9-14, 22, 23 and 25 of docs/plans/epics/E516/525-handoff-state-table.md.
Plan: docs/plans/epics/E516/525-S3b1-ops-guard.md on branch claude/525-plans:
  git -C S:\Repos\rackbops-discord-bot show origin/claude/525-plans:docs/plans/epics/E516/525-S3b1-ops-guard.md
A behaviour change: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Every mutation in a scratch worktree, with -t on the named test. Scratch files: task-unique names (pr-body-525S3b1.md, commit-msg-525S3b1.txt), read back before use. Report the PR link, the pasted checks, the mutation table, the gate's rounds and any deviation. Do not merge.
```
