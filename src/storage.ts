import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { resolveDataDir } from "./dataDir";

/**
 * #132: the width every short-sha site (`shaTag`, log lines, update/handoff messages) agrees on.
 * `redeploy.ts`'s `selectImagesToPrune` rebuilds its tag-shape regex from this constant so the two
 * can never drift apart again — see its own comment for the failure mode that made this necessary.
 */
export const SHORT_SHA_LEN = 7;

/** The short form of a git sha used in logs, messages and image tags — always `SHORT_SHA_LEN`
 *  characters. A config-free leaf (this module imports only `node:*` and `./dataDir`, itself `node:path`-only) so `handoff.ts` can use it
 *  without pulling in `./config`, which it must stay free of (it runs before config is guaranteed
 *  resolved during a handoff). */
export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LEN);
}

// `resolveDataDir` lives in `./dataDir` (a `node:path`-only leaf, so `src/bootLog.ts` can call it without
// evaluating this module's body, #493); its docstring is there. Re-exported so every existing import holds.
export { resolveDataDir };

/**
 * The one `data/` directory. `src/state.ts` and `src/handoff.ts` **import** this rather than
 * recomputing it, and `src/index.ts` imports it too; `HostApi.dataDir` handed to plugins is this.
 * Never recompute a data path from `import.meta.dir` under `src/plugins/` — that module is two hops
 * from `data/`, not one.
 */
export const DATA_DIR = resolveDataDir();

// #154: gives every temp file this process creates here a unique name — see writeJsonAtomic's own
// comment for why. A plain per-call Date.now()/Math.random() would still theoretically collide
// under heavy concurrency; a monotonically increasing counter cannot, by construction.
let tmpCounter = 0;

// #253: chosen ONCE per process, at module load — not per call, like `tmpCounter` is. A pid alone
// isn't enough to tell two WRITERS apart: each container in a handoff has its own pid namespace, and
// the bot runs under an init (`docker-compose.yml`'s `init: true`), so the original and its
// replacement are very likely the SAME small pid, both starting `tmpCounter` at zero — their first
// writes to a shared path used to pick the identical temp name, exactly the collision #154's
// per-process naming was meant to rule out and didn't. This token is what actually distinguishes two
// processes that agree on both pid and counter. Exported for the test that pins its shape and that two
// processes differ; nothing else reads it.
export const TMP_TOKEN = randomBytes(4).toString("hex");

/** The temp path `writeJsonAtomic` writes to before its rename — one exported pure function so the
 *  no-collision guarantee is testable without spinning up two processes. `pid`/`token`/`counter` are
 *  parameters (not read off the module's own `process.pid`/`TMP_TOKEN`/`tmpCounter`) purely so a test
 *  can hand it two processes' worth of identical pid+counter and prove the token is what separates
 *  them. */
export function tmpPathFor(path: string, pid: number, token: string, counter: number): string {
  return `${path}.${pid}.${token}.${counter}.tmp`;
}

