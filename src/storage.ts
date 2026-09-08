import { mkdirSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Resolve the one `data/` directory. Defaults to `<repo>/data` (`/app/data` in the image); a
 * `BOT_DATA_DIR` override relocates it wholesale.
 *
 * **The override exists for tests, not for operators** (#139). Every test that transitively imports
 * `commands`/`update`/`announce` pulls in `state.ts`, whose top-level `await` reads this directory
 * at import — and the suite then *writes* it, silently destroying a developer's real
 * `attemptedUpdateToSha` and `pendingUpdateReport`. Redirecting the whole directory is what
 * contains that, which is why the override lives here rather than on `state.ts` alone: `handoff.ts`
 * writes here too, and three separate spellings of "the data dir" is the underlying defect.
 *
 * Deliberately NOT documented in `.env.example` and NOT on `bot-ops.sh`'s editable whitelist. In a
 * deployment it is a footgun: `buildCreateSpec` copies the container's env onto the replacement but
 * derives `Binds` from the mounts, so a value pointing off the named volume means the original and
 * the replacement write *different* filesystems — the replacement's `handoff.json` is never seen,
 * every `/update` waits out `HANDOFF_DEADLINE_MS` and reports a replacement that "never reported
 * in", and self-update is broken with nothing naming the cause. Hence absolute-only, and hence
 * `index.ts` logs the resolved path on every boot.
 *
 * Under `bun test` an unset override is a hard error rather than a silent fall back to the
 * checkout: without that, a preload that fails to run restores the corruption invisibly.
 */
export function resolveDataDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.BOT_DATA_DIR;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(`BOT_DATA_DIR must be an absolute path, got "${override}"`);
    }
    return override;
  }
  if (env.NODE_ENV === "test") {
    throw new Error(
      "BOT_DATA_DIR must be set under `bun test` — refusing to read or write the checkout's data/ " +
        "(#139). The bunfig.toml preload sets it; if you are seeing this, the preload did not run.",
    );
  }
  return join(import.meta.dir, "..", "data");
}

/**
 * The one `data/` directory. `src/state.ts` and `src/handoff.ts` **import** this rather than
 * recomputing it, and `src/index.ts` imports it too; `HostApi.dataDir` handed to plugins is this.
 * Never recompute a data path from `import.meta.dir` under `src/plugins/` — that module is two hops
 * from `data/`, not one.
 */
export const DATA_DIR = resolveDataDir();

/**
 * Atomically writes `data` as JSON to `path`: a temp file in the same directory, then a rename —
 * never a bare write, which a crash mid-write could leave unparseable for the next read. Mirrors
 * `state.ts`'s `saveStateTo`, generalized so `links.ts` and `characters.ts` both call this instead
 * of each reimplementing the same three lines.
 *
 * **Not safe to call directly from two places that might race on the same `path`** — the temp
 * filename is fixed (`${path}.tmp`), so two overlapping calls for the same path can have one
 * rename fail with `ENOENT` out from under the other (verified: this is exactly what happens if
 * `createJsonWriter`/`createKeyedJsonMutator` are bypassed). Every current caller reaches this
 * only through one of those two serializing wrappers, which is what actually makes it safe — this
 * function's own atomicity is solely "never leaves a half-written file," not "safe under
 * concurrent callers."
 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/**
 * Reads and parses JSON at `path`, falling back to `fresh()` for an absent file (the common
 * fresh-install case). A present-but-corrupt file (truncated, empty, or otherwise unparseable —
 * a power loss or OOM-kill mid-write) is logged and moved aside to `<path>.corrupt-<timestamp>`
 * rather than thrown, so a bad file degrades to "this one file's history lost once" instead of
 * crashing whatever awaited it at import. `label` names which file this is, in the log line —
 * mirrors `state.ts`'s `loadStateFrom`, generalized the same way as `writeJsonAtomic` above.
 */
export async function readJsonOrFresh<T>(path: string, fresh: () => T, label: string): Promise<T> {
  const file = Bun.file(path);
  if (!(await file.exists())) return fresh();
  try {
    return (await file.json()) as T;
  } catch (err) {
    console.error(`[${label}] ${path} is unreadable or corrupt — starting fresh: ${err}`);
    const corrupt = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, corrupt);
      console.error(`[${label}] moved the corrupt file aside to ${corrupt} for inspection`);
    } catch (renameErr) {
      console.error(`[${label}] couldn't move the corrupt file aside: ${renameErr}`);
    }
    return fresh();
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
 * its own queue (a `Map`, populated lazily), so unrelated files' updates never wait on each
 * other; two updates to the SAME path are fully ordered, so the second's `mutate` always sees
 * the first's result, never a stale read. This is what `characters.ts` needs and `createJsonWriter`
 * alone doesn't provide: one Discord User's file can receive two pushes (two different Account
 * Labels, or a retry) close enough together that a naive read-then-write loses one of them.
 */
export function createKeyedJsonMutator<T>(): {
  update: (path: string, fresh: () => T, mutate: (current: T) => T, label: string) => Promise<void>;
} {
  const chains = new Map<string, Promise<void>>();
  return {
    update(path: string, fresh: () => T, mutate: (current: T) => T, label: string): Promise<void> {
      const prior = chains.get(path) ?? Promise.resolve();
      const run = () => readJsonOrFresh<T>(path, fresh, label).then((current) => writeJsonAtomic(path, mutate(current)));
      const next = prior.then(run, run);
      chains.set(path, next.catch(() => {}));
      return next;
    },
  };
}
