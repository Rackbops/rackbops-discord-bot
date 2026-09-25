<!-- Runbook for Rackbops/rackbops-discord-bot#247 (Epic #236): deploy per-plugin routing to debug, prove
     it, then prod. Written 2026-09-24 against `main` @ `f5346f9`; every cite below was read from that tree.
     Host facts (nucbox, schema 4 -> 5, flock, the `.bak-schema2` backup) are from the issue's comments, not
     re-checked here. Every host command is run by roshne, one per block, in ONE interactive bash shell
     (stage 0 sets variables and a function the later blocks use; a new shell means re-running stage 0). -->

## Runbook — deploy per-plugin routing, prove it, then prod

**What the code says, and why the order below is what it is**

- `install.sh <instance> [branch] [--force-bin]` (`ops/install.sh:14-18`, parsed in `main()` from `:213`). From `main` it takes no flag. It always refreshes the host-shared `bin/bot-ops.sh` (`install_shared_bin`, `:172`) — **shared by prod too** — plus the stack's compose file and stack `.env` (`BOT_BUILD_CONTEXT=…#main`, `GIT_SHA` = main's head, `:320`), and never touches the config `.env`. It does not build or start anything; it prints the two commands used in stages 2 and 3 (`:341`, `:380`).
- The panel checks `bot-ops.sh` schema and compose schema **once, at panel startup** (`checkBotOpsSchemaStartup`, `ops/admin/server.ts:441`; required 5 and 1 at `:769`, `:778`). So the banner clears only after the admin container is recreated **after** install.sh. `env-set`/`restart`/`recreate` need `flock` inside the admin container (`lock_config_dir`, `ops/bot-ops.sh:395`), and the admin image installs no util-linux itself (`ops/admin/Dockerfile`), so it is checked, not assumed.
- **No `routing.json`, or one placing no plugin → `single` mode: exactly today's one PUT to the home guild** (`planRegistration`, `src/routing/register.ts:56-59`; `registerPlan` `:128-131`). It touches no other guild, so the 2026-09-20 hand registration survives stages 1-3 untouched. `discovery.json` is written in both modes (`src/routing/live.ts`), which is where every id in this runbook comes from.
- **Any placement → `routed` mode: one PUT per guild the bot is in** (`register.ts:61-72`). Each guild gets **the core commands** (`report`, `update`, `plugins`) **plus** every plugin living there. An unplaced plugin lives in the home guild only; a placed one lives **exactly** where its `servers` say (`pluginsForGuild`, `src/routing/resolve.ts:40-50`). So placing `music` in Pathfinder alone would **remove it from home**, and every non-home guild gains the core commands. The seed below therefore places a plugin in every guild whose current list holds its commands, and a predictor refuses to go on if the result would differ from today in any guild.
- `routing.json` lives in the bot's data volume at `/app/data/routing.json` (`routingPath`, `src/routing/store.ts:28-30`; `state:/app/data`, `docker-compose.yml:44`; `ROUTING_PATH`, `ops/bot-ops.sh:464`). Shape: `{v:1, updatedAt, updatedBy, plugins:{<name>:{servers:{<guildId>:{commands:"all"|[channelIds], postTo?}}}}, webhooks:{}, results:[]}` (`src/routing/model.ts:26-76`). It is read by shape and repaired, never thrown on; anything dropped is logged as `[routing] routing.json: …; it is ignored` (`store.ts:105-109`). A hand-written file takes effect at the next `applyRouting` — here, a restart (`src/index.ts:258-279`).
- Panel routes: `GET /api/routing` → `bot-ops.sh routing-get` = `{routing, discovery}` (`server.ts:573`); `POST /api/routing`, `POST /api/webhooks` (a pasted URL; the bot asks Discord which channel it is for, `src/routing/requests.ts`), `DELETE /api/webhooks/<channelId>`, `POST /api/discovery/refresh` (`server.ts:2035-2066`). The mailbox is drained every 5 s (`REQUEST_DRAIN_MS`, `src/plugins/drain.ts:11`). A plugin secret goes through `POST /api/env` (`env-set`); `env-get` never lists it and `env-schema` shows only `{secret, isSet}` (`ops/bot-ops.sh` header).
- A command outside its channels gets a private "`/rsetlist` works in <#spotify> here." (`refusalMessage`, `src/routing/gate.ts:74-86`). A post goes through the channel's webhook when `routing.json` has a working one, else as the bot (`src/routing/post.ts:114`).

