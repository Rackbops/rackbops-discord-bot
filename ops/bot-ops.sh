#!/usr/bin/env bash
#
# bot-ops.sh — the ONLY privileged surface for the Warbandeer bot admin panels (debug or prod).
#
# The desktop Ops panels (apps/warbandeer-desktop, and roshne's wow-companion) never run docker or
# edit the bot's .env themselves: they invoke this script over SSH, one subcommand at a time, and
# pass BOT_OPS_PROJECT / BOT_OPS_CONTAINER to pick which bot. Keeping the whitelist and the apply
# logic here — versioned and reviewable — means bot secrets never leave the box, and the panels can
# only do the fixed set of operations below.
#
# Subcommands:
#   status        Print JSON: container running?, status line, image, realm status.
#   logs [N]      Print the last N (default 200, max 5000) container log lines, raw.
#   restart       Restart the bot process in place (docker compose restart). No env reload. SSH-only
#                 since #277: the admin panel's Restart button calls recreate instead.
#   recreate      `up -d --force-recreate` so the bot picks up whatever is currently in .env, without
#                 changing any key first — the same recreate env-set itself does after a save, so a
#                 recreate a previous env-set started but the panel never saw finish (a kill, a 504)
#                 can be re-attempted from the panel with no new value submitted (#277).
#   env-get       Print JSON of the NON-SECRET whitelisted env keys and their EFFECTIVE values —
#                 .env read the way compose's env_file loader reads it (see load_env_values).
#   env-set       Read KEY=VALUE lines from stdin, refuse any key outside the whitelist, diff each
#                 remaining one against the effective value, validate the FORMAT of only the ones
#                 that change, back up .env, apply those changes, then `up -d --force-recreate`.
#                 Holds one lock on the config dir for its whole run (#227) — restart and recreate
#                 hold the same lock, so the three never overlap on one instance; a second mutation
#                 waits up to BOT_OPS_LOCK_WAIT_SECONDS (default 60), then refuses, writing nothing.
#   env-schema    Print JSON: each env-get key's validation, plus a plugin's WRITE-ONLY secret keys as
#                 {secret, isSet} — never a value (#205, #240).
#   routing-get   Print JSON {routing, discovery}: the bot's per-plugin routing record and what it can
#                 see, read from its data dir. A missing or corrupt file is null (#240).
#   plugin-request  Read one request JSON on stdin and queue it for the bot's mailbox — a plugin
#                 update action (#105) or a routing / webhook / discovery action (#240).
#   version       Print JSON: {"schema": N} — this script's BOT_OPS_SCHEMA, so a caller (the admin
#                 panel) can tell an outdated deployed copy from the one it was built against (#173).
#
# Design notes:
#   - The compose project + container come from BOT_OPS_PROJECT / BOT_OPS_CONTAINER (the caller
#     passes them per selected bot) — required, no fallback (issue #41: a monorepo-era default here
#     once silently targeted a project/container no real deploy produces). The project MUST be
#     passed with `-p` because it is NOT set in a non-interactive SSH shell's environment — a bare
#     `docker compose` would default to the directory name and miss the running container. (Learned
#     the hard way.) Both are validated to a safe charset since they're interpolated into docker
#     commands.
#   - BOT_OPS_CONFIG_DIR (holds .env + backups/) and BOT_OPS_COMPOSE_FILE (the deployed
#     docker-compose.yml) are two independent, required inputs — no derived guessing between them.
#     They differ under the current layout: the compose file lives under /opt/stacks/<name>/ (so
#     Dockge manages it), while .env lives under /opt/rackbops-discord-bot/<instance>/ (config dir
#     stays outside any git checkout — see ops/README.md). Neither is set here — a caller (a panel,
#     or you by hand) must always pass both; there is no repo-relative fallback.
#   - CORE secrets (DISCORD_TOKEN, GITHUB_TOKEN, ADMIN_TOKEN, the Cloudflare tunnel / Access keys, ...)
#     are deliberately absent from ALLOWED. env-get never reads them out; env-set never writes them.
#     Edit those by hand with nano on the box. A PLUGIN-declared secret key (the Plugin Index marks
#     it `secret: true` — e.g. the wow plugin's BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET) is
#     different, on purpose (ADR-0006 decision 8): env-set may WRITE it, and nothing ever reads it
#     back — env-get never lists it, env-schema says only that it exists and whether it is set, and
#     no output, error or log line this script writes itself carries its value. (The text it does not
#     write is `docker compose`'s, which env-set relays as `log` and restart relays as its output: a
#     message about the env file is withheld whole, and anything else is scrubbed, best effort, of what
#     env-get would not print, core credentials included — see relay_tool_output.)
#   - env-set rebuilds .env line-by-line (no sed) so a value can never inject into the file, and
#     comment/blank/secret lines are preserved verbatim. An indented or `export`ed line for a key
#     being changed is rewritten in place as plain `KEY=`.
#   - env-set diffs BEFORE it validates a value's FORMAT, and validates only what changes (issue
#     #44) — whitelist MEMBERSHIP is still checked for every submitted key regardless. Format-
#     validating every submitted line first meant one stored value the bot accepts but a regex
#     here rejects failed every save that echoed it back, naming a key the operator never touched.
set -euo pipefail

# #173: bumped in the SAME PR whenever a subcommand or an ALLOWED_SPEC row is added or changed — the admin panel (ops/admin/server.ts's REQUIRED_BOT_OPS_SCHEMA, hand-mirrored and
# drift-pinned by a test) compares this against its own copy at startup, so a deployed instance
# whose bin/bot-ops.sh has drifted behind the panel image it's paired with shows up as a loud,
# visible warning instead of a generic "bot-ops: usage: ..." failure the next time someone clicks
# a button the old script doesn't have (the #173 incident: Update now failed on debug because
# install.sh hadn't been re-run since #121 added plugin-request).
# 2: adds env-schema (#205).
# 3: adds routing-get, the four routing / webhook plugin-request actions, and write-only plugin
#    secret keys (#240, ADR-0006).
# 4: a plugin's env keys are listed and editable whether or not the plugin is in PLUGINS, so one
#    env-set can turn a plugin on and configure it (#256).
# 5: adds recreate (#277).
readonly BOT_OPS_SCHEMA=5

die() { echo "bot-ops: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found on the box"; }

cmd_version() {
  need jq
  # #178: composeSchema is read straight from $BOT_OPS_COMPOSE_FILE's own x-rackbops-schema: line —
  # NOT the $COMPOSE_FILE local below, which isn't resolved until AFTER version's early dispatch —
  # ONLY when that path is set and the file exists, so this stays precondition-free (#173 round 3).
  # An unset var, a missing file, or a missing/malformed x-rackbops-schema line are ALL the same
  # `composeSchema: null`, never an error — this must never crash regardless of what state the
  # instance's compose file is in.
  local compose_schema="" raw_compose_file
  raw_compose_file="${BOT_OPS_COMPOSE_FILE:-}"
  if [ -n "$raw_compose_file" ] && [ -f "$raw_compose_file" ]; then
    compose_schema="$(grep -m1 '^x-rackbops-schema:[[:space:]]*[0-9]\+[[:space:]]*$' "$raw_compose_file" 2>/dev/null | grep -o '[0-9]\+' || true)"
  fi
  # #173: stdout JSON only, same convention as status/env-get — the panel's runBotOps reads this
  # subcommand's stdout as JSON, so a stray non-JSON line here would break the same way a stray
  # stdout line already breaks env-get/status (#101).
  if [ -n "$compose_schema" ]; then
    jq -n --argjson schema "$BOT_OPS_SCHEMA" --argjson composeSchema "$compose_schema" '{schema: $schema, composeSchema: $composeSchema}'
  else
    jq -n --argjson schema "$BOT_OPS_SCHEMA" '{schema: $schema, composeSchema: null}'
  fi
}

# #173 round 3: `version` is dispatched HERE — before ANY of the BOT_OPS_PROJECT/CONTAINER/
# CONFIG_DIR/COMPOSE_FILE/.env preconditions below — deliberately reversing the original design
# ("version is a subcommand like any other, it still needs those set"), which review caught live:
# with that ordering, a genuinely CURRENT script pointed at a bad instance config (an unset or
# wrong BOT_OPS_CONFIG_DIR, a missing .env) failed `version` with an instance-config error, and the
# panel's decideBotOpsSchema classified that identically to a real pre-#173 script's drift — an
# operator was told to re-run install.sh for a problem that had nothing to do with the script being
# out of date. `version` needs only `jq` — no docker, no config dir, no compose file — so checking
# it first is what actually decouples "is this script current" from "is this instance configured
# right": now only a genuine schema mismatch or a pre-stamp script's usage error (main()'s `*)`
# fallback below, reached only because an old script has no `version` case at all) is ever reported
# as out of date. See CONTEXT.md's #173 gotcha for the full incident.
if [ "${1:-}" = "version" ]; then
  cmd_version
  exit 0
fi

# Target bot: no fallback to the monorepo-era name — a panel (or you, by hand) must always pass
# both per the selected target (debug/prod), the same "no repo-relative fallback" rule as
# CONFIG_DIR/COMPOSE_FILE below. A default here once silently pointed a var-less invocation (or
# ops/README.md's own "run directly on the box" example) at a project/container no install.sh
# deploy actually produces (issue #41).
PROJECT="${BOT_OPS_PROJECT:-}"
[ -n "$PROJECT" ] || {
  echo "bot-ops: BOT_OPS_PROJECT not set — point it at the instance's compose project (e.g. rackbops-discord-bot-debug)" >&2
  exit 1
}
CONTAINER="${BOT_OPS_CONTAINER:-}"
[ -n "$CONTAINER" ] || {
  echo "bot-ops: BOT_OPS_CONTAINER not set — point it at the instance's container name" >&2
  exit 1
}
LOGS_MAX=5000

[[ "$PROJECT" =~ ^[A-Za-z0-9_.-]+$ ]] || {
  echo "bot-ops: invalid BOT_OPS_PROJECT" >&2
  exit 1
}
[[ "$CONTAINER" =~ ^[A-Za-z0-9_.-]+$ ]] || {
  echo "bot-ops: invalid BOT_OPS_CONTAINER" >&2
  exit 1
}

# Config dir (.env + backups/) and the deployed compose file are independent, required inputs —
# see the design note above. No fallback to this script's own location: that assumption broke
# once the compose file (Dockge-managed, /opt/stacks/) and the config dir (outside any checkout,
# /opt/rackbops-discord-bot/) stopped being the same directory.
CONFIG_DIR="${BOT_OPS_CONFIG_DIR:-}"
[ -n "$CONFIG_DIR" ] || {
  echo "bot-ops: BOT_OPS_CONFIG_DIR not set — point it at the instance's config dir (holds .env + backups/)" >&2
  exit 1
}
COMPOSE_FILE="${BOT_OPS_COMPOSE_FILE:-}"
[ -n "$COMPOSE_FILE" ] || {
  echo "bot-ops: BOT_OPS_COMPOSE_FILE not set — point it at the deployed docker-compose.yml" >&2
  exit 1
}

