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
router's `HTTP_PORT` (#220) — all `RESERVED_KEYS`, #278), or that act on the core's own outbound calls or on a tool it spawns — both
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
  `SHARDING_MANAGER_MODE`, #278; the HTTP router's `HTTP_PORT`, #220), and the variables that act on the core's own outbound calls or on a
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
