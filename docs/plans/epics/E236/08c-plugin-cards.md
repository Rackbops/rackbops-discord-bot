<!-- Plan for Rackbops/rackbops-discord-bot#244 (Epic #236). Copy of the approved plan comment, https://github.com/Rackbops/rackbops-discord-bot/issues/244#issuecomment-5756486560, and the plan patch, https://github.com/Rackbops/rackbops-discord-bot/issues/244#issuecomment-5768827781, as of when they were approved, with the implementer's "Deviations from the plan" appended at the end. -->

## Implementation plan — written by the orchestrating session, to be executed as written

One PR, branch `claude/panel-plugin-cards` cut from `origin/main` **after #256 (settings for a plugin that is off), #242 (PR #268) and #272 (edits kept after a refusal) have merged** — #257 is in — in an isolated worktree. Commit this plan as `docs/plans/epics/E236/08c-plugin-cards.md`. Files: `ops/admin/server.ts` (one merge function), `ops/admin/public/index.html`, `ops/admin/public/admin.css`, `ops/admin/server.test.ts`, docs.

*(Cites are by construct, not by line. Re-verified on 2026-09-21 against `main` + #242: the page has 19 markers and every function, variable, element id, class and token named below exists under that name; `PluginIndexEntry.env` is still `{ key; secret? }[]`; `BADGE_MODIFIERS` has no `danger` entry yet; a plugin's bundle is mounted by `mountPluginAdmin` into `#plugin-admin-list`, OUTSIDE `#plugins-list`; the test harness is `runApply`, whose stub throws `harness: the collector may read only its two selectors` on any other selector.)*

The design is the approved mock (the appendix at the end carries its CSS and the card's markup, since the mock itself is private to roshne). Its promise: **one card per plugin — turn it on, fill in its settings, Apply once.** Step 2 of the mock, *Choose where it lives*, is the next child (#245); build the steps so a step can be inserted between the two.

### Decided — not open for re-planning

- **Nothing on a card saves on its own.** The switch, the settings and the secrets are controls the Apply bar (#257) reads. The only things on a card that act immediately are the ones that already do: the update / schedule / remind / skip / cancel buttons, and a plugin's own settings bundle (its `AdminApi.setEnv` is unchanged).
- **Pending edits survive a re-render.** The update buttons re-load the plugin list when they succeed; that must not throw away a setting someone typed in another card. Edits are captured from the controls before a re-render and put back after it. Only three things drop them: *Discard*, an Apply attempt that ends in a re-render (a success, or a failure that may have written), and a full page load. **#272's rule is kept exactly:** after a refusal that provably wrote nothing (`failureWroteNothing(res.status, result)`), nothing is re-rendered and every control — a typed secret included — still holds what the user entered, so the retry sends it again.
- **One consistent snapshot.** Cards need `/api/plugins`, `/api/env` and `/api/env-schema` together, so one function, `reloadConfig()`, fetches all three, stores them, then renders the cards **and** the Config editor, then refreshes the bar. `loadPlugins` and `loadEnv` become aliases of it (one in-flight fetch is shared), so every existing call site — including the pinned `sendPluginRequest` — keeps working unedited.
- **A secret is secret if either side says so**: the index's `secret: true`, or the schema's `secret: true`. Its value is never put in the DOM by this page, never in `localStorage`, never in a message. It lives in one `<input type="password">` from typing until an Apply attempt ends in a re-render, or Discard.
- **A secret cannot be blanked from the panel** in this version — an empty secret field means "leave it alone".
- **A key lives on exactly one card**: the first plugin in index order that declares it. A later plugin declaring the same key shows *"Set on the `<first>` card."* A key the script reports as `source: "core"` never appears on a card (*"Set under Settings."*), and a key owned by a plugin never appears in the Config editor.
- **Labels are derived, not authored**, for now: `settingLabel(key, pluginName)`. The index's `description` is the hint under the field; the raw key is shown small, in mono, under that. (A `label` field in the Plugin Index is a later, additive improvement — out of scope.)
- **Several cards may be open at once**, and which ones are open is remembered across re-renders (in memory only).
- A plugin's own settings bundle mounts **inside its card**, the first time the card is opened, through the unchanged `makeAdminApi` bridge. `ADMIN_API_VERSION` does not move. The *Plugin Settings* section is deleted.
- Accordion semantics: the card header is a `<button aria-expanded aria-controls>` inside an `<h3>`; the body is a `role="region"` labelled by it. The switch is `<input type="checkbox" role="switch">` with a real `<label>`.

### Step 1 — the view gains what a card needs (`server.ts`, `mergePluginsView`)

`PluginIndexEntry.env` widens to `{ key: string; description?: string; required?: boolean; secret?: boolean }[]`. `PluginView` gains:
```ts
/** #244: the plugin's declared settings, in manifest order — what the card's settings step draws. */
env: { key: string; description: string; required: boolean; secret: boolean }[];
/** #244: the plugin's command names, for the closed card's summary line. */
commands: string[];
```
Both built defensively from untrusted manifest JSON, the way `envKeys` already is: an element without a string `key` is skipped; `description` is a string or `""`; `required` / `secret` are `=== true`; `commands` keeps strings only. `envKeys` stays (the bridge uses it).

### Step 2 — pure parts (`index.html`, each between its own markers)

```js
// PLUGIN_SETTING_LABEL:begin
function settingLabel(key, pluginName)      // "MUSIC_CALLBACK_PORT","music" -> "Callback port"; "SPOTIFY_CLIENT_ID","music" -> "Spotify client ID"
function settingOwners(plugins)             // Map: key -> the first plugin (index order) that declares it
// PLUGIN_SETTING_LABEL:end
```
`settingLabel`: drop a leading `<PLUGIN>_` (the plugin's name upper-cased, `-` → `_`) when something is left; split on `_`; lower-case; capitalise the first word; keep `API ID URI URL DMF TTL IP` upper-case wherever they fall.

```js
// PLUGIN_CARD_STATE:begin      (replaces PLUGIN_BADGES; pluginUpdateBadge moves in unchanged)
// ctx: { indexAvailable, pendingOn: true|false|undefined, pendingSettings: number, labelOf: (key) => string }
function pluginCardState(p, ctx) -> { badge: { text, kind }, summary }
// PLUGIN_CARD_STATE:end
```
First match wins:

| # | when | badge (`kind`) | summary |
|---|---|---|---|
| 1 | `pendingOn === true` | Restart to apply (`warn`) | Turned on, not running yet |
| 2 | `pendingOn === false` | Restart to apply (`warn`) | Turned off, still running until you apply |
| 3 | `pendingSettings > 0` | Restart to apply (`warn`) | `1 setting changed` / `n settings changed` |
| 4 | `indexAvailable && !p.inIndex` | Not in the index (`warn`) | The Plugin Index no longer lists this plugin |
| 5 | `p.error` | Error (`danger`) | Couldn't start. Open for the reason |
| 6 | `p.enabled && p.missingEnv.length` | Needs setup (`warn`) | `Missing: ` + the labels, comma-separated |
| 7 | an update is available | `Update <latest>` (`update`) | `Running · <installed> installed`, or `<installed> installed` when not active |
| 8 | `p.active` | Running (`active`) | `1 command` / `n commands` / `No commands` |
| 9 | `p.enabled` | Not running (no kind) | Turned on, but not running. The log on Overview says why |
| 10 | otherwise | Off (no kind) | Not running |

`BADGE_MODIFIERS` gains `["danger", "rb-badge--danger"]`. The open card shows `p.error`'s own text at the top of its body (an `rb-alert--danger`), since row 5 sends people there "for the reason".

```js
// APPLY_PLAN (extend #257's planApply): input gains `secrets: {KEY: value}`; each non-empty one becomes
//   { key, before: "", now, secret: true } after the plain changes. Same line-break rule.
// PLUGIN_EDITS:begin
function diffEdits(baseline, controls) -> { on: {plugin: bool}, settings: {KEY: value}, secrets: {KEY: value} }   // only what differs
function validateSecretChanges(schema, changes, labelOf) -> { key, message } | null    // message NEVER contains c.now
// PLUGIN_EDITS:end
```
`validateEnvChanges` is **not** edited (it is pinned, and it echoes the value it rejects — which is right for a plain setting and wrong for a secret). `applyPending` runs it over the non-secret changes and `validateSecretChanges` over the secret ones; the secret message is `<label> doesn't look right — check what you pasted.`

### Step 3 — DOM parts

- `reloadConfig(opts)` — `opts.keepEdits` defaults to `true`. Captures `diffEdits(...)` from the live controls when keeping; fetches the three endpoints in parallel (same degradations as today: a failed schema is `{}`; `stateError` / `indexError` notices as today); stores `pluginsData`, `loadedEnv`, `loadedSchema`; `renderPlugins()`; `renderEnvFields()`; re-applies the captured edits to the new controls (a control that no longer exists is dropped silently); `refreshApplyBar()`. `loadPlugins = loadEnv = () => reloadConfig()`.
- `applyPending` / `discardPending` call `reloadConfig({ keepEdits: false })` exactly where they call `loadPlugins(); loadEnv();` today — which, since #272, means: on success, in `discardPending`, and in the failure branch ONLY inside `if (!failureWroteNothing(res.status, result))`. Do not widen or drop that condition.
- `onControlEdited` (the delegated `input`/`change` handler) returns early for an event from inside `.plug__admin`: a plugin's bundle now lives inside `#plugins-list`, so its own inputs pass the handler's `closest("#env-fields, #plugins-list")` filter, and they must not clear the bar's message or re-plan anything.
- `collectPending` (#257) gains two scoped selectors and nothing wider: `#plugins-list [data-setting-key]` (plain settings) and `#plugins-list [data-secret-key]` (secrets, non-empty only). A plugin bundle's DOM sits in `.plug__admin` and may contain anything — so both selectors are additionally filtered with `!el.closest(".plug__admin")`.
- `renderPlugins()` → one `buildPluginCard(p, ctx)` per plugin, replacing `buildPluginRow`:
  - header button: name, description, summary, badge, chevron; toggles the body and records the name in `openCards`.
  - **Turn it on** — the switch (`data-plugin`, `id="plugin-<name>"`, disabled under the same rule as today: not in the index and not enabled; and disabled when `stateError`), its *On* / *Off* text, the hint *"Off keeps everything it has stored. Nothing is deleted."*, the version line, and `buildPluginUpdateBlock(p)` exactly as it is.
  - **Fill in its settings** — for each `p.env` entry, by this order of rules: core key → *Set under Settings*; owned by another card → *Set on the `<first>` card*; no schema row → *"This can't be edited right now — the bot hasn't published this setting yet."*; secret → the secret control; otherwise an `rb-input` holding `loadedEnv[key] ?? ""`. Each field: `<label>` from `settingLabel` (+ ` *` when the schema says required), the control, the description as a `field-hint` wired with `aria-describedby`, the key as `.adm-key`. No `p.env` and no index → *"Settings can't be shown while the Plugin Index is unavailable."*; no `p.env` with an index → the step is omitted.
  - the secret control: `isSet` → `•••••••• Saved on the server` + **Replace**, which swaps in the password field and focuses it, with **Keep the saved value** to swap back (and clear what was typed). Not set → the password field (`type="password"`, `autocomplete="new-password"`, `placeholder="Paste the value"`) and *"Not set yet. Once saved it can be replaced, never shown."*
  - the bundle: `adminTabState(p, panelVer)` decides as today; `mount` happens on first open into a `.plug__admin` root; the gen counter and cleanup list keep working across `reloadConfig`. Open cards re-mount after a re-render.
  - steps are numbered by position among the steps present, so #245 can insert one.
- `refreshApplyBar()` also re-computes every card's header from `pluginCardState` (rows 1–3 depend on what is pending).
- `renderEnvFields()` = today's `loadEnv` body minus the fetch, skipping `PLUGINS` (#257) and every key that `loadedSchema[key]?.source === "plugin"` **or** any plugin's `env` declares.
- Delete `#plugin-admin-section`, `renderPluginAdmin`, `buildPluginRow`, and the `.plugin-row` / `.plugin-admin-tab` CSS they used.

### Step 4 — tests (`ops/admin/server.test.ts`)

- `describe("mergePluginsView surfaces #244 card fields")` — `env carries key, description, required, secret in manifest order` · `a malformed env element is skipped, a missing description is ""` · `required and secret are true only for a literal true` · `commands keeps strings only` · `envKeys is unchanged`.
- `describe("settingLabel / settingOwners (#244)")` — the examples above, one assertion each, plus `a key that IS the prefix is left whole` · `an acronym in the middle stays upper-case` · `the first plugin in order owns a shared key`.
- `describe("pluginCardState (#244)")` — one test per table row, plus `pending outranks an error` · `an index outage never says "not in the index"` · `missing settings are named by label` · `the count is singular for one`.
- `describe("planApply with secrets (#244)")` — `a typed secret is one change marked secret, after the plain ones` · `an empty secret field is no change` · `a line break in a secret is an error`.
- `describe("validateSecretChanges (#244)")` — `a secret that fails its format is reported by label, and the message does not contain the value` · `a secret with no schema row is not checked`.
- `describe("diffEdits (#244)")` — `only controls that differ from the baseline are captured` · `a secret is captured only when non-empty`.
- `describe("applyPending with a card (#244)")`, on #257's `runApply` harness, whose selector allow-list grows from two to four (say so in its error text): `turning on a plugin that was off and filling two settings, one secret, is ONE POST: PLUGINS, then the two keys` (the acceptance bullet) · `a secret that fails validation posts nothing and its value is in no message` · `after a success, or a failure that may have written, the page is re-rendered without keeping edits` · `after a refusal that wrote nothing (#272) nothing is re-rendered and the typed secret is still in its field` · `a control inside .plug__admin is never collected` · `an input event from inside a plugin's own settings bundle does not touch the bar`.
- `describe("a secret's value stays in one password field (#244)")` — source-level pins, the file's idiom for what cannot be lifted: `localStorage.setItem appears once, for the token` · `no value is written for a [data-secret-key] control` (the builder never assigns `.value` to it) · `the secret field is type=password with autocomplete=new-password`.
- `describe("page skeleton")` (add) — `the Plugin Settings section is gone` · `a card header is a button with aria-expanded inside a heading`.
- `BADGE_MODIFIERS` test: `danger maps to rb-badge--danger`.
- Every `PLUGIN_BADGES` test moves to `pluginCardState`; say in the PR which old assertion maps to which row.

### Step 5 — docs and screenshots

`CONTEXT.md`: the `index.html` row's marker list; gotchas — *edits are captured and re-applied around every re-render; only Discard and a finished Apply drop them* · *a key lives on the first card that declares it* · *a secret's value exists only in its password field until the Apply attempt ends*. `ops/README.md`: the Plugins tab. Screenshots against canned data, each of the ten card states closed, one card open with both kinds of secret field, light and dark, desktop and 375 px → `R:/repos/Scratch/e236-244-shots/`; attach the six that matter to the PR.

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| each card state from the matching data | 2 | the ten `pluginCardState` row tests | swap two rows' order; drop the `indexAvailable` guard |
| turn on + two settings (one secret) → one POST | 2, 3 | `turning on a plugin that was off…is ONE POST` | leave secrets out of the body; post them separately |
| Discard restores every control | 3 | #257's discard test + `after a success, or a failure that may have written…` | default `keepEdits` to true in discard |
| #272's kept edits survive the cards | 3 | `after a refusal that wrote nothing (#272)…` | call `reloadConfig` unconditionally in the failure branch |
| a bundle's own inputs never move the bar | 3 | `an input event from inside a plugin's own settings bundle…` | drop the `.plug__admin` early return in `onControlEdited` |
| a secret's value is nowhere but its field and that POST | 2, 3 | `validateSecretChanges…does not contain the value`; the three source pins; `a secret that fails validation posts nothing…` | route secrets through `validateEnvChanges`; assign `.value` on the secret input; add a `localStorage.setItem` |
| the bundle mounts in its card, through the same bridge | 3 | `a control inside .plug__admin is never collected`; the existing `adminTabState` / `bundleMountDecision` tests, unedited | drop the `.closest(".plug__admin")` filter |
| no plugin key in Config, no core key on a card | 2, 3 | `the first plugin in order owns a shared key`; source pin on the `renderEnvFields` skip | remove the `source === "plugin"` skip |
| pending edits survive an update button's re-load | 3 | `only controls that differ from the baseline are captured` + a `reloadConfig` run on the stub page: `an edit in one card survives a re-load triggered from another` | call `reloadConfig({keepEdits:false})` from the alias |
| keyboard and focus | 3 | manual — open a card, flip the switch, edit, reach Apply; paste what you observed | — |
| it looks right | — | manual — the screenshots | — |

### Verification — paste the real output in the PR

```
bun run check
bun run --cwd ops/admin check
bun test ops/admin/server.test.ts --timeout 20000
git grep -n "plugin-admin-section\|buildPluginRow\|renderPluginAdmin" -- ops/admin/public/index.html      # must print nothing
```

The full `bun test` is CI's. Mutation checks in a detached scratch worktree, one mutant at a time. **Process guards (standing):** every command foreground with an explicit timeout; ONE `server.test.ts` run at a time, never parallel copies; a private temp dir per run (`TEMP`/`TMP` under `R:/repos/Scratch/tmp/bot-244`, create it first — `test/setup.ts` sweeps the shared one, #252); reviewers run nothing in the background, get a 45-minute budget and are stopped when their verdict is in; before reporting idle, list your processes by age and `taskkill /T /F` any leftover. Do not merge.

The "no schema row" message in Step 3 is also what a card shows during the gap #256's plan describes: the panel lists a plugin from its own fetch of the index up to ~15 minutes before the bot's cache — which `bot-ops.sh` reads — knows that plugin's keys.

<details><summary>Appendix — the mock's card markup and CSS (port into <code>admin.css</code>; colours, fonts and radii are tokens already; use the existing <code>.field-hint</code> where the mock says <code>.adm-hint</code>)</summary>

```html
<section class="rb-card plug">
  <h3 class="plug__h"><button class="plug__head" type="button" aria-expanded="true" aria-controls="plug-body-music" id="plug-head-music">
    <span class="plug__id"><span class="plug__name">music</span><span class="plug__desc">Setlists turned into Spotify playlists, and listening parties.</span></span>
    <span class="plug__meta"><span class="plug__summary">3 commands</span><span class="rb-badge rb-badge--success">Running</span>
      <svg class="plug__chev plug__chev--open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></span>
  </button></h3>
  <div class="plug__body" id="plug-body-music" role="region" aria-labelledby="plug-head-music">
    <div class="step">
      <div><h4 class="step__title"><span class="step__num">1</span>Turn it on</h4><p class="field-hint">Off keeps everything it has stored. Nothing is deleted.</p></div>
      <div><label class="rb-choice"><input type="checkbox" role="switch" class="rb-switch adm-switch" data-plugin="music" id="plugin-music"><span>On</span></label><p class="field-hint">Version 1.3.0 · up to date</p></div>
    </div>
    <div class="step">
      <div><h4 class="step__title"><span class="step__num">2</span>Fill in its settings</h4><p class="field-hint">Secrets can be replaced but never shown again.</p></div>
      <div class="fields">
        <div class="rb-field"><label class="rb-label" for="set-MUSIC_CALLBACK_PORT">Callback port</label><input class="rb-input" id="set-MUSIC_CALLBACK_PORT" data-setting-key="MUSIC_CALLBACK_PORT"><span class="field-hint">…the index's description…</span><span class="adm-key">MUSIC_CALLBACK_PORT</span></div>
        <div class="rb-field"><span class="rb-label">Spotify client secret</span><div class="secret"><span class="secret__dots" aria-hidden="true">••••••••</span><span>Saved on the server</span><button class="rb-btn rb-btn--sm rb-btn--ghost" type="button">Replace</button></div><span class="adm-key">SPOTIFY_CLIENT_SECRET</span></div>
      </div>
    </div>
  </div>
</section>
```

```css
.adm-key { font-family: var(--rb-font-mono); font-size: 11px; color: var(--rb-text-faint); }
.plug { padding: 0; overflow: hidden; }
.plug__h { margin: 0; }
.plug__head { all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: var(--rb-space-4); padding: var(--rb-space-4) var(--rb-space-5); cursor: pointer; }
.plug__head:hover { background: var(--rb-surface-2); }
.plug__head:focus-visible { outline: var(--rb-focus-ring); outline-offset: -2px; }
.plug__id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.plug__name { font-family: var(--rb-font-display); font-weight: var(--rb-font-weight-medium); font-size: 16px; letter-spacing: var(--rb-heading-tracking); }
.plug__desc { color: var(--rb-text-soft); font-size: 13px; }
.plug__meta { margin-left: auto; display: flex; align-items: center; gap: var(--rb-space-3); color: var(--rb-text-faint); font-size: 13px; white-space: nowrap; }
.plug__chev { width: 16px; height: 16px; flex: none; color: var(--rb-text-faint); transition: transform var(--rb-transition) var(--rb-ease); }
.plug__chev--open { transform: rotate(180deg); }
.plug__body { border-top: 1px solid var(--rb-border); display: flex; flex-direction: column; }
.step { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: var(--rb-space-5); padding: var(--rb-space-5); border-bottom: 1px solid var(--rb-border); }
.step:last-child { border-bottom: none; }
.step__title { display: flex; align-items: center; gap: var(--rb-space-2); font-family: var(--rb-font-display); font-weight: var(--rb-font-weight-medium); font-size: 14px; margin: 0 0 var(--rb-space-1); }
.step__num { display: inline-grid; place-items: center; width: 22px; height: 22px; flex: none; border-radius: var(--rb-radius-pill); background: var(--rb-accent-wash); color: var(--rb-accent); font-family: var(--rb-font-mono); font-size: 12px; }
.fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--rb-space-4) var(--rb-space-5); }
.secret { display: flex; align-items: center; gap: var(--rb-space-3); padding: 5px var(--rb-space-2) 5px var(--rb-space-3); background: var(--rb-surface-sunken); border: 1px solid var(--rb-border); border-radius: var(--rb-radius); font-size: var(--rb-text-sm); }
.secret__dots { font-family: var(--rb-font-mono); color: var(--rb-text-faint); letter-spacing: 0.2em; }
.rb-switch.adm-switch { appearance: none; -webkit-appearance: none; width: 36px; height: 20px; flex: none; margin: 0; border-radius: var(--rb-radius-pill); background: var(--rb-surface-sunken); border: 1px solid var(--rb-border-strong); position: relative; cursor: pointer; transition: background var(--rb-transition) var(--rb-ease), border-color var(--rb-transition) var(--rb-ease); }
.rb-switch.adm-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--rb-text-soft); transition: transform var(--rb-transition) var(--rb-ease), background var(--rb-transition) var(--rb-ease); }
.rb-switch.adm-switch:checked { background: var(--rb-accent); border-color: var(--rb-accent); }
.rb-switch.adm-switch:checked::after { transform: translateX(16px); background: var(--rb-accent-fg); }
.rb-switch.adm-switch:focus-visible { outline: var(--rb-focus-ring); outline-offset: 2px; }
/* phone width: the step's two columns stack, the fields go single-column, the header's meta wraps under the name */
@media (max-width: 640px) { .step { grid-template-columns: minmax(0, 1fr); } .fields { grid-template-columns: minmax(0, 1fr); } .plug__head { flex-wrap: wrap; } .plug__meta { margin-left: 0; white-space: normal; } }
```
Any token above that `rb-theme.css` does not define is a stop-and-tell, not a literal to invent.
</details>


## Plan patch (2026-09-21)

## Plan patch — written by the orchestrating session, 2026-09-21; applies ON TOP of the plan above

Read against `claude/apply-bar-rereading` @ `3e467e2` (#275, its PR not yet open) and `origin/main` @ `e1194e4`. Every construct the plan names was re-verified on `main` today (`plugin-admin-section`, `plugin-admin-list`, `renderPluginAdmin`, `mountPluginAdmin`, `buildPluginRow`, `pluginUpdateBadge`, `buildPluginUpdateBlock`, `adminTabState`, `bundleMountDecision`, `makeAdminApi`, `validateEnvChanges`, `planApply`, `failureWroteNothing`, `collectPending`, `refreshApplyBar`, `onControlEdited` with its `closest("#env-fields, #plugins-list")` filter, the `PLUGIN_BADGES` markers, `BADGE_MODIFIERS` without `danger`, `PluginIndexEntry.env?: { key; secret? }[]` and `PluginView.envKeys` in `server.ts`, the 19-marker skeleton pin, the `runApply` harness with its two-selector collector). **Cut from `origin/main` only after #275 has merged**, and re-verify the #275 cites below against that merged head before executing; if the helper's shape differs from what is described here, stop and tell the orchestrator.

1. **The bar's re-read is #275's `rereadFromServer()`. The plan's Step 3 sentence about `applyPending` / `discardPending` is replaced.** Do NOT edit `applyPending`, `discardPending` or `rereadFromServer`: they already `await rereadFromServer()` exactly where the plan expected `reloadConfig({ keepEdits: false })` — on success, in the failure branch inside `if (!failureWroteNothing(res.status, result, text))` (byte-identical, #272), and in `discardPending`. The helper calls `Promise.allSettled([loadPlugins, loadEnv].map(async (load) => load()))`, and with the plan's aliases (`loadPlugins = loadEnv = () => reloadConfig()`, one shared in-flight fetch) that is one fetch of the three endpoints, inside the `applyRereading` window, with the bar busy — which is what the plan wanted. `reloadConfig(opts = {})` derives its default: `const keepEdits = opts.keepEdits ?? !applyRereading;` — a re-read the bar started drops the edits; every other reload (an update button's `loadPlugins()` in `sendPluginRequest`'s success path, Unlock's `loadEnv(); loadPlugins();` in `showApp`) keeps them. Say this in `reloadConfig`'s comment, and say in `rereadFromServer`'s existing comment that it is now also the one place edits are dropped.
2. **`showApp` and `sendPluginRequest` keep their un-flagged calls.** #275's follow-up (the one about those two call sites) proposed routing them through `rereadFromServer()`; not here: that helper drops edits and locks the bar, which is wrong for an update button pressed while a setting is being typed in another card. Through the aliases they now go through `reloadConfig`, which captures and re-applies edits, so the loss that follow-up describes no longer happens; the bar staying interactive during them is safe because `reloadConfig` replaces the controls synchronously once its fetches have landed. The orchestrator says so on that follow-up when this merges.
3. **`applyBarView` grew `rereading` and `ariaBusy` in #275.** The plan's "`refreshApplyBar()` also re-computes every card's header" stands unchanged; `writeApplyBar` already passes `rereading: applyRereading` — leave it. The plan's `APPLY_PLAN` extension (secrets) and `validateSecretChanges` are unaffected.
4. **Off plugins (#225, whether or not it has merged when you cut).** A state entry with `enabled: false` may exist (transiently today; always once #225 lands: an off plugin keeps its `installedVersion` and bookkeeping). In `buildPluginCard`: the *Turn it on* step shows the version line and `buildPluginUpdateBlock(p)` **only when `p.enabled`**; `pluginCardState` row 7 (an update is available) requires `p.enabled`; row 10's summary becomes `<installed> installed` when `p.installedVersion` is known, else `Not running`. New test in `describe("pluginCardState (#244)")`: `an off plugin shows its installed version and never an update` (mutation: drop the `p.enabled` guard from row 7), and in the card tests: `an off plugin's card offers no update actions` (mutation: drop the guard around `buildPluginUpdateBlock`).
5. **Harness.** `runApply`'s stub loaders are what `rereadFromServer` calls, so model `reloadConfig` as the one loader the aliases point at; its `reloadHold` / `loadersRefresh` / `reloadFails` options apply to it unchanged. Replace the plan's single `an edit in one card survives a re-load triggered from another` with ONE test, two runs, same edit: `an edit typed in a card survives an update button's reload, and is dropped by a Discard` — the update-button run keeps it, the Discard run drops it. That pins the `keepEdits` default from both sides: defaulting to `true` regardless of `applyRereading` fails the Discard half; defaulting to `false` fails the update-button half.
6. **Coverage table, two rows added:** *edits survive a background reload and are dropped by the bar's re-read* → Step 3 → the test in 5 → the two mutations in 5; *an off plugin is shown, never updated* → Steps 2, 3 → the two tests in 4 → their mutations. The row *Discard restores every control* keeps its mutation, now phrased `make keepEdits default to true even while applyRereading`.
7. **Plan file:** `docs/plans/epics/E236/08c-plugin-cards.md` (reserved for this child) = the plan comment above + this patch, with a "Deviations from the plan" section in the shape `06-one-apply.md` carries.
8. Everything else in the plan stands as written: the ten card states, the secret rules, the key-ownership rule, the accordion markup, the deletion of the Plugin Settings section, the tests by name, the screenshots, the verification commands and the process guards.


## Deviations from the plan

(none yet)
