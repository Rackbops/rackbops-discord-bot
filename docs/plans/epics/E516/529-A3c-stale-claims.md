<!-- Plan for #529 bundle A3c (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #529): the stale claims left in
#468 item 12, #469 and #514 item 5. Written by the orchestrating session on 2026-10-17; every `file:line` below was
read at main `75d5457`. Files: `ops/admin/public/admin.css`, `ops/admin/theme/README.md`, `ops/admin/theme/build-theme.ts`,
`ops/admin/theme/build-theme.test.ts`, `CONTEXT.md`, `docs/adr/0004-plugins-fetched-from-a-published-manifest.md`.
None of them is touched by A3a or A3b. -->

## Implementation plan -- #529 A3c: the last stale claims are true, and the theme pin check is tested

Children: **#469** (closes), **#514** (closes: items 2-6 landed in #590 and #591; item 5's last cite here), and
**#468** item 12 (with A3a's 8/10 and A3b's 9/11, #468 closes when the last of the three merges). One PR, branch
`fix/529-A3c-stale-claims`, worktree `S:\Repos\_wt\rdb-529-A3c` cut from `origin/main`. One behaviour-free code change
(a pure function extracted and tested) plus wording: the full gate applies to the code half, the docs half is
claims-vs-code.

### What is wrong, verified at `75d5457`

- **#468 item 12.** `ops/admin/public/admin.css:565` says "Three tabs fit a phone"; `TAB_IDS`
  (`ops/admin/public/index.html:249`) has four. The item's other two cites are already gone from `CONTEXT.md` (Grep
  `host.ts:57`, `server.ts:743`, `24 marked`: no match at `75d5457`), and A1 (#590) derived the lifted-block set from
  the page's markers.
- **#469.** `ops/admin/theme/README.md:6` says a bump without a rebuild "cannot merge", and `CONTEXT.md:1774-1777`
  says the test fails on "a bump without a rebuild (or a hand-edit of the banner)". The test compares line 1 with
  `composeThemeCss(pin)`'s banner only: a hand edit below line 1 is not caught, and "cannot merge" holds only while
  that test runs in a required job. `build-theme.ts`'s pin check (`:37-40`, inside `import.meta.main`) and
  `EXACT_VERSION_RE` (`:7`) have no test.
- **#514 item 5.** `docs/adr/0004-plugins-fetched-from-a-published-manifest.md:12-13` cites `src/restart.ts:71-74`
  and `src/announce.ts:217` (the same kind of stale line cite the item lists; noted on #514 on 2026-10-16). The
  item's `ci.yml:39-40` count is already gone (Grep `491` in `ci.yml`: no match) and the `restart.test.ts` cite was
  fixed in #554.

### Steps

1. `admin.css:565`: "Four tabs fit a phone, ...".
2. `build-theme.ts`: extract `export function pinProblem(pin: unknown): string | null` -- the exact message the
   entry point fails with today when `typeof pin !== "string" || !EXACT_VERSION_RE.test(pin)`, else `null` -- and have
   the `import.meta.main` block call it (`const problem = pinProblem(pin); if (problem) fail(problem);`). No change to
   what the build does.
3. `build-theme.test.ts`: **B1** `pinProblem("1.2.3")` is null; `"^1.2.3"`, `"1.2"`, `"1.2.3-beta"`, `1`,
   `undefined` each return the message naming the value; **B2** `EXACT_VERSION_RE` rejects `"1.2.3 "` and `"v1.2.3"`.
4. `theme/README.md:6`: "`ops/admin/server.test.ts` compares the stamped banner with the pin, so forgetting to
   rebuild after a bump fails CI. It checks the banner line only: a hand edit below it is not caught, which is why
   the file is never hand-edited." `CONTEXT.md:1774-1777`: the same two facts.
5. ADR-0004 lines 12-13: cite by symbol -- `beginHandoff()` in `src/restart.ts`, and the scheduler's
   `restartPending()` check in `src/announce.ts`'s `onTick` (verify both names before writing). An ADR body is a
   record, but these are pointers, not decisions; say "(cites updated #514)" at the end of the sentence.

### Mutation table

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | `pinProblem` returns null for a range (`^1.2.3`) | B1 |
| M2 | `EXACT_VERSION_RE` loses its `$` | B2 |

### Coverage table

| Bullet | Step(s) | Test | Mutation |
|---|---|---|---|
| #468-12: the tab count is true (the other two cites already gone) | 1 | claims audit | -- |
| #469: the theme docs say what the test checks; the pin check is tested | 2, 3, 4 | B1, B2 | M1, M2 |
| #514-5: the last stale line cite is a symbol | 5 | claims audit | -- |

### Verification and Acceptance

- `bun test ops/admin/theme/build-theme.test.ts` and the full `bun test`; `bun run check` in `ops/admin/`. Paste
  B1/B2's pass lines and M1/M2's failing output.
- `git grep -n "cannot merge" ops/admin/theme/README.md` -> nothing. `git grep -n "Three tabs" ops/admin` -> nothing.
- `cd ops/admin/theme && bun run build` leaves `ops/admin/public/rb-theme.css` byte-identical (`git diff --exit-code
  ops/admin/public/rb-theme.css`), if the theme's deps are installed; else name it unverified.

### PR

Title: `fix(admin): test the theme pin check and correct the last stale claims (#469, #514, #468)`. End with
`Closes #469. Closes #514. Part of #468.`
