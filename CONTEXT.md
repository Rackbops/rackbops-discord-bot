# warbandeer-discord — Code Context

> **Purpose:** Discord bot (Bun + TypeScript, discord.js v14) for the guild channel:
> DMF open/close + reset timers (`/dmf`, `/reset`), weekly-reset announcement, a
> continuous realm up/down watch via the Blizzard API (`/status`), GitHub release
> announcements for watched repos, and a `/report` command that files GitHub issues from Discord.
>
> **Fork.** Extracted with full history from [nazumods/wow](https://github.com/nazumods/wow)'s
> `apps/warbandeer-discord` — designed and built there by
> [Nazuraki](https://github.com/nazumods), who gets full credit for the original bot and
> every gotcha documented below. This repo is now the bot's own root (no monorepo, no addon
> release pipeline); self-update was repointed at this fork accordingly — see the **Fork
> gotchas** entry below for what's still open.

## File Map

| File | Responsibility |
|---|---|
| `src/index.ts` | Client login (Guilds intent only), then `activate()` — slash-command registration (guild if `DISCORD_SERVER_ID`, else global), the interaction routes (chat commands → `handleCommand`, `/report` modal submits → `handleReportModal`), the scheduler, and `reportUpdateOutcome()` fired un-awaited (an owed `/update` follow-up must not delay startup). Under `bootMode() === "standby"` (#879) it logs in and attaches **none** of that until `takeOver()` has retired the original — both instances hold the same token and Discord delivers events to both sessions, so a standby with handlers would double every reply. A standby that never reaches `ClientReady` inside `VERIFY_DEADLINE_MS` writes a `failed` marker and exits 1, so the original gets a reason rather than a timeout |
| `src/config.ts` | Env config from `.env` — pure `resolveConfig(env)` (exported for tests) + the `config` singleton resolved from `process.env`; throws at import time on missing required vars or an invalid `COMMAND_PREFIX`. Also the `/report` project→repo map (`REPORT_PROJECTS` + `repoForProject`) + `reportRoleId`, the release-watch list (`watchedRepos` from `WATCHED_REPOS`, comma-separated `owner/repo`, defaulting to `[githubRepo]` — distinct from `githubRepo`, which anchors self-update), and the self-update config (`gitSha`, `botBranch`, `autoUpdate`, `adminUserIds`) |
| `src/commands.ts` | `/dmf`, `/reset`, `/status`, `/update`, `/report` command builders + dispatch; `cmd(name)` builds every command under `config.commandPrefix`, `bareName()` strips it back off on dispatch; `isAdmin()` allowlist gate for `/update`; `updateReply(decision, latestSha, { runningSha, reason, redeploy })` (exported for tests) renders the `/update` acknowledgement — a `redeploy` result present at all means the swap **failed**, since a successful one never returns to reply (the replacement retires this process and delivers the ✅ itself) — the running sha is a **parameter, not a `config` read**, because config resolves env at import time and is one singleton for the whole bun test process, so a formatter reading it is only testable by winning a race with whichever test file imports config first; dispatch passes the interaction's user/channel/application/token to `checkForUpdate` as the follow-up requester; Discord `<t:…>` timestamp helpers |
| `src/report.ts` | `/report` flow: role gate (reads roles from the interaction — no Members intent), Title/Description modal, then `createIssue` in the mapped repo labeled `automated`; `reportBody` footer names the reporter (plain username, no mention); pure `reportAnnouncement()` renders the channel-visible confirmation (reporter, `repo#N` + url, title, description clamped to Discord's 2000-char cap with a truncation note) |
| `src/announce.ts` | 60 s tick scheduler: DMF-open (`checkDmf` is a thin wrapper around `decideDmfAnnouncement`, mirroring `checkRealm`/`checkReleases`'s delegation to a pure decide function) + weekly-reset announcements, continuous realm up/down watch (`checkRealm`, polls every `REALM_POLL_GAP_MS` = 2 min whenever `realmWatchConfigured()`), release polling (`checkReleases` loops `config.watchedRepos`, isolating each repo's failure via a per-repo try/catch so one bad repo can't starve the others; a repo `fetchReleases` reports unreachable is skipped without touching its seen-id list — so it seeds silently if it returns — and warns only on the edge, via the module-level `releaseReachability` log); routes per `AnnounceKind` via `channelFor()` — releases → `RELEASE_ANNOUNCE_CHANNEL_ID` (falls back to `ANNOUNCE_CHANNEL_ID`), everything else → `ANNOUNCE_CHANNEL_ID` |
| `src/config.test.ts` | bun tests for `resolveConfig` (release-channel fallback, required-var, region, `COMMAND_PREFIX`, `REPORT_ROLE_ID`, `WATCHED_REPOS` parse/default, self-update vars) + report helpers (`repoForProject`, `reportBody`, `reportAnnouncement` — content, no-truncation-when-it-fits, the 2000-char clamp, and the boundary either side of it) |
| `src/github.test.ts` | bun tests for pure `decideReleaseAnnouncements`: silent seed on never-polled, unseen-only oldest-first, no-op when nothing new, first release of a zero-release repo. Plus `fetchReleases` against a stubbed `globalThis.fetch` (payload mapping, draft filter, tag fallback, `null` on 404, `[]` on a releaseless repo, throws on 401/403/429/5xx) and `createReachabilityLog` (once per standing failure, silent when healthy, recovery, per-repo independence) |
| `src/state.test.ts` | bun tests for pure `normalizeSeenReleaseIds`: legacy-array migration under the default repo, empty array → `{}`, keyed map/`undefined` pass-through |
| `src/commands.test.ts` | bun tests for `isAdmin` (allowlist hit/miss, fails closed, whole-id match) + `bareName()` (strips the prefix, no-op when unset, passes an unprefixed name through unmangled) + `updateReply()` (names the target build; no longer asks the reader to check whether it changed; both `disabled` reasons — a missing `GIT_SHA` vs. an unpublished one, which is named) |
| `src/update.ts` | Self-update: pure `decideUpdate()` + `sameSha()`, `fetchLatestBotSha()` (newest `config.botBranch` commit on `config.githubRepo`), `fetchShaRelation()` (the `ShaRelation` ancestry answer from `GET /compare/{latest}...{running}`; 404 → `unpublished`, any other failure → `unknown`, never throws), stateful `checkForUpdate({ force, requester })` answering `busy` while a handoff is in flight (guard before any state write — see the gotcha), returning a `DisabledReason` when it disables — and, on `restart`, routing through `applyUpdate()`: a self-contained `redeploy()` when the daemon socket is mounted, else the original exit-75 fallback so a deployment on an older compose file keeps working. A failed redeploy clears `attemptedUpdateToSha` + `pendingUpdateReport` again, since the restart never happened — leaving them would owe a follow-up for nothing and let the anti-loop guard suppress the next genuine attempt; pure `buildUpdateReport()` returns the `PendingUpdateReport` to persist across the restart, or `undefined` when there's no requester (which is what keeps an `AUTO_UPDATE` exit silent) |
| `src/update.test.ts` | bun tests for `decideUpdate`/`sameSha`: staleness, short-sha prefixes, anti-loop suppression, `force`; the ancestry matrix (`ahead`/`identical` → current, `behind`/`diverged` → restart, `unpublished` → disabled and outranking both suppression and `force`, `unknown` → pre-#871 fallback, equality shortcut winning before any relation is read); `fetchShaRelation` against a stubbed `fetch` (each status, 404, 500, a rejected fetch, an unrecognised status, and the `latest...running` argument order); plus `buildUpdateReport` (records requester + both shas; no requester → no report) |
| `src/updateReport.ts` | The follow-up owed after a `/update`-initiated restart. Pure `decideUpdateOutcome()` (`updated`/`noop`/`unexpected`/`unknown` by comparing the running `GIT_SHA` against the report's `toSha`/`fromSha`), `updateOutcomeMessage()`, `tokenUsable()` (15-min interaction-token window), `reportTooOld()` (24 h); `deliverUpdateReport()` walks interaction follow-up → DM → channel with injected deliverers, logging and falling through on each failure; `reportUpdateOutcome(client)` is the boot entry point |
| `src/updateReport.test.ts` | bun tests for the four outcomes (incl. short-sha tolerance and a missing `GIT_SHA`), per-outcome message content, the token/staleness windows, and the delivery fallback order — including "every route fails" resolving to `none` rather than throwing |
| `src/restart.ts` | Ref-counted critical section + `requestRestart()`; exits `RESTART_EXIT_CODE` (75); `setExitFn`/`resetForTest` for tests. Also `beginHandoff()`/`endHandoff()`/`handoffActive()` (#879): quiesce for a handoff — `restartPending()` goes true so the scheduler stops writing `state.json` while the replacement shares that volume, but the process deliberately does **not** exit, because it is the only thing that can remove a replacement that fails to verify |
| `src/restart.test.ts` | bun tests: immediate vs deferred exit, nesting, exit-once, release-on-throw; handoff quiesce-without-exit, resume, idempotent resume, and that a handoff neither masks nor is masked by a genuine pending restart |
| `src/docker.ts` | Minimal Docker Engine API client over `/var/run/docker.sock` via Bun's `fetch(url, { unix })` — no dependency. Unversioned paths so it tracks the daemon's own API version. `inspectSelf()` (hostname first, `parseContainerId()` off `/proc/self/mountinfo` as the fallback for a pinned `hostname:`), `buildImage()` (remote git context — the daemon fetches the source, so the image needs no git or tar), create/start/stop/remove/rename, image list/remove, `daemonReachable()`. Pure `parseBuildOutput()` because `/build` answers **200 even when the build failed**, with the error buried in the JSONL stream |
| `src/docker.test.ts` | bun tests for `parseContainerId` (both mountinfo layouts, short-id rejection) and `parseBuildOutput` (the 200-with-an-error case, `errorDetail.message` preference, non-JSON noise), plus stubbed-`fetch` daemon calls: ping, build query construction (remote + both tags + build-arg), and 304/404 on stop/remove being success rather than errors |
| `src/handoff.ts` | The handoff contract, kept free of I/O so it tests as pure logic: `bootMode(env)` (presence of `HANDOFF_FROM` *is* the standby instruction), the marker file in the shared volume (its own file, never `state.json` — one writer, one reader), `decideHandoffOutcome()` → `ready`/`failed`/`timeout`/`waiting` (plus `stalled`, decided not by it but by outliving `RETIREMENT_DEADLINE_MS` — see the gotcha), deadlines, `handoffFailureMessage()`. The marker is read before the container state on purpose: a replacement that signalled `ready` is already stopping the original, so what it *said* must outrank how it currently looks |
| `src/handoff.test.ts` | bun tests for `bootMode` (incl. an empty `HANDOFF_FROM` staying normal), the full `decideHandoffOutcome` matrix, the three ready-marker-wins races (mid-stop, already gone, expired deadline), and `handoffFailureMessage` always saying the current build is still running |
| `src/redeploy.ts` | The swap itself. `redeploy(sha)`: quiesce → build (`buildRemote()` = `…/<repo>.git#<branch>`, the whole repo at the target branch, tagged `:latest` + `:<sha7>`) → prune → create + start the replacement → poll until `decideHandoffOutcome()` settles; **returns only on failure**, since a successful handoff kills this process mid-await — observing `ready` starts a bounded wait for that death, and outliving it demotes the outcome to `stalled` (reclaim + report) rather than quiescing forever. Pure `buildCreateSpec()` derives the replacement entirely from the original's own inspect (compose labels replicated, mounts re-bound, `User` carried over, `GIT_SHA` **dropped** so the new image's baked sha wins), `imageTags()`, `selectImagesToPrune()` (sha-shaped tags of this repo only — `:latest` and hand-named rollback targets are never candidates), `replacementName()`. `retireOriginal()` is the replacement's side: stop + **remove** (an exited container would be respawned on its old image by `restart: unless-stopped`) then take the canonical name |
| `src/redeploy.test.ts` | bun tests for naming, `buildRemote`, `imageTags`, `selectImagesToPrune` (keep-newest-N oldest-first, the never-prune set, untagged images), and `buildCreateSpec` — label replication, `HANDOFF_FROM` injection with no stacking, the `GIT_SHA` drop, both binds, `User`, restart-policy default, network |
| `src/state.ts` | Announcement dedup state, persisted to `data/state.json` (gitignored). `seenReleaseIds` is keyed per `owner/repo`; pure `normalizeSeenReleaseIds()` migrates the legacy global array (single-repo era) under `config.githubRepo` on load; `saveState` caps each repo's list at 100. `attemptedUpdateToSha` guards the self-update exit loop; `pendingUpdateReport` (`PendingUpdateReport`: `fromSha`, `toSha`, `userId`, `channelId?`, `applicationId?`, `interactionToken?`, `requestedAt`) is the `/update` follow-up owed on next boot — purely additive, so an old `state.json` simply lacks the key |
| `src/wow/dmf.ts` | DMF schedule math: first Sunday of month 00:01 in `tz` (defaults to `config.dmfTimezone`, overridable per call for testability), one week, `end` computed independently (not `start + 168h`) so a DST transition inside the window lands correctly. `dmfKey(window)` keys on the *requested* calendar month (`window.year`/`window.monthIndex`), never on `start`'s UTC parts — see the gotcha. `currentOrNextDmf` checks both this UTC month's and next UTC month's candidate windows for whichever contains `now`. `decideDmfAnnouncement(now, announcedFor)` is the pure decision `announce.ts`'s `checkDmf` wraps |
| `src/wow/dmf.test.ts` | bun tests for `dmfKey` (EU month-boundary collision fixtures: Jan/Feb and Oct/Nov 2026), `currentOrNextDmf` (active during the pre-midnight-UTC tail of a bled-forward window, inactive before open), `decideDmfAnnouncement` (new key, already-announced silence, inactive silence, the exact issue #36 regression — November's key must not be swallowed by October's stored key — and the year-boundary variant, a January window keying the same both sides of UTC midnight), and `dmfWindow`'s DST-correct `end` (US November) |
| `src/wow/reset.ts` | Daily/weekly reset math (fixed UTC: us = Tue 15:00, eu = Wed 04:00) |
| `src/wow/blizzard.ts` | Shared Blizzard API access: the client-credentials token, cached until a minute before expiry. Client creds cover everything the bot reads — Game Data (realm status) and public character profiles — so there is no per-user OAuth or account link. Lifted out of `realm.ts` once `/transmog` became a second caller; it was never realm-specific |
| `src/wow/realm.ts` | Connected-realm status search (`UP`/`DOWN`); pure `decideRealmTransition(prev, next)` → `"up"`/`"down"`/`null` (first observation seeds silently). Token comes from `blizzard.ts`. `realmExists(slug)` answers "is this a realm in the configured region", used by `/transmog` to separate a bad realm from a bad character — the character endpoint returns the *same* 404 for both (verified live), so asking separately is the only way to tell. **Fails open**: an outage or rate limit reports `true`, because "we couldn't ask" must never render as "your realm is wrong" |
| `src/wow/realm.test.ts` | bun tests for `decideRealmTransition`: seed-silent first observation, no-change, UP→DOWN, DOWN→UP |
| `src/wow/transmog.ts` | `/transmog` — a `/customset v1 …` import string for a character you can't inspect in-game (#820, the fallback #819's in-game path can't reach). `buildCustomSet(equipment)` is pure: it maps each equipped item's `transmog.item_modified_appearance_id` / `second_item_modified_appearance_id` (already source ids — no translation) onto the 17-value wire layout, **mirroring `Warbandeer_Collected/outfitcodec.lua` exactly**, since that decoder rejects any count but 17. Also pure: `realmSlug()` and `formatTransmogReply()`. `fetchTransmog()` is the only impure part. **Two values are always 0 by design** — the payload carries no visual-enchant field (illusions) and omits `transmog` entirely for an untransmogged slot; both are named in the reply rather than shipped silently. **A secondary that merely echoes its primary encodes 0**: the REST payload repeats the primary appearance when a slot has no distinct secondary, where the in-game producer emits 0 — and 0 is what this format means by "none", so normalising is what keeps the two producers emitting the same string for the same look. **`bare` (equipped, not transmogged) and `empty` (nothing equipped) are tracked separately** — only `bare` leaves the look incomplete; an empty off hand is just a two-hander, and reporting that as a gap tells the user their look is broken when it isn't. **The slot-type vocabulary (`HEAD`/`SHIRT`/`HANDS`/`MAIN_HAND`…) is the one thing not verified against a captured response**, so an unrecognised type is collected and surfaced in the reply instead of silently encoding 0 |
| `src/wow/transmog.test.ts` | bun tests: wire order and the fixed 17-value count, absent-transmog → 0 + reported bare, illusions always 0, a secondary not bleeding into the next slot, non-transmoggable slots ignored vs unknown ones surfaced; `realmSlug` (spaces, apostrophes, accents, already-a-slug); `formatTransmogReply` (code + import target, slot labels, caveats always present, all-zero special case) |
| `src/github.ts` | GitHub API client: `fetchReleases(repo)` (drafts filtered; returns `null` on a 404 — the repo is missing or invisible to `GITHUB_TOKEN`, which GitHub reports identically — while 401/403/429/5xx still throw, and a releaseless repo is a plain `[]`) + `createReachabilityLog()` (edge-triggered per-repo tracker: `observe(repo, reachable)` → `"lost"` / `"recovered"` / `null`, in-memory so a restart re-reports once) + pure `decideReleaseAnnouncements(releases, seen)` (seed-silently on `seen===undefined`, else announce unseen oldest-first) + `createIssue` / idempotent `ensureLabel` for `/report` (both need `GITHUB_TOKEN` with issues:write) |
| `Dockerfile` | `oven/bun:1-slim` (Debian — Intl IANA timezones), prod-only install, non-root `bun` user, `VOLUME /app/data`, `ARG/ENV GIT_SHA`, `ENTRYPOINT entrypoint.sh` |
| `entrypoint.sh` | Root→`bun` drop when compose starts the container as root: joins the socket's group by reading its GID off the socket (`setpriv --groups`), execs the CMD; a plain exec under `USER bun` |
| `docker-compose.yml` | Local dev: `GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build` — `build.context`/`container_name`/`env_file` default to `.`/`warbandeer-discord`/`.env` respectively. A deployed instance overrides all three per-invocation via `BOT_BUILD_CONTEXT`/`BOT_OPS_CONTAINER`/`BOT_ENV_FILE` (see the config-dir gotcha) — never persisted in `.env`. `GIT_SHA` build arg, named volume `state` → `/app/data`, `restart: unless-stopped`. Opt-in `cloudflared` sidecar (`profiles: [tunnel]`, needs `CLOUDFLARE_TUNNEL_TOKEN`) for exposing a future local API without inbound firewall ports. Opt-in `admin` sidecar (`profiles: [admin]`, deploy-only — see `ops/admin/`) |
| `ops/bot-ops.sh` + `ops/README.md` | Operator admin surface originally driven by the **Ops** tab in `apps/warbandeer-desktop` / `wow-companion` (neither is part of this repo — see **Fork gotchas**): whitelisted `status`/`logs`/`restart`/`env-get`/`env-set` over docker+`.env`, invoked over SSH. Takes `BOT_OPS_CONFIG_DIR` + `BOT_OPS_COMPOSE_FILE` as required inputs (see the config-dir gotcha) — no fallback to its own script location. Secrets are never read/written (whitelist excludes them); env-set backs up to `<config-dir>/backups/` then `up -d --force-recreate`. Still fully usable standalone by SSHing in and invoking it directly (see `ops/README.md`) |
| `ops/install.sh` | Curl-able bootstrap for a fresh instance (`debug`/`prod`) with no checkout on the host — creates the config dir (`.env` from `.env.example`, never overwritten on re-run, `ADMIN_TOKEN` generated fresh into it), the shared `bin/bot-ops.sh`, and the Dockge-managed stack dir (compose file) — the latter two always refreshed. Prints the `up -d --build` invocation, plus the optional `--profile admin` one. See `ops/README.md` |
| `ops/admin/` (`server.ts` + `public/index.html` + `Dockerfile`) | Small per-instance admin web panel — an authenticated, thin wrapper around `ops/bot-ops.sh`'s five operations, nothing new. `server.ts`'s auth check, route→subcommand mapping, and request handler are pure/DI'd (`HandlerConfig` injects `runBotOps`, matching `updateReport.ts`'s injected-deliverer shape) so `server.test.ts` covers them without a real subprocess; only the `import.meta.main` block at the bottom does real I/O (spawns `bot-ops.sh`, binds the port). `public/index.html` is a single self-contained file, no build step — its config form renders from whatever `GET /api/env` returns rather than a hardcoded field list. See `ops/README.md`'s Admin panel section for the two-door auth model |

## Behavior

- **Dedup keys** in `BotState`: `dmfAnnouncedFor` (`"YYYY-M"`), `weeklyAnnouncedFor` (reset ISO),
  `realmStatus` (last observed `UP`/`DOWN`), `seenReleaseIds` (`Record<owner/repo, number[]>`, each
  capped at 100). Restarts never re-announce.
- **Realm watch** runs continuously whenever Blizzard creds + `WOW_REALM` are configured (not tied
  to the weekly reset): polls every `REALM_POLL_GAP_MS` (2 min) and announces every UP↔DOWN
  transition. `state.realmStatus` persists the last reading, so the first observation seeds silently
  (no phantom transition on a fresh install or restart) and restarts never re-announce. A Blizzard
  API error is logged and skipped — it never masquerades as a `DOWN`.
- **Release polling** follows the repo's daily release cron (14:00 UTC, `.github/workflows/release.yml`):
  polls every 5 min inside a 90-min window from 14:00 UTC, plus once at startup to catch
  anything published while the bot was offline. Each repo in `config.watchedRepos` is polled
  independently; a repo's first-ever poll (its key absent from `seenReleaseIds`) seeds silently.
- **Self-update** asks whether the baked-in `GIT_SHA` **contains** the newest `BOT_BRANCH` (default
  `main`) commit on `GITHUB_REPO` (flat 15-min cadence + startup, only when `AUTO_UPDATE=true`;
  `/update` checks on demand with `force`). Stale → persist `attemptedUpdateToSha`, then exit 75
  for the orchestrator to respawn. `/update` is gated on the `ADMIN_USER_IDS` allowlist and fails
  closed when empty.
- **Update follow-up** closes the loop `/update` used to leave open: the command also persists a
  `pendingUpdateReport` (requester + both shas), and the next boot messages that requester with
  the build it actually came back on — `updated` / `noop` / `unexpected` named explicitly, since
  the no-op is otherwise indistinguishable from success. Only a `/update`-initiated restart leaves
  a report, so `AUTO_UPDATE` exits and host reboots stay silent.

## Gotchas

- **Fork gotchas.** This repo was extracted, with history, from `nazumods/wow`'s
  `apps/warbandeer-discord` — see the top-of-file note for full credit to Nazuraki.
  `GITHUB_REPO` now defaults to this fork (`roshne/rackbops-discord-bot`), and self-update no
  longer path-filters (`BOT_PATH` is gone from `src/update.ts` / `src/redeploy.ts` — the whole
  repo is the bot now, so `fetchLatestBotSha` compares against the newest commit on the branch,
  full stop, and `buildRemote` builds from the repo root with no subdirectory). Remaining open
  work from the fork extraction:
  - ~~Self-update's rebuild needs `GITHUB_REPO` to be publicly clonable~~ — **resolved**: this
    repo is public (`roshne/rackbops-discord-bot`), so the daemon's remote git build context
    (no credential support) already works, for both self-update and the no-clone deploy model
    below.
  - `ops/bot-ops.sh`'s consumers — `apps/warbandeer-desktop`'s and `wow-companion`'s **Ops**
    tabs, plus the shared `apps/bot-ops` backend — live in the original monorepo and
    `roshne/wow-companion`, not here. The script itself still works over a direct SSH
    invocation (see `ops/README.md`'s "Run directly on the box" example) — but a caller now
    must also pass `BOT_OPS_CONFIG_DIR` + `BOT_OPS_COMPOSE_FILE` (see the config-dir gotcha
    below), which neither app's `ops.json` has a field for yet. Tracked as
    [roshne/wow-companion#197](https://github.com/roshne/wow-companion/issues/197) (the design
    doc's Q4: `opsCmd`/`configDir` fields).
  - No CI: `.github/workflows/discord-bot-test.yml` lived at the monorepo root, so the
    path-scoped extraction didn't carry it over. `bun run check` + `bun test` (referenced
    elsewhere in this doc as CI-enforced) need to be run by hand until a workflow is added
    here.
- **Config dir and compose file are two independent, required locations — never derived from
  each other or from a checkout.** `/opt/rackbops-discord-bot/<instance>/` holds `.env` +
  `backups/` (operator-precious, never auto-migrated — see `ops/README.md`); `.env` is never
  edited by anything but `ops/bot-ops.sh env-set` or the operator by hand. The **compose file**
  lives separately, at `/opt/stacks/rackbops-discord-bot-<instance>/docker-compose.yml`, purely
  so Dockge (nucbox's stack manager) lists and manages it — Dockge only recognises a compose
  file at a path under its own `DOCKGE_STACKS_DIR`, and doesn't care where anything that file
  references lives. `ops/bot-ops.sh` takes both as required env vars
  (`BOT_OPS_CONFIG_DIR`/`BOT_OPS_COMPOSE_FILE`) with no fallback to its own script location —
  that assumption broke the moment the two stopped being the same directory. `ops/install.sh`
  bootstraps a fresh instance's layout; see `ops/README.md` for the full runbook.
- **`docker-compose.yml`'s three interpolation vars (`BOT_BUILD_CONTEXT`, `BOT_OPS_CONTAINER`,
  `BOT_ENV_FILE`) are all supplied per-invocation, on the command line — none are ever written
  into `.env`.** `ops/bot-ops.sh` exports `BOT_ENV_FILE` inline on every `docker compose` call
  it makes (`cmd_restart`, `cmd_env_set`) and inherits `BOT_OPS_CONTAINER` from its own caller;
  neither of those ever passes `--build`, so `BOT_BUILD_CONTEXT` is irrelevant to them.
  `ops/install.sh`'s printed bootstrap command is the one place that sets `BOT_BUILD_CONTEXT`,
  as a one-shot shell prefix on that single `up -d --build` invocation — unset (the default in
  `build.context: ${BOT_BUILD_CONTEXT:-.}`), it's `.`, so `docker compose up -d --build` run
  directly from this checkout for local dev is unchanged. A future manual rebuild against a
  deployed instance needs the same var re-supplied by hand (see `ops/install.sh`'s output) —
  there's nothing to read it back from. Self-update's own rebuilds (`src/redeploy.ts`) were
  already remote-context-based before any of this, via the Docker Engine API directly, not
  `docker compose` — untouched by it.
- **A profile-gated service still gets fully interpolated and validated at `docker compose
  config` time, regardless of which `--profile` is active.** Profiles only filter which services
  actually get *created/started*; the whole file is parsed and every service's variables
  resolved up front. Verified live: an earlier draft of the `admin` service used
  `${BOT_OPS_CONFIG_DIR:?required}` for its required vars, and a bare `docker compose up -d
  --build` for **the bot service alone** — no `--profile admin` anywhere — failed immediately on
  that error, since `admin`'s definition (unset vars and all) is still part of the same parse.
  The fix: a plain `${VAR:-}` default on `admin`'s own vars, with the *volume mount sources*
  falling back to an obviously-fake path (`/nonexistent-set-BOT_OPS_CONFIG_DIR`) instead of an
  empty string, so a misconfigured `--profile admin` run still fails clearly — from Docker
  itself at container-creation time, once `admin` is actually the profile being brought up —
  rather than breaking every other profile's `config`/`up` in the same file.
- **The redeploy order is inverted on purpose (#879), and the reason is a kernel boundary.** Every
  "shut down, then have something bring the replacement up" variant dies on the same thing: a
  detached process (`setsid`, double fork, `Bun.spawn({ detached: true })`) leaves its *parent*, not
  the container's **PID namespace** or **cgroup**, and per `pid_namespaces(7)` the kernel `SIGKILL`s
  every process in a namespace when its PID 1 exits. `init: true` doesn't help either — tini exits
  with its main child. Starting the replacement *first* means there is no window to survive, so
  nothing has to. Don't "simplify" this back into an exit-then-respawn.
- **The old container is removed, never just stopped.** Under `restart: unless-stopped` an exited
  container is respawned **on its old image** — the original #868 failure, and now with two bots
  live. An explicit `docker stop` is exempt from that policy, which is why retirement is a daemon
  call rather than a process exit.
- **`GIT_SHA` is stripped from the replacement's copied env** (`buildCreateSpec`). Docker's
  `Config.Env` merges the image's baked ENV with the container's own, so copying it verbatim pins
  the *old* sha onto the new container and overrides the new image's — a bot that updated correctly
  would then report its own update as a ⚠️ no-op.
- **A plain `compose up -d` after a swap recreates the container — expected, not a bug.** The
  replacement copies the original's labels verbatim, including `com.docker.compose.config-hash`,
  which embeds the `GIT_SHA` build-arg environment of whatever `up` created the original — so
  compose sees a stale hash and recreates. Benign, verified on the box: compose recognises the
  replacement as its own service (no second bot — the trap the labels exist to prevent), and the
  recreate reuses `:latest`, which *is* the self-deployed build, so no rollback. Don't "fix" it by
  computing a fresh hash — a wrong guess would make compose orphan the service and start a second
  container, the far worse failure.
- **The standby attaches nothing** until it has taken over: both instances hold the same
  `DISCORD_TOKEN` and Discord delivers every event to **both** gateway sessions, so a standby that
  registered handlers would double every command reply for the length of the overlap.
- **The handoff marker is its own file, not `state.json`.** One writer (the replacement), one
  reader (the original). `decideHandoffOutcome` reads it *before* the container state because a
  replacement that signalled `ready` is already stopping the original, so it can be caught mid-stop
  and would otherwise be misread as one that died.
- **`bot-ops.sh env-set` must never gain `--build`.** It recreates without building so it reuses
  the `<project>-bot:latest` tag a self-update just wrote; adding `--build` would rebuild from
  whatever the box's checkout is on, silently rolling the bot back on every settings edit.
- **The bot container *starts* as root but *runs* as `bun`** (`user: "0:0"` in
  `docker-compose.yml` + `entrypoint.sh`). The daemon socket is mode 0660 `root:docker` and the
  docker GID differs per host (115 on the box, 999 on a stock Debian) — naming one would be the
  operator-supplied config #879 rules out — so the entrypoint reads the GID off the socket
  itself (`stat -c %g`), then `setpriv`s to `bun` carrying that one supplementary group. Hygiene,
  not a boundary: the socket mount is already root-equivalent either way. Under the image's own
  `USER bun` (no socket, older compose file) it execs the CMD untouched. State written by a
  pre-drop root-run deployment stays root-owned — a one-time `chown -R bun:bun` on the host's
  `data/`, not something the entrypoint redoes every start.
- **`ready` is a promise of a stop, not the stop itself.** The replacement writes the marker
  *before* retiring the original, so a `retireOriginal` that dies in between would leave the
  original quiesced forever — seen `ready`, stopped counting, waiting to be killed. Two guards
  close that: the original bounds the wait for its own death (`RETIREMENT_DEADLINE_MS`, outcome
  `stalled` — reclaim, remove the replacement, report "check the daemon socket"), and past the
  `stopContainer` point of no return `retireOriginal` degrades instead of throwing, because the
  original is dead by then and a rejecting `ClientReady` would strand *both* containers.
- **A second `/update` mid-swap answers `busy`** — the guard sits at the top of
  `checkForUpdate`, before any state write or network call, because interaction handling does
  not quiesce during a handoff (only the scheduler does) and `/update`'s `force: true` bypasses
  the anti-loop suppression: unguarded, it would overwrite the in-flight attempt's
  `pendingUpdateReport` and then force-remove its replacement.
- **`/report`** (`src/report.ts`) is disabled unless BOTH `REPORT_ROLE_ID` and `GITHUB_TOKEN`
  are set (it replies "not configured" otherwise). `project` is a fixed choices list, so an
  unknown project can't reach the handler; the modal `customId` (`report:<project>`) carries the
  selection to the submit handler. `ensureLabel` treats HTTP 422 (label already exists) as success,
  so `/report` never fails on a missing `automated` label — it creates it on first use. Role check
  reads `member.roles` from the interaction payload (cached manager **or** raw `string[]`), so no
  privileged Members intent is needed.
- **A `/report` outcome is public; its refusals are not (#870).** The modal submit defers
  **without** `MessageFlags.Ephemeral`, so the filed-issue confirmation (and the failure that
  replaces it) lands in the channel the report came from — the transparency is the feature, and the
  confirmation *is* the announcement, so there's no second message and no channel config. The three
  pre-flight refusals stay ephemeral on purpose: an unconfigured bot, a missing role, and an unknown
  project are the reporter's own business, not something the channel needs. Two consequences of
  going public: the send passes `allowedMentions: { parse: [] }`, because the description is
  now untrusted free text in a public message and an `@everyone` typed into the modal would
  otherwise fire; and the message is clamped to 2000 chars by `reportAnnouncement`, since the
  modal's Description field is unbounded and Discord rejects an over-long send outright.
- `config.ts` reads env at import time (the `config` singleton) — tests/scripts must set
  `DISCORD_TOKEN` and `ANNOUNCE_CHANNEL_ID` **before** importing any module that imports it
  (see `config.test.ts`: env vars + dynamic import). Config *logic* is testable without env
  games via the pure `resolveConfig(env)`.
- **DMF "first Sunday" is realm-local (e.g. EU window starts Saturday 22:01/23:01 UTC), so any
  dedup key or "is this month's window active" check must key/compare on the *requested* calendar
  month — never on `window.start`'s UTC year/month.** Whenever that month's 1st is a Sunday
  (~1 month in 7), an ahead-of-UTC realm timezone opens the window before UTC midnight of the
  *previous* month, so `start`'s UTC month equals the previous month's — keying on it collides
  with the previous Faire's dedup key and the Faire silently never announces (issue #36). Use
  `dmfKey(window)` (keys on `window.year`/`window.monthIndex`) and `currentOrNextDmf`, which
  checks both this UTC month's and next UTC month's candidate windows for whichever contains
  `now` — checking only "this month" misses the case where next month's window already opened.
  **`dmfWindow`'s `year`/`monthIndex` fields must be the *normalized* calendar month, not an echo
  of its raw params.** `currentOrNextDmf` calls it with `monthIndex=12` for "next January" —
  `Date.UTC` normalizes that fine for computing `start`/`end`, but a naive `{year, monthIndex}`
  return would key that window `"Y-13"`, while the exact same physical window keys `"(Y+1)-1"`
  once `now` crosses into the new year and gets a directly-canonical `(Y+1, 0)` call instead —
  a second dedup-key collision class, this time causing a *duplicate* announcement rather than a
  skipped one. `dmfWindow` normalizes via `new Date(Date.UTC(year, monthIndex, 1))` before
  returning, so both call shapes produce the same key for the same window.
- Weekly-reset detection compares `now` against `lastWeeklyReset()` within a 10-min window —
  the tick cadence must stay well under that window.
- `COMMAND_PREFIX` (empty by default) namespaces every slash-command name so a second
  debug/staging bot can share a server without command collisions (`r_` → `/r_dmf`). It must be
  lowercase (Discord rejects uppercase names); `resolveConfig` validates and throws otherwise.
  A second bot is its own Discord application/token with its own state volume — and since
  `index.ts`'s `rest.put` fully replaces an application's command set, switching the prefix and
  restarting removes the old names automatically.
- **Build every command with `cmd(name)`, never a bare `new SlashCommandBuilder().setName("foo")`.**
  A hand-written name registers outside the namespace, and dispatch then has to cope with it:
  `bareName()` only strips the prefix when the name actually starts with it. An earlier
  unconditional `slice(prefix.length)` turned an unprefixed `update` into `date`, matching no
  case — the command appeared in Discord and silently did nothing. `cmd()` makes that
  unrepresentable; `bareName()`'s tolerance is the backstop.
- **A clean exit is not an update.** `restart: unless-stopped` respawns the *same image*, so
  self-update only does something if the respawn supplies rebuilt code (manual `--build`, or a
  registry image + Watchtower-style updater). The `attemptedUpdateToSha` marker exists precisely
  because the naive version exit-loops forever against a non-cooperating orchestrator: once the
  bot has exited for a sha and come back unchanged, it warns instead of exiting again.
- **Staleness is ancestry, not sha equality (#871).** `GIT_SHA` is baked as `git rev-parse HEAD` —
  the tip the image was built from — which is only occasionally the last commit to touch
  `apps/warbandeer-discord`, because non-bot commits land on `main` most days. Asking "is my sha
  *the* newest bot commit" therefore called a correct deploy stale as its **normal** state: one
  wasted exit-75 per deploy under `AUTO_UPDATE`, and every `/update` (always `force`) overriding
  the suppression to waste another. `decideUpdate` takes a `ShaRelation` from
  `fetchShaRelation()` (`GET /compare/{latest}...{running}`) instead: `identical`/`ahead` →
  `current`, `behind`/`diverged` → `restart`. It's only fetched when the shas differ, so the
  common path still costs one request.
- **`BOT_BRANCH` is queried through the GitHub API, so it must exist on the remote.** A deploy
  running a local-only branch (e.g. an unpushed integration branch that merges several PRs) can't
  point at it. The *running sha* being unpushed is handled, though: the compare 404s, which is its
  own `ShaRelation` (`unpublished`) and resolves to `disabled` naming the sha — so such a deploy
  can keep `GIT_SHA` baked, where it previously had to be built without one. `unknown` (any other
  compare failure) deliberately falls back to the pre-#871 "mismatch = stale", so a GitHub outage
  degrades the check rather than failing startup.
- **`reportUpdateOutcome()` clears and saves `pendingUpdateReport` *before* it tries to deliver.**
  Delivery is the part that can fail — an expired token, closed DMs, a deleted channel — and a
  report left in place after a failed send would re-fire on every subsequent boot. Losing one
  follow-up beats wedging the marker. For the same reason `index.ts` calls it **after**
  `startScheduler` and doesn't await it: an owed follow-up must never delay or crash startup.
- **The interaction follow-up posts unauthenticated via raw `REST.post(Routes.webhook(...), { auth: false })`,
  not `WebhookClient`** — the webhook route is authenticated by the interaction token itself, and
  discord.js's `WebhookClient.send` typing can't set the ephemeral flag, which the follow-up needs
  to match the ephemeral `/update` reply it continues. **Measured on the box's debug bot (#681):
  the token does survive the restart** — the follow-up lands ephemerally in the original command's
  thread, so DM and channel are true fallbacks rather than the load-bearing path.
- `requestRestart()` exits **immediately** when no critical section is open — anything that must
  survive the exit (a Discord reply, a state write) has to run inside `withCritical()`. The
  `/update` handler wraps its `checkForUpdate` for exactly this reason; without it the process
  dies before `editReply` lands.
- Run `bun run check` (tsc) and `bun test` after changes. In the original monorepo CI ran
  both on every PR/push touching this app (`.github/workflows/discord-bot-test.yml`,
  path-scoped) — that workflow lived at the monorepo root, so it wasn't carried over by the
  fork's extraction (see **Fork gotchas**); this repo has no CI yet, so run both by hand.
  No lint beyond tsc.
- **`cloudflared` currently has nothing to route to** — the bot exposes no HTTP port yet
  (that's the desktop-app API work, tracked separately). It's pure plumbing for now: an
  opt-in sidecar (`--profile tunnel`) that joins the bot's Compose network, so a future
  local server is reachable at `http://bot:<port>` once one exists and a public hostname
  is mapped to it in the Cloudflare dashboard. The bot process itself never reads
  `CLOUDFLARE_TUNNEL_TOKEN` — only the sidecar container does.
- Every `*.test.ts` that reaches the `config` singleton (directly or transitively — `update.ts`
  and `commands.ts` both do) must prime `DISCORD_TOKEN`/`ANNOUNCE_CHANNEL_ID` and use a dynamic
  `await import()`, or it throws when run **standalone**. A full-suite `bun test` can mask this:
  `config.test.ts` sorts first and primes the env for everyone. Check with `bun test src/<f>.test.ts`.
