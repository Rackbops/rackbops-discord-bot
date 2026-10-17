<!-- Plan for #531 bundle O3 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #531): `ops/bot-ops.sh`'s nine
Lows, #473 (ops-bot-ops-sh-1, -3, -4, -5, -6) and #474 (ops-bot-ops-sh-7, -8, -9, -10). Written by the orchestrating
session on 2026-10-17; every `file:line` below was read at main `4cfbebd`. Re-find each anchor by its quoted text on
the tree you cut from. Independent of O1 (`install.sh`) and O2 (compose, image, tunnel docs): this bundle touches
`ops/bot-ops.sh`, `ops/bot-ops.test.ts`, and the `bot-ops` paragraphs of `ops/README.md` and `CONTEXT.md` only.
#473 item 1 is a #531 "Fix once" entry gated on #515's state table; that table exists
(`docs/plans/epics/E516/525-handoff-state-table.md`, rows "guard" and ".env and the lock") and says the swap never
takes the config-dir lock, which is why reading the guard after the lock is the fix and not a lock shared with the swap.
Audited read-only in round 1 (a Sonnet agent, the whole bot-ops suite run on a scratch copy with Step 1 applied):
the fixture design, T1-T6 as worded and every listed mutant held; applied: the first draft ran the guard twice
(before and after the lock), which breaks 12 existing exact-docker-call tests, so the guard now MOVES after the
lock (one query, a source pin plus a real-lock CI test); item 8's query-string half is declined in writing and the
regex no longer refuses an `@` inside a query; the stale `grep|cut` text is at `CONTEXT.md:1619-1620`, not the
file-map row; the two misplaced test comments have a step; `ops/README.md` has no key table, so the visibility
sentence goes into its prose and `.env.example`; Decision 5 quotes #531, and CLAUDE.md as it actually reads. -->

## Implementation plan -- #531 O3: the handoff guard is re-checked once the lock is held, the recreate's argv and env file are pinned, `logs` reads decimal, `status` says when docker failed, credentials are refused in the Plugin Index URL, and the comments and test names say what is true

Children: **#473** (closes: items 1, 3, 4, 5, 6 fixed) and **#474** (closes: items 8, 9, 10 fixed; item 7 DECLINED in
writing, Decision 5). One PR, branch `fix/531-O3-bot-ops`, worktree `S:\Repos\_wt\rdb-531-O3` cut from `origin/main`.
Behaviour changes (a refusal after the lock wait, `logs` clamping, a new `dockerError` field, a refused URL shape):
three-reviewer gate.

### What is wrong, verified at `4cfbebd`

- **Item 1 (`ops-bot-ops-sh-1`).** `cmd_restart` (`ops/bot-ops.sh:656-659`), `cmd_recreate` (`:685-688`) and
  `cmd_env_set` (`:992-995`) each call `guard_no_handoff_in_progress` (`:379-391`) and THEN `lock_config_dir`
  (`:401-407`), whose `flock -w "$LOCK_WAIT_SECONDS"` waits up to 60 s. Nothing re-runs the guard after the wait, so
  a `/update` that creates `<container>-next` during it is not seen.
- **Item 3 (`ops-bot-ops-sh-3`).** `recreate_bot` (`:949-952`) runs `... up -d --force-recreate`; every test matches
  that as a substring (the fake compose handler at `ops/bot-ops.test.ts:198` is `*"up -d --force-recreate"*`), so a
  trailing `--build` passes the suite.
- **Item 4 (`ops-bot-ops-sh-4`).** `BOT_ENV_FILE="$ENV_FILE"` prefixes the compose calls at `:674` (restart) and
  `:952` (recreate_bot); the fake docker logs argv only (`ops/bot-ops.test.ts:244`), and the describe at `:1917`
  pins only the stderr echo. Deleting either prefix leaves the suite green.
