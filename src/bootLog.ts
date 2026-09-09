// #60 item 2 / #168: log which env file and which data dir the bot started against, on EVERY boot —
// before anything else can throw. `src/config.ts`'s `resolveConfig(process.env)` runs as a MODULE-
// BODY side effect the moment `./config` is imported, so a wrong/missing `BOT_ENV_FILE` throws
// `Missing required env var DISCORD_TOKEN` before a single line of `src/index.ts`'s own body runs —
// a log line placed there would be dead for the exact case it exists to diagnose (two config dirs,
// two instances per host; a bot recreated against the wrong `.env` is otherwise indistinguishable
// in `docker logs` from a correctly-configured one). This module's own body prints instead, and
// `src/index.ts` makes `import "./bootLog"` its FIRST import — ESM evaluates imports in the order
// they're written, so this runs before `./config` gets a chance to throw. Pure `describeBoot` is
// exported so the two message shapes are unit-tested without importing this file for its side
// effect (which would print into the test's own stdout).
import { DATA_DIR } from "./storage";

/** The boot-time diagnostic lines, computed from `env`/`dataDir` rather than read directly, so this
 *  stays a pure function the tests can call without touching `process.env` or module-eval order. */
export function describeBoot(env: Record<string, string | undefined>, dataDir: string): string[] {
  const envFile = env.BOT_ENV_FILE;
  return [
    envFile
      ? `[boot] env file: ${envFile}`
      : "[boot] env file: (not passed — plain environment or compose default .env)",
    `[boot] data dir: ${dataDir}`,
  ];
}

for (const line of describeBoot(process.env, DATA_DIR)) console.log(line);
