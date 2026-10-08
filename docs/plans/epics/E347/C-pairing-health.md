# Bundle C -- sections 6 and 7 (#357, #360, #351, #352, #364, #365, #373, #376, #377)

Part of [E347](README.md). Region: `ops/README.md` lines 903-934 (sections 6 and 7) on `4ff8eef`.
Documentation-only, single-audit lane. Effort S. Branch `docs/347-c-pairing-health`, worktree
`S:\Repos\_wt\rdb-347-c`.

Split children: #352's section 2 paragraph, #376's section 2/4 port and #377's section 2/5 pointers are
bundle B's. This plan owns their section 7 sentences only; the PR body says "part of #352/#376/#377, the rest
is bundle B" and does not close those three.

Read each child in full first (`gh issue view <N> --json title,body,comments`). Every `file:line` below was
read at the commit the README says or at `4ff8eef`; **re-read each on your tree** (this repo at your base;
discord-mcp at `fe46591` or newer; `plugins/mcp` at `2820afe`) and write the line you actually read. #392
(`5de2280`) added a `reset...ForTest` hook to most `src/` modules after the review, so expect small shifts.

The three commands in section 7 were executed by the orchestrator on the live Pip container on 2026-10-08
(`ssh roshne@192.168.7.48`, read-only); their output is in step 2 and is what you paste. Run them yourself
only if you change a command's text, over the same SSH (BatchMode works from this machine), and paste your
own output instead.

## Steps

### 1. Section 6 (lines 903-917)

Replace the section body with:

