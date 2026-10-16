import { join } from "node:path";
import { config } from "./config";
import { DATA_DIR, moveCorruptAside, readJsonOrFresh, shortSha, writeJsonAtomic } from "./storage";

/**
 * A `/update`-initiated restart, recorded so the bot can tell the requester what build it
 * actually came back on. Written only by the command path — an `AUTO_UPDATE` exit or a host
 * reboot leaves it unset, and produces no follow-up.
 */
export interface PendingUpdateReport {
  fromSha: string; // sha we were running when /update fired
  toSha: string; // sha we exited to pick up
  userId: string; // who ran /update
  channelId?: string; // last-resort delivery target
  applicationId?: string; // with interactionToken, addresses the follow-up webhook route
  interactionToken?: string; // valid ~15 min from the interaction
  requestedAt: number; // ms epoch, so boot can tell a fresh restart from a week-old one
  // #450: set by the boot that found the swap this report was armed for never took over (`resolveUpdateAttempt`), in the
  // same save that clears the swap record -- so the verdict is on disk with the report it describes, and a boot that dies
  // before delivering it still reports `interrupted`, not the "image wasn't rebuilt" a bare `noop` would say.
  interrupted?: true;
  // #558: set by the boot that found itself rolled back (`retiredBy` naming it as the original, `resolveUpdateAttempt`)
  // when this report is the one that swap armed, in the same save that arms the attempt marker -- so the verdict is on
  // disk with the report, and a boot that dies before delivering it still reports `rolled-back`. Wins over `interrupted`.
  rolledBack?: true;
}

/**
 * A socket-path self-update this container started and has not resolved (#450): written in the same save that
 * arms `attemptedUpdateToSha`/`pendingUpdateReport`, before the build; cleared when `redeploy()` returns (the swap
 * failed) or by the next boot's `resolveUpdateAttempt` (`update.ts`), which reads it to tell a swap that landed
 * (this is the new build), one still in flight (the original restarted beside a live `<name>-next`) and one that was
 * interrupted (nothing took over) apart -- the exit-75 path never writes it, so its absence means "what the two
 * markers say is the whole story".
 */
export interface SwapInFlight {
  fromSha: string; // the build that started the swap
  toSha: string; // the build it was swapping to
  startedAt: number; // ms epoch, for the log
}

export interface RetiredBy {
  sha: string; // the replacement's build
  originalSha: string; // the build it retired (the swap record's fromSha)
  at: number; // ms epoch, for the log
}

// Persisted so a restart does not re-announce a release whose save landed (CONTEXT.md's Behavior section lists what can still repeat one).
export interface BotState {
  // Seen release ids keyed by `owner/repo`, so watched repos never collide and each seeds
  // its "first poll is silent" backlog independently.
  seenReleaseIds: Record<string, number[]>;
  // Keys a prior version wrote but the core no longer defines — the WoW dedup keys (dmfAnnouncedFor,
  // weeklyAnnouncedFor, realmStatus), removed here in #107 now that the wow plugin owns them in its own
  // data/wow.json — are deliberately NOT re-added above, yet are PRESERVED on disk untouched: loadStateFrom
  // spreads the raw JSON (`{ ...raw }`) and saveStateTo re-serialises the whole object, so unknown keys
  // round-trip. A rollback that reintroduces the old core code finds those keys as they were when the
  // core last wrote them — preserved, not advanced: since #107 the wow plugin keeps its own copy in
  // `data/wow.json`, so the frozen values can be older than the plugin's.
  attemptedUpdateToSha?: string; // sha we last exited to update to; guards against an exit loop
  pendingUpdateReport?: PendingUpdateReport; // /update follow-up owed on next boot; consumed once
  swapInFlight?: SwapInFlight; // #450: a socket-path swap from before its build until redeploy() returns or the next boot resolves it
  /** #558: written by the replacement in `takeOver`, after it has stopped the original and adopted the file: which
   *  build retired which. A later boot of the ORIGINAL (the operator's `docker start <name>`, a rollback) reads it and
   *  arms `attemptedUpdateToSha` with `sha`, so the automatic check skips the build it was rolled back from; cleared by
   *  `completeTakeOver` once the original is gone, by the rolled-back boot itself, and by a boot it names neither way. */
  retiredBy?: RetiredBy;
}

const RELEASE_ID_CAP = 100;

/** The raw shape `loadStateFrom` accepts: an object whose `seenReleaseIds` is absent (or `null`, which
 *  `normalizeSeenReleaseIds`'s `??` has always read as absent), a number list (the legacy single-repo
 *  form) or a map of number lists. Anything else — a root that is not an object, a number, a string, a
 *  list of lists, a map with a `null` or string value — would parse but break every later `saveState`
 *  (#509), so it is treated as corrupt. Other keys are not checked: they round-trip untouched. */
export type RawBotState = Omit<BotState, "seenReleaseIds"> & {
  seenReleaseIds?: number[] | Record<string, number[]> | null;
};

export function isRawBotState(raw: unknown): raw is RawBotState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const ids = (raw as { seenReleaseIds?: unknown }).seenReleaseIds;
  if (ids === undefined || ids === null) return true; // absent; `null` is what `normalizeSeenReleaseIds`'s `??` has always read as absent
  if (isNumberList(ids)) return true;
  return typeof ids === "object" && ids !== null && !Array.isArray(ids) && Object.values(ids).every(isNumberList);
}

function isNumberList(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === "number");
}

