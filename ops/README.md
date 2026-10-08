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
| `restart` | Restart the bot process in place (`docker compose restart`) — no env reload. **SSH-only since #277**: the admin panel's Restart button calls `recreate` instead. Compose's output is relayed the way `env-set`'s `log` is (#240): withheld if it is about the env file, scrubbed otherwise — so it is printed when compose has finished, not as it goes; a failed restart prints it, exits with compose's status, and does not say `restarted`. **#227:** holds the same config-dir lock `env-set`/`recreate` do for its whole run, so it queues behind one already in progress rather than overlapping it |
| `recreate` | `up -d --force-recreate` on its own, with no value submitted first — the same recreate `env-set` runs after a save, exposed as its own subcommand (#277) so a recreate a previous `env-set` started but the panel never saw finish (a kill, a 504) can be re-attempted from the panel with one click. `{"ok": bool, "recreated": true, "log": string}`, `log` relayed the same way `restart`'s and `env-set`'s are; exits with compose's status |
| `env-get` | JSON of the **non-secret** editable env keys and their *effective* values (`.env` read the way compose's `env_file:` loader reads it — see the safety notes), followed by the non-secret env keys of every plugin in the cached Plugin Index, whether or not the plugin is in `PLUGINS` (#256) |
| `env-set` | Read `KEY=VALUE` lines from **stdin**, refuse any key outside the whitelist, diff each remaining one against the effective value, validate the format of only the ones that change, back up `.env`, apply those changes, then `up -d --force-recreate` to load them. **#227:** holds an exclusive lock on the config dir for the whole run (the read, the diff, the backup, the rewrite and the recreate) — a second `env-set`/`restart`/`recreate` on the same instance waits up to `BOT_OPS_LOCK_WAIT_SECONDS` (default 60s), then refuses, having written nothing, rather than racing this one |
| `env-schema` | JSON of the same keys as `env-get`, each with the ERE `pattern` `env-set` validates against, whether it is `required` (refuses blank), and its `source` (`core` static whitelist or a plugin's manifest in the cached index, on or off, #256); then one row per plugin **secret** key, `{pattern, required, source: "plugin", secret: true, isSet}` — that it exists and whether it is set, never what it holds (#240) |
| `routing-get` | JSON `{"routing": …, "discovery": …}` — the bot's per-plugin routing record and what it can see (`data/routing.json`, `data/discovery.json`), read from the container like `status` reads `state.json`. A missing, empty or corrupt file is `null`, never an error. Any webhook URL a hand-edit left in either file is redacted (best effort — the files are not meant to hold one), and the bot's webhook store is never opened (#240, ADR-0006) |
| `plugin-request` | Read one **request JSON** from stdin (`{action, …, requestedBy}`), validate it per action, and drop it into the bot's **request mailbox** (`data/plugins/requests/`), written `docker exec -u bun` so the bot (which runs as `bun`) owns it. `action` ∈ the five plugin-update actions `update-now`/`schedule`/`remind`/`skip`/`cancel` (`plugin`, `version?`, `at?`, `days?`) or, since #240, `routing-set` (`plugin`, `servers`), `webhook-add` (`url`), `webhook-remove` (`channelId`), `discovery-refresh`. Prints `{queued: "<file>"}`. See "Plugin request mailbox" below |
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
The file is written **atomically and owner-only**: the body goes to `<file>.tmp` in the same directory
and is `mv`ed to `<file>`, because `cat > <file>` creates the file before filling it and the bot's
drain (which reads only `*.json`, and refuses one it cannot parse — moved to `rejected/`, or deleted if
it may carry a webhook URL) could otherwise read it
half-written — after the panel had already been told `queued`. The temp name must never end in `.json`.
If any step fails the temp file is removed and `plugin-request` exits non-zero instead of reporting
`queued` — status 1 and a line of its own (`plugin-request: could not write the request into the bot's
mailbox`) after docker's stderr; older versions of this script exited with docker's own status and
printed only docker's stderr, and the panel checks only for non-zero; `umask 077` keeps a request that may carry a webhook URL owner-only, which the bot (running as
`bun`, like the write) can still read and delete.

The bot **drains** the mailbox every few seconds on its own timer, at the start of its update tick
(every ~60s, the backstop) and once at boot, applying each request through the same state builders
`/plugins` uses, then deleting the file. A malformed or invalid file (unknown action, bad
`plugin`/`version`, a `version` with a slash, a not-installed plugin) is moved to `requests/rejected/`
with a log line — never applied, never crashing the drain. Since #241 the bot's drain also handles four
**routing** actions — `routing-set`, `webhook-add`, `webhook-remove`, `discovery-refresh` — validated
by the bot against the servers and channels it can see; each may carry an optional `id` the panel
chooses, under which the bot records the outcome in `routing.json`'s `results`. A request file that may
carry a webhook URL is deleted, not moved to `rejected/`, if it is refused. The mailbox can only ever
run the five update actions on an **already-installed** plugin and those four routing ones; it can't
enable a new plugin (that stays `PLUGINS=`-only) or run anything else — the routing actions, described
below, change where a plugin lives, not which plugins run. `requestedBy` is the panel identity
(`email:<addr>` or `token`), recorded in `state.json` and shown by `/plugins list`; a panel-origin
update logs its outcome rather than DMing (there's no Discord user to reach — the panel shows it).

**Routing requests (#240, ADR-0006).** The same mailbox carries four more actions, which change where
a plugin lives rather than what version it runs: `routing-set` (`{plugin, servers}` — `servers` maps a
guild id to `{commands: "all" | [channel ids, non-empty], postTo?: channel id, destinations?: {name:
channel id}}`; an empty object places the plugin nowhere; `destinations` (#219) maps the plugin's declared
named destinations, each a lowercase `^[a-z][a-z0-9-]*$` name, to a channel in that server, is refused when
empty, and whether a name is declared is checked by the bot), `webhook-add` (`{url}` — a Discord webhook URL, on the `discord.com` /
`discordapp.com` hosts, with its numeric id and token), `webhook-remove` (`{channelId}`) and
`discovery-refresh`. `plugin-request` validates each per action before it writes the file and names the
offending *field* when it refuses — never the value: a webhook URL is a credential, so it travels on
stdin only and no message echoes any part of it. This script
only validates and queues; **applying** the requests is the bot's job (since #241, see above), and a
bot from before that moves such a file to `requests/rejected/` like any unknown action (for a
`webhook-add` that file still holds the URL, owner-only, until someone clears it — so roll the bot
forward before the panel). `routing-get` reads
the two files the bot writes — its routing record and what it can see — so a panel can show them.

## Keeping `bot-ops.sh` and `docker-compose.yml` current

Both `bin/bot-ops.sh` and the stack's `docker-compose.yml` on an instance are **deployment
artifacts** — fetched once by `install.sh`, never touched by hand, never precious the way `.env`
is — but nothing re-fetches either of them on its own. **After a merge that changes either file in
a way an instance needs to pick up — a new `bot-ops.sh` subcommand or `ALLOWED_SPEC`
row, or a compose change like a new `environment:` entry, an image pin, a volume — re-run
`install.sh` on each instance.** From `main`, this always refreshes both files, same as before. From
another branch, the compose file is still always refreshed, but the host-shared `bin/bot-ops.sh` is
refreshed only when that branch's own copy is byte-identical to `main`'s — otherwise `install.sh`
refuses and names `--force-bin` as the override (issue #230; `bin/bot-ops.sh` is shared by every
instance on the host, so a per-instance branch can't silently swap it out from under the others).
Otherwise the admin panel image (rebuilt from the same merge) ships a feature, or a runtime setting,
the deployed files don't have yet, and the only symptom might be as subtle as a setting that's
silently not in effect (the #178 incident: `#168`'s `BOT_ENV_FILE` and `#140`'s `cloudflared` pin
were both merged, both images rebuilt, but the deployed compose file was still the pre-merge copy).

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

Full usage: `install.sh <instance> [branch] [--force-bin]`. Pass a branch as the second argument
(`bash -s -- debug my-branch`) to build from something other than `main`; add `--force-bin` as a
third argument only if you need to force-install that branch's `bot-ops.sh` into the host-shared
`bin/` despite it differing from `main`'s (see "Keeping `bot-ops.sh` and `docker-compose.yml`
current" above, issue #230).

It creates `/opt/rackbops-discord-bot/<instance>/.env` from `.env.example` (never overwritten on
a re-run — fill in secrets there by hand). It refreshes three things that are deployment
artifacts, not instance config — `/opt/rackbops-discord-bot/bin/bot-ops.sh` (shared across every
instance on the host: refreshed unconditionally from `main`, or from another branch only when that
branch's own copy is byte-identical to `main`'s, else `install.sh` refuses and names `--force-bin`
— see "Keeping `bot-ops.sh` and `docker-compose.yml` current" above, issue #230),
`/opt/stacks/rackbops-discord-bot-<instance>/docker-compose.yml` (Dockge
lists it as a managed stack because it lives under `/opt/stacks/`, the one path Dockge actually
scans, and — like the stack `.env` below — is always refreshed), and
`/opt/stacks/rackbops-discord-bot-<instance>/.env` — a **compose-project** env file,
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
stranding it beside the real files. The reachable case is a typo'd `BRANCH`: its syntax is validated
up front (#232), but its *existence* is only checked against the remote *after* the three downloads,
so a syntactically valid but nonexistent branch 404s and `set -e` aborts inside `fetch()`.
Immediately after the stack `.env` is written,
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
itself. It is also written into the stack `.env`, as `<repo>#<branch>` (`ops/install.sh:320`), next to
`GIT_SHA`. `GIT_SHA` is what self-update's staleness check reads, and it is resolved via
`git ls-remote` when `install.sh` runs, with no clone needed. Self-update's own rebuilds go through
the Docker Engine API (`src/redeploy.ts`) and set both themselves.

**A manual `up -d --build bot` after `main` has moved** builds the new `main` but bakes the stack
`.env`'s old `GIT_SHA`, so the bot reports itself stale. Either re-run `install.sh` first, or pin both
on the command line to one resolved commit:
`GIT_SHA=$SHA BOT_BUILD_CONTEXT=<repo>#$SHA docker compose … up -d --build bot`, with
`SHA=$(git ls-remote <repo> refs/heads/main | cut -f1)`. The exact blocks, and a check that the
running bot carries it, are in `docs/plans/epics/E236/13-deploy-and-prove.md` ("Rebuilding the bot
later").

## Editable keys (whitelist)

`DISCORD_SERVER_ID`, `ANNOUNCE_CHANNEL_ID`, `RELEASE_ANNOUNCE_CHANNEL_ID`, `REPORT_ROLE_ID`,
`ADMIN_USER_IDS`, `WATCHED_REPOS` (a list of `owner/repo`, or the single word `none` to turn release polling off), `AUTO_UPDATE`,
`BOT_BRANCH`, `COMMAND_PREFIX`, `PLUGINS`, `PLUGIN_INDEX_URL` — listed in `ALLOWED_SPEC`'s own order, the order the admin panel displays
them in (`DISCORD_SERVER_ID` first deliberately; see `ops/bot-ops.sh`). Each is validated
against a format regex when it *changes* (see the safety notes below); an empty value clears the
key back to its documented default.

**Plugin-declared keys** — on top of the static list above, **every plugin in the bot's cached Plugin
Index** contributes its own env keys, whether or not the plugin is in `PLUGINS=` (#256): `env-get` lists
them (non-secret only, after the static keys, in manifest order) and `env-set` accepts them, validating
each with the format and honouring the `required` flag — read from the bot's cached
`data/plugins/index.json`, never hand-mirrored here, and read on every `env-get` / `env-schema` /
`env-set`, even on an instance with no `PLUGINS` (one `docker exec … cat`). The index, not `PLUGINS`,
decides which keys are plugin keys, so **one `env-set` can turn a plugin on and set its settings** — a
single restart — and a key of a plugin that is off is inert until the plugin is on. When two plugins
declare the same key, the first declaration in index order governs it (its format and `required`), on
or off. The bot caches the
index at boot and on its ~15-minute refresh, while the panel's own plugin list comes from the panel's
own fetch of the index, so for up to that long the panel can show a plugin whose keys this script does
not know yet. This is where `WARBANDEER_INGEST_PORT`
lives now that the connector is the `warbandeer` plugin (issue #100): once the bot has cached the index
the key is editable, in the same save that sets `PLUGINS=warbandeer`. A plugin's **`secret` keys are
write-only** (#240, ADR-0006 decision 8): `env-set` accepts them, validated against their `format`
like any other key, but `env-get` never lists one and `env-schema` reports it only as `secret: true`
plus `isSet` — see "Plugin secrets are write-only" under the safety notes. A key the deployment
itself owns (a core credential, or a variable `docker-compose.yml` interpolates) or the bot core reads
without the panel editing it (`GITHUB_REPO`, `PLUGIN_REGISTRY_URL`, `BOT_DATA_DIR`, `NODE_ENV`,
`HANDOFF_FROM`, `HANDOFF_RESTART_POLICY`, `HOSTNAME`, and the four shard variables the discord.js
`Client` reads, `SHARDS`, `SHARD_COUNT`, `SHARDING_MANAGER`, `SHARDING_MANAGER_MODE`, and the HTTP
router's `HTTP_PORT` (#220) and `TRUSTED_PROXY_HOST` (#319), and `LOG_FORMAT` (#324) — all `RESERVED_KEYS`, #278), or that act on the core's own outbound calls or on a tool it spawns — both
spellings of each proxy variable, since Bun's `fetch` honours upper- and lower-case alike
(`HTTP_PROXY`/`http_proxy`, `HTTPS_PROXY`/`https_proxy`, `NO_PROXY`/`no_proxy`), and `TAR_OPTIONS`
(also `RESERVED_KEYS`, #280) —
stays out of every plugin path even if a manifest declares it, on or off. Variables that configure the
runtime in general instead (`NODE_OPTIONS`, `PATH`, `LD_PRELOAD`, `BUN_*`, `TZ`, and a bare
`ALL_PROXY`/`all_proxy`, which Bun's `fetch` does not honour) are not in it. If the
bot isn't running (no cached index),
`env-get` shows the static keys only and notes `plugins: index unavailable` on **stderr** (also on an
instance with no `PLUGINS`, since the index is read regardless) — never
an error (the JSON stays a flat map of editable keys, so the panel round-trips it unchanged) — and
`env-set` refuses a plugin key in that same state, since it can't read the manifest to validate one;
edit a plugin's keys while the bot is up. A valid-JSON-but-wrong-shape cached index is treated the
same way (degraded, never a crash).

**Core secrets are intentionally absent** — `DISCORD_TOKEN`, `GITHUB_TOKEN`, `ADMIN_TOKEN`,
`CLOUDFLARE_TUNNEL_TOKEN` and the other credentials the bot core itself reads. `env-get` never reads
them out and `env-set` refuses to write them. Edit those by hand with `nano` on the box. (A plugin's
own `secret` keys are the one exception, and only for writing — see below. The wow plugin's
`BLIZZARD_CLIENT_ID` / `BLIZZARD_CLIENT_SECRET` are such keys, not core: nothing in the bot core reads
them, so the panel can set them whenever the cached index offers `wow`.)

## Safety notes

- **Plugin secrets are write-only** (#240, ADR-0006 decision 8). Needing SSH to give a plugin its API
  key made adding one painful, so `env-set` accepts a key the cached Plugin Index marks `secret:
  true` — for any plugin in the index, on or off (#256) — and nothing ever reads it back. The value appears in no
  output this script emits: not in `env-get` (a secret key is never listed), not in `env-schema`
  (`secret: true` and `isSet` only), not in `env-set`'s result (it names changed *keys*), not in a
  refusal message (those name a key, and only one that looks like a variable name), not on stderr,
  and not in `docker`'s argv. These keep that true. (1) A submitted secret is **always written** and
  reported as changed, even with the value it already has: otherwise "no changes" would tell a caller
  its guess was the stored value. The one exception is a blank for a key that is already unset, which
  reveals only what `isSet` already does. (2) What `docker compose` prints is relayed — as `log` by
  `env-set`, as its output by `restart` — and compose is not ours: it quotes a `.env` line it refuses
  to parse. So a message that is **about the env file** (it names the file, or says "env file") is
  **withheld whole** and replaced by the script's own sentence: compose's output mentioned an env file,
  it is withheld because such a message can quote the file's contents, the line numbers it gave (if
  any), and running the same command on the host shows the original. That sentence names no path and
  claims no cause or remedy, and is the same whether the command failed or succeeded. The premise:
  compose-go's dotenv reader wraps every parse error as `failed to read <path>: …` (compose-spec/
  compose-go `main`, `dotenv/format.go`, read on 2026-09-21 — upstream `main`, not the compose on any
  host, which was never run for this), so the messages most likely to quote the file name it; and no
  amount of guessing which part of a line it printed can be made exact (compose ends a key at `=` or
  `:`, drops `export`, and trims U+0085 / U+00A0). Anything else is scrubbed (any other message can
  quote a value too), best effort, of what `env-get` would not print — core
  credentials, plugin secrets and plain plugin settings alike; only a static key written `KEY=value`
  is left — worked out from `.env` itself and never from the Plugin Index, which is unavailable exactly
  when the bot is down and compose is complaining. Every definition of a key counts; a line written
  any other way, or that is no definition at all, is scrubbed as a whole line and from its first `=`
  and `:` on; texts are replaced longest first (so a short secret can never unmask a longer one that
  contains it); and a text under six characters is left alone so the message stays readable (a
  credential that short is therefore not scrubbed). The second layer is best effort, not a proof: a
  tool that printed a value transformed would not be caught, and a compose that echoed caller-controlled text could still tell a caller whether a guess
  equals a stored secret (not observed; there is no compose on the dev box to test against). (3) A value containing a CR is
  refused for every key (it could start a new `.env` line), naming the key only, and so is a value
  containing `$` or a quote **anywhere**, for every key, secret or plain, static or plugin: compose
  reads a `.env` value as syntax, so `SPOTIFY_CLIENT_ID=${DISCORD_TOKEN}` would interpolate a core
  secret into a plugin's key (and `PLUGIN_INDEX_URL=https://host/?t=${DISCORD_TOKEN}` would send it to
  that host), and a quote can open a value that swallows the lines after it and stops compose loading
  the file — yet a manifest `format` such as the shipped `^\S+$`, and the static `PLUGIN_INDEX_URL`
  regex, admit both. (The guard is not limited to a leading quote because compose trims a wider set of
  whitespace than bash does, U+0085 and U+00A0 among it, before it looks for one; no shipped key needs
  either character. Older versions of this script checked neither.) Only a value that would change is
  judged: a plain key resubmitted with the value it already holds is skipped before this check (#44's
  rule), so a stored value that holds one never blocks an unrelated save; a submitted secret always
  counts as a change, so it is always judged. (4) A key the
  deployment or the bot core owns — the core credentials, the access and admin settings, every variable
  `docker-compose.yml` interpolates, the settings the core reads that the panel does not edit
  (`GITHUB_REPO`, `PLUGIN_REGISTRY_URL`, `BOT_DATA_DIR`, `NODE_ENV`, `HANDOFF_FROM`,
  `HANDOFF_RESTART_POLICY`, `HOSTNAME`, and discord.js's `SHARDS`, `SHARD_COUNT`, `SHARDING_MANAGER`,
  `SHARDING_MANAGER_MODE`, #278; the HTTP router's `HTTP_PORT`, #220, and `TRUSTED_PROXY_HOST`, #319; `LOG_FORMAT`, #324), and the variables that act on the core's own outbound calls or on a
  tool it spawns — both spellings of each proxy variable (`HTTP_PROXY`/`http_proxy`,
  `HTTPS_PROXY`/`https_proxy`, `NO_PROXY`/`no_proxy`) and `TAR_OPTIONS` (#280) — is
  dropped from every plugin path whatever the manifest says, on or off
  (`RESERVED_KEYS` in the script, pinned by tests against `.env.example`, the compose file, a scan of the
  variables the core's source reads and a behaviour table over the reserved core settings), so a manifest
  that names `DISCORD_TOKEN` cannot make the panel able to overwrite it. (5) The script fails
  closed on the manifest: a key that *any* plugin in the index declares secret — enabled or not — is
  never listed as a plain key, a `secret` that is not exactly `false`, `null` or absent counts as secret, an
  entry whose `key`, `format` or `required` holds a line break (or that has no string `format`) is
  unusable (a line break could re-frame the rows the script reads and forge a plain row for another
  plugin's secret) — though an unusable entry that claims `secret` still marks its key secret — and a
  secret key that
  collides with a static key is ignored (the static key wins). A panel admin who can set
  `PLUGIN_INDEX_URL` controls that index — and the plugin code the bot installs from it — so this
  protects against the panel, its logs and screens, not against whoever owns the index. The
  backup `env-set` writes still holds the previous `.env` — secrets included — which is why it is
  `0600`. A **webhook URL** in a `plugin-request` is treated the same way: it travels on stdin only,
  no message echoes any part of it (the new actions' messages name the field only; an update
  action's rejected field is echoed only when it is at most 40 printable characters, else `(not
  shown)`), and every request file is written owner-only (`umask 077`).

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
  `<config-dir>/backups/.env.bak.<stamp>-<pid>` is written before any change (the pid suffix is
  #227's: with the lock, two saves can no longer land in the same second, but the name is the
  record of what was replaced and must never depend on timing regardless); a no-op (new value
  equals current) does nothing and does **not** restart the bot.
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
      "remoteDir": "/opt/rackbops-discord-bot/bin",
      "project": "rackbops-discord-bot-debug",
      "container": "rackbops-discord-bot-debug",
      "configDir": "/opt/rackbops-discord-bot/debug",
      "composeFile": "/opt/stacks/rackbops-discord-bot-debug/docker-compose.yml",
      "scriptPath": "/opt/rackbops-discord-bot/bin/bot-ops.sh"
    },
    {
      "name": "prod",
      "ssh": "roshne@192.168.7.48",
      "remoteDir": "/opt/rackbops-discord-bot/bin",
      "project": "rackbops-discord-bot-prod",
      "container": "rackbops-discord-bot-prod",
      "configDir": "/opt/rackbops-discord-bot/prod",
      "composeFile": "/opt/stacks/rackbops-discord-bot-prod/docker-compose.yml",
      "scriptPath": "/opt/rackbops-discord-bot/bin/bot-ops.sh"
    }
  ]
}
```

Per target:
- `name` is the switch label, and `ssh` is the SSH destination.
- `project` and `container` are the compose project and container. Both are optional, but the
  defaults are the old `nazumods/wow` debug bot's (`warbandeer-discord-debug` /
  `warbandeer-discord`), so set them for an instance of this bot.
- `configDir`, `composeFile` and `scriptPath` are for an instance laid out as described above. Set
  all three or none: the backend refuses a target with only some of them. They become
  `BOT_OPS_CONFIG_DIR`, `BOT_OPS_COMPOSE_FILE` and the path to the shared script.
- `remoteDir` is still a required field, but it is unused once `scriptPath` is set. Without
  `scriptPath`, the script is taken to be `<remoteDir>/ops/bot-ops.sh`, which only fits a
  pre-migration checkout deploy.

With all three set, the panel runs
`ssh <ssh> "BOT_OPS_PROJECT=<project> BOT_OPS_CONTAINER=<container> BOT_OPS_CONFIG_DIR='<configDir>' BOT_OPS_COMPOSE_FILE='<composeFile>' bash '<scriptPath>' …"`,
reusing your existing key. So key-based SSH to that host must already work, as a user in the
`docker` group with no sudo. The shared backend (`nazumods/wow` `apps/bot-ops`) gained these three
fields for
[roshne/wow-companion#197](https://github.com/roshne/wow-companion/issues/197).

The old single-bot shape, `{ "ssh": "...", "remoteDir": "..." }`, is still read as one `debug`
target, but only works against the old, pre-migration contract. Shipped builds without an
`ops.json` never show the tab.

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

## A Rackbops Clerk instance (the task tracker)

The task tracker (`@rackbops/plugin-tracker`, Rackbops/rackbops-bot-plugins `plugins/tracker`) runs
on an instance of its own, logged in as the **Rackbops Clerk** Discord application (#324; plan of
record: Rackbops/Tooling `research/city-hall-task-tracker.md`, E3 and items 19 and 39). It is an
ordinary `ops/install.sh` instance -- here called `clerk` -- configured so that:

- **commands register globally and work in DMs.** `DISCORD_SERVER_ID` stays blank and
  `data/routing.json` places no plugin, so registration is the one global PUT
  (`src/routing/register.ts:56-59`, `:128-131`), and the routing gate lets every command typed in a
  DM through (`src/routing/gate.ts:105`). No command sets Discord's `contexts`, so Discord's default
  applies (see step 1).
- **it loads the tracker and nothing else** (`PLUGINS=tracker`). The core commands `/update`,
  `/plugins` and `/report` still register next to the tracker's: they are part of the core, not a
  plugin. `/report` says it is not configured while `REPORT_ROLE_ID` is blank. `/update` and
  `/plugins` carry `setDefaultMemberPermissions(0)`, which hides them from non-admins in a server,
  but in a DM they are probably visible to everyone (**inferred**): there, the only protection is
  the handler's own refusal of anyone not in `ADMIN_USER_IDS` (`refuseUnlessAdmin`,
  `src/commands.ts:47-59`).
- **the tracker's HTTP is reachable through the instance's own tunnel**: the host router serves
  every plugin under `/<plugin-name>/` on `HTTP_PORT` inside the container (`src/plugins/host.ts`,
  `routeHttpRequest`; ADR-0007), with no host port published. Today the tracker serves only
  `/tracker/healthz`; its web area (E5) will live under the same prefix.

**Secrets.** The one application secret is `DISCORD_TOKEN` (Clerk's own bot token). Beside it sit
the panel's `ADMIN_TOKEN`, which `install.sh` generates for every instance, and
`CLOUDFLARE_TUNNEL_TOKEN`, which every tunnelled instance has. There is **no city-hall or usr credential yet**: the reminder slice
never calls city-hall, and rev17 took people out of usr, so nothing here needs one until the
execute lane is built (and that waits on the Lepid-Labs side, plan item 25). There is **no
subscription token and no `ANTHROPIC_*` variable, ever** (plan 5.12): model calls run in
Rackbops/docket-runner, not in this bot.

**Precondition: reads gated (plan 5.10).** Every read of the tracker's store needs an identity and
returns only what that identity may see. For this slice the tracker meets it in the plugin itself:
every command and button passes its membership and admission gates, and `/task history` reads
through docket's owner / recipient / admin check; the only HTTP route, `/tracker/healthz`, returns
a status and a timestamp and nothing about anyone. The web area (E5) must keep to the same rule
before it is exposed.

### 1. The Discord application

Create **Rackbops Clerk** at <https://discord.com/developers/applications> under roshne's account,
distinct from every other bot. On **Bot**, copy the token and leave every privileged intent off
(the tracker declares none). On **Installation**, keep **Guild Install** with the scopes `bot` and
`applications.commands`, and invite Clerk to the tracker's server (the `TRACKER_GUILD_ID` one, so
its membership lookup works). A command with no `contexts` of its own gets Discord's default, which
takes in the bot's DMs, so a person who shares that server with Clerk can use the commands in a DM
with it (**inferred** from Discord's documentation, not yet seen on a live Clerk). **User Install**
is not needed for that and is left off.

### 2. The tunnel

In the Cloudflare Zero Trust dashboard, create a tunnel for this instance (Networks -> Tunnels ->
create -> Docker connector) and copy its token: it goes into `.env` in the next step. Give it one
public hostname, `clerk.<domain>`, with the service `http://rackbops-discord-bot-clerk:8080` --
the container **name**, not the `bot` alias a self-update's replacement also carries (see
`HTTP_PORT` in `.env.example`). Put a Cloudflare Access application in front of the hostname
(Access -> Applications -> self-hosted, `clerk.<domain>`): Google sign-in with an allow policy
listing the people who may use the web area, plus a service token and a Service Auth policy for
the uptime monitor, which checks `/tracker/healthz` through the gate. Each friend is added to the
allow policy once. The tracker's own one-time-link sign-in (`/web`) still runs behind it. The JSON
task API (`/tracker/api/v1/`) is gated too, so non-browser callers are turned away until the
tracker plan settles how they get through (plan item 74).

### 3. Bootstrap and `.env`

```sh
curl -fsSL https://raw.githubusercontent.com/Rackbops/rackbops-discord-bot/main/ops/install.sh \
  | bash -s -- clerk
```

Then, in the instance's config-dir `.env` (the hand-edited one; `install.sh` never touches it
again):

Comments go on their own lines: Compose's `env_file:` loader strips a ` # comment` written after a
value, but `bot-ops.sh` and the panel read it as part of the value (`load_env_values` in
`ops/bot-ops.sh`, `parseEnvValue` in `ops/admin/server.ts`), so the two would disagree about what
the bot is running with.

```sh
DISCORD_TOKEN=<Clerk's bot token>
# Required by the core: release announcements for GITHUB_REPO land here. A private channel in the
# tracker's server that Clerk can post in.
ANNOUNCE_CHANNEL_ID=<channel id>
# Blank: global registration, commands in DMs.
DISCORD_SERVER_ID=
# Blank: Clerk is its own application, nothing to collide with.
COMMAND_PREFIX=
GITHUB_REPO=Rackbops/rackbops-discord-bot
BOT_BRANCH=main
ADMIN_USER_IDS=<roshne's Discord user id>
AUTO_UPDATE=false
PLUGINS=tracker
# Any free port; only the tunnel reaches it.
HTTP_PORT=8080
# The tunnel sidecar's compose service name.
TRUSTED_PROXY_HOST=cloudflared
LOG_FORMAT=json
TRACKER_ADMIN_DISCORD_IDS=<roshne's Discord user id>
TRACKER_GUILD_ID=<the tracker server's id>
CLOUDFLARE_TUNNEL_TOKEN=<this instance's tunnel token>
```

Everything else (`REPORT_ROLE_ID`, `GITHUB_TOKEN`, the warbandeer and wow keys) stays blank.
`TRACKER_GUILD_ID` may be left blank -- then only the admission list gates the tracker, and the
plugin logs a warning each time it activates -- but set it. From tracker 0.8.0 it may also list
several servers, comma-separated (`TRACKER_GUILD_ID=<first id>,<second id>`): a member of any
listed server passes, one store and one admission list serve them all, and Clerk must be invited to
each listed server so its membership lookup works there (rackbops-bot-plugins#106). 0.7.0 and
older refuse to load a list.

**Never place the tracker.** A `routing-set` from the panel, or a hand-written `data/routing.json`,
that places a plugin switches the instance to routed mode: per-server registration, the global list
emptied, and the commands gone from DMs (`src/routing/register.ts:61-72`, `:143-146`). Check with
`bot-ops.sh routing-get`: `routing` is `null`, or places no plugin.

### 4. Up

Bring the bot up with `install.sh`'s printed step 2, then the tunnel sidecar with its step 5 (the
`--profile tunnel` command).

### 5. Health

```sh
curl -sS https://clerk.<domain>/tracker/healthz
```

`200` with `{"status":"ok"}` (or `"starting"` in the first minutes) while the notify lane ticks.
The tracker's own `503` is JSON: `stale` when the last good tick is more than three minutes old,
`blocked` when the lane cannot run at all. A plugin that is loaded but not running never reaches
the tracker: the host router answers a plain-text `503 Unavailable` itself
(`src/plugins/host.ts:841`, and again at `:861` once the body has been read). A host-router `404`
means the tracker did not load (read the logs); no answer at all means `HTTP_PORT` or the tunnel.
From the host, without the tunnel:

```sh
docker exec rackbops-discord-bot-clerk bun -e \
  'const r = await fetch("http://127.0.0.1:8080/tracker/healthz"); console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1)'
```

Docker restarts a process that exits, not one that hangs, so point a monitor at the public URL and
alert on anything but `200`.

### 6. Restart, and logs

The named restart path is `bot-ops.sh` with this instance's identity (`install.sh`'s printed
step 3):

```sh
export BOT_OPS_CONFIG_DIR=/opt/rackbops-discord-bot/clerk
export BOT_OPS_COMPOSE_FILE=/opt/stacks/rackbops-discord-bot-clerk/docker-compose.yml
export BOT_OPS_PROJECT=rackbops-discord-bot-clerk
export BOT_OPS_CONTAINER=rackbops-discord-bot-clerk
# Same containers, same env.
bash /opt/rackbops-discord-bot/bin/bot-ops.sh restart
# Re-reads .env (the panel's Restart).
bash /opt/rackbops-discord-bot/bin/bot-ops.sh recreate
bash /opt/rackbops-discord-bot/bin/bot-ops.sh logs 200
```

`restart` is `docker compose restart` over the whole project, so the panel and the tunnel sidecar
restart with the bot. Either command stops the bot with `SIGTERM`, which drains, disposes the plugins (the tracker closes its
database) and exits inside `docker stop`'s grace (`src/shutdown.ts`). With `LOG_FORMAT=json` every
line, the tracker's included, is one `{"time","level","msg"}` object (`src/logFormat.ts`), so
`docker logs rackbops-discord-bot-clerk 2>&1 | jq -rR 'fromjson? | select(.level=="error") | .msg'`
works (`fromjson?` skips any line that is not JSON). A crash is the exception: an uncaught exception
or unhandled rejection that ends the process is printed by Bun itself, as plain text.

Every command, button press and modal submit writes one line once it is handled (#328), e.g.
`[interaction] command /web user=<id> where=dm outcome=answered 212ms`: the kind, the command (with
its subcommand) or the customId's plugin prefix, the user's Discord id, `dm` or
`guild:<id>/channel:<id>`, the outcome (`answered`, `gated` by the routing gate, `unclaimed`, or
`error`, next to the error's own `[interaction]` or `[plugins] <name> interaction failed` line) and
how long it took. It never carries an option value, a
modal field or what the bot answered, so a `/web` sign-in link or a reminder's text never reaches
the log. `docker logs rackbops-discord-bot-clerk 2>&1 | jq -rR 'fromjson? | .msg | select(test("^\\[interaction\\] (command|component|modal) "))'`
lists them (the `[interaction]` error and "no handler" lines share the tag, so the filter names the
three kinds). Clerk runs with `AUTO_UPDATE=false`, so this reaches it on an admin's `/update` or a
re-run of `ops/install.sh clerk`, not by itself.

### 7. Backing up the tracker's database

The tracker keeps everything -- people, tasks, runs, history -- in one SQLite file in WAL mode,
`/app/data/tracker/tracker.sqlite` in the instance's `state` volume. It is personal data, so a
backup is kept only on this host, in an owner-only directory, and pruned.

**Decision: an online `VACUUM INTO`, run with the bun already in the bot's image.** It writes a
transactionally consistent copy while the bot keeps running (a WAL reader blocks no writer), folds
in whatever the `-wal` file holds, and needs no `sqlite3` on the host or in the image. Copying the
files out while the bot runs was rejected: the database, `-wal` and `-shm` would be caught at
different moments. Copying them with the bot stopped is consistent but stops the reminders for the
length of the copy, for no gain over `VACUUM INTO`.

Save this as `clerk-backup.sh` somewhere of the operator's choosing, outside the config dir:

```sh
#!/usr/bin/env bash
# Backs up the Clerk instance's tracker database. Exits non-zero on any failure.
set -eu
C="${CLERK_CONTAINER:-rackbops-discord-bot-clerk}"
DEST="${CLERK_BACKUP_DIR:?set CLERK_BACKUP_DIR to the backup directory}"
KEEP_DAYS="${CLERK_BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="/tmp/tracker-$STAMP.sqlite"
umask 077
mkdir -p "$DEST"
chmod 700 "$DEST"
# ESM, not require(): an error in a `bun -e` script that uses require() is printed but exits 0.
docker exec -u bun -e DB=/app/data/tracker/tracker.sqlite -e OUT="$TMP" "$C" bun -e \
  'import { Database } from "bun:sqlite"; const db = new Database(process.env.DB, { readwrite: true, create: false }); db.run("VACUUM INTO ?", [process.env.OUT]); db.close();'
docker cp "$C:$TMP" "$DEST/tracker-$STAMP.sqlite"
docker exec -u bun "$C" rm -f "$TMP"
find "$DEST" -name 'tracker-*.sqlite' -mtime +"$KEEP_DAYS" -delete
echo "clerk-backup: wrote $DEST/tracker-$STAMP.sqlite"
```

`create: false` makes a wrong database path an error instead of a new empty database, and
`VACUUM INTO` refuses a target that already exists; either exits the script non-zero. Run it daily
from the crontab of a user in the `docker` group (the script needs `docker exec` and `docker cp`),
for example:

```sh
15 4 * * * CLERK_BACKUP_DIR=<backup-dir> bash <path>/clerk-backup.sh >> <backup-dir>/backup.log 2>&1
```

The copy's own file mode comes from the container, so it is the `700` directory, not the file,
that keeps other users out. Fourteen days is the suggested retention; a person's forget-me (E5) is
not honoured by a backup until it ages out -- say so when forget-me ships.

**Restore** (the bot stopped, so nothing holds the file open):

```sh
docker compose -f /opt/stacks/rackbops-discord-bot-clerk/docker-compose.yml -p rackbops-discord-bot-clerk stop bot
docker run --rm -v rackbops-discord-bot-clerk_state:/app/data -v "<backup-dir>":/backup:ro oven/bun:1-slim sh -c \
  'cp /backup/tracker-<STAMP>.sqlite /app/data/tracker/tracker.sqlite && rm -f /app/data/tracker/tracker.sqlite-wal /app/data/tracker/tracker.sqlite-shm && chown bun:bun /app/data/tracker/tracker.sqlite'
docker compose -f /opt/stacks/rackbops-discord-bot-clerk/docker-compose.yml -p rackbops-discord-bot-clerk start bot
```

The stale `-wal`/`-shm` must go: a `-wal` left from the old file would be replayed onto the
restored one. Neither the backup script nor the restore has been run against a live instance
yet. The script was run against a stand-in `docker`. The `VACUUM INTO` step was checked against a
WAL database held open by another process, and it exits 1 on a missing database or an unusable
target.

## A Pip instance (owner result DMs)

Pip's own Discord identity (#333, Epic #332; plan of record `docs/plans/epics/EP-pip-discord-identity.md`
on the epic's plan branch, PR #331). It is an ordinary `ops/install.sh` instance -- here called `pip` --
logged in as the **Pip** Discord application and loading one plugin, `@rackbops/plugin-mcp`
(Rackbops/rackbops-bot-plugins `plugins/mcp`, 0.3.0 in the published index). Its purpose is to be the
visible sender of **owner result DMs**: a result sent through the `pip` bridge of the shared
`Rackbops/discord-mcp` service arrives as a DM *from the Pip application* instead of from prod, debug or
Clerk. The cites below were read from this repository at `8d039c9` (`main`), and the plugin's from
`Rackbops/rackbops-bot-plugins` at `477770d`.

Two identities are involved, and they are not the same thing:

- **The bot** is the Pip application. It is what Rod sees as the DM's author.
- **The principal** is Rod's own paired user on the `pip` bridge (`u-<discord id>@pip`), holding only
  the `dm:self` grant. It is what authorises the send. The service's `whoami` reports the principal,
  never the bot. (The principal's shape and grants are discord-mcp's, not this repository's; see
  its add-a-bridge runbook, linked in section 4 below.)

**Secrets.** `DISCORD_TOKEN` (Pip's own bot token) and `MCP_BRIDGE_TOKEN` (the bridge's shared secret).
On first install `install.sh` also generates an `ADMIN_TOKEN` and prints it (`ops/install.sh:269-273`); Pip never starts the
admin profile, so read that line in your own shell and never paste it anywhere. No tunnel, so no
`CLOUDFLARE_TUNNEL_TOKEN`. Placeholders in angle brackets below are filled in by the operator and are
never written into an issue, a comment or a transcript, and neither is a pairing code.

### 1. The Discord application

Create an application named **Pip** at <https://discord.com/developers/applications>, distinct from every
other bot. Official documentation, read 2026-10-06 (both pages now live under `docs.discord.com`; the old
`discord.com/developers/docs` URLs redirect there):

- Creating an app: [Getting Started](https://docs.discord.com/developers/quick-start/getting-started) --
  after you name the app and press **Create** you land on **General Information**.
- Installation: the same page describes **Installation contexts** (server and user) and **Default Install
  Settings**. For Pip use **Guild Install** only, with the scopes `bot` and `applications.commands`, and
  leave **User Install** off. Invite Pip to the one approved server with the install link the
  Installation page gives you.
- Privileged intents: [Gateway](https://docs.discord.com/developers/topics/gateway) names three,
  `GUILD_PRESENCES`, `GUILD_MEMBERS` and `MESSAGE_CONTENT`, toggled on the **Bot** page. Leave all three
  off. `GUILDS` is not privileged and needs no toggle. Nothing privileged is ever required here: the
  core builds its client with `Guilds` only (`src/client.ts:15`) and the `mcp` plugin declares
  `intents: []` (`plugins.json`'s `mcp` entry and `plugins/mcp/package.json` in
  `Rackbops/rackbops-bot-plugins`).

Keeping the application private (the **Public Bot** toggle on the **Bot** page) is the epic's decision;
that toggle was **not** read from a documentation page. On **Bot**, copy the token into the next step.
The avatar is a separate task and not part of this runbook.

### 2. Bootstrap and `.env`

```sh
curl -fsSL https://raw.githubusercontent.com/Rackbops/rackbops-discord-bot/main/ops/install.sh \
  | bash -s -- pip
```

Then, in the instance's config-dir `.env` (the hand-edited one; `install.sh` never touches it again).
Comments go on their own lines, for the reason given in the Clerk runbook's step 3 (Compose strips
an inline ` # comment`; `bot-ops.sh` and the panel do not).

```sh
DISCORD_TOKEN=<Pip's bot token>
# Required by the core (src/config.ts:78). A private channel in the approved server that only Rod can
# read: the default post target for plugins (section 3), never a DM. With the release watcher off
# (WATCHED_REPOS=none below) the core posts nothing here of its own.
ANNOUNCE_CHANNEL_ID=<channel id>
RELEASE_ANNOUNCE_CHANNEL_ID=
# The one approved server: with it set, registration is one guild-scoped PUT there and nowhere else
# (src/routing/register.ts:56-59, :128-131, reached from src/index.ts:367-382).
DISCORD_SERVER_ID=<server id>
# Every command is prefixed, core ones included (src/commandNaming.ts:13; commands.ts:61-67), so:
# /pipagent register|pair|unregister, /pipupdate, /pipplugins, /pipreport. 1-20 chars of
# [a-z0-9_-] (src/config.ts:96-102). The debug bot's prefix `r` (/ragent) is the precedent:
# Rackbops/discord-mcp deploy/config.multi-bridge.example.json:8.
COMMAND_PREFIX=pip
GITHUB_REPO=Rackbops/rackbops-discord-bot
# `none` turns release polling off (src/config.ts:87, :159); blank would fall back to GITHUB_REPO.
WATCHED_REPOS=none
GITHUB_TOKEN=
# Blank: /pipreport answers that it is not configured (src/report.ts:62-68).
REPORT_ROLE_ID=
# Empty on purpose: with no admins a plugin-update notice is only a log warning, repeated each
# 15-minute poll (src/announce.ts:31), never DMed or posted (src/plugins/updates.ts:495-498; the
# channel fallback at :510-517 runs only after a DM to a configured admin failed). The warning stops
# once mcp is on the index's newest version (:106) or that version is skipped (:110).
# Re-running install.sh and its printed step 2 (ops/install.sh:341) updates the bot core only. The
# plugin's installed version lives in plugins/state.json on the state volume
# (docker-compose.yml:44), and the bot never moves it on its own (src/plugins/install.ts:289-293,
# :320). With no admin, move it either with a mailbox request, which the bot applies and then
# restarts onto (ops/bot-ops.sh:1244-1278; src/plugins/requests.ts:482-491, :335), run with
# section 7's BOT_OPS_* variables:
#   printf '%s' '{"action":"update-now","plugin":"mcp","version":"<x.y.z>","requestedBy":"operator"}' |
#     bash /opt/rackbops-discord-bot/bin/bot-ops.sh plugin-request
# or by pinning PLUGINS=mcp@<x.y.z> below and running bot-ops.sh recreate (.env.example:46-48,
# ops/bot-ops.sh:682-691, :949). A non-numeric requestedBy keeps the outcome in the log
# (src/plugins/updates.ts:692-693). The same request with "action":"skip" and the index's newest
# version silences the warning without moving the plugin (src/plugins/requests.ts:499-501).
ADMIN_USER_IDS=
AUTO_UPDATE=false
BOT_BRANCH=main
PLUGINS=mcp
PLUGIN_INDEX_URL=
# The host router (ADR-0007): the bridge answers under /mcp/ on this port, inside the compose network
# only (no host port is published, and Pip has no tunnel).
HTTP_PORT=<free internal port>
TRUSTED_PROXY_HOST=
LOG_FORMAT=json
# The pip bridge's shared secret: the same value the discord-mcp service holds as
# DISCORD_MCP_BRIDGE_TOKEN_PIP. Generated once, written to both files, never printed.
MCP_BRIDGE_TOKEN=<43+ non-whitespace characters, e.g. 32 random bytes>
```

`MCP_BRIDGE_TOKEN` is the plugin's own secret key (`format` `^\S{43,}$`, `secret: true` in the manifest),
and reaches the plugin through the instance `.env` like any plugin key. It is declared `required: false`
because the plugin's behaviour with it unset is a runtime one: the bridge answers `503` to everything
(`plugins/mcp/src/http.ts:186-187`). Everything else (the warbandeer and wow keys) stays blank.

### 3. What the core still does

The core still runs next to the plugin. This is every way the host sends something **on its own
initiative** under the `.env` above, plus the command paths a member can trigger, so that "Pip's host
sends nothing unsolicited that reaches a DM" is a cited claim and not an assumption. Not listed, by design:
the host's other interaction replies, which go only to the person who interacted and only after they did
(`src/plugins/host.ts:657`, `:681`, and the empty autocomplete response `:755`; `src/commands.ts:200-203`, `:325`). Line numbers are on `f5e7bd7`
(this repository) and `2820afe` (`plugins/mcp` 0.3.1).

| Path | Where it goes under this `.env` | Why it is bounded | Evidence |
|---|---|---|---|
| Release watcher | Nothing: the watcher is off. | `WATCHED_REPOS=none` makes `watchedRepos` `[]` (`src/config.ts:87`, `:159`); `checkReleases` loops nothing, so no release is polled or posted, and boot logs `[release] watcher off (WATCHED_REPOS=none)`. This switches off release polling only: the Plugin Index fetch and the self-update checks are separate. | `src/announce.ts:427-431` (`describeReleaseWatch`) and `:435-443` (`checkReleases`), the tick check at `:217-222` (15-minute poll `:28`), the boot line `src/index.ts:313` |
| Plugin-update notice | Nowhere: a log line. | With `ADMIN_USER_IDS` empty it logs `[plugins] a plugin update is available but ADMIN_USER_IDS is empty` and returns `false`; the version stays un-notified and the warning repeats each 15-minute poll. Section 2's ADMIN_USER_IDS comment says how it stops and how to move the plugin with no admin. The announce-channel fallback runs only after a DM to a configured admin failed. | `src/plugins/updates.ts:489-518` (`deliverPluginNotification`; the empty-list return at `:495-498`, the fallback at `:510-517`), `:578-605` (`checkPluginUpdates`); live deliverers `src/announce.ts:308-322` |
| Scheduled plugin update | Nowhere under this `.env` unless someone writes the request mailbox on the host (see why). In general: the bot restarts onto the update and DMs a heads-up to the Discord user who scheduled it (`src/plugins/updates.ts:653-658`). | A schedule comes only from a request: an admin's `/pipplugins` (none here) or the host-side mailbox. `bot-ops.sh plugin-request` is a `docker exec -u bun` write that validates `action`, `plugin`, `version`, `at` and `days` and never `requestedBy` (`ops/bot-ops.sh:1244-1317`, the write at `:1338`); the bot's `validate` requires only a non-empty string there (`src/plugins/requests.ts:430`) and never consults `ADMIN_USER_IDS`; `update-now` and `schedule` carry it into the state (`:488-501`), and a snowflake is DMed (`updates.ts:653-658`; after the restart, `:697-702`). So anyone in the host's docker group can make Pip's core DM any 17-20 digit user id (`isDiscordUserId`, `src/plugins/updates.ts:225`): a `schedule` DMs twice, the heads-up and the report-back, and `update-now` once, the report-back. That group is Pip's real admin set: the bot service loads the whole `.env` with `env_file` (`docker-compose.yml:36`), so `docker inspect` shows every secret (the admin sidecar's comments say what the wholesale load does, `:74-76`, and that `docker inspect` shows the container's environment, `:84-85`; `ops/install.sh:357-359`), and the group is root-equivalent on the host in itself (`docker-compose.yml:45-49` says the same of the mounted socket); `ADMIN_USER_IDS=` governs Discord-side actors only. The panel's "logged, not sent" outcome is the panel's own choice of a non-snowflake `requestedBy` (`ops/admin/server.ts:2032`), enforced nowhere else. Section 2's `ADMIN_USER_IDS` comment carries the mailbox recipe. | `src/plugins/updates.ts:615-666` (`runDueSchedules`, the DM at `:655`); `src/plugins/requests.ts:419-430` (`validate`), `:488-501` |
| Self-update tick | Nothing. | The check does nothing unless `config.autoUpdate`, and `AUTO_UPDATE=false`. | `src/announce.ts:224-228` |
| `/pipupdate`, `/pipplugins` | An ephemeral refusal to whoever types it: "No admins are configured". | Both set `setDefaultMemberPermissions(0)`, hiding them from members without Discord's Administrator permission (`src/commands.ts:106-107` and `:138`); the handler then refuses anyone not in `ADMIN_USER_IDS`, and with the list empty that is everyone, a server Administrator included. | `src/commands.ts:107` and `:138`; the refusal `:50-59`, called at `:109` and `:171`; the prefix `src/commandNaming.ts:15-16` |
| `/pipreport` | An ephemeral "isn't configured" reply. | Both `REPORT_ROLE_ID` and `GITHUB_TOKEN` are blank, so it never reaches its modal. | `src/report.ts:62-68` |
| `/pipagent` | The plugin's `agent` command, prefixed by `buildCommandBody`; registered with the core commands in one guild-scoped PUT to `DISCORD_SERVER_ID`. | Single mode (no `routing.json`) with a home guild: `src/routing/register.ts:56-59`, executed at `:128-131`. Not a direct REST call in `index.ts`: `initRouting` and `applyRouting` do it. Its replies are to whoever typed it. | `src/plugins/host.ts:293-332`, called at `src/index.ts:212`; `src/index.ts:367-382` |
| Report-backs after an update | Nowhere under this `.env` unless a mailbox request moved the plugin (see why). In general: an ephemeral follow-up where the command was typed, within 15 minutes of it, else a DM, else a channel post (`src/updateReport.ts:101-104`, the window `:13-14`; the follow-up is a raw REST webhook POST, `:128-133`, the one send path outside the Client, `src/client.ts:6-7`). | Delivered only when an owed marker exists: `state.pendingUpdateReport`, set only with a `requester` (the guard `src/update.ts:103-111`, applied at `:303-308`; the one call site constructing a requester is `src/commands.ts:117`), or `state.pendingReport`, set by `/plugins update`, `runDueSchedules` and a mailbox `update-now` (`src/plugins/requests.ts:488-498`). `/pipupdate` and `/pipplugins` refuse here, so the mailbox, which writes only `state.pendingReport` (`src/plugins/requests.ts:489-496`), is the only writer left and `state.pendingUpdateReport` has none; a snowflake `requestedBy` is DMed and any other value is logged (`src/plugins/updates.ts:697-702`: the log at `:697-698`, the DM at `:702`). | `src/index.ts:440` (`reportUpdateOutcome`, `src/updateReport.ts:156-176`) and `:444-455` (`reportPluginUpdateOutcome`, `src/plugins/updates.ts:684-714`) |
| Plugin `post` / `dm` / `edit` / `announce` (the host API) | A DM or an edit, **sent by core code on the plugin's request**: this is the path owner result DMs take. A channel delivery is refused here: `host.post` is wired (`src/index.ts:191-200`), every channel delivery takes that branch (`plugins/mcp/src/drain.ts:177-190`), and with no `routing.json` it throws "destination is not mapped in that server" before any Discord call (`src/plugins/host.ts:148-150`, `src/routing/resolve.ts:95-99`), recorded `failed` / `UPSTREAM_UNAVAILABLE`. Pip runs no panel, and the bot's own paths map a destination only through a `routing-set` request written to the host mailbox (`ops/bot-ops.sh:1279-1303`, applied at `src/plugins/requests.ts:372`), the same host-side write the scheduled-update row describes; this runbook writes none. The `announce` fallback to `ANNOUNCE_CHANNEL_ID` (`plugins/mcp/src/drain.ts:196-202`) runs only when `host.post` is not a function, so never here. | Only the `mcp` plugin calls it here, and only when the bridge's service sends a delivery (or the plugin's own tick re-drives one a restart left `unknown`, `plugins/mcp/src/index.ts:65-80`; the `edit` call `plugins/mcp/src/drain.ts:105`, the DM call `:133`, the channel branch `:177-190`); the service's grants for the principal bound what it may ask for (section 4). | `src/index.ts:171-200` (the host wiring); `src/plugins/delivery.ts:16-46` (`sendPayloadToChannel`, `sendPayloadDm`), `:56-62` (`editOwnMessage`); `src/routing/post.ts:60` (`postForPlugin`, the `announce` path) |
| Guild events | Nothing sent. | `GuildCreate`/`GuildDelete` re-register commands or rewrite discovery. | `src/index.ts:293-294`, `src/routing/live.ts:272-293` |
| Boot, handoff, ticks | Log lines and files. | A standby that never logs in writes a marker file and exits; the mailbox drain and the discovery refresh write files, not messages. | `src/bootLog.ts`; `src/index.ts:130`, `:458-472`; the 5-second mailbox drain `src/plugins/drain.ts:11`, `:26`, started at `src/index.ts:354-359`; the 60-second backstop `src/announce.ts:230-270` (`pluginRequests`, `discovery`) |

Interaction replies (`/pipagent` and the refusals above) are solicited: someone typed the command. The
deliveries through the host API are sent by core code but asked for by the plugin, so they are bridge
deliveries, bounded by the service's grants (section 4) and not by this `.env`. **Conclusion:** under
this configuration the core has no unsolicited Discord output that is not a bridge delivery: the release
watcher is off (`WATCHED_REPOS=none`, added by [#342](https://github.com/Rackbops/rackbops-discord-bot/issues/342)),
and no core-initiated path produces a DM without a host-side mailbox write: the two rows above that can
DM, a scheduled update's heads-up and the report-back, need a request in the mailbox, which only the
host's docker group can write, and that group is Pip's real admin set; the only other DMs are the ones the
plugin sends through the host API on the bridge's request. The switch turns off release polling, not every GitHub request: the Plugin Index
fetch and the self-update checks are separate paths.

### 4. The bridge

This side supplies three values, and the service side is configured from them:

- the container name, `rackbops-discord-bot-pip` (the compose project's `container_name`, from
  `BOT_OPS_CONTAINER`, `docker-compose.yml:31`);
- `HTTP_PORT`, the free internal port from step 2;
- `MCP_BRIDGE_TOKEN`, written into this `.env` and into the service's `DISCORD_MCP_BRIDGE_TOKEN_PIP`.

The bot's compose project is `rackbops-discord-bot-pip` and its network is the project default,
`rackbops-discord-bot-pip_default` (`docker-compose.yml` declares no `networks:` key), so the service
reaches the bridge at `http://rackbops-discord-bot-pip:<HTTP_PORT>/mcp` once it is attached to that
network. The service side (the `pip` bridge entry, the network attachment and the default `dm:self`
grant) is in `Rackbops/discord-mcp`'s
[`deploy/add-bridge.md`](https://github.com/Rackbops/discord-mcp/blob/main/deploy/add-bridge.md)
(Rackbops/discord-mcp#78, for this repo's #334).

`GET /mcp/capabilities` answers `401` without the bearer (and `503` if `MCP_BRIDGE_TOKEN` is unset in the
container: `plugins/mcp/src/http.ts:186-191`, `plugins/mcp/src/auth.ts:63-71`), so a `401` from inside the
network is the "listener is up" check, not a failure.

### 5. Up

Bring the bot up with `install.sh`'s printed step 2. No admin profile and no tunnel: the printed steps 4
and 5 are not run for Pip.

### 6. Pairing on Melody

In Discord, in the approved server, run `/pipagent register` and then `/pipagent pair` (a single-use,
10-minute pairing code, per the plugin's 0.2.0 release notes in the published index). Then, on Melody:

```sh
DISCORD_MCP_URL=https://mcp.rackbops.com/mcp DISCORD_MCP_CONFIG_DIR=<new Pip-only dir> \
  node <discord-mcp checkout>/dist/shim/cli.js pair <code>
```

`pair` saves the URL into `credentials.json`, so later runs need only the directory
(`Rackbops/discord-mcp` `src/shim/cli.ts:107-181`). Use a dedicated, **absolute** directory
(`cli.ts:39-53`: the shim resolves credentials from `DISCORD_MCP_CONFIG_DIR`, and a relative path is
refused): a separate directory is what keeps the prod integration's `credentials.json` untouched. Paste
the code nowhere but that command.

### 7. Health, restart, and logs

```sh
docker logs rackbops-discord-bot-pip 2>&1 | grep 'Logged in as'
docker exec rackbops-discord-bot-pip bun -e \
  'const r = await fetch("http://127.0.0.1:<HTTP_PORT>/mcp/capabilities"); console.log(r.status); process.exit(r.status === 401 ? 0 : 1)'
```

`Logged in as <tag>` (`src/index.ts:130`) says the gateway login worked; `401` from the probe says the
bridge listens and the token is set. `503` means `MCP_BRIDGE_TOKEN` did not reach the container; no
answer at all means `HTTP_PORT`. Failed bearers count toward the plugin's per-IP lockout (more than ten
in a minute answers `429`), so probe a few times, not in a loop. Restart and logs are Clerk's step 6 with
`pip` substituted: `BOT_OPS_CONFIG_DIR=/opt/rackbops-discord-bot/pip`,
`BOT_OPS_COMPOSE_FILE=/opt/stacks/rackbops-discord-bot-pip/docker-compose.yml`,
`BOT_OPS_PROJECT=rackbops-discord-bot-pip`, `BOT_OPS_CONTAINER=rackbops-discord-bot-pip`, then
`bash /opt/rackbops-discord-bot/bin/bot-ops.sh restart | recreate | logs 200`.

### 8. Rollback and disable

In this order:

1. **Stop sending:** remove the Pip credentials directory on Melody, or run `/pipagent unregister`.
2. **Stop Pip.** `bot-ops.sh` has no stop subcommand (`ops/bot-ops.sh:1361` lists them), so:

   ```sh
   docker compose -f /opt/stacks/rackbops-discord-bot-pip/docker-compose.yml -p rackbops-discord-bot-pip stop
   ```

3. **Remove the `pip` bridge from the service**, following the add-a-bridge runbook's rollback. Never
   restore the service's state from a snapshot.

Revoking the bot token and deleting the application are Rod's explicit calls, not part of a rollback.

### 9. What the live run showed

Brought up on nucbox on 2026-10-07 (evening, America/Detroit) and accepted through 2026-10-08 01:28Z. Every
line and number below is quoted from the evidence comments on #336, #337 and #338 and the hosted-side
comments on #332; ids are redacted exactly as they are there. Nothing here is from memory.

**Boot** (second boot, after the `.env` was corrected; `docker logs`, JSON; #336,
[comment](https://github.com/Rackbops/rackbops-discord-bot/issues/336#issuecomment-6047243628)):

```
[boot] env file: /opt/rackbops-discord-bot/pip/.env
[plugins] index: fresh, 1 selected, 0 skipped
Logged in as pip#0023
[plugins] mcp@0.3.0 downloaded, integrity ok
Registered 4 slash commands
```

The first boot ran before the `.env` edit (token only): plain-text logs, `0 selected`, and `Registered 3
slash commands` **globally**. It was corrected by editing the `.env` and `bot-ops.sh recreate`, and the
global list was then emptied with one authenticated `PUT [] /applications/<app>/commands` -> `200`,
because single-server mode never clears it itself (`src/routing/register.ts:43-44`). **Set the `.env`
before the first `up`.** Four distinct bot ids across the instances (pip `15...391`, prod `15...246`,
debug `15...424`, clerk `15...121`).

**The bridge** (`pins.js show` on the discord-mcp stack, #336,
[comment](https://github.com/Rackbops/rackbops-discord-bot/issues/336#issuecomment-6047273999)):

```
bridge  pip              ... test=false  recorded=2026-10-07T21:32:01.524Z  (matches)
```

The `pip` pin was recorded at the service's recreate, which means its authenticated `capabilities` probe
reached the Pip bridge in-network and the shared secret matched on both sides. `curl
https://mcp.rackbops.com/healthz` -> `200`. (The live instance's `MCP_BRIDGE_TOKEN` was 32 random bytes in
hex; any 43+ character non-whitespace value satisfies the manifest's format.)

**Acceptance A1-A11** (the plan document's matrix, `EP-pip-discord-identity.md` section 7):

| Row | Outcome | Date (as on the issue; evening rows are America/Detroit) | Evidence |
|---|---|---|---|
| A1 identity | passed (name + application id confirmed by Rod); the approved avatar (`assets/PIP/pip-canonical-review-v1.png`, #343) was uploaded to the Pip application by Rod on 2026-10-08 | 2026-10-07 (avatar 2026-10-08) | [#338](https://github.com/Rackbops/rackbops-discord-bot/issues/338#issuecomment-6050347866), [#338](https://github.com/Rackbops/rackbops-discord-bot/issues/338#issuecomment-6059443571) |
| A2 isolation | passed: the Pip credential is `u-...@pip` with `dm:self`; the prod integration still answers `@prod` through its own untouched directory | 2026-10-07 | [#337](https://github.com/Rackbops/rackbops-discord-bot/issues/337#issuecomment-6047685066), [#337](https://github.com/Rackbops/rackbops-discord-bot/issues/337#issuecomment-6047828399) |
| A3 duplicate | passed | 2026-10-07 | [#338](https://github.com/Rackbops/rackbops-discord-bot/issues/338#issuecomment-6049553760) |
| A4 blocked DMs | passed (a block is the control) | 2026-10-07 | [#338](https://github.com/Rackbops/rackbops-discord-bot/issues/338#issuecomment-6049553760) |
| A5 revocation | **not run on pip**, by Rod's decision (he declined to cycle a working registration); "proven on debug + per-bridge tests" is the basis, not a pass | - | [#337](https://github.com/Rackbops/rackbops-discord-bot/issues/337#issuecomment-6047828399), [#338](https://github.com/Rackbops/rackbops-discord-bot/issues/338#issuecomment-6049553760) |
| A6 outage | passed | 2026-10-07 | [#338](https://github.com/Rackbops/rackbops-discord-bot/issues/338#issuecomment-6049553760) |
| A7 privacy | passed | 2026-10-07 | [#338](https://github.com/Rackbops/rackbops-discord-bot/issues/338#issuecomment-6049553760) |
| A8 Melody unavailable | passed: Melody genuinely reported offline, delegation returned a generic backend error and no task turn was admitted; hosted chat said the task could not start and no DM had been sent; no queued or automatic send (the error's cause is not established) | 2026-10-08 | [#338](https://github.com/Rackbops/rackbops-discord-bot/issues/338#issuecomment-6050347866) |
| A9 policy | passed, both cases: a task without the phrase produced no send (00:37Z); a fresh task with the exact text `notify me on Discord` sent once after Melody reconnected, with the **same** event id and expiry resumed (01:28Z) | 2026-10-08 | [#338](https://github.com/Rackbops/rackbops-discord-bot/issues/338#issuecomment-6049826123), [#338](https://github.com/Rackbops/rackbops-discord-bot/issues/338#issuecomment-6050347866) |
| A10 preserved instances | passed: prod, debug and Clerk start times unchanged; only Pip created and discord-mcp recreated once | 2026-10-07 | [#336](https://github.com/Rackbops/rackbops-discord-bot/issues/336#issuecomment-6047072913), [#336](https://github.com/Rackbops/rackbops-discord-bot/issues/336#issuecomment-6047685310) |
| A11 restart | passed | 2026-10-07 | [#338](https://github.com/Rackbops/rackbops-discord-bot/issues/338#issuecomment-6049553760) |
| Exit demo | shown: hosted Pip -> connected Melody -> `scripts/result-dm.mjs` -> one DM visibly from the Pip application, `sent` / exit 0; hosted chat reported the truthful outcome in both the failure and the success case | 2026-10-08 | [#338](https://github.com/Rackbops/rackbops-discord-bot/issues/338#issuecomment-6050347866) |

**Unverified, and why.** A5 was not re-run on pip (Rod's decision). The **service-side half of the
rollback** was not rehearsed (Rod's decision; the runbook and the `compose.yaml.bak-pre-pip` /
`config.json.bak-pre-pip` backups are in place). What *was* rehearsed is the disable control: the Pip
credentials directory renamed away -> `{"outcome":"invalid","stage":"validate",...}` and `result-dm:
invalid (credentials.json under DISCORD_MCP_CONFIG_DIR is missing, unreadable or not JSON)`, no network
call, nothing sent; renamed back -> `dry_run`, `u-20...144@pip` ([#338](https://github.com/Rackbops/rackbops-discord-bot/issues/338#issuecomment-6049553760)).
The A8 error's cause is not established. Seven DMs were delivered to Rod from the
Pip application during acceptance, all bridge records `delivered`; prod, debug and Clerk were never
touched. The screenshot of the first hosted DM proves visible delivery, not a full-history duplicate
audit; duplicate behaviour is covered by A3 and A11.

The release-watcher switch (`WATCHED_REPOS=none`, [#342](https://github.com/Rackbops/rackbops-discord-bot/issues/342)) did not exist when this run happened. It was enabled on the live Pip instance afterwards, on 2026-10-07 23:02 EDT, with the evidence (the deployed `GIT_SHA` `b4d322c` and the `[release] watcher off (WATCHED_REPOS=none)` boot line) recorded on [#342](https://github.com/Rackbops/rackbops-discord-bot/issues/342#issuecomment-6051317589). The section 3 table describes the configuration this runbook prescribes, not a statement about the live instance.

### 10. Hosted-Pip handoff

Everything between the two rules below is written to be pasted into hosted Pip's instructions and to be
understood without this repository open. The policy is Rod's, recorded on #332 on 2026-10-07: "opt-in
phrase **"notify me on Discord"** per task; everything else excluded. No quiet hours; 24-hour expiry; no
replay; retry = the same event id." The script's contract is the `scripts/result-dm.mjs` entry in
Rackbops/discord-mcp's README (this repo's #335, Rackbops/discord-mcp#79).

---

**Result DMs to Rod, from the Pip application**

*When.* Only for a task Rod starts with the exact phrase **notify me on Discord** in the task's own text,
and only for that task's terminal result. A task without the phrase never notifies. One DM per task. Never
a progress update, never a summary of a conversation.

*The event.* Mint one opaque **event id** for the task when you hand it off, store it in the task, and
reuse the same id on every retry. Never mint a new id per attempt, and never use a bare conversation id (one
conversation can hold several tasks). It is 1-120 characters from `A-Z a-z 0-9 . _ : -`. The service turns
a repeat of the same event into `duplicate`, never a second DM; a new id would be a second DM.

*The fields.*

- `--label`: the task's own title as one line (no line breaks), trimmed to 200 characters; the script
  refuses a longer or multi-line label as `invalid`. In PowerShell a single-quoted title must double any
  apostrophe (`it''s`).
- `--status`: one of `done`, `failed`, `blocked`, `cancelled`, from the task's terminal state (finished
  successfully -> `done`; ended in error -> `failed`; stopped waiting on Rod -> `blocked`; stopped on
  request -> `cancelled`). No other word.
- `--link`: optional; include it only when the task produced exactly one result page, as an `https://` URL
  of at most 512 characters with no spaces. Otherwise leave it out.
- `--expires`: **required**. The handoff time plus 24 hours, as ISO-8601 with an offset or `Z`, for
  example `2026-10-08T21:25:00-04:00`. After it the script refuses to send.

*The one command.* The delegated Melody task runs exactly this, in PowerShell, with the directory variable
always set explicitly (the script refuses to run without it):

```powershell
$env:DISCORD_MCP_CONFIG_DIR = "$env:APPDATA\discord-mcp-pip"
node 'R:\repos\discord-mcp\scripts\result-dm.mjs' --bridge pip --event <id> --label '<text>' --status <word> --expires <iso> [--link <url>]
```

`R:\repos\discord-mcp` is the discord-mcp checkout on Melody (use its actual path if it differs). `%APPDATA%\discord-mcp-pip` is Pip's own credentials directory. The prod integration's directory
(`C:/Users/roshn/.config/discord-mcp`) is never used for Pip. `--bridge pip` makes the script refuse any
credential whose principal is not on the `pip` bridge. Run it once per attempt and read its one JSON line on
stdout. Never pair, read, copy or print a credential, and never pass `--dry-run`.

*What to tell Rod, by the `outcome` word.* Report a DM as sent only on `sent` or `duplicate`.

| `outcome` (exit code) | Say |
|---|---|
| `sent` (0) | "DM sent." |
| `duplicate` (0) | "Already sent earlier." |
| `pending`, `unknown`, `rate_limited` (3) | "Delivery pending -- retry the same event later; do not start a new one." |
| `unavailable` (3) | "DM not sent: the delivery route was unavailable. Retry the same event later." |
| `expired` (4) | "Not sent: the result is older than its expiry." |
| `unreachable`, `denied`, `unresolved`, `invalid` (2) | A plain failure that names the outcome word. Nothing was sent. |
| `error` (1) | "Outcome unknown (`error`): do not treat the DM as sent." Retry the same event only if Rod asks. |

To retry, re-run the **same** event while it has not expired, and only when Rod asks or the outcome says
to. If the delegation never reaches Melody (offline, backend error, no task turn admitted), say that the
task could not start and that no DM was sent; do not switch machines, do not revoke anything, and do not
queue a send. When Melody is back, the same event may be run once.

*Stopping it.* Rod can stop every send instantly and reversibly by renaming or deleting
`%APPDATA%\discord-mcp-pip` on Melody: the script then refuses with `invalid` (credentials missing) and
sends nothing. `/pipagent unregister` in Discord is the server-side alternative; the next call is
`ACCESS_DENIED` (as proven on the debug bridge, not re-run on pip).

---

*Rollback, in the order section 8 gives.* Stop sending (the directory above, or `/pipagent unregister`),
stop Pip (`docker compose ... stop`), remove the `pip` bridge from the service, and never restore the
service's state from a snapshot. Only the first step was rehearsed on this deployment (section 9); the
service-side half was not.

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
server-native routes:** `GET /api/status`, `GET /api/logs?n=`, `POST /api/restart` (routed but unused
by the page since #277 — see below), `POST /api/recreate` (**#277**: what the Overview's Restart
button actually calls), `GET /api/env`,
`POST /api/env`, `GET /api/whoami` (reflects the requester's own verified Access identity — who
they're signed in as, plus the JWT's claims for the panel's Identity view), and
`GET/POST/DELETE /api/admins` (the panel-managed dynamic admin list — see the narrowing note
above), `GET /api/branches` (the configured repo's branches, for the `BOT_BRANCH` chooser), and
`GET /api/plugins` (the Plugins tab's cards — the Plugin Index merged with this instance's installed
state and current `PLUGINS`; see below), and (**#105**) `POST /api/plugins/request` (an update-action
button → a request file the bot consumes), and (**#242**) the routing routes: `GET /api/routing`
(`bot-ops.sh routing-get`: the bot's `routing.json` and `discovery.json` as `{ routing, discovery }`) and
four writes, `POST /api/routing` (one plugin's server map), `POST /api/webhooks` (`{ url }`),
`DELETE /api/webhooks/<channel id>` and `POST /api/discovery/refresh`, each a `plugin-request` action the
bot applies. The **panel never calls Discord**: the server mints each write's request `id` and returns it
(`{ ok, id, queued }`), and the page learns the outcome, including which channel a new webhook landed on,
from `routing.results` under that `id` a few seconds later. A webhook URL is a secret here too: it reaches
`bot-ops.sh` on stdin only, never in `argv`, a log line, a response or an error message (a `bot-ops.sh`
failure's stderr is redacted before it is logged or returned), and (**#123/#165**) `GET /plugin-admin/<name>.js?v=` +
`GET /api/plugin-proxy/<name>?path=&v=` (a plugin's own admin-tab bundle and its data assets,
proxied same-origin from that plugin's own published package on the allowlisted CDN host — see
"Plugin admin tabs" below), and (**#238**) `GET /rb-theme.css` + `GET /admin.css` + `GET /favicon.svg` (the page's two
stylesheets and Luma favicon, read once at startup from `ops/admin/public/` and served by exact path, public at this
layer like the page itself). The
`/api/whoami`, `/api/admins`, `/api/branches`, `/plugin-admin/<name>.js`,
`/api/plugin-proxy/<name>`, `/rb-theme.css`, `/admin.css` and `/favicon.svg` routes never shell out to `bot-ops.sh`;
`/api/plugins` reads installed state via `status` + `env-get` and fetches the index server-side, and
`/api/plugins/request` shells `bot-ops.sh plugin-request` (the only plugin route that does; the four routing
writes above use the same subcommand), while
a plugin's *enabled* state still goes through the ordinary `POST /api/env` (its `PLUGINS` line, sent by
the Apply bar together with any edited config fields, in one request).
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
like SSH to the box.** That includes any plugin admin tab the panel mounts: a bundle runs with the
panel's own authority, so the Plugin Index is the trust boundary (ADR-0005 decision 6). The config form on the
page is rendered from whatever `GET /api/env` returns (bar `PLUGINS`, below), so it can never drift from
this script's own `ALLOWED` whitelist above. **One Apply bar (#257) collects every change that needs a
restart** — the plugin on/off choices on the Plugins tab and every edited config field — in a bar at the
bottom of the page, visible from any tab and shown only while something is pending, and sends them as a
**single** `POST /api/env` carrying only what changed (`PLUGINS` first): one restart, however many things
changed. There is no per-section Save button and no confirm dialog: the bar states the consequence ("the
bot goes offline for about 20 seconds") next to **Apply and restart**, and **Discard** re-renders every
control from the bot's current state and sends nothing. The POST carries only the fields that changed —
never the untouched ones echoed back (issue #44): a stored value the whitelist would reject can't block an
unrelated apply, and a tab loaded before another operator's save can't silently revert their unrelated
edit. When an apply fails the bar says why (`Couldn't apply: …`), and what happens to the controls depends
on the answer (#272). One of `env-set`'s own **refusals** — an HTTP 502 whose plain-text body has a line
starting `bot-ops: env-set: `, the script's `die "env-set: …"` before it writes — **keeps** the user's
edits and plugin ticks and leaves **Discard** and **Apply and restart** on the bar, so one refused value
can be corrected without retyping the rest (a test pins that every such `die` precedes the write).
**#227:** two admins (or two tabs) applying at once now land one after the other instead of racing —
`env-set`/`restart`/`recreate` hold one lock on the config dir for their whole run, so a second save
either queues behind the first or, if it can't get the lock within `BOT_OPS_LOCK_WAIT_SECONDS`, comes
back as one of `env-set`'s own refusals above (`bot-ops: env-set: another bot-ops.sh mutation is still
running…`) — which keeps the user's edits exactly like any other `env-set` refusal, the right outcome
for "try again." Any
other failure **re-reads** the page's state from the bot, so only OK is left on the bar (nothing is
pending after the re-read, unless something was typed while it ran — that is kept): a **failed recreate** (a 502 with a JSON body: `.env` was already rewritten,
so the bar shows the compose error and the backup path, issue #47), a **timeout** (504: the outcome is
unknown), any status the page does not know, and a plain-text 502 with no such line — a `set -e` abort
after the write, a kill during the recreate, a proxy's own 502, or a refusal before the write that has no
`env-set` prefix (a failed backup, the self-update guard). A **network error, or the page's own timeout,**
leaves the controls as they are. After a failed or killed recreate `.env` already holds the new values but
the running bot may not: the page has re-read, so nothing is pending and Apply is not offered, but this is
now recoverable from the panel with one click — since #277 the Overview's Restart button itself recreates
(`up -d --force-recreate`, the same action Apply's own recreate step runs), so pressing it finishes a
failed or killed recreate with whatever is currently saved in `.env`. (Where the page kept its edits although the
write happened, after a network error, a retry is answered "Nothing needed applying.": the saved settings
already held them.) The raw `PLUGINS` text field is **not** in the Config editor: plugins are chosen on the
Plugins tab, and two controls for one key would be a conflict with no good answer. Pinning a plugin to a
version (`name@version`) is set in `.env`; an existing pin is kept while that plugin stays ticked. A few
fields render as constrained controls instead of free text:
`AUTO_UPDATE` as a select, `BOT_BRANCH` as a live branch chooser (below), and
`ADMIN_USER_IDS`/`WATCHED_REPOS` as chip/tag editors. Every other key — the static ones and each
plugin's manifest keys alike — is a plain text input whose required-ness and format come
from `GET /api/env-schema` (`bot-ops.sh env-schema`, #205/#207), so a blank required key or a value
`env-set` would reject is refused before anything is sent (the bar names the field, marks it and opens its
tab) rather than after a failed, restart-triggering apply. A plugin that needs a richer control (the wow plugin's region-filtered
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

**The Plugins tab (one accordion card per plugin, #244)** lists every plugin the Plugin Index offers
alongside what this instance has installed. `GET /api/plugins` builds the view server-side: it merges
the raw Plugin Index (fetched from `PLUGIN_INDEX_URL` — read on demand from the mounted `.env` like
`GITHUB_REPO`, defaulting to the bot's own index when unset — so an edit is picked up without
recreating the admin service, cached ~5 min) with the bot's installed state (`bot-ops.sh status`'s
`plugins`) and the current `PLUGINS` value (`env-get`). A card's header shows a badge and a one-line
summary from a fixed priority order: a pending change (turning it on/off, or an edited setting) always
wins, ahead of even an error; then "not in the index", an error, "needs setup" (a missing required
setting), an available update (only while the plugin is ON — an off plugin never gets nudged to update
code that isn't running), running with its command count, enabled-but-not-running, or off.

Opening a card shows three steps. **Turn it on** is the switch — ticking it only adds the plugin's name
to `PLUGINS`; the code is fetched and installed by the bot on its next boot exactly as for a
hand-edited `PLUGINS`, and **this never installs code from the browser**. You can never newly-*enable*
a plugin the index doesn't list (the switch is disabled), but an already-enabled plugin the index has
since dropped stays editable so you can still turn it off. **Choose where it lives (#245)** is placement
— which servers get the plugin's commands, and where it posts on its own — and unlike everything else on
the card it **applies at once, with no restart and no Apply bar**: ticking a server, picking channels or
a post target sends `POST /api/routing` a couple of seconds after you stop typing (several quick changes
in a row become one request, not several), and the step shows *Applying…* then either *Live* or the
reason it wasn't (the bot's own refusal, verbatim; or, once the request landed, whichever of the ticked
servers Discord didn't actually register commands in, and why). This step is read-only, and says so,
whenever the panel's picture of what servers the bot is in is missing or more than an hour old — better
than guessing. A server the bot has since left stays listed (so you can see it was there) but is dropped
from anything you send. **Fill in its settings** draws one field per
setting the plugin's manifest declares: a setting owned by the core config (or, if two plugins declare
the same key, by whichever is first in the index) points you at where it's actually edited instead of
duplicating the field; a secret shows only `•••••••• Saved on the server` and a **Replace** button once
one is set (its value is never shown again, never sent anywhere but the one save, and can be replaced
but not blanked from here); a setting the bot hasn't published a validation rule for yet (it can lag
the index by up to ~15 minutes after a fresh install) can't be edited from the card until it has.

**Nothing on a card saves on its own, except where it lives** — nothing else has since #257 replaced the
plugin/config Save buttons with one bar; where a plugin lives is the one deliberate exception (#245),
since it takes effect immediately and there's nothing to restart into. The switch, the settings and the
secrets are all just controls the **Apply bar**
at the bottom of the page reads: it collects every pending change across every card and the Config
editor and sends them as **one** `POST /api/env` (`PLUGINS` first, preserving any `name@version` pin a
still-ticked plugin already had, ordered by the manifest, then every changed setting and secret), so
one restart covers everything you touched. The recreate it triggers is the restart that loads the
change; a removed plugin's stored data files are left untouched. Typing in one card survives opening or
closing another, or an update button's own reload elsewhere on the tab — only **Discard**, or an Apply
attempt that actually lands (a success, or a failure that re-baselines), drops what you typed. If the
Plugin Index can't be fetched, the tab shows an "index unavailable" notice and still lists the
installed plugins (so you can still turn one off) rather than failing — the `/api/plugins` route
degrades to a `200` with an `indexError`, never a hard error, and a card's settings step says so instead
of showing fields it can't validate. If the bot's own state can't be read (`status`/`env-get` failed —
e.g. a docker hiccup), the route sets a `stateError` instead and every switch is **disabled**, since an
empty selection read back under failure would otherwise let an apply wipe the real `PLUGINS`.

**A Servers tab, a Needs-attention list, and pickers instead of pasted ids (#246).** The page has four
tabs: Overview, Plugins, **Servers**, and Settings. The **Servers tab** shows one card per server the bot
is currently in: whether its commands are live (with the count and when), refused by Discord (with a
**Re-invite the bot** link and a **Try again**), never registered there yet (**Try again**), or — outside
routed mode — the quiet single-mode line that isn't a problem; which plugins live there, placed or "lives
here by default"; and its webhooks, each with a **Remove**. An **Add a webhook** field pastes a Discord
webhook URL — it is cleared from the field the instant you press Add, whatever happens next, and never
shown again; the bot asks Discord which channel it actually posts to, and that channel is where the
webhook shows up. **Try again** re-sends the saved placement of the first placed plugin whose servers the
bot can *all* still see — a genuine no-op that re-runs the bot's per-server command registration without
changing `routing.json`; a plugin placed first is deliberately skipped when it still names a server the
bot has left, since re-sending would drop that placement. When no placed plugin qualifies, a note stands
in for the button and says why: routing data is stale (refresh Discord first), a placement names a server
the bot has left (use **Drop now** on that plugin's card first), or nothing is placed at all (restart the
bot to retry).
A toolbar **Refresh from Discord** re-reads what the bot can currently see, and **Copy invite link** puts
the bot's own invite URL on your clipboard (or shows it in a field to copy by hand). One card per server
routing or a webhook still names but the bot has since left stays listed, read-only, until its placement
next changes. The **Needs-attention list**, first on Overview, is a standing summary of what's worth
looking at: a plugin missing a required setting, a required core setting left blank, a server that refused
the bot's commands, a server whose commands never registered, a webhook that stopped working, a home
server the bot isn't in, or a deployment file out of date — each with a button to the right tab or card,
or "Nothing needs attention." when there's nothing to say. It's derived fresh every time, never stored.
**`DISCORD_SERVER_ID`, `ANNOUNCE_CHANNEL_ID` and `RELEASE_ANNOUNCE_CHANNEL_ID` are pickers, not pasted
ids**, once the panel has a recent-enough picture of what the bot can see: a server or channel dropdown by
name (`DISCORD_SERVER_ID` is the **home server** — where a plugin nobody has placed lives and registers
its commands; blank registers those commands globally, which can take about an hour to appear) instead of
a raw snowflake, grouped by server for a channel picker, and a channel the bot can't post in says so right
in its own option. They write the exact same key and value a pasted id would, so nothing about the Apply
bar changes. Without a recent picture of the bot's servers (or before the panel has one at all), all three
fall back to the plain id field, upgrading to the picker in place — keeping whatever you'd already typed —
once discovery is ready. A picker is never downgraded back to the plain field once it has been shown, even
if discovery later goes stale: it keeps a control the operator may be mid-edit on rather than swapping it
out, and an id the bot can no longer see stays as its own selected option.

**Driving an available update (#105).** A card whose plugin is ON and has a newer release than the one
installed grows an update-action area (#225: an off plugin's card still shows its installed version,
never an update badge or these actions — it isn't running, so there's nothing to nudge): a **What
changed** block (the release notes for each version
newer than installed, from the index), **Update now** and **Schedule** (a date/time picker) *when the
update is host-API-compatible with this bot*, and **Remind me in 7 days** and **Skip this version**
*always* (you can still silence or snooze a version you can't yet install); a **Cancel scheduled
update** button appears once one is scheduled. Each button `POST`s a
small request to `POST /api/plugins/request` — `{action, plugin, version?, at?, days?}` — which
Origin-guards and schema-validates it (the same anchored `plugin`/`version` rules `bot-ops.sh` and
the bot enforce, so a bad or hostile body is a `400` here), then sets `requestedBy` from the
**Cloudflare Access identity that made the request, never anything in the body** (`email:<addr>`, or
`token` on the bearer path), and shells `bot-ops.sh plugin-request` to drop the file in the mailbox.
The bot applies it within seconds (its mailbox timer; the 60s tick is the backstop) exactly as it does a `/plugins` command — an
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
