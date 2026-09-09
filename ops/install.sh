#!/usr/bin/env bash
#
# install.sh — bootstrap a fresh rackbops-discord-bot instance with no checkout on the host:
# just git, docker, and curl. Curl-able:
#
#   curl -fsSL https://raw.githubusercontent.com/Rackbops/rackbops-discord-bot/main/ops/install.sh \
#     | bash -s -- debug
#
# Run as a normal user, not root — sudo is invoked internally, just once, to bootstrap /opt.
# `curl ... | sudo bash -s -- debug` also works (SUDO_UID/SUDO_GID tell it who to hand real
# ownership back to); running as root with neither set is refused outright, since there'd be no
# real user to own the result.
#
# Usage: install.sh <instance> [branch]
#   <instance>   Instance name (lowercase/digits/hyphens), e.g. "debug" or "prod".
#   [branch]     BOT_BRANCH to build from and fetch templates from (default: main).
#
# Creates, if not already present:
#   /opt/rackbops-discord-bot/<instance>/.env       from .env.example — fill in secrets by hand
#   /opt/rackbops-discord-bot/<instance>/backups/    ops/bot-ops.sh env-set's backup target
# Always refreshes (never touches .env — same "generated vs. precious" split as the answer-file
# convention this follows; bin/, the compose file, and the compose-project .env below are all
# scripts/deployment descriptors, shared per host or generated from this run's own values, not
# instance config):
#   /opt/rackbops-discord-bot/bin/bot-ops.sh
#   /opt/stacks/rackbops-discord-bot-<instance>/docker-compose.yml
#   /opt/stacks/rackbops-discord-bot-<instance>/.env      Compose's own interpolation source (see
#                                                          below) — NOT the bot's secrets .env above
#
# Every fetched or generated file is written to a temp file first, then moved into place
# atomically — a dropped connection (or, for the generated .env, an interrupted write) leaves
# nothing at the final path rather than a truncated file that a later run's existence-check would
# mistake for real config.
#
# Deliberately does NOT run the initial `up -d --build` itself — the bot won't actually start
# until you've filled in secrets (DISCORD_TOKEN etc.) that only you can supply, so the command is
# printed at the end for you to run once .env is ready, not fired unattended against a live host.
#
# The whole body below lives inside main(), called only as the very last line of this file — a
# `curl | bash` stream executes top-level statements as they arrive, so a truncated download would
# otherwise run whatever prefix already streamed in. Wrapping everything in one function means a
# truncated stream either fails to parse main() at all (nothing defined, nothing runs) or, once
# the file is fully fetched, runs the whole thing — never a partial prefix.
set -euo pipefail

# Every temp file this script creates is registered here and swept however we leave — including
# the `set -e` abort that is the realistic case. `BRANCH` isn't validated until after all three
# fetches, so a typo'd branch 404s inside `fetch()` and aborts mid-run, stranding a `tmp.XXXXXX`
# in the install tree. Nothing sensitive leaks (curl -f writes no body on a 404, all three sources
# are public, and the stack .env holds no secrets by design) — but the litter lands one directory
# from the real ones. A script-level EXIT trap rather than a per-function one: a RETURN trap does
# not fire when `set -e` unwinds, and a second EXIT trap set inside a function would silently
# replace the first.
TMP_FILES=()
cleanup_tmp_files() {
  # The -gt 0 test is deliberately unpinned by any test, and cannot be pinned on a modern box: on
  # bash >= 4.4 `"${empty[@]}"` under `set -u` expands to nothing instead of erroring, so deleting
  # this line changes nothing here (verified: `a=(); rm -f "${a[@]}"` exits 0 on bash 5.x). It
  # defends bash < 4.4, where that expansion is an unbound-variable error — reachable whenever the
  # script dies before the first fetch() registers anything (a bad instance name, `need git`).
  if [ "${#TMP_FILES[@]}" -gt 0 ]; then rm -f "${TMP_FILES[@]}"; fi
}
trap cleanup_tmp_files EXIT

REPO_URL="https://github.com/Rackbops/rackbops-discord-bot.git"
RAW_BASE="https://raw.githubusercontent.com/Rackbops/rackbops-discord-bot"