- **Item 5 (`ops-bot-ops-sh-5`).** `cmd_logs` (`:644-654`): `[[ "$n" =~ ^[0-9]{1,5}$ ]]` then
  `(( n > LOGS_MAX )) && n="$LOGS_MAX"`. Bash reads a leading `0` as octal: `07777` is 4095 (not clamped, docker gets
  `--tail 07777`, which it reads as 7777); `08000` / `09999` make `(( ))` fail ("value too great for base"), the
  `&&` short-circuits, and the unclamped value goes to docker.
- **Item 6 (`ops-bot-ops-sh-6`).** `cmd_status` (`:612-642`): `docker ps ... 2>/dev/null || true` turns a failed
  `docker ps` (socket unreachable, permission denied) into an empty line, so the JSON says `running: false`,
  `status: ""`, `image: ""` with exit 0 -- the same as a missing container.
- **Item 7 (`ops-bot-ops-sh-7`).** Every real `env-set` writes `backups/.env.bak.<stamp>-<pid>` (`:1139`), a full
  copy of `.env` at 0600; nothing removes them.
- **Item 8 (`ops-bot-ops-sh-8`).** `ALLOWED_SPEC`'s row `'PLUGIN_INDEX_URL|^(https?://[^[:space:]]+|file://[^[:space:]]+|/[^[:space:]]+)$'`
  (`:226`) admits `https://user:pw@host/...`; `PLUGIN_INDEX_URL` is a static, non-secret key, so `env-get` returns
  it verbatim to every panel user and `redact_secret_values` (`:880`) does not scrub it.
- **Item 9 (`ops-bot-ops-sh-9`).** The header (`:3-9`) still names "the Warbandeer bot" and the desktop Ops panels
  (`apps/warbandeer-desktop`, wow-companion); `:34` documents `version` as `{"schema": N}` though `cmd_version`
  (`:89-`) also emits `composeSchema`; `:1137-1138` says the pid suffix means "the name can never collide" (two
  saves in one second in different PID namespaces, or a reused pid, can); `ops/README.md:399` repeats the claim;
  `CONTEXT.md:1619-1620` says `cmd_version` reads the compose stamp "via a `grep '^x-rackbops-schema:' | cut`
  one-liner" while the code is `grep -m1 ... | grep -o` (`ops/bot-ops.sh:98`) (the `bot-ops.sh` file-map row,
  `CONTEXT.md:202`, already says `load_env_values` and is fine); two test comments sit above the wrong test (the
  review's `ops/bot-ops.test.ts:340-344` and `:1776-1785` at `4ff8eef`; re-find by reading the comments above the
  `env-get` / `env-schema` helpers and the `recreate` describe).
- **Item 10 (`ops-bot-ops-sh-10`).** The describe "env-set/restart/recreate serialise concurrent mutations" (`:996`)
  never runs `recreate` concurrently; "without flock on PATH, env-set refuses to run unserialised" (`:1075`) is a
  source pin asserting `toContain("need flock")`, which `need flock || true` also satisfies; "the backup name ends
  in the pid" (`:1060`) asserts `\d+`, not the pid; "the request file really is 0600" (`:3489`) returns early on
  win32 and so reports a pass there.

### Decisions (defaults, named so the gate can contest them)

1. **Item 1: the guard MOVES to after the lock** in each of the three commands (it runs once, once the lock is
   held). Running it twice -- a fast check before the lock plus the real one after -- was the first draft; round 1
   ran it and it breaks 12 existing tests that pin the exact docker calls (each would see two `-next` queries:
   `ops/bot-ops.test.ts:726, 749, 808, 835, 848, 865, 917, 940, 956, 968, 1239, 1582` at `4cfbebd`). Moving it keeps
   one `-next` query per command, so those tests stand. The cost: a refusal now waits behind another save's lock
   (up to `LOCK_WAIT_SECONDS`), which only happens when two mutations overlap anyway. Not moved into
   `lock_config_dir`: the helper stays a lock and nothing else (its "taken once per process" source pin at
   `ops/bot-ops.test.ts:1083-` stays true).
2. **Item 5: decimal, explicitly.** `n=$((10#$n))` right after the regex check, then the existing clamp; docker
   always receives the decimal value (so `00200` sends `200`).
