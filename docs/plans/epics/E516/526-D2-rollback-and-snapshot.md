<!-- Plan for #526 bundle D2 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #526): what the replacement leaves for
the original -- #558 (a rolled-back original re-updates to the build it was rolled back from), #507 (the replacement's
import-time `state.json` snapshot drops the original's last writes), and #506 items 10, 11 and 14 (the handoff marker is
not bound to its swap, the `bootMode` comment and test name are stale, the verify timer's start is #492's). Written by
the orchestrating session on 2026-10-16 against Sub #2's D1a branch `fix/526-D1a-attempt-record` (PR #580, in its gate),
first at `82463ba`, re-anchored at `4b4aeef` (round-2 fix `cac42be` plus a merge of main `ea4fdda`) and then at
`9b9fb1b` (D1a's round 3: `reportUpdateOutcome(client, resolution, deliverers, owed = owedReportNow())` delivers only
the report object it was handed, and `interrupted` is marked in place), because D2 builds on D1a's `swapInFlight`
record and `resolveUpdateAttempt`. Every `file:line` below was read at that D1a head; D1a's gate may still move them,
so the implementer re-reads each anchor on the tree it works from (which starts from main AFTER D1a has merged).
Audited read-only before it was committed in two rounds (a Sonnet agent, 200 tool calls over both; round 2 applied
every production snippet to a copy of the D1a head and ran 40 mutants, all killed, and the whole `src` suite, green);
every finding was applied -- round 2 found no blocker and nine minors (the README clause, two more `interrupted`
windows named in Decision 4, D1a's in-place marking, the `awaitRetirementFailure` wiring, anchors), and round 1: `readJsonOrFresh` moves a corrupt file aside itself, so
the reload keeps that and the test says so; the default `reload` effect ran the real reload against the test dir's
`state.json` inside eight existing `takeOver` tests (polluted by `dataIsolation.test.ts`'s saved probe), so every
existing call stubs the two new effects and the tests that touch the file restore it; D1a's round 2 dropped
`resolution` from `decideUpdateOutcome` and put the `interrupted` verdict on the report, so `rolled-back` rides on the
report too; the record protects only a swap between two builds that both carry this change, and the README says so
instead of dropping the `AUTO_UPDATE=false` advice outright; `replacementId` is written only when `HOSTNAME` is the
12-hex id; `completeTakeOver` clears once; `markerFor` warns once per foreign id per attempt; five mutation rows added. -->

## Implementation plan -- #526 D2: the replacement adopts the original's last state before it writes, records who it retired, and a rolled-back original stops auto-updating to the build it was rolled back from; the marker is bound to its swap

Children: **#558** (closes, for a swap between two builds that both carry this change -- the first swap INTO this
change is named as unprotected, below), **#507** (closes; `state-storage-shutdown-1` in #509 and `github-announce-13`
in #500 are the same root cause and are closed by reference, per #526's fix-once), **#506** items 10, 11 and 14 (item 14
by reference to S3b-2, PR #570; with D1a's 12 and 13 merged first, every item is done and #506 closes). One PR, branch
`fix/526-D2-rollback-and-snapshot`, worktree `S:\Repos\_wt\rdb-526-D2` cut from `origin/main` AFTER D1a (PR #580) has
merged. Behaviour changes in the swap and the boot path -> the **three-reviewer gate** applies; every changed
production line mutation-tested in a scratch worktree (never the shared tree). Prerequisite: D1a on main (this plan
edits the lines D1a adds).

### What is wrong, verified at the D1a head `4b4aeef`

- **#558.** A swap that lands never persists `attemptedUpdateToSha` for the original to find: the original (O) arms
  it before the build (`src/update.ts:325-337`), the replacement (R) boots with that snapshot and its first `current`
  check clears it, and D1a's `resolveUpdateAttempt` (`:471-517`) resolves R's copy of `swapInFlight` as `landed` and
  clears it. After S3a's rollback (`docker stop <name>-next`, `docker start <name>`), O boots from the SHARED
  `state.json` (both containers mount the `state:/app/data` volume) with nothing armed, and with `AUTO_UPDATE=true`
  its first check sees the newer sha and rebuilds the build it was just rolled back from. `README.md:99` says so and
  tells the operator to set `AUTO_UPDATE=false` after a rollback. The issue's suggested shape (O persists
  `retiredBySha` when it sees `ready`) is racy: O polls the marker every 2 s (`redeploy.ts`'s `POLL_MS`), and R stops
  O within milliseconds of writing `ready` (`takeOver`, `redeploy.ts:944-952`: write, `restorePolicy`, `retire`), so
  O may never see `ready`; and R's first save (from its own snapshot) would overwrite anything O managed to write
  (#507). The record has to come from R, after the stop.
- **#507.** R loads `state.json` once, at import (`src/state.ts`, `export const state = await loadStateFrom(STATE_FILE)`),
  and writes nothing until it has taken over -- then its first save (`reportUpdateOutcome`'s clear, a release poll's
  `persist`, D1a's `resolveUpdateAttempt`) re-serialises the WHOLE object (`saveState`, `state.ts`), so a release id O
  persisted after R's import (a tick still running while R booted, `README.md:97`, `:101`) is dropped and that
  release is re-announced by R's first poll (handoff state table rows 10 and 14,
  `docs/plans/epics/E516/525-handoff-state-table.md:135`, `:144`; `CONTEXT.md:237` names "#507, open" as a way a
  release can re-post). The moment to re-read is after `retire(originalId)` returns in `takeOver` (`:952`): O is
  stopped (`stopContainer` blocks until it is down, `docker.ts:371-380`; `retireOriginal` re-inspects a late answer),
  and O's shutdown drain awaited its in-flight state write (its tick and `/update` writes sit inside `withCritical`,
  `announce.ts:308`, `commands.ts:113`), so the file holds O's last COMPLETED write (if the 8 s grace expires O exits
  mid-write and the file is the previous complete version, temp+rename) and R has not written yet (R writes no
  `state.json` before `takeOver`: the `ready` marker is `handoff.json`, and `ready.ts` runs `takeOver` before
  `activate`).
- **#506 item 10.** `HandoffMarker` (`src/handoff.ts:60-68`) carries `status`, `sha`, `error`, `at`; its header
  (`:7-11`) says "exactly one process writes it ... the original reads it and clears it, never writes it", while R
  writes from two sites (`src/index.ts:84-89`, the verify timer; `takeOver`, `:944` and the `failed` write in its catch
  `:964`) and both O (`redeploy()`, before the create and after a failed attempt) and R (`takeOver`, `:953`) clear it;
  `CONTEXT.md:190` says "one writer, two clearers". Nothing reads `sha` or `at` (Grep: `readMarker` validates
  `status` only, `:85-94`; `redeploy()` reads `marker?.error`). A `ready` or `failed` left by a surviving EARLIER
  replacement (one that restarted under its restored policy, or one from an attempt the daemon lost) is taken for
  the current attempt's verdict at the four read sites in `redeploy.ts` -- `awaitHandoff`'s poll (`:674`), the late
  re-read (`:530`), the final read (`:595`) and the retirement wait (`awaitRetirementFailure`, `:721-`) -- because
  nothing says which container wrote it.
- **#506 item 11.** `handoff.ts:16`: "Its presence *is* the instruction to boot in standby"; `handoff.test.ts:24`:
  "HANDOFF_FROM is the whole instruction to boot in standby". Since #46 `index.ts` boots on `resolveBootMode`
  (`redeploy.ts:1198-`), which confirms the env against the daemon, because the env never clears from a swapped-in
  container; `bootMode` is the raw check (`CONTEXT.md:190` already says "raw ... necessary but not sufficient").
- **#506 item 14.** Fixed by S3b-2 (PR #570): the verify timer is armed at `index.ts`'s module top (`:80-92`) with
  the bounded boot awaits inside it, the deadline constants are pinned (`handoff.test.ts:224-235`). Closed by
  reference; nothing to do here.

### Decisions (defaults, named so the gate can contest them)

1. **R adopts the file before its first write.** `reloadState()` (`state.ts`) re-reads `state.json` through
   `readJsonOrFresh` (the function `loadStateFrom` uses) and replaces the shared object's keys in place (every importer
   holds that one object). An absent file keeps the snapshot and logs; a file that will not parse is moved aside by
   `readJsonOrFresh` itself (`storage.ts:152-156`, as at load -- the evidence survives R's next save) and the snapshot
   is kept and the log says so; a file that parses but is not a state object keeps the snapshot. A reload never turns
   a good snapshot into an empty one. `takeOver` calls it right after `retire(originalId)` returns and before `clear()`;
   it is best-effort there (logged, never a `failed` marker: the original IS stopped by then, and `takeOver`'s catch
   says it was not).
2. **R records who it retired, in the shared file, after the reload:** `state.retiredBy = { sha: <R's gitSha>,
   originalSha: <O's sha>, at }`, where O's sha is the reloaded `swapInFlight.fromSha` (O armed it before the build,
   D1a). When there is no record to read -- O ran a build before D1a, or O's failure tail cleared it (state table row
   14: "swap lands after reported failure") -- nothing is written and ONE log line says so; when `state.retiredBy`
   already names this build as `sha` (R restarting during its probation, after its first life recorded and then
   resolved the swap record as `landed`) nothing is written and nothing is logged. The key is additive; A and P keep
   their meanings. `completeTakeOver` clears it once the original is gone (a successful removal, or an original that
   was already gone -- one clear, on the one path both take); a failed removal (the corpse stays) and a step-aside
   leave it, since `docker start <name>` is still possible.