**Unverified, said once:** that `curl` on nucbox accepts `-H @file` (7.55+); that `DISCORD_TOKEN` in the config `.env` is unquoted (a 401 from stage 4.3 means it is not); that Discord's bulk PUT accepts the normalised capture files used for rollback; that nucbox's `jq` is 1.6+ (`IN`); that compose tags its built images `<project>-bot` / `<project>-admin` (used for image rollback); the music plugin's secret key name. **There is no on-demand way to make `wow` post** (it posts from its own ticks, in the plugins repo), so D3 waits for its next announcement.

**STOP rule:** any output that is not what a step says to expect — stop, paste it back, do not improvise.

### Stage 0 — shell setup and host checks (debug)

```bash
export I=debug
```
```bash
export W=~/e236-247/$I BOT_OPS_CONFIG_DIR=/opt/rackbops-discord-bot/$I BOT_OPS_COMPOSE_FILE=/opt/stacks/rackbops-discord-bot-$I/docker-compose.yml BOT_OPS_PROJECT=rackbops-discord-bot-$I BOT_OPS_CONTAINER=rackbops-discord-bot-$I
```
```bash
mkdir -p "$W"
```
```bash
capture() { local app; app=$(jq -r .bot.id "$W/discovery.json"); for g in $(jq -r '.guilds[].id' "$W/discovery.json") global; do local p="guilds/$g/commands"; [ "$g" = global ] && p=commands; curl -fsS -H @<(printf 'Authorization: Bot %s\n' "$(grep '^DISCORD_TOKEN=' "$BOT_OPS_CONFIG_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '\r"')") -o "$W/raw-$1-$g.json" "https://discord.com/api/v10/applications/$app/$p" && jq -S 'map(del(.id,.application_id,.guild_id,.version)) | sort_by(.name)' "$W/raw-$1-$g.json" > "$W/$1-$g.json" && echo "$1 $g: $(jq length "$W/$1-$g.json") commands" || echo "$1 $g: FAILED"; done; }
```
(Defines a function; prints nothing. The token is read inside a process substitution by `printf`, a builtin, so it is in no argv and never printed.)

