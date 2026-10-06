<!-- Operator plan for Rackbops/rackbops-discord-bot#336, #337, #338 (Epic #332), written by the
orchestrating session on 2026-10-06 against `main` @ `8d039c9` and Rackbops/discord-mcp @ `315d470`.
Driven by the orchestrating session with Rod, one command per block, in the order below; never handed
to a subordinate. Host facts (nucbox paths, the stack directory, the deploy timer) are from
`ops/README.md`, `docs/plans/epics/E236/13-deploy-and-prove.md` and discord-mcp's `deploy/pins.md`,
not re-checked on the host before this was written. -->

## Operator plan -- #336 bring-up, #337 pairing, #338 live acceptance

**STOP rule:** any output that is not what a step says to expect -- stop, paste it back, do not
improvise. **Secrets rule:** the installer's `ADMIN_TOKEN` line, the bridge secret, the pairing
code and every `credentials.json` are read by Rod in his own shell and never pasted into an issue,
a chat or a model transcript; evidence is pasted with ids redacted.

Prerequisites, all on #332: Q1-Q3 answered (or their defaults recorded on #336), #333 and #334 at
least reviewed on their branches (their runbooks are what the blocks below follow), #335 merged
before #338.

### 1. #336 -- Pip application, instance and bridge (nucbox)

**1.0 Baseline (A10).** In one SSH shell on nucbox:

```bash
docker ps --format '{{.Names}} {{.Status}}'
```
```bash
docker inspect -f '{{.Name}} {{.State.StartedAt}}' rackbops-discord-bot-prod rackbops-discord-bot-debug rackbops-discord-bot-clerk discord-mcp
```
Paste both on #336. These are the "unchanged afterwards" references.

**1.1 The application (Rod, Discord developer portal).** Per `ops/README.md`'s Pip section step 1:
create `Pip`, Bot page with every privileged intent off, Installation = Guild Install only with
`bot` + `applications.commands`, invite it to the one approved server. Record the application id
on #336 **redacted** (first and last two digits).

**1.2 Bootstrap.** In Rod's own shell (not through a model), so the printed `ADMIN_TOKEN` line is
seen by nobody else:

```bash
curl -fsSL https://raw.githubusercontent.com/Rackbops/rackbops-discord-bot/main/ops/install.sh | bash -s -- pip
```
Expect `wrote /opt/rackbops-discord-bot/pip/.env`, the shared `bin/bot-ops.sh` and compose lines
from `main`, and the next-steps text. Paste only the `install: wrote` lines.

**1.3 `.env`.** Rod edits `/opt/rackbops-discord-bot/pip/.env` to the runbook's block (step 4 of
#333's plan): token, private `ANNOUNCE_CHANNEL_ID`, `DISCORD_SERVER_ID`, `COMMAND_PREFIX=pip`,
`ADMIN_USER_IDS=`, `AUTO_UPDATE=false`, `PLUGINS=mcp`, `HTTP_PORT=<free port>`, `LOG_FORMAT=json`.
`MCP_BRIDGE_TOKEN` is appended in 1.5 together with the service's copy. Check the port is free:

```bash
docker ps --format '{{.Names}} {{.Ports}}'; grep -h '^HTTP_PORT=' /opt/rackbops-discord-bot/*/.env
```

**1.4 Up.** install.sh's printed step 2, pasted from 1.2's output -- it is a bare
`docker compose -f /opt/stacks/rackbops-discord-bot-pip/docker-compose.yml -p rackbops-discord-bot-pip up -d --build`
with nothing to export, since the stack `.env` install.sh wrote carries `GIT_SHA`, `BOT_ENV_FILE`,
`BOT_BUILD_CONTEXT` and `BOT_OPS_CONTAINER` (`ops/install.sh:333-341`). Then:

```bash
docker logs --since 5m rackbops-discord-bot-pip 2>&1 | jq -rR 'fromjson? | .msg' | grep -E 'env file|\[plugins\]|Logged in as|Registered|\[startup\]|\[routing\]'
```
Expect `[boot] env file: /opt/rackbops-discord-bot/pip/.env`, `[plugins] index: ..., 1 selected, 0 skipped`,
`Logged in as Pip#NNNN`, `Registered N slash commands` (the prefixed `/pipagent` among them), no
`[startup]` error. Paste. Then the identity and the single server:

