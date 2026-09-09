// #60 item 2 / #168: log which env file and which data dir the bot started against, on EVERY boot —
// before anything else can throw. `src/config.ts`'s `resolveConfig(process.env)` runs as a MODULE-
// BODY side effect the moment `./config` is imported, so a wrong/missing `BOT_ENV_FILE` throws
// `Missing required env var DISCORD_TOKEN` before a single line of `src/index.ts`'s own body runs —
// a log line placed there would be dead for the exact case it exists to diagnose (two config dirs,
// two instances per host; a bot recreated against the wrong `.env` is otherwise indistinguishable
// in `docker logs` from a correctly-configured one). This module's own body prints instead, and
// `src/index.ts` makes `import "./bootLog"` its FIRST import — ESM evaluates imports in the order
// they're written, so this runs before `./config` gets a chance to throw.
//
// The two lines are printed independently, deliberately NOT via one static `import { DATA_DIR }
// from "./storage"` at the top of this file: a static import is hoisted and evaluated before this
// module's own body runs, so if `./storage`'s own module body threw (a misconfigured, operator-
// restricted `BOT_DATA_DIR` — see storage.ts's own docstring), it would take down BOTH lines,
// including the env-file one — the exact silent-failure-at-boot class #168 exists to fix, just
// moved one module over. The env-file line needs nothing but `process.env`, so it prints first and
// unconditionally; `./storage` is then imported dynamically (deferred past that point on purpose).
// A rethrow from inside a top-level-await dynamic import was tried first and rejected: it did NOT
// reliably stop `index.ts` from continuing on into `./config` (observed live — the DISCORD_TOKEN
// throw still fired after it), so this uses the same explicit `log + process.exit(1)` shape
// `ops/admin/server.ts`'s `resolveAdminStorePathsOrExit` already uses for the identical situation
// (a config problem the entry point must react to by refusing to start, not by half-crashing).
export function describeEnvFile(env: Record<string, string | undefined>): string {
  const envFile = env.BOT_ENV_FILE;
  return envFile
    ? `[boot] env file: ${envFile}`
    : "[boot] env file: (not passed — plain environment or compose default .env)";
}

export function describeDataDir(dataDir: string): string {
  return `[boot] data dir: ${dataDir}`;
}

/** Both lines together, for the common case where `dataDir` is already known — kept for a single
 *  call site to assert on both messages at once. Pure: computed from `env`/`dataDir` rather than
 *  read directly, so it stays testable without touching `process.env` or module-eval order. */
export function describeBoot(env: Record<string, string | undefined>, dataDir: string): string[] {
  return [describeEnvFile(env), describeDataDir(dataDir)];
}

console.log(describeEnvFile(process.env));
let dataDir: string;
try {
  ({ DATA_DIR: dataDir } = await import("./storage"));
} catch (err) {
  console.error(`[boot] couldn't resolve the data dir: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
console.log(describeDataDir(dataDir));
