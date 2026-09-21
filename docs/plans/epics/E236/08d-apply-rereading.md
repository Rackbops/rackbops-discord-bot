<!-- Plan for Rackbops/rackbops-discord-bot#275 (Epic #236). Copy of the approved plan comment, https://github.com/Rackbops/rackbops-discord-bot/issues/275#issuecomment-5767319054, as of when it was approved, with the implementer's "Deviations from the plan" appended at the end. -->

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

## Deviations from the plan

Recorded by the implementer(s). None widens or narrows what the plan decided; each is a wording, a test shape or a claim that could not be known until the code was written and reviewed.

1. `applyPending` **awaits** `rereadFromServer()` in the success and failure branches (the plan does not say): the page wraps Apply in `withBusy`, whose `finally` re-enables the button when `applyPending` returns, which would re-enable a visible Apply while the reads are still in flight.
2. The helper **catches and logs** a rejection (`console.error`) instead of rethrowing, so no caller sees an unhandled rejection and the bar cannot stay locked.
3. One existing test changed its **setup**: `Discard on a failed apply also clears the failure, and focus returns to the open tab when the bar goes` used a body that re-baselines (`{ok:false,text:"nope"}`); with the new behaviour nothing is pending once the re-read lands, so it now uses a real env-set refusal (kept edits) to keep Discard on offer. The plan's "#276's tests, unedited" is therefore not exactly true.
4. The CONTEXT.md addition is a paragraph, not "one sentence" (three, covering `allSettled`, `aria-busy`'s scope, and the timeout-free GETs). `applyBarView`'s state comment and the helper's own comments carry the rest.
5. `Promise.allSettled` instead of the plan's `Promise.all`, and each loader starts inside an async arrow (`[loadPlugins, loadEnv].map(async (load) => load())`) so a loader that throws synchronously is that loader's own rejection: it cannot skip the other loader nor let the `finally` clear the flag while the other is still in flight. Found in round-1 review (`Promise.all` can unlock early); the plan text above is left as originally written per the header note, this section is where the change is recorded.
6. **`aria-busy` is scoped to the PENDING view only**, narrower than round-1's literal instruction ("on the bar during the re-read"), and the orchestrator approved the narrowing: `applyBarView(...)` returns `ariaBusy`, true only in the pending view while re-reading; `writeApplyBar` sets/removes `aria-busy` on `#apply-bar` from it. Reason: the failed and done views write their message into the `role="status"` region inside the bar in the same task the re-read starts, and `aria-busy` on a container above a live region can hold that region's announcements until it clears — the failure or success message could go unheard. The pending view has no terminal message to lose. **Unverified: no screen reader was available to confirm the swallowing behaviour**; treat it as reasoned, not measured.
7. The test harness's `view().disabled` (an AND of both buttons) is gone, replaced by `discardDisabled` / `goDisabled` read separately (round-1 finding: the AND let either button stay locked while a `disabled: false` assertion still passed); every `disabled:`-shaped assertion in the apply tests, including the pre-existing #257 ones, now names both buttons, and seven whole-view `applyBarView` expectations gained `ariaBusy: false`.
8. Harness options added beyond the plan's test list: `reloadFailsAlone` (one loader rejects, the other is held, pins that `allSettled` — not `all` — keeps the bar locked until both settle), `reloadThrows` (a loader that throws synchronously is still reported and does not skip its sibling), and `focusThrowsOnce` (a throw as the re-read starts, while focus is moving onto the bar, is reported and the bar still ends unlocked — pins the `try` placement from round-1 finding 3; not mutation-checked, since a plain assignment cannot throw).

