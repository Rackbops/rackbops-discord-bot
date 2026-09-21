## Implementation plan — written by the orchestrating session, to be executed as written

One PR, branch `claude/apply-bar-keep-edits`, cut from `origin/main` **after #242 (PR #268) has merged** (both edit `ops/admin/server.test.ts`; the panel chain is serial), in an isolated worktree. Commit this plan as `docs/plans/epics/E236/08b-apply-keep-edits.md`. Files: `ops/admin/public/index.html` (the `APPLY_VIEW` and `APPLY` blocks only), `ops/admin/server.test.ts`, `CONTEXT.md`, `ops/README.md`. No server route, no `bot-ops.sh` change.

### Decided — not open for re-planning

- **Option 2 of the issue.** The controls are left alone after a failure that PROVES nothing was written; every other failure re-baselines, which stays the safe default.
- **"Proves nothing was written" is exactly one case: HTTP 502 whose body is not JSON** — an early `die()` in `bot-ops.sh`. A JSON 502 means `.env` was rewritten and the recreate failed (#47): re-baseline. A 504 means the outcome is unknown: re-baseline. Any other status (400, 403, 500, anything new) re-baselines too — a status this page does not know about is not proof.
- **The `catch` branch does not change** (a network error or the client-side timeout leaves the controls as they are, as it does today). Re-loading from a server that cannot be reached would replace the user's input with two error lines; the no-box guard already stops that state from planning a `PLUGINS` wipe. Say so in the docs instead.
- **The view does not change.** `applyBarView`'s `failed` state already shows Discard and Apply beside OK whenever something is still pending (`showDiscard/showGo: state.count > 0`), which is what a kept-edits failure needs.
- Not in this PR: marking the refused control `aria-invalid` from the server's message. Tempting, separate, and it would parse a message this page does not own.

### Step 1 — `APPLY_VIEW`: a pure decision

Add beside `describeApplyFailure`:

```js
// Did a failed POST /api/env PROVABLY write nothing? Only then may the page keep what the user typed.
//   502 + JSON ({ok:false, changed, backup, log})  the recreate failed AFTER .env was rewritten (#47)  -> false
//   504                                              bot-ops.sh timed out: the outcome is unknown        -> false
//   502 + a body that is not JSON                   an early die(): it never reached the write          -> true
//   anything else                                    not a status this page can reason about            -> false
function failureWroteNothing(status, result) {
  return status === 502 && result === null;
}
```

`result` is what `applyPending` already computes (`null` when the body did not parse as JSON). Export it to the test harness the way `describeApplyFailure` is.

### Step 2 — `applyPending`'s failure branch

Replace the unconditional `loadPlugins(); loadEnv();` with `if (!failureWroteNothing(res.status, result)) { loadPlugins(); loadEnv(); }` and rewrite the `#47` comment above it: re-baseline unless the answer proves nothing was written; when it does, the controls keep the user's values and ticks, the bar shows the failure with Discard and Apply, and a retry that finds the values already in place gets `recreated:false`, which the bar reports as "Nothing needed applying." (the narrow post-`mv` window in the issue's table). Nothing else in the function changes.

### Step 3 — tests (`ops/admin/server.test.ts`)

The page harness's `api()` stub must carry a `status`: default 200 for `ok: true`, 502 for `ok: false`, overridable per test. Change the stub, not the page.

- `failureWroteNothing: only a plain-text 502 proves nothing was written` — a table: `(502, null)` true; `(502, {log})`, `(502, {ok:false})`, `(504, null)`, `(500, null)`, `(400, null)`, `(200, null)` all false.
- REPLACE the expectations of `a plain-text failure is shown verbatim…` (rename it to say the edits are kept): `reloads` is `{ plugins: 0, env: 0, status: 0 }`; the edited field and the plugin tick still hold the user's values; the bar's view is `Couldn't apply: <message>` with `showOk`, `showDiscard` and `showGo` all true. Say in the PR that this one expectation is the thing under change.
- UNCHANGED, and must stay green untouched: `a failed recreate shows the compose error and the backup path, and re-baselines (#47)`.
- NEW `a 504 re-baselines, because the outcome is unknown` — stub answers `{ ok: false, status: 504, text: "bot-ops.sh timed out" }`; one reload of each; the message is shown verbatim.
- NEW `retrying after a kept-edits failure posts the same body again, and a no-changes answer says nothing needed applying` — first answer a plain-text 502, second `{ ok: true, json: { ok: true, recreated: false } }`; assert two POSTs with identical bodies and the `noop` wording.
- NEW `Discard after a kept-edits failure restores the server's values and posts nothing`.

### Step 4 — docs

`CONTEXT.md` (the "Apply bar derives what is pending from the controls" gotcha) and the `ops/README.md` sentence on failure handling: three outcomes — a refusal that wrote nothing keeps the edits; a failed recreate and a timeout re-baseline; a network error or the page's own timeout leaves the controls as they are. Verify each sentence against the merged page.

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| a plain-text failure keeps the edits, shows the failure with Discard and Apply | 1, 2 | the renamed plain-text test | restore the unconditional `loadPlugins(); loadEnv();`; make `failureWroteNothing` always return false |
| the JSON failure still re-baselines (#47) | 1, 2 | `a failed recreate shows the compose error…` (unchanged) | drop `result === null` from `failureWroteNothing` |
| a 504 re-baselines | 1, 2 | `a 504 re-baselines…` + the table test | drop `status === 502` from `failureWroteNothing` |
| a retry is idempotent and says so | 2 | `retrying after a kept-edits failure…` | clear the controls in the failure branch |
| Discard still works after a kept-edits failure | 2 | `Discard after a kept-edits failure…` | make `discardPending` return early while `applyPhase === "failed"` |
| real Chrome | 2 | — manual: canned bot-ops whose `env-set` exits 1 with plain text; paste what you saw (typed value and tick still there after "Couldn't apply", Discard restores, Apply retries) | — |
| docs say what the page does | 4 | — single read against the merged page | — |

### Verification — paste the real output in the PR

```
bun run check
bun run --cwd ops/admin check
bun test ops/admin/server.test.ts --timeout 20000
```

Mutation checks in a detached scratch worktree, one mutant at a time. **Process guards (standing):** every command foreground with an explicit timeout; ONE `server.test.ts` run at a time, never parallel copies; a private temp dir per run (`TEMP`/`TMP` under `R:/repos/Scratch/tmp/bot-272`, create it first — `test/setup.ts` sweeps the shared one, #252); reviewers run nothing in the background, get a 45-minute budget, and are stopped when their verdict is in; before reporting idle, list your processes by age and `taskkill /T /F` any leftover. Do not merge.