> In Discord, in the approved server, run `/pipagent register` and then `/pipagent pair` (a single-use,
> 10-minute pairing code, per the plugin's 0.2.0 release notes in the published index). From `mcp` 0.3.1 the
> bot's replies name the prefixed command; on 0.3.0 they said `/agent pair`
> (Rackbops/rackbops-bot-plugins#129). Then, on Melody, in PowerShell (the shell the live run used; the
> add-a-bridge runbook's section 7 has the POSIX form):
>
> ```powershell
> $env:DISCORD_MCP_URL = "https://mcp.rackbops.com/mcp"
> $env:DISCORD_MCP_CONFIG_DIR = "$env:APPDATA\discord-mcp-pip"
> node 'R:\repos\discord-mcp\dist\shim\cli.js' pair <code>
> ```
>
> `R:\repos\discord-mcp` is the discord-mcp checkout on Melody. The directory must be absolute
> (`src/shim/cli.ts:42-44` refuses a relative one), dedicated to Pip (a separate directory is what keeps the
> prod integration's `credentials.json` untouched), and under your own profile: the shim writes
> `credentials.json` with mode `0o600`, which Windows ignores (`cli.ts:80-82`), so the directory's inherited
> ACL is the plaintext bearer's only protection, and `%APPDATA%` inherits a user-only one while a directory
> at the root of a drive does not. `pair` saves the URL into `credentials.json`, so later runs need only the
> directory (`cli.ts:107-181`). Paste the code nowhere but that command.
>
> The command prints `Paired as u-<your Discord id>@pip. Credentials saved to ...` (`cli.ts:181`). Check the
> suffix. The service redeems a code on whichever bridge issued it (production bridges are tried first,
> `src/service/redeem.ts:177`) and the shim saves whatever principal comes back (`cli.ts:173-181`), so if the
> code came from `/agent pair` or `/ragent pair` on another bot by mistake, the Pip directory now holds an
> `@prod` or `@debug` principal while the prod directory still looks untouched: `unregister` on that bot and
> pair again with `/pipagent`. The add-a-bridge runbook ends the same step with a `whoami` expecting
> `u-<discord_user_id>@pip` (`deploy/add-bridge.md` section 7, step 5).

Carries #357 (the observable and the mismatch action; the plugins#129 heads-up is now a past-tense note
because 0.3.1 is live) and #360 (PowerShell, the example directory, the placement clause). Confirm against
section 10's command (lines 1055-1058) that the directory and the checkout path match.

### 2. Section 7 (lines 919-934)

Replace the section body with:

> ```sh
> docker logs --since "$(docker inspect -f '{{.State.StartedAt}}' rackbops-discord-bot-pip)" rackbops-discord-bot-pip 2>&1 \
>   | grep -E 'env file|Logged in as|\[release\]|mcp@'
> docker exec rackbops-discord-bot-pip bun -e \
>   'const r = await fetch("http://127.0.0.1:8794/mcp/capabilities", { headers: { authorization: "Bearer " + process.env.MCP_BRIDGE_TOKEN } }); console.log(r.status, await r.text()); process.exit(r.status === 200 ? 0 : 1)'
> ```
>
> The log check is bounded to the current boot on purpose: the container's log is cumulative across
> `bot-ops.sh restart` (`docker compose restart` of the same container, `ops/bot-ops.sh:670`) and across the
> crash-loop restarts of `restart: unless-stopped` (`docker-compose.yml:57`), so a bare `grep 'Logged in as'`
> can match an earlier boot while the new process is failing to log in. Expect, in order, `[boot] env file:
> /opt/rackbops-discord-bot/pip/.env` (`src/bootLog.ts:28`, printed every boot), `Logged in as pip#<tag>`
> (`src/index.ts:130`), `[plugins] mcp@<version> downloaded, integrity ok` and `[release] watcher off
> (WATCHED_REPOS=none)`.
>
> The probe reads the token from the container's own environment (`docker exec` inherits the create-time
> env, which is what `src/plugins/host.ts:85` hands the plugin) and never prints it. `200` with
> `{"dm":true,...}` says the listener is up, the token the plugin loaded is the file's, and DMs are enabled
> (`plugins/mcp/src/http.ts:191-200`). It costs no lockout budget: a valid bearer records no failure, and
> the lockout is keyed by peer address anyway (`plugins/mcp/src/auth.ts:63`, `src/net/clientIp.ts:112-121`),
> so it may run in a loop. Any other answer:
>
> - `401 {"error":"unauthorized"}` **with** the bearer: the token in the container is blank (a
>   `MCP_BRIDGE_TOKEN=` line with no value, section 2), so the plugin rejects every bearer
>   (`plugins/mcp/src/auth.ts:66-69`). Without the bearer `401` only says the listener is up and a token is
>   set, and cannot tell a blank one from a good one.
> - `503 {"error":"bridge not configured"}`: `MCP_BRIDGE_TOKEN` is absent in the container
>   (`plugins/mcp/src/http.ts:187`), for example appended to the `.env` without the recreate (section 5).
> - `503 Unavailable`, plain text: the host router's own answer for a plugin that loaded but is not running
>   (`src/plugins/host.ts:841`, `:861`): `activate()` threw and the log has `[plugins] mcp failed to
>   activate -- the bot keeps running without it` (`host.ts:547-549`). `src/http.ts:36` answers the same
>   while the listener is closing.
> - `404 Not found`: the plugin never loaded (`host.ts:839`): the index or the registry unreachable on a
>   fresh instance with no cache, a `hostApiVersion` skip, a throwing `createPlugin`; the bot runs core-only
>   (`src/index.ts:213-214`). `bot-ops.sh status` prints `plugins[]` with `error`, `active` and
>   `installedVersion` (`ops/bot-ops.sh:631-637`).
> - No answer: the listener binds last in boot, after login and plugin install (`src/index.ts:319-343`), so
>   a boot still in progress answers nothing yet; a bind failure logs `[http] could not listen on :8794`;
>   otherwise the port in the probe is not `HTTP_PORT`.
>
> Restart and logs are Clerk's step 6 with `pip` substituted: `install.sh`'s printed step 3 prints the four
> `BOT_OPS_*` lines instance-exact (`BOT_OPS_CONFIG_DIR=/opt/rackbops-discord-bot/pip`,
> `BOT_OPS_COMPOSE_FILE=/opt/stacks/rackbops-discord-bot-pip/docker-compose.yml`, and `BOT_OPS_PROJECT` and
> `BOT_OPS_CONTAINER` both `rackbops-discord-bot-pip`), then `bash /opt/rackbops-discord-bot/bin/bot-ops.sh
> restart`, or `recreate` (re-reads `.env`), or `logs 200` (`ops/bot-ops.sh:1362` lists the subcommands).

Carries #351 (status and body printed; the two host-router answers and "still booting / bind failed"
mapped; `bot-ops.sh status` named), #352's section 7 half (the blank-token reading), #364 (`--since` the
container's `StartedAt`, and why), #365 (the authenticated probe as the primary check; the rationing caveat
gone), #373 (three spans instead of `restart | recreate | logs 200`), #376's section 7 half (`8794` in the
probe, no placeholder), #377's section 7 half (the `BOT_OPS_*` set is named as `install.sh`'s printed step 3
with the instance values kept).

Executed output to paste, from the orchestrator's run on 2026-10-08 (JSON log lines because `LOG_FORMAT=json`;
the `started` line is the `StartedAt` the `--since` form used; the unauthenticated probe is the old
command's form, run once for #351's acceptance; nothing sensitive in any line):

