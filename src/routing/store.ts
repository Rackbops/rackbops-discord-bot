// Reading and writing `routing.json` and `routing.secrets.json`. Both READ through `storage.ts`'s
// `readJsonOrFresh` (a corrupt file is moved aside, never thrown on); `routing.json` also WRITES
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
// queues. `mutateSecrets` keeps its own queues, keyed the same way, for the same reason.
const routingMutator = createKeyedJsonMutator<RoutingFile>();

// What `readRouting` has already said about a damaged file (#260). It is on the path of every command and
// every announcement since #243, so a file with one bad entry must not write a line per command: each
// distinct message is said once per process.
const said = new Set<string>();

/** Forget what has been said, so a test can see the same problem reported again. */
export function resetRoutingWarningsForTest(): void {
  said.clear();
}

/**
 * The routing file as the bot should act on it. A missing file is fresh; an unparseable one is
 * moved aside (`routing.json.corrupt-<timestamp>`) and read as fresh, as `readJsonOrFresh` does for
 * every data file; a parseable file of the wrong shape is repaired down to whatever in it is valid.
 * Never throws.
 *
 * The repair is tolerant and silent (`repairRouting` is pure); what it dropped is worked out beside it
 * (`droppedByRepair`) and said HERE, at the I/O edge, once per distinct message: a plugin placed in a
 * server whose entry is malformed would otherwise live nowhere with nothing in the log, and `#247` seeds
 * this file by hand. Log output only -- what is registered, posted or refused is decided by the repaired
 * value, exactly as before.
 */
export async function readRouting(dataDir: string): Promise<RoutingFile> {
  const raw = await readJsonOrFresh<unknown>(routingPath(dataDir), freshRouting, "routing");
  for (const message of droppedByRepair(raw)) {
    if (said.has(message)) continue;
    said.add(message);
    console.warn(`[routing] routing.json: ${message}; it is ignored`);
  }
  return repairRouting(raw);
}

/**
 * `mutate` must hand back the whole file. Anything that is not an object -- a callback that forgot its
 * `return`, say -- is refused BEFORE anything is written: repairing `undefined` would give a fresh
 * file, and writing that would erase every placement without a word.
 *
 * That is all this checks. An object of the wrong shape (an empty `{}`, a `Map`, a `Promise` from an
 * `async` callback) is still repaired down and written, so it still empties the file: the type
 * checker is what stops those, since none of them is assignable to the callback's return type. Only a
 * cast or an untyped caller gets past it.
 */
function requireFile<T>(value: T, caller: string): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    const got = value === null ? "null" : Array.isArray(value) ? "a list" : typeof value;
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
 */
export async function mutateRouting(dataDir: string, mutate: (current: RoutingFile) => RoutingFile): Promise<void> {
  await routingMutator.update(
    routingPath(dataDir),
    freshRouting,
    (current) => repairRouting(requireFile(mutate(repairRouting(current)), "mutateRouting")),
    "routing",
  );
}

export async function readSecrets(dataDir: string): Promise<RoutingSecretsFile> {
  return repairSecrets(await readJsonOrFresh<unknown>(secretsPath(dataDir), freshSecrets, "routing-secrets"));
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
    const current = repairSecrets(await readJsonOrFresh<unknown>(path, freshSecrets, "routing-secrets"));
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