die() { echo "install: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found — install it first"; }

# curl | sudo bash -s -- prod runs the WHOLE interpreter as root, not just bootstrap_dir's own
# internal escalation below — id -u is 0 for the entire script in that case, so every file it
# creates would otherwise end up root-owned, locking the real deploy user out of their own
# instance. SUDO_UID/SUDO_GID are set by sudo itself (never the operator) and name who actually
# invoked it; with no sudo in the picture at all there's no real user to hand ownership to, so
# refuse outright rather than silently deploying an instance only root can maintain. A separate
# function (rather than inline in main()) so ops/install.test.ts can source and exercise just
# this decision in isolation, with a faked `id`, without running the rest of the script.
resolve_deploy_identity() {
  if [ "$(id -u)" -eq 0 ]; then
    [ -n "${SUDO_UID:-}" ] \
      || die "don't run this as root directly — invoke it as your normal user via sudo (e.g. curl ... | sudo bash -s -- $INSTANCE), so files end up owned by you, not root"
    DEPLOY_UID="$SUDO_UID"
    DEPLOY_GID="${SUDO_GID:-$SUDO_UID}"
  else
    DEPLOY_UID="$(id -u)"
    DEPLOY_GID="$(id -g)"
  fi
}

# /opt is typically root-owned, so a brand-new top-level directory needs a one-time sudo
# bootstrap to create and chown it to the running user — same "one-time sudo, nothing after
# needs it" convention as app-config-deployment-foundation.md's service tier. Skipped entirely
# once the directory both exists AND is already owned by us (e.g. a re-run, or /opt/stacks
# itself, which pre-existing sibling stacks already made writable) — checking ownership, not
# just existence, means a directory left root-owned by an interrupted prior run (mkdir
# succeeded, chown didn't) self-heals on the next run instead of permanently masquerading as
# already bootstrapped. sudo is only required, and only checked for, the one time it's about
# to actually be used. $DEPLOY_UID/$DEPLOY_GID are resolved once in main() before this is ever
# called — the real deploy user's ids, not necessarily the ids this process is currently running
# under (see main()'s own comment for why those can differ).
bootstrap_dir() {
  local dir="$1"
  [ -d "$dir" ] && [ -O "$dir" ] && return 0
  command -v sudo >/dev/null 2>&1 \
    || die "$dir doesn't exist (or isn't owned by us) and 'sudo' isn't available to fix it — create it and chown it to $DEPLOY_UID:$DEPLOY_GID yourself, then re-run"
  sudo mkdir -p "$dir"
  sudo chown "$DEPLOY_UID:$DEPLOY_GID" "$dir"
}

# Fetch $2 from $RAW_BASE/$BRANCH/$1 to a temp file, chmod it $3, then move it into place at $4
# atomically — a curl failure (network drop, not just a bad HTTP status) aborts under `set -e`
# right after the curl line, before the mv, so nothing is ever left at the final path but a
# fully-written file.
fetch() {
  local src="$1" mode="$2" dest="$3" tmp
  # Temp file lives in dest's own directory, not the default /tmp — mv is only a true atomic
  # rename within one filesystem, and /tmp is commonly a separate tmpfs from /opt. A cross-
  # filesystem mv falls back to copy-then-unlink, which reopens the exact truncated-file window
  # this function exists to close.
  tmp="$(mktemp -p "$(dirname "$dest")")"
  TMP_FILES+=("$tmp")
  curl -fsSL "$RAW_BASE/$BRANCH/$src" -o "$tmp"
  chmod "$mode" "$tmp"
  chown "$DEPLOY_UID:$DEPLOY_GID" "$tmp"
  mv "$tmp" "$dest"
}

# 32 random bytes as hex via /dev/urandom + od — available on effectively any Linux host,
# unlike openssl/uuidgen, which aren't guaranteed given this script's own stated dependencies
# are just git/curl/docker.
random_token() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