# Absolute only. A relative path resolves against whatever cwd this was invoked from, which for a
# maintainer running it out of a clone is the checkout itself — `env-set` would then rewrite the
# checkout's own .env and drop backups/.env.bak.* (a live token) beside it. .gitignore covers those
# two, but not admins.json, which the panel writes into the same directory. Deployed invocations
# are always absolute (install.sh writes /opt/... into the stack .env), so this rejects only the
# hand-run mistake. `src/storage.ts` documents BOT_OPS_CONFIG_DIR as absolute-only and cites it as
# the precedent for BOT_DATA_DIR's own guard — until now that was a claim about a rule nothing
# enforced.
for var in BOT_OPS_CONFIG_DIR BOT_OPS_COMPOSE_FILE; do
  case "${!var}" in
    /*) ;;
    *)
      echo "bot-ops: $var must be an absolute path, got \"${!var}\"" >&2
      exit 1
      ;;
  esac
done
ENV_FILE="$CONFIG_DIR/.env"

# Non-secret keys the panel may read and write, ONE ordered spec (#133) — order and membership are
# a single source, so they can't drift by construction. Anything not here is rejected by env-set
# and omitted by env-get. Each entry is "KEY|regex" (empty string is always allowed — it clears the
# key back to its documented default) EXCEPT the keys named in REQUIRED below, which have no
# default to clear back to. A plain indexed array, not an associative one, on purpose: bash does
# not preserve an associative array's insertion order (hash-bucket order instead), which is exactly
# why an earlier version of this file carried a second, hand-maintained order array alongside
# ALLOWED — and why the two could (and, per issue #133, did) drift apart. `ALLOWED` and
# `ENV_KEY_ORDER` below are now DERIVED from this once, at load, rather than declared by hand —
# every `${ALLOWED[$key]}` regex lookup elsewhere in this file is unchanged; only where ALLOWED and
# its display order come from moved.
ALLOWED_SPEC=(
  'DISCORD_SERVER_ID|^[0-9]{5,25}$'
  'ANNOUNCE_CHANNEL_ID|^[0-9]{5,25}$'
  'RELEASE_ANNOUNCE_CHANNEL_ID|^[0-9]{5,25}$'
  'REPORT_ROLE_ID|^[0-9]{5,25}$'
  'ADMIN_USER_IDS|^[0-9]{5,25}(,[0-9]{5,25})*$'
  # WOW_REALM / WOW_REGION / DMF_TIMEZONE were static rows here until #107 moved the WoW features into
  # @rackbops/plugin-wow. They are the wow plugin's manifest env keys now, merged into this whitelist at
  # runtime by load_plugin_keys (the same #101 path WARBANDEER_INGEST_PORT uses) — validated with the
  # FORMAT the Plugin Index carries, so their regexes live in the plugin's package.json, not here.
  'WATCHED_REPOS|^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)*$'
  'AUTO_UPDATE|^(true|false)$'
  'BOT_BRANCH|^[A-Za-z0-9._/-]{1,100}$'
  'COMMAND_PREFIX|^[a-z0-9_-]{1,20}$'
  # `PLUGINS=` selects which plugins to install (operator-controlled, panel-edited): a bare `name`
  # or `name@version` to pin, comma-separated; empty = no plugins. The manifest-declared env keys of
  # every plugin in the cached index (whether or not it is named here, #256) are merged into this
  # whitelist at runtime by load_plugin_keys, so a plugin's own key (e.g. WARBANDEER_INGEST_PORT, a
  # static row here until #100 removed the baked-in connector) is validated with the FORMAT the Plugin
  # Index carries rather than hand-mirrored per plugin. `name` is `^[a-z][a-z0-9-]*$` (registry.ts); the `@version` tail allows any npm range char.
  'PLUGINS|^[a-z][a-z0-9-]*(@[0-9][0-9A-Za-z.+-]*)?(,[a-z][a-z0-9-]*(@[0-9][0-9A-Za-z.+-]*)?)*$'
  # Where the bot fetches the Plugin Index from: an http(s) URL, a file:// URL, or a bare absolute
  # path (config.ts accepts all three; empty clears back to the published default).
  'PLUGIN_INDEX_URL|^(https?://[^[:space:]]+|file://[^[:space:]]+|/[^[:space:]]+)$'
)

# Derived once, here, from ALLOWED_SPEC above — never hand-declared. Split on the FIRST "|" only
# (AUTO_UPDATE's and PLUGIN_INDEX_URL's regexes both DO contain "|" today, as alternation — the
# split still cuts at the first "|", the one separating the key from its regex, leaving every later
# "|" alone as part of the regex value): ALLOWED is the KEY->regex lookup every validation site
# below already expects;
# ENV_KEY_ORDER is env-get's display order, in the exact sequence ALLOWED_SPEC lists — named to
# match PLUGIN_KEY_ORDER's own convention below.
declare -A ALLOWED=()
ENV_KEY_ORDER=()
build_allowed_from_spec() {
  local spec key
  for spec in "${ALLOWED_SPEC[@]}"; do
    key="${spec%%|*}"
    ALLOWED["$key"]="${spec#*|}"
    ENV_KEY_ORDER+=("$key")
  done
}
build_allowed_from_spec

# Keys env-set must refuse to blank — the exception to ALLOWED's "empty string is always allowed"
# rule above. A parallel set, not a stricter ALLOWED regex, because ALLOWED's regex is a FORMAT
# check applied only when a value is non-blank; these keys instead have no documented default for
# an empty value to clear back to (config.ts's resolveConfig throws `required(...)` on them at
# startup — issue #45's ANNOUNCE_CHANNEL_ID crash-loop). Checked against every other ALLOWED key's
# resolveConfig handling before adding one here: everything else either has a real default or is
# genuinely optional.
declare -A REQUIRED=(
  [ANNOUNCE_CHANNEL_ID]=1
)

# Keys the DEPLOYMENT and the bot CORE own, that a Plugin Index manifest may never make editable or
# listable, whether it declares the key secret or not. Three groups:
#   1. core credentials and access control (#240): a plugin-declared secret key became writable, and a
#      manifest that named DISCORD_TOKEN (by mistake, or through a compromised index entry) would
#      otherwise have made the panel able to overwrite it — the one thing "core secrets stay
#      uneditable" forbids.
#   2. the rest of what docker-compose.yml interpolates (#240): the stack's own paths and names.
#   3. settings the bot CORE process reads that the panel deliberately does not edit (#278): a careless
#      manifest must not be able to turn the repo self-update targets, the plugin registry, the data
#      directory, the runtime mode or discord.js's sharding into a field on a plugin's card, and since
#      #256 an index entry needs no enabled plugin to do that. Some are set by the bot's own redeploy
#      machinery or by docker, and four are read by the discord.js Client the core builds with no shard
#      options, but every one is read from the environment, so a `.env` line would reach it.
# load_plugin_keys drops these on the way in. Pinned by ops/bot-ops.test.ts against .env.example's
# credential-shaped keys, every ${VAR} docker-compose.yml interpolates, every key documented in
# .env.example (each is editable, reserved, or a named plugin-owned setting) and the variables the bot
# core's source reads through the forms the test's scan knows (each is editable or reserved), so a new
# core key that is not decided here fails a test rather than staying claimable by manifest.
#
# A credential a first-party PLUGIN owns is deliberately NOT here: the wow plugin's
# BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET are read by that plugin alone (nothing in the bot core
# does), its Plugin Index entry declares both `secret: true`, and being panel-settable and write-only
# is exactly what ADR-0006 decision 8 is for. The test pin names them in an explicit exemption list
# and checks each sits under .env.example's "Used by the <plugin> plugin" block.
declare -A RESERVED_KEYS=(
  # Group 1 (#240): core credentials and access control.
  [DISCORD_TOKEN]=1
  [GITHUB_TOKEN]=1
  [ADMIN_TOKEN]=1
  [CLOUDFLARE_TUNNEL_TOKEN]=1
  [CLOUDFLARE_ACCESS_TEAM_DOMAIN]=1
  [CLOUDFLARE_ACCESS_AUD]=1
  [ADMIN_ALLOWED_EMAILS]=1
  # Group 2 (#240): the rest of what docker-compose.yml interpolates.
  [BOT_BUILD_CONTEXT]=1
  [ADMIN_BUILD_CONTEXT]=1
  [BOT_ENV_FILE]=1
  [GIT_SHA]=1
  [BOT_OPS_CONTAINER]=1
  [BOT_OPS_PROJECT]=1
  [BOT_OPS_CONFIG_DIR]=1
  [BOT_OPS_COMPOSE_FILE]=1
  # Group 3 (#278): read by the bot core process, not edited by the panel.
  [GITHUB_REPO]=1              # src/config.ts: the repo self-update and release polling anchor to
  [PLUGIN_REGISTRY_URL]=1      # src/plugins/install.ts: where plugin bundles are downloaded from
  [BOT_DATA_DIR]=1             # src/storage.ts: the bot's data directory
  [NODE_ENV]=1                 # src/storage.ts: `test` makes an unset BOT_DATA_DIR a boot error
  [HANDOFF_FROM]=1             # src/handoff.ts: the raw standby instruction, set by the redeploy machinery (#46 checks the named container)
  [HANDOFF_RESTART_POLICY]=1   # src/redeploy.ts: the original's restart policy, carried to the replacement
  [HOSTNAME]=1                 # src/docker.ts: the bot's own container id, set by docker
  [SHARDS]=1                   # discord.js Client (src/client.ts builds it with no shard options): the shards it serves
  [SHARD_COUNT]=1              # discord.js Client: the shard count
  [SHARDING_MANAGER]=1         # discord.js Client: makes client.shard a ShardClientUtil
  [SHARDING_MANAGER_MODE]=1    # discord.js Client: that util's mode
)

# A self-update (nazumods/wow#879) briefly runs the replacement alongside the original under
# "<container>-next" before it takes the canonical name over. Recreating or restarting the
# ORIGINAL while that container exists races retireOriginal's own stop/remove/rename and can leave
# two bots alive on the shared token (issue #51 item 5) — refuse outright rather than risk it; the
# operator can just retry once the swap finishes (usually well under a minute).
#
# The "-next" container's mere EXISTENCE is not enough on its own to decide THAT, in either
# direction:
#   - Too EARLY a signal misses the pre-verification window (up to VERIFY_DEADLINE_MS, ~90s) where
#     "-next" already exists but hasn't written anything yet — an env-set force-recreate landing
#     there would recreate the untouched original under a brand-new container id, orphaning the
#     replacement's own HANDOFF_FROM reference; retireOriginal then 404s on that stale id, treats
#     it as "already gone" (its documented tolerant path), and skips the rename WITHOUT throwing —
#     so the replacement still goes live. Two live bots, and the recreated one is still on the OLD
#     image (:latest isn't retagged until takeOver verifies).
#   - Too LATE a signal (checked only via a marker file, tried and reverted once already) means the
#     container's existence outlives the marker: retireOriginal tolerates its own post-stop
#     remove/rename failing (a stopped original corpse still holding the canonical name, or the
#     resulting name conflict) and never retries — "cosmetic," per its own comment, since the bot
#     is up and serving either way. Guarding on a marker that's already been cleared by then would
#     wrongly allow past that safe point, but guarding on one that hasn't been WRITTEN yet wrongly
#     refuses nothing during the dangerous window above — no single read of that file can tell the
#     two apart, since both look identical (absent) from outside.
#
# What actually distinguishes "still unresolved" from "resolved, rename just didn't stick" is
# whether the ORIGINAL itself is still running. It stays running for the entire pre-verification
# wait and the entire verified-but-not-yet-retired wait (nothing has touched it yet in either), and
# retireOriginal's own comment calls its stop "the point of no return" — every step after that
# (remove, rename) is best-effort and non-fatal on failure. So: refuse only while "-next" exists
# AND the canonical name still resolves to a RUNNING container. A narrow gap remains between that
# stop and the remainder of the cleanup finishing (typically milliseconds — two more daemon calls)
# where this allows through; unlike the window above, both containers agree on the SAME already-
# verified image there (tagLatest runs before the stop), so the worst case is a brief, self-
# resolving overlap rather than a stale-code split-brain — the same class of accepted residual risk
# as issue #51's own item 1.
#
# Formerly a known, DECLINED residual risk (tracked on #85, now HANDLED by #160, not by this
# guard): retireOriginal's own stopContainer call on a genuine first attempt used to be unguarded
# — if the daemon actually stopped the original but the HTTP response was lost in transit (the
# exact scenario takeOver's own comment names), that throw crashed the REPLACEMENT process rather
# than completing the swap, which could leave the crashed replacement mid-reboot (a real Bun
# process + gateway reconnect, low seconds) while `docker ps` already read the original as safely
# gone — a window where an env-set landing here could still produce a genuine two-live-bots
# outcome. #160 closed it at the source: retireOriginal now re-inspects the original on any stop
# throw and proceeds (rather than crashing) once it's confirmed down, so a lost-in-transit response
# no longer crashes the replacement at all — see CONTEXT.md's matching gotcha. #160 also stops
# Docker's OWN restart policy from resurrecting an unverified standby (the other half of #85), so
# this guard's own signal (`-next` exists + the canonical name still running) is no longer racing
# either failure mode it used to.
guard_no_handoff_in_progress() {
  docker ps -a --filter "name=^/${CONTAINER}-next$" --format '{{.Names}}' 2>/dev/null | grep -q . || return 0
  if docker ps --filter "name=^/${CONTAINER}$" --format '{{.Names}}' 2>/dev/null | grep -q .; then
    die "a self-update is in progress (container '${CONTAINER}-next' exists and '${CONTAINER}' is still running) — try again once it completes"
  fi
}

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
  # MUTANT 2 (CI-only): dropped the bounded wait — an unbounded flock blocks forever instead of refusing
  flock 9 \
    || die "$sub: another bot-ops.sh mutation is still running on this instance (waited ${LOCK_WAIT_SECONDS}s) — try again"
}

# One .env definition line: optional indentation, an optional `export ` prefix, the key, `=`, the
# raw value. Shared by load_env_values (which reads .env) and cmd_env_set's rewrite (which
# replaces lines in it), so the two can never disagree about which lines define a key.
readonly ENV_LINE_RE='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$'

# The effective value of every key in .env, read ONCE per invocation into ENV_VALUES the way
# compose's `env_file:` loader reads the same file — checked against `docker compose config`
# (Compose 2.40) on the box, issue #44 — so env-get shows, and env-set diffs against, what the
# bot is actually running with:
# ops/admin/server.ts's parseEnvValue mirrors these same rules for the keys the panel reads itself (#195).
#   - the LAST occurrence of a key wins (the old `grep -m1` took the first);
#   - an `export KEY=...` line defines KEY, indented or not (both used to be invisible);
#   - surrounding whitespace is trimmed — which also drops a CRLF-saved file's trailing "\r",
#     previously leaked into every value;
#   - then ONE layer of matching "..." or '...' is stripped. An unterminated quote is left as-is:
#     compose refuses to load such a file at all ("unterminated quoted value"), so raw is the
#     honest reading, and saving that key rewrites it unquoted — which repairs the file.
# Deliberately NOT modelled, though compose does these too: an inline ` # comment`, `${VAR}`
# interpolation, whitespace around the `=`, a `KEY: value` colon separator, and backslash escapes
# inside double quotes. Apart from PLUGIN_INDEX_URL (a URL, so it admits `:`, `#` and `$`), no STATIC
# ALLOWED regex admits `#`, `$`, `:`, `\`, or whitespace, so nothing env-set writes for those keys can
# produce them; a hand-edit that does shows raw in the panel and normalises on the next save of that
# key, as before. A PLUGIN key's own manifest `format` can admit them (the shipped wow client keys use
# `^\S+$`, which allows `#`, `$`, `\` and quotes) — but env-set refuses a `$` or a quote in ANY key's
# value, because compose acts on those (see the guard in cmd_env_set), and writes a `#` or `\`
# verbatim; this script's own stored/compared reading of a value stays the raw text.
# A bash `read` loop rather than grep on purpose: Git Bash's grep drops "\r" silently, which
# would let the CR handling pass its test on a Windows dev box even with the trim deleted.
declare -A ENV_VALUES=()
load_env_values() {
  ENV_VALUES=()
  [ -f "$ENV_FILE" ] || return 0
  local line val
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ $ENV_LINE_RE ]] || continue
    val="${BASH_REMATCH[3]}"
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    if (( ${#val} >= 2 )); then
      case "$val" in
        \"*\" | \'*\') val="${val:1:${#val}-2}" ;;
      esac
    fi
    ENV_VALUES["${BASH_REMATCH[2]}"]="$val"
  done < "$ENV_FILE"
}

# Effective value of a key (empty if unset/absent) — from ENV_VALUES, so load_env_values first.
env_value() {
  printf '%s' "${ENV_VALUES[$1]-}"
}

# Container paths to the bot's plugin bookkeeping, read the same docker-exec way cmd_status reads
# the bot's own state.json. The cached Plugin Index is the WRAPPER src/plugins/index.ts writes —
# `{ writtenAt, index: { …, plugins: [...] } }` — so the manifest lives at `.index.plugins`, NOT a
# bare top-level `.plugins`. The state file (PluginStateFile) is a DIFFERENT shape whose plugin
# array IS top-level `.plugins`; it is also a different file from the bot's `/app/data/state.json`.
readonly PLUGIN_INDEX_PATH='/app/data/plugins/index.json'
readonly PLUGIN_STATE_PATH='/app/data/plugins/state.json'
# The two files routing-get reads (ADR-0006): the bot's routing record and what it can see. The
# bot's webhook store is deliberately not among them, and this script never opens it.
readonly ROUTING_PATH='/app/data/routing.json'
readonly DISCOVERY_PATH='/app/data/discovery.json'

# The env keys EVERY plugin in the bot's cached Plugin Index declares, whether or not that plugin is
# in PLUGINS (#256) — merged into env-get's listing and env-set's whitelist so the panel manages a
# plugin's own keys (e.g. WARBANDEER_INGEST_PORT) without this script hand-mirroring each plugin, and
# so a plugin can be turned on and configured in ONE save. A key of a plugin that is off is inert until
# the plugin is on. Manifest order is preserved (PLUGIN_KEY_ORDER); PLUGIN_FORMAT / PLUGIN_REQUIRED
# carry each key's validation.
#
# A `secret` key is tracked in a SEPARATE set (PLUGIN_SECRET_*) and never enters PLUGIN_KEY_ORDER /
# PLUGIN_FORMAT / PLUGIN_REQUIRED (#240, ADR-0006 decision 8): those are what env-get lists, so
# keeping the secret keys out of them is what makes it structurally impossible for env-get to emit
# one. A secret key is never listed and never read back, but env-set may write it.
PLUGIN_KEY_ORDER=()
declare -A PLUGIN_FORMAT=()
declare -A PLUGIN_REQUIRED=()
PLUGIN_SECRET_ORDER=()
declare -A PLUGIN_SECRET_FORMAT=()
declare -A PLUGIN_SECRET_REQUIRED=()
# Every key ANY plugin in the index declares secret: such a key is never listed as a plain one,
# whichever plugin declares it plain. (PLUGIN_SECRET_FORMAT is the editable subset: the keys of usable
# entries.)
declare -A PLUGIN_SECRET_ANY=()
# "ok", or "index unavailable" (the bot isn't running or hasn't cached the index yet — env-get then
# shows static keys only, never errors).
PLUGIN_KEYS_STATUS="ok"

# Populate PLUGIN_KEY_ORDER / PLUGIN_FORMAT / PLUGIN_REQUIRED (the listable, editable plain keys) and
# PLUGIN_SECRET_* (the editable secret keys) from the container's cached index — from EVERY plugin in
# it, not only the ones named in this instance's PLUGINS value (#256): the index, not PLUGINS, decides
# which keys are plugin keys, and a key of a plugin that is off is inert until the plugin is on. (When
# two plugins declare the same key, the FIRST declaration in index order governs it, on or off.) That
# is what lets one env-set turn a plugin on AND set its settings; and env-get, env-schema and env-set
# all read the keys through this one loader, so they can never disagree about which keys exist. Runs in
# the CURRENT shell — a command/process substitution would lose the globals it sets to a subshell — so
# it reads docker's output into a variable and parses it via a here-string. It always makes ONE
# read-only `docker exec … cat` of the cached index (an instance with no plugins pays that read too,
# and notes "index unavailable" on stderr when the bot has not cached the index yet). A
# missing/unreadable/invalid index is "unavailable", never an error (D3).
load_plugin_keys() {
  PLUGIN_KEY_ORDER=()
  PLUGIN_FORMAT=()
  PLUGIN_REQUIRED=()
  PLUGIN_SECRET_ORDER=()
  PLUGIN_SECRET_FORMAT=()
  PLUGIN_SECRET_REQUIRED=()
  PLUGIN_SECRET_ANY=()
  PLUGIN_KEYS_STATUS="ok"
  local raw rows key format required secret usable
  raw="$(docker exec "$CONTAINER" cat "$PLUGIN_INDEX_PATH" 2>/dev/null || true)"
  if [ -z "$raw" ] || ! printf '%s' "$raw" | jq -e . >/dev/null 2>&1; then
    PLUGIN_KEYS_STATUS="index unavailable"
    return 0
  fi
  # Each env key as five RAW lines (key, format, required, secret, usable), NOT @tsv: jq's TSV
  # encoder escapes a backslash, which an ERE `format` may legitimately carry (`\.`), and the bash
  # reader would then see it doubled; raw lines pass the regex through verbatim (a `format` never
  # spans lines). `.index.plugins` is the cache wrapper, not a bare `.plugins`.
  #
  # The reader takes exactly five lines per row, so a field that itself held a line break would
  # re-frame every later row — a hostile manifest could then forge a plain row for another plugin's
  # secret key and have env-get list its stored value (#240). So a key holding a CR or LF, or a
  # `format` or `required` doing so (or a `format` that is missing or not a string), makes the entry
  # unusable inside the program, and `secret` is normalised there too: only an absent / null / false
  # `secret` means "not secret", ANY other value (a string, a number, an array) counts as secret —
  # fail closed, never fail open. An unusable entry that CLAIMS secret is not forgotten: it still
  # marks its key secret (a `usable` of "false" and an empty format, so it can never be edited or
  # validated against), otherwise another plugin declaring the same key plain would get it listed.
  # The `usable` column is "true" for a well-formed entry and "false" for that secret-only row (it
  # cannot be dropped to four lines: an empty `format` is a legal well-formed value, so it cannot
  # double as the marker). A key ANY plugin in the index declares secret is secret for every plugin.
  #
  # The `jq -e .` check above only proves valid JSON — NOT that `.index` is an object or that each
  # `.env` element is one (the bot's own isValidPluginIndex checks only `Array.isArray(env)`, so a
  # manifest it accepts and caches can still be wrong-shaped here). Guard both shapes inside the
  # program — a non-object plugin or env entry, or one missing a string key/format, is skipped so the
  # well-formed keys still list — and treat a program error (`.index` being a non-object, which
  # `.index.plugins` can't index) as "index unavailable" via `2>/dev/null` + the `if !`, rather than
  # letting pipefail + set -e abort the whole env-get/env-set. Same posture cmd_status takes for
  # state.json; without it a valid-JSON-but-wrong-shape cached index crashes ops (a D3 violation).
  if ! rows="$(printf '%s' "$raw" | jq -r '
    (.index.plugins // [])
    | map(select(type == "object"))
    | .[]
    | .env[]?
    | select((type == "object") and (.key | type == "string") and (.key | test("[\\r\\n]") | not))
    | (.required // false | tostring) as $req
    | (if (.secret // false) == false then "false" else "true" end) as $sec
    | ((.format | type == "string" and (test("[\\r\\n]") | not)) and ($req | test("[\\r\\n]") | not)) as $wellformed
    | if $wellformed then (.key, .format, $req, $sec, "true")
      elif $sec == "true" then (.key, "", "false", "true", "false")
      else empty end
  ' 2>/dev/null)"; then
    PLUGIN_KEYS_STATUS="index unavailable"
    return 0
  fi
  # Two passes over the same rows (#240). Pass 1 collects the SECRET keys, pass 2 the plain ones, so a
  # key that ANY plugin in the index declares secret is secret everywhere: another plugin declaring the
  # same key non-secret must not get it listed, or env-get would emit a value one manifest called
  # secret. In both passes a key the deployment or the core owns (RESERVED_KEYS) is dropped whatever
  # the manifest says, and a secret key that collides with a static ALLOWED key is ignored (static
  # wins, exactly as for a plain plugin key).
  # jq.exe on a Windows dev box emits CRLF, so each field carries a trailing "\r" that a native
  # Linux jq never adds; strip it (a no-op on Linux) the same way load_env_values strips a
  # CRLF-saved .env — else the key names and the `secret`/`required` flags are all "…\r".
  while IFS= read -r key && IFS= read -r format && IFS= read -r required && IFS= read -r secret && IFS= read -r usable; do
    key="${key%$'\r'}"
    format="${format%$'\r'}"
    required="${required%$'\r'}"
    secret="${secret%$'\r'}"
    usable="${usable%$'\r'}"
    [ "$secret" = "true" ] || continue
    [ -n "$key" ] || continue
    [[ -n "${RESERVED_KEYS[$key]+x}" ]] && continue          # a key the deployment or the core owns: never plugin-editable
    [[ -n "${ALLOWED[$key]+x}" ]] && continue                # a static key: static wins
    PLUGIN_SECRET_ANY["$key"]=1                              # secret for every plugin that declares it
    [ "$usable" = "true" ] || continue                       # an unusable entry's secret claim marks the key, but is never editable
    [[ -n "${PLUGIN_SECRET_FORMAT[$key]+x}" ]] && continue   # a key declared twice: first wins
    PLUGIN_SECRET_ORDER+=("$key")
    PLUGIN_SECRET_FORMAT["$key"]="$format"
    PLUGIN_SECRET_REQUIRED["$key"]="$required"
  done <<< "$rows"
  while IFS= read -r key && IFS= read -r format && IFS= read -r required && IFS= read -r secret && IFS= read -r usable; do
    key="${key%$'\r'}"
    format="${format%$'\r'}"
    required="${required%$'\r'}"
    secret="${secret%$'\r'}"
    # (`usable` is read to consume the row's fifth line but not tested here: an unusable row always
    # carries secret = "true", so the line below already skips it.)
    [ -n "$key" ] || continue
    [ "$secret" = "true" ] && continue                       # a secret key (an unusable row always is one): tracked in PLUGIN_SECRET_*, never here
    [[ -n "${RESERVED_KEYS[$key]+x}" ]] && continue          # a key the deployment or the core owns: never plugin-listable or editable
    [[ -n "${PLUGIN_SECRET_ANY[$key]+x}" ]] && continue      # another plugin declares it secret: secret wins
    [[ -n "${PLUGIN_FORMAT[$key]+x}" ]] && continue          # a key declared twice: first wins
    PLUGIN_KEY_ORDER+=("$key")
    PLUGIN_FORMAT["$key"]="$format"
    PLUGIN_REQUIRED["$key"]="$required"
  done <<< "$rows"
}

cmd_status() {
  need docker; need jq
  local ps_line ps_state status image running realm plugins
  # One `docker ps` covers all three container-metadata fields: its `.State` is the same short
  # word `docker inspect -f '{{.State.Running}}'`/`.State.Status` gave, and `.Image` the same
  # reference `docker inspect -f '{{.Config.Image}}'` gave — so this replaces two `docker inspect`
  # calls, not just reads alongside them. `.Status` (kept as-is) is the human uptime string
  # (ops/admin/public/index.html renders it verbatim as "Container") that `.State` does NOT carry,
  # so it's not dropped as "redundant" the way #59 originally suggested (#59/#143).
  ps_line="$(docker ps -a --filter "name=^/${CONTAINER}$" \
              --format '{{.State}}'$'\t''{{.Status}}'$'\t''{{.Image}}' 2>/dev/null || true)"
  IFS=$'\t' read -r ps_state status image <<<"$ps_line"
  [ "$ps_state" = "running" ] && running=true || running=false
  # Best-effort: the persisted last-observed realm status. Since #107 the wow plugin owns it in its own
  # data/wow.json; fall back to the legacy state.json copy (frozen there) for an instance still on an
  # older bot or not yet running the wow plugin. May be absent on a fresh install.
  realm="$(docker exec "$CONTAINER" cat /app/data/wow.json 2>/dev/null \
            | jq -r '.realmStatus // ""' 2>/dev/null || true)"
  [ -n "$realm" ] || realm="$(docker exec "$CONTAINER" cat /app/data/state.json 2>/dev/null \
            | jq -r '.realmStatus // ""' 2>/dev/null || true)"
  # Best-effort: the plugins the bot recorded after activation (PluginStateFile.plugins — a
  # different file from state.json above). Normalised to a JSON array so --argjson never chokes:
  # an absent/unreadable file, or a `.plugins` that isn't an array, becomes [].
  plugins="$(docker exec "$CONTAINER" cat "$PLUGIN_STATE_PATH" 2>/dev/null \
              | jq -c 'if (.plugins | type) == "array" then .plugins else [] end' 2>/dev/null || true)"
  [ -n "$plugins" ] || plugins='[]'
  jq -n --argjson running "${running:-false}" \
        --arg status "$status" --arg image "$image" --arg realm "$realm" \
        --argjson plugins "$plugins" \
        '{running: $running, status: $status, image: $image, realmStatus: $realm, plugins: $plugins}'
}

cmd_logs() {
  need docker
  local n="${1:-200}"
  # Bounded to 5 digits (max 99999, well over LOGS_MAX) BEFORE the arithmetic comparison below: an
  # unbounded all-digits string like 2^64 wraps in bash's 64-bit `(( ))` context (evaluates as
  # `0 > LOGS_MAX` = false), so the value would sail through uncapped to `docker logs --tail`,
  # which dockerd then treats as "all lines" (issue #53 item 4).
  [[ "$n" =~ ^[0-9]{1,5}$ ]] || die "logs: N must be a number"
  (( n > LOGS_MAX )) && n="$LOGS_MAX"
  docker logs "$CONTAINER" --tail "$n" 2>&1
}

cmd_restart() {
  need docker
  guard_no_handoff_in_progress
  lock_config_dir restart
  # BOT_ENV_FILE is compose-YAML interpolation only (env_file: ${BOT_ENV_FILE:-.env}) — a
  # different mechanism from the container's own runtime env, which env_file: itself supplies
  # once that interpolation resolves.
  # #60 item 2 / #168: name which file this restart is acting on, on stderr — env-get/status's
  # stdout is JSON the panel parses (#101), so a stray stdout line here would be echoed back and
  # rejected the same way.
  echo "bot-ops: env file $ENV_FILE" >&2
  # compose reads .env to restart, and quotes a line it cannot parse; its output is relayed to the panel,
  # so it goes through relay_tool_output, as env-set's `log` does (#240). Captured rather than streamed
  # for that reason -- so someone running this by hand sees compose's output when it has finished, not
  # as it goes (the panel never showed a restart's output before it ended, and shows none of it after a
  # timeout). A failed restart still fails: what is relayed is printed, the exit status is compose's, and
  # "restarted" is not claimed.
  local out rc=0
  out="$(BOT_ENV_FILE="$ENV_FILE" docker compose -f "$COMPOSE_FILE" -p "$PROJECT" restart 2>&1)" || rc=$?
  if [ -n "$out" ]; then printf '%s\n' "$(relay_tool_output "$out")"; fi
  if [ "$rc" -ne 0 ]; then return "$rc"; fi
  echo "restarted $CONTAINER"
}

# #277: `up -d --force-recreate` on its own, with no value submitted first — so a recreate env-set
# started but the panel never confirmed (a kill, a 504) can be finished with one click, and so the
# admin panel's Restart button (which now calls this instead of cmd_restart) always comes back with
# whatever is currently in .env. Shares recreate_bot() with cmd_env_set below, so the two recreates
# can never drift.
cmd_recreate() {
  need docker; need jq
  guard_no_handoff_in_progress
  lock_config_dir recreate
  local rc=0
  recreate_bot || rc=$?
  jq -n --argjson ok "$([ "$rc" -eq 0 ] && echo true || echo false)" --arg log "$RECREATE_LOG" \
        '{ok: $ok, recreated: true, log: $log}'
  return "$rc"
}

cmd_env_get() {
  need jq
  [ -f "$ENV_FILE" ] || die "env-get: $ENV_FILE not found"
  # #133: ALLOWED and ENV_KEY_ORDER are both derived from the single ALLOWED_SPEC above — there is
  # nothing left for them to drift against each other, so the runtime assertion that used to live
  # here (checking the old parallel order array named exactly ALLOWED's keys, each exactly once)
  # is gone with it.
  local key
  load_env_values
  local args=()
  for key in "${ENV_KEY_ORDER[@]}"; do
    args+=(--arg "$key" "$(env_value "$key")")
  done
  # After the static keys, append every plugin's non-secret env keys in manifest order — the plugins in
  # the cached Plugin Index, whether or not each is in PLUGINS (#256) — so the panel's config form
  # renders them (e.g. WARBANDEER_INGEST_PORT) and a plugin can be configured in the same save that
  # turns it on. Read from the container's cached index by load_plugin_keys, never hand-mirrored.
  load_plugin_keys
  if [ "${#PLUGIN_KEY_ORDER[@]}" -gt 0 ]; then
    for key in "${PLUGIN_KEY_ORDER[@]}"; do
      [[ -n "${ALLOWED[$key]+x}" ]] && continue   # a plugin key colliding with a static one: static wins, never double-listed
      args+=(--arg "$key" "$(env_value "$key")")
    done
  fi
  # A note, deliberately NOT a JSON field: env-get's stdout must stay a flat {KEY: value} map the
  # panel round-trips back through env-set (a lowercase `plugins` meta key would be echoed and then
  # rejected as un-editable). #102's panel learns index availability from its own fetch of the index;
  # here we just say on stderr why the plugins' keys aren't being shown.
  if [ "$PLUGIN_KEYS_STATUS" = "index unavailable" ]; then
    echo "bot-ops: plugins: index unavailable — showing static keys only (the bot isn't running or hasn't cached the Plugin Index yet)" >&2
  fi
  # Build a {KEY: value, ...} object over the static keys then the plugins' keys, in that
  # order — jq preserves --arg insertion order in $ARGS.named, and the admin panel's front-end
  # renders this object's keys in the order it receives them rather than re-sorting.
  jq -n "${args[@]}" '$ARGS.named'
}

# #205: JSON of the same keys env-get lists, in the same order, but carrying the validation env-set
# itself enforces rather than the effective value — {KEY: {pattern, required, source}}. Reuses
# env-get's exact loading sequence (need jq, the .env-exists check, load_env_values, load_plugin_keys,
# the same "index unavailable" stderr note) so the two subcommands can never disagree about which
# keys exist or their order.
#
# #256: the plugin rows are those of EVERY plugin in the cached index, enabled or not (see
# load_plugin_keys), so the panel can draw and validate a plugin's settings before the plugin is on.
#
# #240: after those rows come the plugins' WRITE-ONLY secret keys, each
# {pattern, required, source: "plugin", secret: true, isSet} — that the key exists, that it is secret,
# and whether it is set, never what it holds. `isSet` is tested here in bash (`[ -n "$(env_value …)" ]`)
# and only the resulting true/false is handed to jq, so the value never reaches jq's argv either.
# Every non-secret entry is byte-for-byte what it was: the two extra fields are emitted only when the
# row's `secret` column is "true".
cmd_env_schema() {
  need jq
  [ -f "$ENV_FILE" ] || die "env-schema: $ENV_FILE not found"
  local key is_set
  load_env_values
  load_plugin_keys
  # Build the object with jq positional args in groups of six -- key, pattern, required, source,
  # secret, isSet -- so a pattern's backslashes and quotes pass through untouched (never
  # string-interpolate a regex into a jq program). Non-secret rows pass `false false` for the last two.
  local args=()
  for key in "${ENV_KEY_ORDER[@]}"; do
    args+=("$key" "${ALLOWED[$key]}" "$([[ -n "${REQUIRED[$key]+x}" ]] && echo true || echo false)" core false false)
  done
  if [ "${#PLUGIN_KEY_ORDER[@]}" -gt 0 ]; then
    for key in "${PLUGIN_KEY_ORDER[@]}"; do
      [[ -n "${ALLOWED[$key]+x}" ]] && continue   # a plugin key colliding with a static one: static wins, exactly as env-get
      args+=("$key" "${PLUGIN_FORMAT[$key]}" "${PLUGIN_REQUIRED[$key]:-false}" plugin false false)
    done
  fi
  if [ "${#PLUGIN_SECRET_ORDER[@]}" -gt 0 ]; then
    for key in "${PLUGIN_SECRET_ORDER[@]}"; do
      if [ -n "$(env_value "$key")" ]; then is_set=true; else is_set=false; fi
      args+=("$key" "${PLUGIN_SECRET_FORMAT[$key]}" "${PLUGIN_SECRET_REQUIRED[$key]:-false}" plugin true "$is_set")
    done
  fi
  if [ "$PLUGIN_KEYS_STATUS" = "index unavailable" ]; then
    echo "bot-ops: plugins: index unavailable — showing static keys only (the bot isn't running or hasn't cached the Plugin Index yet)" >&2
  fi
  # `_nwise`/`nwise` is NOT a real jq builtin -- it's a documentation example jq's own manual shows
  # as something you could define yourself, never compiled into the interpreter (confirmed: absent
  # from `jq -n 'builtins'` on 1.8.2, and `_nwise(4)` fails "not defined" on a plain CLI invocation
  # with no such def in scope). Group the flat positional array into 6s by index/slice instead --
  # portable back to jq 1.5, and avoids the plan's original `_nwise` call entirely (#205 deviation;
  # only the stride changed in #240).
  jq -n --args \
    '[$ARGS.positional as $a | range(0; ($a|length)/6) | $a[.*6:.*6+6] | {(.[0]): ({pattern: .[1], required: (.[2] == "true"), source: .[3]} + (if .[4] == "true" then {secret: true, isSet: (.[5] == "true")} else {} end))}] | add // {}' \
    -- "${args[@]}"
}

# What may be echoed of a submitted key name that is not editable: only something shaped like an
# environment variable's name — upper-case, at most 40 characters, which every real key here is.
# A multi-line value (a PEM block, say) is read one line at a time, so a later line's text before its
# first `=` arrives here as a "key"; naming it would echo a fragment of a secret into an error that the
# panel's server logs. Anything else is not shown.
echo_key() {
  if [[ "$1" =~ ^[A-Z][A-Z0-9_]{0,39}$ ]]; then printf '%s' "$1"; else printf '%s' "(not shown)"; fi
}

# WHAT IS RELAYED OF ANOTHER TOOL'S OUTPUT. Nothing this script writes itself carries a value; the one
# way a value can still reach an output is a message from a tool it does not own -- `docker compose`
# quoting part of a .env line it refused to parse (an unterminated quote pasted by hand, say) -- which
# env-set relays as `log` and restart relays as its output. Two layers, because the second alone cannot
# be made exact (review round 5): it has to guess which part of a line compose would print, and compose
# reads .env by its own rules -- a key ends at `=` OR `:`, `export ` is dropped, and its whitespace
# includes U+0085 and U+00A0 -- so any guess made with bash's rules misses wherever the two disagree.
#
#   1. relay_tool_output WITHHOLDS, whole, any output that is ABOUT the env file: it names the file
#      ($ENV_FILE) or says "env file". The premise: compose-go's dotenv reader wraps every parse error
#      as `failed to read <path>: ...` (compose-spec/compose-go `main`, dotenv/format.go, read on
#      2026-09-21 -- upstream main, NOT the compose installed on any host, which was never run here), so
#      the messages most likely to quote the file's contents name it. Anything that does not name it
#      goes to layer 2, because any message can quote a value. What is relayed instead of a withheld
#      message is this script's own sentence: it names no path, claims no cause and no remedy (it is
#      the same for a failed run and a successful one, and the script never checked which it saw), and
#      carries nothing from compose's output but the line numbers (digits only).
#   2. Everything else goes through redact_secret_values, best effort, as before.
mentions_env_file() {
  local text="$1" lower="${1,,}"
  [[ "$text" == *"$ENV_FILE"* || "$lower" == *"env file"* ]]
}

relay_tool_output() {
  local text="$1"
  if mentions_env_file "$text"; then
    local lines
    # Each "line N" once, in numeric order. `|| true`: no "line N" in the text is fine, and must not abort
    # the script under pipefail.
    lines="$(printf '%s\n' "$text" | grep -oE 'line [0-9]+' | LC_ALL=C sort -t ' ' -k2,2n -u | tr '\n' ',' || true)"
    lines="${lines%,}"
    printf '%s' "docker compose's output mentioned an env file, so it is withheld: such a message can quote the file's contents.${lines:+ It named ${lines//,/, }.} Run the same command on the host to see it."
    return 0
  fi
  redact_secret_values "$text"
}

# Trim, from both ends of $1, what COMPOSE's .env reader treats as whitespace: ASCII blanks plus U+0085
# and U+00A0 (matched as their UTF-8 bytes, whatever the locale). Result in REPLY -- no subshell, since
# this runs several times per line of .env, so the return channel cannot be `local`; the script has no
# bare `read`, so nothing else touches REPLY.
compose_trim() {
  local s="$1" before
  local nbsp=$'\xc2\xa0' nel=$'\xc2\x85'
  while :; do
    before="$s"
    s="${s#"${s%%[![:space:]]*}"}"
    s="${s%"${s##*[![:space:]]}"}"
    s="${s#"$nbsp"}"; s="${s#"$nel"}"
    s="${s%"$nbsp"}"; s="${s%"$nel"}"
    if [ "$s" = "$before" ]; then break; fi
  done
  REPLY="$s"
}

# Replace, in the text given, each text that looks like a .env value env-get would NOT print with
# "[redacted]" (a best-effort guess, see the end of this comment).
#
# What is scrubbed is decided from .env and the static ALLOWED table ALONE, never from the Plugin Index.
# The index is unavailable exactly when the bot is down, which is when compose is most likely to be
# complaining: a scrub that leaned on it scrubbed nothing when it mattered (#240, review round 4). Only
# a static ALLOWED key written the plain way (`KEY=value`) is printable -- those are the keys env-get
# always lists; every other line is scrubbed: a core credential, a plugin's secret, a plugin's plain
# setting, a key nobody knows. Scrubbing a plain setting costs nothing; missing a secret does.
#   - A line written the plain way (`KEY=value`, which compose reads the same way this script does)
#     gives its value. ANY OTHER line -- another syntax compose accepts (`KEY: value`, `KEY = value`),
#     one it rejects (`export MY!KEY=...`), or no definition at all (the second line of a pasted
#     multi-line secret) -- gives several candidate texts, because which part of it a tool prints is
#     anyone's guess: the whole line; the line without a leading `export`; what follows its first `=`;
#     what follows its first `:`. Every text is trimmed of compose's whitespace (see compose_trim) and
#     also tried without an opening quote (an unterminated value is printed from its quote on) and
#     without both quotes (the way load_env_values reads it). Comments are left alone.
#   - EVERY definition of a key counts, not only the last.
#   - So do the values this invocation read BEFORE it rewrote the file (ENV_VALUES -- a replaced value
#     is no longer in the file). The values being written need no list: the file already holds them.
#   - LONGEST FIRST. Replacing a short text first cuts a longer one that contains it in two, and the
#     longer one then no longer matches: whoever can set one secret could unmask another (round 4).
#   - A text shorter than REDACT_MIN_LENGTH is left alone: those ("us", a port number) are what would
#     make the relayed text unreadable. That rests on an assumption nothing enforces -- that nobody
#     stores a credential shorter than six characters -- so such a credential is NOT scrubbed.
#   - Texts are matched as literals (quoted inside ${...//.../...}, so a `*` or `[` in one is not a glob).
# Best effort by nature: a tool that prints a value transformed (escaped, truncated) is not caught, and
# a line written in a syntax neither this list nor layer 1 anticipates is not either.
readonly REDACT_MIN_LENGTH=6
redact_secret_values() {
  local text="$1" line key rest val quote
  local -a found=() parts=()
  if [ -f "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      compose_trim "$line"; rest="$REPLY"
      if [ -z "$rest" ] || [[ "$rest" == \#* ]]; then continue; fi
      if [[ "$line" =~ $ENV_LINE_RE ]]; then
        # written the plain way, which compose reads the same way: the value is what follows the `=`
        key="${BASH_REMATCH[2]}"
        if [[ -n "${ALLOWED[$key]+x}" ]]; then continue; fi
        parts=("${BASH_REMATCH[3]}")
      else
        # written some other way, or no definition at all: which part a tool prints is anyone's guess
        parts=("$rest")
        if [[ "$rest" =~ ^export[[:space:]]+(.*)$ ]]; then
          rest="${BASH_REMATCH[1]}"
          parts+=("$rest")
        fi
        if [[ "$rest" == *=* ]]; then parts+=("${rest#*=}"); fi
        if [[ "$rest" == *:* ]]; then parts+=("${rest#*:}"); fi
      fi
      for val in "${parts[@]}"; do
        compose_trim "$val"; val="$REPLY"
        found+=("$val")
        quote="${val:0:1}"
        if [[ "$quote" == '"' || "$quote" == "'" ]]; then
          val="${val:1}"
          found+=("$val")
          if [[ -n "$val" && "${val: -1}" == "$quote" ]]; then found+=("${val:0:${#val}-1}"); fi
        fi
      done
    done < "$ENV_FILE"
  fi
  # What env-set read before it rewrote the file (restart loads no values, so this is empty there).
  if [ "${#ENV_VALUES[@]}" -gt 0 ]; then
    for key in "${!ENV_VALUES[@]}"; do
      if [[ -z "${ALLOWED[$key]+x}" ]]; then found+=("${ENV_VALUES[$key]}"); fi
    done
  fi
  if [ "${#found[@]}" -gt 0 ]; then
    local sorted tab
    tab="$(printf '\t')"
    # "<length> TAB <text>" per line, longest first. No text holds a newline (each is part of one line of
    # .env, or was refused by env-set's line-break check), and everything after the first tab is the text.
    sorted="$(
      for val in "${found[@]}"; do
        if (( ${#val} >= REDACT_MIN_LENGTH )); then printf '%d\t%s\n' "${#val}" "$val"; fi
      done | LC_ALL=C sort -t "$tab" -k1,1nr
    )"
    while IFS= read -r line; do
      val="${line#*"$tab"}"
      if [ -n "$val" ]; then text="${text//"$val"/[redacted]}"; fi
    done <<< "$sorted"
  fi
  printf '%s' "$text"
}

# Apply: recreate the container so the new env is loaded (a plain restart would not reload it).
# Deliberately NO --build: a self-update (nazumods/wow#879) tags its freshly built image as the same
# `<project>-bot:latest` compose expects, so recreating without building reuses it. Adding
# --build here would rebuild from whatever this checkout happens to be on, silently rolling
# the bot back to older code every time someone edits a setting.
# #60 item 2 / #168: same stderr-only convention as cmd_restart — named right before the actual
# recreate, not earlier, so a save that hits the "no changes" early return above never logs it.
# Shared by cmd_env_set and cmd_recreate (#277) so the two can never drift. The relayed output
# travels in the global RECREATE_LOG rather than being returned as a string — a bash function can't
# return a string without a subshell, and the exit status here must be compose's.
recreate_bot() {
  echo "bot-ops: env file $ENV_FILE" >&2
  local out rc=0
  out="$(BOT_ENV_FILE="$ENV_FILE" docker compose -f "$COMPOSE_FILE" -p "$PROJECT" up -d --force-recreate 2>&1)" || rc=$?
  # The recreate's own output goes through relay_tool_output before it is echoed back: withheld if
  # it is about the env file, scrubbed of every value env-get would not print otherwise (#240).
  RECREATE_LOG="$(relay_tool_output "$out")"
  return "$rc"
}

cmd_env_set() {
  need docker; need jq
  guard_no_handoff_in_progress
  lock_config_dir env-set
  [ -f "$ENV_FILE" ] || die "env-set: $ENV_FILE not found"

  # Every REQUIRED key must also be an ALLOWED one — REQUIRED is a separate, hand-maintained set
  # (unlike ENV_KEY_ORDER, it isn't derived from ALLOWED_SPEC, since "has no default to clear back
  # to" is a genuinely independent fact about a key, not something ALLOWED_SPEC's shape could carry
  # for free) — a typo here would otherwise silently never enforce that key.
  local rkey
  for rkey in "${!REQUIRED[@]}"; do
    [[ -n "${ALLOWED[$rkey]+x}" ]] || die "env-set: '$rkey' is in REQUIRED but not ALLOWED"
  done

  # Merge in every plugin's declared env keys (from the container's cached index) so the whitelist
  # below accepts them alongside the static ALLOWED set — read once, up front, with one docker read
  # even on an instance with no plugins. The index, not PLUGINS, decides which keys are plugin keys
  # (#256): a plugin's own key is editable in the SAME save that first adds the plugin to PLUGINS, which
  # is what makes turning a plugin on and configuring it one restart. That widens which keys this
  # accepts, and is safe because the index already decides what a plugin key is, a key of a plugin that
  # is off is inert until the plugin is on, and a reserved (core) key stays reserved whatever a manifest
  # says. A key no plugin in the index declares, and a core secret, are still refused below.
  load_env_values
  load_plugin_keys

  # `${#assoc[@]}` on a still-empty associative array once tripped "unbound variable" under
  # `set -u` (pre-bash-4.4); this repo's deploy target (Debian trixie) ships bash 5.3, and
  # `${#PLUGIN_KEY_ORDER[@]}` above already relies on the general form. Confirmed for real on both
  # the deploy host and dev: `bash -c 'set -u; declare -A a=(); echo "${#a[@]}"'` prints `0`, no
  # error (issue #135 item 13) — so SUBMITTED/DIFF's sizes below are read directly off the arrays,
  # no hand-kept counter to drift from what was actually inserted.
  declare -A SUBMITTED=()
  local -a submitted_order=()
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    [[ "$line" == *=* ]] || die "env-set: malformed input line (need KEY=VALUE)"
    key="${line%%=*}"
    val="${line#*=}"
    # A key that isn't even key-shaped (`=value`, `a b=1`) is malformed input — checked before the
    # ALLOWED lookup, which would otherwise die on an empty subscript with a raw bash error.
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "env-set: malformed input line (need KEY=VALUE)"
    # Whitelist membership is checked up front whether or not the value changes — that's a
    # question of authority (may the panel touch this key at all?), not of format. A key is
    # editable if it is a static ALLOWED key, a plugin's own key, OR (#240) a plugin's `secret` key —
    # write-only, see PLUGIN_SECRET_* above — where "a plugin" is any plugin in the cached index, on or
    # off (#256), and a key no index plugin declares is refused. A CORE secret is in none of
    # those sets (and load_plugin_keys never lets a manifest add a reserved key), so it is refused
    # here exactly as before. The message names the key (when it looks like a variable name — see
    # echo_key), never a value.
    [[ -n "${ALLOWED[$key]+x}" || -n "${PLUGIN_FORMAT[$key]+x}" || -n "${PLUGIN_SECRET_FORMAT[$key]+x}" ]] \
      || die "env-set: '$(echo_key "$key")' is not an editable key"
    [[ -n "${SUBMITTED[$key]+x}" ]] || submitted_order+=("$key")
    SUBMITTED["$key"]="$val" # a key repeated on stdin: last wins, like .env itself
  done

  # Reduce to real changes (new value differs from the EFFECTIVE current value — see
  # load_env_values) and validate only those, in submission order. The order matters (issue
  # #44): validating every submitted line first meant a stored value the bot accepts but a regex
  # here rejects — a hand-quoted realm, a CRLF-saved file, `1, 2` in ADMIN_USER_IDS — failed every
  # save that echoed it back, naming a key the operator never touched. A value that isn't
  # changing was never this script's to judge. A no-op must not restart the bot.
  load_env_values
  declare -A DIFF=()
  local fmt is_required is_secret
  if [ "${#SUBMITTED[@]}" -gt 0 ]; then
    for key in "${submitted_order[@]}"; do
      val="${SUBMITTED[$key]}"
      is_secret=""
      [[ -z "${PLUGIN_SECRET_FORMAT[$key]+x}" ]] || is_secret=1
      if [ -z "$is_secret" ]; then
        [ "$val" != "$(env_value "$key")" ] || continue
      else
        # A plugin's secret key is write-only, so its stored value is never something a caller may
        # learn — and "no change" would tell it: a submitted guess that comes back with nothing
        # changed IS the stored value (a read oracle, one guess at a time). So a submitted secret is
        # ALWAYS treated as a change and written, and the result says so whatever it held. The one
        # exception is a blank for a key that is already unset: that reveals only what `isSet` in
        # env-schema already reveals.
        { [ -n "$val" ] || [ -n "$(env_value "$key")" ]; } || continue
      fi
      # A CR in a value would let it start a new line in .env (an LF cannot reach here: stdin is read a
      # line at a time, so a value never holds one) — for a secret
      # key the format regex may be permissive, so this is checked here, for every key, before the
      # format. The message names the key, never the value.
      [[ "$val" != *$'\r'* ]] || die "env-set: value for '$key' is invalid"
      # compose reads a .env value as SYNTAX, and a manifest `format` may admit it (the shipped `^\S+$`
      # does), as does the static PLUGIN_INDEX_URL regex: a `$` starts an interpolation, so
      # `SPOTIFY_CLIENT_ID=${DISCORD_TOKEN}` would hand the plugin — and whoever it displays the value
      # to — a core secret, and `PLUGIN_INDEX_URL=https://host/?t=${DISCORD_TOKEN}` would send it to
      # that host; a quote can open a multi-line or unterminated value, which swallows the lines after
      # it and stops compose loading the file at all. So a value may not contain `$` or a quote
      # ANYWHERE (not just leading: compose trims a wider set of whitespace than bash's `[[:space:]]`,
      # U+0085 and U+00A0 among it, before it looks for a quote). Refused for every key, secret or
      # plain, static or plugin, and never quoting the value. No shipped key needs either character.
      [[ "$val" != *'$'* && "$val" != *'"'* && "$val" != *"'"* ]] \
        || die "env-set: value for '$key' may not contain a dollar sign or a quote"
      # Format + required-ness come from the static ALLOWED set, or from the plugin's manifest entry
      # in the cached index for a plugin-owned key (a static key wins if somehow both name it).
      if [[ -n "${ALLOWED[$key]+x}" ]]; then
        fmt="${ALLOWED[$key]}"
        is_required="${REQUIRED[$key]+x}"
      elif [ -n "$is_secret" ]; then
        fmt="${PLUGIN_SECRET_FORMAT[$key]}"
        if [ "${PLUGIN_SECRET_REQUIRED[$key]:-false}" = "true" ]; then is_required="x"; else is_required=""; fi
      else
        fmt="${PLUGIN_FORMAT[$key]}"
        if [ "${PLUGIN_REQUIRED[$key]:-false}" = "true" ]; then is_required="x"; else is_required=""; fi
      fi
      if [ -z "$val" ]; then
        [ -z "$is_required" ] || die "env-set: '$key' is required and cannot be blank"
      elif [[ ! "$val" =~ $fmt ]]; then
        die "env-set: value for '$key' is invalid"
      fi
      DIFF["$key"]="$val"
    done
  fi
  if [ "${#DIFF[@]}" -eq 0 ]; then
    jq -n '{ok: true, changed: [], recreated: false, note: "no changes"}'
    return 0
  fi

  # Backups live in the config dir's own backups/ subdirectory, never beside .env in a checkout —
  # mkdir -p is defensive here in case a fresh config dir was hand-created without it.
  mkdir -p "$CONFIG_DIR/backups"

  # .env and its backups must stay owned by the deploy user: day-2 SSH ops and redeploys read
  # .env as that (non-root) user, but env-set usually runs from the admin container AS ROOT (it
  # needs the docker socket), whose mktemp/install/mv below would otherwise leave every rewrite
  # root-owned — silently locking the deploy user out on each save (issue #20). Restore ownership
  # to CONFIG_DIR's own owner (install.sh chowns it to the deploy user), by NUMERIC uid:gid since
  # the container has no matching username. On the next real settings change this self-heals a
  # .env already flipped to root, and is a harmless no-op when env-set is instead run directly as
  # the deploy user. Each chown is `|| warn`-guarded so a refused chown (non-root, target already
  # correctly owned) can't abort env-set under `set -e` after the write already happened.
  local target_owner
  target_owner="$(stat -c '%u:%g' "$CONFIG_DIR")"
  # backups/ itself may have just been created by the defensive mkdir above (root-owned in the
  # container context) — chown it too, else a later deploy-user run can't write a backup into it.
  chown "$target_owner" "$CONFIG_DIR/backups" \
    || echo "bot-ops: warning: couldn't set backups/ ownership to $target_owner" >&2

  # #227: the pid suffix means the name can never collide — with the lock two saves can no longer
  # share a second, but the name is the record of what was replaced and must never depend on timing.
  local backup="$CONFIG_DIR/backups/.env.bak.$(date +%Y%m%d-%H%M%S)-$$"
  # Pin the backup to 0600 rather than inheriting .env's mode. `cp` would copy that mode, which is
  # only safe while .env is itself owner-only — and a .env recreated by hand or by a fresh deploy
  # picks up the umask (0664 under the usual 002) instead. This file holds DISCORD_TOKEN and
  # BLIZZARD_CLIENT_SECRET, so its exposure shouldn't depend on the source being right.
  install -m 600 "$ENV_FILE" "$backup"
  chown "$target_owner" "$backup" \
    || echo "bot-ops: warning: couldn't set backup ownership to $target_owner" >&2

  # Rewrite .env: replace matching KEY= lines in place (an indented or `export KEY=` line too — it
  # comes back as plain `KEY=`, which compose reads identically), preserve everything else
  # verbatim, append any changed key that wasn't already present.
  declare -A APPLIED
  local tmp k
  # -p "$CONFIG_DIR" keeps the temp file on the SAME filesystem as $ENV_FILE — env-set usually
  # runs from the admin container, where the default temp dir is the container's own overlay fs
  # while $CONFIG_DIR is a bind mount, so a bare `mktemp` here would make the mv below cross a
  # filesystem boundary and silently degrade to copy-then-unlink, losing the atomicity this is
  # for (same reasoning as ops/install.sh's own fetch() helper). The trap is double-quoted so
  # $tmp's value is baked in immediately, not deferred: $tmp is `local` to this function, so a
  # deferred (single-quoted) expansion would read as unset once the EXIT trap actually fires
  # (after main()'s whole call chain has unwound) and die on `set -u`, corrupting the exit code
  # of an otherwise-successful run.
  tmp="$(mktemp -p "$CONFIG_DIR")"
  trap "rm -f \"$tmp\"" EXIT
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ $ENV_LINE_RE ]]; then
      k="${BASH_REMATCH[2]}"
      if [[ -n "${DIFF[$k]+x}" ]]; then
        printf '%s=%s\n' "$k" "${DIFF[$k]}" >> "$tmp"
        APPLIED["$k"]=1
        continue
      fi
    fi
    printf '%s\n' "$line" >> "$tmp"
  done < "$ENV_FILE"
  for k in "${!DIFF[@]}"; do
    [[ -z "${APPLIED[$k]+x}" ]] && printf '%s=%s\n' "$k" "${DIFF[$k]}" >> "$tmp"
  done
  mv "$tmp" "$ENV_FILE"
  # State the mode instead of inheriting whatever mktemp happened to create. `mv` carries the temp
  # file's mode onto .env, so today .env ends up 0600 purely as a side effect of mktemp's default —
  # correct by accident, and silently narrowing for anyone who set .env to 0640 on purpose. Saying
  # 0600 outright makes the intent the contract. `|| warn`-guarded like the chown calls around it:
  # .env has already been rewritten by this point, so under `set -e` an unguarded failure here (a
  # read-only remount, an immutable attr, an ACL/quota edge case) would exit before the jq -n below
  # ever runs, losing the JSON result for a mutation that already happened (same class as issue #47)
  # — and mktemp's own 0600 default (the comment above) means the file is already correctly narrow
  # even when this explicit chmod can't confirm it.
  chmod 600 "$ENV_FILE" \
    || echo "bot-ops: warning: couldn't set .env permissions to 600" >&2
  chown "$target_owner" "$ENV_FILE" \
    || echo "bot-ops: warning: couldn't restore .env ownership to $target_owner" >&2

  # Apply: recreate the container so the new env is loaded (a plain restart would not reload it) —
  # via the shared recreate_bot() helper (#277), so this and cmd_recreate can never drift. The
  # result names changed KEYS only (never a value).
  local rc=0
  recreate_bot || rc=$?
  local recreate_log="$RECREATE_LOG"
  local changed_json
  changed_json="$(printf '%s\n' "${!DIFF[@]}" | jq -R . | jq -s .)"
  jq -n --argjson changed "$changed_json" --arg backup "$backup" \
        --argjson ok "$([ "$rc" -eq 0 ] && echo true || echo false)" \
        --arg log "$recreate_log" \
        '{ok: $ok, changed: $changed, recreated: true, backup: $backup, log: $log}'
  return "$rc"
}

# #240: the bot's routing record and what it can see, as one JSON object — {routing, discovery} —
# read from its data dir the way cmd_status reads state.json. A file that does not exist yet, is
# empty, is not one JSON object, or will not parse is `null`: never an error, never partial output
# (the posture cmd_status takes for state.json). Only those two files are ever opened here.
#
# Neither file is meant to hold a webhook URL or token, but both are read back from disk a person may
# have edited, so each is scrubbed on the way out: any member named url / token / secret / password is
# dropped (the routing model has none — src/routing/model.ts drops them the same way on its own read),
# and any Discord webhook URL inside a string is replaced by "[redacted]" (a bare `webhooks/<id>/<token>`
# tail by `webhooks/[redacted]`) — in keys as well as values, since that scrub runs on the compact
# JSON text. It is best effort: see the routing-get gotcha in CONTEXT.md for what it does not catch. The two
# documents reach the final jq over a pipe (a builtin printf, so no argv size limit: a discovery.json
# for a large server can run to tens of KB).
readonly ROUTING_SCRUB_JQ='
  if length == 1 and (.[0] | type) == "object"
  then (.[0]
        | walk(if type == "object" then with_entries(select(.key | test("^(url|token|secret|password)$"; "i") | not)) else . end)
        | tojson
        | gsub("https?://[^\"\\\\ ]*webhooks/[^\"\\\\ ]*"; "[redacted]"; "i")
        | gsub("webhooks/[0-9]+/[A-Za-z0-9_.~%-]+"; "webhooks/[redacted]"; "i")
        | fromjson)
  else null end'
# Reads one file from the container into SCRUBBED (a global, so it runs in the CURRENT shell like
# load_plugin_keys: called through a command substitution, `set -e` would not apply inside it and the
# `|| true` below — which a real `docker exec … cat` of a file that isn't there needs, since it exits 1
# and pipefail is on — could be dropped without anyone noticing).
SCRUBBED="null"
read_scrubbed_json() {
  SCRUBBED="$(docker exec "$CONTAINER" cat "$1" 2>/dev/null | jq -c -s "$ROUTING_SCRUB_JQ" 2>/dev/null || true)"
  [ -n "$SCRUBBED" ] || SCRUBBED="null"
}
cmd_routing_get() {
  need docker; need jq
  local routing discovery
  read_scrubbed_json "$ROUTING_PATH"
  routing="$SCRUBBED"
  read_scrubbed_json "$DISCOVERY_PATH"
  discovery="$SCRUBBED"
  { printf '%s\n' "$routing"; printf '%s\n' "$discovery"; } | jq -s '{routing: .[0], discovery: .[1]}'
}

# What may be echoed back of a request field that failed validation: only a short printable string
# (40 characters — every legitimate plugin name, version, timestamp and day count fits, and a webhook
# URL, whose token alone is longer, does not). Anything else — in particular a value a caller put in
# the wrong field — is not shown, so a rejected request can never become a log line carrying a secret.
echo_safe() {
  if [[ "$1" =~ ^[[:print:]]{0,40}$ ]]; then printf '%s' "$1"; else printf '%s' "(not shown)"; fi
}

# A top-level field of the JSON on stdin as a STRING — or "" when it is missing, not a string, or
# holds a control character. The last matters: `$(…)` drops trailing newlines, so a value ending in
# one ("12345\n") would otherwise validate as "12345" while the request file kept the newline.
json_string_field() {
  jq -r --arg f "$1" 'if (.[$f] | type) == "string" and (.[$f] | test("[\\x00-\\x1f]") | not) then .[$f] else "" end'
}

# #105: queue a plugin request the bot's mailbox will consume. Reads the request JSON on stdin
# (the admin panel's POST /api/plugins/request, which fills `requestedBy` from the verified Access
# identity), validates it per action, and writes it into the bot's data/plugins/requests/ so the bot —
# the sole writer of state.json and of its routing record — applies it on its next tick.
# The five plugin-update actions (update-now, schedule, remind, skip, cancel) are #105's; #240 adds
# routing-set, webhook-add, webhook-remove and discovery-refresh (ADR-0006), each validated before the
# file is written. This is the FIRST docker-exec WRITE and the FIRST `-u bun` in this script: every
# other exec is a read-only root `cat`, but the write MUST be `-u bun` (the container runs as root for
# the socket, so a root-created requests/ dir would be un-writable by the bun bot — it could then
# neither delete a consumed file nor create rejected/). The filename is script-controlled (epoch-ms +
# validated action + a nonce, so two same-ms same-action requests don't collide); the untrusted JSON is
# only ever the `cat >` body (a redirect, not eval), never the command or the path. The file is written
# under a temp name and renamed into place, so the bot never sees it half-written (see the write below).
#
# THE PAYLOAD MAY NOW HOLD A SECRET: a webhook-add request carries a Discord webhook URL, which is a
# credential. So it travels on STDIN only — never as an argument (argv is world-readable in `ps` and
# lands in docker's own command line) — the fields it holds are matched in bash rather than handed to
# jq as --arg, no `die` below echoes any part of it, and every request file is written owner-only.
cmd_plugin_request() {
  need docker; need jq
  local payload action plugin version at days
  payload="$(cat)"
  printf '%s' "$payload" | jq -e . >/dev/null 2>&1 || die "plugin-request: payload is not valid JSON"
  # An object, or nothing below can index it (and a jq indexing error is not ours to control).
  printf '%s' "$payload" | jq -e 'type == "object"' >/dev/null 2>&1 || die "plugin-request: payload is not a JSON object"
  # The string fields go through json_string_field: `$(…)` drops a trailing newline and a value holding
  # any control character could pass a check here and still be written to the request file with the
  # character in it, so such a field reads as "" and fails its check ("music\n" is refused, not queued
  # and then rejected by the bot). `days` may be a number or a string; a string with a control
  # character reads as a value that fails the day-count check.
  action="$(printf '%s' "$payload" | json_string_field action)"
  plugin="$(printf '%s' "$payload" | json_string_field plugin)"
  version="$(printf '%s' "$payload" | json_string_field version)"
  at="$(printf '%s' "$payload" | json_string_field at)"
  days="$(printf '%s' "$payload" | jq -r 'if .days == null then "" elif (.days | type) == "string" and (.days | test("[\\x00-\\x1f]")) then "?" else (.days | tostring) end')"

  local snowflake_re='^[0-9]{5,25}$'
  local webhook_re='^https://(canary\.|ptb\.)?discord(app)?\.com/api(/v[0-9]+)?/webhooks/[0-9]{5,25}/[A-Za-z0-9_-]{20,}$'
  # Anchored semver, no slashes — the path-traversal gate (the bot re-validates, but reject early too).
  local ver_re='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
  local iso_re='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?(\.[0-9]+)?([+-][0-9]{2}:?[0-9]{2}|Z)$'
  case "$action" in
    update-now|schedule|remind|skip|cancel)
      [[ "$plugin" =~ ^[a-z][a-z0-9-]*$ ]] || die "plugin-request: bad plugin '$(echo_safe "$plugin")'"
      if [ "$action" != "cancel" ]; then
        [[ "$version" =~ $ver_re ]] || die "plugin-request: bad version '$(echo_safe "$version")'"
      fi
      [ "$action" != "schedule" ] || [[ "$at" =~ $iso_re ]] || die "plugin-request: bad at '$(echo_safe "$at")'"
      if [ "$action" = "remind" ] && [ -n "$days" ]; then
        # 1-999, matching the bot's own validator — a 0-day snooze is meaningless (the bot rejects it too).
        { [[ "$days" =~ ^[0-9]{1,3}$ ]] && [ "$days" -ge 1 ]; } || die "plugin-request: bad days '$(echo_safe "$days")'"
      fi
      ;;
    routing-set)
      # Where a plugin lives: `servers` maps a guild id to {commands: "all" | [channel ids, non-empty],
      # postTo?: channel id}. An empty `servers` object is valid (the plugin is placed nowhere).
      # Every message below names the field, never the offending value.
      [[ "$plugin" =~ ^[a-z][a-z0-9-]*$ ]] || die "plugin-request: bad plugin"
      # \A…\z, not ^…$: in jq's regex flavour `$` also matches before a trailing newline, so "12345\n"
      # would pass as a snowflake (JavaScript's `$`, which the bot uses, does not).
      printf '%s' "$payload" | jq -e '
        def snowflake: type == "string" and test("\\A[0-9]{5,25}\\z");
        (.servers | type == "object")
        and (.servers | to_entries | all(
          (.key | snowflake)
          and (.value | type == "object")
          and ((.value.commands == "all")
               or ((.value.commands | type == "array") and (.value.commands | length > 0) and (.value.commands | all(snowflake))))
          and ((.value | has("postTo") | not) or (.value.postTo | snowflake))
        ))' >/dev/null 2>&1 || die "plugin-request: bad servers"
      ;;
    webhook-add)
      # The URL is a secret: matched in bash from a variable, never passed to jq as --arg, and the
      # failure message carries no part of it.
      local url
      url="$(printf '%s' "$payload" | json_string_field url)"
      [[ "$url" =~ $webhook_re ]] || die "plugin-request: bad webhook url"
      ;;
    webhook-remove)
      local channel_id
      channel_id="$(printf '%s' "$payload" | json_string_field channelId)"
      [[ "$channel_id" =~ $snowflake_re ]] || die "plugin-request: bad channelId"
      ;;
    discovery-refresh) ;;
    *) die "plugin-request: bad action '$(echo_safe "$action")'" ;;
  esac

  local file req_dir='/app/data/plugins/requests'
  # Two RANDOMs, not one: two requests of the same action in the same millisecond must not share a name
  # (they would share the temp file too, and one would overwrite the other).
  file="$(date +%s%3N)-${action}-${RANDOM}${RANDOM}.json"
  # The write is ATOMIC and OWNER-ONLY (found by #241's review gate). `cat > <final>` creates the file
  # and only then fills it, so for a moment it exists empty or partial — and the bot's drain lists
  # `*.json`, reads, and REJECTS a file that does not parse, after this script has already told the
  # panel {ok: true, queued}: a good request lost silently. So the body goes to `<final>.tmp` in the
  # SAME directory (the drain's filter is `f.endsWith(".json")`, src/plugins/requests.ts, so a name
  # ending `.json.tmp` is never picked up — never give the temp file a `.json` ending) and is then
  # `mv`ed into place, which is atomic within a directory. If any step fails the temp file is removed
  # and the shell exits 1, so nothing half-written is left behind and this script dies below rather
  # than reporting `queued`. (A shell that is KILLED mid-write cannot clean up: it leaves a
  # `<file>.json.tmp`, owner-only and invisible to the drain, that nothing sweeps.) `umask 077` comes AFTER `mkdir -p` (a requests/ that does not exist yet
  # keeps the ordinary mode; only the file is narrowed): a request may carry a webhook URL, and the bot
  # — which runs as bun, as does this write — can still read and delete an owner-only file.
  # -i pipes the payload to the container's stdin; -u bun so the file (and requests/) are bun-owned.
  printf '%s' "$payload" \
    | docker exec -i -u bun "$CONTAINER" sh -c "mkdir -p ${req_dir} && umask 077 && cat > ${req_dir}/${file}.tmp && mv ${req_dir}/${file}.tmp ${req_dir}/${file} || { rm -f ${req_dir}/${file}.tmp; exit 1; }" \
    || die "plugin-request: could not write the request into the bot's mailbox"
  jq -n --arg queued "$file" '{ok: true, queued: $queued}'
}

main() {
  [ -f "$ENV_FILE" ] || die ".env not found at $ENV_FILE (is BOT_OPS_CONFIG_DIR correct?)"
  [ -f "$COMPOSE_FILE" ] || die "compose file not found at $COMPOSE_FILE (is BOT_OPS_COMPOSE_FILE correct?)"
  local sub="${1:-}"
  shift || true
  case "$sub" in
    status)  cmd_status ;;
    logs)    cmd_logs "$@" ;;
    restart) cmd_restart ;;
    recreate) cmd_recreate ;;
    env-get) cmd_env_get ;;
    env-set) cmd_env_set ;;
    env-schema) cmd_env_schema ;;
    routing-get) cmd_routing_get ;;
    plugin-request) cmd_plugin_request ;;
    # #173 round 3: version is dispatched near the very top of the script, before this function
    # (and its .env/compose-file preconditions) is ever reached — see the comment above readonly
    # BOT_OPS_SCHEMA. No case arm needed here; kept in the usage string below since it's still a
    # real, documented subcommand.
    *) die "usage: bot-ops.sh {status|logs [N]|restart|recreate|env-get|env-set|env-schema|routing-get|plugin-request|version}" ;;
  esac
}

main "$@"
