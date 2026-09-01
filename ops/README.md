# Bot ops helper

> **Fork note.** This script and doc were extracted, with history, from
> [nazumods/wow](https://github.com/nazumods/wow) — credit to
> [Nazuraki](https://github.com/nazumods) for the original design. The consumers described
> below — `apps/warbandeer-desktop`'s and `wow-companion`'s **Ops** tabs, and the shared
> `apps/bot-ops` backend — live in the original monorepo and `roshne/wow-companion`, not in
> this repo. The script itself is still fully usable on its own: SSH to a box running this
> bot and invoke it directly (see **Run directly on the box** below).

`bot-ops.sh` is the **only** privileged surface behind the **Ops** tab — shipped by two apps
(`apps/warbandeer-desktop` and `roshne/wow-companion`, neither part of this repo — see the
Fork note above), which share one backend in `apps/bot-ops` in the original monorepo
(`nazumods/wow`, not linkable from here since it isn't part of this fork). Neither app runs
docker or edits the bot's `.env` itself — they SSH to the box and invoke this script, one
subcommand at a time. Keeping the whitelist and the apply logic here (versioned, reviewable)
means **bot secrets never leave the box**.

This script is the **authority** on which keys may be written; `apps/bot-ops`'s `OPS_FIELDS` only
mirrors it for display. Add a key here first — a key added only to the module is rejected at apply
time, not silently written.

## Subcommands

| Command | Does |
|---|---|
| `status` | JSON: container running?, status line, image, last-observed realm status |
| `logs [N]` | Last `N` container log lines (default 200, capped 5000), raw |
| `restart` | Restart the bot process in place (`docker compose restart`) — no env reload |
| `env-get` | JSON of the **non-secret** editable env keys and their current values |
| `env-set` | Read `KEY=VALUE` lines from **stdin**, validate, back up `.env`, apply real changes, then `up -d --force-recreate` to load them |

Run directly on the box to test. `BOT_OPS_CONFIG_DIR` (holds `.env` + `backups/`) and
`BOT_OPS_COMPOSE_FILE` (the deployed `docker-compose.yml`, under `/opt/stacks/` for Dockge — see
[Bootstrapping a fresh instance](#bootstrapping-a-fresh-instance-no-checkout)) are **required**,
with no fallback to the script's own location:

```sh
export BOT_OPS_CONFIG_DIR=/opt/rackbops-discord-bot/debug
export BOT_OPS_COMPOSE_FILE=/opt/stacks/rackbops-discord-bot-debug/docker-compose.yml
bash ops/bot-ops.sh status
echo "RELEASE_ANNOUNCE_CHANNEL_ID=1529152068055728330" | bash ops/bot-ops.sh env-set
```

## Bootstrapping a fresh instance (no checkout)

`ops/install.sh` sets up a new instance (`debug`, `prod`, or any other name) on a host that has
nothing but `git`, `docker`, and `curl` — no clone of this repo, no Bun toolchain. It's curl-able
directly from the public repo:

```sh
curl -fsSL https://raw.githubusercontent.com/roshne/rackbops-discord-bot/main/ops/install.sh \
  | bash -s -- debug
```

It creates `/opt/rackbops-discord-bot/<instance>/.env` from `.env.example` (never overwritten on
a re-run — fill in secrets there by hand). It always refreshes two things that are deployment
artifacts, not instance config — `/opt/rackbops-discord-bot/bin/bot-ops.sh` (shared across every
instance on the host) and `/opt/stacks/rackbops-discord-bot-<instance>/docker-compose.yml`
(Dockge lists it as a managed stack because it lives under `/opt/stacks/`, the one path Dockge
actually scans) — both written to a temp file first and moved into place atomically, so a dropped
connection mid-download never leaves a truncated file that a later run's existence-check could
mistake for something real. It prints the exact `docker compose up -d --build` command to run
once `.env` is filled in, and the `BOT_OPS_CONFIG_DIR`/`BOT_OPS_COMPOSE_FILE` exports for day-2
`bin/bot-ops.sh` use afterward — see the script's own output, or read `ops/install.sh` directly.

The compose file's `build.context` defaults to `.` (a local checkout, unchanged for anyone
running `docker compose up -d --build` from a clone) — the bootstrap command instead supplies
`BOT_BUILD_CONTEXT=https://github.com/roshne/rackbops-discord-bot.git#<branch>` as a one-shot
shell variable on that single invocation, so the Docker daemon fetches and builds the source
itself. It is **not** written into `.env` — nothing rebuilds via `docker compose --build` after
that initial bring-up (self-update's own rebuilds go through the Docker Engine API directly, in
`src/redeploy.ts`, independent of this file); a future manual rebuild needs the same variable
re-supplied by hand. `GIT_SHA` (for self-update's staleness check) is resolved via
`git ls-remote` at bootstrap time — no clone needed for that either.

## Editable keys (whitelist)

`ANNOUNCE_CHANNEL_ID`, `RELEASE_ANNOUNCE_CHANNEL_ID`, `GUILD_ID`, `REPORT_ROLE_ID`,
`ADMIN_USER_IDS`, `WOW_REALM`, `WOW_REGION`, `WATCHED_REPOS`, `DMF_TIMEZONE`, `AUTO_UPDATE`,
`BOT_BRANCH`, `COMMAND_PREFIX`. Each is validated against a format regex; an empty value clears
the key back to its documented default.

**Secrets are intentionally absent** — `DISCORD_TOKEN`, `BLIZZARD_CLIENT_ID`,
`BLIZZARD_CLIENT_SECRET`, `GITHUB_TOKEN`, `CLOUDFLARE_TUNNEL_TOKEN`. `env-get` never reads them
out and `env-set` refuses to write them. Edit those by hand with `nano` on the box.

## Safety notes

- **Compose project + container come from `BOT_OPS_PROJECT` / `BOT_OPS_CONTAINER`** (a panel passes
  them per selected bot), defaulting to the debug bot's `warbandeer-discord-debug` /
  `warbandeer-discord`. The project must be passed with `-p` because it is *not* set in a
  non-interactive SSH shell's environment (a bare `docker compose` would default to the directory
  name and miss the running container); both are validated to a safe charset before use.
- **`BOT_OPS_CONFIG_DIR` / `BOT_OPS_COMPOSE_FILE` are required, with no fallback.** The script no
  longer derives anything from its own location — those two independent paths (config dir vs.
  the Dockge-managed compose file, see [Bootstrapping](#bootstrapping-a-fresh-instance-no-checkout))
  must always be passed explicitly. An unset one is a loud, named error, not a guess.
- **`env-set` rebuilds `.env` line-by-line** (no `sed`), so a value can never inject into the
  file, and comment/blank/secret lines are preserved verbatim. A timestamped
  `<config-dir>/backups/.env.bak.<stamp>` is written before any change; a no-op (new value equals
  current) does nothing and does **not** restart the bot.
- Applying an env change **recreates the container** (brief restart) because env vars are frozen
  at container start; a plain `restart` would not reload them.
- That recreate deliberately does **not** pass `--build`, so it reuses whatever image is currently
  tagged — including one a `/update` self-deploy (#879) just built. Adding `--build` would rebuild
  from the box's checkout and roll the bot back on every settings edit.
- These subcommands keep working across a self-update: the replacement container takes the
  original's name as it retires it, so `BOT_OPS_CONTAINER` still resolves and needs no change.

## Enabling a panel + choosing a bot (debug/prod)

The Ops tab is hidden unless an `ops.json` is present — in the app's config dir
(`%APPDATA%\com.nazuraki.warbandeer\ops.json` for **warbandeer-desktop**;
`%APPDATA%\com.roshne.wowcompanion\ops.json` for **wow-companion**), or at the path in the app's
config env var (`WARBANDEER_OPS_CONFIG` / `WOW_COMPANION_OPS_CONFIG`).

**Multi-target format** — list the bots you manage; the panel shows a target (debug/prod) switch:

```json
{
  "targets": [
    {
      "name": "debug",
      "ssh": "roshne@192.168.7.48",
      "remoteDir": "~/repos/wow-debug/apps/warbandeer-discord",
      "project": "warbandeer-discord-debug",
      "container": "warbandeer-discord"
    }
  ]
}
```

Per target: `name` (the switch label), `ssh` (SSH destination), `remoteDir` (the bot dir on that
host — historically the same directory as `.env`/`docker-compose.yml`), and the compose `project`
/ `container` (optional; default to the debug bot's `warbandeer-discord-debug` /
`warbandeer-discord`). The panel runs
`ssh <ssh> "BOT_OPS_PROJECT=<project> BOT_OPS_CONTAINER=<container> bash <remoteDir>/ops/bot-ops.sh …"`,
reusing your existing key — so key-based SSH to that host (as a user in the `docker` group, no sudo)
must already work.

**Known gap since the config-dir/compose-file split above: this `ops.json` shape can't drive a
migrated instance yet.** The panels only pass `BOT_OPS_PROJECT`/`BOT_OPS_CONTAINER` —
`BOT_OPS_CONFIG_DIR` and `BOT_OPS_COMPOSE_FILE` are now also required by `bot-ops.sh`, and neither
app nor the shared `apps/bot-ops` backend has a field for them yet — tracked as
[roshne/wow-companion#197](https://github.com/roshne/wow-companion/issues/197) (the design doc's
Q4, `opsCmd`/`configDir` fields). Until that lands, a
target pointed at a migrated instance needs its invocation hand-adjusted; the panels work
unmodified only against a pre-migration, `remoteDir`-shaped deploy.

The old single-bot shape still works for what it invokes: `{ "ssh": "...", "remoteDir": "..." }`
is read as one `debug` target. Shipped builds without an `ops.json` never show the tab.

## Standing up prod

Prod is just another `ops/install.sh`-bootstrapped instance (see
[Bootstrapping a fresh instance](#bootstrapping-a-fresh-instance-no-checkout)) — nothing in
`bot-ops.sh` itself is prod-specific.

```sh
curl -fsSL https://raw.githubusercontent.com/roshne/rackbops-discord-bot/main/ops/install.sh \
  | bash -s -- prod
```

It needs its **own** Discord application/token — create one at
<https://discord.com/developers/applications>, same as any fresh bot (see the main
[README](../README.md#setup)) — since it's a genuinely separate deployment, not a clone of
debug's identity. Once bootstrapped, give it an `ops.json` target once the panel gap above is
closed; until then, manage it directly (the fetched `/opt/rackbops-discord-bot/bin/bot-ops.sh`
over SSH, or `ops/install.sh`'s own
printed commands).