# The "render validates and fails loudly naming the exact field" half of the personal one-answer-
# file rule, applied to the generated stack .env (see CLAUDE.md's recorded deviation for why this
# repo splits params from secrets instead of using one answer file). Re-reads the FILE just
# written — via the same grep '^KEY=' | cut -d= -f2- one-liner bot-ops.sh already uses for
# ADMIN_TOKEN — rather than trusting the in-memory shell vars that built it, so a future bug in the
# STACKENV heredoc itself is caught here too, not just a bad input. Every one of the three fields
# is always absolute today (CONFIG_DIR/STACK_DIR are both built from a fixed /opt/... prefix), so
# this can't actually fire in the current script — it's forward defense against a future change to
# how those paths are built, proven able to fire at all by ops/install.test.ts's synthetic bad file.
validate_stack_env() {
  local file="$1" key value
  for key in BOT_ENV_FILE BOT_OPS_CONFIG_DIR BOT_OPS_COMPOSE_FILE; do
    value="$(grep "^${key}=" "$file" | tail -n1 | cut -d= -f2-)"
    [[ "$value" == /* ]] || die "$key must be an absolute path, got \"$value\""
  done
  value="$(grep '^BOT_OPS_CONFIG_DIR=' "$file" | tail -n1 | cut -d= -f2-)"
  [ -d "$value" ] || die "BOT_OPS_CONFIG_DIR does not exist"
}

main() {
  INSTANCE="${1:-}"
  BRANCH="${2:-main}"
  [[ "$INSTANCE" =~ ^[a-z0-9-]+$ ]] || die "usage: install.sh <instance> [branch] (instance: lowercase letters/digits/hyphens only)"
  [ "$INSTANCE" != "bin" ] || die "'bin' is reserved (it's the shared /opt/rackbops-discord-bot/bin/ scripts dir) — pick a different instance name"

  need git
  need curl
  need docker

  resolve_deploy_identity

  CONFIG_DIR="/opt/rackbops-discord-bot/$INSTANCE"
  BIN_DIR="/opt/rackbops-discord-bot/bin"
  STACK_DIR="/opt/stacks/rackbops-discord-bot-$INSTANCE"
  PROJECT="rackbops-discord-bot-$INSTANCE"

  bootstrap_dir "$CONFIG_DIR"
  bootstrap_dir "$BIN_DIR"
  bootstrap_dir "$STACK_DIR"

  mkdir -p "$CONFIG_DIR/backups"
  chown "$DEPLOY_UID:$DEPLOY_GID" "$CONFIG_DIR/backups"

  if [ -f "$CONFIG_DIR/.env" ]; then
    echo "install: $CONFIG_DIR/.env already exists — leaving your config alone"
  else
    fetch ".env.example" 600 "$CONFIG_DIR/.env"
    # The one secret this tooling generates itself rather than asking you to supply — it isn't
    # tied to any external account, unlike DISCORD_TOKEN/BLIZZARD_CLIENT_SECRET above.
    ADMIN_TOKEN="$(random_token)"
    sed -i "s#^ADMIN_TOKEN=.*#ADMIN_TOKEN=$ADMIN_TOKEN#" "$CONFIG_DIR/.env"
    echo "install: wrote $CONFIG_DIR/.env from .env.example — fill in secrets before starting"
    echo "install: generated ADMIN_TOKEN for the admin panel — paste this into its unlock prompt:"
    echo "install:   $ADMIN_TOKEN"
  fi

  # bin/bot-ops.sh and the compose file are generated, not precious — always refresh them to
  # whatever BRANCH ships, same as .env is never touched. This is the "scripts/descriptors are
  # deployment artifacts, not instance config" split from app-config-deployment-foundation.md.
  fetch "ops/bot-ops.sh" 755 "$BIN_DIR/bot-ops.sh"
  # #173: name the schema this fetch just installed, so an operator can see it side by side with
  # the admin panel's own "bot-ops.sh schema <got> (panel needs <want>)" startup log line. Read
  # from the file just written (not a hardcoded number here) so this can never itself drift from
  # what actually landed on disk.
  bot_ops_schema="$(grep -m1 '^readonly BOT_OPS_SCHEMA=' "$BIN_DIR/bot-ops.sh" | cut -d= -f2)"
  echo "install: wrote $BIN_DIR/bot-ops.sh from $BRANCH (bot-ops schema ${bot_ops_schema:-unknown})"
  fetch "docker-compose.yml" 644 "$STACK_DIR/docker-compose.yml"
  # #178: same pattern as bot-ops.sh's schema line above — read back from the file just written, so
  # an operator can compare this against the panel's own "docker-compose.yml schema <got> (panel
  # needs <want>)" startup log line after a re-run.
  compose_schema="$(grep -m1 '^x-rackbops-schema:' "$STACK_DIR/docker-compose.yml" | cut -d: -f2 | tr -d '[:space:]')"
  echo "install: wrote $STACK_DIR/docker-compose.yml from $BRANCH (Dockge will list this as a managed stack; compose schema ${compose_schema:-unknown})"

  # Split from the emptiness check (rather than one combined `cmd || die`-free line) so a genuine
  # ls-remote failure — network/DNS, not just a bad branch name — is caught here instead of
  # `set -e` aborting the script one line earlier with only git's own bare error on stderr.
  GIT_SHA="$(git ls-remote "$REPO_URL" "refs/heads/$BRANCH" | cut -f1)" \
    || die "couldn't reach $REPO_URL (git ls-remote failed) — check network/DNS and retry"
  [ -n "$GIT_SHA" ] || die "no branch '$BRANCH' found on $REPO_URL — check the branch name"

  # Compose-project .env for $STACK_DIR — NOT $CONFIG_DIR/.env (the bot's own secrets file). This
  # one holds no secrets at all: it's Compose's own interpolation source (loaded automatically from
  # the project directory for every `${VAR}` in docker-compose.yml, entirely separate from the
  # env_file: directive), so Dockge's Start/Stop/Restart buttons and any bare `docker compose`
  # invocation resolve this instance's real container_name/env_file instead of the compose file's
  # monorepo-era fallbacks — closing the gap install.sh's own printed shell-prefix commands never
  # needed in the first place. Generated, not precious — always refreshed, same as bin/bot-ops.sh
  # and the compose file above, and for the same crash-safety reason: temp file first, atomic move.
  # GIT_SHA carries the sha just resolved above rather than blank, so a bot brought up through this
  # fallback alone still reports accurate self-update status; BOT_BUILD_CONTEXT points at the remote
  # branch (not `.`) so even an accidental rebuild through this fallback has a real Dockerfile to
  # build from instead of failing on the stack dir, which holds none.
  STACK_ENV_TMP="$(mktemp -p "$STACK_DIR")"
  TMP_FILES+=("$STACK_ENV_TMP")
  cat > "$STACK_ENV_TMP" <<STACKENV
BOT_ENV_FILE=$CONFIG_DIR/.env
BOT_OPS_CONTAINER=$PROJECT
BOT_OPS_PROJECT=$PROJECT
BOT_OPS_CONFIG_DIR=$CONFIG_DIR
BOT_OPS_COMPOSE_FILE=$STACK_DIR/docker-compose.yml
BOT_BUILD_CONTEXT=$REPO_URL#$BRANCH
GIT_SHA=$GIT_SHA
STACKENV
  mv "$STACK_ENV_TMP" "$STACK_DIR/.env"
  chown "$DEPLOY_UID:$DEPLOY_GID" "$STACK_DIR/.env"
  # Before this write is announced or the (now-shortened) next-steps block prints — a bad render
  # dies here, silently. Earlier steps (the config .env, bin/bot-ops.sh, docker-compose.yml) have
  # already logged their own real successes by this point; this only guards what comes after it.
  validate_stack_env "$STACK_DIR/.env"
  echo "install: wrote $STACK_DIR/.env (Dockge's own interpolation source — see ops/README.md)"

  cat <<EOF

install: next steps for '$INSTANCE'
  1. Edit $CONFIG_DIR/.env — set DISCORD_TOKEN, ANNOUNCE_CHANNEL_ID, and anything else you need.
     Make sure BOT_BRANCH=$BRANCH and GITHUB_REPO=Rackbops/rackbops-discord-bot are set there too,
     so self-update (/update, AUTO_UPDATE) targets the same branch this bootstrap just built.
  2. Bring it up (safe to re-run) — no vars to export: GIT_SHA/BOT_ENV_FILE/BOT_BUILD_CONTEXT/
     BOT_OPS_CONTAINER all resolve from $STACK_DIR/.env, which Compose auto-loads from the
     directory of the -f file below regardless of your shell's own cwd:

     docker compose -f $STACK_DIR/docker-compose.yml -p $PROJECT up -d --build

  3. Day-2 ops (status/logs/restart/env-get/env-set) go through $BIN_DIR/bot-ops.sh with:

     BOT_OPS_CONFIG_DIR=$CONFIG_DIR \\
     BOT_OPS_COMPOSE_FILE=$STACK_DIR/docker-compose.yml \\
     BOT_OPS_PROJECT=$PROJECT \\
     BOT_OPS_CONTAINER=$PROJECT \\
     bash $BIN_DIR/bot-ops.sh status

  4. Optional: the small web admin panel (wraps the same bot-ops.sh operations). Only bring
     this up once Cloudflare Access is set up for this instance (see ops/README.md's Admin
     panel section) — it has no published host port, so until a tunnel routes to it, this
     just starts a sidecar reachable from nothing but the docker network it's on. ADMIN_TOKEN
     and the CLOUDFLARE_ACCESS_*/ADMIN_ALLOWED_EMAILS vars are read out of .env just for this
     one command (not the whole file), so they aren't baked into the image or shown in docker
     inspect. This is not a secrets boundary, though: the admin container bind-mounts the config
     dir read-write (to write admins.json and back up .env), so it can read every secret in .env
     off the filesystem — panel access is effectively deploy/root-equivalent. Fill
     CLOUDFLARE_ACCESS_TEAM_DOMAIN/CLOUDFLARE_ACCESS_AUD into .env in step 1 to
     have the panel verify Access's own signed JWT directly (ADMIN_TOKEN then becomes a
     fallback, not the only check) — leave them blank to keep ADMIN_TOKEN as the sole door-2
     check for now. ADMIN_ALLOWED_EMAILS further narrows which verified identities the JWT
     check accepts; leave it blank to allow any identity Access's own policy already lets
     through. The command below names the admin service explicitly, so it never rebuilds or
     recreates the running bot container:

     ADMIN_TOKEN=\$(grep '^ADMIN_TOKEN=' $CONFIG_DIR/.env | cut -d= -f2-) \\
     CLOUDFLARE_ACCESS_TEAM_DOMAIN=\$(grep '^CLOUDFLARE_ACCESS_TEAM_DOMAIN=' $CONFIG_DIR/.env | cut -d= -f2-) \\
     CLOUDFLARE_ACCESS_AUD=\$(grep '^CLOUDFLARE_ACCESS_AUD=' $CONFIG_DIR/.env | cut -d= -f2-) \\
     ADMIN_ALLOWED_EMAILS=\$(grep '^ADMIN_ALLOWED_EMAILS=' $CONFIG_DIR/.env | cut -d= -f2-) \\
     ADMIN_BUILD_CONTEXT=$REPO_URL#$BRANCH:ops/admin \\
     BOT_OPS_CONFIG_DIR=$CONFIG_DIR \\
     BOT_OPS_COMPOSE_FILE=$STACK_DIR/docker-compose.yml \\
     BOT_OPS_PROJECT=$PROJECT \\
     BOT_OPS_CONTAINER=$PROJECT \\
     docker compose -f $STACK_DIR/docker-compose.yml -p $PROJECT --profile admin up -d --build admin

  5. Optional: expose the bot's local API (currently just the character-linking endpoint — see
     README.md's Character linking section) to the internet via Cloudflare Tunnel, without
     opening any inbound firewall ports. Only useful once WARBANDEER_INGEST_PORT and
     CLOUDFLARE_TUNNEL_TOKEN are set in .env (see README.md's Cloudflare Tunnel section for how
     to create the tunnel and get a token). CLOUDFLARE_TUNNEL_TOKEN is read out of .env just for
     this one command, same as ADMIN_TOKEN above — the cloudflared container never gets the rest
     of your secrets:

     CLOUDFLARE_TUNNEL_TOKEN=\$(grep '^CLOUDFLARE_TUNNEL_TOKEN=' $CONFIG_DIR/.env | cut -d= -f2-) \\
     docker compose -f $STACK_DIR/docker-compose.yml -p $PROJECT --profile tunnel up -d --build cloudflared
EOF
}

main "$@"