3. **Item 6: an additive `dockerError` field, exit 0 kept.** When that one `docker ps` fails, the JSON gains
   `dockerError: "docker ps failed (exit <rc>)"` -- the exit code only, never docker's stderr (the panel shows this
   JSON to every panel user). `running` stays `false`, `status` / `image` stay `""`. The other reads stay
   best-effort. Exit 0 is kept because `ops/admin/server.ts` treats a non-zero `status` as a failed request and
   would lose the rest of the page; the panel showing `dockerError` is #529 A3's, named in the PR.
4. **Item 8: userinfo refused at write time, the bot unchanged; the query-string half DECLINED.** The
   `PLUGIN_INDEX_URL` row's http(s) branch becomes `https?://[^[:space:]/?#@]+([/?#][^[:space:]]*)?` (no `@` in the
   authority; an `@` after the first `/`, `?` or `#` stays legal, so `https://host?t=a@b` is accepted), so `env-set`
   refuses `https://user:pw@host/x.json` through the existing pattern check and `env-schema` hands the panel the
   stricter pattern. `src/config.ts` is NOT changed (`src/config.ts:130` accepts userinfo today; tightening it would
   stop a bot whose `.env` already has one). DECLINED, in writing on #474 and #531: refusing a query string. A raw
   file URL for a private index legitimately carries `?token=`, and refusing it would break that deployment; the
   value is instead documented as visible to every panel user, so a token in it is the operator's informed choice.
   There is no key table in `ops/README.md`; the sentence goes into `.env.example`'s `PLUGIN_INDEX_URL` comment
   (`.env.example:52-54`) and into `ops/README.md`'s prose where `PLUGIN_INDEX_URL` is described (`:244` and `:359`
   at `4cfbebd`; read both and put it in the one that describes `env-get` / the panel's view).
5. **Item 7 is DECLINED.** Pruning `backups/` deletes operator data from the config dir. #531's body says "No fix
   writes the operator config dir: `.env` plus `backups/` is never auto-touched", and `CLAUDE.md` names the config
   dir (`.env` + `backups/`) "operator-precious and never auto-migrated". Instead `ops/README.md`'s env-set paragraph (`:399`) says the backups are
   kept until the operator removes them, that each holds every secret at 0600, and gives the manual prune:
   `ls -1 <config-dir>/backups/.env.bak.* | sort | head -n -10 | xargs -r rm --`. The decline is written on #474
   when this merges.
6. **Item 10's flock test stays a source pin, honestly named and tightened.** Building a PATH with flock removed
   but bash, coreutils and jq kept is what the existing comment (`:1070-1074`) already declined; the pin is renamed
   "lock_config_dir requires flock (source pin)" and asserts the line is exactly `need flock`
   (`/^\s*need flock$/m` inside the helper body), which `need flock || true` fails.

### Step 1 -- `ops/bot-ops.sh`

1a. Item 1: in `cmd_restart`, `cmd_recreate` and `cmd_env_set`, swap the two lines so `lock_config_dir <sub>` comes
first and `guard_no_handoff_in_progress` second, with the comment `# #473: after the lock -- a /update may start
during the wait`. Above the guard function (`:372-378` comment block) add one sentence: callers run it only once
they hold the config-dir lock, so a self-update that began while they waited is seen. Grep the test file for any
source pin that expects the guard BEFORE the lock and update it (none was found in round 1, but check).

1b. Item 5: in `cmd_logs`, after the regex line: `n=$((10#$n))   # #473: decimal; a leading 0 is not octal`.

