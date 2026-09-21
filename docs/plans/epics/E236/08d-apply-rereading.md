## Implementation plan — written by the orchestrating session, to be executed as written

One PR, branch `claude/apply-bar-rereading`, cut from `origin/main` at `a5eb2dd` (#276) or later, in an isolated worktree. Commit this plan as `docs/plans/epics/E236/08d-apply-rereading.md`. Files: `ops/admin/public/index.html` (`APPLY_VIEW` and `APPLY` only), `ops/admin/server.test.ts`, `CONTEXT.md` (one gotcha sentence), `ops/README.md` only if it describes the window. No server route, no `bot-ops.sh` change. Built now, before #244, so the plugin cards inherit one re-read path instead of three.

### Decided — not open for re-planning

- **One rule for both reproductions** (the issue and its comment): while the page is re-reading the server, the bar is not interactive. A single flag, `applyRereading`, beside `applyPhase`.
- **One helper owns every re-read the bar starts**: `rereadFromServer()` sets the flag, refreshes the bar, awaits `Promise.all([loadPlugins(), loadEnv()])`, and in a `finally` clears the flag and refreshes the bar again. `discardPending`, the re-baselining failure branch and the success branch all call it; `loadStatus()` stays a separate, un-awaited call on success, as today. #272's condition is untouched: the failure branch calls the helper only inside `if (!failureWroteNothing(...))`.
- **The guard sits where the in-flight one does**: `applyPending` and `discardPending` return at once while `applyPhase === "applying" || applyRereading`.
- **The view says it**: `applyBarView(state)` takes `rereading`; when true, Discard and Apply are `busy` in the idle (pending) view and in the failed view. OK stays usable: it only dismisses a message. The "applying" and "done" views do not change.
- **Focus** follows #257's rule for buttons that become disabled: if focus is inside the bar when the re-read starts it moves to the bar itself (`focusIfInBar`), and the existing recovery runs when it ends. No new focus mechanism.
- A loader that throws or rejects must not leave the bar locked: the `finally` is the point of the helper.

### Steps

1. `APPLY_VIEW`: `applyBarView` reads `state.rereading` as above. Update the state comment above the function.
2. `APPLY`: add `let applyRereading = false;` with a comment naming both reproductions; add `rereadFromServer()`; `writeApplyBar` passes `rereading: applyRereading`; replace the three `loadPlugins(); loadEnv();` / `Promise.all([...])` call sites; add the guard to `applyPending` and `discardPending`. Rewrite the comments that describe the old timing.
3. Tests (`ops/admin/server.test.ts`, on the `runApply` harness; a held reload is a promise the test resolves itself, raced against a deadline, never awaited forever):
   - `applyBarView marks Discard and Apply busy while the page re-reads, in the pending view and in the failed view` (pure)
   - `while a Discard is re-reading, Apply posts nothing and both buttons are busy`
   - `while the re-read after a failed recreate is in flight, Apply posts nothing and both buttons are busy`
   - `a second Discard while one is re-reading does nothing`
   - `when the re-read lands the bar is consistent: hidden when nothing is pending, and Apply works again`
   - `a re-read that fails still unlocks the bar`
   - `after a kept-edits refusal (#272) nothing is re-read and the bar is never locked`
4. Docs: `CONTEXT.md`'s Apply-bar gotcha gains one sentence (the bar is busy while the page re-reads, and why); fix any sentence in `ops/README.md` that now lies. #276's docs point at #275 for this window: replace that pointer with the fact.

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| Apply during a Discard's re-read sends nothing; both buttons busy | 1, 2 | `while a Discard is re-reading…`; the pure view test | drop `applyRereading` from `applyPending`'s guard; do not set the flag in `discardPending`; drop `rereading` from `applyBarView` |
| the same after a re-baselining failure (the issue's comment) | 2 | `while the re-read after a failed recreate…` | call `loadPlugins(); loadEnv();` directly in the failure branch again |
| the bar is consistent when the reads resolve | 2 | `when the re-read lands…` | never clear the flag |
| a failed re-read cannot lock the bar | 2 | `a re-read that fails still unlocks the bar` | clear the flag after the `await` instead of in `finally` |
| #272 is untouched | 2 | `after a kept-edits refusal (#272)…` + #276's tests, unedited | call the helper unconditionally in the failure branch |
| real Chrome | 2 | — manual, canned panel with slowed reads: Discard then Apply in one task → POST count 0; a failed recreate then Apply during the re-read → POST count 1; focus never lost to `<body>`; paste what you observed | — |
| docs | 4 | — single read against the merged page | — |

### Verification — paste the real output in the PR

```
bun run check
bun run --cwd ops/admin check
bun test ops/admin/server.test.ts --timeout 20000
```

Mutation checks in a detached scratch worktree, one mutant at a time. **Process guards (standing, verbatim in every reviewer prompt):** every command foreground with an explicit timeout; ONE `server.test.ts` run at a time; a private `TEMP`/`TMP` per run under `R:/repos/Scratch/tmp/bot-275`; avoid `python - <<EOF` for anything slow; reviewers run nothing in the background, get a 45-minute budget, are pointed at a worktree whose HEAD you have verified, and are stopped when their verdict is in; before reporting idle, list your processes by age and kill leftovers. Do not merge.

