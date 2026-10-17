<!-- E516 / #533 bundle P2: CONTEXT.md. Children: #412, #413, #414, #475, #476. File: CONTEXT.md only.
Doc-only: the single claims-vs-code audit lane, not the two-reviewer gate. CUT AFTER #529's A3b MERGES, because
A3b also edits CONTEXT.md (the admin-page rows and the lifted-block count). Line numbers below are at ae0339a and
will move, so anchor every edit on the quoted text.
Audit: round 1 (S:/Repos/_wt/audits/533-docs-audit-round1.md, at ae0339a): 2 majors (the NOROW script's bare-dir
fallback hid 24 of 30 files, the #475 -6 check passed on the old tree) + 3 minors (the no-admins clause, the #412
fixed-string search, #160's real section name), all applied; the four #475 -10 sub-items re-checked and all lag.
Round 2 (narrow, 533-docs-audit-round2.md): READY; 3 minors applied (the #160 pointer sits in the restorePolicy
gotcha, index.ts cite to :343, a searchable #475 -10 check). -->


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
   counter is the in-memory `deliveryFailures` map (:645), so a restart resets it. The cap applies only when
   admins are configured (:717 `else if (deps.adminUserIds.length > 0)`): with none, it warns and retries every
   tick, recording nothing (the `updates.test.ts` row already says the no-admins notice is kept across
   `MAX_DELIVERY_ATTEMPTS + 1` ticks).
4. **#475 -8** The cite "`ops/admin/server.ts:592-593`" (CONTEXT.md:1995) is stale.
   `SUBPROCESS_TIMEOUT_MS`/`IDLE_TIMEOUT_SECONDS` are now at server.ts:667-668.
5. **#475 -11** "27 of them today" in the admin-page row (Grep `of them today`) is a count the lifted-block test
   already enforces, and A3b changes it. "right after `readonly BOT_OPS_SCHEMA=1`" (CONTEXT.md:1468) is out of
   date, because the schema is now 8 (Grep `readonly BOT_OPS_SCHEMA=` in ops/bot-ops.sh).
6. **#475 -10**, the four remaining parts. All four were re-checked at ae0339a and all four lag:
   - **Registry row** (`src/plugins/registry.ts`, about :218): lists a command that collides with a core
     command, but not the skip of a plugin whose NAME equals a core command, because its interaction-routing
     prefix `<name>:` is reserved (#185; src/plugins/registry.ts:75-76 doc, :169 the reason string).
   - **Host API glossary** (about :68-72): lists `name`, `env`, `dataDir`, `log`, `storage`, `announce`. The
     interface also has the optional `post` (src/plugins/contract.ts:313), `dm` (:319), `edit` (:323) and
     `destinations` (:326), absent on an older host. Detail already lives in the gotchas about :402 and :416
     (buttons, #323): point at them.
   - **Interaction routing** (the `src/index.ts` File Map row, about :157): names only commands ->
     `handleCommand` and `/report` modal submits. src/index.ts:313-343 also sends component presses and other
     modal submits to `dispatchPluginInteractionOutcome` (an unclaimed press gets `answerUnclaimedPress`, #323)
     and autocomplete to `dispatchPluginAutocomplete` (#287). The autocomplete gotcha (about :1392) carries the
     detail: point at it.
   - **Self-update Behavior** (about :326-340): shows stale -> persist -> `redeploy()` or exit 75 only. src/update.ts
     also decides `suppressed` (:29, :95), `busy` (:31, #449) and `undetermined` (:34, :91: a failed compare; the
     automatic check waits, an admin's `/update` acts, #505), and a mounted socket whose daemon does not answer
     its ping twice reports `daemonUnreachable` and does NOT exit 75 (:373-390, #505). The follow-up bullet
     (about :338-340) lists five outcomes; README.md:106-112 lists six, adding `unknown` (no `GIT_SHA` baked
     in). Add the three decisions and the unreachable-daemon branch in one or two sentences each, and `unknown`.

   Where the detail already lives in a Gotcha, point the row at that Gotcha instead of repeating it.
7. **#476 -13** CONTEXT.md:979: "see the ⚠️ design-constraint section on #160". No such section exists; the
   only ⚠️ marks are :801 (an unrelated "no-op") and this one. #160 is the closed issue "redeploy: stop the
   un-verified standby being resurrected (restart-policy half of #85)".
8. **#476 -14** Files with no backticked full-path mention anywhere in CONTEXT.md (checked at ae0339a with the
   script in Verification, which prints exactly these 30 `NOROW` lines there):
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
- **#476 -13:** the "section" is not in CONTEXT.md; it is a heading on #160 itself ("Read this before
  implementing", under a warning sign). The pointer at :979 sits inside the same gotcha as the `restorePolicy`
  explanation at :971, so replace it with "see the 'Read this before implementing' section of #160".
- **#476 -14:** the File Map gets one row per test file that has its own subject, and directory rows for the
  rest:
  - one `src/routing/*.test.ts` row (that exact backticked glob) naming what each file pins, in one line each or
    as a list
  - one `test/` helpers row naming each file by its full backticked path (`test/preload.fixture.ts`,
    `test/settleWithin.ts`, `test/stallBunWrite.ts`, `test/storageProbes.ts`, `test/sweep.test.ts`): a bare
    `test/` does not count, since the script accepts only a full path or `<dir>/*.test.ts`
  - a row for `.github/workflows/push-notify.yml` next to the existing workflow mention
  - a row for each other listed file, by its full backticked path

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
4. #475 -6: in both places, replace "only after a successful delivery (capped retries)" and "after a successful
   DM (channel fallback once, then capped retries)" with the delivery rule plus: "with admins configured, after
   `MAX_DELIVERY_ATTEMPTS` (3) undelivered attempts it records the version notified anyway and logs the give-up
   (the attempt count is in memory, so a restart starts it again); with no admins it warns and records nothing".
5. #475 -8, -11: per Decisions.
6. #475 -10: per item 6.
7. #476 -13, -14: per Decisions.

## Tests

None; doc-only. `bun run check` and `bun test` must stay green.

## Mutation table

N/A, because no code changes. Each Coverage check is run on the pre-change tree (it must fail there: a "before"
run that already passes means the check is wrong) and on the branch (it must pass).

## Coverage table

Every search is written in `rg` notation for the Grep tool (ripgrep; MILE's Git Bash has no `rg`, so run them
through the Grep tool, `-U` meaning `multiline: true`): alternation is a bare `|`, never `\|` (literal pipe in
ripgrep); `-F` for a fixed string with `$`/`{}` in it (escape them in the Grep tool's regex); `-U` with `\s+`
where a phrase may wrap.

| Finding | Step | Check (before: hits, after: 0 unless stated) |
|---|---|---|
| #412 | none | closed by reference: `rg -nF 'TMP_TOKEN}.${counter}.tmp' CONTEXT.md` finds the storage row (before and after) |
| #413 | 2 | `rg -nU 'must\s+prime|sorts\s+first\s+and\s+primes' CONTEXT.md` |
| #414 | 3 | `rg -nU 'Not\s+fixed\s+here' CONTEXT.md`: no hit within the #244 paragraph |
| #475 -6 | 4 | `rg -nU 'only\s+after\s+a\s+successful\s+delivery|after\s+a\s+successful\s+DM\s+\(channel' CONTEXT.md`: 0 after; `rg -nU 'records\s+the\s+version\s+notified\s+anyway' CONTEXT.md`: before 0, after 2 |
| #475 -8 | 5 | `rg -n 'server\.ts:59' CONTEXT.md` |
| #475 -10 | 6 | `rg -n 'answerUnclaimedPress|dispatchPluginAutocomplete|daemonUnreachable|undetermined' CONTEXT.md`: quote the hit count before and after (it must rise in the index.ts row and the self-update section); and quote each of the four rows before and after: the registry row names the plugin-name skip; the Host API entry names `post`/`dm`/`edit`/`destinations`; the index.ts row names presses and autocomplete; the self-update section names `suppressed`, `busy`, `undetermined`, the unreachable daemon, and `unknown` |
| #475 -11 | 5 | `rg -n 'of them today|BOT_OPS_SCHEMA=1' CONTEXT.md` |
| #475 -12 | none | closed by reference (#513) |
| #476 -13 | 7 | `rg -n 'design-constraint' CONTEXT.md` |
| #476 -14 | 7 | the Verification script: before, the 30 lines in item 8 (fewer if A3b added rows; paste what it prints); after, no `NOROW` line |

## Verification

Run this from the worktree root in Git Bash, and paste its output before and after. A file counts as covered only
if its full path, or the glob `<its dir>/*.test.ts` (for a test file), appears in backticks. A bare directory
mention does not count: `src/`, `src/routing/` and `src/plugins/` all appear in prose, so accepting them hid 24 of
the 30 files at ae0339a.

```bash
git ls-files 'src/*.ts' 'src/**/*.ts' 'test/*' 'ops/*.ts' 'ops/**/*.ts' '.github/workflows/*' bunfig.toml 'src/**/fixtures/*' \
  | while read -r f; do d=$(dirname "$f"); grep -qF "\`$f\`" CONTEXT.md \
  || { [[ "$f" == *.test.ts ]] && grep -qF "\`$d/*.test.ts\`" CONTEXT.md; } || echo "NOROW $f"; done
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
