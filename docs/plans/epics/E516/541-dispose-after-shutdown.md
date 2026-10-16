<!-- Plan for #541 (Rackbops/rackbops-discord-bot; a standalone bug beside Epic #516, found in the review of #534).
Written by the orchestrating session on 2026-10-16 against `main` @ `691de28`; audited read-only against that tree
before it was committed (8 findings, all applied — the two that changed the design: the shutdown must WAIT for the
activation in flight, bounded, or the late dispose is cut off by `exit(0)`; and `activate()` must stop after the loop
when a shutdown is in progress, or the boot consumes the pending update report with a false failure). Every file:line
below was read from that tree; the implementer re-reads each one on the tree it works from and corrects any that moved. -->

## Implementation plan -- #541: a shutdown during plugin activation waits for the plugin in flight, disposes it, and activates none after it

Child: **#541** (effort S, now M with the two design changes). One PR. A behaviour change in the plugin
host's activation loop and in `index.ts`'s `activate()`, so the **three-reviewer gate** applies; every
changed line mutation-tested in a scratch worktree. Independent of the bundles in flight: R1 (#530) edits
`src/plugins/host.ts` at `:100`, `:836` and `:937` and `index.ts`'s interaction handler and shutdown
wiring; S3a/S3b-2 edit `index.ts`'s boot and ready wiring; none touches `activatePlugins`,
`disposePlugins` or `activate()`'s plugin section (`index.ts:317`). Branch from `origin/main` now; if R1
lands first, re-anchor `index.ts`.

### What is wrong, verified at `691de28`

`activatePlugins` (`src/plugins/host.ts:680-699`) activates the plugins one at a time; `index.ts:317`
awaits it inside `activate()`, and `currentLoadedPlugins` (the list the shutdown handler disposes) is set
before activation starts. `disposePlugins` (`:761-776`) flips `running` false (`:763`) and disposes only
the plugins that are `running` when it is called. Nothing in the loop checks for a shutdown. `activate()`
runs in no critical section (the only `withCritical`/`beginCritical` sites are `announce.ts:301`,
`commands.ts:112`/`:268`, `index.ts:324`/`:378`), so on a SIGTERM during activation `awaitCriticalIdle`
resolves at once, `disposePlugins` runs within a millisecond (`shutdown.ts:139`), then `destroyClient`
(up to 2 s) and `exit(0)`. Two things go wrong:

- The plugin whose `activate()` is pending becomes `running` when it settles (`:693`) — if it settles
  before the exit — and every plugin after it is activated too; none of them is disposed before
  `exit(0)`. Whatever `activate()` set up (a listener, timers, a handle, unflushed writes) is dropped by
  the exit. One still pending at the exit is never disposed either. `afterLateActivate` (`:713-728`) already
  handles the timed-out case: a resolve after the bound disposes what was set up and leaves the plugin off.
- `activate()` carries on after the loop (`index.ts:317-485`): it writes `state.json`, drains the mailbox,
  binds HTTP and starts `reportPluginUpdateOutcome`, which deletes `pendingReport` (`updates.ts:684-694`)
  and reports on the entry's state. So a SIGTERM during the boot after a plugin update would, with any
  "do not activate the rest" fix alone, consume the owed report with a false "failed to start".

### Decisions (defaults, named so the gate can contest them)

1. **A module-level `disposing` flag, set synchronously as `disposePlugins`' first statement** (before the
   `running` flip at `:763`), never cleared in production (a process disposes once, on the way out), cleared
   by a flag-only `resetPluginDisposingForTest()` that `resetPluginHostForTest` (`:1259`) also calls, and
   reported by `pluginHostStateForTest`/`pluginHostLeaks` as guarded state. The flag-only reset exists
   because `CONTEXT.md:479-486` forbids tests from calling `resetPluginHostForTest()` as cleanup (it replaces
   the write queue and would hide a leaked write); the thirteen existing tests that call `disposePlugins`
   (`host.test.ts:2452-2698`) and the new ones use the flag-only reset in an `afterEach`.
