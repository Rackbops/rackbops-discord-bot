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
#   restart       Restart the bot process in place (docker compose restart). No env reload.
#   env-get       Print JSON of the NON-SECRET whitelisted env keys and their current values.
#   env-set       Read KEY=VALUE lines from stdin, validate against the whitelist, back up
#                 .env, apply only real changes, then `up -d --force-recreate` to load them.
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
#   - Secrets (DISCORD_TOKEN, BLIZZARD_CLIENT_SECRET, GITHUB_TOKEN, ...) are deliberately absent
#     from ALLOWED. env-get never reads them out; env-set never writes them. Edit those by hand
#     with nano on the box.
#   - env-set rebuilds .env line-by-line (no sed) so a value can never inject into the file, and
#     comment/blank/secret lines are preserved verbatim.
set -euo pipefail

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
ENV_FILE="$CONFIG_DIR/.env"

# Non-secret keys the panel may read and write. Anything not here is rejected by env-set and
# omitted by env-get. Each key pairs with a validation regex (empty string is always allowed —
# it clears the key back to its documented default).
declare -A ALLOWED=(
  [DISCORD_SERVER_ID]='^[0-9]{5,25}$'
  [ANNOUNCE_CHANNEL_ID]='^[0-9]{5,25}$'
  [RELEASE_ANNOUNCE_CHANNEL_ID]='^[0-9]{5,25}$'
  [REPORT_ROLE_ID]='^[0-9]{5,25}$'
  [ADMIN_USER_IDS]='^[0-9]{5,25}(,[0-9]{5,25})*$'
  # Blizzard realm slugs are lowercase ASCII plus accented Latin letters (7 live EU realms use
  # à/é/ê/ü — e.g. chants-éternels, aggra-português; the other lowercase Latin-1 letters are listed
  # for realms Blizzard may add later). ENUMERATE them — never a range like à-ÿ: env-set can run in
  # the admin container's C locale, where [[ =~ ]] matches byte-wise, so a multibyte range does NOT
  # error — it silently decomposes into an over-broad byte range that wrongly admits ÷ (U+00F7) and
  # other non-slug characters. Each enumerated char is admitted under both C (byte-wise) and UTF-8
  # (char-wise); only the {1,40} bound differs (bytes vs chars), which is moot — real slugs run well
  # under 40. Stays tight otherwise (the value is interpolated into a Blizzard API URL in realm.ts
  # and shown in Discord). REALM_SLUG_RE in ops/admin/public/index.html mirrors this; server.test.ts
  # guards them from drift.
  [WOW_REALM]='^[a-z0-9àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ-]{1,40}$'
  [WOW_REGION]='^(us|eu)$'
  [WATCHED_REPOS]='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)*$'
  # Shape only, not a real-zone check (same philosophy as WOW_REALM above) — the old
  # exactly-one-slash, letters-only pattern both accepted garbage (e.g. "Europe/Pari") and
  # rejected real IANA zones: 3-segment names (America/Argentina/Buenos_Aires,
  # America/Indiana/Indianapolis), hyphens (America/Port-au-Prince), a "+" (Etc/GMT+1), and
  # no-slash names (UTC). The bot's own resolveConfig is the real gate (issue #43): it rejects
  # anything Intl.DateTimeFormat doesn't recognize as a zone, at startup, before this shape check
  # ever gets a chance to be the only thing standing between a typo and a silently-dead scheduler.
  [DMF_TIMEZONE]='^[A-Za-z0-9+_-]+(/[A-Za-z0-9+_-]+){0,2}$'
  [AUTO_UPDATE]='^(true|false)$'
  [BOT_BRANCH]='^[A-Za-z0-9._/-]{1,100}$'
  [COMMAND_PREFIX]='^[a-z0-9_-]{1,20}$'
)

