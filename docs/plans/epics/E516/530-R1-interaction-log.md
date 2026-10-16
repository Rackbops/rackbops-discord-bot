<!-- Plan for sub-epic #530 of Epic #516 (Rackbops/rackbops-discord-bot), bundle R1: what the interaction log says and
what it leaks. Written by the orchestrating session on 2026-10-16 against `main` @ `f1e7083`; audited read-only against
that tree and S4a's diff before it was committed (10 findings, all applied: the hooks run at the shutdown's exit, not at
the signal; six log sites, not four; the once-only writer is a unit-tested function). Every file:line below was read from
that tree; the implementer re-reads each one on the tree it works from (which will have S4a, PR #559, merged:
`src/restart.ts` moves below `:25`) and corrects any that moved. -->

## Implementation plan -- #530 bundle R1: failed replies no longer log the interaction token, and a command that exits the process still gets its line

Children: **#545** and **#446**. One PR. Behaviour changes in the interaction handler's logging and in
`restart.ts`'s exit path, so the **three-reviewer gate** applies: you plus two read-only adversarial
reviewers, up to four rounds; every changed line mutation-tested in a scratch worktree.

**Prerequisite: S4a merged** (PR #559, `fix/525-S4a-restart-identity`): it rewrites `requestRestart`,
`doExit`, `beginShutdown`, `resetForTest` and `stateForTest` in `src/restart.ts`, and `test/stateLeaks.ts`
and `test/stateGuard.test.ts`, all of which this bundle extends. Branch from `origin/main` once it is in.
S3a (PR #557) and S3b-2 edit `src/index.ts` at the boot and ready wiring, far from the interaction handler
this bundle edits (`:237-297`) and the shutdown wiring (`:110-124`); if either lands first, re-anchor.

### What is wrong, verified at `f1e7083`

- **A failed interaction reply is logged whole, interaction token included** (#545). Six sites log a
  thrown error as it is: `src/index.ts:293` (`console.error("[interaction]", err)`, the handler's catch),
  `src/plugins/host.ts:836` (a plugin's component or modal handler), `src/plugins/host.ts:937` (a plugin's
  autocomplete), `src/commands.ts:347` (a plugin's slash command, since #534), `src/updateReport.ts:111`
  (`[updateReport] ${route} delivery failed` — the `token` route posts to
  `Routes.webhook(appId, interactionToken)`, `:128-132`, so a 10015 or a token at its 15-minute edge is a
  REST error whose `url` carries the `/update` requester's token), and `src/plugins/host.ts:100` (the
  `host.log.error(m, e)` wrapper every plugin logs through: a plugin that replies to an interaction itself
  and logs the rejection logs it raw). When the throw is a discord.js REST error from replying (10062
  Unknown interaction, 40060 already acknowledged are the usual ones), it carries `url` —
  `/interactions/{id}/{token}/callback` or `/webhooks/{appId}/{token}/…` — and `requestBody.json`, the reply
  being sent. Measured on Bun 1.4.2 with a real `DiscordAPIError` (the audit, 2026-10-16): the text console
  prints `url` and `rawError` and folds the body to `[Object …]`; `util.format` (the `LOG_FORMAT=json` path,
  `src/logFormat.ts:31`) prints token and body in full; the `withoutRequest` view prints neither in either
  format and keeps `name` (`DiscordAPIError[10062]`), `message`, `code`, `status`, `method`. An interaction
  token lets its holder edit the response and post follow-ups for 15 minutes. #540 (#508) built that cleaner
  (`src/plugins/delivery.ts:19-26`) for the errors the host hands to plugins; these six sites do not use it.
- **A command that ends the process leaves no interaction line** (#446). `src/interactionLog.ts:1-4` says
  every command, press and modal submit shows in the log; the line is written only in the handler's
  `finally` (`src/index.ts:294-296`). `/update` on the exit-75 fallback and `/plugins … update … now` run
  `requestRestart` inside `withCritical` (`src/commands.ts:112-130`, `:268-272`); `withCritical`'s `finally`
  → `endCritical` → `doExit` → `process.exit(75)` runs before control returns to the handler, so no
  `[interaction] command /update user=…` line is ever written for the most consequential admin actions.
  On a successful redeploy the replacement stops this container mid-await: SIGTERM → `shutdown.ts`'s
  handler → its `exit(0)` (`index.ts:121`), again before the `finally`. Only unattributed
  `[restart]`/`[redeploy]` lines remain. `ops/README.md:664-676` is the operator doc for the line (it says
  "once it is handled" and lists `answered`, `gated`, `unclaimed`, `error`).

### Decisions (defaults, named so the gate can contest them)

1. **Clean at the six log sites, with the cleaner that exists.** `withoutRequest(err)` at each. Not in the
   console path: the text console (the default) also prints `url` and `rawError`, so a formatter-only fix
   would have to wrap both formats, and `bootLog.ts` swaps the console only under `LOG_FORMAT=json` by
   design. `withoutRequest` stays in `src/plugins/delivery.ts` (it imports only discord.js and a type from
   `./hostMessage`; `host.ts`, `commands.ts`, `updateReport.ts` importing it creates no cycle —
   `routing/post.ts:20` already does). A plain `Error` passes through by identity, so the existing
   assertions on the logged error object (`commands.test.ts:568`, `host.test.ts:2347`) still hold. The
   `host.log.error` wrapper cleans only the LOGGED copy; the plugin's own error object is untouched. A
   `RateLimitError` (`url`, no `requestBody`) passes the cleaner's gate, and is unreachable here because
   `rejectOnRateLimit` is unset; say so in the docstring, do not widen the gate in this bundle.
2. **A command that exits the process gets its line from an exit hook, run at the process's actual exit,
   with a new outcome `exiting`.** `restart.ts` gains `onBeforeExit(fn): () => void` and an exported
   `runExitHooks()`: hooks run once, synchronously, isolated, in registration order. `doExit` runs them right
   before `exitFn` (the requested-restart path, S4a's deadline included). The shutdown path runs them at
   its EXIT, not at the signal: `index.ts:121`'s `exit: (code) => process.exit(code)` becomes
   `exit: (code) => { runExitHooks(); process.exit(code); }`, so an interaction that arrives or finishes
   during the drain (up to `SHUTDOWN_GRACE_MS`, the client is still connected) logs its real outcome from
   its `finally`, and only one still in flight at the exit logs `exiting`; the second-signal exit
   (`shutdown.ts:108-109`) goes through the same `exit` and is covered. `beginShutdown` does NOT run them
   (the audit's finding: running them at the signal discards the list, so a drain-time interaction gets no
   line, and one that finishes in the drain gets `exiting` with a truncated duration beside its own
   `error` line). The interaction handler registers one hook (only when `facts` is non-null: autocomplete
   has no line) before its `try` and removes it in its `finally`; the line is written through a once-only
   writer, so an interaction whose hook fired never logs a second line when the handler returns during the
   drain. The outcome is `exiting`: the process is leaving before the handler returned.
3. **The once-only writer is a unit-tested function, not a closure in `index.ts`.** `interactionLog.ts`
   gains `createInteractionLine(facts, write, now)`: returns `(outcome) => void` that writes
   `interactionLogLine(facts, outcome, now() - started)` at most once, and nothing when `facts` is null.
   `index.ts` cannot be imported by a test, so the "exactly one line" rule needs a home a test can drive.
4. **Not a start line.** Logging every interaction twice doubles the log for the 99 % that return normally.
5. **The hook list is guarded module state:** `stateForTest` gains `exitHooks: number`, `resetForTest`
   clears it, `test/stateLeaks.ts` reports a leaked hook, `test/stateGuard.test.ts` gets the row (its
   `CLEAN_RESTART` and `allDirty` counts grow by one, to 9 after S4a's 8).

### Step 1 -- the six log sites (#545)

- `src/index.ts:293`: `console.error("[interaction]", withoutRequest(err));`; add `withoutRequest` to the
  existing `./plugins/delivery` import at `:61`. The #545 comment goes ABOVE the `} catch (err) {` line
  (inside the `try` block's last lines is wrong; put it as a comment line immediately above `} catch`),
  so T14's regex (step 3) matches the catch body unbroken.
- `src/plugins/host.ts:836`: `log.error(\`[plugins] ${lp.entry.name} interaction failed\`, withoutRequest(err));`;
  `:937`: `log.error(\`[plugins] ${target?.entry.name} autocomplete for "${bare}" failed\`, withoutRequest(err));`;
  `:100`: `error: (m, e) => opts.baseLog.error(\`[${name}] ${m}\`, withoutRequest(e)),` with
  `import { withoutRequest } from "./delivery";`. The gate-error site at `:917` and the http sites at
  `:1049`/`:1082` are not REST replies; leave them, and say so in the PR.
- `src/commands.ts:347`: `console.error(\`[plugins] ${target.plugin} command /${interaction.commandName} failed\`, withoutRequest(err));`
  with the import from `./plugins/delivery`.
- `src/updateReport.ts:111`: `console.warn(\`[updateReport] ${route} delivery failed\`, withoutRequest(err));`
  with the import.
- A short comment at each site: "#545: a discord.js REST error from the reply carries the interaction
  token in `url` and the reply in `requestBody`; `withoutRequest` keeps code/status/method".
- `src/plugins/delivery.ts:10-17` (`withoutRequest`'s docstring): the host's own log sites use it too
  (#545), the `host.log.error` wrapper cleans the logged copy only, and the `RateLimitError` note.

### Step 2 -- `src/restart.ts` (#446)

After S4a's `clearDeferral` and beside `stopListeners`:

```ts
// #446: run once, synchronously, right before this process exits — a requested restart's `doExit`, or the
// shutdown handler's exit (`index.ts` wires `runExitHooks` into it) — so a log line that would otherwise be
// lost (the interaction line of the command that asked for the exit) can be written first. Cleared by
// `resetForTest`.
let exitHooks: (() => void)[] = [];

/**
 * Registers `fn` to run once, synchronously, immediately before the process exits for a requested restart
 * (`doExit`) or at the end of a shutdown (`runExitHooks`, called by the shutdown handler's `exit`); returns
 * an unsubscribe. A hook that throws is logged and never stops the exit or the other hooks. Hooks run in
 * registration order.
 */
export function onBeforeExit(fn: () => void): () => void {
  exitHooks.push(fn);
  return () => {
    exitHooks = exitHooks.filter((h) => h !== fn);
  };
}

/** Runs and empties the hooks. Exported for the shutdown handler's `exit` (`index.ts`); `doExit` calls it too. */
export function runExitHooks(): void {
  const hooks = exitHooks;
  exitHooks = [];
  for (const hook of hooks) {
    try {
      hook();
    } catch (err) {
      console.error("[restart] an exit hook threw (continuing)", err);
    }
  }
}
```

- `doExit`: after `clearDeferral()` and the `[restart] exiting` log line, `runExitHooks();` then
  `exitFn(RESTART_EXIT_CODE)`. `beginShutdown` is unchanged.
- `resetForTest`: `exitHooks = [];`. `RestartStateForTest`/`stateForTest`: `exitHooks: exitHooks.length`.
- `test/stateLeaks.ts:29-41`: `if (s.exitHooks !== 0) leaks.push(\`${s.exitHooks} onBeforeExit hook(s) still registered\`);`.
  `test/stateGuard.test.ts`: `CLEAN_RESTART` gains `exitHooks: 0` (after S4a's `deferralArmed: false`),
  `rows` gains `["exitHooks", { exitHooks: 2 }, "2 onBeforeExit hook(s)"]`, `allDirty` gains `exitHooks: 1`
  and expects 9. `src/restart.test.ts`'s `stateForTest` `toEqual` (`:284-292` at `cccd683`, moved by S4a)
  gains the field.
- The header comment (`:1-38` after S4a) gains one paragraph on the hooks.

### Step 3 -- `src/interactionLog.ts` and `src/index.ts` (#446)

- `InteractionOutcome` gains `"exiting"` with the doc line: "the process is exiting (a requested restart,
  or a stop) before the handler returned — written by the exit hook `index.ts` registers, so `/update`
  and `/plugins … update … now` leave a line too (#446)". The header (`:1-4`) says the line is written
  once the interaction is handled, "or, for a command that ends the process, right before it exits".
- `src/interactionLog.ts` gains:

  ```ts
  /**
   * #328/#446: the one writer of an interaction's line. Returns `line(outcome)`, which writes
   * `interactionLogLine(facts, outcome, now() - started)` through `write` the FIRST time it is called and
   * nothing after — so the exit hook and the handler's `finally` can both call it and exactly one line
   * lands, whichever fires first. With `facts` null (autocomplete) it writes nothing.
   */
  export function createInteractionLine(
    facts: InteractionFacts | null,
    write: (line: string) => void,
    now: () => number = Date.now,
  ): (outcome: InteractionOutcome) => void {
    const started = now();
    let logged = false;
    return (outcome) => {
      if (logged || facts === null) return;
      logged = true;
      write(interactionLogLine(facts, outcome, now() - started));
    };
  }
  ```

- `src/index.ts:237-297`:

  ```ts
  client.on(Events.InteractionCreate, async (interaction) => {
    const facts = describeInteraction(interaction);
    let outcome: InteractionOutcome = "answered";
    // #328/#446: exactly one line per interaction — once it is handled, or from the exit hook when the
    // handler itself ends the process (a requested restart, or the replacement stopping this container)
    // before it returns. `line` writes at most once, whichever comes first (src/interactionLog.ts).
    const line = createInteractionLine(facts, (l) => console.info(l));
    const offExit = facts ? onBeforeExit(() => line("exiting")) : () => {};
    try {
      … unchanged …
      // #545: a REST error from the reply carries the interaction token in `url` and the reply in
      // `requestBody`; withoutRequest keeps what an operator needs (code, status, method).
    } catch (err) {
      outcome = "error";
      console.error("[interaction]", withoutRequest(err));
    } finally {
      offExit();
      line(outcome);
    }
  });
  ```

  (`started` moves into `createInteractionLine`.) Import `createInteractionLine` beside
  `describeInteraction` (`:58`) and `onBeforeExit`, `runExitHooks` in the `./restart` list (`:19-27`).
- `src/index.ts:121`: `exit: (code) => { runExitHooks(); process.exit(code); },` with a comment: #446, the
  hooks run at the shutdown's exit, after the drain, so an interaction that finished during it logged its
  own outcome and only one still in flight logs `exiting`.
- `src/index.test.ts:472-485` (the #328 pin) becomes: `const line = createInteractionLine(facts, (l) => console.info(l));`
  present once; `const offExit = facts ? onBeforeExit(() => line("exiting")) : () => {};` present, its index
  between `const facts = describeInteraction(interaction);` and the handler's `try {`; the catch matches
  `/catch \(err\) \{\s*outcome = "error";\s*console\.error\("\[interaction\]", withoutRequest\(err\)\);/`
  (no comment between those two statements); the finally matches
  `/finally \{\s*offExit\(\);\s*line\(outcome\);\s*\}/`; `interactionLogLine(` appears NOWHERE in the handler
  (it moved into `createInteractionLine`); `onBeforeExit(` appears exactly once in the file. The shutdown
  pin at `:503-510` (the `createShutdownHandler` call) gains `toContain("exit: (code) => {")`,
  `toContain("runExitHooks();")` inside that call's slice, and `(source.match(/runExitHooks\(/g)).length === 1`.

### Step 4 -- docs, in the same PR

- `ops/README.md:664-676` (the operator doc for the line): "once it is handled" → "once it is handled, or,
  for a command that ends the process (`/update` on the exit-75 path, `/plugins … update … now`, a
  successful self-update), right before the process exits"; add `exiting` to the outcome list with one
  clause; the `jq` filter is unchanged. `:667-669` (the `error` outcome sits next to the error's own
  line): add that the error's own line no longer carries the interaction token or the reply (#545).
- `CONTEXT.md`: the `src/interactionLog.ts` row (grep `one log line per interaction`): `createInteractionLine`,
  the `exiting` outcome; the `src/restart.ts` row (after S4a's text): `onBeforeExit`/`runExitHooks`; the
  `src/index.ts` row's InteractionCreate sentence (grep `InteractionCreate`) and its shutdown sentence
  (grep `createShutdownHandler`): the once-only line, the cleaner, the hooks at the exit; the
  `src/plugins/host.ts` row's interaction/autocomplete sentence and the `host.log` sentence; the
  `src/commands.ts` row (grep `#534`) and the `src/updateReport.ts` row: the cleaner; the
  `src/plugins/delivery.ts` row (`:155`) and the `src/routing/post.ts` row (`:168`): `withoutRequest`'s
  callers now include the six log sites; the test-state-guard list (grep `armed restart-deferral deadline`,
  `:432` after S4a): `exitHooks`; the per-test-file rows (`src/restart.test.ts`, `src/index.test.ts`,
  `src/interactionLog.test.ts`, `src/plugins/host.test.ts`, `src/commands.test.ts`, `src/updateReport.test.ts`,
  `test/stateGuard.test.ts`): the new tests.
- `README.md` has no sentence about the interaction line (grep `[interaction]`, `interaction log`: none);
  nothing to edit there. `docs/adr/`: grep `withoutRequest` and `interaction log`; amend only a sentence the
  change makes false (expected: none).

### Step 5 -- tests

| # | File / test | Pins |
|---|---|---|
| T1 | `src/commands.test.ts`, beside `:560-572` (the "handler that throws is isolated" test): "a REST error from the reply is logged without the interaction token or the reply" | the `DiscordAPIError` built as `delivery.test.ts:143-147` does, with url `https://discord.com/api/v10/interactions/1/<random token>/callback` and `body: { content: "<random marker>" }`; the handler rejects with it; `logs.error.mock.calls[0][1]` has no `url`/`requestBody`/`rawError`, has `code === 50001`, `status === 403`; BOTH `format(...logs.error.mock.calls[0])` and `Bun.inspect(logs.error.mock.calls[0][1])` contain neither the token nor the marker; `replies` still gets "Something went wrong." |
| T2 | `src/commands.test.ts:560-572` keeps `toEqual([["[plugins] demo command /hello failed", boom]])` — a plain Error passes through by identity | unchanged |
| T3 | `src/plugins/host.test.ts`, in the dispatch describe (`:2318-2367`): a SIBLING logger that records both arguments (do not change `makeLog`, whose `toEqual([{level, message}])` callers pass a second argument): "a REST error from a plugin's interaction reply is logged without the token or the body" | as T1, through `dispatchPluginInteractionOutcome`; the logged object has `code`/`status`, no `url`/`requestBody`; `format` and `Bun.inspect` carry neither secret |
| T4 | `src/plugins/host.test.ts`, the autocomplete describe: call `dispatchPluginAutocomplete` directly with the capturing log (its `run` helper hard-wires `makeLog`): "a REST error from a plugin's autocomplete is logged without the token" | the handler throws the same error; `respond([])` still answered; the logged object cleaned |
| T4b | `src/plugins/host.test.ts`, the `createHostApi` log tests: "host.log.error cleans a REST error's logged copy and leaves a plain error as is" | `host.log.error("x", discordError)` → the base log received a cleaned object; `host.log.error("x", plain)` → the same object |
| T4c | `src/updateReport.test.ts`: "a token-route delivery failure is logged without the token" | the REST post rejects with a `DiscordAPIError` whose url is `/webhooks/<app>/<random token>`; the warn's second argument is cleaned; `format` of the call has no token |
| T5 | `src/logFormat.test.ts` (or `delivery.test.ts`): "a cleaned REST error's JSON log line names code and status, never the url or the body" | `jsonLogLine("error", ["[interaction]", withoutRequest(discordError)], now)` contains `50001` and `403`, not the token or the marker; the uncleaned one contains both |
| T6 | `src/restart.test.ts`, new describe "onBeforeExit (#446)": "a requested restart runs the hooks, in order, before the exit function" | `exits` via `setExitFn` pushing `"exit"` into a shared `order`; two hooks push `"a"`, `"b"`; `requestRestart("t")` idle → `["a", "b", "exit"]` |
| T7 | "a deferred restart's hooks run when the section closes, once" | `beginCritical(); onBeforeExit(h); requestRestart("t"); endCritical()` → `h` once; `stateForTest().exitHooks === 0` |
| T8 | "runExitHooks runs and empties the list; beginShutdown does not run them" | `onBeforeExit(h); beginShutdown("SIGTERM")` → `h` not called, `exitHooks === 1`; `runExitHooks()` → `h` once, `exitHooks === 0`; `runExitHooks()` again → still one call |
| T9 | "a throwing hook is isolated: the others run and the exit still happens" | first hook throws; second runs; `exits` is `[75]`; `console.error` once with `an exit hook threw` |
| T10 | "an unsubscribed hook is not run" | `const off = onBeforeExit(h); off(); requestRestart("t")` → `h` not called |
| T11 | "resetForTest clears the hooks, and stateForTest counts them" | register two → `exitHooks === 2`; `resetForTest()` → `0` |
| T12 | "a hook registered after beginShutdown still runs at the exit" | `beginShutdown("SIGTERM"); onBeforeExit(h); runExitHooks()` → `h` once (the drain-time interaction) |
| T13 | `src/interactionLog.test.ts`, new describe "createInteractionLine (#446)": "writes once, whichever caller is first" | `const line = createInteractionLine(facts, w, clock)`; `line("exiting"); line("answered")` → `w` called once with `outcome=exiting`; a fresh one with `line("answered"); line("exiting")` → once with `outcome=answered`; a `facts: null` one → `w` never called; the duration comes from the injected clock |
| T13b | "the exiting outcome renders like the others" | `interactionLogLine(facts, "exiting", 1234)` ends with `outcome=exiting 1234ms` (a render check; the union itself is `tsc`'s) |
| T14 | `src/index.test.ts:472-485` and `:503-510`: the pins rewritten per step 3 | the hook is registered before the `try` and only with facts, removed in the `finally`, `line` is the writer, the catch uses `withoutRequest`, the shutdown `exit` runs the hooks |
| T15 | `test/stateGuard.test.ts`: the `exitHooks` row; `src/restart.test.ts`'s `stateForTest` `toEqual` gains the field | -- |

### Coverage table

| Outcome (bullet) | Step | Test | Mutation that must turn it red |
|---|---|---|---|
| #545: the handler's catch logs no token or body | 1 | T14 (source pin), T5 (the cleaner's effect under JSON) | M1: `console.error("[interaction]", err)` again (T14) |
| #545: a plugin command's failure logs no token or body | 1 | T1, T2 | M2: drop `withoutRequest` at `commands.ts:347` (T1: the token is in `format(...)`); T2 guards the plain-Error identity |
| #545: a plugin interaction's, autocomplete's and `host.log.error`'s failure log no token | 1 | T3, T4, T4b | M3: drop it at `host.ts:836` (T3); M4: at `:937` (T4); M5: at `:100` (T4b) |
| #545: the `/update` requester's token never reaches the delivery-failure line | 1 | T4c | M6: drop it at `updateReport.ts:111` |
| #545: what is kept is what an operator needs | 1 | T1, T3, T5 | M7: `withoutRequest` drops `code` (T1's `code === 50001`) |
| #446: a command that exits via a requested restart leaves its line | 2, 3 | T6, T7, T14 | M8: delete `runExitHooks()` from `doExit` (T6/T7); M9: register the hook after the `try`, or drop it (T14) |
| #446: a command interrupted by a stop leaves its line, at the exit | 2, 3 | T8, T12, T14 | M10: run the hooks in `beginShutdown` instead (T8: `h` called at the signal; T12 red too); M11: drop `runExitHooks()` from `index.ts`'s shutdown `exit` (T14) |
| #446: never two lines for one interaction | 3 | T13 | M12: drop `logged = true` in `createInteractionLine` (T13: two writes) |
| the hooks are isolated and ordered | 2 | T9, T10 | M13: delete the hook's `try`/`catch` (T9); M14: `onBeforeExit` returns a no-op (T10) |
| the hook list is guarded state | 2 | T11, T15 | M15: `resetForTest` keeps the hooks (T11); M16: drop the `stateLeaks.ts` line (T15's row) |
| the `exiting` outcome renders | 3 | T13b | M17: remove `"exiting"` from the union — `tsc` catches it; say so |
| the docs say what the code does | 4 | manual: reviewer B reads every edited sentence, `interactionLog.ts`'s header and `ops/README.md:664-676` included, against the code | -- |

Run every mutation in a scratch copy (`git worktree add --detach <path> <sha>`), never in the tree the tests
or a reviewer are reading. Paste the red test's name per row in the PR.

### Checks, gate, PR

- `bun run check`; `bunx tsc --noEmit -p ops/tsconfig.json`; `bun run check` inside `ops/admin/`;
  `bun test` from the root, then `bun test --randomize` once. CI's Linux run is the evidence for the
  `ops/*` suites that skip here.
- Gate: reviewer A on correctness (every exit path: `doExit` idle and deferred, the shutdown handler's
  exit after a drain that resolved and after one that timed out, the second-signal exit, S4a's deadline,
  `stepAside` once S3a lands; an interaction that arrives during the drain and one that finishes during it;
  a hook registered by an interaction whose handler returns normally — exactly one line; `withoutRequest`
  on the non-REST errors each site can see; the autocomplete path's `respond([])` after a cleaned error;
  `host.log.error` with a non-Error second argument); reviewer B on claims-vs-code (the coverage table,
  every edited comment and `CONTEXT.md`/`ops/README.md` sentence, `interactionLog.ts`'s header, the #545
  claim for BOTH log formats — verify with a real `DiscordAPIError` through `util.format` and `Bun.inspect`).
  Both read-only, both handed the merged tree, #545 and #446.
- Branch `fix/530-R1-interaction-log`; title
  `fix(interaction): log failed replies without the token or the body, and log a command that exits the process (#545, #446)`.
  Body: `Closes #545`, `Closes #446`, `Part of #530`; the pasted checks; the mutation rows; the gate's
  rounds; decisions 1-5 as assumptions taken (decision 2's "at the exit, not at the signal" in its own
  paragraph). Do not merge.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot. Work in a NEW worktree cut from origin/main AFTER S4a (PR #559) is merged, never the shared checkout:
  git -C S:\Repos\rackbops-discord-bot fetch origin && git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-530-R1 origin/main -b fix/530-R1-interaction-log
Issues: Rackbops/rackbops-discord-bot #545 #446 (sub-epic #530 of Epic #516). Read both bodies and comments first.
Plan: docs/plans/epics/E516/530-R1-interaction-log.md on branch claude/530-plans:
  git -C S:\Repos\rackbops-discord-bot show origin/claude/530-plans:docs/plans/epics/E516/530-R1-interaction-log.md
Behaviour changes in the interaction handler's logging and restart.ts's exit path: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Every mutation in a scratch worktree. Scratch files: task-unique names (pr-body-530R1.md, commit-msg-530R1.txt), read back before use. Report the PR link, the pasted checks, the mutation table, the gate's rounds and any deviation. Do not merge.
```
