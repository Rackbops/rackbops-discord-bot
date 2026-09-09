import { describe, expect, test } from "bun:test";
import { describeBoot } from "./bootLog";

// #168: describeBoot is the pure half of bootLog.ts — the module-body side effect (console.log at
// import time) is deliberately NOT exercised here (importing this file for its side effect would
// print into the test's own stdout and can't be un-imported); describeBoot's two message shapes are
// the only thing worth pinning, and they're exactly what index.test.ts's ordering test relies on
// having run before ./config's throw.
describe("describeBoot (#60 item 2 / #168)", () => {
  test("names the env file when BOT_ENV_FILE is set", () => {
    const lines = describeBoot({ BOT_ENV_FILE: "/opt/rackbops-discord-bot/debug/.env" }, "/app/data");
    // Mutation: dropping this branch (always printing the fallback text) would hide exactly the
    // wrong-.env case this issue exists to diagnose.
    expect(lines).toContain("[boot] env file: /opt/rackbops-discord-bot/debug/.env");
  });

  test("prints the fallback text when BOT_ENV_FILE is unset", () => {
    const lines = describeBoot({}, "/app/data");
    // Mutation: dropping this branch (always printing the path, even undefined) would print
    // "[boot] env file: undefined" instead of the documented, readable fallback.
    expect(lines).toContain("[boot] env file: (not passed — plain environment or compose default .env)");
  });

  test("prints the fallback text when BOT_ENV_FILE is the empty string", () => {
    // An empty-but-set value is not a real path — same falsy-string convention config.ts's own
    // `optional()` helper uses elsewhere in this repo.
    const lines = describeBoot({ BOT_ENV_FILE: "" }, "/app/data");
    expect(lines).toContain("[boot] env file: (not passed — plain environment or compose default .env)");
  });

  test("always includes the data dir line, using the passed-in dataDir verbatim", () => {
    const lines = describeBoot({}, "/custom/data/dir");
    expect(lines).toContain("[boot] data dir: /custom/data/dir");
  });

  test("returns exactly two lines, env file first then data dir", () => {
    const lines = describeBoot({ BOT_ENV_FILE: "/x/.env" }, "/y");
    expect(lines).toEqual(["[boot] env file: /x/.env", "[boot] data dir: /y"]);
  });
});
