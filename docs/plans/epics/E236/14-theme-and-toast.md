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

## Part B — the field-hint sweep, the required marker, and rb-toast

## Implementation plan, part B — written by the orchestrating session, to be executed as written

Part B of #300: the panel adopts the three form-validation classes and the required marker that `@rackbops/styles` 0.2.42 ships (std-lib #210), drops its own `aria-invalid` rule in favour of the theme's, and adopts `rb-toast` (#211) for outcomes that land after the click. Part A (PR #303, `a754487`) already vendored 0.2.42 and removed the switch override. Written 2026-09-22 against `origin/main` **after #246 (PR #304) merges** — cut the branch only then, so one sweep covers #246's code too. Cite by construct, never by line. Panel-only: `ops/admin/public/index.html`, `ops/admin/public/admin.css`, `ops/admin/server.test.ts`, `CONTEXT.md`, `ops/README.md` if it names a class. Nothing under `src/`, nothing in `server.ts`, no theme rebuild (0.2.42 is in). Plan file: append this as "Part B" to `docs/plans/epics/E236/14-theme-and-toast.md`, with its own Deviations section. **Closes #300**; the orchestrator closes std-lib #209, #210 and #211 after the merge.

### What the code says (read from source, not guessed)

- `rb-theme.css` (0.2.42, both arcane themes) now defines `.rb-field__help` (`--rb-text-soft`, `--rb-text-sm`), `.rb-field__error` (ink with a 3px `--rb-danger` left bar), `.rb-label__required` (`--rb-danger` glyph), `.rb-input[aria-invalid="true"]` / `.rb-textarea[…]` / `.rb-select[…]` (`border-color: var(--rb-danger)`), and the `.rb-toast-region` / `.rb-toast` / `--info|--success|--warning|--danger` / `[data-rb-enter]` / `__close` family. The std-lib's `Toast` sets the role in React (info/success `status`, warning/danger `alert`); the region is not itself a live region; the entrance from-state `data-rb-enter` is cleared one frame after mount; under `prefers-reduced-motion` the transition collapses to 0 s.
- `admin.css` today: `.field-hint` (faint small text, the panel's help/note class), `.field-hint--danger, .plugin-incompat` (the severity-bar notice — the very rule #210 gave back), `.msg` / `.plugin-actions-msg` (inline outcome lines beside a button — stay), `.adm [aria-invalid="true"] { border-color: var(--rb-danger) }` and `.tag-field:has([aria-invalid="true"])`, `.route__channels[aria-invalid="true"]` (composites: keep). `server.test.ts` pins `.adm [aria-invalid="true"]` and `.tag-field:has(…)` in the "admin.css" describe, `['notice.className = "field-hint field-hint--danger";', 1]` in `expected fragments`, and `.adm-apply__text .field-hint`.
- `index.html` uses `field-hint` in three static places (`#logs-meta`, `#servers-status`, `#apply-hint`) and ~36 builders. They fall into three kinds: **help for a control** (the card's setting description `desc` with `aria-describedby`; `FIELD_META[key].hint` under a config field, currently without `aria-describedby`; the secret field's "Not set yet…" note; the channel checklist's hint; the Add-a-webhook hint), **a refusal about a control** (`notice.className = "field-hint field-hint--danger"` for the stateError notice; `channelErr`), and **a note that describes no control** (empty-list lines, the outage notice, the footnote, version lines, status/outcome lines, `logs-meta`, `apply-hint`, the placement summaries and per-row notes). The required marker is `" *"` appended to label text in three places: `buildSettingField` (plain field), `buildSecretField` (its label is a `<span class="rb-label">`), `renderEnvFields`.

### Decided — not open for re-planning

1. **Three classes, one rule each, and `field-hint` disappears from the repo.** Text that describes a control → `rb-field__help`, and the control names it: `id` on the text, `aria-describedby` on the control (the card's `desc` already does this; the config-editor hint, the secret note, the channel-list hint and the webhook hint gain it). A refusal about a control → `rb-field__error` (the theme's ink-with-bar; `.field-hint--danger` is deleted from `admin.css`, `.plugin-incompat` keeps its own copy of those declarations under its own name). Everything else → a panel class **`adm-note`**, defined in `admin.css` with exactly `.field-hint`'s current declarations. The three static elements move with their kind (`#logs-meta` and `#apply-hint` → `adm-note`; `#servers-status` → `adm-note`). `.adm-apply__text .field-hint` becomes `.adm-apply__text .adm-note`. After this, `git grep -n "field-hint" -- ops/admin` prints nothing — the test literals move too.
2. **The required marker is the theme's glyph, and the control says so.** In all three places the `" *"` suffix becomes a child `<span class="rb-label__required" aria-hidden="true">*</span>` appended after the label text, and the control gains `required = true` (a `<select>` picker included; the chip composite's inner input included). The Apply bar's own validation (`validateEnvChanges`) is unchanged — the attribute is for assistive tech, not for the browser's form validation (there is no `<form>` submit).
3. **The theme owns the invalid border on plain controls.** Delete `.adm [aria-invalid="true"]` from `admin.css`; `.rb-input[aria-invalid="true"]` / `.rb-select[…]` from the theme take over. Keep `.tag-field:has([aria-invalid="true"])` and `.route__channels[aria-invalid="true"]` (composites the theme does not know). The test that pins the deleted rule now pins its absence and the theme's rule's presence in `rb-theme.css`.
4. **`showToast(kind, text)`, vanilla, in a lifted block `TOAST:begin` / `:end`.** One `<div class="rb-toast-region">` appended to `<main id="app">` on first use; each toast `<div class="rb-toast rb-toast--<kind>" role="<toastRole(kind)>">` with a `<span>` for the text and `<button type="button" class="rb-toast__close" aria-label="Dismiss">×</button>`; `data-rb-enter` set on mount and removed in `requestAnimationFrame`; `success` and `info` dismiss themselves after `TOAST_MS = 8000`, `warning` and `danger` stay until dismissed; Escape (one `keydown` listener on `document`, added with the region) dismisses the newest; text through `textContent`; at most `TOAST_MAX = 4` on screen (the oldest goes). `toastRole(kind)` is pure: `danger`/`warning` → `alert`, else `status` (the std-lib's own rule). **Where it fires**, and nowhere else: the settle points of #245's `awaitRequestResult` (applied → `success` *"<plugin>: live in <n> server(s)"* / *"<plugin>: saved, applies once it is running"*; refused → `danger` *"<plugin>: the bot refused it — <reason>"*; timeout → `warning` the 30 s sentence), #245's `refreshDiscovery` and #246's `refreshDiscoveryAll` (landed → `success` *"Read from Discord again."*; refused → `danger`; timeout → `warning`), #246's `addWebhook` / `removeWebhook` (landed → `success` *"Webhook added for #<channel>."* / *"Webhook removed."*; refused → `danger`; timeout → `warning`), and `retryRegistration`'s settle (the plugin's own toast covers it — no second one). Never for the Apply bar (sticky, already a live region) and never for the inline update-action messages (they sit beside their button). The per-step / per-card status lines stay: a toast is never the only place an outcome is reported.
5. **Nothing else moves.** No wording of an existing status line changes; no new endpoint; no `rb-alert` swaps; the drift banner stays a banner.

### Steps

1. `admin.css`: add `.adm-note { … }` (the old `.field-hint` declarations); delete `.field-hint`, `.field-hint--danger` (fold its declarations into `.plugin-incompat` alone), `.adm [aria-invalid="true"]`; rename `.adm-apply__text .field-hint`. No toast CSS (the theme has it).
2. `index.html`: the sweep of decision 1 (every `className = "field-hint…"`, the three static `class="field-hint"`), with `id` + `aria-describedby` wiring for every `rb-field__help`; decision 2 in the three label builders; the `TOAST` block and the `showToast` calls of decision 4.
3. `server.test.ts`: the `expected fragments` entries (the `notice` line becomes `rb-field__error`; add the `adm-note` static count); the admin.css describe (decision 3); the "every class the page uses is styled by admin.css or the theme" test must pass with the new classes (it reads `rb-theme.css` too); the tests below.

### Tests

| # | Test | Pins |
|---|---|---|
| 1 | `no field-hint remains in the panel (source pin)` | `index.html`, `admin.css` and this test file's fragment table contain no `field-hint` |
| 2 | `every rb-field__help is named by its control's aria-describedby (mini-harness)` | `buildSettingField` (plain), `buildSecretField` (unset), `renderEnvFields` with a `FIELD_META` hint, `buildRouteRow`'s checklist, `buildAddWebhookForm`: the help element's `id` appears in the control's `aria-describedby` |
| 3 | `a refusal about a control is rb-field__error, never rb-field__help (source pin)` | the stateError notice and `channelErr` |
| 4 | `the required marker is one aria-hidden rb-label__required span and the control carries required (mini-harness)` | the three builders; a non-required key has neither |
| 5 | `admin.css no longer styles [aria-invalid] on plain controls; the theme does` | rule absent in `admin.css`; `.rb-input[aria-invalid="true"]` present in `rb-theme.css`; the two composite rules still present |
| 6 | `toastRole: danger and warning are alert, success and info are status` | |
| 7 | `showToast: a toast mounts with its class, role, text and a close button; data-rb-enter is cleared next frame` (mini-harness with a rAF stub) | |
| 8 | `showToast: success/info auto-dismiss after TOAST_MS, warning/danger stay; the close button and Escape dismiss; the fifth toast evicts the oldest` (manual clock) | |
| 9 | `outcomes toast exactly once at their settle points (source pin)` | `showToast(` appears in `awaitRequestResult`, `refreshDiscovery`, `refreshDiscoveryAll`, `addWebhook`, `removeWebhook` slices; not in the `APPLY` block, not in `sendPluginRequest`/`buildPluginUpdateBlock` |
| 10 | `every lifted block is still present` (24: `TOAST`) | |

### Coverage table

| Acceptance bullet (#300) | Steps | Test | Mutation that must fail it |
|---|---|---|---|
| tests + typecheck green; theme stamp 0.2.42 | — | acceptance | — |
| no `adm-switch` (Part A, unchanged) | — | Part A's pin | — |
| no `field-hint`; help / error / required from the theme; no own `aria-invalid` rule | 1, 2, 3 | 1, 2, 3, 4, 5 | keep one `field-hint`; drop one `aria-describedby`; use `rb-field__help` for `channelErr`; drop `required`; restore `.adm [aria-invalid]` |
| `showToast` lifted and pinned: kind → class and role, close, per-kind timer, stacking | 2 | 6, 7, 8 | `danger` → `status`; timer removed; eviction removed |
| a routing outcome shows in the status line and as a toast; keyboard dismiss; reduced motion | 2 | 9 + manual | drop the `showToast` call in `awaitRequestResult` |
| screenshots | — | manual | — |
| std-lib #209/#210/#211 closed | — | the orchestrator, after merge | — |

### Acceptance — execute these, paste the real output

```
bun run --cwd ops/admin check
bun test ops/admin/server.test.ts --timeout 20000     # one run at a time on this box; private TEMP/TMP
git grep -n "field-hint" -- ops/admin                  # must print nothing
git grep -n "adm-switch" -- ops/admin                  # still only Part A's pin literal
```

Plus, in the #245/#246 probe harness (headless Chrome, canned data): a refused Apply on a plugin setting shows the themed error bar under the field and the theme's danger border on the control; a required setting's label shows the glyph and `document.getElementById("set-<KEY>").required === true`; a routing outcome shows both the step's status line and a toast; Tab to the toast's × then Enter dismisses it; Escape dismisses the newest; with `prefers-reduced-motion: reduce` emulated, `data-rb-enter` is still cleared and the toast simply appears; screenshots (light/dark: the field help, an error, the required glyph, a success and a danger toast) to roshne directly.

### PR

Branch `claude/theme-classes-toast` from `origin/main` after #246 has merged, isolated worktree under `R:/repos/Scratch/worktrees/`; title `feat(admin): adopt the theme's field help, errors, required marker and toasts (#300)`; body with `Closes #300`, the plan file's Part B section with a Deviations section, the pasted acceptance, the mutation table, the round list. Behaviour change (every notice's rendering, a new notice surface) — the full gate: two adversarial read-only reviewers with different lenses (A: rendering and accessibility in a real browser, both schemes — every kind of note, the error bar's contrast, the glyph, the toast's role/announcement/dismissal/eviction, reduced motion; B: claims-vs-code — the sweep really left no `field-hint`, every `rb-field__help` is wired, every settle point fires exactly one toast, the fragment counts). Mutation-test every changed line in a detached scratch worktree, one mutant at a time. At most four rounds, then stop and tell the orchestrator. **Never merge.**

## Deviations from the plan (Part B)

- **Naming, against the plan's own literal test list:** Test #2 names five sites needing
  `aria-describedby` wiring (`buildSettingField`, `buildSecretField`, `renderEnvFields`,
  `buildRouteRow`'s checklist, `buildAddWebhookForm`). Only three of the five (`buildSettingField`,
  `buildSecretField`, `renderEnvFields`) are covered by a runtime mini-harness; `buildRouteRow` and
  `buildAddWebhookForm` are covered by source-pin regex checks instead, since reaching them at runtime
  needs a full routing model/state/els triple or `serverActionState`, disproportionate plumbing for
  what is, in both cases, straight-line non-conditional wiring code — a regex confirming the help
  element's assigned `id` and the control's `aria-describedby` sit within the same few lines verifies
  the same fact a mini-harness would, for code that has no branches to actually execute differently.
  All five sites are still verified; only the mechanism differs for two of them.
- **The literal acceptance command `git grep -n "field-hint" -- ops/admin` is not fully empty**, for
  the identical reason Part A's `adm-switch` pin wasn't: this repo's own new test file necessarily
  quotes the string "field-hint" to assert its absence (its test title, its own `.not.toContain(...)`
  assertions). The actually-shipped surfaces are clean —
  `git grep -n "field-hint" -- ops/admin/public/index.html ops/admin/public/admin.css` returns nothing
  (exit 1) — pasted alongside the literal form in the PR body, not substituted for it.
- **Two self-referential `indexOf` bugs surfaced and were fixed while writing test #1's
  fragments-table check.** The test reads its own source file (`server.test.ts`) to confirm the
  expected-fragments table never reintroduces `field-hint`; the first two attempts used marker strings
  (`'describe("page skeleton"'`, `'test("the controls carry the design-system classes...'`) typed out
  as one contiguous literal, which matched the test's own source **before** the real target further
  down the file (the test's own code contains those exact search strings). Fixed by building each
  marker via string concatenation (`"describe(" + '"page skeleton"'`) so the raw source text of this
  test never contains the joined form, only the real declaration elsewhere does.
- **The CONTEXT.md `admin.css` row's own prose used to say "the `msg` / `field-hint--danger` notices
  (a severity bar, never coloured small text)"** — rewritten to name `.plugin-incompat`'s now-standalone
  copy of those declarations and the new `adm-note` class, plus a note on the deleted
  `.adm [aria-invalid="true"]` rule and which two composites still keep a local one. A second
  CONTEXT.md reference (webhook-URL-never-echoed gotcha) named `field-hint` as the element class a
  refusal message renders as; updated to `adm-note` to match the rename. `ops/README.md` was checked
  and names none of the changed classes — no edit needed there.
- **Screenshots for the PR body came from the Browser pane's inline screenshot capture, not a saved
  file** — the same limitation #209/#210/#300 Part A already hit: that tool returns an image inline
  with no file path, so `SendUserFile` had nothing to attach. Visual results (both themes: the field
  help, an error, the required glyph, an invalid border, a success and a danger toast) were inspected
  directly in-session and described from that inspection plus the matching computed-style checks, not
  inferred from source alone. Reduced motion specifically was verified by source (the theme's
  `@media (prefers-reduced-motion: reduce)` block collapses `--rb-transition` to `0s`, and
  `showToast`'s `data-rb-enter` removal is unconditional) rather than emulated live, since the Browser
  pane tool used in this environment has no `prefers-reduced-motion` emulation control.
- **Round-1 review finding, verified and fixed: a sixth `showToast` site, not named in decision 4's
  original five.** `sendRouting`'s own initiating-POST failure (its `"posted-error"` outcome — a
  non-`ok` response, an unparseable body, or a network exception; three separate exit points) never
  reached `awaitRequestResult`, so it never toasted, unlike the identical failure class in
  `addWebhook`/`removeWebhook`/`refreshDiscovery`/`refreshDiscoveryAll`, which all toast `danger` on
  their own initiating-POST failure. `retryRegistration` calls `sendRouting` directly and can hit this
  exact path, so the claim that its toast is "already covered" by `sendRouting → awaitRequestResult`
  was only true for the outcomes that actually reach `awaitRequestResult` (`applied`/`refused`/
  `timeout`), not for `posted-error`, which short-circuits before that call. Fixed: all three of
  `sendRouting`'s `posted-error` exits now call `showToast("danger", "Couldn't send it: " + …)`,
  matching the sibling functions' own wording exactly. The settle-point source-pin test gained
  `sendRouting` as a sixth checked site plus a count assertion (exactly 3 `showToast(` calls within
  it, so a mutation clearing only one of the three can't slip through — confirmed by mutation test);
  the existing `sendRouting` mini-harness test gained a direct `toasts()` assertion; a third
  mini-harness (`retryRegistration end-to-end`) needed the same `showToast` stub injected, since it
  now reaches this code path too. `CONTEXT.md`'s toast gotcha (also newly added in this round, since
  the original commit updated the lifted-block *test* count but never added the matching prose
  sentence describing what `TOAST` actually does — a genuine gap in the first pass, caught while
  reconciling this branch) names all six sites and states precisely which of `retryRegistration`'s two
  reachable paths each toast covers, rather than an unqualified "already covers it."
- **Round-2 review (the full gate, run on the combined scope after #306 was resumed as the single,
  sanctioned Part B): two adversarial reviewers, different lenses (correctness/failure-modes;
  claims-vs-code and acceptance-bullet execution).**
  - **Finding, MAJOR, confirmed and fixed (claims-vs-code lens):** the settle-point source-pin test
    (test #9) only ever checked that `showToast(` appears *somewhere* in each of
    `awaitRequestResult`/`refreshDiscovery`/`addWebhook`/`removeWebhook`/`refreshDiscoveryAll` — never
    a per-branch kind/text/count, unlike `sendRouting`, which alone got the round-1 fix's exact-count
    guard. A mutation dropping ONE of several branches, or swapping one branch's `kind`, would pass the
    whole suite unchanged at every site but `sendRouting` — the same vulnerability class the round-1
    fix's own comment names, left unpatched everywhere else. Reproduced by mutation test (dropped
    `removeWebhook`'s success call; swapped `addWebhook`'s success `kind` to `"danger"` — both slipped
    past the suite before the fix, both caught after). Fixed in two parts: (1) the settle-point test's
    presence check became an exact `showToast(` call-count check for all six functions (`sendRouting`
    3, `awaitRequestResult` 3, `refreshDiscovery` 4 — its own count was wrong in the plan's read too,
    corrected to include the network-catch branch alongside landed/timeout/posted-error — `addWebhook`
    5, `removeWebhook` 5, `refreshDiscoveryAll` 5), closing the "drop or add a call" mutation class
    uniformly; (2) a real `.toasts()` content assertion was added to every existing test that already
    exercises a settle branch cleanly (`awaitRequestResult`'s applied/refused, `refreshDiscovery`'s
    timeout/posted-error, `addWebhook`'s success/refused, `refreshDiscoveryAll`'s refused), closing the
    "swap this branch's kind or wording" class for those branches. `removeWebhook` has no behavioural
    mini-harness at all (a pre-existing, deliberately documented choice — `server.test.ts`'s own
    comment: "removeWebhook has no equivalent real-chain harness... its only coverage anywhere else is
    static"), and several branches across `refreshDiscovery`/`addWebhook`/`removeWebhook`/
    `refreshDiscoveryAll`/`awaitRequestResult`'s timeout have no existing test to hang a content
    assertion on without building a new harness from scratch — those keep only the exact-count guard.
    Declined as out of proportion for this fix: building full behavioural harnesses for every remaining
    branch is a larger, separate undertaking than closing a reviewer-evidenced mutation gap on this
    PR's own changed lines, and the count guard already closes the most severe mutation class (a
    silently dropped call) everywhere.
  - **Finding, moderate, declined in writing (correctness lens):** the routing-channel validation error
    (`channelErr`, `buildRouteRow`) is never wired via `aria-describedby` to the `<fieldset>` it
    belongs to, and carries no `role="alert"`/live-region wiring — only the static help text
    (`channelHint`) is wired in. Confirmed pre-existing (the pre-#300 `field-hint`/`field-hint--danger`
    version had the identical gap — not a regression this PR introduced) and outside #300's acceptance
    bullets, which require `channelErr`'s class name (`rb-field__error`) but never mandate
    describedby/live-region wiring for it (test #2/#3 in this doc's own Tests table only ever checked
    the class name). Declined for #306 on scope grounds, not correctness grounds: fixing it well is a
    small design decision of its own (should `channelErr`'s `id` join `channelHint`'s in
    `aria-describedby`, space-separated, and should it carry `role="alert"` or `aria-live="assertive"`)
    that belongs in its own reviewed change rather than folded into an already-multiply-rescoped PR.
    Flagged as a follow-up task (chip spawned in-session, 2026-09-22) rather than lost.
  - Everything else both reviewers checked — the toast helper's eviction/RAF/timer logic and its
    idempotent `dismissToast`, all 6 call sites' outcome-phase coverage, the `required`-attribute wiring
    through the tags-composite's `focusTarget` indirection, the `.adm [aria-invalid]` CSS deletion's
    safety, the ~37-site sweep's classification, every acceptance-bullet command re-executed for real,
    and the Part B heading reading as one coherent section — checked out clean.
- **Two findings relayed from the orchestrator, originating in `#305`'s (the now-closed, superseded
  form-states PR) own round-3 NOT SOUND review — checked against #306's actual code, not copied from
  #305's diff, since the two PRs implement the sweep differently:**
  - **Config-refusal-survives-reload: does not reproduce in #306.** #305's finding described a live
    Apply refusal's `aria-invalid` + `rb-field__error` node + `aria-describedby` token, on a Config
    field, being destroyed when a keep-edits `reloadConfig` → `renderEnvFields()` rebuild replaces the
    control. Verified by reading `refuseApply`/`applyInvalid`/`clearApplyInvalid`
    (`index.html:4355-4379`, `4261-4264`) and `renderEnvFields` (`index.html:3439-3494`) in full: #306's
    Apply-bar refusal mechanism (pre-existing, from #244/#257, untouched by #300's diff) marks a control
    with **`aria-invalid="true"` only** — it never builds a per-field `rb-field__error` node or an
    error-specific `aria-describedby` token for a Config-field refusal (confirmed: the only two
    `rb-field__error` sites in the whole file are the unrelated `stateError` notice and `channelErr`,
    neither reachable from `reloadConfig`/`renderEnvFields`/`applyInvalid`). The one thing that IS
    real and pre-existing (not introduced or regressed by #300): `renderEnvFields()`'s
    `container.innerHTML = ""` rebuild does silently drop the stale `aria-invalid` attribute (the old
    control is detached; `applyInvalid` keeps pointing at it; `clearApplyInvalid()` remains harmless —
    `removeAttribute` on a detached node — just visually inert). Untested before #300 and still
    untested now (`grep applyInvalid ops/admin/server.test.ts` → no matches), out of #300's acceptance
    bullets, and not something #306's diff touches or worsens — declined for #306 on the same
    pre-existing/out-of-scope grounds as the `channelErr` finding above, not folded into the same
    follow-up (different mechanism, different owner: this one is #244/#257's, not #300's). The
    "mutation-guard the null path" ask doesn't apply here either — there is no new capture/restore code
    in #306 to guard, since #306 never added any.
  - **`field-hint` grep re-confirmed genuinely clean, including #246's Servers-panel additions.**
    `git grep -n "field-hint" -- ops/admin/public/index.html ops/admin/public/admin.css` → no matches
    (exit 1). Spot-checked every Servers-panel notice built by `SERVERS_TAB` (`servers__meta` status
    line, per-server `server__line` rows, the webhook list's empty-state text, `attention__item`
    entries) — all `adm-note`, correctly: none describe a specific control, matching #300's own
    classification rule. No `rb-field__help`/`rb-field__error` misclassification found anywhere in the
    Servers panel.