```bash
docker exec rackbops-discord-bot-debug-admin flock --version
```
```bash
docker exec rackbops-discord-bot-prod-admin flock --version
```
Expect `flock from util-linux …` from **both** (install.sh replaces the script prod's panel runs too). Paste both. Missing on either → STOP.

```bash
docker inspect -f '{{.Name}} {{.Image}} {{.Config.Image}}' rackbops-discord-bot-$I rackbops-discord-bot-$I-admin | tee "$W/images-before.txt"
```
Paste it: these image ids are the rollback targets of stages 2 and 3.

### Stage 1 — shared script and compose file to `main`

```bash
cp -a /opt/rackbops-discord-bot/bin/bot-ops.sh /opt/rackbops-discord-bot/bin/bot-ops.sh.bak-schema4
```
```bash
cp -a /opt/stacks/rackbops-discord-bot-$I/docker-compose.yml /opt/stacks/rackbops-discord-bot-$I/.env "$W/"
```
```bash
curl -fsSL https://raw.githubusercontent.com/Rackbops/rackbops-discord-bot/main/ops/install.sh | bash -s -- $I
```
Expect `…/.env already exists — leaving your config alone`, `wrote /opt/rackbops-discord-bot/bin/bot-ops.sh from main (bot-ops schema 5)`, `compose schema 1`, then the next-steps text. Paste the `install:` lines.

```bash
bash /opt/rackbops-discord-bot/bin/bot-ops.sh version
```
Expect `{"schema": 5}` (spacing may differ).

**Rollback:** `cp -a /opt/rackbops-discord-bot/bin/bot-ops.sh.bak-schema4 /opt/rackbops-discord-bot/bin/bot-ops.sh`, and copy the two saved files from `$W` back into the stack dir.

### Stage 2 — rebuild the admin panel (clears the banner)

```bash
ADMIN_TOKEN=$(grep '^ADMIN_TOKEN=' $BOT_OPS_CONFIG_DIR/.env | cut -d= -f2-) CLOUDFLARE_ACCESS_TEAM_DOMAIN=$(grep '^CLOUDFLARE_ACCESS_TEAM_DOMAIN=' $BOT_OPS_CONFIG_DIR/.env | cut -d= -f2-) CLOUDFLARE_ACCESS_AUD=$(grep '^CLOUDFLARE_ACCESS_AUD=' $BOT_OPS_CONFIG_DIR/.env | cut -d= -f2-) ADMIN_ALLOWED_EMAILS=$(grep '^ADMIN_ALLOWED_EMAILS=' $BOT_OPS_CONFIG_DIR/.env | cut -d= -f2-) ADMIN_BUILD_CONTEXT=https://github.com/Rackbops/rackbops-discord-bot.git#main:ops/admin docker compose -f $BOT_OPS_COMPOSE_FILE -p $BOT_OPS_PROJECT --profile admin up -d --build admin
```
(install.sh's own printed command, `ops/install.sh:371-380`, with `$I` in place of the paths.) Expect the build, then `Container rackbops-discord-bot-debug-admin Started` (or `Recreated`). Paste the last 5 lines.

```bash
docker exec rackbops-discord-bot-$I-admin flock --version
```
**Person, in the browser:** open bot-dev.rackbops.com — the out-of-date banner is gone and Overview's Needs-attention has no `outdated-files` line. Say so.

**Rollback:** `docker tag <admin image id from images-before.txt> rackbops-discord-bot-$I-admin` then the same command with `--no-build` in place of `--build` (image name unverified — check with `docker images | grep admin` first).

### Stage 3 — update the bot (still single mode: no `routing.json`)

```bash
docker exec rackbops-discord-bot-$I sh -c 'ls -l /app/data/routing.json /app/data/routing.secrets.json 2>&1'
```
Expect `No such file` for both. If `routing.json` exists, STOP: someone already placed a plugin and the seed below would overwrite it.

Resolve `main`'s commit once, and use it both for what is built and for the `GIT_SHA` baked into the image (see [Rebuilding the bot later](#rebuilding-the-bot-later-without-installsh)):

```bash
SHA=$(git ls-remote https://github.com/Rackbops/rackbops-discord-bot.git refs/heads/main | cut -f1); echo "$SHA"
```
Expect one 40-character sha. Empty → STOP.

```bash
GIT_SHA=$SHA BOT_BUILD_CONTEXT=https://github.com/Rackbops/rackbops-discord-bot.git#$SHA docker compose -f $BOT_OPS_COMPOSE_FILE -p $BOT_OPS_PROJECT up -d --build bot
```
Expect the build, then `Container rackbops-discord-bot-debug Recreated`/`Started`. Do **not** touch the panel's placement controls until stage 4 is done.

```bash
[ "$(docker exec rackbops-discord-bot-$I printenv GIT_SHA)" = "$SHA" ] && echo "GIT_SHA ok" || echo "GIT_SHA MISMATCH"
```
Expect `GIT_SHA ok`. `MISMATCH` → the image carries the wrong commit and self-update will misjudge it: STOP.

```bash
docker logs --since 5m rackbops-discord-bot-$I 2>&1 | grep -E 'Registered|\[routing\]|\[startup\]'
```
Expect `Registered N slash commands` (single mode, `src/index.ts:279`) and no `[routing]`/`[startup]` error.

```bash
bash /opt/rackbops-discord-bot/bin/bot-ops.sh routing-get > "$W/routing-get-0.json"
```
```bash
jq '.discovery' "$W/routing-get-0.json" > "$W/discovery.json"
```
```bash
jq '{routing, home: .discovery.homeGuildId, guilds: [.discovery.guilds[] | {id, name, channels: (.channels|length), commands}], plugins: .discovery.plugins}' "$W/routing-get-0.json"
```
Expect `routing: null`, `home` a snowflake (**null → STOP**: without a home server routed mode also empties the global list, a different path), the home guild and "Pathfinder 2E – World of Warcraft" both listed with channels, and `music` in `plugins` with its commands (e.g. `rsetlist`). **Music missing from `plugins` → STOP**: a routed boot would drop the hand-registered music commands. Paste the output. This is also acceptance "GET /api/routing returns both servers with their channels" from the host side; the person repeats it by opening `https://bot-dev.rackbops.com/api/routing` in the signed-in browser.

**Rollback:** `docker tag <bot image id from images-before.txt> rackbops-discord-bot-$I-bot` then the `up` above with `--no-build`.

### Stage 4 — seed `routing.json` that mirrors today, then the first routed boot

```bash
capture before
```
Expect one `before <id>: N commands` line per guild and `before global: N` (normally 0). Any `FAILED` → STOP (401: the token line is quoted; paste nothing from `.env`).

```bash
for g in $(jq -r '.guilds[].id' "$W/discovery.json"); do jq --arg g "$g" '{($g): map(.name)}' "$W/before-$g.json"; done | jq -s add > "$W/names-before.json"
```
```bash
jq -n --slurpfile d "$W/discovery.json" --slurpfile b "$W/names-before.json" '$d[0] as $d | $b[0] as $b | {v: 1, updatedAt: (now | todate), updatedBy: "roshne (hand seed, #247)", webhooks: {}, results: [], plugins: ([$d.plugins | to_entries[] | .key as $p | .value.commands as $c | [$b | to_entries[] | select(any(.value[]; IN($c[]))) | .key] as $gs | select($gs != [] and $gs != [$d.homeGuildId]) | {key: $p, value: {servers: ($gs | map({key: ., value: {commands: "all"}}) | from_entries)}}] | from_entries)}' > "$W/routing.seed.json"
```
The rule, derived only from what Discord and the bot report: a plugin whose commands are registered only in the home guild stays unplaced (it lives there by default); a plugin registered anywhere else is placed, `commands: "all"`, in **every** guild that has it, home included. No `postTo`, so posting is unchanged (`announceTargets`, `resolve.ts:66-74`). The template it produces, for review:
`{"v":1,"updatedAt":"…","updatedBy":"roshne (hand seed, #247)","webhooks":{},"results":[],"plugins":{"music":{"servers":{"<HOME_GUILD_ID>":{"commands":"all"},"<PATHFINDER_GUILD_ID>":{"commands":"all"}}}}}`

```bash
jq -n --slurpfile d "$W/discovery.json" --slurpfile b "$W/names-before.json" --slurpfile s "$W/routing.seed.json" '$d[0] as $d | $b[0] as $b | $s[0] as $s | ($b[$d.homeGuildId] - [$d.plugins[].commands[]]) as $core | [$d.guilds[].id as $g | ($core + [$d.plugins | to_entries[] | select(if $s.plugins[.key] then $s.plugins[.key].servers[$g] != null else $g == $d.homeGuildId end) | .value.commands[]]) as $pred | {guild: $g, same: (($pred | sort) == (($b[$g] // []) | sort)), missing: (($b[$g] // []) - $pred), added: ($pred - ($b[$g] // []))}]'
```
The predictor mirrors `planRegistration` + `pluginsForGuild` by name. Expect `"same": true` for **every** guild. Paste the output and `cat "$W/routing.seed.json"`. **Any `false` → STOP, do not boot:** `added` naming `report`/`update`/`plugins` in Pathfinder means the 2026-09-20 hand registration held only the music commands, and routing will always add the core commands there (ADR-0006 decision 2) — roshne decides whether that is acceptable before going on; `missing` means something would disappear.

```bash
docker exec -i -u bun rackbops-discord-bot-$I sh -c 'cat > /app/data/routing.json.seed && mv /app/data/routing.json.seed /app/data/routing.json' < "$W/routing.seed.json"
```
```bash
bash /opt/rackbops-discord-bot/bin/bot-ops.sh restart
```
```bash
docker logs --since 2m rackbops-discord-bot-$I 2>&1 | grep -E 'Registered|\[routing\]'
```
Expect `Registered commands in N servers (<home>: n, Pathfinder 2E – World of Warcraft: m, …)` (`logRouted`, `live.ts:118-121`), no `couldn't register`, and **no** `it is ignored` line (the seed was read whole).

```bash
capture after
```
```bash
for f in "$W"/before-*.json; do a="${f/before-/after-}"; if cmp -s "$f" "$a"; then echo "$(basename "$f") identical"; else echo "$(basename "$f") DIFFERS"; diff "$f" "$a"; fi; done
```
Expect `identical` for every guild and global — acceptance "guild command lists before and after the first routed boot identical, captured from the Discord API". Paste it. From here the panel owns routing.

**Rollback:** `docker exec rackbops-discord-bot-$I rm /app/data/routing.json`, `bot-ops.sh restart` (home returns to single mode), then for each non-home guild restore its list: `curl -fsS -X PUT -H @<(printf 'Authorization: Bot %s\nContent-Type: application/json\n' "$(grep '^DISCORD_TOKEN=' "$BOT_OPS_CONFIG_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '\r"')") --data @"$W/before-<GUILD_ID>.json" "https://discord.com/api/v10/applications/$(jq -r .bot.id "$W/discovery.json")/guilds/<GUILD_ID>/commands" | jq length` (`<GUILD_ID>` copied from a `before-*.json` file name; the PUT body shape is unverified).

### Stage 5 — the exit demonstration, all through the panel (debug)

Everything below is done by a person at bot-dev.rackbops.com and in Discord, choosing only from pickers; the host blocks only record. Note the clock time of each click.

- **D1 — placement in seconds.** Plugins → music → *Choose where it lives* → in "Pathfinder 2E – World of Warcraft": *Only in chosen channels* → tick `#spotify`. Leave the home server as it is. Expect *Applying…*, then **Live · Applied at …** within ~5-10 s. *Person in Discord:* `/rsetlist` in `#spotify` works; in another channel of that server the private reply is "`/rsetlist` works in #spotify here." Report both, with times.
- **D2 — a secret that cannot be read back.** Plugins → music → set its secret setting (the field the card marks secret) → Apply. Expect *Set* shown, never the value.
- **D3 — webhook and bot posts.** *Person in Discord:* create a webhook on a channel (Channel settings → Integrations → Webhooks → Copy URL). Panel → Servers → that server → *Add a webhook* → paste → it lists `#<channel>`. Plugins → wow → *Posts to* that channel (in the home server, *Anywhere in this server*, so wow's commands do not change). Its next announcement arrives as the webhook. Then point *Posts to* at a channel with no webhook; the next one arrives as the bot. **Needs wow to announce on its own — timing unknown; this is the one acceptance item that may run over the session.**

```bash
bash /opt/rackbops-discord-bot/bin/bot-ops.sh routing-get | jq '{music: .routing.plugins.music, wow: .routing.plugins.wow, webhooks: .routing.webhooks, results: .routing.results[-4:], commands: [.discovery.guilds[] | {name, commands}]}'
```
Expect music's Pathfinder entry `{"commands":["<spotify id>"]}`, the webhook's metadata (no URL), each request `ok: true` with its `at`, and each guild's `commands.at` at or after the routed boot — the record that the 2026-09-20 hand registration is now the panel's.

```bash
for s in env-get env-schema routing-get status; do printf '%s: ' "$s"; bash /opt/rackbops-discord-bot/bin/bot-ops.sh $s | grep -c -F "$(grep '^SPOTIFY_CLIENT_SECRET=' "$BOT_OPS_CONFIG_DIR/.env" | tail -n1 | cut -d= -f2-)"; done
```
(Swap `SPOTIFY_CLIENT_SECRET` for the key D2 set.) Expect `0` after every subcommand — every bot-ops-backed panel route, and `/api/plugins` reads only `status` + `env-get` (`server.ts:1966-1970`). `env-schema` should still show that key as `{"secret":true,"isSet":true}`.

**Rollback:** undo each change from the panel (untick / *Anywhere*, *Remove* the webhook). Nothing here restarts the bot.

### Stage 6 — prod

Same stages with `export I=prod` and a fresh stage 0 (new `$W`; the flock checks are done). Stage 1's install.sh is already done for the shared script — re-run it anyway for prod's compose file and stack `.env`. Stage 4: if the seed has `"plugins": {}` (nothing registered outside home), **do not write it** — single mode is already exactly today; capture before/after a plain restart instead. Then **enable music from the panel** (Plugins → music → On, fill its settings → Apply: one `env-set`, one recreate), and repeat D1-D3 on prod's servers. **Person:** prod's banner is clear.

### Rebuilding the bot later (without install.sh)

The stack `.env` that `install.sh` writes holds **two** build inputs (`ops/install.sh:320-321`):
- `BOT_BUILD_CONTEXT=<repo>#main`, which builds whatever `main` is when the rebuild runs;
- `GIT_SHA=<main's head when install.sh last ran>`, which is frozen.

Compose passes `GIT_SHA` as the image's build arg (`docker-compose.yml:27`), and the Dockerfile bakes it into the bot's environment (`Dockerfile:18-19`). So a plain `up -d --build bot` any time after `install.sh` builds today's `main` but labels it with the old commit.

Self-update compares that label with `main` (`src/update.ts:249-258`). The bot then reports itself stale, `/update` offers an update it doesn't need, and with `AUTO_UPDATE` on it redeploys for nothing. (Found on the #235 close-out, 2026-09-24.)

**So every rebuild without `install.sh` pins both inputs to one resolved commit.** Use Stage 3's three blocks: resolve `SHA`, build with `GIT_SHA=$SHA BOT_BUILD_CONTEXT=<repo>#$SHA`, then check `printenv GIT_SHA`.
- Shell variables take precedence over the stack `.env` in compose's interpolation, which is why the prefix works. The `printenv` check proves it on the host rather than trusting that rule.
- Building from `#$SHA`, not `#main`, closes the race where `main` moves between the `ls-remote` and the build.
- The admin panel needs none of this: it bakes in no commit.
- Re-running `install.sh` also refreshes the stack `.env`, and then a plain rebuild is correct again, until `main` moves.

### Learned on the 2026-09-24 run (debug, then prod)

- **Image names are `rackbops-discord-bot-<instance>-bot` and `rackbops-discord-bot-<instance>-admin`.** That settles the image-rollback line above: `docker tag <sha from images-before.txt> <that name>`, then `up … --no-build`.
- **Debug's Pathfinder predictor said `added: ["rplugins"]`, which roshne accepted.** The 2026-09-20 hand registration had left out `/rplugins`. Routing sends the core commands to every server, but `/rplugins` has `default_member_permissions: "0"`, so only that server's own admins see it. Expect the same on any server that was registered by hand.
- **Prod's bot is in the home server only, so it needs no seed.** Turning a plugin on from the panel saves a placement there, and the bot then says `Registered commands in 1 server`. With one server, that registers the same set of commands.
- **Each instance has its own tunnel container, `rackbops-discord-bot-<instance>-tunnel`**, on that instance's Docker network. In Cloudflare those tunnels are named `rackbops-discord-bot-{dev,prod}-admin`. A plugin's public route goes on that tunnel as `http://rackbops-discord-bot-<instance>:<port>`.
- **`music` needs five settings, not three.** Its three secrets, plus `SPOTIFY_REDIRECT_URI` and `MUSIC_CALLBACK_PORT`. Without the last two, `/setlist` answers "not set up yet".
  - Each instance needs its own redirect URI: dev uses `https://music-dev.rackbops.com/spotify/callback` and prod `https://music.rackbops.com/spotify/callback`, both on port 8790.
  - Each URI must be registered in the Spotify app, and each needs a tunnel route.
  - `curl` on the callback URL returns `400` once the route works.
- **Copying secrets between instances without printing them:** `grep -E '^(KEY1|KEY2)=' /opt/rackbops-discord-bot/debug/.env | BOT_OPS_CONFIG_DIR=/opt/rackbops-discord-bot/prod … bash bot-ops.sh env-set`. It is the same write as the panel's Apply, and it backs up `.env` first.
- **A phantom "1 change needs a restart"** appears when `PLUGINS` in `.env` isn't in the index's alphabetical order. **Discard** is safe. It is fixed in `6949956`.
- **wow posts only on its own schedule** (next: the Tuesday reset), so D3 can take days.
- **A later rebuild must re-pin `GIT_SHA`.** The stack `.env`'s value is frozen at the last `install.sh`. See [Rebuilding the bot later](#rebuilding-the-bot-later-without-installsh).

### What only a person can confirm

The banner; `/rsetlist` working and being refused (the reply is ephemeral); a post arriving as the webhook vs as the bot; the panel never displaying a secret. Everything else above has a host-side record to paste.