// Imported, never recomputed (#139): the shared resolver is what an override relocates, and a
// second local copy of this expression is how the suite ended up writing the real checkout.
const STATE_FILE = join(DATA_DIR, "state.json");

export const state: BotState = await loadStateFrom(STATE_FILE);

/**
 * Reads and parses a state file at `path` through `readJsonOrFresh` (one implementation of the
 * catch), then checks the shape. Distinguishes "absent" (a fresh install — the common case) from
 * "present but broken": a file that parsed badly (empty, truncated, not JSON — a process killed
 * mid-write, which temp+rename now rules out for this bot's own writes, or a hand edit) or parsed
 * into the wrong shape (`isRawBotState`) is logged loudly and moved aside to
 * `<path>.corrupt-<timestamp>` for inspection rather than thrown, so a bad file degrades to "dedup
 * history lost once" instead of the top-level `await` above throwing before `index.ts` even runs.
 * **A read that failed for another reason (EACCES, EIO, ...) is rethrown by `readJsonOrFresh`**, so
 * that top-level `await` fails the boot with the real error and `restart: unless-stopped` relaunches
 * into it until the volume is fixed (#509): the alternative, a silent fresh state, would re-announce
 * every release and then overwrite a file that may be intact. The move-aside is itself best-effort:
 * a failed rename is logged, not thrown — losing the forensic copy is still better than a crash loop.
 * There is no `fsync` (#510), so a host power loss is outside what the temp+rename write covers.
 */
export async function loadStateFrom(path: string): Promise<BotState> {
  const raw = await readJsonOrFresh<unknown>(path, () => undefined, "state");
  if (raw === undefined) return { seenReleaseIds: {} };
  if (!isRawBotState(raw)) {
    moveCorruptAside(path, "state", "not a state object (seenReleaseIds must be a number list or a map of number lists)");
    return { seenReleaseIds: {} };
  }
  return { ...raw, seenReleaseIds: normalizeSeenReleaseIds(raw.seenReleaseIds ?? undefined, config.githubRepo) };
}

/**
 * Migrate the legacy global `seenReleaseIds` array — from when the bot watched a single
 * repo — into the per-repo map, filing it under the repo it used to mean. Non-destructive:
 * an already-keyed map (or a fresh install's `undefined`) passes through as-is.
 */
export function normalizeSeenReleaseIds(
  raw: number[] | Record<string, number[]> | undefined,
  defaultRepo: string,
): Record<string, number[]> {
  if (Array.isArray(raw)) return raw.length ? { [defaultRepo]: raw } : {};
  return raw ?? {};
}

/** `writeJsonAtomic` for the state file — the same temp name (pid, `TMP_TOKEN`, counter) and rename as
 *  every other JSON file this bot writes (#510; it used to keep a `${path}.tmp` copy of the pattern). */
export function saveStateTo(path: string, data: BotState): Promise<void> {
  return writeJsonAtomic(path, data);
}

/**
 * A serialized writer bound to one file: each `save` queues behind whatever write is already in
 * flight (a promise chain, not a mutex), so two overlapping writers — a `/update`'s save racing a
 * scheduler tick's, neither of which goes through `withCritical` (a ref-count against a *restart*
 * firing mid-write, not a mutex between writers) — can never interleave their own temp-write+
 * rename and corrupt the file. They only ever lose to each other in *order* (a stale-value race),
 * never in bytes (a torn write). `.then(onFulfilled, onRejected)` runs the same write either way,
 * so one call's failure can't permanently wedge every later call behind a rejected chain link —
 * the promise returned to *that* caller still reflects its own real outcome.
 */
export function createStateWriter(path: string): {
  save: (data: BotState) => Promise<void>;
  /** Settles once every save queued so far has (what the test-state guard reads). */
  idle: () => Promise<void>;
} {
  let chain: Promise<void> = Promise.resolve();
  return {
    save(data: BotState): Promise<void> {
      const next = chain.then(
        () => saveStateTo(path, data),
        () => saveStateTo(path, data),
      );
      chain = next.catch(() => {});
      return next;
    },
    idle: () => chain,
  };
}

// (`let` only so resetStateWriterForTest can start a fresh queue.)
let stateWriter = createStateWriter(STATE_FILE);

// `state` as it was loaded, for the test-state guard (test/stateGuard.ts): tests change fields of
// the shared object (attemptedUpdateToSha, pendingUpdateReport, ...) and must put them back.
const loadedState: BotState = structuredClone(state);

/** The keys of `state` that differ from what was loaded, and the writer's queue. */
export function botStateForTest(): { changedKeys: string[]; writes: Promise<void> } {
  const current = state as unknown as Record<string, unknown>;
  const loaded = loadedState as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(current), ...Object.keys(loaded)])];
  return { changedKeys: keys.filter((k) => !Bun.deepEquals(current[k], loaded[k])), writes: stateWriter.idle() };
}

/** Puts `state` back to what was loaded — in place, since every importer holds this one object. */
export function resetBotStateForTest(): void {
  const current = state as unknown as Record<string, unknown>;
  for (const k of Object.keys(current)) delete current[k];
  Object.assign(current, structuredClone(loadedState));
}

/** Starts the writer on a fresh, empty queue, for the test-state guard: it runs this once it has
 *  waited for the queue, so a save that never finishes can't hold every later test up. A save still
 *  running is not stopped (and can overlap the next one on the same temp file), only no longer
 *  waited for — so not for a test's own cleanup, where it would hide a leaked save from the guard:
 *  a test awaits its saves instead. */
export function resetStateWriterForTest(): void {
  stateWriter = createStateWriter(STATE_FILE);
}

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