1c. Item 6: in `cmd_status`, replace the `ps_line=...|| true` assignment with
```bash
  local ps_rc=0 docker_error=""
  ps_line="$(docker ps -a --filter "name=^/${CONTAINER}$" \
              --format '{{.State}}'$'\t''{{.Status}}'$'\t''{{.Image}}' 2>/dev/null)" || ps_rc=$?
  # #473: a failed `docker ps` is not "no container": say so, with the exit code only (never docker's stderr).
  [ "$ps_rc" -eq 0 ] || { ps_line=""; docker_error="docker ps failed (exit $ps_rc)"; }
```
and the final `jq -n` gains `--arg dockerError "$docker_error"` and appends
`+ (if $dockerError == "" then {} else {dockerError: $dockerError} end)` to the object, so a healthy `status` is
byte-identical to today.

1d. Item 8: the `PLUGIN_INDEX_URL` row at `:226` becomes
`'PLUGIN_INDEX_URL|^(https?://[^[:space:]/?#@]+([/?#][^[:space:]]*)?|file://[^[:space:]]+|/[^[:space:]]+)$'`. The
comment at `:228-232` ("AUTO_UPDATE's and PLUGIN_INDEX_URL's regexes both DO contain `|`") stays true; add "and no
`@` in the authority (#474: no `user:pass@` in a value every panel user sees; a query string is allowed and
documented as visible)".

1e. Item 9: the header `:3-9` names this bot and its admin panel (`ops/admin/`), not Warbandeer or the desktop
apps; `:34` reads `{"schema": N, "composeSchema": M|null}` with one clause on what `composeSchema` is (read the
`cmd_version` body for the exact meaning and write that); `:1137-1138` becomes "the pid suffix makes a collision very
unlikely (two saves would need the same second AND the same pid); the name is the record of what was replaced, so
it does not lean on the lock's timing either".

### Step 2 -- `ops/bot-ops.test.ts`

Fixture changes in `setup()` (`:88-290`):
- **`nextStateFile?: string`** -- like `nextState`, but the shim `cat`s the state from that host file on every
  `-next` query (empty = no `-next` container), so a test can change it while a call is blocked on the lock.
  `originalState` applies as with `nextState` (the canonical container answers "running").
- **`containerMeta: "!error"`** -- the `{{.State}}` metadata query exits 3 with `Cannot connect to the Docker
  daemon` on stderr.
- **Env-file log:** every `docker compose` call also appends `"${BOT_ENV_FILE-<unset>}"` to `bin/compose-env.log`
  (a separate file, so `docker.log` lines that tests match exactly are unchanged).
- **`Run.pid`:** `botOps` returns `proc.pid` too.

