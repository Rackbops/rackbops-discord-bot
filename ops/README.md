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
| `status` | JSON: container running?, status line, image, last-observed realm status, and `plugins` (the bot's recorded plugin state — `[]` when none) |
| `logs [N]` | Last `N` container log lines (default 200, capped 5000), raw |
| `restart` | Restart the bot process in place (`docker compose restart`) — no env reload |
| `env-get` | JSON of the **non-secret** editable env keys and their *effective* values (`.env` read the way compose's `env_file:` loader reads it — see the safety notes), followed by the non-secret env keys of every installed plugin (from the Plugin Index) |
| `env-set` | Read `KEY=VALUE` lines from **stdin**, refuse any key outside the whitelist, diff each remaining one against the effective value, validate the format of only the ones that change, back up `.env`, apply those changes, then `up -d --force-recreate` to load them |
| `env-schema` | JSON of the same keys as `env-get`, each with the ERE `pattern` `env-set` validates against, whether it is `required` (refuses blank), and its `source` (`core` static whitelist or the installed plugin's manifest) |
| `plugin-request` | Read one plugin-update **request JSON** from stdin (`{action, plugin, version?, at?, days?, requestedBy}` — `action` ∈ `update-now`/`schedule`/`remind`/`skip`/`cancel`), validate it, and drop it into the bot's **request mailbox** (`data/plugins/requests/`), written `docker exec -u bun` so the bot (which runs as `bun`) owns it. Prints `{queued: "<file>"}`. See "Plugin request mailbox" below |
| `version` | JSON `{"schema": N, "composeSchema": M}` — this script's own `BOT_OPS_SCHEMA`, plus the deployed `docker-compose.yml`'s `x-rackbops-schema:` (`null` when unreadable/unset/absent). The admin panel runs this once at startup to check neither deployed file is behind the panel image; see "Keeping `bot-ops.sh` and `docker-compose.yml` current" below |

Run directly on the box to test. `BOT_OPS_CONFIG_DIR` (holds `.env` + `backups/`),
`BOT_OPS_COMPOSE_FILE` (the deployed `docker-compose.yml`, under `/opt/stacks/` for Dockge — see
[Bootstrapping a fresh instance](#bootstrapping-a-fresh-instance-no-checkout)), `BOT_OPS_PROJECT`
(the compose project, e.g. `rackbops-discord-bot-debug`), and `BOT_OPS_CONTAINER` (the container
name — same value as `BOT_OPS_PROJECT` under the current layout) are all **required** for every
subcommand except `version` (deliberately checkable with none of them set — see "Keeping
`bot-ops.sh` and `docker-compose.yml` current"), with no fallback to the script's own location or
to any monorepo-era default:

```sh
export BOT_OPS_CONFIG_DIR=/opt/rackbops-discord-bot/debug
export BOT_OPS_COMPOSE_FILE=/opt/stacks/rackbops-discord-bot-debug/docker-compose.yml
export BOT_OPS_PROJECT=rackbops-discord-bot-debug
export BOT_OPS_CONTAINER=rackbops-discord-bot-debug
bash ops/bot-ops.sh status
echo "RELEASE_ANNOUNCE_CHANNEL_ID=1529152068055728330" | bash ops/bot-ops.sh env-set
```

## Plugin request mailbox

The admin panel (and Discord's `/plugins`) can act on a plugin update — install now, schedule it,
remind, skip, cancel. The panel is a **separate service that can't write the bot's `state.json`** (the
bot is the sole writer). So a panel action becomes a **request file** the bot consumes: `plugin-request`
validates the JSON and writes it into `data/plugins/requests/` via `docker exec -u bun` (the bot runs
as `bun`, so `-u bun` makes the file bot-owned — a root-created file would be un-deletable by the bot).

The bot **drains** the mailbox at the start of its update tick (every ~60s) and once at boot, applying
each request through the same state builders `/plugins` uses, then deleting the file. A malformed or
invalid file (unknown action, bad `plugin`/`version`, a `version` with a slash, a not-installed
plugin) is moved to `requests/rejected/` with a log line — never applied, never crashing the drain.
The mailbox can only ever run the five actions on an **already-installed** plugin; it can't enable a
new plugin (that stays `PLUGINS=`-only) or run anything else. `requestedBy` is the panel identity
(`email:<addr>` or `token`), recorded in `state.json` and shown by `/plugins list`; a panel-origin
update logs its outcome rather than DMing (there's no Discord user to reach — the panel shows it).

## Keeping `bot-ops.sh` and `docker-compose.yml` current

Both `bin/bot-ops.sh` and the stack's `docker-compose.yml` on an instance are **deployment
artifacts** — fetched once by `install.sh`, never touched by hand, never precious the way `.env`
is — but nothing re-fetches either of them on its own. **After a merge that changes either file in
a way an instance needs to pick up — a new `bot-ops.sh` subcommand or `ALLOWED_SPEC`
row, or a compose change like a new `environment:` entry, an image pin, a volume — re-run
`install.sh` on each instance** (it always refreshes both files) — otherwise the admin panel image
(rebuilt from the same merge) ships a feature, or a runtime setting, the deployed files don't have
yet, and the only symptom might be as subtle as a setting that's silently not in effect (the #178
incident: `#168`'s `BOT_ENV_FILE` and `#140`'s `cloudflared` pin were both merged, both images
rebuilt, but the deployed compose file was still the pre-merge copy).

You don't have to remember to check: both files stamp a schema integer (`bot-ops.sh`'s own
`BOT_OPS_SCHEMA`; the compose file's top-level `x-rackbops-schema:`, a key Compose itself ignores),
and the admin panel checks BOTH once at startup against the schemas it was built for, logging one
line per file — either `<file> schema <N> (panel needs <N>)` or a loud `<file> is OUT OF DATE`
line — and a banner at the top of the panel page naming precisely which file(s) are behind. The
panel still starts and serves `status`/`logs`/`restart` regardless; it just tells you rather than
staying silent about it. `install.sh`'s own summary lines print the schema each file was just
installed with, so the panel's log and install's own output are easy to compare side by side.

`version` is checked deliberately WITHOUT any of the `BOT_OPS_*` config or a real `.env`/compose
file being valid — it needs only `jq`, and reads the compose file's `x-rackbops-schema:` line
directly (never via `docker compose`) ONLY when `BOT_OPS_COMPOSE_FILE` is set and that file exists,
reporting `null` otherwise. That's on purpose: a check that required valid instance config first
couldn't tell "these files are old" apart from "this instance is misconfigured," and would report
the identical `OUT OF DATE` warning for both cases.

## Bootstrapping a fresh instance (no checkout)

`ops/install.sh` sets up a new instance (`debug`, `prod`, or any other name) on a host that has
nothing but `git`, `docker`, and `curl` — no clone of this repo, no Bun toolchain. It's curl-able
directly from the public repo:

```sh
curl -fsSL https://raw.githubusercontent.com/Rackbops/rackbops-discord-bot/main/ops/install.sh \
  | bash -s -- debug
```

It creates `/opt/rackbops-discord-bot/<instance>/.env` from `.env.example` (never overwritten on
a re-run — fill in secrets there by hand). It always refreshes three things that are deployment
artifacts, not instance config — `/opt/rackbops-discord-bot/bin/bot-ops.sh` (shared across every
instance on the host), `/opt/stacks/rackbops-discord-bot-<instance>/docker-compose.yml` (Dockge
lists it as a managed stack because it lives under `/opt/stacks/`, the one path Dockge actually
scans), and `/opt/stacks/rackbops-discord-bot-<instance>/.env` — a **compose-project** env file,
distinct from the bot's own `.env` above and holding no secrets, that Compose loads automatically
for `${VAR}` interpolation. It carries this instance's real `BOT_ENV_FILE`/`BOT_OPS_CONTAINER`/
`BOT_OPS_PROJECT`/`BOT_OPS_CONFIG_DIR`/`BOT_OPS_COMPOSE_FILE`/`BOT_BUILD_CONTEXT`/`GIT_SHA`, so
Dockge's own Start/Stop/Restart buttons resolve this instance's actual identity instead of the
compose file's own monorepo-era fallbacks (issue #41) — and, since #169, so does the exact command
`install.sh` itself prints for step 2 (`docker compose -f .../docker-compose.yml -p ... up -d
--build`, with no shell-exported prefix any more): Compose resolves its project directory, and
therefore which `.env` it auto-loads, from the directory of the file passed via `-f`, regardless of
the invoking shell's own cwd — proven for real in `ops/docker-compose.test.ts` with an absolute
`-f` path invoked from an unrelated cwd, not just trusted from Compose's docs. All three are
written to a temp file first and moved into place atomically, so a dropped connection (or
interrupted write) never leaves a truncated file a later run's existence-check could mistake for
something real. Each temp file is registered with a script-level `EXIT` trap as it is created
(issue #60), so an abort *between* the `mktemp` and the `mv` sweeps its `tmp.XXXXXX` instead of
stranding it beside the real files. The reachable case is a typo'd `BRANCH`: it is only checked
against the remote *after* the three downloads, so the first one 404s and `set -e` aborts inside
`fetch()` before the branch check ever runs. Immediately after the stack `.env` is written,
`validate_stack_env` re-reads it and fails loudly, before anything below it prints or starts
(issue #169): `install: <FIELD> must be an absolute path, got "…"` for a non-absolute
`BOT_ENV_FILE`, `BOT_OPS_CONFIG_DIR`, or `BOT_OPS_COMPOSE_FILE` (all three), or
`install: BOT_OPS_CONFIG_DIR does not exist` for a missing config dir (that one field only —
`BOT_ENV_FILE`/`BOT_OPS_COMPOSE_FILE` are checked for shape, not existence). These are always
absolute today, since `CONFIG_DIR`/`STACK_DIR` are built from a fixed `/opt/...` prefix, so
this is forward defense against a future change to how those paths are built, not a case that fires
in the current script). It prints the exact `docker compose up -d --build` command to run once
`.env` is filled in, and the full `BOT_OPS_*` exports for day-2 `bin/bot-ops.sh` use afterward — see
the script's own output, or read `ops/install.sh` directly.

**Why two files, not one answer file (issue #169, #60 item 1).** The personal `CLAUDE.md`'s
Application config & deployment rule calls for one operator-edited answer file — secrets and
deployment params together — that everything else renders from. This repo deviates from that
letter on purpose, recorded here and in the repo's own `CLAUDE.md`: the generated stack `.env`
above (params — container names, paths, the build context, the resolved commit) and the
hand-edited `$CONFIG_DIR/.env` (secrets — `DISCORD_TOKEN` and friends) are two separate files, not
one. The rule's actual *purpose* still holds through all three of its own tests: no deployment
param lives in the operator's head or shell history (it's in the generated file); a generated file
is never hand-edited (`install.sh` always refreshes the stack `.env`, same as `bot-ops.sh` and the
compose file); and the one precious, operator-edited file is never touched by anything but the
operator (`$CONFIG_DIR/.env`, created once from `.env.example` and left alone on every later run).
Promoting the stack `.env` to hold secrets too (so a single file covered both) would need migrating
live secrets on every already-deployed instance for no behaviour change; a full renderer that emits
both files from one answer file would give up the property that lets `install.sh` be safely re-run
and self-update stay independent of this file (`docker-compose.yml`'s compose file is fetched
verbatim from the target branch, not rendered) — see #169's own body for the full option table.

The compose file's `build.context` defaults to `.` (a local checkout, unchanged for anyone
running `docker compose up -d --build` from a clone) — the bootstrap command instead supplies
`BOT_BUILD_CONTEXT=https://github.com/Rackbops/rackbops-discord-bot.git#<branch>` as a one-shot
shell variable on that single invocation, so the Docker daemon fetches and builds the source
itself. It is **not** written into `.env` — nothing rebuilds via `docker compose --build` after
that initial bring-up (self-update's own rebuilds go through the Docker Engine API directly, in
`src/redeploy.ts`, independent of this file); a future manual rebuild needs the same variable
re-supplied by hand. `GIT_SHA` (for self-update's staleness check) is resolved via
`git ls-remote` at bootstrap time — no clone needed for that either.

## Editable keys (whitelist)

`DISCORD_SERVER_ID`, `ANNOUNCE_CHANNEL_ID`, `RELEASE_ANNOUNCE_CHANNEL_ID`, `REPORT_ROLE_ID`,
`ADMIN_USER_IDS`, `WATCHED_REPOS`, `AUTO_UPDATE`,
`BOT_BRANCH`, `COMMAND_PREFIX`, `PLUGINS`, `PLUGIN_INDEX_URL` — listed in `ALLOWED_SPEC`'s own order, the order the admin panel displays
them in (`DISCORD_SERVER_ID` first deliberately; see `ops/bot-ops.sh`). Each is validated
against a format regex when it *changes* (see the safety notes below); an empty value clears the
key back to its documented default.

**Plugin-declared keys** — on top of the static list above, every **installed** plugin (named in
`PLUGINS=`) contributes its own env keys: `env-get` lists them (non-secret only, after the static
keys, in manifest order) and `env-set` accepts them, validating each with the format, honouring the
`required` flag, and refusing the `secret` keys the Plugin Index carries — read from the bot's
cached `data/plugins/index.json`, never hand-mirrored here. This is where `WARBANDEER_INGEST_PORT`
lives now that the connector is the `warbandeer` plugin (issue #100): set `PLUGINS=warbandeer` and
the key becomes editable once the bot has cached the index. A plugin's `secret` keys are never
listed or written, exactly like the core secrets below. If the bot isn't running (no cached index),
`env-get` shows the static keys only and notes `plugins: index unavailable` on **stderr** — never
an error (the JSON stays a flat map of editable keys, so the panel round-trips it unchanged) — and
`env-set` refuses a plugin key in that same state, since it can't read the manifest to validate one;
edit a plugin's keys while the bot is up. A valid-JSON-but-wrong-shape cached index is treated the
same way (degraded, never a crash).

**Secrets are intentionally absent** — `DISCORD_TOKEN`, `BLIZZARD_CLIENT_ID`,
`BLIZZARD_CLIENT_SECRET`, `GITHUB_TOKEN`, `CLOUDFLARE_TUNNEL_TOKEN`. `env-get` never reads them
out and `env-set` refuses to write them. Edit those by hand with `nano` on the box.

## Safety notes

- **Compose project + container come from `BOT_OPS_PROJECT` / `BOT_OPS_CONTAINER`** (a panel passes
  them per selected bot) — required, with no default (issue #41: a monorepo-era fallback once
  silently targeted a project/container no real deploy produces). The project must be passed with
  `-p` because it is *not* set in a non-interactive SSH shell's environment (a bare `docker compose`
  would default to the directory name and miss the running container); both are validated to a
  safe charset before use.
- **`BOT_OPS_CONFIG_DIR` / `BOT_OPS_COMPOSE_FILE` are required, with no fallback.** The script no
  longer derives anything from its own location — those two independent paths (config dir vs.
  the Dockge-managed compose file, see [Bootstrapping](#bootstrapping-a-fresh-instance-no-checkout))
  must always be passed explicitly. An unset one is a loud, named error, not a guess.
- **Both of those must be absolute, and a relative one is rejected outright** (issue #60). A
  relative path resolves against whatever cwd the script was invoked from, so a maintainer
  hand-running it out of a checkout would have `env-set` rewrite the *checkout's* `.env` and drop
  `backups/.env.bak.*` — a live token — beside it; `.gitignore` covers those two but not the
  `admins.json` the panel writes into the same directory. Every deployed invocation already passes
  an absolute `/opt` path (`install.sh` generates them), so this rejects only the hand-run mistake.
  The error names the offending value, quoted, next to the variable. `src/storage.ts` cites this as
  the absolute-only precedent for its own `BOT_DATA_DIR` guard.
- **The admin panel enforces the same rule on `BOT_OPS_CONFIG_DIR`, and refuses to start without an
  absolute one** (issue #60 too — the item named both sites). The panel reads that variable directly
  to place `admins.json`, so the script's guard doesn't cover it. A relative value exits 1 with the
  same named message rather than degrading, because the silent alternative fails **open**, not
  closed: a misplaced `admins.json` is *absent* rather than malformed, so it reads as an empty
  dynamic list without erroring, and an empty dynamic list plus an empty `ADMIN_ALLOWED_EMAILS` is
  the "no narrowing configured" state in which **every** Access identity authorizes. The panel would
  look healthy while the operator's real admin list sat unread in the directory they meant. A panel
  that won't start at least says why.
  An **unset** value is still fine and still starts: that is the documented bootstrap-only mode
  (`ADMIN_ALLOWED_EMAILS` works, nothing persists), logged as
  `no BOT_OPS_CONFIG_DIR — dynamic admin list can't persist`.
- **`env-set` rebuilds `.env` line-by-line** (no `sed`), so a value can never inject into the
  file, and comment/blank/secret lines are preserved verbatim. A timestamped
  `<config-dir>/backups/.env.bak.<stamp>` is written before any change; a no-op (new value equals
  current) does nothing and does **not** restart the bot.
- **`env-set` diffs before it validates, and only what changes is validated** (issue #44). A
  stored value the bot accepts but a whitelist regex rejects — a hand-quoted realm, a CRLF-saved
  file, `1, 2` in `ADMIN_USER_IDS` — used to fail every save that echoed it back, naming a key the
  operator never touched. Both `env-get` and that diff read `.env` the way compose's `env_file:`
  loader does (checked against `docker compose config`): the **last** occurrence of a key wins,
  `export KEY=` counts, an indented line counts, surrounding whitespace and a trailing CR are
  dropped, and one layer of matching quotes is stripped — so the panel shows, and diffs against,
  the value the bot is actually running with. Not modelled (compose does these too, but nothing
  `env-set` writes can produce them): inline ` # comments`, `${VAR}` interpolation, spaces around
  the `=`, a `KEY: value` colon separator, backslash escapes inside double quotes. A key repeated
  on `env-set`'s stdin takes its last value, like `.env` itself. Unchanged lines are still
  preserved verbatim (a file whose last line lacks a newline gains one); only an indented or
  `export`ed line for a key being changed comes back as plain `KEY=`. `ops/bot-ops.test.ts` pins
  all of this against the real script.
- Applying an env change **recreates the container** (brief restart) because env vars are frozen
  at container start; a plain `restart` would not reload them.
- That recreate deliberately does **not** pass `--build`, so it reuses whatever image is currently
  tagged — including one a `/update` self-deploy (nazumods/wow#879) just built. Adding `--build` would rebuild
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
curl -fsSL https://raw.githubusercontent.com/Rackbops/rackbops-discord-bot/main/ops/install.sh \
  | bash -s -- prod
```

It needs its **own** Discord application/token — create one at
<https://discord.com/developers/applications>, same as any fresh bot (see the main
[README](../README.md#setup)) — since it's a genuinely separate deployment, not a clone of
debug's identity. Once bootstrapped, give it an `ops.json` target once the panel gap above is
closed; until then, manage it directly (the fetched `/opt/rackbops-discord-bot/bin/bot-ops.sh`
over SSH, or `ops/install.sh`'s own
printed commands).

## Admin panel

A small per-instance web panel (`ops/admin/`) — an authenticated wrapper around this
script's own operations, plus a few read-only / self-contained server-native routes (see "What it
exposes" below). Built primarily to sidestep the `ops.json` gap
above rather than fix it: reachable from anywhere, not just wherever the desktop app is
installed, and structurally incapable of touching an instance other than its own (it only ever
knows its own `BOT_OPS_CONFIG_DIR`/`BOT_OPS_COMPOSE_FILE`, baked in per-instance).

**Two doors gate it**, the same pattern already proven for Dockge on nucbox
(`Tooling/docs/nucbox-docker-management.md` Part 3):

1. **Cloudflare Access** — the network-level gate. Set up per instance: a named ingress rule on
   nucbox's existing tunnel (e.g. `bot-debug.<zone>` → the `admin` service's internal address,
   `http://admin:8080`, over the compose network — no host port to bind, so there's nothing to
   loopback-restrict) plus an Access application scoped to your identity, mirroring Dockge's own
   setup in `nucbox-docker-management.md` Part 3. This is operator work — not automated by
   anything in this repo.
2. **Cloudflare Access's own signed JWT** — verified against Cloudflare's published JWKS
   (`https://<team-domain>/cdn-cgi/access/certs`) on every `/api/*` call, via the
   `Cf-Access-Jwt-Assertion` header Access attaches once a request has passed through it.
   Configured per instance with `CLOUDFLARE_ACCESS_TEAM_DOMAIN`/`CLOUDFLARE_ACCESS_AUD` in
   `.env` (see `.env.example` for where to find both in the Zero Trust dashboard). This is the
   primary check once both are set — most requests behind a configured Access application never
   need the bearer prompt at all, since Access attaches the header transparently.

   **These, and the two vars below, take effect only when the admin container starts** — they're
   read once from the environment `--profile admin up` was run with (`ops/install.sh`'s printed
   step 4) and frozen for the container's lifetime, never re-read from `.env`. Setting them for
   the first time after bring-up, or changing either later, does nothing to the running panel
   until step 4 is re-run with the new values exported.

   **Optional narrowing — the admin allow-list.** Restricts which *verified* identities the JWT
   check accepts, on top of whatever Cloudflare Access's own edge policy already allows through.
   Useful when an Access application's policy is shared across several tools — e.g. the same
   "Allow trusted users" policy might also gate Dockge — and you want a narrower set of people
   able to act on this bot specifically. It's the union of two sources: **`ADMIN_ALLOWED_EMAILS`**
   (comma-separated, in `.env`) — the permanent *bootstrap* floor, editable only on the box — plus
   a **dynamic list managed live from the panel's Admins section**, persisted to `admins.json`
   beside `.env` — at the path the panel builds from `BOT_OPS_CONFIG_DIR` itself, which is why a
   **relative** value makes the panel exit 1 at startup rather than start and write the admin list
   somewhere unintended (issue #60; an *unset* value is fine and starts in bootstrap-only mode).
   With both empty there's no narrowing (any identity Access already let through
   authorizes); adding even one admin (env or panel) turns narrowing on. Editing
   `ADMIN_ALLOWED_EMAILS` in `.env` after bring-up needs the same admin-container recreate as the
   Access vars above — it isn't picked up live. If `admins.json` exists
   but can't be read or parsed (a hand-edit typo, a bad mount), the panel fails **closed**, not
   open: narrowing stays in effect (no JWT authorizes unless a bootstrap email matches) rather
   than silently reopening to everyone — the `ADMIN_TOKEN` bearer token remains available to fix
   the file. You can't lock everyone out: bootstrap admins can't be removed from the panel, you
   can't remove yourself, and — when there's no bootstrap floor at all — the panel refuses to
   remove the last remaining admin
   (which would silently reopen it to everyone). Never applied to the bearer-token fallback, which
   stays identity-blind by design.

   **Fallback: a bearer token** (`ADMIN_TOKEN` in `.env`, generated once by `ops/install.sh` at
   bootstrap and printed to the terminal — copy it into the panel's unlock prompt on first
   visit, where it's kept in the browser's `localStorage`). Always required at startup
   regardless of the Access vars above — it's the check a request falls back to whenever the
   JWT path doesn't already succeed: `CLOUDFLARE_ACCESS_TEAM_DOMAIN`/`CLOUDFLARE_ACCESS_AUD`
   aren't set for this instance yet, Cloudflare's JWKS endpoint is briefly unreachable, or no
   Access header is present at all. Either check alone is sufficient (OR, not AND) — a valid
   JWT is evaluated first and, when present and valid, the bearer token is never consulted.
   **Rotating this value in `.env` does not revoke the old one** — same read-once-at-container-
   start rule as the two Access vars above — the running panel keeps accepting the old token
   until the admin container is recreated (re-run `ops/install.sh`'s step 4 with the new
   `ADMIN_TOKEN` exported). If this token has leaked, editing `.env` alone is not enough: the
   leaked token keeps working until that recreate happens.

**What it exposes — `bot-ops.sh`'s operations plus a few read-only or self-contained,
server-native routes:** `GET /api/status`, `GET /api/logs?n=`, `POST /api/restart`, `GET /api/env`,
`POST /api/env`, `GET /api/whoami` (reflects the requester's own verified Access identity — who
they're signed in as, plus the JWT's claims for the panel's Identity view), and
`GET/POST/DELETE /api/admins` (the panel-managed dynamic admin list — see the narrowing note
above), `GET /api/branches` (the configured repo's branches, for the `BOT_BRANCH` chooser), and
`GET /api/plugins` (the Modify Plugins view — the Plugin Index merged with this instance's installed
state and current `PLUGINS`; see below), and (**#105**) `POST /api/plugins/request` (an update-action
button → a request file the bot consumes), and (**#123/#165**) `GET /plugin-admin/<name>.js?v=` +
`GET /api/plugin-proxy/<name>?path=&v=` (a plugin's own admin-tab bundle and its data assets,
proxied same-origin from that plugin's own published package on the allowlisted CDN host — see
"Plugin admin tabs" below). The
`/api/whoami`, `/api/admins`, `/api/branches`, `/plugin-admin/<name>.js`, and
`/api/plugin-proxy/<name>` routes never shell out to `bot-ops.sh`;
`/api/plugins` reads installed state via `status` + `env-get` and fetches the index server-side, and
`/api/plugins/request` shells `bot-ops.sh plugin-request` (the only plugin route that does), while
saving a plugin's *enabled* state still goes through the ordinary `POST /api/env` (only `PLUGINS`).
`/api/admins` manages only this panel's own allow-list, never the Cloudflare Access policy. State-changing
routes (the POSTs/DELETE) are additionally guarded against cross-site forgery by an Origin check —
which relies on `cloudflared` forwarding the public hostname as the `Host` header (the ingress
rule's `httpHostHeader`, which you set when you configure the ingress rule — operator work, not automated by anything in this repo); don't rewrite it to
the internal origin or same-origin browser writes would be wrongly blocked.
A `restart`/`env-set` invocation that runs past 90s (a wedged `dockerd`, a slow image pull) is
killed and answered with a `504`, distinct from the `502` a normal `bot-ops.sh` failure gets;
`Bun.serve`'s own idle timeout is raised to 120s so a legitimately slow-but-under-90s request is
never cut off by the HTTP layer first.
There's no *direct* rebuild/deploy button — that stays Discord's `/update` — but the panel edits
`BOT_BRANCH` and `AUTO_UPDATE`, and with `AUTO_UPDATE=true` the bot's own self-update rebuilds from
`BOT_BRANCH` through the mounted docker socket within ~15 minutes. Combined with the read-write
config-dir mount (the panel reads secrets straight from the mounted `.env` — e.g. `GITHUB_TOKEN` for
the branch chooser below), **panel access is effectively deploy and root-equivalent access — treat it
like SSH to the box.** The config form on the
page is rendered from whatever `GET /api/env` returns, so it can never drift from this script's own
`ALLOWED` whitelist above. Save posts only the fields that changed — the same list the confirm
dialog previews — never the untouched ones echoed back (issue #44): a stored value the whitelist
would reject can't block an unrelated save, and a tab loaded before another operator's save can't
silently revert their unrelated edit. A few fields render as constrained controls instead of free text:
`AUTO_UPDATE` as a select, `BOT_BRANCH` as a live branch chooser (below), and
`ADMIN_USER_IDS`/`WATCHED_REPOS` as chip/tag editors. Every other key — the static ones and each
installed plugin's manifest keys alike — is a plain text input whose required-ness and format come
from `GET /api/env-schema` (`bot-ops.sh env-schema`, #205/#207), so a blank required key or a value
`env-set` would reject is refused before the confirm dialog rather than after a failed,
restart-triggering save. A plugin that needs a richer control (the wow plugin's region-filtered
realm chooser) ships it in its own admin tab — see ADR-0005 — not in this page. (`realms.json` and
its `gen-realms.ts` generator moved to the plugins repo with the wow plugin, under `plugins/wow/`.)

**The `BOT_BRANCH` chooser** lists the configured repo's live branches (branches change far too
often for a static list) via `GET /api/branches`, which calls the GitHub API server-side.
`GITHUB_REPO` and `GITHUB_TOKEN` are read on demand from the mounted `.env` — never from this
container's environment (so the token never appears in `docker inspect`), which also means a
`GITHUB_REPO` edited in `.env` on the box is picked up without restarting the admin service. This
is the opposite of `ADMIN_TOKEN`/`CLOUDFLARE_ACCESS_TEAM_DOMAIN`/`CLOUDFLARE_ACCESS_AUD`/
`ADMIN_ALLOWED_EMAILS` above, which the container reads once from its process environment at
`--profile admin up` time and never revisits — those need a recreate (install.sh's step 4) to
pick up an edit; `GITHUB_REPO`/`GITHUB_TOKEN` don't, because they're read from the file itself on
every request instead. The
token is optional: a public repo lists unauthenticated (just at a lower rate limit), and the result
is cached ~5 minutes so repeated loads don't burn the limit. The chooser offers a blank
"— default (main) —" option (an empty `BOT_BRANCH` is valid and defaults to `main`) and only lists
branch names `bot-ops.sh` accepts (`^[A-Za-z0-9._/-]{1,100}$`); a stored value that isn't a current
branch (a since-deleted branch) is still shown as its own option. If the lookup fails, `BOT_BRANCH`
falls back to a plain text input.

**The Modify Plugins section** lists every plugin the Plugin Index offers alongside what this
instance has installed, and lets you add or remove one by ticking its checkbox and pressing Save.
`GET /api/plugins` builds the view server-side: it merges the raw Plugin Index (fetched from
`PLUGIN_INDEX_URL` — read on demand from the mounted `.env` like `GITHUB_REPO`, defaulting to the
bot's own index when unset — so an edit is picked up without recreating the admin service, cached
~5 min) with the bot's installed state (`bot-ops.sh status`'s `plugins`) and the current `PLUGINS`
value (`env-get`). Each row shows the installed version, an "update to X" badge when the index
carries a newer release, and a state tag (active / needs config / failed / not in index). **This
never installs code from the browser** — ticking a plugin only adds its name to `PLUGINS`; the code
is fetched and installed by the bot on its next boot exactly as it is for a hand-edited `PLUGINS`.
You can never newly-*enable* a plugin the index doesn't list (its checkbox is disabled), but an
already-enabled plugin the index has since dropped stays editable so you can still remove it. Save is
the ordinary config Save under the hood: it computes the new `PLUGINS` string — preserving any
`name@version` pin a still-ticked plugin already had, ordered by the manifest — and `POST`s **only**
`PLUGINS` through `/api/env`, so the same Origin guard, auth, `bot-ops.sh` validation, and recreate
apply as any other config change. The recreate it triggers is the restart that loads the change; a
removed plugin's stored data files are left untouched. If the Plugin Index can't be fetched, the
section shows an "index unavailable" notice and still lists the installed plugins (so you can still
remove one) rather than failing — the `/api/plugins` route degrades to a `200` with an `indexError`,
never a hard error. If the bot's own state can't be read (`status`/`env-get` failed — e.g. a docker
hiccup), the route sets a `stateError` instead and the panel **disables Save**, since an empty
selection read back under failure would otherwise let a save wipe the real `PLUGINS`.

**Driving an available update (#105).** A card whose plugin has a newer release than the one
installed grows an update-action area: a **What changed** block (the release notes for each version
newer than installed, from the index), **Update now** and **Schedule** (a date/time picker) *when the
update is host-API-compatible with this bot*, and **Remind me in 7 days** and **Skip this version**
*always* (you can still silence or snooze a version you can't yet install); a **Cancel scheduled
update** button appears once one is scheduled. Each button `POST`s a
small request to `POST /api/plugins/request` — `{action, plugin, version?, at?, days?}` — which
Origin-guards and schema-validates it (the same anchored `plugin`/`version` rules `bot-ops.sh` and
the bot enforce, so a bad or hostile body is a `400` here), then sets `requestedBy` from the
**Cloudflare Access identity that made the request, never anything in the body** (`email:<addr>`, or
`token` on the bearer path), and shells `bot-ops.sh plugin-request` to drop the file in the mailbox.
The bot applies it on its next tick (within a minute) exactly as it does a `/plugins` command — an
**Update now** or a due **Schedule** restarts the bot to install; the identity is recorded in
`state.json` and shown in `/plugins list`, but because it isn't a Discord user id the bot **logs** the
outcome rather than trying to DM it. An update whose latest version needs a newer bot than this one
shows a "needs a newer bot" note and offers no install button (the bot would reject it anyway). See
"Plugin request mailbox" above for the file format and the `rejected/` quarantine.

**Plugin admin tabs (#123/#165).** A plugin may opt in to its own settings tab instead of the
generic env-key fields — see the root README's "Plugin settings" section for what an operator sees.
Delivery is entirely server-side: `GET /plugin-admin/<name>.js?v=<installedVersion>` fetches the
plugin's built `dist/admin.js` from its published npm package on `cdn.jsdelivr.net` (the only host
either route will ever fetch from), size-capped at 512 KiB, and serves it same-origin so the browser
never makes a cross-origin request for plugin code; `GET /api/plugin-proxy/<name>?path=&v=`
proxies a data asset (e.g. a realm list) the same way, scoped so a bundle can only ever reach files
inside its own package. Auth differs between the two: the bundle route sits **before** the `/api/`
gate, public at this layer like the page itself (Cloudflare Access already gated getting here, and
the bundle is public CDN content anyway); the proxy route is under `/api/` and goes through the
same Access-JWT/bearer check as every other API call. Both accept an optional `?v=` (a strict
semver, 400 on anything else) that pins delivery to the plugin's **installed** version rather than
the Plugin Index's current one — so the tab configures the code that's actually running, not
whatever the manifest currently advertises; a plugin pinned below its first admin-bundle release
gets a real 404 here, which the panel renders as a dedicated note naming both the installed and the
latest version, rather than a generic failure. `getEnv`/`setEnv` are the one deliberate exception: they still validate against
the index's **current** manifest entry regardless of which version's tab is mounted (see
`CONTEXT.md`'s gotcha) — per-version env-key scoping isn't built.

**Bringing it up** — opt-in via compose's `admin` profile, deploy-only (needs the same
`BOT_OPS_CONFIG_DIR`/`BOT_OPS_COMPOSE_FILE`/`BOT_OPS_PROJECT`/`BOT_OPS_CONTAINER` values as
`bot-ops.sh` itself; `ops/install.sh`'s printed output includes the exact command, which names
the `admin` service explicitly so it never rebuilds or recreates the running `bot` container).
It runs as its own sidecar, independent of the bot process's lifecycle — if the bot crashes, the panel
stays up to show that and let you restart it. No published host port: it's reached over the
network via nucbox's own pre-existing, host-level Cloudflare tunnel (an ingress rule pointed at
this service — see "Two doors" above), **not** via this compose file's own opt-in `cloudflared`
sidecar (that one is a separate tunnel dedicated to `WARBANDEER_INGEST_PORT` — see the Cloudflare
Tunnel section in the root README) — so until nucbox's tunnel has an ingress rule for it, bringing
the profile up just starts a service nothing outside the compose network can reach.
