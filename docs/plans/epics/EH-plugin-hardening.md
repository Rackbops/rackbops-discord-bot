# EH — Plugin-framework hardening — implementation plan

Status: **CLOSED — epic complete 2026-09-09.** All five children merged the same day; exit demo on
debug: both new plugin versions installed through the panel, then `docker stop` showed
`[warbandeer] ingest server stopped` inside the drain (exit 0, 169 ms). The in-Discord Cyrillic
`/transmog` check was deferred by roshne (unit-proven). Detail below is the running log. plugins#28 done (plugins PR #29 `b1f12e3`, one round; the
orchestrator's pack check is only meaningful after a real `bun run build` — verified that way).
#184 bot half done (PR #190 `2dd4d10`, two rounds: round 1 found sequential dispose could overrun
the outer bound at N≥2 plugins — now concurrent via `Promise.allSettled`; the orchestrator's first
"sequential" mutation was malformed and a proper for-loop rewrite confirmed the guard); plugins half
done (plugins PR #30 `262dac5`, warbandeer 1.2.0 — the tag push is roshne's). **#184 closed.**
#186 done (PR #189 `3e6f72f`, three rounds — round 2 caught the surrogate-pair fix switching to
code points and re-admitting emoji-heavy overflow; final helpers verified against UTF-16 by the
orchestrator). plugins#27 done (plugins PR #31 `141943e`, wow 1.0.1 — the embedded realm list has no
non-Latin-1 names, so the hint alone is v1; 0/707 false positives). **#55 closed.** #185 done
(PRs #191 `4079dac` + plugins#32; one round; the plan's claim that `selectPlugins` already refused a
plugin named `report` was FALSE — it checked commands only — the subordinate probed it and added the
real guard). **All five children merged.** Remaining: the two publish tags (`warbandeer-v1.2.0`,
`wow-v1.0.1`, roshne's), then the live exit demo on debug, then close. Epic issue:
[#183](https://github.com/Rackbops/rackbops-discord-bot/issues/183). Children (in order):
[#184](https://github.com/Rackbops/rackbops-discord-bot/issues/184) `Plugin.dispose()`,
[#185](https://github.com/Rackbops/rackbops-discord-bot/issues/185) `customId` routing,
[#186](https://github.com/Rackbops/rackbops-discord-bot/issues/186) #55's core half,
[rackbops-bot-plugins#27](https://github.com/Rackbops/rackbops-bot-plugins/issues/27) Cyrillic realm slug,
[rackbops-bot-plugins#28](https://github.com/Rackbops/rackbops-bot-plugins/issues/28) files-allowlist guard.
Standalone epic. Sources: #95's and #123's out-of-scope lists, #55, the review note on
rackbops-bot-plugins#10.

Each child carries an embedded plan, mutation table and executable acceptance; this doc holds the
build order, the contract-compatibility rule the two contract children share, what was deliberately
left out and why, and the exit demo.

---

## 1. What EH delivers

Two compatible extensions to the host↔plugin contract (`dispose`, `interactions`), three hygiene
fixes with evidence behind them. No `HOST_API_VERSION`/`ADMIN_API_VERSION` bump; every existing
published bundle keeps loading unchanged — that is an acceptance bullet on both contract children,
not an assumption.

## 2. Verified starting state (2026-09-09, `main` @ `95f478e`)

- `Plugin` (`src/plugins/contract.ts:207-212`) = `commands`, `ticks`, `activate?()`. No release
  hook; warbandeer's `Bun.serve` (`plugins/warbandeer/src/server.ts:304`) has a `stop()` at `:331`
  nothing calls. #154's drain (`src/shutdown.ts`) exits with it open.
- `InteractionCreate` (`src/index.ts:144-153`) dispatches slash commands and core's `report:`
  modal only; components/modals for plugins are dropped.
- #55: `err.message` unclamped into replies at `src/report.ts:133`, `src/commands.ts:140/178/262`;
  `github.ts:155` embeds `await res.text()`; `config.ts:42` bracket-looks-up `REPORT_PROJECTS`.
  The Cyrillic-slug item lives in `plugins/wow` since #107.
- `generate-index` guards `src/admin/index.ts` exists but not that `files` ships `dist/admin.js`.

## 3. Build order

```
#184 dispose (M, bot PR then plugins PR: warbandeer 1.2.0) ─┐
#185 customId routing (M, bot PR then plugins re-vendor)  ─┤ contract children — the second to land
                                                           │ rebases packages/api/contract.d.ts
#186 #55 core half (S, bot)                                ─┤ independent
plugins#27 Cyrillic slug (S, plugins → wow 1.0.1)          ─┤ independent
plugins#28 files-allowlist guard (S, plugins, no publish)  ─┘ independent
```

All five are ≤ M with plans → hand-offable. Suggested pairing for two subordinates: one takes #184
then plugins#28; the other takes #186 then plugins#27; #185 goes to whoever frees up first. Both
contract children land the **bot side first**, then re-vendor (producer/consumer rule).

## 4. Cross-cutting rules

| # | Rule | Why |
|---|---|---|
| 1 | Contract additions are **optional members only**; no version bump; `contract.test.ts`'s single-const pin untouched | the irreversible-contract rule: land compatibly, never break an installed plugin |
| 2 | `dispose` runs inside the 8 s shutdown grace, **nested** with `destroyClient`, never additive | #154's round-1 lesson (additive timeouts tied the 10 s SIGKILL bound) |
| 3 | Interaction routing keys on `<name>:` — exact split on the first colon; core's `report:` branch stays first; a plugin can't be named `report` (core command uniqueness) | no ambiguity, no core hijack |
| 4 | Error text is clamped at the **throw site** (`github.ts`) *and* defensively at the reply sites | a future long message must not strand an interaction again |
| 5 | The tarball guard has three layers: `files` allowlist at index time, non-empty bundle at build time, `npm pack --dry-run` grep at publish time | each catches a different way to ship a 404ing `adminUrl` |

## 5. Deliberately out of scope

- **Host-owned HTTP router** — warbandeer's own server is ADR-0001's design and no second HTTP
  plugin exists; revisit when one does.
- **Manifest signing** — npm provenance exists on publish; verifying sigstore bundles in Bun is its
  own project.
- **Iframe isolation / per-version env scoping** — declined on #123/#165 (first-party plugins only).
- **`onMessage` watcher plugin** — needs the privileged intent and an LLM-backend decision.

## 6. Mutation guards (the load-bearing ones, from the children)

| Property | Mutation that must fail |
|---|---|
| `dispose` called only for running plugins, isolated, bounded, before `destroyClient` | skip / reorder / unbound → red |
| interactions routed by exact `<name>:` prefix to a running plugin; `report:` never routed | strip the colon rule / reorder → red |
| 5 KB upstream body → reply under the limit; `repoForProject("constructor") === undefined` | remove the clamp / bracket lookup → red |
| empty/hyphen slug never reaches `fetch` | remove the early return → recording-fetch test red |
| `files: ["dist/plugin.js"]` + `adminApiVersion` → `generate-index` throws naming the plugin | drop the guard → red |

## 7. Exit demo (on `debug`)

`docker stop` shows `[warbandeer] ingest server stopped` before `[shutdown] drained`; a fixture
plugin's button round-trips by prefix while a `report:` modal still reaches core (test harness — no
production consumer, declined live in writing); `/transmog` with `Гордунни` answers the realm hint
(roshne, in Discord); a fake 502 with a 5 KB body yields a clamped `/report` failure; `npm pack
--dry-run` lists `dist/admin.js` for both plugins and the guard refuses a fixture that wouldn't.

## 8. Escalations

Both contract children extend the frozen boundary — compatibly, which the rule allows; say so in
each PR. Publishing warbandeer 1.2.0 and wow 1.0.1 is roshne's tag push (CI/OIDC does the rest).

---

*Work in §3 order. This doc is the plan of record for EH; update it if the sequence changes.*
