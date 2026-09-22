<!-- Plan for Rackbops/rackbops-discord-bot#227 (Epic #235). Copy of the approved plan comment,
https://github.com/Rackbops/rackbops-discord-bot/issues/227#issuecomment-5769253491, as of when it
was approved, with the implementer's "Deviations from the plan" appended at the end. -->

## Implementation plan — written by the orchestrating session, to be executed as written

Covers **#227** (Epic #235, `ops/bot-ops.sh`, standalone). Written 2026-09-21 against `origin/main` @ `310e260` AND #277's posted plan (its `recreate_bot()` helper and `cmd_recreate`); every cite read from source that day, line numbers as of `310e260` — cite by construct when you search, because **this PR is cut only after #277 has merged** and that PR moves lines in the same file. If the merged #277 differs from what a step below assumes (the helper's name, where `cmd_env_set` calls it), stop and tell the orchestrator rather than adapting. The issue has no `## Acceptance` section, so this plan defines the observable outcomes; execute them and paste the real output.

**Files:** `ops/bot-ops.sh`, `ops/bot-ops.test.ts`, `ops/README.md`, `CONTEXT.md`. No `ops/admin/` file, no `install.sh`, no schema bump (no subcommand and no output shape changes).

### Decided — not open for re-planning

1. **One `flock` on the config DIRECTORY, taken once at the top of each mutating subcommand.** `cmd_env_set` (`bot-ops.sh:869`) is a plain read-modify-write-and-recreate with no lock; `Bun.serve` handles requests concurrently and `createRunBotOps` spawns with no queue, so two saves at once both read the pre-change `.env` and the second `mv` discards the first's keys, silently. The lock is `flock` on a file descriptor opened **read-only on `$CONFIG_DIR` itself** (`exec 9<"$CONFIG_DIR"`), never on a lock file: a lock file created by env-set running as root inside the admin container would be unwritable by the deploy user's own SSH runs, while a directory needs only read+execute to open, which both identities have, and `flock(2)` works on any open descriptor, a directory included. The descriptor is held until the process exits, which is exactly the span that must be exclusive: the read (`load_env_values`), the diff, the backup, the rewrite and the recreate.
2. **Taken by `cmd_env_set`, `cmd_restart` and `cmd_recreate`** (the last exists once #277 has merged), each at its top, right after `guard_no_handoff_in_progress`. Never inside #277's `recreate_bot()` helper: `flock` is per open-file-description, so a second descriptor locked inside the helper while `cmd_env_set` already holds one would block against the caller's own lock. Two concurrent `up -d --force-recreate` on one compose project is the "additionally undefined" case the issue names; serialising the three mutators closes it.
3. **Bounded wait, then refuse.** `flock -w "$LOCK_WAIT_SECONDS" 9 || die "<sub>: another bot-ops.sh mutation is still running on this instance (waited ${LOCK_WAIT_SECONDS}s) — try again"`. `LOCK_WAIT_SECONDS="${BOT_OPS_LOCK_WAIT_SECONDS:-60}"`, declared beside `LOGS_MAX` (`:133`), overridable from the environment the way every `BOT_OPS_*` input is, so a test can make the wait short. 60 s sits under the panel's `SUBPROCESS_TIMEOUT_MS` (90 s, `server.ts:498`), so a second save queued behind a normal recreate (about 20 s) lands rather than 504s, and a save queued behind a wedged one is refused with a reason instead of being killed. A refusal writes nothing and backs up nothing.
4. **`need flock`** inside the lock helper, like `need docker` / `need jq`. `flock` is util-linux, Essential on Debian, so it is in `oven/bun:1-slim` (the admin image, `ops/admin/Dockerfile:1`) and on the deploy host; a box without it must fail loudly, not run unserialised. On this Windows box Git's bash has no `flock`, so the test fixture provides a no-op `flock` shim on its PATH **only when the real one is absent** (the way it already provides a fake `docker`), keeping every existing env-set test green here; the concurrency tests themselves run only where the real `flock` exists (CI's Linux).
5. **The backup name cannot collide:** `.env.bak.$(date +%Y%m%d-%H%M%S)-$$` (the pid). With the lock two saves can no longer share a second, but the name is the record of what was replaced and must never depend on timing; `install -m 600` overwriting a same-second backup is what the issue's second half is about. `ops/README.md:352`'s `.env.bak.<stamp>` becomes `.env.bak.<stamp>-<pid>`.
6. **Nothing changes for the panel**: `env-set`'s JSON (`{ok, changed, recreated, backup, log}`) and every message the page parses are byte-identical; a lock refusal is a `die` before the write, so it is one of `env-set`'s own refusals (`bot-ops: env-set: …`) and #272's `failureWroteNothing` keeps the user's edits, which is the right outcome for "try again". Verify that by reading `failureWroteNothing` in `ops/admin/public/index.html`; do not edit it.

### Step 1 — `bot-ops.sh`: the lock helper

Beside `guard_no_handoff_in_progress` (`:326`):