/**
 * Atomically writes `data` as JSON to `path`: a temp file in the same directory, then a rename —
 * never a bare write, which a crash mid-write could leave unparseable for the next read.
 * `state.ts`'s `saveStateTo` and the plugins' storage both come here (#510): one implementation of
 * temp+rename.
 *
 * **Not safe to call twice concurrently for the same `path` from the SAME process** — two
 * overlapping calls both write, then both rename, the winner is whichever rename lands last, and
 * the loser's write is silently discarded (a lost update, not a corrupt file). Every in-process
 * caller reaches this only through `createJsonWriter`/`createKeyedJsonMutator`, which serialize
 * that.
 *
 * The temp NAME itself is unique per **(process token, call)** — `tmpPathFor`'s
 * `${path}.${pid}.${TMP_TOKEN}.${counter}.tmp`, #154 + #253. A pid-and-counter name ALONE (#154's
 * original shape) is not enough across DIFFERENT processes: two containers sharing the state volume
 * during a handoff (the replacement's boot-time `loadPluginIndex` cache write, the original's
 * still-running `pluginUpdates` tick re-fetching the same manifest) run under an init and are very
 * likely the SAME small pid, both starting their own `tmpCounter` at zero — so a pid+counter name
 * alone lets their first writes collide on the identical temp path, exactly the failure #154 meant to
 * rule out and didn't (#253). `TMP_TOKEN`, chosen once per process at module load, is what actually
 * makes two DIFFERENT processes' names diverge even when their pid and counter both happen to match:
 * the two writes now always go to two different temp files, so the only remaining question is which
 * RENAME lands last (last-write-wins on the real path, the same "lost update" the in-process comment
 * above already accepts — never a torn or missing file).
 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(data, null, 2));
}

/** `writeJsonAtomic`'s temp-file-then-rename for text that is already serialized, under the same
 *  `tmpPathFor` name (pid, `TMP_TOKEN`, counter) and with the same caveats. Shared (#496) so the plugin
 *  index cache (`src/plugins/index.ts`) gets the #253 cross-process guard instead of keeping a copy. */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tmpPathFor(path, process.pid, TMP_TOKEN, ++tmpCounter);
  try {
    await Bun.write(tmp, text);
    renameSync(tmp, path);
  } catch (err) {
    // #509: a failed write or rename must not leave the temp file behind — the counter means a retry
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

/**
 * What a throw from `Bun.file(path).json()` means (Bun 1.4.2, probed): a `SyntaxError` is a file that
 * parsed badly (empty, truncated, not JSON) — corrupt; `ENOENT` is a file that vanished after `exists()`
 * — absent; anything else (EACCES, EIO, EMFILE, EISDIR) is a read that failed on a file that may be
 * intact — an error, never a reason to move the file aside. Pure.
 */
export function classifyReadError(err: unknown): "corrupt" | "absent" | "error" {
  if (err instanceof SyntaxError) return "corrupt";
  if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT") return "absent";
  return "error";
}

/**
 * Reads and parses JSON at `path`, falling back to `fresh()` for an absent file (the common
 * fresh-install case). A file that **parsed badly** (empty, truncated, not JSON — a process killed
 * mid-write before temp+rename (#68), or a hand edit; temp+rename covers an OOM-kill, a SIGKILL or a
 * crash, but there is no `fsync`, so a host power loss is outside it, #510) is logged and moved aside
 * to `<path>.corrupt-<timestamp>` rather than thrown, so a bad file degrades to "this one file's
 * history lost once" instead of crashing whatever awaited it at import. Once the file is known to
 * exist, a read that fails for any other reason (EACCES, EIO, ...) is logged and **rethrown**:
 * returning fresh would let the next write overwrite a file that may be intact, and moving it aside
 * would hide an environment fault (#509). That reaches every caller, the installed plugins'
 * `HostStorage.readJsonOrFresh` included. `label` names which file this is, in the log line.
 */
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

/**
 * A serialized writer bound to one file: each `save` queues behind whatever write is already in
 * flight (a promise chain, not a mutex), so two overlapping writers can never interleave their
 * own temp-write+rename and corrupt the file — they only ever lose to each other in order, never
 * in bytes. Mirrors `state.ts`'s `createStateWriter`, generalized over the stored type.
 *
 * This alone is NOT enough for a read-modify-write caller (read current -> compute next -> save):
 * it only serializes the final write, not the read that preceded it, so two concurrent callers
 * can each read the same "current" value, compute against it independently, and the second save
 * silently overwrites the first's contribution — a lost update, not a corrupt file. A caller
 * doing read-modify-write on a value keyed by something other than "the whole file" (one entry
 * among many, one of several files) needs `createKeyedJsonMutator` below instead, which
 * serializes the read too.
 */
export function createJsonWriter<T>(path: string): { save: (data: T) => Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  return {
    save(data: T): Promise<void> {
      const next = chain.then(
        () => writeJsonAtomic(path, data),
        () => writeJsonAtomic(path, data),
      );
      chain = next.catch(() => {});
      return next;
    },
  };
}

/**
 * Serializes a full read-modify-write cycle per file path — not just the write. Each path gets
 * its own queue (a `Map`, populated lazily and emptied as queues settle, #511), so unrelated
 * files' updates never wait on each other; two updates to the SAME path are fully ordered, so the
 * second's `mutate` always sees the first's result, never a stale read. This is what
 * `characters.ts` needs and `createJsonWriter` alone doesn't provide: one Discord User's file can
 * receive two pushes (two different Account Labels, or a retry) close enough together that a naive
 * read-then-write loses one of them.
 */
export function createKeyedJsonMutator<T>(): {
  update: (path: string, fresh: () => T, mutate: (current: T) => T, label: string) => Promise<void>;
  /** Settles once every update queued so far has, on every path (what the test-state guard reads). */
  idle: () => Promise<void>;
  /** Paths that still hold a queue — an entry is dropped once its last update settles (#511), so this is
   *  the number of paths with an update in flight, not every path ever touched. */
  pendingPaths: () => number;
} {
  const chains = new Map<string, Promise<void>>();
  return {
    update(path: string, fresh: () => T, mutate: (current: T) => T, label: string): Promise<void> {
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
