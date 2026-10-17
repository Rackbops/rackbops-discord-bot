<!-- E516 / #533 bundle P2: CONTEXT.md. Children: #412, #413, #414, #475, #476. File: CONTEXT.md only.
Doc-only: the single claims-vs-code audit lane, not the two-reviewer gate. CUT AFTER #529's A3b MERGES, because
A3b also edits CONTEXT.md (the admin-page rows and the lifted-block count). Line numbers below are at ae0339a and
will move, so anchor every edit on the quoted text.
Audit: (filled in when the read-only audit has run). -->

# #533 P2 -- CONTEXT.md

## What is wrong, verified at ae0339a

Already fixed, so closed by reference with no edit:

- **#412**: the `src/storage.ts` File Map row now gives `tmpPathFor`'s
  `${path}.${pid}.${TMP_TOKEN}.${counter}.tmp`, and names #154 and #253.
- **#475 -12**: the `src/docker.test.ts` row says a test compares the bound table with the module's async
  exports, so a new call without a row turns the suite red (#513).
- **#475 -8**, four of the five cites: `index.ts:144/:163`, `commands.ts:124/:252` and `host.ts:57` no longer
  appear in CONTEXT.md.
- **#475 -11**, two of the four counts: "14 daemon calls" and "six hardcoded /app/data places" are gone.
- **#475 -10**, the parts already in: the redeploy row names `restorePolicy` (#160), the config row covers
  `HTTP_PORT` and `TRUSTED_PROXY_HOST`, the CI paragraph names `--randomize` and the `docker-build` job, and the
  `RESERVED_KEYS` paragraph lists `TRUSTED_PROXY_HOST`.

Still wrong:

1. **#413** The gotcha starting "Every `*.test.ts` that reaches the `config` singleton" (CONTEXT.md:1294-1297)
   says such a test must prime `DISCORD_TOKEN`/`ANNOUNCE_CHANNEL_ID` or it throws standalone, and that
   `config.test.ts` sorting first masks this. test/setup.ts:74-80 is the first `bunfig.toml` preload, and it
   FORCES both (`process.env.DISCORD_TOKEN = "test-token"`, #462) before any test file loads. So no test can
   throw for them. Also read the "first-importer-wins" paragraph (Grep `first-importer-wins`, about :437) and the
   `test/setup` mentions around :452 and :482-484. Fix whichever of them still describes `??=` priming instead of
   the forced values.
2. **#414** The paragraph ending "**Not fixed here:** the admin panel still offers *Update now* on a carried-off
   plugin's card until #244 folds in an `enabled` check" (CONTEXT.md:1388-1391). #244 landed: the card builds its
   update block only when `p.enabled` (Grep `if (p.enabled)` in `ops/admin/public/index.html`), and the
   plugins row already says "shown only while enabled".
3. **#475 -6** The `src/plugins/updates.ts` row (Grep `only after a successful delivery (capped retries)`) and the
   Behavior line (Grep `after a successful DM (channel fallback once, then capped retries)`) say notifiedVersion
   is recorded only after delivery. src/plugins/updates.ts:644-727 records it anyway after
   `MAX_DELIVERY_ATTEMPTS` (3) failed attempts, logging "gave up notifying ... recording it notified". The
   counter is the in-memory `deliveryFailures` map (:645), so a restart resets it.
4. **#475 -8** The cite "`ops/admin/server.ts:592-593`" (CONTEXT.md:1995) is stale.
   `SUBPROCESS_TIMEOUT_MS`/`IDLE_TIMEOUT_SECONDS` are now at server.ts:667-668.
5. **#475 -11** "27 of them today" in the admin-page row (Grep `of them today`) is a count the lifted-block test
   already enforces, and A3b changes it. "right after `readonly BOT_OPS_SCHEMA=1`" (CONTEXT.md:1468) is out of
   date, because the schema is now 8 (Grep `readonly BOT_OPS_SCHEMA=` in ops/bot-ops.sh).
6. **#475 -10**, the parts not yet re-checked. For each one, check the code, then the row, and fix only what lags:
   - the `src/plugins/registry.ts` row and the skip of a plugin whose name equals a core command (#185; Grep
     `core command` in `src/plugins/registry.ts`)
   - the **Host API** glossary entry and `post`/`dm`/`edit`/`destinations` (Grep those names in the `HostApi`
     interface in `src/plugins/contract.ts`)
   - the interaction-routing description and autocomplete plus component presses (Grep `isAutocomplete\|
     isButton\|isMessageComponent` in `src/index.ts`)
   - the self-update Behavior section, which shows only the exit-75 path (Grep `exit 75\|75` in that section,
     then read `src/update.ts`'s outcome branches, including the D3 `undetermined` decision)

   Where the detail already lives in a Gotcha, point the row at that Gotcha instead of repeating it.
7. **#476 -13** CONTEXT.md:979: "see the ⚠️ design-constraint section on #160". No such section exists; the
   only ⚠️ marks are :801 (an unrelated "no-op") and this one. #160 is the closed issue "redeploy: stop the
   un-verified standby being resurrected (restart-policy half of #85)".
8. **#476 -14** Files with no backticked full-path mention anywhere in CONTEXT.md (checked at ae0339a with the
   script in Verification):
   - `.github/workflows/push-notify.yml`, `ops/admin/theme/build-theme.test.ts`, `ops/install.test.ts`
   - `src/client.test.ts`, `src/dataIsolation.test.ts`, `src/fetchTimeouts.test.ts`, `src/http.test.ts`,
     `src/index.test.ts`, `src/interactionLog.test.ts`, `src/logFormat.test.ts`, `src/report.test.ts`,
     `src/storage.test.ts`
   - `src/plugins/delivery.test.ts`, `src/plugins/drain.test.ts`, `src/plugins/hostMessage.test.ts`
   - `src/routing/{discovery,gate,live,model,post,register,requests,resolve,secrets-leak,store}.test.ts`
   - `test/preload.fixture.ts`, `test/settleWithin.ts`, `test/stallBunWrite.ts`, `test/storageProbes.ts`,
     `test/sweep.test.ts`

## Decisions

- **No counts in prose** where a test already enforces the number: drop "27 of them today" and keep "every name
  listed once in `server.test.ts`'s lifted-block test". Write `readonly BOT_OPS_SCHEMA=<n>`.
- **Cite by name, not by line**, for the #475 -8 fix: "(`SUBPROCESS_TIMEOUT_MS = 90_000`,
  `IDLE_TIMEOUT_SECONDS = 120` in `ops/admin/server.ts`)".
- **#476 -13:** replace the dangling pointer with "see #160 and the `restorePolicy` gotchas above". Before
  writing it, Grep `restorePolicy` in CONTEXT.md to confirm a gotcha above :979 explains why the original is the
  live one on a first attempt. If none does, link #160 alone and say in one clause what it decided: the
  standby's policy stays `no` until it verifies.
- **#476 -14:** the File Map gets one row per test file that has its own subject, and directory rows for the
  rest:
  - one `src/routing/*.test.ts` row naming what each file pins, in one line each or as a list
  - one `test/` helpers row covering `preload.fixture.ts`, `settleWithin.ts`, `stallBunWrite.ts`,
    `storageProbes.ts` and `sweep.test.ts`
  - a row for `push-notify.yml` next to the existing workflow mention

  Each row says what the file tests, taken from its `describe` names; Grep `describe(` in the file. Put each
  row next to its source file's row.

## Steps

1. Rebase nothing; branch from `origin/main` after A3b has merged. Re-run the Verification script first, because
   A3b may have added rows.
2. #413: rewrite the gotcha as: "`test/setup.ts`, the first `bunfig.toml` preload, forces `DISCORD_TOKEN` and
   `ANNOUNCE_CHANNEL_ID` before any test file loads (#462), so a test that reaches `config` needs no priming of
   its own, standalone or in the full suite." Fix the related paragraphs found per item 1.
3. #414: replace the "Not fixed here" sentence with "#244 resolved this: the card builds its update block only
   while the plugin is enabled, so an off plugin shows no *Update now*."
4. #475 -6: in both places, add "after `MAX_DELIVERY_ATTEMPTS` (3) undelivered attempts it records the version
   notified anyway and logs the give-up; the attempt count is in memory, so a restart starts it again".
5. #475 -8, -11: per Decisions.
6. #475 -10: per item 6.
7. #476 -13, -14: per Decisions.

## Tests

None; doc-only. `bun run check` and `bun test` must stay green.

## Mutation table

N/A, because no code changes. Each Coverage check is run on the pre-change tree (it must fail there) and on the
branch (it must pass).

## Coverage table

| Finding | Step | Check |
|---|---|---|
| #412 | none | closed by reference: Grep `TMP_TOKEN}.${counter}.tmp` in CONTEXT.md finds the storage row |
| #413 | 2 | Grep `must prime\|sorts first and primes` in CONTEXT.md: 0 hits |
| #414 | 3 | Grep `Not fixed\s+here` (multiline) in CONTEXT.md: 0 hits near `#244` |
| #475 -6 | 4 | Grep `MAX_DELIVERY_ATTEMPTS` in CONTEXT.md: at least 2 hits |
| #475 -8 | 5 | Grep `server\.ts:59` in CONTEXT.md: 0 hits |
| #475 -10 | 6 | each sub-item's row names what the code does (quote before/after) |
| #475 -11 | 5 | Grep `of them today\|BOT_OPS_SCHEMA=1` in CONTEXT.md: 0 hits |
| #475 -12 | none | closed by reference (#513) |
| #476 -13 | 7 | Grep `design-constraint` in CONTEXT.md: 0 hits |
| #476 -14 | 7 | the Verification script prints no `NOROW` line |

## Verification

Run this from the worktree root in Git Bash, and paste its output before and after. A file counts as covered if
its full path, or a directory glob that matches it (`src/routing/*.test.ts`, `test/`), appears in backticks:

```bash
git ls-files 'src/*.ts' 'src/**/*.ts' 'test/*' 'ops/*.ts' 'ops/**/*.ts' '.github/workflows/*' bunfig.toml 'src/**/fixtures/*' \
  | while read -r f; do d=$(dirname "$f"); grep -qF "\`$f\`" CONTEXT.md || grep -qF "\`$d/*.test.ts\`" CONTEXT.md \
  || grep -qF "\`$d/\`" CONTEXT.md || echo "NOROW $f"; done
```

Then run one independent claims-vs-code audit: spawn a read-only Sonnet agent on the branch. It checks every
sentence this PR adds or changes against the code it cites, and reports anything false. Fix what it finds.
Rewording needs no second audit.

## Acceptance

- [ ] Every Coverage check passes, with before/after output pasted in the PR.
- [ ] The Verification script prints no `NOROW`.
- [ ] The audit report is pasted or summarised with each finding and its fix.
- [ ] `bun run check` and `bun test` green.

## PR

Title: `docs(context): correct the test-env, #244, notifiedVersion, cite and count claims, fix the #160 pointer, and map every test file (#412, #413, #414, #475, #476)`.
The body names what was already fixed and is closed by reference: #412, #475 -12 by #513, and the parts of -8,
-10 and -11 listed above.

## Out of scope

- README, ADRs, CLAUDE/AGENTS/PURPOSE, ops/README (bundle P1).
- Any test or code change. The #475 -12 scan already exists (#513).
