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
#   env-get       Print JSON of the NON-SECRET whitelisted env keys and their EFFECTIVE values —
#                 .env read the way compose's env_file loader reads it (see load_env_values).
#   env-set       Read KEY=VALUE lines from stdin, refuse any key outside the whitelist, diff each
#                 remaining one against the effective value, validate the FORMAT of only the ones
#                 that change, back up .env, apply those changes, then `up -d --force-recreate`.
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
#     comment/blank/secret lines are preserved verbatim. An indented or `export`ed line for a key
#     being changed is rewritten in place as plain `KEY=`.
#   - env-set diffs BEFORE it validates a value's FORMAT, and validates only what changes (issue
#     #44) — whitelist MEMBERSHIP is still checked for every submitted key regardless. Format-
#     validating every submitted line first meant one stored value the bot accepts but a regex
#     here rejects failed every save that echoed it back, naming a key the operator never touched.
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
# it clears the key back to its documented default) EXCEPT the keys named in REQUIRED below, which
# have no default to clear back to.
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
  # `PLUGINS=` selects which plugins to install (operator-controlled, panel-edited): a bare `name`
  # or `name@version` to pin, comma-separated; empty = no plugins. The manifest-declared env keys of
  # the plugins named here are merged into this whitelist at runtime by load_plugin_keys, so a
  # plugin's own key (e.g. WARBANDEER_INGEST_PORT, a static row here until #100 removed the baked-in
  # connector) is validated with the FORMAT the Plugin Index carries rather than hand-mirrored per
  # plugin. `name` is `^[a-z][a-z0-9-]*$` (registry.ts); the `@version` tail allows any npm range char.
  [PLUGINS]='^[a-z][a-z0-9-]*(@[0-9][0-9A-Za-z.+-]*)?(,[a-z][a-z0-9-]*(@[0-9][0-9A-Za-z.+-]*)?)*$'
  # Where the bot fetches the Plugin Index from: an http(s) URL, a file:// URL, or a bare absolute
  # path (config.ts accepts all three; empty clears back to the published default).
  [PLUGIN_INDEX_URL]='^(https?://[^[:space:]]+|file://[^[:space:]]+|/[^[:space:]]+)$'
)

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
  PLUGINS
  PLUGIN_INDEX_URL
)

die() { echo "bot-ops: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found on the box"; }

# A self-update (#879) briefly runs the replacement alongside the original under
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
# Known, DECLINED-for-now residual risk (found in review, tracked on #85 rather than fixed here):
# retireOriginal's own stopContainer call is unguarded on a genuine first attempt (redeploy.ts)
# — if the daemon actually stops the original but the HTTP response is lost in transit (the exact
# scenario takeOver's own comment already names), that throw crashes the REPLACEMENT process
# rather than completing the swap. `docker ps` (no -a) then correctly reports the original as not
# running — this guard reads that as safe — while the crashed replacement is mid-reboot (a real
# Bun process + gateway reconnect, low seconds, not "two more daemon calls") retrying the whole
# handoff. An env-set landing in THAT window can still produce a genuine two-live-bots outcome.
# This is the same restart-policy/crash-proofing family of race as #85's `unless-stopped`
# resurrection issue, not a gap specific to this guard's own signal — fixing it here without also
# fixing #85 would be treating one symptom of a shared root cause.
guard_no_handoff_in_progress() {
  docker ps -a --filter "name=^/${CONTAINER}-next$" --format '{{.Names}}' 2>/dev/null | grep -q . || return 0
  if docker ps --filter "name=^/${CONTAINER}$" --format '{{.Names}}' 2>/dev/null | grep -q .; then
    die "a self-update is in progress (container '${CONTAINER}-next' exists and '${CONTAINER}' is still running) — try again once it completes"
  fi
}

# One .env definition line: optional indentation, an optional `export ` prefix, the key, `=`, the
# raw value. Shared by load_env_values (which reads .env) and cmd_env_set's rewrite (which
# replaces lines in it), so the two can never disagree about which lines define a key.
readonly ENV_LINE_RE='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$'

# The effective value of every key in .env, read ONCE per invocation into ENV_VALUES the way
# compose's `env_file:` loader reads the same file — checked against `docker compose config`
# (Compose 2.40) on the box, issue #44 — so env-get shows, and env-set diffs against, what the
# bot is actually running with:
#   - the LAST occurrence of a key wins (the old `grep -m1` took the first);
#   - an `export KEY=...` line defines KEY, indented or not (both used to be invisible);
#   - surrounding whitespace is trimmed — which also drops a CRLF-saved file's trailing "\r",
#     previously leaked into every value;
#   - then ONE layer of matching "..." or '...' is stripped. An unterminated quote is left as-is:
#     compose refuses to load such a file at all ("unterminated quoted value"), so raw is the
#     honest reading, and saving that key rewrites it unquoted — which repairs the file.
# Deliberately NOT modelled, though compose does these too: an inline ` # comment`, `${VAR}`
# interpolation, whitespace around the `=`, a `KEY: value` colon separator, and backslash escapes
# inside double quotes. Nothing env-set writes can produce them (no ALLOWED regex admits `#`, `$`,
# `:`, `\`, or whitespace); a hand-edit that does shows raw in the panel and normalises on the
# next save of that key, as before.
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