Tests (all inside `describe.skipIf(!runnable)` blocks unless named otherwise):
- **T1 (item 1):** (a) source pin, runs everywhere: in each of `cmd_restart`, `cmd_recreate`, `cmd_env_set`
  (bodies sliced as the `:1083-` pin does), `guard_no_handoff_in_progress` appears exactly once and AFTER
  `lock_config_dir`. (b) behavioural, in the `REAL_FLOCK` describe (`:996`, CI only): a fixture option
  `nextStateFile` (the shim reads the `-next` state from that file on each query; an empty file = no `-next`
  container) starting empty; start an `env-set` with `composeUp.delayMs: 1500`; 300 ms later start a `recreate`
  (it blocks on the lock); 300 ms after that write `running` into the state file; await both -> the env-set exits
  0, the recreate exits non-zero with `a self-update is in progress` and `docker.log` holds exactly ONE
  `up -d --force-recreate` (the env-set's). With the guard before the lock the recreate reads the empty file and
  recreates (two calls).
- **T2 (item 3):** one `env-set` with a real change and one `recreate`: the compose call line in `docker.log`
  equals, exactly, `docker compose -f <compose> -p probe-project up -d --force-recreate` (build the expected string
  from `bashPath(fx.compose)`), and no `docker.log` line contains `--build`.
- **T3 (item 4):** `restart`, `recreate` and `env-set` (real change): every line of `compose-env.log` equals
  `bashPath(fx.envFile)`. A fourth case pins the honest fallback: with `BOT_OPS_CONFIG_DIR` set and nothing else
  changed the value is still the config-dir file (the stack `.env` is irrelevant here).
- **T4 (item 5):** fake `docker logs` already logs argv; `logs 07777` -> the call carries `--tail 5000`;
  `logs 09999` -> exit 0 and `--tail 5000`; `logs 00200` -> `--tail 200`; `logs 200` -> `--tail 200` (unchanged).
- **T5 (item 6):** `containerMeta: "!error"` -> exit 0, `json.dockerError === "docker ps failed (exit 3)"`,
  `running: false`, and stdout does not contain `Cannot connect`; with a healthy `containerMeta` the JSON has no
  `dockerError` key (`toEqual` on the full object, today's shape).
- **T6 (item 8):** `env-set` `PLUGIN_INDEX_URL=https://user:pw@plugins.invalid/x.json` -> refused (non-zero, the
  existing pattern-refusal message naming the key), `.env` unchanged; `https://plugins.invalid/a@b/x.json?v=1`,
  `https://plugins.invalid?t=a@b` and `https://plugins.invalid/x.json?token=abc` -> accepted (the last one pins the
  declined half on purpose); `env-schema`'s `PLUGIN_INDEX_URL.pattern` equals the new row. Grep the test file for the old regex text
  and update any pin of it.
- **T7 (item 10):** (a) a new test in the `REAL_FLOCK` describe (`:996`): `recreate` started 300 ms after an
  `env-set` in flight (`composeUp.delayMs: 1500`) -> both exit 0, and the second `compose-up start` is at or after
  the first `compose-up end` (the shape of the restart test at `:1039-1056`); (b) the flock pin per Decision 6;
  (c) the backup-name test asserts the suffix equals `String(run.pid)` inside `test.skipIf(process.platform ===
  "win32")` (Git Bash's `$$` is not the Windows pid), keeping the shape check for every platform; (d) the 0600 test
  becomes `test.skipIf(process.platform === "win32")(...)` with the early `return` removed.
- **T8 (item 9):** source pins: the header (first 12 lines) does not contain `Warbandeer`; the `version` line of the
  header contains `composeSchema`.
- **Item 9's two misplaced test comments:** find them where the review saw them,
  `git show 4ff8eef:ops/bot-ops.test.ts | sed -n '335,350p;1770,1790p'`, re-find that comment text on your tree,
  and move each comment so it sits above the test it describes (reword only if it no longer matches that test). If
  either is already gone or correctly placed, say so in the PR. No test pins a comment.

### Step 3 -- docs

- `ops/README.md:399` (env-set backups): the collision wording per 1e, and Decision 5's retention sentence and
  manual prune command. `PLUGIN_INDEX_URL` (Decision 4; `:244` / `:359`, whichever describes the panel's view):
  "env-get shows this value to every panel user, so it must not hold a credential: a `user:pass@` URL is refused;
  a query string is allowed, and is shown." Where `ops/README.md` lists the subcommands (Grep `status` / `logs` in
  its subcommand list; if there is no such list, the header of `bot-ops.sh` is the place): `status` "with
  `dockerError` when `docker ps` itself failed"; `logs` "N is read as decimal".
- `.env.example:52-54` (`PLUGIN_INDEX_URL`): the same visibility sentence, shortened.
- `CONTEXT.md:1619-1620`: `cmd_version` reads the stamp with `grep -m1 ... | grep -o` (check `ops/bot-ops.sh:98`
  and quote it). `CONTEXT.md:202` (the `ops/bot-ops.sh` row): append `**#473/#474:** the handoff guard runs after
  the config-dir lock; `status`'s `dockerError`; no `user:pass@` in `PLUGIN_INDEX_URL`; backups kept until the
  operator prunes them`.
- `CONTEXT.md`'s config-dir gotcha (Grep `backups/.env.bak`, near `:642`): one sentence that backups are never
  pruned automatically, by design (Decision 5).

### Mutation table (detached scratch worktree; `bun test ops/bot-ops.test.ts` per mutant, about 400 s on MILE)

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | 1a: `cmd_recreate`'s guard moved back before the lock | T1 (a) (everywhere) and T1 (b) (CI) |
| M1b | 1a: `cmd_env_set`'s guard moved back before the lock | T1 (a) |
| M1c | 1a: `cmd_restart`'s guard moved back before the lock | T1 (a) |
| M1d | 1a: `cmd_recreate`'s guard deleted | the existing guard tests (`a self-update is in progress` cases) and T1 (a) |
| M2 | `recreate_bot` gains `--build` | T2 |
| M3 | `BOT_ENV_FILE="$ENV_FILE"` dropped from `recreate_bot` | T3 recreate and env-set cases |
| M3b | `BOT_ENV_FILE="$ENV_FILE"` dropped from `cmd_restart` | T3 restart case |
| M4 | 1b removed | T4 (`07777` and `09999`) |
| M5 | 1c: `ps_rc` not checked (back to `|| true`) | T5 |
| M5b | 1c: `dockerError` always present | T5 healthy case |
| M6 | 1d: the old `PLUGIN_INDEX_URL` row restored | T6 userinfo case |
| M7 | `need flock` -> `need flock || true` | T7 (b) |
| M8 | the backup suffix `$$` -> `$RANDOM` | T7 (c) (Linux / CI) |

M8 dies only where `$$` equals the spawned pid (not Git Bash): name that in the PR as CI-only, like T7 (a).

### Coverage table

| Bullet | Step(s) | Test | Mutation |
|---|---|---|---|
| #473-1: no restart/recreate/env-set runs after a handoff began during its lock wait | 1a | T1 | M1, M1b, M1c, M1d |
| #473-3: env-set and recreate never gain `--build` | (test only) | T2 | M2 |
| #473-4: compose is pointed at the config-dir `.env` | (test only) | T3 | M3, M3b |
| #473-5: `logs` caps a leading-zero N | 1b | T4 | M4 |
| #473-6: `status` says when docker failed | 1c | T5 | M5, M5b |
| #474-7: declined, retention documented | 3 | lens-B audit | -- |
| #474-8: no `user:pass@` in `PLUGIN_INDEX_URL` via the panel; the query half declined and documented | 1d, 3 | T6 | M6 |
| #474-9: the stale texts (header, `version` contract, collision claim x2, `CONTEXT.md:1619`, two test comments) | 1e, 2, 3 | T8, lens-B audit | -- (wording) |
| #474-10: the four test names keep their promises | 2 | T7 | M7, M8 |

### Verification

```bash
bun install --frozen-lockfile
bunx tsc --noEmit -p ops/tsconfig.json
bun run check
bun test ops/bot-ops.test.ts      # ~400 s on MILE (jq present); the REAL_FLOCK describe skips here
bun test                          # background, alone (a concurrent second suite run gives false failures)
```

Not verifiable on MILE: the `REAL_FLOCK` tests (T7 (a)) and M8; CI's Linux runs them. Docker's real `ps` failure
modes are faked (exit 3 + stderr).

### Acceptance to paste per issue

- **#473:** T1-T5 pass lines; M1-M5b failing output; the new `status` JSON for the failing case.
- **#474:** T6-T8 pass lines; M6-M8 failing output (M8 from CI's log); the `ops/README.md` retention paragraph; the
  decline text for item 7 (posted on #474 after merge).

### PR

- Title: `fix(ops): re-check the handoff guard once the lock is held, pin the recreate's argv and env file, read logs N as decimal, report a failed docker ps in status, refuse credentials in PLUGIN_INDEX_URL, and correct the bot-ops texts (#473, #474)`.
- Body: the items, Decisions 1-6, the output, the mutation table, item 7's decline. End with `Closes #473. Closes #474.`
- After merge: tick #473 and #474 on #531; post item 7's decline and item 8's query-string decline on #474
  (Decisions 4 and 5), and list both in #531's closing comment when the sub-epic closes.

### Out of scope, on purpose

- The panel showing `dockerError` (#529 A3).
- Any change to `src/config.ts`'s `PLUGIN_INDEX_URL` check (Decision 4).
- Automatic backup pruning (Decision 5).
