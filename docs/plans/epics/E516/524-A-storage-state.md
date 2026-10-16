<!-- Plan for sub-epic #524 of Epic #516 (Rackbops/rackbops-discord-bot), bundle A: storage, state and
shutdown. Written by the orchestrating session on 2026-10-15 against `main` @ `c783ad0`. Every file:line
below was read from that tree; the implementer re-reads each one on the tree it works from and corrects
any that moved. -->

## Implementation plan -- #524 bundle A: `src/storage.ts`, `src/state.ts`, `src/shutdown.ts`

Children: **#456**, **#457**, **#509**, **#511**, and items 9, 10, 12a and 13 of **#510** (items 11 and
12b of #510 land elsewhere, see "Closed by reference" below). One PR. A behaviour change (what a read
error does, what a failed write leaves behind, what a malformed `state.json` does, the shutdown handler's
first phase), so the **three-reviewer gate** applies: you plus two read-only adversarial reviewers with
different lenses, up to four rounds, then report. Every coverage row is mutation-tested in a scratch
worktree, real output pasted.

Bundle B1 (`524-B1-boot-ready-datadir.md`) moves `resolveDataDir` out of `src/storage.ts:20-61` into a new
`src/dataDir.ts` and edits `storage.test.ts:30-64`. **Do not touch those lines**; everything here is at
`storage.ts:71` and below, and in `storage.test.ts:86` and below, plus the import lines (`storage.ts:2`,
`storage.test.ts:5`). Two places collide with B1 anyway, so **B1 merges first**: B1 trims `storage.ts:3`
(adjacent to the `:2` edit here), and both bundles edit the one long `src/storage.ts` row of `CONTEXT.md`
(`:205`). Do every step here except the `CONTEXT.md` edits of step 4 first; when you reach those, `git
merge origin/main` into your branch (B1 must be on `main` by then; if it is not, tell the orchestrator and
wait rather than editing the row on the old text), resolve the import-line merge by keeping both edits, and
make the row edit on B1's wording. That keeps every `CONTEXT.md` row a single-writer change.

### What is wrong, verified at `c783ad0`

