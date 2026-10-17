<!-- Plan for #529 bundle A3a (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #529): the routing step of the
admin page -- #405, #406, and #468 items 8 and 10, plus one follow-up from #528's R3 (a refused discovery-refresh
shown as a success). Written by the orchestrating session on 2026-10-17; every `file:line` below was read at main
`75d5457`. Re-find each anchor by its quoted text on the tree you cut from.
A3 is split by area so no PR is L: A3a (this, the routing step), A3b (the page's robustness and access: #467 items
3-7, #468 items 9 and 11), A3c (the stale claims: #468 item 12, #469, #514 item 5's leftovers). A3a and A3b both edit
`ops/admin/public/index.html` and `ops/admin/server.test.ts`, in different functions; whichever merges second merges
main in first.
Files: `ops/admin/public/index.html`, `ops/admin/server.test.ts`, `CONTEXT.md` (the routing-step rows).
Audited read-only in round 1 (a Sonnet agent; Decisions 1 and 3 drafted in a scratch tree and the send describe run,
H1's merge scenario run green, two failure sequences reproduced): applied: the send guard is `mode === "missing"`,
not `!== "ready"` (a stale model has real rows; refusing it broke 11 existing tests and would refuse every edit on a
page open past the hour); "clean" also needs the selection to equal `base`, so an unsent "Chosen, no channel yet"
pick survives a re-render; every early exit after the reservation re-renders (the error exit left the controls
disabled); the held check's move and `sentServers` are named; `retryRegistration` gets its own not-ready message;
the harness gains `routeFocusId`, `getElementById`, `activeElement` and a `timeoutSignal` recorder; the round-3
test and the #300 toast-count pin are named for rewriting; H5 drives the pollers directly; the re-read budget is
10 s; the focus record survives a non-matching busy render; the poll floor's difference from `pollForResult` is
explained. Checked fine: the bot writes `ok: false` + `reason` for a refused discovery refresh; the merge rule is
right for unavailable servers, chosen channels, `postTo` and destinations. -->

## Implementation plan -- #529 A3a: a send merges the operator's own changes onto the freshest saved placement, never sends without a server list, both routing pollers are time-boxed, focus survives the busy state, and a refused discovery refresh says so

Children: **#405** (closes), **#406** (closes), **#468** items 8 and 10 (stays open for 9, 11, 12). One PR, branch
`fix/529-A3a-routing-step`, worktree `S:\Repos\_wt\rdb-529-A3a` cut from `origin/main`. Behaviour changes:
three-reviewer gate.

### What is wrong, verified at `75d5457`

- **#405.** `ensureRouteState` (`ops/admin/public/index.html:1258-1269`) seeds `st.selection` from the model once
  (`st.seeded`) and never again; only `resetToSaved` (`:1677-1685`, deletes the entry) or a reload re-seeds.
  `sendRouting` (`:1525-1596`) posts `routingSetBody(plugin, st.selection, model)` (`:1529-1530`, `:1557`), a whole
  placement the server treats as a full replacement. Nothing refreshes `routingData` on a timer (`loadRouting` runs
  from `showApp`, `:241`, and from the Servers-tab action at `:2462`), so a tab that loaded before another tab's change
  posts a placement without it: the other server is dropped, with a success toast.
- **#406.** `sendRouting` never checks `model.mode`. With `discovery` null, `routingStepModel` returns `rows: []`
  (`:3908`) and `routingSetBody` walks rows only (`:3976`), so the body is `servers: {}` -- placed nowhere. A poll can
  assign such a `routingData` (`:1609`, `:1710`) between an edit and its debounced send, and the held re-send
  (`:1591-1594`) fires without a check. Only `retryablePlacement` (`:1914-1930`) requires `ready`.
- **#468 item 8.** `awaitRequestResult`'s GET (`:1608`) and `refreshDiscovery`'s (`:1709`) carry no signal, so the
  30 s answer timeout is checked only after a poll returns. The `TIMEOUT_SIGNAL` comment (`:209-214`) says the helper
  is "shared by every /api/* call this page makes that shouldn't hang forever".
- **#468 item 10.** `renderRouteStatus` (`:1770-1792`) disables every row control while busy, including the focused
  one, and an applied outcome rebuilds the whole step (`refreshRoutingSteps`, `:1886-1893`, `replaceWith`); focus
  falls to `body`.
- **#528 follow-up (R3).** The bot now refuses a discovery-refresh that wrote nothing (R3, #598). `refreshDiscovery`
  treats ANY found result as success (`:1719-1734`: `refreshRoutingSteps(); showToast("success", "Read from Discord
  again.")`), never reading `found.ok`.

### Decisions (defaults, named so the gate can contest them)

1. **#405: a send is a three-way merge, computed fresh.** At seed time `ensureRouteState` also stores `st.base` (a
   deep copy of the seeded selection). `sendRouting`, once it has reserved the in-flight slot (Decision 3), re-reads
   `/api/routing` (with `timeoutSignal(ROUTING_REREAD_TIMEOUT_MS)`, a new constant of 10000 beside
   `ROUTING_ANSWER_TIMEOUT_MS` -- short, so a stalled connection falls back quickly instead of sitting on "Applying…"
   for 30 s; parsed from `res.text()`; on success it assigns `routingData`, as the pollers do) and builds the model
   from it. When the fresh model has rows (`mode !== "missing"`) and `st.base` exists, `st.selection = mergeSelection(st.base, st.selection, selectionFromModel(freshModel))` before
   `routingSetBody`: per server id in the union of the three, the operator's row when it differs from `base`, else the
   fresh row (absent = off). So a server another tab added survives, and the operator's own changes win where they
   made them. A failed re-read (network, non-ok, unparseable) falls back to the in-memory `routingData` -- today's
   behaviour, no worse -- and is not an error by itself (the harness's GET stub returns `""`, and every existing send
   test keeps its meaning). The window left between the re-read and the POST is milliseconds; a server-side version
   check would close it but changes the request shape the bot reads (a contract change) -- DECLINED here, named in
   the PR.
   `mergeSelection` and `sameRowSelection(a, b)` (on/off, scope, channel set ignoring order, `postTo`, destination
   map) are pure and go in the `PLUGIN_ROUTING` block beside `selectionFromModel`. An absent row and `{ on: false }`
   are the same.
2. **#405: re-seed whenever the step is clean.** `ensureRouteState` re-seeds (`selection` and `base`) from a `ready`
   model when `!st.seeded` OR the step is clean. Clean (a pure `routeStepClean(st)` in `PLUGIN_ROUTING`): no
   `sendTimer`, no `inflight`, not `held`, AND either the outcome is `applied`, or there is no outcome and
   `sameSelection(st.selection, st.base)` (every row `sameRowSelection`). The selection-equals-base half is what keeps
   an unsent pick alive with no timer and no outcome -- "tick a server, click Chosen", which `sendRouting` refuses
   through its `planned.error` exit (round 1 reproduced the wipe without it). A refused, failed or timed-out send
   keeps the operator's picks (its own buttons act on them). After an `applied` outcome the fresh model equals what
   was sent, so the re-seed is a no-op for the picks and moves `base` forward. So any later render (a reload, a
   poll's `refreshRoutingSteps`) shows the fresh placement unless an edit is pending.
3. **#406: never send without a server list.** The guard is `mode === "missing"` (no discovery at all: no rows, the
   `servers: {}` case the issue names). A `stale` model (discovery older than an hour) still has its real rows and
   sends as today: refusing it would refuse every edit on a page left open past the hour (round 1: it also broke 11
   existing tests, whose fixed `generatedAt` reads stale). In `sendRouting` the order becomes: the `held` check MOVES
   ahead of the `planned.error` exit (a busy step with an unsendable selection now returns `"held"`, and the held
   re-send then shows the error) -> reserve `st.inflight = { id: null, sentServers: [], startedAt }` (moved up,
   BEFORE the re-read, so a render during the re-read sees the step busy and Decision 2 cannot re-seed over the
   edit) and render -> the re-read and merge -> if the model's `mode === "missing"`: release the reservation (`if
   (st.inflight === reservation) st.inflight = null`), keep `st.selection`, set `st.outcome = { phase:
   "posted-error", message: "Not sent: the bot's server list isn't available right now. Your picks are kept; change
   one again or use Refresh from Discord once it is back." }`, toast `warning` with the same text, return
   `"not-ready"` -> the `planned.error` exit, which now also releases the reservation -> `reservation.sentServers =
   Object.keys(planned.body.servers)` -> the POST. EVERY early exit after the reservation calls `renderRouteStatus`
   after releasing it (round 1: the `planned.error` exit left every control disabled). The held re-send in `finally`
   goes through the same guard. `retryRegistration` gets its own branch for `"not-ready"`: its subject message is
   "The bot's server list isn't available right now — try again once it is back." (NOT the `"error"` branch's
   "needs at least one channel" text). Add `"not-ready"` to the return-value comment at `:1517-1524`.
4. **#468 item 8: both pollers time-boxed.** Each poll GET in `awaitRequestResult` and `refreshDiscovery` gets
   `timeoutSignal(pollRequestTimeoutMs(startedAt, Date.now()))`, cancelled in a `finally` around the GET.
   `pollRequestTimeoutMs` (pure, `PLUGIN_ROUTING`) = `Math.max(1000, ROUTING_ANSWER_TIMEOUT_MS - (now - startedAt))`.
   An abort lands in the existing catch as a transient failure, and the loop's own timeout check then ends the wait.
   The 1000 ms floor differs from `pollForResult` (`:2399-2421`, the Servers tab's poller, already time-boxed with
   `timeoutSignal(remaining)` and returning before a GET once `remaining <= 0`): these two pollers check the deadline
   AFTER the read, so the floor gives the last read a real chance instead of an instant abort. `pollForResult` is not
   changed. The `TIMEOUT_SIGNAL` comment is reworded to list the callers Grep `timeoutSignal(` actually finds (round
   1 found eleven: the reload, the routing send and re-read, `refreshDiscovery`, the Servers-tab actions and
   `pollForResult`, the plugin request send, the restart, the apply, and the 5 s Access probe) -- describe them by
   kind, not by line.
5. **#468 item 10: focus comes back.** A module-level `routeFocusId` (beside `routeState`, Grep `let routeState =
   new Map()`). In `renderRouteStatus`, before disabling, when `busy` and `document.activeElement` has an id starting
   `"route-" + plugin + "-"`, record it; a busy render whose active element does not match (focus already on `body`,
   or another card) leaves `routeFocusId` untouched, so one card's second render cannot erase the first's record. After the controls are re-enabled (the `!busy` path) and at the end of
   `refreshRoutingSteps`, when `routeFocusId` is set, `const el = document.getElementById(routeFocusId); if (el &&
   !el.disabled) el.focus(); routeFocusId = null`. The row controls already carry stable ids (`:1284`, `:1305`,
   `:1318`, `:1339`, `:1377`, `:1407`).
6. **#528 follow-up: a refused refresh is a refusal.** In `refreshDiscovery`, a found result with `ok === false`
   sets `now2.outcome = { phase: "posted-error", message: "The bot refused it: " + (found.reason || "no reason given")
   }`, renders, and toasts `danger` with the same text; no `refreshRoutingSteps`, no success toast. The held re-send
   still runs.

### Steps

1. `ops/admin/public/index.html`, `PLUGIN_ROUTING` block: `sameRowSelection`, `mergeSelection`, `routeStepClean`,
   `pollRequestTimeoutMs` (Decisions 1, 2, 4), each with a comment naming its issue.
2. `ensureRouteState`: `base`, and the clean re-seed (Decision 2). Rewrite its comment (`:1247-1257`): the round-3
   rule (seed only from a ready model) still holds; add the clean re-seed and why.
3. `sendRouting`: the new order, the re-read and merge, the not-ready exit (Decisions 1, 3); its return-value
   comment.
4. `awaitRequestResult` and `refreshDiscovery`: the per-poll signal (Decision 4); `refreshDiscovery`'s refusal
   (Decision 6).
5. `renderRouteStatus` / `refreshRoutingSteps`: focus (Decision 5).
6. The `TIMEOUT_SIGNAL` comment (Decision 4).
7. `CONTEXT.md`: the routing-step rows (Grep `ensureRouteState` and `sendRouting` in `CONTEXT.md`): seeded from a
   ready model and re-seeded whenever clean; a send re-reads and merges the operator's own changes onto the fresh
   placement; never sent without a ready server list; polls time-boxed; a refused discovery refresh shown as refused.
   Any sentence saying the selection is "never re-seeded" is corrected.

### Tests (`ops/admin/server.test.ts`)

Harness changes first (the describe at Grep `scheduleRoutingSend / sendRouting / awaitRequestResult (#245)`): the
`new Function` prelude gains `let routeFocusId = null;`, and the fake `document` gains `activeElement: null` and
`getElementById: () => null` (round 1: under "use strict" the bare read of `routeFocusId` threw, and
`sendRouting`'s catch turned it into a fake posted-error). The harness's `timeoutSignal` stub becomes a recorder
(`(ms) => { timeoutCalls.push(ms); return { signal: undefined, cancel: () => {} }; }`) exposed as
`timeoutCalls()`. Existing pins that change: the round-3 test (Grep `seeded an` / `st3.selection` in that describe,
at `:11737-11757` on `75d5457`) asserts a later ready model never re-seeds a CLEAN step -- rewrite its second half
to set `sendTimer` (or `held`) before the later model and assert the pick survives, and keep its seed-only-when-ready
first half; the #300 toast-count source pin (Grep `outcomes toast exactly once at their settle points`, `:6498-6500`)
rises from 3 to 4 for `sendRouting` (the not-ready warning) and from 4 to 5 for `refreshDiscovery` (the refusal) --
keep the new toasts inside the sliced spans.

Pure (in the `PLUGIN_ROUTING` describe, Grep `PLUGIN_ROUTING (#245): pure parts`, `applyBlock("PLUGIN_ROUTING")`):
- **P1 (#405):** `mergeSelection`: tab B added S2 (theirs has S1+S2), this tab's base S1, mine S1+S3 -> S1, S2, S3;
  this tab unticked S1 (mine {}) while theirs still has S1 -> S1 absent; both changed S1's channels -> mine wins;
  `sameRowSelection` treats channel order as irrelevant and an absent row as `{ on: false }`.
- **P2:** `routeStepClean`: false with each of `sendTimer`, `inflight`, `held`, each non-applied outcome phase, and
  no outcome with `selection` differing from `base`; true with no outcome and `selection` equal to `base`, and with
  `applied`.
- **P3:** `pollRequestTimeoutMs`: 30000 at start, 1000 floor past the deadline, the remainder in between.

Harness (the `scheduleRoutingSend / sendRouting / awaitRequestResult` describe at `:10887`; give its `apiImpl` a GET
answer of the fresh `routingData` where a test needs one):
- **H1 (#405, the issue's scenario):** with `fakeNow` set within the hour of the fixture's `generatedAt` (so the
  model is `ready`), seed `music` from a model placed in `100` (`ensureRouteState`, so `base` is set); the GET answers a fresh routing with `music` in `100` and `200`; the operator ticks nothing new but changes
  `100` to chosen channel `10`; after the debounce, the POST body has BOTH `100` (chosen, `["10"]`) and `200`.
- **H2 (#405, fallback):** the GET returns non-ok -> the POST is built from the in-memory `routingData`, exactly as
  today (one assertion on the body).
- **H3 (#406):** the GET answers `discovery: null` -> NO POST, `st.inflight` null, the selection unchanged, the
  outcome message starts `Not sent:`, one warning toast, and the row's `box.disabled` is false afterwards (a fake row
  el wired into `routingStepEls`). While the GET promise is still pending (a held promise the test resolves later),
  `st.inflight` is already set. A held re-send whose GET answers `discovery: null` posts nothing. A STALE model (the
  fixture's old `generatedAt`) still posts.
- **H3b (round 1's M1):** tick a server, choose "Chosen" with no channel, let the debounce fire -> `"error"`, no POST,
  `st.inflight` null, and `box.disabled` false.
- **H4 (#405, Decision 2):** `ensureRouteState` with a newer ready model re-seeds a clean step (selection equals the
  new model's) and does NOT re-seed when `sendTimer` is set, when `held`, after a `refused` outcome, or after H3b's
  error exit (the "Chosen" pick survives -- round 1's B2).
- **H5 (#468-8):** drive `awaitRequestResult` directly (not through `sendRouting`, whose re-read also calls
  `timeoutSignal`): two poll iterations record two `timeoutCalls()` entries, the first `30000` or just under; the same
  for `refreshDiscovery`'s loop (count the calls made after its initiating POST).
- **H6 (#528 follow-up):** `refreshDiscovery` whose poll finds `{ id, ok: false, reason: "nothing changed" }` -> the
  outcome message is `The bot refused it: nothing changed`, a `danger` toast, `refreshRoutingSteps` NOT called.
- **S1 (#468-10, source pins):** `renderRouteStatus` reads `document.activeElement` before it disables and calls
  `focus()` on the `!busy` path; `refreshRoutingSteps` restores `routeFocusId`. (The DOM half is browser-only.)
- Run the whole describe: the existing tests must stay green (H2 is the guard that the fallback kept their meaning).

### Mutation table (detached scratch worktree; `bun test ops/admin/server.test.ts`)

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | `mergeSelection` returns `mine` unchanged | P1, H1 |
| M1b | `sameRowSelection` compares channel arrays by order | P1 (order case) |
| M2 | `routeStepClean` ignores `held` | P2, H4 |
| M2b | the clean re-seed removed (seed once again) | H4 |
| M2c | `routeStepClean` drops the selection-equals-base half | P2, H4 (H3b's pick) |
| M3 | the `mode === "missing"` exit removed | H3 |
| M3c | the `planned.error` exit stops calling `renderRouteStatus` | H3b (`box.disabled`) |
| M3b | the reservation moved back after the re-read | H3's busy assertion during the re-read (assert `st.inflight` is set while the GET promise is pending) |
| M4 | the poll GETs lose their signal | H5 |
| M4b | `pollRequestTimeoutMs` floor removed | P3 |
| M5 | the `ok === false` branch removed from `refreshDiscovery` | H6 |
| M6 | the focus restore removed | S1 |

### Coverage table

| Bullet | Step(s) | Test | Mutation |
|---|---|---|---|
| #405: a stale tab no longer drops another operator's server | 1, 2, 3, 7 | P1, P2, H1, H2, H4 | M1, M1b, M2, M2b, M2c |
| #406: a missing server list never becomes `servers: {}`, and no exit leaves the controls frozen | 3, 7 | H3, H3b | M3, M3b, M3c |
| #468-8: both routing pollers are time-boxed, the comment true | 1, 4, 6 | P3, H5 | M4, M4b |
| #468-10: focus survives busy and a rebuild | 5 | S1 (+ manual) | M6 |
| R3 follow-up: a refused discovery refresh shows as refused | 4 | H6 | M5 |

### Verification

- `bun run check` in `ops/admin/`; `bun test` (root, one unscoped run); `bun test --randomize` once.
- The mutation table, in a scratch worktree.
- Manual, not verifiable here: the focus behaviour with a keyboard in a real browser, and two real tabs against a
  live panel (H1 drives the scenario by stub). Name both in the PR.

### Acceptance (paste the output)

- P1-P3, H1-H6 and S1 pass lines; M1-M6 failing output.
- `git grep -n "never re-seeded" ops/admin/public/index.html CONTEXT.md` -> nothing (or only a sentence that says
  what changed).

### PR

Title: `fix(admin): merge a routing send onto the fresh placement, never send without the server list, time-box the routing polls, keep focus, and show a refused discovery refresh (#405, #406, #468)`. End with `Closes #405. Closes
#406. Part of #468.`

### Out of scope

- A server-side base-version check on routing-set (Decision 1): the request shape is the bot's contract.
- Showing the global routing record and an in-progress registration on the step (an R3 follow-up idea): a feature,
  not a defect; left for a later issue.
- Minting an id for plugin UPDATE requests so the panel can show their outcome (U4's note on #529): a feature; left
  for a later issue.
