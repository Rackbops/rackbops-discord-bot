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

import { chmod as fsChmod, mkdir, rename as fsRename, unlink, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createKeyedJsonMutator, readJsonOrFresh } from "../storage";
import {
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

/**
 * The routing file as the bot should act on it. A missing file is fresh; an unparseable one is
 * moved aside (`routing.json.corrupt-<timestamp>`) and read as fresh, as `readJsonOrFresh` does for
 * every data file; a parseable file of the wrong shape is repaired down to whatever in it is valid.
 * Never throws.
 */
export async function readRouting(dataDir: string): Promise<RoutingFile> {
  return repairRouting(await readJsonOrFresh<unknown>(routingPath(dataDir), freshRouting, "routing"));
}

/**
 * Serialized read-modify-write of `routing.json`. `mutate` always receives a REPAIRED value (never
 * whatever the file happened to contain) and returns the file to write -- which is repaired again
 * before it is written, so a value that does not fit the shape can never land in the file. Above
 * all that keeps a webhook URL out of `routing.json` whatever a caller builds: a `url` key on a
 * webhook is not part of `WebhookMeta` and is dropped.
 */
export async function mutateRouting(dataDir: string, mutate: (current: RoutingFile) => RoutingFile): Promise<void> {
  await routingMutator.update(
    routingPath(dataDir),
    freshRouting,
    (current) => repairRouting(mutate(repairRouting(current))),
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
  writeFile?: (path: string, data: string, options: { mode: number }) => Promise<void>;
}

// One queue per secrets file: each write chains behind the one before it, whether that one
// succeeded or failed (a failed write must not wedge every later one).
const secretsQueues = new Map<string, Promise<void>>();
let secretsTmpCounter = 0;

/**
 * As `mutateRouting` (repaired in, repaired out), for the file that holds webhook URLs -- which is
 * owner-only (`0o600`) from the moment it exists.
 *
 * It does not write through `writeJsonAtomic`, which creates its temp file with the process default
 * mode. Instead it serializes its own read-modify-write on a per-path promise chain, writes a temp
 * file created with mode `0o600`, and renames it into place (a rename keeps the mode). So the URLs
 * are never in a file anyone but the owner can read -- not the temp file, not the final one -- and
 * the two other places the same bytes can end up stay owner-only too: a leftover temp file from a
 * write that died between the write and the rename, and the `.corrupt-<timestamp>` copy
 * `readJsonOrFresh` moves an unparseable file to (a rename again). A write that fails part-way removes
 * its temp file, best effort.
 *
 * `chmod` is then called on the final file as a last belt-and-braces step. A `chmod` that fails is
 * logged and swallowed: the write itself succeeded and the file was created owner-only, and refusing
 * to report that would leave the caller retrying a change that already landed. `chmod` and `io` are
 * parameters only so a test can observe or fail them.
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
  const write = io.writeFile ?? ((file, data, options) => fsWriteFile(file, data, options));

  const run = async (): Promise<void> => {
    const current = repairSecrets(await readJsonOrFresh<unknown>(path, freshSecrets, "routing-secrets"));
    const next = repairSecrets(mutate(current));
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${++secretsTmpCounter}.tmp`;
    try {
      await write(tmp, JSON.stringify(next, null, 2), { mode: SECRETS_MODE });
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

  const queued = (secretsQueues.get(path) ?? Promise.resolve()).then(run, run);
  secretsQueues.set(path, queued.catch(() => {}));
  return queued;
}
