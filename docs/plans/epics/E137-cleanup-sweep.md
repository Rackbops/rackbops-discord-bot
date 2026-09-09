# E137 — Reuse & simplification cleanup sweep — plan of record

Status: **CLOSED — epic complete 2026-09-09.** All five children merged; the exit criterion was
executed on `main` @ `a2f83e3` and pasted on the epic. Epic issue:
[#137](https://github.com/Rackbops/rackbops-discord-bot/issues/137) (a re-audit of #58, the
automated whole-repo review filed at `e0f0d18` whose anchors predated the plugin-framework epic).
Children (in order):
[#134](https://github.com/Rackbops/rackbops-discord-bot/issues/134),
[#132](https://github.com/Rackbops/rackbops-discord-bot/issues/132),
[#133](https://github.com/Rackbops/rackbops-discord-bot/issues/133),
[#135](https://github.com/Rackbops/rackbops-discord-bot/issues/135),
[#136](https://github.com/Rackbops/rackbops-discord-bot/issues/136). Standalone epic (no
predecessor chain). Written at close-out, not at pick-up: the epic was reshaped in place and
handed out straight after a session crash, so this file records what landed rather than what was
intended.

---

## 1. What E137 delivered

| Child | PR | What landed |
|---|---|---|
| #134 release polling cadence | #153 | the one behaviour change of the epic; landed 2026-09-08 |
| #132 reuse | #197 | `shortSha`/`SHORT_SHA_LEN`, `githubHeaders`, `sendToChannel`, `DATA_DIR` as single sites |
| #133 env whitelist single-source | #198 | `ALLOWED_SPEC` + `build_allowed_from_spec` in `ops/bot-ops.sh`; the `ALLOWED`/`ALLOWED_ORDER` drift guard gone |
| #135 ops/deploy accuracy | #196 + #199 | admin-service `BOT_OPS_PROJECT`/`BOT_OPS_CONTAINER` defaults emptied; `cmd_env_set` counters replaced by array lengths |
| #136 build/test hygiene | #200 | `noUnusedLocals` + `noUnusedParameters` on; ten test files' redundant env-prime lines removed (`test/setup.ts` preloads); eight intra-file-only exports de-exported |

Spin-off filed from #133's parity check: #195 (the panel's `parseEnvValue` and bot-ops.sh's
`load_env_values` disagree on duplicate keys and on `export`/indented lines).

## 2. Exit criterion, executed (2026-09-09, `main` @ `a2f83e3`)

| Clause | Result |
|---|---|
| none of #132/#133/#135/#136 open | none open |
| `grep -rn "slice(0, 7)" src/` | 0 sites — `shortSha` derives from `SHORT_SHA_LEN` (#132 recorded the deviation from "exactly one") |
| `"User-Agent": "rackbops-discord-bot"` | one site, `src/github.ts` (`githubHeaders`) |
| `ALLOWED_ORDER` and the drift guard gone from `bot-ops.sh` | all remaining hits are comments; no identifier, no runtime guard |
| compose carries no `warbandeer-discord` default | the two admin env defaults are empty; the three `container_name:` defaults deliberately keep `warbandeer-discord*` (#135's ruling: the bot's is pinned by a test, the tunnel's is read by nothing) |
| `bun run check` clean with `noUnusedLocals` on | exit 0 |
| `bun test` | 1122 pass / 0 fail on Windows; the Linux-only `skipIf` tests ran on CI per PR |

## 3. Lessons

- **Never probe a checker with an underscore-prefixed throwaway name.** `noUnusedLocals` exempts
  an import binding whose local name starts with `_` (the same convention as `_param`), so a probe
  named `__probeAlias` came back clean and was misread as "aliased unused imports slip through".
  `import { basename as probeAlias }` is flagged; a `_`-prefixed local `const` is still flagged too.
  The tsconfig comment states the real gap.
- **`main` is branch-protected since #84**: a PR that falls behind needs `gh pr update-branch`
  before the required checks count.
- An exit criterion written before a child's scope ruling can drift from what that child decides;
  record the deviation on the epic rather than rewording the criterion after the fact.

---

*This doc is the plan of record for E137.*
