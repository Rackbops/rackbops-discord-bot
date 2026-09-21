## Implementation plan — written by the orchestrating session, to be executed as written

One PR, branch `claude/panel-apply-bar` cut from `origin/main` **now** (amended 2026-09-21: it needs none of #242's routes; the two only meet in `ops/admin/server.test.ts`, where #242 adds `describe`s next to the `/api/plugins/request` block and this child replaces the two save-path `describe`s further down -- when #242 / #240 land, merge `main`; an additive test-file merge you may resolve by keeping both, anything else is a stop-and-tell), in an isolated worktree. Commit this plan as `docs/plans/epics/E236/08a-apply-bar.md`. Everything is in `ops/admin/public/index.html`, `ops/admin/public/admin.css`, `ops/admin/server.test.ts` and docs. No server route changes.

Read first, in `index.html`: `savePlugins` (between `PLUGINS_SAVE` markers), `saveEnv` (`ENV_SAVE`), `planPluginsSave`, `planEnvSave`, `validateEnvChanges`, `buildTagControl`; and in `server.test.ts` the two `describe`s that lift them — `admin panel saveEnv posts only the changed keys (issue #44)` and `admin panel plugin Save (#102)`. The idiom there (lift the marked source, evaluate it with every page global injected, run it against a stub page) is the idiom for every test here.

### Decided — not open for re-planning

- **`planPluginsSave`, `planEnvSave` and `validateEnvChanges` do not change.** They stay lifted and pinned exactly as they are. The bar *composes* them.
- **`savePlugins` and `saveEnv` are deleted**, with their markers, their buttons (`#save-plugins`, `#save-env`), their message lines (`#plugins-msg`, `#env-msg`) and their `confirm()` calls. One function, `applyPending`, is the only thing that posts config. Every guarantee their tests pinned is re-pinned on `applyPending` — the table below carries each across by name.
- **No `confirm()` on apply.** The bar states the consequence ("the bot goes offline for about 20 seconds") next to the button; a second dialog saying the same thing is noise. (`confirm()` stays where it is for Restart, the update actions and removing an admin.)
- **The raw `PLUGINS` field leaves the Config editor** (`loadEnv` skips that key). Plugins are chosen on the Plugins tab; two controls for one key is a conflict with no good answer. `ops/README.md` says a `name@version` pin is set in `.env`.
- **The bar lives outside the tab panels**, last child of `<main id="app">`, `position: sticky; bottom: 0`, so it is visible from any tab.
- **Pending state is derived from the DOM on every change, never stored.** The same way `saveEnv` reads the controls at click time — so *Discard* is "re-render from the baseline" and there is no second copy of the truth to drift.
- **No progress theatre.** `bot-ops.sh env-set` returns only after the recreate, so the bar says *Restarting the bot…* for exactly as long as the request is in flight, and nothing is polled afterwards.
- The collector reads `#env-fields [data-key]` and `#plugins-list input[type=checkbox][data-plugin]` — the two selectors the old functions used. It must **not** widen to a page-wide `[data-key]`: a plugin's own settings bundle renders arbitrary DOM inside this page. (#244 adds its own, equally scoped, selector.)

### Step 1 — markup and CSS

In `index.html`: delete the two `.row.adm-actions` blocks holding `#save-plugins` / `#save-env` and the two `.msg` lines under them; reword the Plugins card's sub-text (it still says "recreates the bot to apply it" per tick). Add, as the last child of `<main id="app">`:

```html
<div id="apply-bar" class="adm-apply" hidden>
  <div class="adm-apply__text" role="status">
    <strong id="apply-title"></strong>
    <span id="apply-hint" class="field-hint"></span>
  </div>
  <div class="adm-apply__actions">
    <button id="apply-ok" type="button" class="rb-btn rb-btn--ghost" hidden>OK</button>
    <button id="apply-discard" type="button" class="rb-btn rb-btn--ghost">Discard</button>
    <button id="apply-go" type="button" class="rb-btn rb-btn--primary">Apply and restart</button>
  </div>
</div>
```
`admin.css`: `.adm-apply` (sticky, a raised surface, a top border, row layout; stacks at phone width), tone modifiers `.adm-apply--danger` / `.adm-apply--ok`. **Tokens only** — `describe("admin.css uses tokens only")` will fail a raw colour or size.

### Step 2 — the pure parts (two new marked blocks)

```js
// APPLY_PLAN:begin
// input: { loadedEnv, fields: {KEY: value}, plugins: { checkedNames, currentValue, manifestOrder } | null }
// `plugins` is null when the bot's state could not be read -- nothing may be planned against it.
function planApply(input) -> { changes: [{key, before, now}], body, count, error? }
// APPLY_PLAN:end
```
- `PLUGINS` first (from `planPluginsSave`, only when it reports `changed`; `before` is the raw current value), then `planEnvSave`'s changes in field order, **minus any `PLUGINS` key** (the editor no longer has one; this is the belt to that brace).
- A `now` containing `\r` or `\n` → `error: "<KEY> must not contain a line break."` and an empty `body` — `bot-ops.sh` reads stdin line by line, so a line break smuggles a second assignment (the guard `buildSetEnvBody` already has for plugin bundles).
- `body` is `KEY=value` lines joined by `\n`.

```js
// APPLY_VIEW:begin
// state: { count, phase: "idle"|"applying"|"done"|"failed", error?: string, detail?: string }
function applyBarView(state) -> { hidden, tone: ""|"danger"|"ok", title, hint, showDiscard, showGo, showOk, busy }
function describeApplyFailure(text, result) -> { error, detail }     // the failText logic saveEnv has today, split in two lines
// APPLY_VIEW:end
```
| state | title | hint | buttons |
|---|---|---|---|
| idle, count 0 | — (`hidden`) | | |
| idle, count n | `1 change needs a restart` / `n changes need a restart` | `The bot goes offline for about 20 seconds while it restarts.` | Discard, Apply and restart |
| idle, count n, `error` set (validation) | same title | the error, tone `danger` | Discard, Apply and restart |
| applying | `Restarting the bot…` | `This takes about 20 seconds.` | both shown, `busy` |
| done | `Applied. The bot restarted with your changes.` | — , tone `ok` | OK |
| failed | `Couldn't apply: <error>` | `<detail>` (the backup path), tone `danger` | OK; plus Discard + Apply when count > 0 |

### Step 3 — the DOM parts (one marked block, `APPLY`)

- `collectPending()` → builds `planApply`'s input from the two selectors; `plugins` is `null` when `!pluginsData || pluginsData.stateError`.
- `refreshApplyBar()` → `collectPending` → `planApply` → `applyBarView` → writes the bar. Called from one delegated `input` and one `change` listener on `#app`, and at the end of `loadEnv()` and `loadPlugins()` (the baseline moved). A user `input`/`change` clears a `done` or `failed` phase back to `idle`.
- `applyPending()`:
  1. plan; `count === 0` → return. `plan.error` → show it, return.
  2. `validateEnvChanges(loadedSchema, plan.changes)` → on a violation: show its message, set `aria-invalid="true"` on the control (`[data-key="…"]`, or its `dataset.focusId` target for a tag field), `showTab` to the panel that holds it, focus it; **send nothing**.
  3. phase `applying`; `api("/api/env", { method: "POST", body: plan.body, signal })` with `timeoutSignal(MUTATION_TIMEOUT_MS)`.
  4. ok → phase `done`; `loadPlugins(); loadEnv(); loadStatus();`. Not ok → `describeApplyFailure` → phase `failed`; `loadPlugins(); loadEnv();` (`.env` may already have been rewritten — #47).
  5. `unauthorized` is swallowed as today; any other throw → phase `failed` with its message; `cancel()` in `finally`.
- `discardPending()` → phase `idle`; `loadPlugins(); loadEnv();` — nothing is posted.
- `loadPlugins()`: drop the `#save-plugins` lines; when `data.stateError`, render every plugin checkbox `disabled` (the notice already explains why).
- `loadEnv()`: skip the `PLUGINS` key.
- `buildTagControl`: its `sync()` sets a hidden input's value from code, which fires no event, so the bar would never notice a chip change. Lift it:
  ```js
  // TAG_SYNC:begin
  function syncTagValue(hidden, tokens) { hidden.value = tokens.join(","); hidden.dispatchEvent(new Event("input", { bubbles: true })); }
  // TAG_SYNC:end
  ```
- Buttons wired with `withBusy`.

### Step 4 — tests (`ops/admin/server.test.ts`)

Delete the two old `describe`s' **save-function** tests and replace them; keep every `planPluginsSave` / `planEnvSave` / `validateEnvChanges` test untouched. One harness, `runApply(page)`, in the shape of `runSaveEnv`: stub `document` (`getElementById` for the bar's five elements and any `[data-key]` control; `querySelectorAll` for exactly the two selectors, throwing on any other so a widened selector fails loudly), injected `api`, `loadEnv`, `loadPlugins`, `loadStatus`, `showTab`, `loadedEnv`, `loadedSchema`, `pluginsData`, `MUTATION_TIMEOUT_MS`, `timeoutSignal`.

`describe("planApply (#257)")` — `PLUGINS comes first, then the changed fields in field order` · `an unchanged page plans nothing` · `a formatting-only PLUGINS difference plans nothing` · `an existing name@version pin survives` · `with plugins null, a ticked box plans nothing` · `a PLUGINS field among the env fields is ignored` · `a line break in a value is an error and the body is empty`.

`describe("applyBarView (#257)")` — one test per row of the table · `the count is singular for one`.

`describe("applyPending (#257)")` —
`ticking one plugin and editing two fields is ONE POST: PLUGINS first, only those three keys` (the acceptance bullet) · `an untouched field is never posted, even when its stored value would fail its format` (#44 — reuse that test's exact setup) · `nothing changed: nothing is posted` · `a blank required field blocks the whole apply, names the key, marks the control invalid, shows its tab, and posts nothing` (#45) · `a bad format blocks the whole apply the same way` · `with no schema the apply still goes` · `the POST carries an AbortSignal` (#53) · `success re-loads plugins, env and status, and the bar says applied` · `a failed recreate shows the compose error and the backup path, and re-baselines` (#47) · `a plain-text failure is shown verbatim` · `a timeout is shown` · `unauthorized is swallowed` · `an unreadable bot state cannot produce a PLUGINS change` · `no confirm is asked` (inject a `confirm` that throws).

`describe("discardPending (#257)")` — `posts nothing and re-renders plugins and env`.

`describe("syncTagValue (#257)")` — `writes the joined value and dispatches a bubbling input event`.

`describe("page skeleton")` (add) — `the apply bar is the last child of #app, outside every tabpanel` · `neither save button nor its message line remains` · `the Config editor does not render a PLUGINS field` (lifted `loadEnv` is too DOM-heavy — pin the `if (key === "PLUGINS") continue;` line in source, the file's idiom for wiring).

### Step 5 — docs and screenshots

`ops/README.md`: the panel section (one bar; version pins live in `.env`). `CONTEXT.md`: the `index.html` row's marker list (three new, two gone), and a gotcha — *pending changes are derived from the controls on every event, never stored; anything that changes a control's value from code must dispatch an `input` event or the bar will not see it*. Screenshots, from a locally served panel against canned data: the bar pending, in flight, applied and failed — light and dark, desktop and 375 px — into `R:/repos/Scratch/e236-257-shots/`; attach the four that matter to the PR.

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| one plugin + two fields → one POST, PLUGINS first, only those keys | 2, 3 | `ticking one plugin and editing two fields is ONE POST…` | post PLUGINS and the fields separately; post every field |
| nothing changed → hidden, nothing sent | 2, 3 | `an unchanged page plans nothing`; `nothing changed: nothing is posted`; the idle/0 view row | drop the `count === 0` return |
| a blank required field blocks the whole apply | 3 | `a blank required field blocks the whole apply…` | validate after the POST; validate only the first change |
| Discard restores every control | 3 | `posts nothing and re-renders plugins and env` | skip `loadEnv()` in discard |
| failed recreate: compose error + backup, re-baselined | 2, 3 | `a failed recreate shows the compose error and the backup path…` | show the raw JSON; skip the reload on failure |
| no save buttons, no confirm on apply | 1, 3 | `neither save button nor its message line remains`; `no confirm is asked` | leave `confirm(` in `applyPending` |
| an unreadable state cannot be planned against | 2, 3 | `with plugins null, a ticked box plans nothing`; `an unreadable bot state cannot produce a PLUGINS change` | pass the plugins plan through regardless |
| a chip change reaches the bar | 3 | `writes the joined value and dispatches a bubbling input event` | drop the `dispatchEvent` |
| a line break cannot smuggle a key | 2 | `a line break in a value is an error and the body is empty` | drop the check |
| a plugin bundle's DOM cannot feed the bar | 3 | the harness throws on any selector but the two | widen to `#app [data-key]` |
| keyboard and announcement | 1 | manual — tab order ends at the bar; `role="status"` on the text; paste what you observed | — |
| it looks right in both themes and at phone width | 1 | manual — the screenshots | — |

### Verification — paste the real output in the PR

```
bun run check
bun run --cwd ops/admin check
bun test
git grep -n "save-plugins\|save-env\|savePlugins\|saveEnv" -- ops/admin/public/index.html      # must print nothing
```

Mutation checks in a scratch worktree, one at a time, `bun test ops/admin/server.test.ts`.

**Run every `bun test` with a private temp dir**, e.g. `TEMP=R:/repos/Scratch/tmp/bot-257 TMP=R:/repos/Scratch/tmp/bot-257 bun test` (create it first) — `test/setup.ts` sweeps every `rackbops-bot-test-data-*` directory in the system temp dir at start-up (#252), and another subordinate is testing in this repo at the same time.
