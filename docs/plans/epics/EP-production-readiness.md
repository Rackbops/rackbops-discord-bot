# EP — Production readiness — implementation plan

Status: **CLOSED — epic complete 2026-09-09.** All five children done; exit criterion met: prod's
three containers healthy beside debug's, prod's panel at `bot.rackbops.com` behind Access with both
schema lines, `main` refusing a direct push and a pre-checks merge (GH006 / "2 of 2 required status
checks are expected"), and the old `warbandeer-discord` container + `~/repos/wow-debug` gone. The
running log follows. Was: in progress (2026-09-09) — three of five done. #83 (PR #188 `e8b1dd6`; a claims finding
corrected this plan's own false "second layer against the #163 class" statement). #9: prod is up as
**`Rackbops-Bot#9518`** on its own Discord application (a shared token with debug was declined),
"same as debug for everything" except `COMMAND_PREFIX` cleared on prod; announce channel still
shared (duplicate announcements until one changes). #11: `bot.rackbops.com` behind Access — the
Cloudflare objects were created by a fresh subordinate with the authorized MCP (six-email policy,
"six and six" per roshne), the nucbox side by the orchestrator after that session's own permission
gate blocked its SSH reads (roshne chose the takeover; not done on the peer's request); a guarded
write proven both ways; Kuma monitor 17 paused pending the service-token headers; the tools-site
card carries both URLs (Tooling#579, published). Lesson: `--profile tunnel up` recreates the bot
through `depends_on` when its env changed — use `--no-deps`. #10 done: the old container, four
images, two state volumes and the 2.6 GB checkout (token identical to debug's, so hygiene only) are
gone; root-owned `node_modules` left by the old root-run container needed `sudo` to delete. Left:
**#84 only** (roshne's PUT; two rejection probes then close). Epic issue:
[#182](https://github.com/Rackbops/rackbops-discord-bot/issues/182). Children (in order):
[#83](https://github.com/Rackbops/rackbops-discord-bot/issues/83),
[#84](https://github.com/Rackbops/rackbops-discord-bot/issues/84),
[#9](https://github.com/Rackbops/rackbops-discord-bot/issues/9),
[#11](https://github.com/Rackbops/rackbops-discord-bot/issues/11),
[#10](https://github.com/Rackbops/rackbops-discord-bot/issues/10). Standalone epic (no predecessor
chain). #80 (the CI tracking issue) closed into this epic; its Phase 1 (#81, #82) is done.

Each child carries its own embedded plan and executable acceptance (appended 2026-09-09); this doc
holds the connective tissue: build order, what is an operator session versus a PR, the decisions
that are roshne's, and the exit demo.

---

## 1. What EP delivers

A technical merge gate on `main` (build validation + branch protection), a `prod` instance with
its own Discord identity, prod's admin panel behind Cloudflare Access, and the pre-fork debug
deployment removed from nucbox. Nothing new is designed: `install.sh`, the `admin`/`tunnel`
profiles, the Access wiring proven on debug, and `ci.yml` are reused as-is.

## 2. Verified starting state (2026-09-09)

| Item | State |
|---|---|
| `ci.yml` | one job, `checks` (`ci.yml:11-42`): typecheck ×3 + `bun test`; green on every merge since #82 |
| branch protection on `main` | none (`…/branches/main/protection` → 404) |
| prod bootstrap on nucbox | `/opt/rackbops-discord-bot/prod/.env` (48 lines, token + channel set, tunnel token empty) and the stack `docker-compose.yml`, both from 2026-09-01; **no stack `.env`**; no prod container |
| old debug deployment | container `warbandeer-discord` (`Exited (137)`, project `warbandeer-discord-debug`), image `warbandeer-discord-debug-bot:latest`, checkout `~/repos/wow-debug` with a `0600` `.env` (2026-08-01) holding a token + Blizzard secret |
| Uptime Kuma | no monitors for the bot at all |
| Cloudflare | debug's tunnel `rackbops-discord-bot-dev-admin` → `bot-dev.rackbops.com`; nothing for prod |

## 3. Build order

```
#83 docker-build job (S, PR) ──► #84 branch protection (XS, settings; needs #83's context name)
#9  stand up prod (M, operator) ──► #11 prod panel + Access (M, operator)
#10 retire old debug (XS, operator) ── independent; any time roshne confirms the rollback net is done
```

Two tracks run in parallel: the CI track (#83 → #84) is PR + settings work a subordinate can carry
(#83) and roshne applies (#84); the prod track (#9 → #11, then #10) is operator sessions on nucbox
driven by the orchestrator with roshne supplying the Discord application, the secrets, and the
Cloudflare objects. Only #83 produces a code PR.

## 4. Cross-cutting decisions (roshne's, named up front)

| # | Decision | Where |
|---|---|---|
| 1 | Prod's Discord server (debug's or another) and channel/role IDs; prod's plugin set (`PLUGINS=`); whether the warbandeer ingest port is enabled on prod | #9 |
| 2 | Prod's Access allow-list (debug's four bootstrap emails, or narrower) and the public hostname (`bot-prod.rackbops.com` suggested) | #11 |
| 3 | The old debug token: identical to the current debug app's (hygiene only) or a separate live token (revoke it) | #10 |
| 4 | `enforce_admins: true` on `main` — includes roshne; recommended, it is the point | #84 |
| 5 | Uptime Kuma monitors for prod (and debug) — optional, none exist today | #9 |

## 5. Guards

| Property | Guard |
|---|---|
| both images build from a clean checkout with no env | #83's job; two deliberate Dockerfile breakages turn the right step red |
| `main` can't take a red merge or a direct push | #84's two rejections, executed |
| prod boots against its own env file and identity | `[boot] env file: /opt/rackbops-discord-bot/prod/.env`, `Logged in as <prod>`; debug's `StartedAt` unchanged |
| prod panel is closed-door | unauthenticated `curl -sI` → 302 to Access; both schema lines at startup |
| nothing left of the old deployment | `docker ps -a`, `docker images`, `ls ~/repos/wow-debug` all empty; token disposition recorded |

## 6. Exit demo

`docker ps` on nucbox with prod's three containers healthy beside debug's; prod's panel through
Access with both schema lines; a red-check merge refused by GitHub; the old container/checkout gone.

## 7. Escalations

Every prod-track step that creates something outside the repo (a Discord application, a tunnel, a
hostname, an Access app) or touches secrets is roshne's action or needs roshne's explicit go; the
orchestrator drives SSH and pastes evidence. #84 is a repository-settings change: roshne applies.

---

*Work in §3 order. This doc is the plan of record for EP; update it if the sequence changes.*
