import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

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
