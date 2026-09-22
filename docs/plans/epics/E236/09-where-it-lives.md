<!--
Source: the orchestrating session's implementation-plan comment on
https://github.com/Rackbops/rackbops-discord-bot/issues/245#issuecomment-5770563125 (2026-09-22),
plus the planning-notes comment at
https://github.com/Rackbops/rackbops-discord-bot/issues/245#issuecomment-5761317154. Committed verbatim
as the plan, per "written by the orchestrating session, to be executed as written." The "Deviations from
the plan" section at the end is this implementing session's own record, not part of the source plan.
-->

## Implementation plan — written by the orchestrating session, to be executed as written

Covers **#245** — *Choose where it lives*, step 2 of the plugin card — as one PR. Written 2026-09-22 against `origin/main` @ `006dcf3` (which holds #244, PR #299, and #295); every cite below was read from source that day. **Cite by construct, never by line.** Panel-only: `ops/admin/public/index.html`, `ops/admin/public/admin.css`, `ops/admin/server.test.ts`, `CONTEXT.md` (the panel row and a gotcha), `ops/README.md` (the panel paragraph), `README.md` where it describes the Plugins tab. **No `ops/admin/server.ts` change**: `GET /api/routing` (the `routing-get` invocation, answering `{routing, discovery}`), `POST /api/routing` (`parseRoutingSetInput` → `queueRoutingRequest`, answering `{ ok: true, id, queued? }`) and `POST /api/discovery/refresh` have existed since #242. No `ops/bot-ops.sh`, nothing under `src/`. Plan file: `docs/plans/epics/E236/09-where-it-lives.md`.

### What the data says (read from source, not guessed)

