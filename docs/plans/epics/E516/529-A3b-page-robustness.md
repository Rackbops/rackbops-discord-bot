<!-- Plan for #529 bundle A3b (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #529): the admin page's
robustness and access -- #467 items 3-7 and #468 items 9 and 11. Written by the orchestrating session on 2026-10-17;
every `file:line` below was read at main `75d5457`. Re-find each anchor by its quoted text on the tree you cut from.
ORDER: cut A3b from `origin/main` AFTER A3a (the routing step) has merged. A3b converts the read lines inside A3a's
two pollers (`awaitRequestResult`, `refreshDiscovery`) to `readJson`, which #467 item 7 names; it changes nothing
else in `sendRouting`, `ensureRouteState`, those pollers, `renderRouteStatus` or `refreshRoutingSteps`.
Audited read-only in round 1 (a Sonnet agent; Decisions 1-7 drafted in a scratch tree and the whole test file run:
30 failures before the harness wiring, 6 after, all now named): applied: the gate message survives the burst of
401s `showApp` fires (it was erased by the second 401), with a behavioural three-401 test; the one-click Access
button is dropped (it made Lock a one-click no-op) for a note pointing to a new tab; `pickerOptions` and every other
`.channels` read are guarded (a channel-less guild still blanked both panels through the Config picker); every
harness change and every pinned test that flips is listed; `secretsReplacing` joins the `runApply` preludes (its
absence hid a throw); `forceOpenCard` lives in the APPLY block with stubs, and R4 is behavioural; R2 is behavioural
through `overridesSeen`; `ensureToastRegion` stays in the TOAST block (moving it broke three tests and a 400-char
`showApp` pin), and info toasts drop their nested role; the routing poll reads and the AdminApi reads are converted
so #467 item 7 really closes, and the acceptance grep is widened; error bodies are clipped and an HTML page named;
the reload timeout sentence is kept; the #47 failed-but-wrote apply also ends replace mode; READ_JSON sits away from
A3a's `TIMEOUT_SIGNAL` comment. Checked fine: `diffEnvEdits` cannot revive an untyped value (every Config control
renders the raw `loadedEnv` value; Discard and apply-outcome re-reads stay keepEdits=false); the refusal survives
`forceOpenCard`'s re-render; `hasAccessSession` uses a raw fetch, not `api()`.
Files: `ops/admin/public/index.html`, `ops/admin/server.test.ts`, `CONTEXT.md`, `ops/README.md` (the panel paragraphs). -->

## Implementation plan -- #529 A3b: a Servers-tab error stays on its own panel, a reload keeps Config edits too, a saved secret shows as saved, a force-opened card mounts its bundle, failed reads say what failed, the token gate explains itself, Lock leaves nothing behind, and the inputs and toasts are announced

Children: **#467** (closes: items 3-7), **#468** items 9 and 11 (with A3a's 8 and 10 and A3c's 12, #468 closes
when the last of the three merges). One PR, branch `fix/529-A3b-page-robustness`, worktree
`S:\Repos\_wt\rdb-529-A3b` cut from `origin/main`. Behaviour changes: three-reviewer gate.

### What is wrong, verified at `75d5457`

- **#467-3.** `startReload` (`ops/admin/public/index.html:542-603`) calls `renderServers()` and
  `renderNeedsAttention()` (`:577-578`) inside the same `try` as the plugin and Config renders; its `catch`
  (`:584-594`) overwrites `#plugins-list` and `#env-fields` with the error. `serverCardModel` (`:4072-`) calls
  `entry.commands.map` (`:4104`) and `guild.channels.find` (`:4105`, `:4111`, `:4126`, `:4149`) with no shape check.
  `loadRouting` (`:1861-1881`) calls the same two renders.
- **#467-4.** `startReload` passes only `typed.env` (what was typed between the two reads) to `renderEnvFields`
  (`:569`), while the cards keep everything that differs from the old baseline when `keepEdits` (`:559-561`): a Config
  edit made before an update button's or Unlock's reload is replaced by the stored value, silently. The comment at
  `:501-506` documents the asymmetry.
- **#467-5.** `secretsReplacing` (`:482`) loses a key only on "Keep the saved value" (`:2778-2781`). After a successful
  apply the card re-renders `isSet: true` but still in replace mode (`:2736`): an empty password box, no "Saved on the
  server".
