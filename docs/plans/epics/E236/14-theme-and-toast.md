<!--
Source: the orchestrating session's implementation-plan comment on
https://github.com/Rackbops/rackbops-discord-bot/issues/300#issuecomment-5771513661 (2026-09-22),
headed "Implementation plan, part A — written by the orchestrating session, to be executed as
written." Committed verbatim as the plan, per that heading. Part B (the field-hint sweep and the
toast adoption) gets its own plan after #246 merges, appended below this Part A section when it
lands. The "Deviations from the plan" section at the end is this implementing session's own record,
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