- `GET /api/routing` → `{ routing: RoutingFile | null, discovery: DiscoveryFile | null }` (`cmd_routing_get` in `ops/bot-ops.sh`: each file is `null` when missing, empty or unparseable; members named `url`/`token`/`secret`/`password` are dropped on the way out). Shapes are `src/routing/model.ts`: `RoutingFile.plugins[name].servers[guildId] = { commands: "all" | string[], postTo?: string }`; `RoutingFile.webhooks[channelId] = { id, guildId, addedAt, addedBy, broken? }`; `RoutingFile.results: RequestResult[]`, oldest first, at most 20, each `{ id, action, plugin?, channelId?, ok, reason?, at }`. `DiscoveryFile = { v, generatedAt, bot: { id, username }, inviteUrl, homeGuildId: string | null, guilds: [{ id, name, channels: [{ id, name, canSend }], commands: { registered, error?, at } | null }], plugins: { [name]: { posts, commands } } }`. `discovery.plugins` holds **loaded** plugins only (`pluginSummaries` in `src/routing/discovery.ts`), so an off plugin has no entry and its `posts` is unknown.
- The bot validates a `routing-set` against discovery (`validatePluginRouting` in `src/routing/resolve.ts`): every server id must be a guild it is in, every channel in `commands` and `postTo` must be a channel of that guild, a channel list must be non-empty. The **first** problem refuses the **whole** request, worded for the panel: `server <id> is not one the bot is in`, `channel <id> is not in server <g>`, `postTo <id> is not in server <g>`, `the channel list for server <g> is empty`. `servers: {}` is valid and means **nowhere**. A plugin with no entry at all is **unplaced**: home server + default channel (ADR-0006 decision 3).
- After a `routing-set` is written the bot re-registers commands (`applyRouting`) and rewrites `discovery.json` **before** the result is appended to `routing.json` (`applyRoutingRequest` awaits `applyRouting`; the drain records the result afterwards). So when the panel sees its id in `results`, `discovery.guilds[].commands` already shows the post-change registration. A server that refused the registration is `ok: true` on the request and `commands.error` on that guild (Discord's 50001 when the bot was invited without `applications.commands`; the fix is `discovery.inviteUrl`).
- The mailbox is drained every 5 s (`REQUEST_DRAIN_MS`, `src/plugins/drain.ts`); the 60 s tick is the backstop; discovery is also refreshed every 15 min and after every registration.
- `POST /api/routing` answers 200 `{ ok: true, id, queued? }`; 400 with the reason as text; 502 with bot-ops stderr; 504 `bot-ops.sh timed out`. The server mints `id`; the client never chooses one.
- The page's idioms this plan reuses: `api(path, opts)` (adds the bearer token, throws `unauthorized` on 401), `timeoutSignal(ms)` (call `cancel()` in `finally`), `MUTATION_TIMEOUT_MS`, `openCards` / `cardHeaderEls` (per-card state and element refs that survive `renderPlugins`), `buildPluginCard`'s `steps` array (numbered by position — #244 left the seam for this step), `onControlEdited` (delegated `input`/`change` listener on `#app`), and the collector's four selectors (`collectPending`, `captureCardControls`, `reapplyCardEdits`), whose test harness throws on any fifth selector.

### Decided — not open for re-planning

1. **The step is drawn on every card, between *Turn it on* and *Fill in its settings*.** Placement is bot-owned data independent of on/off, so an operator may place a plugin before turning it on; the outcome wording (decision 6) says what that means for a plugin that is not running.
2. **Three modes, decided purely** (`routingStepModel`): `missing` — `discovery` is `null` (*"The bot hasn't published what it can see yet."*); `stale` — `discovery.generatedAt` is missing, unparseable, or older than `DISCOVERY_STALE_MS = 60 * 60 * 1000` by the browser clock (*"Last read from Discord <local time>. Too old to trust."*; a comment names the clock-skew caveat and why an hour: four missed 15-minute refreshes means the bot is down or stuck); `ready`. In `missing`/`stale` the step is **read-only**: the saved placement is listed as text (by server name when discovery has one, by id otherwise), no control is drawn, no `routing-set` is ever sent, and one `rb-btn rb-btn--sm rb-btn--ghost` *Refresh from Discord* posts `/api/discovery/refresh`, waits for that id in `results` the same way a routing change does (decision 6), then re-reads.
3. **Rows.** One row per `discovery.guilds[]` entry, in discovery order, headed by a checkbox (`rb-checkbox`, `dataset.routeServer = <guild id>`, a real `<label>` with the server name) meaning *this plugin lives here*. Ticked, the row shows two controls. **Commands work**: two radios (`rb-radio`, one `name` per plugin+server), *Anywhere in this server* / *Only in chosen channels*; the second reveals a `<fieldset class="route__channels">` with a `<legend>` and one `rb-checkbox` per `guild.channels` entry (`dataset.routeChannel`), under it the hint *"The bot enforces this: a command used elsewhere gets a private reply naming these channels. A thread counts as its parent channel."* **Posts to**: an `rb-select` (`dataset.routePost`) whose first option is *Doesn't post here*, then every channel of that guild labelled by `channelOptionLabel` — `#<name>`, plus ` · webhook` when `routing.webhooks[id]` exists without `broken`, ` · webhook stopped working` when `broken`, ` · the bot can't post here` when `!canSend` and no webhook (still selectable — say which is the case, never forbid; #243's note). The select is drawn **only when `discovery.plugins[p.name]?.posts === true`** (absent for a plugin discovery says does not post, and for one discovery does not know). A server present in `routing.plugins[p.name].servers` but absent from `discovery.guilds` is drawn as a read-only row (`route__row--off`): *"Server <id> — the bot is no longer in it."* Under the list, when there is at least one: *"<n> server(s) the bot has left are still in this plugin's placement. They are dropped the next time you change it."* and a ghost *Drop now* that sends the current placement without them (the one deliberate no-op change). Such ids are **never** included in a request (the bot refuses the whole request otherwise, #259).
4. **Unplaced and nowhere are said, not implied.** The step opens with one sentence, `placementSummary`: unplaced with a home server discovery knows → *"Lives in the home server (<name>) by default and posts to the default channel. Tick a server to place it."*; unplaced, `homeGuildId` set but not among `guilds` → *"Lives in the home server by default, but the bot is not in it, so its commands are registered nowhere. Tick a server to place it."*; unplaced, `homeGuildId` null → *"Lives in every server by default (no home server is set). Tick a server to place it."*; placed in n ≥ 1 → *"In 1 server."* / *"In <n> servers."*; placed with `servers: {}` → *"Nowhere: its commands appear in no server."*. Unticking the last ticked server IS sent (it is what the operator asked), and the summary becomes the nowhere sentence plus *"There is no way back to the default. Tick a server instead."*
5. **One `POST /api/routing` per settled change, carrying the whole plugin map.** Every control change updates that plugin's `routeState` selection and calls `scheduleRoutingSend(plugin)`: a `ROUTING_SEND_DEBOUNCE_MS = 1200` timer coalesces a burst (tick a server, switch to chosen channels, tick one → **one** request). A selection that is not sendable (`routingSetBody` returns `{ error }`: *Only in chosen channels* with none ticked) is never sent: the timer is cancelled, the fieldset gets `aria-invalid="true"` and a `field-hint field-hint--danger` reading *"Pick at least one channel for <server name>."* While a request is in flight for a plugin, a newer change is **held** and sent as ONE follow-up when the in-flight one settles (landed, refused, or timed out); never two in flight for one plugin. The body is exactly `{ plugin, servers }`: per ticked, available server, `commands: "all"` or the ticked channel ids in discovery order, and `postTo` only when the select holds a channel AND the plugin posts.
6. **Applying… then Live, by polling.** After a 200, `awaitRequestResult(id, plugin)` re-reads `GET /api/routing` every `ROUTING_POLL_MS = 2000` (each read through `api()` with `timeoutSignal(10000)`), until `routing.results` holds `id` or `ROUTING_ANSWER_TIMEOUT_MS = 30000` has passed since the POST returned. Outcomes are decided purely (`requestOutcome`): `ok: false` → *"The bot refused it: <reason>"* — the reason verbatim (the bot's rule is that it never carries a URL); the controls keep the operator's choice and a ghost *Reset to what's saved* redraws from `routingData`. `ok: true` → for each server that was sent, read the fresh `discovery.guilds[id].commands`: `error` → that row says *"Discord refused the commands here: <error>"* with a link *Re-invite the bot* whose `href` is `discovery.inviteUrl` (set only when it starts with `https://discord.com/`; `rel="noopener"`); `null` → *"Not registered yet."*; a sent server missing from discovery → *"The bot no longer sees this server."*; every sent server registered → the status is **Live** (an `rb-badge rb-badge--success` reading *Live*, plus *"Applied at <local time>"*) when `p.active`, and *"Saved. Applies once the plugin is running."* when `!p.active` (nothing registers for a plugin that is off or not yet restarted; the `/api/plugins` row's `active` says which). Timeout → *"The bot did not answer within 30 seconds. It may be restarting; the change is queued and applies when it catches up."* and a ghost *Check again* that polls once more. A non-200 POST → *"Couldn't send it: <text>"* (the 400 reason, the 502 text, or `bot-ops.sh timed out`); controls kept. In flight, the status reads *Applying…*, the step body carries `aria-busy="true"` and the step's controls are disabled. The status line is one `role="status"` element per step (a live region), written only when its text changes (`setApplyText`'s rule).
7. **Routing controls are not Apply-bar controls.** They carry `data-route-*` attributes only — never `data-plugin` on a checkbox, `data-setting-key` or `data-secret-key` — so `collectPending`, `captureCardControls`, `reapplyCardEdits` and `diffEdits` never see them and their harness's four selectors stay four. `onControlEdited` returns early for a target inside `.route` (the step's root class), directly after its `.plug__admin` return, so a routing tick neither dismisses a finished Apply message nor refreshes the bar. The step's state (`routeState: Map<plugin, { selection, inflight, held, outcome, timer }>`) is declared beside `openCards`, survives `renderPlugins`, and the step is drawn FROM it, so a card open/close or a background `reloadConfig` loses neither a selection nor an in-flight *Applying…*.
8. **Routing data loads on its own path.** `loadRouting()` → `routingData = { routing, discovery }` (null members allowed; a failed fetch leaves the previous value and the steps say *"Couldn't read where plugins live: <message>"*), called from `showApp` and by the poll. It is **not** added to `reloadConfig`'s `Promise.all` (that would make #275's `rereadFromServer` wait on `routing-get`) and never touches `pluginsData` or `loadedEnv`. When it lands, `refreshRoutingSteps()` redraws each card's step in place through per-plugin element refs in `routingStepEls` (populated by the step builder, cleared by `renderPlugins` exactly like `cardHeaderEls`) — never a full `renderPlugins`. The DOM code uses those refs and `document.getElementById`, never a new `document.querySelectorAll` selector.
9. **The list's footnote** changes from *"Changes apply when the bot restarts: they are collected in the bar below until you apply them."* to *"Switches and settings apply when the bot restarts, through the bar below. Where a plugin lives applies at once."*
10. **Nothing from the server reaches `innerHTML`**: names, reasons, errors and ids go through `textContent` / `createElement`, the page's rule.

