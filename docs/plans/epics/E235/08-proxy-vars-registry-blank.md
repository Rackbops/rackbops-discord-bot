<!-- Plan for Rackbops/rackbops-discord-bot#280 + #281 (not children of Epic #235 or #236; bundled
with this epic's plan directory only because Epic #235's orchestrating session wrote and hosted the
plan). Copy of the approved plan comment
(https://github.com/Rackbops/rackbops-discord-bot/issues/280#issuecomment-5769785191), plus the
implementer's "Deviations from the plan" appended at the end. -->

## Implementation plan — written by the orchestrating session, to be executed as written

Covers **#280 + #281** as one PR: the two XS follow-ups filed from #278's review gate. Written 2026-09-22 against `origin/main` @ `e332728`; every cite read from source that day. Different files, no shared lines — bundled only because each is XS and one gate covers both; if a reviewer finding on one half would hold the other, split at that point and say so. No prerequisites: #277 and #227 (the other `bot-ops.sh` changes) are merged; `install.ts` is touched by nothing in flight (#295 is `install.sh`). Both issue bodies carry `## Acceptance`; the coverage table maps every bullet.

**Files:** `ops/bot-ops.sh` (`RESERVED_KEYS` only), `ops/bot-ops.test.ts`, `src/plugins/install.ts` (one line), `src/plugins/install.test.ts`, `CONTEXT.md` (the `RESERVED_KEYS` gotcha; the install/registry sentence if one exists — Grep `PLUGIN_REGISTRY_URL`), `ops/README.md` (where it says the runtime variables stay claimable). Not `.env.example` (the blank line stays: it is documentation of an optional key, and the fix makes blank mean unset, as `config.ts` already does for `PLUGIN_INDEX_URL`).

### Decided — not open for re-planning

**#280 — reserve the five, after reproducing them.**

1. **Reproduce first, as the issue says, and paste it:** a `bun -e` script that `fetch`es a local `Bun.serve` URL with `HTTPS_PROXY`/`HTTP_PROXY` set to an unreachable address (`http://127.0.0.1:9` — expect the fetch to fail or hang where it succeeds with the variable unset; use `AbortSignal.timeout`), and `NO_PROXY` restoring it; and `TAR_OPTIONS='--version'` (or another option that changes `tar`'s observable behaviour) set while `tarExtract`'s exact argv runs (`ops/README.md` has no tar on this box? Git's bash ships `tar` — use it; `skipIf` when absent and say so). A variable that does not reproduce is dropped, per the issue.
2. **Group 4 in `RESERVED_KEYS`**, `# Group 4 (#280): act on the core's own outbound calls or on a tool it spawns`: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `http_proxy`, `TAR_OPTIONS` — the lower-case `http_proxy` included (it is the one most tools read first). The pin that reads the reserved set (`ops/bot-ops.test.ts`, the `/\[([A-Z][A-Z0-9_]*)\]=1/g` regex) widens to `[A-Za-z_][A-Za-z0-9_]*` so it counts the lower-case key; the behaviour table `a manifest cannot claim a core setting the panel does not edit (#278)` gains the five (they are invisible to the `src/` scan, which is the reason the table exists — say so in the test's comment, as #278 did for the shard variables). `NODE_OPTIONS`, `PATH`, `LD_PRELOAD`, `BUN_*`, `TZ` stay claimable, unchanged.

**#281 — a blank `PLUGIN_REGISTRY_URL` is unset.**

3. **The JavaScript half is the reproduction and it is enough.** `src/plugins/install.ts:14` uses `??`, so `PLUGIN_REGISTRY_URL=""` makes `REGISTRY_BASE` `""` and the metadata URL at `:233` begins with `/` — a relative URL `fetch` rejects (paste `bun -e` output showing the URL and the error). Compose's `env_file` semantics are documented, not guessed: a `KEY=` line sets the variable to the empty string (cite the Compose file reference's env_file section in the PR body). Whether a deployed `.env` carries the line is beside the point: the shipped `.env.example` does, and `config.ts`'s `optional()` (`:57-60`) already treats blank as unset for `PLUGIN_INDEX_URL`, so `install.ts` is the inconsistent one.
4. **The fix is the one-line rule `config.ts` already has:** `(process.env.PLUGIN_REGISTRY_URL?.trim() || DEFAULT_REGISTRY)` — trimmed, so a whitespace-only value is unset too — with the existing trailing-slash strip. `REGISTRY_BASE` is module-level, so the test drives it through the module seam that exists: if `install.ts` exports nothing that exposes the base, export a pure `resolveRegistryBase(env: Record<string, string | undefined>): string` that the module-level constant calls, and test that (blank → default; whitespace → default; a value → itself without its trailing slash; unset → default). Nothing else in `install.ts` changes.

### Steps

1. `ops/bot-ops.sh`: group 4 per decision 2, comment style of groups 1–3.
2. `ops/bot-ops.test.ts`: the widened pin regex; the five keys added to the behaviour table's list (both `(PLUGINS empty)` and `(the plugin enabled)`), a plain-only claim for at least one of them so `env-get` can fail first (the #278 lesson); the `.env.example` pin unaffected (none of the five is documented there — confirm).
3. `src/plugins/install.ts`: `resolveRegistryBase` per decision 4.
4. `src/plugins/install.test.ts`: the four `resolveRegistryBase` cases, plus one through `installPlugins` with a fake `fetch` recording the URL: with the env blank, the first metadata URL starts with `https://registry.npmjs.org/`.
5. Docs: `CONTEXT.md`'s `RESERVED_KEYS` gotcha names group 4 and no longer says these stay claimable; `ops/README.md` likewise; a one-line note beside `PLUGIN_REGISTRY_URL` wherever CONTEXT.md describes it (blank = unset, like `PLUGIN_INDEX_URL`).

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must fail it |
|---|---|---|---|
| #280: each variable reproduced or dropped | 1 | — manual, pasted | — |
| #280: removing any one reserved variable fails a test | 1, 2 | the behaviour table (two tests) | remove `HTTPS_PROXY`; remove `http_proxy` (the lower-case one must be killed by the table, since the pin regex alone cannot) |
| #280: `env-set HTTPS_PROXY=x` refused, `PLUGINS` empty and enabled | 1, 2 | the behaviour table + the acceptance run against the real script with a fake docker, pasted | drop group 4 |
| #280: no doc says they stay claimable | 5 | — single read | — |
| #281: reproduced | 3 | — `bun -e`, pasted | — |
| #281: a test fails without the fix | 3, 4 | `resolveRegistryBase: a blank value is the default registry`; the `installPlugins` URL test | restore `??` |
| both: `bash -n`, `bun run check`, `bun run --cwd ops/admin check`, CI green | — | the acceptance commands | — |

### Acceptance — execute these, paste the real output

```
bash -n ops/bot-ops.sh
bun run check
bun run --cwd ops/admin check
bun test ops/bot-ops.test.ts --timeout 240000 -t "cannot claim a core setting|RESERVED_KEYS covers"
bun test src/plugins/install.test.ts
```

Plus the reproductions from decisions 1 and 3, and the `env-set HTTPS_PROXY=x` run (fake docker serving a fixture index that declares it), verbatim.

### PR

Branch `claude/reserve-proxy-vars-registry-blank` from `origin/main`, isolated worktree; title `fix(ops,plugins): reserve the proxy variables and TAR_OPTIONS, and treat a blank PLUGIN_REGISTRY_URL as unset (#280, #281)`; body with `Closes #280` and `Closes #281`, the plan committed as `docs/plans/epics/E235/08-proxy-vars-registry-blank.md` (with a "Deviations from the plan" section), deviations, the reproductions and acceptance output, the mutation table, the round list with dispositions. Behaviour change (keys that were claimable stop being so; a blank now falls back): the full gate — two adversarial read-only reviewers with different lenses (A: correctness — do the reproductions really show what they claim, does a lower-case key survive `load_plugin_keys`' own handling, what a whitespace value does; B: claims-vs-code and test quality — every coverage-row mutant). Mutation-test every changed line in a detached scratch worktree, one mutant at a time; `ops/bot-ops.test.ts` always with the `-t` filter above. At most four rounds, then stop and tell the orchestrator. **Never merge.**

## Deviations from the plan (recorded at implementation)

1. **`echo_key` scrubs the lower-case `http_proxy` key name in `env-set`'s refusal message.** Not anticipated by the plan. `ops/bot-ops.sh`'s `echo_key` (pre-existing, untouched by this PR) only echoes a refused key shaped `^[A-Z][A-Z0-9_]{0,39}$` — upper-case only, to avoid ever echoing a fragment of a multi-line secret value that got misread as a "key". `http_proxy` fails that pattern, so `env-set HTTP_PROXY=x`-style refusal for it reports `'(not shown)' is not an editable key`, not `'http_proxy' is not an editable key`. Options considered: widen `echo_key` to accept lower-case (rejected — it is a deliberate, security-motivated restriction unrelated to this PR's decided scope, and widening it increases the surface for a coincidental lower-case fragment to be echoed); or special-case the test's expectation. Took the latter: the behaviour-table test now computes the expected echoed form the same way `echo_key` does, so it still fails if `http_proxy` (or any future lower-case reserved key) stops being refused, without changing `echo_key` itself. `echo_key`'s own behaviour is otherwise unaffected and untested by this PR beyond this.
2. **Made `http_proxy` the "plain-only claim" example the plan's Step 2 asked for ("a plain-only claim for at least one of them so `env-get` can fail first").** Excluded it from `secret-claim` the same way `HOSTNAME` already is. Chosen because `http_proxy` is also the one key none of the "RESERVED_KEYS covers" pin tests names directly (not credential-shaped, not documented in `.env.example`, not a compose interpolation, not read through a form the `src/` source scan knows), so the behaviour table is the *only* thing that fails if it drops out of `RESERVED_KEYS` — making it plain-only means that failure is the direct one (`env-get` itself), not only the secret-wins path (`env-schema`).
3. **Did not add a fifth `installPlugins`-level test for "with the env blank, the first metadata URL starts with `https://registry.npmjs.org/`" as Step 4 describes literally.** `REGISTRY_BASE` is a module-level constant resolved once at import from the real `process.env`, so no per-test env can be substituted through the `installPlugins` path — the existing test `downloads, verifies integrity, extracts, and reports the registry URL` (`src/plugins/install.test.ts:80-98`, unmodified by this PR) already asserts the first metadata URL begins with `https://registry.npmjs.org/` under the ambient (unset) test environment, which is the same assertion Step 4 asks for. The actual regression coverage for the blank-string bug itself comes from the four direct `resolveRegistryBase` unit tests instead, which exercise the fixed function without depending on module-import-time environment state.
4. **Extended two more places than Step 5 named.** Step 5 named the `RESERVED_KEYS` gotcha and "where [`ops/README.md`] says the runtime variables stay claimable" — done. Two more spots made the same three-groups/no-group-4 factual claim and were fixed for the same reason (a false factual claim is major, not docs polish): (a) `ops/bot-ops.sh`'s own header comment above `RESERVED_KEYS` said "Three groups" and enumerated only 1–3; updated to four groups with group 4 described. (b) `ops/README.md`'s env-set semantics section (~L313-318, item "(4) A key the deployment or the bot core owns") separately enumerated the reserved settings without group 4; updated alongside the location Step 5 named.
