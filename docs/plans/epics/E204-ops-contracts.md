# E204 — env-schema contract and core command table — implementation plan

Status: **in progress (picked up 2026-09-09).** Epic issue:
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
| 6 | Config/state dependency injection is **not** scheduled. | Eleven importers of `config`, three of the top-level-awaited `state`, every test module graph — an L refactor whose only payoff is test hygiene the #136 preload already delivers. Kept as a note on #137. |

## 2. Verified starting state (2026-09-09, `main` @ `d344cec`)

| Item | State |
|---|---|
| `ops/bot-ops.sh` | `BOT_OPS_SCHEMA=1` (`:55`); `ALLOWED_SPEC` (`:171-195`); `REQUIRED` = `ANNOUNCE_CHANNEL_ID` only (`:223-225`); `load_plugin_keys` fills `PLUGIN_FORMAT`/`PLUGIN_REQUIRED` (`:358-413`); `cmd_env_get` (`:473-508`); usage string (`:750`) |
| `ops/admin/server.ts` | `GET /api/env → env-get` route (`:465-467`); `REQUIRED_BOT_OPS_SCHEMA = 1` (`:660`) |
| `ops/admin/public/index.html` | `REQUIRED_KEYS` (`:1311`), `BRANCH_NAME_RE` (`:1339`), `saveEnv`'s blank check (`:1537-1544`), `loadEnv` (`:1471-1500`) |
| `ops/admin/server.test.ts` | REQUIRED-keys mirror test (`:2214-2231`), BRANCH_NAME_RE mirror (`:2241-2251`), schema mirror (`:2311-2319`), saveEnv harness lifting marker blocks (`:1856-1923`) |
| `src/commands.ts` | `commandData` array literal (`:53-101`), `CORE_COMMAND_NAMES` derived (`:104`), `handleCommand` switch with duplicated admin refusal (`:112-121`, `:150-158`) and plugin fall-through in `default` (`:266-273`) |
| deployed instances | debug and prod both refreshed to `main` @ `10780b4` + cloudflared 2026.9.0 today; shared `bin/bot-ops.sh` at main's sha, both panels report `schema 1 (panel needs 1)` |

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
2. Refresh `bin/bot-ops.sh` per the narrow procedure; the banner clears without a container restart (bind mount). `GET /api/env-schema` returns the object; paste it with `ANNOUNCE_CHANNEL_ID.required = true` and `WARBANDEER_INGEST_PORT` present with `source: "plugin"`.
3. Rebuild the debug bot from `main` (scoped `bot` service); `/report`, `/update` as a non-admin, `/plugins list` answer. Paste the replies.
4. Merge #207, rebuild debug's admin again: blank `ANNOUNCE_CHANNEL_ID` and `BOT_BRANCH = bad branch!` are refused before the confirm dialog with the plan's exact messages; `grep -c 'REQUIRED_KEYS\|BRANCH_NAME_RE' ops/admin/public/index.html` is 0 on `main`.
5. Prod: refresh script + rebuild admin the same way (no banner step needed a second time).

## 6. Escalations

None expected: no shipped identifier changes (the `env-get` shape and every command name are unchanged), no data migration. A cloudflared or bot recreate is not part of this epic's deploys — only the admin service and the bind-mounted script move.

---

*Work in §3 order. This doc is the plan of record for E204; update it if the sequence changes.*