2. **`activatePlugins` checks the flag twice per plugin:** before starting a plugin's `activate()` (a
   shutdown already began: `error = "shutdown began before activate() ran"`, one `warn` line, no call,
   `continue`) and after a plugin's `activate()` settled inside the bound (a shutdown began while it ran:
   `error = "shutdown began during activate()"`, one `warn` line, dispose what it set up — AWAITED, bounded
   by `PLUGIN_DISPOSE_TIMEOUT_MS`, isolated like every other plugin call — leave `running` false,
   `continue`). `afterLateActivate` is unchanged: a plugin that timed out and resolves later is disposed
   there, exactly once (the loop's post-settle check is unreachable on that path).
3. **The shutdown waits for the activation in flight, bounded.** `activatePlugins` publishes its own run
   as a module-level `activation: Promise<void>` (settled, never rejecting; a resolved promise when no
   activation has run). `disposePlugins`, after disposing the running plugins, awaits
   `Promise.race([activation, sleep(timeoutMs)])`: the loop sees the flag when the pending `activate()`
   settles, disposes that plugin (bounded) and refuses the rest, and `disposePlugins` returns once that
   has happened or its bound has passed. So the late dispose is no longer "unawaited and cut off by
   `exit(0)`": within `shutdown.ts`'s own outer bound on `disposePlugins` (`:135-137`), the shutdown exits
   after the in-flight plugin's dispose. An `activate()` that takes longer than the bound is given up on
   like a wedged dispose; the PR says so.
4. **`activate()` stops after the loop when a shutdown is in progress.** `index.ts`, right after
   `await activatePlugins(...)` (`:317`): `if (restartPending()) { console.warn("[plugins] shutdown in
   progress — the rest of activation is skipped"); return; }` (`restartPending()` folds `shuttingDown`,
   `restart.ts:229-231`). No `state.json` write (the previous boot's file stands), no mailbox drain, no
   HTTP bind, no report-back: `pendingReport` survives to the next boot, which reports truthfully. The
   loop keeps iterating rather than `break`ing, so every remaining plugin carries its `error` for the log.
5. **No change to what `disposePlugins` does to running plugins** (concurrent, each bounded), beyond the
   flag and the wait.

### Step 1 -- `src/plugins/host.ts`

- Module state, beside `stateMutator` (`:1247`):

  ```ts
  // #541: set by disposePlugins, read by activatePlugins. A shutdown that lands while plugins are still
  // activating must not let the one in flight, or the ones after it, come up unreleased.
  let disposing = false;
  // #541: the activation run in flight, so disposePlugins can wait (bounded) for the plugin whose
  // activate() is pending to settle and be disposed. Settled and never rejecting.
  let activation: Promise<void> = Promise.resolve();
  ```

- `activatePlugins` (`:680-699`) becomes a thin wrapper that publishes its run:

  ```ts
  export async function activatePlugins(loaded, log, timeoutMs = PLUGIN_ACTIVATE_TIMEOUT_MS): Promise<void> {
    const run = activateEach(loaded, log, timeoutMs);
    activation = run.catch(() => {}); // the loop isolates every throw; this only guards the publication
    return run;
  }

  async function activateEach(loaded: readonly LoadedPlugin[], log: BaseLog, timeoutMs: number): Promise<void> {
    for (const lp of loaded) {
      if (disposing) {
        lp.error = "shutdown began before activate() ran";
        log.warn(`[plugins] ${lp.entry.name} not activated — a shutdown began first`);
        continue;
      }
      try {
        const call = Promise.resolve(lp.plugin.activate?.());
        if ((await within<unknown>(call, timeoutMs, TIMED_OUT)) === TIMED_OUT) {
          afterLateActivate(lp, call, timeoutMs, log);
          throw new Error(`activate() did not finish within ${timeoutMs}ms`);
        }
        if (disposing) {
          // It came up while the process was already leaving: release what it set up and keep it off.
          // Awaited and bounded, so the shutdown that is waiting on this run (disposePlugins) sees it done.
          lp.error = "shutdown began during activate()";
          log.warn(`[plugins] ${lp.entry.name} finished activating after a shutdown began — disposing what it set up`);
          await disposeOne(lp, log, PLUGIN_DISPOSE_TIMEOUT_MS);
          continue;
        }
        lp.running = true;
      } catch (err) { … unchanged … }
    }
  }
  ```

  where `disposeOne(lp, log, timeoutMs)` is the body of `disposePlugins`' per-plugin arrow (`:765-774`),
  extracted so both call it (a throw logged as `dispose failed — continuing`, bounded by a race with a
  timer). Update the docstring (`:676-679`): the two shutdown checks and the published run.
- `disposePlugins` (`:761-776`):

  ```ts
  export async function disposePlugins(loaded, log, timeoutMs): Promise<void> {
    disposing = true; // first, synchronously: activatePlugins reads it after each await (#541)
    const running = loaded.filter((lp) => lp.running);
    for (const lp of running) lp.running = false;
    await Promise.allSettled(running.map((lp) => disposeOne(lp, log, timeoutMs)));
    // #541: wait for an activation still in flight — its pending activate() settles, the loop above
    // disposes that plugin and refuses the rest — bounded like a dispose, so a wedged activate() cannot
    // hold the shutdown past its grace.
    await Promise.race([activation, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  }
  ```

  Update its docstring (`:743-760`): the flag, the wait, and that the plugin activating during the dispose
  is disposed by the loop.
- `host.ts:44-49` (the `LoadedPlugin` field comments): `running` "flipped true by activatePlugins once
  activate() resolves within its bound — and no shutdown has begun"; `error` "set if activate() threw,
  did not finish within its bound, or a shutdown began before or during it (#541)".
- Test seams: `pluginHostStateForTest()` (`:1251`) returns `{ writes, disposing, activation }` (widen its
  return type); `resetPluginDisposingForTest()` (new): `disposing = false; activation = Promise.resolve();`
  with a docstring saying it leaves the write queue alone (the `CONTEXT.md:483-486` convention);
  `resetPluginHostForTest` (`:1259`) calls it. `test/stateLeaks.ts:94`:
  `pluginHostLeaks(s: { writes; disposing: boolean; activation: Promise<void> })` adds
  `if (s.disposing) leaks.push("disposePlugins ran — activatePlugins now refuses every plugin")` and
  `if (!(await settled(s.activation))) leaks.push("a plugin activation still running")`;
  `test/stateGuard.test.ts:222-228`: the two existing calls pass `disposing: false, activation: DONE`, plus
  a `disposing: true` case and an `activation: NEVER` case. `test/stateGuard.ts:67` is unchanged (the
  `GUARDED` resets array keeps `resetPluginHostForTest`, which now clears the flag too).

### Step 2 -- `src/index.ts`

After `await activatePlugins(loadResult.loaded, console)` (`:317`):

```ts
  // #541: a shutdown that began during activation has already disposed what was running and the loop
  // refused the rest; writing state.json, draining the mailbox, binding HTTP and sending the update
  // report-back now would record and announce a boot that never happened (the report would say "failed
  // to start" for a plugin the shutdown refused). Stop here; the pending report is consumed by the next boot.
  if (restartPending()) {
    console.warn("[plugins] shutdown in progress — the rest of activation is skipped");
    return;
  }
```

`restartPending` is imported from `./restart` already (grep the import at `:19-27`; add it if not).
`index.test.ts`: a source pin in the `activate()` section — the slice after `await activatePlugins(`
contains `if (restartPending()) {` before `writePluginState`/`mutatePluginState` (grep the state write
that follows), and `restartPending()` appears in `activate()` exactly once more than today (count the
matches on `main` first and pin the new count).

### Step 3 -- docs, in the same PR

- `CONTEXT.md`: the `src/plugins/host.ts` row (`:219`: "disposes only plugins that are actually `running`"
  and "`disposePlugins` skips a plugin that was never marked running") — add the flag, the wait and the
  loop's two checks; the `src/plugins/host.test.ts` row (`:220`): the new tests; the gotcha at `:542-563`
  ("`running` is flipped once that plugin's `activate()` has succeeded") and `:156`: "— and no shutdown has
  begun"; the test-state-guard rows at `:439` and `:486` ("host.ts has no such reset"): the new flag and
  the flag-only reset, keeping the `:479-481` wording; the `src/index.ts` row's `activate()` sentence: the
  early return.
- `src/plugins/contract.ts` is not edited (vendored byte-identical); its `dispose()` doc (`:425-433`) stays
  true. README and the ADRs have no sentence this changes (grep `disposePlugins`, `activatePlugins`).

### Step 4 -- tests

`src/plugins/host.test.ts` (the `activatePlugins` describe at `:1962-2186`; `lateActivate()` at
`:1978-1987` settles an `activate()` by hand; `makeLog`, `loaded`, `entry`, `orHung`). Add an `afterEach`
calling `resetPluginDisposingForTest()` to this describe and to both describes that call `disposePlugins`
(`:2452-2698`), so the guard (`test/stateGuardHook.ts:33-39`) stays green.

| # | Test | Pins |
|---|---|---|
| T1 | "a plugin whose activate() settles after a shutdown began is disposed before the shutdown returns, left off, and the plugins after it are not activated (#541)" | `lp1` activates and has a `dispose` that resolves when the test says; `lp2` uses `lateActivate()` and signals when its `activate` STARTED (a flag set inside the activate fn, awaited by the test instead of a sleep); `lp3` records whether `activate` ran. Start `activatePlugins([lp1, lp2, lp3], log, 10_000)` un-awaited; await lp2's start signal; start `disposePlugins([lp1, lp2, lp3], log, 2_000)` un-awaited; `await Bun.sleep(0)`; `expect(pluginHostStateForTest().disposing).toBe(true)`; resolve `lp2`; await the activation; then finish `lp1`'s dispose and await `disposePlugins`. Pins: `lp2.running === false`, `lp2.error === "shutdown began during activate()"`, `lp2.dispose` called once and BEFORE `disposePlugins` resolved (record the order), `lp3`'s `activate` never ran, `lp3.error === "shutdown began before activate() ran"`, `lp1.dispose` once; the two `warn` lines present (`not activated — a shutdown began first`, `finished activating after a shutdown began`) |
| T2 | "a dispose that throws after a late activation is logged, not propagated" | `lp2.dispose` throws → the activation resolves; one `dispose failed — continuing` error line |
| T3 | "a plugin whose activate() REJECTS after a shutdown began is recorded as failed, not disposed" | `reject(new Error("boom"))` after the flag → `lp2.error` contains `boom`, `dispose` not called |
| T4 | "disposePlugins waits for the activation in flight, bounded" | an `activate()` that never settles, `disposePlugins([], log, 50)` → resolves in about 50 ms (assert `< 500`), the flag set; a second case where `lp2` settles after 10 ms → `disposePlugins` resolves after `lp2.dispose` ran (order recorded) |
| T5 | "the flag is set synchronously and guarded" | `const p = disposePlugins([], log, 10); expect(pluginHostStateForTest().disposing).toBe(true); await p;` (the `:2611` pattern); `resetPluginDisposingForTest()` → false and `activation` settled; `resetPluginHostForTest()` also clears it |
| T6 | "resetPluginDisposingForTest leaves the write queue alone" | queue a `mutatePluginState` write, call the flag reset, the write still completes through the same queue (the `CONTEXT.md:483-486` shape) |
| T7 | `test/stateGuard.test.ts:222-228`: `pluginHostLeaks({ writes: DONE, disposing: true, activation: DONE })` names `disposePlugins ran`; `{ …, activation: NEVER }` names `activation still running`; the clean case passes both | -- |
| T8 | `src/index.test.ts`: the early-return pin of step 2 | -- |

The existing `activatePlugins` tests (`:1963-2186`) stay green unchanged; say so in the PR after running them.

### Coverage table

| Outcome (bullet) | Step | Test | Mutation that must turn it red |
|---|---|---|---|
| a plugin that comes up after a shutdown began is disposed and left off | 1 | T1 | M1: delete the post-settle `if (disposing)` block (T1: `lp2.running` true, no dispose) |
| the plugins after it are not activated | 1 | T1 | M2: delete the pre-start `if (disposing)` block (T1: `lp3`'s `activate` ran) |
| the flag is set first, synchronously | 1 | T1, T5 | M3: delete `disposing = true` (T1, T5); M4: set it after the `await Promise.allSettled` (T5: false right after the call; T1: `lp2` settles before the flag) |
| the shutdown waits for the activation in flight, bounded | 1 | T1, T4 | M5: delete the `Promise.race` wait (T1: `disposePlugins` resolves before `lp2.dispose`; T4's second case); M6: wait unbounded (T4's first case hangs past 500 ms) |
| the late dispose is awaited and bounded | 1 | T1, T4 | M7: fire-and-forget the late dispose (T1's order: dispose after `disposePlugins` resolved) |
| the late dispose is isolated | 1 | T2 | M8: drop the `catch` in `disposeOne` (T2) |
| a rejection after the shutdown is recorded, not disposed | 1 | T3 | M9: dispose in the catch too (T3) |
| `activate()` stops after the loop under a shutdown | 2 | T8 | M10: delete the early return (the pin) |
| the flag and the run are guarded state, with a flag-only reset | 1 | T5, T6, T7 | M11: `resetPluginDisposingForTest` does nothing (T5); M12: it also replaces the queue (T6); M13: drop the two `stateLeaks.ts` lines (T7) |
| the docs say what the code does | 3 | manual: reviewer B reads the edited sentences against the code | -- |

Run every mutation in a scratch copy (`git worktree add --detach <path> <sha>`), never in the tree the tests
or a reviewer are reading. Paste the red test's name per row in the PR.

### Checks, gate, PR

- `bun run check`; `bunx tsc --noEmit -p ops/tsconfig.json`; `bun run check` inside `ops/admin/`;
  `bun test` from the root, then `bun test --randomize` once (the guard must stay green across the whole
  run: every test that calls `disposePlugins` resets the flag). CI's Linux run is the evidence for the
  `ops/*` suites that skip here.
- Gate: reviewer A on correctness (the shutdown landing before the loop, between two plugins, during one,
  during the last, and after the loop but before the early return; the timed-out plugin that resolves
  after the flag — disposed once, by `afterLateActivate`; `disposePlugins` called twice; the shutdown's
  outer bound against the new wait; the early return against the ready handler and S3a's `afterActivate`
  once that lands; the randomized suite and the guard); reviewer B on claims-vs-code (the coverage table,
  the docstrings, the `CONTEXT.md` rows and gotchas, the error strings, the claim that the existing
  `activatePlugins` tests are unchanged and green). Both read-only, both handed the merged tree and #541.
- Branch `fix/541-dispose-after-shutdown`; title
  `fix(plugins): a shutdown during activation waits for the plugin in flight, disposes it and activates none after it (#541)`.
  Body: `Closes #541`; the pasted checks; the mutation rows; the gate's rounds; decisions 1-5 as assumptions
  taken (decisions 3 and 4, which go beyond the issue's suggested fix, each in their own paragraph with the
  reason). Do not merge.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot. Work in a NEW worktree, never the shared checkout:
  git -C S:\Repos\rackbops-discord-bot fetch origin && git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-541 origin/main -b fix/541-dispose-after-shutdown
Issue: Rackbops/rackbops-discord-bot #541. Read its body and comments first.
Plan: docs/plans/epics/E516/541-dispose-after-shutdown.md on branch claude/530-plans:
  git -C S:\Repos\rackbops-discord-bot show origin/claude/530-plans:docs/plans/epics/E516/541-dispose-after-shutdown.md
A behaviour change in the plugin host's activation loop and index.ts's activate(): run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Every mutation in a scratch worktree. Scratch files: task-unique names (pr-body-541.md, commit-msg-541.txt), read back before use. Report the PR link, the pasted checks, the mutation table, the gate's rounds and any deviation. Do not merge.
```
