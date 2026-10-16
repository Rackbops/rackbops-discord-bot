<!-- Plan for sub-epic #525 of Epic #516 (Rackbops/rackbops-discord-bot), bundle S1: the original's verdict
on the swap. Written by the orchestrating session on 2026-10-15 against `main` @ `b13ceac`, with the handoff
state table (#515, `docs/plans/epics/E516/525-handoff-state-table.md`) as the design input. Every file:line
below was read from that tree; the implementer re-reads each one on the tree it works from and corrects any
that moved. -->

## Implementation plan -- #525 bundle S1: `src/redeploy.ts`'s verdict, `src/handoff.ts`'s message

Children: **#431**, **#433**, **#451**, **#434**, **#432**. One PR. A behaviour change (what the original
does when a poll fails, when a `ready` lands late, and what it tells the requester), so the **three-reviewer
gate** applies: you plus two read-only adversarial reviewers with different lenses, up to four rounds, then
report. Every coverage row is mutation-tested in a scratch worktree, real output pasted.

Bundle A of #524 (another session's PR, `fix/524-storage-state`) edits `src/handoff.ts:7-10` (the header
comment), `CONTEXT.md:743` (the marker gotcha), `src/docker.ts:248` (a `STOP_TIMEOUT_SEC` constant) and adds
one stop-request test to `docker.test.ts`. This bundle does not touch those lines: it edits `handoff.ts` from
`:110` down, `CONTEXT.md` rows `:186-189` plus the generation-guard gotcha at `:883-901`, `docker.ts` only at
`removeContainer` (`:259-267`), and `docker.test.ts` only with one new case. If A merges first, `git merge
origin/main` and keep both sides; nothing overlaps by line.

### What is wrong, verified at `b13ceac`

