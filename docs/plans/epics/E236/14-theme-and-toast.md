<!--
Source: the orchestrating session's implementation-plan comment on
https://github.com/Rackbops/rackbops-discord-bot/issues/300#issuecomment-5771513661 (2026-09-22),
headed "Implementation plan, part A — written by the orchestrating session, to be executed as
written." Committed verbatim as the plan, per that heading. Part B1's focused form-state plan is
appended below Part A; Part B2 retains the toast work after #246. Each "Deviations" section is the
implementing session's own record,
not part of the source plan.
-->

## Part A — vendor @rackbops/styles 0.2.42 and drop the local switch override

## Implementation plan, part A — written by the orchestrating session, to be executed as written

#300 ships as **two PRs**, so that #246 (Subordinate #2, `index.html` throughout) is not fought over. **Part A, this plan:** the `@rackbops/styles` bump to **0.2.42** and the deletion of the panel's local switch override — one line of `index.html`, five lines of `admin.css`, the three theme files. **Part B** (the `field-hint` → `rb-field__help` / `rb-field__error` / `rb-label__required` sweep and the `rb-toast` adoption for #245's and #246's outcomes) gets its own plan after #246 merges; nothing from it is done here. Written 2026-09-22 against `origin/main` @ `585ce4b`; every cite read from source that day. Cite by construct, never by line.

**Files:** `ops/admin/theme/package.json`, `ops/admin/theme/bun.lock`, `ops/admin/public/rb-theme.css` (generated), `ops/admin/public/admin.css`, `ops/admin/public/index.html` (one line), `ops/admin/server.test.ts` (one `expected fragments` entry), `CONTEXT.md` (the `rb-theme.css` row's version, the `admin.css` row's mention of the switch composite if any), `docs/plans/epics/E236/14-theme-and-toast.md` (this plan as its "Part A" section; Part B is appended later). Nothing under `src/`, nothing in `server.ts`.

### What the code says (read, not guessed)

