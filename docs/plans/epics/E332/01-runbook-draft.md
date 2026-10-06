<!-- Plan for Rackbops/rackbops-discord-bot#333 (Epic #332), written by the orchestrating session on
2026-10-06 against `main` @ `8d039c9`, then corrected the same day by an independent claims-vs-code
audit (seven cites had come from a stale checkout; one behaviour claim -- "no admins -> announce
channel" -- was false). Every file:line below is now read from 8d039c9; the implementer re-reads each
one on the tree it works from and corrects any that moved. -->

## Implementation plan -- #333: the Pip section of `ops/README.md`

Documentation only. This is the **single-audit lane**: verify every claim against source while
writing it, then one independent claims-vs-code audit before the PR. No three-reviewer gate.

### What the section is for

An operator stands Pip up from this section the way they stand Clerk up from "A Rackbops Clerk
instance" (`ops/README.md:488-663`): same shape, same level of citation. It also carries the
written half of the epic's G5 decision -- the **core-output table** -- so that "with `PLUGINS=mcp`
and this `.env`, the host emits nothing unsolicited that reaches Rod as a DM" is a documented,
cited claim rather than an assumption.

### Step 1 -- worktree and shape

`git worktree add <path> origin/main -b docs/333-pip-runbook`. Read the Clerk section whole before
writing; mirror its subsection order (the application, bootstrap and `.env`, up, health, restart
and logs) and add the two Pip-specific ones (what the core still does; the bridge and pairing).
Insert the new `## A Pip instance (owner result DMs)` section immediately after the Clerk section
(before the next `## ` heading that follows it).

### Step 2 -- the opening paragraph and "what it is"

- One paragraph: Pip is a separate `ops/install.sh` instance (`pip`) logged in as the **Pip**
  application, loading only `@rackbops/plugin-mcp`, whose purpose is to be the visible sender of
  owner result DMs sent through `Rackbops/discord-mcp`'s `pip` bridge. Link the epic (#332) and the
  design document (`docs/plans/epics/EP-pip-discord-identity.md`).
- State the two identities explicitly: the **bot** (the Pip application, what Rod sees as the DM
  author) and the **principal** (Rod's own paired user, `u-<id>@pip`, holding only `dm:self`,
  which is what authorises the send). `whoami` reports the second, never the first.

### Step 3 -- "1. The Discord application"

Follow Clerk's step 1 but cite the **official** Discord developer documentation, with the date
read, for each of: creating an application; the Bot page and keeping every privileged intent off;
the Installation page with **Guild Install** only, scopes `bot` and `applications.commands`, and
User Install left off. Fetch the pages (WebFetch) rather than recalling them. Note that the
plugin declares `intents: []` (the published manifest, `plugins.json` entry for `mcp`, and
`plugins/mcp/package.json` in `Rackbops/rackbops-bot-plugins`) and the core needs only `Guilds`
(`src/client.ts:15`), so nothing privileged is ever required. The avatar is a separate task; the
section says only that the application's name is `Pip`.

### Step 4 -- "2. Bootstrap and `.env`"

The `install.sh pip` curl line (as Clerk's step 3), then this block, each key with its one-line
reason in a `#` comment on its own line (the Clerk section explains why comments are not placed
after values):

```sh
DISCORD_TOKEN=<Pip's bot token>
# Required by the core (src/config.ts:78). A private channel in the approved server that only Rod
# can read: the one unsolicited core output that can exist (a release post, see the table below)
# lands here, never in a DM.
ANNOUNCE_CHANNEL_ID=<channel id>
RELEASE_ANNOUNCE_CHANNEL_ID=
# The one approved server: with it set, registration is one guild-scoped PUT there and nowhere
# else (src/routing/register.ts:56-59, reached from src/index.ts:366-382).
DISCORD_SERVER_ID=<server id>
# Every command is prefixed, core ones included (src/commandNaming.ts:13, src/commands.ts:63-67):
# /pipagent register|pair|unregister, /pipupdate, /pipplugins, /pipreport. The debug bot's prefix
# `r` (/ragent) is the precedent -- discord-mcp deploy/config.multi-bridge.example.json:8.
COMMAND_PREFIX=pip
GITHUB_REPO=Rackbops/rackbops-discord-bot
# Blank falls back to GITHUB_REPO (src/config.ts:149); that repository publishes no releases.
WATCHED_REPOS=
GITHUB_TOKEN=
# Blank: /report answers that it is not configured.
REPORT_ROLE_ID=
# Empty on purpose: with no admins a plugin-update notice is only a log warning, repeated each
# 15-minute poll, and is never DMed or posted (src/plugins/updates.ts:492-495; the channel
# fallback at :507-509 runs only after a DM to a configured admin failed). Updates happen by
# re-running install.sh and the printed step 2.
ADMIN_USER_IDS=
AUTO_UPDATE=false
BOT_BRANCH=main
PLUGINS=mcp
PLUGIN_INDEX_URL=
# The host router (ADR-0007): the bridge answers under /mcp/ on this port, in-network only.
HTTP_PORT=<free internal port>
TRUSTED_PROXY_HOST=
LOG_FORMAT=json
# The pip bridge's shared secret -- the same value the discord-mcp service holds as
# DISCORD_MCP_BRIDGE_TOKEN_PIP. Generated once, written to both files, never printed.
MCP_BRIDGE_TOKEN=<43+ characters, base64url>
```

Say that `MCP_BRIDGE_TOKEN` is the plugin's own secret key (`format ^\S{43,}$`, `secret: true` in
the manifest), reaches the plugin through the instance `.env` like any plugin key, and that the
installer's printed `ADMIN_TOKEN` line is read in Rod's own shell and never pasted anywhere (the
admin profile is not started for Pip). Then install.sh's printed step 2 as the "Up" step. No
tunnel, no admin profile.

### Step 5 -- "3. What the core still does" (the core-output table)

One row per path; columns *Path*, *Where it goes under this `.env`*, *Why it is bounded*,
*Evidence*. Read each cite on your tree and quote the line numbers you read:

| Path | Expected finding (verify, then cite) |
|---|---|
| Release watcher | `src/announce.ts` `tickChecks` -> `checkReleases` -> `checkRepoReleases` (`:384-425`) polls every 15 min (`RELEASE_POLL_GAP_MS`, `:27`); `commitReleaseAnnouncements` (`:437-457`) **seeds silently on the first poll** (`:443-449`); posts go to `releaseAnnounceChannelId` -> `ANNOUNCE_CHANNEL_ID` (`src/config.ts:146`, `src/announce.ts:73-75`). The watched repo is `GITHUB_REPO` (`src/config.ts:149`), which has no releases (`gh release list --repo Rackbops/rackbops-discord-bot` is empty on your date). |
| Plugin-update notice | `src/plugins/updates.ts` `deliverPluginNotification` (`:486-516`): with `ADMIN_USER_IDS` empty it logs `[plugins] a plugin update is available but ADMIN_USER_IDS is empty` and returns `false` (`:492-495`); the version stays un-notified and the warning repeats each 15-minute poll (`checkPluginUpdates`, `:576-591`). The announce-channel fallback (`:507-509`) is reached only after a DM to a configured admin failed. So: a log line, never a DM, never a post. |
| Self-update tick | `tickChecks` has an `autoUpdate` check (`src/announce.ts:223-228`) that does nothing with `AUTO_UPDATE=false`. |
| `/pipupdate`, `/pipplugins` | The core `update`/`plugins` commands, prefixed like every command (`src/commandNaming.ts:13`); `setDefaultMemberPermissions(0)` (`src/commands.ts:107`, `:138`) hides them from non-admin members, and the handler refuses anyone not in `ADMIN_USER_IDS` (find the check in `src/commands.ts` and cite it) -- with the list empty, nobody. |
| `/pipreport` | Replies ephemerally "`/report` isn't configured -- an admin must set `REPORT_ROLE_ID` and `GITHUB_TOKEN`." when either is blank (`src/report.ts:62-68`). |
| `/pipagent` | The plugin's `agent` command, prefixed by `buildCommandBody` (`src/plugins/host.ts:293-332`, called at `src/index.ts:212`), registered with the core commands through `initRouting`/`applyRouting` (`src/index.ts:366-382`) -- in single mode (no `routing.json`) that is one guild-scoped PUT to `DISCORD_SERVER_ID` (`src/routing/register.ts:56-59`, `:128-131`), the path the Clerk section also cites. Not a direct REST put in `index.ts`. |
| Report-backs after an update | `reportUpdateOutcome` (`src/index.ts:439`) and `reportPluginUpdateOutcome` (`:443-454`) deliver only an owed follow-up to an explicit `/pipupdate` or `/pipplugins update`, which nobody can run here. |
| Boot, handoff, ticks | Log lines only (`src/bootLog.ts`, `src/index.ts`); the mailbox drain and discovery refresh write files, not messages. |

Interaction replies (`/pipagent`, the refusals above) are solicited: someone typed the command.
Close the table with the one-sentence conclusion the epic relies on: under this configuration the
only **unsolicited** Discord output that is not a bridge delivery is a release post into the
private channel, which cannot occur while the watched repository publishes no releases -- and no
path produces a DM.

### Step 6 -- "4. The bridge" and "5. Pairing on Melody"

- The bridge: the three values this side supplies -- container name
  `rackbops-discord-bot-pip`, `HTTP_PORT`, `MCP_BRIDGE_TOKEN` -- and the bot's compose network
  `rackbops-discord-bot-pip_default`; then a link to `deploy/add-bridge.md` in
  `Rackbops/discord-mcp` (being written as #334; link the path, it will exist when both merge) for
  the service side. State that `GET /mcp/capabilities` answers `401` without the bearer, so a 401
  from inside the network is the "listener up" check, not a failure.
- Pairing, as #337's scope: `/pipagent register`, `/pipagent pair` in Discord; on Melody
  `DISCORD_MCP_URL=https://mcp.rackbops.com/mcp DISCORD_MCP_CONFIG_DIR=<new Pip-only dir> node <checkout>/dist/shim/cli.js pair <code>`
  (`src/shim/cli.ts:104-182` in discord-mcp: the URL is saved into `credentials.json`, so later
  runs need only the directory). Say why a dedicated directory: the shim resolves credentials from
  `DISCORD_MCP_CONFIG_DIR` (`cli.ts:39-53`), so a separate directory is what keeps the prod
  integration's `credentials.json` untouched. The code is never pasted into an issue or transcript.

### Step 7 -- "6. Health, restart and logs" and "7. Rollback and disable"

- Health: `docker logs rackbops-discord-bot-pip` for `Logged in as`, and the in-network 401 probe
  from step 6 via `docker exec rackbops-discord-bot-pip bun -e '...'` (adapt Clerk's step 5 form,
  path `/mcp/capabilities`, expect `401`). Restart and logs: Clerk's step 6 with `pip` substituted.
- Rollback and disable, in this order: stop sending (remove the Pip credentials directory on
  Melody, or `/pipagent unregister`); stop Pip -- `bot-ops.sh` has no stop subcommand
  (`ops/bot-ops.sh:1361` lists them), so it is
  `docker compose -f /opt/stacks/rackbops-discord-bot-pip/docker-compose.yml -p rackbops-discord-bot-pip stop`;
  remove the `pip` bridge from the service per the add-a-bridge runbook's rollback; never restore
  the service's state from a snapshot. Token revocation and deleting the application are Rod's
  explicit calls.

### Step 8 -- checks, audit, PR

- `bun run check` and `bun test` (nothing but Markdown changed; say so in the PR).
- A link check: every relative path the section names exists on your tree (`ls` each), every
  `file:line` was re-read.
- **One independent audit**: spawn one read-only reviewer with the finished section and the tree,
  instructed to verify every `file:line`, every quoted env key against `.env.example`, every
  Discord claim against the cited page, and to report anything the section asserts that the code
  does not do. Fix or decline each finding in writing on the PR.
- PR title `docs(ops): a Pip instance -- owner result DMs (#333)`, body with the audit's result and
  the exact check output. Do not merge; report back with the PR link.

### Coverage table

| Acceptance bullet | Step(s) | Verification | What would make it fail |
|---|---|---|---|
| Section present; every `file:line` read on the stated commit; Discord claims cite page + date | 1-7 | manual: the audit pass re-reads each cite | a cite that does not say what the row says |
| Core-output table covers every path with destinations (the eight rows above) | 5 | manual: audit compares the table to `src/announce.ts` `tickChecks` and `src/index.ts` `activate` | a path in `tickChecks` / `activate` with no row |
| One independent audit, findings fixed or declined | 8 | the reviewer's report on the PR | none |
| `bun run check` / `bun test` unchanged | 8 | the pasted output | n/a (docs only) |

### Hand-off brief (spawn text)

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot (worktree from origin/main). Issue: Rackbops/rackbops-discord-bot#333.
Plan: docs/plans/epics/E332/01-runbook-draft.md on branch claude/epic-pip-plans (read it from that branch: git show origin/claude/epic-pip-plans:docs/plans/epics/E332/01-runbook-draft.md).
Documentation only; single-audit lane. Scratch files: use task-unique names (pr-body-333.md). Report the PR link, the audit result and any deviation from the plan.
```
