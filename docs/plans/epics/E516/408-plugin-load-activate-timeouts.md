# #408 -- bound plugin `import()` and `activate()` so one hung plugin can't stall boot

Part of Epic #516 (2026-10-08 code review follow-ups). Issue #408: `bug`, `priority: high`, effort M; the
first child in the epic's build order. A behaviour change, so the full three-reviewer gate applies. Written by
the orchestrator on 2026-10-08 against `main` @ `ded55f5`. Every `file:line` below was read there, and `src/`
is unchanged at `d8cd5af`, where Appendix A also applies cleanly. Re-read each cite on your tree before you
edit, and say so if it moved. An independent claims-vs-code audit of this plan ran before it was committed,
and its findings are folded in.

The code in Appendix A is not a sketch. The orchestrator built it in a scratch worktree off `ded55f5` and ran
`bun run check`, both `ops` typechecks, the full `bun test`, the acceptance script (Appendix B) and every
mutation in Appendix C (31 after review round 1, all killed). Apply it as written and report any deviation.
"Review gate log", below, records what each round found and what changed.

## Hand-off

Written for a Sonnet subordinate, as the epic's method says for an M child. On 2026-10-08, roshne chose to
have the orchestrator ship it directly instead, since the code had already been built and checked. So this
file landed together with the code, in the same PR, and steps 1-8 below were run by the orchestrator. The
sub-facing wording is kept as written.

For a subordinate, the brief would have been the following, with the file already on `main`:

```
/work-on 408 -- EXECUTE AS WRITTEN docs/plans/epics/E516/408-plugin-load-activate-timeouts.md
```

The sub would have worked in a worktree of its own, never the shared checkout:
`git worktree add ../_wt/rdb-408 origin/main -b 408-bound-plugin-import-activate`. That worktree is a clean,
current base and its own branch, so `/work-on`'s steps 1, 2 and 4 are already done: start at step 3 (read the
issue and all its comments) and post this plan as the issue's `## Plan` comment. Write scratch files under
your own scratchpad with names ending `-408` (`commit-msg-408.txt`, `pr-body-408.txt`), and read each one back
before using it.

## What is wrong (verified at `ded55f5`)

- `activatePlugins` (`src/plugins/host.ts:542-552`) awaits each plugin's `activate()` inside a try/catch and
  nothing else. A throw is isolated; a promise that never settles is not.
- `loadPlugins` (`host.ts:212-232`) has the same gap at `await importer(bundlePath)` (`:222`).
- `src/index.ts` awaits both inline inside `activate(c)`, which the `ClientReady` handler runs
  (`index.ts:129-138`) after it has already cleared the standby verify timer (`:131`). `loadPlugins` is at
  `:202`, before the interaction handler is attached (`:222`); `activatePlugins` is at `:301`, before
  `startScheduler` (`:314`), the HTTP listener (`:320-344`), `startRequestDrain` (`:354`), `initRouting` and
  the boot command registration (`:367-383`), `writePluginState` (`:405`) and `markPluginStateReady` (`:436`).
  One hung plugin leaves a bot that logged in, passed its self-update verification, and never comes up.
- The host already bounds ticks (`withTickTimeout`, `:359`), dispose (`:588-591`), HTTP (`:864-869`) and
  autocomplete (`within` at `:730` and `:745`). Not every plugin call: a component/modal handler is awaited
  unbounded (`dispatchPluginInteractionOutcome`, `:652`), as the issue's own "every other plugin call" also
  overlooks. That one is not boot-blocking and is not this issue's.
- The premise holds on the Bun the repo runs. A dynamic `import()` of a bundle whose top-level `await` never
  settles stays pending (scratch probe on Bun 1.4.2):
  `bun 1.4.2: import outcome = still pending after 500ms (527ms)`.
- The reproduction: Appendix B's script against the unchanged tree, through the host's own `loadPlugins` and
  `activatePlugins` with real on-disk bundles and the importer `index.ts` uses:

  ```
  ded55f5
  bun 1.4.2, bounds 200/300ms
  A  loadPlugins: STILL PENDING after 3000ms -- boot stalls here
  B  activatePlugins: STILL PENDING after 3000ms -- boot stalls here; [{"name":"hang-activate","running":false},{"name":"ok","running":false}]
  C  skipped: a phase above stalled
  exit=1
  ```

  Phase B also shows the plugin after the hung one (`ok`) never activating. (Against the unchanged tree the
  extra `timeoutMs` argument the script passes is simply ignored.)

## Decisions (made by the orchestrator; cite them in the PR)