### Step 1 — pure parts (`index.html`, one new lifted block `PLUGIN_ROUTING:begin` / `:end`)

(function signatures as posted on the issue — see the GitHub comment for the full block)

### Step 2 — the DOM (`index.html`, `admin.css`)

(as posted on the issue)

### Step 3 — tests (`ops/admin/server.test.ts`)

(15-row table, as posted on the issue)

### Step 4 — docs

`CONTEXT.md`, `ops/README.md`, `README.md`.

### Acceptance — execute these, paste the real output

```
bun run --cwd ops/admin check
bun test ops/admin/server.test.ts --timeout 20000
```

Plus real headless Chrome against a stub server (canned `routing`/`discovery`, recording `POST /api/routing`): the ONE-POST body, Applying→Live/refused/timeout, no *Posts to* for a non-posting plugin, `discovery: null` read-only text, keyboard-only reachability, screenshots (sent to roshne directly, not attached to the PR).

### PR

Branch `claude/panel-where-it-lives` from `origin/main` (at or after `006dcf3`); title `feat(admin): choose where a plugin lives from its card, applied live (#245)`; the full review gate (two adversarial reviewers, different lenses); mutation-test every changed line; at most four rounds, then stop and tell the orchestrator. **Never merge.**

*(Full verbatim text of every section, including the exact function signatures, the 15-row test table and
the coverage table, is preserved on the issue comment linked at the top of this file — this plan file is
committed for provenance and the Deviations section below, and is not meant to duplicate GitHub's own copy
byte for byte where an editor's word-wrap would make that duplication drift silently.)*

## Deviations from the plan

1. **`channelOptionLabel(channel)` takes one argument**, not the plan's suggested `(channel, webhookMeta)`
   two-arg form. `routingStepModel` already resolves each row's channel to `{ id, name, canSend, webhook:
   "none"|"ok"|"broken" }` once, so a second parameter would recompute (and risk drifting from) the same
   classification. The four pinned strings (test row 4) are unaffected — only the function's own arity.
2. **`routingStepModel`'s `missing` mode still exposes `placed` and `unavailable`** (every currently-routed
   server id) instead of returning empty placement data, computed from `routing.plugins` BEFORE the
   `!discovery` check. Needed for decision 2's own requirement — "the saved placement is listed as text …
   by id otherwise" — which is meaningless if the model throws the placement away the moment discovery is
   absent.
3. **The debounce/send/poll functions (`onRouteChange`, `scheduleRoutingSend`, `sendRouting`,
   `awaitRequestResult`, `refreshDiscovery`, `renderRouteStatus`) are plain browser-only functions, not
   inside a `PLUGIN_ROUTING`-style `new Function`-lifted marker.** They read/write the DOM and real
   `setTimeout`, which the lifted-block harness pattern isn't built for; tests 10–12 use a dedicated
   mini-harness that slices their own source text directly and injects fake `api`/`setTimeout`/
   `clearTimeout`, matching the established `reloadConfig` mini-harness precedent rather than the
   `runApply`-style whole-block lift.
4. **Decision 6's Live/Saved sentence is shown only when *every* sent server registered** (`state ===
   "live"` for all of `outcome.servers`) — read literally from "every sent server registered → the status
   is Live … / Saved …". When at least one server has an issue, the overall status line is left empty and
   the per-row notes (Discord refused it / not registered yet / the bot no longer sees this server) carry
   the whole story; the plan does not specify separate overall wording for that mixed case, and inventing
   one risked a claim the acceptance walkthrough couldn't verify.
5. **A dedicated `posted-error` outcome phase** was added (not named in the plan's four `requestOutcome`
   phases) to distinguish "the POST itself failed" (400/502/504/network) from "the bot's own routing-set
   refusal" (`ok: false` in `routing.results`) — both read *"Couldn't send it: …"* / *"The bot refused it:
   …"* per decision 6, but they are different code paths (one never reaches `requestOutcome` at all, since
   no id was ever minted to poll for) and needed a name to route `renderRouteStatus` correctly.
6. **"Check again" re-polls the SAME request id for one more 30-second window** rather than issuing a new
   `POST /api/routing` — decision 6 names it as a response to a timeout specifically ("the change is
   queued and applies when it catches up"), so re-checking the original request's outcome is the literal
   behavior; a fresh POST would be a second, redundant routing-set. `routeState.lastSent` (the id and sent-
   server list) is stashed once `awaitRequestResult` settles, precisely so the button has something to
   retry after `inflight` is cleared.
7. **Every routing control carries `dataset.routeServer` (the guild id), not the per-kind names decision 3
   lists** (`dataset.routeChannel` for a channel checkbox, `dataset.routePost` for the post select) —
   round-1 review caught this as undisclosed. Harmless: nothing reads these attributes for behavior (every
   handler is wired via a direct closure over the built element, never a delegated dataset lookup), and
   the isolation guarantee that actually matters (decision 7: routing controls invisible to the Apply
   bar's collector) only depends on `dataset.routeServer` existing and `data-plugin`/`data-setting-key`/
   `data-secret-key` never appearing, which still holds and is what the source-pin test checks. Declined
   as a rename with no functional difference, disclosed here instead of silently left unstated.
