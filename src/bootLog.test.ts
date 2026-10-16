import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DATA_PREFIX } from "../test/sweep";
import { describeDataDir, describeEnvFile } from "./bootLog";

// The pure formatters are pinned directly below; the module body (the two lines, the JSON swap, the exit
// on a bad data dir, and the ordering against `./config`) is pinned by the subprocess tests at the end,
// since importing this file in-process runs the body once and cannot un-run it (#168, #458, #493).
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

// The module body, run for real in a child process: `bun src/bootLog.ts` (and `bun src/index.ts`, to see
// the boot lines against `./config`'s module-body throw). Same shape as commandPrefix.test.ts's child.
const ROOT = join(import.meta.dir, "..");
const CHILD_TIMEOUT_MS = 20_000;

function run(file: string, env: Record<string, string>) {
  const child = Bun.spawnSync([process.execPath, file], {
    cwd: ROOT,
    timeout: CHILD_TIMEOUT_MS,
    env: { ...process.env, LOG_FORMAT: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitedDueToTimeout) throw new Error(`${file} was killed after ${CHILD_TIMEOUT_MS}ms`);
  return {
    code: child.exitCode,
    stdout: child.stdout.toString().trim().split("\n").filter(Boolean),
    stderr: child.stderr.toString(),
  };
}

// Named like the suite's own data dirs (pid included), so test/setup.ts sweeps it if a crash skips the `finally`.
function withTmpDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), `${TEST_DATA_PREFIX}${process.pid}-`));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the module body, in a subprocess (#458, #493)", () => {
  const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 10_000; // longer than the child's own bound, so that bound is what fires

  test("prints the env-file line, then the data-dir line, and exits 0", () => {
    withTmpDir((tmp) => {
      const r = run("src/bootLog.ts", { BOT_DATA_DIR: tmp, BOT_ENV_FILE: "/x/.env" });
      // Mutation: deleting `console.log(describeDataDir(dataDir))`, or swapping the two lines, fails here.
      expect(r.code).toBe(0);
      expect(r.stdout).toEqual([describeEnvFile({ BOT_ENV_FILE: "/x/.env" }), describeDataDir(tmp)]);
    });
  }, TEST_TIMEOUT_MS);

  test("under LOG_FORMAT=json both lines are one JSON record each", () => {
    withTmpDir((tmp) => {
      const r = run("src/bootLog.ts", { BOT_DATA_DIR: tmp, BOT_ENV_FILE: "/x/.env", LOG_FORMAT: "json" });
      // Mutation: moving installJsonConsole() below the two console.log calls leaves them plain text.
      expect(r.code).toBe(0);
      expect(r.stdout).toHaveLength(2);
      const records = r.stdout.map((line) => JSON.parse(line) as { time: string; level: string; msg: string });
      expect(records.map((x) => x.level)).toEqual(["info", "info"]);
      expect(records.map((x) => x.msg)).toEqual([describeEnvFile({ BOT_ENV_FILE: "/x/.env" }), describeDataDir(tmp)]);
      for (const x of records) expect(Number.isNaN(Date.parse(x.time))).toBe(false);
    });
  }, TEST_TIMEOUT_MS);

  test("a relative BOT_DATA_DIR still prints the env-file line, then says why it stopped, and exits 1", () => {
    const r = run("src/bootLog.ts", { BOT_DATA_DIR: "./data", BOT_ENV_FILE: "/x/.env" });
    // Mutation: replacing the process.exit(1) with a fallback value lets the boot go on to print a data dir.
    expect(r.code).toBe(1);
    expect(r.stdout).toEqual([describeEnvFile({ BOT_ENV_FILE: "/x/.env" })]);
    expect(r.stderr).toContain("couldn't resolve the data dir");
    expect(r.stderr).toContain("absolute path");
  }, TEST_TIMEOUT_MS);

  // #493: index.ts's own first import is this module, and `./config` (a later sibling) throws at module
  // evaluation when DISCORD_TOKEN is missing. Only the token is blanked: `required("ANNOUNCE_CHANNEL_ID")`
  // runs first and would name the channel id instead; the child inherits the preload's ANNOUNCE_CHANNEL_ID.
  test("both boot lines print before ./config throws (#493)", () => {
    withTmpDir((tmp) => {
      const r = run("src/index.ts", {
        BOT_DATA_DIR: tmp,
        DISCORD_TOKEN: "",
        PLUGINS: "",
        PLUGIN_INDEX_URL: "https://plugins.invalid/plugins.json",
      });
      // Mutation: deleting either boot console.log, or moving `import "./bootLog"` below `./config` in
      // index.ts, fails here. A reintroduced top-level await is the next test's: ESM no longer orders
      // ./config after a suspended bootLog, but on Bun 1.4.2 (Windows) the data-dir line still printed in
      // every run measured, so only that source check sees the regression there.
      expect(r.code).not.toBe(0);
      expect(r.stdout.some((line) => line.startsWith("[boot] env file:"))).toBe(true);
      expect(r.stdout).toContain(describeDataDir(tmp));
      expect(r.stderr).toMatch(/Missing required env var DISCORD_TOKEN/);
    });
  }, TEST_TIMEOUT_MS);

  test("bootLog.ts has no top-level await, which is what makes the ordering hold", () => {
    // Comments are stripped first: the header explains the await it no longer has.
    const code = readFileSync(join(import.meta.dir, "bootLog.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bawait\b/);
  });
});
