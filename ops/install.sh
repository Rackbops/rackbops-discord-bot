#!/usr/bin/env bash
#
# install.sh — bootstrap a fresh rackbops-discord-bot instance with no checkout on the host:
# just git, docker, and curl. Curl-able:
#
#   curl -fsSL https://raw.githubusercontent.com/roshne/rackbops-discord-bot/main/ops/install.sh \
#     | bash -s -- debug
#
# Usage: install.sh <instance> [branch]
#   <instance>   Instance name (lowercase/digits/hyphens), e.g. "debug" or "prod".
#   [branch]     BOT_BRANCH to build from and fetch templates from (default: main).
#
# Creates, if not already present:
#   /opt/rackbops-discord-bot/<instance>/.env       from .env.example — fill in secrets by hand
#   /opt/rackbops-discord-bot/<instance>/backups/    ops/bot-ops.sh env-set's backup target
# Always refreshes (never touches .env — same "generated vs. precious" split as the answer-file
# convention this follows; bin/ and the compose file are scripts/deployment descriptors, shared
# per host, not instance config):
#   /opt/rackbops-discord-bot/bin/bot-ops.sh
#   /opt/stacks/rackbops-discord-bot-<instance>/docker-compose.yml
#
# Every fetched file is written to a temp file first, then moved into place atomically — a
# dropped connection mid-download leaves nothing at the final path rather than a truncated file
# that a later run's existence-check would mistake for real config.
#
# Deliberately does NOT run the initial `up -d --build` itself — that needs BOT_ENV_FILE and
# GIT_SHA resolved from values only you can supply (secrets filled in, the branch to pin) and is
# printed at the end for you to run once .env is ready, not fired unattended against a live host.
set -euo pipefail

REPO_URL="https://github.com/roshne/rackbops-discord-bot.git"
RAW_BASE="https://raw.githubusercontent.com/roshne/rackbops-discord-bot"

die() { echo "install: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found — install it first"; }

INSTANCE="${1:-}"
BRANCH="${2:-main}"
[[ "$INSTANCE" =~ ^[a-z0-9-]+$ ]] || die "usage: install.sh <instance> [branch] (instance: lowercase letters/digits/hyphens only)"

need git
need curl
need docker

CONFIG_DIR="/opt/rackbops-discord-bot/$INSTANCE"
BIN_DIR="/opt/rackbops-discord-bot/bin"
STACK_DIR="/opt/stacks/rackbops-discord-bot-$INSTANCE"
PROJECT="rackbops-discord-bot-$INSTANCE"

mkdir -p "$CONFIG_DIR/backups" "$BIN_DIR" "$STACK_DIR"

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
  curl -fsSL "$RAW_BASE/$BRANCH/$src" -o "$tmp"
  chmod "$mode" "$tmp"
  mv "$tmp" "$dest"
}

if [ -f "$CONFIG_DIR/.env" ]; then
  echo "install: $CONFIG_DIR/.env already exists — leaving your config alone"
else
  fetch ".env.example" 600 "$CONFIG_DIR/.env"
  echo "install: wrote $CONFIG_DIR/.env from .env.example — fill in secrets before starting"
fi

# bin/bot-ops.sh and the compose file are generated, not precious — always refresh them to
# whatever BRANCH ships, same as .env is never touched. This is the "scripts/descriptors are
# deployment artifacts, not instance config" split from app-config-deployment-foundation.md.
fetch "ops/bot-ops.sh" 755 "$BIN_DIR/bot-ops.sh"
echo "install: wrote $BIN_DIR/bot-ops.sh from $BRANCH"
fetch "docker-compose.yml" 644 "$STACK_DIR/docker-compose.yml"
echo "install: wrote $STACK_DIR/docker-compose.yml from $BRANCH (Dockge will list this as a managed stack)"

# Split from the emptiness check (rather than one combined `cmd || die`-free line) so a genuine
# ls-remote failure — network/DNS, not just a bad branch name — is caught here instead of
# `set -e` aborting the script one line earlier with only git's own bare error on stderr.
GIT_SHA="$(git ls-remote "$REPO_URL" "refs/heads/$BRANCH" | cut -f1)" \
  || die "couldn't reach $REPO_URL (git ls-remote failed) — check network/DNS and retry"
[ -n "$GIT_SHA" ] || die "no branch '$BRANCH' found on $REPO_URL — check the branch name"

cat <<EOF

install: next steps for '$INSTANCE'
  1. Edit $CONFIG_DIR/.env — set DISCORD_TOKEN, ANNOUNCE_CHANNEL_ID, and anything else you need.
     Make sure BOT_BRANCH=$BRANCH and GITHUB_REPO=roshne/rackbops-discord-bot are set there too,
     so self-update (/update, AUTO_UPDATE) targets the same branch this bootstrap just built.
  2. Bring it up (safe to re-run):

     GIT_SHA=$GIT_SHA \\
     BOT_ENV_FILE=$CONFIG_DIR/.env \\
     BOT_BUILD_CONTEXT=$REPO_URL#$BRANCH \\
     BOT_OPS_CONTAINER=$PROJECT \\
     docker compose -f $STACK_DIR/docker-compose.yml -p $PROJECT up -d --build

  3. Day-2 ops (status/logs/restart/env-get/env-set) go through $BIN_DIR/bot-ops.sh with:

     BOT_OPS_CONFIG_DIR=$CONFIG_DIR \\
     BOT_OPS_COMPOSE_FILE=$STACK_DIR/docker-compose.yml \\
     BOT_OPS_PROJECT=$PROJECT \\
     BOT_OPS_CONTAINER=$PROJECT \\
     bash $BIN_DIR/bot-ops.sh status
EOF
