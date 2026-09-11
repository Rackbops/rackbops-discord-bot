# E204 — env-schema contract and core command table — implementation plan

Status: **CLOSED — epic complete 2026-09-10.** All three children merged (#205 PR #209 `47252c2`,
#206 PR #210 `9bd0d7c`, #207 PR #211 `441795a`); exit demo executed on debug and pasted on the epic
(the schema-2 banner fired against the un-refreshed script and cleared after the refresh plus an
admin restart; `/api/env-schema` serves 15 keys with `WARBANDEER_INGEST_PORT` as `source: plugin`;
the rebuilt bot registered 9 slash commands and `/r_report` + `/r_plugins list` answered live;
both panels rebuilt from `441795a` with no `REQUIRED_KEYS`/`BRANCH_NAME_RE` and the `ENV_SCHEMA`
block served). Left unverified live: `/r_update` as a non-admin (covered by exact-message tests)
and the in-browser refusal messages (covered by the page's own `saveEnv` run in the test harness;
see the running log for roshne's click check). Was: in progress (picked up 2026-09-09). Epic issue:
[#204](https://github.com/Rackbops/rackbops-discord-bot/issues/204). Children (in order):
[#205](https://github.com/Rackbops/rackbops-discord-bot/issues/205) env-schema subcommand + route,
[#206](https://github.com/Rackbops/rackbops-discord-bot/issues/206) core command table,
[#207](https://github.com/Rackbops/rackbops-discord-bot/issues/207) panel consumes env-schema.
Standalone epic (no predecessor chain). Source: the three items Epic #137 deferred as "needs a
design decision"; the design decisions are made here and in each child's embedded plan.

Each child carries its own file-by-file plan, named tests, mutation guards and executable
acceptance; this doc holds the connective tissue: the decisions, the build order, the guards that
span children, and the exit demo.

---

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | The panel reads validation rules from a new `bot-ops.sh env-schema` subcommand (`{KEY: {pattern, required, source}}`, same keys and order as `env-get`), surfaced as `GET /api/env-schema`. `env-get`'s flat `{KEY: value}` shape is untouched. | `env-get`'s output is POSTed straight back to `env-set`, so metadata needs its own channel (the constraint #137 recorded). Everything the schema needs already exists in the script: `ALLOWED_SPEC` patterns, the `REQUIRED` set, and `load_plugin_keys`' `PLUGIN_FORMAT`/`PLUGIN_REQUIRED` from plugin manifests. |
| 2 | `BOT_OPS_SCHEMA` and `REQUIRED_BOT_OPS_SCHEMA` go 1 → 2 in #205. | A deployed script without the subcommand must show the #173 banner, not a generic failure. This is the first real use of that mechanism; the exit demo proves it. |
| 3 | The panel translates POSIX bracket classes (`[:space:]` and friends) to JS and treats any pattern that still won't compile as "no client-side check". | bash ERE and JS `RegExp` differ; `PLUGIN_INDEX_URL` uses `[[:space:]]`. The server stays the authority either way, so a translation gap degrades to the pre-epic behaviour, never to a wrong refusal. |
| 4 | When `/api/env-schema` is unavailable the panel renders and saves with no client-side validation. | An old deployed script or a 5xx must not brick the config form; the banner already explains the outdated script. |
| 5 | Core commands adopt the plugin `PluginCommand` shape (`name`, `build`, `handle`) as `CoreCommand`, and dispatch is `core ?? plugin`. | One shape for both means the host's collision rule and the prefix application are stated once; the refactor is byte-identical in registration JSON (acceptance pins it). |
| 6 | Config/state dependency injection is **not** scheduled. | Nine `src/` modules import `config`, three import the top-level-awaited `state`, every test module graph changes — an L refactor whose only payoff is test hygiene the #136 preload already delivers. Kept as a note on #137. |

## 2. Verified starting state (2026-09-09, `main` @ `d344cec`)

| Item | State |
|---|---|
| `ops/bot-ops.sh` | `BOT_OPS_SCHEMA=1` (`:55`); `ALLOWED_SPEC` (`:171-195`); `REQUIRED` = `ANNOUNCE_CHANNEL_ID` only (`:223-225`); `load_plugin_keys` fills `PLUGIN_FORMAT`/`PLUGIN_REQUIRED` (`:358-413`); `cmd_env_get` (`:473-507`); usage string (`:750`) |
| `ops/admin/server.ts` | `GET /api/env → env-get` route (`:465-467`); `REQUIRED_BOT_OPS_SCHEMA = 1` (`:660`) |
| `ops/admin/public/index.html` | `REQUIRED_KEYS` (`:1311`), `BRANCH_NAME_RE` (`:1339`), `saveEnv`'s blank check (`:1537-1544`), `loadEnv` (`:1471-1500`) |
| `ops/admin/server.test.ts` | REQUIRED-keys mirror test (`:2214-2231`), BRANCH_NAME_RE mirror (`:2241-2251`), schema mirror (`:2311-2319`), saveEnv harness lifting marker blocks (`:1856-1923`) |
| `src/commands.ts` | `commandData` array literal (`:53-101`), `CORE_COMMAND_NAMES` derived (`:104`), `handleCommand` switch with duplicated admin refusal (`:112-121`, `:150-158`) and plugin fall-through in `default` (`:266-273`) |
| deployed instances | debug and prod refreshed today: bot and admin images built from `10780b4`, stack compose and shared `bin/bot-ops.sh` from `d344cec` (the cloudflared 2026.9.0 bump, the only commit between the two); both panels report `schema 1 (panel needs 1)` |

## 3. Build order

```
#205 env-schema + route + schema 2 (S) ──► #207 panel consumes it (S)
#206 core command table (S) ── independent; runs in parallel with #205
```

#205 → subordinate #1, #206 → subordinate #2 (both started 2026-09-09); #207 → subordinate #3 after
#205 merges (it edits the same `server.test.ts`, `ops/README.md` and `CONTEXT.md` regions).

## 4. Cross-child guards

| Property | Guard |
|---|---|
| the schema names exactly the keys the form shows | #205's keys/order test against `env-get` on the same fixture |
| a pattern survives the trip script → jq → JSON → JS | #205's verbatim-`ALLOWED_SPEC` test; #207's every-pattern-compiles test and the Linux bash-parity test on `PLUGIN_INDEX_URL` |
| the bump can't land on one side only | the existing #173 mirror test (`REQUIRED_BOT_OPS_SCHEMA` vs `BOT_OPS_SCHEMA`) |
| an outdated deployed script is loud, not broken | live: new admin image before the script refresh → banner names `bot-ops.sh`; after → clear |
| the command refactor changes nothing Discord sees | #206's byte-identical `commandData` comparison against `main` |

## 5. Exit demo (debug, orchestrator-driven)

1. Merge #205 and #206. Rebuild debug's admin image from `main` **before** refreshing the shared script: the panel logs `bot-ops.sh schema 1 (panel needs 2)` and shows the OUT OF DATE banner naming `bot-ops.sh`. Paste both.
2. Refresh `bin/bot-ops.sh` per the narrow procedure, then `docker restart` the admin: the schema check runs once at startup (`checkBotOpsSchemaStartup`, baked into `/api/status`), so the banner does **not** clear live — an earlier draft of this step said it would. `GET /api/env-schema` returns the object; paste it with `ANNOUNCE_CHANNEL_ID.required = true` and `WARBANDEER_INGEST_PORT` present with `source: "plugin"`. Because the script is one shared file and the check is strict equality, rebuild the other instance's admin too before it next restarts.
3. Rebuild the debug bot from `main` (scoped `bot` service); `/report`, `/update` as a non-admin, `/plugins list` answer. Paste the replies.
4. Merge #207, rebuild debug's admin again: blank `ANNOUNCE_CHANNEL_ID` and `BOT_BRANCH = bad branch!` are refused before the confirm dialog with the plan's exact messages; `grep -c 'REQUIRED_KEYS\|BRANCH_NAME_RE' ops/admin/public/index.html` is 0 on `main`.
5. Prod: refresh script + rebuild admin the same way (no banner step needed a second time).

## 6. Corrections to the plan (running log)

- **#205 (2026-09-09):** the jq grouping in the child plan used `_nwise(4)`, which is a manual
  example, not a builtin, and fails on every real jq. Subordinate #1 caught it and replaced it with
  `range(0; ($a|length)/4) | $a[.*4:.*4+4]`. Verified on nucbox's jq 1.8.1: the grouping emits the
  nested object with `[[:space:]]` and `\.` intact, and `--args` works before or after the filter, so
  the ordering caveat in the child plan is moot there. Lesson: run every snippet a plan hands a
  subordinate, even a one-liner.
- **#206 (2026-09-10):** two mutation-table rows named tests that did not catch their mutation —
  the handle swap (the dispatch test mocked `handle` away; the non-admin test asserted a substring
  both refusals share) and the `cmd()` bypass (the suite runs with an empty `COMMAND_PREFIX`, and
  the `config` singleton can't be re-resolved per test). Subordinate #2's reviewers caught both;
  fixed with exact-message assertions plus a matching `/update` dispatch test, and `noUnusedLocals`
  named as the real backstop for the bypass (`cmd` has exactly one use). The orchestrator
  reproduced the byte-identical registration under `COMMAND_PREFIX=r_` directly, outside the suite.
- **#207 (2026-09-10):** the "remove the `[:space:]` mapping" row claimed the every-pattern-compiles
  test would fail; it does not — an untranslated `[^[:space:]]` still compiles as a wrong-but-valid
  JS class. Only the bash-parity test on `PLUGIN_INDEX_URL` catches it. The reviewers generalised
  that into a real gap in decision 3: any *unmapped* POSIX class (`[:blank:]`, `[:punct:]`, …)
  compiled to a regex that rejects almost everything instead of "no check". Fixed in review: a
  surviving `[:…:]` token after translation now yields `null`, with a regression test.
- **Deploy (2026-09-10):** a schema bump moves both panels at once — see §5 step 2.

## 7. Escalations

None expected: no shipped identifier changes (the `env-get` shape and every command name are unchanged), no data migration. A cloudflared or bot recreate is not part of this epic's deploys — only the admin service and the bind-mounted script move.

---

*Work in §3 order. This doc is the plan of record for E204; update it if the sequence changes.*
