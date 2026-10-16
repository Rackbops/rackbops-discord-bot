// Test preload — runs once, before any test file is imported (`bunfig.toml`'s `[test] preload`).
//
// Why a preload and not per-file priming (#139): Bun runs every test file in ONE process with ONE
// module registry, so the FIRST file to import a module is the only one whose `process.env` writes
// that module ever sees. Two files setting different values both get the first one's. Measured on
// Bun 1.4.2 — file A set AAA, file B set BBB, both observed the first one's. So per-file setup
// cannot work here: single-file and full runs would disagree, and one new unprimed file sorting
// first would silently revert the whole suite.
//
// `=`, not `??=`. The repo's existing env ritual uses `??=`, but an ambient BOT_DATA_DIR in a
// developer's shell — say one exported while debugging a deployment — would then silently disable
// the entire protection. Safety beats overridability for this one.

import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { formatSwept, isPidAlive, MAX_AGE_MS, sweepStaleTestDirs, TEST_DATA_PREFIX } from "./sweep";

// Sweep PREVIOUS runs' dirs before making this one, rather than removing our own on the way out:
// bun's test runner does not run `process.on("exit")` or `"beforeExit"` handlers (measured on Bun
// 1.4.2 — neither fired), so an exit hook here would be dead code claiming a cleanup that never
// happens. Sweeping on entry runs for certain.
//
// #252: bounded by LIVENESS AND AGE, not "at one directory" — a directory whose embedded pid is
// still alive and under an hour old is a concurrently running suite's own `BOT_DATA_DIR`, not a
// leftover, and sweeping it out from under that run (two `bun test` invocations on one machine,
// routine with several agent sessions working this repo) silently corrupted whatever it did next in
// a test that had nothing to do with the cause. See `test/sweep.ts` for the pure decision logic.
const tmp = tmpdir();
const removed = sweepStaleTestDirs({
  entries: readdirSync(tmp),
  now: Date.now(),
  // #461: a real directory only. lstat reports a junction or a directory symlink as a symbolic link, not a
  // directory, so a planted link is skipped (rmSync would not follow it on Windows either, measured on Bun 1.4.2;
  // this does not rely on that).
  isDir: (name) => lstatSync(join(tmp, name)).isDirectory(),
  mtimeOf: (name) => statSync(join(tmp, name)).mtimeMs,
  isAlive: isPidAlive,
  maxAgeMs: MAX_AGE_MS,
  remove: (name) => rmSync(join(tmp, name), { recursive: true, force: true }),
  onRemoveFailed: (name, err) =>
    console.warn(`[test/setup] could not remove the stale test dir ${name}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`),
});
if (removed.length > 0) console.log(formatSwept(removed));
process.env.BOT_DATA_DIR = mkdtempSync(join(tmp, `${TEST_DATA_PREFIX}${process.pid}-`));

// Snapshot the checkout's real data files BEFORE anything can read or write them, so the guard
// test can prove they were left byte-identical. `null` means "absent", which is a valid snapshot
// and the important one on CI where no data/ exists: `saveStateTo` does mkdirSync + write, so a
// regression would CREATE the file, and asserting it stays absent catches that.
//
// Held on a global rather than in `process.env` deliberately: the preload shares a process with
// the tests, but `process.env` is inherited by every subprocess the suite spawns — and the
// `ops/*.test.ts` files spawn real `bash`, which rejects some values outright (a NUL-sentinel
// version of this failed exactly that way).
// Snapshots the WHOLE tree, not just state.json/handoff.json. Those two are what regressed, but
// the invariant is "the suite never touches the checkout's data/", and `links.json`,
// `characters/` and `plugins/` are equally exposed — `storage.ts` warns specifically that
// `src/plugins/*` is two hops from `data/` and is the likely site of the next wrong recompute.
// A file appearing where there was none is caught too, which is the CI case (no `data/` at all).
const repoDataDir = join(import.meta.dir, "..", "data");
const snapshots: Record<string, string | null> = {};
function snapshotTree(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) snapshotTree(p);
    else snapshots[relative(repoDataDir, p).replaceAll("\\", "/")] = readFileSync(p, "utf8");
  }
}
snapshotTree(repoDataDir);
(globalThis as { __repoDataSnapshots?: Record<string, string | null> }).__repoDataSnapshots = snapshots;

// The two vars `config.ts` requires at import time (#136), FORCED (#462): a real DISCORD_TOKEN in the shell must not
// reach the suite or the subprocesses it spawns, and every other key read at import (config.ts, logFormat.ts,
// plugins/install.ts) is cleared so an in-process result cannot differ from CI's, where none is set. A test that needs
// a value sets it, in a child when it must. Left alone on purpose: NODE_ENV (dataDir.ts's bun-test refusal reads it),
// HOSTNAME (docker.ts reads it per call; tests set it), BOT_ENV_FILE (bootLog.ts prints it), BOT_DATA_DIR (above).
process.env.DISCORD_TOKEN = "test-token";
process.env.ANNOUNCE_CHANNEL_ID = "100";
for (const key of [
  "GITHUB_REPO", "WATCHED_REPOS", "PLUGINS", "PLUGIN_INDEX_URL", "HTTP_PORT", "TRUSTED_PROXY_HOST",
  "RELEASE_ANNOUNCE_CHANNEL_ID", "DISCORD_SERVER_ID", "GITHUB_TOKEN", "GIT_SHA", "BOT_BRANCH", "AUTO_UPDATE",
  "ADMIN_USER_IDS", "REPORT_ROLE_ID", "LOG_FORMAT", "PLUGIN_REGISTRY_URL",
]) {
  delete process.env[key];
}
// #472: cleared, not defaulted -- the suite assumes unprefixed command names (the core-only body fixture
// among them), and an ambient COMMAND_PREFIX (a shell's, or Bun's .env autoload) used to fail those tests
// pointing at the fixture. A test that needs a prefix sets one in a child process (commandPrefix.test.ts).
process.env.COMMAND_PREFIX = "";
// #459: the daemon socket path is a test seam (src/docker.ts). Cleared, not defaulted: an ambient value
// (a shell's, or Bun's .env autoload) would change the path src/docker.ts reads at import, so every
// stubbed-fetch assertion on the `unix` option would fail. (The real transport test hands its child an
// explicit BOT_DOCKER_SOCKET, which overrides this either way.)
delete process.env.BOT_DOCKER_SOCKET;

// The test-state guard is the NEXT preload (test/stateGuardHook.ts), not this one: it loads modules
// that read the environment set above when they are first imported, and a static import here would
// be hoisted above these lines.