- **#467-6.** `openPluginCard` (`:2565-2575`) and `refuseApply` (`:4707-4722`) unhide a closed card in place; the
  admin bundle mounts only from a render where the card was open (`buildSettingsStep(p, ctx, isOpen)`, `:2580`). The
  header's own toggle (`:2880-2889`) re-renders with capture and reapply.
- **#467-7.** `loadStatus` (`:3180-3181`), `loadRouting` (`:1863-1864`), `loadWhoami` (`:330`), `loadAdmins`
  (`:367`) and `startReload`'s `/api/plugins` and `/api/env` (`:551-552`) call `.json()` without `res.ok`: a 504's
  text body surfaces as "Unexpected token". The logs loader stores any body as the log (`:3287-3288`).
  `applyPending`'s catch (`:4804-4815`) prints a raw abort message, unlike `startReload` (`:587-588`).
- **#468-9.** Unlock (`:3137-3143`) stores whatever was typed and calls `showApp`; a wrong token's 401s re-show the
  gate (`api`, `:200-204`) with no message, and the gate has no message element (`:26-36`). Lock (`:3147-3151`) clears
  the token and sets `LOCKED_KEY`; an Access-only operator then sees "Paste the admin token" with nothing to paste
  (startup checks `LOCKED_KEY` first, `:4885`). Lock only hides `#app`: rendered env, logs, admin emails, typed secrets
  and `lastTyped` (`:622`) stay in the page, and the next Unlock's keep-edits reload re-applies them.
- **#468-11.** `buildSecretField` (`:2713-2793`) labels with a `<span>` (`:2716`); the password input is named only by
  its placeholder. `#token-input` (`:32`) and `#admin-email` (`:138`) have placeholders only. The toast region is
  created on the first toast and the toast appended at once (`:975-978`, `:985-`), so the first status toast is an
  insertion into a region that did not exist a moment before.

### Decisions (defaults, named so the gate can contest them)