3. **A boot that finds `retiredBy` naming its own sha as the ORIGINAL is a rollback:** `resolveUpdateAttempt` checks it
   before the swap record. It arms `attemptedUpdateToSha` with the build it was rolled back from (so the automatic
   check skips it until a newer commit lands; `/update`'s `force` applies it anyway), marks the owed report
   `rolledBack` when it is the one this swap armed, clears `retiredBy` and any `swapInFlight` left over (R took over,
   so the swap did land; the record is moot and no probe is made), saves ONCE, logs, and resolves `rolled-back`, a new
   `AttemptResolution`. The report is then delivered as a new outcome `rolled-back` ("the update to X landed and was
   rolled back ... automatic updates skip X; run /update to apply it"), read from `report.rolledBack` the way
   `interrupted` is read from `report.interrupted` (D1a round 2), so a boot that dies between resolving and delivering
   still says the truth. A boot that finds `retiredBy` naming its own sha as the REPLACEMENT (R restarting during
   probation, or after a removal failed) leaves it and goes on to the swap record; one that matches neither clears it
   as stale.
4. **The protection needs both builds to carry this change, and the docs say so.** R must run D2 to write the
   record and O must run D2 to read it, and O must be D1a or later to have armed the swap record R reads. The first
   swap INTO this change (a pre-D2 original, a D2 replacement) is therefore unprotected: a rollback from it still
   auto-updates. Two narrower windows stay open even between two D2 builds, and are named in the PR and the README:
   the record is not written when R dies or is stopped between `retire` and `recordRetirement`, when
   `recordRetirement` rejects or its save fails, or when R has no `GIT_SHA`; and if R also never reached
   `resolveUpdateAttempt` (so O's swap record survives), the rolled-back O probes `<name>-next`, finds it stopped,
   resolves `interrupted` and clears the attempt marker -- the #558 symptom, now reachable only through that double
   failure. `README.md:99` keeps the `AUTO_UPDATE=false` advice for an older original and for a boot whose log says
   "did not take" right after a rollback; the PR body and the #558 closing comment say the same.
5. **The marker is bound to the container that wrote it:** `HandoffMarker` gains `replacementId?: string`, the writer's
   own container id in the 12-hex form Docker gives a container as its hostname -- written ONLY when
   `process.env.HOSTNAME` matches `/^[0-9a-f]{12}$/` (`docker.ts:253` makes the same test; a `hostname:` pinned in
   compose, or an env-level `HOSTNAME=`, is copied into the replacement and is not an id -- a marker then carries none
   and is accepted as today, rather than every marker R writes being taken for foreign). R's three write sites set it
   through one helper. The original's four read sites ignore a marker whose `replacementId` is a 12-hex string that is
   not a prefix of the id it created (one warn per foreign id per attempt, not per 2 s poll); a marker with no id, or
   one that is not 12-hex, is accepted as today. `sha` is read where the header promised: the "replacement verified —
   handing over" line names it. `at` stays informational and the comment says so.
6. **Docs follow the code:** the handoff header and `CONTEXT.md:190` say two write sites, two clearers and the binding
   ("one writer in the normal case; a survivor's writes are ignored"); `bootMode`'s comment and test name say "raw";
   `README.md:99` per Decision 4; `README.md:101` and `CONTEXT.md:237` say the replacement re-reads the file once the
   original is stopped; the outcome count goes from five to six everywhere it is stated (`README.md:106`,
   `CONTEXT.md:182-183` -- `:182` also says "`interrupted` is the fifth outcome" and lists `decideUpdateOutcome()`'s
   five names -- `:332`, and the `UpdateOutcome` doc comment at `updateReport.ts:29`) and the `interrupted` texts lose
   "or the swap was rolled back" (in D2 code a rollback of a recorded swap resolves `rolled-back` before any probe; an
   unrecorded one is Decision 4's gap, named there); the state table rows 10, 14, 25 and 27 get a `**D2:**` note.

### Step 1 -- `src/state.ts`

1a. `PendingUpdateReport` (`:10-22`), after `interrupted?: true;`:

```ts
  // #558: set by the boot that found itself rolled back (`retiredBy` naming it as the original, `resolveUpdateAttempt`)
  // when this report is the one that swap armed, in the same save that arms the attempt marker -- so the verdict is on
  // disk with the report, and a boot that dies before delivering it still reports `rolled-back`. Wins over `interrupted`.
  rolledBack?: true;
```

`BotState` (`:39-53` at `9b9fb1b`), after `swapInFlight`:

```ts
  /** #558: written by the replacement in `takeOver`, after it has stopped the original and adopted the file: which
   *  build retired which. A later boot of the ORIGINAL (the operator's `docker start <name>`, a rollback) reads it and
   *  arms `attemptedUpdateToSha` with `sha`, so the automatic check skips the build it was rolled back from; cleared by
   *  `completeTakeOver` once the original is gone, by the rolled-back boot itself, and by a boot it names neither way. */
  retiredBy?: RetiredBy;
```

with, beside `SwapInFlight` (`:32-36`):

```ts
export interface RetiredBy {
  sha: string; // the replacement's build
  originalSha: string; // the build it retired (the swap record's fromSha)
  at: number; // ms epoch, for the log
}
```

1b. After `saveState` (the end of the file); `shortSha` is imported from `./storage` beside `readJsonOrFresh`
(`state.ts:3` already imports from it -- confirm `shortSha` lives there; if it is elsewhere, import from there):

```ts
/**
 * #507: re-read `state.json` into the shared object, in place (every importer holds this one object). For the
 * replacement, right after it has stopped the original: its own copy was loaded at import, and the original may have
 * persisted a release id (or anything else) since, which the replacement's first save would otherwise drop. An absent
 * file keeps what is in memory; a file that will not parse is moved aside by `readJsonOrFresh` (as at load, so the
 * evidence outlives the next save) and what is in memory is kept; a file that parses but is not a state object is kept
 * on disk and ignored. A reload never turns a good snapshot into an empty one.
 */
export async function reloadState(log: Pick<Console, "warn"> = console): Promise<"reloaded" | "kept"> {
  let raw: unknown;
  try {
    raw = await readJsonOrFresh<unknown>(STATE_FILE, () => undefined, "state");
  } catch (err) {
    log.warn("[state] could not re-read state.json; keeping the copy loaded at start", err);
    return "kept";
  }
  if (raw === undefined) {
    log.warn("[state] state.json is absent or was moved aside as unreadable; keeping the copy loaded at start");
    return "kept";
  }
  if (!isRawBotState(raw)) {
    log.warn("[state] state.json is not a state object; keeping the copy loaded at start");
    return "kept";
  }
  const fresh: BotState = { ...raw, seenReleaseIds: normalizeSeenReleaseIds(raw.seenReleaseIds ?? undefined, config.githubRepo) };
  const current = state as unknown as Record<string, unknown>;
  for (const k of Object.keys(current)) delete current[k];
  Object.assign(current, fresh);
  return "reloaded";
}

/** #558: the replacement's record of the swap it just completed, from the swap record the original armed (D1a). */
export async function recordRetirement(replacementSha: string | undefined, log: Pick<Console, "log" | "warn"> = console): Promise<void> {
  if (!replacementSha) {
    log.warn("[state] not recording the retirement: this build has no GIT_SHA");
    return;
  }
  // A restart of this replacement during its probation: its first life recorded this already (and then resolved the
  // swap record as landed, so there is nothing to read now). Nothing to do, nothing to say.
  if (state.retiredBy?.sha === replacementSha) return;
  const originalSha = state.swapInFlight?.fromSha;
  if (!originalSha) {
    log.warn(
      "[state] not recording the retirement: no swap record from the original to read (it ran a build before #450, or it had already resolved the record) — if this swap is rolled back, set AUTO_UPDATE=false on the original until a newer commit lands",
    );
    return;
  }
  state.retiredBy = { sha: replacementSha, originalSha, at: Date.now() };
  await saveState();
  log.log(`[state] recorded that ${shortSha(replacementSha)} retired ${shortSha(originalSha)}`);
}

/** #558: the original is gone, so no rollback can bring it back; the record is cleared. No-op when none is set. */
export async function clearRetirement(): Promise<void> {
  if (state.retiredBy === undefined) return;
  state.retiredBy = undefined;
  await saveState();
}
```

(`botStateForTest` compares every key against the import-time copy, so a test that reloads a changed file restores
the keys afterwards -- AND the file, see Step 6.)

### Step 2 -- `src/redeploy.ts`

2a. Import `clearRetirement, recordRetirement, reloadState` from `./state` (new import; `state.ts` has a top-level
await, which `index.ts` already resolves before this module is used; `redeploy.test.ts` imports `redeploy.ts` after
the preload has set `BOT_DATA_DIR`, so the import-time load hits the test data dir, as `update.test.ts`'s does; no
cycle: `state.ts` imports only `config` and `storage`). Import `type HandoffMarker` from `./handoff` if it is not
already imported (Grep).

2b. `TakeOverEffects` (`:816-838`) gains:

```ts
  /** #507: re-read `state.json` once the original is stopped (`reloadState`); best-effort. */
  reload?: () => Promise<unknown>;
  /** #558: record which build retired which (`recordRetirement`); best-effort. */
  recordRetirement?: () => Promise<void>;
```

2c. `takeOver` (`:931-975`): after `await retire(originalId);` (`:952`) and before `await clear();` (`:953`):

```ts
    // #507: the original is stopped and its drain awaited its last completed state write; this process's copy predates
    // it. Adopt the file before the first write of this process's own (the clear below writes the marker, not the
    // state, but activate()'s first save is minutes away at most). Best-effort: a failed reload keeps the snapshot.
    await (effects.reload ?? reloadState)().catch((err) => console.warn("[handoff] state re-read failed; keeping the snapshot", err));
    // #558: so a `docker start <name>` of the stopped original knows it was rolled back. Best-effort for the same reason.
    await (effects.recordRetirement ?? (() => recordRetirement(config.gitSha)))().catch((err) =>
      console.warn("[handoff] could not record the retirement; a rolled-back original will auto-update to this build again", err),
    );
```

Both OUTSIDE the failure semantics of the surrounding `try`: the catch (`:954-973`) writes `failed` and exits on the
premise that the original was never stopped, which is false here, hence the `.catch`es. The docstring (`:840-930`)
gains a paragraph on the two steps and why they sit after the stop. **Every existing `takeOver(...)` call in
`redeploy.test.ts` passes the two new effects as no-ops** (a shared `const NO_STATE = { reload: async () => {}, recordRetirement: async () => {} }`
spread into each: `:619`, `:648`, `:665`, `:687`, `:711`, `:730`, `:746`, `:815`, `:845`, `:863`, `:881`, `:900`, `:918`,
`:927`, `:948` at `4b4aeef` -- Grep `takeOver(` and cover every one); without that the default `reloadState` reads the
test dir's `state.json`, which `dataIsolation.test.ts:70-81` has saved a probe id into, and the test-state guard fails
eight of them in the normal order (`bun test src/dataIsolation.test.ts src/redeploy.test.ts` reproduces it).

2d. `completeTakeOver` (`:1029-1096`): ONE clear, inside the `try` right after `await remove(originalId);` (`:1072`)
-- that path is also the one an already-gone original takes (`:1086`'s `if (!original)` branch still calls `remove`,
pinned at `redeploy.test.ts:1318-1322` as `remove:…:plain`), so a second call there would clear twice:
`await clearRetirement().catch((err) => console.warn("[handoff] could not clear the retirement record", err));`
-- not in the failed-removal catch (the corpse stays; a rollback is still possible) and not on the step-aside paths.
`CompleteTakeOverEffects` (`:978`) gains `clearRetirement?: () => Promise<void>` so the tests can observe it. The
docstring says when the record is cleared and when it is kept.

2e. The marker binding (#506 item 10). One filter, exported for its tests:

```ts
const CONTAINER_SHORT_ID_RE = /^[0-9a-f]{12}$/;

/** #506: a marker names the container that wrote it; one from another container (an earlier replacement that is still
 *  alive, or an attempt the daemon lost) is not this attempt's verdict. A marker with no id, or with one that is not a
 *  12-hex short id (an older standby; a pinned hostname), is taken as-is. `warned` is this attempt's set of foreign
 *  ids already reported, so a 2 s poll does not repeat the line. */
export function markerFor(marker: HandoffMarker | undefined, replacementId: string, warned: Set<string>, log: Pick<Console, "warn"> = console): HandoffMarker | undefined {
  const id = marker?.replacementId;
  if (!marker || !id || !CONTAINER_SHORT_ID_RE.test(id)) return marker;
  if (replacementId.startsWith(id)) return marker;
  if (!warned.has(id)) {
    warned.add(id);
    log.warn(`[redeploy] ignoring a ${marker.status} marker written by ${id}, not by this attempt's replacement ${replacementId.slice(0, 12)}`);
  }
  return undefined;
}
```

(`replacementId` is the full 64-hex id from the create; the marker's is the 12-hex hostname, a prefix.) In
`redeploy()`, where `replacementId` is known (after `createContainer`), `const foreign = new Set<string>();` and the
four read sites go through it: `awaitHandoff` takes the set (it already has `replacementId` as its first argument) and
wraps `o.readMarker()` (`:674`); the late re-read (`const late = await read();`, `:530`) and the final read
(`const marker = await read();`, `:595`) wrap the same way; `awaitRetirementFailure` (`:721-`) too (it has
`replacementId` as its first parameter since S4b; give it a fifth parameter `foreign: Set<string>` for the shared
set). The final read matters for more than the outcome: `error: pollError ?? marker?.error` would otherwise carry a
foreign `failed`'s text into the result. The "replacement verified — handing over" line (`:556`) becomes
`` console.log(`[redeploy] replacement verified${readyMarker?.sha ? ` (${shortSha(readyMarker.sha)})` : ""} — handing over`); ``
where `readyMarker` is the `ready` marker that decided it -- the poll's result from `awaitHandoff` OR the late
re-read's (`readyMarker = late` on that path), so the sha is logged whichever read saw `ready` (R5's log assertion
covers both paths).

### Step 3 -- `src/handoff.ts` and `src/index.ts`

3a. `HandoffMarker` (`:60-68`) gains `/** The writer's own container id (its hostname, the 12-hex form), so the original
can tell this attempt's replacement from a survivor of an earlier one (#506). Absent from a marker an older standby
wrote, and from one written where HOSTNAME is not Docker's short id. */ replacementId?: string;` and `at`'s comment
becomes `// when it was written; informational`. Beside it:

```ts
/** This container's 12-hex short id when Docker set it as the hostname, else undefined (a `hostname:` pinned in compose,
 *  an env-level HOSTNAME=, or no container at all) -- the same test `docker.ts`'s self-inspect applies. */
export function ownContainerShortId(env: Record<string, string | undefined> = process.env): string | undefined {
  const host = env.HOSTNAME;
  return host !== undefined && /^[0-9a-f]{12}$/.test(host) ? host : undefined;
}
```

3b. The header (`:7-11`) becomes: "The signal is a marker file in the shared `state:/app/data` volume both containers
already mount. Deliberately its own file, never `state.json`: the replacement writes it, from two sites (the verify
timer gives up; `takeOver` signals `ready`, or `failed` from its catch), and each marker names the container that
wrote it; the original reads it and ignores one another container wrote (#506); it is cleared by the original before
it creates the replacement and after a failed attempt, and by the replacement in `takeOver`. One writer in the
normal case; a surviving earlier replacement's writes are ignored, not prevented."

3c. `:16`: `/** Set on the replacement only. Its presence *is* the instruction to boot in standby. */` ->
`/** Set on the replacement only, and never cleared from its env. Its presence is the RAW standby instruction: necessary, not sufficient — `resolveBootMode` (redeploy.ts) confirms it against the daemon, since a swapped-in container restarts with it set forever (#46). */`.
`bootMode`'s docstring (`:70-75`) gains the same sentence.

3d. `src/index.ts:85-90` (the verify timer's `failed` write; Grep `writeMarker({` under `verifyTimer`) and
`takeOver`'s two writes (`:944`, and the `failed` in its catch `:964`) add `replacementId: ownContainerShortId(),` (a
`string | undefined`; the type is optional).

3e. `src/handoff.test.ts:24`: the name becomes "HANDOFF_FROM is the raw standby instruction (resolveBootMode confirms it against the daemon, #46)".

### Step 4 -- `src/update.ts` and `src/updateReport.ts`

4a. `AttemptResolution` (`:393-407`) gains, first:
`/** `retiredBy` names this build as the ORIGINAL: the operator started it again after a swap that landed (a rollback, #558). The build it was retired by is armed as attempted; the record and any swap record are cleared. */ | "rolled-back"`.
Import `type RetiredBy` from `./state`.

4b. Pure decisions beside `decideAttemptResolution` and `isSwapInFlight` (`:433-441`):

```ts
/** A `retiredBy` as written by `recordRetirement`; a hand-edited one must not throw at boot. */
export function isRetiredBy(v: unknown): v is RetiredBy {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as RetiredBy).sha === "string" && typeof (v as RetiredBy).originalSha === "string" &&
    typeof (v as RetiredBy).at === "number"
  );
}

/** What `retiredBy` says about this boot (#558). `replacement` is checked first: the record's two shas can only be
 *  equal through a hand edit (`decideUpdate` answers `current` for the running sha before `force` is read, update.ts:82,
 *  so no swap to the same commit exists), and that build is then treated as the replacement, which keeps the record. */
export type RetirementVerdict = "none" | "rolled-back" | "replacement" | "stale";
export function decideRetirement(o: { retiredBy?: RetiredBy; runningSha?: string }): RetirementVerdict {
  if (!o.retiredBy) return "none";
  if (!o.runningSha) return "stale";
  if (sameSha(o.retiredBy.sha, o.runningSha)) return "replacement";
  if (sameSha(o.retiredBy.originalSha, o.runningSha)) return "rolled-back";
  return "stale";
}
```

4c. `resolveUpdateAttempt` (`:471-516` at `9b9fb1b`; it has no shutdown guard of its own -- `index.ts` calls it as
`isShuttingDown() ? "none" : await resolveUpdateAttempt()`, so the block below is simply skipped during a shutdown):
before the swap record is read (`const raw: unknown = state.swapInFlight;` at `:473`):

```ts
  // #558: the retirement record first. A rollback resolves here and never probes; a stale or malformed record is
  // cleared and saved with whatever follows (or on its own when no swap record follows).
  const retiredRaw: unknown = state.retiredBy;
  const retired = isRetiredBy(retiredRaw) ? retiredRaw : undefined;
  const verdict = decideRetirement({ retiredBy: retired, runningSha: config.gitSha });
  let retirementCleared = false;
  if (verdict === "rolled-back") {
    // This container was retired by `sha` and is running again — the operator rolled back. The swap landed, so any
    // swap record is moot (no probe); the build we were rolled back from is armed as attempted, so the automatic
    // check skips it until a newer commit lands, and /update (force) still applies it. The owed report, if it is the
    // one that swap armed (same shas, equality as in the `interrupted` branch), carries the verdict.
    state.attemptedUpdateToSha = retired!.sha;
    state.retiredBy = undefined;
    state.swapInFlight = undefined;
    const owed = state.pendingUpdateReport;
    // In place, as D1a's `interrupted` mark is at 9b9fb1b (`owed.interrupted = true`): `reportUpdateOutcome` now
    // delivers only the report object it was handed (`report === owed`, identity), so a copy must not replace it.
    if (owed?.fromSha === retired!.originalSha && owed.toSha === retired!.sha) owed.rolledBack = true;
    log.warn(
      `[update] this container was retired by ${shortSha(retired!.sha)} and is running again — rolled back by the operator; the automatic check skips ${shortSha(retired!.sha)} until a newer commit lands, and /${prefixedName(config.commandPrefix, "update")} applies it anyway`,
    );
    try {
      await saveState();
    } catch (err) {
      log.warn("[update] could not save the rollback marker (armed in memory; the next boot re-arms it)", err);
    }
    return "rolled-back";
  }
  if (verdict === "stale" || (retiredRaw !== undefined && retired === undefined)) {
    state.retiredBy = undefined;
    retirementCleared = true;
    log.log("[update] a retirement record belongs to another build or is malformed — cleared it");
  }
  // `replacement`: this is the new build during or after its probation; the record stays for the original to find.
```

and the existing `if (raw === undefined) return "none";` becomes: when `retirementCleared`, `saveState()` first (in
the same try/catch shape as the final save), then `return "none"`. The existing flow follows unchanged; its final
`saveState` covers a `stale` clear that a resolved swap record follows, while the two `in-flight` returns (the
record changed under the probe; a live `-next`) return before any save, so a stale clear made on those paths stays
in memory only -- harmless, the next boot clears it again. (`prefixedName` is imported in `update.ts` already --
Grep; the `commandNaming.test.ts` scan forbids a bare `/update` in a template, hence the `/${...}` form.)

4d. `updateReport.ts`: `UpdateOutcome` gains `"rolled-back"`; `decideUpdateOutcome` (`:37-41`) reads it from the
report, before `interrupted`:
`if (sameSha(o.runningSha, o.report.fromSha)) return o.report.rolledBack ? "rolled-back" : o.report.interrupted ? "interrupted" : "noop";`
(its docstring: "`report.rolledBack` and `report.interrupted` are boots' verdicts saved with the report; a rollback
wins, since a rolled-back swap did land first"). `updateOutcomeMessage`'s `rolled-back` case:
`` `⚠️ Back up on \`${now}\` — the update to \`${short(report.toSha)}\` landed and was then rolled back (the new build was stopped and this one started again). Automatic updates skip \`${short(report.toSha)}\` until a newer commit lands; run /${prefixedName(config.commandPrefix, "update")} to apply it anyway.` ``
The `interrupted` text and the `UpdateOutcome` doc comment (`:29`) lose "or the swap was rolled back" (Decision 6).
`reportUpdateOutcome(client, resolution, deliverers, owed = owedReportNow())` (the `9b9fb1b` signature: it delivers
only when the report it reads is the `owed` object it was handed) needs no new branch: `rolled-back` is not
`in-flight`, so the report is cleared and delivered as today, and the outcome comes from the report, which 4c marked
in place. The distinct-text test's set grows to 6.

### Step 5 -- docs

- `README.md:99` (one long line; anchor on `set \`AUTO_UPDATE=false\` after the rollback`): the two sentences
  `With \`AUTO_UPDATE=true\` the revived original can update to the same bad build at its next check (the new build's first tick clears the attempt marker), so set \`AUTO_UPDATE=false\` after the rollback until the fix ships.`
  -> `When both builds carry the rollback record (this change and later), the revived original knows it was rolled back — the new build recorded the swap in the shared \`data/state.json\` when it stopped the original — and marks that build as attempted, so the automatic check skips it until a newer commit lands; \`/update\` applies it anyway if you want it back. An original from a build older than this change cannot read the record (one older than #450 also leaves the replacement no swap record to write it from): with \`AUTO_UPDATE=true\` it updates to the same build at its next check, so set \`AUTO_UPDATE=false\` after rolling back to one until the fix ships. Do the same if the revived original's boot log says the swap "did not take" instead of "rolled back by the operator": the record was not written (the new build was stopped before it could, or could not save it), and the next automatic check would rebuild.`
- `README.md:101`: after `the replacement reads it at startup but writes nothing until it has taken over, by which point the original is stopped.` append ` It then re-reads the file before its first write, so a release whose id the original saved while the replacement was booting is not announced again.`
- `README.md:106` "which of five things happened" -> six; the `interrupted` bullet (`:109` at `9b9fb1b`) drops
  "or the swap was rolled back"; a `rolled-back` bullet follows it: "**rolled back** — the update landed and the
  operator rolled it back (the new container was stopped and the old one started again); automatic updates skip that
  build until a newer commit lands."
- `CONTEXT.md:182-183` "five outcomes" -> six, `:182`'s "`interrupted` is the fifth outcome" and its list of
  `decideUpdateOutcome()`'s names gain `rolled-back` (read before `interrupted`), and the list at `:332` too.
- `CONTEXT.md:237`: the clause `or a self-update replacement that booted from a stale \`state.json\` snapshot (#507, open)` -> `(a replacement used to boot from a stale snapshot, #507: since D2 \`takeOver\` re-reads the file once the original is stopped)`.
- `CONTEXT.md:190` (the `handoff.ts` row): `one writer, two clearers, see the gotcha` -> `one writer from two sites, two clearers, each marker bound to the container that wrote it (\`replacementId\`; the original ignores another's, #506), see the gotcha`; append `` `sha` is logged by the original at `ready`; `at` is informational; `ownContainerShortId()` ``.
- `CONTEXT.md:192` (the `redeploy.ts` row): append `` ; **#558/#507:** `takeOver` re-reads `state.json` after the stop (`reloadState`) and records `retiredBy` (`recordRetirement`); `completeTakeOver` clears it once the original is gone; `markerFor()` ignores a marker another container wrote ``.
- `CONTEXT.md`'s `state.ts` row (`:194`): `` `retiredBy` (#558) is the replacement's record of the swap, for a rolled-back original; `reloadState()`/`recordRetirement()`/`clearRetirement()`; `PendingUpdateReport.rolledBack` ``.
- `CONTEXT.md`'s `update.ts` row (`:180`): the `resolveUpdateAttempt` clause D1a appended gains `rolled-back` first,
  "for a swap between two builds that both carry D2".
- The gotcha D1a appended (about `CONTEXT.md:1227-1232` at `9b9fb1b`; Grep `swap record`): add: "A `retiredBy` record naming this build as the original is checked
  before the swap record: a rollback arms the attempt marker instead of resolving the record (#558). Both builds must
  carry D2 for that; the first swap into it is unprotected and the README says to keep `AUTO_UPDATE=false` after
  rolling back to an older build."
- The state table (`525-handoff-state-table.md`): `**D2:**` notes on rows 10 and 14 ("R re-reads the file after the
  stop, so O's late clear of P and its persisted ids reach R"), 25 ("O's boot after a rollback arms A with R's sha: no
  automatic re-update, when O carries D2") and 27 ("a marker is bound to its writer; a survivor's is ignored").
- `#506`: a closing comment listing items 10, 11 (this PR), 12, 13 (D1a) and 14 (S3b-2, PR #570).
- `#558`'s closing comment names Decision 4's gap.

### Step 6 -- tests

**`src/state.test.ts`** (uses the test `DATA_DIR`; every test here that touches the real `state.json` saves its
prior bytes (or absence) first and restores them in `finally` -- restoring only the `state` keys leaves a polluted
file for the next reload -- and restores the shared `state` keys, which the guard checks):
- **S1:** write a file with `seenReleaseIds: { "a/b": [1, 2, 3] }` and `retiredBy` while memory holds `{ "a/b": [1] }`
  -> `reloadState()` returns `reloaded`, `state.seenReleaseIds["a/b"]` is `[1, 2, 3]`, `state.retiredBy` set, a key
  present in memory but absent from the file is gone; **S2:** no file -> `kept`, memory unchanged, a warn; **S3:** a
  file holding `{ not json` -> `kept`, a warn, memory unchanged, and a `state.json.corrupt-*` sibling now exists (the
  move-aside is `readJsonOrFresh`'s; remove the sibling in `finally`); **S3b:** a file holding `{"seenReleaseIds": 5}`
  -> `kept`, the "not a state object" warn, the file untouched; **S4:** `recordRetirement(NEW)` with
  `state.swapInFlight = { fromSha: OLD, toSha: NEW, startedAt }` -> `state.retiredBy` equals
  `{ sha: NEW, originalSha: OLD, at: <number> }` and it is on disk; with no `swapInFlight` -> nothing written, the
  "no swap record" warn; with `state.retiredBy = { sha: NEW, ... }` already -> nothing written, NO warn (spy
  `Bun.write`, and the log stub's `warn` list is empty); with `recordRetirement(undefined)` -> the "no GIT_SHA" warn;
  **S5:** `clearRetirement()` clears and saves; a no-op with none set (no write: spy `Bun.write`).

**`src/redeploy.test.ts`** (the `takeOver` describe at `:612`, the real-daemon one at `:764`, `completeTakeOver` at
`:1132`, `detectRollback` at `:1548`, all at `4b4aeef`):
- **R1:** `takeOver` with recording effects -> the order is `write(ready)`, `restorePolicy`, `retire`, `reload`,
  `recordRetirement`, `clear` (a shared `calls` array); **R2:** `reload` rejecting -> `recordRetirement` and `clear`
  still run, no `failed` marker, no exit, a warn; the same for `recordRetirement` rejecting; **R3:** the default
  effects for the two new ones only: `takeOver` against the real `reloadState` + `recordRetirement` with
  `{ fromSha: OLD, toSha: NEW, ... }` written to the test dir's `state.json` (seeded on DISK, so the reload is what
  brings it in) and `config.gitSha = NEW`, `write`/`clear`/`retire`/`restorePolicy` stubbed -> afterwards
  `state.retiredBy` equals `{ sha: NEW, originalSha: OLD, at }` in memory AND on disk; restore `state`, `config.gitSha`
  and the file in `finally`.
- **R4:** `completeTakeOver`: a successful removal -> `clearRetirement` called exactly once; an original already gone
  (`inspect` returns undefined) -> exactly once; a removal that throws -> NOT called; the step-aside branch -> NOT called.
- **R5 (#506 item 10):** `markerFor(undefined, id, warned)` -> undefined; a marker with no `replacementId` -> returned;
  (and, for the sha log: the "replacement verified" line names the sha both when the POLL saw `ready` and when the
  LATE RE-READ did);
  one whose `replacementId` is `"my-pinned-host"` (not 12-hex) -> returned; one with the first 12 hex of `id` ->
  returned; one with another 12-hex id -> undefined, a warn naming both, and a second call with the same `warned` set
  -> undefined and NO second warn. Through the harness: `awaitHandoff` polling a `ready` marker whose `replacementId`
  is foreign keeps waiting (and decides `timeout` at the deadline) with ONE warn across the polls; the late re-read
  ignores a foreign `ready`; the final read ignores a foreign `failed` (`result.outcome` is not `failed` and
  `result.error` is undefined); the retirement wait ignores a foreign `failed` (stalled at the deadline); each of the
  four with the OWN id behaves as today. The `ready` log line names the marker's sha (assert on the console.log stub).
- **R6:** `takeOver`'s `ready` write and its catch's `failed` write carry `replacementId` equal to `process.env.HOSTNAME`
  when it is set to a 12-hex value in the test, and carry none when it is set to `"my-pinned-host"` (restore it);
  `index.ts`'s write is pinned by `src/index.test.ts`'s source check for `replacementId: ownContainerShortId()` inside
  the timer callback, since `index.ts` does not run under test. `src/handoff.test.ts`: `ownContainerShortId` with a
  12-hex env, a pinned name, and no `HOSTNAME`.

**`src/update.test.ts`:**
- **U1:** `decideRetirement` matrix: none; no running sha -> stale; `sha` running -> replacement (also when both shas
  equal the running one); `originalSha` running -> rolled-back; neither -> stale. `isRetiredBy` rejects `{ sha: 5 }`,
  a string, null.
- **U2:** `resolveUpdateAttempt` with `state.retiredBy = { sha: NEW, originalSha: OLD, at }`, `config.gitSha = OLD`,
  `state.swapInFlight` set and `state.pendingUpdateReport = { fromSha: OLD, toSha: NEW, ... }` (all seeded on disk),
  a probe seam that throws if called -> `rolled-back`; A `=== NEW`, `retiredBy` and `swapInFlight` undefined, the
  report carries `rolledBack: true`, all four on disk; the probe was NOT called; the warn names NEW and `/update`.
  A report with other shas -> NOT marked. With `config.gitSha = NEW` -> the record is untouched and the resolution is
  whatever the swap record gives (seed none -> `none`). With `config.gitSha = THIRD` and no swap record -> `none`,
  and the record is cleared ON DISK (the save on the `raw === undefined` path). A malformed record (`{ sha: 5 }`) ->
  cleared, no throw.
- **U3:** after a `rolled-back` boot, `checkForUpdate(deps)` with the stub deps answering NEW from GitHub ->
  `suppressed` (the re-armed marker holds); with `{ force: true }` and the SAME stub deps (the default would reach the
  real daemon and `requestRestart`) -> `restart` (#558's second acceptance bullet).

**`src/updateReport.test.ts`:** `decideUpdateOutcome({ report: { ...report, rolledBack: true }, runningSha: FROM })`
-> `rolled-back`; with both `rolledBack` and `interrupted` -> `rolled-back`; the message names `TO` and `/update`; the
distinct-text set is 6; `reportUpdateOutcome(client, "none", deliverers)` with a `rolledBack` report clears P and
delivers the `rolled-back` text; the `interrupted` text no longer contains "rolled back".

**`src/handoff.test.ts`:** the renamed test and `ownContainerShortId`; `index.test.ts`: the `replacementId` source pin.

### Mutation table (run in a scratch worktree, never in the shared tree)

```bash
git -C /s/repos/rackbops-discord-bot worktree add --detach /s/Repos/_wt/rdb-526-D2-mut fix/526-D2-rollback-and-snapshot
cd /s/Repos/_wt/rdb-526-D2-mut && bun install --frozen-lockfile
```

Run `bun test src/state.test.ts src/redeploy.test.ts src/update.test.ts src/updateReport.test.ts src/handoff.test.ts src/index.test.ts src/dataIsolation.test.ts` per mutant.

| # | Mutation (production line, after the steps) | Test that must fail |
|---|---|---|
| M1 | 1b `reloadState`: keep memory when the file parses (never replace) | S1 |
| M2 | 1b `reloadState`: replace memory with `{ seenReleaseIds: {} }` when `raw === undefined` | S2, S3 |
| M3 | 1b `reloadState`: the `isRawBotState` check dropped (assign whatever parsed) | S3b |
| M4 | 1b `recordRetirement`: `originalSha` from `swapInFlight.toSha` | S4, R3 |
| M4b | 1b `recordRetirement`: the "already names this build" early return dropped | S4's third case (a write and a warn) |
| M5 | 2c: `reload` moved BEFORE `retire` | R1 |
| M6 | 2c: `recordRetirement` moved before `reload` | R1 |
| M7 | 2c: the `.catch` on `reload` dropped (a rejection reaches the `try`'s catch: `failed` + exit) | R2 |
| M7b | 2c: the `.catch` on `recordRetirement` dropped | R2's second case |
| M8 | 2d: `clearRetirement` called in the failed-removal catch too | R4 |
| M9 | 2d: `clearRetirement` not called after a successful removal | R4 |
| M9b | 2d: a second `clearRetirement` added in the `if (!original)` branch | R4 (called twice) |
| M10 | 2e `markerFor`: drop the prefix check (accept every marker) | R5 (the foreign `ready` is honoured) |
| M10b | 2e: the late re-read (`:530`) unfiltered | R5's late-re-read case |
| M10c | 2e: the final read (`:595`) unfiltered | R5's final-read case (`result.error` carries the foreign text) |
| M11 | 2e: ignore a marker with NO `replacementId` | R5 (an older standby's marker is dropped) |
| M11b | 2e: the 12-hex test dropped (a pinned-name id treated as foreign) | R5's `my-pinned-host` case |
| M11c | 2e: the `warned` set not consulted (warn every poll) | R5's one-warn-across-polls case |
| M12 | 2e: the retirement wait reads the marker unfiltered | R5's retirement case |
| M12b | 2e: the `ready` line without the sha | R5's log assertion |
| M13 | 3d: `takeOver`'s `ready` write without `replacementId` | R6 |
| M13b | 3d: `takeOver`'s catch `failed` write without `replacementId` | R6 |
| M13c | 3a: `ownContainerShortId` returns `env.HOSTNAME` unconditionally | handoff.test's pinned-name case; R6's second case |
| M14 | 4b `decideRetirement`: `originalSha` and `sha` checks swapped in order | U1 (both equal -> rolled-back) |
| M15 | 4c: `state.attemptedUpdateToSha = retired.sha` dropped | U2, U3 (`restart` instead of `suppressed`) |
| M16 | 4c: `state.retiredBy` not cleared on rolled-back | U2 (still on disk) |
| M16b | 4c: the `rolledBack = true` mark dropped | U2 (the report's `rolledBack` on disk; updateReport's delivery case seeds the flag itself and does not see this) |
| M16c | 4c: the stale clear not saved when no swap record follows | U2's `THIRD` case (still on disk) |
| M17 | 4c: the probe called on rolled-back (resolve the swap record first) | U2 (the throwing probe) |
| M18 | 4c: the `replacement` verdict clears the record too | U2's `config.gitSha = NEW` case |
| M19 | 4d: `rolled-back` returns the `interrupted` text | updateReport's distinct-text and message tests |
| M19b | 4d: `interrupted` checked before `rolledBack` | updateReport's both-set case |

### Coverage table

| Bullet (#558's acceptance; #507's and #506's observable outcomes) | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| #558: a boot with the retirement record naming it as the original skips that sha on the next check, and a forced `/update` does not | 1a, 1b, 4 | U1, U2, U3 | M14-M18, M16c |
| #558: a successful takeover records the retirement, after the stop and the reload; a probation restart does not re-record | 1b, 2b, 2c | R1, R3, S4 | M4, M4b, M5, M6 |
| #558: the record is cleared once the original is gone, once, kept while a rollback is possible | 2d | R4 | M8, M9, M9b |
| #558: an on-daemon rollback with `AUTO_UPDATE=true` attempts no new build | -- | roshne's step on nucbox (named in the PR; this box has no daemon) | -- |
| #507: the replacement adopts the file before its first write; a bad file never degrades the snapshot | 1b, 2c | S1-S3b, R1, R2 | M1, M2, M3, M7, M7b |
| #506-10: a marker another container wrote is ignored at all four reads, once-warned; an older standby's or a pinned name's is accepted; `sha` is logged | 2e, 3a, 3d | R5, R6, handoff.test | M10-M13c |
| #506-11: the comment and the test name say "raw" | 3c, 3e | lens-B audit | -- |
| #506-14: closed by reference to S3b-2 | -- | -- | -- |
| the owed report after a rollback says so, and survives a crash before delivery | 1a, 4c, 4d | U2, updateReport tests | M16b, M19, M19b |

### Verification

```bash
bun install --frozen-lockfile
cd ops/admin && bun install --frozen-lockfile && cd ../..
bun run check
bunx tsc --noEmit -p ops/tsconfig.json
cd ops/admin && bun run check && cd ../..
bun test src/dataIsolation.test.ts src/redeploy.test.ts   # in THIS order: the polluted-file case (2c)
bun test src/state.test.ts src/redeploy.test.ts src/update.test.ts src/updateReport.test.ts src/handoff.test.ts src/index.test.ts src/commandNaming.test.ts test/stateGuard.test.ts
bun test --randomize src/redeploy.test.ts src/update.test.ts src/state.test.ts src/dataIsolation.test.ts
bun test
```

Not verifiable here, named in the PR: the on-daemon rollback (#558's third bullet: roll back per #548's recipe with
`AUTO_UPDATE=true`, between two builds that both carry this PR, wait one tick, `docker ps` and the log show no new
build; the log shows "rolled back by the operator"), which joins Rod's nucbox batch with #547/#548; and a real
two-container race for #507 (the test drives the order, not the timing).

### Acceptance to paste per issue

- **#558:** U2 and U3 pass lines, M15 and M17 failing output, R1/R3 pass lines, the warn text; the on-daemon bullet
  named as the operator's; Decision 4's gap in the closing comment.
- **#507:** S1-S3b and R1/R2 pass lines, M1-M3 and M7 failing output; comments on #509 (item 1) and #500 (item 13)
  closing them by reference.
- **#506:** R5/R6 pass lines, M10-M13c; the renamed test; the closing comment listing all five items and where each landed.

### PR

- Title: `fix(handoff): re-read state.json once the original is stopped, record who retired whom so a rolled-back original stops auto-updating to that build, and bind the marker to its writer (#558, #507, #506)`.
- Body: the three items, Decisions 1-6 (4 with the first-swap gap spelled out), the typecheck + test output, the
  mutation table, the on-daemon step named. End with `Closes #558. Closes #507. Closes #506.`
- After merge: tick #558, #507 and #506 on #526; comments on #509 and #500.

### Out of scope, on purpose

- A heartbeat or any other liveness beyond the record (a rollback is an operator action; the record is enough).
- Reconciling two live bots' concurrent writes to `state.json` in general: the one re-read closes the only window
  the design leaves (the replacement's import-to-takeover gap); after the stop there is one writer again.
- Reading the original's sha from its container env (`Config.Env` `GIT_SHA`) instead of the swap record, which would
  cover a pre-#450 original: it adds a daemon read and a second source to `recordRetirement`; the record it would
  write could not be read by that older original anyway (Decision 4).
- Protecting the first swap into this change (Decision 4: the README keeps the operator step for it).
