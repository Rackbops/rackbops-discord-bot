// Reading and writing `routing.json` and `routing.secrets.json`. Both READ through `storage.ts`'s
// `readJsonOrFresh` (a corrupt file is left in place and read as fresh, said once -- the next write moves it
// aside, #477; a read that fails for another reason, EACCES or EIO, is rethrown, #509); `routing.json` also WRITES
// through its serialized read-modify-write. `routing.secrets.json` writes itself, because it has to
// be created owner-only and `writeJsonAtomic` gives its temp file the process default mode.
// Nothing here reads `DATA_DIR`: every function takes the directory it is to use, so a test points
// it at a temp dir and the caller passes `DATA_DIR` at the one place that means it. (Read CONTEXT.md's
// `BOT_DATA_DIR` gotcha before changing that -- a data path recomputed from anything else is how the
// test suite once destroyed a developer's real state.)
//
// The bot is the ONLY writer of these files (ADR-0006). The panel asks for a change through the
// request mailbox; it never touches them.

import { randomUUID } from "node:crypto";
import { copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { chmod as fsChmod, mkdir, rename as fsRename, unlink, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createKeyedJsonMutator, readJsonOrFresh } from "../storage";
import {
  droppedByRepair,
  freshRouting,
  freshSecrets,
  repairRouting,
  repairSecrets,
  type RoutingFile,
  type RoutingSecretsFile,
} from "./model";
import { shown } from "./text";

export function routingPath(dataDir: string): string {
  return `${dataDir}/routing.json`;
}

export function secretsPath(dataDir: string): string {
  return `${dataDir}/routing.secrets.json`;
}

// One mutator at module level, so every caller in the process shares the same per-path queue (the
// `stateMutator` pattern in `src/plugins/host.ts`). A read-modify-write is serialized end to end:
// the second `mutate` always sees the first one's result. A plain read-then-write would let two
// overlapping callers each read the same file and the later write silently drop the earlier change
// -- a lost update, not a corrupt file. The queue is keyed by the path STRING, so every caller must
// spell the directory the same way (production passes `DATA_DIR`); `d`, `d/` and `d\` are three
// queues. `mutateSecrets` keeps its own queues, keyed the same way, for the same reason. (`let` only
// so resetRoutingWritesForTest can start a fresh queue.)
//
// One writer at a time ACROSS containers rests on a single fact, not on these queues (#478): during a handoff the
// replacement writes nothing until `takeOver` has stopped the original (`ready.ts` runs `takeOver` before `activate`,
// and every production caller of `mutateRouting`/`mutateSecrets` -- the mailbox, `markWebhookBroken` -- is wired
// inside `activate`, the mailbox drain gated on `markPluginStateReady`). The ORIGINAL's side is not a guarantee:
// `beginHandoff` does not await in-flight work, so a `markWebhookBroken` can still write from the original during the
// overlap, and the stop waits for criticals only up to `graceMs` before the daemon's SIGKILL -- a write cut there is
// the `.tmp` file `sweepSecretsTemp` removes at the next boot. No cross-process lock is taken (declined).
let routingMutator = createKeyedJsonMutator<RoutingFile>();

// What `readRouting` has already said about a damaged file (#260). It is on the path of every plugin command
// used in a server (`gateCommand`) and every announcement since #243, and of every join since #259, so a
// file with one bad entry must not write a line per read: each distinct line is said once per process. (The
// record is per process, so a problem that is fixed and then put back is not said again until a restart.)
const said = new Set<string>();

/** Paths whose file `mutateRouting` has already copied to `routing.json.before-repair-<ms>` in this process (#477). */
const copiedBeforeRepair = new Set<string>();

/** Forget what has been said, so a test can see the same problem reported again. */
export function resetRoutingWarningsForTest(): void {
  said.clear();
  copiedBeforeRepair.clear();
}

/** What the test-state guard (test/stateGuard.ts) reads here: the warnings said (which
 *  `resetRoutingWarningsForTest` resets), and every write queued on the routing and secrets files —
 *  `writes` settles once they all have (which `resetRoutingWritesForTest` drops). */
export function routingStoreStateForTest(): { said: number; copied: number; writes: Promise<void> } {
  return {
    said: said.size,
    copied: copiedBeforeRepair.size,
    writes: Promise.all([routingMutator.idle(), ...secretsQueues.values()]).then(() => {}),
  };
}

/** Starts the routing and secrets files on fresh, empty queues, for the test-state guard: it runs
 *  this once it has waited for them, so a write that never finishes can't hold every later test up.
 *  A write still running is not stopped, only no longer waited for — so not for a test's own
 *  cleanup, where it would hide a leaked write from the guard: a test awaits its writes instead. */
export function resetRoutingWritesForTest(): void {
  routingMutator = createKeyedJsonMutator<RoutingFile>();
  secretsQueues.clear();
}

/** What went wrong, as text that is clipped (an engine's message can echo a hostile key) and cannot throw. */
function describeFailure(err: unknown): string {
  try {
    return err instanceof Error ? shown(err.message) : "not an Error";
  } catch {
    return "unreadable error";
  }
}

/**
 * Says what the repair of `raw` left out, each distinct line once. Log output only, so nothing in it may
 * change what `readRouting` returns (`gateCommand` fails open when a read throws, so a throw out of a log
 * line would let a restricted command run):
 *  - a logger that throws is swallowed, and the line is recorded as said only once it was written, so it is
 *    tried again on the next read;
 *  - `droppedByRepair` throwing is a bug in the report, not in the file: it is swallowed too, and said once
 *    in place of the report, so a broken report is not mistaken for a clean file.
 * Exported for the test that needs to hand it a value no file can hold.
 */
export function sayWhatWasIgnored(raw: unknown): void {
  let lines: string[];
  try {
    lines = droppedByRepair(raw).map((message) => `[routing] routing.json: ${message}; it is ignored`);
  } catch (err) {
    lines = [`[routing] routing.json: could not work out what the repair ignored (${describeFailure(err)})`];
  }
  for (const line of lines) {
    if (said.has(line)) continue;
    try {
      console.warn(line);
      said.add(line);
    } catch {
      /* logging must never change what is read */
    }
  }
}

/**
 * The routing file as the bot should act on it. A missing file is fresh; an unparseable one is
 * left in place and read as fresh, said once (the next write moves it aside first, `mutateRouting`, #477); a parseable file of the wrong shape is repaired down to whatever in it is valid.
 * Throws only when the read itself fails for a reason other than a parse error (EACCES, EIO:
 * `readJsonOrFresh` rethrows those, #509).
 *
 * The repair is tolerant and silent (`repairRouting` is pure); what it dropped is worked out beside it
 * (`droppedByRepair`) and said HERE, at the I/O edge, once per distinct message: a plugin placed in a
 * server whose entry is malformed would otherwise live nowhere with nothing in the log, and `#247` seeds
 * this file by hand. Log output only -- what is registered, posted or refused is decided by the repaired
 * value, exactly as before.
 */
export async function readRouting(dataDir: string): Promise<RoutingFile> {
  const raw = await readJsonOrFresh<unknown>(routingPath(dataDir), freshRouting, "routing", { onCorrupt: "keep" });
  sayWhatWasIgnored(raw);
  return repairRouting(raw);
}

/**
 * `mutate` must hand back the whole file. Anything that is not an object -- a callback that forgot its
 * `return`, say -- is refused BEFORE anything is written: repairing `undefined` would give a fresh
 * file, and writing that would erase every placement without a word.
 *
 * A thenable (an `async` callback's Promise) is refused too, and its rejection is swallowed so it cannot surface as
 * an unhandledRejection after the refusal (#478). The rest of the shape is the type checker's job: an object of the
 * wrong shape (an empty `{}`, a `Map`) is still repaired down and written, so it still empties the file, and only a
 * cast or an untyped caller gets past it.
 */
function requireFile<T>(value: T, caller: string): T {
  const thenable = typeof (value as { then?: unknown } | null)?.then === "function";
  if (typeof value !== "object" || value === null || Array.isArray(value) || thenable) {
    if (thenable) void (value as PromiseLike<unknown>).then(undefined, () => {});
    const got = value === null ? "null" : Array.isArray(value) ? "a list" : thenable ? "a Promise (an async callback?)" : typeof value;
    throw new TypeError(`${caller}: mutate must return the whole file, not ${got}; nothing was written`);
  }
  return value;
}

/**
 * Serialized read-modify-write of `routing.json`. `mutate` always receives a REPAIRED value (never
 * whatever the file happened to contain) and returns the file to write, which must be an object and
 * is repaired again before it is written -- so a value that does not fit the shape cannot land in
 * the file. That drops every key outside the shape, a `url` or `token` on a webhook above all. It
 * does NOT inspect the text of the string fields the shape does allow (`updatedAt`, `updatedBy`, a
 * webhook's `addedAt`, `addedBy` and `broken`, and a request result's `action`, `at` and `reason`): a
 * caller must not put a webhook URL in any of them.
 *
 * The first write in a process that would drop something the operator typed (`droppedByRepair`) keeps the file as it
 * was at `routing.json.before-repair-<ms>` (#477), once per path; a copy that fails is said and the write goes ahead.
 * `droppedByRepair` reports placements, not bookkeeping: a stray key, a `v: 2` file, `results` entries or a
 * non-string `broken`/`updatedAt`/`updatedBy` are dropped on write with no copy. Refusing to write while something
 * would be dropped is declined: one hand typo would block every panel change.
 */
export async function mutateRouting(dataDir: string, mutate: (current: RoutingFile) => RoutingFile): Promise<void> {
  const path = routingPath(dataDir);
  await routingMutator.update(
    path,
    freshRouting,
    (current) => {
      if (!copiedBeforeRepair.has(path)) {
        try {
          // inside the try for the same reason sayWhatWasIgnored guards it: a throw here must not block the write
          if (droppedByRepair(current).length > 0) {
            copiedBeforeRepair.add(path);
            const copy = `${path}.before-repair-${Date.now()}`;
            copyFileSync(path, copy);
            console.warn(`[routing] routing.json held entries the repair drops; the file as it was is kept at ${copy}`);
          }
        } catch (err) {
          console.warn(`[routing] routing.json held entries the repair drops, and a copy could not be kept (${describeFailure(err)})`);
        }
      }
      return repairRouting(requireFile(mutate(repairRouting(current)), "mutateRouting"));
    },
    "routing",
  );
}

export async function readSecrets(dataDir: string): Promise<RoutingSecretsFile> {
  return repairSecrets(
    await readJsonOrFresh<unknown>(secretsPath(dataDir), freshSecrets, "routing-secrets", { onCorrupt: "keep", redactReason: true }),
  );
}

/** Owner read/write only. */
const SECRETS_MODE = 0o600;

/**
 * The two filesystem calls of a secrets write that a test needs to observe or make fail; the real
 * `node:fs/promises` ones by default.
 */
export interface SecretsIo {
  rename?: (from: string, to: string) => Promise<void>;
  writeFile?: (path: string, data: string, options: { mode: number; flag: string }) => Promise<void>;
}

// One queue per secrets file: each write chains behind the one before it, whether that one
// succeeded or failed (a failed write must not wedge every later one -- see `mutateSecrets`).
const secretsQueues = new Map<string, Promise<void>>();

/**
 * As `mutateRouting` (repaired in, repaired out), for the file that holds webhook URLs -- which is
 * owner-only (`0o600`) from the moment it exists.
 *
 * It does not write through `writeJsonAtomic`, which creates its temp file with the process default
 * mode. Instead it serializes its own read-modify-write on a per-path promise chain, writes a temp
 * file created with mode `0o600`, and renames it into place (a rename keeps the mode). So the URLs
 * are never in a file anyone but the owner can read -- not the temp file, not the final one -- and
 * the two other places the same bytes can end up stay owner-only too (for a file this function
 * created, see below): a leftover temp file from a write that died between the write and the rename,
 * and the `.corrupt-<timestamp>` copy `readJsonOrFresh` moves an unparseable file to (a rename
 * again). A write that fails part-way removes its temp file, best effort.
 *
 * The temp file is named with a random UUID and created exclusively (`flag: "wx"`), so two writers --
 * two containers on one volume during a handoff, where a process id and a counter can repeat, each
 * container having its own process-id namespace -- cannot pick the same name, and a stale file or a
 * symlink already at that name is refused rather than written through.
 *
 * "Owner-only from creation" is about files this function writes. A secrets file put there by hand
 * (a deployment seeding it, a restore) keeps whatever mode it was given until the first write here
 * replaces it, and if it will not parse it is moved aside at that mode.
 *
 * `mutate` must return the whole file (an object), as for `mutateRouting`; it is repaired before it
 * is written. `chmod` is then called on the final file as a last belt-and-braces step. A `chmod` that
 * fails is logged and swallowed: the write itself succeeded and the file was created owner-only, and
 * refusing to report that would leave the caller retrying a change that already landed. `chmod` and
 * `io` are parameters only so a test can observe or fail them.
 *
 * The mode is enforced by the kernel on Linux, where the bot runs; on Windows a mode is not meaningful
 * and the tests that observe it are skipped.
 */
export function mutateSecrets(
  dataDir: string,
  mutate: (current: RoutingSecretsFile) => RoutingSecretsFile,
  chmod: (path: string, mode: number) => Promise<void> = fsChmod,
  io: SecretsIo = {},
): Promise<void> {
  const path = secretsPath(dataDir);
  const rename = io.rename ?? fsRename;
  const write = io.writeFile ?? fsWriteFile;

  const run = async (): Promise<void> => {
    const current = repairSecrets(await readJsonOrFresh<unknown>(path, freshSecrets, "routing-secrets", { redactReason: true }));
    const next = repairSecrets(requireFile(mutate(current), "mutateSecrets"));
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await write(tmp, JSON.stringify(next, null, 2), { mode: SECRETS_MODE, flag: "wx" });
      await rename(tmp, path);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    try {
      await chmod(path, SECRETS_MODE);
    } catch (err) {
      console.error(`[routing] could not re-assert owner-only on ${path} (it was created 0600): ${err}`);
    }
  };

  // The stored chain never rejects (the `.catch`), so a failed write cannot wedge the ones behind it
  // and `run` needs only its fulfilled branch.
  const queued = (secretsQueues.get(path) ?? Promise.resolve()).then(run);
  secretsQueues.set(path, queued.catch(() => {}));
  return queued;
}

/**
 * Removes every `routing.secrets.json.*.tmp` beside the secrets file and returns how many it removed (#479). A
 * secrets write that died between its write and its rename leaves one, holding a live webhook URL that nothing else
 * ever removes. At a normal boot, and after `takeOver`, there is no writer it could belong to. In the overlap window
 * `README.md` documents (`docker start <name>` with the replacement still alive) the sweep can unlink the other
 * instance's in-flight temp file, whose rename then fails with ENOENT: one failed webhook request, no data loss.
 * `.corrupt-` copies are left alone: they are the evidence a write keeps, and owner-only when the bot wrote them.
 * No `fsync` (#510). Never throws: it runs before `initRouting`, which a throw would skip.
 */
export function sweepSecretsTemp(dataDir: string): number {
  const dir = dirname(secretsPath(dataDir));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith("routing.secrets.json.") || !name.endsWith(".tmp")) continue;
    try {
      unlinkSync(`${dir}/${name}`);
      removed += 1;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      console.error(`[routing] could not remove a stale secrets temp file ${name}: ${typeof code === "string" ? code : "unknown error"}`);
    }
  }
  if (removed > 0) console.warn(`[routing] removed ${removed} stale routing.secrets.json temp file(s)`);
  return removed;
}