1. **#467-3: secondary renders fail on their own panel.** A helper `renderOwnPanel(fn, panelId)`: `try { fn() } catch
   (e) { console.error("[admin] " + panelId + " render failed", e); const el = document.getElementById(panelId); if
   (el) el.textContent = "Couldn't draw this panel: " + (e && e.message ? e.message : String(e)) }`. `startReload` and
   `loadRouting` call `renderOwnPanel(renderServers, "servers-list")` and `renderOwnPanel(renderNeedsAttention,
   "attention-list")`. And `serverCardModel` tolerates bad data: `scope` is `"all"` unless `Array.isArray(
   entry.commands)` (then the map), and every `guild.channels.find` reads `(Array.isArray(guild.channels) ?
   guild.channels : []).find`. The same guard for `routingStepModel`'s `g.channels.map` (`:3929`) -- read-only; that
   function is A3a's neighbour but this line is not in a function A3a edits. Round 1 found more unguarded `.channels`
   reads on the same data, one of them inside `startReload`'s main try: `pickerOptions` (Grep `for (const c of
   g.channels)`, `:4328`), reached from `renderEnvFields` -> `buildPickerSelect`, so a channel-less guild still blanked
   both panels. Guard every read of a guild's `channels` with `(Array.isArray(g.channels) ? g.channels : [])`: the
   sites are `pickerOptions`, `:2326` (`guild.channels.find`), `serverCardModel`'s four (`:4105`, `:4111`, `:4126`, and
   the webhooks loop -- re-find it, it is OUTSIDE the plugins loop, so a const made inside that loop is out of scope
   there), `needsAttention`'s webhook-broken branch (`:4291`), and `routingStepModel`'s `:3929`. Grep `.channels` in
   `index.html` after the edit and confirm each remaining read is guarded. A non-array `discovery.guilds` is out of
   scope (the bot always writes an array, `src/routing/discovery.ts`). A corrupt `entry.commands` reads as `"all"`:
   only a hand edit produces one, and the bot's own loader drops it; named, not given its own UI.
2. **#467-4: a keep-edits reload keeps Config edits as it keeps card edits.** A pure `diffEnvEdits(baselineEnv,
   envControls)` in the `PLUGIN_EDITS` block (beside `diffEdits`): every key whose control value differs from
   `baselineEnv[key] ?? ""`. In `startReload`: `renderEnvFields(keepEdits ? { ...diffEnvEdits(loadedEnv, after.env),
   ...typed.env } : typed.env)`, computed BEFORE `loadedEnv = env`. A chip field's committed value is what
   `captureEnvFields` reads (uncommitted typing stays lost, as documented). The `:495-506` comment and the matching
   `CONTEXT.md` sentence are rewritten: cards and Config fields now follow the same rule.
3. **#467-5: a successful apply ends replace mode for what it saved.** In `applyPending`'s `res.ok` branch, before
   `rereadFromServer`: `for (const c of plan.changes) if (c.secret) secretsReplacing.delete(c.key)`. A failed apply
   leaves replace mode (the operator may correct and retry). A value typed into that same secret's box while the POST
   was in flight is dropped with the box (the key was just saved); named in the comment. The same loop also runs on
   a failure that DID write (the #47 path, where `failureWroteNothing(...)` is false and the edits are the stored
   values), just before that branch's `rereadFromServer`.
4. **#467-6: force-opening a card takes the toggle path.** A new `forceOpenCard(name)`, placed INSIDE the `APPLY`
   block (beside `refuseApply`, which is lifted there; outside it the `runApply` harness throws a ReferenceError).
   It keeps `openPluginCard`'s `if (!els) return` guard so an unknown card is never added to `openCards`. When the
   card is closed,
   `const captured = diffEdits(...captureCardControls()); openCards.add(name); renderPlugins();
   reapplyCardEdits(captured); refreshApplyBar();` -- exactly the header toggle's sequence -- else nothing.
   `openPluginCard` calls it then focuses `document.getElementById("plug-head-" + name)`; `refuseApply` calls it
   BEFORE it looks the control up by id (so the id resolves to the rebuilt control, which is what its comment's
   concern was), and its comment is rewritten to say so. Round 1 checked that the refusal survives: `refuseApply`
   calls `clearApplyInvalid()` first, so `forceOpenCard`'s `refreshApplyBar()` finds no `applyRefused` to reconcile,
   and `aria-invalid` / `applyInvalid` / `applyRefused` are set after the lookup. Like the header toggle, the
   re-render remounts every open card's admin bundle, so unsaved bundle-local state in another open card is lost;
   named in the comment.
5. **#467-7: one way to read JSON, one way to describe a fetch failure.** A new marked block `READ_JSON`, placed
   right after the `MUTATION_TIMEOUT_MS` constant (NOT directly above the `TIMEOUT_SIGNAL` comment A3a rewrites):
   `async function readJson(res) { if (!res.ok) { const text = (await res.text()).trim(); throw new Error(
   errorBodyText(text, res.status)); } return res.json(); }`, with `errorBodyText(text, status)` = `"HTTP " + status`
   when the text is empty, `"HTTP " + status + " (an HTML error page)"` when it starts with `<` (a Cloudflare/Access
   502/504 page is kilobytes of HTML), else the text clipped to 300 characters; and `function describeFetchError(e,
   timeoutMs) { return e && e.name === "AbortError" ? "the server did not answer within " + Math.round(timeoutMs /
   1000) + " seconds" : e && e.message ? e.message : String(e); }`. Used by `loadStatus`, `loadRouting`,
   `loadWhoami`, `loadAdmins`, `startReload`'s plugins and env GETs (env-schema keeps its own `r.ok ? r.json() :
   {}`), the AdminApi's reads (Grep `await (await api(` and `await res.json()` near `:804-818`: `getEnv`,
   `getPlugins` and the `try { j = await res.json() }` read), and -- because A3b is cut AFTER A3a merges -- the three
   routing poll reads (`awaitRequestResult`, `refreshDiscovery`, `pollForResult`), where a non-ok read still lands in
   each loop's existing transient-failure catch (no behaviour change there beyond the clearer message). `startReload`'s
   catch keeps today's whole sentence for a timeout, "Error: the server did not answer within 30 seconds. Reload the
   page to try again." (`"Error: " + describeFetchError(e, RELOAD_TIMEOUT_MS) + (e.name === "AbortError" ? ". Reload
   the page to try again." : "")`), so the `TIMED_OUT` constant pinned at `server.test.ts:8050` holds. `applyPending`'s
   catch uses `describeFetchError(e, MUTATION_TIMEOUT_MS)`, so a 110 s abort reads "the server did not answer within
   110 seconds". The logs loader throws on `!res.ok` with `errorBodyText`, so it lands in its existing `Error: `
   branch.
6. **#468-9: the gate explains itself; Lock reloads the page.**
   - Add `<p id="gate-msg" class="rb-field__error" role="alert" hidden></p>` under the token input, and a static
     `<p class="adm-sub" id="gate-locked-note" hidden>Locked in this tab. Paste the admin token, or open the panel in
     a new tab to use your Cloudflare Access session.</p>`.
   - NO one-click "continue with Access" button (round 1: it would make Lock a one-click no-op for an Access
     operator at the same keyboard, dropping the guarantee documented at `:179-184` that Lock sticks across a reload
     of this tab). The note tells an Access operator the way out that already exists -- a new tab, which Lock never
     covered (the same comment says so) -- without weakening Lock. The `:179-184` comment is unchanged in meaning;
     add one sentence pointing at the note.
   - `showGate(message)`: when `message` is non-empty, sets `#gate-msg` and unhides it; an EMPTY message leaves an
     already-shown message alone (round 1: `showApp` fires about seven calls at once, and with a wrong token every one
     401s -- a `showGate("")` from the second 401 erased the first's message before it painted). `#gate-msg` is
     cleared and hidden only by the Unlock click itself and at startup. `#gate-locked-note` is shown when
     `sessionStorage.getItem(LOCKED_KEY)` is set, hidden otherwise.
   - Unlock sets a module flag `unlockPending = true` and clears `#gate-msg`; `api()` on a 401 calls `showGate(
     unlockPending ? "That token was not accepted. Check it and try again." : "")` and does NOT clear the flag (every
     401 of the burst passes the same message); an ok response clears it, as does the next Unlock.
   - Lock: `clearToken(); sessionStorage.setItem(LOCKED_KEY, "1"); location.reload();` -- a reload drops every
     rendered value, typed secret, `lastTyped` and `routeState` with certainty, and startup already shows the gate
     when `LOCKED_KEY` is set. (Clearing each piece by hand would miss the next one added.) A Lock pressed mid-Apply
     abandons the POST client-side while the server finishes the recreate (no `beforeunload` exists); named in the
     comment and in `ops/README.md`'s Lock sentence.
7. **#468-11: named inputs, an announced first toast.** In replace mode `buildSecretField` renders its label as a
   `<label for="secret-KEY">` (the summary mode, which has no input, keeps the span). `#token-input` gets
   `aria-label="Admin token"`, `#admin-email` `aria-label="New admin's email"`. A new `ensureToastRegion()` INSIDE
   the `TOAST` block, idempotent: creates the region once, empty, with `aria-live="polite"`, and registers the Escape
   listener (both moved out of `showToast`'s first-use branch into it). `showToast` calls it first (so the three TOAST
   tests that lift only that block, `server.test.ts:6754`, `:6774`, `:6784`, keep working), and the page calls it
   eagerly once at script start, after the `app` const -- NOT at the top of `showApp` (the `loadRouting is its own
   path` pin at `:11276-11281` reads only `showApp`'s first 400 characters). Inside the polite region a `danger` or
   `warning` toast keeps `role="alert"`; `info`/`success` toasts carry no role of their own (the region announces
   them; a nested `role="status"` inside a live region can double-announce). `toastRole` returns `""` for those and
   `showToast` sets the attribute only when non-empty; update any test pinning `toastRole`'s `"status"`.

### Steps

1. `index.html`: `READ_JSON` block (Decision 5), `renderOwnPanel` (Decision 1), `diffEnvEdits` in `PLUGIN_EDITS`
   (Decision 2), `forceOpenCard` (Decision 4).
2. `startReload`, `loadRouting`, `serverCardModel`, `routingStepModel`'s channels line (Decisions 1, 2, 5).
3. `applyPending` (Decisions 3, 5), `refuseApply` and `openPluginCard` (Decision 4).
4. `loadStatus`, `loadWhoami`, `loadAdmins`, the logs loader, the AdminApi reads, and the read lines of the three
   routing pollers (Decision 5).
5. The gate markup, `showGate`, `api()`, Unlock, Lock (Decision 6).
6. `buildSecretField`, the two inputs, the toast region (Decision 7).
7. Docs: `CONTEXT.md` (Grep `keepEdits`, `secretsReplacing`, `Lock`, `toast`, `openPluginCard` in `CONTEXT.md`) and
   `ops/README.md`'s panel paragraphs (Grep `Lock` and `token` there): the new rules, each in one sentence. Any
   sentence saying a Config edit is kept "only for what was typed between the two reads" is rewritten.

### Tests (`ops/admin/server.test.ts`)

**Harness and existing-test changes first** (round 1 ran the draft: 30 failures before these, 6 after, all named
here; the existing tests are NOT a guard until their harnesses know the new names):
- The `page skeleton > every lifted block is still present` set-equality test (`:7432-7450`): add `"READ_JSON"` to
  its names.
- The `reloadConfig keepEdits (#244 ...)` harness (`:7983`): its prelude/slice gains `READ_JSON` and
  `renderOwnPanel` (put `renderOwnPanel` inside a lifted block, or inside the slice the harness already takes), and
  its `api` stub's responses gain `ok: true` (`:7943-7944`), or `readJson` rejects every reload.
- `runApply` (`:8797-8812`, both the real and non-real preludes): add `READ_JSON` to its blocks, `let
  secretsReplacing = new Set()` (it is declared outside every lifted block today; with the new loop and no prelude,
  every 200 secret apply throws inside `applyPending`'s try and the catch hides it), exposed in the return; stubs for
  `renderPlugins` (recording call order), `reapplyCardEdits`, `captureCardControls`, and `diffEdits` if the
  `PLUGIN_EDITS` block is not already lifted there.
- The `loadRouting preserves the last good snapshot` harness (`:11293`, its slice starts at `async function
  loadRouting(`): `readJson`, `renderOwnPanel`, and `ok` on its stubs.
- Tests whose pinned behaviour changes on purpose, to rewrite (not just re-run):
  - `applyPending (#257) > a timeout is shown` (`:9179-9185`): the message becomes `Couldn't apply: the server did
    not answer within 110 seconds`.
  - `the Apply bar over the real reloadConfig > #284 round 2: ...` (`:10169-10184`): a keeping reload now keeps the
    Config edits; assert they survive.
  - `a refusal across the real reloadConfig (#308) > a keep-edits reload that puts the stored value back drops the
    refusal` (`:13195-13209`): the refused value is now kept, so the refusal stands (`aria-invalid` stays, the bar
    still names the key). Round 1 rewrote it this way and it passed.
  - `applyPending with a card (#244) > a refusal on a plugin-owned key opens its CLOSED card ...` (`:9475-9498`): the
    in-place unhide becomes `forceOpenCard`'s re-render; assert `renderPlugins` ran and the card is in `openCards`.
  - `... a refusal on a card that is ALREADY open never touches cardHeaderEls` (`:9500-9517`): `forceOpenCard` does
    nothing for an open card; assert `renderPlugins` did NOT run.
  - Any test pinning `toastRole`'s `"status"` (Grep `toastRole` in the test file).
  - The `TIMED_OUT` constant (`:8050`) is NOT changed: the reload catch keeps that sentence (Decision 5).

New tests:
- **R1 (#467-3):** `serverCardModel` with `entry = {}` and with a guild lacking `channels` -> no throw, names fall
  back to ids; `pickerOptions("channel", { guilds: [{ id: "1", name: "g" }] }, "")` -> no throw (round 1 reproduced
  the TypeError); `needsAttention` with a channel-less guild in the webhook-broken branch -> no throw. And
  `renderOwnPanel` behaviourally: a `fn` that throws -> the panel element's `textContent` starts `Couldn't draw this
  panel:` and nothing propagates.
- **R2 (#467-4):** `diffEnvEdits({ A: "1", B: "" }, { A: "2", B: "", C: "x" })` -> `{ A: "2", C: "x" }`. Behavioural
  in the reload harness (it records `overridesSeen`): edit the first Config control, `reloadConfig()` (keeping) ->
  `overridesSeen[0]` has `{ K: "typed" }`; with `setRereading(true)` (a Discard re-read) the edit is dropped.
- **R3 (#467-5):** `runApply`: a 200 apply whose plan changes secret `K` with `secretsReplacing` holding `K` -> `K`
  gone; a 400 refusal (`failureWroteNothing` true) -> `K` stays; a failure that wrote (the #47 path) -> `K` gone.
- **R4 (#467-6):** `runApply`, behavioural: a refusal on a key owned by a CLOSED card -> `renderPlugins` recorded
  BEFORE the control lookup and `focus()`, the card in `openCards`, and a setting typed on another card survives
  (via the `reapplyCardEdits` stub's argument). `openPluginCard` on an unknown name adds nothing to `openCards`.
- **R5 (#467-7):** `applyBlock("READ_JSON")`: `readJson` on `{ ok: false, status: 504, text: async () => "bot-ops.sh
  timed out" }` rejects with `bot-ops.sh timed out`; an empty body -> `HTTP 504`; a body starting `<html` -> `HTTP 504
  (an HTML error page)`; a 2000-character body is clipped to 300; on ok returns the parsed body.
  `describeFetchError({ name: "AbortError" }, 110000)` -> `the server did not answer within 110 seconds`.
- **R6 (#468-9), behavioural:** slice `api()` and `showGate` (or put them in a new lifted block), stub
  `document.getElementById` with fake elements: set `unlockPending`, fire THREE concurrent 401s -> `#gate-msg` holds
  the not-accepted text and is not hidden (round 1's blocker); then an ok response clears `unlockPending`, and a
  later 401 passes no message and leaves `#gate-msg` as it was. Source pins: Lock calls `location.reload()`; no
  `gate-access` element exists; `#gate-locked-note` is shown when `LOCKED_KEY` is set.
- **R7 (#468-11):** replace-mode `buildSecretField` (the #300 harness at `:6615`) creates a `label` with `htmlFor =
  "secret-" + key`; both inputs carry their `aria-label`; the TOAST harness: `ensureToastRegion()` twice -> one
  region with `aria-live="polite"`, one Escape listener; an `info` toast has no `role`, a `danger` toast has
  `role="alert"`.

### Mutation table (detached scratch worktree; `bun test ops/admin/server.test.ts`)

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | `serverCardModel`'s `Array.isArray(entry.commands)` guard removed | R1 |
| M1b | `pickerOptions`'s channels guard removed | R1 |
| M1c | `renderOwnPanel` rethrows | R1 |
| M2 | `diffEnvEdits` ignores keys absent from the baseline | R2 |
| M2b | `startReload` back to `renderEnvFields(typed.env)` | R2 (behavioural) |
| M3 | the `secretsReplacing.delete` loop removed | R3 |
| M3b | the loop also runs on a refusal that wrote nothing | R3 (400 case) |
| M4 | `refuseApply` back to unhiding in place | R4 |
| M4b | `forceOpenCard` called after the control lookup | R4 (order) |
| M5 | `readJson` skips the `res.ok` check | R5 |
| M5b | `describeFetchError` drops the AbortError branch | R5 |
| M5c | `errorBodyText` stops clipping / stops naming HTML | R5 |
| M6 | `showGate("")` clears an already-shown message | R6 (three 401s) |
| M6b | `api()` clears `unlockPending` on a 401 | R6 (three 401s) |
| M6c | Lock back to `showGate()` | R6 (pin) |
| M7 | the secret label back to a span | R7 |
| M7b | `ensureToastRegion` not idempotent (two regions) | R7 |

### Coverage table

| Bullet | Step(s) | Test | Mutation |
|---|---|---|---|
| #467-3: a Servers/Needs-attention error stays on its own panel; bad data does not throw anywhere | 1, 2 | R1 | M1, M1b, M1c |
| #467-4: a keep-edits reload keeps Config edits | 1, 2, 7 | R2 | M2, M2b |
| #467-5: a saved secret shows as saved | 3 | R3 | M3, M3b |
| #467-6: a force-opened card mounts its bundle | 1, 3 | R4 (+ manual) | M4, M4b |
| #467-7: failed reads (pollers included) and aborts say what failed | 1, 2, 3, 4 | R5 | M5, M5b, M5c |
| #468-9: the gate says a token was refused, points an Access operator to a new tab, and Lock leaves nothing | 5, 7 | R6 (+ manual) | M6, M6b, M6c |
| #468-11: inputs are named, the first toast is announced | 6 | R7 (+ manual) | M7, M7b |

### Verification

- `bun run check` in `ops/admin/`; `bun test` (root, one unscoped run); `bun test --randomize` once.
- The mutation table, in a scratch worktree.
- Manual, not verifiable here: a bundle mounting on a force-opened card, the gate with a real Access session, a
  screen reader on the labels and the first toast. Name them in the PR.

### Acceptance (paste the output)

- R1-R7 pass lines; M1-M7 failing output.
- `git grep -n "\.json()" ops/admin/public/index.html` -> only `readJson`'s own `res.json()`, `hasAccessSession`'s
  (which checks `res.ok` first), env-schema's `r.ok ? r.json() : {}`, and any read the PR body names with its
  reason.

### PR

Title: `fix(admin): keep a panel's render error on its panel, keep Config edits across a reload, end replace mode on save, mount a force-opened card's bundle, read failures plainly, explain the token gate, and label the inputs (#467, #468)`.
End with `Closes #467. Part of #468.`

### Out of scope

- Showing an update request's outcome (needs an id minted for update requests; U4's note on #529): a feature.
- A one-click "continue with my Access session" button on the gate (round 1: it would let anyone at the keyboard undo
  Lock in one click; the gate's note points to a new tab instead). Adding it is Rod's call.
