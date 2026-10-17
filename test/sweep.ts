// #252: the test preload's cleanup of PREVIOUS runs' `rackbops-bot-test-data-*` directories used to
// sweep EVERY directory carrying the prefix, with no way to tell a previous run's leftover from a
// concurrently running suite's own directory — two `bun test` invocations on one machine (two agent
// sessions, a reviewer's own run alongside the author's) raced, and the second's preload deleted the
// first's `BOT_DATA_DIR` out from under it mid-run. Pure over injected seams (`now`, `mtimeOf`,
// `isAlive`, `remove`) so this is unit-testable without touching the real filesystem or spawning a
// real process; `test/setup.ts` calls it with the real ones.
export const TEST_DATA_PREFIX = "rackbops-bot-test-data-";

// A run's directory is now named `<prefix><pid>-<mkdtemp-random>` — the pid is ours, the random tail
// is `mkdtempSync`'s. Anchored at the start so a name that merely CONTAINS digits after the prefix in
// some other shape (there is no other shape today, but a future rename should still be refused rather
// than mis-parsed) doesn't false-match.
const PID_RE = new RegExp(`^${TEST_DATA_PREFIX}(\\d+)-`);

/** The pid embedded in a `TEST_DATA_PREFIX`-named directory, or `null` for a name with none — which
 *  is the pre-#252 format (`<prefix><mkdtemp-random>`, no pid at all): a leftover by definition,
 *  since nothing alive is naming its directories that way anymore. */
export function parsePid(name: string): number | null {
  const m = PID_RE.exec(name);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) ? pid : null;
}

/** A directory this old cannot belong to a run still in progress, whatever its pid says (a reused
 *  pid could otherwise fool the liveness check alone) — one hour, generous next to any real suite's
 *  runtime. Exported so `test/setup.ts` and this file's own tests share the one number. */
export const MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Removes every `TEST_DATA_PREFIX`-named entry in `opts.entries` that is provably NOT a concurrently
 * running suite's own directory: its embedded pid is no longer alive, OR it is older than
 * `opts.maxAgeMs` (a reused pid cannot hold a run that old), OR its name carries no parseable pid at
 * all (the pre-#252 format). A directory whose pid is alive and young is left alone — that is exactly
 * the concurrent run #252 exists to stop deleting. Returns the names actually removed.
 *
 * Entries that are not real directories (`isDir`) are skipped before anything else is read; a `remove`
 * that throws is handed to `onRemoveFailed` and left out of the returned list. This function itself never
 * touches the filesystem — it decides, the injected seams do.
 */
export function sweepStaleTestDirs(opts: {
  entries: string[];
  now: number;
  isDir: (name: string) => boolean;
  mtimeOf: (name: string) => number;
  isAlive: (pid: number) => boolean;
  maxAgeMs: number;
  remove: (name: string) => void;
  onRemoveFailed: (name: string, err: unknown) => void;
}): string[] {
  const removed: string[] = [];
  for (const entry of opts.entries) {
    if (!entry.startsWith(TEST_DATA_PREFIX)) continue;
    // Two sweeps can see the same stale entry in their `readdir` snapshot and race to remove it (the very
    // concurrent-invocations scenario #252 exists to make safe): `isDir` and `mtimeOf` read a path a sibling's
    // `remove` may have already deleted, and a seam backed by lstat/stat throws ENOENT for a vanished path. That
    // is not staleness, it is nothing left to do. #461: only a real directory is a run's dir -- a stray file or a
    // link under the prefix is left alone before anything else is read.
    let stale: boolean;
    try {
      if (!opts.isDir(entry)) continue;
      const pid = parsePid(entry);
      stale = pid === null || opts.now - opts.mtimeOf(entry) > opts.maxAgeMs || !opts.isAlive(pid);
    } catch (err) {
      // Narrowed to ENOENT specifically, matching `isPidAlive`'s error-code check below -- any other error
      // (EACCES, ENOTDIR, ...) is a real problem, not "already gone," and should surface loudly rather than be
      // swallowed as if a sibling sweep had won the race.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue;
    }
    if (!stale) continue;
    // #461: a dead run's dir an orphan still holds (EBUSY/EPERM on Windows) is reported and skipped; it must not
    // stop every later run, and it is not "removed".
    try {
      opts.remove(entry);
      removed.push(entry);
    } catch (err) {
      opts.onRemoveFailed(entry, err);
    }
  }
  return removed;
}

/** The one log line `test/setup.ts` prints for a sweep: the count, then at most ten names. */
export function formatSwept(removed: string[]): string {
  return `[test/setup] swept ${removed.length} stale test dir(s): ${removed.slice(0, 10).join(", ")}${removed.length > 10 ? ", ..." : ""}`;
}

/**
 * Whether `pid` names a live process — `process.kill(pid, 0)` sends no signal, only asks the OS.
 * `ESRCH` ("no such process") is the one error that means dead; anything else thrown (`EPERM`: a
 * real, live process this one just isn't permitted to signal) is treated as alive, since the only
 * question here is "is that pid free to be reused," and EPERM proves it isn't. Verified on this
 * Windows box (Bun 1.4.2) before relying on it: `process.kill(<this process's pid>, 0)` does not
 * throw, and `process.kill(<a pid that just exited>, 0)` throws `ESRCH` — the decision-2 probe this
 * function's own test pins.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