# Display order for env-get's output — a plain indexed array, not ALLOWED's own iteration order,
# which as a bash associative array is unspecified (hash-bucket order, not declaration order).
# Must contain exactly the same keys as ALLOWED; cmd_env_get asserts this so the two can't drift.
ALLOWED_ORDER=(
  DISCORD_SERVER_ID
  ANNOUNCE_CHANNEL_ID
  RELEASE_ANNOUNCE_CHANNEL_ID
  REPORT_ROLE_ID
  ADMIN_USER_IDS
  WOW_REALM
  WOW_REGION
  WATCHED_REPOS
  DMF_TIMEZONE
  AUTO_UPDATE
  BOT_BRANCH
  COMMAND_PREFIX
)

die() { echo "bot-ops: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found on the box"; }

# Current value of a key from .env (empty if unset/absent). Strips the leading `KEY=`.
env_value() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  local line
  line="$(grep -m1 -E "^${key}=" "$ENV_FILE" || true)"
  printf '%s' "${line#*=}"
}

cmd_status() {
  need docker; need jq
  local running status image realm
  running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"
  status="$(docker ps -a --filter "name=^/${CONTAINER}$" --format '{{.Status}}' 2>/dev/null || true)"
  image="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
  # Best-effort: the persisted last-observed realm status (may be absent on a fresh install).
  realm="$(docker exec "$CONTAINER" cat /app/data/state.json 2>/dev/null \
            | jq -r '.realmStatus // ""' 2>/dev/null || true)"
  jq -n --argjson running "${running:-false}" \
        --arg status "$status" --arg image "$image" --arg realm "$realm" \
        '{running: $running, status: $status, image: $image, realmStatus: $realm}'
}

cmd_logs() {
  need docker
  local n="${1:-200}"
  [[ "$n" =~ ^[0-9]+$ ]] || die "logs: N must be a number"
  (( n > LOGS_MAX )) && n="$LOGS_MAX"
  docker logs "$CONTAINER" --tail "$n" 2>&1
}

cmd_restart() {
  need docker
  # BOT_ENV_FILE is compose-YAML interpolation only (env_file: ${BOT_ENV_FILE:-.env}) — a
  # different mechanism from the container's own runtime env, which env_file: itself supplies
  # once that interpolation resolves.
  BOT_ENV_FILE="$ENV_FILE" docker compose -f "$COMPOSE_FILE" -p "$PROJECT" restart 2>&1
  echo "restarted $CONTAINER"
}

