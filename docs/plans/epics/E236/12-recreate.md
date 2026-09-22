<!-- Plan for Rackbops/rackbops-discord-bot#277 (Epic #236). Copy of the approved plan comment,
     https://github.com/Rackbops/rackbops-discord-bot/issues/277#issuecomment-5768797183, as of when
     it was posted (2026-09-21, against `origin/main` @ `e1194e4`), with the "Wiring notes" groundwork
     comment folded in above it (https://github.com/Rackbops/rackbops-discord-bot/issues/277#issuecomment-5767713591),
     and the implementer's "Deviations from the plan" appended at the end. Cut from `origin/main` @
     `a4a8dbe` (after #278/PR #279 merged, which touched `ops/bot-ops.sh`, `ops/bot-ops.test.ts` and
     `CONTEXT.md`) -- every line cite in both comments below was re-checked against `a4a8dbe` before
     work started; the constructs all still match, only line numbers in `ops/bot-ops.sh` and
     `ops/bot-ops.test.ts` shifted (RESERVED_KEYS grew by ~24 lines and the test file by ~153). The
     implementation below cites the re-checked, current line numbers rather than the stale ones. -->

## Wiring notes for the plan (gathered 2026-09-21 on `origin/main` = `e1194e4`)

Decided by roshne: **one Restart button** — the Overview's existing Restart does a recreate; no second button; the in-place `docker compose restart` stays an SSH-only `bot-ops.sh restart`. The implementation plan is NOT written yet; this comment is the groundwork for it, so the search does not have to be paid for twice. Line numbers are as of `e1194e4`; cite by construct when writing the plan.

### Plan outline (the orchestrator's design, to be turned into the plan)

1. **`ops/bot-ops.sh`** — a `recreate` subcommand. Move `cmd_env_set`'s recreate step (the `bot-ops: env file …` stderr line, `up -d --force-recreate` with `BOT_ENV_FILE`, the capture, `relay_tool_output`) into ONE helper that `cmd_env_set` and `cmd_recreate` both call, so the two can never drift. `cmd_recreate`: `need docker; need jq`, `guard_no_handoff_in_progress`, the helper, then `jq -n '{ok, recreated: true, log}'` and `return` compose's status. A `recreate)` arm in `main()` and in the usage string. `BOT_OPS_SCHEMA` 4 → 5 with its comment line.
2. **`ops/admin/server.ts`** — a `buildInvocation` branch `POST /api/recreate → { args: ["recreate"], contentType: "application/json" }`; `auditLogLine` learns `recreate` (the success line, the timeout line and — unlike restart — a FAILED line, since a failed recreate can leave the bot down); `REQUIRED_BOT_OPS_SCHEMA` 4 → 5.
3. **`ops/admin/public/index.html`** — the `RESTART` block's `doRestart` POSTs `/api/recreate` instead of `/api/restart`; the confirm text says what happens ("Restart the bot? It comes back with the saved settings and is offline for about 20 seconds."); success shows a plain sentence, a JSON failure shows its `log` (never the raw JSON), then `loadStatus()`. No new marker block, so the 19-marker pin does not move. `POST /api/restart` stays routed (nothing in the page calls it any more; say so in the docs) — removing a route is a separate decision.
4. **Tests** — `bot-ops.test.ts` (docker shim): success shape, failure shape + exit status, the relay (withheld / scrubbed), the handoff guard, and env-set's existing tests passing UNEDITED after the helper extraction; `server.test.ts`: `buildInvocation`, the three audit lines, the `doRestart` lifted-block tests re-pointed at `/api/recreate`, the schema drift pin at 5. Mutants: call `restart` instead of the helper; drop the guard; drop the audit branch; bump only one schema constant; leave `doRestart` on `/api/restart`.
5. **Docs** — `ops/README.md` (subcommand table, the Overview paragraph), `CONTEXT.md`, and the deploy notes for #247 (schema 5).

### What the code looks like today (verified by a read-only search agent)

**Server (`ops/admin/server.ts`)**
- `buildInvocation(method, pathname, searchParams, body)` (~452) is the pure route → invocation mapper, called once for every request no server-native route claimed (~1909); unmatched → 404. Restart branch (~465): `if (method === "POST" && pathname === "/api/restart") return { args: ["restart"], contentType: "text/plain" };` — env-set branch (~471): `{ args: ["env-set"], stdin: body ?? "", contentType: "application/json" }`.
- The cross-site-write guard and auth are GLOBAL for every `/api/*` request, before `buildInvocation` runs: `isCrossSiteWrite(req)` → 403 (~1752; it covers POST and DELETE whose `Origin` host differs), then `authorizeRequest` → 401 (~1771). A new POST route needs no per-route wiring for either.
- There is NO separate allow-list of subcommands: `buildInvocation`'s literal branches are the only gate.
- Failure mapping (~1912-1931): `timedOut` → 504 `bot-ops.sh timed out`; stdout that parses as JSON → 502 with that JSON; otherwise 502 with stderr (or `bot-ops.sh failed`). `SUBPROCESS_TIMEOUT_MS = 90_000` (~498); Bun's idle timeout is 120 s so the 504 wins.
- `auditLogLine` (~1474-1507) logs only `restart` and `env-set` (`if (action !== "restart" && action !== "env-set") return null;`). Restart success: `[admin] restart by <actor>`; timeout: `[admin] restart timed out (killed after running past its limit) — attempted by <actor>`; a non-timeout failed restart logs nothing. Only `env-set` has the "recreate FAILED, but .env already changed" branch.
- `REQUIRED_BOT_OPS_SCHEMA = 4` (~674) with a numbered history comment above it; compared at boot by `checkBotOpsSchemaStartup` → `decideBotOpsSchema`; the result rides `GET /api/status` (`mergeStatusOutdated`) and the banner is client-side (`describeOutdatedBanner`, `#bot-ops-outdated-banner`).

**Page (`ops/admin/public/index.html`)**
- `// RESTART:begin … // RESTART:end` (~1098-1117) is 20 lines: `doRestart()` → `confirm("Restart the bot? It will be briefly unavailable.")`, `#restart-msg` ← "Restarting…", `timeoutSignal(MUTATION_TIMEOUT_MS)`, `api("/api/restart", { method: "POST", signal })`, the text answer shown as-is (`"Failed: " + text` on a non-OK), `loadStatus()`, `cancel()` in `finally`. Wired by `document.getElementById("restart").addEventListener("click", (e) => withBusy(e.currentTarget, doRestart));`.
- Markup (~61-70): `<button id="restart" class="rb-btn rb-btn--danger">Restart</button>` beside `#refresh-status`, message element `<div id="restart-msg" class="msg">`. No static hint text.
- `withBusy(el, fn)` (~1052) disables the clicked element for the duration.

**Tests (`ops/admin/server.test.ts`)**
- `describe("buildInvocation")` → `POST /api/restart -> restart, text`; `describe("handleRequest")` has the outdated-script restart test and the 504 test (it POSTs `/api/restart`); the Origin/auth gates are tested generically (they are global).
- Audit: `describe("describeActor / describeAction / parseChangedKeys / auditLogLine")` — success, null-for-reads-and-no-op-failures, and the timeout line.
- The page block: `describe("admin panel doRestart (issue #53 item 2)")` — present in the page; a declined confirm never calls `api()`; a confirmed restart POSTs with a real AbortSignal and re-loads status; a failed restart surfaces the text. Blocks are lifted inline per describe with `indexSrc.match(/\/\/ NAME:begin\n([\s\S]*?)\n\s*\/\/ NAME:end/)` and run through `new Function(...)` with fake collaborators — there is no shared helper.
- `describe("page skeleton")` → `every lifted block is still present` pins 19 marker names.
- `describe("REQUIRED_BOT_OPS_SCHEMA mirrors ops/bot-ops.sh's BOT_OPS_SCHEMA (#173, can't drift)")` is the drift pin.

**Script (`ops/bot-ops.sh`)**
- `cmd_restart` (~579-600): `need docker`, `guard_no_handoff_in_progress`, the `bot-ops: env file` stderr line, `docker compose … restart` captured, `relay_tool_output`, compose's exit status, `restarted $CONTAINER` only on success.
- `cmd_env_set`'s recreate step (~1041-1055): the same stderr line, `recreate_log="$(BOT_ENV_FILE="$ENV_FILE" docker compose -f "$COMPOSE_FILE" -p "$PROJECT" up -d --force-recreate 2>&1)" || rc=$?`, `relay_tool_output`, then `jq -n … '{ok: $ok, changed: $changed, recreated: true, backup: $backup, log: $log}'` and `return "$rc"`.
- `main()` (~1231-1253): the `case` of subcommands; the usage text is the string in its `*)` arm (`version` is dispatched earlier, before the `.env` / compose-file preconditions).
- `readonly BOT_OPS_SCHEMA=4` (~73) with a numbered history comment. `guard_no_handoff_in_progress` (~326) dies with "a self-update is in progress …" when `<container>-next` exists while `<container>` is still running; restart and env-set both call it first.

**`docker-compose.yml`** — three services: `bot` (no profile), `admin` (`profiles: [admin]`), `cloudflared` (`profiles: [tunnel]`). The script never passes `--profile` nor sets `COMPOSE_PROFILES`, so a bare `up -d --force-recreate` recreates ONLY the bot — which is what env-set's recreate already does, and why the panel does not take itself down.

## Implementation plan — written by the orchestrating session, to be executed as written

Written 2026-09-21 against `origin/main` @ `e1194e4`; every construct below was read from source that day and the wiring-notes comment above (also at `e1194e4`) still matches line for line. Cite by construct when you search. **Cut the branch from `origin/main` only after #278 (PR #279) has merged** — it edits `ops/bot-ops.sh`, `ops/bot-ops.test.ts` and `CONTEXT.md` too. One PR, branch `claude/panel-recreate`, isolated worktree under `R:/repos/Scratch/worktrees/`. Commit this plan as `docs/plans/epics/E236/12-recreate.md` (with a "Deviations from the plan" section in the shape `06-one-apply.md` carries).

**Files:** `ops/bot-ops.sh`, `ops/bot-ops.test.ts`, `ops/admin/server.ts`, `ops/admin/server.test.ts`, `ops/admin/public/index.html`, `ops/README.md`, `CONTEXT.md`. Nothing under `src/`; not `docker-compose.yml`; not `install.sh`.

### Decided — not open for re-planning

1. **One Restart button, and it recreates.** The Overview's existing Restart does `up -d --force-recreate`, so the bot always comes back with the saved `.env`. No second button, no "Restart and reload settings" wording on the button itself: the confirm dialog says what happens. The in-place `docker compose restart` stays an SSH-only `bot-ops.sh restart`; `POST /api/restart` stays routed (removing a route is a separate decision) and the docs say the page no longer calls it.
2. **One recreate helper, shared.** `cmd_env_set`'s recreate step (`bot-ops.sh:1041-1055`: the `bot-ops: env file` stderr line, the `BOT_ENV_FILE=… up -d --force-recreate` capture, `relay_tool_output`) moves into one function that `cmd_env_set` and the new `cmd_recreate` both call, so the two can never drift. `cmd_env_set`'s observable behaviour is unchanged and its existing tests are not edited.
3. **Same result shape as `env-set`'s, minus what does not apply:** `{ok, recreated: true, log}` on stdout, exit status = compose's, on success and on failure alike (a compose failure still prints the JSON, then exits non-zero — exactly what the panel's generic 502-with-JSON path is built for). `recreated: true` means "a recreate was attempted", as it does for `env-set`.
4. **Audit: a success line and the timeout line, no separate FAILED line.** `auditLogLine` learns `recreate` for the success line (`[admin] recreate by <actor>`) and the existing generic timeout line covers it; a non-timeout failure returns `null` like a failed restart does, because `handleRequest`'s own `console.error` (`server.ts:1914-1916`) already names the action, the exit code and the actor. The wiring notes proposed a FAILED audit line; it would be a duplicate of that error line, and unlike `env-set` there are no changed keys to carry. Dropped, on purpose.
5. **Schema 4 → 5 on both sides**, in this PR: `BOT_OPS_SCHEMA` (`bot-ops.sh:73`, with a `# 5: adds recreate (#277).` history line) and `REQUIRED_BOT_OPS_SCHEMA` (`server.ts:674`, with `5 = recreate (#277).`). The issue's acceptance bullet says "4"; that was written before #256 took 4 — 5 is right. An older deployed script shows the existing out-of-date banner, unchanged.
6. **The page shows a sentence, never raw JSON.** Success: `Restarted. The bot is back with the saved settings.` A JSON failure shows `Failed: <log>` (the compose log, relayed by the script); a plain-text failure or a 504 shows `Failed: <text>` as today. `loadStatus()` runs after either outcome, as today. No new marker block, so the 19-marker skeleton pin does not move; the `RESTART` block keeps its name.
7. **Only the bot is recreated.** `docker-compose.yml` puts `admin` under `profiles: [admin]` (`:116`) and `cloudflared` under `profiles: [tunnel]` (`:141`); the script passes no `--profile` and sets no `COMPOSE_PROFILES`, so a bare `up -d --force-recreate` touches only `bot` — which is what `env-set`'s recreate already does, and why the panel never takes itself down. Verified by reading; pinned by the existing docker shim, which records every compose call (assert that the recreate issues exactly one compose call and that it is the `up` line).
8. **The Apply bar is not touched.** The issue's option 2 (the bar offering a recreate after a failed one) is decided after this lands.

### Step 1 — `ops/bot-ops.sh`

- Add `recreate_bot()` above `cmd_env_set`: `echo "bot-ops: env file $ENV_FILE" >&2`; `local out rc=0; out="$(BOT_ENV_FILE="$ENV_FILE" docker compose -f "$COMPOSE_FILE" -p "$PROJECT" up -d --force-recreate 2>&1)" || rc=$?`; `RECREATE_LOG="$(relay_tool_output "$out")"`; `return "$rc"`. The output travels in the global `RECREATE_LOG` (the script's `REPLY` idiom for `compose_trim`: a function cannot return a string without a subshell, and the exit status must be compose's). Move the two comment blocks that explain the recreate (`:1041-1047`, the no-`--build` rule and the stderr-only convention) onto the helper; leave a one-line pointer where they were.
- `cmd_env_set`: replace `:1048-1055` with `local rc=0; recreate_bot || rc=$?; local recreate_log="$RECREATE_LOG"` — the `jq -n` result line and `return "$rc"` stay exactly as they are.
- `cmd_recreate()`: `need docker; need jq`; `guard_no_handoff_in_progress`; `local rc=0; recreate_bot || rc=$?`; `jq -n --argjson ok "$([ "$rc" -eq 0 ] && echo true || echo false)" --arg log "$RECREATE_LOG" '{ok: $ok, recreated: true, log: $log}'`; `return "$rc"`.
- `main()`: a `recreate) cmd_recreate ;;` arm between `restart)` and `env-get)`, and `recreate` in the usage string after `restart`.
- `readonly BOT_OPS_SCHEMA=5` with its history line. Update the header comment (`:19`) if it enumerates subcommands.

### Step 2 — `ops/admin/server.ts`

- `buildInvocation`: after the `/api/restart` branch, `if (method === "POST" && pathname === "/api/recreate") return { args: ["recreate"], contentType: "application/json" };` and add `recreate` to the doc comment's list of 1:1 subcommands.
- `auditLogLine`: the first guard becomes `if (action !== "restart" && action !== "env-set" && action !== "recreate") return null;`. Nothing else changes: the `exitCode === 0` line already reads `describeAction`, which returns the bare action name for anything but `env-set`; the timeout line already interpolates `action`; the non-timeout failure path already returns `null` for anything but `env-set`. Update the function's doc comment (`:1470-1473`) to name recreate and to say why a failed recreate has no audit line (decision 4).
- `REQUIRED_BOT_OPS_SCHEMA = 5` with its history line.

### Step 3 — `ops/admin/public/index.html`, the `RESTART` block only

`doRestart()`: confirm text `Restart the bot? It comes back with the saved settings and is offline for about 20 seconds.`; `api("/api/recreate", { method: "POST", signal })`; read `text`, try `JSON.parse` into `result` (null on failure); on `res.ok` the sentence from decision 6; otherwise `"Failed: " + ((result && result.log) || text)`; the existing `msg.className` toggling, `loadStatus()` and the `finally { cancel() }` stay. The button markup (`:67`) and `withBusy` wiring (`:1118`) are untouched.

### Step 4 — tests

`ops/bot-ops.test.ts` — a new `describe.skipIf(!runnable)("bot-ops.sh recreate (#277)")` on the existing fixture (`composeUp` is the shim's `up -d --force-recreate` answer; `dockerCalls(fx)` lists every docker call; `withheld()` is the relay sentence):

| # | Test name | Pins |
|---|---|---|
| 1 | `recreate prints {ok:true, recreated:true, log} and exits 0, after exactly one compose call, the up line` | `composeUp: { output: "Container x Started" }` → JSON equal, exit 0, `dockerCalls` has one `compose` call containing `up -d --force-recreate`, none containing ` restart` |
| 2 | `a failed recreate prints the same shape with ok:false and exits with compose's status` | `composeUp: { output: "no such image", exitCode: 1 }` → `ok: false`, `log: "no such image"`, exit 1 |
| 3 | `what compose says about the env file is withheld whole, and a stored secret is scrubbed` | two runs: an output naming `{ENV_FILE}` → `log === withheld("line 2")`; an output quoting a stored secret value → `log` does not contain it, contains `[redacted]` (mirror the restart describe at `:1343-1362`) |
| 4 | `recreate refuses while a self-update is in progress, before any compose call` | `nextRunning` fixture → exit non-zero, stderr names the self-update, `dockerCalls` has no `compose` call |
| 5 | `env-set's recreate still goes through the one helper: its log is relayed and its JSON unchanged` | the existing env-set describe blocks that assert `up -d --force-recreate`, `recreated: true`, the relay (`:1555+`, `:2092+`, `:2147+`) run **unedited** and green — name them in the PR |
| 6 | `version reports schema 5 (#277: recreate)` | rename the existing test at `:1433` and update the literal pin at `:1426`; every `{ schema: 4 … }` literal becomes 5 |
| 7 | `the usage line names recreate` | an unknown subcommand's `die` text contains `recreate` |

`ops/admin/server.test.ts`:

| # | Test name | Pins |
|---|---|---|
| 8 | `POST /api/recreate -> recreate, json` (in `describe("buildInvocation")`) | |
| 9 | `auditLogLine logs a successful recreate with the actor, the timeout line for a killed one, and nothing for a plain failure (its console.error line already names the actor)` (in the audit describe) | three assertions |
| 10 | `POST /api/recreate: a compose failure's JSON reaches the page as a 502 with that JSON; a timeout is a 504` (in `describe("handleRequest")`, canned `runBotOps`) | body equals the canned stdout; `Content-Type: application/json`; the 504 text |
| 11 | the `describe("admin panel doRestart (issue #53 item 2)")` tests, re-pointed: `a confirmed restart POSTs /api/recreate with a real AbortSignal, shows the sentence, and re-loads status` · `the confirm says the bot comes back with the saved settings` · `a JSON failure shows the compose log, never the raw JSON` · `a plain-text failure shows the text` · `a declined confirm never calls api()` (unchanged) | the harness's `api` returns `{ ok, text }` already; add a JSON-body case |
| 12 | `the page no longer calls /api/restart` (in `describe("page skeleton")`) | `indexSrc` does not contain `"/api/restart"`; `"/api/recreate"` appears exactly once |
| 13 | the drift pin at `:2283` passes at 5 with no edit (it regexes the script) — say so in the PR | |

### Coverage table

| Acceptance bullet (the issue's, corrected for schema 5) | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| `recreate` prints the JSON shape, relays the log, exits with compose's status | 1 | 1, 2, 3 | `cmd_recreate` runs `restart` instead of the helper; exit 0 on failure; skip `relay_tool_output` |
| the handoff guard applies | 1 | 4 | drop `guard_no_handoff_in_progress` from `cmd_recreate` |
| one helper, env-set unchanged | 1 | 5 | give `cmd_env_set` its own compose line again (the helper's relay is then the only one tested) |
| `POST /api/recreate`: Origin guard, auth, audit, failure mapping | 2 | 8, 9, 10 + the existing global Origin/auth tests | drop the `buildInvocation` branch; drop `recreate` from `auditLogLine`'s action set |
| the Overview button confirms, shows the outcome, refreshes | 3 | 11 | drop the `confirm`; leave the POST on `/api/restart`; show the raw JSON; drop `loadStatus()` |
| both schema constants are 5 and the drift pin holds | 1, 2 | 6, 13 | bump only one side |
| the page never calls the old route | 3 | 12 | leave `doRestart` on `/api/restart` |
| docs say a failed or killed recreate can be finished from the panel | 5 | — single read against the merged code | — |
| real Chrome | 3 | — manual: the canned panel (the #275 probe harness under `R:/repos/Scratch/tmp/bot-275/probe/` has a real `handleRequest` + canned `runBotOps`; add a `recreate` answer): press Restart, confirm, see the sentence and a status reload; then a canned failure `{ok:false,recreated:true,log:"no such image"}` → `Failed: no such image`; paste what you observed | — |

### Step 5 — docs

- `ops/README.md`: a `recreate` row in the subcommand table (`:29-31` region) — what it runs, the JSON shape, that its output is relayed like `env-set`'s; the `restart` row gains "SSH-only since #277: the panel's Restart recreates"; the Apply-bar paragraph at `:564-566` ("Restart does not reload the env file (#277 tracks a recreate action)") is rewritten: Restart recreates, so a failed or killed recreate is finished from the panel with one click.
- `CONTEXT.md`: the same sentence at `:1338-1339`; the `ops/bot-ops.sh` row's subcommand list and the `ops/admin/server.ts` row's route list (Grep each row on a short unique substring; they are long); the gotcha that explains `BOT_OPS_SCHEMA` (`:962-964`) gets the `5` history line if it enumerates versions.
- `docs/plans/epics/E236/11-deploy-and-prove.md` does not exist yet; instead add one line to #247's "Host state change" comment thread when this merges: the deployed script must be schema 5 before the new panel image (the orchestrator does that).

### Acceptance — execute these, paste the real output

```
bash -n ops/bot-ops.sh
shellcheck ops/bot-ops.sh            # the same two warnings as main (SC2064, SC2155), no new one
bunx tsc --noEmit -p ops/tsconfig.json
bun run --cwd ops/admin check
bun test ops/bot-ops.test.ts --timeout 240000 -t "recreate|schema 5|usage"
bun test ops/admin/server.test.ts --timeout 20000
```

Then the real-Chrome run from the coverage table, and the mutation table: every row above, one mutant at a time in a detached scratch worktree, each with the failing test names. Name what is CI-only: the full `ops/bot-ops.test.ts` and the Docker image builds.

### PR

Title `feat(ops): the panel's Restart recreates the bot, so a failed recreate can be finished from the panel (#277)`; body with `Closes #277`, the plan-file path, deviations, the pasted acceptance output and Chrome observations, the mutation table, the round list with dispositions, and one line saying `POST /api/restart` is still routed and unused. Behaviour change on a privileged surface: the full gate — two adversarial read-only reviewers with different lenses (A: correctness and failure modes — the helper extraction, a compose failure's exit path, the handoff guard, the 502/504 mapping, what the page shows for each; B: claims-vs-code and test quality — every coverage-row mutant really fails only the test it names, and env-set's unedited tests really exercise the shared helper). At most four rounds, then stop and tell the orchestrator. **Never merge.**

**Process guards (standing — paste verbatim into every reviewer prompt):** every command foreground with an explicit timeout; anything that reads stdin (`bot-ops.sh env-set` / `plugin-request`, `python -`) gets a pipe or `</dev/null`, and no `python - <<EOF` for anything slow; ONE `ops/bot-ops.test.ts` or `ops/admin/server.test.ts` run at a time on this Windows box, never parallel mutation copies; `ops/bot-ops.test.ts` always with a `-t` filter — its full run is CI's; a private `TEMP`/`TMP` per test run (`test/setup.ts` sweeps the shared one, #252); reviewers run nothing in the background, get a 45-minute budget, are pointed only at a worktree whose HEAD was just verified to be the pushed head, write their report to a scratch dir under `R:/repos/Scratch/tmp/`, and are stopped when their verdict is in; before anyone reports idle, list processes by age (`Get-CimInstance Win32_Process`) and kill leftovers (`taskkill -F -T -PID <pid>` or `Stop-Process`) — on Windows, stopping an agent or a shell does not kill its `bun.exe` children.

## Deviations from the plan

- **Line cites re-verified, not reused.** The plan and wiring notes were written against `e1194e4`; the branch was correctly cut from `a4a8dbe` (after #278/PR #279 merged), which shifted line numbers in `ops/bot-ops.sh` (`RESERVED_KEYS` grew by ~24 lines) without changing any construct the plan named. Every cite was re-checked against `a4a8dbe` before editing; the implementation uses the re-checked line numbers, not the stale ones from the plan text (which is left verbatim above as the record of what was approved).
- **A second unanticipated PR landed on `main` mid-work.** The plan named #275 as the one PR that might land and said a plain merge was "expected to be clean." #275 (PR #288) did land, but so did #224 (PR #285, plugin install staging-dir extraction) — neither was anticipated together. `git merge origin/main` auto-merged cleanly everywhere except one hunk in `CONTEXT.md`, where this branch's #277 sentence (rewriting "Restart does not reload the env file" now that it does) and `main`'s new #275 paragraphs (the Apply bar's re-read locking, `aria-busy`, the two-GETs-no-timeout note) both touched the same paragraph. Resolved by keeping both: this branch's #277 rewrite, followed by `main`'s three new #275 paragraphs unedited. Re-verified after resolving: root/`ops`/`ops/admin` typecheck clean, the targeted `bot-ops.test.ts` filter still 15/15, and the full `server.test.ts` suite 674 pass / 1 skip / 0 fail (includes #275's and #224's own new tests).
- **Test 5 ("env-set's recreate still goes through the one helper") is not a new test file entry**, per the plan's own text — it names the *existing*, unedited `env-set` relay/scrub/backup tests as the ones that keep guarding the shared `recreate_bot()` helper from the other caller. Verified directly (not just asserted) as part of mutation-testing decision 2: reverting `cmd_env_set` to its own inline compose call (bypassing the helper, dropping the relay) fails 16 of those existing tests — see the mutation table.