- `readJsonOrFresh` (`src/storage.ts:141-157`) treats every throw from `file.json()` as corruption: it
  logs "unreadable or corrupt", renames the file to `<path>.corrupt-<ts>` and returns `fresh()`. Probed on
  Bun 1.4.2 (scratch script, 2026-10-15): an empty file and malformed JSON throw a `SyntaxError`; a file
  that vanished throws an `Error` with `code: "ENOENT"`; a directory throws `Error` with `code: "EISDIR"`
  (and `Bun.file(dir).exists()` is `false`, so a directory already reads as absent). So the error class
  does tell the cases apart, and the catch ignores it. `loadStateFrom` (`src/state.ts:54-73`) is a
  hand-copied second implementation of the same catch. (#509 item 2; partly addresses #477's item 1 and
  #484's item 6, see decision 8.)
- `writeFileAtomic` (`storage.ts:126-131`) has no cleanup: a failed `Bun.write` or `renameSync` leaves
  `<path>.<pid>.<token>.<n>.tmp` behind, and the counter means a retry never overwrites it. (#509 item 3.)
- `TMP_TOKEN` (`storage.ts:83`) is pinned only by `tmpPathFor`'s pure tests (`storage.test.ts:178-187`,
  hand-supplied tokens) and a source-text grep (`:193-198`). `const TMP_TOKEN = "x"` keeps the suite green.
  (#509 item 5.)
- `loadStateFrom` spreads whatever parsed (`state.ts:58-61`): `{"seenReleaseIds":{"a/b":null}}` loads, and
  then every `saveState` (`state.ts:160-166`) throws on `null.slice`; `42` or `[]` load as `{}` (a top-level
  `null` already throws inside the `try` at `:61` and is moved aside). (#509 item 8.)
- `saveStateTo` (`state.ts:93-98`) still writes the fixed `${path}.tmp`, with no `TMP_TOKEN`; the comment
  at `storage.ts:96-98` says `writeJsonAtomic` "mirrors" it. `src/plugins/index.ts:53-55` already writes
  through `writeFileAtomic` since #496, so that half of #510 item 9 is done. (#510 item 9.)
- `dataIsolation.test.ts:9-21` calls itself the guard that "the suite must never read or write the
  checkout's own `data/`"; it pins the two real writers at one point in time. (#510 item 10.)
- `shutdown.ts:113-116`: `deps.beginShutdown` and `await deps.awaitIdle` sit outside any try; a throw
  there rejects the handler with `draining` left `true`, and `exit` is never reached. (#510 item 12a.)
- `storage.ts:135-136` and `state.ts:45-46` name "a power loss or OOM-kill mid-write" as what temp+rename
  defends against; there is no `fsync`, so power loss is not covered. (#510 item 13.)
- `createKeyedJsonMutator` (`storage.ts:195-211`) never deletes a `chains` entry (`:206`). (#511 item 14.)
- Doc drift (#511 item 15), each re-verified: `CONTEXT.md:743` "One writer (the replacement), one reader
  (the original)", but `clearMarker()` runs in the original at `src/redeploy.ts:214` (the start of a
  redeploy) and `:387` (after a failed one), and in the replacement inside `takeOver` (`:641`, `clear =
  effects.clear ?? clearMarker` at `:616`) once it has taken over; the writer is a bare `Bun.write`
  (`src/handoff.ts:69-71`; same claim at `handoff.ts:7-10`); `CONTEXT.md:402`
  "hardcodes `/app/data/...` in six places" (grep today: `ops/bot-ops.sh:468`, `:469`, `:472`, `:473`,
  `:630`, `:632`, `:1360`, seven, plus a comment at `:467`); `state.ts:26-30` "A rollback ... finds its
  dedup history intact" (the keys are preserved but frozen; the wow plugin advances its own copy in
  `wow.json` since #107); `state.test.ts:119-123` "`loadState`/`saveState` ... untested here directly"
  (`dataIsolation.test.ts:62-78` drives the real `saveState`); `README.md:259` "Release-announcement dedup
  state" (the file also holds `attemptedUpdateToSha` and `pendingUpdateReport`, `state.ts:31-32`);
  `shutdown.ts:19` "a one-line `process.on`" (`index.ts:123-124` are two); `shutdown.test.ts:140-143` pins
  the literal `8_000 < 10_000`, not `docker.ts:248`'s `timeoutSec = 10`.
- `storage.test.ts:137-141` and `state.test.ts:182-186` assert `existsSync(`${file}.tmp`)` is false. For
  `writeJsonAtomic` that name has not existed since #154, so the assertion is true for any implementation
  (replace the rename with a copy: green). (#456.)
- Only `normalizeSeenReleaseIds` is tested (`state.test.ts:98-117`); no test loads a legacy array through
  `loadStateFrom`, and no test saves more than 3 ids, so a wrong repo at `state.ts:61` or deleting the cap
  loop at `:161-164` stays green. (#457.)

### Decisions (defaults, named so the gate can contest them)

1. **Error classes in `readJsonOrFresh`.** `SyntaxError` = corrupt: today's path (log, move aside, fresh).
   `code === "ENOENT"` = the file vanished between `exists()` and `json()`: return `fresh()`, move nothing,
   log nothing (an absent file is the common fresh-install case). **Anything else is rethrown** after one
   `console.error` naming the path and the error (`[label] <path> could not be read (<err>); not treating
   it as corrupt`). A read that fails for EACCES/EIO is an environment fault: returning fresh would let the
   next write overwrite good data, and moving the file aside is wrong because it may be intact. For
   `state.ts`'s top-level `await` (`:41`) and for `index.ts:78`'s top-level `await readPluginState(...)` that
   means boot fails loudly with the real error instead of silently re-announcing or forgetting every plugin
   pin; `restart: unless-stopped` relaunches until the volume is fixed, and `docker logs` names the fault.
   **This reaches every other `readJsonOrFresh` caller too** -- `src/plugins/host.ts:1201`,
   `src/commands.ts:181`/`:210`, `src/routing/store.ts:126`/`:168`/`:229`, `src/routing/discovery.ts:188`, and
   the installed plugins through `HostStorage.readJsonOrFresh` (`index.ts:77`/`:153`, `announce.ts:61`): a
   read that fails for a non-parse reason now rejects where it used to return fresh. That is the position
   taken: `HostStorage`'s shape and `HOST_API_VERSION` do not change, and the contract's comment
   (`src/plugins/contract.ts:267-268`, "corrupt-file-moved-aside reads") stays true for a corrupt file; a
   plugin that read a user's file under EIO and got "fresh" would have overwritten it on the next write.
   `contract.ts` itself is NOT edited (the plugins repo vendors it byte-identical, PR #539); name the
   behaviour change for plugins in the PR body and in the `CONTEXT.md` storage row. Say so in the docblock,
   and rewrite `state.ts:48-50` (which calls a throwing top-level await the thing to avoid) to say which
   throws are now deliberate.
2. **`loadStateFrom` delegates to `readJsonOrFresh`** (one implementation of the catch) and validates the
   shape afterwards; a shape failure uses the same move-aside, through a new exported
   `moveCorruptAside(path, label, reason)` that `readJsonOrFresh` also calls. Shape = a non-null object whose
   `seenReleaseIds`, when present, is a number list or a map of number lists; `42` and `[]` are malformed
   (today they load as `{}` silently), and so is `null` (today it throws inside the `try` and is moved
   aside, so only the reason text changes).
3. **`saveStateTo` becomes `writeJsonAtomic(path, data)`.** Kept as an exported function (tests and
   `createStateWriter` call it) so nothing else moves.
4. **No `fsync`** (#510 item 13): reword the two comments to the crash the pattern does cover (a process
   killed mid-write: OOM-kill, SIGKILL, a crash) and say power loss is not. An `fsync` of the file and the
   directory on every state write is a design change this epic does not ask for.
5. **No boot-time `*.tmp` sweep** (#509 item 3's "optionally"): cleanup on the failure path is the fix; a
   sweep would have to reason about another live process's temp files during a handoff.
6. **`createKeyedJsonMutator` gains `pendingPaths(): number`** (how many paths still hold a queue), for
   the pruning test. `HostStorage` in `src/plugins/contract.ts:272-279` is **not** changed (an extra
   property on the returned object is assignable to the contract's narrower type; `contract.test.ts` pins
   that file).
7. **`docker.ts` gets `export const STOP_TIMEOUT_SEC = 10`** as `stopContainer`'s default (`:248`), so
   `shutdown.test.ts` can derive its margin from it, and `docker.test.ts` pins that the default really is
   what a stop request sends (`t=10`). Two files sub-epic #525 owns (`docker.ts`, `docker.test.ts`), plus
   the `handoff.ts:7-10` comment; say so in the PR.
8. **Closed by reference, not fixed here:** #509 item 1 (the replacement's stale `state.json` snapshot) is
   `self-update-handoff-15`'s, #507 in #526. #510 item 12b (the exit-75 restart path skipping dispose) is
   `docker-restart-4`'s, #512 in #525. #510 item 11 (the `NODE_ENV` test detection) lands in **bundle B1**
   with the `resolveDataDir` move. **Partly addressed, not closed:** #477 item 1 and #484 item 6 (routing
   reads moving a file aside) get the "a non-parse read error is not corruption" half from decision 1; their
   other halves -- a trailing-comma `routing.json` still being renamed by a read, and re-checking that the
   path still holds the failed file before renaming it -- stay with #528. Each gets one line in the PR body
   and a comment on its issue.
9. **Declined in writing** (#510 item 12's "withTimeout timers are never cleared": `exit` is
   `process.exit`, so a pending timer changes nothing, and each `shutdown.test.ts` case bounds its own race;
   #511 item 15's "40-50 ms of timing slack": no flake has been seen on CI's Linux runner and the margins at
   `shutdown.test.ts:150-287` are 50-100 ms each). Both in the PR body.

### Step 1 -- `src/storage.ts`

- **Export `TMP_TOKEN`** (`:83`): `export const TMP_TOKEN = ...`, and add to its comment: "Exported for
  the test that pins its shape and that two processes differ; nothing else reads it."
- **`writeFileAtomic`** (`:126-131`):

  ```ts
  export async function writeFileAtomic(path: string, text: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = tmpPathFor(path, process.pid, TMP_TOKEN, ++tmpCounter);
    try {
      await Bun.write(tmp, text);
      renameSync(tmp, path);
    } catch (err) {
      // #509: a failed write or rename must not leave the temp file behind -- the counter means a retry
      // never reuses this name, so without this each failure leaks one file for good. The cleanup's own
      // failure (EBUSY/EPERM on Windows) must not mask the real error.
      try {
        rmSync(tmp, { force: true });
      } catch {
        // the original error is the one worth throwing
      }
      throw err;
    }
  }
  ```

  Add `rmSync` to the `node:fs` import (`:2`).
- **`moveCorruptAside`** (new, exported, placed before `readJsonOrFresh`):

  ```ts
  /** Logs that `path` is unusable and renames it to `<path>.corrupt-<ts>`; a failed rename is logged, not
   *  thrown. The one move-aside both `readJsonOrFresh` and `state.ts`'s shape check use. */
  export function moveCorruptAside(path: string, label: string, reason: string): void {
    console.error(`[${label}] ${path} is unreadable or corrupt — starting fresh: ${reason}`);
    const corrupt = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, corrupt);
      console.error(`[${label}] moved the corrupt file aside to ${corrupt} for inspection`);
    } catch (renameErr) {
      console.error(`[${label}] couldn't move the corrupt file aside: ${renameErr}`);
    }
  }
  ```

- **`readJsonOrFresh`** (`:141-157`) becomes:

  ```ts
  export async function readJsonOrFresh<T>(path: string, fresh: () => T, label: string): Promise<T> {
    const file = Bun.file(path);
    if (!(await file.exists())) return fresh();
    try {
      return (await file.json()) as T;
    } catch (err) {
      const kind = classifyReadError(err);
      if (kind === "absent") return fresh();
      if (kind === "corrupt") {
        moveCorruptAside(path, label, String(err));
        return fresh();
      }
      console.error(`[${label}] ${path} could not be read (${err}); not treating it as corrupt`);
      throw err;
    }
  }

  /** What a throw from `Bun.file(path).json()` means (Bun 1.4.2, probed): a `SyntaxError` is a file that
   *  parsed badly (empty, truncated, not JSON) -- corrupt; `ENOENT` is a file that vanished after `exists()`
   *  -- absent; anything else (EACCES, EIO, EMFILE, EISDIR) is a read that failed on a file that may be
   *  intact -- an error, never a reason to move the file aside. Pure. */
  export function classifyReadError(err: unknown): "corrupt" | "absent" | "error" {
    if (err instanceof SyntaxError) return "corrupt";
    if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT") return "absent";
    return "error";
  }
  ```

  Rewrite the docblock (`:133-140`): the move-aside is for a file that **parsed badly** (empty, truncated,
  not JSON — a process killed mid-write before #154's temp+rename, or a hand edit); a read that fails for
  any other reason is logged and **rethrown**, because returning fresh would let the next write overwrite a
  file that may be intact, and moving it aside would hide an environment fault (decision 1, #509).
- **Comments:** `:96-98` "Mirrors `state.ts`'s `saveStateTo`, generalized so ..." -> "`state.ts`'s
  `saveStateTo` and the plugins' storage both come here (#510); one implementation of temp+rename."
  `:135-136` "(truncated, empty, or otherwise unparseable — a power loss or OOM-kill mid-write)" -> "(a
  process killed mid-write before the rename landed — an OOM-kill, a SIGKILL, a crash; there is no `fsync`,
  so a host power loss is outside what temp+rename covers, #510)".
- **`createKeyedJsonMutator`** (`:195-211`): prune on settle, and the counter:

  ```ts
  export function createKeyedJsonMutator<T>(): {
    update: (path: string, fresh: () => T, mutate: (current: T) => T, label: string) => Promise<void>;
    /** Settles once every update queued so far has, on every path (what the test-state guard reads). */
    idle: () => Promise<void>;
    /** Paths that still hold a queue -- an entry is dropped once its last update settles (#511), so this is
     *  the number of paths with an update in flight, not every path ever touched. */
    pendingPaths: () => number;
  } {
    const chains = new Map<string, Promise<void>>();
    return {
      update(path, fresh, mutate, label) {
        const prior = chains.get(path) ?? Promise.resolve();
        const run = () => readJsonOrFresh<T>(path, fresh, label).then((current) => writeJsonAtomic(path, mutate(current)));
        const next = prior.then(run, run);
        const tail = next.catch(() => {});
        chains.set(path, tail);
        void tail.then(() => {
          if (chains.get(path) === tail) chains.delete(path);
        });
        return next;
      },
      idle: () => Promise.all(chains.values()).then(() => {}),
      pendingPaths: () => chains.size,
    };
  }
  ```

  Update the docblock's "a `Map`, populated lazily" (`:188-189`) with "and emptied as queues settle (#511)".

### Step 2 -- `src/state.ts`

- Import: `import { DATA_DIR, moveCorruptAside, readJsonOrFresh, writeJsonAtomic } from "./storage";` and drop
  `mkdirSync`, `renameSync`, `dirname` from the `node:fs`/`node:path` imports (`:1-2`) once nothing uses them.
- **Shape check** (new, exported, pure), after `RELEASE_ID_CAP`:

  ```ts
  /** The raw shape `loadStateFrom` accepts: an object whose `seenReleaseIds`, when present, is a number list
   *  (the legacy single-repo form) or a map of number lists. Anything else -- `null`, a number, a list, a
   *  map with a `null` or string value -- would parse but break every later `saveState` (#509), so it is
   *  treated as corrupt. Other keys are not checked: they round-trip untouched. */
  export type RawBotState = Omit<BotState, "seenReleaseIds"> & { seenReleaseIds?: number[] | Record<string, number[]> };

  export function isRawBotState(raw: unknown): raw is RawBotState {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    const ids = (raw as { seenReleaseIds?: unknown }).seenReleaseIds;
    if (ids === undefined) return true;
    if (isNumberList(ids)) return true;
    return (
      typeof ids === "object" && ids !== null && !Array.isArray(ids) && Object.values(ids).every(isNumberList)
    );
  }

  function isNumberList(v: unknown): v is number[] {
    return Array.isArray(v) && v.every((n) => typeof n === "number");
  }
  ```

- **`loadStateFrom`** (`:54-73`):

  ```ts
  export async function loadStateFrom(path: string): Promise<BotState> {
    const raw = await readJsonOrFresh<unknown>(path, () => undefined, "state");
    if (raw === undefined) return { seenReleaseIds: {} };
    if (!isRawBotState(raw)) {
      moveCorruptAside(path, "state", "not a state object (seenReleaseIds must be a number list or a map of number lists)");
      return { seenReleaseIds: {} };
    }
    return { ...raw, seenReleaseIds: normalizeSeenReleaseIds(raw.seenReleaseIds, config.githubRepo) };
  }
  ```

  Note `readJsonOrFresh` returns `fresh()` = `undefined` for an absent file **and** for a corrupt one it moved
  aside; both read as fresh state here, as today. Rewrite the docblock (`:43-53`): absent -> fresh; parsed
  badly or wrong-shaped -> logged, moved aside, fresh ("dedup history lost once"); **a read that failed for
  another reason is rethrown by `readJsonOrFresh`**, so the top-level `await` at `:41` fails the boot with
  the real error (decision 1) instead of a silent fresh state that would re-announce and then overwrite the
  file. Replace "a power loss or OOM-kill mid-write" (`:45-46`) per decision 4.
- **`saveStateTo`** (`:88-98`):

  ```ts
  /** `writeJsonAtomic` for the state file -- the same temp name (pid, `TMP_TOKEN`, counter) and rename as
   *  every other JSON file this bot writes (#510; it used to keep a `${path}.tmp` copy of the pattern). */
  export function saveStateTo(path: string, data: BotState): Promise<void> {
    return writeJsonAtomic(path, data);
  }
  ```

- **Cap** (`:160-166`):

  ```ts
  /** Keeps the newest `cap` ids per repo, in place (every importer holds `state`), and returns the map. */
  export function capSeenReleaseIds(ids: Record<string, number[]>, cap = RELEASE_ID_CAP): Record<string, number[]> {
    for (const [repo, list] of Object.entries(ids)) ids[repo] = list.slice(-cap);
    return ids;
  }

  export function saveState(): Promise<void> {
    // Cap each repo's release-id history so the file never grows unbounded.
    capSeenReleaseIds(state.seenReleaseIds);
    return stateWriter.save(state);
  }
  ```

- **Comment** `:26-30`: end it "... so unknown keys round-trip. A rollback that reintroduces the old core
  code finds those keys as they were when the core last wrote them -- preserved, not advanced: since #107
  the wow plugin keeps its own copy in `data/wow.json`, so the frozen values can be older than the plugin's."

### Step 3 -- `src/shutdown.ts` and `src/docker.ts`

- `shutdown.ts:113-116`:

  ```ts
    draining = true;
    // #510: neither throws today (notifyStop catches its listeners, awaitCriticalIdle never rejects), but
    // the exit below must be reached whatever this phase does -- otherwise `draining` stays true and the
    // process sits until the daemon's SIGKILL. Guarded separately, so a throwing beginShutdown still drains.
    try {
      deps.beginShutdown(signal);
    } catch (err) {
      deps.log.error("[shutdown] beginShutdown failed (draining anyway)", err);
    }
    deps.log.log(`[shutdown] ${signal} received — draining in-flight work (up to ${deps.graceMs}ms)`);
    const startedAt = Date.now();
    let drained = false;
    try {
      drained = await deps.awaitIdle(deps.graceMs);
    } catch (err) {
      deps.log.error("[shutdown] the drain failed (continuing to dispose and exit)", err);
    }
    const elapsedMs = Date.now() - startedAt;
  ```

  Keep the two existing log lines for `drained` true/false below it unchanged.
- `shutdown.ts:19`: "so index.ts's own wiring is a one-line `process.on(signal, handler)`" -> "so
  `index.ts`'s own wiring is two `process.on(signal, handler)` lines sharing one handler".
- `docker.ts:248`: add above `stopContainer`

  ```ts
  /** `docker stop`'s grace before SIGKILL, in seconds, for every stop this bot issues; `shutdown.ts`'s
   *  `SHUTDOWN_GRACE_MS` is measured against it (its test imports this). */
  export const STOP_TIMEOUT_SEC = 10;
  ```

  and `timeoutSec = STOP_TIMEOUT_SEC`. Nothing else in `docker.ts` changes.

### Step 4 -- docs, in the same PR

- `CONTEXT.md:743-744`: "One writer (the replacement), one reader (the original)." -> "The replacement
  writes it (`writeMarker`, a plain `Bun.write`: a half-written marker reads as `undefined` through
  `readMarker`'s tolerant parse, so it needs no temp+rename) and clears it once it has taken over
  (`takeOver`); the original reads it, and clears it at the start of a redeploy and after a failed one
  (`redeploy.ts`). One writer, two clearers, never two writers."
- `src/handoff.ts:7-10`: same correction in that header ("exactly one process writes it (the replacement,
  which also clears it in `takeOver`); the original reads it and clears it (`redeploy.ts`), never writes
  it"). `handoff.ts` is in sub-epic #525's scope; say so in the PR.
- `CONTEXT.md:402`: "hardcodes `/app/data/...` in six places" -> "hardcodes `/app/data/...` (the `*_PATH`
  constants, `status`'s realm read and `plugin-request`'s mailbox dir)". No count.
- `README.md:259` `src/state.ts` row: "Release-announcement dedup state (`data/state.json`)" ->
  "`data/state.json`: release-announcement dedup state, plus the self-update guard (`attemptedUpdateToSha`)
  and the owed `/update` follow-up (`pendingUpdateReport`)".
- `CONTEXT.md` File Map rows, each grepped on a short unique substring and edited on one line's worth of
  text (never Read a long row by line range): `src/state.test.ts` (`:174`): append the new cases
  (legacy-array migration through `loadStateFrom`, the shape check, the cap through `saveState`, a
  non-corruption read error propagating, `saveStateTo`'s temp name). `src/storage.ts` (`:205`; grep `Shared
  atomic-JSON-file primitives`): append "**#509/#510/#511:** `readJsonOrFresh` moves aside only a file that
  parsed badly (`classifyReadError`: a `SyntaxError`), reads a vanished file as absent, and rethrows any
  other read error (EACCES, EIO, EISDIR) after one log line -- for every caller, the installed plugins'
  `HostStorage.readJsonOrFresh` included, since returning fresh let the next write overwrite a file that was
  intact; `writeFileAtomic` removes its temp file when the write or rename fails; `moveCorruptAside` is the
  one move-aside (`state.ts` uses it for its shape check); `createKeyedJsonMutator` drops a path's queue
  once it settles (`pendingPaths()`); `TMP_TOKEN` is exported for its test". `src/state.ts` (`:190`):
  `loadStateFrom` delegates to `readJsonOrFresh` and validates the shape (`isRawBotState`), `saveStateTo` is
  `writeJsonAtomic`, the cap is `capSeenReleaseIds`. `src/shutdown.ts` (`:181`) and `src/shutdown.test.ts`
  (`:183`): the guarded first phase and its two tests, the margin derived from `STOP_TIMEOUT_SEC`. (There
  are no rows for `storage.test.ts` or `dataIsolation.test.ts`; do not add any -- the missing test rows are
  #475's.)
- `src/state.test.ts:119-123`: "`loadState`/`saveState` themselves stay bound to the real STATE_FILE and
  untested here directly" -> "`loadState` stays bound to the real STATE_FILE; `saveState` is driven for real
  by `dataIsolation.test.ts` (under the test data dir) and by the cap test below".
- `src/dataIsolation.test.ts:9-21`: replace the first sentence with "The regression guard for #139, as far
  as a test can be one: it drives the two real writers (`saveState()`, `writeMarker()`) and proves each
  landed under `BOT_DATA_DIR` while the checkout's `data/` stayed byte-identical to the preload's snapshot.
  It does not see reads, a file that sorts after this one, or a write-then-delete before it ran; the
  containment itself is the preload (`test/setup.ts`) plus `resolveDataDir`'s refusal to use the checkout
  under `bun test`." Keep the rest.

### Step 5 -- tests

`storage.test.ts` (add `rmSync`/`mkdirSync` imports as needed; import `TMP_TOKEN`, `classifyReadError`,
`moveCorruptAside` from `./storage`; import `stallBunWrite` from `../test/stallBunWrite`).

First extend `test/stallBunWrite.ts` to record what each stalled call was given:
`calls: unknown[][]` pushed inside the mock before `reach()`; return it. (`state.test.ts` keeps working.)

| # | Test | Pins |
|---|---|---|
| T1 | `readJsonOrFresh` / "a malformed-JSON file loads fresh **and is moved aside**" | extend `:125-135`: after the read, `existsSync(file)` false and one `.corrupt-` entry in `readdirSync(dir)`; and extend `:97-100` (absent file): `console.error` is NOT called |
| T2 | "a read that fails for a reason other than corruption is rethrown, and nothing is moved aside" | `spyOn(Bun, "file").mockImplementation(() => ({ exists: async () => true, json: async () => { throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); } }) as never)` inside `try`/`finally` (restore); `await expect(readJsonOrFresh(file, fresh, "t")).rejects.toThrow(/EIO/)`; the real file written beforehand is intact and `readdirSync(dir)` has no `.corrupt-` entry; `console.error` called once with a message containing `could not be read` and not `corrupt — starting fresh` |
| T3 | "a file that vanished between exists() and json() reads fresh, with no log and nothing moved aside" | same spy, `code: "ENOENT"`; resolves `fresh()`; `console.error` not called |
| T4 | `classifyReadError` / "SyntaxError is corrupt, ENOENT is absent, anything else is an error" | `new SyntaxError("x")` -> corrupt; `{code:"ENOENT"}` -> absent; `{code:"EACCES"}`, `new Error("x")`, `"string"` -> error |
| T4b | `moveCorruptAside` / "logs the reason and the new name, and a failed rename is logged, not thrown" | on a real file: returns, `existsSync(file)` false, one `.corrupt-` entry, two `console.error` calls (the reason, the new name); on a path that does not exist: does not throw, the second line contains `couldn't move` |
| T5 | `writeJsonAtomic` / "a write that cannot complete leaves no temp file behind" | `mkdirSync(file)` (a directory at the target: rename throws -- `EPERM` on Windows, probed; `EISDIR` or `ENOTDIR` on Linux per POSIX, not probed here, so assert only that it throws); `await expect(writeJsonAtomic(file, { n: 1 })).rejects.toThrow()`; `readdirSync(dir).filter((f) => f.endsWith(".tmp"))` is `[]` |
| T6 | "writeJsonAtomic leaves no `*.tmp` entry in the directory on success" (replaces `:137-141`, #456) | `readdirSync(dir)` equals `["x.json"]` |
| T7 | `TMP_TOKEN (#253)` / "writeJsonAtomic's temp name carries the module's TMP_TOKEN, which is eight hex chars" (replaces the source pin `:189-198`, #509 item 5) | `expect(TMP_TOKEN).toMatch(/^[0-9a-f]{8}$/)`; `const stall = stallBunWrite(); try { void writeJsonAtomic(file, { n: 1 }).catch(() => {}); await stall.reached; expect(String(stall.calls[0]![0])).toMatch(new RegExp(`^${escapeRegExp(file)}\\.${process.pid}\\.${TMP_TOKEN}\\.\\d+\\.tmp$`)); } finally { stall.restore(); }` (write a 3-line `escapeRegExp` in the test; backslashes in a Windows path need it) |
| T8 | "TMP_TOKEN differs between two processes" | twice: `Bun.spawnSync([process.execPath, "-e", 'import("./src/storage").then((m) => console.log(m.TMP_TOKEN))'], { cwd: <repo root>, env: process.env, timeout: 20_000 })` (the child inherits `BOT_DATA_DIR`, so `DATA_DIR`'s own `resolveDataDir()` is happy); both `stdout.toString().trim()` match `/^[0-9a-f]{8}$/`, differ from each other and from the in-process `TMP_TOKEN` |
| T9 | `createKeyedJsonMutator` / "forgets a path once its queue settles, and holds it while an update is in flight" | fresh mutator: `pendingPaths()` 0; `await m.update(a, ...)` then `await Promise.resolve(); await Promise.resolve();` (the prune runs two microtasks after the update's own promise settles -- the extra ticks are required, not optional) -> 0; then `const stall = stallBunWrite(); try { void m.update(a, ...).catch(() => {}); await stall.reached; expect(m.pendingPaths()).toBe(1); } finally { stall.restore(); }` -- the stuck update never settles, so leave it; it is this test's own mutator |
| T9b | "a path with a second update still queued is not forgotten when the first settles" | `const p1 = m.update(a, ...); const p2 = m.update(a, ...);` (both real writes, queued back to back); `await p1; await Promise.resolve(); await Promise.resolve();` -> `pendingPaths()` is 1 (p2's queue is current, p1's prune must not delete it); `await p2; await Promise.resolve(); await Promise.resolve();` -> 0 |
| T10 | "an update that rejects still clears its path" | a `mutate` that throws; `await expect(m.update(...)).rejects.toThrow()`; `await Promise.resolve(); await Promise.resolve()`; `pendingPaths()` 0 |

`state.test.ts` (import `config` from `./config` and `DATA_DIR`, `TMP_TOKEN` from `./storage`;
`isRawBotState`, `capSeenReleaseIds` from `./state`):

| # | Test | Pins |
|---|---|---|
| T11 | `loadStateFrom` / "migrates a legacy global array under config.githubRepo" (#457) | write `{"seenReleaseIds":[1,2]}`; expect `{ seenReleaseIds: { [config.githubRepo]: [1, 2] } }` |
| T12 | "a parseable file whose seenReleaseIds is not a map of number lists is moved aside and loads fresh" (#509 item 8) | `test.each` over `{"seenReleaseIds":{"a/b":null}}`, `{"seenReleaseIds":"abc"}`, `42`, `[]`, `null`, each in its own fresh temp dir: loads `{ seenReleaseIds: {} }`, `existsSync(file)` false, one `.corrupt-` entry, `console.error` called with a message containing `not a state object` (for `null`, which the old code also moved aside, this pins the new reason text); and extend `:133-136` (absent file): `console.error` is NOT called |
| T13 | `isRawBotState` / table | `{}` true; `{seenReleaseIds:[1]}` true; `{seenReleaseIds:{"a/b":[1]}}` true; `{seenReleaseIds:{"a/b":null}}` false; `{seenReleaseIds:"abc"}` false; `{seenReleaseIds:["1"]}` false; `null`, `42`, `[]` false; `{attemptedUpdateToSha:"x"}` true |
| T14 | "a read error that is not corruption propagates (loadStateFrom delegates to readJsonOrFresh)" | the T2 spy; `await expect(loadStateFrom(file)).rejects.toThrow(/EIO/)`; no `.corrupt-` entry |
| T15 | `saveStateTo` / "writes through writeJsonAtomic's temp name, not a fixed `.tmp`" (#510 item 9) | `stallBunWrite`; `void saveStateTo(file, { seenReleaseIds: {} }).catch(() => {})`; `await stall.reached`; the recorded path matches `` `^${escapeRegExp(file)}\\.${process.pid}\\.${TMP_TOKEN}\\.\\d+\\.tmp$` `` |
| T16 | "saveStateTo leaves no `*.tmp` entry in the directory on success" (replaces `:182-186`, #456) | `readdirSync(dir)` equals `["state.json"]` |
| T17 | `capSeenReleaseIds` / "keeps the newest 100 of 150, per repo, in place" (#457) | `const ids = { "a/b": Array.from({ length: 150 }, (_, i) => i), "c/d": [1] }; const same = capSeenReleaseIds(ids); expect(same).toBe(ids); expect(ids["a/b"]).toEqual(range 50..149); expect(ids["c/d"]).toEqual([1])` |
| T18 | "saveState caps the live history before it writes" (the wiring, #457) | in the `botStateForTest / resetBotStateForTest` describe (its `afterEach` resets): `state.seenReleaseIds["cap/probe"] = Array.from({ length: 150 }, (_, i) => i); await saveState(); const written = JSON.parse(readFileSync(join(DATA_DIR, "state.json"), "utf8")); expect(written.seenReleaseIds["cap/probe"]).toHaveLength(100); expect(written.seenReleaseIds["cap/probe"][0]).toBe(50)`; then `delete state.seenReleaseIds["cap/probe"]; await saveState();` so the file left behind carries no probe |

`shutdown.test.ts` (import `STOP_TIMEOUT_SEC` from `./docker`):

| # | Test | Pins |
|---|---|---|
| T19 | "a rejecting awaitIdle still disposes, destroys and exits 0, logging the failure" (#510 item 12a) | `awaitIdle: async () => { throw new Error("drain blew up"); }`; `order` is `["disposePlugins", "destroyClient", "exit"]`; `exits` `[0]`; an error entry includes `the drain failed` |
| T20 | "a throwing beginShutdown is logged, and the drain still runs before exit" | `beginShutdown: () => { throw new Error("x"); }`; `order` is `["awaitIdle", "disposePlugins", "destroyClient", "exit"]`; `exits` `[0]`; an error entry includes `beginShutdown failed` |
| T21 | `:140-143` becomes "SHUTDOWN_GRACE_MS leaves real margin under docker stop's SIGKILL bound, as `docker.ts` sets it" | `expect(SHUTDOWN_GRACE_MS).toBe(8_000); expect(SHUTDOWN_GRACE_MS).toBeLessThan(STOP_TIMEOUT_SEC * 1000); expect(STOP_TIMEOUT_SEC).toBe(10)` |
| T22 | `docker.test.ts`, beside the explicit-`10` case at `:233`: "stopContainer's default grace is STOP_TIMEOUT_SEC, on the wire" | call `stopContainer(id)` with no timeout argument through the file's existing fake-fetch harness; the request URL contains `t=${STOP_TIMEOUT_SEC}` |

### Coverage table

The Low groups carry no `## Acceptance`; each row names the observable outcome its item demands.

| Outcome | Step | Test | Mutation that must turn it red |
|---|---|---|---|
| a `SyntaxError` read is moved aside and reads fresh | 1 | T1 (storage), existing `state.test.ts:153` and `:169` (state) | M1: in `classifyReadError`, return `"error"` for a `SyntaxError` |
| a non-corruption read error is rethrown and nothing is moved aside | 1 | T2, T14 | M2: make the `"error"` branch fall through to `moveCorruptAside` + `fresh()` |
| a vanished file reads fresh silently; an absent one logs nothing | 1, 2 | T3, T1 (absent), T12 (absent) | M3: return `"error"` for `ENOENT`; M3b: delete `if (raw === undefined) return ...` in `loadStateFrom` (an absent file then logs through `moveCorruptAside`) |
| a failed write leaves no temp file | 1 | T5 | M4: delete the `rmSync(tmp, …)` line |
| a successful write leaves no temp file | 1, 2 | T6, T16 | M5: replace `renameSync(tmp, path)` with `copyFileSync(tmp, path)` |
| the temp name carries a per-process random token | 1 | T7, T8 | M6: `export const TMP_TOKEN = "deadbeef"` (T7's shape check and T8 red); M7: compute a fresh token inside `writeFileAtomic` per call (T7 red: the name no longer carries the exported token) |
| `state.ts` writes through `writeJsonAtomic` | 2 | T15 | M8: revert `saveStateTo` to the fixed `${path}.tmp` write |
| a malformed-but-parseable `state.json` is moved aside | 2 | T12, T13 | M9: make `isRawBotState` return `true` for a map value of `null` |
| a legacy array migrates under the configured repo | 2 | T11 | M10: pass `""` instead of `config.githubRepo` at the `normalizeSeenReleaseIds` call |
| the history is capped at 100 per repo, on the real save path | 2 | T17, T18 | M11: delete the `capSeenReleaseIds(state.seenReleaseIds)` call in `saveState`; M12: `slice(-cap)` -> `slice(0, cap)` |
| a mutator forgets a settled path, and only that path's own queue | 1 | T9, T9b, T10 | M13: delete the `void tail.then(...)` pruning; M13b: delete the `chains.get(path) === tail` check (unconditional delete; T9b's `1` becomes `0`) |
| the shutdown handler always reaches `exit`, and a throwing beginShutdown still drains | 3 | T19, T20 | M14: remove the `try`/`catch` around `awaitIdle`; M14b: put `beginShutdown` and `awaitIdle` in one `try` (T20's order loses `awaitIdle`) |
| the shutdown margin is measured against docker's own stop timeout, which is what a stop sends | 3 | T21, T22 | M15: `STOP_TIMEOUT_SEC = 7` (T21 red because 8000 is no longer under 7000); M15b: `timeoutSec = 30` as the default while the constant stays 10 (T22 red) |
| the docs say what the code does | 4 | manual: reviewer B reads every edited sentence against the code | -- |

Run every mutation in a scratch copy (`git worktree add --detach <path> <sha>`), never in the tree the
tests or a reviewer are reading. Paste the red test's name per row in the PR. `bun test` from the repo
root (one unscoped run covers root and `ops/admin`); T8 spawns two short `bun -e` processes.

### Checks, gate, PR

- `bun run check`; `bunx tsc --noEmit -p ops/tsconfig.json`; `bun run check` inside `ops/admin/`;
  `bun test` from the repo root, then `bun test --randomize` once. Some `ops/*` suites skip without
  `docker compose`/`bash`/`jq` -- name CI's Linux run as the evidence. The PR is not ready until CI is green.
- Review gate: reviewer A on correctness and failure modes (the error classification against Bun's real
  error classes; the rethrow at `state.ts:41`'s and `index.ts:78`'s top-level awaits and what `restart:
  unless-stopped` then does; what each other `readJsonOrFresh` caller, the routing store and the plugins'
  `HostStorage` included, does with a rejection it never saw before; the pruning race in
  `createKeyedJsonMutator` -- an update queued between settle and delete must chain on the old tail, which
  the `chains.get(path) === tail` check guarantees; the shape check against a `state.json` written by the
  real `saveState` under the test data dir, there being no example file in the docs); reviewer B on
  claims-vs-code, walking the coverage table and every edited comment and doc line against the merged
  tree. Both read-only, both handed the merged tree and the five issues. Fix or decline every evidenced
  finding in writing; re-run the gate on the whole merged state after a behaviour fix.
- Branch `fix/524-storage-state`; commit and PR title
  `fix(storage): classify read errors, clean up failed writes, validate state.json and pin the storage guards (#456, #457, #509, #510, #511)`.
  Body: one line each `Closes #456`, `Closes #457`, `Closes #509`, `Closes #511`; `Part of #510 (items 9,
  10, 12a, 13 here; 11 in bundle B1; 12b is #512's)`; the pasted checks; the mutation rows; the gate's
  rounds; decisions 1-9 named as assumptions taken (decision 1's reach into every `readJsonOrFresh` caller
  and the plugins' `HostStorage` stated in its own paragraph); the two declines of decision 9; the
  closed-by-reference lines (#509 item 1 -> #507, #510 item 12b -> #512) and the partly-addressed lines
  (#477 item 1 and #484 item 6 -> this PR's `classifyReadError`, with what remains); the #525-owned files
  touched (`docker.ts`, `docker.test.ts`, `handoff.ts`'s header). After the merge, comment on #477 and #484
  naming the PR, the item and what of it remains (do not close them). Do not merge.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot. Work in a NEW worktree, never the shared checkout:
  git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-524-A origin/main -b fix/524-storage-state
Issues: Rackbops/rackbops-discord-bot #456 #457 #509 #510 #511 (sub-epic #524 of Epic #516). Read each issue body first.
Plan: docs/plans/epics/E516/524-A-storage-state.md on branch claude/524-plans:
  git -C S:\Repos\rackbops-discord-bot show origin/claude/524-plans:docs/plans/epics/E516/524-A-storage-state.md
Behaviour change: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Every mutation in a scratch worktree. Scratch files: task-unique names (pr-body-524A.md, commit-msg-524A.txt), read back before use. Report the PR link, the pasted checks, the mutation table, the gate's rounds and any deviation. Do not merge.
```