cmd_env_get() {
  need jq
  [ -f "$ENV_FILE" ] || die "env-get: $ENV_FILE not found"
  # ALLOWED_ORDER must name exactly ALLOWED's keys, each exactly once — a key added to one and
  # not the other would otherwise silently drop it from the panel (missing from ALLOWED_ORDER) or
  # crash on an unset array element (missing from ALLOWED, present in ALLOWED_ORDER). A duplicate
  # in ALLOWED_ORDER is checked explicitly (not just "same length as ALLOWED") — a length-and-
  # membership check alone would pass for e.g. one key duplicated and a different key dropped,
  # since the count still matches and every listed key still exists in ALLOWED.
  local key
  declare -A seen=()
  for key in "${ALLOWED_ORDER[@]}"; do
    [[ -n "${ALLOWED[$key]+x}" ]] || die "env-get: '$key' is in ALLOWED_ORDER but not ALLOWED"
    [[ -z "${seen[$key]+x}" ]] || die "env-get: '$key' appears more than once in ALLOWED_ORDER"
    seen["$key"]=1
  done
  (( ${#seen[@]} == ${#ALLOWED[@]} )) \
    || die "env-get: ALLOWED_ORDER (${#seen[@]} unique) and ALLOWED (${#ALLOWED[@]}) have drifted"
  local args=()
  for key in "${ALLOWED_ORDER[@]}"; do
    args+=(--arg "$key" "$(env_value "$key")")
  done
  # Build a {KEY: value, ...} object over exactly the allowlisted keys, in ALLOWED_ORDER's order —
  # jq preserves --arg insertion order in $ARGS.named, and the admin panel's front-end renders
  # this object's keys in the order it receives them rather than re-sorting.
  jq -n "${args[@]}" '$ARGS.named'
}

cmd_env_set() {
  need docker; need jq
  [ -f "$ENV_FILE" ] || die "env-set: $ENV_FILE not found"

  # Counters track sizes explicitly: `${#assoc[@]}` on a still-empty associative array trips
  # "unbound variable" under `set -u`, so we never expand a possibly-empty array for its length.
  declare -A CHANGES=()
  local line key val n_changes=0
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    [[ "$line" == *=* ]] || die "env-set: malformed input line (need KEY=VALUE)"
    key="${line%%=*}"
    val="${line#*=}"
    [[ -n "${ALLOWED[$key]+x}" ]] || die "env-set: '$key' is not an editable key"
    if [ -n "$val" ] && [[ ! "$val" =~ ${ALLOWED[$key]} ]]; then
      die "env-set: value for '$key' is invalid"
    fi
    CHANGES["$key"]="$val"
    n_changes=$((n_changes + 1))
  done

  # Reduce to real changes (new value differs from current) — a no-op must not restart the bot.
  declare -A DIFF=()
  local n_diff=0
  if [ "$n_changes" -gt 0 ]; then
    for key in "${!CHANGES[@]}"; do
      if [ "${CHANGES[$key]}" != "$(env_value "$key")" ]; then
        DIFF["$key"]="${CHANGES[$key]}"
        n_diff=$((n_diff + 1))
      fi
    done
  fi
  if [ "$n_diff" -eq 0 ]; then
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

  local backup="$CONFIG_DIR/backups/.env.bak.$(date +%Y%m%d-%H%M%S)"
  # Pin the backup to 0600 rather than inheriting .env's mode. `cp` would copy that mode, which is
  # only safe while .env is itself owner-only — and a .env recreated by hand or by a fresh deploy
  # picks up the umask (0664 under the usual 002) instead. This file holds DISCORD_TOKEN and
  # BLIZZARD_CLIENT_SECRET, so its exposure shouldn't depend on the source being right.
  install -m 600 "$ENV_FILE" "$backup"
  chown "$target_owner" "$backup" \
    || echo "bot-ops: warning: couldn't set backup ownership to $target_owner" >&2

  # Rewrite .env: replace matching KEY= lines in place, preserve everything else verbatim,
  # append any changed key that wasn't already present.
  declare -A APPLIED
  local tmp k
  tmp="$(mktemp)"
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]]; then
      k="${BASH_REMATCH[1]}"
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
  # 0600 outright makes the intent the contract.
  chmod 600 "$ENV_FILE"
  chown "$target_owner" "$ENV_FILE" \
    || echo "bot-ops: warning: couldn't restore .env ownership to $target_owner" >&2

  # Apply: recreate the container so the new env is loaded (a plain restart would not reload it).
  # Deliberately NO --build: a self-update (#879) tags its freshly built image as the same
  # `<project>-bot:latest` compose expects, so recreating without building reuses it. Adding
  # --build here would rebuild from whatever this checkout happens to be on, silently rolling
  # the bot back to older code every time someone edits a setting.
  local recreate_log rc=0
  recreate_log="$(BOT_ENV_FILE="$ENV_FILE" docker compose -f "$COMPOSE_FILE" -p "$PROJECT" up -d --force-recreate 2>&1)" || rc=$?

  local changed_json
  changed_json="$(printf '%s\n' "${!DIFF[@]}" | jq -R . | jq -s .)"
  jq -n --argjson changed "$changed_json" --arg backup "$backup" \
        --argjson ok "$([ "$rc" -eq 0 ] && echo true || echo false)" \
        --arg log "$recreate_log" \
        '{ok: $ok, changed: $changed, recreated: true, backup: $backup, log: $log}'
  return "$rc"
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
    env-get) cmd_env_get ;;
    env-set) cmd_env_set ;;
    *) die "usage: bot-ops.sh {status|logs [N]|restart|env-get|env-set}" ;;
  esac
}

main "$@"