```bash
# #227: one exclusive lock per config dir around every mutation of it (env-set's read-modify-write
# and the recreate that loads it; restart and recreate too, so two `docker compose` mutations of one
# project never overlap). The lock is on the DIRECTORY's own descriptor, opened read-only — a lock
# file written by root inside the admin container would be unwritable by the deploy user on the
# host — and is held until this process exits. Never taken twice in one process (flock is per open
# file description, so a second descriptor would wait on the first). A bounded wait, then a refusal
# that has written nothing.
LOCK_WAIT_SECONDS="${BOT_OPS_LOCK_WAIT_SECONDS:-60}"
lock_config_dir() {
  local sub="$1"
  need flock
  exec 9<"$CONFIG_DIR" || die "$sub: cannot open $CONFIG_DIR to lock it"
  flock -w "$LOCK_WAIT_SECONDS" 9 \
    || die "$sub: another bot-ops.sh mutation is still running on this instance (waited ${LOCK_WAIT_SECONDS}s) — try again"
}
```

(`LOCK_WAIT_SECONDS` may instead sit beside `LOGS_MAX` at `:133` if the file keeps its constants together; either is fine, say which.)

### Step 2 — `bot-ops.sh`: take it

`cmd_env_set`: `lock_config_dir env-set` as the line after `guard_no_handoff_in_progress` (`:871`), before `[ -f "$ENV_FILE" ]` and everything that reads. `cmd_restart` (`:579`): `lock_config_dir restart` after its guard. `cmd_recreate` (from #277): `lock_config_dir recreate` after its guard. The backup line (`:1011`) gains `-$$`. Update the header comment's description of env-set (`:19`) and the comment above the backup if it describes the name.

### Step 3 — tests (`ops/bot-ops.test.ts`)

Fixture: in `setup()`, when `Bun.which("flock") === null`, write `<bin>/flock` as `#!/usr/bin/env bash\nexit 0\n` (mode 755) beside the fake `docker`, with a comment saying why (Windows has none; the lock's behaviour is CI's). Export `const REAL_FLOCK = Bun.which("flock") !== null` for the `skipIf`s below. Extend `composeUp` with an optional `delayMs` the fake `docker` honours with `sleep` before printing, and have the fake append `compose-up start <epoch-ms>` / `compose-up end <epoch-ms>` lines to `docker.log` around it (only when `delayMs` is set), so overlap is measurable.

| # | Test name | Pins |
|---|---|---|
| 1 | `two env-set saves started at once both land: no key is lost, two distinct backups, the second recreate starts after the first ends` (`skipIf(!REAL_FLOCK)`) | `composeUp.delayMs: 1500`; `Promise.all` of two `botOps(fx, ["env-set"], …)` with different keys; both exit 0; `.env` holds both values; each result's `changed` names only its own key; `backups/` holds two files with different names; `docker.log` shows `end` of the first before `start` of the second |
| 2 | `a save that cannot take the lock in time is refused before the write: .env untouched, no backup, its own env-set prefix` (`skipIf(!REAL_FLOCK)`) | `composeUp.delayMs: 4000`, `BOT_OPS_LOCK_WAIT_SECONDS=1` via `identityOverrides`; the second run exits non-zero with stderr containing `bot-ops: env-set: another bot-ops.sh mutation is still running`; its key is absent from `.env`; exactly one backup exists |
| 3 | `restart waits for an env-set in flight` (`skipIf(!REAL_FLOCK)`) | env-set with `delayMs: 1500` and a concurrent `restart` (`composeRestart` set) → both exit 0 and `docker.log`'s restart call comes after the compose-up `end` line |
| 4 | `the backup name ends in the pid, and the JSON's backup field is that file` | one save; the created file matches `/\.env\.bak\.\d{8}-\d{6}-\d+$/`; `json.backup` equals its path |
| 5 | `without flock on PATH, env-set refuses to run unserialised` | a fixture whose PATH has no `flock` at all (build the env without the shim and without the system PATH's `flock` — on Linux, point PATH at `<bin>` plus a copy of bash/coreutils/jq only; simplest: prepend a directory holding a `flock` that `exit 127`s? no — `need` uses `command -v`, so remove it: run with `PATH` = `<bin>:<dir with symlinks to bash, jq, docker fake, coreutils>`; if that is too brittle on CI, pin the guard by source instead: `lock_config_dir` contains `need flock`, and `cmd_env_set`, `cmd_restart` and `cmd_recreate` each call `lock_config_dir` exactly once, before their first read — say which you did and why) | |
| 6 | `the lock is taken once per process, never inside the recreate helper` (source pin) | `lock_config_dir` appears in exactly the three `cmd_*` bodies and not in `recreate_bot` |
| 7 | the existing env-set, restart and (after #277) recreate describes run unedited and green on this box with the shim | name them in the PR |

### Coverage table

| Outcome demanded | Step | Test | Mutation that must fail it |
|---|---|---|---|
| concurrent saves never lose each other | 1, 2 | 1 | remove `lock_config_dir` from `cmd_env_set` (the second save's `mv` drops the first's key) |
| the lock is bounded and a refusal writes nothing | 1, 2 | 2 | drop `-w`; move the lock after the backup |
| restart and recreate are serialised with env-set | 2 | 3, 6 | remove the call from `cmd_restart`; move it into `recreate_bot` |
| backups never collide | 2 | 4 | drop `-$$` |
| a host without flock fails loudly | 1 | 5 | drop `need flock` |
| docs | 4 | — single read against the merged code | — |

### Step 4 — docs

`ops/README.md`: the `env-set` and `restart` rows of the subcommand table (`:29-31`) say the config dir is locked for the mutation's length and a second one waits up to 60 s then refuses; `:352`'s backup name; a sentence in the Apply-bar section (`:553-571`) that two admins saving at once now land one after the other. `CONTEXT.md`: the `ops/bot-ops.sh` row (Grep it on a short substring), and a new gotcha beside the ops ones — **`env-set`, `restart` and `recreate` hold one `flock` on the config dir (#227)** — the directory-not-file reason, the never-twice-in-one-process reason, the 60 s bound under the panel's 90 s, and that Windows tests run against a no-op shim so the lock's behaviour is CI's.

### Acceptance — execute these, paste the real output

```
bash -n ops/bot-ops.sh
shellcheck ops/bot-ops.sh                                 # no warning main does not already have
bun test ops/bot-ops.test.ts --timeout 240000 -t "lock|backup name|concurr|started at once|waits for an env-set"
```

The three `skipIf(!REAL_FLOCK)` tests are **CI-only** — say so, and paste their lines from the CI log of the PR's green run (`gh run view <id> --log` filtered on the test names) so the concurrency claim is measured, not read. **Host-only, for the orchestrator to ask roshne:** `docker exec <admin container> flock --version` on nucbox once, confirming the image ships it.

### PR

Branch `claude/bot-ops-config-lock` from `origin/main` **after #277 has merged**, isolated worktree; title `fix(ops): env-set, restart and recreate hold one lock on the config dir, and a backup name cannot collide (#227)`; body with `Closes #227`, the plan committed as `docs/plans/epics/E235/04-env-set-lock.md` (with a "Deviations from the plan" section), deviations, the acceptance output including the CI log lines, the mutation table, the round list with dispositions. Behaviour change on a privileged surface: the full gate — two adversarial read-only reviewers with different lenses (A: correctness and failure modes — the descriptor held to exit, `exec 9<` under `set -e`, a refusal's stderr prefix reaching `failureWroteNothing`, a wedged first save; B: claims-vs-code and test quality — the concurrency test really detects a lost update with the lock removed, and the shim cannot mask it on CI). Mutation-test every changed line in a detached scratch worktree, one mutant at a time; the concurrency mutants are run on CI by pushing a mutant to a throwaway branch only if they cannot be run locally — say which. At most four rounds, then stop and tell the orchestrator. **Never merge.**

## Deviations from the plan (recorded at implementation)

- **Line cites re-verified against `31989e9`** (origin/main after #277 merged as PR #290), not the plan's original `310e260`. Confirmed the three facts the hand-off brief asked to confirm before editing: `recreate_bot()` sits between `redact_secret_values` and `cmd_env_set` (lines 900, between 831 and 910), `cmd_recreate` sits after `cmd_restart` (line 637, after 609), and `cmd_env_set` calls `recreate_bot || rc=$?` (line 1110) — all matched, so no stop-and-message was needed.
- **`LOCK_WAIT_SECONDS` placed directly above `lock_config_dir()`** (the plan's primary code block), not beside `LOGS_MAX` — the plan offered either; co-locating it with the helper it configures keeps the two readable together without needing to know it lives near `guard_no_handoff_in_progress`.
- **Test 5's shape: source pin, not a rebuilt-PATH fixture.** The PATH-rebuild shape needs a real, working bash + coreutils + jq with `flock` specifically excluded — fragile to construct portably, and moot on this box anyway (no real `flock` exists here to exclude in the first place; the concurrency-relevant absence is already what `REAL_FLOCK`/the shim cover). A source pin (`lock_config_dir`'s body contains `need flock`) is deterministic on every platform and names the exact guard the coverage table's mutant drops. Written as its own test rather than folded into test 6, matching the plan's two-row split in the coverage table.
- **Mutation testing: the two concurrency-only mutations (rows "concurrent saves never lose each other" and "the lock is bounded and a refusal writes nothing") were run on CI** by pushing each mutant to a throwaway branch, since tests 1/2/3 cannot execute locally on this Windows box (no real `flock`) — see the mutation table in the PR body for the run links. Every other mutation (order/dedup analog doesn't apply here; backup-name suffix, `need flock`, and the "never inside `recreate_bot`" placement) was run locally in a detached scratch worktree.
- No other deviations: all six "Decided" items, both steps' code changes, and all seven named tests were implemented as specified.
