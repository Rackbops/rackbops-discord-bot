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

`DISCORD_SERVER_ID`, `ANNOUNCE_CHANNEL_ID`, `RELEASE_ANNOUNCE_CHANNEL_ID`, `REPORT_ROLE_ID`,
`ADMIN_USER_IDS`, `WOW_REALM`, `WOW_REGION`, `WATCHED_REPOS`, `DMF_TIMEZONE`, `AUTO_UPDATE`,
`BOT_BRANCH`, `COMMAND_PREFIX` — listed in `ALLOWED_ORDER`, the order the admin panel displays
them in (`DISCORD_SERVER_ID` first deliberately; see `ops/bot-ops.sh`). Each is validated
against a format regex; an empty value clears the key back to its documented default.

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

## Admin panel

A small per-instance web panel (`ops/admin/`) — a thin, authenticated wrapper around this
script's own five operations, nothing more. Built primarily to sidestep the `ops.json` gap
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

   **Optional narrowing — the admin allow-list.** Restricts which *verified* identities the JWT
   check accepts, on top of whatever Cloudflare Access's own edge policy already allows through.
   Useful when an Access application's policy is shared across several tools — e.g. the same
   "Allow trusted users" policy might also gate Dockge — and you want a narrower set of people
   able to act on this bot specifically. It's the union of two sources: **`ADMIN_ALLOWED_EMAILS`**
   (comma-separated, in `.env`) — the permanent *bootstrap* floor, editable only on the box — plus
   a **dynamic list managed live from the panel's Admins section**, persisted to `admins.json`
   beside `.env`. With both empty there's no narrowing (any identity Access already let through
   authorizes); adding even one admin (env or panel) turns narrowing on. You can't lock everyone
   out: bootstrap admins can't be removed from the panel, you can't remove yourself, and — when
   there's no bootstrap floor at all — the panel refuses to remove the last remaining admin
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

**What it exposes — `bot-ops.sh`'s five operations plus a few read-only or self-contained,
server-native routes:** `GET /api/status`, `GET /api/logs?n=`, `POST /api/restart`, `GET /api/env`,
`POST /api/env`, `GET /api/whoami` (reflects the requester's own verified Access identity — who
they're signed in as, plus the JWT's claims for the panel's Identity view), and
`GET/POST/DELETE /api/admins` (the panel-managed dynamic admin list — see the narrowing note
above), and `GET /api/branches` (the configured repo's branches, for the `BOT_BRANCH` chooser). The
`/api/whoami`, `/api/admins`, and `/api/branches` routes never shell out to `bot-ops.sh`;
`/api/admins` manages only this panel's own allow-list, never the Cloudflare Access policy. State-changing
routes (the POSTs/DELETE) are additionally guarded against cross-site forgery by an Origin check —
which relies on `cloudflared` forwarding the public hostname as the `Host` header (the ingress
rule's `httpHostHeader`, which the `install.sh`/tunnel setup already sets); don't rewrite it to
the internal origin or same-origin browser writes would be wrongly blocked.
No rebuild/deploy capability lives here — that stays Discord's `/update`. The config form on the
page is rendered from whatever `GET /api/env` returns, so it can never drift from this script's own
`ALLOWED` whitelist above. A few fields render as constrained controls instead of free text:
`WOW_REGION`/`AUTO_UPDATE` as selects, `DMF_TIMEZONE` as an IANA-zone datalist, `WOW_REALM` as a
region-filtered realm chooser and `BOT_BRANCH` as a live branch chooser (both below), and
`ADMIN_USER_IDS`/`WATCHED_REPOS` as chip/tag editors.

**The `WOW_REALM` chooser** reads a static, bundled `public/realms.json` (served at `GET
/realms.json` — non-secret data, public at that layer like the page itself) and filters it to the
region `WOW_REGION` is currently set to. The panel never calls Blizzard at request time. That file
is regenerated locally, by hand, about once a year (WoW realm lists change that rarely) with
`bun run ops/tools/gen-realms.ts` — a script that lives outside `ops/admin/` (so it's never in the
deployed image and adds no dependency to it), reads Blizzard client creds from
`R:\repos\secrets\BattleNetAPI-secrets.json` (`ID`/`SECRET`), and calls the realm-index endpoint
via the `roshne/battlenet-api-research` client, writing every slug it returns (accented EU slugs
included). The chooser then offers only slugs `bot-ops.sh`'s `WOW_REALM` regex accepts — lowercase
ASCII plus accented Latin letters, so EU realms like `chants-éternels` and `aggra-português` are
offered — never suggesting a realm the server would reject. (`REALM_SLUG_RE` in `index.html` is a
hand-duplicated mirror of that regex; `ops/admin/server.test.ts` guards the two against drift.) If
`realms.json` is absent, `WOW_REALM` gracefully falls back to a plain text input.

**The `BOT_BRANCH` chooser** lists the configured repo's live branches (branches change far too
often for a static list) via `GET /api/branches`, which calls the GitHub API server-side.
`GITHUB_REPO` and `GITHUB_TOKEN` are read on demand from the mounted `.env` — never from this
container's environment (so the token never appears in `docker inspect`), which also means a
`GITHUB_REPO` edited in `.env` on the box is picked up without restarting the admin service. The
token is optional: a public repo lists unauthenticated (just at a lower rate limit), and the result
is cached ~5 minutes so repeated loads don't burn the limit. The chooser offers a blank
"— default (main) —" option (an empty `BOT_BRANCH` is valid and defaults to `main`) and only lists
branch names `bot-ops.sh` accepts (`^[A-Za-z0-9._/-]{1,100}$`); a stored value that isn't a current
branch (a since-deleted branch) is still shown as its own option. If the lookup fails, `BOT_BRANCH`
falls back to a plain text input.

**Bringing it up** — opt-in via compose's `admin` profile, deploy-only (needs the same
`BOT_OPS_CONFIG_DIR`/`BOT_OPS_COMPOSE_FILE`/`BOT_OPS_PROJECT`/`BOT_OPS_CONTAINER` values as
`bot-ops.sh` itself; `ops/install.sh`'s printed output includes the exact command, which names
the `admin` service explicitly so it never rebuilds or recreates the running `bot` container).
It runs as its own sidecar, independent of the bot process's lifecycle — if the bot crashes, the panel
stays up to show that and let you restart it. No published host port: it's reachable only via
the `cloudflared` sidecar on the same compose network, which is itself gated by Access — so
until a tunnel actually routes to it, bringing the profile up just starts a service nothing
outside that network can reach.
