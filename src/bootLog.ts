// #60 item 2 / #168: log which env file and which data dir the bot started against, on EVERY boot —
// before anything else can throw. `src/config.ts`'s `resolveConfig(process.env)` runs as a MODULE-
// BODY side effect the moment `./config` is imported, so a wrong/missing `BOT_ENV_FILE` throws
// `Missing required env var DISCORD_TOKEN` before a single line of `src/index.ts`'s own body runs —
// a log line placed there would be dead for the exact case it exists to diagnose (two config dirs,
// two instances per host; a bot recreated against the wrong `.env` is otherwise indistinguishable
// in `docker logs` from a correctly-configured one). This module's own body prints instead, and
// `src/index.ts` makes `import "./bootLog"` its FIRST import — ESM evaluates imports in the order
// they're written, so this runs before `./config` gets a chance to throw. This module is fully
// synchronous, so ESM evaluates it to completion before `./config` (#493); both lines are therefore
// printed before `resolveConfig` can throw, not just the first.
//
// `resolveDataDir` comes from `./dataDir`, a leaf over `node:path` whose import cannot throw; the call
// can (a relative `BOT_DATA_DIR`, or no override under `bun test`), so it is made here, inside a
// `try`, after the env-file line has printed — a bad data dir costs one line and `process.exit(1)`,
// never the env-file line. This used to be a dynamic import of `./storage` behind a top-level wait,
// which made this module async: a later sibling import (`./config`) could then evaluate, and throw,
// while this one was suspended, losing the data-dir line in exactly the misconfigured-boot case (#493;
// the auditor reproduced the loss 3 of 3 runs on Bun 1.4.2). A static `import { DATA_DIR } from
// "./storage"` would be worse: `storage.ts`'s body computes `DATA_DIR` at load and would take both
// lines down with it — including the env-file one, the exact silent-failure-at-boot class #168 exists
// to fix, just moved one module over. The exit is the same explicit `log + process.exit(1)` shape
// `ops/admin/server.ts`'s `resolveAdminStorePathsOrExit` already uses for the identical situation (a
// config problem the entry point must react to by refusing to start, not by half-crashing).
import { installJsonConsole, logFormatFrom } from "./logFormat";
import { resolveDataDir } from "./dataDir";

export function describeEnvFile(env: Record<string, string | undefined>): string {
  const envFile = env.BOT_ENV_FILE;
  return envFile
    ? `[boot] env file: ${envFile}`
    : "[boot] env file: (not passed — plain environment or compose default .env)";
}

export function describeDataDir(dataDir: string): string {
  return `[boot] data dir: ${dataDir}`;
}

// #324: before the first line, so even the boot lines come out as JSON when LOG_FORMAT=json. A value
// that is neither json nor text is said once, in text, and the bot runs on: a log format is not worth
// refusing to deliver reminders over.
const logFormat = logFormatFrom(process.env);
if (logFormat === "json") installJsonConsole(console, process.stdout, process.stderr);
else if (logFormat === "invalid") console.error(`[boot] LOG_FORMAT must be json or text, got "${process.env.LOG_FORMAT}" -- logging as text`);
console.log(describeEnvFile(process.env));
let dataDir: string;
try {
  dataDir = resolveDataDir();
} catch (err) {
  console.error(`[boot] couldn't resolve the data dir: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
console.log(describeDataDir(dataDir));