```
== StartedAt
2026-10-08T13:02:42.125128904Z
== logs --since StartedAt (boot anchors)
{"time":"2026-10-08T13:02:42.672Z","level":"info","msg":"[boot] env file: /opt/rackbops-discord-bot/pip/.env"}
{"time":"2026-10-08T13:02:44.284Z","level":"info","msg":"Logged in as pip#0023"}
{"time":"2026-10-08T13:02:44.836Z","level":"info","msg":"[plugins] mcp@0.3.1 downloaded, integrity ok"}
{"time":"2026-10-08T13:02:44.844Z","level":"info","msg":"[release] watcher off (WATCHED_REPOS=none)"}
{"time":"2026-10-08T13:02:45.060Z","level":"info","msg":"Registered 4 slash commands"}
== unauthenticated probe (status + body)
401 {"error":"unauthorized"}
== authenticated probe (status + body)
200 {"dm":true,"targeted_post":true,"cards":true,"edit":true,"destinations":[{"destination":"alerts","description":"Time-sensitive findings and warnings"},{"destination":"deals","description":"Notable deals or opportunities"},{"destination":"digest","description":"Periodic summaries"},{"destination":"ops","description":"Operational status and infrastructure notices"}]}
```

### 3. Checks, audit, PR

- Re-read every cite on your tree; paste `git rev-parse --short HEAD` for each tree used.
- Paste the executed output above (or your own re-run) under #351, #364 and #365.
- Spawn one read-only claims-vs-code audit subagent over the diff (lens: each of the five probe readings
  against `plugins/mcp/src/http.ts`, `auth.ts`, `src/plugins/host.ts`, `src/http.ts`, `src/index.ts`; the
  `Paired as` string and the redeem order against discord-mcp; the PowerShell block actually parses). Fix or
  decline each finding in writing.
- PR title: `docs(ops): Pip runbook pairing check and bounded health probes (#347)`. Body: `Closes #357, #360,
  #351, #364, #365, #373`; `Part of #352, #376, #377 (the rest is bundle B)`; the pasted output; the audit
  findings. Do not merge.

## Coverage

| Acceptance bullet | Step | Check | What it catches |
|---|---|---|---|
| #357: section 6 names `Paired as u-<id>@pip` and the mismatch action, citing `cli.ts:181` and add-bridge section 7 | 1 | audit re-reads both | the step ending without the check |
| #360: the command runs in the shell it names; placement names the profile and cites `cli.ts:80-82` | 1 | paste the block into `pwsh -NoProfile -Command -` with a dummy code and a scratch dir: it must reach the shim and fail on the code, not on parsing | a POSIX line under a PowerShell label |
| #351: the probe prints status and body; the five readings mapped with cites; one run pasted | 2 | the pasted `401 {"error":"unauthorized"}` and the audit | a reading attributed to the wrong cause |
| #352 (section 7 half): the blank-value reading | 2 | audit re-reads `auth.ts:66-69` | `401` read as healthy |
| #364: the login check bounded to the current boot and the text says why | 2 | the pasted `--since` output | a stale boot's line accepted |
| #365: the authenticated probe shown, `200` expected, the lockout said to be per peer address; one run pasted | 2 | the pasted `200 {"dm":true,...}` | the rationing caveat back |
| #373: no code span uses `|` for "one of" | 2 | grep the section for `restart \| recreate` -> none | the pipeline back |
| #376 (section 7 half): no placeholder in the probe | 2 | grep for `<HTTP_PORT>` -> none | the placeholder back |
| #377 (section 7 half): the `BOT_OPS_*` export block not copied | 2 | grep for `export BOT_OPS_` in the Pip section -> none | the copy back |
| Every bundle: independent audit, nothing outstanding | 3 | the findings on the PR | a false claim shipping |

## Hand-off brief

```
EXECUTE AS WRITTEN
Repo: Rackbops/rackbops-discord-bot. Plan: docs/plans/epics/E347/C-pairing-health.md on main (also the ## Plan comment on #347 for bundle C). Children: #357, #360, #351, #352, #364, #365, #373, #376, #377 -- read each in full, comments included; you own only the section 7 sentences of #352, #376 and #377.
Worktree: git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-347-c origin/main -b docs/347-c-pairing-health (fetch first). Sibling trees: discord-mcp at S:\Repos\discord-mcp (fetch; git show origin/main:<path>), plugins/mcp 0.3.1 at Rackbops/rackbops-bot-plugins 2820afe.
Documentation-only, single-audit lane: verify every cite on your tree while writing, paste the executed output the plan carries (re-run over ssh roshne@192.168.7.48 only if you change a command), then one read-only claims-vs-code audit subagent; fix or decline each finding in writing. Scratch files use task-unique names (pr-body-347c.md, commit-msg-347c.txt) and are read back before use. Rebase on origin/main before marking ready; never resolve a conflict in another bundle's region -- report it. Report the PR link, the pasted checks, the audit's findings and any deviation. Do not merge.
```
