import { mkdirSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * #132: the width every short-sha site (`shaTag`, log lines, update/handoff messages) agrees on.
 * `redeploy.ts`'s `selectImagesToPrune` rebuilds its tag-shape regex from this constant so the two
 * can never drift apart again — see its own comment for the failure mode that made this necessary.
 */
export const SHORT_SHA_LEN = 7;

/** The short form of a git sha used in logs, messages and image tags — always `SHORT_SHA_LEN`
 *  characters. A config-free leaf (this module imports only `node:*`) so `handoff.ts` can use it
 *  without pulling in `./config`, which it must stay free of (it runs before config is guaranteed
 *  resolved during a handoff). */
export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LEN);
}

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
 * in", and self-update is broken with nothing naming the cause. That is why `index.ts` logs the
 * resolved path on every boot — it is the one thing that turns that into a one-line diagnosis.
 * (Absolute-only is a *separate* guard, and not a mitigation for the above: `/srv/elsewhere` is
 * absolute and is exactly the failure case. It exists because a relative value resolves against
 * cwd, which can land back inside a checkout — the same reason `BOT_OPS_CONFIG_DIR` is
 * absolute-only.)
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

// #154: gives every temp file this process creates here a unique name — see writeJsonAtomic's own
// comment for why. A plain per-call Date.now()/Math.random() would still theoretically collide
// under heavy concurrency; a monotonically increasing counter cannot, by construction.
let tmpCounter = 0;

/**
 * Atomically writes `data` as JSON to `path`: a temp file in the same directory, then a rename —
 * never a bare write, which a crash mid-write could leave unparseable for the next read. Mirrors
 * `state.ts`'s `saveStateTo`, generalized so `links.ts` and `characters.ts` both call this instead
 * of each reimplementing the same three lines.
 *
 * **Not safe to call twice concurrently for the same `path` from the SAME process** — two
 * overlapping calls both write, then both rename, the winner is whichever rename lands last, and
 * the loser's write is silently discarded (a lost update, not a corrupt file). Every in-process
 * caller reaches this only through `createJsonWriter`/`createKeyedJsonMutator`, which serialize
 * that.
 *
 * The temp NAME itself, though, is per-process-unique (`${path}.${pid}.${counter}.tmp`, #154) —
 * unlike the writes it's safe across DIFFERENT processes racing the same `path`, which the
 * in-process serializers above can't help with at all: two containers sharing the state volume
 * during a handoff (the replacement's boot-time `loadPluginIndex` cache write, the original's
 * still-running `pluginUpdates` tick re-fetching the same manifest) used to share one fixed
 * `${path}.tmp`, so either process's rename could fail with `ENOENT` out from under the other, or
 * — worse — one process's in-flight write could be clobbered mid-write by the other reusing the
 * same temp path. A unique name per (process, call) makes that structurally impossible: the two
 * writes now always go to two different temp files, so the only remaining question is which
 * RENAME lands last (last-write-wins on the real path, the same "lost update" the in-process
 * comment above already accepts — never a torn or missing file).
 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${++tmpCounter}.tmp`;
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