- `ops/admin/theme/README.md`: bump = edit the exact pin in `package.json`, `bun install`, `bun run build` there, commit `package.json` + `bun.lock` + the regenerated `rb-theme.css`; never hand-edit `rb-theme.css`; its first line stamps the version, and a `server.test.ts` test fails when the stamp and the pin disagree (`themePkg.devDependencies["@rackbops/styles"]` vs the first-line stamp). The pin is `0.2.39` today; `rb-theme.css` line 1 says `@rackbops/styles@0.2.39`.
- `build-theme.ts` concatenates `node_modules/@rackbops/styles/arcane-obsidian/bundle.css` and `arcane-parchment/bundle.css`, and refuses when the installed version and the pin differ.
- The std-lib releases since 0.2.39: **0.2.40** (`.rb-toast`, #211), **0.2.41** (a track-and-thumb `.rb-switch` in every theme, #209), **0.2.42** (`.rb-field__help`, `.rb-field__error`, `.rb-label__required`, `[aria-invalid="true"]` on `.rb-input`/`.rb-select`/`.rb-textarea`, #210). `gh release list --repo Rackbops/rackbops-ui-ux-std-lib` confirms 0.2.42 is `Latest`.
- The local override: `admin.css` has five rules under `.rb-switch.adm-switch` (`appearance: none`, the `::after` thumb, `:checked`, `:checked::after`, `:focus-visible`), and `index.html`'s `buildTurnItOnStep` sets `check.className = "rb-switch adm-switch";` — the only `adm-switch` in the repo. `server.test.ts`'s `expected fragments` table pins `['check.className = "rb-switch adm-switch";', 1]`.
- `admin.css`'s "tokens only" test and `CONTEXT.md`'s `admin.css` row both describe the file; `CONTEXT.md`'s `rb-theme.css` row names the bump procedure.

### Decided — not open for re-planning

1. **Bump straight to 0.2.42**, not 0.2.41: Part B needs #210's classes and there is no reason to build the theme twice. Read the `rb-theme.css` diff and name in the PR body everything it carries beyond the switch, the toast and the form-validation rules (anything else that landed 0.2.39 → 0.2.42 in the two arcane bundles); a change that alters an existing rule the panel relies on is a finding to raise, not to absorb silently.
2. **Delete the override entirely** — all five rules and the `adm-switch` class; the switch is `<input type="checkbox" role="switch" class="rb-switch">` and nothing else. No replacement rule in `admin.css`: if 0.2.42's `arcane-obsidian`/`arcane-parchment` switch does not render acceptably in the panel, that is a std-lib finding (file it there, keep the override, say so) — never a second local override.
3. **Nothing else in `index.html` or `admin.css` changes.** No `field-hint` rename, no toast, no touching of the plugin cards beyond that one class string. If the bump's diff shows 0.2.42 now ships a rule the panel duplicates locally (other than the switch), note it for Part B and leave it.

### Steps

1. `ops/admin/theme/package.json`: `"@rackbops/styles": "0.2.42"`; `bun install` in `ops/admin/theme`; `bun run build` there; commit the three files. Paste `bun run build`'s output line (`build-theme: wrote public/rb-theme.css from @rackbops/styles@0.2.42 (<n> bytes)`).
2. `admin.css`: delete the five `.rb-switch.adm-switch` rules (and their section comment if one exists).
3. `index.html`: `check.className = "rb-switch";`.
4. `server.test.ts`: the `expected fragments` entry becomes `['check.className = "rb-switch";', 1]`; if `'rb-switch adm-switch'` appears in any other test string, remove it. Add one source pin: `expect(indexSrc).not.toContain("adm-switch"); expect(adminCss).not.toContain("adm-switch");` in the `admin.css uses tokens only` describe or beside the fragments test (whichever already reads `admin.css`).
5. Docs: `CONTEXT.md`'s `rb-theme.css` row (the version it names, if it names one) and the `admin.css` row (drop the switch from its composites list if listed); `docs/plans/epics/E236/14-theme-and-toast.md` with this plan as "Part A" and a Deviations section.

### Coverage table

| Outcome | Step | Test | Mutation that must fail it |
|---|---|---|---|
| the vendored theme is 0.2.42 and was rebuilt, not hand-edited | 1 | the existing theme-stamp test (pin vs `rb-theme.css` line 1) | edit the pin without rebuilding; edit the stamp line by hand |
| the switch override is gone | 2, 3, 4 | the new `adm-switch` absence pin; the moved fragment entry | restore the class on the switch; restore one `.rb-switch.adm-switch` rule |
| the switch still reads as a switch | 2, 3 | — manual: real browser, light and dark, off / on / focused (screenshots) | — |
| nothing else moved | — | `bun test ops/admin/server.test.ts` green with no other fragment count touched | — |

### Acceptance — execute these, paste the real output

```
bun run --cwd ops/admin/theme build
bun run --cwd ops/admin check
bun test ops/admin/server.test.ts --timeout 20000      # one run at a time on this box; private TEMP/TMP
git grep -n adm-switch -- ops/admin                    # must print nothing
```

Plus: the real-browser check of the card switch against the #244/#245 probe harness or a locally served panel with canned data — off, on, keyboard-focused, light and dark — screenshots to roshne directly; and the `rb-theme.css` diff summary (decision 1) in the PR body.

### PR

Branch `claude/theme-0-2-42` from `origin/main` (at or after `585ce4b`), isolated worktree under `R:/repos/Scratch/worktrees/`; title `chore(admin): vendor @rackbops/styles 0.2.42 and drop the local switch override (#300)`; body with **`Part of #300`** (not `Closes` — Part B closes it), the plan file, deviations, the pasted acceptance, the mutation results, the round list. Behaviour change (the switch's rendering) but small: the full gate still applies — two adversarial read-only reviewers with different lenses (A: the rendering in a real browser, both schemes, focus ring, the diff of `rb-theme.css` for anything beyond the three give-backs; B: claims-vs-code — the stamp, the fragment counts, no leftover `adm-switch`, the CONTEXT.md sentences). One round is expected; at most four, then stop and tell the orchestrator. Never merge. Subordinate #2 will be editing `index.html` for #246 at the same time: your one-line change merges cleanly, but run `ops/admin/server.test.ts` one at a time on this box.

## Deviations from the plan

- **The `rb-theme.css` diff (decision 1) carries nothing beyond the three named give-backs.** Diffed
  `styles/arcane-obsidian/` and `styles/arcane-parchment/` in `rackbops-ui-ux-std-lib` between tags
  `v0.2.39` and `v0.2.42` directly (not inferred from the generated file): the only changes are
  `components/form.css`'s #210 additions (`.rb-label__required`/`.rb-field__help`/`.rb-field__error`
  plus the `[aria-invalid="true"]` rules), `components/form.css`'s #209 switch rework
  (`.rb-checkbox`/`.rb-radio` losing the shared `accent-color` block's `.rb-switch` member, `.rb-switch`
  itself becoming the track-and-thumb shape), a new `components/toast.css` (#211) and its `@import`
  line in `index.css`, and each theme's `design.md` prose (not shipped — `bundle.css` never includes
  `design.md`). No existing rule the panel relies on changed shape or value. Nothing to raise as a
  finding.
- **`CONTEXT.md` needed no edit.** Checked both conditions the plan names directly: the `rb-theme.css`
  row (`CONTEXT.md`'s `ops/admin/public/rb-theme.css` entry) says only "line 1 names the version it
  came from" — it does not itself name a version number, so there is nothing to update. The
  `admin.css` row does not mention the switch or any switch composite in its list of what the file
  covers, so there is nothing to drop from it either. Verified by reading both rows directly rather
  than assuming from the plan's conditional wording.
- **The literal acceptance command `git grep -n adm-switch -- ops/admin` is not fully empty**, and by
  construction cannot be: it also matches the two lines of the new source-pin test itself (Step 4),
  `expect(indexSrc).not.toContain("adm-switch"); expect(css).not.toContain("adm-switch");`, which must
  reference the literal string to assert its absence elsewhere. The actually shipped surfaces are
  clean — `git grep -n adm-switch -- ops/admin/public/index.html ops/admin/public/admin.css` returns
  nothing (exit 1) — and that is the real form of the acceptance bullet's intent ("the card switch is
  `class="rb-switch"` alone"). Both the literal command's real output and the scoped, genuinely-empty
  form are pasted in the PR body rather than silently substituting one for the other.

## Part B1 — adopt shared form states and complete std-lib #210

Written by the orchestrating session against `main` at `a754487` (`@rackbops/styles` 0.2.42 was
already vendored by Part A). This deliberately separates #210's form-state adoption from Part B2's
toast work and from #246's Servers behavior.

### Decided scope

1. This PR is form states only: no toast helper, routing outcome change, Servers tab change, or #246 code.
2. Every old `field-hint` is classified. Help for an editable control becomes `rb-field__help`;
   non-field panel copy becomes `adm-note` (and `adm-note--danger` for danger copy).
3. Required Config, plugin plain-setting and visible secret labels use a structured
   `<span class="rb-label__required" aria-hidden="true">*</span>` and their native controls carry
   `required` (the tag composite's focus input is its native control).
4. Rejected Config/plugin fields gain a stable adjacent `rb-field__error`, `aria-invalid="true"`,
   and an error id appended to `aria-describedby`. Clearing removes only that error and token,
   preserving help. The Apply bar remains the single live announcement surface.
5. Route validation uses the same shared help/error classes and stable description ids. The local
   `.route__channels[aria-invalid="true"]` and `.tag-field:has([aria-invalid="true"])` composite
   rules remain; the broad `.adm [aria-invalid="true"]` rule is deleted.

### Implementation steps

1. `ops/admin/public/index.html`: add required-marker, token-safe description and inline-error
   helpers; classify all old hints; add native required semantics; wire refusal/edit/apply/Discard
   error lifecycle; give route help/error stable ids and preserve help while errors appear/clear.
2. `ops/admin/public/admin.css`: rename panel notes, delete the broad local invalid rule, retain the
   tag and route composite rules.
3. `ops/admin/server.test.ts`: update class/CSS pins and exercise required semantics, the inline
   error consumer boundary, token preservation, route help/error wiring, and local composite rules.
4. `CONTEXT.md` and `ops/README.md`: state the shared-vs-local styling ownership.

### Coverage table

| Acceptance outcome | Steps | Test | Mutation that must fail it |
|---|---|---|---|
| typecheck and panel tests green | 1–3 | acceptance commands | — |
| no `field-hint`; true control help/errors use shared classes, other copy uses `adm-note` | 1–3 | source pins plus Apply harness | restore one `field-hint`; classify a control description as `adm-note` |
| required labels use the shared marker and native controls carry `required` | 1, 3 | Config/plain/secret/tag builder pins | restore string-concatenated `" *"`; omit `required` from one native control |
| validation is inline, invalid, and described without losing help | 1, 3 | Apply refusal/edit/Discard harness | replace `aria-describedby` instead of adding a token; omit the inline error node |
| route validation adopts shared help/error and preserves its composite outline | 1–3 | route source/harness pins | remove the help id while adding the error; remove the route composite rule |
| broad local invalid CSS is gone; tag composite remains | 2, 3 | CSS rule/source test | restore `.adm [aria-invalid]`; delete `.tag-field:has(...)` |
| browser behavior works in both schemes | 1–2 | manual Chrome acceptance | — |

### Acceptance

```text
bun run --cwd ops/admin check
bun test ops/admin/server.test.ts --timeout 20000
git grep -n "field-hint" -- ops/admin
git grep -n 'adm \[aria-invalid="true"\]' -- ops/admin/public/admin.css
```

The two greps must print nothing. The test file runs once at a time with private `TEMP`/`TMP`.
Mutation-test each behavior-changing line, at minimum the coverage-table mutations. In real Chrome
with canned current-main data and both schemes: verify Config required/help/error behavior and
error clearing; required plugin plain and visible secret controls; chosen-with-no-channels route
error plus retained composite outline; and keyboard reachability.

### Deviations and evidence

- **Scope:** no product-scope deviation. This remains form states only; no toast, Servers or #246
  behavior was added. The form-state helpers are deliberately unmarked rather than increasing the
  page's documented 22 lifted test-block markers: the existing Apply and route harnesses execute the
  helper source immediately before their marked blocks.
- **Acceptance (private `TEMP`/`TMP`, serial):** `bun run --cwd=ops/admin check` exited 0 with
  `$ bunx tsc --noEmit`. The final clean `bun test ops/admin/server.test.ts --timeout 20000`
  exited 0 with `775 pass`, `5 skip`, `0 fail`, `3389 expect() calls`, and
  `Ran 780 tests across 1 file`.
  `git grep -n "field-hint" -- ops/admin` and
  `git grep -n 'adm \[aria-invalid="true"\]' -- ops/admin/public/admin.css` both printed nothing
  (the expected git-grep exit 1 for no matches).
- **Mutation matrix:** 48 one-at-a-time mutants in detached worktree
  `bot-300-form-states-mutations`; every final mutant was killed, and each run executed the full
  focused test file. The first 19 covered a restored legacy hint,
  a control help misclassified as `adm-note`, string-only and exposed required markers, missing native
  `required` on plain/secret/Config/tag controls, overwritten help descriptions, a missing inline
  error, stale error cleanup, route help-token loss, removed route/tag composite rules, restored broad
  invalid CSS, and missing Config/plain/secret help description tokens. The Config help-token mutant
  initially survived; three builder assertions were added, after which that mutant and the equivalent
  plain-plugin and secret mutants all failed. The strengthened clean baseline then returned the
  acceptance result above. After round 1, 29 further mutants covered all 18 panel-note
  classifications, both saved/visible secret-label branches, the multiline plan-error key and inline
  refusal, live required-marker append, and all three route invalid/error DOM writes; all 29 were
  killed with `Ran 780 tests across 1 file` in every run.
- **Review gate round 1:** both independent reviewers returned NOT SOUND. Reproduced findings were:
  multiline `plan.error` could bypass the adjacent inline refusal; the saved-secret branch left an
  orphaned label; the non-field-note, marker-append and three route invalid/error writes did not all
  have line-level mutation guards. The implementation and consumer tests were corrected, then the
  final baseline and 29-mutant follow-up above were run against the complete state. The claims
  reviewer's screenshot-artifact concern is disclosed below rather than papered over.
- **Real Chrome, canned current-main data:** the complete pre-review pass in both `arcane-obsidian`
  and `arcane-parchment` rendered the
  blank required Config refusal with native `required`, focused invalid control, adjacent
  `rb-field__error` (no competing live role), and both help/error ids in `aria-describedby`; typing
  removed only the error node/token. The plugin's required plain and visible secret controls exposed
  the shared marker, native `required`, and shared help token. Chosen-with-no-channels routing exposed
  shared help/error tokens plus the retained `1px solid` composite outline. Keyboard traversal reached
  Config, plugin switch, routing checkbox/radio, plain setting, visible secret and Apply controls.
  After the round-1 behavior fixes, the dark Config multiline/required refusal was re-run and again
  showed native `required`, focus, invalid state, both description tokens and an adjacent shared error
  with no live role. The later fixes did not change the already-verified light-theme CSS or route
  behavior; the saved-secret label branch is additionally executed in the final browser-DOM test.
  Dark and light screenshots were captured inline by the Chrome automation surface. Environment gap:
  that surface exposes screenshot bytes/display but no documented local-file save API, so no local
  screenshot path could be produced without leaving the required computer-use surface.