- `awaitHandoff` (`src/redeploy.ts:398-418`) reads the marker and inspects the replacement in one
  `Promise.all` (`:402-405`). `readMarker` never throws (`handoff.ts:74-83`); `tryInspectContainer` throws on
  any non-404 non-ok status and on its 60 s bound (`docker.ts:171-177`). So one 5xx rejects the poll even
  when the marker already read `ready`, the catch at `:333-342` sets `outcome = "failed"`, and the final
  removal (`:374`) force-removes a replacement that may already be stopping the original: zero bots (#433,
  state table row 15). The same catch leaves `observedAt` at its initial `0` (`:299`), so the generation
  guard (`:359-365`, `Date.parse(StartedAt) > observedAt`) is true for any running replacement and the
  removal is skipped (`:371-372`); the requester is told "I removed it" while the standby goes on to retire
  the original after the reported failure (#431, row 14). Today #431 masks #433: the skip is what stops the
  zero-bot removal. The comment at `:295-298` says the opposite of what the code does.
- A second trigger needs no poll error (row 15): the marker is read at the top of an iteration and
  `elapsedMs` is computed after the inspect returns (`:401-415`), so a `ready` written in between loses to
  `timeout` when the 120 s boundary falls in that window.
- `handoffFailureMessage` (`handoff.ts:134-164`) says "I removed it" in all three variants (`:142`,
  `:152-153`, `:162`); `RedeployResult` (`redeploy.ts:195-198`) carries no removal status; the only caller,
  `updateReply` (`src/commands.ts:396-402`), passes outcome and error. The claim is false when the guard
  skipped the removal (`:371-373`), when `removeContainer` threw (`:376-379`), and when nothing was ever
  created (`inspectSelf` or build failures, `:218-221`, `:234-239`; the error-only results reach the same
  "did not complete the handoff ... I removed it" text). (#451, rows 6, 7, 9, 14, 20, 26.)
- `redeploy.test.ts:1145-1156` ("at-or-before the decision") uses a `StartedAt` 60 s earlier, so `>` ->
  `>=` survives; no `Running: false` fixture carries a `StartedAt` (`:1123`), so deleting the
  `Running === true` conjunct (`:363`) survives (some `Running: true` fixtures carry none either, `SELF` at
  `:30`, which is why `!!StartedAt` stays); no fixture uses Docker's nanosecond fraction (the table's probe 2
  shows Bun 1.4.2 parses it; nothing pins that). (#434.)
- `CONTEXT.md:188` says `buildRemote()` is `…/<repo>.git#<branch>`, "the whole repo at the target branch";
  the code builds the exact compared sha (`redeploy.ts:225-229`) and the test at `:994-1006` pins it. The
  row's `takeOver` sequence omits `restorePolicy` (`:639`, between `tagLatest` and `retire`). (#432.)
  `CONTEXT.md:186` also says "one writer, one reader" of the marker; the original and the replacement both
  clear it (`redeploy.ts:214`, `:387`, `:641`) -- the gotcha at `:743` is bundle A's, this row is ours.

### Decisions (defaults, named so the gate can contest them)

1. **A failed inspect is not a verdict.** `awaitHandoff` catches the inspect per poll, keeps polling with
   the replacement's state unknown, and lets the marker and the deadline decide (a new
   `inspectFailed` input to the pure `decideHandoffOutcome`). One 5xx or one 60 s timeout no longer aborts a
   swap. #431's suggested fix alone (a real `observedAt` in the catch) would instead have the original
   force-remove a healthy, booting replacement on one blip; the table's row 14 and its interaction 4 are why
   this plan tolerates the blip instead. The literal fix is still made (decision 3), as the backstop's.
   **The cost, stated plainly:** a daemon that answers every poll with an error now holds the original
   quiesced (no scheduler ticks; interactions still answer) for the 120 s `HANDOFF_DEADLINE_MS`, where today
   the first failed poll un-quiesces it within one guard inspect and one removal call. Against a daemon that
   hangs rather than errors, each poll's inspect is bounded at 60 s (`docker.ts:38`) and `elapsedMs` is
   checked after it, so the worst case is about 120 + 60 s of polling plus the guard inspect and the removal
   (60 s each), about 300 s, against about 180 s today. Both are bounded, both end with the original
   serving; the difference buys never tearing down a healthy swap over a blip. The gate can contest it.
2. **What the replacement said outranks what the poll saw.** The marker is read before the inspect in every
   poll (as today), so a `ready` read in the same poll as a failed inspect already decides `ready` once
   decision 1 lands (#433's trigger is gone: nothing rejects). For row 15's race -- a `ready` written after
   a poll's marker read and before its verdict -- `redeploy()` reads the marker once more, right after
   `awaitHandoff` returns and before it acts on any verdict other than `ready`; a fresh `ready` sends it
   down the ready path (the retirement wait) instead of the removal. One re-read, in one place. The
   residual window is from the marker read before the generation guard to the `removeContainer` call: the
   guard's own inspect and the removal, milliseconds against a healthy daemon and up to the 60 s bound of
   one call against a hanging one. Named as exactly that in the docblock, `CONTEXT.md` and the state
   table; never as "one daemon call".
3. **`observedAt` is real on every path:** initialised to `now()` before the poll, replaced by the poll's
   own observation, re-sampled in the backstop catch (#431's fix as written) and after the retirement wait
   (as today). The catch's re-sample matters when the throw comes late in a long poll: without it a
   replacement restarted during the poll is judged against the pre-poll time and wrongly left alone. The
   catch can no longer be reached by the daemon stubs (the inspect is caught per poll; `readMarker` never
   throws), so a `readMarker` seam makes it reachable for its test; it stays as the #37 safety net.
4. **The result says what became of the replacement** (#451): `RedeployResult.replacement` is `"none"`
   (nothing there to remove -- never created, or already gone), `"removed"`, `"left"` (restarted after the
   verdict, left alone) or `"remove-failed"` (with `replacementError`), and `handoffFailureMessage` renders
   one tail per value. To tell `"none"` from `"removed"` on the cleanup paths, `removeContainer` returns
   whether the daemon had the container (`true` on 2xx, `false` on 404): a create the daemon rejected
   (row 9's 400 on a bad bind) is cleaned up by name, finds nothing, and must not be reported as removed.
   Optional in the type, so the test literals in `update.test.ts:277-376` and `commands.test.ts:211-217`
   still compile; every producer sets it; an absent value renders no claim about the container.
5. **Test seams on `redeploy()`'s options** (the existing `retirementOpts` object, renamed
   `RedeployOptions`): `handoffDeadlineMs` (the 120 s), `now` (the clock the verdict times and the
   generation guard use) and `readMarker` (the reads in `awaitHandoff` and in `redeploy()`). Neither `now`
   nor `readMarker` reaches `awaitRetirementFailure`, which keeps `Date.now()` and the module `readMarker`
   (`:431-434`) -- deliberately, and R6 depends on it: with a fixed clock `elapsedMs` never advances, and R6
   terminates only because `ready` is on disk and the retirement wait runs on real time. Do not "complete"
   the seam. Real callers take the defaults, as today; `update.ts:341` passes nothing.
6. **#434 is pinned with the clock seam:** a tie (`StartedAt === observedAt`) is removed, a `Running: false`
   container with a later `StartedAt` is removed, and the "restarted, left alone" fixture carries a
   nanosecond fraction. (`!!current.State.StartedAt` at `:364` is an equivalent mutant: `Date.parse(undefined)`
   is `NaN` and `NaN > x` is false. Do not chase it.)
7. **The state table and the gotcha are kept live:** rows 14, 15 and 26, the "Rows that wedge" entry for
   row 15, the #431/#433/#451 cross-check bullets, and `CONTEXT.md`'s generation-guard gotcha (`:883-901`,
   which describes `observedAt`'s sampling) are updated in the same PR.

### Step 1 -- `src/handoff.ts:117-130` (`decideHandoffOutcome`)

```ts
export function decideHandoffOutcome(o: {
  marker?: HandoffMarker;
  replacement?: ReplacementState;
  /** This poll's inspect of the replacement failed (a 5xx, a timeout): its state is UNKNOWN, which is not
   *  "gone" (#433). The marker still decides; otherwise keep waiting, and let the deadline bound it. */
  inspectFailed?: boolean;
  elapsedMs: number;
  deadlineMs?: number;
}): HandoffOutcome {
  if (o.marker?.status === "ready") return "ready";
  if (o.marker?.status === "failed") return "failed";
  if (!o.inspectFailed) {
    // Gone entirely, or stopped without ever signalling: it isn't coming back to signal now.
    if (!o.replacement) return "failed";
    if (!o.replacement.running && o.replacement.status !== "created") return "failed";
  }
  if (o.elapsedMs >= (o.deadlineMs ?? HANDOFF_DEADLINE_MS)) return "timeout";
  return "waiting";
}
```

Extend the docstring (`:110-116`): a failed inspect leaves the state unknown rather than reading as "gone".

### Step 2 -- `src/handoff.ts:132-164` (`handoffFailureMessage`)

```ts
/** What became of the `<name>-next` container after a failed swap, for the requester (#451). */
export type ReplacementDisposition = "none" | "removed" | "left" | "remove-failed";

export function handoffFailureMessage(outcome: "failed" | "timeout" | "stalled", o: {
  targetSha: string;
  error?: string;
  replacement?: ReplacementDisposition;
  replacementError?: string;
}): string {
  const short = shortSha(o.targetSha);
  const tail = replacementTail(o);
  if (outcome === "timeout") {
    // `o.error` here is the last poll's daemon error, when the last poll failed (decision 1): a deadline
    // spent on a daemon that would not answer is worth naming to the requester.
    return (
      `⚠️ The replacement for \`${short}\` never reported in within ${Math.round(HANDOFF_DEADLINE_MS / 1000)}s` +
      `${o.error ? ` (last daemon error: ${o.error})` : ""} — ${tail}`
    );
  }
  if (outcome === "stalled") {
    return (
      `⚠️ The replacement for \`${short}\` verified but never retired me within ` +
      `${Math.round(RETIREMENT_DEADLINE_MS / 60_000)}m — ${tail} Check the daemon socket.${o.error ? ` (${o.error})` : ""}`
    );
  }
  return `⚠️ The replacement for \`${short}\` did not complete the handoff${o.error ? `: ${o.error}` : ""} — ${tail}`;
}

/** One clause per disposition, lowercase so it follows a dash; every one ends on "the current build",
 *  which is the headline. */
function replacementTail(o: { replacement?: ReplacementDisposition; replacementError?: string }): string {
  switch (o.replacement) {
    case "none":
      return "nothing was left to clean up, and I stayed on the current build.";
    case "removed":
      return "I removed it and stayed on the current build.";
    case "left":
      return "it restarted after I had decided, so I left it alone (check `docker ps` for the `-next` container) and stayed on the current build.";
    case "remove-failed":
      return `I could not remove it${o.replacementError ? ` (${o.replacementError})` : ""}: remove the \`-next\` container by hand. I stayed on the current build.`;
    default:
      return "I stayed on the current build.";
  }
}
```

Keep the existing comments on why `stalled` is distinct and why `failed` is outcome-neutral (`:145-149`,
`:156-159`), moved to sit with the branches.

### Step 3 -- `src/redeploy.ts`

- **`RedeployResult`** (`:194-198`):

  ```ts
  /** Only ever a failure: a redeploy that *works* kills this process before it can return. */
  export interface RedeployResult {
    outcome?: HandoffOutcome;
    error?: string;
    /** What became of the `<name>-next` container (#451): never created, removed, left alone because it
     *  restarted after the verdict (the generation guard), or still there after a failed removal. */
    replacement?: ReplacementDisposition;
    /** Set with `remove-failed`: the daemon's answer. */
    replacementError?: string;
  }

  /** Test seams; real callers take every default. */
  export interface RedeployOptions {
    /** `RETIREMENT_DEADLINE_MS`: the post-`ready` retirement wait. */
    deadlineMs?: number;
    /** `POLL_MS`: the interval of both the handoff poll and the retirement wait. */
    pollMs?: number;
    /** `HANDOFF_DEADLINE_MS`: how long the original waits for a verdict. */
    handoffDeadlineMs?: number;
    /** The clock the verdict times and the generation guard use. Not the retirement wait's, which keeps
     *  `Date.now()` -- see the plan's decision 5. */
    now?: () => number;
    /** The marker reads in the handoff poll and in `redeploy()`; not the retirement wait's. */
    readMarker?: typeof readMarker;
  }
  ```

  Import it with `import type { ..., ReplacementDisposition } from "./handoff"` -- `tsconfig.json` sets
  `verbatimModuleSyntax`, so a type must be imported as one (`HandoffOutcome` at `:37` shows the shape).
  `HANDOFF_DEADLINE_MS` is a value import, added to the existing `./handoff` list (`:28-38`).
  `ContainerInspect` is already imported (`:24`).
- **`src/docker.ts:259-267` `removeContainer`** returns whether the daemon had the container:

  ```ts
  /** `true` when the daemon removed it, `false` when it had nothing by that id or name (404) -- a removal
   *  that already happened is not an error, but a caller reporting what it cleaned up needs to know (#451). */
  export async function removeContainer(id: string, force = false, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
    const params = new URLSearchParams(force ? { force: "1" } : {});
    return bounded(timeoutMs, `rm ${id}`, async (s) => {
      const res = await api(`/containers/${encodeURIComponent(id)}?${params}`, s, { method: "DELETE" });
      if (res.status === 404) return false;
      if (!res.ok) {
        throw new Error(`docker rm ${id} failed: ${res.status} ${clampUpstreamBody(await res.text())}`);
      }
      return true;
    });
  }
  ```

  Every existing caller `await`s it for its effect only (`redeploy.ts:263`, `:286`, `:374`, `:506`), so none
  changes. Bundle A touches `docker.ts:248` (two lines above); this hunk starts at `:259`, so the two merge
  cleanly. One `docker.test.ts` case pins the return (D1 below); bundle A's own `docker.test.ts` addition is
  a stop-request test elsewhere in the file.
- **`redeploy(latestSha, opts: RedeployOptions = {})`** (`:208-213`): `const now = opts.now ?? Date.now;
  const read = opts.readMarker ?? readMarker; const pollMs = opts.pollMs ?? POLL_MS;`. **The ready branch's
  own call at `:316`, `awaitRetirementFailure(retirementOpts.deadlineMs, retirementOpts.pollMs)`, becomes
  `awaitRetirementFailure(opts.deadlineMs, pollMs)`** -- the parameter is renamed, and that is the one other
  place the old name appears (`:212`, `:316`). Every result gains `replacement`:
  - `:220` -> `return { error: ..., replacement: "none" };`
  - `:238` -> `return { error: ..., replacement: "none" };`
  - `:286-290`: record what the cleanup found:

    ```ts
      let replacement: ReplacementDisposition = "none";
      let replacementError: string | undefined;
      try {
        // By name when there is no id (#130, see above). The daemon may have nothing by that name (a create
        // it rejected outright): then nothing was started and the requester must not hear "removed".
        replacement = (await removeContainer(replacementId ?? name, true)) ? "removed" : "none";
      } catch (cleanupErr) {
        replacement = "remove-failed";
        replacementError = (cleanupErr as Error).message;
        console.error(`[redeploy] could not clean up the failed replacement: ${replacementError}`);
      }
      endHandoff();
      return { error: `could not start the replacement: ${(err as Error).message}`, replacement, ...(replacementError !== undefined ? { replacementError } : {}) };
    ```

  - The verdict (`:294-342`) becomes:

    ```ts
    let outcome: HandoffOutcome;
    // #431: the verdict's own time. Sampled before the poll, replaced by the poll's observation, re-sampled
    // after the retirement wait and in the backstop catch -- never left at epoch 0, which made the generation
    // guard below read EVERY running replacement as a later life and skip the removal.
    let observedAt = now();
    let pollError: string | undefined;
    try {
      const decided = await awaitHandoff(replacementId, {
        deadlineMs: opts.handoffDeadlineMs ?? HANDOFF_DEADLINE_MS,
        pollMs,
        now,
        readMarker: read,
      });
      outcome = decided.outcome;
      observedAt = decided.observedAt;
      // Set only when the LAST poll's inspect failed: a deadline spent on a daemon that would not answer is
      // named to the requester; an error the daemon recovered from is not blamed for a silent replacement.
      if (outcome === "timeout") pollError = decided.lastPollError;
      if (outcome !== "ready") {
        // Row 15 of the state table: a `ready` written after that poll's marker read and before its
        // verdict would otherwise lose to `timeout` or `failed`. What the replacement SAID outranks what
        // the poll saw, so read once more before acting on anything else.
        const late = await read();
        if (late?.status === "ready") {
          console.warn(`[redeploy] the replacement signalled ready as the poll decided ${outcome} — honouring it`);
          outcome = "ready";
          pollError = undefined;
        }
      }
      if (outcome === "ready") {
        ... the existing ready branch (:303-332): same log lines, `awaitRetirementFailure(opts.deadlineMs, pollMs)`,
        failed|stalled, then `observedAt = now();` with its #160 comment (:323-331) kept ...
      }
    } catch (err) {
      // The #37 safety net. Nothing above throws through the daemon stubs any more (awaitHandoff catches
      // the inspect per poll, readMarker never throws), so this is reached only by something new; it still
      // un-quiesces on every exit, and it judges the replacement against the moment it fired (#431) -- a
      // throw late in a long poll must not leave the guard comparing against the pre-poll time.
      pollError = (err as Error).message;
      console.error(`[redeploy] handoff decision failed: ${pollError} — reclaiming`);
      outcome = "failed";
      observedAt = now();
    }

    const marker = await read();
    let replacement: ReplacementDisposition = "removed";
    let replacementError: string | undefined;
    try {
      ... the generation guard (:346-370) unchanged ...
      if (restartedSinceDecision) {
        replacement = "left";
        console.warn(`[redeploy] replacement restarted after we decided ${outcome} — leaving it alone`);
      } else {
        // The window this plan leaves open: a `ready` written after the read above and before this call --
        // the guard's inspect plus this removal, milliseconds against a healthy daemon, up to one 60 s bound
        // against a hanging one -- removes a replacement mid-retire. Named in CONTEXT.md and the table.
        replacement = (await removeContainer(replacementId, true)) ? "removed" : "none";
      }
    } catch (err) {
      replacement = "remove-failed";
      replacementError = (err as Error).message;
      console.error(`[redeploy] could not remove the replacement: ${replacementError}`);
    } finally {
      endHandoff();
      await clearMarker();
    }
    console.warn(`[redeploy] handoff ${outcome} — staying on the current build (replacement: ${replacement})`);
    return { outcome, error: pollError ?? marker?.error, replacement, ...(replacementError !== undefined ? { replacementError } : {}) };
    ```

  Rewrite the comment at `:295-298` to the one above (it currently claims the opposite). Keep the #160
  comment on the re-sample after the wait (`:323-331`).
- **`awaitHandoff`** (`:393-418`):

  ```ts
  /** Poll the marker and the replacement's state until one of them decides it. `observedAt` is the time of
   *  the observation that produced the terminal outcome (#160), the baseline the generation guard in
   *  `redeploy()` compares the replacement's later `StartedAt` against. A failed inspect (#433) is not a
   *  verdict: the marker, read first, still decides; otherwise the state is unknown for this poll and the
   *  deadline bounds how long that can go on. `lastPollError` is the LAST poll's inspect error, or
   *  undefined when the last poll's inspect worked. */
  async function awaitHandoff(
    replacementId: string,
    o: { deadlineMs: number; pollMs: number; now: () => number; readMarker: typeof readMarker },
  ): Promise<{ outcome: HandoffOutcome; observedAt: number; lastPollError?: string }> {
    const startedAt = o.now();
    let lastPollError: string | undefined;
    for (;;) {
      const observedAt = o.now();
      const marker = await o.readMarker();
      let container: ContainerInspect | undefined;
      let inspectFailed = false;
      try {
        container = await tryInspectContainer(replacementId);
        if (lastPollError !== undefined) console.log("[redeploy] the replacement's state is readable again");
        lastPollError = undefined;
      } catch (err) {
        inspectFailed = true;
        const message = (err as Error).message;
        if (lastPollError === undefined) console.warn(`[redeploy] could not inspect the replacement (${message}); still waiting on the marker`);
        lastPollError = message;
      }
      const outcome = decideHandoffOutcome({
        marker,
        replacement: container && { running: container.State.Running, status: container.State.Status, exitCode: container.State.ExitCode },
        inspectFailed,
        elapsedMs: o.now() - startedAt,
        deadlineMs: o.deadlineMs,
      });
      if (outcome !== "waiting") return { outcome, observedAt, lastPollError };
      await Bun.sleep(o.pollMs);
    }
  }
  ```

  `awaitRetirementFailure` (`:427-437`) is unchanged, and keeps `Date.now()` and the module `readMarker`
  (decision 5).

### Step 4 -- callers

- `src/commands.ts:401`: `return handoffFailureMessage(kind, { targetSha: latestSha, error: o.redeploy.error,
  replacement: o.redeploy.replacement, replacementError: o.redeploy.replacementError });`
- `src/update.ts:349`: `` console.warn(`[update] redeploy to ${shortNew} failed: ${result.error ?? result.outcome} (replacement: ${result.replacement ?? "unknown"})`); ``
- Grep `src/`, `README.md`, `ops/README.md` and `CONTEXT.md` for `I removed it` and `removed it and stayed`:
  nothing else quotes the sentence at `b13ceac` (checked), but confirm on your tree.

### Step 5 -- docs, in the same PR

- `CONTEXT.md:188` (`src/redeploy.ts` row; grep `The swap itself.` and anchor each Edit on one line's worth
  of text): "(`buildRemote()` = `…/<repo>.git#<branch>`, the whole repo at the target branch, tagged" ->
  "(`buildRemote()` = `…/<repo>.git#<sha>`, the whole repo at the exact compared sha — never the branch
  tip, so a push landing in the fetch window cannot ship newer code stamped with the older `GIT_SHA` —
  tagged" (#432). "poll until `decideHandoffOutcome()` settles" -> "poll until `decideHandoffOutcome()`
  settles — a failed inspect leaves the replacement's state unknown for that poll rather than reading as
  gone, and `redeploy()` reads the marker once more before acting on any verdict but `ready`, so a late
  `ready` wins (#433); the verdict's time is what the generation guard judges a restarted replacement
  against, never epoch 0 (#431); the result's `replacement` says what became of the `-next` container
  (#451). One window stays: a `ready` written between the marker read before the generation guard and the
  removal — that guard's inspect plus the removal call, milliseconds against a healthy daemon, up to one 60 s
  call bound against a hanging one". "applies `latestTag()`
  onto its own now-verified image via `tagImage()` (best-effort — a tag hiccup must not fail an
  otherwise-successful handoff), then `retireOriginal()`" -> insert ", then restores the original's
  restart policy onto itself (`restorePolicy`, #160 — not best-effort: a throw writes `failed` and exits),"
  before "then `retireOriginal()`" (#432).
- `CONTEXT.md:186` (`src/handoff.ts` row): "(its own file, never `state.json` — one writer, one reader)" ->
  "(its own file, never `state.json` — one writer, the replacement; read by the original, cleared by
  both)"; add `inspectFailed` to the `decideHandoffOutcome()` sentence and `ReplacementDisposition` to the
  `handoffFailureMessage()` mention.
- `CONTEXT.md:187` and `:189` (the two test rows): append the new cases in each row's style. The
  `src/docker.ts` row (grep `| \`src/docker.ts\` |`): `removeContainer` now returns whether the daemon had
  the container.
- `CONTEXT.md:883-901`, the generation-guard gotcha (grep `observedAt`): it says `observedAt` is the poll's
  own timestamp for `failed`/`timeout` and re-sampled after the retirement wait; add that it starts as the
  pre-poll time and is re-sampled in the backstop catch too, so it is never epoch 0 (#431), and that a
  failed poll no longer reaches that catch (#433).
- `docs/plans/epics/E516/525-handoff-state-table.md`: row 14's "Recovered by" -> "a failed inspect no
  longer decides anything (S1): the poll continues and the marker or the deadline decides; a replacement
  judged `failed`/`timeout` is removed against a real verdict time; the cost is that a daemon erroring for
  the whole window holds the original quiesced for the 120 s deadline"; row 15 -> "closed by S1's marker
  re-read before any non-`ready` verdict is acted on; the residual window is the generation guard's inspect
  plus the removal call (one 60 s bound at worst)"; the "Rows that wedge" entry for row 15 (`:168-169`) ->
  the same, in one line; row 26 -> the result now says `remove-failed`/`left`/`none` and the requester is
  told so; the cross-check bullets for #431, #433, #451 -> one line each naming this PR. Nothing else in the
  file.

### Step 6 -- tests

`src/handoff.test.ts` (`decideHandoffOutcome` describe, `:37-96`; `handoffFailureMessage`, `:98-143`):

| # | Test | Pins |
|---|---|---|
| H1 | "a failed inspect is not a verdict: waiting before the deadline, timeout at it" | `{ inspectFailed: true, elapsedMs: 0 }` -> `waiting`; `{ inspectFailed: true, replacement: undefined, elapsedMs: 0 }` -> `waiting` (not `failed`); `{ inspectFailed: true, elapsedMs: HANDOFF_DEADLINE_MS }` -> `timeout` |
| H2 | "the marker still decides when the inspect failed" | `{ marker: ready, inspectFailed: true }` -> `ready`; `{ marker: failed, inspectFailed: true }` -> `failed` |
| H3 | "a replacement seen exited is still failed when the inspect worked" (the existing `:58-64` cases, unchanged -- cite them) | -- |
| H4 | `handoffFailureMessage` / "says what became of the replacement, per disposition, for every outcome" | for each outcome: `replacement: "none"` -> contains `nothing was left to clean up`, not `removed it`; `"removed"` -> `removed it`; `"left"` -> `left it alone` and `-next`; `"remove-failed"` with `replacementError: "409 Conflict"` -> `could not remove it`, `409 Conflict`, `by hand`; `undefined` -> none of `removed it`/`left it alone`/`could not remove`; every variant contains `current build` (extend `:138-142`) |
| H5 | "a timeout names the last daemon error when there was one" | `handoffFailureMessage("timeout", { targetSha, error: "docker inspect c failed: 500" })` contains `last daemon error: docker inspect c failed: 500`; without `error` it does not contain `last daemon error` |

`src/redeploy.test.ts` (in the `redeploy — cleanup always runs` describe; the `stubDaemon` harness
`:783-844`). The harness cannot tell a poll from the pre-removal inspect: both hit
`/containers/<id>/json` and the same `o.pollReplacement()` (`:839`), so a test that needs different
answers counts calls in its own closure, exactly as `:1118-1136` and `:1172-1189` do today. Two harness
changes only: widen `pollReplacement` to `() => Response | Promise<Response>` (`:784`; `:839` already
sits in an async function, so `return o.pollReplacement()` stays), because R4's closure awaits
`writeMarker`, and `tsconfig.json` type-checks `src/**` test files; and add `selfInspectFails?: boolean`,
which makes the `/containers/${HOSTNAME}/json` line (`:814`) answer 500. `afterStart` runs inside the
awaited `/start` handler (`:834-837`), so a marker it writes is on disk before the first poll.

| # | Test | Pins |
|---|---|---|
| R1 | replaces `:915-925`: "a single failed inspect mid-poll is tolerated — the next poll decides, the error is not the verdict, and the verdict's own time is what the guard uses" | `pollMs: 30`; closure counter: call 1 -> 500 (record `t1 = Date.now()` first); call 2 -> `exited` (the verdict); call 3, the pre-removal inspect -> running with `StartedAt: new Date(t1 + 5).toISOString()` (after the pre-poll sample, before the deciding poll's observation); `result.outcome` `failed`; `result.error` undefined (the 500 did not become the verdict); the counter is 3; removal attempted (a StartedAt before the verdict's observation is the same life); `handoffActive()` false |
| R2 | "every poll failing until the handoff deadline is a timeout that names the last error; the handoff ends and the replacement is removed" | `pollReplacement` always 500; `redeploy(sha, { handoffDeadlineMs: 50, pollMs: 10 })`; `outcome` `timeout`; `error` contains `500`; removal attempted (the guard's own inspect also fails and "proceeds as usual"); `handoffActive()` false |
| R2b | "an error the daemon recovered from is not blamed for a timeout" | `handoffDeadlineMs: 80, pollMs: 10`; call 1 -> 500, every later call -> running; `outcome` `timeout`; `error` undefined |
| R3 | "#433: a ready marker decides in the same poll as a failed inspect — one poll, not a wait for the deadline" | `afterStart` writes `ready`; `pollReplacement` always 500; `{ handoffDeadlineMs: 200, deadlineMs: 60, pollMs: 15 }`; `outcome` `stalled` (ready honoured, then the retirement wait elapsed), not `failed`; exactly 2 GETs to `/containers/<id>/json` in `calls` (the one poll, then the pre-removal inspect) -- more means the first poll did not decide; removal attempted (as `:1097-1110`) |
| R4 | "row 15: a ready written during the deciding poll beats the deadline" | `{ handoffDeadlineMs: 0, deadlineMs: 60, pollMs: 15 }`; `pollReplacement` on its first call `await writeMarker({ status: "ready", ... })` then returns running (the top-of-poll read saw nothing; elapsed is already past the 0 ms deadline, so the poll decides `timeout`; the re-read in `redeploy()` must turn it into `ready`); `outcome` `stalled`, never `timeout` |
| R5 | "the #37 backstop still ends the handoff and judges the replacement against the moment it fired, not the pre-poll time (#431)" | `readMarker` seam: returns `undefined` on calls 1-2, throws on call 3 (the third poll's read), `undefined` afterwards; `pollMs: 30`; polls 1-2 -> running without `StartedAt` (waiting); record `t1` at poll 1; the pre-removal inspect -> running with `StartedAt: new Date(t1 + 5).toISOString()`; `outcome` `failed`; `error` contains the thrown message; removal attempted (the catch's `observedAt` is after `t1 + 5`; the pre-poll time is not); `handoffActive()` false |
| R6 | "#434: a StartedAt equal to the verdict time is the same life, removed" | `now: () => T` (a fixed `T = Date.now()` captured before the call); `afterStart` writes `ready`; `pollReplacement` returns running with `StartedAt: new Date(T).toISOString()`; `{ deadlineMs: 60, pollMs: 15 }`; `outcome` `stalled` (the retirement wait runs on real time, decision 5); removal attempted |
| R7 | "#434: a later StartedAt on a container that is not running is removed, not left alone" | closure counter: call 1 -> `exited` (the verdict); call 2, the pre-removal inspect -> `{ Running: false, Status: "exited", ExitCode: 1, StartedAt: new Date(Date.now() + 5_000).toISOString() }`; removal attempted; `result.replacement` `removed` |
| R8 | `:1117-1140` ("restarted after we decided ... left alone"): the fixture's `StartedAt` carries Docker's nanosecond fraction | `` `${new Date(Date.now() + 5).toISOString().slice(0, -1)}000000Z` `` (nine fractional digits); still left alone; `result.replacement` `left` |
| R9 | "the result says what became of the replacement (#451)" | `selfInspectFails` -> `replacement` `none` (the fallback also fails: on this box `/proc/self/mountinfo` is absent, on Linux it holds no container id outside Docker and an id would hit an unstubbed path -- assert only the result, never the reason); `buildFails` -> `none`; `startFails` + cleanup 204 -> `removed`; `startFails` + cleanup DELETE 404 -> `none` (a create the daemon never acted on); `startFails` + cleanup DELETE 500 -> `remove-failed` with `replacementError` containing `500`; the `:929-938` 409 case -> `remove-failed`, `replacementError` contains `409`; the ordinary exited case with removal 204 -> `removed`, with removal 404 -> `none` |

`src/docker.test.ts` (one case, beside the existing `removeContainer` coverage in the `daemon calls`
describe, `:84-`; bundle A adds a stop-request case to the same file, elsewhere):

| # | Test | Pins |
|---|---|---|
| D1 | "removeContainer says whether the daemon had the container" | 204 -> resolves `true`; 404 -> resolves `false`; 500 -> rejects (as today) |

`src/commands.test.ts` (`:211-217`):

| # | Test | Pins |
|---|---|---|
| C1 | "the /update failure reply says what became of the replacement" | `updateReply("restart", SHA, { redeploy: { outcome: "failed", replacement: "left" } })` contains `left it alone`; `{ outcome: "timeout", replacement: "removed", error: "docker inspect x failed: 500" }` contains `removed it` and `last daemon error: docker inspect x failed: 500`; `{ outcome: "failed", replacement: "none" }` does not contain `removed it`; `{ outcome: "failed", replacement: "remove-failed", replacementError: "409" }` contains `409` |

### Coverage table

| Outcome | Step | Test | Mutation that must turn it red |
|---|---|---|---|
| one failed inspect does not decide the swap | 1, 3 | R1 | M1: remove the per-poll `try`/`catch` in `awaitHandoff` (the 500 throws to the backstop: `error` becomes `500`) |
| an unanswering daemon ends in `timeout`, not a false `failed` | 1, 3 | R2, H1 | M2: delete the `if (!o.inspectFailed)` guard (an undefined replacement reads as failed) |
| a recovered error is not blamed for a timeout | 3 | R2b | M2b: drop `lastPollError = undefined` on a successful inspect |
| a `ready` marker outranks a failed inspect, in that same poll | 1, 3 | R3, H2 | M3: in `awaitHandoff`, skip `readMarker` when the inspect failed (R3's GET count climbs past 2; the late re-read would still rescue the outcome, which is why the count is the assertion) |
| a late `ready` beats the deadline | 3 | R4 | M4: delete the re-read in `redeploy()` (R4 ends `timeout`) |
| the verdict's own time is what the guard uses | 3 | R1, R5 | M5a: delete `observedAt = decided.observedAt;` (R1's `t1 + 5` StartedAt is now after the pre-poll sample: left alone); M5b: drop `observedAt = now()` from the backstop catch (R5's `t1 + 5` is after the pre-poll sample: left alone); M5c: `let observedAt = 0` (R5 red as well) |
| a tie is the same life, removed | 3 | R6 | M6: `>` -> `>=` at the guard |
| only a running later life is left alone | 3 | R7 | M7: delete the `current?.State.Running === true &&` conjunct (`!!current.State.StartedAt` is equivalent and not chased, decision 6) |
| Docker's nanosecond `StartedAt` parses | 3 | R8 | (a format pin: if `Date.parse` returned `NaN` the guard would never skip and R8 goes red; no source mutation) |
| the requester is told what became of the replacement | 2, 3, 4 | R8, R9, H4, C1, D1 | M8: set `replacement = "removed"` on the `left` branch (R8 red); M9: drop `replacement` from the `none` results (R9); M9b: `removeContainer` returns `true` on 404 (D1 and R9's 404 rows); M10: `commands.ts` stops passing `replacement` (C1 red) |
| a timeout names the last daemon error | 2, 3 | H5, C1, R2 | M11: drop `o.error` from the `timeout` branch (H5, C1); M11b: drop `pollError = decided.lastPollError` (R2's `error` undefined) |
| every failure message still names the current build | 2 | H4 | M12: drop "current build" from one tail |
| the `[update]` log names the disposition | 4 | -- (a log line; no test) | -- |
| the docs say what the code does | 5 | manual: reviewer B reads every edited row, the gotcha and the table rows against the code | -- |

Run every mutation in a scratch copy (`git worktree add --detach <path> <sha>`), never in the tree the
tests or a reviewer are reading. Paste the red test's name per row in the PR. `bun test src/redeploy.test.ts`
alone is a few seconds; the full `bun test` from the repo root is the check that counts.

### Checks, gate, PR

- `bun run check`; `bunx tsc --noEmit -p ops/tsconfig.json`; `bun run check` inside `ops/admin/`;
  `bun test` from the repo root, then `bun test --randomize` once. Name CI's Linux run as the evidence for
  the `ops/*` suites that skip here. The PR is not ready until CI is green.
- Review gate: reviewer A on correctness and failure modes (walk rows 14, 15 and 26 of the state table
  against the new code; the residual window as decision 2 states it; the longer quiesce decision 1 buys
  and whether its cost is stated accurately in the PR; the `now` seam's effect on `elapsedMs` when a test
  fixes the clock; the `readMarker` seam never reaching production; `removeContainer`'s new return against
  every caller); reviewer B on claims-vs-code, walking the coverage table, every edited comment, the
  `CONTEXT.md` rows and gotcha, and the table rows against the merged tree. Both read-only, both handed the
  merged tree, the five issues and the state table. Fix or decline every evidenced finding in writing;
  re-run the gate on the whole merged state after a behaviour fix.
- Branch `fix/525-S1-swap-verdict`; commit and PR title
  `fix(redeploy): let the marker outrank a failed poll, judge the replacement against a real verdict time, and say what became of it (#431, #433, #451, #434, #432)`.
  Body: one line each `Closes #431`, `Closes #433`, `Closes #434`, `Closes #451`, `Closes #432`; the pasted
  checks; the mutation rows; the gate's rounds; decisions 1-7 named as assumptions taken (decision 1's
  departure from #431's suggested fix, and the longer quiesce it costs, in their own paragraph, with the
  table's rows 14 and 15 as the reason); the residual window as decision 2 states it; the `docker.ts`
  touch (`removeContainer`'s return) named as #525's own file shared with bundle A's `:248` edit. Do not
  merge.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot. Work in a NEW worktree, never the shared checkout:
  git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-525-S1 origin/main -b fix/525-S1-swap-verdict
Issues: Rackbops/rackbops-discord-bot #431 #433 #451 #434 #432 (sub-epic #525 of Epic #516). Read each issue body first, and rows 14, 15 and 26 of docs/plans/epics/E516/525-handoff-state-table.md (on main).
Plan: docs/plans/epics/E516/525-S1-swap-verdict.md on branch claude/525-plans:
  git -C S:\Repos\rackbops-discord-bot show origin/claude/525-plans:docs/plans/epics/E516/525-S1-swap-verdict.md
Behaviour change: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Every mutation in a scratch worktree. Scratch files: task-unique names (pr-body-525S1.md, commit-msg-525S1.txt), read back before use. Report the PR link, the pasted checks, the mutation table, the gate's rounds and any deviation. Do not merge.
```