```bash
for i in pip prod debug clerk; do printf '%s: ' "$i"; docker exec rackbops-discord-bot-$i cat /app/data/discovery.json | jq -c '{bot: .bot.id, guilds: (.guilds|length)}'; done
```
(`jq` runs on the host: the bot image installs nothing beyond `oven/bun:1-slim`, `Dockerfile:1-27`;
`bot-ops.sh` itself reads the bot's files this way, `ops/bot-ops.sh:517-518`.) Expect `guilds: 1`
for pip and a bot id that differs from the other three. Paste all four, ids redacted.

**1.5 The bridge** -- follow `deploy/add-bridge.md` (#334) literally, with `<instance>=pip`,
`<ID>=PIP`, bridge id `pip`, `commandPrefix` `pip`, `test: false`, network
`rackbops-discord-bot-pip_default`. The secret is generated once and appended to both files without
printing; Pip is recreated (`bot-ops.sh recreate` with the pip identity from install.sh's printed
step 3) **before** the service restart; the deploy timer is stopped for the restart and started
after. Expect, in order: Pip's log `Logged in as` again; the service's `loaded config from` line;
`pins.js show` listing `pip`; `curl -sS https://mcp.rackbops.com/healthz` 200; a prod caller's
`whoami` from Melody still `@prod`. Paste each.

**1.6 A10 after.** Re-run 1.0's two blocks; prod, debug and Clerk `StartedAt` unchanged. Paste.

**Rollback (1.x):** the add-a-bridge runbook's rollback for the service; stop Pip with
`docker compose -f /opt/stacks/rackbops-discord-bot-pip/docker-compose.yml -p rackbops-discord-bot-pip stop`
(`bot-ops.sh` has no stop subcommand, `ops/bot-ops.sh:1361`); keep `/opt/rackbops-discord-bot/pip`
for diagnosis; token revocation and deleting the application are Rod's explicit calls.

### 2. #337 -- the Pip local integration (Melody)

**2.1** In Discord, in the approved server: `/pipagent register`, then `/pipagent pair`. The code
is shown to Rod only.

**2.2** On Melody, in PowerShell, with `<checkout>` the built discord-mcp checkout that the prod
`discord-shim` integration already uses and `<pipdir>` a new directory (for example
`$env:APPDATA\discord-mcp-pip`):

```powershell
$env:DISCORD_MCP_URL = 'https://mcp.rackbops.com/mcp'; $env:DISCORD_MCP_CONFIG_DIR = '<pipdir>'; node '<checkout>\dist\shim\cli.js' pair <code>
```
Expect `Paired as u-<id>@pip. Credentials saved to <pipdir>\credentials.json.` Paste with the id
redacted. (`src/shim/cli.ts:180-181` prints exactly that; the `@pip` suffix is the
bridge-qualified principal.)

**2.3 A2.** With #335 merged, from the same checkout:

```powershell
$env:DISCORD_MCP_CONFIG_DIR = '<pipdir>'; node '<checkout>\scripts\result-dm.mjs' --bridge pip --event probe-a2 --label probe --status done --expires (Get-Date).AddHours(1).ToString('o') --dry-run
```
Expect one JSON line on stdout with `outcome: dry_run`, `principal_id: u-<id>@pip`,
`bridge: pip`, `recipient_id` equal to Rod's id, and the would-be `content` (the dry run carries
what it resolved; grants are checked inside the script, which would have printed `denied` with
`code: no-dm-self` otherwise). Before #335 lands, the equivalent is
`tools.mcp__<pip server>__whoami` from Codex or the dev-instance probe shape from
`deploy/dev-instance.md` step 6 with the token read from the Pip credentials file by the script
itself, never echoed. Then the prod integration's `whoami` (its usual route): still `@prod`. Paste
both, ids redacted.

**2.4 A5.** `/pipagent unregister`, then `/pipagent register`; re-run 2.3's Pip command -> outcome
`denied`, `stage: whoami`, `code: ACCESS_DENIED` (the service's registration gate refuses
`whoami` itself for a superseded generation, `src/service/tools.ts:145-157`,
`src/service/registration.ts:246-248`); the prod `whoami` still answers. Then `/pipagent pair`
and 2.2 again -> restored. Paste the three results.

**2.5** State on #337 that `~/.codex/config.toml` on Melody was not edited (the prod integrations
are untouched); if Rod chooses to add a `[mcp_servers.pip-discord]` stdio entry for the Codex
route, that is additive and is recorded there.

