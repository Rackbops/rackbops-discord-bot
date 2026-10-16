<!-- Plan for #527 bundle U4 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #527): the plugin request mailbox,
`src/plugins/requests.ts` and its boot-drain call in `src/index.ts` -- #419, #417, #480 (items 4-8) and #481 (items 9
and 10). Written by the orchestrating session on 2026-10-16 against main `ea4fdda`; every `file:line` below was read at
that sha. U2 (Sub #1, in flight) changes one line of this file (`requests.ts:512` passes `r.version` to `remindLater`)
and flips `requests.test.ts:505`; U4 is cut AFTER U2 merges. U3 edits `updates.ts` only, so U3 and U4 can run on two
subs at once. D1a (#526) edits `CONTEXT.md:156` (the `index.ts` row) too: cut U4 after D1a has merged as well, or expect
a one-row conflict there (an escalation item per the personal CLAUDE.md) and re-anchor. Audited read-only before it was
committed (a Sonnet agent, 163 tool calls, with the steps applied to a scratch copy and Q1-Q7/M1-M17 plus extra mutants
run); every finding was applied: recording results for update actions would have written a webhook URL or 60 KB of
hostile text into `routing.json` (the secret-bearing refusal recorded too; `action` was unbounded) AND no writer in this
repo mints an `id` for an update request (`ops/admin/server.ts:2033-2034` sends none; `bot-ops.sh plugin-request`
passes the payload through), so item 9's recording is dropped and the comment it rests on is reworded instead; the
`shown()` change broke `interactionLog.test.ts:68` (eight other callers; a JSON-quoted newline became U+FFFD), so the
control-character cleaning moves to the mailbox's log sink; `restartPending() && !handoffActive()` let the report-back
through when a restart was pending AND a handoff was active (probed), so the guard is a new `restartRequested()`; ten
`validate(...)` call sites, four `PluginRequestDeps` literals and two guard cases that stop compiling are now listed;
the Pip runbook (`ops/README.md:932-1000`) states the old rule and is updated; seven unguarded lines gained tests; the
oversize file logged twice. Round 2 (the same agent, the rewrite applied to a fresh copy: 336 pass on the touched
files, `bun test src/` 2,112 pass, every mutant run): no blocker; the post-drain warn passed two arguments to a
one-argument logger (a `tsc` error), the announce deps assertion was vacuous under test (`toBe`, not `toEqual`), two
more runbook sentences become false, and Q2/Q3 gained the snowflake range's ends and three more control characters. -->
(The sub-epic's "item 7 after #449" is acknowledged under Children.)

## Implementation plan -- #527 U4: the boot drain's restart no longer eats its own report-back, the mailbox checks who asks and bounds what it stores, a cancel in the same drain stops the restart, an unreadable mailbox is logged, and the tests assert the effects they name

Children: **#419** (closes), **#417** (closes), **#480** (closes: items 4-8; the sub-epic asked for item 7 to follow
#449, and item 7 here is a warn plus a comment on the report slot, independent of #449's busy-guard half, so it does
not wait), **#481** (closes: item 10 fixed; item 9's comment fixed and its two suggested fixes declined in writing).
One PR, branch `fix/527-U4-request-mailbox`, worktree `S:\Repos\_wt\rdb-527-U4` cut from `origin/main` after U2 (and,
for `CONTEXT.md:156`, D1a) has merged. Behaviour
changes (a refusal rule, a restart withheld, a report deferred, a file deleted) -> the **three-reviewer gate** applies;
every changed production line mutation-tested in a scratch worktree.

### What is wrong, verified at `ea4fdda`

- **#419.** `activate()` starts the scheduler at `src/index.ts:398` (`firstTick = startScheduler(...)`), whose first
  tick runs synchronously (`announce.ts:69-74`) inside `withCritical` (`:300-308`), then drains the mailbox at `:527`
  (`await consumePluginRequests(livePluginRequestDeps())`); an `update-now` there calls `requestRestart`
  (`requests.ts:350`) while the first tick's critical section is still open, so the restart is DEFERRED
  (`restart.ts:365-370`), not immediate -- the comment at `index.ts:523-525` ("exit deferred by nothing at boot →
  immediate") is wrong in that case. `activate()` then goes on to `reportPluginUpdateOutcome` (`:542-553`), which
  reads the `pendingReport` that `pinUpdateNow` just wrote, finds the entry still on the OLD `installedVersion`,
  reports "could not be updated ... still on X" (`updates.ts:489-497`), and clears the report (`:720-724`): the
  restart then happens, the update lands, and the next boot has no report left. Reproduced at the unit level in
  audit: `beginCritical(); requestRestart("x")` leaves `restartPending() === true` with no exit (the probe output goes
  in the PR; `restart.test.ts` pins the deferral itself).
- **#417.** `requests.test.ts:301` ("skip/schedule/remind/cancel apply their mutation and never restart") drives a
  `skip` file only; no test asserts a mailbox `schedule`'s `scheduled` (version, `at`, requester), a `remind`'s
  `remindAt` (the 7-day default at `requests.ts:512`, or an explicit `days`), or a `cancel`'s clearing after a drain;
  no test sends a non-string `requestedBy` (`:439` tests `typeof` and emptiness). Confirmed: swapping
  `scheduleUpdate`'s arguments, breaking the `days` default, making the cancel a no-op and deleting the `typeof`
  half all survive the suite at `ea4fdda`. (U2 adds the `remind` -> `notifiedVersion` case; the rest is here.)
- **#480 item 4.** `validate` (`:439`) accepts any non-empty string `requestedBy`; a 17-20 digit one is DMed by the
  heads-up and the report-back (`updates.ts`'s `isDiscordUserId` sites, `:248`) whether or not it is an admin; the
  comment at `:501` calls it "a panel identity" but nothing enforces that, and the Pip runbook says so in as many
  words (`ops/README.md:995`: "never consults `ADMIN_USER_IDS`"; "anyone in the host's docker group can make Pip's
  core DM any 17-20 digit user id"). **Item 5.** `requestedBy` is stored and logged as given: unbounded, control
  characters included (the routing path clips its own to `MAX_REQUESTED_BY`, 200, `src/routing/requests.ts:61`); a
  reason built from an untrusted value (`shown`, or `errorText(err)` for `apply failed — …`/`validation threw — …`,
  which `shown` never sees) reaches `reject`'s log line with its newlines intact; the file's size is uncapped at
  `readFile` (`:238`). **Item 6.** `restartReason` latches at the first applied `update-now` (`:330`) and
  `requestRestart` fires after the loop (`:350`) whatever came later: an `update-now` and a `cancel` for the same
  plugin in one drain (the test at `:321-332` has exactly that shape and asserts only the count) still restart with
  nothing to install. **Item 7.** `pendingReport` is a single slot (`pinUpdateNow` replaces it, `updates.ts:344-350`);
  two `update-now`s for different plugins in one drain keep both `targetVersion`s but only the second report-back;
  the comment at `:348-350` says they "share one restart" and nothing more. **Item 8.** `drainOnce`'s `readDir` catch
  (`:209-211`) returns silently for every error, not only "no requests dir yet": an `EACCES` or `EMFILE` makes every
  5-second beat a silent no-op while the panel says "queued".
- **#481 item 9.** Update actions record no result (`handleRoutingRequest` records one for routing actions through
  `routing.mutateRouting(withResult(...))`, `:389-408`; the update path has nothing, `:324-341`), and the comment at
  `:463-472` calls the refusal "a better answer to a double-click in the panel", which the panel never sees: a refused
  `update-now` is a log line and a file in `rejected/`. But NO writer in this repo gives an update request an `id` to
  record under: the panel's update route (`POST /api/plugins/request`, `ops/admin/server.ts:2021-2050`) sends
  `{ ...parsed.request, requestedBy }` (`:2033-2034`; `parsePluginRequestInput`, `:1275-1314`, returns no `id`; the
  `id` at `:1866-1868` is `queueRoutingRequest`'s, routing actions only), and `bot-ops.sh plugin-request` passes the
  payload through verbatim. `requests.test.ts:1687-1693` ("update actions record no result") pins today's behaviour as
  #241's decision. **Item 10.** `consumePluginRequests`'s docstring says "Never throws" (`:149`) while `drainOnce`
  rethrows a Plugin Index load failure (`:346`, pinned at `:820`); the header (`:3-4`) says routing actions "get the
  same treatment in #240" (landed); with an empty or uncached index the host-API pre-flight (`:484-489`) is skipped
  silently (`entryByName.get` finds nothing), which no comment says.

### Decisions (defaults, named so the gate can contest them)

1. **The boot report-back waits for the next boot when a restart EXIT is requested.** `restart.ts` exports
   `restartRequested()` = `pending !== undefined || shuttingDown` (beside `restartPending()`, `:299`, which also
   counts a handoff); `activate()` checks it right before `reportPluginUpdateOutcome` and, when true, logs and skips
   it: the exit re-runs this boot, whose report-back then sees the installed version. Not `restartPending()`: that is
   true during a HANDOFF of this process too (`:300`), which the first tick starts under `AUTO_UPDATE=true` when a new
   commit is out, and a handoff can fail and leave this process running for days, still owing the report. Not
   `restartPending() && !handoffActive()` either: probed in audit, a restart requested while a handoff is active
   (`requestRestart` after `beginHandoff` under `critical > 0`) makes that false and the report-back goes out -- the
   very scenario (a boot-drain `update-now` plus an AUTO_UPDATE handoff from the first tick) this item describes.
   True under a shutdown is right: the process is going away and the report survives in state. The comment at
   `:523-525` says what is true.
2. **A Discord-id `requestedBy` must be an admin:** `PluginRequestDeps` gains `adminUserIds: string[]`; `validate`
   refuses a `requestedBy` that `isDiscordUserId` (`updates.ts:248`, the same test the DM sites apply, so the gate
   cannot drift from them) accepts and `adminUserIds` does not include ("requestedBy <id> is not an admin"); every
   other non-empty string is a panel identity: the server writes `email:<addr>` or `token` (`ops/admin/server.ts:1866`,
   `:2033`), and a hand-written file says whatever the operator typed.
3. **`requestedBy` is bounded and clean, and a reason never forges a log line:** `validate` returns a copy with
   `requestedBy` stripped of control characters (`[\x00-\x1f\x7f]`) and clipped to `MAX_REQUESTED_BY` (exported from
   `src/routing/requests.ts:61` and imported, so the two paths cannot drift); a strip that leaves nothing is "missing
   requestedBy"; `reject`'s log line replaces control characters in the REASON with U+FFFD (the sink, so `shown`'s
   output and `errorText`'s alike are covered; `shown` itself is NOT changed -- it has 22 call sites across seven
   modules and `interactionLog.test.ts:68` pins that a JSON-quoted newline survives it); a request file over 65,536 UTF-16 units is
   DELETED unparsed with the reason "request file too large (N characters)" (not moved to `rejected/`: a blob that
   size is never a real request, and quarantining it keeps whatever it carries; the file is still read whole before
   the check, so the cap bounds parsing and storage, not the read; a `routing-set` of some 2,900 channel ids would
   hit it, which no real server has).
4. **The restart is decided after the drain, from the state:** once every file is handled, the drain re-reads the
   state and requests the restart only if some plugin still carries a `targetVersion`; a cancel in the same drain
   therefore cancels the restart too. A re-read that throws falls back to today's behaviour (the restart is requested;
   a warn says the state could not be re-read) -- the files are applied and gone by then, so a lost restart would
   strand the pins.
5. **The single report slot is named, not widened:** an `update-now` that replaces ANOTHER plugin's pending report
   logs a warn naming both (a second click on the same plugin is silent); the comment says the slot is single
   (`pendingReport` is in the vendored `contract.ts` and in `state.json`: widening it is a live data-path change,
   the operator's call, and a panel-origin report-back is a log line anyway).
6. **A `readDir` error other than `ENOENT` is logged once per distinct error code** (module state
   `lastReaddirFailure`, reset by `resetPluginRequestsForTest` and by a `readDir` that succeeds, read by the
   test-state guard), so an unreadable mailbox is visible without a line every five seconds.
7. **Update actions still record no result, and the comment stops pretending otherwise** (#481 item 9): with no
   writer minting an `id`, recording would be dead code, and the audit's probe of a recording path showed what it
   costs when it is not dead (a webhook URL or 60 KB of hostile `action` text in `routing.json`). The `:463-472`
   comment says the refusal is a log line and a `rejected/` file that the panel does not see; `requests.test.ts:1687`
   keeps pinning #241's decision. Recording update outcomes needs the panel to mint and surface an id for update
   requests first -- noted on #529 for the page work (A3), not done here. "Retry `apply` once before quarantining"
   is declined too: a transient `EBUSY`/`EIO` can clear, but the file lands in `rejected/` with its reason, the
   operator can re-drop it, and a retry loop in the drain is a new hazard for a case nobody has seen.
8. **Comments say what the code does** (item 10): "Never throws" becomes "rejects only when the Plugin Index load
   threw, after the routing requests were handled"; the header's #240 is past; the pre-flight's gap is named.

### Step 1 -- `src/restart.ts` and `src/index.ts`

1a. `restart.ts`, after `restartPending()` (`:299-301`):

```ts
/** True while an exit is requested (a pending restart or a shutdown) -- not during a handoff alone, which can still
 *  fail and leave this process running (#419: the boot report-back must then still go out). */
export function restartRequested(): boolean {
  return pending !== undefined || shuttingDown;
}
```

1b. `index.ts` `:523-525` comment and `:542-553`: the comment becomes "An update-now request restarts here: at once
when nothing is in flight, else deferred by the first tick's critical section (startScheduler fired the first tick
synchronously above), applying on the next boot; anything queued after is drained by the pluginRequests tick." Before
`reportPluginUpdateOutcome({` (`:542`):

```ts
  // #419: the boot drain's update-now may have requested a restart that the first tick is still deferring. The
  // report it wrote belongs to the boot AFTER that restart (the target is not installed yet); reporting it now would
  // say "still on the old version" and consume it. The exit re-runs this whole boot. restartRequested, not
  // restartPending: a handoff alone (the first tick's AUTO_UPDATE) can fail and leave this process owing the report.
  if (restartRequested()) {
    console.log("[plugins] a restart is pending — the plugin update report-back waits for the next boot");
  } else {
    reportPluginUpdateOutcome({ ... }).catch(...);  // unchanged
  }
```

(`restartRequested` joins the `./restart` import at `:27`.)

### Step 2 -- `src/plugins/requests.ts`

2a. Header `:3-4`: "(... via `docker exec -u bun`; the routing actions get the same treatment, #240)". `:149`:
"Drain the request mailbox once, serialized against any concurrent drain. Rejects only when the Plugin Index load
threw (the update files stay queued; the routing requests before and after them were handled), never for a file."

2b. `PluginRequestDeps` gains `/** #480 item 4: the Discord ids a snowflake `requestedBy` may be (ADMIN_USER_IDS); a panel identity is any other non-empty string. */ adminUserIds: string[];`
and `announce.ts`'s `livePluginRequestDeps` (`:362-390`) passes `adminUserIds: config.adminUserIds` (a mutant that
passes `[]` survives unless `announce.test.ts:42`'s deps test asserts `deps.adminUserIds` is the SAME array as
`config.adminUserIds` -- `toBe`, not `toEqual`: the preload sets no `ADMIN_USER_IDS`, so `config.adminUserIds` is
`[]` under test and `toEqual([])` is vacuous; measured). Import `MAX_REQUESTED_BY` from `../routing/requests` (export it there, `:61`; no
cycle: `requests.ts:28` already imports `requestIdOf` from that module) and `isDiscordUserId` from `./updates` (export
it if it is not; `:248`).

2c. `validate(raw, installed, entryByName, hostApiVersion, adminUserIds)` (`:428-491`): after the `requestedBy` string
check (`:439`):

```ts
  // #480 items 4 and 5: a Discord id is DMed (the heads-up, the report-back), so it must be an admin's; anything
  // else is a panel identity (email:<addr>, token). Stored and logged as given, so it is bounded and stripped of
  // control characters first (MAX_REQUESTED_BY is the routing path's bound; isDiscordUserId is the DM sites' test).
  const requestedBy = r.requestedBy.replace(/[\x00-\x1f\x7f]/g, "").slice(0, MAX_REQUESTED_BY);
  if (requestedBy.length === 0) return { ok: false, reason: "missing requestedBy" };
  if (isDiscordUserId(requestedBy) && !adminUserIds.includes(requestedBy)) {
    return { ok: false, reason: `requestedBy ${requestedBy} is not an admin` };
  }
```

and the final `return { ok: true, request: { ...(raw as PluginRequest), requestedBy } };`. The comment block at
`:463-472` loses "and it is a better answer to a double-click in the panel too" and gains "the panel does not see
this refusal: it is a log line and a file in `rejected/` (an update request carries no id to record a result under,
unlike a routing request)". After the host-API check (`:484-489`) a comment: "With an empty or uncached index
`entryByName` is empty and this check cannot run: a pin to an incompatible current version is then caught by the
install (it fails and reverts, #104)."

2d. `drainOnce`:
- `:209-211` becomes

```ts
  } catch (err) {
    // #480 item 8: "no requests dir yet" is ENOENT; anything else (EACCES on a root-owned dir, EMFILE) is a mailbox
    // nobody is reading, logged once per error code rather than every beat.
    if (!isNotFound(err)) {
      const code = (err as { code?: unknown }).code;
      const key = typeof code === "string" ? code : errorText(err);
      if (lastReaddirFailure !== key) {
        lastReaddirFailure = key;
        deps.log.warn(`[plugins] cannot list the request mailbox ${deps.requestsDir}: ${key} — panel requests are not being applied`);
      }
    }
    return;
  }
  lastReaddirFailure = undefined;
```

with `let lastReaddirFailure: string | undefined;` beside `undeletable` (`:126`), cleared by
`resetPluginRequestsForTest` (`:130`) and reported by `pluginRequestsStateForTest` (`:145`: `{ undeletable, draining, readdirFailure: lastReaddirFailure !== undefined }`;
`test/stateLeaks.ts:108`'s `pluginRequestLeaks` takes `readdirFailure: boolean` and pushes "a request-mailbox readdir
failure remembered — the next one is not logged" when it is true; `test/stateGuard.test.ts:247`'s `CLEAN` snapshot and
`:258` gain `readdirFailure: false`/the leak case; `test/stateGuard.ts` needs no change).
- Right after `refuse` is defined (`:260-262`) and before `tryParse` (`:263`), so it covers routing and update
  files alike and nothing has looked inside the text yet:
  `if (text.length > MAX_REQUEST_CHARS) { await refuse(\`request file too large (${text.length} characters)\`, true); continue; }`
  with `const MAX_REQUEST_CHARS = 64 * 1024;` beside `TORN_READ_RETRY_MS` (a webhook-add is a few hundred characters;
  `secret = true` makes `reject` delete rather than move aside, Decision 3; `reject` logs the reason, so there is ONE
  line, not a second warn). Not before the torn-read retry: a torn read is short, not long.
- `reject` (find it: the function `refuse` and `:247` call) replaces control characters in the reason it logs:
  `reason.replace(/[\x00-\x1f\x7f]/g, REPLACEMENT)` with `const REPLACEMENT = String.fromCharCode(0xfffd);` (the form
  `resolve.ts:143` uses: a typed `"\ufffd"` escape is normalised to the glyph by the Edit tool) (#480 item 5: a hostile
  `action`, `plugin`, `version` or a thrown error's message cannot start a second log line). Only the log line; the
  reason is otherwise unchanged.
- `validate(raw, installed, entryByName, deps.hostApiVersion, deps.adminUserIds)` at `:320`.
- `:348-350` becomes: after the loop and the `loadFailure` rethrow,

```ts
  // ONE restart after the full drain, so an update-now doesn't strand later co-dropped files -- and only if a
  // targetVersion is still set once every file has been applied (#480 item 6): a cancel in the same drain for the
  // plugin an update-now pinned leaves nothing to install. buildPluginStateFile consumes each targetVersion
  // independently; `pendingReport` is ONE slot (contract.ts), so two update-nows in one drain keep both targets and
  // the LAST report-back only -- the replaced one is named in the log (#480 item 7).
  if (restartReason !== undefined) {
    let pinned = true;
    try {
      pinned = (await deps.readState()).plugins.some((p) => p.targetVersion !== undefined);
    } catch (err) {
      // The files are applied and gone; a lost restart would strand their pins. Restart as before. (One argument:
      // `PluginUpdateLog.warn` takes the message only, updates.ts:511; the cause goes in the text.)
      deps.log.warn(`[plugins] could not re-read the plugin state after the drain (${redactWebhookUrls(errorText(err))}); restarting as requested`);
    }
    if (pinned) deps.requestRestart(restartReason);
    else deps.log.warn("[plugins] the update-now in this drain was cancelled before the restart; nothing to install");
  }
```

2e. `apply`'s `update-now` (`:497-507`): the mutate becomes

```ts
      await deps.mutateState((s) => {
        if (s.pendingReport !== undefined && s.pendingReport.plugin !== r.plugin) {
          deps.log.warn(`[plugins] the report-back for ${s.pendingReport.plugin} ${s.pendingReport.toVersion} is replaced by ${r.plugin} ${r.version}'s (one report slot)`);
        }
        return pinUpdateNow(r.plugin, r.version, report)(s);
      });
```

2f. Call sites that stop compiling (`bun run check` names each; all listed so none is found by surprise):
`validate(...)` with four arguments at `requests.test.ts:32`, `:84`, `:101`, `:114`, `:120`, `:122`, `:131`, `:148`,
`:769`, `:781` (a fifth argument, `[]` or the harness's `ADMIN`); `PluginRequestDeps` literals without `adminUserIds`
at `requests.test.ts:171`, `src/routing/secrets-leak.test.ts:98` and `:280`, `test/stateLeak.fixture.ts:35`.

### Step 3 -- docs

- `CONTEXT.md`'s `requests.ts` row (`:223`; Grep ``| `src/plugins/requests.ts` |`` to re-find it): append `` ; **#480/#481:** a snowflake `requestedBy` must be one of `ADMIN_USER_IDS` (`isDiscordUserId`, the DM sites' test), `requestedBy` is stripped of control characters and clipped to `MAX_REQUESTED_BY`, a file over 64 Ki characters is deleted unparsed, `reject`'s log line cannot be forged by a reason, the restart after a drain is requested only while a `targetVersion` remains (a cancel in the same drain cancels it), a replaced report-back is named, and a `readDir` failure other than ENOENT is logged once per code; update actions still record no result (no writer mints an id for one) ``; the `requests.test.ts` row (`:224`): the new tests. `CONTEXT.md`'s `index.ts` row (`:156`, also edited by D1a): the boot report-back waits for the next boot when a restart exit is requested (`restartRequested`, #419).
- `ops/README.md`'s "Plugin request mailbox" section (`:56-103`; `:77` names what goes to `rejected/`): one sentence
  that a snowflake `requestedBy` must be one of `ADMIN_USER_IDS` (a panel identity, `email:<addr>` or `token`, is
  unchanged), and that a file over 64 Ki characters is deleted, not quarantined.
- The Pip runbook in `ops/README.md`: `:995` ("requires only a non-empty string there … and never consults
  `ADMIN_USER_IDS`"; "anyone in the host's docker group can make Pip's core DM any 17-20 digit user id"; and "The
  panel's 'logged, not sent' outcome is the panel's own choice of a non-snowflake `requestedBy` ... enforced nowhere
  else") -> the new rule (a snowflake must be one of `ADMIN_USER_IDS`; a writer with host access can still name an
  ADMIN's id; the panel's identity is still its own choice, but the bot now refuses a non-admin snowflake from any
  writer); `:934-935` ("This list governs Discord-side actors only") -> it also gates which snowflake a mailbox
  request may name; read `:994`, `:1000` and the comment at `:932-943` (which cites `requests.ts:497-507, :350,
  :514-516` by line) and recite them by symbol (`apply`'s `update-now` case, the post-drain restart, `apply`'s
  `remind` case) with the new behaviour. The `:1000-1001` line cites are a snapshot the `:988-989` header dates to
  `ded55f5`; leave them.
- `CONTEXT.md:184` (the `restart.ts` row; it already names `restartPending()` and `isShuttingDown()`):
  `restartRequested()` beside them.

### Step 4 -- tests

**`src/plugins/requests.test.ts`** (the harness at `:161-223` gains `adminUserIds: [ADMIN]` with
`const ADMIN = "200863115821318144"` in `deps`, and the options `readDirError?: Error` (thrown by `readDir` when set) and
`readStateThrowsAfter?: number` (the n-th `readState` call rejects); test titles carry their `Q<n>` tag):
- **Q1 (#417):** a `schedule` file (`version: "1.1.0"`, `at: "2026-09-06T12:00:00.000Z"`) -> `scheduled` equals
  `{ version: "1.1.0", at: "2026-09-06T12:00:00.000Z", requestedBy: "email:me@x.com" }` (`toEqual`: no `channelId`
  from the mailbox, so U2's optional field is absent); a `remind` file with no `days` -> `remindAt` is exactly
  `"2026-09-12T12:00:00.000Z"` (the harness's `now` plus 7 days); with `days: 3` -> `"2026-09-08T12:00:00.000Z"`;
  a `cancel` file on an `opts.state` whose entry has `scheduled`, `targetVersion` and whose file has a matching
  `pendingReport` -> all three cleared; `requestedBy: 5` -> rejected with `missing requestedBy`; `restarts` empty
  in every case (none of these needs one).
- **Q2 (#480 item 4):** `requestedBy: ADMIN` -> applied; `"300000000000000000"` (18 digits, not in it) -> rejected
  with `is not an admin`, and so are a 17-digit and a 20-digit non-admin (`"1".repeat(17)`, `"1".repeat(20)`: the
  snowflake range's ends); `"email:me@x.com"`, `"token"` -> applied; a 16-digit and a 21-digit string -> applied (not
  a snowflake: a panel identity); `validate` directly with `adminUserIds: []` and a snowflake -> refused.
- **Q3 (#480 item 5):** `requestedBy: "me\n\t\r\x00\x7f\x1b[31mevil" + "x".repeat(300)` -> applied, and the stored
  `pendingReport.userId` has none of those characters and is exactly 200 units long; `requestedBy: "\n\t"` ->
  rejected with `missing requestedBy` (the post-strip check); a file whose `requestedBy` is `"x".repeat(70_000)`
  (the harness JSON-encodes it: 70,074 characters) -> `fs.size` 0 and `rejected` EMPTY (deleted, not moved aside),
  exactly ONE warn, matching `rejecting request .* too large \(70074 characters\)`, no `mutations`, and
  `h.indexLoads === 0` (never reached the parse, let alone the index); a second case where that file is
  `"{ not json" + "x".repeat(70_000)` set raw into `h.fs` -> the same warn, no `unreadable JSON` rejection (the size
  check runs first); and the log sink: a file with `action: "nope\n\r\x1b\x7fforged"` -> the `rejecting request` warn
  is one line containing none of those four characters and four U+FFFD, and `errors` is empty.
- **Q4 (#480 item 6):** `100-update-now` + `200-cancel` for the same plugin -> `restarts` empty, `targetVersion`
  undefined, `pendingReport` undefined, both files gone, one warn `cancelled before the restart`. The existing
  `:321-332` test has exactly that shape (all three files are `wb(...)`, so under the new rule its cancel clears the
  only target and no restart follows): change its cancel to a second installed plugin `other` (through `opts.state`;
  `validate` needs only the installed map for a cancel) so it still pins "two update-nows share ONE restart after the
  full drain" by a case where a target remains, AND assert that its two same-plugin `update-now`s produce NO
  `one report slot` warn (a second click on the same plugin is silent). `readStateThrowsAfter: 2` (call 1 is the
  context load, call 2 the post-drain re-read) -> the restart IS requested, one warn `could not re-read`, the drain
  resolves.
- **Q5 (#480 item 7):** two `update-now`s for `warbandeer` and a second installed plugin `other` -> both
  `targetVersion`s set, `pendingReport.plugin === "other"`, one warn naming `warbandeer` and `other`, one restart.
- **Q6 (#480 item 8):** `readDirError` = `Object.assign(new Error("EACCES"), { code: "EACCES" })` (`isNotFound` at
  `:198` tests `.code`; the harness's own non-REQ_DIR rejection at `:173` has no code, which no existing test reaches)
  -> one warn naming `EACCES` and `REQ_DIR`, no throw; a second drain -> no second warn; a `code: "ENOENT"` error ->
  no warn; after a drain whose `readDir` succeeds a later `EACCES` warns again; `pluginRequestsStateForTest().readdirFailure`
  is `true` after the failure and `false` after `resetPluginRequestsForTest()`.
- **Q7 (#481 item 9, unchanged behaviour):** the existing `:1687-1693` ("update actions record no result") stays
  green, and gains a sibling sending an `update-now` WITH an `id` and routing deps -> `results` still `[]`.
- **Q8 (comments, #481 item 10):** none; the lens-B audit reads them.

**`src/restart.test.ts`:** `restartRequested()` across the states: nothing -> false; `beginHandoff` alone -> false
(while `restartPending()` is true); `requestRestart` under `beginCritical` -> true; `requestRestart` under a critical
section AND an active handoff -> true; `beginShutdown` -> true; `resetForTest` in `finally` (the `setExitFn` restore
pattern the file uses).

**`src/index.test.ts`:** a source pin in the `#241` describe (`:478-513`, which holds `activateFn`; `bootDrain` is
test-local at `:505`, so compute it again inside the new test): `const guard = source.indexOf("if (restartRequested()) {", bootDrain)`
is greater than `bootDrain` and less than `source.indexOf("reportPluginUpdateOutcome({", activateFn)` (that call's
index is taken from `activateFn`, as `:245` does -- note `:241`'s warning about the `reportUpdateOutcome(` prefix),
and the slice between `guard` and the report call contains `} else {` (the call is in the else branch).

**`src/announce.test.ts:42`** (the `livePluginRequestDeps` test): `expect(deps.adminUserIds).toBe(config.adminUserIds)`
(identity; see 2b).

**`test/stateGuard.test.ts`:** `pluginRequestLeaks` gains the `readdirFailure` case (and `:247`/`:258` per 2d).

### Mutation table (scratch worktree; `bun test src/plugins/requests.test.ts src/index.test.ts src/restart.test.ts src/announce.test.ts test/stateGuard.test.ts` per mutant)

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | 1b: the `restartRequested()` guard removed | the index.test.ts pin |
| M1b | 1a: `restartRequested` = `restartPending()` | restart.test's handoff-alone case |
| M1c | 1a: `restartRequested` = `pending !== undefined` | restart.test's shutdown case |
| M2 | 2c: the admin check dropped | Q2 |
| M2b | 2c: `isDiscordUserId` -> `/^\d{17,20}$/` test duplicated and loosened to `{16,21}` | Q2's 16/21-digit cases |
| M2d | 2c: the same, narrowed to `{18,20}` or `{17,19}` | Q2's 17-digit and 20-digit non-admin cases |
| M2c | 2b: `announce.ts` passes `adminUserIds: []` | the announce.test.ts assertion |
| M3 | 2c: the control-character strip dropped | Q3 |
| M3b | 2c: `\x7f` dropped from the strip class | Q3 (the `\x7f` survives) |
| M3c | 2c: the post-strip emptiness check dropped | Q3's `"\n\t"` case |
| M4 | 2c: `.slice(0, MAX_REQUESTED_BY)` dropped | Q3 (length) |
| M5 | 2d: the size check dropped | Q3 (parsed, other reason) |
| M5b | 2d: the size check's `refuse(..., true)` -> `refuse(..., false)` | Q3 (`rejected` not empty) |
| M5c | 2d: `reject`'s control-character replace dropped, or narrowed to `\n` only, or missing `\x7f` | Q3's forged-line case (four characters) |
| M6 | 2d: the post-drain `targetVersion` check dropped (restart whenever latched) | Q4 |
| M6b | 2d: the re-read's try/catch dropped (a rejecting `readState` rejects the drain) | Q4's `readStateThrowsAfter` case |
| M7 | 2e: the slot warn dropped | Q5 |
| M7b | 2e: `!== r.plugin` dropped (warn on the same plugin too) | the rewritten `:321` test (no-warn assertion) |
| M8 | 2d: the readdir catch back to `return` | Q6 |
| M9 | 2d: the once-per-code guard dropped | Q6 (two warns) |
| M9b | 2d: `lastReaddirFailure = undefined` after a successful `readDir` dropped | Q6 (no re-warn after recovery) |
| M13 | Q1's effects: `scheduleUpdate`'s `version`/`at` swapped in `apply` (`:509`) | Q1 (`scheduled.at`) |
| M14 | `apply`'s `(r.days ?? 7)` -> `(r.days ?? 1)` (`:512`) | Q1 (the default `remindAt`) |
| M15 | `apply`'s `cancel` case -> a no-op mutate | Q1 (the cancel case) |

### Coverage table

| Bullet | Step(s) | Test | Mutation |
|---|---|---|---|
| #419: a requested restart exit defers the boot report-back to the next boot (a handoff alone does not); the comment is true | 1 | index pin, restart.test | M1, M1b, M1c |
| #417: schedule, remind (default and explicit), cancel and a non-string requester are asserted after a drain | 4 | Q1 | M13, M14, M15 |
| #480-4: a snowflake requester must be an admin, through the live deps | 2b, 2c | Q2, announce.test | M2, M2b, M2c, M2d |
| #480-5: requester bounded and clean; the log sink cannot be forged; a huge file deleted unread, one line | 2c, 2d | Q3 | M3, M3b, M3c, M4, M5, M5b, M5c |
| #480-6: a cancel in the drain cancels the restart; a failed re-read restarts as before | 2d | Q4 | M6, M6b |
| #480-7: a replaced report-back is named, a same-plugin re-pin is not; the slot is documented | 2e | Q5, the `:321` test | M7, M7b |
| #480-8: an unreadable mailbox is logged once per code, again after a recovery | 2d | Q6 | M8, M9, M9b |
| #481-9: update actions record no result (kept, with the reason); the comment is true; both suggested fixes declined | 2c, Decision 7 | Q7 | -- |
| #481-10: the comments are true | 2a, 2c | lens-B audit | -- |

### Verification

```bash
bun install --frozen-lockfile
bun run check
bun test src/plugins/requests.test.ts src/index.test.ts src/restart.test.ts src/announce.test.ts src/routing/secrets-leak.test.ts test/stateGuard.test.ts
bun test
```

Not verifiable here: #419's timing in a live boot (the fix is an ordering guard; the reproduction is the read order,
`requestRestart`'s deferral and the unit probe, all quoted in the PR).

### Acceptance to paste per issue

- **#419:** the index pin's and the restart.test cases' pass lines, M1-M1c; the quoted order and the unit probe.
  **#417:** Q1 and M13-M15. **#480:** Q2-Q6, M2-M9b. **#481:** Q7; the three comment diffs; Decision 7's two
  declines with their reasons, and the note left on #529.

### PR

- Title: `fix(plugins): defer the boot report-back behind a requested restart, require an admin for a snowflake requester, bound what the mailbox stores and logs, withhold a cancelled restart, and log an unreadable mailbox (#419, #417, #480, #481)`.
- Body: the items, Decisions 1-8, the output, the mutation table. End with `Closes #419. Closes #417. Closes #480. Closes #481.`
- After merge: tick the four on #527; a comment on #529 that recording update outcomes needs the panel to mint and
  surface an id for update requests (A3's call).
