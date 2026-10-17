import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DATA_PREFIX } from "./sweep";

// #403, #461, #462: test/setup.ts runs for real, in a child `bun test` (the pattern test/stateGuard.test.ts uses),
// with its temp root pointed at a PRIVATE directory. Directories planted there before the child runs tell the real
// `isAlive` / `maxAgeMs` / `mtimeOf` / `isDir` / `remove` seams apart afterwards, and no other session's preload
// (which sweeps the shared `tmpdir()`) can touch them.
const CHILD_TIMEOUT_MS = 20_000;
const REPO_ROOT = join(import.meta.dir, "..");

function runPreloadChild(env: Record<string, string>, sbx: string) {
  return Bun.spawnSync([process.execPath, "test", "./test/preload.fixture.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env, TEMP: sbx, TMP: sbx, TMPDIR: sbx },
    timeout: CHILD_TIMEOUT_MS,
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** A bogus value for EVERY key test/setup.ts clears, each one `config.ts` accepts where it checks the format. */
const AMBIENT_ENV: Record<string, string> = {
  DISCORD_TOKEN: "real-token",
  ANNOUNCE_CHANNEL_ID: "999",
  GITHUB_REPO: "x/y",
  WATCHED_REPOS: "x/z",
  PLUGINS: "someplugin",
  PLUGIN_INDEX_URL: "http://127.0.0.1:9/index.json",
  HTTP_PORT: "1234",
  TRUSTED_PROXY_HOST: "proxy.test",
  RELEASE_ANNOUNCE_CHANNEL_ID: "777",
  DISCORD_SERVER_ID: "888",
  GITHUB_TOKEN: "ghp_x",
  GIT_SHA: "abc",
  BOT_BRANCH: "other",
  AUTO_UPDATE: "true",
  ADMIN_USER_IDS: "999",
  REPORT_ROLE_ID: "555",
  LOG_FORMAT: "json",
  PLUGIN_REGISTRY_URL: "http://localhost:4873",
  // Not read by resolveConfig, so the fixture's deep-equal ignores them; the fixture asserts them directly. The
  // parent's own preload has already cleared both, so without these the child could never see an ambient value.
  BOT_DOCKER_SOCKET: "/x/docker.sock",
  COMMAND_PREFIX: "zz",
};

/** The pid of a process that has exited (the `isPidAlive` test's own probe). */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  const pid = proc.pid;
  await proc.exited;
  return pid;
}

describe("the preload in test/setup.ts, run for real (#403, #461, #462)", () => {
  let sbx = "";
  let planted: { live: string; dead: string; old: string; link: string; target: string; file: string } | undefined;
  let child: { exitCode: number | null; stdout: string; stderr: string } | undefined;

  beforeAll(async () => {
    sbx = mkdtempSync(join(tmpdir(), "preload-sbx-"));
    const dead = await deadPid();
    const tail = () => Math.random().toString(36).slice(2, 8);
    const live = join(sbx, `${TEST_DATA_PREFIX}${process.pid}-live-${tail()}`);
    const deadDir = join(sbx, `${TEST_DATA_PREFIX}${dead}-dead-${tail()}`);
    const old = join(sbx, `${TEST_DATA_PREFIX}${process.pid}-old-${tail()}`);
    const link = join(sbx, `${TEST_DATA_PREFIX}${dead}-link-${tail()}`);
    const file = join(sbx, `${TEST_DATA_PREFIX}${dead}-file-${tail()}`);
    const target = join(sbx, "link-target");
    for (const d of [live, deadDir, old, target]) mkdirSync(d);
    writeFileSync(join(target, "sentinel.txt"), "keep");
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(old, past, past);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(file, "stray");
    planted = { live, dead: deadDir, old, link, target, file };
    const result = runPreloadChild(AMBIENT_ENV, sbx);
    if (result.exitedDueToTimeout) throw new Error(`preload child was killed after ${CHILD_TIMEOUT_MS}ms:\n${result.stderr.toString()}`);
    child = { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }, CHILD_TIMEOUT_MS + 10_000);

  afterAll(() => {
    rmSync(sbx, { recursive: true, force: true });
  });

  const output = () => `exit ${child?.exitCode}\nstdout:\n${child?.stdout}\nstderr:\n${child?.stderr}`;

  test("P0: the child swept the private temp root, not the shared one", () => {
    const m = /\[preload\.fixture\] tmpdir=(.*)/.exec(child!.stdout);
    expect(m, output()).not.toBeNull();
    expect(realpathSync(m![1]!.trim())).toBe(realpathSync(sbx));
  });

  test("P1 (#403): a live young dir is kept, a dead one and an old one are removed and named", () => {
    expect(existsSync(planted!.live), output()).toBe(true);
    expect(existsSync(planted!.dead), output()).toBe(false);
    expect(existsSync(planted!.old), output()).toBe(false);
    const swept = /swept 2 stale test dir\(s\): (.*)/.exec(child!.stdout);
    expect(swept, output()).not.toBeNull();
    expect(swept![1]).toContain(planted!.dead.split(/[\\/]/).pop()!);
    expect(swept![1]).toContain(planted!.old.split(/[\\/]/).pop()!);
    expect(swept![1]).not.toContain(planted!.live.split(/[\\/]/).pop()!);
  });

  test("P2 (#461): a link and a stray file under the prefix are left alone", () => {
    expect(lstatSync(planted!.link).isSymbolicLink(), output()).toBe(true);
    expect(readFileSync(join(planted!.target, "sentinel.txt"), "utf8")).toBe("keep");
    expect(existsSync(planted!.file), output()).toBe(true);
  });

  test("P3 (#462): the fixture's assertions held with an ambient value for every cleared key", () => {
    expect(child!.exitCode, output()).toBe(0);
  });
});

describe.skipIf(process.platform !== "win32")("a dead run's dir an orphan holds does not fail the next run (#461 item 2)", () => {
  test("W1: the held dir is warned about and skipped, the other dead dir is swept", async () => {
    const sbx = mkdtempSync(join(tmpdir(), "preload-sbx-"));
    const dead = await deadPid();
    const held = join(sbx, `${TEST_DATA_PREFIX}${dead}-held-abc123`);
    const gone = join(sbx, `${TEST_DATA_PREFIX}${dead}-gone-abc123`);
    mkdirSync(held);
    mkdirSync(gone);
    // An OPEN FILE HANDLE does not make rmSync throw on Windows under Bun 1.4.2 (measured); a cwd inside the dir does: EBUSY.
    const holder = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { cwd: held, stdout: "ignore", stderr: "ignore" });
    try {
      await Bun.sleep(500);
      const result = runPreloadChild({}, sbx);
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      const out = `exit ${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
      expect(result.exitCode, out).toBe(0);
      expect(stderr, out).toContain("could not remove the stale test dir");
      expect(stderr, out).toContain(held.split(/[\\/]/).pop()!);
      expect(stderr, out).toContain("EBUSY");
      const swept = /swept \d+ stale test dir\(s\): (.*)/.exec(stdout);
      expect(swept, out).not.toBeNull();
      expect(swept![1]).toContain(gone.split(/[\\/]/).pop()!);
      expect(swept![1]).not.toContain(held.split(/[\\/]/).pop()!);
      expect(existsSync(held)).toBe(true);
    } finally {
      holder.kill();
      await holder.exited;
      rmSync(sbx, { recursive: true, force: true });
    }
  }, 60_000);
});

// #514 (posthoc-1-2): a tool-dependent suite fails on CI instead of skipping green.
describe("the ops suites refuse to skip on CI (#514 item 2)", () => {
  for (const file of ["ops/bot-ops.test.ts", "ops/install.test.ts", "ops/docker-compose.test.ts"]) {
    const run = (env: Record<string, string | undefined>) => {
      const empty = mkdtempSync(join(tmpdir(), "empty-path-"));
      try {
        const { CI: _ci, ...rest } = process.env;
        return Bun.spawnSync([process.execPath, "test", `./${file}`], {
          cwd: REPO_ROOT,
          env: { ...rest, ...env, PATH: empty, Path: empty },
          timeout: 30_000,
          stdout: "pipe",
          stderr: "pipe",
        });
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    };

    test(`C1: ${file} throws at load with CI set and no tools on PATH`, () => {
      const result = run({ CI: "true" });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("required on CI; refusing to skip");
    }, 30_000);

    test(`C1: ${file} only warns and skips with CI unset and no tools on PATH`, () => {
      const result = run({});
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toContain("SKIPPING");
    }, 30_000);
  }
});

// #461 items 4 and 6: CI is time-boxed, least-privilege, and pinned by commit.
describe("ci.yml (#461)", () => {
  const text = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const ci = Bun.YAML.parse(text) as { permissions?: unknown; jobs: Record<string, Record<string, unknown>> };

  test("Y1: read-only token, every job time-boxed, every action pinned by commit with a bare-ref comment", () => {
    expect(ci.permissions).toEqual({ contents: "read" });
    for (const [name, job] of Object.entries(ci.jobs)) {
      expect(typeof job["timeout-minutes"], `job ${name} has no timeout-minutes`).toBe("number");
    }
    const uses = text.split("\n").filter((line) => /^\s*-?\s*uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/@[0-9a-f]{40} # v?\d[\w.]*$/);
  });
});