### 3. #338 -- live acceptance A1-A11 and the rollback rehearsal

Each Discord-affecting row is one fixture Rod approves before it runs (G7). All commands run on
Melody with `DISCORD_MCP_CONFIG_DIR` = `<pipdir>`; evidence is the script's stdout line (redacted)
and, where named, a host or Discord observation. Event ids are fixed per row so a re-run is a
duplicate, never a second message. Every invocation carries `--bridge pip` (the pin) and
`--expires` (required, fail-closed): for a fixture, `(Get-Date).AddHours(24).ToString('o')` in
PowerShell; the status words are `done|failed|blocked|cancelled`.

| Row | Command / action | Expect |
|---|---|---|
| A1 identity | `result-dm.mjs --bridge pip --event a1 --label "A1 identity fixture" --status done --expires <now+24h>` | `sent`, a `url` under `discord.com/channels/@me/...`; Rod sees the DM from **Pip**; the message's author id (Discord's Copy ID on the author) equals the application's bot user id from 1.4. **The approved avatar stays an outstanding item on #338** until the asset Rod reviews is on the application; name + id alone do not close A1 (Pip's Q1 answer on #332) |
| A3 duplicate | the A1 command again; then with `--label "A1 changed"` | `duplicate` with the same `message_ref`; then `invalid`; one visible DM |
| A4 blocked | Rod blocks Pip (or closes DMs from server members); `--event a4 ... --status failed --expires <now+24h>`; unblock; the same command again | `unreachable`; after unblocking, running the **same** event again is the operator's choice and yields `sent` -- paste both, and note that nothing resent on its own |
| A6 outage | `docker compose -f /opt/stacks/rackbops-discord-bot-pip/docker-compose.yml -p rackbops-discord-bot-pip stop` on nucbox; `--event a6 ...`; start Pip (`... start`); the same command | with Pip down the registration gate cannot reach the bridge, so `unavailable` at `stage: whoami` (exit 3, nothing sent); an interruption that lands mid-send instead gives `pending` or `unknown`; after the restart the same event -> `sent` or `duplicate`; the proof is one DM in Discord, never two |
| A7 privacy | `grep -c` the Pip token, the bridge secret's first 8 characters and the pairing code against the script's captured output and `docker logs discord-mcp --since 30m` | `0` for each; paste the counts, never the values |
| A8 Melody unavailable | with Melody's connected-computer link off, hosted Pip runs an approved result task | hosted chat reports the delegation failed; no DM |
| A9 policy | one included task (started with "notify me on Discord", the phrase Pip proposed on #332) and one excluded task, through hosted Pip | one DM for the included task (`sent`), none for the excluded; runs only after Rod has approved the Q4 policy on #332 -- no approval, no A9 and no routine sends |
| A10 preserved | 1.0's two blocks | prod, debug, Clerk unchanged since 1.6 |
| A11 restart | `bot-ops.sh restart` with the pip identity, then the A1 command again | `duplicate`; no second DM; `docker exec rackbops-discord-bot-pip cat /app/data/mcp/deliveries/<message_ref>.json \| jq .state` is `delivered` (the plugin keeps one file per request under `mcp/deliveries/`, rackbops-bot-plugins `plugins/mcp/src/store.ts:24-29`; `<message_ref>` is the 64-hex value the A1 run printed) |
| A2, A5 | 2.3 and 2.4 once more after A4's restore | as in #337 |

**Rollback rehearsal**, after the rows: 1.x's rollback in order (disable on Melody by renaming
`<pipdir>`; stop Pip; remove the `pip` bridge, network and token line from the service and restart
it in the window; re-run 1.0; prod, debug, Clerk healthy), then restore every step (bridge back, Pip
up, `<pipdir>` renamed back, `result-dm.mjs --dry-run` resolves again). Paste the health lines at
both ends.

**Hosted Pip in the loop (A8, A9, the exit demo):** these need Pip's answer to Q6 on #332 and Rod
at the hosted side; they are the last rows run, and the exit demo is A9's included case observed
end to end with hosted chat's report quoted.