- **D1. The bounds.** `PLUGIN_IMPORT_TIMEOUT_MS = 10_000` and `PLUGIN_ACTIVATE_TIMEOUT_MS = 30_000`. Every
  published plugin's `activate()` is short local work (read in `rackbops-bot-plugins`' `plugins/*/src/index.ts`;
  the local checkout was 26 commits behind `origin/main`, and the auditor confirmed upstream `music` is
  unchanged in shape). `wow` initialises its store. `warbandeer` loads its links and may `Bun.serve` a port.
  `music` initialises its stores and may start a callback server. `mcp` marks pending deliveries unknown.
  `tracker` opens, vacuums and recovers its SQLite database. The one network step is that `warbandeer` and
  `music` resolve `TRUSTED_PROXY_HOST` (a DNS lookup, `proxy.refresh()`) when it is set. 30 s is the bound a
  tick already gets (`PLUGIN_TICK_TIMEOUT_MS`) and leaves all of that wide room. An import is a parse of one
  local file; 10 s matches `PLUGIN_HTTP_TIMEOUT_MS`. Activation stays sequential ("in order", as
  `disposePlugins`' comment describes it), so N wedged plugins delay boot by at most N × (10 + 30) s, never
  forever. The bound covers only time spent *waiting*. `Promise.resolve(lp.plugin.activate?.())` runs
  `activate()`'s synchronous prefix before `within` arms the timer, and synchronous work after an `await`
  that ends by resolving still beats an overdue timer, because microtasks drain first. The auditor probed both
  on Bun 1.4.2: with 300 ms of synchronous work and a 100 ms bound, the plugin still settled within its bound.
  Synchronous work can't be bounded from the same thread anyway (D6).
- **D2. A timed-out plugin stays off for this boot.** `running` stays false and `error` becomes
  `activate() did not finish within 30000ms`, logged through the existing "failed to activate -- the bot keeps
  running without it" line, exactly the throw path. That `error` is what `buildPluginStateFile` writes to
  `state.json` (`host.ts:945`, `loaded?.error`). It does not come up late if `activate()` later resolves.
  Only the boot write, after `activatePlugins` returns, computes `active` and `error`; the later writes
  through `mutatePluginState` (`updates.ts`, `requests.ts`, `commands.ts`) never set either. A plugin that
  switched itself on mid-life would therefore contradict the panel and `bot-ops.sh status` until the next boot.
- **D3. A late resolve is disposed; a late rejection is only logged.** Shutdown's `disposePlugins` disposes
  only `running` plugins (`host.ts:584`), so without this a `music` or `warbandeer` `activate()` that finished
  late would keep its port and timers for the life of the process while `state.json` said it was inactive. Its
  `dispose()` runs once, as soon as `activate()` resolves (never before: a dispose that ran while `activate()`
  was still going could run before anything was set up). It is isolated like every other plugin call, so a sync
  or async throw is logged with `disposePlugins`' own "dispose failed -- continuing" wording. Nothing awaits
  it, so it is not bounded. A late rejection is logged at warn and not disposed: "one whose `activate()`
  threw has nothing `dispose()` could safely release" (`host.ts:570-571`).
- **D4. A late import is dropped.** `createPlugin` never runs for it. Whatever the module's own top level does
  is out of the host's reach; that is noted in the constant's comment, not fixed.
- **D5. The contract's doc comments change; its shape does not.** `src/plugins/contract.ts` gains the bound and
  the late-dispose rule on `activate?()` and `dispose?()`, and the timeout on `PluginStateEntry.error`.
  Comments only: no type changes, `HOST_API_VERSION` stays `1`, and `contract.test.ts` (no runtime code but
  that constant) stays green. The consequence: `rackbops-bot-plugins` vendors this file byte-for-byte as
  `packages/api/contract.d.ts`, and its `scripts/check-contract.ts` (in its CI's `checks` job, which runs on
  every `pull_request` and on pushes to `main`, `ci.yml:7-10`) fails until it is re-vendored. That job is not
  a required check there (its `AGENTS.md:124`), so the drift turns its PRs red without blocking their merges.
  The orchestrator opens that XS re-vendor PR right after this one merges, not before, so a contract still in
  review is never propagated. The alternative, if roshne prefers it: drop the `contract.ts` hunks here and
  fold them into the next contract change.
- **D6. Out of scope, by issue.** #407 (slash commands aren't `running`-gated): until it lands, a timed-out
  plugin's commands still dispatch, as a plugin's whose `activate()` threw do today. There is one
  difference: a plugin whose late `activate()` resolves is then disposed (D3), so its commands keep
  dispatching against resources it has released. `contract.ts` tells plugin authors so. #409
  (`disposePlugins` flips `running` only after dispose): this plan does not touch `disposePlugins`'s code, but
  #409 will very likely touch the same single-line `CONTEXT.md` rows (the `host.ts` row, where its "the flip
  stops the gate" claim lives, and the `host.test.ts` row) and perhaps the `LoadedPlugin.running` comment this
  diff edits. Whichever lands second gets a text conflict there. A conflict on a `CONTEXT.md` row is roshne's
  to see before it is resolved (personal CLAUDE.md, Escalation), so the PR that hits it stops and asks rather
  than picking a side. #470's `plugin-host-7` (no global `unhandledRejection` handler): this change adds no
  unhandled path. A test pins each late `activate()` path; a late import rejection is absorbed by `within`'s
  own `p.then(resolve, reject)` (`host.ts:694`) and is not separately tested. #475's `docs-context-md-8`
  (stale `index.ts:144`/`:163` cites in the same gotcha): left for #475; this plan only appends to that
  bullet. A synchronous infinite loop in `activate()` or `createPlugin` can't be bounded from the same thread.
- **D7. Every catch that describes a plugin's throw does it without throwing (added in review round 1).**
  Plugin code can throw or reject with anything, including a value `String()` throws on
  (`Object.create(null)`, "No default value" on Bun) or an Error whose `message` getter throws. Before this
  change, `activatePlugins`' own catch called `String(err)`, so such a throw escaped `activatePlugins`
  itself. Later plugins never activated and the rejection left the `ClientReady` listener, which halts boot
  by another route. The same applied to the import catch, the late paths, `pluginCommandMap`, `pluginTicks`
  (both called outside `index.ts`'s setup try) and `disposePlugins`. A single `describeThrown` helper in
  `host.ts` now serves all six sites. It falls back to `(unprintable thrown value)`. `afterLateActivate`'s
  chain also ends in a catch, so even a throwing logger can't leave an unhandled rejection. Each site has
  its own test and its own mutation (M19-M27).

## Acceptance

The issue has no `## Acceptance` section. These are the observable outcomes its failure scenario demands.

- [ ] **A1.** A plugin whose `activate()` never settles no longer stalls boot. `activatePlugins` returns after
      the bound with that plugin `running: false` and `error` = `activate() did not finish within <ms>ms`
      (logged), and the plugins after it activate.
- [ ] **A2.** A bundle whose `import()` never settles no longer stalls boot. `loadPlugins` returns after the
      bound with `import() did not finish within <ms>ms` recorded and logged for it, and loads the bundles
      after it.
- [ ] **A3.** Real callers, which pass no bound (`index.ts:202`, `:301`), get 10 s for an import and 30 s for
      an `activate()`.
- [ ] **A4.** An `activate()` that finishes after the bound stays off and is disposed once it lands, and not
      before. One that fails after the bound is logged and not disposed. A late `dispose()` that throws is
      logged. No late path leaves an unhandled rejection.
- [ ] **A5.** `state.json` says so: `active: false` and the missed bound as `error` for each hung plugin;
      `active: true` and no `error` for the plugin after them.
- [ ] **A6.** On the real boot path (`ClientReady` → `activate()` → `index.ts:301`), a hung plugin delays boot
      by its bound and then the bot comes up: the plugins after it active, the scheduler started, commands
      registered, `state.json` written. Manual, on the debug instance (V2).
- [ ] **A7.** (Added in round 1.) A plugin that throws or rejects with a value `String()` can't convert, from
      its import, `activate()`, `commands`/`ticks` getter, or `dispose()` (late or at shutdown), is still
      isolated and logged as `(unprintable thrown value)`, and the plugins after it are unaffected.

## Steps

### 1. Before-evidence (no code change yet)

A fresh worktree has no `node_modules`: run `bun install --frozen-lockfile` in its root and again with
`--cwd ops/admin`. Extract the three appendices into your scratchpad (each is the one fenced block under its
heading), then run the acceptance script against your untouched worktree:

```bash
PLAN=<worktree>/docs/plans/epics/E516/408-plugin-load-activate-timeouts.md
awk '/^## Appendix A/{f=1} f&&/^```diff$/{p=1;next} p&&/^```$/{exit} p' "$PLAN" > <scratchpad>/408-code.diff
awk '/^## Appendix B/{f=1} f&&/^```ts$/{p=1;next} p&&/^```$/{exit} p' "$PLAN" > <scratchpad>/acceptance-408.ts
awk '/^## Appendix C/{f=1} f&&/^```ts$/{p=1;next} p&&/^```$/{exit} p' "$PLAN" > <scratchpad>/mutate-408.ts
bun <scratchpad>/acceptance-408.ts <worktree>
```

Paste the output. Expect `exit 1` and both phases `STILL PENDING`, as in "What is wrong".

### 2. Apply the change (Appendix A, plus the `CONTEXT.md` edits below)

Appendix A is the full diff for `src/plugins/host.ts`, `src/plugins/contract.ts`, `src/plugins/host.test.ts`
and `src/index.test.ts` (the orchestrator checked that the extracted block applies cleanly to a fresh tree). Run
`git -C <worktree> apply --check <scratchpad>/408-code.diff`, then the same without `--check`. If `--check`
fails because a line moved, apply that hunk by hand with Edit and say which.
In summary:

- `host.ts`: `PLUGIN_IMPORT_TIMEOUT_MS` above `loadPlugins`; `loadPlugins` takes `timeoutMs` (default that
  constant) and races the import through the existing `within(...)` helper with the existing `TIMED_OUT`
  sentinel (both further down the file; `within` is a hoisted function declaration and `TIMED_OUT` is read
  only at call time, so neither moves). `PLUGIN_ACTIVATE_TIMEOUT_MS` above `activatePlugins`;
  `activatePlugins` takes `timeoutMs` and, on a timeout, hands the still-pending call to the new
  `afterLateActivate` and throws into the existing catch, so the log line and `lp.error` come from the one
  place they already did. The `LoadedPlugin.running`/`error` and `LoadResult.errors` comments are updated.
  Round 1 adds `describeThrown`, used at all six catch sites, and the late chain's terminal catch (D7).
- `contract.ts`: comments only (D5).
- `host.test.ts`: an `orHung` helper so a dropped bound fails by name rather than deadlocking (`CONTEXT.md`'s
  gotcha on tests that can deadlock), plus an `unprintable()` value. Four `loadPlugins` tests, eleven
  `activatePlugins` tests, one each for `pluginCommandMap`, `pluginTicks` and `disposePlugins`, and a
  `state.json` consumer-boundary describe.
- `index.ts`: **no change.** Both calls keep taking the defaults. `index.test.ts` gains one test pinning that
  boot passes neither call a bound of its own.

`CONTEXT.md`, three edits. Its rows are several KB each, so anchor each Edit on the short substring quoted:

1. The `src/plugins/host.ts` row. Replace
   `isolating a throwing import/createPlugin (recorded, skipped, never fatal).` with
   `isolating a throwing import/createPlugin, and an import still unsettled after `PLUGIN_IMPORT_TIMEOUT_MS` (10 s, #408), the same way (recorded, skipped, never fatal).`
   In the same row, replace `` `activatePlugins` runs each `activate()` in order, isolating a throw. `` with
   `` `activatePlugins` runs each `activate()` in order, isolating a throw, and an `activate()` still unsettled after `PLUGIN_ACTIVATE_TIMEOUT_MS` (30 s, #408) the same way: that plugin stays off this boot (its slash commands excepted, which are not `running`-gated until #407), and if its `activate()` resolves later, its `dispose()` runs then (`afterLateActivate`), since `disposePlugins` skips a plugin that was never marked running. Every catch here that turns what it caught into text (a log line, or `state.json`'s `error`) does it through `describeThrown`, which never throws itself, so even a value `String()` can't convert stays isolated. ``
2. The `src/plugins/host.test.ts` row. After `activate order + isolation + `running`/`error`;` insert
   `` **#408:** an import or `activate()` that never settles is given up on at its bound (the bundles and plugins after it still load and activate, and the bound it missed is the `errors`/`error` text, through to `state.json`), the defaults are pinned (`PLUGIN_IMPORT_TIMEOUT_MS` 10 s, `PLUGIN_ACTIVATE_TIMEOUT_MS` 30 s), a late import is dropped, and a late `activate()` is disposed once it lands and not before (a late rejection is only logged, as is a late `dispose()` that throws), a plugin with no `activate()` still comes up, every catch survives a thrown value `String()` can't convert, and a throwing logger leaves no unhandled rejection; ``
3. The gotcha **"Plugin ticks are `running`-gated, and `activatePlugins()` runs BEFORE `startScheduler()`."**
   After its last line (`` first — that reintroduces the boot-announcement gap this ordering closes; `index.test.ts` pins it. ``)
   append, indented two spaces like the rest of the bullet:

   ```
     Because everything after it waits on `activatePlugins()`, it is bounded per plugin (#408): an
     `activate()` still unsettled after `PLUGIN_ACTIVATE_TIMEOUT_MS` (30 s), like a bundle `import()` after
     `PLUGIN_IMPORT_TIMEOUT_MS` (10 s) in `loadPlugins()`, is recorded as that plugin's failure, so a hung
     plugin delays the scheduler, the HTTP listener, routing and the boot state write by the bound, not forever.
   ```

   Leave the bullet's stale `index.ts:144`/`:163` cites alone; they are #475's.

Commit as you go, Conventional Commits with the issue number, e.g.
`fix(plugins): bound plugin import() and activate() so one hung plugin can't stall boot (#408)`.

### 3. Local checks

```bash
bun run check
bunx tsc --noEmit -p ops/tsconfig.json
bun run --cwd ops/admin check
bun test
bun test --randomize
```

All green; paste the summaries. Nothing here is `skipIf(win32)`, so a Windows run covers these tests.

### 4. Acceptance (V1), after the change

```bash
bun <scratchpad>/acceptance-408.ts <worktree>
bun <scratchpad>/acceptance-408.ts <worktree> --defaults
```

The orchestrator's prototype run gave exactly this; yours should match apart from timings, paths and dates:

```
bun 1.4.2, bounds 200/300ms
[plugins] hang-import: import() did not finish within 200ms
A  loadPlugins returned after 205ms: loaded=["ok"] errors={"hang-import":"import() did not finish within 200ms"}
[plugins] hang-activate failed to activate — the bot keeps running without it: activate() did not finish within 300ms
[ok] activated
B  activatePlugins returned after 302ms: [{"name":"hang-activate","running":false,"error":"activate() did not finish within 300ms"},{"name":"ok","running":true}]
...
C  load + activate + state write took 517ms; ...\data\plugins\state.json:
  (abbreviated here; the script prints the whole file)
  hang-import    "active": false, "error": "import() did not finish within 200ms"
  hang-activate  "active": false, "error": "activate() did not finish within 300ms"
  ok             "active": true (no error)
exit=0
```

`--defaults` (about 80 s) shows the real callers' bounds through the real `import()`: phase A returned after
10005 ms, phase B after 30002 ms, phase C after 40008 ms, with `10000ms`/`30000ms` in the errors. Paste the
full output of both runs, `state.json` included.

### 5. Mutation check

Run `mutate-408.ts` (extracted in step 1) in a **scratch worktree of the committed branch**, never in your
working tree or the shared checkout (the script rewrites `host.ts` while it runs):

```bash
git -C <worktree> worktree add --detach <scratchpad>/wt408-mut HEAD
bun install --cwd <scratchpad>/wt408-mut --frozen-lockfile
bun <scratchpad>/mutate-408.ts <scratchpad>/wt408-mut
git -C <worktree> worktree remove --force <scratchpad>/wt408-mut
```

Expect `31 mutations, 0 survived` and exit 0; paste it. An anchor that is not found prints `??` and counts as
a survivor: fix the anchor to the code you applied, never loosen the test.

### 6. Review gate (yours, before the PR)

Two adversarial reviewers, read-only, given the merged-state tree, issue #408 and this plan, told to verify
rather than accept. Fix or decline in writing every evidenced finding; up to four rounds, then hand back to
the orchestrator with the round count and what each round found. A wording-only fix needs no new round.

- **Reviewer 1, failure modes.** Every path a late `activate()` or import can take. Does it settle before
  `activatePlugins` returns, while a later plugin is activating, during a shutdown drain, or after
  `process.exit`? Can a late `dispose()` and shutdown's `disposePlugins` ever both run for one plugin? Look for
  any unhandled rejection, including a late import rejection (untested; D6 says why it is safe): a test-only
  `process.on("unhandledRejection")` probe is fair. Check for timers left
  armed (`within` clears its own on settle). Look at the sequential worst case, a throwing `activate` getter, a
  thenable from `activate()`, and the standby path (`index.ts:129-138`: verify timer cleared, `takeOver` done,
  then this). Confirm `index.ts` needs no change.
- **Reviewer 2, claims vs code, and the acceptance walk.** Every comment and doc sentence the diff adds or
  changes (`host.ts`, `contract.ts`, the three `CONTEXT.md` edits) checked against the code it describes.
  Rerun V1, then walk the coverage table: does each test assert what its name says, and does the named
  mutation fail it? Confirm `contract.ts` gained no runtime code (`contract.test.ts`).

### 7. Pull request

Title: `fix(plugins): bound plugin import() and activate() so one hung plugin can't stall boot (#408)`. Body:
`Closes #408`, `Part of #516`; Summary; the decisions D1-D6 by number, one line each; Test plan, with the
automated list from the coverage table plus V1's pasted output, and V2 under Manual as "run by the
orchestrator on the debug instance before merge"; Assumptions "None"; a closing line saying the
`rackbops-bot-plugins` re-vendor follows the merge (D5). Wait for CI (both `checks` and `docker-build`), then
message the orchestrator with the PR link and every pasted output. Do not merge: V2 runs first.

### 8. Orchestrator, after the sub hands back

1. Verify the pasted evidence: steps 1, 3, 4 and 5 and the gate's findings. Re-run anything that looks off.
2. Run V2 (below), paste it into the PR, then merge.
3. Re-vendor `packages/api/contract.d.ts` in `rackbops-bot-plugins` from the merged `contract.ts` (an XS PR
   there; its `check-contract` goes green again).
4. Put the debug instance back on `main` (V2 step 5) and tick #408 on #516.

## Coverage table

| Acceptance | Step | Test (`src/plugins/host.test.ts`) | Mutation that fails it (Appendix C) |
|---|---|---|---|
| A1 | 2 (`activatePlugins`) | `activatePlugins` > "an activate() that never settles is given up on after timeoutMs: the plugin stays off and the ones after it still activate (#408)" | M5 (bound dropped: hangs), M8 (timed-out plugin marked running), M6 (activate never called) |
| A2 | 2 (`loadPlugins`) | `loadPlugins` > "an import that never settles is given up on after timeoutMs, and the bundles after it still load (#408)"; "an import that lands after the bound is dropped: createPlugin never runs for it (#408)" | M1 (bound dropped), M2 (sentinel check dropped) |
| A3 | 2 (constants, defaults) | "real callers get PLUGIN_IMPORT_TIMEOUT_MS, 10 s (#408)"; "real callers get PLUGIN_ACTIVATE_TIMEOUT_MS, 30 s, the same bound as a tick (#408)" | M3, M4, M9, M10 |
| A3 (`index.ts` half) | 2 | `index.test.ts` > "boot calls loadPlugins and activatePlugins with no bound of its own (#408)" | M28, M29 |
| A4 | 2 (`afterLateActivate`) | "an activate() that finishes after the bound stays off, and is disposed once it does -- not before (#408)"; "an activate() that fails after the bound is logged and not disposed (#408)"; "a dispose() that throws synchronously after a late activate() is logged (#408)"; "a late dispose() that rejects with a value String() can't convert is still logged (#408)" (the async case); "a late activate() whose log line throws leaves no unhandled rejection (#408)" | M7, M11, M12, M13, M14, M15, M16, M17, X2, M27 |
| A5 | 2 | "a plugin that never finishes loading or activating, through to state.json (#408)" > "is recorded active:false with the bound it missed as its error; the plugin after it is active" | M1, M2, M8 |
| A7 | 2 (`describeThrown`, D7) | `loadPlugins` > "an import that rejects with a value String() can't convert is still isolated, and the bundles after it still load (#408)"; `activatePlugins` > "an activate() that throws a value String() can't convert is isolated, and the plugins after it still activate (#408)", "an activate() that rejects after the bound with a value String() can't convert is still logged (#408)", "a late dispose() that rejects with a value String() can't convert is still logged (#408)"; `pluginCommandMap` > "a commands getter that throws a value String() can't convert is skipped and logged, not thrown (#408)"; `pluginTicks` > "a ticks getter that throws …"; `disposePlugins` > "a dispose that rejects with a value String() can't convert is still logged (#408)" | M19 (the helper), M20-M26 (one per site) |
| `activate` optional / plain value | 2 | "a plugin with no activate(), or one that returns a plain value, is running (#408)" | X1 (the `Promise.resolve` wrap dropped) |
| A6 | V2 | none: `activate()` runs only after a real gateway login (`ClientReady`), which no test has | n/a, manual |
| Sync-throw isolation (behaviour kept; the test is new) | 2 | "a synchronously-throwing activate is isolated the same as an async rejection" | M18 (activate called outside the try) |

The `contract.ts` and `CONTEXT.md` lines are doc-only and carry no mutation. Reviewer 2 checks them against
the code instead.

## Review gate log

**Round 1** (two adversarial reviewers on `e001d32`; both verdicts NOT SOUND). Every evidenced finding was
reproduced before it was fixed.

- Failure-mode lens, MAJOR: a value `String()` can't convert, thrown or rejected by a plugin, made the
  isolating catches throw. That leaves an unhandled rejection on the late paths, and in-bound it makes
  `activatePlugins` itself reject, halting boot (reproduced: `String(Object.create(null))` throws
  `TypeError: No default value` on Bun 1.4.2). **Fixed:** D7, A7, M19-M27.
- Failure-mode lens, MINOR: the contract's "exactly as if this had thrown" was not exact, because a late
  resolve is disposed and a thrown plugin is not. **Fixed** in the wording.
- Failure-mode lens, MINOR: `orHung` leaves a 2 s timer armed, and a false "hung" needs a ≥2 s synchronous
  stall before the first microtask drain. **Declined:** not a realistic flake (the reviewer's own probe:
  a 2.3 s in-loop stall still returned 3/3).
- Claims lens, MAJOR: `Promise.resolve(...)` around `activate()` was unguarded. Its mutation X1 survived, and
  a plugin with no `activate()` would have failed. **Fixed:** new test, X1 killed.
- Claims lens, MAJOR: the late dispose's async-rejection path was unguarded (X2 survived), and the "even
  synchronously" test name implied otherwise. **Fixed:** an async-rejecting late dispose is tested, the test
  is renamed, and X2 is killed.
- Claims lens, MAJOR: "stays off" / "never ran" in `contract.ts`, `CONTEXT.md` and `afterLateActivate`'s
  comment ignored that slash commands are not `running`-gated (#407), even after the late dispose.
  **Fixed** in all three places, and D6.
- Claims lens, MINOR, all **fixed**:
  - The `PLUGIN_IMPORT_TIMEOUT_MS` comment covered only a never-settling module, not a slow one, and didn't
    say the module's top-level side effects still run.
  - `loadPlugins`' "never ... holding up".
  - The contract's "outside a shutdown".
  - The `afterLateActivate` comment's "already says".
  - `PluginStateEntry.active` didn't mention the bound.
  - `index.ts`'s `loadPlugins` call was not pinned to pass no bound (now pinned, M28/M29).
- Claims lens, MINOR: `contract.ts` names `PLUGIN_ACTIVATE_TIMEOUT_MS`, which isn't in the vendored file.
  **Declined:** `TickCheck`'s doc already names `PLUGIN_TICK_TIMEOUT_MS` the same way, and both give the
  value ("currently 30 s").

## V2: the real boot on the debug instance (orchestrator, needs roshne's go-ahead)

This touches a live host: it deploys the PR branch to `debug` on `botbox`, edits two cached bundles in debug's
data volume and restarts it twice. Each edit is reversed from a backup taken first. On 2026-10-08 debug's
`state.json` listed `music` 1.6.0, `warbandeer` 1.3.0, `wow` 1.0.1 and `mcp` 0.3.0, in that order; re-read it
first and use the versions it shows. The plan makes `warbandeer` (second) hang on import and `wow` (third) hang
in `activate()`, so one plugin runs before the hung ones and one after. A cached bundle is reused with no
content check (`src/plugins/install.ts:238-242`), so the edits take effect on restart.

The bot process runs as `bun` (the container starts as root only to read the socket's group, then drops,
`docker-compose.yml:50-56`), so every file edit below runs `docker exec -u bun`, as `ops/README.md:61-62`
does, keeping the files bot-owned.

0. Record where debug stands. `bot-ops.sh` takes debug's identity the way `ops/README.md:637-640` shows for
   clerk:

   ```sh
   export BOT_OPS_CONFIG_DIR=/opt/rackbops-discord-bot/debug
   export BOT_OPS_COMPOSE_FILE=/opt/stacks/rackbops-discord-bot-debug/docker-compose.yml
   export BOT_OPS_PROJECT=rackbops-discord-bot-debug
   export BOT_OPS_CONTAINER=rackbops-discord-bot-debug
   bash /opt/rackbops-discord-bot/bin/bot-ops.sh env-get | grep -E '"(AUTO_UPDATE|BOT_BRANCH)"'
   docker exec rackbops-discord-bot-debug cat /app/data/plugins/state.json
   ```

   If `AUTO_UPDATE` is on, a `main` commit landing mid-test would read as `diverged` and redeploy `main` under
   the test (`src/update.ts:81-88`). So, as `install.sh`'s own next step 1 says, point `BOT_BRANCH` at the
   branch for the test (`printf 'BOT_BRANCH=<branch>\n' | bash /opt/rackbops-discord-bot/bin/bot-ops.sh env-set`)
   and back in step 5.
1. Deploy the branch. `install.sh` only refreshes the compose file, `bot-ops.sh` and the stack `.env`; it
   deliberately does not start anything (`ops/install.sh:44`, and its printed step 2, `:337-341`). So build
   and recreate the bot yourself, then check that the running image is the PR's head commit:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Rackbops/rackbops-discord-bot/<branch>/ops/install.sh | bash -s -- debug <branch>
   docker compose -f /opt/stacks/rackbops-discord-bot-debug/docker-compose.yml -p rackbops-discord-bot-debug up -d --build bot
   docker exec rackbops-discord-bot-debug printenv GIT_SHA   # must be the PR head sha (Dockerfile:18-19)
   ```

   Wait for all four plugins to come up `active: true` on the new image before planting anything.
2. Plant both hangs and restart:

   ```sh
   docker exec -u bun rackbops-discord-bot-debug sh -euc '
     w=/app/data/plugins/warbandeer/1.3.0/dist; cp "$w/plugin.js" "$w/plugin.js.bak-408"
     { printf "await new Promise(() => {});\n"; cat "$w/plugin.js.bak-408"; } > "$w/plugin.js"
     o=/app/data/plugins/wow/1.0.1/dist; cp "$o/plugin.js" "$o/plugin.js.bak-408"; cp "$o/plugin.js" "$o/plugin.real.js"
     printf "%s\n" "import * as real from \"./plugin.real.js\";" \
       "export function createPlugin(host) { return { ...real.createPlugin(host), activate: () => new Promise(() => {}) }; }" > "$o/plugin.js"'
   docker restart rackbops-discord-bot-debug
   ```

   (The auditor checked on Bun 1.4.2 that a top-level `await` placed before a bundle's `import` declarations
   is valid ESM, and that the spread keeps `wow`'s `commands` and `ticks`.)

3. After about a minute:

   ```sh
   docker logs --since "$(docker inspect -f '{{.State.StartedAt}}' rackbops-discord-bot-debug)" rackbops-discord-bot-debug 2>&1 \
     | grep -E 'Logged in as|\[plugins\]|\[release\]|Registered|\[startup\]'
   docker exec rackbops-discord-bot-debug cat /app/data/plugins/state.json
   ```

   Expect `Logged in as ...`, then `[plugins] warbandeer: import() did not finish within 10000ms`, then about
   30 s later `[plugins] wow failed to activate — the bot keeps running without it: activate() did not finish within 30000ms`,
   then the `[release]` line (`describeReleaseWatch`, printed just before `startScheduler`, `index.ts:313`) and
   a `Registered ...` line (`Registered N slash commands` in single mode, `index.ts:383`, or
   `Registered commands in N servers ...` in routed mode, `src/routing/live.ts:118-121`). In `state.json`, expect `music` and `mcp` with `active: true`; `warbandeer`
   `active: false` with the import error; `wow` `active: false` with the activate error; and all four
   `installedVersion`s unchanged.
4. Restore and restart, then confirm all four are `active: true` again:

   ```sh
   docker exec -u bun rackbops-discord-bot-debug sh -euc '
     w=/app/data/plugins/warbandeer/1.3.0/dist; mv "$w/plugin.js.bak-408" "$w/plugin.js"
     o=/app/data/plugins/wow/1.0.1/dist; mv "$o/plugin.js.bak-408" "$o/plugin.js"; rm "$o/plugin.real.js"'
   docker restart rackbops-discord-bot-debug
   ```

5. After the merge, put debug back on `main`: set `BOT_BRANCH` back to what step 0 recorded (if you changed
   it), then

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Rackbops/rackbops-discord-bot/main/ops/install.sh | bash -s -- debug
   docker compose -f /opt/stacks/rackbops-discord-bot-debug/docker-compose.yml -p rackbops-discord-bot-debug up -d --build bot
   docker exec rackbops-discord-bot-debug printenv GIT_SHA   # must be main's head
   ```

If roshne declines V2, A6 is named as unverified in the PR. Everything after `index.ts:301` is unchanged
straight-line code that `index.test.ts` pins in order, and V1 covers the real `import()` path; the gap is the
live gateway boot itself.

## Done means

- Steps 1, 3, 4 and 5 run, with their real output pasted.
- The gate cleared 2 of 3, with every evidenced finding fixed or declined in writing.
- CI green on both jobs.
- V2 pasted, or A6 named as unverified.
- The re-vendor PR in `rackbops-bot-plugins` opened after the merge.
- #408 ticked on #516.

## Appendix A -- the change (`git apply`-able, against `ded55f5`)

```diff
diff --git a/src/index.test.ts b/src/index.test.ts
index ff45d74..0416c6d 100644
--- a/src/index.test.ts
+++ b/src/index.test.ts
@@ -96,6 +96,16 @@ describe("index.ts wiring", () => {
     expect(startSched).toBeLessThan(restPut);
   });
 
+  // #408: boot passes neither call a bound of its own, so both take host.ts's defaults
+  // (PLUGIN_IMPORT_TIMEOUT_MS, PLUGIN_ACTIVATE_TIMEOUT_MS), which host.test.ts pins.
+  test("boot calls loadPlugins and activatePlugins with no bound of its own (#408)", () => {
+    const activateFn = source.indexOf("async function activate(");
+    const load = source.indexOf("await loadPlugins(", activateFn);
+    expect(load).toBeGreaterThan(activateFn);
+    expect(source.slice(load, source.indexOf(");", load))).toMatch(/,\s*console,\s*$/); // console is the last argument
+    expect(source.indexOf("await activatePlugins(loadResult.loaded, console);", activateFn)).toBeGreaterThan(activateFn);
+  });
+
   // #239: registration moved into src/routing/, but with no routing the bot must make EXACTLY the call
   // it always made. index.ts can't run under test, so the shape of the wiring is pinned in the source.
   describe("command registration is routed through src/routing (#239)", () => {
diff --git a/src/plugins/contract.ts b/src/plugins/contract.ts
index 0d0789d..4ac896b 100644
--- a/src/plugins/contract.ts
+++ b/src/plugins/contract.ts
@@ -195,9 +195,10 @@ export interface PluginStateEntry {
   /** Every env key the plugin expects is present. Enabled-but-unconfigured plugins still load. */
   configured: boolean;
   missingEnv: string[];
-  /** Loaded and `activate()` succeeded this boot. */
+  /** Loaded and `activate()` succeeded this boot, within the host's bound (#408). */
   active: boolean;
-  /** Why it is not active (unknown name, incompatible host API, download/integrity failure, a throw). */
+  /** Why it is not active (unknown name, incompatible host API, download/integrity failure, a throw, an
+   *  import or `activate()` that did not finish in time). */
   error?: string;
   /** Last version the admins were notified about. */
   notifiedVersion?: string;
@@ -385,14 +386,25 @@ export interface PluginHttpInfo {
 export interface Plugin {
   commands?: readonly PluginCommand[];
   ticks?: readonly TickCheck[];
-  /** Runs once, inside the bot's `activate()`, after `takeOver()`. All side effects (files, servers) belong here. */
+  /**
+   * Runs once, inside the bot's `activate()`, after `takeOver()`. All side effects (files, servers) belong here.
+   * The host waits on it for at most `PLUGIN_ACTIVATE_TIMEOUT_MS` (currently 30 s, #408). Past that the plugin
+   * is recorded as failed, the way a throw is, and stays off until the next restart; the call is not
+   * cancelled. If it resolves later, the host calls `dispose()` once to release what it set up; if it rejects
+   * later, the host only logs it. Until #407 lands, slash commands are the exception to "off": the host
+   * dispatches a plugin's commands whether or not it is running, including after that late `dispose()`,
+   * so a command handler must cope with state its `activate()` never finished setting up.
+   */
   activate?(): Promise<void>;
   /**
    * `activate()`'s counterpart (#184) — runs once, on the way out: a `docker stop`, a self-update's
    * retire, `SIGINT`. Release whatever `activate()` acquired here (servers, handles, timers). Must
    * not throw — the host isolates a throw and continues disposing the rest — and is bounded by the
    * host's own shutdown grace, so a slow or wedged `dispose` loses the remainder of its cleanup
-   * rather than delaying the process past the daemon's own SIGKILL. Optional: a plugin with nothing
+   * rather than delaying the process past the daemon's own SIGKILL. It also runs once, not through that
+   * shutdown path, as soon as an `activate()` the host had stopped waiting on resolves (#408): that plugin
+   * was never marked running, and nothing else would release what it set up. That call is isolated the
+   * same way but not bounded, since nothing waits on it. Optional: a plugin with nothing
    * to release (no servers, no long-lived handles) can omit it.
    */
   dispose?(): Promise<void>;
diff --git a/src/plugins/host.test.ts b/src/plugins/host.test.ts
index 4a6485b..33eb2d2 100644
--- a/src/plugins/host.test.ts
+++ b/src/plugins/host.test.ts
@@ -3,7 +3,7 @@ import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { ButtonStyle, SlashCommandBuilder, type MessageComponentInteraction } from "discord.js";
-import type { HostApi, HostStorage, Plugin, PluginCommand, PluginIndex, PluginIndexEntry, PluginModule, PluginStateFile } from "./contract";
+import type { HostApi, HostStorage, Plugin, PluginCommand, PluginIndex, PluginIndexEntry, PluginModule, PluginStateFile, TickCheck } from "./contract";
 import { installPlugins, type InstalledPlugin } from "./install";
 import type { HostDeliveryDeps, LoadedPlugin } from "./host";
 import { pinsFromState, selectPlugins } from "./registry";
@@ -16,6 +16,8 @@ import { settled } from "../../test/stateLeaks";
 const {
   createHostApi,
   loadPlugins,
+  PLUGIN_IMPORT_TIMEOUT_MS,
+  PLUGIN_ACTIVATE_TIMEOUT_MS,
   pluginCommandMap,
   buildCommandBody,
   autocompleteOptionPaths,
@@ -125,6 +127,14 @@ function loaded(e: PluginIndexEntry, plugin: Plugin, running = false): LoadedPlu
   return { entry: e, version: "1.0.0", plugin, running };
 }
 
+/** #408: `p`, or `"hung"` once 2 s pass without it settling -- so a regression that drops the import or
+ *  activate() bound fails by name rather than deadlocking into bun's own test timeout. */
+const orHung = <T>(p: Promise<T>): Promise<T | "hung"> => Promise.race([p, Bun.sleep(2_000).then(() => "hung" as const)]);
+
+/** #408: a value `String()` throws on ("No default value") -- plugin code can throw or reject with one, and
+ *  every isolating catch in host.ts must still describe it rather than throw again. */
+const unprintable = (): unknown => Object.create(null);
+
 const cmd = (name: string, build?: PluginCommand["build"]): PluginCommand => ({
   name,
   build: build ?? ((b) => b.setDescription(`the ${name} command`)),
@@ -630,6 +640,61 @@ describe("loadPlugins", () => {
       "[plugins] createboom: create failed",
     ]);
   });
+
+  test("an import that never settles is given up on after timeoutMs, and the bundles after it still load (#408)", async () => {
+    const { log, calls } = makeLog();
+    const installed: InstalledPlugin[] = [
+      { entry: entry({ name: "stuck" }), version: "1.0.0", bundlePath: "/stuck" },
+      { entry: entry({ name: "ok" }), version: "1.0.0", bundlePath: "/ok" },
+    ];
+    const importer = (path: string): Promise<PluginModule> =>
+      path === "/stuck" ? new Promise<PluginModule>(() => {}) : Promise.resolve({ createPlugin: () => ({ commands: [] }) });
+    const outcome = await orHung(loadPlugins(installed, makeHost, importer, log, 20));
+    if (outcome === "hung") throw new Error("loadPlugins never returned");
+    expect(outcome.loaded.map((l) => l.entry.name)).toEqual(["ok"]);
+    expect(outcome.errors).toEqual({ stuck: "import() did not finish within 20ms" });
+    expect(calls.filter((c) => c.level === "error").map((c) => c.message)).toEqual([
+      "[plugins] stuck: import() did not finish within 20ms",
+    ]);
+  });
+
+  test("an import that lands after the bound is dropped: createPlugin never runs for it (#408)", async () => {
+    let land: (mod: PluginModule) => void = () => {};
+    let created = 0;
+    const installed: InstalledPlugin[] = [{ entry: entry({ name: "late" }), version: "1.0.0", bundlePath: "/late" }];
+    const result = await orHung(loadPlugins(installed, makeHost, () => new Promise<PluginModule>((resolve) => (land = resolve)), makeLog().log, 20));
+    if (result === "hung") throw new Error("loadPlugins never returned");
+    land({ createPlugin: () => { created += 1; return { commands: [] }; } });
+    await Bun.sleep(0); // let anything still chained on the late import run
+    expect(created).toBe(0);
+    expect(result.loaded).toEqual([]);
+  });
+
+  test("an import that rejects with a value String() can't convert is still isolated, and the bundles after it still load (#408)", async () => {
+    const { log, calls } = makeLog();
+    const installed: InstalledPlugin[] = [
+      { entry: entry({ name: "odd" }), version: "1.0.0", bundlePath: "/odd" },
+      { entry: entry({ name: "ok" }), version: "1.0.0", bundlePath: "/ok" },
+    ];
+    const importer = (path: string): Promise<PluginModule> =>
+      path === "/odd" ? Promise.reject(unprintable()) : Promise.resolve({ createPlugin: () => ({ commands: [] }) });
+    const result = await loadPlugins(installed, makeHost, importer, log, 20);
+    expect(result.loaded.map((l) => l.entry.name)).toEqual(["ok"]);
+    expect(result.errors).toEqual({ odd: "(unprintable thrown value)" });
+    expect(calls.filter((c) => c.level === "error").map((c) => c.message)).toEqual(["[plugins] odd: (unprintable thrown value)"]);
+  });
+
+  test("real callers get PLUGIN_IMPORT_TIMEOUT_MS, 10 s (#408)", async () => {
+    expect(PLUGIN_IMPORT_TIMEOUT_MS).toBe(10_000);
+    const setSpy = spyOn(globalThis, "setTimeout");
+    try {
+      const installed: InstalledPlugin[] = [{ entry: entry({ name: "ok" }), version: "1.0.0", bundlePath: "/ok" }];
+      await loadPlugins(installed, makeHost, async () => ({ createPlugin: () => ({ commands: [] }) }), makeLog().log);
+      expect(setSpy.mock.calls.some((call) => call[1] === PLUGIN_IMPORT_TIMEOUT_MS)).toBe(true);
+    } finally {
+      setSpy.mockRestore();
+    }
+  });
 });
 
 describe("pluginCommandMap", () => {
@@ -655,6 +720,20 @@ describe("pluginCommandMap", () => {
     expect([...map.keys()]).toEqual(["hi"]); // bad skipped, good kept
     expect(calls.some((l) => l.level === "error" && l.message.includes("malformed commands"))).toBe(true);
   });
+
+  test("a commands getter that throws a value String() can't convert is skipped and logged, not thrown (#408)", () => {
+    const { log, calls } = makeLog();
+    const bad = loaded(entry({ name: "bad" }), { get commands(): readonly PluginCommand[] { throw unprintable(); } });
+    const good = loaded(entry({ name: "good" }), { commands: [cmd("hi")] });
+    let map: ReturnType<typeof pluginCommandMap> = new Map();
+    expect(() => {
+      map = pluginCommandMap([bad, good], [], log);
+    }).not.toThrow();
+    expect([...map.keys()]).toEqual(["hi"]);
+    expect(calls.filter((l) => l.level === "error").map((l) => l.message)).toEqual([
+      "[plugins] bad: ignoring malformed commands — (unprintable thrown value)",
+    ]);
+  });
 });
 
 describe("buildCommandBody", () => {
@@ -809,6 +888,20 @@ describe("pluginTicks", () => {
     expect(calls.some((l) => l.level === "error" && l.message.includes("malformed ticks"))).toBe(true);
   });
 
+  test("a ticks getter that throws a value String() can't convert is skipped and logged, not thrown (#408)", () => {
+    const { log, calls } = makeLog();
+    const bad = loaded(entry({ name: "bad" }), { get ticks(): readonly TickCheck[] { throw unprintable(); } });
+    const good = loaded(entry({ name: "good" }), { ticks: [{ name: "t", run: async () => {} }] });
+    let checks: ReturnType<typeof pluginTicks> = [];
+    expect(() => {
+      checks = pluginTicks([bad, good], log);
+    }).not.toThrow();
+    expect(checks.map((c) => c.name)).toEqual(["good:t"]);
+    expect(calls.filter((l) => l.level === "error").map((l) => l.message)).toEqual([
+      "[plugins] bad: ignoring malformed ticks — (unprintable thrown value)",
+    ]);
+  });
+
   // #217: `timeoutMs` (pluginTicks' third parameter) is the test seam, the same shape as
   // guardedTick's `watchdogMs`. The 2s `Bun.sleep` sentinel is what a regression that drops the
   // bound looks like -- a check that never settles -- surfaced as a plain "hung" assertion failure
@@ -1559,6 +1652,206 @@ describe("activatePlugins", () => {
     expect(lp2.error).toContain("boom");
     expect(lp3.running).toBe(true);
   });
+
+  // #408: an activate() the test settles by hand, after activatePlugins has stopped waiting on it.
+  const lateActivate = () => {
+    let resolve: () => void = () => {};
+    let reject: (err: unknown) => void = () => {};
+    const activate = () =>
+      new Promise<void>((res, rej) => {
+        resolve = res;
+        reject = rej;
+      });
+    return { activate, resolve: () => resolve(), reject: (err: unknown) => reject(err) };
+  };
+
+  test("an activate() that never settles is given up on after timeoutMs: the plugin stays off and the ones after it still activate (#408)", async () => {
+    const { log, calls } = makeLog();
+    const lp1 = loaded(entry({ name: "one" }), { activate: async () => {} });
+    const lp2 = loaded(entry({ name: "two" }), { activate: () => new Promise<void>(() => {}) });
+    const lp3 = loaded(entry({ name: "three" }), { activate: async () => {} });
+    expect(await orHung(activatePlugins([lp1, lp2, lp3], log, 20))).not.toBe("hung");
+    expect(lp1.running).toBe(true);
+    expect(lp2.running).toBe(false);
+    expect(lp2.error).toBe("activate() did not finish within 20ms");
+    expect(lp3.running).toBe(true);
+    expect(calls.filter((c) => c.level === "error").map((c) => c.message)).toEqual([
+      "[plugins] two failed to activate — the bot keeps running without it: activate() did not finish within 20ms",
+    ]);
+  });
+
+  // `activate` is optional, and plugin code is only type-asserted: no activate(), or one returning a plain
+  // value, must still come up -- what wrapping the call in Promise.resolve() is for.
+  test("a plugin with no activate(), or one that returns a plain value, is running (#408)", async () => {
+    const { log, calls } = makeLog();
+    const none = loaded(entry({ name: "none" }), { commands: [] });
+    const plain = loaded(entry({ name: "plain" }), { activate: (() => 1) as unknown as () => Promise<void> });
+    await activatePlugins([none, plain], log, 20);
+    expect([none.running, none.error, plain.running, plain.error]).toEqual([true, undefined, true, undefined]);
+    expect(calls).toEqual([]);
+  });
+
+  test("a synchronously-throwing activate is isolated the same as an async rejection", async () => {
+    const lp1 = loaded(entry({ name: "one" }), { activate: () => { throw new Error("sync boom"); } });
+    const lp2 = loaded(entry({ name: "two" }), { activate: async () => {} });
+    await activatePlugins([lp1, lp2], makeLog().log, 20);
+    expect(lp1.running).toBe(false);
+    expect(lp1.error).toBe("sync boom");
+    expect(lp2.running).toBe(true);
+  });
+
+  test("an activate() that finishes after the bound stays off, and is disposed once it does -- not before (#408)", async () => {
+    const { log, calls } = makeLog();
+    const late = lateActivate();
+    let disposed = 0;
+    const lp = loaded(entry({ name: "slow" }), { activate: late.activate, dispose: async () => { disposed += 1; } });
+    expect(await orHung(activatePlugins([lp], log, 20))).not.toBe("hung");
+    await Bun.sleep(0);
+    expect(disposed).toBe(0); // still activating: a dispose now could run before activate() sets anything up
+    late.resolve();
+    await Bun.sleep(0);
+    expect(disposed).toBe(1);
+    expect(lp.running).toBe(false);
+    expect(lp.error).toBe("activate() did not finish within 20ms"); // this boot's outcome is unchanged
+    expect(calls.filter((c) => c.level === "warn").map((c) => c.message)).toEqual([
+      "[plugins] slow finished activating after the 20ms bound — it stays off until the next restart; disposing what it set up",
+    ]);
+  });
+
+  test("an activate() that fails after the bound is logged and not disposed (#408)", async () => {
+    const { log, calls } = makeLog();
+    const late = lateActivate();
+    let disposed = 0;
+    const lp = loaded(entry({ name: "slow" }), { activate: late.activate, dispose: async () => { disposed += 1; } });
+    expect(await orHung(activatePlugins([lp], log, 20))).not.toBe("hung");
+    late.reject(new Error("late boom"));
+    await Bun.sleep(0);
+    expect(disposed).toBe(0);
+    expect(lp.running).toBe(false);
+    expect(calls.filter((c) => c.level === "warn").map((c) => c.message)).toEqual([
+      "[plugins] slow failed to activate after the 20ms bound: late boom",
+    ]);
+  });
+
+  test("a dispose() that throws synchronously after a late activate() is logged (#408)", async () => {
+    const { log, calls } = makeLog();
+    const late = lateActivate();
+    const lp = loaded(entry({ name: "slow" }), { activate: late.activate, dispose: () => { throw new Error("dispose blew up"); } });
+    expect(await orHung(activatePlugins([lp], log, 20))).not.toBe("hung");
+    late.resolve();
+    await Bun.sleep(0);
+    expect(calls.filter((c) => c.level === "error").map((c) => c.message)).toContain(
+      "[plugins] slow dispose failed — continuing: dispose blew up",
+    );
+  });
+
+  test("real callers get PLUGIN_ACTIVATE_TIMEOUT_MS, 30 s, the same bound as a tick (#408)", async () => {
+    expect(PLUGIN_ACTIVATE_TIMEOUT_MS).toBe(30_000);
+    expect(PLUGIN_ACTIVATE_TIMEOUT_MS).toBe(PLUGIN_TICK_TIMEOUT_MS);
+    const setSpy = spyOn(globalThis, "setTimeout");
+    try {
+      await activatePlugins([loaded(entry({ name: "ok" }), { activate: async () => {} })], makeLog().log);
+      expect(setSpy.mock.calls.some((call) => call[1] === PLUGIN_ACTIVATE_TIMEOUT_MS)).toBe(true);
+    } finally {
+      setSpy.mockRestore();
+    }
+  });
+
+  test("an activate() that throws a value String() can't convert is isolated, and the plugins after it still activate (#408)", async () => {
+    const { log, calls } = makeLog();
+    const lp1 = loaded(entry({ name: "odd" }), { activate: async () => { throw unprintable(); } });
+    const lp2 = loaded(entry({ name: "ok" }), { activate: async () => {} });
+    await activatePlugins([lp1, lp2], log, 20);
+    expect(lp1.running).toBe(false);
+    expect(lp1.error).toBe("(unprintable thrown value)");
+    expect(lp2.running).toBe(true);
+    expect(calls.filter((c) => c.level === "error").map((c) => c.message)).toEqual([
+      "[plugins] odd failed to activate — the bot keeps running without it: (unprintable thrown value)",
+    ]);
+  });
+
+  test("an activate() that rejects after the bound with a value String() can't convert is still logged (#408)", async () => {
+    const { log, calls } = makeLog();
+    const late = lateActivate();
+    const lp = loaded(entry({ name: "slow" }), { activate: late.activate });
+    await activatePlugins([lp], log, 20);
+    late.reject(unprintable());
+    await Bun.sleep(0);
+    expect(calls.filter((c) => c.level === "warn").map((c) => c.message)).toEqual([
+      "[plugins] slow failed to activate after the 20ms bound: (unprintable thrown value)",
+    ]);
+  });
+
+  test("a late dispose() that rejects with a value String() can't convert is still logged (#408)", async () => {
+    const { log, calls } = makeLog();
+    const late = lateActivate();
+    const lp = loaded(entry({ name: "slow" }), { activate: late.activate, dispose: () => Promise.reject(unprintable()) });
+    await activatePlugins([lp], log, 20);
+    late.resolve();
+    await Bun.sleep(0);
+    expect(calls.filter((c) => c.level === "error").map((c) => c.message)).toContain(
+      "[plugins] slow dispose failed — continuing: (unprintable thrown value)",
+    );
+  });
+
+  // afterLateActivate's comment promises its chain never ends in an unhandled rejection -- the process has
+  // no handler for one -- even if the logger itself throws. This is the test that reads that claim.
+  test("a late activate() whose log line throws leaves no unhandled rejection (#408)", async () => {
+    const unhandled: unknown[] = [];
+    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
+    process.on("unhandledRejection", onUnhandled);
+    try {
+      const throwingLog = { info: () => {}, warn: () => { throw new Error("log blew up"); }, error: () => {} };
+      const resolved = lateActivate();
+      const rejected = lateActivate();
+      const a = loaded(entry({ name: "a" }), { activate: resolved.activate });
+      const b = loaded(entry({ name: "b" }), { activate: rejected.activate });
+      await activatePlugins([a, b], throwingLog, 20);
+      resolved.resolve();
+      rejected.reject(new Error("late boom"));
+      await Bun.sleep(50); // past the microtask drain an unhandled rejection is reported after
+      expect(unhandled).toEqual([]);
+    } finally {
+      process.off("unhandledRejection", onUnhandled);
+    }
+  });
+});
+
+// #408, at the consumer boundary: what the boot writes to state.json for a plugin whose import or
+// activate() never settled -- the panel and `bot-ops.sh status` read `active` and `error` from there.
+describe("a plugin that never finishes loading or activating, through to state.json (#408)", () => {
+  test("is recorded active:false with the bound it missed as its error; the plugin after it is active", async () => {
+    const { log } = makeLog();
+    const names = ["stuck-import", "stuck-activate", "ok"];
+    const installed: InstalledPlugin[] = names.map((name) => ({ entry: entry({ name }), version: "1.0.0", bundlePath: `/${name}` }));
+    const importer = (path: string): Promise<PluginModule> => {
+      if (path === "/stuck-import") return new Promise<PluginModule>(() => {});
+      const activate = path === "/stuck-activate" ? () => new Promise<void>(() => {}) : async () => {};
+      return Promise.resolve({ createPlugin: () => ({ activate }) });
+    };
+    const makeHost = (e: PluginIndexEntry): HostApi =>
+      createHostApi({ entry: e, processEnv: {}, dataDir: "/d", baseLog: log, storage: realStorage, announce: async () => {} });
+    const load = await orHung(loadPlugins(installed, makeHost, importer, log, 20));
+    if (load === "hung") throw new Error("loadPlugins never returned");
+    const { loaded: loadedPlugins, errors } = load;
+    expect(await orHung(activatePlugins(loadedPlugins, log, 20))).not.toBe("hung");
+    const state = buildPluginStateFile({
+      selected: installed.map((i) => ({ name: i.entry.name, entry: i.entry })),
+      installed,
+      installSkips: {},
+      fallbacks: {},
+      loaded: loadedPlugins,
+      loadErrors: errors,
+      processEnv: {},
+      previous: { hostApiVersion: 1, writtenAt: "", plugins: [] },
+      now: new Date("2026-10-08T00:00:00.000Z"),
+    });
+    expect(state.plugins.map((p) => ({ name: p.name, active: p.active, error: p.error }))).toEqual([
+      { name: "stuck-import", active: false, error: "import() did not finish within 20ms" },
+      { name: "stuck-activate", active: false, error: "activate() did not finish within 20ms" },
+      { name: "ok", active: true, error: undefined },
+    ]);
+  });
 });
 
 describe("routeInteractionByPrefix", () => {
@@ -1792,6 +2085,16 @@ describe("disposePlugins (#184)", () => {
     expect(calls.some((c) => c.level === "error" && c.message.includes("sync-boom"))).toBe(true);
   });
 
+  test("a dispose that rejects with a value String() can't convert is still logged (#408)", async () => {
+    const { log, calls } = makeLog();
+    const odd = loaded(entry({ name: "odd" }), { dispose: () => Promise.reject(unprintable()) }, true);
+    await disposePlugins([odd], log, 50);
+    expect(odd.running).toBe(false);
+    expect(calls.filter((c) => c.level === "error").map((c) => c.message)).toEqual([
+      "[plugins] odd dispose failed — continuing: (unprintable thrown value)",
+    ]);
+  });
+
   // The mutation this guards: dropping the per-plugin timeout entirely, which would leave this test
   // hanging on a dispose() that never resolves on its own.
   test("a dispose that never resolves is bounded by the per-plugin timeout", async () => {
diff --git a/src/plugins/host.ts b/src/plugins/host.ts
index 75c9435..1534249 100644
--- a/src/plugins/host.ts
+++ b/src/plugins/host.ts
@@ -41,9 +41,9 @@ export interface LoadedPlugin {
   entry: PluginIndexEntry;
   version: string;
   plugin: Plugin;
-  /** Flipped true by activatePlugins once activate() resolves; gates this plugin's ticks. */
+  /** Flipped true by activatePlugins once activate() resolves within its bound; gates this plugin's ticks. */
   running: boolean;
-  /** Set if activate() threw. */
+  /** Set if activate() threw or did not finish within its bound (#408). */
   error?: string;
 }
 
@@ -198,32 +198,57 @@ function refuseUnanswerableButtons(message: unknown, deps: HostDeliveryDeps): vo
   }
 }
 
+/** What a plugin threw or rejected with, as text for a log line or `state.json`, never itself throwing.
+ *  Plugin code is only type-asserted, so it can throw anything — including a value `String()` can't
+ *  convert (`Object.create(null)`) or an Error whose `message` getter throws — and an isolating catch
+ *  that threw while describing it would end the isolation it exists for (#408). */
+const UNPRINTABLE_THROWN = "(unprintable thrown value)";
+function describeThrown(err: unknown): string {
+  try {
+    return String(err instanceof Error ? err.message : err);
+  } catch {
+    return UNPRINTABLE_THROWN;
+  }
+}
+
 export interface LoadResult {
   loaded: LoadedPlugin[];
-  /** name -> reason, for bundles whose import or createPlugin threw. */
+  /** name -> reason, for bundles whose import failed or did not finish in time, or whose createPlugin threw. */
   errors: Record<string, string>;
 }
 
+/** The most `loadPlugins` waits on one bundle's `import()` (#408) before it records that bundle as
+ *  failed and moves on to the next. A bundle is a local file, so in practice only a module whose
+ *  top-level `await` is that slow, or never settles, gets here. The import is not cancelled: whatever
+ *  the module's own top level does still runs, but if it lands later it is dropped, and `createPlugin`
+ *  never runs for it. */
+export const PLUGIN_IMPORT_TIMEOUT_MS = 10_000;
+
 /**
  * Imports each installed bundle and runs its `createPlugin(host)` — pure, no side effects yet
- * (those are `activate()`). A rejecting import or a throwing `createPlugin` is isolated: that
- * plugin is recorded in `errors` and left out of `loaded`, never crashing the others or the bot.
+ * (those are `activate()`). A rejecting import, one still unsettled after `timeoutMs` (#408, see
+ * PLUGIN_IMPORT_TIMEOUT_MS), or a throwing `createPlugin` is isolated: that plugin is recorded in
+ * `errors` and left out of `loaded`, never crashing the others or the bot, and holding them up by
+ * `timeoutMs` at most.
+ * `timeoutMs` is the test seam, like `pluginTicks`': real callers take the default.
  */
 export async function loadPlugins(
   installed: readonly InstalledPlugin[],
   makeHost: (entry: PluginIndexEntry) => HostApi,
   importer: (bundlePath: string) => Promise<PluginModule>,
   log: BaseLog,
+  timeoutMs = PLUGIN_IMPORT_TIMEOUT_MS,
 ): Promise<LoadResult> {
   const loaded: LoadedPlugin[] = [];
   const errors: Record<string, string> = {};
   for (const { entry, version, bundlePath } of installed) {
     try {
-      const mod = await importer(bundlePath);
+      const mod = await within<PluginModule | typeof TIMED_OUT>(importer(bundlePath), timeoutMs, TIMED_OUT);
+      if (mod === TIMED_OUT) throw new Error(`import() did not finish within ${timeoutMs}ms`);
       const plugin = mod.createPlugin(makeHost(entry));
       loaded.push({ entry, version, plugin, running: false });
     } catch (err) {
-      const message = err instanceof Error ? err.message : String(err);
+      const message = describeThrown(err);
       errors[entry.name] = message;
       log.error(`[plugins] ${entry.name}: ${message}`);
     }
@@ -258,7 +283,7 @@ export function pluginCommandMap(
         map.set(command.name, { entry, command });
       }
     } catch (err) {
-      log.error(`[plugins] ${entry.name}: ignoring malformed commands — ${err instanceof Error ? err.message : String(err)}`);
+      log.error(`[plugins] ${entry.name}: ignoring malformed commands — ${describeThrown(err)}`);
     }
   }
   return map;
@@ -531,26 +556,75 @@ export function pluginTicks(
         });
       }
     } catch (err) {
-      log.error(`[plugins] ${lp.entry.name}: ignoring malformed ticks — ${err instanceof Error ? err.message : String(err)}`);
+      log.error(`[plugins] ${lp.entry.name}: ignoring malformed ticks — ${describeThrown(err)}`);
     }
   }
   return checks;
 }
 
-/** Runs each plugin's `activate()` in order, isolated: a throw is recorded and logged, the plugin
- * left not-running, and the rest (and the bot) carry on. Mutates each LoadedPlugin in place. */
-export async function activatePlugins(loaded: readonly LoadedPlugin[], log: BaseLog): Promise<void> {
+/** The most `activatePlugins` waits on one plugin's `activate()` (#408) before it records that plugin
+ *  as failed and moves on, as for a throw. index.ts awaits `activatePlugins` before the scheduler, the
+ *  HTTP listener, routing and the boot state write, so without a bound one `activate()` that never
+ *  settled held all of them, and every plugin after it, for good. The same 30 s as `PLUGIN_TICK_TIMEOUT_MS`.
+ *  Activation stays sequential, so N wedged plugins delay boot by N times this, never forever. */
+export const PLUGIN_ACTIVATE_TIMEOUT_MS = 30_000;
+
+/** Runs each plugin's `activate()` in order, isolated: a throw, or one still unsettled after `timeoutMs`
+ * (#408, see PLUGIN_ACTIVATE_TIMEOUT_MS), is recorded and logged, the plugin left not-running, and the
+ * rest (and the bot) carry on — see `afterLateActivate` for one that settles after that. Mutates each
+ * LoadedPlugin in place. `timeoutMs` is the test seam, like `pluginTicks`': real callers take the default. */
+export async function activatePlugins(
+  loaded: readonly LoadedPlugin[],
+  log: BaseLog,
+  timeoutMs = PLUGIN_ACTIVATE_TIMEOUT_MS,
+): Promise<void> {
   for (const lp of loaded) {
     try {
-      await lp.plugin.activate?.();
+      // A sync throw (or a throwing getter) lands in the catch below, as before.
+      const call = Promise.resolve(lp.plugin.activate?.());
+      if ((await within<unknown>(call, timeoutMs, TIMED_OUT)) === TIMED_OUT) {
+        afterLateActivate(lp, call, timeoutMs, log);
+        throw new Error(`activate() did not finish within ${timeoutMs}ms`);
+      }
       lp.running = true;
     } catch (err) {
-      lp.error = err instanceof Error ? err.message : String(err);
+      lp.error = describeThrown(err);
       log.error(`[plugins] ${lp.entry.name} failed to activate — the bot keeps running without it: ${lp.error}`);
     }
   }
 }
 
+/**
+ * #408: what happens to an `activate()` that `activatePlugins` stopped waiting on, once it does settle.
+ * The plugin stays off either way: `running` is never set, so its ticks, HTTP routes and component, modal
+ * and autocomplete handlers stay gated off, and this boot's state.json records it as not active — a
+ * plugin flipping on mid-life would contradict what the panel shows. (Its slash commands are the
+ * exception: they are not `running`-gated until #407 lands, so they keep dispatching, even after the
+ * dispose below.) A RESOLVE means `activate()` may have set things up (a server, timers, a database
+ * handle) that `disposePlugins` will never release, since it disposes only running plugins, so its
+ * `dispose()` runs now, isolated like every other plugin call (a throw, sync or async, is logged).
+ * Nothing awaits it, so it is not bounded. A
+ * REJECTION is only logged: a plugin whose `activate()` failed has nothing `dispose()` could safely
+ * release, as for a throw inside the bound. Nothing awaits this chain either, and the process has no
+ * `unhandledRejection` handler, so it ends in a catch that drops whatever is left.
+ */
+function afterLateActivate(lp: LoadedPlugin, call: Promise<unknown>, timeoutMs: number, log: BaseLog): void {
+  const name = lp.entry.name;
+  call
+    .then(
+      () => {
+        log.warn(`[plugins] ${name} finished activating after the ${timeoutMs}ms bound — it stays off until the next restart; disposing what it set up`);
+        return Promise.resolve()
+          .then(() => lp.plugin.dispose?.())
+          .catch((err: unknown) => log.error(`[plugins] ${name} dispose failed — continuing: ${describeThrown(err)}`));
+      },
+      (err: unknown) => log.warn(`[plugins] ${name} failed to activate after the ${timeoutMs}ms bound: ${describeThrown(err)}`),
+    )
+    .catch(() => {
+      // Only a throw from `log` itself reaches here, and there is nowhere left to report it.
+    });
+}
+
 /** The most one plugin's `dispose()` gets (#184) — a server close or a handle release is normally
  *  near-instant; this exists only so one wedged plugin can't consume the whole shutdown grace and
  *  starve every other plugin's own dispose. `shutdown.ts` separately bounds the WHOLE
@@ -590,7 +664,7 @@ export async function disposePlugins(loaded: readonly LoadedPlugin[], log: BaseL
           new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
         ]);
       } catch (err) {
-        log.error(`[plugins] ${lp.entry.name} dispose failed — continuing: ${err instanceof Error ? err.message : String(err)}`);
+        log.error(`[plugins] ${lp.entry.name} dispose failed — continuing: ${describeThrown(err)}`);
       } finally {
         lp.running = false;
       }
```

## Appendix B -- `acceptance-408.ts`

```ts
// #408 acceptance: real on-disk bundles, loaded through the host's own loadPlugins/activatePlugins with the
// importer src/index.ts uses, then the state.json the boot would write. Not a committed test: it exists to
// show the real dynamic import() path, which the unit tests replace with a fake importer.
//
//   bun acceptance-408.ts <repo-root>             small bounds (200 ms import, 300 ms activate)
//   bun acceptance-408.ts <repo-root> --defaults  no bounds passed: the defaults real callers get
//
// Phase A: [hang-import, ok] through loadPlugins.  Phase B: [hang-activate, ok] through loadPlugins +
// activatePlugins.  Phase C (only if A and B returned): all three, then writePluginState, printed.
// Exit 0 only when every phase returned; a phase still pending at the sentinel is the #408 stall.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
if (repo === undefined) {
  console.error("usage: bun acceptance-408.ts <repo-root> [--defaults]");
  process.exit(2);
}
const useDefaults = process.argv.includes("--defaults");
const work = mkdtempSync(join(tmpdir(), "acceptance-408-"));
const dataDir = join(work, "data");
mkdirSync(dataDir, { recursive: true });
process.env.BOT_DATA_DIR = dataDir;
process.env.DISCORD_TOKEN ??= "acceptance-token";
process.env.ANNOUNCE_CHANNEL_ID ??= "100";

const host = await import(pathToFileURL(join(repo, "src/plugins/host.ts")).href);
const s = await import(pathToFileURL(join(repo, "src/storage.ts")).href);
const storage = {
  readJsonOrFresh: s.readJsonOrFresh,
  writeJsonAtomic: s.writeJsonAtomic,
  createJsonWriter: s.createJsonWriter,
  createKeyedJsonMutator: s.createKeyedJsonMutator,
};

const SOURCES: Record<string, string> = {
  "hang-import": "await new Promise(() => {});\nexport function createPlugin() { return {}; }\n",
  "hang-activate": "export function createPlugin() { return { activate: () => new Promise(() => {}) }; }\n",
  ok: "export function createPlugin(host) { return { async activate() { host.log.info('activated'); } }; }\n",
};
const entry = (name: string) => ({
  name,
  package: `@acceptance/${name}`,
  version: "1.0.0",
  description: "d",
  hostApiVersion: 1,
  intents: [],
  commands: [],
  env: [],
  releases: [],
});
// A fresh file per phase: a module that already settled (or is still pending) is cached by URL.
let n = 0;
const install = (names: string[]) =>
  names.map((name) => {
    const dir = join(work, "bundles", `${name}-${n++}`);
    mkdirSync(dir, { recursive: true });
    const bundlePath = join(dir, "plugin.js");
    writeFileSync(bundlePath, SOURCES[name]!);
    return { entry: entry(name), version: "1.0.0", bundlePath };
  });
const makeHost = (e: ReturnType<typeof entry>) =>
  host.createHostApi({ entry: e, processEnv: {}, dataDir, baseLog: console, storage, announce: async () => {} });
// The importer src/index.ts passes to loadPlugins.
const importer = async (bundlePath: string) => await import(pathToFileURL(bundlePath).href);

const IMPORT_MS = 200;
const ACTIVATE_MS = 300;
const SENTINEL_MS = useDefaults ? 60_000 : 3_000;
const PENDING = Symbol("pending");
const orStall = <T>(p: Promise<T>) =>
  Promise.race([p, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), SENTINEL_MS))]);
const load = (installed: ReturnType<typeof install>) =>
  useDefaults
    ? host.loadPlugins(installed, makeHost, importer, console)
    : host.loadPlugins(installed, makeHost, importer, console, IMPORT_MS);
const activate = (loaded: unknown[]) =>
  useDefaults ? host.activatePlugins(loaded, console) : host.activatePlugins(loaded, console, ACTIVATE_MS);

console.log(`bun ${Bun.version}, ${useDefaults ? "default bounds" : `bounds ${IMPORT_MS}/${ACTIVATE_MS}ms`}`);
let stalled = false;

let t = Date.now();
const a = await orStall(load(install(["hang-import", "ok"])));
if (a === PENDING) {
  stalled = true;
  console.log(`A  loadPlugins: STILL PENDING after ${SENTINEL_MS}ms -- boot stalls here`);
} else {
  console.log(`A  loadPlugins returned after ${Date.now() - t}ms: loaded=${JSON.stringify(a.loaded.map((l: { entry: { name: string } }) => l.entry.name))} errors=${JSON.stringify(a.errors)}`);
}

const b = await load(install(["hang-activate", "ok"]));
t = Date.now();
const bOutcome = await orStall(activate(b.loaded));
const shape = (loaded: { entry: { name: string }; running: boolean; error?: string }[]) =>
  JSON.stringify(loaded.map((l) => ({ name: l.entry.name, running: l.running, error: l.error })));
if (bOutcome === PENDING) {
  stalled = true;
  console.log(`B  activatePlugins: STILL PENDING after ${SENTINEL_MS}ms -- boot stalls here; ${shape(b.loaded)}`);
} else {
  console.log(`B  activatePlugins returned after ${Date.now() - t}ms: ${shape(b.loaded)}`);
}

if (stalled) {
  console.log("C  skipped: a phase above stalled");
  process.exit(1);
}

t = Date.now();
const installed = install(["hang-import", "hang-activate", "ok"]);
const c = await load(installed);
await activate(c.loaded);
const selected = installed.map((i) => ({ name: i.entry.name, entry: i.entry }));
await host.writePluginState({
  dataDir,
  storage,
  selected,
  installed,
  installSkips: {},
  fallbacks: {},
  loaded: c.loaded,
  loadErrors: c.errors,
  processEnv: {},
  previous: { hostApiVersion: 1, writtenAt: "", plugins: [] },
  now: () => new Date(),
});
console.log(`C  load + activate + state write took ${Date.now() - t}ms; ${join(dataDir, "plugins", "state.json")}:`);
console.log(readFileSync(join(dataDir, "plugins", "state.json"), "utf8"));
process.exit(0);
```

## Appendix C -- `mutate-408.ts`

```ts
// Mutation check for #408's changed lines: apply one mutation to src/plugins/host.ts (or src/index.ts) in a
// scratch worktree, run host.test.ts and index.test.ts, record whether the run FAILED (it must), restore.
// Usage: bun mutate-408.ts <worktree>    Never point it at a tree anything else is reading.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const wt = process.argv[2]!;
const HOST = "src/plugins/host.ts";
const INDEX = "src/index.ts";
const originals = new Map([HOST, INDEX].map((f) => [f, readFileSync(join(wt, f), "utf8")]));

const OLD_DESCRIBE = "err instanceof Error ? err.message : String(err)";
const mutations: { id: string; from: string; to: string; file?: string }[] = [
  { id: "M1 import unbounded", from: "await within<PluginModule | typeof TIMED_OUT>(importer(bundlePath), timeoutMs, TIMED_OUT)", to: "await importer(bundlePath)" },
  { id: "M2 drop TIMED_OUT check on import", from: "      if (mod === TIMED_OUT) throw new Error(`import() did not finish within ${timeoutMs}ms`);\n", to: "" },
  { id: "M3 import default bound", from: "  timeoutMs = PLUGIN_IMPORT_TIMEOUT_MS,", to: "  timeoutMs = 5_000," },
  { id: "M4 import constant", from: "PLUGIN_IMPORT_TIMEOUT_MS = 10_000", to: "PLUGIN_IMPORT_TIMEOUT_MS = 20_000" },
  { id: "M5 activate unbounded", from: "if ((await within<unknown>(call, timeoutMs, TIMED_OUT)) === TIMED_OUT) {", to: "if ((await call) === TIMED_OUT) {" },
  { id: "M6 activate never called", from: "const call = Promise.resolve(lp.plugin.activate?.());", to: "const call = Promise.resolve();" },
  { id: "M7 no late handling", from: "        afterLateActivate(lp, call, timeoutMs, log);\n", to: "" },
  { id: "M8 timed-out plugin marked running", from: "        throw new Error(`activate() did not finish within ${timeoutMs}ms`);", to: "        lp.running = true; continue;" },
  { id: "M9 activate default bound", from: "  timeoutMs = PLUGIN_ACTIVATE_TIMEOUT_MS,", to: "  timeoutMs = 5_000," },
  { id: "M10 activate constant", from: "PLUGIN_ACTIVATE_TIMEOUT_MS = 30_000", to: "PLUGIN_ACTIVATE_TIMEOUT_MS = 60_000" },
  { id: "M11 late resolve not disposed", from: "          .then(() => lp.plugin.dispose?.())", to: "          .then(() => undefined)" },
  { id: "M12 late resolve flips running", from: "      () => {\n        log.warn(`[plugins] ${name} finished activating", to: "      () => {\n        lp.running = true;\n        log.warn(`[plugins] ${name} finished activating" },
  { id: "M13 late reject disposed too", from: "      (err: unknown) => log.warn(`[plugins] ${name} failed to activate after", to: "      (err: unknown) => void lp.plugin.dispose?.() ?? log.warn(`[plugins] ${name} failed to activate after" },
  { id: "M14 late dispose uncaught", from: "          .catch((err: unknown) => log.error(`[plugins] ${name} dispose failed — continuing: ${describeThrown(err)}`));", to: ";" },
  { id: "M15 sync dispose throw escapes", from: "        return Promise.resolve()\n          .then(() => lp.plugin.dispose?.())", to: "        return Promise.resolve(lp.plugin.dispose?.())" },
  { id: "M16 disposed at the timeout, not when activate lands", from: "  const name = lp.entry.name;\n  call\n", to: "  void Promise.resolve().then(() => lp.plugin.dispose?.()).catch(() => {});\n  const name = lp.entry.name;\n  call\n" },
  { id: "M17 late reject unhandled", from: "      (err: unknown) => log.warn(`[plugins] ${name} failed to activate after the ${timeoutMs}ms bound: ${describeThrown(err)}`),\n", to: "" },
  { id: "M18 activate called outside the try", from: "  for (const lp of loaded) {\n    try {\n      // A sync throw (or a throwing getter) lands in the catch below, as before.\n      const call = Promise.resolve(lp.plugin.activate?.());\n", to: "  for (const lp of loaded) {\n    const call = Promise.resolve(lp.plugin.activate?.());\n    try {\n" },
  // Round 1 of the review gate: describeThrown, its six call sites, the late chain's terminal catch, and the two
  // lines reviewer 2 found unguarded (X1, X2).
  { id: "M19 describeThrown can throw", from: "  try {\n    return String(err instanceof Error ? err.message : err);\n  } catch {\n    return UNPRINTABLE_THROWN;\n  }", to: `  return ${OLD_DESCRIBE};` },
  { id: "M20 loadPlugins catch", from: "      const message = describeThrown(err);", to: `      const message = ${OLD_DESCRIBE};` },
  { id: "M21 pluginCommandMap catch", from: "ignoring malformed commands — ${describeThrown(err)}", to: `ignoring malformed commands — \${${OLD_DESCRIBE}}` },
  { id: "M22 pluginTicks catch", from: "ignoring malformed ticks — ${describeThrown(err)}", to: `ignoring malformed ticks — \${${OLD_DESCRIBE}}` },
  { id: "M23 activatePlugins catch", from: "      lp.error = describeThrown(err);", to: `      lp.error = ${OLD_DESCRIBE};` },
  { id: "M24 late reject describe", from: "bound: ${describeThrown(err)}`),", to: `bound: \${${OLD_DESCRIBE}}\`),` },
  { id: "M25 late dispose describe", from: "${name} dispose failed — continuing: ${describeThrown(err)}", to: `\${name} dispose failed — continuing: \${${OLD_DESCRIBE}}` },
  { id: "M26 disposePlugins catch", from: "${lp.entry.name} dispose failed — continuing: ${describeThrown(err)}", to: `\${lp.entry.name} dispose failed — continuing: \${${OLD_DESCRIBE}}` },
  { id: "M27 late chain has no terminal catch", from: "    )\n    .catch(() => {\n      // Only a throw from `log` itself reaches here, and there is nowhere left to report it.\n    });", to: "    );" },
  { id: "X1 activate result not wrapped", from: "const call = Promise.resolve(lp.plugin.activate?.());", to: "const call = lp.plugin.activate?.() as Promise<unknown>;" },
  { id: "X2 late dispose not chained", from: "          .then(() => lp.plugin.dispose?.())", to: "          .then(() => { void lp.plugin.dispose?.(); })" },
  { id: "M28 boot passes loadPlugins a bound", file: INDEX, from: "      console,\n    );\n    // #184: visible", to: "      console,\n      5,\n    );\n    // #184: visible" },
  { id: "M29 boot passes activatePlugins a bound", file: INDEX, from: "await activatePlugins(loadResult.loaded, console);", to: "await activatePlugins(loadResult.loaded, console, 5);" },
];

let survivors = 0;
try {
  for (const m of mutations) {
    const file = m.file ?? HOST;
    const original = originals.get(file)!;
    if (original.split(m.from).length !== 2) {
      console.log(`?? ${m.id}: anchor not found exactly once in ${file}`);
      survivors += 1;
      continue;
    }
    writeFileSync(join(wt, file), original.replace(m.from, () => m.to));
    const proc = Bun.spawnSync(["bun", "test", "src/plugins/host.test.ts", "src/index.test.ts", "--timeout", "10000"], { cwd: wt, stdout: "pipe", stderr: "pipe" });
    const out = proc.stdout.toString() + proc.stderr.toString();
    const fails = out.split("\n").filter((l) => l.includes("(fail)")).map((l) => l.trim().replace(/^\(fail\) /, ""));
    const summary = out.match(/(\d+) fail/)?.[0] ?? "?";
    const killed = proc.exitCode !== 0;
    if (!killed) survivors += 1;
    console.log(`${killed ? "KILLED " : "SURVIVED"} ${m.id} (exit ${proc.exitCode}, ${summary})`);
    for (const f of fails.slice(0, 4)) console.log(`         - ${f}`);
    if (fails.length === 0 && killed) console.log(`         ${out.split("\n").filter((l) => /error|Unhandled/i.test(l)).slice(0, 2).join(" | ")}`);
    writeFileSync(join(wt, file), original);
  }
} finally {
  for (const [file, original] of originals) writeFileSync(join(wt, file), original);
}
console.log(`${mutations.length} mutations, ${survivors} survived`);
process.exit(survivors === 0 ? 0 : 1);
```