# The env keys the INSTALLED plugins declare — merged into env-get's listing and env-set's
# whitelist so the panel manages a plugin's own keys (e.g. WARBANDEER_INGEST_PORT) without this
# script hand-mirroring each plugin. `secret` keys are dropped entirely — never listed, never
# editable, exactly like the core secrets. Manifest order is preserved (PLUGIN_KEY_ORDER);
# PLUGIN_FORMAT / PLUGIN_REQUIRED carry each key's validation.
PLUGIN_KEY_ORDER=()
declare -A PLUGIN_FORMAT=()
declare -A PLUGIN_REQUIRED=()
# "none" (no plugins enabled — no docker read attempted), "ok", or "index unavailable" (the bot
# isn't running or hasn't cached the index yet — env-get then shows static keys only, never errors).
PLUGIN_KEYS_STATUS="none"

# Populate PLUGIN_KEY_ORDER / PLUGIN_FORMAT / PLUGIN_REQUIRED from the container's cached index,
# restricted to the plugins named in this instance's own PLUGINS value. Requires load_env_values to
# have run (reads the effective PLUGINS). Runs in the CURRENT shell — a command/process substitution
# would lose the globals it sets to a subshell — so it reads docker's output into a variable and
# parses it via a here-string. No plugins enabled → returns immediately WITHOUT touching docker, so
# an instance with no plugins pays nothing (and every pre-#101 test, none of which set PLUGINS, sees
# no new docker call). A missing/unreadable/invalid index is "unavailable", never an error (D3).
load_plugin_keys() {
  PLUGIN_KEY_ORDER=()
  PLUGIN_FORMAT=()
  PLUGIN_REQUIRED=()
  PLUGIN_KEYS_STATUS="none"
  local plugins_val names_json raw rows key format required secret
  plugins_val="$(env_value PLUGINS)"
  [ -n "$plugins_val" ] || return 0
  PLUGIN_KEYS_STATUS="ok"
  # PLUGINS is `name(@version)?(,…)*`; the index is keyed by bare name, so drop any @version pin.
  names_json="$(printf '%s' "$plugins_val" \
                | jq -R 'split(",") | map(split("@")[0] | select(length > 0))')"
  raw="$(docker exec "$CONTAINER" cat "$PLUGIN_INDEX_PATH" 2>/dev/null || true)"
  if [ -z "$raw" ] || ! printf '%s' "$raw" | jq -e . >/dev/null 2>&1; then
    PLUGIN_KEYS_STATUS="index unavailable"
    return 0
  fi
  # Each env key as four RAW lines (key, format, required, secret), NOT @tsv: jq's TSV encoder
  # escapes a backslash, which an ERE `format` may legitimately carry (`\.`), and the bash reader
  # would then see it doubled; raw lines pass the regex through verbatim (a `format` never spans
  # lines). `.index.plugins` is the cache wrapper, not a bare `.plugins`.
  #
  # The `jq -e .` check above only proves valid JSON — NOT that `.index` is an object or that each
  # `.env` element is one (the bot's own isValidPluginIndex checks only `Array.isArray(env)`, so a
  # manifest it accepts and caches can still be wrong-shaped here). Guard both shapes inside the
  # program — a non-object plugin or env entry, or one missing a string key/format, is skipped so the
  # well-formed keys still list — and treat a program error (`.index` being a non-object, which
  # `.index.plugins` can't index) as "index unavailable" via `2>/dev/null` + the `if !`, rather than
  # letting pipefail + set -e abort the whole env-get/env-set. Same posture cmd_status takes for
  # state.json; without it a valid-JSON-but-wrong-shape cached index crashes ops (a D3 violation).
  if ! rows="$(printf '%s' "$raw" | jq -r --argjson names "$names_json" '
    (.index.plugins // [])
    | map(select((type == "object") and (.name as $n | $names | index($n))))
    | .[].env[]?
    | select((type == "object") and (.key | type == "string") and (.format | type == "string"))
    | (.key, .format, (.required // false | tostring), (.secret // false | tostring))
  ' 2>/dev/null)"; then
    PLUGIN_KEYS_STATUS="index unavailable"
    return 0
  fi
  while IFS= read -r key && IFS= read -r format && IFS= read -r required && IFS= read -r secret; do
    # jq.exe on a Windows dev box emits CRLF, so each field carries a trailing "\r" that a native
    # Linux jq never adds; strip it (a no-op on Linux) the same way load_env_values strips a
    # CRLF-saved .env — else the key names and the `secret`/`required` flags are all "…\r".
    key="${key%$'\r'}"
    format="${format%$'\r'}"
    required="${required%$'\r'}"
    secret="${secret%$'\r'}"
    [ -n "$key" ] || continue
    [ "$secret" = "true" ] && continue                # secret keys: never listed or edited
    [[ -n "${PLUGIN_FORMAT[$key]+x}" ]] && continue   # a key declared twice: first wins
    PLUGIN_KEY_ORDER+=("$key")
    PLUGIN_FORMAT["$key"]="$format"
    PLUGIN_REQUIRED["$key"]="$required"
  done <<< "$rows"
}

cmd_status() {
  need docker; need jq
  local running status image realm plugins
  running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"
  status="$(docker ps -a --filter "name=^/${CONTAINER}$" --format '{{.Status}}' 2>/dev/null || true)"
  image="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
  # Best-effort: the persisted last-observed realm status (may be absent on a fresh install).
  realm="$(docker exec "$CONTAINER" cat /app/data/state.json 2>/dev/null \
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
  load_env_values
  local args=()
  for key in "${ALLOWED_ORDER[@]}"; do
    args+=(--arg "$key" "$(env_value "$key")")
  done
  # After the static keys, append each INSTALLED plugin's non-secret env keys in manifest order, so
  # the panel's config form renders them (e.g. WARBANDEER_INGEST_PORT once the warbandeer plugin is
  # installed) — read from the container's cached index by load_plugin_keys, never hand-mirrored.
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
  # here we just say on stderr why a configured plugin's keys aren't being shown.
  if [ "$PLUGIN_KEYS_STATUS" = "index unavailable" ]; then
    echo "bot-ops: plugins: index unavailable — showing static keys only (the bot isn't running or hasn't cached the Plugin Index yet)" >&2
  fi
  # Build a {KEY: value, ...} object over the static keys then the installed plugins' keys, in that
  # order — jq preserves --arg insertion order in $ARGS.named, and the admin panel's front-end
  # renders this object's keys in the order it receives them rather than re-sorting.
  jq -n "${args[@]}" '$ARGS.named'
}

cmd_env_set() {
  need docker; need jq
  guard_no_handoff_in_progress
  [ -f "$ENV_FILE" ] || die "env-set: $ENV_FILE not found"

  # Every REQUIRED key must also be an ALLOWED one — same drift worry as ALLOWED_ORDER vs ALLOWED
  # in cmd_env_get: a typo here would otherwise silently never enforce that key.
  local rkey
  for rkey in "${!REQUIRED[@]}"; do
    [[ -n "${ALLOWED[$rkey]+x}" ]] || die "env-set: '$rkey' is in REQUIRED but not ALLOWED"
  done

  # Merge in each INSTALLED plugin's declared env keys (from the container's cached index) so the
  # whitelist below accepts them alongside the static ALLOWED set — read once, up front. Needs the
  # effective PLUGINS value, so load .env first. No plugins → no docker read (load_plugin_keys
  # short-circuits), a no-op on an instance with no plugins. The manifest reflects the CURRENTLY
  # installed plugins: a plugin's own key becomes editable only once that plugin is in PLUGINS and
  # the bot has cached the index, not in the same save that first adds the plugin.
  load_env_values
  load_plugin_keys

  # Counters track sizes explicitly: `${#assoc[@]}` on a still-empty associative array trips
  # "unbound variable" under `set -u`, so we never expand a possibly-empty array for its length.
  declare -A SUBMITTED=()
  local -a submitted_order=()
  local line key val n_submitted=0
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
    # editable if it is a static ALLOWED key OR an installed plugin's own non-secret key; a
    # plugin's `secret` key was dropped from PLUGIN_FORMAT, so it is refused here exactly like a
    # core secret.
    [[ -n "${ALLOWED[$key]+x}" || -n "${PLUGIN_FORMAT[$key]+x}" ]] || die "env-set: '$key' is not an editable key"
    [[ -n "${SUBMITTED[$key]+x}" ]] || submitted_order+=("$key")
    SUBMITTED["$key"]="$val" # a key repeated on stdin: last wins, like .env itself
    n_submitted=$((n_submitted + 1))
  done

  # Reduce to real changes (new value differs from the EFFECTIVE current value — see
  # load_env_values) and validate only those, in submission order. The order matters (issue
  # #44): validating every submitted line first meant a stored value the bot accepts but a regex
  # here rejects — a hand-quoted realm, a CRLF-saved file, `1, 2` in ADMIN_USER_IDS — failed every
  # save that echoed it back, naming a key the operator never touched. A value that isn't
  # changing was never this script's to judge. A no-op must not restart the bot.
  load_env_values
  declare -A DIFF=()
  local n_diff=0 fmt is_required
  if [ "$n_submitted" -gt 0 ]; then
    for key in "${submitted_order[@]}"; do
      val="${SUBMITTED[$key]}"
      [ "$val" != "$(env_value "$key")" ] || continue
      # Format + required-ness come from the static ALLOWED set, or from the installed plugin's
      # manifest entry for a plugin-owned key (a static key wins if somehow both name it).
      if [[ -n "${ALLOWED[$key]+x}" ]]; then
        fmt="${ALLOWED[$key]}"
        is_required="${REQUIRED[$key]+x}"
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
      n_diff=$((n_diff + 1))
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
