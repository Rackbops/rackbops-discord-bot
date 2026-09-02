import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config";
import type { RealmStatus } from "./wow/realm";

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
}

// Persisted so restarts never re-announce something already posted.
export interface BotState {
  // Seen release ids keyed by `owner/repo`, so watched repos never collide and each seeds
  // its "first poll is silent" backlog independently.
  seenReleaseIds: Record<string, number[]>;
  dmfAnnouncedFor?: string; // "2026-7"
  weeklyAnnouncedFor?: string; // ISO timestamp of the reset announced
  realmStatus?: RealmStatus; // last observed realm status; drives up/down transition announcements
  attemptedUpdateToSha?: string; // sha we last exited to update to; guards against an exit loop
  pendingUpdateReport?: PendingUpdateReport; // /update follow-up owed on next boot; consumed once
}

const RELEASE_ID_CAP = 100;

const DATA_DIR = join(import.meta.dir, "..", "data");
const STATE_FILE = join(DATA_DIR, "state.json");

export const state: BotState = await loadStateFrom(STATE_FILE);

/**
 * Reads and parses a state file at `path`. Distinguishes "absent" (a fresh install — the common
 * case) from "present but broken" (empty, truncated, or otherwise unparseable — a power loss or
 * OOM-kill mid-write, or two overlapping writers racing before `createStateWriter` existed): the
 * latter is logged loudly and moved aside to `<path>.corrupt-<timestamp>` for inspection rather
 * than thrown, so a bad file degrades to "dedup history lost once" instead of the top-level
 * `await` above throwing before `index.ts` even runs — which `restart: unless-stopped` would then
 * relaunch into forever. Mirrors `handoff.ts`'s `readMarker`, which treats its own sibling file
 * the same way. The move-aside is itself best-effort: a failed rename is logged, not thrown —
 * losing the forensic copy is still better than a crash loop.
 */
export async function loadStateFrom(path: string): Promise<BotState> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { seenReleaseIds: {} };
  try {
    const raw = (await file.json()) as Omit<BotState, "seenReleaseIds"> & {
      seenReleaseIds?: number[] | Record<string, number[]>;
    };
    return { ...raw, seenReleaseIds: normalizeSeenReleaseIds(raw.seenReleaseIds, config.githubRepo) };
  } catch (err) {
    console.error(`[state] ${path} is unreadable or corrupt — starting fresh (dedup history lost once): ${err}`);
    const corrupt = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, corrupt);
      console.error(`[state] moved the corrupt file aside to ${corrupt} for inspection`);
    } catch (renameErr) {
      console.error(`[state] couldn't move the corrupt file aside: ${renameErr}`);
    }
    return { seenReleaseIds: {} };
  }
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

/**
 * Atomically writes `data` to `path`: a temp file in the same directory, then an atomic rename —
 * never a bare truncate-in-place, which a crash mid-write (or, absent `createStateWriter`'s
 * queue, an overlapping second writer) can catch and leave unparseable for the next `loadStateFrom`.
 */
export async function saveStateTo(path: string, data: BotState): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
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
export function createStateWriter(path: string): { save: (data: BotState) => Promise<void> } {
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
  };
}

const stateWriter = createStateWriter(STATE_FILE);

export function saveState(): Promise<void> {
  // Cap each repo's release-id history so the file never grows unbounded.
  for (const [repo, ids] of Object.entries(state.seenReleaseIds)) {
    state.seenReleaseIds[repo] = ids.slice(-RELEASE_ID_CAP);
  }
  return stateWriter.save(state);
}
