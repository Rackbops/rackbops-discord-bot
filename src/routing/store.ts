// Reading and writing `routing.json` and `routing.secrets.json`, through the same `storage.ts`
// primitives every other data file uses (atomic write, corrupt-file move-aside, serialized
// read-modify-write). Nothing here reads `DATA_DIR`: every function takes the directory it is to
// use, so a test points it at a temp dir and the caller passes `DATA_DIR` at the one place that
// means it. (Read CONTEXT.md's `BOT_DATA_DIR` gotcha before changing that -- a data path recomputed
// from anything else is how the test suite once destroyed a developer's real state.)
//
// The bot is the ONLY writer of these files (ADR-0006). The panel asks for a change through the
// request mailbox; it never touches them.

import { chmod as fsChmod } from "node:fs/promises";
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

// One mutator per file, at module level, so every caller in the process shares the same per-path
// queue (the `stateMutator` pattern in `src/plugins/host.ts`). A read-modify-write is serialized end
// to end: the second `mutate` always sees the first one's result. A plain read-then-write would let
// two overlapping callers each read the same file and the later write silently drop the earlier
// change -- a lost update, not a corrupt file.
const routingMutator = createKeyedJsonMutator<RoutingFile>();
const secretsMutator = createKeyedJsonMutator<RoutingSecretsFile>();

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
 * whatever the file happened to contain) and returns the file to write.
 */
export async function mutateRouting(dataDir: string, mutate: (current: RoutingFile) => RoutingFile): Promise<void> {
  await routingMutator.update(
    routingPath(dataDir),
    freshRouting,
    (current) => mutate(repairRouting(current)),
    "routing",
  );
}

export async function readSecrets(dataDir: string): Promise<RoutingSecretsFile> {
  return repairSecrets(await readJsonOrFresh<unknown>(secretsPath(dataDir), freshSecrets, "routing-secrets"));
}

/**
 * As `mutateRouting`, for the file that holds webhook URLs -- then makes it owner-only (`0o600`).
 * `chmod` is a parameter only so a test can make it fail; it defaults to `node:fs/promises`'s. A
 * chmod that fails is logged and swallowed: the write itself succeeded, and refusing to report that
 * would leave the caller retrying a change that already landed.
 *
 * The mode is set AFTER the atomic rename, because `writeJsonAtomic` gives the new file the process
 * default. So the file is briefly readable under that default between the rename and this chmod; the
 * data directory is the bot's own volume, which is why that gap is accepted here rather than
 * widening `storage.ts` to write with a mode.
 */
export async function mutateSecrets(
  dataDir: string,
  mutate: (current: RoutingSecretsFile) => RoutingSecretsFile,
  chmod: (path: string, mode: number) => Promise<void> = fsChmod,
): Promise<void> {
  const path = secretsPath(dataDir);
  await secretsMutator.update(path, freshSecrets, (current) => mutate(repairSecrets(current)), "routing-secrets");
  try {
    await chmod(path, 0o600);
  } catch (err) {
    console.error(`[routing] could not make ${path} owner-only; it keeps the default mode: ${err}`);
  }
}
