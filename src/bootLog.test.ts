import { describe, expect, test } from "bun:test";
import { describeBoot, describeDataDir, describeEnvFile } from "./bootLog";

// #168: describeBoot/describeEnvFile/describeDataDir are the pure half of bootLog.ts — the module-
// body side effect (console.log at import time, plus the dynamic ./storage import) is deliberately
// NOT exercised here (importing this file for its side effect would print into the test's own
// stdout and can't be un-imported); their message shapes are the only thing worth pinning, and
// they're exactly what index.test.ts's ordering test relies on having run before ./config's throw.
describe("describeEnvFile (#60 item 2 / #168)", () => {
  test("names the env file when BOT_ENV_FILE is set", () => {
    // Mutation: dropping this branch (always printing the fallback text) would hide exactly the
    // wrong-.env case this issue exists to diagnose.
    expect(describeEnvFile({ BOT_ENV_FILE: "/opt/rackbops-discord-bot/debug/.env" })).toBe(
      "[boot] env file: /opt/rackbops-discord-bot/debug/.env",
    );
  });

  test("prints the fallback text when BOT_ENV_FILE is unset", () => {
    // Mutation: dropping this branch (always printing the path, even undefined) would print
    // "[boot] env file: undefined" instead of the documented, readable fallback.
    expect(describeEnvFile({})).toBe("[boot] env file: (not passed — plain environment or compose default .env)");
  });

  test("prints the fallback text when BOT_ENV_FILE is the empty string", () => {
    // An empty-but-set value is not a real path — same falsy-string convention config.ts's own
    // `optional()` helper uses elsewhere in this repo.
    expect(describeEnvFile({ BOT_ENV_FILE: "" })).toBe(
      "[boot] env file: (not passed — plain environment or compose default .env)",
    );
  });
});

describe("describeDataDir (#60 item 2 / #168)", () => {
  test("uses the passed-in dataDir verbatim", () => {
    expect(describeDataDir("/custom/data/dir")).toBe("[boot] data dir: /custom/data/dir");
  });
});

describe("describeBoot (#60 item 2 / #168)", () => {
  test("returns exactly two lines, env file first then data dir", () => {
    expect(describeBoot({ BOT_ENV_FILE: "/x/.env" }, "/y")).toEqual(["[boot] env file: /x/.env", "[boot] data dir: /y"]);
  });

  test("composes describeEnvFile and describeDataDir, not a separate implementation", () => {
    // Mutation: a describeBoot that duplicates the branch logic instead of delegating could drift
    // from describeEnvFile/describeDataDir without either test catching it.
    const env = { BOT_ENV_FILE: "/a/.env" };
    expect(describeBoot(env, "/b")).toEqual([describeEnvFile(env), describeDataDir("/b")]);
  });
});
